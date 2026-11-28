use crate::persist::{
    agents, app_state_get, app_state_set_checked, body, notifications, persist, revision_counter,
    routines, threads,
};
use serde_json::{json, Value};
use std::sync::{Mutex, OnceLock};
use uuid::Uuid;

pub const KITE_APP_USER_MODEL_ID: &str = "dev.kite.code";

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ResolvedNotificationMeta {
    pub actor_name: Option<String>,
    pub thread_title: Option<String>,
    pub workspace_id: Option<String>,
}

struct NotificationCenter {
    authorization: String,
    preferences: Value,
    persistence_error: Option<String>,
}

fn default_authorization() -> &'static str {
    if cfg!(windows) {
        "authorized"
    } else {
        "notDetermined"
    }
}

fn default_preferences() -> Value {
    json!({
        "schemaVersion": 2,
        "osNotificationsEnabled": cfg!(windows),
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
    let stored_auth = value
        .get("authorization")
        .and_then(|v| v.as_str())
        .filter(|v| valid_authorization(v))
        .unwrap_or("notDetermined");
    let stored = value.get("preferences");
    let stored_schema = stored
        .and_then(|p| p.get("schemaVersion"))
        .and_then(|v| v.as_i64())
        .unwrap_or(1);
    let stored_os_enabled = stored
        .and_then(|p| p.get("osNotificationsEnabled"))
        .and_then(|v| v.as_bool());

    let upgrade_legacy_windows = cfg!(windows)
        && stored_schema < 2
        && matches!(stored_auth, "notDetermined" | "denied")
        && stored_os_enabled != Some(true);

    let (authorization, os_notifications_enabled) = if upgrade_legacy_windows {
        ("authorized".to_string(), true)
    } else {
        (stored_auth.to_string(), stored_os_enabled.unwrap_or(false))
    };

    let preferences = json!({
        "schemaVersion": 2,
        "osNotificationsEnabled": os_notifications_enabled,
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
                authorization: default_authorization().into(),
                preferences: default_preferences(),
                persistence_error: None,
            }),
        None => NotificationCenter {
            authorization: default_authorization().into(),
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

/// Emits `"kite://notifications-updated"` to the Tauri frontend.
/// NEVER call while holding `notifications()`, `center()`, `revision_counter()`,
/// `threads()`, `agents()`, or `routines()`.
pub fn emit_notifications_updated() {
    if let Some(app) = crate::get_app_handle() {
        use tauri::Emitter;
        let _ = app.emit("kite://notifications-updated", json!({ "ts": now_ms() }));
    }
}

fn non_empty_trimmed(raw: Option<&str>) -> Option<String> {
    raw.map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn is_generic_thread_title(title: &str) -> bool {
    let lower = title.trim().to_ascii_lowercase();
    lower.is_empty() || matches!(lower.as_str(), "new thread" | "new chat" | "untitled")
}

/// Resolves characteristic actor name, thread title, and workspace id from
/// persisted stores. Acquires and drops `threads()`, `routines()`, and `agents()`
/// in strictly separate short scopes, never nesting locks and never acquiring
/// `notifications()`, `revision_counter()`, or `center()`.
pub fn resolve_notification_context(
    thread_id: Option<&str>,
    profile_id: Option<&str>,
    routine_id: Option<&str>,
) -> ResolvedNotificationMeta {
    let tid = non_empty_trimmed(thread_id);
    let pid = non_empty_trimmed(profile_id);
    let rid = non_empty_trimmed(routine_id);

    let (thread_title, thread_profile_id, thread_workspace_id) = if let Some(tid) = tid.as_deref() {
        if let Ok(items) = threads().lock() {
            if let Some(thread) = items
                .iter()
                .find(|t| t.get("id").and_then(Value::as_str) == Some(tid))
            {
                let title = thread
                    .get("title")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !is_generic_thread_title(s))
                    .map(str::to_string);
                let prof = non_empty_trimmed(thread.get("profileId").and_then(Value::as_str));
                let ws = non_empty_trimmed(thread.get("workspaceId").and_then(Value::as_str));
                (title, prof, ws)
            } else {
                (None, None, None)
            }
        } else {
            (None, None, None)
        }
    } else {
        (None, None, None)
    };

    let (routine_name, routine_agent_id, routine_workspace_id) = if let Some(rid) = rid.as_deref() {
        if let Ok(items) = routines().lock() {
            if let Some(routine) = items
                .iter()
                .find(|r| r.get("id").and_then(Value::as_str) == Some(rid))
            {
                let name = non_empty_trimmed(routine.get("name").and_then(Value::as_str));
                let aid = non_empty_trimmed(routine.get("agentId").and_then(Value::as_str));
                let ws = non_empty_trimmed(routine.get("workspaceId").and_then(Value::as_str));
                (name, aid, ws)
            } else {
                (None, None, None)
            }
        } else {
            (None, None, None)
        }
    } else {
        (None, None, None)
    };

    let effective_profile_id = pid.or(thread_profile_id).or(routine_agent_id);
    let workspace_id = thread_workspace_id.or(routine_workspace_id);

    let agent_name = if let Some(aid) = effective_profile_id.as_deref() {
        agents().lock().ok().and_then(|list| {
            list.iter()
                .find(|a| a.id == aid)
                .and_then(|a| non_empty_trimmed(Some(a.name.as_str())))
        })
    } else {
        None
    };

    let actor_name = agent_name.or_else(|| routine_name.clone());
    let resolved_thread_title = if rid.is_some() {
        routine_name.or(thread_title)
    } else {
        thread_title
    };

    ResolvedNotificationMeta {
        actor_name,
        thread_title: resolved_thread_title,
        workspace_id,
    }
}

fn sanitize_and_escape_xml(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        if ch.is_ascii_control() && !matches!(ch, '\n' | '\r' | '\t') {
            continue;
        }
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            other => out.push(other),
        }
    }
    out
}

pub(crate) fn build_windows_toast_xml(title: &str, body: &str, silent: bool) -> String {
    let clean_title = sanitize_and_escape_xml(title.trim());
    let clean_body = sanitize_and_escape_xml(body.trim());
    let body_node = if clean_body.is_empty() {
        String::new()
    } else {
        format!("<text>{clean_body}</text>")
    };
    let audio_node = if silent {
        "<audio silent=\"true\"/>"
    } else {
        ""
    };
    format!(
        "<toast><visual><binding template=\"ToastGeneric\"><text>{clean_title}</text>{body_node}</binding></visual>{audio_node}</toast>"
    )
}

pub(crate) fn windows_toast_tag_hash(raw: &str) -> String {
    const FNV_OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
    const FNV_PRIME: u64 = 0x0100_0000_01b3;
    let mut hash = FNV_OFFSET_BASIS;
    for byte in raw.trim().as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    format!("{hash:016x}")
}

#[cfg(all(windows, not(test)))]
fn utf16_reg_sz_bytes(value: &str) -> Vec<u8> {
    value
        .encode_utf16()
        .chain(std::iter::once(0u16))
        .flat_map(u16::to_le_bytes)
        .collect()
}

#[cfg(all(windows, not(test)))]
fn resolve_windows_toast_icon_uri() -> Option<String> {
    let mut candidates = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("icons").join("icon.ico"));
            candidates.push(dir.join("icon.ico"));
            candidates.push(dir.join("resources").join("icons").join("icon.ico"));
            if let Some(parent) = dir.parent() {
                candidates.push(parent.join("icons").join("icon.ico"));
                if let Some(grandparent) = parent.parent() {
                    candidates.push(grandparent.join("icons").join("icon.ico"));
                }
            }
        }
    }
    candidates.push(std::path::PathBuf::from("icons/icon.ico"));
    candidates.push(std::path::PathBuf::from("src-tauri/icons/icon.ico"));
    for candidate in candidates {
        if candidate.is_file() {
            let resolved = candidate.canonicalize().unwrap_or(candidate);
            let text = resolved.to_string_lossy();
            return Some(text.strip_prefix(r"\\?\").unwrap_or(text.as_ref()).to_string());
        }
    }
    None
}

pub fn init_os_notifications() {
    static OS_NOTIF_INIT: OnceLock<()> = OnceLock::new();
    OS_NOTIF_INIT.get_or_init(|| {
        #[cfg(all(windows, not(test)))]
        {
            use windows::core::{HSTRING, PCWSTR};
            use windows::Win32::Foundation::ERROR_SUCCESS;
            use windows::Win32::System::Registry::{
                RegCloseKey, RegCreateKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_WRITE,
                REG_OPTION_NON_VOLATILE, REG_SZ,
            };
            use windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;

            let subkey = HSTRING::from(format!(
                "Software\\Classes\\AppUserModelId\\{KITE_APP_USER_MODEL_ID}"
            ));
            let mut hkey = HKEY::default();
            let reg_status = unsafe {
                RegCreateKeyExW(
                    HKEY_CURRENT_USER,
                    &subkey,
                    None,
                    PCWSTR::null(),
                    REG_OPTION_NON_VOLATILE,
                    KEY_WRITE,
                    None,
                    &mut hkey,
                    None,
                )
            };
            if reg_status == ERROR_SUCCESS {
                let display_name = HSTRING::from("DisplayName");
                let display_bytes = utf16_reg_sz_bytes("Kite Code");
                let set_display = unsafe {
                    RegSetValueExW(hkey, &display_name, None, REG_SZ, Some(&display_bytes))
                };
                if set_display != ERROR_SUCCESS {
                    crate::logger::log_trace(&format!(
                        "init_os_notifications: failed to write DisplayName registry value: {:?}",
                        set_display
                    ));
                }
                if let Some(icon_uri) = resolve_windows_toast_icon_uri() {
                    let icon_name = HSTRING::from("IconUri");
                    let icon_bytes = utf16_reg_sz_bytes(&icon_uri);
                    let set_icon = unsafe {
                        RegSetValueExW(hkey, &icon_name, None, REG_SZ, Some(&icon_bytes))
                    };
                    if set_icon != ERROR_SUCCESS {
                        crate::logger::log_trace(&format!(
                            "init_os_notifications: failed to write IconUri registry value: {:?}",
                            set_icon
                        ));
                    }
                }
                unsafe {
                    let _ = RegCloseKey(hkey);
                }
            } else {
                crate::logger::log_trace(&format!(
                    "init_os_notifications: RegCreateKeyExW failed: {:?}",
                    reg_status
                ));
            }

            if let Err(err) = unsafe {
                SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(KITE_APP_USER_MODEL_ID))
            } {
                crate::logger::log_trace(&format!(
                    "init_os_notifications: SetCurrentProcessExplicitAppUserModelID failed: {err}"
                ));
            }
        }
    });
}

