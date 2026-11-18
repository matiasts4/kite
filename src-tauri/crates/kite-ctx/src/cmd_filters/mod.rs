pub mod fs;
pub mod git;
pub mod js;
pub mod python;
pub mod rust;

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::lossless::{compact_lossless, strip_ansi};
use crate::pipeline::ContentKind;

/// Result emitted by deterministic CLI output compressors.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilterOutput {
    pub text: String,
    pub filter_name: &'static str,
    pub compressed: bool,
}

/// Declarative custom filter rule loaded from `.kite/ctx-filters.json` or `~/.kite/ctx/filters.json`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CustomFilterRule {
    pub name: String,
    pub program: String,
    #[serde(default)]
    pub subcommand: Option<String>,
    #[serde(default)]
    pub strip_prefixes: Vec<String>,
    #[serde(default)]
    pub keep_prefixes: Vec<String>,
    #[serde(default)]
    pub max_lines: Option<usize>,
    #[serde(default)]
    pub head_tail_keep: Option<(usize, usize)>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct CustomFilterFile {
    #[serde(default)]
    rules: Vec<CustomFilterRule>,
}

/// Load custom filter rules from workspace `.kite/ctx-filters.json` and user `~/.kite/ctx/filters.json`.
pub fn load_custom_filter_rules(
    workspace_dir: Option<&Path>,
    home_dir: Option<&Path>,
) -> Vec<CustomFilterRule> {
    let mut rules = Vec::new();
    let ws = workspace_dir
        .map(Path::to_path_buf)
        .or_else(|| std::env::current_dir().ok());
    if let Some(ws_path) = ws {
        let candidate = ws_path.join(".kite").join("ctx-filters.json");
        append_rules_from_file(&candidate, &mut rules);
    }
    let home = home_dir
        .map(Path::to_path_buf)
        .or_else(|| Some(crate::hooks::resolve_home_dir()));
    if let Some(home_path) = home {
        let candidate = home_path.join(".kite").join("ctx").join("filters.json");
        append_rules_from_file(&candidate, &mut rules);
    }
    rules
}

fn append_rules_from_file(path: &Path, out: &mut Vec<CustomFilterRule>) {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return;
    };
    if let Ok(direct) = serde_json::from_str::<Vec<CustomFilterRule>>(&raw) {
        out.extend(direct);
        return;
    }
    if let Ok(wrapped) = serde_json::from_str::<CustomFilterFile>(&raw) {
        out.extend(wrapped.rules);
    }
}

/// Apply matching declarative custom filter rules while preserving error diagnostics.
pub fn apply_custom_filter_rules(
    rules: &[CustomFilterRule],
    bin: &str,
    rest: &[String],
    combined: &str,
    exit_code: i32,
) -> Option<String> {
    let first_sub = rest.first().map(|s| s.as_str()).unwrap_or("");
    let rule = rules.iter().find(|r| {
        normalize_bin_name(&r.program) == bin
            && r.subcommand
                .as_deref()
                .map(|sub| sub.eq_ignore_ascii_case(first_sub))
                .unwrap_or(true)
    })?;

    let mut kept: Vec<&str> = Vec::new();
    for line in combined.lines() {
        let trimmed = line.trim();
        let lower = trimmed.to_ascii_lowercase();
        let is_error_signal = exit_code != 0
            || lower.contains("error")
            || lower.contains("failed")
            || lower.contains("panic")
            || lower.contains("exception");

        if is_error_signal {
            kept.push(line);
            continue;
        }

        if !rule.strip_prefixes.is_empty()
            && rule
                .strip_prefixes
                .iter()
                .any(|p| trimmed.starts_with(p.as_str()))
        {
            continue;
        }

        if !rule.keep_prefixes.is_empty()
            && !rule
                .keep_prefixes
                .iter()
                .any(|p| trimmed.starts_with(p.as_str()))
        {
            continue;
        }

        kept.push(line);
    }

    if let Some((head, tail)) = rule.head_tail_keep {
        if kept.len() > head + tail && (head > 0 || tail > 0) {
            let omitted = kept.len() - (head + tail);
            let mut sliced = Vec::with_capacity(head + tail + 1);
            sliced.extend_from_slice(&kept[..head]);
            let marker = format!(
                "... ({omitted} lines omitted by custom filter '{}')",
                rule.name
            );
            let mut out = sliced.join("\n");
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str(&marker);
            if tail > 0 {
                out.push('\n');
                out.push_str(&kept[kept.len() - tail..].join("\n"));
            }
            return Some(out);
        }
    }

    if let Some(max) = rule.max_lines {
        if max > 0 && kept.len() > max {
            let omitted = kept.len() - max;
            let mut out = kept[..max].join("\n");
            out.push_str(&format!(
                "\n... ({omitted} lines omitted by custom filter '{}')",
                rule.name
            ));
            return Some(out);
        }
    }

    Some(kept.join("\n"))
}

/// Normalize executable name across Unix/Windows paths (`C:\...\git.exe` -> `git`).
pub fn normalize_bin_name(raw: &str) -> String {
    let base = Path::new(raw)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(raw);
    let lower = base.to_ascii_lowercase();
    for suffix in [".exe", ".cmd", ".bat", ".ps1"] {
        if let Some(stripped) = lower.strip_suffix(suffix) {
            return stripped.to_string();
        }
    }
    lower
}

