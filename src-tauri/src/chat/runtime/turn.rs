use crate::chat::drivers::declaration;
use crate::chat::recipe::{apply_recipe, snapshot_for_agent};
use crate::chat::session::{
    RecipeSnapshot, SendReceipt, SessionManager, SessionMode, SessionSpec, SessionState,
    SessionTransport,
};
use crate::chat::threads::{chat_item, load_thread, replace_thread, touch, upsert_item};
use crate::chat::utils::{chat_log, now_ms};
use crate::persist::threads;
use serde_json::{json, Value};
use std::io::Write;
use std::path::Path;
use std::time::{Duration, Instant};
use uuid::Uuid;

use super::pipeline::{flush_pipeline_deltas, set_thread_field};
use super::settle::finish_run;
use super::spawn::launch_provider;
use super::state::{
    bounded_notice, emit_note_item, emit_notice_item, live_cv, live_turns, prune_stale_runs,
    session_manager, sync_thread_provider_session_id, ManagedSendError, SendBinding, TurnRun,
};
use super::stream_json::{emit_deltas, handle_stream_json_line, record_turn_failure};

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
        Some(
            SessionState::Running
                | SessionState::Waiting
                | SessionState::Completed
                | SessionState::Idle
                | SessionState::Resurrecting
        )
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

/// Writes a client frame to the one-shot pipe when that pipe exists, and to
/// the lasting session otherwise. A persistent Grok process does not publish
/// its stdin on the live run.
pub fn write_session_frame(thread_id: &str, line: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return false;
    }
    let stdin_arc = {
        let live = live_turns().lock().unwrap();
        live.by_thread
            .get(thread_id)
            .and_then(|run_id| live.runs.get(run_id))
            .and_then(|run| run.stdin.clone())
    };
    if let Some(stdin_mutex) = stdin_arc {
        if let Ok(mut stdin) = stdin_mutex.lock() {
            let payload = format!("{trimmed}\n");
            if stdin.write_all(payload.as_bytes()).is_ok() && stdin.flush().is_ok() {
                return true;
            }
        }
    }
    session_manager()
        .lock()
        .ok()
        .and_then(|mut manager| manager.write_frame(thread_id, trimmed).ok())
        .is_some()
}

