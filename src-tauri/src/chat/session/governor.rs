use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::Duration;

/// Default maximum number of concurrent heavy external provider processes.
pub const DEFAULT_HEAVY_PROCESS_LIMIT: usize = 4;
/// Minimum allowed heavy process concurrency limit.
pub const MIN_HEAVY_PROCESS_LIMIT: usize = 1;
/// Maximum allowed heavy process concurrency limit.
pub const MAX_HEAVY_PROCESS_LIMIT: usize = 8;
/// Default maximum number of concurrent multiplexed daemon session leases.
pub const DEFAULT_MULTIPLEXED_LIMIT: usize = 16;

const CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(5);

/// Concurrency weight class for a provider session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionWeight {
    /// Lightweight session multiplexed over a shared long-lived daemon.
    Multiplexed,
    /// Dedicated heavy child process (e.g. standalone CLI or unpooled server).
    HeavyProcess,
}

/// Point-in-time telemetry snapshot of active and queued governor capacity.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GovernorSnapshot {
    pub heavy_active: usize,
    pub heavy_limit: usize,
    pub multiplexed_active: usize,
    pub multiplexed_limit: usize,
    pub heavy_queued: usize,
}

/// Parses a `KITE_MAX_ACTIVE_PROCESSES` value, clamping valid integers to `1..=8`.
pub fn parse_heavy_process_limit(raw: Option<&str>) -> usize {
    raw.and_then(|v| v.trim().parse::<usize>().ok())
        .map(|n| n.clamp(MIN_HEAVY_PROCESS_LIMIT, MAX_HEAVY_PROCESS_LIMIT))
        .unwrap_or(DEFAULT_HEAVY_PROCESS_LIMIT)
}

/// Returns the configured heavy-process limit from `KITE_MAX_ACTIVE_PROCESSES`,
/// falling back to [`DEFAULT_HEAVY_PROCESS_LIMIT`] when unset or invalid.
pub fn configured_heavy_process_limit() -> usize {
    parse_heavy_process_limit(std::env::var("KITE_MAX_ACTIVE_PROCESSES").ok().as_deref())
}

#[derive(Debug)]
struct GovernorState {
    heavy_active: usize,
    heavy_limit: usize,
    multiplexed_active: usize,
    multiplexed_limit: usize,
    heavy_queue: VecDeque<u64>,
    multiplexed_queue: VecDeque<u64>,
    next_ticket: u64,
}

impl GovernorState {
    fn new(heavy_limit: usize, multiplexed_limit: usize) -> Self {
        Self {
            heavy_active: 0,
            heavy_limit: heavy_limit.clamp(MIN_HEAVY_PROCESS_LIMIT, MAX_HEAVY_PROCESS_LIMIT),
            multiplexed_active: 0,
            multiplexed_limit: multiplexed_limit.max(1),
            heavy_queue: VecDeque::new(),
            multiplexed_queue: VecDeque::new(),
            next_ticket: 0,
        }
    }

    fn queue_mut(&mut self, weight: SessionWeight) -> &mut VecDeque<u64> {
        match weight {
            SessionWeight::HeavyProcess => &mut self.heavy_queue,
            SessionWeight::Multiplexed => &mut self.multiplexed_queue,
        }
    }

    fn counts_mut(&mut self, weight: SessionWeight) -> (&mut usize, usize, &mut VecDeque<u64>) {
        match weight {
            SessionWeight::HeavyProcess => (
                &mut self.heavy_active,
                self.heavy_limit,
                &mut self.heavy_queue,
            ),
            SessionWeight::Multiplexed => (
                &mut self.multiplexed_active,
                self.multiplexed_limit,
                &mut self.multiplexed_queue,
            ),
        }
    }

    fn can_fast_acquire(&self, weight: SessionWeight) -> bool {
        match weight {
            SessionWeight::HeavyProcess => {
                self.heavy_queue.is_empty() && self.heavy_active < self.heavy_limit
            }
            SessionWeight::Multiplexed => {
                self.multiplexed_queue.is_empty()
                    && self.multiplexed_active < self.multiplexed_limit
            }
        }
    }

