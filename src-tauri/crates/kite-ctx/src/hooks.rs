use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{CtxError, Result};

/// Supported coding-agent targets for non-destructive hook, plugin, and rule installation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentTarget {
    Claude,
    Antigravity,
    Cursor,
    Codex,
    Gemini,
    OpenCode,
    Grok,
    Copilot,
    Agents,
    All,
}

impl AgentTarget {
    pub fn parse(raw: &str) -> Result<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "claude" | "claude-code" => Ok(Self::Claude),
            "antigravity" | "agy" => Ok(Self::Antigravity),
            "cursor" => Ok(Self::Cursor),
            "codex" => Ok(Self::Codex),
            "gemini" | "gemini-cli" => Ok(Self::Gemini),
            "opencode" | "open-code" => Ok(Self::OpenCode),
            "grok" => Ok(Self::Grok),
            "copilot" | "github-copilot" => Ok(Self::Copilot),
            "agents" => Ok(Self::Agents),
            "all" | "auto" => Ok(Self::All),
            other => Err(CtxError::InvalidInput(format!(
                "unknown agent target '{other}' (expected claude|antigravity|cursor|codex|gemini|opencode|grok|copilot|agents|all)"
            ))),
        }
    }
}

/// Outcome per agent configuration surface after `init` or `--check`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HookInstallAction {
    pub target: String,
    pub path: String,
    pub status: String,
}

pub const KITE_CTX_INSTRUCTION: &str = r#"<!-- kite-ctx:start -->
## Kite Context Engine (`kite ctx`)

Use `kite ctx` to minimize redundant file reads and noisy terminal outputs across sessions:
- Prefer `kite ctx read <path> --mode signatures|map|diff|lines:N-M` when surveying files; repeated unchanged reads inside a session return compact cache stubs automatically.
- Wrap noisy build, test, lint, search, or git commands with `kite ctx exec -- <command>` to filter redundant logs while keeping all failures and exit codes intact.
- When retrieving truncated `<<ccr:HASH>>` blocks, run `kite ctx retrieve <hash> [--lines N-M] [--search <term>]`.
- Share compressed agent handoffs with `kite ctx share put <key>` and `kite ctx share get <key> [--full]`.
- Inspect live token savings with `kite ctx stats [--json]` and audit missed command optimizations with `kite ctx discover`.
<!-- kite-ctx:end -->"#;

pub const OPENCODE_PLUGIN_TS: &str = r#"// kite-ctx OpenCode plugin — automatically rewrites eligible shell commands through `kite ctx exec`.
import { execFileSync } from "node:child_process";

function rewriteCommand(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const out = execFileSync(
      "kite",
      ["ctx", "hook-rewrite", "--agent", "opencode", "--command", raw],
      { encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "ignore"] }
    );
    const parsed = JSON.parse(out.trim() || "{}");
    if (typeof parsed.command === "string" && parsed.command.trim() && parsed.command !== raw) {
      return parsed.command;
    }
  } catch {
    // Fail-open passthrough
  }
  return null;
}

export default {
  id: "kite-ctx",
  name: "Kite Context Engine",
  async server() {
    return {
      "tool.execute.before": async (input: any, output: any) => {
        const tool = String(input?.tool ?? input?.name ?? "").toLowerCase();
        if (tool !== "bash" && tool !== "shell") return;
        const args = output?.args ?? input?.args;
        if (!args || typeof args.command !== "string") return;
        const rewritten = rewriteCommand(args.command);
        if (rewritten) {
          args.command = rewritten;
        }
      },
    };
  },
  setup(ctx: any) {
    if (ctx?.tool?.hook) {
      ctx.tool.hook("execute.before", async (event: any) => {
        const tool = String(event?.tool ?? event?.name ?? "").toLowerCase();
        if (tool !== "bash" && tool !== "shell") return;
        const args = event?.args;
        if (!args || typeof args.command !== "string") return;
        const rewritten = rewriteCommand(args.command);
        if (rewritten) {
          args.command = rewritten;
        }
      });
    }
  },
};
"#;

/// Rewrite a shell command (including top-level `&&` and `;` compound chains)
/// if any segment is eligible for `kite ctx exec`.
pub fn rewrite_hook_command(command: &str) -> Option<String> {
    let trimmed = command.trim();
    if trimmed.is_empty() || trimmed.contains('\n') || trimmed.contains('\r') {
        return None;
    }

    let segments = split_shell_chain(trimmed)?;
    let mut rewritten_any = false;
    let mut out = String::with_capacity(trimmed.len() + 32);

    for (idx, (segment, sep_after)) in segments.iter().enumerate() {
        if idx > 0 {
            // Separator was already appended after previous segment
        }
        if let Some(rewritten_seg) = rewrite_single_segment(segment) {
            out.push_str(&rewritten_seg);
            rewritten_any = true;
        } else {
            out.push_str(segment.trim());
        }
        if !sep_after.is_empty() {
            if *sep_after == "&&" {
                out.push_str(" && ");
            } else if *sep_after == ";" {
                out.push_str("; ");
            }
        }
    }

    if rewritten_any {
        Some(out)
    } else {
        None
    }
}

