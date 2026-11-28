//! Native Rust ReAct loop engine (`S4`).
//!
//! Orchestrates multi-step streaming provider turns, workspace-sandboxed tool
//! execution, optional MCP tool calls, `NativePermissionMode` approval gating
//! backed by [`crate::chat::approval::ApprovalDecision`], token-budget
//! compaction between steps, and cooperative cancellation.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::chat::approval::ApprovalDecision;
use crate::chat::session::TransportEvent;

use super::compaction;
use super::mcp_client::NativeMcpClient;
use super::tools::{NativeToolRegistry, ToolOutput};
use super::types::{
    FastLaneEndpoint, NativeMessage, NativeRole, NativeStreamChunk, NativeToolCall, NativeToolDef,
    NativeTurnRequest, NativeUsage,
};

pub const DEFAULT_MAX_STEPS: usize = 16;
pub const DEFAULT_TOKEN_BUDGET: usize = 128_000;
pub const MAX_STOP_CONTINUATIONS: usize = 3;
const MAX_RATE_LIMIT_RETRIES: usize = 2;
const MAX_RATE_LIMIT_WAIT_MS: u64 = 5_000;

/// Lifecycle hook event kinds emitted across a ReAct turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum HookEventKind {
    SessionStart,
    PreToolUse,
    PostToolUse,
    PreInvocation,
    PostInvocation,
    Stop,
}

impl HookEventKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::SessionStart => "SessionStart",
            Self::PreToolUse => "PreToolUse",
            Self::PostToolUse => "PostToolUse",
            Self::PreInvocation => "PreInvocation",
            Self::PostInvocation => "PostInvocation",
            Self::Stop => "Stop",
        }
    }
}

/// Permission stance returned by a `PreToolUse` (or session-gate) lifecycle hook.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HookPermissionDecision {
    Allow,
    Deny,
    #[default]
    Ask,
    ForceAsk,
}

/// Optional early-termination directive returned by a lifecycle hook.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HookTerminationBehavior {
    Stop,
    Fail,
}

/// CamelCase JSON payload serialized to lifecycle hook processes and passed to [`NativeHookRunner`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookInvocationContext {
    pub event: HookEventKind,
    pub workspace_root: String,
    pub step: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_input: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_is_error: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assistant_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_prompt: Option<String>,
    pub continuation_active: bool,
    pub continuation_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

/// Normalized result returned by a [`NativeHookRunner`].
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookExecutionOutcome {
    #[serde(default)]
    pub decision: HookPermissionDecision,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub overwrite: Option<Map<String, Value>>,
    #[serde(default)]
    pub inject_steps: Vec<String>,
    #[serde(default)]
    pub termination_behavior: Option<HookTerminationBehavior>,
    #[serde(default, rename = "continue")]
    pub continue_turn: bool,
}

/// Asynchronous lifecycle hook runner executed by [`run_react_loop`].
pub trait NativeHookRunner: Send + Sync + std::fmt::Debug {
    fn run_hook<'a>(
        &'a self,
        ctx: HookInvocationContext,
    ) -> Pin<Box<dyn Future<Output = Result<HookExecutionOutcome, String>> + Send + 'a>>;
}

/// Tool execution policy applied by the native ReAct loop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativePermissionMode {
    ReadOnly,
    Supervised,
    FullAccess,
}

impl NativePermissionMode {
    pub fn from_control_str(raw: Option<&str>) -> Self {
        match raw.unwrap_or("").trim().to_ascii_lowercase().as_str() {
            "fullaccess" | "full_access" | "full-access" | "bypasspermissions" | "auto" => {
                Self::FullAccess
            }
            "readonly" | "read_only" | "read-only" | "plan" => Self::ReadOnly,
            _ => Self::Supervised,
        }
    }
}

/// Returns `true` for built-in mutating tools or external MCP tools that modify state.
pub fn is_mutating_tool(name: &str) -> bool {
    !matches!(name.trim(), "read_file" | "grep_search" | "find_files")
}

/// Runs an async future to completion from synchronous code without panicking on
/// nested Tokio runtimes or deadlocking `current_thread` test runtimes.
pub(crate) fn run_tokio_blocking<F, T>(fut: F) -> Result<T, String>
where
    F: Future<Output = T> + Send,
    T: Send,
{
    if tokio::runtime::Handle::try_current().is_ok() {
        std::thread::scope(|scope| {
            let handle = std::thread::Builder::new()
                .name("kite-native-tokio".to_string())
                .spawn_scoped(scope, move || {
                    let rt = tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                        .map_err(|err| format!("Failed to build Tokio runtime: {err}"))?;
                    Ok::<T, String>(rt.block_on(fut))
                })
                .map_err(|err| format!("Failed to spawn Tokio worker thread: {err}"))?;
            handle
                .join()
                .map_err(|_| "Tokio worker thread panicked".to_string())?
        })
    } else {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|err| format!("Failed to build Tokio runtime: {err}"))?;
        Ok(rt.block_on(fut))
    }
}

/// Streaming provider abstraction enabling scripted mocks in unit tests and real
/// HTTPS/SSE execution via [`HttpNativeProvider`].
pub trait NativeProvider: Send + Sync {
    fn stream_turn(
        &self,
        req: &NativeTurnRequest,
        on_chunk: &mut (dyn FnMut(NativeStreamChunk) + Send),
    ) -> Result<(), String>;

    fn stream_turn_cancellable(
        &self,
        req: &NativeTurnRequest,
        cancel: &AtomicBool,
        on_chunk: &mut (dyn FnMut(NativeStreamChunk) + Send),
    ) -> Result<(), String> {
        if cancel.load(Ordering::Acquire) {
            return Err("turn cancelled".to_string());
        }
        self.stream_turn(req, on_chunk)
    }
}

/// Real HTTPS/SSE provider running [`super::providers::execute_turn`] via Tokio.
#[derive(Debug, Default, Clone, Copy)]
pub struct HttpNativeProvider;

impl HttpNativeProvider {
    pub fn new() -> Self {
        Self
    }
}

impl NativeProvider for HttpNativeProvider {
    fn stream_turn(
        &self,
        req: &NativeTurnRequest,
        on_chunk: &mut (dyn FnMut(NativeStreamChunk) + Send),
    ) -> Result<(), String> {
        run_tokio_blocking(super::providers::execute_turn(req, on_chunk))?
    }

    fn stream_turn_cancellable(
        &self,
        req: &NativeTurnRequest,
        cancel: &AtomicBool,
        on_chunk: &mut (dyn FnMut(NativeStreamChunk) + Send),
    ) -> Result<(), String> {
        if cancel.load(Ordering::Acquire) {
            return Err("turn cancelled".to_string());
        }
        run_tokio_blocking(async {
            let turn_fut = super::providers::execute_turn(req, on_chunk);
            tokio::pin!(turn_fut);
            loop {
                tokio::select! {
                    res = &mut turn_fut => return res,
                    _ = tokio::time::sleep(Duration::from_millis(20)) => {
                        if cancel.load(Ordering::Acquire) {
                            return Err("turn cancelled".to_string());
                        }
                    }
                }
            }
        })?
    }
}

/// Approval prompt metadata passed to a [`NativeApprovalGate`].
#[derive(Debug, Clone)]
pub struct NativeApprovalRequest {
    pub request_id: String,
    pub tool_name: String,
    pub arguments: Value,
}

/// Interactive approval callback/channel invoked under [`NativePermissionMode::Supervised`].
pub trait NativeApprovalGate: Send + Sync {
    fn request_approval(
        &self,
        req: &NativeApprovalRequest,
        cancel: &AtomicBool,
    ) -> Result<ApprovalDecision, String>;
}

/// Configuration for a single [`run_react_loop`] execution.
#[derive(Debug, Clone)]
pub struct ReactLoopConfig {
    pub endpoint: FastLaneEndpoint,
    pub workspace_root: PathBuf,
    pub system_prompt: Option<String>,
    pub permission_mode: NativePermissionMode,
    pub max_steps: usize,
    pub token_budget: usize,
    pub max_tokens: Option<u32>,
    pub extra_tools: Vec<NativeToolDef>,
    pub mcp_client: Option<NativeMcpClient>,
    pub mcp_tool_names: HashSet<String>,
    pub hook_runner: Option<Arc<dyn NativeHookRunner>>,
}

impl ReactLoopConfig {
    pub fn new(endpoint: FastLaneEndpoint, workspace_root: PathBuf) -> Self {
        Self {
            endpoint,
            workspace_root,
            system_prompt: None,
            permission_mode: NativePermissionMode::Supervised,
            max_steps: DEFAULT_MAX_STEPS,
            token_budget: DEFAULT_TOKEN_BUDGET,
            max_tokens: None,
            extra_tools: Vec::new(),
            mcp_client: None,
            mcp_tool_names: HashSet::new(),
            hook_runner: None,
        }
    }
}

