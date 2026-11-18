use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::ccr_store::CcrStore;
use crate::crusher::SmartCrusher;
use crate::error::{CtxError, Result};
use crate::lossless::compact_lossless;
use crate::pipeline::{detect_content_kind, ContentKind};
use crate::store::{now_unix_secs, ContextStore};
use crate::tokens::{estimate_tokens, sha256_hex};

pub const DEFAULT_SHARED_TTL_SECS: i64 = 3600;

/// Hierarchical scope controlling cross-session and inter-agent visibility.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextScope {
    User,
    Project,
    Session,
    Agent,
    Turn,
}

impl ContextScope {
    pub fn parse(raw: &str) -> Result<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "user" => Ok(Self::User),
            "project" => Ok(Self::Project),
            "session" => Ok(Self::Session),
            "agent" => Ok(Self::Agent),
            "turn" => Ok(Self::Turn),
            other => Err(CtxError::InvalidInput(format!(
                "invalid context scope '{other}' (expected user|project|session|agent|turn)"
            ))),
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Project => "project",
            Self::Session => "session",
            Self::Agent => "agent",
            Self::Turn => "turn",
        }
    }
}

/// Metadata + compressed content stored for inter-agent handoffs.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SharedEntry {
    pub scope: ContextScope,
    pub scope_id: String,
    pub key: String,
    pub source_agent: String,
    pub source_provider: String,
    pub compressed_text: String,
    pub ccr_hash: String,
    pub original_tokens: usize,
    pub compressed_tokens: usize,
    pub transforms: Vec<String>,
    pub tree_hash: Option<String>,
    pub created_at: i64,
    pub expires_at: i64,
}

impl SharedEntry {
    pub fn savings_percent(&self) -> f64 {
        if self.original_tokens == 0 {
            return 0.0;
        }
        let saved = self.original_tokens.saturating_sub(self.compressed_tokens);
        (saved as f64 / self.original_tokens as f64) * 100.0
    }
}

/// Cached cross-session tool/command output invalidated by git tree or file hash.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ToolCacheEntry {
    pub cache_key: String,
    pub workspace_root: String,
    pub tree_hash: String,
    pub tool_name: String,
    pub compressed_output: String,
    pub ccr_hash: Option<String>,
    pub raw_tokens: usize,
    pub compressed_tokens: usize,
}

/// Shared inter-agent compressed handoff store and cross-session tool-result cache.
#[derive(Clone)]
pub struct SharedContextStore {
    store: ContextStore,
    ccr: CcrStore,
    ttl_secs: i64,
}

impl SharedContextStore {
    pub fn new(store: ContextStore) -> Self {
        let ccr = CcrStore::new(store.clone());
        Self {
            store,
            ccr,
            ttl_secs: DEFAULT_SHARED_TTL_SECS,
        }
    }

    pub fn with_ttl(mut self, ttl_secs: i64) -> Self {
        self.ttl_secs = ttl_secs.max(1);
        self
    }

    /// Compress `content`, store original in CCR, and save entry under `(scope, scope_id, key)`.
    #[allow(clippy::too_many_arguments)]
    pub fn put(
        &self,
        scope: ContextScope,
        scope_id: &str,
        key: &str,
        content: &str,
        source_agent: &str,
        source_provider: &str,
        tree_hash: Option<&str>,
    ) -> Result<SharedEntry> {
        let kind = detect_content_kind(content);
        let (compressed_text, transform_name, ccr_hash) = match kind {
            ContentKind::Json => {
                let res = SmartCrusher::default().crush(content, Some(&self.ccr))?;
                let hash = match res.ccr_hash {
                    Some(h) => h,
                    None => self
                        .ccr
                        .put(content, &res.output, res.stage, "shared_ctx")?,
                };
                (res.output, res.stage.to_string(), hash)
            }
            _ => {
                let folded = compact_lossless(content, kind);
                let hash = self
                    .ccr
                    .put(content, &folded, "lossless", "shared_ctx")?;
                (folded, format!("lossless:{kind:?}"), hash)
            }
        };

        let original_tokens = estimate_tokens(content);
        let compressed_tokens = estimate_tokens(&compressed_text);
        let transforms = vec![transform_name];
        let transforms_json = serde_json::to_string(&transforms)?;
        let now = now_unix_secs();
        let expires_at = now + self.ttl_secs;

        self.store.with_conn(|conn| {
            conn.execute(
                "DELETE FROM shared_entries WHERE expires_at <= ?1",
                params![now],
            )?;
            conn.execute(
                "INSERT INTO shared_entries (
                    scope, scope_id, key_name, source_agent, source_provider,
                    compressed_text, ccr_hash, original_tokens, compressed_tokens,
                    transforms_json, tree_hash, created_at, expires_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
                ON CONFLICT(scope, scope_id, key_name) DO UPDATE SET
                    source_agent = excluded.source_agent,
                    source_provider = excluded.source_provider,
                    compressed_text = excluded.compressed_text,
                    ccr_hash = excluded.ccr_hash,
                    original_tokens = excluded.original_tokens,
                    compressed_tokens = excluded.compressed_tokens,
                    transforms_json = excluded.transforms_json,
                    tree_hash = excluded.tree_hash,
                    created_at = excluded.created_at,
                    expires_at = excluded.expires_at",
                params![
                    scope.as_str(),
                    scope_id,
                    key,
                    source_agent,
                    source_provider,
                    compressed_text,
                    ccr_hash,
                    original_tokens as i64,
                    compressed_tokens as i64,
                    transforms_json,
                    tree_hash,
                    now,
                    expires_at
                ],
            )?;
            Ok(())
        })?;

        Ok(SharedEntry {
            scope,
            scope_id: scope_id.to_string(),
            key: key.to_string(),
            source_agent: source_agent.to_string(),
            source_provider: source_provider.to_string(),
            compressed_text,
            ccr_hash,
            original_tokens,
            compressed_tokens,
            transforms,
            tree_hash: tree_hash.map(str::to_string),
            created_at: now,
            expires_at,
        })
    }