/// Split a shell command on top-level `&&` and `;` outside quotes.
/// Returns `None` if unsafe shell operators (`|`, `||`, `>`, `<`, `$(`, backticks) appear outside quotes.
fn split_shell_chain(command: &str) -> Option<Vec<(String, &'static str)>> {
    let bytes = command.as_bytes();
    let len = bytes.len();
    let mut i = 0;
    let mut in_single = false;
    let mut in_double = false;
    let mut seg_start = 0;
    let mut out: Vec<(String, &'static str)> = Vec::new();

    while i < len {
        let b = bytes[i];
        if b == b'\\' && !in_single && i + 1 < len {
            i += 2;
            continue;
        }
        if b == b'\'' && !in_double {
            in_single = !in_single;
            i += 1;
            continue;
        }
        if b == b'"' && !in_single {
            in_double = !in_double;
            i += 1;
            continue;
        }

        if !in_single && !in_double {
            // Reject unsafe operators outside quotes
            if b == b'>' || b == b'<' || b == b'`' {
                return None;
            }
            if b == b'$' && i + 1 < len && bytes[i + 1] == b'(' {
                return None;
            }
            if b == b'|' {
                return None;
            }
            if b == b'&' {
                if i + 1 < len && bytes[i + 1] == b'&' {
                    let seg = command[seg_start..i].trim().to_string();
                    if seg.is_empty() {
                        return None;
                    }
                    out.push((seg, "&&"));
                    i += 2;
                    seg_start = i;
                    continue;
                } else {
                    // Background `&` or `2>&1`
                    return None;
                }
            }
            if b == b';' {
                let seg = command[seg_start..i].trim().to_string();
                if !seg.is_empty() {
                    out.push((seg, ";"));
                }
                i += 1;
                seg_start = i;
                continue;
            }
        }
        i += 1;
    }

    if in_single || in_double {
        return None;
    }

    let tail = command[seg_start..].trim().to_string();
    if !tail.is_empty() {
        out.push((tail, ""));
    } else if let Some(last) = out.last_mut() {
        last.1 = "";
    }

    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn rewrite_single_segment(segment: &str) -> Option<String> {
    let trimmed = segment.trim();
    if trimmed.is_empty()
        || trimmed.starts_with("kite ")
        || trimmed.starts_with("kite.exe ")
        || trimmed.contains("kite ctx ")
    {
        return None;
    }

    let mut words = trimmed.split_whitespace();
    let first_word = words.next()?;
    let second_word = words.next().unwrap_or("");

    // Skip git interactive/commit mutations
    if first_word == "git" && matches!(second_word, "commit" | "rebase" | "merge" | "add" | "checkout" | "switch" | "reset" | "clean") {
        return None;
    }

    let eligible = matches!(
        first_word,
        "git" | "cargo" | "vitest" | "jest" | "tsc" | "pytest" | "ruff" | "mypy" | "rg" | "grep" | "tree"
    ) || ((first_word == "npx"
        || first_word == "npm"
        || first_word == "pnpm"
        || first_word == "yarn"
        || first_word == "bun")
        && (trimmed.contains("test")
            || trimmed.contains("vitest")
            || trimmed.contains("jest")
            || trimmed.contains("tsc")
            || trimmed.contains("lint")
            || trimmed.contains("typecheck")));

    if eligible {
        Some(format!("kite ctx exec -- {trimmed}"))
    } else {
        None
    }
}

/// Evaluate a hook event for any supported coding agent (`Claude`, `Antigravity`, `Codex`,
/// `Gemini`, `Cursor`, `OpenCode`, `Copilot`) and return the protocol-specific stdout JSON.
pub fn evaluate_hook_input(
    agent_hint: Option<AgentTarget>,
    stdin_json: &str,
    command_override: Option<&str>,
) -> Option<String> {
    if let Some(raw_cmd) = command_override {
        if let Some(rewritten) = rewrite_hook_command(raw_cmd) {
            return Some(json!({ "command": rewritten }).to_string());
        }
        return Some("{}".to_string());
    }

    let cleaned = stdin_json.trim_start_matches('\u{feff}').trim();
    if cleaned.is_empty() {
        return fail_open_response(agent_hint);
    }

    let Ok(parsed) = serde_json::from_str::<Value>(cleaned) else {
        return fail_open_response(agent_hint);
    };

    // 1. Antigravity plugin protocol: `{"toolCall": {"name": "run_command", "args": {"CommandLine": "..."}}}`
    if agent_hint == Some(AgentTarget::Antigravity) || parsed.get("toolCall").is_some() {
        return evaluate_antigravity_hook(&parsed);
    }

    // 2. Copilot camelCase protocol: `{"toolName": "bash", "toolArgs": "{\"command\":\"...\"}"}`
    if parsed.get("toolName").is_some() || parsed.get("toolArgs").is_some() {
        return evaluate_copilot_camel_hook(&parsed);
    }

    let event_name = parsed
        .get("hook_event_name")
        .or_else(|| parsed.get("hookEventName"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let tool_name = parsed
        .get("tool_name")
        .and_then(Value::as_str)
        .unwrap_or("");

    // 3. Gemini CLI BeforeTool protocol: `{"tool_name": "run_shell_command", "tool_input": {"command": "..."}}`
    if agent_hint == Some(AgentTarget::Gemini)
        || event_name == "BeforeTool"
        || tool_name == "run_shell_command"
    {
        return evaluate_gemini_hook(&parsed);
    }

    // 4. Cursor preToolUse protocol: `{"hook_event_name": "preToolUse", "tool_input": {"command": "..."}}`
    if agent_hint == Some(AgentTarget::Cursor)
        || event_name == "preToolUse"
        || tool_name == "Shell"
    {
        return evaluate_cursor_hook(&parsed);
    }

    // 5. Claude Code / Codex / Copilot PascalCase PreToolUse protocol
    evaluate_claude_or_codex_hook(&parsed)
}

fn fail_open_response(agent_hint: Option<AgentTarget>) -> Option<String> {
    match agent_hint {
        Some(AgentTarget::Antigravity) | Some(AgentTarget::Gemini) => {
            Some(r#"{"decision":"allow"}"#.to_string())
        }
        Some(AgentTarget::Cursor) | Some(AgentTarget::OpenCode) => Some("{}".to_string()),
        _ => None,
    }
}

fn evaluate_antigravity_hook(parsed: &Value) -> Option<String> {
    let Some(tool_call) = parsed.get("toolCall") else {
        return Some(r#"{"decision":"allow"}"#.to_string());
    };
    let name = tool_call
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("");
    if !matches!(name, "run_command" | "Bash" | "bash" | "PowerShell") {
        return Some(r#"{"decision":"allow"}"#.to_string());
    }
    let Some(args) = tool_call.get("args") else {
        return Some(r#"{"decision":"allow"}"#.to_string());
    };
    let (cmd_key, cmd_val) = if let Some(c) = args.get("CommandLine").and_then(Value::as_str) {
        ("CommandLine", c)
    } else if let Some(c) = args.get("command").and_then(Value::as_str) {
        ("command", c)
    } else {
        return Some(r#"{"decision":"allow"}"#.to_string());
    };

    let Some(rewritten) = rewrite_hook_command(cmd_val) else {
        return Some(r#"{"decision":"allow"}"#.to_string());
    };

    let mut overwrite = args.clone();
    if let Some(obj) = overwrite.as_object_mut() {
        obj.insert(cmd_key.to_string(), Value::String(rewritten));
    }

    Some(
        json!({
            "decision": "allow",
            "reason": "Rewritten by kite-ctx for token optimization.",
            "overwrite": overwrite
        })
        .to_string(),
    )
}

fn evaluate_gemini_hook(parsed: &Value) -> Option<String> {
    let tool = parsed
        .get("tool_name")
        .and_then(Value::as_str)
        .unwrap_or("run_shell_command");
    if !matches!(tool, "run_shell_command" | "Bash" | "bash" | "shell") {
        return Some(r#"{"decision":"allow"}"#.to_string());
    }
    let Some(input) = parsed.get("tool_input") else {
        return Some(r#"{"decision":"allow"}"#.to_string());
    };
    let Some(cmd) = input.get("command").and_then(Value::as_str) else {
        return Some(r#"{"decision":"allow"}"#.to_string());
    };
    let Some(rewritten) = rewrite_hook_command(cmd) else {
        return Some(r#"{"decision":"allow"}"#.to_string());
    };
    let mut updated_input = input.clone();
    if let Some(obj) = updated_input.as_object_mut() {
        obj.insert("command".to_string(), Value::String(rewritten));
    }
    Some(
        json!({
            "decision": "allow",
            "hookSpecificOutput": {
                "tool_input": updated_input
            }
        })
        .to_string(),
    )
}

fn evaluate_cursor_hook(parsed: &Value) -> Option<String> {
    let Some(input) = parsed.get("tool_input") else {
        return Some("{}".to_string());
    };
    let Some(cmd) = input.get("command").and_then(Value::as_str) else {
        return Some("{}".to_string());
    };
    let Some(rewritten) = rewrite_hook_command(cmd) else {
        return Some("{}".to_string());
    };
    let mut updated_input = input.clone();
    if let Some(obj) = updated_input.as_object_mut() {
        obj.insert("command".to_string(), Value::String(rewritten));
    }
    Some(
        json!({
            "continue": true,
            "permission": "allow",
            "updated_input": updated_input
        })
        .to_string(),
    )
}

fn evaluate_copilot_camel_hook(parsed: &Value) -> Option<String> {
    let tool = parsed.get("toolName").and_then(Value::as_str)?;
    if !matches!(
        tool,
        "bash" | "Bash" | "run_in_terminal" | "runTerminalCommand" | "shell"
    ) {
        return None;
    }
    let raw_args = parsed.get("toolArgs").and_then(Value::as_str)?;
    let mut args_val: Value = serde_json::from_str(raw_args).ok()?;
    let cmd = args_val.get("command").and_then(Value::as_str)?;
    let rewritten = rewrite_hook_command(cmd)?;
    if let Some(obj) = args_val.as_object_mut() {
        obj.insert("command".to_string(), Value::String(rewritten));
    }
    let modified_args = serde_json::to_string(&args_val).ok()?;
    Some(
        json!({
            "permissionDecision": "allow",
            "modifiedArgs": modified_args
        })
        .to_string(),
    )
}

fn evaluate_claude_or_codex_hook(parsed: &Value) -> Option<String> {
    let tool = parsed.get("tool_name").and_then(Value::as_str)?;
    if !matches!(
        tool,
        "Bash" | "bash" | "PowerShell" | "run_in_terminal" | "runTerminalCommand"
    ) {
        return None;
    }
    let input = parsed.get("tool_input")?;
    let cmd = input.get("command").and_then(Value::as_str)?;
    let rewritten = rewrite_hook_command(cmd)?;
    let mut updated_input = input.clone();
    if let Some(obj) = updated_input.as_object_mut() {
        obj.insert("command".to_string(), Value::String(rewritten));
    }
    Some(
        json!({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "allow",
                "updatedInput": updated_input
            }
        })
        .to_string(),
    )
}

/// Handle a `PreToolUse` JSON stdin hook event without mutating failing commands.
pub fn evaluate_pre_tool_use_json(stdin_json: &str) -> Option<String> {
    evaluate_hook_input(None, stdin_json, None)
}

/// Install or check mandatory hooks, plugins, and skill files under explicit `home_dir` and `workspace_dir`.
pub fn apply_agent_setup(
    target: AgentTarget,
    home_dir: &Path,
    workspace_dir: &Path,
    check_only: bool,
) -> Result<Vec<HookInstallAction>> {
    let mut actions = Vec::new();
    let targets = match target {
        AgentTarget::All => vec![
            AgentTarget::Claude,
            AgentTarget::Antigravity,
            AgentTarget::Cursor,
            AgentTarget::Codex,
            AgentTarget::Gemini,
            AgentTarget::OpenCode,
            AgentTarget::Grok,
            AgentTarget::Copilot,
            AgentTarget::Agents,
        ],
        single => vec![single],
    };

    let explicit_single = target != AgentTarget::All;

    for item in targets {
        match item {
            AgentTarget::Claude => {
                let claude_dir = home_dir.join(".claude");
                let settings_path = claude_dir.join("settings.json");
                let skill_path = claude_dir.join("skills").join("kite-ctx").join("SKILL.md");
                if explicit_single || claude_dir.exists() {
                    actions.push(install_claude_hook(&settings_path, check_only)?);
                    actions.push(upsert_skill_file("claude_skill", &skill_path, check_only)?);
                } else {
                    actions.push(skipped("claude", &settings_path));
                }
            }
            AgentTarget::Antigravity => {
                let agy_cli_dir = home_dir.join(".gemini").join("antigravity-cli");
                let agy_dir = home_dir.join(".gemini").join("antigravity");
                let agy_plugin_dir = home_dir
                    .join(".gemini")
                    .join("config")
                    .join("plugins")
                    .join("kite-ctx");
                let agy_cli_skill = agy_cli_dir.join("skills").join("kite-ctx").join("SKILL.md");
                let agy_skill = agy_dir.join("skills").join("kite-ctx").join("SKILL.md");
                let mut any = false;
                if agy_cli_dir.exists() {
                    actions.push(upsert_skill_file(
                        "antigravity-cli",
                        &agy_cli_skill,
                        check_only,
                    )?);
                    any = true;
                }
                if agy_dir.exists() {
                    actions.push(upsert_skill_file("antigravity", &agy_skill, check_only)?);
                    any = true;
                }
                if any || explicit_single {
                    if !any {
                        actions.push(upsert_skill_file("antigravity", &agy_skill, check_only)?);
                    }
                    actions.push(install_antigravity_plugin(&agy_plugin_dir, check_only)?);
                } else {
                    actions.push(skipped("antigravity", &agy_skill));
                }
            }
            AgentTarget::Cursor => {
                let cursor_ws_dir = workspace_dir.join(".cursor");
                let rule_path = cursor_ws_dir.join("rules").join("kite-ctx.mdc");
                let cursor_home_dir = home_dir.join(".cursor");
                let home_skill = cursor_home_dir.join("skills").join("kite-ctx").join("SKILL.md");
                let home_hooks = cursor_home_dir.join("hooks.json");
                let mut any = false;
                if explicit_single || cursor_ws_dir.exists() {
                    actions.push(upsert_skill_file("cursor", &rule_path, check_only)?);
                    any = true;
                }
                if explicit_single || cursor_home_dir.exists() {
                    actions.push(install_cursor_hook(&home_hooks, check_only)?);
                    actions.push(upsert_skill_file("cursor_skill", &home_skill, check_only)?);
                    any = true;
                }
                if !any {
                    actions.push(skipped("cursor", &rule_path));
                }
            }
            AgentTarget::Codex => {
                let codex_dir = home_dir.join(".codex");
                let hooks_path = codex_dir.join("hooks.json");
                let skill_path = codex_dir.join("skills").join("kite-ctx").join("SKILL.md");
                if explicit_single || codex_dir.exists() {
                    actions.push(install_codex_hook(&hooks_path, check_only)?);
                    actions.push(upsert_skill_file("codex", &skill_path, check_only)?);
                } else {
                    actions.push(skipped("codex", &skill_path));
                }
            }
            AgentTarget::Gemini => {
                let gemini_dir = home_dir.join(".gemini");
                let settings_path = gemini_dir.join("settings.json");
                let skill_path = gemini_dir.join("skills").join("kite-ctx").join("SKILL.md");
                if explicit_single || gemini_dir.exists() {
                    actions.push(install_gemini_hook(&settings_path, check_only)?);
                    actions.push(upsert_skill_file("gemini", &skill_path, check_only)?);
                } else {
                    actions.push(skipped("gemini", &skill_path));
                }
            }
            AgentTarget::OpenCode => {
                let oc_dir = home_dir.join(".config").join("opencode");
                let plugin_path = oc_dir.join("plugins").join("kite-ctx.ts");
                let skill_path = oc_dir.join("skills").join("kite-ctx").join("SKILL.md");
                if explicit_single || oc_dir.exists() {
                    actions.push(install_opencode_plugin(&plugin_path, check_only)?);
                    actions.push(upsert_skill_file("opencode", &skill_path, check_only)?);
                } else {
                    actions.push(skipped("opencode", &skill_path));
                }
            }
            AgentTarget::Grok => {
                let grok_dir = home_dir.join(".grok");
                let skill_path = grok_dir.join("skills").join("kite-ctx").join("SKILL.md");
                if explicit_single || grok_dir.exists() {
                    actions.push(upsert_skill_file("grok", &skill_path, check_only)?);
                } else {
                    actions.push(skipped("grok", &skill_path));
                }
            }
            AgentTarget::Copilot => {
                let copilot_dir = home_dir.join(".copilot");
                let hook_path = copilot_dir.join("hooks").join("kite-ctx.json");
                let skill_path = copilot_dir.join("skills").join("kite-ctx").join("SKILL.md");
                if explicit_single || copilot_dir.exists() {
                    actions.push(install_copilot_hook(&hook_path, check_only)?);
                    actions.push(upsert_skill_file("copilot", &skill_path, check_only)?);
                } else {
                    actions.push(skipped("copilot", &skill_path));
                }
            }
            AgentTarget::Agents => {
                let agents_dir = home_dir.join(".agents");
                let cfg_agents_dir = home_dir.join(".config").join("agents");
                let primary = agents_dir.join("skills").join("kite-ctx").join("SKILL.md");
                let secondary = cfg_agents_dir.join("skills").join("kite-ctx").join("SKILL.md");
                let mut any = false;
                if explicit_single || agents_dir.exists() {
                    actions.push(upsert_skill_file("agents", &primary, check_only)?);
                    any = true;
                }
                if cfg_agents_dir.exists() {
                    actions.push(upsert_skill_file("config_agents", &secondary, check_only)?);
                    any = true;
                }
                if !any {
                    actions.push(skipped("agents", &primary));
                }
            }
            AgentTarget::All => {}
        }
    }

    Ok(actions)
}

fn skipped(target: &str, path: &Path) -> HookInstallAction {
    HookInstallAction {
        target: target.to_string(),
        path: path.to_string_lossy().into_owned(),
        status: "skipped_missing_dir".to_string(),
    }
}

fn install_claude_hook(settings_path: &Path, check_only: bool) -> Result<HookInstallAction> {
    upsert_nested_hook_entry(
        "claude",
        settings_path,
        "PreToolUse",
        "Bash|PowerShell",
        "kite ctx hook-rewrite --agent claude",
        Some(5),
        check_only,
    )
}

fn install_codex_hook(hooks_path: &Path, check_only: bool) -> Result<HookInstallAction> {
    upsert_nested_hook_entry(
        "codex_hook",
        hooks_path,
        "PreToolUse",
        "Bash",
        "kite ctx hook-rewrite --agent codex",
        None,
        check_only,
    )
}

fn install_gemini_hook(settings_path: &Path, check_only: bool) -> Result<HookInstallAction> {
    upsert_nested_hook_entry(
        "gemini_hook",
        settings_path,
        "BeforeTool",
        "run_shell_command",
        "kite ctx hook-rewrite --agent gemini",
        None,
        check_only,
    )
}

fn upsert_nested_hook_entry(
    target_label: &str,
    json_path: &Path,
    event_key: &str,
    matcher: &str,
    hook_cmd: &str,
    timeout_secs: Option<u64>,
    check_only: bool,
) -> Result<HookInstallAction> {
    let mut root: Value = if json_path.is_file() {
        let raw = std::fs::read_to_string(json_path)?;
        serde_json::from_str(raw.trim_start_matches('\u{feff}')).unwrap_or_else(|_| json!({}))
    } else {
        json!({})
    };

    let already_exact = root
        .get("hooks")
        .and_then(|h| h.get(event_key))
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter().any(|item| {
                item.get("hooks")
                    .and_then(Value::as_array)
                    .map(|inner| {
                        inner.iter().any(|entry| {
                            entry.get("command").and_then(Value::as_str) == Some(hook_cmd)
                        })
                    })
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false);

    if already_exact {
        return Ok(HookInstallAction {
            target: target_label.to_string(),
            path: json_path.to_string_lossy().into_owned(),
            status: "already_installed".to_string(),
        });
    }

    if check_only {
        return Ok(HookInstallAction {
            target: target_label.to_string(),
            path: json_path.to_string_lossy().into_owned(),
            status: "would_install".to_string(),
        });
    }

    if let Some(parent) = json_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let obj = root
        .as_object_mut()
        .ok_or_else(|| CtxError::InvalidInput("hook json root is not an object".to_string()))?;
    let hooks = obj
        .entry("hooks")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| CtxError::InvalidInput("hooks field is not an object".to_string()))?;
    let event_arr = hooks
        .entry(event_key)
        .or_insert_with(|| json!([]))
        .as_array_mut()
        .ok_or_else(|| CtxError::InvalidInput(format!("{event_key} is not an array")))?;

    // Remove older `kite ctx hook-rewrite` entries so we upgrade cleanly without duplicates.
    event_arr.retain(|item| {
        !item
            .get("hooks")
            .and_then(Value::as_array)
            .map(|inner| {
                inner.iter().any(|entry| {
                    entry
                        .get("command")
                        .and_then(Value::as_str)
                        .is_some_and(|c| c.starts_with("kite ctx hook-rewrite"))
                })
            })
            .unwrap_or(false)
    });

    let mut hook_item = json!({
        "type": "command",
        "command": hook_cmd,
    });
    if let Some(t) = timeout_secs {
        hook_item["timeout"] = json!(t);
    }

    event_arr.push(json!({
        "matcher": matcher,
        "hooks": [hook_item]
    }));

    std::fs::write(json_path, serde_json::to_string_pretty(&root)?)?;
    Ok(HookInstallAction {
        target: target_label.to_string(),
        path: json_path.to_string_lossy().into_owned(),
        status: "installed".to_string(),
    })
}

fn install_cursor_hook(hooks_path: &Path, check_only: bool) -> Result<HookInstallAction> {
    let mut root: Value = if hooks_path.is_file() {
        let raw = std::fs::read_to_string(hooks_path)?;
        serde_json::from_str(raw.trim_start_matches('\u{feff}'))
            .unwrap_or_else(|_| json!({ "version": 1, "hooks": {} }))
    } else {
        json!({ "version": 1, "hooks": {} })
    };

    let hook_cmd = "kite ctx hook-rewrite --agent cursor";
    let already_present = root
        .get("hooks")
        .and_then(|h| h.get("preToolUse"))
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .any(|entry| entry.get("command").and_then(Value::as_str) == Some(hook_cmd))
        })
        .unwrap_or(false);

    if already_present {
        return Ok(HookInstallAction {
            target: "cursor_hook".to_string(),
            path: hooks_path.to_string_lossy().into_owned(),
            status: "already_installed".to_string(),
        });
    }

    if check_only {
        return Ok(HookInstallAction {
            target: "cursor_hook".to_string(),
            path: hooks_path.to_string_lossy().into_owned(),
            status: "would_install".to_string(),
        });
    }

    if let Some(parent) = hooks_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let obj = root
        .as_object_mut()
        .ok_or_else(|| CtxError::InvalidInput("cursor hooks.json is not an object".to_string()))?;
    obj.entry("version").or_insert_with(|| json!(1));
    let hooks = obj
        .entry("hooks")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| CtxError::InvalidInput("cursor hooks is not an object".to_string()))?;
    let pre = hooks
        .entry("preToolUse")
        .or_insert_with(|| json!([]))
        .as_array_mut()
        .ok_or_else(|| CtxError::InvalidInput("cursor preToolUse is not an array".to_string()))?;

    pre.retain(|entry| {
        !entry
            .get("command")
            .and_then(Value::as_str)
            .is_some_and(|c| c.starts_with("kite ctx hook-rewrite"))
    });
    pre.push(json!({
        "matcher": "Shell",
        "command": hook_cmd
    }));

    std::fs::write(hooks_path, serde_json::to_string_pretty(&root)?)?;
    Ok(HookInstallAction {
        target: "cursor_hook".to_string(),
        path: hooks_path.to_string_lossy().into_owned(),
        status: "installed".to_string(),
    })
}

fn install_antigravity_plugin(plugin_dir: &Path, check_only: bool) -> Result<HookInstallAction> {
    let plugin_json_path = plugin_dir.join("plugin.json");
    let hooks_json_path = plugin_dir.join("hooks.json");
    let rules_md_path = plugin_dir.join("rules").join("AGENTS.md");

    let plugin_json = serde_json::to_string_pretty(&json!({
        "name": "kite-ctx",
        "version": "0.1.0",
        "description": "Kite Context Engine mandatory command optimization hook and rules for Antigravity"
    }))?;
    let hooks_json = serde_json::to_string_pretty(&json!({
        "hooks": {
            "PreToolUse": [
                {
                    "matcher": "run_command",
                    "hooks": [
                        {
                            "type": "command",
                            "command": "kite ctx hook-rewrite --agent antigravity"
                        }
                    ]
                }
            ]
        }
    }))?;
    let rules_body = format!("{KITE_CTX_INSTRUCTION}\n");

    let up_to_date = plugin_json_path.is_file()
        && hooks_json_path.is_file()
        && rules_md_path.is_file()
        && std::fs::read_to_string(&plugin_json_path).ok().as_deref() == Some(&plugin_json)
        && std::fs::read_to_string(&hooks_json_path).ok().as_deref() == Some(&hooks_json)
        && std::fs::read_to_string(&rules_md_path).ok().as_deref() == Some(&rules_body);

    if up_to_date {
        return Ok(HookInstallAction {
            target: "antigravity_plugin".to_string(),
            path: hooks_json_path.to_string_lossy().into_owned(),
            status: "already_installed".to_string(),
        });
    }

    if check_only {
        return Ok(HookInstallAction {
            target: "antigravity_plugin".to_string(),
            path: hooks_json_path.to_string_lossy().into_owned(),
            status: "would_install".to_string(),
        });
    }

    std::fs::create_dir_all(plugin_dir.join("rules"))?;
    std::fs::write(&plugin_json_path, plugin_json)?;
    std::fs::write(&hooks_json_path, hooks_json)?;
    std::fs::write(&rules_md_path, rules_body)?;

    Ok(HookInstallAction {
        target: "antigravity_plugin".to_string(),
        path: hooks_json_path.to_string_lossy().into_owned(),
        status: "installed".to_string(),
    })
}

fn install_opencode_plugin(plugin_path: &Path, check_only: bool) -> Result<HookInstallAction> {
    if plugin_path.is_file() {
        let existing = std::fs::read_to_string(plugin_path)?;
        if existing == OPENCODE_PLUGIN_TS {
            return Ok(HookInstallAction {
                target: "opencode_plugin".to_string(),
                path: plugin_path.to_string_lossy().into_owned(),
                status: "already_installed".to_string(),
            });
        }
    }

    if check_only {
        return Ok(HookInstallAction {
            target: "opencode_plugin".to_string(),
            path: plugin_path.to_string_lossy().into_owned(),
            status: "would_install".to_string(),
        });
    }

    if let Some(parent) = plugin_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(plugin_path, OPENCODE_PLUGIN_TS)?;

    Ok(HookInstallAction {
        target: "opencode_plugin".to_string(),
        path: plugin_path.to_string_lossy().into_owned(),
        status: "installed".to_string(),
    })
}

fn install_copilot_hook(hook_path: &Path, check_only: bool) -> Result<HookInstallAction> {
    let body = serde_json::to_string_pretty(&json!({
        "version": 1,
        "hooks": {
            "PreToolUse": [
                {
                    "type": "command",
                    "command": "kite ctx hook-rewrite --agent copilot",
                    "cwd": ".",
                    "timeout": 5
                }
            ]
        }
    }))?;

    if hook_path.is_file() {
        let existing = std::fs::read_to_string(hook_path)?;
        if existing == body {
            return Ok(HookInstallAction {
                target: "copilot_hook".to_string(),
                path: hook_path.to_string_lossy().into_owned(),
                status: "already_installed".to_string(),
            });
        }
    }

    if check_only {
        return Ok(HookInstallAction {
            target: "copilot_hook".to_string(),
            path: hook_path.to_string_lossy().into_owned(),
            status: "would_install".to_string(),
        });
    }

    if let Some(parent) = hook_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(hook_path, body)?;

    Ok(HookInstallAction {
        target: "copilot_hook".to_string(),
        path: hook_path.to_string_lossy().into_owned(),
        status: "installed".to_string(),
    })
}

fn upsert_skill_file(target: &str, path: &Path, check_only: bool) -> Result<HookInstallAction> {
    let body = format!(
        "---\nname: kite-ctx\ndescription: \"Optimize file reads, shell outputs, and context handoffs using kite ctx.\"\n---\n\n{KITE_CTX_INSTRUCTION}\n"
    );

    if path.is_file() {
        let existing = std::fs::read_to_string(path)?;
        if existing == body {
            return Ok(HookInstallAction {
                target: target.to_string(),
                path: path.to_string_lossy().into_owned(),
                status: "already_installed".to_string(),
            });
        }
    }

    if check_only {
        return Ok(HookInstallAction {
            target: target.to_string(),
            path: path.to_string_lossy().into_owned(),
            status: "would_install".to_string(),
        });
    }

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, body)?;

    Ok(HookInstallAction {
        target: target.to_string(),
        path: path.to_string_lossy().into_owned(),
        status: "installed".to_string(),
    })
}

/// Resolve current OS user's home directory.
pub fn resolve_home_dir() -> PathBuf {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
        .filter(|v| !v.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrites_compound_chains_and_safe_commands_while_skipping_pipes_and_redirections() {
        assert_eq!(
            rewrite_hook_command("cargo test -p kite-ctx"),
            Some("kite ctx exec -- cargo test -p kite-ctx".to_string())
        );
        assert_eq!(
            rewrite_hook_command("cd src-tauri && cargo test -p kite-ctx"),
            Some("cd src-tauri && kite ctx exec -- cargo test -p kite-ctx".to_string())
        );
        assert_eq!(
            rewrite_hook_command("git status; npx vitest run"),
            Some("kite ctx exec -- git status; kite ctx exec -- npx vitest run".to_string())
        );
        assert_eq!(rewrite_hook_command("kite ctx stats"), None);
        assert_eq!(rewrite_hook_command("cd src-tauri && echo done"), None);
        assert_eq!(rewrite_hook_command("cargo test | tee out.log"), None);
        assert_eq!(rewrite_hook_command("git status > status.txt"), None);
        assert_eq!(rewrite_hook_command("git commit -m \"feat: init\""), None);

        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let ws = tmp.path().join("ws");
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        std::fs::write(
            home.join(".claude").join("settings.json"),
            r#"{"env":{"FOO":"bar"}}"#,
        )
        .unwrap();

        let check = apply_agent_setup(AgentTarget::Claude, &home, &ws, true).unwrap();
        assert_eq!(check[0].status, "would_install");

        let install = apply_agent_setup(AgentTarget::Claude, &home, &ws, false).unwrap();
        assert_eq!(install[0].status, "installed");
        let saved = std::fs::read_to_string(home.join(".claude").join("settings.json")).unwrap();
        assert!(saved.contains("kite ctx hook-rewrite --agent claude"));
        assert!(saved.contains(r#""FOO": "bar""#));

        let second = apply_agent_setup(AgentTarget::Claude, &home, &ws, false).unwrap();
        assert_eq!(second[0].status, "already_installed");
    }

    #[test]
    fn evaluates_all_agent_hook_protocols_correctly() {
        // 1. Antigravity PreToolUse (`run_command`)
        let agy_in = r#"{"toolCall":{"name":"run_command","args":{"CommandLine":"cd src-tauri && cargo test -p kite-ctx","WaitMsBeforeAsync":5000}}}"#;
        let agy_out: Value = serde_json::from_str(
            &evaluate_hook_input(Some(AgentTarget::Antigravity), agy_in, None).unwrap(),
        )
        .unwrap();
        assert_eq!(agy_out["decision"], "allow");
        assert_eq!(
            agy_out["overwrite"]["CommandLine"],
            "cd src-tauri && kite ctx exec -- cargo test -p kite-ctx"
        );
        assert_eq!(agy_out["overwrite"]["WaitMsBeforeAsync"], 5000);

        // Antigravity passthrough returns fail-open allow
        let agy_noop = r#"{"toolCall":{"name":"run_command","args":{"CommandLine":"echo hello"}}}"#;
        let agy_noop_out: Value = serde_json::from_str(
            &evaluate_hook_input(Some(AgentTarget::Antigravity), agy_noop, None).unwrap(),
        )
        .unwrap();
        assert_eq!(agy_noop_out, json!({"decision": "allow"}));

        // 2. Gemini CLI BeforeTool (`run_shell_command`)
        let gem_in = r#"{"hook_event_name":"BeforeTool","tool_name":"run_shell_command","tool_input":{"command":"git status"}}"#;
        let gem_out: Value = serde_json::from_str(
            &evaluate_hook_input(Some(AgentTarget::Gemini), gem_in, None).unwrap(),
        )
        .unwrap();
        assert_eq!(gem_out["decision"], "allow");
        assert_eq!(
            gem_out["hookSpecificOutput"]["tool_input"]["command"],
            "kite ctx exec -- git status"
        );

        // 3. Cursor preToolUse (`Shell` with UTF-8 BOM)
        let cur_in = "\u{feff}{\"hook_event_name\":\"preToolUse\",\"tool_name\":\"Shell\",\"tool_input\":{\"command\":\"npx vitest run\"}}";
        let cur_out: Value = serde_json::from_str(
            &evaluate_hook_input(Some(AgentTarget::Cursor), cur_in, None).unwrap(),
        )
        .unwrap();
        assert_eq!(cur_out["continue"], true);
        assert_eq!(cur_out["permission"], "allow");
        assert_eq!(
            cur_out["updated_input"]["command"],
            "kite ctx exec -- npx vitest run"
        );

        // 4. OpenCode `--command`
        let oc_out: Value = serde_json::from_str(
            &evaluate_hook_input(Some(AgentTarget::OpenCode), "", Some("cargo check")).unwrap(),
        )
        .unwrap();
        assert_eq!(oc_out["command"], "kite ctx exec -- cargo check");

        // 5. Copilot camelCase (`toolArgs`)
        let cop_in = r#"{"toolName":"bash","toolArgs":"{\"command\":\"pytest -q\"}"}"#;
        let cop_out: Value = serde_json::from_str(
            &evaluate_hook_input(Some(AgentTarget::Copilot), cop_in, None).unwrap(),
        )
        .unwrap();
        assert_eq!(cop_out["permissionDecision"], "allow");
        assert!(cop_out["modifiedArgs"]
            .as_str()
            .unwrap()
            .contains("kite ctx exec -- pytest -q"));
    }

    #[test]
    fn installs_mandatory_hooks_plugins_and_skills_across_all_agent_surfaces() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let ws = tmp.path().join("ws");

        std::fs::create_dir_all(home.join(".claude")).unwrap();
        std::fs::create_dir_all(home.join(".gemini").join("antigravity")).unwrap();
        std::fs::create_dir_all(home.join(".gemini").join("antigravity-cli")).unwrap();
        std::fs::create_dir_all(home.join(".cursor")).unwrap();
        std::fs::create_dir_all(home.join(".codex")).unwrap();
        std::fs::create_dir_all(home.join(".config").join("opencode")).unwrap();
        std::fs::create_dir_all(home.join(".grok")).unwrap();
        std::fs::create_dir_all(home.join(".copilot")).unwrap();
        std::fs::create_dir_all(home.join(".agents")).unwrap();

        let actions = apply_agent_setup(AgentTarget::All, &home, &ws, false).unwrap();
        assert!(actions.iter().any(|a| a.target == "claude" && a.status == "installed"));
        assert!(actions.iter().any(|a| a.target == "antigravity_plugin" && a.status == "installed"));
        assert!(actions.iter().any(|a| a.target == "cursor_hook" && a.status == "installed"));
        assert!(actions.iter().any(|a| a.target == "codex_hook" && a.status == "installed"));
        assert!(actions.iter().any(|a| a.target == "gemini_hook" && a.status == "installed"));
        assert!(actions.iter().any(|a| a.target == "opencode_plugin" && a.status == "installed"));
        assert!(actions.iter().any(|a| a.target == "copilot_hook" && a.status == "installed"));

        assert!(home
            .join(".gemini")
            .join("config")
            .join("plugins")
            .join("kite-ctx")
            .join("hooks.json")
            .is_file());
        assert!(home.join(".cursor").join("hooks.json").is_file());
        assert!(home.join(".codex").join("hooks.json").is_file());
        assert!(home.join(".gemini").join("settings.json").is_file());
        assert!(home
            .join(".config")
            .join("opencode")
            .join("plugins")
            .join("kite-ctx.ts")
            .is_file());
        assert!(home
            .join(".copilot")
            .join("hooks")
            .join("kite-ctx.json")
            .is_file());
    }
}
