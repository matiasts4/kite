use std::collections::HashMap;
use std::sync::OnceLock;

use regex::Regex;

use crate::pipeline::{CompressionStrategy, ContentKind};

const FOLD_MIN_BLOCK: usize = 3;
const FOLD_MAX_BLOCK: usize = 64;
const FOLD_MAX_CANDIDATES: usize = 8;
const FOLD_MAX_LINES: usize = 20_000;

fn ansi_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]").unwrap())
}

fn run_marker_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\.\.\. \(repeated (\d+) times\)$").unwrap())
}

fn block_marker_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\.\.\. \(repeats (\d+) lines from (\d+) lines back\)$").unwrap())
}

fn timestamp_row_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"^\s*\[?(?:\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}|\d{2}/\d{2}/\d{2,4}[ T]\d{1,2}:\d{2}|[A-Z][a-z]{2}\s+\d{1,2}\s+\d{1,2}:\d{2}|\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?(?:\s|\]|$))",
        )
        .unwrap()
    })
}

fn grep_row_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^(?P<path>[^\n:]+|[A-Za-z]:[^\n:]+):(?P<line>\d+):(?P<content>.*)$").unwrap())
}

fn heading_row_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^(?P<line>\d+):(?P<content>.*)$").unwrap())
}

fn dir_data_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^(?P<base>[^/\n:]+):(?P<line>\d+):(?P<content>.*)$").unwrap())
}

fn diff_index_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^index [0-9a-fA-F]+\.\.[0-9a-fA-F]+(?: [0-7]+)?$").unwrap())
}

fn path_row_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^(?P<dir>(?:\.{0,2}/)?(?:[^/\s:]+/)+)(?P<base>[^/\s:]+)$").unwrap())
}

fn split_keep_trailing(text: &str) -> (Vec<&str>, bool) {
    if text.is_empty() {
        return (Vec::new(), false);
    }
    let had_trailing = text.ends_with('\n');
    let body = if had_trailing {
        &text[..text.len() - 1]
    } else {
        text
    };
    (body.split('\n').collect(), had_trailing)
}

fn join_keep_trailing(lines: &[String], had_trailing: bool) -> String {
    let mut out = lines.join("\n");
    if had_trailing {
        out.push('\n');
    }
    out
}

/// Remove non-semantic ANSI CSI/SGR escape sequences.
pub fn strip_ansi(text: &str) -> String {
    ansi_re().replace_all(text, "").into_owned()
}

/// Collapse runs of >=2 identical consecutive lines into `<line>\n... (repeated N times)`.
pub fn collapse_runs(text: &str) -> String {
    let (lines, had_trailing) = split_keep_trailing(text);
    if lines.is_empty() {
        return text.to_string();
    }
    let mut out = Vec::with_capacity(lines.len());
    let mut i = 0;
    while i < lines.len() {
        let mut j = i;
        while j + 1 < lines.len() && lines[j + 1] == lines[i] {
            j += 1;
        }
        let run_len = j - i + 1;
        out.push(lines[i].to_string());
        if run_len >= 2 {
            out.push(format!("... (repeated {run_len} times)"));
        }
        i = j + 1;
    }
    join_keep_trailing(&out, had_trailing)
}

/// Exact inverse of [`collapse_runs`].
pub fn expand_runs(text: &str) -> String {
    let (lines, had_trailing) = split_keep_trailing(text);
    if lines.is_empty() {
        return text.to_string();
    }
    let mut out = Vec::with_capacity(lines.len());
    let mut i = 0;
    while i < lines.len() {
        if i + 1 < lines.len() {
            if let Some(caps) = run_marker_re().captures(lines[i + 1]) {
                if let Ok(count) = caps[1].parse::<usize>() {
                    for _ in 0..count {
                        out.push(lines[i].to_string());
                    }
                    i += 2;
                    continue;
                }
            }
        }
        out.push(lines[i].to_string());
        i += 1;
    }
    join_keep_trailing(&out, had_trailing)
}

