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

fn sync_matching_subagent_items(
    parent: &mut Value,
    subagent_id: &str,
    matched_call_id: Option<&str>,
    child_thread_id: Option<&str>,
    tool_status: &str,
    meta_status: &str,
    streaming: bool,
    step_count: Option<usize>,
    latest_activity: Option<&str>,
    model: Option<&str>,
    provider: Option<&str>,
) -> Vec<Value> {
    let mut updated = Vec::new();
    let synth_id = format!("sub_{subagent_id}");
    let Some(items) = parent.get_mut("items").and_then(Value::as_array_mut) else {
        return updated;
    };
    for target in items.iter_mut() {
        let has_subagent_shape = target.get("toolKind").and_then(Value::as_str) == Some("subagent")
            || target.get("subagentMeta").is_some();
        if !has_subagent_shape {
            continue;
        }
        if streaming || matches!(meta_status, "running" | "waiting") {
            let (srv, clean_name) = super::record::resolve_item_clean_tool_name(target);
            if crate::acp::is_non_delegating_subagent_tool(&clean_name) {
                continue;
            }
            let tid = target.get("id").and_then(Value::as_str).unwrap_or("");
            let is_legacy_untyped_kite_ctrl = !super::record::is_spawn_subagent_item(target)
                && (srv.as_deref() == Some("kite-dispatch")
                    || target
                        .get("toolName")
                        .and_then(Value::as_str)
                        .is_some_and(|n| n.eq_ignore_ascii_case("call_mcp_tool")))
                && target.get("title").and_then(Value::as_str) == Some("Subagent · Subagent")
                && target
                    .pointer("/subagentMeta/workspaceMode")
                    .and_then(Value::as_str)
                    .is_none_or(|s| s.trim().is_empty())
                && !target
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .contains("started thread:")
                && !target
                    .get("detail")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .contains("started thread:")
                && (target
                    .pointer("/subagentMeta/childThreadId")
                    .and_then(Value::as_str)
                    .is_none_or(|s| s.trim().is_empty())
                    || matched_call_id.is_some_and(|cid| !cid.is_empty() && cid != tid));
            if is_legacy_untyped_kite_ctrl {
                continue;
            }
        }
        let tid = target.get("id").and_then(Value::as_str).unwrap_or("");
        let meta_sid = target
            .pointer("/subagentMeta/subagentId")
            .and_then(Value::as_str)
            .unwrap_or("");
        let meta_ctid = target
            .pointer("/subagentMeta/childThreadId")
            .and_then(Value::as_str);
        let matches = tid == synth_id
            || meta_sid == subagent_id
            || matched_call_id.is_some_and(|cid| !cid.is_empty() && tid == cid)
            || child_thread_id.is_some_and(|ctid| {
                !ctid.is_empty() && (meta_ctid == Some(ctid) || meta_sid == ctid)
            });
        if !matches {
            continue;
        }
        let is_primary_or_non_failed = target.get("status").and_then(Value::as_str) != Some("failed")
            || tool_status == "completed";
        if is_primary_or_non_failed {
            target["status"] = json!(tool_status);
        }
        target["streaming"] = json!(streaming);
        if let Some(meta) = target
            .get_mut("subagentMeta")
            .and_then(Value::as_object_mut)
        {
            meta.insert("subagentId".to_string(), json!(subagent_id));
            if let Some(ctid) = child_thread_id {
                meta.insert("childThreadId".to_string(), json!(ctid));
            }
            meta.insert("status".to_string(), json!(meta_status));
            if let Some(steps) = step_count {
                meta.insert("stepCount".to_string(), json!(steps));
            }
            if let Some(latest) = latest_activity {
                meta.insert("latestActivity".to_string(), json!(latest));
            }
            if let Some(m) = model {
                meta.insert("model".to_string(), json!(m));
            }
            if let Some(p) = provider {
                meta.insert("provider".to_string(), json!(p));
            }
        }
        updated.push(target.clone());
    }
    updated
}

