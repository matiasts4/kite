//! Workspace-contained filesystem tools (`read_file`, `edit_file`, `write_file`).

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;

use kite_ctx::lossless::compact_lossless;
use kite_ctx::read_cache::{extract_map, extract_signatures};
use kite_ctx::{ContentKind, MAX_EXEC_OUTPUT_CHARS};
use serde_json::{json, Value};

use crate::native_agent::types::NativeToolDef;

use super::{
    canonical_workspace_root, display_relative_path, optional_bool, optional_str, optional_usize,
    required_str, resolve_workspace_path, truncate_output, ToolOutput,
};

const MAX_FILE_READ_BYTES: u64 = 8 * 1024 * 1024;
const LARGE_READ_COMPRESS_THRESHOLD: usize = 4_096;
const MAX_READ_OUTPUT_CHARS: usize = MAX_EXEC_OUTPUT_CHARS;

pub fn read_file_def() -> NativeToolDef {
    NativeToolDef {
        name: "read_file".to_string(),
        description: "Read a UTF-8 file inside the workspace, optionally slicing a 1-based inclusive line range or extracting structural signatures/module maps.".to_string(),
        parameters: json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Workspace-relative or workspace-contained file path."
                },
                "start_line": {
                    "type": "integer",
                    "description": "Optional 1-based starting line number."
                },
                "end_line": {
                    "type": "integer",
                    "description": "Optional 1-based inclusive ending line number."
                },
                "mode": {
                    "type": "string",
                    "enum": ["full", "signatures", "map"],
                    "description": "Optional read mode: 'full' (default), 'signatures', or 'map'."
                }
            },
            "required": ["path"]
        }),
    }
}

pub fn edit_file_def() -> NativeToolDef {
    NativeToolDef {
        name: "edit_file".to_string(),
        description: "Replace exact text inside a workspace file. Fails if target is missing or ambiguous unless replace_all is true.".to_string(),
        parameters: json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Workspace-relative or workspace-contained file path."
                },
                "target": {
                    "type": "string",
                    "description": "Exact existing text block to replace."
                },
                "replacement": {
                    "type": "string",
                    "description": "Replacement text."
                },
                "replace_all": {
                    "type": "boolean",
                    "description": "When true, replace every exact occurrence instead of requiring a unique match."
                }
            },
            "required": ["path", "target", "replacement"]
        }),
    }
}

pub fn write_file_def() -> NativeToolDef {
    NativeToolDef {
        name: "write_file".to_string(),
        description: "Create, overwrite, or append to a UTF-8 file inside the workspace, automatically creating missing parent directories.".to_string(),
        parameters: json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Workspace-relative or workspace-contained file path."
                },
                "content": {
                    "type": "string",
                    "description": "Text content to write or append."
                },
                "append": {
                    "type": "boolean",
                    "description": "Append to existing content instead of overwriting (default false)."
                }
            },
            "required": ["path", "content"]
        }),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReadFileMode {
    Full,
    Signatures,
    Map,
}

impl ReadFileMode {
    fn parse(raw: Option<&str>) -> Result<Self, String> {
        match raw.map(str::trim).filter(|s| !s.is_empty()) {
            None => Ok(Self::Full),
            Some(v) if v.eq_ignore_ascii_case("full") => Ok(Self::Full),
            Some(v) if v.eq_ignore_ascii_case("signatures") => Ok(Self::Signatures),
            Some(v) if v.eq_ignore_ascii_case("map") => Ok(Self::Map),
            Some(other) => Err(format!(
                "Unsupported read_file mode '{other}'; expected 'full', 'signatures', or 'map'."
            )),
        }
    }
}

