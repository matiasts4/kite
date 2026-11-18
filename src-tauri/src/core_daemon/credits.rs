use std::collections::HashMap;
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::core_wire::{encode_rpc_frame, ChannelAttachMode, ChannelCreditTracker, Frame};

pub(crate) static CORE_DAEMON_OWNER: OnceLock<bool> = OnceLock::new();
static CORE_DAEMON_STARTUP_GATE: OnceLock<DaemonStartupGate> = OnceLock::new();
const CORE_DAEMON_STARTUP_WAIT_CAP: Duration = Duration::from_millis(1500);

/// Coordinates early IPC checks with async `ensure_core_daemon_started()`
/// in `.setup()` so window launch never blocks while preventing early callers
/// from misreading `CORE_DAEMON_OWNER` as `false` before initialization finishes.
struct DaemonStartupGate {
    pending: Mutex<bool>,
    ready: Condvar,
}

impl DaemonStartupGate {
    fn new() -> Self {
        Self {
            pending: Mutex::new(false),
            ready: Condvar::new(),
        }
    }

    fn mark_pending(&self) {
        if let Ok(mut guard) = self.pending.lock() {
            *guard = true;
        }
    }

    fn finish(&self) {
        if let Ok(mut guard) = self.pending.lock() {
            *guard = false;
            self.ready.notify_all();
        }
    }

    fn wait_while_pending(&self, timeout: Duration) -> bool {
        let Ok(mut guard) = self.pending.lock() else {
            return false;
        };
        if !*guard {
            return true;
        }
        let deadline = Instant::now() + timeout;
        while *guard {
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                return false;
            };
            let Ok((next, res)) = self.ready.wait_timeout(guard, remaining) else {
                return false;
            };
            guard = next;
            if res.timed_out() && *guard {
                return false;
            }
        }
        true
    }
}

fn startup_gate() -> &'static DaemonStartupGate {
    CORE_DAEMON_STARTUP_GATE.get_or_init(DaemonStartupGate::new)
}

pub fn mark_core_daemon_startup_pending() {
    startup_gate().mark_pending();
}

pub fn finish_core_daemon_startup() {
    startup_gate().finish();
}

/// Ensures `finish_core_daemon_startup()` fires even if startup initialization exits early or unwinds.
pub struct CoreDaemonStartupGuard;

impl CoreDaemonStartupGuard {
    pub fn new() -> Self {
        Self
    }
}

impl Drop for CoreDaemonStartupGuard {
    fn drop(&mut self) {
        finish_core_daemon_startup();
    }
}
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
    if let Some(&owner) = CORE_DAEMON_OWNER.get() {
        return owner;
    }
    let _ = startup_gate().wait_while_pending(CORE_DAEMON_STARTUP_WAIT_CAP);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn daemon_startup_gate_returns_immediately_when_not_pending() {
        let gate = DaemonStartupGate::new();
        assert!(gate.wait_while_pending(Duration::from_millis(50)));
    }

    #[test]
    fn daemon_startup_gate_waits_for_finish_and_wakes_waiter() {
        use std::sync::Arc;
        let gate = Arc::new(DaemonStartupGate::new());
        gate.mark_pending();

        let signal = Arc::clone(&gate);
        let handle = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            signal.finish();
        });

        assert!(gate.wait_while_pending(Duration::from_millis(500)));
        handle.join().expect("startup waiter thread joins cleanly");
    }

    #[test]
    fn daemon_startup_gate_times_out_cleanly_when_never_finished() {
        let gate = DaemonStartupGate::new();
        gate.mark_pending();
        assert!(!gate.wait_while_pending(Duration::from_millis(15)));
    }
}
