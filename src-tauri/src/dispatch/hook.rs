//! Deterministic `PreToolUse` / `BeforeTool` subagent interception (`kite dispatch hook-subagent`) (`S14`).
//!
//! Ensures parent orchestrators running inside Kite Thread Mode (`KITE_DISPATCH=1`,
//! `KITE_ADDRESS=thread:<id>`) route subagents through `kite_subagent_run` / RightDock
//! when Thread Mode or explicit Kite Subagents configuration applies, block native
//! `send_message` attempts against killed/settled or `childThreadId` Kite subagents,
//! and normalize shell `kite dispatch run` calls to `--via thread`.

use std::io::Read;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookStackEntry {
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookDefaultDelegation {
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub effort: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookSubagentSettings {
    #[serde(default)]
    pub stack: Vec<HookStackEntry>,
    #[serde(default)]
    pub default_delegation: Option<HookDefaultDelegation>,
    #[serde(default)]
    pub override_policy: String,
}

fn canonical_provider(raw: &str) -> &'static str {
    match raw.trim().to_ascii_lowercase().as_str() {
        "antigravity" | "agy" => "antigravity",
        "claude" | "claude-code" => "claude",
        "codex" => "codex",
        "cursor" | "cursor-agent" => "cursor",
        "gemini" | "gemini-cli" => "gemini",
        "grok" => "grok",
        "opencode" | "open-code" => "opencode",
        "copilot" | "github-copilot" => "copilot",
        _ => "",
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HookSubagentRunStatus {
    pub subagent_id: String,
    pub child_thread_id: Option<String>,
    pub status: String,
}

fn open_sqlite_readonly(db_path: &Path) -> Option<rusqlite::Connection> {
    if !db_path.is_file() {
        return None;
    }
    rusqlite::Connection::open_with_flags(
        db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()
}

pub fn load_subagent_settings_from_sqlite(db_path: &Path) -> HookSubagentSettings {
    let Some(conn) = open_sqlite_readonly(db_path) else {
        return HookSubagentSettings::default();
    };
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM app_state WHERE key = 'subagentSettings'",
            [],
            |row| row.get(0),
        )
        .ok();
    raw.and_then(|s| serde_json::from_str::<HookSubagentSettings>(&s).ok())
        .unwrap_or_default()
}

pub fn load_thread_subagents_from_sqlite(
    db_path: &Path,
    thread_id: &str,
) -> Vec<HookSubagentRunStatus> {
    let tid = thread_id.trim();
    if tid.is_empty() {
        return Vec::new();
    }
    let Some(conn) = open_sqlite_readonly(db_path) else {
        return Vec::new();
    };
    let raw: Option<String> = conn
        .query_row(
            "SELECT data FROM threads WHERE id = ?1",
            rusqlite::params![tid],
            |row| row.get(0),
        )
        .ok();
    let Some(parsed) = raw.and_then(|s| serde_json::from_str::<Value>(&s).ok()) else {
        return Vec::new();
    };
    let Some(runs) = parsed.get("subagentRuns").and_then(Value::as_array) else {
        return Vec::new();
    };
    runs.iter()
        .filter_map(|run| {
            let subagent_id = run
                .get("subagentId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())?
                .to_string();
            let child_thread_id = run
                .get("childThreadId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            let status = run
                .get("status")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or("running")
                .to_string();
            Some(HookSubagentRunStatus {
                subagent_id,
                child_thread_id,
                status,
            })
        })
        .collect()
}

pub fn load_default_subagent_settings() -> HookSubagentSettings {
    let db_path = super::roaming_app_dir().join("kite.sqlite");
    load_subagent_settings_from_sqlite(&db_path)
}

fn extract_tool_name_and_input(parsed: &Value) -> Option<(String, Value)> {
    if let Some(tc) = parsed.get("toolCall") {
        let name = tc
            .get("name")
            .or_else(|| tc.get("tool"))
            .and_then(Value::as_str)?
            .trim()
            .to_string();
        let input = tc
            .get("args")
            .or_else(|| tc.get("parameters"))
            .or_else(|| tc.get("input"))
            .cloned()
            .unwrap_or_else(|| json!({}));
        return Some((name, input));
    }

    let name = parsed
        .get("tool_name")
        .or_else(|| parsed.get("toolName"))
        .or_else(|| parsed.get("tool"))
        .or_else(|| parsed.get("name"))
        .and_then(Value::as_str)?
        .trim()
        .to_string();

    if let Some(raw_args) = parsed.get("toolArgs").and_then(Value::as_str) {
        let parsed_args = serde_json::from_str::<Value>(raw_args).unwrap_or_else(|_| json!({}));
        return Some((name, parsed_args));
    }

    let input = parsed
        .get("tool_input")
        .or_else(|| parsed.get("toolInput"))
        .or_else(|| parsed.get("args"))
        .or_else(|| parsed.get("parameters"))
        .or_else(|| parsed.get("input"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    Some((name, input))
}

fn requires_cross_provider_or_strict_redirect(
    agent_provider: &str,
    settings: &HookSubagentSettings,
) -> Option<String> {
    let canon_agent = canonical_provider(agent_provider);
    let is_strict = settings.override_policy.trim().eq_ignore_ascii_case("strict");

    if let Some(def) = settings.default_delegation.as_ref() {
        let def_prov = canonical_provider(&def.provider);
        if !def_prov.is_empty() && (is_strict || (!canon_agent.is_empty() && def_prov != canon_agent))
        {
            return Some(format!("{}/{}", def.provider.trim(), def.model.trim()));
        }
    }

    let enabled_stack: Vec<&HookStackEntry> = settings
        .stack
        .iter()
        .filter(|e| e.enabled && !e.provider.trim().is_empty())
        .collect();

    if !enabled_stack.is_empty() {
        let has_cross_provider = enabled_stack.iter().any(|e| {
            let p = canonical_provider(&e.provider);
            !p.is_empty() && !canon_agent.is_empty() && p != canon_agent
        });
        if is_strict || has_cross_provider {
            let summary: Vec<String> = enabled_stack
                .iter()
                .map(|e| format!("{}/{}", e.provider.trim(), e.model.trim()))
                .collect();
            return Some(summary.join(", "));
        }
    }

    if is_strict {
        return Some("configured Kite Subagents stack (strict policy)".to_string());
    }

    None
}

fn requires_thread_subagent_redirect(
    agent_provider: &str,
    tool_name: &str,
    in_thread_mode: bool,
    settings: &HookSubagentSettings,
) -> Option<String> {
    if let Some(target) = requires_cross_provider_or_strict_redirect(agent_provider, settings) {
        return Some(target);
    }
    if !in_thread_mode {
        return None;
    }
    if let Some(def) = settings.default_delegation.as_ref() {
        let prov = def.provider.trim();
        let model = def.model.trim();
        if !prov.is_empty() && !model.is_empty() {
            return Some(format!("{prov}/{model}"));
        }
    }
    if let Some(entry) = settings
        .stack
        .iter()
        .find(|e| e.enabled && !e.provider.trim().is_empty() && !e.model.trim().is_empty())
    {
        return Some(format!("{}/{}", entry.provider.trim(), entry.model.trim()));
    }
    if tool_name == "invoke_subagent" {
        return Some("antigravity/gemini-4-hydrogen".to_string());
    }
    None
}

fn normalize_shell_dispatch_run_command(cmd: &str) -> Option<String> {
    let mut updated = cmd.to_string();
    let mut changed = false;

    for prefix in ["kite dispatch run ", "kite.exe dispatch run "] {
        if let Some(idx) = updated.find(prefix) {
            let after = &updated[idx + prefix.len()..];
            if !after.contains("--via ") && !after.contains("--via=") {
                let replacement = format!("{prefix}--via thread ");
                updated = format!(
                    "{}{}{}",
                    &updated[..idx],
                    replacement,
                    &updated[idx + prefix.len()..]
                );
                changed = true;
                break;
            }
        }
    }

    if updated.contains("kite dispatch ") || updated.contains("kite.exe dispatch ") {
        if updated.contains("--workspace worktree") {
            updated = updated.replace("--workspace worktree", "--workspace share");
            changed = true;
        }
        if updated.contains("--workspace=worktree") {
            updated = updated.replace("--workspace=worktree", "--workspace=share");
            changed = true;
        }
    }

    if changed {
        Some(updated)
    } else {
        None
    }
}

fn allow_with_updated_input(agent: &str, updated_obj: Value) -> Value {
    match canonical_provider(agent) {
        "antigravity" => json!({
            "decision": "allow",
            "overwrite": updated_obj
        }),
        "gemini" => json!({
            "decision": "allow",
            "hookSpecificOutput": {
                "tool_input": updated_obj
            }
        }),
        "cursor" => json!({
            "continue": true,
            "permission": "allow",
            "updated_input": updated_obj
        }),
        _ => json!({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "allow",
                "updatedInput": updated_obj
            }
        }),
    }
}

fn deny_with_reason(agent: &str, reason: &str) -> Value {
    match canonical_provider(agent) {
        "antigravity" | "gemini" => json!({
            "decision": "deny",
            "reason": reason
        }),
        "cursor" => json!({
            "continue": false,
            "permission": "deny",
            "reason": reason
        }),
        _ => json!({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": reason
            }
        }),
    }
}

/// Evaluate a subagent or shell hook payload under explicit session/activation state and settings.
pub fn evaluate_subagent_hook(
    agent_hint: Option<&str>,
    raw_json: &str,
    is_active: bool,
    in_thread_mode: bool,
    settings: &HookSubagentSettings,
) -> Value {
    evaluate_subagent_hook_with_context(
        agent_hint,
        raw_json,
        is_active,
        in_thread_mode,
        settings,
        None,
    )
}

/// Evaluate a subagent or shell hook payload with optional parent-thread `subagentRuns` context.
fn is_exempt_native_subagent_type(tool_input: &Value) -> bool {
    let type_name = tool_input
        .get("TypeName")
        .or_else(|| tool_input.get("typeName"))
        .or_else(|| tool_input.get("type_name"))
        .or_else(|| tool_input.get("subagent_type"))
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    type_name.eq_ignore_ascii_case("image-generator")
}

pub fn evaluate_subagent_hook_with_context(
    agent_hint: Option<&str>,
    raw_json: &str,
    is_active: bool,
    in_thread_mode: bool,
    settings: &HookSubagentSettings,
    thread_subagents: Option<&[HookSubagentRunStatus]>,
) -> Value {
    if !is_active {
        return json!({});
    }

    let cleaned = raw_json.trim_start_matches('\u{feff}').trim();
    if cleaned.is_empty() {
        return json!({});
    }
    let Ok(parsed) = serde_json::from_str::<Value>(cleaned) else {
        return json!({});
    };
    let Some((tool_name, tool_input)) = extract_tool_name_and_input(&parsed) else {
        return json!({});
    };

    let inferred_agent = agent_hint
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| match tool_name.as_str() {
            "invoke_subagent" | "define_subagent" | "send_message" | "run_command" => "antigravity",
            "Task" | "Agent" => "claude",
            "run_shell_command" => "gemini",
            _ => "",
        });

    // 1. Native subagent tools (`invoke_subagent`, `define_subagent`, `Task`, `Agent`)
    if matches!(
        tool_name.as_str(),
        "invoke_subagent" | "define_subagent" | "Task" | "Agent"
    ) {
        if tool_name == "define_subagent"
            || (tool_name == "invoke_subagent" && is_exempt_native_subagent_type(&tool_input))
        {
            return json!({ "decision": "allow" });
        }
        if let Some(target_stack) = requires_thread_subagent_redirect(
            inferred_agent,
            &tool_name,
            in_thread_mode,
            settings,
        ) {
            let role = tool_input
                .get("Name")
                .or_else(|| tool_input.get("Role"))
                .or_else(|| tool_input.get("subagent_type"))
                .or_else(|| tool_input.get("description"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or("Fast Executor");
            let msg = format!(
                "Native `{tool_name}` is blocked because Kite Subagents is configured for `{target_stack}`. Call the `kite_subagent_run` MCP tool or run `kite dispatch run --via thread --role \"{role}\" --wait \"<Prompt>\"` so Kite routes the subagent to your configured stack and renders it in RightDock."
            );
            return deny_with_reason(inferred_agent, &msg);
        }

        if tool_name == "invoke_subagent" {
            let mut updated = tool_input.clone();
            let Some(obj) = updated.as_object_mut() else {
                return json!({ "decision": "allow" });
            };
            let mut changed = false;
            let current_model = obj
                .get("Model")
                .or_else(|| obj.get("model"))
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("");
            if current_model.is_empty() || current_model.eq_ignore_ascii_case("inherit") {
                let configured_agy_model = settings
                    .default_delegation
                    .as_ref()
                    .filter(|d| canonical_provider(&d.provider) == "antigravity")
                    .map(|d| d.model.trim())
                    .filter(|m| !m.is_empty())
                    .or_else(|| {
                        settings
                            .stack
                            .iter()
                            .find(|e| {
                                e.enabled
                                    && canonical_provider(&e.provider) == "antigravity"
                                    && !e.model.trim().is_empty()
                            })
                            .map(|e| e.model.trim())
                    });
                let mapped_native_model = configured_agy_model.and_then(|m| {
                    let lower = m.to_ascii_lowercase();
                    if lower.contains("lite") {
                        Some("flash_lite")
                    } else if lower.contains("flash") {
                        Some("flash")
                    } else {
                        None
                    }
                });
                if let Some(target_native) = mapped_native_model {
                    obj.insert("Model".to_string(), Value::String(target_native.to_string()));
                    changed = true;
                }
            }
            let current_ws = obj
                .get("Workspace")
                .or_else(|| obj.get("workspace"))
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("");
            if current_ws.is_empty() {
                obj.insert("Workspace".to_string(), Value::String("share".to_string()));
                changed = true;
            }
            if changed {
                return allow_with_updated_input(inferred_agent, updated);
            }
            return json!({ "decision": "allow" });
        }

        // `Task` / `Agent` (Claude / Cursor / Codex / Gemini)
        let mut updated = tool_input.clone();
        let Some(obj) = updated.as_object_mut() else {
            return json!({ "decision": "allow" });
        };
        let current_model = obj
            .get("model")
            .or_else(|| obj.get("Model"))
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("");
        if current_model.is_empty() || current_model.eq_ignore_ascii_case("inherit") {
            let fast_model = settings
                .default_delegation
                .as_ref()
                .map(|d| d.model.trim())
                .filter(|m| !m.is_empty())
                .or_else(|| {
                    settings
                        .stack
                        .iter()
                        .find(|e| e.enabled && !e.model.trim().is_empty())
                        .map(|e| e.model.trim())
                })
                .unwrap_or(match canonical_provider(inferred_agent) {
                    "gemini" => "flash",
                    _ => "haiku",
                });
            obj.insert("model".to_string(), Value::String(fast_model.to_string()));
            return allow_with_updated_input(inferred_agent, updated);
        }
        return json!({ "decision": "allow" });
    }

    // 2. Prevent native `send_message` from masking killed/settled or Kite-managed subagents.
    if in_thread_mode && tool_name == "send_message" {
        let recipient = tool_input
            .get("Recipient")
            .or_else(|| tool_input.get("recipient"))
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("");
        if !recipient.is_empty() {
            if let Some(run) = thread_subagents.and_then(|runs| {
                runs.iter().find(|r| {
                    r.subagent_id == recipient || r.child_thread_id.as_deref() == Some(recipient)
                })
            }) {
                let status_lower = run.status.to_ascii_lowercase();
                if matches!(status_lower.as_str(), "killed" | "stopped" | "failed") {
                    let msg = format!(
                        "Native `send_message` to `{recipient}` is blocked because that subagent is already `{status_lower}` in Kite and cannot be relaunched or resumed here. Do NOT report that it was relaunched; call `kite_subagent_run` (or `kite dispatch run --via thread`) to launch a new tracked subagent in RightDock."
                    );
                    return deny_with_reason(inferred_agent, &msg);
                }
                if let Some(ref cid) = run.child_thread_id {
                    let msg = format!(
                        "Native `send_message` cannot reach Kite thread subagent `{recipient}` (thread:`{cid}`). Use `kite_subagent_send` (or `kite dispatch send thread:{cid} \"<task>\" --wait`) instead."
                    );
                    return deny_with_reason(inferred_agent, &msg);
                }
            }
        }
    }

    // 3. Shell `kite dispatch run` normalization inside Thread Mode
    if in_thread_mode
        && matches!(
            tool_name.as_str(),
            "run_command"
                | "Bash"
                | "bash"
                | "shell"
                | "Shell"
                | "PowerShell"
                | "execute_command"
                | "run_shell_command"
                | "run_in_terminal"
                | "runTerminalCommand"
        )
    {
        let mut updated = tool_input.clone();
        let Some(obj) = updated.as_object_mut() else {
            return json!({ "decision": "allow" });
        };
        let (cmd_key, cmd_val) = if let Some(c) = obj.get("CommandLine").and_then(Value::as_str) {
            ("CommandLine", c.to_string())
        } else if let Some(c) = obj.get("command").and_then(Value::as_str) {
            ("command", c.to_string())
        } else {
            return json!({ "decision": "allow" });
        };

        if let Some(rewritten) = normalize_shell_dispatch_run_command(&cmd_val) {
            obj.insert(cmd_key.to_string(), Value::String(rewritten));
            return allow_with_updated_input(inferred_agent, updated);
        }
    }

    json!({ "decision": "allow" })
}

pub fn run_hook_cli(args: &[String]) -> i32 {
    let mut agent: Option<String> = None;
    let mut input_arg: Option<String> = None;
    let mut force_active = false;

    let mut i = 0;
    while i < args.len() {
        let tok = args[i].as_str();
        match tok {
            "--agent" => {
                if let Some(val) = args.get(i + 1) {
                    agent = Some(val.clone());
                }
                i += 2;
            }
            "--input" => {
                if let Some(val) = args.get(i + 1) {
                    input_arg = Some(val.clone());
                }
                i += 2;
            }
            "--force-active" => {
                force_active = true;
                i += 1;
            }
            _ => {
                if let Some(val) = tok.strip_prefix("--agent=") {
                    agent = Some(val.to_string());
                } else if let Some(val) = tok.strip_prefix("--input=") {
                    input_arg = Some(val.to_string());
                }
                i += 1;
            }
        }
    }

    let kite_dispatch_on = std::env::var("KITE_DISPATCH").ok().as_deref() == Some("1");
    let kite_address = std::env::var("KITE_ADDRESS").ok().unwrap_or_default();
    let in_thread_mode = force_active || kite_address.trim().starts_with("thread:");
    let is_active = force_active || kite_dispatch_on || in_thread_mode;

    if !is_active {
        super::emit_cli_line("{}");
        return 0;
    }

    let raw_input = match input_arg {
        Some(s) => s,
        None => {
            let mut buf = String::new();
            let _ = std::io::stdin().read_to_string(&mut buf);
            buf
        }
    };

    let caller_thread_id = if in_thread_mode {
        kite_address
            .trim()
            .strip_prefix("thread:")
            .map(str::trim)
            .filter(|s| !s.is_empty())
    } else {
        None
    };
    let db_path = super::roaming_app_dir().join("kite.sqlite");
    let settings = load_subagent_settings_from_sqlite(&db_path);
    let thread_subagents = caller_thread_id
        .map(|tid| load_thread_subagents_from_sqlite(&db_path, tid))
        .unwrap_or_default();
    let out = evaluate_subagent_hook_with_context(
        agent.as_deref(),
        &raw_input,
        is_active,
        in_thread_mode,
        &settings,
        Some(&thread_subagents),
    );
    super::emit_cli_line(&out.to_string());
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inactive_session_returns_noop_empty_object() {
        let payload = r#"{"toolCall":{"name":"invoke_subagent","args":{"Name":"helper","Prompt":"Check code","Model":"inherit"}}}"#;
        let out = evaluate_subagent_hook(
            Some("antigravity"),
            payload,
            false,
            false,
            &HookSubagentSettings::default(),
        );
        assert_eq!(out, json!({}));
    }

    #[test]
    fn thread_mode_redirects_native_subagents_while_standalone_rewrites_flash_and_share() {
        let payload = r#"{"toolCall":{"name":"invoke_subagent","args":{"Name":"helper","Prompt":"Check code","Model":"inherit"}}}"#;
        let out_thread_default = evaluate_subagent_hook(
            Some("antigravity"),
            payload,
            true,
            true,
            &HookSubagentSettings::default(),
        );
        assert_eq!(
            out_thread_default["decision"], "deny",
            "Thread Mode must redirect Antigravity native invoke_subagent to kite_subagent_run"
        );
        assert!(out_thread_default["reason"]
            .as_str()
            .unwrap_or("")
            .contains("kite_subagent_run"));

        let out_standalone_default = evaluate_subagent_hook(
            Some("antigravity"),
            payload,
            true,
            false,
            &HookSubagentSettings::default(),
        );
        assert_eq!(out_standalone_default["decision"], "allow");
        assert_eq!(out_standalone_default["overwrite"]["Model"], "inherit");
        assert_eq!(out_standalone_default["overwrite"]["Workspace"], "share");
        assert!(out_standalone_default.get("hookSpecificOutput").is_none());

        let flash_settings = HookSubagentSettings {
            stack: vec![HookStackEntry {
                provider: "antigravity".to_string(),
                model: "gemini-3.8-flash".to_string(),
                effort: None,
                enabled: true,
            }],
            default_delegation: Some(HookDefaultDelegation {
                provider: "antigravity".to_string(),
                model: "gemini-3.8-flash".to_string(),
                effort: None,
            }),
            override_policy: "ask".to_string(),
        };
        let out_standalone_flash = evaluate_subagent_hook(
            Some("antigravity"),
            payload,
            true,
            false,
            &flash_settings,
        );
        assert_eq!(out_standalone_flash["decision"], "allow");
        assert_eq!(out_standalone_flash["overwrite"]["Model"], "flash");
        assert_eq!(out_standalone_flash["overwrite"]["Workspace"], "share");
        assert!(out_standalone_flash.get("hookSpecificOutput").is_none());

        let out_thread_flash = evaluate_subagent_hook(
            Some("antigravity"),
            payload,
            true,
            true,
            &flash_settings,
        );
        assert_eq!(out_thread_flash["decision"], "deny");

        let hydrogen_settings = HookSubagentSettings {
            stack: vec![HookStackEntry {
                provider: "antigravity".to_string(),
                model: "gemini-4-hydrogen".to_string(),
                effort: None,
                enabled: true,
            }],
            default_delegation: Some(HookDefaultDelegation {
                provider: "antigravity".to_string(),
                model: "gemini-4-hydrogen".to_string(),
                effort: None,
            }),
            override_policy: "ask".to_string(),
        };
        let out_thread_hydrogen = evaluate_subagent_hook(
            Some("antigravity"),
            payload,
            true,
            true,
            &hydrogen_settings,
        );
        assert_eq!(out_thread_hydrogen["decision"], "deny");
        assert!(out_thread_hydrogen["reason"]
            .as_str()
            .unwrap_or("")
            .contains("gemini-4-hydrogen"));
    }

    #[test]
    fn blocks_native_subagent_and_redirects_to_kite_subagent_run_when_cross_provider_stack_configured() {
        let settings = HookSubagentSettings {
            stack: vec![HookStackEntry {
                provider: "grok".to_string(),
                model: "grok-4.7-build-fast".to_string(),
                effort: Some("low".to_string()),
                enabled: true,
            }],
            default_delegation: Some(HookDefaultDelegation {
                provider: "grok".to_string(),
                model: "grok-4.7-build-fast".to_string(),
                effort: Some("low".to_string()),
            }),
            override_policy: "ask".to_string(),
        };
        let payload = r#"{"toolCall":{"name":"invoke_subagent","args":{"Name":"Fast Executor","Prompt":"Fix parser"}}}"#;
        let out = evaluate_subagent_hook(
            Some("antigravity"),
            payload,
            true,
            true,
            &settings,
        );
        assert_eq!(out["decision"], "deny");
        assert!(out.get("hookSpecificOutput").is_none());
        let reason = out["reason"].as_str().expect("deny reason");
        assert!(reason.contains("kite_subagent_run"));
        assert!(reason.contains("kite dispatch run --via thread"));

        let claude_payload = r#"{"tool_name":"Agent","tool_input":{"description":"Fast Executor","prompt":"Fix parser"}}"#;
        let claude_out = evaluate_subagent_hook(
            Some("claude"),
            claude_payload,
            true,
            true,
            &settings,
        );
        assert_eq!(
            claude_out["hookSpecificOutput"]["permissionDecision"],
            "deny"
        );
    }

    #[test]
    fn normalizes_shell_kite_dispatch_run_to_via_thread_and_share_workspace() {
        let payload = r#"{"toolCall":{"name":"run_command","args":{"CommandLine":"kite dispatch run --role \"Fast Executor\" --workspace worktree --wait \"Inspect tests\""}}}"#;
        let out = evaluate_subagent_hook(
            Some("antigravity"),
            payload,
            true,
            true,
            &HookSubagentSettings::default(),
        );
        assert_eq!(out["decision"], "allow");
        assert_eq!(
            out["overwrite"]["CommandLine"],
            "kite dispatch run --via thread --role \"Fast Executor\" --workspace share --wait \"Inspect tests\""
        );
        assert!(out.get("hookSpecificOutput").is_none());
    }

    #[test]
    fn thread_mode_blocks_send_message_to_killed_or_kite_child_subagents_via_sqlite() {
        let db_path = std::env::temp_dir().join(format!(
            "kite-hook-subagent-{}.sqlite",
            uuid::Uuid::new_v4().simple()
        ));
        let conn = rusqlite::Connection::open(&db_path).expect("open temp sqlite");
        conn.execute_batch(
            "CREATE TABLE app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE threads (id TEXT PRIMARY KEY, data TEXT NOT NULL);",
        )
        .expect("create schema");
        let thread_json = json!({
            "id": "parent-thread-1",
            "subagentRuns": [
                {
                    "subagentId": "67c4b77e-2724-46d4-96d3-78b4799bf138",
                    "status": "killed"
                },
                {
                    "subagentId": "sub-2950065b",
                    "childThreadId": "2950065b-child",
                    "status": "running"
                },
                {
                    "subagentId": "native-idle-ok",
                    "status": "completed"
                }
            ]
        });
        conn.execute(
            "INSERT INTO threads (id, data) VALUES (?1, ?2)",
            rusqlite::params!["parent-thread-1", thread_json.to_string()],
        )
        .expect("insert thread");
        drop(conn);

        let runs = load_thread_subagents_from_sqlite(&db_path, "parent-thread-1");
        let _ = std::fs::remove_file(&db_path);
        assert_eq!(runs.len(), 3);

        // Killed native subagent cannot be "relaunched" via native send_message.
        let send_killed = r#"{"toolCall":{"name":"send_message","args":{"Recipient":"67c4b77e-2724-46d4-96d3-78b4799bf138","Message":"Continue analysis"}}}"#;
        let out_killed = evaluate_subagent_hook_with_context(
            Some("antigravity"),
            send_killed,
            true,
            true,
            &HookSubagentSettings::default(),
            Some(&runs),
        );
        assert_eq!(out_killed["decision"], "deny");
        let reason_killed = out_killed["reason"].as_str().unwrap_or("");
        assert!(reason_killed.contains("killed"));
        assert!(reason_killed.contains("kite_subagent_run"));

        // Kite childThreadId subagent rejects native send_message and points to kite_subagent_send.
        let send_child = r#"{"toolCall":{"name":"send_message","args":{"Recipient":"2950065b-child","Message":"Status?"}}}"#;
        let out_child = evaluate_subagent_hook_with_context(
            Some("antigravity"),
            send_child,
            true,
            true,
            &HookSubagentSettings::default(),
            Some(&runs),
        );
        assert_eq!(out_child["decision"], "deny");
        assert!(out_child["reason"]
            .as_str()
            .unwrap_or("")
            .contains("kite_subagent_send"));

        // Non-subagent peer communication and cleanup `manage_subagents` remain allowed.
        let send_peer = r#"{"toolCall":{"name":"send_message","args":{"Recipient":"peer-helper","Message":"Hi"}}}"#;
        let out_peer = evaluate_subagent_hook_with_context(
            Some("antigravity"),
            send_peer,
            true,
            true,
            &HookSubagentSettings::default(),
            Some(&runs),
        );
        assert_eq!(out_peer["decision"], "allow");

        let kill_native = r#"{"toolCall":{"name":"manage_subagents","args":{"Action":"kill","ConversationIds":["67c4b77e-2724-46d4-96d3-78b4799bf138"]}}}"#;
        let out_manage = evaluate_subagent_hook_with_context(
            Some("antigravity"),
            kill_native,
            true,
            true,
            &HookSubagentSettings::default(),
            Some(&runs),
        );
        assert_eq!(out_manage["decision"], "allow");
    }

    #[test]
    fn thread_mode_allows_builtin_image_generator_subagent_without_redirect() {
        let strict_grok = HookSubagentSettings {
            stack: vec![HookStackEntry {
                provider: "grok".to_string(),
                model: "grok-4.7-build-fast".to_string(),
                effort: Some("low".to_string()),
                enabled: true,
            }],
            default_delegation: Some(HookDefaultDelegation {
                provider: "grok".to_string(),
                model: "grok-4.7-build-fast".to_string(),
                effort: Some("low".to_string()),
            }),
            override_policy: "strict".to_string(),
        };
        let payload = r#"{"toolCall":{"name":"invoke_subagent","args":{"TypeName":"image-generator","Role":"Wallpaper Generator","Prompt":"Generate 16:9 cosmic horizon"}}}"#;
        for settings in [&HookSubagentSettings::default(), &strict_grok] {
            let out = evaluate_subagent_hook(
                Some("antigravity"),
                payload,
                true,
                true,
                settings,
            );
            assert_eq!(out["decision"], "allow");
            assert!(out.get("overwrite").is_none());
        }
    }
}
