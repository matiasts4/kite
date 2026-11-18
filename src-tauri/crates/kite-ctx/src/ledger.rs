use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::store::{now_unix_secs, ContextStore};

/// Input record captured whenever `kite-ctx` compresses, deduplicates, or reuses context.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LedgerEventInput {
    pub session_id: String,
    pub agent: String,
    pub provider: String,
    pub model: String,
    pub category: String,
    pub command_or_tool: String,
    pub raw_tokens: usize,
    pub compressed_tokens: usize,
    pub cache_hit: bool,
    pub overhead_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TotalsSummary {
    pub requests: usize,
    pub raw_tokens: usize,
    pub compressed_tokens: usize,
    pub tokens_saved: usize,
    pub savings_percent: f64,
    pub cache_hits: usize,
    pub cache_hit_rate: f64,
    pub estimated_usd_saved: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentBreakdown {
    pub agent: String,
    pub requests: usize,
    pub tokens_saved: usize,
    pub savings_percent: f64,
    pub cache_hits: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ModelBreakdown {
    pub model: String,
    pub requests: usize,
    pub tokens_saved: usize,
    pub savings_usd: f64,
    pub savings_percent: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CategoryBreakdown {
    pub category: String,
    pub requests: usize,
    pub tokens_saved: usize,
    pub savings_percent: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FeatureBreakdown {
    pub feature: String,
    pub category: String,
    pub requests: usize,
    pub raw_tokens: usize,
    pub compressed_tokens: usize,
    pub tokens_saved: usize,
    pub savings_percent: f64,
    pub cache_hits: usize,
    pub avg_overhead_ms: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct QuotaPreservation {
    pub saved_tokens_30d: usize,
    pub pro_equivalent_pct: f64,
    pub tier_5x_pct: f64,
    pub tier_20x_pct: f64,
}

/// Complete telemetry snapshot consumed by both `kite ctx stats --json` and Kite Desktop UI.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MonitorSnapshot {
    pub ok: bool,
    pub engine_version: String,
    pub db_path: Option<String>,
    pub active_session_id: Option<String>,
    pub lifetime: TotalsSummary,
    pub session: TotalsSummary,
    pub agents: Vec<AgentBreakdown>,
    pub models: Vec<ModelBreakdown>,
    pub categories: Vec<CategoryBreakdown>,
    #[serde(default)]
    pub features: Vec<FeatureBreakdown>,
    #[serde(default)]
    pub discovery: crate::discover::DiscoverySummary,
    pub recent_sparkline: Vec<usize>,
    pub avg_overhead_ms: f64,
    pub ccr_entries: usize,
    pub shared_entries: usize,
    pub read_records: usize,
    pub quota_preservation: QuotaPreservation,
}

/// Persistent SQLite token-savings & quota telemetry ledger.
#[derive(Clone)]
pub struct SavingsLedger {
    store: ContextStore,
}

impl SavingsLedger {
    pub fn new(store: ContextStore) -> Self {
        Self { store }
    }

    /// Record a single context optimization or cache-reuse event.
    pub fn record(&self, event: &LedgerEventInput) -> Result<()> {
        let tokens_saved = event.raw_tokens.saturating_sub(event.compressed_tokens);
        let now = now_unix_secs();
        self.store.with_conn(|conn| {
            conn.execute(
                "INSERT INTO ledger_events (
                    session_id, agent, provider, model, category, command_or_tool,
                    raw_tokens, compressed_tokens, tokens_saved, cache_hit, overhead_ms, created_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                params![
                    event.session_id,
                    event.agent,
                    event.provider,
                    event.model,
                    event.category,
                    event.command_or_tool,
                    event.raw_tokens as i64,
                    event.compressed_tokens as i64,
                    tokens_saved as i64,
                    i64::from(event.cache_hit),
                    event.overhead_ms as i64,
                    now
                ],
            )?;
            Ok(())
        })
    }

    pub fn reset(&self) -> Result<()> {
        self.store.with_conn(|conn| {
            conn.execute("DELETE FROM ledger_events", [])?;
            Ok(())
        })
    }

    /// Build a complete telemetry snapshot across lifetime and active session.
    pub fn snapshot(&self, session_filter: Option<&str>) -> Result<MonitorSnapshot> {
        let now = now_unix_secs();
        self.store.with_conn(|conn| {
            let resolved_session: Option<String> = match session_filter {
                Some(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
                _ => conn
                    .query_row(
                        "SELECT session_id FROM ledger_events ORDER BY id DESC LIMIT 1",
                        [],
                        |r| r.get(0),
                    )
                    .ok(),
            };

            let lifetime = query_totals(conn, None)?;
            let session = match resolved_session.as_deref() {
                Some(sid) => query_totals(conn, Some(sid))?,
                None => empty_totals(),
            };

            let agents = query_agents(conn, resolved_session.as_deref())?;
            let models = query_models(conn)?;
            let categories = query_categories(conn)?;
            let features = query_features(conn)?;

            let mut spark_stmt = conn.prepare(
                "SELECT tokens_saved FROM ledger_events ORDER BY id DESC LIMIT 24",
            )?;
            let mut spark_rows = spark_stmt.query([])?;
            let mut recent_sparkline = Vec::new();
            while let Some(r) = spark_rows.next()? {
                recent_sparkline.push(r.get::<_, i64>(0)?.max(0) as usize);
            }
            recent_sparkline.reverse();

            let avg_overhead_ms: f64 = conn.query_row(
                "SELECT COALESCE(AVG(overhead_ms), 0.0) FROM ledger_events",
                [],
                |r| r.get(0),
            )?;

            let ccr_entries: usize = conn
                .query_row(
                    "SELECT COUNT(*) FROM ccr_entries WHERE expires_at > ?1",
                    params![now],
                    |r| r.get::<_, i64>(0),
                )
                .unwrap_or(0) as usize;
            let shared_entries: usize = conn
                .query_row(
                    "SELECT COUNT(*) FROM shared_entries WHERE expires_at > ?1",
                    params![now],
                    |r| r.get::<_, i64>(0),
                )
                .unwrap_or(0) as usize;
            let read_records: usize = conn
                .query_row("SELECT COUNT(*) FROM read_records", [], |r| {
                    r.get::<_, i64>(0)
                })
                .unwrap_or(0) as usize;

            let window_start = now - (30 * 86_400);
            let saved_tokens_30d: usize = conn
                .query_row(
                    "SELECT COALESCE(SUM(tokens_saved), 0) FROM ledger_events WHERE created_at >= ?1",
                    params![window_start],
                    |r| r.get::<_, i64>(0),
                )
                .unwrap_or(0)
                .max(0) as usize;

            // Approximate monthly token quota capacity benchmarks per tier (in tokens).
            let quota_preservation = QuotaPreservation {
                saved_tokens_30d,
                pro_equivalent_pct: ((saved_tokens_30d as f64 / 5_000_000.0) * 100.0).min(100.0),
                tier_5x_pct: ((saved_tokens_30d as f64 / 25_000_000.0) * 100.0).min(100.0),
                tier_20x_pct: ((saved_tokens_30d as f64 / 100_000_000.0) * 100.0).min(100.0),
            };

            Ok(MonitorSnapshot {
                ok: true,
                engine_version: env!("CARGO_PKG_VERSION").to_string(),
                db_path: self
                    .store
                    .db_path()
                    .map(|p| p.to_string_lossy().into_owned()),
                active_session_id: resolved_session,
                lifetime,
                session,
                agents,
                models,
                categories,
                features,
                discovery: crate::discover::DiscoverySummary::default(),
                recent_sparkline,
                avg_overhead_ms,
                ccr_entries,
                shared_entries,
                read_records,
                quota_preservation,
            })
        })
    }
}

fn empty_totals() -> TotalsSummary {
    TotalsSummary {
        requests: 0,
        raw_tokens: 0,
        compressed_tokens: 0,
        tokens_saved: 0,
        savings_percent: 0.0,
        cache_hits: 0,
        cache_hit_rate: 0.0,
        estimated_usd_saved: 0.0,
    }
}

fn estimate_usd_per_token(model: &str) -> f64 {
    let lower = model.to_ascii_lowercase();
    if lower.contains("opus") {
        15.0 / 1_000_000.0
    } else if lower.contains("sonnet") || lower.contains("grok") || lower.contains("gpt") {
        3.0 / 1_000_000.0
    } else if lower.contains("haiku") || lower.contains("flash") {
        0.50 / 1_000_000.0
    } else {
        3.0 / 1_000_000.0
    }
}

fn query_totals(conn: &rusqlite::Connection, session_id: Option<&str>) -> Result<TotalsSummary> {
    let (sql, param_val): (&str, Option<&str>) = match session_id {
        Some(sid) => (
            "SELECT COUNT(*), COALESCE(SUM(raw_tokens), 0), COALESCE(SUM(compressed_tokens), 0),
                    COALESCE(SUM(tokens_saved), 0), COALESCE(SUM(cache_hit), 0)
             FROM ledger_events WHERE session_id = ?1",
            Some(sid),
        ),
        None => (
            "SELECT COUNT(*), COALESCE(SUM(raw_tokens), 0), COALESCE(SUM(compressed_tokens), 0),
                    COALESCE(SUM(tokens_saved), 0), COALESCE(SUM(cache_hit), 0)
             FROM ledger_events",
            None,
        ),
    };

    let (requests, raw_tokens, compressed_tokens, tokens_saved, cache_hits) = match param_val {
        Some(sid) => conn.query_row(sql, params![sid], |r| {
            Ok((
                r.get::<_, i64>(0)? as usize,
                r.get::<_, i64>(1)? as usize,
                r.get::<_, i64>(2)? as usize,
                r.get::<_, i64>(3)? as usize,
                r.get::<_, i64>(4)? as usize,
            ))
        })?,
        None => conn.query_row(sql, [], |r| {
            Ok((
                r.get::<_, i64>(0)? as usize,
                r.get::<_, i64>(1)? as usize,
                r.get::<_, i64>(2)? as usize,
                r.get::<_, i64>(3)? as usize,
                r.get::<_, i64>(4)? as usize,
            ))
        })?,
    };

    // Estimate USD per model row accurately.
    let model_sql = if session_id.is_some() {
        "SELECT model, COALESCE(SUM(tokens_saved), 0) FROM ledger_events WHERE session_id = ?1 GROUP BY model"
    } else {
        "SELECT model, COALESCE(SUM(tokens_saved), 0) FROM ledger_events GROUP BY model"
    };
    let mut stmt = conn.prepare(model_sql)?;
    let mut usd = 0.0;
    let mut rows = match param_val {
        Some(sid) => stmt.query(params![sid])?,
        None => stmt.query([])?,
    };
    while let Some(r) = rows.next()? {
        let model: String = r.get(0)?;
        let saved: i64 = r.get(1)?;
        usd += (saved.max(0) as f64) * estimate_usd_per_token(&model);
    }

    let savings_percent = if raw_tokens > 0 {
        (tokens_saved as f64 / raw_tokens as f64) * 100.0
    } else {
        0.0
    };
    let cache_hit_rate = if requests > 0 {
        (cache_hits as f64 / requests as f64) * 100.0
    } else {
        0.0
    };

    Ok(TotalsSummary {
        requests,
        raw_tokens,
        compressed_tokens,
        tokens_saved,
        savings_percent,
        cache_hits,
        cache_hit_rate,
        estimated_usd_saved: usd,
    })
}

fn query_agents(
    conn: &rusqlite::Connection,
    session_id: Option<&str>,
) -> Result<Vec<AgentBreakdown>> {
    let sql = if session_id.is_some() {
        "SELECT agent, COUNT(*), COALESCE(SUM(raw_tokens), 0), COALESCE(SUM(tokens_saved), 0), COALESCE(SUM(cache_hit), 0)
         FROM ledger_events WHERE session_id = ?1 GROUP BY agent ORDER BY SUM(tokens_saved) DESC"
    } else {
        "SELECT agent, COUNT(*), COALESCE(SUM(raw_tokens), 0), COALESCE(SUM(tokens_saved), 0), COALESCE(SUM(cache_hit), 0)
         FROM ledger_events GROUP BY agent ORDER BY SUM(tokens_saved) DESC"
    };
    let mut stmt = conn.prepare(sql)?;
    let mut rows = match session_id {
        Some(sid) => stmt.query(params![sid])?,
        None => stmt.query([])?,
    };
    let mut out = Vec::new();
    while let Some(r) = rows.next()? {
        let agent: String = r.get(0)?;
        let requests = r.get::<_, i64>(1)? as usize;
        let raw = r.get::<_, i64>(2)? as usize;
        let saved = r.get::<_, i64>(3)? as usize;
        let cache_hits = r.get::<_, i64>(4)? as usize;
        let savings_percent = if raw > 0 {
            (saved as f64 / raw as f64) * 100.0
        } else {
            0.0
        };
        out.push(AgentBreakdown {
            agent,
            requests,
            tokens_saved: saved,
            savings_percent,
            cache_hits,
        });
    }
    Ok(out)
}

fn query_models(conn: &rusqlite::Connection) -> Result<Vec<ModelBreakdown>> {
    let mut stmt = conn.prepare(
        "SELECT model, COUNT(*), COALESCE(SUM(raw_tokens), 0), COALESCE(SUM(tokens_saved), 0)
         FROM ledger_events GROUP BY model ORDER BY SUM(tokens_saved) DESC",
    )?;
    let mut rows = stmt.query([])?;
    let mut out = Vec::new();
    while let Some(r) = rows.next()? {
        let model: String = r.get(0)?;
        let requests = r.get::<_, i64>(1)? as usize;
        let raw = r.get::<_, i64>(2)? as usize;
        let saved = r.get::<_, i64>(3)? as usize;
        let savings_usd = (saved as f64) * estimate_usd_per_token(&model);
        let savings_percent = if raw > 0 {
            (saved as f64 / raw as f64) * 100.0
        } else {
            0.0
        };
        out.push(ModelBreakdown {
            model,
            requests,
            tokens_saved: saved,
            savings_usd,
            savings_percent,
        });
    }
    Ok(out)
}

fn query_categories(conn: &rusqlite::Connection) -> Result<Vec<CategoryBreakdown>> {
    let mut stmt = conn.prepare(
        "SELECT category, COUNT(*), COALESCE(SUM(raw_tokens), 0), COALESCE(SUM(tokens_saved), 0)
         FROM ledger_events GROUP BY category ORDER BY SUM(tokens_saved) DESC",
    )?;
    let mut rows = stmt.query([])?;
    let mut out = Vec::new();
    while let Some(r) = rows.next()? {
        let category: String = r.get(0)?;
        let requests = r.get::<_, i64>(1)? as usize;
        let raw = r.get::<_, i64>(2)? as usize;
        let saved = r.get::<_, i64>(3)? as usize;
        let savings_percent = if raw > 0 {
            (saved as f64 / raw as f64) * 100.0
        } else {
            0.0
        };
        out.push(CategoryBreakdown {
            category,
            requests,
            tokens_saved: saved,
            savings_percent,
        });
    }
    Ok(out)
}

pub fn normalize_feature_name(category: &str, command_or_tool: &str) -> String {
    let cat = category.trim();
    let tool = command_or_tool.trim();
    match cat {
        "read" => {
            if tool == "read:stub" {
                "read:dedup".to_string()
            } else if tool.starts_with("read:lines:") {
                "read:lines".to_string()
            } else if tool.is_empty() {
                "read:auto".to_string()
            } else {
                tool.to_string()
            }
        }
        "exec" | "cmd" => {
            if tool.is_empty() {
                "exec:generic".to_string()
            } else if tool.starts_with("exec:") {
                tool.to_string()
            } else {
                format!("exec:{tool}")
            }
        }
        "compress" => {
            if tool.is_empty() {
                "compress:auto".to_string()
            } else {
                tool.to_string()
            }
        }
        "share" => {
            if tool.is_empty() {
                "share:put".to_string()
            } else {
                tool.to_string()
            }
        }
        "ccr" => {
            if tool.is_empty() {
                "ccr:retrieve".to_string()
            } else {
                tool.to_string()
            }
        }
        "mcp" => {
            if tool.is_empty() {
                "mcp:stdio".to_string()
            } else if tool.starts_with("mcp:") {
                tool.to_string()
            } else {
                format!("mcp:{tool}")
            }
        }
        "runtime" => {
            if tool.is_empty() {
                "runtime:thread_history".to_string()
            } else if tool.starts_with("runtime:") {
                tool.to_string()
            } else {
                format!("runtime:{tool}")
            }
        }
        other => {
            if tool.is_empty() {
                other.to_string()
            } else {
                format!("{other}:{tool}")
            }
        }
    }
}

fn query_features(conn: &rusqlite::Connection) -> Result<Vec<FeatureBreakdown>> {
    #[derive(Default)]
    struct Accum {
        category: String,
        requests: usize,
        raw_tokens: usize,
        compressed_tokens: usize,
        tokens_saved: usize,
        cache_hits: usize,
        overhead_sum_ms: u64,
    }

    let mut stmt = conn.prepare(
        "SELECT category, command_or_tool, raw_tokens, compressed_tokens, tokens_saved, cache_hit, overhead_ms
         FROM ledger_events",
    )?;
    let mut rows = stmt.query([])?;
    let mut grouped: std::collections::BTreeMap<String, Accum> = std::collections::BTreeMap::new();

    while let Some(r) = rows.next()? {
        let category: String = r.get(0)?;
        let command_or_tool: String = r.get(1)?;
        let raw = r.get::<_, i64>(2)?.max(0) as usize;
        let compressed = r.get::<_, i64>(3)?.max(0) as usize;
        let saved = r.get::<_, i64>(4)?.max(0) as usize;
        let cache_hit = r.get::<_, i64>(5)? > 0;
        let overhead_ms = r.get::<_, i64>(6)?.max(0) as u64;

        let feature = normalize_feature_name(&category, &command_or_tool);
        let entry = grouped.entry(feature).or_default();
        if entry.category.is_empty() {
            entry.category = category;
        }
        entry.requests += 1;
        entry.raw_tokens += raw;
        entry.compressed_tokens += compressed;
        entry.tokens_saved += saved;
        if cache_hit {
            entry.cache_hits += 1;
        }
        entry.overhead_sum_ms += overhead_ms;
    }

    let mut out: Vec<FeatureBreakdown> = grouped
        .into_iter()
        .map(|(feature, acc)| {
            let savings_percent = if acc.raw_tokens > 0 {
                (acc.tokens_saved as f64 / acc.raw_tokens as f64) * 100.0
            } else {
                0.0
            };
            let avg_overhead_ms = if acc.requests > 0 {
                acc.overhead_sum_ms as f64 / acc.requests as f64
            } else {
                0.0
            };
            FeatureBreakdown {
                feature,
                category: acc.category,
                requests: acc.requests,
                raw_tokens: acc.raw_tokens,
                compressed_tokens: acc.compressed_tokens,
                tokens_saved: acc.tokens_saved,
                savings_percent,
                cache_hits: acc.cache_hits,
                avg_overhead_ms,
            }
        })
        .collect();

    out.sort_by(|a, b| {
        b.tokens_saved
            .cmp(&a.tokens_saved)
            .then_with(|| b.requests.cmp(&a.requests))
            .then_with(|| a.feature.cmp(&b.feature))
    });
    out.truncate(20);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_and_aggregates_lifetime_and_session_breakdowns() {
        let store = ContextStore::open_in_memory().unwrap();
        let ledger = SavingsLedger::new(store);

        ledger
            .record(&LedgerEventInput {
                session_id: "s-alpha".to_string(),
                agent: "Orion".to_string(),
                provider: "anthropic".to_string(),
                model: "claude-sonnet-4-5".to_string(),
                category: "cmd".to_string(),
                command_or_tool: "cargo test".to_string(),
                raw_tokens: 10_000,
                compressed_tokens: 500,
                cache_hit: false,
                overhead_ms: 4,
            })
            .unwrap();

        ledger
            .record(&LedgerEventInput {
                session_id: "s-beta".to_string(),
                agent: "Nova".to_string(),
                provider: "google".to_string(),
                model: "gemini-2.5-pro".to_string(),
                category: "read".to_string(),
                command_or_tool: "kite ctx read".to_string(),
                raw_tokens: 4_000,
                compressed_tokens: 20,
                cache_hit: true,
                overhead_ms: 1,
            })
            .unwrap();

        let snap = ledger.snapshot(Some("s-beta")).unwrap();
        assert!(snap.ok);
        assert_eq!(snap.lifetime.requests, 2);
        assert_eq!(snap.lifetime.tokens_saved, 13_480);
        assert_eq!(snap.lifetime.cache_hits, 1);
        assert_eq!(snap.session.requests, 1);
        assert_eq!(snap.session.tokens_saved, 3_980);
        assert_eq!(snap.agents.len(), 1);
        assert_eq!(snap.agents[0].agent, "Nova");
        assert_eq!(snap.models.len(), 2);
        assert!(
            snap.features.iter().any(|f| f.feature == "exec:cargo test" && f.tokens_saved == 9_500),
            "expected feature breakdown for cargo test: {:?}",
            snap.features
        );
    }
}
