use std::collections::HashSet;
use std::path::{Path, PathBuf};

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::ccr_store::CcrStore;
use crate::error::{CtxError, Result};
use crate::store::{now_unix_secs, ContextStore};
use crate::tokens::{estimate_tokens, sha256_hex};

/// Read strategy controlling how much file detail is returned to an agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadMode {
    Auto,
    Full,
    Signatures,
    Map,
    Diff,
    Lines(usize, usize),
}

impl ReadMode {
    pub fn parse(spec: &str) -> Result<Self> {
        let s = spec.trim().to_ascii_lowercase();
        match s.as_str() {
            "" | "auto" => Ok(Self::Auto),
            "full" => Ok(Self::Full),
            "signatures" | "sigs" => Ok(Self::Signatures),
            "map" => Ok(Self::Map),
            "diff" => Ok(Self::Diff),
            _ => {
                if let Some(rest) = s.strip_prefix("lines:") {
                    let parts: Vec<&str> = rest.split('-').collect();
                    if parts.len() == 2 {
                        let start = parts[0].trim().parse::<usize>().map_err(|_| {
                            CtxError::InvalidInput(format!("invalid line start in '{spec}'"))
                        })?;
                        let end = parts[1].trim().parse::<usize>().map_err(|_| {
                            CtxError::InvalidInput(format!("invalid line end in '{spec}'"))
                        })?;
                        if start == 0 || end < start {
                            return Err(CtxError::InvalidInput(format!(
                                "line range must satisfy 1 <= start <= end in '{spec}'"
                            )));
                        }
                        return Ok(Self::Lines(start, end));
                    }
                }
                Err(CtxError::InvalidInput(format!(
                    "unsupported read mode '{spec}' (expected auto|full|signatures|map|diff|lines:N-M)"
                )))
            }
        }
    }

    pub fn label(&self) -> String {
        match self {
            Self::Auto => "auto".to_string(),
            Self::Full => "full".to_string(),
            Self::Signatures => "signatures".to_string(),
            Self::Map => "map".to_string(),
            Self::Diff => "diff".to_string(),
            Self::Lines(s, e) => format!("lines:{s}-{e}"),
        }
    }
}

/// Lifecycle state tracked for every file read inside a session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadStatus {
    Fresh,
    Stale,
    Superseded,
}

impl ReadStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Fresh => "fresh",
            Self::Stale => "stale",
            Self::Superseded => "superseded",
        }
    }
}

/// Result returned by [`ReadCache::read_file`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReadResult {
    pub path: String,
    pub sha256: String,
    pub mode: String,
    pub content: String,
    pub raw_tokens: usize,
    pub delivered_tokens: usize,
    pub tokens_saved: usize,
    pub deduplicated: bool,
    pub delta_diff: bool,
    pub ccr_hash: String,
    pub turn_index: usize,
}

struct PriorRead {
    id: i64,
    sha256: String,
    line_start: usize,
    line_end: usize,
    turn_index: usize,
    ccr_hash: String,
    content_snapshot: String,
}

/// Session-scoped read deduplicator, structural outline extractor, and diff delta engine.
#[derive(Clone)]
pub struct ReadCache {
    store: ContextStore,
    ccr: CcrStore,
}

impl ReadCache {
    pub fn new(store: ContextStore) -> Self {
        let ccr = CcrStore::new(store.clone());
        Self { store, ccr }
    }

    /// Read a file on disk using the requested [`ReadMode`] with session SHA-256 deduplication.
    pub fn read_file(
        &self,
        session_id: &str,
        path: impl AsRef<Path>,
        mode: ReadMode,
        fresh: bool,
    ) -> Result<ReadResult> {
        let raw_path = path.as_ref();
        let canonical = canonicalize_display(raw_path);
        let full_text = std::fs::read_to_string(raw_path)?;
        self.read_content(session_id, &canonical, &full_text, mode, fresh)
    }

