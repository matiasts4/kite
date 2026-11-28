use crate::chat::threads::{
    chat_item, sanitize_chat_text_with_state, starts_with_system_message_envelope_header, touch,
    upsert_item,
};
use crate::chat::utils::now_ms;
use crate::persist::{notifications, persist, threads};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::sync::Mutex;

fn streaming_sys_msg_runs() -> &'static Mutex<HashSet<String>> {
    static RUNS: std::sync::OnceLock<Mutex<HashSet<String>>> = std::sync::OnceLock::new();
    RUNS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn last_agent_step_by_run() -> &'static Mutex<HashMap<String, i64>> {
    static MAP: std::sync::OnceLock<Mutex<HashMap<String, i64>>> = std::sync::OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

fn fallback_projected_steps_by_run() -> &'static Mutex<HashMap<String, HashSet<i64>>> {
    static MAP: std::sync::OnceLock<Mutex<HashMap<String, HashSet<i64>>>> =
        std::sync::OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

fn record_agent_step_index(run_id: &str, step_index: i64) {
    let mut map = last_agent_step_by_run().lock().unwrap();
    if map.len() > 256 {
        map.clear();
    }
    map.insert(run_id.to_string(), step_index);
}

fn mark_fallback_projected_step(run_id: &str, step_index: i64) {
    let mut map = fallback_projected_steps_by_run().lock().unwrap();
    if map.len() > 256 {
        map.clear();
    }
    map.entry(run_id.to_string()).or_default().insert(step_index);
}

fn is_fallback_projected_step(run_id: &str, step_index: i64) -> bool {
    fallback_projected_steps_by_run()
        .lock()
        .unwrap()
        .get(run_id)
        .is_some_and(|steps| steps.contains(&step_index))
}

pub(super) fn clear_stream_run_state(run_id: &str) {
    streaming_sys_msg_runs().lock().unwrap().remove(run_id);
    last_agent_step_by_run().lock().unwrap().remove(run_id);
    fallback_projected_steps_by_run().lock().unwrap().remove(run_id);
    stderr_ring().lock().unwrap().remove(run_id);
    result_failures().lock().unwrap().remove(run_id);
}

#[cfg(test)]
pub(super) fn seed_stream_run_state_for_test(run_id: &str, step: i64) {
    streaming_sys_msg_runs()
        .lock()
        .unwrap()
        .insert(run_id.to_string());
    last_agent_step_by_run()
        .lock()
        .unwrap()
        .insert(run_id.to_string(), step);
    fallback_projected_steps_by_run()
        .lock()
        .unwrap()
        .entry(run_id.to_string())
        .or_default()
        .insert(step);
    stderr_ring()
        .lock()
        .unwrap()
        .insert(run_id.to_string(), "test stderr".to_string());
    result_failures()
        .lock()
        .unwrap()
        .insert(run_id.to_string(), "test failure".to_string());
}

#[cfg(test)]
pub(super) fn has_stream_run_state_for_test(run_id: &str) -> bool {
    streaming_sys_msg_runs().lock().unwrap().contains(run_id)
        || last_agent_step_by_run().lock().unwrap().contains_key(run_id)
        || fallback_projected_steps_by_run()
            .lock()
            .unwrap()
            .contains_key(run_id)
        || stderr_ring().lock().unwrap().contains_key(run_id)
        || result_failures().lock().unwrap().contains_key(run_id)
}

use super::pipeline::apply_known_turn_pipeline;
use super::settle::finish_run;
use super::state::{emit_notice_item, live_cv, live_turns};
use super::turn::push_event;

