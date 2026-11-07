use crate::logger::log_trace;
use crate::persist::workspace_path;
use crate::session_resolver::{
    canonical_agent_engine, claude_session_file_exists, detect_child_agent_in_shell,
    choose_restore_provider_id, get_persisted_terminal_session, is_generic_shell_engine,
    restore_grok_provider_id,
    read_persisted_terminal_sessions, remove_persisted_terminal_session,
    resolve_provider_session_id_with_context, upsert_persisted_terminal_session,
    upsert_persisted_terminal_session_clearing_provider, write_persisted_terminal_sessions,
    PersistedTerminalSession,
};
use portable_pty::{native_pty_system, Child as PtyChild, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use uuid::Uuid;

pub fn to_base64(data: &[u8]) -> String {
    const CHARSET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as usize;
        let b1 = chunk.get(1).copied().unwrap_or(0) as usize;
        let b2 = chunk.get(2).copied().unwrap_or(0) as usize;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(CHARSET[(triple >> 18) & 63] as char);
        out.push(CHARSET[(triple >> 12) & 63] as char);
        if chunk.len() > 1 {
            out.push(CHARSET[(triple >> 6) & 63] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(CHARSET[triple & 63] as char);
        } else {
            out.push('=');
        }
    }
    out
}

const MAX_SCROLLBACK_BYTES: usize = 256 * 1024;
static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

// Benchmark data-plane telemetry atomic counters. Every recorder is gated on
// BENCH_ACTIVE so an unset benchmark run pays only one relaxed load per event.
static BENCH_ACTIVE: AtomicBool = AtomicBool::new(false);
static BENCH_PTY_BYTES_READ: AtomicU64 = AtomicU64::new(0);
static BENCH_VT_FEED_CALLS: AtomicU64 = AtomicU64::new(0);
static BENCH_VT_FEED_DURATION_US_SUM: AtomicU64 = AtomicU64::new(0);
static BENCH_VT_FEED_DURATIONS: Mutex<Vec<u64>> = Mutex::new(Vec::new());
static BENCH_ACTIVITY_EVENTS_EMITTED: AtomicU64 = AtomicU64::new(0);
static BENCH_SNAPSHOT_POLLS: AtomicU64 = AtomicU64::new(0);
static BENCH_SNAPSHOT_PAYLOAD_BYTES: AtomicU64 = AtomicU64::new(0);

pub fn set_bench_active(active: bool) {
    BENCH_ACTIVE.store(active, Ordering::Relaxed);
}

pub fn is_bench_active() -> bool {
    BENCH_ACTIVE.load(Ordering::Relaxed)
}

pub fn bench_reset_counters() {
    BENCH_PTY_BYTES_READ.store(0, Ordering::Relaxed);
    BENCH_VT_FEED_CALLS.store(0, Ordering::Relaxed);
    BENCH_VT_FEED_DURATION_US_SUM.store(0, Ordering::Relaxed);
    BENCH_ACTIVITY_EVENTS_EMITTED.store(0, Ordering::Relaxed);
    BENCH_SNAPSHOT_POLLS.store(0, Ordering::Relaxed);
    BENCH_SNAPSHOT_PAYLOAD_BYTES.store(0, Ordering::Relaxed);
    if let Ok(mut lock) = BENCH_VT_FEED_DURATIONS.lock() {
        lock.clear();
    }
}

pub fn bench_record_pty_bytes(bytes: u64) {
    if !is_bench_active() {
        return;
    }
    BENCH_PTY_BYTES_READ.fetch_add(bytes, Ordering::Relaxed);
}

pub fn bench_record_vt_feed(duration_us: u64) {
    if !is_bench_active() {
        return;
    }
    BENCH_VT_FEED_CALLS.fetch_add(1, Ordering::Relaxed);
    BENCH_VT_FEED_DURATION_US_SUM.fetch_add(duration_us, Ordering::Relaxed);
    if let Ok(mut lock) = BENCH_VT_FEED_DURATIONS.lock() {
        if lock.len() >= 4096 {
            lock.drain(0..2048);
        }
        lock.push(duration_us);
    }
}

pub fn bench_record_activity_event() {
    if !is_bench_active() {
        return;
    }
    BENCH_ACTIVITY_EVENTS_EMITTED.fetch_add(1, Ordering::Relaxed);
}

pub fn bench_record_snapshot_poll(payload_bytes: u64) {
    if !is_bench_active() {
        return;
    }
    BENCH_SNAPSHOT_POLLS.fetch_add(1, Ordering::Relaxed);
    BENCH_SNAPSHOT_PAYLOAD_BYTES.fetch_add(payload_bytes, Ordering::Relaxed);
}

/// Serialized tests toggle the process-wide benchmark gate; they must not race
/// each other across modules.
#[cfg(test)]
pub(crate) fn bench_test_lock() -> &'static Mutex<()> {
    static LOCK: std::sync::OnceLock<Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalDataPlaneSnapshot {
    pub active_terminals: usize,
    pub live_visible_terminals: usize,
    pub pty_bytes_read_total: u64,
    pub vt_feed_calls_total: u64,
    pub vt_feed_duration_us_p95: f64,
    pub activity_events_emitted_total: u64,
    pub snapshot_polls_total: u64,
    pub snapshot_payload_bytes_total: u64,
}

pub fn get_terminal_data_plane_snapshot() -> TerminalDataPlaneSnapshot {
    if crate::core_daemon::is_external_daemon_owner() {
        if let Ok(res) = crate::core_daemon::send_core_daemon_rpc("core.status", None) {
            if let Some(plane) = res.get("dataPlane") {
                if let Ok(parsed) =
                    serde_json::from_value::<TerminalDataPlaneSnapshot>(plane.clone())
                {
                    return parsed;
                }
            }
        }
    }
    get_terminal_data_plane_local_snapshot()
}

pub fn get_terminal_data_plane_local_snapshot() -> TerminalDataPlaneSnapshot {
    let (active_terminals, live_visible_terminals) = {
        if let Ok(map) = get_terminals().lock() {
            let active = map.len();
            let live = map.values().filter(|inst| inst.presentation_live.load(Ordering::Relaxed)).count();
            (active, live)
        } else {
            (0, 0)
        }
    };

    let p95 = {
        if let Ok(lock) = BENCH_VT_FEED_DURATIONS.lock() {
            if lock.is_empty() {
                0.0
            } else {
                let mut sorted = lock.clone();
                sorted.sort_unstable();
                let idx = ((sorted.len() * 95) / 100).min(sorted.len() - 1);
                sorted[idx] as f64
            }
        } else {
            0.0
        }
    };

    TerminalDataPlaneSnapshot {
        active_terminals,
        live_visible_terminals,
        pty_bytes_read_total: BENCH_PTY_BYTES_READ.load(Ordering::Relaxed),
        vt_feed_calls_total: BENCH_VT_FEED_CALLS.load(Ordering::Relaxed),
        vt_feed_duration_us_p95: p95,
        activity_events_emitted_total: BENCH_ACTIVITY_EVENTS_EMITTED.load(Ordering::Relaxed),
        snapshot_polls_total: BENCH_SNAPSHOT_POLLS.load(Ordering::Relaxed),
        snapshot_payload_bytes_total: BENCH_SNAPSHOT_PAYLOAD_BYTES.load(Ordering::Relaxed),
    }
}

fn now_unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
struct TerminalAnsiMarkerCounts {
    #[serde(rename = "dec2026Start")]
    dec_2026_start: usize,
    #[serde(rename = "dec2026End")]
    dec_2026_end: usize,
    #[serde(rename = "altScreen1049Start")]
    alt_screen_1049_start: usize,
    #[serde(rename = "altScreen1049End")]
    alt_screen_1049_end: usize,
    #[serde(rename = "carriageReturn")]
    carriage_return: usize,
    #[serde(rename = "eraseJ")]
    erase_j: usize,
    #[serde(rename = "eraseK")]
    erase_k: usize,
    #[serde(rename = "cursorShow")]
    cursor_show: usize,
    #[serde(rename = "cursorHide")]
    cursor_hide: usize,
    osc: usize,
}

fn scan_terminal_ansi_markers(
    pending: &mut Vec<u8>,
    bytes: &[u8],
) -> TerminalAnsiMarkerCounts {
    let mut data = std::mem::take(pending);
    data.extend_from_slice(bytes);
    let mut counts = TerminalAnsiMarkerCounts::default();
    let mut index = 0;
    while index < data.len() {
        if data[index] != 0x1b {
            if data[index] == b'\r' {
                counts.carriage_return += 1;
            }
            index += 1;
            continue;
        }
        if index + 1 >= data.len() {
            *pending = data[index..].to_vec();
            break;
        }
        if data[index + 1] == b']' {
            let mut cursor = index + 2;
            let mut terminator_len = None;
            while cursor < data.len() {
                if data[cursor] == 0x07 {
                    terminator_len = Some(1);
                    break;
                }
                if data[cursor] == 0x1b && cursor + 1 < data.len() && data[cursor + 1] == b'\\' {
                    terminator_len = Some(2);
                    break;
                }
                cursor += 1;
            }
            let Some(length) = terminator_len else {
                *pending = data[index..].to_vec();
                break;
            };
            counts.osc += 1;
            index = cursor + length;
            continue;
        }
        if data[index + 1] != b'[' {
            index += 1;
            continue;
        }
        let mut cursor = index + 2;
        while cursor < data.len() && !(0x40..=0x7e).contains(&data[cursor]) {
            cursor += 1;
        }
        if cursor == data.len() {
            *pending = data[index..].to_vec();
            break;
        }
        let sequence = &data[index..=cursor];
        match sequence {
            b"\x1b[?2026h" => counts.dec_2026_start += 1,
            b"\x1b[?2026l" => counts.dec_2026_end += 1,
            b"\x1b[?1049h" => counts.alt_screen_1049_start += 1,
            b"\x1b[?1049l" => counts.alt_screen_1049_end += 1,
            b"\x1b[?25h" | b"\x1b[25h" => counts.cursor_show += 1,
            b"\x1b[?25l" | b"\x1b[25l" => counts.cursor_hide += 1,
            _ => {
                if data[cursor] == b'J' {
                    counts.erase_j += 1;
                } else if data[cursor] == b'K' {
                    counts.erase_k += 1;
                }
            }
        }
        index = cursor + 1;
    }
    counts
}

#[cfg_attr(not(test), allow(dead_code))]
fn count_terminal_ansi_markers(bytes: &[u8]) -> TerminalAnsiMarkerCounts {
    let mut pending = Vec::new();
    scan_terminal_ansi_markers(&mut pending, bytes)
}

fn terminal_capture_safe_filename(session_id: &str) -> String {
    let safe_id: String = session_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '_'
            }
        })
        .collect();
    let safe_id = if safe_id.is_empty() { "session" } else { &safe_id };
    format!("{safe_id}.jsonl")
}

fn terminal_capture_dir() -> Option<std::path::PathBuf> {
    let value = std::env::var_os("KITE_TERMINAL_CAPTURE_DIR")?;
    if value.is_empty() {
        return None;
    }
    Some(std::path::PathBuf::from(value))
}

fn append_terminal_capture_record(session_id: &str, record: serde_json::Value) {
    let Some(directory) = terminal_capture_dir() else {
        return;
    };
    static CAPTURE_LOCK: std::sync::OnceLock<Mutex<()>> = std::sync::OnceLock::new();
    let lock = CAPTURE_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if std::fs::create_dir_all(&directory).is_err() {
        return;
    }
    let path = directory.join(terminal_capture_safe_filename(session_id));
    static INITIALIZED_FILES: std::sync::OnceLock<Mutex<HashSet<std::path::PathBuf>>> =
        std::sync::OnceLock::new();
    let initialized = INITIALIZED_FILES.get_or_init(|| Mutex::new(HashSet::new()));
    let mut initialized_guard = initialized
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if !initialized_guard.contains(&path) {
        let Ok(_) = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&path)
        else {
            return;
        };
        initialized_guard.insert(path.clone());
    }
    drop(initialized_guard);
    let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) else {
        return;
    };
    let Ok(mut line) = serde_json::to_vec(&record) else {
        return;
    };
    line.push(b'\n');
    let _ = file.write_all(&line);
}

fn capture_terminal_lifecycle(
    session_id: &str,
    attached_to_existing: bool,
    requested_engine: Option<&str>,
    restore_kind: &str,
    scrollback_bytes: Option<usize>,
) {
    let Some(_) = terminal_capture_dir() else {
        return;
    };
    let (effective_engine, provider_session_id, workspace_id, pane_id, columns, rows) = {
        let map = get_terminals().lock().ok();
        let Some(map) = map else { return };
        let Some(instance) = map.get(session_id) else { return };
        (
            instance.engine.clone(),
            instance.provider_session_id.lock().ok().and_then(|id| id.clone()),
            instance.workspace_id.lock().ok().and_then(|id| id.clone()),
            instance.pane_id.lock().ok().and_then(|id| id.clone()),
            instance.cols.load(Ordering::Relaxed),
            instance.rows.load(Ordering::Relaxed),
        )
    };
    append_terminal_capture_record(
        session_id,
        serde_json::json!({
            "kind": "lifecycle",
            "sessionId": session_id,
            "attachedToExisting": attached_to_existing,
            "requestedEngine": requested_engine,
            "effectiveEngine": effective_engine,
            "providerSessionId": provider_session_id,
            "workspaceId": workspace_id,
            "paneId": pane_id,
            "columns": columns,
            "rows": rows,
            "restoreKind": restore_kind,
            "scrollbackBytes": scrollback_bytes,
            "resume": restore_kind == "restoredFromDisk",
            "capturedAtUnixMs": now_unix_ms(),
        }),
    );
}

fn capture_terminal_output(
    session_id: &str,
    instance: &TerminalInstance,
    bytes: &[u8],
    captured_at_unix_ms: i64,
) -> u64 {
    if bytes.is_empty() {
        return instance.sequence.fetch_add(1, Ordering::SeqCst);
    }
    if terminal_capture_dir().is_none() {
        return instance.sequence.fetch_add(1, Ordering::SeqCst);
    }
    let sequence = instance.sequence.fetch_add(1, Ordering::SeqCst);
    let provider_session_id = instance
        .provider_session_id
        .lock()
        .ok()
        .and_then(|id| id.clone());
    let workspace_id = instance.workspace_id.lock().ok().and_then(|id| id.clone());
    let pane_id = instance.pane_id.lock().ok().and_then(|id| id.clone());
    let ansi_markers = instance
        .ansi_scan_tail
        .lock()
        .map(|mut pending| scan_terminal_ansi_markers(&mut pending, bytes))
        .unwrap_or_default();
    append_terminal_capture_record(
        session_id,
        serde_json::json!({
            "kind": "output",
            "sessionId": session_id,
            "engine": instance.engine.clone(),
            "providerSessionId": provider_session_id,
            "workspaceId": workspace_id,
            "paneId": pane_id,
            "columns": instance.cols.load(Ordering::Relaxed),
            "rows": instance.rows.load(Ordering::Relaxed),
            "capturedAtUnixMs": captured_at_unix_ms,
            "sequence": sequence,
            "byteOffset": instance
                .output_byte_offset
                .fetch_add(bytes.len() as u64, Ordering::SeqCst),
            "byteLength": bytes.len(),
            "rawBytesBase64": to_base64(bytes),
            "ansiMarkers": ansi_markers,
        }),
    );
    sequence
}

