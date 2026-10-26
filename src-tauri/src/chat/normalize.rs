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

use crate::acp::{classify_tool_metadata, summarize_tool_detail, AcpToolCall};
use crate::chat::session::ApprovalDecision;

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

/// An approval request, normalized without inventing a thread or a run id.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedApproval {
    pub id: String,
    pub provider: String,
    pub tool_name: String,
    pub title: String,
    pub detail: String,
    pub risk: String,
    pub command: Option<String>,
    pub path: Option<String>,
    pub parameters: Value,
}

/// The result of mapping one provider settlement frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApprovalMapping {
    Decision(ApprovalDecision),
    Unsupported { reason: String },
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

const DECLARED_PROVIDERS: [&str; 8] = [
    "antigravity",
    "acp",
    "claude",
    "codex",
    "cursor",
    "gemini",
    "grok",
    "opencode",
];

fn canonical_provider(provider: &str) -> String {
    match provider.trim().to_ascii_lowercase().as_str() {
        "agy" => "antigravity".to_string(),
        "claude-code" | "claudecode" => "claude".to_string(),
        "open-code" => "opencode".to_string(),
        "" => "unknown".to_string(),
        other => other.to_string(),
    }
}

fn is_declared_provider(provider: &str) -> bool {
    DECLARED_PROVIDERS.contains(&provider)
}

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

fn bounded(text: &str, max: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max {
        return trimmed.to_string();
    }
    let keep = max.saturating_sub(3);
    let mut out: String = trimmed.chars().take(keep).collect();
    out.push_str("...");
    out
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

fn needs_approval(tool_name: &str, state: &str) -> bool {
    matches!(tool_name, "ask_permission" | "ask_custom_permission")
        || state.eq_ignore_ascii_case("WAITING_FOR_CONFIRMATION")
        || state.eq_ignore_ascii_case("REQUIRES_APPROVAL")
}

fn risk_of(command: &Option<String>, path: &Option<String>) -> &'static str {
    if command.is_some() {
        "command"
    } else if path.is_some() {
        "fileChange"
    } else {
        "unknown"
    }
}

fn normalized_token(token: &str) -> String {
    token
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .map(|ch| ch.to_ascii_lowercase())
        .collect()
}

fn decision_from_token(provider: &str, token: &str) -> Option<ApprovalDecision> {
    let normalized = normalized_token(token);
    match normalized.as_str() {
        "allowonce" => Some(ApprovalDecision::AllowOnce),
        "allowforsession" => Some(ApprovalDecision::AllowForSession),
        "deny" => Some(ApprovalDecision::Deny),
        "denyandstop" => Some(ApprovalDecision::DenyAndStop),
        _ if matches!(provider, "antigravity" | "acp") => match normalized.as_str() {
            "allow" | "accept" | "accepted" | "approve" | "approved" => {
                Some(ApprovalDecision::AllowOnce)
            }
            "allowalways" | "acceptforsession" => Some(ApprovalDecision::AllowForSession),
            "reject" | "rejected" | "rejectonce" | "decline" | "declined" => {
                Some(ApprovalDecision::Deny)
            }
            "rejectandstop" | "cancel" | "cancelled" | "canceled" | "abort" | "interrupt" => {
                Some(ApprovalDecision::DenyAndStop)
            }
            _ => None,
        },
        _ => None,
    }
}

fn approval_token(value: &Value) -> Option<&str> {
    value
        .pointer("/result/outcome/optionId")
        .and_then(Value::as_str)
        .or_else(|| value.pointer("/result/outcome/option").and_then(Value::as_str))
        .or_else(|| value.pointer("/result/optionId").and_then(Value::as_str))
        .or_else(|| value.pointer("/result/decision").and_then(Value::as_str))
        .or_else(|| value.pointer("/response/decision").and_then(Value::as_str))
        .or_else(|| value.pointer("/response/behavior").and_then(Value::as_str))
        .or_else(|| value.get("decision").and_then(Value::as_str))
        .or_else(|| value.get("optionId").and_then(Value::as_str))
        .or_else(|| value.get("approvalDecision").and_then(Value::as_str))
}

