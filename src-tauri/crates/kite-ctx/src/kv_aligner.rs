use std::sync::OnceLock;

use regex::Regex;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::store::{now_unix_secs, ContextStore};
use crate::tokens::sha256_hex;

/// Category of volatile prompt tokens that can break provider KV prefix caches.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VolatileCategory {
    Uuid,
    IsoTimestamp,
    JwtToken,
    HexHash,
}

/// Non-mutating warning describing a volatile span found inside a system prompt.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VolatileFinding {
    pub category: VolatileCategory,
    pub start: usize,
    pub end: usize,
    pub matched: String,
    pub suggestion: &'static str,
}

/// Provider-specific prompt caching economics.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CacheEconomics {
    pub provider: &'static str,
    /// Write multiplier (`1.25` for Anthropic 25% write surcharge, `1.0` for OpenAI/Gemini).
    pub write_factor: f64,
    /// Read multiplier (`0.10` for 90% discount, `0.50` for 50% discount).
    pub read_factor: f64,
    /// Provider ephemeral cache TTL in seconds.
    pub ttl_secs: f64,
}

impl CacheEconomics {
    pub fn for_provider(provider: &str) -> Self {
        match provider.trim().to_ascii_lowercase().as_str() {
            "anthropic" | "claude" | "bedrock" => Self {
                provider: "anthropic",
                write_factor: 1.25,
                read_factor: 0.10,
                ttl_secs: 300.0,
            },
            "openai" | "codex" => Self {
                provider: "openai",
                write_factor: 1.0,
                read_factor: 0.50,
                ttl_secs: 600.0,
            },
            "gemini" | "google" | "antigravity" => Self {
                provider: "gemini",
                write_factor: 1.0,
                read_factor: 0.10,
                ttl_secs: 3600.0,
            },
            _ => Self {
                provider: "generic",
                write_factor: 1.0,
                read_factor: 0.50,
                ttl_secs: 300.0,
            },
        }
    }
}

/// Result of [`KvAligner::plan_live_zone`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LiveZonePlan {
    pub session_id: String,
    pub frozen_message_count: usize,
    pub live_start_index: usize,
    pub prefix_hit: bool,
}

/// Break-even evaluation result for mutating an already-cached historical message slot.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NetCostDecision {
    pub allow_mutation: bool,
    pub benefit: f64,
    pub penalty: f64,
    pub p_alive: f64,
}

fn uuid_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b")
            .unwrap()
    })
}

fn iso_ts_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b")
            .unwrap()
    })
}

fn jwt_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b").unwrap()
    })
}

fn hex_hash_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\b(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{40}|[0-9a-fA-F]{64})\b").unwrap())
}

/// Structural (non-mutating) scanner detecting volatile tokens in a system prompt.
pub fn scan_volatile_tokens(system_prompt: &str) -> Vec<VolatileFinding> {
    let mut findings = Vec::new();

    for m in uuid_re().find_iter(system_prompt) {
        findings.push(VolatileFinding {
            category: VolatileCategory::Uuid,
            start: m.start(),
            end: m.end(),
            matched: m.as_str().to_string(),
            suggestion: "Move per-session UUID out of static system prompt prefix into dynamic tail message",
        });
    }
    for m in iso_ts_re().find_iter(system_prompt) {
        findings.push(VolatileFinding {
            category: VolatileCategory::IsoTimestamp,
            start: m.start(),
            end: m.end(),
            matched: m.as_str().to_string(),
            suggestion: "Move wall-clock timestamp into trailing user/context turn to preserve prefix KV cache",
        });
    }
    for m in jwt_re().find_iter(system_prompt) {
        findings.push(VolatileFinding {
            category: VolatileCategory::JwtToken,
            start: m.start(),
            end: m.end(),
            matched: m.as_str().to_string(),
            suggestion: "Strip ephemeral bearer token from prompt text",
        });
    }
    for m in hex_hash_re().find_iter(system_prompt) {
        findings.push(VolatileFinding {
            category: VolatileCategory::HexHash,
            start: m.start(),
            end: m.end(),
            matched: m.as_str().to_string(),
            suggestion: "Relocate volatile digest out of static system prefix",
        });
    }

    findings.sort_by_key(|f| f.start);
    findings
}

