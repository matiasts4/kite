use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
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

pub type SwarmTurnLauncher<'a> = &'a dyn Fn(&str, &str) -> Result<(), String>;

pub(super) struct WaitChannel {
    pub(super) condvar: (Mutex<u64>, Condvar),
    pub(super) notify: Notify,
    pub(super) active_coordinator_waiters: AtomicUsize,
}

impl WaitChannel {
    fn new() -> Self {
        Self {
            condvar: (Mutex::new(0), Condvar::new()),
            notify: Notify::new(),
            active_coordinator_waiters: AtomicUsize::new(0),
        }
    }
}

pub(super) fn swarm_state_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

pub(super) fn wait_hub() -> &'static Mutex<HashMap<String, Arc<WaitChannel>>> {
    static HUB: OnceLock<Mutex<HashMap<String, Arc<WaitChannel>>>> = OnceLock::new();
    HUB.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(super) fn wait_channel_for(coord_thread_id: &str) -> Arc<WaitChannel> {
    let mut map = wait_hub().lock().unwrap_or_else(|e| e.into_inner());
    map.entry(coord_thread_id.to_string())
        .or_insert_with(|| Arc::new(WaitChannel::new()))
        .clone()
}

pub(super) fn notify_swarm_waiters(coord_thread_id: &str) {
    let channel = wait_channel_for(coord_thread_id);
    if let Ok(mut gen_guard) = channel.condvar.0.lock() {
        *gen_guard = gen_guard.wrapping_add(1);
        channel.condvar.1.notify_all();
    }
    channel.notify.notify_waiters();
}

pub(super) fn valid_worker_name(name: &str) -> bool {
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

pub(super) fn resolve_base_dir(coord_thread_id: &str, cwd: Option<&str>) -> Option<PathBuf> {
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

pub(super) fn swarm_json_path(coord_thread_id: &str, swarm_id: &str, cwd: Option<&str>) -> PathBuf {
    let base = resolve_base_dir(coord_thread_id, cwd).unwrap_or_else(roaming_app_dir);
    base.join(".kite")
        .join("chat")
        .join("swarms")
        .join(format!("{swarm_id}.json"))
}

pub(super) fn resolve_caller_scope(from_address: &str) -> Result<(String, String), DispatchError> {
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

pub(super) fn load_swarm_state(coord_thread_id: &str, cwd: Option<&str>) -> (SwarmState, PathBuf) {
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

pub(super) fn save_and_broadcast_swarm(coord_thread_id: &str, path: &Path, state: &SwarmState) {
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

pub(super) fn next_seq(state: &SwarmState) -> u64 {
    state.posts.iter().map(|p| p.seq).max().unwrap_or(0) + 1
}

pub(super) fn ensure_channel(state: &mut SwarmState, channel_name: &str) -> Result<(), DispatchError> {
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

pub(super) fn member_matches_post(member: &SwarmMember, post: &SwarmBoardPost) -> bool {
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

pub(super) fn coordinator_matches_post(post: &SwarmBoardPost) -> bool {
    if post.author.eq_ignore_ascii_case("coordinator") {
        return false;
    }
    let text_lower = post.text.to_ascii_lowercase();
    if text_lower.contains("[stall]")
        || text_lower.contains("[done]")
        || text_lower.contains("[blocked]")
    {
        return true;
    }
    post.mentions
        .iter()
        .any(|m| m.eq_ignore_ascii_case("@coordinator") || m.eq_ignore_ascii_case("@all"))
}

pub(super) fn is_coordinator_busy(coord_tid: &str) -> bool {
    let live_busy = crate::chat::runtime::live_turns()
        .lock()
        .ok()
        .is_some_and(|live| {
            live.by_thread
                .get(coord_tid)
                .and_then(|run_id| live.runs.get(run_id))
                .is_some_and(|run| !run.finished && !run.closing)
        });
    if live_busy {
        return true;
    }
    threads()
        .lock()
        .ok()
        .is_some_and(|all| {
            all.iter()
                .find(|t| t.get("id").and_then(Value::as_str) == Some(coord_tid))
                .and_then(|t| t.get("status").and_then(Value::as_str))
                == Some("running")
        })
}

pub(super) fn format_posts(posts: &[&SwarmBoardPost]) -> String {
    if posts.is_empty() {
        return "(no matching swarm board posts)".to_string();
    }
    posts
        .iter()
        .map(|p| format!("#{} [#{}] @{}: {}", p.seq, p.channel, p.author, p.text))
        .collect::<Vec<_>>()
        .join("\n")
}

pub(super) fn format_status(state: &SwarmState) -> String {
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

pub(super) fn build_worker_initial_prompt(
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

pub(super) fn build_worker_wakeup_prompt(title: &str, member: &SwarmMember, posts: &[SwarmBoardPost]) -> String {
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

pub(super) fn build_coordinator_wakeup_prompt(state: &SwarmState, posts: &[SwarmBoardPost]) -> String {
    let refs: Vec<&SwarmBoardPost> = posts.iter().collect();
    let formatted = format_posts(&refs);
    let max_seq = posts.iter().map(|p| p.seq).max().unwrap_or(state.last_coordinator_wake_seq);
    format!(
        "[Swarm Coordinator Wakeup — \"{}\" ({}) | head #{}]\n\
        Workers posted new updates requiring coordinator attention. Review them, inspect worker output or diffs if needed, respond on the board (`kite dispatch swarm post ...`) or wait for further updates (`kite dispatch swarm wait --since {} --mentions-only`).\n\n\
        Unread Board Posts:\n{}\n\n\
        Swarm Status:\n{}",
        state.title,
        state.swarm_id,
        max_seq,
        max_seq,
        formatted,
        format_status(state),
    )
}
