use crate::chat::drivers::declaration;
use crate::chat::recipe::{apply_recipe, snapshot_for_agent};
use crate::chat::session::{
    RecipeSnapshot, SendReceipt, SessionManager, SessionMode, SessionSpec, SessionState,
    SessionTransport,
};
use crate::chat::threads::{
    apply_derived_title_if_needed, chat_item, is_internal_dispatch_prompt, load_thread,
    replace_thread, touch, upsert_item,
};
use crate::chat::utils::{chat_log, now_ms};
use crate::persist::{persist, threads};
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
    session_manager, sync_thread_provider_session_id_for_provider, ManagedSendError, SendBinding,
    TurnRun,
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

pub const QUIET_TURN_NOTE_TEXT: &str =
    "The provider has not sent an update. Stop the turn if this stays quiet.";

pub fn prune_quiet_turn_note(thread_id: &str, run_id: Option<&str>) {
    let mut removed_ids = Vec::new();
    {
        let Ok(mut all_threads) = threads().lock() else {
            return;
        };
        if let Some(thread) = all_threads
            .iter_mut()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(thread_id))
        {
            if let Some(arr) = thread.get_mut("items").and_then(Value::as_array_mut) {
                arr.retain(|it| {
                    let is_quiet = it.get("kind").and_then(Value::as_str) == Some("note")
                        && it.get("text").and_then(Value::as_str) == Some(QUIET_TURN_NOTE_TEXT);
                    if is_quiet {
                        if let Some(id) = it.get("id").and_then(Value::as_str) {
                            if !id.is_empty() {
                                removed_ids.push(id.to_string());
                            }
                        }
                    }
                    !is_quiet
                });
                if !removed_ids.is_empty() {
                    touch(thread);
                }
            }
        }
    }
    if removed_ids.is_empty() {
        return;
    }
    if let Some(rid) = run_id.filter(|s| !s.trim().is_empty()) {
        if let Ok(mut live) = live_turns().lock() {
            if let Some(run) = live.runs.get_mut(rid) {
                for id in &removed_ids {
                    append_event(run, json!({ "kind": "remove", "itemId": id }), true);
                }
            }
        }
        live_cv().notify_all();
    }
    crate::persist::persist_async();
}

/// Chooses the handle to sync onto `thread["providerSessionId"]` during `pump_persistent_session`.
/// Prefers a confirmed `SessionRecord.resume_handle`, falling back once to `transport_resume_handle`
/// when `last_synced_handle` is empty so early `init` ids survive fallback stops without
/// re-clobbering mid-turn account-eviction clears.
pub(crate) fn resolve_pump_sync_handle<'a>(
    record_handle: Option<&'a str>,
    transport_handle: Option<&'a str>,
    last_synced_handle: Option<&str>,
) -> Option<&'a str> {
    let next = record_handle
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or_else(|| {
            if last_synced_handle.is_none() {
                transport_handle.map(str::trim).filter(|s| !s.is_empty())
            } else {
                None
            }
        })?;
    (last_synced_handle != Some(next)).then_some(next)
}

