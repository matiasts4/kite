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
    build_acp_tool_call, extract_mentions, merge_subagent_meta, merge_swarm_meta, AcpStreamEvent,
    SubagentMeta, SwarmMeta,
};
use crate::chat::models::default_mode;
use crate::chat::runtime::{live_cv, live_turns, push_event};
use crate::chat::threads::{blank_thread, chat_item, touch, upsert_item};
use crate::chat::utils::now_ms;
use crate::persist::{persist, threads, workspace_path};

pub fn emit_subagent_event(mut payload: Value) {
    slim_run_update_payload(&mut payload);
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


/// Run updates only carry run metadata for runs whose step transcript lives in a child
/// thread or transcript file; the renderer hydrates steps from `subagentStepsUpdated`
/// deltas or `get_thread_subagent_detail`.
fn slim_run_update_payload(payload: &mut Value) {
    if payload.get("kind").and_then(Value::as_str) != Some("subagentRunUpdated") {
        return;
    }
    if let Some(run) = payload.get_mut("run") {
        strip_external_run_items(run);
    }
}

type StepFingerprints = std::collections::HashMap<String, std::collections::HashMap<String, u64>>;

#[cfg(test)]
pub(super) fn emit_slim_for_test(payload: &mut Value) {
    slim_run_update_payload(payload);
}

const STEP_FINGERPRINT_MAX_RUNS: usize = 128;

fn step_fingerprints() -> &'static Mutex<StepFingerprints> {
    static CELL: OnceLock<Mutex<StepFingerprints>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(StepFingerprints::new()))
}

fn step_item_fingerprint(item: &Value) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    item.to_string().hash(&mut hasher);
    hasher.finish()
}

/// Returns only the step items that are new or changed since the previous emission for
/// this run, so each progress event stops re-serializing the whole accumulated transcript.
/// Settled runs drop their fingerprints so the cache stays bounded.
pub(super) fn delta_step_items(
    thread_id: &str,
    subagent_id: &str,
    items: &[Value],
    settled: bool,
) -> Vec<Value> {
    let key = format!("{thread_id}:{subagent_id}");
    let mut cache = step_fingerprints().lock().unwrap();
    if cache.len() >= STEP_FINGERPRINT_MAX_RUNS && !cache.contains_key(&key) {
        cache.clear();
    }
    let seen = cache.entry(key.clone()).or_default();
    let mut delta = Vec::new();
    for (idx, item) in items.iter().enumerate() {
        let id = item
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("#{idx}"));
        let fingerprint = step_item_fingerprint(item);
        if seen.get(&id) != Some(&fingerprint) {
            seen.insert(id, fingerprint);
            delta.push(item.clone());
        }
    }
    if settled {
        cache.remove(&key);
    }
    delta
}

pub(super) fn emit_subagent_steps_event(thread_id: &str, subagent_id: &str, run: &Value) {
    let settled = matches!(
        run.get("status").and_then(Value::as_str),
        Some("completed" | "failed" | "killed")
    );
    let all_items: &[Value] = run
        .get("items")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let delta = delta_step_items(thread_id, subagent_id, all_items, settled);
    emit_subagent_event(json!({
        "kind": "subagentStepsUpdated",
        "threadId": thread_id,
        "subagentId": subagent_id,
        "childThreadId": run.get("childThreadId").cloned().unwrap_or(Value::Null),
        "items": delta,
        "itemsDelta": true,
        "stepCount": run.get("stepCount").cloned().unwrap_or_else(|| json!(0)),
        "latestActivity": run.get("latestActivity").cloned().unwrap_or(Value::Null),
        "status": run.get("status").cloned().unwrap_or_else(|| json!("running")),
        "model": run.get("model").cloned().unwrap_or(Value::Null),
        "provider": run.get("provider").cloned().unwrap_or(Value::Null),
    }));
}

pub(super) fn emit_subagent_runs_removed(thread_id: &str, removed: Vec<(String, String)>) {
    for (sid, ptc) in removed {
        emit_subagent_event(json!({
            "kind": "subagentRunRemoved",
            "threadId": thread_id,
            "subagentId": (!sid.is_empty()).then_some(sid),
            "parentToolCallId": (!ptc.is_empty()).then_some(ptc),
        }));
    }
}

pub fn is_generic_tool_field(key: &str, val: &str) -> bool {
    let trimmed = val.trim();
    if trimmed.is_empty()
        || trimmed.eq_ignore_ascii_case("tool")
        || trimmed.eq_ignore_ascii_case("dynamictoolcall")
    {
        return true;
    }
    match key {
        "toolKind" => matches!(trimmed, "dynamicToolCall" | "unknown" | "other"),
        "title" => trimmed.eq_ignore_ascii_case("dynamic tool call"),
        _ => false,
    }
}

