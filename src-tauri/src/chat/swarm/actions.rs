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
    try_remove_clean_worktree, try_remove_clean_worktree_path, SwarmBoardPost, SwarmChannel,
    SwarmMember, SwarmState,
};
use crate::chat::threads::blank_thread;
use crate::chat::threads::touch;
use crate::chat::utils::now_ms;
use crate::dispatch::cli::{SwarmChannelAction, SwarmCommand};
use crate::dispatch::types::DispatchError;
use crate::persist::{persist, roaming_app_dir, threads, workspace_path};

fn normalize_member_channels(channels: &[String]) -> Vec<String> {
    let mut member_channels: Vec<String> = Vec::new();
    for ch in channels {
        let norm = ch.trim().trim_start_matches('#').to_ascii_lowercase();
        if !norm.is_empty() && !member_channels.contains(&norm) {
            member_channels.push(norm);
        }
    }
    if !member_channels.iter().any(|c| c == "main") {
        member_channels.push("main".to_string());
    }
    member_channels
}

fn launch_pending_turns(
    coord_tid: &str,
    cwd: Option<&str>,
    launcher: Option<SwarmTurnLauncher<'_>>,
    pending_launches: Vec<(String, String, String)>,
) {
    for (member_name, child_id, prompt) in pending_launches {
        let already_killed = {
            let _guard = swarm_state_lock().lock().unwrap_or_else(|e| e.into_inner());
            let (state, _) = load_swarm_state(coord_tid, cwd);
            state
                .members
                .iter()
                .find(|m| m.name.eq_ignore_ascii_case(&member_name))
                .is_some_and(|m| m.state.eq_ignore_ascii_case("killed"))
        };
        if already_killed {
            continue;
        }
        if let Err(err) = invoke_launcher(launcher, &child_id, &prompt) {
            if let Ok(mut all) = threads().lock() {
                if let Some(child) = all
                    .iter_mut()
                    .find(|t| t.get("id").and_then(Value::as_str) == Some(child_id.as_str()))
                {
                    child["status"] = json!("error");
                    crate::chat::threads::touch(child);
                }
            }
            crate::chat::subagents::sync_child_thread_to_parent(&child_id);
            let _guard = swarm_state_lock().lock().unwrap_or_else(|e| e.into_inner());
            let (mut state, path) = load_swarm_state(coord_tid, cwd);
            if let Some(m) = state
                .members
                .iter_mut()
                .find(|m| m.name.eq_ignore_ascii_case(&member_name))
            {
                if !m.state.eq_ignore_ascii_case("killed") {
                    m.state = "stopped".to_string();
                    m.current_activity = Some(err);
                }
            }
            save_and_broadcast_swarm(coord_tid, &path, &state);
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn execute_swarm_add(
    coord_tid: &str,
    caller_name: &str,
    cwd: Option<&str>,
    launcher: Option<SwarmTurnLauncher<'_>>,
    name: &str,
    provider: Option<&str>,
    model: Option<&str>,
    effort: Option<&str>,
    workspace: Option<&str>,
    channels: &[String],
    fork: Option<&str>,
    role: Option<&str>,
    brief: &str,
) -> Result<String, DispatchError> {
    if !valid_worker_name(name) {
        return Err(DispatchError::BadArgs);
    }
    let cfg_dir = if cfg!(test) {
        None
    } else {
        Some(crate::persist::roaming_app_dir())
    };
    let resolved_target = role.and_then(|role_name| {
        crate::dispatch::role::resolve_role_target(
            cfg_dir.as_deref(),
            cwd.map(std::path::Path::new),
            role_name,
        )
    });
    let (
        role_provider,
        role_model,
        role_effort,
        role_workspace,
        role_mode,
        role_agent_id,
        role_label_owned,
        role_body_owned,
    ) = match resolved_target {
        Some(crate::dispatch::role::ResolvedRoleTarget::AgentProfile(ap)) => (
            ap.provider,
            ap.model,
            ap.effort,
            None,
            ap.mode,
            Some(ap.agent_id),
            Some(ap.display_name),
            None,
        ),
        Some(crate::dispatch::role::ResolvedRoleTarget::MarkdownRole(rf)) => {
            let rp = rf
                .provider
                .as_deref()
                .and_then(crate::chat::models::canonical_thread_provider_id)
                .or_else(|| crate::chat::models::canonical_thread_provider_id(&rf.command))
                .map(str::to_string);
            let body = Some(rf.body.trim().to_string()).filter(|b| !b.is_empty());
            (
                rp,
                rf.model,
                rf.effort,
                rf.workspace,
                None,
                None,
                role.map(str::to_string),
                body,
            )
        }
        None => (None, None, None, None, None, None, role.map(str::to_string), None),
    };
    let eff_provider_owned = provider.map(str::to_string).or(role_provider);
    let eff_model_owned = model.map(str::to_string).or(role_model);
    let eff_effort_owned = effort.map(str::to_string).or(role_effort);
    let eff_workspace_owned = workspace.map(str::to_string).or(role_workspace);

    let member_channels = normalize_member_channels(channels);
    let primary_channel = member_channels[0].clone();
    let ws_mode = eff_workspace_owned.as_deref().unwrap_or("inherit");

    // Lock 1: pre-check roster/channels without doing CLI discovery or git worktree I/O.
    let (swarm_id, fork_source_thread_id) = {
        let _guard = swarm_state_lock().lock().unwrap_or_else(|e| e.into_inner());
        let (state, _) = load_swarm_state(coord_tid, cwd);
        if state
            .members
            .iter()
            .any(|m| m.name.eq_ignore_ascii_case(name) && m.child_thread_id.is_some())
        {
            return Err(DispatchError::NameTaken);
        }
        for ch in &member_channels {
            if state.channels.iter().any(|c| c.name == *ch && c.archived) {
                return Err(DispatchError::DestinationGone);
            }
        }
        let fork_source_thread_id = match fork {
            Some(src) if src.eq_ignore_ascii_case("coordinator") => Some(coord_tid.to_string()),
            Some(src) => Some(
                state
                    .members
                    .iter()
                    .find(|m| m.name.eq_ignore_ascii_case(src))
                    .and_then(|m| m.child_thread_id.clone())
                    .ok_or(DispatchError::UnknownAddress)?,
            ),
            None => None,
        };
        (state.swarm_id, fork_source_thread_id)
    };

    // Unlocked preparation: model validation + worktree creation happen without holding swarm_state_lock.
    let prepared = prepare_swarm_member_thread(
        coord_tid,
        &swarm_id,
        name,
        eff_provider_owned.as_deref(),
        eff_model_owned.as_deref(),
        eff_effort_owned.as_deref(),
        role_mode.as_deref(),
        role_agent_id.as_deref(),
        ws_mode,
        role_label_owned.as_deref(),
        fork,
        fork_source_thread_id.as_deref(),
        cwd,
    )?;

    let wt_cleanup = prepared.worktree_path.clone();
    let ws_cleanup = prepared.workspace_mode.clone();
    let mut pending_launches: Vec<(String, String, String)> = Vec::new();
    let mut rollback_worktree = false;
    let commit_res = {
        let _guard = swarm_state_lock().lock().unwrap_or_else(|e| e.into_inner());
        let (mut state, path) = load_swarm_state(coord_tid, cwd);
        if state
            .members
            .iter()
            .any(|m| m.name.eq_ignore_ascii_case(name) && m.child_thread_id.is_some())
        {
            rollback_worktree = true;
            Err(DispatchError::NameTaken)
        } else {
            let mut ch_err = None;
            for ch in &member_channels {
                if let Err(err) = ensure_channel(&mut state, ch) {
                    ch_err = Some(err);
                    break;
                }
            }
            if let Some(err) = ch_err {
                rollback_worktree = true;
                Err(err)
            } else {
                let PreparedSwarmWorker {
                    child_id,
                    child_thread,
                    provider: resolved_provider,
                    model: resolved_model,
                    worktree_path: _,
                    workspace_mode: _,
                } = prepared;

                if let Ok(mut all) = threads().lock() {
                    all.push(child_thread);
                }

                let seq = next_seq(&state);
                let post_text = format!("@{name} {brief}");
                let post = SwarmBoardPost {
                    seq,
                    author: caller_name.to_string(),
                    channel: primary_channel,
                    text: post_text.clone(),
                    mentions: extract_mentions(&post_text),
                    created_at_unix_ms: now_ms(),
                };
                state.posts.push(post.clone());

                let member_role = role
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("{resolved_provider} worker"));
                let member = SwarmMember {
                    name: name.to_string(),
                    role: member_role.clone(),
                    provider: Some(resolved_provider.clone()),
                    model: resolved_model.clone(),
                    effort: eff_effort_owned.clone(),
                    workspace_mode: Some(ws_mode.to_string()),
                    state: "working".to_string(),
                    current_activity: None,
                    channels: member_channels,
                    subagent_id: Some(child_id.clone()),
                    child_thread_id: Some(child_id.clone()),
                    brief: Some(brief.to_string()),
                    last_read_seq: seq,
                    pending_wake: false,
                };
                state
                    .members
                    .retain(|m| !(m.name.eq_ignore_ascii_case(name) && m.child_thread_id.is_none()));
                let role_pair = role.zip(role_body_owned.as_deref());
                let prompt = build_worker_initial_prompt(&state, &member, &post, role_pair);
                state.members.push(member);
                register_swarm_worker_subagent_run(
                    coord_tid,
                    &child_id,
                    name,
                    &member_role,
                    &resolved_provider,
                    resolved_model.as_deref(),
                    Some(ws_mode),
                    brief,
                );
                save_and_broadcast_swarm(coord_tid, &path, &state);
                pending_launches.push((name.to_string(), child_id.clone(), prompt));

                Ok(format!(
                    "added @{name} (thread:{child_id}, provider={resolved_provider}, model={}, seq=#{seq})",
                    resolved_model.as_deref().unwrap_or("default"),
                ))
            }
        }
    };

    if rollback_worktree {
        if let Some(ref wt) = wt_cleanup {
            try_remove_clean_worktree_path(wt, &ws_cleanup);
        }
    }
    match commit_res {
        Ok(msg) => {
            launch_pending_turns(coord_tid, cwd, launcher, pending_launches);
            Ok(msg)
        }
        Err(err) => Err(err),
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn execute_swarm_model_with_settings(
    coord_tid: &str,
    cwd: Option<&str>,
    launcher: Option<SwarmTurnLauncher<'_>>,
    name: &str,
    provider: Option<&str>,
    model: &str,
    effort: Option<&str>,
    override_stack: bool,
    settings: &crate::subagent_settings::SubagentSettings,
) -> Result<String, DispatchError> {
    if name.eq_ignore_ascii_case("coordinator") {
        let canon_new = provider
            .map(|p| {
                crate::chat::models::canonical_thread_provider_id(p)
                    .map(str::to_string)
                    .ok_or(DispatchError::BadArgs)
            })
            .transpose()?;
        let eff_provider = if let Some(ref p) = canon_new {
            Some(p.clone())
        } else {
            threads().lock().ok().and_then(|all| {
                all.iter()
                    .find(|t| t.get("id").and_then(Value::as_str) == Some(coord_tid))
                    .and_then(|t| t.get("provider").and_then(Value::as_str))
                    .map(str::to_string)
            })
        };
        crate::subagent_settings::check_stack_policy(
            settings,
            eff_provider.as_deref(),
            Some(model),
            override_stack,
        )
        .map_err(|_| DispatchError::BadArgs)?;
        if let Some(ref eff_p) = eff_provider {
            crate::chat::models::validate_provider_model_selection(eff_p, model)
                .map_err(|_| DispatchError::BadArgs)?;
        }
        if let Ok(mut all) = threads().lock() {
            if let Some(coord) = all
                .iter_mut()
                .find(|t| t.get("id").and_then(Value::as_str) == Some(coord_tid))
            {
                let prev_provider = coord
                    .get("provider")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                if let Some(ref p) = canon_new {
                    if prev_provider.as_deref() != Some(p.as_str()) {
                        coord["providerSessionId"] = Value::Null;
                    }
                    coord["provider"] = json!(p);
                }
                coord["model"] = json!(model);
                if let Some(eff) = effort {
                    set_thread_effort_option(coord, eff);
                }
                touch(coord);
            }
        }
        let _guard = swarm_state_lock().lock().unwrap_or_else(|e| e.into_inner());
        let (mut state, path) = load_swarm_state(coord_tid, cwd);
        state.coordinator_model = Some(model.to_string());
        save_and_broadcast_swarm(coord_tid, &path, &state);
        return Ok(format!("switched coordinator -> model={model}"));
    }

    let canon_new_provider = provider
        .map(|p| {
            crate::chat::models::canonical_thread_provider_id(p)
                .map(str::to_string)
                .ok_or(DispatchError::BadArgs)
        })
        .transpose()?;

    // Lock 1: verify member readiness and resolve effective provider.
    let effective_provider = {
        let _guard = swarm_state_lock().lock().unwrap_or_else(|e| e.into_inner());
        let (state, _) = load_swarm_state(coord_tid, cwd);
        let member = state
            .members
            .iter()
            .find(|m| m.name.eq_ignore_ascii_case(name))
            .ok_or(DispatchError::UnknownAddress)?;
        if member.state == "killed" {
            return Err(DispatchError::DestinationGone);
        }
        if member.state == "working" {
            return Err(DispatchError::NotReady);
        }
        canon_new_provider.clone().or_else(|| member.provider.clone())
    };

    // Unlocked check: stack policy and CLI model discovery run without holding swarm_state_lock.
    crate::subagent_settings::check_stack_policy(
        settings,
        effective_provider.as_deref(),
        Some(model),
        override_stack,
    )
    .map_err(|_| DispatchError::BadArgs)?;
    if let Some(ref eff_p) = effective_provider {
        crate::chat::models::validate_provider_model_selection(eff_p, model)
            .map_err(|_| DispatchError::BadArgs)?;
    }

    let mut pending_launches: Vec<(String, String, String)> = Vec::new();
    let (result_text, child_to_sync) = {
        let _guard = swarm_state_lock().lock().unwrap_or_else(|e| e.into_inner());
        let (mut state, path) = load_swarm_state(coord_tid, cwd);
        let idx = state
            .members
            .iter()
            .position(|m| m.name.eq_ignore_ascii_case(name))
            .ok_or(DispatchError::UnknownAddress)?;
        if state.members[idx].state == "killed" {
            return Err(DispatchError::DestinationGone);
        }
        if state.members[idx].state == "working" {
            return Err(DispatchError::NotReady);
        }
        let prev_provider = state.members[idx].provider.clone();
        let prev_state = state.members[idx].state.clone();
        if let Some(ref p) = canon_new_provider {
            state.members[idx].provider = Some(p.clone());
        }
        state.members[idx].model = Some(model.to_string());
        if effort.is_some() {
            state.members[idx].effort = effort.map(str::to_string);
        }
        let child_tid = state.members[idx].child_thread_id.clone();
        let new_provider = state.members[idx].provider.clone();

        if let Some(ref cid) = child_tid {
            if let Ok(mut all) = threads().lock() {
                if let Some(child) = all
                    .iter_mut()
                    .find(|t| t.get("id").and_then(Value::as_str) == Some(cid.as_str()))
                {
                    if let Some(ref p) = new_provider {
                        if prev_provider.as_deref() != Some(p.as_str()) {
                            child["providerSessionId"] = Value::Null;
                        }
                        child["provider"] = json!(p);
                    }
                    child["model"] = json!(model);
                    if let Some(eff) = effort {
                        set_thread_effort_option(child, eff);
                    }
                    touch(child);
                }
            }
            if prev_state == "stopped" {
                let unread: Vec<SwarmBoardPost> = state
                    .posts
                    .iter()
                    .filter(|p| {
                        p.seq > state.members[idx].last_read_seq
                            && member_matches_post(&state.members[idx], p)
                    })
                    .cloned()
                    .collect();
                if let Some(max_seq) = unread.iter().map(|p| p.seq).max() {
                    state.members[idx].last_read_seq = max_seq;
                }
                state.members[idx].pending_wake = false;
                state.members[idx].state = "working".to_string();
                let provider_label = new_provider.as_deref().unwrap_or("inherit");
                let unread_block = if unread.is_empty() {
                    String::new()
                } else {
                    let refs: Vec<&SwarmBoardPost> = unread.iter().collect();
                    format!("\n\nUnread Board Posts:\n{}", format_posts(&refs))
                };
                let resume_prompt = format!(
                    "[Swarm Failover Resume] Your model was switched to {model} ({provider_label}). Keep your existing conversation context, resume any incomplete work on Swarm `{}`, and post updates via `kite dispatch swarm post \"@coordinator ...\"`.{unread_block}",
                    state.swarm_id
                );
                pending_launches.push((
                    state.members[idx].name.clone(),
                    cid.clone(),
                    resume_prompt,
                ));
            }
        }
        save_and_broadcast_swarm(coord_tid, &path, &state);
        (
            format!(
                "switched @{name} -> provider={} model={model}{}",
                new_provider.as_deref().unwrap_or("inherit"),
                if prev_state == "stopped" { " (resumed)" } else { "" }
            ),
            child_tid,
        )
    };

    if let Some(ref cid) = child_to_sync {
        crate::chat::subagents::sync_child_thread_to_parent(cid);
    }
    launch_pending_turns(coord_tid, cwd, launcher, pending_launches);
    Ok(result_text)
}

pub fn execute_swarm_action(
    command: &SwarmCommand,
    from_address: &str,
    cwd: Option<&str>,
    launcher: Option<SwarmTurnLauncher<'_>>,
) -> Result<String, DispatchError> {
    let (coord_tid, caller_name) = resolve_caller_scope(from_address)?;

    if let SwarmCommand::Wait {
        since,
        mentions_only,
        timeout_ms,
    } = command
    {
        return execute_swarm_wait(&coord_tid, &caller_name, *since, *mentions_only, *timeout_ms);
    }
    if let SwarmCommand::Add {
        name,
        provider,
        model,
        effort,
        workspace,
        channels,
        fork,
        role,
        override_stack: _,
        brief,
    } = command
    {
        return execute_swarm_add(
            &coord_tid,
            &caller_name,
            cwd,
            launcher,
            name,
            provider.as_deref(),
            model.as_deref(),
            effort.as_deref(),
            workspace.as_deref(),
            channels,
            fork.as_deref(),
            role.as_deref(),
            brief,
        );
    }
    if let SwarmCommand::Model {
        name,
        provider,
        model,
        effort,
        override_stack,
    } = command
    {
        let settings = crate::subagent_settings::get_subagent_settings();
        return execute_swarm_model_with_settings(
            &coord_tid,
            cwd,
            launcher,
            name,
            provider.as_deref(),
            model,
            effort.as_deref(),
            *override_stack,
            &settings,
        );
    }

    let mut pending_launches: Vec<(String, String, String)> = Vec::new();
    let mut pending_kills: Vec<String> = Vec::new();
    let mut maybe_wake_coord = false;
    let result_text = {
        let _guard = swarm_state_lock().lock().unwrap_or_else(|e| e.into_inner());
        let (mut state, path) = load_swarm_state(&coord_tid, cwd);

        match command {
            SwarmCommand::Title { title } => {
                state.title = title.trim().to_string();
                save_and_broadcast_swarm(&coord_tid, &path, &state);
                Ok(format!("Swarm title set to \"{}\" ({})", state.title, state.swarm_id))
            }
            SwarmCommand::Post { channel, text } => {
                let target_channel = channel
                    .as_deref()
                    .map(|c| c.trim().trim_start_matches('#').to_ascii_lowercase())
                    .filter(|c| !c.is_empty())
                    .unwrap_or_else(|| "main".to_string());
                ensure_channel(&mut state, &target_channel)?;

                let seq = next_seq(&state);
                let mentions = extract_mentions(text);
                let post = SwarmBoardPost {
                    seq,
                    author: caller_name.clone(),
                    channel: target_channel.clone(),
                    text: text.clone(),
                    mentions,
                    created_at_unix_ms: now_ms(),
                };
                state.posts.push(post.clone());

                let swarm_title = state.title.clone();
                let mut woken = Vec::new();
                for member in &mut state.members {
                    if !member_matches_post(member, &post) {
                        continue;
                    }
                    if member.state == "working" {
                        member.pending_wake = true;
                    } else if matches!(member.state.as_str(), "waiting" | "stopped") {
                        let unread: Vec<SwarmBoardPost> = state
                            .posts
                            .iter()
                            .filter(|p| p.seq > member.last_read_seq)
                            .cloned()
                            .collect();
                        let wake_posts = if unread.is_empty() {
                            vec![post.clone()]
                        } else {
                            unread
                        };
                        member.last_read_seq = seq;
                        member.pending_wake = false;
                        member.state = "working".to_string();
                        if let Some(ref cid) = member.child_thread_id {
                            let wake_prompt = build_worker_wakeup_prompt(&swarm_title, member, &wake_posts);
                            pending_launches.push((member.name.clone(), cid.clone(), wake_prompt));
                            woken.push(format!("@{}", member.name));
                        }
                    }
                }
                if coordinator_matches_post(&post) {
                    maybe_wake_coord = true;
                }
                save_and_broadcast_swarm(&coord_tid, &path, &state);
                Ok(format!(
                    "posted #{seq} [#{target_channel}] woke=[{}]",
                    woken.join(",")
                ))
            }
            SwarmCommand::Read { since, channel } => {
                let ch_filter = channel
                    .as_deref()
                    .map(|c| c.trim().trim_start_matches('#').to_ascii_lowercase())
                    .filter(|c| !c.is_empty() && c != "*");
                let matching: Vec<&SwarmBoardPost> = state
                    .posts
                    .iter()
                    .filter(|p| {
                        p.seq > *since
                            && ch_filter
                                .as_ref()
                                .is_none_or(|ch| p.channel.eq_ignore_ascii_case(ch))
                    })
                    .collect();
                let formatted = format_posts(&matching);
                let max_matched = matching.iter().map(|p| p.seq).max();
                if ch_filter.is_none() {
                    if caller_name == "coordinator" {
                        if let Some(head) = max_matched.filter(|&h| h > state.last_coordinator_wake_seq) {
                            state.last_coordinator_wake_seq = head;
                            save_and_broadcast_swarm(&coord_tid, &path, &state);
                        }
                    } else if let Some(head) =
                        max_matched.or_else(|| state.posts.iter().map(|p| p.seq).max())
                    {
                        if let Some(member) = state
                            .members
                            .iter_mut()
                            .find(|m| m.name.eq_ignore_ascii_case(&caller_name))
                        {
                            if head > member.last_read_seq {
                                member.last_read_seq = head;
                                save_and_broadcast_swarm(&coord_tid, &path, &state);
                            }
                        }
                    }
                }
                Ok(formatted)
            }
            SwarmCommand::Status => Ok(format_status(&state)),
            SwarmCommand::Kill { name } => {
                if name.eq_ignore_ascii_case("coordinator") || name.eq_ignore_ascii_case("all") {
                    return Err(DispatchError::BadArgs);
                }
                let idx = state
                    .members
                    .iter()
                    .position(|m| m.name.eq_ignore_ascii_case(name))
                    .ok_or(DispatchError::UnknownAddress)?;
                let child_tid = state.members[idx].child_thread_id.clone();
                state.members[idx].state = "killed".to_string();
                state.members[idx].pending_wake = false;
                save_and_broadcast_swarm(&coord_tid, &path, &state);

                if let Some(cid) = child_tid {
                    crate::chat::kill_registry::mark_thread_killed(&cid);
                    pending_kills.push(cid);
                }
                Ok(format!("killed @{name}"))
            }
            SwarmCommand::Channel {
                action,
                channel,
                topic,
                member,
            } => match action {
                SwarmChannelAction::List => {
                    let list = state
                        .channels
                        .iter()
                        .map(|c| {
                            format!(
                                "#{} archived={} topic={}",
                                c.name,
                                c.archived,
                                c.topic.as_deref().unwrap_or("-")
                            )
                        })
                        .collect::<Vec<_>>()
                        .join("\n");
                    Ok(list)
                }
                SwarmChannelAction::Create => {
                    let ch = channel
                        .as_deref()
                        .map(|c| c.trim().trim_start_matches('#').to_ascii_lowercase())
                        .filter(|c| !c.is_empty())
                        .ok_or(DispatchError::BadArgs)?;
                    if let Some(existing) = state.channels.iter_mut().find(|c| c.name == ch) {
                        existing.archived = false;
                        if topic.is_some() {
                            existing.topic = topic.clone();
                        }
                    } else {
                        state.channels.push(SwarmChannel {
                            name: ch.clone(),
                            topic: topic.clone(),
                            archived: false,
                        });
                    }
                    save_and_broadcast_swarm(&coord_tid, &path, &state);
                    Ok(format!("channel #{ch} ready"))
                }
                SwarmChannelAction::Subscribe => {
                    let ch = channel
                        .as_deref()
                        .map(|c| c.trim().trim_start_matches('#').to_ascii_lowercase())
                        .filter(|c| !c.is_empty())
                        .ok_or(DispatchError::BadArgs)?;
                    ensure_channel(&mut state, &ch)?;
                    let target_member = member
                        .clone()
                        .or_else(|| {
                            if caller_name != "coordinator" {
                                Some(caller_name.clone())
                            } else {
                                None
                            }
                        })
                        .ok_or(DispatchError::BadArgs)?;
                    let m = state
                        .members
                        .iter_mut()
                        .find(|m| m.name.eq_ignore_ascii_case(&target_member))
                        .ok_or(DispatchError::UnknownAddress)?;
                    if !m.channels.iter().any(|c| c.eq_ignore_ascii_case(&ch)) {
                        m.channels.push(ch.clone());
                    }
                    save_and_broadcast_swarm(&coord_tid, &path, &state);
                    Ok(format!("@{target_member} subscribed to #{ch}"))
                }
                SwarmChannelAction::Unsubscribe => {
                    let ch = channel
                        .as_deref()
                        .map(|c| c.trim().trim_start_matches('#').to_ascii_lowercase())
                        .filter(|c| !c.is_empty())
                        .ok_or(DispatchError::BadArgs)?;
                    let target_member = member
                        .clone()
                        .or_else(|| {
                            if caller_name != "coordinator" {
                                Some(caller_name.clone())
                            } else {
                                None
                            }
                        })
                        .ok_or(DispatchError::BadArgs)?;
                    let m = state
                        .members
                        .iter_mut()
                        .find(|m| m.name.eq_ignore_ascii_case(&target_member))
                        .ok_or(DispatchError::UnknownAddress)?;
                    m.channels.retain(|c| !c.eq_ignore_ascii_case(&ch));
                    save_and_broadcast_swarm(&coord_tid, &path, &state);
                    Ok(format!("@{target_member} unsubscribed from #{ch}"))
                }
                SwarmChannelAction::Archive => {
                    let ch = channel
                        .as_deref()
                        .map(|c| c.trim().trim_start_matches('#').to_ascii_lowercase())
                        .filter(|c| !c.is_empty() && c != "main")
                        .ok_or(DispatchError::BadArgs)?;
                    let c = state
                        .channels
                        .iter_mut()
                        .find(|c| c.name == ch)
                        .ok_or(DispatchError::UnknownAddress)?;
                    c.archived = true;
                    save_and_broadcast_swarm(&coord_tid, &path, &state);
                    Ok(format!("channel #{ch} archived"))
                }
            },
            SwarmCommand::Wait { .. } | SwarmCommand::Add { .. } | SwarmCommand::Model { .. } => {
                unreachable!()
            }
        }
    }?;

    // Cancel killed worker turns and launch woken/added worker turns outside all locks
    // so finish_run / start_turn / tests cannot deadlock on swarm_state_lock.
    for cid in pending_kills {
        crate::chat::cancel_turn(&cid);
        crate::chat::subagents::sync_child_thread_to_parent(&cid);
        try_remove_clean_worktree(&cid);
    }

    launch_pending_turns(&coord_tid, cwd, launcher, pending_launches);

    if maybe_wake_coord {
        maybe_wake_idle_coordinator(&coord_tid, cwd, launcher);
    }

    Ok(result_text)
}