pub fn sync_child_thread_to_parent(child_thread_id: &str) {
    let snapshot = {
        let Ok(all_threads) = threads().lock() else {
            return;
        };
        let Some(child) = all_threads
            .iter()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(child_thread_id))
        else {
            return;
        };
        let Some(parent_tid) = child
            .get("parentThreadId")
            .and_then(Value::as_str)
            .map(str::to_string)
        else {
            return;
        };
        let child_status = child
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("idle")
            .to_string();
        let child_items = child
            .get("items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let child_model = child.get("model").and_then(Value::as_str).map(str::to_string);
        let child_provider = child
            .get("provider")
            .and_then(Value::as_str)
            .map(str::to_string);
        let child_failure = child
            .pointer("/turnFailure/message")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        (
            parent_tid,
            child_status,
            child_items,
            child_model,
            child_provider,
            child_failure,
        )
    };

    let (parent_tid, child_status, child_items, child_model, child_provider, child_failure) =
        snapshot;
    let is_killed = crate::chat::kill_registry::is_thread_killed(child_thread_id);
    let run_status = if is_killed {
        "killed"
    } else {
        match child_status.as_str() {
            "running" => "running",
            "waiting" => "waiting",
            "error" => "failed",
            _ => "completed",
        }
    };
    let tool_status = match run_status {
        "running" | "waiting" => "running",
        "failed" | "killed" => "error",
        _ => "completed",
    };
    let is_terminal = matches!(run_status, "completed" | "failed" | "killed");
    let now = now_ms();

    let mut emitted_run: Option<Value> = None;
    let mut updated_tool_items: Vec<Value> = Vec::new();
    let mut should_persist = is_terminal;

    {
        let Ok(mut all_threads) = threads().lock() else {
            return;
        };
        if let Some(parent) = all_threads
            .iter_mut()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(parent_tid.as_str()))
        {
            let mut matched_sub_id: Option<String> = None;
            let mut matched_call_id: Option<String> = None;
            let mut synced_step_count = 0usize;
            let mut synced_latest_activity: Option<String> = None;
            if let Some(runs) = parent.get_mut("subagentRuns").and_then(Value::as_array_mut) {
                if let Some(run) = runs.iter_mut().find(|r| {
                    r.get("childThreadId").and_then(Value::as_str) == Some(child_thread_id)
                        || r.get("subagentId").and_then(Value::as_str) == Some(child_thread_id)
                }) {
                    let initial_prompt = run.get("prompt").and_then(Value::as_str).map(str::to_string);
                    let mut filtered_items =
                        filter_subagent_stream_items(&child_items, initial_prompt.as_deref());
                    if run_status == "failed" {
                        if let Some(ref failure_msg) = child_failure {
                            let already_shown = filtered_items.iter().any(|it| {
                                it.get("text")
                                    .and_then(Value::as_str)
                                    .is_some_and(|t| t.contains(failure_msg.as_str()))
                                    || it
                                        .get("detail")
                                        .and_then(Value::as_str)
                                        .is_some_and(|d| d.contains(failure_msg.as_str()))
                            });
                            if !already_shown {
                                filtered_items.push(json!({
                                    "id": format!("subagent-error-{child_thread_id}"),
                                    "kind": "error",
                                    "title": "Subagent error",
                                    "text": failure_msg,
                                    "detail": failure_msg,
                                    "status": "error",
                                    "timestamp": now,
                                }));
                            }
                        }
                    }
                    let (step_count, computed_latest) = summarize_run_progress(&filtered_items);
                    let prev_status = run
                        .get("status")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    if prev_status != run_status {
                        should_persist = true;
                    }
                    let latest_activity = if is_killed {
                        Some("Stopped by user".to_string())
                    } else if run_status == "failed" {
                        child_failure.clone().or(computed_latest)
                    } else {
                        computed_latest
                    };
                    synced_step_count = step_count;
                    synced_latest_activity = latest_activity.clone();

                    matched_sub_id = run
                        .get("subagentId")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    matched_call_id = run
                        .get("parentToolCallId")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    run["items"] = Value::Array(filtered_items);
                    run["status"] = json!(run_status);
                    run["stepCount"] = json!(step_count);
                    if let Some(ref latest) = latest_activity {
                        run["latestActivity"] = json!(latest);
                    }
                    if let Some(ref m) = child_model {
                        run["model"] = json!(m);
                    }
                    if let Some(ref p) = child_provider {
                        run["provider"] = json!(p);
                    }
                    run["updatedAtUnixMs"] = json!(now);
                    if is_terminal {
                        if run.get("completedAtUnixMs").is_none_or(Value::is_null) {
                            run["completedAtUnixMs"] = json!(now);
                        }
                    } else if let Some(obj) = run.as_object_mut() {
                        obj.remove("completedAtUnixMs");
                    }
                    emitted_run = Some(run.clone());
                }
            }
            if matched_sub_id.is_none() {
                let (_, fallback_latest) = summarize_run_progress(&child_items);
                synced_latest_activity = fallback_latest;
                synced_step_count = summarize_run_progress(&child_items).0;
            }
            updated_tool_items = sync_matching_subagent_items(
                parent,
                matched_sub_id.as_deref().unwrap_or(child_thread_id),
                matched_call_id.as_deref(),
                Some(child_thread_id),
                tool_status,
                run_status,
                !is_terminal,
                Some(synced_step_count),
                synced_latest_activity.as_deref(),
                child_model.as_deref(),
                child_provider.as_deref(),
            );
            reconcile_duplicate_subagent_state(parent);
            touch(parent);
        }
    }

    if !updated_tool_items.is_empty() {
        if let Ok(mut live) = live_turns().lock() {
            if let Some(run_id) = live.by_thread.get(&parent_tid).cloned() {
                if let Some(run) = live.runs.get_mut(&run_id) {
                    for tool_item in &updated_tool_items {
                        push_event(run, json!({ "kind": "upsert", "item": tool_item }));
                    }
                }
            }
        }
        live_cv().notify_all();
    }

    if let Some(run) = emitted_run {
        let sub_id = run
            .get("subagentId")
            .and_then(Value::as_str)
            .unwrap_or(child_thread_id)
            .to_string();
        emit_subagent_event(json!({
            "kind": "subagentRunUpdated",
            "threadId": parent_tid,
            "subagentId": sub_id,
            "run": run,
        }));
        emit_subagent_steps_event(&parent_tid, &sub_id, &run);
    }
    if should_persist {
        persist();
    }
}