pub fn send_os_notification(
    title: &str,
    body: &str,
    tag: Option<&str>,
    silent: bool,
) -> Result<(), String> {
    if title.trim().is_empty() && body.trim().is_empty() {
        return Err("Notification title and body cannot both be empty.".to_string());
    }

    #[cfg(all(windows, not(test)))]
    {
        use windows::core::HSTRING;
        use windows::Data::Xml::Dom::XmlDocument;
        use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};
        use windows::Win32::Foundation::{RPC_E_CHANGED_MODE, S_FALSE, S_OK};
        use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

        init_os_notifications();

        struct ComGuard(bool);
        impl Drop for ComGuard {
            fn drop(&mut self) {
                if self.0 {
                    unsafe {
                        CoUninitialize();
                    }
                }
            }
        }

        let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        if hr != S_OK && hr != S_FALSE && hr != RPC_E_CHANGED_MODE {
            return Err(format!("CoInitializeEx failed: {hr:?}"));
        }
        let _com_guard = ComGuard(hr == S_OK || hr == S_FALSE);

        let xml = build_windows_toast_xml(title, body, silent);
        let doc = XmlDocument::new().map_err(|e| format!("XmlDocument::new failed: {e}"))?;
        doc.LoadXml(&HSTRING::from(xml))
            .map_err(|e| format!("XmlDocument::LoadXml failed: {e}"))?;
        let toast = ToastNotification::CreateToastNotification(&doc)
            .map_err(|e| format!("CreateToastNotification failed: {e}"))?;

        if let Some(raw_tag) = tag.map(str::trim).filter(|s| !s.is_empty()) {
            let toast_tag = windows_toast_tag_hash(raw_tag);
            let _ = toast.SetTag(&HSTRING::from(toast_tag));
            let _ = toast.SetGroup(&HSTRING::from("kite"));
        }

        let notifier = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(
            KITE_APP_USER_MODEL_ID,
        ))
        .map_err(|e| format!("CreateToastNotifierWithId failed: {e}"))?;
        notifier
            .Show(&toast)
            .map_err(|e| format!("ToastNotificationManager Show failed: {e}"))?;
        Ok(())
    }

    #[cfg(any(not(windows), test))]
    {
        let _ = (tag, silent);
        Ok(())
    }
}

