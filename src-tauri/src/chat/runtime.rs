use crate::persist::{notifications, persist, threads, workspace_path};
use crate::connections::EndpointVerification;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use uuid::Uuid;

use crate::chat::drivers::{declaration, DriverVersion};
use crate::chat::persistent::{
    unsupported_wire, AntigravitySession, OpenCodeServerSession, PersistentControls,
    ANTIGRAVITY_DRIVER, OPENCODE_DRIVER,
};
use crate::chat::recipe::{apply_recipe, snapshot_for_agent};
use crate::chat::session::{
    declared_session_mode, RecipeSnapshot, SendReceipt, SessionManager, SessionMode, SessionSpec,
    SessionState, SessionTransport,
};
use crate::chat::threads::{
    chat_item, load_thread, replace_thread, sanitize_chat_text, touch, upsert_item,
};
use crate::chat::utils::{chat_log, clip_argv, now_ms, resolve_bin};

pub struct TurnRun {
    pub revision: String,
    pub events: Vec<Value>,
    pub next_sequence: u64,
    pub assistant_id: String,
    pub assistant_text: String,
    pub child: Option<Arc<Mutex<crate::hidden_exec::HiddenChild>>>,
    pub stdin: Option<Arc<Mutex<Box<dyn std::io::Write + Send>>>>,
    pub closing: bool,
    pub finished: bool,
    pub started_at_ms: i64,
    pub routine_id: Option<String>,
}

pub struct LiveTurns {
    pub runs: HashMap<String, TurnRun>,
    pub by_thread: HashMap<String, String>,
}

pub fn live_turns() -> &'static Mutex<LiveTurns> {
    static CELL: std::sync::OnceLock<Mutex<LiveTurns>> = std::sync::OnceLock::new();
    CELL.get_or_init(|| {
        Mutex::new(LiveTurns {
            runs: HashMap::new(),
            by_thread: HashMap::new(),
        })
    })
}

pub fn live_cv() -> &'static Condvar {
    static CELL: std::sync::OnceLock<Condvar> = std::sync::OnceLock::new();
    CELL.get_or_init(Condvar::new)
}

pub fn prune_stale_runs(live: &mut LiveTurns) {
    let now = now_ms();
    let stale_keys: Vec<String> = live
        .runs
        .iter()
        .filter(|(_, run)| run.finished && (now.saturating_sub(run.started_at_ms) > 120_000))
        .map(|(k, _)| k.clone())
        .collect();

    for k in stale_keys {
        live.runs.remove(&k);
        live.by_thread.retain(|_, rid| rid != &k);
    }
}

/// Connection and endpoint a chat or agent send binds to. Both are optional:
/// a send without them keeps the local CLI's own account and model defaults.
#[derive(Debug, Clone, Default)]
pub struct SendBinding {
    pub connection_id: Option<String>,
    pub supported_endpoint: Option<String>,
}

/// The process environment flag that opts a send into a session that stays
/// open. It must be exactly `1`; any other value keeps the one-command path.
pub const PERSISTENT_SESSIONS_ENV: &str = "KITE_PERSISTENT_SESSIONS";

/// The largest operational notice this module writes into a thread.
pub const MAX_NOTICE_CHARS: usize = 2_000;

/// The route a send uses. Persistent sessions are opt-in per process and are
/// only available when the driver declaration observed a lasting channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SendRoute {
    Persistent,
    OneShot,
}

/// Why a send did not complete through the session manager.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManagedSendError {
    /// The agent recipe could not be written before the process started. No
    /// session was attached and no turn was written, and the caller must not
    /// fall back to a command that would run without its recipe.
    Prepare(String),
    /// The process never started, so the prompt was not written anywhere and
    /// the caller may keep today's one-command path.
    Start(String),
    /// The process started but rejected the turn. The prompt may have been
    /// written, so it is never replayed as a second command.
    Turn(String),
}

impl ManagedSendError {
    pub fn reason(&self) -> &str {
        match self {
            ManagedSendError::Prepare(reason)
            | ManagedSendError::Start(reason)
            | ManagedSendError::Turn(reason) => reason,
        }
    }

    pub fn before_turn(&self) -> bool {
        matches!(self, ManagedSendError::Start(_))
    }
}

fn persistent_flag_enabled(raw: Option<&str>) -> bool {
    raw == Some("1")
}

pub fn persistent_sessions_enabled() -> bool {
    persistent_flag_enabled(std::env::var(PERSISTENT_SESSIONS_ENV).ok().as_deref())
}

/// The route a send may use. Only a driver that declared a lasting channel and
/// a process that set the opt-in flag may keep a process open. Everything else
/// keeps today's one-command path, so a resumable or unobservable driver never
/// looks persistent.
pub fn send_route(provider: &str, persistent_enabled: bool) -> SendRoute {
    let Some(declared) = declaration(provider) else {
        return SendRoute::OneShot;
    };
    if declared_session_mode(&declared, persistent_enabled) != SessionMode::Persistent {
        return SendRoute::OneShot;
    }
    // A declaration is not an adapter: without a documented wire and a served
    // transport the route stays one command per turn.
    if unsupported_wire(provider).is_some() {
        return SendRoute::OneShot;
    }
    match declared.driver.as_str() {
        ANTIGRAVITY_DRIVER | OPENCODE_DRIVER => SendRoute::Persistent,
        _ => SendRoute::OneShot,
    }
}

/// Provider and transport text is untrusted; operational notices stay bounded.
pub fn bounded_notice(message: &str) -> String {
    sanitize_chat_text(message)
        .chars()
        .take(MAX_NOTICE_CHARS)
        .collect()
}

/// Sends one turn through the session manager with a caller-supplied lasting
/// wire. The manager never picks a driver mode on its own, so a spec that was
/// not declared persistent is rejected before anything is attached.
pub fn managed_send(
    manager: &mut SessionManager,
    spec: SessionSpec,
    transport: Box<dyn SessionTransport>,
    command_id: &str,
    prompt: &str,
) -> Result<SendReceipt, ManagedSendError> {
    if spec.mode != SessionMode::Persistent {
        return Err(ManagedSendError::Start(
            "the session manager only accepts a declared persistent route".to_string(),
        ));
    }
    let thread_id = spec.thread_id.clone();
    manager
        .attach(spec, transport)
        .map_err(|error| ManagedSendError::Start(error.to_string()))?;
    match manager.start(&thread_id) {
        Ok(_) => manager
            .send_turn(&thread_id, command_id, prompt)
            .map_err(|error| ManagedSendError::Turn(error.to_string())),
        Err(error) => Err(ManagedSendError::Start(error.to_string())),
    }
}

/// Sends one turn after a caller-owned preparation step completes. The step
/// runs before the session is attached, so it is also before any process
/// starts: an agent recipe is already on disk when the provider launches. A
/// preparation failure never reaches a provider and is never retried as a
/// second command.
pub fn managed_send_prepared<F>(
    manager: &mut SessionManager,
    spec: SessionSpec,
    transport: Box<dyn SessionTransport>,
    command_id: &str,
    prompt: &str,
    prepare: F,
) -> Result<SendReceipt, ManagedSendError>
where
    F: FnOnce() -> Result<(), String>,
{
    if spec.mode != SessionMode::Persistent {
        return Err(ManagedSendError::Start(
            "the session manager only accepts a declared persistent route".to_string(),
        ));
    }
    let thread_id = spec.thread_id.clone();
    prepare().map_err(ManagedSendError::Prepare)?;
    manager
        .attach(spec, transport)
        .map_err(|error| ManagedSendError::Start(error.to_string()))?;
    match manager.start(&thread_id) {
        Ok(_) => manager
            .send_turn(&thread_id, command_id, prompt)
            .map_err(|error| ManagedSendError::Turn(error.to_string())),
        Err(error) => Err(ManagedSendError::Start(error.to_string())),
    }
}

/// Whether the next send needs a new provider process. A running, waiting, or
/// completed persistent session still owns its process; every other state
/// starts a generation, and an agent thread applies the current recipe first.
pub fn starts_new_session(state: Option<SessionState>) -> bool {
    !matches!(
        state,
        Some(SessionState::Running | SessionState::Waiting | SessionState::Completed)
    )
}

/// Writes the agent recipe into the directory the session will use. A loose
/// chat has no recipe and writes nothing. The return value reports whether a
/// recipe was applied.
pub fn apply_agent_recipe(cwd: &Path, recipe: Option<&RecipeSnapshot>) -> Result<bool, String> {
    let Some(recipe) = recipe else {
        return Ok(false);
    };
    apply_recipe(cwd, recipe).map(|()| true).map_err(|error| {
        format!("could not write the agent recipe before the session started: {error}")
    })
}

/// The bounded statement a one-command send adds to its thread. It comes from
/// the driver declaration, so a resumable driver, an unobserved driver, and a
/// disabled persistent process each say their own reason instead of sharing a
/// guessed claim.
pub fn one_shot_notice(provider: &str, persistent_enabled: bool) -> Option<String> {
    let declared = declaration(provider)?;
    let notice = match declared.session_mode {
        Some(SessionMode::Persistent) if !persistent_enabled => format!(
            "Persistent sessions are off for {provider} in this process, so each send is a new command. The thread context is attached to every turn."
        ),
        Some(SessionMode::Persistent) => return None,
        Some(SessionMode::Resumable) => format!(
            "{provider} can continue a session with a provider-issued id, but this build does not pass one, so each send is a new command. The thread context is attached to every turn."
        ),
        Some(SessionMode::OneShot) => format!(
            "{provider} has no lasting session channel, so each send is a new command. The thread context is attached to every turn."
        ),
        None => format!(
            "The lasting session mode of {provider} could not be observed on this machine, so each send is a new command. The thread context is attached to every turn."
        ),
    };
    Some(bounded_notice(&notice))
}

fn session_manager() -> &'static Mutex<SessionManager> {
    static CELL: std::sync::OnceLock<Mutex<SessionManager>> = std::sync::OnceLock::new();
    CELL.get_or_init(|| Mutex::new(SessionManager::new()))
}

/// The lasting wire a send may open. The kind is evidence about this build's
/// adapter, not a capability derived from the driver id.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportKind {
    Antigravity,
    OpenCodeServer,
}

/// A lasting transport chosen from the declaration, plus the version evidence
/// that gates it. The comparison itself runs inside `spawn`, before any
/// process starts, so a mismatch reaches the caller as a start failure.
#[derive(Debug)]
pub struct SelectedTransport {
    pub driver: String,
    pub kind: TransportKind,
    pub version: DriverVersion,
    pub transport: Box<dyn SessionTransport>,
}

