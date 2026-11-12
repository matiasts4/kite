use crate::chat::threads::{chat_item, sanitize_chat_text, touch, upsert_item};
use crate::chat::utils::now_ms;
use crate::persist::{notifications, persist, threads};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Read;
use std::sync::Mutex;

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
                            Some("dynamicToolCall".to_string()),
                            Some(String::new()),
                            Some(String::new()),
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
                let thought_id = format!("r_{}_{}", run_id, step_index);
                let mut reasoning_item = chat_item(&thought_id, "reasoning", &text, !is_done);
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
                if let Some(thread) = items.iter_mut().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id)) {
                    upsert_item(thread, &reasoning_item);
                }
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
                {
                    let source = if profile_id.is_some() { "agentChat" } else { "codeThread" };
                    let notice = json!({
                        "id": approval.request_id,
                        "runId": run_id,
                        "target": { "source": source, "id": thread_id },
                        "profileId": profile_id,
                        "routineId": Value::Null,
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
                persist();
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

                let is_ok = !status.eq_ignore_ascii_case("ERROR") && !status.eq_ignore_ascii_case("FAILED");
                finish_run(run_id, is_ok, false, "");

                // Reap child process if still alive so pipe reader threads terminate promptly without hanging
                if let Some(child_arc) = {
                    let live = live_turns().lock().unwrap();
                    live.runs.get(run_id).and_then(|r| r.child.clone())
                } {
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
            if !handle_stream_json_line(thread_id, run_id, assistant_id, &line) {
                emit_deltas(thread_id, run_id, assistant_id, &line);
            }
        }
    }
    if !pending.is_empty() {
        let text = String::from_utf8_lossy(&pending);
        if !handle_stream_json_line(thread_id, run_id, assistant_id, &text) {
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
    let source = if profile_id.is_some() { "agentChat" } else { "codeThread" };
    let notice = json!({
        "id": request_id,
        "runId": run_id,
        "target": { "source": source, "id": thread_id },
        "profileId": profile_id,
        "routineId": Value::Null,
        "kind": { "kind": "needsInput", "requestKind": "toolApproval" },
        "resolution": Value::Null,
        "createdAtUnixMs": now_ms(),
        "isRead": false,
        "isWaitingForInput": true
    });
    let mut notifs = notifications().lock().unwrap();
    if let Some(pos) = notifs.iter().position(|n| n.get("id").and_then(|v| v.as_str()) == Some(request_id.as_str())) {
        notifs[pos] = notice;
    } else {
        notifs.insert(0, notice);
        if notifs.len() > 100 {
            notifs.truncate(100);
        }
    }
    persist();
}

pub fn emit_deltas(thread_id: &str, run_id: &str, assistant_id: &str, text: &str) {
    let clean = sanitize_chat_text(text);
    if clean.is_empty() {
        return;
    }
    if let Some(permission) = headless_permission_denial(&clean) {
        open_headless_permission(thread_id, run_id, &permission);
        return;
    }
    for chunk in chars_chunks(&clean, 8000) {
        let appended = {
            let mut live = live_turns().lock().unwrap();
            let Some(run) = live.runs.get_mut(run_id) else { return };
            if run.closing || run.finished {
                return;
            }
            if run.assistant_text.chars().count() >= 200_000 {
                return;
            }
            let room = 200_000 - run.assistant_text.chars().count();
            let piece: String = chunk.chars().take(room).collect();
            run.assistant_text.push_str(&piece);
            push_event(run, json!({ "kind": "delta", "itemId": assistant_id, "text": piece }));
            run.assistant_text.clone()
        };
        live_cv().notify_all();
        let item = chat_item(assistant_id, "assistant", &appended, true);
        let mut items = threads().lock().unwrap();
        if let Some(thread) = items.iter_mut().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id)) {
            upsert_item(thread, &item);
        }
    }
    crate::chat::subagents::sync_child_thread_to_parent(thread_id);
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
    let mut item = crate::chat::subagents::acp_tool_to_chat_item(&tool);
    let streaming = tool.status == "running" || tool.status == "pending";
    let existing = {
        let items = threads().lock().unwrap();
        items
            .iter()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(thread_id))
            .and_then(|t| t.get("items"))
            .and_then(Value::as_array)
            .and_then(|arr| {
                arr.iter()
                    .find(|it| it.get("id").and_then(Value::as_str) == Some(tool.id.as_str()))
            })
            .cloned()
    };
    if let Some(ex) = existing {
        if tool.name.trim().is_empty() {
            if let Some(v) = ex.get("toolName").and_then(Value::as_str) {
                item["toolName"] = json!(v);
            }
            if let Some(v) = ex.get("toolKind").and_then(Value::as_str) {
                item["toolKind"] = json!(v);
            }
        }
        if tool.title.trim().is_empty() {
            if let Some(v) = ex.get("title").and_then(Value::as_str) {
                item["title"] = json!(v);
            }
        }
        if tool.detail.trim().is_empty() {
            if let Some(v) = ex.get("detail").and_then(Value::as_str) {
                item["detail"] = json!(v);
            }
        }
        if tool.output.is_none() {
            if let Some(v) = ex.get("text").and_then(Value::as_str) {
                if !v.is_empty() {
                    item["text"] = json!(v);
                }
            }
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
                merged.status = tool.status.clone();
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

    crate::chat::checkpoints::maybe_fill_turn_tool_diff(thread_id, run_id, &mut item, streaming);

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
    if item.get("subagentMeta").is_some() {
        crate::chat::subagents::record_subagent_tool_call(thread_id, &item);
    }
    if item.get("swarmMeta").is_some() {
        crate::chat::subagents::record_swarm_tool_call(thread_id, &item);
    }
    crate::chat::subagents::sync_child_thread_to_parent(thread_id);
    if !streaming {
        persist();
    }
}