pub fn extract_final_assistant_text(thread_id: &str) -> String {
    let Ok(all_threads) = threads().lock() else {
        return String::new();
    };
    let Some(thread) = all_threads
        .iter()
        .find(|t| t.get("id").and_then(Value::as_str) == Some(thread_id))
    else {
        return String::new();
    };
    let Some(items) = thread.get("items").and_then(Value::as_array) else {
        return String::new();
    };
    items
        .iter()
        .rev()
        .find(|item| {
            item.get("kind").and_then(Value::as_str) == Some("assistant")
                && !item
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .is_empty()
        })
        .and_then(|item| item.get("text").and_then(Value::as_str))
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

pub use crate::dispatch::cli_wire::format_subagent_wait_output;

pub fn send_subagent_message_with_launcher(
    thread_id: &str,
    subagent_id: &str,
    message: &str,
    launcher: Option<&dyn Fn(&str, &str) -> Result<(), String>>,
) -> Result<Value, String> {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Err("message is required".to_string());
    }

    let (child_tid, emitted_run, updated_items) = {
        let mut all = threads()
            .lock()
            .map_err(|_| "threads lock poisoned".to_string())?;
        let Some(parent) = all
            .iter_mut()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(thread_id))
        else {
            return Err("Parent thread not found".to_string());
        };

        let mut matched_child: Option<String> = None;
        let mut matched_tool_call: Option<String> = None;
        let mut matched_sid = subagent_id.to_string();
        let mut updated_run: Option<Value> = None;
        if let Some(runs) = parent.get_mut("subagentRuns").and_then(Value::as_array_mut) {
            if let Some(run) = runs.iter_mut().find(|r| {
                r.get("subagentId").and_then(Value::as_str) == Some(subagent_id)
                    || r.get("parentToolCallId").and_then(Value::as_str) == Some(subagent_id)
                    || r.get("childThreadId").and_then(Value::as_str) == Some(subagent_id)
            }) {
                matched_child = run
                    .get("childThreadId")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                matched_tool_call = run
                    .get("parentToolCallId")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                if let Some(sid) = run.get("subagentId").and_then(Value::as_str) {
                    if !sid.is_empty() {
                        matched_sid = sid.to_string();
                    }
                }
                if matched_child.is_some() {
                    run["status"] = json!("running");
                    run["latestActivity"] = json!("Sending follow-up message...");
                    run["updatedAtUnixMs"] = json!(now_ms());
                    if let Some(obj) = run.as_object_mut() {
                        obj.remove("completedAtUnixMs");
                    }
                    updated_run = Some(run.clone());
                }
            }
        }

        let Some(cid) = matched_child else {
            return Err("This subagent run has no interactive child thread".to_string());
        };
        let synced_items = sync_matching_subagent_items(
            parent,
            &matched_sid,
            matched_tool_call.as_deref(),
            Some(&cid),
            "running",
            "running",
            true,
            None,
            Some("Running follow-up task..."),
            None,
            None,
        );
        touch(parent);
        if let Some(child) = all
            .iter_mut()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(cid.as_str()))
        {
            child["status"] = json!("running");
            touch(child);
        }
        (cid, updated_run, synced_items)
    };

    persist();
    if !updated_items.is_empty() {
        if let Ok(mut live) = live_turns().lock() {
            if let Some(rid) = live.by_thread.get(thread_id).cloned() {
                if let Some(run) = live.runs.get_mut(&rid) {
                    for it in &updated_items {
                        push_event(run, json!({ "kind": "upsert", "item": it }));
                    }
                }
            }
        }
        live_cv().notify_all();
    }
    if let Some(ref run) = emitted_run {
        emit_subagent_event(json!({
            "kind": "subagentRunUpdated",
            "threadId": thread_id,
            "subagentId": run.get("subagentId"),
            "run": run,
        }));
    }

    crate::chat::kill_registry::clear_thread_killed(&child_tid);
    let launch_res = match launcher {
        Some(f) => f(&child_tid, trimmed),
        None => crate::chat::kill_registry::resume_child_thread_turn(&child_tid, trimmed),
    };
    if let Err(err) = launch_res {
        if let Ok(mut all) = threads().lock() {
            if let Some(parent) = all
                .iter_mut()
                .find(|t| t.get("id").and_then(Value::as_str) == Some(thread_id))
            {
                if let Some(runs) = parent.get_mut("subagentRuns").and_then(Value::as_array_mut) {
                    if let Some(run) = runs.iter_mut().find(|r| {
                        r.get("childThreadId").and_then(Value::as_str) == Some(child_tid.as_str())
                    }) {
                        run["status"] = json!("failed");
                        run["latestActivity"] = json!(err.clone());
                        run["updatedAtUnixMs"] = json!(now_ms());
                        run["completedAtUnixMs"] = json!(now_ms());
                    }
                }
            }
        }
        persist();
        sync_child_thread_to_parent(&child_tid);
        return Err(err);
    }

    sync_child_thread_to_parent(&child_tid);
    Ok(build_subagent_detail(thread_id, subagent_id)
        .or(emitted_run)
        .unwrap_or(Value::Null))
}