    fn can_grant_ticket(&self, weight: SessionWeight, ticket: u64) -> bool {
        match weight {
            SessionWeight::HeavyProcess => {
                self.heavy_active < self.heavy_limit && self.heavy_queue.front() == Some(&ticket)
            }
            SessionWeight::Multiplexed => {
                self.multiplexed_active < self.multiplexed_limit
                    && self.multiplexed_queue.front() == Some(&ticket)
            }
        }
    }

    fn has_capacity_for_next(&self, weight: SessionWeight) -> bool {
        match weight {
            SessionWeight::HeavyProcess => {
                !self.heavy_queue.is_empty() && self.heavy_active < self.heavy_limit
            }
            SessionWeight::Multiplexed => {
                !self.multiplexed_queue.is_empty()
                    && self.multiplexed_active < self.multiplexed_limit
            }
        }
    }
}

#[derive(Debug)]
struct GovernorInner {
    state: Mutex<GovernorState>,
    cv: Condvar,
}

/// Ensures a queued ticket is always cleaned up and waiting siblings are woken
/// even if a waiting call unwinds unexpectedly before acquiring a permit.
struct QueuedTicketGuard<'a> {
    inner: &'a Arc<GovernorInner>,
    weight: SessionWeight,
    ticket: u64,
    armed: bool,
}

impl Drop for QueuedTicketGuard<'_> {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        state.queue_mut(self.weight).retain(|&t| t != self.ticket);
        drop(state);
        self.inner.cv.notify_all();
    }
}

fn is_cancelled(cancel: Option<&Arc<AtomicBool>>) -> bool {
    cancel.is_some_and(|flag| flag.load(Ordering::Acquire))
}

/// Coordinates global active provider concurrency with strict FIFO queueing.
#[derive(Debug, Clone)]
pub struct ProcessGovernor {
    inner: Arc<GovernorInner>,
}

impl Default for ProcessGovernor {
    fn default() -> Self {
        Self::new()
    }
}

impl ProcessGovernor {
    pub fn new() -> Self {
        Self::with_limits(configured_heavy_process_limit(), DEFAULT_MULTIPLEXED_LIMIT)
    }

    pub fn with_limits(heavy_limit: usize, multiplexed_limit: usize) -> Self {
        Self {
            inner: Arc::new(GovernorInner {
                state: Mutex::new(GovernorState::new(heavy_limit, multiplexed_limit)),
                cv: Condvar::new(),
            }),
        }
    }

    /// Acquires a concurrency permit for `weight`, blocking in strict FIFO ticket
    /// order when capacity is saturated until a slot frees or `cancel` turns `true`.
    pub fn acquire(
        &self,
        weight: SessionWeight,
        cancel: Option<&Arc<AtomicBool>>,
    ) -> Result<GovernorPermit, String> {
        if is_cancelled(cancel) {
            return Err("process governor acquisition cancelled".to_string());
        }

        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());

        if state.can_fast_acquire(weight) {
            let (active, _, _) = state.counts_mut(weight);
            *active += 1;
            return Ok(GovernorPermit {
                inner: Arc::clone(&self.inner),
                weight,
            });
        }

        state.next_ticket += 1;
        let ticket = state.next_ticket;
        state.queue_mut(weight).push_back(ticket);

        let mut ticket_guard = QueuedTicketGuard {
            inner: &self.inner,
            weight,
            ticket,
            armed: true,
        };

