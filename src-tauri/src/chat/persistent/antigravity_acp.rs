//! Shared multiplexed `agy acp --stdio` daemon pool and session transport.
//!
//! Multiple Antigravity conversations and subagents sharing a connection and
//! environment fingerprint multiplex onto a single long-lived `agy acp --stdio
//! --disable-telemetry` process wrapped in Kite's `HiddenChild` Job Object.
//! A background stdout reader demultiplexes JSON-RPC responses by `"id"` and
//! routes notifications (`session/update`, `session/request_permission`, etc.)
//! by `sessionId` into per-session bounded event queues.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::fmt;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::chat::drivers::{declaration, DriverProbe, SystemDriverProbe};
use crate::chat::runtime::bounded_notice;
use crate::chat::session::{SessionTransport, TransportEvent, TransportSpec};
use crate::chat::utils::chat_log;
use crate::hidden_exec::{spawn_streaming_with_owned_env, HiddenChild};

use super::antigravity::ParsedLine;
use super::controls::{
    frame_schema, push_bounded, read_tail, tail_detail, unhandled_request_reply,
    verify_driver_version, ANTIGRAVITY_DRIVER, PersistentControls,
};

/// Observed CLI flags for the multiplexed Antigravity ACP server.
/// `--process-per-session` is intentionally omitted so sessions multiplex in-process.
pub const AGY_ACP_ARGS: [&str; 3] = ["acp", "--stdio", "--disable-telemetry"];

/// Maximum time to wait for synchronous ACP control requests (`initialize`,
/// `session/new`, `session/load`, `session/set_config_option`).
pub const AGY_ACP_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);

/// Best-effort bounded wait for `session/close` on explicit `stop()`.
const AGY_ACP_CLOSE_TIMEOUT: Duration = Duration::from_millis(750);

/// Pool key: `(connection_id_or_default, env_fingerprint)`.
pub type AgyAcpPoolKey = (String, String);

/// Resolves the Antigravity CLI binary for ACP multiplexing.
pub fn resolve_antigravity_acp_program() -> Result<PathBuf, String> {
    crate::chat::utils::resolve_agy_bin().ok_or_else(|| {
        "Antigravity CLI (agy) is not installed; a shared ACP daemon cannot start without it"
            .to_string()
    })
}

fn is_per_thread_env_key(key: &str) -> bool {
    key.eq_ignore_ascii_case("KITE_THREAD_ID")
        || key.eq_ignore_ascii_case("KITE_ADDRESS")
        || key.eq_ignore_ascii_case("KITE_SESSION_ID")
        || key.eq_ignore_ascii_case("KITE_MODEL")
        || key.eq_ignore_ascii_case("KITE_CONNECTION_ID")
        || key.eq_ignore_ascii_case("KITE_THREAD_MODE")
        || key.eq_ignore_ascii_case("KITE_MULTIPLEXED_DAEMON")
        || key.eq_ignore_ascii_case("AGY_CLI_DISABLE_AUTO_UPDATE")
}

/// Scrubs per-thread identity variables (`KITE_ADDRESS`, `KITE_THREAD_ID`,
/// `KITE_SESSION_ID`, `KITE_MODEL`) before spawning a shared multiplexed daemon
/// so Thread #1's identity never leaks to sibling sessions or shared stdio MCP
/// children, while preserving Thread Mode detection via `KITE_THREAD_MODE=1`
/// and `KITE_MULTIPLEXED_DAEMON=1`.
pub fn shared_daemon_env(extra_env: &[(String, String)]) -> Vec<(String, String)> {
    let mut is_thread_mode = false;
    let mut out: Vec<(String, String)> = Vec::with_capacity(extra_env.len() + 2);
    for (key, value) in extra_env {
        let trimmed = key.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.eq_ignore_ascii_case("KITE_ADDRESS") {
            if value.trim().starts_with("thread:") {
                is_thread_mode = true;
            }
            continue;
        }
        if trimmed.eq_ignore_ascii_case("KITE_THREAD_ID")
            || trimmed.eq_ignore_ascii_case("KITE_SESSION_ID")
            || trimmed.eq_ignore_ascii_case("KITE_MODEL")
        {
            continue;
        }
        if trimmed.eq_ignore_ascii_case("KITE_THREAD_MODE") && value.trim() == "1" {
            is_thread_mode = true;
        }
        if trimmed.eq_ignore_ascii_case("KITE_DISPATCH") && value.trim() == "1" {
            is_thread_mode = true;
        }
        if trimmed.eq_ignore_ascii_case("KITE_THREAD_MODE")
            || trimmed.eq_ignore_ascii_case("KITE_MULTIPLEXED_DAEMON")
        {
            continue;
        }
        out.push((key.clone(), value.clone()));
    }
    if is_thread_mode {
        out.push(("KITE_THREAD_MODE".to_string(), "1".to_string()));
    }
    out.push(("KITE_MULTIPLEXED_DAEMON".to_string(), "1".to_string()));
    out
}

/// Computes a stable SHA-256 fingerprint for daemon-scoped environment overrides,
/// excluding per-thread correlation identifiers so parallel threads share one daemon.
pub fn compute_env_fingerprint(extra_env: &[(String, String)]) -> String {
    let mut normalized: BTreeMap<String, String> = BTreeMap::new();
    for (raw_key, raw_val) in extra_env {
        let trimmed_key = raw_key.trim();
        if trimmed_key.is_empty() || is_per_thread_env_key(trimmed_key) {
            continue;
        }
        let key = if cfg!(windows) {
            trimmed_key.to_ascii_uppercase()
        } else {
            trimmed_key.to_string()
        };
        normalized.insert(key, raw_val.clone());
    }
    if normalized.is_empty() {
        return "default".to_string();
    }
    let mut hasher = Sha256::new();
    for (key, value) in &normalized {
        hasher.update(key.as_bytes());
        hasher.update(b"=");
        hasher.update(value.as_bytes());
        hasher.update(b"\0");
    }
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

/// Derives the pool key `(connection_id_or_default, env_fingerprint)` from a
/// connection id and environment override list.
pub fn pool_key_for(connection_id: Option<&str>, extra_env: &[(String, String)]) -> AgyAcpPoolKey {
    let conn = connection_id
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or_else(|| {
            extra_env
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case("KITE_CONNECTION_ID"))
                .map(|(_, v)| v.trim())
                .filter(|s| !s.is_empty())
        })
        .unwrap_or("default")
        .to_string();
    (conn, compute_env_fingerprint(extra_env))
}

fn rpc_line(id: u64, method: &str, params: Value) -> String {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    })
    .to_string()
}

pub fn agy_acp_initialize_line(id: u64) -> String {
    rpc_line(
        id,
        "initialize",
        json!({
            "protocolVersion": 1,
            "clientCapabilities": {}
        }),
    )
}

pub fn agy_acp_session_new_line(id: u64, cwd: &str) -> String {
    rpc_line(
        id,
        "session/new",
        json!({
            "cwd": cwd,
            "mcpServers": []
        }),
    )
}

pub fn agy_acp_session_load_line(id: u64, session_id: &str, cwd: &str) -> String {
    rpc_line(
        id,
        "session/load",
        json!({
            "sessionId": session_id,
            "cwd": cwd,
            "mcpServers": []
        }),
    )
}

/// Observed `agy acp --stdio` `session/set_config_option` payload: `"value"` is
/// a string (`"model"`, `"thought_level"`, or `"mode"`).
pub fn agy_acp_config_line(id: u64, session_id: &str, config_id: &str, value: &str) -> String {
    rpc_line(
        id,
        "session/set_config_option",
        json!({
            "sessionId": session_id,
            "configId": config_id,
            "value": value
        }),
    )
}

pub fn agy_acp_prompt_line(id: u64, session_id: &str, prompt: &str) -> String {
    rpc_line(
        id,
        "session/prompt",
        json!({
            "sessionId": session_id,
            "prompt": [{ "type": "text", "text": prompt }]
        }),
    )
}

pub fn agy_acp_close_line(id: u64, session_id: &str) -> String {
    rpc_line(
        id,
        "session/close",
        json!({
            "sessionId": session_id
        }),
    )
}

pub fn agy_acp_cancel_line(session_id: &str) -> String {
    json!({
        "jsonrpc": "2.0",
        "method": "session/cancel",
        "params": {
            "sessionId": session_id
        }
    })
    .to_string()
}

/// Normalizes a reasoning effort string onto observed ACP `thought_level` values.
pub fn normalize_agy_thought_level(raw: Option<&str>) -> Option<&'static str> {
    let trimmed = raw.map(str::trim).filter(|s| !s.is_empty())?;
    match trimmed.to_ascii_lowercase().as_str() {
        "low" | "minimal" => Some("low"),
        "medium" => Some("medium"),
        "high" => Some("high"),
        "xhigh" | "x-high" | "extra" | "max" | "ultra" => Some("xhigh"),
        _ => None,
    }
}

/// Maps Kite permission mode names onto observed ACP `mode` config values.
pub fn map_agy_permission_mode(raw: Option<&str>) -> Option<&'static str> {
    let trimmed = raw.map(str::trim).filter(|s| !s.is_empty())?;
    match trimmed.to_ascii_lowercase().as_str() {
        "readonly" | "read_only" | "read-only" | "plan" => Some("plan"),
        "acceptedits" | "accept_edits" | "accept-edits" => Some("accept-edits"),
        "auto" | "fullaccess" | "full_access" | "full-access" | "bypasspermissions"
        | "bypass_permissions" => Some("auto"),
        "default" | "supervised" | "ask" => Some("default"),
        _ => None,
    }
}

/// Splits or normalizes `model` and `thought_level` against `available_models`
/// returned in `session/new` or `session/load` `configOptions`.
pub fn resolve_agy_model_and_thought(
    model: Option<&str>,
    effort: Option<&str>,
    available_models: &[String],
) -> (Option<String>, Option<&'static str>) {
    let trimmed_model = model.map(str::trim).filter(|s| !s.is_empty());
    let mut resolved_model = trimmed_model.map(str::to_string);
    let mut inferred_effort: Option<&str> = None;

    if let Some(m) = trimmed_model {
        if !available_models.is_empty() && !available_models.iter().any(|opt| opt == m) {
            for (suffix, tier) in [
                ("-xhigh", "xhigh"),
                ("-high", "high"),
                ("-medium", "medium"),
                ("-low", "low"),
                ("-max", "xhigh"),
                ("-ultra", "xhigh"),
                ("-minimal", "low"),
            ] {
                if let Some(base) = m.strip_suffix(suffix) {
                    if available_models.iter().any(|opt| opt == base) {
                        resolved_model = Some(base.to_string());
                        inferred_effort = Some(tier);
                        break;
                    }
                }
            }
            if inferred_effort.is_none() {
                let candidate = format!("{m}-medium");
                if available_models.iter().any(|opt| opt == &candidate) {
                    resolved_model = Some(candidate);
                }
            }
        }
    }

    let resolved_thought = normalize_agy_thought_level(effort.or(inferred_effort));
    (resolved_model, resolved_thought)
}

fn extract_available_model_options(value: &Value) -> Vec<String> {
    extract_config_options_snapshot(value)
        .map(|(models, _)| models)
        .unwrap_or_default()
}

