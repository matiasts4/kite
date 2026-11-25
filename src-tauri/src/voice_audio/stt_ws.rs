use crate::voice_audio::resampler::encode_pcm16_wav;
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;
use tauri::Emitter;
use tokio::sync::broadcast;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::{AUTHORIZATION, HeaderValue};
use tokio_tungstenite::tungstenite::Message;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SttTranscriptEvent {
    pub kind: String, // "partial" | "final"
    pub text: String,
    pub backend: String,
}

pub fn build_stt_ws_url(base_url: &str, language: &str, sample_rate: u32) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    let ws_base = if let Some(rest) = trimmed.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = trimmed.strip_prefix("http://") {
        format!("ws://{rest}")
    } else if trimmed.starts_with("wss://") || trimmed.starts_with("ws://") {
        trimmed.to_string()
    } else {
        format!("wss://{trimmed}")
    };
    let endpoint = if ws_base.ends_with("/stt") {
        ws_base
    } else if ws_base.ends_with("/v1") {
        format!("{ws_base}/stt")
    } else {
        format!("{ws_base}/v1/stt")
    };
    let lang = if language.trim().is_empty() {
        "es"
    } else {
        language.trim()
    };
    format!("{endpoint}?language={lang}&encoding=linear16&sample_rate={sample_rate}")
}

pub fn build_stt_http_url(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    let http_base = if let Some(rest) = trimmed.strip_prefix("wss://") {
        format!("https://{rest}")
    } else if let Some(rest) = trimmed.strip_prefix("ws://") {
        format!("http://{rest}")
    } else {
        trimmed.to_string()
    };
    if http_base.ends_with("/audio/transcriptions") {
        http_base
    } else if http_base.ends_with("/v1") {
        format!("{http_base}/audio/transcriptions")
    } else {
        format!("{http_base}/v1/audio/transcriptions")
    }
}

