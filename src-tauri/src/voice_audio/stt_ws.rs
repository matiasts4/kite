use crate::voice_audio::resampler::encode_pcm16_wav;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;
use tauri::Emitter;
use tokio::sync::broadcast;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::{HeaderValue, AUTHORIZATION};
use tokio_tungstenite::tungstenite::Message;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SttTranscriptEvent {
    pub kind: String, // "partial" | "final"
    pub text: String,
    pub backend: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SttWsFrame {
    Transcript { text: String, is_final: bool },
    Done { text: Option<String> },
    Error(String),
    Ignore,
}

pub fn is_xai_streaming_stt_base_url(base_url: &str) -> bool {
    let lower = base_url.trim().to_ascii_lowercase();
    if lower.is_empty() || lower.contains("api.x.ai") {
        return true;
    }
    !lower.contains("openai.com") && !lower.contains("groq.com")
}

fn normalize_stt_language(language: &str) -> String {
    let short = language
        .trim()
        .split(['-', '_'])
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if short.is_empty() {
        "es".to_string()
    } else {
        short
    }
}

pub fn build_stt_ws_url(base_url: &str, language: &str, sample_rate: u32) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    let ws_base = if trimmed.is_empty() {
        "wss://api.x.ai/v1".to_string()
    } else if let Some(rest) = trimmed.strip_prefix("https://") {
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
    let short_lang = normalize_stt_language(language);
    if short_lang == "auto" {
        format!(
            "{endpoint}?sample_rate={sample_rate}&encoding=pcm&interim_results=true&endpointing=400"
        )
    } else {
        format!(
            "{endpoint}?sample_rate={sample_rate}&encoding=pcm&interim_results=true&language={short_lang}&endpointing=400"
        )
    }
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

/// Joins committed speech text with a new partial/final segment on word boundaries.
pub fn join_speech_partial(stable: &str, interim: &str) -> String {
    let head = stable.trim();
    let tail = interim.trim();
    if head.is_empty() {
        return tail.to_string();
    }
    if tail.is_empty() {
        return head.to_string();
    }
    if tail.starts_with(head) {
        return tail.to_string();
    }
    if head.ends_with(tail) {
        return head.to_string();
    }

    let head_chars: Vec<char> = head.chars().collect();
    let tail_chars: Vec<char> = tail.chars().collect();
    let max = head_chars.len().min(tail_chars.len());
    for size in (1..=max).rev() {
        if head_chars[head_chars.len() - size..] != tail_chars[..size] {
            continue;
        }
        let before_ok =
            size == head_chars.len() || head_chars[head_chars.len() - size - 1].is_whitespace();
        let after_ok = size == tail_chars.len() || tail_chars[size].is_whitespace();
        if !before_ok || !after_ok {
            continue;
        }
        let mut merged = String::with_capacity(head.len() + tail.len());
        merged.push_str(head);
        for &ch in &tail_chars[size..] {
            merged.push(ch);
        }
        return merged.split_whitespace().collect::<Vec<_>>().join(" ");
    }

    format!("{head} {tail}")
}

fn non_empty_trimmed_str(val: Option<&Value>) -> Option<String> {
    val.and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

pub fn parse_stt_ws_frame(raw: &str) -> SttWsFrame {
    let Ok(parsed) = serde_json::from_str::<Value>(raw) else {
        return SttWsFrame::Ignore;
    };
    if !parsed.is_object() {
        return SttWsFrame::Ignore;
    }

    let msg_type = parsed
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or_default();

    let text_chunk = non_empty_trimmed_str(parsed.get("transcript"))
        .or_else(|| non_empty_trimmed_str(parsed.get("text")))
        .or_else(|| non_empty_trimmed_str(parsed.get("delta")))
        .or_else(|| non_empty_trimmed_str(parsed.pointer("/data/transcript")))
        .or_else(|| non_empty_trimmed_str(parsed.pointer("/channel/alternatives/0/transcript")));

    if msg_type == "Error" || msg_type == "error" {
        let err_msg = non_empty_trimmed_str(parsed.pointer("/error/message"))
            .or_else(|| non_empty_trimmed_str(parsed.get("message")))
            .unwrap_or_else(|| "Streaming STT error".to_string());
        return SttWsFrame::Error(err_msg);
    }

    if matches!(
        msg_type,
        "Done" | "done" | "transcript.done" | "session.done"
    ) {
        return SttWsFrame::Done { text: text_chunk };
    }

    if let Some(text) = text_chunk {
        let has_explicit_final_flag = parsed.get("is_final").is_some()
            || parsed.get("speech_final").is_some()
            || parsed.get("final").is_some();
        let is_final = parsed.get("is_final").and_then(|v| v.as_bool()) == Some(true)
            || parsed.get("speech_final").and_then(|v| v.as_bool()) == Some(true)
            || parsed.get("final").and_then(|v| v.as_bool()) == Some(true)
            || msg_type == "transcript.final"
            || (msg_type == "transcript" && !has_explicit_final_flag);
        return SttWsFrame::Transcript { text, is_final };
    }

    SttWsFrame::Ignore
}

pub fn parse_stt_ws_message(raw: &str) -> Option<SttTranscriptEvent> {
    match parse_stt_ws_frame(raw) {
        SttWsFrame::Transcript { text, is_final } => Some(SttTranscriptEvent {
            kind: if is_final {
                "final".to_string()
            } else {
                "partial".to_string()
            },
            text,
            backend: "rust-ws".to_string(),
        }),
        SttWsFrame::Done { text: Some(text) } => Some(SttTranscriptEvent {
            kind: "final".to_string(),
            text,
            backend: "rust-ws".to_string(),
        }),
        _ => None,
    }
}

fn pcm16_to_le_bytes(pcm: &[i16]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(pcm.len() * 2);
    for &s in pcm {
        bytes.extend_from_slice(&s.to_le_bytes());
    }
    bytes
}

fn emit_stt_event(event_name: &str, kind: &str, text: &str) {
    if let Some(handle) = crate::get_app_handle() {
        let ev = SttTranscriptEvent {
            kind: kind.to_string(),
            text: text.to_string(),
            backend: "rust-ws".to_string(),
        };
        let _ = handle.emit(event_name, &ev);
    }
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
            let bytes = pcm16_to_le_bytes(chunk);
            if write.send(Message::Binary(bytes)).await.is_err() {
                return Err("STT WebSocket pre-roll send interrupted".to_string());
            }
        }
    }

    let mut final_transcript = String::new();
    let mut interim_transcript = String::new();
    let mut stop_rx = stop_signal.clone();
    let mut flushing = false;
    let flush_sleep = tokio::time::sleep(Duration::from_secs(3600));
    tokio::pin!(flush_sleep);

    loop {
        tokio::select! {
            _ = stop_rx.changed(), if !flushing => {
                if *stop_rx.borrow() {
                    flushing = true;
                    let _ = write.send(Message::Text(r#"{"type":"audio.done"}"#.to_string())).await;
                    flush_sleep.as_mut().reset(tokio::time::Instant::now() + Duration::from_millis(1100));
                }
            }
            _ = &mut flush_sleep, if flushing => {
                let _ = write.close().await;
                break;
            }
            frame = rx.recv(), if !flushing => {
                match frame {
                    Ok(pcm) => {
                        if !pcm.is_empty() {
                            let bytes = pcm16_to_le_bytes(&pcm);
                            if write.send(Message::Binary(bytes)).await.is_err() {
                                return Err("STT WebSocket send interrupted".to_string());
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                }
            }
            incoming = read.next() => {
                match incoming {
                    Some(Ok(Message::Text(txt))) => {
                        match parse_stt_ws_frame(&txt) {
                            SttWsFrame::Error(err_msg) => {
                                let _ = write.close().await;
                                return Err(err_msg);
                            }
                            SttWsFrame::Done { text } => {
                                if let Some(t) = text {
                                    final_transcript = join_speech_partial(&final_transcript, &t);
                                } else if !interim_transcript.is_empty() {
                                    final_transcript = join_speech_partial(&final_transcript, &interim_transcript);
                                }
                                interim_transcript.clear();
                                if !final_transcript.is_empty() {
                                    emit_stt_event("voice:stt-final", "final", &final_transcript);
                                }
                                let _ = write.close().await;
                                break;
                            }
                            SttWsFrame::Transcript { text, is_final: true } => {
                                final_transcript = join_speech_partial(&final_transcript, &text);
                                interim_transcript.clear();
                                emit_stt_event("voice:stt-final", "final", &final_transcript);
                                if flushing {
                                    flush_sleep.as_mut().reset(tokio::time::Instant::now() + Duration::from_millis(250));
                                }
                            }
                            SttWsFrame::Transcript { text, is_final: false } => {
                                interim_transcript = text;
                                let combined = join_speech_partial(&final_transcript, &interim_transcript);
                                emit_stt_event("voice:stt-partial", "partial", &combined);
                            }
                            SttWsFrame::Ignore => {}
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Err(err)) => return Err(format!("STT WebSocket read failed: {err}")),
                    _ => {}
                }
            }
        }
    }

    Ok(join_speech_partial(&final_transcript, &interim_transcript))
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
        .text(
            "model",
            if model.trim().is_empty() {
                "grok-voice-transcribe-2.0".to_string()
            } else {
                model.to_string()
            },
        );
    if !language.trim().is_empty() && language != "auto" {
        form = form.text(
            "language",
            language.split('-').next().unwrap_or(language).to_string(),
        );
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
            "wss://api.x.ai/v1/stt?sample_rate=16000&encoding=pcm&interim_results=true&language=es&endpointing=400"
        );
        assert_eq!(
            build_stt_ws_url("https://api.x.ai/v1", "auto", 16000),
            "wss://api.x.ai/v1/stt?sample_rate=16000&encoding=pcm&interim_results=true&endpointing=400"
        );
        assert_eq!(
            build_stt_http_url("wss://api.x.ai/v1"),
            "https://api.x.ai/v1/audio/transcriptions"
        );
        assert!(is_xai_streaming_stt_base_url("https://api.x.ai/v1"));
        assert!(!is_xai_streaming_stt_base_url("https://api.openai.com/v1"));
        assert!(!is_xai_streaming_stt_base_url("https://api.groq.com/openai/v1"));
    }

    #[test]
    fn parses_partial_and_final_ws_transcript_frames() {
        let partial = parse_stt_ws_message(
            r#"{"type":"transcript.partial","text":"abre dos","is_final":false}"#,
        )
        .unwrap();
        assert_eq!(partial.kind, "partial");
        assert_eq!(partial.text, "abre dos");

        let final_ev = parse_stt_ws_message(
            r#"{"type":"transcript.final","text":"abre dos terminales","is_final":true}"#,
        )
        .unwrap();
        assert_eq!(final_ev.kind, "final");
        assert_eq!(final_ev.text, "abre dos terminales");

        assert_eq!(
            parse_stt_ws_frame(
                r#"{"type":"transcript.created","delta":"hola","is_final":false}"#
            ),
            SttWsFrame::Transcript {
                text: "hola".to_string(),
                is_final: false
            }
        );
        assert_eq!(
            parse_stt_ws_frame(r#"{"type":"interim","data":{"transcript":"en vivo"}}"#),
            SttWsFrame::Transcript {
                text: "en vivo".to_string(),
                is_final: false
            }
        );
        assert_eq!(
            parse_stt_ws_frame(
                r#"{"type":"transcript","channel":{"alternatives":[{"transcript":"listo"}]},"speech_final":true}"#
            ),
            SttWsFrame::Transcript {
                text: "listo".to_string(),
                is_final: true
            }
        );
        assert_eq!(
            parse_stt_ws_frame(r#"{"type":"Done","transcript":"terminado"}"#),
            SttWsFrame::Done {
                text: Some("terminado".to_string())
            }
        );
        assert_eq!(
            parse_stt_ws_frame(r#"{"type":"error","error":{"message":"invalid audio"}}"#),
            SttWsFrame::Error("invalid audio".to_string())
        );
    }

    #[test]
    fn joins_spanish_utf8_partials_on_word_boundaries() {
        assert_eq!(
            join_speech_partial("¿Cómo estás", "estás hoy?"),
            "¿Cómo estás hoy?"
        );
        assert_eq!(
            join_speech_partial("hola mundo", "cómo estás"),
            "hola mundo cómo estás"
        );
        assert_eq!(
            join_speech_partial("abre", "abre dos terminales"),
            "abre dos terminales"
        );
    }

    #[tokio::test]
    async fn streams_binary_pcm16_frames_and_audio_done_against_mock_xai_ws() {
        use tokio::net::TcpListener;
        use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        let (captured_req_tx, captured_req_rx) = tokio::sync::oneshot::channel::<(String, String)>();
        let server_task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut req_tx = Some(captured_req_tx);
            let ws_stream = tokio_tungstenite::accept_hdr_async(
                stream,
                move |req: &Request, resp: Response| {
                    if let Some(tx) = req_tx.take() {
                        let uri = req.uri().to_string();
                        let auth = req
                            .headers()
                            .get("authorization")
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or("")
                            .to_string();
                        let _ = tx.send((uri, auth));
                    }
                    Ok(resp)
                },
            )
            .await
            .unwrap();

            let (mut ws_tx, mut ws_rx) = ws_stream.split();
            let mut binary_frames: Vec<Vec<u8>> = Vec::new();
            let mut saw_audio_done = false;

            // Expect pre-roll binary frame
            if let Some(Ok(Message::Binary(bytes))) = ws_rx.next().await {
                binary_frames.push(bytes);
            }
            // Send first interim partial
            ws_tx
                .send(Message::Text(
                    r#"{"type":"transcript","text":"hola","is_final":false}"#.to_string(),
                ))
                .await
                .unwrap();

            // Expect live binary PCM16 frame
            if let Some(Ok(Message::Binary(bytes))) = ws_rx.next().await {
                binary_frames.push(bytes);
            }
            // Emit first finalized segment + next interim segment
            ws_tx
                .send(Message::Text(
                    r#"{"type":"transcript","text":"hola mundo","is_final":true}"#.to_string(),
                ))
                .await
                .unwrap();
            ws_tx
                .send(Message::Text(
                    r#"{"type":"transcript","delta":"cómo","is_final":false}"#.to_string(),
                ))
                .await
                .unwrap();

            // Wait for audio.done after stop signal
            while let Some(Ok(msg)) = ws_rx.next().await {
                match msg {
                    Message::Binary(bytes) => binary_frames.push(bytes),
                    Message::Text(txt) => {
                        if txt.contains(r#""type":"audio.done""#) {
                            saw_audio_done = true;
                            ws_tx
                                .send(Message::Text(
                                    r#"{"type":"transcript","text":"cómo estás","speech_final":true}"#
                                        .to_string(),
                                ))
                                .await
                                .unwrap();
                            ws_tx
                                .send(Message::Text(r#"{"type":"Done"}"#.to_string()))
                                .await
                                .unwrap();
                            break;
                        }
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }

            (binary_frames, saw_audio_done)
        });

        let (frame_tx, frame_rx) = broadcast::channel::<Vec<i16>>(8);
        let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
        let base_url = format!("http://{addr}/v1");

        let pre_roll = vec![100i16, -200i16];
        let client_task = tokio::spawn(async move {
            stream_pcm_to_stt_ws_with_preroll(
                "xai-test-key",
                &base_url,
                "es-ES",
                16000,
                pre_roll,
                frame_rx,
                stop_rx,
            )
            .await
        });

        let (uri, auth) = captured_req_rx.await.unwrap();
        assert_eq!(
            uri,
            "/v1/stt?sample_rate=16000&encoding=pcm&interim_results=true&language=es&endpointing=400"
        );
        assert_eq!(auth, "Bearer xai-test-key");

        tokio::time::sleep(Duration::from_millis(30)).await;
        frame_tx.send(vec![300i16, -400i16]).unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        stop_tx.send(true).unwrap();

        let final_transcript = client_task.await.unwrap().unwrap();
        let (binary_frames, saw_audio_done) = server_task.await.unwrap();

        assert!(saw_audio_done);
        assert_eq!(binary_frames.len(), 2);
        assert_eq!(binary_frames[0], vec![100u8, 0, 56, 255]); // 100i16, -200i16 LE
        assert_eq!(binary_frames[1], vec![44u8, 1, 112, 254]); // 300i16, -400i16 LE
        assert_eq!(final_transcript, "hola mundo cómo estás");
    }
}
