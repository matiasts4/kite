//! Fallback transcript reader and projector for stalled Antigravity (`agy`) stdout streams.
//!
//! When Antigravity encounters a transient stream interruption during in-flight tool calls,
//! its CLI resumes internally and writes progress to `<brain>/<cid>/.system_generated/logs/`
//! while `stdout` stops emitting `step_update` and terminal `result` frames. This module
//! inspects that on-disk transcript outside locks and projects missing steps and completion
//! state back into the live Kite run and thread.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use serde_json::{json, Value};

use crate::acp::{build_acp_tool_call, parse_output_json, response_indicates_failure, strip_mcp_prefix};
use crate::chat::subagents::{
    antigravity_brain_logs_dir, reconcile_antigravity_subagents_for_thread_with_session,
};
use crate::chat::threads::{sanitize_chat_text, touch};
use crate::persist::{persist_async, threads};

use super::state::{emit_notice_item, live_cv, live_turns};
use super::stream_json::{emit_fallback_step_deltas, record_acp_tool_update};
use super::turn::append_event;

pub const STALL_PROBE_DELAY: Duration = Duration::from_secs(12);
pub const STALL_PROBE_INTERVAL: Duration = Duration::from_secs(1);
pub const COMPLETED_SETTLE_GRACE: Duration = Duration::from_secs(5);
pub const IMMEDIATE_ERROR_SETTLE_GRACE: Duration = Duration::from_secs(8);
pub const TRANSIENT_ERROR_SETTLE_GRACE: Duration = Duration::from_secs(30);
pub const API_RETRY_ERROR_SETTLE_GRACE: Duration = Duration::from_secs(120);

const BACKGROUND_TASK_MARKER: &str = "Tool is running as a background task with task id:";
const INTERRUPTED_TOOL_TEXT: &str = "Interrupted before completion; retried in subsequent steps.";

