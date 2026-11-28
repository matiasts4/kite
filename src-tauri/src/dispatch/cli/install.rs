use serde_json::{json, Value};

use crate::dispatch::address::is_caller_endpoint;
use crate::dispatch::policy::{ChildrenMode, RunInput, SendInput, Service, WaitInput};
use crate::dispatch::port::Port;
use crate::dispatch::presence::PresenceState;
use crate::dispatch::types::{exit_code, Caller, DispatchError, Family, Receipt, ReceiptStatus};
use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpProfile {
    Full,
    DispatchOnly,
    None,
}

/// Pure helper backing [`mcp_entry_for_profile`] for deterministic testing without mutating env vars.
pub fn mcp_entry_for_profile_with_http(
    profile: McpProfile,
    hub_info: Option<(u16, &str)>,
    use_http_hub: bool,
) -> Option<Value> {
    if profile == McpProfile::None {
        return None;
    }
    if use_http_hub {
        if let Some((port, token)) = hub_info {
            let trimmed = token.trim();
            if port > 0 && !trimmed.is_empty() {
                return Some(json!({
                    "type": "http",
                    "url": format!("http://127.0.0.1:{port}/mcp"),
                    "headers": {
                        "Authorization": format!("Bearer {trimmed}")
                    }
                }));
            }
        }
    }
    Some(json!({
        "command": "kite",
        "args": ["dispatch", "mcp"]
    }))
}

/// Builds the `mcpServers["kite-dispatch"]` JSON config entry for the requested [`McpProfile`].
///
/// Emits `{ "type": "http", "url": "http://127.0.0.1:<port>/mcp", "headers": { "Authorization": "Bearer <token>" } }`
/// when `hub_info` is `Some` and `KITE_MCP_HTTP_HUB=1`, falls back to `{ "command": "kite", "args": ["dispatch", "mcp"] }`
/// otherwise, or returns `None` for [`McpProfile::None`].
pub fn mcp_entry_for_profile(
    profile: McpProfile,
    hub_info: Option<(u16, &str)>,
) -> Option<Value> {
    let use_http_hub = std::env::var("KITE_MCP_HTTP_HUB")
        .ok()
        .is_some_and(|v| v.trim() == "1");
    mcp_entry_for_profile_with_http(profile, hub_info, use_http_hub)
}

fn read_disk_mcp_hub_info() -> Option<(u16, String)> {
    let path = crate::persist::roaming_app_dir().join("mcp-hub.json");
    let bytes = std::fs::read(path).ok()?;
    let parsed = serde_json::from_slice::<Value>(&bytes).ok()?;
    let token = parsed.get("token").and_then(Value::as_str)?.trim().to_string();
    if token.is_empty() {
        return None;
    }
    let port = parsed
        .get("url")
        .and_then(Value::as_str)
        .and_then(|url| url.rsplit(':').next())
        .and_then(|tail| tail.split('/').next())
        .and_then(|raw| raw.parse::<u16>().ok())
        .or_else(|| parsed.get("port").and_then(Value::as_u64).map(|p| p as u16))
        .filter(|&p| p > 0)?;
    Some((port, token))
}

pub fn check_token(expected: &str, presented: &str) -> bool {
    !expected.is_empty() && expected == presented
}

pub fn offline_receipt(id: &str, op: &str) -> Receipt {
    Receipt::new(
        id,
        op,
        ReceiptStatus::Failed,
        "",
        false,
        None,
        Some(DispatchError::RuntimeOffline.code().into()),
    )
}

pub fn bad_token_receipt(id: &str, op: &str) -> Receipt {
    Receipt::new(
        id,
        op,
        ReceiptStatus::Rejected,
        "",
        false,
        None,
        Some("bad_token".into()),
    )
}

pub(super) fn inherited_parent(explicit: Option<&String>, from: &str) -> Option<String> {
    if let Some(parent) = explicit.filter(|value| !value.is_empty()) {
        return Some(parent.clone());
    }
    if is_caller_endpoint(from) {
        Some(from.to_string())
    } else {
        None
    }
}

pub(super) fn is_test_binary_path(exe: &std::path::Path) -> bool {
    let in_deps = exe
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("deps"));
    let test_stem = exe
        .file_stem()
        .and_then(|s| s.to_str())
        .is_some_and(|stem| {
            stem.starts_with("kite_code-")
                || (stem.starts_with("kite-") && stem != "kite-code")
        });
    in_deps || test_stem
}

pub(super) fn running_under_test() -> bool {
    if cfg!(test) {
        return true;
    }
    std::env::current_exe()
        .map(|exe| is_test_binary_path(&exe))
        .unwrap_or(false)
}

fn shim_matches_metadata(src: &std::fs::Metadata, dest: &std::fs::Metadata) -> bool {
    if src.len() != dest.len() {
        return false;
    }
    match (src.modified(), dest.modified()) {
        (Ok(s_mod), Ok(d_mod)) => s_mod <= d_mod,
        _ => false,
    }
}

pub(crate) fn write_shim_to_dir(dir: &std::path::Path, current_exe: &std::path::Path) {
    let _ = std::fs::create_dir_all(dir);
    let console_name = if cfg!(windows) { "kite.exe" } else { "kite" };
    let sibling_console = current_exe.parent().map(|parent| parent.join(console_name));
    let target_exe = if let Some(src) = sibling_console.filter(|path| path.is_file()) {
        let dest = dir.join(console_name);
        if dest != src {
            let needs_copy = match (std::fs::metadata(&src), std::fs::metadata(&dest)) {
                (Ok(s), Ok(d)) => !shim_matches_metadata(&s, &d),
                (Ok(_), Err(_)) => true,
                _ => false,
            };
            if needs_copy {
                let tmp = dir.join(format!("{console_name}.tmp"));
                if std::fs::copy(&src, &tmp).is_ok() && std::fs::rename(&tmp, &dest).is_err() {
                    let _ = std::fs::remove_file(&tmp);
                    let _ = std::fs::copy(&src, &dest);
                }
            }
        }
        if dest.is_file() {
            dest
        } else {
            src
        }
    } else {
        current_exe.to_path_buf()
    };

    #[cfg(windows)]
    {
        let script = format!("@echo off\r\n\"{}\" %*\r\n", target_exe.display());
        let _ = std::fs::write(dir.join("kite.cmd"), script);
    }
    #[cfg(not(windows))]
    {
        let path = dir.join("kite");
        if path != target_exe {
            let script = format!("#!/usr/bin/env sh\nexec \"{}\" \"$@\"\n", target_exe.display());
            let _ = std::fs::write(&path, script);
        }
    }
}