/// Chooses the lasting transport for a driver that declared one. A wire this
/// build does not speak, a declaration without version evidence, and a driver
/// without an adapter all fail closed before a session is attached. The caller
/// keeps the one-command path and writes the reason into the thread.
pub fn select_persistent_transport(
    driver: &str,
    controls: PersistentControls,
) -> Result<SelectedTransport, String> {
    let declared = declaration(driver)
        .ok_or_else(|| format!("{driver} has no driver declaration in this build"))?;
    if let Some(refusal) = unsupported_wire(driver) {
        return Err(refusal);
    }
    let version = declared.version.clone().ok_or_else(|| {
        format!(
            "{} declares no version evidence, so a lasting session cannot start",
            declared.driver
        )
    })?;
    let kind = match declared.driver.as_str() {
        ANTIGRAVITY_DRIVER => TransportKind::Antigravity,
        OPENCODE_DRIVER => TransportKind::OpenCodeServer,
        other => {
            return Err(format!(
                "Unsupported: {other} declares a lasting wire but this build has no adapter for it"
            ))
        }
    };
    let transport: Box<dyn SessionTransport> = match kind {
        TransportKind::Antigravity => Box::new(AntigravitySession::new(controls)),
        TransportKind::OpenCodeServer => Box::new(OpenCodeServerSession::new()),
    };
    Ok(SelectedTransport {
        driver: declared.driver,
        kind,
        version,
        transport,
    })
}

/// The bounded statement a thread receives when the lasting route could not
/// start. The prompt is already stored, so the same send can run on the
/// one-command path without losing it.
pub fn persistent_fallback_notice(driver: &str, reason: &str) -> String {
    bounded_notice(&format!(
        "Persistent sessions are enabled, but {driver} could not start one: {reason}. This turn runs as one command."
    ))
}

/// Writes one bounded `notice` item into the live run and the durable thread.
/// The user item is already stored, so a failed route never removes it.
fn emit_notice_item(thread_id: &str, run_id: &str, message: &str) {
    let item = chat_item(
        &format!("n{}", Uuid::new_v4().simple()),
        "notice",
        &bounded_notice(message),
        false,
    );
    {
        let mut live = live_turns().lock().unwrap();
        if let Some(run) = live.runs.get_mut(run_id) {
            append_event(run, json!({ "kind": "upsert", "item": item.clone() }), true);
        }
    }
    {
        let mut items = threads().lock().unwrap();
        if let Some(thread) = items
            .iter_mut()
            .find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id))
        {
            upsert_item(thread, &item);
            touch(thread);
        }
    }
    live_cv().notify_all();
    persist();
}

/// Reads a lasting session's normalized events into the live chat run. The
/// pump stops at a completed turn, a provider exit, a failure, or a run the
/// user already finished.
fn pump_persistent_session(thread_id: String, run_id: String, assistant_id: String) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(40));
        let events = {
            let mut manager = session_manager().lock().unwrap();
            manager.poll(&thread_id).unwrap_or_default()
        };
        let mut outcome: Option<(bool, String)> = None;
        for event in events {
            match event.kind.as_str() {
                "text" => {
                    if let Some(text) = event.payload.get("text").and_then(Value::as_str) {
                        emit_deltas(&thread_id, &run_id, &assistant_id, text);
                    }
                }
                "notice" => {
                    if let Some(text) = event.payload.get("text").and_then(Value::as_str) {
                        emit_notice_item(&thread_id, &run_id, text);
                    }
                }
                "turnCompleted" => outcome = Some((true, String::new())),
                "turnFailed" => {
                    let reason = event
                        .payload
                        .get("reason")
                        .and_then(Value::as_str)
                        .unwrap_or("the provider reported that this turn failed");
                    outcome = Some((false, reason.to_string()));
                }
                "stopped" | "interrupted" => outcome = Some((true, String::new())),
                "failed" => {
                    let reason = event
                        .payload
                        .get("reason")
                        .and_then(Value::as_str)
                        .unwrap_or("the provider session failed");
                    outcome = Some((false, reason.to_string()));
                }
                "exited" => {
                    let code = event.payload.get("code").and_then(Value::as_i64);
                    let error = event
                        .payload
                        .get("error")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    let ok = error.is_none() && code.unwrap_or(0) == 0;
                    outcome = Some((ok, error.unwrap_or_default()));
                }
                _ => {}
            }
        }
        if let Some((ok, error)) = outcome {
            finish_run(&run_id, ok, false, &error);
            return;
        }
        let finished = live_turns()
            .lock()
            .unwrap()
            .runs
            .get(&run_id)
            .map(|run| run.finished || run.closing)
            .unwrap_or(true);
        if finished {
            return;
        }
    });
}

pub fn start_turn(
    thread_id: &str,
    profile_id: Option<&str>,
    prompt: &str,
    attachments: Vec<Value>,
    routine_id: Option<&str>,
) -> Value {
    start_turn_with_binding(thread_id, profile_id, prompt, attachments, routine_id, None)
}

pub fn start_turn_with_binding(
    thread_id: &str,
    profile_id: Option<&str>,
    prompt: &str,
    attachments: Vec<Value>,
    routine_id: Option<&str>,
    binding: Option<&SendBinding>,
) -> Value {
    let mut thread = load_thread(thread_id, profile_id, "Chat");
    if let Some(profile_id) = profile_id {
        thread["profileId"] = json!(profile_id);
        let cur_prov = thread.get("provider").and_then(|v| v.as_str()).unwrap_or("");
        if cur_prov == "claude" || cur_prov.is_empty() {
            let ag_list = crate::persist::agents().lock().unwrap();
            if let Some(ag) = ag_list.iter().find(|a| a.id == profile_id) {
                if ag.engine != "claude" && ag.engine != "claude-code" {
                    let corrected = match ag.engine.as_str() {
                        "codex" => "codex",
                        "cursor" => "cursor",
                        "gemini" => "gemini",
                        "grok" => "grok",
                        "opencode" | "open-code" => "opencode",
                        _ => "antigravity",
                    };
                    thread["provider"] = json!(corrected);
                }
            }
        }
    }
    thread["status"] = json!("running");
    touch(&mut thread);
    replace_thread(&thread);
    let run_id = Uuid::new_v4().to_string();
    chat_log(&format!(
        "start_turn: thread={}, run={}, provider={}, prompt_chars={}",
        thread_id,
        run_id,
        thread.get("provider").and_then(|v| v.as_str()).unwrap_or(""),
        prompt.len()
    ));
    let user_id = format!("u{}", Uuid::new_v4().simple());
    let assistant_id = format!("a{}", Uuid::new_v4().simple());
    let revision = thread.get("revision").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let mut user_item = chat_item(&user_id, "user", prompt, false);
    if !attachments.is_empty() {
        user_item["attachments"] = Value::Array(attachments);
    }
    let assistant_item = chat_item(&assistant_id, "assistant", "", true);
    {
        let mut items = threads().lock().unwrap();
        if let Some(stored) = items.iter_mut().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id)) {
            upsert_item(stored, &user_item);
            upsert_item(stored, &assistant_item);
            thread = stored.clone();
        }
    }
    let mut run = TurnRun {
        revision,
        events: Vec::new(),
        next_sequence: 0,
        assistant_id: assistant_id.clone(),
        assistant_text: String::new(),
        child: None,
        stdin: None,
        closing: false,
        finished: false,
        started_at_ms: now_ms(),
        routine_id: routine_id.map(|id| id.to_string()),
    };
    push_event(&mut run, json!({ "kind": "status", "status": "running" }));
    push_event(&mut run, json!({ "kind": "upsert", "item": user_item }));
    push_event(&mut run, json!({ "kind": "upsert", "item": assistant_item }));
    {
        let mut live = live_turns().lock().unwrap();
        live.by_thread.insert(thread_id.to_string(), run_id.clone());
        live.runs.insert(run_id.clone(), run);
    }
    launch_provider(thread_id.to_string(), run_id.clone(), &thread, prompt, binding);
    json!({
        "schemaVersion": 1,
        "runId": run_id,
        "thread": thread
    })
}

pub fn push_event(run: &mut TurnRun, event: Value) {
    append_event(run, event, false);
}

pub fn append_event(run: &mut TurnRun, mut event: Value, force: bool) {
    if run.finished || (!force && run.events.len() >= 400) {
        return;
    }
    run.next_sequence += 1;
    event["sequence"] = json!(run.next_sequence);
    run.events.push(event);
}

