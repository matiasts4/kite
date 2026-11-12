use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::sync::Notify;

use crate::acp::extract_mentions;
use crate::chat::models::{default_mode, provider_ok};
use crate::chat::subagents::{
    emit_swarm_event, provision_subagent_worktree, register_swarm_worker_subagent_run,
    remembered_provider_defaults, resolve_git_repo_root, set_thread_effort_option,
    SwarmBoardPost, SwarmChannel, SwarmMember, SwarmState,
};
use crate::chat::threads::blank_thread;
use crate::chat::threads::touch;
use crate::chat::utils::now_ms;
use crate::dispatch::cli::{SwarmChannelAction, SwarmCommand};
use crate::dispatch::types::DispatchError;
use crate::persist::{persist, roaming_app_dir, threads, workspace_path};

pub type SwarmTurnLauncher<'a> = &'a dyn Fn(&str, &str) -> Result<(), String>;

struct WaitChannel {
    condvar: (Mutex<u64>, Condvar),
    notify: Notify,
}

impl WaitChannel {
    fn new() -> Self {
        Self {
            condvar: (Mutex::new(0), Condvar::new()),
            notify: Notify::new(),
        }
    }
}

fn swarm_state_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn wait_hub() -> &'static Mutex<HashMap<String, Arc<WaitChannel>>> {
    static HUB: OnceLock<Mutex<HashMap<String, Arc<WaitChannel>>>> = OnceLock::new();
    HUB.get_or_init(|| Mutex::new(HashMap::new()))
}

fn wait_channel_for(coord_thread_id: &str) -> Arc<WaitChannel> {
    let mut map = wait_hub().lock().unwrap_or_else(|e| e.into_inner());
    map.entry(coord_thread_id.to_string())
        .or_insert_with(|| Arc::new(WaitChannel::new()))
        .clone()
}

fn notify_swarm_waiters(coord_thread_id: &str) {
    let channel = wait_channel_for(coord_thread_id);
    if let Ok(mut gen_guard) = channel.condvar.0.lock() {
        *gen_guard = gen_guard.wrapping_add(1);
        channel.condvar.1.notify_all();
    }
    channel.notify.notify_waiters();
}

fn valid_worker_name(name: &str) -> bool {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.len() > 48 {
        return false;
    }
    if matches!(trimmed, "coordinator" | "all" | "human" | "user") {
        return false;
    }
    let mut chars = trimmed.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    first.is_ascii_lowercase()
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

fn resolve_base_dir(coord_thread_id: &str, cwd: Option<&str>) -> Option<PathBuf> {
    let from_thread = threads().lock().ok().and_then(|all| {
        let t = all
            .iter()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(coord_thread_id))?;
        t.get("worktreePath")
            .or_else(|| t.get("workingDirectory"))
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .or_else(|| {
                t.get("workspaceId")
                    .and_then(Value::as_str)
                    .and_then(workspace_path)
                    .map(PathBuf::from)
            })
    });
    from_thread
        .or_else(|| {
            cwd.map(str::trim)
                .filter(|s| !s.is_empty())
                .map(PathBuf::from)
        })
        .filter(|p| !p.as_os_str().is_empty())
}

fn swarm_json_path(coord_thread_id: &str, swarm_id: &str, cwd: Option<&str>) -> PathBuf {
    let base = resolve_base_dir(coord_thread_id, cwd).unwrap_or_else(roaming_app_dir);
    base.join(".kite")
        .join("chat")
        .join("swarms")
        .join(format!("{swarm_id}.json"))
}

fn resolve_caller_scope(from_address: &str) -> Result<(String, String), DispatchError> {
    let raw = from_address
        .trim()
        .strip_prefix("thread:")
        .unwrap_or(from_address.trim())
        .to_string();
    if raw.is_empty() {
        return Err(DispatchError::BadArgs);
    }
    if let Ok(all) = threads().lock() {
        if let Some(caller_thread) = all
            .iter()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(raw.as_str()))
        {
            if let (Some(parent), Some(member_name)) = (
                caller_thread
                    .get("swarmParentThreadId")
                    .and_then(Value::as_str),
                caller_thread
                    .get("swarmMemberName")
                    .and_then(Value::as_str),
            ) {
                return Ok((parent.to_string(), member_name.to_string()));
            }
        }
    }
    Ok((raw, "coordinator".to_string()))
}

fn load_swarm_state(coord_thread_id: &str, cwd: Option<&str>) -> (SwarmState, PathBuf) {
    let (from_thread, coord_model) = threads()
        .lock()
        .ok()
        .map(|all| {
            if let Some(t) = all
                .iter()
                .find(|t| t.get("id").and_then(Value::as_str) == Some(coord_thread_id))
            {
                let model = t
                    .get("model")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let state = t
                    .get("swarmState")
                    .and_then(|v| serde_json::from_value::<SwarmState>(v.clone()).ok());
                (state, model)
            } else {
                (None, None)
            }
        })
        .unwrap_or((None, None));

    let default_id = format!("swarm_{coord_thread_id}");
    if let Some(mut state) = from_thread {
        if state.coordinator_model.is_none() {
            state.coordinator_model = coord_model;
        }
        let path = swarm_json_path(coord_thread_id, &state.swarm_id, cwd);
        return (state, path);
    }

    let path = swarm_json_path(coord_thread_id, &default_id, cwd);
    if let Ok(raw) = fs::read_to_string(&path) {
        if let Ok(mut state) = serde_json::from_str::<SwarmState>(&raw) {
            if state.coordinator_model.is_none() {
                state.coordinator_model = coord_model;
            }
            return (state, path);
        }
    }

    (SwarmState::empty_for(coord_thread_id, coord_model), path)
}

