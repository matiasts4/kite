use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::core_wire::{
    decode_close_payload, decode_credit_payload, decode_facts_payload, decode_focus_payload,
    decode_resize_payload, decode_rpc_payload, encode_close_frame, encode_credit_frame,
    encode_facts_frame, encode_focus_frame, encode_resize_frame, encode_rpc_frame,
    ChannelAttachMode, ChannelCreditTracker, Frame, FrameKind, FrameStreamDecoder,
};
use crate::logger::log_trace;
use crate::terminal::get_terminals;

pub const CORE_PROTOCOL_VERSION: &str = "kite-core/v1";
pub const CORE_VERSION: &str = "0.1.0";

static CORE_DAEMON_RUNNING: AtomicBool = AtomicBool::new(false);
static NEXT_CHANNEL_ID: AtomicU32 = AtomicU32::new(1);
static DAEMON_SHUTDOWN_NOTIFY: OnceLock<tokio::sync::Notify> = OnceLock::new();
static DAEMON_ACTIVITY_NOTIFY: OnceLock<tokio::sync::Notify> = OnceLock::new();
static DAEMON_UI_EVENT_BROADCAST: OnceLock<tokio::sync::broadcast::Sender<Frame>> = OnceLock::new();

fn daemon_ui_event_tx() -> &'static tokio::sync::broadcast::Sender<Frame> {
    DAEMON_UI_EVENT_BROADCAST.get_or_init(|| {
        let (tx, _rx) = tokio::sync::broadcast::channel(64);
        tx
    })
}

/// Broadcasts a Channel 0 UI notification frame to all connected clients (e.g. `dispatch-open-pane`).
pub fn broadcast_daemon_ui_event(event: &str, data: Value) {
    let notification = json!({
        "jsonrpc": "2.0",
        "method": "dispatch.event",
        "params": {
            "event": event,
            "data": data,
        }
    });
    let frame = encode_rpc_frame(&notification);
    let _ = daemon_ui_event_tx().send(frame);
}

/// Resolved once at startup: true when a detached `kite-core` process owns the
/// pipe (and therefore every PTY), false when this process runs the core itself.
static CORE_DAEMON_OWNER: OnceLock<bool> = OnceLock::new();

/// True when an out-of-process `kite-core` owns the PTY registry.
///
/// Callers must forward terminal operations over the control pipe in that case
/// instead of expecting a local `get_terminals()` entry.
pub fn is_external_daemon_owner() -> bool {
    CORE_DAEMON_OWNER.get().copied().unwrap_or(false)
}

/// Snapshot credit for in-process / IPC sessions that are keyed by `session_id`
/// or `channel_id` instead of by a live client channel.
static SESSION_CREDIT_TRACKERS: OnceLock<Mutex<HashMap<String, ChannelCreditTracker>>> =
    OnceLock::new();

fn daemon_shutdown_notify() -> &'static tokio::sync::Notify {
    DAEMON_SHUTDOWN_NOTIFY.get_or_init(tokio::sync::Notify::new)
}

fn daemon_activity_notify() -> &'static tokio::sync::Notify {
    DAEMON_ACTIVITY_NOTIFY.get_or_init(tokio::sync::Notify::new)
}

/// Wakes any attached stream clients when a PTY produces output, changes
/// metadata, or exits so idle connections sleep at 0.00% CPU without polling.
pub fn notify_daemon_activity() {
    daemon_activity_notify().notify_waiters();
}

fn session_credit_trackers() -> &'static Mutex<HashMap<String, ChannelCreditTracker>> {
    SESSION_CREDIT_TRACKERS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Grants snapshot credit to an in-process / IPC session.
///
/// Returns true when the tracker had no credit before the grant, which is the
/// trigger for emitting a coalesced `terminal://activity` wake-up.
pub fn grant_session_snapshot_credit(key: &str, amount: u32) -> bool {
    if key.is_empty() || amount == 0 {
        return false;
    }
    let Ok(mut trackers) = session_credit_trackers().lock() else {
        return false;
    };
    let tracker = trackers
        .entry(key.to_string())
        .or_insert_with(|| ChannelCreditTracker::with_credit(0, ChannelAttachMode::SnapshotBin, 0));
    let was_exhausted = tracker.is_exhausted();
    tracker.replenish(amount);
    was_exhausted
}

/// True while the session has snapshot budget left.
///
/// Sessions that never received an explicit credit grant stay unmetered so the
/// legacy in-process poller keeps its always-emit behavior.
pub fn has_session_snapshot_credit(session_id: &str) -> bool {
    if session_id.is_empty() {
        return true;
    }
    let Ok(trackers) = session_credit_trackers().lock() else {
        return true;
    };
    match trackers.get(session_id) {
        Some(tracker) => !tracker.is_exhausted(),
        None => true,
    }
}

/// Consumes one snapshot credit. Returns false when the balance is empty, which
/// pauses wire emission while the VT engine keeps parsing in memory (S2).
pub fn try_consume_session_snapshot_credit(session_id: &str) -> bool {
    if session_id.is_empty() {
        return true;
    }
    let Ok(mut trackers) = session_credit_trackers().lock() else {
        return true;
    };
    let Some(tracker) = trackers.get_mut(session_id) else {
        return true;
    };
    tracker.try_consume(1)
}

