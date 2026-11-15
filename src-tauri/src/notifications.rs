use crate::persist::{app_state_get, app_state_set_checked, body, notifications, persist, revision_counter};
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
    match app_state_get("notificationCenter") {
        Some(raw) => serde_json::from_str::<Value>(&raw)
            .map(|value| center_from_stored(&value))
            .unwrap_or_else(|_| NotificationCenter {
                authorization: "notDetermined".into(),
                preferences: default_preferences(),
                persistence_error: None,
            }),
        None => NotificationCenter {
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
    match app_state_set_checked("notificationCenter", &payload) {
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
    // Clone and drop notifications() before locking revision_counter() or center(),
    // because persist() acquires revision_counter() before notifications().
    let notifs = { notifications().lock().unwrap().clone() };
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
    let revision = { *revision_counter().lock().unwrap() as i64 };
    let (authorization, preferences, persistence_error) = {
        let center = center().lock().unwrap();
        (
            center.authorization.clone(),
            center.preferences.clone(),
            center.persistence_error.clone(),
        )
    };
    json!({
        "schemaVersion": 1,
        "revision": revision,
        "records": notifs,
        "unreadCount": unread_count,
        "openInputRequestCount": open_input_count,
        "authorization": authorization,
        "preferences": preferences,
        "persistenceError": persistence_error,
        "archiveReadOnly": false,
        "openRecordId": Value::Null
    })
}

pub fn notifications_snapshot_direct(_request: Option<Value>) -> Value {
    make_notifications_snapshot()
}

#[tauri::command]
pub async fn notifications_snapshot(request: Option<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || notifications_snapshot_direct(request))
        .await
        .unwrap_or_else(|_| make_notifications_snapshot())
}

pub fn notifications_poll_direct(_request: Option<Value>) -> Value {
    make_notifications_snapshot()
}

#[tauri::command]
pub async fn notifications_poll(request: Option<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || notifications_poll_direct(request))
        .await
        .unwrap_or_else(|_| make_notifications_snapshot())
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

pub fn notifications_report_attention_direct(request: Option<Value>) -> Value {
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
pub async fn notifications_report_attention(request: Option<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || notifications_report_attention_direct(request))
        .await
        .unwrap_or_else(|_| make_notifications_snapshot())
}

fn format_auto_switch_confirmation_copy(
    confirmation: &crate::account_switcher::PendingAutoSwitchConfirmation,
) -> (String, String) {
    let from_label = if confirmation.from_account_label.trim().is_empty() {
        "current account"
    } else {
        confirmation.from_account_label.trim()
    };
    let to_target = match confirmation
        .to_plan_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(plan) => format!("{} ({})", confirmation.to_account_label, plan),
        None => confirmation.to_account_label.clone(),
    };
    let busy_count = confirmation.busy_sessions.len();
    let title = match confirmation.reason.as_str() {
        "busy_terminals_ask" => format!(
            "Confirm switch to {} ({} busy terminal{})",
            confirmation.to_account_label,
            busy_count,
            if busy_count == 1 { "" } else { "s" }
        ),
        "unverified_catalog" => format!(
            "Confirm switch to {} (catalog unverified)",
            confirmation.to_account_label
        ),
        _ => format!(
            "Model confirmation required to switch to {}",
            confirmation.to_account_label
        ),
    };

    let mut body = format!("Switching from {} to {}.", from_label, to_target);
    let req_model = confirmation
        .requested_model
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let fallback_model = confirmation
        .suggested_fallback_model
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    match confirmation.reason.as_str() {
        "busy_terminals_ask" => {
            if busy_count > 0 {
                body.push_str(&format!(
                    " {} active terminal session{} may be interrupted.",
                    busy_count,
                    if busy_count == 1 { "" } else { "s" }
                ));
            }
            if let Some(req) = req_model {
                body.push_str(&format!(" Current model: '{}'.", req));
            }
        }
        "unverified_catalog" => {
            if let Some(req) = req_model {
                body.push_str(&format!(
                    " Model '{}' compatibility is unverified for the target account.",
                    req
                ));
            }
            if let Some(fb) = fallback_model.filter(|fb| Some(*fb) != req_model) {
                body.push_str(&format!(" Suggested fallback: '{}'.", fb));
            }
        }
        _ => match (req_model, fallback_model) {
            (Some(req), Some(fb)) if !req.eq_ignore_ascii_case(fb) => {
                body.push_str(&format!(
                    " Requested model '{}' is unavailable; suggested fallback: '{}'.",
                    req, fb
                ));
            }
            (Some(req), _) => {
                body.push_str(&format!(" Requested model '{}' requires confirmation.", req));
            }
            (None, Some(fb)) => {
                body.push_str(&format!(" Suggested fallback model: '{}'.", fb));
            }
            (None, None) => {}
        },
    }

    (title, body)
}

