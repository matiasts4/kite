use crate::remote::auth::now_unix_ms;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{broadcast, oneshot, watch};

const EVENT_BUS_CAPACITY: usize = 512;
const WATCHER_POLL_INTERVAL_MS: u64 = 120;

#[derive(Debug, Clone)]
pub struct RemotePushEvent {
    pub event: String,
    pub seq: u64,
    pub ts: i64,
    pub thread_id: Option<String>,
    pub payload: Value,
}

impl RemotePushEvent {
    pub fn to_wire_json(&self) -> String {
        json!({
            "type": "event",
            "event": self.event,
            "seq": self.seq,
            "ts": self.ts,
            "payload": self.payload,
        })
        .to_string()
    }
}

pub struct RemoteEventBus {
    tx: broadcast::Sender<RemotePushEvent>,
    seq: AtomicU64,
    next_conn_id: AtomicU64,
    connected_count: AtomicUsize,
    device_killers: Mutex<HashMap<String, Vec<(u64, watch::Sender<bool>)>>>,
    pending_argos: Mutex<HashMap<String, oneshot::Sender<Value>>>,
    thread_subscribers: Mutex<HashMap<String, usize>>,
    active_watchers: Mutex<HashMap<String, bool>>,
    initial_cursors: Mutex<HashMap<String, (String, u64)>>,
}

impl RemoteEventBus {
    pub fn new() -> Arc<Self> {
        let (tx, _) = broadcast::channel(EVENT_BUS_CAPACITY);
        Arc::new(Self {
            tx,
            seq: AtomicU64::new(1),
            next_conn_id: AtomicU64::new(1),
            connected_count: AtomicUsize::new(0),
            device_killers: Mutex::new(HashMap::new()),
            pending_argos: Mutex::new(HashMap::new()),
            thread_subscribers: Mutex::new(HashMap::new()),
            active_watchers: Mutex::new(HashMap::new()),
            initial_cursors: Mutex::new(HashMap::new()),
        })
    }

    pub fn subscribe_events(&self) -> broadcast::Receiver<RemotePushEvent> {
        self.tx.subscribe()
    }

    pub fn publish(&self, event: impl Into<String>, payload: Value) {
        self.emit_internal(None, event.into(), payload);
    }

    pub fn publish_for_thread(
        &self,
        thread_id: impl Into<String>,
        event: impl Into<String>,
        payload: Value,
    ) {
        self.emit_internal(Some(thread_id.into()), event.into(), payload);
    }

    fn emit_internal(&self, thread_id: Option<String>, event: String, payload: Value) {
        let seq = self.seq.fetch_add(1, Ordering::Relaxed);
        let ts = now_unix_ms();
        let _ = self.tx.send(RemotePushEvent {
            event,
            seq,
            ts,
            thread_id,
            payload,
        });
    }

    pub fn next_seq_and_ts(&self) -> (u64, i64) {
        (self.seq.fetch_add(1, Ordering::Relaxed), now_unix_ms())
    }

    pub fn register_connection(&self, device_id: &str) -> (u64, watch::Receiver<bool>) {
        let conn_id = self.next_conn_id.fetch_add(1, Ordering::Relaxed);
        let (kill_tx, kill_rx) = watch::channel(false);
        {
            let mut map = self.device_killers.lock().unwrap_or_else(|e| e.into_inner());
            map.entry(device_id.to_string())
                .or_default()
                .push((conn_id, kill_tx));
        }
        self.connected_count.fetch_add(1, Ordering::Relaxed);
        (conn_id, kill_rx)
    }