/// Collapse repeated multi-line blocks (`>= 3` lines) into LZ-style back-references.
pub fn fold_repeated_blocks(text: &str) -> String {
    let (lines, had_trailing) = split_keep_trailing(text);
    let n = lines.len();
    if n < FOLD_MIN_BLOCK * 2 || n > FOLD_MAX_LINES {
        return text.to_string();
    }

    let mut positions: HashMap<&str, Vec<usize>> = HashMap::new();
    let mut out: Vec<String> = Vec::with_capacity(n);
    let mut i = 0;

    while i < n {
        let mut best_len = 0usize;
        let mut best_dist = 0usize;

        if let Some(cands) = positions.get(lines[i]) {
            for &q in cands.iter().rev() {
                let max_len = FOLD_MAX_BLOCK.min(n - i).min(i - q);
                let mut length = 0usize;
                while length < max_len && lines[q + length] == lines[i + length] {
                    length += 1;
                }
                if length > best_len {
                    best_len = length;
                    best_dist = i - q;
                }
            }
        }

        if best_len >= FOLD_MIN_BLOCK {
            let marker = format!("... (repeats {best_len} lines from {best_dist} lines back)");
            let block_chars: usize = (0..best_len).map(|k| lines[i + k].len() + 1).sum();
            if block_chars > marker.len() + 1 {
                out.push(marker);
                for k in 0..best_len {
                    remember_pos(&mut positions, lines[i + k], i + k);
                }
                i += best_len;
                continue;
            }
        }

        remember_pos(&mut positions, lines[i], i);
        out.push(lines[i].to_string());
        i += 1;
    }

    join_keep_trailing(&out, had_trailing)
}

fn remember_pos<'a>(positions: &mut HashMap<&'a str, Vec<usize>>, line: &'a str, idx: usize) {
    let bucket = positions.entry(line).or_default();
    bucket.push(idx);
    if bucket.len() > FOLD_MAX_CANDIDATES {
        bucket.remove(0);
    }
}

/// Exact inverse of [`fold_repeated_blocks`].
pub fn unfold_repeated_blocks(text: &str) -> String {
    let (lines, had_trailing) = split_keep_trailing(text);
    if lines.is_empty() {
        return text.to_string();
    }
    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    for line in lines {
        if let Some(caps) = block_marker_re().captures(line) {
            if let (Ok(len), Ok(dist)) = (caps[1].parse::<usize>(), caps[2].parse::<usize>()) {
                if dist <= out.len() && len <= dist {
                    let start = out.len() - dist;
                    let slice: Vec<String> = out[start..start + len].to_vec();
                    out.extend(slice);
                    continue;
                }
            }
        }
        out.push(line.to_string());
    }
    join_keep_trailing(&out, had_trailing)
}

/// Group `path:line:content` search output under shared file headings.
pub fn search_heading(text: &str) -> String {
    let (lines, had_trailing) = split_keep_trailing(text);
    if lines.is_empty() {
        return text.to_string();
    }
    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    let mut current_path: Option<String> = None;

    for line in lines {
        let matched = if timestamp_row_re().is_match(line) {
            None
        } else {
            grep_row_re().captures(line)
        };

        if let Some(caps) = matched {
            let path = &caps["path"];
            if current_path.as_deref() != Some(path) {
                out.push(path.to_string());
                current_path = Some(path.to_string());
            }
            out.push(format!("{}:{}", &caps["line"], &caps["content"]));
        } else {
            out.push(line.to_string());
            current_path = None;
        }
    }

    join_keep_trailing(&out, had_trailing)
}

