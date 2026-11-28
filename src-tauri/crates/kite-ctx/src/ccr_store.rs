use std::collections::BTreeSet;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::error::{CtxError, Result};
use crate::store::{now_unix_secs, ContextStore};
use crate::tokens::{estimate_tokens, short_hash};

pub const DEFAULT_CCR_TTL_SECS: i64 = 3600;
pub const DEFAULT_CCR_MAX_ENTRIES: usize = 2000;
pub const DEFAULT_RETRIEVE_MAX_CHARS: usize = 16_000;
const FTS_CHUNK_LINES: usize = 20;
const FTS_MAX_CHUNKS: usize = 500;
const FTS_MAX_RANKED_CHUNKS: usize = 12;

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
    #[serde(default)]
    pub truncated: bool,
    #[serde(default)]
    pub search_mode: String,
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
            let _ = conn.execute(
                "DELETE FROM ccr_chunks_fts WHERE hash IN (SELECT hash FROM ccr_entries WHERE expires_at <= ?1)",
                params![now],
            );
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

            let _ = index_ccr_chunks(conn, &hash, original);

            let count: i64 =
                conn.query_row("SELECT COUNT(*) FROM ccr_entries", [], |row| row.get(0))?;
            if count as usize > self.max_entries {
                let excess = count - (self.max_entries as i64);
                let _ = conn.execute(
                    "DELETE FROM ccr_chunks_fts WHERE hash IN (
                        SELECT hash FROM ccr_entries ORDER BY last_accessed_at ASC, created_at ASC LIMIT ?1
                    )",
                    params![excess],
                );
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

    /// Retrieve original content optionally sliced by 1-based line range or search query.
    pub fn retrieve_filtered(
        &self,
        hash: &str,
        lines: Option<(usize, usize)>,
        search: Option<&str>,
    ) -> Result<CcrRetrieveResult> {
        self.retrieve_filtered_with_options(hash, lines, search, false, 0)
    }

    /// Retrieve original content with BM25 FTS5 chunk search, `±context_lines` expansion,
    /// substring fallback, and default safe output ceiling unless `force_full` is enabled.
    pub fn retrieve_filtered_with_options(
        &self,
        hash: &str,
        lines: Option<(usize, usize)>,
        search: Option<&str>,
        force_full: bool,
        context_lines: usize,
    ) -> Result<CcrRetrieveResult> {
        let entry = self.retrieve(hash)?;
        let all_lines: Vec<&str> = entry.original_text.lines().collect();
        let total_lines = all_lines.len();

        let (content, returned_lines, truncated, search_mode) =
            if let Some(query) = search.filter(|q| !q.trim().is_empty()) {
                self.search_entry_lines(&entry.hash, &all_lines, query, force_full, context_lines)
            } else if let Some((start, end)) = lines {
                let s = start.max(1);
                let e = end.max(s).min(total_lines.max(1));
                if s > total_lines || all_lines.is_empty() {
                    (String::new(), 0, false, "lines".to_string())
                } else {
                    let slice = &all_lines[s - 1..e];
                    let joined = slice.join("\n");
                    if !force_full && joined.chars().count() > DEFAULT_RETRIEVE_MAX_CHARS {
                        let (clipped, kept_count) =
                            clip_lines_to_budget(slice, DEFAULT_RETRIEVE_MAX_CHARS - 200);
                        let out = format!(
                            "{clipped}\n... [truncated {kept_count}/{} lines at {} chars — narrow --lines or pass --force]",
                            slice.len(),
                            DEFAULT_RETRIEVE_MAX_CHARS
                        );
                        (out, kept_count, true, "lines".to_string())
                    } else {
                        (joined, slice.len(), false, "lines".to_string())
                    }
                }
            } else if !force_full && entry.original_text.chars().count() > DEFAULT_RETRIEVE_MAX_CHARS
            {
                let out = cap_unfiltered_output(&all_lines, &entry.hash, entry.original_tokens);
                let kept_lines = out.lines().count();
                (out, kept_lines, true, "capped".to_string())
            } else {
                (
                    entry.original_text.clone(),
                    total_lines,
                    false,
                    "full".to_string(),
                )
            };

        Ok(CcrRetrieveResult {
            hash: entry.hash,
            content,
            total_lines,
            returned_lines,
            original_tokens: entry.original_tokens,
            strategy: entry.strategy,
            tool_name: entry.tool_name,
            truncated,
            search_mode,
        })
    }

    fn search_entry_lines(
        &self,
        hash: &str,
        all_lines: &[&str],
        query: &str,
        force_full: bool,
        context_lines: usize,
    ) -> (String, usize, bool, String) {
        if all_lines.is_empty() {
            return (String::new(), 0, false, "substring".to_string());
        }

        let terms = tokenize_fts_terms(query);
        let ranked_chunks = query_fts_chunks(&self.store, hash, &terms);
        let lower_needle = query.trim().to_ascii_lowercase();
        let lower_terms: Vec<String> = terms.iter().map(|t| t.to_ascii_lowercase()).collect();

        let mut selected_indices: BTreeSet<usize> = BTreeSet::new();
        let mut mode = "substring";

        if !ranked_chunks.is_empty() {
            mode = "fts5_bm25";
            for (cs, ce) in ranked_chunks {
                let start_idx = cs.saturating_sub(1).min(all_lines.len().saturating_sub(1));
                let end_idx = ce.saturating_sub(1).min(all_lines.len().saturating_sub(1));
                let mut chunk_hits = Vec::new();
                for idx in start_idx..=end_idx {
                    let lower_line = all_lines[idx].to_ascii_lowercase();
                    if lower_line.contains(&lower_needle)
                        || lower_terms.iter().any(|t| lower_line.contains(t.as_str()))
                    {
                        chunk_hits.push(idx);
                    }
                }
                if chunk_hits.is_empty() {
                    // Porter stemmer matched the chunk without literal substring parity.
                    for idx in start_idx..=end_idx.min(start_idx + 9) {
                        selected_indices.insert(idx);
                    }
                } else {
                    for hit in chunk_hits {
                        let lo = hit.saturating_sub(context_lines);
                        let hi = (hit + context_lines).min(all_lines.len() - 1);
                        for idx in lo..=hi {
                            selected_indices.insert(idx);
                        }
                    }
                }
            }
        } else {
            for (idx, line) in all_lines.iter().enumerate() {
                if line.to_ascii_lowercase().contains(&lower_needle) {
                    let lo = idx.saturating_sub(context_lines);
                    let hi = (idx + context_lines).min(all_lines.len() - 1);
                    for c_idx in lo..=hi {
                        selected_indices.insert(c_idx);
                    }
                }
            }
        }

        if selected_indices.is_empty() {
            return (String::new(), 0, false, mode.to_string());
        }

        let max_chars = if force_full {
            usize::MAX
        } else {
            DEFAULT_RETRIEVE_MAX_CHARS.saturating_sub(180)
        };
        let mut rendered = Vec::new();
        let mut total_chars = 0usize;
        let mut returned_lines = 0usize;
        let mut truncated = false;
        let mut prev_idx: Option<usize> = None;

        for idx in &selected_indices {
            if context_lines > 0 {
                if let Some(prev) = prev_idx {
                    if *idx > prev + 1 {
                        rendered.push("--".to_string());
                        total_chars += 3;
                    }
                }
            }
            let row = format!("{}: {}", idx + 1, all_lines[*idx]);
            let row_chars = row.chars().count() + 1;
            if rendered.is_empty() && row_chars > max_chars {
                let clipped: String = row.chars().take(max_chars).collect();
                rendered.push(format!("{clipped}... [line clipped]"));
                returned_lines += 1;
                truncated = true;
                break;
            }
            if !rendered.is_empty() && total_chars + row_chars > max_chars {
                truncated = true;
                break;
            }
            total_chars += row_chars;
            rendered.push(row);
            returned_lines += 1;
            prev_idx = Some(*idx);
        }

        if truncated {
            let remaining = selected_indices.len().saturating_sub(returned_lines);
            rendered.push(format!(
                "... (+{remaining} matching lines truncated at {DEFAULT_RETRIEVE_MAX_CHARS} chars — refine --search or pass --force)"
            ));
        }

        (rendered.join("\n"), returned_lines, truncated, mode.to_string())
    }

    pub fn evict_expired(&self) -> Result<usize> {
        let now = now_unix_secs();
        self.store.with_conn(|conn| {
            let _ = conn.execute(
                "DELETE FROM ccr_chunks_fts WHERE hash IN (SELECT hash FROM ccr_entries WHERE expires_at <= ?1)",
                params![now],
            );
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

fn index_ccr_chunks(conn: &Connection, hash: &str, original: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM ccr_chunks_fts WHERE hash = ?1", params![hash])?;
    let all_lines: Vec<&str> = original.lines().collect();
    if all_lines.is_empty() {
        return Ok(());
    }
    let chunk_size = if all_lines.len() <= FTS_CHUNK_LINES * FTS_MAX_CHUNKS {
        FTS_CHUNK_LINES
    } else {
        all_lines.len().div_ceil(FTS_MAX_CHUNKS)
    };
    let mut stmt = conn.prepare(
        "INSERT INTO ccr_chunks_fts (hash, line_start, line_end, content) VALUES (?1, ?2, ?3, ?4)",
    )?;
    for (idx, chunk) in all_lines.chunks(chunk_size).enumerate() {
        let line_start = (idx * chunk_size + 1) as i64;
        let line_end = line_start + (chunk.len() as i64) - 1;
        let body = chunk.join("\n");
        stmt.execute(params![hash, line_start, line_end, body])?;
    }
    Ok(())
}

fn tokenize_fts_terms(query: &str) -> Vec<String> {
    query
        .split(|c: char| !c.is_alphanumeric() && c != '_')
        .map(str::trim)
        .filter(|s| s.len() >= 2)
        .map(str::to_string)
        .collect()
}

fn query_fts_chunks(store: &ContextStore, hash: &str, terms: &[String]) -> Vec<(usize, usize)> {
    if terms.is_empty() {
        return Vec::new();
    }
    let match_expr = terms
        .iter()
        .take(8)
        .map(|t| format!("\"{}\"", t.replace('"', "")))
        .collect::<Vec<_>>()
        .join(" OR ");

    store
        .with_conn(|conn| {
            let Ok(mut stmt) = conn.prepare(
                "SELECT line_start, line_end
                 FROM ccr_chunks_fts
                 WHERE hash = ?1 AND ccr_chunks_fts MATCH ?2
                 ORDER BY bm25(ccr_chunks_fts) ASC
                 LIMIT ?3",
            ) else {
                return Ok(Vec::new());
            };
            let Ok(mut rows) = stmt.query(params![hash, match_expr, FTS_MAX_RANKED_CHUNKS as i64])
            else {
                return Ok(Vec::new());
            };
            let mut chunks = Vec::new();
            while let Some(r) = rows.next()? {
                let s = r.get::<_, i64>(0)?.max(1) as usize;
                let e = r.get::<_, i64>(1)?.max(1) as usize;
                chunks.push((s, e));
            }
            Ok(chunks)
        })
        .unwrap_or_default()
}

fn clip_lines_to_budget(lines: &[&str], max_chars: usize) -> (String, usize) {
    let mut out = Vec::new();
    let mut used = 0usize;
    for line in lines {
        let len = line.chars().count() + 1;
        if !out.is_empty() && used + len > max_chars {
            break;
        }
        if out.is_empty() && len > max_chars {
            let clipped: String = line.chars().take(max_chars).collect();
            out.push(clipped);
            return (out.join("\n"), 1);
        }
        used += len;
        out.push((*line).to_string());
    }
    let count = out.len();
    (out.join("\n"), count)
}

fn cap_unfiltered_output(all_lines: &[&str], hash: &str, original_tokens: usize) -> String {
    let head_budget = 8_000usize;
    let tail_budget = 4_000usize;
    let (head, head_count) = clip_lines_to_budget(all_lines, head_budget);

    let mut tail_lines = Vec::new();
    let mut tail_chars = 0usize;
    let mut idx = all_lines.len();
    while idx > head_count {
        let line = all_lines[idx - 1];
        let next_len = line.chars().count() + 1;
        if !tail_lines.is_empty() && tail_chars + next_len > tail_budget {
            break;
        }
        tail_chars += next_len;
        tail_lines.push(line);
        idx -= 1;
    }
    tail_lines.reverse();
    let omitted_lines = all_lines
        .len()
        .saturating_sub(head_count + tail_lines.len());

    let mut out = head;
    out.push_str(&format!(
        "\n... [capped by kite-ctx retrieve: {omitted_lines} middle lines omitted from ~{original_tokens} raw tokens — pass `--search <term>`, `--lines N-M`, or `--force` for full dump (`kite ctx retrieve {hash} --search <term>`)] ...\n"
    ));
    if !tail_lines.is_empty() {
        out.push_str(&tail_lines.join("\n"));
    }
    out
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

    #[test]
    fn fts5_bm25_ranks_matching_chunks_expands_context_and_caps_unfiltered_retrievals() {
        let store = ContextStore::open_in_memory().unwrap();
        let ccr = CcrStore::new(store);

        let mut lines = Vec::new();
        for i in 1..=260 {
            if i == 120 {
                lines.push("error[E0308]: mismatched types in context_monitor snapshot handler".to_string());
            } else if i == 210 {
                lines.push("note: symbol::resolution::failed :: exact punctuation marker".to_string());
            } else {
                lines.push(format!(
                    "filler diagnostic log line {i:03} with unrelated module initialization output payload padding"
                ));
            }
        }
        let huge = lines.join("\n");
        let hash = ccr.put(&huge, "preview", "auto_ccr", "cargo check").unwrap();

        // 1. FTS5 BM25 search with +-2 context lines
        let fts_res = ccr
            .retrieve_filtered_with_options(&hash, None, Some("mismatched snapshot"), false, 2)
            .unwrap();
        assert_eq!(fts_res.search_mode, "fts5_bm25");
        assert!(fts_res.content.contains("120: error[E0308]"));
        assert!(fts_res.content.contains("118: filler diagnostic"));
        assert!(fts_res.content.contains("122: filler diagnostic"));

        // 2. Pure punctuation query falls back cleanly to substring search
        let sub_res = ccr
            .retrieve_filtered_with_options(&hash, None, Some("::"), false, 1)
            .unwrap();
        assert_eq!(sub_res.search_mode, "substring");
        assert!(sub_res.content.contains("210: note: symbol::resolution::failed"));

        // 3. Unfiltered giant retrieval is capped by default unless --force is passed
        let capped = ccr
            .retrieve_filtered_with_options(&hash, None, None, false, 0)
            .unwrap();
        assert!(capped.truncated);
        assert_eq!(capped.search_mode, "capped");
        assert!(capped.content.len() < huge.len());

        let forced = ccr
            .retrieve_filtered_with_options(&hash, None, None, true, 0)
            .unwrap();
        assert!(!forced.truncated);
        assert_eq!(forced.search_mode, "full");
        assert_eq!(forced.content, huge);

        // 4. Single oversized matching line still respects DEFAULT_RETRIEVE_MAX_CHARS when !force
        let giant_line = format!("single_needle_token {}", "x".repeat(25_000));
        let giant_hash = ccr.put(&giant_line, "p", "auto_ccr", "curl").unwrap();
        let clipped_match = ccr
            .retrieve_filtered_with_options(&giant_hash, None, Some("single_needle_token"), false, 0)
            .unwrap();
        assert!(clipped_match.truncated);
        assert!(clipped_match.content.chars().count() <= DEFAULT_RETRIEVE_MAX_CHARS);
        assert!(clipped_match.content.contains("single_needle_token"));
    }
}
