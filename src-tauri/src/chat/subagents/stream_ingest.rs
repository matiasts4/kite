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

pub(super) fn parse_nested_frame_items(subagent_id: &str, id_hint: &str, frame: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    let msg_type = frame.get("type").and_then(Value::as_str).unwrap_or("");
    if (msg_type == "assistant" || msg_type == "user")
        && frame.pointer("/message/content").and_then(Value::as_array).is_some()
    {
        if let Some(parts) = frame.pointer("/message/content").and_then(Value::as_array) {
            for (idx, part) in parts.iter().enumerate() {
                match part.get("type").and_then(Value::as_str).unwrap_or("") {
                    "thinking" => {
                        if let Some(text) = part.get("thinking").or_else(|| part.get("text")).and_then(Value::as_str) {
                            if !text.trim().is_empty() {
                                let item_id = format!("sub_{subagent_id}_{id_hint}_th_{idx}");
                                out.push(chat_item(&item_id, "reasoning", text, false));
                            }
                        }
                    }
                    "text" => {
                        if let Some(text) = part.get("text").and_then(Value::as_str) {
                            if !text.trim().is_empty() {
                                let item_id = format!("sub_{subagent_id}_{id_hint}_tx_{idx}");
                                out.push(chat_item(&item_id, "assistant", text, false));
                            }
                        }
                    }
                    "tool_use" => {
                        let tool_id = part
                            .get("id")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                            .unwrap_or_else(|| format!("sub_{subagent_id}_{id_hint}_tu_{idx}"));
                        let tool_name = part.get("name").and_then(Value::as_str).unwrap_or("tool");
                        let params = part.get("input").cloned().unwrap_or(Value::Null);
                        let tool = build_acp_tool_call(
                            tool_id,
                            tool_name,
                            params,
                            "running".to_string(),
                            None,
                            None,
                            None,
                            None,
                            None,
                            None,
                            None,
                            Some(subagent_id.to_string()),
                        );
                        out.push(acp_tool_to_chat_item(&tool));
                    }
                    "tool_result" => {
                        let tool_id = part
                            .get("tool_use_id")
                            .or_else(|| part.get("id"))
                            .and_then(Value::as_str)
                            .unwrap_or("tool_1")
                            .to_string();
                        let output = part.get("content").and_then(|v| {
                            v.as_str()
                                .map(str::to_string)
                                .or_else(|| (!v.is_null()).then(|| serde_json::to_string_pretty(v).ok()).flatten())
                        });
                        let is_error = part.get("is_error").and_then(Value::as_bool).unwrap_or(false);
                        let tool = build_acp_tool_call(
                            tool_id,
                            "",
                            Value::Null,
                            if is_error { "failed".into() } else { "completed".into() },
                            output,
                            None,
                            None,
                            Some("dynamicToolCall".to_string()),
                            Some(String::new()),
                            Some(String::new()),
                            None,
                            Some(subagent_id.to_string()),
                        );
                        out.push(acp_tool_to_chat_item(&tool));
                    }
                    _ => {}
                }
            }
            return out;
        }
    }

    if let Ok(line) = serde_json::to_string(frame) {
        if let Some(ev) = crate::acp::parse_acp_stream_line("nested", id_hint, &line) {
            match ev {
                AcpStreamEvent::ToolUpdate { tool } => out.push(acp_tool_to_chat_item(&tool)),
                AcpStreamEvent::ContentDelta { text } if !text.trim().is_empty() => {
                    let item_id = format!("sub_{subagent_id}_{id_hint}_msg");
                    out.push(chat_item(&item_id, "assistant", &text, false));
                }
                AcpStreamEvent::ThoughtDelta { text, is_done, .. } if !text.trim().is_empty() => {
                    let item_id = format!("sub_{subagent_id}_{id_hint}_thought");
                    out.push(chat_item(&item_id, "reasoning", &text, !is_done));
                }
                _ => {}
            }
        }
    }
    out
}