/// Writes `kite.cmd` (and copies companion console `kite.exe`) next to app data so a terminal can call `kite` with synchronous stdio,
/// and ensures the shim `bin` folder is registered on Windows User `PATH`.
pub fn install_kite_shim() -> std::path::PathBuf {
    let dir = crate::persist::roaming_app_dir().join("bin");
    if running_under_test() {
        return dir;
    }
    if let Ok(exe) = std::env::current_exe() {
        write_shim_to_dir(&dir, &exe);
    }
    let _ = crate::user_path::ensure_kite_bin_on_user_path(&dir);
    dir
}

pub(super) fn user_home_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(std::path::PathBuf::from)
}

pub(super) fn existing_skill_roots(home: &std::path::Path) -> Vec<std::path::PathBuf> {
    [
        home.join(".claude").join("skills"),
        home.join(".grok").join("skills"),
        home.join(".codex").join("skills"),
        home.join(".cursor").join("skills"),
        home.join(".gemini").join("antigravity-cli").join("skills"),
        home.join(".gemini").join("antigravity").join("skills"),
        home.join(".gemini").join("skills"),
        home.join(".agents").join("skills"),
        home.join(".config").join("agents").join("skills"),
        home.join(".config").join("opencode").join("skills"),
        home.join(".copilot").join("skills"),
        home.join(".kimi").join("skills"),
        home.join(".amp").join("skills"),
        home.join(".config").join("amp").join("skills"),
        home.join(".factory").join("skills"),
        home.join(".droid").join("skills"),
    ]
    .into_iter()
    .filter(|root| root.is_dir())
    .collect()
}

/// Copies the manual into each existing user skill root as `kite-dispatch/SKILL.md`.
/// A missing root is left untouched.
#[allow(dead_code)]
pub(crate) fn copy_skill_into_existing_roots(home: &std::path::Path, text: &str) {
    for root in existing_skill_roots(home) {
        let dest = root.join("kite-dispatch");
        if std::fs::create_dir_all(&dest).is_ok() {
            let _ = std::fs::write(dest.join("SKILL.md"), text);
        }
    }
}

/// Removes legacy loose `kite-dispatch/SKILL.md` files (and the `kite-dispatch`
/// directory if empty) across all 16 global skill roots under `home`.
pub fn cleanup_legacy_dispatch_skills(home: &std::path::Path) {
    for root in existing_skill_roots(home) {
        let dir = root.join("kite-dispatch");
        let skill_file = dir.join("SKILL.md");
        if skill_file.is_file() {
            let _ = std::fs::remove_file(&skill_file);
        }
        if dir.is_dir() {
            let _ = std::fs::remove_dir(&dir);
        }
    }
}

fn write_if_changed(path: &std::path::Path, content: &str) {
    if path.is_file() {
        if let Ok(existing) = std::fs::read_to_string(path) {
            if existing == content {
                return;
            }
        }
    }
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, content);
}

fn upsert_managed_rule_block(path: &std::path::Path, rules_markdown: &str) {
    const START_MARKER: &str = "<!-- kite-dispatch:start -->";
    const END_MARKER: &str = "<!-- kite-dispatch:end -->";
    let block = rules_markdown.trim();
    if path.is_file() {
        if let Ok(existing) = std::fs::read_to_string(path) {
            if let (Some(start_idx), Some(end_rel)) = (
                existing.find(START_MARKER),
                existing.find(END_MARKER),
            ) {
                if start_idx <= end_rel {
                    let end_idx = end_rel + END_MARKER.len();
                    let mut updated = String::with_capacity(existing.len() + block.len());
                    updated.push_str(&existing[..start_idx]);
                    updated.push_str(block);
                    updated.push_str(&existing[end_idx..]);
                    write_if_changed(path, &updated);
                    return;
                }
            }
            let trimmed_existing = existing.trim_end();
            let updated = if trimmed_existing.is_empty() {
                format!("{block}\n")
            } else {
                format!("{trimmed_existing}\n\n{block}\n")
            };
            write_if_changed(path, &updated);
            return;
        }
    }
    write_if_changed(path, &format!("{block}\n"));
}

fn format_dispatch_hook_command(raw_cmd: &str, fallback_json: Option<&str>) -> String {
    #[cfg(windows)]
    {
        let fb_stmt = match fallback_json {
            Some(fb) => format!("echo {fb}"),
            None => "ver >nul".to_string(),
        };
        let run_stmt = if let Some(sub_args) = raw_cmd.strip_prefix("kite ") {
            format!(
                r#"if exist "%APPDATA%\Kite Code\bin\kite.exe" ("%APPDATA%\Kite Code\bin\kite.exe" {sub_args}) else (where /q kite >nul 2>nul & if errorlevel 1 ({fb_stmt}) else ({raw_cmd}))"#
            )
        } else {
            format!(
                "where /q kite >nul 2>nul & if errorlevel 1 ({fb_stmt}) else ({raw_cmd})"
            )
        };
        format!(
            r#"set _K=& (if "%KITE_DISPATCH%"=="1" set _K=1) & (if defined KITE_AGENT_ID set _K=1) & if defined _K ({run_stmt}) else ({fb_stmt})"#
        )
    }
    #[cfg(not(windows))]
    {
        let fb_stmt = match fallback_json {
            Some(fb) => format!("printf '%s\\n' '{fb}'"),
            None => "true".to_string(),
        };
        format!(
            r#"if [ "$KITE_DISPATCH" = "1" ] || [ -n "$KITE_AGENT_ID" ]; then if command -v kite >/dev/null 2>&1; then {raw_cmd}; else {fb_stmt}; fi; else {fb_stmt}; fi"#
        )
    }
}

#[derive(Clone, Copy)]
enum McpServerAction<'a> {
    Keep,
    Set(&'a Value),
    Remove,
}

