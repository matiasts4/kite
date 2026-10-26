//! Kite Code — Native Plugin Ecosystem and Service Hub
//!
//! Exposes IPC commands for managing third-party plugins, auth state transitions,
//! credentials, and persistent connection records.

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::Manager;

pub const CANONICAL_PLUGIN_IDS: [&str; 29] = [
    "x",
    "apollo",
    "vidiq",
    "higgsfield",
    "fal",
    "youtube",
    "github",
    "linear",
    "stripe",
    "revenuecat",
    "cloudflare",
    "gmail",
    "supabase",
    "vercel",
    "shopify",
    "slack",
    "notion",
    "sentry",
    "resend",
    "metaads",
    "googleads",
    "ryze",
    "blender",
    "unreal",
    "unity",
    "quickbooks",
    "posthog",
    "zernio",
    "paddle",
];

pub fn default_state_for(id: &str) -> &'static str {
    match id {
        "x" | "posthog" | "zernio" | "paddle" => "preview",
        "youtube" | "gmail" | "metaads" | "quickbooks" => "unavailable",
        _ => "disconnected",
    }
}

pub fn is_valid_state(state: &str) -> bool {
    matches!(
        state,
        "preview"
            | "unavailable"
            | "disconnected"
            | "connecting"
            | "connected"
            | "needsReauth"
            | "disconnectPending"
    )
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginConnection {
    pub id: String,
    pub state: String,
    pub account: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginConfig {
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub endpoint: Option<String>,
    #[serde(default)]
    pub read_only: Option<bool>,
    #[serde(default)]
    pub account: Option<String>,
    #[serde(default)]
    pub custom_port: Option<u16>,
    #[serde(default)]
    pub enabled_providers: Option<Vec<String>>,
}

pub fn requires_api_key(id: &str) -> bool {
    matches!(
        id,
        "vidiq"
            | "fal"
            | "github"
            | "stripe"
            | "revenuecat"
            | "cloudflare"
            | "shopify"
            | "slack"
            | "resend"
            | "sentry"
            | "apollo"
            | "ryze"
    )
}

pub fn requires_local_port(id: &str) -> bool {
    matches!(id, "blender" | "unreal" | "unity")
}

fn default_schema_version() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginActionInner {
    #[serde(default = "default_schema_version", alias = "schema_version")]
    pub schema_version: u32,
    pub id: String,
    pub action: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
enum PluginActionRequestHelper {
    Nested { request: PluginActionInner },
    Direct(PluginActionInner),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginActionRequest {
    #[serde(alias = "schema_version")]
    pub schema_version: u32,
    pub id: String,
    pub action: String,
}

impl<'de> Deserialize<'de> for PluginActionRequest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let helper = PluginActionRequestHelper::deserialize(deserializer)?;
        let inner = match helper {
            PluginActionRequestHelper::Nested { request } => request,
            PluginActionRequestHelper::Direct(inner) => inner,
        };
        Ok(PluginActionRequest {
            schema_version: inner.schema_version,
            id: inner.id,
            action: inner.action,
        })
    }
}

pub fn default_account_for(id: &str) -> String {
    match id {
        "x" => "@kite_agent".to_string(),
        "apollo" => "team@apollo.io".to_string(),
        "vidiq" => "channel@vidiq.com".to_string(),
        "higgsfield" => "creator@higgsfield.ai".to_string(),
        "fal" => "workspace@fal.ai".to_string(),
        "youtube" => "channel@youtube.com".to_string(),
        "github" => "octocat@github.com".to_string(),
        "linear" => "workspace@linear.app".to_string(),
        "stripe" => "acct_kite_live@stripe.com".to_string(),
        "revenuecat" => "app@revenuecat.com".to_string(),
        "cloudflare" => "admin@cloudflare.com".to_string(),
        "gmail" => "user@gmail.com".to_string(),
        "supabase" => "project@supabase.co".to_string(),
        "vercel" => "team@vercel.com".to_string(),
        "shopify" => "store@myshopify.com".to_string(),
        "slack" => "workspace@slack.com".to_string(),
        "notion" => "workspace@mcp.notion.so".to_string(),
        "sentry" => "project@sentry.io".to_string(),
        "resend" => "delivery@resend.dev".to_string(),
        "metaads" => "act_100294819@meta.com".to_string(),
        "googleads" => "ads-984-123@google.com".to_string(),
        "ryze" => "team@ryze.ai".to_string(),
        "blender" => "localhost:9224".to_string(),
        "unreal" => "localhost:30010".to_string(),
        "unity" => "localhost:8080".to_string(),
        "quickbooks" => "company@quickbooks.com".to_string(),
        "posthog" => "project@posthog.com".to_string(),
        "zernio" => "org@zernio.com".to_string(),
        "paddle" => "seller@paddle.com".to_string(),
        _ => format!("account@{}.service", id),
    }
}

pub fn initial_connections() -> Vec<PluginConnection> {
    CANONICAL_PLUGIN_IDS
        .iter()
        .map(|&id| PluginConnection {
            id: id.to_string(),
            state: default_state_for(id).to_string(),
            account: None,
            message: None,
        })
        .collect()
}

pub fn load_connections_from_disk(path: &Path) -> Result<Vec<PluginConnection>, String> {
    if !path.exists() {
        return Ok(initial_connections());
    }

    let contents = fs::read_to_string(path).map_err(|e| format!("Failed to read plugins state: {e}"))?;
    if contents.trim().is_empty() {
        return Ok(initial_connections());
    }

    #[derive(Deserialize)]
    #[serde(untagged)]
    enum PersistedData {
        List(Vec<PluginConnection>),
        Map(HashMap<String, PluginConnection>),
    }

    let loaded_map: HashMap<String, PluginConnection> = match serde_json::from_str::<PersistedData>(&contents) {
        Ok(PersistedData::List(list)) => list.into_iter().map(|item| (item.id.clone(), item)).collect(),
        Ok(PersistedData::Map(map)) => map,
        Err(_) => return Ok(initial_connections()),
    };

    let connections = CANONICAL_PLUGIN_IDS
        .iter()
        .map(|&id| {
            if let Some(existing) = loaded_map.get(id) {
                PluginConnection {
                    id: id.to_string(),
                    state: if is_valid_state(&existing.state) {
                        existing.state.clone()
                    } else {
                        default_state_for(id).to_string()
                    },
                    account: existing.account.clone(),
                    message: existing.message.clone(),
                }
            } else {
                PluginConnection {
                    id: id.to_string(),
                    state: default_state_for(id).to_string(),
                    account: None,
                    message: None,
                }
            }
        })
        .collect();

    Ok(connections)
}

pub fn save_connections_to_disk(path: &Path, connections: &[PluginConnection]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create parent directory for plugins state: {e}"))?;
    }
    let json_bytes = serde_json::to_string_pretty(connections).map_err(|e| format!("Failed to serialize plugins state: {e}"))?;
    fs::write(path, json_bytes).map_err(|e| format!("Failed to write plugins state file: {e}"))?;
    Ok(())
}

pub fn plugins_state_path(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(dir) = app.path().app_data_dir() {
        let p = dir.join("plugins_state.json");
        if p.exists() {
            return p;
        }
        let roaming_p = crate::persist::roaming_app_dir().join("plugins_state.json");
        if roaming_p.exists() {
            return roaming_p;
        }
        return p;
    }
    crate::persist::roaming_app_dir().join("plugins_state.json")
}

pub fn load_configs_from_disk(path: &Path) -> Result<HashMap<String, PluginConfig>, String> {
    if !path.exists() {
        return Ok(HashMap::new());
    }

    let contents = fs::read_to_string(path).map_err(|e| format!("Failed to read plugins config: {e}"))?;
    if contents.trim().is_empty() {
        return Ok(HashMap::new());
    }

    serde_json::from_str::<HashMap<String, PluginConfig>>(&contents)
        .map_err(|e| format!("Failed to parse plugins config: {e}"))
}

pub fn save_configs_to_disk(path: &Path, configs: &HashMap<String, PluginConfig>) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create parent directory for plugins config: {e}"))?;
    }
    let json_bytes = serde_json::to_string_pretty(configs).map_err(|e| format!("Failed to serialize plugins config: {e}"))?;
    fs::write(path, json_bytes).map_err(|e| format!("Failed to write plugins config file: {e}"))?;
    Ok(())
}

