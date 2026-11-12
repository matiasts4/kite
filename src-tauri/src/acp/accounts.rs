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

/// Discovers native MCP servers grouped by provider (Antigravity, Claude Code, Codex, Cursor, Gemini, and Kite built-in).
pub fn list_provider_mcp_servers_impl(request: Option<Value>) -> Value {
    let filter_provider = request
        .as_ref()
        .and_then(|v| v.get("provider").or_else(|| v.get("engine")))
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_lowercase());

    let home = user_home_dir();
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
        "sourcePath": "kite-code mcp-tasks"
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

/// Reads active Antigravity credentials and ~/.gemini/google_accounts.json to list accounts.
pub fn antigravity_list_google_accounts_impl() -> Result<Value, String> {
    let home = if let Ok(p) = std::env::var("USERPROFILE") {
        PathBuf::from(p)
    } else if let Ok(h) = std::env::var("HOME") {
        PathBuf::from(h)
    } else {
        PathBuf::from(".")
    };

    let active_from_cred = crate::quota::read_antigravity_credential().map(|(e, _)| e);
    let mut active = active_from_cred.unwrap_or_default();
    let mut all: Vec<String> = Vec::new();

    let accounts_path = home.join(".gemini").join("google_accounts.json");
    if accounts_path.is_file() {
        if let Ok(raw) = std::fs::read_to_string(&accounts_path) {
            if let Ok(val) = serde_json::from_str::<Value>(&raw) {
                if active.is_empty() {
                    active = val.get("active").and_then(|v| v.as_str()).unwrap_or("").to_string();
                }
                if let Some(file_active) = val.get("active").and_then(|v| v.as_str()) {
                    if !file_active.is_empty() && !all.contains(&file_active.to_string()) {
                        all.push(file_active.to_string());
                    }
                }
                if let Some(old) = val.get("old").and_then(|v| v.as_array()) {
                    for email_val in old {
                        if let Some(email) = email_val.as_str() {
                            if !email.is_empty() && !all.contains(&email.to_string()) {
                                all.push(email.to_string());
                            }
                        }
                    }
                }
            }
        }
    }

    if !active.is_empty() && !all.contains(&active) {
        all.insert(0, active.clone());
    }

    Ok(json!({
        "active": if active.is_empty() { Value::Null } else { json!(active) },
        "accounts": all
    }))
}

/// Switches the active Google account in ~/.gemini/google_accounts.json.
pub fn antigravity_set_active_google_account_impl(email: String) -> Result<Value, String> {
    let target = email.trim();
    let home = if let Ok(p) = std::env::var("USERPROFILE") {
        PathBuf::from(p)
    } else if let Ok(h) = std::env::var("HOME") {
        PathBuf::from(h)
    } else {
        PathBuf::from(".")
    };

    let accounts_path = home.join(".gemini").join("google_accounts.json");
    let mut current_data: Value = if accounts_path.is_file() {
        let raw = std::fs::read_to_string(&accounts_path).unwrap_or_default();
        serde_json::from_str(&raw).unwrap_or(json!({}))
    } else {
        json!({ "active": "", "old": [] })
    };

    let prev_active = current_data.get("active").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let mut old_list: Vec<String> = current_data.get("old")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default();

    if !prev_active.is_empty() && prev_active.as_str() != target && !old_list.iter().any(|e| e == &prev_active) {
        old_list.push(prev_active);
    }
    old_list.retain(|e| e.as_str() != target);

    current_data["active"] = json!(target);
    current_data["old"] = json!(old_list);

    let parent = accounts_path.parent().unwrap_or(Path::new("."));
    let _ = std::fs::create_dir_all(parent);
    let serialized = serde_json::to_string_pretty(&current_data).map_err(|e| e.to_string())?;
    std::fs::write(&accounts_path, serialized).map_err(|e| e.to_string())?;

    let all_accounts: Vec<String> = std::iter::once(target.to_string())
        .chain(old_list.into_iter())
        .collect();

    Ok(json!({
        "success": true,
        "active": target,
        "accounts": all_accounts
    }))
}
