use crate::remote::auth::now_unix_ms;
use crate::remote::events::RemoteEventBus;
use crate::remote::rpc::{blocking, opt_str, req_str, RpcContext, RpcError};
use crate::voice_audio::resampler::encode_pcm16_wav;
use crate::voice_audio::stt_ws::{
    build_stt_ws_url, is_xai_streaming_stt_base_url, join_speech_partial, parse_stt_ws_frame,
    SttWsFrame,
};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::Emitter;
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::{HeaderValue, AUTHORIZATION};
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;

const MAX_AUDIO_BYTES: usize = 15 * 1024 * 1024;
const MAX_AUDIO_B64_LEN: usize = ((MAX_AUDIO_BYTES / 3) + 2) * 4;
const MAX_ACTIVE_STT_SESSIONS: usize = 4;
const STT_SESSION_TTL: Duration = Duration::from_secs(120);
const STT_WS_CHANNEL_CAPACITY: usize = 128;
const STT_MIN_FALLBACK_PCM_BYTES: usize = 1600;
const STT_STOP_AWAIT_TIMEOUT_MS: u64 = 1800;
const ARGOS_TIMEOUT_SECS: u64 = 45;
const DEFAULT_GROK_BASE_URL: &str = "https://api.x.ai/v1";
const DEFAULT_GROK_MODEL: &str = "grok-voice-transcribe-2.0";
const ELEVENLABS_VOICE: &str = "21m00Tcm4TlvDq8ikWAM";
const ELEVENLABS_MODEL: &str = "eleven_v4_turbo";
const DEFAULT_ELEVENLABS_STABILITY: f64 = 0.5;
const DEFAULT_ELEVENLABS_SIMILARITY: f64 = 0.8;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, PartialEq)]
pub struct DesktopVoiceSettings {
    pub grok_base_url: String,
    pub grok_model: String,
    pub offline_stt_engine: Option<String>,
    pub tts_engine: String,
    pub elevenlabs_voice_id: String,
    pub elevenlabs_model: String,
    pub elevenlabs_stability: f64,
    pub elevenlabs_similarity: f64,
}

impl Default for DesktopVoiceSettings {
    fn default() -> Self {
        Self {
            grok_base_url: DEFAULT_GROK_BASE_URL.to_string(),
            grok_model: DEFAULT_GROK_MODEL.to_string(),
            offline_stt_engine: None,
            tts_engine: "auto".to_string(),
            elevenlabs_voice_id: ELEVENLABS_VOICE.to_string(),
            elevenlabs_model: ELEVENLABS_MODEL.to_string(),
            elevenlabs_stability: DEFAULT_ELEVENLABS_STABILITY,
            elevenlabs_similarity: DEFAULT_ELEVENLABS_SIMILARITY,
        }
    }
}

impl DesktopVoiceSettings {
    pub fn from_json_str(raw: &str) -> Self {
        let mut out = Self::default();
        let Ok(val) = serde_json::from_str::<Value>(raw) else {
            return out;
        };
        if let Some(s) = val
            .get("grokTranscriptionBaseUrl")
            .or_else(|| val.get("grokBaseUrl"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            out.grok_base_url = s.to_string();
        }
        if let Some(s) = val
            .get("grokTranscriptionModel")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            out.grok_model = s.to_string();
        }
        out.offline_stt_engine = val
            .get("offlineSttEngine")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        if let Some(s) = val
            .get("ttsEngine")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            let norm = s.to_ascii_lowercase();
            out.tts_engine = match norm.as_str() {
                "elevenlabs" => "elevenlabs".to_string(),
                "web" | "browser" => "web".to_string(),
                "device" => "device".to_string(),
                "auto" => "auto".to_string(),
                _ => "auto".to_string(),
            };
        }
        if let Some(s) = val
            .get("elevenlabsVoiceId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            out.elevenlabs_voice_id = s.to_string();
        }
        if let Some(s) = val
            .get("elevenlabsModel")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            out.elevenlabs_model = s.to_string();
        }
        if let Some(v) = val
            .get("elevenlabsStability")
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite())
        {
            out.elevenlabs_stability = v.clamp(0.0, 1.0);
        }
        if let Some(v) = val
            .get("elevenlabsSimilarity")
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite())
        {
            out.elevenlabs_similarity = v.clamp(0.0, 1.0);
        }
        out
    }

    pub fn load() -> Self {
        crate::credentials::get_vault_credential("operator_settings_json")
            .as_deref()
            .map(Self::from_json_str)
            .unwrap_or_default()
    }

    pub fn default_tts_provider(&self) -> &'static str {
        match self.tts_engine.to_ascii_lowercase().as_str() {
            "elevenlabs" => "elevenlabs",
            "web" | "browser" | "device" => "device",
            _ => "auto",
        }
    }

    pub fn effective_grok_model(&self) -> &str {
        let model = self.grok_model.trim();
        if is_xai_base_url(&self.grok_base_url)
            && (model.is_empty() || model == "whisper-large-v3")
        {
            DEFAULT_GROK_MODEL
        } else if model.is_empty() {
            DEFAULT_GROK_MODEL
        } else {
            model
        }
    }
}

fn is_xai_base_url(base_url: &str) -> bool {
    let lower = base_url.trim().to_ascii_lowercase();
    lower.is_empty()
        || lower.contains("api.x.ai")
        || (!lower.contains("openai.com") && !lower.contains("groq.com"))
}

