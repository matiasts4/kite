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
    RelativeTimestamp,
    JwtToken,
    HexHash,
    DomVolatileAttr,
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

/// Result of [`KvAligner::plan_live_zone`] or [`KvAligner::plan_voice_window`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LiveZonePlan {
    pub session_id: String,
    pub frozen_message_count: usize,
    pub live_start_index: usize,
    pub prefix_hit: bool,
    #[serde(default)]
    pub allow_compaction: bool,
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

fn relative_ts_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)\b(?:hace\s+\d+\s*(?:s|seg|segundos?|m|min|minutos?|h|hr|hrs|horas?|d|d[ií]as?)|\d+\s*(?:s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)\s+ago)\b",
        )
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

fn dom_volatile_attr_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r#"(?i)(?::r[0-9a-zA-Z]{1,8}:|\bmui-[0-9a-zA-Z_-]{3,}\b|\?t=\d{10,16}\b|\b(?:nonce|csrf[_-]?token|xsrf[_-]?token|_token)\s*[=:]\s*["']?[A-Za-z0-9+/=_-]{8,}["']?)"#,
        )
        .unwrap()
    })
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
    for m in relative_ts_re().find_iter(system_prompt) {
        findings.push(VolatileFinding {
            category: VolatileCategory::RelativeTimestamp,
            start: m.start(),
            end: m.end(),
            matched: m.as_str().to_string(),
            suggestion: "Move relative timestamp out of static system prompt prefix into dynamic tail context",
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
    for m in dom_volatile_attr_re().find_iter(system_prompt) {
        findings.push(VolatileFinding {
            category: VolatileCategory::DomVolatileAttr,
            start: m.start(),
            end: m.end(),
            matched: m.as_str().to_string(),
            suggestion: "Strip ephemeral DOM attribute (CSRF/nonce/React-MUI ID/Vite cache-buster) from cached prefix",
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
            allow_compaction: false,
        })
    }

    /// Batch-frozen prefix planner for voice turns so incremental turns stay append-only
    /// within the live tail window instead of invalidating the KV cache on every single turn.
    pub fn plan_voice_window(
        &self,
        provider: &str,
        static_prefix_hash: &str,
        turn_hashes: &[String],
        max_live_turns: usize,
        idle_secs: u64,
    ) -> Result<LiveZonePlan> {
        let now = now_unix_secs();
        let session_id = format!(
            "voice:{}:{}",
            provider.trim().to_ascii_lowercase(),
            static_prefix_hash
        );
        let live_cap = max_live_turns.max(1);
        let total = turn_hashes.len();

        let prior: Option<(i64, String)> = self.store.with_conn(|conn| {
            conn.query_row(
                "SELECT frozen_message_count, last_prefix_hash FROM kv_sessions WHERE session_id = ?1",
                params![session_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(Into::into)
        })?;

        let (base_frozen, prefix_hit) = if let Some((prev_len, prev_hash)) = prior {
            let prev_len_usize = (prev_len.max(0) as usize).min(total);
            if prev_len_usize > 0 {
                let current_prefix_hash = sha256_hex(&turn_hashes[..prev_len_usize].join("|"));
                if current_prefix_hash == prev_hash {
                    (prev_len_usize, true)
                } else {
                    (0, false)
                }
            } else {
                (0, !turn_hashes.is_empty() && prev_hash == sha256_hex(""))
            }
        } else {
            (0, false)
        };

        let econ = CacheEconomics::for_provider(provider);
        let cache_expired = (idle_secs as f64) >= econ.ttl_secs;

        let (frozen_turn_count, allow_compaction) = if total <= live_cap {
            (base_frozen.min(total), false)
        } else if cache_expired {
            let target = total.saturating_sub(live_cap);
            (target, target > base_frozen)
        } else {
            // Freeze in batch steps of `live_cap` so intermediate turns stay append-only
            // without rewriting/invalidating the cached prefix on every single turn.
            let overflow = total.saturating_sub(live_cap);
            let batch_frozen = (overflow / live_cap) * live_cap;
            let target = base_frozen.max(batch_frozen).min(total);
            (target, target > base_frozen)
        };

        let frozen_hash = sha256_hex(&turn_hashes[..frozen_turn_count].join("|"));
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
                    frozen_turn_count as i64,
                    frozen_hash,
                    now
                ],
            )?;
            Ok(())
        })?;

        Ok(LiveZonePlan {
            session_id,
            frozen_message_count: frozen_turn_count,
            live_start_index: frozen_turn_count,
            prefix_hit,
            allow_compaction,
        })
    }

    /// Batch-frozen sliding-window planner for thread history (`assemble_thread_context`),
    /// advancing the dropped prefix only in batch increments (or when provider KV TTL expires)
    /// so intermediate turns maintain an identical byte-for-byte cached prefix.
    pub fn plan_thread_window(
        &self,
        session_id: &str,
        provider: &str,
        item_hashes: &[String],
        max_live_items: usize,
        batch_size: usize,
    ) -> Result<LiveZonePlan> {
        let now = now_unix_secs();
        let total = item_hashes.len();
        let live_cap = max_live_items.max(1);
        let batch = batch_size.max(1);
        let kv_key = format!("thread:{session_id}");

        let prior: Option<(i64, String, i64)> = self.store.with_conn(|conn| {
            conn.query_row(
                "SELECT frozen_message_count, last_prefix_hash, last_turn_at
                 FROM kv_sessions WHERE session_id = ?1",
                params![kv_key],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(Into::into)
        })?;

        let econ = CacheEconomics::for_provider(provider);
        let cache_expired = prior
            .as_ref()
            .is_some_and(|(_, _, ts)| ((now - *ts).max(0) as f64) >= econ.ttl_secs);

        let window_start = if total <= live_cap {
            0
        } else if cache_expired {
            total - live_cap
        } else {
            let overflow = total - live_cap;
            let batch_start = (overflow / batch) * batch;
            if let Some((prev_start, _, _)) = &prior {
                let prev = (*prev_start).max(0) as usize;
                if prev <= total && total.saturating_sub(prev) < live_cap + batch {
                    prev.max(batch_start)
                } else {
                    batch_start
                }
            } else {
                batch_start
            }
        };

        let prefix_hit = if let Some((prev_start, prev_meta, _)) = prior {
            if cache_expired || (prev_start.max(0) as usize) != window_start {
                false
            } else if let Some((len_str, prev_hash)) = prev_meta.split_once(':') {
                if let Ok(prev_len) = len_str.parse::<usize>() {
                    prev_len > 0
                        && window_start + prev_len <= total
                        && sha256_hex(&item_hashes[window_start..window_start + prev_len].join("|"))
                            == prev_hash
                } else {
                    false
                }
            } else {
                false
            }
        } else {
            false
        };

        let sent_len = total.saturating_sub(window_start);
        let current_slice_hash = sha256_hex(&item_hashes[window_start..].join("|"));
        let stored_meta = format!("{sent_len}:{current_slice_hash}");

        self.store.with_conn(|conn| {
            conn.execute(
                "INSERT INTO kv_sessions (
                    session_id, provider, frozen_message_count, last_prefix_hash, last_turn_at, total_cached_tokens, prefix_hits
                ) VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6)
                ON CONFLICT(session_id) DO UPDATE SET
                    provider = excluded.provider,
                    frozen_message_count = excluded.frozen_message_count,
                    last_prefix_hash = excluded.last_prefix_hash,
                    last_turn_at = excluded.last_turn_at,
                    prefix_hits = kv_sessions.prefix_hits + excluded.prefix_hits",
                params![
                    kv_key,
                    provider,
                    window_start as i64,
                    stored_meta,
                    now,
                    i64::from(prefix_hit)
                ],
            )?;
            Ok(())
        })?;

        Ok(LiveZonePlan {
            session_id: session_id.to_string(),
            frozen_message_count: window_start,
            live_start_index: window_start,
            prefix_hit,
            allow_compaction: false,
        })
    }

    /// Batch-frozen prefix planner for long browser action/snapshot loops so intermediate
    /// navigation turns remain append-only within the live window instead of invalidating
    /// the provider KV prefix cache on every browser turn.
    pub fn plan_browser_window(
        &self,
        session_id: &str,
        provider: &str,
        turn_hashes: &[String],
        max_live_turns: usize,
        batch_size: usize,
        idle_secs: u64,
    ) -> Result<LiveZonePlan> {
        let now = now_unix_secs();
        let kv_key = format!("browser:{session_id}");
        let live_cap = max_live_turns.max(1);
        let batch = batch_size.max(1);
        let total = turn_hashes.len();

        let prior: Option<(i64, String)> = self.store.with_conn(|conn| {
            conn.query_row(
                "SELECT frozen_message_count, last_prefix_hash FROM kv_sessions WHERE session_id = ?1",
                params![kv_key],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(Into::into)
        })?;

        let (base_frozen, prefix_hit) = if let Some((prev_len, prev_hash)) = prior {
            let prev_len_usize = (prev_len.max(0) as usize).min(total);
            if prev_len_usize > 0 {
                let current_prefix_hash = sha256_hex(&turn_hashes[..prev_len_usize].join("|"));
                if current_prefix_hash == prev_hash {
                    (prev_len_usize, true)
                } else {
                    (0, false)
                }
            } else {
                (0, !turn_hashes.is_empty() && prev_hash == sha256_hex(""))
            }
        } else {
            (0, false)
        };

        let econ = CacheEconomics::for_provider(provider);
        let cache_expired = (idle_secs as f64) >= econ.ttl_secs;

        let (frozen_turn_count, allow_compaction) = if total <= live_cap {
            (base_frozen.min(total), false)
        } else if cache_expired {
            let target = total.saturating_sub(live_cap);
            (target, target > base_frozen)
        } else {
            let overflow = total.saturating_sub(live_cap);
            let batch_frozen = (overflow / batch) * batch;
            let target = base_frozen.max(batch_frozen).min(total);
            (target, target > base_frozen)
        };

        let frozen_hash = sha256_hex(&turn_hashes[..frozen_turn_count].join("|"));
        self.store.with_conn(|conn| {
            conn.execute(
                "INSERT INTO kv_sessions (
                    session_id, provider, frozen_message_count, last_prefix_hash, last_turn_at, total_cached_tokens, prefix_hits
                ) VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6)
                ON CONFLICT(session_id) DO UPDATE SET
                    provider = excluded.provider,
                    frozen_message_count = excluded.frozen_message_count,
                    last_prefix_hash = excluded.last_prefix_hash,
                    last_turn_at = excluded.last_turn_at,
                    prefix_hits = kv_sessions.prefix_hits + excluded.prefix_hits",
                params![
                    kv_key,
                    provider,
                    frozen_turn_count as i64,
                    frozen_hash,
                    now,
                    i64::from(prefix_hit)
                ],
            )?;
            Ok(())
        })?;

        Ok(LiveZonePlan {
            session_id: kv_key,
            frozen_message_count: frozen_turn_count,
            live_start_index: frozen_turn_count,
            prefix_hit,
            allow_compaction,
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

    #[test]
    fn detects_spanish_and_english_relative_timestamps() {
        let clean = "You are Argos, concise voice assistant. Respond in JSON.";
        assert!(scan_volatile_tokens(clean).is_empty());

        let dirty = "Context updated hace 5s, last build hace 12 min, agent ping 5m ago, sync 30s ago.";
        let findings = scan_volatile_tokens(dirty);
        assert_eq!(findings.len(), 4);
        assert!(findings
            .iter()
            .all(|f| f.category == VolatileCategory::RelativeTimestamp));
        assert_eq!(findings[0].matched, "hace 5s");
        assert_eq!(findings[1].matched, "hace 12 min");
        assert_eq!(findings[2].matched, "5m ago");
        assert_eq!(findings[3].matched, "30s ago");
    }

    #[test]
    fn plans_voice_window_in_batches_without_per_turn_invalidation() {
        let store = ContextStore::open_in_memory().unwrap();
        let aligner = KvAligner::new(store);
        let prefix_hash = sha256_hex("static-argos-prompt");

        let mk_turns = |n: usize| -> Vec<String> {
            (0..n).map(|i| sha256_hex(&format!("turn-{i}"))).collect()
        };

        // Turns 1..=7 with max_live_turns=4 and warm cache: no batch freeze yet.
        let p5 = aligner
            .plan_voice_window("anthropic", &prefix_hash, &mk_turns(5), 4, 5)
            .unwrap();
        assert_eq!(p5.frozen_message_count, 0);
        assert_eq!(p5.live_start_index, 0);
        assert!(!p5.allow_compaction);

        // Turn 8 hits the first batch boundary (8 - 4 = 4 frozen turns).
        let p8 = aligner
            .plan_voice_window("anthropic", &prefix_hash, &mk_turns(8), 4, 5)
            .unwrap();
        assert_eq!(p8.frozen_message_count, 4);
        assert_eq!(p8.live_start_index, 4);
        assert!(p8.allow_compaction);

        // Turns 9..=11 reuse the frozen prefix [0..4] with prefix_hit=true and no compaction.
        let p9 = aligner
            .plan_voice_window("anthropic", &prefix_hash, &mk_turns(9), 4, 5)
            .unwrap();
        assert_eq!(p9.frozen_message_count, 4);
        assert_eq!(p9.live_start_index, 4);
        assert!(p9.prefix_hit);
        assert!(!p9.allow_compaction);

        // Turn 12 advances to the next batch boundary (8 frozen turns).
        let p12 = aligner
            .plan_voice_window("anthropic", &prefix_hash, &mk_turns(12), 4, 5)
            .unwrap();
        assert_eq!(p12.frozen_message_count, 8);
        assert_eq!(p12.live_start_index, 8);
        assert!(p12.prefix_hit);
        assert!(p12.allow_compaction);

        // If cache is expired (idle >= TTL), allow immediate compaction down to max_live_turns.
        let p_expired = aligner
            .plan_voice_window("anthropic", &prefix_hash, &mk_turns(13), 4, 400)
            .unwrap();
        assert_eq!(p_expired.frozen_message_count, 9);
        assert_eq!(p_expired.live_start_index, 9);
        assert!(p_expired.allow_compaction);
    }

    #[test]
    fn plans_thread_window_in_batches_and_records_prefix_hits() {
        let store = ContextStore::open_in_memory().unwrap();
        let aligner = KvAligner::new(store.clone());
        let hashes: Vec<String> = (0..22).map(|i| sha256_hex(&format!("item-{i}"))).collect();

        // Turn 15 (> 14 max_live_items): holds window_start=0 until batch boundary (14+6=20)
        let p15 = aligner
            .plan_thread_window("t-1", "anthropic", &hashes[..15], 14, 6)
            .unwrap();
        assert_eq!(p15.live_start_index, 0);
        assert!(!p15.prefix_hit);

        // Turn 16..18: same window_start=0 -> prefix_hit = true!
        let p16 = aligner
            .plan_thread_window("t-1", "anthropic", &hashes[..16], 14, 6)
            .unwrap();
        assert_eq!(p16.live_start_index, 0);
        assert!(p16.prefix_hit);

        let p17 = aligner
            .plan_thread_window("t-1", "anthropic", &hashes[..17], 14, 6)
            .unwrap();
        assert_eq!(p17.live_start_index, 0);
        assert!(p17.prefix_hit);

        // Turn 20: slides by one full batch of 6 -> live_start_index = 6
        let p20 = aligner
            .plan_thread_window("t-1", "anthropic", &hashes[..20], 14, 6)
            .unwrap();
        assert_eq!(p20.live_start_index, 6);
        assert!(!p20.prefix_hit);

        // Turn 21: holds window_start=6 -> prefix_hit = true!
        let p21 = aligner
            .plan_thread_window("t-1", "anthropic", &hashes[..21], 14, 6)
            .unwrap();
        assert_eq!(p21.live_start_index, 6);
        assert!(p21.prefix_hit);

        let hits: i64 = store
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT prefix_hits FROM kv_sessions WHERE session_id = 'thread:t-1'",
                    [],
                    |r| r.get(0),
                )
                .map_err(Into::into)
            })
            .unwrap();
        assert_eq!(hits, 3);
    }

    #[test]
    fn detects_dom_volatile_attrs_and_plans_browser_window_batches() {
        let dirty = "Element :r1a: id=\"mui-4281\" src=\"/app.tsx?t=1732741234567\" csrf_token=AbCdEf123456 nonce=\"n98765432\"";
        let findings = scan_volatile_tokens(dirty);
        let dom_findings: Vec<_> = findings
            .iter()
            .filter(|f| f.category == VolatileCategory::DomVolatileAttr)
            .collect();
        assert_eq!(dom_findings.len(), 5);

        let store = ContextStore::open_in_memory().unwrap();
        let aligner = KvAligner::new(store);
        let turns: Vec<String> = (0..16).map(|i| sha256_hex(&format!("bturn-{i}"))).collect();

        let p5 = aligner
            .plan_browser_window("tab-1", "anthropic", &turns[..5], 4, 4, 10)
            .unwrap();
        assert_eq!(p5.frozen_message_count, 0);
        assert!(!p5.allow_compaction);

        let p8 = aligner
            .plan_browser_window("tab-1", "anthropic", &turns[..8], 4, 4, 10)
            .unwrap();
        assert_eq!(p8.frozen_message_count, 4);
        assert!(p8.allow_compaction);

        let p9 = aligner
            .plan_browser_window("tab-1", "anthropic", &turns[..9], 4, 4, 10)
            .unwrap();
        assert_eq!(p9.frozen_message_count, 4);
        assert!(p9.prefix_hit);
        assert!(!p9.allow_compaction);
    }
}
