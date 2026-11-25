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
        "whisperModelPath": Value::Null,
        "parakeetModelPath": Value::Null,
        "offlineSttEngine": "auto",
        "language": "auto",
        "deviceId": Value::Null,
        "outputDeviceId": Value::Null,
        "voiceTransportMode": "cascaded",
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
    let output_device_id = match incoming.get("outputDeviceId") {
        Some(Value::String(value)) if !value.is_empty() && value != "automatic" => json!(value),
        Some(Value::Null) => Value::Null,
        Some(_) => Value::Null,
        None => previous.get("outputDeviceId").cloned().unwrap_or(Value::Null),
    };
    let whisper_model_path = match incoming.get("whisperModelPath") {
        Some(Value::String(value)) if !value.trim().is_empty() => json!(value.trim()),
        Some(Value::Null) => Value::Null,
        Some(_) => Value::Null,
        None => previous.get("whisperModelPath").cloned().unwrap_or(Value::Null),
    };
    let parakeet_model_path = match incoming.get("parakeetModelPath") {
        Some(Value::String(value)) if !value.trim().is_empty() => json!(value.trim()),
        Some(Value::Null) => Value::Null,
        Some(_) => Value::Null,
        None => previous.get("parakeetModelPath").cloned().unwrap_or(Value::Null),
    };
    let offline_stt_engine = incoming
        .get("offlineSttEngine")
        .and_then(|value| value.as_str())
        .filter(|value| matches!(*value, "auto" | "whisper" | "parakeet" | "disabled"))
        .unwrap_or_else(|| {
            previous
                .get("offlineSttEngine")
                .and_then(|value| value.as_str())
                .unwrap_or("auto")
        });
    let voice_transport_mode = incoming
        .get("voiceTransportMode")
        .and_then(|value| value.as_str())
        .filter(|value| *value == "cascaded" || *value == "realtime")
        .unwrap_or_else(|| {
            previous
                .get("voiceTransportMode")
                .and_then(|value| value.as_str())
                .unwrap_or("cascaded")
        });
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
        "whisperModelPath": whisper_model_path,
        "parakeetModelPath": parakeet_model_path,
        "offlineSttEngine": offline_stt_engine,
        "language": language,
        "deviceId": device_id,
        "outputDeviceId": output_device_id,
        "voiceTransportMode": voice_transport_mode,
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

fn probe_dictation_availability_value() -> Value {
    let settings = current_settings();
    let whisper_override = settings.get("whisperModelPath").and_then(|v| v.as_str());
    let parakeet_override = settings.get("parakeetModelPath").and_then(|v| v.as_str());
    let local_engines =
        crate::voice_audio::offline_stt::probe_local_engines(whisper_override, parakeet_override);
    let any_local = local_engines.iter().any(|e| e.available);
    let has_cloud = crate::credentials::get_vault_credential("grok_transcription")
        .or_else(|| crate::credentials::get_vault_credential("grok"))
        .map(|k| !k.trim().is_empty())
        .unwrap_or(false)
        || crate::credentials::get_vault_credential("cloudflare")
            .map(|k| !k.trim().is_empty())
            .unwrap_or(false);

    let privacy = crate::audio_ducking::probe_microphone_privacy_status();
    let devices = crate::voice_audio::capture::list_input_devices();
    let has_mic = !devices.is_empty() && privacy.available;
    let can_start = has_mic && (any_local || has_cloud);

    let state = if privacy.access_denied {
        "permissionRequired"
    } else if !privacy.available || devices.is_empty() {
        "unavailable"
    } else if any_local || has_cloud {
        "ready"
    } else {
        "needsSetup"
    };

    let guidance = if privacy.access_denied {
        privacy.message_es.clone()
    } else if devices.is_empty() {
        "No se detectó ningún micrófono conectado en Windows.".to_string()
    } else if any_local {
        "Motor local offline y captura nativa WASAPI listos.".to_string()
    } else if has_cloud {
        "Captura nativa WASAPI lista con transcripción Cloud.".to_string()
    } else {
        "Configura una API Key de transcripción o selecciona un modelo local Whisper/Parakeet."
            .to_string()
    };

    json!({
        "schemaVersion": 1,
        "state": state,
        "canRequestPermission": privacy.access_denied || !privacy.available,
        "canStart": can_start,
        "hasCloudStt": has_cloud,
        "hasLocalStt": any_local,
        "guidance": guidance,
        "localEngines": local_engines
    })
}

pub fn read_dictation_availability_direct(_request: Option<Value>) -> Value {
    probe_dictation_availability_value()
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

pub fn select_dictation_whisper_model_direct(request: Option<Value>) -> Value {
    let model_path = request_body(&request)
        .and_then(|v| v.get("modelPath").or_else(|| v.get("path")))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    let mut patch = json!({
        "whisperModelPath": model_path
    });
    if model_path.is_some() {
        patch["localEngine"] = json!("whisper");
    }
    let _ = update_dictation_settings_direct(Some(json!({ "settings": patch })));
    probe_dictation_availability_value()
}

#[tauri::command]
pub async fn select_dictation_whisper_model(request: Option<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || select_dictation_whisper_model_direct(request))
        .await
        .unwrap_or_else(|_| unavailable_dictation())
}

