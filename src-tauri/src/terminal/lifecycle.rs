use crate::logger::log_trace;
use crate::session_resolver::{
    canonical_agent_engine, choose_restore_provider_id, detect_child_agent_in_shell,
    is_generic_shell_engine, read_persisted_terminal_sessions,
    resolve_provider_session_id_with_context, restore_grok_provider_id,
    upsert_persisted_terminal_session, upsert_persisted_terminal_session_clearing_provider,
    write_persisted_terminal_sessions, PersistedTerminalSession,
};
use crate::terminal::{
    bench_record_activity_event, bench_record_pty_bytes, bench_record_vt_feed,
    capture_terminal_lifecycle, capture_terminal_output, extract_osc_cwd, get_terminals,
    now_unix_ms, snapshot_scrollback_for_attach, try_bind_provider_session_id,
    write_scrollback_file, MAX_SCROLLBACK_BYTES, TerminalInstance,
};
use portable_pty::Child as PtyChild;
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

pub static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

pub fn emit_terminal_activity(session_id: &str, seq: u64, exited: bool, exit_code: Option<i64>) {
    bench_record_activity_event();
    crate::core_daemon::notify_daemon_activity();
    emit_terminal_activity_to_webview(session_id, seq, exited, exit_code);
}

/// Invoked by `CoreConnection`'s `core-reader` thread in the GUI process when
/// `kite-core --daemon` pushes a `SNAPSHOT_BIN` or `CLOSE` frame over a channel.
pub fn emit_terminal_activity_from_core(
    session_id: &str,
    seq: u64,
    exited: bool,
    exit_code: Option<i64>,
) {
    bench_record_activity_event();
    emit_terminal_activity_to_webview(session_id, seq, exited, exit_code);
}

pub fn emit_terminal_activity_to_webview(
    session_id: &str,
    seq: u64,
    exited: bool,
    exit_code: Option<i64>,
) {
    let Some(app) = crate::get_app_handle() else {
        return;
    };
    use tauri::Emitter;
    let _ = app.emit(
        "terminal://activity",
        serde_json::json!({
            "sessionId": session_id,
            "seq": seq,
            "exited": exited,
            "exitCode": exit_code,
        }),
    );
}

pub fn notify_terminal_exit(session_id: &str, inst: &TerminalInstance, code: i64) {
    if inst.exit_notified.swap(true, Ordering::Relaxed) {
        return;
    }
    inst.lifecycle_stop.store(true, Ordering::Relaxed);
    let seq = inst.vt_engine.lock().ok().map(|vt| vt.seq()).unwrap_or(0);
    emit_terminal_activity(session_id, seq, true, Some(code));
}

pub fn try_child_exit(inst: &TerminalInstance) -> Option<i64> {
    let mut child = inst.child.lock().ok()?;
    match child.try_wait() {
        Ok(Some(status)) => Some(status.exit_code() as i64),
        _ => None,
    }
}

pub fn maybe_bind_provider_session(session_id: &str, inst: &Arc<TerminalInstance>) {
    let now = now_unix_ms();
    let needs_bind = inst
        .provider_session_id
        .lock()
        .ok()
        .and_then(|p| p.clone())
        .is_none();
    let is_shell = is_generic_shell_engine(&inst.engine);
    let shell_has_agent = is_shell
        && inst
            .detected_agent_engine
            .lock()
            .ok()
            .and_then(|d| d.clone())
            .is_some();
    if !(needs_bind && (!is_shell || shell_has_agent)) {
        return;
    }
    let attempts = inst.bind_attempts.load(Ordering::Relaxed);
    if attempts >= 4 {
        return;
    }
    let last_attempt = inst.last_bind_attempt_ms.load(Ordering::Relaxed) as i64;
    let required_gap_ms = match attempts {
        0 => 1_200,
        1 => 3_500,
        2 => 8_000,
        _ => 18_000,
    };
    if now.saturating_sub(last_attempt) < required_gap_ms {
        return;
    }
    inst.last_bind_attempt_ms
        .store(now as u64, Ordering::Relaxed);
    inst.bind_attempts.fetch_add(1, Ordering::Relaxed);
    let sid = session_id.to_string();
    let inst = Arc::clone(inst);
    std::thread::spawn(move || {
        let _ = try_bind_provider_session_id(&sid, &inst);
    });
}

