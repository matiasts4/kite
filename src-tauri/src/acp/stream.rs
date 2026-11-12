//! ACP and agent stream protocol engine.
//! Parses stream JSON events, handles approvals, and extracts thought frames.

use serde_json::{json, Value};

use super::types::*;

/// Text carried by a thought frame. Empty markers and ordinary answer deltas return `None`.
pub fn extract_thought_text(value: &Value) -> Option<String> {
    if let Some(parts) = value.pointer("/message/content").and_then(Value::as_array) {
        for part in parts {
            let kind = part.get("type").and_then(Value::as_str).unwrap_or("");
            if !is_thought_kind(kind) {
                continue;
            }
            if let Some(text) = part
                .get("thinking")
                .or_else(|| part.get("text"))
                .and_then(string_field)
            {
                return Some(text.to_string());
            }
        }
    }
    if !frame_is_thought(value) {
        return None;
    }
    let text = value
        .pointer("/delta/thinking")
        .or_else(|| value.pointer("/delta/reasoning"))
        .or_else(|| value.pointer("/item/text"))
        .or_else(|| value.pointer("/item/thinking"))
        .or_else(|| value.pointer("/part/text"))
        .or_else(|| value.pointer("/part/thinking"))
        .or_else(|| value.pointer("/delta/text"))
        .or_else(|| value.get("delta"))
        .or_else(|| value.get("thinking"))
        .or_else(|| value.get("thought"))
        .or_else(|| value.get("reasoning"))
        .or_else(|| value.get("text"))
        .or_else(|| value.get("summary"))
        .or_else(|| value.pointer("/properties/text"))
        .and_then(string_field)?;
    Some(text.to_string())
}

/// A thought-shaped frame whose text is not in a field this build reads.
pub fn thought_frame_without_text(value: &Value) -> bool {
    frame_is_thought(value) && extract_thought_text(value).is_none() && !thought_marker_is_empty(value)
}

