use crate::persist::{app_state_get, app_state_set, body};
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

pub fn read_dictation_availability_direct(_request: Option<Value>) -> Value {
    unavailable_dictation()
}

#[tauri::command]
pub async fn read_dictation_availability(request: Option<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || read_dictation_availability_direct(request))
        .await
        .unwrap_or_else(|_| unavailable_dictation())
}

pub fn read_dictation_settings_direct(_request: Option<Value>) -> Value {
    current_settings()
}

#[tauri::command]
pub async fn read_dictation_settings(request: Option<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || read_dictation_settings_direct(request))
        .await
        .unwrap_or_else(|_| default_settings())
}

pub fn update_dictation_settings_direct(request: Option<Value>) -> Value {
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
pub async fn update_dictation_settings(request: Option<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || update_dictation_settings_direct(request))
        .await
        .unwrap_or_else(|_| default_settings())
}

pub fn list_dictation_input_devices_direct(_request: Option<Value>) -> Value {
    let devices: Vec<Value> = crate::voice_audio::capture::list_input_devices()
        .into_iter()
        .map(|d| {
            json!({
                "id": d.id,
                "label": d.name,
                "isDefault": d.is_default,
                "sampleRate": d.sample_rate,
                "channels": d.channels
            })
        })
        .collect();
    json!({
        "schemaVersion": 1,
        "devices": devices,
        "selectedId": current_settings().get("deviceId").cloned().unwrap_or(Value::Null)
    })
}

#[tauri::command]
pub async fn list_dictation_input_devices(request: Option<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || list_dictation_input_devices_direct(request))
        .await
        .unwrap_or_else(|_| json!({ "schemaVersion": 1, "devices": [], "selectedId": Value::Null }))
}

pub fn select_dictation_whisper_model_direct(_request: Option<Value>) -> Value {
    unavailable_dictation()
}

#[tauri::command]
pub async fn select_dictation_whisper_model(request: Option<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || select_dictation_whisper_model_direct(request))
        .await
        .unwrap_or_else(|_| unavailable_dictation())
}

pub fn request_dictation_permission_direct(_request: Option<Value>) -> Value {
    unavailable_dictation()
}

#[tauri::command]
pub async fn request_dictation_permission(request: Option<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || request_dictation_permission_direct(request))
        .await
        .unwrap_or_else(|_| unavailable_dictation())
}

pub fn start_dictation_direct(request: Option<Value>) -> Value {
    let id = request_id(&request);
    let settings = current_settings();
    let device_id = settings
        .get("deviceId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let result = match crate::voice_audio::capture::start_capture(device_id, 16000) {
        Ok(_) => json!({
            "schemaVersion": 1,
            "requestId": id,
            "phase": "listening",
            "level": 0.0,
            "durationMs": 0,
            "transcript": "",
            "error": Value::Null
        }),
        Err(err) => json!({
            "schemaVersion": 1,
            "requestId": id,
            "phase": "error",
            "level": 0.0,
            "durationMs": 0,
            "transcript": "",
            "error": {
                "code": "captureFailed",
                "message": err
            }
        }),
    };
    dictation_takes().lock().unwrap().insert(id, result.clone());
    result
}

#[tauri::command]
pub async fn start_dictation(request: Option<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || start_dictation_direct(request))
        .await
        .unwrap_or_else(|_| dictation_error("unavailable"))
}

pub fn read_dictation_direct(request: Option<Value>) -> Value {
    let id = request_id(&request);
    let status = crate::voice_audio::capture::get_capture_status();
    let mut takes = dictation_takes().lock().unwrap();
    if let Some(entry) = takes.get_mut(&id) {
        if entry.get("phase").and_then(|v| v.as_str()) == Some("listening") && status.active {
            entry["level"] = json!(status.level);
        }
        return entry.clone();
    }
    dictation_error(&id)
}

#[tauri::command]
pub async fn read_dictation(request: Option<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || read_dictation_direct(request))
        .await
        .unwrap_or_else(|_| dictation_error("unavailable"))
}