    pub fn unregister_connection(&self, device_id: &str, conn_id: u64) {
        let mut removed = false;
        {
            let mut map = self.device_killers.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(entries) = map.get_mut(device_id) {
                let before = entries.len();
                entries.retain(|(id, _)| *id != conn_id);
                removed = entries.len() != before;
                if entries.is_empty() {
                    map.remove(device_id);
                }
            }
        }
        if removed {
            let _ = self
                .connected_count
                .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |c| Some(c.saturating_sub(1)));
        }
    }

    pub fn connected_device_ids(&self) -> HashSet<String> {
        let map = self.device_killers.lock().unwrap_or_else(|e| e.into_inner());
        map.iter()
            .filter(|(_, conns)| !conns.is_empty())
            .map(|(id, _)| id.clone())
            .collect()
    }

    pub fn disconnect_device(&self, device_id: &str) {
        let killers = {
            let mut map = self.device_killers.lock().unwrap_or_else(|e| e.into_inner());
            map.remove(device_id).unwrap_or_default()
        };
        let removed_count = killers.len();
        for (_, tx) in killers {
            let _ = tx.send(true);
        }
        if removed_count > 0 {
            let _ = self.connected_count.fetch_update(
                Ordering::Relaxed,
                Ordering::Relaxed,
                |c| Some(c.saturating_sub(removed_count)),
            );
        }
    }

    pub fn disconnect_all(&self) {
        let all = {
            let mut map = self.device_killers.lock().unwrap_or_else(|e| e.into_inner());
            std::mem::take(&mut *map)
        };
        for (_, entries) in all {
            for (_, tx) in entries {
                let _ = tx.send(true);
            }
        }
        self.connected_count.store(0, Ordering::Relaxed);
    }

    pub fn connected_clients(&self) -> usize {
        self.connected_count.load(Ordering::Relaxed)
    }

    pub fn register_argos_turn(&self, request_id: String) -> oneshot::Receiver<Value> {
        let (tx, rx) = oneshot::channel();
        let mut map = self.pending_argos.lock().unwrap_or_else(|e| e.into_inner());
        map.insert(request_id, tx);
        rx
    }

    pub fn resolve_argos_turn(&self, request_id: &str, payload: Value) -> bool {
        let sender = {
            let mut map = self.pending_argos.lock().unwrap_or_else(|e| e.into_inner());
            map.remove(request_id)
        };
        if let Some(tx) = sender {
            tx.send(payload).is_ok()
        } else {
            false
        }
    }

    pub fn cancel_argos_turn(&self, request_id: &str) {
        let mut map = self.pending_argos.lock().unwrap_or_else(|e| e.into_inner());
        map.remove(request_id);
    }

    pub fn add_thread_subscriber(self: &Arc<Self>, thread_id: &str, initial_cursor: Option<(String, u64)>) {
        if let Some(cursor) = initial_cursor {
            let mut cursors = self.initial_cursors.lock().unwrap_or_else(|e| e.into_inner());
            cursors.entry(thread_id.to_string()).or_insert(cursor);
        }
        {
            let mut subs = self.thread_subscribers.lock().unwrap_or_else(|e| e.into_inner());
            let entry = subs.entry(thread_id.to_string()).or_insert(0);
            *entry += 1;
        }
        self.ensure_thread_watcher(thread_id.to_string());
    }

    pub fn remove_thread_subscriber(&self, thread_id: &str) {
        let mut subs = self.thread_subscribers.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(count) = subs.get_mut(thread_id) {
            if *count <= 1 {
                subs.remove(thread_id);
            } else {
                *count -= 1;
            }
        }
    }

    pub fn subscriber_count(&self, thread_id: &str) -> usize {
        self.thread_subscribers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(thread_id)
            .copied()
            .unwrap_or(0)
    }

    pub fn ensure_thread_watcher(self: &Arc<Self>, thread_id: String) {
        if thread_id.trim().is_empty() {
            return;
        }
        {
            let mut watchers = self.active_watchers.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(recheck) = watchers.get_mut(&thread_id) {
                *recheck = true;
                return;
            }
            watchers.insert(thread_id.clone(), false);
        }
        let bus = Arc::clone(self);
        tokio::spawn(async move {
            run_thread_watcher(bus, thread_id).await;
        });
    }

    fn take_initial_cursor(&self, thread_id: &str) -> Option<(String, u64)> {
        self.initial_cursors
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(thread_id)
    }

    fn should_continue_or_remove_watcher(&self, thread_id: &str) -> bool {
        let mut watchers = self.active_watchers.lock().unwrap_or_else(|e| e.into_inner());
        if self.subscriber_count(thread_id) > 0 {
            if let Some(recheck) = watchers.get_mut(thread_id) {
                if *recheck {
                    *recheck = false;
                    return true;
                }
            }
        }
        watchers.remove(thread_id);
        false
    }
}

struct WatcherGuard {
    bus: Arc<RemoteEventBus>,
    thread_id: String,
    disarmed: bool,
}

impl Drop for WatcherGuard {
    fn drop(&mut self) {
        if self.disarmed {
            return;
        }
        let mut watchers = self.bus.active_watchers.lock().unwrap_or_else(|e| e.into_inner());
        watchers.remove(&self.thread_id);
    }
}