/// Parses an incoming line from the agent process (supports agy stream-json, ACP JSON-RPC 2.0, and Claude/Codex stream events).
pub fn parse_acp_stream_line(thread_id: &str, run_id: &str, line: &str) -> Option<AcpStreamEvent> {
    let trimmed = line.trim();
    if !trimmed.starts_with('{') || !trimmed.ends_with('}') {
        return None;
    }

    let val = serde_json::from_str::<Value>(trimmed).ok()?;

    // 1. Check for stream-json format from agy (`"event": ...`)
    if let Some(event) = val.get("event").and_then(|v| v.as_str()) {
        match event {
            "init" => {
                let conv_id = val.pointer("/init/conversation_id")
                    .or_else(|| val.pointer("/init/conversationId"))
                    .or_else(|| val.pointer("/init/session_id"))
                    .or_else(|| val.pointer("/init/sessionId"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let model = val.pointer("/init/model").and_then(|v| v.as_str()).unwrap_or("").to_string();
                return Some(AcpStreamEvent::Init {
                    conversation_id: conv_id,
                    model,
                });
            }
            "step_update" => {
                let su = val.get("step_update")?;
                let step_type = su.get("step_type").and_then(|v| v.as_str()).unwrap_or("");
                let state = su.get("state").and_then(|v| v.as_str()).unwrap_or("");
                let step_index = su.get("step_index").and_then(|v| v.as_i64()).unwrap_or(0);
                let duration = su.get("duration_seconds").and_then(|v| v.as_f64());

                if step_type == "agent_response" || step_type == "planner_response" {
                    let delta = su
                        .get("text_delta")
                        .or_else(|| su.get("text"))
                        .or_else(|| su.get("content"))
                        .and_then(|v| v.as_str());
                    if let Some(d) = delta {
                        if !d.is_empty() {
                            return Some(AcpStreamEvent::ContentDelta {
                                text: d.to_string(),
                            });
                        }
                    }
                    let thought = su
                        .get("thinking")
                        .or_else(|| su.get("thought"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    if !thought.is_empty() {
                        return Some(AcpStreamEvent::ThoughtDelta {
                            text: thought.to_string(),
                            is_done: state.eq_ignore_ascii_case("DONE") || state.eq_ignore_ascii_case("COMPLETED"),
                            duration_seconds: duration,
                        });
                    }
                    return Some(AcpStreamEvent::Raw {
                        line: trimmed.to_string(),
                    });
                } else if step_type == "thought" || step_type == "reasoning" {
                    let text = su
                        .get("text")
                        .or_else(|| su.get("detail"))
                        .or_else(|| su.get("thought"))
                        .or_else(|| su.get("thinking"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    return Some(AcpStreamEvent::ThoughtDelta {
                        text: text.to_string(),
                        is_done: state.eq_ignore_ascii_case("DONE") || state.eq_ignore_ascii_case("COMPLETED"),
                        duration_seconds: duration,
                    });
                } else if step_type == "tool" {
                    let tool_name = su.get("tool_name").and_then(|v| v.as_str()).unwrap_or("tool");
                    let tool_id = su
                        .get("tool_call_id")
                        .or_else(|| su.get("toolCallId"))
                        .or_else(|| su.pointer("/tool_info/id"))
                        .or_else(|| su.pointer("/tool_info/tool_call_id"))
                        .or_else(|| su.get("id"))
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.trim().is_empty())
                        .map(String::from)
                        .unwrap_or_else(|| format!("t_{}_{}", run_id, step_index));
                    let params = su
                        .pointer("/tool_info/parameters")
                        .or_else(|| su.get("parameters"))
                        .or_else(|| su.get("input"))
                        .cloned()
                        .unwrap_or(Value::Null);
                    let output = su
                        .pointer("/tool_info/output")
                        .or_else(|| su.pointer("/tool_info/error"))
                        .or_else(|| su.get("output"))
                        .or_else(|| su.get("result"))
                        .or_else(|| su.get("error"))
                        .or_else(|| su.get("content"))
                        .and_then(|v| {
                            if let Some(s) = v.as_str() {
                                if s.trim().is_empty() {
                                    None
                                } else {
                                    Some(s.to_string())
                                }
                            } else if !v.is_null() {
                                serde_json::to_string_pretty(v).ok()
                            } else {
                                None
                            }
                        });

                    let is_done = state.eq_ignore_ascii_case("DONE") || state.eq_ignore_ascii_case("COMPLETED");
                    let is_failed = state.eq_ignore_ascii_case("ERROR") || state.eq_ignore_ascii_case("FAILED");

                    let (tool_kind, _, _, command, file_path, _, _) =
                        classify_tool_metadata(tool_name, &params);

                    // Check if tool requires user approval
                    if tool_name == "ask_permission"
                        || tool_name == "ask_custom_permission"
                        || state.eq_ignore_ascii_case("WAITING_FOR_CONFIRMATION")
                        || state.eq_ignore_ascii_case("REQUIRES_APPROVAL")
                    {
                        let desc = params
                            .get("description")
                            .or_else(|| params.get("prompt"))
                            .or_else(|| params.get("CommandLine"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("El agente solicita permiso para ejecutar esta acción.");
                        let risk = if command.is_some() {
                            "command"
                        } else if file_path.is_some() {
                            "fileChange"
                        } else {
                            "unknown"
                        };
                        let (_, _, approval_title, ..) = classify_tool_metadata(tool_name, &params);

                        return Some(AcpStreamEvent::PermissionRequired {
                            approval: AcpApprovalRequest {
                                request_id: su
                                    .get("request_id")
                                    .and_then(|v| v.as_str())
                                    .map(String::from)
                                    .unwrap_or_else(|| format!("req_{}_{}", run_id, step_index)),
                                thread_id: thread_id.to_string(),
                                run_id: run_id.to_string(),
                                tool_name: tool_name.to_string(),
                                title: approval_title,
                                description: desc.to_string(),
                                risk: risk.to_string(),
                                impact: command.clone().or_else(|| file_path.clone()),
                                command,
                                path: file_path,
                                details: params,
                            },
                        });
                    }

                    let status = if is_failed {
                        "failed"
                    } else if is_done {
                        "completed"
                    } else {
                        "running"
                    };
                    let parent_tool_use_id = su
                        .get("parent_tool_use_id")
                        .or_else(|| val.get("parent_tool_use_id"))
                        .or_else(|| su.get("parentToolUseId"))
                        .and_then(|v| v.as_str())
                        .map(String::from);

                    return Some(AcpStreamEvent::ToolUpdate {
                        tool: build_acp_tool_call(
                            tool_id,
                            tool_name,
                            params,
                            status.to_string(),
                            output,
                            duration,
                            None,
                            Some(tool_kind),
                            None,
                            None,
                            command,
                            parent_tool_use_id,
                        ),
                    });
                }
                return Some(AcpStreamEvent::Raw {
                    line: trimmed.to_string(),
                });
            }
            "result" => {
                let status = val.pointer("/result/status").and_then(|v| v.as_str()).unwrap_or("SUCCESS");
                let in_tok = val.pointer("/result/usage/input_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
                let out_tok = val.pointer("/result/usage/output_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
                let duration = val.pointer("/result/duration_seconds").and_then(|v| v.as_f64()).unwrap_or(0.0);
                return Some(AcpStreamEvent::Result {
                    status: status.to_string(),
                    input_tokens: in_tok,
                    output_tokens: out_tok,
                    duration_seconds: duration,
                });
            }
            _ => {}
        }
    }

    // 2. Check for standard ACP JSON-RPC 2.0 notifications & requests (`"method": ...`)
    if let Some(method) = val.get("method").and_then(|v| v.as_str()) {
        let params = val.get("params").cloned().unwrap_or(Value::Null);
        match method {
            "session/new" | "session/initialize" | "session/init" => {
                let conv_id = params
                    .get("sessionId")
                    .or_else(|| params.get("session_id"))
                    .or_else(|| params.get("conversationId"))
                    .or_else(|| val.pointer("/result/sessionId"))
                    .or_else(|| val.pointer("/result/session_id"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let model = params.get("model").and_then(|v| v.as_str()).unwrap_or("").to_string();
                return Some(AcpStreamEvent::Init {
                    conversation_id: conv_id,
                    model,
                });
            }
            "session/update" => {
                let update = params.get("update").unwrap_or(&params);
                let update_type = update
                    .get("sessionUpdate")
                    .or_else(|| update.get("type"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                match update_type {
                    "content_delta" | "agent_message_chunk" => {
                        let text = update
                            .get("text")
                            .or_else(|| update.pointer("/content/text"))
                            .and_then(|v| v.as_str())?;
                        return Some(AcpStreamEvent::ContentDelta { text: text.to_string() });
                    }
                    "thought_delta" | "agent_thought_chunk" => {
                        let text = update
                            .get("text")
                            .or_else(|| update.pointer("/content/text"))
                            .and_then(|v| v.as_str())?;
                        let is_done = update.get("isDone").and_then(|v| v.as_bool()).unwrap_or(false);
                        return Some(AcpStreamEvent::ThoughtDelta {
                            text: text.to_string(),
                            is_done,
                            duration_seconds: update.get("durationSeconds").and_then(|v| v.as_f64()),
                        });
                    }
                    "tool_call" | "tool_call_update" => {
                        let output = update
                            .get("rawOutput")
                            .or_else(|| update.get("output"))
                            .and_then(|v| {
                                if let Some(s) = v.as_str() {
                                    Some(s.to_string())
                                } else if !v.is_null() {
                                    serde_json::to_string_pretty(v).ok()
                                } else {
                                    None
                                }
                            });
                        let parent_tool_use_id = update
                            .get("parent_tool_use_id")
                            .or_else(|| params.get("parent_tool_use_id"))
                            .or_else(|| val.get("parent_tool_use_id"))
                            .and_then(|v| v.as_str())
                            .map(String::from);

                        return Some(AcpStreamEvent::ToolUpdate {
                            tool: acp_tool_from_update(update, output, parent_tool_use_id),
                        });
                    }
                    "plan" | "plan_update" => {
                        let step = update
                            .get("step")
                            .or_else(|| update.get("title"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("Plan updated")
                            .to_string();
                        let status = update.get("status").and_then(|v| v.as_str()).unwrap_or("running").to_string();
                        return Some(AcpStreamEvent::PlanUpdate { step, status });
                    }
                    _ => {}
                }
            }
            "session/request_permission" | "permission/request" => {
                let req_id = val
                    .get("id")
                    .and_then(|v| {
                        if let Some(s) = v.as_str() {
                            Some(s.to_string())
                        } else {
                            v.as_i64().map(|n| n.to_string())
                        }
                    })
                    .or_else(|| params.get("requestId").and_then(|v| v.as_str()).map(String::from))
                    .unwrap_or_else(|| format!("acp_req_{}", run_id));

                let tool_call = params.get("toolCall").unwrap_or(&params);
                let tool_name = tool_call
                    .get("toolName")
                    .or_else(|| tool_call.get("name"))
                    .or_else(|| tool_call.get("title"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("ask_permission");
                let tool_params = tool_call
                    .get("rawInput")
                    .or_else(|| tool_call.get("parameters"))
                    .cloned()
                    .unwrap_or_else(|| params.clone());
                let (_, _, title, command, file_path, _, _) = classify_tool_metadata(tool_name, &tool_params);
                let desc = params
                    .get("description")
                    .or_else(|| tool_call.get("title"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("Se requiere confirmación para continuar con la herramienta.");
                let risk = if command.is_some() {
                    "command"
                } else if file_path.is_some() {
                    "fileChange"
                } else {
                    "unknown"
                };

                return Some(AcpStreamEvent::PermissionRequired {
                    approval: AcpApprovalRequest {
                        request_id: req_id,
                        thread_id: thread_id.to_string(),
                        run_id: run_id.to_string(),
                        tool_name: tool_name.to_string(),
                        title,
                        description: desc.to_string(),
                        risk: risk.to_string(),
                        impact: command.clone().or_else(|| file_path.clone()),
                        command,
                        path: file_path,
                        details: tool_params,
                    },
                });
            }
            _ => {}
        }
    }

    // 3. Check for Claude Code / Codex stream-json (`"type": ...`)
    if let Some(msg_type) = val.get("type").and_then(|v| v.as_str()) {
        if let Some(text) = extract_thought_text(&val) {
            return Some(AcpStreamEvent::ThoughtDelta {
                text,
                is_done: val.get("done").and_then(|v| v.as_bool()).unwrap_or(false)
                    || msg_type == "item.completed",
                duration_seconds: val
                    .get("duration_seconds")
                    .or_else(|| val.get("durationSeconds"))
                    .and_then(|v| v.as_f64()),
            });
        }
        if thought_frame_without_text(&val) {
            return Some(AcpStreamEvent::UnknownFrame {
                message: format!("Unrecognized {msg_type} frame"),
            });
        }
        match msg_type {
            "system" | "session" | "session_init" => {
                let conv_id = val
                    .get("session_id")
                    .or_else(|| val.get("sessionId"))
                    .or_else(|| val.get("conversation_id"))
                    .or_else(|| val.pointer("/data/session_id"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if !conv_id.is_empty() {
                    let model = val.get("model").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    return Some(AcpStreamEvent::Init {
                        conversation_id: conv_id.to_string(),
                        model,
                    });
                }
            }
            "step_start" | "step-start" => {
                let conv_id = val
                    .get("sessionID")
                    .or_else(|| val.get("sessionId"))
                    .or_else(|| val.get("session_id"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if !conv_id.is_empty() {
                    return Some(AcpStreamEvent::Init {
                        conversation_id: conv_id.to_string(),
                        model: String::new(),
                    });
                }
            }
            "content_block_delta" | "text_delta" | "text-delta" | "text" => {
                let text = val
                    .pointer("/delta/text")
                    .or_else(|| val.pointer("/part/text"))
                    .or_else(|| val.get("text"))
                    .and_then(|v| v.as_str())?;
                return Some(AcpStreamEvent::ContentDelta { text: text.to_string() });
            }
            "thinking" | "reasoning" => {
                let text = val
                    .get("thinking")
                    .or_else(|| val.get("text"))
                    .or_else(|| val.get("summary"))
                    .and_then(|v| v.as_str())?;
                return Some(AcpStreamEvent::ThoughtDelta {
                    text: text.to_string(),
                    is_done: val.get("done").and_then(|v| v.as_bool()).unwrap_or(false),
                    duration_seconds: val.get("duration_seconds").and_then(|v| v.as_f64()),
                });
            }
            "thread.started" => {
                let conv_id = val.get("thread_id").and_then(|v| v.as_str()).unwrap_or("");
                if !conv_id.is_empty() {
                    return Some(AcpStreamEvent::Init {
                        conversation_id: conv_id.to_string(),
                        model: String::new(),
                    });
                }
            }
            "item.completed" | "item.started" => {
                if let Some(item) = val.get("item") {
                    let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    if item_type == "agent_message" {
                        let text = item
                            .get("text")
                            .or_else(|| item.pointer("/content/0/text"))
                            .and_then(|v| v.as_str());
                        if let Some(t) = text {
                            if !t.is_empty() {
                                return Some(AcpStreamEvent::ContentDelta { text: t.to_string() });
                            }
                        }
                    } else if item_type == "reasoning" {
                        let text = item.get("text").and_then(|v| v.as_str());
                        if let Some(t) = text {
                            return Some(AcpStreamEvent::ThoughtDelta {
                                text: t.to_string(),
                                is_done: msg_type == "item.completed",
                                duration_seconds: None,
                            });
                        }
                    } else if item_type == "command_execution" {
                        let tool_id = item.get("id").and_then(|v| v.as_str()).unwrap_or("cmd_1").to_string();
                        let command = item.get("command").and_then(|v| v.as_str()).map(String::from);
                        let output = item.get("output").and_then(|v| v.as_str()).map(String::from);
                        let is_done = msg_type == "item.completed";
                        let status = if is_done {
                            let exit_code = item.get("exit_code").and_then(|v| v.as_i64()).unwrap_or(0);
                            if exit_code != 0 { "failed" } else { "completed" }
                        } else {
                            "running"
                        };
                        let title = command.as_ref().map(|c| {
                            let short: String = c.chars().take(72).collect();
                            format!("Run `{}`", short)
                        }).unwrap_or_else(|| "Command".into());
                        let detail = command.as_ref().map(|c| format!("$ {}", c)).unwrap_or_default();
                        return Some(AcpStreamEvent::ToolUpdate {
                            tool: build_acp_tool_call(
                                tool_id,
                                "command_execution",
                                serde_json::json!({ "command": command }),
                                status.to_string(),
                                output,
                                None,
                                None,
                                None,
                                Some(title),
                                Some(detail),
                                command,
                                val.get("parent_tool_use_id").and_then(|v| v.as_str()).map(String::from),
                            ),
                        });
                    } else if item_type == "mcp_tool_call" {
                        let tool_id = item.get("id").and_then(|v| v.as_str()).unwrap_or("mcp_1").to_string();
                        let tool_name = item.get("tool").or_else(|| item.get("name")).and_then(|v| v.as_str()).unwrap_or("tool");
                        let server_name = item.get("server").and_then(|v| v.as_str()).map(String::from);
                        let params = item.get("arguments").or_else(|| item.get("parameters")).cloned().unwrap_or(Value::Null);
                        let output = item.get("result").or_else(|| item.get("output")).and_then(|v| {
                            if let Some(s) = v.as_str() { Some(s.to_string()) }
                            else if !v.is_null() { serde_json::to_string_pretty(v).ok() }
                            else { None }
                        });
                        let is_done = msg_type == "item.completed";
                        return Some(AcpStreamEvent::ToolUpdate {
                            tool: build_acp_tool_call(
                                tool_id,
                                tool_name,
                                params,
                                if is_done { "completed".into() } else { "running".into() },
                                output,
                                None,
                                server_name,
                                None,
                                None,
                                None,
                                None,
                                val.get("parent_tool_use_id").and_then(|v| v.as_str()).map(String::from),
                            ),
                        });
                    } else if item_type == "file_change" {
                        let tool_id = item.get("id").and_then(|v| v.as_str()).unwrap_or("fc_1").to_string();
                        let is_done = msg_type == "item.completed";
                        let status = item
                            .get("status")
                            .and_then(|v| v.as_str())
                            .map(|s| match s {
                                "completed" | "done" | "succeeded" => "completed",
                                "failed" | "error" => "failed",
                                _ => if is_done { "completed" } else { "running" },
                            })
                            .unwrap_or(if is_done { "completed" } else { "running" });

                        let mut first_path: Option<String> = item
                            .get("path")
                            .or_else(|| item.get("file_path"))
                            .and_then(|v| v.as_str())
                            .map(str::to_string);
                        let mut total_add = 0usize;
                        let mut total_del = 0usize;
                        let mut has_counts = false;

                        if let Some(changes) = item.get("changes").and_then(|v| v.as_array()) {
                            for ch in changes {
                                if first_path.is_none() {
                                    first_path = ch.get("path").and_then(|v| v.as_str()).map(str::to_string);
                                }
                                if let Some(diff_str) = ch.get("diff").and_then(|v| v.as_str()) {
                                    if let Some((add, del)) = unified_diff_line_counts(diff_str) {
                                        total_add += add;
                                        total_del += del;
                                        has_counts = true;
                                    }
                                }
                            }
                        }
                        if !has_counts {
                            if let Some(diff_str) = item.get("diff").and_then(|v| v.as_str()) {
                                if let Some((add, del)) = unified_diff_line_counts(diff_str) {
                                    total_add = add;
                                    total_del = del;
                                    has_counts = true;
                                }
                            }
                        }

                        let mut tool = build_acp_tool_call(
                            tool_id,
                            "file_change",
                            serde_json::json!({ "path": first_path, "changes": item.get("changes") }),
                            status.to_string(),
                            item.get("output").and_then(|v| v.as_str()).map(String::from),
                            None,
                            None,
                            Some("fileChange".to_string()),
                            None,
                            None,
                            None,
                            val.get("parent_tool_use_id").and_then(|v| v.as_str()).map(String::from),
                        );
                        if tool.file_path.is_none() {
                            tool.file_path = first_path;
                        }
                        if has_counts {
                            tool.added_lines = Some(total_add);
                            tool.removed_lines = Some(total_del);
                        }
                        return Some(AcpStreamEvent::ToolUpdate { tool });
                    }
                }
            }
            "turn.completed" | "step_finish" | "step-finish" | "step.completed" => {
                let in_tok = val.pointer("/usage/input_tokens")
                    .or_else(|| val.pointer("/tokens/input"))
                    .or_else(|| val.pointer("/tokens/prompt"))
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0);
                let out_tok = val.pointer("/usage/output_tokens")
                    .or_else(|| val.pointer("/tokens/output"))
                    .or_else(|| val.pointer("/tokens/completion"))
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0);
                let dur = val.get("duration_seconds").or_else(|| val.get("duration")).and_then(|v| v.as_f64()).unwrap_or(0.0);
                let status = val.get("reason").and_then(|v| v.as_str()).unwrap_or("SUCCESS");
                return Some(AcpStreamEvent::Result {
                    status: status.to_string(),
                    input_tokens: in_tok,
                    output_tokens: out_tok,
                    duration_seconds: dur,
                });
            }
            "tool_use" | "tool_call" | "tool-call" | "tool-use" => {
                let part = val.get("part");
                let src = part.unwrap_or(&val);
                let tool_id = src
                    .get("callID")
                    .or_else(|| src.get("callId"))
                    .or_else(|| src.get("id"))
                    .or_else(|| src.get("tool_call_id"))
                    .or_else(|| val.get("callID"))
                    .or_else(|| val.get("id"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("tool_1")
                    .to_string();
                let tool_name = src
                    .get("tool")
                    .or_else(|| src.get("name"))
                    .or_else(|| src.get("tool_name"))
                    .or_else(|| val.get("tool"))
                    .or_else(|| val.get("name"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("tool");
                let params = src
                    .get("input")
                    .or_else(|| src.get("parameters"))
                    .or_else(|| src.get("arguments"))
                    .or_else(|| val.get("input"))
                    .cloned()
                    .unwrap_or(Value::Null);
                let parent_tool_use_id = src
                    .get("parent_tool_use_id")
                    .or_else(|| val.get("parent_tool_use_id"))
                    .and_then(|v| v.as_str())
                    .map(String::from);
                let initial_status = if response_indicates_failure("", Some(src), None, None) {
                    "failed".to_string()
                } else {
                    src.get("status")
                        .or_else(|| src.pointer("/state/status"))
                        .and_then(|v| v.as_str())
                        .map(|s| normalize_subagent_status(s, None))
                        .unwrap_or_else(|| "running".to_string())
                };
                return Some(AcpStreamEvent::ToolUpdate {
                    tool: build_acp_tool_call(
                        tool_id,
                        tool_name,
                        params,
                        initial_status,
                        None,
                        None,
                        None,
                        None,
                        None,
                        None,
                        None,
                        parent_tool_use_id,
                    ),
                });
            }
            "tool_result" | "tool-result" | "tool_output" | "tool-output" => {
                let part = val.get("part");
                let src = part.unwrap_or(&val);
                let tool_id = src
                    .get("callID")
                    .or_else(|| src.get("callId"))
                    .or_else(|| src.get("tool_use_id"))
                    .or_else(|| src.get("id"))
                    .or_else(|| src.get("tool_call_id"))
                    .or_else(|| val.get("callID"))
                    .or_else(|| val.get("id"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("tool_1")
                    .to_string();
                let tool_name = src
                    .get("tool")
                    .or_else(|| src.get("name"))
                    .or_else(|| src.get("tool_name"))
                    .or_else(|| val.get("tool"))
                    .or_else(|| val.get("name"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let output = src
                    .get("output")
                    .or_else(|| src.get("result"))
                    .or_else(|| src.get("content"))
                    .or_else(|| val.get("output"))
                    .and_then(|v| {
                        if let Some(s) = v.as_str() {
                            Some(s.to_string())
                        } else if !v.is_null() {
                            serde_json::to_string_pretty(v).ok()
                        } else {
                            None
                        }
                    });
                let is_error = src
                    .get("is_error")
                    .or_else(|| src.get("isError"))
                    .or_else(|| val.get("is_error"))
                    .or_else(|| val.get("isError"))
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
                    || response_indicates_failure("", Some(src), None, output.as_deref())
                    || response_indicates_failure("", Some(&val), None, None);
                let status = if is_error { "failed" } else { "completed" };
                let parent_tool_use_id = src
                    .get("parent_tool_use_id")
                    .or_else(|| val.get("parent_tool_use_id"))
                    .and_then(|v| v.as_str())
                    .map(String::from);
                return Some(AcpStreamEvent::ToolUpdate {
                    tool: build_acp_tool_call(
                        tool_id,
                        tool_name,
                        Value::Null,
                        status.to_string(),
                        output,
                        None,
                        None,
                        if tool_name.is_empty() { Some("dynamicToolCall".to_string()) } else { None },
                        if tool_name.is_empty() { Some(String::new()) } else { None },
                        if tool_name.is_empty() { Some(String::new()) } else { None },
                        None,
                        parent_tool_use_id,
                    ),
                });
            }
            "assistant" | "user" => {
                if let Some(parts) = val.pointer("/message/content").and_then(|v| v.as_array()) {
                    let parent_tool_use_id = val
                        .get("parent_tool_use_id")
                        .and_then(|v| v.as_str())
                        .map(String::from);
                    for part in parts {
                        match part.get("type").and_then(|v| v.as_str()).unwrap_or("") {
                            "tool_use" => {
                                let tool_id = part.get("id").and_then(|v| v.as_str()).unwrap_or("tool_1").to_string();
                                let tool_name = part.get("name").and_then(|v| v.as_str()).unwrap_or("tool");
                                let params = part.get("input").cloned().unwrap_or(Value::Null);
                                return Some(AcpStreamEvent::ToolUpdate {
                                    tool: build_acp_tool_call(
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
                                        parent_tool_use_id,
                                    ),
                                });
                            }
                            "tool_result" => {
                                let tool_id = part.get("tool_use_id").or_else(|| part.get("id")).and_then(|v| v.as_str()).unwrap_or("tool_1").to_string();
                                let output = part.get("content").and_then(|v| {
                                    if let Some(s) = v.as_str() { Some(s.to_string()) }
                                    else if !v.is_null() { serde_json::to_string_pretty(v).ok() }
                                    else { None }
                                });
                                let is_error = part.get("is_error").and_then(|v| v.as_bool()).unwrap_or(false);
                                return Some(AcpStreamEvent::ToolUpdate {
                                    tool: build_acp_tool_call(
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
                                        parent_tool_use_id,
                                    ),
                                });
                            }
                            "text" => {
                                if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
                                    if !text.is_empty() {
                                        return Some(AcpStreamEvent::ContentDelta { text: text.to_string() });
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }
            _ => {}
        }
    }

    None
}

/// Formats an approval response payload to write to the child process `stdin` via JSON-RPC 2.0 / ACP.
pub fn format_acp_approval_response(request_id: &str, decision: &str) -> String {
    let normalized = decision.trim().to_lowercase();
    let approved = matches!(
        normalized.as_str(),
        "accept" | "accepted" | "approve" | "approved" | "allow" | "allow_once" | "accept_for_session" | "allow_always"
    );
    let outcome = if normalized == "accept_for_session" || normalized == "allow_always" {
        "allow_always"
    } else if approved {
        "allow_once"
    } else {
        "reject_once"
    };

    let rpc_id: Value = if let Ok(num) = request_id.parse::<i64>() {
        json!(num)
    } else {
        json!(request_id)
    };

    let payload = json!({
        "jsonrpc": "2.0",
        "id": rpc_id,
        "result": {
            "outcome": {
                "outcome": "selected",
                "optionId": outcome
            },
            "approved": approved,
            "decision": if approved { "approve" } else { "deny" }
        }
    });

    format!("{}\n", payload.to_string())
}