    /// Core implementation operating directly on UTF-8 content (also used by tests).
    pub fn read_content(
        &self,
        session_id: &str,
        canonical_path: &str,
        full_text: &str,
        mode: ReadMode,
        fresh: bool,
    ) -> Result<ReadResult> {
        let file_sha = sha256_hex(full_text);
        let short_sha = &file_sha[..12];
        let total_lines = full_text.lines().count().max(1);
        let (req_start, req_end) = match mode {
            ReadMode::Lines(s, e) => (s.min(total_lines), e.min(total_lines)),
            _ => (1, total_lines),
        };

        let raw_slice = extract_slice(full_text, req_start, req_end);
        let raw_tokens = estimate_tokens(&raw_slice);

        let prior = self.latest_fresh_read(session_id, canonical_path)?;
        let next_turn = prior.as_ref().map_or(1, |p| p.turn_index + 1);

        // Cache full snapshot in CCR so any stub or delta can always recover the exact file.
        let ccr_hash = if !full_text.is_empty() {
            self.ccr
                .put(full_text, &format!("file:{canonical_path}"), "read_cache", "read")?
        } else {
            String::new()
        };

        // Case 1: Unchanged file already read in this session covering the requested range.
        if !fresh {
            if let Some(ref prev) = prior {
                if prev.sha256 == file_sha
                    && prev.line_start <= req_start
                    && req_end <= prev.line_end
                    && !matches!(mode, ReadMode::Signatures | ReadMode::Map)
                {
                    let stub = format!(
                        "[Unchanged since read #{} — sha256:{short_sha} lines:{req_start}-{req_end}. Pass --fresh or kite ctx retrieve {} for full text]",
                        prev.turn_index, prev.ccr_hash
                    );
                    let delivered_tokens = estimate_tokens(&stub);
                    return Ok(ReadResult {
                        path: canonical_path.to_string(),
                        sha256: file_sha,
                        mode: "stub".to_string(),
                        content: stub,
                        raw_tokens,
                        delivered_tokens,
                        tokens_saved: raw_tokens.saturating_sub(delivered_tokens),
                        deduplicated: true,
                        delta_diff: false,
                        ccr_hash: prev.ccr_hash.clone(),
                        turn_index: prev.turn_index,
                    });
                }
            }
        }

        // Case 2: File changed on disk since prior read -> emit delta diff when mode is Auto or Diff.
        if let Some(ref prev) = prior {
            if prev.sha256 != file_sha && matches!(mode, ReadMode::Auto | ReadMode::Diff) && !fresh
            {
                let diff_body = compute_line_diff(&prev.content_snapshot, full_text, canonical_path);
                let header = format!(
                    "[Modified since read #{} (sha256:{short_sha}, {total_lines} lines) — showing diff delta]",
                    prev.turn_index
                );
                let combined = format!("{header}\n{diff_body}");
                let (content, is_delta) = if estimate_tokens(&combined) < raw_tokens {
                    (combined, true)
                } else {
                    (raw_slice.clone(), false)
                };

                self.mark_prior_status(prev.id, ReadStatus::Stale)?;
                self.insert_read_record(
                    session_id,
                    canonical_path,
                    &file_sha,
                    if is_delta { "diff" } else { "full" },
                    1,
                    total_lines,
                    next_turn,
                    &ccr_hash,
                    full_text,
                    estimate_tokens(&content),
                )?;

                let delivered_tokens = estimate_tokens(&content);
                return Ok(ReadResult {
                    path: canonical_path.to_string(),
                    sha256: file_sha,
                    mode: if is_delta { "diff" } else { "full" }.to_string(),
                    content,
                    raw_tokens,
                    delivered_tokens,
                    tokens_saved: raw_tokens.saturating_sub(delivered_tokens),
                    deduplicated: false,
                    delta_diff: is_delta,
                    ccr_hash,
                    turn_index: next_turn,
                });
            }
        }

        // Case 3: Fresh delivery in requested structural/slice/full mode.
        let content = match mode {
            ReadMode::Auto | ReadMode::Full => raw_slice,
            ReadMode::Lines(_, _) => raw_slice,
            ReadMode::Signatures => extract_signatures(canonical_path, full_text),
            ReadMode::Map => extract_map(canonical_path, full_text),
            ReadMode::Diff => match prior {
                Some(ref prev) => compute_line_diff(&prev.content_snapshot, full_text, canonical_path),
                None => raw_slice,
            },
        };

        if let Some(ref prev) = prior {
            let status = if prev.sha256 == file_sha {
                ReadStatus::Superseded
            } else {
                ReadStatus::Stale
            };
            self.mark_prior_status(prev.id, status)?;
        }

        let delivered_tokens = estimate_tokens(&content);
        let (stored_start, stored_end) = match mode {
            ReadMode::Signatures | ReadMode::Map => (0, 0),
            _ => (req_start, req_end),
        };
        self.insert_read_record(
            session_id,
            canonical_path,
            &file_sha,
            &mode.label(),
            stored_start,
            stored_end,
            next_turn,
            &ccr_hash,
            full_text,
            delivered_tokens,
        )?;

        Ok(ReadResult {
            path: canonical_path.to_string(),
            sha256: file_sha,
            mode: mode.label(),
            content,
            raw_tokens,
            delivered_tokens,
            tokens_saved: raw_tokens.saturating_sub(delivered_tokens),
            deduplicated: false,
            delta_diff: false,
            ccr_hash,
            turn_index: next_turn,
        })
    }

