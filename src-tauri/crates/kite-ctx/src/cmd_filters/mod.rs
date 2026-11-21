pub mod fs;
pub mod git;
pub mod js;
pub mod python;
pub mod rust;

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::ccr_store::CcrStore;
use crate::lossless::{compact_lossless, strip_ansi};
use crate::pipeline::ContentKind;

pub(crate) const GIT_VALUE_FLAGS: &[&str] = &[
    "-C",
    "-c",
    "--git-dir",
    "--work-tree",
    "--namespace",
    "--super-prefix",
    "--exec-path",
    "--config-env",
];

pub(crate) const CARGO_VALUE_FLAGS: &[&str] = &[
    "-C",
    "-Z",
    "--manifest-path",
    "--target-dir",
    "--color",
    "--config",
    "--explain",
];

pub(crate) const NPX_VALUE_FLAGS: &[&str] = &[
    "--prefix",
    "-p",
    "--package",
    "-c",
    "--call",
    "--userconfig",
    "--cache",
    "--node-options",
];

pub(crate) const PKG_VALUE_FLAGS: &[&str] = &[
    "--prefix",
    "-C",
    "--dir",
    "--cwd",
    "--filter",
    "--workspace",
    "-w",
    "--userconfig",
    "--cache",
    "--loglevel",
];

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

/// Normalize an `npx` tool token (`C:\...\vitest.cmd` or `vitest@2.1` -> `vitest`).
pub(crate) fn normalize_npx_tool(raw: &str) -> String {
    let base = normalize_bin_name(raw);
    if !base.starts_with('@') {
        if let Some((pkg, _ver)) = base.split_once('@') {
            return pkg.to_string();
        }
    }
    base
}

/// Skip leading flags (including known flags that take a separate value) to locate
/// the subcommand or tool argument index inside `args`.
pub fn resolve_subcommand_index(
    args: &[String],
    value_flags: &[&str],
    skip_plus_prefix: bool,
) -> Option<usize> {
    let mut i = 0usize;
    while i < args.len() {
        let arg = args[i].as_str();
        if arg == "--" {
            return (i + 1 < args.len()).then_some(i + 1);
        }
        if value_flags.contains(&arg) {
            i += 2;
            continue;
        }
        if arg.starts_with('-') || (skip_plus_prefix && arg.starts_with('+')) {
            i += 1;
            continue;
        }
        return Some(i);
    }
    None
}

/// Resolve `(index, normalized_subcommand)` for binaries that accept global flags before
/// their subcommand (`git`, `cargo`, `npx`, `npm`, `pnpm`, `yarn`, `bun`).
pub fn resolve_subcommand_for_bin(bin: &str, args: &[String]) -> Option<(usize, String)> {
    match bin {
        "git" => resolve_subcommand_index(args, GIT_VALUE_FLAGS, false)
            .map(|idx| (idx, args[idx].to_ascii_lowercase())),
        "cargo" => resolve_subcommand_index(args, CARGO_VALUE_FLAGS, true)
            .map(|idx| (idx, args[idx].to_ascii_lowercase())),
        "npx" => resolve_subcommand_index(args, NPX_VALUE_FLAGS, false)
            .map(|idx| (idx, normalize_npx_tool(&args[idx]))),
        "npm" | "pnpm" | "yarn" | "bun" => resolve_subcommand_index(args, PKG_VALUE_FLAGS, false)
            .map(|idx| (idx, args[idx].to_ascii_lowercase())),
        _ => None,
    }
}

/// Canonical feature label (`<bin> <subcommand>` or `<bin>`) for ledger & discovery telemetry.
pub fn canonical_command_label(command: &[String]) -> String {
    let Some(first) = command.first() else {
        return String::new();
    };
    let bin = normalize_bin_name(first);
    if bin.is_empty() {
        return String::new();
    }
    let rest = &command[1..];
    if let Some((_, sub)) = resolve_subcommand_for_bin(&bin, rest) {
        return format!("{bin} {sub}");
    }
    if let Some(arg1) = rest.first().map(|s| s.trim()) {
        if !arg1.is_empty()
            && !arg1.starts_with('-')
            && !arg1.contains(char::is_whitespace)
            && arg1.len() <= 40
        {
            return format!("{bin} {arg1}");
        }
    }
    bin
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
    filter_command_output_with_ccr(command, stdout, stderr, exit_code, None)
}

/// Route executed command output through deterministic filters with optional CCR spillover
/// for large search/diff/status/build outputs.
pub fn filter_command_output_with_ccr(
    command: &[String],
    stdout: &str,
    stderr: &str,
    exit_code: i32,
    ccr: Option<&CcrStore>,
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
        "git" => git::filter_git_with_ccr(rest, &combined, exit_code, ccr),
        "cargo" => rust::filter_cargo_with_ccr(rest, &combined, exit_code, ccr),
        "vitest" | "jest" => js::filter_js_test(&combined, exit_code),
        "tsc" => js::filter_tsc(&combined),
        "npm" | "pnpm" | "yarn" | "bun" => js::filter_pkg_runner(rest, &combined, exit_code),
        "npx" => js::filter_npx(rest, &combined, exit_code),
        "pytest" => python::filter_pytest(&combined, exit_code),
        "ruff" | "mypy" => python::filter_python_lint(&combined),
        "grep" | "rg" => fs::filter_search_with_ccr(&combined, ccr),
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

    #[test]
    fn resolves_commands_past_leading_value_flags() {
        let npx_cmd: Vec<String> = vec![
            "npx".into(),
            "--prefix".into(),
            "C:\\projects\\app".into(),
            "vitest".into(),
            "run".into(),
        ];
        let vitest_raw = " ✓ a.test.ts (3)\n Test Files  1 passed (1)\n      Tests  3 passed (3)\n";
        let npx_res = filter_command_output(&npx_cmd, vitest_raw, "", 0);
        assert_eq!(npx_res.filter_name, "vitest_text");
        assert!(!npx_res.text.contains("a.test.ts"));

        let npm_cmd: Vec<String> = vec![
            "npm".into(),
            "--prefix".into(),
            "frontend".into(),
            "run".into(),
            "test".into(),
        ];
        let npm_res = filter_command_output(&npm_cmd, vitest_raw, "", 0);
        assert_eq!(npm_res.filter_name, "vitest_text");

        let git_cmd: Vec<String> = vec![
            "git".into(),
            "-C".into(),
            "C:\\repo".into(),
            "-c".into(),
            "core.quotepath=false".into(),
            "status".into(),
        ];
        let status_raw = "On branch main\nChanges not staged for commit:\n\tmodified:   src/main.rs\n";
        let git_res = filter_command_output(&git_cmd, status_raw, "", 0);
        assert_eq!(git_res.filter_name, "git_status");
        assert!(git_res.text.contains("src/main.rs"));

        let cargo_cmd: Vec<String> = vec![
            "cargo".into(),
            "+nightly".into(),
            "--manifest-path".into(),
            "src-tauri/Cargo.toml".into(),
            "test".into(),
        ];
        let cargo_raw = "   Compiling app v0.1.0\ntest a ... ok\ntest result: ok. 1 passed; 0 failed\n";
        let cargo_res = filter_command_output(&cargo_cmd, cargo_raw, "", 0);
        assert_eq!(cargo_res.filter_name, "cargo_test");
        assert!(!cargo_res.text.contains("Compiling app"));
    }
}