/// Exact inverse of [`search_heading`].
pub fn search_unheading(text: &str) -> String {
    let (lines, had_trailing) = split_keep_trailing(text);
    if lines.is_empty() {
        return text.to_string();
    }
    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    let mut current_path: Option<&str> = None;
    let mut i = 0;

    while i < lines.len() {
        let line = lines[i];
        let data = heading_row_re().captures(line);
        if let (Some(path), Some(caps)) = (current_path, data.as_ref()) {
            out.push(format!("{path}:{}:{}", &caps["line"], &caps["content"]));
            i += 1;
            continue;
        }
        if data.is_none() && i + 1 < lines.len() && heading_row_re().is_match(lines[i + 1]) {
            current_path = Some(line);
            i += 1;
            continue;
        }
        current_path = None;
        out.push(line.to_string());
        i += 1;
    }

    join_keep_trailing(&out, had_trailing)
}

/// Group `dir/file:line:content` search rows by shared parent directory header (`dir/`).
pub fn search_dir_heading(text: &str) -> String {
    let (lines, had_trailing) = split_keep_trailing(text);
    if lines.is_empty() {
        return text.to_string();
    }
    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    let mut current_dir: Option<String> = None;

    for line in lines {
        let matched = if timestamp_row_re().is_match(line) {
            None
        } else {
            grep_row_re().captures(line)
        };

        if let Some(caps) = matched {
            let path = &caps["path"];
            if let Some(cut) = path.rfind('/') {
                let (dir_part, base) = (&path[..cut + 1], &path[cut + 1..]);
                if current_dir.as_deref() != Some(dir_part) {
                    out.push(dir_part.to_string());
                    current_dir = Some(dir_part.to_string());
                }
                out.push(format!("{base}:{}:{}", &caps["line"], &caps["content"]));
                continue;
            }
        }
        out.push(line.to_string());
        current_dir = None;
    }

    join_keep_trailing(&out, had_trailing)
}

/// Exact inverse of [`search_dir_heading`].
pub fn search_dir_unheading(text: &str) -> String {
    let (lines, had_trailing) = split_keep_trailing(text);
    if lines.is_empty() {
        return text.to_string();
    }
    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    let mut current_dir: Option<&str> = None;
    let mut i = 0;

    while i < lines.len() {
        let line = lines[i];
        let is_data = dir_data_re().is_match(line);
        if let Some(dir) = current_dir {
            if is_data {
                out.push(format!("{dir}{line}"));
                i += 1;
                continue;
            }
        }
        if line.ends_with('/') && i + 1 < lines.len() && dir_data_re().is_match(lines[i + 1]) {
            current_dir = Some(line);
            i += 1;
            continue;
        }
        current_dir = None;
        out.push(line.to_string());
        i += 1;
    }

    join_keep_trailing(&out, had_trailing)
}

/// Group file-path listings (`find` / `rg --files`) by repeated directory headers (`dir/`).
pub fn path_heading(text: &str) -> String {
    let (lines, had_trailing) = split_keep_trailing(text);
    let path_count = lines.iter().filter(|l| path_row_re().is_match(l)).count();
    if path_count < 2 {
        return text.to_string();
    }

    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    let mut current: Option<String> = None;
    for line in lines {
        if let Some(caps) = path_row_re().captures(line) {
            let dir = &caps["dir"];
            if current.as_deref() != Some(dir) {
                out.push(dir.to_string());
                current = Some(dir.to_string());
            }
            out.push(caps["base"].to_string());
        } else {
            out.push(line.to_string());
            current = None;
        }
    }
    join_keep_trailing(&out, had_trailing)
}

/// Exact inverse of [`path_heading`].
pub fn path_unheading(text: &str) -> String {
    let (lines, had_trailing) = split_keep_trailing(text);
    if lines.is_empty() {
        return text.to_string();
    }
    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    let mut current: Option<&str> = None;
    let mut i = 0;

    while i < lines.len() {
        let line = lines[i];
        let is_base = !line.is_empty() && !line.contains('/');
        if let Some(dir) = current {
            if is_base {
                out.push(format!("{dir}{line}"));
                i += 1;
                continue;
            }
        }
        if line.ends_with('/')
            && i + 1 < lines.len()
            && !lines[i + 1].is_empty()
            && !lines[i + 1].contains('/')
        {
            current = Some(line);
            i += 1;
            continue;
        }
        current = None;
        out.push(line.to_string());
        i += 1;
    }

    join_keep_trailing(&out, had_trailing)
}

