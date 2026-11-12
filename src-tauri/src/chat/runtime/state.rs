use crate::chat::drivers::{declaration, DriverVersion};
use crate::chat::persistent::{
    unsupported_wire, AntigravitySession, GrokSession, OpenCodeServerSession,
    PersistentControls, ANTIGRAVITY_DRIVER, GROK_DRIVER, OPENCODE_DRIVER,
};
use crate::chat::session::{
    declared_session_mode, SessionManager, SessionMode, SessionTransport,
};
use crate::chat::threads::{chat_item, sanitize_chat_text, touch, upsert_item};
use crate::chat::utils::now_ms;
use crate::persist::{persist, threads};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex};
use uuid::Uuid;

use super::turn::append_event;

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
    /// Highest sequence a client has already been given. Older events can leave
    /// the buffer without hiding a row the transcript has not seen.
    pub delivered_through: u64,
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

/// Sessions are on unless the process sets the gate to exactly `0`.
pub fn sessions_enabled_from(raw: Option<&str>) -> bool {
    raw != Some("0")
}

pub fn persistent_sessions_enabled() -> bool {
    sessions_enabled_from(std::env::var(PERSISTENT_SESSIONS_ENV).ok().as_deref())
}

/// The route a send may use. A served lasting channel keeps its process.
/// `false` is the explicit off switch. A driver without a served wire stays
/// one command per turn.
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
        ANTIGRAVITY_DRIVER | OPENCODE_DRIVER | GROK_DRIVER => SendRoute::Persistent,
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

pub fn session_manager() -> &'static Mutex<SessionManager> {
    static CELL: std::sync::OnceLock<Mutex<SessionManager>> = std::sync::OnceLock::new();
    CELL.get_or_init(|| Mutex::new(SessionManager::new()))
}

pub fn sync_thread_provider_session_id(thread_id: &str, handle: Option<&str>) {
    let Some(handle) = handle.filter(|h| !h.trim().is_empty()) else {
        return;
    };
    let mut updated = false;
    {
        let mut items = threads().lock().unwrap();
        if let Some(thread) = items.iter_mut().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id)) {
            if thread.get("providerSessionId").and_then(|v| v.as_str()) != Some(handle) {
                thread["providerSessionId"] = json!(handle);
                touch(thread);
                updated = true;
            }
        }
    }
    if updated {
        persist();
    }
}

/// The lasting wire a send may open. The kind is evidence about this build's
/// adapter, not a capability derived from the driver id.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportKind {
    Antigravity,
    OpenCodeServer,
    GrokAgent,
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
        GROK_DRIVER => TransportKind::GrokAgent,
        other => {
            return Err(format!(
                "Unsupported: {other} declares a lasting wire but this build has no adapter for it"
            ))
        }
    };
    let transport: Box<dyn SessionTransport> = match kind {
        TransportKind::Antigravity => Box::new(AntigravitySession::new(controls)),
        TransportKind::OpenCodeServer => Box::new(OpenCodeServerSession::with_controls(controls)),
        TransportKind::GrokAgent => Box::new(GrokSession::new(controls)),
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
pub fn emit_notice_item(thread_id: &str, run_id: &str, message: &str) {
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

pub fn emit_note_item(thread_id: &str, run_id: &str, message: &str) {
    let item = chat_item(
        &format!("n{}", Uuid::new_v4().simple()),
        "note",
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

/// Clears stored `providerSessionId` handles on threads matching `provider`
/// (normalizing `"agy"` <-> `"antigravity"`) so subsequent turns never resume across accounts.
pub(crate) fn clear_provider_thread_handles(items: &mut [Value], provider: &str) -> usize {
    let norm = |s: &str| match s.trim().to_ascii_lowercase().as_str() {
        "agy" | "antigravity" => "antigravity".to_string(),
        other => other.to_string(),
    };
    let target = norm(provider);
    let mut cleared = 0usize;
    for thread in items.iter_mut() {
        let Some(tp) = thread.get("provider").and_then(|v| v.as_str()) else {
            continue;
        };
        if norm(tp) != target {
            continue;
        }
        if thread
            .get("providerSessionId")
            .is_some_and(|v| !v.is_null())
        {
            thread["providerSessionId"] = Value::Null;
            touch(thread);
            cleared += 1;
        }
    }
    cleared
}

/// Evicts warm chat sessions, persisted thread conversation handles, & model caches belonging to
/// `provider` after account rotation so no cached process, resume id, or model list outlives the credential swap.
pub(crate) fn evict_provider_runtime_state(provider: &str) -> Vec<String> {
    let evicted = if let Ok(mut manager) = session_manager().lock() {
        manager.evict_provider_sessions(provider)
    } else {
        Vec::new()
    };
    let cleared = {
        let mut items = threads().lock().unwrap();
        clear_provider_thread_handles(&mut items, provider)
    };
    if cleared > 0 {
        persist();
    }
    crate::chat::models::invalidate_provider_model_cache(provider);
    evicted
}