/// Captures the current `(run_id, next_sequence)` for a thread without mutating `delivered_through`.
pub fn active_run_cursor(thread_id: &str) -> Option<(String, u64)> {
    let live = crate::chat::runtime::state::live_turns()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let run_id = live.by_thread.get(thread_id)?;
    let run = live.runs.get(run_id)?;
    Some((run_id.clone(), run.next_sequence))
}

/// Non-mutating snapshot reader over `live_turns()`.
/// Unlike `read_turn_updates()`, this never modifies `run.delivered_through` so Desktop
/// compaction cannot drop events before the Desktop UI consumes them.
pub fn snapshot_turn_updates_readonly(
    run_id: &str,
    after_sequence: u64,
) -> (Vec<Value>, u64, bool, bool, bool) {
    let live = crate::chat::runtime::state::live_turns()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    match live.runs.get(run_id) {
        Some(run) => {
            let first_seq = run
                .events
                .first()
                .and_then(|event| event.get("sequence"))
                .and_then(Value::as_u64);
            let resync_required = match first_seq {
                Some(first) => first > after_sequence.saturating_add(1),
                None => run.next_sequence > after_sequence,
            };
            let mut events: Vec<Value> = run
                .events
                .iter()
                .filter(|ev| ev.get("sequence").and_then(Value::as_u64).unwrap_or(0) > after_sequence)
                .take(33)
                .cloned()
                .collect();
            let has_more = events.len() > 32;
            if has_more {
                events.truncate(32);
            }
            let next_seq = events
                .last()
                .and_then(|ev| ev.get("sequence"))
                .and_then(Value::as_u64)
                .unwrap_or(if resync_required { run.next_sequence } else { after_sequence });
            (events, next_seq, has_more, run.finished && !has_more, resync_required)
        }
        None => (Vec::new(), after_sequence, false, true, true),
    }
}

async fn emit_projected_snapshot(bus: &RemoteEventBus, thread_id: &str) -> Option<(String, bool)> {
    let tid = thread_id.to_string();
    let projected = tokio::task::spawn_blocking(move || {
        let raw = crate::chat::load_thread(&tid, None, "Chat Thread");
        crate::chat::subagents::project_thread_for_ipc(raw)
    })
    .await
    .ok()?;
    let st = projected
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("idle")
        .to_string();
    let waiting = projected.get("pendingApproval").is_some_and(|v| !v.is_null())
        || projected.get("pendingUserInput").is_some_and(|v| !v.is_null());
    bus.publish_for_thread(
        thread_id,
        "thread.snapshot",
        json!({ "threadId": thread_id, "thread": projected }),
    );
    Some((st, waiting))
}