pub fn read_turn_updates(run_id: &str, after_sequence: u64, wait_ms: u64) -> Value {
    let wait = wait_ms.min(1000);
    let deadline = Instant::now() + Duration::from_millis(wait);
    loop {
        let mut live = live_turns().lock().unwrap();
        prune_stale_runs(&mut live);
        let (events, revision, finished) = match live.runs.get(run_id) {
            Some(run) => {
                let events: Vec<Value> = run
                    .events
                    .iter()
                    .filter(|event| event.get("sequence").and_then(|v| v.as_u64()).unwrap_or(0) > after_sequence)
                    .take(32)
                    .cloned()
                    .collect();
                (events, run.revision.clone(), run.finished)
            }
            None => (Vec::new(), format!("{:064x}", 1), true),
        };
        if !events.is_empty() || finished || Instant::now() >= deadline {
            let next = events
                .last()
                .and_then(|event| event.get("sequence"))
                .and_then(|v| v.as_u64())
                .unwrap_or(after_sequence);
            return json!({
                "schemaVersion": 1,
                "runId": run_id,
                "revision": revision,
                "afterSequence": after_sequence,
                "nextSequence": next,
                "events": events,
                "resyncRequired": false
            });
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        let (_guard, _) = live_cv().wait_timeout(live, remaining).unwrap();
    }
}

pub fn cancel_turn(thread_id: &str) {
    chat_log(&format!("cancel_turn: requested for thread={}", thread_id));
    let run_id = {
        let live = live_turns().lock().unwrap();
        live.by_thread.get(thread_id).cloned()
    };
    let Some(run_id) = run_id else {
        chat_log(&format!("cancel_turn: no live run for thread={}", thread_id));
        return;
    };
    let child = {
        let live = live_turns().lock().unwrap();
        live.runs.get(&run_id).and_then(|run| run.child.clone())
    };
    if let Some(child) = child {
        if let Ok(mut child) = child.lock() {
            let _ = child.kill();
        }
    }
    // A lasting session owns its own process, so the live-run handle is not
    // enough to stop it. Stopping is a no-op for a thread with no session.
    if let Ok(mut manager) = session_manager().lock() {
        let _ = manager.stop(thread_id);
    }
    finish_run(&run_id, false, true, "Stopped.");
}

pub fn assemble_thread_context(thread: &Value, current_prompt: &str) -> String {
    let Some(items) = thread.get("items").and_then(|v| v.as_array()) else {
        return current_prompt.to_string();
    };

    let mut past_items: Vec<&Value> = items
        .iter()
        .filter(|it| {
            let streaming = it.get("streaming").and_then(|v| v.as_bool()).unwrap_or(false);
            let text = it.get("text").and_then(|v| v.as_str()).unwrap_or("");
            !streaming && !text.trim().is_empty()
        })
        .collect();

    if let Some(last) = past_items.last() {
        if last.get("kind").and_then(|v| v.as_str()) == Some("user")
            && last.get("text").and_then(|v| v.as_str()) == Some(current_prompt)
        {
            past_items.pop();
        }
    }

    if past_items.is_empty() {
        return current_prompt.to_string();
    }

    if past_items.len() > 14 {
        let drain_count = past_items.len() - 14;
        past_items = past_items[drain_count..].to_vec();
    }

    let mut context_buffer = String::new();
    context_buffer.push_str("--- Previous Conversation History ---\n");

    for item in past_items {
        let kind = item.get("kind").and_then(|v| v.as_str()).unwrap_or("");
        let text = item.get("text").and_then(|v| v.as_str()).unwrap_or("");
        match kind {
            "user" => {
                context_buffer.push_str("\n[User]:\n");
                context_buffer.push_str(text.trim());
                context_buffer.push('\n');
            }
            "assistant" => {
                context_buffer.push_str("\n[Assistant]:\n");
                if text.len() > 4000 {
                    context_buffer.push_str(&text[..4000]);
                    context_buffer.push_str("\n... [output truncated for brevity] ...\n");
                } else {
                    context_buffer.push_str(text.trim());
                    context_buffer.push('\n');
                }
            }
            "tool" => {
                let tool_name = item.get("toolName").or_else(|| item.get("title")).and_then(|v| v.as_str()).unwrap_or("tool");
                let status = item.get("status").and_then(|v| v.as_str()).unwrap_or("completed");
                context_buffer.push_str(&format!("\n[Tool Call: {} ({})]\n", tool_name, status));
                if text.len() > 1500 {
                    context_buffer.push_str(&text[..1500]);
                    context_buffer.push_str(&format!("\n... [clipped {} characters] ...\n", text.len() - 1500));
                } else {
                    context_buffer.push_str(text.trim());
                    context_buffer.push('\n');
                }
            }
            _ => {}
        }
    }

    context_buffer.push_str("\n--- Current Request ---\n");
    context_buffer.push_str(current_prompt);
    context_buffer
}

pub fn launch_provider(
    thread_id: String,
    run_id: String,
    thread: &Value,
    prompt: &str,
    binding: Option<&SendBinding>,
) {
    let provider = thread.get("provider").and_then(|v| v.as_str()).unwrap_or("antigravity").to_string();
    let mode = thread.get("mode").and_then(|v| v.as_str()).unwrap_or("fullAccess").to_string();
    let model = thread.get("model").and_then(|v| v.as_str()).map(|s| s.to_string());
    let provider_session_id = thread.get("providerSessionId").and_then(|v| v.as_str()).map(|s| s.to_string());
    let effort = thread
        .get("providerOptions")
        .and_then(|v| v.as_array())
        .and_then(|arr| {
            arr.iter().find(|opt| opt.get("id").and_then(|v| v.as_str()) == Some("effort"))
        })
        .and_then(|opt| opt.get("value").and_then(|v| v.as_str()))
        .map(|s| s.to_string());
    let workspace_id = thread.get("workspaceId").and_then(|v| v.as_str()).map(|s| s.to_string());
    let profile_id = thread.get("profileId").and_then(|v| v.as_str()).map(|s| s.to_string());
    let prompt = prompt.to_string();
    let thread_clone = thread.clone();
    let binding = binding.cloned();
    let assistant_id = {
        let live = live_turns().lock().unwrap();
        live.runs.get(&run_id).map(|run| run.assistant_id.clone()).unwrap_or_else(|| "aassistant".into())
    };
    std::thread::spawn(move || {
        let verified_endpoints = match verified_endpoints_for(
            binding.as_ref().and_then(|value| value.connection_id.as_deref()),
        ) {
            Ok(endpoints) => endpoints,
            Err(message) => {
                finish_run(&run_id, false, false, &message);
                return;
            }
        };
        let values = SendValues {
            connection_id: binding.as_ref().and_then(|value| value.connection_id.as_deref()),
            model: model.as_deref(),
            session_id: provider_session_id.as_deref(),
            supported_endpoint: binding
                .as_ref()
                .and_then(|value| value.supported_endpoint.as_deref()),
            verified_endpoints: &verified_endpoints,
        };
        let cwd = workspace_id
            .as_deref()
            .and_then(workspace_path)
            .map(PathBuf::from)
            .filter(|path| path.is_dir())
            .unwrap_or_else(|| {
                if let Some(ref aid) = profile_id {
                    let home = crate::agent_mind::get_agent_home_dir(aid);
                    let _ = std::fs::create_dir_all(&home);
                    let _ = crate::agent_mind::sync_agent_instructions(
                        home.parent().unwrap_or(Path::new(".")),
                        aid,
                    );
                    home
                } else {
                    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
                }
            });
        // Snapshot once. The same value is written before the process starts
        // and stored on the session, so a later agent edit cannot reach it.
        let recipe = profile_id.as_deref().and_then(snapshot_for_agent);
        let effective_prompt = if provider_session_id.is_some() {
            prompt.clone()
        } else {
            assemble_thread_context(&thread_clone, &prompt)
        };
        match build_spawn(&provider, &mode, &values, effort.as_deref(), &effective_prompt) {
            Ok(plan) => {
                chat_log(&format!(
                    "spawn: provider={}, endpoint={}, connection={}",
                    provider,
                    plan.endpoint.verified_endpoint(),
                    plan.connection_id.as_deref().unwrap_or("none"),
                ));
                let persistent_enabled = persistent_sessions_enabled();
                let mut fallback_notice_emitted = false;
                if send_route(&provider, persistent_enabled) == SendRoute::Persistent {
                    if let Some(declared) = declaration(&provider) {
                        // The mode comes from the declaration, not from the
                        // driver id. The declaration and the flag both say
                        // persistent or this branch is never reached.
                        let spec = SessionSpec {
                            thread_id: thread_id.clone(),
                            driver: provider.clone(),
                            connection_id: values.connection_id.map(str::to_string),
                            working_directory: Some(cwd.to_string_lossy().to_string()),
                            mode: SessionMode::OneShot,
                            recipe: recipe.clone(),
                        }
                        .with_declared_mode(&declared, persistent_enabled);
                        let first_session = {
                            let manager = session_manager().lock().unwrap();
                            starts_new_session(manager.status(&thread_id).map(|record| record.state))
                        };
                        let controls = PersistentControls {
                            model: model.clone(),
                            effort: effort.clone(),
                            permission_mode: Some(mode.clone()),
                        };
                        let cwd_for_prepare = cwd.clone();
                        let recipe_for_prepare = recipe.clone();
                        let outcome = {
                            match select_persistent_transport(&provider, controls) {
                                Ok(selected) => {
                                    chat_log(&format!(
                                        "persistent transport: driver={}, kind={:?}, minimum={}",
                                        selected.driver, selected.kind, selected.version.minimum
                                    ));
                                    let mut manager = session_manager().lock().unwrap();
                                    managed_send_prepared(
                                        &mut manager,
                                        spec,
                                        selected.transport,
                                        &run_id,
                                        &prompt,
                                        move || {
                                            if !first_session {
                                                return Ok(());
                                            }
                                            apply_agent_recipe(
                                                &cwd_for_prepare,
                                                recipe_for_prepare.as_ref(),
                                            )
                                            .map(|_| ())
                                        },
                                    )
                                }
                                // Selection reads the driver declaration and its
                                // version evidence. Nothing was attached and no
                                // process started, so the prompt can run on the
                                // one-command path below.
                                Err(reason) => Err(ManagedSendError::Start(reason)),
                            }
                        };
                        match outcome {
                            Ok(_) => {
                                // The lasting wire accepted the turn. Its frames
                                // are projected into this live run until the
                                // turn ends, fails, or the process exits.
                                pump_persistent_session(
                                    thread_id.clone(),
                                    run_id.clone(),
                                    assistant_id.clone(),
                                );
                                return;
                            }
                            Err(ManagedSendError::Prepare(reason)) => {
                                // The recipe never landed on disk, so neither
                                // the lasting session nor a one-command send may
                                // run without it.
                                emit_notice_item(
                                    &thread_id,
                                    &run_id,
                                    &format!(
                                        "The agent recipe could not be written, so the {provider} session did not start: {reason} Your message is still in the thread."
                                    ),
                                );
                                finish_run(&run_id, false, false, &reason);
                                return;
                            }
                            Err(error) if error.before_turn() => {
                                // Nothing was written to a provider, so the
                                // user prompt is still intact and can run on
                                // today's one-command path.
                                emit_notice_item(
                                    &thread_id,
                                    &run_id,
                                    &persistent_fallback_notice(&provider, error.reason()),
                                );
                                fallback_notice_emitted = true;
                            }
                            Err(error) => {
                                // The turn may have reached the provider, so
                                // it is never replayed as a second command.
                                emit_notice_item(
                                    &thread_id,
                                    &run_id,
                                    &format!(
                                        "{provider} failed while accepting the turn on its session: {}. Your message is still in the thread.",
                                        error.reason()
                                    ),
                                );
                                finish_run(&run_id, false, false, "");
                                return;
                            }
                        }
                    }
                }
                if !fallback_notice_emitted {
                    if let Some(notice) = one_shot_notice(&provider, persistent_enabled) {
                        emit_notice_item(&thread_id, &run_id, &notice);
                    }
                }
                if let Err(reason) = apply_agent_recipe(&cwd, recipe.as_ref()) {
                    emit_notice_item(
                        &thread_id,
                        &run_id,
                        &format!(
                            "The agent recipe could not be written before {provider} started: {reason} Your message is still in the thread."
                        ),
                    );
                    finish_run(&run_id, false, false, &reason);
                    return;
                }
                let args_refs: Vec<&str> = plan.args.iter().map(|s| s.as_str()).collect();
                match crate::hidden_exec::spawn_streaming(&plan.program, &args_refs, Some(&cwd)) {
                    Ok(child) => stream_child(thread_id, run_id, assistant_id, child),
                    Err(err) => finish_run(&run_id, false, false, &format!("{provider} failed to start: {err}")),
                }
            }
            Err(message) => finish_run(&run_id, false, false, &message),
        }
    });
}

/// Endpoints verified on the connection named by the send. An empty list is
/// returned when the send does not select a connection, so no endpoint can be
/// claimed as supported.
fn verified_endpoints_for(connection_id: Option<&str>) -> Result<Vec<EndpointVerification>, String> {
    let Some(connection_id) = connection_id.filter(|id| !id.is_empty()) else {
        return Ok(Vec::new());
    };
    let registry = crate::connections::ConnectionRegistry::open()?;
    let record = registry
        .load(connection_id)?
        .ok_or_else(|| format!("connection {connection_id} is not in the shared registry"))?;
    Ok(record.endpoints)
}

pub fn list_available_providers() -> Vec<&'static str> {
    let mut available = Vec::new();
    if resolve_bin("agy", &[r"C:\Users\PC\AppData\Local\agy\bin\agy.exe"]).is_some() {
        available.push("Antigravity");
    }
    if resolve_bin("codex", &[
        r"C:\Users\PC\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe",
        r"C:\Users\PC\AppData\Local\Programs\OpenAI\codex.exe",
    ]).is_some() {
        available.push("Codex");
    }
    if resolve_bin("claude", &[]).is_some() {
        available.push("Claude");
    }
    if resolve_bin("agent", &[]).or_else(|| resolve_bin("cursor-agent", &[])).is_some() {
        available.push("Cursor");
    }
    if resolve_bin("grok", &[]).is_some() {
        available.push("Grok");
    }
    if resolve_bin("opencode", &[]).is_some() {
        available.push("OpenCode");
    }
    if resolve_bin("gemini", &[]).is_some() {
        available.push("Gemini CLI");
    }
    available
}

/// One local chat spawn form. A driver id is not a permission: each endpoint
/// declares which send values its command line can consume, and the spawn is
/// evidence for that endpoint only.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SpawnEndpoint {
    pub endpoint_id: &'static str,
    /// This spawn form selects a model without an extra opt-in. It reflects
    /// existing supported behavior, not a capability inherited from the driver.
    pub model_by_default: bool,
    pub accepts_model: bool,
    pub accepts_session: bool,
}