pub fn grok_stt_endpoints(base_url: &str) -> (String, Option<String>) {
    let trimmed = base_url.trim().trim_end_matches('/');
    let base = if trimmed.is_empty() {
        DEFAULT_GROK_BASE_URL
    } else {
        trimmed
    };
    let lower = base.to_ascii_lowercase();
    if lower.contains("openai.com") || lower.contains("groq.com") {
        let primary = if base.ends_with("/audio/transcriptions") {
            base.to_string()
        } else {
            format!("{base}/audio/transcriptions")
        };
        return (primary, None);
    }

    if base.ends_with("/audio/transcriptions") {
        (base.to_string(), None)
    } else if base.ends_with("/stt") {
        let root = base.trim_end_matches("/stt");
        (base.to_string(), Some(format!("{root}/audio/transcriptions")))
    } else {
        (format!("{base}/stt"), Some(format!("{base}/audio/transcriptions")))
    }
}

fn truncate_snippet(raw: &str, max_chars: usize) -> String {
    let compact: String = raw
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max_chars)
        .collect();
    compact.trim().to_string()
}

fn extract_stt_transcript(body: &Value) -> String {
    if let Some(text) = body.get("text").and_then(Value::as_str) {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    if let Some(res) = body.get("result") {
        if let Some(text) = res.as_str() {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
        if let Some(text) = res.get("text").and_then(Value::as_str) {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    String::new()
}

pub fn normalize_stt_provider(raw: Option<&str>) -> Result<&'static str, RpcError> {
    match raw
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        None | Some("auto") => Ok("auto"),
        Some("grok") => Ok("grok"),
        Some("openai") => Ok("openai"),
        Some("offline") => Ok("offline"),
        Some(other) => Err(RpcError::invalid_params(format!(
            "Unsupported sttProvider '{other}'. Expected 'auto', 'grok', 'openai', or 'offline'."
        ))),
    }
}

pub fn normalize_tts_provider(raw: Option<&str>) -> Result<&'static str, RpcError> {
    match raw
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        None | Some("auto") => Ok("auto"),
        Some("elevenlabs") => Ok("elevenlabs"),
        Some("device") => Ok("device"),
        Some(other) => Err(RpcError::invalid_params(format!(
            "Unsupported ttsProvider '{other}'. Expected 'auto', 'elevenlabs', or 'device'."
        ))),
    }
}

pub fn has_grok_stt_key() -> bool {
    resolve_grok_stt_key().is_some()
}

pub fn has_openai_stt_key() -> bool {
    resolve_openai_stt_key().is_some()
}

pub async fn handle_voice(ctx: &RpcContext, method: &str, params: Value) -> Result<Value, RpcError> {
    match method {
        "voice.transcribe" => {
            let b64 = req_str(&params, "audioBase64")?;
            let (text, backend, duration_ms) = transcribe_audio_base64(
                &b64,
                opt_str(&params, "mimeType").as_deref(),
                opt_str(&params, "language").as_deref(),
                opt_str(&params, "sttProvider").as_deref(),
            )
            .await?;
            Ok(json!({ "text": text, "backend": backend, "durationMs": duration_ms }))
        }
        "voice.stt.start" => handle_stt_start(ctx, params).await,
        "voice.stt.chunk" => handle_stt_chunk(params).await,
        "voice.stt.stop" => handle_stt_stop(params).await,
        "voice.tts" => handle_voice_tts(params).await,
        "voice.argos.turn" => handle_argos_turn(ctx, params).await,
        "voice.realtime.start" => {
            let res = crate::voice_realtime::voice_realtime_connect(
                None,
                opt_str(&params, "voice"),
                opt_str(&params, "instructions"),
                None,
                None,
                None,
                None,
                opt_str(&params, "provider"),
                None,
                None,
            )
            .await;
            let ok = res.get("ok").and_then(Value::as_bool).unwrap_or(false);
            let mut out = json!({
                "ok": ok,
                "status": crate::voice_realtime::voice_realtime_status().await,
            });
            if !ok {
                if let Some(err) = res
                    .get("reason")
                    .or_else(|| res.get("error"))
                    .and_then(Value::as_str)
                {
                    out["error"] = json!(err);
                }
            }
            Ok(out)
        }
        "voice.realtime.audio" => {
            let raw_b64 = req_str(&params, "pcm16Base64")?;
            let bytes = decode_bounded_audio(&raw_b64)?;
            if bytes.len() % 2 != 0 {
                return Err(RpcError::invalid_params("pcm16Base64 must contain whole 16-bit PCM samples."));
            }
            let src_rate = params
                .get("sampleRate")
                .and_then(Value::as_u64)
                .map(|r| r as u32)
                .unwrap_or(24000);
            if !(8000..=96000).contains(&src_rate) {
                return Err(RpcError::invalid_params("sampleRate must be between 8000 and 96000 Hz."));
            }
            let target_rate = crate::voice_realtime::voice_realtime_status().await.sample_rate.max(8000);
            let forward_b64 = if src_rate == target_rate {
                BASE64.encode(&bytes)
            } else {
                let resampled_bytes = blocking(move || resample_pcm16_le(&bytes, src_rate, target_rate)).await?;
                BASE64.encode(resampled_bytes)
            };
            let res = crate::voice_realtime::voice_realtime_send_audio(forward_b64).await;
            Ok(json!({ "ok": res.get("ok").and_then(Value::as_bool).unwrap_or(false) }))
        }
        "voice.realtime.truncate" => {
            let item_id = req_str(&params, "itemId")?;
            let audio_end_ms = params
                .get("audioEndMs")
                .and_then(Value::as_u64)
                .ok_or_else(|| RpcError::invalid_params("audioEndMs is required."))?;
            let res = crate::voice_realtime::voice_realtime_truncate(item_id, audio_end_ms).await;
            Ok(json!({ "ok": res.get("ok").and_then(Value::as_bool).unwrap_or(false) }))
        }
        "voice.realtime.stop" => {
            let _ = crate::voice_realtime::voice_realtime_disconnect().await;
            Ok(json!({ "ok": true }))
        }
        _ => Err(RpcError::new("method_not_found", format!("Unknown method '{method}'."))),
    }
}