/// Extracts `(available_models, available_thought_levels)` from an ACP
/// `result.configOptions` array. Returns `None` when `configOptions` is absent
/// or empty so callers keep any previously observed schema snapshot.
fn extract_config_options_snapshot(value: &Value) -> Option<(Vec<String>, Vec<String>)> {
    let options = value
        .pointer("/result/configOptions")
        .and_then(Value::as_array)
        .filter(|arr| !arr.is_empty())?;
    let mut models = Vec::new();
    let mut thought_levels = Vec::new();
    for opt in options {
        let Some(opt_id) = opt.get("id").and_then(Value::as_str) else {
            continue;
        };
        let target = match opt_id {
            "model" => &mut models,
            "thought_level" => &mut thought_levels,
            _ => continue,
        };
        if let Some(entries) = opt.get("options").and_then(Value::as_array) {
            for entry in entries {
                if let Some(val) = entry
                    .get("value")
                    .or_else(|| entry.get("id"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    target.push(val.to_string());
                }
            }
        }
    }
    Some((models, thought_levels))
}

fn is_unsupported_thought_level_error(code: Option<i64>, detail: &str) -> bool {
    if code != Some(-32602) {
        return false;
    }
    let lower = detail.to_ascii_lowercase();
    lower.contains("thinking level")
        || lower.contains("thought_level")
        || lower.contains("not offered")
        || lower.contains("not supported")
}

fn extract_session_id(value: &Value) -> Option<&str> {
    [
        "/params/sessionId",
        "/params/session_id",
        "/sessionId",
        "/session_id",
        "/result/sessionId",
        "/result/session_id",
    ]
    .iter()
    .filter_map(|pointer| value.pointer(pointer).and_then(Value::as_str))
    .map(str::trim)
    .find(|candidate| !candidate.is_empty())
}

fn json_id(value: &Value) -> Option<u64> {
    value.get("id").and_then(|id| {
        id.as_u64()
            .or_else(|| id.as_str().and_then(|text| text.trim().parse().ok()))
    })
}

fn rpc_request_id(value: &Value) -> Option<String> {
    let id = value.get("id")?;
    if id.is_null() {
        return None;
    }
    if let Some(number) = id.as_u64() {
        return Some(number.to_string());
    }
    if let Some(number) = id.as_i64() {
        return Some(number.to_string());
    }
    let text = id.as_str()?.trim();
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

fn rpc_error_text(value: &Value) -> String {
    value
        .get("error")
        .and_then(|error| {
            error
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| error.as_str().map(str::to_string))
        })
        .unwrap_or_else(|| "no detail was reported".to_string())
}

fn extract_update_text(update: &Value) -> String {
    if let Some(text) = update
        .pointer("/content/text")
        .or_else(|| update.get("text"))
        .or_else(|| update.pointer("/delta/text"))
        .and_then(Value::as_str)
    {
        return text.to_string();
    }
    if let Some(parts) = update.get("content").and_then(Value::as_array) {
        let mut combined = String::new();
        for part in parts {
            let kind = part.get("type").and_then(Value::as_str).unwrap_or("text");
            if kind == "text" {
                if let Some(t) = part.get("text").and_then(Value::as_str) {
                    combined.push_str(t);
                }
            }
        }
        return combined;
    }
    String::new()
}

/// Normalizes a single NDJSON line from `agy acp --stdio` into `ParsedLine`.
pub fn parse_agy_acp_line(line: &str, prompt_id: Option<u64>) -> ParsedLine {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return ParsedLine::default();
    }
    let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
        return ParsedLine {
            conversation_id: None,
            events: vec![TransportEvent::Notice(bounded_notice(&format!(
                "antigravity acp wrote a non-JSON line (schema=non-json): {trimmed}"
            )))],
        };
    };

    let session_id = extract_session_id(&value).map(str::to_string);
    let method = value.get("method").and_then(Value::as_str);

    if method.is_none() && (value.get("result").is_some() || value.get("error").is_some()) {
        if prompt_id.is_some() && json_id(&value) == prompt_id {
            if value.get("error").is_some() {
                return ParsedLine {
                    conversation_id: session_id,
                    events: vec![TransportEvent::TurnFailed(bounded_notice(&format!(
                        "antigravity acp error: {}",
                        rpc_error_text(&value)
                    )))],
                };
            }
            let mut events = Vec::new();
            if let Some(usage) = value.pointer("/result/usage").filter(|u| {
                u.is_object()
                    && (u.get("inputTokens").is_some()
                        || u.get("input_tokens").is_some()
                        || u.get("outputTokens").is_some()
                        || u.get("output_tokens").is_some()
                        || u.get("used").is_some())
            }) {
                events.push(TransportEvent::Activity(
                    json!({
                        "jsonrpc": "2.0",
                        "method": "session/update",
                        "params": {
                            "sessionId": session_id.clone().unwrap_or_default(),
                            "update": {
                                "sessionUpdate": "usage_update",
                                "usage": usage
                            }
                        }
                    })
                    .to_string(),
                ));
            }
            if let Some(stop_reason) = value
                .pointer("/result/stopReason")
                .and_then(Value::as_str)
                .map(str::trim)
            {
                if stop_reason.eq_ignore_ascii_case("error")
                    || stop_reason.eq_ignore_ascii_case("failed")
                {
                    let detail = value
                        .pointer("/result/error/message")
                        .or_else(|| value.pointer("/result/error"))
                        .or_else(|| value.pointer("/result/message"))
                        .and_then(Value::as_str)
                        .unwrap_or("antigravity acp ended the turn with an error");
                    return ParsedLine {
                        conversation_id: session_id,
                        events: vec![TransportEvent::TurnFailed(bounded_notice(detail))],
                    };
                }
                if !stop_reason.is_empty()
                    && !matches!(
                        stop_reason.to_ascii_lowercase().as_str(),
                        "end_turn" | "stop" | "stopped" | "completed" | "cancelled"
                    )
                {
                    events.push(TransportEvent::Notice(bounded_notice(&format!(
                        "antigravity acp stopped: {stop_reason}"
                    ))));
                }
            }
            events.push(TransportEvent::TurnEnded);
            return ParsedLine {
                conversation_id: session_id,
                events,
            };
        }
        return ParsedLine {
            conversation_id: session_id,
            events: Vec::new(),
        };
    }

    if method == Some("session/update") {
        let update = value
            .pointer("/params/update")
            .unwrap_or_else(|| value.get("params").unwrap_or(&Value::Null));
        let kind = update
            .get("sessionUpdate")
            .or_else(|| update.get("type"))
            .and_then(Value::as_str)
            .unwrap_or("unknown");

        let events = match kind {
            "agent_message_chunk" | "content_delta" => {
                let raw = extract_update_text(update);
                let clean = crate::chat::threads::sanitize_chat_text(&raw);
                if clean.is_empty() {
                    Vec::new()
                } else {
                    vec![TransportEvent::Text(clean)]
                }
            }
            "agent_thought_chunk"
            | "thought_delta"
            | "tool_call"
            | "tool_call_update"
            | "tool_call_content_chunk"
            | "plan"
            | "plan_update"
            | "usage_update" => vec![TransportEvent::Activity(trimmed.to_string())],
            "turn_completed" | "turn_complete" => {
                let mut out = Vec::new();
                if update.get("usage").is_some() {
                    out.push(TransportEvent::Activity(trimmed.to_string()));
                }
                out.push(TransportEvent::TurnEnded);
                out
            }
            "turn_failed" | "error" => {
                let reason = update
                    .pointer("/error/message")
                    .or_else(|| update.get("error"))
                    .or_else(|| update.get("message"))
                    .or_else(|| update.get("reason"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .unwrap_or("antigravity acp turn failed");
                vec![TransportEvent::TurnFailed(bounded_notice(reason))]
            }
            "available_commands_update"
            | "session_info_update"
            | "hook_execution"
            | "config_option_update"
            | "current_mode_update"
            | "mode_update"
            | "commands_update"
            | "user_message_chunk" => Vec::new(),
            other => vec![TransportEvent::Notice(bounded_notice(&format!(
                "antigravity acp session update `{other}` is not projected (schema={})",
                frame_schema(update)
            )))],
        };
        return ParsedLine {
            conversation_id: session_id,
            events,
        };
    }

    if matches!(
        method,
        Some("session/request_permission")
            | Some("permission/request")
            | Some("x.ai/ask_user_question")
            | Some("_x.ai/ask_user_question")
            | Some("AskUserQuestion")
            | Some("x.ai/exit_plan_mode")
            | Some("_x.ai/exit_plan_mode")
    ) {
        return ParsedLine {
            conversation_id: session_id,
            events: vec![TransportEvent::Activity(trimmed.to_string())],
        };
    }

    if method.is_some() {
        if let Some(id) = rpc_request_id(&value) {
            return ParsedLine {
                conversation_id: session_id,
                events: vec![TransportEvent::UnhandledRequest { id }],
            };
        }
    }

    ParsedLine {
        conversation_id: session_id,
        events: vec![TransportEvent::Notice(bounded_notice(&format!(
            "antigravity acp sent an unknown frame (schema={})",
            frame_schema(&value)
        )))],
    }
}

pub(crate) struct SpawnedAgyAcpProcess {
    pub stdin: Box<dyn Write + Send>,
    pub stdout: Box<dyn Read + Send>,
    pub stderr: Option<Box<dyn Read + Send>>,
    pub child: Option<HiddenChild>,
    pub killer: Option<Box<dyn FnMut() + Send>>,
}

pub(crate) trait AgyAcpSpawner: Send + Sync + fmt::Debug {
    fn spawn(
        &self,
        program: &Path,
        cwd: Option<&Path>,
        extra_env: &[(String, String)],
    ) -> Result<SpawnedAgyAcpProcess, String>;
}

#[derive(Debug, Default)]
struct RealAgyAcpSpawner;

impl AgyAcpSpawner for RealAgyAcpSpawner {
    fn spawn(
        &self,
        program: &Path,
        cwd: Option<&Path>,
        extra_env: &[(String, String)],
    ) -> Result<SpawnedAgyAcpProcess, String> {
        let mut child =
            spawn_streaming_with_owned_env(program, &AGY_ACP_ARGS, cwd, extra_env).map_err(
                |error| {
                    format!(
                        "could not start shared antigravity acp daemon with {}: {error}",
                        program.display()
                    )
                },
            )?;
        let Some(stdin) = child.stdin.take() else {
            let _ = child.kill();
            return Err("shared antigravity acp daemon started without writable stdin".to_string());
        };
        let Some(stdout) = child.stdout.take() else {
            let _ = child.kill();
            return Err("shared antigravity acp daemon started without readable stdout".to_string());
        };
        let stderr = child.stderr.take();
        Ok(SpawnedAgyAcpProcess {
            stdin,
            stdout,
            stderr,
            child: Some(child),
            killer: None,
        })
    }
}

#[derive(Debug, Default)]
struct SessionMailbox {
    events: VecDeque<TransportEvent>,
    in_flight_prompt_id: Option<u64>,
    prompt_settled: bool,
    exit_emitted: bool,
}

#[derive(Default)]
struct SessionRegistry {
    by_session: HashMap<String, Arc<Mutex<SessionMailbox>>>,
    prompt_owners: HashMap<u64, String>,
}

#[derive(Default)]
struct RpcWaiters {
    waiters: HashMap<u64, Option<Value>>,
}

struct DaemonLifecycle {
    leases: usize,
    last_active_at: Instant,
    initialized: bool,
    killed: bool,
    child: Option<HiddenChild>,
    killer: Option<Box<dyn FnMut() + Send>>,
    stdout_reader: Option<JoinHandle<()>>,
    stderr_reader: Option<JoinHandle<()>>,
    stderr_tail: Arc<Mutex<String>>,
}

impl Default for DaemonLifecycle {
    fn default() -> Self {
        Self {
            leases: 0,
            last_active_at: Instant::now(),
            initialized: false,
            killed: false,
            child: None,
            killer: None,
            stdout_reader: None,
            stderr_reader: None,
            stderr_tail: Arc::new(Mutex::new(String::new())),
        }
    }
}

struct DaemonSharedState {
    next_id: AtomicU64,
    eof: AtomicBool,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    rpc: Mutex<RpcWaiters>,
    rpc_cv: Condvar,
    sessions: Mutex<SessionRegistry>,
    lifecycle: Mutex<DaemonLifecycle>,
}

impl DaemonSharedState {
    fn new(initial_leases: usize) -> Self {
        Self {
            next_id: AtomicU64::new(1),
            eof: AtomicBool::new(false),
            writer: Mutex::new(None),
            rpc: Mutex::new(RpcWaiters::default()),
            rpc_cv: Condvar::new(),
            sessions: Mutex::new(SessionRegistry::default()),
            lifecycle: Mutex::new(DaemonLifecycle {
                leases: initial_leases,
                last_active_at: Instant::now(),
                ..DaemonLifecycle::default()
            }),
        }
    }
}

pub(crate) struct AgyAcpDaemon {
    init_lock: Mutex<()>,
    state: Arc<DaemonSharedState>,
}

impl fmt::Debug for AgyAcpDaemon {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AgyAcpDaemon")
            .field("active_sessions", &self.active_session_count())
            .field("eof", &self.is_eof())
            .finish()
    }
}

impl AgyAcpDaemon {
    fn new_with_lease() -> Arc<Self> {
        Arc::new(Self {
            init_lock: Mutex::new(()),
            state: Arc::new(DaemonSharedState::new(1)),
        })
    }

    fn alloc_id(&self) -> u64 {
        self.state.next_id.fetch_add(1, Ordering::Relaxed)
    }

    fn is_eof(&self) -> bool {
        self.state.eof.load(Ordering::SeqCst)
    }

    fn is_alive(&self) -> bool {
        if self.is_eof() {
            return false;
        }
        self.state
            .lifecycle
            .lock()
            .map(|lc| !lc.killed)
            .unwrap_or(false)
    }

    fn try_acquire_lease(&self) -> bool {
        if self.is_eof() {
            return false;
        }
        let Ok(mut lc) = self.state.lifecycle.lock() else {
            return false;
        };
        if lc.killed || self.is_eof() {
            return false;
        }
        lc.leases += 1;
        lc.last_active_at = Instant::now();
        true
    }

    fn release_lease(&self) {
        if let Ok(mut lc) = self.state.lifecycle.lock() {
            lc.leases = lc.leases.saturating_sub(1);
            lc.last_active_at = Instant::now();
        }
    }

    fn touch_activity(&self) {
        if let Ok(mut lc) = self.state.lifecycle.lock() {
            lc.last_active_at = Instant::now();
        }
    }