pub(super) fn upsert_nested_item(list: &mut Vec<Value>, item: &Value) {
    let mut normalized = item.clone();
    let append_delta = normalized
        .as_object_mut()
        .and_then(|obj| obj.remove("_appendDelta"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let kind = normalized
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    if kind == "tool" || kind == "command" {
        for prev in list.iter_mut() {
            if matches!(
                prev.get("kind").and_then(Value::as_str),
                Some("assistant" | "reasoning")
            ) && prev.get("streaming").and_then(Value::as_bool) == Some(true)
            {
                prev["streaming"] = json!(false);
            }
        }
    }

    let has_intervening_tool = |from_idx: usize| -> bool {
        list.get(from_idx + 1..)
            .unwrap_or(&[])
            .iter()
            .any(|later| {
                matches!(
                    later.get("kind").and_then(Value::as_str),
                    Some("tool" | "command")
                )
            })
    };

    if append_delta && matches!(kind.as_str(), "assistant" | "reasoning") {
        let delta = normalized.get("text").and_then(Value::as_str).unwrap_or("");
        if delta.is_empty() {
            return;
        }
        let target_id = normalized
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("");
        let seg_prefix = format!("{target_id}#seg");
        let is_unkeyed_stream = target_id.ends_with("_stream_msg")
            || target_id.ends_with("_stream_thought");
        let existing_pos = if !is_unkeyed_stream && !target_id.is_empty() {
            list.iter().rposition(|ex| {
                let ex_id = ex.get("id").and_then(Value::as_str).unwrap_or("");
                (ex_id == target_id || ex_id.starts_with(&seg_prefix))
                    && ex.get("kind").and_then(Value::as_str) == Some(kind.as_str())
                    && ex.get("streaming").and_then(Value::as_bool) == Some(true)
            })
            .filter(|&pos| !has_intervening_tool(pos))
        } else {
            list.last()
                .filter(|ex| {
                    ex.get("kind").and_then(Value::as_str) == Some(kind.as_str())
                        && ex.get("streaming").and_then(Value::as_bool) == Some(true)
                })
                .map(|_| list.len() - 1)
        };
        if let Some(pos) = existing_pos {
            let slot = &mut list[pos];
            let existing_text = slot.get("text").and_then(Value::as_str).unwrap_or("");
            slot["text"] = json!(format!("{existing_text}{delta}"));
            if let Some(streaming) = normalized.get("streaming").and_then(Value::as_bool) {
                slot["streaming"] = json!(streaming);
            }
            return;
        }
        if is_unkeyed_stream
            || (!target_id.is_empty()
                && list.iter().any(|ex| {
                    let ex_id = ex.get("id").and_then(Value::as_str).unwrap_or("");
                    ex_id == target_id || ex_id.starts_with(&seg_prefix)
                }))
        {
            normalized["id"] = json!(format!("{target_id}#seg{}", list.len()));
        }
        list.push(normalized);
        return;
    }

    let id = normalized
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let seg_prefix = format!("{id}#seg");
    if let Some(pos) = list.iter().rposition(|ex| {
        if id.is_empty() {
            return false;
        }
        let ex_id = ex.get("id").and_then(Value::as_str).unwrap_or("");
        ex_id == id || ex_id.starts_with(&seg_prefix)
    }) {
        if matches!(kind.as_str(), "assistant" | "reasoning") && has_intervening_tool(pos) {
            normalized["id"] = json!(format!("{id}#seg{}", list.len()));
            list.push(normalized);
            return;
        }
        let slot = &mut list[pos];
        if let (Some(ex_obj), Some(new_obj)) = (slot.as_object_mut(), normalized.as_object()) {
            for (k, v) in new_obj {
                if v.is_null() {
                    continue;
                }
                if let Some(new_str) = v.as_str() {
                    if is_generic_tool_field(k, new_str)
                        && ex_obj
                            .get(k)
                            .and_then(Value::as_str)
                            .is_some_and(|old| !is_generic_tool_field(k, old))
                    {
                        continue;
                    }
                }
                if k == "subagentMeta" {
                    if let (Some(old_sub), Some(new_sub)) = (
                        ex_obj
                            .get("subagentMeta")
                            .and_then(|val| serde_json::from_value::<SubagentMeta>(val.clone()).ok()),
                        serde_json::from_value::<SubagentMeta>(v.clone()).ok(),
                    ) {
                        if let Ok(merged) = serde_json::to_value(merge_subagent_meta(Some(&old_sub), new_sub)) {
                            ex_obj.insert(k.clone(), merged);
                            continue;
                        }
                    }
                }
                if k == "swarmMeta" {
                    if let (Some(old_swarm), Some(new_swarm)) = (
                        ex_obj
                            .get("swarmMeta")
                            .and_then(|val| serde_json::from_value::<SwarmMeta>(val.clone()).ok()),
                        serde_json::from_value::<SwarmMeta>(v.clone()).ok(),
                    ) {
                        if let Ok(merged) = serde_json::to_value(merge_swarm_meta(Some(&old_swarm), new_swarm)) {
                            ex_obj.insert(k.clone(), merged);
                            continue;
                        }
                    }
                }
                ex_obj.insert(k.clone(), v.clone());
            }
            return;
        }
    }

    let mut temp = json!({ "items": std::mem::take(list) });
    upsert_item(&mut temp, &normalized);
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
                .map(activity_line_for_text)
        } else {
            None
        }
    });
    (step_count, latest_activity)
}

/// First line of a message, or a readable stand-in when the message is a JSON payload.
fn activity_line_for_text(text: &str) -> String {
    if text.starts_with('{') || text.starts_with('[') {
        let findings = serde_json::from_str::<Value>(text)
            .ok()
            .and_then(|v| v.get("findings").and_then(Value::as_array).map(Vec::len));
        return match findings {
            Some(1) => "Reported 1 finding".to_string(),
            Some(n) => format!("Reported {n} findings"),
            None => "Returned a structured report".to_string(),
        };
    }
    text.lines().next().unwrap_or(text).chars().take(120).collect()
}

