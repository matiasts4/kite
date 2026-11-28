//! Workspace-contained search tools (`grep_search`, `find_files`).

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use kite_ctx::lossless::compact_lossless;
use kite_ctx::{ContentKind, MAX_EXEC_OUTPUT_CHARS};
use serde_json::{json, Value};

use crate::native_agent::types::NativeToolDef;

use super::{
    canonical_workspace_root, display_relative_path, optional_bool, optional_str, optional_usize,
    required_str, resolve_workspace_path, should_skip_dir_name, truncate_output, ToolOutput,
};

const DEFAULT_GREP_MAX_RESULTS: usize = 100;
const HARD_GREP_MAX_RESULTS: usize = 500;
const DEFAULT_FIND_MAX_RESULTS: usize = 200;
const HARD_FIND_MAX_RESULTS: usize = 1_000;
const MAX_SCAN_ENTRIES: usize = 25_000;
const MAX_GREP_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_LINE_PREVIEW_CHARS: usize = 400;
const LARGE_SEARCH_COMPRESS_THRESHOLD: usize = 8_000;

pub fn grep_search_def() -> NativeToolDef {
    NativeToolDef {
        name: "grep_search".to_string(),
        description: "Search UTF-8 workspace files for a text pattern, skipping .git, node_modules, and target directories.".to_string(),
        parameters: json!({
            "type": "object",
            "properties": {
                "pattern": {
                    "type": "string",
                    "description": "Text pattern to search for."
                },
                "path": {
                    "type": "string",
                    "description": "Optional workspace-relative file or subdirectory to search (defaults to '.')."
                },
                "case_insensitive": {
                    "type": "boolean",
                    "description": "Perform case-insensitive matching (default false)."
                },
                "max_results": {
                    "type": "integer",
                    "description": "Maximum number of matching lines to return (default 100, max 500)."
                }
            },
            "required": ["pattern"]
        }),
    }
}

pub fn find_files_def() -> NativeToolDef {
    NativeToolDef {
        name: "find_files".to_string(),
        description: "List workspace files matching an optional glob or filename pattern, skipping .git, node_modules, and target directories.".to_string(),
        parameters: json!({
            "type": "object",
            "properties": {
                "pattern": {
                    "type": "string",
                    "description": "Optional glob (e.g. '*.rs', 'src/**/*.ts') or filename substring."
                },
                "path": {
                    "type": "string",
                    "description": "Optional workspace-relative subdirectory to search (defaults to '.')."
                },
                "max_results": {
                    "type": "integer",
                    "description": "Maximum number of file paths to return (default 200, max 1000)."
                }
            }
        }),
    }
}

struct CollectedFiles {
    files: Vec<PathBuf>,
    scan_capped: bool,
}

fn collect_workspace_files(
    canonical_root: &Path,
    search_root: &Path,
) -> Result<CollectedFiles, String> {
    if !search_root.exists() {
        return Err(format!(
            "Search path '{}' does not exist.",
            display_relative_path(canonical_root, search_root)
        ));
    }

    let canon_start = fs::canonicalize(search_root)
        .map_err(|e| format!("Failed to resolve search path: {e}"))?;
    if !canon_start.starts_with(canonical_root) {
        return Err("Search path resolves outside workspace root.".to_string());
    }

    if canon_start.is_file() {
        return Ok(CollectedFiles {
            files: vec![canon_start],
            scan_capped: false,
        });
    }

    let mut files = Vec::new();
    let mut visited_dirs = HashSet::new();
    visited_dirs.insert(canon_start.clone());
    let mut stack = vec![canon_start];
    let mut scanned = 0usize;
    let mut scan_capped = false;

    while let Some(dir) = stack.pop() {
        let Ok(read_dir) = fs::read_dir(&dir) else {
            continue;
        };
        let mut entries: Vec<_> = read_dir.filter_map(Result::ok).collect();
        entries.sort_by(|a, b| {
            let a_name = a.file_name().to_string_lossy().to_ascii_lowercase();
            let b_name = b.file_name().to_string_lossy().to_ascii_lowercase();
            a_name.cmp(&b_name).then_with(|| a.file_name().cmp(&b.file_name()))
        });

        let mut subdirs = Vec::new();
        for entry in entries {
            scanned += 1;
            if scanned > MAX_SCAN_ENTRIES {
                scan_capped = true;
                break;
            }

            let name_os = entry.file_name();
            let name = name_os.to_string_lossy();
            let Ok(ft) = entry.file_type() else {
                continue;
            };
            let entry_path = entry.path();

            if ft.is_dir() && should_skip_dir_name(&name) {
                continue;
            }

            if ft.is_symlink() {
                let Ok(canon) = fs::canonicalize(&entry_path) else {
                    continue;
                };
                if !canon.starts_with(canonical_root) {
                    continue;
                }
                if canon.is_dir() {
                    if should_skip_dir_name(&name) {
                        continue;
                    }
                    if visited_dirs.insert(canon.clone()) {
                        subdirs.push(canon);
                    }
                } else if canon.is_file() {
                    files.push(canon);
                }
            } else if ft.is_dir() {
                if let Ok(canon) = fs::canonicalize(&entry_path) {
                    if canon.starts_with(canonical_root) && visited_dirs.insert(canon.clone()) {
                        subdirs.push(canon);
                    }
                }
            } else if ft.is_file() {
                files.push(entry_path);
            }
        }

        if scan_capped {
            break;
        }
        // Push in reverse sorted order so LIFO pops directories in alphabetical order.
        for sub in subdirs.into_iter().rev() {
            stack.push(sub);
        }
    }

    Ok(CollectedFiles { files, scan_capped })
}

