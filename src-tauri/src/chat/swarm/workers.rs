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

pub fn default_turn_launcher(child_thread_id: &str, prompt: &str) -> Result<(), String> {
    crate::chat::kill_registry::launch_child_thread_turn(child_thread_id, prompt)
}

pub(super) fn invoke_launcher(
    launcher: Option<SwarmTurnLauncher<'_>>,
    child_thread_id: &str,
    prompt: &str,
) -> Result<(), String> {
    if crate::chat::kill_registry::is_thread_killed(child_thread_id) {
        return Err("member thread was killed".to_string());
    }
    match launcher {
        Some(f) => f(child_thread_id, prompt),
        None => default_turn_launcher(child_thread_id, prompt),
    }
}

pub(super) struct PreparedSwarmWorker {
    pub(super) child_id: String,
    pub(super) child_thread: Value,
    pub(super) provider: String,
    pub(super) model: Option<String>,
    pub(super) worktree_path: Option<String>,
    pub(super) workspace_mode: String,
}

#[allow(clippy::too_many_arguments)]
pub(super) fn prepare_swarm_member_thread(
    coord_thread_id: &str,
    swarm_id: &str,
    name: &str,
    provider_override: Option<&str>,
    model_override: Option<&str>,
    effort_override: Option<&str>,
    workspace_mode: &str,
    role_label: Option<&str>,
    fork_source: Option<&str>,
    fork_source_thread_id: Option<&str>,
    fallback_cwd: Option<&str>,
) -> Result<PreparedSwarmWorker, DispatchError> {
    let (coord_provider, coord_model, coord_ws_id, coord_cwd) = threads()
        .lock()
        .ok()
        .map(|all| {
            if let Some(c) = all
                .iter()
                .find(|t| t.get("id").and_then(Value::as_str) == Some(coord_thread_id))
            {
                let cp = c.get("provider").and_then(Value::as_str).map(str::to_string);
                let cm = c.get("model").and_then(Value::as_str).map(str::to_string);
                let cws = c.get("workspaceId").and_then(Value::as_str).map(str::to_string);
                let ccwd = c
                    .get("worktreePath")
                    .or_else(|| c.get("workingDirectory"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or_else(|| cws.as_deref().and_then(workspace_path));
                (cp, cm, cws, ccwd)
            } else {
                (None, None, None, None)
            }
        })
        .unwrap_or((None, None, None, None));

    let raw_provider = provider_override
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_ascii_lowercase)
        .or_else(|| coord_provider.clone())
        .unwrap_or_else(|| "antigravity".to_string());
    let Some(canon_provider) = crate::chat::models::canonical_thread_provider_id(&raw_provider)
    else {
        return Err(DispatchError::BadArgs);
    };
    let provider = canon_provider.to_string();

    let same_provider_as_parent = coord_provider
        .as_deref()
        .is_some_and(|p| p.eq_ignore_ascii_case(&provider));
    let (remembered_model, remembered_effort) = remembered_provider_defaults(&provider);
    let requested_model = model_override
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| {
            if provider_override.is_none() || same_provider_as_parent {
                coord_model.clone().or(remembered_model.clone())
            } else {
                remembered_model.clone()
            }
        });
    if model_override.is_some() {
        if let Some(ref explicit_model) = requested_model {
            crate::chat::models::validate_provider_model_selection(&provider, explicit_model)
                .map_err(|_| DispatchError::BadArgs)?;
        }
    }

    let child_id = uuid::Uuid::new_v4().to_string();
    let short_id: String = child_id.chars().filter(|c| *c != '-').take(8).collect();
    let title = role_label
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("@{name} ({provider})"));

    let mut child = blank_thread(
        &child_id,
        None,
        &title,
        &provider,
        coord_ws_id.as_deref(),
    );
    child["model"] = requested_model
        .as_ref()
        .map(|m| json!(m))
        .unwrap_or(Value::Null);
    child["mode"] = json!(default_mode(&provider));
    child["startedByAgent"] = json!(true);
    child["sideChat"] = json!(true);
    child["parentThreadId"] = json!(coord_thread_id);
    child["swarmParentThreadId"] = json!(coord_thread_id);
    child["swarmId"] = json!(swarm_id);
    child["swarmMemberName"] = json!(name);
    child["workspaceMode"] = json!(workspace_mode);
    if let Some(r) = role_label {
        child["subagentRole"] = json!(r);
    }
    if let Some(eff) = effort_override {
        set_thread_effort_option(&mut child, eff);
    } else if !same_provider_as_parent {
        if let Some(eff) = remembered_effort {
            set_thread_effort_option(&mut child, &eff);
        } else {
            child["effort"] = Value::Null;
            child["providerOptions"] = json!([]);
        }
    }

    if let Some(src_tid) = fork_source_thread_id.or_else(|| {
        if fork_source.is_some_and(|s| s.eq_ignore_ascii_case("coordinator")) {
            Some(coord_thread_id)
        } else {
            None
        }
    }) {
        if let Ok(all) = threads().lock() {
            if let Some(src) = all
                .iter()
                .find(|t| t.get("id").and_then(Value::as_str) == Some(src_tid))
            {
                if let Some(items) = src.get("items").and_then(Value::as_array) {
                    child["items"] = Value::Array(items.clone());
                }
            }
        }
    }

    let base_cwd = coord_cwd
        .or_else(|| fallback_cwd.map(str::to_string))
        .filter(|s| !s.trim().is_empty());
    let mut final_cwd = base_cwd.clone();
    let mut worktree_path: Option<String> = None;
    if workspace_mode == "share" || workspace_mode == "branch" {
        let base_str = base_cwd.ok_or(DispatchError::PathRejected)?;
        let base_path = PathBuf::from(&base_str);
        let repo_root = resolve_git_repo_root(&base_path).unwrap_or(base_path);
        let wt_path = provision_subagent_worktree(&repo_root, workspace_mode, &short_id)
            .map_err(|_| DispatchError::PathRejected)?;
        let wt_str = wt_path.to_string_lossy().to_string();
        child["worktreePath"] = json!(wt_str);
        child["workingDirectory"] = json!(wt_str);
        worktree_path = Some(wt_str.clone());
        final_cwd = Some(wt_str);
    } else if let Some(ref dir) = final_cwd {
        child["workingDirectory"] = json!(dir);
    }

    let final_model = child.get("model").and_then(Value::as_str).map(str::to_string);
    let _ = final_cwd;
    Ok(PreparedSwarmWorker {
        child_id,
        child_thread: child,
        provider,
        model: final_model,
        worktree_path,
        workspace_mode: workspace_mode.to_string(),
    })
}