fn merge_nested_hook_and_mcp_json(
    json_path: &std::path::Path,
    event_key: &str,
    matcher: &str,
    hook_cmd: &str,
    timeout_secs: Option<u64>,
    mcp_action: McpServerAction<'_>,
) -> String {
    let mut root: Value = if json_path.is_file() {
        std::fs::read_to_string(json_path)
            .ok()
            .and_then(|raw| serde_json::from_str(raw.trim_start_matches('\u{feff}')).ok())
            .unwrap_or_else(|| json!({}))
    } else {
        json!({})
    };

    if !root.is_object() {
        root = json!({});
    }
    let obj = root.as_object_mut().expect("object");
    let hooks_val = obj.entry("hooks").or_insert_with(|| json!({}));
    if !hooks_val.is_object() {
        *hooks_val = json!({});
    }
    let hooks_obj = hooks_val.as_object_mut().expect("hooks object");
    let event_val = hooks_obj.entry(event_key).or_insert_with(|| json!([]));
    if !event_val.is_array() {
        *event_val = json!([]);
    }
    let event_arr = event_val.as_array_mut().expect("event array");
    event_arr.retain(|item| {
        !item
            .get("hooks")
            .and_then(Value::as_array)
            .map(|inner| {
                inner.iter().any(|entry| {
                    entry
                        .get("command")
                        .and_then(Value::as_str)
                        .is_some_and(|c| c.contains("kite dispatch hook-subagent"))
                })
            })
            .unwrap_or(false)
    });
    let mut hook_item = json!({
        "type": "command",
        "command": hook_cmd
    });
    if let Some(t) = timeout_secs {
        hook_item["timeout"] = json!(t);
    }
    event_arr.push(json!({
        "matcher": matcher,
        "hooks": [hook_item]
    }));

    match mcp_action {
        McpServerAction::Keep => {}
        McpServerAction::Set(entry) => {
            let mcp_val = obj.entry("mcpServers").or_insert_with(|| json!({}));
            if !mcp_val.is_object() {
                *mcp_val = json!({});
            }
            if let Some(mcp_obj) = mcp_val.as_object_mut() {
                mcp_obj.insert("kite-dispatch".to_string(), entry.clone());
            }
        }
        McpServerAction::Remove => {
            if let Some(mcp_obj) = obj.get_mut("mcpServers").and_then(Value::as_object_mut) {
                mcp_obj.remove("kite-dispatch");
            }
        }
    }

    let serialized = serde_json::to_string_pretty(&root).unwrap_or_else(|_| "{}".to_string());
    write_if_changed(json_path, &serialized);
    serialized
}

fn upsert_codex_config_toml(
    config_path: &std::path::Path,
    hooks_sha256: &str,
    mcp_entry: Option<&Value>,
) {
    const START_MARKER: &str = "# kite-dispatch:start";
    const END_MARKER: &str = "# kite-dispatch:end";
    let block = match mcp_entry {
        Some(entry) if entry.get("type").and_then(Value::as_str) == Some("http") => {
            let url = entry.get("url").and_then(Value::as_str).unwrap_or("");
            let auth = entry
                .pointer("/headers/Authorization")
                .and_then(Value::as_str)
                .unwrap_or("");
            format!(
                "{START_MARKER}\n[mcp_servers.kite-dispatch]\nurl = \"{url}\"\nhttp_headers = {{ Authorization = \"{auth}\" }}\napproval_mode = \"approve\"\ntrusted_hash = \"{hooks_sha256}\"\n{END_MARKER}"
            )
        }
        Some(_) => format!(
            "{START_MARKER}\n[mcp_servers.kite-dispatch]\ncommand = \"kite\"\nargs = [\"dispatch\", \"mcp\"]\napproval_mode = \"approve\"\ntrusted_hash = \"{hooks_sha256}\"\n{END_MARKER}"
        ),
        None => format!(
            "{START_MARKER}\n# kite-dispatch MCP disabled (McpProfile::None)\n{END_MARKER}"
        ),
    };

    if config_path.is_file() {
        if let Ok(existing) = std::fs::read_to_string(config_path) {
            if let (Some(start_idx), Some(end_rel)) =
                (existing.find(START_MARKER), existing.find(END_MARKER))
            {
                if start_idx <= end_rel {
                    let end_idx = end_rel + END_MARKER.len();
                    let mut updated = String::with_capacity(existing.len() + block.len());
                    updated.push_str(&existing[..start_idx]);
                    updated.push_str(&block);
                    updated.push_str(&existing[end_idx..]);
                    write_if_changed(config_path, &updated);
                    return;
                }
            }
            let trimmed_existing = existing.trim_end();
            let updated = if trimmed_existing.is_empty() {
                format!("{block}\n")
            } else {
                format!("{trimmed_existing}\n\n{block}\n")
            };
            write_if_changed(config_path, &updated);
            return;
        }
    }
    write_if_changed(config_path, &format!("{block}\n"));
}

const OPENCODE_DISPATCH_PLUGIN_TS: &str = r#"// kite-dispatch OpenCode plugin — routes subagent and shell dispatch calls through `kite dispatch hook-subagent`.
import { execFileSync } from "node:child_process";

function evaluateDispatchHook(tool: string, args: Record<string, unknown>): Record<string, unknown> | null {
  if (!tool || !args) return null;
  try {
    const payload = JSON.stringify({ tool_name: tool, tool_input: args });
    const out = execFileSync(
      "kite",
      ["dispatch", "hook-subagent", "--agent", "opencode", "--input", payload],
      { encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "pipe"] }
    );
    const parsed = JSON.parse(out.trim() || "{}");
    if (parsed && typeof parsed.overwrite === "object" && parsed.overwrite !== null) {
      return parsed.overwrite as Record<string, unknown>;
    }
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return null;
    }
    const status = typeof err?.status === "number" ? err.status : 0;
    const stderr = String(err?.stderr ?? "").trim();
    const stdout = String(err?.stdout ?? "").trim();
    if (status === 2 || stderr || stdout) {
      throw new Error(stderr || stdout || `Blocked by Kite policy hook (exit ${status}).`);
    }
  }
  return null;
}

export default {
  id: "kite-dispatch",
  name: "Kite Subagent & Swarm Dispatch",
  async server() {
    return {
      "tool.execute.before": async (input: any, output: any) => {
        const tool = String(input?.tool ?? input?.name ?? "");
        const args = output?.args ?? input?.args;
        if (!args || typeof args !== "object") return;
        const updated = evaluateDispatchHook(tool, args);
        if (updated) Object.assign(args, updated);
      },
    };
  },
};
"#;

/// Cleans up legacy loose `kite-dispatch/SKILL.md` directories and provisions
/// the unified `kite-dispatch` plugin, hooks, MCP config, and `<2 KB` `rules/AGENTS.md`
/// across all detected agent roots under `home`.
pub fn install_dispatch_integrations_at(home: &std::path::Path, rules_markdown: &str) {
    let hub_info = if !running_under_test()
        && std::env::var("KITE_MCP_HTTP_HUB")
            .ok()
            .is_some_and(|v| v.trim() == "1")
    {
        read_disk_mcp_hub_info()
    } else {
        None
    };
    let use_http_hub = std::env::var("KITE_MCP_HTTP_HUB")
        .ok()
        .is_some_and(|v| v.trim() == "1");
    let hub_ref = hub_info.as_ref().map(|(p, t)| (*p, t.as_str()));
    install_dispatch_integrations_with_profile_at(
        home,
        rules_markdown,
        McpProfile::Full,
        hub_ref,
        use_http_hub,
    );
}

