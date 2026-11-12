use crate::logger::log_trace;
use crate::session_resolver::{
    detect_child_agent_in_shell, is_generic_shell_engine, read_persisted_terminal_sessions,
    resolve_provider_session_id_with_context, write_persisted_terminal_sessions,
    PersistedTerminalSession,
};
use crate::terminal::{
    delete_scrollback_file, get_globally_claimed_provider_ids, get_terminals, now_unix_ms,
    snapshot_scrollback_for_attach, spawn_session_with_options, SpawnMode, SpawnOptions,
    TerminalInstance,
};
use serde::{Deserialize, Serialize};
use std::sync::atomic::Ordering;
use std::sync::Arc;

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

    let mut quiesced = Vec::new();
    let mut pids_to_kill = Vec::new();
    let mut persisted_map = read_persisted_terminal_sessions();
    let now = now_unix_ms();

    for (session_id, inst) in &matching_sessions {
        // 1. Drain in-memory buffer into durable scrollback so zero history is lost
        let _ = snapshot_scrollback_for_attach(session_id, inst, false);

        // 2. Collect child PID
        let mut root_pid: Option<u32> = None;
        if let Ok(child) = inst.child.lock() {
            if let Some(pid) = child.process_id() {
                pids_to_kill.push(pid);
                root_pid = Some(pid);
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

        // Capture and preserve the live conversation/session ID of this terminal
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

        // Persist to disk so that attach_terminal or app restarts know this session belongs to effective_engine
        persisted_map.insert(
            session_id.clone(),
            PersistedTerminalSession {
                session_id: session_id.clone(),
                workspace_id: ws_id.clone(),
                pane_id: p_id.clone(),
                base_engine: inst.engine.clone(),
                active_engine: effective_engine.clone(),
                provider_session_id: prov_id.clone(),
                cwd: cwd.clone(),
                had_user_activity: true,
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
        });
    }

    write_persisted_terminal_sessions(&persisted_map);

    // Terminate child processes to release OS file locks
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
            let _ = child.kill();
        }
    }

    // Yield briefly for OS file handle release
    std::thread::sleep(std::time::Duration::from_millis(30));

    quiesced
}

/// Respawns quiesced terminals with the updated environment and launches the provider agent.
pub fn respawn_provider_terminals(
    provider: &str,
    new_account_label: &str,
    quiesced: &[QuiescedTerminal],
) {
    if crate::core_daemon::is_external_daemon_owner() {
        let params = serde_json::json!({
            "provider": provider,
            "newAccountLabel": new_account_label,
            "quiesced": quiesced,
        });
        if crate::core_daemon::send_core_daemon_rpc("session.respawn_provider", Some(params)).is_ok() {
            return;
        }
    }
    respawn_provider_terminals_local(provider, new_account_label, quiesced);
}

pub fn respawn_provider_terminals_local(
    _provider: &str,
    _new_account_label: &str,
    quiesced: &[QuiescedTerminal],
) {
    if quiesced.is_empty() {
        return;
    }

    for (i, q) in quiesced.iter().enumerate() {
        // Clear stale scrollback so the agent CLI can paint its fresh interactive TUI
        delete_scrollback_file(&q.session_id);

        let is_agent = !is_generic_shell_engine(&q.effective_engine);
        let (engine_to_spawn, mode) = if is_generic_shell_engine(&q.base_engine) && is_agent {
            (
                q.base_engine.clone(),
                SpawnMode::Resume {
                    provider_session_id: q.provider_session_id.clone(),
                    allow_continue_fallback: true,
                    hybrid_shell_agent: Some(q.effective_engine.clone()),
                },
            )
        } else if is_agent {
            (
                q.effective_engine.clone(),
                SpawnMode::Resume {
                    provider_session_id: q.provider_session_id.clone(),
                    allow_continue_fallback: true,
                    hybrid_shell_agent: None,
                },
            )
        } else {
            (
                q.effective_engine.clone(),
                SpawnMode::Fresh,
            )
        };

        spawn_session_with_options(
            &q.session_id,
            &q.cwd,
            &engine_to_spawn,
            SpawnOptions {
                workspace_id: q.workspace_id.clone(),
                pane_id: q.pane_id.clone(),
                cols: q.cols,
                rows: q.rows,
                mode,
                auto_approve: true,
                ..Default::default()
            },
        );

        // Throttle subsequent terminal spawns by 30ms to prevent ConPTY CPU storms
        if i + 1 < quiesced.len() {
            std::thread::sleep(std::time::Duration::from_millis(30));
        }
    }
}