/// Reads a lasting session's normalized events into the live chat run. The
/// pump stops at a completed turn, a provider exit, a failure, or a run the
/// user already finished.
pub fn pump_persistent_session(thread_id: String, run_id: String, assistant_id: String) {
    std::thread::spawn(move || {
        let mut last_progress = Instant::now();
        let mut last_stdout_event = Instant::now();
        let mut last_transcript_probe = Instant::now();
        let mut quiet_noted = false;
        let mut last_stdout_step_index: Option<i64> = None;
        let turn_started_at_ms = live_turns()
            .lock()
            .ok()
            .and_then(|live| live.runs.get(&run_id).map(|run| run.started_at_ms))
            .unwrap_or_else(now_ms);
        let (driver_name, thread_session_id) = threads()
            .lock()
            .ok()
            .and_then(|all| {
                all.iter()
                    .find(|t| t.get("id").and_then(Value::as_str) == Some(thread_id.as_str()))
                    .map(|t| {
                        (
                            t.get("provider")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string(),
                            t.get("providerSessionId")
                                .and_then(Value::as_str)
                                .map(str::trim)
                                .filter(|s| !s.is_empty())
                                .map(str::to_string),
                        )
                    })
            })
            .unwrap_or_default();
        let mut last_synced_handle: Option<String> = thread_session_id.clone();
        let session_handle = session_manager()
            .lock()
            .ok()
            .and_then(|mgr| mgr.transport_resume_handle(&thread_id));
        let mut observed_conversation_id: Option<String> = session_handle.or(thread_session_id);
        let mut fallback = super::antigravity_fallback::TranscriptCatchupState::default();
        if super::antigravity_fallback::is_antigravity_driver(&driver_name) {
            if let Some(ref cid) = observed_conversation_id {
                fallback.baseline_step_index =
                    super::antigravity_fallback::read_baseline_max_step_for_session(cid);
            }
            fallback.baseline_initialized = true;
        }
        let mut had_events = false;
        loop {
            std::thread::sleep(Duration::from_millis(if had_events { 16 } else { 40 }));
            flush_pipeline_deltas(&thread_id, &run_id, &assistant_id);
            let (events, handle, transport_handle) = {
                let mut manager = session_manager().lock().unwrap();
                let events = manager.poll(&thread_id).unwrap_or_default();
                let handle = manager.status(&thread_id).and_then(|r| r.resume_handle.clone());
                let transport_handle = manager.transport_resume_handle(&thread_id);
                (events, handle, transport_handle)
            };
            had_events = !events.is_empty();
            if let Some(active_cid) = transport_handle
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                if observed_conversation_id.as_deref() != Some(active_cid) {
                    observed_conversation_id = Some(active_cid.to_string());
                }
            }
            if events.is_empty() {
                let has_async_subagent = crate::chat::subagents::has_active_child_subagent(&thread_id);
                let has_in_flight_bg_cmd = super::antigravity_fallback::is_antigravity_driver(&driver_name)
                    && threads()
                        .lock()
                        .ok()
                        .and_then(|all| {
                            all.iter()
                                .find(|t| t.get("id").and_then(Value::as_str) == Some(thread_id.as_str()))
                                .and_then(|t| t.get("items").and_then(Value::as_array))
                                .map(|items| {
                                    items.iter().any(|it| {
                                        it.get("status").and_then(Value::as_str) == Some("running")
                                            && it
                                                .get("text")
                                                .and_then(Value::as_str)
                                                .and_then(super::antigravity_fallback::extract_background_task_id)
                                                .is_some()
                                    })
                                })
                        })
                        .unwrap_or(false);
                let stalled_long_enough =
                    last_stdout_event.elapsed() >= super::antigravity_fallback::STALL_PROBE_DELAY;
                if super::antigravity_fallback::is_antigravity_driver(&driver_name)
                    && (stalled_long_enough || has_in_flight_bg_cmd || has_async_subagent)
                    && last_transcript_probe.elapsed() >= super::antigravity_fallback::STALL_PROBE_INTERVAL
                {
                    last_transcript_probe = Instant::now();
                    if let Some(ref cid) = observed_conversation_id {
                        let poll_res = super::antigravity_fallback::poll_transcript_catchup_for_session(
                            &thread_id,
                            &run_id,
                            &assistant_id,
                            cid,
                            turn_started_at_ms,
                            last_stdout_step_index,
                            &mut fallback,
                            false,
                        );
                        if poll_res.projected_updates {
                            last_progress = Instant::now();
                            if quiet_noted {
                                prune_quiet_turn_note(&thread_id, Some(&run_id));
                                quiet_noted = false;
                            }
                        }
                        if stalled_long_enough {
                            if let Some((ok, err_msg)) = fallback.ready_to_settle(
                                &poll_res.verdict,
                                Instant::now(),
                                last_stdout_event.elapsed(),
                            ) {
                                super::antigravity_fallback::reconcile_subagents_with_session(
                                    &thread_id,
                                    &run_id,
                                    cid,
                                );
                                prune_quiet_turn_note(&thread_id, Some(&run_id));
                                if let Ok(mut manager) = session_manager().lock() {
                                    let _ = manager.stop(&thread_id);
                                }
                                settle_persistent_turn_outcome(&thread_id, &run_id, ok, &err_msg);
                                return;
                            }
                        }
                    }
                }
                if has_async_subagent || has_in_flight_bg_cmd {
                    last_progress = Instant::now();
                } else if !quiet_noted && last_progress.elapsed() >= Duration::from_secs(20) {
                    emit_note_item(&thread_id, &run_id, QUIET_TURN_NOTE_TEXT);
                    quiet_noted = true;
                }
            } else {
                last_progress = Instant::now();
                last_stdout_event = Instant::now();
                if quiet_noted {
                    prune_quiet_turn_note(&thread_id, Some(&run_id));
                    quiet_noted = false;
                }
            }
            if let Some(h) = resolve_pump_sync_handle(
                handle.as_deref(),
                transport_handle.as_deref(),
                last_synced_handle.as_deref(),
            ) {
                sync_thread_provider_session_id_for_provider(
                    &thread_id,
                    Some(&driver_name),
                    Some(h),
                );
                last_synced_handle = Some(h.to_string());
            }
            let mut outcome: Option<(bool, String)> = None;
            let mut exited_abruptly = false;
            let mut pending_notices: Vec<String> = Vec::new();
            for event in events {
                match event.kind.as_str() {
                    "text" => {
                        if let Some(text) = event.payload.get("text").and_then(Value::as_str) {
                            emit_deltas(&thread_id, &run_id, &assistant_id, text);
                        }
                    }
                    "notice" => {
                        if let Some(text) = event.payload.get("text").and_then(Value::as_str) {
                            pending_notices.push(text.to_string());
                        }
                    }
                    "activity" => {
                        if let Some(line) = event.payload.get("line").and_then(Value::as_str) {
                            if let Some(step_idx) =
                                super::antigravity_fallback::extract_step_index_from_stream_line(line)
                            {
                                last_stdout_step_index = Some(
                                    last_stdout_step_index.map_or(step_idx, |prev| prev.max(step_idx)),
                                );
                            }
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
                        if outcome.is_none() {
                            let code = event.payload.get("code").and_then(Value::as_i64);
                            let error = event
                                .payload
                                .get("error")
                                .and_then(Value::as_str)
                                .map(str::to_string);
                            let ok = error.is_none() && code.unwrap_or(0) == 0;
                            exited_abruptly = true;
                            outcome = Some((ok, error.unwrap_or_default()));
                        }
                    }
                    _ => {}
                }
            }
            if let Some(outcome) = outcome {
                let logs_dir = observed_conversation_id
                    .as_deref()
                    .and_then(super::antigravity_fallback::brain_logs_dir_for_session);
                let (ok, error) = resolve_antigravity_poll_outcome_in_dir(
                    &thread_id,
                    &run_id,
                    &assistant_id,
                    &driver_name,
                    logs_dir.as_deref(),
                    observed_conversation_id.as_deref(),
                    turn_started_at_ms,
                    last_stdout_step_index,
                    &mut fallback,
                    exited_abruptly,
                    pending_notices,
                    outcome,
                );
                settle_persistent_turn_outcome(&thread_id, &run_id, ok, &error);
                return;
            }
            for notice in pending_notices {
                emit_notice_item(&thread_id, &run_id, &notice);
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
                    sync_thread_provider_session_id_for_provider(
                        &thread_id,
                        Some(&driver_name),
                        Some(h),
                    );
                }
                return;
            }
        }
    });
}

