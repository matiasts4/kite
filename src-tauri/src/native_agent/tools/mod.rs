//! Workspace-sandboxed native coding tools for the Rust agent fast lane.

pub mod fs_tools;
pub mod search_tools;
pub mod shell_tools;

use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};

use serde_json::Value;

use crate::native_agent::types::NativeToolDef;

const IGNORED_DIR_NAMES: &[&str] = &[".git", "node_modules", "target"];

/// Normalized result returned by every native workspace tool execution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolOutput {
    pub ok: bool,
    pub content: String,
    pub truncated: bool,
}

impl ToolOutput {
    pub fn success(content: impl Into<String>, truncated: bool) -> Self {
        Self {
            ok: true,
            content: content.into(),
            truncated,
        }
    }

    pub fn error(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            content: message.into(),
            truncated: false,
        }
    }
}

/// Registry exposing JSON-schema definitions and synchronous execution for all built-in tools.
#[derive(Debug, Clone, Default)]
pub struct NativeToolRegistry;

impl NativeToolRegistry {
    pub fn new() -> Self {
        Self
    }

    pub fn definitions(&self) -> Vec<NativeToolDef> {
        vec![
            fs_tools::read_file_def(),
            fs_tools::edit_file_def(),
            fs_tools::write_file_def(),
            search_tools::grep_search_def(),
            search_tools::find_files_def(),
            shell_tools::run_command_def(),
        ]
    }

    pub fn execute(&self, workspace_root: &Path, name: &str, args: Value) -> ToolOutput {
        if !args.is_object() && !args.is_null() {
            return ToolOutput::error(format!("Tool '{name}' arguments must be a JSON object."));
        }
        match name {
            "read_file" => fs_tools::execute_read_file(workspace_root, &args),
            "edit_file" => fs_tools::execute_edit_file(workspace_root, &args),
            "write_file" => fs_tools::execute_write_file(workspace_root, &args),
            "grep_search" => search_tools::execute_grep_search(workspace_root, &args),
            "find_files" => search_tools::execute_find_files(workspace_root, &args),
            "run_command" => shell_tools::execute_run_command(workspace_root, &args),
            other => ToolOutput::error(format!("Unknown native tool '{other}'.")),
        }
    }
}

/// Canonicalize `workspace_root` and confirm it exists as a directory.
pub(crate) fn canonical_workspace_root(workspace_root: &Path) -> Result<PathBuf, String> {
    if !workspace_root.exists() {
        return Err(format!(
            "Workspace root '{}' does not exist.",
            workspace_root.display()
        ));
    }
    let canonical = std::fs::canonicalize(workspace_root).map_err(|e| {
        format!(
            "Failed to canonicalize workspace root '{}': {e}",
            workspace_root.display()
        )
    })?;
    if !canonical.is_dir() {
        return Err(format!(
            "Workspace root '{}' is not a directory.",
            workspace_root.display()
        ));
    }
    Ok(canonical)
}

/// Resolve `raw_target` strictly inside the canonical `workspace_root`.
///
/// Rejects empty paths, NUL bytes, root-relative/drive-relative prefixes, `..` escapes,
/// external absolute paths, dangling symlinks, and symlinks resolving outside the workspace.
/// For paths not yet on disk, canonicalizes the nearest existing ancestor directory and
/// verifies `starts_with(&canonical_root)` before reattaching remaining segments.
pub fn resolve_workspace_path(workspace_root: &Path, raw_target: &str) -> Result<PathBuf, String> {
    let trimmed = raw_target.trim();
    if trimmed.is_empty() {
        return Err("Path must not be empty.".to_string());
    }
    if trimmed.contains('\0') {
        return Err("Path contains an invalid NUL byte.".to_string());
    }

    let canonical_root = canonical_workspace_root(workspace_root)?;
    let raw_path = Path::new(trimmed);
    let has_prefix_or_root = raw_path
        .components()
        .any(|c| matches!(c, Component::Prefix(_) | Component::RootDir));

    let normalized = if has_prefix_or_root {
        if !raw_path.is_absolute() {
            return Err(format!(
                "Path '{raw_target}' uses a root-relative or drive-relative prefix outside workspace containment."
            ));
        }
        normalize_absolute_lexically(raw_path, raw_target)?
    } else {
        let rel_segments = normalize_relative_lexically(raw_path, raw_target, &canonical_root)?;
        let mut joined = canonical_root.clone();
        for seg in rel_segments {
            joined.push(seg);
        }
        joined
    };

    canonicalize_nearest_ancestor(&canonical_root, &normalized, raw_target)
}