fn save_and_broadcast_swarm(coord_thread_id: &str, path: &Path, state: &SwarmState) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(pretty) = serde_json::to_string_pretty(state) {
        let _ = fs::write(path, pretty);
    }
    if let Ok(mut all) = threads().lock() {
        if let Some(coord) = all
            .iter_mut()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(coord_thread_id))
        {
            coord["swarmId"] = json!(state.swarm_id);
            coord["swarmState"] = serde_json::to_value(state).unwrap_or(Value::Null);
            touch(coord);
        }
    }
    persist();
    emit_swarm_event(coord_thread_id, state);
    notify_swarm_waiters(coord_thread_id);
}

fn next_seq(state: &SwarmState) -> u64 {
    state.posts.iter().map(|p| p.seq).max().unwrap_or(0) + 1
}

fn ensure_channel(state: &mut SwarmState, channel_name: &str) -> Result<(), DispatchError> {
    let ch = channel_name.trim().trim_start_matches('#').to_ascii_lowercase();
    if ch.is_empty() {
        return Err(DispatchError::BadArgs);
    }
    if let Some(existing) = state.channels.iter().find(|c| c.name == ch) {
        if existing.archived {
            return Err(DispatchError::DestinationGone);
        }
        return Ok(());
    }
    state.channels.push(SwarmChannel {
        name: ch,
        topic: None,
        archived: false,
    });
    Ok(())
}

fn member_matches_post(member: &SwarmMember, post: &SwarmBoardPost) -> bool {
    if member.state == "killed" || member.name.eq_ignore_ascii_case(&post.author) {
        return false;
    }
    let member_lower = member.name.to_ascii_lowercase();
    for raw_mention in &post.mentions {
        let m = raw_mention.trim().to_ascii_lowercase();
        let Some(target) = m.strip_prefix('@') else {
            continue;
        };
        if target == "all" {
            return true;
        }
        if let Some(ch) = target.strip_prefix('#') {
            if member
                .channels
                .iter()
                .any(|sub| sub.eq_ignore_ascii_case(ch))
            {
                return true;
            }
            continue;
        }
        if target == member_lower || member_lower.starts_with(&format!("{target}-")) {
            return true;
        }
    }
    false
}

fn coordinator_matches_post(post: &SwarmBoardPost) -> bool {
    if post.author.eq_ignore_ascii_case("coordinator") {
        return false;
    }
    let text_lower = post.text.to_ascii_lowercase();
    if text_lower.contains("[stall]") || text_lower.contains("[done]") {
        return true;
    }
    post.mentions
        .iter()
        .any(|m| m.eq_ignore_ascii_case("@coordinator") || m.eq_ignore_ascii_case("@all"))
}

fn format_posts(posts: &[&SwarmBoardPost]) -> String {
    if posts.is_empty() {
        return "(no matching swarm board posts)".to_string();
    }
    posts
        .iter()
        .map(|p| format!("#{} [#{}] @{}: {}", p.seq, p.channel, p.author, p.text))
        .collect::<Vec<_>>()
        .join("\n")
}

fn format_status(state: &SwarmState) -> String {
    let head = state.posts.iter().map(|p| p.seq).max().unwrap_or(0);
    let mut lines = vec![format!(
        "Swarm \"{}\" ({}) | head: #{} | members: {}",
        state.title,
        state.swarm_id,
        head,
        state.members.len()
    )];
    for m in &state.members {
        lines.push(format!(
            "  @{:<16} state={:<8} provider={} model={} workspace={} channels=[{}] lastReadSeq={}",
            m.name,
            m.state,
            m.provider.as_deref().unwrap_or("inherit"),
            m.model.as_deref().unwrap_or("default"),
            m.workspace_mode.as_deref().unwrap_or("inherit"),
            m.channels.join(","),
            m.last_read_seq,
        ));
    }
    lines.join("\n")
}

fn build_worker_initial_prompt(
    state: &SwarmState,
    member: &SwarmMember,
    brief_post: &SwarmBoardPost,
) -> String {
    format!(
        "[Swarm Assignment — \"{}\"]\n\
        Roster Handle: @{}\n\
        Subscribed Channels: {}\n\
        Coordination Protocol: You belong to Swarm `{}`. Post progress, questions, blockers (`[stall]`), or completion (`[done]`) back to the board using `kite dispatch swarm post \"@coordinator ...\"` and read updates via `kite dispatch swarm read --since {}`.\n\n\
        Assignment Post #{} [#{}]:\n{}",
        state.title,
        member.name,
        member.channels.join(", "),
        state.swarm_id,
        brief_post.seq,
        brief_post.seq,
        brief_post.channel,
        member.brief.as_deref().unwrap_or(&brief_post.text),
    )
}