    /// Count read records per lifecycle status (`fresh`, `stale`, `superseded`) for a session.
    pub fn lifecycle_counts(&self, session_id: &str) -> Result<(usize, usize, usize)> {
        self.store.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT status, COUNT(*) FROM read_records WHERE session_id = ?1 GROUP BY status",
            )?;
            let mut rows = stmt.query(params![session_id])?;
            let (mut fresh, mut stale, mut superseded) = (0usize, 0usize, 0usize);
            while let Some(row) = rows.next()? {
                let status: String = row.get(0)?;
                let cnt: i64 = row.get(1)?;
                match status.as_str() {
                    "fresh" => fresh = cnt as usize,
                    "stale" => stale = cnt as usize,
                    "superseded" => superseded = cnt as usize,
                    _ => {}
                }
            }
            Ok((fresh, stale, superseded))
        })
    }

    fn latest_fresh_read(
        &self,
        session_id: &str,
        canonical_path: &str,
    ) -> Result<Option<PriorRead>> {
        self.store.with_conn(|conn| {
            let row = conn
                .query_row(
                    "SELECT id, sha256, line_start, line_end, turn_index, COALESCE(ccr_hash, ''), content_snapshot
                     FROM read_records
                     WHERE session_id = ?1 AND canonical_path = ?2 AND status = 'fresh'
                     ORDER BY id DESC LIMIT 1",
                    params![session_id, canonical_path],
                    |r| {
                        Ok(PriorRead {
                            id: r.get(0)?,
                            sha256: r.get(1)?,
                            line_start: r.get::<_, i64>(2)? as usize,
                            line_end: r.get::<_, i64>(3)? as usize,
                            turn_index: r.get::<_, i64>(4)? as usize,
                            ccr_hash: r.get(5)?,
                            content_snapshot: r.get(6)?,
                        })
                    },
                )
                .optional()?;
            Ok(row)
        })
    }

    fn mark_prior_status(&self, id: i64, status: ReadStatus) -> Result<()> {
        self.store.with_conn(|conn| {
            conn.execute(
                "UPDATE read_records SET status = ?1 WHERE id = ?2",
                params![status.as_str(), id],
            )?;
            Ok(())
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn insert_read_record(
        &self,
        session_id: &str,
        canonical_path: &str,
        sha256: &str,
        mode: &str,
        line_start: usize,
        line_end: usize,
        turn_index: usize,
        ccr_hash: &str,
        content_snapshot: &str,
        tokens: usize,
    ) -> Result<()> {
        let now = now_unix_secs();
        self.store.with_conn(|conn| {
            conn.execute(
                "INSERT INTO read_records (
                    session_id, canonical_path, sha256, mode, line_start, line_end,
                    turn_index, status, ccr_hash, content_snapshot, tokens, created_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'fresh', ?8, ?9, ?10, ?11)",
                params![
                    session_id,
                    canonical_path,
                    sha256,
                    mode,
                    line_start as i64,
                    line_end as i64,
                    turn_index as i64,
                    ccr_hash,
                    content_snapshot,
                    tokens as i64,
                    now
                ],
            )?;
            Ok(())
        })
    }
}

fn canonicalize_display(path: &Path) -> String {
    let resolved = std::fs::canonicalize(path).unwrap_or_else(|_| {
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            std::env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join(path)
        }
    });
    let s = resolved.to_string_lossy().replace('\\', "/");
    s.strip_prefix("//?/").unwrap_or(&s).to_string()
}

fn extract_slice(text: &str, start: usize, end: usize) -> String {
    if text.is_empty() {
        return String::new();
    }
    let lines: Vec<&str> = text.lines().collect();
    if lines.is_empty() {
        return String::new();
    }
    let s = start.max(1).min(lines.len());
    let e = end.max(s).min(lines.len());
    lines[s - 1..e].join("\n")
}

