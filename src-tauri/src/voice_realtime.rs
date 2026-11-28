use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::Emitter;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::handshake::client::Request as WsRequest;
use tokio_tungstenite::tungstenite::http::header::{HeaderName, HeaderValue, AUTHORIZATION};
use tokio_tungstenite::tungstenite::Message;

pub const DEFAULT_REALTIME_ENDPOINT: &str = "wss://api.x.ai/v1/realtime";
pub const DEFAULT_OPENAI_REALTIME_ENDPOINT: &str =
    "wss://api.openai.com/v1/realtime?model=gpt-realtime";
pub const DEFAULT_GEMINI_LIVE_ENDPOINT: &str = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
pub const DEFAULT_GEMINI_LIVE_MODEL: &str =
    "models/gemini-2.5-flash-native-audio-preview-09-2025";

pub const REALTIME_SAMPLE_RATE: u32 = 24000;
pub const GEMINI_INPUT_SAMPLE_RATE: u32 = 16000;
pub const MAX_MID_WORK_ITEMS: usize = 20;
const MUTE_FLUSH_CHUNKS: usize = 5;
const MUTE_FLUSH_CHUNK_MS: u32 = 100;
const MAX_PENDING_TOOL_CALLS: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RealtimeProviderKind {
    Xai,
    GeminiLive,
    #[serde(alias = "openai")]
    OpenAi,
}

impl RealtimeProviderKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Xai => "xai",
            Self::GeminiLive => "gemini_live",
            Self::OpenAi => "openai",
        }
    }

    pub fn capture_sample_rate(self) -> u32 {
        match self {
            Self::GeminiLive => GEMINI_INPUT_SAMPLE_RATE,
            Self::Xai | Self::OpenAi => REALTIME_SAMPLE_RATE,
        }
    }

    pub fn output_sample_rate(self) -> u32 {
        REALTIME_SAMPLE_RATE
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeStatus {
    pub connected: bool,
    pub endpoint: Option<String>,
    pub provider: Option<String>,
    pub sample_rate: u32,
    pub tracked_items: usize,
    pub muted: bool,
}

struct RealtimeHandle {
    session_id: u64,
    endpoint: String,
    provider: RealtimeProviderKind,
    input_sample_rate: u32,
    muted: Arc<AtomicBool>,
    outbound_tx: mpsc::UnboundedSender<String>,
    item_tracker: Mutex<MidWorkItemTracker>,
    pending_tool_calls: Mutex<HashMap<String, String>>,
    stop_tx: tokio::sync::watch::Sender<bool>,
}

static REALTIME_SESSION: OnceLock<Mutex<Option<RealtimeHandle>>> = OnceLock::new();
static NEXT_SESSION_ID: AtomicU64 = AtomicU64::new(1);

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

fn redact_prefixed_tokens(
    out: &mut String,
    prefix: &str,
    skip_after_prefix_ws: bool,
    keep_prefix: bool,
) {
    let mut search_from = 0;
    while search_from < out.len() {
        let Some(rel_idx) = out[search_from..].find(prefix) else {
            break;
        };
        let idx = search_from + rel_idx;
        let mut token_start = idx + prefix.len();
        if skip_after_prefix_ws {
            while token_start < out.len() {
                let Some(ch) = out[token_start..].chars().next() else {
                    break;
                };
                if ch.is_whitespace() {
                    token_start += ch.len_utf8();
                } else {
                    break;
                }
            }
        }
        let end = out[token_start..]
            .find(|c: char| {
                c.is_whitespace() || matches!(c, '"' | '\'' | '&' | ',' | ';' | ')' | ']' | '}')
            })
            .map(|rel| token_start + rel)
            .unwrap_or(out.len());
        if keep_prefix && end == token_start {
            search_from = token_start;
            continue;
        }
        let replace_start = if keep_prefix { token_start } else { idx };
        let replacement = "[REDACTED_SECRET]";
        out.replace_range(replace_start..end, replacement);
        search_from = replace_start + replacement.len();
    }
}

pub fn redact_realtime_error(msg: &str) -> String {
    let mut out = msg.to_string();
    redact_prefixed_tokens(&mut out, "Bearer ", true, false);
    redact_prefixed_tokens(&mut out, "bearer ", true, false);
    redact_prefixed_tokens(&mut out, "key=", false, true);
    redact_prefixed_tokens(&mut out, "AIza", false, false);
    redact_prefixed_tokens(&mut out, "xai-", false, false);
    redact_prefixed_tokens(&mut out, "sk-", false, false);
    out
}

fn extract_ws_host(endpoint: &str) -> String {
    let trimmed = endpoint.trim();
    let without_scheme = trimmed
        .strip_prefix("wss://")
        .or_else(|| trimmed.strip_prefix("ws://"))
        .or_else(|| trimmed.strip_prefix("https://"))
        .or_else(|| trimmed.strip_prefix("http://"))
        .unwrap_or(trimmed);
    let authority = without_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("");
    authority
        .split(':')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
}

pub fn resolve_provider_kind(
    provider: Option<&str>,
    endpoint: Option<&str>,
) -> RealtimeProviderKind {
    if let Some(raw) = provider.map(str::trim).filter(|s| !s.is_empty()) {
        match raw.to_ascii_lowercase().as_str() {
            "gemini_live" | "gemini-live" | "gemini" | "google" | "google_ai" => {
                return RealtimeProviderKind::GeminiLive;
            }
            "openai" | "open_ai" | "openai_realtime" | "openai-realtime" => {
                return RealtimeProviderKind::OpenAi;
            }
            "xai" | "x_ai" | "grok" | "grok_realtime" | "grok-realtime" => {
                return RealtimeProviderKind::Xai;
            }
            _ => {}
        }
    }

    if let Some(ep) = endpoint.map(str::trim).filter(|s| !s.is_empty()) {
        let host = extract_ws_host(ep);
        if host == "generativelanguage.googleapis.com"
            || host.ends_with(".generativelanguage.googleapis.com")
            || host.ends_with("aiplatform.googleapis.com")
        {
            return RealtimeProviderKind::GeminiLive;
        }
        if host == "api.openai.com" || host.ends_with(".openai.com") {
            return RealtimeProviderKind::OpenAi;
        }
    }

    RealtimeProviderKind::Xai
}

pub fn default_endpoint_for_provider(
    provider: RealtimeProviderKind,
    model: Option<&str>,
) -> String {
    match provider {
        RealtimeProviderKind::Xai => DEFAULT_REALTIME_ENDPOINT.to_string(),
        RealtimeProviderKind::GeminiLive => DEFAULT_GEMINI_LIVE_ENDPOINT.to_string(),
        RealtimeProviderKind::OpenAi => {
            if let Some(m) = model.map(str::trim).filter(|s| !s.is_empty()) {
                format!("wss://api.openai.com/v1/realtime?model={m}")
            } else {
                DEFAULT_OPENAI_REALTIME_ENDPOINT.to_string()
            }
        }
    }
}

pub fn vault_credential_candidates(provider: RealtimeProviderKind) -> &'static [&'static str] {
    match provider {
        RealtimeProviderKind::GeminiLive => &["gemini_live", "gemini", "google_ai"],
        RealtimeProviderKind::OpenAi => &["openai_realtime", "openai"],
        RealtimeProviderKind::Xai => &["grok_realtime", "grok", "grok_transcription"],
    }
}

