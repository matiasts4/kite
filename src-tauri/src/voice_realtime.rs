use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::Emitter;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::{AUTHORIZATION, HeaderValue};
use tokio_tungstenite::tungstenite::Message;

pub const DEFAULT_REALTIME_ENDPOINT: &str = "wss://api.x.ai/v1/realtime";
pub const REALTIME_SAMPLE_RATE: u32 = 24000;
pub const MAX_MID_WORK_ITEMS: usize = 20;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeStatus {
    pub connected: bool,
    pub endpoint: Option<String>,
    pub sample_rate: u32,
    pub tracked_items: usize,
}

struct RealtimeHandle {
    endpoint: String,
    outbound_tx: mpsc::UnboundedSender<String>,
    item_tracker: Mutex<MidWorkItemTracker>,
    stop_tx: tokio::sync::watch::Sender<bool>,
}

static REALTIME_SESSION: OnceLock<Mutex<Option<RealtimeHandle>>> = OnceLock::new();

fn session_slot() -> &'static Mutex<Option<RealtimeHandle>> {
    REALTIME_SESSION.get_or_init(|| Mutex::new(None))
}

/// Tracks non-essential mid-work commentary item IDs with a sliding cap of 20 items,
/// emitting `conversation.item.delete` payloads for evicted items to keep long calls stable.
#[derive(Debug)]
pub struct MidWorkItemTracker {
    max_items: usize,
    items: VecDeque<String>,
}

impl MidWorkItemTracker {
    pub fn new(max_items: usize) -> Self {
        Self {
            max_items: max_items.max(1),
            items: VecDeque::new(),
        }
    }

    pub fn record(&mut self, item_id: &str) -> Vec<Value> {
        let clean = item_id.trim();
        if clean.is_empty() {
            return Vec::new();
        }
        if !self.items.iter().any(|existing| existing == clean) {
            self.items.push_back(clean.to_string());
        }
        let mut deletions = Vec::new();
        while self.items.len() > self.max_items {
            if let Some(evicted) = self.items.pop_front() {
                deletions.push(json!({
                    "type": "conversation.item.delete",
                    "item_id": evicted
                }));
            }
        }
        deletions
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }
}

pub fn redact_realtime_error(msg: &str) -> String {
    let mut out = msg.to_string();
    for prefix in ["Bearer ", "xai-", "sk-"] {
        if let Some(idx) = out.find(prefix) {
            let end = out[idx..]
                .find(|c: char| c.is_whitespace() || c == '"' || c == '\'')
                .map(|rel| idx + rel)
                .unwrap_or(out.len());
            out.replace_range(idx..end, "[REDACTED_SECRET]");
        }
    }
    out
}

pub fn build_session_update_event(
    voice: &str,
    instructions: &str,
    tools: &[Value],
    prefix_padding_ms: u32,
    silence_duration_ms: u32,
) -> Value {
    json!({
        "type": "session.update",
        "session": {
            "modalities": ["audio", "text"],
            "voice": if voice.trim().is_empty() { "Ara" } else { voice.trim() },
            "instructions": instructions,
            "input_audio_format": "pcm16",
            "output_audio_format": "pcm16",
            "sample_rate": REALTIME_SAMPLE_RATE,
            "turn_detection": {
                "type": "server_vad",
                "threshold": 0.5,
                "prefix_padding_ms": prefix_padding_ms,
                "silence_duration_ms": silence_duration_ms
            },
            "tools": tools
        }
    })
}

pub fn build_audio_append_event(pcm16: &[i16]) -> Value {
    let mut bytes = Vec::with_capacity(pcm16.len() * 2);
    for &s in pcm16 {
        bytes.extend_from_slice(&s.to_le_bytes());
    }
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    json!({
        "type": "input_audio_buffer.append",
        "audio": b64
    })
}

