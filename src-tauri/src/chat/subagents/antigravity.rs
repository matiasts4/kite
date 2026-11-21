use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::placeholders::{
    drop_superseded_placeholders_with_details, find_unbound_placeholder_index,
    superseded_placeholder_ids,
};
use super::*;
use crate::acp::{
    is_non_delegating_subagent_tool, parse_output_json, parse_output_json_array,
    strip_mcp_prefix, SubagentMeta,
};
use crate::chat::runtime::{live_cv, live_turns, push_event};
use crate::chat::threads::touch;
use crate::chat::utils::{now_ms, user_home_dir};
use crate::persist::{persist, threads};

#[derive(Clone, Debug)]
struct PendingInvoke {
    role: Option<String>,
    type_name: Option<String>,
    prompt: Option<String>,
    model: Option<String>,
    workspace_mode: Option<String>,
    created_at_ms: i64,
}

#[derive(Clone, Debug)]
struct DiscoveredAgySubagent {
    cid: String,
    role: String,
    type_name: Option<String>,
    prompt: Option<String>,
    model: Option<String>,
    workspace_mode: Option<String>,
    status: String,
    transcript_uri: Option<String>,
    created_at_ms: i64,
}

#[derive(Default)]
pub struct AntigravityReconcileOutcome {
    pub changed: bool,
    pub items_to_emit: Vec<Value>,
    pub removed_item_ids: Vec<String>,
    pub runs_to_emit: Vec<Value>,
    pub removed_runs: Vec<(String, String)>,
    pub uris_to_sync: Vec<(String, String, bool)>,
}

fn apply_drop_superseded(thread: &mut Value, outcome: &mut AntigravityReconcileOutcome) {
    let (ids, runs) = drop_superseded_placeholders_with_details(thread);
    if !ids.is_empty() || !runs.is_empty() {
        outcome.changed = true;
        outcome.removed_item_ids.extend(ids);
        outcome.removed_runs.extend(runs);
    }
}

fn downgrade_unspawned_failed_native_invokes(
    thread: &mut Value,
) -> (Vec<Value>, Vec<(String, String)>) {
    let mut call_ids = Vec::new();
    let mut downgraded_items = Vec::new();
    if let Some(items) = thread.get_mut("items").and_then(Value::as_array_mut) {
        for it in items.iter_mut() {
            if super::record::downgrade_unspawned_failed_native_invoke_in_place(it) {
                if let Some(id) = it.get("id").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                    call_ids.push(id.to_string());
                }
                downgraded_items.push(it.clone());
            }
        }
    }
    let mut removed_runs = Vec::new();
    for call_id in call_ids {
        removed_runs.extend(super::record::remove_unspawned_invoke_runs_in_thread(
            thread, &call_id,
        ));
    }
    (downgraded_items, removed_runs)
}

fn unwrap_transcript_arg_str(val: Option<&Value>) -> Option<String> {
    let raw = val?.as_str()?.trim();
    if raw.is_empty() {
        return None;
    }
    let decoded = if raw.starts_with('"') && raw.ends_with('"') && raw.len() >= 2 {
        serde_json::from_str::<String>(raw).unwrap_or_else(|_| raw.to_string())
    } else {
        raw.to_string()
    };
    let clean = decoded.trim().to_string();
    (!clean.is_empty()).then_some(clean)
}

fn parse_step_timestamp_ms(step: &Value) -> i64 {
    step.get("created_at")
        .and_then(Value::as_str)
        .and_then(|s| crate::quota::utils::chrono_parse_rfc3339(s).ok())
        .unwrap_or_else(now_ms)
}

fn normalize_agy_state(raw: &str) -> String {
    match raw.trim().to_ascii_lowercase().as_str() {
        "running" | "queued" | "pending" | "started" | "in_progress" | "inprogress" => {
            "running".to_string()
        }
        "waiting" | "needs_input" | "needsinput" | "blocked" => "waiting".to_string(),
        "failed" | "error" | "errored" | "rejected" => "failed".to_string(),
        "killed" | "cancelled" | "canceled" => "killed".to_string(),
        _ => "completed".to_string(),
    }
}

fn detect_non_delegating_subagent_item_kind(
    it: &Value,
    seen_spawn_child_ids: &HashSet<String>,
) -> Option<(Option<String>, String)> {
    let raw_name = it.get("toolName").and_then(Value::as_str)?;
    let (srv, clean) = super::record::resolve_item_clean_tool_name(it);
    if is_non_delegating_subagent_tool(&clean) {
        return Some((srv, clean.to_ascii_lowercase()));
    }
    let has_subagent_shape = it.get("toolKind").and_then(Value::as_str) == Some("subagent")
        || it.get("subagentMeta").is_some();
    if !has_subagent_shape || super::record::is_spawn_subagent_item(it) {
        return None;
    }
    let raw_lower = raw_name.to_ascii_lowercase();
    let detail = it.get("detail").and_then(Value::as_str).unwrap_or("");
    let text = it.get("text").and_then(Value::as_str).unwrap_or("");
    let is_kite_dispatch = srv.as_deref() == Some("kite-dispatch")
        || raw_name.eq_ignore_ascii_case("call_mcp_tool")
        || raw_lower.contains("kite-dispatch")
        || raw_lower.contains("kite_dispatch")
        || detail.contains("kite-dispatch");
    if !is_kite_dispatch {
        return None;
    }
    let is_generic_title = it.get("title").and_then(Value::as_str) == Some("Subagent · Subagent")
        || (it.pointer("/subagentMeta/role").and_then(Value::as_str) == Some("Subagent")
            && it
                .get("title")
                .and_then(Value::as_str)
                .is_none_or(|t| t.is_empty() || t.starts_with("Subagent")));
    let lacks_workspace = it
        .pointer("/subagentMeta/workspaceMode")
        .and_then(Value::as_str)
        .is_none_or(|s| s.trim().is_empty());
    let lacks_started_thread = !text.contains("started thread:") && !detail.contains("started thread:");
    if !(is_generic_title && lacks_workspace && lacks_started_thread) {
        return None;
    }
    let ctid = it
        .pointer("/subagentMeta/childThreadId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let server = srv.or_else(|| Some("kite-dispatch".to_string()));
    match ctid {
        None => Some((server, "kite_subagent_wait".to_string())),
        Some(c) if seen_spawn_child_ids.contains(c) => {
            let has_send_hint = it
                .pointer("/subagentMeta/prompt")
                .and_then(Value::as_str)
                .is_some_and(|p| !p.trim().is_empty())
                || detail.contains("\"message\"")
                || detail.contains("\"task\"");
            let kind = if has_send_hint {
                "kite_subagent_send"
            } else {
                "kite_subagent_read"
            };
            Some((server, kind.to_string()))
        }
        Some(_) => None,
    }
}

pub(super) fn downgrade_non_delegating_subagent_items(
    thread: &mut Value,
) -> (HashSet<String>, Vec<Value>) {
    let mut removed_ids = HashSet::new();
    let mut downgraded_items = Vec::new();
    let mut spawn_sids = HashSet::new();
    if let Some(items) = thread.get("items").and_then(Value::as_array) {
        let mut seen_cids = HashSet::new();
        for it in items {
            if detect_non_delegating_subagent_item_kind(it, &seen_cids).is_none()
                && it.get("toolKind").and_then(Value::as_str) == Some("subagent")
            {
                if let Some(ctid) = it
                    .pointer("/subagentMeta/childThreadId")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    seen_cids.insert(ctid.to_string());
                    spawn_sids.insert(ctid.to_string());
                }
                if let Some(sid) = it
                    .pointer("/subagentMeta/subagentId")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    spawn_sids.insert(sid.to_string());
                }
            }
        }
    }
    let Some(items) = thread.get_mut("items").and_then(Value::as_array_mut) else {
        return (removed_ids, downgraded_items);
    };
    let mut seen_spawn_child_ids = HashSet::new();
    for it in items.iter_mut() {
        let Some((srv, clean)) = detect_non_delegating_subagent_item_kind(it, &seen_spawn_child_ids)
        else {
            if it.get("toolKind").and_then(Value::as_str) == Some("subagent") {
                if let Some(ctid) = it
                    .pointer("/subagentMeta/childThreadId")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    seen_spawn_child_ids.insert(ctid.to_string());
                }
            }
            continue;
        };
        let item_id = it
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if !item_id.is_empty() {
            removed_ids.insert(item_id.clone());
        }
        let is_send_msg = clean == "send_message";
        let is_kite_subagent_ctrl = matches!(
            clean.as_str(),
            "kite_subagent_wait" | "kite_subagent_read" | "kite_subagent_send"
        );
        let sid_opt = it
            .pointer("/subagentMeta/subagentId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let ctid_absent = it
            .pointer("/subagentMeta/childThreadId")
            .and_then(Value::as_str)
            .is_none_or(|s| s.trim().is_empty());
        if let Some(sid) = sid_opt {
            if is_send_msg {
                if sid == item_id {
                    removed_ids.insert(sid);
                }
            } else if is_kite_subagent_ctrl {
                if sid == item_id || (ctid_absent && !spawn_sids.contains(&sid)) {
                    removed_ids.insert(sid);
                }
            } else {
                removed_ids.insert(sid);
            }
        }
        if super::record::downgrade_non_delegating_item_in_place(it, &clean, srv.as_deref()) {
            downgraded_items.push(it.clone());
        }
    }
    (removed_ids, downgraded_items)
}

