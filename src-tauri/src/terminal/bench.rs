use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

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
        if let Ok(map) = crate::terminal::get_terminals().lock() {
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