pub fn extract_parent_subagent_id(val: &Value) -> Option<String> {
    val.get("parent_tool_use_id")
        .or_else(|| val.get("parentToolUseId"))
        .or_else(|| val.get("subagent_id"))
        .or_else(|| val.get("subagentId"))
        .or_else(|| val.pointer("/params/update/parent_tool_use_id"))
        .or_else(|| val.pointer("/step_update/parent_tool_use_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

pub fn handle_stream_json_line(thread_id: &str, run_id: &str, assistant_id: &str, line: &str) -> bool {
    let trimmed = line.trim();
    if !trimmed.starts_with('{') || !trimmed.ends_with('}') {
        return false;
    }
    let Ok(val) = serde_json::from_str::<Value>(trimmed) else {
        return false;
    };

    if let Some(parent_id) = extract_parent_subagent_id(&val) {
        if crate::chat::subagents::ingest_nested_subagent_frame(thread_id, run_id, &parent_id, &val) {
            return true;
        }
    }

    if let Some(parts) = val.pointer("/message/content").and_then(Value::as_array) {
        let msg_type = val.get("type").and_then(Value::as_str).unwrap_or("");
        if matches!(msg_type, "assistant" | "user") && !parts.is_empty() {
            let mut handled = false;
            for (idx, part) in parts.iter().enumerate() {
                match part.get("type").and_then(Value::as_str).unwrap_or("") {
                    "thinking" => {
                        if let Some(text) = part.get("thinking").or_else(|| part.get("text")).and_then(Value::as_str) {
                            if !text.trim().is_empty() {
                                let thought_id = format!("r_{}_{}", run_id, idx);
                                let reasoning_item = chat_item(&thought_id, "reasoning", text, false);
                                {
                                    let mut live = live_turns().lock().unwrap();
                                    if let Some(run) = live.runs.get_mut(run_id) {
                                        push_event(run, json!({ "kind": "upsert", "item": reasoning_item.clone() }));
                                    }
                                }
                                live_cv().notify_all();
                                let mut items = threads().lock().unwrap();
                                if let Some(thread) = items.iter_mut().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id)) {
                                    upsert_item(thread, &reasoning_item);
                                }
                                handled = true;
                            }
                        }
                    }
                    "text" => {
                        if let Some(text) = part.get("text").and_then(Value::as_str) {
                            if !text.is_empty() {
                                emit_deltas(thread_id, run_id, assistant_id, text);
                                handled = true;
                            }
                        }
                    }
                    "tool_use" => {
                        let tool_id = part.get("id").and_then(Value::as_str).unwrap_or("tool_1").to_string();
                        let tool_name = part.get("name").and_then(Value::as_str).unwrap_or("tool");
                        let params = part.get("input").cloned().unwrap_or(Value::Null);
                        let tool = crate::acp::build_acp_tool_call(
                            tool_id,
                            tool_name,
                            params,
                            "running".to_string(),
                            None, None, None, None, None, None, None, None,
                        );
                        record_acp_tool_update(thread_id, run_id, tool);
                        handled = true;
                    }
                    "tool_result" => {
                        let tool_id = part.get("tool_use_id").or_else(|| part.get("id")).and_then(Value::as_str).unwrap_or("tool_1").to_string();
                        let output = part.get("content").and_then(|v| {
                            v.as_str()
                                .map(str::to_string)
                                .or_else(|| (!v.is_null()).then(|| serde_json::to_string_pretty(v).ok()).flatten())
                        });
                        let is_error = part.get("is_error").and_then(Value::as_bool).unwrap_or(false);
                        let tool = crate::acp::build_acp_tool_call(
                            tool_id,
                            "",
                            Value::Null,
                            if is_error { "failed".into() } else { "completed".into() },
                            output,
                            None, None,
                            None,
                            None,
                            None,
                            None, None,
                        );
                        record_acp_tool_update(thread_id, run_id, tool);
                        handled = true;
                    }
                    _ => {}
                }
            }
            if handled {
                return true;
            }
        }
    }

    if apply_known_turn_pipeline(thread_id, run_id, assistant_id, &val) {
        return true;
    }

    if val.get("event").and_then(Value::as_str) == Some("step_update") {
        if let Some(su) = val.get("step_update") {
            let step_type = su.get("step_type").and_then(Value::as_str).unwrap_or("");
            if step_type == "agent_response" || step_type == "planner_response" {
                let step_idx = su.get("step_index").and_then(Value::as_i64);
                let state = su.get("state").and_then(Value::as_str).unwrap_or("");
                let thought = su
                    .get("thinking")
                    .or_else(|| su.get("thought"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                // Transcript fallback already projected this step while stdout was stalled; skip delayed text deltas
                // and do not fall through to parse_acp_stream_line (which would re-emit them as ContentDelta).
                if let Some(curr) = step_idx {
                    if is_fallback_projected_step(run_id, curr) {
                        if !thought.is_empty() {
                            emit_thought_delta(
                                thread_id,
                                run_id,
                                curr,
                                thought,
                                state.eq_ignore_ascii_case("DONE")
                                    || state.eq_ignore_ascii_case("COMPLETED"),
                                su.get("duration_seconds").and_then(Value::as_f64),
                            );
                        }
                        return true;
                    }
                }
                let raw_delta = su
                    .get("text_delta")
                    .or_else(|| su.get("text"))
                    .or_else(|| su.get("content"))
                    .and_then(Value::as_str);
                if let Some(raw) = raw_delta {
                    if !raw.is_empty() {
                        let step_changed = {
                            let map = last_agent_step_by_run().lock().unwrap();
                            matches!((map.get(run_id).copied(), step_idx), (Some(prev), Some(curr)) if curr != prev)
                        };
                        let emitted =
                            emit_deltas_inner(thread_id, run_id, assistant_id, raw, step_changed);
                        if emitted {
                            if let Some(curr) = step_idx {
                                record_agent_step_index(run_id, curr);
                            }
                            return true;
                        }
                        if thought.is_empty() {
                            return true;
                        }
                    }
                }
            }
        }
    }

    if let Some(acp_event) = crate::acp::parse_acp_stream_line(thread_id, run_id, trimmed) {
        match acp_event {
            crate::acp::AcpStreamEvent::Init { conversation_id, model } => {
                if !conversation_id.is_empty() {
                    let mut items = threads().lock().unwrap();
                    if let Some(thread) = items.iter_mut().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id)) {
                        thread["providerSessionId"] = json!(conversation_id);
                        if !model.is_empty() && (thread.get("model").is_none() || thread["model"].is_null()) {
                            thread["model"] = json!(model);
                        }
                        touch(thread);
                    }
                    drop(items);
                    persist();
                }
                return true;
            }
            crate::acp::AcpStreamEvent::ContentDelta { text } => {
                emit_deltas(thread_id, run_id, assistant_id, &text);
                return true;
            }
            crate::acp::AcpStreamEvent::ThoughtDelta {
                text,
                is_done,
                duration_seconds,
            } => {
                let step_index = val
                    .pointer("/step_update/step_index")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0);
                emit_thought_delta(thread_id, run_id, step_index, &text, is_done, duration_seconds);
                return true;
            }
            crate::acp::AcpStreamEvent::ToolUpdate { tool } => {
                record_acp_tool_update(thread_id, run_id, tool);
                return true;
            }
            crate::acp::AcpStreamEvent::PermissionRequired { approval } => {
                let approval_val = json!({
                    "id": approval.request_id,
                    "toolName": approval.tool_name,
                    "title": approval.title,
                    "detail": approval.description,
                    "risk": approval.risk,
                    "impact": approval.impact,
                    "text": approval.description,
                    "command": approval.command,
                    "path": approval.path,
                    "tool": approval.tool_name,
                    "parameters": approval.details,
                    "status": "pending"
                });
                {
                    let mut live = live_turns().lock().unwrap();
                    if let Some(run) = live.runs.get_mut(run_id) {
                        push_event(run, json!({ "kind": "approvalOpened", "approval": approval_val.clone() }));
                        push_event(run, json!({ "kind": "status", "status": "waiting" }));
                    }
                }
                live_cv().notify_all();
                let profile_id = {
                    let mut items = threads().lock().unwrap();
                    if let Some(thread) = items.iter_mut().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id)) {
                        thread["pendingApproval"] = approval_val;
                        thread["status"] = json!("waiting");
                        touch(thread);
                        thread.get("profileId").and_then(|v| v.as_str()).map(|s| s.to_string())
                    } else {
                        None
                    }
                };
                let meta = crate::notifications::resolve_notification_context(
                    Some(thread_id),
                    profile_id.as_deref(),
                    None,
                );
                {
                    let source = if profile_id.is_some() { "agentChat" } else { "codeThread" };
                    let module = if profile_id.is_some() { "agent" } else { "chat" };
                    let notice = json!({
                        "id": approval.request_id,
                        "runId": run_id,
                        "target": { "source": source, "id": thread_id },
                        "profileId": profile_id,
                        "routineId": Value::Null,
                        "actorName": meta.actor_name,
                        "threadTitle": meta.thread_title,
                        "workspaceId": meta.workspace_id,
                        "module": module,
                        "kind": { "kind": "needsInput", "requestKind": "toolApproval" },
                        "resolution": Value::Null,
                        "createdAtUnixMs": now_ms(),
                        "isRead": false,
                        "isWaitingForInput": true
                    });
                    let mut notifs = notifications().lock().unwrap();
                    if let Some(pos) = notifs.iter().position(|n| n.get("id").and_then(|v| v.as_str()) == Some(&approval.request_id)) {
                        notifs[pos] = notice;
                    } else {
                        notifs.insert(0, notice);
                        if notifs.len() > 100 {
                            notifs.truncate(100);
                        }
                    }
                }
                crate::chat::subagents::sync_child_thread_to_parent(thread_id);
                persist();
                crate::notifications::emit_notifications_updated();
                return true;
            }
            crate::acp::AcpStreamEvent::UnknownFrame { message } => {
                let mut hash = 0u32;
                for byte in message.bytes() {
                    hash = hash.wrapping_mul(31).wrapping_add(byte as u32);
                }
                let note_id = format!("notice_{run_id}_{hash}");
                let mut note = chat_item(&note_id, "note", &message, false);
                note["title"] = json!("Unrecognized frame");
                {
                    let mut live = live_turns().lock().unwrap();
                    if let Some(run) = live.runs.get_mut(run_id) {
                        push_event(run, json!({ "kind": "upsert", "item": note.clone() }));
                    }
                }
                live_cv().notify_all();
                let mut items = threads().lock().unwrap();
                if let Some(thread) = items.iter_mut().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id)) {
                    upsert_item(thread, &note);
                }
                return true;
            }
            crate::acp::AcpStreamEvent::PlanUpdate { step, status } => {
                let plan_item_id = format!("plan_{}", run_id);
                let is_streaming = status == "running" || status == "pending";
                let mut plan_item = chat_item(&plan_item_id, "tool", &step, is_streaming);
                plan_item["title"] = json!(format!("Plan · {}", step));
                plan_item["status"] = json!(status);
                plan_item["toolKind"] = json!("planUpdate");
                {
                    let mut live = live_turns().lock().unwrap();
                    if let Some(run) = live.runs.get_mut(run_id) {
                        push_event(run, json!({ "kind": "upsert", "item": plan_item.clone() }));
                    }
                }
                live_cv().notify_all();
                let mut items = threads().lock().unwrap();
                if let Some(thread) = items.iter_mut().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id)) {
                    upsert_item(thread, &plan_item);
                }
                return true;
            }
            crate::acp::AcpStreamEvent::Result {
                input_tokens,
                output_tokens,
                duration_seconds,
                ref status,
            } => {
                let usage_val = serde_json::to_value(crate::chat::normalize::usage_from_provider(
                    input_tokens,
                    output_tokens,
                    None,
                    None,
                    Some(duration_seconds),
                ))
                .unwrap_or_else(|_| json!({
                    "inputTokens": input_tokens,
                    "outputTokens": output_tokens,
                    "durationSeconds": duration_seconds
                }));
                {
                    let mut live = live_turns().lock().unwrap();
                    if let Some(run) = live.runs.get_mut(run_id) {
                        push_event(run, json!({ "kind": "usage", "usage": usage_val.clone() }));
                    }
                }
                live_cv().notify_all();
                {
                    let mut items = threads().lock().unwrap();
                    if let Some(thread) = items.iter_mut().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id)) {
                        thread["usage"] = usage_val;
                        touch(thread);
                    }
                }
                persist();
                crate::chat::subagents::reconcile_antigravity_subagents_for_thread(
                    thread_id,
                    Some(run_id),
                );

                let is_ok = !status.eq_ignore_ascii_case("ERROR") && !status.eq_ignore_ascii_case("FAILED");
                let child_arc = {
                    let live = live_turns().lock().unwrap();
                    live.runs.get(run_id).and_then(|r| r.child.clone())
                };
                if is_ok {
                    finish_run(run_id, true, false, "");
                } else {
                    let result_err = ["/result/error/message", "/result/error", "/error/message", "/error", "/result/message"]
                        .iter()
                        .filter_map(|ptr| val.pointer(ptr).and_then(Value::as_str))
                        .map(str::trim)
                        .find(|s| !s.is_empty())
                        .map(str::to_string)
                        .unwrap_or_else(|| format!("the provider ended the turn with status {status}"));
                    if child_arc.is_some() {
                        // Let `stream_child` finish draining stderr and record the classified
                        // `turnFailure` before calling `finish_run` once.
                        record_result_failure(run_id, &result_err);
                    } else {
                        let provider = threads()
                            .lock()
                            .unwrap()
                            .iter()
                            .find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id))
                            .and_then(|t| t.get("provider").and_then(|v| v.as_str()))
                            .unwrap_or("")
                            .to_string();
                        let projected = crate::chat::normalize::project_process_failure(
                            Some(1),
                            &result_err,
                            &provider,
                            &[],
                        );
                        if let Some(failure) = projected.failure {
                            record_turn_failure(thread_id, &failure);
                            finish_run(run_id, false, false, "");
                        } else {
                            finish_run(run_id, false, false, &result_err);
                        }
                    }
                }

                // Reap child process if still alive so pipe reader threads terminate promptly without hanging
                if let Some(child_arc) = child_arc {
                    if let Ok(mut c) = child_arc.lock() {
                        let _ = c.kill();
                    }
                }

                return true;
            }
            crate::acp::AcpStreamEvent::Raw { .. } => return true,
        }
    }

    if val.is_object() {
        if val.get("type").is_some()
            || val.get("event").is_some()
            || val.get("jsonrpc").is_some()
            || val.get("sessionID").is_some()
            || val.get("sessionId").is_some()
            || val.get("session_id").is_some()
            || val.get("step").is_some()
            || val.get("step_index").is_some()
            || val.get("tokens").is_some()
            || val.get("part").is_some()
            || val.get("delta").is_some()
            || val.get("method").is_some()
            || val.get("result").is_some()
            || val.get("error").is_some()
        {
            let kind = val
                .get("method")
                .or_else(|| val.get("type"))
                .or_else(|| val.get("event"))
                .and_then(Value::as_str)
                .unwrap_or("frame");
            emit_notice_item(
                thread_id,
                run_id,
                &format!("unrecognized frame `{kind}`"),
            );
            return true;
        }
    }

    false
}