pub fn stop_dictation_direct(request: Option<Value>) -> Value {
    let id = request_id(&request);
    let wav = crate::voice_audio::capture::stop_capture_and_export_wav();
    let settings = current_settings();
    let language = settings
        .get("language")
        .and_then(|v| v.as_str())
        .unwrap_or("auto")
        .to_string();

    let mut transcript = String::new();
    let mut err_obj = Value::Null;

    if let Some(wav_bytes) = wav {
        let grok_key = crate::credentials::get_vault_credential("grok_transcription")
            .or_else(|| crate::credentials::get_vault_credential("grok"));
        if let Some(api_key) = grok_key.filter(|k| !k.trim().is_empty()) {
            let res = tauri::async_runtime::block_on(
                crate::voice_audio::stt_ws::transcribe_wav_http_fallback(
                    wav_bytes,
                    &api_key,
                    "https://api.x.ai/v1",
                    "grok-voice-transcribe-2.0",
                    &language,
                ),
            );
            match res {
                Ok(text) => transcript = text,
                Err(err) => err_obj = json!({ "code": "sttFailed", "message": err }),
            }
        }
    }

    let result = json!({
        "schemaVersion": 1,
        "requestId": id,
        "phase": if err_obj.is_null() { "done" } else { "error" },
        "level": 0.0,
        "durationMs": 0,
        "transcript": transcript,
        "error": err_obj
    });
    dictation_takes().lock().unwrap().insert(id, result.clone());
    result
}

#[tauri::command]
pub async fn stop_dictation(request: Option<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || stop_dictation_direct(request))
        .await
        .unwrap_or(Value::Null)
}

pub fn cancel_dictation_direct(request: Option<Value>) -> Value {
    let id = request_id(&request);
    crate::voice_audio::capture::stop_capture();
    dictation_takes().lock().unwrap().remove(&id);
    Value::Null
}

#[tauri::command]
pub async fn cancel_dictation(request: Option<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || cancel_dictation_direct(request))
        .await
        .unwrap_or(Value::Null)
}

pub fn read_agent_voice_input_availability_direct(_request: Option<Value>) -> Value {
    unavailable_voice_input()
}

#[tauri::command]
pub async fn read_agent_voice_input_availability(request: Option<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || {
        read_agent_voice_input_availability_direct(request)
    })
    .await
    .unwrap_or_else(|_| unavailable_voice_input())
}

pub fn request_agent_voice_input_permission_direct(_request: Option<Value>) -> Value {
    unavailable_voice_input()
}

#[tauri::command]
pub async fn request_agent_voice_input_permission(request: Option<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || {
        request_agent_voice_input_permission_direct(request)
    })
    .await
    .unwrap_or_else(|_| unavailable_voice_input())
}

pub fn read_agent_voice_create_direct(request: Option<Value>) -> Value {
    let id = request_id(&request);
    voice_takes()
        .lock()
        .unwrap()
        .get(&id)
        .cloned()
        .unwrap_or_else(|| voice_error(&id))
}

#[tauri::command]
pub async fn read_agent_voice_create(request: Option<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || read_agent_voice_create_direct(request))
        .await
        .unwrap_or_else(|_| voice_error("unavailable"))
}

pub fn start_agent_voice_create_direct(request: Option<Value>) -> Value {
    let id = request_id(&request);
    let result = voice_error(&id);
    voice_takes().lock().unwrap().insert(id, result.clone());
    result
}

#[tauri::command]
pub async fn start_agent_voice_create(request: Option<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || start_agent_voice_create_direct(request))
        .await
        .unwrap_or_else(|_| voice_error("unavailable"))
}

pub fn stop_agent_voice_create_direct(request: Option<Value>) -> Value {
    let id = request_id(&request);
    voice_takes().lock().unwrap().remove(&id);
    Value::Null
}

#[tauri::command]
pub async fn stop_agent_voice_create(request: Option<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || stop_agent_voice_create_direct(request))
        .await
        .unwrap_or(Value::Null)
}

