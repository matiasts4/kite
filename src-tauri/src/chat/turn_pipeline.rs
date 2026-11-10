//! Canonical turn pipeline shared by every provider transport.
//!
//! Frames enter here. The renderer never parses a provider wire. A tool call
//! keeps one snapshot for its whole life, text waits 50ms unless it is the
//! first chunk or the segment is closing, and a failed process becomes a
//! structured failure instead of assistant text.

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::chat::session::ApprovalDecision;

pub const DELTA_WINDOW: Duration = Duration::from_millis(50);

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

/// Merges tool_call, tool_call_update, and tool_call_content_chunk by id.
#[derive(Debug, Default, Clone)]
pub struct ToolCallTracker {
    calls: BTreeMap<String, ToolCallSnapshot>,
}

impl ToolCallTracker {
    pub fn snapshot(&self, id: &str) -> Option<&ToolCallSnapshot> {
        self.calls.get(id)
    }

    pub fn ingest(&mut self, frame: &Value) -> Vec<ProviderTurnEvent> {
        if let Some(event) = reverse_request(frame) {
            return vec![event];
        }
        let update = frame.pointer("/params/update").unwrap_or(frame);
        let kind = update
            .get("sessionUpdate")
            .or_else(|| update.get("type"))
            .or_else(|| frame.get("method"))
            .and_then(Value::as_str)
            .unwrap_or("");
        match kind {
            "tool_call" | "tool_call_update" | "tool_use" => {
                let snap = self.merge_tool(update);
                vec![ProviderTurnEvent::ToolCallUpdated { tool: snap }]
            }
            "tool_call_content_chunk" => {
                let snap = self.append_chunk(update);
                vec![ProviderTurnEvent::ToolCallUpdated { tool: snap }]
            }
            "agent_message_chunk" | "content_delta" | "text_delta" => text_delta(update),
            "agent_thought_chunk" | "thought_delta" | "thinking" | "reasoning" => {
                reasoning_delta(update)
            }
            "plan" | "plan_update" | "x.ai/exit_plan_mode" | "_x.ai/exit_plan_mode" => {
                vec![plan_event(update)]
            }
            "session/request_permission" | "permission/request" => {
                vec![approval_event(frame)]
            }
            _ if frame.get("method").is_some() || frame.get("type").is_some() => {
                vec![ProviderTurnEvent::Notice {
                    code: "unknownFrame".into(),
                    message: bounded(
                        &format!("unrecognized frame `{kind}`"),
                        180,
                    ),
                }]
            }
            _ => Vec::new(),
        }
    }

    fn merge_tool(&mut self, update: &Value) -> ToolCallSnapshot {
        let id = tool_id(update);
        let entry = self.calls.entry(id.clone()).or_insert_with(|| ToolCallSnapshot {
            id: id.clone(),
            kind: "tool".into(),
            title: String::new(),
            status: "inProgress".into(),
            path: None,
            command: None,
            query: None,
            additions: None,
            deletions: None,
            output: String::new(),
        });
        if let Some(kind) = update.get("kind").and_then(Value::as_str) {
            if !kind.is_empty() {
                entry.kind = kind.to_string();
            }
        }
        if let Some(title) = update
            .get("title")
            .or_else(|| update.get("name"))
            .and_then(Value::as_str)
        {
            if !title.is_empty() {
                entry.title = title.to_string();
            }
        }
        if let Some(status) = update.get("status").and_then(Value::as_str) {
            if !status.is_empty() {
                entry.status = status.to_string();
            }
        }
        let input = update
            .get("rawInput")
            .or_else(|| update.get("input"))
            .or_else(|| update.get("arguments"));
        if let Some(input) = input {
            if entry.path.is_none() {
                entry.path = string_field(input, &["path", "file", "filePath"]);
            }
            if entry.command.is_none() {
                entry.command = string_field(input, &["command", "cmd"]);
            }
            if entry.query.is_none() {
                entry.query = string_field(input, &["query", "pattern"]);
            }
        }
        if entry.path.is_none() {
            entry.path = update
                .pointer("/locations/0/path")
                .and_then(Value::as_str)
                .map(str::to_string);
        }
        if let Some(add) = update
            .pointer("/diff/additions")
            .or_else(|| update.get("addedLines"))
            .and_then(Value::as_i64)
        {
            entry.additions = Some(add);
        }
        if let Some(del) = update
            .pointer("/diff/deletions")
            .or_else(|| update.get("removedLines"))
            .and_then(Value::as_i64)
        {
            entry.deletions = Some(del);
        }
        entry.clone()
    }

