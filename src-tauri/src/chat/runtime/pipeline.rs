use crate::chat::approval::{parse_decision, ApprovalDecision};
use crate::chat::normalize::{
    automatic_approval_decision, effective_permission_mode, should_auto_approve,
    DeltaCoalescer, ProviderTurnEvent, ToolCallSnapshot, ToolCallTracker,
};
use crate::chat::threads::{chat_item, touch, upsert_item};
use crate::chat::utils::{chat_log, now_ms};
use crate::persist::{notifications, persist, threads};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{mpsc, Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};
use uuid::Uuid;

use super::settle::finish_run;
use super::state::{emit_notice_item, live_cv, live_turns, session_manager};
use super::stream_json::{
    emit_deltas, read_pipe, read_stderr_ring, record_turn_failure, take_run_stderr,
};
use super::turn::{push_event, write_session_frame};

pub struct HostApprovalWaiter {
    pub tx: mpsc::SyncSender<ApprovalDecision>,
    pub thread_id: String,
    pub agent_id: Option<String>,
    pub tool_family: String,
}

static HOST_APPROVAL_WAITERS: OnceLock<Mutex<HashMap<String, HostApprovalWaiter>>> =
    OnceLock::new();

fn host_approval_waiters() -> &'static Mutex<HashMap<String, HostApprovalWaiter>> {
    HOST_APPROVAL_WAITERS.get_or_init(|| Mutex::new(HashMap::new()))
}

type AcpWireMetadata = (bool, Vec<crate::acp::AcpApprovalOption>);

static PENDING_ACP_APPROVAL_WIRE: OnceLock<Mutex<HashMap<(String, String), AcpWireMetadata>>> =
    OnceLock::new();

fn pending_acp_approval_wire() -> &'static Mutex<HashMap<(String, String), AcpWireMetadata>> {
    PENDING_ACP_APPROVAL_WIRE.get_or_init(|| Mutex::new(HashMap::new()))
}

static SESSION_AUTO_APPROVED_THREADS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn session_auto_approved_threads() -> &'static Mutex<HashSet<String>> {
    SESSION_AUTO_APPROVED_THREADS.get_or_init(|| Mutex::new(HashSet::new()))
}

pub(crate) fn clear_acp_approval_wire(thread_id: &str) {
    let tid = clean_thread_id(thread_id);
    if let Ok(mut wire) = pending_acp_approval_wire().lock() {
        wire.retain(|(stored_tid, _), _| stored_tid != tid && stored_tid != thread_id);
    }
}

pub(crate) fn clear_session_auto_approved(thread_id: &str) {
    let tid = clean_thread_id(thread_id);
    if let Ok(mut approved) = session_auto_approved_threads().lock() {
        approved.remove(tid);
        approved.remove(thread_id);
    }
}

fn is_session_auto_approve_decision(decision: &str) -> bool {
    matches!(
        decision.trim().to_ascii_lowercase().as_str(),
        "allowforsession"
            | "allow_for_session"
            | "accept_for_session"
            | "acceptforsession"
            | "allow_always"
            | "allowalways"
            | "always_allow"
            | "alwaysallow"
    )
}

fn clean_thread_id(raw: &str) -> &str {
    let trimmed = raw.trim();
    trimmed.strip_prefix("thread:").unwrap_or(trimmed).trim()
}

fn settle_host_approval_thread_state(
    thread_id: &str,
    request_id: &str,
    decision_str: &str,
    restore_running: bool,
    resolution: &str,
) {
    {
        let mut live = live_turns().lock().unwrap();
        let run_id = live.by_thread.get(thread_id).cloned();
        if let Some(ref rid) = run_id {
            if let Some(run) = live.runs.get_mut(rid) {
                push_event(
                    run,
                    json!({
                        "kind": "approvalResolved",
                        "requestId": request_id,
                        "decision": decision_str
                    }),
                );
                if restore_running && !run.finished && !run.closing {
                    push_event(run, json!({ "kind": "status", "status": "running" }));
                }
            }
        }
    }
    live_cv().notify_all();

    let has_active_run = live_turns()
        .lock()
        .ok()
        .is_some_and(|live| {
            live.by_thread
                .get(thread_id)
                .and_then(|rid| live.runs.get(rid))
                .is_some_and(|run| !run.finished && !run.closing)
        });

    {
        let mut items = threads().lock().unwrap();
        if let Some(thread) = items
            .iter_mut()
            .find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id))
        {
            let matches_pending = thread
                .pointer("/pendingApproval/id")
                .and_then(Value::as_str)
                .is_none_or(|id| id == request_id);
            if matches_pending {
                thread["pendingApproval"] = Value::Null;
                if restore_running {
                    let target_status = if has_active_run { "running" } else { "idle" };
                    if thread.get("status").and_then(Value::as_str) == Some("waiting") {
                        thread["status"] = json!(target_status);
                    }
                }
                touch(thread);
            }
        }
    }
    {
        let mut notifs = notifications().lock().unwrap();
        if let Some(item) = notifs
            .iter_mut()
            .find(|n| n.get("id").and_then(|v| v.as_str()) == Some(request_id))
        {
            item["isWaitingForInput"] = json!(false);
            item["resolution"] = json!(resolution);
            item["isRead"] = json!(true);
        }
    }
    crate::chat::subagents::sync_child_thread_to_parent(thread_id);
    persist();
    crate::notifications::emit_notifications_updated();
}