pub fn stderr_ring() -> &'static Mutex<HashMap<String, String>> {
    static RING: std::sync::OnceLock<Mutex<HashMap<String, String>>> =
        std::sync::OnceLock::new();
    RING.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn read_stderr_ring(mut pipe: impl Read, run_id: &str) {
    let mut pending = Vec::new();
    let mut buf = [0u8; 4096];
    loop {
        let Ok(count) = pipe.read(&mut buf) else { break };
        if count == 0 {
            break;
        }
        pending.extend_from_slice(&buf[..count]);
    }
    if pending.is_empty() {
        return;
    }
    let text = String::from_utf8_lossy(&pending);
    let mut ring = stderr_ring().lock().unwrap();
    let entry = ring.entry(run_id.to_string()).or_default();
    entry.push_str(&text);
    if entry.len() > 16_000 {
        let drain = entry.len() - 16_000;
        entry.drain(..drain);
    }
}

pub fn take_run_stderr(run_id: &str) -> String {
    stderr_ring()
        .lock()
        .unwrap()
        .remove(run_id)
        .unwrap_or_default()
}

fn result_failures() -> &'static Mutex<HashMap<String, String>> {
    static MAP: std::sync::OnceLock<Mutex<HashMap<String, String>>> = std::sync::OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn record_result_failure(run_id: &str, message: &str) {
    let trimmed = message.trim();
    if run_id.is_empty() || trimmed.is_empty() {
        return;
    }
    result_failures()
        .lock()
        .unwrap()
        .insert(run_id.to_string(), trimmed.to_string());
}

