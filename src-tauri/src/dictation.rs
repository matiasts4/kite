use crate::persist::{body, db_connection};
use rusqlite::params;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use uuid::Uuid;

const NIL_REQUEST: &str = "00000000-0000-4000-8000-000000000000";
const DICTATION_MESSAGE: &str = "Dictation is unavailable. Check Voice settings and try again.";
const VOICE_MESSAGE: &str = "Voice creation is unavailable. No local engine is installed.";

fn request_body(request: &Option<Value>) -> Option<&Value> {
    body(request)
}

fn request_id(request: &Option<Value>) -> String {
    request_body(request)
        .and_then(|value| value.get("requestId"))
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .unwrap_or(NIL_REQUEST)
        .to_string()
}

fn app_state_get(key: &str) -> Option<String> {
    db_connection()
        .lock()
        .unwrap()
        .query_row(
            "SELECT value FROM app_state WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .ok()
}

fn app_state_set(key: &str, value: &str) {
    let _ = db_connection().lock().unwrap().execute(
        "INSERT INTO app_state (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    );
}

fn default_settings() -> Value {
    json!({
        "schemaVersion": 1,
        "mode": "local",
        "localEngine": Value::Null,
        "language": "auto",
        "deviceId": Value::Null,
        "cuesEnabled": true,
        "shortcut": { "kind": "standard" }
    })
}

fn known_language(value: &str) -> bool {
    matches!(
        value,
        "auto" | "en" | "es" | "fr" | "de" | "it" | "pt" | "nl" | "pl" | "ru" | "tr" | "sv"
            | "no" | "da" | "fi" | "cs" | "el" | "he" | "ar" | "hi" | "id" | "ja" | "ko"
            | "zh" | "zh-Hant" | "th" | "vi" | "uk" | "ro" | "hu" | "ca"
    )
}

fn normalize_settings(incoming: &Value, previous: &Value) -> Value {
    let mode = incoming
        .get("mode")
        .and_then(|value| value.as_str())
        .filter(|value| *value == "local" || *value == "cloud")
        .unwrap_or_else(|| previous.get("mode").and_then(|value| value.as_str()).unwrap_or("local"));
    let local_engine = match incoming.get("localEngine") {
        Some(Value::String(value)) if value == "whisper" || value == "parakeet" => json!(value),
        Some(Value::Null) => Value::Null,
        Some(_) => Value::Null,
        None => previous.get("localEngine").cloned().unwrap_or(Value::Null),
    };
    let language = incoming
        .get("language")
        .and_then(|value| value.as_str())
        .filter(|value| known_language(value))
        .unwrap_or_else(|| previous.get("language").and_then(|value| value.as_str()).unwrap_or("auto"));
    let device_id = match incoming.get("deviceId") {
        Some(Value::String(value)) if !value.is_empty() && value != "automatic" => json!(value),
        Some(Value::Null) => Value::Null,
        Some(_) => Value::Null,
        None => previous.get("deviceId").cloned().unwrap_or(Value::Null),
    };
    let cues_enabled = incoming
        .get("cuesEnabled")
        .and_then(|value| value.as_bool())
        .or_else(|| previous.get("cuesEnabled").and_then(|value| value.as_bool()))
        .unwrap_or(true);
    let shortcut = incoming
        .get("shortcut")
        .filter(|value| value.is_object())
        .cloned()
        .or_else(|| previous.get("shortcut").cloned())
        .unwrap_or_else(|| json!({ "kind": "standard" }));
    json!({
        "schemaVersion": 1,
        "mode": mode,
        "localEngine": local_engine,
        "language": language,
        "deviceId": device_id,
        "cuesEnabled": cues_enabled,
        "shortcut": shortcut
    })
}

fn settings_slot() -> &'static Mutex<Value> {
    static CELL: OnceLock<Mutex<Value>> = OnceLock::new();
    CELL.get_or_init(|| {
        let stored = app_state_get("dictationSettings")
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .map(|value| normalize_settings(&value, &default_settings()))
            .unwrap_or_else(default_settings);
        Mutex::new(stored)
    })
}

fn dictation_takes() -> &'static Mutex<HashMap<String, Value>> {
    static CELL: OnceLock<Mutex<HashMap<String, Value>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(HashMap::new()))
}

