//! Shared child-thread kill registry and turn launcher helper.
//!
//! Kept independent of `swarm` and `dispatch_wire::protocol` so both `chat::subagents`
//! and `dispatch_wire` depend downward without cycles or layering inversions.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde_json::Value;

use crate::persist::threads;

#[derive(Clone, Copy, PartialEq, Eq)]
enum ThreadLifecycleFlag {
    Killed,
    Settled,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum MarkKillOutcome {
    Marked,
    AlreadySettled,
}

fn killed_threads() -> &'static Mutex<HashMap<String, ThreadLifecycleFlag>> {
    static KILLED: OnceLock<Mutex<HashMap<String, ThreadLifecycleFlag>>> = OnceLock::new();
    KILLED.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn mark_thread_killed(thread_id: &str) {
    if let Ok(mut map) = killed_threads().lock() {
        map.insert(thread_id.to_string(), ThreadLifecycleFlag::Killed);
    }
}

pub fn try_mark_thread_killed(thread_id: &str) -> MarkKillOutcome {
    if let Ok(mut map) = killed_threads().lock() {
        if map.get(thread_id) == Some(&ThreadLifecycleFlag::Settled) {
            return MarkKillOutcome::AlreadySettled;
        }
        map.insert(thread_id.to_string(), ThreadLifecycleFlag::Killed);
    }
    MarkKillOutcome::Marked
}

pub fn try_mark_thread_settled(thread_id: &str) -> bool {
    if let Ok(mut map) = killed_threads().lock() {
        if map.get(thread_id) == Some(&ThreadLifecycleFlag::Killed) {
            return false;
        }
        map.insert(thread_id.to_string(), ThreadLifecycleFlag::Settled);
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
        .map(|map| map.get(thread_id) == Some(&ThreadLifecycleFlag::Killed))
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
}