#[derive(Clone, Debug, PartialEq)]
pub struct TranscriptToolCall {
    pub name: String,
    pub args: Value,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TranscriptStep {
    pub step_index: i64,
    pub step_type: String,
    pub status: String,
    pub created_at_ms: Option<i64>,
    pub error: Option<String>,
    pub content: String,
    pub tool_calls: Vec<TranscriptToolCall>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TranscriptVerdict {
    NoCatchupNeeded,
    ActiveProgress,
    Completed {
        step_index: i64,
    },
    TerminalError {
        step_index: i64,
        message: String,
        immediate: bool,
    },
}

#[derive(Default)]
pub struct TranscriptCatchupState {
    pub baseline_step_index: Option<i64>,
    pub baseline_initialized: bool,
    pub projected_step_cursor: Option<i64>,
    pub max_projected_step_index: Option<i64>,
    pub last_file_len: u64,
    pub last_modified: Option<SystemTime>,
    pub settled_error_steps: HashSet<i64>,
    pub projected_planner_steps: HashSet<i64>,
    pub emitted_running_tool_steps: HashSet<i64>,
    pub completed_generic_steps: HashSet<i64>,
    pub projected_misc_steps: HashSet<i64>,
    pub settled_task_ids: HashSet<String>,
    pub pending_tool_map: HashMap<i64, (String, TranscriptToolCall)>,
    pub pending_bg_task_tools: HashMap<String, (i64, String, TranscriptToolCall)>,
    pub catchup_activated: bool,
    pub last_verdict_key: Option<(i64, u8, Instant)>,
    pub last_verdict: Option<TranscriptVerdict>,
}

impl TranscriptCatchupState {
    /// Returns `(ok, error_message)` once a terminal transcript verdict has remained stable
    /// past its settle grace window and stdout has also stayed silent for `COMPLETED_SETTLE_GRACE`.
    pub fn ready_to_settle(
        &self,
        verdict: &TranscriptVerdict,
        now: Instant,
        stdout_silent_for: Duration,
    ) -> Option<(bool, String)> {
        match verdict {
            TranscriptVerdict::Completed { step_index } => {
                let (_, _, since) = self.last_verdict_key.filter(|(s, kind, _)| *s == *step_index && *kind == 1)?;
                if now.saturating_duration_since(since) >= COMPLETED_SETTLE_GRACE
                    && stdout_silent_for >= COMPLETED_SETTLE_GRACE
                {
                    Some((true, String::new()))
                } else {
                    None
                }
            }
            TranscriptVerdict::TerminalError {
                step_index,
                message,
                immediate,
            } => {
                let (_, _, since) = self.last_verdict_key.filter(|(s, kind, _)| *s == *step_index && *kind == 2)?;
                let grace = if *immediate {
                    IMMEDIATE_ERROR_SETTLE_GRACE
                } else if is_in_flight_api_retry_error(message) {
                    API_RETRY_ERROR_SETTLE_GRACE
                } else {
                    TRANSIENT_ERROR_SETTLE_GRACE
                };
                if now.saturating_duration_since(since) >= grace
                    && stdout_silent_for >= COMPLETED_SETTLE_GRACE
                {
                    Some((false, message.clone()))
                } else {
                    None
                }
            }
            _ => None,
        }
    }

    fn record_verdict_stability(&mut self, verdict: &TranscriptVerdict, now: Instant) {
        let next_key = match verdict {
            TranscriptVerdict::Completed { step_index } => Some((*step_index, 1u8)),
            TranscriptVerdict::TerminalError { step_index, .. } => Some((*step_index, 2u8)),
            _ => None,
        };
        match (self.last_verdict_key, next_key) {
            (Some((ps, pk, since)), Some((ns, nk))) if ps == ns && pk == nk => {
                self.last_verdict_key = Some((ns, nk, since));
            }
            (_, Some((ns, nk))) => {
                self.last_verdict_key = Some((ns, nk, now));
            }
            (_, None) => {
                self.last_verdict_key = None;
            }
        }
        self.last_verdict = Some(verdict.clone());
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct CatchupPollResult {
    pub projected_updates: bool,
    pub verdict: TranscriptVerdict,
}

pub fn is_antigravity_driver(driver: &str) -> bool {
    matches!(
        driver.trim().to_ascii_lowercase().as_str(),
        "antigravity" | "agy"
    )
}

pub fn extract_step_index_from_stream_line(line: &str) -> Option<i64> {
    let trimmed = line.trim();
    if !trimmed.starts_with('{') || !trimmed.ends_with('}') {
        return None;
    }
    let val = serde_json::from_str::<Value>(trimmed).ok()?;
    val.pointer("/step_update/step_index")
        .and_then(Value::as_i64)
}

pub fn resolve_transcript_file(logs_dir: &Path) -> Option<PathBuf> {
    let full = logs_dir.join("transcript_full.jsonl");
    if full.is_file() {
        return Some(full);
    }
    let compact = logs_dir.join("transcript.jsonl");
    compact.is_file().then_some(compact)
}

pub fn read_baseline_max_step_for_session(session_id: &str) -> Option<i64> {
    let dir = antigravity_brain_logs_dir(session_id)?;
    read_baseline_max_step_in_dir(&dir)
}

pub fn read_baseline_max_step_in_dir(logs_dir: &Path) -> Option<i64> {
    let path = resolve_transcript_file(logs_dir)?;
    let raw = fs::read_to_string(path).ok()?;
    parse_transcript_steps(&raw).last().map(|s| s.step_index)
}

pub fn parse_transcript_steps(raw: &str) -> Vec<TranscriptStep> {
    let mut steps = Vec::new();
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(val) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        let Some(step_index) = val.get("step_index").and_then(Value::as_i64) else {
            continue;
        };
        let step_type = val
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_ascii_uppercase();
        if step_type.is_empty() {
            continue;
        }
        let status = val
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("DONE")
            .trim()
            .to_ascii_uppercase();
        let created_at_ms = val
            .get("created_at")
            .and_then(Value::as_str)
            .and_then(|s| crate::quota::utils::chrono_parse_rfc3339(s).ok());
        let error = val
            .get("error")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let raw_content = val
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or("");
        let content = if matches!(step_type.as_str(), "PLANNER_RESPONSE" | "USER_INPUT") {
            sanitize_chat_text(raw_content)
        } else {
            raw_content.to_string()
        };
        let mut tool_calls = Vec::new();
        if let Some(tcs) = val.get("tool_calls").and_then(Value::as_array) {
            for tc in tcs {
                let raw_name = tc
                    .get("name")
                    .or_else(|| tc.get("tool_name"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim();
                if raw_name.is_empty() {
                    continue;
                }
                let args = tc
                    .get("args")
                    .or_else(|| tc.get("arguments"))
                    .or_else(|| tc.get("parameters"))
                    .or_else(|| tc.get("input"))
                    .cloned()
                    .unwrap_or(Value::Null);
                tool_calls.push(TranscriptToolCall {
                    name: raw_name.to_string(),
                    args,
                });
            }
        }
        steps.push(TranscriptStep {
            step_index,
            step_type,
            status,
            created_at_ms,
            error,
            content,
            tool_calls,
        });
    }
    steps.sort_by_key(|s| s.step_index);
    steps
}

pub fn slice_active_turn_steps<'a>(
    steps: &'a [TranscriptStep],
    baseline_step_index: Option<i64>,
    turn_started_at_ms: i64,
) -> &'a [TranscriptStep] {
    if steps.is_empty() {
        return &[];
    }
    let min_step = baseline_step_index.unwrap_or(-1);
    if let Some(pos) = steps.iter().rposition(|s| {
        s.step_type == "USER_INPUT"
            && s.step_index > min_step
            && s.created_at_ms
                .is_none_or(|ts| baseline_step_index.is_some() || ts >= turn_started_at_ms - 15_000)
    }) {
        return &steps[pos..];
    }
    if baseline_step_index.is_some() {
        if let Some(pos) = steps.iter().position(|s| s.step_index > min_step) {
            return &steps[pos..];
        }
        return &[];
    }
    if let Some(pos) = steps.iter().rposition(|s| s.step_type == "USER_INPUT") {
        return &steps[pos..];
    }
    steps
}

pub(crate) fn extract_background_task_id(content: &str) -> Option<String> {
    let idx = content.find(BACKGROUND_TASK_MARKER)?;
    let rest = &content[idx + BACKGROUND_TASK_MARKER.len()..];
    let token = rest
        .split_whitespace()
        .next()?
        .trim_matches(|ch: char| matches!(ch, '"' | '\'' | '.' | ',' | ')' | ']'));
    (!token.is_empty()).then(|| token.to_string())
}

pub(crate) fn extract_system_message_sender(content: &str) -> Option<String> {
    let idx = content.find("sender=")?;
    let rest = &content[idx + "sender=".len()..];
    let token = rest
        .split_whitespace()
        .next()?
        .trim_matches(|ch: char| matches!(ch, '"' | '\'' | '.' | ',' | ';'));
    (!token.is_empty()).then(|| token.to_string())
}

/// Strips the `<SYSTEM_MESSAGE>` / `[Message] ... content=` / `Task id "..." finished with result:`
/// wrapper from a background task completion message so only the clean command output remains.
pub fn clean_background_task_system_message_output(raw: &str) -> String {
    let mut slice = raw.trim();
    if let Some(close_idx) = slice.rfind("</SYSTEM_MESSAGE>") {
        let before_close = &slice[..close_idx];
        if let Some(open_idx) = before_close.rfind("<SYSTEM_MESSAGE>") {
            slice = &before_close[open_idx + "<SYSTEM_MESSAGE>".len()..];
        }
    } else if let Some(open_idx) = slice.rfind("<SYSTEM_MESSAGE>") {
        let after_open = &slice[open_idx + "<SYSTEM_MESSAGE>".len()..];
        if after_open.trim_start().starts_with("[Message]") {
            slice = after_open;
        }
    }
    slice = slice.trim();
    if slice.starts_with("[Message]") {
        let first_line_end = slice.find('\n').unwrap_or(slice.len());
        if let Some(content_pos) = slice[..first_line_end].find("content=") {
            slice = slice[content_pos + "content=".len()..].trim();
        }
    }
    if slice.starts_with("Task id ") {
        if let Some(res_pos) = slice.find("finished with result:") {
            slice = slice[res_pos + "finished with result:".len()..].trim_start_matches([' ', '\t', '\r', '\n']);
        }
    }
    slice.trim().to_string()
}

fn extract_invoked_subagent_cid(content: &str) -> Option<String> {
    if !content.contains("conversationId") && !content.contains("conversation_id") {
        return None;
    }
    let obj = parse_output_json(Some(content))?;
    if response_indicates_failure("", None, Some(&obj), Some(content)) {
        return None;
    }
    obj.get("conversationId")
        .or_else(|| obj.get("conversation_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn clean_error_text(step: &TranscriptStep) -> String {
    if let Some(ref err) = step.error {
        return err.clone();
    }
    step.content
        .trim()
        .strip_prefix("Error:")
        .unwrap_or(step.content.trim())
        .trim()
        .to_string()
}

fn is_immediate_terminal_error(msg: &str) -> bool {
    let lower = msg.to_ascii_lowercase();
    lower.contains("attempt 5")
        || lower.contains("individual quota reached")
        || lower.contains("resource_exhausted")
        || lower.contains("resource has been exhausted")
        || lower.contains("not authenticated")
        || lower.contains("authentication")
        || lower.contains("unauthorized")
}

/// Matches early provider retry errors (`API error (attempt 1)`..`attempt 4`) that are still
/// backing off/retrying unless they already indicate an immediate quota or auth failure.
pub(crate) fn is_in_flight_api_retry_error(msg: &str) -> bool {
    if is_immediate_terminal_error(msg) {
        return false;
    }
    let lower = msg.to_ascii_lowercase();
    (1..=4).any(|attempt| lower.contains(&format!("api error (attempt {attempt})")))
}

pub fn analyze_turn_verdict(
    turn_slice: &[TranscriptStep],
    last_stdout_step_index: Option<i64>,
    catchup_already_active: bool,
) -> TranscriptVerdict {
    if turn_slice.is_empty() {
        return TranscriptVerdict::NoCatchupNeeded;
    }
    let max_step = turn_slice.last().map(|s| s.step_index).unwrap_or(-1);
    let has_non_user_work = turn_slice.iter().any(|s| s.step_type != "USER_INPUT");
    let advanced_past_stdout = match last_stdout_step_index {
        Some(seen) => max_step > seen,
        None => has_non_user_work,
    };
    let has_bg_or_system_work = turn_slice.iter().any(|s| {
        s.step_type == "SYSTEM_MESSAGE"
            || s.step_type == "ERROR_MESSAGE"
            || (s.step_type == "GENERIC" && extract_background_task_id(&s.content).is_some())
    });
    if !catchup_already_active && !advanced_past_stdout && !has_bg_or_system_work {
        return TranscriptVerdict::NoCatchupNeeded;
    }

    let last_error_step = turn_slice
        .iter()
        .rev()
        .find(|s| s.step_type == "ERROR_MESSAGE")
        .map(|s| s.step_index)
        .unwrap_or(-1);

    let mut open_bg_tasks: HashSet<String> = HashSet::new();
    let mut open_subagents: HashSet<String> = HashSet::new();
    let mut invoke_steps: HashSet<i64> = HashSet::new();
    let mut expected_tool_steps: HashSet<i64> = HashSet::new();
    let mut finished_tool_steps: HashSet<i64> = HashSet::new();
    let mut active_running_generic = false;

    for step in turn_slice {
        match step.step_type.as_str() {
            "PLANNER_RESPONSE" => {
                if !step.tool_calls.is_empty() {
                    let after_last_error = step.step_index > last_error_step;
                    for (idx, tc) in step.tool_calls.iter().enumerate() {
                        let expected_step = step.step_index + 1 + idx as i64;
                        let (_, clean) = strip_mcp_prefix(&tc.name, &Value::Null);
                        if clean == "invoke_subagent" {
                            invoke_steps.insert(expected_step);
                        }
                        if after_last_error {
                            expected_tool_steps.insert(expected_step);
                        }
                    }
                }
            }
            "GENERIC" => {
                if let Some(task_id) = extract_background_task_id(&step.content) {
                    // Ownership transfers to `open_bg_tasks` until a matching `SYSTEM_MESSAGE` arrives.
                    open_bg_tasks.insert(task_id);
                    finished_tool_steps.insert(step.step_index);
                } else if step.status != "RUNNING" {
                    finished_tool_steps.insert(step.step_index);
                } else if step.step_index > last_error_step {
                    active_running_generic = true;
                }
                if invoke_steps.contains(&step.step_index) {
                    if let Some(cid) = extract_invoked_subagent_cid(&step.content) {
                        open_subagents.insert(cid);
                    }
                }
            }
            "SYSTEM_MESSAGE" => {
                if let Some(sender) = extract_system_message_sender(&step.content) {
                    open_bg_tasks.remove(&sender);
                    open_subagents.remove(&sender);
                }
            }
            _ => {}
        }
    }

    let unresolved_sync_tools = expected_tool_steps
        .iter()
        .any(|s| !finished_tool_steps.contains(s));
    let has_open_work = unresolved_sync_tools
        || active_running_generic
        || !open_bg_tasks.is_empty()
        || !open_subagents.is_empty();

    let Some(last) = turn_slice.last() else {
        return TranscriptVerdict::NoCatchupNeeded;
    };

    if last.step_type == "PLANNER_RESPONSE"
        && last.status == "DONE"
        && last.tool_calls.is_empty()
        && !last.content.trim().is_empty()
        && !has_open_work
    {
        return TranscriptVerdict::Completed {
            step_index: last.step_index,
        };
    }

    if last.step_type == "ERROR_MESSAGE" && !has_open_work {
        let msg = clean_error_text(last);
        let immediate = is_immediate_terminal_error(&msg);
        return TranscriptVerdict::TerminalError {
            step_index: last.step_index,
            message: msg,
            immediate,
        };
    }

    TranscriptVerdict::ActiveProgress
}

fn normalize_fallback_command(raw: &str) -> String {
    raw.replace("kite ctx exec --", " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn collect_turn_acp_tools(
    thread_id: &str,
    turn_started_at_ms: i64,
) -> Vec<(String, Option<String>, Option<String>)> {
    let Ok(items) = threads().lock() else {
        return Vec::new();
    };
    let Some(thread) = items
        .iter()
        .find(|t| t.get("id").and_then(Value::as_str) == Some(thread_id))
    else {
        return Vec::new();
    };
    let Some(thread_items) = thread.get("items").and_then(Value::as_array) else {
        return Vec::new();
    };
    thread_items
        .iter()
        .filter_map(|it| {
            let id = it.get("id").and_then(Value::as_str)?;
            if !id.starts_with("call_") {
                return None;
            }
            let created_ms = it
                .get("createdAtUnixMs")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            if created_ms + 5_000 < turn_started_at_ms {
                return None;
            }
            let tool_name = it
                .get("toolName")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| crate::acp::strip_mcp_prefix(s, it).1)
                .or_else(|| {
                    it.get("title")
                        .and_then(Value::as_str)
                        .and_then(crate::chat::normalize::normalize_acp_tool_name)
                        .map(|s| crate::acp::strip_mcp_prefix(&s, it).1)
                })
                .unwrap_or_default()
                .trim()
                .to_string();
            let file_path = it
                .get("filePath")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            let cmd = it
                .get("command")
                .and_then(Value::as_str)
                .map(normalize_fallback_command)
                .filter(|s| !s.is_empty());
            Some((tool_name, file_path, cmd))
        })
        .collect()
}

fn has_live_acp_tool_match(
    live_acp_tools: &[(String, Option<String>, Option<String>)],
    tc: &TranscriptToolCall,
) -> bool {
    if live_acp_tools.is_empty() {
        return false;
    }
    let (_kind, _srv, _title, cmd, path, _, _) =
        crate::acp::classify_tool_metadata(&tc.name, &tc.args);
    let norm_cmd = cmd
        .as_deref()
        .map(normalize_fallback_command)
        .filter(|s| !s.is_empty());
    let norm_path = path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let tc_clean = crate::acp::strip_mcp_prefix(&tc.name, &tc.args).1;
    live_acp_tools.iter().any(|(item_name, item_path, item_cmd)| {
        if let (Some(c), Some(ic)) = (norm_cmd.as_ref(), item_cmd.as_ref()) {
            return ic == c;
        }
        if let (Some(p), Some(ip)) = (norm_path, item_path.as_deref()) {
            return ip.eq_ignore_ascii_case(p);
        }
        !tc_clean.is_empty()
            && !item_name.is_empty()
            && item_name.eq_ignore_ascii_case(&tc_clean)
            && norm_cmd.is_none()
            && norm_path.is_none()
    })
}

fn record_tool_step(
    thread_id: &str,
    run_id: &str,
    tool_id: String,
    tc: TranscriptToolCall,
    status: &str,
    output: Option<String>,
) {
    let acp_tool = build_acp_tool_call(
        tool_id,
        &tc.name,
        tc.args,
        status.to_string(),
        output,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    );
    record_acp_tool_update(thread_id, run_id, acp_tool);
}

fn generic_step_status(step: &TranscriptStep, is_background_task: bool) -> (&'static str, bool) {
    if is_background_task {
        return ("running", false);
    }
    match step.status.as_str() {
        "ERROR" | "FAILED" => ("failed", true),
        "RUNNING" => ("running", false),
        _ if step.content.contains("Encountered error in step execution:") => ("failed", true),
        _ => ("completed", true),
    }
}

fn collapse_newlines(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut prev_nl = false;
    for ch in text.chars() {
        if ch == '\r' {
            continue;
        }
        if ch == '\n' {
            if !prev_nl {
                out.push('\n');
                prev_nl = true;
            }
        } else {
            prev_nl = false;
            out.push(ch);
        }
    }
    out
}

fn text_already_streamed(run_id: &str, text: &str) -> bool {
    let cleaned_needle = sanitize_chat_text(text);
    let needle = cleaned_needle.trim();
    if needle.is_empty() {
        return true;
    }
    let Ok(live) = live_turns().lock() else {
        return false;
    };
    let Some(run) = live.runs.get(run_id) else {
        return false;
    };
    let cleaned_existing = sanitize_chat_text(&run.assistant_text);
    let existing = cleaned_existing.trim();
    if existing.is_empty() {
        return false;
    }
    if existing == needle || existing.ends_with(needle) {
        return true;
    }
    if needle.len() >= 16 {
        if existing.contains(needle) {
            return true;
        }
        let collapsed_existing = collapse_newlines(existing);
        let collapsed_needle = collapse_newlines(needle);
        if !collapsed_needle.is_empty() && collapsed_existing.contains(&collapsed_needle) {
            return true;
        }
    }
    false
}

fn settle_pre_error_running_tools(
    thread_id: &str,
    run_id: &str,
    err_step: i64,
    active_bg_steps: &HashSet<i64>,
) -> bool {
    let prefix = format!("t_{run_id}_");
    let mut updated_items = Vec::new();
    {
        let Ok(mut all_threads) = threads().lock() else {
            return false;
        };
        let Some(thread) = all_threads
            .iter_mut()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(thread_id))
        else {
            return false;
        };
        let Some(items) = thread.get_mut("items").and_then(Value::as_array_mut) else {
            return false;
        };
        for it in items.iter_mut() {
            let Some(id) = it.get("id").and_then(Value::as_str) else {
                continue;
            };
            let Some(rest) = id.strip_prefix(&prefix) else {
                continue;
            };
            let Ok(step_num) = rest.parse::<i64>() else {
                continue;
            };
            if step_num >= err_step || active_bg_steps.contains(&step_num) {
                continue;
            }
            let is_subagent = it.get("toolKind").and_then(Value::as_str) == Some("subagent")
                || it.get("subagentMeta").is_some()
                || it
                    .get("toolName")
                    .and_then(Value::as_str)
                    .is_some_and(|n| strip_mcp_prefix(n, &Value::Null).1 == "invoke_subagent");
            if is_subagent {
                continue;
            }
            let is_running = it.get("streaming").and_then(Value::as_bool) == Some(true)
                || matches!(
                    it.get("status").and_then(Value::as_str),
                    Some("running" | "inProgress" | "in_progress" | "pending" | "started")
                );
            if !is_running {
                continue;
            }
            it["status"] = json!("failed");
            it["streaming"] = json!(false);
            if it
                .get("text")
                .and_then(Value::as_str)
                .is_none_or(|t| t.trim().is_empty())
            {
                it["text"] = json!(INTERRUPTED_TOOL_TEXT);
            }
            updated_items.push(it.clone());
        }
        if !updated_items.is_empty() {
            touch(thread);
        }
    }
    if updated_items.is_empty() {
        return false;
    }
    {
        if let Ok(mut live) = live_turns().lock() {
            if let Some(run) = live.runs.get_mut(run_id) {
                for item in &updated_items {
                    append_event(run, json!({ "kind": "upsert", "item": item }), true);
                }
            }
        }
    }
    live_cv().notify_all();
    persist_async();
    true
}

pub fn poll_transcript_catchup_for_session(
    thread_id: &str,
    run_id: &str,
    assistant_id: &str,
    session_id: &str,
    turn_started_at_ms: i64,
    last_stdout_step_index: Option<i64>,
    state: &mut TranscriptCatchupState,
    force_read: bool,
) -> CatchupPollResult {
    let Some(dir) = antigravity_brain_logs_dir(session_id) else {
        return CatchupPollResult {
            projected_updates: false,
            verdict: TranscriptVerdict::NoCatchupNeeded,
        };
    };
    poll_transcript_catchup_in_dir(
        thread_id,
        run_id,
        assistant_id,
        Some(session_id),
        &dir,
        turn_started_at_ms,
        last_stdout_step_index,
        state,
        force_read,
    )
}

/// Matches transient stream interruption or early API-retry errors (excluding immediate quota/auth/network failures).
pub(crate) fn is_transient_stream_interruption(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    (lower.contains("the stream was interrupted")
        || lower.contains("stream was interrupted")
        || is_in_flight_api_retry_error(&lower))
        && !is_immediate_terminal_error(&lower)
}

/// True when `text` is an Antigravity `"result"` error notice emitted alongside a spurious interruption.
pub(crate) fn is_spurious_antigravity_result_notice(text: &str) -> bool {
    let trimmed = text.trim();
    trimmed == "antigravity ended the turn with status ERROR"
        || trimmed.starts_with("antigravity error:")
}

/// Resolves the brain log directory for an Antigravity conversation ID.
pub(crate) fn brain_logs_dir_for_session(session_id: &str) -> Option<PathBuf> {
    antigravity_brain_logs_dir(session_id)
}

/// Returns `Some(step_index)` when the active turn slice in `logs_dir` already ended cleanly in `Completed`.
pub(crate) fn verify_completed_turn_on_disk_in_dir(
    logs_dir: &Path,
    baseline_step_index: Option<i64>,
    turn_started_at_ms: i64,
    last_stdout_step_index: Option<i64>,
) -> Option<i64> {
    let transcript_path = resolve_transcript_file(logs_dir)?;
    let raw = fs::read_to_string(&transcript_path).ok()?;
    let steps = parse_transcript_steps(&raw);
    let turn_slice = slice_active_turn_steps(&steps, baseline_step_index, turn_started_at_ms);
    match analyze_turn_verdict(turn_slice, last_stdout_step_index, true) {
        TranscriptVerdict::Completed { step_index } => Some(step_index),
        _ => None,
    }
}

pub fn poll_transcript_catchup_in_dir(
    thread_id: &str,
    run_id: &str,
    assistant_id: &str,
    session_id: Option<&str>,
    logs_dir: &Path,
    turn_started_at_ms: i64,
    last_stdout_step_index: Option<i64>,
    state: &mut TranscriptCatchupState,
    force_read: bool,
) -> CatchupPollResult {
    let Some(path) = resolve_transcript_file(logs_dir) else {
        return CatchupPollResult {
            projected_updates: false,
            verdict: TranscriptVerdict::NoCatchupNeeded,
        };
    };
    let Ok(meta) = fs::metadata(&path) else {
        return CatchupPollResult {
            projected_updates: false,
            verdict: TranscriptVerdict::NoCatchupNeeded,
        };
    };
    let len = meta.len();
    let modified = meta.modified().ok();
    if !force_read
        && state.catchup_activated
        && len == state.last_file_len
        && modified == state.last_modified
    {
        let cached_verdict = state
            .last_verdict
            .clone()
            .unwrap_or(TranscriptVerdict::ActiveProgress);
        return CatchupPollResult {
            projected_updates: false,
            verdict: cached_verdict,
        };
    }

    let Ok(raw) = fs::read_to_string(&path) else {
        return CatchupPollResult {
            projected_updates: false,
            verdict: TranscriptVerdict::NoCatchupNeeded,
        };
    };
    state.last_file_len = len;
    state.last_modified = modified;

    let all_steps = parse_transcript_steps(&raw);
    let turn_slice = slice_active_turn_steps(&all_steps, state.baseline_step_index, turn_started_at_ms);
    let verdict = analyze_turn_verdict(turn_slice, last_stdout_step_index, state.catchup_activated);
    if matches!(verdict, TranscriptVerdict::NoCatchupNeeded) {
        return CatchupPollResult {
            projected_updates: false,
            verdict,
        };
    }

    state.catchup_activated = true;
    state.record_verdict_stability(&verdict, Instant::now());
    let floor_step = last_stdout_step_index.unwrap_or(-1);
    let seed_step = state
        .projected_step_cursor
        .map_or(floor_step, |prev| prev.max(floor_step));
    state.projected_step_cursor = Some(seed_step);
    let generic_steps_by_index: HashMap<i64, &TranscriptStep> = turn_slice
        .iter()
        .filter(|s| s.step_type == "GENERIC")
        .map(|s| (s.step_index, s))
        .collect();
    let non_generic_step_indices: HashSet<i64> = turn_slice
        .iter()
        .filter(|s| s.step_type != "GENERIC")
        .map(|s| s.step_index)
        .collect();
    let latest_error_step = turn_slice
        .iter()
        .filter(|s| s.step_type == "ERROR_MESSAGE")
        .map(|s| s.step_index)
        .max();

    let mut projected = false;
    let mut saw_system_or_subagent = false;
    let live_acp_tools = collect_turn_acp_tools(thread_id, turn_started_at_ms);

    for step in turn_slice {
        if step.step_type == "PLANNER_RESPONSE" && !step.tool_calls.is_empty() {
            for (idx, tc) in step.tool_calls.iter().enumerate() {
                if has_live_acp_tool_match(&live_acp_tools, tc) {
                    continue;
                }
                let expected_step = step.step_index + 1 + idx as i64;
                let tool_id = format!("t_{run_id}_{expected_step}");
                state
                    .pending_tool_map
                    .entry(expected_step)
                    .or_insert_with(|| (tool_id, tc.clone()));
            }
        }
    }
    state
        .pending_tool_map
        .retain(|_, (_, tc)| !has_live_acp_tool_match(&live_acp_tools, tc));

    for step in turn_slice {
        if step.step_type == "GENERIC" && !state.completed_generic_steps.contains(&step.step_index) {
            if let Some(task_id) = extract_background_task_id(&step.content) {
                if !state.settled_task_ids.contains(&task_id) {
                    if let Some((tool_id, tc)) = state.pending_tool_map.get(&step.step_index).cloned() {
                        state
                            .pending_bg_task_tools
                            .insert(task_id, (step.step_index, tool_id, tc));
                    }
                }
            }
        }
        if step.step_type == "SYSTEM_MESSAGE" {
            if let Some(sender) = extract_system_message_sender(&step.content) {
                if !state.settled_task_ids.contains(&sender) {
                    if let Some((gen_step_idx, tool_id, tc)) = state.pending_bg_task_tools.remove(&sender) {
                        let cleaned_out = clean_background_task_system_message_output(&step.content);
                        record_tool_step(
                            thread_id,
                            run_id,
                            tool_id,
                            tc,
                            "completed",
                            (!cleaned_out.is_empty()).then_some(cleaned_out),
                        );
                        state.completed_generic_steps.insert(gen_step_idx);
                        projected = true;
                    }
                    state.settled_task_ids.insert(sender);
                }
            }
        }
    }

    let active_bg_steps: HashSet<i64> = state
        .pending_bg_task_tools
        .values()
        .map(|(step_idx, _, _)| *step_idx)
        .collect();

    for step in turn_slice {
        if step.step_type == "ERROR_MESSAGE" && !state.settled_error_steps.contains(&step.step_index) {
            if settle_pre_error_running_tools(thread_id, run_id, step.step_index, &active_bg_steps) {
                projected = true;
            }
            if step.step_index > seed_step {
                let err = clean_error_text(step);
                if !err.is_empty() {
                    emit_notice_item(
                        thread_id,
                        run_id,
                        &format!("antigravity stream interrupted; continuing turn recovery: {err}"),
                    );
                    projected = true;
                }
            }
            state.settled_error_steps.insert(step.step_index);
        }
    }

    for step in turn_slice {
        match step.step_type.as_str() {
            "PLANNER_RESPONSE" => {
                if !step.tool_calls.is_empty() {
                    for idx in 0..step.tool_calls.len() {
                        let expected_step = step.step_index + 1 + idx as i64;
                        if expected_step <= seed_step
                            || state.completed_generic_steps.contains(&expected_step)
                        {
                            continue;
                        }
                        let Some((tool_id, tc)) = state.pending_tool_map.get(&expected_step).cloned() else {
                            continue;
                        };
                        let (tool_kind, ..) = crate::acp::classify_tool_metadata(&tc.name, &tc.args);
                        let is_subagent_call = tool_kind == "subagent"
                            || crate::chat::subagents::is_invoke_subagent_tool_name(&tc.name);
                        let interrupted_tool = !is_subagent_call
                            && !active_bg_steps.contains(&expected_step)
                            && (latest_error_step.is_some_and(|e| expected_step < e)
                                || (!generic_steps_by_index.contains_key(&expected_step)
                                    && non_generic_step_indices.contains(&expected_step)));
                        if let Some(gen_step) = generic_steps_by_index.get(&expected_step) {
                            let is_bg = extract_background_task_id(&gen_step.content).is_some();
                            let (status, is_done) = if interrupted_tool && gen_step.status == "RUNNING" {
                                ("failed", true)
                            } else {
                                generic_step_status(gen_step, is_bg)
                            };
                            if !is_done && !state.emitted_running_tool_steps.insert(expected_step) {
                                continue;
                            }
                            let out = if status == "failed" && gen_step.content.trim().is_empty() {
                                Some(INTERRUPTED_TOOL_TEXT.to_string())
                            } else {
                                (!gen_step.content.trim().is_empty()).then(|| gen_step.content.clone())
                            };
                            record_tool_step(thread_id, run_id, tool_id, tc, status, out);
                            if is_done {
                                state.completed_generic_steps.insert(expected_step);
                            }
                            projected = true;
                        } else if interrupted_tool {
                            record_tool_step(
                                thread_id,
                                run_id,
                                tool_id,
                                tc,
                                "failed",
                                Some(INTERRUPTED_TOOL_TEXT.to_string()),
                            );
                            state.completed_generic_steps.insert(expected_step);
                            projected = true;
                        } else if state.emitted_running_tool_steps.insert(expected_step) {
                            record_tool_step(thread_id, run_id, tool_id, tc, "running", None);
                            projected = true;
                        }
                    }
                }
                let max_seen_step = seed_step.max(state.max_projected_step_index.unwrap_or(-1));
                if step.step_index > max_seen_step
                    && state.projected_planner_steps.insert(step.step_index)
                {
                    let cleaned_content = sanitize_chat_text(&step.content);
                    if !cleaned_content.trim().is_empty()
                        && !text_already_streamed(run_id, &cleaned_content)
                    {
                        if emit_fallback_step_deltas(
                            thread_id,
                            run_id,
                            assistant_id,
                            step.step_index,
                            &cleaned_content,
                        ) {
                            projected = true;
                        }
                    }
                    state.max_projected_step_index = Some(
                        state
                            .max_projected_step_index
                            .map_or(step.step_index, |prev| prev.max(step.step_index)),
                    );
                }
            }
            "GENERIC" => {
                if step.step_index > seed_step {
                    if step.content.contains("conversationId") && state.projected_misc_steps.insert(step.step_index) {
                        saw_system_or_subagent = true;
                    }
                    if !state.completed_generic_steps.contains(&step.step_index) {
                        let is_bg = extract_background_task_id(&step.content).is_some();
                        let (status, is_done) = generic_step_status(step, is_bg);
                        if is_done || state.emitted_running_tool_steps.insert(step.step_index) {
                            if let Some((tool_id, tc)) = state.pending_tool_map.get(&step.step_index).cloned() {
                                let out = (!step.content.trim().is_empty()).then(|| step.content.clone());
                                record_tool_step(thread_id, run_id, tool_id, tc, status, out);
                                projected = true;
                            }
                        }
                        if is_done {
                            state.completed_generic_steps.insert(step.step_index);
                        }
                    }
                }
            }
            "SYSTEM_MESSAGE" => {
                if state.projected_misc_steps.insert(step.step_index) {
                    saw_system_or_subagent = true;
                }
            }
            _ => {}
        }
    }

    if projected || saw_system_or_subagent {
        if let Some(cid) = session_id {
            reconcile_antigravity_subagents_for_thread_with_session(
                thread_id,
                Some(run_id),
                Some(cid),
            );
        }
    }

    CatchupPollResult {
        projected_updates: projected,
        verdict,
    }
}

pub fn reconcile_subagents_with_session(thread_id: &str, run_id: &str, session_id: &str) {
    reconcile_antigravity_subagents_for_thread_with_session(
        thread_id,
        Some(run_id),
        Some(session_id),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::runtime::state::{live_turns, TurnRun};
    use crate::chat::utils::now_ms;

    struct CleanupGuard {
        tid: String,
        rid: String,
        dir: PathBuf,
    }

    impl Drop for CleanupGuard {
        fn drop(&mut self) {
            if let Ok(mut live) = live_turns().lock() {
                live.runs.remove(&self.rid);
                live.by_thread.remove(&self.tid);
            }
            if let Ok(mut items) = threads().lock() {
                items.retain(|t| t.get("id").and_then(Value::as_str) != Some(self.tid.as_str()));
            }
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    fn seed_thread_and_run(tid: &str, rid: &str, asst_id: &str, initial_tool_step: i64) {
        {
            let mut items = threads().lock().unwrap();
            items.push(json!({
                "id": tid,
                "status": "running",
                "title": "Fallback Test",
                "provider": "antigravity",
                "items": [
                    { "id": "u1", "kind": "user", "text": "fix it" },
                    {
                        "id": format!("t_{rid}_{initial_tool_step}"),
                        "kind": "tool",
                        "toolKind": "fileChange",
                        "toolName": "edit_file",
                        "title": "Edit toast.ts",
                        "status": "running",
                        "streaming": true,
                        "text": ""
                    }
                ]
            }));
        }
        let mut live = live_turns().lock().unwrap();
        live.runs.insert(
            rid.to_string(),
            TurnRun {
                revision: "rev-fb".into(),
                events: Vec::new(),
                next_sequence: 0,
                assistant_id: asst_id.to_string(),
                assistant_text: String::new(),
                child: None,
                stdin: None,
                closing: false,
                finished: false,
                started_at_ms: now_ms(),
                finished_at_ms: None,
                routine_id: None,
                delivered_through: 0,
                file_baselines: HashMap::new(),
            },
        );
        live.by_thread.insert(tid.to_string(), rid.to_string());
    }

    #[test]
    fn stalled_edit_transcript_settles_pre_error_tool_waits_for_async_tasks_then_completes() {
        let uid = uuid::Uuid::new_v4().simple().to_string();
        let tid = format!("fb-thread-{uid}");
        let rid = format!("fb-run-{uid}");
        let asst_id = format!("fb-asst-{uid}");
        let dir = std::env::temp_dir().join(format!("kite-agy-fb-test-{uid}"));
        fs::create_dir_all(&dir).unwrap();
        let _guard = CleanupGuard {
            tid: tid.clone(),
            rid: rid.clone(),
            dir: dir.clone(),
        };
        seed_thread_and_run(&tid, &rid, &asst_id, 282);

        let tpath = dir.join("transcript_full.jsonl");
        let turn_start_ms = now_ms() - 5_000;
        let phase1 = [
            json!({ "step_index": 0, "type": "USER_INPUT", "status": "DONE", "created_at": "2026-11-17T21:44:13Z", "content": "fix it" }),
            json!({ "step_index": 281, "type": "PLANNER_RESPONSE", "status": "DONE", "tool_calls": [{ "name": "edit_file", "args": { "Path": "src/lib/toast.ts" } }, { "name": "edit_file", "args": { "Path": "src/lib/toast.css" } }], "content": "" }),
            json!({ "step_index": 284, "type": "ERROR_MESSAGE", "status": "DONE", "error": "The stream was interrupted. Please continue the task you were working on.", "content": "Error: The stream was interrupted. Please continue the task you were working on." }),
            json!({ "step_index": 285, "type": "PLANNER_RESPONSE", "status": "DONE", "tool_calls": [{ "name": "edit_file", "args": { "Path": "src/lib/toast.ts", "Target": "a", "Replacement": "b" } }, { "name": "invoke_subagent", "args": { "Role": "Verifier" } }], "content": "" }),
            json!({ "step_index": 286, "type": "GENERIC", "status": "DONE", "content": "Made 1 replacement in toast.ts" }),
            json!({ "step_index": 287, "type": "GENERIC", "status": "DONE", "content": "{\"conversationId\":\"sub-verify-1\"}" }),
            json!({ "step_index": 288, "type": "PLANNER_RESPONSE", "status": "DONE", "tool_calls": [], "content": "Esperando al verificador." }),
        ];
        fs::write(
            &tpath,
            phase1.iter().map(|v| v.to_string()).collect::<Vec<_>>().join("\n") + "\n",
        )
        .unwrap();

        let mut state = TranscriptCatchupState::default();
        let r1 = poll_transcript_catchup_in_dir(
            &tid,
            &rid,
            &asst_id,
            None,
            &dir,
            turn_start_ms,
            Some(282),
            &mut state,
            true,
        );
        assert!(r1.projected_updates, "expected catch-up updates after stall");
        assert_eq!(
            r1.verdict,
            TranscriptVerdict::ActiveProgress,
            "open invoke_subagent must keep turn active instead of prematurely settling on narration"
        );

        let items = threads()
            .lock()
            .unwrap()
            .iter()
            .find(|t| t["id"] == tid)
            .and_then(|t| t["items"].as_array().cloned())
            .unwrap();
        let interrupted_item = items
            .iter()
            .find(|it| it["id"] == format!("t_{rid}_282"))
            .expect("initial edit item");
        assert_eq!(interrupted_item["status"], json!("failed"));
        assert_eq!(interrupted_item["streaming"], json!(false));
        let interrupted_second_item = items
            .iter()
            .find(|it| it["id"] == format!("t_{rid}_283"))
            .expect("interrupted unstarted batch sibling item");
        assert_eq!(interrupted_second_item["status"], json!("failed"));
        assert_eq!(interrupted_second_item["streaming"], json!(false));
        assert_eq!(interrupted_second_item["text"], json!(INTERRUPTED_TOOL_TEXT));
        let post_edit_item = items
            .iter()
            .find(|it| it["id"] == format!("t_{rid}_286"))
            .expect("recovered edit item");
        assert_eq!(post_edit_item["status"], json!("completed"));

        let mut phase2 = phase1.to_vec();
        phase2.extend([
            json!({ "step_index": 289, "type": "SYSTEM_MESSAGE", "status": "DONE", "content": "[Message] sender=sub-verify-1 content=PASS" }),
            json!({ "step_index": 290, "type": "PLANNER_RESPONSE", "status": "DONE", "tool_calls": [{ "name": "run_command", "args": { "CommandLine": "npx vitest run" } }], "content": "" }),
            json!({ "step_index": 291, "type": "GENERIC", "status": "RUNNING", "content": "Tool is running as a background task with task id: conv-1/task-291" }),
            json!({ "step_index": 292, "type": "PLANNER_RESPONSE", "status": "DONE", "tool_calls": [], "content": "Corriendo suite completa." }),
        ]);
        fs::write(
            &tpath,
            phase2.iter().map(|v| v.to_string()).collect::<Vec<_>>().join("\n") + "\n",
        )
        .unwrap();

        let r2 = poll_transcript_catchup_in_dir(
            &tid,
            &rid,
            &asst_id,
            None,
            &dir,
            turn_start_ms,
            Some(282),
            &mut state,
            true,
        );
        assert!(r2.projected_updates);
        assert_eq!(
            r2.verdict,
            TranscriptVerdict::ActiveProgress,
            "open background task-291 must keep turn active"
        );

        let mut phase3 = phase2.clone();
        phase3.extend([
            json!({ "step_index": 293, "type": "SYSTEM_MESSAGE", "status": "DONE", "content": "[Message] sender=conv-1/task-291 content=1387 passed" }),
            json!({ "step_index": 294, "type": "PLANNER_RESPONSE", "status": "DONE", "tool_calls": [], "content": "Listo: todo corregido." }),
        ]);
        fs::write(
            &tpath,
            phase3.iter().map(|v| v.to_string()).collect::<Vec<_>>().join("\n") + "\n",
        )
        .unwrap();

        let r3 = poll_transcript_catchup_in_dir(
            &tid,
            &rid,
            &asst_id,
            None,
            &dir,
            turn_start_ms,
            Some(282),
            &mut state,
            true,
        );
        assert!(r3.projected_updates);
        assert_eq!(r3.verdict, TranscriptVerdict::Completed { step_index: 294 });

        let final_items = threads()
            .lock()
            .unwrap()
            .iter()
            .find(|t| t["id"] == tid)
            .and_then(|t| t["items"].as_array().cloned())
            .unwrap();
        let bg_cmd_item = final_items
            .iter()
            .find(|it| it["id"] == format!("t_{rid}_291"))
            .expect("background run_command item");
        assert_eq!(
            bg_cmd_item["status"],
            json!("completed"),
            "background command item must finish cleanly once its SYSTEM_MESSAGE arrives"
        );
        let asst_text = final_items
            .into_iter()
            .filter(|it| it["kind"] == "assistant")
            .filter_map(|it| it["text"].as_str().map(str::to_string))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            asst_text.contains("Listo: todo corregido."),
            "assistant response must include final recovered text, got: {asst_text}"
        );
    }

    #[test]
    fn unrecovered_error_verdict_classifies_immediate_vs_transient_errors() {
        let immediate_steps = parse_transcript_steps(
            &[
                json!({ "step_index": 0, "type": "USER_INPUT", "status": "DONE", "content": "go" }).to_string(),
                json!({ "step_index": 1, "type": "ERROR_MESSAGE", "status": "DONE", "error": "API error (attempt 5): dial tcp: lookup host", "content": "Error: API error (attempt 5): dial tcp: lookup host" }).to_string(),
            ]
            .join("\n"),
        );
        assert_eq!(
            analyze_turn_verdict(&immediate_steps, None, false),
            TranscriptVerdict::TerminalError {
                step_index: 1,
                message: "API error (attempt 5): dial tcp: lookup host".to_string(),
                immediate: true,
            }
        );

        let auth_steps = parse_transcript_steps(
            &[
                json!({ "step_index": 0, "type": "USER_INPUT", "status": "DONE", "content": "go" }).to_string(),
                json!({ "step_index": 1, "type": "ERROR_MESSAGE", "status": "DONE", "error": "authentication failed: expired token", "content": "Error: authentication failed: expired token" }).to_string(),
            ]
            .join("\n"),
        );
        assert_eq!(
            analyze_turn_verdict(&auth_steps, None, false),
            TranscriptVerdict::TerminalError {
                step_index: 1,
                message: "authentication failed: expired token".to_string(),
                immediate: true,
            }
        );

        let retry_steps = parse_transcript_steps(
            &[
                json!({ "step_index": 0, "type": "USER_INPUT", "status": "DONE", "content": "go" }).to_string(),
                json!({ "step_index": 1, "type": "ERROR_MESSAGE", "status": "DONE", "error": "The stream was interrupted.", "content": "Error: The stream was interrupted." }).to_string(),
            ]
            .join("\n"),
        );
        assert_eq!(
            analyze_turn_verdict(&retry_steps, None, false),
            TranscriptVerdict::TerminalError {
                step_index: 1,
                message: "The stream was interrupted.".to_string(),
                immediate: false,
            }
        );
    }

    #[test]
    fn turn_slicer_ignores_previous_turn_steps_using_baseline() {
        let steps = parse_transcript_steps(
            &[
                json!({ "step_index": 0, "type": "USER_INPUT", "status": "DONE", "created_at": "2026-11-17T10:00:00Z", "content": "turn 1" }).to_string(),
                json!({ "step_index": 1, "type": "PLANNER_RESPONSE", "status": "DONE", "created_at": "2026-11-17T10:01:00Z", "tool_calls": [], "content": "done 1" }).to_string(),
                json!({ "step_index": 2, "type": "USER_INPUT", "status": "DONE", "created_at": "2026-11-17T11:00:00Z", "content": "turn 2" }).to_string(),
                json!({ "step_index": 3, "type": "PLANNER_RESPONSE", "status": "DONE", "created_at": "2026-11-17T11:00:05Z", "tool_calls": [], "content": "done 2" }).to_string(),
            ]
            .join("\n"),
        );
        let turn2_start_ms = crate::quota::utils::chrono_parse_rfc3339("2026-11-17T11:00:00Z").unwrap();
        let sliced = slice_active_turn_steps(&steps, Some(1), turn2_start_ms);
        assert_eq!(sliced.first().map(|s| s.step_index), Some(2));
        assert_eq!(sliced.last().map(|s| s.step_index), Some(3));
    }

    #[test]
    fn extracts_step_index_from_antigravity_step_update_frame() {
        let line = r#"{"event":"step_update","step_update":{"step_index":282,"step_type":"tool"}}"#;
        assert_eq!(extract_step_index_from_stream_line(line), Some(282));
        assert_eq!(extract_step_index_from_stream_line(r#"{"event":"init"}"#), None);
    }

    #[test]
    fn ready_to_settle_enforces_grace_windows_before_settling() {
        let mut state = TranscriptCatchupState::default();
        let t0 = Instant::now();

        let completed = TranscriptVerdict::Completed { step_index: 12 };
        state.record_verdict_stability(&completed, t0);
        assert_eq!(
            state.ready_to_settle(&completed, t0 + Duration::from_secs(2), Duration::from_secs(15)),
            None
        );
        assert_eq!(
            state.ready_to_settle(&completed, t0 + Duration::from_secs(5), Duration::from_secs(15)),
            Some((true, String::new()))
        );

        let transient_err = TranscriptVerdict::TerminalError {
            step_index: 13,
            message: "The stream was interrupted.".to_string(),
            immediate: false,
        };
        state.record_verdict_stability(&transient_err, t0);
        assert_eq!(
            state.ready_to_settle(&transient_err, t0 + Duration::from_secs(10), Duration::from_secs(20)),
            None
        );
        assert_eq!(
            state.ready_to_settle(&transient_err, t0 + Duration::from_secs(30), Duration::from_secs(30)),
            Some((false, "The stream was interrupted.".to_string()))
        );

        let immediate_err = TranscriptVerdict::TerminalError {
            step_index: 14,
            message: "API error (attempt 5)".to_string(),
            immediate: true,
        };
        state.record_verdict_stability(&immediate_err, t0);
        assert_eq!(
            state.ready_to_settle(&immediate_err, t0 + Duration::from_secs(8), Duration::from_secs(12)),
            Some((false, "API error (attempt 5)".to_string()))
        );
    }

    #[test]
    fn non_generic_step_collision_does_not_mark_interrupted_tool_completed() {
        let tid = format!("th-fb-col-{}", now_ms());
        let rid = format!("run-fb-col-{}", now_ms());
        let asst_id = format!("asst-col-{}", now_ms());
        let dir = std::env::temp_dir().join(format!("kite_fb_col_{}", now_ms()));
        fs::create_dir_all(&dir).unwrap();
        let _guard = CleanupGuard {
            tid: tid.clone(),
            rid: rid.clone(),
            dir: dir.clone(),
        };
        seed_thread_and_run(&tid, &rid, &asst_id, 11);

        let tpath = dir.join("transcript_full.jsonl");
        let rows = [
            json!({ "step_index": 0, "type": "USER_INPUT", "status": "DONE", "created_at": "2026-11-17T21:44:13Z", "content": "fix it" }),
            json!({ "step_index": 10, "type": "PLANNER_RESPONSE", "status": "DONE", "tool_calls": [{ "name": "edit_file", "args": { "Path": "a.ts" } }, { "name": "grep", "args": { "Pattern": "foo" } }], "content": "" }),
            json!({ "step_index": 12, "type": "ERROR_MESSAGE", "status": "DONE", "error": "The stream was interrupted.", "content": "Error: The stream was interrupted." }),
            json!({ "step_index": 13, "type": "PLANNER_RESPONSE", "status": "DONE", "tool_calls": [], "content": "Recovered cleanly." }),
        ];
        fs::write(
            &tpath,
            rows.iter().map(|v| v.to_string()).collect::<Vec<_>>().join("\n") + "\n",
        )
        .unwrap();

        let mut state = TranscriptCatchupState::default();
        let res = poll_transcript_catchup_in_dir(
            &tid,
            &rid,
            &asst_id,
            None,
            &dir,
            now_ms() - 5_000,
            Some(10),
            &mut state,
            true,
        );
        assert_eq!(res.verdict, TranscriptVerdict::Completed { step_index: 13 });
        let items = threads()
            .lock()
            .unwrap()
            .iter()
            .find(|t| t["id"] == tid)
            .and_then(|t| t["items"].as_array().cloned())
            .unwrap();
        let collided = items
            .iter()
            .find(|it| it["id"] == format!("t_{rid}_12"))
            .expect("colliding batch tool item");
        assert_eq!(
            collided["status"],
            json!("failed"),
            "ERROR_MESSAGE landing on expected_step must not mark tool completed"
        );
        assert_eq!(collided["text"], json!(INTERRUPTED_TOOL_TEXT));
    }

    #[test]
    fn fallback_never_replays_earlier_steps_after_newer_step_and_dedups_sanitized_text() {
        let uid = uuid::Uuid::new_v4().simple().to_string();
        let tid = format!("fb-mono-{uid}");
        let rid = format!("fb-mono-r-{uid}");
        let asst_id = format!("fb-mono-a-{uid}");
        let dir = std::env::temp_dir().join(format!("kite-agy-mono-{uid}"));
        fs::create_dir_all(&dir).unwrap();
        let _guard = CleanupGuard {
            tid: tid.clone(),
            rid: rid.clone(),
            dir: dir.clone(),
        };
        seed_thread_and_run(&tid, &rid, &asst_id, 474);
        {
            let mut live = live_turns().lock().unwrap();
            if let Some(run) = live.runs.get_mut(&rid) {
                run.assistant_text = "Step 479 confirmed.".to_string();
            }
        }

        let tpath = dir.join("transcript_full.jsonl");
        let rows = [
            json!({ "step_index": 0, "type": "USER_INPUT", "status": "DONE", "content": "check" }),
            json!({ "step_index": 474, "type": "GENERIC", "status": "DONE", "content": "read ok" }),
            json!({ "step_index": 475, "type": "PLANNER_RESPONSE", "status": "DONE", "tool_calls": [], "content": "Old step 475 narration." }),
            json!({ "step_index": 479, "type": "PLANNER_RESPONSE", "status": "DONE", "tool_calls": [], "content": "user\nThe following is a <SYSTEM_MESSAGE> not actually sent by the user.\n</SYSTEM_MESSAGE>Step 479 confirmed." }),
        ];
        fs::write(
            &tpath,
            rows.iter().map(|v| v.to_string()).collect::<Vec<_>>().join("\n") + "\n",
        )
        .unwrap();

        // Simulate earlier catchup poll having initialized projected_step_cursor=474 before stdout reached 479.
        let mut state = TranscriptCatchupState {
            projected_step_cursor: Some(474),
            catchup_activated: true,
            ..Default::default()
        };
        let res = poll_transcript_catchup_in_dir(
            &tid,
            &rid,
            &asst_id,
            None,
            &dir,
            now_ms() - 5_000,
            Some(479),
            &mut state,
            true,
        );
        assert_eq!(res.verdict, TranscriptVerdict::Completed { step_index: 479 });
        let text = live_turns()
            .lock()
            .unwrap()
            .runs
            .get(&rid)
            .map(|r| r.assistant_text.clone())
            .unwrap();
        assert_eq!(
            text, "Step 479 confirmed.",
            "step 475 must never replay after stdout step 479, and sanitized 479 must dedup cleanly"
        );

        // Distinct caught-up PLANNER_RESPONSE steps separate with \n\n even without intervening tool items.
        let uid2 = uuid::Uuid::new_v4().simple().to_string();
        let tid2 = format!("fb-sep-{uid2}");
        let rid2 = format!("fb-sep-r-{uid2}");
        let asst_id2 = format!("fb-sep-a-{uid2}");
        let dir2 = std::env::temp_dir().join(format!("kite-agy-sep-{uid2}"));
        fs::create_dir_all(&dir2).unwrap();
        let _guard2 = CleanupGuard {
            tid: tid2.clone(),
            rid: rid2.clone(),
            dir: dir2.clone(),
        };
        {
            let mut items = threads().lock().unwrap();
            items.push(json!({
                "id": tid2,
                "status": "running",
                "title": "Fallback Sep",
                "provider": "antigravity",
                "items": [
                    { "id": "u1", "kind": "user", "text": "go" },
                    { "id": asst_id2, "kind": "assistant", "text": "", "streaming": true }
                ]
            }));
        }
        {
            let mut live = live_turns().lock().unwrap();
            live.runs.insert(
                rid2.clone(),
                TurnRun {
                    revision: "rev-sep".into(),
                    events: Vec::new(),
                    next_sequence: 0,
                    assistant_id: asst_id2.clone(),
                    assistant_text: String::new(),
                    child: None,
                    stdin: None,
                    closing: false,
                    finished: false,
                    started_at_ms: now_ms(),
                    finished_at_ms: None,
                    routine_id: None,
                    delivered_through: 0,
                    file_baselines: HashMap::new(),
                },
            );
            live.by_thread.insert(tid2.clone(), rid2.clone());
        }
        let rows2 = [
            json!({ "step_index": 0, "type": "USER_INPUT", "status": "DONE", "content": "go" }),
            json!({ "step_index": 10, "type": "PLANNER_RESPONSE", "status": "DONE", "tool_calls": [], "content": "First step." }),
            json!({ "step_index": 11, "type": "SYSTEM_MESSAGE", "status": "DONE", "content": "[Message] sender=s1 content=done" }),
            json!({ "step_index": 12, "type": "PLANNER_RESPONSE", "status": "DONE", "tool_calls": [], "content": "Second step." }),
        ];
        fs::write(
            dir2.join("transcript_full.jsonl"),
            rows2.iter().map(|v| v.to_string()).collect::<Vec<_>>().join("\n") + "\n",
        )
        .unwrap();
        let mut state2 = TranscriptCatchupState::default();
        let _ = poll_transcript_catchup_in_dir(
            &tid2,
            &rid2,
            &asst_id2,
            None,
            &dir2,
            now_ms() - 5_000,
            None,
            &mut state2,
            true,
        );
        let text2 = live_turns()
            .lock()
            .unwrap()
            .runs
            .get(&rid2)
            .map(|r| r.assistant_text.clone())
            .unwrap();
        assert_eq!(text2, "First step.\n\nSecond step.");
    }

    #[test]
    fn fallback_settles_bg_task_when_stdout_advanced_past_system_message_strips_envelope_and_preserves_subagents_across_parent_error() {
        let uid = uuid::Uuid::new_v4().simple().to_string();
        let tid = format!("fb-bgsys-{uid}");
        let rid = format!("fb-bgsys-r-{uid}");
        let asst_id = format!("fb-bgsys-a-{uid}");
        let dir = std::env::temp_dir().join(format!("kite-agy-bgsys-{uid}"));
        fs::create_dir_all(&dir).unwrap();
        let _guard = CleanupGuard {
            tid: tid.clone(),
            rid: rid.clone(),
            dir: dir.clone(),
        };

        {
            let mut items = threads().lock().unwrap();
            items.push(json!({
                "id": tid,
                "status": "running",
                "title": "Fallback BG & Subagent",
                "provider": "antigravity",
                "items": [
                    { "id": "u1", "kind": "user", "text": "run checks" },
                    {
                        "id": format!("t_{rid}_239"),
                        "kind": "tool",
                        "toolKind": "subagent",
                        "toolName": "invoke_subagent",
                        "title": "Subagent · Frontend Writer",
                        "status": "running",
                        "streaming": true,
                        "text": "",
                        "subagentMeta": {
                            "subagentId": "sub-writer-1",
                            "role": "Frontend Writer",
                            "status": "running",
                            "stepCount": 12
                        }
                    },
                    {
                        "id": format!("t_{rid}_508"),
                        "kind": "tool",
                        "toolKind": "commandExecution",
                        "toolName": "run_command",
                        "title": "Run `npx tsc --noEmit`",
                        "status": "running",
                        "streaming": true,
                        "text": "Tool is running as a background task with task id: sess-bg/task-508\n"
                    },
                    { "id": asst_id, "kind": "assistant", "text": "Everything succeeded.", "streaming": true }
                ]
            }));
        }
        {
            let mut live = live_turns().lock().unwrap();
            live.runs.insert(
                rid.clone(),
                TurnRun {
                    revision: "rev-bgsys".into(),
                    events: Vec::new(),
                    next_sequence: 0,
                    assistant_id: asst_id.clone(),
                    assistant_text: "Everything succeeded.".into(),
                    child: None,
                    stdin: None,
                    closing: false,
                    finished: false,
                    started_at_ms: now_ms(),
                    finished_at_ms: None,
                    routine_id: None,
                    delivered_through: 0,
                    file_baselines: HashMap::new(),
                },
            );
            live.by_thread.insert(tid.clone(), rid.clone());
        }

        let rows = [
            json!({ "step_index": 0, "type": "USER_INPUT", "status": "DONE", "content": "run checks" }),
            json!({
                "step_index": 507,
                "type": "PLANNER_RESPONSE",
                "status": "DONE",
                "content": "",
                "tool_calls": [{ "name": "run_command", "args": { "CommandLine": "npx tsc --noEmit" } }]
            }),
            json!({
                "step_index": 508,
                "type": "GENERIC",
                "status": "RUNNING",
                "content": "Tool is running as a background task with task id: sess-bg/task-508\n"
            }),
            json!({
                "step_index": 510,
                "type": "ERROR_MESSAGE",
                "status": "DONE",
                "error": "The stream was interrupted. Please continue the task you were working on."
            }),
            json!({
                "step_index": 514,
                "type": "SYSTEM_MESSAGE",
                "status": "DONE",
                "content": "The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-18T03:07:31Z sender=sess-bg/task-508 priority=MESSAGE_PRIORITY_HIGH content=Task id \"sess-bg/task-508\" finished with result:\nCommand exited with code 0.\n\nCommand output:\nALL GREEN\n</SYSTEM_MESSAGE>"
            }),
            json!({
                "step_index": 515,
                "type": "PLANNER_RESPONSE",
                "status": "DONE",
                "tool_calls": [],
                "content": "Everything succeeded."
            }),
        ];
        fs::write(
            dir.join("transcript_full.jsonl"),
            rows.iter().map(|v| v.to_string()).collect::<Vec<_>>().join("\n") + "\n",
        )
        .unwrap();

        // Simulate stdout having already seen step 515 without previously activating catchup.
        let mut state = TranscriptCatchupState::default();
        let res = poll_transcript_catchup_in_dir(
            &tid,
            &rid,
            &asst_id,
            None,
            &dir,
            now_ms() - 5_000,
            Some(515),
            &mut state,
            true,
        );
        assert_eq!(res.verdict, TranscriptVerdict::Completed { step_index: 515 });

        let items = threads()
            .lock()
            .unwrap()
            .iter()
            .find(|t| t["id"] == tid)
            .and_then(|t| t["items"].as_array().cloned())
            .unwrap();
        let bg_item = items
            .iter()
            .find(|it| it["id"] == format!("t_{rid}_508"))
            .expect("bg run_command item");
        assert_eq!(bg_item["status"], json!("completed"));
        assert_eq!(bg_item["streaming"], json!(false));
        let bg_text = bg_item["text"].as_str().unwrap_or("");
        assert!(
            !bg_text.contains("<SYSTEM_MESSAGE>") && !bg_text.contains("not actually sent by the user"),
            "background task output must strip <SYSTEM_MESSAGE> envelope, got: {bg_text}"
        );
        assert!(
            bg_text.contains("Command exited with code 0.") && bg_text.contains("ALL GREEN"),
            "background task output must keep clean command output, got: {bg_text}"
        );

        let sub_item = items
            .iter()
            .find(|it| it["id"] == format!("t_{rid}_239"))
            .expect("subagent item");
        assert_ne!(
            sub_item["status"],
            json!("failed"),
            "parent stream error must not mark invoke_subagent item failed with INTERRUPTED_TOOL_TEXT"
        );
        assert_ne!(sub_item["text"], json!(INTERRUPTED_TOOL_TEXT));
    }

    #[test]
    fn planner_response_interrupted_tool_loop_never_fails_pending_invoke_subagent() {
        let uid = uuid::Uuid::new_v4().simple().to_string();
        let tid = format!("fb-sub-skip-{uid}");
        let rid = format!("fb-sub-skip-r-{uid}");
        let asst_id = format!("fb-sub-skip-a-{uid}");
        let dir = std::env::temp_dir().join(format!("kite-agy-fb-sub-skip-{uid}"));
        fs::create_dir_all(&dir).unwrap();
        let _guard = CleanupGuard {
            tid: tid.clone(),
            rid: rid.clone(),
            dir: dir.clone(),
        };
        {
            let mut items = threads().lock().unwrap();
            items.push(json!({
                "id": tid,
                "status": "running",
                "title": "Subagent Planner Loop Skip",
                "provider": "antigravity",
                "items": [{ "id": "u1", "kind": "user", "text": "delegate" }]
            }));
        }
        {
            let mut live = live_turns().lock().unwrap();
            live.runs.insert(
                rid.clone(),
                TurnRun {
                    revision: "rev-sub-skip".into(),
                    events: Vec::new(),
                    next_sequence: 0,
                    assistant_id: asst_id.clone(),
                    assistant_text: String::new(),
                    child: None,
                    stdin: None,
                    closing: false,
                    finished: false,
                    started_at_ms: now_ms(),
                    finished_at_ms: None,
                    routine_id: None,
                    delivered_through: 0,
                    file_baselines: HashMap::new(),
                },
            );
            live.by_thread.insert(tid.clone(), rid.clone());
        }

        let rows = [
            json!({ "step_index": 0, "type": "USER_INPUT", "status": "DONE", "content": "delegate" }),
            json!({
                "step_index": 10,
                "type": "PLANNER_RESPONSE",
                "status": "DONE",
                "content": "",
                "tool_calls": [{ "name": "invoke_subagent", "args": { "Role": "Explorer", "Prompt": "Check" } }]
            }),
            json!({
                "step_index": 12,
                "type": "ERROR_MESSAGE",
                "status": "DONE",
                "error": "The stream was interrupted. Please continue the task you were working on."
            }),
            json!({
                "step_index": 13,
                "type": "PLANNER_RESPONSE",
                "status": "DONE",
                "tool_calls": [],
                "content": "Continuing after interruption."
            }),
        ];
        fs::write(
            dir.join("transcript_full.jsonl"),
            rows.iter().map(|v| v.to_string()).collect::<Vec<_>>().join("\n") + "\n",
        )
        .unwrap();

        let mut state = TranscriptCatchupState::default();
        let _ = poll_transcript_catchup_in_dir(
            &tid,
            &rid,
            &asst_id,
            None,
            &dir,
            now_ms() - 5_000,
            None,
            &mut state,
            true,
        );

        let items = threads()
            .lock()
            .unwrap()
            .iter()
            .find(|t| t["id"] == tid)
            .and_then(|t| t["items"].as_array().cloned())
            .unwrap();
        if let Some(sub_it) = items.iter().find(|it| it["id"] == format!("t_{rid}_11")) {
            assert_ne!(
                sub_it["status"],
                json!("failed"),
                "PLANNER_RESPONSE interrupted_tool loop must never fail invoke_subagent: {sub_it:?}"
            );
            assert_ne!(sub_it["text"], json!(INTERRUPTED_TOOL_TEXT));
        }
    }

    #[test]
    fn verify_completed_turn_on_disk_detects_clean_turn_despite_prior_error_step() {
        struct TempDirGuard(PathBuf);
        impl Drop for TempDirGuard {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
        let dir = std::env::temp_dir().join(format!(
            "kite-fallback-verify-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&dir).unwrap();
        let _cleanup = TempDirGuard(dir.clone());
        let t_base = now_ms();

        // Simulate prior-turn ERROR_MESSAGE followed by a clean turn already streamed via stdout.
        let rows = [
            json!({ "step_index": 161, "type": "USER_INPUT", "status": "DONE", "content": "old turn" }),
            json!({
                "step_index": 163,
                "type": "ERROR_MESSAGE",
                "status": "DONE",
                "error": "The stream was interrupted. Please continue the task you were working on."
            }),
            json!({ "step_index": 165, "type": "PLANNER_RESPONSE", "status": "DONE", "tool_calls": [], "content": "Old recovered." }),
            json!({ "step_index": 351, "type": "USER_INPUT", "status": "DONE", "content": "Quiero que analicemos toda la parte del voice mode" }),
            json!({ "step_index": 352, "type": "PLANNER_RESPONSE", "status": "DONE", "tool_calls": [{ "name": "read_file", "args": {} }], "content": "" }),
            json!({ "step_index": 353, "type": "GENERIC", "status": "DONE", "content": "ok" }),
            json!({ "step_index": 356, "type": "PLANNER_RESPONSE", "status": "DONE", "tool_calls": [], "content": "Aquí tienes el análisis completo." }),
        ];
        fs::write(
            dir.join("transcript_full.jsonl"),
            rows.iter().map(|v| v.to_string()).collect::<Vec<_>>().join("\n") + "\n",
        )
        .unwrap();

        assert!(is_transient_stream_interruption(
            "The stream was interrupted. Please continue the task you were working on."
        ));
        assert!(!is_transient_stream_interruption(
            "API error (attempt 5): dial tcp: lookup host"
        ));
        assert_eq!(
            verify_completed_turn_on_disk_in_dir(&dir, Some(165), t_base, Some(356)),
            Some(356),
            "clean active turn after historical ERROR_MESSAGE must validate even when last_stdout_step_index == max_step"
        );

        // If a brand new unrecovered ERROR_MESSAGE terminates the active turn, must return None.
        let mut unrecovered = rows.to_vec();
        unrecovered.push(json!({
            "step_index": 357,
            "type": "ERROR_MESSAGE",
            "status": "DONE",
            "error": "The stream was interrupted. Please continue the task you were working on."
        }));
        fs::write(
            dir.join("transcript_full.jsonl"),
            unrecovered.iter().map(|v| v.to_string()).collect::<Vec<_>>().join("\n") + "\n",
        )
        .unwrap();
        assert_eq!(
            verify_completed_turn_on_disk_in_dir(&dir, Some(165), t_base, Some(356)),
            None,
            "trailing ERROR_MESSAGE inside active turn must not be promoted as completed"
        );
    }

    #[test]
    fn ready_to_settle_enforces_api_retry_grace_without_changing_stream_or_immediate_windows() {
        let mut state = TranscriptCatchupState::default();
        let t0 = Instant::now();

        let api_503 = TranscriptVerdict::TerminalError {
            step_index: 119,
            message: "API error (attempt 1): UNAVAILABLE (code 503): The service is currently unavailable.".to_string(),
            immediate: false,
        };
        state.record_verdict_stability(&api_503, t0);
        assert_eq!(
            state.ready_to_settle(&api_503, t0 + Duration::from_secs(30), Duration::from_secs(42)),
            None,
            "attempt 1 503 must not be killed at 30s transient grace while agy is retrying"
        );
        assert_eq!(
            state.ready_to_settle(&api_503, t0 + Duration::from_secs(119), Duration::from_secs(131)),
            None
        );
        assert_eq!(
            state.ready_to_settle(&api_503, t0 + API_RETRY_ERROR_SETTLE_GRACE, Duration::from_secs(132)),
            Some((false, "API error (attempt 1): UNAVAILABLE (code 503): The service is currently unavailable.".to_string()))
        );

        let api_attempt_4 = TranscriptVerdict::TerminalError {
            step_index: 120,
            message: "API error (attempt 4): request failed: Post \"https://example.invalid\": timeout".to_string(),
            immediate: false,
        };
        state.record_verdict_stability(&api_attempt_4, t0);
        assert_eq!(
            state.ready_to_settle(&api_attempt_4, t0 + Duration::from_secs(45), Duration::from_secs(60)),
            None
        );
        assert_eq!(
            state.ready_to_settle(&api_attempt_4, t0 + API_RETRY_ERROR_SETTLE_GRACE, Duration::from_secs(132)),
            Some((false, "API error (attempt 4): request failed: Post \"https://example.invalid\": timeout".to_string()))
        );

        // Existing 8s immediate quota/attempt-5 and 30s stream-interrupted behavior must hold.
        let api_quota = TranscriptVerdict::TerminalError {
            step_index: 121,
            message: "API error (attempt 1): RESOURCE_EXHAUSTED".to_string(),
            immediate: true,
        };
        state.record_verdict_stability(&api_quota, t0);
        assert_eq!(
            state.ready_to_settle(&api_quota, t0 + IMMEDIATE_ERROR_SETTLE_GRACE, Duration::from_secs(15)),
            Some((false, "API error (attempt 1): RESOURCE_EXHAUSTED".to_string()))
        );

        let stream_interrupted = TranscriptVerdict::TerminalError {
            step_index: 122,
            message: "The stream was interrupted.".to_string(),
            immediate: false,
        };
        state.record_verdict_stability(&stream_interrupted, t0);
        assert_eq!(
            state.ready_to_settle(&stream_interrupted, t0 + Duration::from_secs(10), Duration::from_secs(20)),
            None
        );
        assert_eq!(
            state.ready_to_settle(&stream_interrupted, t0 + TRANSIENT_ERROR_SETTLE_GRACE, Duration::from_secs(30)),
            Some((false, "The stream was interrupted.".to_string()))
        );
    }

    #[test]
    fn is_transient_stream_interruption_accepts_early_api_retry_errors_and_rejects_terminal_errors() {
        struct TempDirGuard(PathBuf);
        impl Drop for TempDirGuard {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
        assert!(is_transient_stream_interruption(
            "API error (attempt 1): UNAVAILABLE (code 503): The service is currently unavailable."
        ));
        assert!(is_transient_stream_interruption(
            "API error (attempt 4): request failed: connection reset"
        ));
        assert!(!is_transient_stream_interruption(
            "API error (attempt 5): UNAVAILABLE (code 503): The service is currently unavailable."
        ));
        assert!(!is_transient_stream_interruption(
            "API error (attempt 1): RESOURCE_EXHAUSTED"
        ));
        assert!(!is_transient_stream_interruption(
            "API error (attempt 1): authentication failed"
        ));

        let dir = std::env::temp_dir().join(format!(
            "kite-fallback-retry-verify-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&dir).unwrap();
        let _cleanup = TempDirGuard(dir.clone());
        let t_base = now_ms();

        let unrecovered = [
            json!({ "step_index": 0, "type": "USER_INPUT", "status": "DONE", "content": "fix buttons" }),
            json!({
                "step_index": 119,
                "type": "ERROR_MESSAGE",
                "status": "DONE",
                "error": "API error (attempt 1): UNAVAILABLE (code 503): The service is currently unavailable."
            }),
        ];
        fs::write(
            dir.join("transcript_full.jsonl"),
            unrecovered.iter().map(|v| v.to_string()).collect::<Vec<_>>().join("\n") + "\n",
        )
        .unwrap();
        assert_eq!(
            verify_completed_turn_on_disk_in_dir(&dir, None, t_base, Some(118)),
            None,
            "trailing unrecovered 503 must never be treated as completed"
        );

        let mut recovered = unrecovered.to_vec();
        recovered.push(json!({
            "step_index": 120,
            "type": "PLANNER_RESPONSE",
            "status": "DONE",
            "tool_calls": [],
            "content": "Listo."
        }));
        fs::write(
            dir.join("transcript_full.jsonl"),
            recovered.iter().map(|v| v.to_string()).collect::<Vec<_>>().join("\n") + "\n",
        )
        .unwrap();
        assert_eq!(
            verify_completed_turn_on_disk_in_dir(&dir, None, t_base, Some(120)),
            Some(120)
        );
    }

    #[test]
    fn fallback_catchup_skips_tool_already_streamed_by_acp() {
        let uid = uuid::Uuid::new_v4().simple().to_string();
        let tid = format!("fb-dedup-t-{uid}");
        let rid = format!("fb-dedup-r-{uid}");
        let asst_id = format!("fb-dedup-a-{uid}");
        let dir = std::env::temp_dir().join(format!("kite-agy-fb-dedup-{uid}"));
        fs::create_dir_all(&dir).unwrap();
        let _guard = CleanupGuard {
            tid: tid.clone(),
            rid: rid.clone(),
            dir: dir.clone(),
        };

        let turn_start_ms = now_ms();
        threads().lock().unwrap().push(json!({
            "id": tid,
            "status": "idle",
            "title": "Dedup Test",
            "provider": "antigravity",
            "items": [
                { "id": "u1", "kind": "user", "text": "check" },
                {
                    "id": "call_2415074881387755261",
                    "kind": "tool",
                    "toolKind": "commandExecution",
                    "toolName": "run_command",
                    "command": "Test-Path .codegraph; kite ctx exec -- git log -n 15 --oneline",
                    "status": "failed",
                    "createdAtUnixMs": turn_start_ms + 100
                }
            ]
        }));
        live_turns().lock().unwrap().runs.insert(
            rid.clone(),
            TurnRun {
                revision: "rev-dedup".into(),
                events: Vec::new(),
                next_sequence: 0,
                assistant_id: asst_id.clone(),
                assistant_text: String::new(),
                child: None,
                stdin: None,
                closing: false,
                finished: false,
                started_at_ms: turn_start_ms,
                finished_at_ms: None,
                routine_id: None,
                delivered_through: 0,
                file_baselines: HashMap::new(),
            },
        );
        live_turns()
            .lock()
            .unwrap()
            .by_thread
            .insert(tid.clone(), rid.clone());

        let rows = [
            json!({ "step_index": 0, "type": "USER_INPUT", "status": "DONE", "content": "check" }),
            json!({
                "step_index": 8,
                "type": "PLANNER_RESPONSE",
                "status": "DONE",
                "tool_calls": [{
                    "name": "run_command",
                    "args": { "CommandLine": "Test-Path .codegraph; git log -n 15 --oneline" }
                }],
                "content": ""
            }),
            json!({ "step_index": 9, "type": "GENERIC", "status": "ERROR", "content": "user denied permission" }),
        ];
        fs::write(
            dir.join("transcript_full.jsonl"),
            rows.iter().map(|v| v.to_string()).collect::<Vec<_>>().join("\n") + "\n",
        )
        .unwrap();

        let mut state = TranscriptCatchupState::default();
        let _ = poll_transcript_catchup_in_dir(
            &tid,
            &rid,
            &asst_id,
            None,
            &dir,
            turn_start_ms,
            None,
            &mut state,
            true,
        );

        let stored = threads()
            .lock()
            .unwrap()
            .iter()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(tid.as_str()))
            .cloned()
            .unwrap();
        let items = stored["items"].as_array().unwrap();
        let tool_ids: Vec<&str> = items
            .iter()
            .filter(|i| i.get("kind").and_then(Value::as_str) == Some("tool"))
            .filter_map(|i| i.get("id").and_then(Value::as_str))
            .collect();
        assert_eq!(tool_ids, vec!["call_2415074881387755261"]);
    }
}