pub fn build_truncate_event(item_id: &str, audio_end_ms: u64) -> Value {
    json!({
        "type": "conversation.item.truncate",
        "item_id": item_id,
        "content_index": 0,
        "audio_end_ms": audio_end_ms
    })
}

pub fn build_tool_output_events(call_id: &str, output_json: &str) -> (Value, Value) {
    let item_create = json!({
        "type": "conversation.item.create",
        "item": {
            "type": "function_call_output",
            "call_id": call_id,
            "output": output_json
        }
    });
    let response_create = json!({
        "type": "response.create"
    });
    (item_create, response_create)
}

pub fn get_realtime_status() -> RealtimeStatus {
    let slot = session_slot().lock().unwrap();
    if let Some(handle) = slot.as_ref() {
        let tracked = handle.item_tracker.lock().map(|t| t.len()).unwrap_or(0);
        RealtimeStatus {
            connected: true,
            endpoint: Some(handle.endpoint.clone()),
            sample_rate: REALTIME_SAMPLE_RATE,
            tracked_items: tracked,
        }
    } else {
        RealtimeStatus {
            connected: false,
            endpoint: None,
            sample_rate: REALTIME_SAMPLE_RATE,
            tracked_items: 0,
        }
    }
}

pub fn disconnect_realtime() {
    let handle = {
        let mut slot = session_slot().lock().unwrap();
        slot.take()
    };
    if let Some(h) = handle {
        let _ = h.stop_tx.send(true);
    }
    crate::voice_audio::capture::stop_capture();
}