pub fn resolve_realtime_api_key_with(
    provider: RealtimeProviderKind,
    explicit_api_key: Option<&str>,
    vault_lookup: &dyn Fn(&str) -> Option<String>,
) -> String {
    if let Some(explicit) = explicit_api_key.map(str::trim).filter(|s| !s.is_empty()) {
        return explicit.to_string();
    }
    for &candidate in vault_credential_candidates(provider) {
        if let Some(found) = vault_lookup(candidate) {
            let clean = found.trim();
            if !clean.is_empty() {
                return clean.to_string();
            }
        }
    }
    String::new()
}

pub fn resolve_realtime_api_key(
    provider: RealtimeProviderKind,
    explicit_api_key: Option<&str>,
) -> String {
    if let Some(explicit) = explicit_api_key.map(str::trim).filter(|s| !s.is_empty()) {
        return explicit.to_string();
    }
    let candidates = vault_credential_candidates(provider);
    let batch = crate::credentials::get_vault_credentials_batch(candidates);
    for &candidate in candidates {
        if let Some(found) = batch.get(candidate) {
            let clean = found.trim();
            if !clean.is_empty() {
                return clean.to_string();
            }
        }
    }
    String::new()
}

pub fn build_realtime_ws_request(
    provider: RealtimeProviderKind,
    endpoint: &str,
    api_key: &str,
) -> Result<WsRequest, String> {
    let clean_endpoint = endpoint.trim();
    let clean_key = api_key.trim();

    let connect_url = match provider {
        RealtimeProviderKind::GeminiLive => {
            if clean_key.starts_with("ya29.") {
                clean_endpoint.to_string()
            } else if clean_endpoint.contains("key=") {
                clean_endpoint.to_string()
            } else if clean_endpoint.contains('?') {
                format!("{clean_endpoint}&key={clean_key}")
            } else {
                format!("{clean_endpoint}?key={clean_key}")
            }
        }
        RealtimeProviderKind::Xai | RealtimeProviderKind::OpenAi => clean_endpoint.to_string(),
    };

    let mut request = connect_url
        .into_client_request()
        .map_err(|err| redact_realtime_error(&err.to_string()))?;

    match provider {
        RealtimeProviderKind::GeminiLive => {
            if clean_key.starts_with("ya29.") {
                let auth_header = HeaderValue::from_str(&format!("Bearer {clean_key}"))
                    .map_err(|_| "invalid_credentials".to_string())?;
                request.headers_mut().insert(AUTHORIZATION, auth_header);
            }
        }
        RealtimeProviderKind::OpenAi => {
            let auth_header = HeaderValue::from_str(&format!("Bearer {clean_key}"))
                .map_err(|_| "invalid_credentials".to_string())?;
            request.headers_mut().insert(AUTHORIZATION, auth_header);
            request.headers_mut().insert(
                HeaderName::from_static("openai-beta"),
                HeaderValue::from_static("realtime=v1"),
            );
        }
        RealtimeProviderKind::Xai => {
            let auth_header = HeaderValue::from_str(&format!("Bearer {clean_key}"))
                .map_err(|_| "invalid_credentials".to_string())?;
            request.headers_mut().insert(AUTHORIZATION, auth_header);
        }
    }

    Ok(request)
}

fn encode_pcm16_le_base64(pcm16: &[i16]) -> String {
    let mut bytes = Vec::with_capacity(pcm16.len() * 2);
    for &s in pcm16 {
        bytes.extend_from_slice(&s.to_le_bytes());
    }
    base64::engine::general_purpose::STANDARD.encode(&bytes)
}