pub fn take_result_failure(run_id: &str) -> Option<String> {
    result_failures().lock().unwrap().remove(run_id)
}

pub fn record_turn_failure(thread_id: &str, failure: &crate::chat::normalize::TurnFailure) {
    let Ok(value) = serde_json::to_value(failure) else {
        return;
    };
    let mut items = threads().lock().unwrap();
    if let Some(thread) = items
        .iter_mut()
        .find(|thread| thread.get("id").and_then(|v| v.as_str()) == Some(thread_id))
    {
        thread["turnFailure"] = value;
        thread["status"] = json!("error");
        touch(thread);
    }
    drop(items);
    persist();
}

fn should_discard_unhandled_json_line(line: &str) -> bool {
    let trimmed = line.trim();
    trimmed.starts_with('{')
        && trimmed.ends_with('}')
        && matches!(serde_json::from_str::<Value>(trimmed), Ok(Value::Object(_)))
}

pub fn read_pipe(mut pipe: impl Read, thread_id: &str, run_id: &str, assistant_id: &str) {
    let mut pending = Vec::new();
    let mut buf = [0u8; 4096];
    loop {
        let read = pipe.read(&mut buf);
        let Ok(count) = read else { break };
        if count == 0 {
            break;
        }
        pending.extend_from_slice(&buf[..count]);
        while let Some(pos) = pending.iter().position(|&b| b == b'\n') {
            let line_bytes: Vec<u8> = pending.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line_bytes);
            if !handle_stream_json_line(thread_id, run_id, assistant_id, &line)
                && !should_discard_unhandled_json_line(&line)
            {
                emit_deltas(thread_id, run_id, assistant_id, &line);
            }
        }
    }
    if !pending.is_empty() {
        let text = String::from_utf8_lossy(&pending);
        if !handle_stream_json_line(thread_id, run_id, assistant_id, &text)
            && !should_discard_unhandled_json_line(&text)
        {
            emit_deltas(thread_id, run_id, assistant_id, &text);
        }
    }
}