pub fn request_dictation_permission_direct(_request: Option<Value>) -> Value {
    probe_dictation_availability_value()
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
        let offline_pref = settings.get("offlineSttEngine").and_then(|v| v.as_str());
        let whisper_path = settings.get("whisperModelPath").and_then(|v| v.as_str());
        let parakeet_path = settings.get("parakeetModelPath").and_then(|v| v.as_str());
        let prefer_local = settings.get("mode").and_then(|v| v.as_str()) == Some("local");

        if prefer_local && offline_pref != Some("disabled") {
            match crate::voice_audio::offline_stt::transcribe_wav_offline(
                &wav_bytes,
                offline_pref,
                whisper_path,
                parakeet_path,
                &language,
            ) {
                Ok(text) if !text.is_empty() => transcript = text,
                Ok(_) => {}
                Err(err) => err_obj = json!({ "code": "offlineSttUnavailable", "message": err }),
            }
        }

        if transcript.is_empty() {
            let grok_key = crate::credentials::get_vault_credential("grok_transcription")
                .or_else(|| crate::credentials::get_vault_credential("grok"));
            if let Some(api_key) = grok_key.filter(|k| !k.trim().is_empty()) {
                err_obj = Value::Null;
                let res = tauri::async_runtime::block_on(
                    crate::voice_audio::stt_ws::transcribe_wav_http_fallback(
                        wav_bytes.clone(),
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

        if transcript.is_empty() && !prefer_local && offline_pref != Some("disabled") {
            if let Ok(text) = crate::voice_audio::offline_stt::transcribe_wav_offline(
                &wav_bytes,
                offline_pref,
                whisper_path,
                parakeet_path,
                &language,
            ) {
                if !text.is_empty() {
                    transcript = text;
                    err_obj = Value::Null;
                }
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
    let avail = probe_dictation_availability_value();
    json!({
        "schemaVersion": 1,
        "state": avail["state"],
        "canRequestPermission": avail["canRequestPermission"],
        "canStart": avail["canStart"],
        "guidance": avail["guidance"]
    })
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
    read_agent_voice_input_availability_direct(None)
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
    let status = crate::voice_audio::capture::get_capture_status();
    let mut takes = voice_takes().lock().unwrap();
    if let Some(entry) = takes.get_mut(&id) {
        if entry.get("phase").and_then(|v| v.as_str()) == Some("listening") && status.active {
            entry["level"] = json!(status.level);
        }
        return entry.clone();
    }
    voice_error(&id)
}

#[tauri::command]
pub async fn read_agent_voice_create(request: Option<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || read_agent_voice_create_direct(request))
        .await
        .unwrap_or_else(|_| voice_error("unavailable"))
}

pub fn start_agent_voice_create_direct(request: Option<Value>) -> Value {
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
            "transcript": "",
            "error": Value::Null,
            "draft": Value::Null
        }),
        Err(err) => json!({
            "schemaVersion": 1,
            "requestId": id,
            "phase": "error",
            "level": 0.0,
            "transcript": "",
            "error": { "code": "captureFailed", "message": err },
            "draft": Value::Null
        }),
    };
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
    let stop_val = stop_dictation_direct(Some(json!({ "requestId": id })));
    let transcript = stop_val
        .get("transcript")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let result = json!({
        "schemaVersion": 1,
        "requestId": id,
        "phase": stop_val["phase"],
        "level": 0.0,
        "transcript": transcript,
        "error": stop_val["error"],
        "draft": if transcript.is_empty() { Value::Null } else { json!({ "brief": transcript }) }
    });
    voice_takes().lock().unwrap().insert(id, result.clone());
    result
}

#[tauri::command]
pub async fn stop_agent_voice_create(request: Option<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || stop_agent_voice_create_direct(request))
        .await
        .unwrap_or(Value::Null)
}

pub fn cancel_agent_voice_create_direct(request: Option<Value>) -> Value {
    let id = request_id(&request);
    crate::voice_audio::capture::stop_capture();
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
    crate::voice_realtime::disconnect_realtime();
    json!({
        "status": "closed",
        "connected": false
    })
}

#[tauri::command]
pub async fn voice_live_close(request: Option<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || voice_live_close_direct(request))
        .await
        .unwrap_or_else(|_| live_unavailable())
}

pub fn voice_live_connect_direct(_request: Option<Value>) -> Value {
    let status = crate::voice_realtime::get_realtime_status();
    json!({
        "status": if status.connected { "connected" } else { "ready" },
        "connected": status.connected,
        "sampleRate": status.sample_rate
    })
}

#[tauri::command]
pub async fn voice_live_connect(request: Option<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || voice_live_connect_direct(request))
        .await
        .unwrap_or_else(|_| live_unavailable())
}

pub fn voice_live_send_direct(_request: Option<Value>) -> Value {
    let status = crate::voice_realtime::get_realtime_status();
    json!({
        "status": if status.connected { "connected" } else { "idle" },
        "connected": status.connected
    })
}

#[tauri::command]
pub async fn voice_live_send(request: Option<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || voice_live_send_direct(request))
        .await
        .unwrap_or_else(|_| live_unavailable())
}

pub fn voice_live_session_direct(_request: Option<Value>) -> Value {
    let status = crate::voice_realtime::get_realtime_status();
    json!({
        "status": if status.connected { "active" } else { "idle" },
        "connected": status.connected,
        "sampleRate": status.sample_rate,
        "trackedItems": status.tracked_items
    })
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

    #[test]
    fn test_dictation_availability_and_model_selection() {
        let avail = read_dictation_availability_direct(None);
        assert_eq!(avail["schemaVersion"], 1);
        assert!(avail["localEngines"].is_array());
        assert_eq!(avail["localEngines"].as_array().unwrap().len(), 2);

        let updated = select_dictation_whisper_model_direct(Some(json!({
            "modelPath": "C:\\models\\ggml-base.bin"
        })));
        assert_eq!(updated["schemaVersion"], 1);
        let settings = read_dictation_settings_direct(None);
        assert_eq!(settings["whisperModelPath"], "C:\\models\\ggml-base.bin");
        assert_eq!(settings["localEngine"], "whisper");
    }
}