/// Summary returned when [`run_react_loop`] settles cleanly.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReactLoopOutcome {
    pub steps_executed: usize,
    pub final_text: String,
    pub total_usage: NativeUsage,
    pub compactions: usize,
}

fn sleep_with_cancel(total_ms: u64, cancel: &AtomicBool) -> bool {
    let mut remaining = total_ms.min(MAX_RATE_LIMIT_WAIT_MS);
    while remaining > 0 {
        if cancel.load(Ordering::Acquire) {
            return false;
        }
        let slice = remaining.min(20);
        std::thread::sleep(Duration::from_millis(slice));
        remaining -= slice;
    }
    !cancel.load(Ordering::Acquire)
}

fn parse_tool_arguments(raw: &str) -> Result<Value, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str::<Value>(trimmed)
        .map_err(|err| format!("Invalid JSON tool arguments: {err}"))
}

fn execute_authorized_tool(
    registry: &NativeToolRegistry,
    config: &ReactLoopConfig,
    name: &str,
    args: Value,
) -> ToolOutput {
    if let Some(mcp_client) = config.mcp_client.as_ref() {
        if config.mcp_tool_names.contains(name) {
            return match run_tokio_blocking(mcp_client.call_tool(name, args)) {
                Ok(Ok(output)) => ToolOutput::success(output, false),
                Ok(Err(err)) | Err(err) => ToolOutput::error(err),
            };
        }
    }
    registry.execute(&config.workspace_root, name, args)
}

enum ToolGateResult {
    Allowed,
    Denied(String),
    StopTurn(String),
}

