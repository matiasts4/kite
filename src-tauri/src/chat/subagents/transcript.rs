use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::*;
use crate::acp::{
    build_acp_tool_call, extract_mentions, merge_subagent_meta, AcpStreamEvent, SubagentMeta,
    SwarmMeta,
};
use crate::chat::models::default_mode;
use crate::chat::runtime::{live_cv, live_turns, push_event};
use crate::chat::threads::{blank_thread, chat_item, touch, upsert_item};
use crate::chat::utils::now_ms;
use crate::persist::{persist, threads, workspace_path};

pub fn resolve_local_transcript_path(uri: &str) -> Option<PathBuf> {
    let trimmed = uri.trim();
    if trimmed.is_empty() {
        return None;
    }
    let decoded = trimmed.replace("%20", " ").replace("%3A", ":").replace("%3a", ":");
    let stripped = if let Some(rest) = decoded.strip_prefix("file:///") {
        // Windows paths in file:///C:/... have a drive letter after the triple slash; POSIX needs leading /.
        if rest.chars().nth(1) == Some(':') {
            rest.to_string()
        } else {
            format!("/{rest}")
        }
    } else if let Some(rest) = decoded.strip_prefix("file://") {
        rest.to_string()
    } else {
        decoded
    };
    Some(PathBuf::from(stripped))
}


fn parse_transcript_line(line: &str, idx: usize, subagent_id: &str) -> Vec<Value> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    let Ok(val) = serde_json::from_str::<Value>(trimmed) else {
        return Vec::new();
    };
    let mut items: Vec<Value> = Vec::new();
    let step_type = val
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_uppercase();
    match step_type.as_str() {
        "USER_INPUT" => {
            let text = val.get("content").and_then(Value::as_str).unwrap_or("");
            if !text.trim().is_empty() {
                let id = format!("sub_{subagent_id}_u_{idx}");
                upsert_nested_item(&mut items, &chat_item(&id, "user", text, false));
            }
        }
        "PLANNER_RESPONSE" => {
            if let Some(thinking) = val.get("thinking").and_then(Value::as_str) {
                if !thinking.trim().is_empty() {
                    let id = format!("sub_{subagent_id}_r_{idx}");
                    upsert_nested_item(
                        &mut items,
                        &chat_item(&id, "reasoning", thinking, false),
                    );
                }
            }
            if let Some(tool_calls) = val.get("tool_calls").and_then(Value::as_array) {
                for (t_idx, tc) in tool_calls.iter().enumerate() {
                    let raw_name = tc
                        .get("name")
                        .or_else(|| tc.get("tool_name"))
                        .and_then(Value::as_str)
                        .unwrap_or("tool");
                    let tc_id = tc
                        .get("id")
                        .or_else(|| tc.get("call_id"))
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .unwrap_or_else(|| format!("sub_{subagent_id}_t_{idx}_{t_idx}"));
                    let params = tc
                        .get("arguments")
                        .or_else(|| tc.get("parameters"))
                        .or_else(|| tc.get("input"))
                        .cloned()
                        .unwrap_or(Value::Null);
                    let output = tc.get("output").or_else(|| tc.get("result")).and_then(|v| {
                        v.as_str()
                            .map(str::to_string)
                            .or_else(|| (!v.is_null()).then(|| serde_json::to_string_pretty(v).ok()).flatten())
                    });
                    let status = tc
                        .get("status")
                        .and_then(Value::as_str)
                        .unwrap_or("completed")
                        .to_string();
                    let acp_tool = build_acp_tool_call(
                        tc_id,
                        raw_name,
                        params,
                        status,
                        output,
                        None,
                        None,
                        None,
                        None,
                        None,
                        None,
                        None,
                    );
                    upsert_nested_item(&mut items, &acp_tool_to_chat_item(&acp_tool));
                }
            }
            if let Some(text) = val.get("content").and_then(Value::as_str) {
                if !text.trim().is_empty() {
                    let id = format!("sub_{subagent_id}_a_{idx}");
                    upsert_nested_item(&mut items, &chat_item(&id, "assistant", text, false));
                }
            }
        }
        _ => {
            // Fallback for Claude/ACP stream lines inside a local JSONL file.
            let hint = if val.pointer("/message/content").and_then(Value::as_array).is_some() {
                format!("jsonl_{idx}")
            } else {
                extract_nested_frame_hint(&val)
            };
            for item in parse_nested_frame_items(subagent_id, &hint, &val) {
                upsert_nested_item(&mut items, &item);
            }
        }
    }
    items
}