pub fn ingest_nested_subagent_frame(
    thread_id: &str,
    parent_run_id: &str,
    parent_tool_use_id: &str,
    frame: &Value,
) -> bool {
    let hint = now_ms().to_string();
    let nested_items = parse_nested_frame_items(parent_tool_use_id, &hint, frame);
    if nested_items.is_empty() {
        return false;
    }

    let mut parent_tool_item_update: Option<Value> = None;
    let mut updated_run: Option<Value> = None;

    {
        let mut all_threads = threads().lock().unwrap();
        if let Some(thread) = all_threads
            .iter_mut()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(thread_id))
        {
            let fallback_provider = thread
                .get("provider")
                .and_then(Value::as_str)
                .map(str::to_string);
            if thread.get("subagentRuns").and_then(Value::as_array).is_none() {
                thread["subagentRuns"] = Value::Array(Vec::new());
            }
            let runs = thread["subagentRuns"].as_array_mut().unwrap();
            let pos = runs.iter().position(|r| {
                r.get("parentToolCallId").and_then(Value::as_str) == Some(parent_tool_use_id)
                    || r.get("subagentId").and_then(Value::as_str) == Some(parent_tool_use_id)
            });
            let idx = if let Some(idx) = pos {
                idx
            } else {
                let now = now_ms();
                let placeholder = SubagentRun {
                    subagent_id: parent_tool_use_id.to_string(),
                    parent_thread_id: thread_id.to_string(),
                    parent_tool_call_id: parent_tool_use_id.to_string(),
                    role: "Subagent".to_string(),
                    swarm_member_name: None,
                    type_name: None,
                    provider: fallback_provider,
                    model: None,
                    workspace_mode: None,
                    prompt: None,
                    status: "running".to_string(),
                    transcript_uri: None,
                    child_thread_id: None,
                    latest_activity: None,
                    step_count: 0,
                    items: Vec::new(),
                    started_at_unix_ms: now,
                    updated_at_unix_ms: now,
                    completed_at_unix_ms: None,
                };
                runs.push(serde_json::to_value(placeholder).unwrap_or(json!({})));
                runs.len() - 1
            };

            let run = &mut runs[idx];
            let sub_id = run
                .get("subagentId")
                .and_then(Value::as_str)
                .unwrap_or(parent_tool_use_id)
                .to_string();
            let mut existing = run
                .get("items")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            for item in &nested_items {
                upsert_nested_item(&mut existing, item);
            }
            let (step_count, latest_activity) = summarize_run_progress(&existing);
            run["items"] = Value::Array(existing);
            run["stepCount"] = json!(step_count);
            if let Some(ref latest) = latest_activity {
                run["latestActivity"] = json!(latest);
            }
            run["updatedAtUnixMs"] = json!(now_ms());
            updated_run = Some(run.clone());

            parent_tool_item_update = sync_parent_tool_item_progress(
                thread,
                &sub_id,
                step_count,
                latest_activity.as_deref(),
            );
            touch(thread);
        }
    }

    if let Some(parent_tool) = parent_tool_item_update {
        {
            let mut live = live_turns().lock().unwrap();
            if let Some(run) = live.runs.get_mut(parent_run_id) {
                push_event(run, json!({ "kind": "upsert", "item": parent_tool }));
            }
        }
        live_cv().notify_all();
    }

    if let Some(run) = updated_run {
        emit_subagent_event(json!({
            "kind": "subagentRunUpdated",
            "threadId": thread_id,
            "subagentId": run.get("subagentId"),
            "run": run,
        }));
    }
    true
}

pub fn build_subagent_detail(thread_id: &str, subagent_id: &str) -> Option<Value> {
    let all_threads = threads().lock().unwrap();
    let parent = all_threads
        .iter()
        .find(|t| t.get("id").and_then(Value::as_str) == Some(thread_id))?;
    let mut run = parent
        .get("subagentRuns")
        .and_then(Value::as_array)
        .and_then(|runs| {
            runs.iter().find(|r| {
                r.get("subagentId").and_then(Value::as_str) == Some(subagent_id)
                    || r.get("parentToolCallId").and_then(Value::as_str) == Some(subagent_id)
                    || r.get("childThreadId").and_then(Value::as_str) == Some(subagent_id)
            })
        })
        .cloned()?;

    let child_tid = run.get("childThreadId").and_then(Value::as_str).map(str::to_string);
    let uri = run.get("transcriptUri").and_then(Value::as_str).map(str::to_string);
    let initial_prompt = run.get("prompt").and_then(Value::as_str).map(str::to_string);

    if let Some(cid) = child_tid {
        if let Some(child) = all_threads
            .iter()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(cid.as_str()))
        {
            if let Some(child_items) = child.get("items").and_then(Value::as_array) {
                let filtered =
                    filter_subagent_stream_items(child_items, initial_prompt.as_deref());
                run["items"] = Value::Array(filtered.clone());
                let (steps, latest) = summarize_run_progress(&filtered);
                run["stepCount"] = json!(steps);
                if let Some(l) = latest {
                    run["latestActivity"] = json!(l);
                }
            }
            if let Some(status) = child.get("status").and_then(Value::as_str) {
                if status == "running" || status == "waiting" {
                    run["status"] = json!(status);
                }
            }
            if let Some(model) = child.get("model").and_then(Value::as_str) {
                run["model"] = json!(model);
            }
            if let Some(provider) = child.get("provider").and_then(Value::as_str) {
                run["provider"] = json!(provider);
            }
        }
    }
    drop(all_threads);

    if let Some(u) = uri {
        if let Some(path) = resolve_local_transcript_path(&u) {
            if let Ok(content) = fs::read_to_string(&path) {
                let parsed = parse_transcript_jsonl(&content, subagent_id);
                if !parsed.is_empty() {
                    let mut items = run
                        .get("items")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    for it in &parsed {
                        upsert_nested_item(&mut items, it);
                    }
                    let filtered =
                        filter_subagent_stream_items(&items, initial_prompt.as_deref());
                    let (steps, latest) = summarize_run_progress(&filtered);
                    run["items"] = Value::Array(filtered);
                    run["stepCount"] = json!(steps);
                    if let Some(l) = latest {
                        run["latestActivity"] = json!(l);
                    }
                }
            }
        }
    }

    if let Some(existing_items) = run.get("items").and_then(Value::as_array).cloned() {
        let filtered = filter_subagent_stream_items(&existing_items, initial_prompt.as_deref());
        run["items"] = Value::Array(filtered);
    }

    Some(run)
}