pub(super) fn maybe_wake_idle_coordinator(
    coord_tid: &str,
    cwd: Option<&str>,
    launcher: Option<SwarmTurnLauncher<'_>>,
) {
    #[cfg(test)]
    if launcher.is_none() {
        return;
    }

    let channel = wait_channel_for(coord_tid);
    if crate::chat::kill_registry::is_thread_killed(coord_tid) || is_coordinator_busy(coord_tid) {
        return;
    }

    let wake_plan: Option<(u64, u64, String)> = {
        let _guard = swarm_state_lock().lock().unwrap_or_else(|e| e.into_inner());
        if channel.active_coordinator_waiters.load(Ordering::SeqCst) > 0 {
            return;
        }
        let (mut state, path) = load_swarm_state(coord_tid, cwd);
        let unread: Vec<SwarmBoardPost> = state
            .posts
            .iter()
            .filter(|p| p.seq > state.last_coordinator_wake_seq && coordinator_matches_post(p))
            .cloned()
            .collect();
        if unread.is_empty() {
            None
        } else {
            let prev_seq = state.last_coordinator_wake_seq;
            let max_seq = unread
                .iter()
                .map(|p| p.seq)
                .max()
                .unwrap_or(prev_seq);
            let next_seq = prev_seq.max(max_seq);
            state.last_coordinator_wake_seq = next_seq;
            let prompt = build_coordinator_wakeup_prompt(&state, &unread);
            save_and_broadcast_swarm(coord_tid, &path, &state);
            Some((prev_seq, next_seq, prompt))
        }
    };

    if let Some((prev_seq, next_seq, prompt)) = wake_plan {
        if invoke_launcher(launcher, coord_tid, &prompt).is_err() {
            let _guard = swarm_state_lock().lock().unwrap_or_else(|e| e.into_inner());
            let (mut state, path) = load_swarm_state(coord_tid, cwd);
            if state.last_coordinator_wake_seq == next_seq {
                state.last_coordinator_wake_seq = prev_seq;
                save_and_broadcast_swarm(coord_tid, &path, &state);
            }
        }
    }
}