/// Resolves an Antigravity persistent-session outcome batch, promoting spurious post-reply
/// stream-interruption errors to clean completion when the active transcript on disk already
/// settled cleanly in `Completed`, and dropping matching result-error notices.
#[allow(clippy::too_many_arguments)]
pub(crate) fn resolve_antigravity_poll_outcome_in_dir(
    thread_id: &str,
    run_id: &str,
    assistant_id: &str,
    driver_name: &str,
    logs_dir: Option<&Path>,
    session_id: Option<&str>,
    turn_started_at_ms: i64,
    last_stdout_step_index: Option<i64>,
    fallback: &mut super::antigravity_fallback::TranscriptCatchupState,
    exited_abruptly: bool,
    pending_notices: Vec<String>,
    outcome: (bool, String),
) -> (bool, String) {
    let (mut ok, mut error) = outcome;
    if super::antigravity_fallback::is_antigravity_driver(driver_name) {
        if let Some(dir) = logs_dir {
            let live_assistant_empty = live_turns()
                .lock()
                .ok()
                .and_then(|live| {
                    live.runs
                        .get(run_id)
                        .map(|run| run.assistant_text.trim().is_empty())
                })
                .unwrap_or(false);
            let spurious_interruption = !ok
                && super::antigravity_fallback::is_transient_stream_interruption(&error)
                && super::antigravity_fallback::verify_completed_turn_on_disk_in_dir(
                    dir,
                    fallback.baseline_step_index,
                    turn_started_at_ms,
                    last_stdout_step_index,
                )
                .is_some();
            if spurious_interruption {
                chat_log(&format!(
                    "pump_persistent_session: promoting spurious post-reply interruption to ok=true for thread={}",
                    thread_id
                ));
                ok = true;
                error.clear();
            }
            let has_open_bg_tool = threads()
                .lock()
                .ok()
                .and_then(|all| {
                    all.iter()
                        .find(|t| t.get("id").and_then(Value::as_str) == Some(thread_id))
                        .and_then(|t| t.get("items").and_then(Value::as_array))
                        .map(|items| {
                            items.iter().any(|it| {
                                it.get("text")
                                    .and_then(Value::as_str)
                                    .and_then(super::antigravity_fallback::extract_background_task_id)
                                    .is_some()
                            })
                        })
                })
                .unwrap_or(false);
            let needs_exit_catchup = fallback.catchup_activated
                || exited_abruptly
                || has_open_bg_tool
                || (ok && live_assistant_empty);
            if needs_exit_catchup {
                let _ = super::antigravity_fallback::poll_transcript_catchup_in_dir(
                    thread_id,
                    run_id,
                    assistant_id,
                    session_id,
                    dir,
                    turn_started_at_ms,
                    last_stdout_step_index,
                    fallback,
                    true,
                );
            }
        }
        if let Some(cid) = session_id {
            super::antigravity_fallback::reconcile_subagents_with_session(thread_id, run_id, cid);
        }
    }
    for notice in pending_notices {
        if ok
            && super::antigravity_fallback::is_antigravity_driver(driver_name)
            && super::antigravity_fallback::is_spurious_antigravity_result_notice(&notice)
        {
            continue;
        }
        emit_notice_item(thread_id, run_id, &notice);
    }
    (ok, error)
}