/// Net-cost break-even formula:
/// `delta_t * (w + r * (R - 1)) > p_alive * (w - r) * (S + delta_t)`
/// where `p_alive = max(0, 1 - idle_secs / ttl_secs)`.
pub fn evaluate_net_cost(
    provider: &str,
    delta_tokens: usize,
    suffix_tokens: usize,
    remaining_turns: usize,
    idle_secs: f64,
) -> NetCostDecision {
    let econ = CacheEconomics::for_provider(provider);
    let dt = delta_tokens as f64;
    let s = suffix_tokens as f64;
    let r_turns = (remaining_turns.max(1)) as f64;
    let p_alive = (1.0 - (idle_secs.max(0.0) / econ.ttl_secs)).max(0.0);

    let benefit = dt * (econ.write_factor + econ.read_factor * (r_turns - 1.0));
    let penalty = p_alive * (econ.write_factor - econ.read_factor) * (s + dt);

    NetCostDecision {
        allow_mutation: benefit > penalty,
        benefit,
        penalty,
        p_alive,
    }
}

/// Prefix tracker & live-zone boundary manager backed by SQLite.
#[derive(Clone)]
pub struct KvAligner {
    store: ContextStore,
}

impl KvAligner {
    pub fn new(store: ContextStore) -> Self {
        Self { store }
    }

    /// Compute how many prefix messages are frozen (already cached upstream) vs live delta.
    pub fn plan_live_zone(
        &self,
        session_id: &str,
        provider: &str,
        message_hashes: &[String],
    ) -> Result<LiveZonePlan> {
        let now = now_unix_secs();
        let current_full_hash = sha256_hex(&message_hashes.join("|"));

        let prior: Option<(i64, String)> = self.store.with_conn(|conn| {
            conn.query_row(
                "SELECT frozen_message_count, last_prefix_hash FROM kv_sessions WHERE session_id = ?1",
                params![session_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(Into::into)
        })?;

        let (frozen_count, prefix_hit) = if let Some((prev_len, prev_hash)) = prior {
            let prev_len_usize = (prev_len.max(0) as usize).min(message_hashes.len());
            let current_prefix_hash = sha256_hex(&message_hashes[..prev_len_usize].join("|"));
            if prev_len_usize > 0 && current_prefix_hash == prev_hash {
                (prev_len_usize, true)
            } else {
                (0, false)
            }
        } else {
            (0, false)
        };

        // Persist updated prefix boundary covering all messages forwarded in this turn.
        self.store.with_conn(|conn| {
            conn.execute(
                "INSERT INTO kv_sessions (
                    session_id, provider, frozen_message_count, last_prefix_hash, last_turn_at, total_cached_tokens
                ) VALUES (?1, ?2, ?3, ?4, ?5, 0)
                ON CONFLICT(session_id) DO UPDATE SET
                    provider = excluded.provider,
                    frozen_message_count = excluded.frozen_message_count,
                    last_prefix_hash = excluded.last_prefix_hash,
                    last_turn_at = excluded.last_turn_at",
                params![
                    session_id,
                    provider,
                    message_hashes.len() as i64,
                    current_full_hash,
                    now
                ],
            )?;
            Ok(())
        })?;

        Ok(LiveZonePlan {
            session_id: session_id.to_string(),
            frozen_message_count: frozen_count,
            live_start_index: frozen_count,
            prefix_hit,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_volatile_tokens_in_system_prompts_without_mutation() {
        let prompt = "You are Kite. Session 550e8400-e29b-41d4-a716-446655440000 started at 2026-11-18T01:30:00Z.";
        let findings = scan_volatile_tokens(prompt);
        assert_eq!(findings.len(), 2);
        assert_eq!(findings[0].category, VolatileCategory::Uuid);
        assert_eq!(findings[1].category, VolatileCategory::IsoTimestamp);
    }

    #[test]
    fn freezes_cached_prefix_turns_and_gates_retroactive_mutations() {
        let store = ContextStore::open_in_memory().unwrap();
        let aligner = KvAligner::new(store);

        let turn1 = vec!["sys".to_string(), "u1".to_string(), "a1".to_string()];
        let p1 = aligner.plan_live_zone("s-1", "anthropic", &turn1).unwrap();
        assert_eq!(p1.frozen_message_count, 0);
        assert!(!p1.prefix_hit);

        let mut turn2 = turn1.clone();
        turn2.push("u2".to_string());
        let p2 = aligner.plan_live_zone("s-1", "anthropic", &turn2).unwrap();
        assert_eq!(p2.frozen_message_count, 3);
        assert_eq!(p2.live_start_index, 3);
        assert!(p2.prefix_hit);

        // Fresh warm Anthropic cache (idle=10s) with small savings (500 tok) vs 20k suffix -> reject
        let warm = evaluate_net_cost("anthropic", 500, 20_000, 3, 10.0);
        assert!(!warm.allow_mutation);

        // Expired cache (idle=400s > 300s TTL) -> P_alive=0 -> penalty=0 -> allow compaction!
        let expired = evaluate_net_cost("anthropic", 500, 20_000, 3, 400.0);
        assert!(expired.allow_mutation);
        assert_eq!(expired.p_alive, 0.0);
    }
}