impl SpawnEndpoint {
    /// The only endpoint a completed spawn is evidence for. It is never a
    /// network route, so a CLI start cannot verify a chat API endpoint.
    pub fn verified_endpoint(&self) -> &'static str {
        self.endpoint_id
    }
}

pub fn spawn_endpoint(provider: &str) -> Option<SpawnEndpoint> {
    let endpoint = match provider {
        "antigravity" | "agy" => SpawnEndpoint {
            endpoint_id: "agy -p",
            model_by_default: true,
            accepts_model: true,
            accepts_session: true,
        },
        "claude" => SpawnEndpoint {
            endpoint_id: "claude -p",
            model_by_default: true,
            accepts_model: true,
            accepts_session: true,
        },
        "codex" => SpawnEndpoint {
            endpoint_id: "codex exec",
            model_by_default: true,
            accepts_model: true,
            accepts_session: true,
        },
        "cursor" => SpawnEndpoint {
            endpoint_id: "cursor-agent -p",
            model_by_default: false,
            accepts_model: false,
            accepts_session: false,
        },
        "grok" => SpawnEndpoint {
            endpoint_id: "grok -p",
            model_by_default: false,
            accepts_model: false,
            accepts_session: false,
        },
        // The Go chat route needs a Go model and the `x-opencode-session`
        // header. `opencode run` selects neither, so it is not that endpoint.
        "opencode" => SpawnEndpoint {
            endpoint_id: "opencode run",
            model_by_default: false,
            accepts_model: false,
            accepts_session: false,
        },
        "gemini" => SpawnEndpoint {
            endpoint_id: "gemini --prompt",
            model_by_default: false,
            accepts_model: false,
            accepts_session: false,
        },
        _ => return None,
    };
    Some(endpoint)
}

/// Values a chat or agent send may pass to a spawn. A value reaches the command
/// line only when the endpoint declares it and, for a model on an endpoint that
/// does not select one by default, when the send names the endpoint explicitly.
#[derive(Debug, Clone, Copy, Default)]
pub struct SendValues<'a> {
    pub connection_id: Option<&'a str>,
    pub model: Option<&'a str>,
    pub session_id: Option<&'a str>,
    /// Explicit supported-endpoint flag. It must name this spawn's endpoint and
    /// that endpoint must be verified on `connection_id`.
    pub supported_endpoint: Option<&'a str>,
    pub verified_endpoints: &'a [EndpointVerification],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResolvedSend<'a> {
    pub endpoint: SpawnEndpoint,
    pub connection_id: Option<&'a str>,
    pub model: Option<&'a str>,
    pub session_id: Option<&'a str>,
}

