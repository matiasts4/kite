//! Antigravity Agent Client Protocol (ACP) & Stream Protocol Engine
//! Provides structured bidirectional communication, interactive tool approvals,
//! and live thought/tool delta dispatch.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpModelDescriptor {
    pub id: String,
    pub name: String,
    pub description: String,
    pub supports_effort: bool,
    pub effort_options: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpToolCall {
    pub id: String,
    pub name: String,
    pub title: String,
    pub detail: String,
    pub tool_kind: String, // "commandExecution" | "fileChange" | "mcpToolCall" | "webSearch" | "dynamicToolCall"
    pub server_name: Option<String>,
    pub command: Option<String>,
    pub file_path: Option<String>,
    pub added_lines: Option<usize>,
    pub removed_lines: Option<usize>,
    pub parameters: Value,
    pub status: String, // "pending" | "running" | "completed" | "failed" | "requiresApproval"
    pub output: Option<String>,
    pub duration_seconds: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpApprovalRequest {
    pub request_id: String,
    pub thread_id: String,
    pub run_id: String,
    pub tool_name: String,
    pub title: String,
    pub description: String,
    pub risk: String, // "command" | "fileChange" | "externalWrite" | "creditUse" | "unknown"
    pub impact: Option<String>,
    pub command: Option<String>,
    pub path: Option<String>,
    pub details: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AcpStreamEvent {
    Init {
        conversation_id: String,
        model: String,
    },
    ThoughtDelta {
        text: String,
        is_done: bool,
        duration_seconds: Option<f64>,
    },
    ContentDelta {
        text: String,
    },
    ToolUpdate {
        tool: AcpToolCall,
    },
    PermissionRequired {
        approval: AcpApprovalRequest,
    },
    PlanUpdate {
        step: String,
        status: String,
    },
    Result {
        status: String,
        input_tokens: i64,
        output_tokens: i64,
        duration_seconds: f64,
    },
    Raw {
        line: String,
    },
}

/// Resolves the Antigravity ACP or CLI binary across standard installation paths.
pub fn resolve_antigravity_acp_binary() -> Option<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        candidates.push(PathBuf::from(&local).join("agy").join("bin").join("agy.exe"));
        candidates.push(PathBuf::from(&local).join("Programs").join("antigravity-acp").join("antigravity-acp.exe"));
    }
    if let Ok(user) = std::env::var("USERPROFILE") {
        candidates.push(PathBuf::from(&user).join(".gemini").join("antigravity").join("antigravity-acp.exe"));
    }

    for c in candidates {
        if c.is_file() {
            return Some(c);
        }
    }

    if let Ok(path_var) = std::env::var("PATH") {
        for segment in std::env::split_paths(&path_var) {
            let agy = segment.join("agy.exe");
            if agy.is_file() {
                return Some(agy);
            }
            let acp = segment.join("antigravity-acp.exe");
            if acp.is_file() {
                return Some(acp);
            }
        }
    }

    None
}

