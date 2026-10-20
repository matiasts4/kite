use crate::quota::types::{ProviderQuotaStatus, QuotaWindow};
use crate::quota::utils::{now_ms, user_home_dir};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;

pub fn fetch_opencode_quota() -> ProviderQuotaStatus {
    let mut status = ProviderQuotaStatus {
        provider_id: "opencode".to_string(),
        display_name: "OpenCode".to_string(),
        is_available: false,
        is_auth: false,
        primary_usage_percent: 0.0,
        primary_remaining_percent: 100.0,
        primary_reset_at: None,
        time_until_reset_ms: None,
        windows: Vec::new(),
        metadata: HashMap::new(),
        last_updated_ms: now_ms(),
        error: None,
    };

    let home = user_home_dir();
    let opencode_dir = home.join(".opencode");
    let kite_quota_cfg = home.join(".kite").join("opencode-go-quota.json");
    let devhub_quota_cfg = home.join(".devhub").join("opencode-go-quota.json");

    let mut auth_cookie: Option<String> = std::env::var("OPENCODE_GO_AUTH_COOKIE").ok();
    let mut workspace_id: Option<String> = std::env::var("OPENCODE_GO_WORKSPACE_ID").ok();

    for cfg_file in [&kite_quota_cfg, &devhub_quota_cfg] {
        if auth_cookie.is_none() && cfg_file.exists() {
            if let Ok(content) = std::fs::read_to_string(cfg_file) {
                if let Ok(val) = serde_json::from_str::<Value>(&content) {
                    auth_cookie = val.get("authCookie").and_then(|v| v.as_str()).map(|s| s.to_string());
                    if workspace_id.is_none() {
                        workspace_id = val.get("workspaceId").and_then(|v| v.as_str()).map(|s| s.to_string());
                    }
                }
            }
        }
    }

    if opencode_dir.exists() || auth_cookie.is_some() {
        status.is_available = true;
    }

    if let Some(_cookie) = auth_cookie {
        status.is_available = true;
        status.is_auth = true;
        if let Some(ref w) = workspace_id {
            status.metadata.insert("workspaceId".to_string(), json!(w));
        }
        status.metadata.insert("source".to_string(), json!("Cookie de consola OpenCode Go configurada"));

        status.windows.push(QuotaWindow {
            name: "OpenCode Go (Consola activa)".to_string(),
            usage_percent: 0.0,
            remaining_fraction: 1.0,
            resets_at: None,
            time_until_reset_ms: None,
            is_exhausted: false,
        });
        return status;
    }

    if opencode_dir.exists() {
        status.is_auth = true;
        status.windows.push(QuotaWindow {
            name: "OpenCode CLI Local".to_string(),
            usage_percent: 0.0,
            remaining_fraction: 1.0,
            resets_at: None,
            time_until_reset_ms: None,
            is_exhausted: false,
        });
        return status;
    }

    status.error = Some("OpenCode Go no configurado. Ingresa tu cookie de consola en la configuración.".to_string());
    status
}

/// Calls the Grok CLI proxy billing endpoint. Returns (http_status, body).

#[tauri::command]
pub fn save_opencode_cookie(cookie: String, workspace_id: Option<String>) -> Result<bool, String> {
    let home = user_home_dir();
    let dir = home.join(".kite");
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("opencode-go-quota.json");
    let data = json!({
        "authCookie": cookie.trim(),
        "workspaceId": workspace_id.map(|w| w.trim().to_string()).unwrap_or_default()
    });
    std::fs::write(&path, serde_json::to_string_pretty(&data).unwrap_or_default())
        .map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub fn clear_opencode_cookie() -> Result<bool, String> {
    let home = user_home_dir();
    let path = home.join(".kite").join("opencode-go-quota.json");
    if path.exists() {
        let _ = std::fs::remove_file(path);
    }
    Ok(true)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

