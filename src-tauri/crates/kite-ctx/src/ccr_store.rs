use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::error::{CtxError, Result};
use crate::store::{now_unix_secs, ContextStore};
use crate::tokens::{estimate_tokens, short_hash};

pub const DEFAULT_CCR_TTL_SECS: i64 = 3600;
pub const DEFAULT_CCR_MAX_ENTRIES: usize = 2000;

/// Stored original payload retrievable by content hash.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CcrEntry {
    pub hash: String,
    pub original_text: String,
    pub compressed_preview: String,
    pub strategy: String,
    pub tool_name: String,
    pub original_tokens: usize,
    pub compressed_tokens: usize,
    pub created_at: i64,
    pub expires_at: i64,
}

/// Filtered or full retrieval view over a stored CCR entry.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CcrRetrieveResult {
    pub hash: String,
    pub content: String,
    pub total_lines: usize,
    pub returned_lines: usize,
    pub original_tokens: usize,
    pub strategy: String,
    pub tool_name: String,
}

/// Reversible Compress-Cache-Retrieve persistence backed by SQLite.
#[derive(Clone)]
pub struct CcrStore {
    store: ContextStore,
    default_ttl_secs: i64,
    max_entries: usize,
}

impl CcrStore {
    pub fn new(store: ContextStore) -> Self {
        Self {
            store,
            default_ttl_secs: DEFAULT_CCR_TTL_SECS,
            max_entries: DEFAULT_CCR_MAX_ENTRIES,
        }
    }

    pub fn with_limits(mut self, ttl_secs: i64, max_entries: usize) -> Self {
        self.default_ttl_secs = ttl_secs.max(1);
        self.max_entries = max_entries.max(1);
        self
    }

    /// Guard against storing bare `<<ccr:...>>` sentinel strings as originals.
    pub fn is_bare_marker(text: &str) -> bool {
        let trimmed = text.trim();
        !trimmed.contains('\n') && trimmed.starts_with("<<ccr:") && trimmed.ends_with(">>")
    }

    /// Persist an uncompressed payload and return its 16-hex-char SHA-256 key.
    pub fn put(
        &self,
        original: &str,
        compressed_preview: &str,
        strategy: &str,
        tool_name: &str,
    ) -> Result<String> {
        if original.is_empty() {
            return Err(CtxError::InvalidInput(
                "cannot store empty payload in CCR".to_string(),
            ));
        }
        if Self::is_bare_marker(original) {
            return Err(CtxError::InvalidInput(
                "refusing to store bare CCR marker as original payload".to_string(),
            ));
        }

        let hash = short_hash(original);
        let now = now_unix_secs();
        let expires_at = now + self.default_ttl_secs;
        let original_tokens = estimate_tokens(original) as i64;
        let compressed_tokens = estimate_tokens(compressed_preview) as i64;

        self.store.with_conn(|conn| {
            conn.execute("DELETE FROM ccr_entries WHERE expires_at <= ?1", params![now])?;
            let prev_max: i64 = conn.query_row(
                "SELECT COALESCE(MAX(last_accessed_at), 0) FROM ccr_entries",
                [],
                |r| r.get(0),
            )?;
            let lru_stamp = (now * 1000).max(prev_max + 1);

            conn.execute(
                "INSERT INTO ccr_entries (
                    hash, original_text, compressed_preview, strategy, tool_name,
                    original_tokens, compressed_tokens, created_at, last_accessed_at, expires_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                ON CONFLICT(hash) DO UPDATE SET
                    compressed_preview = excluded.compressed_preview,
                    last_accessed_at = excluded.last_accessed_at,
                    expires_at = excluded.expires_at",
                params![
                    hash,
                    original,
                    compressed_preview,
                    strategy,
                    tool_name,
                    original_tokens,
                    compressed_tokens,
                    now,
                    lru_stamp,
                    expires_at
                ],
            )?;

            let count: i64 =
                conn.query_row("SELECT COUNT(*) FROM ccr_entries", [], |row| row.get(0))?;
            if count as usize > self.max_entries {
                let excess = count - (self.max_entries as i64);
                conn.execute(
                    "DELETE FROM ccr_entries WHERE hash IN (
                        SELECT hash FROM ccr_entries ORDER BY last_accessed_at ASC, created_at ASC LIMIT ?1
                    )",
                    params![excess],
                )?;
            }
            Ok(())
        })?;