pub fn plugins_config_path(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(dir) = app.path().app_data_dir() {
        let p = dir.join("plugins_config.json");
        if p.exists() {
            return p;
        }
        let roaming_p = crate::persist::roaming_app_dir().join("plugins_config.json");
        if roaming_p.exists() {
            return roaming_p;
        }
        return p;
    }
    crate::persist::roaming_app_dir().join("plugins_config.json")
}

static STATE_LOCK: Mutex<()> = Mutex::new(());

#[tauri::command]
pub fn plugin_connections(app: tauri::AppHandle) -> Result<Vec<PluginConnection>, String> {
    let _guard = STATE_LOCK.lock().map_err(|e| format!("State lock poisoned: {e}"))?;
    let path = plugins_state_path(&app);
    let connections = load_connections_from_disk(&path)?;
    if !path.exists() {
        let _ = save_connections_to_disk(&path, &connections);
    }
    Ok(connections)
}

#[tauri::command]
pub fn plugin_connection_action(app: tauri::AppHandle, request: PluginActionRequest) -> Result<(), String> {
    let _guard = STATE_LOCK.lock().map_err(|e| format!("State lock poisoned: {e}"))?;
    let path = plugins_state_path(&app);
    let mut connections = load_connections_from_disk(&path)?;

    if !CANONICAL_PLUGIN_IDS.contains(&request.id.as_str()) {
        return Err(format!("Unknown plugin id: '{}'", request.id));
    }

    let conn = match connections.iter_mut().find(|c| c.id == request.id) {
        Some(c) => c,
        None => return Err(format!("Plugin '{}' not found in connections", request.id)),
    };

    match request.action.as_str() {
        "connect" | "reconnect" => {
            let config_path = plugins_config_path(&app);
            let configs = load_configs_from_disk(&config_path).unwrap_or_default();
            let saved_cfg = configs.get(&request.id);
            let has_key = saved_cfg
                .and_then(|c| c.api_key.as_deref())
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false);
            let has_port = saved_cfg
                .and_then(|c| c.custom_port)
                .map(|p| p > 0)
                .unwrap_or(false);

            if requires_api_key(&request.id) && !has_key {
                return Err(format!(
                    "El plugin '{}' requiere una API Key configurada para conectarse.",
                    request.id
                ));
            }
            if requires_local_port(&request.id) && !has_port {
                return Err(format!(
                    "El plugin '{}' requiere configurar un puerto local válido para conectarse.",
                    request.id
                ));
            }

            conn.state = "connected".to_string();
            if conn.account.as_deref().unwrap_or("").trim().is_empty() {
                conn.account = saved_cfg
                    .and_then(|c| c.account.clone())
                    .filter(|a| !a.trim().is_empty())
                    .or_else(|| Some(default_account_for(&request.id)));
            }
            conn.message = None;
        }
        "cancel" | "disconnect" => {
            conn.state = "disconnected".to_string();
            conn.account = None;
            conn.message = None;
        }
        "connecting" => {
            conn.state = "connecting".to_string();
        }
        "needsReauth" => {
            conn.state = "needsReauth".to_string();
        }
        "disconnectPending" => {
            conn.state = "disconnectPending".to_string();
        }
        other => {
            return Err(format!("Unknown plugin action: '{other}'"));
        }
    }

    save_connections_to_disk(&path, &connections)?;
    Ok(())
}