fn preview_line(line: &str, max_chars: usize) -> String {
    let trimmed = line.trim_end_matches('\r');
    let count = trimmed.chars().count();
    if count <= max_chars {
        return trimmed.to_string();
    }
    let prefix: String = trimmed.chars().take(max_chars).collect();
    format!("{prefix}...")
}

pub fn execute_grep_search(workspace_root: &Path, args: &Value) -> ToolOutput {
    let pattern = match required_str(args, "pattern") {
        Ok(p) => p,
        Err(e) => return ToolOutput::error(e),
    };
    if pattern.is_empty() {
        return ToolOutput::error("grep_search 'pattern' must not be empty.");
    }
    let raw_path = match optional_str(args, "path") {
        Ok(p) => p.unwrap_or("."),
        Err(e) => return ToolOutput::error(e),
    };
    let case_insensitive = match optional_bool(args, "case_insensitive", false) {
        Ok(b) => b,
        Err(e) => return ToolOutput::error(e),
    };
    let max_results = match optional_usize(args, "max_results") {
        Ok(v) => v
            .unwrap_or(DEFAULT_GREP_MAX_RESULTS)
            .clamp(1, HARD_GREP_MAX_RESULTS),
        Err(e) => return ToolOutput::error(e),
    };

    let canonical_root = match canonical_workspace_root(workspace_root) {
        Ok(r) => r,
        Err(e) => return ToolOutput::error(e),
    };
    let search_root = match resolve_workspace_path(workspace_root, raw_path) {
        Ok(p) => p,
        Err(e) => return ToolOutput::error(e),
    };

    let collected = match collect_workspace_files(&canonical_root, &search_root) {
        Ok(c) => c,
        Err(e) => return ToolOutput::error(e),
    };

    let needle_lower = if case_insensitive {
        pattern.to_lowercase()
    } else {
        String::new()
    };

    let mut matches = Vec::new();
    let mut hit_limit = collected.scan_capped;

    'outer: for file_path in &collected.files {
        let Ok(meta) = fs::metadata(file_path) else {
            continue;
        };
        if meta.len() > MAX_GREP_FILE_BYTES {
            continue;
        }
        let Ok(bytes) = fs::read(file_path) else {
            continue;
        };
        if bytes.iter().take(8192).any(|&b| b == 0) {
            continue;
        }
        let Ok(text) = std::str::from_utf8(&bytes) else {
            continue;
        };
        let rel = display_relative_path(&canonical_root, file_path);

        for (idx, line) in text.lines().enumerate() {
            let is_match = if case_insensitive {
                line.to_lowercase().contains(&needle_lower)
            } else {
                line.contains(pattern)
            };
            if is_match {
                if matches.len() >= max_results {
                    hit_limit = true;
                    break 'outer;
                }
                matches.push(format!(
                    "{rel}:{}:{}",
                    idx + 1,
                    preview_line(line, MAX_LINE_PREVIEW_CHARS)
                ));
            }
        }
    }

    if matches.is_empty() {
        return ToolOutput::success("No matches found.", collected.scan_capped);
    }

    let joined = matches.join("\n");
    let body = if joined.len() > LARGE_SEARCH_COMPRESS_THRESHOLD {
        compact_lossless(&joined, ContentKind::Grep)
    } else {
        joined
    };
    let (bounded, char_truncated) = truncate_output(
        &body,
        MAX_EXEC_OUTPUT_CHARS,
        "\n... [grep_search output truncated; narrow path or pattern]",
    );
    ToolOutput::success(bounded, hit_limit || char_truncated)
}

fn single_segment_glob(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    let (m, n) = (p.len(), t.len());
    let mut dp = vec![vec![false; n + 1]; m + 1];
    dp[0][0] = true;
    for i in 1..=m {
        if p[i - 1] == '*' {
            dp[i][0] = dp[i - 1][0];
        }
    }
    for i in 1..=m {
        for j in 1..=n {
            dp[i][j] = match p[i - 1] {
                '*' => dp[i - 1][j] || dp[i][j - 1],
                '?' => dp[i - 1][j - 1],
                ch => dp[i - 1][j - 1] && ch == t[j - 1],
            };
        }
    }
    dp[m][n]
}

