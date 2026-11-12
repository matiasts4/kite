use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const CORE_PROTOCOL_VERSION: &str = "kite-core/v1";
pub const CORE_VERSION: &str = "0.1.0";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreHandshakeRequest {
    pub protocol: String,
    pub framed: bool,
    pub client: String,
    pub pid: u32,
    pub auth_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreHandshakeResponse {
    pub protocol: String,
    pub framed: bool,
    pub core_version: String,
    pub core_pid: u32,
    pub active_sessions: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSessionSummary {
    pub session_id: String,
    pub channel_id: Option<u32>,
    pub workspace_id: Option<String>,
    pub pane_id: Option<String>,
    pub engine: String,
    pub cwd: String,
    pub root_pid: u32,
    pub cols: u16,
    pub rows: u16,
    pub exited: bool,
    pub exit_code: Option<i64>,
    pub spawned_at_unix_ms: i64,
}

/// Installed and development builds must not share a daemon endpoint.
pub fn core_pipe_stem() -> &'static str {
    if cfg!(debug_assertions) {
        "kite-core-v1-dev"
    } else {
        "kite-core-v1"
    }
}

pub fn get_core_pipe_name() -> String {
    if let Ok(custom) = std::env::var("KITE_CORE_PIPE") {
        let trimmed = custom.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    let stem = core_pipe_stem();
    #[cfg(windows)]
    {
        let user = std::env::var("USERNAME").unwrap_or_else(|_| "user".to_string());
        format!(r"\\.\pipe\{stem}-{user}")
    }
    #[cfg(not(windows))]
    {
        if let Ok(xdg) = std::env::var("XDG_RUNTIME_DIR") {
            format!("{xdg}/{stem}.sock")
        } else {
            let uid = unsafe { libc::getuid() };
            format!("/tmp/{stem}-{uid}.sock")
        }
    }
}

pub fn core_auth_token_path() -> PathBuf {
    crate::persist::roaming_app_dir().join("core-session.token")
}

pub fn get_or_create_core_token() -> String {
    let path = core_auth_token_path();
    if let Ok(content) = std::fs::read_to_string(&path) {
        let trimmed = content.trim().to_string();
        if !trimmed.is_empty() {
            return trimmed;
        }
    }

    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let token = format!("kt-{}", uuid::Uuid::new_v4().simple());
    let _ = std::fs::write(&path, &token);
    token
}

pub fn validate_core_token(token: &str) -> bool {
    let expected = get_or_create_core_token();
    !token.is_empty() && token == expected
}

/// Lightweight `FACTS` payload for a session, emitted whenever metadata changes.
pub(crate) fn session_facts(inst: &crate::terminal::TerminalInstance) -> Value {
    let cwd = inst
        .live_cwd
        .lock()
        .ok()
        .map(|cwd| cwd.clone())
        .filter(|cwd| !cwd.is_empty())
        .unwrap_or_else(|| inst.cwd.clone());
    let title = inst.vt_engine.lock().ok().and_then(|vt| vt.title());
    let provider_session_id = inst
        .provider_session_id
        .lock()
        .ok()
        .and_then(|provider| provider.clone());
    json!({
        "cwd": cwd,
        "title": title,
        "activeEngine": inst.engine,
        "providerSessionId": provider_session_id,
    })
}

pub(crate) fn child_exit_state(inst: &crate::terminal::TerminalInstance) -> (bool, Option<i64>) {
    if let Ok(mut child) = inst.child.lock() {
        if let Ok(Some(status)) = child.try_wait() {
            return (true, Some(status.exit_code() as i64));
        }
    }
    (false, None)
}
