//! Missed-savings history auditor (`kite ctx discover`).
//!
//! Scans shell history and recent local agent session logs for commands that were
//! executed without `kite ctx exec`, estimating how many tokens could have been
//! saved and surfacing top optimization candidates.

use std::collections::BTreeMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::cmd_filters::normalize_bin_name;
use crate::hooks::rewrite_hook_command;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct DiscoverCandidate {
    pub command: String,
    pub count: usize,
    pub estimated_missed_tokens: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct DiscoverySummary {
    pub scanned_commands: usize,
    pub already_optimized: usize,
    pub missed_commands: usize,
    pub estimated_missed_tokens: usize,
    pub top_candidates: Vec<DiscoverCandidate>,
}

/// Audit an iterator of raw shell command strings and compute missed token savings.
pub fn scan_command_strings<I, S>(commands: I) -> DiscoverySummary
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut scanned_commands = 0usize;
    let mut already_optimized = 0usize;
    let mut missed_commands = 0usize;
    let mut estimated_missed_tokens = 0usize;
    let mut grouped: BTreeMap<String, (usize, usize)> = BTreeMap::new();

    for raw in commands {
        let trimmed = raw.as_ref().trim();
        if trimmed.is_empty() {
            continue;
        }
        scanned_commands += 1;

        if trimmed.contains("kite ctx ")
            || trimmed.contains("kite.exe ctx ")
            || trimmed.starts_with("kite ctx")
        {
            already_optimized += 1;
            continue;
        }

        if let Some(rewritten) = rewrite_hook_command(trimmed) {
            if rewritten != trimmed {
                missed_commands += 1;
                let (label, est_tokens) = classify_missed_command(trimmed);
                estimated_missed_tokens += est_tokens;
                let entry = grouped.entry(label).or_insert((0, 0));
                entry.0 += 1;
                entry.1 += est_tokens;
            }
        }
    }

    let mut top_candidates: Vec<DiscoverCandidate> = grouped
        .into_iter()
        .map(|(command, (count, tokens))| DiscoverCandidate {
            command,
            count,
            estimated_missed_tokens: tokens,
        })
        .collect();

    top_candidates.sort_by(|a, b| {
        b.estimated_missed_tokens
            .cmp(&a.estimated_missed_tokens)
            .then_with(|| b.count.cmp(&a.count))
            .then_with(|| a.command.cmp(&b.command))
    });
    top_candidates.truncate(10);

    DiscoverySummary {
        scanned_commands,
        already_optimized,
        missed_commands,
        estimated_missed_tokens,
        top_candidates,
    }
}

fn classify_missed_command(cmd: &str) -> (String, usize) {
    // Pick the first eligible segment in case of a `&&` or `;` chain.
    for part in cmd.split(|c| c == ';' || c == '&') {
        let seg = part.trim();
        if seg.is_empty() {
            continue;
        }
        let mut words = seg.split_whitespace();
        let Some(first) = words.next() else {
            continue;
        };
        let bin = normalize_bin_name(first);
        let second = words.next().unwrap_or("");
        match bin.as_str() {
            "cargo" => {
                let sub = if second.is_empty() { "build" } else { second };
                let est = match sub {
                    "test" => 1_200,
                    "clippy" | "check" | "build" => 750,
                    _ => 500,
                };
                return (format!("cargo {sub}"), est);
            }
            "git" => {
                let sub = if second.is_empty() { "status" } else { second };
                let est = match sub {
                    "diff" | "show" => 900,
                    "log" => 650,
                    "status" => 260,
                    _ => 300,
                };
                return (format!("git {sub}"), est);
            }
            "vitest" | "jest" | "pytest" => {
                return (bin, 1_100);
            }
            "tsc" => {
                return ("tsc".to_string(), 700);
            }
            "rg" | "grep" => {
                return (bin, 600);
            }
            "npx" | "npm" | "pnpm" | "yarn" | "bun" => {
                let sub = if second.is_empty() { "test" } else { second };
                return (format!("{bin} {sub}"), 950);
            }
            "tree" | "find" | "ls" | "dir" => {
                return (bin, 350);
            }
            _ => {}
        }
    }
    ("shell command".to_string(), 400)
}