/// Reads a lasting session's normalized events into the live chat run. The
/// pump stops at a completed turn, a provider exit, a failure, or a run the
/// user already finished.
pub fn pump_persistent_session(thread_id: String, run_id: String, assistant_id: String) {
    std::thread::spawn(move || {
        let mut last_progress = Instant::now();
        let mut quiet_noted = false;
        loop {
            std::thread::sleep(Duration::from_millis(40));
            flush_pipeline_deltas(&thread_id, &run_id, &assistant_id);
            let (events, handle) = {
                let mut manager = session_manager().lock().unwrap();
                let events = manager.poll(&thread_id).unwrap_or_default();
                let handle = manager.status(&thread_id).and_then(|r| r.resume_handle.clone());
                (events, handle)
            };
            if events.is_empty() {
                if !quiet_noted && last_progress.elapsed() >= Duration::from_secs(20) {
                    emit_note_item(
                        &thread_id,
                        &run_id,
                        "The provider has not sent an update. Stop the turn if this stays quiet.",
                    );
                    quiet_noted = true;
                }
            } else {
                last_progress = Instant::now();
                quiet_noted = false;
            }
            if let Some(h) = handle.as_deref() {
                sync_thread_provider_session_id(&thread_id, Some(h));
            }
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
                    "activity" => {
                        if let Some(line) = event.payload.get("line").and_then(Value::as_str) {
                            handle_stream_json_line(&thread_id, &run_id, &assistant_id, line);
                        }
                    }
                    "unhandledRequest" => {
                        if let Some(id) = event.payload.get("id").and_then(Value::as_str) {
                            let reply = crate::chat::persistent::unhandled_request_reply(id);
                            let _ = write_session_frame(&thread_id, &reply);
                            emit_note_item(
                                &thread_id,
                                &run_id,
                                "The provider asked for something this build does not handle. The request was declined so the turn can continue.",
                            );
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
                let handle = {
                    let manager = session_manager().lock().unwrap();
                    manager.status(&thread_id).and_then(|r| r.resume_handle.clone())
                };
                if let Some(h) = handle.as_deref() {
                    sync_thread_provider_session_id(&thread_id, Some(h));
                }
                if !ok {
                    let provider = threads()
                        .lock()
                        .unwrap()
                        .iter()
                        .find(|t| t.get("id").and_then(|v| v.as_str()) == Some(&thread_id))
                        .and_then(|t| t.get("provider").and_then(|v| v.as_str()))
                        .unwrap_or("")
                        .to_string();
                    let projected = crate::chat::normalize::project_process_failure(
                        Some(1),
                        &error,
                        &provider,
                        &[],
                    );
                    if let Some(failure) = projected.failure {
                        record_turn_failure(&thread_id, &failure);
                        finish_run(&run_id, false, false, "");
                        return;
                    }
                }
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
                let handle = {
                    let manager = session_manager().lock().unwrap();
                    manager.status(&thread_id).and_then(|r| r.resume_handle.clone())
                };
                if let Some(h) = handle.as_deref() {
                    sync_thread_provider_session_id(&thread_id, Some(h));
                }
                return;
            }
        }
    });
}

/// Best-effort hidden ref before the provider starts. A miss does not fail the turn.
pub fn remember_turn_checkpoint(thread: &mut Value, thread_id: &str, run_id: &str) {
    let Some(ref_name) = crate::chat::checkpoints::capture_for_thread(thread, thread_id, run_id) else {
        return;
    };
    crate::chat::checkpoints::record_checkpoint_ref(thread, &ref_name);
    let found = threads()
        .lock()
        .unwrap()
        .iter()
        .any(|item| item.get("id").and_then(|v| v.as_str()) == Some(thread_id));
    if found {
        set_thread_field(thread_id, "checkpointRef", json!(ref_name.clone()));
        if let Some(stored) = threads()
            .lock()
            .unwrap()
            .iter()
            .find(|item| item.get("id").and_then(|v| v.as_str()) == Some(thread_id))
        {
            if let Some(revision) = stored.get("revision").cloned() {
                thread["revision"] = revision;
            }
            if let Some(updated) = stored.get("updatedAtUnixMs").cloned() {
                thread["updatedAtUnixMs"] = updated;
            }
        }
    } else {
        touch(thread);
        replace_thread(thread);
    }
    chat_log(&format!(
        "checkpoint: thread={thread_id} run={run_id} ref={ref_name}"
    ));
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
    crate::dispatch_wire::protocol::clear_thread_killed(thread_id);
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
    remember_turn_checkpoint(&mut thread, thread_id, &run_id);
    let revision = thread
        .get("revision")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
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
        delivered_through: 0,
        file_baselines: std::collections::HashMap::new(),
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

fn compact_delivered(run: &mut TurnRun) {
    if run.delivered_through == 0 || run.events.len() < 400 {
        return;
    }
    let delivered = run.delivered_through;
    run.events.retain(|event| {
        event
            .get("sequence")
            .and_then(|value| value.as_u64())
            .unwrap_or(0)
            > delivered
    });
}

pub fn append_event(run: &mut TurnRun, mut event: Value, force: bool) {
    if run.finished {
        return;
    }
    compact_delivered(run);
    // Undelivered events stay. Dropping them is what made a live turn look frozen.
    if !force && run.events.len() >= 2_000 {
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
        let (events, revision, finished) = match live.runs.get_mut(run_id) {
            Some(run) => {
                let events: Vec<Value> = run
                    .events
                    .iter()
                    .filter(|event| event.get("sequence").and_then(|v| v.as_u64()).unwrap_or(0) > after_sequence)
                    .take(32)
                    .cloned()
                    .collect();
                if let Some(next) = events
                    .last()
                    .and_then(|event| event.get("sequence"))
                    .and_then(|value| value.as_u64())
                {
                    if next > run.delivered_through {
                        run.delivered_through = next;
                    }
                }
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
                "resyncRequired": false,
                "finished": finished
            });
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        let (_guard, _) = live_cv().wait_timeout(live, remaining).unwrap();
    }
}

pub fn is_turn_running(thread_id: &str) -> bool {
    let Ok(live) = live_turns().lock() else {
        return false;
    };
    live.by_thread
        .get(thread_id)
        .and_then(|run_id| live.runs.get(run_id))
        .map(|run| !run.finished && !run.closing)
        .unwrap_or(false)
}

pub fn cancel_turn(thread_id: &str) {
    chat_log(&format!("cancel_turn: requested for thread={}", thread_id));
    let run_id = {
        let live = live_turns().lock().unwrap();
        live.by_thread.get(thread_id).cloned()
    };
    let Some(run_id) = run_id else {
        chat_log(&format!("cancel_turn: no live run for thread={}", thread_id));
        if let Ok(mut manager) = session_manager().lock() {
            let _ = manager.interrupt(thread_id);
        }
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
