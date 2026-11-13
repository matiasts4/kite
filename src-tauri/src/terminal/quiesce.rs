use crate::logger::log_trace;
use crate::session_resolver::{
    detect_child_agent_in_shell, is_generic_shell_engine, read_persisted_terminal_sessions,
    resolve_provider_session_id_with_context, write_persisted_terminal_sessions,
    PersistedTerminalSession,
};
use crate::terminal::scrollback::{
    read_scrollback_file_in, snapshot_scrollback_for_attach_in, write_scrollback_file_in,
};
use crate::terminal::{
    emit_terminal_ui_event, get_globally_claimed_provider_ids, get_terminals, now_unix_ms,
    spawn_session_with_options, SpawnMode, SpawnOptions, TerminalInstance, MAX_SCROLLBACK_BYTES,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::Path;
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
pub(crate) struct DeferredRotation {
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

pub fn append_rotation_divider_to_scrollback_in(
    scrollback_dir: Option<&Path>,
    session_id: &str,
    account_label: &str,
) {
    let mut combined = read_scrollback_file_in(scrollback_dir, session_id).unwrap_or_default();
    let divider = format_account_rotation_divider(account_label);
    combined.extend_from_slice(&divider);
    if combined.len() > MAX_SCROLLBACK_BYTES {
        let excess = combined.len() - MAX_SCROLLBACK_BYTES;
        combined.drain(0..excess);
    }
    let _ = write_scrollback_file_in(scrollback_dir, session_id, &combined);
}

pub fn append_rotation_divider_to_scrollback(session_id: &str, account_label: &str) {
    append_rotation_divider_to_scrollback_in(None, session_id, account_label);
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
    quiesce_provider_terminals_in(provider, get_terminals(), None, None)
}

pub(crate) fn quiesce_provider_terminals_in(
    provider: &str,
    terminals_map: &Mutex<HashMap<String, Arc<TerminalInstance>>>,
    scrollback_dir: Option<&Path>,
    mut persisted_override: Option<&mut HashMap<String, PersistedTerminalSession>>,
) -> Vec<QuiescedTerminal> {
    log_trace(&format!("quiesce_provider_terminals invoked for provider={}", provider));

    let matching_sessions: Vec<(String, Arc<TerminalInstance>)> = {
        let Ok(mut map) = terminals_map.lock() else {
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
    let mut disk_persisted = if persisted_override.is_none() {
        Some(read_persisted_terminal_sessions())
    } else {
        None
    };
    let persisted_map = match persisted_override.as_deref_mut() {
        Some(map) => map,
        None => disk_persisted
            .as_mut()
            .expect("disk persisted map initialized"),
    };
    let now = now_unix_ms();

    for (session_id, inst) in &matching_sessions {
        // 1. Drain unread PTY buffer into durable scrollback, then ensure in-memory scrollback is on disk.
        let _ = snapshot_scrollback_for_attach_in(scrollback_dir, session_id, inst, false);
        if let Ok(sb) = inst.scrollback.lock() {
            if !sb.is_empty() {
                let _ = write_scrollback_file_in(scrollback_dir, session_id, &sb);
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

    if let Some(ref map) = disk_persisted {
        write_persisted_terminal_sessions(map);
    }

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

pub fn plan_rotated_spawn(q: &QuiescedTerminal) -> (String, SpawnMode) {
    let is_agent = !is_generic_shell_engine(&q.effective_engine);
    if is_generic_shell_engine(&q.base_engine) && is_agent {
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
    }
}

fn spawn_rotated_terminal(
    q: &QuiescedTerminal,
    event_provider: &str,
    account_label: &str,
    email: Option<&str>,
) {
    let (engine_to_spawn, mode) = plan_rotated_spawn(q);

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
    respawn_provider_terminals_with(
        provider,
        new_account_label,
        new_email,
        quiesced,
        None,
        None,
        deferred_rotations(),
        spawn_rotated_terminal,
    );
}

pub(crate) fn respawn_provider_terminals_with<F>(
    provider: &str,
    new_account_label: &str,
    new_email: Option<&str>,
    quiesced: &[QuiescedTerminal],
    scrollback_dir: Option<&Path>,
    mut persisted_override: Option<&mut HashMap<String, PersistedTerminalSession>>,
    deferred_store: &Mutex<HashMap<String, DeferredRotation>>,
    mut spawn_fn: F,
) where
    F: FnMut(&QuiescedTerminal, &str, &str, Option<&str>),
{
    let event_provider = canonical_rotation_provider(provider);

    // Update any still-deferred panes from an earlier switch before focusing occurs.
    if let Ok(mut deferred_map) = deferred_store.lock() {
        for q in quiesced {
            deferred_map.remove(&q.session_id);
        }
        for (sid, entry) in deferred_map.iter_mut() {
            if entry.provider == event_provider && entry.account_label != new_account_label {
                entry.account_label = new_account_label.to_string();
                entry.email = new_email.map(String::from);
                append_rotation_divider_to_scrollback_in(scrollback_dir, sid, new_account_label);
            }
        }
    }

    if quiesced.is_empty() {
        return;
    }

    // Clear stale persisted conversation IDs and stamp visible rotation dividers into scrollback.
    let mut disk_persisted = if persisted_override.is_none() {
        Some(read_persisted_terminal_sessions())
    } else {
        None
    };
    let persisted_map = match persisted_override.as_deref_mut() {
        Some(map) => map,
        None => disk_persisted
            .as_mut()
            .expect("disk persisted map initialized"),
    };
    let now = now_unix_ms();
    for q in quiesced {
        append_rotation_divider_to_scrollback_in(scrollback_dir, &q.session_id, new_account_label);
        if let Some(entry) = persisted_map.get_mut(&q.session_id) {
            entry.provider_session_id = None;
            entry.had_user_activity = false;
            entry.last_user_input = None;
            entry.saved_at_unix_ms = now;
        }
    }
    if let Some(ref map) = disk_persisted {
        write_persisted_terminal_sessions(map);
    }

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
        spawn_fn(q, &event_provider, new_account_label, new_email);
        if i + 1 < live_first.len() {
            std::thread::sleep(std::time::Duration::from_millis(30));
        }
    }

    if !deferred.is_empty() {
        if let Ok(mut deferred_map) = deferred_store.lock() {
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
    maybe_respawn_deferred_terminal_with(
        session_id,
        deferred_rotations(),
        get_terminals(),
        spawn_rotated_terminal,
    )
}

pub(crate) fn maybe_respawn_deferred_terminal_with<F>(
    session_id: &str,
    deferred_store: &Mutex<HashMap<String, DeferredRotation>>,
    terminals_map: &Mutex<HashMap<String, Arc<TerminalInstance>>>,
    mut spawn_fn: F,
) -> bool
where
    F: FnMut(&QuiescedTerminal, &str, &str, Option<&str>),
{
    let pending = deferred_store
        .lock()
        .ok()
        .and_then(|mut map| map.remove(session_id));
    let Some(mut entry) = pending else {
        return false;
    };
    if terminals_map
        .lock()
        .map(|map| map.contains_key(session_id))
        .unwrap_or(false)
    {
        return false;
    }
    entry.terminal.presentation_live = true;
    spawn_fn(
        &entry.terminal,
        &entry.provider,
        &entry.account_label,
        entry.email.as_deref(),
    );
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal::launcher::build_agent_cli_args_ext;
    use portable_pty::{native_pty_system, Child, ChildKiller, ExitStatus, PtySize};
    use std::sync::atomic::AtomicBool;

    struct RecordingWriter(Arc<Mutex<Vec<u8>>>);

    impl Write for RecordingWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[derive(Debug, Clone)]
    struct MockChild {
        exited: Arc<AtomicBool>,
        pid: u32,
    }

    impl ChildKiller for MockChild {
        fn kill(&mut self) -> std::io::Result<()> {
            self.exited.store(true, Ordering::Relaxed);
            Ok(())
        }

        fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
            Box::new(self.clone())
        }
    }

    impl Child for MockChild {
        fn try_wait(&mut self) -> std::io::Result<Option<ExitStatus>> {
            if self.exited.load(Ordering::Relaxed) {
                Ok(Some(ExitStatus::with_exit_code(0)))
            } else {
                Ok(None)
            }
        }

        fn wait(&mut self) -> std::io::Result<ExitStatus> {
            self.exited.store(true, Ordering::Relaxed);
            Ok(ExitStatus::with_exit_code(0))
        }

        fn process_id(&self) -> Option<u32> {
            Some(self.pid)
        }

        #[cfg(windows)]
        fn as_raw_handle(&self) -> Option<std::os::windows::io::RawHandle> {
            None
        }
    }

    struct AutoExitOnCtrlCWriter {
        bytes: Arc<Mutex<Vec<u8>>>,
        exited: Arc<AtomicBool>,
    }

    impl Write for AutoExitOnCtrlCWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.bytes.lock().unwrap().extend_from_slice(buf);
            if buf.contains(&0x03) {
                self.exited.store(true, Ordering::Relaxed);
            }
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn make_test_terminal(
        engine: &str,
        detected_agent: Option<&str>,
        cwd: &str,
        provider_session_id: Option<&str>,
        presentation_live: bool,
        scrollback_seed: &[u8],
    ) -> (Arc<TerminalInstance>, Arc<Mutex<Vec<u8>>>, Arc<AtomicBool>) {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("open mock pty");
        drop(pair.slave);

        let written = Arc::new(Mutex::new(Vec::new()));
        let exited = Arc::new(AtomicBool::new(false));
        let writer: Box<dyn Write + Send> = Box::new(AutoExitOnCtrlCWriter {
            bytes: Arc::clone(&written),
            exited: Arc::clone(&exited),
        });
        let child: Box<dyn portable_pty::Child + Send> = Box::new(MockChild {
            exited: Arc::clone(&exited),
            pid: 99_999,
        });

        let inst = Arc::new(TerminalInstance {
            master: Arc::new(Mutex::new(pair.master)),
            writer: Arc::new(Mutex::new(writer)),
            child: Arc::new(Mutex::new(child)),
            buffer: Arc::new(Mutex::new(Vec::new())),
            scrollback: Arc::new(Mutex::new(scrollback_seed.to_vec())),
            vt_engine: Arc::new(Mutex::new(crate::vt_engine::TerminalVtEngine::new(100, 32))),
            sequence: std::sync::atomic::AtomicU64::new(0),
            output_byte_offset: std::sync::atomic::AtomicU64::new(0),
            output_capture_order: Mutex::new(()),
            ansi_scan_tail: Mutex::new(Vec::new()),
            cwd: cwd.to_string(),
            live_cwd: Arc::new(Mutex::new(cwd.to_string())),
            engine: engine.to_string(),
            detected_agent_engine: Arc::new(Mutex::new(detected_agent.map(String::from))),
            provider_session_id: Arc::new(Mutex::new(provider_session_id.map(String::from))),
            workspace_id: Mutex::new(Some("ws-1".to_string())),
            pane_id: Mutex::new(Some("pane-1".to_string())),
            spawned_at_unix_ms: 1_700_000_000_000,
            root_pid: 99_999,
            had_user_activity: AtomicBool::new(false),
            input_line_buffer: Mutex::new(String::new()),
            last_user_input: Mutex::new(None),
            last_bind_attempt_ms: std::sync::atomic::AtomicU64::new(0),
            bind_attempts: std::sync::atomic::AtomicU32::new(0),
            cols: std::sync::atomic::AtomicU16::new(100),
            rows: std::sync::atomic::AtomicU16::new(32),
            presentation_live: AtomicBool::new(presentation_live),
            exit_notified: AtomicBool::new(false),
            lifecycle_stop: AtomicBool::new(false),
            suppress_exit_event: AtomicBool::new(false),
            last_output_ms: std::sync::atomic::AtomicU64::new(0),
            last_paint_emit_ms: std::sync::atomic::AtomicU64::new(0),
            paint_flush_armed: AtomicBool::new(false),
        });

        let _unused = std::mem::size_of::<RecordingWriter>();
        (inst, written, exited)
    }

    #[test]
    fn quiesce_provider_terminals_isolates_antigravity_and_preserves_other_providers() {
        let scroll_dir =
            std::env::temp_dir().join(format!("kite-quiesce-iso-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&scroll_dir).unwrap();

        let (agy_direct, agy_written, _) = make_test_terminal(
            "antigravity",
            None,
            "/repo/a",
            Some("conv-old-agy"),
            true,
            b"agy prior output\r\n",
        );
        let (agy_hybrid, hybrid_written, _) = make_test_terminal(
            "powershell",
            Some("agy"),
            "/repo/b",
            Some("conv-old-hybrid"),
            false,
            b"hybrid prior output\r\n",
        );
        let (claude, claude_written, _) = make_test_terminal(
            "claude-code",
            None,
            "/repo/c",
            Some("conv-claude"),
            true,
            b"claude stays\r\n",
        );
        let (codex, codex_written, _) = make_test_terminal(
            "codex",
            None,
            "/repo/d",
            Some("conv-codex"),
            true,
            b"codex stays\r\n",
        );
        let (gemini, gemini_written, _) = make_test_terminal(
            "gemini",
            None,
            "/repo/e",
            Some("conv-gemini"),
            true,
            b"gemini stays\r\n",
        );
        let (plain_ps, ps_written, _) = make_test_terminal(
            "powershell",
            None,
            "/repo/f",
            None,
            true,
            b"ps stays\r\n",
        );

        let terminals_map: Mutex<HashMap<String, Arc<TerminalInstance>>> = Mutex::new(
            [
                ("sess-agy".to_string(), Arc::clone(&agy_direct)),
                ("sess-hybrid".to_string(), Arc::clone(&agy_hybrid)),
                ("sess-claude".to_string(), Arc::clone(&claude)),
                ("sess-codex".to_string(), Arc::clone(&codex)),
                ("sess-gemini".to_string(), Arc::clone(&gemini)),
                ("sess-ps".to_string(), Arc::clone(&plain_ps)),
            ]
            .into_iter()
            .collect(),
        );

        let mut persisted_map = HashMap::new();
        let quiesced = quiesce_provider_terminals_in(
            "antigravity",
            &terminals_map,
            Some(&scroll_dir),
            Some(&mut persisted_map),
        );

        assert_eq!(quiesced.len(), 2);
        let q_ids: HashSet<String> = quiesced.iter().map(|q| q.session_id.clone()).collect();
        assert!(q_ids.contains("sess-agy"));
        assert!(q_ids.contains("sess-hybrid"));

        let remaining = terminals_map.lock().unwrap();
        assert_eq!(remaining.len(), 4);
        assert!(remaining.contains_key("sess-claude"));
        assert!(remaining.contains_key("sess-codex"));
        assert!(remaining.contains_key("sess-gemini"));
        assert!(remaining.contains_key("sess-ps"));

        assert_eq!(*agy_written.lock().unwrap(), b"\x03");
        assert_eq!(*hybrid_written.lock().unwrap(), b"\x03");
        assert!(agy_direct.suppress_exit_event.load(Ordering::Relaxed));
        assert!(agy_direct.lifecycle_stop.load(Ordering::Relaxed));
        assert!(agy_hybrid.suppress_exit_event.load(Ordering::Relaxed));
        assert!(agy_hybrid.lifecycle_stop.load(Ordering::Relaxed));

        assert!(claude_written.lock().unwrap().is_empty());
        assert!(codex_written.lock().unwrap().is_empty());
        assert!(gemini_written.lock().unwrap().is_empty());
        assert!(ps_written.lock().unwrap().is_empty());
        assert!(!claude.suppress_exit_event.load(Ordering::Relaxed));
        assert!(!codex.suppress_exit_event.load(Ordering::Relaxed));
        assert!(!gemini.suppress_exit_event.load(Ordering::Relaxed));
        assert!(!plain_ps.suppress_exit_event.load(Ordering::Relaxed));

        assert_eq!(
            read_scrollback_file_in(Some(&scroll_dir), "sess-agy").as_deref(),
            Some(b"agy prior output\r\n".as_slice())
        );
        assert_eq!(
            read_scrollback_file_in(Some(&scroll_dir), "sess-hybrid").as_deref(),
            Some(b"hybrid prior output\r\n".as_slice())
        );
        assert_eq!(persisted_map["sess-agy"].provider_session_id, None);
        assert_eq!(persisted_map["sess-hybrid"].provider_session_id, None);

        let _ = std::fs::remove_dir_all(&scroll_dir);
    }

    #[test]
    fn respawn_provider_terminals_preserves_scrollback_emits_divider_and_updates_deferred() {
        let scroll_dir =
            std::env::temp_dir().join(format!("kite-respawn-scroll-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&scroll_dir).unwrap();
        write_scrollback_file_in(Some(&scroll_dir), "sess-live", b"before live rotation\r\n");
        write_scrollback_file_in(Some(&scroll_dir), "sess-bg", b"before bg rotation\r\n");

        let quiesced = vec![
            QuiescedTerminal {
                session_id: "sess-live".to_string(),
                cwd: "/repo/live".to_string(),
                base_engine: "antigravity".to_string(),
                effective_engine: "antigravity".to_string(),
                provider_session_id: Some("conv-live-old".to_string()),
                workspace_id: Some("ws-1".to_string()),
                pane_id: Some("pane-1".to_string()),
                cols: 100,
                rows: 30,
                presentation_live: true,
                auto_approve: true,
            },
            QuiescedTerminal {
                session_id: "sess-bg".to_string(),
                cwd: "/repo/bg".to_string(),
                base_engine: "powershell".to_string(),
                effective_engine: "agy".to_string(),
                provider_session_id: Some("conv-bg-old".to_string()),
                workspace_id: Some("ws-1".to_string()),
                pane_id: Some("pane-2".to_string()),
                cols: 100,
                rows: 30,
                presentation_live: false,
                auto_approve: true,
            },
        ];

        let mut persisted_map = HashMap::new();
        persisted_map.insert(
            "sess-live".to_string(),
            PersistedTerminalSession {
                session_id: "sess-live".to_string(),
                workspace_id: Some("ws-1".to_string()),
                pane_id: Some("pane-1".to_string()),
                base_engine: "antigravity".to_string(),
                active_engine: "antigravity".to_string(),
                provider_session_id: Some("conv-live-old".to_string()),
                cwd: "/repo/live".to_string(),
                had_user_activity: true,
                last_user_input: Some("secret".to_string()),
                spawned_at_unix_ms: 100,
                saved_at_unix_ms: 100,
            },
        );
        let deferred_store: Mutex<HashMap<String, DeferredRotation>> = Mutex::new(HashMap::new());
        let mut spawned: Vec<(String, String, String, Option<String>)> = Vec::new();

        respawn_provider_terminals_with(
            "agy",
            "Cuenta Trabajo",
            Some("work@example.com"),
            &quiesced,
            Some(&scroll_dir),
            Some(&mut persisted_map),
            &deferred_store,
            |q, prov, label, email| {
                spawned.push((
                    q.session_id.clone(),
                    prov.to_string(),
                    label.to_string(),
                    email.map(String::from),
                ));
            },
        );

        assert_eq!(spawned.len(), 1);
        assert_eq!(
            spawned[0],
            (
                "sess-live".to_string(),
                "antigravity".to_string(),
                "Cuenta Trabajo".to_string(),
                Some("work@example.com".to_string())
            )
        );
        assert_eq!(persisted_map["sess-live"].provider_session_id, None);
        assert!(!persisted_map["sess-live"].had_user_activity);

        let live_scroll =
            String::from_utf8(read_scrollback_file_in(Some(&scroll_dir), "sess-live").unwrap())
                .unwrap();
        assert!(live_scroll.starts_with("before live rotation\r\n"));
        assert!(live_scroll.contains("─── ✦ Kite Vault: Sesión reactivada con cuenta «Cuenta Trabajo» ───"));

        // Consecutive switch before user focuses deferred background pane must update its target account + divider
        respawn_provider_terminals_with(
            "antigravity",
            "Cuenta Personal",
            Some("personal@example.com"),
            &[],
            Some(&scroll_dir),
            None,
            &deferred_store,
            |q, prov, label, email| {
                spawned.push((
                    q.session_id.clone(),
                    prov.to_string(),
                    label.to_string(),
                    email.map(String::from),
                ));
            },
        );
        assert_eq!(spawned.len(), 1);

        let empty_terminals: Mutex<HashMap<String, Arc<TerminalInstance>>> =
            Mutex::new(HashMap::new());
        let materialized = maybe_respawn_deferred_terminal_with(
            "sess-bg",
            &deferred_store,
            &empty_terminals,
            |q, prov, label, email| {
                spawned.push((
                    q.session_id.clone(),
                    prov.to_string(),
                    label.to_string(),
                    email.map(String::from),
                ));
            },
        );
        assert!(materialized);
        assert_eq!(spawned.len(), 2);
        assert_eq!(
            spawned[1],
            (
                "sess-bg".to_string(),
                "antigravity".to_string(),
                "Cuenta Personal".to_string(),
                Some("personal@example.com".to_string())
            )
        );
        assert!(!maybe_respawn_deferred_terminal_with(
            "sess-bg",
            &deferred_store,
            &empty_terminals,
            |_, _, _, _| {}
        ));

        let bg_scroll =
            String::from_utf8(read_scrollback_file_in(Some(&scroll_dir), "sess-bg").unwrap())
                .unwrap();
        assert!(bg_scroll.starts_with("before bg rotation\r\n"));
        assert!(bg_scroll.contains("─── ✦ Kite Vault: Sesión reactivada con cuenta «Cuenta Trabajo» ───"));
        assert!(bg_scroll.contains("─── ✦ Kite Vault: Sesión reactivada con cuenta «Cuenta Personal» ───"));

        let _ = std::fs::remove_dir_all(&scroll_dir);
    }

    #[test]
    fn plan_rotated_spawn_never_reuses_old_conversation_id_for_antigravity_or_hybrid() {
        let direct_q = QuiescedTerminal {
            session_id: "sess-direct".to_string(),
            cwd: "/repo".to_string(),
            base_engine: "antigravity".to_string(),
            effective_engine: "antigravity".to_string(),
            provider_session_id: Some("old-conv-direct-999".to_string()),
            workspace_id: None,
            pane_id: None,
            cols: 100,
            rows: 30,
            presentation_live: true,
            auto_approve: true,
        };
        let (engine, mode) = plan_rotated_spawn(&direct_q);
        assert_eq!(engine, "antigravity");
        assert!(matches!(
            mode,
            SpawnMode::Agent {
                hybrid_shell_agent: None
            }
        ));
        let (args, bound_id) = build_agent_cli_args_ext(
            &engine,
            &direct_q.session_id,
            &direct_q.cwd,
            &mode,
            None,
            direct_q.auto_approve,
            None,
        );
        assert!(bound_id.is_none());
        assert!(!args.iter().any(|a| a == "--conversation"));
        assert!(!args.iter().any(|a| a == "old-conv-direct-999"));

        // Contrast against SpawnMode::Resume to prove --conversation would be emitted if mode hadn't been Agent
        let (resume_args, _) = build_agent_cli_args_ext(
            &engine,
            &direct_q.session_id,
            &direct_q.cwd,
            &SpawnMode::Resume {
                provider_session_id: Some("old-conv-direct-999".to_string()),
                allow_continue_fallback: true,
                hybrid_shell_agent: None,
            },
            None,
            direct_q.auto_approve,
            None,
        );
        assert!(resume_args.iter().any(|a| a == "--conversation"));
        assert!(resume_args.iter().any(|a| a == "old-conv-direct-999"));

        let hybrid_q = QuiescedTerminal {
            base_engine: "powershell".to_string(),
            effective_engine: "agy".to_string(),
            provider_session_id: Some("old-conv-hybrid-888".to_string()),
            ..direct_q
        };
        let (hyb_engine, hyb_mode) = plan_rotated_spawn(&hybrid_q);
        assert_eq!(hyb_engine, "powershell");
        assert!(matches!(
            hyb_mode,
            SpawnMode::Agent {
                hybrid_shell_agent: Some(ref a)
            } if a == "agy"
        ));
        if let SpawnMode::Agent {
            hybrid_shell_agent: Some(ref inner),
        } = hyb_mode
        {
            let (inner_args, inner_bound) = build_agent_cli_args_ext(
                inner,
                &hybrid_q.session_id,
                &hybrid_q.cwd,
                &SpawnMode::Agent {
                    hybrid_shell_agent: None,
                },
                None,
                hybrid_q.auto_approve,
                None,
            );
            assert!(inner_bound.is_none());
            assert!(!inner_args.iter().any(|a| a == "--conversation"));
            assert!(!inner_args.iter().any(|a| a == "old-conv-hybrid-888"));
        }
    }

    #[test]
    fn classify_session_activity_distinguishes_idle_from_busy() {
        let now = 50_000;
        let idle = classify_session_activity(&SessionActivityInput {
            now_ms: now,
            last_output_ms: now - BUSY_ACTIVITY_WINDOW_MS - 100,
            last_paint_emit_ms: now - BUSY_ACTIVITY_WINDOW_MS - 50,
            output_byte_offset: 120,
            pending_buffer_len: 0,
            child_running: true,
            had_user_activity: true,
        });
        assert!(!idle.0);

        let busy_output = classify_session_activity(&SessionActivityInput {
            now_ms: now,
            last_output_ms: now - 500,
            last_paint_emit_ms: 0,
            output_byte_offset: 120,
            pending_buffer_len: 0,
            child_running: true,
            had_user_activity: true,
        });
        assert!(busy_output.0);
        assert!(busy_output.1.contains(&"recent_output".to_string()));

        let exited_ignores_recent_output = classify_session_activity(&SessionActivityInput {
            now_ms: now,
            last_output_ms: now - 50,
            last_paint_emit_ms: now - 50,
            output_byte_offset: 120,
            pending_buffer_len: 32,
            child_running: false,
            had_user_activity: true,
        });
        assert!(!exited_ignores_recent_output.0);
    }
}
