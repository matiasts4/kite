//! Provider frame normalization and approval mapping.
//!
//! The native boundary turns one provider frame into transcript events. The
//! renderer never parses a provider wire. An unrecognized frame becomes a
//! bounded notice that carries the provider and a schema hint, so a turn stays
//! readable instead of disappearing.
//!
//! The approval vocabulary is `allowOnce`, `allowForSession`, `deny`, and
//! `denyAndStop`. [`map_approval`] reads a provider settlement frame and
//! returns the canonical decision or an explicit [`ApprovalMapping::Unsupported`].
//! It is pure: it owns no state and performs no I/O, so an unknown or
//! already-settled request cannot mutate a thread through this module.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::acp::{acp_tool_from_update, build_acp_tool_call, classify_tool_metadata, AcpToolCall};
pub use super::approval::*;

#[path = "turn_pipeline.rs"]
mod pipeline;
pub use pipeline::*;

/// One normalized provider frame. Serde tags the variant as `kind`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum NormalizedEvent {
    #[serde(rename_all = "camelCase")]
    Text { text: String },
    #[serde(rename_all = "camelCase")]
    Reasoning {
        text: String,
        done: bool,
        duration_seconds: Option<f64>,
    },
    #[serde(rename_all = "camelCase")]
    Tool { tool: AcpToolCall },
    #[serde(rename_all = "camelCase")]
    Plan { step: String, status: String },
    #[serde(rename_all = "camelCase")]
    ApprovalOpened { approval: NormalizedApproval },
    #[serde(rename_all = "camelCase")]
    ApprovalResolved {
        request_id: String,
        decision: String,
    },
    #[serde(rename_all = "camelCase")]
    Notice {
        provider: String,
        code: String,
        message: String,
        hint: String,
    },
    #[serde(rename_all = "camelCase")]
    Error { code: String, message: String },
    #[serde(rename_all = "camelCase")]
    Usage {
        input_tokens: i64,
        output_tokens: i64,
        duration_seconds: f64,
    },
}


/// Longer fragments are cut so one defective frame cannot flood a transcript.
const MAX_NOTICE_EXCERPT: usize = 200;
const MAX_NOTICE_MESSAGE: usize = 280;
const MAX_ERROR_MESSAGE: usize = 2_000;

/// Providers whose current spawn asks for plain text. Only Antigravity asks
/// for stream-json today, so a non-JSON line from these drivers is content.
const TEXT_WIRE_PROVIDERS: [&str; 6] = [
    "claude", "codex", "cursor", "gemini", "grok", "opencode",
];

fn is_text_wire(provider: &str) -> bool {
    TEXT_WIRE_PROVIDERS.contains(&provider)
}

fn schema_hint(provider: &str) -> &'static str {
    match provider {
        "antigravity" => "expected stream-json with an `event` field: init, step_update, or result",
        "acp" => "expected JSON-RPC with `method` and `params`, or a `type` frame",
        "claude" | "codex" => "expected a JSON `type` frame or plain text",
        _ => "expected a JSON object with `event`, `method`, `type`, or `error`",
    }
}

fn frame_excerpt(raw: &str) -> String {
    let collapsed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    bounded(&collapsed, MAX_NOTICE_EXCERPT)
}

fn notice_event(
    provider: &str,
    code: &str,
    message: String,
    hint: &str,
) -> Vec<NormalizedEvent> {
    vec![NormalizedEvent::Notice {
        provider: provider.to_string(),
        code: code.to_string(),
        message: bounded(&message, MAX_NOTICE_MESSAGE),
        hint: hint.to_string(),
    }]
}

fn notice(provider: &str, code: &str, raw: &str, hint: &str) -> Vec<NormalizedEvent> {
    let excerpt = frame_excerpt(raw);
    let message = if excerpt.is_empty() {
        format!("{provider} sent a frame this build does not recognize")
    } else {
        format!("{provider} sent a frame this build does not recognize: {excerpt}")
    };
    notice_event(provider, code, message, hint)
}

fn json_id(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) if !text.trim().is_empty() => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

fn string_at(value: &Value, pointer: &str) -> Option<String> {
    value.pointer(pointer).and_then(Value::as_str).map(str::to_string)
}

fn number_at(value: &Value, pointers: &[&str]) -> Option<f64> {
    pointers
        .iter()
        .find_map(|pointer| value.pointer(pointer).and_then(Value::as_f64))
}

fn i64_at(value: &Value, pointers: &[&str]) -> Option<i64> {
    pointers
        .iter()
        .find_map(|pointer| value.pointer(pointer).and_then(Value::as_i64))
}