pub fn parse_stt_ws_message(raw: &str) -> Option<SttTranscriptEvent> {
    let parsed: Value = serde_json::from_str(raw).ok()?;
    let msg_type = parsed
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    let text = parsed
        .get("text")
        .or_else(|| parsed.get("transcript"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())?
        .to_string();

    let is_final = parsed
        .get("is_final")
        .or_else(|| parsed.get("final"))
        .and_then(|v| v.as_bool())
        .unwrap_or_else(|| msg_type.contains("final") || msg_type == "transcript");

    Some(SttTranscriptEvent {
        kind: if is_final {
            "final".to_string()
        } else {
            "partial".to_string()
        },
        text,
        backend: "rust-ws".to_string(),
    })
}

pub async fn stream_pcm_to_stt_ws(
    api_key: &str,
    base_url: &str,
    language: &str,
    sample_rate: u32,
    rx: broadcast::Receiver<Vec<i16>>,
    stop_signal: tokio::sync::watch::Receiver<bool>,
) -> Result<String, String> {
    stream_pcm_to_stt_ws_with_preroll(
        api_key,
        base_url,
        language,
        sample_rate,
        Vec::new(),
        rx,
        stop_signal,
    )
    .await
}

pub async fn stream_pcm_to_stt_ws_with_preroll(
    api_key: &str,
    base_url: &str,
    language: &str,
    sample_rate: u32,
    initial_pcm: Vec<i16>,
    mut rx: broadcast::Receiver<Vec<i16>>,
    stop_signal: tokio::sync::watch::Receiver<bool>,
) -> Result<String, String> {
    let ws_url = build_stt_ws_url(base_url, language, sample_rate);
    let mut request = ws_url
        .into_client_request()
        .map_err(|e| format!("Invalid STT WebSocket URL: {e}"))?;
    let auth_val = HeaderValue::from_str(&format!("Bearer {}", api_key.trim()))
        .map_err(|e| format!("Invalid STT credential header: {e}"))?;
    request.headers_mut().insert(AUTHORIZATION, auth_val);

    let (ws_stream, _) = tokio::time::timeout(
        Duration::from_secs(5),
        tokio_tungstenite::connect_async(request),
    )
    .await
    .map_err(|_| "STT WebSocket connect timeout".to_string())?
    .map_err(|e| format!("STT WebSocket handshake failed: {e}"))?;

    let (mut write, mut read) = ws_stream.split();
    if !initial_pcm.is_empty() {
        for chunk in initial_pcm.chunks(3200) {
            let mut bytes = Vec::with_capacity(chunk.len() * 2);
            for &s in chunk {
                bytes.extend_from_slice(&s.to_le_bytes());
            }
            let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
            let msg = serde_json::json!({ "type": "audio", "audio": encoded }).to_string();
            if write.send(Message::Text(msg)).await.is_err() {
                return Err("STT WebSocket pre-roll send interrupted".to_string());
            }
        }
    }

    let mut last_text = String::new();
    let mut stop_rx = stop_signal.clone();
    let mut flushing = false;
    let flush_sleep = tokio::time::sleep(Duration::from_secs(3600));
    tokio::pin!(flush_sleep);

    loop {
        tokio::select! {
            _ = stop_rx.changed(), if !flushing => {
                if *stop_rx.borrow() {
                    flushing = true;
                    let _ = write.send(Message::Text(serde_json::json!({"type": "commit"}).to_string())).await;
                    flush_sleep.as_mut().reset(tokio::time::Instant::now() + Duration::from_millis(900));
                }
            }
            _ = &mut flush_sleep, if flushing => {
                let _ = write.close().await;
                break;
            }
            frame = rx.recv(), if !flushing => {
                match frame {
                    Ok(pcm) => {
                        let mut bytes = Vec::with_capacity(pcm.len() * 2);
                        for s in pcm {
                            bytes.extend_from_slice(&s.to_le_bytes());
                        }
                        let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
                        let msg = serde_json::json!({
                            "type": "audio",
                            "audio": encoded,
                        }).to_string();
                        if write.send(Message::Text(msg)).await.is_err() {
                            return Err("STT WebSocket send interrupted".to_string());
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                }
            }
            incoming = read.next() => {
                match incoming {
                    Some(Ok(Message::Text(txt))) => {
                        if let Some(ev) = parse_stt_ws_message(&txt) {
                            last_text = ev.text.clone();
                            let is_final = ev.kind == "final";
                            if let Some(handle) = crate::get_app_handle() {
                                let event_name = if is_final { "voice:stt-final" } else { "voice:stt-partial" };
                                let _ = handle.emit(event_name, &ev);
                            }
                            if flushing && is_final {
                                let _ = write.close().await;
                                break;
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Err(err)) => return Err(format!("STT WebSocket read failed: {err}")),
                    _ => {}
                }
            }
        }
    }

    Ok(last_text)
}

/// RIFF/WAVE fallback over HTTP multipart when streaming WebSocket STT fails or disconnects.
pub async fn transcribe_wav_http_fallback(
    wav_bytes: Vec<u8>,
    api_key: &str,
    base_url: &str,
    model: &str,
    language: &str,
) -> Result<String, String> {
    if wav_bytes.len() <= 44 {
        return Ok(String::new());
    }
    let url = build_stt_http_url(base_url);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

    let part = reqwest::multipart::Part::bytes(wav_bytes)
        .file_name("speech.wav")
        .mime_str("audio/wav")
        .map_err(|e| format!("Multipart error: {e}"))?;
    let mut form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("model", if model.trim().is_empty() { "grok-voice-transcribe-2.0".to_string() } else { model.to_string() });
    if !language.trim().is_empty() && language != "auto" {
        form = form.text("language", language.split('-').next().unwrap_or(language).to_string());
    }

    let resp = client
        .post(&url)
        .bearer_auth(api_key.trim())
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("HTTP STT fallback request failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP STT fallback returned status {}", resp.status()));
    }

    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("Invalid JSON from HTTP STT fallback: {e}"))?;
    Ok(body
        .get("text")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string())
}

pub fn encode_samples_wav(samples: &[i16], sample_rate: u32) -> Vec<u8> {
    encode_pcm16_wav(samples, sample_rate)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_wss_stt_url_and_http_fallback_url() {
        assert_eq!(
            build_stt_ws_url("https://api.x.ai/v1", "es-ES", 16000),
            "wss://api.x.ai/v1/stt?language=es-ES&encoding=linear16&sample_rate=16000"
        );
        assert_eq!(
            build_stt_http_url("wss://api.x.ai/v1"),
            "https://api.x.ai/v1/audio/transcriptions"
        );
    }

    #[test]
    fn parses_partial_and_final_ws_transcript_frames() {
        let partial = parse_stt_ws_message(r#"{"type":"transcript.partial","text":"abre dos","is_final":false}"#).unwrap();
        assert_eq!(partial.kind, "partial");
        assert_eq!(partial.text, "abre dos");

        let final_ev = parse_stt_ws_message(r#"{"type":"transcript.final","text":"abre dos terminales","is_final":true}"#).unwrap();
        assert_eq!(final_ev.kind, "final");
        assert_eq!(final_ev.text, "abre dos terminales");
    }
}