fn valid_provider_session_id(id: &str) -> Option<&str> {
    let clean = id.trim();
    if clean.is_empty()
        || !clean
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return None;
    }
    Some(clean)
}

pub fn antigravity_brain_logs_dir(provider_session_id: &str) -> Option<PathBuf> {
    let clean = valid_provider_session_id(provider_session_id)?;
    Some(
        user_home_dir()
            .join(".gemini")
            .join("antigravity-cli")
            .join("brain")
            .join(clean)
            .join(".system_generated")
            .join("logs"),
    )
}

fn upsert_discovered(
    map: &mut HashMap<String, DiscoveredAgySubagent>,
    order: &mut Vec<String>,
    entry: DiscoveredAgySubagent,
) {
    if let Some(existing) = map.get_mut(&entry.cid) {
        if existing.role == "Subagent" && entry.role != "Subagent" {
            existing.role = entry.role;
        }
        if existing.type_name.is_none() {
            existing.type_name = entry.type_name;
        }
        if existing.prompt.is_none() {
            existing.prompt = entry.prompt;
        }
        if existing.model.is_none() {
            existing.model = entry.model;
        }
        if existing.workspace_mode.is_none() {
            existing.workspace_mode = entry.workspace_mode;
        }
        if existing.transcript_uri.is_none() {
            existing.transcript_uri = entry.transcript_uri;
        }
        let existing_terminal =
            matches!(existing.status.as_str(), "completed" | "failed" | "killed");
        let incoming_terminal = matches!(entry.status.as_str(), "completed" | "failed" | "killed");
        if incoming_terminal || !existing_terminal {
            existing.status = entry.status;
        }
        if existing.created_at_ms <= 0 || (entry.created_at_ms > 0 && entry.created_at_ms < existing.created_at_ms) {
            existing.created_at_ms = entry.created_at_ms;
        }
    } else {
        order.push(entry.cid.clone());
        map.insert(entry.cid.clone(), entry);
    }
}