fn request_gate_approval(
    call_name: &str,
    args: &Value,
    approval_gate: Option<&dyn NativeApprovalGate>,
    session_approved: &mut bool,
    cancel: &AtomicBool,
    hook_reason: Option<&str>,
    missing_gate_default: &str,
) -> ToolGateResult {
    let Some(gate) = approval_gate else {
        let msg = hook_reason
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| missing_gate_default.replace("{name}", call_name));
        return ToolGateResult::Denied(msg);
    };
    let req = NativeApprovalRequest {
        request_id: format!("native-req-{}", uuid::Uuid::new_v4().simple()),
        tool_name: call_name.to_string(),
        arguments: args.clone(),
    };
    match gate.request_approval(&req, cancel) {
        Ok(ApprovalDecision::AllowOnce) => ToolGateResult::Allowed,
        Ok(ApprovalDecision::AllowForSession | ApprovalDecision::AlwaysAllow) => {
            *session_approved = true;
            ToolGateResult::Allowed
        }
        Ok(ApprovalDecision::Deny) => ToolGateResult::Denied(format!(
            "Permission denied by user for tool '{call_name}'."
        )),
        Ok(ApprovalDecision::DenyAndStop) => ToolGateResult::StopTurn("turn cancelled".to_string()),
        Err(err) => {
            if cancel.load(Ordering::Acquire) || err == "turn cancelled" {
                ToolGateResult::StopTurn("turn cancelled".to_string())
            } else {
                ToolGateResult::Denied(format!(
                    "Approval failed for tool '{call_name}': {err}"
                ))
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn check_tool_permission(
    mode: NativePermissionMode,
    call_name: &str,
    args: &Value,
    hook_decision: HookPermissionDecision,
    hook_reason: Option<&str>,
    approval_gate: Option<&dyn NativeApprovalGate>,
    session_approved: &mut bool,
    cancel: &AtomicBool,
) -> ToolGateResult {
    if hook_decision == HookPermissionDecision::Deny {
        let reason = hook_reason
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("Tool '{call_name}' denied by lifecycle hook."));
        return ToolGateResult::Denied(reason);
    }

    if hook_decision == HookPermissionDecision::ForceAsk {
        if mode == NativePermissionMode::ReadOnly && is_mutating_tool(call_name) {
            return ToolGateResult::Denied(format!(
                "Tool '{call_name}' is denied because permission mode is ReadOnly."
            ));
        }
        return request_gate_approval(
            call_name,
            args,
            approval_gate,
            session_approved,
            cancel,
            hook_reason,
            "Tool '{name}' requires user approval (forced by lifecycle hook).",
        );
    }

    if !is_mutating_tool(call_name) {
        return ToolGateResult::Allowed;
    }

    match mode {
        NativePermissionMode::FullAccess => ToolGateResult::Allowed,
        NativePermissionMode::ReadOnly => ToolGateResult::Denied(format!(
            "Tool '{call_name}' is denied because permission mode is ReadOnly."
        )),
        NativePermissionMode::Supervised => {
            if hook_decision == HookPermissionDecision::Allow || *session_approved {
                return ToolGateResult::Allowed;
            }
            request_gate_approval(
                call_name,
                args,
                approval_gate,
                session_approved,
                cancel,
                hook_reason,
                "Tool '{name}' requires user approval in Supervised mode.",
            )
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn build_hook_context(
    config: &ReactLoopConfig,
    event: HookEventKind,
    step: usize,
    continuation_active: bool,
    continuation_count: usize,
    tool_name: Option<String>,
    tool_input: Option<Value>,
    tool_output: Option<String>,
    tool_is_error: Option<bool>,
    assistant_text: Option<String>,
    user_prompt: Option<String>,
) -> HookInvocationContext {
    HookInvocationContext {
        event,
        workspace_root: config.workspace_root.to_string_lossy().into_owned(),
        step,
        tool_name,
        tool_input,
        tool_output,
        tool_is_error,
        assistant_text,
        user_prompt,
        continuation_active,
        continuation_count,
        session_id: config.endpoint.session_header.clone(),
    }
}

fn invoke_hook(
    runner: Option<&Arc<dyn NativeHookRunner>>,
    ctx: HookInvocationContext,
    on_event: &mut (dyn FnMut(TransportEvent) + Send),
) -> Option<HookExecutionOutcome> {
    let runner = runner?;
    let event_name = ctx.event.as_str();
    match run_tokio_blocking(runner.run_hook(ctx)) {
        Ok(Ok(outcome)) => Some(outcome),
        Ok(Err(err)) | Err(err) => {
            on_event(TransportEvent::Activity(
                json!({
                    "type": "hook_error",
                    "event": event_name,
                    "message": err,
                })
                .to_string(),
            ));
            None
        }
    }
}

fn push_injected_steps(history: &mut Vec<NativeMessage>, steps: &[String]) {
    for step_text in steps {
        if step_text.trim().is_empty() {
            continue;
        }
        history.push(NativeMessage {
            role: NativeRole::User,
            content: step_text.clone(),
            tool_call_id: None,
            tool_calls: Vec::new(),
        });
    }
}

fn merge_shallow_overwrite(args: Value, overwrite: &Map<String, Value>) -> (Value, bool) {
    if overwrite.is_empty() {
        return (args, false);
    }
    let mut map = match args {
        Value::Object(existing) => existing,
        Value::Null => Map::new(),
        other => return (other, false),
    };
    for (k, v) in overwrite {
        map.insert(k.clone(), v.clone());
    }
    (Value::Object(map), true)
}

enum HookLoopControl {
    Continue,
    StopClean,
    Fail(String),
}

fn evaluate_hook_control(
    outcome: &HookExecutionOutcome,
    allow_decision_deny: bool,
    default_fail_msg: &str,
) -> HookLoopControl {
    if outcome.termination_behavior == Some(HookTerminationBehavior::Fail)
        || (allow_decision_deny && outcome.decision == HookPermissionDecision::Deny)
    {
        let reason = outcome
            .reason
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(default_fail_msg)
            .to_string();
        return HookLoopControl::Fail(reason);
    }
    if outcome.termination_behavior == Some(HookTerminationBehavior::Stop) {
        return HookLoopControl::StopClean;
    }
    HookLoopControl::Continue
}

fn emit_hook_terminated(
    on_event: &mut (dyn FnMut(TransportEvent) + Send),
    event: HookEventKind,
    reason: Option<&str>,
) {
    on_event(TransportEvent::Activity(
        json!({
            "type": "hook_terminated",
            "event": event.as_str(),
            "behavior": "stop",
            "reason": reason,
        })
        .to_string(),
    ));
}

/// Executes the multi-step ReAct loop against `provider` and `registry`,
/// emitting normalized [`TransportEvent`]s into `on_event`.
#[allow(clippy::too_many_arguments)]
pub fn run_react_loop(
    provider: &dyn NativeProvider,
    registry: &NativeToolRegistry,
    config: &ReactLoopConfig,
    history: &mut Vec<NativeMessage>,
    user_prompt: &str,
    cancel: &AtomicBool,
    approval_gate: Option<&dyn NativeApprovalGate>,
    session_approved: &mut bool,
    on_event: &mut (dyn FnMut(TransportEvent) + Send),
) -> Result<ReactLoopOutcome, String> {
    if cancel.load(Ordering::Acquire) {
        on_event(TransportEvent::TurnFailed("turn cancelled".to_string()));
        return Err("turn cancelled".to_string());
    }

    let initial_user_prompt = (!user_prompt.trim().is_empty()).then(|| user_prompt.to_string());
    if let Some(ref prompt_text) = initial_user_prompt {
        history.push(NativeMessage {
            role: NativeRole::User,
            content: prompt_text.clone(),
            tool_call_id: None,
            tool_calls: Vec::new(),
        });
    } else if history.is_empty() {
        let err = "a turn needs a message".to_string();
        on_event(TransportEvent::TurnFailed(err.clone()));
        return Err(err);
    }

    let mut all_tools = registry.definitions();
    for extra in &config.extra_tools {
        if !all_tools.iter().any(|existing| existing.name == extra.name) {
            all_tools.push(extra.clone());
        }
    }

    let max_steps = config.max_steps.max(1);
    let mut total_usage = NativeUsage::default();
    let mut compactions = 0usize;
    let mut continuation_active = false;
    let mut continuation_count = 0usize;

    if let Some(outcome) = invoke_hook(
        config.hook_runner.as_ref(),
        build_hook_context(
            config,
            HookEventKind::SessionStart,
            0,
            continuation_active,
            continuation_count,
            None,
            None,
            None,
            None,
            None,
            initial_user_prompt.clone(),
        ),
        on_event,
    ) {
        push_injected_steps(history, &outcome.inject_steps);
        match evaluate_hook_control(&outcome, true, "Turn aborted by SessionStart lifecycle hook.") {
            HookLoopControl::Continue => {}
            HookLoopControl::StopClean => {
                emit_hook_terminated(
                    on_event,
                    HookEventKind::SessionStart,
                    outcome.reason.as_deref(),
                );
                on_event(TransportEvent::TurnEnded);
                return Ok(ReactLoopOutcome {
                    steps_executed: 0,
                    final_text: outcome.reason.unwrap_or_default(),
                    total_usage,
                    compactions,
                });
            }
            HookLoopControl::Fail(reason) => {
                on_event(TransportEvent::TurnFailed(reason.clone()));
                return Err(reason);
            }
        }
    }

    for step in 0..max_steps {
        if cancel.load(Ordering::Acquire) {
            on_event(TransportEvent::TurnFailed("turn cancelled".to_string()));
            return Err("turn cancelled".to_string());
        }

        if compaction::compact_messages(history, config.token_budget) {
            compactions += 1;
        }

        if let Some(outcome) = invoke_hook(
            config.hook_runner.as_ref(),
            build_hook_context(
                config,
                HookEventKind::PreInvocation,
                step,
                continuation_active,
                continuation_count,
                None,
                None,
                None,
                None,
                None,
                None,
            ),
            on_event,
        ) {
            push_injected_steps(history, &outcome.inject_steps);
            match evaluate_hook_control(
                &outcome,
                true,
                "Turn aborted by PreInvocation lifecycle hook.",
            ) {
                HookLoopControl::Continue => {}
                HookLoopControl::StopClean => {
                    emit_hook_terminated(
                        on_event,
                        HookEventKind::PreInvocation,
                        outcome.reason.as_deref(),
                    );
                    on_event(TransportEvent::TurnEnded);
                    return Ok(ReactLoopOutcome {
                        steps_executed: step,
                        final_text: outcome.reason.unwrap_or_default(),
                        total_usage,
                        compactions,
                    });
                }
                HookLoopControl::Fail(reason) => {
                    on_event(TransportEvent::TurnFailed(reason.clone()));
                    return Err(reason);
                }
            }
            if !outcome.inject_steps.is_empty()
                && compaction::compact_messages(history, config.token_budget)
            {
                compactions += 1;
            }
        }

        let req = NativeTurnRequest {
            endpoint: config.endpoint.clone(),
            system_prompt: config.system_prompt.clone(),
            messages: history.clone(),
            tools: all_tools.clone(),
            max_tokens: config.max_tokens,
        };

        let mut step_text = String::new();
        let mut pending_calls: Vec<NativeToolCall> = Vec::new();
        let mut call_index_by_id: HashMap<String, usize> = HashMap::new();
        let mut step_usage = NativeUsage::default();
        let mut stream_error: Option<String> = None;

        for retry_attempt in 0..=MAX_RATE_LIMIT_RETRIES {
            step_text.clear();
            pending_calls.clear();
            call_index_by_id.clear();
            step_usage = NativeUsage::default();
            stream_error = None;
            let mut rate_limit: Option<(Option<u64>, String)> = None;

            let call_res = {
                let mut chunk_handler = |chunk: NativeStreamChunk| {
                    if cancel.load(Ordering::Acquire) {
                        return;
                    }
                    match chunk {
                        NativeStreamChunk::TextDelta(text) => {
                            if !text.is_empty() {
                                step_text.push_str(&text);
                                on_event(TransportEvent::Text(text));
                            }
                        }
                        NativeStreamChunk::ReasoningDelta(text) => {
                            if !text.is_empty() {
                                on_event(TransportEvent::Activity(
                                    json!({
                                        "type": "thinking",
                                        "text": text,
                                    })
                                    .to_string(),
                                ));
                            }
                        }
                        NativeStreamChunk::ToolCallStart { id, name } => {
                            if let Some(&idx) = call_index_by_id.get(&id) {
                                if pending_calls[idx].name.is_empty() && !name.is_empty() {
                                    pending_calls[idx].name = name.clone();
                                }
                            } else {
                                let idx = pending_calls.len();
                                call_index_by_id.insert(id.clone(), idx);
                                pending_calls.push(NativeToolCall {
                                    id: id.clone(),
                                    name: name.clone(),
                                    arguments: String::new(),
                                });
                            }
                            on_event(TransportEvent::Activity(
                                json!({
                                    "type": "tool_use",
                                    "id": id,
                                    "name": name,
                                    "input": {},
                                })
                                .to_string(),
                            ));
                        }
                        NativeStreamChunk::ToolCallDelta {
                            id,
                            arguments_delta,
                        } => {
                            if let Some(&idx) = call_index_by_id.get(&id) {
                                pending_calls[idx].arguments.push_str(&arguments_delta);
                            } else if !id.is_empty() {
                                let idx = pending_calls.len();
                                call_index_by_id.insert(id.clone(), idx);
                                pending_calls.push(NativeToolCall {
                                    id,
                                    name: String::new(),
                                    arguments: arguments_delta,
                                });
                            } else if let Some(last) = pending_calls.last_mut() {
                                last.arguments.push_str(&arguments_delta);
                            }
                        }
                        NativeStreamChunk::Usage(usage) => {
                            step_usage.input_tokens =
                                step_usage.input_tokens.max(usage.input_tokens);
                            step_usage.output_tokens =
                                step_usage.output_tokens.max(usage.output_tokens);
                            step_usage.cached_tokens =
                                step_usage.cached_tokens.max(usage.cached_tokens);
                            on_event(TransportEvent::Activity(
                                json!({
                                    "type": "usage_update",
                                    "usage": {
                                        "inputTokens": total_usage.input_tokens.saturating_add(step_usage.input_tokens),
                                        "outputTokens": total_usage.output_tokens.saturating_add(step_usage.output_tokens),
                                        "cachedInputTokens": total_usage.cached_tokens.saturating_add(step_usage.cached_tokens),
                                    }
                                })
                                .to_string(),
                            ));
                        }
                        NativeStreamChunk::Done => {}
                        NativeStreamChunk::RateLimited {
                            retry_after_ms,
                            message,
                        } => {
                            rate_limit = Some((retry_after_ms, message));
                        }
                        NativeStreamChunk::Error(err) => {
                            stream_error = Some(err);
                        }
                    }
                };
                provider.stream_turn_cancellable(&req, cancel, &mut chunk_handler)
            };

            if cancel.load(Ordering::Acquire) {
                on_event(TransportEvent::TurnFailed("turn cancelled".to_string()));
                return Err("turn cancelled".to_string());
            }

            if let Err(err) = call_res {
                let reason = if cancel.load(Ordering::Acquire) || err == "turn cancelled" {
                    "turn cancelled".to_string()
                } else {
                    err
                };
                on_event(TransportEvent::TurnFailed(reason.clone()));
                return Err(reason);
            }

            if let Some(err) = stream_error {
                on_event(TransportEvent::TurnFailed(err.clone()));
                return Err(err);
            }

            if let Some((retry_after_ms, msg)) = rate_limit {
                if step_text.is_empty()
                    && pending_calls.is_empty()
                    && retry_attempt < MAX_RATE_LIMIT_RETRIES
                {
                    let wait_ms = retry_after_ms.unwrap_or(250);
                    if !sleep_with_cancel(wait_ms, cancel) {
                        on_event(TransportEvent::TurnFailed("turn cancelled".to_string()));
                        return Err("turn cancelled".to_string());
                    }
                    continue;
                }
                if step_text.is_empty() && pending_calls.is_empty() {
                    let err = format!("Rate limited: {msg}");
                    on_event(TransportEvent::TurnFailed(err.clone()));
                    return Err(err);
                }
            }

            break;
        }

        total_usage.input_tokens = total_usage
            .input_tokens
            .saturating_add(step_usage.input_tokens);
        total_usage.output_tokens = total_usage
            .output_tokens
            .saturating_add(step_usage.output_tokens);
        total_usage.cached_tokens = total_usage
            .cached_tokens
            .saturating_add(step_usage.cached_tokens);

        history.push(NativeMessage {
            role: NativeRole::Assistant,
            content: step_text.clone(),
            tool_call_id: None,
            tool_calls: pending_calls.clone(),
        });

        let mut deferred_post_invocation_steps: Vec<String> = Vec::new();
        if let Some(outcome) = invoke_hook(
            config.hook_runner.as_ref(),
            build_hook_context(
                config,
                HookEventKind::PostInvocation,
                step,
                continuation_active,
                continuation_count,
                None,
                None,
                None,
                None,
                Some(step_text.clone()),
                None,
            ),
            on_event,
        ) {
            match evaluate_hook_control(
                &outcome,
                true,
                "Turn aborted by PostInvocation lifecycle hook.",
            ) {
                HookLoopControl::Continue => {
                    if pending_calls.is_empty() {
                        push_injected_steps(history, &outcome.inject_steps);
                    } else {
                        deferred_post_invocation_steps = outcome.inject_steps;
                    }
                }
                HookLoopControl::StopClean => {
                    emit_hook_terminated(
                        on_event,
                        HookEventKind::PostInvocation,
                        outcome.reason.as_deref(),
                    );
                    on_event(TransportEvent::TurnEnded);
                    return Ok(ReactLoopOutcome {
                        steps_executed: step + 1,
                        final_text: step_text,
                        total_usage,
                        compactions,
                    });
                }
                HookLoopControl::Fail(reason) => {
                    on_event(TransportEvent::TurnFailed(reason.clone()));
                    return Err(reason);
                }
            }
        }

        if pending_calls.is_empty() {
            if let Some(outcome) = invoke_hook(
                config.hook_runner.as_ref(),
                build_hook_context(
                    config,
                    HookEventKind::Stop,
                    step,
                    continuation_active,
                    continuation_count,
                    None,
                    None,
                    None,
                    None,
                    Some(step_text.clone()),
                    None,
                ),
                on_event,
            ) {
                match evaluate_hook_control(
                    &outcome,
                    true,
                    "Turn aborted by Stop lifecycle hook.",
                ) {
                    HookLoopControl::Fail(reason) => {
                        on_event(TransportEvent::TurnFailed(reason.clone()));
                        return Err(reason);
                    }
                    HookLoopControl::StopClean => {
                        emit_hook_terminated(
                            on_event,
                            HookEventKind::Stop,
                            outcome.reason.as_deref(),
                        );
                        on_event(TransportEvent::TurnEnded);
                        return Ok(ReactLoopOutcome {
                            steps_executed: step + 1,
                            final_text: step_text,
                            total_usage,
                            compactions,
                        });
                    }
                    HookLoopControl::Continue => {
                        if outcome.continue_turn && continuation_count < MAX_STOP_CONTINUATIONS {
                            continuation_active = true;
                            continuation_count += 1;
                            let before_len = history.len();
                            push_injected_steps(history, &outcome.inject_steps);
                            if history.len() == before_len {
                                let fallback = outcome
                                    .reason
                                    .as_deref()
                                    .map(str::trim)
                                    .filter(|s| !s.is_empty())
                                    .unwrap_or("Continue working on the remaining requirements.")
                                    .to_string();
                                history.push(NativeMessage {
                                    role: NativeRole::User,
                                    content: fallback,
                                    tool_call_id: None,
                                    tool_calls: Vec::new(),
                                });
                            }
                            on_event(TransportEvent::Activity(
                                json!({
                                    "type": "hook_continue",
                                    "event": "Stop",
                                    "continuationCount": continuation_count,
                                    "continuationActive": true,
                                })
                                .to_string(),
                            ));
                            if compaction::compact_messages(history, config.token_budget) {
                                compactions += 1;
                            }
                            continue;
                        }
                    }
                }
            }

            on_event(TransportEvent::TurnEnded);
            return Ok(ReactLoopOutcome {
                steps_executed: step + 1,
                final_text: step_text,
                total_usage,
                compactions,
            });
        }

        let mut post_loop_inject_steps = deferred_post_invocation_steps;
        let mut terminate_after_tools: Option<(HookEventKind, HookLoopControl)> = None;

        for (call_idx, call) in pending_calls.iter().enumerate() {
            if cancel.load(Ordering::Acquire) {
                on_event(TransportEvent::TurnFailed("turn cancelled".to_string()));
                return Err("turn cancelled".to_string());
            }

            let parsed_args = parse_tool_arguments(&call.arguments);
            let mut effective_args_for_exec = parsed_args;
            let mut pre_hook_decision = HookPermissionDecision::Ask;
            let mut pre_hook_reason: Option<String> = None;
            let mut args_rewritten = false;
            let mut pre_hook_control = HookLoopControl::Continue;

            if let Ok(current_args) = effective_args_for_exec {
                let mut merged_args = current_args;
                if let Some(outcome) = invoke_hook(
                    config.hook_runner.as_ref(),
                    build_hook_context(
                        config,
                        HookEventKind::PreToolUse,
                        step,
                        continuation_active,
                        continuation_count,
                        Some(call.name.clone()),
                        Some(merged_args.clone()),
                        None,
                        None,
                        None,
                        None,
                    ),
                    on_event,
                ) {
                    if let Some(ref overwrite_map) = outcome.overwrite {
                        let (updated, did_merge) =
                            merge_shallow_overwrite(merged_args, overwrite_map);
                        merged_args = updated;
                        args_rewritten = did_merge;
                    }
                    pre_hook_decision = outcome.decision;
                    pre_hook_reason = outcome.reason.clone();
                    post_loop_inject_steps.extend(
                        outcome
                            .inject_steps
                            .iter()
                            .filter(|s| !s.trim().is_empty())
                            .cloned(),
                    );
                    // On PreToolUse, `decision == Deny` blocks only this tool call;
                    // only `terminationBehavior` aborts or stops the turn.
                    pre_hook_control = evaluate_hook_control(
                        &outcome,
                        false,
                        "Turn aborted by PreToolUse lifecycle hook.",
                    );
                }
                effective_args_for_exec = Ok(merged_args);
            }

            let args_for_ui = effective_args_for_exec.clone().unwrap_or_else(|_| json!({}));
            on_event(TransportEvent::Activity(
                json!({
                    "type": "tool_use",
                    "id": call.id,
                    "name": call.name,
                    "input": args_for_ui,
                })
                .to_string(),
            ));

            match pre_hook_control {
                HookLoopControl::Continue => {}
                HookLoopControl::StopClean => {
                    let reason = pre_hook_reason
                        .as_deref()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .unwrap_or("Tool execution stopped by PreToolUse lifecycle hook.")
                        .to_string();
                    on_event(TransportEvent::Activity(
                        json!({
                            "type": "tool_result",
                            "tool_use_id": call.id,
                            "id": call.id,
                            "name": call.name,
                            "output": reason,
                            "content": reason,
                            "is_error": false,
                        })
                        .to_string(),
                    ));
                    history.push(NativeMessage {
                        role: NativeRole::Tool,
                        content: reason,
                        tool_call_id: Some(call.id.clone()),
                        tool_calls: Vec::new(),
                    });
                    for remaining in &pending_calls[call_idx + 1..] {
                        history.push(NativeMessage {
                            role: NativeRole::Tool,
                            content: "[skipped: turn stopped by lifecycle hook]".to_string(),
                            tool_call_id: Some(remaining.id.clone()),
                            tool_calls: Vec::new(),
                        });
                    }
                    push_injected_steps(history, &post_loop_inject_steps);
                    emit_hook_terminated(
                        on_event,
                        HookEventKind::PreToolUse,
                        pre_hook_reason.as_deref(),
                    );
                    on_event(TransportEvent::TurnEnded);
                    return Ok(ReactLoopOutcome {
                        steps_executed: step + 1,
                        final_text: step_text,
                        total_usage,
                        compactions,
                    });
                }
                HookLoopControl::Fail(reason) => {
                    on_event(TransportEvent::Activity(
                        json!({
                            "type": "tool_result",
                            "tool_use_id": call.id,
                            "id": call.id,
                            "name": call.name,
                            "output": reason,
                            "content": reason,
                            "is_error": true,
                        })
                        .to_string(),
                    ));
                    on_event(TransportEvent::TurnFailed(reason.clone()));
                    return Err(reason);
                }
            }

            let mut executed_args_for_post: Option<Value> = None;
            let mut output = match effective_args_for_exec {
                Err(parse_err) => ToolOutput::error(parse_err),
                Ok(args) => {
                    match check_tool_permission(
                        config.permission_mode,
                        &call.name,
                        &args,
                        pre_hook_decision,
                        pre_hook_reason.as_deref(),
                        approval_gate,
                        session_approved,
                        cancel,
                    ) {
                        ToolGateResult::Allowed => {
                            executed_args_for_post = Some(args.clone());
                            execute_authorized_tool(registry, config, &call.name, args)
                        }
                        ToolGateResult::Denied(reason) => {
                            executed_args_for_post = Some(args);
                            ToolOutput::error(reason)
                        }
                        ToolGateResult::StopTurn(reason) => {
                            on_event(TransportEvent::Activity(
                                json!({
                                    "type": "tool_result",
                                    "tool_use_id": call.id,
                                    "id": call.id,
                                    "name": call.name,
                                    "output": reason,
                                    "content": reason,
                                    "is_error": true,
                                })
                                .to_string(),
                            ));
                            on_event(TransportEvent::TurnFailed(reason.clone()));
                            return Err(reason);
                        }
                    }
                }
            };

            if args_rewritten {
                let notice = format!(
                    "[hook] Tool '{}' arguments modified by lifecycle hook",
                    call.name
                );
                if output.content.trim().is_empty() {
                    output.content = notice;
                } else {
                    output.content.push('\n');
                    output.content.push_str(&notice);
                }
            }

            on_event(TransportEvent::Activity(
                json!({
                    "type": "tool_result",
                    "tool_use_id": call.id,
                    "id": call.id,
                    "name": call.name,
                    "output": output.content,
                    "content": output.content,
                    "is_error": !output.ok,
                })
                .to_string(),
            ));

            history.push(NativeMessage {
                role: NativeRole::Tool,
                content: output.content.clone(),
                tool_call_id: Some(call.id.clone()),
                tool_calls: Vec::new(),
            });

            if let Some(outcome) = invoke_hook(
                config.hook_runner.as_ref(),
                build_hook_context(
                    config,
                    HookEventKind::PostToolUse,
                    step,
                    continuation_active,
                    continuation_count,
                    Some(call.name.clone()),
                    executed_args_for_post,
                    Some(output.content),
                    Some(!output.ok),
                    None,
                    None,
                ),
                on_event,
            ) {
                post_loop_inject_steps.extend(
                    outcome
                        .inject_steps
                        .iter()
                        .filter(|s| !s.trim().is_empty())
                        .cloned(),
                );
                let ctrl = evaluate_hook_control(
                    &outcome,
                    true,
                    "Turn aborted by PostToolUse lifecycle hook.",
                );
                if !matches!(ctrl, HookLoopControl::Continue) {
                    for remaining in &pending_calls[call_idx + 1..] {
                        history.push(NativeMessage {
                            role: NativeRole::Tool,
                            content: "[skipped: turn terminated by lifecycle hook]".to_string(),
                            tool_call_id: Some(remaining.id.clone()),
                            tool_calls: Vec::new(),
                        });
                    }
                    terminate_after_tools = Some((HookEventKind::PostToolUse, ctrl));
                    break;
                }
            }
        }

        push_injected_steps(history, &post_loop_inject_steps);

        if let Some((event, ctrl)) = terminate_after_tools {
            match ctrl {
                HookLoopControl::Continue => {}
                HookLoopControl::StopClean => {
                    emit_hook_terminated(on_event, event, None);
                    on_event(TransportEvent::TurnEnded);
                    return Ok(ReactLoopOutcome {
                        steps_executed: step + 1,
                        final_text: step_text,
                        total_usage,
                        compactions,
                    });
                }
                HookLoopControl::Fail(reason) => {
                    on_event(TransportEvent::TurnFailed(reason.clone()));
                    return Err(reason);
                }
            }
        }

        if compaction::compact_messages(history, config.token_budget) {
            compactions += 1;
        }
    }

    let err = format!("Native ReAct loop exceeded max_steps ({max_steps})");
    on_event(TransportEvent::TurnFailed(err.clone()));
    Err(err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native_agent::types::{resolve_fast_lane_endpoint, FastLaneEndpoint};
    use std::collections::VecDeque;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    fn test_endpoint(base_url: Option<&str>) -> FastLaneEndpoint {
        resolve_fast_lane_endpoint(
            "openai",
            "gpt-5-mini",
            Some("test-key-123"),
            base_url,
            "api_key",
            None,
        )
        .unwrap()
    }

    fn temp_workspace(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "kite-native-loop-{tag}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    struct ScriptedProvider {
        steps: Mutex<VecDeque<Vec<NativeStreamChunk>>>,
        seen_requests: Mutex<Vec<NativeTurnRequest>>,
    }

    impl ScriptedProvider {
        fn new(steps: Vec<Vec<NativeStreamChunk>>) -> Self {
            Self {
                steps: Mutex::new(VecDeque::from(steps)),
                seen_requests: Mutex::new(Vec::new()),
            }
        }
    }

    impl NativeProvider for ScriptedProvider {
        fn stream_turn(
            &self,
            req: &NativeTurnRequest,
            on_chunk: &mut (dyn FnMut(NativeStreamChunk) + Send),
        ) -> Result<(), String> {
            self.seen_requests.lock().unwrap().push(req.clone());
            let next = self
                .steps
                .lock()
                .unwrap()
                .pop_front()
                .ok_or_else(|| "no scripted step remaining".to_string())?;
            for chunk in next {
                on_chunk(chunk);
            }
            Ok(())
        }
    }

    struct ScriptedApprovalGate {
        decisions: Mutex<VecDeque<ApprovalDecision>>,
        calls: Mutex<Vec<NativeApprovalRequest>>,
    }

    impl ScriptedApprovalGate {
        fn new(decisions: Vec<ApprovalDecision>) -> Self {
            Self {
                decisions: Mutex::new(VecDeque::from(decisions)),
                calls: Mutex::new(Vec::new()),
            }
        }
    }

    impl NativeApprovalGate for ScriptedApprovalGate {
        fn request_approval(
            &self,
            req: &NativeApprovalRequest,
            _cancel: &AtomicBool,
        ) -> Result<ApprovalDecision, String> {
            self.calls.lock().unwrap().push(req.clone());
            Ok(self
                .decisions
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(ApprovalDecision::Deny))
        }
    }

    #[test]
    fn multi_step_react_loop_executes_tools_and_emits_structured_events() {
        let ws = temp_workspace("multi");
        std::fs::write(ws.join("notes.txt"), "hello fast lane").unwrap();

        let provider = ScriptedProvider::new(vec![
            vec![
                NativeStreamChunk::ReasoningDelta("Checking notes.txt".into()),
                NativeStreamChunk::ToolCallStart {
                    id: "call_1".into(),
                    name: "read_file".into(),
                },
                NativeStreamChunk::ToolCallDelta {
                    id: "call_1".into(),
                    arguments_delta: r#"{"path":"notes.txt"}"#.into(),
                },
                NativeStreamChunk::Usage(NativeUsage {
                    input_tokens: 10,
                    output_tokens: 5,
                    cached_tokens: 0,
                }),
                NativeStreamChunk::Done,
            ],
            vec![
                NativeStreamChunk::TextDelta("Read ".into()),
                NativeStreamChunk::TextDelta("notes.txt successfully.".into()),
                NativeStreamChunk::Usage(NativeUsage {
                    input_tokens: 20,
                    output_tokens: 6,
                    cached_tokens: 5,
                }),
                NativeStreamChunk::Done,
            ],
        ]);

        let registry = NativeToolRegistry::new();
        let mut config = ReactLoopConfig::new(test_endpoint(None), ws.clone());
        config.permission_mode = NativePermissionMode::ReadOnly;

        let mut history = Vec::new();
        let cancel = AtomicBool::new(false);
        let mut session_approved = false;
        let mut events = Vec::new();

        let outcome = run_react_loop(
            &provider,
            &registry,
            &config,
            &mut history,
            "Read notes.txt",
            &cancel,
            None,
            &mut session_approved,
            &mut |ev| events.push(ev),
        )
        .unwrap();

        assert_eq!(outcome.steps_executed, 2);
        assert_eq!(outcome.final_text, "Read notes.txt successfully.");
        assert_eq!(outcome.total_usage.input_tokens, 30);
        assert_eq!(outcome.total_usage.output_tokens, 11);
        assert_eq!(outcome.total_usage.cached_tokens, 5);

        let activities: Vec<Value> = events
            .iter()
            .filter_map(|ev| match ev {
                TransportEvent::Activity(line) => serde_json::from_str::<Value>(line).ok(),
                _ => None,
            })
            .collect();

        assert!(activities.iter().any(|v| v["type"] == "thinking"));
        assert!(activities
            .iter()
            .any(|v| v["type"] == "tool_use" && v["name"] == "read_file"));
        assert!(activities.iter().any(|v| {
            v["type"] == "tool_result"
                && v["tool_use_id"] == "call_1"
                && v["is_error"] == false
                && v["output"]
                    .as_str()
                    .is_some_and(|s| s.contains("hello fast lane"))
        }));
        assert!(matches!(events.last(), Some(TransportEvent::TurnEnded)));

        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn readonly_mode_denies_mutating_tools_without_writing() {
        let ws = temp_workspace("readonly");
        let target = ws.join("blocked.txt");

        let provider = ScriptedProvider::new(vec![
            vec![
                NativeStreamChunk::ToolCallStart {
                    id: "call_w".into(),
                    name: "write_file".into(),
                },
                NativeStreamChunk::ToolCallDelta {
                    id: "call_w".into(),
                    arguments_delta: r#"{"path":"blocked.txt","content":"nope"}"#.into(),
                },
                NativeStreamChunk::Done,
            ],
            vec![
                NativeStreamChunk::TextDelta("Cannot write in ReadOnly mode.".into()),
                NativeStreamChunk::Done,
            ],
        ]);

        let registry = NativeToolRegistry::new();
        let mut config = ReactLoopConfig::new(test_endpoint(None), ws.clone());
        config.permission_mode = NativePermissionMode::ReadOnly;

        let mut history = Vec::new();
        let cancel = AtomicBool::new(false);
        let mut session_approved = false;
        let mut events = Vec::new();

        let outcome = run_react_loop(
            &provider,
            &registry,
            &config,
            &mut history,
            "Write file",
            &cancel,
            None,
            &mut session_approved,
            &mut |ev| events.push(ev),
        )
        .unwrap();

        assert_eq!(outcome.steps_executed, 2);
        assert!(!target.exists());
        let has_error_result = events.iter().any(|ev| match ev {
            TransportEvent::Activity(line) => {
                serde_json::from_str::<Value>(line).is_ok_and(|v| {
                    v["type"] == "tool_result" && v["is_error"] == true
                })
            }
            _ => false,
        });
        assert!(has_error_result);
        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn supervised_gate_supports_allow_for_session_and_deny() {
        let ws = temp_workspace("supervised");

        // 1. Deny first write, then AllowForSession on second write, third write skips prompt
        let provider = ScriptedProvider::new(vec![
            vec![
                NativeStreamChunk::ToolCallStart {
                    id: "c1".into(),
                    name: "write_file".into(),
                },
                NativeStreamChunk::ToolCallDelta {
                    id: "c1".into(),
                    arguments_delta: r#"{"path":"a.txt","content":"denied"}"#.into(),
                },
                NativeStreamChunk::Done,
            ],
            vec![
                NativeStreamChunk::ToolCallStart {
                    id: "c2".into(),
                    name: "write_file".into(),
                },
                NativeStreamChunk::ToolCallDelta {
                    id: "c2".into(),
                    arguments_delta: r#"{"path":"b.txt","content":"approved-1"}"#.into(),
                },
                NativeStreamChunk::Done,
            ],
            vec![
                NativeStreamChunk::ToolCallStart {
                    id: "c3".into(),
                    name: "write_file".into(),
                },
                NativeStreamChunk::ToolCallDelta {
                    id: "c3".into(),
                    arguments_delta: r#"{"path":"c.txt","content":"approved-2"}"#.into(),
                },
                NativeStreamChunk::Done,
            ],
            vec![
                NativeStreamChunk::TextDelta("Completed writes.".into()),
                NativeStreamChunk::Done,
            ],
        ]);

        let gate = ScriptedApprovalGate::new(vec![
            ApprovalDecision::Deny,
            ApprovalDecision::AllowForSession,
        ]);

        let registry = NativeToolRegistry::new();
        let mut config = ReactLoopConfig::new(test_endpoint(None), ws.clone());
        config.permission_mode = NativePermissionMode::Supervised;

        let mut history = Vec::new();
        let cancel = AtomicBool::new(false);
        let mut session_approved = false;
        let mut events = Vec::new();

        let outcome = run_react_loop(
            &provider,
            &registry,
            &config,
            &mut history,
            "Write files",
            &cancel,
            Some(&gate),
            &mut session_approved,
            &mut |ev| events.push(ev),
        )
        .unwrap();

        assert_eq!(outcome.steps_executed, 4);
        assert!(session_approved);
        assert_eq!(gate.calls.lock().unwrap().len(), 2);
        assert!(!ws.join("a.txt").exists());
        assert_eq!(std::fs::read_to_string(ws.join("b.txt")).unwrap(), "approved-1");
        assert_eq!(std::fs::read_to_string(ws.join("c.txt")).unwrap(), "approved-2");

        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn cancellation_emits_turn_failed_without_executing_tools() {
        let ws = temp_workspace("cancel");

        struct CancellingProvider {
            cancel: Arc<AtomicBool>,
        }
        impl NativeProvider for CancellingProvider {
            fn stream_turn(
                &self,
                _req: &NativeTurnRequest,
                on_chunk: &mut (dyn FnMut(NativeStreamChunk) + Send),
            ) -> Result<(), String> {
                on_chunk(NativeStreamChunk::TextDelta("partial".into()));
                self.cancel.store(true, Ordering::Release);
                on_chunk(NativeStreamChunk::Done);
                Ok(())
            }
        }

        let cancel = Arc::new(AtomicBool::new(false));
        let provider = CancellingProvider {
            cancel: Arc::clone(&cancel),
        };
        let registry = NativeToolRegistry::new();
        let config = ReactLoopConfig::new(test_endpoint(None), ws.clone());
        let mut history = Vec::new();
        let mut session_approved = false;
        let mut events = Vec::new();

        let err = run_react_loop(
            &provider,
            &registry,
            &config,
            &mut history,
            "Start turn",
            &cancel,
            None,
            &mut session_approved,
            &mut |ev| events.push(ev),
        )
        .unwrap_err();

        assert_eq!(err, "turn cancelled");
        assert!(matches!(
            events.last(),
            Some(TransportEvent::TurnFailed(msg)) if msg == "turn cancelled"
        ));
        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn compacts_large_tool_outputs_between_steps() {
        let ws = temp_workspace("compact");
        let big_body = "abcdef1234567890 ".repeat(200); // ~3400 chars
        std::fs::write(ws.join("big.txt"), &big_body).unwrap();

        let provider = ScriptedProvider::new(vec![
            vec![
                NativeStreamChunk::ToolCallStart {
                    id: "big_read".into(),
                    name: "read_file".into(),
                },
                NativeStreamChunk::ToolCallDelta {
                    id: "big_read".into(),
                    arguments_delta: r#"{"path":"big.txt"}"#.into(),
                },
                NativeStreamChunk::Done,
            ],
            vec![
                NativeStreamChunk::ToolCallStart {
                    id: "small_read".into(),
                    name: "find_files".into(),
                },
                NativeStreamChunk::ToolCallDelta {
                    id: "small_read".into(),
                    arguments_delta: r#"{}"#.into(),
                },
                NativeStreamChunk::Done,
            ],
            vec![
                NativeStreamChunk::TextDelta("Finished.".into()),
                NativeStreamChunk::Done,
            ],
        ]);

        let registry = NativeToolRegistry::new();
        let mut config = ReactLoopConfig::new(test_endpoint(None), ws.clone());
        config.permission_mode = NativePermissionMode::ReadOnly;
        config.token_budget = 600; // forces compaction once big.txt (~850+ tokens) enters history

        let mut history = Vec::new();
        let cancel = AtomicBool::new(false);
        let mut session_approved = false;
        let mut events = Vec::new();

        let outcome = run_react_loop(
            &provider,
            &registry,
            &config,
            &mut history,
            "Inspect big.txt then list files",
            &cancel,
            None,
            &mut session_approved,
            &mut |ev| events.push(ev),
        )
        .unwrap();

        assert!(outcome.compactions >= 1);
        let seen = provider.seen_requests.lock().unwrap();
        assert_eq!(seen.len(), 3);
        let _ = std::fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn http_native_provider_runs_inside_current_thread_tokio_runtime() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();

        let server_thread = std::thread::spawn(move || {
            if let Ok((mut socket, _)) = listener.accept() {
                let mut buf = [0u8; 4096];
                let _ = socket.read(&mut buf);
                let sse_body = concat!(
                    "data: {\"choices\":[{\"delta\":{\"content\":\"hi from sse\"}}]}\n\n",
                    "data: [DONE]\n\n"
                );
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    sse_body.len(),
                    sse_body
                );
                let _ = socket.write_all(response.as_bytes());
                let _ = socket.flush();
            }
        });

        let provider = HttpNativeProvider::new();
        let req = NativeTurnRequest {
            endpoint: test_endpoint(Some(&format!("http://127.0.0.1:{}", addr.port()))),
            system_prompt: None,
            messages: vec![NativeMessage {
                role: NativeRole::User,
                content: "say hi".into(),
                tool_call_id: None,
                tool_calls: Vec::new(),
            }],
            tools: Vec::new(),
            max_tokens: Some(64),
        };

        let mut chunks = Vec::new();
        provider
            .stream_turn(&req, &mut |c| chunks.push(c))
            .expect("nested tokio invocation should succeed without panic or deadlock");
        assert!(chunks
            .iter()
            .any(|c| matches!(c, NativeStreamChunk::TextDelta(t) if t == "hi from sse")));
        let _ = server_thread.join();
    }

    struct MockHookRunner {
        seen: Mutex<Vec<HookInvocationContext>>,
        handler: Box<dyn Fn(&HookInvocationContext) -> Result<HookExecutionOutcome, String> + Send + Sync>,
    }

    impl std::fmt::Debug for MockHookRunner {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.debug_struct("MockHookRunner").finish()
        }
    }

    impl MockHookRunner {
        fn new<F>(handler: F) -> Arc<Self>
        where
            F: Fn(&HookInvocationContext) -> Result<HookExecutionOutcome, String> + Send + Sync + 'static,
        {
            Arc::new(Self {
                seen: Mutex::new(Vec::new()),
                handler: Box::new(handler),
            })
        }

        fn events_seen(&self) -> Vec<HookInvocationContext> {
            self.seen.lock().unwrap().clone()
        }
    }

    impl NativeHookRunner for MockHookRunner {
        fn run_hook<'a>(
            &'a self,
            ctx: HookInvocationContext,
        ) -> Pin<Box<dyn Future<Output = Result<HookExecutionOutcome, String>> + Send + 'a>>
        {
            let res = {
                self.seen.lock().unwrap().push(ctx.clone());
                (self.handler)(&ctx)
            };
            Box::pin(async move { res })
        }
    }

    #[test]
    fn lifecycle_hooks_pre_tool_use_overwrite_allow_and_rewrite_notice() {
        let ws = temp_workspace("hook-overwrite");

        let provider = ScriptedProvider::new(vec![
            vec![
                NativeStreamChunk::ToolCallStart {
                    id: "c1".into(),
                    name: "write_file".into(),
                },
                NativeStreamChunk::ToolCallDelta {
                    id: "c1".into(),
                    arguments_delta: r#"{"path":"note.txt","content":"raw-body"}"#.into(),
                },
                NativeStreamChunk::Done,
            ],
            vec![
                NativeStreamChunk::TextDelta("Wrote sanitized note.".into()),
                NativeStreamChunk::Done,
            ],
        ]);

        let hook_runner = MockHookRunner::new(|ctx| {
            if ctx.event == HookEventKind::PreToolUse && ctx.tool_name.as_deref() == Some("write_file") {
                let mut overwrite = Map::new();
                overwrite.insert("content".to_string(), json!("sanitized-body"));
                return Ok(HookExecutionOutcome {
                    decision: HookPermissionDecision::Allow,
                    overwrite: Some(overwrite),
                    ..Default::default()
                });
            }
            Ok(HookExecutionOutcome::default())
        });

        let registry = NativeToolRegistry::new();
        let mut config = ReactLoopConfig::new(test_endpoint(None), ws.clone());
        // Supervised without approval gate: PreToolUse `Allow` bypasses supervised gate.
        config.permission_mode = NativePermissionMode::Supervised;
        config.hook_runner = Some(hook_runner.clone());

        let mut history = Vec::new();
        let cancel = AtomicBool::new(false);
        let mut session_approved = false;
        let mut events = Vec::new();

        let outcome = run_react_loop(
            &provider,
            &registry,
            &config,
            &mut history,
            "Write note.txt",
            &cancel,
            None,
            &mut session_approved,
            &mut |ev| events.push(ev),
        )
        .unwrap();

        assert_eq!(outcome.steps_executed, 2);
        assert_eq!(
            std::fs::read_to_string(ws.join("note.txt")).unwrap(),
            "sanitized-body"
        );
        assert!(!session_approved, "PreToolUse Allow must not globally mark session_approved");

        let expected_notice = "[hook] Tool 'write_file' arguments modified by lifecycle hook";
        let has_notice_in_result = events.iter().any(|ev| match ev {
            TransportEvent::Activity(line) => serde_json::from_str::<Value>(line).is_ok_and(|v| {
                v["type"] == "tool_result"
                    && v["is_error"] == false
                    && v["output"].as_str().is_some_and(|s| s.contains(expected_notice))
            }),
            _ => false,
        });
        assert!(has_notice_in_result, "tool_result must carry rewrite notice");
        assert!(
            history
                .iter()
                .any(|m| m.role == NativeRole::Tool && m.content.contains(expected_notice)),
            "history tool message must carry rewrite notice"
        );

        let seen = hook_runner.events_seen();
        let post_tool = seen
            .iter()
            .find(|c| c.event == HookEventKind::PostToolUse)
            .expect("PostToolUse fired");
        assert_eq!(
            post_tool.tool_input.as_ref().and_then(|v| v.get("content")).and_then(Value::as_str),
            Some("sanitized-body")
        );
        assert_eq!(post_tool.tool_is_error, Some(false));

        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn lifecycle_hooks_deny_and_force_ask_decisions() {
        let ws = temp_workspace("hook-deny-force-ask");
        std::fs::write(ws.join("readme.txt"), "secret-data").unwrap();

        let provider = ScriptedProvider::new(vec![
            vec![
                NativeStreamChunk::ToolCallStart {
                    id: "c_deny".into(),
                    name: "write_file".into(),
                },
                NativeStreamChunk::ToolCallDelta {
                    id: "c_deny".into(),
                    arguments_delta: r#"{"path":"blocked.txt","content":"bad"}"#.into(),
                },
                NativeStreamChunk::Done,
            ],
            vec![
                NativeStreamChunk::ToolCallStart {
                    id: "c_ask_deny".into(),
                    name: "read_file".into(),
                },
                NativeStreamChunk::ToolCallDelta {
                    id: "c_ask_deny".into(),
                    arguments_delta: r#"{"path":"readme.txt"}"#.into(),
                },
                NativeStreamChunk::Done,
            ],
            vec![
                NativeStreamChunk::ToolCallStart {
                    id: "c_ask_allow".into(),
                    name: "read_file".into(),
                },
                NativeStreamChunk::ToolCallDelta {
                    id: "c_ask_allow".into(),
                    arguments_delta: r#"{"path":"readme.txt"}"#.into(),
                },
                NativeStreamChunk::Done,
            ],
            vec![
                NativeStreamChunk::TextDelta("Done checking hooks.".into()),
                NativeStreamChunk::Done,
            ],
        ]);

        let hook_runner = MockHookRunner::new(|ctx| {
            if ctx.event == HookEventKind::PreToolUse {
                match ctx.tool_name.as_deref() {
                    Some("write_file") => {
                        return Ok(HookExecutionOutcome {
                            decision: HookPermissionDecision::Deny,
                            reason: Some("blocked by security hook".into()),
                            ..Default::default()
                        });
                    }
                    Some("read_file") => {
                        return Ok(HookExecutionOutcome {
                            decision: HookPermissionDecision::ForceAsk,
                            reason: Some("reading sensitive file requires confirmation".into()),
                            ..Default::default()
                        });
                    }
                    _ => {}
                }
            }
            Ok(HookExecutionOutcome::default())
        });

        let gate = ScriptedApprovalGate::new(vec![
            ApprovalDecision::Deny,
            ApprovalDecision::AllowOnce,
        ]);

        let registry = NativeToolRegistry::new();
        let mut config = ReactLoopConfig::new(test_endpoint(None), ws.clone());
        // FullAccess + session_approved = true normally auto-allows everything;
        // hook Deny and ForceAsk must still take effect.
        config.permission_mode = NativePermissionMode::FullAccess;
        config.hook_runner = Some(hook_runner);

        let mut history = Vec::new();
        let cancel = AtomicBool::new(false);
        let mut session_approved = true;
        let mut events = Vec::new();

        let outcome = run_react_loop(
            &provider,
            &registry,
            &config,
            &mut history,
            "Test deny and force_ask",
            &cancel,
            Some(&gate),
            &mut session_approved,
            &mut |ev| events.push(ev),
        )
        .unwrap();

        assert_eq!(outcome.steps_executed, 4);
        assert!(!ws.join("blocked.txt").exists());
        assert_eq!(gate.calls.lock().unwrap().len(), 2);

        let tool_results: Vec<Value> = events
            .iter()
            .filter_map(|ev| match ev {
                TransportEvent::Activity(line) => serde_json::from_str::<Value>(line)
                    .ok()
                    .filter(|v| v["type"] == "tool_result"),
                _ => None,
            })
            .collect();
        assert_eq!(tool_results.len(), 3);
        assert_eq!(tool_results[0]["is_error"], true);
        assert!(tool_results[0]["output"]
            .as_str()
            .is_some_and(|s| s.contains("blocked by security hook")));
        assert_eq!(tool_results[1]["is_error"], true);
        assert_eq!(tool_results[2]["is_error"], false);
        assert!(tool_results[2]["output"]
            .as_str()
            .is_some_and(|s| s.contains("secret-data")));

        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn lifecycle_hooks_inject_steps_and_session_start_termination() {
        let ws = temp_workspace("hook-inject-abort");

        // 1) SessionStart, PreInvocation, PostInvocation, PostToolUse injectSteps flow.
        let provider = ScriptedProvider::new(vec![
            vec![
                NativeStreamChunk::ToolCallStart {
                    id: "c1".into(),
                    name: "find_files".into(),
                },
                NativeStreamChunk::ToolCallDelta {
                    id: "c1".into(),
                    arguments_delta: "{}".into(),
                },
                NativeStreamChunk::Done,
            ],
            vec![
                NativeStreamChunk::TextDelta("All checked.".into()),
                NativeStreamChunk::Done,
            ],
        ]);

        let hook_runner = MockHookRunner::new(|ctx| match ctx.event {
            HookEventKind::SessionStart => Ok(HookExecutionOutcome {
                inject_steps: vec!["SessionStart guidance".into()],
                ..Default::default()
            }),
            HookEventKind::PreInvocation if ctx.step == 0 => Ok(HookExecutionOutcome {
                inject_steps: vec!["PreInvocation step-0 guidance".into()],
                ..Default::default()
            }),
            HookEventKind::PostToolUse => Ok(HookExecutionOutcome {
                inject_steps: vec!["PostToolUse follow-up".into()],
                ..Default::default()
            }),
            _ => Ok(HookExecutionOutcome::default()),
        });

        let registry = NativeToolRegistry::new();
        let mut config = ReactLoopConfig::new(test_endpoint(None), ws.clone());
        config.hook_runner = Some(hook_runner.clone());

        let mut history = Vec::new();
        let cancel = AtomicBool::new(false);
        let mut session_approved = false;
        let mut events = Vec::new();

        let outcome = run_react_loop(
            &provider,
            &registry,
            &config,
            &mut history,
            "Run checks",
            &cancel,
            None,
            &mut session_approved,
            &mut |ev| events.push(ev),
        )
        .unwrap();
        assert_eq!(outcome.steps_executed, 2);

        let seen_reqs = provider.seen_requests.lock().unwrap();
        assert!(seen_reqs[0]
            .messages
            .iter()
            .any(|m| m.content == "SessionStart guidance"));
        assert!(seen_reqs[0]
            .messages
            .iter()
            .any(|m| m.content == "PreInvocation step-0 guidance"));
        assert!(seen_reqs[1]
            .messages
            .iter()
            .any(|m| m.content == "PostToolUse follow-up"));

        // 2) SessionStart deny aborts cleanly before calling provider.
        let never_called_provider = ScriptedProvider::new(vec![]);
        let deny_runner = MockHookRunner::new(|ctx| {
            if ctx.event == HookEventKind::SessionStart {
                return Ok(HookExecutionOutcome {
                    decision: HookPermissionDecision::Deny,
                    reason: Some("workspace policy blocked turn".into()),
                    ..Default::default()
                });
            }
            Ok(HookExecutionOutcome::default())
        });
        let mut deny_cfg = ReactLoopConfig::new(test_endpoint(None), ws.clone());
        deny_cfg.hook_runner = Some(deny_runner);
        let mut deny_history = Vec::new();
        let mut deny_events = Vec::new();
        let err = run_react_loop(
            &never_called_provider,
            &registry,
            &deny_cfg,
            &mut deny_history,
            "Should abort",
            &cancel,
            None,
            &mut session_approved,
            &mut |ev| deny_events.push(ev),
        )
        .unwrap_err();
        assert_eq!(err, "workspace policy blocked turn");
        assert!(never_called_provider.seen_requests.lock().unwrap().is_empty());
        assert!(matches!(
            deny_events.last(),
            Some(TransportEvent::TurnFailed(msg)) if msg == "workspace policy blocked turn"
        ));

        // 3) SessionStart terminationBehavior = Stop ends cleanly with 0 steps.
        let stop_runner = MockHookRunner::new(|ctx| {
            if ctx.event == HookEventKind::SessionStart {
                return Ok(HookExecutionOutcome {
                    termination_behavior: Some(HookTerminationBehavior::Stop),
                    reason: Some("handled by session hook".into()),
                    ..Default::default()
                });
            }
            Ok(HookExecutionOutcome::default())
        });
        let mut stop_cfg = ReactLoopConfig::new(test_endpoint(None), ws.clone());
        stop_cfg.hook_runner = Some(stop_runner);
        let mut stop_history = Vec::new();
        let mut stop_events = Vec::new();
        let stop_outcome = run_react_loop(
            &never_called_provider,
            &registry,
            &stop_cfg,
            &mut stop_history,
            "Stop early",
            &cancel,
            None,
            &mut session_approved,
            &mut |ev| stop_events.push(ev),
        )
        .unwrap();
        assert_eq!(stop_outcome.steps_executed, 0);
        assert_eq!(stop_outcome.final_text, "handled by session hook");
        assert!(matches!(stop_events.last(), Some(TransportEvent::TurnEnded)));

        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn lifecycle_hooks_stop_continue_caps_at_three_continuations() {
        let ws = temp_workspace("hook-stop-cap");

        let provider = ScriptedProvider::new(vec![
            vec![NativeStreamChunk::TextDelta("Initial reply.".into()), NativeStreamChunk::Done],
            vec![NativeStreamChunk::TextDelta("Continuation 1.".into()), NativeStreamChunk::Done],
            vec![NativeStreamChunk::TextDelta("Continuation 2.".into()), NativeStreamChunk::Done],
            vec![NativeStreamChunk::TextDelta("Continuation 3.".into()), NativeStreamChunk::Done],
            vec![NativeStreamChunk::TextDelta("Should never run.".into()), NativeStreamChunk::Done],
        ]);

        let hook_runner = MockHookRunner::new(|ctx| {
            if ctx.event == HookEventKind::Stop {
                return Ok(HookExecutionOutcome {
                    continue_turn: true,
                    inject_steps: vec![format!("Continue iteration {}", ctx.continuation_count + 1)],
                    ..Default::default()
                });
            }
            Ok(HookExecutionOutcome::default())
        });

        let registry = NativeToolRegistry::new();
        let mut config = ReactLoopConfig::new(test_endpoint(None), ws.clone());
        config.hook_runner = Some(hook_runner.clone());

        let mut history = Vec::new();
        let cancel = AtomicBool::new(false);
        let mut session_approved = false;
        let mut events = Vec::new();

        let outcome = run_react_loop(
            &provider,
            &registry,
            &config,
            &mut history,
            "Keep working until verified",
            &cancel,
            None,
            &mut session_approved,
            &mut |ev| events.push(ev),
        )
        .unwrap();

        // 1 initial turn + max 3 continuations = 4 steps total.
        assert_eq!(outcome.steps_executed, 4);
        assert_eq!(outcome.final_text, "Continuation 3.");
        assert_eq!(provider.seen_requests.lock().unwrap().len(), 4);
        assert!(matches!(events.last(), Some(TransportEvent::TurnEnded)));

        let seen = hook_runner.events_seen();
        let stop_contexts: Vec<(bool, usize)> = seen
            .iter()
            .filter(|c| c.event == HookEventKind::Stop)
            .map(|c| (c.continuation_active, c.continuation_count))
            .collect();
        assert_eq!(
            stop_contexts,
            vec![(false, 0), (true, 1), (true, 2), (true, 3)]
        );

        let pre_contexts: Vec<(bool, usize)> = seen
            .iter()
            .filter(|c| c.event == HookEventKind::PreInvocation)
            .map(|c| (c.continuation_active, c.continuation_count))
            .collect();
        assert_eq!(
            pre_contexts,
            vec![(false, 0), (true, 1), (true, 2), (true, 3)]
        );

        let _ = std::fs::remove_dir_all(&ws);
    }
}