        loop {
            if is_cancelled(cancel) {
                state.queue_mut(weight).retain(|&t| t != ticket);
                ticket_guard.armed = false;
                drop(state);
                self.inner.cv.notify_all();
                return Err("process governor acquisition cancelled".to_string());
            }

            if state.can_grant_ticket(weight, ticket) {
                let (active, _, queue) = state.counts_mut(weight);
                let popped = queue.pop_front();
                debug_assert_eq!(popped, Some(ticket));
                *active += 1;
                ticket_guard.armed = false;
                let wake_next = state.has_capacity_for_next(weight);
                drop(state);
                if wake_next {
                    self.inner.cv.notify_all();
                }
                return Ok(GovernorPermit {
                    inner: Arc::clone(&self.inner),
                    weight,
                });
            }

            state = match cancel {
                Some(_) => {
                    let (next, _) = self
                        .inner
                        .cv
                        .wait_timeout(state, CANCEL_POLL_INTERVAL)
                        .unwrap_or_else(|poison| poison.into_inner());
                    next
                }
                None => self
                    .inner
                    .cv
                    .wait(state)
                    .unwrap_or_else(|poison| poison.into_inner()),
            };
        }
    }

    /// Non-blocking permit acquisition that respects any already-queued FIFO waiters.
    pub fn try_acquire(&self, weight: SessionWeight) -> Option<GovernorPermit> {
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if !state.can_fast_acquire(weight) {
            return None;
        }
        let (active, _, _) = state.counts_mut(weight);
        *active += 1;
        Some(GovernorPermit {
            inner: Arc::clone(&self.inner),
            weight,
        })
    }

    /// Updates the heavy-process concurrency limit (clamped to `1..=8`) and wakes
    /// waiting threads immediately so a raised limit unblocks queued waiters.
    pub fn set_heavy_limit(&self, limit: usize) {
        let clamped = limit.clamp(MIN_HEAVY_PROCESS_LIMIT, MAX_HEAVY_PROCESS_LIMIT);
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        state.heavy_limit = clamped;
        drop(state);
        self.inner.cv.notify_all();
    }

    pub fn snapshot(&self) -> GovernorSnapshot {
        let state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        GovernorSnapshot {
            heavy_active: state.heavy_active,
            heavy_limit: state.heavy_limit,
            multiplexed_active: state.multiplexed_active,
            multiplexed_limit: state.multiplexed_limit,
            heavy_queued: state.heavy_queue.len(),
        }
    }
}

/// RAII concurrency slot released automatically when dropped.
#[derive(Debug)]
pub struct GovernorPermit {
    inner: Arc<GovernorInner>,
    weight: SessionWeight,
}

impl GovernorPermit {
    pub fn weight(&self) -> SessionWeight {
        self.weight
    }
}

impl Drop for GovernorPermit {
    fn drop(&mut self) {
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        match self.weight {
            SessionWeight::HeavyProcess => {
                state.heavy_active = state.heavy_active.saturating_sub(1);
            }
            SessionWeight::Multiplexed => {
                state.multiplexed_active = state.multiplexed_active.saturating_sub(1);
            }
        }
        drop(state);
        self.inner.cv.notify_all();
    }
}

/// Returns the singleton global process governor for the runtime.
pub fn global_process_governor() -> &'static ProcessGovernor {
    static INSTANCE: OnceLock<ProcessGovernor> = OnceLock::new();
    INSTANCE.get_or_init(ProcessGovernor::new)
}