    fn append_chunk(&mut self, update: &Value) -> ToolCallSnapshot {
        let id = tool_id(update);
        let chunk = update
            .get("content")
            .or_else(|| update.get("text"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let entry = self.calls.entry(id.clone()).or_insert_with(|| ToolCallSnapshot {
            id,
            kind: "tool".into(),
            title: String::new(),
            status: "inProgress".into(),
            path: None,
            command: None,
            query: None,
            additions: None,
            deletions: None,
            output: String::new(),
        });
        entry.output.push_str(chunk);
        entry.clone()
    }
}

/// Holds intermediate text until 50ms have passed. The first chunk and a
/// segment close flush immediately.
#[derive(Debug, Clone)]
pub struct DeltaCoalescer {
    pub window: Duration,
    message: String,
    reasoning: String,
    message_open: bool,
    reasoning_open: bool,
    message_since: Option<Instant>,
    reasoning_since: Option<Instant>,
}

impl Default for DeltaCoalescer {
    fn default() -> Self {
        Self::new(DELTA_WINDOW)
    }
}

impl DeltaCoalescer {
    pub fn new(window: Duration) -> Self {
        Self {
            window,
            message: String::new(),
            reasoning: String::new(),
            message_open: false,
            reasoning_open: false,
            message_since: None,
            reasoning_since: None,
        }
    }

    pub fn push_message(&mut self, text: &str, segment_close: bool, now: Instant) -> Option<String> {
        self.push(true, text, segment_close, now)
    }

    pub fn push_reasoning(&mut self, text: &str, segment_close: bool, now: Instant) -> Option<String> {
        self.push(false, text, segment_close, now)
    }

    pub fn poll(&mut self, now: Instant) -> Vec<String> {
        let (message, reasoning) = self.poll_split(now);
        let mut out = Vec::new();
        if let Some(text) = message {
            out.push(text);
        }
        if let Some(text) = reasoning {
            out.push(text);
        }
        out
    }

    /// Message buffer, then reasoning buffer. Empty buffers stay `None`.
    pub fn poll_split(&mut self, now: Instant) -> (Option<String>, Option<String>) {
        let message = if self.due(self.message_since, now) {
            self.take(true)
        } else {
            None
        };
        let reasoning = if self.due(self.reasoning_since, now) {
            self.take(false)
        } else {
            None
        };
        (message, reasoning)
    }

    pub fn flush_split(&mut self) -> (Option<String>, Option<String>) {
        (self.take(true), self.take(false))
    }

    pub fn pending(&self) -> bool {
        !self.message.is_empty() || !self.reasoning.is_empty()
    }

    fn push(&mut self, message: bool, text: &str, segment_close: bool, now: Instant) -> Option<String> {
        if text.is_empty() && !segment_close {
            return None;
        }
        let (buf, open, since) = if message {
            (&mut self.message, &mut self.message_open, &mut self.message_since)
        } else {
            (
                &mut self.reasoning,
                &mut self.reasoning_open,
                &mut self.reasoning_since,
            )
        };
        let first = !*open && buf.is_empty();
        buf.push_str(text);
        if first || segment_close {
            *open = !segment_close;
            *since = None;
            let flushed = std::mem::take(buf);
            return if flushed.is_empty() { None } else { Some(flushed) };
        }
        *open = true;
        if since.is_none() {
            *since = Some(now);
        }
        None
    }

    fn due(&self, since: Option<Instant>, now: Instant) -> bool {
        since.is_some_and(|start| now.duration_since(start) >= self.window)
    }

    fn take(&mut self, message: bool) -> Option<String> {
        let buf = if message {
            self.message_since = None;
            std::mem::take(&mut self.message)
        } else {
            self.reasoning_since = None;
            std::mem::take(&mut self.reasoning)
        };
        if buf.is_empty() { None } else { Some(buf) }
    }
}

pub fn effective_permission_mode(provider: &str, requested: &str) -> EffectivePermission {
    let provider = provider.trim().to_ascii_lowercase();
    let parsed = PermissionMode::parse(requested);
    let (effective, clamped) = match provider.as_str() {
        "grok" => match parsed {
            Some(PermissionMode::AcceptEdits) => (PermissionMode::Supervised, true),
            Some(mode) => (mode, false),
            None => (PermissionMode::Supervised, true),
        },
        "fx" => match parsed {
            Some(PermissionMode::Supervised) => (PermissionMode::Supervised, false),
            Some(PermissionMode::Auto) => (PermissionMode::Auto, false),
            _ => (PermissionMode::Supervised, true),
        },
        "muse" | "kiro" => match parsed {
            Some(PermissionMode::Supervised) => (PermissionMode::Supervised, false),
            Some(PermissionMode::FullAccess) => (PermissionMode::FullAccess, false),
            _ => (PermissionMode::Supervised, true),
        },
        _ => match parsed {
            Some(mode) => (mode, false),
            None => (PermissionMode::Supervised, true),
        },
    };
    EffectivePermission {
        requested: requested.to_string(),
        effective,
        clamped,
    }
}

/// Automatic grants are one request. A session-wide grant would widen every
/// other thread that shares the server.
pub fn automatic_approval_decision() -> ApprovalDecision {
    ApprovalDecision::AllowOnce
}

/// `fullAccess` grants every tool once. `acceptEdits` grants file edits once
/// and still asks for commands. Questions are never auto-answered.
pub fn should_auto_approve(effective_mode: &str, tool_name: &str) -> bool {
    let name = tool_name.to_ascii_lowercase();
    let command = name.contains("bash")
        || name.contains("shell")
        || name.contains("command")
        || name.contains("terminal")
        || name.contains("exec");
    match effective_mode {
        "fullAccess" => true,
        "acceptEdits" if !command => true,
        _ => false,
    }
}

pub fn classify_turn_failure(exit_code: Option<i32>, stderr: &str, provider: &str) -> Option<TurnFailure> {
    let text = stderr.trim();
    if text.is_empty() && exit_code.unwrap_or(0) == 0 {
        return None;
    }
    let lower = text.to_ascii_lowercase();
    if lower.contains("rate limit") || lower.contains("usage limit") || lower.contains("quota") {
        return Some(TurnFailure::UsageLimit {
            message: bounded(text, 400),
            reset_at_unix_ms: None,
        });
    }
    if lower.contains("sign in")
        || lower.contains("not logged")
        || lower.contains("auth required")
        || lower.contains("unauthorized")
        || lower.contains("not authenticated")
        || lower.contains("authentication required")
        || lower.contains("login")
    {
        return Some(TurnFailure::AuthRequired {
            provider: provider.to_string(),
            message: bounded(text, 400),
        });
    }
    if lower.contains("a value is required")
        || lower.contains("usage:")
        || lower.contains("unexpected argument")
        || lower.contains("unrecognized")
        || lower.contains("flags provided but not defined")
        || lower.contains("invalid model selection")
        || lower.contains("invalid flag")
    {
        return Some(TurnFailure::CliUsageError {
            command: provider.to_string(),
            message: bounded(text, 400),
        });
    }
    if exit_code.unwrap_or(0) != 0 {
        return Some(TurnFailure::ProcessError {
            exit_code,
            message: if text.is_empty() {
                "the provider process exited".into()
            } else {
                bounded(text, 400)
            },
        });
    }
    None
}

#[derive(Debug, Clone, PartialEq)]
pub struct FailureProjection {
    pub assistant_items: Vec<Value>,
    pub failure: Option<TurnFailure>,
}

/// A process failure never becomes an assistant item. Stderr stays on the banner.
pub fn project_process_failure(
    exit_code: Option<i32>,
    stderr: &str,
    provider: &str,
    assistant_items: &[Value],
) -> FailureProjection {
    FailureProjection {
        assistant_items: assistant_items.to_vec(),
        failure: classify_turn_failure(exit_code, stderr, provider),
    }
}

pub fn usage_from_provider(
    input_tokens: i64,
    output_tokens: i64,
    cached_input_tokens: Option<i64>,
    context_window_tokens: Option<i64>,
    duration_seconds: Option<f64>,
) -> UsageReport {
    UsageReport {
        input_tokens,
        output_tokens,
        cached_input_tokens,
        context_window_tokens,
        duration_seconds,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompletionCue {
    Silent,
    Chime,
}

pub fn completion_cue(outcome: &str, thread_focused: bool) -> CompletionCue {
    match outcome {
        "cancelled" | "interrupted" => CompletionCue::Silent,
        "completed" if thread_focused => CompletionCue::Chime,
        _ => CompletionCue::Silent,
    }
}

pub fn follow_up_uses_delta_only(provider_session_id: Option<&str>, session_warm: bool) -> bool {
    session_warm || provider_session_id.is_some_and(|id| !id.is_empty())
}

pub fn catalog_cache_key(provider: &str, connection_id: Option<&str>) -> String {
    let canon = match provider {
        "agy" => "antigravity",
        "claude-code" => "claude",
        "open-code" => "opencode",
        other => other,
    };
    format!("{canon}|{}", connection_id.unwrap_or(""))
}

pub fn grok_permission_flag(mode: PermissionMode) -> &'static str {
    match mode {
        PermissionMode::Supervised => "default",
        PermissionMode::AcceptEdits => "default",
        PermissionMode::Auto => "auto",
        PermissionMode::FullAccess => "bypassPermissions",
    }
}

fn reverse_request(frame: &Value) -> Option<ProviderTurnEvent> {
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

fn user_input_from(frame: &Value) -> UserInputRequest {
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

fn approval_event(frame: &Value) -> ProviderTurnEvent {
    let params = frame.get("params").unwrap_or(frame);
    ProviderTurnEvent::ApprovalRequested {
        request_id: params
            .get("id")
            .or_else(|| frame.get("id"))
            .and_then(Value::as_str)
            .unwrap_or("approval")
            .to_string(),
        tool_name: params
            .get("toolName")
            .or_else(|| params.get("tool_name"))
            .and_then(Value::as_str)
            .unwrap_or("tool")
            .to_string(),
        title: params
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("Approval requested")
            .to_string(),
    }
}

fn plan_event(update: &Value) -> ProviderTurnEvent {
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

fn text_delta(update: &Value) -> Vec<ProviderTurnEvent> {
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

fn reasoning_delta(update: &Value) -> Vec<ProviderTurnEvent> {
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

fn tool_id(update: &Value) -> String {
    update
        .get("toolCallId")
        .or_else(|| update.get("id"))
        .and_then(Value::as_str)
        .unwrap_or("tool")
        .to_string()
}

fn string_field(value: &Value, names: &[&str]) -> Option<String> {
    for name in names {
        if let Some(text) = value.get(*name).and_then(Value::as_str) {
            if !text.is_empty() {
                return Some(text.to_string());
            }
        }
    }
    None
}

fn bounded(text: &str, max: usize) -> String {
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn tool_frames_merge_path_status_and_output_by_id() {
        let mut tracker = ToolCallTracker::default();
        tracker.ingest(&json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "call-1",
            "kind": "read",
            "title": "Read normalize.rs",
            "rawInput": { "path": "src-tauri/src/chat/normalize.rs" }
        }));
        tracker.ingest(&json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": "call-1",
            "status": "completed",
            "locations": [{ "path": "src-tauri/src/chat/normalize.rs" }],
            "diff": { "additions": 18, "deletions": 4 }
        }));
        tracker.ingest(&json!({
            "sessionUpdate": "tool_call_content_chunk",
            "toolCallId": "call-1",
            "content": "merged\n"
        }));
        let snap = tracker.snapshot("call-1").expect("merged tool");
        assert_eq!(snap.path.as_deref(), Some("src-tauri/src/chat/normalize.rs"));
        assert_eq!(snap.status, "completed");
        assert_eq!(snap.additions, Some(18));
        assert_eq!(snap.deletions, Some(4));
        assert_eq!(snap.output, "merged\n");
        assert_eq!(snap.kind, "read");
    }

    #[test]
    fn deltas_flush_the_first_chunk_and_hold_the_next_until_the_window() {
        let mut coalescer = DeltaCoalescer::new(DELTA_WINDOW);
        let start = Instant::now();
        let first = coalescer.push_message("Hello", false, start);
        assert_eq!(first.as_deref(), Some("Hello"));
        assert!(coalescer.push_message(" there", false, start).is_none());
        assert!(coalescer.poll(start + Duration::from_millis(49)).is_empty());
        let flushed = coalescer.poll(start + DELTA_WINDOW);
        assert_eq!(flushed, vec![" there".to_string()]);
        let closed = coalescer.push_reasoning("done", true, start);
        assert_eq!(closed.as_deref(), Some("done"));
    }

    #[test]
    fn unknown_frames_become_notices() {
        let mut tracker = ToolCallTracker::default();
        let events = tracker.ingest(&json!({ "method": "session/dance", "params": {} }));
        assert!(matches!(
            events.first(),
            Some(ProviderTurnEvent::Notice { code, .. }) if code == "unknownFrame"
        ));
    }

    #[test]
    fn reverse_requests_become_questions_plans_and_approvals() {
        let mut tracker = ToolCallTracker::default();
        let question = tracker.ingest(&json!({
            "method": "x.ai/ask_user_question",
            "id": "q-1",
            "params": {
                "questions": [{
                    "id": "color",
                    "header": "Color",
                    "options": ["red", "blue"],
                    "allowCustomAnswer": true,
                    "allowAttachments": false
                }]
            }
        }));
        assert!(matches!(
            question.first(),
            Some(ProviderTurnEvent::UserInputRequested { request }) if request.request_id == "q-1"
        ));
        let plan = tracker.ingest(&json!({
            "method": "x.ai/exit_plan_mode",
            "params": { "title": "Ship it", "plan": "do the thing" }
        }));
        assert!(matches!(plan.first(), Some(ProviderTurnEvent::PlanUpdated { .. })));
        let approval = tracker.ingest(&json!({
            "method": "session/request_permission",
            "id": "perm-1",
            "params": { "toolName": "shell", "title": "Run tests" }
        }));
        assert!(matches!(
            approval.first(),
            Some(ProviderTurnEvent::ApprovalRequested { request_id, .. }) if request_id == "perm-1"
        ));
    }

    #[test]
    fn grok_accept_edits_clamps_to_supervised_and_auto_approval_is_once() {
        let grok = effective_permission_mode("grok", "acceptEdits");
        assert!(grok.clamped);
        assert_eq!(grok.effective, PermissionMode::Supervised);
        assert_eq!(grok_permission_flag(grok.effective), "default");
        let fx = effective_permission_mode("fx", "fullAccess");
        assert_eq!(fx.effective, PermissionMode::Supervised);
        let muse = effective_permission_mode("muse", "auto");
        assert_eq!(muse.effective, PermissionMode::Supervised);
        assert_eq!(automatic_approval_decision(), ApprovalDecision::AllowOnce);
        assert!(should_auto_approve("fullAccess", "bash"));
        assert!(should_auto_approve("acceptEdits", "write_file"));
        assert!(!should_auto_approve("acceptEdits", "bash"));
        assert!(!should_auto_approve("supervised", "write_file"));
    }

    #[test]
    fn clap_usage_on_stderr_adds_no_assistant_item() {
        let projected = project_process_failure(
            Some(2),
            "error: a value is required for '--single <PROMPT>' but none was supplied\nUsage: grok -p <PROMPT>",
            "grok",
            &[],
        );
        assert!(projected.assistant_items.is_empty());
        assert!(matches!(
            projected.failure,
            Some(TurnFailure::CliUsageError { .. })
        ));
    }

    #[test]
    fn auth_and_cli_flag_failures_classify_correctly() {
        let auth = classify_turn_failure(
            Some(1),
            "error: not authenticated. Run 'agy auth' to log in.",
            "antigravity",
        );
        assert!(matches!(auth, Some(TurnFailure::AuthRequired { .. })));

        let flag_err = classify_turn_failure(
            Some(2),
            "flags provided but not defined: -invalid-flag",
            "antigravity",
        );
        assert!(matches!(flag_err, Some(TurnFailure::CliUsageError { .. })));

        let model_err = classify_turn_failure(
            Some(1),
            "error: invalid model selection (--model \"Gemini 3.0 Flash\"): invalid model",
            "antigravity",
        );
        assert!(matches!(model_err, Some(TurnFailure::CliUsageError { .. })));
    }

    #[test]
    fn usage_has_no_synthetic_cost_and_cancel_stays_silent() {
        let usage = usage_from_provider(10, 4, Some(2), Some(128_000), Some(1.5));
        let value = serde_json::to_value(&usage).unwrap();
        assert!(value.get("costUsd").is_none());
        assert_eq!(value["inputTokens"], 10);
        assert_eq!(completion_cue("cancelled", true), CompletionCue::Silent);
        assert_eq!(completion_cue("interrupted", false), CompletionCue::Silent);
        assert_eq!(completion_cue("completed", true), CompletionCue::Chime);
        assert_eq!(completion_cue("completed", false), CompletionCue::Silent);
    }

    #[test]
    fn a_resume_handle_sends_only_the_new_delta() {
        for provider in ["grok", "antigravity", "codex", "claude", "cursor", "opencode"] {
            assert!(
                follow_up_uses_delta_only(Some("provider-session"), false),
                "{provider}"
            );
            assert!(!follow_up_uses_delta_only(None, false), "{provider}");
        }
        assert!(follow_up_uses_delta_only(None, true));
    }

    #[test]
    fn catalogs_are_keyed_by_provider_and_connection() {
        assert_ne!(
            catalog_cache_key("grok", Some("acc-a")),
            catalog_cache_key("grok", Some("acc-b"))
        );
        assert_eq!(
            catalog_cache_key("agy", Some("acc-a")),
            catalog_cache_key("antigravity", Some("acc-a"))
        );
    }

    #[test]
    fn effort_round_trips_through_provider_options() {
        let options = effort_option(&json!([]), Some("high"));
        let thread = json!({ "providerOptions": options });
        assert_eq!(hydrated_effort(&thread).as_deref(), Some("high"));
        let cleared = effort_option(&thread["providerOptions"], None);
        let cleared_thread = json!({ "providerOptions": cleared, "effort": Value::Null });
        assert!(hydrated_effort(&cleared_thread).is_none());
    }
}