pub fn parse_transcript_jsonl(content: &str, subagent_id: &str) -> Vec<Value> {
    let mut items: Vec<Value> = Vec::new();
    for (idx, line) in content.lines().enumerate() {
        for item in parse_transcript_line(line, idx, subagent_id) {
            upsert_nested_item(&mut items, &item);
        }
    }
    items
}

pub(super) fn active_tailers() -> &'static Mutex<HashSet<String>> {
    static SET: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    SET.get_or_init(|| Mutex::new(HashSet::new()))
}

pub(crate) struct TranscriptTailState {
    offset: u64,
    next_line_idx: usize,
    pending_bytes: Vec<u8>,
}

impl TranscriptTailState {
    pub(crate) fn new() -> Self {
        Self {
            offset: 0,
            next_line_idx: 0,
            pending_bytes: Vec::new(),
        }
    }

    pub(crate) fn read_incremental_items(
        &mut self,
        path: &Path,
        subagent_id: &str,
        flush_eof: bool,
    ) -> Vec<Value> {
        let Ok(meta) = fs::metadata(path) else {
            return Vec::new();
        };
        if meta.len() < self.offset {
            // File was truncated or rewritten from scratch.
            self.offset = 0;
            self.next_line_idx = 0;
            self.pending_bytes.clear();
        }
        let Ok(mut file) = File::open(path) else {
            return Vec::new();
        };
        if file.seek(SeekFrom::Start(self.offset)).is_err() {
            return Vec::new();
        }
        let mut buf = Vec::new();
        if file.read_to_end(&mut buf).is_err() {
            return Vec::new();
        }
        if !buf.is_empty() {
            self.offset += buf.len() as u64;
            self.pending_bytes.extend_from_slice(&buf);
        }

        let mut items = Vec::new();
        if let Some(last_nl) = self.pending_bytes.iter().rposition(|&b| b == b'\n') {
            let tail = self.pending_bytes.split_off(last_nl + 1);
            let complete = std::mem::replace(&mut self.pending_bytes, tail);
            let text = String::from_utf8_lossy(&complete);
            for line in text.lines() {
                let idx = self.next_line_idx;
                self.next_line_idx += 1;
                for item in parse_transcript_line(line, idx, subagent_id) {
                    upsert_nested_item(&mut items, &item);
                }
            }
        }
        if flush_eof && !self.pending_bytes.is_empty() {
            let leftover = std::mem::take(&mut self.pending_bytes);
            let text = String::from_utf8_lossy(&leftover);
            for line in text.lines() {
                let idx = self.next_line_idx;
                self.next_line_idx += 1;
                for item in parse_transcript_line(line, idx, subagent_id) {
                    upsert_nested_item(&mut items, &item);
                }
            }
        }
        items
    }
}

fn apply_parsed_transcript_items(
    thread_id: &str,
    subagent_id: &str,
    parsed_items: &[Value],
) -> bool {
    if parsed_items.is_empty() {
        return false;
    }

    let mut updated_run: Option<Value> = None;
    {
        let mut all_threads = threads().lock().unwrap();
        if let Some(thread) = all_threads
            .iter_mut()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(thread_id))
        {
            if let Some(runs) = thread.get_mut("subagentRuns").and_then(Value::as_array_mut) {
                if let Some(run) = runs.iter_mut().find(|r| {
                    r.get("subagentId").and_then(Value::as_str) == Some(subagent_id)
                }) {
                    let mut existing: Vec<Value> = run
                        .get("items")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    for item in parsed_items {
                        upsert_nested_item(&mut existing, item);
                    }
                    let (step_count, latest_activity) = summarize_run_progress(&existing);
                    run["items"] = Value::Array(existing);
                    run["stepCount"] = json!(step_count);
                    if let Some(ref latest) = latest_activity {
                        run["latestActivity"] = json!(latest);
                    }
                    run["updatedAtUnixMs"] = json!(now_ms());
                    updated_run = Some(run.clone());
                    sync_parent_tool_item_progress(
                        thread,
                        subagent_id,
                        step_count,
                        latest_activity.as_deref(),
                    );
                    touch(thread);
                }
            }
        }
    }

    if let Some(run) = updated_run {
        emit_subagent_event(json!({
            "kind": "subagentRunUpdated",
            "threadId": thread_id,
            "subagentId": subagent_id,
            "run": run,
        }));
        emit_subagent_steps_event(thread_id, subagent_id, &run);
        return true;
    }
    false
}

