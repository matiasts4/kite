pub mod call_receipts;
pub mod capture;
pub mod offline_stt;
pub mod resampler;
pub mod ring_buffer;
pub mod stt_ws;

use capture::{
    get_capture_status, list_input_devices, start_capture, stop_capture_and_export_wav,
    NativeAudioInputDevice, NativeCaptureStatus,
};
use serde_json::{json, Value};

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
) -> Value {
    let rate = sample_rate.unwrap_or(16000);
    tauri::async_runtime::spawn_blocking(move || match start_capture(device_id, rate) {
        Ok(_) => json!({ "ok": true, "sampleRate": rate }),
        Err(err) => json!({ "ok": false, "error": err }),
    })
    .await
    .unwrap_or_else(|e| json!({ "ok": false, "error": e.to_string() }))
}

#[tauri::command]
pub async fn voice_audio_stop_capture() -> Value {
    tauri::async_runtime::spawn_blocking(move || {
        let wav = stop_capture_and_export_wav();
        match wav {
            Some(bytes) => {
                use base64::Engine;
                let wav_base64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                json!({ "ok": true, "wavBytes": bytes.len(), "wavBase64": wav_base64 })
            }
            None => json!({ "ok": true, "wavBytes": 0 }),
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