/// A headless CLI that cannot ask prints this and stops. The permission name is
/// the quoted word in `the "mcp" permission`. A long answer that merely mentions
/// the sentence is left alone.
pub fn headless_permission_denial(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.len() > 800 {
        return None;
    }
    let lower = trimmed.to_ascii_lowercase();
    if !lower.contains("headless mode cannot prompt") || !lower.contains("auto-denied") {
        return None;
    }
    let Some(open) = trimmed.find('"') else {
        return Some("tool".to_string());
    };
    let rest = &trimmed[open + 1..];
    let Some(end) = rest.find('"') else {
        return Some("tool".to_string());
    };
    let name = rest[..end].trim();
    if name.is_empty() || name.len() > 40 || name.contains(' ') {
        return Some("tool".to_string());
    }
    Some(name.to_string())
}

pub fn open_headless_permission(thread_id: &str, run_id: &str, permission: &str) {
    let request_id = format!("perm_{run_id}_headless");
    let approval_val = json!({
        "id": request_id,
        "toolName": permission,
        "title": format!("{permission} permission"),
        "detail": format!("The {permission} tool was denied because headless mode cannot prompt."),
        "risk": "unknown",
        "impact": "Allow for session applies on the next send. This call already ended.",
        "status": "pending"
    });
    {
        let mut live = live_turns().lock().unwrap();
        if let Some(run) = live.runs.get_mut(run_id) {
            push_event(run, json!({ "kind": "approvalOpened", "approval": approval_val.clone() }));
            push_event(run, json!({ "kind": "status", "status": "waiting" }));
        }
    }
    live_cv().notify_all();
    let profile_id = {
        let mut items = threads().lock().unwrap();
        if let Some(thread) = items.iter_mut().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id)) {
            thread["pendingApproval"] = approval_val;
            thread["status"] = json!("waiting");
            touch(thread);
            thread.get("profileId").and_then(|v| v.as_str()).map(|s| s.to_string())
        } else {
            None
        }
    };
    let meta = crate::notifications::resolve_notification_context(
        Some(thread_id),
        profile_id.as_deref(),
        None,
    );
    let source = if profile_id.is_some() { "agentChat" } else { "codeThread" };
    let module = if profile_id.is_some() { "agent" } else { "chat" };
    let notice = json!({
        "id": request_id,
        "runId": run_id,
        "target": { "source": source, "id": thread_id },
        "profileId": profile_id,
        "routineId": Value::Null,
        "actorName": meta.actor_name,
        "threadTitle": meta.thread_title,
        "workspaceId": meta.workspace_id,
        "module": module,
        "kind": { "kind": "needsInput", "requestKind": "toolApproval" },
        "resolution": Value::Null,
        "createdAtUnixMs": now_ms(),
        "isRead": false,
        "isWaitingForInput": true
    });
    {
        let mut notifs = notifications().lock().unwrap();
        if let Some(pos) = notifs.iter().position(|n| n.get("id").and_then(|v| v.as_str()) == Some(request_id.as_str())) {
            notifs[pos] = notice;
        } else {
            notifs.insert(0, notice);
            if notifs.len() > 100 {
                notifs.truncate(100);
            }
        }
    }
    persist();
    crate::notifications::emit_notifications_updated();
    crate::chat::subagents::sync_child_thread_to_parent(thread_id);
}