    fn active_session_count(&self) -> usize {
        self.state
            .sessions
            .lock()
            .map(|reg| reg.by_session.len())
            .unwrap_or(0)
    }

    fn has_session(&self, session_id: &str) -> bool {
        self.state
            .sessions
            .lock()
            .map(|reg| reg.by_session.contains_key(session_id))
            .unwrap_or(false)
    }

    fn register_session(&self, session_id: &str) -> Arc<Mutex<SessionMailbox>> {
        let mailbox = Arc::new(Mutex::new(SessionMailbox::default()));
        if let Ok(mut reg) = self.state.sessions.lock() {
            reg.by_session
                .insert(session_id.to_string(), Arc::clone(&mailbox));
        }
        self.touch_activity();
        mailbox
    }

    fn unregister_session(&self, session_id: &str) {
        if let Ok(mut reg) = self.state.sessions.lock() {
            reg.by_session.remove(session_id);
            reg.prompt_owners.retain(|_, owner| owner != session_id);
        }
        self.touch_activity();
    }

    fn write_raw(&self, frame: &str) -> Result<(), String> {
        if self.is_eof() {
            return Err("the shared antigravity acp daemon ended".to_string());
        }
        let mut guard = self
            .state
            .writer
            .lock()
            .map_err(|_| "the antigravity acp writer lock was poisoned".to_string())?;
        let Some(stdin) = guard.as_mut() else {
            return Err("the shared antigravity acp daemon has no open stdin".to_string());
        };
        let payload = frame.trim_end();
        stdin
            .write_all(payload.as_bytes())
            .and_then(|_| stdin.write_all(b"\n"))
            .and_then(|_| stdin.flush())
            .map_err(|error| {
                format!("could not write to the shared antigravity acp daemon: {error}")
            })?;
        drop(guard);
        self.touch_activity();
        Ok(())
    }

    fn call_rpc(&self, id: u64, frame: &str, timeout: Duration) -> Result<Value, String> {
        {
            let mut rpc = self
                .state
                .rpc
                .lock()
                .map_err(|_| "the antigravity acp rpc lock was poisoned".to_string())?;
            if self.is_eof() {
                return Err("the shared antigravity acp daemon ended before answering".to_string());
            }
            rpc.waiters.insert(id, None);
        }

        if let Err(err) = self.write_raw(frame) {
            if let Ok(mut rpc) = self.state.rpc.lock() {
                rpc.waiters.remove(&id);
            }
            return Err(err);
        }

        let deadline = Instant::now() + timeout;
        let mut rpc = self
            .state
            .rpc
            .lock()
            .map_err(|_| "the antigravity acp rpc lock was poisoned".to_string())?;
        loop {
            if let Some(Some(resp)) = rpc.waiters.get(&id).cloned() {
                rpc.waiters.remove(&id);
                return Ok(resp);
            }
            if self.is_eof() {
                rpc.waiters.remove(&id);
                return Err("the shared antigravity acp daemon ended before answering".to_string());
            }
            let now = Instant::now();
            if now >= deadline {
                rpc.waiters.remove(&id);
                return Err(format!(
                    "the shared antigravity acp daemon did not answer within {} ms",
                    timeout.as_millis()
                ));
            }
            let (next, _) = self
                .state
                .rpc_cv
                .wait_timeout(rpc, deadline - now)
                .map_err(|_| "the antigravity acp rpc lock was poisoned".to_string())?;
            rpc = next;
        }
    }

    fn ensure_initialized(
        &self,
        spawner: &dyn AgyAcpSpawner,
        program: &Path,
        cwd: Option<&Path>,
        extra_env: &[(String, String)],
    ) -> Result<(), String> {
        let _init_guard = self
            .init_lock
            .lock()
            .map_err(|_| "the antigravity acp init lock was poisoned".to_string())?;

        {
            let lc = self
                .state
                .lifecycle
                .lock()
                .map_err(|_| "the antigravity acp lifecycle lock was poisoned".to_string())?;
            if lc.killed {
                return Err("the shared antigravity acp daemon was shut down".to_string());
            }
            if lc.initialized && !self.is_eof() {
                return Ok(());
            }
        }

        let mut spawned = spawner.spawn(program, cwd, extra_env)?;
        let tail = Arc::new(Mutex::new(String::new()));
        let stderr_reader = spawned.stderr.take().and_then(|mut pipe| {
            let tail_ref = Arc::clone(&tail);
            std::thread::Builder::new()
                .name("agy-acp-stderr".to_string())
                .spawn(move || read_tail(&mut pipe, tail_ref))
                .ok()
        });

        self.state.eof.store(false, Ordering::SeqCst);
        {
            let mut writer = self
                .state
                .writer
                .lock()
                .map_err(|_| "the antigravity acp writer lock was poisoned".to_string())?;
            *writer = Some(spawned.stdin);
        }

        let state_for_reader = Arc::clone(&self.state);
        let stdout = spawned.stdout;
        let stdout_reader = match std::thread::Builder::new()
            .name("agy-acp-demux".to_string())
            .spawn(move || read_daemon_stdout(stdout, state_for_reader))
        {
            Ok(handle) => handle,
            Err(err) => {
                if let Ok(mut writer) = self.state.writer.lock() {
                    *writer = None;
                }
                if let Some(mut child) = spawned.child.take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                if let Some(mut killer) = spawned.killer.take() {
                    killer();
                }
                if let Some(handle) = stderr_reader {
                    let _ = handle.join();
                }
                return Err(format!(
                    "could not start antigravity acp demux reader thread: {err}"
                ));
            }
        };

        {
            let mut lc = self
                .state
                .lifecycle
                .lock()
                .map_err(|_| "the antigravity acp lifecycle lock was poisoned".to_string())?;
            lc.child = spawned.child;
            lc.killer = spawned.killer;
            lc.stdout_reader = Some(stdout_reader);
            lc.stderr_reader = stderr_reader;
            lc.stderr_tail = tail;
            lc.last_active_at = Instant::now();
        }

        let init_id = self.alloc_id();
        let init_res = self.call_rpc(
            init_id,
            &agy_acp_initialize_line(init_id),
            AGY_ACP_HANDSHAKE_TIMEOUT,
        );
        match init_res {
            Ok(resp) if resp.get("error").is_none() => {
                if let Ok(mut lc) = self.state.lifecycle.lock() {
                    lc.initialized = true;
                    lc.last_active_at = Instant::now();
                }
                Ok(())
            }
            Ok(resp) => {
                let err = format!(
                    "antigravity acp refused initialize: {}",
                    rpc_error_text(&resp)
                );
                self.shutdown();
                Err(err)
            }
            Err(err) => {
                self.shutdown();
                Err(err)
            }
        }
    }

    fn shutdown(&self) {
        let (child, killer, stdout_reader, stderr_reader) = {
            let Ok(mut lc) = self.state.lifecycle.lock() else {
                return;
            };
            lc.killed = true;
            lc.initialized = false;
            (
                lc.child.take(),
                lc.killer.take(),
                lc.stdout_reader.take(),
                lc.stderr_reader.take(),
            )
        };
        self.state.eof.store(true, Ordering::SeqCst);
        self.state.rpc_cv.notify_all();
        if let Ok(mut writer) = self.state.writer.lock() {
            *writer = None;
        }
        if let Some(mut child) = child {
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Some(mut killer) = killer {
            killer();
        }
        if let Some(handle) = stdout_reader {
            let _ = handle.join();
        }
        if let Some(handle) = stderr_reader {
            let _ = handle.join();
        }
    }

    fn try_mark_idle_for_reap(&self, idle_timeout: Duration) -> bool {
        let has_sessions = self
            .state
            .sessions
            .lock()
            .map(|reg| !reg.by_session.is_empty())
            .unwrap_or(true);
        if has_sessions {
            return false;
        }
        let Ok(mut lc) = self.state.lifecycle.lock() else {
            return false;
        };
        if lc.killed || lc.leases > 0 {
            return false;
        }
        if lc.last_active_at.elapsed() >= idle_timeout {
            lc.killed = true;
            true
        } else {
            false
        }
    }
}

fn handle_daemon_eof(state: &Arc<DaemonSharedState>) {
    state.eof.store(true, Ordering::SeqCst);
    state.rpc_cv.notify_all();

    let (killed, mut child, stderr_reader, stderr_tail) = {
        let Ok(mut lc) = state.lifecycle.lock() else {
            return;
        };
        (
            lc.killed,
            lc.child.take(),
            lc.stderr_reader.take(),
            Arc::clone(&lc.stderr_tail),
        )
    };

    let code = child.as_mut().and_then(|c| c.wait().ok());
    if let Some(handle) = stderr_reader {
        let _ = handle.join();
    }
    if killed {
        return;
    }

    let tail = stderr_tail
        .lock()
        .map(|s| s.clone())
        .unwrap_or_default();
    let error = match code {
        Some(0) => None,
        Some(other) => Some(format!(
            "antigravity acp exited with code {other}{}",
            tail_detail(&tail)
        )),
        None => Some(format!(
            "antigravity acp exited unexpectedly{}",
            tail_detail(&tail)
        )),
    };

    let mailboxes: Vec<Arc<Mutex<SessionMailbox>>> = state
        .sessions
        .lock()
        .map(|reg| reg.by_session.values().cloned().collect())
        .unwrap_or_default();

    for mb in mailboxes {
        if let Ok(mut guard) = mb.lock() {
            if !guard.exit_emitted {
                guard.exit_emitted = true;
                push_bounded(
                    &mut guard.events,
                    TransportEvent::Exit {
                        code,
                        error: error.clone(),
                    },
                );
            }
        }
    }
}

fn read_daemon_stdout(stdout: Box<dyn Read + Send>, state: Arc<DaemonSharedState>) {
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
                    chat_log(&format!(
                        "antigravity acp non-json stdout line ignored: {}",
                        bounded_notice(trimmed)
                    ));
                    continue;
                };

                let method = value.get("method").and_then(Value::as_str);
                if method.is_none()
                    && (value.get("result").is_some() || value.get("error").is_some())
                {
                    if let Some(id) = json_id(&value) {
                        {
                            if let Ok(mut rpc) = state.rpc.lock() {
                                if let Some(slot) = rpc.waiters.get_mut(&id) {
                                    *slot = Some(value.clone());
                                    state.rpc_cv.notify_all();
                                }
                            }
                        }

                        let prompt_owner = state
                            .sessions
                            .lock()
                            .ok()
                            .and_then(|mut reg| {
                                let sid = reg.prompt_owners.remove(&id)?;
                                reg.by_session.get(&sid).cloned()
                            });
                        if let Some(mailbox) = prompt_owner {
                            let parsed = parse_agy_acp_line(trimmed, Some(id));
                            if let Ok(mut mb) = mailbox.lock() {
                                if mb.in_flight_prompt_id == Some(id) {
                                    mb.in_flight_prompt_id = None;
                                }
                                if !mb.prompt_settled {
                                    mb.prompt_settled = true;
                                    for ev in parsed.events {
                                        push_bounded(&mut mb.events, ev);
                                    }
                                }
                            }
                        }
                    }
                    continue;
                }

                let session_id = extract_session_id(&value).map(str::to_string);
                let parsed = parse_agy_acp_line(trimmed, None);
                if let Some(sid) = session_id {
                    let mailbox = state
                        .sessions
                        .lock()
                        .ok()
                        .and_then(|reg| reg.by_session.get(&sid).cloned());
                    if let Some(mailbox) = mailbox {
                        if let Ok(mut mb) = mailbox.lock() {
                            // Ignore unprompted notifications such as `session/load` history replay
                            // or trailing frames after turn settlement so prior replies cannot leak
                            // into the follow-up turn.
                            if mb.in_flight_prompt_id.is_some() {
                                for ev in parsed.events {
                                    if matches!(
                                        ev,
                                        TransportEvent::TurnEnded | TransportEvent::TurnFailed(_)
                                    ) {
                                        mb.prompt_settled = true;
                                        mb.in_flight_prompt_id = None;
                                    }
                                    push_bounded(&mut mb.events, ev);
                                }
                            }
                        }
                    }
                } else {
                    for ev in parsed.events {
                        if let TransportEvent::UnhandledRequest { id } = ev {
                            let reply = unhandled_request_reply(&id);
                            if let Ok(mut writer) = state.writer.lock() {
                                if let Some(stdin) = writer.as_mut() {
                                    let _ = stdin.write_all(reply.as_bytes());
                                    let _ = stdin.write_all(b"\n");
                                    let _ = stdin.flush();
                                }
                            }
                        }
                    }
                }
            }
            Err(_) => break,
        }
    }
    handle_daemon_eof(&state);
}

/// Global pool of multiplexed `agy acp --stdio --disable-telemetry` daemons,
/// keyed by `(connection_id_or_default, env_fingerprint)`.
pub struct SharedAgyAcpPool {
    daemons: HashMap<AgyAcpPoolKey, Arc<AgyAcpDaemon>>,
    spawner: Arc<dyn AgyAcpSpawner>,
}

