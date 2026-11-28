use crate::chat::drivers::{declaration, DriverVersion};
use crate::chat::persistent::{
    unsupported_wire, use_shared_acp_mux, use_shared_grok_mux, AgyAcpSessionHandle,
    AntigravitySession, GrokPooledSessionHandle, GrokSession, OpenCodeServerSession,
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
    pub finished_at_ms: Option<i64>,
    pub routine_id: Option<String>,
    /// Highest sequence a client has already been given. Older events can leave
    /// the buffer without hiding a row the transcript has not seen.
    pub delivered_through: u64,
    /// Per-turn incremental baseline contents keyed by normalized path so tools that
    /// omit diffs (or edit the same file multiple times in one turn) compute accurate counts.
    pub file_baselines: HashMap<String, String>,
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
        .filter(|(_, run)| {
            if !run.finished {
                return false;
            }
            let elapsed_since_finish =
                now.saturating_sub(run.finished_at_ms.unwrap_or(run.started_at_ms));
            let has_undelivered = run.next_sequence > run.delivered_through;
            if has_undelivered {
                elapsed_since_finish > 600_000
            } else {
                elapsed_since_finish > 120_000
            }
        })
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

fn normalize_provider_key(provider: &str) -> String {
    match provider.trim().to_ascii_lowercase().as_str() {
        "agy" | "antigravity" => "antigravity".to_string(),
        "open-code" | "opencode" => "opencode".to_string(),
        "claude-code" | "claude" => "claude".to_string(),
        other => other.to_string(),
    }
}

pub fn sync_thread_provider_session_id_for_provider(
    thread_id: &str,
    expected_provider: Option<&str>,
    handle: Option<&str>,
) {
    let Some(handle) = handle.filter(|h| !h.trim().is_empty()) else {
        return;
    };
    let expected = expected_provider
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(normalize_provider_key);
    let mut updated = false;
    {
        let mut items = threads().lock().unwrap();
        if let Some(thread) = items
            .iter_mut()
            .find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id))
        {
            if let Some(ref exp) = expected {
                let current = thread
                    .get("provider")
                    .and_then(|v| v.as_str())
                    .map(normalize_provider_key)
                    .unwrap_or_default();
                if !current.is_empty() && current != *exp {
                    return;
                }
            }
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

pub fn sync_thread_provider_session_id(thread_id: &str, handle: Option<&str>) {
    let active_driver = session_manager()
        .lock()
        .ok()
        .and_then(|mgr| mgr.status(thread_id).map(|r| r.driver));
    sync_thread_provider_session_id_for_provider(thread_id, active_driver.as_deref(), handle);
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
        TransportKind::Antigravity => {
            if use_shared_acp_mux() {
                Box::new(AgyAcpSessionHandle::new(controls))
            } else {
                Box::new(AntigravitySession::new(controls))
            }
        }
        TransportKind::OpenCodeServer => Box::new(OpenCodeServerSession::with_controls(controls)),
        TransportKind::GrokAgent => {
            if use_shared_grok_mux() {
                Box::new(GrokPooledSessionHandle::new(controls))
            } else {
                Box::new(GrokSession::new(controls))
            }
        }
    };
    Ok(SelectedTransport {
        driver: declared.driver,
        kind,
        version,
        transport,
    })
}

/// Opt-in Native Rust Fast Lane selector strictly gated on `fast_lane_enabled`
/// and verified official API-key / OpenCode Go gateway eligibility (explicitly
/// rejecting consumer OAuth / cookie / CLI-only subscription drivers).
#[allow(clippy::too_many_arguments)]
pub fn try_select_fast_lane_transport(
    provider: &str,
    model: Option<&str>,
    api_key: Option<&str>,
    base_url: Option<&str>,
    auth_kind: &str,
    session_id: Option<&str>,
    controls: PersistentControls,
) -> Option<Box<dyn SessionTransport>> {
    let settings = crate::native_agent::load_runtime_resource_settings();
    if !settings.fast_lane_enabled {
        return None;
    }
    let model_id = model
        .or(controls.model.as_deref())
        .unwrap_or("")
        .trim();
    if crate::native_agent::types::resolve_fast_lane_endpoint(
        provider,
        model_id,
        api_key,
        base_url,
        auth_kind,
        session_id,
    )
    .is_err()
    {
        return None;
    }
    Some(Box::new(
        crate::native_agent::transport::NativeFastLaneTransport::new(controls),
    ))
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
    let target = normalize_provider_key(provider);
    let mut cleared = 0usize;
    for thread in items.iter_mut() {
        let Some(tp) = thread.get("provider").and_then(|v| v.as_str()) else {
            continue;
        };
        if normalize_provider_key(tp) != target {
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

/// Returns true when `thread_id` still owns an unfinished in-memory run or an
/// active persistent session state in this process. Acquires locks sequentially
/// so callers holding no lock can check liveness before inspecting `threads()`.
pub fn is_thread_runtime_active(thread_id: &str) -> bool {
    let has_live_run = live_turns().lock().is_ok_and(|live| {
        live.by_thread
            .get(thread_id)
            .and_then(|run_id| live.runs.get(run_id))
            .is_some_and(|run| !run.finished)
    });
    if has_live_run {
        return true;
    }
    session_manager()
        .lock()
        .ok()
        .and_then(|mgr| mgr.status(thread_id))
        .is_some_and(|record| {
            matches!(
                record.state,
                crate::chat::session::SessionState::Starting
                    | crate::chat::session::SessionState::Running
                    | crate::chat::session::SessionState::Resurrecting
                    | crate::chat::session::SessionState::Waiting
            )
        })
}

const IN_FLIGHT_DISPATCH_TTL_MS: i64 = 45_000;

/// Metadata for a live ACP/provider tool call invoking `kite-dispatch` (MCP or CLI),
/// used to correlate loopback dispatch requests back to the originating thread when
/// a shared multiplexed daemon scrubs per-thread `KITE_ADDRESS`.
#[derive(Debug, Clone)]
pub struct InFlightDispatchCall {
    pub thread_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub role: Option<String>,
    pub prompt: Option<String>,
    pub tasks: Vec<String>,
    pub command: Option<String>,
    pub swarm_action: Option<String>,
    pub swarm_member: Option<String>,
    pub swarm_title: Option<String>,
    pub created_at_ms: i64,
    pub claimed: bool,
}

#[derive(Debug, Clone, Default)]
pub struct DispatchCorrelationQuery {
    pub expected_tools: Vec<String>,
    pub role: Option<String>,
    pub prompt: Option<String>,
    pub tasks: Vec<String>,
    pub command_hint: Option<String>,
    pub swarm_action: Option<String>,
    pub swarm_member: Option<String>,
    pub swarm_title: Option<String>,
    pub consume_claim: bool,
}

fn in_flight_dispatch_calls() -> &'static Mutex<Vec<InFlightDispatchCall>> {
    static CELL: std::sync::OnceLock<Mutex<Vec<InFlightDispatchCall>>> = std::sync::OnceLock::new();
    CELL.get_or_init(|| Mutex::new(Vec::new()))
}

fn normalize_match_text(raw: &str) -> String {
    raw.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn register_in_flight_dispatch_call(mut call: InFlightDispatchCall) {
    let now = now_ms();
    if call.created_at_ms <= 0 {
        call.created_at_ms = now;
    }
    let Ok(mut guard) = in_flight_dispatch_calls().lock() else {
        return;
    };
    guard.retain(|entry| now.saturating_sub(entry.created_at_ms) <= IN_FLIGHT_DISPATCH_TTL_MS);
    if let Some(existing) = guard
        .iter_mut()
        .find(|e| e.thread_id == call.thread_id && e.tool_call_id == call.tool_call_id)
    {
        let was_claimed = existing.claimed;
        if call.role.is_some() {
            existing.role = call.role;
        }
        if call.prompt.is_some() {
            existing.prompt = call.prompt;
        }
        if !call.tasks.is_empty() {
            existing.tasks = call.tasks;
        }
        if call.command.is_some() {
            existing.command = call.command;
        }
        if call.swarm_action.is_some() {
            existing.swarm_action = call.swarm_action;
        }
        if call.swarm_member.is_some() {
            existing.swarm_member = call.swarm_member;
        }
        if call.swarm_title.is_some() {
            existing.swarm_title = call.swarm_title;
        }
        if !call.tool_name.is_empty() {
            existing.tool_name = call.tool_name;
        }
        existing.claimed = was_claimed;
    } else {
        guard.push(call);
    }
}

pub fn finish_in_flight_dispatch_call(thread_id: &str, tool_call_id: &str) {
    let Ok(mut guard) = in_flight_dispatch_calls().lock() else {
        return;
    };
    guard.retain(|e| !(e.thread_id == thread_id && e.tool_call_id == tool_call_id));
}

#[cfg(test)]
pub fn clear_in_flight_dispatch_calls_for_test() {
    if let Ok(mut guard) = in_flight_dispatch_calls().lock() {
        guard.clear();
    }
}

/// Resolves the unique originating thread for an incoming multiplexed dispatch request
/// by scoring live ACP tool calls. Returns `None` if no call matches or if two distinct
/// threads tie with the same highest score (never guesses across siblings).
pub fn claim_matching_in_flight_dispatch_thread(
    query: &DispatchCorrelationQuery,
) -> Option<String> {
    let now = now_ms();
    let Ok(mut guard) = in_flight_dispatch_calls().lock() else {
        return None;
    };
    guard.retain(|entry| now.saturating_sub(entry.created_at_ms) <= IN_FLIGHT_DISPATCH_TTL_MS);
    if guard.is_empty() {
        return None;
    }

    let q_prompt = query
        .prompt
        .as_deref()
        .map(normalize_match_text)
        .filter(|s| !s.is_empty());
    let q_tasks: Vec<String> = query
        .tasks
        .iter()
        .map(|t| normalize_match_text(t))
        .filter(|s| !s.is_empty())
        .collect();
    let q_role = query
        .role
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("subagent"))
        .map(|s| s.to_ascii_lowercase());
    let q_cmd = query
        .command_hint
        .as_deref()
        .map(normalize_match_text)
        .filter(|s| !s.is_empty());
    let q_swarm_action = query
        .swarm_action
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_ascii_lowercase());
    let q_swarm_member = query
        .swarm_member
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_ascii_lowercase());
    let q_swarm_title = query
        .swarm_title
        .as_deref()
        .map(normalize_match_text)
        .filter(|s| !s.is_empty());

    let mut scored: Vec<(usize, u32, i64)> = Vec::new();
    for (idx, entry) in guard.iter().enumerate() {
        if query.consume_claim && entry.claimed {
            continue;
        }
        let tool_lower = entry.tool_name.trim().to_ascii_lowercase();
        let tool_matches = query.expected_tools.is_empty()
            || query
                .expected_tools
                .iter()
                .any(|t| t.eq_ignore_ascii_case(&tool_lower));
        let is_shell = matches!(
            tool_lower.as_str(),
            "run_command" | "bash" | "shell" | "commandexecution"
        );
        if !tool_matches && !is_shell {
            continue;
        }

        let mut score: u32 = 0;

        if let (Some(qp), Some(ep)) = (
            q_prompt.as_deref(),
            entry.prompt.as_deref().map(normalize_match_text),
        ) {
            if !ep.is_empty() && (ep == qp || ep.contains(qp) || qp.contains(&ep)) {
                score += 100;
            }
        }
        if !q_tasks.is_empty() && !entry.tasks.is_empty() {
            let e_tasks: Vec<String> = entry
                .tasks
                .iter()
                .map(|t| normalize_match_text(t))
                .filter(|s| !s.is_empty())
                .collect();
            let all_match = q_tasks
                .iter()
                .all(|qt| e_tasks.iter().any(|et| et == qt || et.contains(qt)));
            if all_match {
                score += 110;
            }
        } else if let Some(first_task) = q_tasks.first() {
            if let Some(ep) = entry.prompt.as_deref().map(normalize_match_text) {
                if !ep.is_empty() && (ep == *first_task || ep.contains(first_task)) {
                    score += 95;
                }
            }
        }

        if let (Some(qr), Some(er)) = (
            q_role.as_deref(),
            entry
                .role
                .as_deref()
                .map(|r| r.trim().to_ascii_lowercase()),
        ) {
            if er == qr {
                score += 60;
            }
        }

        if let (Some(qc), Some(ec)) = (
            q_cmd.as_deref(),
            entry.command.as_deref().map(normalize_match_text),
        ) {
            if !ec.is_empty() && (ec == qc || ec.contains(qc)) {
                score += 95;
            }
        }

        if let (Some(qa), Some(ea)) = (
            q_swarm_action.as_deref(),
            entry
                .swarm_action
                .as_deref()
                .map(|a| a.trim().to_ascii_lowercase()),
        ) {
            if ea == qa {
                score += 40;
            }
        }
        if let (Some(qm), Some(em)) = (
            q_swarm_member.as_deref(),
            entry
                .swarm_member
                .as_deref()
                .map(|m| m.trim().to_ascii_lowercase()),
        ) {
            if em == qm {
                score += 45;
            }
        }
        if let (Some(qt), Some(et)) = (
            q_swarm_title.as_deref(),
            entry.swarm_title.as_deref().map(normalize_match_text),
        ) {
            if !et.is_empty() && et == qt {
                score += 45;
            }
        }

        if score == 0 && tool_matches {
            score = 25;
        }
        if score > 0 {
            scored.push((idx, score, entry.created_at_ms));
        }
    }

    if scored.is_empty() {
        return None;
    }
    scored.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| b.2.cmp(&a.2)));
    let best_score = scored[0].1;
    let best_idx = scored[0].0;
    let best_thread = guard[best_idx].thread_id.clone();

    let distinct_tied_threads: std::collections::HashSet<&str> = scored
        .iter()
        .filter(|(_, s, _)| *s == best_score)
        .map(|(i, _, _)| guard[*i].thread_id.as_str())
        .collect();
    if distinct_tied_threads.len() > 1 {
        return None;
    }

    if query.consume_claim {
        guard[best_idx].claimed = true;
    }
    Some(best_thread)
}

/// Returns the thread ID when **exactly one** unfinished live turn is currently active
/// in this process; returns `None` when zero or multiple turns are active concurrently.
pub fn single_active_live_thread_id() -> Option<String> {
    let Ok(live) = live_turns().lock() else {
        return None;
    };
    let mut active_threads: Vec<String> = live
        .by_thread
        .iter()
        .filter_map(|(tid, rid)| {
            live.runs
                .get(rid)
                .filter(|run| !run.finished)
                .map(|_| tid.clone())
        })
        .collect();
    active_threads.sort();
    active_threads.dedup();
    if active_threads.len() == 1 {
        active_threads.into_iter().next()
    } else {
        None
    }
}