/// Inserts or replaces a sticky actionable notification for a pending auto-switch confirmation.
/// Releases `notifications()` BEFORE snapshotting or calling `persist()`.
pub(crate) fn upsert_auto_switch_confirmation_notification(
    confirmation: &crate::account_switcher::PendingAutoSwitchConfirmation,
) -> Value {
    let id = format!("autoswitch_{}", confirmation.confirmation_id);
    let target = if let Some(ref tid) = confirmation.thread_id {
        json!({ "source": "codeThread", "id": tid })
    } else {
        json!({ "source": "accountVault", "id": confirmation.provider })
    };
    let (title, body) = format_auto_switch_confirmation_copy(confirmation);
    let notice = json!({
        "id": id,
        "runId": Value::Null,
        "target": target,
        "profileId": Value::Null,
        "routineId": Value::Null,
        "kind": {
            "kind": "autoSwitchConfirm",
            "requestKind": confirmation.reason,
        },
        "title": title,
        "body": body,
        "confirmationId": confirmation.confirmation_id,
        "autoSwitchConfirm": serde_json::to_value(confirmation).unwrap_or(Value::Null),
        "createdAtUnixMs": confirmation.created_at_unix_ms,
        "isRead": false,
        "isWaitingForInput": true,
        "resolution": Value::Null,
    });

    {
        let mut items = notifications().lock().unwrap();
        items.retain(|existing| existing.get("id").and_then(|v| v.as_str()) != Some(&id));
        items.insert(0, notice);
        if items.len() > 100 {
            items.truncate(100);
        }
    }

    let snapshot = make_notifications_snapshot();
    persist();
    snapshot
}

/// Resolves sticky auto-switch confirmation notifications in bulk (`"attended"` or `"abandoned"`).
/// Drops `notifications()` lock BEFORE calling `persist()`.
pub(crate) fn resolve_auto_switch_notifications_for_ids(
    confirmation_ids: &[String],
    resolution: &str,
) -> usize {
    if confirmation_ids.is_empty() {
        return 0;
    }
    let mut changed = 0usize;
    {
        let mut items = notifications().lock().unwrap();
        for item in items.iter_mut() {
            let matches = confirmation_ids.iter().any(|cid| {
                let expected_id = format!("autoswitch_{}", cid);
                item.get("confirmationId").and_then(|v| v.as_str()) == Some(cid.as_str())
                    || item.get("id").and_then(|v| v.as_str()) == Some(expected_id.as_str())
            });
            if !matches {
                continue;
            }
            let unresolved = item.get("resolution").map(|v| v.is_null()).unwrap_or(true)
                || item.get("isWaitingForInput").and_then(|v| v.as_bool()) == Some(true);
            if unresolved {
                item["resolution"] = json!(resolution);
                item["isWaitingForInput"] = json!(false);
                item["isRead"] = json!(true);
                changed += 1;
            }
        }
    }

    if changed > 0 {
        persist();
    }
    changed
}

#[allow(dead_code)]
pub(crate) fn resolve_auto_switch_confirmation_notification(
    confirmation_id: &str,
    resolution: &str,
) -> bool {
    resolve_auto_switch_notifications_for_ids(&[confirmation_id.to_string()], resolution) > 0
}

pub fn notifications_mark_read_direct(request: Option<Value>) -> Value {
    let req = body(&request);
    let record_id = req.and_then(|r| r.get("recordId")).and_then(|v| v.as_str()).unwrap_or("");
    let snapshot_items = {
        let mut items = notifications().lock().unwrap();
        if let Some(item) = items.iter_mut().find(|n| n.get("id").and_then(|v| v.as_str()) == Some(record_id)) {
            item["isRead"] = json!(true);
        }
        items.clone()
    };
    let snap = make_notifications_snapshot_inner(&snapshot_items);
    persist();
    snap
}

#[tauri::command]
pub async fn notifications_mark_read(request: Option<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || notifications_mark_read_direct(request))
        .await
        .unwrap_or_else(|_| make_notifications_snapshot())
}

pub fn notifications_mark_all_read_direct(_request: Option<Value>) -> Value {
    let snapshot_items = {
        let mut items = notifications().lock().unwrap();
        for item in items.iter_mut() {
            item["isRead"] = json!(true);
        }
        items.clone()
    };
    let snap = make_notifications_snapshot_inner(&snapshot_items);
    persist();
    snap
}

#[tauri::command]
pub async fn notifications_mark_all_read(request: Option<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || notifications_mark_all_read_direct(request))
        .await
        .unwrap_or_else(|_| make_notifications_snapshot())
}

pub fn notifications_mark_reviewed_direct(request: Option<Value>) -> Value {
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
pub async fn notifications_mark_reviewed(request: Option<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || notifications_mark_reviewed_direct(request))
        .await
        .unwrap_or_else(|_| make_notifications_snapshot())
}

pub fn notifications_request_authorization_direct(_request: Option<Value>) -> Value {
    let mut current = center().lock().unwrap();
    // Studio has no OS notification channel, so a local request cannot grant banners.
    current.authorization = "denied".into();
    current.persistence_error = save_center(&current);
    drop(current);
    make_notifications_snapshot()
}

