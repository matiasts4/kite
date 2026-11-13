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


pub(super) fn upsert_nested_item(list: &mut Vec<Value>, item: &Value) {
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
    let resolved_detail = if tool.tool_kind == "subagent"
        && (tool.detail.trim_start().starts_with('$') || tool.detail.contains("kite dispatch"))
    {
        tool.subagent_meta
            .as_ref()
            .and_then(|m| m.prompt.clone())
            .unwrap_or_default()
    } else {
        tool.detail.clone()
    };
    item["detail"] = json!(resolved_detail);
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

pub fn filter_subagent_stream_items(items: &[Value], initial_prompt: Option<&str>) -> Vec<Value> {
    items
        .iter()
        .enumerate()
        .filter(|(idx, it)| {
            let kind = it.get("kind").and_then(Value::as_str).unwrap_or("");
            if kind == "notice" || kind == "note" {
                return false;
            }
            if *idx == 0 && kind == "user" {
                let text = it.get("text").and_then(Value::as_str).unwrap_or("").trim();
                if text.starts_with("[Subagent Role:")
                    || initial_prompt
                        .map(str::trim)
                        .filter(|p| !p.is_empty())
                        .is_some_and(|p| text == p)
                {
                    return false;
                }
            }
            true
        })
        .map(|(_, it)| it.clone())
        .collect()
}

pub(super) fn summarize_run_progress(items: &[Value]) -> (usize, Option<String>) {
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