pub(crate) struct SttLiveSession {
    created_at: Instant,
    last_activity: Instant,
    language: String,
    provider: String,
    sample_rate: u32,
    use_grok_ws: bool,
    pcm_buffer: Vec<u8>,
    frame_tx: Option<mpsc::Sender<Vec<u8>>>,
    stop_tx: Option<watch::Sender<bool>>,
    ws_task: Option<tokio::task::JoinHandle<Result<String, String>>>,
}

#[cfg(test)]
impl SttLiveSession {
    pub(crate) fn dummy_for_test(last_activity: Instant) -> Self {
        Self {
            created_at: last_activity,
            last_activity,
            language: String::new(),
            provider: "offline".to_string(),
            sample_rate: 16000,
            use_grok_ws: false,
            pcm_buffer: Vec::new(),
            frame_tx: None,
            stop_tx: None,
            ws_task: None,
        }
    }
}

static STT_LIVE_SESSIONS: OnceLock<Mutex<HashMap<String, SttLiveSession>>> = OnceLock::new();

fn stt_live_sessions() -> &'static Mutex<HashMap<String, SttLiveSession>> {
    STT_LIVE_SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn abort_live_session(mut sess: SttLiveSession) {
    if let Some(stop_tx) = sess.stop_tx.take() {
        let _ = stop_tx.send(true);
    }
    if let Some(task) = sess.ws_task.take() {
        task.abort();
    }
}

pub(crate) fn prune_stt_sessions(
    map: &mut HashMap<String, SttLiveSession>,
    now: Instant,
) -> Vec<SttLiveSession> {
    let mut evicted = Vec::new();
    let stale_ids: Vec<String> = map
        .iter()
        .filter(|(_, sess)| now.saturating_duration_since(sess.last_activity) > STT_SESSION_TTL)
        .map(|(id, _)| id.clone())
        .collect();
    for id in stale_ids {
        if let Some(sess) = map.remove(&id) {
            evicted.push(sess);
        }
    }
    while map.len() >= MAX_ACTIVE_STT_SESSIONS {
        let Some(oldest_id) = map
            .iter()
            .min_by_key(|(_, sess)| sess.last_activity)
            .map(|(id, _)| id.clone())
        else {
            break;
        };
        if let Some(sess) = map.remove(&oldest_id) {
            evicted.push(sess);
        }
    }
    evicted
}

fn parse_stt_sample_rate(params: &Value) -> Result<u32, RpcError> {
    match params.get("sampleRate") {
        None | Some(Value::Null) => Ok(16000),
        Some(v) => {
            let Some(rate) = v.as_u64() else {
                return Err(RpcError::invalid_params(
                    "sampleRate must be an integer between 8000 and 48000 Hz.",
                ));
            };
            if !(8000..=48000).contains(&rate) {
                return Err(RpcError::invalid_params(
                    "sampleRate must be between 8000 and 48000 Hz.",
                ));
            }
            Ok(rate as u32)
        }
    }
}

async fn handle_stt_start(ctx: &RpcContext, params: Value) -> Result<Value, RpcError> {
    let provider = normalize_stt_provider(opt_str(&params, "sttProvider").as_deref())?;
    let sample_rate = parse_stt_sample_rate(&params)?;
    let lang = opt_str(&params, "language").unwrap_or_default();

    let (settings, grok_key) =
        blocking(|| (DesktopVoiceSettings::load(), resolve_grok_stt_key())).await?;

    let session_id = Uuid::new_v4().to_string();
    let use_grok_ws = (provider == "auto" || provider == "grok")
        && grok_key.is_some()
        && is_xai_streaming_stt_base_url(&settings.grok_base_url);

    let (frame_tx, stop_tx, ws_task) = if let Some(key) = grok_key.filter(|_| use_grok_ws) {
        let (tx, rx) = mpsc::channel::<Vec<u8>>(STT_WS_CHANNEL_CAPACITY);
        let (s_tx, s_rx) = watch::channel(false);
        let events = Arc::clone(&ctx.events);
        let sid = session_id.clone();
        let base_url = settings.grok_base_url.clone();
        let ws_lang = lang.clone();
        let handle = tokio::spawn(async move {
            run_grok_stt_ws_stream(events, sid, key, base_url, ws_lang, sample_rate, rx, s_rx).await
        });
        (Some(tx), Some(s_tx), Some(handle))
    } else {
        (None, None, None)
    };

    let now = Instant::now();
    let session = SttLiveSession {
        created_at: now,
        last_activity: now,
        language: lang,
        provider: provider.to_string(),
        sample_rate,
        use_grok_ws,
        pcm_buffer: Vec::new(),
        frame_tx,
        stop_tx,
        ws_task,
    };

    let evicted = {
        let mut map = stt_live_sessions().lock().unwrap_or_else(|e| e.into_inner());
        let evicted = prune_stt_sessions(&mut map, now);
        map.insert(session_id.clone(), session);
        evicted
    };
    for old in evicted {
        abort_live_session(old);
    }

    Ok(json!({
        "sessionId": session_id,
        "streaming": use_grok_ws,
        "provider": provider,
        "sampleRate": sample_rate,
    }))
}

async fn handle_stt_chunk(params: Value) -> Result<Value, RpcError> {
    let session_id = req_str(&params, "sessionId")?;
    let b64 = req_str(&params, "pcm16Base64")?;
    let bytes = decode_bounded_audio(&b64)?;
    if bytes.len() % 2 != 0 {
        return Err(RpcError::invalid_params(
            "pcm16Base64 must contain whole 16-bit PCM samples.",
        ));
    }

    let tx_opt = {
        let mut map = stt_live_sessions().lock().unwrap_or_else(|e| e.into_inner());
        let Some(sess) = map.get_mut(&session_id) else {
            return Err(RpcError::new(
                "session_not_found",
                format!("Unknown or expired STT session '{session_id}'."),
            ));
        };
        if sess.pcm_buffer.len().saturating_add(bytes.len()) > MAX_AUDIO_BYTES {
            return Err(RpcError::new(
                "payload_too_large",
                "Streaming audio buffer exceeds maximum 15 MiB limit.",
            ));
        }
        sess.last_activity = Instant::now();
        sess.pcm_buffer.extend_from_slice(&bytes);
        sess.frame_tx.clone()
    };

    if let Some(tx) = tx_opt {
        let _ = tx.try_send(bytes);
    }

    Ok(json!({ "ok": true }))
}

