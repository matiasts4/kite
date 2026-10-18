use crate::logger::log_trace;
use crate::persist::{agents, workspaces, AgentProfile, Workspace};
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

#[tauri::command]
pub fn bootstrap() -> BootstrapResponse {
    log_trace("Invoked: bootstrap()");
    BootstrapResponse {
        browser_document_token: Uuid::new_v4().to_string(),
        schema_version: 1,
        persistence_read_only: false,
        recovery_notices: vec![],
        preferences: serde_json::json!({
            "schemaVersion": 1,
            "workMode": "code",
            "route": { "kind": "code" },
            "selectedWorkspaceId": "a1111111-1111-4111-8111-111111111111",
            "selectedAgentId": "c3333333-3333-4333-8333-333333333333",
            "sidebarVisible": true,
            "appearance": "dark",
            "zoomPercent": 100,
            "terminalPreference": { "kind": "default" },
            "usageMeter": { "showPlanUsage": true, "showPaneContext": true },
            "darkTheme": "kite-dark",
            "lightTheme": "kite-light",
            "quitBehavior": "keepSessionsRunning"
        }),
        workspaces: workspaces().lock().unwrap().clone(),
        agents: agents().lock().unwrap().clone(),
    }
}
