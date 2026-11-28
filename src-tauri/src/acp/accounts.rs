//! ACP account management and provider MCP server discovery.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub fn user_home_dir() -> PathBuf {
    if let Ok(p) = std::env::var("USERPROFILE") {
        PathBuf::from(p)
    } else if let Ok(h) = std::env::var("HOME") {
        PathBuf::from(h)
    } else {
        PathBuf::from(".")
    }
}

/// Resolves the Antigravity ACP or CLI binary across standard installation paths.
pub fn resolve_antigravity_acp_binary() -> Option<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        candidates.push(PathBuf::from(&local).join("agy").join("bin").join("agy.exe"));
        candidates.push(PathBuf::from(&local).join("Programs").join("antigravity-acp").join("antigravity-acp.exe"));
    }
    if let Ok(user) = std::env::var("USERPROFILE") {
        candidates.push(PathBuf::from(&user).join(".gemini").join("antigravity").join("antigravity-acp.exe"));
    }

    for c in candidates {
        if c.is_file() {
            return Some(c);
        }
    }

    if let Ok(path_var) = std::env::var("PATH") {
        for segment in std::env::split_paths(&path_var) {
            let agy = segment.join("agy.exe");
            if agy.is_file() {
                return Some(agy);
            }
            let acp = segment.join("antigravity-acp.exe");
            if acp.is_file() {
                return Some(acp);
            }
        }
    }

    None
}

/// Discovers native MCP servers grouped by provider (Antigravity, Claude Code, Codex, Cursor, Gemini, OpenCode, and Kite built-in).
pub fn list_provider_mcp_servers_impl(request: Option<Value>) -> Value {
    let home = user_home_dir();
    list_provider_mcp_servers_with_home(&home, request)
}

pub fn list_provider_mcp_servers_with_home(home: &Path, request: Option<Value>) -> Value {
    let plugin_servers = crate::plugin_runtime::mcp_bridge::list_active_plugin_mcp_servers(&[]);
    list_provider_mcp_servers_with_home_and_plugins(home, request, plugin_servers)
}