fn segment_glob(pat_segs: &[&str], path_segs: &[&str]) -> bool {
    let (m, n) = (pat_segs.len(), path_segs.len());
    let mut dp = vec![vec![false; n + 1]; m + 1];
    dp[0][0] = true;
    for i in 1..=m {
        if pat_segs[i - 1] == "**" {
            dp[i][0] = dp[i - 1][0];
        }
    }
    for i in 1..=m {
        for j in 1..=n {
            dp[i][j] = if pat_segs[i - 1] == "**" {
                dp[i - 1][j] || dp[i][j - 1]
            } else {
                dp[i - 1][j - 1] && single_segment_glob(pat_segs[i - 1], path_segs[j - 1])
            };
        }
    }
    dp[m][n]
}

fn matches_file_pattern(pattern: Option<&str>, rel_root: &str, rel_search: &str) -> bool {
    let Some(raw) = pattern.map(str::trim).filter(|s| !s.is_empty() && *s != "*") else {
        return true;
    };
    let normalized = raw.replace('\\', "/");
    let normalized = normalized.strip_prefix("./").unwrap_or(&normalized);

    if normalized.contains('/') {
        let pat_segs: Vec<&str> = normalized.split('/').filter(|s| !s.is_empty()).collect();
        if normalized.contains('*') || normalized.contains('?') {
            let root_segs: Vec<&str> = rel_root.split('/').filter(|s| !s.is_empty()).collect();
            let search_segs: Vec<&str> = rel_search.split('/').filter(|s| !s.is_empty()).collect();
            segment_glob(&pat_segs, &root_segs) || segment_glob(&pat_segs, &search_segs)
        } else {
            let pat_lower = normalized.to_lowercase();
            rel_root.to_lowercase().contains(&pat_lower)
                || rel_search.to_lowercase().contains(&pat_lower)
        }
    } else {
        let file_name = rel_root.rsplit('/').next().unwrap_or(rel_root);
        if normalized.contains('*') || normalized.contains('?') {
            single_segment_glob(normalized, file_name)
        } else {
            file_name.to_lowercase().contains(&normalized.to_lowercase())
        }
    }
}

pub fn execute_find_files(workspace_root: &Path, args: &Value) -> ToolOutput {
    let pattern = match optional_str(args, "pattern") {
        Ok(p) => p,
        Err(e) => return ToolOutput::error(e),
    };
    let raw_path = match optional_str(args, "path") {
        Ok(p) => p.unwrap_or("."),
        Err(e) => return ToolOutput::error(e),
    };
    let max_results = match optional_usize(args, "max_results") {
        Ok(v) => v
            .unwrap_or(DEFAULT_FIND_MAX_RESULTS)
            .clamp(1, HARD_FIND_MAX_RESULTS),
        Err(e) => return ToolOutput::error(e),
    };

    let canonical_root = match canonical_workspace_root(workspace_root) {
        Ok(r) => r,
        Err(e) => return ToolOutput::error(e),
    };
    let search_root = match resolve_workspace_path(workspace_root, raw_path) {
        Ok(p) => p,
        Err(e) => return ToolOutput::error(e),
    };
    let canon_search = match fs::canonicalize(&search_root) {
        Ok(p) => p,
        Err(e) => return ToolOutput::error(format!("Failed to resolve search directory: {e}")),
    };

    let collected = match collect_workspace_files(&canonical_root, &canon_search) {
        Ok(c) => c,
        Err(e) => return ToolOutput::error(e),
    };

    let mut matched = Vec::new();
    let mut hit_limit = collected.scan_capped;
    for file_path in &collected.files {
        let rel_root = display_relative_path(&canonical_root, file_path);
        let rel_search = display_relative_path(&canon_search, file_path);
        if matches_file_pattern(pattern, &rel_root, &rel_search) {
            if matched.len() >= max_results {
                hit_limit = true;
                break;
            }
            matched.push(rel_root);
        }
    }

    if matched.is_empty() {
        return ToolOutput::success("No files found.", collected.scan_capped);
    }

    let joined = matched.join("\n");
    let body = if joined.len() > LARGE_SEARCH_COMPRESS_THRESHOLD {
        compact_lossless(&joined, ContentKind::Paths)
    } else {
        joined
    };
    let (bounded, char_truncated) = truncate_output(
        &body,
        MAX_EXEC_OUTPUT_CHARS,
        "\n... [find_files output truncated; narrow path or pattern]",
    );
    ToolOutput::success(bounded, hit_limit || char_truncated)
}
