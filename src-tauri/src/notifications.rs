use crate::persist::{body, db_connection, notifications, persist, revision_counter};
use rusqlite::params;
use serde_json::{json, Value};
use std::sync::{Mutex, OnceLock};
use uuid::Uuid;

struct NotificationCenter {
    authorization: String,
    preferences: Value,
    persistence_error: Option<String>,
}

fn default_preferences() -> Value {
    json!({
        "schemaVersion": 1,
        "osNotificationsEnabled": false,
        "finishSoundEnabled": true,
        "inputRequestsEnabled": true
    })
}

fn valid_authorization(value: &str) -> bool {
    matches!(
        value,
        "notDetermined" | "denied" | "authorized" | "provisional"
    )
}

fn center_from_stored(value: &Value) -> NotificationCenter {
    let authorization = value
        .get("authorization")
        .and_then(|v| v.as_str())
        .filter(|v| valid_authorization(v))
        .unwrap_or("notDetermined")
        .to_string();
    let stored = value.get("preferences");
    let preferences = json!({
        "schemaVersion": 1,
        "osNotificationsEnabled": stored
            .and_then(|p| p.get("osNotificationsEnabled"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        "finishSoundEnabled": stored
            .and_then(|p| p.get("finishSoundEnabled"))
            .and_then(|v| v.as_bool())
            .unwrap_or(true),
        "inputRequestsEnabled": stored
            .and_then(|p| p.get("inputRequestsEnabled"))
            .and_then(|v| v.as_bool())
            .unwrap_or(true)
    });
    NotificationCenter {
        authorization,
        preferences,
        persistence_error: None,
    }
}

fn load_center() -> NotificationCenter {
    let stored = db_connection().lock().unwrap().query_row(
        "SELECT value FROM app_state WHERE key = 'notificationCenter'",
        [],
        |row| row.get::<_, String>(0),
    );
    match stored {
        Ok(raw) => serde_json::from_str::<Value>(&raw)
            .map(|value| center_from_stored(&value))
            .unwrap_or_else(|_| NotificationCenter {
                authorization: "notDetermined".into(),
                preferences: default_preferences(),
                persistence_error: None,
            }),
        Err(_) => NotificationCenter {
            authorization: "notDetermined".into(),
            preferences: default_preferences(),
            persistence_error: None,
        },
    }
}

fn center() -> &'static Mutex<NotificationCenter> {
    static CELL: OnceLock<Mutex<NotificationCenter>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(load_center()))
}

fn save_center(center: &NotificationCenter) -> Option<String> {
    let payload = json!({
        "authorization": center.authorization,
        "preferences": center.preferences
    })
    .to_string();
    let result = db_connection().lock().unwrap().execute(
        "INSERT INTO app_state (key, value) VALUES ('notificationCenter', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![payload],
    );
    match result {
        Ok(_) => None,
        Err(error) => Some(format!("Notification settings could not be saved: {error}")),
    }
}

fn reload_center() {
    let loaded = load_center();
    let mut current = center().lock().unwrap();
    current.authorization = loaded.authorization;
    current.preferences = loaded.preferences;
    current.persistence_error = None;
}

pub fn make_notifications_snapshot() -> Value {
    let notifs = notifications().lock().unwrap();
    make_notifications_snapshot_inner(&notifs)
}

pub fn make_notifications_snapshot_inner(notifs: &[Value]) -> Value {
    let unread_count = notifs
        .iter()
        .filter(|n| n.get("isRead").and_then(|v| v.as_bool()) == Some(false))
        .count();
    let open_input_count = notifs
        .iter()
        .filter(|n| n.get("isWaitingForInput").and_then(|v| v.as_bool()) == Some(true))
        .count();
    let revision = *revision_counter().lock().unwrap() as i64;
    let center = center().lock().unwrap();
    json!({
        "schemaVersion": 1,
        "revision": revision,
        "records": notifs,
        "unreadCount": unread_count,
        "openInputRequestCount": open_input_count,
        "authorization": center.authorization,
        "preferences": center.preferences,
        "persistenceError": center.persistence_error,
        "archiveReadOnly": false,
        "openRecordId": Value::Null
    })
}

#[tauri::command]
pub fn notifications_snapshot(_request: Option<Value>) -> Value {
    make_notifications_snapshot()
}