#[tauri::command]
pub async fn voice_realtime_connect(
    endpoint: Option<String>,
    voice: Option<String>,
    instructions: Option<String>,
    tools: Option<Vec<Value>>,
    prefix_padding_ms: Option<u32>,
    silence_duration_ms: Option<u32>,
    device_id: Option<String>,
) -> Value {
    disconnect_realtime();

    let api_key = crate::credentials::get_vault_credential("grok_realtime")
        .or_else(|| crate::credentials::get_vault_credential("grok"))
        .or_else(|| crate::credentials::get_vault_credential("grok_transcription"))
        .unwrap_or_default()
        .trim()
        .to_string();

    if api_key.is_empty() {
        return json!({
            "ok": false,
            "connected": false,
            "fallbackToCascaded": true,
            "reason": "missing_credentials"
        });
    }

    let target_endpoint = endpoint
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_REALTIME_ENDPOINT.to_string());

    let mut request = match target_endpoint.clone().into_client_request() {
        Ok(req) => req,
        Err(err) => {
            return json!({
                "ok": false,
                "connected": false,
                "fallbackToCascaded": true,
                "reason": redact_realtime_error(&err.to_string())
            });
        }
    };
    let auth_header = match HeaderValue::from_str(&format!("Bearer {api_key}")) {
        Ok(val) => val,
        Err(_) => {
            return json!({
                "ok": false,
                "connected": false,
                "fallbackToCascaded": true,
                "reason": "invalid_credentials"
            });
        }
    };
    request.headers_mut().insert(AUTHORIZATION, auth_header);

    let ws_res = tokio::time::timeout(
        Duration::from_secs(6),
        tokio_tungstenite::connect_async(request),
    )
    .await;

    let ws_stream = match ws_res {
        Ok(Ok((stream, _))) => stream,
        Ok(Err(err)) => {
            return json!({
                "ok": false,
                "connected": false,
                "fallbackToCascaded": true,
                "reason": redact_realtime_error(&err.to_string())
            });
        }
        Err(_) => {
            return json!({
                "ok": false,
                "connected": false,
                "fallbackToCascaded": true,
                "reason": "realtime_connect_timeout"
            });
        }
    };

    let mut capture_rx = match crate::voice_audio::capture::start_capture(device_id, REALTIME_SAMPLE_RATE) {
        Ok(rx) => rx,
        Err(err) => {
            return json!({
                "ok": false,
                "connected": false,
                "fallbackToCascaded": true,
                "reason": err
            });
        }
    };

    let (outbound_tx, mut outbound_rx) = mpsc::unbounded_channel::<String>();
    let (stop_tx, mut stop_rx) = tokio::sync::watch::channel(false);

    let session_update = build_session_update_event(
        voice.as_deref().unwrap_or("Ara"),
        instructions.as_deref().unwrap_or(""),
        tools.as_deref().unwrap_or(&[]),
        prefix_padding_ms.unwrap_or(300),
        silence_duration_ms.unwrap_or(500),
    );
    let _ = outbound_tx.send(session_update.to_string());

    {
        let mut slot = session_slot().lock().unwrap();
        *slot = Some(RealtimeHandle {
            endpoint: target_endpoint.clone(),
            outbound_tx: outbound_tx.clone(),
            item_tracker: Mutex::new(MidWorkItemTracker::new(MAX_MID_WORK_ITEMS)),
            stop_tx,
        });
    }

    tauri::async_runtime::spawn(async move {
        let (mut write, mut read) = ws_stream.split();
        loop {
            tokio::select! {
                _ = stop_rx.changed() => {
                    if *stop_rx.borrow() {
                        let _ = write.close().await;
                        break;
                    }
                }
                outbound = outbound_rx.recv() => {
                    match outbound {
                        Some(msg) => {
                            if write.send(Message::Text(msg)).await.is_err() {
                                break;
                            }
                        }
                        None => break,
                    }
                }
                pcm_frame = capture_rx.recv() => {
                    if let Ok(pcm) = pcm_frame {
                        let ev = build_audio_append_event(&pcm);
                        if write.send(Message::Text(ev.to_string())).await.is_err() {
                            break;
                        }
                    }
                }
                incoming = read.next() => {
                    match incoming {
                        Some(Ok(Message::Text(txt))) => {
                            if let Ok(parsed) = serde_json::from_str::<Value>(&txt) {
                                let ev_type = parsed.get("type").and_then(|v| v.as_str()).unwrap_or("");
                                if ev_type == "conversation.item.created" {
                                    if let Some(item_id) = parsed.pointer("/item/id").and_then(|v| v.as_str()) {
                                        let deletions = {
                                            let slot = session_slot().lock().unwrap();
                                            slot.as_ref()
                                                .and_then(|h| h.item_tracker.lock().ok().map(|mut t| t.record(item_id)))
                                                .unwrap_or_default()
                                        };
                                        for del in deletions {
                                            let _ = outbound_tx.send(del.to_string());
                                        }
                                    }
                                }
                                if let Some(handle) = crate::get_app_handle() {
                                    match ev_type {
                                        "response.audio.delta" => {
                                            let _ = handle.emit("voice:realtime-audio-delta", &parsed);
                                        }
                                        "response.function_call_arguments.done" => {
                                            let _ = handle.emit("voice:realtime-tool-call", &parsed);
                                        }
                                        "conversation.item.input_audio_transcription.completed"
                                        | "response.audio_transcript.delta"
                                        | "response.audio_transcript.done" => {
                                            let _ = handle.emit("voice:realtime-transcript", &parsed);
                                        }
                                        "error" => {
                                            let safe_err = redact_realtime_error(&parsed.to_string());
                                            let _ = handle.emit("voice:realtime-status", json!({ "ok": false, "error": safe_err }));
                                        }
                                        _ => {}
                                    }
                                }
                            }
                        }
                        Some(Ok(Message::Close(_))) | None => break,
                        Some(Err(_)) => break,
                        _ => {}
                    }
                }
            }
        }
        disconnect_realtime();
    });

    json!({
        "ok": true,
        "connected": true,
        "endpoint": target_endpoint,
        "sampleRate": REALTIME_SAMPLE_RATE
    })
}

#[tauri::command]
pub async fn voice_realtime_disconnect() -> Value {
    tauri::async_runtime::spawn_blocking(disconnect_realtime)
        .await
        .ok();
    json!({ "ok": true, "connected": false })
}

