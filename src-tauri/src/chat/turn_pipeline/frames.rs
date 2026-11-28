use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::acp::{
    classify_tool_metadata, extract_subagent_meta, extract_swarm_meta, merge_subagent_meta,
    merge_swarm_meta, response_indicates_failure, SubagentMeta, SwarmMeta,
};
use crate::chat::session::ApprovalDecision;

use super::*;

pub(super) fn reverse_request(frame: &Value) -> Option<ProviderTurnEvent> {
    let method = frame.get("method").and_then(Value::as_str)?;
    match method {
        "x.ai/ask_user_question" | "_x.ai/ask_user_question" | "AskUserQuestion" => {
            Some(ProviderTurnEvent::UserInputRequested {
                request: user_input_from(frame),
            })
        }
        "x.ai/exit_plan_mode" | "_x.ai/exit_plan_mode" => Some(plan_event(
            frame.get("params").unwrap_or(frame),
        )),
        "session/request_permission" | "permission/request" => Some(approval_event(frame)),
        _ => None,
    }
}

pub(super) fn user_input_from(frame: &Value) -> UserInputRequest {
    let params = frame.get("params").unwrap_or(frame);
    let request_id = params
        .get("id")
        .or_else(|| frame.get("id"))
        .and_then(Value::as_str)
        .unwrap_or("question")
        .to_string();
    let rows = params
        .get("questions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_else(|| vec![params.clone()]);
    let questions = rows
        .iter()
        .enumerate()
        .map(|(index, row)| UserQuestion {
            id: row
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| format!("q{index}")),
            header: row
                .get("header")
                .or_else(|| row.get("question"))
                .and_then(Value::as_str)
                .unwrap_or("Question")
                .to_string(),
            options: row
                .get("options")
                .and_then(Value::as_array)
                .map(|options| {
                    options
                        .iter()
                        .filter_map(|option| {
                            option
                                .as_str()
                                .or_else(|| option.get("label").and_then(Value::as_str))
                                .map(str::to_string)
                        })
                        .collect()
                })
                .unwrap_or_default(),
            allow_custom_answer: row
                .get("allowCustomAnswer")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            allow_attachments: row
                .get("allowAttachments")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            multi_select: row.get("multiSelect").and_then(Value::as_bool).unwrap_or(false),
        })
        .collect();
    UserInputRequest {
        request_id,
        questions,
    }
}

