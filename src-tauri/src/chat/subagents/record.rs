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

pub fn record_subagent_tool_call(thread_id: &str, tool_item: &Value) {
    let Some(meta_val) = tool_item.get("subagentMeta") else {
        return;
    };
    let Ok(mut meta) = serde_json::from_value::<SubagentMeta>(meta_val.clone()) else {
        return;
    };
    let item_status = tool_item
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or(meta.status.as_str());
    let item_text = tool_item.get("text").and_then(Value::as_str);
    if meta.status != "killed"
        && crate::acp::response_indicates_failure(item_status, Some(tool_item), None, item_text)
    {
        meta.status = "failed".to_string();
    }
    let tool_call_id = tool_item
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or(&meta.subagent_id)
        .to_string();
    let now = now_ms();
    let mut emitted_run: Option<Value> = None;
    let mut uri_to_sync: Option<(String, String, bool)> = None;

    {
        let mut all_threads = threads().lock().unwrap();
        if let Some(thread) = all_threads
            .iter_mut()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(thread_id))
        {
            if thread.get("subagentRuns").and_then(Value::as_array).is_none() {
                thread["subagentRuns"] = Value::Array(Vec::new());
            }
            let parent_provider = thread
                .get("provider")
                .and_then(Value::as_str)
                .map(str::to_string);
            let runs = thread["subagentRuns"].as_array_mut().unwrap();
            let pos = runs.iter().position(|r| {
                let r_cid = r.get("childThreadId").and_then(Value::as_str);
                let r_call = r
                    .get("parentToolCallId")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let r_is_terminal = matches!(
                    r.get("status").and_then(Value::as_str),
                    Some("completed" | "failed" | "killed")
                );
                let role_or_prompt_matches = (meta.prompt.as_deref().is_some_and(|p| {
                    !p.trim().is_empty()
                        && r.get("prompt").and_then(Value::as_str).map(str::trim) == Some(p.trim())
                })) || (!meta.role.is_empty()
                    && r.get("role").and_then(Value::as_str) == Some(meta.role.as_str()));

                r.get("subagentId").and_then(Value::as_str) == Some(meta.subagent_id.as_str())
                    || r_call == tool_call_id.as_str()
                    || (meta.child_thread_id.is_some()
                        && r_cid == meta.child_thread_id.as_deref())
                    || (!r_is_terminal
                        && r_cid.is_none()
                        && meta.child_thread_id.is_some()
                        && role_or_prompt_matches
                        && (tool_call_id.starts_with("dispatch-subagent-")
                            || r_call.is_empty()
                            || r_call.starts_with("dispatch-subagent-")
                            || r_call == tool_call_id.as_str()))
                    || (!r_is_terminal
                        && r_cid.is_some()
                        && meta.child_thread_id.is_none()
                        && role_or_prompt_matches
                        && (r_call.is_empty()
                            || r_call.starts_with("dispatch-subagent-")
                            || r_call == tool_call_id.as_str()))
            });
            let is_terminal = matches!(meta.status.as_str(), "completed" | "failed" | "killed");
            if let Some(idx) = pos {
                let run = &mut runs[idx];
                let existing_meta = serde_json::from_value::<SubagentMeta>(run.clone()).ok();
                let merged = merge_subagent_meta(existing_meta.as_ref(), meta.clone());
                run["subagentId"] = json!(merged.subagent_id);
                if !tool_call_id.starts_with("dispatch-subagent-")
                    || run
                        .get("parentToolCallId")
                        .and_then(Value::as_str)
                        .is_none_or(str::is_empty)
                {
                    run["parentToolCallId"] = json!(tool_call_id);
                }
                run["role"] = json!(merged.role);
                if let Some(ref t) = merged.type_name {
                    run["typeName"] = json!(t);
                }
                if let Some(ref p) = merged.provider.or(parent_provider) {
                    run["provider"] = json!(p);
                }
                if let Some(ref m) = merged.model {
                    run["model"] = json!(m);
                }
                if let Some(ref w) = merged.workspace_mode {
                    run["workspaceMode"] = json!(w);
                }
                if let Some(ref pr) = merged.prompt {
                    run["prompt"] = json!(pr);
                }
                run["status"] = json!(merged.status);
                if let Some(ref uri) = merged.transcript_uri {
                    run["transcriptUri"] = json!(uri);
                    uri_to_sync = Some((merged.subagent_id.clone(), uri.clone(), !is_terminal));
                }
                if let Some(ref ctid) = merged.child_thread_id {
                    run["childThreadId"] = json!(ctid);
                }
                if let Some(ref latest) = merged.latest_activity {
                    run["latestActivity"] = json!(latest);
                }
                let existing_steps = run.get("stepCount").and_then(Value::as_u64).unwrap_or(0) as usize;
                run["stepCount"] = json!(existing_steps.max(merged.step_count));
                run["updatedAtUnixMs"] = json!(now);
                if is_terminal && run.get("completedAtUnixMs").is_none_or(Value::is_null) {
                    run["completedAtUnixMs"] = json!(now);
                }
                emitted_run = Some(run.clone());
            } else {
                let sub_id = meta.subagent_id.clone();
                if let Some(ref uri) = meta.transcript_uri {
                    uri_to_sync = Some((sub_id.clone(), uri.clone(), !is_terminal));
                }
                let created = SubagentRun {
                    subagent_id: meta.subagent_id.clone(),
                    parent_thread_id: thread_id.to_string(),
                    parent_tool_call_id: tool_call_id,
                    role: meta.role.clone(),
                    swarm_member_name: None,
                    type_name: meta.type_name.clone(),
                    provider: meta.provider.clone().or(parent_provider),
                    model: meta.model.clone(),
                    workspace_mode: meta.workspace_mode.clone(),
                    prompt: meta.prompt.clone(),
                    status: meta.status.clone(),
                    transcript_uri: meta.transcript_uri.clone(),
                    child_thread_id: meta.child_thread_id.clone(),
                    latest_activity: meta.latest_activity.clone(),
                    step_count: meta.step_count,
                    items: Vec::new(),
                    started_at_unix_ms: now,
                    updated_at_unix_ms: now,
                    completed_at_unix_ms: if is_terminal { Some(now) } else { None },
                };
                if let Ok(val) = serde_json::to_value(created) {
                    runs.push(val.clone());
                    emitted_run = Some(val);
                }
            }
            reconcile_duplicate_subagent_state(thread);
            touch(thread);
        }
    }

    if let Some((sub_id, uri, running)) = uri_to_sync {
        sync_transcript_file(thread_id, &sub_id, &uri);
        if running {
            spawn_transcript_tailer_if_needed(thread_id, &sub_id, &uri);
        }
    }

    if let Some(run) = emitted_run {
        emit_subagent_event(json!({
            "kind": "subagentRunUpdated",
            "threadId": thread_id,
            "subagentId": run.get("subagentId"),
            "run": run,
        }));
    }
}