#[allow(clippy::too_many_arguments)]
pub fn request_host_tool_approval(
    thread_id: &str,
    agent_id: Option<&str>,
    tool_name: &str,
    tool_family: &str,
    title: &str,
    detail: &str,
    risk: &str,
    impact: &str,
    timeout: Duration,
) -> Result<ApprovalDecision, String> {
    let tid = clean_thread_id(thread_id);
    if tid.is_empty() {
        return Err("thread_id is required for host interactive approval.".to_string());
    }
    let clean_aid = agent_id
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let request_id = format!("host-req-{}", Uuid::new_v4());
    let (tx, rx) = mpsc::sync_channel::<ApprovalDecision>(1);

    {
        let mut waiters = host_approval_waiters().lock().unwrap();
        waiters.insert(
            request_id.clone(),
            HostApprovalWaiter {
                tx,
                thread_id: tid.to_string(),
                agent_id: clean_aid.clone(),
                tool_family: tool_family.trim().to_ascii_lowercase(),
            },
        );
    }

    let approval_val = json!({
        "id": request_id,
        "toolName": tool_name,
        "toolFamily": tool_family,
        "title": title,
        "detail": detail,
        "risk": risk,
        "impact": impact,
        "text": detail,
        "tool": tool_name,
        "status": "pending",
        "supportsAlwaysAllow": true,
    });

    let active_run_id = {
        let mut live = live_turns().lock().unwrap();
        let rid = live.by_thread.get(tid).cloned();
        if let Some(ref r_id) = rid {
            if let Some(run) = live.runs.get_mut(r_id) {
                push_event(
                    run,
                    json!({ "kind": "approvalOpened", "approval": approval_val.clone() }),
                );
                push_event(run, json!({ "kind": "status", "status": "waiting" }));
            }
        }
        rid
    };
    live_cv().notify_all();

    let thread_profile_id = {
        let mut items = threads().lock().unwrap();
        if let Some(thread) = items
            .iter_mut()
            .find(|t| t.get("id").and_then(|v| v.as_str()) == Some(tid))
        {
            thread["pendingApproval"] = approval_val;
            thread["status"] = json!("waiting");
            touch(thread);
            thread
                .get("profileId")
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .or(clean_aid)
        } else {
            clean_aid
        }
    };

    let meta = crate::notifications::resolve_notification_context(
        Some(tid),
        thread_profile_id.as_deref(),
        None,
    );

    {
        let source = if thread_profile_id.is_some() {
            "agentChat"
        } else {
            "codeThread"
        };
        let module = if thread_profile_id.is_some() {
            "agent"
        } else {
            "chat"
        };
        let notice = json!({
            "id": request_id,
            "runId": active_run_id,
            "target": { "source": source, "id": tid },
            "profileId": thread_profile_id,
            "routineId": Value::Null,
            "actorName": meta.actor_name,
            "threadTitle": meta.thread_title,
            "workspaceId": meta.workspace_id,
            "module": module,
            "kind": { "kind": "needsInput", "requestKind": "toolApproval" },
            "resolution": Value::Null,
            "createdAtUnixMs": now_ms(),
            "isRead": false,
            "isWaitingForInput": true
        });
        let mut notifs = notifications().lock().unwrap();
        if let Some(pos) = notifs
            .iter()
            .position(|n| n.get("id").and_then(|v| v.as_str()) == Some(&request_id))
        {
            notifs[pos] = notice;
        } else {
            notifs.insert(0, notice);
            if notifs.len() > 100 {
                notifs.truncate(100);
            }
        }
    }
    crate::chat::subagents::sync_child_thread_to_parent(tid);
    persist();
    crate::notifications::emit_notifications_updated();

    match rx.recv_timeout(timeout) {
        Ok(decision) => Ok(decision),
        Err(mpsc::RecvTimeoutError::Timeout) => {
            let removed = {
                let mut waiters = host_approval_waiters().lock().unwrap();
                waiters.remove(&request_id)
            };
            if removed.is_some() {
                settle_host_approval_thread_state(tid, &request_id, "deny", true, "timeout");
            }
            Ok(ApprovalDecision::Deny)
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            let removed = {
                let mut waiters = host_approval_waiters().lock().unwrap();
                waiters.remove(&request_id)
            };
            if removed.is_some() {
                settle_host_approval_thread_state(tid, &request_id, "deny", true, "cancelled");
            }
            Ok(ApprovalDecision::Deny)
        }
    }
}

pub fn cancel_host_approvals_for_thread(thread_id: &str) {
    let tid = clean_thread_id(thread_id);
    if tid.is_empty() {
        return;
    }
    let drained: Vec<(String, HostApprovalWaiter)> = {
        let mut waiters = host_approval_waiters().lock().unwrap();
        let keys: Vec<String> = waiters
            .iter()
            .filter(|(_, w)| w.thread_id == tid)
            .map(|(k, _)| k.clone())
            .collect();
        keys.into_iter()
            .filter_map(|k| waiters.remove(&k).map(|w| (k, w)))
            .collect()
    };
    for (req_id, waiter) in drained {
        let _ = waiter.tx.try_send(ApprovalDecision::DenyAndStop);
        settle_host_approval_thread_state(tid, &req_id, "denyAndStop", false, "cancelled");
    }
}

pub fn write_user_input_to_run(thread_id: &str, request_id: &str, answers: &Value) {
    let line = format!(
        "{}\n",
        json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "result": { "answers": answers }
        })
    );
    write_approval_to_run(thread_id, request_id, "allowOnce");
    let _ = write_session_frame(thread_id, &line);
    set_thread_field(thread_id, "pendingUserInput", Value::Null);
}

