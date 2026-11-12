//! Approval settlement mapping and approval normalization structures.
//!
//! The approval vocabulary is `allowOnce`, `allowForSession`, `deny`, and
//! `denyAndStop`. [`map_approval`] reads a provider settlement frame and
//! returns the canonical decision or an explicit [`ApprovalMapping::Unsupported`].
//! It is pure: it owns no state and performs no I/O, so an unknown or
//! already-settled request cannot mutate a thread through this module.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use crate::chat::session::ApprovalDecision;

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

pub fn canonical_provider(provider: &str) -> String {
    match provider.trim().to_ascii_lowercase().as_str() {
        "agy" => "antigravity".to_string(),
        "claude-code" | "claudecode" => "claude".to_string(),
        "open-code" => "opencode".to_string(),
        "" => "unknown".to_string(),
        other => other.to_string(),
    }
}

pub fn is_declared_provider(provider: &str) -> bool {
    DECLARED_PROVIDERS.contains(&provider)
}

pub fn bounded(text: &str, max: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max {
        return trimmed.to_string();
    }
    let keep = max.saturating_sub(3);
    let mut out: String = trimmed.chars().take(keep).collect();
    out.push_str("...");
    out
}

pub fn needs_approval(tool_name: &str, state: &str) -> bool {
    matches!(tool_name, "ask_permission" | "ask_custom_permission")
        || state.eq_ignore_ascii_case("WAITING_FOR_CONFIRMATION")
        || state.eq_ignore_ascii_case("REQUIRES_APPROVAL")
}

pub fn risk_of(command: &Option<String>, path: &Option<String>) -> &'static str {
    if command.is_some() {
        "command"
    } else if path.is_some() {
        "fileChange"
    } else {
        "unknown"
    }
}

pub fn normalized_token(token: &str) -> String {
    token
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .map(|ch| ch.to_ascii_lowercase())
        .collect()
}

pub fn decision_from_token(provider: &str, token: &str) -> Option<ApprovalDecision> {
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

pub fn approval_token(value: &Value) -> Option<&str> {
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

pub fn is_approval_response(value: &Value) -> bool {
    approval_token(value).is_some()
        || value.get("approved").and_then(Value::as_bool).is_some()
        || value
            .pointer("/result/approved")
            .and_then(Value::as_bool)
            .is_some()
}

pub fn is_approval_request(value: &Value) -> bool {
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

pub fn is_settled(value: &Value) -> bool {
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

pub fn unsupported(provider: &str, reason: &str) -> ApprovalMapping {
    ApprovalMapping::Unsupported {
        reason: format!("{provider}: {reason}"),
    }
}

pub fn map_approval_value(provider: &str, value: &Value) -> ApprovalMapping {
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