fn build_worker_wakeup_prompt(title: &str, member: &SwarmMember, posts: &[SwarmBoardPost]) -> String {
    let refs: Vec<&SwarmBoardPost> = posts.iter().collect();
    let formatted = format_posts(&refs);
    let max_seq = posts.iter().map(|p| p.seq).max().unwrap_or(member.last_read_seq);
    format!(
        "[Swarm @mention Wakeup — \"{}\" | head #{}]\n\
        You are @{}. New board messages woke you up. Reply on the board via `kite dispatch swarm post \"@coordinator ...\"` when finished or blocked.\n\n\
        Unread Board Posts:\n{}",
        title, max_seq, member.name, formatted
    )
}

pub fn default_turn_launcher(child_thread_id: &str, prompt: &str) -> Result<(), String> {
    crate::dispatch_wire::protocol::clear_thread_killed(child_thread_id);
    let profile_id = threads().lock().ok().and_then(|list| {
        list.iter()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(child_thread_id))
            .and_then(|t| t.get("profileId").and_then(Value::as_str))
            .map(str::to_string)
    });
    let value = crate::chat::start_turn(child_thread_id, profile_id.as_deref(), prompt, Vec::new(), None);
    if let Some(err) = value.get("error").and_then(Value::as_str) {
        Err(err.to_string())
    } else {
        Ok(())
    }
}