async fn handle_stt_stop(params: Value) -> Result<Value, RpcError> {
    let session_id = req_str(&params, "sessionId")?;
    let cancel = params.get("cancel").and_then(Value::as_bool).unwrap_or(false);

    let mut sess = {
        let mut map = stt_live_sessions().lock().unwrap_or_else(|e| e.into_inner());
        map.remove(&session_id).ok_or_else(|| {
            RpcError::new(
                "session_not_found",
                format!("Unknown or expired STT session '{session_id}'."),
            )
        })?
    };

    if cancel {
        let elapsed_ms = sess.created_at.elapsed().as_millis() as u64;
        abort_live_session(sess);
        return Ok(json!({
            "ok": true,
            "cancelled": true,
            "text": "",
            "backend": "cancelled",
            "durationMs": elapsed_ms,
        }));
    }

    // Drop the frame sender once stopped so the stream loop observes end-of-input after draining.
    sess.frame_tx.take();
    let stop_tx = sess.stop_tx.take();
    if let Some(ref tx) = stop_tx {
        let _ = tx.send(true);
    }

    if let Some(mut task) = sess.ws_task.take() {
        match tokio::time::timeout(
            Duration::from_millis(STT_STOP_AWAIT_TIMEOUT_MS),
            &mut task,
        )
        .await
        {
            Ok(Ok(Ok(ws_text))) => {
                let trimmed = ws_text.trim().to_string();
                if !trimmed.is_empty() {
                    return Ok(json!({
                        "text": trimmed,
                        "backend": "grok_stt",
                        "durationMs": sess.created_at.elapsed().as_millis() as u64,
                    }));
                }
            }
            Ok(Ok(Err(err))) => {
                eprintln!("[remote::voice] streaming Grok WS STT failed: {err}");
            }
            Ok(Err(join_err)) => {
                eprintln!("[remote::voice] streaming Grok WS STT task error: {join_err}");
            }
            Err(_) => {
                task.abort();
                eprintln!(
                    "[remote::voice] streaming Grok WS STT stop timed out after {STT_STOP_AWAIT_TIMEOUT_MS}ms"
                );
            }
        }
    }
    drop(stop_tx);

    if sess.pcm_buffer.len() >= STT_MIN_FALLBACK_PCM_BYTES {
        let pcm = std::mem::take(&mut sess.pcm_buffer);
        let rate = sess.sample_rate;
        let wav_b64 = blocking(move || {
            let samples: Vec<i16> = pcm
                .chunks_exact(2)
                .map(|c| i16::from_le_bytes([c[0], c[1]]))
                .collect();
            let wav_bytes = encode_pcm16_wav(&samples, rate);
            BASE64.encode(wav_bytes)
        })
        .await?;
        let lang_opt = (!sess.language.is_empty()).then_some(sess.language.as_str());
        let (text, backend, _) = transcribe_audio_base64(
            &wav_b64,
            Some("audio/wav"),
            lang_opt,
            Some(sess.provider.as_str()),
        )
        .await?;
        return Ok(json!({
            "text": text.trim(),
            "backend": backend,
            "durationMs": sess.created_at.elapsed().as_millis() as u64,
        }));
    }

    Ok(json!({
        "text": "",
        "backend": if sess.use_grok_ws { "grok_stt" } else { "offline_stt" },
        "durationMs": sess.created_at.elapsed().as_millis() as u64,
    }))
}

fn publish_stt_partial(events: &RemoteEventBus, session_id: &str, text: &str, is_final: bool) {
    if !text.trim().is_empty() {
        events.publish(
            "voice.stt_partial",
            json!({
                "sessionId": session_id,
                "text": text,
                "isFinal": is_final,
            }),
        );
    }
}