pub fn schedule_paint_activity(session_id: &str, inst: &Arc<TerminalInstance>, seq: u64) {
    if !inst.presentation_live.load(Ordering::Relaxed) {
        return;
    }
    let now = now_unix_ms() as u64;
    let last = inst.last_paint_emit_ms.load(Ordering::Relaxed);
    if now.saturating_sub(last) >= 16 {
        inst.last_paint_emit_ms.store(now, Ordering::Relaxed);
        emit_terminal_activity(session_id, seq, false, None);
        return;
    }
    if inst
        .paint_flush_armed
        .compare_exchange(false, true, Ordering::Relaxed, Ordering::Relaxed)
        .is_err()
    {
        return;
    }
    let wait = 16u64.saturating_sub(now.saturating_sub(last)).max(1);
    let session_id = session_id.to_string();
    let inst = Arc::clone(inst);
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(wait));
        inst.paint_flush_armed.store(false, Ordering::Relaxed);
        if !inst.presentation_live.load(Ordering::Relaxed) {
            return;
        }
        inst.last_paint_emit_ms
            .store(now_unix_ms() as u64, Ordering::Relaxed);
        let seq = inst.vt_engine.lock().ok().map(|vt| vt.seq()).unwrap_or(0);
        emit_terminal_activity(&session_id, seq, false, None);
    });
}

pub fn spawn_terminal_lifecycle(session_id: String, inst: Arc<TerminalInstance>) {
    std::thread::spawn(move || {
        while !inst.lifecycle_stop.load(Ordering::Relaxed) && !SHUTTING_DOWN.load(Ordering::Relaxed)
        {
            std::thread::sleep(std::time::Duration::from_millis(400));
            if inst.lifecycle_stop.load(Ordering::Relaxed) {
                break;
            }
            maybe_bind_provider_session(&session_id, &inst);
            if let Some(code) = try_child_exit(&inst) {
                notify_terminal_exit(&session_id, &inst, code);
                break;
            }
        }
    });
}

pub fn spawn_pty_reader(
    mut reader: impl Read + Send + 'static,
    inst: Arc<TerminalInstance>,
    session_id: String,
) {
    std::thread::spawn(move || {
        let mut temp = [0u8; 32768];
        let mut dirty = false;
        let mut last_flush = std::time::Instant::now();
        while let Ok(n) = reader.read(&mut temp) {
            if n == 0 {
                break;
            }
            bench_record_pty_bytes(n as u64);
            let mut pending_replies = Vec::new();
            let mut wants_paint = false;
            let mut seq_after = 0u64;
            if let Ok(mut vt) = inst.vt_engine.lock() {
                let seq_before = vt.seq();
                let t_feed_start = std::time::Instant::now();
                vt.feed(&temp[..n]);
                bench_record_vt_feed(t_feed_start.elapsed().as_micros() as u64);
                wants_paint = vt.wants_paint() || vt.seq() != seq_before;
                seq_after = vt.seq();
                pending_replies = vt.take_replies();
            }
            if !pending_replies.is_empty() {
                if let Ok(mut w) = inst.writer.try_lock() {
                    let _ = w.write_all(&pending_replies);
                    let _ = w.flush();
                } else {
                    let w_clone = Arc::clone(&inst.writer);
                    let pending_replies = pending_replies.clone();
                    std::thread::spawn(move || {
                        if let Ok(mut w) = w_clone.lock() {
                            let _ = w.write_all(&pending_replies);
                            let _ = w.flush();
                        }
                    });
                }
            }
            if let Some(osc_dir) = extract_osc_cwd(&temp[..n]) {
                if let Ok(mut cwd_guard) = inst.live_cwd.lock() {
                    *cwd_guard = osc_dir;
                }
            }
            let _ = capture_terminal_output(&session_id, &inst, &temp[..n], now_unix_ms());
            {
                let mut b_guard = inst.buffer.lock().ok();
                let mut s_guard = inst.scrollback.lock().ok();
                if let Some(ref mut b) = b_guard {
                    b.extend_from_slice(&temp[..n]);
                    if b.len() > MAX_SCROLLBACK_BYTES {
                        let excess = b.len() - MAX_SCROLLBACK_BYTES;
                        b.drain(0..excess);
                    }
                }
                if let Some(ref mut s) = s_guard {
                    s.extend_from_slice(&temp[..n]);
                    if s.len() > MAX_SCROLLBACK_BYTES {
                        let excess = s.len() - MAX_SCROLLBACK_BYTES;
                        s.drain(0..excess);
                    }
                    dirty = true;
                }
            }
            if wants_paint {
                schedule_paint_activity(&session_id, &inst, seq_after);
            } else {
                crate::core_daemon::notify_daemon_activity();
            }
            if dirty && last_flush.elapsed() >= std::time::Duration::from_millis(2500) {
                let snapshot_bytes = inst.scrollback.lock().ok().map(|s| s.clone());
                if let Some(s) = snapshot_bytes {
                    write_scrollback_file(&session_id, &s);
                }
                dirty = false;
                last_flush = std::time::Instant::now();
            }
        }
        if dirty {
            let snapshot_bytes = inst.scrollback.lock().ok().map(|s| s.clone());
            if let Some(s) = snapshot_bytes {
                write_scrollback_file(&session_id, &s);
            }
        }
        if let Some(code) = try_child_exit(&inst) {
            notify_terminal_exit(&session_id, &inst, code);
        }
    });
}