fn invoke_launcher(
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
fn spawn_swarm_member_thread(
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

    let provider = provider_override
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_ascii_lowercase)
        .or_else(|| coord_provider.clone())
        .unwrap_or_else(|| "antigravity".to_string());
    if !provider_ok(&provider) {
        return Err(DispatchError::BadArgs);
    }

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

fn try_remove_clean_worktree(child_thread_id: &str) {
    let wt_info = threads().lock().ok().and_then(|all| {
        let child = all
            .iter()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(child_thread_id))?;
        let wt = child.get("worktreePath").and_then(Value::as_str)?.to_string();
        let ws_mode = child
            .get("workspaceMode")
            .and_then(Value::as_str)
            .unwrap_or("inherit")
            .to_string();
        Some((wt, ws_mode))
    });
    let Some((wt_str, ws_mode)) = wt_info else {
        return;
    };
    if !matches!(ws_mode.as_str(), "share" | "branch") {
        return;
    }
    let wt_path = PathBuf::from(&wt_str);
    if !wt_path.exists() {
        return;
    }
    // Check clean working tree before removing so dirty edits are never discarded.
    let Ok(status_out) = crate::git::run_git(&wt_path, &["status", "--porcelain"]) else {
        return;
    };
    if !status_out.status.success() || !String::from_utf8_lossy(&status_out.stdout).trim().is_empty()
    {
        return;
    }
    let Some(parent_repo) = wt_path
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.parent())
    else {
        return;
    };
    let _ = crate::git::run_git(parent_repo, &["worktree", "remove", &wt_str]);
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

    let mut pending_launches: Vec<(String, String, String)> = Vec::new();
    let mut pending_kills: Vec<String> = Vec::new();
    let result_text = {
        let _guard = swarm_state_lock().lock().unwrap_or_else(|e| e.into_inner());
        let (mut state, path) = load_swarm_state(&coord_tid, cwd);

        match command {
            SwarmCommand::Title { title } => {
                state.title = title.trim().to_string();
                save_and_broadcast_swarm(&coord_tid, &path, &state);
                Ok(format!("Swarm title set to \"{}\" ({})", state.title, state.swarm_id))
            }
            SwarmCommand::Add {
                name,
                provider,
                model,
                effort,
                workspace,
                channels,
                fork,
                role,
                brief,
            } => {
                if !valid_worker_name(name) {
                    return Err(DispatchError::BadArgs);
                }
                if state
                    .members
                    .iter()
                    .any(|m| m.name.eq_ignore_ascii_case(name))
                {
                    return Err(DispatchError::NameTaken);
                }
                let mut member_channels: Vec<String> = Vec::new();
                for ch in channels {
                    let norm = ch.trim().trim_start_matches('#').to_ascii_lowercase();
                    if !norm.is_empty() && !member_channels.contains(&norm) {
                        ensure_channel(&mut state, &norm)?;
                        member_channels.push(norm);
                    }
                }
                if !member_channels.iter().any(|c| c == "main") {
                    ensure_channel(&mut state, "main")?;
                    member_channels.push("main".to_string());
                }
                let primary_channel = member_channels[0].clone();

                let fork_source_thread_id = match fork.as_deref() {
                    Some(src) if src.eq_ignore_ascii_case("coordinator") => Some(coord_tid.clone()),
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

                let ws_mode = workspace.as_deref().unwrap_or("inherit");
                let (child_id, resolved_provider, resolved_model, _) = spawn_swarm_member_thread(
                    &coord_tid,
                    &state.swarm_id,
                    name,
                    provider.as_deref(),
                    model.as_deref(),
                    effort.as_deref(),
                    ws_mode,
                    role.as_deref(),
                    fork.as_deref(),
                    fork_source_thread_id.as_deref(),
                    cwd,
                )?;

                let seq = next_seq(&state);
                let post_text = format!("@{name} {brief}");
                let post = SwarmBoardPost {
                    seq,
                    author: caller_name.clone(),
                    channel: primary_channel.clone(),
                    text: post_text.clone(),
                    mentions: extract_mentions(&post_text),
                    created_at_unix_ms: now_ms(),
                };
                state.posts.push(post.clone());

                let member_role = role
                    .clone()
                    .unwrap_or_else(|| format!("{resolved_provider} worker"));
                let member = SwarmMember {
                    name: name.clone(),
                    role: member_role.clone(),
                    provider: Some(resolved_provider.clone()),
                    model: resolved_model.clone(),
                    effort: effort.clone(),
                    workspace_mode: Some(ws_mode.to_string()),
                    state: "working".to_string(),
                    current_activity: None,
                    channels: member_channels,
                    subagent_id: Some(child_id.clone()),
                    child_thread_id: Some(child_id.clone()),
                    brief: Some(brief.clone()),
                    last_read_seq: seq,
                    pending_wake: false,
                };
                let prompt = build_worker_initial_prompt(&state, &member, &post);
                state.members.push(member);
                register_swarm_worker_subagent_run(
                    &coord_tid,
                    &child_id,
                    name,
                    &member_role,
                    &resolved_provider,
                    resolved_model.as_deref(),
                    Some(ws_mode),
                    brief,
                );
                save_and_broadcast_swarm(&coord_tid, &path, &state);
                pending_launches.push((name.clone(), child_id.clone(), prompt));

                Ok(format!(
                    "added @{name} (thread:{child_id}, provider={resolved_provider}, model={}, seq=#{seq})",
                    resolved_model.as_deref().unwrap_or("default"),
                ))
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
                if caller_name != "coordinator" && ch_filter.is_none() {
                    if let Some(head) = matching
                        .iter()
                        .map(|p| p.seq)
                        .max()
                        .or_else(|| state.posts.iter().map(|p| p.seq).max())
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
                Ok(format_posts(&matching))
            }
            SwarmCommand::Status => Ok(format_status(&state)),
            SwarmCommand::Model {
                name,
                provider,
                model,
                effort,
            } => {
                if name.eq_ignore_ascii_case("coordinator") {
                    let prev_provider = threads().lock().ok().and_then(|all| {
                        all.iter()
                            .find(|t| t.get("id").and_then(Value::as_str) == Some(coord_tid.as_str()))
                            .and_then(|t| t.get("provider").and_then(Value::as_str))
                            .map(str::to_string)
                    });
                    if let Some(ref p) = provider {
                        if !provider_ok(p) {
                            return Err(DispatchError::BadArgs);
                        }
                    }
                    state.coordinator_model = Some(model.clone());
                    if let Ok(mut all) = threads().lock() {
                        if let Some(coord) = all.iter_mut().find(|t| {
                            t.get("id").and_then(Value::as_str) == Some(coord_tid.as_str())
                        }) {
                            if let Some(ref p) = provider {
                                if prev_provider.as_deref() != Some(p.as_str()) {
                                    coord["providerSessionId"] = Value::Null;
                                }
                                coord["provider"] = json!(p);
                            }
                            coord["model"] = json!(model);
                            if let Some(ref eff) = effort {
                                set_thread_effort_option(coord, eff);
                            }
                            touch(coord);
                        }
                    }
                    save_and_broadcast_swarm(&coord_tid, &path, &state);
                    return Ok(format!("switched coordinator -> model={model}"));
                }

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
                if let Some(ref p) = provider {
                    if !provider_ok(p) {
                        return Err(DispatchError::BadArgs);
                    }
                }
                let prev_provider = state.members[idx].provider.clone();
                let prev_state = state.members[idx].state.clone();
                if let Some(ref p) = provider {
                    state.members[idx].provider = Some(p.clone());
                }
                state.members[idx].model = Some(model.clone());
                if effort.is_some() {
                    state.members[idx].effort = effort.clone();
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
                            if let Some(ref eff) = effort {
                                set_thread_effort_option(child, eff);
                            }
                            touch(child);
                        }
                    }
                    crate::chat::subagents::sync_child_thread_to_parent(cid);
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
                save_and_broadcast_swarm(&coord_tid, &path, &state);
                Ok(format!(
                    "switched @{name} -> provider={} model={model}{}",
                    new_provider.as_deref().unwrap_or("inherit"),
                    if prev_state == "stopped" { " (resumed)" } else { "" }
                ))
            }
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
                    crate::dispatch_wire::protocol::mark_thread_killed(&cid);
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
            SwarmCommand::Wait { .. } => unreachable!(),
        }
    }?;

    // Cancel killed worker turns and launch woken/added worker turns outside all locks
    // so finish_run / start_turn / tests cannot deadlock on swarm_state_lock.
    for cid in pending_kills {
        crate::chat::cancel_turn(&cid);
        crate::chat::subagents::sync_child_thread_to_parent(&cid);
        try_remove_clean_worktree(&cid);
    }

    for (member_name, child_id, prompt) in pending_launches {
        if let Err(err) = invoke_launcher(launcher, &child_id, &prompt) {
            let _guard = swarm_state_lock().lock().unwrap_or_else(|e| e.into_inner());
            let (mut state, path) = load_swarm_state(&coord_tid, cwd);
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

    Ok(result_text)
}

fn collect_wait_matches(state: &SwarmState, caller_name: &str, since: u64, mentions_only: bool) -> Option<String> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct CleanupSwarmThread(String, PathBuf);
    impl Drop for CleanupSwarmThread {
        fn drop(&mut self) {
            if let Ok(mut list) = threads().lock() {
                list.retain(|t| {
                    let id = t.get("id").and_then(Value::as_str).unwrap_or("");
                    let pid = t.get("parentThreadId").and_then(Value::as_str).unwrap_or("");
                    id != self.0 && pid != self.0
                });
            }
            let _ = fs::remove_dir_all(&self.1);
        }
    }

    fn init_git_repo(dir: &Path) {
        fs::create_dir_all(dir).unwrap();
        assert!(crate::git::run_git(dir, &["init"]).unwrap().status.success());
        assert!(crate::git::run_git(dir, &["config", "user.email", "test@kite.local"])
            .unwrap()
            .status
            .success());
        assert!(crate::git::run_git(dir, &["config", "user.name", "Kite Test"])
            .unwrap()
            .status
            .success());
        fs::write(dir.join("README.md"), "swarm seed\n").unwrap();
        assert!(crate::git::run_git(dir, &["add", "README.md"])
            .unwrap()
            .status
            .success());
        assert!(crate::git::run_git(dir, &["commit", "-m", "init"])
            .unwrap()
            .status
            .success());
    }

    #[test]
    fn swarm_title_add_mention_wakeup_channel_model_failover_and_kill() {
        let coord_id = format!("swarm-coord-{}", uuid::Uuid::new_v4().simple());
        let repo_dir = std::env::temp_dir().join(format!("kite-swarm-repo-{}", uuid::Uuid::new_v4().simple()));
        init_git_repo(&repo_dir);
        let _guard = CleanupSwarmThread(coord_id.clone(), repo_dir.clone());

        let mut coord = blank_thread(&coord_id, None, "Main Coordinator", "antigravity", None);
        coord["model"] = json!("claude-opus-4-6");
        coord["workingDirectory"] = json!(repo_dir.to_string_lossy().to_string());
        coord["items"] = json!([{ "id": "u0", "kind": "user", "text": "Coordinate swarm" }]);
        threads().lock().unwrap().push(coord);

        let launched: Arc<Mutex<Vec<(String, String)>>> = Arc::new(Mutex::new(Vec::new()));
        let launched_clone = launched.clone();
        let launcher_fn = move |cid: &str, prompt: &str| -> Result<(), String> {
            launched_clone
                .lock()
                .unwrap()
                .push((cid.to_string(), prompt.to_string()));
            Ok(())
        };

        let coord_addr = format!("thread:{coord_id}");
        let cwd_str = repo_dir.to_string_lossy().to_string();

        execute_swarm_action(
            &SwarmCommand::Title {
                title: "Cross-Provider Refactor".into(),
            },
            &coord_addr,
            Some(&cwd_str),
            Some(&launcher_fn),
        )
        .unwrap();

        // Reject reserved name
        assert!(execute_swarm_action(
            &SwarmCommand::Add {
                name: "coordinator".into(),
                provider: Some("grok".into()),
                model: Some("grok-3-mini".into()),
                effort: None,
                workspace: None,
                channels: Vec::new(),
                fork: None,
                role: None,
                brief: "invalid".into(),
            },
            &coord_addr,
            Some(&cwd_str),
            Some(&launcher_fn),
        )
        .is_err());

        // Add grok worker with share worktree, forked context, and channel #parser
        let add_res = execute_swarm_action(
            &SwarmCommand::Add {
                name: "verifier".into(),
                provider: Some("grok".into()),
                model: Some("grok-3-mini".into()),
                effort: Some("low".into()),
                workspace: Some("share".into()),
                channels: vec!["parser".into()],
                fork: Some("coordinator".into()),
                role: Some("Parser Verifier".into()),
                brief: "Audit token edge cases".into(),
            },
            &coord_addr,
            Some(&cwd_str),
            Some(&launcher_fn),
        )
        .unwrap();
        assert!(add_res.contains("added @verifier"), "add_res={add_res}");

        // Add second worker subscribed only to #ui
        execute_swarm_action(
            &SwarmCommand::Add {
                name: "ui-dev".into(),
                provider: Some("gemini".into()),
                model: Some("gemini-2.5-flash".into()),
                effort: None,
                workspace: Some("inherit".into()),
                channels: vec!["ui".into()],
                fork: None,
                role: Some("UI Worker".into()),
                brief: "Polish badge".into(),
            },
            &coord_addr,
            Some(&cwd_str),
            Some(&launcher_fn),
        )
        .unwrap();

        let (state, swarm_path) = load_swarm_state(&coord_id, Some(&cwd_str));
        assert!(swarm_path.exists());
        assert_eq!(state.members.len(), 2);
        let verifier_cid = state.members[0].child_thread_id.clone().unwrap();
        let ui_cid = state.members[1].child_thread_id.clone().unwrap();
        let verifier_addr = format!("thread:{verifier_cid}");

        // Verify forked items & worktree on verifier child thread
        let verifier_wt = {
            let all = threads().lock().unwrap();
            let v = all.iter().find(|t| t["id"] == verifier_cid).unwrap();
            assert_eq!(v["items"].as_array().unwrap().len(), 1);
            v["worktreePath"].as_str().unwrap().to_string()
        };
        assert!(PathBuf::from(&verifier_wt).join("README.md").exists());

        // Settle both workers so they transition working -> waiting (zero idle tokens)
        on_worker_turn_settled_with_launcher(&verifier_cid, true, Some(&launcher_fn));
        on_worker_turn_settled_with_launcher(&ui_cid, true, Some(&launcher_fn));

        let status_waiting = execute_swarm_action(
            &SwarmCommand::Status,
            &coord_addr,
            Some(&cwd_str),
            Some(&launcher_fn),
        )
        .unwrap();
        assert!(status_waiting.contains("state=waiting"));

        // Channel mention @#parser wakes ONLY verifier, leaving ui-dev waiting!
        let launches_before = launched.lock().unwrap().len();
        execute_swarm_action(
            &SwarmCommand::Post {
                channel: Some("parser".into()),
                text: "@#parser check #1 again".into(),
            },
            &coord_addr,
            Some(&cwd_str),
            Some(&launcher_fn),
        )
        .unwrap();
        {
            let launches = launched.lock().unwrap();
            assert_eq!(launches.len(), launches_before + 1);
            assert_eq!(launches.last().unwrap().0, verifier_cid);
        }

        // While verifier is WORKING, posting another @verifier mention queues pending_wake (does not double-launch)
        execute_swarm_action(
            &SwarmCommand::Post {
                channel: None,
                text: "@verifier check #2 too".into(),
            },
            &coord_addr,
            Some(&cwd_str),
            Some(&launcher_fn),
        )
        .unwrap();
        assert_eq!(launched.lock().unwrap().len(), launches_before + 1);

        // Settling verifier drains pending_wake and immediately launches follow-up turn!
        on_worker_turn_settled_with_launcher(&verifier_cid, true, Some(&launcher_fn));
        assert_eq!(launched.lock().unwrap().len(), launches_before + 2);

        // Now verifier reads before settling, then settles -> waiting cleanly!
        let read_out = execute_swarm_action(
            &SwarmCommand::Read {
                since: 1,
                channel: None,
            },
            &verifier_addr,
            Some(&cwd_str),
            Some(&launcher_fn),
        )
        .unwrap();
        assert!(read_out.contains("check #2 too"));
        on_worker_turn_settled_with_launcher(&verifier_cid, true, Some(&launcher_fn));

        // Hot-swap verifier model across providers while keeping history intact
        {
            let mut all = threads().lock().unwrap();
            let v = all.iter_mut().find(|t| t["id"] == verifier_cid).unwrap();
            v["providerSessionId"] = json!("stale-grok-session");
            v["items"] = json!([
                { "id": "u0", "kind": "user", "text": "Coordinate swarm" },
                { "id": "a1", "kind": "assistant", "text": "Checked parser" }
            ]);
        }
        execute_swarm_action(
            &SwarmCommand::Model {
                name: "verifier".into(),
                provider: Some("codex".into()),
                model: "o4-mini".into(),
                effort: Some("high".into()),
            },
            &coord_addr,
            Some(&cwd_str),
            Some(&launcher_fn),
        )
        .unwrap();
        {
            let all = threads().lock().unwrap();
            let v = all.iter().find(|t| t["id"] == verifier_cid).unwrap();
            assert_eq!(v["provider"], "codex");
            assert_eq!(v["model"], "o4-mini");
            assert!(v["providerSessionId"].is_null());
            assert_eq!(v["items"].as_array().unwrap().len(), 2);
        }

        // Kill verifier -> cleans clean worktree, marks killed permanently, refuses reuse
        execute_swarm_action(
            &SwarmCommand::Kill {
                name: "verifier".into(),
            },
            &coord_addr,
            Some(&cwd_str),
            Some(&launcher_fn),
        )
        .unwrap();
        assert!(!PathBuf::from(&verifier_wt).exists());
        assert!(execute_swarm_action(
            &SwarmCommand::Add {
                name: "verifier".into(),
                provider: Some("grok".into()),
                model: None,
                effort: None,
                workspace: None,
                channels: Vec::new(),
                fork: None,
                role: None,
                brief: "reuse".into(),
            },
            &coord_addr,
            Some(&cwd_str),
            Some(&launcher_fn),
        )
        .is_err());
    }

    #[tokio::test]
    async fn swarm_wait_wakes_immediately_on_post_without_polling() {
        let coord_id = format!("swarm-wait-{}", uuid::Uuid::new_v4().simple());
        let scratch = std::env::temp_dir().join(format!("kite-swarm-wait-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&scratch).unwrap();
        let _guard = CleanupSwarmThread(coord_id.clone(), scratch.clone());

        let mut coord = blank_thread(&coord_id, None, "Wait Coordinator", "antigravity", None);
        coord["workingDirectory"] = json!(scratch.to_string_lossy().to_string());
        threads().lock().unwrap().push(coord);

        let coord_addr = format!("thread:{coord_id}");
        let noop_launcher = |_cid: &str, _prompt: &str| -> Result<(), String> { Ok(()) };
        execute_swarm_action(
            &SwarmCommand::Add {
                name: "verifier".into(),
                provider: Some("grok".into()),
                model: None,
                effort: None,
                workspace: Some("inherit".into()),
                channels: vec!["main".into()],
                fork: None,
                role: Some("Verifier".into()),
                brief: "Check audit".into(),
            },
            &coord_addr,
            None,
            Some(&noop_launcher),
        )
        .unwrap();

        let worker_tid = {
            let (state, _) = load_swarm_state(&coord_id, None);
            state.members[0].child_thread_id.clone().unwrap()
        };
        let worker_addr = format!("thread:{worker_tid}");

        let coord_addr_bg = coord_addr.clone();
        let wait_task = tokio::spawn(async move {
            wait_swarm_async(&coord_addr_bg, 1, true, 5_000).await
        });

        tokio::time::sleep(Duration::from_millis(60)).await;
        execute_swarm_action(
            &SwarmCommand::Post {
                channel: None,
                text: "@coordinator [done] finished audit".into(),
            },
            &worker_addr,
            None,
            None,
        )
        .unwrap();

        let output = wait_task.await.unwrap().unwrap();
        assert!(output.contains("[done] finished audit"), "output={output}");
        crate::chat::threads::remove_thread(&worker_tid);
    }

    #[test]
    fn stopped_worker_model_switch_resumes_working_and_keeps_history() {
        let coord_id = format!("swarm-failover-{}", uuid::Uuid::new_v4().simple());
        let scratch = std::env::temp_dir().join(format!(
            "kite-swarm-failover-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&scratch).unwrap();
        let _guard = CleanupSwarmThread(coord_id.clone(), scratch.clone());

        let mut coord = blank_thread(&coord_id, None, "Coordinator", "antigravity", None);
        coord["workingDirectory"] = json!(scratch.to_string_lossy().to_string());
        threads().lock().unwrap().push(coord);

        let coord_addr = format!("thread:{coord_id}");
        let cwd_str = scratch.to_string_lossy().to_string();
        let launches = Arc::new(Mutex::new(Vec::<(String, String)>::new()));
        let launches_ref = Arc::clone(&launches);
        let launcher_fn = move |cid: &str, prompt: &str| -> Result<(), String> {
            launches_ref
                .lock()
                .unwrap()
                .push((cid.to_string(), prompt.to_string()));
            Ok(())
        };

        execute_swarm_action(
            &SwarmCommand::Add {
                name: "quota-worker".into(),
                provider: Some("grok".into()),
                model: Some("grok-3-mini".into()),
                effort: None,
                workspace: Some("inherit".into()),
                channels: vec!["main".into()],
                fork: None,
                role: Some("Quota Worker".into()),
                brief: "Audit auth".into(),
            },
            &coord_addr,
            Some(&cwd_str),
            Some(&launcher_fn),
        )
        .unwrap();

        let worker_cid = {
            let (state, _) = load_swarm_state(&coord_id, None);
            state.members[0].child_thread_id.clone().unwrap()
        };
        {
            let mut all = threads().lock().unwrap();
            let w = all.iter_mut().find(|t| t["id"] == worker_cid).unwrap();
            w["items"] = json!([
                { "id": "u1", "kind": "user", "text": "Audit auth" },
                { "id": "a1", "kind": "assistant", "text": "Hit rate limit halfway" }
            ]);
        }
        // Settle with ok=false -> stopped
        on_worker_turn_settled_with_launcher(&worker_cid, false, Some(&launcher_fn));

        let res = execute_swarm_action(
            &SwarmCommand::Model {
                name: "quota-worker".into(),
                provider: Some("gemini".into()),
                model: "gemini-2.5-flash".into(),
                effort: Some("medium".into()),
            },
            &coord_addr,
            Some(&cwd_str),
            Some(&launcher_fn),
        )
        .unwrap();
        assert!(res.contains("(resumed)"), "res={res}");

        let (state, _) = load_swarm_state(&coord_id, Some(&cwd_str));
        assert_eq!(state.members[0].state, "working");
        assert_eq!(state.members[0].provider.as_deref(), Some("gemini"));
        assert_eq!(state.members[0].model.as_deref(), Some("gemini-2.5-flash"));
        assert_eq!(launches.lock().unwrap().len(), 2);
        assert!(launches.lock().unwrap()[1].1.contains("Swarm Failover Resume"));

        let all = threads().lock().unwrap();
        let w = all.iter().find(|t| t["id"] == worker_cid).unwrap();
        assert_eq!(w["items"].as_array().unwrap().len(), 2);
        drop(all);
        crate::chat::threads::remove_thread(&worker_cid);
    }

    #[test]
    fn swarm_worker_metadata_channel_priority_subagent_linkage_and_sync_wait() {
        let coord_id = format!("swarm-t3-audit-{}", uuid::Uuid::new_v4().simple());
        let scratch = std::env::temp_dir().join(format!(
            "kite-swarm-t3-audit-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&scratch).unwrap();
        let _guard = CleanupSwarmThread(coord_id.clone(), scratch.clone());

        let mut coord = blank_thread(&coord_id, None, "Main", "antigravity", Some("ws-1"));
        coord["model"] = json!("claude-opus-4-6");
        set_thread_effort_option(&mut coord, "high");
        coord["workingDirectory"] = json!(scratch.to_string_lossy().to_string());
        threads().lock().unwrap().push(coord);

        let coord_addr = format!("thread:{coord_id}");
        let cwd_str = scratch.to_string_lossy().to_string();
        let noop_launcher = |_cid: &str, _prompt: &str| -> Result<(), String> { Ok(()) };

        execute_swarm_action(
            &SwarmCommand::Add {
                name: "parser".into(),
                provider: Some("grok".into()),
                model: None,
                effort: None,
                workspace: Some("inherit".into()),
                channels: vec!["parser".into()],
                fork: None,
                role: Some("Parser Specialist".into()),
                brief: "Inspect lexer".into(),
            },
            &coord_addr,
            Some(&cwd_str),
            Some(&noop_launcher),
        )
        .unwrap();

        let (state, _) = load_swarm_state(&coord_id, Some(&cwd_str));
        assert_eq!(state.posts[0].channel, "parser");
        assert_eq!(state.members[0].channels, vec!["parser".to_string(), "main".to_string()]);
        let worker_cid = state.members[0].child_thread_id.clone().unwrap();

        {
            let all = threads().lock().unwrap();
            let child = all.iter().find(|t| t["id"] == worker_cid).unwrap();
            assert!(child["profileId"].is_null(), "profileId={:?}", child["profileId"]);
            assert_eq!(child["workspaceId"].as_str(), Some("ws-1"));
            assert_ne!(child["model"].as_str(), Some("claude-opus-4-6"));
            assert_ne!(child["effort"].as_str(), Some("high"));

            let parent = all.iter().find(|t| t["id"] == coord_id).unwrap();
            let runs = parent["subagentRuns"].as_array().unwrap();
            assert!(
                runs.iter().any(|r| {
                    r.get("childThreadId").and_then(Value::as_str) == Some(worker_cid.as_str())
                        && r.get("swarmMemberName").and_then(Value::as_str) == Some("parser")
                }),
                "runs={runs:?}"
            );
        }
        assert!(crate::chat::subagents::build_subagent_detail(&coord_id, &worker_cid).is_some());

        // Stopped worker stays stopped in build_swarm_state even if child["status"] == "idle".
        on_worker_turn_settled_with_launcher(&worker_cid, false, Some(&noop_launcher));
        let built = crate::chat::subagents::build_swarm_state(&coord_id);
        assert_eq!(built["members"][0]["state"], "stopped");

        // Filtered channel read must not advance last_read_seq past unread #main posts.
        execute_swarm_action(
            &SwarmCommand::Post {
                channel: Some("main".into()),
                text: "@all check main".into(),
            },
            &coord_addr,
            Some(&cwd_str),
            Some(&noop_launcher),
        )
        .unwrap();
        let before_read_seq = load_swarm_state(&coord_id, Some(&cwd_str)).0.members[0].last_read_seq;
        execute_swarm_action(
            &SwarmCommand::Read {
                since: 0,
                channel: Some("empty-ch".into()),
            },
            &format!("thread:{worker_cid}"),
            Some(&cwd_str),
            Some(&noop_launcher),
        )
        .unwrap();
        let after_read_seq = load_swarm_state(&coord_id, Some(&cwd_str)).0.members[0].last_read_seq;
        assert_eq!(after_read_seq, before_read_seq);

        // Concurrent blocking execute_swarm_wait wakes on worker post without AB-BA deadlock.
        let coord_id_wait = coord_id.clone();
        let handle = std::thread::spawn(move || {
            execute_swarm_wait(&coord_id_wait, "coordinator", 2, true, 5_000)
        });
        std::thread::sleep(Duration::from_millis(40));
        execute_swarm_action(
            &SwarmCommand::Post {
                channel: None,
                text: "@coordinator [done] checked".into(),
            },
            &format!("thread:{worker_cid}"),
            Some(&cwd_str),
            None,
        )
        .unwrap();
        let wait_out = handle.join().unwrap().unwrap();
        assert!(wait_out.contains("[done] checked"), "wait_out={wait_out}");

        crate::chat::threads::remove_thread(&worker_cid);
    }
}