pub fn cancel_agent_voice_create_direct(request: Option<Value>) -> Value {
    let id = request_id(&request);
    voice_takes().lock().unwrap().remove(&id);
    Value::Null
}

#[tauri::command]
pub async fn cancel_agent_voice_create(request: Option<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || cancel_agent_voice_create_direct(request))
        .await
        .unwrap_or(Value::Null)
}

pub fn preview_voice_import_direct(request: Option<Value>) -> Value {
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
pub async fn preview_voice_import(request: Option<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || preview_voice_import_direct(request))
        .await
        .unwrap_or_else(|_| json!({ "schemaVersion": 1, "sourceFound": false, "hasImportableData": false }))
}

pub fn apply_voice_import_direct(request: Option<Value>) -> Value {
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
pub async fn apply_voice_import(request: Option<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || apply_voice_import_direct(request))
        .await
        .unwrap_or_else(|_| json!({ "schemaVersion": 1, "didWrite": false }))
}

pub fn voice_assistant_prompt_direct(request: Option<Value>) -> Value {
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
pub async fn voice_assistant_prompt(request: Option<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || voice_assistant_prompt_direct(request))
        .await
        .unwrap_or_else(|_| json!({ "prompt": "Voice is unavailable.", "notes": "Live voice is unavailable. No local engine is installed." }))
}

pub fn voice_context_read_direct(_request: Option<Value>) -> Value {
    json!({
        "root_version": "0000000000000000000000000000000000000000000000000000000000000000",
        "files": []
    })
}

#[tauri::command]
pub async fn voice_context_read(request: Option<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || voice_context_read_direct(request))
        .await
        .unwrap_or_else(|_| json!({ "root_version": "0000000000000000000000000000000000000000000000000000000000000000", "files": [] }))
}

fn live_unavailable() -> Value {
    json!({
        "status": "unavailable",
        "reason": "no engine",
        "detail": "Live voice is unavailable. No local engine is installed."
    })
}

pub fn voice_live_close_direct(_request: Option<Value>) -> Value {
    live_unavailable()
}

#[tauri::command]
pub async fn voice_live_close(request: Option<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || voice_live_close_direct(request))
        .await
        .unwrap_or_else(|_| live_unavailable())
}

pub fn voice_live_connect_direct(_request: Option<Value>) -> Value {
    live_unavailable()
}

#[tauri::command]
pub async fn voice_live_connect(request: Option<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || voice_live_connect_direct(request))
        .await
        .unwrap_or_else(|_| live_unavailable())
}

pub fn voice_live_send_direct(_request: Option<Value>) -> Value {
    live_unavailable()
}

#[tauri::command]
pub async fn voice_live_send(request: Option<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || voice_live_send_direct(request))
        .await
        .unwrap_or_else(|_| live_unavailable())
}

pub fn voice_live_session_direct(_request: Option<Value>) -> Value {
    live_unavailable()
}

#[tauri::command]
pub async fn voice_live_session(request: Option<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || voice_live_session_direct(request))
        .await
        .unwrap_or_else(|_| live_unavailable())
}

pub fn voice_resolve_work_direct(request: Option<Value>) -> Value {
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

#[tauri::command]
pub async fn voice_resolve_work(request: Option<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || voice_resolve_work_direct(request))
        .await
        .unwrap_or_else(|_| {
            json!({
                "schema_version": 1,
                "operation_id": "unavailable",
                "snapshot_id": "unavailable",
                "status": "unavailable",
                "candidate_id": Value::Null,
                "confidence": Value::Null,
                "model": Value::Null,
                "alternatives": []
            })
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_async_dictation_command_wrapper() {
        let resolved = tauri::async_runtime::block_on(voice_resolve_work(Some(json!({
            "operation_id": "op-1",
            "snapshot_id": "snap-1"
        }))));
        assert_eq!(resolved["operation_id"], "op-1");
        assert_eq!(resolved["snapshot_id"], "snap-1");
    }
}
