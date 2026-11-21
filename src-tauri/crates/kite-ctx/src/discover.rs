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

use crate::cmd_filters::{normalize_bin_name, resolve_subcommand_for_bin};
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
        let unquoted = unquote_command_string(raw.as_ref());
        let trimmed = unquoted.trim();
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

fn unquote_command_string(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.len() >= 2 && trimmed.starts_with('"') && trimmed.ends_with('"') {
        if let Ok(decoded) = serde_json::from_str::<String>(trimmed) {
            return decoded;
        }
        return trimmed[1..trimmed.len() - 1].to_string();
    }
    trimmed.to_string()
}

fn classify_missed_command(cmd: &str) -> (String, usize) {
    // Pick the first eligible segment in case of a `&&` or `;` chain.
    for part in cmd.split(|c| c == ';' || c == '&') {
        let seg = part.trim();
        if seg.is_empty() {
            continue;
        }
        let words: Vec<String> = seg.split_whitespace().map(str::to_string).collect();
        let Some(first) = words.first() else {
            continue;
        };
        let bin = normalize_bin_name(first);
        let sub = resolve_subcommand_for_bin(&bin, &words[1..])
            .map(|(_, s)| s)
            .or_else(|| words.get(1).cloned())
            .unwrap_or_default();
        match bin.as_str() {
            "cargo" => {
                let s = if sub.is_empty() { "build".to_string() } else { sub };
                let est = match s.as_str() {
                    "test" | "nextest" => 1_200,
                    "clippy" | "check" | "build" => 750,
                    _ => 500,
                };
                return (format!("cargo {s}"), est);
            }
            "git" => {
                let s = if sub.is_empty() { "status".to_string() } else { sub };
                let est = match s.as_str() {
                    "diff" | "show" | "grep" => 900,
                    "log" => 650,
                    "status" => 260,
                    _ => 300,
                };
                return (format!("git {s}"), est);
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
                let s = if sub.is_empty() { "test".to_string() } else { sub };
                return (format!("{bin} {s}"), 950);
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
    let appdata_dir = {
        let under_home = home_dir.join("AppData").join("Roaming");
        if under_home.is_dir() {
            Some(under_home)
        } else if home_dir == crate::hooks::resolve_home_dir() {
            std::env::var("APPDATA").ok().map(PathBuf::from)
        } else {
            None
        }
    };
    if let Some(appdata) = appdata_dir {
        let ps_hist = appdata
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
    collect_recent_jsonl(&home_dir.join(".claude").join("projects"), 4, &mut jsonl_files);
    collect_recent_jsonl(&home_dir.join(".codex").join("sessions"), 4, &mut jsonl_files);
    jsonl_files.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, path) in jsonl_files.into_iter().take(12) {
        extract_commands_from_jsonl_tail(&path, 192 * 1024, &mut collected);
    }

    // 4. Antigravity session transcripts (`brain/<uuid>/.system_generated/logs/transcript.jsonl`),
    // sorted newest-first directly at depth 4 and matched with hook-rewrite tool responses.
    let mut agy_logs: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    collect_antigravity_transcripts(
        &home_dir
            .join(".gemini")
            .join("antigravity-cli")
            .join("brain"),
        &mut agy_logs,
    );
    collect_antigravity_transcripts(
        &home_dir.join(".gemini").join("antigravity").join("brain"),
        &mut agy_logs,
    );
    agy_logs.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, path) in agy_logs.into_iter().take(16) {
        extract_antigravity_commands_from_jsonl_tail(&path, 256 * 1024, &mut collected);
    }

    scan_command_strings(collected)
}

fn collect_antigravity_transcripts(
    brain_dir: &Path,
    out: &mut Vec<(std::time::SystemTime, PathBuf)>,
) {
    if !brain_dir.is_dir() {
        return;
    }
    let Ok(entries) = std::fs::read_dir(brain_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let transcript = path
            .join(".system_generated")
            .join("logs")
            .join("transcript.jsonl");
        if let Ok(meta) = std::fs::metadata(&transcript) {
            if meta.is_file() {
                if let Ok(modified) = meta.modified() {
                    out.push((modified, transcript));
                }
            }
        }
    }
}

fn extract_antigravity_commands_from_jsonl_tail(
    path: &Path,
    max_bytes: u64,
    out: &mut Vec<String>,
) {
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

    let mut pending_calls: Vec<Option<String>> = Vec::new();
    let mut pending_cursor = 0usize;

    let flush_pending = |pending: &mut Vec<Option<String>>, cursor: &mut usize, out: &mut Vec<String>| {
        for slot in pending.drain(..) {
            if let Some(cmd) = slot {
                out.push(cmd);
            }
        }
        *cursor = 0;
    };

    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || !trimmed.starts_with('{') {
            continue;
        }
        let Ok(val) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        let step_type = val.get("type").and_then(Value::as_str).unwrap_or("");
        if step_type == "PLANNER_RESPONSE" {
            flush_pending(&mut pending_calls, &mut pending_cursor, out);
            if let Some(tool_calls) = val.get("tool_calls").and_then(Value::as_array) {
                for call in tool_calls {
                    let cmd = call
                        .get("args")
                        .and_then(|a| a.get("CommandLine").or_else(|| a.get("command")))
                        .and_then(Value::as_str)
                        .map(unquote_command_string)
                        .filter(|s| !s.trim().is_empty());
                    pending_calls.push(cmd);
                }
            }
            continue;
        }

        if step_type == "GENERIC" && pending_cursor < pending_calls.len() {
            let maybe_cmd = pending_calls[pending_cursor].take();
            pending_cursor += 1;
            if let Some(cmd) = maybe_cmd {
                let content = val.get("content").and_then(Value::as_str).unwrap_or("");
                let rewritten_by_hook = content.contains(
                    "A pre-tool hook changed the arguments of this tool call before it ran",
                );
                if rewritten_by_hook && rewrite_hook_command(&cmd).is_some() {
                    out.push(format!("kite ctx exec -- {cmd}"));
                } else {
                    out.push(cmd);
                }
            }
            continue;
        }

        if line.contains("CommandLine") || line.contains("\"command\"") {
            extract_commands_from_value(&val, out);
        }
    }

    flush_pending(&mut pending_calls, &mut pending_cursor, out);
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
                        let cleaned = unquote_command_string(s);
                        if !cleaned.is_empty() {
                            out.push(cleaned);
                        }
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

    #[test]
    fn discovers_antigravity_depth4_transcripts_unquotes_and_respects_hook_rewrites() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let log_dir = home
            .join(".gemini")
            .join("antigravity-cli")
            .join("brain")
            .join("session-123")
            .join(".system_generated")
            .join("logs");
        std::fs::create_dir_all(&log_dir).unwrap();

        let transcript = "\
{\"step_index\":1,\"type\":\"PLANNER_RESPONSE\",\"tool_calls\":[{\"name\":\"run_command\",\"args\":{\"CommandLine\":\"\\\"git -C C:\\\\\\\\repo diff\\\"\"}}]}\n\
{\"step_index\":2,\"type\":\"GENERIC\",\"content\":\"A pre-tool hook changed the arguments of this tool call before it ran. Changed: CommandLine.\\n\"}\n\
{\"step_index\":3,\"type\":\"PLANNER_RESPONSE\",\"tool_calls\":[{\"name\":\"run_command\",\"args\":{\"CommandLine\":\"\\\"npx --prefix ui vitest run\\\"\"}}]}\n\
{\"step_index\":4,\"type\":\"GENERIC\",\"content\":\"Command exited with code 0\"}\n";
        std::fs::write(log_dir.join("transcript.jsonl"), transcript).unwrap();

        let summary = discover_from_host(home, home);
        assert_eq!(summary.scanned_commands, 2);
        assert_eq!(summary.already_optimized, 1);
        assert_eq!(summary.missed_commands, 1);
        assert_eq!(summary.top_candidates[0].command, "npx vitest");
    }
}