fn emit_terminal_activity(session_id: &str, seq: u64, exited: bool, exit_code: Option<i64>) {
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

fn emit_terminal_activity_to_webview(
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

fn notify_terminal_exit(session_id: &str, inst: &TerminalInstance, code: i64) {
    if inst.exit_notified.swap(true, Ordering::Relaxed) {
        return;
    }
    inst.lifecycle_stop.store(true, Ordering::Relaxed);
    let seq = inst.vt_engine.lock().ok().map(|vt| vt.seq()).unwrap_or(0);
    emit_terminal_activity(session_id, seq, true, Some(code));
}

fn try_child_exit(inst: &TerminalInstance) -> Option<i64> {
    let mut child = inst.child.lock().ok()?;
    match child.try_wait() {
        Ok(Some(status)) => Some(status.exit_code() as i64),
        _ => None,
    }
}

fn maybe_bind_provider_session(session_id: &str, inst: &Arc<TerminalInstance>) {
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

fn schedule_paint_activity(session_id: &str, inst: &Arc<TerminalInstance>, seq: u64) {
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

fn spawn_terminal_lifecycle(session_id: String, inst: Arc<TerminalInstance>) {
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

fn spawn_pty_reader(
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

pub fn terminal_scrollback_dir() -> std::path::PathBuf {
    let base = std::env::var("APPDATA").unwrap_or_else(|_| r"C:\Users\PC\AppData\Roaming".into());
    let folder = if cfg!(debug_assertions) {
        "Kite Code Dev"
    } else {
        "Kite Code"
    };
    let dir = std::path::PathBuf::from(base).join(folder).join("terminals");
    let _ = std::fs::create_dir_all(&dir);
    static PRUNED: std::sync::OnceLock<()> = std::sync::OnceLock::new();
    PRUNED.get_or_init(|| {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            let now = std::time::SystemTime::now();
            for entry in entries.flatten() {
                if let Ok(meta) = entry.metadata() {
                    if let Ok(modified) = meta.modified() {
                        if let Ok(age) = now.duration_since(modified) {
                            if age.as_secs() > 7 * 86400 {
                                let _ = std::fs::remove_file(entry.path());
                            }
                        }
                    }
                }
            }
        }
    });
    dir
}

pub fn scrollback_path_for_session(session_id: &str) -> std::path::PathBuf {
    let safe_id: String = session_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    terminal_scrollback_dir().join(format!("{}.scrollback", safe_id))
}

pub fn read_scrollback_file(session_id: &str) -> Option<Vec<u8>> {
    let path = scrollback_path_for_session(session_id);
    if path.is_file() {
        std::fs::read(&path).ok().filter(|b| !b.is_empty())
    } else {
        None
    }
}

pub fn write_scrollback_file(session_id: &str, bytes: &[u8]) {
    let path = scrollback_path_for_session(session_id);
    let _ = std::fs::write(path, bytes);
}

pub fn terminal_recent_text(session_id: &str) -> String {
    if session_id.is_empty() {
        return String::new();
    }
    if should_proxy_to_core_daemon(session_id) {
        if let Ok(res) = crate::core_daemon::send_core_daemon_rpc(
            "session.recent_text",
            Some(serde_json::json!({ "sessionId": session_id })),
        ) {
            if let Some(text) = res.get("text").and_then(|v| v.as_str()) {
                return text.to_string();
            }
        }
    }
    terminal_recent_text_local(session_id)
}

pub fn terminal_recent_text_local(session_id: &str) -> String {
    if session_id.is_empty() {
        return String::new();
    }
    let inst = {
        let map = get_terminals().lock().unwrap();
        map.get(session_id).cloned()
    };
    let bytes = if let Some(inst) = inst {
        let screen = inst
            .vt_engine
            .lock()
            .ok()
            .map(|vt| vt.screen_text())
            .unwrap_or_default();
        if !screen.trim().is_empty() {
            return screen;
        }
        // Same lock order as the reader: buffer, then scrollback. The grid lock is already dropped.
        let pending = inst.buffer.lock().ok().map(|buf| buf.clone()).unwrap_or_default();
        let scroll = inst
            .scrollback
            .lock()
            .ok()
            .map(|buf| buf.clone())
            .unwrap_or_default();
        if scroll.is_empty() { pending } else { scroll }
    } else {
        read_scrollback_file(session_id).unwrap_or_default()
    };
    let start = bytes.len().saturating_sub(64 * 1024);
    plain_terminal_text(&bytes[start..])
}

fn plain_terminal_text(bytes: &[u8]) -> String {
    let mut kept = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == 0x1b {
            i += 1;
            if i >= bytes.len() {
                break;
            }
            match bytes[i] {
                b'[' => {
                    i += 1;
                    while i < bytes.len() {
                        let c = bytes[i];
                        i += 1;
                        if (0x40..=0x7e).contains(&c) {
                            break;
                        }
                    }
                }
                b']' => {
                    i += 1;
                    while i < bytes.len() {
                        if bytes[i] == 0x07 {
                            i += 1;
                            break;
                        }
                        if bytes[i] == 0x1b && i + 1 < bytes.len() && bytes[i + 1] == b'\\' {
                            i += 2;
                            break;
                        }
                        i += 1;
                    }
                }
                _ => i += 1,
            }
            continue;
        }
        if b == b'\r' || b == 0x08 || (b < 0x20 && b != b'\n' && b != b'\t') {
            if b == 0x08 {
                kept.pop();
            }
            i += 1;
            continue;
        }
        kept.push(b);
        i += 1;
    }
    String::from_utf8_lossy(&kept).replace('\u{0}', "")
}

#[cfg(test)]
mod plain_terminal_text_tests {
    use super::plain_terminal_text;

    #[test]
    fn dispatch_read_strips_color_and_keeps_lines() {
        let raw = b"hello \x1b[31mred\x1b[0m\r\nnext";
        assert_eq!(plain_terminal_text(raw), "hello red\nnext");
    }
}

pub fn delete_scrollback_file(session_id: &str) {
    let path = scrollback_path_for_session(session_id);
    let _ = std::fs::remove_file(path);
}

#[derive(Debug, Clone)]
pub enum SpawnMode {
    Fresh,
    Resume {
        provider_session_id: Option<String>,
        allow_continue_fallback: bool,
        hybrid_shell_agent: Option<String>,
    },
}

#[derive(Debug, Clone)]
pub struct SpawnOptions {
    pub cols: u16,
    pub rows: u16,
    pub workspace_id: Option<String>,
    pub pane_id: Option<String>,
    pub mode: SpawnMode,
    pub initial_prompt: Option<String>,
    pub auto_approve: bool,
    pub system_prompt: Option<String>,
    /// When set, this argv is the process. The agent CLI is not also started.
    pub raw_argv: Option<Vec<String>>,
}

impl Default for SpawnOptions {
    fn default() -> Self {
        Self {
            cols: 80,
            rows: 24,
            workspace_id: None,
            pane_id: None,
            mode: SpawnMode::Fresh,
            initial_prompt: None,
            auto_approve: false,
            system_prompt: None,
            raw_argv: None,
        }
    }
}

pub struct TerminalInstance {
    pub master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    pub writer: Arc<Mutex<Box<dyn Write + Send>>>,
    pub child: Arc<Mutex<Box<dyn PtyChild + Send>>>,
    pub buffer: Arc<Mutex<Vec<u8>>>,
    pub scrollback: Arc<Mutex<Vec<u8>>>,
    pub vt_engine: Arc<Mutex<crate::vt_engine::TerminalVtEngine>>,
    pub sequence: AtomicU64,
    pub output_byte_offset: AtomicU64,
    pub output_capture_order: Mutex<()>,
    pub ansi_scan_tail: Mutex<Vec<u8>>,
    pub cwd: String,
    pub live_cwd: Arc<Mutex<String>>,
    pub engine: String,
    pub detected_agent_engine: Arc<Mutex<Option<String>>>,
    pub provider_session_id: Arc<Mutex<Option<String>>>,
    pub workspace_id: Mutex<Option<String>>,
    pub pane_id: Mutex<Option<String>>,
    pub spawned_at_unix_ms: i64,
    /// OS process id of the PTY root child, captured at spawn time.
    pub root_pid: u32,
    pub had_user_activity: AtomicBool,
    pub input_line_buffer: Mutex<String>,
    pub last_user_input: Mutex<Option<String>>,
    pub last_bind_attempt_ms: AtomicU64,
    pub bind_attempts: std::sync::atomic::AtomicU32,
    pub cols: std::sync::atomic::AtomicU16,
    pub rows: std::sync::atomic::AtomicU16,
    /// When false, paint wakes stop. The PTY and the VT engine keep running.
    pub presentation_live: AtomicBool,
    pub exit_notified: AtomicBool,
    pub lifecycle_stop: AtomicBool,
    pub last_paint_emit_ms: AtomicU64,
    pub paint_flush_armed: AtomicBool,
}

pub fn get_terminals() -> &'static Mutex<HashMap<String, Arc<TerminalInstance>>> {
    static INSTANCE: std::sync::OnceLock<Mutex<HashMap<String, Arc<TerminalInstance>>>> =
        std::sync::OnceLock::new();
    INSTANCE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Root shell PIDs of every open terminal session. Benchmark attribution uses
/// these as lineage anchors for the workload and PTY-host buckets.
pub fn get_terminal_root_pids() -> HashSet<u32> {
    let mut roots = HashSet::new();
    if let Ok(map) = get_terminals().lock() {
        for inst in map.values() {
            if let Ok(child) = inst.child.lock() {
                if let Some(pid) = child.process_id() {
                    roots.insert(pid);
                }
            }
        }
    }
    roots.extend(crate::core_daemon::get_client_session_root_pids());
    roots
}

pub fn get_session_resolve_lock() -> &'static Mutex<()> {
    static LOCK: std::sync::OnceLock<Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

pub fn get_globally_claimed_provider_ids(current_session_id: &str) -> HashSet<String> {
    let mut claimed = HashSet::new();

    if let Ok(map) = get_terminals().lock() {
        for (sid, inst) in map.iter() {
            if sid != current_session_id {
                if let Ok(p) = inst.provider_session_id.lock() {
                    if let Some(ref pid) = *p {
                        if !pid.is_empty() {
                            claimed.insert(pid.clone());
                        }
                    }
                }
            }
        }
    }

    let persisted_map = read_persisted_terminal_sessions();
    for (sid, session) in persisted_map {
        if sid != current_session_id {
            if let Some(ref pid) = session.provider_session_id {
                if !pid.is_empty() {
                    claimed.insert(pid.clone());
                }
            }
        }
    }

    claimed
}

fn snapshot_scrollback_for_attach(
    session_id: &str,
    inst: &TerminalInstance,
    preserve_unread_buffer: bool,
) -> Option<Vec<u8>> {
    let mut had_pending = false;
    let buf_guard = inst.buffer.lock().ok();
    let sb_guard = inst.scrollback.lock().ok();
    if let Some(mut buf) = buf_guard {
        if !buf.is_empty() {
            had_pending = true;
            if !preserve_unread_buffer {
                buf.clear();
            }
        }
    }
    if let Some(sb) = sb_guard {
        if had_pending && !sb.is_empty() {
            write_scrollback_file(session_id, &sb);
        }
        if sb.is_empty() {
            None
        } else {
            Some(sb.clone())
        }
    } else {
        None
    }
}

pub fn try_bind_provider_session_id(session_id: &str, inst: &TerminalInstance) -> Option<String> {
    let _resolve_guard = get_session_resolve_lock()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    inst.last_bind_attempt_ms
        .store(now_unix_ms() as u64, Ordering::Relaxed);

    let root_pid = inst.child.lock().ok().and_then(|c| c.process_id());
    let detected_child = if is_generic_shell_engine(&inst.engine) {
        let child = root_pid.and_then(detect_child_agent_in_shell);
        if let Some(ref c) = child {
            inst.had_user_activity.store(true, Ordering::Relaxed);
            if let Ok(mut det) = inst.detected_agent_engine.lock() {
                *det = Some(c.clone());
            }
        } else {
            // For a generic shell, if no child agent is running, don't allow a stale or
            // false-positive text detection to persist as an active agent engine.
            let has_bound_prov = inst
                .provider_session_id
                .lock()
                .ok()
                .and_then(|p| p.clone())
                .is_some();
            if !has_bound_prov {
                if let Ok(mut det) = inst.detected_agent_engine.lock() {
                    *det = None;
                }
            }
        }
        child
    } else {
        None
    };

    let engine = if is_generic_shell_engine(&inst.engine) {
        detected_child
            .or_else(|| {
                let has_bound = inst
                    .provider_session_id
                    .lock()
                    .ok()
                    .and_then(|p| p.clone())
                    .is_some();
                if has_bound {
                    inst.detected_agent_engine.lock().ok().and_then(|d| d.clone())
                } else {
                    None
                }
            })
            .unwrap_or_else(|| canonical_agent_engine(&inst.engine))
    } else {
        inst.detected_agent_engine
            .lock()
            .ok()
            .and_then(|d| d.clone())
            .unwrap_or_else(|| canonical_agent_engine(&inst.engine))
    };

    let cwd = inst
        .live_cwd
        .lock()
        .ok()
        .map(|c| c.clone())
        .filter(|c| !c.is_empty())
        .unwrap_or_else(|| inst.cwd.clone());

    let last_input = inst.last_user_input.lock().ok().and_then(|l| l.clone());
    let ws_id = inst.workspace_id.lock().ok().and_then(|w| w.clone());
    let p_id = inst.pane_id.lock().ok().and_then(|p| p.clone());
    let had_activity = inst.had_user_activity.load(Ordering::Relaxed);

    if is_generic_shell_engine(&engine) {
        if had_activity {
            upsert_persisted_terminal_session(PersistedTerminalSession {
                session_id: session_id.to_string(),
                workspace_id: ws_id,
                pane_id: p_id,
                base_engine: inst.engine.clone(),
                active_engine: engine,
                provider_session_id: None,
                cwd,
                had_user_activity: true,
                last_user_input: last_input,
                spawned_at_unix_ms: inst.spawned_at_unix_ms,
                saved_at_unix_ms: now_unix_ms(),
            });
        }
        return None;
    }

    // Flush any unread output into scrollback so transcript/scrollback matching has the latest bytes
    let _ = snapshot_scrollback_for_attach(session_id, inst, false);

    let existing_prov = inst.provider_session_id.lock().ok().and_then(|p| p.clone());
    if let Some(ref pid) = existing_prov {
        return Some(pid.clone());
    }

    let claimed_ids = get_globally_claimed_provider_ids(session_id);
    let resolved = resolve_provider_session_id_with_context(
        &engine,
        &cwd,
        session_id,
        existing_prov.as_deref(),
        inst.spawned_at_unix_ms,
        &claimed_ids,
        root_pid,
        last_input.as_deref(),
    );

    if let Some(ref pid) = resolved {
        if let Ok(mut p) = inst.provider_session_id.lock() {
            *p = Some(pid.clone());
        }
        log_trace(&format!(
            "try_bind_provider_session_id: bound session {} to provider id {}",
            session_id, pid
        ));
    }

    let final_prov = resolved.clone().or(existing_prov);
    if had_activity || final_prov.is_some() {
        upsert_persisted_terminal_session(PersistedTerminalSession {
            session_id: session_id.to_string(),
            workspace_id: ws_id,
            pane_id: p_id,
            base_engine: inst.engine.clone(),
            active_engine: engine,
            provider_session_id: final_prov.clone(),
            cwd,
            had_user_activity: had_activity || final_prov.is_some(),
            last_user_input: last_input,
            spawned_at_unix_ms: inst.spawned_at_unix_ms,
            saved_at_unix_ms: now_unix_ms(),
        });
    }

    final_prov
}

fn is_agent_cli_engine(engine: &str) -> bool {
    let canonical = canonical_agent_engine(engine);
    matches!(
        canonical.as_str(),
        "claude-code" | "codex" | "gemini" | "open-code" | "cursor" | "grok" | "antigravity"
    ) || !program_names(&canonical).is_empty()
        || !program_names(engine.trim()).is_empty()
}

fn program_names(engine: &str) -> &'static [&'static str] {
    match engine {
        "claude-code" | "claude" => &["claude"],
        "codex" => &["codex"],
        "cursor" => &["cursor-agent", "agent"],
        "gemini" => &["gemini"],
        "github-copilot" => &["copilot"],
        "droid" => &["droid"],
        "open-code" | "opencode" => &["opencode"],
        "deep-seek" | "deepseek" => &["deepseek"],
        "grok" => &["grok"],
        "kimi" => &["kimi"],
        "amp" => &["amp"],
        "antigravity" | "agy" => &["agy"],
        "gentle-shell" | "gentleshell" | "gentle" | "gentle-pi" => &["gentle-shell", "pi"],
        "aider" => &["aider"],
        "muse" => &["muse"],
        _ => &[],
    }
}

fn resolve_raw_program(word: &str) -> Option<String> {
    let path = std::path::Path::new(word);
    if path.is_file() {
        return Some(word.to_string());
    }
    where_program(word)
}

/// `Ok(None)` means this start is not a raw argv. `Err` means the executable is missing.
fn raw_argv_from_request(req: &serde_json::Value) -> Result<Option<Vec<String>>, ()> {
    let Some(items) = req.get("argv").and_then(|value| value.as_array()) else {
        return Ok(None);
    };
    let argv: Vec<String> = items
        .iter()
        .filter_map(|value| value.as_str().map(str::to_string))
        .collect();
    let Some(program) = argv.first().map(|word| word.trim()).filter(|word| !word.is_empty()) else {
        return Err(());
    };
    if resolve_raw_program(program).is_none() {
        return Err(());
    }
    Ok(Some(argv))
}

fn search_path_var(name: &str, path_var: Option<std::ffi::OsString>) -> Option<String> {
    let path_var = path_var?;
    let path_exts: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC".to_string())
            .split(';')
            .filter(|ext| !ext.is_empty())
            .map(|ext| ext.to_lowercase())
            .collect()
    } else {
        Vec::new()
    };

    for dir in std::env::split_paths(&path_var) {
        let direct = dir.join(name);
        if direct.is_file() {
            return Some(direct.to_string_lossy().to_string());
        }
        if cfg!(windows) {
            for ext in &path_exts {
                let with_ext = dir.join(format!("{}{}", name, ext));
                if with_ext.is_file() {
                    return Some(with_ext.to_string_lossy().to_string());
                }
            }
        }
    }
    None
}

fn parse_reg_path_output(stdout: &str) -> Option<String> {
    for line in stdout.lines() {
        let marker = if line.contains("REG_EXPAND_SZ") {
            "REG_EXPAND_SZ"
        } else if line.contains("REG_SZ") {
            "REG_SZ"
        } else {
            continue;
        };
        if let Some(idx) = line.find(marker) {
            let val = line[idx + marker.len()..].trim();
            if !val.is_empty() {
                return Some(val.to_string());
            }
        }
    }
    None
}

#[cfg(windows)]
fn query_registry_path(key: &str, val_name: &str) -> Option<String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let output = Command::new("reg")
        .args(["query", key, "/v", val_name])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    parse_reg_path_output(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(windows)]
fn fresh_registry_path() -> Option<std::ffi::OsString> {
    static CACHED: std::sync::OnceLock<Option<std::ffi::OsString>> = std::sync::OnceLock::new();
    CACHED
        .get_or_init(|| {
            let query_keys = [
                ("HKCU\\Environment", "Path"),
                (
                    "HKLM\\System\\CurrentControlSet\\Control\\Session Manager\\Environment",
                    "Path",
                ),
            ];
            let mut parts = Vec::new();
            for (key, val_name) in query_keys {
                if let Some(val) = query_registry_path(key, val_name) {
                    parts.push(val);
                }
            }
            if parts.is_empty() {
                None
            } else {
                Some(std::ffi::OsString::from(parts.join(";")))
            }
        })
        .clone()
}

fn where_program(name: &str) -> Option<String> {
    if let Some(found) = search_path_var(name, std::env::var_os("PATH")) {
        return Some(found);
    }
    #[cfg(windows)]
    {
        if let Some(fresh_path) = fresh_registry_path() {
            if let Some(found) = search_path_var(name, Some(fresh_path.clone())) {
                if let Ok(curr) = std::env::var("PATH") {
                    let updated = format!("{};{}", fresh_path.to_string_lossy(), curr);
                    std::env::set_var("PATH", updated);
                }
                return Some(found);
            }
        }
    }
    None
}

fn known_program_path(name: &str) -> Option<String> {
    let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
    let appdata = std::env::var("APPDATA").unwrap_or_default();
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    let mut candidates = Vec::new();
    if name == "agy" {
        candidates.push(
            std::path::PathBuf::from(&local)
                .join("agy")
                .join("bin")
                .join("agy.exe"),
        );
    }
    if name == "codex" {
        candidates.push(
            std::path::PathBuf::from(&local)
                .join("Programs")
                .join("OpenAI")
                .join("codex.exe"),
        );
    }
    if name == "grok" {
        candidates.push(
            std::path::PathBuf::from(&home)
                .join(".grok")
                .join("bin")
                .join("grok.exe"),
        );
        candidates.push(
            std::path::PathBuf::from(&home)
                .join(".grok")
                .join("bin")
                .join("grok"),
        );
    }
    candidates.push(
        std::path::PathBuf::from(&home)
            .join(format!(".{name}"))
            .join("bin")
            .join(format!("{name}.exe")),
    );
    candidates.push(
        std::path::PathBuf::from(&home)
            .join(format!(".{name}"))
            .join("bin")
            .join(name),
    );
    candidates.push(
        std::path::PathBuf::from(&appdata)
            .join("npm")
            .join(format!("{name}.cmd")),
    );
    candidates.push(
        std::path::PathBuf::from(&home)
            .join(".local")
            .join("bin")
            .join(format!("{name}.exe")),
    );
    candidates.push(
        std::path::PathBuf::from(&home)
            .join(".local")
            .join("bin")
            .join(name),
    );
    candidates.push(
        std::path::PathBuf::from(&home)
            .join(".cargo")
            .join("bin")
            .join(format!("{name}.exe")),
    );
    candidates.push(
        std::path::PathBuf::from(&home)
            .join(".cargo")
            .join("bin")
            .join(name),
    );
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .map(|path| path.to_string_lossy().into_owned())
}

pub fn engine_installed(engine: &str) -> bool {
    resolve_engine_program(engine).is_some()
}

pub fn resolve_engine_program(engine: &str) -> Option<String> {
    for name in program_names(engine) {
        if let Some(path) = known_program_path(name).or_else(|| where_program(name)) {
            return Some(path);
        }
    }
    None
}

const AGENT_TERMINAL_TERM: &str = "xterm-256color";
const AGENT_TERMINAL_UTF8_PREAMBLE: &str =
    "$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); chcp 65001 > $null; $env:TERM = 'xterm-256color';";

fn build_agent_launch_command(program: &str, agent_args: &[String]) -> String {
    let quoted_program = program.replace('\'', "''");
    let quoted_args: Vec<String> = agent_args
        .iter()
        .map(|arg| format!("'{}'", arg.replace('\'', "''")))
        .collect();
    let launch = if quoted_args.is_empty() {
        format!("& '{quoted_program}'")
    } else {
        format!("& '{quoted_program}' {}", quoted_args.join(" "))
    };
    format!("{AGENT_TERMINAL_UTF8_PREAMBLE} {launch}")
}

/// Returns the native executable that should be the ConPTY child for an agent.
/// A `.exe`/`.com` is used as-is. An npm `.cmd` shim is followed to the `.exe`
/// it launches (`"%dp0%\...\tool.exe" %*`). Anything else (scripts run through
/// an interpreter) yields `None` and keeps the PowerShell wrapper.
fn resolve_direct_agent_executable(program: &str) -> Option<std::path::PathBuf> {
    let path = std::path::Path::new(program);
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "exe" | "com" => path.is_file().then(|| path.to_path_buf()),
        "cmd" | "bat" => {
            let shim_dir = path.parent()?;
            let text = std::fs::read_to_string(path).ok()?;
            text.lines().find_map(|line| {
                let lower = line.to_lowercase();
                let start = lower.find("%dp0%")?;
                let rest = &line[start + "%dp0%".len()..];
                let end = rest.to_lowercase().find(".exe")? + ".exe".len();
                let relative = rest[..end].trim_start_matches(['\\', '/']);
                let candidate = shim_dir.join(relative.replace('/', "\\"));
                candidate.is_file().then_some(candidate)
            })
        }
        _ => None,
    }
}

/// Builds the ConPTY child command for an agent CLI. Preferred: the agent
/// executable itself, with no intermediate PowerShell console host. Fallback:
/// the historical `powershell.exe -NoExit -Command` wrapper, logged so a
/// fallback is never mistaken for a direct launch.
fn build_agent_command(
    program: &str,
    agent_args: &[String],
    cwd: &std::path::Path,
) -> (CommandBuilder, &'static str) {
    if let Some(exe) = resolve_direct_agent_executable(program) {
        log_trace(&format!(
            "agent_launch: direct ConPTY child exe={} args={}",
            exe.display(),
            agent_args.len()
        ));
        let mut c = CommandBuilder::new(exe.as_os_str());
        c.cwd(cwd);
        c.args(agent_args);
        return (c, "direct");
    }
    log_trace(&format!(
        "WARN agent_launch: no native executable behind {program}; using PowerShell wrapper"
    ));
    let mut c = CommandBuilder::new("powershell.exe");
    c.cwd(cwd);
    let launch = build_agent_launch_command(program, agent_args);
    c.args(["-NoLogo", "-NoExit", "-Command", &launch]);
    (c, "powershell")
}

/// Builds the CLI arguments for launching or resuming an AI agent engine.
/// Note: We intentionally avoid `--continue` / `resume --last` when `provider_session_id` is `None`,
/// because in multi-pane workspaces `--continue` causes panes without a bound ID to hijack
/// whichever other conversation happens to be unlocked or second-most-recent in the workspace.
pub fn build_agent_cli_args(
    engine: &str,
    session_id: &str,
    cwd: &str,
    mode: &SpawnMode,
) -> (Vec<String>, Option<String>) {
    build_agent_cli_args_ext(engine, session_id, cwd, mode, None, false, None)
}

pub fn build_agent_cli_args_ext(
    engine: &str,
    session_id: &str,
    cwd: &str,
    mode: &SpawnMode,
    initial_prompt: Option<&str>,
    auto_approve: bool,
    system_prompt: Option<&str>,
) -> (Vec<String>, Option<String>) {
    let canonical = canonical_agent_engine(engine);
    let mut args: Vec<String> = Vec::new();
    let mut bound_id: Option<String> = None;

    match mode {
        SpawnMode::Fresh => {
            match canonical.as_str() {
                "grok" => {
                    if auto_approve {
                        args.push("--always-approve".to_string());
                    }
                    if let Some(sys) = system_prompt {
                        args.push("--system-prompt-override".to_string());
                        args.push(sys.to_string());
                    }
                    if let Some(prompt) = initial_prompt {
                        args.push(prompt.to_string());
                    }
                }
                "codex" => {
                    if auto_approve {
                        args.push("--approve-for-me".to_string());
                    }
                    if let Some(prompt) = initial_prompt {
                        args.push(prompt.to_string());
                    }
                }
                "antigravity" => {
                    if auto_approve {
                        args.push("--dangerously-skip-permissions".to_string());
                    }
                    if let Some(prompt) = initial_prompt {
                        args.push("-i".to_string());
                        args.push(prompt.to_string());
                    }
                }
                "claude-code" => {
                    let target_uuid = if Uuid::parse_str(session_id).is_ok() {
                        session_id.to_string()
                    } else {
                        Uuid::new_v4().to_string()
                    };
                    args.push("--session-id".to_string());
                    args.push(target_uuid.clone());
                    bound_id = Some(target_uuid);

                    if auto_approve {
                        args.push("--permission-mode".to_string());
                        args.push("bypassPermissions".to_string());
                    }
                    if let Some(sys) = system_prompt {
                        args.push("--system-prompt".to_string());
                        args.push(sys.to_string());
                    }
                    if let Some(prompt) = initial_prompt {
                        args.push(prompt.to_string());
                    }
                }
                "open-code" => {
                    if auto_approve {
                        args.push("--auto".to_string());
                    }
                    if let Some(prompt) = initial_prompt {
                        args.push("--prompt".to_string());
                        args.push(prompt.to_string());
                    }
                }
                "gentle-shell" => {
                    args.push("--tui-mode".to_string());
                    args.push("regular".to_string());
                    if auto_approve {
                        args.push("--approve".to_string());
                    }
                    if let Some(prompt) = initial_prompt {
                        args.push(prompt.to_string());
                    }
                }
                _ => {
                    if let Some(prompt) = initial_prompt {
                        args.push(prompt.to_string());
                    }
                }
            }
        }
        SpawnMode::Resume {
            provider_session_id,
            allow_continue_fallback,
            ..
        } => {
            match canonical.as_str() {
                "antigravity" => {
                    if let Some(id) = provider_session_id.as_deref().filter(|s| !s.is_empty()) {
                        args.push("--conversation".to_string());
                        args.push(id.to_string());
                        bound_id = Some(id.to_string());
                    }
                    if auto_approve {
                        args.push("--dangerously-skip-permissions".to_string());
                    }
                    if let Some(prompt) = initial_prompt {
                        args.push("-i".to_string());
                        args.push(prompt.to_string());
                    }
                }
                "codex" => {
                    if let Some(id) = provider_session_id.as_deref().filter(|s| !s.is_empty()) {
                        args.push("resume".to_string());
                        args.push(id.to_string());
                        bound_id = Some(id.to_string());
                    }
                    if auto_approve {
                        args.push("--approve-for-me".to_string());
                    }
                    if let Some(prompt) = initial_prompt {
                        args.push(prompt.to_string());
                    }
                }
                "claude-code" => {
                    let candidate_id = provider_session_id
                        .as_deref()
                        .filter(|s| !s.is_empty())
                        .or_else(|| {
                            if Uuid::parse_str(session_id).is_ok() {
                                Some(session_id)
                            } else {
                                None
                            }
                        });
                    if let Some(id) = candidate_id {
                        if claude_session_file_exists(cwd, id) {
                            args.push("--resume".to_string());
                            args.push(id.to_string());
                            bound_id = Some(id.to_string());
                        } else {
                            let fresh_uuid = candidate_id
                                .filter(|id| Uuid::parse_str(id).is_ok())
                                .map(str::to_string)
                                .unwrap_or_else(|| Uuid::new_v4().to_string());
                            args.push("--session-id".to_string());
                            args.push(fresh_uuid.clone());
                            bound_id = Some(fresh_uuid);
                        }
                    } else {
                        let fresh_uuid = Uuid::new_v4().to_string();
                        args.push("--session-id".to_string());
                        args.push(fresh_uuid.clone());
                        bound_id = Some(fresh_uuid);
                    }
                    if auto_approve {
                        args.push("--permission-mode".to_string());
                        args.push("bypassPermissions".to_string());
                    }
                    if let Some(sys) = system_prompt {
                        args.push("--system-prompt".to_string());
                        args.push(sys.to_string());
                    }
                    if let Some(prompt) = initial_prompt {
                        args.push(prompt.to_string());
                    }
                }
                "open-code" => {
                    if let Some(id) = provider_session_id.as_deref().filter(|s| !s.is_empty()) {
                        args.push("--session".to_string());
                        args.push(id.to_string());
                        bound_id = Some(id.to_string());
                    }
                    if auto_approve {
                        args.push("--auto".to_string());
                    }
                    if let Some(prompt) = initial_prompt {
                        args.push("--prompt".to_string());
                        args.push(prompt.to_string());
                    }
                }
                "grok" => {
                    if let Some(id) = provider_session_id.as_deref().filter(|s| !s.is_empty()) {
                        args.push("-r".to_string());
                        args.push(id.to_string());
                        bound_id = Some(id.to_string());
                    }
                    if auto_approve {
                        args.push("--always-approve".to_string());
                    }
                    if let Some(sys) = system_prompt {
                        args.push("--system-prompt-override".to_string());
                        args.push(sys.to_string());
                    }
                    if let Some(prompt) = initial_prompt {
                        args.push(prompt.to_string());
                    }
                }
                "gemini" => {
                    if let Some(id_or_path) = provider_session_id.as_deref().filter(|s| !s.is_empty()) {
                        if std::path::Path::new(id_or_path).is_file() {
                            args.push("--session-file".to_string());
                            args.push(id_or_path.to_string());
                            bound_id = Some(id_or_path.to_string());
                        }
                    }
                }
                "kimi" => {
                    if let Some(id) = provider_session_id.as_deref().filter(|s| !s.is_empty()) {
                        args.push("--session".to_string());
                        args.push(id.to_string());
                        bound_id = Some(id.to_string());
                    }
                }
                "cursor" | "droid" => {
                    if let Some(id) = provider_session_id.as_deref().filter(|s| !s.is_empty()) {
                        args.push("--resume".to_string());
                        args.push(id.to_string());
                        bound_id = Some(id.to_string());
                    }
                }
                "aider" => {
                    if *allow_continue_fallback || provider_session_id.is_some() {
                        args.push("--restore-chat-history".to_string());
                    }
                }
                "gentle-shell" => {
                    args.push("--tui-mode".to_string());
                    args.push("regular".to_string());
                    if let Some(id) = provider_session_id.as_deref().filter(|s| !s.is_empty()) {
                        args.push("--session".to_string());
                        args.push(id.to_string());
                        bound_id = Some(id.to_string());
                    } else if *allow_continue_fallback {
                        args.push("--continue".to_string());
                    }
                    if auto_approve {
                        args.push("--approve".to_string());
                    }
                    if let Some(prompt) = initial_prompt {
                        args.push(prompt.to_string());
                    }
                }
                _ => {}
            }
        }
    }

    (args, bound_id)
}

/// Scans PTY output chunks for OSC 9;9;<path>\x07 or OSC 7;file://... sequences to track live CWD.
pub fn extract_osc_cwd(bytes: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(bytes);
    // Look for OSC 9;9;<path> terminated by BEL (\x07) or ST (\x1b\\)
    if let Some(idx) = text.rfind("\x1b]9;9;") {
        let after = &text[idx + 6..];
        let end = after
            .find('\x07')
            .or_else(|| after.find("\x1b\\"))
            .unwrap_or(0);
        if end > 0 {
            let candidate = after[..end].trim().trim_matches('"');
            if !candidate.is_empty() && std::path::Path::new(candidate).is_dir() {
                return Some(candidate.to_string());
            }
        }
    }
    None
}

pub fn spawn_session(session_id: &str, cwd: &str, engine: &str) -> Arc<TerminalInstance> {
    spawn_session_with_size(session_id, cwd, engine, 80, 24)
}

pub fn spawn_session_with_size(
    session_id: &str,
    cwd: &str,
    engine: &str,
    cols: u16,
    rows: u16,
) -> Arc<TerminalInstance> {
    spawn_session_with_options(
        session_id,
        cwd,
        engine,
        SpawnOptions {
            cols,
            rows,
            auto_approve: is_agent_cli_engine(engine),
            ..Default::default()
        },
    )
}

/// Puts the complete dispatch manual on a known agent.
/// A system-prompt engine receives it as that argument, including on resume.
/// Any other known agent receives it in the birth prompt. A resume does not
/// turn that text into a new task. A raw argv is left untouched.
fn attach_dispatch_manual(
    engine: &str,
    raw: bool,
    resume: bool,
    system_prompt: Option<String>,
    initial_prompt: Option<String>,
) -> (Option<String>, Option<String>) {
    if raw {
        return (system_prompt, initial_prompt);
    }
    if crate::dispatch::programs::accepts_system_prompt(engine) {
        let system_prompt =
            system_prompt.or_else(|| Some(crate::dispatch::cli::skill_text().to_string()));
        return (system_prompt, initial_prompt);
    }
    if resume || crate::dispatch::programs::canonical(engine).is_none() {
        return (system_prompt, initial_prompt);
    }
    if initial_prompt
        .as_deref()
        .unwrap_or("")
        .contains("Kite Dispatch")
    {
        return (system_prompt, initial_prompt);
    }
    let manual = crate::dispatch::cli::skill_text();
    let initial_prompt = Some(match initial_prompt {
        Some(task) if !task.trim().is_empty() => format!("{manual}\n\n{task}"),
        _ => manual.to_string(),
    });
    (system_prompt, initial_prompt)
}

pub fn spawn_session_with_options(
    session_id: &str,
    cwd: &str,
    engine: &str,
    options: SpawnOptions,
) -> Arc<TerminalInstance> {
    let requested_cols = options.cols;
    let requested_rows = options.rows;
    let hybrid_engine = match &options.mode {
        SpawnMode::Resume { hybrid_shell_agent, .. } => hybrid_shell_agent.as_deref(),
        SpawnMode::Fresh => None,
    };
    let is_agent_cli =
        is_agent_cli_engine(engine) || hybrid_engine.is_some_and(is_agent_cli_engine);
    // The agent is born at the geometry the pane measured. A wider spawn followed by
    // a resize to the real width raced the agent's startup: OpenCode read 80 columns,
    // then the host shrank to 42 before it listened, so it drew 80-column frames into
    // a 42-column ConPTY (captured 2026-11-01).
    let (cols, rows) = (requested_cols, requested_rows);
    log_trace(&format!(
        "spawn_session: session_id={}, cwd={}, engine={}, cols={}, rows={}, mode={:?}",
        session_id, cwd, engine, cols, rows, options.mode
    ));
    let current = std::env::current_dir().ok();
    let target_dir = if std::path::Path::new(cwd).is_dir() {
        std::path::PathBuf::from(cwd)
    } else {
        current.unwrap_or_else(|| std::path::PathBuf::from(cwd))
    };
    let target_dir_str = target_dir.to_string_lossy().into_owned();

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: if rows == 0 { 24 } else { rows },
            cols: if cols == 0 { 80 } else { cols },
            pixel_width: 0,
            pixel_height: 0,
        })
        .expect("failed to open pty");

    let hybrid_agent_opt = match &options.mode {
        SpawnMode::Resume {
            hybrid_shell_agent: Some(agent),
            provider_session_id: Some(_),
            ..
        } if is_generic_shell_engine(engine) && !is_generic_shell_engine(agent) => {
            Some(agent.clone())
        }
        _ => None,
    };

    let resume = matches!(options.mode, SpawnMode::Resume { .. });
    let raw = options
        .raw_argv
        .as_ref()
        .filter(|argv| !argv.is_empty())
        .is_some();
    let manual_engine = hybrid_agent_opt.as_deref().unwrap_or(engine);
    let (system_prompt, initial_prompt) = attach_dispatch_manual(
        manual_engine,
        raw,
        resume,
        options.system_prompt.clone(),
        options.initial_prompt.clone(),
    );

    let mut initial_provider_id: Option<String> = None;
    let mut initial_detected_agent: Option<String> = None;

    let mut agent_terminal = false;
    let mut launcher = "powershell";
    let mut resolved_program_path: Option<String> = None;
    let mut cmd = if let Some(argv) = options.raw_argv.as_ref().filter(|argv| !argv.is_empty()) {
        let mut c = CommandBuilder::new(&argv[0]);
        if argv.len() > 1 {
            c.args(&argv[1..]);
        }
        c.cwd(&target_dir);
        launcher = "raw";
        c
    } else if let Some(ref hybrid_agent) = hybrid_agent_opt {
        // Hybrid shell resume: open PowerShell in the saved CWD and automatically invoke the agent's resume command
        let (agent_args, bound_id) = build_agent_cli_args_ext(
            hybrid_agent,
            session_id,
            &target_dir_str,
            &options.mode,
            initial_prompt.as_deref(),
            options.auto_approve,
            system_prompt.as_deref(),
        );
        initial_provider_id = bound_id;
        initial_detected_agent = Some(canonical_agent_engine(hybrid_agent));

        if let Some(program) = resolve_engine_program(hybrid_agent) {
            resolved_program_path = Some(program.clone());
            agent_terminal = true;
            let (built, kind) = build_agent_command(&program, &agent_args, &target_dir);
            launcher = kind;
            built
        } else {
            let mut c = CommandBuilder::new("powershell.exe");
            c.cwd(&target_dir);
            c.args(["-NoLogo"]);
            c
        }
    } else if let Some(program) = resolve_engine_program(engine) {
        resolved_program_path = Some(program.clone());
        agent_terminal = true;
        let (agent_args, bound_id) = build_agent_cli_args_ext(
            engine,
            session_id,
            &target_dir_str,
            &options.mode,
            initial_prompt.as_deref(),
            options.auto_approve,
            system_prompt.as_deref(),
        );
        initial_provider_id = bound_id;
        initial_detected_agent = Some(canonical_agent_engine(engine));
        let (built, kind) = build_agent_command(&program, &agent_args, &target_dir);
        launcher = kind;
        built
    } else if is_generic_shell_engine(engine) {
        let mut c = CommandBuilder::new("powershell.exe");
        c.cwd(&target_dir);
        c.args(["-NoLogo"]);
        c
    } else {
        let mut c = CommandBuilder::new("powershell.exe");
        c.cwd(&target_dir);
        let looked_for = program_names(engine).join(", ");
        let hint = format!(
            "Write-Host '{engine} was not found ({looked_for}).' -ForegroundColor Yellow"
        );
        c.args([
            "-NoLogo",
            "-NoExit",
            "-Command",
            &hint,
        ]);
        c
    };

    cmd.env("KITE_ENV", "1");
    cmd.env("KITE_SESSION_ID", session_id);
    cmd.env("KITE_DISPATCH", "1");
    let dispatch_address = format!("session:{session_id}");
    cmd.env("KITE_ADDRESS", &dispatch_address);
    let skill = crate::dispatch::cli::install_dispatch_skill();
    cmd.env("KITE_SKILL_FILE", skill.display().to_string());
    let bin = crate::dispatch::cli::install_kite_shim();
    let inherited = std::env::var("PATH").unwrap_or_default();
    let mut path_parts = vec![bin.display().to_string()];
    if let Some(ref prog) = resolved_program_path {
        if let Some(parent) = std::path::Path::new(prog).parent() {
            let p_str = parent.display().to_string();
            if !inherited.to_lowercase().contains(&p_str.to_lowercase()) {
                path_parts.push(p_str);
            }
        }
    }
    if !inherited.is_empty() {
        path_parts.push(inherited);
    }
    let sep = if cfg!(windows) { ";" } else { ":" };
    let path_value = path_parts.join(sep);
    cmd.env("PATH", &path_value);
    cmd.env("AGY_CLI_DISABLE_AUTO_UPDATE", "true");
    if agent_terminal {
        cmd.env("TERM", AGENT_TERMINAL_TERM);
    }
    if let Some(ref ws_id) = options.workspace_id {
        cmd.env("KITE_WORKSPACE_ID", ws_id);
    }
    if let Some(ref p_id) = options.pane_id {
        cmd.env("KITE_PANE_ID", p_id);
    }

    // Inject API credentials from the Kite vault into the agent terminal if not already present in env
    for &var_name in crate::credentials::provider_env_vars(engine) {
        if std::env::var(var_name).is_err() {
            if let Some((key, _)) = crate::credentials::resolve_provider_credential(engine) {
                cmd.env(var_name, key);
                break;
            }
        }
    }

    let trace_engine = initial_detected_agent
        .clone()
        .unwrap_or_else(|| engine.to_string());
    let launch_text = initial_prompt.as_deref().unwrap_or("");
    crate::dispatch::trace::record(&crate::dispatch::trace::handoff_event(
        "launch",
        launch_text,
        crate::dispatch::trace::Fields {
            op: "launch",
            session: session_id,
            engine: &trace_engine,
            status: "",
            pane: "",
            writes: if initial_prompt.is_some() { 1 } else { 0 },
            launcher,
            manual: crate::dispatch::trace::manual_label(system_prompt.is_some(), launch_text),
        },
    ));

    let child = pair
        .slave
        .spawn_command(cmd)
        .expect("failed to spawn command in pty");
    drop(pair.slave);
    let root_pid = child.process_id().unwrap_or(0);

    let reader = pair
        .master
        .try_clone_reader()
        .expect("failed to clone pty reader");
    let writer = Arc::new(Mutex::new(
        pair.master
            .take_writer()
            .expect("failed to take pty writer"),
    ));

    let buffer = Arc::new(Mutex::new(Vec::new()));

    let initial_scrollback = if is_agent_cli {
        delete_scrollback_file(session_id);
        Vec::new()
    } else {
        read_scrollback_file(session_id).unwrap_or_default()
    };
    let scrollback = Arc::new(Mutex::new(initial_scrollback));
    let live_cwd = Arc::new(Mutex::new(target_dir_str.clone()));

    let initial_cols = if cols == 0 { 80 } else { cols };
    let initial_rows = if rows == 0 { 24 } else { rows };
    let mut vt_engine_init = crate::vt_engine::TerminalVtEngine::new(initial_cols, initial_rows);
    if !is_agent_cli {
        if let Ok(sb_guard) = scrollback.lock() {
            if !sb_guard.is_empty() {
                vt_engine_init.feed(&sb_guard);
                let _ = vt_engine_init.take_replies();
            }
        }
    }
    let vt_engine = Arc::new(Mutex::new(vt_engine_init));

    let spawned_at_ms = now_unix_ms();
    let had_initial_activity = match &options.mode {
        SpawnMode::Resume {
            provider_session_id,
            allow_continue_fallback,
            ..
        } => provider_session_id.is_some() || *allow_continue_fallback,
        SpawnMode::Fresh => false,
    };

    let instance = Arc::new(TerminalInstance {
        master: Arc::new(Mutex::new(pair.master)),
        writer,
        child: Arc::new(Mutex::new(child)),
        buffer,
        scrollback,
        vt_engine,
        sequence: AtomicU64::new(0),
        output_byte_offset: AtomicU64::new(0),
        output_capture_order: Mutex::new(()),
        ansi_scan_tail: Mutex::new(Vec::new()),
        cwd: target_dir_str.clone(),
        live_cwd,
        engine: engine.to_string(),
        detected_agent_engine: Arc::new(Mutex::new(initial_detected_agent.clone())),
        provider_session_id: Arc::new(Mutex::new(initial_provider_id.clone())),
        workspace_id: Mutex::new(options.workspace_id.clone()),
        pane_id: Mutex::new(options.pane_id.clone()),
        spawned_at_unix_ms: spawned_at_ms,
        root_pid,
        had_user_activity: AtomicBool::new(had_initial_activity),
        input_line_buffer: Mutex::new(String::new()),
        last_user_input: Mutex::new(None),
        last_bind_attempt_ms: AtomicU64::new(0),
        bind_attempts: std::sync::atomic::AtomicU32::new(0),
        cols: std::sync::atomic::AtomicU16::new(if cols == 0 { 80 } else { cols }),
        rows: std::sync::atomic::AtomicU16::new(if rows == 0 { 24 } else { rows }),
        presentation_live: AtomicBool::new(true),
        exit_notified: AtomicBool::new(false),
        lifecycle_stop: AtomicBool::new(false),
        last_paint_emit_ms: AtomicU64::new(0),
        paint_flush_armed: AtomicBool::new(false),
    });

    let mut start_reader = false;
    if let Ok(mut map) = get_terminals().lock() {
        if map.contains_key(session_id) {
            if let Ok(mut child) = instance.child.lock() {
                let _ = child.kill();
            }
            if let Some(existing) = map.get(session_id) {
                return Arc::clone(existing);
            }
        } else {
            map.insert(session_id.to_string(), Arc::clone(&instance));
            start_reader = true;
        }
    }
    if start_reader {
        spawn_pty_reader(reader, Arc::clone(&instance), session_id.to_string());
        spawn_terminal_lifecycle(session_id.to_string(), Arc::clone(&instance));
    }

    // Record initial session metadata in terminal-sessions.json
    let active_eng = initial_detected_agent.unwrap_or_else(|| engine.to_string());
    let record = PersistedTerminalSession {
        session_id: session_id.to_string(),
        workspace_id: options.workspace_id,
        pane_id: options.pane_id,
        base_engine: engine.to_string(),
        active_engine: active_eng,
        provider_session_id: initial_provider_id,
        cwd: target_dir_str,
        had_user_activity: had_initial_activity,
        last_user_input: None,
        spawned_at_unix_ms: spawned_at_ms,
        saved_at_unix_ms: spawned_at_ms,
    };
    if matches!(options.mode, SpawnMode::Fresh) {
        upsert_persisted_terminal_session_clearing_provider(record);
    } else {
        upsert_persisted_terminal_session(record);
    }

    instance
}

