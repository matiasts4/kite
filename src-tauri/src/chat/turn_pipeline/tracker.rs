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

/// Merges tool_call, tool_call_update, and tool_call_content_chunk by id.
#[derive(Debug, Default, Clone)]
pub struct ToolCallTracker {
    calls: BTreeMap<String, ToolCallSnapshot>,
    call_meta: BTreeMap<String, (String, Value)>,
    next_anon_id: usize,
    last_anon_id: Option<String>,
}

impl ToolCallTracker {
    pub fn snapshot(&self, id: &str) -> Option<&ToolCallSnapshot> {
        self.calls.get(id)
    }

    fn resolve_tool_id(&mut self, update: &Value, is_new_call: bool) -> String {
        if let Some(id) = explicit_tool_id(update) {
            return id;
        }
        if is_new_call {
            self.next_anon_id += 1;
            let id = format!("tool-{}", self.next_anon_id);
            self.last_anon_id = Some(id.clone());
            id
        } else {
            self.last_anon_id.clone().unwrap_or_else(|| "tool".to_string())
        }
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
            "tool_call" | "tool_use" => {
                let snap = self.merge_tool(update, true);
                vec![ProviderTurnEvent::ToolCallUpdated { tool: snap }]
            }
            "tool_call_update" => {
                let snap = self.merge_tool(update, false);
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
            "turn_completed" | "turn_complete" | "turn.completed" | "usage_update" | "step_finish" => {
                usage_events(update, frame)
            }
            "available_commands_update"
            | "session_info_update"
            | "hook_execution"
            | "config_option_update"
            | "current_mode_update"
            | "mode_update"
            | "commands_update"
            | "user_message_chunk"
            | "step_start" => Vec::new(),
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

    fn merge_tool(&mut self, update: &Value, is_new_call: bool) -> ToolCallSnapshot {
        let id = self.resolve_tool_id(update, is_new_call);
        let src = update.get("part").unwrap_or(update);
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
            subagent_meta: None,
            swarm_meta: None,
            parent_tool_use_id: None,
        });
        let incoming_name = src
            .get("name")
            .or_else(|| src.get("tool"))
            .or_else(|| src.get("tool_name"))
            .or_else(|| src.get("toolName"))
            .or_else(|| src.get("title"))
            .or_else(|| update.get("name"))
            .or_else(|| update.get("toolName"))
            .and_then(Value::as_str)
            .map(str::to_string);
        if let Some(kind) = src
            .get("kind")
            .or_else(|| update.get("kind"))
            .and_then(Value::as_str)
        {
            if !kind.is_empty() && entry.kind != "subagent" && entry.kind != "swarm" {
                entry.kind = crate::acp::normalize_tool_kind_name(kind);
            }
        }
        if let Some(title) = src
            .get("title")
            .or_else(|| src.get("name"))
            .or_else(|| src.get("tool"))
            .or_else(|| src.get("tool_name"))
            .or_else(|| src.pointer("/state/title"))
            .or_else(|| update.get("title"))
            .or_else(|| update.get("name"))
            .and_then(Value::as_str)
        {
            if !title.is_empty() {
                entry.title = title.to_string();
            }
        }
        if let Some(status) = src
            .get("status")
            .or_else(|| src.pointer("/state/status"))
            .or_else(|| update.get("status"))
            .and_then(Value::as_str)
        {
            if !status.is_empty() {
                entry.status = status.to_string();
            }
        }
        if let Some(parent_id) = src
            .get("parent_tool_use_id")
            .or_else(|| src.get("parentToolUseId"))
            .or_else(|| update.get("parent_tool_use_id"))
            .or_else(|| update.get("parentToolUseId"))
            .and_then(Value::as_str)
        {
            if !parent_id.is_empty() {
                entry.parent_tool_use_id = Some(parent_id.to_string());
            }
        }
        let input = src
            .get("rawInput")
            .or_else(|| src.get("input"))
            .or_else(|| src.get("arguments"))
            .or_else(|| src.get("parameters"))
            .or_else(|| src.pointer("/state/input"))
            .or_else(|| update.get("rawInput"))
            .or_else(|| update.get("input"))
            .or_else(|| update.get("arguments"));
        if let Some(input) = input {
            if entry.path.is_none() {
                entry.path = string_field(
                    input,
                    &["path", "file", "filePath", "file_path", "Path", "TargetFile"],
                );
            }
            if entry.command.is_none() {
                entry.command = string_field(input, &["command", "cmd", "CommandLine"]);
            }
            if entry.query.is_none() {
                entry.query = string_field(input, &["query", "pattern", "q", "regex", "search"]);
            }
        }
        if entry.path.is_none() {
            entry.path = src
                .pointer("/locations/0/path")
                .or_else(|| update.pointer("/locations/0/path"))
                .and_then(Value::as_str)
                .map(str::to_string);
        }
        let (content_path, content_add, content_del) = {
            let from_src = crate::acp::extract_acp_diff_and_path(src);
            if from_src.1.is_some() || from_src.2.is_some() || from_src.0.is_some() {
                from_src
            } else {
                crate::acp::extract_acp_diff_and_path(update)
            }
        };
        if entry.path.is_none() {
            entry.path = content_path;
        }
        if let Some(add) = content_add {
            entry.additions = Some(add as i64);
        }
        if let Some(del) = content_del {
            entry.deletions = Some(del as i64);
        }
        if let Some(add) = src
            .pointer("/diff/additions")
            .or_else(|| src.get("addedLines"))
            .or_else(|| update.pointer("/diff/additions"))
            .or_else(|| update.get("addedLines"))
            .and_then(Value::as_i64)
        {
            entry.additions = Some(add);
        }
        if let Some(del) = src
            .pointer("/diff/deletions")
            .or_else(|| src.get("removedLines"))
            .or_else(|| update.pointer("/diff/deletions"))
            .or_else(|| update.get("removedLines"))
            .and_then(Value::as_i64)
        {
            entry.deletions = Some(del);
        }
        if let Some(out) = src
            .get("rawOutput")
            .or_else(|| src.get("output"))
            .or_else(|| src.pointer("/state/output"))
            .or_else(|| update.get("rawOutput"))
            .or_else(|| update.get("output"))
        {
            let out_str = if let Some(s) = out.as_str() {
                Some(s.to_string())
            } else if !out.is_null() {
                serde_json::to_string(out).ok()
            } else {
                None
            };
            if let Some(text) = out_str {
                if !text.is_empty() {
                    entry.output = text;
                }
            }
        }

        let (stored_name, stored_input) = self
            .call_meta
            .entry(id.clone())
            .or_insert_with(|| (String::new(), Value::Null));
        if let Some(name) = incoming_name {
            if !name.is_empty() {
                *stored_name = name;
            }
        }
        if let Some(inp) = input {
            if !inp.is_null() {
                *stored_input = inp.clone();
            }
        }
        let eval_name = if stored_name.is_empty() {
            if entry.subagent_meta.is_some() {
                "invoke_subagent"
            } else if entry.swarm_meta.is_some() {
                "swarm"
            } else {
                entry.title.as_str()
            }
        } else {
            stored_name.as_str()
        };
        let (
            classified_kind,
            _,
            classified_title,
            classified_cmd,
            classified_path,
            classified_add,
            classified_del,
        ) = classify_tool_metadata(eval_name, stored_input);
        if entry.command.is_none() {
            entry.command = classified_cmd;
        }
        if entry.path.is_none() {
            entry.path = classified_path;
        }
        if entry.additions.is_none() {
            entry.additions = classified_add.map(|n| n as i64);
        }
        if entry.deletions.is_none() {
            entry.deletions = classified_del.map(|n| n as i64);
        }
        if entry.status != "killed"
            && (response_indicates_failure(
                &entry.status,
                Some(src),
                None,
                Some(entry.output.as_str()),
            ) || response_indicates_failure(&entry.status, Some(update), None, None))
        {
            entry.status = "failed".to_string();
        }
        if let Some(meta) = extract_subagent_meta(
            eval_name,
            &entry.id,
            stored_input,
            Some(entry.output.as_str()),
            &entry.status,
        ) {
            if meta.status == "failed" && entry.status != "killed" {
                entry.status = "failed".to_string();
            }
            entry.kind = "subagent".into();
            let clean_title = entry.title.trim().to_ascii_lowercase().replace([' ', '-'], "_");
            if entry.title.is_empty()
                || entry.title == eval_name
                || crate::acp::types::is_shell_wrapper_name(&clean_title)
            {
                entry.title = classified_title;
            }
            entry.subagent_meta = Some(merge_subagent_meta(entry.subagent_meta.as_ref(), meta));
        } else if let Some(meta) =
            extract_swarm_meta(eval_name, stored_input, Some(entry.output.as_str()))
        {
            entry.kind = "swarm".into();
            if entry.title.is_empty() || entry.title == eval_name {
                entry.title = classified_title;
            }
            entry.swarm_meta = Some(merge_swarm_meta(entry.swarm_meta.as_ref(), meta));
        } else if classified_kind == "subagent"
            || classified_kind == "swarm"
            || (classified_kind == "fileChange"
                && matches!(entry.kind.as_str(), "tool" | "other" | ""))
        {
            entry.kind = classified_kind;
        }

        entry.clone()
    }

    fn append_chunk(&mut self, update: &Value) -> ToolCallSnapshot {
        let id = self.resolve_tool_id(update, false);
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
            subagent_meta: None,
            swarm_meta: None,
            parent_tool_use_id: None,
        });
        entry.output.push_str(chunk);
        if entry.status != "killed"
            && response_indicates_failure(&entry.status, None, None, Some(entry.output.as_str()))
        {
            entry.status = "failed".to_string();
            if let Some(meta) = entry.subagent_meta.as_mut() {
                meta.status = "failed".to_string();
            }
        }
        entry.clone()
    }
}