        Ok(hash)
    }

    /// Retrieve the verbatim uncompressed entry if still present and unexpired.
    pub fn retrieve(&self, hash: &str) -> Result<CcrEntry> {
        let normalized = hash.trim();
        let now = now_unix_secs();
        self.store.with_conn(|conn| {
            let row = conn
                .query_row(
                    "SELECT hash, original_text, compressed_preview, strategy, tool_name,
                            original_tokens, compressed_tokens, created_at, expires_at
                     FROM ccr_entries
                     WHERE hash = ?1 AND expires_at > ?2",
                    params![normalized, now],
                    |r| {
                        Ok(CcrEntry {
                            hash: r.get(0)?,
                            original_text: r.get(1)?,
                            compressed_preview: r.get(2)?,
                            strategy: r.get(3)?,
                            tool_name: r.get(4)?,
                            original_tokens: r.get::<_, i64>(5)? as usize,
                            compressed_tokens: r.get::<_, i64>(6)? as usize,
                            created_at: r.get(7)?,
                            expires_at: r.get(8)?,
                        })
                    },
                )
                .optional()?;

            let Some(entry) = row else {
                return Err(CtxError::NotFound(format!(
                    "CCR entry '{normalized}' missing or expired"
                )));
            };

            let prev_max: i64 = conn.query_row(
                "SELECT COALESCE(MAX(last_accessed_at), 0) FROM ccr_entries",
                [],
                |r| r.get(0),
            )?;
            let lru_stamp = (now * 1000).max(prev_max + 1);
            conn.execute(
                "UPDATE ccr_entries SET last_accessed_at = ?1 WHERE hash = ?2",
                params![lru_stamp, normalized],
            )?;
            Ok(entry)
        })
    }

    /// Retrieve original content optionally sliced by 1-based line range or substring query.
    pub fn retrieve_filtered(
        &self,
        hash: &str,
        lines: Option<(usize, usize)>,
        search: Option<&str>,
    ) -> Result<CcrRetrieveResult> {
        let entry = self.retrieve(hash)?;
        let all_lines: Vec<&str> = entry.original_text.lines().collect();
        let total_lines = all_lines.len();

        let (content, returned_lines) = if let Some(query) = search.filter(|q| !q.trim().is_empty())
        {
            let needle = query.to_ascii_lowercase();
            let matched: Vec<String> = all_lines
                .iter()
                .enumerate()
                .filter(|(_, line)| line.to_ascii_lowercase().contains(&needle))
                .map(|(idx, line)| format!("{}: {line}", idx + 1))
                .collect();
            let count = matched.len();
            (matched.join("\n"), count)
        } else if let Some((start, end)) = lines {
            let s = start.max(1);
            let e = end.max(s).min(total_lines.max(1));
            if s > total_lines {
                (String::new(), 0)
            } else {
                let slice: Vec<&str> = all_lines[s - 1..e].to_vec();
                let count = slice.len();
                (slice.join("\n"), count)
            }
        } else {
            (entry.original_text.clone(), total_lines)
        };

        Ok(CcrRetrieveResult {
            hash: entry.hash,
            content,
            total_lines,
            returned_lines,
            original_tokens: entry.original_tokens,
            strategy: entry.strategy,
            tool_name: entry.tool_name,
        })
    }

    pub fn evict_expired(&self) -> Result<usize> {
        let now = now_unix_secs();
        self.store.with_conn(|conn| {
            let removed = conn.execute(
                "DELETE FROM ccr_entries WHERE expires_at <= ?1",
                params![now],
            )?;
            Ok(removed)
        })
    }

    pub fn len(&self) -> Result<usize> {
        self.store.with_conn(|conn| {
            let count: i64 =
                conn.query_row("SELECT COUNT(*) FROM ccr_entries", [], |r| r.get(0))?;
            Ok(count as usize)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stores_retrieves_slices_and_searches_ccr_entries() {
        let store = ContextStore::open_in_memory().unwrap();
        let ccr = CcrStore::new(store);

        let raw = "line one alpha\nline two beta\nline three alpha\nline four gamma\n";
        let hash = ccr.put(raw, "preview", "crusher", "search").unwrap();
        assert_eq!(hash.len(), 16);

        let full = ccr.retrieve(&hash).unwrap();
        assert_eq!(full.original_text, raw);

        let sliced = ccr.retrieve_filtered(&hash, Some((2, 3)), None).unwrap();
        assert_eq!(sliced.returned_lines, 2);
        assert_eq!(sliced.content, "line two beta\nline three alpha");

        let searched = ccr.retrieve_filtered(&hash, None, Some("ALPHA")).unwrap();
        assert_eq!(searched.returned_lines, 2);
        assert!(searched.content.contains("1: line one alpha"));
        assert!(searched.content.contains("3: line three alpha"));
    }

    #[test]
    fn rejects_bare_ccr_markers_and_enforces_lru_cap() {
        let store = ContextStore::open_in_memory().unwrap();
        let ccr = CcrStore::new(store).with_limits(3600, 2);

        let err = ccr.put("<<ccr:0123456789abcdef>>", "p", "test", "tool");
        assert!(err.is_err());

        let h1 = ccr.put("payload-one-abc", "p1", "test", "t").unwrap();
        let h2 = ccr.put("payload-two-def", "p2", "test", "t").unwrap();
        // Touch h1 so h2 becomes LRU
        let _ = ccr.retrieve(&h1).unwrap();
        let h3 = ccr.put("payload-three-ghi", "p3", "test", "t").unwrap();

        assert_eq!(ccr.len().unwrap(), 2);
        assert!(ccr.retrieve(&h1).is_ok());
        assert!(ccr.retrieve(&h3).is_ok());
        assert!(ccr.retrieve(&h2).is_err());
    }
}