#[tauri::command]
pub async fn start_terminal(request: serde_json::Value) -> serde_json::Value {
    start_terminal_sync(request)
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
            if let Some(ref ws_id) = workspace_id {
                if let Ok(mut w) = inst.workspace_id.lock() {
                    if w.is_none() {
                        *w = Some(ws_id.clone());
                    }
                }
            }
            if let Some(ref p_id) = pane_id {
                if let Ok(mut p) = inst.pane_id.lock() {
                    if p.is_none() {
                        *p = Some(p_id.clone());
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
        system_prompt = Some(crate::dispatch::cli::skill_text().to_string());
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

#[tauri::command]
pub async fn attach_terminal(request: serde_json::Value) -> serde_json::Value {
    attach_terminal_sync(request)
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
                if let Some(ref ws_id) = workspace_id {
                    if let Ok(mut w) = inst.workspace_id.lock() {
                        if w.is_none() {
                            *w = Some(ws_id.clone());
                        }
                    }
                }
                if let Some(ref p_id) = pane_id {
                    if let Ok(mut p) = inst.pane_id.lock() {
                        if p.is_none() {
                            *p = Some(p_id.clone());
                        }
                    }
                }
                if req_cols > 0 && req_rows > 0 {
                    let prev_cols = inst.cols.swap(req_cols, Ordering::Relaxed);
                    let prev_rows = inst.rows.swap(req_rows, Ordering::Relaxed);
                    if prev_cols != req_cols || prev_rows != req_rows {
                        if let Ok(master) = inst.master.lock() {
                            let _ = master.resize(PtySize {
                                rows: req_rows,
                                cols: req_cols,
                                pixel_width: 0,
                                pixel_height: 0,
                            });
                        }
                        if let Ok(mut vt) = inst.vt_engine.lock() {
                            vt.resize(req_cols, req_rows);
                        }
                    }
                }
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

#[tauri::command]
pub async fn read_terminal_output(request: serde_json::Value) -> serde_json::Value {
    read_terminal_output_sync(request)
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

#[tauri::command]
pub async fn write_terminal(request: serde_json::Value) -> serde_json::Value {
    write_terminal_sync(request)
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

#[tauri::command]
pub async fn resize_terminal(request: serde_json::Value) -> serde_json::Value {
    resize_terminal_sync(request)
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
fn take_terminal_output_buffer(inst: &TerminalInstance) -> Vec<u8> {
    inst.buffer
        .lock()
        .ok()
        .map(|mut buf| std::mem::take(&mut *buf))
        .unwrap_or_default()
}

fn attach_observed_bytes(mut value: serde_json::Value, bytes: &[u8]) -> serde_json::Value {
    if bytes.is_empty() {
        return value;
    }
    if let Some(obj) = value.as_object_mut() {
        obj.insert(
            "observedBytesBase64".to_string(),
            serde_json::Value::String(to_base64(bytes)),
        );
    }
    value
}

/// Every snapshot poll response carries the benchmark gate state so the
/// frontend collector can activate and deactivate itself without extra IPC.
pub fn attach_benchmark_active(
    mut value: serde_json::Value,
    bench_active: bool,
) -> serde_json::Value {
    if let Some(obj) = value.as_object_mut() {
        obj.insert(
            "benchmarkActive".to_string(),
            serde_json::Value::Bool(bench_active),
        );
    }
    value
}

#[tauri::command]
pub async fn poll_terminal_snapshot(request: serde_json::Value) -> serde_json::Value {
    poll_terminal_snapshot_sync(request)
}

pub fn poll_terminal_snapshot_sync(request: serde_json::Value) -> serde_json::Value {
    let req = request.get("request").unwrap_or(&request);
    let session_id = req.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
    if should_proxy_to_core_daemon(session_id) {
        if let Ok(res) =
            crate::core_daemon::send_core_daemon_rpc("session.poll_snapshot", Some(req.clone()))
        {
            return res;
        }
    }
    poll_terminal_snapshot_local_sync(request)
}

pub fn poll_terminal_snapshot_local_sync(request: serde_json::Value) -> serde_json::Value {
    let req = request.get("request").unwrap_or(&request);
    let session_id = req.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
    let since_seq = req.get("sinceSeq").and_then(|v| v.as_u64()).unwrap_or(0);

    let instance = {
        let map = get_terminals().lock().unwrap();
        map.get(session_id).cloned()
    };

    if let Some(inst) = instance {
        let (exited, exit_code) = if let Ok(mut child) = inst.child.lock() {
            if let Ok(Some(status)) = child.try_wait() {
                (true, Some(status.exit_code() as i64))
            } else {
                (false, None)
            }
        } else {
            (false, None)
        };

        if let Ok(mut vt) = inst.vt_engine.lock() {
            let pending_replies = vt.take_replies();
            let res = vt.get_snapshot_diff(since_seq, exited, exit_code);
            let timeout_notes = vt.take_dec2026_timeouts();
            drop(vt);
            log_dec2026_timeouts(session_id, timeout_notes);
            if !pending_replies.is_empty() {
                if let Ok(mut w) = inst.writer.lock() {
                    let _ = w.write_all(&pending_replies);
                    let _ = w.flush();
                }
            }
            let observed = take_terminal_output_buffer(&inst);
            let snapshot_val = serde_json::to_value(&res).unwrap_or(serde_json::Value::Null);
            let bench_active = is_bench_active();
            let res_val = attach_benchmark_active(
                attach_observed_bytes(snapshot_val, &observed),
                bench_active,
            );
            // Measuring payload size is benchmark-only work: skip the second
            // serialization entirely when no run is active.
            let payload_bytes = if bench_active {
                serde_json::to_string(&res_val)
                    .map(|s| s.len() as u64)
                    .unwrap_or(0)
            } else {
                0
            };
            bench_record_snapshot_poll(payload_bytes);
            return res_val;
        }
    }

    let bench_active = is_bench_active();
    bench_record_snapshot_poll(if bench_active { 64 } else { 0 });
    attach_benchmark_active(
        serde_json::json!({
            "kind": "unchanged",
            "seq": since_seq,
            "exited": false,
            "exitCode": serde_json::Value::Null
        }),
        bench_active,
    )
}

// ---------------------------------------------------------------------------
// Binary snapshot polling (`SNAPSHOT_BIN`)
// ---------------------------------------------------------------------------

static LAST_BIN_POLLED_SEQ: std::sync::OnceLock<Mutex<HashMap<String, u64>>> =
    std::sync::OnceLock::new();

fn last_bin_polled_seq() -> &'static Mutex<HashMap<String, u64>> {
    LAST_BIN_POLLED_SEQ.get_or_init(|| Mutex::new(HashMap::new()))
}

fn record_bin_polled_seq(session_id: &str, seq: u64) {
    if let Ok(mut map) = last_bin_polled_seq().lock() {
        map.insert(session_id.to_string(), seq);
    }
}

fn bin_polled_seq(session_id: &str) -> u64 {
    last_bin_polled_seq()
        .lock()
        .ok()
        .and_then(|map| map.get(session_id).copied())
        .unwrap_or(0)
}

/// Returns the sequence number of output a binary client has not received yet.
fn unpolled_bin_seq(session_id: &str) -> Option<u64> {
    let instance = get_terminals()
        .lock()
        .ok()
        .and_then(|map| map.get(session_id).cloned())?;
    let vt = instance.vt_engine.lock().ok()?;
    let seq = vt.seq();
    if vt.has_pending_output() || seq > bin_polled_seq(session_id) {
        Some(seq)
    } else {
        None
    }
}

/// True when the VT grid advanced past the last `SNAPSHOT_BIN` frame delivered.
pub fn session_has_unpolled_output(session_id: &str) -> bool {
    unpolled_bin_seq(session_id).is_some()
}

/// Emits `terminal://activity` after a `CREDIT` replenishment re-armed a paused
/// binary channel, coalescing all dirty rows into exactly one wake-up (S2).
pub fn notify_session_credit_restored(session_id: &str) {
    if let Some(seq) = unpolled_bin_seq(session_id) {
        emit_terminal_activity(session_id, seq, false, None);
    }
}

/// Builds a `SNAPSHOT_BIN` frame payload for a session while applying every side
/// effect of `poll_terminal_snapshot_sync`: PTY query replies, DEC 2026 timeout
/// logging, observed output draining, and snapshot credit accounting.
///
/// Returns an empty payload when the session is gone, the grid is unchanged, or
/// the session's credit balance is exhausted. The VT engine keeps parsing either
/// way, so a paused channel resumes with one coalesced frame.
pub fn poll_terminal_snapshot_bin_bytes(session_id: &str, since_seq: Option<u64>) -> Vec<u8> {
    if should_proxy_to_core_daemon(session_id) {
        if let Some(pushed) = crate::core_daemon::take_client_cached_snapshot_bin(session_id) {
            bench_record_snapshot_poll(pushed.len() as u64);
            return pushed;
        }
        let params = serde_json::json!({ "sessionId": session_id, "sinceSeq": since_seq });
        match crate::core_daemon::send_core_daemon_rpc("session.poll_snapshot_bin", Some(params)) {
            Ok(res) => {
                return res
                    .get("bytesBase64")
                    .and_then(|v| v.as_str())
                    .and_then(decode_base64)
                    .unwrap_or_default();
            }
            Err(_) => return Vec::new(),
        }
    }
    poll_terminal_snapshot_bin_local_bytes(session_id, since_seq)
}

/// In-process `SNAPSHOT_BIN` builder used by the daemon that owns the PTYs.
pub fn poll_terminal_snapshot_bin_local_bytes(session_id: &str, since_seq: Option<u64>) -> Vec<u8> {
    let instance = {
        let Ok(map) = get_terminals().lock() else {
            return Vec::new();
        };
        map.get(session_id).cloned()
    };
    let Some(inst) = instance else {
        return Vec::new();
    };

    let (exited, exit_code) = if let Ok(mut child) = inst.child.lock() {
        if let Ok(Some(status)) = child.try_wait() {
            (true, Some(status.exit_code() as i64))
        } else {
            (false, None)
        }
    } else {
        (false, None)
    };

    let has_credit = crate::core_daemon::has_session_snapshot_credit(session_id);
    let mut pending_replies = Vec::new();
    let mut timeout_notes = Vec::new();
    let mut render_held = false;
    let mut response = None;
    if let Ok(mut vt) = inst.vt_engine.lock() {
        pending_replies = vt.take_replies();
        timeout_notes = vt.take_dec2026_timeouts();
        render_held = vt.render_held();
        if has_credit {
            response = Some(vt.get_snapshot_diff(since_seq.unwrap_or(0), exited, exit_code));
        }
    }
    log_dec2026_timeouts(session_id, timeout_notes);
    if !pending_replies.is_empty() {
        if let Ok(mut writer) = inst.writer.lock() {
            let _ = writer.write_all(&pending_replies);
            let _ = writer.flush();
        }
    }

    let observed = take_terminal_output_buffer(&inst);
    if !observed.is_empty() {
        maybe_bind_provider_session(session_id, &inst);
    }

    let Some(crate::vt_engine::TerminalSnapshotPollResponse::Snapshot { snapshot, .. }) = response else {
        return Vec::new();
    };
    if !crate::core_daemon::try_consume_session_snapshot_credit(session_id) {
        return Vec::new();
    }

    let bench_active = is_bench_active();
    let observed_bytes_base64 = if observed.is_empty() {
        None
    } else {
        Some(to_base64(&observed))
    };
    let bytes = crate::vt_engine::serialize_render_snapshot_bin(
        &snapshot,
        exited,
        exit_code,
        render_held,
        bench_active,
        observed_bytes_base64,
    );
    record_bin_polled_seq(session_id, snapshot.seq);
    bench_record_snapshot_poll(bytes.len() as u64);
    bytes
}

#[tauri::command]
pub async fn set_terminal_presentation(request: serde_json::Value) -> serde_json::Value {
    set_terminal_presentation_sync(request)
}
pub fn set_terminal_presentation_sync(request: serde_json::Value) -> serde_json::Value {
    let req = request.get("request").unwrap_or(&request);
    let session_id = req.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
    let live = req.get("live").and_then(|v| v.as_bool()).unwrap_or(false);
    if should_proxy_to_core_daemon(session_id) {
        if crate::core_daemon::send_client_session_focus(session_id, live) {
            return serde_json::json!({ "ok": true, "live": live });
        }
        if let Ok(res) =
            crate::core_daemon::send_core_daemon_rpc("session.set_presentation", Some(req.clone()))
        {
            return res;
        }
    }
    set_terminal_presentation_local_sync(request)
}

pub fn set_terminal_presentation_local_sync(request: serde_json::Value) -> serde_json::Value {
    let req = request.get("request").unwrap_or(&request);
    let session_id = req.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
    let live = req.get("live").and_then(|v| v.as_bool()).unwrap_or(false);
    let instance = {
        let map = get_terminals().lock().unwrap();
        map.get(session_id).cloned()
    };
    if let Some(inst) = instance {
        inst.presentation_live.store(live, Ordering::Relaxed);
        if let Ok(mut vt) = inst.vt_engine.lock() {
            vt.set_canvas_active(live);
        }
        if live {
            let seq = inst.vt_engine.lock().ok().map(|vt| vt.seq()).unwrap_or(0);
            emit_terminal_activity(session_id, seq, false, None);
        }
    }
    serde_json::json!({ "ok": instance_exists(session_id), "live": live })
}

fn instance_exists(session_id: &str) -> bool {
    get_terminals()
        .lock()
        .ok()
        .and_then(|map| map.get(session_id).cloned())
        .is_some()
}

/// True when this process owns a live PTY registry entry for the session.
pub fn has_local_terminal_instance(session_id: &str) -> bool {
    instance_exists(session_id)
}

/// True when a detached `kite-core` owns the PTYs and this process must forward
/// terminal operations over the control pipe instead of touching a local map.
fn should_proxy_to_core_daemon(session_id: &str) -> bool {
    !session_id.is_empty()
        && crate::core_daemon::is_external_daemon_owner()
        && !has_local_terminal_instance(session_id)
}

fn log_dec2026_timeouts(session_id: &str, notes: Vec<crate::vt_engine::Dec2026TimeoutNotice>) {
    for note in notes {
        log_trace(&format!(
            "WARN dec2026_timeout: session_id={session_id}, held_ms={}, seq={}",
            note.held_ms, note.seq
        ));
    }
}

fn terminal_log_dir() -> std::path::PathBuf {
    let base = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| r"C:\Users\PC\AppData\Local".into());
    let folder = if cfg!(debug_assertions) {
        "Kite Code Dev"
    } else {
        "Kite Code"
    };
    let dir = std::path::PathBuf::from(base).join(folder);
    let _ = std::fs::create_dir_all(&dir);
    dir
}

#[tauri::command]
pub async fn scroll_terminal_viewport(
    request: serde_json::Value,
) -> Result<crate::vt_engine::RenderSnapshot, String> {
    scroll_terminal_viewport_sync(request)
}

/// Scrolls the viewport and returns one packed `SNAPSHOT_BIN` frame.
///
/// The JSON command stays for hosts that do not have this command yet. A scroll
/// must not come back empty after the viewport moved, or the client would issue
/// a second scroll.
#[tauri::command]
pub async fn scroll_terminal_viewport_bin(
    request: serde_json::Value,
) -> Result<tauri::ipc::Response, String> {
    Ok(tauri::ipc::Response::new(scroll_terminal_viewport_bin_bytes(
        request,
    )?))
}

pub fn scroll_terminal_viewport_bin_bytes(request: serde_json::Value) -> Result<Vec<u8>, String> {
    let req = request.get("request").unwrap_or(&request);
    let session_id = req.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
    if should_proxy_to_core_daemon(session_id) {
        let res = crate::core_daemon::send_core_daemon_rpc(
            "session.scroll_viewport_bin",
            Some(req.clone()),
        )?;
        return Ok(res
            .get("bytesBase64")
            .and_then(|value| value.as_str())
            .and_then(decode_base64)
            .unwrap_or_default());
    }
    Ok(scroll_terminal_viewport_bin_local_bytes(request))
}

pub fn scroll_terminal_viewport_bin_local_bytes(request: serde_json::Value) -> Vec<u8> {
    let session_id = request
        .get("request")
        .unwrap_or(&request)
        .get("sessionId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let snapshot = match scroll_terminal_viewport_local_sync(request) {
        Ok(snapshot) => snapshot,
        Err(_) => return Vec::new(),
    };
    let bytes = crate::vt_engine::serialize_render_snapshot_bin(
        &snapshot,
        false,
        None,
        false,
        is_bench_active(),
        None,
    );
    if !session_id.is_empty() {
        record_bin_polled_seq(&session_id, snapshot.seq);
    }
    bench_record_snapshot_poll(bytes.len() as u64);
    bytes
}

pub fn scroll_terminal_viewport_sync(
    request: serde_json::Value,
) -> Result<crate::vt_engine::RenderSnapshot, String> {
    let req = request.get("request").unwrap_or(&request);
    let session_id = req.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
    if should_proxy_to_core_daemon(session_id) {
        if let Ok(res) =
            crate::core_daemon::send_core_daemon_rpc("session.scroll_viewport", Some(req.clone()))
        {
            if let Ok(snap) = serde_json::from_value(res) {
                return Ok(snap);
            }
        }
    }
    scroll_terminal_viewport_local_sync(request)
}

pub fn scroll_terminal_viewport_local_sync(
    request: serde_json::Value,
) -> Result<crate::vt_engine::RenderSnapshot, String> {
    let req = request.get("request").unwrap_or(&request);
    let session_id = req.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
    let delta_lines = req.get("deltaLines").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
    let absolute_offset = req.get("absoluteOffset").and_then(|v| v.as_u64());
    if session_id.is_empty() {
        return Err("Session not found".to_string());
    }

    let inst = {
        let manager = get_terminals().lock().map_err(|e| e.to_string())?;
        manager
            .get(session_id)
            .cloned()
            .ok_or_else(|| "Session not found".to_string())?
    };
    let mut vt = inst.vt_engine.lock().map_err(|e| e.to_string())?;
    let prev_seq = vt.seq();
    if let Some(offset) = absolute_offset {
        vt.jump_scrollback(offset as u32);
    } else {
        vt.scroll_viewport(delta_lines);
    }
    let response = vt.get_snapshot_diff(prev_seq, false, None);
    let notes = vt.take_dec2026_timeouts();
    let snapshot = match response {
        crate::vt_engine::TerminalSnapshotPollResponse::Snapshot { snapshot, .. } => Ok(snapshot),
        crate::vt_engine::TerminalSnapshotPollResponse::Unchanged { .. } => {
            match vt.get_snapshot_diff(0, false, None) {
                crate::vt_engine::TerminalSnapshotPollResponse::Snapshot { snapshot, .. } => Ok(snapshot),
                crate::vt_engine::TerminalSnapshotPollResponse::Unchanged { seq, .. } => {
                    Err(format!("scroll produced no snapshot at seq {seq}"))
                }
            }
        }
    };
    drop(vt);
    log_dec2026_timeouts(session_id, notes);
    snapshot
}

#[tauri::command]
pub async fn find_terminal_text(request: serde_json::Value) -> Result<serde_json::Value, String> {
    find_terminal_text_sync(request)
}

pub fn find_terminal_text_sync(request: serde_json::Value) -> Result<serde_json::Value, String> {
    let req = request.get("request").unwrap_or(&request);
    let session_id = req.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
    if should_proxy_to_core_daemon(session_id) {
        if let Ok(res) =
            crate::core_daemon::send_core_daemon_rpc("session.find_text", Some(req.clone()))
        {
            return Ok(res);
        }
    }
    find_terminal_text_local_sync(request)
}

pub fn find_terminal_text_local_sync(
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let req = request.get("request").unwrap_or(&request);
    let session_id = req.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
    let query = req.get("query").and_then(|v| v.as_str()).unwrap_or("");
    let limit = req.get("limit").and_then(|v| v.as_u64()).unwrap_or(40) as usize;
    if session_id.is_empty() {
        return Err("Session not found".to_string());
    }
    let inst = {
        let manager = get_terminals().lock().map_err(|e| e.to_string())?;
        manager
            .get(session_id)
            .cloned()
            .ok_or_else(|| "Session not found".to_string())?
    };
    let mut vt = inst.vt_engine.lock().map_err(|e| e.to_string())?;
    let hits = vt.find_text(query, limit);
    Ok(serde_json::json!({ "hits": hits }))
}

#[tauri::command]
pub async fn dump_terminal_diagnostics(request: serde_json::Value) -> Result<String, String> {
    let req = request.get("request").unwrap_or(&request);
    let session_id = req
        .get("sessionId")
        .or_else(|| req.get("session_id"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if should_proxy_to_core_daemon(session_id) {
        if let Ok(res) =
            crate::core_daemon::send_core_daemon_rpc("session.dump_diagnostics", Some(req.clone()))
        {
            if let Some(path) = res.get("path").and_then(|v| v.as_str()) {
                return Ok(path.to_string());
            }
        }
    }
    dump_terminal_diagnostics_local_sync(request)
}

pub fn dump_terminal_diagnostics_local_sync(request: serde_json::Value) -> Result<String, String> {
    let req = request.get("request").unwrap_or(&request);
    let session_id = req
        .get("sessionId")
        .or_else(|| req.get("session_id"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if session_id.is_empty() {
        return Err("Session not found".to_string());
    }
    let inst = {
        let manager = get_terminals().lock().map_err(|e| e.to_string())?;
        manager
            .get(&session_id)
            .cloned()
            .ok_or_else(|| "Session not found".to_string())?
    };
    let mut report = {
        let vt = inst.vt_engine.lock().map_err(|e| e.to_string())?;
        vt.diagnostic_report()
    };
    let scrollback_b64 = {
        let bytes = inst.scrollback.lock().map_err(|e| e.to_string())?;
        let start = bytes.len().saturating_sub(16 * 1024);
        to_base64(&bytes[start..])
    };
    if let Some(obj) = report.as_object_mut() {
        obj.insert("sessionId".to_string(), serde_json::Value::String(session_id.clone()));
        obj.insert(
            "scrollbackBase64".to_string(),
            serde_json::Value::String(scrollback_b64),
        );
    }
    let safe_id: String = session_id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect();
    let stamp = now_unix_ms();
    let path = terminal_log_dir().join(format!("terminal-diag-{safe_id}-{stamp}.json"));
    let body = serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| e.to_string())?;
    let path_str = path.to_string_lossy().to_string();
    log_trace(&format!(
        "dump_terminal_diagnostics: session_id={session_id}, path={path_str}"
    ));
    Ok(path_str)
}

#[tauri::command]
pub async fn clear_terminal_vt(request: serde_json::Value) -> serde_json::Value {
    clear_terminal_vt_sync(request)
}

pub fn clear_terminal_vt_sync(request: serde_json::Value) -> serde_json::Value {
    let req = request.get("request").unwrap_or(&request);
    let session_id = req.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
    if should_proxy_to_core_daemon(session_id) {
        if let Ok(res) =
            crate::core_daemon::send_core_daemon_rpc("session.clear_vt", Some(req.clone()))
        {
            return res;
        }
    }
    clear_terminal_vt_local_sync(request)
}

pub fn clear_terminal_vt_local_sync(request: serde_json::Value) -> serde_json::Value {
    let req = request.get("request").unwrap_or(&request);
    let session_id = req.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");

    let instance = {
        let map = get_terminals().lock().unwrap();
        map.get(session_id).cloned()
    };

    if let Some(inst) = instance {
        if let Ok(mut vt) = inst.vt_engine.lock() {
            vt.clear();
        }
    }
    serde_json::Value::Null
}

#[tauri::command]
pub fn report_terminal_agent_detected(request: serde_json::Value) -> serde_json::Value {
    let req = request.get("request").unwrap_or(&request);
    let session_id = req.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
    if should_proxy_to_core_daemon(session_id) {
        if let Ok(res) = crate::core_daemon::send_core_daemon_rpc(
            "session.report_agent_detected",
            Some(req.clone()),
        ) {
            return res;
        }
    }
    report_terminal_agent_detected_local(request)
}

pub fn report_terminal_agent_detected_local(request: serde_json::Value) -> serde_json::Value {
    let req = request.get("request").unwrap_or(&request);
    let session_id = req.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
    let engine = req.get("engine").and_then(|v| v.as_str()).unwrap_or("");
    if session_id.is_empty() || engine.is_empty() || is_generic_shell_engine(engine) {
        return serde_json::Value::Null;
    }

    let canonical = canonical_agent_engine(engine);
    let instance = {
        let map = get_terminals().lock().unwrap();
        map.get(session_id).cloned()
    };
    if let Some(inst) = instance {
        // If this terminal instance is a generic shell (e.g. powershell, cmd, bash, terminal),
        // we must not blindly trust stdout text scraping unless an actual child agent process
        // is running under this shell.
        if is_generic_shell_engine(&inst.engine) {
            let root_pid = inst.child.lock().ok().and_then(|c| c.process_id());
            let has_child_agent = root_pid.and_then(detect_child_agent_in_shell);
            if has_child_agent.as_deref() != Some(canonical.as_str()) && has_child_agent.is_none() {
                // No actual agent process exists in the process tree of this generic shell.
                // Do not mark it as an agent engine.
                return serde_json::Value::Null;
            }
        }

        inst.had_user_activity.store(true, Ordering::Relaxed);
        if let Ok(mut det) = inst.detected_agent_engine.lock() {
            *det = Some(canonical);
        }
        let _ = try_bind_provider_session_id(session_id, &inst);
    }
    serde_json::Value::Null
}

/// Flushes scrollback and persists `terminal-sessions.json` for every live
/// terminal without terminating any child process and without latching
/// `SHUTTING_DOWN`, so the background core survives a GUI window close (S4).
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
fn flush_and_persist_active_terminals(
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

#[tauri::command]
pub async fn terminate_terminal(request: serde_json::Value) -> serde_json::Value {
    terminate_terminal_sync(request)
}

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

#[tauri::command]
pub fn launch_workspace_terminals(request: serde_json::Value) -> serde_json::Value {
    log_trace(&format!("Invoked launch_workspace_terminals: {:?}", request));
    let req = request.get("request").unwrap_or(&request);
    let request_id = req.get("requestId").cloned().unwrap_or_else(|| {
        serde_json::Value::String(Uuid::new_v4().to_string())
    });

    let count = req
        .get("count")
        .and_then(|v| v.as_u64())
        .unwrap_or_else(|| {
            req.get("seats")
                .and_then(|s| s.as_array())
                .map(|a| a.len() as u64)
                .unwrap_or(1)
        })
        .clamp(1, 6) as usize;

    let default_engine = req
        .get("engine")
        .and_then(|e| e.as_str())
        .unwrap_or("terminal");

    let seats = req.get("seats").and_then(|s| s.as_array());
    // Do not spawn here. The pane does not exist yet, so the only size we
    // could pass is 80×24. The view attaches after the host settles and
    // `attach_terminal` spawns at that grid. Spawning early let the CLI paint
    // into a buffer the view then drained and dropped, which left a blank
    // cursor on an otherwise running session.

    static CODENAME_COUNTER: std::sync::atomic::AtomicUsize =
        std::sync::atomic::AtomicUsize::new(0);

    const AGENT_CODENAMES: &[&str] = &[
        "Orion", "Nova", "Atlas", "Vega", "Titan", "Echo", "Phoenix", "Lyra", "Apex", "Zenith",
        "Cygnus", "Helios", "Falcon", "Sirius", "Altair", "Polaris", "Castor", "Pollux", "Astra",
        "Cosmo", "Vortex", "Nebula", "Specter", "Sol", "Aura", "Quantum", "Nexus", "Pulse",
        "Ranger", "Draco",
    ];

    let mut slots = Vec::new();
    for i in 0..count {
        let session_id = Uuid::new_v4().to_string();
        let pane_id = Uuid::new_v4().to_string();

        let engine = seats
            .and_then(|s| s.get(i))
            .and_then(|seat| seat.get("engine"))
            .and_then(|e| e.as_str())
            .unwrap_or(default_engine);

        let is_plain_shell = matches!(engine, "powershell" | "terminal" | "cmd" | "bash" | "zsh");

        let provided_agent_name = seats
            .and_then(|s| s.get(i))
            .and_then(|seat| seat.get("agentName"))
            .and_then(|a| a.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty());

        let codename = if is_plain_shell {
            "Terminal".to_string()
        } else if let Some(custom) = provided_agent_name {
            custom.to_string()
        } else {
            let next_idx = CODENAME_COUNTER.fetch_add(1, Ordering::SeqCst);
            AGENT_CODENAMES[next_idx % AGENT_CODENAMES.len()].to_string()
        };

        let work_title = codename.clone();

        let seat_label = seats
            .and_then(|s| s.get(i))
            .and_then(|seat| seat.get("label"))
            .and_then(|l| l.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty() && *s != "Terminal" && *s != engine)
            .map(|s| s.to_string())
            .unwrap_or_else(|| work_title.clone());

        slots.push(serde_json::json!({
            "index": i,
            "sessionId": session_id,
            "paneId": pane_id,
            "engine": engine,
            "displayName": seat_label,
            "agentName": if is_plain_shell { serde_json::Value::Null } else { serde_json::Value::String(codename) },
            "roleLabel": serde_json::Value::Null,
            "workTitle": work_title
        }));
    }

    serde_json::json!({
        "requestId": request_id,
        "attachedToExisting": false,
        "slots": slots
    })
}

#[tauri::command]
pub fn list_terminal_profiles() -> serde_json::Value {
    serde_json::json!({
        "schemaVersion": 1,
        "profiles": [
            { "kind": "default" },
            { "kind": "powerShell" },
            { "kind": "commandPrompt" }
        ]
    })
}

fn request_body(request: &serde_json::Value) -> &serde_json::Value {
    request.get("request").unwrap_or(request)
}

fn option_body(request: &Option<serde_json::Value>) -> Option<&serde_json::Value> {
    request.as_ref().map(request_body)
}

fn owner_workspace_id(owner: &serde_json::Value) -> Option<&str> {
    let kind = owner.get("kind").and_then(|value| value.as_str())?;
    if kind == "workspace" || kind == "workspaceLaunch" {
        owner
            .get("workspaceId")
            .and_then(|value| value.as_str())
            .filter(|id| !id.is_empty())
    } else {
        None
    }
}

fn owner_agent_id(owner: &serde_json::Value) -> Option<&str> {
    let kind = owner.get("kind").and_then(|value| value.as_str())?;
    if kind == "agent" || kind == "agentLaunch" {
        owner
            .get("agentId")
            .and_then(|value| value.as_str())
            .filter(|id| !id.is_empty())
    } else {
        None
    }
}

fn extract_workspace_id(req: &serde_json::Value) -> Option<String> {
    req.get("workspaceId")
        .and_then(|value| value.as_str())
        .filter(|id| !id.is_empty())
        .or_else(|| req.get("owner").and_then(owner_workspace_id))
        .map(str::to_string)
}

fn extract_pane_id(req: &serde_json::Value) -> Option<String> {
    req.get("paneId")
        .and_then(|value| value.as_str())
        .filter(|id| !id.is_empty())
        .or_else(|| {
            req.get("owner")
                .and_then(|o| o.get("paneId"))
                .and_then(|v| v.as_str())
                .filter(|id| !id.is_empty())
        })
        .map(str::to_string)
}

fn workspace_cwd(req: &serde_json::Value) -> String {
    if let Some(cwd) = req
        .get("cwd")
        .and_then(|value| value.as_str())
        .filter(|path| std::path::Path::new(path).is_dir())
    {
        return cwd.to_string();
    }
    let workspace_id = req
        .get("workspaceId")
        .and_then(|value| value.as_str())
        .filter(|id| !id.is_empty())
        .or_else(|| req.get("owner").and_then(owner_workspace_id));
    if let Some(path) = workspace_id
        .and_then(workspace_path)
        .filter(|path| std::path::Path::new(path).is_dir())
    {
        return path;
    }

    let agent_id = req
        .get("agentId")
        .and_then(|value| value.as_str())
        .filter(|id| !id.is_empty())
        .or_else(|| req.get("owner").and_then(owner_agent_id));
    if let Some(aid) = agent_id {
        let home = crate::agent_mind::get_agent_home_dir(aid);
        let _ = std::fs::create_dir_all(&home);
        let _ = crate::agent_mind::sync_agent_instructions(
            home.parent().unwrap_or(std::path::Path::new(".")),
            aid,
        );
        return home.to_string_lossy().into_owned();
    }

    std::env::current_dir()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|_| ".".into())
}

fn write_session(session_id: &str, text: &str) -> bool {
    if session_id.is_empty() || text.is_empty() {
        return false;
    }
    if should_proxy_to_core_daemon(session_id) {
        let res = write_terminal_sync(serde_json::json!({
            "sessionId": session_id,
            "input": text,
        }));
        return res.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    }
    let instance = {
        let map = get_terminals().lock().unwrap();
        map.get(session_id).cloned()
    };
    let Some(instance) = instance else {
        return false;
    };
    instance.had_user_activity.store(true, Ordering::Relaxed);
    if let Ok(mut writer) = instance.writer.lock() {
        let _ = writer.write_all(text.as_bytes());
        let _ = writer.flush();
        return true;
    }
    false
}

fn quote_path(path: &str) -> Option<String> {
    let trimmed = path.trim();
    if trimmed.is_empty() || trimmed.chars().any(|ch| ch.is_control()) {
        return None;
    }
    Some(format!("'{}' ", trimmed.replace('\'', "''")))
}

fn remove_session(session_id: &str) -> Option<(String, String)> {
    if session_id.is_empty() {
        return None;
    }
    let instance = {
        let mut map = get_terminals().lock().unwrap();
        map.remove(session_id)
    }?;
    let live_dir = instance
        .live_cwd
        .lock()
        .ok()
        .map(|c| c.clone())
        .filter(|c| !c.is_empty())
        .unwrap_or_else(|| instance.cwd.clone());
    let home = (live_dir, instance.engine.clone());
    if let Ok(mut child) = instance.child.lock() {
        let _ = child.kill();
    }
    delete_scrollback_file(session_id);
    remove_persisted_terminal_session(session_id);
    Some(home)
}

pub(crate) fn decode_base64(input: &str) -> Option<Vec<u8>> {
    fn value(byte: u8) -> Option<u8> {
        match byte {
            b'A'..=b'Z' => Some(byte - b'A'),
            b'a'..=b'z' => Some(byte - b'a' + 26),
            b'0'..=b'9' => Some(byte - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let bytes = input.as_bytes();
    if bytes.is_empty() || bytes.len() % 4 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for chunk in bytes.chunks(4) {
        let pad = chunk.iter().filter(|byte| **byte == b'=').count();
        if pad > 2 {
            return None;
        }
        let a = value(chunk[0])?;
        let b = value(chunk[1])?;
        let c = if chunk[2] == b'=' { 0 } else { value(chunk[2])? };
        let d = if chunk[3] == b'=' { 0 } else { value(chunk[3])? };
        out.push((a << 2) | (b >> 4));
        if pad < 2 {
            out.push((b << 4) | (c >> 2));
        }
        if pad < 1 {
            out.push((c << 6) | d);
        }
    }
    Some(out)
}

fn stage_clipboard_file(
    _owner: Option<&serde_json::Value>,
    session_id: &str,
    format: &str,
    bytes_b64: &str,
) -> Option<String> {
    let ext = match format {
        "png" | "gif" | "webp" | "bmp" => format,
        "jpeg" => "jpg",
        _ => return None,
    };
    let bytes = decode_base64(bytes_b64)?;
    if bytes.is_empty() || bytes.len() > 12_000_000 {
        return None;
    }
    let dir = std::env::temp_dir().join("kite-clipboard");
    std::fs::create_dir_all(&dir).ok()?;
    let safe_id: String = session_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let name = format!(
        "{}-{}.{}",
        if safe_id.is_empty() {
            "image"
        } else {
            &safe_id
        },
        &Uuid::new_v4().to_string()[..8],
        ext
    );
    let path = dir.join(name);
    std::fs::write(&path, bytes).ok()?;
    Some(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn insert_terminal_drop_paths(request: Option<serde_json::Value>) -> serde_json::Value {
    if let Some(req) = option_body(&request) {
        let session_id = req
            .get("sessionId")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let mut text = String::new();
        if let Some(paths) = req.get("paths").and_then(|value| value.as_array()) {
            for path in paths.iter().take(20) {
                let Some(path) = path.as_str() else { continue };
                if let Some(quoted) = quote_path(path) {
                    text.push_str(&quoted);
                }
            }
        }
        let _ = write_session(session_id, &text);
    }
    serde_json::Value::Null
}

#[tauri::command]
pub fn insert_terminal_files_entry(request: Option<serde_json::Value>) -> serde_json::Value {
    if let Some(req) = option_body(&request) {
        let session_id = req
            .get("sessionId")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let workspace_id = req
            .get("workspaceId")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let resource_id = req
            .get("resourceId")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let entry_id = req
            .get("entryId")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        if let Some(path) = crate::files::files_entry_path(workspace_id, resource_id, entry_id) {
            if let Some(quoted) = quote_path(&path.to_string_lossy()) {
                let _ = write_session(session_id, &quoted);
            }
        }
    }
    serde_json::Value::Null
}

#[tauri::command]
pub fn restart_agent_terminal_for_autopilot(request: serde_json::Value) -> serde_json::Value {
    let req = request_body(&request);
    let old_id = req
        .get("oldSessionId")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    if should_proxy_to_core_daemon(old_id) {
        if let Ok(res) = crate::core_daemon::send_core_daemon_rpc(
            "session.restart_autopilot",
            Some(req.clone()),
        ) {
            return res;
        }
    }
    restart_agent_terminal_for_autopilot_local_sync(request)
}

pub fn restart_agent_terminal_for_autopilot_local_sync(
    request: serde_json::Value,
) -> serde_json::Value {
    let req = request_body(&request);
    let old_id = req
        .get("oldSessionId")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let new_id = req
        .get("newSessionId")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let prompt = req
        .get("prompt")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let cols = req
        .get("columns")
        .and_then(|value| value.as_u64())
        .unwrap_or(80)
        .clamp(2, 512) as u16;
    let rows = req
        .get("rows")
        .and_then(|value| value.as_u64())
        .unwrap_or(24)
        .clamp(1, 256) as u16;
    let previous = remove_session(old_id);
    let (cwd, engine) = previous.unwrap_or_else(|| (workspace_cwd(req), "powershell".to_string()));
    if !new_id.is_empty() && new_id != old_id {
        remove_session(new_id);
        spawn_session_with_size(new_id, &cwd, &engine, cols, rows);
        let prompt = prompt.trim();
        if !prompt.is_empty() {
            let _ = write_session(new_id, &format!("{prompt}\r\n"));
        }
    }
    serde_json::json!({
        "sessionId": new_id,
        "attachedToExisting": false,
        "host": { "backend": "conpty", "buildNumber": 22631 },
        "restore": { "kind": "startedFresh", "reason": "noConversation" }
    })
}

#[tauri::command]
pub fn stage_terminal_clipboard_image(request: Option<serde_json::Value>) -> serde_json::Value {
    if let Some(req) = option_body(&request) {
        let session_id = req
            .get("sessionId")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let format = req
            .get("format")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let bytes = req
            .get("bytesBase64")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        if let Some(path) = stage_clipboard_file(req.get("owner"), session_id, format, bytes) {
            if let Some(quoted) = quote_path(&path) {
                let _ = write_session(session_id, &quoted);
            }
        }
    }
    serde_json::Value::Null
}

// ---------------------------------------------------------------------------
// Targeted Provider Terminal Orchestration (Account Switcher)
// ---------------------------------------------------------------------------

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_reg_path_output_reads_reg_sz() {
        let stdout = "\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_SZ    C:\\Tools;C:\\CLIs\r\n";
        assert_eq!(
            parse_reg_path_output(stdout).as_deref(),
            Some("C:\\Tools;C:\\CLIs")
        );
    }

    #[test]
    fn parse_reg_path_output_prefers_expand_sz() {
        let stdout = "\n    Path    REG_EXPAND_SZ    %USERPROFILE%\\.local\\bin\n";
        assert_eq!(
            parse_reg_path_output(stdout).as_deref(),
            Some("%USERPROFILE%\\.local\\bin")
        );
    }

    #[test]
    fn parse_reg_path_output_skips_empty() {
        assert_eq!(parse_reg_path_output("    Path    REG_SZ    \n"), None);
        assert_eq!(parse_reg_path_output(""), None);
    }

    #[test]
    fn resumed_grok_and_claude_keep_the_system_prompt() {
        let grok = SpawnMode::Resume {
            provider_session_id: Some("sess-1".into()),
            allow_continue_fallback: false,
            hybrid_shell_agent: None,
        };
        let (args, bound) = build_agent_cli_args_ext(
            "grok",
            "local",
            "C:/tmp",
            &grok,
            Some("task"),
            false,
            Some("MANUAL"),
        );
        assert_eq!(bound.as_deref(), Some("sess-1"));
        assert!(args.windows(2).any(|pair| pair == ["-r", "sess-1"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--system-prompt-override", "MANUAL"]));

        let claude = SpawnMode::Resume {
            provider_session_id: Some("not-a-session-file".into()),
            allow_continue_fallback: false,
            hybrid_shell_agent: None,
        };
        let (args, _) = build_agent_cli_args_ext(
            "claude-code",
            "local",
            "C:/tmp",
            &claude,
            Some("task"),
            false,
            Some("MANUAL"),
        );
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--system-prompt", "MANUAL"]));
    }

    #[test]
    fn a_codex_birth_includes_the_manual_and_a_resume_does_not() {
        let (system, prompt) =
            attach_dispatch_manual("codex", false, false, None, Some("Look".into()));
        assert!(system.is_none());
        let prompt = prompt.unwrap();
        assert!(prompt.contains("This text is the complete manual."));
        assert!(prompt.contains("Look"));
        assert!(!prompt.contains("KITE_SKILL_FILE"));

        let (system, prompt) = attach_dispatch_manual("codex", false, true, None, None);
        assert!(system.is_none());
        assert!(prompt.is_none());

        let (system, prompt) =
            attach_dispatch_manual("grok", false, true, None, Some("task".into()));
        let system = system.unwrap();
        assert!(system.contains("This text is the complete manual."));
        assert!(!system.contains("KITE_SKILL_FILE"));
        assert_eq!(prompt.as_deref(), Some("task"));
    }

    #[test]
    fn dispatch_missing_raw_program_starts_no_session() {
        let value = start_terminal_local_sync(serde_json::json!({
            "engine": "kite-dispatch-no-such-program",
            "argv": ["kite-dispatch-no-such-program"],
        }));
        assert_eq!(
            value.get("error").and_then(|item| item.as_str()),
            Some("program_not_found")
        );
        assert!(value.get("sessionId").is_none());
    }

    #[test]
    fn direct_agent_executable_follows_npm_cmd_shim_and_skips_scripts() {
        let dir = std::env::temp_dir().join(format!("kite-shim-{}", std::process::id()));
        let bin = dir.join("node_modules").join("tool").join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let exe = bin.join("tool.exe");
        std::fs::write(&exe, b"").unwrap();
        let shim = dir.join("tool.cmd");
        std::fs::write(
            &shim,
            "@ECHO off\r\nCALL :find_dp0\r\n\"%dp0%\\node_modules\\tool\\bin\\tool.exe\"   %*\r\n",
        )
        .unwrap();
        let script_shim = dir.join("js.cmd");
        std::fs::write(
            &script_shim,
            "\"%_prog%\"  \"%dp0%\\node_modules\\js\\bundle\\js.js\" %*\r\n",
        )
        .unwrap();

        assert_eq!(
            resolve_direct_agent_executable(&exe.to_string_lossy()),
            Some(exe.clone())
        );
        assert_eq!(
            resolve_direct_agent_executable(&shim.to_string_lossy()),
            Some(exe.clone())
        );
        assert_eq!(resolve_direct_agent_executable(&script_shim.to_string_lossy()), None);
        assert_eq!(resolve_direct_agent_executable("C:\\x\\tool.ps1"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn agent_launch_command_normalizes_utf8_console_and_term() {
        let command = build_agent_launch_command(
            r"C:\Program Files\OpenCode\opencode.exe",
            &["--prompt".to_string(), "box ▣".to_string()],
        );

        assert!(command.contains("$OutputEncoding = [Console]::OutputEncoding"));
        assert!(command.contains("chcp 65001 > $null"));
        assert!(command.contains("$env:TERM = 'xterm-256color'"));
        assert!(command.contains("& 'C:\\Program Files\\OpenCode\\opencode.exe' '--prompt' 'box ▣'"));
    }

    #[test]
    fn test_build_agent_cli_args_resume_flags() {
        let (agy_args, agy_id) = build_agent_cli_args(
            "antigravity",
            "sess-1",
            r"E:\kite",
            &SpawnMode::Resume {
                provider_session_id: Some("5094dc56-5a10-42ba-86a6-49565d2e6569".to_string()),
                allow_continue_fallback: true,
                hybrid_shell_agent: None,
            },
        );
        assert_eq!(
            agy_args,
            vec!["--conversation", "5094dc56-5a10-42ba-86a6-49565d2e6569"]
        );
        assert_eq!(
            agy_id.as_deref(),
            Some("5094dc56-5a10-42ba-86a6-49565d2e6569")
        );

        let (codex_args, _) = build_agent_cli_args(
            "codex",
            "sess-2",
            r"E:\kite",
            &SpawnMode::Resume {
                provider_session_id: Some("019d976b-21c5-71d2-9078-fd9428c0219c".to_string()),
                allow_continue_fallback: true,
                hybrid_shell_agent: None,
            },
        );
        assert_eq!(
            codex_args,
            vec!["resume", "019d976b-21c5-71d2-9078-fd9428c0219c"]
        );

        let (opencode_args, _) = build_agent_cli_args(
            "open-code",
            "sess-3",
            r"E:\kite",
            &SpawnMode::Resume {
                provider_session_id: Some("ses_12345".to_string()),
                allow_continue_fallback: true,
                hybrid_shell_agent: None,
            },
        );
        assert_eq!(opencode_args, vec!["--session", "ses_12345"]);

        let (grok_args, grok_id) = build_agent_cli_args(
            "grok",
            "sess-grok",
            r"E:\kite",
            &SpawnMode::Resume {
                provider_session_id: Some("01a1a8c4-876b-7260-b545-c8f1d9ecd705".to_string()),
                allow_continue_fallback: true,
                hybrid_shell_agent: None,
            },
        );
        assert_eq!(
            grok_args,
            vec!["-r", "01a1a8c4-876b-7260-b545-c8f1d9ecd705"]
        );
        assert_eq!(
            grok_id.as_deref(),
            Some("01a1a8c4-876b-7260-b545-c8f1d9ecd705")
        );

        let (grok_none_args, grok_none_id) = build_agent_cli_args(
            "grok",
            "sess-grok-none",
            r"E:\kite",
            &SpawnMode::Resume {
                provider_session_id: None,
                allow_continue_fallback: true,
                hybrid_shell_agent: None,
            },
        );
        assert!(grok_none_args.is_empty());
        assert!(grok_none_id.is_none());

        // Verify that missing provider_session_id never falls back to --continue / resume --last
        let (agy_none_args, agy_none_id) = build_agent_cli_args(
            "antigravity",
            "sess-4",
            r"E:\kite",
            &SpawnMode::Resume {
                provider_session_id: None,
                allow_continue_fallback: true,
                hybrid_shell_agent: None,
            },
        );
        assert!(agy_none_args.is_empty());
        assert!(agy_none_id.is_none());
    }

    #[test]
    fn test_build_agent_cli_args_fresh_with_prompt_and_auto_approve() {
        let (grok_args, _) = build_agent_cli_args_ext(
            "grok",
            "sess-grok",
            r"E:\kite",
            &SpawnMode::Fresh,
            Some("Desarrolla la tarea ODD"),
            true,
            None,
        );
        assert_eq!(
            grok_args,
            vec!["--always-approve", "Desarrolla la tarea ODD"]
        );

        let (codex_args, _) = build_agent_cli_args_ext(
            "codex",
            "sess-codex",
            r"E:\kite",
            &SpawnMode::Fresh,
            Some("Desarrolla la tarea ODD"),
            true,
            None,
        );
        assert_eq!(
            codex_args,
            vec!["--approve-for-me", "Desarrolla la tarea ODD"]
        );

        let (agy_args, _) = build_agent_cli_args_ext(
            "antigravity",
            "sess-agy",
            r"E:\kite",
            &SpawnMode::Fresh,
            Some("Desarrolla la tarea ODD"),
            true,
            None,
        );
        assert_eq!(
            agy_args,
            vec!["--dangerously-skip-permissions", "-i", "Desarrolla la tarea ODD"]
        );

        let (claude_args, bound_id) = build_agent_cli_args_ext(
            "claude-code",
            "sess-claude",
            r"E:\kite",
            &SpawnMode::Fresh,
            Some("Desarrolla la tarea ODD"),
            true,
            None,
        );
        assert!(bound_id.is_some());
        assert_eq!(claude_args[0], "--session-id");
        assert_eq!(claude_args[2], "--permission-mode");
        assert_eq!(claude_args[3], "bypassPermissions");
        assert_eq!(claude_args[4], "Desarrolla la tarea ODD");

        let (opencode_args, _) = build_agent_cli_args_ext(
            "open-code",
            "sess-oc",
            r"E:\kite",
            &SpawnMode::Fresh,
            Some("Desarrolla la tarea ODD"),
            true,
            None,
        );
        assert_eq!(
            opencode_args,
            vec!["--auto", "--prompt", "Desarrolla la tarea ODD"]
        );
    }

    #[test]
    fn test_agent_cli_auto_approve_defaults() {
        assert!(is_agent_cli_engine("antigravity"));
        assert!(is_agent_cli_engine("agy"));
        assert!(is_agent_cli_engine("claude-code"));
        assert!(!is_agent_cli_engine("powershell"));
        assert!(!is_agent_cli_engine("terminal"));

        let (agy_no_prompt, _) = build_agent_cli_args_ext(
            "agy",
            "sess-agy-noprompt",
            r"E:\kite",
            &SpawnMode::Fresh,
            None,
            true,
            None,
        );
        assert_eq!(agy_no_prompt, vec!["--dangerously-skip-permissions"]);

        let (agy_resume, _) = build_agent_cli_args_ext(
            "antigravity",
            "sess-agy-res",
            r"E:\kite",
            &SpawnMode::Resume {
                provider_session_id: Some("conv-123".to_string()),
                allow_continue_fallback: true,
                hybrid_shell_agent: None,
            },
            None,
            true,
            None,
        );
        assert_eq!(
            agy_resume,
            vec!["--conversation", "conv-123", "--dangerously-skip-permissions"]
        );
    }

    #[test]
    fn test_terminal_session_lifecycle() {
        let session_id = format!("test-sess-{}", Uuid::new_v4());

        // 1. Start terminal session
        let start_res = start_terminal_sync(serde_json::json!({
            "sessionId": session_id,
            "engine": "powershell",
            "columns": 80,
            "rows": 24,
            "confirmedByBuilder": true
        }));

        assert_eq!(start_res["sessionId"], session_id);
        assert_eq!(start_res["attachedToExisting"], false);
        assert_eq!(start_res["host"]["backend"], "conpty");
        assert_eq!(start_res["restore"]["kind"], "startedFresh");

        // Verify session is recorded in active instances
        {
            let map = get_terminals().lock().unwrap();
            assert!(map.contains_key(&session_id));
        }

        // 2. Attach / reconnect to existing session
        let attach_res = attach_terminal_sync(serde_json::json!({
            "sessionId": session_id
        }));
        assert_eq!(attach_res["sessionId"], session_id);
        assert_eq!(attach_res["attachedToExisting"], true);
        assert_eq!(attach_res["restore"]["kind"], "reattached");

        // 3. Write input
        let write_res = write_terminal_sync(serde_json::json!({
            "sessionId": session_id,
            "input": "echo 'kite_test_lifecycle'\r\n"
        }));
        assert_eq!(write_res["ok"], true);

        // 4. Resize terminal
        let resize_res = resize_terminal_sync(serde_json::json!({
            "sessionId": session_id,
            "columns": 120,
            "rows": 40
        }));
        assert_eq!(resize_res["ok"], true);

        // 5. Read output (PTY output is asynchronous, give it a few polling iterations)
        let mut got_output = false;
        for _ in 0..50 {
            std::thread::sleep(std::time::Duration::from_millis(100));
            let read_res = read_terminal_output_sync(serde_json::json!({
                "sessionId": session_id
            }));
            let kind = read_res["kind"].as_str().unwrap_or("");
            if kind == "output" {
                got_output = true;
                assert!(read_res["bytesBase64"].as_str().is_some());
                assert!(read_res["sequence"].as_u64().is_some());
                break;
            }
        }
        assert!(got_output, "ConPTY terminal should produce output");

        // 6. Terminate terminal
        let term_res = terminate_terminal_sync(serde_json::json!({
            "sessionId": session_id
        }));
        assert_eq!(term_res["terminated"], true);

        // Verify session is removed from active instances
        {
            let map = get_terminals().lock().unwrap();
            assert!(!map.contains_key(&session_id));
        }

        // 7. Reading terminated session returns idle without error
        let read_after_term = read_terminal_output_sync(serde_json::json!({
            "sessionId": session_id
        }));
        assert_eq!(read_after_term["kind"], "idle");
    }

    #[test]
    fn test_fresh_powershell_terminal_produces_prompt_without_input() {
        let session_id = format!("test-fresh-ps-{}", Uuid::new_v4());
        let _ = start_terminal_sync(serde_json::json!({
            "sessionId": session_id,
            "engine": "powershell",
            "columns": 80,
            "rows": 24,
            "confirmedByBuilder": true
        }));

        let mut output_str = String::new();
        let mut answered_cpr = false;
        for _ in 0..30 {
            std::thread::sleep(std::time::Duration::from_millis(100));
            let read_res = read_terminal_output_sync(serde_json::json!({
                "sessionId": session_id
            }));
            if let Some(b64) = read_res["bytesBase64"].as_str() {
                if let Some(bytes) = decode_base64(b64) {
                    let chunk = String::from_utf8_lossy(&bytes);
                    output_str.push_str(&chunk);
                    if chunk.contains("\x1b[6n") && !answered_cpr {
                        answered_cpr = true;
                        let _ = write_terminal_sync(serde_json::json!({
                            "sessionId": session_id,
                            "input": "\x1b[1;1R"
                        }));
                    }
                }
            }
            if output_str.contains("PS ") || output_str.contains(">") {
                break;
            }
        }

        println!("FRESH PS OUTPUT: {:?}", output_str);
        let _ = terminate_terminal_sync(serde_json::json!({ "sessionId": session_id }));
        assert!(!output_str.is_empty(), "Fresh PowerShell terminal must produce prompt output without waiting for input");
    }

    #[test]
    fn test_fresh_agent_spawn_produces_output() {
        if !engine_installed("antigravity") {
            return;
        }
        let session_id = format!("test-fresh-agy-{}", Uuid::new_v4());
        let _ = start_terminal_sync(serde_json::json!({
            "sessionId": session_id,
            "engine": "antigravity",
            "columns": 80,
            "rows": 24,
            "confirmedByBuilder": true
        }));

        let mut output_str = String::new();
        let mut answered_cpr = false;
        for _ in 0..40 {
            std::thread::sleep(std::time::Duration::from_millis(100));
            let read_res = read_terminal_output_sync(serde_json::json!({
                "sessionId": session_id
            }));
            if let Some(b64) = read_res["bytesBase64"].as_str() {
                if let Some(bytes) = decode_base64(b64) {
                    let chunk = String::from_utf8_lossy(&bytes);
                    output_str.push_str(&chunk);
                    if chunk.contains("\x1b[6n") && !answered_cpr {
                        answered_cpr = true;
                        let _ = write_terminal_sync(serde_json::json!({
                            "sessionId": session_id,
                            "input": "\x1b[1;1R"
                        }));
                    }
                }
            }
            if output_str.contains("Antigravity") {
                break;
            }
        }

        println!("FRESH AGY OUTPUT: {:?}", output_str);
        let _ = terminate_terminal_sync(serde_json::json!({ "sessionId": session_id }));
        assert!(output_str.contains("Antigravity"), "Fresh agent terminal must produce Antigravity banner upon CPR response");
    }

    #[test]
    fn test_terminal_missing_or_unknown_session_safety() {
        let fake_id = "non-existent-session-xyz";

        // Writing to non-existent session reports the missing target without panic
        let write_res = write_terminal_sync(serde_json::json!({
            "sessionId": fake_id,
            "input": "test"
        }));
        assert_eq!(write_res["ok"], false);
        assert_eq!(write_res["error"], "Session not found");

        // Resizing non-existent session reports the missing target without panic
        let resize_res = resize_terminal_sync(serde_json::json!({
            "sessionId": fake_id,
            "columns": 80,
            "rows": 24
        }));
        assert_eq!(resize_res["ok"], false);
        assert_eq!(resize_res["error"], "Session not found");

        // Terminating a non-existent session reports that no live session was terminated
        let term_res = terminate_terminal_sync(serde_json::json!({
            "sessionId": fake_id
        }));
        assert_eq!(term_res["terminated"], false);
        assert_eq!(term_res["sessionId"], fake_id);

        // Reading non-existent session returns idle
        let read_res = read_terminal_output_sync(serde_json::json!({
            "sessionId": fake_id
        }));
        assert_eq!(read_res["kind"], "idle");
    }

    #[test]
    fn test_list_terminal_profiles() {
        let res = list_terminal_profiles();
        assert_eq!(res["schemaVersion"], 1);
        assert!(res["profiles"].as_array().unwrap().len() >= 3);
    }

    #[test]
    fn test_terminal_scrollback_persistence() {
        let test_session = format!("test-sb-{}", Uuid::new_v4());
        let sample_output = b"\x1b[32mKite ConPTY Test Output\x1b[0m\r\n";
        write_scrollback_file(&test_session, sample_output);

        let read_back = read_scrollback_file(&test_session);
        assert!(read_back.is_some());
        assert_eq!(read_back.unwrap(), sample_output);

        // attach_terminal on new session should find the scrollback on disk
        let attach_res = attach_terminal_sync(serde_json::json!({
            "sessionId": test_session,
            "engine": "powershell"
        }));
        assert_eq!(attach_res["sessionId"], test_session);
        assert_eq!(attach_res["restore"]["kind"], "restoredFromDisk");
        let b64 = attach_res["scrollbackBase64"]
            .as_str()
            .expect("scrollbackBase64 should be present");
        assert_eq!(b64, to_base64(sample_output));

        // Terminating should delete the scrollback file from disk
        let _ = terminate_terminal_sync(serde_json::json!({
            "sessionId": test_session
        }));
        assert!(read_scrollback_file(&test_session).is_none());
    }

    #[test]
    fn test_stage_clipboard_file_and_sanitization() {
        let fake_png_bytes = b"\x89PNG\r\n\x1a\nfakeimagebytes";
        let b64 = to_base64(fake_png_bytes);

        // Test with session_id that contains invalid filename characters
        let dirty_session = "agent:session/test\\1?*";
        let path = stage_clipboard_file(None, dirty_session, "png", &b64);
        assert!(path.is_some());
        let staged_path = path.unwrap();
        assert!(staged_path.ends_with(".png"));
        assert!(std::path::Path::new(&staged_path).is_file());

        // Verify content matches
        let read_bytes = std::fs::read(&staged_path).unwrap();
        assert_eq!(read_bytes, fake_png_bytes);

        // Clean up
        let _ = std::fs::remove_file(staged_path);
    }

    #[test]
    fn terminal_capture_safe_filename_is_path_safe() {
        assert_eq!(
            terminal_capture_safe_filename(r"agent:session/test\\1?*"),
            "agent_session_test__1__.jsonl"
        );
        assert_eq!(terminal_capture_safe_filename(""), "session.jsonl");
    }

    #[test]
    fn terminal_capture_counts_key_ansi_markers() {
        let bytes = b"\x1b[?2026h\x1b[?2026l\x1b[?1049h\x1b[?1049l\r\x1b[2J\x1b[K\x1b[?25h\x1b[25l\x1b]0;title\x07";
        let counts = count_terminal_ansi_markers(bytes);
        assert_eq!(counts.dec_2026_start, 1);
        assert_eq!(counts.dec_2026_end, 1);
        assert_eq!(counts.alt_screen_1049_start, 1);
        assert_eq!(counts.alt_screen_1049_end, 1);
        assert_eq!(counts.carriage_return, 1);
        assert_eq!(counts.erase_j, 1);
        assert_eq!(counts.erase_k, 1);
        assert_eq!(counts.cursor_show, 1);
        assert_eq!(counts.cursor_hide, 1);
        assert_eq!(counts.osc, 1);
    }

    #[test]
    fn terminal_capture_scanner_carries_split_sequences() {
        let mut pending = Vec::new();
        let first = scan_terminal_ansi_markers(&mut pending, b"\x1b[?2026");
        assert_eq!(first, TerminalAnsiMarkerCounts::default());
        assert!(!pending.is_empty());
        let second = scan_terminal_ansi_markers(&mut pending, b"h\x1b]title");
        assert_eq!(second.dec_2026_start, 1);
        assert_eq!(second.osc, 0);
        let third = scan_terminal_ansi_markers(&mut pending, b"\x07");
        assert_eq!(third.osc, 1);
        assert!(pending.is_empty());
    }

    #[test]
    fn terminal_capture_marker_schema_uses_stable_keys() {
        let value = serde_json::to_value(count_terminal_ansi_markers(b"\x1b[?2026h")).unwrap();
        assert_eq!(value["dec2026Start"], 1);
        assert!(value.get("eraseJ").is_some());
        assert!(value.get("cursorHide").is_some());
    }

    #[test]
    fn generic_shell_with_falsely_persisted_codex_self_heals_and_does_not_launch_codex() {
        let session_id = format!("test-heal-{}", Uuid::new_v4());
        let cwd = std::env::current_dir()
            .unwrap_or_else(|_| std::path::PathBuf::from(r"E:\kite"))
            .to_string_lossy()
            .into_owned();

        // 1. Manually write a corrupted persisted record with base_engine: "powershell", active_engine: "codex", provider_session_id: None
        upsert_persisted_terminal_session(PersistedTerminalSession {
            session_id: session_id.clone(),
            workspace_id: Some("ws-heal".to_string()),
            pane_id: Some("pane-heal".to_string()),
            base_engine: "powershell".to_string(),
            active_engine: "codex".to_string(),
            provider_session_id: None,
            cwd: cwd.clone(),
            had_user_activity: true,
            last_user_input: None,
            spawned_at_unix_ms: now_unix_ms(),
            saved_at_unix_ms: now_unix_ms(),
        });

        // 2. Also write a test scrollback
        let _ = write_scrollback_file(&session_id, b"Windows PowerShell\r\nPS C:\\> npm run dev\r\n");

        // 3. Attach to this terminal as powershell
        let req = serde_json::json!({
            "sessionId": session_id,
            "engine": "powershell",
            "cwd": cwd,
            "cols": 80,
            "rows": 24,
            "workspaceId": "ws-heal",
            "paneId": "pane-heal"
        });

        let result = attach_terminal_sync(req);

        // Should return existing scrollback rather than deleting it
        assert!(result.is_object(), "attach_terminal should return an object");
        let b64 = result["scrollbackBase64"].as_str().unwrap_or("");
        assert!(!b64.is_empty(), "scrollback should be preserved");

        // Check that the persisted record was self-healed: active_engine should now be "powershell"
        let map = read_persisted_terminal_sessions();
        let healed = map.get(&session_id).expect("session should exist in persisted map");
        assert_eq!(healed.active_engine, "powershell", "active_engine should have self-healed to powershell");
        assert!(healed.provider_session_id.is_none(), "generic shell should not have provider_session_id");

        // Clean up
        let _ = terminate_terminal_sync(serde_json::json!({ "sessionId": session_id }));
        let _ = delete_scrollback_file(&session_id);
        let mut map = read_persisted_terminal_sessions();
        map.remove(&session_id);
        write_persisted_terminal_sessions(&map);
    }

    #[test]
    fn generic_shell_ignores_agent_detection_without_running_child_agent() {
        let session_id = format!("test-ignore-{}", Uuid::new_v4());
        let cwd = std::env::current_dir()
            .unwrap_or_else(|_| std::path::PathBuf::from(r"E:\kite"))
            .to_string_lossy()
            .into_owned();

        // Spawn a fresh powershell terminal
        let _ = spawn_session_with_options(
            &session_id,
            &cwd,
            "powershell",
            SpawnOptions {
                cols: 80,
                rows: 24,
                mode: SpawnMode::Fresh,
                ..Default::default()
            },
        );

        // Attempt to report codex agent detection
        let report_req = serde_json::json!({
            "sessionId": session_id,
            "engine": "codex"
        });
        let res = report_terminal_agent_detected(report_req);
        assert!(res.is_null());

        // Check that the terminal's detected_agent_engine is still None because no codex child process exists
        let inst = get_terminals().lock().unwrap().get(&session_id).cloned();
        assert!(inst.is_some());
        let det = inst.unwrap().detected_agent_engine.lock().unwrap().clone();
        assert_eq!(det, None, "Generic shell without running codex process must ignore agent detection");

        // Clean up
        let _ = terminate_terminal_sync(serde_json::json!({ "sessionId": session_id }));
        let _ = delete_scrollback_file(&session_id);
    }

    #[test]
    fn observed_bytes_attach_to_snapshot_poll_json() {
        let value = serde_json::json!({
            "kind": "unchanged",
            "seq": 3,
            "exited": false,
            "exitCode": null
        });
        let empty = attach_observed_bytes(value.clone(), b"");
        assert!(empty.get("observedBytesBase64").is_none());

        let with = attach_observed_bytes(value, b"OpenCode v0.2.0\n");
        let encoded = with
            .get("observedBytesBase64")
            .and_then(|v| v.as_str())
            .expect("observed bytes");
        assert_eq!(decode_base64(encoded).unwrap(), b"OpenCode v0.2.0\n");
    }
}
