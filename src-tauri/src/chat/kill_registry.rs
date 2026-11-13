//! Shared child-thread kill registry and turn launcher helper.
//!
//! Kept independent of `swarm` and `dispatch_wire::protocol` so both `chat::subagents`
//! and `dispatch_wire` depend downward without cycles or layering inversions.

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

use serde_json::Value;

use crate::persist::threads;

fn killed_threads() -> &'static Mutex<HashSet<String>> {
    static KILLED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    KILLED.get_or_init(|| Mutex::new(HashSet::new()))
}

pub fn mark_thread_killed(thread_id: &str) {
    if let Ok(mut set) = killed_threads().lock() {
        set.insert(thread_id.to_string());
    }
}

pub fn clear_thread_killed(thread_id: &str) {
    if let Ok(mut set) = killed_threads().lock() {
        set.remove(thread_id);
    }
}

pub fn is_thread_killed(thread_id: &str) -> bool {
    killed_threads()
        .lock()
        .ok()
        .map(|set| set.contains(thread_id))
        .unwrap_or(false)
}

/// Launches a follow-up or initial turn on an existing child subagent/swarm thread.
pub fn launch_child_thread_turn(child_thread_id: &str, prompt: &str) -> Result<(), String> {
    clear_thread_killed(child_thread_id);
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