/// Drop `index <sha>..<sha>[ mode]` bookkeeping lines from unified diffs.
pub fn diff_strip_index(text: &str) -> String {
    let (lines, had_trailing) = split_keep_trailing(text);
    if lines.is_empty() {
        return text.to_string();
    }
    let out: Vec<String> = lines
        .into_iter()
        .filter(|line| !diff_index_re().is_match(line))
        .map(str::to_string)
        .collect();
    join_keep_trailing(&out, had_trailing)
}

/// Trim trailing whitespace per line and collapse multiple consecutive blank lines to one.
pub fn minify_blank_lines(text: &str) -> String {
    let (lines, had_trailing) = split_keep_trailing(text);
    if lines.is_empty() {
        return text.to_string();
    }
    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    let mut blank_run = 0usize;
    for line in lines {
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            blank_run += 1;
            if blank_run == 1 {
                out.push(String::new());
            }
        } else {
            blank_run = 0;
            out.push(trimmed.to_string());
        }
    }
    join_keep_trailing(&out, had_trailing)
}

fn lossless_enabled() -> bool {
    match std::env::var("KITE_CTX_LOSSLESS") {
        Ok(raw) => !matches!(
            raw.trim().to_ascii_lowercase().as_str(),
            "0" | "false" | "no" | "off"
        ),
        Err(_) => true,
    }
}

/// Dispatch deterministic Stage-0 lossless transforms with strict size & round-trip checks.
pub fn compact_lossless(content: &str, kind: ContentKind) -> String {
    if content.is_empty() || !lossless_enabled() {
        return content.to_string();
    }

    match kind {
        ContentKind::Log => {
            let baseline = strip_ansi(content);
            let candidate = collapse_runs(&baseline);
            let best = if expand_runs(&candidate) == baseline && candidate.len() < baseline.len() {
                candidate
            } else {
                baseline
            };
            let minified = minify_blank_lines(&best);
            let final_out = if minified.len() < best.len() {
                minified
            } else {
                best
            };
            if final_out.len() < content.len() {
                final_out
            } else {
                content.to_string()
            }
        }
        ContentKind::Grep => {
            let mut best = content.to_string();
            let cand_file = search_heading(content);
            if search_unheading(&cand_file) == content && cand_file.len() < best.len() {
                best = cand_file;
            }
            let cand_dir = search_dir_heading(content);
            if search_dir_unheading(&cand_dir) == content && cand_dir.len() < best.len() {
                best = cand_dir;
            }
            best
        }
        ContentKind::Paths => {
            let candidate = path_heading(content);
            if path_unheading(&candidate) == content && candidate.len() < content.len() {
                candidate
            } else {
                content.to_string()
            }
        }
        ContentKind::Diff => {
            let candidate = diff_strip_index(content);
            if candidate.len() < content.len() {
                candidate
            } else {
                content.to_string()
            }
        }
        ContentKind::Json => match serde_json::from_str::<serde_json::Value>(content.trim()) {
            Ok(value) => {
                let compact = serde_json::to_string(&value).unwrap_or_else(|_| content.to_string());
                if compact.len() < content.len() {
                    compact
                } else {
                    content.to_string()
                }
            }
            Err(_) => content.to_string(),
        },
        ContentKind::Text | ContentKind::Auto => {
            let baseline = strip_ansi(content);
            let runs_folded = collapse_runs(&baseline);
            let candidate = if expand_runs(&runs_folded) == baseline {
                let blocks_folded = fold_repeated_blocks(&runs_folded);
                if unfold_repeated_blocks(&blocks_folded) == runs_folded {
                    blocks_folded
                } else {
                    runs_folded
                }
            } else {
                baseline
            };
            let minified = minify_blank_lines(&candidate);
            let best = if minified.len() < candidate.len() {
                minified
            } else {
                candidate
            };
            if best.len() < content.len() {
                best
            } else {
                content.to_string()
            }
        }
    }
}