fn value_to_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Null => None,
        other => serde_json::to_string_pretty(other).ok(),
    }
}

fn is_done_state(state: &str) -> bool {
    state.eq_ignore_ascii_case("DONE") || state.eq_ignore_ascii_case("COMPLETED")
}

fn is_failed_state(state: &str) -> bool {
    state.eq_ignore_ascii_case("ERROR") || state.eq_ignore_ascii_case("FAILED")
}

fn is_error_state(state: &str) -> bool {
    is_failed_state(state) || state.eq_ignore_ascii_case("FAILURE")
}

fn normalize_json_frame(provider: &str, raw: &str, value: &Value) -> Vec<NormalizedEvent> {
    if let Some(event) = value.get("event").and_then(Value::as_str) {
        return match event {
            "init" => Vec::new(),
            "step_update" => normalize_antigravity_step(provider, raw, value),
            "result" => normalize_event_result(value),
            _ => notice(provider, "unknownEvent", raw, schema_hint(provider)),
        };
    }

    if let Some(method) = value.get("method").and_then(Value::as_str) {
        return match method {
            "session/new" | "session/initialize" | "session/init" => Vec::new(),
            "session/update" => normalize_acp_update(provider, raw, value),
            "session/request_permission" | "permission/request" => {
                normalize_acp_approval(provider, value)
            }
            _ => notice(provider, "unknownMethod", raw, schema_hint(provider)),
        };
    }

    if let Some(text) = crate::acp::extract_thought_text(value) {
        return vec![NormalizedEvent::Reasoning {
            text,
            done: value.get("done").and_then(Value::as_bool).unwrap_or(false),
            duration_seconds: value
                .get("duration_seconds")
                .or_else(|| value.get("durationSeconds"))
                .and_then(Value::as_f64),
        }];
    }
    if crate::acp::thought_frame_without_text(value) {
        return notice(
            provider,
            "unknownThought",
            raw,
            "expected thinking, text, or delta text on a reasoning frame",
        );
    }

    if let Some(kind) = value.get("type").and_then(Value::as_str) {
        return match kind {
            "system" | "session" | "session_init" => Vec::new(),
            "content_block_delta" | "text_delta" => {
                let text = value
                    .pointer("/delta/text")
                    .or_else(|| value.get("text"))
                    .and_then(Value::as_str);
                match text {
                    Some(text) if !text.is_empty() => vec![NormalizedEvent::Text {
                        text: text.to_string(),
                    }],
                    Some(_) => Vec::new(),
                    None => notice(
                        provider,
                        "missingContent",
                        raw,
                        "expected delta.text or text on this frame",
                    ),
                }
            }
            "thinking" | "reasoning" => {
                let text = value
                    .get("thinking")
                    .or_else(|| value.get("text"))
                    .or_else(|| value.get("summary"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if text.is_empty() {
                    return Vec::new();
                }
                vec![NormalizedEvent::Reasoning {
                    text: text.to_string(),
                    done: value.get("done").and_then(Value::as_bool).unwrap_or(false),
                    duration_seconds: value.get("duration_seconds").and_then(Value::as_f64),
                }]
            }
            "tool_use" | "tool_call" => {
                let tool_name = value
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("tool");
                let parameters = value
                    .get("input")
                    .or_else(|| value.get("parameters"))
                    .cloned()
                    .unwrap_or(Value::Null);
                let id = value
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("tool_1")
                    .to_string();
                let parent_tool_use_id = value
                    .get("parent_tool_use_id")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                vec![NormalizedEvent::Tool {
                    tool: build_acp_tool_call(
                        id,
                        tool_name,
                        parameters,
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
                }]
            }
            "result" => normalize_type_result(value),
            "error" => vec![NormalizedEvent::Error {
                code: error_code(value),
                message: error_message(value),
            }],
            "approval_resolved" => normalize_local_resolution(provider, raw, value),
            _ => notice(provider, "unknownType", raw, schema_hint(provider)),
        };
    }

    if let Some(error) = value.get("error") {
        return vec![NormalizedEvent::Error {
            code: json_id(error.get("code")).unwrap_or_else(|| "providerError".to_string()),
            message: error_message(value),
        }];
    }

    if is_approval_response(value) {
        return normalize_approval_response(provider, value);
    }

    notice(provider, "unknownFrame", raw, schema_hint(provider))
}

fn normalize_antigravity_step(
    provider: &str,
    raw: &str,
    value: &Value,
) -> Vec<NormalizedEvent> {
    let Some(step) = value.get("step_update") else {
        return notice(provider, "missingStepUpdate", raw, schema_hint(provider));
    };
    let step_type = step.get("step_type").and_then(Value::as_str).unwrap_or("");
    let state = step.get("state").and_then(Value::as_str).unwrap_or("");
    let step_index = step.get("step_index").and_then(Value::as_i64).unwrap_or(0);

    match step_type {
        "agent_response" => {
            let text = step
                .get("text_delta")
                .or_else(|| step.get("text"))
                .or_else(|| step.get("content"))
                .and_then(Value::as_str);
            match text {
                Some(text) if !text.is_empty() => vec![NormalizedEvent::Text {
                    text: text.to_string(),
                }],
                Some(_) => Vec::new(),
                None => notice(
                    provider,
                    "missingContent",
                    raw,
                    "expected step_update.text_delta, step_update.text, or step_update.content",
                ),
            }
        }
        "thought" | "reasoning" => {
            let text = step
                .get("text")
                .or_else(|| step.get("detail"))
                .or_else(|| step.get("thought"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if text.is_empty() {
                return Vec::new();
            }
            vec![NormalizedEvent::Reasoning {
                text: text.to_string(),
                done: is_done_state(state),
                duration_seconds: step.get("duration_seconds").and_then(Value::as_f64),
            }]
        }
        "tool" => normalize_antigravity_tool(provider, step, step_index),
        _ => notice(
            provider,
            "unknownStep",
            raw,
            "expected step_type agent_response, thought, reasoning, or tool",
        ),
    }
}

fn normalize_antigravity_tool(
    provider: &str,
    step: &Value,
    step_index: i64,
) -> Vec<NormalizedEvent> {
    let tool_name = step.get("tool_name").and_then(Value::as_str).unwrap_or("tool");
    let state = step.get("state").and_then(Value::as_str).unwrap_or("");
    let parameters = step
        .pointer("/tool_info/parameters")
        .or_else(|| step.get("parameters"))
        .or_else(|| step.get("input"))
        .cloned()
        .unwrap_or(Value::Null);
    let output = step
        .pointer("/tool_info/output")
        .or_else(|| step.get("output"))
        .or_else(|| step.get("result"))
        .and_then(value_to_text);
    let (tool_kind, server_name, title, command, file_path, _added_lines, _removed_lines) =
        classify_tool_metadata(tool_name, &parameters);

    if needs_approval(tool_name, state) {
        let detail = parameters
            .get("description")
            .or_else(|| parameters.get("prompt"))
            .or_else(|| parameters.get("CommandLine"))
            .and_then(Value::as_str)
            .unwrap_or("The agent requests permission to run this action.")
            .to_string();
        let request_id = json_id(step.get("request_id"))
            .or_else(|| json_id(step.get("id")))
            .unwrap_or_else(|| format!("approval-{step_index}"));
        return vec![NormalizedEvent::ApprovalOpened {
            approval: NormalizedApproval {
                id: request_id,
                provider: provider.to_string(),
                tool_name: tool_name.to_string(),
                title,
                detail,
                risk: risk_of(&command, &file_path).to_string(),
                command,
                path: file_path,
                parameters,
            },
        }];
    }

    let status = if is_failed_state(state) {
        "failed"
    } else if is_done_state(state) {
        "completed"
    } else {
        "running"
    };
    let id = json_id(step.get("tool_call_id"))
        .or_else(|| json_id(step.get("id")))
        .unwrap_or_else(|| format!("tool-{step_index}"));
    let parent_tool_use_id = step
        .get("parent_tool_use_id")
        .or_else(|| step.get("parentToolUseId"))
        .and_then(Value::as_str)
        .map(str::to_string);
    vec![NormalizedEvent::Tool {
        tool: build_acp_tool_call(
            id,
            tool_name,
            parameters,
            status.to_string(),
            output,
            step.get("duration_seconds").and_then(Value::as_f64),
            server_name,
            Some(tool_kind),
            Some(title),
            None,
            command,
            parent_tool_use_id,
        ),
    }]
}

fn normalize_event_result(value: &Value) -> Vec<NormalizedEvent> {
    let status = value
        .pointer("/result/status")
        .and_then(Value::as_str)
        .unwrap_or("SUCCESS");
    if is_error_state(status) {
        let message = value
            .pointer("/result/error")
            .and_then(value_to_text)
            .or_else(|| string_at(value, "/result/message"))
            .unwrap_or_else(|| format!("The provider reported {status}."));
        return vec![NormalizedEvent::Error {
            code: "providerResult".to_string(),
            message: bounded(&message, MAX_ERROR_MESSAGE),
        }];
    }
    vec![NormalizedEvent::Usage {
        input_tokens: i64_at(
            value,
            &["/result/usage/input_tokens", "/result/usage/prompt_tokens"],
        )
        .unwrap_or(0),
        output_tokens: i64_at(
            value,
            &[
                "/result/usage/output_tokens",
                "/result/usage/completion_tokens",
            ],
        )
        .unwrap_or(0),
        duration_seconds: number_at(value, &["/result/duration_seconds"]).unwrap_or(0.0),
    }]
}

fn normalize_acp_update(provider: &str, raw: &str, value: &Value) -> Vec<NormalizedEvent> {
    let params = value.get("params").unwrap_or(&Value::Null);
    let update = params.get("update").unwrap_or(params);
    let update_type = update
        .get("sessionUpdate")
        .or_else(|| update.get("type"))
        .and_then(Value::as_str)
        .unwrap_or("");

    match update_type {
        "content_delta" | "agent_message_chunk" => {
            let text = update
                .get("text")
                .or_else(|| update.pointer("/content/text"))
                .and_then(Value::as_str);
            match text {
                Some(text) if !text.is_empty() => vec![NormalizedEvent::Text {
                    text: text.to_string(),
                }],
                Some(_) => Vec::new(),
                None => notice(
                    provider,
                    "missingContent",
                    raw,
                    "expected update.text or update.content.text",
                ),
            }
        }
        "thought_delta" | "agent_thought_chunk" => {
            let text = update
                .get("text")
                .or_else(|| update.pointer("/content/text"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if text.is_empty() {
                return Vec::new();
            }
            vec![NormalizedEvent::Reasoning {
                text: text.to_string(),
                done: update.get("isDone").and_then(Value::as_bool).unwrap_or(false),
                duration_seconds: update.get("durationSeconds").and_then(Value::as_f64),
            }]
        }
        "tool_call" | "tool_call_update" => normalize_acp_tool(update),
        "plan" | "plan_update" => {
            let step = update
                .get("step")
                .or_else(|| update.get("title"))
                .and_then(Value::as_str)
                .unwrap_or("Plan updated")
                .to_string();
            let status = update
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("running")
                .to_string();
            vec![NormalizedEvent::Plan { step, status }]
        }
        "approval_resolved" => normalize_local_resolution(provider, raw, update),
        _ => notice(
            provider,
            "unknownUpdate",
            raw,
            "expected sessionUpdate content_delta, thought_delta, tool_call, plan, or approval_resolved",
        ),
    }
}

fn normalize_acp_tool(update: &Value) -> Vec<NormalizedEvent> {
    let output = update
        .get("rawOutput")
        .or_else(|| update.get("output"))
        .and_then(value_to_text);
    let parent_tool_use_id = update
        .get("parent_tool_use_id")
        .and_then(Value::as_str)
        .map(str::to_string);

    vec![NormalizedEvent::Tool {
        tool: acp_tool_from_update(update, output, parent_tool_use_id),
    }]
}

fn normalize_acp_approval(provider: &str, value: &Value) -> Vec<NormalizedEvent> {
    let params = value.get("params").cloned().unwrap_or(Value::Null);
    let request_id = json_id(value.get("id"))
        .or_else(|| json_id(params.get("requestId")))
        .unwrap_or_else(|| "acp_request".to_string());
    let tool_call = params.get("toolCall").unwrap_or(&params);
    let tool_name = tool_call
        .get("toolName")
        .or_else(|| tool_call.get("name"))
        .or_else(|| tool_call.get("title"))
        .and_then(Value::as_str)
        .unwrap_or("ask_permission");
    let parameters = tool_call
        .get("rawInput")
        .or_else(|| tool_call.get("parameters"))
        .cloned()
        .unwrap_or_else(|| params.clone());
    let (_, _, title, command, file_path, _, _) = classify_tool_metadata(tool_name, &parameters);
    let detail = params
        .get("description")
        .or_else(|| tool_call.get("title"))
        .and_then(Value::as_str)
        .unwrap_or("Permission is required to continue with this tool.")
        .to_string();

    vec![NormalizedEvent::ApprovalOpened {
        approval: NormalizedApproval {
            id: request_id,
            provider: provider.to_string(),
            tool_name: tool_name.to_string(),
            title,
            detail,
            risk: risk_of(&command, &file_path).to_string(),
            command,
            path: file_path,
            parameters,
        },
    }]
}

fn normalize_type_result(value: &Value) -> Vec<NormalizedEvent> {
    let is_error = value.get("is_error").and_then(Value::as_bool).unwrap_or(false)
        || value
            .get("subtype")
            .and_then(Value::as_str)
            .map(|subtype| subtype.to_ascii_lowercase().starts_with("error"))
            .unwrap_or(false);
    if is_error {
        let message = value
            .get("error")
            .and_then(value_to_text)
            .or_else(|| value.get("result").and_then(Value::as_str).map(str::to_string))
            .unwrap_or_else(|| "The provider reported an error result.".to_string());
        return vec![NormalizedEvent::Error {
            code: "providerResult".to_string(),
            message: bounded(&message, MAX_ERROR_MESSAGE),
        }];
    }

    let input_tokens = i64_at(
        value,
        &["/usage/input_tokens", "/usage/prompt_tokens"],
    );
    let output_tokens = i64_at(
        value,
        &["/usage/output_tokens", "/usage/completion_tokens"],
    );
    let duration_seconds = number_at(value, &["/duration_seconds"])
        .or_else(|| number_at(value, &["/duration_ms"]).map(|ms| ms / 1_000.0));
    if input_tokens.is_none() && output_tokens.is_none() && duration_seconds.is_none() {
        return Vec::new();
    }
    vec![NormalizedEvent::Usage {
        input_tokens: input_tokens.unwrap_or(0),
        output_tokens: output_tokens.unwrap_or(0),
        duration_seconds: duration_seconds.unwrap_or(0.0),
    }]
}

fn normalize_local_resolution(provider: &str, raw: &str, value: &Value) -> Vec<NormalizedEvent> {
    let request_id = json_id(value.get("requestId"))
        .or_else(|| json_id(value.get("request_id")))
        .or_else(|| json_id(value.get("id")))
        .unwrap_or_default();
    let token = value
        .get("decision")
        .or_else(|| value.get("optionId"))
        .and_then(Value::as_str);
    match token.and_then(|token| decision_from_token(provider, token)) {
        Some(decision) => vec![NormalizedEvent::ApprovalResolved {
            request_id,
            decision: decision.as_str().to_string(),
        }],
        None => match token {
            Some(token) => notice_event(
                provider,
                "unsupportedApproval",
                format!(
                    "{provider} reported the decision `{}`, which this build cannot map",
                    bounded(token, 64)
                ),
                "expected allowOnce, allowForSession, deny, or denyAndStop",
            ),
            None => notice(
                provider,
                "missingDecision",
                raw,
                "expected requestId and decision on this frame",
            ),
        },
    }
}

fn normalize_approval_response(provider: &str, value: &Value) -> Vec<NormalizedEvent> {
    let request_id = json_id(value.get("id"))
        .or_else(|| json_id(value.get("requestId")))
        .unwrap_or_default();
    match map_approval_value(provider, value) {
        ApprovalMapping::Decision(decision) => vec![NormalizedEvent::ApprovalResolved {
            request_id,
            decision: decision.as_str().to_string(),
        }],
        ApprovalMapping::Unsupported { reason } => notice_event(
            provider,
            "unsupportedApproval",
            reason,
            "expected an approval settlement this build can map",
        ),
    }
}

fn error_code(value: &Value) -> String {
    json_id(value.pointer("/error/code"))
        .or_else(|| value.get("code").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_else(|| "providerError".to_string())
}

fn error_message(value: &Value) -> String {
    value
        .pointer("/error/message")
        .and_then(Value::as_str)
        .or_else(|| value.get("message").and_then(Value::as_str))
        .or_else(|| value.get("text").and_then(Value::as_str))
        .map(|message| bounded(message, MAX_ERROR_MESSAGE))
        .unwrap_or_else(|| "The provider reported an error.".to_string())
}

/// Normalizes one raw provider frame. A frame never panics and never becomes
/// an empty answer unless it is empty or carries session metadata only.
pub fn normalize_frame(provider: &str, raw: &str) -> Vec<NormalizedEvent> {
    let provider = canonical_provider(provider);
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }

    if trimmed.starts_with('{') {
        if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
            return normalize_json_frame(&provider, raw, &value);
        }
        if !is_text_wire(&provider) {
            return notice(&provider, "malformedFrame", raw, schema_hint(&provider));
        }
    }

    if is_text_wire(&provider) {
        return vec![NormalizedEvent::Text {
            text: raw.trim_end_matches(['\r', '\n']).to_string(),
        }];
    }

    notice(&provider, "nonJsonFrame", raw, schema_hint(&provider))
}

/// Replays a fixture body line by line in order. Blank lines frame the file,
/// not the conversation, and are skipped.
pub fn replay_fixture(provider: &str, body: &str) -> Vec<NormalizedEvent> {
    body.lines()
        .filter(|line| !line.trim().is_empty())
        .flat_map(|line| normalize_frame(provider, line))
        .collect()
}

#[cfg(test)]
#[path = "normalize_tests.rs"]
mod tests;