/// Scan recent shell history and local agent session transcripts on disk.
pub fn discover_from_host(home_dir: &Path, _workspace_dir: &Path) -> DiscoverySummary {
    let mut collected: Vec<String> = Vec::new();

    // 1. PowerShell PSReadLine history (Windows)
    if let Ok(appdata) = std::env::var("APPDATA") {
        let ps_hist = PathBuf::from(appdata)
            .join("Microsoft")
            .join("Windows")
            .join("PowerShell")
            .join("PSReadLine")
            .join("ConsoleHost_history.txt");
        collect_tail_lines(&ps_hist, 400, &mut collected);
    }

    // 2. Bash / Zsh history
    collect_tail_lines(&home_dir.join(".bash_history"), 300, &mut collected);
    collect_tail_lines(&home_dir.join(".zsh_history"), 300, &mut collected);

    // 3. Recent agent JSONL transcripts (bounded for sub-30ms speed)
    let mut jsonl_files: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    collect_recent_jsonl(&home_dir.join(".claude").join("projects"), 2, &mut jsonl_files);
    collect_recent_jsonl(&home_dir.join(".codex").join("sessions"), 3, &mut jsonl_files);
    collect_recent_jsonl(
        &home_dir
            .join(".gemini")
            .join("antigravity-cli")
            .join("brain"),
        3,
        &mut jsonl_files,
    );

    jsonl_files.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, path) in jsonl_files.into_iter().take(12) {
        extract_commands_from_jsonl_tail(&path, 192 * 1024, &mut collected);
    }

    scan_command_strings(collected)
}

fn collect_tail_lines(path: &Path, max_lines: usize, out: &mut Vec<String>) {
    let Ok(mut file) = std::fs::File::open(path) else {
        return;
    };
    let Ok(meta) = file.metadata() else {
        return;
    };
    let len = meta.len();
    let offset = len.saturating_sub(64 * 1024);
    let _ = file.seek(SeekFrom::Start(offset));
    let mut buf = Vec::new();
    if file.read_to_end(&mut buf).is_err() {
        return;
    }
    let text = String::from_utf8_lossy(&buf);
    let lines: Vec<&str> = text.lines().collect();
    let start = lines.len().saturating_sub(max_lines);
    for line in &lines[start..] {
        let cleaned = line
            .strip_prefix(": ")
            .and_then(|s| s.split_once(';').map(|(_, cmd)| cmd))
            .unwrap_or(line)
            .trim();
        if !cleaned.is_empty() {
            out.push(cleaned.to_string());
        }
    }
}

fn collect_recent_jsonl(
    dir: &Path,
    max_depth: usize,
    out: &mut Vec<(std::time::SystemTime, PathBuf)>,
) {
    if max_depth == 0 || !dir.is_dir() {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten().take(40) {
        let path = entry.path();
        if path.is_dir() {
            collect_recent_jsonl(&path, max_depth - 1, out);
        } else if path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("jsonl"))
        {
            if let Ok(meta) = entry.metadata() {
                if let Ok(modified) = meta.modified() {
                    out.push((modified, path));
                }
            }
        }
    }
}

fn extract_commands_from_jsonl_tail(path: &Path, max_bytes: u64, out: &mut Vec<String>) {
    let Ok(mut file) = std::fs::File::open(path) else {
        return;
    };
    let Ok(meta) = file.metadata() else {
        return;
    };
    let offset = meta.len().saturating_sub(max_bytes);
    let _ = file.seek(SeekFrom::Start(offset));
    let mut buf = Vec::new();
    if file.read_to_end(&mut buf).is_err() {
        return;
    }
    let text = String::from_utf8_lossy(&buf);
    for line in text.lines() {
        if !line.contains("CommandLine") && !line.contains("\"command\"") {
            continue;
        }
        if let Ok(val) = serde_json::from_str::<Value>(line) {
            extract_commands_from_value(&val, out);
        }
    }
}

fn extract_commands_from_value(val: &Value, out: &mut Vec<String>) {
    match val {
        Value::Object(map) => {
            for (k, v) in map {
                if (k == "CommandLine" || k == "command") && v.is_string() {
                    if let Some(s) = v.as_str() {
                        out.push(s.to_string());
                    }
                } else {
                    extract_commands_from_value(v, out);
                }
            }
        }
        Value::Array(arr) => {
            for item in arr {
                extract_commands_from_value(item, out);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audits_missed_and_optimized_commands_accurately() {
        let sample = vec![
            "cargo test -p kite-ctx",
            "cd src-tauri && cargo test --bin kite",
            "kite ctx exec -- cargo test -p kite-ctx",
            "git status",
            "git diff HEAD~1",
            "npx vitest run",
            "echo hello",
        ];

        let summary = scan_command_strings(sample);
        assert_eq!(summary.scanned_commands, 7);
        assert_eq!(summary.already_optimized, 1);
        assert_eq!(summary.missed_commands, 5);
        assert!(summary.estimated_missed_tokens >= 3_500);
        assert_eq!(summary.top_candidates[0].command, "cargo test");
        assert_eq!(summary.top_candidates[0].count, 2);
    }
}