fn voice_takes() -> &'static Mutex<HashMap<String, Value>> {
    static CELL: OnceLock<Mutex<HashMap<String, Value>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(HashMap::new()))
}

struct VoicePreview {
    id: String,
    include_history: bool,
}

fn voice_preview() -> &'static Mutex<Option<VoicePreview>> {
    static CELL: OnceLock<Mutex<Option<VoicePreview>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(None))
}

fn unavailable_dictation() -> Value {
    json!({
        "schemaVersion": 1,
        "state": "unavailable",
        "canRequestPermission": false,
        "canStart": false,
        "guidance": "No installed local transcription engine is ready.",
        "localEngines": [
            {
                "id": "whisper",
                "label": "Whisper",
                "available": false,
                "detail": "No local Whisper engine is installed."
            },
            {
                "id": "parakeet",
                "label": "Parakeet",
                "available": false,
                "detail": "No local Parakeet engine is installed."
            }
        ]
    })
}

fn unavailable_voice_input() -> Value {
    json!({
        "schemaVersion": 1,
        "state": "unavailable",
        "canRequestPermission": false,
        "canStart": false,
        "guidance": "No local voice engine is installed."
    })
}

fn dictation_error(request_id: &str) -> Value {
    json!({
        "schemaVersion": 1,
        "requestId": request_id,
        "phase": "error",
        "level": 0.0,
        "durationMs": 0,
        "transcript": "",
        "error": {
            "code": "engineUnavailable",
            "message": DICTATION_MESSAGE
        }
    })
}

fn voice_error(request_id: &str) -> Value {
    json!({
        "schemaVersion": 1,
        "requestId": request_id,
        "phase": "error",
        "level": 0.0,
        "transcript": "",
        "error": {
            "code": "engineUnavailable",
            "message": VOICE_MESSAGE
        },
        "draft": Value::Null
    })
}

fn current_settings() -> Value {
    settings_slot().lock().unwrap().clone()
}

#[tauri::command]
pub fn read_dictation_availability(_request: Option<Value>) -> Value {
    unavailable_dictation()
}

#[tauri::command]
pub fn read_dictation_settings(_request: Option<Value>) -> Value {
    current_settings()
}

#[tauri::command]
pub fn update_dictation_settings(request: Option<Value>) -> Value {
    let incoming = request_body(&request)
        .and_then(|value| value.get("settings"))
        .cloned()
        .or_else(|| request_body(&request).cloned())
        .unwrap_or_else(default_settings);
    let mut slot = settings_slot().lock().unwrap();
    let next = normalize_settings(&incoming, &slot);
    *slot = next.clone();
    drop(slot);
    app_state_set("dictationSettings", &next.to_string());
    next
}

#[tauri::command]
pub fn list_dictation_input_devices(_request: Option<Value>) -> Value {
    json!({
        "schemaVersion": 1,
        "devices": [],
        "selectedId": current_settings().get("deviceId").cloned().unwrap_or(Value::Null)
    })
}

#[tauri::command]
pub fn select_dictation_whisper_model(_request: Option<Value>) -> Value {
    unavailable_dictation()
}

#[tauri::command]
pub fn request_dictation_permission(_request: Option<Value>) -> Value {
    unavailable_dictation()
}

#[tauri::command]
pub fn start_dictation(request: Option<Value>) -> Value {
    let id = request_id(&request);
    let result = dictation_error(&id);
    dictation_takes().lock().unwrap().insert(id, result.clone());
    result
}

#[tauri::command]
pub fn read_dictation(request: Option<Value>) -> Value {
    let id = request_id(&request);
    dictation_takes()
        .lock()
        .unwrap()
        .get(&id)
        .cloned()
        .unwrap_or_else(|| dictation_error(&id))
}

#[tauri::command]
pub fn stop_dictation(request: Option<Value>) -> Value {
    let id = request_id(&request);
    dictation_takes().lock().unwrap().remove(&id);
    Value::Null
}

#[tauri::command]
pub fn cancel_dictation(request: Option<Value>) -> Value {
    let id = request_id(&request);
    dictation_takes().lock().unwrap().remove(&id);
    Value::Null
}

#[tauri::command]
pub fn read_agent_voice_input_availability(_request: Option<Value>) -> Value {
    unavailable_voice_input()
}