fn strip_dangling_user_role_line(text: &mut String) -> bool {
    let trimmed_end = text.trim_end_matches([' ', '\t', '\r', '\n']);
    let line_start = trimmed_end.rfind('\n').map_or(0, |p| p + 1);
    if trimmed_end[line_start..].trim() != "user" {
        return false;
    }
    let prefix = trimmed_end[..line_start].trim_end();
    text.truncate(prefix.len());
    true
}

fn emit_thought_delta(
    thread_id: &str,
    run_id: &str,
    step_index: i64,
    text: &str,
    is_done: bool,
    duration_seconds: Option<f64>,
) {
    let thought_id = format!("r_{}_{}", run_id, step_index);
    let mut reasoning_item = chat_item(&thought_id, "reasoning", text, !is_done);
    if let Some(dur) = duration_seconds {
        reasoning_item["durationSeconds"] = json!(dur);
    }
    {
        let mut live = live_turns().lock().unwrap();
        if let Some(run) = live.runs.get_mut(run_id) {
            push_event(run, json!({ "kind": "upsert", "item": reasoning_item.clone() }));
        }
    }
    live_cv().notify_all();
    let mut items = threads().lock().unwrap();
    if let Some(thread) = items
        .iter_mut()
        .find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id))
    {
        upsert_item(thread, &reasoning_item);
    }
}

pub fn emit_deltas(thread_id: &str, run_id: &str, assistant_id: &str, text: &str) {
    let _ = emit_deltas_inner(thread_id, run_id, assistant_id, text, false);
}

/// Emits a transcript-recovered planner response step with a paragraph break when needed,
/// recording `step_index` so delayed stdout frames for that step are suppressed without
/// losing the paragraph separator before subsequent stdout steps.
pub(crate) fn emit_fallback_step_deltas(
    thread_id: &str,
    run_id: &str,
    assistant_id: &str,
    step_index: i64,
    text: &str,
) -> bool {
    let emitted = emit_deltas_inner(thread_id, run_id, assistant_id, text, true);
    if emitted {
        mark_fallback_projected_step(run_id, step_index);
        record_agent_step_index(run_id, step_index);
    }
    emitted
}

fn emit_deltas_inner(
    thread_id: &str,
    run_id: &str,
    assistant_id: &str,
    text: &str,
    force_paragraph_break: bool,
) -> bool {
    let was_in_sys = {
        let runs = streaming_sys_msg_runs().lock().unwrap();
        runs.contains(run_id)
    };
    let sanitized = sanitize_chat_text_with_state(text, was_in_sys);
    let clean = sanitized.text;
    let next_in_sys = sanitized.in_system_message;
    let stripped_leading = sanitized.stripped_leading;
    {
        let mut runs = streaming_sys_msg_runs().lock().unwrap();
        if next_in_sys {
            if runs.len() > 256 {
                runs.clear();
            }
            runs.insert(run_id.to_string());
        } else {
            runs.remove(run_id);
        }
    }

    let leading_sys_header = !was_in_sys && starts_with_system_message_envelope_header(text);
    if clean.is_empty() {
        if leading_sys_header {
            let fixed_item = {
                let mut live = live_turns().lock().unwrap();
                live.runs.get_mut(run_id).and_then(|run| {
                    if !run.closing && !run.finished && strip_dangling_user_role_line(&mut run.assistant_text) {
                        let item = chat_item(assistant_id, "assistant", &run.assistant_text, true);
                        push_event(run, json!({ "kind": "upsert", "item": item.clone() }));
                        Some(item)
                    } else {
                        None
                    }
                })
            };
            if let Some(item) = fixed_item {
                live_cv().notify_all();
                let mut items = threads().lock().unwrap();
                if let Some(thread) = items
                    .iter_mut()
                    .find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id))
                {
                    upsert_item(thread, &item);
                }
            }
        }
        return false;
    }
    if let Some(permission) = headless_permission_denial(&clean) {
        open_headless_permission(thread_id, run_id, &permission);
        return false;
    }
    let (has_tool_after_assistant, has_subagent_after_assistant) = {
        let items = threads().lock().unwrap();
        items
            .iter()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(thread_id))
            .and_then(|t| t.get("items"))
            .and_then(Value::as_array)
            .and_then(|list| {
                let pos = list
                    .iter()
                    .position(|it| it.get("id").and_then(Value::as_str) == Some(assistant_id))?;
                let after = &list[pos + 1..];
                let any_tool = after.iter().any(|it| {
                    matches!(
                        it.get("kind").and_then(Value::as_str),
                        Some("tool" | "command")
                    )
                });
                let any_subagent = after.iter().any(|it| {
                    matches!(
                        it.get("toolKind").and_then(Value::as_str),
                        Some("subagent" | "swarm")
                    ) || it.get("subagentMeta").is_some()
                        || it.get("swarmMeta").is_some()
                });
                Some((any_tool, any_subagent))
            })
            .unwrap_or((false, false))
    };

    let mut apply_seam_check =
        has_tool_after_assistant || force_paragraph_break || stripped_leading;
    let mut emitted_any = false;
    for chunk in chars_chunks(&clean, 8000) {
        let item = {
            let mut live = live_turns().lock().unwrap();
            let Some(run) = live.runs.get_mut(run_id) else {
                return emitted_any;
            };
            if run.closing || run.finished {
                return emitted_any;
            }
            let mut replaced_with_upsert = false;
            if leading_sys_header && strip_dangling_user_role_line(&mut run.assistant_text) {
                replaced_with_upsert = true;
            }
            let mut sep = "";
            if apply_seam_check && !run.assistant_text.is_empty() {
                apply_seam_check = false;
                let lower = run.assistant_text.to_ascii_lowercase();
                let is_waiting_narration = has_tool_after_assistant
                    && has_subagent_after_assistant
                    && (lower.contains("esperando")
                        || lower.contains("waiting for")
                        || lower.contains("lancé el subagente")
                        || lower.contains("lance el subagente"));
                if is_waiting_narration {
                    run.assistant_text.clear();
                    replaced_with_upsert = true;
                } else if !chunk.starts_with('\n') && !run.assistant_text.ends_with("\n\n") {
                    sep = if run.assistant_text.ends_with('\n') {
                        "\n"
                    } else {
                        "\n\n"
                    };
                } else if chunk.starts_with('\n')
                    && !chunk.starts_with("\n\n")
                    && !run.assistant_text.ends_with('\n')
                    && chunk.len() > 1
                {
                    sep = "\n";
                }
            } else {
                apply_seam_check = false;
            }
            if run.assistant_text.chars().count() >= 200_000 {
                return emitted_any;
            }
            let room = 200_000 - run.assistant_text.chars().count();
            let sep_chars = sep.chars().count();
            let piece: String = chunk.chars().take(room.saturating_sub(sep_chars)).collect();
            let delta_piece = if sep_chars > 0 && room >= sep_chars {
                format!("{sep}{piece}")
            } else if sep_chars > 0 {
                sep.chars().take(room).collect()
            } else {
                piece
            };
            run.assistant_text.push_str(&delta_piece);
            let item = chat_item(assistant_id, "assistant", &run.assistant_text, true);
            if replaced_with_upsert {
                push_event(run, json!({ "kind": "upsert", "item": item.clone() }));
            } else {
                push_event(run, json!({ "kind": "delta", "itemId": assistant_id, "text": delta_piece }));
            }
            emitted_any = true;
            item
        };
        live_cv().notify_all();
        let mut items = threads().lock().unwrap();
        if let Some(thread) = items.iter_mut().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id)) {
            upsert_item(thread, &item);
        }
    }
    crate::chat::subagents::sync_child_thread_to_parent(thread_id);
    emitted_any
}