/// Finalizes one persistent-session turn outcome, syncing any resume handle and retiring
/// broken transport sessions after connection failures so the next turn respawns cleanly.
pub(crate) fn settle_persistent_turn_outcome(thread_id: &str, run_id: &str, ok: bool, error: &str) {
    let (driver, handle) = {
        let manager = session_manager().lock().unwrap();
        manager
            .status(thread_id)
            .map(|r| (Some(r.driver.clone()), r.resume_handle.clone()))
            .unwrap_or((None, None))
    };
    if let Some(h) = handle.as_deref() {
        sync_thread_provider_session_id_for_provider(thread_id, driver.as_deref(), Some(h));
    }
    if !ok {
        if crate::chat::runtime::post_reply::is_connection_failure(error) {
            if let Ok(mut manager) = session_manager().lock() {
                let _ = manager.stop(thread_id);
            }
        }
        let provider = threads()
            .lock()
            .unwrap()
            .iter()
            .find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id))
            .and_then(|t| t.get("provider").and_then(|v| v.as_str()))
            .unwrap_or("")
            .to_string();
        let projected =
            crate::chat::normalize::project_process_failure(Some(1), error, &provider, &[]);
        if let Some(failure) = projected.failure {
            record_turn_failure(thread_id, &failure);
            finish_run(run_id, false, false, "");
            return;
        }
    }
    finish_run(run_id, ok, false, error);
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
    if let Some(obj) = thread.as_object_mut() {
        obj.remove("turnFailure");
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
    let provider_prompt = crate::chat::format_prompt_with_attachments(prompt, &attachments);
    let mut user_item = chat_item(&user_id, "user", prompt, false);
    if is_internal_dispatch_prompt(prompt) {
        user_item["internalDispatch"] = json!(true);
    }
    if !attachments.is_empty() {
        user_item["attachments"] = Value::Array(attachments);
    }
    let assistant_item = chat_item(&assistant_id, "assistant", "", true);
    let mut title_mutated = false;
    {
        let mut items = threads().lock().unwrap();
        if let Some(stored) = items.iter_mut().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id)) {
            if let Some(obj) = stored.as_object_mut() {
                obj.remove("turnFailure");
            }
            upsert_item(stored, &user_item);
            upsert_item(stored, &assistant_item);
            if apply_derived_title_if_needed(stored, "provisional", false) {
                touch(stored);
                title_mutated = true;
            }
            thread = stored.clone();
        }
    }
    if title_mutated {
        persist();
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
        finished_at_ms: None,
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
    launch_provider(thread_id.to_string(), run_id.clone(), &thread, &provider_prompt, binding);
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
        let (events, revision, finished, has_more, resync_required) = match live.runs.get_mut(run_id) {
            Some(run) => {
                let first_seq = run
                    .events
                    .first()
                    .and_then(|event| event.get("sequence"))
                    .and_then(|v| v.as_u64());
                let compacted_gap = match first_seq {
                    Some(first) => first > after_sequence + 1,
                    None => run.next_sequence > after_sequence,
                };
                let mut events: Vec<Value> = run
                    .events
                    .iter()
                    .filter(|event| event.get("sequence").and_then(|v| v.as_u64()).unwrap_or(0) > after_sequence)
                    .take(33)
                    .cloned()
                    .collect();
                let has_more = events.len() > 32;
                if has_more {
                    events.truncate(32);
                }
                if let Some(next) = events
                    .last()
                    .and_then(|event| event.get("sequence"))
                    .and_then(|value| value.as_u64())
                {
                    if next > run.delivered_through {
                        run.delivered_through = next;
                    }
                }
                (events, run.revision.clone(), run.finished && !has_more, has_more, compacted_gap)
            }
            None => (Vec::new(), format!("{:064x}", 1), true, false, true),
        };
        if !events.is_empty() || finished || resync_required || Instant::now() >= deadline {
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
                "hasMore": has_more,
                "resyncRequired": resync_required,
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

fn cancel_active_child_threads(parent_thread_id: &str) {
    let (subagent_targets, swarm_child_ids) = {
        let all = threads().lock().unwrap();
        let Some(parent) = all
            .iter()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(parent_thread_id))
        else {
            return;
        };
        let mut seen_cids: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut sub_ids: Vec<String> = Vec::new();
        if let Some(runs) = parent.get("subagentRuns").and_then(Value::as_array) {
            for run in runs {
                let status = run.get("status").and_then(Value::as_str).unwrap_or("running");
                let terminal = matches!(
                    status,
                    "completed"
                        | "failed"
                        | "killed"
                        | "cancelled"
                        | "canceled"
                        | "stopped"
                        | "interrupted"
                );
                if terminal {
                    continue;
                }
                let Some(cid) = run
                    .get("childThreadId")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty() && *s != parent_thread_id)
                else {
                    continue;
                };
                if seen_cids.insert(cid.to_string()) {
                    let target = run
                        .get("subagentId")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .unwrap_or(cid);
                    sub_ids.push(target.to_string());
                }
            }
        }
        let mut swarm_cids: Vec<String> = Vec::new();
        if let Some(members) = parent
            .pointer("/swarmState/members")
            .and_then(Value::as_array)
        {
            for member in members {
                let state = member.get("state").and_then(Value::as_str).unwrap_or("");
                if !matches!(state, "working" | "waiting") {
                    continue;
                }
                if let Some(cid) = member
                    .get("childThreadId")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty() && *s != parent_thread_id)
                {
                    if seen_cids.insert(cid.to_string()) {
                        swarm_cids.push(cid.to_string());
                    }
                }
            }
        }
        (sub_ids, swarm_cids)
    };
    for sid in subagent_targets {
        let _ = crate::chat::subagents::cancel_subagent_thread(parent_thread_id, &sid);
    }
    for cid in swarm_child_ids {
        cancel_turn(&cid);
    }
}

