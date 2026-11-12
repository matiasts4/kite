use uuid::Uuid;
use crate::logger::log_trace;
use crate::session_resolver::{
    canonical_agent_engine, choose_restore_provider_id, claude_session_file_exists,
    get_persisted_terminal_session, is_generic_shell_engine, read_persisted_terminal_sessions,
    remove_persisted_terminal_session, resolve_provider_session_id_with_context,
    restore_grok_provider_id, upsert_persisted_terminal_session_clearing_provider,
    PersistedTerminalSession,
};
use crate::terminal::{
    capture_terminal_lifecycle, delete_scrollback_file, extract_pane_id, extract_workspace_id,
    get_globally_claimed_provider_ids, get_session_resolve_lock, get_terminals,
    is_agent_cli_engine, log_dec2026_timeouts, now_unix_ms, raw_argv_from_request,
    read_scrollback_file, should_proxy_to_core_daemon, snapshot_scrollback_for_attach,
    spawn_session_with_options, to_base64, try_bind_provider_session_id, workspace_cwd,
    write_scrollback_file, SHUTTING_DOWN, SpawnMode, SpawnOptions, TerminalInstance,
};
use portable_pty::PtySize;
use std::io::Write;
use std::sync::atomic::Ordering;
use std::sync::Arc;

fn update_instance_geometry_and_metadata(
    inst: &TerminalInstance,
    workspace_id: Option<&str>,
    pane_id: Option<&str>,
    cols: u16,
    rows: u16,
) {
    if let Some(ws_id) = workspace_id {
        if let Ok(mut w) = inst.workspace_id.lock() {
            if w.is_none() {
                *w = Some(ws_id.to_string());
            }
        }
    }
    if let Some(p_id) = pane_id {
        if let Ok(mut p) = inst.pane_id.lock() {
            if p.is_none() {
                *p = Some(p_id.to_string());
            }
        }
    }
    if cols > 0 && rows > 0 {
        let prev_cols = inst.cols.swap(cols, Ordering::Relaxed);
        let prev_rows = inst.rows.swap(rows, Ordering::Relaxed);
        if prev_cols != cols || prev_rows != rows {
            if let Ok(master) = inst.master.lock() {
                let _ = master.resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                });
            }
            if let Ok(mut vt) = inst.vt_engine.lock() {
                vt.resize(cols, rows);
            }
        }
    }
}

pub fn start_terminal_sync(request: serde_json::Value) -> serde_json::Value {
    let req = request.get("request").unwrap_or(&request);
    let session_id = req
        .get("sessionId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    if should_proxy_to_core_daemon(&session_id) {
        let mut remote = req.clone();
        remote["sessionId"] = serde_json::Value::String(session_id.clone());
        if let Ok(res) = crate::core_daemon::send_core_daemon_rpc("session.create", Some(remote)) {
            let eff_id = res
                .get("sessionId")
                .and_then(|v| v.as_str())
                .unwrap_or(&session_id)
                .to_string();
            let channel_id = res
                .get("channelId")
                .and_then(|v| v.as_u64())
                .map(|v| v as u32);
            let root_pid = res
                .get("rootPid")
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as u32;
            crate::core_daemon::register_client_session_channel(&eff_id, channel_id, root_pid);
            return serde_json::json!({
                "sessionId": eff_id,
                "attachedToExisting": false,
                "scrollbackBase64": serde_json::Value::Null,
                "host": { "backend": "conpty", "buildNumber": 22631 },
                "restore": { "kind": "startedFresh", "reason": "coreDaemon" },
                "rootPid": res.get("rootPid").cloned().unwrap_or(serde_json::Value::Null),
                "spawnedAtUnixMs": res.get("spawnedAtUnixMs").cloned().unwrap_or(serde_json::Value::Null),
                "channelId": res.get("channelId").cloned().unwrap_or(serde_json::Value::Null),
            });
        }
        // The daemon did not answer: fall back to an in-process spawn.
    }
    start_terminal_local_sync(request)
}