pub fn chars_chunks(text: &str, size: usize) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut current = String::new();
    for ch in text.chars() {
        current.push(ch);
        if current.len() >= size {
            chunks.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

pub fn record_acp_tool_update(thread_id: &str, run_id: &str, tool: crate::acp::AcpToolCall) {
    let runtime_active = super::state::is_thread_runtime_active(thread_id);
    let mut item = crate::chat::subagents::acp_tool_to_chat_item(&tool);
    let streaming = tool.status == "running" || tool.status == "pending";
    let (existing, thread_active) = {
        let items = threads().lock().unwrap();
        let thread = items
            .iter()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(thread_id));
        let active = thread.is_some_and(|t| {
            matches!(
                t.get("status").and_then(Value::as_str),
                Some("running" | "waiting")
            )
        });
        let found = thread
            .and_then(|t| t.get("items"))
            .and_then(Value::as_array)
            .and_then(|arr| {
                arr.iter()
                    .find(|it| it.get("id").and_then(Value::as_str) == Some(tool.id.as_str()))
            })
            .cloned();
        (found, active)
    };
    let parent_active = runtime_active || thread_active;
    if let Some(ex) = existing {
        for key in ["toolName", "toolKind", "title", "detail"] {
            let incoming_generic = item
                .get(key)
                .and_then(Value::as_str)
                .is_none_or(|s| crate::chat::subagents::is_generic_tool_field(key, s));
            if incoming_generic {
                if let Some(prev_val) = ex
                    .get(key)
                    .and_then(Value::as_str)
                    .filter(|s| !crate::chat::subagents::is_generic_tool_field(key, s))
                {
                    item[key] = json!(prev_val);
                }
            }
        }
        if tool.output.is_none() {
            if let Some(v) = ex.get("text").and_then(Value::as_str) {
                if !v.is_empty() {
                    item["text"] = json!(v);
                }
            }
        }
        if let Some(created_at) = ex
            .get("createdAtUnixMs")
            .filter(|v| v.as_i64().is_some_and(|n| n > 0))
        {
            item["createdAtUnixMs"] = created_at.clone();
        }
        for key in [
            "serverName",
            "command",
            "filePath",
            "addedLines",
            "removedLines",
            "parentToolUseId",
        ] {
            if item.get(key).is_none() {
                if let Some(v) = ex.get(key) {
                    item[key] = v.clone();
                }
            }
        }
        if let Some(ex_sub) = ex
            .get("subagentMeta")
            .and_then(|v| serde_json::from_value::<crate::acp::SubagentMeta>(v.clone()).ok())
        {
            let mut merged = match tool.subagent_meta.clone() {
                Some(m) => crate::acp::merge_subagent_meta(Some(&ex_sub), m),
                None => ex_sub,
            };
            if matches!(tool.status.as_str(), "completed" | "failed" | "cancelled") {
                merged.status = if tool.status == "cancelled" {
                    "killed".to_string()
                } else {
                    tool.status.clone()
                };
            }
            item["toolKind"] = json!("subagent");
            if let Ok(v) = serde_json::to_value(merged) {
                item["subagentMeta"] = v;
            }
        }
        if let Some(ex_swarm) = ex
            .get("swarmMeta")
            .and_then(|v| serde_json::from_value::<crate::acp::SwarmMeta>(v.clone()).ok())
        {
            let merged = match tool.swarm_meta.clone() {
                Some(m) => crate::acp::merge_swarm_meta(Some(&ex_swarm), m),
                None => ex_swarm,
            };
            item["toolKind"] = json!("swarm");
            if let Ok(v) = serde_json::to_value(merged) {
                item["swarmMeta"] = v;
            }
        }
    }

    let item_tool_name = item
        .get("toolName")
        .and_then(Value::as_str)
        .unwrap_or(&tool.name);
    let item_failed = crate::acp::response_indicates_failure(
        &tool.status,
        None,
        None,
        item.get("text").and_then(Value::as_str),
    );
    let has_started_thread_receipt = item
        .get("text")
        .and_then(Value::as_str)
        .is_some_and(|t| t.contains("started thread:"));
    if parent_active
        && !item_failed
        && tool.status == "completed"
        && (crate::chat::subagents::is_invoke_subagent_tool_name(item_tool_name)
            || has_started_thread_receipt)
        && item.get("subagentMeta").is_some()
        && !crate::chat::subagents::child_transcript_ended_with_final_response(
            item.pointer("/subagentMeta/transcriptUri").and_then(Value::as_str),
        )
    {
        item["status"] = json!("running");
        item["streaming"] = json!(false);
        if let Some(meta_obj) = item.get_mut("subagentMeta").and_then(Value::as_object_mut) {
            meta_obj.insert("status".into(), json!("running"));
        }
    }

    let retracted_unspawned_invoke =
        crate::chat::subagents::downgrade_unspawned_failed_native_invoke_in_place(&mut item);

    {
        let mut live = live_turns().lock().unwrap();
        if let Some(run) = live.runs.get_mut(run_id) {
            push_event(run, json!({ "kind": "upsert", "item": item.clone() }));
        }
    }
    live_cv().notify_all();
    {
        let mut all_threads = threads().lock().unwrap();
        if let Some(thread) = all_threads
            .iter_mut()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(thread_id))
        {
            upsert_item(thread, &item);
            touch(thread);
        }
    }
    // Schedule diff calculation only after thread["items"] holds the item so kite-diff-worker can patch it reliably.
    crate::chat::checkpoints::schedule_turn_tool_diff(thread_id, run_id, &item, streaming);
    if retracted_unspawned_invoke {
        crate::chat::subagents::remove_unspawned_invoke_runs(thread_id, &tool.id);
    } else if item.get("subagentMeta").is_some() {
        crate::chat::subagents::record_subagent_tool_call(thread_id, &item);
    }
    if item.get("swarmMeta").is_some() {
        crate::chat::subagents::record_swarm_tool_call(thread_id, &item);
    }
    crate::chat::subagents::sync_child_thread_to_parent(thread_id);
    if !streaming {
        let clean_name = crate::acp::strip_mcp_prefix(&tool.name, &Value::Null)
            .1
            .to_ascii_lowercase();
        if clean_name == "manage_subagents"
            || clean_name == "invoke_subagent"
            || item.get("subagentMeta").is_some()
        {
            crate::chat::subagents::reconcile_antigravity_subagents_for_thread(
                thread_id,
                Some(run_id),
            );
        }
    }
    if !streaming {
        crate::persist::persist_async();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn clear_stream_run_state_removes_stderr_ring_and_result_failures() {
        let rid = format!("run-stream-clear-{}", uuid::Uuid::new_v4().simple());
        read_stderr_ring(Cursor::new(b"boom stderr\n".to_vec()), &rid);
        record_result_failure(&rid, "provider failed");
        seed_stream_run_state_for_test(&rid, 3);

        assert!(stderr_ring().lock().unwrap().contains_key(&rid));
        assert!(result_failures().lock().unwrap().contains_key(&rid));

        clear_stream_run_state(&rid);

        assert!(
            !stderr_ring().lock().unwrap().contains_key(&rid),
            "clear_stream_run_state must remove stderr_ring entry"
        );
        assert!(
            !result_failures().lock().unwrap().contains_key(&rid),
            "clear_stream_run_state must remove result_failures entry"
        );
        assert!(!has_stream_run_state_for_test(&rid));
    }

    #[test]
    fn read_stderr_ring_keeps_tail_bounded_and_take_drains_on_one_shot() {
        let rid = format!("run-stderr-ring-{}", uuid::Uuid::new_v4().simple());
        let payload = "x".repeat(20_000);
        read_stderr_ring(Cursor::new(payload.into_bytes()), &rid);

        let stored_len = stderr_ring()
            .lock()
            .unwrap()
            .get(&rid)
            .map(String::len)
            .unwrap_or(0);
        assert_eq!(stored_len, 16_000);

        let drained = take_run_stderr(&rid);
        assert_eq!(drained.len(), 16_000);
        assert!(!stderr_ring().lock().unwrap().contains_key(&rid));
    }
}