fn validate_normal_segment(seg: &std::ffi::OsStr, raw_target: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        if seg.to_string_lossy().contains(':') {
            return Err(format!(
                "Path '{raw_target}' contains an unsupported colon character in a path segment."
            ));
        }
    }
    let _ = (seg, raw_target);
    Ok(())
}

fn normalize_absolute_lexically(raw_path: &Path, raw_target: &str) -> Result<PathBuf, String> {
    let mut base = PathBuf::new();
    let mut segments: Vec<OsString> = Vec::new();

    for comp in raw_path.components() {
        match comp {
            Component::Prefix(prefix) => base.push(prefix.as_os_str()),
            Component::RootDir => base.push(comp.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if segments.pop().is_none() {
                    return Err(format!(
                        "Path '{raw_target}' traverses above the filesystem root."
                    ));
                }
            }
            Component::Normal(seg) => {
                if seg == "." {
                    continue;
                }
                if seg == ".." {
                    if segments.pop().is_none() {
                        return Err(format!(
                            "Path '{raw_target}' traverses above the filesystem root."
                        ));
                    }
                    continue;
                }
                validate_normal_segment(seg, raw_target)?;
                segments.push(seg.to_os_string());
            }
        }
    }

    for seg in segments {
        base.push(seg);
    }
    Ok(base)
}

fn normalize_relative_lexically(
    raw_path: &Path,
    raw_target: &str,
    canonical_root: &Path,
) -> Result<Vec<OsString>, String> {
    let mut segments: Vec<OsString> = Vec::new();

    for comp in raw_path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                if segments.pop().is_none() {
                    return Err(format!(
                        "Path '{raw_target}' escapes workspace root '{}'.",
                        canonical_root.display()
                    ));
                }
            }
            Component::Normal(seg) => {
                if seg == "." {
                    continue;
                }
                if seg == ".." {
                    if segments.pop().is_none() {
                        return Err(format!(
                            "Path '{raw_target}' escapes workspace root '{}'.",
                            canonical_root.display()
                        ));
                    }
                    continue;
                }
                validate_normal_segment(seg, raw_target)?;
                segments.push(seg.to_os_string());
            }
            Component::Prefix(_) | Component::RootDir => {
                return Err(format!(
                    "Path '{raw_target}' uses an unsupported prefix or root."
                ));
            }
        }
    }

    Ok(segments)
}

fn canonicalize_nearest_ancestor(
    canonical_root: &Path,
    normalized: &Path,
    raw_target: &str,
) -> Result<PathBuf, String> {
    let mut probe = normalized.to_path_buf();
    let mut missing_tail: Vec<OsString> = Vec::new();

    loop {
        match std::fs::symlink_metadata(&probe) {
            Ok(_) => {
                let canon_ancestor = std::fs::canonicalize(&probe).map_err(|e| {
                    format!("Failed to resolve path '{raw_target}' (possible dangling symlink): {e}")
                })?;
                if !canon_ancestor.starts_with(canonical_root) {
                    return Err(format!(
                        "Path '{raw_target}' resolves outside workspace root '{}'.",
                        canonical_root.display()
                    ));
                }
                if !missing_tail.is_empty() && !canon_ancestor.is_dir() {
                    return Err(format!(
                        "Ancestor '{}' of path '{raw_target}' is not a directory.",
                        canon_ancestor.display()
                    ));
                }
                let mut resolved = canon_ancestor;
                for seg in missing_tail.into_iter().rev() {
                    resolved.push(seg);
                }
                if !resolved.starts_with(canonical_root) {
                    return Err(format!(
                        "Path '{raw_target}' escapes workspace root '{}'.",
                        canonical_root.display()
                    ));
                }
                return Ok(resolved);
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                let Some(name) = probe.file_name().map(|n| n.to_os_string()) else {
                    return Err(format!(
                        "Path '{raw_target}' is outside workspace root '{}'.",
                        canonical_root.display()
                    ));
                };
                missing_tail.push(name);
                if !probe.pop() {
                    return Err(format!(
                        "Path '{raw_target}' is outside workspace root '{}'.",
                        canonical_root.display()
                    ));
                }
            }
            Err(err) => {
                return Err(format!("Failed to inspect path '{raw_target}': {err}"));
            }
        }
    }
}

