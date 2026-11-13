use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
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

pub(super) fn collect_wait_matches(state: &SwarmState, caller_name: &str, since: u64, mentions_only: bool) -> Option<String> {
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
        Some(format!("{}\n---\n{}", format_posts(&matched), format_status(state)))
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
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);

    loop {
        let observed_gen = {
            let gen_guard = channel.condvar.0.lock().unwrap_or_else(|e| e.into_inner());
            *gen_guard
        };
        {
            let _guard = swarm_state_lock().lock().unwrap_or_else(|e| e.into_inner());
            let (state, _) = load_swarm_state(coord_tid, None);
            if let Some(output) = collect_wait_matches(&state, caller_name, since, mentions_only) {
                return Ok(output);
            }
        }
        let now = Instant::now();
        if now >= deadline {
            let _guard = swarm_state_lock().lock().unwrap_or_else(|e| e.into_inner());
            let (state, _) = load_swarm_state(coord_tid, None);
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
    let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);

    loop {
        let notified = channel.notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        {
            let _guard = swarm_state_lock().lock().unwrap_or_else(|e| e.into_inner());
            let (state, _) = load_swarm_state(&coord_tid, None);
            if let Some(output) = collect_wait_matches(&state, &caller_name, since, mentions_only) {
                return Ok(output);
            }
        }
        let now = tokio::time::Instant::now();
        if now >= deadline {
            let _guard = swarm_state_lock().lock().unwrap_or_else(|e| e.into_inner());
            let (state, _) = load_swarm_state(&coord_tid, None);
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