pub fn build_swarm_state(thread_id: &str) -> Value {
    let all_threads = threads().lock().unwrap();
    let Some(parent) = all_threads
        .iter()
        .find(|t| t.get("id").and_then(Value::as_str) == Some(thread_id))
    else {
        return serde_json::to_value(SwarmState::empty_for(thread_id, None)).unwrap_or(json!({}));
    };
    let coordinator_model = parent
        .get("model")
        .and_then(Value::as_str)
        .map(str::to_string);
    let mut state = parent
        .get("swarmState")
        .and_then(|v| serde_json::from_value::<SwarmState>(v.clone()).ok())
        .unwrap_or_else(|| SwarmState::empty_for(thread_id, coordinator_model));

    // Reconcile any child threads spawned directly for swarm members.
    for child in all_threads.iter() {
        if child.get("parentThreadId").and_then(Value::as_str) != Some(thread_id) {
            continue;
        }
        let Some(member_name) = child.get("swarmMemberName").and_then(Value::as_str) else {
            continue;
        };
        if let Some(member) = state.members.iter_mut().find(|m| m.name == member_name) {
            member.child_thread_id = child.get("id").and_then(Value::as_str).map(str::to_string);
            if member.state != "killed" {
                let st = child.get("status").and_then(Value::as_str).unwrap_or("idle");
                match st {
                    "running" => member.state = "working".to_string(),
                    "error" => member.state = "stopped".to_string(),
                    "waiting" if member.state.is_empty() => member.state = "waiting".to_string(),
                    "idle" if member.state.is_empty() => member.state = "waiting".to_string(),
                    _ => {}
                }
            }
            if member.current_activity.is_none() {
                if let Some(child_items) = child.get("items").and_then(Value::as_array) {
                    let (_, latest) = summarize_run_progress(child_items);
                    if latest.is_some() {
                        member.current_activity = latest;
                    }
                }
            }
            if let Some(m) = child.get("model").and_then(Value::as_str) {
                member.model = Some(m.to_string());
            }
            if let Some(p) = child.get("provider").and_then(Value::as_str) {
                member.provider = Some(p.to_string());
            }
        }
    }

    serde_json::to_value(state).unwrap_or(json!({}))
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn register_swarm_worker_subagent_run(
    parent_thread_id: &str,
    child_thread_id: &str,
    member_name: &str,
    role: &str,
    provider: &str,
    model: Option<&str>,
    workspace_mode: Option<&str>,
    brief: &str,
) {
    let now = now_ms();
    let created = SubagentRun {
        subagent_id: child_thread_id.to_string(),
        parent_thread_id: parent_thread_id.to_string(),
        parent_tool_call_id: format!("swarm-member-{member_name}-{child_thread_id}"),
        role: role.to_string(),
        swarm_member_name: Some(member_name.to_string()),
        type_name: Some(provider.to_string()),
        provider: Some(provider.to_string()),
        model: model.map(str::to_string),
        workspace_mode: workspace_mode.map(str::to_string),
        prompt: Some(brief.to_string()),
        status: "running".to_string(),
        transcript_uri: None,
        child_thread_id: Some(child_thread_id.to_string()),
        latest_activity: None,
        step_count: 0,
        items: Vec::new(),
        started_at_unix_ms: now,
        updated_at_unix_ms: now,
        completed_at_unix_ms: None,
    };
    let Ok(val) = serde_json::to_value(created) else {
        return;
    };
    let mut emitted = None;
    if let Ok(mut all_threads) = threads().lock() {
        if let Some(parent) = all_threads
            .iter_mut()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(parent_thread_id))
        {
            if parent.get("subagentRuns").and_then(Value::as_array).is_none() {
                parent["subagentRuns"] = Value::Array(Vec::new());
            }
            if let Some(runs) = parent.get_mut("subagentRuns").and_then(Value::as_array_mut) {
                if !runs.iter().any(|r| {
                    r.get("childThreadId").and_then(Value::as_str) == Some(child_thread_id)
                        || r.get("subagentId").and_then(Value::as_str) == Some(child_thread_id)
                }) {
                    runs.push(val.clone());
                    emitted = Some(val);
                    touch(parent);
                }
            }
        }
    }
    if let Some(run) = emitted {
        emit_subagent_event(json!({
            "kind": "subagentRunUpdated",
            "threadId": parent_thread_id,
            "subagentId": run.get("subagentId"),
            "run": run,
        }));
    }
}