impl fmt::Debug for SharedAgyAcpPool {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let (daemons, sessions) = self.stats();
        formatter
            .debug_struct("SharedAgyAcpPool")
            .field("active_daemons", &daemons)
            .field("active_sessions", &sessions)
            .finish()
    }
}

impl Default for SharedAgyAcpPool {
    fn default() -> Self {
        Self::new()
    }
}

impl SharedAgyAcpPool {
    pub fn new() -> Self {
        Self::with_spawner(Arc::new(RealAgyAcpSpawner))
    }

    pub(crate) fn with_spawner(spawner: Arc<dyn AgyAcpSpawner>) -> Self {
        Self {
            daemons: HashMap::new(),
            spawner,
        }
    }

    /// Returns `(active_daemon_count, active_session_count)`.
    pub fn stats(&self) -> (usize, usize) {
        let mut daemon_count = 0usize;
        let mut session_count = 0usize;
        for daemon in self.daemons.values() {
            if daemon.is_alive() {
                daemon_count += 1;
                session_count += daemon.active_session_count();
            }
        }
        (daemon_count, session_count)
    }

    fn take_idle_or_dead_daemons(&mut self, idle_timeout: Duration) -> Vec<Arc<AgyAcpDaemon>> {
        let mut keys_to_remove = Vec::new();
        let mut to_shutdown = Vec::new();

        for (key, daemon) in &self.daemons {
            if daemon.try_mark_idle_for_reap(idle_timeout) {
                keys_to_remove.push(key.clone());
                to_shutdown.push(Arc::clone(daemon));
            } else if daemon.is_eof() {
                let no_leases = daemon
                    .state
                    .lifecycle
                    .lock()
                    .map(|lc| lc.leases == 0)
                    .unwrap_or(false);
                if no_leases && daemon.active_session_count() == 0 {
                    keys_to_remove.push(key.clone());
                }
            }
        }

        for key in keys_to_remove {
            self.daemons.remove(&key);
        }

        to_shutdown
    }

    /// Reaps daemons with `active_sessions == 0` whose idle duration is `>= idle_timeout`.
    pub fn reap_idle_daemons(&mut self, idle_timeout: Duration) -> usize {
        let to_shutdown = self.take_idle_or_dead_daemons(idle_timeout);
        let reaped = to_shutdown.len();
        for daemon in to_shutdown {
            daemon.shutdown();
        }
        reaped
    }

    fn acquire_leased_slot(
        &mut self,
        key: &AgyAcpPoolKey,
    ) -> (Arc<AgyAcpDaemon>, Arc<dyn AgyAcpSpawner>) {
        if let Some(existing) = self.daemons.get(key) {
            if existing.try_acquire_lease() {
                return (Arc::clone(existing), Arc::clone(&self.spawner));
            }
        }
        let fresh = AgyAcpDaemon::new_with_lease();
        self.daemons.insert(key.clone(), Arc::clone(&fresh));
        (fresh, Arc::clone(&self.spawner))
    }

    fn remove_if_same(&mut self, key: &AgyAcpPoolKey, candidate: &Arc<AgyAcpDaemon>) {
        if self
            .daemons
            .get(key)
            .is_some_and(|current| Arc::ptr_eq(current, candidate))
        {
            self.daemons.remove(key);
        }
    }

    #[cfg(test)]
    pub(crate) fn age_daemon_idle_for_test(&self, key: &AgyAcpPoolKey, age: Duration) {
        if let Some(daemon) = self.daemons.get(key) {
            if let Ok(mut lc) = daemon.state.lifecycle.lock() {
                if let Some(backdated) = Instant::now().checked_sub(age) {
                    lc.last_active_at = backdated;
                }
            }
        }
    }
}

/// Global singleton pool for multiplexed `agy acp --stdio` daemons.
pub fn global_agy_acp_pool() -> &'static Mutex<SharedAgyAcpPool> {
    static POOL: OnceLock<Mutex<SharedAgyAcpPool>> = OnceLock::new();
    POOL.get_or_init(|| Mutex::new(SharedAgyAcpPool::new()))
}

fn reap_idle_in_pool(pool: &Mutex<SharedAgyAcpPool>, idle_timeout: Duration) -> usize {
    let to_shutdown = {
        let Ok(mut guard) = pool.lock() else {
            return 0;
        };
        guard.take_idle_or_dead_daemons(idle_timeout)
    };
    let count = to_shutdown.len();
    for daemon in to_shutdown {
        daemon.shutdown();
    }
    count
}

/// Kills all pooled `agy acp` daemons with zero active sessions whose idle
/// elapsed time meets or exceeds `idle_timeout`.
pub fn reap_idle_agy_acp_daemons(idle_timeout: Duration) -> usize {
    reap_idle_in_pool(global_agy_acp_pool(), idle_timeout)
}

/// Returns `(active_daemon_count, active_session_count)` for the global pool.
pub fn agy_acp_pool_stats() -> (usize, usize) {
    global_agy_acp_pool()
        .lock()
        .map(|pool| pool.stats())
        .unwrap_or((0, 0))
}

fn acquire_or_create_daemon(
    pool: &Mutex<SharedAgyAcpPool>,
    key: &AgyAcpPoolKey,
    program: &Path,
    cwd: Option<&Path>,
    extra_env: &[(String, String)],
) -> Result<Arc<AgyAcpDaemon>, String> {
    let (daemon, spawner) = {
        let mut guard = pool
            .lock()
            .map_err(|_| "the shared antigravity acp pool lock was poisoned".to_string())?;
        guard.acquire_leased_slot(key)
    };

    if let Err(err) = daemon.ensure_initialized(spawner.as_ref(), program, cwd, extra_env) {
        daemon.release_lease();
        if let Ok(mut guard) = pool.lock() {
            guard.remove_if_same(key, &daemon);
        }
        return Err(err);
    }

    Ok(daemon)
}

/// Session transport backed by one logical ACP session inside a shared
/// `agy acp --stdio --disable-telemetry` daemon.
pub struct AgyAcpSessionHandle {
    controls: PersistentControls,
    applied_controls: PersistentControls,
    available_models: Vec<String>,
    available_thought_levels: Option<Vec<String>>,
    connection_id: Option<String>,
    program: Option<PathBuf>,
    probe: Box<dyn DriverProbe>,
    pool: Option<Arc<Mutex<SharedAgyAcpPool>>>,
    daemon: Option<Arc<AgyAcpDaemon>>,
    session_id: Option<String>,
    mailbox: Option<Arc<Mutex<SessionMailbox>>>,
    resume: Arc<Mutex<Option<String>>>,
    stopping: bool,
    spawns: u32,
}

impl AgyAcpSessionHandle {
    pub fn new(controls: PersistentControls) -> Self {
        Self::with_probe(controls, None, Box::new(SystemDriverProbe))
    }

    pub fn with_program(controls: PersistentControls, program: Option<PathBuf>) -> Self {
        Self::with_probe(controls, program, Box::new(SystemDriverProbe))
    }

    pub fn with_probe(
        controls: PersistentControls,
        program: Option<PathBuf>,
        probe: Box<dyn DriverProbe>,
    ) -> Self {
        Self {
            applied_controls: controls.clone(),
            controls,
            available_models: Vec::new(),
            available_thought_levels: None,
            connection_id: None,
            program,
            probe,
            pool: None,
            daemon: None,
            session_id: None,
            mailbox: None,
            resume: Arc::new(Mutex::new(None)),
            stopping: false,
            spawns: 0,
        }
    }

    pub fn with_connection_id(mut self, connection_id: Option<String>) -> Self {
        self.connection_id = connection_id
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        self
    }

    #[cfg(test)]
    pub(crate) fn with_pool_and_probe(
        controls: PersistentControls,
        pool: Arc<Mutex<SharedAgyAcpPool>>,
        program: Option<PathBuf>,
        probe: Box<dyn DriverProbe>,
    ) -> Self {
        let mut handle = Self::with_probe(controls, program, probe);
        handle.pool = Some(pool);
        handle
    }

    fn target_pool(&self) -> &Mutex<SharedAgyAcpPool> {
        match &self.pool {
            Some(custom) => custom.as_ref(),
            None => global_agy_acp_pool(),
        }
    }

    fn apply_config_option(
        daemon: &AgyAcpDaemon,
        session_id: &str,
        config_id: &str,
        value: &str,
        mailbox: Option<&Arc<Mutex<SessionMailbox>>>,
    ) -> Result<Value, String> {
        let id = daemon.alloc_id();
        let line = agy_acp_config_line(id, session_id, config_id, value);
        let resp = daemon.call_rpc(id, &line, AGY_ACP_HANDSHAKE_TIMEOUT)?;
        if resp.get("error").is_some() {
            let code = resp.pointer("/error/code").and_then(Value::as_i64);
            let detail = rpc_error_text(&resp);
            if code == Some(-32601)
                || (config_id == "thought_level" && is_unsupported_thought_level_error(code, &detail))
            {
                if let Some(mb) = mailbox {
                    if let Ok(mut guard) = mb.lock() {
                        push_bounded(
                            &mut guard.events,
                            TransportEvent::Notice(bounded_notice(&format!(
                                "antigravity acp ignored config `{config_id}`: {detail}"
                            ))),
                        );
                    }
                }
                return Ok(Value::Null);
            }
            return Err(format!(
                "antigravity acp rejected config option `{config_id}` (`{value}`): {detail}"
            ));
        }
        Ok(resp)
    }

    #[allow(clippy::too_many_arguments)]
    fn apply_controls_to_session(
        daemon: &AgyAcpDaemon,
        session_id: &str,
        controls: &PersistentControls,
        previous: Option<&PersistentControls>,
        available_models: &mut Vec<String>,
        available_thought_levels: &mut Option<Vec<String>>,
        accepts_model: bool,
        accepts_effort: bool,
        accepts_permission: bool,
        mailbox: Option<&Arc<Mutex<SessionMailbox>>>,
    ) -> Result<(), String> {
        let (resolved_model, resolved_thought) = resolve_agy_model_and_thought(
            controls.model.as_deref(),
            controls.effort.as_deref(),
            available_models,
        );
        let resolved_mode = map_agy_permission_mode(controls.permission_mode.as_deref());

        let (prev_model, prev_thought, prev_mode) = match previous {
            Some(prev) => {
                let (pm, pt) = resolve_agy_model_and_thought(
                    prev.model.as_deref(),
                    prev.effort.as_deref(),
                    available_models,
                );
                let pmode = map_agy_permission_mode(prev.permission_mode.as_deref());
                (pm, pt, pmode)
            }
            None => (None, None, None),
        };

        let mut model_changed = false;
        if accepts_model {
            if let Some(ref model_val) = resolved_model {
                if previous.is_none() || prev_model.as_deref() != Some(model_val.as_str()) {
                    let resp =
                        Self::apply_config_option(daemon, session_id, "model", model_val, mailbox)?;
                    model_changed = true;
                    if let Some((next_models, next_thoughts)) =
                        extract_config_options_snapshot(&resp)
                    {
                        if !next_models.is_empty() {
                            *available_models = next_models;
                        }
                        *available_thought_levels = Some(next_thoughts);
                    }
                }
            }
        }
        if accepts_effort {
            let effective_thought: Option<String> = match (
                resolved_thought,
                available_thought_levels.as_deref(),
            ) {
                (Some(thought), Some(offered)) => {
                    if offered.is_empty() {
                        None
                    } else {
                        crate::chat::models::clamp_effort_to_levels(thought, offered)
                    }
                }
                (Some(thought), None) => crate::chat::models::sanitize_antigravity_cli_effort(
                    resolved_model.as_deref(),
                    Some(thought),
                )
                .and_then(|eff| normalize_agy_thought_level(Some(&eff)).map(str::to_string)),
                (None, _) => None,
            };
            if let Some(ref thought_val) = effective_thought {
                if previous.is_none()
                    || model_changed
                    || prev_thought != Some(thought_val.as_str())
                {
                    let _ = Self::apply_config_option(
                        daemon,
                        session_id,
                        "thought_level",
                        thought_val,
                        mailbox,
                    )?;
                }
            }
        }
        if accepts_permission {
            if let Some(mode_val) = resolved_mode {
                if previous.is_none() || prev_mode != Some(mode_val) {
                    let _ =
                        Self::apply_config_option(daemon, session_id, "mode", mode_val, mailbox)?;
                }
            }
        }

        Ok(())
    }