#[tauri::command]
pub async fn voice_realtime_send_audio(pcm_base64: String) -> Value {
    let slot = session_slot().lock().unwrap();
    if let Some(handle) = slot.as_ref() {
        let msg = json!({
            "type": "input_audio_buffer.append",
            "audio": pcm_base64
        })
        .to_string();
        let ok = handle.outbound_tx.send(msg).is_ok();
        return json!({ "ok": ok });
    }
    json!({ "ok": false, "error": "Realtime session not connected" })
}

#[tauri::command]
pub async fn voice_realtime_truncate(item_id: String, audio_end_ms: u64) -> Value {
    let slot = session_slot().lock().unwrap();
    if let Some(handle) = slot.as_ref() {
        let ev = build_truncate_event(&item_id, audio_end_ms);
        let ok = handle.outbound_tx.send(ev.to_string()).is_ok();
        return json!({ "ok": ok, "itemId": item_id, "audioEndMs": audio_end_ms });
    }
    json!({ "ok": false, "error": "Realtime session not connected" })
}

#[tauri::command]
pub async fn voice_realtime_submit_tool_result(call_id: String, output_json: String) -> Value {
    let slot = session_slot().lock().unwrap();
    if let Some(handle) = slot.as_ref() {
        let (item_ev, resp_ev) = build_tool_output_events(&call_id, &output_json);
        let ok1 = handle.outbound_tx.send(item_ev.to_string()).is_ok();
        let ok2 = handle.outbound_tx.send(resp_ev.to_string()).is_ok();
        return json!({ "ok": ok1 && ok2, "callId": call_id });
    }
    json!({ "ok": false, "error": "Realtime session not connected" })
}

#[tauri::command]
pub async fn voice_realtime_status() -> RealtimeStatus {
    get_realtime_status()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_24khz_session_update_truncate_and_tool_outputs() {
        let session_ev = build_session_update_event(
            "Ara",
            "Instrucciones",
            &[json!({ "type": "function", "name": "peek_changes" })],
            300,
            500,
        );
        assert_eq!(session_ev["type"], "session.update");
        assert_eq!(session_ev["session"]["sample_rate"], 24000);
        assert_eq!(session_ev["session"]["input_audio_format"], "pcm16");
        assert_eq!(session_ev["session"]["turn_detection"]["prefix_padding_ms"], 300);

        let trunc = build_truncate_event("item-abc", 1250);
        assert_eq!(trunc["type"], "conversation.item.truncate");
        assert_eq!(trunc["item_id"], "item-abc");
        assert_eq!(trunc["audio_end_ms"], 1250);

        let (item_ev, resp_ev) = build_tool_output_events("call-1", "{\"ok\":true}");
        assert_eq!(item_ev["type"], "conversation.item.create");
        assert_eq!(item_ev["item"]["type"], "function_call_output");
        assert_eq!(item_ev["item"]["call_id"], "call-1");
        assert_eq!(resp_ev["type"], "response.create");
    }

    #[test]
    fn mid_work_tracker_prunes_beyond_20_item_cap_and_redacts_secrets() {
        let mut tracker = MidWorkItemTracker::new(MAX_MID_WORK_ITEMS);
        for i in 1..=20 {
            assert!(tracker.record(&format!("item-{i}")).is_empty());
        }
        let deletions = tracker.record("item-21");
        assert_eq!(deletions.len(), 1);
        assert_eq!(deletions[0]["type"], "conversation.item.delete");
        assert_eq!(deletions[0]["item_id"], "item-1");
        assert_eq!(tracker.len(), 20);

        let safe = redact_realtime_error("Auth failed with Bearer xai-secretkey1234567890 on socket");
        assert!(!safe.contains("xai-secretkey1234567890"));
        assert!(safe.contains("[REDACTED_SECRET]"));
    }
}