/// Resolves the send values a spawn may forward. An explicit request is never
/// downgraded to a silent omission: when the supported-endpoint flag cannot be
/// honored, this returns an error.
pub fn resolve_send<'a>(
    provider: &str,
    values: &SendValues<'a>,
) -> Result<ResolvedSend<'a>, String> {
    let endpoint =
        spawn_endpoint(provider).ok_or_else(|| format!("{provider} has no local chat command in this build."))?;
    let supported_endpoint = values.supported_endpoint.filter(|id| !id.is_empty());
    let connection_id = values.connection_id.filter(|id| !id.is_empty());

    if let Some(claimed) = supported_endpoint {
        if claimed != endpoint.endpoint_id {
            return Err(format!(
                "{claimed} is not the endpoint the {provider} spawn uses ({})",
                endpoint.endpoint_id
            ));
        }
        if !endpoint.accepts_model {
            return Err(format!(
                "the {provider} spawn endpoint {claimed} does not support model selection"
            ));
        }
        let connection_id = connection_id.ok_or_else(|| {
            format!("endpoint {claimed} must belong to a connection before a send can use it")
        })?;
        let verified = values
            .verified_endpoints
            .iter()
            .any(|endpoint| endpoint.endpoint_id == claimed && endpoint.ok);
        if !verified {
            return Err(format!(
                "endpoint {claimed} is not verified for connection {connection_id}"
            ));
        }
    } else if connection_id.is_some() {
        return Err(
            "a send cannot pass a connection without naming the endpoint that supports it".to_string(),
        );
    }

    let model = values
        .model
        .filter(|model| !model.is_empty())
        .filter(|_| endpoint.accepts_model && (supported_endpoint.is_some() || endpoint.model_by_default));
    let session_id = values
        .session_id
        .filter(|session| !session.is_empty())
        .filter(|_| endpoint.accepts_session);

    Ok(ResolvedSend {
        endpoint,
        connection_id,
        model,
        session_id,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpawnArgs {
    pub endpoint: SpawnEndpoint,
    pub args: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct SpawnPlan {
    pub endpoint: SpawnEndpoint,
    pub program: PathBuf,
    pub args: Vec<String>,
    pub connection_id: Option<String>,
}

/// Builds the argument vector for one spawn endpoint. Program lookup is left to
/// `build_spawn`, so argument rules are testable without an installed CLI.
pub fn spawn_args(
    provider: &str,
    mode: &str,
    values: &SendValues<'_>,
    effort: Option<&str>,
    prompt: &str,
) -> Result<SpawnArgs, String> {
    let resolved = resolve_send(provider, values)?;
    let prompt = clip_argv(prompt);
    let read_only = mode == "readOnly";
    let sent = if read_only {
        format!("Read-only mode: do not create, edit, or delete files.\n\n{prompt}")
    } else {
        prompt
    };
    let args = match provider {
        "antigravity" | "agy" => {
            let mut args = vec!["-p".into(), sent, "--output-format".into(), "stream-json".into()];
            if let Some(sid) = resolved.session_id {
                args.push("--conversation".into());
                args.push(sid.to_string());
            }
            match mode {
                "readOnly" => {
                    args.push("--mode".into());
                    args.push("plan".into());
                }
                "acceptEdits" => {
                    args.push("--mode".into());
                    args.push("accept-edits".into());
                }
                _ => {
                    args.push("--dangerously-skip-permissions".into());
                }
            }
            if let Some(model) = resolved.model {
                args.push("--model".into());
                args.push(model.into());
            }
            if let Some(effort) = effort {
                args.push("--effort".into());
                args.push(effort.into());
            }
            args
        }
        "claude" => {
            let permission = match mode {
                "readOnly" => "plan",
                "acceptEdits" => "acceptEdits",
                _ => "bypassPermissions",
            };
            let mut args = vec!["-p".into(), "--output-format".into(), "text".into(), "--permission-mode".into(), permission.into()];
            if let Some(sid) = resolved.session_id {
                args.push("--resume".into());
                args.push(sid.to_string());
            }
            if let Some(model) = resolved.model {
                args.push("--model".into());
                args.push(model.into());
            }
            args.push(sent);
            args
        }
        "codex" => {
            let mut args = if let Some(sid) = resolved.session_id {
                vec!["exec".into(), "resume".into(), sid.to_string(), "--skip-git-repo-check".into()]
            } else {
                vec!["exec".into(), "--skip-git-repo-check".into()]
            };
            if read_only {
                args.push("--sandbox".into());
                args.push("read-only".into());
            } else {
                args.push("--full-auto".into());
            }
            if let Some(model) = resolved.model {
                args.push("--model".into());
                args.push(model.into());
            }
            args.push(sent);
            args
        }
        "grok" => {
            let permission = match mode {
                "readOnly" => "plan",
                "acceptEdits" => "acceptEdits",
                _ => "bypassPermissions",
            };
            vec![
                "-p".into(),
                "--permission-mode".into(),
                permission.into(),
                sent,
            ]
        }
        "cursor" => vec!["-p".into(), sent],
        "opencode" => vec!["run".into(), sent],
        "gemini" => vec!["--prompt".into(), sent],
        other => return Err(format!("{other} has no local chat command in this build.")),
    };
    Ok(SpawnArgs {
        endpoint: resolved.endpoint,
        args,
    })
}

fn resolve_spawn_program(provider: &str) -> Result<PathBuf, String> {
    let program = match provider {
        "antigravity" | "agy" => {
            resolve_bin("agy", &[r"C:\Users\PC\AppData\Local\agy\bin\agy.exe"]).ok_or_else(|| {
                let avail = list_available_providers().join(", ");
                format!("Antigravity CLI (agy) is not installed. Available providers: {avail}")
            })?
        }
        "claude" => resolve_bin("claude", &[]).ok_or_else(|| {
            let avail = list_available_providers().join(", ");
            if avail.is_empty() {
                "Claude Code is not installed. Install it with 'npm install -g @anthropic-ai/claude-code'.".to_string()
            } else {
                format!("Claude Code is not installed. Installed on this system: {avail}. Please switch providers in the dropdown.")
            }
        })?,
        "codex" => resolve_bin("codex", &[
            r"C:\Users\PC\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe",
            r"C:\Users\PC\AppData\Local\Programs\OpenAI\codex.exe",
        ]).ok_or_else(|| {
            let avail = list_available_providers().join(", ");
            format!("Codex is not installed. Available providers: {avail}")
        })?,
        "cursor" => resolve_bin("agent", &[])
            .or_else(|| resolve_bin("cursor-agent", &[]))
            .ok_or_else(|| {
                let avail = list_available_providers().join(", ");
                format!("Cursor Agent is not installed. Available providers: {avail}")
            })?,
        "grok" => resolve_bin("grok", &[]).ok_or_else(|| {
            let avail = list_available_providers().join(", ");
            format!("Grok is not installed. Available providers: {avail}")
        })?,
        "opencode" => {
            let natives = crate::chat::persistent::opencode_native_paths();
            let fallbacks: Vec<&str> = natives.iter().map(String::as_str).collect();
            resolve_bin("opencode", &fallbacks).ok_or_else(|| {
                let avail = list_available_providers().join(", ");
                format!("OpenCode is not installed. Available providers: {avail}")
            })?
        }
        "gemini" => resolve_bin("gemini", &[]).ok_or_else(|| {
            let avail = list_available_providers().join(", ");
            format!("Gemini CLI is not installed. Available providers: {avail}")
        })?,
        other => return Err(format!("{other} has no local chat command in this build.")),
    };
    Ok(program)
}

pub fn build_spawn(
    provider: &str,
    mode: &str,
    values: &SendValues<'_>,
    effort: Option<&str>,
    prompt: &str,
) -> Result<SpawnPlan, String> {
    let spawn = spawn_args(provider, mode, values, effort, prompt)?;
    let program = resolve_spawn_program(provider)?;
    Ok(SpawnPlan {
        endpoint: spawn.endpoint,
        program,
        args: spawn.args,
        connection_id: values.connection_id.filter(|id| !id.is_empty()).map(str::to_string),
    })
}

pub fn write_approval_to_run(thread_id: &str, request_id: &str, decision: &str) {
    let stdin_arc = {
        let mut live = live_turns().lock().unwrap();
        let run_id = live.by_thread.get(thread_id).cloned();
        let mut handle = None;
        if let Some(ref rid) = run_id {
            if let Some(run) = live.runs.get_mut(rid) {
                handle = run.stdin.clone();
                push_event(
                    run,
                    json!({
                        "kind": "approvalResolved",
                        "requestId": request_id,
                        "decision": decision
                    }),
                );
                if decision != "denyAndStop" {
                    push_event(run, json!({ "kind": "status", "status": "running" }));
                }
            }
        }
        handle
    };
    live_cv().notify_all();

    {
        let mut items = threads().lock().unwrap();
        if let Some(thread) = items.iter_mut().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id)) {
            thread["pendingApproval"] = Value::Null;
            if decision != "denyAndStop" {
                thread["status"] = json!("running");
            }
            touch(thread);
        }
    }
    persist();

    if let Some(stdin_mutex) = stdin_arc {
        if let Ok(mut stdin) = stdin_mutex.lock() {
            let line = crate::acp::format_acp_approval_response(request_id, decision);
            let _ = stdin.write_all(line.as_bytes());
            let _ = stdin.flush();
        }
    }
}

pub fn stream_child(thread_id: String, run_id: String, assistant_id: String, mut child: crate::hidden_exec::HiddenChild) {
    let pid = child.id();
    chat_log(&format!("stream_child: started for run_id={}, pid={}", run_id, pid));
    let stdin = child.stdin.take().map(|s| Arc::new(Mutex::new(s)));
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let shared = Arc::new(Mutex::new(child));
    {
        let mut live = live_turns().lock().unwrap();
        if let Some(run) = live.runs.get_mut(&run_id) {
            run.child = Some(Arc::clone(&shared));
            run.stdin = stdin;
        }
    }
    let out_run = run_id.clone();
    let out_id = assistant_id.clone();
    let err_run = run_id.clone();
    let err_id = assistant_id.clone();
    let out_thread = thread_id.clone();
    let err_thread = thread_id.clone();
    let stdout_thread = std::thread::spawn(move || {
        if let Some(stdout) = stdout {
            read_pipe(stdout, &out_thread, &out_run, &out_id);
        }
    });
    let stderr_thread = std::thread::spawn(move || {
        if let Some(stderr) = stderr {
            read_pipe(stderr, &err_thread, &err_run, &err_id);
        }
    });
    let _ = stdout_thread.join();
    let _ = stderr_thread.join();
    {
        let mut live = live_turns().lock().unwrap();
        if let Some(run) = live.runs.get_mut(&run_id) {
            run.stdin = None;
        }
    }
    let status = shared.lock().ok().and_then(|mut child| child.wait().ok());
    let ok = status.map(|code| code == 0).unwrap_or(false);
    chat_log(&format!("stream_child: process exited for run_id={}, pid={}, ok={}", run_id, pid, ok));
    let message = if ok { String::new() } else { "The provider command exited with an error.".into() };
    finish_run(&run_id, ok, false, &message);
}

pub fn handle_stream_json_line(thread_id: &str, run_id: &str, assistant_id: &str, line: &str) -> bool {
    let trimmed = line.trim();
    if !trimmed.starts_with('{') || !trimmed.ends_with('}') {
        return false;
    }
    let Ok(val) = serde_json::from_str::<Value>(trimmed) else {
        return false;
    };

    if let Some(acp_event) = crate::acp::parse_acp_stream_line(thread_id, run_id, trimmed) {
        match acp_event {
            crate::acp::AcpStreamEvent::Init { conversation_id, model } => {
                if !conversation_id.is_empty() {
                    let mut items = threads().lock().unwrap();
                    if let Some(thread) = items.iter_mut().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id)) {
                        thread["providerSessionId"] = json!(conversation_id);
                        if !model.is_empty() && (thread.get("model").is_none() || thread["model"].is_null()) {
                            thread["model"] = json!(model);
                        }
                        touch(thread);
                    }
                    drop(items);
                    persist();
                }
                return true;
            }
            crate::acp::AcpStreamEvent::ContentDelta { text } => {
                emit_deltas(thread_id, run_id, assistant_id, &text);
                return true;
            }
            crate::acp::AcpStreamEvent::ThoughtDelta {
                text,
                is_done,
                duration_seconds,
            } => {
                let step_index = val
                    .pointer("/step_update/step_index")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0);
                let thought_id = format!("r_{}_{}", run_id, step_index);
                let mut reasoning_item = chat_item(&thought_id, "reasoning", &text, !is_done);
                if let Some(dur) = duration_seconds {
                    reasoning_item["durationSeconds"] = json!(dur);
                }
                {
                    let mut live = live_turns().lock().unwrap();
                    if let Some(run) = live.runs.get_mut(run_id) {
                        push_event(run, json!({ "kind": "upsert", "item": reasoning_item.clone() }));
                    }
                }
                live_cv().notify_all();
                let mut items = threads().lock().unwrap();
                if let Some(thread) = items.iter_mut().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id)) {
                    upsert_item(thread, &reasoning_item);
                }
                return true;
            }
            crate::acp::AcpStreamEvent::ToolUpdate { tool } => {
                let is_streaming = tool.status == "running" || tool.status == "pending";
                let is_terminal = tool.status == "completed" || tool.status == "failed";
                let output_str = tool.output.as_deref().unwrap_or("");
                let mut tool_item = chat_item(&tool.id, "tool", output_str, is_streaming);
                tool_item["title"] = json!(if tool.title.is_empty() { tool.name.clone() } else { tool.title.clone() });
                tool_item["detail"] = json!(tool.detail);
                tool_item["status"] = json!(tool.status);
                tool_item["toolName"] = json!(tool.name);
                tool_item["toolKind"] = json!(tool.tool_kind);
                if let Some(srv) = tool.server_name {
                    tool_item["serverName"] = json!(srv);
                }
                if let Some(cmd) = tool.command {
                    tool_item["command"] = json!(cmd);
                }
                if let Some(fp) = tool.file_path {
                    tool_item["filePath"] = json!(fp);
                }
                if let Some(add) = tool.added_lines {
                    tool_item["addedLines"] = json!(add);
                }
                if let Some(rem) = tool.removed_lines {
                    tool_item["removedLines"] = json!(rem);
                }
                if let Some(dur) = tool.duration_seconds {
                    tool_item["durationSeconds"] = json!(dur);
                }

                {
                    let mut live = live_turns().lock().unwrap();
                    if let Some(run) = live.runs.get_mut(run_id) {
                        push_event(run, json!({ "kind": "upsert", "item": tool_item.clone() }));
                    }
                }
                live_cv().notify_all();
                {
                    let mut items = threads().lock().unwrap();
                    if let Some(thread) = items.iter_mut().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id)) {
                        upsert_item(thread, &tool_item);
                        touch(thread);
                    }
                }
                if is_terminal {
                    persist();
                }
                return true;
            }
            crate::acp::AcpStreamEvent::PermissionRequired { approval } => {
                let approval_val = json!({
                    "id": approval.request_id,
                    "toolName": approval.tool_name,
                    "title": approval.title,
                    "detail": approval.description,
                    "risk": approval.risk,
                    "impact": approval.impact,
                    "text": approval.description,
                    "command": approval.command,
                    "path": approval.path,
                    "tool": approval.tool_name,
                    "parameters": approval.details,
                    "status": "pending"
                });
                {
                    let mut live = live_turns().lock().unwrap();
                    if let Some(run) = live.runs.get_mut(run_id) {
                        push_event(run, json!({ "kind": "approvalOpened", "approval": approval_val.clone() }));
                        push_event(run, json!({ "kind": "status", "status": "waiting" }));
                    }
                }
                live_cv().notify_all();
                {
                    let mut items = threads().lock().unwrap();
                    if let Some(thread) = items.iter_mut().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id)) {
                        thread["pendingApproval"] = approval_val;
                        thread["status"] = json!("waiting");
                        touch(thread);
                    }
                }
                persist();
                return true;
            }
            crate::acp::AcpStreamEvent::PlanUpdate { step, status } => {
                let plan_item_id = format!("plan_{}", run_id);
                let is_streaming = status == "running" || status == "pending";
                let mut plan_item = chat_item(&plan_item_id, "tool", &step, is_streaming);
                plan_item["title"] = json!(format!("Plan · {}", step));
                plan_item["status"] = json!(status);
                plan_item["toolKind"] = json!("planUpdate");
                {
                    let mut live = live_turns().lock().unwrap();
                    if let Some(run) = live.runs.get_mut(run_id) {
                        push_event(run, json!({ "kind": "upsert", "item": plan_item.clone() }));
                    }
                }
                live_cv().notify_all();
                let mut items = threads().lock().unwrap();
                if let Some(thread) = items.iter_mut().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id)) {
                    upsert_item(thread, &plan_item);
                }
                return true;
            }
            crate::acp::AcpStreamEvent::Result {
                input_tokens,
                output_tokens,
                duration_seconds,
                ..
            } => {
                let usage_val = json!({
                    "inputTokens": input_tokens,
                    "outputTokens": output_tokens,
                    "durationSeconds": duration_seconds,
                    "costUsd": (input_tokens as f64 * 0.000003) + (output_tokens as f64 * 0.000015)
                });
                {
                    let mut live = live_turns().lock().unwrap();
                    if let Some(run) = live.runs.get_mut(run_id) {
                        push_event(run, json!({ "kind": "usage", "usage": usage_val.clone() }));
                    }
                }
                live_cv().notify_all();
                {
                    let mut items = threads().lock().unwrap();
                    if let Some(thread) = items.iter_mut().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id)) {
                        thread["usage"] = usage_val;
                        touch(thread);
                    }
                }
                persist();
                return true;
            }
            crate::acp::AcpStreamEvent::Raw { .. } => {}
        }
    }

    if val.get("event").is_some() || val.get("jsonrpc").is_some() {
        return true;
    }

    false
}

pub fn read_pipe(mut pipe: impl Read, thread_id: &str, run_id: &str, assistant_id: &str) {
    let mut pending = Vec::new();
    let mut buf = [0u8; 4096];
    loop {
        let read = pipe.read(&mut buf);
        let Ok(count) = read else { break };
        if count == 0 {
            break;
        }
        pending.extend_from_slice(&buf[..count]);
        while let Some(pos) = pending.iter().position(|&b| b == b'\n') {
            let line_bytes: Vec<u8> = pending.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line_bytes);
            if !handle_stream_json_line(thread_id, run_id, assistant_id, &line) {
                emit_deltas(thread_id, run_id, assistant_id, &line);
            }
        }
    }
    if !pending.is_empty() {
        let text = String::from_utf8_lossy(&pending);
        if !handle_stream_json_line(thread_id, run_id, assistant_id, &text) {
            emit_deltas(thread_id, run_id, assistant_id, &text);
        }
    }
}

pub fn emit_deltas(thread_id: &str, run_id: &str, assistant_id: &str, text: &str) {
    let clean = sanitize_chat_text(text);
    if clean.is_empty() {
        return;
    }
    for chunk in chars_chunks(&clean, 8000) {
        let appended = {
            let mut live = live_turns().lock().unwrap();
            let Some(run) = live.runs.get_mut(run_id) else { return };
            if run.closing || run.finished {
                return;
            }
            if run.assistant_text.chars().count() >= 200_000 {
                return;
            }
            let room = 200_000 - run.assistant_text.chars().count();
            let piece: String = chunk.chars().take(room).collect();
            run.assistant_text.push_str(&piece);
            push_event(run, json!({ "kind": "delta", "itemId": assistant_id, "text": piece }));
            run.assistant_text.clone()
        };
        live_cv().notify_all();
        let item = chat_item(assistant_id, "assistant", &appended, true);
        let mut items = threads().lock().unwrap();
        if let Some(thread) = items.iter_mut().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id)) {
            upsert_item(thread, &item);
        }
    }
}