pub fn sync_transcript_file(thread_id: &str, subagent_id: &str, uri: &str) -> Vec<Value> {
    let Some(path) = resolve_local_transcript_path(uri) else {
        return Vec::new();
    };
    let Ok(content) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    let parsed_items = parse_transcript_jsonl(&content, subagent_id);
    if apply_parsed_transcript_items(thread_id, subagent_id, &parsed_items) {
        persist();
    }
    parsed_items
}

pub(super) fn spawn_transcript_tailer_if_needed(thread_id: &str, subagent_id: &str, uri: &str) {
    let Some(path) = resolve_local_transcript_path(uri) else {
        return;
    };
    if !path.exists() {
        return;
    }
    let key = format!("{thread_id}:{subagent_id}:{uri}");
    {
        let mut set = active_tailers().lock().unwrap();
        if set.contains(&key) {
            return;
        }
        set.insert(key.clone());
    }

    let thread_id = thread_id.to_string();
    let subagent_id = subagent_id.to_string();
    thread::spawn(move || {
        const MAX_IDLE_TICKS: u32 = 4;
        const MAX_SAFETY_TICKS: u32 = 86_400; // 6h upper bound at 250ms ticks
        let mut tail_state = TranscriptTailState::new();
        let mut last_sig: Option<(u64, Option<std::time::SystemTime>)> = None;
        let mut idle_ticks = 0u32;
        let mut synced_since_persist = false;
        for _ in 0..MAX_SAFETY_TICKS {
            if let Ok(meta) = fs::metadata(&path) {
                let sig = (meta.len(), meta.modified().ok());
                if last_sig != Some(sig) {
                    last_sig = Some(sig);
                    idle_ticks = 0;
                    let delta = tail_state.read_incremental_items(&path, &subagent_id, false);
                    if apply_parsed_transcript_items(&thread_id, &subagent_id, &delta) {
                        synced_since_persist = true;
                    }
                }
            }
            let still_running = {
                let list = threads().lock().unwrap();
                list.iter()
                    .find(|t| t.get("id").and_then(Value::as_str) == Some(thread_id.as_str()))
                    .and_then(|t| t.get("subagentRuns").and_then(Value::as_array))
                    .and_then(|runs| {
                        runs.iter()
                            .find(|r| r.get("subagentId").and_then(Value::as_str) == Some(subagent_id.as_str()))
                    })
                    .and_then(|r| r.get("status").and_then(Value::as_str))
                    .is_some_and(|s| s == "running" || s == "waiting")
            };
            if still_running {
                idle_ticks = 0;
            } else {
                idle_ticks += 1;
                if idle_ticks >= MAX_IDLE_TICKS {
                    break;
                }
            }
            thread::sleep(Duration::from_millis(250));
        }
        let eof_delta = tail_state.read_incremental_items(&path, &subagent_id, true);
        if apply_parsed_transcript_items(&thread_id, &subagent_id, &eof_delta) {
            synced_since_persist = true;
        }
        if synced_since_persist {
            persist();
        }
        active_tailers().lock().unwrap().remove(&key);
    });
}

pub(super) fn sync_parent_tool_item_progress(
    thread: &mut Value,
    subagent_id: &str,
    step_count: usize,
    latest_activity: Option<&str>,
) -> Option<Value> {
    let items = thread.get_mut("items")?.as_array_mut()?;
    let target = items.iter_mut().find(|it| {
        it.pointer("/subagentMeta/subagentId").and_then(Value::as_str) == Some(subagent_id)
            || it.get("id").and_then(Value::as_str) == Some(subagent_id)
    })?;
    if let Some(meta) = target.get_mut("subagentMeta").and_then(Value::as_object_mut) {
        meta.insert("stepCount".to_string(), json!(step_count));
        if let Some(latest) = latest_activity {
            meta.insert("latestActivity".to_string(), json!(latest));
        }
    }
    Some(target.clone())
}