/// Returns a point-in-time snapshot from [`global_process_governor`].
pub fn governor_snapshot() -> GovernorSnapshot {
    global_process_governor().snapshot()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::thread;

    fn wait_until(timeout: Duration, mut pred: impl FnMut() -> bool) {
        let start = std::time::Instant::now();
        while !pred() {
            assert!(
                start.elapsed() < timeout,
                "timed out waiting for governor condition"
            );
            thread::sleep(Duration::from_millis(2));
        }
    }

    #[test]
    fn defaults_and_env_parsing_clamp_to_1_through_8() {
        assert_eq!(DEFAULT_HEAVY_PROCESS_LIMIT, 4);
        assert_eq!(DEFAULT_MULTIPLEXED_LIMIT, 16);
        assert_eq!(parse_heavy_process_limit(None), 4);
        assert_eq!(parse_heavy_process_limit(Some("")), 4);
        assert_eq!(parse_heavy_process_limit(Some("abc")), 4);
        assert_eq!(parse_heavy_process_limit(Some("0")), 1);
        assert_eq!(parse_heavy_process_limit(Some("1")), 1);
        assert_eq!(parse_heavy_process_limit(Some(" 6 ")), 6);
        assert_eq!(parse_heavy_process_limit(Some("99")), 8);
    }

    #[test]
    fn raii_drop_releases_slots_and_snapshot_serializes_camel_case() {
        let gov = ProcessGovernor::with_limits(4, 16);
        let p1 = gov.try_acquire(SessionWeight::HeavyProcess).expect("heavy permit");
        let p2 = gov
            .try_acquire(SessionWeight::Multiplexed)
            .expect("multiplexed permit");
        assert_eq!(p1.weight(), SessionWeight::HeavyProcess);
        assert_eq!(p2.weight(), SessionWeight::Multiplexed);

        let snap = gov.snapshot();
        assert_eq!(
            snap,
            GovernorSnapshot {
                heavy_active: 1,
                heavy_limit: 4,
                multiplexed_active: 1,
                multiplexed_limit: 16,
                heavy_queued: 0,
            }
        );

        let serialized = serde_json::to_value(&snap).expect("serialize snapshot");
        assert_eq!(serialized["heavyActive"], 1);
        assert_eq!(serialized["heavyLimit"], 4);
        assert_eq!(serialized["multiplexedActive"], 1);
        assert_eq!(serialized["multiplexedLimit"], 16);
        assert_eq!(serialized["heavyQueued"], 0);

        drop(p1);
        drop(p2);

        let after = gov.snapshot();
        assert_eq!(after.heavy_active, 0);
        assert_eq!(after.multiplexed_active, 0);
    }

    #[test]
    fn blocks_at_custom_cap_2_and_cap_4_until_drop_releases_slot() {
        let gov4 = ProcessGovernor::with_limits(4, 16);
        let mut held4 = Vec::new();
        for _ in 0..4 {
            held4.push(
                gov4.try_acquire(SessionWeight::HeavyProcess)
                    .expect("within cap 4"),
            );
        }
        assert!(gov4.try_acquire(SessionWeight::HeavyProcess).is_none());
        let mut mux_held = Vec::new();
        for _ in 0..DEFAULT_MULTIPLEXED_LIMIT {
            mux_held.push(
                gov4.try_acquire(SessionWeight::Multiplexed)
                    .expect("within multiplexed cap 16"),
            );
        }
        assert!(gov4.try_acquire(SessionWeight::Multiplexed).is_none());
        drop(mux_held);
        assert_eq!(gov4.snapshot().multiplexed_active, 0);
        held4.pop();
        assert!(gov4.try_acquire(SessionWeight::HeavyProcess).is_some());
        drop(held4);

        let gov2 = Arc::new(ProcessGovernor::with_limits(2, 16));
        let h1 = gov2.try_acquire(SessionWeight::HeavyProcess).unwrap();
        let h2 = gov2.try_acquire(SessionWeight::HeavyProcess).unwrap();
        assert!(gov2.try_acquire(SessionWeight::HeavyProcess).is_none());

        let acquired = Arc::new(AtomicBool::new(false));
        let gov2_bg = Arc::clone(&gov2);
        let acquired_bg = Arc::clone(&acquired);
        let waiter = thread::spawn(move || {
            let permit = gov2_bg
                .acquire(SessionWeight::HeavyProcess, None)
                .expect("acquire after release");
            acquired_bg.store(true, Ordering::SeqCst);
            drop(permit);
        });

        wait_until(Duration::from_secs(2), || gov2.snapshot().heavy_queued == 1);
        assert!(!acquired.load(Ordering::SeqCst));

        drop(h1);
        waiter.join().expect("waiter finished");
        assert!(acquired.load(Ordering::SeqCst));
        drop(h2);
        assert_eq!(gov2.snapshot().heavy_active, 0);
        assert_eq!(gov2.snapshot().heavy_queued, 0);
    }

    #[test]
    fn grants_queued_waiters_in_strict_fifo_order() {
        let gov = Arc::new(ProcessGovernor::with_limits(1, 16));
        let holder = gov.try_acquire(SessionWeight::HeavyProcess).unwrap();
        let order = Arc::new(Mutex::new(Vec::new()));
        let mut handles = Vec::new();

        for id in 1..=4 {
            let gov_c = Arc::clone(&gov);
            let order_c = Arc::clone(&order);
            let h = thread::spawn(move || {
                let permit = gov_c
                    .acquire(SessionWeight::HeavyProcess, None)
                    .expect("waiter should acquire");
                order_c.lock().unwrap().push(id);
                drop(permit);
            });
            wait_until(Duration::from_secs(2), || gov.snapshot().heavy_queued == id);
            handles.push(h);
        }

        // Release the single slot so waiters proceed strictly in ticket order.
        drop(holder);
        for h in handles {
            h.join().expect("waiter join");
        }

        assert_eq!(*order.lock().unwrap(), vec![1, 2, 3, 4]);
        assert_eq!(gov.snapshot().heavy_active, 0);
        assert_eq!(gov.snapshot().heavy_queued, 0);
    }

    #[test]
    fn cancel_wakes_immediately_recovers_slot_and_unblocks_next_waiter() {
        let pre_cancelled = Arc::new(AtomicBool::new(true));
        let gov = Arc::new(ProcessGovernor::with_limits(1, 16));
        assert!(gov
            .acquire(SessionWeight::HeavyProcess, Some(&pre_cancelled))
            .is_err());
        assert_eq!(gov.snapshot().heavy_active, 0);

        let holder = gov.try_acquire(SessionWeight::HeavyProcess).unwrap();
        let cancel_head = Arc::new(AtomicBool::new(false));
        let (tx1, rx1) = mpsc::channel();
        let gov_1 = Arc::clone(&gov);
        let cancel_1 = Arc::clone(&cancel_head);
        let t1 = thread::spawn(move || {
            let res = gov_1.acquire(SessionWeight::HeavyProcess, Some(&cancel_1));
            let _ = tx1.send(res.is_err());
        });
        wait_until(Duration::from_secs(2), || gov.snapshot().heavy_queued == 1);

        let (tx2, rx2) = mpsc::channel();
        let gov_2 = Arc::clone(&gov);
        let t2 = thread::spawn(move || {
            let permit = gov_2
                .acquire(SessionWeight::HeavyProcess, None)
                .expect("second waiter acquires after head cancels and holder drops");
            let _ = tx2.send(());
            drop(permit);
        });
        wait_until(Duration::from_secs(2), || gov.snapshot().heavy_queued == 2);

        cancel_head.store(true, Ordering::SeqCst);
        let was_err = rx1
            .recv_timeout(Duration::from_secs(1))
            .expect("cancelled waiter wakes immediately");
        assert!(was_err);
        t1.join().unwrap();

        // Slot must still belong only to `holder`, with `t2` now at head of queue.
        let mid = gov.snapshot();
        assert_eq!(mid.heavy_active, 1);
        assert_eq!(mid.heavy_queued, 1);

        drop(holder);
        rx2.recv_timeout(Duration::from_secs(1))
            .expect("second waiter unblocks cleanly");
        t2.join().unwrap();

        let end = gov.snapshot();
        assert_eq!(end.heavy_active, 0);
        assert_eq!(end.heavy_queued, 0);
    }

    #[test]
    fn set_heavy_limit_clamps_1_to_8_and_unblocks_queued_waiters() {
        let gov = Arc::new(ProcessGovernor::with_limits(1, 16));
        gov.set_heavy_limit(0);
        assert_eq!(gov.snapshot().heavy_limit, 1);
        gov.set_heavy_limit(99);
        assert_eq!(gov.snapshot().heavy_limit, 8);
        gov.set_heavy_limit(1);
        assert_eq!(gov.snapshot().heavy_limit, 1);

        let holder = gov.try_acquire(SessionWeight::HeavyProcess).unwrap();
        let (tx, rx) = mpsc::channel();
        let mut waiters = Vec::new();
        for idx in 1..=2 {
            let gov_c = Arc::clone(&gov);
            let tx_c = tx.clone();
            let h = thread::spawn(move || {
                let permit = gov_c
                    .acquire(SessionWeight::HeavyProcess, None)
                    .expect("waiter unblocks when limit rises");
                let _ = tx_c.send(idx);
                drop(permit);
            });
            wait_until(Duration::from_secs(2), || gov.snapshot().heavy_queued == idx);
            waiters.push(h);
        }

        // Raising limit from 1 to 3 while `holder` is still active must wake both queued waiters.
        gov.set_heavy_limit(3);
        let a = rx.recv_timeout(Duration::from_secs(1)).unwrap();
        let b = rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!([a.min(b), a.max(b)], [1, 2]);

        for h in waiters {
            h.join().unwrap();
        }
        assert_eq!(gov.snapshot().heavy_active, 1);
        assert_eq!(gov.snapshot().heavy_queued, 0);

        drop(holder);
        assert_eq!(gov.snapshot().heavy_active, 0);
    }

    #[test]
    fn global_process_governor_and_snapshot_reflect_active_permits() {
        let permit = global_process_governor()
            .try_acquire(SessionWeight::Multiplexed)
            .expect("global multiplexed permit");
        assert!(governor_snapshot().multiplexed_active >= 1);
        drop(permit);
    }
}