#[tauri::command]
pub fn request_agent_voice_input_permission(_request: Option<Value>) -> Value {
    unavailable_voice_input()
}

#[tauri::command]
pub fn read_agent_voice_create(request: Option<Value>) -> Value {
    let id = request_id(&request);
    voice_takes()
        .lock()
        .unwrap()
        .get(&id)
        .cloned()
        .unwrap_or_else(|| voice_error(&id))
}

#[tauri::command]
pub fn start_agent_voice_create(request: Option<Value>) -> Value {
    let id = request_id(&request);
    let result = voice_error(&id);
    voice_takes().lock().unwrap().insert(id, result.clone());
    result
}

#[tauri::command]
pub fn stop_agent_voice_create(request: Option<Value>) -> Value {
    let id = request_id(&request);
    voice_takes().lock().unwrap().remove(&id);
    Value::Null
}

#[tauri::command]
pub fn cancel_agent_voice_create(request: Option<Value>) -> Value {
    let id = request_id(&request);
    voice_takes().lock().unwrap().remove(&id);
    Value::Null
}

#[tauri::command]
pub fn preview_voice_import(request: Option<Value>) -> Value {
    let include_history = request_body(&request)
        .and_then(|value| value.get("includeHistory"))
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let id = Uuid::new_v4().to_string();
    *voice_preview().lock().unwrap() = Some(VoicePreview {
        id: id.clone(),
        include_history,
    });
    let history_count = if include_history { json!(0) } else { Value::Null };
    json!({
        "schemaVersion": 1,
        "previewId": id,
        "sourceFound": false,
        "hasPreferences": false,
        "vocabularyCount": 0,
        "historyCount": history_count,
        "skippedCount": 0,
        "hasImportableData": false
    })
}

#[tauri::command]
pub fn apply_voice_import(request: Option<Value>) -> Value {
    let preview_id = request_body(&request)
        .and_then(|value| value.get("previewId"))
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let include_history = voice_preview()
        .lock()
        .unwrap()
        .as_ref()
        .filter(|preview| preview.id == preview_id)
        .map(|preview| preview.include_history)
        .unwrap_or(false);
    json!({
        "schemaVersion": 1,
        "didWrite": false,
        "vocabularyAdded": 0,
        "vocabularyUpdated": 0,
        "historyAdded": 0,
        "historyUpdated": 0,
        "historyIncluded": include_history
    })
}

#[tauri::command]
pub fn voice_assistant_prompt(request: Option<Value>) -> Value {
    let prompt = request_body(&request)
        .and_then(|value| value.get("prompt"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("Voice is unavailable.");
    json!({
        "prompt": prompt,
        "notes": "Live voice is unavailable. No local engine is installed."
    })
}

#[tauri::command]
pub fn voice_context_read(_request: Option<Value>) -> Value {
    json!({
        "root_version": "0000000000000000000000000000000000000000000000000000000000000000",
        "files": []
    })
}

fn live_unavailable() -> Value {
    json!({
        "status": "unavailable",
        "reason": "no engine",
        "detail": "Live voice is unavailable. No local engine is installed."
    })
}

#[tauri::command]
pub fn voice_live_close(_request: Option<Value>) -> Value {
    live_unavailable()
}

#[tauri::command]
pub fn voice_live_connect(_request: Option<Value>) -> Value {
    live_unavailable()
}

#[tauri::command]
pub fn voice_live_send(_request: Option<Value>) -> Value {
    live_unavailable()
}

#[tauri::command]
pub fn voice_live_session(_request: Option<Value>) -> Value {
    live_unavailable()
}

#[tauri::command]
pub fn voice_resolve_work(request: Option<Value>) -> Value {
    let body = request_body(&request);
    let operation_id = body
        .and_then(|value| value.get("operation_id"))
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("unavailable");
    let snapshot_id = body
        .and_then(|value| value.get("snapshot_id"))
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("unavailable");
    json!({
        "schema_version": 1,
        "operation_id": operation_id,
        "snapshot_id": snapshot_id,
        "status": "unavailable",
        "candidate_id": Value::Null,
        "confidence": Value::Null,
        "model": Value::Null,
        "alternatives": []
    })
}