async fn drain_and_send_audio_done<S>(
    frame_rx: &mut mpsc::Receiver<Vec<u8>>,
    write: &mut S,
) -> Result<(), String>
where
    S: futures_util::Sink<Message> + Unpin,
{
    while let Ok(pcm) = frame_rx.try_recv() {
        if !pcm.is_empty() && write.send(Message::Binary(pcm)).await.is_err() {
            return Err("STT WebSocket send interrupted".to_string());
        }
    }
    let _ = write
        .send(Message::Text(r#"{"type":"audio.done"}"#.to_string()))
        .await;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn run_grok_stt_ws_stream(
    events: Arc<RemoteEventBus>,
    session_id: String,
    api_key: String,
    base_url: String,
    language: String,
    sample_rate: u32,
    mut frame_rx: mpsc::Receiver<Vec<u8>>,
    mut stop_rx: watch::Receiver<bool>,
) -> Result<String, String> {
    let ws_url = build_stt_ws_url(&base_url, &language, sample_rate);
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
    let mut final_transcript = String::new();
    let mut interim_transcript = String::new();
    let mut flushing = false;
    let mut rx_closed = false;
    let flush_sleep = tokio::time::sleep(Duration::from_secs(3600));
    tokio::pin!(flush_sleep);

    if *stop_rx.borrow_and_update() {
        drain_and_send_audio_done(&mut frame_rx, &mut write).await?;
        flushing = true;
        rx_closed = true;
        flush_sleep
            .as_mut()
            .reset(tokio::time::Instant::now() + Duration::from_millis(1100));
    }

    loop {
        tokio::select! {
            changed = stop_rx.changed(), if !flushing => {
                if changed.is_err() || *stop_rx.borrow_and_update() {
                    drain_and_send_audio_done(&mut frame_rx, &mut write).await?;
                    flushing = true;
                    rx_closed = true;
                    flush_sleep
                        .as_mut()
                        .reset(tokio::time::Instant::now() + Duration::from_millis(1100));
                }
            }
            _ = &mut flush_sleep, if flushing => {
                let _ = write.close().await;
                break;
            }
            maybe_pcm = frame_rx.recv(), if !flushing && !rx_closed => {
                match maybe_pcm {
                    Some(pcm) => {
                        if !pcm.is_empty() && write.send(Message::Binary(pcm)).await.is_err() {
                            return Err("STT WebSocket send interrupted".to_string());
                        }
                    }
                    None => {
                        rx_closed = true;
                    }
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
                                let had_new_text = text.is_some() || !interim_transcript.is_empty();
                                if let Some(t) = text {
                                    final_transcript = join_speech_partial(&final_transcript, &t);
                                } else if !interim_transcript.is_empty() {
                                    final_transcript = join_speech_partial(&final_transcript, &interim_transcript);
                                }
                                interim_transcript.clear();
                                if had_new_text {
                                    publish_stt_partial(&events, &session_id, &final_transcript, true);
                                }
                                let _ = write.close().await;
                                break;
                            }
                            SttWsFrame::Transcript { text, is_final: true } => {
                                final_transcript = join_speech_partial(&final_transcript, &text);
                                interim_transcript.clear();
                                publish_stt_partial(&events, &session_id, &final_transcript, true);
                                if flushing {
                                    flush_sleep
                                        .as_mut()
                                        .reset(tokio::time::Instant::now() + Duration::from_millis(250));
                                }
                            }
                            SttWsFrame::Transcript { text, is_final: false } => {
                                interim_transcript = text;
                                let combined = join_speech_partial(&final_transcript, &interim_transcript);
                                publish_stt_partial(&events, &session_id, &combined, false);
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

fn resample_pcm16_le(bytes: &[u8], src_rate: u32, dst_rate: u32) -> Vec<u8> {
    let f32_samples: Vec<f32> = bytes
        .chunks_exact(2)
        .map(|chunk| i16::from_le_bytes([chunk[0], chunk[1]]) as f32 / 32768.0)
        .collect();
    let resampled = crate::voice_audio::resampler::resample_f32_to_pcm16_mono(&f32_samples, src_rate, 1, dst_rate);
    let mut out = Vec::with_capacity(resampled.len() * 2);
    for s in resampled {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

struct PendingArgosGuard {
    events: Arc<RemoteEventBus>,
    turn_id: String,
}

impl Drop for PendingArgosGuard {
    fn drop(&mut self) {
        self.events.cancel_argos_turn(&self.turn_id);
    }
}

fn emit_argos_status(events: &RemoteEventBus, turn_id: &str, phase: &str, detail: Option<&str>) {
    let mut payload = json!({ "turnId": turn_id, "phase": phase });
    if let Some(d) = detail {
        payload["detail"] = json!(d);
    }
    events.publish("voice.argos_status", payload);
}

async fn handle_voice_tts(params: Value) -> Result<Value, RpcError> {
    let text = req_str(&params, "text")?;
    let tts_provider = normalize_tts_provider(opt_str(&params, "ttsProvider").as_deref())?;
    if tts_provider == "device" {
        return Ok(json!({
            "provider": "device",
            "mimeType": "text/plain",
            "audioBase64": "",
        }));
    }

    let started = Instant::now();
    let voice_override = opt_str(&params, "voiceId");
    let model_override = opt_str(&params, "model");
    let (xi_key, settings) = blocking(|| {
        (
            crate::credentials::resolve_provider_key("elevenlabs"),
            DesktopVoiceSettings::load(),
        )
    })
    .await?;

    let Some(api_key) = xi_key.filter(|k| !k.trim().is_empty()) else {
        return Err(RpcError::new(
            "tts_unavailable",
            "ElevenLabs API key is not configured.",
        ));
    };

    let (mp3, used_voice_id, used_model) = synthesize_elevenlabs_mp3(
        &api_key,
        &text,
        &settings,
        voice_override.as_deref(),
        model_override.as_deref(),
    )
    .await
    .map_err(|err| RpcError::new("tts_failed", err))?;

    Ok(json!({
        "audioBase64": BASE64.encode(mp3),
        "mimeType": "audio/mpeg",
        "provider": "elevenlabs",
        "voiceId": used_voice_id,
        "model": used_model,
        "durationMs": started.elapsed().as_millis() as u64,
    }))
}

async fn handle_argos_turn(ctx: &RpcContext, params: Value) -> Result<Value, RpcError> {
    let stt_provider = opt_str(&params, "sttProvider");
    let _ = normalize_stt_provider(stt_provider.as_deref())?;
    let tts_provider = normalize_tts_provider(opt_str(&params, "ttsProvider").as_deref())?;

    let Some(app) = crate::get_app_handle() else {
        return Err(RpcError::new("argos_unavailable", "Desktop GUI is not attached to handle Argos turns."));
    };
    let (started, turn_id) = (Instant::now(), Uuid::new_v4().to_string());
    let language = opt_str(&params, "language");
    let request_tts = params.get("requestTts").and_then(Value::as_bool).unwrap_or(false);

    let mut transcript = opt_str(&params, "transcript").unwrap_or_default();
    if transcript.is_empty() {
        let audio_b64 = opt_str(&params, "audioBase64")
            .ok_or_else(|| RpcError::invalid_params("transcript or audioBase64 is required."))?;
        emit_argos_status(&ctx.events, &turn_id, "transcribing", None);
        let (text, _, _) = transcribe_audio_base64(
            &audio_b64,
            opt_str(&params, "mimeType").as_deref(),
            language.as_deref(),
            stt_provider.as_deref(),
        )
        .await?;
        transcript = text.trim().to_string();
        if transcript.is_empty() {
            emit_argos_status(&ctx.events, &turn_id, "error", Some("Empty speech transcript"));
            return Err(RpcError::new("empty_transcript", "No speech detected in audio."));
        }
    }

    emit_argos_status(&ctx.events, &turn_id, "thinking", None);
    let rx = ctx.events.register_argos_turn(turn_id.clone());
    let _guard = PendingArgosGuard {
        events: Arc::clone(&ctx.events),
        turn_id: turn_id.clone(),
    };
    let req_payload = json!({
        "requestId": turn_id,
        "turnId": turn_id,
        "transcript": transcript,
        "workspaceId": params.get("workspaceId").cloned().unwrap_or(Value::Null),
        "history": params.get("history").cloned().unwrap_or_else(|| json!([])),
        "language": language,
        "requestTts": request_tts,
    });
    if let Err(err) = app.emit("remote:argos-turn-request", &req_payload) {
        emit_argos_status(&ctx.events, &turn_id, "error", Some(&err.to_string()));
        return Err(RpcError::internal(format!("Failed dispatching Argos turn: {err}")));
    }

    let reply_val = match tokio::time::timeout(Duration::from_secs(ARGOS_TIMEOUT_SECS), rx).await {
        Ok(Ok(val)) => val,
        Ok(Err(_)) => {
            emit_argos_status(&ctx.events, &turn_id, "error", Some("Argos reply channel closed"));
            return Err(RpcError::internal("Desktop Argos reply channel closed."));
        }
        Err(_) => {
            emit_argos_status(&ctx.events, &turn_id, "error", Some("Argos turn timed out"));
            return Err(RpcError::new("argos_timeout", "Desktop Argos turn timed out after 45s."));
        }
    };
    if let Some(err_msg) = reply_val
        .get("error")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
    {
        emit_argos_status(&ctx.events, &turn_id, "error", Some(err_msg));
        return Err(RpcError::new("argos_failed", err_msg));
    }

    let reply = reply_val.get("reply").and_then(Value::as_str).unwrap_or("").to_string();
    let mut tts_b64: Option<String> = None;
    if request_tts && tts_provider != "device" && !reply.trim().is_empty() {
        let voice_override = opt_str(&params, "voiceId");
        let model_override = opt_str(&params, "model");
        if let Ok((Some(xi_key), settings)) = blocking(|| {
            (
                crate::credentials::resolve_provider_key("elevenlabs"),
                DesktopVoiceSettings::load(),
            )
        })
        .await
        {
            emit_argos_status(&ctx.events, &turn_id, "speaking", None);
            match synthesize_elevenlabs_mp3(
                &xi_key,
                &reply,
                &settings,
                voice_override.as_deref(),
                model_override.as_deref(),
            )
            .await
            {
                Ok((mp3, _, _)) => {
                    tts_b64 = Some(BASE64.encode(mp3));
                }
                Err(err) => {
                    eprintln!("[remote::voice] ElevenLabs TTS failed: {err}");
                }
            }
        }
    }
    emit_argos_status(&ctx.events, &turn_id, "done", None);
    let mut out = json!({
        "turnId": turn_id,
        "transcript": transcript,
        "reply": reply,
        "receipts": reply_val.get("receipts").cloned().unwrap_or_else(|| json!([])),
        "proposal": reply_val.get("proposal").cloned().unwrap_or(Value::Null),
        "strategy": reply_val.get("strategy").and_then(Value::as_str).unwrap_or("desktop_argos"),
        "durationMs": started.elapsed().as_millis() as u64,
    });
    if let Some(audio) = tts_b64 {
        out["ttsAudioBase64"] = json!(audio);
        out["ttsMimeType"] = json!("audio/mpeg");
    }
    Ok(out)
}

fn resolve_grok_stt_key() -> Option<String> {
    crate::credentials::resolve_provider_key("grok_transcription")
        .or_else(|| crate::credentials::resolve_provider_key("grok"))
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty())
}

fn resolve_openai_stt_key() -> Option<String> {
    crate::credentials::get_vault_credential("openai")
        .or_else(|| crate::credentials::get_vault_credential("openai_realtime"))
        .or_else(|| std::env::var("OPENAI_API_KEY").ok())
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty())
}

pub fn decode_bounded_audio(raw_b64: &str) -> Result<Vec<u8>, RpcError> {
    let clean_b64 = raw_b64
        .trim()
        .strip_prefix("data:")
        .and_then(|r| r.split_once(";base64,").map(|(_, d)| d))
        .unwrap_or_else(|| raw_b64.trim());
    if clean_b64.len() > MAX_AUDIO_B64_LEN {
        return Err(RpcError::new("payload_too_large", "Audio payload exceeds maximum 15 MiB limit."));
    }
    let bytes = BASE64
        .decode(clean_b64)
        .map_err(|e| RpcError::invalid_params(format!("Invalid base64 audio: {e}")))?;
    if bytes.is_empty() {
        return Err(RpcError::invalid_params("Audio payload is empty."));
    }
    if bytes.len() > MAX_AUDIO_BYTES {
        return Err(RpcError::new("payload_too_large", "Decoded audio exceeds maximum 15 MiB limit."));
    }
    Ok(bytes)
}

async fn post_stt_multipart(
    client: &reqwest::Client,
    url: &str,
    api_key: &str,
    bytes: &[u8],
    ext: &str,
    safe_mime: &str,
    model: &str,
    lang: &str,
) -> Result<reqwest::Response, RpcError> {
    let part = reqwest::multipart::Part::bytes(bytes.to_vec())
        .file_name(format!("speech.{ext}"))
        .mime_str(safe_mime)
        .map_err(|e| RpcError::internal(format!("Multipart error: {e}")))?;
    let mut form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("model", model.to_string());
    if !lang.is_empty() && lang != "auto" {
        form = form.text(
            "language",
            lang.split(['-', '_']).next().unwrap_or(lang).to_string(),
        );
    }
    client
        .post(url)
        .bearer_auth(api_key.trim())
        .multipart(form)
        .send()
        .await
        .map_err(|e| RpcError::new("stt_failed", format!("Cloud STT failed: {e}")))
}

async fn transcribe_grok_stt(
    client: &reqwest::Client,
    api_key: &str,
    settings: &DesktopVoiceSettings,
    bytes: &[u8],
    ext: &str,
    safe_mime: &str,
    lang: &str,
) -> Result<String, RpcError> {
    let (primary_url, fallback_url) = grok_stt_endpoints(&settings.grok_base_url);
    let model = settings.effective_grok_model();

    let mut resp = post_stt_multipart(
        client,
        &primary_url,
        api_key,
        bytes,
        ext,
        safe_mime,
        model,
        lang,
    )
    .await?;

    let status = resp.status();
    let should_fallback = fallback_url.is_some()
        && (status == reqwest::StatusCode::NOT_FOUND
            || status == reqwest::StatusCode::METHOD_NOT_ALLOWED
            || ((status == reqwest::StatusCode::BAD_REQUEST
                || status == reqwest::StatusCode::UNPROCESSABLE_ENTITY)
                && primary_url.ends_with("/stt")));

    if should_fallback {
        if let Some(ref fb_url) = fallback_url {
            resp = post_stt_multipart(
                client,
                fb_url,
                api_key,
                bytes,
                ext,
                safe_mime,
                model,
                lang,
            )
            .await?;
        }
    }

    if !resp.status().is_success() {
        let final_status = resp.status();
        let err_body = resp.text().await.unwrap_or_default();
        let snippet = truncate_snippet(&err_body, 180);
        let msg = if snippet.is_empty() {
            format!("Grok STT returned HTTP {final_status}.")
        } else {
            format!("Grok STT returned HTTP {final_status}: {snippet}")
        };
        return Err(RpcError::new("stt_failed", msg));
    }
    let body: Value = resp
        .json()
        .await
        .map_err(|e| RpcError::new("stt_failed", format!("Invalid Grok STT JSON: {e}")))?;
    Ok(extract_stt_transcript(&body))
}

async fn transcribe_openai_stt(
    client: &reqwest::Client,
    api_key: &str,
    bytes: &[u8],
    ext: &str,
    safe_mime: &str,
    lang: &str,
) -> Result<String, RpcError> {
    let resp = post_stt_multipart(
        client,
        "https://api.openai.com/v1/audio/transcriptions",
        api_key,
        bytes,
        ext,
        safe_mime,
        "whisper-1",
        lang,
    )
    .await?;
    if !resp.status().is_success() {
        let final_status = resp.status();
        let err_body = resp.text().await.unwrap_or_default();
        let snippet = truncate_snippet(&err_body, 180);
        let msg = if snippet.is_empty() {
            format!("OpenAI STT returned HTTP {final_status}.")
        } else {
            format!("OpenAI STT returned HTTP {final_status}: {snippet}")
        };
        return Err(RpcError::new("stt_failed", msg));
    }
    let body: Value = resp
        .json()
        .await
        .map_err(|e| RpcError::new("stt_failed", format!("Invalid OpenAI STT JSON: {e}")))?;
    Ok(extract_stt_transcript(&body))
}

async fn transcribe_audio_base64(
    raw_b64: &str,
    mime_type: Option<&str>,
    language: Option<&str>,
    stt_provider: Option<&str>,
) -> Result<(String, &'static str, u64), RpcError> {
    let provider = normalize_stt_provider(stt_provider)?;
    let started = Instant::now();
    let bytes = decode_bounded_audio(raw_b64)?;
    let lang = language.unwrap_or("").trim().to_string();
    let (safe_mime, ext) = normalize_audio_mime(mime_type.unwrap_or("audio/m4a"));

    let (settings, grok_key, openai_key) = blocking(|| {
        (
            DesktopVoiceSettings::load(),
            resolve_grok_stt_key(),
            resolve_openai_stt_key(),
        )
    })
    .await?;

    let build_client = || {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(25))
            .build()
            .map_err(|e| RpcError::internal(format!("HTTP client error: {e}")))
    };

    let mut last_cloud_err: Option<RpcError> = None;

    if provider == "grok" || provider == "auto" {
        if let Some(ref key) = grok_key {
            let client = build_client()?;
            match transcribe_grok_stt(&client, key, &settings, &bytes, ext, safe_mime, &lang).await {
                Ok(text) => return Ok((text, "grok_stt", started.elapsed().as_millis() as u64)),
                Err(err) if provider == "grok" => return Err(err),
                Err(err) => last_cloud_err = Some(err),
            }
        } else if provider == "grok" {
            return Err(RpcError::new(
                "stt_unavailable",
                "Grok STT key is not configured.",
            ));
        }
    }

    if provider == "openai" || provider == "auto" {
        if let Some(ref key) = openai_key {
            let client = build_client()?;
            match transcribe_openai_stt(&client, key, &bytes, ext, safe_mime, &lang).await {
                Ok(text) => return Ok((text, "openai_stt", started.elapsed().as_millis() as u64)),
                Err(err) if provider == "openai" => return Err(err),
                Err(err) => last_cloud_err = Some(err),
            }
        } else if provider == "openai" {
            return Err(RpcError::new(
                "stt_unavailable",
                "OpenAI STT key is not configured.",
            ));
        }
    }

    let preferred_offline = settings
        .offline_stt_engine
        .clone()
        .filter(|e| !e.eq_ignore_ascii_case("auto"));
    let offline = blocking(move || {
        let engines = crate::voice_audio::offline_stt::probe_local_engines(None, None);
        if !engines.iter().any(|e| e.available) {
            return Err(
                "No cloud STT key (xAI/OpenAI) configured and no offline Whisper/Parakeet engine ready."
                    .to_string(),
            );
        }
        let wav_bytes = if bytes.len() > 44 && bytes.starts_with(b"RIFF") {
            bytes
        } else {
            transcode_audio_to_wav_ffmpeg(&bytes, ext)?
        };
        crate::voice_audio::offline_stt::transcribe_wav_offline(
            &wav_bytes,
            preferred_offline.as_deref(),
            None,
            None,
            &lang,
        )
    })
    .await?;

    match offline {
        Ok(text) => Ok((text, "offline_stt", started.elapsed().as_millis() as u64)),
        Err(err) => {
            if provider == "auto" {
                if let Some(cloud_err) = last_cloud_err {
                    return Err(cloud_err);
                }
            }
            Err(RpcError::new("stt_unavailable", err))
        }
    }
}

struct TempFileGuard(PathBuf);
impl Drop for TempFileGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn transcode_audio_to_wav_ffmpeg(input_bytes: &[u8], ext: &str) -> Result<Vec<u8>, String> {
    let stamp = format!("{}-{}", now_unix_ms(), Uuid::new_v4().simple());
    let in_path = std::env::temp_dir().join(format!("kite-remote-in-{stamp}.{ext}"));
    let out_path = std::env::temp_dir().join(format!("kite-remote-out-{stamp}.wav"));
    let _in_guard = TempFileGuard(in_path.clone());
    let _out_guard = TempFileGuard(out_path.clone());

    std::fs::write(&in_path, input_bytes)
        .map_err(|e| format!("Failed writing audio buffer for transcoding: {e}"))?;

    let mut cmd = std::process::Command::new("ffmpeg");
    cmd.args([
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
    ])
    .arg(&in_path)
    .args(["-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le"])
    .arg(&out_path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = cmd.output().map_err(|_| {
        "Offline STT received compressed mobile audio without ffmpeg installed; configure a Cloud STT key (xAI/OpenAI) or install ffmpeg.".to_string()
    })?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Audio transcoding via ffmpeg failed: {}", detail.trim()));
    }
    std::fs::read(&out_path).map_err(|e| format!("Failed reading transcoded WAV: {e}"))
}

fn normalize_audio_mime(raw: &str) -> (&'static str, &'static str) {
    let lower = raw.trim().to_ascii_lowercase();
    if lower.contains("wav") { ("audio/wav", "wav") }
    else if lower.contains("webm") { ("audio/webm", "webm") }
    else if lower.contains("ogg") { ("audio/ogg", "ogg") }
    else if lower.contains("mpeg") || lower.contains("mp3") { ("audio/mpeg", "mp3") }
    else { ("audio/mp4", "m4a") }
}

async fn post_elevenlabs_tts(
    client: &reqwest::Client,
    api_key: &str,
    voice_id: &str,
    model: &str,
    text: &str,
    settings: &DesktopVoiceSettings,
) -> Result<reqwest::Response, String> {
    let encoded_voice = crate::remote::auth::percent_encode(voice_id);
    let url = format!(
        "https://api.elevenlabs.io/v1/text-to-speech/{encoded_voice}?output_format=mp3_44100_128"
    );
    client
        .post(&url)
        .header("xi-api-key", api_key.trim())
        .json(&json!({
            "text": text,
            "model_id": model,
            "voice_settings": {
                "stability": settings.elevenlabs_stability,
                "similarity_boost": settings.elevenlabs_similarity,
            }
        }))
        .send()
        .await
        .map_err(|e| e.to_string())
}

async fn synthesize_elevenlabs_mp3(
    api_key: &str,
    text: &str,
    settings: &DesktopVoiceSettings,
    voice_id_override: Option<&str>,
    model_override: Option<&str>,
) -> Result<(Vec<u8>, String, String), String> {
    let voice_id = voice_id_override
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&settings.elevenlabs_voice_id)
        .to_string();
    let explicit_model = model_override
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let active_model = explicit_model
        .clone()
        .unwrap_or_else(|| settings.elevenlabs_model.clone());

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = post_elevenlabs_tts(
        &client,
        api_key,
        &voice_id,
        &active_model,
        text,
        settings,
    )
    .await?;

    if !resp.status().is_success() {
        let status = resp.status();
        let err_body = resp.text().await.unwrap_or_default();
        if (status == reqwest::StatusCode::BAD_REQUEST
            || status == reqwest::StatusCode::UNPROCESSABLE_ENTITY)
            && active_model == ELEVENLABS_MODEL
            && explicit_model.is_none()
        {
            let fallback_model = "eleven_turbo_v2_5";
            let retry_resp = post_elevenlabs_tts(
                &client,
                api_key,
                &voice_id,
                fallback_model,
                text,
                settings,
            )
            .await?;
            if retry_resp.status().is_success() {
                let bytes = retry_resp.bytes().await.map_err(|e| e.to_string())?.to_vec();
                return Ok((bytes, voice_id, fallback_model.to_string()));
            }
            let retry_status = retry_resp.status();
            let retry_body = retry_resp.text().await.unwrap_or_default();
            let snippet = truncate_snippet(&retry_body, 180);
            return Err(if snippet.is_empty() {
                format!("ElevenLabs HTTP {retry_status}")
            } else {
                format!("ElevenLabs HTTP {retry_status}: {snippet}")
            });
        }
        let snippet = truncate_snippet(&err_body, 180);
        return Err(if snippet.is_empty() {
            format!("ElevenLabs HTTP {status}")
        } else {
            format!("ElevenLabs HTTP {status}: {snippet}")
        });
    }

    let bytes = resp.bytes().await.map_err(|e| e.to_string())?.to_vec();
    Ok((bytes, voice_id, active_model))
}
