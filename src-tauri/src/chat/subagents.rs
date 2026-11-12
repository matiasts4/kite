use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::acp::{
    build_acp_tool_call, extract_mentions, merge_subagent_meta, AcpStreamEvent, SubagentMeta,
    SwarmMeta,
};
use crate::chat::models::default_mode;
use crate::chat::runtime::{live_cv, live_turns, push_event};
use crate::chat::threads::{blank_thread, chat_item, touch, upsert_item};
use crate::chat::utils::now_ms;
use crate::persist::{persist, threads, workspace_path};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentRun {
    pub subagent_id: String,
    pub parent_thread_id: String,
    pub parent_tool_call_id: String,
    pub role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub type_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcript_uri: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub child_thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_activity: Option<String>,
    #[serde(default)]
    pub step_count: usize,
    #[serde(default)]
    pub items: Vec<Value>,
    pub started_at_unix_ms: i64,
    pub updated_at_unix_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at_unix_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwarmMember {
    pub name: String,
    pub role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_mode: Option<String>,
    pub state: String, // "waiting" | "working" | "stopped" | "killed"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_activity: Option<String>,
    #[serde(default)]
    pub channels: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub child_thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brief: Option<String>,
    #[serde(default)]
    pub last_read_seq: u64,
    #[serde(default)]
    pub pending_wake: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwarmBoardPost {
    pub seq: u64,
    pub author: String,
    pub channel: String,
    pub text: String,
    #[serde(default)]
    pub mentions: Vec<String>,
    pub created_at_unix_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwarmChannel {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub topic: Option<String>,
    #[serde(default)]
    pub archived: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwarmState {
    pub swarm_id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coordinator_model: Option<String>,
    #[serde(default)]
    pub members: Vec<SwarmMember>,
    #[serde(default)]
    pub posts: Vec<SwarmBoardPost>,
    #[serde(default)]
    pub channels: Vec<SwarmChannel>,
}

impl SwarmState {
    pub fn empty_for(thread_id: &str, coordinator_model: Option<String>) -> Self {
        Self {
            swarm_id: format!("swarm_{thread_id}"),
            title: "Swarm".to_string(),
            coordinator_model,
            members: Vec::new(),
            posts: Vec::new(),
            channels: vec![SwarmChannel {
                name: "main".to_string(),
                topic: None,
                archived: false,
            }],
        }
    }
}

pub fn emit_subagent_event(payload: Value) {
    if let Some(app) = crate::get_app_handle() {
        use tauri::Emitter;
        let _ = app.emit("chat-subagent-event", payload);
    } else {
        crate::core_daemon::broadcast_daemon_ui_event("chat-subagent-event", payload);
    }
}

pub fn emit_swarm_event(thread_id: &str, state: &SwarmState) {
    let payload = json!({
        "kind": "swarmStateUpdated",
        "threadId": thread_id,
        "swarmState": state,
    });
    if let Some(app) = crate::get_app_handle() {
        use tauri::Emitter;
        let _ = app.emit("chat-swarm-event", payload.clone());
    } else {
        crate::core_daemon::broadcast_daemon_ui_event("chat-swarm-event", payload.clone());
    }
    emit_subagent_event(payload);
}

pub fn resolve_local_transcript_path(uri: &str) -> Option<PathBuf> {
    let trimmed = uri.trim();
    if trimmed.is_empty() {
        return None;
    }
    let decoded = trimmed.replace("%20", " ").replace("%3A", ":").replace("%3a", ":");
    let stripped = if let Some(rest) = decoded.strip_prefix("file:///") {
        // Windows paths in file:///C:/... have a drive letter after the triple slash; POSIX needs leading /.
        if rest.chars().nth(1) == Some(':') {
            rest.to_string()
        } else {
            format!("/{rest}")
        }
    } else if let Some(rest) = decoded.strip_prefix("file://") {
        rest.to_string()
    } else {
        decoded
    };
    Some(PathBuf::from(stripped))
}

fn upsert_nested_item(list: &mut Vec<Value>, item: &Value) {
    let mut temp = json!({ "items": std::mem::take(list) });
    upsert_item(&mut temp, item);
    if let Some(arr) = temp.get_mut("items").and_then(|v| v.as_array_mut()) {
        *list = std::mem::take(arr);
    }
}

pub fn acp_tool_to_chat_item(tool: &crate::acp::AcpToolCall) -> Value {
    let is_streaming = tool.status == "running" || tool.status == "pending";
    let output_str = tool.output.as_deref().unwrap_or("");
    let mut item = chat_item(&tool.id, "tool", output_str, is_streaming);
    item["title"] = json!(if tool.title.is_empty() { tool.name.clone() } else { tool.title.clone() });
    item["detail"] = json!(tool.detail);
    item["status"] = json!(tool.status);
    item["toolName"] = json!(tool.name);
    item["toolKind"] = json!(tool.tool_kind);
    if let Some(ref srv) = tool.server_name {
        item["serverName"] = json!(srv);
    }
    if let Some(ref cmd) = tool.command {
        item["command"] = json!(cmd);
    }
    if let Some(ref fp) = tool.file_path {
        item["filePath"] = json!(fp);
    }
    if let Some(add) = tool.added_lines {
        item["addedLines"] = json!(add);
    }
    if let Some(rem) = tool.removed_lines {
        item["removedLines"] = json!(rem);
    }
    if let Some(dur) = tool.duration_seconds {
        item["durationSeconds"] = json!(dur);
    }
    if let Some(ref meta) = tool.subagent_meta {
        if let Ok(val) = serde_json::to_value(meta) {
            item["subagentMeta"] = val;
        }
    }
    if let Some(ref meta) = tool.swarm_meta {
        if let Ok(val) = serde_json::to_value(meta) {
            item["swarmMeta"] = val;
        }
    }
    if let Some(ref pid) = tool.parent_tool_use_id {
        item["parentToolUseId"] = json!(pid);
    }
    item
}

fn summarize_run_progress(items: &[Value]) -> (usize, Option<String>) {
    let step_count = items
        .iter()
        .filter(|it| {
            matches!(
                it.get("kind").and_then(Value::as_str),
                Some("tool" | "command" | "reasoning")
            )
        })
        .count();
    let latest_activity = items.iter().rev().find_map(|it| {
        let kind = it.get("kind").and_then(Value::as_str).unwrap_or("");
        if kind == "tool" || kind == "command" {
            it.get("title")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .map(|s| s.trim().chars().take(120).collect())
        } else if kind == "reasoning" || kind == "assistant" {
            it.get("text")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| s.lines().next().unwrap_or(s).chars().take(120).collect())
        } else {
            None
        }
    });
    (step_count, latest_activity)
}

pub fn parse_transcript_jsonl(content: &str, subagent_id: &str) -> Vec<Value> {
    let mut items: Vec<Value> = Vec::new();
    for (idx, line) in content.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(val) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        let step_type = val
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_uppercase();
        match step_type.as_str() {
            "USER_INPUT" => {
                let text = val.get("content").and_then(Value::as_str).unwrap_or("");
                if !text.trim().is_empty() {
                    let id = format!("sub_{subagent_id}_u_{idx}");
                    upsert_nested_item(&mut items, &chat_item(&id, "user", text, false));
                }
            }
            "PLANNER_RESPONSE" => {
                if let Some(thinking) = val.get("thinking").and_then(Value::as_str) {
                    if !thinking.trim().is_empty() {
                        let id = format!("sub_{subagent_id}_r_{idx}");
                        upsert_nested_item(
                            &mut items,
                            &chat_item(&id, "reasoning", thinking, false),
                        );
                    }
                }
                if let Some(tool_calls) = val.get("tool_calls").and_then(Value::as_array) {
                    for (t_idx, tc) in tool_calls.iter().enumerate() {
                        let raw_name = tc
                            .get("name")
                            .or_else(|| tc.get("tool_name"))
                            .and_then(Value::as_str)
                            .unwrap_or("tool");
                        let tc_id = tc
                            .get("id")
                            .or_else(|| tc.get("call_id"))
                            .and_then(Value::as_str)
                            .map(str::to_string)
                            .unwrap_or_else(|| format!("sub_{subagent_id}_t_{idx}_{t_idx}"));
                        let params = tc
                            .get("arguments")
                            .or_else(|| tc.get("parameters"))
                            .or_else(|| tc.get("input"))
                            .cloned()
                            .unwrap_or(Value::Null);
                        let output = tc.get("output").or_else(|| tc.get("result")).and_then(|v| {
                            v.as_str()
                                .map(str::to_string)
                                .or_else(|| (!v.is_null()).then(|| serde_json::to_string_pretty(v).ok()).flatten())
                        });
                        let status = tc
                            .get("status")
                            .and_then(Value::as_str)
                            .unwrap_or("completed")
                            .to_string();
                        let acp_tool = build_acp_tool_call(
                            tc_id,
                            raw_name,
                            params,
                            status,
                            output,
                            None,
                            None,
                            None,
                            None,
                            None,
                            None,
                            None,
                        );
                        upsert_nested_item(&mut items, &acp_tool_to_chat_item(&acp_tool));
                    }
                }
                if let Some(text) = val.get("content").and_then(Value::as_str) {
                    if !text.trim().is_empty() {
                        let id = format!("sub_{subagent_id}_a_{idx}");
                        upsert_nested_item(&mut items, &chat_item(&id, "assistant", text, false));
                    }
                }
            }
            _ => {
                // Fallback for Claude/ACP stream lines inside a local JSONL file.
                for item in parse_nested_frame_items(subagent_id, &format!("jsonl_{idx}"), &val) {
                    upsert_nested_item(&mut items, &item);
                }
            }
        }
    }
    items
}

fn active_tailers() -> &'static Mutex<HashSet<String>> {
    static SET: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    SET.get_or_init(|| Mutex::new(HashSet::new()))
}

pub fn sync_transcript_file(thread_id: &str, subagent_id: &str, uri: &str) -> Vec<Value> {
    let Some(path) = resolve_local_transcript_path(uri) else {
        return Vec::new();
    };
    let Ok(content) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    let parsed_items = parse_transcript_jsonl(&content, subagent_id);
    if parsed_items.is_empty() {
        return parsed_items;
    }

    let mut updated_run: Option<Value> = None;
    {
        let mut all_threads = threads().lock().unwrap();
        if let Some(thread) = all_threads
            .iter_mut()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(thread_id))
        {
            if let Some(runs) = thread.get_mut("subagentRuns").and_then(Value::as_array_mut) {
                if let Some(run) = runs.iter_mut().find(|r| {
                    r.get("subagentId").and_then(Value::as_str) == Some(subagent_id)
                }) {
                    let mut existing: Vec<Value> = run
                        .get("items")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    for item in &parsed_items {
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
                    sync_parent_tool_item_progress(
                        thread,
                        subagent_id,
                        step_count,
                        latest_activity.as_deref(),
                    );
                    touch(thread);
                }
            }
        }
    }

    if let Some(run) = updated_run {
        emit_subagent_event(json!({
            "kind": "subagentRunUpdated",
            "threadId": thread_id,
            "subagentId": subagent_id,
            "run": run,
        }));
    }
    parsed_items
}

fn spawn_transcript_tailer_if_needed(thread_id: &str, subagent_id: &str, uri: &str) {
    let Some(path) = resolve_local_transcript_path(uri) else {
        return;
    };
    if !path.exists() {
        return;
    }
    let key = format!("{thread_id}:{subagent_id}:{uri}");
    {
        let mut set = active_tailers().lock().unwrap();
        if set.contains(&key) {
            return;
        }
        set.insert(key.clone());
    }

    let thread_id = thread_id.to_string();
    let subagent_id = subagent_id.to_string();
    let uri = uri.to_string();
    thread::spawn(move || {
        let mut last_len: u64 = 0;
        let mut idle_ticks = 0u32;
        for _ in 0..1200 {
            if let Ok(meta) = fs::metadata(&path) {
                let len = meta.len();
                if len != last_len {
                    last_len = len;
                    idle_ticks = 0;
                    sync_transcript_file(&thread_id, &subagent_id, &uri);
                }
            }
            let still_running = {
                let list = threads().lock().unwrap();
                list.iter()
                    .find(|t| t.get("id").and_then(Value::as_str) == Some(thread_id.as_str()))
                    .and_then(|t| t.get("subagentRuns").and_then(Value::as_array))
                    .and_then(|runs| {
                        runs.iter()
                            .find(|r| r.get("subagentId").and_then(Value::as_str) == Some(subagent_id.as_str()))
                    })
                    .and_then(|r| r.get("status").and_then(Value::as_str))
                    .is_some_and(|s| s == "running" || s == "waiting")
            };
            if !still_running {
                idle_ticks += 1;
                if idle_ticks >= 2 {
                    break;
                }
            }
            thread::sleep(Duration::from_millis(250));
        }
        active_tailers().lock().unwrap().remove(&key);
    });
}

fn sync_parent_tool_item_progress(
    thread: &mut Value,
    subagent_id: &str,
    step_count: usize,
    latest_activity: Option<&str>,
) -> Option<Value> {
    let items = thread.get_mut("items")?.as_array_mut()?;
    let target = items.iter_mut().find(|it| {
        it.pointer("/subagentMeta/subagentId").and_then(Value::as_str) == Some(subagent_id)
            || it.get("id").and_then(Value::as_str) == Some(subagent_id)
    })?;
    if let Some(meta) = target.get_mut("subagentMeta").and_then(Value::as_object_mut) {
        meta.insert("stepCount".to_string(), json!(step_count));
        if let Some(latest) = latest_activity {
            meta.insert("latestActivity".to_string(), json!(latest));
        }
    }
    Some(target.clone())
}

pub fn record_subagent_tool_call(thread_id: &str, tool_item: &Value) {
    let Some(meta_val) = tool_item.get("subagentMeta") else {
        return;
    };
    let Ok(meta) = serde_json::from_value::<SubagentMeta>(meta_val.clone()) else {
        return;
    };
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
                r.get("subagentId").and_then(Value::as_str) == Some(meta.subagent_id.as_str())
                    || r.get("parentToolCallId").and_then(Value::as_str) == Some(tool_call_id.as_str())
            });
            let is_terminal = matches!(meta.status.as_str(), "completed" | "failed" | "killed");
            if let Some(idx) = pos {
                let run = &mut runs[idx];
                let existing_meta = serde_json::from_value::<SubagentMeta>(run.clone()).ok();
                let merged = merge_subagent_meta(existing_meta.as_ref(), meta.clone());
                run["subagentId"] = json!(merged.subagent_id);
                run["parentToolCallId"] = json!(tool_call_id);
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

fn parse_nested_frame_items(subagent_id: &str, id_hint: &str, frame: &Value) -> Vec<Value> {
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

    if let Some(cid) = child_tid {
        if let Some(child) = all_threads
            .iter()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(cid.as_str()))
        {
            if let Some(child_items) = child.get("items").and_then(Value::as_array) {
                if !child_items.is_empty() {
                    run["items"] = Value::Array(child_items.clone());
                    let (steps, latest) = summarize_run_progress(child_items);
                    run["stepCount"] = json!(steps);
                    if let Some(l) = latest {
                        run["latestActivity"] = json!(l);
                    }
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
                    let (steps, latest) = summarize_run_progress(&items);
                    run["items"] = Value::Array(items);
                    run["stepCount"] = json!(steps);
                    if let Some(l) = latest {
                        run["latestActivity"] = json!(l);
                    }
                }
            }
        }
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
                member.state = match st {
                    "running" => "working".to_string(),
                    "waiting" | "idle" => "waiting".to_string(),
                    _ => "stopped".to_string(),
                };
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

#[derive(Debug, Clone)]
pub struct ChildSubagentSpawnParams {
    pub parent_thread_id: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub role: Option<String>,
    pub workspace_mode: String,
    pub fallback_cwd: Option<String>,
    pub task: String,
}

#[derive(Debug, Clone)]
pub struct ChildSubagentSpawnResult {
    pub child_thread_id: String,
    pub provider: String,
    pub model: Option<String>,
    pub working_directory: Option<String>,
}

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

fn remembered_provider_defaults(provider: &str) -> (Option<String>, Option<String>) {
    let Ok(all) = threads().lock() else {
        return (None, None);
    };
    let mut best_ts: i64 = -1;
    let mut best_model: Option<String> = None;
    let mut best_effort: Option<String> = None;
    for t in all.iter() {
        let Some(p) = t.get("provider").and_then(Value::as_str) else {
            continue;
        };
        if !p.eq_ignore_ascii_case(provider) {
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

    let tool_call_id = format!("dispatch-subagent-{child_id}");
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
        (
            parent_tid,
            child_status,
            child_items,
            child_model,
            child_provider,
        )
    };

    let (parent_tid, child_status, child_items, child_model, child_provider) = snapshot;
    let (step_count, latest_activity) = summarize_run_progress(&child_items);
    let run_status = if crate::dispatch_wire::protocol::is_thread_killed(child_thread_id) {
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
    let mut updated_tool_item: Option<Value> = None;

    {
        let Ok(mut all_threads) = threads().lock() else {
            return;
        };
        if let Some(parent) = all_threads
            .iter_mut()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(parent_tid.as_str()))
        {
            let mut matched_sub_id: Option<String> = None;
            if let Some(runs) = parent.get_mut("subagentRuns").and_then(Value::as_array_mut) {
                if let Some(run) = runs.iter_mut().find(|r| {
                    r.get("childThreadId").and_then(Value::as_str) == Some(child_thread_id)
                        || r.get("subagentId").and_then(Value::as_str) == Some(child_thread_id)
                }) {
                    matched_sub_id = run
                        .get("subagentId")
                        .and_then(Value::as_str)
                        .map(str::to_string);
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
                    if is_terminal && run.get("completedAtUnixMs").is_none_or(Value::is_null) {
                        run["completedAtUnixMs"] = json!(now);
                    }
                    emitted_run = Some(run.clone());
                }
            }
            if let Some(items) = parent.get_mut("items").and_then(Value::as_array_mut) {
                if let Some(target) = items.iter_mut().find(|it| {
                    it.pointer("/subagentMeta/childThreadId").and_then(Value::as_str)
                        == Some(child_thread_id)
                        || it.pointer("/subagentMeta/subagentId").and_then(Value::as_str)
                            == Some(matched_sub_id.as_deref().unwrap_or(child_thread_id))
                }) {
                    target["status"] = json!(tool_status);
                    if let Some(meta) = target
                        .get_mut("subagentMeta")
                        .and_then(Value::as_object_mut)
                    {
                        meta.insert("status".to_string(), json!(run_status));
                        meta.insert("stepCount".to_string(), json!(step_count));
                        if let Some(ref latest) = latest_activity {
                            meta.insert("latestActivity".to_string(), json!(latest));
                        }
                        if let Some(ref m) = child_model {
                            meta.insert("model".to_string(), json!(m));
                        }
                        if let Some(ref p) = child_provider {
                            meta.insert("provider".to_string(), json!(p));
                        }
                    }
                    updated_tool_item = Some(target.clone());
                }
            }
            touch(parent);
        }
    }

    if let Some(tool_item) = updated_tool_item {
        if let Ok(mut live) = live_turns().lock() {
            if let Some(run_id) = live.by_thread.get(&parent_tid).cloned() {
                if let Some(run) = live.runs.get_mut(&run_id) {
                    push_event(run, json!({ "kind": "upsert", "item": tool_item }));
                }
            }
        }
        live_cv().notify_all();
    }

    if let Some(run) = emitted_run {
        emit_subagent_event(json!({
            "kind": "subagentRunUpdated",
            "threadId": parent_tid,
            "subagentId": run.get("subagentId"),
            "run": run,
        }));
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

pub fn format_subagent_wait_output(response_text: &str, child_thread_id: &str) -> String {
    let trimmed = response_text.trim();
    if trimmed.is_empty() {
        format!("[subagent_id: thread:{child_thread_id}]")
    } else {
        format!("{trimmed}\n\n[subagent_id: thread:{child_thread_id}]")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::threads::{blank_thread, remove_thread};

    struct CleanupThread(String);
    impl Drop for CleanupThread {
        fn drop(&mut self) {
            remove_thread(&self.0);
        }
    }

    #[test]
    fn parses_local_transcript_jsonl_into_canonical_chat_items() {
        let content = concat!(
            r#"{"type":"USER_INPUT","content":"Check RightDock responsiveness"}"#, "\n",
            r#"{"type":"PLANNER_RESPONSE","thinking":"Inspecting dockConfig","tool_calls":[{"id":"tc-1","name":"read_file","arguments":{"path":"src/components/RightDock.tsx"},"status":"completed"}],"content":"RightDock uses clamp widths."}"#, "\n"
        );
        let items = parse_transcript_jsonl(content, "sub-jsonl-1");
        assert_eq!(items.len(), 4);
        assert_eq!(items[0]["kind"], "user");
        assert_eq!(items[1]["kind"], "reasoning");
        assert_eq!(items[2]["kind"], "tool");
        assert_eq!(items[2]["filePath"], "src/components/RightDock.tsx");
        assert_eq!(items[3]["kind"], "assistant");
    }

    #[test]
    fn routes_parent_tool_use_id_frames_into_nested_subagent_run() {
        let tid = format!("subagent-nest-{}", uuid::Uuid::new_v4().simple());
        let _cleanup = CleanupThread(tid.clone());
        let thread = blank_thread(&tid, None, "Main Thread", "claude", None);
        threads().lock().unwrap().push(thread);

        let parent_tool = build_acp_tool_call(
            "toolu_task_1".to_string(),
            "Task",
            json!({
                "description": "Codebase Explorer",
                "prompt": "Find dock config",
                "subagent_type": "Explore",
                "model": "haiku"
            }),
            "running".to_string(),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        );
        let parent_item = acp_tool_to_chat_item(&parent_tool);
        {
            let mut list = threads().lock().unwrap();
            let t = list.iter_mut().find(|t| t["id"] == tid).unwrap();
            upsert_item(t, &parent_item);
        }
        record_subagent_tool_call(&tid, &parent_item);

        let nested_tool = json!({
            "type": "assistant",
            "parent_tool_use_id": "toolu_task_1",
            "message": {
                "content": [{
                    "type": "tool_use",
                    "id": "toolu_inner_1",
                    "name": "read_file",
                    "input": { "file_path": "src/components/dock/dockConfig.tsx" }
                }]
            }
        });
        assert!(ingest_nested_subagent_frame(
            &tid,
            "run-1",
            "toolu_task_1",
            &nested_tool
        ));

        let detail = build_subagent_detail(&tid, "toolu_task_1").expect("detail");
        assert_eq!(detail["role"], "Codebase Explorer");
        assert_eq!(detail["stepCount"], 1);
        assert_eq!(detail["items"].as_array().unwrap().len(), 1);
        assert_eq!(detail["items"][0]["filePath"], "src/components/dock/dockConfig.tsx");

        // Parent thread must NOT have the nested inner tool flattened into its top-level items!
        let list = threads().lock().unwrap();
        let parent = list.iter().find(|t| t["id"] == tid).unwrap();
        assert_eq!(parent["items"].as_array().unwrap().len(), 1);
        assert_eq!(parent["items"][0]["subagentMeta"]["stepCount"], 1);
    }

    #[test]
    fn records_swarm_state_channels_members_and_mentions() {
        let tid = format!("swarm-state-{}", uuid::Uuid::new_v4().simple());
        let _cleanup = CleanupThread(tid.clone());
        let mut thread = blank_thread(&tid, None, "Main", "antigravity", None);
        thread["model"] = json!("claude-opus-4-6");
        threads().lock().unwrap().push(thread);

        let title_tool = acp_tool_to_chat_item(&build_acp_tool_call(
            "sw-1".into(),
            "swarm",
            json!({ "action": "title", "title": "Parser Rewrite" }),
            "completed".into(),
            None, None, None, None, None, None, None, None,
        ));
        record_swarm_tool_call(&tid, &title_tool);

        let add_tool = acp_tool_to_chat_item(&build_acp_tool_call(
            "sw-2".into(),
            "swarm",
            json!({
                "action": "add",
                "name": "verifier",
                "model": "flash",
                "workspace": "share",
                "brief": "Audit parser invariants"
            }),
            "completed".into(),
            None, None, None, None, None, None, None, None,
        ));
        record_swarm_tool_call(&tid, &add_tool);

        let post_tool = acp_tool_to_chat_item(&build_acp_tool_call(
            "sw-3".into(),
            "post_message",
            json!({ "channel": "parser", "message": "@verifier check #1" }),
            "completed".into(),
            None, None, None, None, None, None, None, None,
        ));
        record_swarm_tool_call(&tid, &post_tool);

        let state = build_swarm_state(&tid);
        assert_eq!(state["title"], "Parser Rewrite");
        assert_eq!(state["coordinatorModel"], "claude-opus-4-6");
        assert_eq!(state["members"][0]["name"], "verifier");
        assert_eq!(state["members"][0]["state"], "working");
        assert_eq!(state["posts"][0]["seq"], 1);
        assert_eq!(state["posts"][0]["channel"], "parser");
        assert_eq!(state["posts"][0]["mentions"][0], "@verifier");
    }
}