pub fn on_worker_turn_settled_with_launcher(
    child_thread_id: &str,
    ok: bool,
    launcher: Option<SwarmTurnLauncher<'_>>,
) {
    let (swarm_ref, owns_swarm) = threads()
        .lock()
        .ok()
        .map(|all| {
            let Some(thread) = all
                .iter()
                .find(|t| t.get("id").and_then(Value::as_str) == Some(child_thread_id))
            else {
                return (None, false);
            };
            if let (Some(parent), Some(member)) = (
                thread.get("swarmParentThreadId").and_then(Value::as_str),
                thread.get("swarmMemberName").and_then(Value::as_str),
            ) {
                return (Some((parent.to_string(), member.to_string())), false);
            }
            let owns = thread.get("swarmState").is_some() || thread.get("swarmId").is_some();
            (None, owns)
        })
        .unwrap_or((None, false));

    let Some((coord_tid, member_name)) = swarm_ref else {
        if owns_swarm {
            maybe_wake_idle_coordinator(child_thread_id, None, launcher);
        }
        return;
    };

    let follow_up: Option<(String, String)> = {
        let _guard = swarm_state_lock().lock().unwrap_or_else(|e| e.into_inner());
        let (mut state, path) = load_swarm_state(&coord_tid, None);
        let Some(idx) = state
            .members
            .iter()
            .position(|m| m.name.eq_ignore_ascii_case(&member_name))
        else {
            return;
        };
        if state.members[idx].state == "killed" {
            return;
        }
        let prev_state = state.members[idx].state.clone();
        let unread_matching: Vec<SwarmBoardPost> = if ok && state.members[idx].pending_wake {
            state
                .posts
                .iter()
                .filter(|p| {
                    p.seq > state.members[idx].last_read_seq
                        && member_matches_post(&state.members[idx], p)
                })
                .cloned()
                .collect()
        } else {
            Vec::new()
        };

        let mut next_turn = None;
        state.members[idx].pending_wake = false;
        if !unread_matching.is_empty() {
            let max_seq = unread_matching
                .iter()
                .map(|p| p.seq)
                .max()
                .unwrap_or(state.members[idx].last_read_seq);
            state.members[idx].last_read_seq = max_seq;
            state.members[idx].state = "working".to_string();
            let wake_prompt =
                build_worker_wakeup_prompt(&state.title, &state.members[idx], &unread_matching);
            next_turn = Some((child_thread_id.to_string(), wake_prompt));
        } else {
            state.members[idx].state = if ok { "waiting" } else { "stopped" }.to_string();
            let has_unread_coord = state
                .posts
                .iter()
                .any(|p| p.seq > state.last_coordinator_wake_seq && coordinator_matches_post(p));
            let other_working = state
                .members
                .iter()
                .enumerate()
                .any(|(i, m)| i != idx && m.state == "working");
            // Post a synthetic blocker/completion notice if a worker stopped unexpectedly or the last active worker settled without posting.
            if !has_unread_coord
                && prev_state == "working"
                && (!ok || !other_working)
            {
                let note = if ok {
                    format!(
                        "@coordinator [done] All active workers settled (last settled: @{member_name})."
                    )
                } else {
                    format!(
                        "@coordinator [blocked] Worker @{member_name} stopped without posting to the board."
                    )
                };
                let seq = next_seq(&state);
                state.posts.push(SwarmBoardPost {
                    seq,
                    author: member_name.clone(),
                    channel: "main".to_string(),
                    mentions: extract_mentions(&note),
                    text: note,
                    created_at_unix_ms: now_ms(),
                });
            }
        }
        save_and_broadcast_swarm(&coord_tid, &path, &state);
        next_turn
    };

    if let Some((cid, prompt)) = follow_up {
        if let Err(err) = invoke_launcher(launcher, &cid, &prompt) {
            let _guard = swarm_state_lock().lock().unwrap_or_else(|e| e.into_inner());
            let (mut state, path) = load_swarm_state(&coord_tid, None);
            if let Some(m) = state
                .members
                .iter_mut()
                .find(|m| m.name.eq_ignore_ascii_case(&member_name))
            {
                m.state = "stopped".to_string();
                m.current_activity = Some(err);
            }
            save_and_broadcast_swarm(&coord_tid, &path, &state);
        }
    } else {
        maybe_wake_idle_coordinator(&coord_tid, None, launcher);
    }
}

pub fn on_worker_turn_settled(child_thread_id: &str, ok: bool) {
    on_worker_turn_settled_with_launcher(child_thread_id, ok, None);
}