/// Provisions `kite-dispatch` plugin, hooks, rules, and MCP registration according to `profile`.
pub fn install_dispatch_integrations_with_profile_at(
    home: &std::path::Path,
    rules_markdown: &str,
    profile: McpProfile,
    hub_info: Option<(u16, &str)>,
    use_http_hub: bool,
) {
    use sha2::{Digest, Sha256};

    let mcp_entry = mcp_entry_for_profile_with_http(profile, hub_info, use_http_hub);
    let mcp_action = match mcp_entry.as_ref() {
        Some(entry) => McpServerAction::Set(entry),
        None => McpServerAction::Remove,
    };

    // 1. Remove legacy loose `skills/kite-dispatch/SKILL.md` pollution.
    cleanup_legacy_dispatch_skills(home);

    // 2. Provision Antigravity plugin at `~/.gemini/config/plugins/kite-dispatch`.
    let agy_plugin_dir = home
        .join(".gemini")
        .join("config")
        .join("plugins")
        .join("kite-dispatch");
    let plugin_json = serde_json::to_string_pretty(&json!({
        "name": "kite-dispatch",
        "version": env!("CARGO_PKG_VERSION"),
        "description": "Kite cross-provider subagent and swarm orchestration plugin for Antigravity",
        "hooks": "./hooks.json",
        "mcpServers": "./mcp_config.json"
    }))
    .unwrap_or_default();
    let agy_hook_cmd = format_dispatch_hook_command(
        "kite dispatch hook-subagent --agent antigravity",
        Some(r#"{"decision":"allow"}"#),
    );
    let hooks_json = serde_json::to_string_pretty(&json!({
        "kite-dispatch": {
            "PreToolUse": [
                {
                    "matcher": "invoke_subagent|define_subagent|run_command|write_to_file|replace_file_content|multi_replace_file_content|edit_file|write_file",
                    "hooks": [
                        {
                            "type": "command",
                            "timeout": 5,
                            "command": agy_hook_cmd
                        }
                    ]
                }
            ]
        }
    }))
    .unwrap_or_default();
    let mcp_config_json = match mcp_entry.as_ref() {
        Some(entry) => serde_json::to_string_pretty(&json!({
            "mcpServers": {
                "kite-dispatch": entry
            }
        }))
        .unwrap_or_default(),
        None => serde_json::to_string_pretty(&json!({
            "mcpServers": {}
        }))
        .unwrap_or_default(),
    };
    let rules_body = format!("{}\n", rules_markdown.trim());

    write_if_changed(&agy_plugin_dir.join("plugin.json"), &plugin_json);
    write_if_changed(&agy_plugin_dir.join("hooks.json"), &hooks_json);
    write_if_changed(&agy_plugin_dir.join("mcp_config.json"), &mcp_config_json);
    write_if_changed(
        &agy_plugin_dir.join("rules").join("AGENTS.md"),
        &rules_body,
    );

    // 3. Non-destructively merge into existing agent directories on disk.
    // Claude (`~/.claude/settings.json` + `~/.claude/CLAUDE.md`)
    let claude_dir = home.join(".claude");
    if claude_dir.is_dir() {
        let claude_cmd =
            format_dispatch_hook_command("kite dispatch hook-subagent --agent claude", None);
        merge_nested_hook_and_mcp_json(
            &claude_dir.join("settings.json"),
            "PreToolUse",
            "Task|Agent|Bash|Write|Edit|MultiEdit|NotebookEdit",
            &claude_cmd,
            Some(5),
            mcp_action,
        );
        upsert_managed_rule_block(&claude_dir.join("CLAUDE.md"), rules_markdown);
    }

    // Codex (`~/.codex/hooks.json` + `~/.codex/config.toml` + `~/.codex/AGENTS.md`)
    let codex_dir = home.join(".codex");
    if codex_dir.is_dir() {
        let codex_cmd =
            format_dispatch_hook_command("kite dispatch hook-subagent --agent codex", None);
        let hooks_raw = merge_nested_hook_and_mcp_json(
            &codex_dir.join("hooks.json"),
            "PreToolUse",
            "Task|Agent|Bash|Write|Edit|MultiEdit|apply_patch",
            &codex_cmd,
            None,
            McpServerAction::Keep,
        );
        let mut hasher = Sha256::new();
        hasher.update(hooks_raw.as_bytes());
        let hooks_sha256 = format!("{:x}", hasher.finalize());
        upsert_codex_config_toml(
            &codex_dir.join("config.toml"),
            &hooks_sha256,
            mcp_entry.as_ref(),
        );
        upsert_managed_rule_block(&codex_dir.join("AGENTS.md"), rules_markdown);
    }

    // Gemini CLI (`~/.gemini/settings.json` + `~/.gemini/GEMINI.md`)
    let gemini_dir = home.join(".gemini");
    if gemini_dir.is_dir() {
        let gemini_cmd = format_dispatch_hook_command(
            "kite dispatch hook-subagent --agent gemini",
            Some(r#"{"decision":"allow"}"#),
        );
        merge_nested_hook_and_mcp_json(
            &gemini_dir.join("settings.json"),
            "BeforeTool",
            "run_shell_command|Task|Agent|write_file|replace|edit_file",
            &gemini_cmd,
            Some(5),
            mcp_action,
        );
        upsert_managed_rule_block(&gemini_dir.join("GEMINI.md"), rules_markdown);
    }

    // Cursor (`~/.cursor/hooks.json` + `~/.cursor/mcp.json` + `~/.cursor/rules/kite-dispatch.mdc`)
    let cursor_dir = home.join(".cursor");
    if cursor_dir.is_dir() {
        let cursor_hooks_path = cursor_dir.join("hooks.json");
        let mut root: Value = if cursor_hooks_path.is_file() {
            std::fs::read_to_string(&cursor_hooks_path)
                .ok()
                .and_then(|raw| serde_json::from_str(raw.trim_start_matches('\u{feff}')).ok())
                .unwrap_or_else(|| json!({ "version": 1, "hooks": {} }))
        } else {
            json!({ "version": 1, "hooks": {} })
        };
        if !root.is_object() {
            root = json!({ "version": 1, "hooks": {} });
        }
        let obj = root.as_object_mut().expect("object");
        obj.entry("version").or_insert_with(|| json!(1));
        let hooks_val = obj.entry("hooks").or_insert_with(|| json!({}));
        if !hooks_val.is_object() {
            *hooks_val = json!({});
        }
        let pre_val = hooks_val
            .as_object_mut()
            .expect("hooks obj")
            .entry("preToolUse")
            .or_insert_with(|| json!([]));
        if !pre_val.is_array() {
            *pre_val = json!([]);
        }
        let pre_arr = pre_val.as_array_mut().expect("preToolUse array");
        pre_arr.retain(|entry| {
            !entry
                .get("command")
                .and_then(Value::as_str)
                .is_some_and(|c| c.contains("kite dispatch hook-subagent"))
        });
        let cursor_cmd =
            format_dispatch_hook_command("kite dispatch hook-subagent --agent cursor", Some("{}"));
        pre_arr.push(json!({
            "matcher": "Shell|Task|Agent|Write|Edit|Delete|edit_file|write_file",
            "command": cursor_cmd
        }));
        if let Ok(serialized) = serde_json::to_string_pretty(&root) {
            write_if_changed(&cursor_hooks_path, &serialized);
        }
        let cursor_mcp_path = cursor_dir.join("mcp.json");
        let mut mcp_root: Value = if cursor_mcp_path.is_file() {
            std::fs::read_to_string(&cursor_mcp_path)
                .ok()
                .and_then(|raw| serde_json::from_str(raw.trim_start_matches('\u{feff}')).ok())
                .unwrap_or_else(|| json!({}))
        } else {
            json!({})
        };
        if !mcp_root.is_object() {
            mcp_root = json!({});
        }
        let mcp_servers = mcp_root
            .as_object_mut()
            .expect("object")
            .entry("mcpServers")
            .or_insert_with(|| json!({}));
        if !mcp_servers.is_object() {
            *mcp_servers = json!({});
        }
        if let Some(servers_obj) = mcp_servers.as_object_mut() {
            match mcp_entry.as_ref() {
                Some(entry) => {
                    servers_obj.insert("kite-dispatch".to_string(), entry.clone());
                }
                None => {
                    servers_obj.remove("kite-dispatch");
                }
            }
        }
        if let Ok(serialized) = serde_json::to_string_pretty(&mcp_root) {
            write_if_changed(&cursor_mcp_path, &serialized);
        }
        write_if_changed(
            &cursor_dir.join("rules").join("kite-dispatch.mdc"),
            &rules_body,
        );
    }

    // OpenCode (`~/.config/opencode/plugins/kite-dispatch.ts` + `~/.config/opencode/AGENTS.md`)
    let opencode_dir = home.join(".config").join("opencode");
    if opencode_dir.is_dir() {
        write_if_changed(
            &opencode_dir.join("plugins").join("kite-dispatch.ts"),
            OPENCODE_DISPATCH_PLUGIN_TS,
        );
        upsert_managed_rule_block(&opencode_dir.join("AGENTS.md"), rules_markdown);
    }

    // Copilot (`~/.copilot/hooks/kite-dispatch.json`)
    let copilot_dir = home.join(".copilot");
    if copilot_dir.is_dir() {
        let copilot_cmd =
            format_dispatch_hook_command("kite dispatch hook-subagent --agent copilot", None);
        let copilot_hook = serde_json::to_string_pretty(&json!({
            "version": 1,
            "hooks": {
                "PreToolUse": [
                    {
                        "type": "command",
                        "command": copilot_cmd,
                        "cwd": ".",
                        "timeout": 5
                    }
                ]
            }
        }))
        .unwrap_or_default();
        write_if_changed(
            &copilot_dir.join("hooks").join("kite-dispatch.json"),
            &copilot_hook,
        );
    }
}

/// Writes the manual that `kite dispatch skill` prints into app data, cleans up
/// legacy loose skill directories, and provisions the unified `kite-dispatch`
/// plugin/hook/MCP/rules integration across supported local agents.
pub fn install_dispatch_skill() -> std::path::PathBuf {
    let dir = crate::persist::roaming_app_dir().join("dispatch");
    let path = dir.join("SKILL.md");
    if running_under_test() {
        return path;
    }
    let _ = std::fs::create_dir_all(&dir);
    let text = skill_text();
    let _ = std::fs::write(&path, &text);
    if let Some(home) = user_home_dir() {
        let rules = compose_thread_rules_markdown();
        install_dispatch_integrations_at(&home, &rules);
    }
    path
}

/// Runs `install_dispatch_skill` at most once per desktop app process during
/// turn spawns; explicit settings/role saves still call `install_dispatch_skill` directly.
pub fn ensure_dispatch_skill_once() -> std::path::PathBuf {
    let dir = crate::persist::roaming_app_dir().join("dispatch");
    let path = dir.join("SKILL.md");
    if running_under_test() {
        return path;
    }
    static ONCE: std::sync::OnceLock<()> = std::sync::OnceLock::new();
    ONCE.get_or_init(|| {
        let _ = install_dispatch_skill();
    });
    path
}

/// Installs non-destructive `kite ctx` hooks and `kite-ctx/SKILL.md` across all
/// detected agent directories on the host.
pub fn install_ctx_integrations() -> Vec<kite_ctx::HookInstallAction> {
    if running_under_test() {
        return Vec::new();
    }
    let Some(home) = user_home_dir() else {
        return Vec::new();
    };
    let workspace = std::env::current_dir().unwrap_or_else(|_| home.clone());
    kite_ctx::apply_agent_setup(kite_ctx::AgentTarget::All, &home, &workspace, false)
        .unwrap_or_default()
}

/// Runs `install_ctx_integrations` at most once per desktop app process.
pub fn ensure_ctx_integrations_once() {
    if running_under_test() {
        return;
    }
    static ONCE: std::sync::OnceLock<()> = std::sync::OnceLock::new();
    ONCE.get_or_init(|| {
        let _ = install_ctx_integrations();
    });
}

/// `--hidden` wins. Otherwise `--pane` or a human caller asks for a pane.
pub(super) fn show_pane(hidden: bool, pane: bool, caller: Caller) -> bool {
    if hidden {
        return false;
    }
    if pane {
        return true;
    }
    caller == Caller::Human
}

pub(super) fn combine_task(file_text: Option<String>, words: Option<String>) -> Option<String> {
    match (file_text, words.filter(|value| !value.is_empty())) {
        (Some(mut file), Some(words)) => {
            file.push_str("\n\n");
            file.push_str(&words);
            Some(file)
        }
        (Some(file), None) => Some(file),
        (None, Some(words)) => Some(words),
        (None, None) => None,
    }
}

#[cfg(test)]
mod install_tests {
    use super::*;
    use crate::subagent_settings::{
        DefaultDelegation, OverridePolicy, SubagentRoleRecord, SubagentSettings, SubagentStackEntry,
    };

    #[test]
    fn install_dispatch_integrations_cleans_legacy_skills_and_provisions_plugin_hooks_mcp_and_concise_rules() {
        let home = std::env::temp_dir().join(format!(
            "kite-dispatch-integrations-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&home);

        // Seed legacy `skills/kite-dispatch/SKILL.md` across multiple roots
        let legacy_claude_skill = home
            .join(".claude")
            .join("skills")
            .join("kite-dispatch")
            .join("SKILL.md");
        let legacy_agy_skill = home
            .join(".gemini")
            .join("antigravity-cli")
            .join("skills")
            .join("kite-dispatch")
            .join("SKILL.md");
        std::fs::create_dir_all(legacy_claude_skill.parent().unwrap()).unwrap();
        std::fs::create_dir_all(legacy_agy_skill.parent().unwrap()).unwrap();
        std::fs::write(&legacy_claude_skill, "legacy claude skill").unwrap();
        std::fs::write(&legacy_agy_skill, "legacy agy skill").unwrap();

        // Seed existing agent directories
        std::fs::create_dir_all(home.join(".codex")).unwrap();
        std::fs::create_dir_all(home.join(".cursor")).unwrap();
        std::fs::write(
            home.join(".cursor").join("mcp.json"),
            r#"{"mcpServers":{"existing-tool":{"command":"node","args":["tool.js"]}}}"#,
        )
        .unwrap();
        std::fs::create_dir_all(home.join(".config").join("opencode")).unwrap();
        std::fs::create_dir_all(home.join(".copilot")).unwrap();

        let settings = SubagentSettings {
            stack: vec![SubagentStackEntry {
                provider: "grok".to_string(),
                model: "grok-4.7-build-fast".to_string(),
                effort: Some("low".to_string()),
                enabled: true,
            }],
            default_delegation: Some(DefaultDelegation {
                provider: "grok".to_string(),
                model: "grok-4.7-build-fast".to_string(),
                effort: Some("low".to_string()),
            }),
            override_policy: OverridePolicy::Ask,
        };
        let roles = vec![SubagentRoleRecord {
            slug: "review".to_string(),
            scope: "global".to_string(),
            path: "dispatch/roles/review.md".to_string(),
            command: "auto".to_string(),
            description: Some("Review a task and report findings.".to_string()),
            provider: None,
            model: None,
            effort: None,
            workspace: Some("inherit".to_string()),
            body: "Review the task.".to_string(),
        }];

        let rules_md = compose_thread_rules_markdown_with(&settings, &roles);
        install_dispatch_integrations_at(&home, &rules_md);

        // 1. Legacy skills/kite-dispatch/SKILL.md files and empty directories are removed
        assert!(!legacy_claude_skill.exists());
        assert!(!legacy_claude_skill.parent().unwrap().exists());
        assert!(!legacy_agy_skill.exists());
        assert!(!legacy_agy_skill.parent().unwrap().exists());

        // 2. Antigravity plugin files exist with expected structure
        let plugin_dir = home
            .join(".gemini")
            .join("config")
            .join("plugins")
            .join("kite-dispatch");
        assert!(plugin_dir.join("plugin.json").is_file());
        assert!(plugin_dir.join("hooks.json").is_file());
        assert!(plugin_dir.join("mcp_config.json").is_file());
        let rules_path = plugin_dir.join("rules").join("AGENTS.md");
        assert!(rules_path.is_file());

        let rules_text = std::fs::read_to_string(&rules_path).unwrap();
        assert!(
            rules_text.len() < 2048,
            "rules/AGENTS.md must stay under 2 KB, got {} bytes",
            rules_text.len()
        );
        for required in [
            "<!-- kite-dispatch:start -->",
            "<!-- kite-dispatch:end -->",
            "kite_subagent_run",
            "kite_subagent_send",
            "kite_subagent_wait",
            "kite_subagent_read",
            "kite_swarm",
            "kite dispatch run --via thread",
            "--task",
            "--count",
            "kite dispatch send thread:<id>",
            "kite dispatch swarm",
            "grok/grok-4.7-build-fast",
        ] {
            assert!(
                rules_text.contains(required),
                "rules/AGENTS.md missing `{required}`"
            );
        }
        for forbidden in ["gentle-shell", "aider", "muse", "kimi", "keys", "attach"] {
            assert!(
                !rules_text.contains(forbidden),
                "rules/AGENTS.md must not contain terminal-only token `{forbidden}`"
            );
        }

        // 3. Claude, Codex, Gemini, Cursor, OpenCode, and Copilot integrations are provisioned
        let claude_settings =
            std::fs::read_to_string(home.join(".claude").join("settings.json")).unwrap();
        assert!(claude_settings.contains("kite dispatch hook-subagent --agent claude"));
        assert!(claude_settings.contains("\"kite-dispatch\""));
        assert!(home.join(".claude").join("CLAUDE.md").is_file());

        let codex_toml =
            std::fs::read_to_string(home.join(".codex").join("config.toml")).unwrap();
        assert!(codex_toml.contains("[mcp_servers.kite-dispatch]"));
        assert!(codex_toml.contains("approval_mode = \"approve\""));
        assert!(codex_toml.contains("trusted_hash = \""));

        assert!(home.join(".gemini").join("settings.json").is_file());
        assert!(home.join(".gemini").join("GEMINI.md").is_file());
        assert!(home.join(".cursor").join("hooks.json").is_file());
        let cursor_mcp: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(home.join(".cursor").join("mcp.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(cursor_mcp["mcpServers"]["kite-dispatch"]["command"], "kite");
        assert_eq!(
            cursor_mcp["mcpServers"]["kite-dispatch"]["args"],
            serde_json::json!(["dispatch", "mcp"])
        );
        assert_eq!(cursor_mcp["mcpServers"]["existing-tool"]["command"], "node");
        assert!(home
            .join(".cursor")
            .join("rules")
            .join("kite-dispatch.mdc")
            .is_file());
        assert!(home
            .join(".config")
            .join("opencode")
            .join("plugins")
            .join("kite-dispatch.ts")
            .is_file());
        assert!(home
            .join(".copilot")
            .join("hooks")
            .join("kite-dispatch.json")
            .is_file());

        // Antigravity kite-dispatch hooks.json uses named "kite-dispatch" key, timeout, KITE_DISPATCH/KITE_AGENT_ID gate, exit-2 preserving invocation, and filesystem_write matchers
        let agy_hooks_val: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(plugin_dir.join("hooks.json")).unwrap(),
        )
        .unwrap();
        let agy_pre = &agy_hooks_val["kite-dispatch"]["PreToolUse"][0];
        let agy_matcher = agy_pre["matcher"].as_str().unwrap();
        assert!(agy_matcher.contains("write_to_file"));
        assert!(agy_matcher.contains("edit_file"));
        let agy_entry = &agy_pre["hooks"][0];
        assert_eq!(agy_entry["timeout"], 5);
        let agy_cmd = agy_entry["command"].as_str().unwrap();
        assert!(agy_cmd.contains("kite dispatch hook-subagent --agent antigravity"));
        assert!(agy_cmd.contains("KITE_DISPATCH"));
        assert!(agy_cmd.contains("KITE_AGENT_ID"));
        assert!(agy_cmd.contains("{\"decision\":\"allow\"}"));
        assert!(
            !agy_cmd.contains("|| echo") && !agy_cmd.contains("|| exit /b 0") && !agy_cmd.contains("|| true"),
            "hook wrapper must not swallow exit 2 denials: {agy_cmd}"
        );

        let claude_hooks: serde_json::Value = serde_json::from_str(&claude_settings).unwrap();
        assert!(claude_hooks["hooks"]["PreToolUse"][0]["matcher"]
            .as_str()
            .unwrap()
            .contains("Write|Edit"));
        let codex_hooks: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(home.join(".codex").join("hooks.json")).unwrap(),
        )
        .unwrap();
        assert!(codex_hooks["hooks"]["PreToolUse"][0]["matcher"]
            .as_str()
            .unwrap()
            .contains("apply_patch"));
        let cursor_hooks: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(home.join(".cursor").join("hooks.json")).unwrap(),
        )
        .unwrap();
        assert!(cursor_hooks["hooks"]["preToolUse"][0]["matcher"]
            .as_str()
            .unwrap()
            .contains("edit_file|write_file"));
        let opencode_plugin = std::fs::read_to_string(
            home.join(".config")
                .join("opencode")
                .join("plugins")
                .join("kite-dispatch.ts"),
        )
        .unwrap();
        assert!(opencode_plugin.contains("status === 2"));

        // Re-installing over legacy bare hook commands replaces without duplicating
        std::fs::write(
            home.join(".gemini").join("settings.json"),
            r#"{"hooks":{"BeforeTool":[{"matcher":"run_shell_command|Task|Agent","hooks":[{"type":"command","command":"kite dispatch hook-subagent --agent gemini"}]}]}}"#,
        )
        .unwrap();
        install_dispatch_integrations_at(&home, &rules_md);
        let gem_val: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(home.join(".gemini").join("settings.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(gem_val["hooks"]["BeforeTool"].as_array().unwrap().len(), 1);
        assert!(gem_val["hooks"]["BeforeTool"][0]["matcher"]
            .as_str()
            .unwrap()
            .contains("write_file"));
        let gem_cmd = gem_val["hooks"]["BeforeTool"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap();
        assert!(gem_cmd.contains("KITE_DISPATCH"));
        assert!(gem_cmd.contains("KITE_AGENT_ID"));
        assert!(gem_cmd.contains("{\"decision\":\"allow\"}"));
        assert!(
            !gem_cmd.contains("|| echo") && !gem_cmd.contains("|| exit /b 0") && !gem_cmd.contains("|| true"),
            "gemini hook wrapper must not swallow exit 2 denials: {gem_cmd}"
        );

        let _ = std::fs::remove_dir_all(&home);
    }

    #[cfg(windows)]
    #[test]
    fn windows_dispatch_hook_command_preserves_exit_2_when_kite_present_and_allows_when_inactive() {
        use std::os::windows::process::CommandExt;

        let tmp = std::env::temp_dir().join(format!(
            "kite-hook-cmd-exit2-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let fake_kite = tmp.join("kite.cmd");
        std::fs::write(&fake_kite, "@echo off\r\nexit /b 2\r\n").unwrap();

        let wrapped = format_dispatch_hook_command(
            "kite dispatch hook-subagent --agent antigravity",
            Some(r#"{"decision":"allow"}"#),
        );
        let cmdline = format!(r#""{wrapped}""#);
        let path_with_fake = format!(
            "{};{}",
            tmp.display(),
            std::env::var("PATH").unwrap_or_default()
        );
        // 1. Active KITE_AGENT_ID with fake kite on PATH must propagate exit 2
        let active_out = std::process::Command::new("cmd")
            .args(["/D", "/C"])
            .raw_arg(&cmdline)
            .env("PATH", &path_with_fake)
            .env("APPDATA", tmp.join("empty-appdata"))
            .env_remove("KITE_DISPATCH")
            .env("KITE_AGENT_ID", "agent-123")
            .output()
            .unwrap();
        assert_eq!(
            active_out.status.code(),
            Some(2),
            "exit 2 must propagate when KITE_AGENT_ID is active; stdout={}, stderr={}",
            String::from_utf8_lossy(&active_out.stdout),
            String::from_utf8_lossy(&active_out.stderr),
        );

        // 2. Inactive (neither KITE_DISPATCH nor KITE_AGENT_ID) must fail open with exit 0 + allow JSON
        let inactive_out = std::process::Command::new("cmd")
            .args(["/D", "/C"])
            .raw_arg(&cmdline)
            .env("PATH", &path_with_fake)
            .env("APPDATA", tmp.join("empty-appdata"))
            .env_remove("KITE_DISPATCH")
            .env_remove("KITE_AGENT_ID")
            .output()
            .unwrap();
        assert_eq!(
            inactive_out.status.code(),
            Some(0),
            "inactive wrapper must exit 0; stdout={}, stderr={}",
            String::from_utf8_lossy(&inactive_out.stdout),
            String::from_utf8_lossy(&inactive_out.stderr),
        );
        assert!(String::from_utf8_lossy(&inactive_out.stdout).contains(r#"{"decision":"allow"}"#));

        // 3. Active KITE_AGENT_ID with missing kite binary (no APPDATA bin, no PATH kite) fails open gracefully
        let missing_bin_out = std::process::Command::new("cmd")
            .args(["/D", "/C"])
            .raw_arg(&cmdline)
            .env("PATH", std::env::temp_dir())
            .env("APPDATA", tmp.join("empty-appdata"))
            .env_remove("KITE_DISPATCH")
            .env("KITE_AGENT_ID", "agent-123")
            .output()
            .unwrap();
        assert_eq!(missing_bin_out.status.code(), Some(0));
        assert!(String::from_utf8_lossy(&missing_bin_out.stdout).contains(r#"{"decision":"allow"}"#));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn mcp_entry_for_profile_supports_http_hub_opt_in_stdio_fallback_and_none() {
        // 1. None always suppresses MCP entry
        assert_eq!(mcp_entry_for_profile_with_http(McpProfile::None, None, false), None);
        assert_eq!(
            mcp_entry_for_profile_with_http(McpProfile::None, Some((43210, "tok-1")), true),
            None
        );

        // 2. Stdio fallback when HTTP hub is disabled or hub_info is absent/invalid
        let expected_stdio = serde_json::json!({
            "command": "kite",
            "args": ["dispatch", "mcp"]
        });
        assert_eq!(
            mcp_entry_for_profile_with_http(McpProfile::Full, None, false),
            Some(expected_stdio.clone())
        );
        assert_eq!(
            mcp_entry_for_profile_with_http(McpProfile::DispatchOnly, Some((43210, "tok-1")), false),
            Some(expected_stdio.clone())
        );
        assert_eq!(
            mcp_entry_for_profile_with_http(McpProfile::Full, None, true),
            Some(expected_stdio.clone())
        );
        assert_eq!(
            mcp_entry_for_profile_with_http(McpProfile::Full, Some((0, "tok-1")), true),
            Some(expected_stdio.clone())
        );
        assert_eq!(
            mcp_entry_for_profile_with_http(McpProfile::Full, Some((43210, "   ")), true),
            Some(expected_stdio.clone())
        );

        // 3. HTTP Hub entry when hub_info is Some and KITE_MCP_HTTP_HUB=1
        let expected_http = serde_json::json!({
            "type": "http",
            "url": "http://127.0.0.1:43210/mcp",
            "headers": {
                "Authorization": "Bearer secret-token-256"
            }
        });
        assert_eq!(
            mcp_entry_for_profile_with_http(McpProfile::Full, Some((43210, "secret-token-256")), true),
            Some(expected_http.clone())
        );
        assert_eq!(
            mcp_entry_for_profile_with_http(
                McpProfile::DispatchOnly,
                Some((43210, "secret-token-256")),
                true
            ),
            Some(expected_http.clone())
        );

        // 4. Verify env-backed `mcp_entry_for_profile` with `KITE_MCP_HTTP_HUB=1`
        static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _guard = ENV_LOCK.lock().unwrap();
        let prev = std::env::var_os("KITE_MCP_HTTP_HUB");
        std::env::set_var("KITE_MCP_HTTP_HUB", "1");
        let env_http = mcp_entry_for_profile(McpProfile::Full, Some((43210, "secret-token-256")));
        std::env::remove_var("KITE_MCP_HTTP_HUB");
        let env_stdio = mcp_entry_for_profile(McpProfile::Full, Some((43210, "secret-token-256")));
        if let Some(old) = prev {
            std::env::set_var("KITE_MCP_HTTP_HUB", old);
        }
        assert_eq!(env_http, Some(expected_http));
        assert_eq!(env_stdio, Some(expected_stdio));
    }

    #[test]
    fn install_dispatch_integrations_with_profile_writes_http_hub_and_handles_none() {
        let home = std::env::temp_dir().join(format!(
            "kite-dispatch-http-profile-test-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        std::fs::create_dir_all(home.join(".codex")).unwrap();
        std::fs::create_dir_all(home.join(".gemini")).unwrap();
        std::fs::create_dir_all(home.join(".cursor")).unwrap();
        std::fs::write(
            home.join(".cursor").join("mcp.json"),
            r#"{"mcpServers":{"existing":{"command":"node","args":["s.js"]}}}"#,
        )
        .unwrap();

        install_dispatch_integrations_with_profile_at(
            &home,
            "<!-- kite-dispatch:start -->\nrules\n<!-- kite-dispatch:end -->",
            McpProfile::Full,
            Some((49152, "hub-secret-abc")),
            true,
        );

        let agy_mcp: Value = serde_json::from_str(
            &std::fs::read_to_string(
                home.join(".gemini")
                    .join("config")
                    .join("plugins")
                    .join("kite-dispatch")
                    .join("mcp_config.json"),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(agy_mcp["mcpServers"]["kite-dispatch"]["type"], "http");
        assert_eq!(
            agy_mcp["mcpServers"]["kite-dispatch"]["url"],
            "http://127.0.0.1:49152/mcp"
        );
        assert_eq!(
            agy_mcp["mcpServers"]["kite-dispatch"]["headers"]["Authorization"],
            "Bearer hub-secret-abc"
        );

        let cursor_mcp: Value = serde_json::from_str(
            &std::fs::read_to_string(home.join(".cursor").join("mcp.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(cursor_mcp["mcpServers"]["kite-dispatch"]["type"], "http");
        assert_eq!(cursor_mcp["mcpServers"]["existing"]["command"], "node");

        let claude_settings: Value = serde_json::from_str(
            &std::fs::read_to_string(home.join(".claude").join("settings.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            claude_settings["mcpServers"]["kite-dispatch"]["url"],
            "http://127.0.0.1:49152/mcp"
        );

        let codex_toml =
            std::fs::read_to_string(home.join(".codex").join("config.toml")).unwrap();
        assert!(codex_toml.contains("url = \"http://127.0.0.1:49152/mcp\""));
        assert!(codex_toml.contains("Authorization = \"Bearer hub-secret-abc\""));

        // Re-running with McpProfile::None strips kite-dispatch while keeping existing servers
        install_dispatch_integrations_with_profile_at(
            &home,
            "<!-- kite-dispatch:start -->\nrules\n<!-- kite-dispatch:end -->",
            McpProfile::None,
            None,
            false,
        );
        let cursor_after_none: Value = serde_json::from_str(
            &std::fs::read_to_string(home.join(".cursor").join("mcp.json")).unwrap(),
        )
        .unwrap();
        assert!(cursor_after_none["mcpServers"].get("kite-dispatch").is_none());
        assert_eq!(cursor_after_none["mcpServers"]["existing"]["command"], "node");

        let _ = std::fs::remove_dir_all(&home);
    }
}