fn is_approval_response(value: &Value) -> bool {
    approval_token(value).is_some()
        || value.get("approved").and_then(Value::as_bool).is_some()
        || value
            .pointer("/result/approved")
            .and_then(Value::as_bool)
            .is_some()
}

fn is_approval_request(value: &Value) -> bool {
    if let Some(method) = value.get("method").and_then(Value::as_str) {
        if matches!(method, "session/request_permission" | "permission/request") {
            return true;
        }
    }
    if let Some(kind) = value.get("type").and_then(Value::as_str) {
        if matches!(kind, "approval_request" | "permission_request") {
            return true;
        }
    }
    value.get("event").and_then(Value::as_str) == Some("step_update")
        && value
            .pointer("/step_update/step_type")
            .and_then(Value::as_str)
            == Some("tool")
        && needs_approval(
            value
                .pointer("/step_update/tool_name")
                .and_then(Value::as_str)
                .unwrap_or(""),
            value
                .pointer("/step_update/state")
                .and_then(Value::as_str)
                .unwrap_or(""),
        )
}

fn is_settled(value: &Value) -> bool {
    if value.get("settled").and_then(Value::as_bool) == Some(true) {
        return true;
    }
    let status = value
        .get("status")
        .and_then(Value::as_str)
        .or_else(|| value.pointer("/result/status").and_then(Value::as_str));
    matches!(
        status.map(str::to_ascii_lowercase).as_deref(),
        Some("resolved" | "settled" | "answered" | "cancelled" | "canceled")
    )
}

fn unsupported(provider: &str, reason: &str) -> ApprovalMapping {
    ApprovalMapping::Unsupported {
        reason: format!("{provider}: {reason}"),
    }
}