fn extract_plugin_id(request: &Option<Value>) -> Option<String> {
    let val = request.as_ref()?;
    if let Some(s) = val.as_str() {
        return Some(s.to_string());
    }
    let target = val.get("request").unwrap_or(val);
    if let Some(s) = target.as_str() {
        return Some(s.to_string());
    }
    target
        .get("pluginId")
        .or_else(|| target.get("plugin_id"))
        .or_else(|| target.get("id"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

pub fn get_plugin_config_from_path(
    config_path: &Path,
    pid: &str,
) -> Result<Option<PluginConfig>, String> {
    let configs = load_configs_from_disk(config_path)?;
    Ok(configs.get(pid).cloned())
}

#[allow(non_snake_case)]
#[tauri::command]
pub fn get_plugin_config(
    app: tauri::AppHandle,
    request: Option<Value>,
    plugin_id: Option<String>,
    pluginId: Option<String>,
) -> Result<Option<PluginConfig>, String> {
    let _guard = STATE_LOCK.lock().map_err(|e| format!("State lock poisoned: {e}"))?;
    let pid = extract_plugin_id(&request)
        .or(plugin_id)
        .or(pluginId)
        .ok_or_else(|| "Missing plugin_id".to_string())?;

    let path = plugins_config_path(&app);
    get_plugin_config_from_path(&path, &pid)
}

#[allow(non_snake_case)]
fn extract_save_payload(
    request: &Option<Value>,
    plugin_id: Option<String>,
    pluginId: Option<String>,
    config: Option<PluginConfig>,
) -> Result<(String, PluginConfig), String> {
    if let Some(val) = request {
        let target = val.get("request").unwrap_or(val);
        let pid = target
            .get("pluginId")
            .or_else(|| target.get("plugin_id"))
            .or_else(|| target.get("id"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .or_else(|| plugin_id.clone())
            .or_else(|| pluginId.clone());

        let cfg = target
            .get("config")
            .map(|c| serde_json::from_value::<PluginConfig>(c.clone()))
            .transpose()
            .map_err(|e| format!("Invalid plugin config: {e}"))?
            .or_else(|| config.clone());

        if let (Some(p), Some(c)) = (pid, cfg) {
            return Ok((p, c));
        }
    }

    let pid = plugin_id.or(pluginId).ok_or_else(|| "Missing plugin_id".to_string())?;
    let cfg = config.ok_or_else(|| "Missing config".to_string())?;
    Ok((pid, cfg))
}

pub fn save_plugin_config_paths(
    config_path: &Path,
    state_path: &Path,
    pid: &str,
    cfg: PluginConfig,
) -> Result<(), String> {
    if !CANONICAL_PLUGIN_IDS.contains(&pid) {
        return Err(format!("Unknown plugin id: '{pid}'"));
    }

    let mut configs = load_configs_from_disk(config_path)?;
    configs.insert(pid.to_string(), cfg.clone());
    save_configs_to_disk(config_path, &configs)?;

    let has_key = cfg.api_key.as_deref().map(|s| !s.trim().is_empty()).unwrap_or(false);
    let has_port = cfg.custom_port.map(|p| p > 0).unwrap_or(false);

    let mut connections = load_connections_from_disk(state_path)?;
    if let Some(conn) = connections.iter_mut().find(|c| c.id == pid) {
        if (requires_api_key(pid) && has_key) || (requires_local_port(pid) && has_port) {
            conn.state = "connected".to_string();
            if conn.account.as_deref().unwrap_or("").trim().is_empty() {
                conn.account = cfg
                    .account
                    .filter(|a| !a.trim().is_empty())
                    .or_else(|| Some(default_account_for(pid)));
            }
            conn.message = None;
            save_connections_to_disk(state_path, &connections)?;
        } else if (requires_api_key(pid) && !has_key) || (requires_local_port(pid) && !has_port) {
            if conn.state == "connected" {
                conn.state = "disconnected".to_string();
                conn.account = None;
                conn.message = None;
                save_connections_to_disk(state_path, &connections)?;
            }
        }
    }

    Ok(())
}

#[allow(non_snake_case)]
#[tauri::command]
pub fn save_plugin_config(
    app: tauri::AppHandle,
    request: Option<Value>,
    plugin_id: Option<String>,
    pluginId: Option<String>,
    config: Option<PluginConfig>,
) -> Result<(), String> {
    let _guard = STATE_LOCK.lock().map_err(|e| format!("State lock poisoned: {e}"))?;
    let (pid, cfg) = extract_save_payload(&request, plugin_id, pluginId, config)?;
    let config_path = plugins_config_path(&app);
    let state_path = plugins_state_path(&app);
    save_plugin_config_paths(&config_path, &state_path, &pid, cfg)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_canonical_29_plugins_count() {
        assert_eq!(CANONICAL_PLUGIN_IDS.len(), 29);
    }

    #[test]
    fn test_initial_states() {
        let conns = initial_connections();
        assert_eq!(conns.len(), 29);

        let preview_ids: Vec<&str> = conns.iter().filter(|c| c.state == "preview").map(|c| c.id.as_str()).collect();
        assert_eq!(preview_ids, vec!["x", "posthog", "zernio", "paddle"]);

        let unavailable_ids: Vec<&str> = conns.iter().filter(|c| c.state == "unavailable").map(|c| c.id.as_str()).collect();
        assert_eq!(unavailable_ids, vec!["youtube", "gmail", "metaads", "quickbooks"]);

        let disconnected_count = conns.iter().filter(|c| c.state == "disconnected").count();
        assert_eq!(disconnected_count, 21);
    }

    #[test]
    fn test_serialization_camel_case() {
        let conn = PluginConnection {
            id: "github".to_string(),
            state: "connected".to_string(),
            account: Some("octocat@github.com".to_string()),
            message: None,
        };
        let val = serde_json::to_value(&conn).unwrap();
        assert_eq!(val["id"], "github");
        assert_eq!(val["state"], "connected");
        assert_eq!(val["account"], "octocat@github.com");
        assert!(val["message"].is_null());
    }

    #[test]
    fn test_plugin_config_serialization_camel_case() {
        let cfg = PluginConfig {
            api_key: Some("sk-test-key-12345".to_string()),
            endpoint: Some("https://api.fal.ai/v1".to_string()),
            read_only: Some(true),
            account: Some("dev@kite.app".to_string()),
            custom_port: Some(9224),
            enabled_providers: Some(vec!["claude-code".to_string(), "antigravity".to_string()]),
        };
        let val = serde_json::to_value(&cfg).unwrap();
        assert_eq!(val["apiKey"], "sk-test-key-12345");
        assert_eq!(val["endpoint"], "https://api.fal.ai/v1");
        assert_eq!(val["readOnly"], true);
        assert_eq!(val["account"], "dev@kite.app");
        assert_eq!(val["customPort"], 9224);
        assert_eq!(val["enabledProviders"][0], "claude-code");
        assert_eq!(val["enabledProviders"][1], "antigravity");

        // Deserialization roundtrip
        let roundtrip: PluginConfig = serde_json::from_value(val).unwrap();
        assert_eq!(roundtrip, cfg);

        // Partial deserialization
        let partial_json = r#"{"apiKey": "abc-123"}"#;
        let partial_cfg: PluginConfig = serde_json::from_str(partial_json).unwrap();
        assert_eq!(partial_cfg.api_key, Some("abc-123".to_string()));
        assert_eq!(partial_cfg.endpoint, None);
        assert_eq!(partial_cfg.custom_port, None);
        assert_eq!(partial_cfg.enabled_providers, None);
    }

    #[test]
    fn test_action_request_deserialization() {
        // Direct camelCase
        let json_str = r#"{"schemaVersion": 1, "id": "github", "action": "connect"}"#;
        let req: PluginActionRequest = serde_json::from_str(json_str).unwrap();
        assert_eq!(req.schema_version, 1);
        assert_eq!(req.id, "github");
        assert_eq!(req.action, "connect");

        // Direct snake_case
        let json_str2 = r#"{"schema_version": 2, "id": "stripe", "action": "disconnect"}"#;
        let req2: PluginActionRequest = serde_json::from_str(json_str2).unwrap();
        assert_eq!(req2.schema_version, 2);
        assert_eq!(req2.id, "stripe");
        assert_eq!(req2.action, "disconnect");

        // Nested in request
        let json_str3 = r#"{"request": {"schemaVersion": 1, "id": "linear", "action": "cancel"}}"#;
        let req3: PluginActionRequest = serde_json::from_str(json_str3).unwrap();
        assert_eq!(req3.schema_version, 1);
        assert_eq!(req3.id, "linear");
        assert_eq!(req3.action, "cancel");
    }

    #[test]
    fn test_file_persistence_roundtrip() {
        let temp_dir = std::env::temp_dir().join(format!("kite_test_{}", std::process::id()));
        let file_path = temp_dir.join("plugins_state.json");

        let mut conns = initial_connections();
        // Modify github to connected
        let github = conns.iter_mut().find(|c| c.id == "github").unwrap();
        github.state = "connected".to_string();
        github.account = Some("octocat@github.com".to_string());

        save_connections_to_disk(&file_path, &conns).unwrap();

        let loaded = load_connections_from_disk(&file_path).unwrap();
        assert_eq!(loaded.len(), 29);
        let loaded_github = loaded.iter().find(|c| c.id == "github").unwrap();
        assert_eq!(loaded_github.state, "connected");
        assert_eq!(loaded_github.account, Some("octocat@github.com".to_string()));

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_config_persistence_roundtrip() {
        let temp_dir = std::env::temp_dir().join(format!("kite_config_test_{}", std::process::id()));
        let config_path = temp_dir.join("plugins_config.json");

        let mut configs = HashMap::new();
        configs.insert(
            "github".to_string(),
            PluginConfig {
                api_key: Some("ghp_secrettoken".to_string()),
                endpoint: None,
                read_only: Some(false),
                account: Some("octocat".to_string()),
                custom_port: None,
                enabled_providers: None,
            },
        );
        configs.insert(
            "blender".to_string(),
            PluginConfig {
                api_key: None,
                endpoint: None,
                read_only: None,
                account: None,
                custom_port: Some(9224),
                enabled_providers: Some(vec!["antigravity".to_string()]),
            },
        );

        save_configs_to_disk(&config_path, &configs).unwrap();

        let loaded = load_configs_from_disk(&config_path).unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded.get("github"), configs.get("github"));
        assert_eq!(loaded.get("blender"), configs.get("blender"));

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_save_plugin_config_auto_connect() {
        let temp_dir = std::env::temp_dir().join(format!("kite_autoconnect_test_{}", std::process::id()));
        let config_path = temp_dir.join("plugins_config.json");
        let state_path = temp_dir.join("plugins_state.json");

        // Seed initial connections
        let conns = initial_connections();
        save_connections_to_disk(&state_path, &conns).unwrap();

        // Save config with api_key for fal
        let cfg = PluginConfig {
            api_key: Some("fal-key-999".to_string()),
            endpoint: None,
            read_only: None,
            account: None,
            custom_port: None,
            enabled_providers: None,
        };

        save_plugin_config_paths(&config_path, &state_path, "fal", cfg).unwrap();

        // Verify state transitioned to connected
        let updated_conns = load_connections_from_disk(&state_path).unwrap();
        let fal_conn = updated_conns.iter().find(|c| c.id == "fal").unwrap();
        assert_eq!(fal_conn.state, "connected");
        assert_eq!(fal_conn.account, Some("workspace@fal.ai".to_string()));
        assert_eq!(fal_conn.message, None);

        // Verify config was persisted
        let loaded_cfg = get_plugin_config_from_path(&config_path, "fal").unwrap().unwrap();
        assert_eq!(loaded_cfg.api_key, Some("fal-key-999".to_string()));

        // Test with custom port for unity
        let unity_cfg = PluginConfig {
            api_key: None,
            endpoint: None,
            read_only: None,
            account: Some("custom-unity-editor".to_string()),
            custom_port: Some(8081),
            enabled_providers: None,
        };
        save_plugin_config_paths(&config_path, &state_path, "unity", unity_cfg).unwrap();

        let updated_conns2 = load_connections_from_disk(&state_path).unwrap();
        let unity_conn = updated_conns2.iter().find(|c| c.id == "unity").unwrap();
        assert_eq!(unity_conn.state, "connected");
        assert_eq!(unity_conn.account, Some("custom-unity-editor".to_string()));

        // Now test removing key reverts state to disconnected
        let empty_fal_cfg = PluginConfig {
            api_key: Some("".to_string()),
            endpoint: None,
            read_only: None,
            account: None,
            custom_port: None,
            enabled_providers: None,
        };
        save_plugin_config_paths(&config_path, &state_path, "fal", empty_fal_cfg).unwrap();
        let updated_conns3 = load_connections_from_disk(&state_path).unwrap();
        let fal_conn_rev = updated_conns3.iter().find(|c| c.id == "fal").unwrap();
        assert_eq!(fal_conn_rev.state, "disconnected");

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_extract_payload_formats() {
        // Direct value
        let val1 = serde_json::json!({ "pluginId": "github" });
        assert_eq!(extract_plugin_id(&Some(val1)), Some("github".to_string()));

        // Nested request
        let val2 = serde_json::json!({ "request": { "plugin_id": "linear" } });
        assert_eq!(extract_plugin_id(&Some(val2)), Some("linear".to_string()));

        // String value
        let val3 = serde_json::json!("stripe");
        assert_eq!(extract_plugin_id(&Some(val3)), Some("stripe".to_string()));

        // Save payload wrapped
        let save_val = serde_json::json!({
            "request": {
                "pluginId": "fal",
                "config": {
                    "apiKey": "key123"
                }
            }
        });
        let (pid, cfg) = extract_save_payload(&Some(save_val), None, None, None).unwrap();
        assert_eq!(pid, "fal");
        assert_eq!(cfg.api_key, Some("key123".to_string()));
    }
}