pub fn chars_chunks(text: &str, size: usize) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut current = String::new();
    for ch in text.chars() {
        current.push(ch);
        if current.len() >= size {
            chunks.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

pub fn finish_run(run_id: &str, ok: bool, stopped: bool, error_text: &str) {
    chat_log(&format!("finish_run starting: run_id={}, ok={}, stopped={}", run_id, ok, stopped));
    let (thread_id, assistant_id, assistant_text, routine_id) = {
        let mut live = live_turns().lock().unwrap();
        let thread_id = live.by_thread.iter().find(|(_, id)| id.as_str() == run_id).map(|(thread, _)| thread.clone());
        let Some(run) = live.runs.get_mut(run_id) else {
            chat_log(&format!("finish_run: run {} not found in live_turns", run_id));
            return;
        };
        if run.closing || run.finished {
            chat_log(&format!("finish_run: run {} already closing or finished", run_id));
            return;
        }
        run.closing = true;
        (thread_id, run.assistant_id.clone(), run.assistant_text.clone(), run.routine_id.clone())
    };
    let thread_id = thread_id.unwrap_or_default();
    let mut profile_for_routine: Option<String> = None;
    let mut reflection_task: Option<(String, String, String)> = None;
    let mut quota_events: Option<(Value, Value)> = None;

    let error_item = if !ok && !stopped && assistant_text.is_empty() && !error_text.is_empty() {
        Some(chat_item(&format!("e{}", Uuid::new_v4().simple()), "error", error_text, false))
    } else {
        None
    };

    let final_item = chat_item(&assistant_id, "assistant", &assistant_text, false);

    if !thread_id.is_empty() {
        let mut items = threads().lock().unwrap();
        if let Some(thread) = items.iter_mut().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id.as_str())) {
            if let Some(ref err_it) = error_item {
                upsert_item(thread, err_it);
            }
            if !assistant_text.is_empty() {
                upsert_item(thread, &final_item);
            }
            let final_status = if ok || stopped { "idle" } else { "error" };
            thread["status"] = json!(final_status);

            if let Some(arr) = thread.get_mut("items").and_then(|v| v.as_array_mut()) {
                for it in arr.iter_mut() {
                    if it.get("streaming").and_then(|v| v.as_bool()) == Some(true) {
                        it["streaming"] = json!(false);
                    }
                }
            }

            let has_existing_usage = thread
                .get("usage")
                .and_then(|u| u.get("inputTokens"))
                .and_then(|v| v.as_i64())
                .unwrap_or(0) > 0;

            if !has_existing_usage {
                let out_tokens = (assistant_text.len() / 4).max(1) as i64;
                let in_tokens = thread
                    .get("items")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|it| it.get("text").and_then(|t| t.as_str()))
                            .map(|s| s.len() / 4)
                            .sum::<usize>() as i64
                    })
                    .unwrap_or(0);

                let total_in = in_tokens.max(10);
                let total_out = out_tokens;
                thread["usage"] = json!({
                    "inputTokens": total_in,
                    "outputTokens": total_out,
                    "costUsd": (total_in as f64 * 0.000003) + (total_out as f64 * 0.000015)
                });
            }

            let title = thread.get("title").and_then(|v| v.as_str()).unwrap_or("");
            if matches!(title, "New Chat" | "New Agent Chat" | "Chat" | "") {
                if let Some(first_user) = thread.get("items")
                    .and_then(|v| v.as_array())
                    .and_then(|arr| arr.iter().find(|it| it.get("kind").and_then(|k| k.as_str()) == Some("user")))
                    .and_then(|it| it.get("text").and_then(|t| t.as_str()))
                {
                    let first_line = first_user.lines().next().unwrap_or("").trim();
                    if !first_line.is_empty() {
                        let concise: String = first_line.chars().take(60).collect();
                        thread["title"] = json!(concise);
                        thread["titleOrigin"] = json!("generated");
                    }
                }
            }

            touch(thread);

            // Plan lifecycle handling
            let is_planning = thread.get("plan").and_then(|v| v.as_bool()).unwrap_or(false);
            let has_proposed_tag = assistant_text.contains("<proposed_plan>");
            if is_planning || has_proposed_tag {
                let plan_markdown = if let Some(start) = assistant_text.find("<proposed_plan>") {
                    let inner = &assistant_text[start + 15..];
                    if let Some(end) = inner.find("</proposed_plan>") {
                        inner[..end].trim().to_string()
                    } else {
                        inner.trim().to_string()
                    }
                } else {
                    assistant_text.trim().to_string()
                };

                if !plan_markdown.is_empty() {
                    let mut plans = thread.get("plans").and_then(|v| v.as_array()).cloned().unwrap_or_default();
                    let active_id = thread.get("activePlanId").and_then(|v| v.as_str()).map(|s| s.to_string());
                    let mut updated = false;

                    if let Some(ref aid) = active_id {
                        if let Some(slot) = plans.iter_mut().find(|p| p.get("id").and_then(|v| v.as_str()) == Some(aid.as_str())) {
                            let rev = slot.get("revision").and_then(|v| v.as_i64()).unwrap_or(1);
                            slot["revision"] = json!(rev + 1);
                            slot["markdown"] = json!(plan_markdown);
                            slot["status"] = json!("ready");
                            slot["sourceTurnId"] = json!(run_id);
                            updated = true;
                        }
                    }

                    if !updated {
                        let new_id = Uuid::new_v4().to_string();
                        plans.push(json!({
                            "id": new_id,
                            "revision": 1,
                            "sourceTurnId": run_id,
                            "markdown": plan_markdown,
                            "status": "ready"
                        }));
                        thread["activePlanId"] = json!(new_id);
                    }
                    thread["plans"] = Value::Array(plans);
                }
            } else {
                let aid = thread.get("activePlanId").and_then(|v| v.as_str()).map(|s| s.to_string());
                if let Some(aid) = aid {
                    if let Some(plans) = thread.get_mut("plans").and_then(|v| v.as_array_mut()) {
                        if let Some(slot) = plans.iter_mut().find(|p| p.get("id").and_then(|v| v.as_str()) == Some(aid.as_str())) {
                            if slot.get("status").and_then(|v| v.as_str()) == Some("implementing") {
                                slot["status"] = json!(if ok { "completed" } else if stopped { "interrupted" } else { "failed" });
                            }
                        }
                    }
                }
            }

            // ── Quota Exhaustion & Handoff Detection ──
            let current_provider = thread.get("provider").and_then(|v| v.as_str()).unwrap_or("antigravity").to_string();
            let combined_output = format!("{}\n{}", assistant_text, error_text);
            if !ok || !stopped {
                if let Some(reason) = crate::handoff::detect_quota_exhaustion(&current_provider, &combined_output) {
                    let workspace_id = thread.get("workspaceId").and_then(|v| v.as_str());
                    let handoff_capsule = crate::handoff::build_handoff_capsule_from_thread(
                        Some(thread),
                        &current_provider,
                        &assistant_text,
                        workspace_id,
                    );
                    let suggestions_val = crate::handoff::recommend_continuation_targets_direct(current_provider.clone());
                    let suggestions = suggestions_val.get("suggestions").cloned().unwrap_or(json!([]));

                    let offer = json!({
                        "failedProvider": current_provider,
                        "reason": reason,
                        "partialOutput": assistant_text,
                        "handoffPrompt": handoff_capsule,
                        "suggestions": suggestions,
                        "offeredAtUnixMs": now_ms()
                    });
                    thread["quotaHandoffOffer"] = offer.clone();

                    let handoff_item = json!({
                        "id": format!("qho_{}", Uuid::new_v4().simple()),
                        "kind": "quotaHandoff",
                        "text": format!("Se ha detectado agotamiento de cuota en {}: {}", current_provider, reason),
                        "title": "Límite de cuota alcanzado",
                        "detail": Value::Null,
                        "status": "ready",
                        "streaming": false,
                        "exitCode": Value::Null,
                        "createdAtUnixMs": now_ms(),
                        "attachments": [],
                        "handoffOffer": offer
                    });
                    upsert_item(thread, &handoff_item);
                    quota_events = Some((handoff_item, offer));
                }
            }

            profile_for_routine = thread.get("profileId").and_then(|v| v.as_str()).map(|s| s.to_string());
            if ok {
                if let Some(ref pid) = profile_for_routine {
                    let user_prompt = thread.get("items")
                        .and_then(|v| v.as_array())
                        .and_then(|arr| arr.iter().rev().find(|it| it.get("kind").and_then(|k| k.as_str()) == Some("user")))
                        .and_then(|it| it.get("text").and_then(|t| t.as_str()))
                        .unwrap_or("");
                    if !user_prompt.is_empty() {
                        reflection_task = Some((pid.clone(), user_prompt.to_string(), assistant_text.clone()));
                    }
                }
            }
        }
        drop(items);
    }

    if let Some((ref pid, ref user_prompt, ref a_text)) = reflection_task {
        crate::agent_mind::apply_post_turn_reflection(pid, user_prompt, a_text);
    }

    if let Some(routine_id) = routine_id.as_deref() {
        if !thread_id.is_empty() {
            settle_routine(run_id, &thread_id, routine_id, profile_for_routine.as_deref(), ok, stopped);
        }
    }

    {
        let mut live = live_turns().lock().unwrap();
        if let Some(run) = live.runs.get_mut(run_id) {
            if let Some(ref err_it) = error_item {
                append_event(run, json!({ "kind": "upsert", "item": err_it }), true);
            }
            if let Some((ref handoff_item, ref offer)) = quota_events {
                append_event(run, json!({ "kind": "upsert", "item": handoff_item }), true);
                append_event(run, json!({ "kind": "quotaHandoff", "offer": offer }), true);
            }
            if !run.finished {
                if !assistant_text.is_empty() {
                    append_event(run, json!({ "kind": "upsert", "item": final_item }), true);
                }
                let final_status = if ok || stopped { "idle" } else { "error" };
                append_event(run, json!({ "kind": "status", "status": final_status }), true);
                append_event(run, json!({ "kind": "finished", "ok": ok && !stopped, "stoppedByBuilder": stopped }), true);
                run.finished = true;
            }
        }
        prune_stale_runs(&mut live);
    }

    live_cv().notify_all();
    persist();
    chat_log(&format!("finish_run: completed cleanly for run_id={}", run_id));
}

pub fn settle_routine(run_id: &str, thread_id: &str, routine_id: &str, profile_id: Option<&str>, ok: bool, stopped: bool) {
    if Uuid::parse_str(thread_id).is_err() || Uuid::parse_str(run_id).is_err() {
        return;
    }
    let outcome = if stopped {
        "cancelled"
    } else if ok {
        "completed"
    } else {
        "failed"
    };
    let profile = profile_id.filter(|id| Uuid::parse_str(id).is_ok());
    let routine = if Uuid::parse_str(routine_id).is_ok() {
        json!(routine_id)
    } else {
        Value::Null
    };
    let notice = json!({
        "id": Uuid::new_v4().to_string(),
        "runId": run_id,
        "target": { "source": "codeThread", "id": thread_id },
        "profileId": profile,
        "routineId": routine,
        "kind": { "kind": "settled", "outcome": outcome },
        "resolution": "runSettled",
        "createdAtUnixMs": now_ms(),
        "isRead": false,
        "isWaitingForInput": false
    });
    let mut items = notifications().lock().unwrap();
    items.insert(0, notice);
    if items.len() > 100 {
        items.truncate(100);
    }
}