fn list_provider_mcp_servers_with_home_and_plugins(
    home: &Path,
    request: Option<Value>,
    plugin_servers: Vec<Value>,
) -> Value {
    let filter_provider = request
        .as_ref()
        .and_then(|v| v.get("provider").or_else(|| v.get("engine")))
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_lowercase());
    let mut providers: Vec<Value> = Vec::new();
    let mut all_servers: Vec<Value> = Vec::new();

    // 1. Built-in Kite Native MCP (Available to all providers)
    let kite_builtin = json!({
        "id": "mcp:kite:kite-tasks",
        "name": "kite-tasks",
        "provider": "kite",
        "providerLabel": "Kite Native",
        "transport": "stdio",
        "status": "connected",
        "builtin": true,
        "description": "Local workspace task board & ticket orchestration MCP server.",
        "toolCount": 5,
        "tools": ["list_tasks", "get_task", "create_task", "update_task", "add_task_comment"],
        "sourcePath": "kite mcp tasks"
    });
    all_servers.push(kite_builtin.clone());

    // 2. Antigravity Native MCPs (~/.gemini/antigravity-cli/mcp/* and ~/.gemini/antigravity/mcp_config.json)
    let mut agy_servers: Vec<Value> = Vec::new();
    let agy_mcp_dir = home.join(".gemini").join("antigravity-cli").join("mcp");
    if agy_mcp_dir.is_dir() {
        if let Ok(entries) = std::fs::read_dir(&agy_mcp_dir) {
            let mut dirs: Vec<PathBuf> = entries.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
            dirs.sort();
            for dir in dirs {
                let Some(server_name) = dir.file_name().and_then(|n| n.to_str()).map(String::from) else {
                    continue;
                };
                let mut tools: Vec<String> = Vec::new();
                if let Ok(files) = std::fs::read_dir(&dir) {
                    for f in files.flatten() {
                        let path = f.path();
                        if path.extension().and_then(|e| e.to_str()) == Some("json") {
                            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                                tools.push(stem.to_string());
                            }
                        }
                    }
                }
                tools.sort();
                let srv = json!({
                    "id": format!("mcp:antigravity:{}", server_name),
                    "name": server_name,
                    "provider": "antigravity",
                    "providerLabel": "Antigravity",
                    "transport": "native-schema",
                    "status": "ready",
                    "builtin": false,
                    "description": format!("Antigravity native MCP server ({} tools discovered)", tools.len()),
                    "toolCount": tools.len(),
                    "tools": tools,
                    "sourcePath": dir.to_string_lossy().to_string()
                });
                agy_servers.push(srv.clone());
                all_servers.push(srv);
            }
        }
    }

    // Also inspect ~/.gemini/antigravity/mcp_config.json if present
    let agy_config_path = home.join(".gemini").join("antigravity").join("mcp_config.json");
    if agy_config_path.is_file() {
        if let Ok(raw) = std::fs::read_to_string(&agy_config_path) {
            if let Ok(parsed) = serde_json::from_str::<Value>(&raw) {
                if let Some(obj) = parsed.get("mcpServers").and_then(|v| v.as_object()) {
                    for (name, cfg) in obj {
                        let id = format!("mcp:antigravity:{}", name);
                        if !agy_servers.iter().any(|s| s.get("id").and_then(|v| v.as_str()) == Some(&id)) {
                            let cmd = cfg.get("command").and_then(|v| v.as_str()).unwrap_or("stdio");
                            let srv = json!({
                                "id": id,
                                "name": name,
                                "provider": "antigravity",
                                "providerLabel": "Antigravity",
                                "transport": cmd,
                                "status": "configured",
                                "builtin": false,
                                "description": format!("Configured in mcp_config.json ({})", cmd),
                                "toolCount": 0,
                                "tools": [],
                                "sourcePath": agy_config_path.to_string_lossy().to_string()
                            });
                            agy_servers.push(srv.clone());
                            all_servers.push(srv);
                        }
                    }
                }
            }
        }
    }

    providers.push(json!({
        "provider": "antigravity",
        "label": "Antigravity",
        "configPath": agy_mcp_dir.to_string_lossy().to_string(),
        "servers": agy_servers
    }));

    // 3. Claude Code Native MCPs (~/.claude.json)
    let mut claude_servers: Vec<Value> = Vec::new();
    let claude_path = home.join(".claude.json");
    if claude_path.is_file() {
        if let Ok(raw) = std::fs::read_to_string(&claude_path) {
            if let Ok(parsed) = serde_json::from_str::<Value>(&raw) {
                if let Some(obj) = parsed.get("mcpServers").and_then(|v| v.as_object()) {
                    for (name, cfg) in obj {
                        let cmd = cfg
                            .get("command")
                            .or_else(|| cfg.get("url"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("stdio");
                        let srv = json!({
                            "id": format!("mcp:claude-code:{}", name),
                            "name": name,
                            "provider": "claude-code",
                            "providerLabel": "Claude Code",
                            "transport": cmd,
                            "status": "configured",
                            "builtin": false,
                            "description": format!("Claude Code MCP server ({})", cmd),
                            "toolCount": 0,
                            "tools": [],
                            "sourcePath": claude_path.to_string_lossy().to_string()
                        });
                        claude_servers.push(srv.clone());
                        all_servers.push(srv);
                    }
                }
            }
        }
    }
    providers.push(json!({
        "provider": "claude-code",
        "label": "Claude Code",
        "configPath": claude_path.to_string_lossy().to_string(),
        "servers": claude_servers
    }));

    // 4. Codex Native MCPs (~/.codex/config.toml)
    let mut codex_servers: Vec<Value> = Vec::new();
    let codex_path = home.join(".codex").join("config.toml");
    if codex_path.is_file() {
        if let Ok(raw) = std::fs::read_to_string(&codex_path) {
            for line in raw.lines() {
                let trimmed = line.trim();
                if let Some(rest) = trimmed.strip_prefix("[mcp_servers.") {
                    if let Some(name) = rest.strip_suffix(']') {
                        let clean = name.trim_matches('"').trim_matches('\'');
                        if !clean.is_empty() && !clean.contains('.') {
                            let srv = json!({
                                "id": format!("mcp:codex:{}", clean),
                                "name": clean,
                                "provider": "codex",
                                "providerLabel": "Codex",
                                "transport": "toml",
                                "status": "configured",
                                "builtin": false,
                                "description": "Configured in ~/.codex/config.toml",
                                "toolCount": 0,
                                "tools": [],
                                "sourcePath": codex_path.to_string_lossy().to_string()
                            });
                            codex_servers.push(srv.clone());
                            all_servers.push(srv);
                        }
                    }
                }
            }
        }
    }
    providers.push(json!({
        "provider": "codex",
        "label": "Codex",
        "configPath": codex_path.to_string_lossy().to_string(),
        "servers": codex_servers
    }));

    // 5. Cursor Native MCPs (~/.cursor/mcp.json)
    let mut cursor_servers: Vec<Value> = Vec::new();
    let cursor_path = home.join(".cursor").join("mcp.json");
    if cursor_path.is_file() {
        if let Ok(raw) = std::fs::read_to_string(&cursor_path) {
            if let Ok(parsed) = serde_json::from_str::<Value>(&raw) {
                if let Some(obj) = parsed.get("mcpServers").and_then(|v| v.as_object()) {
                    for (name, cfg) in obj {
                        let cmd = cfg.get("command").or_else(|| cfg.get("url")).and_then(|v| v.as_str()).unwrap_or("stdio");
                        let srv = json!({
                            "id": format!("mcp:cursor:{}", name),
                            "name": name,
                            "provider": "cursor",
                            "providerLabel": "Cursor",
                            "transport": cmd,
                            "status": "configured",
                            "builtin": false,
                            "description": format!("Cursor MCP server ({})", cmd),
                            "toolCount": 0,
                            "tools": [],
                            "sourcePath": cursor_path.to_string_lossy().to_string()
                        });
                        cursor_servers.push(srv.clone());
                        all_servers.push(srv);
                    }
                }
            }
        }
    }
    providers.push(json!({
        "provider": "cursor",
        "label": "Cursor",
        "configPath": cursor_path.to_string_lossy().to_string(),
        "servers": cursor_servers
    }));

    // 6. Gemini CLI Native MCPs (~/.gemini/settings.json)
    let mut gemini_servers: Vec<Value> = Vec::new();
    let gemini_path = home.join(".gemini").join("settings.json");
    if gemini_path.is_file() {
        if let Ok(raw) = std::fs::read_to_string(&gemini_path) {
            if let Ok(parsed) = serde_json::from_str::<Value>(&raw) {
                if let Some(obj) = parsed.get("mcpServers").and_then(|v| v.as_object()) {
                    for (name, cfg) in obj {
                        let cmd = cfg.get("command").or_else(|| cfg.get("url")).and_then(|v| v.as_str()).unwrap_or("stdio");
                        let srv = json!({
                            "id": format!("mcp:gemini:{}", name),
                            "name": name,
                            "provider": "gemini",
                            "providerLabel": "Gemini CLI",
                            "transport": cmd,
                            "status": "configured",
                            "builtin": false,
                            "description": format!("Gemini CLI MCP server ({})", cmd),
                            "toolCount": 0,
                            "tools": [],
                            "sourcePath": gemini_path.to_string_lossy().to_string()
                        });
                        gemini_servers.push(srv.clone());
                        all_servers.push(srv);
                    }
                }
            }
        }
    }
    providers.push(json!({
        "provider": "gemini",
        "label": "Gemini CLI",
        "configPath": gemini_path.to_string_lossy().to_string(),
        "servers": gemini_servers
    }));

    // 7. OpenCode Native MCPs (~/.config/opencode/opencode.json)
    let mut opencode_servers: Vec<Value> = Vec::new();
    let opencode_path = home.join(".config").join("opencode").join("opencode.json");
    if opencode_path.is_file() {
        if let Ok(raw) = std::fs::read_to_string(&opencode_path) {
            if let Ok(parsed) = serde_json::from_str::<Value>(&raw) {
                if let Some(obj) = parsed.get("mcp").and_then(|v| v.as_object()) {
                    for (name, cfg) in obj {
                        let enabled = cfg.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);
                        let cmd_str = cfg.get("command").and_then(|v| {
                            v.as_str().map(String::from).or_else(|| {
                                v.as_array().and_then(|arr| {
                                    let parts: Vec<&str> = arr.iter().filter_map(|x| x.as_str()).collect();
                                    if parts.is_empty() {
                                        None
                                    } else {
                                        Some(parts.join(" "))
                                    }
                                })
                            })
                        });
                        let url_str = cfg.get("url").and_then(|v| v.as_str()).map(String::from);
                        let entry_type = cfg.get("type").and_then(|v| v.as_str());
                        let transport = cmd_str
                            .as_deref()
                            .and_then(|s| s.split_whitespace().next())
                            .or(url_str.as_deref())
                            .or(entry_type)
                            .unwrap_or("stdio");
                        let detail = cmd_str
                            .as_deref()
                            .or(url_str.as_deref())
                            .or(entry_type)
                            .unwrap_or("stdio");
                        let status = if enabled { "configured" } else { "disabled" };
                        let srv = json!({
                            "id": format!("mcp:opencode:{}", name),
                            "name": name,
                            "provider": "opencode",
                            "providerLabel": "OpenCode",
                            "transport": transport,
                            "status": status,
                            "enabled": enabled,
                            "builtin": false,
                            "description": format!("OpenCode MCP server ({})", detail),
                            "toolCount": 0,
                            "tools": [],
                            "sourcePath": opencode_path.to_string_lossy().to_string()
                        });
                        opencode_servers.push(srv.clone());
                        all_servers.push(srv);
                    }
                }
            }
        }
    }
    providers.push(json!({
        "provider": "opencode",
        "label": "OpenCode",
        "configPath": opencode_path.to_string_lossy().to_string(),
        "servers": opencode_servers
    }));

    // 8. Active Extension / Plugin MCP servers
    let mut added_plugin_servers: Vec<Value> = Vec::new();
    for srv in plugin_servers {
        let Some(srv_id) = srv.get("id").and_then(Value::as_str) else {
            continue;
        };
        if !all_servers
            .iter()
            .any(|existing| existing.get("id").and_then(Value::as_str) == Some(srv_id))
        {
            added_plugin_servers.push(srv.clone());
            all_servers.push(srv);
        }
    }
    if !added_plugin_servers.is_empty() {
        providers.push(json!({
            "provider": "plugins",
            "label": "Extensions",
            "configPath": crate::persist::roaming_app_dir()
                .join("plugins")
                .to_string_lossy()
                .to_string(),
            "servers": added_plugin_servers
        }));
    }

    let filtered_servers: Vec<Value> = if let Some(ref p) = filter_provider {
        all_servers
            .iter()
            .filter(|s| {
                let sp = s.get("provider").and_then(|v| v.as_str()).unwrap_or("");
                sp == p || sp == "kite"
            })
            .cloned()
            .collect()
    } else {
        all_servers.clone()
    };

    json!({
        "providers": providers,
        "servers": filtered_servers,
        "allServers": all_servers
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opencode_mcp_discovery_parses_local_remote_and_disabled_entries() {
        let temp_home = std::env::temp_dir().join(format!(
            "kite-opencode-mcp-test-{}",
            uuid::Uuid::new_v4()
        ));
        let opencode_dir = temp_home.join(".config").join("opencode");
        std::fs::create_dir_all(&opencode_dir).expect("create temp opencode dir");
        let opencode_cfg = json!({
            "mcp": {
                "kite-tasks": {
                    "type": "local",
                    "command": ["kite", "mcp", "tasks"],
                    "enabled": true
                },
                "remote-ctx": {
                    "type": "remote",
                    "url": "https://mcp.example.com/sse",
                    "enabled": false
                },
                "default-enabled": {
                    "type": "local",
                    "command": ["npx", "-y", "@example/mcp"]
                }
            }
        });
        std::fs::write(
            opencode_dir.join("opencode.json"),
            serde_json::to_string_pretty(&opencode_cfg).unwrap(),
        )
        .expect("write opencode.json");

        let res = list_provider_mcp_servers_with_home(&temp_home, Some(json!({ "provider": "opencode" })));
        let providers = res["providers"].as_array().expect("providers array");
        let opencode = providers
            .iter()
            .find(|p| p.get("provider").and_then(|v| v.as_str()) == Some("opencode"))
            .expect("opencode provider");
        let opencode_servers = opencode["servers"].as_array().expect("opencode servers");
        assert_eq!(opencode_servers.len(), 3);

        let kite_tasks = opencode_servers
            .iter()
            .find(|s| s.get("name").and_then(|v| v.as_str()) == Some("kite-tasks"))
            .expect("kite-tasks server");
        assert_eq!(kite_tasks["id"], "mcp:opencode:kite-tasks");
        assert_eq!(kite_tasks["transport"], "kite");
        assert_eq!(kite_tasks["status"], "configured");
        assert_eq!(kite_tasks["enabled"], true);

        let remote_ctx = opencode_servers
            .iter()
            .find(|s| s.get("name").and_then(|v| v.as_str()) == Some("remote-ctx"))
            .expect("remote-ctx server");
        assert_eq!(remote_ctx["id"], "mcp:opencode:remote-ctx");
        assert_eq!(remote_ctx["transport"], "https://mcp.example.com/sse");
        assert_eq!(remote_ctx["status"], "disabled");
        assert_eq!(remote_ctx["enabled"], false);

        let default_enabled = opencode_servers
            .iter()
            .find(|s| s.get("name").and_then(|v| v.as_str()) == Some("default-enabled"))
            .expect("default-enabled server");
        assert_eq!(default_enabled["status"], "configured");
        assert_eq!(default_enabled["enabled"], true);

        let filtered = res["servers"].as_array().expect("filtered servers");
        assert!(filtered.iter().any(|s| s["id"] == "mcp:opencode:kite-tasks"));
        assert!(filtered.iter().any(|s| s["id"] == "mcp:kite:kite-tasks"));

        let _ = std::fs::remove_dir_all(&temp_home);
    }

    #[test]
    fn plugin_mcp_servers_merge_dedup_and_pass_provider_filter() {
        let temp_home = std::env::temp_dir().join(format!(
            "kite-plugin-mcp-acct-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&temp_home).expect("create temp home");

        let plugin_entries = vec![
            json!({
                "id": "mcp:kite:kite-tasks",
                "name": "kite-tasks",
                "provider": "kite",
                "providerLabel": "Extension",
                "transport": "stdio",
                "status": "configured",
                "builtin": false,
                "pluginId": "dup",
                "description": "Duplicate id should be skipped"
            }),
            json!({
                "id": "android-cli_adb",
                "name": "adb",
                "provider": "kite",
                "providerLabel": "Extension",
                "transport": "stdio",
                "status": "configured",
                "builtin": false,
                "pluginId": "android-cli",
                "description": "Extension 'Android CLI' stdio MCP server (adb-mcp)"
            }),
        ];

        let res = list_provider_mcp_servers_with_home_and_plugins(
            &temp_home,
            Some(json!({ "provider": "codex" })),
            plugin_entries,
        );
        let providers = res["providers"].as_array().expect("providers array");
        let plugins_prov = providers
            .iter()
            .find(|p| p.get("provider").and_then(|v| v.as_str()) == Some("plugins"))
            .expect("plugins provider entry");
        let prov_servers = plugins_prov["servers"].as_array().expect("plugins servers");
        assert_eq!(prov_servers.len(), 1);
        assert_eq!(prov_servers[0]["id"], "android-cli_adb");

        let all_servers = res["allServers"].as_array().expect("allServers array");
        assert_eq!(
            all_servers
                .iter()
                .filter(|s| s["id"] == "mcp:kite:kite-tasks")
                .count(),
            1
        );
        assert!(all_servers.iter().any(|s| s["id"] == "android-cli_adb"));

        let filtered = res["servers"].as_array().expect("filtered servers");
        assert!(filtered.iter().any(|s| s["id"] == "android-cli_adb"));

        // Without plugin servers, "plugins" provider entry is omitted.
        let empty_res = list_provider_mcp_servers_with_home_and_plugins(&temp_home, None, vec![]);
        let empty_providers = empty_res["providers"].as_array().unwrap();
        assert!(!empty_providers
            .iter()
            .any(|p| p.get("provider").and_then(|v| v.as_str()) == Some("plugins")));

        let _ = std::fs::remove_dir_all(&temp_home);
    }
}