#[tauri::command]
pub async fn notifications_request_authorization(request: Option<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || notifications_request_authorization_direct(request))
        .await
        .unwrap_or_else(|_| make_notifications_snapshot())
}

pub fn notifications_refresh_authorization_direct(_request: Option<Value>) -> Value {
    reload_center();
    make_notifications_snapshot()
}

#[tauri::command]
pub async fn notifications_refresh_authorization(request: Option<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || notifications_refresh_authorization_direct(request))
        .await
        .unwrap_or_else(|_| make_notifications_snapshot())
}

pub fn notifications_set_preferences_direct(request: Option<Value>) -> Value {
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
pub async fn notifications_set_preferences(request: Option<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || notifications_set_preferences_direct(request))
        .await
        .unwrap_or_else(|_| make_notifications_snapshot())
}

pub fn notifications_open_system_settings_direct(_request: Option<Value>) -> Value {
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
pub async fn notifications_open_system_settings(request: Option<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || notifications_open_system_settings_direct(request))
        .await
        .unwrap_or(Value::Null)
}

pub fn notifications_play_sample_direct(_request: Option<Value>) -> Value {
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

#[tauri::command]
pub async fn notifications_play_sample(request: Option<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || notifications_play_sample_direct(request))
        .await
        .unwrap_or(Value::Null)
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

        let updated = notifications_mark_read_direct(Some(json!({
            "request": { "recordId": &first_id }
        })));
        let updated_records = updated["records"].as_array().unwrap();
        let target = updated_records.iter().find(|r| r["id"] == first_id).unwrap();
        assert_eq!(target["isRead"], true);

        // Verify async wrapper returns valid snapshot too.
        let async_snap = tauri::async_runtime::block_on(notifications_snapshot(None));
        assert!(async_snap.get("records").is_some());

        // Mark all read
        let all_read = notifications_mark_all_read_direct(None);
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

    #[test]
    fn test_auto_switch_confirmation_notification_upsert_and_resolve() {
        let cid = format!("conf-test-{}", Uuid::new_v4().simple());
        struct Cleanup(String);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let target_id = format!("autoswitch_{}", self.0);
                let mut items = notifications().lock().unwrap();
                items.retain(|n| n.get("id").and_then(|v| v.as_str()) != Some(target_id.as_str()));
            }
        }
        let _cleanup = Cleanup(cid.clone());

        let conf = crate::account_switcher::PendingAutoSwitchConfirmation {
            confirmation_id: cid.clone(),
            provider: "agy".to_string(),
            from_account_id: Some("a1".to_string()),
            from_account_label: "Work Pro".to_string(),
            from_email: Some("work@kite.local".to_string()),
            to_account_id: "a2".to_string(),
            to_account_label: "Personal Free".to_string(),
            to_email: Some("personal@kite.local".to_string()),
            to_plan_name: Some("Free".to_string()),
            source_plan_name: Some("Google AI Pro".to_string()),
            requested_model: Some("claude-opus-4-6".to_string()),
            suggested_fallback_model: Some("gemini-2.5-pro".to_string()),
            available_target_models: vec!["gemini-2.5-pro".to_string()],
            thread_id: Some("thread-notif-1".to_string()),
            handoff_prompt: Some("Resume now".to_string()),
            busy_sessions: Vec::new(),
            reason: "model_mismatch".to_string(),
            created_at_unix_ms: 100_000,
            expires_at_unix_ms: 1_000_000,
        };

        let snap = upsert_auto_switch_confirmation_notification(&conf);
        let expected_id = format!("autoswitch_{}", cid);
        let records = snap["records"].as_array().unwrap();
        let rec = records
            .iter()
            .find(|r| r["id"] == expected_id)
            .expect("auto-switch notification record");
        assert_eq!(rec["kind"]["kind"], "autoSwitchConfirm");
        assert_eq!(rec["kind"]["requestKind"], "model_mismatch");
        assert_eq!(rec["target"]["source"], "codeThread");
        assert_eq!(rec["target"]["id"], "thread-notif-1");
        assert_eq!(rec["confirmationId"], cid);
        assert_eq!(rec["autoSwitchConfirm"]["toAccountId"], "a2");
        assert_eq!(rec["isWaitingForInput"], true);
        assert_eq!(rec["isRead"], false);
        assert!(rec["resolution"].is_null());
        let body = rec["body"].as_str().unwrap_or("");
        assert!(body.contains("Work Pro"));
        assert!(body.contains("Personal Free"));
        assert!(body.contains("Free"));
        assert!(body.contains("claude-opus-4-6"));
        assert!(body.contains("gemini-2.5-pro"));

        assert!(resolve_auto_switch_confirmation_notification(&cid, "attended"));
        let snap2 = make_notifications_snapshot();
        let rec2 = snap2["records"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == expected_id)
            .unwrap();
        assert_eq!(rec2["resolution"], "attended");
        assert_eq!(rec2["isWaitingForInput"], false);
    }
}