pub fn record_swarm_tool_call(thread_id: &str, tool_item: &Value) -> Option<Value> {
    let meta_val = tool_item.get("swarmMeta")?;
    let meta = serde_json::from_value::<SwarmMeta>(meta_val.clone()).ok()?;
    let now = now_ms();
    let mut updated_state: Option<Value> = None;

    {
        let mut all_threads = threads().lock().unwrap();
        if let Some(thread) = all_threads
            .iter_mut()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(thread_id))
        {
            let coordinator_model = thread
                .get("model")
                .and_then(Value::as_str)
                .map(str::to_string);
            let mut state: SwarmState = thread
                .get("swarmState")
                .and_then(|v| serde_json::from_value::<SwarmState>(v.clone()).ok())
                .unwrap_or_else(|| SwarmState::empty_for(thread_id, coordinator_model.clone()));
            if state.coordinator_model.is_none() {
                state.coordinator_model = coordinator_model;
            }
            if let Some(ref sid) = meta.swarm_id {
                state.swarm_id = sid.clone();
            }

            let target_channel = meta.channel.clone().unwrap_or_else(|| "main".to_string());
            if !target_channel.is_empty()
                && !state.channels.iter().any(|c| c.name == target_channel)
            {
                state.channels.push(SwarmChannel {
                    name: target_channel.clone(),
                    topic: None,
                    archived: false,
                });
            }

            match meta.action.as_str() {
                "title" => {
                    if let Some(ref title) = meta.swarm_title {
                        if !title.trim().is_empty() {
                            state.title = title.trim().to_string();
                        }
                    }
                }
                "channel" => {
                    // Ensure channel entry already inserted above; nothing else needed.
                }
                "add" => {
                    let names: Vec<String> = if !meta.member_names.is_empty() {
                        meta.member_names.clone()
                    } else if let Some(ref m) = meta.member_name {
                        vec![m.clone()]
                    } else {
                        Vec::new()
                    };
                    for name in names {
                        if let Some(existing) = state.members.iter_mut().find(|m| m.name == name) {
                            if meta.model.is_some() {
                                existing.model = meta.model.clone();
                            }
                            if meta.workspace_mode.is_some() {
                                existing.workspace_mode = meta.workspace_mode.clone();
                            }
                            if meta.brief.is_some() {
                                existing.brief = meta.brief.clone();
                            }
                            if existing.state == "stopped" {
                                existing.state = "waiting".to_string();
                            }
                            if !existing.channels.contains(&target_channel) {
                                existing.channels.push(target_channel.clone());
                            }
                        } else {
                            let role = meta
                                .brief
                                .as_deref()
                                .and_then(|b| b.lines().next())
                                .map(|l| l.trim().chars().take(72).collect::<String>())
                                .filter(|s| !s.is_empty())
                                .unwrap_or_else(|| format!("@{name}"));
                            state.members.push(SwarmMember {
                                name,
                                role,
                                provider: thread
                                    .get("provider")
                                    .and_then(Value::as_str)
                                    .map(str::to_string),
                                model: meta.model.clone(),
                                effort: None,
                                workspace_mode: meta.workspace_mode.clone(),
                                state: "waiting".to_string(),
                                current_activity: None,
                                channels: vec![target_channel.clone()],
                                subagent_id: None,
                                child_thread_id: None,
                                brief: meta.brief.clone(),
                                last_read_seq: 0,
                                pending_wake: false,
                            });
                        }
                    }
                }
                "model" => {
                    if let Some(ref member_name) = meta.member_name {
                        if let Some(member) = state.members.iter_mut().find(|m| &m.name == member_name)
                        {
                            member.model = meta.model.clone();
                        }
                    } else if meta.model.is_some() {
                        state.coordinator_model = meta.model.clone();
                    }
                }
                "kill" => {
                    if let Some(ref member_name) = meta.member_name {
                        if let Some(member) = state.members.iter_mut().find(|m| &m.name == member_name)
                        {
                            member.state = "killed".to_string();
                        }
                    }
                }
                "post_message" => {
                    if let Some(ref text) = meta.post_text {
                        let next_seq = meta
                            .seq
                            .unwrap_or_else(|| state.posts.last().map(|p| p.seq + 1).unwrap_or(1));
                        if !state.posts.iter().any(|p| p.seq == next_seq) {
                            let author = meta
                                .member_name
                                .clone()
                                .unwrap_or_else(|| "coordinator".to_string());
                            let mentions = if meta.mentions.is_empty() {
                                extract_mentions(text)
                            } else {
                                meta.mentions.clone()
                            };
                            for mention in &mentions {
                                let name = mention.trim_start_matches('@');
                                if name == "all" {
                                    for m in &mut state.members {
                                        if m.state == "waiting" {
                                            m.state = "working".to_string();
                                        }
                                    }
                                } else if let Some(member) =
                                    state.members.iter_mut().find(|m| m.name == name)
                                {
                                    if member.state != "killed" {
                                        member.state = "working".to_string();
                                    }
                                }
                            }
                            state.posts.push(SwarmBoardPost {
                                seq: next_seq,
                                author,
                                channel: target_channel,
                                text: text.clone(),
                                mentions,
                                created_at_unix_ms: now,
                            });
                        }
                        if meta.seq.is_none() {
                            if let Some(item_id) = tool_item.get("id").and_then(Value::as_str) {
                                if let Some(items) = thread.get_mut("items").and_then(Value::as_array_mut) {
                                    if let Some(stored) = items.iter_mut().find(|it| it.get("id").and_then(Value::as_str) == Some(item_id)) {
                                        if let Some(meta_obj) = stored.get_mut("swarmMeta").and_then(Value::as_object_mut) {
                                            meta_obj.insert("seq".to_string(), json!(next_seq));
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                _ => {}
            }

            if let Ok(state_val) = serde_json::to_value(&state) {
                thread["swarmState"] = state_val.clone();
                touch(thread);
                updated_state = Some(state_val);
            }
        }
    }

    if let Some(ref state_val) = updated_state {
        emit_subagent_event(json!({
            "kind": "swarmStateUpdated",
            "threadId": thread_id,
            "swarmState": state_val,
        }));
    }
    updated_state
}