fn read_utf8_file(resolved: &Path, display_path: &str) -> Result<String, String> {
    let meta = fs::metadata(resolved)
        .map_err(|e| format!("Cannot access file '{display_path}': {e}"))?;
    if meta.is_dir() {
        return Err(format!("Path '{display_path}' is a directory, not a file."));
    }
    if meta.len() > MAX_FILE_READ_BYTES {
        return Err(format!(
            "File '{display_path}' ({} bytes) exceeds max safe read limit ({MAX_FILE_READ_BYTES} bytes).",
            meta.len()
        ));
    }
    let bytes = fs::read(resolved)
        .map_err(|e| format!("Failed to read file '{display_path}': {e}"))?;
    if bytes.iter().take(8192).any(|&b| b == 0) {
        return Err(format!("Cannot read binary file '{display_path}'."));
    }
    String::from_utf8(bytes)
        .map_err(|_| format!("File '{display_path}' is not valid UTF-8 text."))
}

pub fn execute_read_file(workspace_root: &Path, args: &Value) -> ToolOutput {
    let raw_path = match required_str(args, "path") {
        Ok(p) => p,
        Err(e) => return ToolOutput::error(e),
    };
    let start_line = match optional_usize(args, "start_line") {
        Ok(v) => v,
        Err(e) => return ToolOutput::error(e),
    };
    let end_line = match optional_usize(args, "end_line") {
        Ok(v) => v,
        Err(e) => return ToolOutput::error(e),
    };
    let mode = match optional_str(args, "mode").and_then(ReadFileMode::parse) {
        Ok(m) => m,
        Err(e) => return ToolOutput::error(e),
    };

    if matches!(start_line, Some(0)) || matches!(end_line, Some(0)) {
        return ToolOutput::error("start_line and end_line must be >= 1.");
    }
    if let (Some(start), Some(end)) = (start_line, end_line) {
        if end < start {
            return ToolOutput::error("end_line must be >= start_line.");
        }
    }

    let canonical_root = match canonical_workspace_root(workspace_root) {
        Ok(r) => r,
        Err(e) => return ToolOutput::error(e),
    };
    let resolved = match resolve_workspace_path(workspace_root, raw_path) {
        Ok(p) => p,
        Err(e) => return ToolOutput::error(e),
    };
    let rel_display = display_relative_path(&canonical_root, &resolved);

    let text = match read_utf8_file(&resolved, &rel_display) {
        Ok(t) => t,
        Err(e) => return ToolOutput::error(e),
    };

    let view = match mode {
        ReadFileMode::Signatures => extract_signatures(&rel_display, &text),
        ReadFileMode::Map => extract_map(&rel_display, &text),
        ReadFileMode::Full => {
            if start_line.is_some() || end_line.is_some() {
                let lines: Vec<&str> = text.lines().collect();
                if lines.is_empty() {
                    String::new()
                } else {
                    let start = start_line.unwrap_or(1);
                    if start > lines.len() {
                        return ToolOutput::success(
                            format!(
                                "[start_line {start} exceeds file length ({} lines)]",
                                lines.len()
                            ),
                            false,
                        );
                    }
                    let end = end_line.unwrap_or(lines.len()).min(lines.len());
                    lines[start - 1..end].join("\n")
                }
            } else {
                text
            }
        }
    };

    let compacted = if view.len() > LARGE_READ_COMPRESS_THRESHOLD {
        compact_lossless(&view, ContentKind::Text)
    } else {
        view
    };

    let (bounded, truncated) = truncate_output(
        &compacted,
        MAX_READ_OUTPUT_CHARS,
        "\n... [read_file output truncated; pass start_line/end_line or mode='map'/'signatures']",
    );
    ToolOutput::success(bounded, truncated)
}