fn classify_tool_metadata(raw_name: &str, params: &Value) -> (String, Option<String>, String, Option<String>, Option<String>, Option<usize>, Option<usize>) {
    let lower = raw_name.to_lowercase();

    // Extract MCP server name & clean tool name if formatted like mcp__server__tool or mcp_server_tool or call_mcp_tool
    let mut server_name = params
        .get("ServerName")
        .or_else(|| params.get("serverName"))
        .or_else(|| params.get("server_name"))
        .and_then(|v| v.as_str())
        .map(String::from);

    let mut clean_name = raw_name.to_string();
    if raw_name == "call_mcp_tool" {
        if let Some(tn) = params.get("ToolName").or_else(|| params.get("toolName")).and_then(|v| v.as_str()) {
            clean_name = tn.to_string();
        }
    } else if let Some(rest) = raw_name.strip_prefix("mcp__") {
        let parts: Vec<&str> = rest.splitn(2, "__").collect();
        if parts.len() == 2 {
            server_name = Some(parts[0].to_string());
            clean_name = parts[1].to_string();
        }
    } else if let Some(rest) = raw_name.strip_prefix("mcp_") {
        let parts: Vec<&str> = rest.splitn(2, '_').collect();
        if parts.len() == 2 && server_name.is_none() {
            server_name = Some(parts[0].to_string());
            clean_name = parts[1].to_string();
        }
    }

    let command = params
        .get("CommandLine")
        .or_else(|| params.get("command"))
        .or_else(|| params.get("cmd"))
        .and_then(|v| v.as_str())
        .map(String::from);

    let file_path = params
        .get("TargetFile")
        .or_else(|| params.get("AbsolutePath"))
        .or_else(|| params.get("file_path"))
        .or_else(|| params.get("path"))
        .and_then(|v| v.as_str())
        .map(String::from);

    let mut added_lines = None;
    let mut removed_lines = None;
    if let (Some(target), Some(replacement)) = (
        params.get("TargetContent").or_else(|| params.get("old_string")).and_then(|v| v.as_str()),
        params.get("ReplacementContent").or_else(|| params.get("new_string")).and_then(|v| v.as_str()),
    ) {
        removed_lines = Some(target.lines().count().max(1));
        added_lines = Some(replacement.lines().count().max(1));
    } else if let Some(code) = params.get("CodeContent").or_else(|| params.get("content")).and_then(|v| v.as_str()) {
        if file_path.is_some() {
            added_lines = Some(code.lines().count().max(1));
            removed_lines = Some(0);
        }
    }

    let tool_kind = if server_name.is_some() || lower.contains("mcp") {
        "mcpToolCall"
    } else if command.is_some() || lower.contains("bash") || lower.contains("command") || lower.contains("shell") || lower.contains("exec") {
        "commandExecution"
    } else if added_lines.is_some()
        || lower.contains("edit")
        || lower.contains("write")
        || lower.contains("replace")
        || lower.contains("patch")
    {
        "fileChange"
    } else if lower.contains("web") || lower.contains("url") || lower.contains("browser") || lower.contains("fetch") {
        "webSearch"
    } else {
        "dynamicToolCall"
    };

    let explicit_action = params
        .get("toolAction")
        .or_else(|| params.get("toolSummary"))
        .or_else(|| params.get("Instruction"))
        .or_else(|| params.get("Description"))
        .and_then(|v| v.as_str())
        .map(String::from);

    let title = if let Some(action) = explicit_action {
        action
    } else if let Some(ref srv) = server_name {
        format!("{} · {}", srv, clean_name)
    } else if let Some(ref cmd) = command {
        let short_cmd: String = cmd.chars().take(72).collect();
        format!("Run `{}`", short_cmd)
    } else if let Some(ref fp) = file_path {
        let base = Path::new(fp).file_name().and_then(|s| s.to_str()).unwrap_or(fp);
        if tool_kind == "fileChange" {
            format!("Edit {}", base)
        } else {
            format!("Read {}", base)
        }
    } else {
        clean_name.replace('_', " ")
    };

    (
        tool_kind.to_string(),
        server_name,
        title,
        command,
        file_path,
        added_lines,
        removed_lines,
    )
}

