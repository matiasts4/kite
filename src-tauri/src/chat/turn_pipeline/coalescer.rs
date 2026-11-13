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
