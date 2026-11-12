use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};

use crate::core_wire::{encode_rpc_frame, ChannelAttachMode, ChannelCreditTracker, Frame};

pub(crate) static CORE_DAEMON_OWNER: OnceLock<bool> = OnceLock::new();
static DAEMON_SHUTDOWN_NOTIFY: OnceLock<tokio::sync::Notify> = OnceLock::new();
static DAEMON_ACTIVITY_NOTIFY: OnceLock<tokio::sync::Notify> = OnceLock::new();
static DAEMON_UI_EVENT_BROADCAST: OnceLock<tokio::sync::broadcast::Sender<Frame>> = OnceLock::new();

/// Snapshot credit for in-process / IPC sessions that are keyed by `session_id`
/// or `channel_id` instead of by a live client channel.
static SESSION_CREDIT_TRACKERS: OnceLock<Mutex<HashMap<String, ChannelCreditTracker>>> =
    OnceLock::new();

pub fn daemon_ui_event_tx() -> &'static tokio::sync::broadcast::Sender<Frame> {
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

/// True when an out-of-process `kite-core` owns the PTY registry.
///
/// Callers must forward terminal operations over the control pipe in that case
/// instead of expecting a local `get_terminals()` entry.
pub fn is_external_daemon_owner() -> bool {
    CORE_DAEMON_OWNER.get().copied().unwrap_or(false)
}

pub fn daemon_shutdown_notify() -> &'static tokio::sync::Notify {
    DAEMON_SHUTDOWN_NOTIFY.get_or_init(tokio::sync::Notify::new)
}

pub fn daemon_activity_notify() -> &'static tokio::sync::Notify {
    DAEMON_ACTIVITY_NOTIFY.get_or_init(tokio::sync::Notify::new)
}

/// Wakes any attached stream clients when a PTY produces output, changes
/// metadata, or exits so idle connections sleep at 0.00% CPU without polling.
pub fn notify_daemon_activity() {
    daemon_activity_notify().notify_waiters();
}

pub fn session_credit_trackers() -> &'static Mutex<HashMap<String, ChannelCreditTracker>> {
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

pub fn clear_in_process_channels() {
    if let Ok(mut trackers) = session_credit_trackers().lock() {
        trackers.clear();
    }
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

pub fn attached_channel(
    channel_id: u32,
    session_id: String,
    tracker: ChannelCreditTracker,
) -> AttachedChannelState {
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
