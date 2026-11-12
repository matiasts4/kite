use crate::terminal::{
    bench_record_snapshot_poll, decode_base64, emit_terminal_activity, get_terminals,
    has_local_terminal_instance, instance_exists, is_bench_active, log_dec2026_timeouts,
    maybe_bind_provider_session, should_proxy_to_core_daemon, to_base64, TerminalInstance,
};
use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

fn take_terminal_output_buffer(inst: &TerminalInstance) -> Vec<u8> {
    inst.buffer
        .lock()
        .ok()
        .map(|mut buf| std::mem::take(&mut *buf))
        .unwrap_or_default()
}

pub(crate) fn attach_observed_bytes(mut value: serde_json::Value, bytes: &[u8]) -> serde_json::Value {
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
    {
        let req_check = request.get("request").unwrap_or(&request);
        let sid_check = req_check.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
        let live_check = req_check.get("live").and_then(|v| v.as_bool()).unwrap_or(false);
        if live_check && !instance_exists(sid_check) {
            crate::terminal::maybe_respawn_deferred_terminal_local(sid_check);
        }
    }
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



/// Scrolls the viewport and returns one packed `SNAPSHOT_BIN` frame.
///
/// The JSON command stays for hosts that do not have this command yet. A scroll
/// must not come back empty after the viewport moved, or the client would issue
/// a second scroll.

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