    pub fn get_entry(
        &self,
        scope: ContextScope,
        scope_id: &str,
        key: &str,
    ) -> Result<Option<SharedEntry>> {
        let now = now_unix_secs();
        self.store.with_conn(|conn| {
            let row = conn
                .query_row(
                    "SELECT source_agent, source_provider, compressed_text, ccr_hash,
                            original_tokens, compressed_tokens, transforms_json, tree_hash,
                            created_at, expires_at
                     FROM shared_entries
                     WHERE scope = ?1 AND scope_id = ?2 AND key_name = ?3 AND expires_at > ?4",
                    params![scope.as_str(), scope_id, key, now],
                    |r| {
                        let transforms_raw: String = r.get(6)?;
                        let transforms =
                            serde_json::from_str::<Vec<String>>(&transforms_raw).unwrap_or_default();
                        Ok(SharedEntry {
                            scope,
                            scope_id: scope_id.to_string(),
                            key: key.to_string(),
                            source_agent: r.get(0)?,
                            source_provider: r.get(1)?,
                            compressed_text: r.get(2)?,
                            ccr_hash: r.get(3)?,
                            original_tokens: r.get::<_, i64>(4)? as usize,
                            compressed_tokens: r.get::<_, i64>(5)? as usize,
                            transforms,
                            tree_hash: r.get(7)?,
                            created_at: r.get(8)?,
                            expires_at: r.get(9)?,
                        })
                    },
                )
                .optional()?;
            Ok(row)
        })
    }

    /// Retrieve compressed handoff by default, or verbatim original when `full == true`.
    pub fn get(
        &self,
        scope: ContextScope,
        scope_id: &str,
        key: &str,
        full: bool,
    ) -> Result<Option<String>> {
        let Some(entry) = self.get_entry(scope, scope_id, key)? else {
            return Ok(None);
        };
        if !full {
            return Ok(Some(entry.compressed_text));
        }
        match self.ccr.retrieve(&entry.ccr_hash) {
            Ok(orig) => Ok(Some(orig.original_text)),
            Err(_) => Ok(Some(entry.compressed_text)),
        }
    }