pub fn write_approval_to_run(thread_id: &str, request_id: &str, decision: &str) {
    let tid = clean_thread_id(thread_id);
    let matched_host: Option<(String, HostApprovalWaiter)> = {
        let mut waiters = host_approval_waiters().lock().unwrap();
        let trimmed_req = request_id.trim();
        if !trimmed_req.is_empty() {
            if let Some(w) = waiters.remove(trimmed_req) {
                Some((trimmed_req.to_string(), w))
            } else {
                None
            }
        } else {
            let fallback_key = waiters
                .iter()
                .find(|(_, w)| w.thread_id == tid)
                .map(|(k, _)| k.clone());
            fallback_key.and_then(|k| waiters.remove(&k).map(|w| (k, w)))
        }
    };

    if let Some((host_req_id, waiter)) = matched_host {
        let parsed_decision = parse_decision(decision).unwrap_or(ApprovalDecision::Deny);
        if parsed_decision == ApprovalDecision::AlwaysAllow {
            if let Some(ref aid) = waiter.agent_id {
                let _ = crate::agents::set_agent_tool_policy_allow(aid, &waiter.tool_family);
            }
        }
        let restore_running = parsed_decision != ApprovalDecision::DenyAndStop;
        let _ = waiter.tx.try_send(parsed_decision);
        settle_host_approval_thread_state(
            tid,
            &host_req_id,
            parsed_decision.as_str(),
            restore_running,
            "attended",
        );
        if parsed_decision == ApprovalDecision::DenyAndStop {
            cancel_host_approvals_for_thread(tid);
        }
        return;
    }

    {
        let mut live = live_turns().lock().unwrap();
        let run_id = live.by_thread.get(thread_id).cloned();
        if let Some(ref rid) = run_id {
            if let Some(run) = live.runs.get_mut(rid) {
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
    }
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
    {
        let mut notifs = notifications().lock().unwrap();
        if let Some(item) = notifs.iter_mut().find(|n| n.get("id").and_then(|v| v.as_str()) == Some(request_id)) {
            item["isWaitingForInput"] = json!(false);
            item["resolution"] = json!("attended");
            item["isRead"] = json!(true);
        }
    }
    persist();
    crate::notifications::emit_notifications_updated();

    if is_session_auto_approve_decision(decision) {
        if let Ok(mut approved) = session_auto_approved_threads().lock() {
            approved.insert(tid.to_string());
        }
    }

    let wire_meta = pending_acp_approval_wire().lock().ok().and_then(|mut wire| {
        wire.remove(&(tid.to_string(), request_id.to_string()))
            .or_else(|| wire.remove(&(thread_id.to_string(), request_id.to_string())))
    });
    let (wire_id_is_string, wire_options) = match wire_meta {
        Some((is_str, opts)) => (Some(is_str), opts),
        None => (None, Vec::new()),
    };

    let line = crate::acp::format_acp_approval_response_with_wire(
        request_id,
        decision,
        wire_id_is_string,
        &wire_options,
    );
    let _ = write_session_frame(thread_id, &line);
}

pub fn stream_child(thread_id: String, run_id: String, assistant_id: String, mut child: crate::hidden_exec::HiddenChild) {
    let pid = child.id();
    chat_log(&format!("stream_child: started for run_id={}, pid={}", run_id, pid));
    // Drop the stdin write pipe immediately so child processes (like `opencode run` and `codex exec`,
    // which check if stdin is a pipe and wait for EOF) receive EOF and do not hang.
    drop(child.stdin.take());
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let shared = Arc::new(Mutex::new(child));
    {
        let mut live = live_turns().lock().unwrap();
        if let Some(run) = live.runs.get_mut(&run_id) {
            run.child = Some(Arc::clone(&shared));
            run.stdin = None;
        }
    }
    let out_run = run_id.clone();
    let out_id = assistant_id.clone();
    let err_run = run_id.clone();
    let out_thread = thread_id.clone();
    let stdout_thread = std::thread::spawn(move || {
        if let Some(stdout) = stdout {
            read_pipe(stdout, &out_thread, &out_run, &out_id);
        }
    });
    let stderr_thread = std::thread::spawn(move || {
        if let Some(stderr) = stderr {
            read_stderr_ring(stderr, &err_run);
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
    let exit_code = status.map(|code| code as i32);
    let result_failure = super::stream_json::take_result_failure(&run_id);
    let ok = exit_code.unwrap_or(1) == 0 && result_failure.is_none();
    chat_log(&format!("stream_child: process exited for run_id={}, pid={}, ok={}", run_id, pid, ok));
    let stderr_text = take_run_stderr(&run_id);
    let failure_detail = match (stderr_text.trim().is_empty(), result_failure.as_deref()) {
        (false, Some(res)) if !stderr_text.contains(res) => format!("{stderr_text}\n{res}"),
        (false, _) => stderr_text,
        (true, Some(res)) => res.to_string(),
        (true, None) => String::new(),
    };
    let effective_exit = if ok {
        Some(0)
    } else {
        exit_code.filter(|&c| c != 0).or(Some(1))
    };
    let provider = threads()
        .lock()
        .unwrap()
        .iter()
        .find(|thread| thread.get("id").and_then(|value| value.as_str()) == Some(thread_id.as_str()))
        .and_then(|thread| thread.get("provider").and_then(|value| value.as_str()))
        .unwrap_or("")
        .to_string();
    let projected = crate::chat::normalize::project_process_failure(
        effective_exit,
        &failure_detail,
        &provider,
        &[],
    );
    cancel_host_approvals_for_thread(&thread_id);
    if let Some(failure) = projected.failure {
        record_turn_failure(&thread_id, &failure);
        finish_run(&run_id, false, false, "");
    } else {
        let message = if ok {
            String::new()
        } else {
            "The provider command exited with an error.".into()
        };
        finish_run(&run_id, ok, false, &message);
    }
}

#[derive(Default)]
struct DeltaScheduleState {
    pending: HashMap<String, (String, String, Instant)>,
    stopped: bool,
}

struct DeltaFlushScheduler;

impl DeltaFlushScheduler {
    fn run_loop<F>(shared: Arc<(Mutex<DeltaScheduleState>, Condvar)>, flush_fn: F)
    where
        F: Fn(&str, &str, &str),
    {
        let (lock, cvar) = &*shared;
        let mut state = lock.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            let next_deadline = state.pending.values().map(|(_, _, deadline)| *deadline).min();
            let Some(earliest) = next_deadline else {
                if state.stopped {
                    break;
                }
                state = cvar.wait(state).unwrap_or_else(|e| e.into_inner());
                continue;
            };
            let now = Instant::now();
            if earliest <= now {
                let due_keys: Vec<String> = state
                    .pending
                    .iter()
                    .filter(|(_, (_, _, deadline))| *deadline <= now)
                    .map(|(run_id, _)| run_id.clone())
                    .collect();
                let mut due = Vec::with_capacity(due_keys.len());
                for run_id in due_keys {
                    if let Some((thread_id, assistant_id, _)) = state.pending.remove(&run_id) {
                        due.push((thread_id, run_id, assistant_id));
                    }
                }
                drop(state);
                for (thread_id, run_id, assistant_id) in due {
                    flush_fn(&thread_id, &run_id, &assistant_id);
                }
                state = lock.lock().unwrap_or_else(|e| e.into_inner());
                if state.stopped && state.pending.is_empty() {
                    break;
                }
            } else {
                if state.stopped {
                    break;
                }
                let wait_for = earliest.saturating_duration_since(now);
                let (next_state, _) = cvar
                    .wait_timeout(state, wait_for)
                    .unwrap_or_else(|e| e.into_inner());
                state = next_state;
            }
        }
    }

    fn schedule_in(
        shared: &Arc<(Mutex<DeltaScheduleState>, Condvar)>,
        thread_id: &str,
        run_id: &str,
        assistant_id: &str,
        deadline: Instant,
    ) {
        let (lock, cvar) = &**shared;
        let mut state = lock.lock().unwrap_or_else(|e| e.into_inner());
        let should_notify = match state.pending.get_mut(run_id) {
            Some((existing_thread, existing_assistant, existing_deadline)) => {
                *existing_thread = thread_id.to_string();
                *existing_assistant = assistant_id.to_string();
                if deadline < *existing_deadline {
                    *existing_deadline = deadline;
                    true
                } else {
                    false
                }
            }
            None => {
                let prev_min = state.pending.values().map(|(_, _, d)| *d).min();
                state.pending.insert(
                    run_id.to_string(),
                    (thread_id.to_string(), assistant_id.to_string(), deadline),
                );
                prev_min.is_none_or(|min| deadline < min)
            }
        };
        if should_notify {
            cvar.notify_one();
        }
    }

    fn clear_in(shared: &Arc<(Mutex<DeltaScheduleState>, Condvar)>, run_id: &str) {
        let (lock, _) = &**shared;
        let mut state = lock.lock().unwrap_or_else(|e| e.into_inner());
        state.pending.remove(run_id);
    }
}

static DELTA_FLUSH_SCHEDULER: OnceLock<Arc<(Mutex<DeltaScheduleState>, Condvar)>> = OnceLock::new();

fn delta_flush_scheduler() -> &'static Arc<(Mutex<DeltaScheduleState>, Condvar)> {
    DELTA_FLUSH_SCHEDULER.get_or_init(|| {
        let shared = Arc::new((Mutex::new(DeltaScheduleState::default()), Condvar::new()));
        let worker_shared = Arc::clone(&shared);
        if let Err(err) = std::thread::Builder::new()
            .name("kite-delta-flush".to_string())
            .spawn(move || DeltaFlushScheduler::run_loop(worker_shared, flush_pipeline_deltas))
        {
            chat_log(&format!("kite-delta-flush spawn failed: {err}"));
        }
        shared
    })
}

pub fn schedule_delta_flush(thread_id: &str, run_id: &str, assistant_id: &str, delay: Duration) {
    let deadline = Instant::now() + delay;
    DeltaFlushScheduler::schedule_in(
        delta_flush_scheduler(),
        thread_id,
        run_id,
        assistant_id,
        deadline,
    );
}

pub fn clear_pending_delta_flush(run_id: &str) {
    if let Some(shared) = DELTA_FLUSH_SCHEDULER.get() {
        DeltaFlushScheduler::clear_in(shared, run_id);
    }
}

pub fn pipeline_runs() -> &'static Mutex<HashMap<String, (ToolCallTracker, DeltaCoalescer)>> {
    static RUNS: std::sync::OnceLock<Mutex<HashMap<String, (ToolCallTracker, DeltaCoalescer)>>> =
        std::sync::OnceLock::new();
    RUNS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn apply_known_turn_pipeline(thread_id: &str, run_id: &str, assistant_id: &str, frame: &Value) -> bool {
    let now = Instant::now();
    let (events, message, reasoning, holding) = {
        let mut runs = pipeline_runs().lock().unwrap();
        let (tools, deltas) = runs
            .entry(run_id.to_string())
            .or_insert_with(|| (ToolCallTracker::default(), DeltaCoalescer::default()));
        let events = tools.ingest(frame);
        if events.is_empty()
            || (events.len() == 1
                && matches!(
                    events.first(),
                    Some(ProviderTurnEvent::Notice { code, .. }) if code == "unknownFrame"
                ))
        {
            return false;
        }
        let mut message = None;
        let mut reasoning = None;
        for event in &events {
            match event {
                ProviderTurnEvent::MessageDelta { text } => {
                    if let Some(flushed) = deltas.push_message(text, false, now) {
                        message = Some(flushed);
                    }
                }
                ProviderTurnEvent::ReasoningDelta { text } => {
                    if let Some(flushed) = deltas.push_reasoning(text, false, now) {
                        reasoning = Some(flushed);
                    }
                }
                _ => {}
            }
        }
        let (due_message, due_reasoning) = deltas.poll_split(now);
        if message.is_none() {
            message = due_message;
        }
        if reasoning.is_none() {
            reasoning = due_reasoning;
        }
        let holding = deltas.pending();
        (events, message, reasoning, holding)
    };
    if let Some(text) = message {
        emit_deltas(thread_id, run_id, assistant_id, &text);
    }
    if let Some(text) = reasoning {
        append_reasoning_delta(thread_id, run_id, &text);
    }
    for event in events {
        match event {
            ProviderTurnEvent::MessageDelta { .. } | ProviderTurnEvent::ReasoningDelta { .. } => {}
            ProviderTurnEvent::ToolCallUpdated { tool } => {
                if let Some(ref parent_id) = tool.parent_tool_use_id {
                    if crate::chat::subagents::ingest_nested_subagent_frame(
                        thread_id,
                        run_id,
                        parent_id,
                        frame,
                    ) {
                        continue;
                    }
                }
                upsert_tool_snapshot(thread_id, run_id, &tool);
            }
            ProviderTurnEvent::ApprovalRequested {
                request_id,
                rpc_id_is_string,
                tool_name,
                title,
                detail,
                command,
                path,
                risk,
                parameters,
                options,
            } => project_approval_with_meta(
                thread_id,
                run_id,
                &request_id,
                rpc_id_is_string,
                &tool_name,
                &title,
                detail.as_deref(),
                command.as_deref(),
                path.as_deref(),
                risk.as_deref(),
                &parameters,
                &options,
            ),
            ProviderTurnEvent::UserInputRequested { request } => {
                let value = serde_json::to_value(&request).unwrap_or(Value::Null);
                set_thread_field(thread_id, "pendingUserInput", value);
                set_thread_field(thread_id, "status", json!("waiting"));
            }
            ProviderTurnEvent::PlanUpdated { title, status, body } => {
                project_plan(thread_id, run_id, &title, &status, &body);
                if matches!(
                    frame.get("method").and_then(Value::as_str),
                    Some("x.ai/exit_plan_mode") | Some("_x.ai/exit_plan_mode")
                ) {
                    if let Some(id) = frame
                        .get("id")
                        .and_then(|value| value.as_i64().map(|number| number.to_string()).or_else(|| value.as_str().map(str::to_string)))
                    {
                        let _ = write_session_frame(
                            thread_id,
                            &crate::chat::persistent::plan_request_ack(&id),
                        );
                    }
                }
            }
            ProviderTurnEvent::UsageUpdated { usage } => {
                if let Ok(value) = serde_json::to_value(&usage) {
                    set_thread_field(thread_id, "usage", value);
                }
            }
            ProviderTurnEvent::TurnTerminal { failure } => {
                if let Some(failure) = failure {
                    record_turn_failure(thread_id, &failure);
                }
            }
            ProviderTurnEvent::SessionStarted { provider_session_id } => {
                if let Some(id) = provider_session_id {
                    if !id.is_empty() {
                        set_thread_field(thread_id, "providerSessionId", json!(id));
                    }
                }
            }
            ProviderTurnEvent::Notice { message, .. } => emit_notice_item(thread_id, run_id, &message),
        }
    }
    if holding {
        schedule_delta_flush(
            thread_id,
            run_id,
            assistant_id,
            crate::chat::normalize::DELTA_WINDOW,
        );
    }
    true
}

pub fn flush_pipeline_deltas(thread_id: &str, run_id: &str, assistant_id: &str) {
    let (message, reasoning) = {
        let mut runs = pipeline_runs().lock().unwrap();
        let Some((_, deltas)) = runs.get_mut(run_id) else {
            return;
        };
        deltas.flush_split()
    };
    if let Some(text) = message {
        emit_deltas(thread_id, run_id, assistant_id, &text);
    }
    if let Some(text) = reasoning {
        append_reasoning_delta(thread_id, run_id, &text);
    }
}

pub fn set_thread_field(thread_id: &str, field: &str, value: Value) {
    let mut items = threads().lock().unwrap();
    if let Some(thread) = items
        .iter_mut()
        .find(|thread| thread.get("id").and_then(|v| v.as_str()) == Some(thread_id))
    {
        thread[field] = value;
        touch(thread);
    }
    drop(items);
    persist();
}

pub fn append_reasoning_delta(thread_id: &str, run_id: &str, text: &str) {
    if text.is_empty() {
        return;
    }
    let thought_id = format!("r_{run_id}_live");
    let combined = {
        let items = threads().lock().unwrap();
        items
            .iter()
            .find(|thread| thread.get("id").and_then(|v| v.as_str()) == Some(thread_id))
            .and_then(|thread| thread.get("items"))
            .and_then(|v| v.as_array())
            .and_then(|list| list.iter().find(|it| it.get("id").and_then(|v| v.as_str()) == Some(thought_id.as_str())))
            .and_then(|it| it.get("text"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    } + text;
    let item = chat_item(&thought_id, "reasoning", &combined, true);
    {
        let mut live = live_turns().lock().unwrap();
        if let Some(run) = live.runs.get_mut(run_id) {
            push_event(run, json!({ "kind": "upsert", "item": item.clone() }));
        }
    }
    live_cv().notify_all();
    let mut items = threads().lock().unwrap();
    if let Some(thread) = items
        .iter_mut()
        .find(|thread| thread.get("id").and_then(|v| v.as_str()) == Some(thread_id))
    {
        upsert_item(thread, &item);
    }
}

fn register_or_finish_in_flight_dispatch(
    thread_id: &str,
    snap: &ToolCallSnapshot,
    item: &Value,
    streaming: bool,
) {
    let raw_name = item
        .get("toolName")
        .and_then(Value::as_str)
        .or(snap.tool_name.as_deref())
        .unwrap_or("");
    let (_, clean_name) = crate::acp::strip_mcp_prefix(raw_name, item);
    let lower = clean_name.trim().to_ascii_lowercase();
    let command = snap
        .command
        .as_deref()
        .or_else(|| item.get("command").and_then(Value::as_str))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let is_dispatch_shell = command
        .as_deref()
        .is_some_and(|c| c.to_ascii_lowercase().contains("kite dispatch"));
    let is_dispatch_tool = matches!(
        lower.as_str(),
        "kite_subagent_run"
            | "kite_subagent_send"
            | "kite_subagent_wait"
            | "kite_subagent_read"
            | "kite_swarm"
            | "kite_thread"
            | "kite_memory"
            | "kite_routine"
            | "kite_teammate"
            | "kite_tasks"
            | "kite_ctx"
            | "kite_diff"
    ) || is_dispatch_shell;
    if !is_dispatch_tool {
        return;
    }
    if !streaming {
        super::state::finish_in_flight_dispatch_call(thread_id, &snap.id);
        return;
    }
    let raw_input = snap.raw_input.as_ref();
    let role = snap
        .subagent_meta
        .as_ref()
        .map(|m| m.role.clone())
        .filter(|r| !r.trim().is_empty() && !r.eq_ignore_ascii_case("subagent"))
        .or_else(|| {
            raw_input
                .and_then(|v| v.get("role").or_else(|| v.get("Role")))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        });
    let prompt = snap
        .subagent_meta
        .as_ref()
        .and_then(|m| m.prompt.clone())
        .filter(|p| !p.trim().is_empty())
        .or_else(|| {
            raw_input
                .and_then(|v| {
                    v.get("task")
                        .or_else(|| v.get("prompt"))
                        .or_else(|| v.get("Prompt"))
                        .or_else(|| v.get("message"))
                })
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        });
    let tasks: Vec<String> = raw_input
        .and_then(|v| v.get("tasks"))
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let swarm_action = snap
        .swarm_meta
        .as_ref()
        .map(|m| m.action.clone())
        .or_else(|| {
            raw_input
                .and_then(|v| v.get("action"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        });
    let swarm_member = snap
        .swarm_meta
        .as_ref()
        .and_then(|m| m.member_name.clone())
        .or_else(|| {
            raw_input
                .and_then(|v| v.get("name"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        });
    let swarm_title = snap
        .swarm_meta
        .as_ref()
        .and_then(|m| m.swarm_title.clone())
        .or_else(|| {
            raw_input
                .and_then(|v| v.get("title"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        });
    super::state::register_in_flight_dispatch_call(super::state::InFlightDispatchCall {
        thread_id: thread_id.to_string(),
        tool_call_id: snap.id.clone(),
        tool_name: if lower.is_empty() && is_dispatch_shell {
            "run_command".to_string()
        } else {
            lower
        },
        role,
        prompt,
        tasks,
        command,
        swarm_action,
        swarm_member,
        swarm_title,
        created_at_ms: now_ms(),
        claimed: false,
    });
}

pub fn upsert_tool_snapshot(thread_id: &str, run_id: &str, snap: &ToolCallSnapshot) {
    let snap_is_wait_timeout = crate::acp::is_wait_timeout_receipt(Some(snap.output.as_str()));
    let mut resolved_status = snap.status.clone();
    if resolved_status != "killed"
        && !snap_is_wait_timeout
        && crate::acp::response_indicates_failure(
            &resolved_status,
            None,
            None,
            Some(snap.output.as_str()),
        )
    {
        resolved_status = "failed".to_string();
    }
    let mut streaming = matches!(
        resolved_status.as_str(),
        "inProgress" | "running" | "pending" | "in_progress"
    );
    let mut item = chat_item(&snap.id, "tool", &snap.output, streaming);
    let title = if snap.title.is_empty() {
        snap.kind.clone()
    } else {
        snap.title.clone()
    };
    item["title"] = json!(title);
    item["status"] = json!(resolved_status);
    item["toolKind"] = json!(snap.kind);
    if let Some(tool_name) = snap
        .tool_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        item["toolName"] = json!(tool_name);
    }
    if let Some(path) = &snap.path {
        item["filePath"] = json!(path);
    }
    if let Some(command) = &snap.command {
        item["command"] = json!(command);
    }
    if let Some(query) = &snap.query {
        item["query"] = json!(query);
    }
    if let Some(additions) = snap.additions {
        item["addedLines"] = json!(additions);
    }
    if let Some(deletions) = snap.deletions {
        item["removedLines"] = json!(deletions);
    }
    let runtime_active = super::state::is_thread_runtime_active(thread_id);
    let mut sub_meta = snap.subagent_meta.clone();
    let mut swarm_meta = snap.swarm_meta.clone();
    let mut thread_active = false;
    {
        let items = threads().lock().unwrap();
        if let Some(thread) = items
            .iter()
            .find(|thread| thread.get("id").and_then(|v| v.as_str()) == Some(thread_id))
        {
            thread_active = matches!(
                thread.get("status").and_then(Value::as_str),
                Some("running" | "waiting")
            );
            if let Some(existing) = thread
                .get("items")
                .and_then(|v| v.as_array())
                .and_then(|list| {
                    list.iter()
                        .find(|it| it.get("id").and_then(|v| v.as_str()) == Some(snap.id.as_str()))
                })
            {
            if snap.output.is_empty() {
                if let Some(text) = existing.get("text") {
                    item["text"] = text.clone();
                }
            }
            if let Some(ex_sub) = existing
                .get("subagentMeta")
                .and_then(|v| serde_json::from_value::<crate::acp::SubagentMeta>(v.clone()).ok())
            {
                sub_meta = Some(match sub_meta.take() {
                    Some(m) => crate::acp::merge_subagent_meta(Some(&ex_sub), m),
                    None => ex_sub,
                });
            }
            if let Some(ex_swarm) = existing
                .get("swarmMeta")
                .and_then(|v| serde_json::from_value::<crate::acp::SwarmMeta>(v.clone()).ok())
            {
                swarm_meta = Some(match swarm_meta.take() {
                    Some(m) => crate::acp::merge_swarm_meta(Some(&ex_swarm), m),
                    None => ex_swarm,
                });
            }
            for key in ["toolName", "toolKind", "title", "detail"] {
                let incoming_generic = item
                    .get(key)
                    .and_then(Value::as_str)
                    .is_none_or(|s| crate::chat::subagents::is_generic_tool_field(key, s));
                if incoming_generic {
                    if let Some(prev_val) = existing
                        .get(key)
                        .and_then(Value::as_str)
                        .filter(|s| !crate::chat::subagents::is_generic_tool_field(key, s))
                    {
                        item[key] = json!(prev_val);
                    }
                }
            }
            if let Some(prev_ts) = existing
                .get("createdAtUnixMs")
                .and_then(Value::as_i64)
                .filter(|&ts| ts > 0)
            {
                item["createdAtUnixMs"] = json!(prev_ts);
            }
            for key in [
                "serverName",
                "query",
                "filePath",
                "addedLines",
                "removedLines",
                "command",
            ] {
                if item.get(key).is_none() {
                    if let Some(value) = existing.get(key) {
                        item[key] = value.clone();
                    }
                }
            }
            }
        }
    }
    let parent_active = runtime_active || thread_active;
    let item_tool_name = item
        .get("toolName")
        .and_then(Value::as_str)
        .unwrap_or(&snap.title);
    let has_started_thread_receipt = item
        .get("text")
        .and_then(Value::as_str)
        .is_some_and(|t| t.contains("started thread:"));
    if let Some(ref mut meta) = sub_meta {
        if parent_active
            && (crate::chat::subagents::is_invoke_subagent_tool_name(item_tool_name)
                || has_started_thread_receipt)
            && resolved_status == "completed"
            && !crate::chat::subagents::child_transcript_ended_with_final_response(
                meta.transcript_uri.as_deref(),
            )
        {
            meta.status = "running".to_string();
            item["status"] = json!("running");
            streaming = false;
            item["streaming"] = json!(false);
        } else if snap.subagent_meta.is_none()
            && matches!(
                resolved_status.as_str(),
                "completed" | "failed" | "cancelled" | "killed"
            )
        {
            meta.status = if resolved_status == "cancelled" {
                "killed".to_string()
            } else {
                resolved_status.clone()
            };
        }
    }
    let item_text_is_wait_timeout = snap_is_wait_timeout
        || item
            .get("text")
            .and_then(Value::as_str)
            .is_some_and(|t| crate::acp::is_wait_timeout_receipt(Some(t)));
    if item_text_is_wait_timeout && sub_meta.is_some() {
        let timeout_cid = item
            .get("text")
            .and_then(Value::as_str)
            .and_then(crate::chat::subagents::extract_started_thread_id_from_text);
        if let Some(ref mut m) = sub_meta {
            if m.child_thread_id.is_none() {
                if let Some(cid) = timeout_cid {
                    m.child_thread_id = Some(cid.clone());
                    if m.subagent_id.is_empty() || m.subagent_id == snap.id {
                        m.subagent_id = cid;
                    }
                }
            }
            if m.status != "killed" && m.status != "completed" {
                m.status = "running".to_string();
            }
            if m.latest_activity
                .as_deref()
                .is_some_and(|la| crate::acp::is_wait_timeout_receipt(Some(la)))
            {
                m.latest_activity = None;
            }
        }
        if resolved_status == "failed" || resolved_status == "completed" {
            item["status"] = json!("running");
            streaming = false;
            item["streaming"] = json!(false);
        }
    } else if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
        if resolved_status != "killed"
            && crate::acp::response_indicates_failure(&resolved_status, None, None, Some(text))
        {
            streaming = false;
            item["status"] = json!("failed");
            item["streaming"] = json!(false);
            if let Some(ref mut m) = sub_meta {
                m.status = "failed".to_string();
            }
        }
    }
    if let Some(ref m) = sub_meta {
        item["toolKind"] = json!("subagent");
        if let Ok(v) = serde_json::to_value(m) {
            item["subagentMeta"] = v;
        }
    }
    if let Some(ref m) = swarm_meta {
        item["toolKind"] = json!("swarm");
        if let Ok(v) = serde_json::to_value(m) {
            item["swarmMeta"] = v;
        }
    }
    register_or_finish_in_flight_dispatch(thread_id, snap, &item, streaming);
    {
        let mut live = live_turns().lock().unwrap();
        if let Some(run) = live.runs.get_mut(run_id) {
            push_event(run, json!({ "kind": "upsert", "item": item.clone() }));
        }
    }
    live_cv().notify_all();
    {
        let mut items = threads().lock().unwrap();
        if let Some(thread) = items
            .iter_mut()
            .find(|thread| thread.get("id").and_then(|v| v.as_str()) == Some(thread_id))
        {
            upsert_item(thread, &item);
            touch(thread);
        }
    }
    // Schedule diff calculation only after thread["items"] holds the item so kite-diff-worker can patch it reliably.
    crate::chat::checkpoints::schedule_turn_tool_diff(thread_id, run_id, &item, streaming);
    if item.get("subagentMeta").is_some() {
        crate::chat::subagents::record_subagent_tool_call(thread_id, &item);
    }
    if item.get("swarmMeta").is_some() {
        crate::chat::subagents::record_swarm_tool_call(thread_id, &item);
    }
    crate::chat::subagents::sync_child_thread_to_parent(thread_id);
    if !streaming
        && (item.get("toolKind").and_then(Value::as_str) == Some("subagent")
            || item
                .get("toolName")
                .and_then(Value::as_str)
                .is_some_and(|n| {
                    let (_, clean) = crate::acp::strip_mcp_prefix(n, &Value::Null);
                    crate::chat::subagents::is_invoke_subagent_tool_name(&clean)
                        || clean.eq_ignore_ascii_case("manage_subagents")
                }))
    {
        crate::chat::subagents::reconcile_antigravity_subagents_for_thread(thread_id, Some(run_id));
    }
    if !streaming {
        crate::persist::persist_async();
    }
}

#[allow(clippy::too_many_arguments)]
pub fn project_approval_with_meta(
    thread_id: &str,
    run_id: &str,
    request_id: &str,
    rpc_id_is_string: bool,
    tool_name: &str,
    title: &str,
    detail: Option<&str>,
    command: Option<&str>,
    path: Option<&str>,
    risk: Option<&str>,
    parameters: &Value,
    options: &[crate::acp::AcpApprovalOption],
) {
    let tid = clean_thread_id(thread_id);
    if let Ok(mut wire) = pending_acp_approval_wire().lock() {
        wire.insert(
            (tid.to_string(), request_id.to_string()),
            (rpc_id_is_string, options.to_vec()),
        );
    }

    let (provider, mode) = {
        let items = threads().lock().unwrap();
        let thread = items
            .iter()
            .find(|thread| thread.get("id").and_then(|v| v.as_str()) == Some(thread_id));
        (
            thread
                .and_then(|thread| thread.get("provider"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            thread
                .and_then(|thread| thread.get("mode"))
                .and_then(|v| v.as_str())
                .unwrap_or("supervised")
                .to_string(),
        )
    };
    let effective = effective_permission_mode(&provider, &mode);
    let session_auto = session_auto_approved_threads()
        .lock()
        .is_ok_and(|approved| approved.contains(tid) || approved.contains(thread_id));
    if session_auto || should_auto_approve(effective.effective.as_str(), tool_name) {
        let decision = automatic_approval_decision().as_str();
        let _ = session_manager()
            .lock()
            .unwrap()
            .respond_approval(thread_id, request_id, automatic_approval_decision());
        write_approval_to_run(thread_id, request_id, decision);
        return;
    }

    let resolved_detail = detail
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or_else(|| command.map(str::trim).filter(|s| !s.is_empty()))
        .or_else(|| path.map(str::trim).filter(|s| !s.is_empty()))
        .unwrap_or(title);
    let approval_val = json!({
        "id": request_id,
        "toolName": tool_name,
        "title": title,
        "detail": resolved_detail,
        "risk": risk.unwrap_or("tool"),
        "command": command,
        "path": path,
        "parameters": parameters,
        "supportsAlwaysAllow": false,
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

    let thread_profile_id = {
        let mut items = threads().lock().unwrap();
        if let Some(thread) = items
            .iter_mut()
            .find(|thread| thread.get("id").and_then(|v| v.as_str()) == Some(thread_id))
        {
            thread["pendingApproval"] = approval_val;
            thread["status"] = json!("waiting");
            touch(thread);
            thread
                .get("profileId")
                .and_then(|v| v.as_str())
                .map(str::to_string)
        } else {
            None
        }
    };

    let meta = crate::notifications::resolve_notification_context(
        Some(tid),
        thread_profile_id.as_deref(),
        None,
    );
    {
        let source = if thread_profile_id.is_some() {
            "agentChat"
        } else {
            "codeThread"
        };
        let module = if thread_profile_id.is_some() {
            "agent"
        } else {
            "chat"
        };
        let notice = json!({
            "id": request_id,
            "runId": run_id,
            "target": { "source": source, "id": tid },
            "profileId": thread_profile_id,
            "routineId": Value::Null,
            "actorName": meta.actor_name,
            "threadTitle": meta.thread_title,
            "workspaceId": meta.workspace_id,
            "module": module,
            "kind": { "kind": "needsInput", "requestKind": "toolApproval" },
            "resolution": Value::Null,
            "createdAtUnixMs": now_ms(),
            "isRead": false,
            "isWaitingForInput": true
        });
        let mut notifs = notifications().lock().unwrap();
        if let Some(pos) = notifs
            .iter()
            .position(|n| n.get("id").and_then(|v| v.as_str()) == Some(request_id))
        {
            notifs[pos] = notice;
        } else {
            notifs.insert(0, notice);
            if notifs.len() > 100 {
                notifs.truncate(100);
            }
        }
    }
    persist();
    crate::notifications::emit_notifications_updated();
    crate::chat::subagents::sync_child_thread_to_parent(thread_id);
}

pub fn project_approval(thread_id: &str, run_id: &str, request_id: &str, tool_name: &str, title: &str) {
    project_approval_with_meta(
        thread_id,
        run_id,
        request_id,
        true,
        tool_name,
        title,
        None,
        None,
        None,
        None,
        &Value::Null,
        &[],
    );
}

pub fn project_plan(thread_id: &str, run_id: &str, title: &str, status: &str, body: &str) {
    let plan_item_id = format!("plan_{run_id}");
    let streaming = status == "running" || status == "pending";
    let mut plan_item = chat_item(&plan_item_id, "tool", body, streaming);
    plan_item["title"] = json!(format!("Plan · {title}"));
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
    if let Some(thread) = items
        .iter_mut()
        .find(|thread| thread.get("id").and_then(|v| v.as_str()) == Some(thread_id))
    {
        upsert_item(thread, &plan_item);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_approval_broker_handles_always_allow_timeout_and_cancellation() {
        let aid = format!("ag-pipe-{}", Uuid::new_v4());
        let tid = format!("th-pipe-{}", Uuid::new_v4());
        let rid = format!("run-pipe-{}", Uuid::new_v4());

        {
            let mut list = threads().lock().unwrap();
            list.push(json!({
                "id": tid,
                "status": "running",
                "profileId": aid,
                "items": [],
                "pendingApproval": Value::Null,
            }));
        }
        {
            let mut live = live_turns().lock().unwrap();
            live.by_thread.insert(tid.clone(), rid.clone());
            live.runs.insert(
                rid.clone(),
                super::super::state::TurnRun {
                    revision: "rev".into(),
                    events: Vec::new(),
                    next_sequence: 0,
                    assistant_id: "a1".into(),
                    assistant_text: String::new(),
                    child: None,
                    stdin: None,
                    closing: false,
                    finished: false,
                    started_at_ms: now_ms(),
                    finished_at_ms: None,
                    routine_id: None,
                    delivered_through: 0,
                    file_baselines: HashMap::new(),
                },
            );
        }

        // 1. Timeout returns Deny and clears pendingApproval
        let timed_out = request_host_tool_approval(
            &tid,
            Some(&aid),
            "kite_tasks",
            "tasks",
            "Allow kite_tasks?",
            "create task",
            "medium",
            "Write task",
            Duration::from_millis(25),
        )
        .unwrap();
        assert_eq!(timed_out, ApprovalDecision::Deny);
        {
            let list = threads().lock().unwrap();
            let t = list
                .iter()
                .find(|t| t.get("id").and_then(Value::as_str) == Some(tid.as_str()))
                .unwrap();
            assert!(t["pendingApproval"].is_null());
            assert_eq!(t["status"], "running");
        }

        // 2. AlwaysAllow updates SQLite policy to "allow" and does NOT send ACP frame
        let tid_clone = tid.clone();
        let responder = std::thread::spawn(move || {
            for _ in 0..80 {
                let req_id = {
                    let list = threads().lock().unwrap();
                    list.iter()
                        .find(|t| t.get("id").and_then(Value::as_str) == Some(tid_clone.as_str()))
                        .and_then(|t| t.pointer("/pendingApproval/id").and_then(Value::as_str))
                        .map(str::to_string)
                };
                if let Some(id) = req_id {
                    assert!(id.starts_with("host-req-"));
                    write_approval_to_run(&tid_clone, &id, "alwaysAllow");
                    return;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        });

        let decision = request_host_tool_approval(
            &tid,
            Some(&aid),
            "kite_diff",
            "diff",
            "Allow kite_diff?",
            "inspect diff",
            "low",
            "Read diff",
            Duration::from_secs(2),
        )
        .unwrap();
        responder.join().unwrap();
        assert_eq!(decision, ApprovalDecision::AlwaysAllow);
        let cfg = crate::agents::load_agent_autonomy_config(&aid);
        assert_eq!(
            cfg.tool_policies.get("diff").map(String::as_str),
            Some("allow")
        );

        // 3. Cancellation unblocks pending waiter with DenyAndStop
        let tid_cancel = tid.clone();
        let canceller = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(30));
            cancel_host_approvals_for_thread(&tid_cancel);
        });
        let cancelled = request_host_tool_approval(
            &tid,
            Some(&aid),
            "kite_tasks",
            "tasks",
            "Allow kite_tasks?",
            "update task",
            "medium",
            "Write task",
            Duration::from_secs(2),
        )
        .unwrap();
        canceller.join().unwrap();
        assert_eq!(cancelled, ApprovalDecision::DenyAndStop);

        {
            let mut live = live_turns().lock().unwrap();
            live.runs.remove(&rid);
            live.by_thread.remove(&tid);
        }
        threads()
            .lock()
            .unwrap()
            .retain(|t| t.get("id").and_then(Value::as_str) != Some(tid.as_str()));
    }

    #[test]
    fn delta_flush_scheduler_flushes_on_single_worker_thread_and_keeps_earliest_deadline() {
        use std::collections::HashSet;
        use std::thread::ThreadId;

        struct TestScheduler {
            shared: Arc<(Mutex<DeltaScheduleState>, Condvar)>,
            worker: Option<std::thread::JoinHandle<()>>,
        }
        impl Drop for TestScheduler {
            fn drop(&mut self) {
                let (lock, cvar) = &*self.shared;
                if let Ok(mut state) = lock.lock() {
                    state.stopped = true;
                    cvar.notify_all();
                }
                if let Some(handle) = self.worker.take() {
                    let _ = handle.join();
                }
            }
        }

        let shared = Arc::new((Mutex::new(DeltaScheduleState::default()), Condvar::new()));
        let flushed: Arc<Mutex<Vec<(String, String, String, ThreadId, Option<String>)>>> =
            Arc::new(Mutex::new(Vec::new()));
        let worker_shared = Arc::clone(&shared);
        let worker_flushed = Arc::clone(&flushed);
        let worker = std::thread::Builder::new()
            .name("kite-delta-flush-test".to_string())
            .spawn(move || {
                DeltaFlushScheduler::run_loop(worker_shared, move |tid, rid, aid| {
                    let current = std::thread::current();
                    worker_flushed.lock().unwrap().push((
                        tid.to_string(),
                        rid.to_string(),
                        aid.to_string(),
                        current.id(),
                        current.name().map(str::to_string),
                    ));
                });
            })
            .unwrap();
        let _guard = TestScheduler {
            shared: Arc::clone(&shared),
            worker: Some(worker),
        };

        let now = Instant::now();
        let d_early = now + Duration::from_millis(25);
        let d_later = now + Duration::from_millis(400);
        // Repeatedly scheduling the same run_id must keep the earliest deadline (d_early), not push out to d_later.
        DeltaFlushScheduler::schedule_in(&shared, "t-1", "r-1", "a-1", d_early);
        DeltaFlushScheduler::schedule_in(&shared, "t-1", "r-1", "a-1", d_later);
        // Schedule a second run and a third that gets cleared before due.
        DeltaFlushScheduler::schedule_in(&shared, "t-2", "r-2", "a-2", now + Duration::from_millis(35));
        DeltaFlushScheduler::schedule_in(&shared, "t-3", "r-3", "a-3", now + Duration::from_millis(20));
        DeltaFlushScheduler::clear_in(&shared, "r-3");

        let wait_deadline = Instant::now() + Duration::from_millis(250);
        loop {
            if flushed.lock().unwrap().len() >= 2 || Instant::now() >= wait_deadline {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }

        let calls = flushed.lock().unwrap();
        assert_eq!(calls.len(), 2, "r-1 and r-2 must flush without waiting 400ms; r-3 cleared");
        let thread_ids: HashSet<ThreadId> = calls.iter().map(|c| c.3).collect();
        assert_eq!(thread_ids.len(), 1, "all delta flushes must run on one thread");
        assert_eq!(calls[0].4.as_deref(), Some("kite-delta-flush-test"));
        let run_ids: HashSet<&str> = calls.iter().map(|c| c.1.as_str()).collect();
        assert!(run_ids.contains("r-1"));
        assert!(run_ids.contains("r-2"));
        assert!(!run_ids.contains("r-3"));
    }

    #[test]
    fn singleton_delta_flush_scheduler_flushes_held_delta_to_live_run() {
        let tid = format!("th-delta-sched-{}", Uuid::new_v4());
        let rid = format!("run-delta-sched-{}", Uuid::new_v4());
        let aid = "asst-delta-1";

        {
            let mut list = threads().lock().unwrap();
            list.push(json!({
                "id": tid,
                "status": "running",
                "items": [],
            }));
        }
        {
            let mut live = live_turns().lock().unwrap();
            live.by_thread.insert(tid.clone(), rid.clone());
            live.runs.insert(
                rid.clone(),
                super::super::state::TurnRun {
                    revision: "rev".into(),
                    events: Vec::new(),
                    next_sequence: 0,
                    assistant_id: aid.into(),
                    assistant_text: String::new(),
                    child: None,
                    stdin: None,
                    closing: false,
                    finished: false,
                    started_at_ms: now_ms(),
                    finished_at_ms: None,
                    routine_id: None,
                    delivered_through: 0,
                    file_baselines: HashMap::new(),
                },
            );
        }

        // First delta flushes immediately; second delta within DELTA_WINDOW is held and scheduled on singleton thread.
        let frame1 = json!({
            "params": {
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "text": "hello " }
                }
            }
        });
        let frame2 = json!({
            "params": {
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "text": "world" }
                }
            }
        });
        assert!(apply_known_turn_pipeline(&tid, &rid, aid, &frame1));
        assert!(apply_known_turn_pipeline(&tid, &rid, aid, &frame2));

        let wait_deadline = Instant::now() + Duration::from_secs(1);
        loop {
            let text = live_turns()
                .lock()
                .unwrap()
                .runs
                .get(&rid)
                .map(|r| r.assistant_text.clone())
                .unwrap_or_default();
            if text == "hello world" || Instant::now() >= wait_deadline {
                assert_eq!(text, "hello world");
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }

        clear_pending_delta_flush(&rid);
        pipeline_runs().lock().unwrap().remove(&rid);
        {
            let mut live = live_turns().lock().unwrap();
            live.runs.remove(&rid);
            live.by_thread.remove(&tid);
        }
        threads()
            .lock()
            .unwrap()
            .retain(|t| t.get("id").and_then(Value::as_str) != Some(tid.as_str()));
    }
}