pub fn flush_all_terminal_scrollbacks() {
    let active_instances: Vec<(String, Arc<TerminalInstance>)> = {
        let Ok(map) = get_terminals().lock() else {
            return;
        };
        map.iter()
            .map(|(session_id, inst)| (session_id.clone(), Arc::clone(inst)))
            .collect()
    };
    if active_instances.is_empty() {
        return;
    }
    flush_and_persist_active_terminals(&active_instances, now_unix_ms());
}

/// Shared scrollback flush + session metadata persistence for a snapshot of live
/// instances. Returns the root PIDs the caller may terminate.
pub fn flush_and_persist_active_terminals(
    active_instances: &[(String, Arc<TerminalInstance>)],
    now: i64,
) -> Vec<u32> {
    let mut persisted_map = read_persisted_terminal_sessions();
    let mut claimed_provider_ids: HashSet<String> = HashSet::new();
    let mut pids_to_kill: Vec<u32> = Vec::new();

    for (session_id, inst) in active_instances.iter() {
        // 1. Flush any unread buffer into scrollback and write .scrollback to disk
        let _ = snapshot_scrollback_for_attach(session_id, inst, false);

        // 2. Inspect child process PID & detect if a manual agent CLI is running inside a shell
        let mut root_pid: Option<u32> = None;
        if let Ok(child) = inst.child.lock() {
            root_pid = child.process_id();
        }
        if let Some(pid) = root_pid {
            pids_to_kill.push(pid);
        }

        let child_agent = if is_generic_shell_engine(&inst.engine) {
            let running_child = root_pid.and_then(detect_child_agent_in_shell);
            if running_child.is_some() {
                running_child
            } else {
                // If no child agent process is currently running, only trust detected_agent_engine
                // if there is an already verified and bound provider_session_id.
                let has_bound_prov = inst
                    .provider_session_id
                    .lock()
                    .ok()
                    .and_then(|p| p.clone())
                    .is_some();
                if has_bound_prov {
                    inst.detected_agent_engine.lock().ok().and_then(|d| d.clone())
                } else {
                    None
                }
            }
        } else {
            None
        };

        let active_engine = child_agent
            .clone()
            .unwrap_or_else(|| canonical_agent_engine(&inst.engine));

        let cwd = inst
            .live_cwd
            .lock()
            .ok()
            .map(|c| c.clone())
            .filter(|c| !c.is_empty())
            .unwrap_or_else(|| inst.cwd.clone());

        let existing_prov = inst
            .provider_session_id
            .lock()
            .ok()
            .and_then(|p| p.clone())
            .or_else(|| {
                persisted_map
                    .get(session_id)
                    .and_then(|p| p.provider_session_id.clone())
            });

        let last_input = inst
            .last_user_input
            .lock()
            .ok()
            .and_then(|l| l.clone())
            .or_else(|| {
                persisted_map
                    .get(session_id)
                    .and_then(|p| p.last_user_input.clone())
            });

        let resolved_provider_id = if !is_generic_shell_engine(&active_engine) {
            resolve_provider_session_id_with_context(
                &active_engine,
                &cwd,
                session_id,
                existing_prov.as_deref(),
                inst.spawned_at_unix_ms,
                &claimed_provider_ids,
                root_pid,
                last_input.as_deref(),
            )
        } else {
            None
        };

        if let Some(ref pid) = resolved_provider_id {
            claimed_provider_ids.insert(pid.clone());
        }

        let ws_id = inst
            .workspace_id
            .lock()
            .ok()
            .and_then(|w| w.clone())
            .or_else(|| {
                persisted_map
                    .get(session_id)
                    .and_then(|p| p.workspace_id.clone())
            });
        let p_id = inst
            .pane_id
            .lock()
            .ok()
            .and_then(|p| p.clone())
            .or_else(|| {
                persisted_map
                    .get(session_id)
                    .and_then(|p| p.pane_id.clone())
            });

        let had_activity = inst.had_user_activity.load(Ordering::Relaxed)
            || child_agent.is_some()
            || resolved_provider_id.is_some();

        persisted_map.insert(
            session_id.clone(),
            PersistedTerminalSession {
                session_id: session_id.clone(),
                workspace_id: ws_id,
                pane_id: p_id,
                base_engine: inst.engine.clone(),
                active_engine,
                provider_session_id: resolved_provider_id,
                cwd,
                had_user_activity: had_activity,
                last_user_input: last_input,
                spawned_at_unix_ms: inst.spawned_at_unix_ms,
                saved_at_unix_ms: now,
            },
        );
    }

    // Atomically persist terminal-sessions.json before any caller kills children.
    write_persisted_terminal_sessions(&persisted_map);
    pids_to_kill
}

