use crate::dispatch::address::is_caller_endpoint;
use crate::dispatch::policy::{ChildrenMode, RunInput, SendInput, Service, WaitInput};
use crate::dispatch::port::Port;
use crate::dispatch::presence::PresenceState;
use crate::dispatch::types::{exit_code, Caller, DispatchError, Family, Receipt, ReceiptStatus};
use super::*;

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

/// Writes `kite.cmd` (and copies companion console `kite.exe`) next to app data so a terminal can call `kite` with synchronous stdio.
pub fn install_kite_shim() -> std::path::PathBuf {
    let dir = crate::persist::roaming_app_dir().join("bin");
    if running_under_test() {
        return dir;
    }
    if let Ok(exe) = std::env::current_exe() {
        write_shim_to_dir(&dir, &exe);
    }
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

fn merge_nested_hook_and_mcp_json(
    json_path: &std::path::Path,
    event_key: &str,
    matcher: &str,
    hook_cmd: &str,
    include_mcp_server: bool,
) -> String {
    use serde_json::{json, Value};

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
                        .is_some_and(|c| c.starts_with("kite dispatch hook-subagent"))
                })
            })
            .unwrap_or(false)
    });
    event_arr.push(json!({
        "matcher": matcher,
        "hooks": [
            {
                "type": "command",
                "command": hook_cmd
            }
        ]
    }));

    if include_mcp_server {
        let mcp_val = obj.entry("mcpServers").or_insert_with(|| json!({}));
        if !mcp_val.is_object() {
            *mcp_val = json!({});
        }
        if let Some(mcp_obj) = mcp_val.as_object_mut() {
            mcp_obj.insert(
                "kite-dispatch".to_string(),
                json!({
                    "command": "kite",
                    "args": ["dispatch", "mcp"]
                }),
            );
        }
    }

    let serialized = serde_json::to_string_pretty(&root).unwrap_or_else(|_| "{}".to_string());
    write_if_changed(json_path, &serialized);
    serialized
}

fn upsert_codex_config_toml(config_path: &std::path::Path, hooks_sha256: &str) {
    const START_MARKER: &str = "# kite-dispatch:start";
    const END_MARKER: &str = "# kite-dispatch:end";
    let block = format!(
        "{START_MARKER}\n[mcp_servers.kite-dispatch]\ncommand = \"kite\"\nargs = [\"dispatch\", \"mcp\"]\napproval_mode = \"approve\"\ntrusted_hash = \"{hooks_sha256}\"\n{END_MARKER}"
    );

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
      { encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "ignore"] }
    );
    const parsed = JSON.parse(out.trim() || "{}");
    if (parsed && typeof parsed.overwrite === "object" && parsed.overwrite !== null) {
      return parsed.overwrite as Record<string, unknown>;
    }
  } catch {
    // Fail-open passthrough
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
    use serde_json::{json, Value};
    use sha2::{Digest, Sha256};

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
    let hooks_json = serde_json::to_string_pretty(&json!({
        "hooks": {
            "PreToolUse": [
                {
                    "matcher": "invoke_subagent|define_subagent|run_command",
                    "hooks": [
                        {
                            "type": "command",
                            "command": "kite dispatch hook-subagent --agent antigravity"
                        }
                    ]
                }
            ]
        }
    }))
    .unwrap_or_default();
    let mcp_config_json = serde_json::to_string_pretty(&json!({
        "mcpServers": {
            "kite-dispatch": {
                "command": "kite",
                "args": ["dispatch", "mcp"]
            }
        }
    }))
    .unwrap_or_default();
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
        merge_nested_hook_and_mcp_json(
            &claude_dir.join("settings.json"),
            "PreToolUse",
            "Task|Agent|Bash",
            "kite dispatch hook-subagent --agent claude",
            true,
        );
        upsert_managed_rule_block(&claude_dir.join("CLAUDE.md"), rules_markdown);
    }

    // Codex (`~/.codex/hooks.json` + `~/.codex/config.toml` + `~/.codex/AGENTS.md`)
    let codex_dir = home.join(".codex");
    if codex_dir.is_dir() {
        let hooks_raw = merge_nested_hook_and_mcp_json(
            &codex_dir.join("hooks.json"),
            "PreToolUse",
            "Task|Agent|Bash",
            "kite dispatch hook-subagent --agent codex",
            false,
        );
        let mut hasher = Sha256::new();
        hasher.update(hooks_raw.as_bytes());
        let hooks_sha256 = format!("{:x}", hasher.finalize());
        upsert_codex_config_toml(&codex_dir.join("config.toml"), &hooks_sha256);
        upsert_managed_rule_block(&codex_dir.join("AGENTS.md"), rules_markdown);
    }

    // Gemini CLI (`~/.gemini/settings.json` + `~/.gemini/GEMINI.md`)
    let gemini_dir = home.join(".gemini");
    if gemini_dir.is_dir() {
        merge_nested_hook_and_mcp_json(
            &gemini_dir.join("settings.json"),
            "BeforeTool",
            "run_shell_command|Task|Agent",
            "kite dispatch hook-subagent --agent gemini",
            true,
        );
        upsert_managed_rule_block(&gemini_dir.join("GEMINI.md"), rules_markdown);
    }

    // Cursor (`~/.cursor/hooks.json` + `~/.cursor/rules/kite-dispatch.mdc`)
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
                .is_some_and(|c| c.starts_with("kite dispatch hook-subagent"))
        });
        pre_arr.push(json!({
            "matcher": "Shell|Task|Agent",
            "command": "kite dispatch hook-subagent --agent cursor"
        }));
        if let Ok(serialized) = serde_json::to_string_pretty(&root) {
            write_if_changed(&cursor_hooks_path, &serialized);
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
        let copilot_hook = serde_json::to_string_pretty(&json!({
            "version": 1,
            "hooks": {
                "PreToolUse": [
                    {
                        "type": "command",
                        "command": "kite dispatch hook-subagent --agent copilot",
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

        let _ = std::fs::remove_dir_all(&home);
    }
}