async fn run_thread_watcher(bus: Arc<RemoteEventBus>, thread_id: String) {
    let mut guard = WatcherGuard {
        bus: Arc::clone(&bus),
        thread_id: thread_id.clone(),
        disarmed: false,
    };

    let mut active_run_id: Option<String> = None;
    let mut after_sequence: u64 = 0;
    let mut last_approval_key: Option<String> = None;
    let mut last_input_key: Option<String> = None;
    let mut idle_polls: u32 = 0;

    loop {
        if bus.subscriber_count(&thread_id) == 0 {
            break;
        }

        let live_snapshot: Option<(String, bool, u64)> = {
            let live = crate::chat::runtime::state::live_turns()
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            live.by_thread.get(&thread_id).and_then(|run_id| {
                live.runs
                    .get(run_id)
                    .map(|run| (run_id.clone(), run.finished, run.next_sequence))
            })
        };

        let (thread_status, thread_title, thread_profile_id, pending_approval, user_input_key) = {
            let items = crate::persist::threads()
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if let Some(thread) = items
                .iter()
                .find(|t| t.get("id").and_then(Value::as_str) == Some(thread_id.as_str()))
            {
                let st = thread.get("status").and_then(Value::as_str).unwrap_or("idle").to_string();
                let title = thread.get("title").and_then(Value::as_str).unwrap_or("Chat").to_string();
                let profile_id = thread
                    .get("profileId")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string);
                let approval = thread.get("pendingApproval").filter(|v| !v.is_null()).cloned();
                let u_key = thread
                    .get("pendingUserInput")
                    .filter(|v| !v.is_null())
                    .map(|u| {
                        u.get("requestId")
                            .or_else(|| u.get("request_id"))
                            .and_then(Value::as_str)
                            .map(str::to_string)
                            .unwrap_or_else(|| u.to_string())
                    });
                (st, title, profile_id, approval, u_key)
            } else {
                ("idle".to_string(), "Chat".to_string(), None, None, None)
            }
        };

        if let Some(approval) = pending_approval.as_ref() {
            let key = approval
                .get("requestId")
                .or_else(|| approval.get("id"))
                .or_else(|| approval.get("title"))
                .and_then(Value::as_str)
                .unwrap_or("approval")
                .to_string();
            if last_approval_key.as_deref() != Some(key.as_str()) {
                last_approval_key = Some(key);
                bus.publish_for_thread(
                    &thread_id,
                    "thread.approval_required",
                    json!({
                        "threadId": thread_id,
                        "title": thread_title,
                        "profileId": thread_profile_id,
                        "approval": approval,
                    }),
                );
            }
        } else {
            last_approval_key = None;
        }

        if user_input_key != last_input_key {
            let appeared = user_input_key.is_some();
            last_input_key = user_input_key.clone();
            if appeared {
                let _ = emit_projected_snapshot(&bus, &thread_id).await;
            }
        }

        if let Some((run_id, run_finished, _)) = live_snapshot {
            idle_polls = 0;
            if active_run_id.as_deref() != Some(run_id.as_str()) {
                active_run_id = Some(run_id.clone());
                after_sequence = match bus.take_initial_cursor(&thread_id) {
                    Some((cursor_run, cursor_seq)) if cursor_run == run_id => cursor_seq,
                    _ => 0,
                };
            }

            let mut was_cancelled = false;
            let mut had_error = false;
            let mut settled = run_finished;

            loop {
                let (events, next_seq, has_more, finished_now, resync_required) =
                    snapshot_turn_updates_readonly(&run_id, after_sequence);

                if resync_required {
                    let _ = emit_projected_snapshot(&bus, &thread_id).await;
                    after_sequence = next_seq;
                    if finished_now {
                        settled = true;
                    }
                    break;
                }

                if !events.is_empty() {
                    for ev in &events {
                        if ev.get("kind").and_then(Value::as_str) == Some("finished")
                            && ev.get("stoppedByBuilder").and_then(Value::as_bool) == Some(true)
                        {
                            was_cancelled = true;
                        }
                        if ev.get("kind").and_then(Value::as_str) == Some("status")
                            && ev.get("status").and_then(Value::as_str) == Some("error")
                        {
                            had_error = true;
                        }
                    }
                    after_sequence = next_seq;
                    bus.publish_for_thread(
                        &thread_id,
                        "thread.delta",
                        json!({ "threadId": thread_id, "runId": run_id, "events": events, "nextSequence": next_seq }),
                    );
                }

                if finished_now {
                    settled = true;
                }
                if !has_more {
                    break;
                }
            }

            if settled {
                let mut settled_status = thread_status.clone();
                let mut settled_waiting = pending_approval.is_some() || user_input_key.is_some();
                if let Some((st, waiting)) = emit_projected_snapshot(&bus, &thread_id).await {
                    settled_status = st;
                    settled_waiting = waiting;
                }
                let final_status = if was_cancelled {
                    "cancelled"
                } else if settled_status == "waiting" || settled_waiting {
                    "waiting"
                } else if had_error || settled_status == "error" {
                    "error"
                } else {
                    "idle"
                };
                bus.publish_for_thread(
                    &thread_id,
                    "thread.finished",
                    json!({ "threadId": thread_id, "runId": run_id, "status": final_status }),
                );
                if !bus.should_continue_or_remove_watcher(&thread_id) {
                    guard.disarmed = true;
                    return;
                }
                active_run_id = None;
                continue;
            }
        } else {
            if let Some(run_id) = active_run_id.take() {
                let final_status = if thread_status == "waiting"
                    || pending_approval.is_some()
                    || user_input_key.is_some()
                {
                    "waiting"
                } else if thread_status == "error" {
                    "error"
                } else {
                    "idle"
                };
                let _ = emit_projected_snapshot(&bus, &thread_id).await;
                bus.publish_for_thread(
                    &thread_id,
                    "thread.finished",
                    json!({ "threadId": thread_id, "runId": run_id, "status": final_status }),
                );
                if !bus.should_continue_or_remove_watcher(&thread_id) {
                    guard.disarmed = true;
                    return;
                }
                continue;
            }
            idle_polls += 1;
            if thread_status != "running" && idle_polls >= 2 {
                if !bus.should_continue_or_remove_watcher(&thread_id) {
                    guard.disarmed = true;
                    return;
                }
                idle_polls = 0;
                continue;
            }
        }

        tokio::time::sleep(Duration::from_millis(WATCHER_POLL_INTERVAL_MS)).await;
    }
}
