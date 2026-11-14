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

pub(crate) fn set_thread_effort_option(thread: &mut Value, effort: &str) {
    thread["effort"] = json!(effort);
    if thread.get("providerOptions").and_then(Value::as_array).is_none() {
        thread["providerOptions"] = json!([]);
    }
    if let Some(opts) = thread.get_mut("providerOptions").and_then(Value::as_array_mut) {
        if let Some(existing) = opts
            .iter_mut()
            .find(|opt| opt.get("id").and_then(Value::as_str) == Some("effort"))
        {
            existing["value"] = json!(effort);
        } else {
            opts.push(json!({ "id": "effort", "value": effort }));
        }
    }
}

pub(crate) fn remembered_provider_defaults(provider: &str) -> (Option<String>, Option<String>) {
    let canon = crate::chat::models::canonical_thread_provider_id(provider)
        .unwrap_or(provider)
        .to_string();
    let Ok(all) = threads().lock() else {
        return (None, None);
    };
    let mut best_ts: i64 = -1;
    let mut best_model: Option<String> = None;
    let mut best_effort: Option<String> = None;
    for t in all.iter() {
        if t.get("startedByAgent").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let Some(p) = t.get("provider").and_then(Value::as_str) else {
            continue;
        };
        let p_canon = crate::chat::models::canonical_thread_provider_id(p).unwrap_or(p);
        if !p_canon.eq_ignore_ascii_case(&canon) {
            continue;
        }
        let ts = t
            .get("updatedAtUnixMs")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let model = t
            .get("model")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        if let Some(ref m) = model {
            if crate::chat::models::model_likely_belongs_to_another_provider(&canon, m)
                || (!cfg!(test)
                    && crate::chat::models::validate_provider_model_selection(&canon, m).is_err())
            {
                continue;
            }
        }
        let effort = t
            .get("effort")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        if ts >= best_ts && (model.is_some() || effort.is_some()) {
            best_ts = ts;
            if model.is_some() {
                best_model = model;
            }
            if effort.is_some() {
                best_effort = effort;
            }
        }
    }
    (best_model, best_effort)
}

