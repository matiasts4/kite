use crate::persist::{body, db_connection, notifications, persist, revision_counter};
use rusqlite::params;
use serde_json::{json, Value};
use std::sync::{Mutex, OnceLock};

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

#[tauri::command]
pub fn notifications_report_attention(_request: Option<Value>) -> Value {
    make_notifications_snapshot()
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
        use std::os::windows::process::CommandExt;
        let mut cmd = std::process::Command::new("cmd");
        cmd.creation_flags(0x08000000);
        let _ = cmd.args(["/C", "start", "", "ms-settings:notifications"]).spawn();
    }
    Value::Null
}

#[tauri::command]
pub fn notifications_play_sample(_request: Option<Value>) -> Value {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut cmd = std::process::Command::new("powershell");
        cmd.creation_flags(0x08000000);
        let _ = cmd
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "[System.Media.SystemSounds]::Asterisk.Play()",
            ])
            .spawn();
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
}
