use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::acp::{
    classify_tool_metadata, extract_subagent_meta, extract_swarm_meta, merge_subagent_meta,
    merge_swarm_meta, response_indicates_failure, SubagentMeta, SwarmMeta,
};
use crate::chat::session::ApprovalDecision;

pub const DELTA_WINDOW: Duration = Duration::from_millis(24);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProviderTurnEvent {
    SessionStarted {
        provider_session_id: Option<String>,
    },
    MessageDelta {
        text: String,
    },
    ReasoningDelta {
        text: String,
    },
    ToolCallUpdated {
        tool: ToolCallSnapshot,
    },
    PlanUpdated {
        title: String,
        status: String,
        body: String,
    },
    ApprovalRequested {
        request_id: String,
        tool_name: String,
        title: String,
    },
    UserInputRequested {
        request: UserInputRequest,
    },
    UsageUpdated {
        usage: UsageReport,
    },
    TurnTerminal {
        failure: Option<TurnFailure>,
    },
    Notice {
        code: String,
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallSnapshot {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub status: String,
    pub path: Option<String>,
    pub command: Option<String>,
    pub query: Option<String>,
    pub additions: Option<i64>,
    pub deletions: Option<i64>,
    pub output: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent_meta: Option<SubagentMeta>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub swarm_meta: Option<SwarmMeta>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_tool_use_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserInputRequest {
    pub request_id: String,
    pub questions: Vec<UserQuestion>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserQuestion {
    pub id: String,
    pub header: String,
    pub options: Vec<String>,
    pub allow_custom_answer: bool,
    pub allow_attachments: bool,
    pub multi_select: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageReport {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cached_input_tokens: Option<i64>,
    pub context_window_tokens: Option<i64>,
    pub duration_seconds: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TurnFailure {
    UsageLimit {
        message: String,
        reset_at_unix_ms: Option<i64>,
    },
    AuthRequired {
        provider: String,
        message: String,
    },
    CliUsageError {
        command: String,
        message: String,
    },
    ProcessError {
        exit_code: Option<i32>,
        message: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionMode {
    Supervised,
    AcceptEdits,
    Auto,
    FullAccess,
}

impl PermissionMode {
    pub fn as_str(self) -> &'static str {
        match self {
            PermissionMode::Supervised => "supervised",
            PermissionMode::AcceptEdits => "acceptEdits",
            PermissionMode::Auto => "auto",
            PermissionMode::FullAccess => "fullAccess",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "supervised" | "default" | "ask" => Some(PermissionMode::Supervised),
            "acceptEdits" | "accept-edits" => Some(PermissionMode::AcceptEdits),
            "auto" => Some(PermissionMode::Auto),
            "fullAccess" | "bypassPermissions" | "dontAsk" => Some(PermissionMode::FullAccess),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EffectivePermission {
    pub requested: String,
    pub effective: PermissionMode,
    pub clamped: bool,
}