pub fn notifications_send_os_direct(request: Option<Value>) -> Value {
    let req = body(&request);
    let title = req.and_then(|r| r.get("title")).and_then(Value::as_str).unwrap_or("");
    let body_text = req.and_then(|r| r.get("body")).and_then(Value::as_str).unwrap_or("");
    let tag = req.and_then(|r| r.get("tag")).and_then(Value::as_str);
    let silent = req.and_then(|r| r.get("silent")).and_then(Value::as_bool).unwrap_or(false);
    let force_test = req
        .and_then(|r| r.get("forceTest"))
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let os_enabled = {
        let current = center().lock().unwrap();
        current
            .preferences
            .get("osNotificationsEnabled")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    };

    if !force_test && !os_enabled {
        return json!({
            "ok": false,
            "skipped": true,
            "reason": "os_notifications_disabled"
        });
    }

    match send_os_notification(title, body_text, tag, silent) {
        Ok(()) => json!({ "ok": true }),
        Err(err) => json!({ "ok": false, "error": err }),
    }
}

#[tauri::command]
pub async fn notifications_send_os(request: Option<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || notifications_send_os_direct(request))
        .await
        .unwrap_or_else(|err| json!({ "ok": false, "error": err.to_string() }))
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
    let explicit_workspace_id = non_empty_trimmed(payload.get("workspaceId").and_then(|v| v.as_str()));

    if title.is_empty() && detail.is_empty() {
        return make_notifications_snapshot();
    }

    let source = payload
        .get("source")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| matches!(*s, "terminal" | "agentChat" | "codeThread" | "codeTerminal"))
        .unwrap_or("terminal")
        .to_string();
    let profile_id = non_empty_trimmed(payload.get("profileId").and_then(Value::as_str))
        .or_else(|| non_empty_trimmed(payload.get("agentId").and_then(Value::as_str)));
    let thread_id = non_empty_trimmed(payload.get("threadId").and_then(Value::as_str));
    let explicit_actor_name = non_empty_trimmed(payload.get("actorName").and_then(Value::as_str));
    let explicit_thread_title = non_empty_trimmed(payload.get("threadTitle").and_then(Value::as_str));
    let explicit_module = payload
        .get("module")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| matches!(*s, "agent" | "code" | "chat"))
        .map(str::to_string);

    let resolved = if (profile_id.is_some() || thread_id.is_some())
        && (explicit_actor_name.is_none()
            || explicit_thread_title.is_none()
            || explicit_workspace_id.is_none())
    {
        resolve_notification_context(thread_id.as_deref(), profile_id.as_deref(), None)
    } else {
        ResolvedNotificationMeta::default()
    };

    let actor_name = explicit_actor_name.or(resolved.actor_name);
    let thread_title = explicit_thread_title.or(resolved.thread_title);
    let workspace_id = explicit_workspace_id.or(resolved.workspace_id);

    let module = explicit_module.unwrap_or_else(|| match source.as_str() {
        "agentChat" => "agent".to_string(),
        "codeThread" => {
            if profile_id.is_some() {
                "agent".to_string()
            } else {
                "chat".to_string()
            }
        }
        "terminal" | "codeTerminal" => "code".to_string(),
        _ => {
            if profile_id.is_some() {
                "agent".to_string()
            } else {
                "code".to_string()
            }
        }
    });

    let target_id = if matches!(source.as_str(), "agentChat" | "codeThread") {
        thread_id
            .clone()
            .or_else(|| (!session_id.is_empty()).then(|| session_id.clone()))
            .or_else(|| workspace_id.clone())
            .unwrap_or_else(|| "terminal".to_string())
    } else if !session_id.is_empty() {
        session_id
    } else {
        thread_id
            .clone()
            .or_else(|| workspace_id.clone())
            .unwrap_or_else(|| "terminal".to_string())
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
        "target": { "source": source, "id": target_id },
        "profileId": profile_id,
        "routineId": Value::Null,
        "actorName": actor_name,
        "threadTitle": thread_title,
        "workspaceId": workspace_id,
        "module": module,
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
    emit_notifications_updated();
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
    emit_notifications_updated();
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
        emit_notifications_updated();
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

/// Inserts a deduplicated unread alert notification when a model or quota window hits 0%.
/// Returns `None` if an unread record with the same `dedup_key` already exists.
pub fn upsert_model_quota_exhausted_notification(
    dedup_key: &str,
    provider_id: &str,
    display_name: &str,
    window_name: &str,
    resets_at: Option<&str>,
) -> Option<Value> {
    let record_id = format!("quota_{dedup_key}");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let title = format!("Cuota agotada: {window_name}");
    let reset_suffix = resets_at
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|r| format!(" (reinicio: {r})"))
        .unwrap_or_default();
    let body = format!("{display_name} llegó al 0% en «{window_name}»{reset_suffix}. Cambiá de modelo o revisá tus cuotas.");

    {
        let mut items = notifications().lock().unwrap();
        let already_unread = items.iter().any(|item| {
            item.get("id").and_then(|v| v.as_str()) == Some(record_id.as_str())
                && !item.get("isRead").and_then(|v| v.as_bool()).unwrap_or(false)
        });
        if already_unread {
            return None;
        }
        items.retain(|item| item.get("id").and_then(|v| v.as_str()) != Some(record_id.as_str()));
        items.insert(
            0,
            json!({
                "id": record_id,
                "runId": Value::Null,
                "target": { "source": "accountVault", "id": provider_id },
                "profileId": Value::Null,
                "routineId": Value::Null,
                "kind": {
                    "kind": "modelQuotaExhausted",
                    "requestKind": provider_id,
                },
                "title": title,
                "body": body,
                "createdAtUnixMs": now,
                "isRead": false,
                "isWaitingForInput": false,
                "resolution": Value::Null,
            }),
        );
        if items.len() > 100 {
            items.truncate(100);
        }
    }

    let snapshot = make_notifications_snapshot();
    persist();
    emit_notifications_updated();
    Some(snapshot)
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
    emit_notifications_updated();
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
    emit_notifications_updated();
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
    emit_notifications_updated();
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
    if cfg!(windows) {
        current.authorization = "authorized".into();
        current.preferences["schemaVersion"] = json!(2);
        current.preferences["osNotificationsEnabled"] = json!(true);
    } else {
        current.authorization = "denied".into();
    }
    current.persistence_error = save_center(&current);
    drop(current);
    emit_notifications_updated();
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
        "schemaVersion": 2,
        "osNotificationsEnabled": bool_field("osNotificationsEnabled", cfg!(windows)),
        "finishSoundEnabled": bool_field("finishSoundEnabled", true),
        "inputRequestsEnabled": bool_field("inputRequestsEnabled", true)
    });
    current.persistence_error = save_center(&current);
    drop(current);
    emit_notifications_updated();
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

    #[test]
    fn model_quota_exhausted_notifications_are_created_and_deduplicated() {
        let key = format!("test-quota-{}", Uuid::new_v4());
        let expected_id = format!("quota_{}", key);
        struct Cleanup(String);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let mut items = notifications().lock().unwrap();
                items.retain(|n| n.get("id").and_then(|v| v.as_str()) != Some(self.0.as_str()));
            }
        }
        let _cleanup = Cleanup(expected_id.clone());

        let created = upsert_model_quota_exhausted_notification(
            &key,
            "antigravity",
            "Antigravity",
            "Gemini 4 Argon (Gemini 4 Argon Weekly Limit)",
            Some("2026-11-22T05:16:50Z"),
        );
        assert!(created.is_some());

        // Duplicate call with identical dedup key returns None (no spam).
        let duplicate = upsert_model_quota_exhausted_notification(
            &key,
            "antigravity",
            "Antigravity",
            "Gemini 4 Argon (Gemini 4 Argon Weekly Limit)",
            Some("2026-11-22T05:16:50Z"),
        );
        assert!(duplicate.is_none());

        let snap = make_notifications_snapshot();
        let count = snap["records"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|r| r["id"] == expected_id)
            .count();
        assert_eq!(count, 1);
    }

    fn center_test_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    #[test]
    fn test_build_windows_toast_xml_escapes_and_handles_silent_and_empty_body() {
        let xml = build_windows_toast_xml(
            "  Chip\x00 Worker & <Co>\t\"'  ",
            "Build\x07 finished\nLine 2\x1b",
            true,
        );
        assert_eq!(
            xml,
            "<toast><visual><binding template=\"ToastGeneric\"><text>Chip Worker &amp; &lt;Co&gt;\t&quot;&apos;</text><text>Build finished\nLine 2</text></binding></visual><audio silent=\"true\"/></toast>"
        );

        let xml_no_body = build_windows_toast_xml("Title only", "   \x00\x01  ", false);
        assert_eq!(
            xml_no_body,
            "<toast><visual><binding template=\"ToastGeneric\"><text>Title only</text></binding></visual></toast>"
        );

        let tag_a = windows_toast_tag_hash("thread:11111111-2222-3333-4444-555555555555");
        let tag_b = windows_toast_tag_hash("thread:11111111-2222-3333-4444-555555555555");
        assert_eq!(tag_a, tag_b);
        assert!(tag_a.len() <= 16);
        assert!(tag_a.chars().all(|c| c.is_ascii_alphanumeric()));
    }

    #[test]
    fn test_resolve_context_and_settle_turn_notification_carries_actor_and_thread_title() {
        let suffix = Uuid::new_v4().simple().to_string();
        let agent_id = Uuid::new_v4().to_string();
        let thread_id = Uuid::new_v4().to_string();
        let generic_thread_id = Uuid::new_v4().to_string();
        let routine_id = Uuid::new_v4().to_string();
        let workspace_id = format!("ws-{suffix}");
        let run_id = Uuid::new_v4().to_string();
        let routine_run_id = Uuid::new_v4().to_string();

        struct Cleanup {
            agent_id: String,
            thread_ids: Vec<String>,
            routine_id: String,
            run_ids: Vec<String>,
        }
        impl Drop for Cleanup {
            fn drop(&mut self) {
                if let Ok(mut list) = agents().lock() {
                    list.retain(|a| a.id != self.agent_id);
                }
                if let Ok(mut list) = threads().lock() {
                    list.retain(|t| {
                        t.get("id")
                            .and_then(Value::as_str)
                            .is_none_or(|id| !self.thread_ids.iter().any(|x| x == id))
                    });
                }
                if let Ok(mut list) = routines().lock() {
                    list.retain(|r| {
                        r.get("id").and_then(Value::as_str) != Some(self.routine_id.as_str())
                    });
                }
                if let Ok(mut list) = notifications().lock() {
                    list.retain(|n| {
                        let rid = n.get("runId").and_then(Value::as_str);
                        let rtid = n.get("routineId").and_then(Value::as_str);
                        !rid.is_some_and(|id| self.run_ids.iter().any(|x| x == id))
                            && rtid != Some(self.routine_id.as_str())
                    });
                }
            }
        }
        let _cleanup = Cleanup {
            agent_id: agent_id.clone(),
            thread_ids: vec![thread_id.clone(), generic_thread_id.clone()],
            routine_id: routine_id.clone(),
            run_ids: vec![run_id.clone(), routine_run_id.clone()],
        };

        {
            let mut list = agents().lock().unwrap();
            list.push(crate::persist::AgentProfile {
                id: agent_id.clone(),
                name: "Chip Worker".to_string(),
                engine: "claude".to_string(),
                purpose: "Test".to_string(),
                brief: "Test".to_string(),
                avatar: None,
                created_at_unix_ms: 1,
                pinned: false,
                order: 99,
                memory_budget: None,
                reflection_mode: None,
                allow_agent_scheduling: None,
                allow_agent_messaging: None,
                default_mode: None,
                default_plan: None,
                default_model: None,
                default_provider_options: vec![],
                place_display_names: vec![],
                disabled_plugin_ids: vec![],
            });
        }
        {
            let mut list = threads().lock().unwrap();
            list.push(json!({
                "id": thread_id,
                "title": "Build FPGA Controller",
                "profileId": agent_id,
                "workspaceId": workspace_id,
                "items": []
            }));
            list.push(json!({
                "id": generic_thread_id,
                "title": "New thread",
                "profileId": agent_id,
                "workspaceId": workspace_id,
                "items": []
            }));
        }
        {
            let mut list = routines().lock().unwrap();
            list.push(json!({
                "id": routine_id,
                "agentId": agent_id,
                "name": "Nightly Firmware Audit",
                "workspaceId": workspace_id,
            }));
        }

        let meta = resolve_notification_context(Some(&thread_id), None, None);
        assert_eq!(meta.actor_name.as_deref(), Some("Chip Worker"));
        assert_eq!(meta.thread_title.as_deref(), Some("Build FPGA Controller"));
        assert_eq!(meta.workspace_id.as_deref(), Some(workspace_id.as_str()));

        let generic_meta = resolve_notification_context(Some(&generic_thread_id), None, None);
        assert_eq!(generic_meta.actor_name.as_deref(), Some("Chip Worker"));
        assert_eq!(generic_meta.thread_title, None);

        let routine_meta = resolve_notification_context(Some(&generic_thread_id), None, Some(&routine_id));
        assert_eq!(routine_meta.actor_name.as_deref(), Some("Chip Worker"));
        assert_eq!(
            routine_meta.thread_title.as_deref(),
            Some("Nightly Firmware Audit")
        );

        crate::chat::runtime::settle_turn_notification(
            &run_id,
            &thread_id,
            Some(&agent_id),
            true,
            false,
        );
        let snap = make_notifications_snapshot();
        let rec = snap["records"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["runId"] == run_id)
            .expect("settled turn record");
        assert_eq!(rec["actorName"], "Chip Worker");
        assert_eq!(rec["threadTitle"], "Build FPGA Controller");
        assert_eq!(rec["workspaceId"], workspace_id);
        assert_eq!(rec["module"], "agent");
        assert_eq!(rec["target"]["source"], "agentChat");

        crate::chat::runtime::settle_routine(
            &routine_run_id,
            &thread_id,
            &routine_id,
            Some(&agent_id),
            true,
            false,
        );
        crate::routines::dispatch_output_actions(
            &agent_id,
            &routine_id,
            &json!({
                "id": routine_id,
                "name": "Nightly Firmware Audit",
                "workspaceId": workspace_id,
                "outputActions": ["notify_desktop"],
            }),
            Some(&thread_id),
            "All checks passed.",
            false,
            0,
        );
        let snap_after = make_notifications_snapshot();
        let routine_records: Vec<&Value> = snap_after["records"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|r| r["routineId"] == routine_id && r["target"]["id"] == thread_id)
            .collect();
        assert_eq!(
            routine_records.len(),
            1,
            "notify_desktop must deduplicate against settle_routine for the same routineId + target.id"
        );
        assert_eq!(routine_records[0]["actorName"], "Chip Worker");
        assert_eq!(routine_records[0]["threadTitle"], "Nightly Firmware Audit");
        assert_eq!(routine_records[0]["module"], "agent");
    }

    #[test]
    fn test_report_attention_direct_stores_terminal_actor_and_module() {
        let suffix = Uuid::new_v4().simple().to_string();
        let session_id = format!("term-sess-{suffix}");
        let ws_id = format!("ws-term-{suffix}");

        struct Cleanup(String);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                if let Ok(mut list) = notifications().lock() {
                    list.retain(|n| n.pointer("/target/id").and_then(Value::as_str) != Some(&self.0));
                }
            }
        }
        let _cleanup = Cleanup(session_id.clone());

        let snap = notifications_report_attention_direct(Some(json!({
            "payload": {
                "source": "terminal",
                "kind": "settled",
                "title": "Orion · Codex finished",
                "body": "Cargo tests passed.",
                "actorName": "Orion · Codex",
                "sessionId": session_id,
                "workspaceId": ws_id,
            }
        })));
        let rec = snap["records"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["target"]["id"] == session_id)
            .expect("terminal attention notification");
        assert_eq!(rec["target"]["source"], "terminal");
        assert_eq!(rec["actorName"], "Orion · Codex");
        assert_eq!(rec["module"], "code");
        assert_eq!(rec["workspaceId"], ws_id);
        assert_eq!(rec["kind"]["kind"], "settled");
        assert_eq!(rec["kind"]["outcome"], "completed");
    }

    #[test]
    fn test_windows_v1_to_v2_migration_and_explicit_opt_out_preservation() {
        let legacy_denied = center_from_stored(&json!({
            "authorization": "denied",
            "preferences": {
                "schemaVersion": 1,
                "osNotificationsEnabled": false,
                "finishSoundEnabled": false,
                "inputRequestsEnabled": true
            }
        }));
        if cfg!(windows) {
            assert_eq!(legacy_denied.authorization, "authorized");
            assert_eq!(legacy_denied.preferences["osNotificationsEnabled"], true);
        } else {
            assert_eq!(legacy_denied.authorization, "denied");
            assert_eq!(legacy_denied.preferences["osNotificationsEnabled"], false);
        }
        assert_eq!(legacy_denied.preferences["schemaVersion"], 2);
        assert_eq!(legacy_denied.preferences["finishSoundEnabled"], false);
        assert_eq!(legacy_denied.preferences["inputRequestsEnabled"], true);

        let legacy_missing_prefs = center_from_stored(&json!({
            "authorization": "notDetermined"
        }));
        if cfg!(windows) {
            assert_eq!(legacy_missing_prefs.authorization, "authorized");
            assert_eq!(
                legacy_missing_prefs.preferences["osNotificationsEnabled"],
                true
            );
        } else {
            assert_eq!(legacy_missing_prefs.authorization, "notDetermined");
        }
        assert_eq!(legacy_missing_prefs.preferences["schemaVersion"], 2);

        let explicit_v2_opt_out = center_from_stored(&json!({
            "authorization": "authorized",
            "preferences": {
                "schemaVersion": 2,
                "osNotificationsEnabled": false,
                "finishSoundEnabled": false,
                "inputRequestsEnabled": false
            }
        }));
        assert_eq!(explicit_v2_opt_out.authorization, "authorized");
        assert_eq!(explicit_v2_opt_out.preferences["schemaVersion"], 2);
        assert_eq!(
            explicit_v2_opt_out.preferences["osNotificationsEnabled"],
            false
        );
        assert_eq!(explicit_v2_opt_out.preferences["finishSoundEnabled"], false);
        assert_eq!(
            explicit_v2_opt_out.preferences["inputRequestsEnabled"],
            false
        );
    }

    #[test]
    fn test_notifications_send_os_direct_respects_enabled_flag_and_force_test() {
        let _guard = center_test_lock().lock().unwrap();
        let (prev_auth, prev_prefs) = {
            let current = center().lock().unwrap();
            (current.authorization.clone(), current.preferences.clone())
        };
        struct RestoreCenter(String, Value);
        impl Drop for RestoreCenter {
            fn drop(&mut self) {
                let mut current = center().lock().unwrap();
                current.authorization = self.0.clone();
                current.preferences = self.1.clone();
                let _ = save_center(&current);
            }
        }
        let _restore = RestoreCenter(prev_auth, prev_prefs);

        notifications_set_preferences_direct(Some(json!({
            "osNotificationsEnabled": false
        })));
        let skipped = notifications_send_os_direct(Some(json!({
            "title": "Chip Worker",
            "body": "Finished turn"
        })));
        assert_eq!(skipped["ok"], false);
        assert_eq!(skipped["skipped"], true);
        assert_eq!(skipped["reason"], "os_notifications_disabled");

        let forced = notifications_send_os_direct(Some(json!({
            "title": "Chip Worker",
            "body": "Preview toast",
            "forceTest": true,
            "silent": true
        })));
        assert_eq!(forced["ok"], true);

        notifications_set_preferences_direct(Some(json!({
            "osNotificationsEnabled": true
        })));
        let invalid = notifications_send_os_direct(Some(json!({
            "title": "   ",
            "body": ""
        })));
        assert_eq!(invalid["ok"], false);
        assert!(invalid["error"].as_str().is_some_and(|s| !s.is_empty()));

        let ok = notifications_send_os_direct(Some(json!({
            "title": "Chip Worker",
            "body": "Done",
            "tag": "thread:123"
        })));
        assert_eq!(ok["ok"], true);
    }
}