/// Synchronously flushes all terminal scrollbacks, captures live CWDs, child agent processes,
/// and provider session IDs into `terminal-sessions.json`, and terminates ConPTY processes
/// cleanly WITHOUT deleting `.scrollback` files.
pub fn snapshot_and_shutdown_all_terminals(reason: &str) {
    if SHUTTING_DOWN.swap(true, Ordering::SeqCst) {
        return;
    }
    log_trace(&format!(
        "snapshot_and_shutdown_all_terminals invoked: reason={}",
        reason
    ));

    let active_instances: Vec<(String, Arc<TerminalInstance>)> = {
        let Ok(mut map) = get_terminals().lock() else {
            return;
        };
        map.drain().collect()
    };

    if active_instances.is_empty() {
        return;
    }

    let pids_to_kill = flush_and_persist_active_terminals(&active_instances, now_unix_ms());

    // Terminate child process trees so no orphaned ConPTY/node/agent processes remain
    #[cfg(windows)]
    if !pids_to_kill.is_empty() {
        let mut kill_args: Vec<String> = vec!["/F".into(), "/T".into()];
        for pid in &pids_to_kill {
            kill_args.push("/PID".into());
            kill_args.push(pid.to_string());
        }
        let kill_refs: Vec<&str> = kill_args.iter().map(|s| s.as_str()).collect();
        let _ = crate::hidden_exec::run(
            std::path::Path::new("taskkill.exe"),
            &kill_refs,
            std::time::Duration::from_secs(5),
        );
    }

    for (_session_id, inst) in active_instances {
        if let Ok(mut child) = inst.child.lock() {
            let _ = child.kill();
        }
    }
}
