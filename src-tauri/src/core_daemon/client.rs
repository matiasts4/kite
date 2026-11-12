use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};

use crate::core_wire::{
    decode_close_payload, decode_facts_payload, decode_rpc_payload, encode_credit_frame,
    encode_focus_frame, encode_resize_frame, encode_rpc_frame, Frame, FrameKind,
    FrameStreamDecoder,
};
use crate::logger::log_trace;

use super::credits::{
    grant_session_snapshot_credit, is_external_daemon_owner, CORE_DAEMON_OWNER,
};
use super::pipe::{
    get_core_pipe_name, get_or_create_core_token, CoreHandshakeResponse, CORE_PROTOCOL_VERSION,
};
use super::server::run_core_daemon_main;

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
pub(crate) struct ClientRoutes {
    pub(crate) closed: bool,
    pub(crate) core_pid: u32,
    pub(crate) replies: HashMap<u64, std::sync::mpsc::Sender<Result<Value, String>>>,
    pub(crate) channels: HashMap<u32, String>,
    pub(crate) sessions: HashMap<String, ClientSessionSlot>,
    /// Frames pushed on `channel_id >= 1` before the caller registered `channel_id -> session_id`.
    pub(crate) early_frames: HashMap<u32, Vec<Frame>>,
}

pub struct CoreConnection {
    writer: tokio::sync::mpsc::UnboundedSender<Vec<u8>>,
    pub(crate) routes: std::sync::Arc<Mutex<ClientRoutes>>,
    next_id: std::sync::atomic::AtomicU64,
}

static CORE_CONNECTION: OnceLock<Mutex<Option<std::sync::Arc<CoreConnection>>>> = OnceLock::new();

pub(crate) fn core_connection_slot() -> &'static Mutex<Option<std::sync::Arc<CoreConnection>>> {
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

pub(crate) fn apply_pushed_channel_frame_locked(
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