    fn close_session_internal(&mut self, wait_close_ack: bool) {
        self.stopping = true;
        self.available_models.clear();
        self.available_thought_levels = None;
        let Some(daemon) = self.daemon.take() else {
            self.session_id = None;
            self.mailbox = None;
            return;
        };
        let session_id = self.session_id.take();
        self.mailbox = None;

        if let Some(sid) = session_id {
            if !daemon.is_eof() {
                let close_id = daemon.alloc_id();
                let close_frame = agy_acp_close_line(close_id, &sid);
                if wait_close_ack {
                    let _ = daemon.call_rpc(close_id, &close_frame, AGY_ACP_CLOSE_TIMEOUT);
                } else {
                    let _ = daemon.write_raw(&close_frame);
                }
            }
            daemon.unregister_session(&sid);
        }
        daemon.release_lease();
    }
}

impl fmt::Debug for AgyAcpSessionHandle {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AgyAcpSessionHandle")
            .field("controls", &self.controls)
            .field("connection_id", &self.connection_id)
            .field("session_id", &self.session_id)
            .field("spawns", &self.spawns)
            .field("stopping", &self.stopping)
            .finish()
    }
}

impl SessionTransport for AgyAcpSessionHandle {
    fn spawn(&mut self, spec: &TransportSpec) -> Result<(), String> {
        if self.session_id.is_some() && !self.stopping && self.is_alive() {
            return Err("the antigravity acp session is already running".to_string());
        }
        if self.daemon.is_some() {
            self.close_session_internal(false);
        }

        let declared = declaration(&spec.driver)
            .ok_or_else(|| format!("{} has no driver declaration in this build", spec.driver))?;
        if declared.driver != ANTIGRAVITY_DRIVER {
            return Err(format!(
                "{} does not speak the antigravity acp wire",
                spec.driver
            ));
        }

        let program = match self.program.clone() {
            Some(program) => program,
            None => resolve_antigravity_acp_program()?,
        };
        verify_driver_version(ANTIGRAVITY_DRIVER, &program, self.probe.as_ref())?;

        let pool_key = pool_key_for(self.connection_id.as_deref(), &spec.extra_env);
        let daemon_cwd = spec.working_directory.as_deref().map(Path::new);
        let daemon_env = shared_daemon_env(&spec.extra_env);
        let daemon = acquire_or_create_daemon(
            self.target_pool(),
            &pool_key,
            &program,
            daemon_cwd,
            &daemon_env,
        )?;

        let session_cwd = spec
            .working_directory
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(".");
        let requested_resume = spec
            .resume_handle
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);

        let (session_id, mailbox, open_response) = if let Some(ref handle) = requested_resume {
            let mailbox = daemon.register_session(handle);
            let open_id = daemon.alloc_id();
            let open_line = agy_acp_session_load_line(open_id, handle, session_cwd);
            match daemon.call_rpc(open_id, &open_line, AGY_ACP_HANDSHAKE_TIMEOUT) {
                Ok(resp) if resp.get("error").is_none() => {
                    let resolved_sid = extract_session_id(&resp)
                        .map(str::to_string)
                        .unwrap_or_else(|| handle.clone());
                    let final_mb = if resolved_sid != *handle {
                        daemon.unregister_session(handle);
                        daemon.register_session(&resolved_sid)
                    } else {
                        mailbox
                    };
                    if let Ok(mut mb) = final_mb.lock() {
                        mb.events.retain(|ev| matches!(ev, TransportEvent::Exit { .. }));
                    }
                    (resolved_sid, final_mb, resp)
                }
                Ok(resp) => {
                    daemon.unregister_session(handle);
                    daemon.release_lease();
                    return Err(format!(
                        "antigravity acp refused session/load: {}",
                        rpc_error_text(&resp)
                    ));
                }
                Err(err) => {
                    daemon.unregister_session(handle);
                    daemon.release_lease();
                    return Err(err);
                }
            }
        } else {
            let open_id = daemon.alloc_id();
            let open_line = agy_acp_session_new_line(open_id, session_cwd);
            let resp = match daemon.call_rpc(open_id, &open_line, AGY_ACP_HANDSHAKE_TIMEOUT) {
                Ok(resp) if resp.get("error").is_none() => resp,
                Ok(resp) => {
                    daemon.release_lease();
                    return Err(format!(
                        "antigravity acp refused session/new: {}",
                        rpc_error_text(&resp)
                    ));
                }
                Err(err) => {
                    daemon.release_lease();
                    return Err(err);
                }
            };
            let Some(sid) = extract_session_id(&resp).map(str::to_string) else {
                daemon.release_lease();
                return Err("antigravity acp session/new did not return a sessionId".to_string());
            };
            let mailbox = daemon.register_session(&sid);
            (sid, mailbox, resp)
        };

        let (mut available_models, mut available_thought_levels) =
            match extract_config_options_snapshot(&open_response) {
                Some((models, thoughts)) => (models, Some(thoughts)),
                None => (extract_available_model_options(&open_response), None),
            };
        if let Err(err) = Self::apply_controls_to_session(
            &daemon,
            &session_id,
            &self.controls,
            None,
            &mut available_models,
            &mut available_thought_levels,
            declared.accepts_model,
            declared.accepts_effort,
            declared.accepts_permission,
            Some(&mailbox),
        ) {
            if !daemon.is_eof() {
                let close_id = daemon.alloc_id();
                let _ = daemon.write_raw(&agy_acp_close_line(close_id, &session_id));
            }
            daemon.unregister_session(&session_id);
            daemon.release_lease();
            return Err(err);
        }

        if let Ok(mut resume) = self.resume.lock() {
            *resume = Some(session_id.clone());
        }
        self.daemon = Some(daemon);
        self.session_id = Some(session_id);
        self.mailbox = Some(mailbox);
        self.available_models = available_models;
        self.available_thought_levels = available_thought_levels;
        self.applied_controls = self.controls.clone();
        self.stopping = false;
        self.spawns += 1;
        Ok(())
    }

    fn write_turn(&mut self, prompt: &str) -> Result<(), String> {
        if self.stopping {
            return Err("the antigravity acp session is already stopped".to_string());
        }
        let Some(daemon) = self.daemon.clone() else {
            return Err("the antigravity acp session has not spawned".to_string());
        };
        let Some(session_id) = self.session_id.clone() else {
            return Err("the antigravity acp session has no sessionId".to_string());
        };
        let Some(mailbox) = self.mailbox.clone() else {
            return Err("the antigravity acp session has no event mailbox".to_string());
        };
        if daemon.is_eof() {
            return Err("the shared antigravity acp daemon ended before the turn".to_string());
        }

        if self.applied_controls != self.controls {
            Self::apply_controls_to_session(
                &daemon,
                &session_id,
                &self.controls,
                Some(&self.applied_controls),
                &mut self.available_models,
                &mut self.available_thought_levels,
                true,
                true,
                true,
                Some(&mailbox),
            )?;
            self.applied_controls = self.controls.clone();
        }

        let prompt_id = daemon.alloc_id();
        {
            if let Ok(mut mb) = mailbox.lock() {
                mb.events.retain(|ev| matches!(ev, TransportEvent::Exit { .. }));
                mb.in_flight_prompt_id = Some(prompt_id);
                mb.prompt_settled = false;
            }
            if let Ok(mut reg) = daemon.state.sessions.lock() {
                reg.prompt_owners.insert(prompt_id, session_id.clone());
            }
        }

        let frame = agy_acp_prompt_line(prompt_id, &session_id, prompt);
        if let Err(err) = daemon.write_raw(&frame) {
            if let Ok(mut mb) = mailbox.lock() {
                if mb.in_flight_prompt_id == Some(prompt_id) {
                    mb.in_flight_prompt_id = None;
                }
            }
            if let Ok(mut reg) = daemon.state.sessions.lock() {
                reg.prompt_owners.remove(&prompt_id);
            }
            return Err(err);
        }
        Ok(())
    }

    fn write_frame(&mut self, frame: &str) -> Result<(), String> {
        if self.stopping {
            return Err("the antigravity acp session is already stopped".to_string());
        }
        let Some(daemon) = &self.daemon else {
            return Err("the antigravity acp session has no active daemon".to_string());
        };
        daemon.write_raw(frame)
    }

    fn interrupt(&mut self) -> Result<(), String> {
        if self.stopping {
            return Ok(());
        }
        let has_in_flight = self
            .mailbox
            .as_ref()
            .and_then(|mb| mb.lock().ok().map(|g| g.in_flight_prompt_id.is_some()))
            .unwrap_or(false);
        if has_in_flight {
            if let (Some(daemon), Some(sid)) = (&self.daemon, &self.session_id) {
                if !daemon.is_eof() {
                    let _ = daemon.write_raw(&agy_acp_cancel_line(sid));
                }
            }
        }
        self.close_session_internal(true);
        Ok(())
    }

    fn stop(&mut self) -> Result<(), String> {
        if self.stopping && self.daemon.is_none() {
            return Ok(());
        }
        self.close_session_internal(true);
        Ok(())
    }

    fn spawn_count(&self) -> u32 {
        self.spawns
    }

    fn resume_handle(&self) -> Option<String> {
        self.resume.lock().ok().and_then(|guard| guard.clone())
    }

    fn drain(&mut self) -> Vec<TransportEvent> {
        let Some(mailbox) = &self.mailbox else {
            return Vec::new();
        };
        mailbox
            .lock()
            .map(|mut mb| mb.events.drain(..).collect())
            .unwrap_or_default()
    }

    fn is_alive(&self) -> bool {
        if self.spawns == 0 {
            return !self.stopping;
        }
        if self.stopping {
            return false;
        }
        match (&self.daemon, &self.session_id) {
            (Some(daemon), Some(sid)) => daemon.is_alive() && daemon.has_session(sid),
            _ => false,
        }
    }

    fn controls(&self) -> Option<PersistentControls> {
        Some(self.controls.clone())
    }

    fn update_controls(&mut self, next: &PersistentControls) -> bool {
        if self.spawns == 0 {
            self.controls = next.clone();
            self.applied_controls = next.clone();
            return true;
        }
        if !self.is_alive() {
            return false;
        }
        if self.controls == *next {
            return true;
        }
        let (Some(daemon), Some(session_id)) = (&self.daemon, &self.session_id) else {
            return false;
        };
        match Self::apply_controls_to_session(
            daemon,
            session_id,
            next,
            Some(&self.controls),
            &mut self.available_models,
            &mut self.available_thought_levels,
            true,
            true,
            true,
            self.mailbox.as_ref(),
        ) {
            Ok(()) => {
                self.controls = next.clone();
                self.applied_controls = next.clone();
                true
            }
            Err(_) => false,
        }
    }
}