fn merge_manage_rows_into(
    rows: &[Value],
    default_created_at_ms: i64,
    pending: &mut VecDeque<PendingInvoke>,
    map: &mut HashMap<String, DiscoveredAgySubagent>,
    order: &mut Vec<String>,
) {
    for row in rows {
        let Some(cid) = row
            .get("conversationId")
            .or_else(|| row.get("conversation_id"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        let role = row
            .get("role")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("Subagent")
            .to_string();
        let type_name = row
            .get("type")
            .or_else(|| row.get("typeName"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let transcript_uri = row
            .get("transcript")
            .or_else(|| row.get("logAbsoluteUri"))
            .or_else(|| row.get("transcriptUri"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let status = normalize_agy_state(
            row.get("state")
                .or_else(|| row.get("status"))
                .and_then(Value::as_str)
                .unwrap_or("idle"),
        );

        let matched_idx = pending.iter().position(|p| {
            p.role.as_deref() == Some(role.as_str())
                || (type_name.is_some() && p.type_name == type_name)
        });
        let matched = matched_idx.and_then(|idx| pending.remove(idx));

        upsert_discovered(
            map,
            order,
            DiscoveredAgySubagent {
                cid: cid.to_string(),
                role,
                type_name: type_name.or_else(|| matched.as_ref().and_then(|m| m.type_name.clone())),
                prompt: matched.as_ref().and_then(|m| m.prompt.clone()),
                model: matched.as_ref().and_then(|m| m.model.clone()),
                workspace_mode: matched
                    .as_ref()
                    .and_then(|m| m.workspace_mode.clone()),
                status,
                transcript_uri,
                created_at_ms: matched
                    .as_ref()
                    .map(|m| m.created_at_ms)
                    .unwrap_or(default_created_at_ms),
            },
        );
    }
}

fn parse_antigravity_parent_transcript(
    logs_dir: &Path,
    map: &mut HashMap<String, DiscoveredAgySubagent>,
    order: &mut Vec<String>,
) {
    let full = logs_dir.join("transcript_full.jsonl");
    let compact = logs_dir.join("transcript.jsonl");
    let path = if full.is_file() {
        full
    } else if compact.is_file() {
        compact
    } else {
        return;
    };
    let Ok(content) = fs::read_to_string(&path) else {
        return;
    };

    let mut pending: VecDeque<PendingInvoke> = VecDeque::new();
    let mut pending_manage: usize = 0;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(step) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        let step_type = step
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_uppercase();
        let step_ts = parse_step_timestamp_ms(&step);

        if step_type == "PLANNER_RESPONSE" {
            if let Some(tool_calls) = step.get("tool_calls").and_then(Value::as_array) {
                for tc in tool_calls {
                    let raw_name = tc
                        .get("name")
                        .or_else(|| tc.get("tool_name"))
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    let (_, clean) = strip_mcp_prefix(raw_name, &Value::Null);
                    if clean == "manage_subagents" {
                        pending_manage += 1;
                        continue;
                    }
                    if clean != "invoke_subagent" {
                        continue;
                    }
                    let args = tc
                        .get("args")
                        .or_else(|| tc.get("arguments"))
                        .or_else(|| tc.get("parameters"))
                        .or_else(|| tc.get("input"))
                        .unwrap_or(&Value::Null);
                    pending.push_back(PendingInvoke {
                        role: unwrap_transcript_arg_str(
                            args.get("Role").or_else(|| args.get("role")),
                        ),
                        type_name: unwrap_transcript_arg_str(
                            args.get("TypeName").or_else(|| args.get("typeName")),
                        ),
                        prompt: unwrap_transcript_arg_str(
                            args.get("Prompt").or_else(|| args.get("prompt")),
                        ),
                        model: unwrap_transcript_arg_str(
                            args.get("Model").or_else(|| args.get("model")),
                        ),
                        workspace_mode: unwrap_transcript_arg_str(
                            args.get("Workspace").or_else(|| args.get("workspace")),
                        ),
                        created_at_ms: step_ts,
                    });
                }
            }
            continue;
        }

        // Only inspect actual tool output frames so quoted JSON inside shell logs,
        // system messages, or user prompts never invents phantom subagents.
        if !matches!(step_type.as_str(), "GENERIC" | "TOOL_RESPONSE" | "") {
            continue;
        }

        if step_type == "GENERIC" {
            let status = step.get("status").and_then(Value::as_str).unwrap_or("");
            if status.eq_ignore_ascii_case("ERROR") || status.eq_ignore_ascii_case("FAILED") {
                let msg = step
                    .get("error")
                    .or_else(|| step.get("content"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_ascii_lowercase();
                if msg.contains("invoke_subagent")
                    && (msg.contains("pre-tool hook") || msg.contains("is blocked"))
                {
                    let _ = pending.pop_front();
                    continue;
                }
            }
        }

        if let Some(body) = step.get("content").and_then(Value::as_str) {
            if body.contains("conversationId") {
                if pending_manage > 0 || step_type == "TOOL_RESPONSE" {
                    if let Some(arr) = parse_output_json_array(Some(body)) {
                        pending_manage = pending_manage.saturating_sub(1);
                        merge_manage_rows_into(&arr, step_ts, &mut pending, map, order);
                        continue;
                    }
                }
                let is_invoke_response =
                    step_type == "TOOL_RESPONSE" || body.contains("Created the following subagent");
                if is_invoke_response && !pending.is_empty() {
                    if let Some(obj) = parse_output_json(Some(body)) {
                        if let Some(cid) = obj
                            .get("conversationId")
                            .or_else(|| obj.get("conversation_id"))
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                        {
                            let matched = pending.pop_front();
                        let transcript_uri = obj
                            .get("logAbsoluteUri")
                            .or_else(|| obj.get("log_absolute_uri"))
                            .or_else(|| obj.get("transcriptUri"))
                            .or_else(|| obj.get("transcript"))
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .map(str::to_string);
                            let failed = crate::acp::response_indicates_failure(
                                "",
                                None,
                                Some(&obj),
                                Some(body),
                            );
                            upsert_discovered(
                                map,
                                order,
                                DiscoveredAgySubagent {
                                    cid: cid.to_string(),
                                    role: matched
                                        .as_ref()
                                        .and_then(|m| m.role.clone())
                                        .unwrap_or_else(|| "Subagent".to_string()),
                                    type_name: matched.as_ref().and_then(|m| m.type_name.clone()),
                                    prompt: matched.as_ref().and_then(|m| m.prompt.clone()),
                                    model: matched.as_ref().and_then(|m| m.model.clone()),
                                    workspace_mode: matched
                                        .as_ref()
                                        .and_then(|m| m.workspace_mode.clone()),
                                    status: if failed {
                                        "failed".to_string()
                                    } else {
                                        "running".to_string()
                                    },
                                    transcript_uri,
                                    created_at_ms: matched
                                        .as_ref()
                                        .map(|m| m.created_at_ms)
                                        .unwrap_or(step_ts),
                                },
                            );
                        }
                    }
                }
            }
        }
    }
}

fn collect_manage_outputs_from_thread_items(
    thread: &Value,
    map: &mut HashMap<String, DiscoveredAgySubagent>,
    order: &mut Vec<String>,
) {
    let Some(items) = thread.get("items").and_then(Value::as_array) else {
        return;
    };
    let mut empty_pending = VecDeque::new();
    for it in items {
        let Some(raw_name) = it.get("toolName").and_then(Value::as_str) else {
            continue;
        };
        let (_, clean) = strip_mcp_prefix(raw_name, &Value::Null);
        if clean != "manage_subagents" {
            continue;
        }
        let text = it.get("text").and_then(Value::as_str);
        if let Some(rows) = parse_output_json_array(text) {
            let item_ts = it
                .get("createdAtUnixMs")
                .and_then(Value::as_i64)
                .unwrap_or_else(now_ms);
            merge_manage_rows_into(&rows, item_ts, &mut empty_pending, map, order);
        }
    }
}

fn insert_subagent_item_chronologically(items: &mut Vec<Value>, item: Value) {
    let created = item
        .get("createdAtUnixMs")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let last_user = items
        .iter()
        .rposition(|it| it.get("kind").and_then(Value::as_str) == Some("user"))
        .map(|idx| idx + 1)
        .unwrap_or(0);
    let trailing_asst = items[last_user..]
        .iter()
        .position(|it| {
            it.get("kind").and_then(Value::as_str) == Some("assistant")
                && it.get("streaming").and_then(Value::as_bool) != Some(true)
        })
        .map(|rel| last_user + rel);
    let ts_pos = (created > 0)
        .then(|| {
            items[last_user..]
                .iter()
                .position(|it| {
                    it.get("createdAtUnixMs")
                        .and_then(Value::as_i64)
                        .is_some_and(|t| t > created)
                })
                .map(|rel| last_user + rel)
        })
        .flatten();

    let insert_at = match (ts_pos, trailing_asst) {
        (Some(a), Some(b)) => a.min(b),
        (Some(a), None) => a,
        (None, Some(b)) => b,
        (None, None) => items.len(),
    };
    items.insert(insert_at, item);
}

fn collect_resolved_bg_tasks_from_logs_dir(logs_dir: &Path) -> HashMap<String, String> {
    let mut resolved = HashMap::new();
    let full = logs_dir.join("transcript_full.jsonl");
    let compact = logs_dir.join("transcript.jsonl");
    let path = if full.is_file() {
        full
    } else if compact.is_file() {
        compact
    } else {
        return resolved;
    };
    let Ok(raw) = fs::read_to_string(path) else {
        return resolved;
    };
    for line in raw.lines() {
        let trimmed = line.trim();
        if !trimmed.contains("SYSTEM_MESSAGE") {
            continue;
        }
        let Ok(step) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        if step.get("type").and_then(Value::as_str) != Some("SYSTEM_MESSAGE") {
            continue;
        }
        let Some(content) = step.get("content").and_then(Value::as_str) else {
            continue;
        };
        if let Some(sender) =
            crate::chat::runtime::antigravity_fallback::extract_system_message_sender(content)
        {
            let cleaned =
                crate::chat::runtime::antigravity_fallback::clean_background_task_system_message_output(content);
            if !cleaned.is_empty() {
                resolved.insert(sender, cleaned);
            }
        }
    }
    resolved
}

fn reconcile_antigravity_background_tasks_in_thread(
    thread: &mut Value,
    custom_logs_dir: Option<&Path>,
) -> Vec<Value> {
    let mut updated_items = Vec::new();
    let Some(items) = thread.get_mut("items").and_then(Value::as_array_mut) else {
        return updated_items;
    };
    let mut resolved_by_dir: HashMap<PathBuf, HashMap<String, String>> = HashMap::new();
    for it in items.iter_mut() {
        if it.get("kind").and_then(Value::as_str) != Some("tool") {
            continue;
        }
        if it.get("toolKind").and_then(Value::as_str) == Some("subagent") {
            continue;
        }
        let Some(text) = it.get("text").and_then(Value::as_str).map(str::to_string) else {
            continue;
        };
        let trimmed = text.trim();
        if trimmed.starts_with("The following is a <SYSTEM_MESSAGE>")
            || (trimmed.starts_with("<SYSTEM_MESSAGE>") && trimmed.contains("[Message]"))
        {
            let cleaned =
                crate::chat::runtime::antigravity_fallback::clean_background_task_system_message_output(trimmed);
            if !cleaned.is_empty() && cleaned != text {
                it["text"] = json!(cleaned);
                if it.get("streaming").and_then(Value::as_bool) == Some(true) {
                    it["streaming"] = json!(false);
                }
                if it.get("status").and_then(Value::as_str) == Some("running") {
                    it["status"] = json!("completed");
                }
                updated_items.push(it.clone());
                continue;
            }
        }
        if let Some(task_id) =
            crate::chat::runtime::antigravity_fallback::extract_background_task_id(&text)
        {
            let task_cid = task_id.split('/').next().unwrap_or("");
            let candidate_dir = custom_logs_dir
                .map(Path::to_path_buf)
                .or_else(|| antigravity_brain_logs_dir(task_cid));
            if let Some(dir) = candidate_dir {
                let map = resolved_by_dir
                    .entry(dir.clone())
                    .or_insert_with(|| collect_resolved_bg_tasks_from_logs_dir(&dir));
                if let Some(cleaned_out) = map.get(&task_id) {
                    it["text"] = json!(cleaned_out);
                    it["status"] = json!("completed");
                    it["streaming"] = json!(false);
                    updated_items.push(it.clone());
                }
            }
        }
    }
    updated_items
}

pub fn reconcile_antigravity_subagents_in_thread(
    thread: &mut Value,
    custom_logs_dir: Option<&Path>,
    include_parent_transcript: bool,
) -> AntigravityReconcileOutcome {
    let mut transcript_map: HashMap<String, DiscoveredAgySubagent> = HashMap::new();
    let mut transcript_order: Vec<String> = Vec::new();
    let effective_dir = custom_logs_dir.map(Path::to_path_buf).or_else(|| {
        thread
            .get("providerSessionId")
            .and_then(Value::as_str)
            .and_then(antigravity_brain_logs_dir)
    });
    if include_parent_transcript {
        if let Some(ref dir) = effective_dir {
            parse_antigravity_parent_transcript(dir, &mut transcript_map, &mut transcript_order);
        }
    }
    let bg_updated = reconcile_antigravity_background_tasks_in_thread(thread, effective_dir.as_deref());
    let mut outcome =
        reconcile_antigravity_subagents_with_discovered(thread, transcript_map, transcript_order);
    if !bg_updated.is_empty() {
        outcome.changed = true;
        outcome.items_to_emit.extend(bg_updated);
    }
    outcome
}

pub(super) fn collect_live_subagent_ids(thread: &Value) -> (HashSet<String>, HashSet<String>) {
    let mut item_ids = HashSet::new();
    let mut meta_ids = HashSet::new();
    if let Some(items) = thread.get("items").and_then(Value::as_array) {
        for it in items {
            if it.get("toolKind").and_then(Value::as_str) != Some("subagent") {
                continue;
            }
            if let Some(id) = it.get("id").and_then(Value::as_str) {
                if !id.is_empty() {
                    item_ids.insert(id.to_string());
                }
            }
            for ptr in ["/subagentMeta/subagentId", "/subagentMeta/childThreadId"] {
                if let Some(sid) = it.pointer(ptr).and_then(Value::as_str) {
                    if !sid.is_empty() {
                        meta_ids.insert(sid.to_string());
                    }
                }
            }
        }
    }
    (item_ids, meta_ids)
}

pub(super) fn is_orphaned_generic_placeholder_run(
    run: &Value,
    live_item_ids: &HashSet<String>,
    live_meta_ids: &HashSet<String>,
) -> bool {
    let p_call = run
        .get("parentToolCallId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let sid = run.get("subagentId").and_then(Value::as_str).unwrap_or("");
    if (!p_call.is_empty() && live_item_ids.contains(p_call))
        || (!sid.is_empty() && live_meta_ids.contains(sid))
    {
        return false;
    }
    let is_terminal = matches!(
        run.get("status").and_then(Value::as_str),
        Some("completed" | "failed" | "killed")
    );
    is_terminal
        && run.get("role").and_then(Value::as_str) == Some("Subagent")
        && run.get("model").is_none_or(Value::is_null)
        && run.get("stepCount").and_then(Value::as_u64).unwrap_or(0) == 0
        && run
            .get("transcriptUri")
            .and_then(Value::as_str)
            .is_none_or(|s| s.trim().is_empty())
        && run
            .get("childThreadId")
            .and_then(Value::as_str)
            .is_none_or(|s| s.trim().is_empty())
        && run
            .get("items")
            .and_then(Value::as_array)
            .is_none_or(Vec::is_empty)
}

pub(super) fn prune_non_delegating_or_orphaned_placeholder_runs(
    thread: &mut Value,
    removed_ids: &HashSet<String>,
) -> bool {
    let (live_item_ids, live_meta_ids) = collect_live_subagent_ids(thread);
    let mut surviving_call_by_sid: HashMap<String, String> = HashMap::new();
    if let Some(items) = thread.get("items").and_then(Value::as_array) {
        for it in items {
            if it.get("toolKind").and_then(Value::as_str) != Some("subagent") {
                continue;
            }
            let Some(id) = it.get("id").and_then(Value::as_str).filter(|s| !s.is_empty()) else {
                continue;
            };
            let is_synthetic = id.starts_with("dispatch-subagent-") || id.starts_with("sub_");
            for key_ptr in ["/subagentMeta/subagentId", "/subagentMeta/childThreadId"] {
                if let Some(key) = it
                    .pointer(key_ptr)
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                {
                    let replace = surviving_call_by_sid.get(key).is_none_or(|prev| {
                        (prev.starts_with("dispatch-subagent-") || prev.starts_with("sub_"))
                            && !is_synthetic
                    });
                    if replace {
                        surviving_call_by_sid.insert(key.to_string(), id.to_string());
                    }
                }
            }
        }
    }
    let Some(runs) = thread.get_mut("subagentRuns").and_then(Value::as_array_mut) else {
        return false;
    };
    let mut mutated = false;
    let before = runs.len();
    runs.retain_mut(|r| {
        let p_call = r
            .get("parentToolCallId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let sid = r
            .get("subagentId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let ctid = r
            .get("childThreadId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if !removed_ids.is_empty() {
            if removed_ids.contains(&sid) {
                return false;
            }
            if removed_ids.contains(&p_call) {
                let anchor_key = if !sid.is_empty() && live_meta_ids.contains(&sid) {
                    Some(sid.as_str())
                } else if !ctid.is_empty() && live_meta_ids.contains(&ctid) {
                    Some(ctid.as_str())
                } else {
                    None
                };
                if let Some(key) = anchor_key.filter(|k| *k != p_call.as_str()) {
                    let replacement = surviving_call_by_sid
                        .get(key)
                        .cloned()
                        .unwrap_or_else(|| format!("sub_{key}"));
                    r["parentToolCallId"] = json!(replacement);
                    mutated = true;
                } else {
                    return false;
                }
            }
        }
        !is_orphaned_generic_placeholder_run(r, &live_item_ids, &live_meta_ids)
    });
    runs.len() != before || mutated
}

/// True when the child's own transcript ends with a delivered final response:
/// a completed `PLANNER_RESPONSE` with text and no pending tool calls.
pub(crate) fn child_transcript_ended_with_final_response(uri: Option<&str>) -> bool {
    use std::io::{Read, Seek, SeekFrom};

    const TAIL_BYTES: u64 = 256 * 1024;
    let Some(path) = uri.and_then(resolve_local_transcript_path) else {
        return false;
    };
    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    let Ok(len) = file.metadata().map(|m| m.len()) else {
        return false;
    };
    if len == 0 {
        return false;
    }
    let start = len.saturating_sub(TAIL_BYTES);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return false;
    }
    let mut buf = Vec::with_capacity((len - start) as usize);
    if file.read_to_end(&mut buf).is_err() {
        return false;
    }
    let content = String::from_utf8_lossy(&buf);
    let Some(last_line) = content.lines().rev().find(|l| !l.trim().is_empty()) else {
        return false;
    };
    let Ok(step) = serde_json::from_str::<Value>(last_line) else {
        return false;
    };
    let is_planner_response = step.get("type").and_then(Value::as_str) == Some("PLANNER_RESPONSE");
    let is_done = step
        .get("status")
        .and_then(Value::as_str)
        .map_or(true, |s| s.eq_ignore_ascii_case("DONE"));
    let has_text = step
        .get("content")
        .and_then(Value::as_str)
        .is_some_and(|c| !c.trim().is_empty());
    let has_pending_calls = step
        .get("tool_calls")
        .and_then(Value::as_array)
        .is_some_and(|calls| !calls.is_empty());
    is_planner_response && is_done && has_text && !has_pending_calls
}

fn is_terminal_subagent_status(status: Option<&str>) -> bool {
    matches!(status, Some("completed" | "failed" | "killed"))
}

fn should_update_discovered_status(current: Option<&str>, discovered: &str) -> bool {
    if current == Some(discovered) || current == Some("killed") {
        return false;
    }
    !(is_terminal_subagent_status(current) && matches!(discovered, "running" | "waiting"))
}

fn existing_terminal_subagent_status(thread: &Value, cid: &str) -> Option<String> {
    if let Some(runs) = thread.get("subagentRuns").and_then(Value::as_array) {
        for r in runs {
            if r.get("subagentId").and_then(Value::as_str) == Some(cid) {
                let s = r.get("status").and_then(Value::as_str);
                if is_terminal_subagent_status(s) {
                    return s.map(str::to_string);
                }
            }
        }
    }
    if let Some(items) = thread.get("items").and_then(Value::as_array) {
        for it in items {
            if it.pointer("/subagentMeta/subagentId").and_then(Value::as_str) == Some(cid) {
                let s = it.pointer("/subagentMeta/status").and_then(Value::as_str);
                if is_terminal_subagent_status(s) {
                    return s.map(str::to_string);
                }
            }
        }
    }
    None
}

fn reconcile_antigravity_subagents_with_discovered(
    thread: &mut Value,
    mut transcript_map: HashMap<String, DiscoveredAgySubagent>,
    transcript_order: Vec<String>,
) -> AntigravityReconcileOutcome {
    let mut outcome = AntigravityReconcileOutcome::default();
    let provider = thread
        .get("provider")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let parent_model = thread
        .get("model")
        .and_then(Value::as_str)
        .map(str::to_string);
    let parent_thread_id = thread
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let thread_status = thread
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("idle");
    let parent_active = matches!(thread_status, "running" | "waiting");
    let parent_failed = thread_status == "error";

    let (removed_ids, downgraded_items) = downgrade_non_delegating_subagent_items(thread);
    if !downgraded_items.is_empty() {
        outcome.changed = true;
        outcome.items_to_emit.extend(downgraded_items);
    }
    let (blocked_downgraded, blocked_runs) = downgrade_unspawned_failed_native_invokes(thread);
    if !blocked_downgraded.is_empty() || !blocked_runs.is_empty() {
        outcome.changed = true;
        outcome.items_to_emit.extend(blocked_downgraded);
        outcome.removed_runs.extend(blocked_runs);
    }
    if prune_non_delegating_or_orphaned_placeholder_runs(thread, &removed_ids) {
        outcome.changed = true;
    }
    apply_drop_superseded(thread, &mut outcome);

    let mut map: HashMap<String, DiscoveredAgySubagent> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    collect_manage_outputs_from_thread_items(thread, &mut map, &mut order);
    for cid in transcript_order {
        if let Some(entry) = transcript_map.remove(&cid) {
            upsert_discovered(&mut map, &mut order, entry);
        }
    }

    // Prune phantom `sub_<cid>` cards (e.g. `sub_sub-conv-42`) that have 0 steps, generic
    // "Subagent" role, no childThreadId, are not in `map`, and have no existing local transcript file.
    if prune_phantom_unbacked_discovered_cards(thread, &map) {
        outcome.changed = true;
    }
    apply_drop_superseded(thread, &mut outcome);

    if thread.get("items").and_then(Value::as_array).is_none() {
        thread["items"] = Value::Array(Vec::new());
    }
    if thread.get("subagentRuns").and_then(Value::as_array).is_none() {
        thread["subagentRuns"] = Value::Array(Vec::new());
    }

    const BOGUS_INTERRUPTED_TEXT: &str =
        "Interrupted before completion; retried in subsequent steps.";
    let now = now_ms();
    for cid in order {
        let Some(mut rec) = map.remove(&cid) else {
            continue;
        };
        if matches!(rec.status.as_str(), "running" | "waiting") {
            let child_ended =
                child_transcript_ended_with_final_response(rec.transcript_uri.as_deref());
            let existing_terminal = existing_terminal_subagent_status(thread, &rec.cid);
            if child_ended && existing_terminal.as_deref() != Some("killed") {
                rec.status = "completed".to_string();
            } else if let Some(term) = existing_terminal {
                rec.status = term;
            } else if !parent_active {
                // A parent turn that errored (for example a dropped network call after the
                // child already answered) must not retroactively fail a child whose own
                // transcript ends with a delivered final response.
                rec.status = if parent_failed && !child_ended {
                    "failed".to_string()
                } else {
                    "completed".to_string()
                };
            }
        }
        let effective_model =
            resolve_effective_subagent_model(rec.model.as_deref(), parent_model.as_deref());
        let item_status = match rec.status.as_str() {
            "running" | "waiting" => "running",
            "failed" => "failed",
            _ => "completed",
        };
        let is_running = rec.status == "running" || rec.status == "waiting";

        // 1. Bind or synthesize timeline item
        let item_call_id = {
            let items = thread["items"].as_array_mut().unwrap();
            let existing_idx = items
                .iter()
                .position(|it| {
                    it.get("id").and_then(Value::as_str) == Some(&format!("sub_{}", rec.cid))
                        || it.pointer("/subagentMeta/subagentId").and_then(Value::as_str)
                            == Some(rec.cid.as_str())
                })
                .or_else(|| {
                    items.iter().position(|it| {
                        it.get("toolName").and_then(Value::as_str).is_some_and(|n| {
                            strip_mcp_prefix(n, &Value::Null).1 == "invoke_subagent"
                        })
                            && it.pointer("/subagentMeta/role").and_then(Value::as_str)
                                == Some(rec.role.as_str())
                            && it
                                .pointer("/subagentMeta/subagentId")
                                .and_then(Value::as_str)
                                == it.get("id").and_then(Value::as_str)
                    })
                })
                // The streamed call has no role, so a generic card is the same delegation.
                .or_else(|| find_unbound_placeholder_index(items, rec.prompt.as_deref()));

            if let Some(idx) = existing_idx {
                let it = &mut items[idx];
                let existing_id = it
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let mut touched_item = false;
                if it.get("toolKind").and_then(Value::as_str) != Some("subagent") {
                    it["toolKind"] = json!("subagent");
                    touched_item = true;
                }
                let mut updated_title: Option<String> = None;
                let mut updated_detail: Option<String> = None;
                let mut updated_terminal_status = false;
                if let Some(meta_obj) = it.get_mut("subagentMeta").and_then(Value::as_object_mut) {
                    let was_unbound_placeholder = meta_obj
                        .get("subagentId")
                        .and_then(Value::as_str)
                        == Some(existing_id.as_str())
                        && meta_obj
                            .get("stepCount")
                            .and_then(Value::as_u64)
                            .unwrap_or(0)
                            == 0
                        && meta_obj
                            .get("transcriptUri")
                            .and_then(Value::as_str)
                            .is_none_or(|s| s.trim().is_empty())
                        && meta_obj
                            .get("childThreadId")
                            .and_then(Value::as_str)
                            .is_none_or(|s| s.trim().is_empty());
                    if meta_obj.get("subagentId").and_then(Value::as_str) != Some(rec.cid.as_str())
                    {
                        meta_obj.insert("subagentId".into(), json!(rec.cid));
                        touched_item = true;
                    }
                    if meta_obj.get("role").and_then(Value::as_str) == Some("Subagent")
                        && rec.role != "Subagent"
                    {
                        meta_obj.insert("role".into(), json!(rec.role));
                        updated_title = Some(format!("Subagent · {}", rec.role));
                        touched_item = true;
                    }
                    if meta_obj.get("model").is_none_or(Value::is_null)
                        || meta_obj
                            .get("model")
                            .and_then(Value::as_str)
                            .is_some_and(|m| m.eq_ignore_ascii_case("inherit"))
                    {
                        if let Some(ref m) = effective_model {
                            meta_obj.insert("model".into(), json!(m));
                            touched_item = true;
                        }
                    }
                    if meta_obj.get("typeName").is_none_or(Value::is_null) {
                        if let Some(ref tn) = rec.type_name {
                            meta_obj.insert("typeName".into(), json!(tn));
                            touched_item = true;
                        }
                    }
                    if meta_obj.get("prompt").is_none_or(Value::is_null) {
                        if let Some(ref pr) = rec.prompt {
                            meta_obj.insert("prompt".into(), json!(pr));
                            updated_detail = Some(pr.clone());
                            touched_item = true;
                        }
                    }
                    if meta_obj.get("transcriptUri").is_none_or(Value::is_null) {
                        if let Some(ref uri) = rec.transcript_uri {
                            meta_obj.insert("transcriptUri".into(), json!(uri));
                            touched_item = true;
                        }
                    }
                    let meta_status = meta_obj.get("status").and_then(Value::as_str);
                    let allow_adopt_live =
                        was_unbound_placeholder && is_running && meta_status == Some("completed");
                    if allow_adopt_live || should_update_discovered_status(meta_status, &rec.status)
                    {
                        meta_obj.insert("status".into(), json!(rec.status));
                        updated_terminal_status = true;
                        touched_item = true;
                    }
                }
                if let Some(title) = updated_title {
                    it["title"] = json!(title);
                }
                if let Some(detail) = updated_detail {
                    it["detail"] = json!(detail);
                }
                if updated_terminal_status {
                    it["status"] = json!(item_status);
                    it["streaming"] = json!(is_running);
                } else if !is_running
                    && (it.get("streaming").and_then(Value::as_bool) == Some(true)
                        || it.get("status").and_then(Value::as_str) == Some("running")
                        || (item_status == "completed"
                            && it.get("status").and_then(Value::as_str) == Some("failed")
                            && it.get("text").and_then(Value::as_str)
                                == Some(BOGUS_INTERRUPTED_TEXT)))
                {
                    it["status"] = json!(item_status);
                    it["streaming"] = json!(false);
                    touched_item = true;
                }
                if item_status == "completed"
                    && it.get("text").and_then(Value::as_str) == Some(BOGUS_INTERRUPTED_TEXT)
                {
                    it["text"] = json!("");
                    it["exitCode"] = Value::Null;
                    touched_item = true;
                }
                if touched_item {
                    outcome.changed = true;
                    outcome.items_to_emit.push(it.clone());
                }
                existing_id
            } else {
                let item_id = format!("sub_{}", rec.cid);
                let meta = SubagentMeta {
                    subagent_id: rec.cid.clone(),
                    role: rec.role.clone(),
                    type_name: rec.type_name.clone(),
                    provider: (!provider.is_empty()).then(|| provider.clone()),
                    model: effective_model.clone(),
                    workspace_mode: rec.workspace_mode.clone(),
                    prompt: rec.prompt.clone(),
                    status: rec.status.clone(),
                    transcript_uri: rec.transcript_uri.clone(),
                    child_thread_id: None,
                    latest_activity: None,
                    step_count: 0,
                };
                let mut item = json!({
                    "id": item_id,
                    "kind": "tool",
                    "toolKind": "subagent",
                    "toolName": "invoke_subagent",
                    "title": format!("Subagent · {}", rec.role),
                    "detail": rec.prompt,
                    "text": "",
                    "status": item_status,
                    "streaming": is_running,
                    "exitCode": if item_status == "failed" { json!(1) } else { Value::Null },
                    "createdAtUnixMs": rec.created_at_ms,
                    "attachments": [],
                });
                if let Ok(mval) = serde_json::to_value(meta) {
                    item["subagentMeta"] = mval;
                }
                insert_subagent_item_chronologically(items, item.clone());
                outcome.changed = true;
                outcome.items_to_emit.push(item);
                item_id
            }
        };

        // 2. Upsert SubagentRun
        let runs = thread["subagentRuns"].as_array_mut().unwrap();
        if let Some(run) = runs.iter_mut().find(|r| {
            r.get("subagentId").and_then(Value::as_str) == Some(rec.cid.as_str())
                || r.get("parentToolCallId").and_then(Value::as_str) == Some(item_call_id.as_str())
        }) {
            let run_was_unbound_placeholder = run.get("subagentId").and_then(Value::as_str)
                == Some(item_call_id.as_str())
                && run
                    .get("transcriptUri")
                    .and_then(Value::as_str)
                    .is_none_or(|s| s.trim().is_empty())
                && run
                    .get("childThreadId")
                    .and_then(Value::as_str)
                    .is_none_or(|s| s.trim().is_empty())
                && run.get("stepCount").and_then(Value::as_u64).unwrap_or(0) == 0;
            let mut touched_run = false;
            if run.get("subagentId").and_then(Value::as_str) != Some(rec.cid.as_str()) {
                run["subagentId"] = json!(rec.cid);
                touched_run = true;
            }
            if run.get("role").and_then(Value::as_str) == Some("Subagent") && rec.role != "Subagent"
            {
                run["role"] = json!(rec.role);
                touched_run = true;
            }
            if run.get("model").is_none_or(Value::is_null)
                || run
                    .get("model")
                    .and_then(Value::as_str)
                    .is_some_and(|m| m.eq_ignore_ascii_case("inherit"))
            {
                if let Some(ref m) = effective_model {
                    run["model"] = json!(m);
                    touched_run = true;
                }
            }
            if run.get("provider").is_none_or(Value::is_null) && !provider.is_empty() {
                run["provider"] = json!(provider);
                touched_run = true;
            }
            if run.get("typeName").is_none_or(Value::is_null) {
                if let Some(ref tn) = rec.type_name {
                    run["typeName"] = json!(tn);
                    touched_run = true;
                }
            }
            if run.get("workspaceMode").is_none_or(Value::is_null) {
                if let Some(ref w) = rec.workspace_mode {
                    run["workspaceMode"] = json!(w);
                    touched_run = true;
                }
            }
            if run.get("prompt").is_none_or(Value::is_null) {
                if let Some(ref p) = rec.prompt {
                    run["prompt"] = json!(p);
                    touched_run = true;
                }
            }
            if run.get("transcriptUri").is_none_or(Value::is_null) {
                if let Some(ref uri) = rec.transcript_uri {
                    run["transcriptUri"] = json!(uri);
                    touched_run = true;
                }
            }
            let run_status = run.get("status").and_then(Value::as_str);
            let allow_run_adopt_live =
                run_was_unbound_placeholder && is_running && run_status == Some("completed");
            if allow_run_adopt_live || should_update_discovered_status(run_status, &rec.status) {
                run["status"] = json!(rec.status);
                if is_running {
                    if run.get("completedAtUnixMs").is_some_and(|v| !v.is_null()) {
                        run["completedAtUnixMs"] = Value::Null;
                    }
                } else if run.get("completedAtUnixMs").is_none_or(Value::is_null) {
                    run["completedAtUnixMs"] = json!(now);
                }
                touched_run = true;
            }
            let has_items = run
                .get("items")
                .and_then(Value::as_array)
                .is_some_and(|a| !a.is_empty());
            if !has_items || is_running {
                if let Some(uri) = run
                    .get("transcriptUri")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                {
                    outcome.uris_to_sync.push((rec.cid.clone(), uri, is_running));
                }
            }
            if touched_run {
                run["updatedAtUnixMs"] = json!(now);
                outcome.changed = true;
                outcome.runs_to_emit.push(run.clone());
            }
        } else {
            let created = SubagentRun {
                subagent_id: rec.cid.clone(),
                parent_thread_id: parent_thread_id.clone(),
                parent_tool_call_id: item_call_id,
                role: rec.role,
                swarm_member_name: None,
                type_name: rec.type_name,
                provider: (!provider.is_empty()).then(|| provider.clone()),
                model: effective_model,
                workspace_mode: rec.workspace_mode,
                prompt: rec.prompt,
                status: rec.status,
                transcript_uri: rec.transcript_uri.clone(),
                child_thread_id: None,
                latest_activity: None,
                step_count: 0,
                items: Vec::new(),
                started_at_unix_ms: rec.created_at_ms,
                updated_at_unix_ms: now,
                completed_at_unix_ms: (!is_running).then_some(now),
            };
            if let Ok(val) = serde_json::to_value(created) {
                runs.push(val.clone());
                outcome.changed = true;
                outcome.runs_to_emit.push(val);
            }
            if let Some(uri) = rec.transcript_uri {
                outcome.uris_to_sync.push((rec.cid, uri, is_running));
            }
        }
    }

    apply_drop_superseded(thread, &mut outcome);

    reconcile_existing_completed_subagent_transcripts(thread, now, &mut outcome);

    if !outcome.removed_item_ids.is_empty() {
        let removed_set: HashSet<&str> =
            outcome.removed_item_ids.iter().map(String::as_str).collect();
        outcome.items_to_emit.retain(|it| {
            it.get("id")
                .and_then(Value::as_str)
                .is_none_or(|id| !removed_set.contains(id))
        });
    }

    outcome
}

fn is_phantom_unbacked_subagent_item_or_run(
    id_or_call: &str,
    sid: &str,
    role: &str,
    steps: u64,
    uri: &str,
    child_tid: &str,
    discovered_map: &HashMap<String, DiscoveredAgySubagent>,
) -> bool {
    if !id_or_call.starts_with("sub_")
        || role != "Subagent"
        || steps > 0
        || !child_tid.trim().is_empty()
        || (!sid.is_empty() && discovered_map.contains_key(sid))
    {
        return false;
    }
    uri.trim().is_empty()
        || !resolve_local_transcript_path(uri).is_some_and(|p| p.is_file())
}

fn prune_phantom_unbacked_discovered_cards(
    thread: &mut Value,
    discovered_map: &HashMap<String, DiscoveredAgySubagent>,
) -> bool {
    let mut phantom_ids: HashSet<String> = HashSet::new();
    if let Some(items) = thread.get("items").and_then(Value::as_array) {
        for it in items {
            if it.get("toolKind").and_then(Value::as_str) != Some("subagent") {
                continue;
            }
            let id = it.get("id").and_then(Value::as_str).unwrap_or("");
            let sid = it
                .pointer("/subagentMeta/subagentId")
                .and_then(Value::as_str)
                .unwrap_or("");
            let role = it
                .pointer("/subagentMeta/role")
                .and_then(Value::as_str)
                .unwrap_or("");
            let steps = it
                .pointer("/subagentMeta/stepCount")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let uri = it
                .pointer("/subagentMeta/transcriptUri")
                .and_then(Value::as_str)
                .unwrap_or("");
            let ctid = it
                .pointer("/subagentMeta/childThreadId")
                .and_then(Value::as_str)
                .unwrap_or("");
            if is_phantom_unbacked_subagent_item_or_run(
                id,
                sid,
                role,
                steps,
                uri,
                ctid,
                discovered_map,
            ) {
                phantom_ids.insert(id.to_string());
                if !sid.is_empty() {
                    phantom_ids.insert(sid.to_string());
                }
            }
        }
    }
    if let Some(runs) = thread.get("subagentRuns").and_then(Value::as_array) {
        for r in runs {
            let ptc = r
                .get("parentToolCallId")
                .and_then(Value::as_str)
                .unwrap_or("");
            let sid = r.get("subagentId").and_then(Value::as_str).unwrap_or("");
            let role = r.get("role").and_then(Value::as_str).unwrap_or("");
            let steps = r.get("stepCount").and_then(Value::as_u64).unwrap_or(0);
            let uri = r.get("transcriptUri").and_then(Value::as_str).unwrap_or("");
            let ctid = r.get("childThreadId").and_then(Value::as_str).unwrap_or("");
            let has_items = r
                .get("items")
                .and_then(Value::as_array)
                .is_some_and(|a| !a.is_empty());
            if !has_items
                && is_phantom_unbacked_subagent_item_or_run(
                    ptc,
                    sid,
                    role,
                    steps,
                    uri,
                    ctid,
                    discovered_map,
                )
            {
                if !ptc.is_empty() {
                    phantom_ids.insert(ptc.to_string());
                }
                if !sid.is_empty() {
                    phantom_ids.insert(sid.to_string());
                }
            }
        }
    }
    if phantom_ids.is_empty() {
        return false;
    }
    if let Some(items) = thread.get_mut("items").and_then(Value::as_array_mut) {
        items.retain(|it| {
            let id = it.get("id").and_then(Value::as_str).unwrap_or("");
            let sid = it
                .pointer("/subagentMeta/subagentId")
                .and_then(Value::as_str)
                .unwrap_or("");
            !phantom_ids.contains(id) && (sid.is_empty() || !phantom_ids.contains(sid))
        });
    }
    if let Some(runs) = thread.get_mut("subagentRuns").and_then(Value::as_array_mut) {
        runs.retain(|r| {
            let sid = r.get("subagentId").and_then(Value::as_str).unwrap_or("");
            let ptc = r
                .get("parentToolCallId")
                .and_then(Value::as_str)
                .unwrap_or("");
            !phantom_ids.contains(sid) && (ptc.is_empty() || !phantom_ids.contains(ptc))
        });
    }
    true
}

fn probe_subagent_transcript_uri(sid: &str) -> Option<String> {
    let logs_dir = antigravity_brain_logs_dir(sid)?;
    for candidate in ["transcript_full.jsonl", "transcript.jsonl"] {
        let p = logs_dir.join(candidate);
        if p.is_file() {
            return Some(format!(
                "file:///{}",
                p.to_string_lossy().replace('\\', "/").trim_start_matches('/')
            ));
        }
    }
    None
}

fn reconcile_existing_completed_subagent_transcripts(
    thread: &mut Value,
    now: i64,
    outcome: &mut AntigravityReconcileOutcome,
) {
    const BOGUS_INTERRUPTED_TEXT: &str =
        "Interrupted before completion; retried in subsequent steps.";
    let mut terminal_syncs: Vec<(String, String, Option<String>, String)> = Vec::new();
    if let Some(runs) = thread.get_mut("subagentRuns").and_then(Value::as_array_mut) {
        for run in runs.iter_mut() {
            let sid = run
                .get("subagentId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let ptc = run
                .get("parentToolCallId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let is_local_child = run
                .get("childThreadId")
                .and_then(Value::as_str)
                .is_some_and(|s| !s.trim().is_empty());
            if is_local_child {
                continue;
            }
            let mut touched_run = false;
            let mut resolved_uri = run
                .get("transcriptUri")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .map(str::to_string);
            if resolved_uri.is_none() && !sid.is_empty() {
                if let Some(probed) = probe_subagent_transcript_uri(&sid) {
                    run["transcriptUri"] = json!(probed.clone());
                    resolved_uri = Some(probed);
                    touched_run = true;
                }
            }
            let cur_status = run.get("status").and_then(Value::as_str).unwrap_or("");
            if let Some(ref uri) = resolved_uri {
                if cur_status != "killed" && child_transcript_ended_with_final_response(Some(uri)) {
                    if cur_status != "completed" {
                        run["status"] = json!("completed");
                        touched_run = true;
                    }
                    if run.get("completedAtUnixMs").is_none_or(Value::is_null) {
                        run["completedAtUnixMs"] = json!(now);
                        touched_run = true;
                    }
                    let items_empty = run
                        .get("items")
                        .and_then(Value::as_array)
                        .is_none_or(Vec::is_empty);
                    if (touched_run || items_empty)
                        && !outcome.uris_to_sync.iter().any(|(c, _, _)| c == &sid)
                    {
                        outcome.uris_to_sync.push((sid.clone(), uri.clone(), false));
                    }
                }
            }
            let final_status = run
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if touched_run {
                run["updatedAtUnixMs"] = json!(now);
                outcome.changed = true;
                outcome.runs_to_emit.push(run.clone());
            }
            if is_terminal_subagent_status(Some(final_status.as_str())) {
                terminal_syncs.push((sid, ptc, resolved_uri, final_status));
            }
        }
    }
    if terminal_syncs.is_empty() {
        return;
    }
    if let Some(items) = thread.get_mut("items").and_then(Value::as_array_mut) {
        for (sid, ptc, uri_opt, term_status) in terminal_syncs {
            let synth_id = format!("sub_{sid}");
            for it in items.iter_mut() {
                let id = it.get("id").and_then(Value::as_str).unwrap_or("");
                let meta_sid = it
                    .pointer("/subagentMeta/subagentId")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if id != synth_id && (ptc.is_empty() || id != ptc) && meta_sid != sid {
                    continue;
                }
                let mut touched_item = false;
                if term_status == "completed" {
                    if it.get("status").and_then(Value::as_str) != Some("completed") {
                        it["status"] = json!("completed");
                        touched_item = true;
                    }
                    if it.get("streaming").and_then(Value::as_bool) == Some(true) {
                        it["streaming"] = json!(false);
                        touched_item = true;
                    }
                    if it.get("exitCode").is_some_and(|v| !v.is_null()) {
                        it["exitCode"] = Value::Null;
                        touched_item = true;
                    }
                    if it.get("text").and_then(Value::as_str) == Some(BOGUS_INTERRUPTED_TEXT) {
                        it["text"] = json!("");
                        touched_item = true;
                    }
                } else {
                    let target_status = if term_status == "killed" { "error" } else { "failed" };
                    let cur_it_status = it.get("status").and_then(Value::as_str).unwrap_or("");
                    if matches!(
                        cur_it_status,
                        "" | "running" | "waiting" | "queued" | "pending" | "inProgress" | "in_progress"
                    ) {
                        it["status"] = json!(target_status);
                        touched_item = true;
                    }
                    if it.get("streaming").and_then(Value::as_bool) == Some(true) {
                        it["streaming"] = json!(false);
                        touched_item = true;
                    }
                }
                if let Some(meta_obj) = it.get_mut("subagentMeta").and_then(Value::as_object_mut) {
                    if meta_obj.get("status").and_then(Value::as_str) != Some(term_status.as_str()) {
                        meta_obj.insert("status".into(), json!(term_status));
                        touched_item = true;
                    }
                    if let Some(ref uri) = uri_opt {
                        if meta_obj.get("transcriptUri").is_none_or(Value::is_null) {
                            meta_obj.insert("transcriptUri".into(), json!(uri));
                            touched_item = true;
                        }
                    }
                }
                if touched_item {
                    outcome.changed = true;
                    outcome.items_to_emit.push(it.clone());
                }
            }
        }
    }
}

pub fn needs_antigravity_transcript_reconcile(thread: &Value) -> bool {
    const BOGUS_INTERRUPTED_TEXT: &str =
        "Interrupted before completion; retried in subsequent steps.";
    let empty_map = HashMap::new();
    let mut seen_spawn_child_ids = HashSet::new();
    let has_item_needing_cleanup = thread
        .get("items")
        .and_then(Value::as_array)
        .is_some_and(|arr| {
            arr.iter().any(|it| {
                let has_subagent_shape = it.get("toolKind").and_then(Value::as_str) == Some("subagent")
                    || it.get("subagentMeta").is_some();
                if has_subagent_shape
                    && (super::record::is_unspawned_failed_native_invoke(it)
                        || detect_non_delegating_subagent_item_kind(it, &seen_spawn_child_ids)
                            .is_some())
                {
                    return true;
                }
                if it.get("toolKind").and_then(Value::as_str) == Some("subagent") {
                    if let Some(ctid) = it
                        .pointer("/subagentMeta/childThreadId")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                    {
                        seen_spawn_child_ids.insert(ctid.to_string());
                    }
                }
                if it.get("toolKind").and_then(Value::as_str) == Some("subagent") {
                    if it.get("text").and_then(Value::as_str) == Some(BOGUS_INTERRUPTED_TEXT) {
                        return true;
                    }
                    let id = it.get("id").and_then(Value::as_str).unwrap_or("");
                    let sid = it
                        .pointer("/subagentMeta/subagentId")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    let role = it
                        .pointer("/subagentMeta/role")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    let steps = it
                        .pointer("/subagentMeta/stepCount")
                        .and_then(Value::as_u64)
                        .unwrap_or(0);
                    let uri = it
                        .pointer("/subagentMeta/transcriptUri")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    let ctid = it
                        .pointer("/subagentMeta/childThreadId")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    if is_phantom_unbacked_subagent_item_or_run(
                        id,
                        sid,
                        role,
                        steps,
                        uri,
                        ctid,
                        &empty_map,
                    ) {
                        return true;
                    }
                } else if it.get("kind").and_then(Value::as_str) == Some("tool") {
                    if let Some(txt) = it.get("text").and_then(Value::as_str) {
                        let t = txt.trim();
                        if t.starts_with("The following is a <SYSTEM_MESSAGE>")
                            || (t.starts_with("<SYSTEM_MESSAGE>") && t.contains("[Message]"))
                            || crate::chat::runtime::antigravity_fallback::extract_background_task_id(t).is_some()
                        {
                            return true;
                        }
                    }
                }
                false
            })
        });
    let (live_item_ids, live_meta_ids) = collect_live_subagent_ids(thread);
    let has_placeholder_run = thread
        .get("subagentRuns")
        .and_then(Value::as_array)
        .is_some_and(|runs| {
            runs.iter()
                .any(|r| is_orphaned_generic_placeholder_run(r, &live_item_ids, &live_meta_ids))
        });
    let has_superseded_placeholder = thread
        .get("items")
        .and_then(Value::as_array)
        .is_some_and(|items| !superseded_placeholder_ids(items).is_empty());
    let has_desynced_terminal_item = {
        let mut term_by_sid: HashMap<&str, &str> = HashMap::new();
        let mut term_by_ptc: HashMap<&str, &str> = HashMap::new();
        if let Some(runs) = thread.get("subagentRuns").and_then(Value::as_array) {
            for r in runs {
                let status = r.get("status").and_then(Value::as_str);
                if is_terminal_subagent_status(status) {
                    let s = status.unwrap_or("");
                    if let Some(sid) = r.get("subagentId").and_then(Value::as_str) {
                        if !sid.is_empty() {
                            term_by_sid.insert(sid, s);
                        }
                    }
                    if let Some(ptc) = r.get("parentToolCallId").and_then(Value::as_str) {
                        if !ptc.is_empty() {
                            term_by_ptc.insert(ptc, s);
                        }
                    }
                }
            }
        }
        !term_by_sid.is_empty()
            && thread
                .get("items")
                .and_then(Value::as_array)
                .is_some_and(|arr| {
                    arr.iter().any(|it| {
                        if it.get("toolKind").and_then(Value::as_str) != Some("subagent") {
                            return false;
                        }
                        let id = it.get("id").and_then(Value::as_str).unwrap_or("");
                        let sid = it
                            .pointer("/subagentMeta/subagentId")
                            .and_then(Value::as_str)
                            .unwrap_or("");
                        let term = term_by_sid
                            .get(sid)
                            .or_else(|| term_by_ptc.get(id))
                            .copied();
                        let Some(term_status) = term else {
                            return false;
                        };
                        it.get("streaming").and_then(Value::as_bool) == Some(true)
                            || !is_terminal_subagent_status(
                                it.pointer("/subagentMeta/status").and_then(Value::as_str),
                            )
                            || (term_status == "completed"
                                && it.get("status").and_then(Value::as_str) != Some("completed"))
                    })
                })
    };
    if has_item_needing_cleanup
        || has_placeholder_run
        || has_superseded_placeholder
        || has_desynced_terminal_item
    {
        return true;
    }

    if thread.get("provider").and_then(Value::as_str) != Some("antigravity") {
        return false;
    }
    let has_provider_session = thread
        .get("providerSessionId")
        .and_then(Value::as_str)
        .and_then(valid_provider_session_id)
        .is_some();
    let parent_has_model = thread
        .get("model")
        .and_then(Value::as_str)
        .is_some_and(|m| {
            let trimmed = m.trim();
            !trimmed.is_empty() && !trimmed.eq_ignore_ascii_case("automatic")
        });
    let has_incomplete_run = thread
        .get("subagentRuns")
        .and_then(Value::as_array)
        .is_some_and(|runs| {
            runs.iter().any(|r| {
                let is_local_child = r
                    .get("childThreadId")
                    .and_then(Value::as_str)
                    .is_some_and(|s| !s.trim().is_empty());
                if is_local_child {
                    return false;
                }
                let status = r.get("status").and_then(Value::as_str);
                let is_active = matches!(
                    status,
                    Some("running" | "waiting" | "queued" | "pending" | "inProgress" | "in_progress")
                );
                let sid = r.get("subagentId").and_then(Value::as_str).unwrap_or("");
                let uri_opt = r
                    .get("transcriptUri")
                    .and_then(Value::as_str)
                    .filter(|s| !s.trim().is_empty())
                    .map(str::to_string)
                    .or_else(|| {
                        ((is_active || status == Some("failed")) && !sid.is_empty())
                            .then(|| probe_subagent_transcript_uri(sid))
                            .flatten()
                    });
                let unhydrated_uri = uri_opt
                    .as_deref()
                    .and_then(resolve_local_transcript_path)
                    .is_some_and(|path| path.is_file())
                    && r.get("items")
                        .and_then(Value::as_array)
                        .is_none_or(Vec::is_empty);
                let failed_but_ended = status == Some("failed")
                    && uri_opt
                        .as_deref()
                        .is_some_and(|u| child_transcript_ended_with_final_response(Some(u)));
                let model_missing = has_provider_session
                    && parent_has_model
                    && (r.get("model").is_none_or(Value::is_null)
                        || r.get("model")
                            .and_then(Value::as_str)
                            .is_some_and(|m| m.trim().is_empty() || m.eq_ignore_ascii_case("inherit")));
                model_missing || unhydrated_uri || is_active || failed_but_ended
            })
        });
    if has_incomplete_run {
        return true;
    }
    if !has_provider_session {
        return false;
    }
    let existing_run_cids: HashSet<&str> = thread
        .get("subagentRuns")
        .and_then(Value::as_array)
        .map(|runs| {
            runs.iter()
                .filter_map(|r| r.get("subagentId").and_then(Value::as_str))
                .collect()
        })
        .unwrap_or_default();
    let has_unreconciled_manage_output = thread
        .get("items")
        .and_then(Value::as_array)
        .is_some_and(|arr| {
            arr.iter().any(|it| {
                let is_manage = it
                    .get("toolName")
                    .and_then(Value::as_str)
                    .is_some_and(|n| strip_mcp_prefix(n, &Value::Null).1 == "manage_subagents");
                if !is_manage {
                    return false;
                }
                let Some(text) = it.get("text").and_then(Value::as_str) else {
                    return false;
                };
                if !text.contains("conversationId") {
                    return false;
                }
                parse_output_json_array(Some(text)).is_some_and(|rows| {
                    rows.iter().any(|row| {
                        row.get("conversationId")
                            .or_else(|| row.get("conversation_id"))
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .is_some_and(|cid| !cid.is_empty() && !existing_run_cids.contains(cid))
                    })
                })
            })
        });
    has_unreconciled_manage_output
}

pub fn hydrate_antigravity_subagents_on_load(thread: &mut Value) -> bool {
    hydrate_antigravity_subagents_with_logs_dir(thread, None)
}

pub fn hydrate_antigravity_subagents_with_logs_dir(
    thread: &mut Value,
    custom_logs_dir: Option<&Path>,
) -> bool {
    if custom_logs_dir.is_none() && !needs_antigravity_transcript_reconcile(thread) {
        return false;
    }
    let outcome = reconcile_antigravity_subagents_in_thread(thread, custom_logs_dir, true);
    let mut changed = outcome.changed;
    for (sub_id, uri, _) in outcome.uris_to_sync {
        let Some(path) = resolve_local_transcript_path(&uri) else {
            continue;
        };
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        let parsed = parse_transcript_jsonl(&content, &sub_id);
        if parsed.is_empty() {
            continue;
        }
        if let Some(runs) = thread.get_mut("subagentRuns").and_then(Value::as_array_mut) {
            if let Some(run) = runs
                .iter_mut()
                .find(|r| r.get("subagentId").and_then(Value::as_str) == Some(sub_id.as_str()))
            {
                let (step_count, latest) = summarize_run_progress(&parsed);
                let items_val = Value::Array(parsed);
                let steps_val = json!(step_count);
                let latest_changed = latest.as_ref().is_some_and(|l| {
                    run.get("latestActivity").and_then(Value::as_str) != Some(l.as_str())
                });
                if run.get("items") != Some(&items_val)
                    || run.get("stepCount") != Some(&steps_val)
                    || latest_changed
                {
                    run["items"] = items_val;
                    run["stepCount"] = steps_val;
                    if let Some(ref l) = latest {
                        run["latestActivity"] = json!(l);
                    }
                    sync_parent_tool_item_progress(thread, &sub_id, step_count, latest.as_deref());
                    changed = true;
                }
            }
        }
    }
    changed
}

pub fn reconcile_antigravity_subagents_for_thread(thread_id: &str, run_id: Option<&str>) {
    reconcile_antigravity_subagents_for_thread_with_session(thread_id, run_id, None);
}

pub fn reconcile_antigravity_subagents_for_thread_with_session(
    thread_id: &str,
    run_id: Option<&str>,
    fallback_session_id: Option<&str>,
) {
    let logs_dir: Option<PathBuf> = {
        let Ok(all_threads) = threads().lock() else {
            return;
        };
        let Some(thread) = all_threads
            .iter()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(thread_id))
        else {
            return;
        };
        let is_agy_or_has_manage = thread
            .get("provider")
            .and_then(Value::as_str)
            .is_some_and(crate::chat::runtime::antigravity_fallback::is_antigravity_driver)
            || thread
                .get("items")
                .and_then(Value::as_array)
                .is_some_and(|arr| {
                    arr.iter().any(|it| {
                        it.get("toolName")
                            .and_then(Value::as_str)
                            .is_some_and(|n| {
                                let clean = strip_mcp_prefix(n, &Value::Null).1;
                                clean == "manage_subagents" || is_non_delegating_subagent_tool(&clean)
                            })
                    })
                });
        if !is_agy_or_has_manage {
            return;
        }
        thread
            .get("providerSessionId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .or(fallback_session_id.map(str::trim).filter(|s| !s.is_empty()))
            .and_then(antigravity_brain_logs_dir)
    };

    let mut transcript_map: HashMap<String, DiscoveredAgySubagent> = HashMap::new();
    let mut transcript_order: Vec<String> = Vec::new();
    if let Some(ref dir) = logs_dir {
        parse_antigravity_parent_transcript(dir, &mut transcript_map, &mut transcript_order);
    }

    let outcome = {
        let Ok(mut all_threads) = threads().lock() else {
            return;
        };
        let Some(thread) = all_threads
            .iter_mut()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(thread_id))
        else {
            return;
        };
        let res = reconcile_antigravity_subagents_with_discovered(
            thread,
            transcript_map,
            transcript_order,
        );
        if res.changed {
            touch(thread);
        }
        res
    };

    if let Some(rid) = run_id {
        if !outcome.items_to_emit.is_empty() || !outcome.removed_item_ids.is_empty() {
            {
                let mut live = live_turns().lock().unwrap();
                if let Some(run) = live.runs.get_mut(rid) {
                    for it in &outcome.items_to_emit {
                        push_event(run, json!({ "kind": "upsert", "item": it }));
                    }
                    for removed_id in &outcome.removed_item_ids {
                        push_event(run, json!({ "kind": "remove", "itemId": removed_id }));
                    }
                }
            }
            live_cv().notify_all();
        }
    }

    for (sub_id, uri, running) in outcome.uris_to_sync {
        sync_transcript_file(thread_id, &sub_id, &uri);
        if running {
            spawn_transcript_tailer_if_needed(thread_id, &sub_id, &uri);
        }
    }

    emit_subagent_runs_removed(thread_id, outcome.removed_runs);

    for run in outcome.runs_to_emit {
        emit_subagent_event(json!({
            "kind": "subagentRunUpdated",
            "threadId": thread_id,
            "subagentId": run.get("subagentId"),
            "run": run,
        }));
    }

    if outcome.changed {
        persist();
    }
}