/// Strategy wrapper over [`compact_lossless`].
pub struct LosslessStrategy {
    pub kind: ContentKind,
}

impl CompressionStrategy for LosslessStrategy {
    fn name(&self) -> &'static str {
        "lossless"
    }

    fn compress(&self, input: &str) -> String {
        compact_lossless(input, self.kind)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_ansi_and_collapses_runs_reversibly() {
        let line = "\x1b[32m[2026-11-18] INFO worker heartbeat accepted\x1b[0m\n";
        let raw = line.repeat(5);
        let compressed = compact_lossless(&raw, ContentKind::Log);
        assert!(compressed.contains("... (repeated 5 times)"));
        assert!(!compressed.contains("\x1b["));
        assert_eq!(
            expand_runs(&compressed),
            "[2026-11-18] INFO worker heartbeat accepted\n".repeat(5)
        );
    }

    #[test]
    fn avoids_expanding_short_runs_when_marker_is_longer() {
        let raw = "ok\nok\nok\n";
        assert_eq!(compact_lossless(raw, ContentKind::Log), raw);
    }

    #[test]
    fn folds_repeated_multiline_blocks_reversibly() {
        let original = "\
name: alpha
image: rust:1.88
memory: 128Mi
cpu: 100m
name: beta
image: rust:1.88
memory: 128Mi
cpu: 100m
";
        let folded = fold_repeated_blocks(original);
        assert!(folded.contains("... (repeats 3 lines from 4 lines back)"));
        assert_eq!(unfold_repeated_blocks(&folded), original);
    }

    #[test]
    fn groups_grep_by_file_and_directory_reversibly() {
        let same_file = "\
src/lib.rs:10:pub mod lossless;
src/lib.rs:11:pub mod crusher;
src/lib.rs:12:pub mod ledger;
";
        let file_folded = compact_lossless(same_file, ContentKind::Grep);
        assert!(file_folded.starts_with("src/lib.rs\n10:pub mod lossless;"));
        assert_eq!(search_unheading(&file_folded), same_file);

        let same_dir = "\
src/components/telemetry/A.tsx:5:export const A = 1;
src/components/telemetry/B.tsx:8:export const B = 2;
src/components/telemetry/C.tsx:9:export const C = 3;
";
        let dir_folded = compact_lossless(same_dir, ContentKind::Grep);
        assert!(dir_folded.starts_with("src/components/telemetry/\nA.tsx:5:"));
        assert_eq!(search_dir_unheading(&dir_folded), same_dir);
    }

    #[test]
    fn skips_timestamp_lines_during_search_heading() {
        let log = "2026-11-18 14:30:00 [INFO] a\n2026-11-18 14:30:01 [INFO] b\n";
        assert_eq!(search_heading(log), log);
    }

    #[test]
    fn strips_diff_index_and_folds_paths() {
        let diff = "diff --git a/a.rs b/a.rs\nindex 1111111..2222222 100644\n--- a/a.rs\n+++ b/a.rs\n";
        let stripped = compact_lossless(diff, ContentKind::Diff);
        assert!(!stripped.contains("index 1111111..2222222"));

        let paths = "src/crates/ctx/a.rs\nsrc/crates/ctx/b.rs\nsrc/crates/ctx/c.rs\n";
        let folded_paths = compact_lossless(paths, ContentKind::Paths);
        assert!(folded_paths.starts_with("src/crates/ctx/\na.rs\n"));
        assert_eq!(path_unheading(&folded_paths), paths);
    }

    #[test]
    fn returns_unchanged_when_transform_would_not_shrink() {
        let tiny = "short\n";
        assert_eq!(compact_lossless(tiny, ContentKind::Text), tiny);
    }
}