fn map_approval_value(provider: &str, value: &Value) -> ApprovalMapping {
    if !is_declared_provider(provider) {
        return unsupported(provider, "no approval vocabulary is declared for this provider");
    }
    if is_settled(value) {
        return unsupported(
            provider,
            "the request is already settled and is never settled twice",
        );
    }
    if let Some(token) = approval_token(value) {
        return match decision_from_token(provider, token) {
            Some(decision) => ApprovalMapping::Decision(decision),
            None => {
                let token = bounded(token, 64);
                unsupported(
                    provider,
                    &format!("decision `{token}` is not in the declared vocabulary"),
                )
            }
        };
    }
    let approved = value
        .get("approved")
        .and_then(Value::as_bool)
        .or_else(|| value.pointer("/result/approved").and_then(Value::as_bool));
    if let Some(approved) = approved {
        return ApprovalMapping::Decision(if approved {
            ApprovalDecision::AllowOnce
        } else {
            ApprovalDecision::Deny
        });
    }
    if is_approval_request(value) {
        return unsupported(
            provider,
            "the frame is an approval request, not a settlement",
        );
    }
    unsupported(provider, "the frame carries no approval decision")
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
                let (tool_kind, server_name, title, command, file_path, added_lines, removed_lines) =
                    classify_tool_metadata(tool_name, &parameters);
                let detail = summarize_tool_detail(&parameters, &None, &command, &file_path);
                vec![NormalizedEvent::Tool {
                    tool: AcpToolCall {
                        id: value
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or("tool_1")
                            .to_string(),
                        name: tool_name.to_string(),
                        title,
                        detail,
                        tool_kind,
                        server_name,
                        command,
                        file_path,
                        added_lines,
                        removed_lines,
                        parameters,
                        status: "running".to_string(),
                        output: None,
                        duration_seconds: None,
                    },
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
    let (tool_kind, server_name, title, command, file_path, added_lines, removed_lines) =
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
    let detail = summarize_tool_detail(&parameters, &output, &command, &file_path);
    let id = json_id(step.get("tool_call_id"))
        .or_else(|| json_id(step.get("id")))
        .unwrap_or_else(|| format!("tool-{step_index}"));
    vec![NormalizedEvent::Tool {
        tool: AcpToolCall {
            id,
            name: tool_name.to_string(),
            title,
            detail,
            tool_kind,
            server_name,
            command,
            file_path,
            added_lines,
            removed_lines,
            parameters,
            status: status.to_string(),
            output,
            duration_seconds: step.get("duration_seconds").and_then(Value::as_f64),
        },
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
    let tool_id = update
        .get("toolCallId")
        .or_else(|| update.get("id"))
        .and_then(Value::as_str)
        .unwrap_or("acp_tool")
        .to_string();
    let tool_name = update
        .get("toolName")
        .or_else(|| update.get("name"))
        .or_else(|| update.get("title"))
        .and_then(Value::as_str)
        .unwrap_or("tool");
    let status = match update
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("running")
    {
        "completed" | "done" | "succeeded" => "completed",
        "failed" | "error" => "failed",
        "pending" => "pending",
        _ => "running",
    };
    let parameters = update
        .get("rawInput")
        .or_else(|| update.get("parameters"))
        .or_else(|| update.get("input"))
        .cloned()
        .unwrap_or(Value::Null);
    let output = update
        .get("rawOutput")
        .or_else(|| update.get("output"))
        .and_then(value_to_text);
    let (tool_kind, server_name, title, command, file_path, added_lines, removed_lines) =
        classify_tool_metadata(tool_name, &parameters);
    let detail = summarize_tool_detail(&parameters, &output, &command, &file_path);

    vec![NormalizedEvent::Tool {
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
            parameters,
            status: status.to_string(),
            output,
            duration_seconds: update.get("durationSeconds").and_then(Value::as_f64),
        },
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

/// Maps a provider settlement frame onto the canonical decision vocabulary.
///
/// A frame that is not a settlement (an open request, a malformed payload, an
/// unknown token, or an already-settled request) returns an explicit
/// [`ApprovalMapping::Unsupported`] with a bounded reason.
pub fn map_approval(provider: &str, raw: &str) -> ApprovalMapping {
    let provider = canonical_provider(provider);
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return unsupported(&provider, "the frame is empty");
    }

    let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
        return match decision_from_token(&provider, trimmed) {
            Some(decision) => ApprovalMapping::Decision(decision),
            None => unsupported(
                &provider,
                "the frame is not JSON and is not a canonical decision",
            ),
        };
    };

    map_approval_value(&provider, &value)
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
mod tests {
    use super::*;
    use crate::chat::session::{
        ScriptedTransport, SessionError, SessionManager, SessionMode, SessionSpec, TransportEvent,
    };

    const ANTIGRAVITY_STREAM: &str = include_str!("../../tests/fixtures/antigravity.stream.json");
    const CODEX_TOOL_CALL: &str = include_str!("../../tests/fixtures/codex.tool-call.json");
    const CLAUDE_TEXT: &str = include_str!("../../tests/fixtures/claude.text.txt");
    const UNKNOWN_FRAME: &str = include_str!("../../tests/fixtures/unknown.frame.json");
    const APPROVAL_ANTIGRAVITY: &str =
        include_str!("../../tests/fixtures/approval.antigravity.stream.json");
    const APPROVAL_ACP: &str =
        include_str!("../../tests/fixtures/approval.acp.session-request.json");
    const APPROVAL_ANTIGRAVITY_RESPONSE: &str =
        include_str!("../../tests/fixtures/approval.antigravity.response.json");
    const APPROVAL_ACP_RESPONSE: &str =
        include_str!("../../tests/fixtures/approval.acp.response.json");
    const APPROVAL_SETTLED: &str = include_str!("../../tests/fixtures/approval.settled.frame.json");

    const DECLARED: [&str; 8] = [
        "antigravity",
        "acp",
        "claude",
        "codex",
        "cursor",
        "gemini",
        "grok",
        "opencode",
    ];

    fn opened(provider: &str, body: &str) -> NormalizedApproval {
        let events = replay_fixture(provider, body);
        assert_eq!(events.len(), 1, "expected exactly one event for {body}");
        match events.into_iter().next().unwrap() {
            NormalizedEvent::ApprovalOpened { approval } => approval,
            other => panic!("expected an approvalOpened event, got {other:?}"),
        }
    }

    #[test]
    fn every_fixture_replays_deterministically_twice() {
        let fixtures = [
            ("antigravity", ANTIGRAVITY_STREAM),
            ("codex", CODEX_TOOL_CALL),
            ("claude", CLAUDE_TEXT),
            ("antigravity", UNKNOWN_FRAME),
            ("antigravity", APPROVAL_ANTIGRAVITY),
            ("acp", APPROVAL_ACP),
            ("antigravity", APPROVAL_ANTIGRAVITY_RESPONSE),
            ("acp", APPROVAL_ACP_RESPONSE),
            ("antigravity", APPROVAL_SETTLED),
        ];

        for (provider, body) in fixtures {
            let first = replay_fixture(provider, body);
            let second = replay_fixture(provider, body);
            assert_eq!(first, second, "{provider} fixture must replay identically");
            assert!(!first.is_empty(), "{provider} fixture must not drop every event");
        }
    }

    #[test]
    fn the_antigravity_stream_frame_becomes_text() {
        assert_eq!(
            replay_fixture("antigravity", ANTIGRAVITY_STREAM),
            vec![NormalizedEvent::Text {
                text: "I will inspect the workspace before editing.".to_string(),
            }]
        );
        assert_eq!(
            replay_fixture("agy", ANTIGRAVITY_STREAM),
            replay_fixture("antigravity", ANTIGRAVITY_STREAM),
            "the program alias is the same wire"
        );
    }

    #[test]
    fn the_codex_json_frame_becomes_a_tool() {
        let events = replay_fixture("codex", CODEX_TOOL_CALL);
        assert_eq!(events.len(), 1, "one frame is one event");
        match &events[0] {
            NormalizedEvent::Tool { tool } => {
                assert_eq!(tool.id, "call_codex_1");
                assert_eq!(tool.name, "shell");
                assert_eq!(tool.tool_kind, "commandExecution");
                assert_eq!(tool.command.as_deref(), Some("cargo test chat::normalize::"));
                assert_eq!(tool.status, "running");
                assert!(tool.detail.contains("cargo test chat::normalize::"));
            }
            other => panic!("expected a tool event, got {other:?}"),
        }
    }

    #[test]
    fn the_claude_text_frame_becomes_text() {
        assert_eq!(
            replay_fixture("claude", CLAUDE_TEXT),
            vec![NormalizedEvent::Text {
                text: "I will inspect the workspace before editing it.".to_string(),
            }]
        );
    }

    #[test]
    fn an_unknown_frame_is_a_bounded_notice_with_provider_metadata() {
        let events = replay_fixture("antigravity", UNKNOWN_FRAME);
        assert_eq!(events.len(), 1);
        match &events[0] {
            NormalizedEvent::Notice {
                provider,
                code,
                message,
                hint,
            } => {
                assert_eq!(provider, "antigravity");
                assert_eq!(code, "unknownFrame");
                assert!(message.contains("telemetry"), "the notice names the shape");
                assert!(
                    message.chars().count() <= 280,
                    "the notice is bounded, got {} chars",
                    message.chars().count()
                );
                assert!(!hint.is_empty());
                assert!(hint.contains("event"), "the hint names the expected schema");
            }
            other => panic!("expected a notice event, got {other:?}"),
        }

        match &normalize_frame("agy", UNKNOWN_FRAME)[0] {
            NormalizedEvent::Notice { provider, .. } => {
                assert_eq!(provider, "antigravity", "an alias is reported canonically")
            }
            other => panic!("expected a notice event, got {other:?}"),
        }
    }

    #[test]
    fn a_malformed_json_frame_is_bounded() {
        let raw = format!(
            "{{\"event\":\"step_update\",\"step_update\":{{\"text\":\"{}\"}}",
            "x".repeat(8_000)
        );
        let events = normalize_frame("antigravity", &raw);
        assert_eq!(events.len(), 1);
        match &events[0] {
            NormalizedEvent::Notice { code, message, .. } => {
                assert_eq!(code, "malformedFrame");
                assert!(message.chars().count() <= 280);
            }
            other => panic!("expected a notice event, got {other:?}"),
        }
    }

    #[test]
    fn a_non_json_frame_on_a_json_wire_is_a_notice() {
        let events = normalize_frame("antigravity", "starting provider...");
        match &events[0] {
            NormalizedEvent::Notice { code, .. } => assert_eq!(code, "nonJsonFrame"),
            other => panic!("expected a notice event, got {other:?}"),
        }
    }

    #[test]
    fn session_metadata_frames_produce_no_transcript_event() {
        assert!(normalize_frame(
            "antigravity",
            r#"{"event":"init","init":{"conversation_id":"conversation-1","model":"model-1"}}"#
        )
        .is_empty());
        assert!(normalize_frame("claude", r#"{"type":"system","session_id":"session-1"}"#)
            .is_empty());
    }

    #[test]
    fn reasoning_plan_usage_and_error_frames_normalize() {
        assert_eq!(
            normalize_frame(
                "antigravity",
                r#"{"event":"step_update","step_update":{"step_type":"thought","state":"DONE","step_index":2,"text":"I checked the parser.","duration_seconds":1.5}}"#
            ),
            vec![NormalizedEvent::Reasoning {
                text: "I checked the parser.".to_string(),
                done: true,
                duration_seconds: Some(1.5),
            }]
        );

        assert_eq!(
            normalize_frame(
                "acp",
                r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"plan","step":"Run the focused tests","status":"completed"}}}"#
            ),
            vec![NormalizedEvent::Plan {
                step: "Run the focused tests".to_string(),
                status: "completed".to_string(),
            }]
        );

        assert_eq!(
            normalize_frame(
                "antigravity",
                r#"{"event":"result","result":{"status":"SUCCESS","usage":{"input_tokens":120,"output_tokens":30},"duration_seconds":2.5}}"#
            ),
            vec![NormalizedEvent::Usage {
                input_tokens: 120,
                output_tokens: 30,
                duration_seconds: 2.5,
            }]
        );

        assert_eq!(
            normalize_frame(
                "claude",
                r#"{"type":"result","usage":{"input_tokens":7,"output_tokens":3},"duration_ms":1500}"#
            ),
            vec![NormalizedEvent::Usage {
                input_tokens: 7,
                output_tokens: 3,
                duration_seconds: 1.5,
            }]
        );

        match &normalize_frame(
            "claude",
            r#"{"type":"error","error":{"code":"auth","message":"login required"}}"#,
        )[0]
        {
            NormalizedEvent::Error { code, message } => {
                assert_eq!(code, "auth");
                assert!(message.contains("login required"));
            }
            other => panic!("expected an error event, got {other:?}"),
        }
    }

    #[test]
    fn each_approval_request_opens_with_a_provider_issued_id() {
        let antigravity = opened("antigravity", APPROVAL_ANTIGRAVITY);
        assert_eq!(antigravity.id, "perm-agy-1");
        assert_eq!(antigravity.provider, "antigravity");
        assert_eq!(antigravity.risk, "command");
        assert_eq!(
            antigravity.command.as_deref(),
            Some("cargo publish --dry-run")
        );
        assert_eq!(antigravity.detail, "Publish the crate to the registry");

        let acp = opened("acp", APPROVAL_ACP);
        assert_eq!(acp.id, "perm-42");
        assert_eq!(acp.provider, "acp");
        assert_eq!(acp.tool_name, "shell");
        assert_eq!(acp.risk, "command");
        assert_eq!(acp.command.as_deref(), Some("cargo publish --dry-run"));
    }

    #[test]
    fn the_four_canonical_decisions_map_for_every_declared_provider() {
        for provider in DECLARED {
            for decision in [
                ApprovalDecision::AllowOnce,
                ApprovalDecision::AllowForSession,
                ApprovalDecision::Deny,
                ApprovalDecision::DenyAndStop,
            ] {
                let raw = format!("{{\"decision\":\"{}\"}}", decision.as_str());
                assert_eq!(
                    map_approval(provider, &raw),
                    ApprovalMapping::Decision(decision),
                    "{provider} must map {}",
                    decision.as_str()
                );
            }
        }
    }

    #[test]
    fn the_antigravity_vocabulary_maps_to_the_canonical_decisions() {
        let cases = [
            ("allow_once", ApprovalDecision::AllowOnce),
            ("allow_always", ApprovalDecision::AllowForSession),
            ("accept_for_session", ApprovalDecision::AllowForSession),
            ("reject_once", ApprovalDecision::Deny),
            ("reject_and_stop", ApprovalDecision::DenyAndStop),
            ("cancel", ApprovalDecision::DenyAndStop),
            ("approved", ApprovalDecision::AllowOnce),
        ];

        for (token, expected) in cases {
            let raw = format!(
                "{{\"jsonrpc\":\"2.0\",\"id\":\"perm-1\",\"result\":{{\"outcome\":{{\"outcome\":\"selected\",\"optionId\":\"{token}\"}}}}}}"
            );
            assert_eq!(
                map_approval("antigravity", &raw),
                ApprovalMapping::Decision(expected),
                "token {token}"
            );
            assert_eq!(
                map_approval("acp", &raw),
                ApprovalMapping::Decision(expected),
                "token {token} on the ACP wire"
            );
        }

        assert_eq!(
            map_approval("antigravity", APPROVAL_ANTIGRAVITY_RESPONSE),
            ApprovalMapping::Decision(ApprovalDecision::AllowForSession)
        );
        assert_eq!(
            map_approval("acp", APPROVAL_ACP_RESPONSE),
            ApprovalMapping::Decision(ApprovalDecision::Deny)
        );
    }

    #[test]
    fn an_unobserved_provider_vocabulary_is_explicitly_unsupported() {
        match map_approval("codex", r#"{"decision":"accept"}"#) {
            ApprovalMapping::Unsupported { reason } => {
                assert!(reason.contains("codex"), "the reason names the provider");
                assert!(reason.contains("accept"), "the reason names the token");
            }
            other => panic!("codex accept is not observed, got {other:?}"),
        }

        match map_approval("unknown-provider", r#"{"decision":"allowOnce"}"#) {
            ApprovalMapping::Unsupported { reason } => {
                assert!(reason.contains("unknown-provider"));
            }
            other => panic!("an undeclared provider must be unsupported, got {other:?}"),
        }

        match map_approval(
            "antigravity",
            r#"{"result":{"outcome":{"optionId":"maybe_later"}}}"#,
        ) {
            ApprovalMapping::Unsupported { reason } => {
                assert!(reason.contains("maybe_later"), "the reason names the token");
            }
            other => panic!("an unknown token must be unsupported, got {other:?}"),
        }
    }

    #[test]
    fn an_approval_request_is_not_a_settlement() {
        for (provider, body) in [
            ("antigravity", APPROVAL_ANTIGRAVITY),
            ("acp", APPROVAL_ACP),
        ] {
            match map_approval(provider, body) {
                ApprovalMapping::Unsupported { reason } => {
                    assert!(reason.contains("request"), "the reason names the request: {reason}");
                }
                other => panic!("an open request must not become a decision, got {other:?}"),
            }
        }
    }

    #[test]
    fn a_settled_request_is_never_settled_again() {
        let first = map_approval("antigravity", APPROVAL_SETTLED);
        let second = map_approval("antigravity", APPROVAL_SETTLED);
        assert_eq!(first, second, "mapping is pure and repeatable");
        match first {
            ApprovalMapping::Unsupported { reason } => {
                assert!(reason.contains("settled"), "the reason names the settled state");
            }
            other => panic!("a settled request must not map, got {other:?}"),
        }

        match map_approval(
            "antigravity",
            r#"{"decision":"allowOnce","status":"resolved"}"#,
        ) {
            ApprovalMapping::Unsupported { reason } => assert!(reason.contains("settled")),
            other => panic!("a settled marker must win over the token, got {other:?}"),
        }
    }

    #[test]
    fn a_settled_approval_cannot_be_settled_twice_on_the_thread() {
        let request = normalize_frame("antigravity", APPROVAL_ANTIGRAVITY);
        let NormalizedEvent::ApprovalOpened { approval } = &request[0] else {
            panic!("expected an approvalOpened event, got {:?}", request[0]);
        };
        let ApprovalMapping::Decision(decision) =
            map_approval("antigravity", APPROVAL_ANTIGRAVITY_RESPONSE)
        else {
            panic!("the response fixture must map");
        };

        let mut manager = SessionManager::new();
        let transport = ScriptedTransport::new();
        let spec = SessionSpec {
            thread_id: "thread-1".to_string(),
            driver: "antigravity".to_string(),
            connection_id: None,
            working_directory: None,
            mode: SessionMode::OneShot,
            recipe: None,
            resume_handle: None,
        };
        manager.attach(spec, Box::new(transport.clone())).unwrap();
        manager.start("thread-1").unwrap();
        transport.script(TransportEvent::ApprovalRequest {
            id: approval.id.clone(),
            kind: "command".to_string(),
        });
        manager.poll("thread-1").unwrap();

        manager
            .respond_approval("thread-1", &approval.id, decision)
            .unwrap();
        let events_after_first = manager.events_since("thread-1", 0);
        let record_after_first = manager.status("thread-1").unwrap();

        let error = manager
            .respond_approval("thread-1", &approval.id, decision)
            .unwrap_err();
        assert_eq!(error, SessionError::UnknownApproval(approval.id.clone()));
        assert_eq!(
            manager.events_since("thread-1", 0),
            events_after_first,
            "a rejected second settlement writes no event"
        );
        assert_eq!(
            manager.status("thread-1").unwrap(),
            record_after_first,
            "a rejected second settlement changes no session field"
        );
    }

    #[test]
    fn normalized_events_serialize_with_a_kind_tag() {
        let text = serde_json::to_value(NormalizedEvent::Text {
            text: "hi".to_string(),
        })
        .unwrap();
        assert_eq!(text, serde_json::json!({ "kind": "text", "text": "hi" }));

        let approval = serde_json::to_value(NormalizedEvent::ApprovalOpened {
            approval: opened("antigravity", APPROVAL_ANTIGRAVITY),
        })
        .unwrap();
        assert_eq!(approval["kind"], "approvalOpened");
        assert_eq!(approval["approval"]["id"], "perm-agy-1");
        assert_eq!(approval["approval"]["provider"], "antigravity");
    }

    #[test]
    fn the_existing_acp_parsers_are_unchanged() {
        use crate::acp::{format_acp_approval_response, parse_acp_stream_line, AcpStreamEvent};

        match parse_acp_stream_line("thread-1", "run-1", APPROVAL_ANTIGRAVITY.trim()).unwrap() {
            AcpStreamEvent::PermissionRequired { approval } => {
                assert_eq!(approval.request_id, "perm-agy-1");
                assert_eq!(approval.tool_name, "ask_permission");
                assert_eq!(approval.command.as_deref(), Some("cargo publish --dry-run"));
                assert_eq!(approval.title, "Run `cargo publish --dry-run`");
            }
            other => panic!("expected the antigravity approval shape, got {other:?}"),
        }

        match parse_acp_stream_line("thread-1", "run-1", APPROVAL_ACP.trim()).unwrap() {
            AcpStreamEvent::PermissionRequired { approval } => {
                assert_eq!(approval.request_id, "perm-42");
                assert_eq!(approval.tool_name, "shell");
                assert_eq!(approval.command.as_deref(), Some("cargo publish --dry-run"));
            }
            other => panic!("expected the ACP approval shape, got {other:?}"),
        }

        assert_eq!(
            format_acp_approval_response("perm-42", "allow_once"),
            "{\"id\":\"perm-42\",\"jsonrpc\":\"2.0\",\"result\":{\"approved\":true,\"decision\":\"approve\",\"outcome\":{\"optionId\":\"allow_once\",\"outcome\":\"selected\"}}}\n"
        );
    }
}
