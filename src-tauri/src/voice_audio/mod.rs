pub mod call_receipts;
pub mod capture;
pub mod offline_stt;
pub mod resampler;
pub mod ring_buffer;
pub mod stt_ws;

use capture::{
    ensure_capture_started, finish_capture_turn, get_capture_status, list_input_devices,
    mark_speech_start, set_capture_muted, subscribe_capture_frames, NativeAudioInputDevice,
    NativeCaptureStatus,
};
use serde_json::{json, Value};
use std::sync::{Mutex, OnceLock};
use tokio::sync::watch;

#[derive(Clone)]
struct SttSessionConfig {
    api_key: String,
    base_url: String,
    language: String,
    sample_rate: u32,
}

struct ActiveSttStream {
    stop_tx: watch::Sender<bool>,
    task: tauri::async_runtime::JoinHandle<Result<String, String>>,
}

static STT_SESSION_CFG: OnceLock<Mutex<Option<SttSessionConfig>>> = OnceLock::new();
static ACTIVE_STT_STREAM: OnceLock<Mutex<Option<ActiveSttStream>>> = OnceLock::new();

fn stt_cfg_slot() -> &'static Mutex<Option<SttSessionConfig>> {
    STT_SESSION_CFG.get_or_init(|| Mutex::new(None))
}

fn stt_stream_slot() -> &'static Mutex<Option<ActiveSttStream>> {
    ACTIVE_STT_STREAM.get_or_init(|| Mutex::new(None))
}

fn cancel_active_stt_stream() {
    let active = {
        let mut guard = stt_stream_slot().lock().unwrap();
        guard.take()
    };
    if let Some(s) = active {
        let _ = s.stop_tx.send(true);
        s.task.abort();
    }
}

fn spawn_stt_stream_if_configured(initial_pcm: Vec<i16>) {
    {
        let guard = stt_stream_slot().lock().unwrap();
        if guard.is_some() {
            return;
        }
    }
    let cfg = {
        let guard = stt_cfg_slot().lock().unwrap();
        guard.clone()
    };
    let Some(cfg) = cfg else {
        return;
    };
    let Some(rx) = subscribe_capture_frames() else {
        return;
    };
    let (stop_tx, stop_rx) = watch::channel(false);
    let task = tauri::async_runtime::spawn(async move {
        stt_ws::stream_pcm_to_stt_ws_with_preroll(
            &cfg.api_key,
            &cfg.base_url,
            &cfg.language,
            cfg.sample_rate,
            initial_pcm,
            rx,
            stop_rx,
        )
        .await
    });
    let mut guard = stt_stream_slot().lock().unwrap();
    *guard = Some(ActiveSttStream { stop_tx, task });
}

#[tauri::command]
pub async fn voice_audio_list_devices() -> Vec<NativeAudioInputDevice> {
    tauri::async_runtime::spawn_blocking(list_input_devices)
        .await
        .unwrap_or_default()
}

#[tauri::command]
pub async fn voice_audio_start_capture(
    device_id: Option<String>,
    sample_rate: Option<u32>,
    keep_existing: Option<bool>,
    from_barge_in: Option<bool>,
    stt_api_key: Option<String>,
    stt_base_url: Option<String>,
    stt_language: Option<String>,
) -> Value {
    let rate = sample_rate.unwrap_or(16000);
    let keep = keep_existing.unwrap_or(false);
    let barge_in = from_barge_in.unwrap_or(false);
    cancel_active_stt_stream();

    {
        let mut cfg_guard = stt_cfg_slot().lock().unwrap();
        if let Some(key) = stt_api_key.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
            *cfg_guard = Some(SttSessionConfig {
                api_key: key,
                base_url: stt_base_url
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| "https://api.x.ai/v1".to_string()),
                language: stt_language
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| "es-ES".to_string()),
                sample_rate: rate,
            });
        } else {
            *cfg_guard = None;
        }
    }

    let started = tauri::async_runtime::spawn_blocking(move || {
        ensure_capture_started(device_id, rate, keep, barge_in)
    })
    .await;

    match started {
        Ok(Ok((_rx, pre_roll))) => {
            if barge_in {
                spawn_stt_stream_if_configured(pre_roll);
            }
            json!({ "ok": true, "sampleRate": rate })
        }
        Ok(Err(err)) => json!({ "ok": false, "error": err }),
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }
}

#[tauri::command]
pub async fn voice_audio_mark_speech_start(pre_roll_ms: Option<u32>) -> Value {
    let ms = pre_roll_ms.unwrap_or(400);
    let pre_roll = tauri::async_runtime::spawn_blocking(move || mark_speech_start(ms))
        .await
        .unwrap_or_default();
    let sample_count = pre_roll.len();
    spawn_stt_stream_if_configured(pre_roll);
    json!({ "ok": true, "preRollSamples": sample_count })
}

#[tauri::command]
pub async fn voice_audio_set_muted(muted: bool) -> Value {
    tauri::async_runtime::spawn_blocking(move || set_capture_muted(muted))
        .await
        .ok();
    if muted {
        cancel_active_stt_stream();
    }
    json!({ "ok": true, "muted": muted })
}

#[tauri::command]
pub async fn voice_audio_stop_capture(
    keep_alive: Option<bool>,
    discard: Option<bool>,
    trim_trailing_ms: Option<u32>,
) -> Value {
    let keep = keep_alive.unwrap_or(false);
    let is_discard = discard.unwrap_or(false);
    let trim_ms = trim_trailing_ms.unwrap_or(0);

    let active_stt = {
        let mut guard = stt_stream_slot().lock().unwrap();
        guard.take()
    };
    let mut stt_transcript: Option<String> = None;
    if let Some(stream) = active_stt {
        let _ = stream.stop_tx.send(true);
        if is_discard {
            stream.task.abort();
        } else {
            let task_res = tokio::time::timeout(
                std::time::Duration::from_millis(1200),
                stream.task,
            )
            .await;
            if let Ok(Ok(Ok(txt))) = task_res {
                let clean = txt.trim().to_string();
                if !clean.is_empty() {
                    stt_transcript = Some(clean);
                }
            }
        }
    }

    if !keep {
        let mut cfg_guard = stt_cfg_slot().lock().unwrap();
        *cfg_guard = None;
    }

    tauri::async_runtime::spawn_blocking(move || {
        let wav = finish_capture_turn(keep, is_discard, trim_ms);
        match wav {
            Some(bytes) => {
                use base64::Engine;
                let wav_base64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                json!({
                    "ok": true,
                    "wavBytes": bytes.len(),
                    "wavBase64": wav_base64,
                    "sttTranscript": stt_transcript
                })
            }
            None => json!({
                "ok": true,
                "wavBytes": 0,
                "sttTranscript": stt_transcript
            }),
        }
    })
    .await
    .unwrap_or_else(|e| json!({ "ok": false, "error": e.to_string() }))
}

#[tauri::command]
pub async fn voice_audio_status() -> NativeCaptureStatus {
    tauri::async_runtime::spawn_blocking(get_capture_status)
        .await
        .unwrap_or_else(|_| get_capture_status())
}
