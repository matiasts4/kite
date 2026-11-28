//! Workspace-sandboxed shell command execution (`run_command`) via `hidden_exec` + `kite-ctx`.

use std::path::{Path, PathBuf};
use std::time::Duration;

use kite_ctx::{filter_command_output, MAX_EXEC_OUTPUT_CHARS};
use serde_json::{json, Value};

use crate::hidden_exec;
use crate::native_agent::types::NativeToolDef;

use super::{
    canonical_workspace_root, optional_str, optional_u64, required_str, resolve_workspace_path,
    truncate_output, ToolOutput,
};

const DEFAULT_TIMEOUT_SECS: u64 = 30;
const MAX_TIMEOUT_SECS: u64 = 120;

pub fn run_command_def() -> NativeToolDef {
    NativeToolDef {
        name: "run_command".to_string(),
        description: "Run a shell command inside the workspace root (or an optional workspace-contained working_dir) with bounded timeout (<= 120s) and compressed stdout/stderr.".to_string(),
        parameters: json!({
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "Shell command line to execute."
                },
                "timeout_secs": {
                    "type": "integer",
                    "description": "Optional timeout in seconds (default 30, max 120)."
                },
                "working_dir": {
                    "type": "string",
                    "description": "Optional workspace-relative or workspace-contained working directory."
                }
            },
            "required": ["command"]
        }),
    }
}

fn normalize_exec_cwd(canonical_dir: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let s = canonical_dir.to_string_lossy();
        if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            let unc = PathBuf::from(format!(r"\\{rest}"));
            if unc.as_os_str().len() < 248 {
                return unc;
            }
        } else if let Some(rest) = s.strip_prefix(r"\\?\") {
            let plain = PathBuf::from(rest);
            if plain.as_os_str().len() < 248 {
                return plain;
            }
        }
    }
    canonical_dir.to_path_buf()
}

fn has_shell_operators(command: &str) -> bool {
    command.contains(['|', '&', ';', '>', '<', '\n', '\r', '`'])
}

fn tokenize_simple_command(command: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut chars = command.chars();

    while let Some(ch) = chars.next() {
        match quote {
            Some(q) if ch == q => quote = None,
            Some('\\') if quote == Some('"') => {
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            }
            Some(_) => current.push(ch),
            None if ch == '\'' || ch == '"' => quote = Some(ch),
            None if ch.is_whitespace() => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            None => current.push(ch),
        }
    }

    if quote.is_some() {
        return Vec::new();
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

fn build_filter_tokens(shell_name: &str, command: &str) -> Vec<String> {
    if !has_shell_operators(command) {
        let simple = tokenize_simple_command(command);
        if !simple.is_empty() {
            return simple;
        }
    }
    vec![shell_name.to_string(), command.to_string()]
}

pub fn execute_run_command(workspace_root: &Path, args: &Value) -> ToolOutput {
    let command = match required_str(args, "command") {
        Ok(c) => c,
        Err(e) => return ToolOutput::error(e),
    };
    if command.trim().is_empty() {
        return ToolOutput::error("run_command 'command' must not be empty.");
    }

    let timeout_secs = match optional_u64(args, "timeout_secs") {
        Ok(v) => v.unwrap_or(DEFAULT_TIMEOUT_SECS).clamp(1, MAX_TIMEOUT_SECS),
        Err(e) => return ToolOutput::error(e),
    };

    let working_dir_raw = match optional_str(args, "working_dir") {
        Ok(d) => d,
        Err(e) => return ToolOutput::error(e),
    };

    let canonical_cwd = match working_dir_raw {
        Some(dir) => match resolve_workspace_path(workspace_root, dir) {
            Ok(resolved) => {
                if !resolved.is_dir() {
                    return ToolOutput::error(format!(
                        "working_dir '{}' is not an existing directory.",
                        resolved.display()
                    ));
                }
                resolved
            }
            Err(e) => return ToolOutput::error(e),
        },
        None => match canonical_workspace_root(workspace_root) {
            Ok(root) => root,
            Err(e) => return ToolOutput::error(e),
        },
    };

    let exec_cwd = normalize_exec_cwd(&canonical_cwd);

    #[cfg(windows)]
    let (shell_bin, shell_args): (&str, [&str; 4]) = (
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", command],
    );
    #[cfg(not(windows))]
    let (shell_bin, shell_args): (&str, [&str; 2]) = ("/bin/sh", ["-c", command]);

    let output = match hidden_exec::run_in_dir(
        Path::new(shell_bin),
        &shell_args,
        Some(&exec_cwd),
        Duration::from_secs(timeout_secs),
    ) {
        Ok(out) => out,
        Err(e) => return ToolOutput::error(format!("Failed to execute command: {e}")),
    };

    let filter_tokens = build_filter_tokens(shell_bin, command);
    let stdout = output.stdout_lossy();
    let stderr = output.stderr_lossy();
    let exit_code = output.code.unwrap_or(-1);
    let filtered = filter_command_output(&filter_tokens, &stdout, &stderr, exit_code);

    let (bounded, truncated) = truncate_output(
        filtered.text.trim_end(),
        MAX_EXEC_OUTPUT_CHARS,
        "\n... [command output truncated]",
    );

    if output.timed_out {
        let msg = if bounded.is_empty() {
            format!("Command timed out after {timeout_secs}s.")
        } else {
            format!("Command timed out after {timeout_secs}s.\n{bounded}")
        };
        return ToolOutput {
            ok: false,
            content: msg,
            truncated,
        };
    }

    if output.success() {
        let content = if bounded.is_empty() {
            "(command exited with code 0; no output)".to_string()
        } else {
            bounded
        };
        ToolOutput::success(content, truncated)
    } else {
        let msg = if bounded.is_empty() {
            format!("Command exited with code {exit_code}.")
        } else {
            format!("Command exited with code {exit_code}.\n{bounded}")
        };
        ToolOutput {
            ok: false,
            content: msg,
            truncated,
        }
    }
}