impl Drop for AgyAcpSessionHandle {
    fn drop(&mut self) {
        if self.daemon.is_some() {
            self.close_session_internal(false);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::drivers::DriverVersion;
    use crate::chat::session::SessionMode;
    use std::sync::atomic::AtomicUsize;

    #[derive(Debug)]
    struct FakeAgyProbe {
        version: String,
    }

    impl DriverProbe for FakeAgyProbe {
        fn probe(
            &self,
            _driver: &str,
            _program: &Path,
            _evidence: &DriverVersion,
        ) -> Result<String, String> {
            Ok(self.version.clone())
        }
    }

    fn fake_probe() -> Box<dyn DriverProbe> {
        Box::new(FakeAgyProbe {
            version: "1.5.17".to_string(),
        })
    }

    fn spec_for(thread_id: &str, resume_handle: Option<&str>) -> TransportSpec {
        TransportSpec {
            session_id: format!("{thread_id}:1"),
            driver: "antigravity".to_string(),
            working_directory: Some(".".to_string()),
            mode: SessionMode::Persistent,
            recipe_revision: Some("rev-1".to_string()),
            resume_handle: resume_handle.map(str::to_string),
            extra_env: Vec::new(),
        }
    }

    #[derive(Default)]
    struct PipeInner {
        buf: VecDeque<u8>,
        closed: bool,
    }

    #[derive(Clone)]
    struct PipeWriter(Arc<(Mutex<PipeInner>, Condvar)>);

    #[derive(Clone)]
    struct PipeReader(Arc<(Mutex<PipeInner>, Condvar)>);

    fn memory_pipe() -> (PipeWriter, PipeReader) {
        let shared = Arc::new((Mutex::new(PipeInner::default()), Condvar::new()));
        (PipeWriter(Arc::clone(&shared)), PipeReader(shared))
    }

    impl PipeWriter {
        fn close(&self) {
            let (lock, cv) = &*self.0;
            if let Ok(mut inner) = lock.lock() {
                inner.closed = true;
                cv.notify_all();
            }
        }
    }

    impl Write for PipeWriter {
        fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
            let (lock, cv) = &*self.0;
            let mut inner = lock.lock().unwrap();
            if inner.closed {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::BrokenPipe,
                    "pipe closed",
                ));
            }
            inner.buf.extend(data);
            cv.notify_all();
            Ok(data.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl Drop for PipeWriter {
        fn drop(&mut self) {
            self.close();
        }
    }

    impl Read for PipeReader {
        fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
            if out.is_empty() {
                return Ok(0);
            }
            let (lock, cv) = &*self.0;
            let mut inner = lock.lock().unwrap();
            while inner.buf.is_empty() && !inner.closed {
                inner = cv.wait(inner).unwrap();
            }
            if inner.buf.is_empty() && inner.closed {
                return Ok(0);
            }
            let count = out.len().min(inner.buf.len());
            for slot in out.iter_mut().take(count) {
                *slot = inner.buf.pop_front().unwrap();
            }
            Ok(count)
        }
    }

    #[derive(Debug)]
    struct MockServerRecord {
        spawns: AtomicUsize,
        kills: AtomicUsize,
        requests: Mutex<Vec<Value>>,
        closed_sessions: Mutex<Vec<String>>,
    }

    impl MockServerRecord {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                spawns: AtomicUsize::new(0),
                kills: AtomicUsize::new(0),
                requests: Mutex::new(Vec::new()),
                closed_sessions: Mutex::new(Vec::new()),
            })
        }

        fn requests_for_method(&self, method: &str) -> Vec<Value> {
            self.requests
                .lock()
                .unwrap()
                .iter()
                .filter(|v| v.get("method").and_then(Value::as_str) == Some(method))
                .cloned()
                .collect()
        }
    }

    #[derive(Debug)]
    struct MockAgyAcpSpawner {
        record: Arc<MockServerRecord>,
        interleave_on_prompt: bool,
    }

    impl MockAgyAcpSpawner {
        fn new(record: Arc<MockServerRecord>, interleave_on_prompt: bool) -> Arc<Self> {
            Arc::new(Self {
                record,
                interleave_on_prompt,
            })
        }
    }

    impl AgyAcpSpawner for MockAgyAcpSpawner {
        fn spawn(
            &self,
            _program: &Path,
            _cwd: Option<&Path>,
            _extra_env: &[(String, String)],
        ) -> Result<SpawnedAgyAcpProcess, String> {
            let spawn_idx = self.record.spawns.fetch_add(1, Ordering::SeqCst) + 1;
            let (c2s_w, c2s_r) = memory_pipe();
            let (s2c_w, s2c_r) = memory_pipe();

            let s2c_killer = s2c_w.clone();
            let c2s_killer = c2s_w.clone();
            let record = Arc::clone(&self.record);
            let record_for_kill = Arc::clone(&self.record);
            let interleave = self.interleave_on_prompt;

            std::thread::spawn(move || {
                let mut reader = BufReader::new(c2s_r);
                let mut line = String::new();
                let mut next_session = 0usize;
                let mut s2c = s2c_w;

                let write_frame = |writer: &mut PipeWriter, payload: Value| -> bool {
                    let text = format!("{payload}\n");
                    writer.write_all(text.as_bytes()).is_ok()
                };

                loop {
                    line.clear();
                    match reader.read_line(&mut line) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {
                            let trimmed = line.trim();
                            if trimmed.is_empty() {
                                continue;
                            }
                            let Ok(req) = serde_json::from_str::<Value>(trimmed) else {
                                continue;
                            };
                            record.requests.lock().unwrap().push(req.clone());
                            let id = req.get("id").cloned();
                            let method = req.get("method").and_then(Value::as_str).unwrap_or("");
                            match method {
                                "initialize" => {
                                    let _ = write_frame(
                                        &mut s2c,
                                        json!({
                                            "jsonrpc": "2.0",
                                            "id": id,
                                            "result": {
                                                "protocolVersion": 1,
                                                "agentInfo": {
                                                    "name": "Antigravity ACP Server",
                                                    "version": "1.5.17"
                                                }
                                            }
                                        }),
                                    );
                                }
                                "session/new" => {
                                    next_session += 1;
                                    let sid = format!("d{spawn_idx}-s{next_session}");
                                    let _ = write_frame(
                                        &mut s2c,
                                        json!({
                                            "jsonrpc": "2.0",
                                            "id": id,
                                            "result": {
                                                "sessionId": sid,
                                                "configOptions": [
                                                    {
                                                        "id": "model",
                                                        "options": [
                                                            { "value": "gemini-4-neon" },
                                                            { "value": "gemini-4-argon" },
                                                            { "value": "gpt-oss-120b-medium" }
                                                        ]
                                                    },
                                                    {
                                                        "id": "thought_level",
                                                        "options": [
                                                            { "value": "low" },
                                                            { "value": "medium" },
                                                            { "value": "high" },
                                                            { "value": "xhigh" }
                                                        ]
                                                    },
                                                    {
                                                        "id": "mode",
                                                        "options": [
                                                            { "value": "default" },
                                                            { "value": "accept-edits" },
                                                            { "value": "auto" },
                                                            { "value": "plan" }
                                                        ]
                                                    }
                                                ]
                                            }
                                        }),
                                    );
                                }
                                "session/load" => {
                                    let sid = req
                                        .pointer("/params/sessionId")
                                        .and_then(Value::as_str)
                                        .unwrap_or("loaded-1");
                                    let _ = write_frame(
                                        &mut s2c,
                                        json!({
                                            "jsonrpc": "2.0",
                                            "id": id,
                                            "result": {
                                                "sessionId": sid,
                                                "configOptions": []
                                            }
                                        }),
                                    );
                                }
                                "session/set_config_option" => {
                                    let sid = req
                                        .pointer("/params/sessionId")
                                        .and_then(Value::as_str)
                                        .unwrap_or("");
                                    let cfg_id = req
                                        .pointer("/params/configId")
                                        .and_then(Value::as_str)
                                        .unwrap_or("");
                                    let cfg_val = req
                                        .pointer("/params/value")
                                        .and_then(Value::as_str)
                                        .unwrap_or("");
                                    if cfg_id == "mode" && !cfg_val.is_empty() {
                                        let _ = write_frame(
                                            &mut s2c,
                                            json!({
                                                "jsonrpc": "2.0",
                                                "method": "session/update",
                                                "params": {
                                                    "sessionId": sid,
                                                    "update": {
                                                        "sessionUpdate": "current_mode_update",
                                                        "currentModeId": cfg_val
                                                    }
                                                }
                                            }),
                                        );
                                    }
                                    if cfg_id == "model" && cfg_val == "gemini-pro-orchestrator-neon" {
                                        let _ = write_frame(
                                            &mut s2c,
                                            json!({
                                                "jsonrpc": "2.0",
                                                "id": id,
                                                "result": {
                                                    "configOptions": [
                                                        {
                                                            "id": "model",
                                                            "currentValue": "gemini-pro-orchestrator-neon",
                                                            "options": [
                                                                { "value": "gemini-4-neon" },
                                                                { "value": "gemini-4-argon" },
                                                                { "value": "gemini-pro-orchestrator-neon" },
                                                                { "value": "gpt-oss-120b-medium" }
                                                            ]
                                                        },
                                                        {
                                                            "id": "mode",
                                                            "options": [
                                                                { "value": "default" },
                                                                { "value": "accept-edits" },
                                                                { "value": "auto" },
                                                                { "value": "plan" }
                                                            ]
                                                        }
                                                    ]
                                                }
                                            }),
                                        );
                                    } else if cfg_id == "model" && cfg_val == "gemini-4-narrow" {
                                        let _ = write_frame(
                                            &mut s2c,
                                            json!({
                                                "jsonrpc": "2.0",
                                                "id": id,
                                                "result": {
                                                    "configOptions": [
                                                        {
                                                            "id": "model",
                                                            "currentValue": "gemini-4-narrow",
                                                            "options": [
                                                                { "value": "gemini-4-neon" },
                                                                { "value": "gemini-4-narrow" },
                                                                { "value": "gemini-pro-orchestrator-neon" },
                                                                { "value": "gpt-oss-120b-medium" }
                                                            ]
                                                        },
                                                        {
                                                            "id": "thought_level",
                                                            "currentValue": "medium",
                                                            "options": [
                                                                { "value": "low" },
                                                                { "value": "medium" },
                                                                { "value": "high" }
                                                            ]
                                                        },
                                                        {
                                                            "id": "mode",
                                                            "options": [
                                                                { "value": "default" },
                                                                { "value": "accept-edits" },
                                                                { "value": "auto" },
                                                                { "value": "plan" }
                                                            ]
                                                        }
                                                    ]
                                                }
                                            }),
                                        );
                                    } else {
                                        let _ = write_frame(
                                            &mut s2c,
                                            json!({
                                                "jsonrpc": "2.0",
                                                "id": id,
                                                "result": { "configOptions": [] }
                                            }),
                                        );
                                    }
                                }
                                "session/prompt" => {
                                    let sid = req
                                        .pointer("/params/sessionId")
                                        .and_then(Value::as_str)
                                        .unwrap_or("")
                                        .to_string();
                                    let prompt = req
                                        .pointer("/params/prompt/0/text")
                                        .and_then(Value::as_str)
                                        .unwrap_or("")
                                        .to_string();
                                    if prompt == "__crash__" {
                                        s2c.close();
                                        break;
                                    }
                                    let _ = write_frame(
                                        &mut s2c,
                                        json!({
                                            "jsonrpc": "2.0",
                                            "method": "session/update",
                                            "params": {
                                                "sessionId": sid,
                                                "update": {
                                                    "sessionUpdate": "agent_thought_chunk",
                                                    "content": { "type": "text", "text": format!("thinking:{sid}") }
                                                }
                                            }
                                        }),
                                    );
                                    if interleave {
                                        let _ = write_frame(
                                            &mut s2c,
                                            json!({
                                                "jsonrpc": "2.0",
                                                "method": "session/update",
                                                "params": {
                                                    "sessionId": sid,
                                                    "update": {
                                                        "sessionUpdate": "tool_call",
                                                        "toolCallId": format!("call-{sid}"),
                                                        "title": "Read file",
                                                        "kind": "read",
                                                        "status": "completed"
                                                    }
                                                }
                                            }),
                                        );
                                    }
                                    let _ = write_frame(
                                        &mut s2c,
                                        json!({
                                            "jsonrpc": "2.0",
                                            "method": "session/update",
                                            "params": {
                                                "sessionId": sid,
                                                "update": {
                                                    "sessionUpdate": "agent_message_chunk",
                                                    "content": { "type": "text", "text": format!("reply[{sid}]:{prompt}") }
                                                }
                                            }
                                        }),
                                    );
                                    let _ = write_frame(
                                        &mut s2c,
                                        json!({
                                            "jsonrpc": "2.0",
                                            "id": id,
                                            "result": { "stopReason": "end_turn" }
                                        }),
                                    );
                                }
                                "session/close" => {
                                    let sid = req
                                        .pointer("/params/sessionId")
                                        .and_then(Value::as_str)
                                        .unwrap_or("")
                                        .to_string();
                                    record.closed_sessions.lock().unwrap().push(sid);
                                    let _ = write_frame(
                                        &mut s2c,
                                        json!({
                                            "jsonrpc": "2.0",
                                            "id": id,
                                            "result": {}
                                        }),
                                    );
                                }
                                _ => {
                                    if id.is_some() {
                                        let _ = write_frame(
                                            &mut s2c,
                                            json!({
                                                "jsonrpc": "2.0",
                                                "id": id,
                                                "result": {}
                                            }),
                                        );
                                    }
                                }
                            }
                        }
                    }
                }
            });

            Ok(SpawnedAgyAcpProcess {
                stdin: Box::new(c2s_w),
                stdout: Box::new(s2c_r),
                stderr: None,
                child: None,
                killer: Some(Box::new(move || {
                    record_for_kill.kills.fetch_add(1, Ordering::SeqCst);
                    c2s_killer.close();
                    s2c_killer.close();
                })),
            })
        }
    }

    fn drain_until_turn_ended(handle: &mut AgyAcpSessionHandle) -> Vec<TransportEvent> {
        let mut collected = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            let chunk = handle.drain();
            let done = chunk.iter().any(|ev| {
                matches!(
                    ev,
                    TransportEvent::TurnEnded | TransportEvent::TurnFailed(_)
                )
            });
            collected.extend(chunk);
            if done {
                return collected;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        panic!("timed out waiting for TurnEnded; collected={collected:?}");
    }

    #[test]
    fn three_concurrent_sessions_demux_strictly_by_session_id() {
        let record = MockServerRecord::new();
        let spawner = MockAgyAcpSpawner::new(Arc::clone(&record), true);
        let pool = Arc::new(Mutex::new(SharedAgyAcpPool::with_spawner(spawner)));

        let mut handles: Vec<AgyAcpSessionHandle> = (0..3)
            .map(|_| {
                AgyAcpSessionHandle::with_pool_and_probe(
                    PersistentControls::default(),
                    Arc::clone(&pool),
                    Some(PathBuf::from("mock-agy")),
                    fake_probe(),
                )
            })
            .collect();

        for (idx, handle) in handles.iter_mut().enumerate() {
            let mut spec = spec_for(&format!("thread-{idx}"), None);
            // Per-thread correlation env vars must NOT fragment the shared daemon pool.
            spec.extra_env = vec![
                ("KITE_THREAD_ID".to_string(), format!("thread-{idx}")),
                ("KITE_ADDRESS".to_string(), format!("thread:thread-{idx}")),
                ("KITE_SESSION_ID".to_string(), format!("thread-{idx}")),
            ];
            handle.spawn(&spec).expect("spawn session on shared daemon");
        }

        assert_eq!(record.spawns.load(Ordering::SeqCst), 1);
        assert_eq!(pool.lock().unwrap().stats(), (1, 3));

        let session_ids: Vec<String> = handles
            .iter()
            .map(|h| h.resume_handle().expect("sessionId"))
            .collect();
        assert_eq!(session_ids, vec!["d1-s1", "d1-s2", "d1-s3"]);

        std::thread::scope(|scope| {
            let mut workers = Vec::new();
            for (idx, handle) in handles.iter_mut().enumerate() {
                let expected_sid = session_ids[idx].clone();
                workers.push(scope.spawn(move || {
                    let prompt = format!("hello-from-{idx}");
                    handle.write_turn(&prompt).expect("write_turn");
                    let events = drain_until_turn_ended(handle);
                    let texts: Vec<String> = events
                        .iter()
                        .filter_map(|ev| match ev {
                            TransportEvent::Text(t) => Some(t.clone()),
                            _ => None,
                        })
                        .collect();
                    assert_eq!(texts, vec![format!("reply[{expected_sid}]:{prompt}")]);

                    let activities: Vec<&str> = events
                        .iter()
                        .filter_map(|ev| match ev {
                            TransportEvent::Activity(raw) => Some(raw.as_str()),
                            _ => None,
                        })
                        .collect();
                    assert_eq!(activities.len(), 2);
                    for act in activities {
                        assert!(
                            act.contains(&expected_sid),
                            "activity leaked across sessions: {act} expected {expected_sid}"
                        );
                    }
                    assert_eq!(events.last(), Some(&TransportEvent::TurnEnded));
                }));
            }
            for worker in workers {
                worker.join().unwrap();
            }
        });
    }

    #[test]
    fn session_close_frees_one_session_without_killing_siblings() {
        let record = MockServerRecord::new();
        let spawner = MockAgyAcpSpawner::new(Arc::clone(&record), false);
        let pool = Arc::new(Mutex::new(SharedAgyAcpPool::with_spawner(spawner)));

        let mut h1 = AgyAcpSessionHandle::with_pool_and_probe(
            PersistentControls::default(),
            Arc::clone(&pool),
            Some(PathBuf::from("mock-agy")),
            fake_probe(),
        );
        let mut h2 = AgyAcpSessionHandle::with_pool_and_probe(
            PersistentControls::default(),
            Arc::clone(&pool),
            Some(PathBuf::from("mock-agy")),
            fake_probe(),
        );
        let mut h3 = AgyAcpSessionHandle::with_pool_and_probe(
            PersistentControls::default(),
            Arc::clone(&pool),
            Some(PathBuf::from("mock-agy")),
            fake_probe(),
        );

        h1.spawn(&spec_for("t1", None)).unwrap();
        h2.spawn(&spec_for("t2", None)).unwrap();
        h3.spawn(&spec_for("t3", None)).unwrap();
        let sid2 = h2.resume_handle().unwrap();
        assert_eq!(pool.lock().unwrap().stats(), (1, 3));

        h2.stop().expect("stop session 2");
        assert!(!h2.is_alive());
        assert_eq!(h2.resume_handle().as_deref(), Some(sid2.as_str()));
        assert_eq!(record.kills.load(Ordering::SeqCst), 0);
        assert_eq!(pool.lock().unwrap().stats(), (1, 2));
        assert_eq!(*record.closed_sessions.lock().unwrap(), vec![sid2]);

        assert!(h1.is_alive());
        assert!(h3.is_alive());
        h1.write_turn("still alive 1").unwrap();
        h3.write_turn("still alive 3").unwrap();
        let ev1 = drain_until_turn_ended(&mut h1);
        let ev3 = drain_until_turn_ended(&mut h3);
        assert!(ev1
            .iter()
            .any(|ev| matches!(ev, TransportEvent::Text(t) if t.contains("still alive 1"))));
        assert!(ev3
            .iter()
            .any(|ev| matches!(ev, TransportEvent::Text(t) if t.contains("still alive 3"))));
    }

    #[test]
    fn observed_config_options_model_thought_level_and_mode_are_sent_and_updated() {
        let record = MockServerRecord::new();
        let spawner = MockAgyAcpSpawner::new(Arc::clone(&record), false);
        let pool = Arc::new(Mutex::new(SharedAgyAcpPool::with_spawner(spawner)));

        let controls = PersistentControls {
            model: Some("gemini-4-argon-high".to_string()),
            effort: Some("xhigh".to_string()),
            permission_mode: Some("acceptEdits".to_string()),
        };
        let mut handle = AgyAcpSessionHandle::with_pool_and_probe(
            controls,
            Arc::clone(&pool),
            Some(PathBuf::from("mock-agy")),
            fake_probe(),
        );
        handle.spawn(&spec_for("cfg-thread", None)).unwrap();

        let cfg_reqs = record.requests_for_method("session/set_config_option");
        assert_eq!(cfg_reqs.len(), 3);
        assert_eq!(cfg_reqs[0]["params"]["configId"], "model");
        assert_eq!(cfg_reqs[0]["params"]["value"], "gemini-4-argon");
        assert_eq!(cfg_reqs[1]["params"]["configId"], "thought_level");
        assert_eq!(cfg_reqs[1]["params"]["value"], "xhigh");
        assert_eq!(cfg_reqs[2]["params"]["configId"], "mode");
        assert_eq!(cfg_reqs[2]["params"]["value"], "accept-edits");

        let updated = PersistentControls {
            model: Some("gemini-4-neon".to_string()),
            effort: Some("low".to_string()),
            permission_mode: Some("readOnly".to_string()),
        };
        assert!(handle.update_controls(&updated));
        let cfg_reqs = record.requests_for_method("session/set_config_option");
        assert_eq!(cfg_reqs.len(), 6);
        assert_eq!(cfg_reqs[3]["params"]["configId"], "model");
        assert_eq!(cfg_reqs[3]["params"]["value"], "gemini-4-neon");
        assert_eq!(cfg_reqs[4]["params"]["configId"], "thought_level");
        assert_eq!(cfg_reqs[4]["params"]["value"], "low");
        assert_eq!(cfg_reqs[5]["params"]["configId"], "mode");
        assert_eq!(cfg_reqs[5]["params"]["value"], "plan");

        let sid = handle.resume_handle().unwrap();
        handle.stop().unwrap();

        let mut resumed = AgyAcpSessionHandle::with_pool_and_probe(
            PersistentControls {
                model: Some("gemini-4-neon".to_string()),
                effort: Some("medium".to_string()),
                permission_mode: Some("auto".to_string()),
            },
            Arc::clone(&pool),
            Some(PathBuf::from("mock-agy")),
            fake_probe(),
        );
        resumed.spawn(&spec_for("cfg-thread", Some(&sid))).unwrap();
        let loads = record.requests_for_method("session/load");
        assert_eq!(loads.len(), 1);
        assert_eq!(loads[0]["params"]["sessionId"], sid);
        let cfg_reqs = record.requests_for_method("session/set_config_option");
        assert_eq!(cfg_reqs.last().unwrap()["params"]["configId"], "mode");
        assert_eq!(cfg_reqs.last().unwrap()["params"]["value"], "auto");
    }

    #[test]
    fn reap_idle_daemons_preserves_active_sessions_and_reaps_zero_session_past_ttl() {
        let record = MockServerRecord::new();
        let spawner = MockAgyAcpSpawner::new(Arc::clone(&record), false);
        let pool = Arc::new(Mutex::new(SharedAgyAcpPool::with_spawner(spawner)));

        let mut active_handle = AgyAcpSessionHandle::with_pool_and_probe(
            PersistentControls::default(),
            Arc::clone(&pool),
            Some(PathBuf::from("mock-agy")),
            fake_probe(),
        )
        .with_connection_id(Some("conn-active".to_string()));
        active_handle.spawn(&spec_for("active", None)).unwrap();

        let mut idle_handle = AgyAcpSessionHandle::with_pool_and_probe(
            PersistentControls::default(),
            Arc::clone(&pool),
            Some(PathBuf::from("mock-agy")),
            fake_probe(),
        )
        .with_connection_id(Some("conn-idle".to_string()));
        idle_handle.spawn(&spec_for("idle", None)).unwrap();
        assert_eq!(pool.lock().unwrap().stats(), (2, 2));

        idle_handle.stop().unwrap();
        assert_eq!(pool.lock().unwrap().stats(), (2, 1));
        assert_eq!(record.kills.load(Ordering::SeqCst), 0);

        // Before TTL expires, zero-session daemon stays warm.
        assert_eq!(reap_idle_in_pool(&pool, Duration::from_secs(60)), 0);
        assert_eq!(pool.lock().unwrap().stats(), (2, 1));

        // Age both keys past TTL: only the zero-session daemon is reaped; the active daemon remains.
        let active_key = pool_key_for(Some("conn-active"), &[]);
        let idle_key = pool_key_for(Some("conn-idle"), &[]);
        {
            let guard = pool.lock().unwrap();
            guard.age_daemon_idle_for_test(&active_key, Duration::from_secs(120));
            guard.age_daemon_idle_for_test(&idle_key, Duration::from_secs(120));
        }

        assert_eq!(reap_idle_in_pool(&pool, Duration::from_secs(60)), 1);
        assert_eq!(record.kills.load(Ordering::SeqCst), 1);
        assert_eq!(pool.lock().unwrap().stats(), (1, 1));
        assert!(active_handle.is_alive());

        active_handle.stop().unwrap();
        assert_eq!(reap_idle_in_pool(&pool, Duration::ZERO), 1);
        assert_eq!(record.kills.load(Ordering::SeqCst), 2);
        assert_eq!(pool.lock().unwrap().stats(), (0, 0));
    }

    #[test]
    fn parse_agy_acp_line_maps_updates_permissions_and_errors_cleanly() {
        let text = parse_agy_acp_line(
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s-1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hello acp"}}}}"#,
            None,
        );
        assert_eq!(text.conversation_id.as_deref(), Some("s-1"));
        assert_eq!(text.events, vec![TransportEvent::Text("hello acp".to_string())]);

        let perm = parse_agy_acp_line(
            r#"{"jsonrpc":"2.0","id":"perm-1","method":"session/request_permission","params":{"sessionId":"s-1","toolCall":{"toolCallId":"tc-1","name":"shell"}}}"#,
            None,
        );
        assert_eq!(perm.conversation_id.as_deref(), Some("s-1"));
        assert!(matches!(perm.events.first(), Some(TransportEvent::Activity(_))));

        for housekeeping in [
            "available_commands_update",
            "config_option_update",
            "current_mode_update",
            "session_info_update",
        ] {
            let line = format!(
                r#"{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"s-1","update":{{"sessionUpdate":"{housekeeping}"}}}}}}"#
            );
            assert!(parse_agy_acp_line(&line, None).events.is_empty());
        }

        let failed = parse_agy_acp_line(
            r#"{"jsonrpc":"2.0","id":42,"error":{"code":-32000,"message":"quota reached"}}"#,
            Some(42),
        );
        assert!(matches!(
            failed.events.first(),
            Some(TransportEvent::TurnFailed(reason)) if reason.contains("quota reached")
        ));

        let with_usage_and_reason = parse_agy_acp_line(
            r#"{"jsonrpc":"2.0","id":43,"result":{"stopReason":"max_tokens","usage":{"inputTokens":1200,"outputTokens":350}}}"#,
            Some(43),
        );
        assert_eq!(with_usage_and_reason.events.len(), 3);
        let usage_activity = match &with_usage_and_reason.events[0] {
            TransportEvent::Activity(line) => line.clone(),
            other => panic!("expected Activity, got {other:?}"),
        };
        assert!(matches!(
            &with_usage_and_reason.events[1],
            TransportEvent::Notice(msg) if msg.contains("max_tokens")
        ));
        assert_eq!(with_usage_and_reason.events[2], TransportEvent::TurnEnded);

        let mut tracker = crate::chat::normalize::ToolCallTracker::default();
        let parsed_usage = tracker.ingest(&serde_json::from_str::<Value>(&usage_activity).unwrap());
        assert!(matches!(
            parsed_usage.first(),
            Some(crate::chat::normalize::ProviderTurnEvent::UsageUpdated { usage })
                if usage.input_tokens == 1200 && usage.output_tokens == 350
        ));
    }

    #[test]
    fn pool_key_env_fingerprint_and_drop_cleanup() {
        let base = vec![
            ("KITE_THREAD_ID".to_string(), "t-1".to_string()),
            ("KITE_ADDRESS".to_string(), "thread:t-1".to_string()),
            ("KITE_SESSION_ID".to_string(), "t-1".to_string()),
            ("KITE_MODEL".to_string(), "gemini-4-neon".to_string()),
            ("KITE_WORKSPACE_ID".to_string(), "ws-1".to_string()),
        ];
        let same_daemon = vec![
            ("KITE_THREAD_ID".to_string(), "t-2".to_string()),
            ("KITE_ADDRESS".to_string(), "thread:t-2".to_string()),
            ("KITE_SESSION_ID".to_string(), "t-2".to_string()),
            ("KITE_MODEL".to_string(), "gemini-4-argon".to_string()),
            ("KITE_WORKSPACE_ID".to_string(), "ws-1".to_string()),
        ];
        let diff_daemon = vec![
            ("KITE_THREAD_ID".to_string(), "t-3".to_string()),
            ("KITE_WORKSPACE_ID".to_string(), "ws-2".to_string()),
        ];

        assert_eq!(
            pool_key_for(None, &base),
            pool_key_for(None, &same_daemon),
            "per-thread env vars must coalesce onto the same daemon key"
        );
        assert_ne!(
            pool_key_for(None, &base),
            pool_key_for(None, &diff_daemon),
            "different daemon-scoped env vars must isolate onto distinct keys"
        );
        assert_ne!(
            pool_key_for(Some("conn-a"), &base),
            pool_key_for(Some("conn-b"), &base),
            "different connections must isolate onto distinct keys"
        );

        let record = MockServerRecord::new();
        let spawner = MockAgyAcpSpawner::new(Arc::clone(&record), false);
        let pool = Arc::new(Mutex::new(SharedAgyAcpPool::with_spawner(spawner)));

        {
            let mut h1 = AgyAcpSessionHandle::with_pool_and_probe(
                PersistentControls::default(),
                Arc::clone(&pool),
                Some(PathBuf::from("mock-agy")),
                fake_probe(),
            );
            h1.spawn(&spec_for("drop-1", None)).unwrap();
            assert_eq!(pool.lock().unwrap().stats(), (1, 1));
        }

        // Dropping handle without explicit stop() releases session and lease cleanly.
        assert_eq!(pool.lock().unwrap().stats(), (1, 0));
        assert_eq!(reap_idle_in_pool(&pool, Duration::ZERO), 1);
        assert_eq!(pool.lock().unwrap().stats(), (0, 0));
    }

    #[test]
    fn interrupt_and_unexpected_daemon_eof_emit_clean_events() {
        let record = MockServerRecord::new();
        let spawner = MockAgyAcpSpawner::new(Arc::clone(&record), false);
        let pool = Arc::new(Mutex::new(SharedAgyAcpPool::with_spawner(spawner)));

        let mut h1 = AgyAcpSessionHandle::with_pool_and_probe(
            PersistentControls::default(),
            Arc::clone(&pool),
            Some(PathBuf::from("mock-agy")),
            fake_probe(),
        );
        let mut h2 = AgyAcpSessionHandle::with_pool_and_probe(
            PersistentControls::default(),
            Arc::clone(&pool),
            Some(PathBuf::from("mock-agy")),
            fake_probe(),
        );
        h1.spawn(&spec_for("int-1", None)).unwrap();
        h2.spawn(&spec_for("int-2", None)).unwrap();
        let sid1 = h1.resume_handle().unwrap();

        h1.interrupt().expect("interrupt session 1");
        assert!(!h1.is_alive());
        assert_eq!(h1.resume_handle().as_deref(), Some(sid1.as_str()));
        assert!(h2.is_alive());
        assert_eq!(pool.lock().unwrap().stats(), (1, 1));

        // Trigger unexpected daemon crash/EOF while h2 is open -> Exit must reach h2.
        h2.write_turn("__crash__").unwrap();

        let deadline = Instant::now() + Duration::from_secs(2);
        let mut saw_exit = false;
        while Instant::now() < deadline {
            if h2
                .drain()
                .iter()
                .any(|ev| matches!(ev, TransportEvent::Exit { .. }))
            {
                saw_exit = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(saw_exit, "unexpected daemon EOF must emit Exit to active sessions");
        assert!(!h2.is_alive());
        assert_eq!(pool.lock().unwrap().stats(), (0, 0));
    }

    #[test]
    fn acp_omits_thought_level_when_model_drops_it_and_clamps_narrow_tiers() {
        let record = MockServerRecord::new();
        let spawner = MockAgyAcpSpawner::new(Arc::clone(&record), false);
        let pool = Arc::new(Mutex::new(SharedAgyAcpPool::with_spawner(spawner)));

        // 1. Spawn on gemini-pro-orchestrator-neon with stale effort="high":
        //    ACP set_config_option("model", "gemini-pro-orchestrator-neon") returns configOptions
        //    WITHOUT thought_level -> thought_level MUST NOT be sent!
        let mut handle = AgyAcpSessionHandle::with_pool_and_probe(
            PersistentControls {
                model: Some("gemini-pro-orchestrator-neon".to_string()),
                effort: Some("high".to_string()),
                permission_mode: Some("fullAccess".to_string()),
            },
            Arc::clone(&pool),
            Some(PathBuf::from("mock-agy")),
            fake_probe(),
        );
        handle.spawn(&spec_for("orch-thread", None)).expect("spawn orchestrator session");

        let cfg_reqs = record.requests_for_method("session/set_config_option");
        assert_eq!(cfg_reqs.len(), 2, "must send only model + mode, never thought_level: {cfg_reqs:?}");
        assert_eq!(cfg_reqs[0]["params"]["configId"], "model");
        assert_eq!(cfg_reqs[0]["params"]["value"], "gemini-pro-orchestrator-neon");
        assert_eq!(cfg_reqs[1]["params"]["configId"], "mode");
        assert!(
            !cfg_reqs.iter().any(|r| r["params"]["configId"] == "thought_level"),
            "thought_level must be omitted for orchestrator model"
        );

        // 2. Switch mid-session to gemini-4-narrow (only offers low|medium|high) with effort="xhigh":
        //    thought_level must clamp xhigh -> high!
        assert!(handle.update_controls(&PersistentControls {
            model: Some("gemini-4-narrow".to_string()),
            effort: Some("xhigh".to_string()),
            permission_mode: Some("fullAccess".to_string()),
        }));
        let cfg_reqs = record.requests_for_method("session/set_config_option");
        assert_eq!(cfg_reqs.len(), 4, "expected model + clamped thought_level: {cfg_reqs:?}");
        assert_eq!(cfg_reqs[2]["params"]["configId"], "model");
        assert_eq!(cfg_reqs[2]["params"]["value"], "gemini-4-narrow");
        assert_eq!(cfg_reqs[3]["params"]["configId"], "thought_level");
        assert_eq!(cfg_reqs[3]["params"]["value"], "high");

        // 3. Switch mid-session to gpt-oss-120b: retained available_models must resolve to gpt-oss-120b-medium!
        assert!(handle.update_controls(&PersistentControls {
            model: Some("gpt-oss-120b".to_string()),
            effort: None,
            permission_mode: Some("fullAccess".to_string()),
        }));
        let cfg_reqs = record.requests_for_method("session/set_config_option");
        assert_eq!(cfg_reqs.last().unwrap()["params"]["configId"], "model");
        assert_eq!(cfg_reqs.last().unwrap()["params"]["value"], "gpt-oss-120b-medium");
    }

    #[test]
    fn session_load_history_replay_and_idle_updates_do_not_leak_into_next_turn() {
        let daemon = AgyAcpDaemon::new_with_lease();
        let mailbox = daemon.register_session("s-replay");

        let replay_lines = [
            json!({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": "s-replay",
                    "update": {
                        "sessionUpdate": "user_message_chunk",
                        "content": { "type": "text", "text": "Prior user prompt" }
                    }
                }
            })
            .to_string(),
            json!({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": "s-replay",
                    "update": {
                        "sessionUpdate": "agent_thought_chunk",
                        "content": { "type": "text", "text": "Prior thought" }
                    }
                }
            })
            .to_string(),
            json!({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": "s-replay",
                    "update": {
                        "sessionUpdate": "tool_call",
                        "toolCallId": "tc-old-1",
                        "title": "Read old file",
                        "status": "completed"
                    }
                }
            })
            .to_string(),
            json!({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": "s-replay",
                    "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "content": { "type": "text", "text": "Prior assistant reply M1" }
                    }
                }
            })
            .to_string(),
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "result": { "sessionId": "s-replay" }
            })
            .to_string(),
        ]
        .join("\n")
            + "\n";

        read_daemon_stdout(
            Box::new(std::io::Cursor::new(replay_lines.into_bytes())),
            Arc::clone(&daemon.state),
        );

        {
            let guard = mailbox.lock().unwrap();
            let non_exit: Vec<&TransportEvent> = guard
                .events
                .iter()
                .filter(|ev| !matches!(ev, TransportEvent::Exit { .. }))
                .collect();
            assert!(
                non_exit.is_empty(),
                "session/load history replay must not enqueue turn events when idle: {non_exit:?}"
            );
        }

        // Active Turn 2 prompt in flight must receive only Turn 2 events; stray post-turn chunks are dropped.
        let active_daemon = AgyAcpDaemon::new_with_lease();
        let active_mailbox = active_daemon.register_session("s-replay");
        {
            let mut guard = active_mailbox.lock().unwrap();
            guard.in_flight_prompt_id = Some(3);
            guard.prompt_settled = false;
        }
        active_daemon
            .state
            .sessions
            .lock()
            .unwrap()
            .prompt_owners
            .insert(3, "s-replay".to_string());
        let active_and_trailing_lines = [
            json!({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": "s-replay",
                    "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "content": { "type": "text", "text": "Fresh Turn 2 reply" }
                    }
                }
            })
            .to_string(),
            json!({
                "jsonrpc": "2.0",
                "id": 3,
                "result": { "stopReason": "end_turn" }
            })
            .to_string(),
            json!({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": "s-replay",
                    "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "content": { "type": "text", "text": "Stale trailing update" }
                    }
                }
            })
            .to_string(),
        ]
        .join("\n")
            + "\n";

        read_daemon_stdout(
            Box::new(std::io::Cursor::new(active_and_trailing_lines.into_bytes())),
            Arc::clone(&active_daemon.state),
        );

        let events: Vec<TransportEvent> = active_mailbox
            .lock()
            .unwrap()
            .events
            .drain(..)
            .filter(|ev| !matches!(ev, TransportEvent::Exit { .. }))
            .collect();
        assert_eq!(
            events,
            vec![
                TransportEvent::Text("Fresh Turn 2 reply".to_string()),
                TransportEvent::TurnEnded,
            ]
        );
    }

    #[test]
    fn shared_daemon_env_scrubs_per_thread_kite_address_and_preserves_thread_mode() {
        let thread1_env = vec![
            ("KITE_DISPATCH".to_string(), "1".to_string()),
            ("KITE_ADDRESS".to_string(), "thread:thread-1-uuid".to_string()),
            ("KITE_THREAD_ID".to_string(), "thread-1-uuid".to_string()),
            ("KITE_SESSION_ID".to_string(), "sess-1".to_string()),
            ("KITE_MODEL".to_string(), "gemini-4-hydrogen".to_string()),
            ("KITE_WORKSPACE_ID".to_string(), "ws-42".to_string()),
        ];
        let scrubbed = shared_daemon_env(&thread1_env);
        assert!(
            !scrubbed.iter().any(|(k, _)| k.eq_ignore_ascii_case("KITE_ADDRESS")),
            "KITE_ADDRESS must never bake Thread #1 identity into shared daemon: {scrubbed:?}"
        );
        assert!(
            !scrubbed.iter().any(|(k, _)| k.eq_ignore_ascii_case("KITE_THREAD_ID")),
            "KITE_THREAD_ID must be stripped: {scrubbed:?}"
        );
        assert!(
            !scrubbed.iter().any(|(k, _)| k.eq_ignore_ascii_case("KITE_SESSION_ID")),
            "KITE_SESSION_ID must be stripped: {scrubbed:?}"
        );
        assert!(
            !scrubbed.iter().any(|(k, _)| k.eq_ignore_ascii_case("KITE_MODEL")),
            "KITE_MODEL must be stripped: {scrubbed:?}"
        );
        assert!(
            scrubbed
                .iter()
                .any(|(k, v)| k == "KITE_THREAD_MODE" && v == "1"),
            "KITE_THREAD_MODE=1 must be preserved for PreToolUse hooks and loopback routing: {scrubbed:?}"
        );
        assert!(
            scrubbed
                .iter()
                .any(|(k, v)| k == "KITE_MULTIPLEXED_DAEMON" && v == "1"),
            "KITE_MULTIPLEXED_DAEMON=1 must be injected: {scrubbed:?}"
        );
        assert!(
            scrubbed
                .iter()
                .any(|(k, v)| k == "KITE_WORKSPACE_ID" && v == "ws-42"),
            "workspace env must remain intact: {scrubbed:?}"
        );
    }
}