pub fn start_terminal_local_sync(request: serde_json::Value) -> serde_json::Value {
    let req = request.get("request").unwrap_or(&request);
    let session_id = req
        .get("sessionId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    let cwd = workspace_cwd(req);
    let workspace_id = extract_workspace_id(req);
    let pane_id = extract_pane_id(req);

    let engine = req
        .get("engine")
        .or_else(|| req.get("owner").and_then(|o| o.get("engine")))
        .and_then(|e| e.as_str())
        .unwrap_or("powershell");

    let cols = req
        .get("columns")
        .or_else(|| req.get("cols"))
        .and_then(|v| v.as_u64())
        .unwrap_or(80) as u16;
    let rows = req.get("rows").and_then(|v| v.as_u64()).unwrap_or(24) as u16;
    let preserve_unread_buffer = req
        .get("preserveUnreadBuffer")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let raw_argv = match raw_argv_from_request(req) {
        Ok(argv) => argv,
        Err(()) => {
            return serde_json::json!({ "error": "program_not_found" });
        }
    };

    let existing_scrollback = {
        let map = get_terminals().lock().unwrap();
        if let Some(inst) = map.get(&session_id) {
            update_instance_geometry_and_metadata(
                inst,
                workspace_id.as_deref(),
                pane_id.as_deref(),
                cols,
                rows,
            );
            let sb = snapshot_scrollback_for_attach(&session_id, inst, preserve_unread_buffer);
            Some((sb, inst.root_pid, inst.spawned_at_unix_ms))
        } else {
            None
        }
    };
    if let Some((sb, root_pid, spawned_at_unix_ms)) = existing_scrollback {
        capture_terminal_lifecycle(
            &session_id,
            true,
            Some(engine),
            "reattached",
            sb.as_ref().map(Vec::len),
        );
        return serde_json::json!({
            "sessionId": session_id,
            "attachedToExisting": true,
            "scrollbackBase64": sb.as_deref().map(to_base64),
            "host": { "backend": "conpty", "buildNumber": 22631 },
            "restore": { "kind": "reattached" },
            "rootPid": root_pid,
            "spawnedAtUnixMs": spawned_at_unix_ms
        });
    }

    let initial_prompt = req
        .get("initialPrompt")
        .or_else(|| req.get("prompt"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let auto_approve = req
        .get("autoApprove")
        .and_then(|v| v.as_bool())
        .unwrap_or_else(|| is_agent_cli_engine(engine));
    let mut system_prompt = req
        .get("systemPrompt")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|text| !text.is_empty());
    if system_prompt.is_none() && crate::dispatch::programs::accepts_system_prompt(engine) {
        system_prompt = Some(crate::dispatch::cli::manual_text().to_string());
    }

    spawn_session_with_options(
        &session_id,
        &cwd,
        engine,
        SpawnOptions {
            cols,
            rows,
            workspace_id,
            pane_id,
            mode: SpawnMode::Fresh,
            initial_prompt,
            auto_approve,
            system_prompt,
            raw_argv,
        },
    );

    let agent_name = req
        .get("agentName")
        .or_else(|| req.get("displayName"))
        .and_then(|v| v.as_str());
    crate::dispatch_wire::register_terminal_session(&session_id, engine, agent_name);

    let disk_scrollback_bytes = read_scrollback_file(&session_id);
    let disk_scrollback = disk_scrollback_bytes.as_deref().map(to_base64);
    capture_terminal_lifecycle(
        &session_id,
        false,
        Some(engine),
        "startedFresh",
        disk_scrollback_bytes.as_ref().map(Vec::len),
    );

    let (root_pid, spawned_at_unix_ms) = get_terminals()
        .lock()
        .ok()
        .and_then(|map| {
            map.get(&session_id)
                .map(|inst| (inst.root_pid, inst.spawned_at_unix_ms))
        })
        .unwrap_or((0, now_unix_ms()));

    serde_json::json!({
        "sessionId": session_id,
        "attachedToExisting": false,
        "scrollbackBase64": disk_scrollback,
        "host": { "backend": "conpty", "buildNumber": 22631 },
        "restore": { "kind": "startedFresh", "reason": "noConversation" },
        "rootPid": root_pid,
        "spawnedAtUnixMs": spawned_at_unix_ms
    })
}

pub fn attach_terminal_sync(request: serde_json::Value) -> serde_json::Value {
    let req = request.get("request").unwrap_or(&request);
    let session_id = req
        .get("sessionId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    if should_proxy_to_core_daemon(&session_id) {
        let mut remote = req.clone();
        remote["sessionId"] = serde_json::Value::String(session_id.clone());
        if let Ok(res) = crate::core_daemon::send_core_daemon_rpc("session.attach_rpc", Some(remote))
        {
            let exited = res
                .get("exited")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let root_pid = res
                .get("rootPid")
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as u32;
            let channel_id = res
                .get("channelId")
                .and_then(|v| v.as_u64())
                .map(|v| v as u32);
            let attached_to_existing = root_pid > 0
                || res
                    .get("attachedToExisting")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
            crate::core_daemon::register_client_session_channel(&session_id, channel_id, root_pid);
            return serde_json::json!({
                "sessionId": session_id,
                "attachedToExisting": attached_to_existing,
                "scrollbackBase64": serde_json::Value::Null,
                "screenSeed": false,
                "channelId": res.get("channelId").cloned().unwrap_or(serde_json::Value::Null),
                "rootPid": res.get("rootPid").cloned().unwrap_or(serde_json::Value::Null),
                "exited": exited,
                "host": { "backend": "conpty", "buildNumber": 22631 },
                "restore": { "kind": if attached_to_existing { "reattached" } else { "restoredFromDisk" } },
            });
        }
        // The daemon did not answer: fall back to a local attach/spawn.
    }
    attach_terminal_local_sync(request)
}

pub fn attach_terminal_local_sync(request: serde_json::Value) -> serde_json::Value {
    let req = request.get("request").unwrap_or(&request);
    let session_id = req
        .get("sessionId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    let workspace_id = extract_workspace_id(req);
    let pane_id = extract_pane_id(req);
    let requested_engine = req
        .get("engine")
        .and_then(|value| value.as_str())
        .filter(|engine| !engine.is_empty());
    let preserve_unread_buffer = req
        .get("preserveUnreadBuffer")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let resync_from_screen = req
        .get("resyncFromScreen")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let req_cols = req
        .get("columns")
        .and_then(|value| value.as_u64())
        .unwrap_or(0) as u16;
    let req_rows = req
        .get("rows")
        .and_then(|value| value.as_u64())
        .unwrap_or(0) as u16;

    let (attached_to_existing, initial_scrollback, screen_seed) = {
        let mut map = get_terminals().lock().unwrap();
        if let Some(inst) = map.get(&session_id) {
            let is_alive = if let Ok(mut child) = inst.child.lock() {
                child.try_wait().ok().flatten().is_none()
            } else {
                true
            };

            if is_alive {
                update_instance_geometry_and_metadata(
                    inst,
                    workspace_id.as_deref(),
                    pane_id.as_deref(),
                    req_cols,
                    req_rows,
                );
                let sb = snapshot_scrollback_for_attach(&session_id, inst, preserve_unread_buffer);
                // A fresh attach or renderer switch must not replay the raw byte tail
                // into the other engine when the session is on the alternate screen:
                // the tail is cut mid-sequence and spans earlier grid sizes. Seed from
                // the live screen and drop the unread tail so the agent's next repaint
                // lands on a matching base.
                let seed = if !preserve_unread_buffer || resync_from_screen {
                    let seed = inst
                        .vt_engine
                        .lock()
                        .ok()
                        .and_then(|vt| vt.alternate_screen_seed());
                    if seed.is_some() {
                        if let Ok(mut unread) = inst.buffer.lock() {
                            unread.clear();
                        }
                    }
                    seed
                } else {
                    None
                };
                (true, sb, seed)
            } else {
                map.remove(&session_id);
                (false, None, None)
            }
        } else {
            (false, None, None)
        }
    };

    let mut scrollback_byte_len = initial_scrollback.as_ref().map(Vec::len);
    let scrollback_base64 = if let Some(seed) = screen_seed.as_deref() {
        scrollback_byte_len = Some(seed.len());
        Some(to_base64(seed))
    } else if attached_to_existing {
        initial_scrollback.as_deref().map(to_base64)
    } else {
        let _resolve_guard = get_session_resolve_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let claimed_ids = get_globally_claimed_provider_ids(&session_id);

        let disk_bytes = read_scrollback_file(&session_id);
        scrollback_byte_len = disk_bytes.as_ref().map(Vec::len);
        let persisted = get_persisted_terminal_session(&session_id);
        let default_cwd = workspace_cwd(req);
        let cwd = persisted
            .as_ref()
            .map(|p| p.cwd.as_str())
            .filter(|dir| !dir.is_empty() && std::path::Path::new(dir).is_dir())
            .unwrap_or(&default_cwd)
            .to_string();

        let requested_engine = req
            .get("engine")
            .and_then(|value| value.as_str())
            .filter(|engine| !engine.is_empty());
        let engine = requested_engine
            .or_else(|| persisted.as_ref().map(|p| p.base_engine.as_str()))
            .filter(|e| !e.is_empty())
            .unwrap_or("powershell")
            .to_string();

        let cols = req
            .get("columns")
            .and_then(|value| value.as_u64())
            .unwrap_or(80) as u16;
        let rows = req
            .get("rows")
            .and_then(|value| value.as_u64())
            .unwrap_or(24) as u16;

        let is_generic_shell = is_generic_shell_engine(&engine)
            || persisted
                .as_ref()
                .map(|p| is_generic_shell_engine(&p.base_engine))
                .unwrap_or(false);

        // Determine if we should spawn in Resume mode (either from persisted session record or existing scrollback)
        let mode = if let Some(ref saved) = persisted {
            let saved_provider_id = saved.provider_session_id.as_deref();
            if saved_provider_id.is_some_and(|id| !id.trim().is_empty() && claimed_ids.contains(id))
            {
                log_trace(&format!(
                    "attach_terminal: saved provider session {} for terminal {} is already claimed; opening this pane fresh",
                    saved_provider_id.unwrap_or(""),
                    session_id
                ));
            }
            let resolved_provider_id = if canonical_agent_engine(&engine) == "grok"
                || canonical_agent_engine(&saved.active_engine) == "grok"
            {
                restore_grok_provider_id(
                    saved_provider_id,
                    &claimed_ids,
                    &cwd,
                    &session_id,
                    saved.spawned_at_unix_ms,
                    saved.last_user_input.as_deref(),
                )
            } else {
                choose_restore_provider_id(saved_provider_id, &claimed_ids)
            };

            // For generic shell terminals (PowerShell, Terminal, CMD), we ONLY resume an agent
            // if there was an explicitly verified provider session previously bound to this session.
            // Plain shell terminals (e.g. running npm run dev) must NEVER be hijacked by codex or any other agent.
            let hybrid_shell_agent = if is_generic_shell
                && !is_generic_shell_engine(&saved.active_engine)
                && resolved_provider_id.is_some()
            {
                Some(saved.active_engine.clone())
            } else {
                None
            };

            if is_generic_shell && hybrid_shell_agent.is_none() {
                // Self-heal corrupted persisted sessions where active_engine was falsely set to an agent
                if !is_generic_shell_engine(&saved.active_engine) {
                    upsert_persisted_terminal_session_clearing_provider(PersistedTerminalSession {
                        session_id: session_id.clone(),
                        workspace_id: saved.workspace_id.clone(),
                        pane_id: saved.pane_id.clone(),
                        base_engine: engine.clone(),
                        active_engine: engine.clone(),
                        provider_session_id: None,
                        cwd: cwd.clone(),
                        had_user_activity: saved.had_user_activity,
                        last_user_input: saved.last_user_input.clone(),
                        spawned_at_unix_ms: saved.spawned_at_unix_ms,
                        saved_at_unix_ms: now_unix_ms(),
                    });
                }
                SpawnMode::Fresh
            } else {
                SpawnMode::Resume {
                    provider_session_id: resolved_provider_id.clone(),
                    allow_continue_fallback: resolved_provider_id.is_some()
                        && saved.had_user_activity,
                    hybrid_shell_agent,
                }
            }
        } else {
            SpawnMode::Fresh
        };

        let is_agent_cli_restore = match &mode {
            SpawnMode::Resume { hybrid_shell_agent, .. } => {
                !is_generic_shell || hybrid_shell_agent.is_some()
            }
            SpawnMode::Fresh => !is_generic_shell,
        };

        // For AI agent CLIs (agy, claude, codex, opencode), the CLI renders its own TUI upon
        // spawning/resuming. Clear the pre-restart .scrollback file after resolving the session ID
        // so the old TUI screen is not concatenated with the newly spawned TUI screen.
        if is_agent_cli_restore {
            delete_scrollback_file(&session_id);
        }

        let resolved_ws_id = workspace_id
            .or_else(|| persisted.as_ref().and_then(|p| p.workspace_id.clone()));
        let resolved_pane_id = pane_id
            .or_else(|| persisted.as_ref().and_then(|p| p.pane_id.clone()));

        let auto_approve = req
            .get("autoApprove")
            .and_then(|v| v.as_bool())
            .unwrap_or_else(|| is_agent_cli_engine(&engine));

        spawn_session_with_options(
            &session_id,
            &cwd,
            &engine,
            SpawnOptions {
                cols,
                rows,
                workspace_id: resolved_ws_id,
                pane_id: resolved_pane_id,
                mode,
                auto_approve,
                ..Default::default()
            },
        );

        if is_agent_cli_restore {
            None
        } else {
            disk_bytes.as_deref().map(to_base64)
        }
    };

    capture_terminal_lifecycle(
        &session_id,
        attached_to_existing,
        requested_engine,
        if attached_to_existing {
            "reattached"
        } else {
            "restoredFromDisk"
        },
        scrollback_byte_len,
    );

    serde_json::json!({
        "sessionId": session_id,
        "attachedToExisting": attached_to_existing,
        "scrollbackBase64": scrollback_base64,
        "screenSeed": screen_seed.is_some(),
        "host": { "backend": "conpty", "buildNumber": 22631 },
        "restore": { "kind": if attached_to_existing { "reattached" } else { "restoredFromDisk" } }
    })
}

pub fn read_terminal_output_sync(request: serde_json::Value) -> serde_json::Value {
    let req = request.get("request").unwrap_or(&request);
    let session_id = req.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
    if should_proxy_to_core_daemon(session_id) {
        if let Ok(res) =
            crate::core_daemon::send_core_daemon_rpc("session.read_output", Some(req.clone()))
        {
            return res;
        }
    }
    read_terminal_output_local_sync(request)
}

pub fn read_terminal_output_local_sync(request: serde_json::Value) -> serde_json::Value {
    let req = request.get("request").unwrap_or(&request);
    let session_id = req.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
    let instance = {
        let map = get_terminals().lock().unwrap();
        map.get(session_id).cloned()
    };

    if let Some(inst) = instance {
        let mut bytes = Vec::new();
        if let Ok(mut buf) = inst.buffer.lock() {
            if !buf.is_empty() {
                bytes = std::mem::take(&mut *buf);
            }
        }

        let now = now_unix_ms();

        if !bytes.is_empty() {
            let seq = inst.sequence.load(Ordering::Relaxed);
            return serde_json::json!({
                "kind": "output",
                "sequence": seq,
                "bytesBase64": to_base64(&bytes),
                "turnStartedAtUnixMs": now,
                "waitingForInput": false
            });
        }

        if let Ok(mut child) = inst.child.lock() {
            if let Ok(Some(status)) = child.try_wait() {
                return serde_json::json!({
                    "kind": "exited",
                    "status": {
                        "code": status.exit_code() as i64,
                        "signal": serde_json::Value::Null
                    }
                });
            }
        }

        return serde_json::json!({
            "kind": "idle",
            "turnStartedAtUnixMs": now,
            "waitingForInput": true
        });
    }

    serde_json::json!({
        "kind": "idle",
        "turnStartedAtUnixMs": 0,
        "waitingForInput": true
    })
}

pub fn write_terminal_sync(request: serde_json::Value) -> serde_json::Value {
    let req = request.get("request").unwrap_or(&request);
    let session_id = req.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
    let input = req.get("input").and_then(|v| v.as_str()).unwrap_or("");
    if should_proxy_to_core_daemon(session_id) {
        if crate::core_daemon::send_client_session_data(session_id, input.as_bytes()) {
            return serde_json::json!({ "ok": true });
        }
        if let Ok(res) = crate::core_daemon::send_core_daemon_rpc("session.write", Some(req.clone()))
        {
            return res;
        }
    }
    write_terminal_local_sync(request)
}

pub fn write_terminal_local_sync(request: serde_json::Value) -> serde_json::Value {
    let req = request.get("request").unwrap_or(&request);
    let session_id = req.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
    let input = req.get("input").and_then(|v| v.as_str()).unwrap_or("");

    let instance = {
        let map = get_terminals().lock().unwrap();
        map.get(session_id).cloned()
    };

    let mut wrote_ok = false;
    if let Some(inst) = instance {
        let mut submitted_line = false;
        if !input.is_empty() {
            if let Ok(mut vt) = inst.vt_engine.lock() {
                vt.reset_scrollback();
            }
            inst.had_user_activity.store(true, Ordering::Relaxed);
            if let Ok(mut line_buf) = inst.input_line_buffer.lock() {
                for ch in input.chars() {
                    if ch == '\r' || ch == '\n' {
                        submitted_line = true;
                        let trimmed = line_buf.trim().to_string();
                        if trimmed.len() >= 2 && !trimmed.starts_with('\x1b') {
                            if let Ok(mut last) = inst.last_user_input.lock() {
                                *last = Some(trimmed);
                            }
                        }
                        line_buf.clear();
                    } else if ch == '\x08' || ch == '\x7f' {
                        let _ = line_buf.pop();
                    } else if !ch.is_control() && line_buf.len() < 4096 {
                        line_buf.push(ch);
                    }
                }
            }
        }
        let wrote = if let Ok(mut writer) = inst.writer.lock() {
            let _ = writer.write_all(input.as_bytes());
            let _ = writer.flush();
            true
        } else {
            false
        };
        wrote_ok = wrote;
        if wrote
            && (input.contains('\n') || input.contains('\r') || input.contains("\u{1b}[200~"))
        {
            crate::dispatch::trace::record(&crate::dispatch::trace::handoff_event(
                "pty",
                input,
                crate::dispatch::trace::Fields {
                    op: "pty-write",
                    session: session_id,
                    engine: &inst.engine,
                    status: "",
                    pane: "",
                    writes: 1,
                    launcher: "",
                    manual: "none",
                },
            ));
        }

        if submitted_line {
            let needs_bind = inst
                .provider_session_id
                .lock()
                .ok()
                .and_then(|p| p.clone())
                .is_none();
            if needs_bind {
                inst.bind_attempts.store(0, Ordering::Relaxed);
                let sid = session_id.to_string();
                let inst_clone = Arc::clone(&inst);
                std::thread::spawn(move || {
                    // Retry binding across progressive intervals as the CLI creates its lock/transcript
                    for delay_ms in [350_u64, 900, 2000, 4000] {
                        std::thread::sleep(std::time::Duration::from_millis(delay_ms));
                        if try_bind_provider_session_id(&sid, &inst_clone).is_some() {
                            break;
                        }
                    }
                });
            }
        }
    } else {
        return serde_json::json!({ "ok": false, "error": "Session not found" });
    }

    if wrote_ok {
        serde_json::json!({ "ok": true })
    } else {
        serde_json::json!({ "ok": false, "error": "Terminal writer unavailable" })
    }
}

pub fn resize_terminal_sync(request: serde_json::Value) -> serde_json::Value {
    let req = request.get("request").unwrap_or(&request);
    let session_id = req.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
    let cols = req.get("columns").and_then(|v| v.as_u64()).unwrap_or(80) as u16;
    let rows = req.get("rows").and_then(|v| v.as_u64()).unwrap_or(24) as u16;
    if should_proxy_to_core_daemon(session_id) {
        if crate::core_daemon::send_client_session_resize(session_id, cols, rows) {
            return serde_json::json!({ "ok": true, "columns": cols, "rows": rows });
        }
        if let Ok(res) =
            crate::core_daemon::send_core_daemon_rpc("session.resize", Some(req.clone()))
        {
            return res;
        }
    }
    resize_terminal_local_sync(request)
}

pub fn resize_terminal_local_sync(request: serde_json::Value) -> serde_json::Value {
    let req = request.get("request").unwrap_or(&request);
    let session_id = req.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
    let cols = req.get("columns").and_then(|v| v.as_u64()).unwrap_or(80) as u16;
    let rows = req.get("rows").and_then(|v| v.as_u64()).unwrap_or(24) as u16;
    let force = req.get("force").and_then(|v| v.as_bool()).unwrap_or(false);

    let instance = {
        let map = get_terminals().lock().unwrap();
        map.get(session_id).cloned()
    };

    let Some(inst) = instance else {
        return serde_json::json!({ "ok": false, "error": "Session not found" });
    };

    {
        let prev_cols = inst.cols.swap(cols, Ordering::Relaxed);
        let prev_rows = inst.rows.swap(rows, Ordering::Relaxed);
        if force || prev_cols != cols || prev_rows != rows {
            let _ = inst.master.lock().unwrap().resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            });
            let mut pending_replies = Vec::new();
            let mut alt_screen = false;
            let mut timeout_notes = Vec::new();
            if let Ok(mut vt) = inst.vt_engine.lock() {
                alt_screen = vt.alternate_screen();
                vt.resize(cols, rows);
                timeout_notes = vt.take_dec2026_timeouts();
                if vt.is_canvas_active() {
                    pending_replies = vt.take_replies();
                }
            }
            log_trace(&format!(
                "resize_terminal: session_id={session_id}, from={prev_cols}x{prev_rows}, to={cols}x{rows}, alt_screen={alt_screen}"
            ));
            log_dec2026_timeouts(session_id, timeout_notes);
            if !pending_replies.is_empty() {
                if let Ok(mut w) = inst.writer.lock() {
                    let _ = w.write_all(&pending_replies);
                    let _ = w.flush();
                }
            }
        }
    }

    serde_json::json!({ "ok": true, "columns": cols, "rows": rows })
}

/// Bytes GhostGrid has not yet handed to the agent registry.
///
/// The DOM surface drains this buffer through `read_terminal_output`. GhostGrid
/// never calls that command, so the snapshot poll takes the same chunks and
/// returns them as `observedBytesBase64`. The scrollback copy stays intact.


/// Flushes scrollback and persists `terminal-sessions.json` for every live
/// terminal without terminating any child process and without latching
/// `SHUTTING_DOWN`, so the background core survives a GUI window close (S4).

pub fn terminate_terminal_sync(request: serde_json::Value) -> serde_json::Value {
    let req = request.get("request").unwrap_or(&request);
    let session_id = req.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
    if should_proxy_to_core_daemon(session_id) {
        crate::core_daemon::unregister_client_session(session_id);
        if let Ok(res) =
            crate::core_daemon::send_core_daemon_rpc("session.terminate", Some(req.clone()))
        {
            return res;
        }
    }
    terminate_terminal_local_sync(request)
}

pub fn terminate_terminal_local_sync(request: serde_json::Value) -> serde_json::Value {
    let req = request.get("request").unwrap_or(&request);
    let session_id = req.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
    let preserve_state = req
        .get("preserveState")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
        || SHUTTING_DOWN.load(Ordering::SeqCst);

    let instance = {
        let mut map = get_terminals().lock().unwrap();
        map.remove(session_id)
    };
    // Callers must know whether a live session actually existed; an idempotent
    // second close must not be reported as a successful termination.
    let existed = instance.is_some();

    if let Some(inst) = instance {
        inst.lifecycle_stop.store(true, Ordering::Relaxed);
        if preserve_state {
            if let Ok(sb) = inst.scrollback.lock() {
                if !sb.is_empty() {
                    write_scrollback_file(session_id, &sb);
                }
            }
        }
        std::thread::spawn(move || {
            if let Ok(mut child) = inst.child.lock() {
                #[cfg(windows)]
                if let Some(pid) = child.process_id() {
                    let pid_str = pid.to_string();
                    let _ = crate::hidden_exec::run(
                        std::path::Path::new("taskkill.exe"),
                        &["/F", "/T", "/PID", &pid_str],
                        std::time::Duration::from_secs(5),
                    );
                }
                let _ = child.kill();
            }
        });
    }

    if !session_id.is_empty() && !preserve_state {
        delete_scrollback_file(session_id);
        remove_persisted_terminal_session(session_id);
    }

    serde_json::json!({ "terminated": existed, "sessionId": session_id })
}

