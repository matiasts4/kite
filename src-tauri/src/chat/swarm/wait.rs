use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::sync::Notify;

use super::*;
use crate::acp::extract_mentions;
use crate::chat::models::{default_mode, provider_ok};
use crate::chat::subagents::{
    emit_swarm_event, provision_subagent_worktree, register_swarm_worker_subagent_run,
    remembered_provider_defaults, resolve_git_repo_root, set_thread_effort_option,
    try_remove_clean_worktree, SwarmBoardPost, SwarmChannel, SwarmMember, SwarmState,
};
use crate::chat::threads::blank_thread;
use crate::chat::threads::touch;
use crate::chat::utils::now_ms;
use crate::dispatch::cli::{SwarmChannelAction, SwarmCommand};
use crate::dispatch::types::DispatchError;
use crate::persist::{persist, roaming_app_dir, threads, workspace_path};

struct CoordinatorWaitGuard(Option<Arc<WaitChannel>>);

impl CoordinatorWaitGuard {
    fn enter(channel: &Arc<WaitChannel>, caller_name: &str) -> Self {
        if caller_name == "coordinator" {
            channel
                .active_coordinator_waiters
                .fetch_add(1, Ordering::SeqCst);
            Self(Some(Arc::clone(channel)))
        } else {
            Self(None)
        }
    }
}

impl Drop for CoordinatorWaitGuard {
    fn drop(&mut self) {
        if let Some(ref ch) = self.0 {
            ch.active_coordinator_waiters.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

fn collect_wait_matches(
    state: &SwarmState,
    caller_name: &str,
    since: u64,
    mentions_only: bool,
) -> Option<(String, u64)> {
    let caller_member = if caller_name != "coordinator" {
        state
            .members
            .iter()
            .find(|m| m.name.eq_ignore_ascii_case(caller_name))
            .cloned()
    } else {
        None
    };

    let matched: Vec<&SwarmBoardPost> = state
        .posts
        .iter()
        .filter(|p| {
            if p.seq <= since {
                return false;
            }
            if !mentions_only {
                return true;
            }
            if caller_name == "coordinator" {
                coordinator_matches_post(p)
            } else if let Some(ref m) = caller_member {
                member_matches_post(m, p)
            } else {
                true
            }
        })
        .collect();

    if matched.is_empty() {
        None
    } else {
        let head = matched.iter().map(|p| p.seq).max().unwrap_or(since);
        Some((
            format!("{}\n---\n{}", format_posts(&matched), format_status(state)),
            head,
        ))
    }
}

fn ack_coordinator_wait_hit(
    coord_tid: &str,
    caller_name: &str,
    path: &Path,
    state: &mut SwarmState,
    matched_head: u64,
) {
    if caller_name == "coordinator" && matched_head > state.last_coordinator_wake_seq {
        state.last_coordinator_wake_seq = matched_head;
        save_and_broadcast_swarm(coord_tid, path, state);
    }
}

pub fn execute_swarm_wait(
    coord_tid: &str,
    caller_name: &str,
    since: u64,
    mentions_only: bool,
    timeout_ms: u64,
) -> Result<String, DispatchError> {
    let channel = wait_channel_for(coord_tid);
    let mut wait_guard = Some(CoordinatorWaitGuard::enter(&channel, caller_name));
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);

    loop {
        let observed_gen = {
            let gen_guard = channel.condvar.0.lock().unwrap_or_else(|e| e.into_inner());
            *gen_guard
        };
        {
            let _guard = swarm_state_lock().lock().unwrap_or_else(|e| e.into_inner());
            let (mut state, path) = load_swarm_state(coord_tid, None);
            if let Some((output, head)) =
                collect_wait_matches(&state, caller_name, since, mentions_only)
            {
                ack_coordinator_wait_hit(coord_tid, caller_name, &path, &mut state, head);
                return Ok(output);
            }
        }
        let now = Instant::now();
        if now >= deadline {
            let _guard = swarm_state_lock().lock().unwrap_or_else(|e| e.into_inner());
            let (mut state, path) = load_swarm_state(coord_tid, None);
            if let Some((output, head)) =
                collect_wait_matches(&state, caller_name, since, mentions_only)
            {
                ack_coordinator_wait_hit(coord_tid, caller_name, &path, &mut state, head);
                return Ok(output);
            }
            // Drop waiter guard under swarm_state_lock so no post can observe waiters > 0 after timeout.
            drop(wait_guard.take());
            return Ok(format!(
                "(wait timeout after {}ms with no new posts > #{since})\n---\n{}",
                timeout_ms,
                format_status(&state)
            ));
        }
        let remaining = deadline.saturating_duration_since(now);
        let gen_guard = channel.condvar.0.lock().unwrap_or_else(|e| e.into_inner());
        if *gen_guard == observed_gen {
            let _ = channel
                .condvar
                .1
                .wait_timeout(gen_guard, remaining)
                .unwrap_or_else(|e| e.into_inner());
        }
    }
}

pub async fn wait_swarm_async(
    from_address: &str,
    since: u64,
    mentions_only: bool,
    timeout_ms: u64,
) -> Result<String, DispatchError> {
    let (coord_tid, caller_name) = resolve_caller_scope(from_address)?;
    let channel = wait_channel_for(&coord_tid);
    let mut wait_guard = Some(CoordinatorWaitGuard::enter(&channel, &caller_name));
    let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);

    loop {
        let notified = channel.notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        {
            let _guard = swarm_state_lock().lock().unwrap_or_else(|e| e.into_inner());
            let (mut state, path) = load_swarm_state(&coord_tid, None);
            if let Some((output, head)) =
                collect_wait_matches(&state, &caller_name, since, mentions_only)
            {
                ack_coordinator_wait_hit(&coord_tid, &caller_name, &path, &mut state, head);
                return Ok(output);
            }
        }
        let now = tokio::time::Instant::now();
        if now >= deadline {
            let _guard = swarm_state_lock().lock().unwrap_or_else(|e| e.into_inner());
            let (mut state, path) = load_swarm_state(&coord_tid, None);
            if let Some((output, head)) =
                collect_wait_matches(&state, &caller_name, since, mentions_only)
            {
                ack_coordinator_wait_hit(&coord_tid, &caller_name, &path, &mut state, head);
                return Ok(output);
            }
            drop(wait_guard.take());
            return Ok(format!(
                "(wait timeout after {}ms with no new posts > #{since})\n---\n{}",
                timeout_ms,
                format_status(&state)
            ));
        }
        let remaining = deadline.saturating_duration_since(now);
        let _ = tokio::time::timeout(remaining, notified).await;
    }
}