pub fn spawn_child_subagent_thread(
    params: ChildSubagentSpawnParams,
) -> Result<ChildSubagentSpawnResult, String> {
    let parent_meta = params.parent_thread_id.as_deref().and_then(|pid| {
        let all = threads().lock().ok()?;
        let parent = all
            .iter()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(pid))?;
        let p_provider = parent
            .get("provider")
            .and_then(Value::as_str)
            .map(str::to_string);
        let p_model = parent
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_string);
        let p_ws_id = parent
            .get("workspaceId")
            .and_then(Value::as_str)
            .map(str::to_string);
        let p_cwd = parent
            .get("worktreePath")
            .or_else(|| parent.get("workingDirectory"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| p_ws_id.as_deref().and_then(workspace_path));
        Some((p_provider, p_model, p_ws_id, p_cwd))
    });

    let (parent_provider, parent_model, parent_workspace_id, parent_cwd) =
        parent_meta.unwrap_or((None, None, None, None));

    let provider = params
        .provider
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_ascii_lowercase)
        .or_else(|| parent_provider.clone())
        .unwrap_or_else(|| "antigravity".to_string());

    let same_provider_as_parent = parent_provider
        .as_deref()
        .is_some_and(|p| p.eq_ignore_ascii_case(&provider));
    let (remembered_model, remembered_effort) = remembered_provider_defaults(&provider);

    let child_id = uuid::Uuid::new_v4().to_string();
    let short_id: String = child_id.chars().filter(|c| *c != '-').take(8).collect();

    let requested_model = params
        .model
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| {
            if params.provider.is_none() || same_provider_as_parent {
                parent_model.clone().or(remembered_model.clone())
            } else {
                remembered_model.clone()
            }
        });

    let title = params
        .role
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("Subagent ({provider})"));

    let mut child = blank_thread(
        &child_id,
        None,
        &title,
        &provider,
        parent_workspace_id.as_deref(),
    );
    child["model"] = requested_model
        .as_ref()
        .map(|model| json!(model))
        .unwrap_or(Value::Null);
    child["mode"] = json!(default_mode(&provider));
    child["startedByAgent"] = json!(true);
    child["sideChat"] = json!(true);
    if let Some(ref pid) = params.parent_thread_id {
        child["parentThreadId"] = json!(pid);
    }
    if let Some(ref role) = params.role.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        child["subagentRole"] = json!(role);
    }
    let workspace_mode = match params.workspace_mode.trim().to_ascii_lowercase().as_str() {
        "share" => "share".to_string(),
        "branch" => "branch".to_string(),
        _ => "inherit".to_string(),
    };
    child["workspaceMode"] = json!(workspace_mode);
    if let Some(eff) = params
        .effort
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        set_thread_effort_option(&mut child, eff);
    } else if !same_provider_as_parent {
        if let Some(eff) = remembered_effort {
            set_thread_effort_option(&mut child, &eff);
        } else {
            child["effort"] = Value::Null;
            child["providerOptions"] = json!([]);
        }
    }

    let base_cwd = parent_cwd
        .or(params.fallback_cwd)
        .filter(|s| !s.trim().is_empty());
    let mut final_cwd = base_cwd.clone();
    if workspace_mode == "share" || workspace_mode == "branch" {
        let base_str = base_cwd.ok_or_else(|| {
            format!("cannot provision {workspace_mode} worktree without a repository path")
        })?;
        let base_path = PathBuf::from(&base_str);
        let repo_root = resolve_git_repo_root(&base_path).unwrap_or(base_path);
        let wt_path = provision_subagent_worktree(&repo_root, &workspace_mode, &short_id)?;
        let wt_str = wt_path.to_string_lossy().to_string();
        child["worktreePath"] = json!(wt_str);
        child["workingDirectory"] = json!(wt_str);
        final_cwd = Some(wt_str);
    } else if let Some(ref cwd_str) = final_cwd {
        child["workingDirectory"] = json!(cwd_str);
    }

    let final_model = child
        .get("model")
        .and_then(Value::as_str)
        .map(str::to_string);

    {
        let mut all_threads = threads().lock().unwrap();
        all_threads.push(child);
    }

    let claimed_tool_id = params.parent_thread_id.as_deref().and_then(|pid| {
        let all_threads = threads().lock().ok()?;
        let parent = all_threads
            .iter()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(pid))?;
        let items = parent.get("items").and_then(Value::as_array)?;
        let target_role = params.role.as_deref().unwrap_or("");
        find_reclaimable_unbound_subagent_call_id(items, target_role, &params.task)
    });

    let tool_call_id = claimed_tool_id.unwrap_or_else(|| format!("dispatch-subagent-{child_id}"));
    let tool_item = json!({
        "id": tool_call_id,
        "kind": "tool",
        "toolName": "dispatch_subagent",
        "toolKind": "subagent",
        "title": title,
        "detail": params.task,
        "status": "running",
        "subagentMeta": {
            "subagentId": child_id,
            "role": params.role.unwrap_or_else(|| format!("Subagent ({provider})")),
            "typeName": provider,
            "provider": provider,
            "model": final_model,
            "workspaceMode": workspace_mode,
            "prompt": params.task,
            "status": "running",
            "childThreadId": child_id,
            "stepCount": 0
        }
    });

    if let Some(pid) = params.parent_thread_id.as_deref() {
        {
            let mut all_threads = threads().lock().unwrap();
            if let Some(parent) = all_threads
                .iter_mut()
                .find(|t| t.get("id").and_then(Value::as_str) == Some(pid))
            {
                upsert_item(parent, &tool_item);
                reconcile_duplicate_subagent_state(parent);
                touch(parent);
            }
        }
        if let Ok(mut live) = live_turns().lock() {
            if let Some(run_id) = live.by_thread.get(pid).cloned() {
                if let Some(run) = live.runs.get_mut(&run_id) {
                    push_event(run, json!({ "kind": "upsert", "item": tool_item.clone() }));
                }
            }
        }
        live_cv().notify_all();
        record_subagent_tool_call(pid, &tool_item);
    }

    persist();
    Ok(ChildSubagentSpawnResult {
        child_thread_id: child_id,
        provider,
        model: final_model,
        working_directory: final_cwd,
    })
}

pub(crate) fn is_terminal_subagent_item(item: &Value) -> bool {
    let top_status = item
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let meta_status = item
        .pointer("/subagentMeta/status")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    [top_status, meta_status].into_iter().any(|status| {
        status.eq_ignore_ascii_case("completed")
            || status.eq_ignore_ascii_case("failed")
            || status.eq_ignore_ascii_case("error")
            || status.eq_ignore_ascii_case("killed")
            || status.eq_ignore_ascii_case("done")
            || status.eq_ignore_ascii_case("exited")
    })
}

pub(crate) fn find_reclaimable_unbound_subagent_call_id(
    items: &[Value],
    target_role: &str,
    target_prompt: &str,
) -> Option<String> {
    let target_role = target_role.trim();
    let target_prompt = target_prompt.trim();
    items
        .iter()
        .rev()
        .find(|it| {
            let id = it.get("id").and_then(Value::as_str).unwrap_or("");
            if id.is_empty()
                || id.starts_with("dispatch-subagent-")
                || it.get("toolKind").and_then(Value::as_str) != Some("subagent")
            {
                return false;
            }
            if is_terminal_subagent_item(it) {
                return false;
            }
            let has_cid = it
                .pointer("/subagentMeta/childThreadId")
                .and_then(Value::as_str)
                .is_some_and(|s| !s.trim().is_empty());
            if has_cid {
                return false;
            }
            let it_role = it
                .pointer("/subagentMeta/role")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            let it_prompt = it
                .pointer("/subagentMeta/prompt")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            let is_live = matches!(
                it.get("status").and_then(Value::as_str),
                Some("running" | "inProgress" | "pending" | "in_progress")
            );
            (!target_prompt.is_empty() && it_prompt == target_prompt)
                || (!target_role.is_empty() && it_role == target_role)
                || is_live
        })
        .and_then(|it| it.get("id").and_then(Value::as_str).map(str::to_string))
}