pub fn steer_subagent_thread(
    thread_id: &str,
    subagent_id: &str,
    message: &str,
) -> Result<Value, String> {
    send_subagent_message_with_launcher(thread_id, subagent_id, message, None)
}

pub fn cancel_subagent_thread(thread_id: &str, subagent_id: &str) -> Result<Value, String> {
    let mut did_kill = false;
    let (child_tid, existing_status, settled_detail, already_settled_nat) = {
        let all = threads()
            .lock()
            .map_err(|_| "threads lock poisoned".to_string())?;
        let Some(parent) = all
            .iter()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(thread_id))
        else {
            return Err("Parent thread not found".to_string());
        };
        let Some(run) = parent
            .get("subagentRuns")
            .and_then(Value::as_array)
            .and_then(|runs| {
                runs.iter().find(|r| {
                    r.get("subagentId").and_then(Value::as_str) == Some(subagent_id)
                        || r.get("parentToolCallId").and_then(Value::as_str) == Some(subagent_id)
                        || r.get("childThreadId").and_then(Value::as_str) == Some(subagent_id)
                })
            })
        else {
            return Err("Subagent run not found".to_string());
        };
        let status = run
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("running")
            .to_string();
        let detail = if matches!(status.as_str(), "completed" | "failed" | "killed") {
            Some(run.clone())
        } else {
            None
        };
        let cid = run
            .get("childThreadId")
            .and_then(Value::as_str)
            .map(str::to_string);
        let settled_naturally = if matches!(status.as_str(), "completed" | "failed" | "killed") {
            false
        } else if let Some(ref child_id) = cid {
            let outcome = crate::chat::kill_registry::try_mark_thread_killed(child_id);
            if outcome == crate::chat::kill_registry::MarkKillOutcome::AlreadySettled {
                true
            } else {
                did_kill = true;
                false
            }
        } else {
            false
        };
        (cid, status, detail, settled_naturally)
    };

    if already_settled_nat {
        if let Some(ref cid) = child_tid {
            sync_child_thread_to_parent(cid);
        }
        return Ok(build_subagent_detail(thread_id, subagent_id)
            .or(settled_detail)
            .unwrap_or(Value::Null));
    }

    // Never clobber an already-settled subagent run with "killed" / "Stopped by user".
    if matches!(existing_status.as_str(), "completed" | "failed" | "killed") {
        return Ok(build_subagent_detail(thread_id, subagent_id)
            .or(settled_detail)
            .unwrap_or(Value::Null));
    }

    if let Some(ref cid) = child_tid {
        crate::chat::cancel_turn(cid);
        if let Ok(mut manager) = crate::chat::session_manager().lock() {
            let already_closed = manager
                .status(cid)
                .is_some_and(|r| r.state == crate::chat::SessionState::Closed);
            if !already_closed {
                let _ = manager.stop(cid);
            }
        }
    }

    let now = now_ms();
    let mut updated_run: Option<Value> = None;
    let mut already_settled_in_race = false;
    let mut should_clear_killed = false;
    let mut updated_items: Vec<Value> = Vec::new();
    {
        let mut all = threads()
            .lock()
            .map_err(|_| "threads lock poisoned".to_string())?;
        if let Some(parent) = all
            .iter_mut()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(thread_id))
        {
            let mut matched_call: Option<String> = None;
            let mut matched_sid = subagent_id.to_string();
            if let Some(runs) = parent.get_mut("subagentRuns").and_then(Value::as_array_mut) {
                if let Some(run) = runs.iter_mut().find(|r| {
                    r.get("subagentId").and_then(Value::as_str) == Some(subagent_id)
                        || r.get("parentToolCallId").and_then(Value::as_str) == Some(subagent_id)
                        || r.get("childThreadId").and_then(Value::as_str) == Some(subagent_id)
                }) {
                    let current_status = run
                        .get("status")
                        .and_then(Value::as_str)
                        .unwrap_or("running");
                    if matches!(current_status, "completed" | "failed")
                        || (!did_kill && current_status == "killed")
                    {
                        already_settled_in_race = true;
                        should_clear_killed = current_status != "killed";
                        updated_run = Some(run.clone());
                    } else {
                        matched_call = run
                            .get("parentToolCallId")
                            .and_then(Value::as_str)
                            .map(str::to_string);
                        if let Some(sid) = run.get("subagentId").and_then(Value::as_str) {
                            if !sid.is_empty() {
                                matched_sid = sid.to_string();
                            }
                        }
                        run["status"] = json!("killed");
                        run["latestActivity"] = json!("Stopped by user");
                        run["updatedAtUnixMs"] = json!(now);
                        run["completedAtUnixMs"] = json!(now);
                        updated_run = Some(run.clone());
                    }
                }
            }
            if !already_settled_in_race {
                updated_items = sync_matching_subagent_items(
                    parent,
                    &matched_sid,
                    matched_call.as_deref(),
                    child_tid.as_deref(),
                    "error",
                    "killed",
                    false,
                    None,
                    Some("Stopped by user"),
                    None,
                    None,
                );
                touch(parent);
            }
        }
        if !already_settled_in_race {
            if let Some(ref cid) = child_tid {
                if let Some(child) = all
                    .iter_mut()
                    .find(|t| t.get("id").and_then(Value::as_str) == Some(cid.as_str()))
                {
                    child["status"] = json!("idle");
                    touch(child);
                }
            }
        }
    }

    if should_clear_killed {
        if let Some(ref cid) = child_tid {
            crate::chat::kill_registry::clear_thread_killed(cid);
        }
    }

    if !already_settled_in_race {
        persist();
        if !updated_items.is_empty() {
            if let Ok(mut live) = live_turns().lock() {
                if let Some(rid) = live.by_thread.get(thread_id).cloned() {
                    if let Some(run) = live.runs.get_mut(&rid) {
                        for it in &updated_items {
                            push_event(run, json!({ "kind": "upsert", "item": it }));
                        }
                    }
                }
            }
            live_cv().notify_all();
        }
        if let Some(ref cid) = child_tid {
            sync_child_thread_to_parent(cid);
        } else if let Some(ref run) = updated_run {
            let sid = run
                .get("subagentId")
                .and_then(Value::as_str)
                .unwrap_or(subagent_id);
            emit_subagent_event(json!({
                "kind": "subagentRunUpdated",
                "threadId": thread_id,
                "subagentId": sid,
                "run": run,
            }));
            emit_subagent_steps_event(thread_id, sid, run);
        }
    }
    Ok(build_subagent_detail(thread_id, subagent_id)
        .or(updated_run)
        .unwrap_or(Value::Null))
}