pub fn cancel_turn(thread_id: &str) {
    chat_log(&format!("cancel_turn: requested for thread={}", thread_id));
    enum CancelRunState {
        Active(String),
        Closing,
        MissingOrFinished,
    }
    let run_state = {
        let live = live_turns().lock().unwrap();
        match live
            .by_thread
            .get(thread_id)
            .and_then(|rid| live.runs.get(rid).map(|run| (rid.clone(), run.closing, run.finished)))
        {
            Some((_, true, false)) => CancelRunState::Closing,
            Some((rid, false, false)) => CancelRunState::Active(rid),
            _ => CancelRunState::MissingOrFinished,
        }
    };
    let run_id = match run_state {
        CancelRunState::Closing => return,
        CancelRunState::Active(rid) => rid,
        CancelRunState::MissingOrFinished => {
            chat_log(&format!("cancel_turn: no live run for thread={}", thread_id));
            if let Ok(mut manager) = session_manager().lock() {
                let _ = manager.interrupt(thread_id);
            }
            cancel_active_child_threads(thread_id);
            let mut changed = false;
            {
                let mut items = threads().lock().unwrap();
                if let Some(stored) = items
                    .iter_mut()
                    .find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id))
                {
                    if super::settle::heal_orphaned_running_thread(stored, true) {
                        touch(stored);
                        changed = true;
                    } else if apply_derived_title_if_needed(stored, "generated", true) {
                        changed = true;
                    }
                }
            }
            if changed {
                persist();
            }
            return;
        }
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
    cancel_active_child_threads(thread_id);
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
            let has_attachments = it
                .get("attachments")
                .and_then(|v| v.as_array())
                .is_some_and(|arr| !arr.is_empty());
            !streaming && (!text.trim().is_empty() || has_attachments)
        })
        .collect();

    if let Some(last) = past_items.last() {
        if last.get("kind").and_then(|v| v.as_str()) == Some("user") {
            let last_text = last.get("text").and_then(|v| v.as_str()).unwrap_or("");
            let last_atts = last
                .get("attachments")
                .and_then(|v| v.as_array())
                .map(|a| a.as_slice())
                .unwrap_or(&[]);
            if last_text == current_prompt
                || crate::chat::format_prompt_with_attachments(last_text, last_atts) == current_prompt
            {
                past_items.pop();
            }
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

    let session_id = thread
        .get("id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("thread");
    let provider_name = thread
        .get("provider")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("local");
    let agent_name = thread
        .get("subagentRole")
        .or_else(|| thread.get("swarmMemberName"))
        .or_else(|| thread.get("agentRole"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(if provider_name != "local" {
            provider_name
        } else {
            "thread"
        });
    let model_name = thread
        .get("model")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("unknown");
    let ctx_engine = past_items
        .iter()
        .any(|it| it.get("text").and_then(|v| v.as_str()).is_some_and(|t| t.len() > 900))
        .then(|| {
            if cfg!(test) && std::env::var_os(kite_ctx::ENV_DB_PATH).is_none() {
                kite_ctx::ContextEngine::open_in_memory().ok()
            } else {
                kite_ctx::ContextEngine::open_default().ok()
            }
        })
        .flatten();

    for item in past_items {
        let kind = item.get("kind").and_then(|v| v.as_str()).unwrap_or("");
        let text = item.get("text").and_then(|v| v.as_str()).unwrap_or("");
        match kind {
            "user" => {
                let atts = item
                    .get("attachments")
                    .and_then(|v| v.as_array())
                    .map(|a| a.as_slice())
                    .unwrap_or(&[]);
                let formatted = crate::chat::format_prompt_with_attachments(text.trim(), atts);
                context_buffer.push_str("\n[User]:\n");
                context_buffer.push_str(formatted.trim());
                context_buffer.push('\n');
            }
            "assistant" => {
                context_buffer.push_str("\n[Assistant]:\n");
                let trimmed = text.trim();
                if trimmed.chars().count() > 4000 || trimmed.len() > 1200 {
                    if let Some(compressed) = ctx_engine.as_ref().and_then(|eng| {
                        eng.compress_runtime_segment(
                            trimmed,
                            4000,
                            "runtime:thread_history",
                            session_id,
                            agent_name,
                            provider_name,
                            model_name,
                        )
                        .ok()
                    }) {
                        context_buffer.push_str(&compressed);
                        context_buffer.push('\n');
                    } else {
                        let clipped: String = trimmed.chars().take(4000).collect();
                        context_buffer.push_str(&clipped);
                        context_buffer.push_str("\n... [output truncated for brevity] ...\n");
                    }
                } else {
                    context_buffer.push_str(trimmed);
                    context_buffer.push('\n');
                }
            }
            "tool" => {
                let tool_name = item
                    .get("toolName")
                    .or_else(|| item.get("title"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("tool");
                let status = item
                    .get("status")
                    .and_then(|v| v.as_str())
                    .unwrap_or("completed");
                context_buffer.push_str(&format!("\n[Tool Call: {} ({})]\n", tool_name, status));
                let trimmed = text.trim();
                if trimmed.chars().count() > 1500 || trimmed.len() > 900 {
                    if let Some(compressed) = ctx_engine.as_ref().and_then(|eng| {
                        eng.compress_runtime_segment(
                            trimmed,
                            1500,
                            "runtime:thread_history",
                            session_id,
                            agent_name,
                            provider_name,
                            model_name,
                        )
                        .ok()
                    }) {
                        context_buffer.push_str(&compressed);
                        context_buffer.push('\n');
                    } else {
                        let clipped: String = trimmed.chars().take(1500).collect();
                        let total_chars = trimmed.chars().count();
                        context_buffer.push_str(&clipped);
                        context_buffer.push_str(&format!(
                            "\n... [clipped {} characters] ...\n",
                            total_chars.saturating_sub(1500)
                        ));
                    }
                } else {
                    context_buffer.push_str(trimmed);
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
