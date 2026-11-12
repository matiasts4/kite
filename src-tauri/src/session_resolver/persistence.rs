use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PersistedTerminalSession {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
    pub base_engine: String,
    pub active_engine: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_session_id: Option<String>,
    pub cwd: String,
    #[serde(default)]
    pub had_user_activity: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_user_input: Option<String>,
    pub spawned_at_unix_ms: i64,
    pub saved_at_unix_ms: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedTerminalSessionsFile {
    #[serde(default)]
    pub sessions: HashMap<String, PersistedTerminalSession>,
}

pub fn persisted_sessions_file_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

pub fn terminal_sessions_file_path() -> PathBuf {
    crate::persist::roaming_app_dir().join("terminal-sessions.json")
}

pub fn read_persisted_terminal_sessions_unlocked() -> HashMap<String, PersistedTerminalSession> {
    let path = terminal_sessions_file_path();
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return HashMap::new();
    };
    if let Ok(parsed) = serde_json::from_str::<PersistedTerminalSessionsFile>(&raw) {
        return parsed.sessions;
    }
    serde_json::from_str::<HashMap<String, PersistedTerminalSession>>(&raw).unwrap_or_default()
}

pub fn write_persisted_terminal_sessions_unlocked(
    sessions: &HashMap<String, PersistedTerminalSession>,
) {
    let path = terminal_sessions_file_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let payload = PersistedTerminalSessionsFile {
        sessions: sessions.clone(),
    };
    if let Ok(json) = serde_json::to_string_pretty(&payload) {
        let unique_ext = format!("json.{}.tmp", uuid::Uuid::new_v4().simple());
        let tmp_path = path.with_extension(unique_ext);
        if std::fs::write(&tmp_path, &json).is_ok() {
            if std::fs::rename(&tmp_path, &path).is_err() {
                let _ = std::fs::write(&path, &json);
                let _ = std::fs::remove_file(&tmp_path);
            }
        } else {
            let _ = std::fs::write(&path, &json);
        }
    }
}

pub fn read_persisted_terminal_sessions() -> HashMap<String, PersistedTerminalSession> {
    let _guard = persisted_sessions_file_lock()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    read_persisted_terminal_sessions_unlocked()
}

pub fn write_persisted_terminal_sessions(sessions: &HashMap<String, PersistedTerminalSession>) {
    let _guard = persisted_sessions_file_lock()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    write_persisted_terminal_sessions_unlocked(sessions);
}

pub fn get_persisted_terminal_session(session_id: &str) -> Option<PersistedTerminalSession> {
    let _guard = persisted_sessions_file_lock()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    read_persisted_terminal_sessions_unlocked().remove(session_id)
}

pub fn upsert_persisted_terminal_session(record: PersistedTerminalSession) {
    upsert_persisted_terminal_session_inner(record, false);
}

pub fn upsert_persisted_terminal_session_clearing_provider(record: PersistedTerminalSession) {
    upsert_persisted_terminal_session_inner(record, true);
}

pub fn upsert_persisted_terminal_session_inner(
    record: PersistedTerminalSession,
    clear_provider_session_id: bool,
) {
    let _guard = persisted_sessions_file_lock()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let mut map = read_persisted_terminal_sessions_unlocked();
    let merged = if let Some(prev) = map.get(&record.session_id) {
        PersistedTerminalSession {
            session_id: record.session_id,
            workspace_id: record.workspace_id.or_else(|| prev.workspace_id.clone()),
            pane_id: record.pane_id.or_else(|| prev.pane_id.clone()),
            base_engine: if record.base_engine.is_empty() {
                prev.base_engine.clone()
            } else {
                record.base_engine
            },
            active_engine: if record.active_engine.is_empty() {
                prev.active_engine.clone()
            } else {
                record.active_engine
            },
            provider_session_id: if clear_provider_session_id {
                record.provider_session_id
            } else {
                record
                    .provider_session_id
                    .or_else(|| prev.provider_session_id.clone())
            },
            cwd: if record.cwd.is_empty() {
                prev.cwd.clone()
            } else {
                record.cwd
            },
            had_user_activity: record.had_user_activity || prev.had_user_activity,
            last_user_input: record
                .last_user_input
                .or_else(|| prev.last_user_input.clone()),
            spawned_at_unix_ms: if record.spawned_at_unix_ms > 0 {
                record.spawned_at_unix_ms
            } else {
                prev.spawned_at_unix_ms
            },
            saved_at_unix_ms: record.saved_at_unix_ms,
        }
    } else {
        record
    };
    map.insert(merged.session_id.clone(), merged);
    write_persisted_terminal_sessions_unlocked(&map);
}

pub fn remove_persisted_terminal_session(session_id: &str) {
    let _guard = persisted_sessions_file_lock()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let mut map = read_persisted_terminal_sessions_unlocked();
    if map.remove(session_id).is_some() {
        write_persisted_terminal_sessions_unlocked(&map);
    }
}
