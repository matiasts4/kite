use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::*;
use crate::acp::{
    build_acp_tool_call, extract_mentions, merge_subagent_meta, AcpStreamEvent, SubagentMeta,
    SwarmMeta,
};
use crate::chat::models::default_mode;
use crate::chat::runtime::{live_cv, live_turns, push_event};
use crate::chat::threads::{blank_thread, chat_item, touch, upsert_item};
use crate::chat::utils::now_ms;
use crate::persist::{persist, threads, workspace_path};

pub(crate) fn resolve_git_repo_root(dir: &Path) -> Option<PathBuf> {
    let out = crate::git::run_git(dir, &["rev-parse", "--show-toplevel"]).ok()?;
    if !out.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if raw.is_empty() {
        None
    } else {
        Some(PathBuf::from(raw))
    }
}

pub fn provision_subagent_worktree(
    repo_root: &Path,
    mode: &str,
    short_id: &str,
) -> Result<PathBuf, String> {
    let worktrees_dir = repo_root.join(".kite").join("worktrees");
    fs::create_dir_all(&worktrees_dir).map_err(|err| err.to_string())?;
    let wt_path = worktrees_dir.join(format!("subagent-{short_id}"));
    let wt_str = wt_path.to_string_lossy().to_string();
    let out = match mode {
        "share" => crate::git::run_git(repo_root, &["worktree", "add", "--detach", &wt_str])
            .map_err(|err| err.message)?,
        "branch" => {
            let branch_name = format!("kite/subagent-{short_id}");
            crate::git::run_git(repo_root, &["worktree", "add", "-b", &branch_name, &wt_str])
                .map_err(|err| err.message)?
        }
        other => return Err(format!("unsupported worktree mode: {other}")),
    };
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("git worktree add ({mode}) failed")
        } else {
            stderr
        });
    }
    Ok(wt_path)
}

pub(crate) fn try_remove_clean_worktree_path(wt_str: &str, ws_mode: &str) {
    if !matches!(ws_mode, "share" | "branch") {
        return;
    }
    let wt_path = PathBuf::from(wt_str);
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
    let _ = crate::git::run_git(parent_repo, &["worktree", "remove", wt_str]);
}

pub(crate) fn try_remove_clean_worktree(child_thread_id: &str) {
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
    try_remove_clean_worktree_path(&wt_str, &ws_mode);
}