pub(crate) fn display_relative_path(canonical_root: &Path, resolved: &Path) -> String {
    let rel = resolved.strip_prefix(canonical_root).unwrap_or(resolved);
    let raw = rel.to_string_lossy().replace('\\', "/");
    let trimmed = raw.strip_prefix("//?/").unwrap_or(&raw);
    if trimmed.is_empty() {
        ".".to_string()
    } else {
        trimmed.to_string()
    }
}

pub(crate) fn should_skip_dir_name(name: &str) -> bool {
    IGNORED_DIR_NAMES.contains(&name)
}

pub(crate) fn truncate_output(text: &str, max_chars: usize, notice: &str) -> (String, bool) {
    let total_chars = text.chars().count();
    if total_chars <= max_chars {
        return (text.to_string(), false);
    }
    let keep = max_chars.saturating_sub(notice.chars().count());
    let mut cut_byte = text.len();
    for (seen, (idx, _)) in text.char_indices().enumerate() {
        if seen >= keep {
            cut_byte = idx;
            break;
        }
    }
    let prefix = text[..cut_byte].trim_end();
    (format!("{prefix}{notice}"), true)
}

pub(crate) fn required_str<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    match args.get(key) {
        Some(Value::String(s)) => Ok(s.as_str()),
        Some(Value::Null) | None => Err(format!("Missing required string argument '{key}'.")),
        Some(_) => Err(format!("Argument '{key}' must be a string.")),
    }
}

pub(crate) fn optional_str<'a>(args: &'a Value, key: &str) -> Result<Option<&'a str>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.as_str())),
        Some(_) => Err(format!("Argument '{key}' must be a string.")),
    }
}

pub(crate) fn optional_bool(args: &Value, key: &str, default: bool) -> Result<bool, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(default),
        Some(Value::Bool(b)) => Ok(*b),
        Some(_) => Err(format!("Argument '{key}' must be a boolean.")),
    }
}

pub(crate) fn optional_usize(args: &Value, key: &str) -> Result<Option<usize>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) => n
            .as_u64()
            .and_then(|v| usize::try_from(v).ok())
            .map(Some)
            .ok_or_else(|| format!("Argument '{key}' must be a non-negative integer.")),
        Some(_) => Err(format!("Argument '{key}' must be a non-negative integer.")),
    }
}