pub fn execute_edit_file(workspace_root: &Path, args: &Value) -> ToolOutput {
    let raw_path = match required_str(args, "path") {
        Ok(p) => p,
        Err(e) => return ToolOutput::error(e),
    };
    let target = match required_str(args, "target") {
        Ok(t) => t,
        Err(e) => return ToolOutput::error(e),
    };
    let replacement = match required_str(args, "replacement") {
        Ok(r) => r,
        Err(e) => return ToolOutput::error(e),
    };
    let replace_all = match optional_bool(args, "replace_all", false) {
        Ok(b) => b,
        Err(e) => return ToolOutput::error(e),
    };

    if target.is_empty() {
        return ToolOutput::error("edit_file 'target' must not be empty.");
    }

    let canonical_root = match canonical_workspace_root(workspace_root) {
        Ok(r) => r,
        Err(e) => return ToolOutput::error(e),
    };
    let resolved = match resolve_workspace_path(workspace_root, raw_path) {
        Ok(p) => p,
        Err(e) => return ToolOutput::error(e),
    };
    let rel_display = display_relative_path(&canonical_root, &resolved);

    let content = match read_utf8_file(&resolved, &rel_display) {
        Ok(t) => t,
        Err(e) => return ToolOutput::error(e),
    };

    let match_count = content.matches(target).count();
    if match_count == 0 {
        return ToolOutput::error(format!("Target text not found in '{rel_display}'."));
    }
    if match_count > 1 && !replace_all {
        return ToolOutput::error(format!(
            "Target text matched {match_count} locations in '{rel_display}'; provide more context or set replace_all=true."
        ));
    }

    let updated = if replace_all {
        content.replace(target, replacement)
    } else {
        content.replacen(target, replacement, 1)
    };

    if let Err(e) = fs::write(&resolved, updated.as_bytes()) {
        return ToolOutput::error(format!("Failed to write '{rel_display}': {e}"));
    }

    let suffix = if match_count == 1 { "" } else { "s" };
    ToolOutput::success(
        format!("Edited '{rel_display}' ({match_count} replacement{suffix})."),
        false,
    )
}

pub fn execute_write_file(workspace_root: &Path, args: &Value) -> ToolOutput {
    let raw_path = match required_str(args, "path") {
        Ok(p) => p,
        Err(e) => return ToolOutput::error(e),
    };
    let content = match required_str(args, "content") {
        Ok(c) => c,
        Err(e) => return ToolOutput::error(e),
    };
    let append = match optional_bool(args, "append", false) {
        Ok(b) => b,
        Err(e) => return ToolOutput::error(e),
    };

    let canonical_root = match canonical_workspace_root(workspace_root) {
        Ok(r) => r,
        Err(e) => return ToolOutput::error(e),
    };
    let resolved = match resolve_workspace_path(workspace_root, raw_path) {
        Ok(p) => p,
        Err(e) => return ToolOutput::error(e),
    };
    let rel_display = display_relative_path(&canonical_root, &resolved);

    if resolved == canonical_root || resolved.is_dir() {
        return ToolOutput::error(format!(
            "Cannot write_file to directory '{rel_display}'."
        ));
    }

    if let Some(parent) = resolved.parent() {
        if !parent.starts_with(&canonical_root) {
            return ToolOutput::error("Parent directory escapes workspace root.");
        }
        if !parent.exists() {
            if let Err(e) = fs::create_dir_all(parent) {
                return ToolOutput::error(format!(
                    "Failed to create parent directories for '{rel_display}': {e}"
                ));
            }
        }
        match fs::canonicalize(parent) {
            Ok(canon_parent) if canon_parent.starts_with(&canonical_root) => {}
            Ok(_) => return ToolOutput::error("Parent directory resolved outside workspace root."),
            Err(e) => {
                return ToolOutput::error(format!(
                    "Failed to verify parent directory for '{rel_display}': {e}"
                ))
            }
        }
    }

    if append {
        let mut file = match OpenOptions::new().create(true).append(true).open(&resolved) {
            Ok(f) => f,
            Err(e) => {
                return ToolOutput::error(format!(
                    "Failed to open '{rel_display}' for append: {e}"
                ))
            }
        };
        if let Err(e) = file.write_all(content.as_bytes()) {
            return ToolOutput::error(format!("Failed to append to '{rel_display}': {e}"));
        }
        ToolOutput::success(
            format!("Appended {} bytes to '{rel_display}'.", content.len()),
            false,
        )
    } else {
        if let Err(e) = fs::write(&resolved, content.as_bytes()) {
            return ToolOutput::error(format!("Failed to write '{rel_display}': {e}"));
        }
        ToolOutput::success(
            format!("Wrote {} bytes to '{rel_display}'.", content.len()),
            false,
        )
    }
}
