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

pub fn default_turn_launcher(child_thread_id: &str, prompt: &str) -> Result<(), String> {
    crate::chat::kill_registry::launch_child_thread_turn(child_thread_id, prompt)
}

pub(super) fn invoke_launcher(
    launcher: Option<SwarmTurnLauncher<'_>>,
    child_thread_id: &str,
    prompt: &str,
) -> Result<(), String> {
    match launcher {
        Some(f) => f(child_thread_id, prompt),
        None => default_turn_launcher(child_thread_id, prompt),
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn spawn_swarm_member_thread(
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
) -> Result<(String, String, Option<String>, Option<String>), DispatchError> {
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
    if workspace_mode == "share" || workspace_mode == "branch" {
        let base_str = base_cwd.ok_or(DispatchError::PathRejected)?;
        let base_path = PathBuf::from(&base_str);
        let repo_root = resolve_git_repo_root(&base_path).unwrap_or(base_path);
        let wt_path = provision_subagent_worktree(&repo_root, workspace_mode, &short_id)
            .map_err(|_| DispatchError::PathRejected)?;
        let wt_str = wt_path.to_string_lossy().to_string();
        child["worktreePath"] = json!(wt_str);
        child["workingDirectory"] = json!(wt_str);
        final_cwd = Some(wt_str);
    } else if let Some(ref dir) = final_cwd {
        child["workingDirectory"] = json!(dir);
    }

    let final_model = child.get("model").and_then(Value::as_str).map(str::to_string);
    if let Ok(mut all) = threads().lock() {
        all.push(child);
    }

    Ok((child_id, provider, final_model, final_cwd))
}

pub fn on_worker_turn_settled_with_launcher(
    child_thread_id: &str,
    ok: bool,
    launcher: Option<SwarmTurnLauncher<'_>>,
) {
    let swarm_ref = threads().lock().ok().and_then(|all| {
        let child = all
            .iter()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(child_thread_id))?;
        let coord_tid = child
            .get("swarmParentThreadId")
            .and_then(Value::as_str)?
            .to_string();
        let member_name = child
            .get("swarmMemberName")
            .and_then(Value::as_str)?
            .to_string();
        Some((coord_tid, member_name))
    });
    let Some((coord_tid, member_name)) = swarm_ref else {
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
    }
}

pub fn on_worker_turn_settled(child_thread_id: &str, ok: bool) {
    on_worker_turn_settled_with_launcher(child_thread_id, ok, None);
}
