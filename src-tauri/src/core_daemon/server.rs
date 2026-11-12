use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::core_wire::{
    decode_credit_payload, decode_focus_payload, decode_resize_payload, decode_rpc_payload,
    encode_close_frame, encode_facts_frame, encode_rpc_frame, ChannelAttachMode, Frame, FrameKind,
    FrameStreamDecoder,
};
use crate::logger::log_trace;
use crate::terminal::get_terminals;

use super::client::send_core_daemon_rpc;
use super::credits::{
    attached_channel, clear_in_process_channels, daemon_activity_notify, daemon_shutdown_notify,
    daemon_ui_event_tx, grant_session_snapshot_credit, is_external_daemon_owner,
    AttachedChannelState,
};
use super::pipe::{
    child_exit_state, get_core_pipe_name, get_or_create_core_token, session_facts,
    CoreHandshakeRequest, CoreHandshakeResponse, LiveSessionSummary, CORE_PROTOCOL_VERSION,
    CORE_VERSION,
};

static CORE_DAEMON_RUNNING: AtomicBool = AtomicBool::new(false);
static NEXT_CHANNEL_ID: AtomicU32 = AtomicU32::new(1);

/// Handles JSON-RPC 2.0 requests arriving on Channel 0.
pub fn handle_control_rpc_request(
    method: &str,
    params: Option<Value>,
    attached_channels: &mut HashMap<u32, AttachedChannelState>,
) -> Result<Value, String> {
    match method {
        "session.create" => {
            let p = params.unwrap_or_else(|| json!({}));
            let session_id = p
                .get("sessionId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let effective_id = if session_id.is_empty() {
                format!("term-{}", uuid::Uuid::new_v4())
            } else {
                session_id
            };

            let mut start_payload = p.clone();
            start_payload["sessionId"] = json!(effective_id);

            let res = crate::terminal::start_terminal_local_sync(start_payload);
            if res.get("error").is_some() {
                return Err(res["error"].as_str().unwrap_or("Failed to start terminal").to_string());
            }

            let channel_id = NEXT_CHANNEL_ID.fetch_add(1, Ordering::SeqCst);
            attached_channels.insert(
                channel_id,
                attached_channel(
                    channel_id,
                    effective_id.clone(),
                    crate::core_wire::ChannelCreditTracker::new(channel_id, ChannelAttachMode::SnapshotBin),
                ),
            );

            let root_pid = res.get("rootPid").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            let spawned_at = res.get("spawnedAtUnixMs").and_then(|v| v.as_i64()).unwrap_or_else(|| {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as i64
            });

            Ok(json!({
                "sessionId": effective_id,
                "channelId": channel_id,
                "rootPid": root_pid,
                "spawnedAtUnixMs": spawned_at,
            }))
        }

        "session.attach" => {
            let p = params.unwrap_or_else(|| json!({}));
            let session_id = p
                .get("sessionId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "Missing sessionId in session.attach".to_string())?
                .to_string();

            let mode_str = p.get("mode").and_then(|v| v.as_str()).unwrap_or("snapshot_bin");
            let mode = if mode_str == "raw" {
                ChannelAttachMode::RawData
            } else {
                ChannelAttachMode::SnapshotBin
            };

            let inst = {
                let map = get_terminals().lock().unwrap();
                map.get(&session_id).cloned()
            };

            let Some(inst) = inst else {
                return Err(format!("Session {} not found in active terminals", session_id));
            };

            let live = p.get("live").and_then(|v| v.as_bool()).unwrap_or(true);
            inst.presentation_live.store(live, Ordering::SeqCst);

            let (exited, exit_code) = child_exit_state(&inst);
            let root_pid = inst.root_pid;
            let channel_id = NEXT_CHANNEL_ID.fetch_add(1, Ordering::SeqCst);

            attached_channels.insert(
                channel_id,
                attached_channel(
                    channel_id,
                    session_id.clone(),
                    crate::core_wire::ChannelCreditTracker::new(channel_id, mode),
                ),
            );

            let facts = session_facts(&inst);

            Ok(json!({
                "sessionId": session_id,
                "channelId": channel_id,
                "rootPid": root_pid,
                "exited": exited,
                "exitCode": exit_code,
                "facts": facts,
            }))
        }

        "session.write" => {
            let p = params.unwrap_or_else(|| json!({}));
            Ok(crate::terminal::write_terminal_local_sync(p))
        }

        "session.resize" => {
            let p = params.unwrap_or_else(|| json!({}));
            Ok(crate::terminal::resize_terminal_local_sync(p))
        }

        "session.poll_snapshot" => {
            let p = params.unwrap_or_else(|| json!({}));
            Ok(crate::terminal::poll_terminal_snapshot_local_sync(p))
        }

        "session.poll_snapshot_bin" => {
            let p = params.unwrap_or_else(|| json!({}));
            let session_id = p
                .get("sessionId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let since_seq = p.get("sinceSeq").and_then(|v| v.as_u64());
            let bytes = crate::terminal::poll_terminal_snapshot_bin_local_bytes(
                &session_id, since_seq,
            );
            Ok(json!({ "bytesBase64": crate::terminal::to_base64(&bytes) }))
        }

        "session.attach_rpc" => {
            let p = params.unwrap_or_else(|| json!({}));
            let session_id = p
                .get("sessionId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let mut combined = crate::terminal::attach_terminal_local_sync(p);
            let channel_id = NEXT_CHANNEL_ID.fetch_add(1, Ordering::SeqCst);
            combined["channelId"] = json!(channel_id);
            attached_channels.insert(
                channel_id,
                attached_channel(
                    channel_id,
                    session_id,
                    crate::core_wire::ChannelCreditTracker::new(channel_id, ChannelAttachMode::SnapshotBin),
                ),
            );
            Ok(combined)
        }

        "session.detach" => {
            let p = params.unwrap_or_else(|| json!({}));
            if p.get("all").and_then(|v| v.as_bool()) == Some(true) {
                attached_channels.clear();
            } else if let Some(ch) = p.get("channelId").and_then(|v| v.as_u64()) {
                attached_channels.remove(&(ch as u32));
            } else if let Some(sid) = p.get("sessionId").and_then(|v| v.as_str()) {
                attached_channels.retain(|_, v| v.session_id != sid);
            }
            Ok(json!({ "detached": true }))
        }

        "session.list" => {
            let mut list: Vec<LiveSessionSummary> = Vec::new();
            if let Ok(map) = get_terminals().lock() {
                for (sid, inst) in map.iter() {
                    let (exited, exit_code) = child_exit_state(inst);
                    let cols = inst.cols.load(Ordering::Relaxed);
                    let rows = inst.rows.load(Ordering::Relaxed);
                    let ch_id = attached_channels
                        .iter()
                        .find(|(_, state)| state.session_id == *sid)
                        .map(|(k, _)| *k);

                    list.push(LiveSessionSummary {
                        session_id: sid.clone(),
                        channel_id: ch_id,
                        workspace_id: inst.workspace_id.lock().ok().and_then(|w| w.clone()),
                        pane_id: inst.pane_id.lock().ok().and_then(|p| p.clone()),
                        engine: inst.engine.clone(),
                        cwd: inst.cwd.clone(),
                        root_pid: inst.root_pid,
                        cols,
                        rows,
                        exited,
                        exit_code,
                        spawned_at_unix_ms: inst.spawned_at_unix_ms,
                    });
                }
            }
            Ok(json!({ "sessions": list }))
        }

        "session.terminate" => {
            let p = params.unwrap_or_else(|| json!({}));
            let session_id = p
                .get("sessionId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            // An idempotent second close must not be reported as a termination.
            let (existed, exit_code) = {
                let map = get_terminals().lock().ok();
                match map.as_ref().and_then(|map| map.get(&session_id).cloned()) {
                    Some(inst) => {
                        let (exited, code) = child_exit_state(&inst);
                        (true, if exited { code } else { None })
                    }
                    None => (false, None),
                }
            };
            if existed {
                let _ = crate::terminal::terminate_terminal_local_sync(p);
            }
            attached_channels.retain(|_, v| v.session_id != session_id);
            Ok(json!({ "terminated": existed, "exitCode": exit_code }))
        }

        "session.scroll_viewport" => {
            let p = params.unwrap_or_else(|| json!({}));
            let snapshot = crate::terminal::scroll_terminal_viewport_local_sync(p)?;
            serde_json::to_value(snapshot).map_err(|err| err.to_string())
        }

        "session.scroll_viewport_bin" => {
            let p = params.unwrap_or_else(|| json!({}));
            let bytes = crate::terminal::scroll_terminal_viewport_bin_local_bytes(p);
            Ok(json!({ "bytesBase64": crate::terminal::to_base64(&bytes) }))
        }

        "session.find_text" => {
            let p = params.unwrap_or_else(|| json!({}));
            crate::terminal::find_terminal_text_local_sync(p)
        }

        "session.get_selection_text" => {
            let p = params.unwrap_or_else(|| json!({}));
            crate::terminal::get_terminal_selection_text_local_sync(p)
        }

        "session.clear_vt" => {
            let p = params.unwrap_or_else(|| json!({}));
            Ok(crate::terminal::clear_terminal_vt_local_sync(p))
        }

        "session.set_presentation" => {
            let p = params.unwrap_or_else(|| json!({}));
            Ok(crate::terminal::set_terminal_presentation_local_sync(p))
        }

        "session.report_agent_detected" => {
            let p = params.unwrap_or_else(|| json!({}));
            Ok(crate::terminal::report_terminal_agent_detected_local(p))
        }

        "session.dump_diagnostics" => {
            let p = params.unwrap_or_else(|| json!({}));
            let path = crate::terminal::dump_terminal_diagnostics_local_sync(p)?;
            Ok(json!({ "path": path }))
        }

        "session.recent_text" => {
            let p = params.unwrap_or_else(|| json!({}));
            let session_id = p.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
            Ok(json!({ "text": crate::terminal::terminal_recent_text_local(session_id) }))
        }

        "session.read_output" => {
            let p = params.unwrap_or_else(|| json!({}));
            Ok(crate::terminal::read_terminal_output_local_sync(p))
        }

        "session.restart_autopilot" => {
            let p = params.unwrap_or_else(|| json!({}));
            Ok(crate::terminal::restart_agent_terminal_for_autopilot_local_sync(p))
        }

        "session.inspect_provider" => {
            let p = params.unwrap_or_else(|| json!({}));
            let provider = p.get("provider").and_then(|v| v.as_str()).unwrap_or("");
            let report = crate::terminal::inspect_provider_sessions_local(provider);
            serde_json::to_value(report).map_err(|e| e.to_string())
        }

        "session.quiesce_provider" => {
            let p = params.unwrap_or_else(|| json!({}));
            let provider = p.get("provider").and_then(|v| v.as_str()).unwrap_or("");
            let list = crate::terminal::quiesce_provider_terminals_local(provider);
            serde_json::to_value(list).map_err(|e| e.to_string())
        }

        "session.respawn_provider" => {
            let p = params.unwrap_or_else(|| json!({}));
            let provider = p.get("provider").and_then(|v| v.as_str()).unwrap_or("");
            let label = p.get("newAccountLabel").and_then(|v| v.as_str()).unwrap_or("");
            let email = p.get("newEmail").and_then(|v| v.as_str());
            let quiesced: Vec<crate::terminal::QuiescedTerminal> = p
                .get("quiesced")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();
            crate::terminal::respawn_provider_terminals_local(provider, label, email, &quiesced);
            Ok(json!({ "ok": true }))
        }

        "core.status" => {
            let active = get_terminals().lock().map(|m| m.len()).unwrap_or(0);
            let plane = crate::terminal::get_terminal_data_plane_local_snapshot();
            Ok(json!({
                "protocol": CORE_PROTOCOL_VERSION,
                "coreVersion": CORE_VERSION,
                "corePid": std::process::id(),
                "activeSessions": active,
                "dataPlane": serde_json::to_value(plane).unwrap_or(json!({})),
            }))
        }

        "agent.dispatch" => {
            let p = params.unwrap_or_else(|| json!({}));
            let result = if p.get("argv").is_some() {
                // CLI envelope: the daemon parses argv exactly like the loopback
                // endpoint so both transports share one dispatch path.
                crate::dispatch_wire::execute_argv_envelope(&p)
            } else {
                let action = p.get("action").and_then(|v| v.as_str()).unwrap_or("send");
                match action {
                    "send" => crate::dispatch_wire::dispatch_send(Some(p.clone())),
                    "publish" => crate::dispatch_wire::dispatch_publish(Some(p.clone())),
                    "osc" => crate::dispatch_wire::dispatch_osc(Some(p.clone())),
                    "ls" => crate::dispatch_wire::dispatch_ls(Some(p.clone())),
                    "run" => crate::dispatch_wire::dispatch_run(Some(p.clone())),
                    "wait" => crate::dispatch_wire::dispatch_wait(Some(p.clone())),
                    "read" => crate::dispatch_wire::dispatch_read(Some(p.clone())),
                    "report" => crate::dispatch_wire::dispatch_report(Some(p.clone())),
                    "skill" => crate::dispatch_wire::dispatch_skill(),
                    "pane_shown" => crate::dispatch_wire::dispatch_pane_shown(Some(p.clone())),
                    "kill" => crate::dispatch_wire::dispatch_kill(Some(p.clone())),
                    "interrupt" => crate::dispatch_wire::dispatch_interrupt(Some(p.clone())),
                    "keys" => crate::dispatch_wire::dispatch_keys(Some(p.clone())),
                    "attach" => crate::dispatch_wire::dispatch_attach(Some(p.clone())),
                    _ => json!({ "error": format!("Unknown agent dispatch action: {}", action) }),
                }
            };
            record_agent_dispatch(&p, &result);
            Ok(result)
        }

        "core.shutdown" => {
            log_trace("core.shutdown requested: snapshotting and terminating all background terminals");
            crate::terminal::snapshot_and_shutdown_all_terminals("core_shutdown");
            CORE_DAEMON_RUNNING.store(false, Ordering::SeqCst);
            // Wake the accept loop so the daemon exits immediately instead of
            // waiting for the next client connection.
            daemon_shutdown_notify().notify_one();
            Ok(json!({ "shuttingDown": true }))
        }

        unknown => Err(format!("Unknown JSON-RPC method: {}", unknown)),
    }
}

/// Mirrors a daemon-owned dispatch into the on-disk agent inbox so state
/// survives a GUI that is closed (S5).
fn record_agent_dispatch(params: &Value, result: &Value) {
    let cwd = params
        .get("cwd")
        .or_else(|| params.get("workspace"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let id = params.get("id").and_then(|v| v.as_str()).unwrap_or("");
    if cwd.is_empty() || id.is_empty() {
        return;
    }

    let failed = result.get("error").is_some()
        || result
            .get("exit")
            .and_then(|v| v.as_i64())
            .is_some_and(|code| code != 0);
    let action = params
        .get("action")
        .and_then(|v| v.as_str())
        .unwrap_or("argv");
    let session_id = params
        .get("sessionId")
        .or_else(|| params.get("address"))
        .and_then(|v| v.as_str());
    let mut entry = json!({
        "cwd": cwd,
        "id": id,
        "ok": !failed,
        "message": format!("kite-core agent.dispatch {}", action),
        "agentName": "kite-core",
    });
    if let Some(session_id) = session_id {
        entry["sessionId"] = json!(session_id);
    }
    let recorded = crate::agent_inbox::complete_agent_inbox(entry);
    if let Some(error) = recorded.get("error").and_then(|v| v.as_str()) {
        log_trace(&format!("agent.dispatch inbox record failed: {}", error));
    }
}

/// Invoked when the desktop GUI window is closed (X / Alt+F4).
///
/// Flushes scrollback, drops every in-process channel view, and restores audio
/// ducking, but never terminates the live PTYs or autonomous agents (S4).
pub fn on_client_window_close() {
    log_trace("Client desktop window closed: keeping kite-core and active agent terminals running in background");
    // A detached core owns the channels: detach this GUI client without killing
    // a single PTY or autonomous agent (S4).
    if is_external_daemon_owner() {
        let _ = send_core_daemon_rpc("session.detach", Some(json!({ "all": true })));
    }
    crate::terminal::flush_all_terminal_scrollbacks();
    clear_in_process_channels();
    // Ensure audio ducking is restored immediately
    crate::audio_ducking::restore_audio_immediate();
    // Do NOT call snapshot_and_shutdown_all_terminals!
}

/// Starts the standalone daemon server event loop on this build's pipe.
pub fn run_core_daemon_main() {
    CORE_DAEMON_RUNNING.store(true, Ordering::SeqCst);
    // Loopback agent dispatch lives inside the daemon so an external script can
    // dispatch while no GUI window is open (S5).
    crate::dispatch_wire::start_background();
    let pipe_path = get_core_pipe_name();
    let token = get_or_create_core_token();

    log_trace(&format!(
        "Starting kite-core daemon v{} (PID: {}) on {}",
        CORE_VERSION,
        std::process::id(),
        pipe_path
    ));

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("Failed to build tokio runtime for kite-core");

    rt.block_on(async move {
        #[cfg(windows)]
        {
            use tokio::net::windows::named_pipe::ServerOptions;

            while CORE_DAEMON_RUNNING.load(Ordering::SeqCst) {
                let server = match ServerOptions::new()
                    .first_pipe_instance(false)
                    .create(&pipe_path)
                {
                    Ok(s) => s,
                    Err(e) => {
                        log_trace(&format!("Failed to create named pipe {}: {}", pipe_path, e));
                        tokio::time::sleep(Duration::from_millis(250)).await;
                        continue;
                    }
                };

                let connected = tokio::select! {
                    _ = daemon_shutdown_notify().notified() => None,
                    result = server.connect() => Some(result),
                };

                match connected {
                    None => break,
                    Some(Ok(())) => {
                        tokio::spawn(handle_stream_client(server, token.clone()));
                    }
                    Some(Err(e)) => {
                        log_trace(&format!("Pipe connect failed: {}", e));
                    }
                }
            }
        }

        #[cfg(not(windows))]
        {
            use tokio::net::UnixListener;
            let _ = std::fs::remove_file(&pipe_path);
            let listener = UnixListener::bind(&pipe_path).expect("Failed to bind Unix socket");
            while CORE_DAEMON_RUNNING.load(Ordering::SeqCst) {
                tokio::select! {
                    _ = daemon_shutdown_notify().notified() => break,
                    accepted = listener.accept() => {
                        if let Ok((stream, _)) = accepted {
                            tokio::spawn(handle_stream_client(stream, token.clone()));
                        }
                    }
                }
            }
        }
    });

    log_trace("kite-core daemon event loop terminated");
}

/// Full handshake plus 9-byte framed multiplexed server loop.
///
/// Generic over the transport so the Windows named pipe, the Unix socket, and
/// in-memory `tokio::io::duplex` tests all run the exact same protocol logic.
pub(crate) async fn handle_stream_client<S>(stream: S, expected_token: String)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (reader, mut writer) = tokio::io::split(stream);
    let mut buf_reader = tokio::io::BufReader::new(reader);

    // 1. Handshake line
    let mut handshake_line = String::new();
    match buf_reader.read_line(&mut handshake_line).await {
        Ok(0) | Err(_) => return,
        Ok(_) => {}
    }
    if handshake_line.trim().is_empty() {
        return;
    }

    let Ok(req) = serde_json::from_str::<CoreHandshakeRequest>(handshake_line.trim()) else {
        log_trace("Invalid handshake JSON line from client");
        return;
    };

    if req.auth_token != expected_token {
        log_trace("Handshake authentication failed: invalid token");
        return;
    }

    let active_count = get_terminals().lock().map(|m| m.len()).unwrap_or(0);
    let resp = CoreHandshakeResponse {
        protocol: CORE_PROTOCOL_VERSION.to_string(),
        framed: true,
        core_version: CORE_VERSION.to_string(),
        core_pid: std::process::id(),
        active_sessions: active_count,
    };

    let resp_bytes = format!("{}\n", serde_json::to_string(&resp).unwrap());
    if writer.write_all(resp_bytes.as_bytes()).await.is_err() {
        return;
    }

    // 2. Framed Multiplexed Loop (Event-driven: 0.00% CPU when idle, zero standing timers)
    let mut decoder = FrameStreamDecoder::new();
    let mut attached_channels: HashMap<u32, AttachedChannelState> = HashMap::new();
    let mut ui_event_rx = daemon_ui_event_tx().subscribe();
    let mut read_buf = [0u8; 8192];
    let mut pending_drain = false;

    loop {
        if pending_drain && !attached_channels.is_empty() {
            pending_drain = false;
            if !drain_attached_channels(&mut attached_channels, &mut writer).await {
                return;
            }
        }

        tokio::select! {
            _ = daemon_activity_notify().notified(), if !attached_channels.is_empty() => {
                pending_drain = true;
            }

            ui_evt = ui_event_rx.recv() => {
                if let Ok(frame) = ui_evt {
                    let enc = frame.encode();
                    if writer.write_all(&enc).await.is_err() {
                        return;
                    }
                    let _ = writer.flush().await;
                }
            }

            res = buf_reader.read(&mut read_buf) => {
                match res {
                    Ok(0) => break, // EOF / Client disconnected
                    Ok(n) => {
                        decoder.feed(&read_buf[..n]);
                        loop {
                            // Any oversized or malformed frame aborts the
                            // connection instead of silently stalling the drain.
                            let frame = match decoder.next_frame() {
                                Ok(Some(frame)) => frame,
                                Ok(None) => break,
                                Err(err) => {
                                    log_trace(&format!(
                                        "Framing error, aborting client connection: {}",
                                        err
                                    ));
                                    return;
                                }
                            };
                            match frame.kind {
                                FrameKind::Rpc if frame.channel_id == 0 => {
                                    if let Ok(val) = decode_rpc_payload(&frame.payload) {
                                        let id = val.get("id").cloned().unwrap_or(json!(null));
                                        let method = val.get("method").and_then(|v| v.as_str()).unwrap_or("");
                                        let params = val.get("params").cloned();

                                        let reply_json = match handle_control_rpc_request(method, params, &mut attached_channels) {
                                            Ok(result) => json!({
                                                "jsonrpc": "2.0",
                                                "id": id,
                                                "result": result
                                            }),
                                            Err(err_msg) => json!({
                                                "jsonrpc": "2.0",
                                                "id": id,
                                                "error": { "code": -32000, "message": err_msg }
                                            }),
                                        };

                                        let reply_frame = encode_rpc_frame(&reply_json);
                                        let enc = reply_frame.encode();
                                        if writer.write_all(&enc).await.is_err() {
                                            return;
                                        }
                                        if matches!(
                                            method,
                                            "session.create"
                                                | "session.attach"
                                                | "session.attach_rpc"
                                                | "session.resize"
                                                | "session.scroll_viewport"
                                                | "session.scroll_viewport_bin"
                                                | "session.set_presentation"
                                        ) {
                                            pending_drain = true;
                                        }
                                    }
                                }

                                FrameKind::Data => {
                                    if let Some(state) = attached_channels.get(&frame.channel_id) {
                                        if let Ok(text) = std::str::from_utf8(&frame.payload) {
                                            let _ = crate::terminal::write_terminal_local_sync(json!({
                                                "sessionId": state.session_id,
                                                "input": text
                                            }));
                                        } else {
                                            let inst = {
                                                let map = get_terminals().lock().unwrap();
                                                map.get(&state.session_id).cloned()
                                            };
                                            if let Some(inst) = inst {
                                                if let Ok(mut w) = inst.writer.lock() {
                                                    use std::io::Write;
                                                    let _ = w.write_all(&frame.payload);
                                                    let _ = w.flush();
                                                }
                                            }
                                        }
                                    }
                                }

                                FrameKind::Credit => {
                                    if let Ok(amount) = decode_credit_payload(&frame.payload) {
                                        if let Some(state) = attached_channels.get_mut(&frame.channel_id) {
                                            state.tracker.replenish(amount);
                                            // Keep the in-process session tracker in
                                            // lockstep so a paused poll re-arms too.
                                            grant_session_snapshot_credit(&state.session_id, amount);
                                            pending_drain = true;
                                        }
                                    }
                                }

                                FrameKind::Resize => {
                                    if let Ok((cols, rows, _, _)) = decode_resize_payload(&frame.payload) {
                                        if let Some(state) = attached_channels.get(&frame.channel_id) {
                                            let _ = crate::terminal::resize_terminal_local_sync(json!({
                                                "sessionId": state.session_id,
                                                "columns": cols,
                                                "rows": rows
                                            }));
                                            pending_drain = true;
                                        }
                                    }
                                }

                                FrameKind::Focus => {
                                    if let Ok((_, live_visible)) = decode_focus_payload(&frame.payload) {
                                        if let Some(state) = attached_channels.get_mut(&frame.channel_id) {
                                            let _ = crate::terminal::set_terminal_presentation_local_sync(json!({
                                                "sessionId": state.session_id,
                                                "live": live_visible
                                            }));
                                            if live_visible {
                                                state.initial_full_sent = false;
                                                pending_drain = true;
                                            }
                                        }
                                    }
                                }

                                FrameKind::Close => {
                                    attached_channels.remove(&frame.channel_id);
                                }

                                _ => {}
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
        }
    }

    log_trace("Pipe client disconnected cleanly, preserving background PTYs");
}

async fn drain_attached_channels<W>(
    attached_channels: &mut HashMap<u32, AttachedChannelState>,
    writer: &mut W,
) -> bool
where
    W: AsyncWrite + Unpin,
{
    let mut channel_ids: Vec<u32> = attached_channels.keys().copied().collect();
    channel_ids.sort_unstable();

    for channel_id in channel_ids {
        let Some(state) = attached_channels.get_mut(&channel_id) else {
            continue;
        };
        let inst = {
            let Ok(map) = get_terminals().lock() else {
                continue;
            };
            map.get(&state.session_id).cloned()
        };

        let Some(inst) = inst else {
            continue;
        };

        let (current_seq, vt_dirty) = inst
            .vt_engine
            .lock()
            .ok()
            .map(|vt| (vt.seq(), vt.wants_paint()))
            .unwrap_or((0, false));
        let exit_flagged = inst.exit_notified.load(Ordering::Relaxed);
        let has_raw_bytes = matches!(state.tracker.mode(), ChannelAttachMode::RawData)
            && inst.buffer.lock().map(|b| !b.is_empty()).unwrap_or(false);

        if state.initial_full_sent
            && !vt_dirty
            && current_seq == state.last_seq
            && (!exit_flagged || state.last_exited)
            && !has_raw_bytes
        {
            continue;
        }

        let (exited, exit_code) = child_exit_state(&inst);

        // FACTS whenever the lightweight metadata changes.
        let facts = session_facts(&inst);
        let title = facts.get("title").and_then(|v| v.as_str()).map(str::to_string);
        let cwd = facts.get("cwd").and_then(|v| v.as_str()).map(str::to_string);
        if title != state.last_title || cwd != state.last_cwd {
            state.last_title = title;
            state.last_cwd = cwd;
            if writer
                .write_all(&encode_facts_frame(channel_id, &facts).encode())
                .await
                .is_err()
            {
                return false;
            }
        }

        // CLOSE exactly once when the process exits (unless suppressed during planned rotation).
        if exited && !state.last_exited && !inst.suppress_exit_event.load(Ordering::Relaxed) {
            state.last_exited = true;
            let code = exit_code.unwrap_or(0) as i32;
            if writer
                .write_all(&encode_close_frame(channel_id, true, code).encode())
                .await
                .is_err()
            {
                return false;
            }
        }

        match state.tracker.mode() {
            ChannelAttachMode::SnapshotBin => {
                if state.tracker.available_credit() == 0 {
                    continue;
                }
                let since_seq = if state.initial_full_sent {
                    Some(state.last_seq)
                } else {
                    None
                };
                let bytes = crate::terminal::poll_terminal_snapshot_bin_local_bytes(
                    &state.session_id,
                    since_seq,
                );
                if bytes.is_empty() {
                    continue;
                }
                if !state.tracker.try_consume(1) {
                    continue;
                }
                state.initial_full_sent = true;
                if let Some(seq) = crate::vt_engine::snapshot_bin_seq(&bytes) {
                    state.last_seq = seq;
                }
                if writer
                    .write_all(&Frame::new(channel_id, FrameKind::SnapshotBin, bytes).encode())
                    .await
                    .is_err()
                {
                    return false;
                }
            }
            ChannelAttachMode::RawData => {
                let pending_len = inst.buffer.lock().map(|b| b.len() as u32).unwrap_or(0);
                if pending_len == 0 || state.tracker.available_credit() < pending_len {
                    continue;
                }
                let bytes = inst
                    .buffer
                    .lock()
                    .map(|mut b| std::mem::take(&mut *b))
                    .unwrap_or_default();
                if bytes.is_empty() {
                    continue;
                }
                if !state.tracker.try_consume(bytes.len() as u32) {
                    if let Ok(mut buffer) = inst.buffer.lock() {
                        let mut restored = bytes;
                        restored.extend_from_slice(&buffer);
                        *buffer = restored;
                    }
                    continue;
                }
                if writer
                    .write_all(&Frame::new(channel_id, FrameKind::Data, bytes).encode())
                    .await
                    .is_err()
                {
                    return false;
                }
            }
        }
    }
    let _ = writer.flush().await;
    true
}

#[cfg(windows)]
#[allow(dead_code)]
async fn handle_pipe_client(
    stream: tokio::net::windows::named_pipe::NamedPipeServer,
    expected_token: String,
) {
    handle_stream_client(stream, expected_token).await;
}

#[cfg(not(windows))]
#[allow(dead_code)]
async fn handle_unix_client(stream: tokio::net::UnixStream, expected_token: String) {
    handle_stream_client(stream, expected_token).await;
}
