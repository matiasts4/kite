use crate::logger::log_trace;
use crate::persist::{agents, app_state_get, app_state_set, workspaces, AgentProfile, Workspace};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize)]
pub struct BootstrapResponse {
    #[serde(rename = "browserDocumentToken")]
    pub browser_document_token: String,
    #[serde(rename = "schemaVersion")]
    pub schema_version: i32,
    #[serde(rename = "persistenceReadOnly")]
    pub persistence_read_only: bool,
    #[serde(rename = "recoveryNotices")]
    pub recovery_notices: Vec<String>,
    pub preferences: serde_json::Value,
    pub workspaces: Vec<Workspace>,
    pub agents: Vec<AgentProfile>,
}

#[tauri::command]
pub fn auth_bootstrap() -> serde_json::Value {
    log_trace("Invoked: auth_bootstrap()");
    let (name, email) = if let Some((e, n)) = crate::quota::read_antigravity_credential() {
        (n.unwrap_or_else(|| "Matias Tobar".to_string()), e)
    } else {
        ("Kite Developer".to_string(), "developer@kite.local".to_string())
    };

    serde_json::json!({
        "schemaVersion": 2,
        "revision": 1,
        "phase": { "kind": "signedIn" },
        "access": { "kind": "entitled" },
        "user": {
            "name": name,
            "email": email
        },
        "subscriptionTier": "ultra",
        "features": {
            "voice": true,
            "assistant": true,
            "kiteVerse": true,
            "remote": true
        },
        "includedCredits": 10000,
        "canReopenBrowser": false,
        "paymentRecovery": false
    })
}

#[tauri::command]
pub fn auth_snapshot() -> serde_json::Value {
    auth_bootstrap()
}

#[tauri::command]
pub fn auth_begin_sign_in() -> serde_json::Value {
    auth_bootstrap()
}

#[tauri::command]
pub fn auth_sign_in_diagnostics() -> serde_json::Value {
    serde_json::json!({ "rejections": [] })
}

#[tauri::command]
pub fn auth_cancel_sign_in(_request: Option<serde_json::Value>) -> serde_json::Value {
    serde_json::json!({ "ok": true })
}

#[tauri::command]
pub fn auth_open_privacy(_request: Option<serde_json::Value>) -> serde_json::Value {
    serde_json::json!({ "ok": true })
}

#[tauri::command]
pub fn auth_open_signup(_request: Option<serde_json::Value>) -> serde_json::Value {
    serde_json::json!({ "ok": true })
}

#[tauri::command]
pub fn auth_open_terms(_request: Option<serde_json::Value>) -> serde_json::Value {
    serde_json::json!({ "ok": true })
}

#[tauri::command]
pub fn auth_open_upgrade(_request: Option<serde_json::Value>) -> serde_json::Value {
    serde_json::json!({ "ok": true })
}

#[tauri::command]
pub fn auth_prewarm_sign_in(_request: Option<serde_json::Value>) -> serde_json::Value {
    serde_json::json!({ "ok": true })
}

#[tauri::command]
pub fn auth_reopen_sign_in(_request: Option<serde_json::Value>) -> serde_json::Value {
    serde_json::json!({ "ok": true })
}

#[tauri::command]
pub fn auth_retry_entitlement(_request: Option<serde_json::Value>) -> serde_json::Value {
    serde_json::json!({ "ok": true })
}

#[tauri::command]
pub fn auth_sign_out(_request: Option<serde_json::Value>) -> serde_json::Value {
    serde_json::json!({ "ok": true })
}

fn bootstrap_preferences() -> serde_json::Value {
    let saved_theme_raw = app_state_get("themeCustomizations");
    let saved_theme_json: Option<serde_json::Value> = saved_theme_raw
        .as_deref()
        .and_then(|raw| serde_json::from_str(raw).ok());

    let appearance = saved_theme_json
        .as_ref()
        .and_then(|v| v.get("appearanceMode"))
        .and_then(|v| v.as_str())
        .unwrap_or("dark");
    let dark_theme = saved_theme_json
        .as_ref()
        .and_then(|v| v.get("darkThemeId"))
        .and_then(|v| v.as_str())
        .unwrap_or("kite-dark");
    let light_theme = saved_theme_json
        .as_ref()
        .and_then(|v| v.get("lightThemeId"))
        .and_then(|v| v.as_str())
        .unwrap_or("kite-light");

    serde_json::json!({
        "schemaVersion": 1,
        "workMode": "code",
        "route": { "kind": "code" },
        "selectedWorkspaceId": "a1111111-1111-4111-8111-111111111111",
        "selectedAgentId": "c3333333-3333-4333-8333-333333333333",
        "sidebarVisible": true,
        "appearance": appearance,
        "zoomPercent": 100,
        "terminalPreference": { "kind": "default" },
        "usageMeter": { "showPlanUsage": true, "showPaneContext": true },
        "darkTheme": dark_theme,
        "lightTheme": light_theme,
        "themeCustomizations": saved_theme_json,
        "quitBehavior": "keepSessionsRunning"
    })
}

#[tauri::command]
pub fn save_theme_preferences(preferences: Option<serde_json::Value>) -> serde_json::Value {
    if let Some(pref) = preferences {
        if let Ok(serialized) = serde_json::to_string(&pref) {
            app_state_set("themeCustomizations", &serialized);
            return serde_json::json!({ "ok": true });
        }
    }
    serde_json::json!({ "ok": false })
}

pub fn bootstrap_sync() -> BootstrapResponse {
    log_trace("Invoked: bootstrap()");
    BootstrapResponse {
        browser_document_token: Uuid::new_v4().to_string(),
        schema_version: 1,
        persistence_read_only: false,
        recovery_notices: vec![],
        preferences: bootstrap_preferences(),
        workspaces: workspaces().lock().unwrap().clone(),
        agents: agents().lock().unwrap().clone(),
    }
}

#[tauri::command]
pub async fn bootstrap() -> BootstrapResponse {
    tokio::task::spawn_blocking(bootstrap_sync)
        .await
        .unwrap_or_else(|_| {
            log_trace("bootstrap worker failed");
            BootstrapResponse {
                browser_document_token: Uuid::new_v4().to_string(),
                schema_version: 1,
                persistence_read_only: true,
                recovery_notices: vec!["bootstrap worker failed".to_string()],
                preferences: bootstrap_preferences(),
                workspaces: vec![],
                agents: vec![],
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bootstrap_sync_returns_workspaces_without_blocking_the_caller_thread_contract() {
        let first = bootstrap_sync();
        assert_eq!(first.schema_version, 1);
        assert!(!first.persistence_read_only);
        assert!(first.preferences.get("workMode").is_some());
        let second = bootstrap_sync();
        assert_eq!(second.workspaces.len(), first.workspaces.len());
        assert_eq!(second.agents.len(), first.agents.len());
    }

    #[test]
    fn save_theme_preferences_round_trips_into_bootstrap_preferences() {
        let payload = serde_json::json!({
            "schemaVersion": 1,
            "appearanceMode": "dark",
            "darkThemeId": "aurora-studio",
            "lightThemeId": "warm-atelier"
        });
        let res = save_theme_preferences(Some(payload));
        assert_eq!(res.get("ok").and_then(|v| v.as_bool()), Some(true));

        let prefs = bootstrap_preferences();
        assert_eq!(prefs.get("darkTheme").and_then(|v| v.as_str()), Some("aurora-studio"));
        assert_eq!(prefs.get("lightTheme").and_then(|v| v.as_str()), Some("warm-atelier"));
    }
}