fn clear_in_process_channels() {
    if let Ok(mut trackers) = session_credit_trackers().lock() {
        trackers.clear();
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreHandshakeRequest {
    pub protocol: String,
    pub framed: bool,
    pub client: String,
    pub pid: u32,
    pub auth_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreHandshakeResponse {
    pub protocol: String,
    pub framed: bool,
    pub core_version: String,
    pub core_pid: u32,
    pub active_sessions: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSessionSummary {
    pub session_id: String,
    pub channel_id: Option<u32>,
    pub workspace_id: Option<String>,
    pub pane_id: Option<String>,
    pub engine: String,
    pub cwd: String,
    pub root_pid: u32,
    pub cols: u16,
    pub rows: u16,
    pub exited: bool,
    pub exit_code: Option<i64>,
    pub spawned_at_unix_ms: i64,
}

pub fn get_core_pipe_name() -> String {
    if let Ok(custom) = std::env::var("KITE_CORE_PIPE") {
        let trimmed = custom.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    #[cfg(windows)]
    {
        let user = std::env::var("USERNAME").unwrap_or_else(|_| "user".to_string());
        format!(r"\\.\pipe\kite-core-v1-{}", user)
    }
    #[cfg(not(windows))]
    {
        if let Ok(xdg) = std::env::var("XDG_RUNTIME_DIR") {
            format!("{}/kite-core-v1.sock", xdg)
        } else {
            let uid = unsafe { libc::getuid() };
            format!("/tmp/kite-core-v1-{}.sock", uid)
        }
    }
}

pub fn core_auth_token_path() -> PathBuf {
    crate::persist::roaming_app_dir().join("core-session.token")
}

pub fn get_or_create_core_token() -> String {
    let path = core_auth_token_path();
    if let Ok(content) = std::fs::read_to_string(&path) {
        let trimmed = content.trim().to_string();
        if !trimmed.is_empty() {
            return trimmed;
        }
    }

    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let token = format!("kt-{}", uuid::Uuid::new_v4().simple());
    let _ = std::fs::write(&path, &token);
    token
}

pub fn validate_core_token(token: &str) -> bool {
    let expected = get_or_create_core_token();
    !token.is_empty() && token == expected
}

/// Tracks channel state for an attached client connection.
pub struct AttachedChannelState {
    pub channel_id: u32,
    pub session_id: String,
    pub tracker: ChannelCreditTracker,
    pub last_seq: u64,
    pub initial_full_sent: bool,
    pub last_title: Option<String>,
    pub last_cwd: Option<String>,
    pub last_exited: bool,
}

/// Lightweight `FACTS` payload for a session, emitted whenever metadata changes.
fn session_facts(inst: &crate::terminal::TerminalInstance) -> Value {
    let cwd = inst
        .live_cwd
        .lock()
        .ok()
        .map(|cwd| cwd.clone())
        .filter(|cwd| !cwd.is_empty())
        .unwrap_or_else(|| inst.cwd.clone());
    let title = inst.vt_engine.lock().ok().and_then(|vt| vt.title());
    let provider_session_id = inst
        .provider_session_id
        .lock()
        .ok()
        .and_then(|provider| provider.clone());
    json!({
        "cwd": cwd,
        "title": title,
        "activeEngine": inst.engine,
        "providerSessionId": provider_session_id,
    })
}

fn child_exit_state(inst: &crate::terminal::TerminalInstance) -> (bool, Option<i64>) {
    if let Ok(mut child) = inst.child.lock() {
        if let Ok(Some(status)) = child.try_wait() {
            return (true, Some(status.exit_code() as i64));
        }
    }
    (false, None)
}

fn attached_channel(channel_id: u32, session_id: String, tracker: ChannelCreditTracker) -> AttachedChannelState {
    AttachedChannelState {
        channel_id,
        session_id,
        tracker,
        last_seq: 0,
        initial_full_sent: false,
        last_title: None,
        last_cwd: None,
        last_exited: false,
    }
}

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
                    ChannelCreditTracker::new(channel_id, ChannelAttachMode::SnapshotBin),
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
                    ChannelCreditTracker::new(channel_id, mode),
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
                    ChannelCreditTracker::new(channel_id, ChannelAttachMode::SnapshotBin),
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
            let quiesced: Vec<crate::terminal::QuiescedTerminal> = p
                .get("quiesced")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();
            crate::terminal::respawn_provider_terminals_local(provider, label, &quiesced);
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

/// Starts the standalone daemon server event loop on `\\.\pipe\kite-core-v1-<username>`.
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
async fn handle_stream_client<S>(stream: S, expected_token: String)
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

        // CLOSE exactly once when the process exits.
        if exited && !state.last_exited {
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
async fn handle_pipe_client(
    stream: tokio::net::windows::named_pipe::NamedPipeServer,
    expected_token: String,
) {
    handle_stream_client(stream, expected_token).await;
}

#[cfg(not(windows))]
async fn handle_unix_client(stream: tokio::net::UnixStream, expected_token: String) {
    handle_stream_client(stream, expected_token).await;
}

// -----------------------------------------------------------------------------
// Persistent Multiplexed Client (`CoreConnection` — S3, S6)
// -----------------------------------------------------------------------------

const CORE_PROBE_TIMEOUT: Duration = Duration::from_millis(500);
const CORE_RPC_TIMEOUT: Duration = Duration::from_millis(5000);

#[derive(Debug, Clone, Default)]
pub struct ClientSessionSlot {
    pub channel_id: Option<u32>,
    pub latest_snapshot_bin: Option<Vec<u8>>,
    pub latest_seq: u64,
    pub root_pid: u32,
    pub exited: bool,
    pub exit_code: Option<i64>,
    pub facts: Value,
}

#[derive(Default)]
struct ClientRoutes {
    closed: bool,
    core_pid: u32,
    replies: HashMap<u64, std::sync::mpsc::Sender<Result<Value, String>>>,
    channels: HashMap<u32, String>,
    sessions: HashMap<String, ClientSessionSlot>,
    /// Frames pushed on `channel_id >= 1` before the caller registered `channel_id -> session_id`.
    early_frames: HashMap<u32, Vec<Frame>>,
}

pub struct CoreConnection {
    writer: tokio::sync::mpsc::UnboundedSender<Vec<u8>>,
    routes: std::sync::Arc<Mutex<ClientRoutes>>,
    next_id: std::sync::atomic::AtomicU64,
}

static CORE_CONNECTION: OnceLock<Mutex<Option<std::sync::Arc<CoreConnection>>>> = OnceLock::new();

fn core_connection_slot() -> &'static Mutex<Option<std::sync::Arc<CoreConnection>>> {
    CORE_CONNECTION.get_or_init(|| Mutex::new(None))
}

#[cfg(windows)]
type ClientPipeStream = tokio::net::windows::named_pipe::NamedPipeClient;
#[cfg(not(windows))]
type ClientPipeStream = tokio::net::UnixStream;

async fn open_client_pipe_stream(pipe_name: &str) -> Result<ClientPipeStream, String> {
    #[cfg(windows)]
    {
        tokio::net::windows::named_pipe::ClientOptions::new()
            .open(pipe_name)
            .map_err(|err| format!("kite-core pipe unavailable: {}", err))
    }
    #[cfg(not(windows))]
    {
        tokio::net::UnixStream::connect(pipe_name)
            .await
            .map_err(|err| format!("kite-core socket unavailable: {}", err))
    }
}

fn apply_pushed_channel_frame_locked(
    routes: &mut ClientRoutes,
    session_id: &str,
    frame: Frame,
) -> Option<(String, u64, bool, Option<i64>)> {
    let slot = routes
        .sessions
        .entry(session_id.to_string())
        .or_insert_with(|| ClientSessionSlot {
            channel_id: Some(frame.channel_id),
            ..Default::default()
        });
    slot.channel_id = Some(frame.channel_id);

    match frame.kind {
        FrameKind::SnapshotBin => {
            if let Some(seq) = crate::vt_engine::snapshot_bin_seq(&frame.payload) {
                slot.latest_seq = seq;
            }
            slot.latest_snapshot_bin = Some(frame.payload);
            Some((
                session_id.to_string(),
                slot.latest_seq,
                slot.exited,
                slot.exit_code,
            ))
        }
        FrameKind::Facts => {
            if let Ok(facts) = decode_facts_payload(&frame.payload) {
                slot.facts = facts;
            }
            None
        }
        FrameKind::Close => {
            if let Ok((exited, code)) = decode_close_payload(&frame.payload) {
                slot.exited = exited;
                slot.exit_code = Some(code as i64);
                Some((
                    session_id.to_string(),
                    slot.latest_seq,
                    slot.exited,
                    slot.exit_code,
                ))
            } else {
                None
            }
        }
        _ => None,
    }
}

impl CoreConnection {
    pub fn connect() -> Result<std::sync::Arc<Self>, String> {
        let pipe_name = get_core_pipe_name();
        let token = get_or_create_core_token();
        let routes = std::sync::Arc::new(Mutex::new(ClientRoutes::default()));
        let routes_for_thread = std::sync::Arc::clone(&routes);
        let (writer_tx, mut writer_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();

        std::thread::Builder::new()
            .name("core-client-io".to_string())
            .spawn(move || {
                let Ok(rt) = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                else {
                    let _ = ready_tx.send(Err("failed to build core-client tokio runtime".into()));
                    return;
                };

                rt.block_on(async move {
                    let mut stream = match open_client_pipe_stream(&pipe_name).await {
                        Ok(s) => s,
                        Err(err) => {
                            let _ = ready_tx.send(Err(err));
                            return;
                        }
                    };

                    let handshake = json!({
                        "protocol": CORE_PROTOCOL_VERSION,
                        "framed": true,
                        "client": "kite-desktop",
                        "pid": std::process::id(),
                        "authToken": token,
                    });
                    let Ok(line) = serde_json::to_string(&handshake) else {
                        let _ = ready_tx.send(Err("failed to serialize core handshake".into()));
                        return;
                    };
                    if stream
                        .write_all(format!("{}\n", line).as_bytes())
                        .await
                        .is_err()
                        || stream.flush().await.is_err()
                    {
                        let _ = ready_tx.send(Err("failed to write core handshake".into()));
                        return;
                    }

                    let (read_half, mut write_half) = tokio::io::split(stream);
                    let mut buf_reader = tokio::io::BufReader::new(read_half);
                    let mut reply_line = String::new();
                    match tokio::time::timeout(
                        CORE_PROBE_TIMEOUT,
                        buf_reader.read_line(&mut reply_line),
                    )
                    .await
                    {
                        Ok(Ok(n)) if n > 0 => {}
                        _ => {
                            let _ = ready_tx.send(Err(
                                "kite-core did not answer the handshake within 500 ms".into(),
                            ));
                            return;
                        }
                    }

                    let parsed: CoreHandshakeResponse =
                        match serde_json::from_str(reply_line.trim()) {
                            Ok(p) => p,
                            Err(err) => {
                                let _ = ready_tx.send(Err(err.to_string()));
                                return;
                            }
                        };
                    if parsed.protocol != CORE_PROTOCOL_VERSION {
                        let _ = ready_tx.send(Err(format!(
                            "unexpected core protocol: {}",
                            parsed.protocol
                        )));
                        return;
                    }
                    if let Ok(mut r) = routes_for_thread.lock() {
                        r.core_pid = parsed.core_pid;
                    }

                    let _ = ready_tx.send(Ok(()));

                    // Dedicated writer task (`core-writer`): drains queued 9-byte frames without blocking callers.
                    let writer_task = tokio::spawn(async move {
                        while let Some(frame_bytes) = writer_rx.recv().await {
                            if write_half.write_all(&frame_bytes).await.is_err() {
                                break;
                            }
                            if writer_rx.is_empty() && write_half.flush().await.is_err() {
                                break;
                            }
                        }
                    });

                    // Dedicated reader loop (`core-reader`): decodes Channel 0 RPC replies and Channel 1..N push frames.
                    let mut decoder = FrameStreamDecoder::new();
                    let buffered = buf_reader.buffer();
                    if !buffered.is_empty() {
                        decoder.feed(buffered);
                    }
                    let mut read_half = buf_reader.into_inner();
                    let mut chunk = [0u8; 32768];

                    loop {
                        let mut pending_activities: Vec<(String, u64, bool, Option<i64>)> =
                            Vec::new();
                        let mut protocol_error = false;
                        {
                            loop {
                                match decoder.next_frame() {
                                    Ok(Some(frame)) => {
                                        if frame.channel_id == 0 && frame.kind == FrameKind::Rpc {
                                            if let Ok(payload) = decode_rpc_payload(&frame.payload)
                                            {
                                                if let Some(id) =
                                                    payload.get("id").and_then(|v| v.as_u64())
                                                {
                                                    let tx = routes_for_thread
                                                        .lock()
                                                        .ok()
                                                        .and_then(|mut r| r.replies.remove(&id));
                                                    if let Some(tx) = tx {
                                                        let res = match payload.get("error") {
                                                            Some(err) => Err(err.to_string()),
                                                            None => Ok(payload
                                                                .get("result")
                                                                .cloned()
                                                                .unwrap_or(Value::Null)),
                                                        };
                                                        let _ = tx.send(res);
                                                    }
                                                } else if let Some(method) =
                                                    payload.get("method").and_then(|v| v.as_str())
                                                {
                                                    if method == "dispatch.event" {
                                                        if let Some(params) = payload.get("params") {
                                                            if let Some(event_name) = params
                                                                .get("event")
                                                                .and_then(|v| v.as_str())
                                                            {
                                                                let event_data = params
                                                                    .get("data")
                                                                    .cloned()
                                                                    .unwrap_or(Value::Null);
                                                                if let Some(app) = crate::get_app_handle() {
                                                                    use tauri::Emitter;
                                                                    let _ = app.emit(event_name, event_data);
                                                                }
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        } else if frame.channel_id >= 1 {
                                            if let Ok(mut r) = routes_for_thread.lock() {
                                                if let Some(sid) =
                                                    r.channels.get(&frame.channel_id).cloned()
                                                {
                                                    if let Some(act) =
                                                        apply_pushed_channel_frame_locked(
                                                            &mut r, &sid, frame,
                                                        )
                                                    {
                                                        pending_activities.push(act);
                                                    }
                                                } else {
                                                    r.early_frames
                                                        .entry(frame.channel_id)
                                                        .or_default()
                                                        .push(frame);
                                                }
                                            }
                                        }
                                    }
                                    Ok(None) => break,
                                    Err(_) => {
                                        protocol_error = true;
                                        break;
                                    }
                                }
                            }
                        }

                        for (sid, seq, exited, exit_code) in pending_activities {
                            crate::terminal::emit_terminal_activity_from_core(
                                &sid, seq, exited, exit_code,
                            );
                        }

                        if protocol_error {
                            break;
                        }

                        match read_half.read(&mut chunk).await {
                            Ok(0) | Err(_) => break,
                            Ok(n) => decoder.feed(&chunk[..n]),
                        }
                    }

                    writer_task.abort();
                    if let Ok(mut r) = routes_for_thread.lock() {
                        r.closed = true;
                        for (_, tx) in r.replies.drain() {
                            let _ = tx.send(Err("lost connection to kite-core".to_string()));
                        }
                    }
                });
            })
            .map_err(|err| err.to_string())?;

        match ready_rx.recv_timeout(CORE_PROBE_TIMEOUT) {
            Ok(Ok(())) => Ok(std::sync::Arc::new(Self {
                writer: writer_tx,
                routes,
                next_id: std::sync::atomic::AtomicU64::new(1),
            })),
            Ok(Err(err)) => Err(err),
            Err(_) => Err("kite-core did not answer the handshake within 500 ms".to_string()),
        }
    }

    pub fn get() -> Result<std::sync::Arc<Self>, String> {
        let mut guard = core_connection_slot()
            .lock()
            .map_err(|err| err.to_string())?;
        if let Some(existing) = guard.as_ref() {
            let is_closed = existing.routes.lock().map(|r| r.closed).unwrap_or(true);
            if !is_closed {
                return Ok(std::sync::Arc::clone(existing));
            }
        }
        let connected = Self::connect()?;
        *guard = Some(std::sync::Arc::clone(&connected));
        Ok(connected)
    }

    pub fn send_frame(&self, frame: Frame) -> bool {
        self.writer.send(frame.encode()).is_ok()
    }

    pub fn call_rpc(
        &self,
        method: &str,
        params: Option<Value>,
        timeout: Duration,
    ) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = std::sync::mpsc::channel();
        {
            let mut r = self.routes.lock().map_err(|err| err.to_string())?;
            if r.closed {
                return Err(format!("{}: connection to kite-core is closed", method));
            }
            r.replies.insert(id, tx);
        }
        let request = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params.unwrap_or_else(|| json!({})),
        });
        if !self.send_frame(encode_rpc_frame(&request)) {
            if let Ok(mut r) = self.routes.lock() {
                r.replies.remove(&id);
                r.closed = true;
            }
            return Err(format!("{}: failed to send RPC frame to kite-core", method));
        }

        match rx.recv_timeout(timeout) {
            Ok(result) => result,
            Err(_) => {
                if let Ok(mut r) = self.routes.lock() {
                    r.replies.remove(&id);
                }
                Err(format!(
                    "kite-core did not answer {} within {} ms",
                    method,
                    timeout.as_millis()
                ))
            }
        }
    }
}

/// Performs a Channel 0 JSON-RPC 2.0 call over the persistent `CoreConnection`,
/// automatically reconnecting once if the previous pipe was closed.
pub fn send_core_daemon_rpc(method: &str, params: Option<Value>) -> Result<Value, String> {
    let timeout = if method == "session.list" || method == "core.status" {
        CORE_PROBE_TIMEOUT
    } else {
        CORE_RPC_TIMEOUT
    };
    let conn = CoreConnection::get()?;
    match conn.call_rpc(method, params.clone(), timeout) {
        Ok(val) => Ok(val),
        Err(err) if err.contains("closed") || err.contains("lost connection") => {
            if let Ok(mut guard) = core_connection_slot().lock() {
                *guard = None;
            }
            let retry_conn = CoreConnection::get()?;
            retry_conn.call_rpc(method, params, timeout)
        }
        Err(err) => Err(err),
    }
}

/// Registers a session's `channel_id` and `root_pid` in `CoreConnection` after
/// `session.create` or `session.attach_rpc`, draining any `early_frames` that
/// arrived before the RPC return path finished.
pub fn register_client_session_channel(
    session_id: &str,
    channel_id: Option<u32>,
    root_pid: u32,
) {
    if session_id.is_empty() {
        return;
    }
    let Ok(conn) = CoreConnection::get() else {
        return;
    };
    let mut pending_activities = Vec::new();
    if let Ok(mut r) = conn.routes.lock() {
        let slot = r
            .sessions
            .entry(session_id.to_string())
            .or_default();
        if root_pid > 0 {
            slot.root_pid = root_pid;
        }
        if let Some(ch) = channel_id {
            slot.channel_id = Some(ch);
            r.channels.insert(ch, session_id.to_string());
            if let Some(early) = r.early_frames.remove(&ch) {
                for frame in early {
                    if let Some(act) = apply_pushed_channel_frame_locked(&mut r, session_id, frame)
                    {
                        pending_activities.push(act);
                    }
                }
            }
        }
    }
    for (sid, seq, exited, exit_code) in pending_activities {
        crate::terminal::emit_terminal_activity_from_core(&sid, seq, exited, exit_code);
    }
}

pub fn unregister_client_session(session_id: &str) {
    let conn = core_connection_slot()
        .lock()
        .ok()
        .and_then(|g| g.as_ref().cloned());
    let Some(conn) = conn else {
        return;
    };
    if let Ok(mut r) = conn.routes.lock() {
        if let Some(slot) = r.sessions.remove(session_id) {
            if let Some(ch) = slot.channel_id {
                r.channels.remove(&ch);
                r.early_frames.remove(&ch);
            }
        }
    };
}

/// Enqueues a 9-byte `DATA` frame directly onto `core-writer` (`channel_id >= 1`).
pub fn send_client_session_data(session_id: &str, bytes: &[u8]) -> bool {
    if session_id.is_empty() || bytes.is_empty() {
        return false;
    }
    let Ok(conn) = CoreConnection::get() else {
        return false;
    };
    let channel_id = conn
        .routes
        .lock()
        .ok()
        .and_then(|r| r.sessions.get(session_id).and_then(|s| s.channel_id));
    let Some(ch) = channel_id else {
        return false;
    };
    conn.send_frame(Frame::new(ch, FrameKind::Data, bytes.to_vec()))
}

/// Enqueues a 9+8 byte `RESIZE` frame directly onto `core-writer` (`channel_id >= 1`).
pub fn send_client_session_resize(session_id: &str, cols: u16, rows: u16) -> bool {
    if session_id.is_empty() {
        return false;
    }
    let Ok(conn) = CoreConnection::get() else {
        return false;
    };
    let channel_id = conn
        .routes
        .lock()
        .ok()
        .and_then(|r| r.sessions.get(session_id).and_then(|s| s.channel_id));
    let Some(ch) = channel_id else {
        return false;
    };
    conn.send_frame(encode_resize_frame(ch, cols, rows, 0, 0))
}

/// Enqueues a 9+2 byte `FOCUS` frame directly onto `core-writer` (`channel_id >= 1`).
pub fn send_client_session_focus(session_id: &str, live: bool) -> bool {
    if session_id.is_empty() {
        return false;
    }
    let Ok(conn) = CoreConnection::get() else {
        return false;
    };
    let channel_id = conn
        .routes
        .lock()
        .ok()
        .and_then(|r| r.sessions.get(session_id).and_then(|s| s.channel_id));
    let Some(ch) = channel_id else {
        return false;
    };
    conn.send_frame(encode_focus_frame(ch, live, live))
}

/// Enqueues a 9+4 byte `CREDIT` frame directly onto `core-writer` (`channel_id >= 1`).
pub fn send_client_session_credit(
    session_id: Option<&str>,
    channel_id: Option<u32>,
    amount: u32,
) -> bool {
    if amount == 0 {
        return false;
    }
    let Ok(conn) = CoreConnection::get() else {
        return false;
    };
    let resolved_ch = channel_id.or_else(|| {
        let sid = session_id?;
        conn.routes
            .lock()
            .ok()
            .and_then(|r| r.sessions.get(sid).and_then(|s| s.channel_id))
    });
    let Some(ch) = resolved_ch else {
        return false;
    };
    conn.send_frame(encode_credit_frame(ch, amount))
}

/// Takes the latest pushed `SNAPSHOT_BIN` payload from `ClientSessionSlot` in O(1)
/// without Base64 or JSON round-trips.
pub fn take_client_cached_snapshot_bin(session_id: &str) -> Option<Vec<u8>> {
    let guard = core_connection_slot().lock().ok()?;
    let conn = guard.as_ref()?;
    let mut r = conn.routes.lock().ok()?;
    r.sessions.get_mut(session_id)?.latest_snapshot_bin.take()
}

/// Returns the latest cached facts for an active session (`cwd`, `title`, `activeEngine`, `providerSessionId`).
pub fn get_client_session_facts(session_id: &str) -> Option<Value> {
    let guard = core_connection_slot().lock().ok()?;
    let conn = guard.as_ref()?;
    let r = conn.routes.lock().ok()?;
    r.sessions.get(session_id).map(|s| s.facts.clone())
}

/// Returns the OS PID of the connected `kite-core --daemon` process, if active.
pub fn get_core_daemon_pid() -> Option<u32> {
    let guard = core_connection_slot().lock().ok()?;
    let conn = guard.as_ref()?;
    let r = conn.routes.lock().ok()?;
    if !r.closed && r.core_pid > 0 {
        Some(r.core_pid)
    } else {
        None
    }
}

/// Returns `(session_id, root_pid, facts)` for all live daemon-owned sessions cached in `CoreConnection`.
pub fn get_client_active_session_summaries() -> Vec<(String, u32, Value)> {
    let mut out = Vec::new();
    if let Ok(guard) = core_connection_slot().lock() {
        if let Some(conn) = guard.as_ref() {
            if let Ok(r) = conn.routes.lock() {
                for (sid, slot) in &r.sessions {
                    if !slot.exited {
                        out.push((sid.clone(), slot.root_pid, slot.facts.clone()));
                    }
                }
            }
        }
    }
    out
}

/// Returns the root OS PIDs of active daemon-owned sessions for lineage telemetry.
pub fn get_client_session_root_pids() -> std::collections::HashSet<u32> {
    let mut pids = std::collections::HashSet::new();
    if let Ok(guard) = core_connection_slot().lock() {
        if let Some(conn) = guard.as_ref() {
            if let Ok(r) = conn.routes.lock() {
                for slot in r.sessions.values() {
                    if slot.root_pid > 0 && !slot.exited {
                        pids.insert(slot.root_pid);
                    }
                }
            }
        }
    }
    if pids.is_empty() && is_external_daemon_owner() {
        if let Ok(res) = send_core_daemon_rpc("session.list", None) {
            if let Some(arr) = res.get("sessions").and_then(|v| v.as_array()) {
                for item in arr {
                    let exited = item.get("exited").and_then(|v| v.as_bool()).unwrap_or(false);
                    let pid = item.get("rootPid").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                    if pid > 0 && !exited {
                        pids.insert(pid);
                    }
                }
            }
        }
    }
    pids
}

/// True when a live `kite-core` daemon answers on the local pipe/socket.
pub fn probe_core_daemon_pipe() -> bool {
    send_core_daemon_rpc("session.list", None).is_ok()
}

#[cfg(not(test))]
fn spawn_detached_core_daemon() -> bool {
    let Ok(exe) = std::env::current_exe() else {
        return false;
    };
    let mut command = std::process::Command::new(exe);
    command.arg("--daemon");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW | DETACHED_PROCESS
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        command.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);
    }
    command.spawn().is_ok()
}

/// Starts (or discovers) the background core.
///
/// Returns true when an out-of-process daemon owns the pipe, so the caller can
/// skip starting a second loopback dispatch listener in the GUI process.
pub fn ensure_core_daemon_started() -> bool {
    *CORE_DAEMON_OWNER.get_or_init(|| {
        if probe_core_daemon_pipe() {
            log_trace("Connected to an existing kite-core daemon");
            return true;
        }

        #[cfg(not(test))]
        {
            if spawn_detached_core_daemon() {
                // Give the detached core up to 500 ms to publish its pipe.
                for _ in 0..50 {
                    std::thread::sleep(Duration::from_millis(10));
                    if probe_core_daemon_pipe() {
                        log_trace("Spawned kite-core daemon and completed the handshake");
                        return true;
                    }
                }
            }
        }

        std::thread::spawn(|| {
            run_core_daemon_main();
        });
        false
    })
}

#[tauri::command]
pub async fn shutdown_core_daemon(force: Option<bool>) -> serde_json::Value {
    log_trace("IPC shutdown_core_daemon invoked: explicit app termination");
    let force_flag = force.unwrap_or(false);
    // Ask a detached core to stop its own sessions when one owns the pipe.
    if send_core_daemon_rpc("core.shutdown", Some(json!({ "force": force_flag }))).is_err() {
        log_trace("No detached kite-core answered core.shutdown; shutting down in-process sessions");
    }
    crate::terminal::snapshot_and_shutdown_all_terminals("ipc_shutdown_core_daemon");
    crate::dispatch_wire::shutdown();
    crate::audio_ducking::restore_audio_immediate();
    if let Ok(mut manager) = crate::chat::runtime::session_manager().lock() {
        manager.stop_all();
    }
    serde_json::json!({ "shuttingDown": true, "force": force_flag })
}

#[tauri::command]
pub async fn poll_terminal_snapshot_bin(
    request: serde_json::Value,
) -> Result<tauri::ipc::Response, String> {
    let req = request.get("request").unwrap_or(&request);
    let session_id = req.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
    let since_seq = req.get("sinceSeq").and_then(|v| v.as_u64());

    if !crate::terminal::has_local_terminal_instance(session_id)
        && !is_external_daemon_owner()
    {
        return Err(format!("Session {} not found", session_id));
    }

    let bin_bytes = crate::terminal::poll_terminal_snapshot_bin_bytes(session_id, since_seq);
    Ok(tauri::ipc::Response::new(bin_bytes))
}

#[tauri::command]
pub async fn replenish_terminal_credit(
    request: Option<serde_json::Value>,
) -> serde_json::Value {
    let req = request.as_ref().and_then(|r| r.get("request")).or(request.as_ref());
    let session_key = req
        .and_then(|r| r.get("sessionId").or_else(|| r.get("session_id")))
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let channel_id = req
        .and_then(|r| r.get("channelId"))
        .and_then(|v| v.as_u64())
        .map(|v| v as u32);
    let amount = req
        .and_then(|r| r.get("amount"))
        .and_then(|v| v.as_u64())
        .map(|v| v as u32)
        .unwrap_or(1)
        .max(1);

    let key = session_key.or_else(|| channel_id.map(|id| id.to_string()));
    let mut woken = false;
    if is_external_daemon_owner() {
        woken = send_client_session_credit(key.as_deref(), channel_id, amount);
    }
    if let Some(key) = key.as_deref() {
        let was_exhausted = grant_session_snapshot_credit(key, amount);
        if was_exhausted {
            // Coalesced wake: one activity event releases the whole dirty tail (S2).
            crate::terminal::notify_session_credit_restored(key);
            woken = true;
        }
    }

    serde_json::json!({
        "ok": true,
        "channelId": channel_id,
        "sessionId": key,
        "granted": amount,
        "woken": woken,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_session(prefix: &str) -> String {
        format!("{}-{}", prefix, uuid::Uuid::new_v4())
    }

    fn start_test_terminal(session_id: &str, cols: u16, rows: u16) -> Value {
        crate::terminal::start_terminal_sync(json!({
            "sessionId": session_id,
            "engine": "powershell",
            "cols": cols,
            "rows": rows,
            "confirmedByBuilder": true
        }))
    }

    #[test]
    fn test_core_token_generation_and_validation() {
        let token = get_or_create_core_token();
        assert!(!token.is_empty());
        assert!(validate_core_token(&token));
        assert!(!validate_core_token("bad_token_12345"));
    }

    #[test]
    fn test_control_rpc_session_list() {
        let mut channels = HashMap::new();
        let res = handle_control_rpc_request("session.list", None, &mut channels).unwrap();
        assert!(res.get("sessions").is_some());
    }

    #[test]
    fn test_handshake_roundtrip_json() {
        let req = CoreHandshakeRequest {
            protocol: CORE_PROTOCOL_VERSION.to_string(),
            framed: true,
            client: "kite-desktop".to_string(),
            pid: 12345,
            auth_token: "test_token".to_string(),
        };
        let line = serde_json::to_string(&req).unwrap();
        let parsed: CoreHandshakeRequest = serde_json::from_str(&line).unwrap();
        assert_eq!(parsed.protocol, "kite-core/v1");
        assert_eq!(parsed.pid, 12345);
    }

    #[test]
    fn session_rpc_reports_the_real_root_pid_and_terminate_is_idempotent() {
        let session_id = test_session("test-core-create");
        let mut channels = HashMap::new();
        let created = handle_control_rpc_request(
            "session.create",
            Some(json!({
                "sessionId": session_id,
                "engine": "powershell",
                "cols": 52,
                "rows": 14
            })),
            &mut channels,
        )
        .expect("session.create");

        let root_pid = created["rootPid"].as_u64().unwrap_or(0);
        assert!(root_pid > 0, "session.create must report the PTY root pid");
        assert!(created["spawnedAtUnixMs"].as_i64().unwrap_or(0) > 0);
        let channel_id = created["channelId"].as_u64().unwrap() as u32;
        assert!(channels.contains_key(&channel_id));

        let listed = handle_control_rpc_request("session.list", None, &mut channels).unwrap();
        let entry = listed["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["sessionId"] == json!(session_id))
            .expect("session listed")
            .clone();
        assert_eq!(entry["rootPid"].as_u64().unwrap(), root_pid);

        let attached = handle_control_rpc_request(
            "session.attach",
            Some(json!({ "sessionId": session_id, "live": true })),
            &mut channels,
        )
        .expect("session.attach");
        assert_eq!(attached["rootPid"].as_u64().unwrap(), root_pid);

        let first = handle_control_rpc_request(
            "session.terminate",
            Some(json!({ "sessionId": session_id })),
            &mut channels,
        )
        .unwrap();
        assert_eq!(first["terminated"], true);

        let second = handle_control_rpc_request(
            "session.terminate",
            Some(json!({ "sessionId": session_id })),
            &mut channels,
        )
        .unwrap();
        assert_eq!(
            second["terminated"], false,
            "an idempotent second terminate must not report a termination"
        );
    }

    #[test]
    fn replenish_terminal_credit_meters_a_session_until_the_next_grant() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let key = test_session("test-credit");

        let granted = runtime.block_on(replenish_terminal_credit(Some(json!({
            "sessionId": key,
            "amount": 1
        }))));
        assert_eq!(granted["granted"], 1);
        assert!(
            try_consume_session_snapshot_credit(&key),
            "the grant must arm exactly one snapshot"
        );
        assert!(
            !try_consume_session_snapshot_credit(&key),
            "a single grant must not arm a second snapshot"
        );
        assert!(!has_session_snapshot_credit(&key));

        let reopened = runtime.block_on(replenish_terminal_credit(Some(json!({
            "sessionId": key,
            "amount": 2
        }))));
        assert_eq!(reopened["woken"], true, "an exhausted tracker must wake");
        assert!(try_consume_session_snapshot_credit(&key));
        assert!(try_consume_session_snapshot_credit(&key));
        assert!(!try_consume_session_snapshot_credit(&key));
    }

    #[test]
    fn legacy_unmetered_sessions_keep_emitting_snapshots() {
        let key = test_session("test-unmetered");
        for _ in 0..5 {
            assert!(try_consume_session_snapshot_credit(&key));
        }
        assert!(has_session_snapshot_credit(&key));
    }

    async fn read_line_async<R: AsyncRead + Unpin>(reader: &mut R) -> Result<String, String> {
        let mut line = Vec::new();
        let mut byte = [0u8; 1];
        loop {
            let read = reader.read(&mut byte).await.map_err(|err| err.to_string())?;
            if read == 0 || byte[0] == b'\n' {
                break;
            }
            line.push(byte[0]);
        }
        String::from_utf8(line).map_err(|err| err.to_string())
    }

    #[test]
    fn pipe_client_handshake_attach_and_delta_loop() {
        let session_id = test_session("test-core-pipe");
        let started = start_test_terminal(&session_id, 40, 10);
        assert!(started["rootPid"].as_u64().unwrap_or(0) > 0);
        // Let the PTY reader publish the first prompt.
        std::thread::sleep(Duration::from_millis(600));

        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();

        runtime.block_on(async {
            let (client, server) = tokio::io::duplex(512 * 1024);
            let token = get_or_create_core_token();
            let server_task = tokio::spawn(handle_stream_client(server, token.clone()));
            let (mut reader, mut writer) = tokio::io::split(client);

            let handshake = json!({
                "protocol": CORE_PROTOCOL_VERSION,
                "framed": true,
                "client": "kite-test",
                "pid": std::process::id(),
                "authToken": token,
            });
            writer
                .write_all(format!("{}\n", handshake).as_bytes())
                .await
                .unwrap();
            let reply_line = read_line_async(&mut reader).await.unwrap();
            let reply: CoreHandshakeResponse = serde_json::from_str(&reply_line).unwrap();
            assert_eq!(reply.protocol, CORE_PROTOCOL_VERSION);
            assert!(reply.active_sessions >= 1);

            let attach = json!({
                "jsonrpc": "2.0",
                "id": 7,
                "method": "session.attach",
                "params": {
                    "sessionId": session_id,
                    "mode": "snapshot_bin",
                    "cols": 40,
                    "rows": 10,
                    "live": true
                }
            });
            writer.write_all(&encode_rpc_frame(&attach).encode()).await.unwrap();

            let mut decoder = FrameStreamDecoder::new();
            let mut attach_reply: Option<Value> = None;
            let mut snapshots: Vec<(u8, Vec<u8>)> = Vec::new();
            let mut saw_facts = false;
            let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
            let mut chunk = [0u8; 8192];

            while tokio::time::Instant::now() < deadline {
                if snapshots.len() >= 2 && attach_reply.is_some() {
                    break;
                }
                let read = tokio::time::timeout(Duration::from_millis(250), reader.read(&mut chunk)).await;
                if let Ok(Ok(0)) = read {
                    break;
                }
                if let Ok(Ok(read)) = read {
                    decoder.feed(&chunk[..read]);
                }
                while let Ok(Some(frame)) = decoder.next_frame() {
                    match frame.kind {
                        FrameKind::Rpc => {
                            attach_reply = decode_rpc_payload(&frame.payload).ok();
                        }
                        FrameKind::Facts => {
                            saw_facts = true;
                        }
                        FrameKind::SnapshotBin => {
                            snapshots.push((frame.payload[17], frame.payload.clone()));
                            let channel_id = frame.channel_id;
                            if snapshots.len() == 1 {
                                // Publish one dirty row so the next frame is a delta.
                                if let Some(inst) = get_terminals()
                                    .lock()
                                    .ok()
                                    .and_then(|map| map.get(&session_id).cloned())
                                {
                                    if let Ok(mut vt) = inst.vt_engine.lock() {
                                        vt.feed(b"\r\nDELTA-ROW");
                                    }
                                }
                            }
                            writer
                                .write_all(&encode_credit_frame(channel_id, 1).encode())
                                .await
                                .unwrap();
                        }
                        _ => {}
                    }
                }
            }

            let attach_reply = attach_reply.expect("session.attach reply");
            assert!(
                attach_reply["result"]["rootPid"].as_u64().unwrap_or(0) > 0,
                "session.attach must report the real root pid"
            );
            assert!(saw_facts, "the first tick must publish FACTS metadata");
            assert_eq!(snapshots.len(), 2, "expected a full frame and a delta frame");
            assert_eq!(
                snapshots[0].0 & 0x01,
                0x01,
                "the first frame must be full"
            );
            assert_eq!(
                snapshots[1].0 & 0x01,
                0x00,
                "the second frame must be a dirty-row delta instead of a full repaint"
            );
            let first_seq = crate::vt_engine::snapshot_bin_seq(&snapshots[0].1).unwrap();
            let second_seq = crate::vt_engine::snapshot_bin_seq(&snapshots[1].1).unwrap();
            assert!(
                second_seq > first_seq,
                "the loop must advance last_seq instead of replaying seq 0"
            );

            // Killing the child must produce exactly one CLOSE frame.
            if let Some(inst) = get_terminals()
                .lock()
                .ok()
                .and_then(|map| map.get(&session_id).cloned())
            {
                if let Ok(mut child) = inst.child.lock() {
                    let _ = child.kill();
                }
            }

            let mut close_frames = 0;
            let close_deadline = tokio::time::Instant::now() + Duration::from_secs(6);
            while tokio::time::Instant::now() < close_deadline && close_frames == 0 {
                let read = tokio::time::timeout(Duration::from_millis(250), reader.read(&mut chunk)).await;
                if let Ok(Ok(read)) = read {
                    decoder.feed(&chunk[..read]);
                }
                while let Ok(Some(frame)) = decoder.next_frame() {
                    if frame.kind == FrameKind::Close {
                        close_frames += 1;
                        let (exited, _) =
                            crate::core_wire::decode_close_payload(&frame.payload).unwrap();
                        assert!(exited);
                    }
                }
            }
            assert_eq!(close_frames, 1, "process exit must emit one CLOSE frame");

            drop(writer);
            let _ = tokio::time::timeout(Duration::from_secs(2), server_task).await;
        });

        let _ = crate::terminal::terminate_terminal_sync(json!({ "sessionId": session_id }));
    }

    #[test]
    fn oversized_frame_aborts_the_client_connection() {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();

        runtime.block_on(async {
            let (client, server) = tokio::io::duplex(64 * 1024);
            let token = get_or_create_core_token();
            let server_task = tokio::spawn(handle_stream_client(server, token.clone()));
            let (mut reader, mut writer) = tokio::io::split(client);

            let handshake = json!({
                "protocol": CORE_PROTOCOL_VERSION,
                "framed": true,
                "client": "kite-test",
                "pid": std::process::id(),
                "authToken": token,
            });
            writer
                .write_all(format!("{}\n", handshake).as_bytes())
                .await
                .unwrap();
            let reply_line = read_line_async(&mut reader).await.unwrap();
            let reply: CoreHandshakeResponse = serde_json::from_str(&reply_line).unwrap();
            assert_eq!(reply.protocol, CORE_PROTOCOL_VERSION);

            // A header declaring a 17 MiB payload exceeds the 16 MiB frame cap.
            let mut header = [0u8; crate::core_wire::FRAME_HEADER_LEN];
            header[0..4].copy_from_slice(&0u32.to_le_bytes());
            header[4] = FrameKind::Rpc as u8;
            header[5..9].copy_from_slice(&(17u32 * 1024 * 1024).to_le_bytes());
            writer.write_all(&header).await.unwrap();
            writer.flush().await.unwrap();

            // The daemon must abort the connection instead of leaving it open.
            let mut buf = [0u8; 64];
            let closed = tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    match reader.read(&mut buf).await {
                        Ok(0) => return true,
                        Ok(_) => continue,
                        Err(_) => return true,
                    }
                }
            })
            .await;
            assert_eq!(
                closed,
                Ok(true),
                "an oversized frame must abort the client connection"
            );

            let _ = tokio::time::timeout(Duration::from_secs(2), server_task).await;
        });
    }

    #[test]
    fn gui_terminal_channel_rpcs_drive_the_daemon_pty_registry() {
        let session_id = test_session("test-core-gui-rpc");
        let mut channels = HashMap::new();
        let created = handle_control_rpc_request(
            "session.create",
            Some(json!({
                "sessionId": session_id,
                "engine": "powershell",
                "cols": 40,
                "rows": 10
            })),
            &mut channels,
        )
        .expect("session.create");
        assert!(created["rootPid"].as_u64().unwrap_or(0) > 0);

        let written = handle_control_rpc_request(
            "session.write",
            Some(json!({ "sessionId": session_id, "input": "echo kite\r\n" })),
            &mut channels,
        )
        .expect("session.write");
        assert_eq!(written["ok"], true);

        let missing = handle_control_rpc_request(
            "session.write",
            Some(json!({ "sessionId": "missing-gui-session", "input": "x" })),
            &mut channels,
        )
        .expect("session.write");
        assert_eq!(missing["ok"], false);
        assert_eq!(missing["error"], "Session not found");

        let resized = handle_control_rpc_request(
            "session.resize",
            Some(json!({ "sessionId": session_id, "columns": 52, "rows": 12 })),
            &mut channels,
        )
        .expect("session.resize");
        assert_eq!(resized["ok"], true);

        std::thread::sleep(Duration::from_millis(400));

        let polled = handle_control_rpc_request(
            "session.poll_snapshot",
            Some(json!({ "sessionId": session_id, "sinceSeq": 0 })),
            &mut channels,
        )
        .expect("session.poll_snapshot");
        assert!(
            polled.get("kind").and_then(|v| v.as_str()).is_some(),
            "session.poll_snapshot must answer with a snapshot poll response, got {polled:?}"
        );

        let bin = handle_control_rpc_request(
            "session.poll_snapshot_bin",
            Some(json!({ "sessionId": session_id })),
            &mut channels,
        )
        .expect("session.poll_snapshot_bin");
        let raw = crate::terminal::decode_base64(
            bin["bytesBase64"]
                .as_str()
                .expect("session.poll_snapshot_bin must return bytesBase64"),
        )
        .expect("bytesBase64 must decode");
        assert!(
            crate::vt_engine::snapshot_bin_seq(&raw).is_some(),
            "the forwarded binary frame must carry a SNAPSHOT_BIN header"
        );
        assert_eq!(raw[17] & 0x01, 0x01, "the first forwarded frame must be full");

        let attached = handle_control_rpc_request(
            "session.attach_rpc",
            Some(json!({ "sessionId": session_id, "live": true })),
            &mut channels,
        )
        .expect("session.attach_rpc");
        let channel_id = attached["channelId"]
            .as_u64()
            .expect("session.attach_rpc must bind a channelId") as u32;
        assert!(channels.contains_key(&channel_id));
        assert_eq!(attached["sessionId"], json!(session_id));

        let detached = handle_control_rpc_request(
            "session.detach",
            Some(json!({ "all": true })),
            &mut channels,
        )
        .expect("session.detach");
        assert_eq!(detached["detached"], true);
        assert!(
            channels.is_empty(),
            "session.detach with all=true must drop every attached channel"
        );

        let _ = handle_control_rpc_request(
            "session.terminate",
            Some(json!({ "sessionId": session_id })),
            &mut channels,
        );
    }

    #[test]
    fn agent_dispatch_records_an_inbox_state_entry() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let cwd = std::env::temp_dir().join(format!("kite-core-inbox-{stamp}"));
        std::fs::create_dir_all(&cwd).unwrap();

        let mut channels = HashMap::new();
        let result = handle_control_rpc_request(
            "agent.dispatch",
            Some(json!({
                "action": "ls",
                "id": "dispatch-audit-1",
                "cwd": cwd.to_string_lossy(),
            })),
            &mut channels,
        )
        .expect("agent.dispatch");
        assert!(
            result.get("op").is_some() || result.get("error").is_some(),
            "agent.dispatch must answer with a receipt, got {result:?}"
        );

        let recorded = cwd
            .join(".kite")
            .join("inbox")
            .join("dispatch-audit-1.result.json");
        assert!(
            recorded.is_file(),
            "a daemon-owned dispatch must record its state in the agent inbox"
        );
        let body = std::fs::read_to_string(&recorded).unwrap();
        assert!(body.contains("kite-core"));

        let _ = std::fs::remove_dir_all(&cwd);
    }

    #[test]
    fn persistent_client_routes_early_frames_and_extended_rpcs() {
        let session_id = test_session("core-client-routes");
        let mut channels = HashMap::new();

        let created = handle_control_rpc_request(
            "session.create",
            Some(json!({
                "sessionId": session_id,
                "engine": "powershell",
                "cols": 80,
                "rows": 24,
            })),
            &mut channels,
        )
        .expect("session.create");
        let channel_id = created["channelId"].as_u64().unwrap() as u32;

        // Verify extended Channel 0 RPCs (`set_presentation`, `find_text`, `recent_text`, `clear_vt`, `core.status`)
        let pres = handle_control_rpc_request(
            "session.set_presentation",
            Some(json!({ "sessionId": session_id, "live": true })),
            &mut channels,
        )
        .expect("session.set_presentation");
        assert_eq!(pres["ok"], true);
        assert_eq!(pres["live"], true);

        let found = handle_control_rpc_request(
            "session.find_text",
            Some(json!({ "sessionId": session_id, "query": "ps", "limit": 10 })),
            &mut channels,
        )
        .expect("session.find_text");
        assert!(found.get("hits").is_some());

        let recent = handle_control_rpc_request(
            "session.recent_text",
            Some(json!({ "sessionId": session_id })),
            &mut channels,
        )
        .expect("session.recent_text");
        assert!(recent.get("text").is_some());

        let status = handle_control_rpc_request("core.status", None, &mut channels)
            .expect("core.status");
        assert_eq!(status["protocol"], CORE_PROTOCOL_VERSION);
        assert!(status.get("dataPlane").is_some(), "core.status must carry dataPlane");

        // Verify provider quiesce and respawn RPCs over Channel 0
        let quiesced = handle_control_rpc_request(
            "session.quiesce_provider",
            Some(json!({ "provider": "isolated_test_provider" })),
            &mut channels,
        )
        .expect("session.quiesce_provider");
        assert!(quiesced.as_array().is_some());

        let _ = handle_control_rpc_request(
            "session.respawn_provider",
            Some(json!({
                "provider": "isolated_test_provider",
                "newAccountLabel": "Test",
                "quiesced": quiesced,
            })),
            &mut channels,
        )
        .expect("session.respawn_provider");

        let _ = handle_control_rpc_request(
            "session.clear_vt",
            Some(json!({ "sessionId": session_id })),
            &mut channels,
        )
        .expect("session.clear_vt");

        // Verify `ClientRoutes` early frame buffering and O(1) push cache extraction
        let snap_bytes = crate::terminal::poll_terminal_snapshot_bin_local_bytes(&session_id, None);
        assert!(!snap_bytes.is_empty());
        let mut client_routes = ClientRoutes::default();
        client_routes
            .early_frames
            .entry(channel_id)
            .or_default()
            .push(Frame::new(channel_id, FrameKind::SnapshotBin, snap_bytes.clone()));

        client_routes.channels.insert(channel_id, session_id.clone());
        if let Some(early) = client_routes.early_frames.remove(&channel_id) {
            for f in early {
                let act = apply_pushed_channel_frame_locked(&mut client_routes, &session_id, f);
                assert!(act.is_some());
            }
        }
        let cached = client_routes
            .sessions
            .get_mut(&session_id)
            .and_then(|s| s.latest_snapshot_bin.take())
            .expect("pushed SNAPSHOT_BIN must be cached in ClientSessionSlot");
        assert_eq!(cached, snap_bytes);

        let _ = handle_control_rpc_request(
            "session.terminate",
            Some(json!({ "sessionId": session_id })),
            &mut channels,
        );
    }
}