    pub fn list_keys(&self, scope: ContextScope, scope_id: &str) -> Result<Vec<String>> {
        let now = now_unix_secs();
        self.store.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT key_name FROM shared_entries
                 WHERE scope = ?1 AND scope_id = ?2 AND expires_at > ?3
                 ORDER BY created_at DESC",
            )?;
            let mut rows = stmt.query(params![scope.as_str(), scope_id, now])?;
            let mut keys = Vec::new();
            while let Some(r) = rows.next()? {
                keys.push(r.get(0)?);
            }
            Ok(keys)
        })
    }

    /// Store a cross-session tool/command result tied to the current workspace tree hash.
    pub fn put_tool_cache(
        &self,
        workspace_root: &str,
        tree_hash: &str,
        tool_name: &str,
        canonical_args: &str,
        raw_output: &str,
    ) -> Result<ToolCacheEntry> {
        let args_hash = sha256_hex(canonical_args);
        let cache_key = sha256_hex(&format!(
            "{workspace_root}|{tree_hash}|{tool_name}|{args_hash}"
        ));
        let kind = detect_content_kind(raw_output);
        let (compressed_output, ccr_hash) = match kind {
            ContentKind::Json => {
                let res = SmartCrusher::default().crush(raw_output, Some(&self.ccr))?;
                (res.output, res.ccr_hash)
            }
            _ => (compact_lossless(raw_output, kind), None),
        };
        let raw_tokens = estimate_tokens(raw_output);
        let compressed_tokens = estimate_tokens(&compressed_output);
        let now = now_unix_secs();
        let expires_at = now + self.ttl_secs;

        self.store.with_conn(|conn| {
            conn.execute(
                "INSERT INTO tool_cache (
                    cache_key, workspace_root, tree_hash, tool_name, args_hash,
                    compressed_output, ccr_hash, raw_tokens, compressed_tokens, created_at, expires_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                ON CONFLICT(cache_key) DO UPDATE SET
                    compressed_output = excluded.compressed_output,
                    ccr_hash = excluded.ccr_hash,
                    raw_tokens = excluded.raw_tokens,
                    compressed_tokens = excluded.compressed_tokens,
                    created_at = excluded.created_at,
                    expires_at = excluded.expires_at",
                params![
                    cache_key,
                    workspace_root,
                    tree_hash,
                    tool_name,
                    args_hash,
                    compressed_output,
                    ccr_hash,
                    raw_tokens as i64,
                    compressed_tokens as i64,
                    now,
                    expires_at
                ],
            )?;
            Ok(())
        })?;

        Ok(ToolCacheEntry {
            cache_key,
            workspace_root: workspace_root.to_string(),
            tree_hash: tree_hash.to_string(),
            tool_name: tool_name.to_string(),
            compressed_output,
            ccr_hash,
            raw_tokens,
            compressed_tokens,
        })
    }

    /// Look up a cached cross-session tool result; automatically misses when `tree_hash` changes.
    pub fn get_tool_cache(
        &self,
        workspace_root: &str,
        current_tree_hash: &str,
        tool_name: &str,
        canonical_args: &str,
    ) -> Result<Option<ToolCacheEntry>> {
        let args_hash = sha256_hex(canonical_args);
        let cache_key = sha256_hex(&format!(
            "{workspace_root}|{current_tree_hash}|{tool_name}|{args_hash}"
        ));
        let now = now_unix_secs();
        self.store.with_conn(|conn| {
            let row = conn
                .query_row(
                    "SELECT cache_key, workspace_root, tree_hash, tool_name,
                            compressed_output, ccr_hash, raw_tokens, compressed_tokens
                     FROM tool_cache
                     WHERE cache_key = ?1 AND expires_at > ?2",
                    params![cache_key, now],
                    |r| {
                        Ok(ToolCacheEntry {
                            cache_key: r.get(0)?,
                            workspace_root: r.get(1)?,
                            tree_hash: r.get(2)?,
                            tool_name: r.get(3)?,
                            compressed_output: r.get(4)?,
                            ccr_hash: r.get(5)?,
                            raw_tokens: r.get::<_, i64>(6)? as usize,
                            compressed_tokens: r.get::<_, i64>(7)? as usize,
                        })
                    },
                )
                .optional()?;
            Ok(row)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shares_compressed_handoffs_with_provenance_and_full_recovery() {
        let store = ContextStore::open_in_memory().unwrap();
        let shared = SharedContextStore::new(store);
        let items: Vec<_> = (0..40)
            .map(|i| {
                serde_json::json!({
                    "id": i,
                    "file": "src-tauri/crates/kite-ctx/src/shared_ctx.rs",
                    "status": "checked"
                })
            })
            .collect();
        let raw = serde_json::to_string_pretty(&items).unwrap();

        let entry = shared
            .put(
                ContextScope::Project,
                "kite",
                "audit-findings",
                &raw,
                "Orion",
                "anthropic",
                Some("tree-aaa"),
            )
            .unwrap();
        assert_eq!(entry.source_agent, "Orion");
        assert_eq!(entry.source_provider, "anthropic");
        assert!(entry.compressed_tokens < entry.original_tokens);

        // Scope isolation: session scope must not see project scope entry.
        assert!(shared
            .get(ContextScope::Session, "kite", "audit-findings", false)
            .unwrap()
            .is_none());

        let compressed = shared
            .get(ContextScope::Project, "kite", "audit-findings", false)
            .unwrap()
            .unwrap();
        assert_eq!(compressed, entry.compressed_text);

        let full = shared
            .get(ContextScope::Project, "kite", "audit-findings", true)
            .unwrap()
            .unwrap();
        assert_eq!(full, raw);
    }

    #[test]
    fn invalidates_cross_session_tool_cache_when_tree_hash_changes() {
        let store = ContextStore::open_in_memory().unwrap();
        let shared = SharedContextStore::new(store);
        let raw_out = "src/a.rs:1:hello\nsrc/a.rs:2:world\nsrc/a.rs:3:ok\n";

        shared
            .put_tool_cache("/repo/kite", "git-tree-1", "rg", "pattern=hello", raw_out)
            .unwrap();

        let hit = shared
            .get_tool_cache("/repo/kite", "git-tree-1", "rg", "pattern=hello")
            .unwrap();
        assert!(hit.is_some());

        let miss = shared
            .get_tool_cache("/repo/kite", "git-tree-2", "rg", "pattern=hello")
            .unwrap();
        assert!(miss.is_none());
    }
}