pub(crate) fn optional_u64(args: &Value, key: &str) -> Result<Option<u64>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) => n
            .as_u64()
            .map(Some)
            .ok_or_else(|| format!("Argument '{key}' must be a non-negative integer.")),
        Some(_) => Err(format!("Argument '{key}' must be a non-negative integer.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct TempWorkspace {
        path: PathBuf,
    }

    impl TempWorkspace {
        fn new(prefix: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "kite-native-tools-{prefix}-{}",
                uuid::Uuid::new_v4().simple()
            ));
            std::fs::create_dir_all(&path).expect("create temp workspace");
            Self { path }
        }

        fn write(&self, rel: &str, content: &str) {
            let full = self.path.join(rel);
            if let Some(parent) = full.parent() {
                std::fs::create_dir_all(parent).expect("create parent dirs");
            }
            std::fs::write(full, content).expect("write fixture file");
        }
    }

    impl Drop for TempWorkspace {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn definitions_expose_all_six_tools_and_unknown_tool_errors() {
        let registry = NativeToolRegistry::new();
        let defs = registry.definitions();
        let names: Vec<&str> = defs.iter().map(|d| d.name.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "read_file",
                "edit_file",
                "write_file",
                "grep_search",
                "find_files",
                "run_command",
            ]
        );
        for def in &defs {
            assert!(!def.description.trim().is_empty());
            assert_eq!(def.parameters["type"], "object");
        }

        let ws = TempWorkspace::new("unknown");
        let out = registry.execute(&ws.path, "does_not_exist", json!({}));
        assert!(!out.ok);
        assert!(out.content.contains("Unknown native tool"));
    }

    #[test]
    fn resolve_workspace_path_rejects_traversal_and_external_paths() {
        let ws = TempWorkspace::new("sandbox");
        let outside = TempWorkspace::new("outside");
        outside.write("secret.txt", "top-secret");

        assert!(resolve_workspace_path(&ws.path, "").is_err());
        assert!(resolve_workspace_path(&ws.path, "   ").is_err());
        assert!(resolve_workspace_path(&ws.path, "../outside.txt").is_err());
        assert!(resolve_workspace_path(&ws.path, "a/../../outside.txt").is_err());
        assert!(
            resolve_workspace_path(&ws.path, &outside.path.join("secret.txt").to_string_lossy())
                .is_err()
        );
        assert!(resolve_workspace_path(
            &ws.path,
            &outside.path.join("new_dir/new.txt").to_string_lossy()
        )
        .is_err());

        #[cfg(windows)]
        {
            assert!(resolve_workspace_path(&ws.path, r"\outside.txt").is_err());
            assert!(resolve_workspace_path(&ws.path, "C:outside.txt").is_err());
            assert!(resolve_workspace_path(&ws.path, "note.txt:ads").is_err());
            let verbatim_escape = format!(r"\\?\{}\..\outside.txt", ws.path.display());
            assert!(resolve_workspace_path(&ws.path, &verbatim_escape).is_err());
        }

        let rel_new = resolve_workspace_path(&ws.path, "nested/sub/new.txt")
            .expect("nested new path inside workspace must resolve");
        let canon_root = std::fs::canonicalize(&ws.path).unwrap();
        assert!(rel_new.starts_with(&canon_root));

        let abs_new = resolve_workspace_path(&ws.path, &ws.path.join("abs/new.txt").to_string_lossy())
            .expect("absolute path inside workspace must resolve");
        assert!(abs_new.starts_with(&canon_root));

        // Symlink containment check (skipped only if OS denies symlink privilege).
        let link_path = ws.path.join("escape_link");
        #[cfg(windows)]
        let link_res = std::os::windows::fs::symlink_dir(&outside.path, &link_path);
        #[cfg(unix)]
        let link_res = std::os::unix::fs::symlink(&outside.path, &link_path);

        if link_res.is_ok() {
            assert!(resolve_workspace_path(&ws.path, "escape_link").is_err());
            assert!(resolve_workspace_path(&ws.path, "escape_link/secret.txt").is_err());
            assert!(resolve_workspace_path(&ws.path, "escape_link/sub/new.txt").is_err());
        }
    }

    #[test]
    fn write_file_creates_parents_writes_appends_and_rejects_escapes() {
        let ws = TempWorkspace::new("write");
        let registry = NativeToolRegistry::new();

        let write_out = registry.execute(
            &ws.path,
            "write_file",
            json!({
                "path": "deep/folder/notes.txt",
                "content": "first line\n"
            }),
        );
        assert!(write_out.ok, "write failed: {}", write_out.content);
        assert_eq!(
            std::fs::read_to_string(ws.path.join("deep/folder/notes.txt")).unwrap(),
            "first line\n"
        );

        let append_out = registry.execute(
            &ws.path,
            "write_file",
            json!({
                "path": "deep/folder/notes.txt",
                "content": "second line\n",
                "append": true
            }),
        );
        assert!(append_out.ok, "append failed: {}", append_out.content);
        assert_eq!(
            std::fs::read_to_string(ws.path.join("deep/folder/notes.txt")).unwrap(),
            "first line\nsecond line\n"
        );

        let escape_out = registry.execute(
            &ws.path,
            "write_file",
            json!({
                "path": "../escape.txt",
                "content": "blocked"
            }),
        );
        assert!(!escape_out.ok);
    }

    #[test]
    fn read_file_handles_ranges_modes_and_large_compression() {
        let ws = TempWorkspace::new("read");
        ws.write(
            "src/sample.rs",
            "use std::fs;\n\npub struct Config {\n    pub port: u16,\n}\n\npub fn run() {\n    let x = 1;\n    println!(\"{x}\");\n}\n",
        );

        let registry = NativeToolRegistry::new();

        let range_out = registry.execute(
            &ws.path,
            "read_file",
            json!({
                "path": "src/sample.rs",
                "start_line": 3,
                "end_line": 5
            }),
        );
        assert!(range_out.ok, "range read failed: {}", range_out.content);
        assert!(!range_out.truncated);
        assert_eq!(
            range_out.content,
            "pub struct Config {\n    pub port: u16,\n}"
        );

        let bad_range = registry.execute(
            &ws.path,
            "read_file",
            json!({
                "path": "src/sample.rs",
                "start_line": 6,
                "end_line": 2
            }),
        );
        assert!(!bad_range.ok);

        let sigs = registry.execute(
            &ws.path,
            "read_file",
            json!({
                "path": "src/sample.rs",
                "mode": "signatures"
            }),
        );
        assert!(sigs.ok);
        assert!(sigs.content.contains("pub struct Config"));
        assert!(sigs.content.contains("pub fn run"));
        assert!(!sigs.content.contains("let x = 1"));

        let map = registry.execute(
            &ws.path,
            "read_file",
            json!({
                "path": "src/sample.rs",
                "mode": "map"
            }),
        );
        assert!(map.ok);
        assert!(map.content.contains("imports (1):"));
        assert!(map.content.contains("symbols:"));

        // Large repetitive content triggers kite-ctx lossless compression before truncation.
        let large_text = "repetitive diagnostic heartbeat line with steady payload\n".repeat(400);
        ws.write("large.log", &large_text);
        let large_out = registry.execute(&ws.path, "read_file", json!({ "path": "large.log" }));
        assert!(large_out.ok);
        assert!(large_out.content.contains("repeated 400 times"));
        assert!(large_out.content.len() < large_text.len());

        // Unique content exceeding MAX_EXEC_OUTPUT_CHARS is cleanly bounded with truncated = true.
        let huge_unique = (0..600)
            .map(|i| format!("unique_entry_{i:04}_abcdefghijklmnopqrstuvwxyz_0123456789\n"))
            .collect::<String>();
        ws.write("huge.txt", &huge_unique);
        let huge_out = registry.execute(&ws.path, "read_file", json!({ "path": "huge.txt" }));
        assert!(huge_out.ok);
        assert!(huge_out.truncated);
        assert!(huge_out.content.contains("read_file output truncated"));
    }

    #[test]
    fn edit_file_enforces_exact_match_and_ambiguity_guards() {
        let ws = TempWorkspace::new("edit");
        ws.write("lib.rs", "let a = foo();\nlet b = foo();\n");
        let registry = NativeToolRegistry::new();

        // Missing target fails cleanly.
        let missing = registry.execute(
            &ws.path,
            "edit_file",
            json!({
                "path": "lib.rs",
                "target": "bar()",
                "replacement": "baz()"
            }),
        );
        assert!(!missing.ok);
        assert!(missing.content.contains("not found"));

        // Ambiguous target without replace_all fails cleanly and keeps file unchanged.
        let ambiguous = registry.execute(
            &ws.path,
            "edit_file",
            json!({
                "path": "lib.rs",
                "target": "foo()",
                "replacement": "bar()"
            }),
        );
        assert!(!ambiguous.ok);
        assert!(ambiguous.content.contains("2 locations"));
        assert_eq!(
            std::fs::read_to_string(ws.path.join("lib.rs")).unwrap(),
            "let a = foo();\nlet b = foo();\n"
        );

        // Exact unique match succeeds.
        let single = registry.execute(
            &ws.path,
            "edit_file",
            json!({
                "path": "lib.rs",
                "target": "let a = foo();",
                "replacement": "let a = unique_call();"
            }),
        );
        assert!(single.ok);
        assert_eq!(
            std::fs::read_to_string(ws.path.join("lib.rs")).unwrap(),
            "let a = unique_call();\nlet b = foo();\n"
        );

        // replace_all updates multiple occurrences.
        ws.write("multi.txt", "tag\nkeep\ntag\n");
        let all = registry.execute(
            &ws.path,
            "edit_file",
            json!({
                "path": "multi.txt",
                "target": "tag",
                "replacement": "done",
                "replace_all": true
            }),
        );
        assert!(all.ok);
        assert_eq!(
            std::fs::read_to_string(ws.path.join("multi.txt")).unwrap(),
            "done\nkeep\ndone\n"
        );
    }

    #[test]
    fn grep_search_and_find_files_skip_ignored_dirs_and_respect_bounds() {
        let ws = TempWorkspace::new("search");
        ws.write("src/main.rs", "fn main() { println!(\"NeedleOne\"); }\n");
        ws.write("src/nested/helper.rs", "pub fn helper() { let x = \"needle_two\"; }\n");
        ws.write("README.md", "Project docs\n");
        ws.write(".git/config", "needle_ignored_git\n");
        ws.write("node_modules/pkg/index.js", "needle_ignored_nm\n");
        ws.write("target/debug/out.txt", "needle_ignored_target\n");

        let registry = NativeToolRegistry::new();

        let grep_ci = registry.execute(
            &ws.path,
            "grep_search",
            json!({
                "pattern": "needle",
                "case_insensitive": true
            }),
        );
        assert!(grep_ci.ok, "grep failed: {}", grep_ci.content);
        assert!(grep_ci.content.contains("src/main.rs:1:"));
        assert!(grep_ci.content.contains("src/nested/helper.rs:1:"));
        assert!(!grep_ci.content.contains(".git"));
        assert!(!grep_ci.content.contains("node_modules"));
        assert!(!grep_ci.content.contains("target/"));

        let grep_limited = registry.execute(
            &ws.path,
            "grep_search",
            json!({
                "pattern": "needle",
                "case_insensitive": true,
                "max_results": 1
            }),
        );
        assert!(grep_limited.ok);
        assert!(grep_limited.truncated);

        let grep_escape = registry.execute(
            &ws.path,
            "grep_search",
            json!({
                "pattern": "secret",
                "path": "../outside"
            }),
        );
        assert!(!grep_escape.ok);

        let found_rs = registry.execute(
            &ws.path,
            "find_files",
            json!({
                "pattern": "*.rs"
            }),
        );
        assert!(found_rs.ok);
        assert!(found_rs.content.contains("src/main.rs"));
        assert!(found_rs.content.contains("src/nested/helper.rs"));
        assert!(!found_rs.content.contains("README.md"));
        assert!(!found_rs.content.contains("node_modules"));
        assert!(!found_rs.content.contains("target/"));

        let found_limited = registry.execute(
            &ws.path,
            "find_files",
            json!({
                "max_results": 1
            }),
        );
        assert!(found_limited.ok);
        assert!(found_limited.truncated);

        let find_exact = registry.execute(
            &ws.path,
            "find_files",
            json!({
                "pattern": "src/**/*.rs",
                "max_results": 10
            }),
        );
        assert!(find_exact.ok);
        assert!(!find_exact.truncated);
        assert!(find_exact.content.contains("src/main.rs"));
        assert!(find_exact.content.contains("src/nested/helper.rs"));

        let find_escape = registry.execute(
            &ws.path,
            "find_files",
            json!({
                "path": "../outside"
            }),
        );
        assert!(!find_escape.ok);
    }

    #[test]
    fn run_command_executes_in_workspace_validates_dir_and_enforces_timeouts() {
        let ws = TempWorkspace::new("shell");
        ws.write("sub/marker.txt", "inside-sub\n");
        let registry = NativeToolRegistry::new();

        let ok_out = registry.execute(
            &ws.path,
            "run_command",
            json!({
                "command": "echo kite-shell-ok"
            }),
        );
        assert!(ok_out.ok, "run_command failed: {}", ok_out.content);
        assert!(ok_out.content.contains("kite-shell-ok"));

        #[cfg(windows)]
        let check_dir_cmd = "Get-Content marker.txt";
        #[cfg(not(windows))]
        let check_dir_cmd = "cat marker.txt";

        let dir_out = registry.execute(
            &ws.path,
            "run_command",
            json!({
                "command": check_dir_cmd,
                "working_dir": "sub"
            }),
        );
        assert!(dir_out.ok, "working_dir command failed: {}", dir_out.content);
        assert!(dir_out.content.contains("inside-sub"));

        let escape_dir = registry.execute(
            &ws.path,
            "run_command",
            json!({
                "command": "echo should-not-run",
                "working_dir": "../outside"
            }),
        );
        assert!(!escape_dir.ok);

        let fail_out = registry.execute(
            &ws.path,
            "run_command",
            json!({
                "command": "exit 7"
            }),
        );
        assert!(!fail_out.ok);
        assert!(fail_out.content.contains("7"));

        #[cfg(windows)]
        let noisy_cmd = "1..25 | ForEach-Object { Write-Output 'steady_heartbeat_row_for_compression' }";
        #[cfg(not(windows))]
        let noisy_cmd = "i=1; while [ $i -le 25 ]; do echo steady_heartbeat_row_for_compression; i=$((i+1)); done";

        let noisy_out = registry.execute(
            &ws.path,
            "run_command",
            json!({
                "command": noisy_cmd
            }),
        );
        assert!(noisy_out.ok, "noisy command failed: {}", noisy_out.content);
        assert!(noisy_out.content.contains("repeated 25 times"));

        #[cfg(windows)]
        let sleep_cmd = "Start-Sleep -Seconds 10";
        #[cfg(not(windows))]
        let sleep_cmd = "sleep 10";

        let timeout_out = registry.execute(
            &ws.path,
            "run_command",
            json!({
                "command": sleep_cmd,
                "timeout_secs": 1
            }),
        );
        assert!(!timeout_out.ok);
        assert!(timeout_out.content.to_ascii_lowercase().contains("timed out"));
    }
}