/// Extract structural API signatures (imports, types, functions, exports, markdown headings)
/// in pure Rust without heavy parser runtimes.
pub fn extract_signatures(path: &str, content: &str) -> String {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    let mut out = Vec::new();
    for (idx, line) in content.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("//") || trimmed.starts_with('#') && ext != "md" {
            continue;
        }
        let keep = match ext.as_str() {
            "rs" => {
                trimmed.starts_with("pub ")
                    || trimmed.starts_with("fn ")
                    || trimmed.starts_with("async fn ")
                    || trimmed.starts_with("struct ")
                    || trimmed.starts_with("enum ")
                    || trimmed.starts_with("trait ")
                    || trimmed.starts_with("impl ")
                    || trimmed.starts_with("mod ")
            }
            "ts" | "tsx" | "js" | "jsx" | "mjs" | "mts" => {
                trimmed.starts_with("export ")
                    || trimmed.starts_with("function ")
                    || trimmed.starts_with("async function ")
                    || trimmed.starts_with("interface ")
                    || trimmed.starts_with("type ")
                    || trimmed.starts_with("class ")
            }
            "py" => {
                trimmed.starts_with("def ")
                    || trimmed.starts_with("async def ")
                    || trimmed.starts_with("class ")
            }
            "go" => {
                trimmed.starts_with("func ")
                    || trimmed.starts_with("type ")
                    || trimmed.starts_with("package ")
            }
            "md" => trimmed.starts_with('#'),
            _ => {
                trimmed.starts_with("fn ")
                    || trimmed.starts_with("def ")
                    || trimmed.starts_with("class ")
                    || trimmed.starts_with("function ")
                    || trimmed.starts_with("export ")
                    || trimmed.starts_with('#')
            }
        };
        if keep {
            out.push(format!("{}: {}", idx + 1, line.trim_end()));
        }
    }
    if out.is_empty() {
        extract_slice(content, 1, 30)
    } else {
        out.join("\n")
    }
}

/// Extract high-level module map (imports + declarations + line count).
pub fn extract_map(path: &str, content: &str) -> String {
    let total = content.lines().count();
    let mut imports = Vec::new();
    let mut symbols = Vec::new();

    for (idx, line) in content.lines().enumerate() {
        let t = line.trim();
        if t.starts_with("use ")
            || t.starts_with("import ")
            || t.starts_with("from ")
            || t.starts_with("#include ")
        {
            imports.push(format!("{}: {t}", idx + 1));
        }
    }

    let sigs = extract_signatures(path, content);
    if !sigs.is_empty() {
        symbols.push(sigs);
    }

    let mut out = vec![format!("file: {path} ({total} lines)")];
    if !imports.is_empty() {
        out.push(format!("imports ({}):", imports.len()));
        out.extend(imports.into_iter().take(20));
    }
    if !symbols.is_empty() {
        out.push("symbols:".to_string());
        out.extend(symbols);
    }
    out.join("\n")
}

