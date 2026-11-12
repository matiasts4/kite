use crate::logger::log_trace;
use crate::session_resolver::{
    detect_child_agent_in_shell, is_generic_shell_engine, read_persisted_terminal_sessions,
    resolve_provider_session_id_with_context, write_persisted_terminal_sessions,
    PersistedTerminalSession,
};
use crate::terminal::{
    emit_terminal_ui_event, get_globally_claimed_provider_ids, get_terminals, now_unix_ms,
    read_scrollback_file, snapshot_scrollback_for_attach, spawn_session_with_options,
    write_scrollback_file, SpawnMode, SpawnOptions, TerminalInstance, MAX_SCROLLBACK_BYTES,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, OnceLock};

/// Activity recency threshold used to distinguish an actively streaming agent turn
/// from a terminal sitting idle at its interactive prompt.
pub const BUSY_ACTIVITY_WINDOW_MS: u64 = 3_000;

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuiescedTerminal {
    pub session_id: String,
    pub cwd: String,
    pub base_engine: String,
    pub effective_engine: String,
    pub provider_session_id: Option<String>,
    pub workspace_id: Option<String>,
    pub pane_id: Option<String>,
    pub cols: u16,
    pub rows: u16,
    #[serde(default = "default_true")]
    pub presentation_live: bool,
    #[serde(default = "default_true")]
    pub auto_approve: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSessionSummary {
    pub session_id: String,
    pub engine: String,
    pub workspace_id: Option<String>,
    pub pane_id: Option<String>,
    pub cwd: String,
    pub busy: bool,
    pub reasons: Vec<String>,
    pub last_output_age_ms: Option<u64>,
    pub presentation_live: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSessionsInspection {
    pub managed_idle: Vec<ProviderSessionSummary>,
    pub managed_busy: Vec<ProviderSessionSummary>,
    pub external_blocking: Vec<String>,
    pub unaffected_terminals_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionActivityInput {
    pub now_ms: u64,
    pub last_output_ms: u64,
    pub last_paint_emit_ms: u64,
    pub output_byte_offset: u64,
    pub pending_buffer_len: usize,
    pub child_running: bool,
    pub had_user_activity: bool,
}

#[derive(Debug, Clone)]
struct DeferredRotation {
    terminal: QuiescedTerminal,
    provider: String,
    account_label: String,
    email: Option<String>,
}

static DEFERRED_ROTATIONS: OnceLock<Mutex<HashMap<String, DeferredRotation>>> = OnceLock::new();

fn deferred_rotations() -> &'static Mutex<HashMap<String, DeferredRotation>> {
    DEFERRED_ROTATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn canonical_rotation_provider(provider: &str) -> String {
    match crate::account_switcher::canon_provider(provider).as_str() {
        "agy" => "antigravity".to_string(),
        other => other.to_string(),
    }
}

/// Pure classifier for live terminal busyness based strictly on observable PTY state.
pub fn classify_session_activity(input: &SessionActivityInput) -> (bool, Vec<String>, Option<u64>) {
    let latest_ms = input.last_output_ms.max(input.last_paint_emit_ms);
    let age_ms = (latest_ms > 0).then(|| input.now_ms.saturating_sub(latest_ms));

    if !input.child_running {
        return (false, Vec::new(), age_ms);
    }

    let mut reasons = Vec::new();
    if let Some(age) = age_ms {
        if age <= BUSY_ACTIVITY_WINDOW_MS {
            reasons.push("recent_output".to_string());
        }
    }
    if input.pending_buffer_len > 0 {
        reasons.push("pending_output".to_string());
    }

    let busy = !reasons.is_empty();
    (busy, reasons, age_ms)
}

pub fn format_account_rotation_divider(account_label: &str) -> Vec<u8> {
    format!(
        "\r\n─── ✦ Kite Vault: Sesión reactivada con cuenta «{}» ───\r\n",
        account_label.trim()
    )
    .into_bytes()
}

pub fn append_rotation_divider_to_scrollback(session_id: &str, account_label: &str) {
    let mut combined = read_scrollback_file(session_id).unwrap_or_default();
    let divider = format_account_rotation_divider(account_label);
    combined.extend_from_slice(&divider);
    if combined.len() > MAX_SCROLLBACK_BYTES {
        let excess = combined.len() - MAX_SCROLLBACK_BYTES;
        combined.drain(0..excess);
    }
    let _ = write_scrollback_file(session_id, &combined);
}

pub fn inspect_provider_sessions(provider: &str) -> ProviderSessionsInspection {
    if crate::core_daemon::is_external_daemon_owner() {
        if let Ok(res) = crate::core_daemon::send_core_daemon_rpc(
            "session.inspect_provider",
            Some(serde_json::json!({ "provider": provider })),
        ) {
            if let Ok(report) = serde_json::from_value::<ProviderSessionsInspection>(res) {
                return report;
            }
        }
    }
    inspect_provider_sessions_local(provider)
}

pub fn inspect_provider_sessions_local(provider: &str) -> ProviderSessionsInspection {
    let now_ms = now_unix_ms().max(0) as u64;
    let mut report = ProviderSessionsInspection::default();

    let snapshot_entries: Vec<(String, Arc<TerminalInstance>)> = {
        let Ok(map) = get_terminals().lock() else {
            return report;
        };
        map.iter().map(|(k, v)| (k.clone(), Arc::clone(v))).collect()
    };

    for (session_id, inst) in snapshot_entries {
        if !terminal_matches_provider(&inst, provider) {
            report.unaffected_terminals_count += 1;
            continue;
        }

        let child_running = if inst.exit_notified.load(Ordering::Relaxed) {
            false
        } else if let Ok(mut child) = inst.child.lock() {
            matches!(child.try_wait(), Ok(None))
        } else {
            false
        };
        let pending_buffer_len = inst.buffer.lock().map(|b| b.len()).unwrap_or(0);
        let input = SessionActivityInput {
            now_ms,
            last_output_ms: inst.last_output_ms.load(Ordering::Relaxed),
            last_paint_emit_ms: inst.last_paint_emit_ms.load(Ordering::Relaxed),
            output_byte_offset: inst.output_byte_offset.load(Ordering::Relaxed),
            pending_buffer_len,
            child_running,
            had_user_activity: inst.had_user_activity.load(Ordering::Relaxed),
        };
        let (busy, reasons, last_output_age_ms) = classify_session_activity(&input);

        let effective_engine = if is_generic_shell_engine(&inst.engine) {
            inst.detected_agent_engine
                .lock()
                .ok()
                .and_then(|d| d.clone())
                .unwrap_or_else(|| inst.engine.clone())
        } else {
            inst.engine.clone()
        };
        let cwd = inst
            .live_cwd
            .lock()
            .ok()
            .and_then(|c| if !c.is_empty() { Some(c.clone()) } else { None })
            .unwrap_or_else(|| inst.cwd.clone());
        let workspace_id = inst.workspace_id.lock().ok().and_then(|w| w.clone());
        let pane_id = inst.pane_id.lock().ok().and_then(|p| p.clone());
        let presentation_live = inst.presentation_live.load(Ordering::Relaxed);

        let summary = ProviderSessionSummary {
            session_id,
            engine: effective_engine,
            workspace_id,
            pane_id,
            cwd,
            busy,
            reasons,
            last_output_age_ms,
            presentation_live,
        };
        if busy {
            report.managed_busy.push(summary);
        } else {
            report.managed_idle.push(summary);
        }
    }

    if let Some(procs) = crate::account_switcher::storage::running_process_names() {
        let mut seen = HashSet::new();
        for name in procs {
            if crate::account_switcher::storage::is_blocking_process(provider, &name) {
                let lower = name.to_ascii_lowercase();
                if seen.insert(lower) {
                    report.external_blocking.push(name);
                }
            }
        }
    }

    report
}

pub fn terminal_matches_provider(inst: &TerminalInstance, provider: &str) -> bool {
    let canon_p = crate::account_switcher::canon_provider(provider);

    // 1. Direct engine match (e.g. engine == "antigravity" or "agy")
    if crate::account_switcher::same_provider(&inst.engine, &canon_p) {
        return true;
    }

    // 2. Detected agent engine match
    if let Ok(det) = inst.detected_agent_engine.lock() {
        if let Some(ref d) = *det {
            if crate::account_switcher::same_provider(d, &canon_p) {
                return true;
            }
        }
    }

    // 3. Process tree inspection for generic shell engines (PowerShell / Bash / CMD)
    if is_generic_shell_engine(&inst.engine) {
        if let Ok(child) = inst.child.lock() {
            if let Some(pid) = child.process_id() {
                if let Some(detected) = detect_child_agent_in_shell(pid) {
                    if crate::account_switcher::same_provider(&detected, &canon_p) {
                        return true;
                    }
                }
            }
        }
    }

    false
}

/// Drains output buffer to scrollback and gracefully terminates Kite terminals associated with `provider`.
/// Returns the list of quiesced terminals so they can be respawned after credentials swap.
pub fn quiesce_provider_terminals(provider: &str) -> Vec<QuiescedTerminal> {
    if crate::core_daemon::is_external_daemon_owner() {
        if let Ok(res) = crate::core_daemon::send_core_daemon_rpc(
            "session.quiesce_provider",
            Some(serde_json::json!({ "provider": provider })),
        ) {
            if let Ok(quiesced) = serde_json::from_value::<Vec<QuiescedTerminal>>(res) {
                return quiesced;
            }
        }
    }
    quiesce_provider_terminals_local(provider)
}

pub fn quiesce_provider_terminals_local(provider: &str) -> Vec<QuiescedTerminal> {
    log_trace(&format!("quiesce_provider_terminals invoked for provider={}", provider));

    let matching_sessions: Vec<(String, Arc<TerminalInstance>)> = {
        let Ok(mut map) = get_terminals().lock() else {
            return Vec::new();
        };
        let mut matching_keys = Vec::new();
        for (sid, inst) in map.iter() {
            if terminal_matches_provider(inst, provider) {
                matching_keys.push(sid.clone());
            }
        }
        let mut extracted = Vec::new();
        for k in matching_keys {
            if let Some(inst) = map.remove(&k) {
                extracted.push((k, inst));
            }
        }
        extracted
    };

    if matching_sessions.is_empty() {
        return Vec::new();
    }

    // 0. Suppress exit event emission and issue Ctrl+C so active CLIs can flush cleanly
    // before we collect scrollback and terminate any remaining process tree.
    for (_session_id, inst) in &matching_sessions {
        inst.suppress_exit_event.store(true, Ordering::Relaxed);
        if let Ok(mut w) = inst.writer.lock() {
            let _ = w.write_all(b"\x03");
            let _ = w.flush();
        }
    }

    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(600);
    loop {
        let mut any_running = false;
        for (_session_id, inst) in &matching_sessions {
            if let Ok(mut child) = inst.child.lock() {
                if matches!(child.try_wait(), Ok(None)) {
                    any_running = true;
                }
            }
        }
        if !any_running || std::time::Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }

    let mut quiesced = Vec::new();
    let mut pids_to_kill = Vec::new();
    let mut persisted_map = read_persisted_terminal_sessions();
    let now = now_unix_ms();

    for (session_id, inst) in &matching_sessions {
        // 1. Drain unread PTY buffer into durable scrollback, then ensure in-memory scrollback is on disk.
        let _ = snapshot_scrollback_for_attach(session_id, inst, false);
        if let Ok(sb) = inst.scrollback.lock() {
            if !sb.is_empty() {
                let _ = write_scrollback_file(session_id, &sb);
            }
        }
        inst.lifecycle_stop.store(true, Ordering::Relaxed);

        // 2. Collect child PID only if child is still alive after Ctrl+C grace window.
        let mut root_pid: Option<u32> = None;
        if let Ok(mut child) = inst.child.lock() {
            root_pid = child.process_id();
            if matches!(child.try_wait(), Ok(None)) {
                if let Some(pid) = root_pid {
                    pids_to_kill.push(pid);
                }
            }
        }

        let cwd = inst
            .live_cwd
            .lock()
            .ok()
            .and_then(|c| if !c.is_empty() { Some(c.clone()) } else { None })
            .unwrap_or_else(|| inst.cwd.clone());

        let ws_id = inst.workspace_id.lock().ok().and_then(|w| w.clone());
        let p_id = inst.pane_id.lock().ok().and_then(|p| p.clone());
        let presentation_live = inst.presentation_live.load(Ordering::Relaxed);

        // Resolve the real agent engine (e.g. "antigravity" / "agy") even if wrapped in a shell
        let effective_engine = if is_generic_shell_engine(&inst.engine) {
            inst.detected_agent_engine
                .lock()
                .ok()
                .and_then(|d| d.clone())
                .unwrap_or_else(|| provider.to_string())
        } else {
            inst.engine.clone()
        };

        let prov_id = inst
            .provider_session_id
            .lock()
            .ok()
            .and_then(|p| p.clone())
            .or_else(|| {
                persisted_map
                    .get(session_id)
                    .and_then(|p| p.provider_session_id.clone())
            })
            .or_else(|| {
                if !is_generic_shell_engine(&effective_engine) {
                    let claimed = get_globally_claimed_provider_ids(session_id);
                    let last_input = inst.last_user_input.lock().ok().and_then(|l| l.clone());
                    resolve_provider_session_id_with_context(
                        &effective_engine,
                        &cwd,
                        session_id,
                        None,
                        inst.spawned_at_unix_ms,
                        &claimed,
                        root_pid,
                        last_input.as_deref(),
                    )
                } else {
                    None
                }
            });

        // Clear stale provider_session_id on rotation so future restarts never pass
        // `--conversation <old_id>` under the newly active account.
        persisted_map.insert(
            session_id.clone(),
            PersistedTerminalSession {
                session_id: session_id.clone(),
                workspace_id: ws_id.clone(),
                pane_id: p_id.clone(),
                base_engine: inst.engine.clone(),
                active_engine: effective_engine.clone(),
                provider_session_id: None,
                cwd: cwd.clone(),
                had_user_activity: false,
                last_user_input: None,
                spawned_at_unix_ms: inst.spawned_at_unix_ms,
                saved_at_unix_ms: now,
            },
        );

        let c = inst.cols.load(Ordering::Relaxed);
        let r = inst.rows.load(Ordering::Relaxed);

        quiesced.push(QuiescedTerminal {
            session_id: session_id.clone(),
            cwd,
            base_engine: inst.engine.clone(),
            effective_engine,
            provider_session_id: prov_id,
            workspace_id: ws_id,
            pane_id: p_id,
            cols: if c == 0 { 80 } else { c },
            rows: if r == 0 { 24 } else { r },
            presentation_live,
            auto_approve: true,
        });
    }

    write_persisted_terminal_sessions(&persisted_map);

    // Force kill only remaining stubborn child process trees to release OS file locks
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
            std::time::Duration::from_millis(400),
        );
    }

    for (_session_id, inst) in &matching_sessions {
        if let Ok(mut child) = inst.child.lock() {
            if matches!(child.try_wait(), Ok(None)) {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }

    std::thread::sleep(std::time::Duration::from_millis(30));

    quiesced
}

fn spawn_rotated_terminal(
    q: &QuiescedTerminal,
    event_provider: &str,
    account_label: &str,
    email: Option<&str>,
) {
    let is_agent = !is_generic_shell_engine(&q.effective_engine);
    let (engine_to_spawn, mode) = if is_generic_shell_engine(&q.base_engine) && is_agent {
        (
            q.base_engine.clone(),
            SpawnMode::Agent {
                hybrid_shell_agent: Some(q.effective_engine.clone()),
            },
        )
    } else if is_agent {
        (
            q.effective_engine.clone(),
            SpawnMode::Agent {
                hybrid_shell_agent: None,
            },
        )
    } else {
        (q.effective_engine.clone(), SpawnMode::Fresh)
    };

    let inst = spawn_session_with_options(
        &q.session_id,
        &q.cwd,
        &engine_to_spawn,
        SpawnOptions {
            workspace_id: q.workspace_id.clone(),
            pane_id: q.pane_id.clone(),
            cols: q.cols,
            rows: q.rows,
            mode,
            auto_approve: q.auto_approve,
            preserve_scrollback_on_agent: true,
            ..Default::default()
        },
    );
    inst.presentation_live
        .store(q.presentation_live, Ordering::Relaxed);
    if let Ok(mut vt) = inst.vt_engine.lock() {
        vt.set_canvas_active(q.presentation_live);
    }

    emit_terminal_ui_event(
        "terminal://account-rotated",
        serde_json::json!({
            "sessionId": q.session_id,
            "provider": event_provider,
            "accountLabel": account_label,
            "email": email,
        }),
    );
}

/// Respawns quiesced terminals with the updated environment and launches fresh provider sessions.
pub fn respawn_provider_terminals(
    provider: &str,
    new_account_label: &str,
    new_email: Option<&str>,
    quiesced: &[QuiescedTerminal],
) {
    if crate::core_daemon::is_external_daemon_owner() {
        let params = serde_json::json!({
            "provider": provider,
            "newAccountLabel": new_account_label,
            "newEmail": new_email,
            "quiesced": quiesced,
        });
        if crate::core_daemon::send_core_daemon_rpc("session.respawn_provider", Some(params)).is_ok() {
            return;
        }
    }
    respawn_provider_terminals_local(provider, new_account_label, new_email, quiesced);
}

pub fn respawn_provider_terminals_local(
    provider: &str,
    new_account_label: &str,
    new_email: Option<&str>,
    quiesced: &[QuiescedTerminal],
) {
    let event_provider = canonical_rotation_provider(provider);

    // Update any still-deferred panes from an earlier switch before focusing occurs.
    if let Ok(mut deferred_map) = deferred_rotations().lock() {
        for q in quiesced {
            deferred_map.remove(&q.session_id);
        }
        for (sid, entry) in deferred_map.iter_mut() {
            if entry.provider == event_provider && entry.account_label != new_account_label {
                entry.account_label = new_account_label.to_string();
                entry.email = new_email.map(String::from);
                append_rotation_divider_to_scrollback(sid, new_account_label);
            }
        }
    }

    if quiesced.is_empty() {
        return;
    }

    // Clear stale persisted conversation IDs and stamp visible rotation dividers into scrollback.
    let mut persisted_map = read_persisted_terminal_sessions();
    let now = now_unix_ms();
    for q in quiesced {
        append_rotation_divider_to_scrollback(&q.session_id, new_account_label);
        if let Some(entry) = persisted_map.get_mut(&q.session_id) {
            entry.provider_session_id = None;
            entry.had_user_activity = false;
            entry.last_user_input = None;
            entry.saved_at_unix_ms = now;
        }
    }
    write_persisted_terminal_sessions(&persisted_map);

    let mut live_first = Vec::new();
    let mut deferred = Vec::new();
    for q in quiesced {
        if q.presentation_live {
            live_first.push(q);
        } else {
            deferred.push(q);
        }
    }

    for (i, q) in live_first.iter().enumerate() {
        spawn_rotated_terminal(q, &event_provider, new_account_label, new_email);
        if i + 1 < live_first.len() {
            std::thread::sleep(std::time::Duration::from_millis(30));
        }
    }

    if !deferred.is_empty() {
        if let Ok(mut deferred_map) = deferred_rotations().lock() {
            for q in deferred {
                deferred_map.insert(
                    q.session_id.clone(),
                    DeferredRotation {
                        terminal: q.clone(),
                        provider: event_provider.clone(),
                        account_label: new_account_label.to_string(),
                        email: new_email.map(String::from),
                    },
                );
            }
        }
    }
}

/// Materializes an unfocused quiesced terminal when the user later focuses or attaches to it.
pub fn maybe_respawn_deferred_terminal_local(session_id: &str) -> bool {
    let pending = deferred_rotations()
        .lock()
        .ok()
        .and_then(|mut map| map.remove(session_id));
    let Some(mut entry) = pending else {
        return false;
    };
    if get_terminals()
        .lock()
        .map(|map| map.contains_key(session_id))
        .unwrap_or(false)
    {
        return false;
    }
    entry.terminal.presentation_live = true;
    spawn_rotated_terminal(
        &entry.terminal,
        &entry.provider,
        &entry.account_label,
        entry.email.as_deref(),
    );
    true
}
