//! Shared child-thread kill registry and turn launcher helper.
//!
//! Kept independent of `swarm` and `dispatch_wire::protocol` so both `chat::subagents`
//! and `dispatch_wire` depend downward without cycles or layering inversions.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde_json::Value;

use crate::persist::threads;

pub const MAX_KILLED_THREADS: usize = 256;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ThreadLifecycleFlag {
    Killed,
    Settled,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum MarkKillOutcome {
    Marked,
    AlreadySettled,
}

#[derive(Clone, Copy)]
struct KillRegistryEntry {
    flag: ThreadLifecycleFlag,
    seq: u64,
}

#[derive(Default)]
struct KilledThreadsMap {
    entries: HashMap<String, KillRegistryEntry>,
    next_seq: u64,
}

impl KilledThreadsMap {
    fn get(&self, thread_id: &str) -> Option<ThreadLifecycleFlag> {
        self.entries.get(thread_id).map(|entry| entry.flag)
    }

    fn insert(&mut self, thread_id: &str, flag: ThreadLifecycleFlag) {
        self.next_seq = self.next_seq.wrapping_add(1);
        let seq = self.next_seq;
        self.entries
            .insert(thread_id.to_string(), KillRegistryEntry { flag, seq });
        self.prune_settled_over_limit(MAX_KILLED_THREADS);
    }

    fn remove(&mut self, thread_id: &str) {
        self.entries.remove(thread_id);
    }

    fn prune_settled_over_limit(&mut self, max_entries: usize) {
        while self.entries.len() > max_entries {
            let oldest_settled = self
                .entries
                .iter()
                .filter(|(_, entry)| entry.flag == ThreadLifecycleFlag::Settled)
                .min_by_key(|(_, entry)| entry.seq)
                .map(|(key, _)| key.clone());
            let Some(key) = oldest_settled else {
                break;
            };
            self.entries.remove(&key);
        }
    }
}

fn killed_threads() -> &'static Mutex<KilledThreadsMap> {
    static KILLED: OnceLock<Mutex<KilledThreadsMap>> = OnceLock::new();
    KILLED.get_or_init(|| Mutex::new(KilledThreadsMap::default()))
}

pub fn mark_thread_killed(thread_id: &str) {
    if let Ok(mut map) = killed_threads().lock() {
        map.insert(thread_id, ThreadLifecycleFlag::Killed);
    }
}

pub fn try_mark_thread_killed(thread_id: &str) -> MarkKillOutcome {
    if let Ok(mut map) = killed_threads().lock() {
        if map.get(thread_id) == Some(ThreadLifecycleFlag::Settled) {
            return MarkKillOutcome::AlreadySettled;
        }
        map.insert(thread_id, ThreadLifecycleFlag::Killed);
    }
    MarkKillOutcome::Marked
}

pub fn try_mark_thread_settled(thread_id: &str) -> bool {
    if let Ok(mut map) = killed_threads().lock() {
        if map.get(thread_id) == Some(ThreadLifecycleFlag::Killed) {
            return false;
        }
        map.insert(thread_id, ThreadLifecycleFlag::Settled);
        return true;
    }
    true
}

pub fn clear_thread_killed(thread_id: &str) {
    if let Ok(mut map) = killed_threads().lock() {
        map.remove(thread_id);
    }
}

pub fn is_thread_killed(thread_id: &str) -> bool {
    killed_threads()
        .lock()
        .ok()
        .map(|map| map.get(thread_id) == Some(ThreadLifecycleFlag::Killed))
        .unwrap_or(false)
}

/// Launches an automated/queued turn on an existing child subagent/swarm thread.
/// Refuses to resurrect a thread that has already been marked `Killed`.
pub fn launch_child_thread_turn(child_thread_id: &str, prompt: &str) -> Result<(), String> {
    if is_thread_killed(child_thread_id) {
        return Err("thread was killed".to_string());
    }
    start_child_thread_turn_inner(child_thread_id, prompt)
}

/// Resumes or steers a child thread from an explicit user action, clearing any prior `Killed` mark.
pub fn resume_child_thread_turn(child_thread_id: &str, prompt: &str) -> Result<(), String> {
    clear_thread_killed(child_thread_id);
    start_child_thread_turn_inner(child_thread_id, prompt)
}

fn start_child_thread_turn_inner(child_thread_id: &str, prompt: &str) -> Result<(), String> {
    let profile_id = threads().lock().ok().and_then(|list| {
        list.iter()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(child_thread_id))
            .and_then(|t| t.get("profileId").and_then(Value::as_str))
            .map(str::to_string)
    });
    let value =
        crate::chat::start_turn(child_thread_id, profile_id.as_deref(), prompt, Vec::new(), None);
    if let Some(err) = value.get("error").and_then(Value::as_str) {
        Err(err.to_string())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_child_thread_turn_refuses_killed_thread_without_clearing_flag() {
        let tid = format!("t-killed-guard-{}", uuid::Uuid::new_v4().simple());
        assert_eq!(try_mark_thread_killed(&tid), MarkKillOutcome::Marked);
        let err = launch_child_thread_turn(&tid, "wake up").unwrap_err();
        assert!(err.contains("killed"), "unexpected error: {err}");
        assert!(is_thread_killed(&tid), "killed flag must stay set");
        clear_thread_killed(&tid);
    }

    #[test]
    fn killed_threads_map_caps_settled_fifo_and_never_prunes_killed_entries() {
        let mut map = KilledThreadsMap::default();
        for i in 0..10 {
            map.insert(&format!("active-kill-{i}"), ThreadLifecycleFlag::Killed);
        }
        for i in 0..(MAX_KILLED_THREADS + 25) {
            map.insert(&format!("settled-{i}"), ThreadLifecycleFlag::Settled);
        }
        assert_eq!(map.entries.len(), MAX_KILLED_THREADS);
        for i in 0..10 {
            assert_eq!(
                map.get(&format!("active-kill-{i}")),
                Some(ThreadLifecycleFlag::Killed),
                "active Killed entries must never be pruned"
            );
        }
        // Oldest settled entries were evicted; newest settled entries remain.
        assert_eq!(map.get("settled-0"), None);
        assert_eq!(map.get("settled-34"), None);
        assert_eq!(
            map.get(&format!("settled-{}", MAX_KILLED_THREADS + 24)),
            Some(ThreadLifecycleFlag::Settled)
        );
    }
}