pub(super) fn approval_event(frame: &Value) -> ProviderTurnEvent {
    let params = frame.get("params").unwrap_or(frame);
    let raw_id = params.get("id").or_else(|| frame.get("id"));
    let (request_id, rpc_id_is_string) = match raw_id {
        Some(Value::String(s)) if !s.trim().is_empty() => (s.clone(), true),
        Some(Value::Number(n)) => (n.to_string(), false),
        _ => ("approval".to_string(), true),
    };
    let tool_call = params.get("toolCall").or_else(|| params.get("tool_call"));
    let fallback_kind = tool_call
        .and_then(|tc| tc.get("kind"))
        .and_then(Value::as_str)
        .map(str::trim)
        .map(|k| match k.to_ascii_lowercase().as_str() {
            "execute" | "command" => "bash",
            "edit" | "write" => "edit_file",
            _ => k,
        });
    let tool_name = params
        .get("toolName")
        .or_else(|| params.get("tool_name"))
        .or_else(|| tool_call.and_then(|tc| tc.get("name")))
        .or_else(|| tool_call.and_then(|tc| tc.get("toolName")))
        .or_else(|| tool_call.and_then(|tc| tc.get("tool_name")))
        .or_else(|| tool_call.and_then(|tc| tc.get("tool")))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or(fallback_kind)
        .unwrap_or("tool")
        .to_string();

    let raw_input = tool_call
        .and_then(|tc| {
            tc.get("rawInput")
                .or_else(|| tc.get("args"))
                .or_else(|| tc.get("input"))
                .or_else(|| tc.get("parameters"))
        })
        .or_else(|| {
            params
                .get("rawInput")
                .or_else(|| params.get("args"))
                .or_else(|| params.get("input"))
                .or_else(|| params.get("parameters"))
        })
        .cloned()
        .unwrap_or(Value::Null);

    let (tool_kind, _server, classified_title, command, file_path, _, _) =
        classify_tool_metadata(&tool_name, &raw_input);

    let title = params
        .get("title")
        .or_else(|| tool_call.and_then(|tc| tc.get("title")))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            if !classified_title.is_empty() && classified_title != tool_name {
                classified_title
            } else {
                "Approval requested".to_string()
            }
        });

    let detail = command
        .clone()
        .or_else(|| file_path.clone())
        .or_else(|| Some(title.clone()));
    let risk = match tool_kind.as_str() {
        "commandExecution" => Some("command".to_string()),
        "fileChange" => Some("fileChange".to_string()),
        "mcpToolCall" => Some("externalWrite".to_string()),
        _ => Some("tool".to_string()),
    };

    let options = params
        .get("options")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|item| {
                    let option_id = item
                        .get("optionId")
                        .or_else(|| item.get("id"))
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())?
                        .to_string();
                    Some(crate::acp::AcpApprovalOption {
                        option_id,
                        name: item
                            .get("name")
                            .or_else(|| item.get("label"))
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        kind: item
                            .get("kind")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    ProviderTurnEvent::ApprovalRequested {
        request_id,
        rpc_id_is_string,
        tool_name,
        title,
        detail,
        command,
        path: file_path,
        risk,
        parameters: raw_input,
        options,
    }
}

pub(super) fn plan_event(update: &Value) -> ProviderTurnEvent {
    ProviderTurnEvent::PlanUpdated {
        title: update
            .get("title")
            .or_else(|| update.get("step"))
            .and_then(Value::as_str)
            .unwrap_or("Plan")
            .to_string(),
        status: update
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("proposed")
            .to_string(),
        body: update
            .get("plan")
            .or_else(|| update.get("body"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
    }
}

pub(super) fn text_delta(update: &Value) -> Vec<ProviderTurnEvent> {
    let text = update
        .get("text")
        .or_else(|| update.pointer("/content/text"))
        .or_else(|| update.pointer("/delta/text"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if text.is_empty() {
        Vec::new()
    } else {
        vec![ProviderTurnEvent::MessageDelta {
            text: text.to_string(),
        }]
    }
}

pub(super) fn reasoning_delta(update: &Value) -> Vec<ProviderTurnEvent> {
    let text = update
        .get("text")
        .or_else(|| update.pointer("/content/text"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if text.is_empty() {
        Vec::new()
    } else {
        vec![ProviderTurnEvent::ReasoningDelta {
            text: text.to_string(),
        }]
    }
}

pub(super) fn usage_events(update: &Value, frame: &Value) -> Vec<ProviderTurnEvent> {
    let usage = update
        .get("usage")
        .or_else(|| update.pointer("/part/tokens"))
        .or_else(|| frame.get("usage"))
        .unwrap_or(update);
    let input_tokens = usage
        .get("inputTokens")
        .or_else(|| usage.get("input_tokens"))
        .or_else(|| usage.get("input"))
        .or_else(|| usage.get("used"))
        .and_then(Value::as_i64);
    let output_tokens = usage
        .get("outputTokens")
        .or_else(|| usage.get("output_tokens"))
        .or_else(|| usage.get("output"))
        .and_then(Value::as_i64);
    if input_tokens.is_none() && output_tokens.is_none() {
        return Vec::new();
    }
    let cached_input_tokens = usage
        .get("cachedReadTokens")
        .or_else(|| usage.get("cachedInputTokens"))
        .or_else(|| usage.get("cached_input_tokens"))
        .or_else(|| usage.get("cache_read_input_tokens"))
        .or_else(|| usage.pointer("/cache/read"))
        .and_then(Value::as_i64);
    let context_window_tokens = usage
        .get("contextWindowTokens")
        .or_else(|| usage.get("context_window_tokens"))
        .and_then(Value::as_i64);
    let duration_seconds = usage
        .get("durationSeconds")
        .or_else(|| usage.get("duration_seconds"))
        .and_then(Value::as_f64)
        .or_else(|| {
            usage
                .get("elapsed_ms")
                .or_else(|| update.get("elapsed_ms"))
                .and_then(Value::as_f64)
                .map(|ms| ms / 1000.0)
        });
    vec![ProviderTurnEvent::UsageUpdated {
        usage: usage_from_provider(
            input_tokens.unwrap_or(0),
            output_tokens.unwrap_or(0),
            cached_input_tokens,
            context_window_tokens,
            duration_seconds,
        ),
    }]
}

pub(super) fn explicit_tool_id(update: &Value) -> Option<String> {
    let src = update
        .get("part")
        .or_else(|| update.get("item"))
        .unwrap_or(update);
    for candidate in [
        src.get("toolCallId"),
        src.get("tool_call_id"),
        src.get("callID"),
        src.get("callId"),
        src.get("id"),
        update.get("toolCallId"),
        update.get("tool_call_id"),
        update.get("callID"),
        update.get("callId"),
        update.get("id"),
    ] {
        if let Some(id) = candidate
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            return Some(id.to_string());
        }
    }
    if let Some(idx) = src
        .get("step_index")
        .or_else(|| update.get("step_index"))
        .and_then(Value::as_i64)
    {
        return Some(format!("step-{idx}"));
    }
    None
}

pub(super) fn string_field(value: &Value, names: &[&str]) -> Option<String> {
    for name in names {
        if let Some(text) = value.get(*name).and_then(Value::as_str) {
            if !text.is_empty() {
                return Some(text.to_string());
            }
        }
    }
    None
}

pub(super) fn bounded(text: &str, max: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max {
        return trimmed.to_string();
    }
    let mut out: String = trimmed.chars().take(max.saturating_sub(3)).collect();
    out.push_str("...");
    out
}

pub fn effort_option(options: &Value, effort: Option<&str>) -> Value {
    let mut rows: Vec<Value> = options
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|row| row.get("id").and_then(Value::as_str) != Some("effort"))
        .collect();
    if let Some(effort) = effort.map(str::trim).filter(|value| !value.is_empty()) {
        rows.push(json!({ "id": "effort", "value": effort }));
    }
    Value::Array(rows)
}

pub fn hydrated_effort(thread: &Value) -> Option<String> {
    thread
        .get("effort")
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            thread
                .get("providerOptions")
                .and_then(Value::as_array)
                .and_then(|rows| {
                    rows.iter().find(|row| row.get("id").and_then(Value::as_str) == Some("effort"))
                })
                .and_then(|row| row.get("value").and_then(Value::as_str))
                .map(str::to_string)
                .filter(|value| !value.is_empty())
        })
}