#[tauri::command]
pub fn continue_turn_with_handoff(request: Option<Value>) -> Result<Value, String> {
    let req = crate::persist::body(&request);
    let thread_id = req
        .and_then(|r| r.get("threadId").or_else(|| r.get("thread_id")))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let target_provider = req
        .and_then(|r| r.get("targetProvider").or_else(|| r.get("target_provider")))
        .and_then(|v| v.as_str())
        .unwrap_or("agy")
        .to_string();
    let target_account_id = req
        .and_then(|r| r.get("targetAccountId").or_else(|| r.get("target_account_id")))
        .and_then(|v| v.as_str())
        .map(String::from);
    let custom_handoff_prompt = req
        .and_then(|r| r.get("customHandoffPrompt").or_else(|| r.get("custom_handoff_prompt")))
        .and_then(|v| v.as_str())
        .map(String::from);

    if let Some(ref acc_id) = target_account_id {
        let res = crate::account_switcher::switch_account_profile_direct(target_provider.clone(), acc_id.clone());
        if res.get("success").and_then(|v| v.as_bool()) != Some(true) {
            let msg = res
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("No se pudo cambiar de cuenta.")
                .to_string();
            return Err(msg);
        }
    }

    let mut thread = {
        let items = threads().lock().unwrap();
        items.iter().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(&thread_id)).cloned()
    }.unwrap_or_else(|| load_thread(&thread_id, None, "Chat"));

    let handoff_prompt = if let Some(p) = custom_handoff_prompt.filter(|s| !s.trim().is_empty()) {
        p
    } else if let Some(saved) = thread.pointer("/quotaHandoffOffer/handoffPrompt").and_then(|v| v.as_str()) {
        saved.to_string()
    } else {
        let from_p = thread.get("provider").and_then(|v| v.as_str()).unwrap_or("antigravity");
        let ws_id = thread.get("workspaceId").and_then(|v| v.as_str());
        crate::handoff::build_handoff_capsule(&thread_id, from_p, "", ws_id)
    };

    thread["quotaHandoffOffer"] = Value::Null;
    thread["providerSessionId"] = Value::Null;
    thread["provider"] = json!(target_provider);
    touch(&mut thread);
    replace_thread(&thread);

    let profile_id = thread.get("profileId").and_then(|v| v.as_str()).map(|s| s.to_string());
    Ok(start_turn(&thread_id, profile_id.as_deref(), &handoff_prompt, Vec::new(), None))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connections::EndpointVerification;

    const OPENCODE_GO_CHAT: &str =
        "https://opencode.ai/inference/go/openai/v1/chat/completions";

    fn send<'a>(
        model: Option<&'a str>,
        session_id: Option<&'a str>,
        connection_id: Option<&'a str>,
        supported_endpoint: Option<&'a str>,
        verified_endpoints: &'a [EndpointVerification],
    ) -> SendValues<'a> {
        SendValues {
            connection_id,
            model,
            session_id,
            supported_endpoint,
            verified_endpoints,
        }
    }

    fn model_flags(args: &[String]) -> Vec<&str> {
        args.iter().map(String::as_str).filter(|arg| *arg == "--model").collect()
    }

    #[test]
    fn spawns_without_a_supported_endpoint_omit_model_and_session() {
        for provider in ["cursor", "grok", "opencode", "gemini"] {
            let values = send(Some("go-model-1"), Some("session-1"), None, None, &[]);
            let spawn = spawn_args(provider, "fullAccess", &values, None, "hello")
                .unwrap_or_else(|error| panic!("{provider} spawn args: {error}"));

            let joined = spawn.args.join(" ");
            assert!(
                model_flags(&spawn.args).is_empty(),
                "{provider} must omit --model without a supported endpoint: {joined}"
            );
            assert!(
                !spawn.args.iter().any(|arg| arg == "--conversation" || arg == "--resume" || arg == "resume"),
                "{provider} must omit session resume: {joined}"
            );
            assert!(
                !spawn.args.iter().any(|arg| arg.contains("opencode.ai")),
                "{provider} must not name a network endpoint: {joined}"
            );
        }
    }

    #[test]
    fn supported_endpoint_flag_fails_on_a_spawn_without_model_support() {
        for provider in ["cursor", "grok", "opencode", "gemini"] {
            let endpoint_id = spawn_endpoint(provider)
                .unwrap_or_else(|| panic!("{provider} endpoint"))
                .endpoint_id;
            let verified = vec![EndpointVerification {
                endpoint_id: endpoint_id.to_string(),
                ok: true,
            }];
            let values = send(
                Some("go-model-1"),
                None,
                Some("connection-1"),
                Some(endpoint_id),
                &verified,
            );
            let error = spawn_args(provider, "fullAccess", &values, None, "hello")
                .expect_err("a spawn without model support must fail, not add --model");

            assert!(
                error.contains("does not support model selection"),
                "{provider}: {error}"
            );
        }
    }

    #[test]
    fn supported_endpoint_without_a_verified_connection_endpoint_fails() {
        let unverified = vec![EndpointVerification {
            endpoint_id: "agy -p".to_string(),
            ok: false,
        }];
        let values = send(
            Some("gemini-4-argon"),
            None,
            Some("antigravity:api_key:email=|org=|account="),
            Some("agy -p"),
            &unverified,
        );
        let error = spawn_args("antigravity", "fullAccess", &values, None, "hello")
            .expect_err("an endpoint that is not verified on the connection must fail");
        assert!(error.contains("is not verified for connection"), "{error}");

        let without_connection = send(Some("gemini-4-argon"), None, None, Some("agy -p"), &[]);
        let error = spawn_args("antigravity", "fullAccess", &without_connection, None, "hello")
            .expect_err("a supported endpoint needs a connection");
        assert!(error.contains("must belong to a connection"), "{error}");
    }

    #[test]
    fn verified_supported_endpoint_forwards_connection_model_and_session() {
        let connection_id = "antigravity:api_key:email=|org=|account=";
        let verified = vec![EndpointVerification {
            endpoint_id: "agy -p".to_string(),
            ok: true,
        }];
        let values = send(
            Some("gemini-4-argon"),
            Some("conversation-1"),
            Some(connection_id),
            Some("agy -p"),
            &verified,
        );

        let resolved = resolve_send("antigravity", &values).expect("supported send");
        assert_eq!(resolved.endpoint.endpoint_id, "agy -p");
        assert_eq!(resolved.connection_id, Some(connection_id));
        assert_eq!(resolved.model, Some("gemini-4-argon"));
        assert_eq!(resolved.session_id, Some("conversation-1"));

        let spawn = spawn_args("antigravity", "fullAccess", &values, None, "hello")
            .expect("spawn args");
        assert_eq!(model_flags(&spawn.args), vec!["--model"]);
        assert!(spawn.args.iter().any(|arg| arg == "gemini-4-argon"));
        assert!(spawn.args.iter().any(|arg| arg == "--conversation"));
    }

    #[test]
    fn connection_without_a_named_supported_endpoint_fails() {
        let values = send(
            Some("composer"),
            None,
            Some("cursor:api_key:email=|org=|account="),
            None,
            &[],
        );
        let error = spawn_args("cursor", "fullAccess", &values, None, "hello")
            .expect_err("a connection needs a named endpoint");
        assert!(
            error.contains("without naming the endpoint that supports it"),
            "{error}"
        );
    }

    #[test]
    fn existing_model_and_session_flags_are_preserved() {
        let agy = spawn_args(
            "antigravity",
            "readOnly",
            &send(Some("gemini-4-argon"), Some("conversation-1"), None, None, &[]),
            Some("high"),
            "hello",
        )
        .expect("antigravity args");
        assert_eq!(
            agy.args,
            vec![
                "-p",
                "Read-only mode: do not create, edit, or delete files.\n\nhello",
                "--output-format",
                "stream-json",
                "--conversation",
                "conversation-1",
                "--mode",
                "plan",
                "--model",
                "gemini-4-argon",
                "--effort",
                "high",
            ]
        );

        let claude = spawn_args(
            "claude",
            "acceptEdits",
            &send(Some("sonnet"), Some("conversation-1"), None, None, &[]),
            None,
            "hello",
        )
        .expect("claude args");
        assert_eq!(
            claude.args,
            vec![
                "-p",
                "--output-format",
                "text",
                "--permission-mode",
                "acceptEdits",
                "--resume",
                "conversation-1",
                "--model",
                "sonnet",
                "hello",
            ]
        );

        let codex = spawn_args(
            "codex",
            "acceptEdits",
            &send(Some("gpt-6-sol"), Some("conversation-1"), None, None, &[]),
            None,
            "hello",
        )
        .expect("codex args");
        assert_eq!(
            codex.args,
            vec![
                "exec",
                "resume",
                "conversation-1",
                "--skip-git-repo-check",
                "--full-auto",
                "--model",
                "gpt-6-sol",
                "hello",
            ]
        );
    }

    #[test]
    fn claiming_the_go_chat_endpoint_on_a_cli_spawn_fails() {
        let verified = vec![EndpointVerification {
            endpoint_id: OPENCODE_GO_CHAT.to_string(),
            ok: true,
        }];
        let values = send(
            Some("go-model-1"),
            Some("session-1"),
            Some("opencode:api_key:email=|org=|account="),
            Some(OPENCODE_GO_CHAT),
            &verified,
        );
        let error = spawn_args("opencode", "fullAccess", &values, None, "hello")
            .expect_err("the Go chat route is not the opencode run endpoint");
        assert!(
            error.contains("is not the endpoint the opencode spawn uses"),
            "{error}"
        );
    }

    #[test]
    fn opencode_run_is_not_evidence_for_the_go_chat_endpoint() {
        let endpoint = spawn_endpoint("opencode").expect("opencode endpoint");
        assert_eq!(endpoint.endpoint_id, "opencode run");
        assert_ne!(endpoint.endpoint_id, OPENCODE_GO_CHAT);
        assert!(
            !endpoint.endpoint_id.contains("opencode.ai"),
            "a local spawn endpoint is not a network route"
        );

        let spawn = spawn_args(
            "opencode",
            "fullAccess",
            &send(None, None, None, None, &[]),
            None,
            "hello",
        )
        .expect("opencode args");
        assert_eq!(spawn.args, vec!["run", "hello"]);
        assert!(!spawn.args.iter().any(|arg| arg.contains(OPENCODE_GO_CHAT)));
    }

    use crate::chat::session::{ScriptedTransport, SessionState};

    fn persistent_spec(thread_id: &str) -> SessionSpec {
        SessionSpec {
            thread_id: thread_id.to_string(),
            driver: "codex".to_string(),
            connection_id: None,
            working_directory: None,
            mode: SessionMode::Persistent,
            recipe: None,
        }
    }

    #[test]
    fn the_persistent_route_requires_a_persistent_declaration_and_the_flag() {
        for driver in ["antigravity", "agy", "opencode"] {
            assert_eq!(send_route(driver, true), SendRoute::Persistent, "{driver}");
            assert_eq!(send_route(driver, false), SendRoute::OneShot, "{driver}");
        }
        for driver in ["codex", "gemini", "grok", "cursor", "claude", "not-a-driver"] {
            assert_eq!(send_route(driver, true), SendRoute::OneShot, "{driver}");
            assert_eq!(send_route(driver, false), SendRoute::OneShot, "{driver}");
        }
    }

    #[test]
    fn only_the_exact_flag_value_enables_persistent_sessions() {
        assert!(persistent_flag_enabled(Some("1")));
        for raw in [
            None,
            Some(""),
            Some("0"),
            Some("true"),
            Some(" 1"),
            Some("1 "),
            Some("01"),
            Some("1\n"),
        ] {
            assert!(!persistent_flag_enabled(raw), "{raw:?} must not enable sessions");
        }
    }

    #[test]
    fn operational_notices_stay_bounded() {
        let long = "é".repeat(MAX_NOTICE_CHARS + 250);
        let notice = bounded_notice(&long);

        assert_eq!(notice.chars().count(), MAX_NOTICE_CHARS);
        assert!(!notice.contains('\u{0}'));
    }

    #[test]
    fn a_managed_send_that_never_started_keeps_the_prompt_for_the_one_shot_path() {
        let mut manager = SessionManager::new();
        let transport = ScriptedTransport::new().failing_spawn("no lasting wire");

        let error = managed_send(
            &mut manager,
            persistent_spec("thread-1"),
            Box::new(transport),
            "command-1",
            "keep this prompt",
        )
        .unwrap_err();

        assert!(error.before_turn());
        assert!(error.reason().contains("no lasting wire"));
        assert_eq!(
            manager.status("thread-1").map(|record| record.state),
            Some(SessionState::Failed)
        );
    }

    #[test]
    fn a_managed_send_writes_only_the_new_message_to_one_session() {
        let mut manager = SessionManager::new();
        let transport = ScriptedTransport::new();
        let probe = transport.clone();

        managed_send(
            &mut manager,
            persistent_spec("thread-1"),
            Box::new(transport),
            "command-1",
            "first",
        )
        .expect("first managed send");
        managed_send(
            &mut manager,
            persistent_spec("thread-1"),
            Box::new(ScriptedTransport::new()),
            "command-2",
            "second",
        )
        .expect("second managed send");

        assert_eq!(probe.written_turns(), vec!["first".to_string(), "second".to_string()]);
        assert_eq!(probe.spawn_count(), 1);
    }

    #[test]
    fn the_manager_route_rejects_a_non_persistent_mode() {
        let mut manager = SessionManager::new();
        let mut spec = persistent_spec("thread-1");
        spec.mode = SessionMode::Resumable;

        let error = managed_send(
            &mut manager,
            spec,
            Box::new(ScriptedTransport::new()),
            "command-1",
            "hello",
        )
        .unwrap_err();

        assert!(error.before_turn());
        assert!(manager.status("thread-1").is_none());
    }

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "kite-runtime-{label}-{}-{nanos}",
                std::process::id()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn agent_recipe() -> RecipeSnapshot {
        RecipeSnapshot {
            agent_id: "agent-1".to_string(),
            revision: "r1".to_string(),
            role: "Ordered role.".to_string(),
            memory: "memory".to_string(),
            user: "user".to_string(),
            skills: vec!["root-cause".to_string()],
        }
    }

    #[test]
    fn the_recipe_is_written_before_the_session_starts() {
        let dir = TempDir::new("recipe-order");
        let recipe = agent_recipe();
        let mut spec = persistent_spec("thread-1");
        spec.recipe = Some(recipe.clone());
        let transport = ScriptedTransport::new();
        let probe = transport.clone();
        let observer = transport.clone();
        let spawns_at_prepare = Arc::new(Mutex::new(None));
        let observed = spawns_at_prepare.clone();
        let target = dir.path().to_path_buf();
        let for_prepare = recipe.clone();
        let mut manager = SessionManager::new();

        managed_send_prepared(
            &mut manager,
            spec,
            Box::new(transport),
            "command-1",
            "hello",
            move || {
                *observed.lock().unwrap() = Some(observer.spawn_count());
                apply_agent_recipe(&target, Some(&for_prepare)).map(|_| ())
            },
        )
        .expect("prepared send");

        assert_eq!(*spawns_at_prepare.lock().unwrap(), Some(0));
        let agents = std::fs::read_to_string(dir.path().join("AGENTS.md")).expect("recipe written");
        assert!(agents.contains("Ordered role."));
        assert_eq!(
            probe.spawned_specs()[0].recipe_revision.as_deref(),
            Some("r1")
        );
    }

    #[test]
    fn a_loose_chat_writes_no_recipe_before_the_session_starts() {
        let dir = TempDir::new("loose-chat");

        assert_eq!(apply_agent_recipe(dir.path(), None), Ok(false));
        assert!(!dir.path().join("AGENTS.md").exists());
        assert!(!dir.path().join("CLAUDE.md").exists());
    }

    #[test]
    fn a_live_session_does_not_start_another_process() {
        assert!(starts_new_session(None));
        assert!(!starts_new_session(Some(SessionState::Running)));
        assert!(!starts_new_session(Some(SessionState::Waiting)));
        assert!(!starts_new_session(Some(SessionState::Completed)));
        assert!(starts_new_session(Some(SessionState::Closed)));
        assert!(starts_new_session(Some(SessionState::Failed)));
        assert!(starts_new_session(Some(SessionState::Interrupted)));
        assert!(starts_new_session(Some(SessionState::Resumable)));
    }

    #[test]
    fn a_preparation_failure_starts_nothing_and_is_not_replayed() {
        let transport = ScriptedTransport::new();
        let probe = transport.clone();
        let mut manager = SessionManager::new();

        let error = managed_send_prepared(
            &mut manager,
            persistent_spec("thread-1"),
            Box::new(transport),
            "command-1",
            "keep this prompt",
            || Err("recipe could not be written".to_string()),
        )
        .unwrap_err();

        assert_eq!(
            error,
            ManagedSendError::Prepare("recipe could not be written".to_string())
        );
        assert!(!error.before_turn());
        assert_eq!(probe.spawn_count(), 0);
        assert!(manager.status("thread-1").is_none());
    }

    #[test]
    fn one_shot_notices_follow_the_driver_declaration() {
        for driver in ["gemini", "grok", "cursor"] {
            let notice = one_shot_notice(driver, true).expect("resumable notice");
            assert!(notice.contains("provider-issued id"), "{driver}: {notice}");
            assert!(
                notice.chars().count() <= MAX_NOTICE_CHARS,
                "{driver} notice must stay bounded"
            );
        }

        let claude = one_shot_notice("claude", true).expect("unobserved notice");
        assert!(claude.contains("could not be observed"), "{claude}");

        let disabled = one_shot_notice("antigravity", false).expect("disabled notice");
        assert!(disabled.contains("Persistent sessions are off"), "{disabled}");
        assert!(one_shot_notice("antigravity", true).is_none());
        assert!(one_shot_notice("codex", true).is_none());
        assert!(one_shot_notice("opencode", true).is_none());
        assert!(one_shot_notice("not-a-driver", true).is_none());
    }

    #[test]
    fn transport_selection_follows_the_declaration_and_wire() {
        let antigravity = select_persistent_transport("antigravity", PersistentControls::default())
            .expect("antigravity transport");
        assert_eq!(antigravity.kind, TransportKind::Antigravity);
        assert_eq!(antigravity.driver, "antigravity");
        assert_eq!(antigravity.version.minimum.to_string(), "1.4.5");

        let opencode = select_persistent_transport("opencode", PersistentControls::default())
            .expect("opencode transport");
        assert_eq!(opencode.kind, TransportKind::OpenCodeServer);
        assert_eq!(opencode.version.minimum.to_string(), "2.1.4");

        let codex = select_persistent_transport("codex", PersistentControls::default())
            .expect_err("codex documents no turn frame");
        assert!(codex.contains("Unsupported"), "{codex}");
        assert!(codex.contains("app-server"), "{codex}");

        for driver in ["claude", "gemini", "grok", "cursor"] {
            let error = select_persistent_transport(driver, PersistentControls::default())
                .expect_err("no lasting wire");
            assert!(error.contains("Unsupported"), "{driver}: {error}");
        }

        let unknown = select_persistent_transport("not-a-driver", PersistentControls::default())
            .expect_err("unknown driver");
        assert!(unknown.contains("no driver declaration"), "{unknown}");
    }

    #[test]
    fn an_unsupported_wire_keeps_the_prompt_and_attaches_nothing() {
        let mut manager = SessionManager::new();

        let outcome = match select_persistent_transport("codex", PersistentControls::default()) {
            Ok(selected) => managed_send_prepared(
                &mut manager,
                persistent_spec("thread-1"),
                selected.transport,
                "command-1",
                "keep this prompt",
                || Ok(()),
            ),
            Err(reason) => Err(ManagedSendError::Start(reason)),
        };

        let error = outcome.expect_err("the codex wire is refused");
        assert!(error.before_turn());
        assert!(error.reason().contains("app-server"), "{error:?}");
        assert!(manager.status("thread-1").is_none());
        assert_eq!(manager.active_thread_count(), 0);
    }

    #[test]
    fn a_fallback_notice_is_bounded_and_names_the_reason() {
        let reason = "Unsupported: codex: `codex app-server --help` documents the stdio transport";
        let notice = persistent_fallback_notice("codex", reason);

        assert!(notice.starts_with("Persistent sessions are enabled"), "{notice}");
        assert!(notice.contains("codex"), "{notice}");
        assert!(notice.contains("app-server"), "{notice}");
        assert!(notice.contains("This turn runs as one command."), "{notice}");
        assert!(notice.chars().count() <= MAX_NOTICE_CHARS);
    }

    #[test]
    fn a_version_mismatch_becomes_a_bounded_fallback_notice() {
        let evidence = declaration("antigravity")
            .expect("antigravity declaration")
            .version
            .expect("antigravity version evidence");
        let reason = crate::chat::drivers::evaluate_version("agy 1.0.0", &evidence)
            .expect_err("1.0.0 is older than 1.4.5");
        let notice = persistent_fallback_notice(
            "antigravity",
            &format!("antigravity version check failed: {reason}"),
        );

        assert!(notice.contains("1.0.0"), "{notice}");
        assert!(notice.contains("1.4.5"), "{notice}");
        assert!(notice.chars().count() <= MAX_NOTICE_CHARS);
    }

    #[test]
    fn a_started_turn_is_never_replayed_as_a_second_command() {
        let mut manager = SessionManager::new();
        let transport = ScriptedTransport::new().failing_write("the provider refused the message");

        let error = managed_send(
            &mut manager,
            persistent_spec("thread-1"),
            Box::new(transport),
            "command-1",
            "only once",
        )
        .unwrap_err();

        assert!(!error.before_turn(), "a started turn must not fall back");
        assert!(error.reason().contains("refused"), "{error:?}");
        assert_eq!(
            manager.status("thread-1").map(|record| record.state),
            Some(SessionState::Running)
        );
    }
}