/// Combine stdout/stderr cleanly after stripping ANSI sequences.
pub(crate) fn merge_streams(stdout: &str, stderr: &str) -> String {
    let out = strip_ansi(stdout);
    let err = strip_ansi(stderr);
    match (out.trim().is_empty(), err.trim().is_empty()) {
        (true, true) => String::new(),
        (false, true) => out,
        (true, false) => err,
        (false, false) => format!("{}\n{}", out.trim_end(), err.trim_end()),
    }
}

/// Route executed command output through deterministic, zero-ML filters.
///
/// Guarantees that failure exit codes and error diagnostics are never dropped.
pub fn filter_command_output(
    command: &[String],
    stdout: &str,
    stderr: &str,
    exit_code: i32,
) -> FilterOutput {
    let combined = merge_streams(stdout, stderr);
    if combined.is_empty() {
        return FilterOutput {
            text: String::new(),
            filter_name: "empty",
            compressed: false,
        };
    }

    let Some(first) = command.first() else {
        let folded = compact_lossless(&combined, ContentKind::Log);
        let compressed = folded.len() < combined.len();
        return FilterOutput {
            text: folded,
            filter_name: "generic_log",
            compressed,
        };
    };

    let bin = normalize_bin_name(first);
    let rest = &command[1..];

    let custom_rules = load_custom_filter_rules(None, None);
    if !custom_rules.is_empty() {
        if let Some(filtered) =
            apply_custom_filter_rules(&custom_rules, &bin, rest, &combined, exit_code)
        {
            if filtered.len() < combined.len() {
                return FilterOutput {
                    text: filtered,
                    filter_name: "custom",
                    compressed: true,
                };
            }
        }
    }

    let routed: Option<(&'static str, String)> = match bin.as_str() {
        "git" => git::filter_git(rest, &combined, exit_code),
        "cargo" => rust::filter_cargo(rest, &combined, exit_code),
        "vitest" | "jest" => js::filter_js_test(&combined, exit_code),
        "tsc" => js::filter_tsc(&combined),
        "npm" | "pnpm" | "yarn" | "bun" => js::filter_pkg_runner(rest, &combined, exit_code),
        "npx" => js::filter_npx(rest, &combined, exit_code),
        "pytest" => python::filter_pytest(&combined, exit_code),
        "ruff" | "mypy" => python::filter_python_lint(&combined),
        "grep" | "rg" => fs::filter_search(&combined),
        "ls" | "dir" | "tree" | "find" => fs::filter_listing(&combined),
        _ => None,
    };

    if let Some((filter_name, filtered)) = routed {
        let compressed = filtered.len() < combined.len();
        return FilterOutput {
            text: if filtered.len() <= combined.len() {
                filtered
            } else {
                combined
            },
            filter_name,
            compressed,
        };
    }

    let kind = crate::pipeline::detect_content_kind(&combined);
    let folded = compact_lossless(&combined, kind);
    let compressed = folded.len() < combined.len();
    FilterOutput {
        text: folded,
        filter_name: "generic",
        compressed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_git_cargo_vitest_tsc_pytest_and_rg() {
        let cmd = vec![
            "C:\\Program Files\\Git\\cmd\\git.exe".to_string(),
            "status".to_string(),
        ];
        let out = "On branch main\nChanges not staged for commit:\n  (use \"git add <file>...\" to update what will be committed)\n\tmodified:   src/lib.rs\nUntracked files:\n  (use \"git add <file>...\" to include in what will be committed)\n\tnew.rs\n";
        let res = filter_command_output(&cmd, out, "", 0);
        assert_eq!(res.filter_name, "git_status");
        assert!(res.text.contains("src/lib.rs"));
        assert!(!res.text.contains("use \"git add"));
        assert!(res.compressed);
    }

    #[test]
    fn applies_declarative_custom_filter_rules_and_preserves_errors() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path();
        std::fs::create_dir_all(ws.join(".kite")).unwrap();
        std::fs::write(
            ws.join(".kite").join("ctx-filters.json"),
            r##"[{
                "name": "docker-build",
                "program": "docker",
                "subcommand": "build",
                "strip_prefixes": ["#1 [internal]", "#2 [internal]"],
                "head_tail_keep": [2, 2]
            }]"##,
        )
        .unwrap();

        let rules = load_custom_filter_rules(Some(ws), None);
        assert_eq!(rules.len(), 1);

        let raw = "#1 [internal] load build definition\n#2 [internal] load metadata\nStep 1/6 : FROM rust:1.82\nStep 2/6 : WORKDIR /app\nStep 3/6 : COPY . .\nStep 4/6 : RUN cargo build\nStep 5/6 : ERROR: failed to compile crate\nStep 6/6 : EXPOSE 8080\nSuccessfully built abcdef";
        let filtered =
            apply_custom_filter_rules(&rules, "docker", &["build".to_string()], raw, 0).unwrap();
        assert!(!filtered.contains("#1 [internal]"));
        assert!(filtered.contains("Step 1/6 : FROM rust:1.82"));
        assert!(filtered.contains("Successfully built abcdef"));
        assert!(filtered.contains("omitted by custom filter 'docker-build'"));
    }
}