/// Pure-Rust line-level LCS diff yielding unified-style `@@` hunks.
pub fn compute_line_diff(old: &str, new: &str, path: &str) -> String {
    let a: Vec<&str> = old.lines().collect();
    let b: Vec<&str> = new.lines().collect();
    if a == b {
        return String::new();
    }

    // Fallback cleanly for gigantic files to stay linear-bound in memory.
    if a.len() * b.len() > 2_000_000 {
        let a_set: HashSet<&str> = a.iter().copied().collect();
        let mut out = vec![format!("--- {path}"), format!("+++ {path}")];
        for (idx, line) in b.iter().enumerate() {
            if !a_set.contains(line) {
                out.push(format!("+L{}: {line}", idx + 1));
            }
        }
        return out.join("\n");
    }

    let m = a.len();
    let n = b.len();
    let mut dp = vec![vec![0usize; n + 1]; m + 1];
    for i in (0..m).rev() {
        for j in (0..n).rev() {
            dp[i][j] = if a[i] == b[j] {
                dp[i + 1][j + 1] + 1
            } else {
                dp[i + 1][j].max(dp[i][j + 1])
            };
        }
    }

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Op<'a> {
        Keep(usize, usize, &'a str),
        Del(usize, &'a str),
        Add(usize, &'a str),
    }

    let mut ops = Vec::new();
    let (mut i, mut j) = (0usize, 0usize);
    while i < m && j < n {
        if a[i] == b[j] {
            ops.push(Op::Keep(i + 1, j + 1, a[i]));
            i += 1;
            j += 1;
        } else if dp[i + 1][j] >= dp[i][j + 1] {
            ops.push(Op::Del(i + 1, a[i]));
            i += 1;
        } else {
            ops.push(Op::Add(j + 1, b[j]));
            j += 1;
        }
    }
    while i < m {
        ops.push(Op::Del(i + 1, a[i]));
        i += 1;
    }
    while j < n {
        ops.push(Op::Add(j + 1, b[j]));
        j += 1;
    }

    let mut out = vec![format!("--- {path}"), format!("+++ {path}")];
    let context = 2usize;
    let changed_indices: Vec<usize> = ops
        .iter()
        .enumerate()
        .filter(|(_, op)| !matches!(op, Op::Keep(_, _, _)))
        .map(|(idx, _)| idx)
        .collect();

    if changed_indices.is_empty() {
        return String::new();
    }

    let mut idx = 0usize;
    while idx < changed_indices.len() {
        let start = changed_indices[idx].saturating_sub(context);
        let mut end = (changed_indices[idx] + context + 1).min(ops.len());
        while idx + 1 < changed_indices.len()
            && changed_indices[idx + 1].saturating_sub(context) <= end
        {
            idx += 1;
            end = (changed_indices[idx] + context + 1).min(ops.len());
        }

        let old_start = ops[start..end]
            .iter()
            .find_map(|op| match op {
                Op::Keep(o, _, _) | Op::Del(o, _) => Some(*o),
                Op::Add(_, _) => None,
            })
            .unwrap_or(1);
        let new_start = ops[start..end]
            .iter()
            .find_map(|op| match op {
                Op::Keep(_, n, _) | Op::Add(n, _) => Some(*n),
                Op::Del(_, _) => None,
            })
            .unwrap_or(1);
        out.push(format!("@@ -{old_start} +{new_start} @@"));

        for op in &ops[start..end] {
            match op {
                Op::Keep(_, _, line) => out.push(format!(" {line}")),
                Op::Del(_, line) => out.push(format!("-{line}")),
                Op::Add(_, line) => out.push(format!("+{line}")),
            }
        }
        idx += 1;
    }

    out.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deduplicates_unchanged_rereads_and_emits_diff_on_edit() {
        let store = ContextStore::open_in_memory().unwrap();
        let cache = ReadCache::new(store);
        let v1 = (1..=30)
            .map(|i| format!("pub fn item_{i}() -> usize {{ {i} }}"))
            .collect::<Vec<_>>()
            .join("\n");

        // 1. Initial read delivers full content
        let r1 = cache
            .read_content("sess-1", "src/example.rs", &v1, ReadMode::Full, false)
            .unwrap();
        assert!(!r1.deduplicated);
        assert_eq!(r1.mode, "full");
        assert!(r1.content.contains("item_15"));

        // 2. Unchanged re-read inside same session emits tiny stub
        let r2 = cache
            .read_content(
                "sess-1",
                "src/example.rs",
                &v1,
                ReadMode::Lines(5, 15),
                false,
            )
            .unwrap();
        assert!(r2.deduplicated);
        assert_eq!(r2.mode, "stub");
        assert!(r2.content.contains("Unchanged since read #1"));
        assert!(r2.delivered_tokens < 40);

        // 3. Modified file on disk emits delta diff and marks old read stale
        let v2 = v1.replace("item_15() -> usize { 15 }", "item_15() -> usize { 999 }");
        let r3 = cache
            .read_content("sess-1", "src/example.rs", &v2, ReadMode::Auto, false)
            .unwrap();
        assert!(r3.delta_diff);
        assert_eq!(r3.mode, "diff");
        assert!(r3.content.contains("-pub fn item_15() -> usize { 15 }"));
        assert!(r3.content.contains("+pub fn item_15() -> usize { 999 }"));

        let (fresh, stale, _) = cache.lifecycle_counts("sess-1").unwrap();
        assert_eq!(fresh, 1);
        assert_eq!(stale, 1);
    }

    #[test]
    fn extracts_signatures_and_map_modes() {
        let store = ContextStore::open_in_memory().unwrap();
        let cache = ReadCache::new(store);
        let src = "use std::fs;\n\npub struct Config {\n    pub port: u16,\n}\n\npub fn run() {\n    let x = 1;\n    println!(\"{x}\");\n}\n";

        let sigs = cache
            .read_content("sess-2", "src/lib.rs", src, ReadMode::Signatures, false)
            .unwrap();
        assert!(sigs.content.contains("3: pub struct Config {"));
        assert!(sigs.content.contains("7: pub fn run() {"));
        assert!(!sigs.content.contains("let x = 1"));

        let map = cache
            .read_content("sess-2", "src/lib.rs", src, ReadMode::Map, false)
            .unwrap();
        assert!(map.content.contains("imports (1):"));
        assert!(map.content.contains("1: use std::fs;"));
        assert!(map.content.contains("symbols:"));
    }
}