fn summarize_tool_detail(params: &Value, output: &Option<String>, command: &Option<String>, file_path: &Option<String>) -> String {
    let mut parts = Vec::new();
    if let Some(cmd) = command {
        parts.push(format!("$ {}", cmd));
    } else if let Some(fp) = file_path {
        parts.push(fp.clone());
    } else if !params.is_null() {
        if let Ok(pretty) = serde_json::to_string_pretty(params) {
            if pretty != "{}" && pretty != "null" {
                parts.push(pretty);
            }
        }
    }
    if let Some(out) = output {
        let trimmed = out.trim();
        if !trimmed.is_empty() {
            parts.push(trimmed.to_string());
        }
    }
    parts.join("\n\n")
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

                if step_type == "agent_response" {
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
                } else if step_type == "thought" || step_type == "reasoning" {
                    let text = su
                        .get("text")
                        .or_else(|| su.get("detail"))
                        .or_else(|| su.get("thought"))
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
                        .or_else(|| su.get("id"))
                        .and_then(|v| v.as_str())
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
                        .or_else(|| su.get("output"))
                        .or_else(|| su.get("result"))
                        .and_then(|v| {
                            if let Some(s) = v.as_str() {
                                Some(s.to_string())
                            } else if !v.is_null() {
                                serde_json::to_string_pretty(v).ok()
                            } else {
                                None
                            }
                        });

                    let is_done = state.eq_ignore_ascii_case("DONE") || state.eq_ignore_ascii_case("COMPLETED");
                    let is_failed = state.eq_ignore_ascii_case("ERROR") || state.eq_ignore_ascii_case("FAILED");

                    let (tool_kind, server_name, title, command, file_path, added_lines, removed_lines) =
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
                                title: title.clone(),
                                description: desc.to_string(),
                                risk: risk.to_string(),
                                impact: command.clone().or_else(|| file_path.clone()),
                                command,
                                path: file_path,
                                details: params,
                            },
                        });
                    }

                    let detail = summarize_tool_detail(&params, &output, &command, &file_path);
                    let status = if is_failed {
                        "failed"
                    } else if is_done {
                        "completed"
                    } else {
                        "running"
                    };

                    return Some(AcpStreamEvent::ToolUpdate {
                        tool: AcpToolCall {
                            id: tool_id,
                            name: tool_name.to_string(),
                            title,
                            detail,
                            tool_kind,
                            server_name,
                            command,
                            file_path,
                            added_lines,
                            removed_lines,
                            parameters: params,
                            status: status.to_string(),
                            output,
                            duration_seconds: duration,
                        },
                    });
                }
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
                        let tool_id = update
                            .get("toolCallId")
                            .or_else(|| update.get("id"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("acp_tool")
                            .to_string();
                        let tool_name = update
                            .get("toolName")
                            .or_else(|| update.get("name"))
                            .or_else(|| update.get("title"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("tool");
                        let raw_status = update.get("status").and_then(|v| v.as_str()).unwrap_or("running");
                        let status = match raw_status {
                            "completed" | "done" | "succeeded" => "completed",
                            "failed" | "error" => "failed",
                            "pending" => "pending",
                            _ => "running",
                        };
                        let tool_params = update
                            .get("rawInput")
                            .or_else(|| update.get("parameters"))
                            .or_else(|| update.get("input"))
                            .cloned()
                            .unwrap_or(Value::Null);
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
                        let (tool_kind, server_name, title, command, file_path, added_lines, removed_lines) =
                            classify_tool_metadata(tool_name, &tool_params);
                        let detail = summarize_tool_detail(&tool_params, &output, &command, &file_path);

                        return Some(AcpStreamEvent::ToolUpdate {
                            tool: AcpToolCall {
                                id: tool_id,
                                name: tool_name.to_string(),
                                title,
                                detail,
                                tool_kind,
                                server_name,
                                command,
                                file_path,
                                added_lines,
                                removed_lines,
                                parameters: tool_params,
                                status: status.to_string(),
                                output,
                                duration_seconds: update.get("durationSeconds").and_then(|v| v.as_f64()),
                            },
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
            "content_block_delta" | "text_delta" => {
                let text = val
                    .pointer("/delta/text")
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
            "tool_use" | "tool_call" => {
                let tool_id = val.get("id").and_then(|v| v.as_str()).unwrap_or("tool_1").to_string();
                let tool_name = val.get("name").and_then(|v| v.as_str()).unwrap_or("tool");
                let params = val.get("input").or_else(|| val.get("parameters")).cloned().unwrap_or(Value::Null);
                let (tool_kind, server_name, title, command, file_path, added_lines, removed_lines) =
                    classify_tool_metadata(tool_name, &params);
                let detail = summarize_tool_detail(&params, &None, &command, &file_path);
                return Some(AcpStreamEvent::ToolUpdate {
                    tool: AcpToolCall {
                        id: tool_id,
                        name: tool_name.to_string(),
                        title,
                        detail,
                        tool_kind,
                        server_name,
                        command,
                        file_path,
                        added_lines,
                        removed_lines,
                        parameters: params,
                        status: "running".to_string(),
                        output: None,
                        duration_seconds: None,
                    },
                });
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

fn user_home_dir() -> PathBuf {
    if let Ok(p) = std::env::var("USERPROFILE") {
        PathBuf::from(p)
    } else if let Ok(h) = std::env::var("HOME") {
        PathBuf::from(h)
    } else {
        PathBuf::from(".")
    }
}

/// Discovers native MCP servers grouped by provider (Antigravity, Claude Code, Codex, Cursor, Gemini, and Kite built-in).
#[tauri::command]
pub fn list_provider_mcp_servers(request: Option<Value>) -> Value {
    let filter_provider = request
        .as_ref()
        .and_then(|v| v.get("provider").or_else(|| v.get("engine")))
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_lowercase());

    let home = user_home_dir();
    let mut providers: Vec<Value> = Vec::new();
    let mut all_servers: Vec<Value> = Vec::new();

    // 1. Built-in Kite Native MCP (Available to all providers)
    let kite_builtin = json!({
        "id": "mcp:kite:kite-tasks",
        "name": "kite-tasks",
        "provider": "kite",
        "providerLabel": "Kite Native",
        "transport": "stdio",
        "status": "connected",
        "builtin": true,
        "description": "Local workspace task board & ticket orchestration MCP server.",
        "toolCount": 5,
        "tools": ["list_tasks", "get_task", "create_task", "update_task", "add_task_comment"],
        "sourcePath": "kite-code mcp-tasks"
    });
    all_servers.push(kite_builtin.clone());

    // 2. Antigravity Native MCPs (~/.gemini/antigravity-cli/mcp/* and ~/.gemini/antigravity/mcp_config.json)
    let mut agy_servers: Vec<Value> = Vec::new();
    let agy_mcp_dir = home.join(".gemini").join("antigravity-cli").join("mcp");
    if agy_mcp_dir.is_dir() {
        if let Ok(entries) = std::fs::read_dir(&agy_mcp_dir) {
            let mut dirs: Vec<PathBuf> = entries.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
            dirs.sort();
            for dir in dirs {
                let Some(server_name) = dir.file_name().and_then(|n| n.to_str()).map(String::from) else {
                    continue;
                };
                let mut tools: Vec<String> = Vec::new();
                if let Ok(files) = std::fs::read_dir(&dir) {
                    for f in files.flatten() {
                        let path = f.path();
                        if path.extension().and_then(|e| e.to_str()) == Some("json") {
                            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                                tools.push(stem.to_string());
                            }
                        }
                    }
                }
                tools.sort();
                let srv = json!({
                    "id": format!("mcp:antigravity:{}", server_name),
                    "name": server_name,
                    "provider": "antigravity",
                    "providerLabel": "Antigravity",
                    "transport": "native-schema",
                    "status": "ready",
                    "builtin": false,
                    "description": format!("Antigravity native MCP server ({} tools discovered)", tools.len()),
                    "toolCount": tools.len(),
                    "tools": tools,
                    "sourcePath": dir.to_string_lossy().to_string()
                });
                agy_servers.push(srv.clone());
                all_servers.push(srv);
            }
        }
    }

    // Also inspect ~/.gemini/antigravity/mcp_config.json if present
    let agy_config_path = home.join(".gemini").join("antigravity").join("mcp_config.json");
    if agy_config_path.is_file() {
        if let Ok(raw) = std::fs::read_to_string(&agy_config_path) {
            if let Ok(parsed) = serde_json::from_str::<Value>(&raw) {
                if let Some(obj) = parsed.get("mcpServers").and_then(|v| v.as_object()) {
                    for (name, cfg) in obj {
                        let id = format!("mcp:antigravity:{}", name);
                        if !agy_servers.iter().any(|s| s.get("id").and_then(|v| v.as_str()) == Some(&id)) {
                            let cmd = cfg.get("command").and_then(|v| v.as_str()).unwrap_or("stdio");
                            let srv = json!({
                                "id": id,
                                "name": name,
                                "provider": "antigravity",
                                "providerLabel": "Antigravity",
                                "transport": cmd,
                                "status": "configured",
                                "builtin": false,
                                "description": format!("Configured in mcp_config.json ({})", cmd),
                                "toolCount": 0,
                                "tools": [],
                                "sourcePath": agy_config_path.to_string_lossy().to_string()
                            });
                            agy_servers.push(srv.clone());
                            all_servers.push(srv);
                        }
                    }
                }
            }
        }
    }

    providers.push(json!({
        "provider": "antigravity",
        "label": "Antigravity",
        "configPath": agy_mcp_dir.to_string_lossy().to_string(),
        "servers": agy_servers
    }));

    // 3. Claude Code Native MCPs (~/.claude.json)
    let mut claude_servers: Vec<Value> = Vec::new();
    let claude_path = home.join(".claude.json");
    if claude_path.is_file() {
        if let Ok(raw) = std::fs::read_to_string(&claude_path) {
            if let Ok(parsed) = serde_json::from_str::<Value>(&raw) {
                if let Some(obj) = parsed.get("mcpServers").and_then(|v| v.as_object()) {
                    for (name, cfg) in obj {
                        let cmd = cfg
                            .get("command")
                            .or_else(|| cfg.get("url"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("stdio");
                        let srv = json!({
                            "id": format!("mcp:claude-code:{}", name),
                            "name": name,
                            "provider": "claude-code",
                            "providerLabel": "Claude Code",
                            "transport": cmd,
                            "status": "configured",
                            "builtin": false,
                            "description": format!("Claude Code MCP server ({})", cmd),
                            "toolCount": 0,
                            "tools": [],
                            "sourcePath": claude_path.to_string_lossy().to_string()
                        });
                        claude_servers.push(srv.clone());
                        all_servers.push(srv);
                    }
                }
            }
        }
    }
    providers.push(json!({
        "provider": "claude-code",
        "label": "Claude Code",
        "configPath": claude_path.to_string_lossy().to_string(),
        "servers": claude_servers
    }));

    // 4. Codex Native MCPs (~/.codex/config.toml)
    let mut codex_servers: Vec<Value> = Vec::new();
    let codex_path = home.join(".codex").join("config.toml");
    if codex_path.is_file() {
        if let Ok(raw) = std::fs::read_to_string(&codex_path) {
            for line in raw.lines() {
                let trimmed = line.trim();
                if let Some(rest) = trimmed.strip_prefix("[mcp_servers.") {
                    if let Some(name) = rest.strip_suffix(']') {
                        let clean = name.trim_matches('"').trim_matches('\'');
                        if !clean.is_empty() && !clean.contains('.') {
                            let srv = json!({
                                "id": format!("mcp:codex:{}", clean),
                                "name": clean,
                                "provider": "codex",
                                "providerLabel": "Codex",
                                "transport": "toml",
                                "status": "configured",
                                "builtin": false,
                                "description": "Configured in ~/.codex/config.toml",
                                "toolCount": 0,
                                "tools": [],
                                "sourcePath": codex_path.to_string_lossy().to_string()
                            });
                            codex_servers.push(srv.clone());
                            all_servers.push(srv);
                        }
                    }
                }
            }
        }
    }
    providers.push(json!({
        "provider": "codex",
        "label": "Codex",
        "configPath": codex_path.to_string_lossy().to_string(),
        "servers": codex_servers
    }));

    // 5. Cursor Native MCPs (~/.cursor/mcp.json)
    let mut cursor_servers: Vec<Value> = Vec::new();
    let cursor_path = home.join(".cursor").join("mcp.json");
    if cursor_path.is_file() {
        if let Ok(raw) = std::fs::read_to_string(&cursor_path) {
            if let Ok(parsed) = serde_json::from_str::<Value>(&raw) {
                if let Some(obj) = parsed.get("mcpServers").and_then(|v| v.as_object()) {
                    for (name, cfg) in obj {
                        let cmd = cfg.get("command").or_else(|| cfg.get("url")).and_then(|v| v.as_str()).unwrap_or("stdio");
                        let srv = json!({
                            "id": format!("mcp:cursor:{}", name),
                            "name": name,
                            "provider": "cursor",
                            "providerLabel": "Cursor",
                            "transport": cmd,
                            "status": "configured",
                            "builtin": false,
                            "description": format!("Cursor MCP server ({})", cmd),
                            "toolCount": 0,
                            "tools": [],
                            "sourcePath": cursor_path.to_string_lossy().to_string()
                        });
                        cursor_servers.push(srv.clone());
                        all_servers.push(srv);
                    }
                }
            }
        }
    }
    providers.push(json!({
        "provider": "cursor",
        "label": "Cursor",
        "configPath": cursor_path.to_string_lossy().to_string(),
        "servers": cursor_servers
    }));

    // 6. Gemini CLI Native MCPs (~/.gemini/settings.json)
    let mut gemini_servers: Vec<Value> = Vec::new();
    let gemini_path = home.join(".gemini").join("settings.json");
    if gemini_path.is_file() {
        if let Ok(raw) = std::fs::read_to_string(&gemini_path) {
            if let Ok(parsed) = serde_json::from_str::<Value>(&raw) {
                if let Some(obj) = parsed.get("mcpServers").and_then(|v| v.as_object()) {
                    for (name, cfg) in obj {
                        let cmd = cfg.get("command").or_else(|| cfg.get("url")).and_then(|v| v.as_str()).unwrap_or("stdio");
                        let srv = json!({
                            "id": format!("mcp:gemini:{}", name),
                            "name": name,
                            "provider": "gemini",
                            "providerLabel": "Gemini CLI",
                            "transport": cmd,
                            "status": "configured",
                            "builtin": false,
                            "description": format!("Gemini CLI MCP server ({})", cmd),
                            "toolCount": 0,
                            "tools": [],
                            "sourcePath": gemini_path.to_string_lossy().to_string()
                        });
                        gemini_servers.push(srv.clone());
                        all_servers.push(srv);
                    }
                }
            }
        }
    }
    providers.push(json!({
        "provider": "gemini",
        "label": "Gemini CLI",
        "configPath": gemini_path.to_string_lossy().to_string(),
        "servers": gemini_servers
    }));

    let filtered_servers: Vec<Value> = if let Some(ref p) = filter_provider {
        all_servers
            .iter()
            .filter(|s| {
                let sp = s.get("provider").and_then(|v| v.as_str()).unwrap_or("");
                sp == p || sp == "kite"
            })
            .cloned()
            .collect()
    } else {
        all_servers.clone()
    };

    json!({
        "providers": providers,
        "servers": filtered_servers,
        "allServers": all_servers
    })
}

/// Reads active Antigravity credentials and ~/.gemini/google_accounts.json to list accounts.
#[tauri::command]
pub fn antigravity_list_google_accounts() -> Result<Value, String> {
    let home = if let Ok(p) = std::env::var("USERPROFILE") {
        PathBuf::from(p)
    } else if let Ok(h) = std::env::var("HOME") {
        PathBuf::from(h)
    } else {
        PathBuf::from(".")
    };

    let active_from_cred = crate::quota::read_antigravity_credential().map(|(e, _)| e);
    let mut active = active_from_cred.unwrap_or_default();
    let mut all: Vec<String> = Vec::new();

    let accounts_path = home.join(".gemini").join("google_accounts.json");
    if accounts_path.is_file() {
        if let Ok(raw) = std::fs::read_to_string(&accounts_path) {
            if let Ok(val) = serde_json::from_str::<Value>(&raw) {
                if active.is_empty() {
                    active = val.get("active").and_then(|v| v.as_str()).unwrap_or("").to_string();
                }
                if let Some(file_active) = val.get("active").and_then(|v| v.as_str()) {
                    if !file_active.is_empty() && !all.contains(&file_active.to_string()) {
                        all.push(file_active.to_string());
                    }
                }
                if let Some(old) = val.get("old").and_then(|v| v.as_array()) {
                    for email_val in old {
                        if let Some(email) = email_val.as_str() {
                            if !email.is_empty() && !all.contains(&email.to_string()) {
                                all.push(email.to_string());
                            }
                        }
                    }
                }
            }
        }
    }

    if !active.is_empty() && !all.contains(&active) {
        all.insert(0, active.clone());
    }

    Ok(json!({
        "active": if active.is_empty() { Value::Null } else { json!(active) },
        "accounts": all
    }))
}

/// Switches the active Google account in ~/.gemini/google_accounts.json.
#[tauri::command]
pub fn antigravity_set_active_google_account(email: String) -> Result<Value, String> {
    let target = email.trim();
    let home = if let Ok(p) = std::env::var("USERPROFILE") {
        PathBuf::from(p)
    } else if let Ok(h) = std::env::var("HOME") {
        PathBuf::from(h)
    } else {
        PathBuf::from(".")
    };

    let accounts_path = home.join(".gemini").join("google_accounts.json");
    let mut current_data: Value = if accounts_path.is_file() {
        let raw = std::fs::read_to_string(&accounts_path).unwrap_or_default();
        serde_json::from_str(&raw).unwrap_or(json!({}))
    } else {
        json!({ "active": "", "old": [] })
    };

    let prev_active = current_data.get("active").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let mut old_list: Vec<String> = current_data.get("old")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default();

    if !prev_active.is_empty() && prev_active.as_str() != target && !old_list.iter().any(|e| e == &prev_active) {
        old_list.push(prev_active);
    }
    old_list.retain(|e| e.as_str() != target);

    current_data["active"] = json!(target);
    current_data["old"] = json!(old_list);

    let parent = accounts_path.parent().unwrap_or(Path::new("."));
    let _ = std::fs::create_dir_all(parent);
    let serialized = serde_json::to_string_pretty(&current_data).map_err(|e| e.to_string())?;
    std::fs::write(&accounts_path, serialized).map_err(|e| e.to_string())?;

    let all_accounts: Vec<String> = std::iter::once(target.to_string())
        .chain(old_list.into_iter())
        .collect();

    Ok(json!({
        "success": true,
        "active": target,
        "accounts": all_accounts
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_antigravity_list_google_accounts() {
        let res = antigravity_list_google_accounts().unwrap();
        println!("LIST GOOGLE ACCOUNTS: {}", serde_json::to_string_pretty(&res).unwrap());
        assert_eq!(res.get("active").and_then(|v| v.as_str()), Some("arxonlabs@gmail.com"));
        let arr = res.get("accounts").and_then(|v| v.as_array()).unwrap();
        assert!(arr.iter().any(|v| v.as_str() == Some("arxonlabs@gmail.com")));
    }
}