#[tauri::command]
pub fn notifications_poll(_request: Option<Value>) -> Value {
    make_notifications_snapshot()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

/// Normalizes the `payload` object carried by `notifications_report_attention`.
/// Returns `None` when the caller supplied nothing actionable so the command stays
/// backward-compatible with plain snapshot polling.
fn attention_payload(request: &Option<Value>) -> Option<Value> {
    let req = body(request)?;
    let raw = req.get("payload")?;
    let payload = match raw {
        Value::String(text) => serde_json::from_str::<Value>(text).ok()?,
        other => other.clone(),
    };
    if !payload.is_object() {
        return None;
    }
    if payload
        .as_object()
        .map(|object| object.is_empty())
        .unwrap_or(true)
    {
        return None;
    }
    Some(payload)
}

#[tauri::command]
pub fn notifications_report_attention(request: Option<Value>) -> Value {
    let Some(payload) = attention_payload(&request) else {
        return make_notifications_snapshot();
    };

    let kind = payload
        .get("kind")
        .and_then(|v| v.as_str())
        .unwrap_or("settled");
    let title = payload
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let detail = payload
        .get("body")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let session_id = payload
        .get("sessionId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let workspace_id = payload
        .get("workspaceId")
        .and_then(|v| v.as_str())
        .map(|value| value.to_string());

    if title.is_empty() && detail.is_empty() {
        return make_notifications_snapshot();
    }

    let target_id = if session_id.is_empty() {
        workspace_id.unwrap_or_else(|| "terminal".to_string())
    } else {
        session_id
    };

    let (record_kind, waiting_for_input) = match kind {
        "needs_input" | "needsInput" => (
            json!({ "kind": "needsInput", "requestKind": "question" }),
            true,
        ),
        "error" | "failed" => (json!({ "kind": "settled", "outcome": "failed" }), false),
        _ => (json!({ "kind": "settled", "outcome": "completed" }), false),
    };

    let notice = json!({
        "id": Uuid::new_v4().to_string(),
        "runId": Value::Null,
        "target": { "source": "terminal", "id": target_id },
        "profileId": Value::Null,
        "routineId": Value::Null,
        "kind": record_kind,
        "title": title,
        "body": detail,
        "resolution": Value::Null,
        "createdAtUnixMs": now_ms(),
        "isRead": false,
        "isWaitingForInput": waiting_for_input
    });

    {
        let mut items = notifications().lock().unwrap();
        items.insert(0, notice);
        if items.len() > 100 {
            items.truncate(100);
        }
    }

    let snapshot = make_notifications_snapshot();
    persist();
    snapshot
}

#[tauri::command]
pub fn notifications_mark_read(request: Option<Value>) -> Value {
    let req = body(&request);
    let record_id = req.and_then(|r| r.get("recordId")).and_then(|v| v.as_str()).unwrap_or("");
    let mut items = notifications().lock().unwrap();
    if let Some(item) = items.iter_mut().find(|n| n.get("id").and_then(|v| v.as_str()) == Some(record_id)) {
        item["isRead"] = json!(true);
    }
    let snap = make_notifications_snapshot_inner(&items);
    drop(items);
    persist();
    snap
}

#[tauri::command]
pub fn notifications_mark_all_read(_request: Option<Value>) -> Value {
    let mut items = notifications().lock().unwrap();
    for item in items.iter_mut() {
        item["isRead"] = json!(true);
    }
    let snap = make_notifications_snapshot_inner(&items);
    drop(items);
    persist();
    snap
}

#[tauri::command]
pub fn notifications_mark_reviewed(request: Option<Value>) -> Value {
    let req = body(&request);
    let ids: Vec<String> = if let Some(arr) = req.and_then(|r| r.as_array()) {
        arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect()
    } else if let Some(arr) = req.and_then(|r| r.get("recordIds")).and_then(|v| v.as_array()) {
        arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect()
    } else {
        Vec::new()
    };
    let mut items = notifications().lock().unwrap();
    for item in items.iter_mut() {
        if let Some(id) = item.get("id").and_then(|v| v.as_str()) {
            if ids.iter().any(|target| target == id) {
                item["isRead"] = json!(true);
            }
        }
    }
    drop(items);
    persist();
    make_notifications_snapshot()
}

#[tauri::command]
pub fn notifications_request_authorization(_request: Option<Value>) -> Value {
    let mut current = center().lock().unwrap();
    // Studio has no OS notification channel, so a local request cannot grant banners.
    current.authorization = "denied".into();
    current.persistence_error = save_center(&current);
    drop(current);
    make_notifications_snapshot()
}

#[tauri::command]
pub fn notifications_refresh_authorization(_request: Option<Value>) -> Value {
    reload_center();
    make_notifications_snapshot()
}

#[tauri::command]
pub fn notifications_set_preferences(request: Option<Value>) -> Value {
    let req = body(&request);
    let mut current = center().lock().unwrap();
    let previous = current.preferences.clone();
    let bool_field = |name: &str, fallback: bool| {
        req.and_then(|r| r.get(name))
            .and_then(|v| v.as_bool())
            .or_else(|| previous.get(name).and_then(|v| v.as_bool()))
            .unwrap_or(fallback)
    };
    current.preferences = json!({
        "schemaVersion": 1,
        "osNotificationsEnabled": bool_field("osNotificationsEnabled", false),
        "finishSoundEnabled": bool_field("finishSoundEnabled", true),
        "inputRequestsEnabled": bool_field("inputRequestsEnabled", true)
    });
    current.persistence_error = save_center(&current);
    drop(current);
    make_notifications_snapshot()
}

#[tauri::command]
pub fn notifications_open_system_settings(_request: Option<Value>) -> Value {
    #[cfg(windows)]
    {
        #[link(name = "shell32")]
        extern "system" {
            fn ShellExecuteW(
                hwnd: *mut std::ffi::c_void,
                lpOperation: *const u16,
                lpFile: *const u16,
                lpParameters: *const u16,
                lpDirectory: *const u16,
                nShowCmd: i32,
            ) -> isize;
        }
        use std::os::windows::ffi::OsStrExt;
        let op: Vec<u16> = std::ffi::OsStr::new("open").encode_wide().chain(Some(0)).collect();
        let file: Vec<u16> = std::ffi::OsStr::new("ms-settings:notifications").encode_wide().chain(Some(0)).collect();
        unsafe {
            ShellExecuteW(std::ptr::null_mut(), op.as_ptr(), file.as_ptr(), std::ptr::null(), std::ptr::null(), 1);
        }
    }
    Value::Null
}

#[tauri::command]
pub fn notifications_play_sample(_request: Option<Value>) -> Value {
    #[cfg(windows)]
    {
        #[link(name = "user32")]
        extern "system" {
            fn MessageBeep(uType: u32) -> i32;
        }
        const MB_ICONASTERISK: u32 = 0x0000_0040;
        unsafe {
            MessageBeep(MB_ICONASTERISK);
        }
    }
    Value::Null
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_notifications_snapshot_and_mark_read() {
        let snap = make_notifications_snapshot();
        let records = snap["records"].as_array().expect("records array");
        assert!(!records.is_empty());
        let first_id = records[0]["id"].as_str().unwrap().to_string();

        let updated = notifications_mark_read(Some(json!({
            "request": { "recordId": &first_id }
        })));
        let updated_records = updated["records"].as_array().unwrap();
        let target = updated_records.iter().find(|r| r["id"] == first_id).unwrap();
        assert_eq!(target["isRead"], true);

        // Mark all read
        let all_read = notifications_mark_all_read(None);
        assert_eq!(all_read["unreadCount"], 0);
    }

    #[test]
    fn test_settle_turn_and_approval_notifications() {
        crate::chat::runtime::settle_turn_notification(
            "run-test-1",
            "thread-test-1",
            Some("agent-1"),
            true,
            false,
        );
        let snap = make_notifications_snapshot();
        let records = snap["records"].as_array().unwrap();
        let found = records.iter().find(|r| r["runId"] == "run-test-1").expect("found settled notification");
        assert_eq!(found["kind"]["kind"], "settled");
        assert_eq!(found["kind"]["outcome"], "completed");
        assert_eq!(found["target"]["source"], "agentChat");
        assert_eq!(found["isWaitingForInput"], false);

        // Simulate an approval needsInput notice
        {
            let mut items = notifications().lock().unwrap();
            items.insert(0, json!({
                "id": "approval-req-99",
                "runId": "run-test-2",
                "target": { "source": "codeThread", "id": "thread-test-2" },
                "profileId": Value::Null,
                "routineId": Value::Null,
                "kind": { "kind": "needsInput", "requestKind": "toolApproval" },
                "resolution": Value::Null,
                "createdAtUnixMs": 1000,
                "isRead": false,
                "isWaitingForInput": true
            }));
        }
        let snap2 = make_notifications_snapshot();
        assert!(snap2["openInputRequestCount"].as_i64().unwrap_or(0) >= 1);
        let records2 = snap2["records"].as_array().unwrap();
        let approval = records2.iter().find(|r| r["id"] == "approval-req-99").unwrap();
        assert_eq!(approval["isWaitingForInput"], true);
    }
}