fn normalize_flat_realtime_tools(tools: &[Value]) -> Vec<Value> {
    tools
        .iter()
        .filter_map(|tool| {
            if let Some(func) = tool.get("function").filter(|v| v.is_object()) {
                let name = func.get("name")?.as_str()?.trim();
                if name.is_empty() {
                    return None;
                }
                let mut obj = serde_json::Map::new();
                obj.insert("type".to_string(), json!("function"));
                obj.insert("name".to_string(), json!(name));
                if let Some(desc) = func.get("description") {
                    obj.insert("description".to_string(), desc.clone());
                }
                if let Some(params) = func.get("parameters") {
                    obj.insert("parameters".to_string(), params.clone());
                }
                Some(Value::Object(obj))
            } else {
                Some(tool.clone())
            }
        })
        .collect()
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
            "input_audio_transcription": {
                "language_hint": "es"
            },
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

pub fn build_openai_session_update_event(
    voice: &str,
    instructions: &str,
    tools: &[Value],
    prefix_padding_ms: u32,
    silence_duration_ms: u32,
) -> Value {
    let clean_voice = voice.trim();
    let resolved_voice = if clean_voice.is_empty() {
        "alloy"
    } else {
        clean_voice
    };
    let normalized_tools = normalize_flat_realtime_tools(tools);
    json!({
        "type": "session.update",
        "session": {
            "modalities": ["audio", "text"],
            "voice": resolved_voice,
            "instructions": instructions,
            "input_audio_format": "pcm16",
            "output_audio_format": "pcm16",
            "input_audio_transcription": {
                "model": "gpt-4o-mini-transcribe"
            },
            "turn_detection": {
                "type": "server_vad",
                "threshold": 0.5,
                "prefix_padding_ms": prefix_padding_ms,
                "silence_duration_ms": silence_duration_ms
            },
            "tools": normalized_tools
        }
    })
}

fn sanitize_gemini_schema(schema: &Value) -> Value {
    match schema {
        Value::Object(map) => {
            let mut clean = serde_json::Map::new();
            for (k, v) in map {
                if k == "$schema" || k == "additionalProperties" {
                    continue;
                }
                clean.insert(k.clone(), sanitize_gemini_schema(v));
            }
            Value::Object(clean)
        }
        Value::Array(items) => Value::Array(items.iter().map(sanitize_gemini_schema).collect()),
        other => other.clone(),
    }
}

fn normalize_gemini_function_declaration(tool: &Value) -> Option<Value> {
    let src = tool.get("function").filter(|v| v.is_object()).unwrap_or(tool);
    let name = src.get("name").and_then(|v| v.as_str())?.trim();
    if name.is_empty() {
        return None;
    }
    let mut decl = serde_json::Map::new();
    decl.insert("name".to_string(), json!(name));
    if let Some(desc) = src.get("description").and_then(|v| v.as_str()) {
        decl.insert("description".to_string(), json!(desc));
    }
    if let Some(params) = src.get("parameters").filter(|v| v.is_object()) {
        decl.insert("parameters".to_string(), sanitize_gemini_schema(params));
    }
    Some(Value::Object(decl))
}

pub fn build_gemini_live_setup_event(
    model: &str,
    voice: &str,
    instructions: &str,
    tools: &[Value],
    prefix_padding_ms: u32,
    silence_duration_ms: u32,
) -> Value {
    let trimmed_model = model.trim();
    let resolved_model = if trimmed_model.is_empty() {
        DEFAULT_GEMINI_LIVE_MODEL.to_string()
    } else if trimmed_model.starts_with("models/") || trimmed_model.starts_with("projects/") {
        trimmed_model.to_string()
    } else {
        format!("models/{trimmed_model}")
    };

    let resolved_voice = if voice.trim().is_empty() {
        "Aoede"
    } else {
        voice.trim()
    };

    let function_declarations: Vec<Value> = tools
        .iter()
        .filter_map(normalize_gemini_function_declaration)
        .collect();

    let mut setup_map = serde_json::Map::new();
    setup_map.insert("model".to_string(), json!(resolved_model));
    setup_map.insert(
        "generationConfig".to_string(),
        json!({
            "responseModalities": ["AUDIO"],
            "speechConfig": {
                "voiceConfig": {
                    "prebuiltVoiceConfig": {
                        "voiceName": resolved_voice
                    }
                }
            }
        }),
    );
    setup_map.insert(
        "systemInstruction".to_string(),
        json!({
            "parts": [{ "text": instructions }]
        }),
    );
    if !function_declarations.is_empty() {
        setup_map.insert(
            "tools".to_string(),
            json!([{ "functionDeclarations": function_declarations }]),
        );
    }
    setup_map.insert(
        "realtimeInputConfig".to_string(),
        json!({
            "automaticActivityDetection": {
                "disabled": false,
                "prefixPaddingMs": prefix_padding_ms,
                "silenceDurationMs": silence_duration_ms
            }
        }),
    );
    setup_map.insert("inputAudioTranscription".to_string(), json!({}));
    setup_map.insert("outputAudioTranscription".to_string(), json!({}));

    json!({
        "setup": Value::Object(setup_map)
    })
}

pub fn build_audio_append_event(pcm16: &[i16]) -> Value {
    let b64 = encode_pcm16_le_base64(pcm16);
    json!({
        "type": "input_audio_buffer.append",
        "audio": b64
    })
}

pub fn build_gemini_audio_input_base64_event(pcm_base64: &str) -> Value {
    json!({
        "realtimeInput": {
            "audio": {
                "mimeType": "audio/pcm;rate=16000",
                "data": pcm_base64
            }
        }
    })
}

pub fn build_gemini_audio_input_event(pcm16: &[i16]) -> Value {
    let b64 = encode_pcm16_le_base64(pcm16);
    build_gemini_audio_input_base64_event(&b64)
}

pub fn build_provider_audio_input_event(provider: RealtimeProviderKind, pcm16: &[i16]) -> Value {
    match provider {
        RealtimeProviderKind::GeminiLive => build_gemini_audio_input_event(pcm16),
        RealtimeProviderKind::Xai | RealtimeProviderKind::OpenAi => build_audio_append_event(pcm16),
    }
}

pub fn build_provider_audio_base64_event(
    provider: RealtimeProviderKind,
    pcm_base64: &str,
) -> Value {
    match provider {
        RealtimeProviderKind::GeminiLive => build_gemini_audio_input_base64_event(pcm_base64),
        RealtimeProviderKind::Xai | RealtimeProviderKind::OpenAi => json!({
            "type": "input_audio_buffer.append",
            "audio": pcm_base64
        }),
    }
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

pub fn build_gemini_tool_response_event(call_id: &str, name: &str, output_json: &str) -> Value {
    let response_obj = match serde_json::from_str::<Value>(output_json) {
        Ok(Value::Object(map)) => Value::Object(map),
        Ok(other) => json!({ "result": other }),
        Err(_) => json!({ "result": output_json }),
    };

    json!({
        "toolResponse": {
            "functionResponses": [{
                "id": call_id,
                "name": name,
                "response": response_obj
            }]
        }
    })
}

pub fn build_mute_silence_flush_frames(provider: RealtimeProviderKind) -> Vec<Value> {
    let sample_rate = provider.capture_sample_rate();
    let chunk_samples = ((sample_rate as usize) * (MUTE_FLUSH_CHUNK_MS as usize)) / 1000;
    let zeros = vec![0i16; chunk_samples];
    (0..MUTE_FLUSH_CHUNKS)
        .map(|_| build_provider_audio_input_event(provider, &zeros))
        .collect()
}

fn apply_mute_toggle(
    muted_flag: &AtomicBool,
    provider: RealtimeProviderKind,
    outbound_tx: &mpsc::UnboundedSender<String>,
    next_muted: bool,
) -> (bool, usize, u32) {
    let was_muted = muted_flag.swap(next_muted, Ordering::SeqCst);
    if !was_muted && next_muted {
        let frames = build_mute_silence_flush_frames(provider);
        let mut sent = 0usize;
        let mut all_ok = true;
        for frame in frames {
            if outbound_tx.send(frame.to_string()).is_ok() {
                sent += 1;
            } else {
                all_ok = false;
                break;
            }
        }
        return (all_ok, sent, sent as u32 * MUTE_FLUSH_CHUNK_MS);
    }
    (true, 0, 0)
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedRealtimeEvent {
    pub event_name: &'static str,
    pub payload: Value,
}

#[derive(Debug, Default)]
pub struct GeminiServerParseResult {
    pub events: Vec<ParsedRealtimeEvent>,
    pub tool_calls: Vec<(String, String)>,
    pub cancelled_tool_ids: Vec<String>,
}

fn parse_pcm_sample_rate_from_mime(mime: &str) -> u32 {
    for part in mime.split(';') {
        let trimmed = part.trim();
        if let Some(rate_str) = trimmed.strip_prefix("rate=") {
            if let Ok(rate) = rate_str.trim().parse::<u32>() {
                if rate >= 8000 {
                    return rate;
                }
            }
        }
    }
    REALTIME_SAMPLE_RATE
}

pub fn parse_gemini_server_message(parsed: &Value) -> GeminiServerParseResult {
    let mut result = GeminiServerParseResult::default();

    if parsed.get("setupComplete").is_some() {
        result.events.push(ParsedRealtimeEvent {
            event_name: "voice:realtime-status",
            payload: json!({
                "ok": true,
                "connected": true,
                "provider": RealtimeProviderKind::GeminiLive.as_str(),
                "setupComplete": true
            }),
        });
    }

    if let Some(sc) = parsed.get("serverContent") {
        if sc.get("interrupted").and_then(|v| v.as_bool()) == Some(true) {
            result.events.push(ParsedRealtimeEvent {
                event_name: "voice:realtime-clear-audio",
                payload: json!({
                    "provider": RealtimeProviderKind::GeminiLive.as_str(),
                    "reason": "interrupted"
                }),
            });
        }

        if let Some(parts) = sc.pointer("/modelTurn/parts").and_then(|v| v.as_array()) {
            for part in parts {
                if let Some(inline) = part.get("inlineData") {
                    let mime = inline
                        .get("mimeType")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let data = inline.get("data").and_then(|v| v.as_str()).unwrap_or("");
                    if !data.is_empty() && (mime.is_empty() || mime.starts_with("audio/")) {
                        let sample_rate = parse_pcm_sample_rate_from_mime(mime);
                        result.events.push(ParsedRealtimeEvent {
                            event_name: "voice:realtime-audio-delta",
                            payload: json!({
                                "delta": data,
                                "sampleRate": sample_rate
                            }),
                        });
                    }
                }
            }
        }

        if let Some(in_tr) = sc.get("inputTranscription") {
            let text = in_tr.get("text").and_then(|v| v.as_str()).unwrap_or("");
            let finished = in_tr
                .get("finished")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if !text.is_empty() || finished {
                result.events.push(ParsedRealtimeEvent {
                    event_name: "voice:realtime-user-speech",
                    payload: json!({
                        "text": text,
                        "interim": !finished,
                        "delta": !finished
                    }),
                });
            }
        }

        if let Some(out_tr) = sc.get("outputTranscription") {
            if let Some(text) = out_tr
                .get("text")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
            {
                result.events.push(ParsedRealtimeEvent {
                    event_name: "voice:realtime-transcript",
                    payload: json!({
                        "type": "response.audio_transcript.delta",
                        "delta": text
                    }),
                });
            }
        }

        if sc.get("turnComplete").and_then(|v| v.as_bool()) == Some(true) {
            result.events.push(ParsedRealtimeEvent {
                event_name: "voice:realtime-transcript",
                payload: json!({
                    "type": "response.audio_transcript.done"
                }),
            });
        }
    }

    if let Some(calls) = parsed
        .pointer("/toolCall/functionCalls")
        .and_then(|v| v.as_array())
    {
        for call in calls {
            let id = call.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let name = call.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let args = call.get("args").cloned().unwrap_or_else(|| json!({}));
            if !id.is_empty() && !name.is_empty() {
                result.tool_calls.push((id.to_string(), name.to_string()));
                result.events.push(ParsedRealtimeEvent {
                    event_name: "voice:realtime-tool-call",
                    payload: json!({
                        "call_id": id,
                        "name": name,
                        "arguments": args
                    }),
                });
            }
        }
    }

    if let Some(ids) = parsed
        .pointer("/toolCallCancellation/ids")
        .and_then(|v| v.as_array())
    {
        for id in ids.iter().filter_map(|v| v.as_str()) {
            result.cancelled_tool_ids.push(id.to_string());
        }
    }

    if parsed.get("error").is_some() {
        let safe_err = redact_realtime_error(&parsed.to_string());
        result.events.push(ParsedRealtimeEvent {
            event_name: "voice:realtime-status",
            payload: json!({ "ok": false, "error": safe_err }),
        });
    }

    result
}

#[derive(Debug, Default)]
pub struct OpenAiXaiServerParseResult {
    pub events: Vec<ParsedRealtimeEvent>,
    pub created_item_id: Option<String>,
    pub tool_call: Option<(String, String)>,
}

pub fn parse_openai_xai_server_message(
    provider: RealtimeProviderKind,
    parsed: &Value,
) -> OpenAiXaiServerParseResult {
    let mut result = OpenAiXaiServerParseResult::default();
    let ev_type = parsed.get("type").and_then(|v| v.as_str()).unwrap_or("");

    if ev_type == "conversation.item.created" {
        if let Some(item_id) = parsed.pointer("/item/id").and_then(|v| v.as_str()) {
            result.created_item_id = Some(item_id.to_string());
        }
    }

    match ev_type {
        "response.audio.delta" | "response.output_audio.delta" => {
            result.events.push(ParsedRealtimeEvent {
                event_name: "voice:realtime-audio-delta",
                payload: parsed.clone(),
            });
        }
        "response.function_call_arguments.done" => {
            let call_id = parsed
                .get("call_id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let name = parsed
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if !call_id.is_empty() && !name.is_empty() {
                result.tool_call = Some((call_id, name));
            }
            result.events.push(ParsedRealtimeEvent {
                event_name: "voice:realtime-tool-call",
                payload: parsed.clone(),
            });
        }
        "input_audio_buffer.speech_started" => {
            result.events.push(ParsedRealtimeEvent {
                event_name: "voice:realtime-clear-audio",
                payload: json!({
                    "provider": provider.as_str(),
                    "reason": "speech_started",
                    "item_id": parsed.get("item_id").cloned().unwrap_or(Value::Null)
                }),
            });
        }
        "conversation.item.input_audio_transcription.delta" => {
            let delta = parsed
                .get("delta")
                .or_else(|| parsed.get("transcript"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if !delta.is_empty() {
                result.events.push(ParsedRealtimeEvent {
                    event_name: "voice:realtime-user-speech",
                    payload: json!({
                        "text": delta,
                        "interim": true,
                        "delta": true
                    }),
                });
            }
        }
        "conversation.item.input_audio_transcription.updated" => {
            let transcript = parsed
                .get("transcript")
                .or_else(|| parsed.get("text"))
                .or_else(|| parsed.get("delta"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if !transcript.is_empty() {
                result.events.push(ParsedRealtimeEvent {
                    event_name: "voice:realtime-user-speech",
                    payload: json!({
                        "text": transcript,
                        "interim": true,
                        "delta": false
                    }),
                });
            }
        }
        "conversation.item.input_audio_transcription.completed" => {
            let transcript = parsed
                .get("transcript")
                .or_else(|| parsed.get("text"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            result.events.push(ParsedRealtimeEvent {
                event_name: "voice:realtime-user-speech",
                payload: json!({
                    "text": transcript,
                    "interim": false,
                    "delta": false
                }),
            });
            result.events.push(ParsedRealtimeEvent {
                event_name: "voice:realtime-transcript",
                payload: parsed.clone(),
            });
        }
        "response.audio_transcript.delta"
        | "response.audio_transcript.done"
        | "response.output_audio_transcript.delta"
        | "response.output_audio_transcript.done" => {
            result.events.push(ParsedRealtimeEvent {
                event_name: "voice:realtime-transcript",
                payload: parsed.clone(),
            });
        }
        "error" => {
            let safe_err = redact_realtime_error(&parsed.to_string());
            result.events.push(ParsedRealtimeEvent {
                event_name: "voice:realtime-status",
                payload: json!({ "ok": false, "error": safe_err }),
            });
        }
        _ => {}
    }

    result
}

pub fn get_realtime_status() -> RealtimeStatus {
    let slot = session_slot().lock().unwrap();
    if let Some(handle) = slot.as_ref() {
        let tracked = handle.item_tracker.lock().map(|t| t.len()).unwrap_or(0);
        let muted = handle.muted.load(Ordering::Relaxed);
        RealtimeStatus {
            connected: true,
            endpoint: Some(handle.endpoint.clone()),
            provider: Some(handle.provider.as_str().to_string()),
            sample_rate: handle.provider.output_sample_rate(),
            tracked_items: tracked,
            muted,
        }
    } else {
        RealtimeStatus {
            connected: false,
            endpoint: None,
            provider: None,
            sample_rate: REALTIME_SAMPLE_RATE,
            tracked_items: 0,
            muted: false,
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

fn disconnect_realtime_if_session(expected_session_id: u64) {
    let handle = {
        let mut slot = session_slot().lock().unwrap();
        let should_take = slot
            .as_ref()
            .map(|h| h.session_id == expected_session_id)
            .unwrap_or(false);
        if should_take {
            slot.take()
        } else {
            None
        }
    };
    if let Some(h) = handle {
        let _ = h.stop_tx.send(true);
        crate::voice_audio::capture::stop_capture();
    }
}

fn record_pending_tool_call(session_id: u64, call_id: &str, name: &str) {
    let slot = session_slot().lock().unwrap();
    if let Some(handle) = slot.as_ref().filter(|h| h.session_id == session_id) {
        if let Ok(mut pending) = handle.pending_tool_calls.lock() {
            if pending.len() >= MAX_PENDING_TOOL_CALLS {
                if let Some(oldest_key) = pending.keys().next().cloned() {
                    pending.remove(&oldest_key);
                }
            }
            pending.insert(call_id.to_string(), name.to_string());
        }
    }
}

fn remove_pending_tool_calls(session_id: u64, call_ids: &[String]) {
    if call_ids.is_empty() {
        return;
    }
    let slot = session_slot().lock().unwrap();
    if let Some(handle) = slot.as_ref().filter(|h| h.session_id == session_id) {
        if let Ok(mut pending) = handle.pending_tool_calls.lock() {
            for id in call_ids {
                pending.remove(id);
            }
        }
    }
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
    provider: Option<String>,
    api_key: Option<String>,
    model: Option<String>,
) -> Value {
    disconnect_realtime();

    let provider_kind = resolve_provider_kind(provider.as_deref(), endpoint.as_deref());
    let resolved_key = resolve_realtime_api_key(provider_kind, api_key.as_deref());

    if resolved_key.is_empty() {
        return json!({
            "ok": false,
            "connected": false,
            "fallbackToCascaded": true,
            "provider": provider_kind.as_str(),
            "reason": "missing_credentials"
        });
    }

    let mut target_endpoint = endpoint
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| default_endpoint_for_provider(provider_kind, model.as_deref()));

    if provider_kind == RealtimeProviderKind::OpenAi && !target_endpoint.contains("model=") {
        if let Some(m) = model.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            let sep = if target_endpoint.contains('?') { '&' } else { '?' };
            target_endpoint = format!("{target_endpoint}{sep}model={m}");
        }
    }

    let request = match build_realtime_ws_request(provider_kind, &target_endpoint, &resolved_key) {
        Ok(req) => req,
        Err(reason) => {
            return json!({
                "ok": false,
                "connected": false,
                "fallbackToCascaded": true,
                "provider": provider_kind.as_str(),
                "reason": reason
            });
        }
    };

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
                "provider": provider_kind.as_str(),
                "reason": redact_realtime_error(&err.to_string())
            });
        }
        Err(_) => {
            return json!({
                "ok": false,
                "connected": false,
                "fallbackToCascaded": true,
                "provider": provider_kind.as_str(),
                "reason": "realtime_connect_timeout"
            });
        }
    };

    let capture_sample_rate = provider_kind.capture_sample_rate();
    let mut capture_rx = match crate::voice_audio::capture::start_capture(device_id, capture_sample_rate) {
        Ok(rx) => rx,
        Err(err) => {
            let mut ws_stream = ws_stream;
            let _ = tokio::time::timeout(Duration::from_millis(400), ws_stream.close(None)).await;
            return json!({
                "ok": false,
                "connected": false,
                "fallbackToCascaded": true,
                "provider": provider_kind.as_str(),
                "reason": err
            });
        }
    };

    let (outbound_tx, mut outbound_rx) = mpsc::unbounded_channel::<String>();
    let (stop_tx, mut stop_rx) = tokio::sync::watch::channel(false);

    let default_voice = match provider_kind {
        RealtimeProviderKind::GeminiLive => "Aoede",
        RealtimeProviderKind::OpenAi => "alloy",
        RealtimeProviderKind::Xai => "Ara",
    };
    let raw_voice = voice.as_deref().map(str::trim).unwrap_or("");
    let resolved_voice = if raw_voice.is_empty()
        || (provider_kind != RealtimeProviderKind::Xai && raw_voice.eq_ignore_ascii_case("Ara"))
    {
        default_voice
    } else {
        raw_voice
    };

    let initial_setup = match provider_kind {
        RealtimeProviderKind::GeminiLive => build_gemini_live_setup_event(
            model.as_deref().unwrap_or(DEFAULT_GEMINI_LIVE_MODEL),
            resolved_voice,
            instructions.as_deref().unwrap_or(""),
            tools.as_deref().unwrap_or(&[]),
            prefix_padding_ms.unwrap_or(300),
            silence_duration_ms.unwrap_or(500),
        ),
        RealtimeProviderKind::OpenAi => build_openai_session_update_event(
            resolved_voice,
            instructions.as_deref().unwrap_or(""),
            tools.as_deref().unwrap_or(&[]),
            prefix_padding_ms.unwrap_or(300),
            silence_duration_ms.unwrap_or(500),
        ),
        RealtimeProviderKind::Xai => build_session_update_event(
            resolved_voice,
            instructions.as_deref().unwrap_or(""),
            tools.as_deref().unwrap_or(&[]),
            prefix_padding_ms.unwrap_or(300),
            silence_duration_ms.unwrap_or(500),
        ),
    };
    let _ = outbound_tx.send(initial_setup.to_string());

    let session_id = NEXT_SESSION_ID.fetch_add(1, Ordering::Relaxed);
    let muted_flag = Arc::new(AtomicBool::new(false));
    let loop_muted = Arc::clone(&muted_flag);

    {
        let mut slot = session_slot().lock().unwrap();
        *slot = Some(RealtimeHandle {
            session_id,
            endpoint: target_endpoint.clone(),
            provider: provider_kind,
            input_sample_rate: capture_sample_rate,
            muted: muted_flag,
            outbound_tx: outbound_tx.clone(),
            item_tracker: Mutex::new(MidWorkItemTracker::new(MAX_MID_WORK_ITEMS)),
            pending_tool_calls: Mutex::new(HashMap::new()),
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
                    match pcm_frame {
                        Ok(pcm) => {
                            if !loop_muted.load(Ordering::Relaxed) && !pcm.is_empty() {
                                let ev = build_provider_audio_input_event(provider_kind, &pcm);
                                if write.send(Message::Text(ev.to_string())).await.is_err() {
                                    break;
                                }
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
                incoming = read.next() => {
                    let frame_text = match incoming {
                        Some(Ok(Message::Text(txt))) => Some(txt),
                        Some(Ok(Message::Binary(bytes))) => String::from_utf8(bytes).ok(),
                        Some(Ok(Message::Close(_))) | None => break,
                        Some(Err(_)) => break,
                        _ => None,
                    };

                    if let Some(txt) = frame_text {
                        if let Ok(parsed) = serde_json::from_str::<Value>(&txt) {
                            match provider_kind {
                                RealtimeProviderKind::GeminiLive => {
                                    let res = parse_gemini_server_message(&parsed);
                                    for (call_id, name) in &res.tool_calls {
                                        record_pending_tool_call(session_id, call_id, name);
                                    }
                                    remove_pending_tool_calls(session_id, &res.cancelled_tool_ids);
                                    if let Some(handle) = crate::get_app_handle() {
                                        for ev in res.events {
                                            let _ = handle.emit(ev.event_name, &ev.payload);
                                        }
                                    }
                                }
                                RealtimeProviderKind::Xai | RealtimeProviderKind::OpenAi => {
                                    let res = parse_openai_xai_server_message(provider_kind, &parsed);
                                    if let Some(item_id) = res.created_item_id.as_deref() {
                                        let deletions = {
                                            let slot = session_slot().lock().unwrap();
                                            slot.as_ref()
                                                .filter(|h| h.session_id == session_id)
                                                .and_then(|h| {
                                                    h.item_tracker
                                                        .lock()
                                                        .ok()
                                                        .map(|mut t| t.record(item_id))
                                                })
                                                .unwrap_or_default()
                                        };
                                        for del in deletions {
                                            let _ = outbound_tx.send(del.to_string());
                                        }
                                    }
                                    if let Some((call_id, name)) = res.tool_call {
                                        record_pending_tool_call(session_id, &call_id, &name);
                                    }
                                    if let Some(handle) = crate::get_app_handle() {
                                        for ev in res.events {
                                            let _ = handle.emit(ev.event_name, &ev.payload);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        disconnect_realtime_if_session(session_id);
    });

    json!({
        "ok": true,
        "connected": true,
        "endpoint": target_endpoint,
        "provider": provider_kind.as_str(),
        "sampleRate": REALTIME_SAMPLE_RATE,
        "inputSampleRate": capture_sample_rate
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
        if handle.muted.load(Ordering::Relaxed) {
            return json!({ "ok": true, "muted": true });
        }
        let msg = build_provider_audio_base64_event(handle.provider, &pcm_base64).to_string();
        let ok = handle.outbound_tx.send(msg).is_ok();
        return json!({ "ok": ok });
    }
    json!({ "ok": false, "error": "Realtime session not connected" })
}

#[tauri::command]
pub async fn voice_realtime_truncate(item_id: String, audio_end_ms: u64) -> Value {
    let slot = session_slot().lock().unwrap();
    if let Some(handle) = slot.as_ref() {
        if handle.provider == RealtimeProviderKind::GeminiLive {
            return json!({
                "ok": true,
                "itemId": item_id,
                "audioEndMs": audio_end_ms,
                "ignored": "gemini_server_vad"
            });
        }
        let ev = build_truncate_event(&item_id, audio_end_ms);
        let ok = handle.outbound_tx.send(ev.to_string()).is_ok();
        return json!({ "ok": ok, "itemId": item_id, "audioEndMs": audio_end_ms });
    }
    json!({ "ok": false, "error": "Realtime session not connected" })
}

#[tauri::command]
pub async fn voice_realtime_submit_tool_result(
    call_id: String,
    output_json: String,
    tool_name: Option<String>,
) -> Value {
    let slot = session_slot().lock().unwrap();
    if let Some(handle) = slot.as_ref() {
        let tracked_name = handle
            .pending_tool_calls
            .lock()
            .ok()
            .and_then(|mut map| map.remove(&call_id));
        let resolved_name = tool_name
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .or(tracked_name)
            .unwrap_or_else(|| "tool".to_string());

        return match handle.provider {
            RealtimeProviderKind::GeminiLive => {
                let resp_ev =
                    build_gemini_tool_response_event(&call_id, &resolved_name, &output_json);
                let ok = handle.outbound_tx.send(resp_ev.to_string()).is_ok();
                json!({ "ok": ok, "callId": call_id, "toolName": resolved_name })
            }
            RealtimeProviderKind::Xai | RealtimeProviderKind::OpenAi => {
                let (item_ev, resp_ev) = build_tool_output_events(&call_id, &output_json);
                let ok1 = handle.outbound_tx.send(item_ev.to_string()).is_ok();
                let ok2 = handle.outbound_tx.send(resp_ev.to_string()).is_ok();
                json!({ "ok": ok1 && ok2, "callId": call_id })
            }
        };
    }
    json!({ "ok": false, "error": "Realtime session not connected" })
}

#[tauri::command]
pub async fn voice_realtime_status() -> RealtimeStatus {
    get_realtime_status()
}

#[tauri::command]
pub async fn voice_realtime_set_muted(muted: bool) -> Value {
    let outcome = {
        let slot = session_slot().lock().unwrap();
        slot.as_ref().map(|handle| {
            let (ok, chunks_sent, flushed_ms) = apply_mute_toggle(
                &handle.muted,
                handle.provider,
                &handle.outbound_tx,
                muted,
            );
            (ok, chunks_sent, flushed_ms, handle.input_sample_rate)
        })
    };

    tauri::async_runtime::spawn_blocking(move || {
        crate::voice_audio::capture::set_capture_muted(muted);
    })
    .await
    .ok();

    match outcome {
        Some((ok, chunks_sent, flushed_ms, sample_rate)) => json!({
            "ok": ok,
            "muted": muted,
            "chunksSent": chunks_sent,
            "flushedMs": flushed_ms,
            "sampleRate": sample_rate
        }),
        None => json!({
            "ok": false,
            "muted": muted,
            "chunksSent": 0,
            "flushedMs": 0,
            "error": "Realtime session not connected"
        }),
    }
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
        assert_eq!(
            session_ev["session"]["turn_detection"]["prefix_padding_ms"],
            300
        );

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

    #[test]
    fn resolves_providers_sample_rates_endpoints_and_credentials_priority() {
        assert_eq!(
            resolve_provider_kind(Some("gemini_live"), None),
            RealtimeProviderKind::GeminiLive
        );
        assert_eq!(
            resolve_provider_kind(Some("openai"), None),
            RealtimeProviderKind::OpenAi
        );
        assert_eq!(
            resolve_provider_kind(Some("xai"), None),
            RealtimeProviderKind::Xai
        );
        assert_eq!(
            resolve_provider_kind(None, Some(DEFAULT_GEMINI_LIVE_ENDPOINT)),
            RealtimeProviderKind::GeminiLive
        );
        assert_eq!(
            resolve_provider_kind(None, Some(DEFAULT_OPENAI_REALTIME_ENDPOINT)),
            RealtimeProviderKind::OpenAi
        );
        assert_eq!(
            resolve_provider_kind(None, Some(DEFAULT_REALTIME_ENDPOINT)),
            RealtimeProviderKind::Xai
        );

        assert_eq!(RealtimeProviderKind::GeminiLive.capture_sample_rate(), 16000);
        assert_eq!(RealtimeProviderKind::GeminiLive.output_sample_rate(), 24000);
        assert_eq!(RealtimeProviderKind::Xai.capture_sample_rate(), 24000);
        assert_eq!(RealtimeProviderKind::OpenAi.capture_sample_rate(), 24000);

        let vault = |key: &str| -> Option<String> {
            match key {
                "gemini" => Some("AIza-from-gemini".to_string()),
                "google_ai" => Some("AIza-from-google-ai".to_string()),
                "openai" => Some("sk-from-openai".to_string()),
                "grok" => Some("xai-from-grok".to_string()),
                _ => None,
            }
        };
        assert_eq!(
            resolve_realtime_api_key_with(
                RealtimeProviderKind::GeminiLive,
                Some("  AIza-explicit  "),
                &vault
            ),
            "AIza-explicit"
        );
        assert_eq!(
            resolve_realtime_api_key_with(RealtimeProviderKind::GeminiLive, None, &vault),
            "AIza-from-gemini"
        );
        assert_eq!(
            resolve_realtime_api_key_with(RealtimeProviderKind::OpenAi, None, &vault),
            "sk-from-openai"
        );
        assert_eq!(
            resolve_realtime_api_key_with(RealtimeProviderKind::Xai, None, &vault),
            "xai-from-grok"
        );
    }

    #[test]
    fn builds_provider_ws_requests_and_openai_session_update() {
        let gem_req = build_realtime_ws_request(
            RealtimeProviderKind::GeminiLive,
            DEFAULT_GEMINI_LIVE_ENDPOINT,
            "AIzaTestSecret123",
        )
        .expect("gemini ws request");
        assert!(gem_req
            .uri()
            .to_string()
            .contains("?key=AIzaTestSecret123"));
        assert!(gem_req.headers().get(AUTHORIZATION).is_none());

        let oai_req = build_realtime_ws_request(
            RealtimeProviderKind::OpenAi,
            DEFAULT_OPENAI_REALTIME_ENDPOINT,
            "sk-test-123",
        )
        .expect("openai ws request");
        assert_eq!(
            oai_req.headers().get(AUTHORIZATION).unwrap().to_str().unwrap(),
            "Bearer sk-test-123"
        );
        assert_eq!(
            oai_req
                .headers()
                .get("openai-beta")
                .unwrap()
                .to_str()
                .unwrap(),
            "realtime=v1"
        );

        let xai_req = build_realtime_ws_request(
            RealtimeProviderKind::Xai,
            DEFAULT_REALTIME_ENDPOINT,
            "xai-test-123",
        )
        .expect("xai ws request");
        assert_eq!(
            xai_req.headers().get(AUTHORIZATION).unwrap().to_str().unwrap(),
            "Bearer xai-test-123"
        );
        assert!(xai_req.headers().get("openai-beta").is_none());

        let oai_session = build_openai_session_update_event(
            "alloy",
            "Speak concisely.",
            &[json!({
                "type": "function",
                "function": {
                    "name": "call_thinker_agent",
                    "description": "Delegate heavy work",
                    "parameters": { "type": "object" }
                }
            })],
            250,
            450,
        );
        assert_eq!(oai_session["type"], "session.update");
        assert_eq!(oai_session["session"]["voice"], "alloy");
        assert!(oai_session["session"].get("sample_rate").is_none());
        assert_eq!(oai_session["session"]["tools"][0]["name"], "call_thinker_agent");
    }

    #[test]
    fn builds_gemini_live_setup_audio_and_tool_response_frames() {
        let tools = vec![
            json!({
                "type": "function",
                "name": "peek_changes",
                "description": "Inspect git changes",
                "parameters": {
                    "$schema": "http://json-schema.org/draft-07/schema#",
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                        "path": { "type": "string" }
                    }
                }
            }),
            json!({
                "function": {
                    "name": "call_thinker_agent",
                    "description": "Run coding task",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "goal": { "type": "string" }
                        },
                        "required": ["goal"]
                    }
                }
            }),
        ];

        let setup = build_gemini_live_setup_event(
            "",
            "Puck",
            "Be crisp and helpful.",
            &tools,
            300,
            500,
        );
        assert_eq!(setup["setup"]["model"], DEFAULT_GEMINI_LIVE_MODEL);
        assert_eq!(setup["setup"]["generationConfig"]["responseModalities"], json!(["AUDIO"]));
        assert_eq!(
            setup["setup"]["generationConfig"]["speechConfig"]["voiceConfig"]["prebuiltVoiceConfig"]
                ["voiceName"],
            "Puck"
        );
        assert_eq!(
            setup["setup"]["systemInstruction"]["parts"][0]["text"],
            "Be crisp and helpful."
        );
        let decls = setup["setup"]["tools"][0]["functionDeclarations"]
            .as_array()
            .expect("functionDeclarations array");
        assert_eq!(decls.len(), 2);
        assert_eq!(decls[0]["name"], "peek_changes");
        assert!(decls[0]["parameters"].get("$schema").is_none());
        assert!(decls[0]["parameters"].get("additionalProperties").is_none());
        assert_eq!(decls[1]["name"], "call_thinker_agent");
        assert_eq!(
            setup["setup"]["realtimeInputConfig"]["automaticActivityDetection"]["disabled"],
            false
        );
        assert_eq!(
            setup["setup"]["realtimeInputConfig"]["automaticActivityDetection"]["prefixPaddingMs"],
            300
        );
        assert_eq!(
            setup["setup"]["realtimeInputConfig"]["automaticActivityDetection"]["silenceDurationMs"],
            500
        );
        assert_eq!(setup["setup"]["inputAudioTranscription"], json!({}));
        assert_eq!(setup["setup"]["outputAudioTranscription"], json!({}));

        let audio_ev = build_gemini_audio_input_event(&[1000, -1000]);
        assert_eq!(
            audio_ev["realtimeInput"]["audio"]["mimeType"],
            "audio/pcm;rate=16000"
        );
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(audio_ev["realtimeInput"]["audio"]["data"].as_str().unwrap())
            .unwrap();
        assert_eq!(decoded.len(), 4);

        let tool_json = build_gemini_tool_response_event(
            "call-9",
            "call_thinker_agent",
            r#"{"accepted":true,"taskId":"t-1"}"#,
        );
        assert_eq!(tool_json["toolResponse"]["functionResponses"][0]["id"], "call-9");
        assert_eq!(
            tool_json["toolResponse"]["functionResponses"][0]["name"],
            "call_thinker_agent"
        );
        assert_eq!(
            tool_json["toolResponse"]["functionResponses"][0]["response"]["accepted"],
            true
        );

        let tool_plain = build_gemini_tool_response_event("call-10", "hang_up", "done");
        assert_eq!(
            tool_plain["toolResponse"]["functionResponses"][0]["response"]["result"],
            "done"
        );
    }

    #[test]
    fn parses_gemini_server_frames_audio_interrupted_transcriptions_and_tool_calls() {
        let setup_res = parse_gemini_server_message(&json!({ "setupComplete": {} }));
        assert_eq!(setup_res.events.len(), 1);
        assert_eq!(setup_res.events[0].event_name, "voice:realtime-status");
        assert_eq!(setup_res.events[0].payload["setupComplete"], true);

        let audio_res = parse_gemini_server_message(&json!({
            "serverContent": {
                "modelTurn": {
                    "parts": [{
                        "inlineData": {
                            "mimeType": "audio/pcm;rate=24000",
                            "data": "AQIDBA=="
                        }
                    }]
                },
                "outputTranscription": {
                    "text": "Hola, revisando."
                }
            }
        }));
        assert_eq!(audio_res.events.len(), 2);
        assert_eq!(audio_res.events[0].event_name, "voice:realtime-audio-delta");
        assert_eq!(audio_res.events[0].payload["delta"], "AQIDBA==");
        assert_eq!(audio_res.events[0].payload["sampleRate"], 24000);
        assert_eq!(audio_res.events[1].event_name, "voice:realtime-transcript");
        assert_eq!(
            audio_res.events[1].payload["type"],
            "response.audio_transcript.delta"
        );
        assert_eq!(audio_res.events[1].payload["delta"], "Hola, revisando.");

        let interrupted_res = parse_gemini_server_message(&json!({
            "serverContent": {
                "interrupted": true,
                "inputTranscription": {
                    "text": "para un segundo",
                    "finished": false
                }
            }
        }));
        assert_eq!(interrupted_res.events[0].event_name, "voice:realtime-clear-audio");
        assert_eq!(interrupted_res.events[1].event_name, "voice:realtime-user-speech");
        assert_eq!(interrupted_res.events[1].payload["text"], "para un segundo");
        assert_eq!(interrupted_res.events[1].payload["interim"], true);

        let turn_done_res = parse_gemini_server_message(&json!({
            "serverContent": {
                "turnComplete": true,
                "inputTranscription": {
                    "text": "para un segundo por favor",
                    "finished": true
                }
            }
        }));
        assert_eq!(turn_done_res.events[0].event_name, "voice:realtime-user-speech");
        assert_eq!(turn_done_res.events[0].payload["interim"], false);
        assert_eq!(turn_done_res.events[1].event_name, "voice:realtime-transcript");
        assert_eq!(
            turn_done_res.events[1].payload["type"],
            "response.audio_transcript.done"
        );

        let tool_res = parse_gemini_server_message(&json!({
            "toolCall": {
                "functionCalls": [{
                    "id": "gc-42",
                    "name": "call_thinker_agent",
                    "args": { "task": "Run cargo test" }
                }]
            }
        }));
        assert_eq!(tool_res.tool_calls, vec![("gc-42".to_string(), "call_thinker_agent".to_string())]);
        assert_eq!(tool_res.events[0].event_name, "voice:realtime-tool-call");
        assert_eq!(tool_res.events[0].payload["call_id"], "gc-42");
        assert_eq!(tool_res.events[0].payload["name"], "call_thinker_agent");
        assert_eq!(tool_res.events[0].payload["arguments"]["task"], "Run cargo test");
    }

    #[test]
    fn parses_openai_xai_speech_started_and_user_transcriptions() {
        let session_ev = build_session_update_event("Ara", "Instr", &[], 300, 500);
        assert_eq!(session_ev["session"]["input_audio_transcription"]["language_hint"], "es");

        let started = parse_openai_xai_server_message(
            RealtimeProviderKind::OpenAi,
            &json!({ "type": "input_audio_buffer.speech_started", "item_id": "itm-1" }),
        );
        assert_eq!(started.events[0].event_name, "voice:realtime-clear-audio");

        let delta = parse_openai_xai_server_message(
            RealtimeProviderKind::Xai,
            &json!({ "type": "conversation.item.input_audio_transcription.delta", "delta": "hola " }),
        );
        assert_eq!(delta.events[0].event_name, "voice:realtime-user-speech");
        assert_eq!(delta.events[0].payload["interim"], true);
        assert_eq!(delta.events[0].payload["delta"], true);
        assert_eq!(delta.events[0].payload["text"], "hola ");

        let updated = parse_openai_xai_server_message(
            RealtimeProviderKind::Xai,
            &json!({ "type": "conversation.item.input_audio_transcription.updated", "transcript": "hola argos" }),
        );
        assert_eq!(updated.events[0].event_name, "voice:realtime-user-speech");
        assert_eq!(updated.events[0].payload["interim"], true);
        assert_eq!(updated.events[0].payload["delta"], false);
        assert_eq!(updated.events[0].payload["text"], "hola argos");

        let done = parse_openai_xai_server_message(
            RealtimeProviderKind::Xai,
            &json!({ "type": "conversation.item.input_audio_transcription.completed", "transcript": "hola mundo" }),
        );
        assert_eq!(done.events.len(), 2);
        assert_eq!(done.events[0].event_name, "voice:realtime-user-speech");
        assert_eq!(done.events[0].payload["interim"], false);
        assert_eq!(done.events[0].payload["delta"], false);
        assert_eq!(done.events[0].payload["text"], "hola mundo");
        assert_eq!(done.events[1].event_name, "voice:realtime-transcript");

        let gem_interim = parse_gemini_server_message(&json!({
            "serverContent": {
                "inputTranscription": { "text": "abre un hilo", "finished": false }
            }
        }));
        assert_eq!(gem_interim.events[0].event_name, "voice:realtime-user-speech");
        assert_eq!(gem_interim.events[0].payload["interim"], true);
        assert_eq!(gem_interim.events[0].payload["delta"], true);
        assert_eq!(gem_interim.events[0].payload["text"], "abre un hilo");
    }

    #[test]
    fn redacts_aiza_query_key_bearer_xai_and_sk_tokens() {
        let gem_url_err = redact_realtime_error(
            "Handshake failed for wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=AIzaSyDummySecretKey987&alt=json",
        );
        assert!(!gem_url_err.contains("AIzaSyDummySecretKey987"));
        assert!(gem_url_err.contains("[REDACTED_SECRET]"));
        assert!(gem_url_err.contains("&alt=json"));

        let standalone = redact_realtime_error(
            "keys AIzaStandalone999 Bearer jwt.token.123 sk-proj-abc xai-token-xyz failed",
        );
        assert!(!standalone.contains("AIzaStandalone999"));
        assert!(!standalone.contains("jwt.token.123"));
        assert!(!standalone.contains("sk-proj-abc"));
        assert!(!standalone.contains("xai-token-xyz"));
        assert!(standalone.contains("[REDACTED_SECRET]"));
    }

    #[test]
    fn mute_flush_sends_500ms_zero_pcm_only_on_unmuted_to_muted_transition() {
        let gem_frames = build_mute_silence_flush_frames(RealtimeProviderKind::GeminiLive);
        assert_eq!(gem_frames.len(), 5);
        let mut gem_total_samples = 0usize;
        for frame in &gem_frames {
            assert_eq!(
                frame["realtimeInput"]["audio"]["mimeType"],
                "audio/pcm;rate=16000"
            );
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(frame["realtimeInput"]["audio"]["data"].as_str().unwrap())
                .unwrap();
            assert!(bytes.iter().all(|&b| b == 0));
            gem_total_samples += bytes.len() / 2;
        }
        assert_eq!(gem_total_samples, 8000); // 500 ms @ 16 kHz

        let xai_frames = build_mute_silence_flush_frames(RealtimeProviderKind::Xai);
        assert_eq!(xai_frames.len(), 5);
        let mut xai_total_samples = 0usize;
        for frame in &xai_frames {
            assert_eq!(frame["type"], "input_audio_buffer.append");
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(frame["audio"].as_str().unwrap())
                .unwrap();
            assert!(bytes.iter().all(|&b| b == 0));
            xai_total_samples += bytes.len() / 2;
        }
        assert_eq!(xai_total_samples, 12000); // 500 ms @ 24 kHz

        let muted_flag = AtomicBool::new(false);
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();

        // unmuted -> muted: sends 5 chunks (500ms)
        let (ok1, sent1, ms1) = apply_mute_toggle(&muted_flag, RealtimeProviderKind::Xai, &tx, true);
        assert!(ok1);
        assert_eq!(sent1, 5);
        assert_eq!(ms1, 500);
        for _ in 0..5 {
            assert!(rx.try_recv().is_ok());
        }
        assert!(rx.try_recv().is_err());

        // muted -> muted (idempotent): sends 0 chunks
        let (ok2, sent2, ms2) = apply_mute_toggle(&muted_flag, RealtimeProviderKind::Xai, &tx, true);
        assert!(ok2);
        assert_eq!(sent2, 0);
        assert_eq!(ms2, 0);

        // muted -> unmuted: sends 0 chunks
        let (ok3, sent3, ms3) =
            apply_mute_toggle(&muted_flag, RealtimeProviderKind::Xai, &tx, false);
        assert!(ok3);
        assert_eq!(sent3, 0);
        assert_eq!(ms3, 0);

        let status = get_realtime_status();
        assert!(!status.connected);
        assert!(!status.muted);
        assert_eq!(status.provider, None);
    }
}
