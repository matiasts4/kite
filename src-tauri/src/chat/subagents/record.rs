use std::collections::HashSet;
use std::fs;
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

pub(super) fn resolve_effective_subagent_model(
    raw_model: Option<&str>,
    parent_model: Option<&str>,
) -> Option<String> {
    let explicit = raw_model
        .map(str::trim)
        .filter(|m| !m.is_empty() && !m.eq_ignore_ascii_case("inherit"));
    explicit.map(str::to_string).or_else(|| {
        parent_model
            .map(str::trim)
            .filter(|m| !m.is_empty() && !m.eq_ignore_ascii_case("automatic"))
            .map(str::to_string)
    })
}

pub(crate) fn is_invoke_subagent_tool_name(name: &str) -> bool {
    let (_, clean) = crate::acp::strip_mcp_prefix(name, &Value::Null);
    clean.eq_ignore_ascii_case("invoke_subagent")
        || clean.eq_ignore_ascii_case("kite_subagent_run")
        || clean.eq_ignore_ascii_case("dispatch_subagent")
}

pub(super) fn resolve_item_clean_tool_name(item: &Value) -> (Option<String>, String) {
    let raw_name = item.get("toolName").and_then(Value::as_str).unwrap_or("");
    let (mut server_name, mut clean) = crate::acp::strip_mcp_prefix(raw_name, item);
    if clean.trim().is_empty() {
        if let Some(derived) = item
            .get("title")
            .and_then(Value::as_str)
            .and_then(crate::chat::normalize::normalize_acp_tool_name)
        {
            let (t_srv, t_clean) = crate::acp::strip_mcp_prefix(&derived, item);
            if server_name.is_none() {
                server_name = t_srv;
            }
            if !t_clean.trim().is_empty() {
                clean = t_clean;
            }
        }
    }
    if server_name.is_none() {
        server_name = item
            .get("serverName")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
    }

    if raw_name.eq_ignore_ascii_case("call_mcp_tool") || clean.eq_ignore_ascii_case("call_mcp_tool") {
        let detail = item.get("detail").and_then(Value::as_str).unwrap_or("");
        let trimmed_detail = detail.trim_start();
        if trimmed_detail.starts_with('{') {
            if let Some(Ok(params_val)) = serde_json::Deserializer::from_str(trimmed_detail)
                .into_iter::<Value>()
                .next()
            {
                let (d_srv, d_clean) = crate::acp::strip_mcp_prefix("call_mcp_tool", &params_val);
                if server_name.is_none() {
                    server_name = d_srv;
                }
                if !d_clean.is_empty() && !d_clean.eq_ignore_ascii_case("call_mcp_tool") {
                    clean = d_clean;
                }
            }
        }
        let detail_lower = detail.to_ascii_lowercase();
        if clean.eq_ignore_ascii_case("call_mcp_tool")
            && (detail_lower.contains("\"toolname\"") || detail_lower.contains("toolname:"))
        {
            for candidate in [
                "kite_subagent_wait",
                "kite_subagent_read",
                "kite_subagent_send",
                "kite_subagent_run",
                "kite_swarm",
                "send_message",
                "define_subagent",
                "manage_subagents",
                "invoke_subagent",
            ] {
                if detail_lower.contains(candidate) {
                    clean = candidate.to_string();
                    break;
                }
            }
        }
        if clean.eq_ignore_ascii_case("call_mcp_tool") {
            if let Some(title) = item.get("title").and_then(Value::as_str) {
                if let Some((left, right)) = title.split_once('·') {
                    let r = right.trim();
                    if !r.is_empty() && !r.contains(' ') && !r.eq_ignore_ascii_case("Subagent") {
                        clean = r.to_string();
                        if server_name.is_none() && !left.trim().is_empty() {
                            server_name = Some(left.trim().to_string());
                        }
                    }
                }
            }
        }
        if server_name.is_none()
            && (detail_lower.contains("kite-dispatch") || clean.to_ascii_lowercase().starts_with("kite_"))
        {
            server_name = Some("kite-dispatch".to_string());
        }
    }

    (server_name, clean)
}

pub(super) fn is_spawn_subagent_item(item: &Value) -> bool {
    let (_, clean) = resolve_item_clean_tool_name(item);
    if crate::acp::is_non_delegating_subagent_tool(&clean) {
        return false;
    }
    if clean.eq_ignore_ascii_case("invoke_subagent")
        || clean.eq_ignore_ascii_case("kite_subagent_run")
        || clean.eq_ignore_ascii_case("dispatch_subagent")
    {
        return true;
    }
    let cmd = item.get("command").and_then(Value::as_str).or_else(|| {
        item.get("detail")
            .and_then(Value::as_str)
            .and_then(|d| d.trim_start().strip_prefix("$ "))
            .and_then(|d| d.lines().next())
    });
    cmd.is_some_and(|c| {
        matches!(
            crate::acp::match_dispatch_cli(&crate::acp::tokenize_shell_tokens(c)),
            Some(crate::acp::DispatchCliCommand::Run(_))
        )
    })
}

pub(super) fn downgrade_non_delegating_item_in_place(
    it: &mut Value,
    clean_name: &str,
    server_name: Option<&str>,
) -> bool {
    let has_subagent_shape = it.get("toolKind").and_then(Value::as_str) == Some("subagent")
        || it.get("subagentMeta").is_some();
    if !has_subagent_shape {
        return false;
    }
    let raw_name = it.get("toolName").and_then(Value::as_str).unwrap_or("");
    let lower_clean = clean_name.trim().to_ascii_lowercase();
    let is_mcp_tool = lower_clean.starts_with("kite_subagent_")
        || server_name.is_some()
        || raw_name.eq_ignore_ascii_case("call_mcp_tool")
        || raw_name.to_ascii_lowercase().starts_with("mcp");

    if let Some(obj) = it.as_object_mut() {
        obj.remove("subagentMeta");
    }
    if is_mcp_tool {
        it["toolKind"] = json!("mcpToolCall");
        let srv = server_name
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("kite-dispatch");
        if it.get("serverName").is_none() && lower_clean.starts_with("kite_subagent_") {
            it["serverName"] = json!(srv);
        }
        let title = it.get("title").and_then(Value::as_str).unwrap_or("");
        if title.is_empty()
            || title.starts_with("Subagent")
            || title == "call_mcp_tool"
            || title == clean_name
        {
            it["title"] = json!(format!("{srv} · {lower_clean}"));
        }
    } else {
        it["toolKind"] = json!("dynamicToolCall");
        let title = it.get("title").and_then(Value::as_str).unwrap_or("");
        if title.is_empty() || title.starts_with("Subagent") {
            it["title"] = json!(lower_clean.replace('_', " "));
        }
    }
    true
}

fn is_hook_blocked_or_empty_invoke_text(text: Option<&str>) -> bool {
    let trimmed = text.map(str::trim).unwrap_or("");
    if trimmed.is_empty() {
        return true;
    }
    let lower = trimmed.to_ascii_lowercase();
    lower.contains("pre-tool hook")
        || lower.contains("native `invoke_subagent` is blocked")
        || lower.contains("native invoke_subagent is blocked")
}

/// True when a native `invoke_subagent` call failed before ever spawning a child subagent or
/// receiving an explicit non-hook failure message (for example when denied at `PreToolUse`).
pub(crate) fn is_unspawned_failed_native_invoke(item: &Value) -> bool {
    let (_, clean) = resolve_item_clean_tool_name(item);
    if !clean.eq_ignore_ascii_case("invoke_subagent") {
        return false;
    }
    let has_subagent_shape = item.get("toolKind").and_then(Value::as_str) == Some("subagent")
        || item.get("subagentMeta").is_some();
    if !has_subagent_shape {
        return false;
    }
    let item_status = item.get("status").and_then(Value::as_str).unwrap_or("");
    let meta_status = item
        .pointer("/subagentMeta/status")
        .and_then(Value::as_str)
        .unwrap_or("");
    if item_status.eq_ignore_ascii_case("killed") || meta_status.eq_ignore_ascii_case("killed") {
        return false;
    }
    let item_text = item.get("text").and_then(Value::as_str);
    let is_failed = item_status.eq_ignore_ascii_case("failed")
        || item_status.eq_ignore_ascii_case("error")
        || meta_status.eq_ignore_ascii_case("failed")
        || meta_status.eq_ignore_ascii_case("error")
        || crate::acp::response_indicates_failure(item_status, Some(item), None, item_text);
    if !is_failed {
        return false;
    }
    let item_id = item.get("id").and_then(Value::as_str).unwrap_or("").trim();
    let sid = item
        .pointer("/subagentMeta/subagentId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let child_tid = item
        .pointer("/subagentMeta/childThreadId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let transcript_uri = item
        .pointer("/subagentMeta/transcriptUri")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let step_count = item
        .pointer("/subagentMeta/stepCount")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let unspawned = child_tid.is_empty()
        && transcript_uri.is_empty()
        && step_count == 0
        && (sid.is_empty() || (!item_id.is_empty() && sid == item_id));
    unspawned && is_hook_blocked_or_empty_invoke_text(item_text)
}

pub(crate) fn downgrade_unspawned_failed_native_invoke_in_place(item: &mut Value) -> bool {
    if !is_unspawned_failed_native_invoke(item) {
        return false;
    }
    let role = item
        .pointer("/subagentMeta/role")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|r| !r.is_empty() && !r.eq_ignore_ascii_case("Subagent"))
        .map(str::to_string);
    if let Some(obj) = item.as_object_mut() {
        obj.remove("subagentMeta");
    }
    item["toolKind"] = json!("dynamicToolCall");
    item["title"] = match role {
        Some(r) => json!(format!("invoke_subagent · {r}")),
        None => json!("invoke_subagent"),
    };
    true
}

pub(super) fn remove_unspawned_invoke_runs_in_thread(
    thread: &mut Value,
    call_id: &str,
) -> Vec<(String, String)> {
    let mut removed = Vec::new();
    let Some(runs) = thread.get_mut("subagentRuns").and_then(Value::as_array_mut) else {
        return removed;
    };
    runs.retain(|r| {
        let sid = r.get("subagentId").and_then(Value::as_str).unwrap_or("").trim();
        let ptc = r
            .get("parentToolCallId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let matches_call = sid == call_id || ptc == call_id;
        let is_unspawned = r
            .get("childThreadId")
            .and_then(Value::as_str)
            .is_none_or(|s| s.trim().is_empty())
            && r.get("transcriptUri")
                .and_then(Value::as_str)
                .is_none_or(|s| s.trim().is_empty())
            && r.get("stepCount").and_then(Value::as_u64).unwrap_or(0) == 0
            && r.get("items").and_then(Value::as_array).is_none_or(Vec::is_empty);
        if matches_call && is_unspawned {
            removed.push((sid.to_string(), ptc.to_string()));
            return false;
        }
        true
    });
    removed
}

pub(crate) fn remove_unspawned_invoke_runs(thread_id: &str, call_id: &str) {
    if call_id.trim().is_empty() {
        return;
    }
    let removed = {
        let Ok(mut all_threads) = threads().lock() else {
            return;
        };
        let Some(thread) = all_threads
            .iter_mut()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(thread_id))
        else {
            return;
        };
        let removed = remove_unspawned_invoke_runs_in_thread(thread, call_id);
        if !removed.is_empty() {
            touch(thread);
        }
        removed
    };
    emit_subagent_runs_removed(thread_id, removed);
}

pub fn record_subagent_tool_call(thread_id: &str, tool_item: &Value) {
    let (resolved_server, clean_name) = resolve_item_clean_tool_name(tool_item);
    let item_id_raw = tool_item.get("id").and_then(Value::as_str).unwrap_or("");
    if is_unspawned_failed_native_invoke(tool_item) {
        if !item_id_raw.is_empty() {
            let mut item_upserts: Vec<Value> = Vec::new();
            let mut removed_runs: Vec<(String, String)> = Vec::new();
            if let Ok(mut all_threads) = threads().lock() {
                if let Some(thread) = all_threads
                    .iter_mut()
                    .find(|t| t.get("id").and_then(Value::as_str) == Some(thread_id))
                {
                    if let Some(items) = thread.get_mut("items").and_then(Value::as_array_mut) {
                        if let Some(it) = items
                            .iter_mut()
                            .find(|i| i.get("id").and_then(Value::as_str) == Some(item_id_raw))
                        {
                            if downgrade_unspawned_failed_native_invoke_in_place(it) {
                                item_upserts.push(it.clone());
                            }
                        }
                    }
                    removed_runs = remove_unspawned_invoke_runs_in_thread(thread, item_id_raw);
                    if !item_upserts.is_empty() || !removed_runs.is_empty() {
                        touch(thread);
                    }
                }
            }
            if !item_upserts.is_empty() {
                if let Ok(mut live) = live_turns().lock() {
                    if let Some(rid) = live.by_thread.get(thread_id).cloned() {
                        if let Some(run) = live.runs.get_mut(&rid) {
                            for it in &item_upserts {
                                push_event(run, json!({ "kind": "upsert", "item": it }));
                            }
                        }
                    }
                }
                live_cv().notify_all();
            }
            emit_subagent_runs_removed(thread_id, removed_runs);
        }
        return;
    }
    if crate::acp::is_non_delegating_subagent_tool(&clean_name) {
        if !item_id_raw.is_empty() {
            let mut item_upserts: Vec<Value> = Vec::new();
            if let Ok(mut all_threads) = threads().lock() {
                if let Some(thread) = all_threads
                    .iter_mut()
                    .find(|t| t.get("id").and_then(Value::as_str) == Some(thread_id))
                {
                    if let Some(items) = thread.get_mut("items").and_then(Value::as_array_mut) {
                        if let Some(it) = items
                            .iter_mut()
                            .find(|i| i.get("id").and_then(Value::as_str) == Some(item_id_raw))
                        {
                            if downgrade_non_delegating_item_in_place(
                                it,
                                &clean_name,
                                resolved_server.as_deref(),
                            ) {
                                item_upserts.push(it.clone());
                            }
                        }
                    }
                    if !item_upserts.is_empty() {
                        touch(thread);
                    }
                }
            }
            if !item_upserts.is_empty() {
                if let Ok(mut live) = live_turns().lock() {
                    if let Some(rid) = live.by_thread.get(thread_id).cloned() {
                        if let Some(run) = live.runs.get_mut(&rid) {
                            for it in &item_upserts {
                                push_event(run, json!({ "kind": "upsert", "item": it }));
                            }
                        }
                    }
                }
                live_cv().notify_all();
            }
        }
        return;
    }

    let Some(meta_val) = tool_item.get("subagentMeta") else {
        return;
    };
    let Ok(mut meta) = serde_json::from_value::<SubagentMeta>(meta_val.clone()) else {
        return;
    };
    let item_status = tool_item
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or(meta.status.as_str())
        .to_string();
    let item_text = tool_item.get("text").and_then(Value::as_str);
    let is_wait_timeout = crate::acp::is_wait_timeout_receipt(item_text);
    if is_wait_timeout {
        if meta.child_thread_id.is_none() {
            if let Some(cid) = item_text.and_then(super::dedup::extract_started_thread_id_from_text)
            {
                meta.child_thread_id = Some(cid.clone());
                if meta.subagent_id.is_empty() || meta.subagent_id == item_id_raw {
                    meta.subagent_id = cid;
                }
            }
        }
        if meta.status == "failed" {
            meta.status = "running".to_string();
        }
        if meta
            .latest_activity
            .as_deref()
            .is_some_and(|la| crate::acp::is_wait_timeout_receipt(Some(la)))
        {
            meta.latest_activity = None;
        }
    }
    let mut is_failed = false;
    if meta.status != "killed"
        && !is_wait_timeout
        && crate::acp::response_indicates_failure(&item_status, Some(tool_item), None, item_text)
    {
        meta.status = "failed".to_string();
        is_failed = true;
    }
    let tool_call_id = tool_item
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or(&meta.subagent_id)
        .to_string();
    let is_spawn = is_spawn_subagent_item(tool_item);
    let runtime_active = crate::chat::runtime::is_thread_runtime_active(thread_id);
    let now = now_ms();
    let mut emitted_run: Option<Value> = None;
    let mut uri_to_sync: Option<(String, String, bool)> = None;
    let mut item_upserts: Vec<Value> = Vec::new();

    {
        let mut all_threads = threads().lock().unwrap();
        let child_thread_state: Option<(String, bool, bool)> = meta.child_thread_id.as_deref().and_then(|cid| {
            all_threads
                .iter()
                .find(|t| t.get("id").and_then(Value::as_str) == Some(cid))
                .map(|child| {
                    let st = child
                        .get("status")
                        .and_then(Value::as_str)
                        .unwrap_or("idle")
                        .to_string();
                    let killed = crate::chat::kill_registry::is_thread_killed(cid);
                    let settled = child.get("isSettled").and_then(Value::as_bool) == Some(true)
                        || (st == "idle"
                            && child
                                .get("items")
                                .and_then(Value::as_array)
                                .is_some_and(|arr| {
                                    arr.iter().any(|it| {
                                        it.get("kind").and_then(Value::as_str) == Some("assistant")
                                            && it
                                                .get("text")
                                                .and_then(Value::as_str)
                                                .is_some_and(|t| !t.trim().is_empty())
                                    })
                                }));
                    (st, killed, settled)
                })
        });
        let child_turn_running = meta
            .child_thread_id
            .as_deref()
            .is_some_and(crate::chat::runtime::is_turn_running);
        let started_async_receipt = item_text.is_some_and(|t| t.contains("started thread:"));
        let is_async_spawn =
            clean_name.eq_ignore_ascii_case("dispatch_subagent") || started_async_receipt;
        let child_is_active = !is_failed
            && (child_turn_running
                || child_thread_state.as_ref().is_some_and(|(st, killed, settled)| {
                    !*killed
                        && (matches!(st.as_str(), "running" | "waiting")
                            || (is_async_spawn && st == "idle" && !*settled))
                })
                || (started_async_receipt && child_thread_state.is_none()));

        if let Some(thread) = all_threads
            .iter_mut()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(thread_id))
        {
            let parent_active = runtime_active
                || matches!(
                    thread.get("status").and_then(Value::as_str),
                    Some("running" | "waiting")
                );
            if child_is_active {
                meta.status = "running".to_string();
            } else if let Some((ref st, killed, _)) = child_thread_state {
                if killed {
                    meta.status = "killed".to_string();
                } else if st == "error" {
                    meta.status = "failed".to_string();
                } else if meta.status == "running" {
                    meta.status = "completed".to_string();
                }
            } else if is_spawn
                && !is_failed
                && meta.status == "completed"
                && clean_name.eq_ignore_ascii_case("invoke_subagent")
            {
                let transcript_ended = meta
                    .transcript_uri
                    .as_deref()
                    .is_some_and(|u| child_transcript_ended_with_final_response(Some(u)));
                if !transcript_ended && parent_active {
                    meta.status = "running".to_string();
                }
            }
            if thread.get("subagentRuns").and_then(Value::as_array).is_none() {
                thread["subagentRuns"] = Value::Array(Vec::new());
            }
            let parent_provider = thread
                .get("provider")
                .and_then(Value::as_str)
                .map(str::to_string);
            let parent_model = thread
                .get("model")
                .and_then(Value::as_str)
                .map(str::to_string);
            let runs = thread["subagentRuns"].as_array_mut().unwrap();
            let incoming_cid = meta
                .child_thread_id
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty());
            let pos = runs
                .iter()
                .position(|r| {
                    let r_cid = r
                        .get("childThreadId")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty());
                    let r_sid = r
                        .get("subagentId")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty());
                    (incoming_cid.is_some() && (r_cid == incoming_cid || r_sid == incoming_cid))
                        || (!meta.subagent_id.is_empty()
                            && meta.subagent_id != tool_call_id
                            && (r_sid == Some(meta.subagent_id.as_str())
                                || r_cid == Some(meta.subagent_id.as_str())))
                })
                .or_else(|| {
                    runs.iter().position(|r| {
                        let r_cid = r
                            .get("childThreadId")
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|s| !s.is_empty());
                        if let (Some(rc), Some(ic)) = (r_cid, incoming_cid) {
                            if rc != ic {
                                return false;
                            }
                        }
                        if r_cid.is_some()
                            && incoming_cid.is_none()
                            && !meta.subagent_id.is_empty()
                            && meta.subagent_id != tool_call_id
                            && r_cid != Some(meta.subagent_id.as_str())
                        {
                            return false;
                        }
                        let r_call = r
                            .get("parentToolCallId")
                            .and_then(Value::as_str)
                            .unwrap_or("");
                        let r_is_terminal = matches!(
                            r.get("status").and_then(Value::as_str),
                            Some("completed" | "failed" | "killed")
                        );
                        let role_or_prompt_matches = (meta.prompt.as_deref().is_some_and(|p| {
                            !p.trim().is_empty()
                                && r.get("prompt").and_then(Value::as_str).map(str::trim)
                                    == Some(p.trim())
                        })) || (!meta.role.is_empty()
                            && r.get("role").and_then(Value::as_str) == Some(meta.role.as_str()));

                        r.get("subagentId").and_then(Value::as_str) == Some(meta.subagent_id.as_str())
                            || (r_call == tool_call_id.as_str()
                                && (r_cid.is_none()
                                    || incoming_cid.is_none()
                                    || r_cid == incoming_cid))
                            || (!r_is_terminal
                                && r_cid.is_none()
                                && meta.child_thread_id.is_some()
                                && role_or_prompt_matches
                                && (tool_call_id.starts_with("dispatch-subagent-")
                                    || r_call.is_empty()
                                    || r_call.starts_with("dispatch-subagent-")
                                    || r_call == tool_call_id.as_str()))
                            || (!r_is_terminal
                                && r_cid.is_some()
                                && meta.child_thread_id.is_none()
                                && role_or_prompt_matches
                                && (r_call.is_empty()
                                    || r_call.starts_with("dispatch-subagent-")
                                    || r_call == tool_call_id.as_str()))
                    })
                });
            let is_terminal = matches!(meta.status.as_str(), "completed" | "failed" | "killed");
            let mut synced_model: Option<String> = None;
            let mut synced_subagent_id = meta.subagent_id.clone();
            let mut effective_run_status = meta.status.clone();
            let mut effective_run_is_running = !is_terminal;
            if let Some(idx) = pos {
                let run = &mut runs[idx];
                let old_sid = run
                    .get("subagentId")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let old_ptc = run
                    .get("parentToolCallId")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let run_was_unbound_placeholder = !old_sid.is_empty()
                    && old_sid == old_ptc
                    && run
                        .get("transcriptUri")
                        .and_then(Value::as_str)
                        .is_none_or(|s| s.trim().is_empty())
                    && run
                        .get("childThreadId")
                        .and_then(Value::as_str)
                        .is_none_or(|s| s.trim().is_empty())
                    && run.get("stepCount").and_then(Value::as_u64).unwrap_or(0) == 0;
                let existing_meta = serde_json::from_value::<SubagentMeta>(run.clone()).ok();
                let merged = merge_subagent_meta(existing_meta.as_ref(), meta.clone());
                synced_subagent_id = merged.subagent_id.clone();
                run["subagentId"] = json!(merged.subagent_id);
                if !tool_call_id.starts_with("dispatch-subagent-")
                    || run
                        .get("parentToolCallId")
                        .and_then(Value::as_str)
                        .is_none_or(str::is_empty)
                {
                    run["parentToolCallId"] = json!(tool_call_id);
                }
                run["role"] = json!(merged.role);
                if let Some(ref t) = merged.type_name {
                    run["typeName"] = json!(t);
                }
                if let Some(ref p) = merged.provider.or(parent_provider) {
                    run["provider"] = json!(p);
                }
                if let Some(m) = resolve_effective_subagent_model(
                    merged.model.as_deref(),
                    parent_model.as_deref(),
                ) {
                    run["model"] = json!(m);
                    synced_model = Some(m);
                }
                if let Some(ref w) = merged.workspace_mode {
                    run["workspaceMode"] = json!(w);
                }
                if let Some(ref pr) = merged.prompt {
                    run["prompt"] = json!(pr);
                }
                let cur_run_status = run.get("status").and_then(Value::as_str);
                let cur_is_terminal =
                    matches!(cur_run_status, Some("completed" | "failed" | "killed"));
                let allow_adopt_live = child_is_active
                    || (run_was_unbound_placeholder
                        && cur_run_status == Some("completed")
                        && !is_terminal
                        && (merged.subagent_id != old_sid
                            || merged.transcript_uri.is_some()
                            || merged.child_thread_id.is_some()));
                if allow_adopt_live || !(cur_is_terminal && !is_terminal) {
                    run["status"] = json!(merged.status);
                }
                effective_run_status = run
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("running")
                    .to_string();
                effective_run_is_running = !matches!(
                    effective_run_status.as_str(),
                    "completed" | "failed" | "killed"
                );
                if effective_run_is_running {
                    if let Some(obj) = run.as_object_mut() {
                        obj.remove("completedAtUnixMs");
                    }
                } else if run.get("completedAtUnixMs").is_none_or(Value::is_null) {
                    run["completedAtUnixMs"] = json!(now);
                }
                if let Some(ref uri) = merged.transcript_uri {
                    run["transcriptUri"] = json!(uri);
                    uri_to_sync = Some((
                        merged.subagent_id.clone(),
                        uri.clone(),
                        effective_run_is_running,
                    ));
                }
                if let Some(ref ctid) = merged.child_thread_id {
                    run["childThreadId"] = json!(ctid);
                }
                if let Some(ref latest) = merged.latest_activity {
                    if !crate::acp::is_wait_timeout_receipt(Some(latest)) {
                        run["latestActivity"] = json!(latest);
                    }
                }
                let existing_steps = run.get("stepCount").and_then(Value::as_u64).unwrap_or(0) as usize;
                run["stepCount"] = json!(existing_steps.max(merged.step_count));
                run["updatedAtUnixMs"] = json!(now);
                emitted_run = Some(run.clone());
            } else {
                let sub_id = meta.subagent_id.clone();
                if let Some(ref uri) = meta.transcript_uri {
                    uri_to_sync = Some((sub_id.clone(), uri.clone(), !is_terminal));
                }
                let effective_model = resolve_effective_subagent_model(
                    meta.model.as_deref(),
                    parent_model.as_deref(),
                );
                synced_model = effective_model.clone();
                let created = SubagentRun {
                    subagent_id: meta.subagent_id.clone(),
                    parent_thread_id: thread_id.to_string(),
                    parent_tool_call_id: tool_call_id.clone(),
                    role: meta.role.clone(),
                    swarm_member_name: None,
                    type_name: meta.type_name.clone(),
                    provider: meta.provider.clone().or(parent_provider),
                    model: effective_model,
                    workspace_mode: meta.workspace_mode.clone(),
                    prompt: meta.prompt.clone(),
                    status: meta.status.clone(),
                    transcript_uri: meta.transcript_uri.clone(),
                    child_thread_id: meta.child_thread_id.clone(),
                    latest_activity: meta.latest_activity.clone(),
                    step_count: meta.step_count,
                    items: Vec::new(),
                    started_at_unix_ms: now,
                    updated_at_unix_ms: now,
                    completed_at_unix_ms: if is_terminal { Some(now) } else { None },
                };
                if let Ok(val) = serde_json::to_value(created) {
                    runs.push(val.clone());
                    emitted_run = Some(val);
                }
            }
            if is_spawn && (meta.status == "running" || !effective_run_is_running) {
                let desired_item_status = match effective_run_status.as_str() {
                    "running" | "waiting" => Some("running"),
                    "completed" => Some("completed"),
                    "failed" => Some("failed"),
                    "killed" => Some("error"),
                    _ => None,
                };
                if let Some(target_item_status) = desired_item_status {
                    if let Some(items) = thread.get_mut("items").and_then(Value::as_array_mut) {
                        for it in items.iter_mut() {
                            let matches_call =
                                it.get("id").and_then(Value::as_str) == Some(tool_call_id.as_str());
                            let matches_sub = it
                                .pointer("/subagentMeta/subagentId")
                                .and_then(Value::as_str)
                                == Some(synced_subagent_id.as_str());
                            if !matches_call && !matches_sub {
                                continue;
                            }
                            let mut changed_it = false;
                            if it.get("status").and_then(Value::as_str) != Some(target_item_status) {
                                it["status"] = json!(target_item_status);
                                changed_it = true;
                            }
                            if it.get("streaming").and_then(Value::as_bool) == Some(true) {
                                it["streaming"] = json!(false);
                                changed_it = true;
                            }
                            if let Some(meta_obj) =
                                it.get_mut("subagentMeta").and_then(Value::as_object_mut)
                            {
                                if meta_obj.get("status").and_then(Value::as_str)
                                    != Some(effective_run_status.as_str())
                                {
                                    meta_obj.insert("status".into(), json!(effective_run_status));
                                    changed_it = true;
                                }
                            }
                            if changed_it {
                                item_upserts.push(it.clone());
                            }
                        }
                    }
                }
            }
            if let Some(ref resolved_model) = synced_model {
                if let Some(items) = thread.get_mut("items").and_then(Value::as_array_mut) {
                    for it in items.iter_mut() {
                        let matches_call = it.get("id").and_then(Value::as_str) == Some(tool_call_id.as_str());
                        let matches_sub = it
                            .pointer("/subagentMeta/subagentId")
                            .and_then(Value::as_str)
                            == Some(synced_subagent_id.as_str());
                        if !matches_call && !matches_sub {
                            continue;
                        }
                        if let Some(meta_obj) = it.get_mut("subagentMeta").and_then(Value::as_object_mut) {
                            let needs_model = meta_obj.get("model").is_none_or(Value::is_null)
                                || meta_obj
                                    .get("model")
                                    .and_then(Value::as_str)
                                    .is_some_and(|m| m.trim().is_empty() || m.eq_ignore_ascii_case("inherit"));
                            if needs_model {
                                meta_obj.insert("model".into(), json!(resolved_model));
                            }
                        }
                    }
                }
            }
            reconcile_duplicate_subagent_state(thread);
            touch(thread);
        }
    }

    if !item_upserts.is_empty() {
        if let Ok(mut live) = live_turns().lock() {
            if let Some(rid) = live.by_thread.get(thread_id).cloned() {
                if let Some(run) = live.runs.get_mut(&rid) {
                    for it in &item_upserts {
                        push_event(run, json!({ "kind": "upsert", "item": it }));
                    }
                }
            }
        }
        live_cv().notify_all();
    }

    if let Some((sub_id, uri, running)) = uri_to_sync {
        sync_transcript_file(thread_id, &sub_id, &uri);
        if running {
            spawn_transcript_tailer_if_needed(thread_id, &sub_id, &uri);
        }
    }

    if let Some(run) = emitted_run {
        emit_subagent_event(json!({
            "kind": "subagentRunUpdated",
            "threadId": thread_id,
            "subagentId": run.get("subagentId"),
            "run": run,
        }));
    }
}

pub fn record_swarm_tool_call(thread_id: &str, tool_item: &Value) -> Option<Value> {
    let meta_val = tool_item.get("swarmMeta")?;
    let meta = serde_json::from_value::<SwarmMeta>(meta_val.clone()).ok()?;
    let now = now_ms();
    let mut updated_state: Option<Value> = None;

    {
        let mut all_threads = threads().lock().unwrap();
        if let Some(thread) = all_threads
            .iter_mut()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(thread_id))
        {
            let coordinator_model = thread
                .get("model")
                .and_then(Value::as_str)
                .map(str::to_string);
            let mut state: SwarmState = thread
                .get("swarmState")
                .and_then(|v| serde_json::from_value::<SwarmState>(v.clone()).ok())
                .unwrap_or_else(|| SwarmState::empty_for(thread_id, coordinator_model.clone()));
            if state.coordinator_model.is_none() {
                state.coordinator_model = coordinator_model;
            }
            if let Some(ref sid) = meta.swarm_id {
                state.swarm_id = sid.clone();
            }

            let target_channel = meta.channel.clone().unwrap_or_else(|| "main".to_string());
            if !target_channel.is_empty()
                && !state.channels.iter().any(|c| c.name == target_channel)
            {
                state.channels.push(SwarmChannel {
                    name: target_channel.clone(),
                    topic: None,
                    archived: false,
                });
            }

            match meta.action.as_str() {
                "title" => {
                    if let Some(ref title) = meta.swarm_title {
                        if !title.trim().is_empty() {
                            state.title = title.trim().to_string();
                        }
                    }
                }
                "channel" => {
                    // Ensure channel entry already inserted above; nothing else needed.
                }
                "add" => {
                    let names: Vec<String> = if !meta.member_names.is_empty() {
                        meta.member_names.clone()
                    } else if let Some(ref m) = meta.member_name {
                        vec![m.clone()]
                    } else {
                        Vec::new()
                    };
                    for name in names {
                        if let Some(existing) = state.members.iter_mut().find(|m| m.name == name) {
                            if meta.model.is_some() {
                                existing.model = meta.model.clone();
                            }
                            if meta.workspace_mode.is_some() {
                                existing.workspace_mode = meta.workspace_mode.clone();
                            }
                            if meta.brief.is_some() {
                                existing.brief = meta.brief.clone();
                            }
                            if existing.state == "stopped" {
                                existing.state = "waiting".to_string();
                            }
                            if !existing.channels.contains(&target_channel) {
                                existing.channels.push(target_channel.clone());
                            }
                        } else {
                            let role = meta
                                .brief
                                .as_deref()
                                .and_then(|b| b.lines().next())
                                .map(|l| l.trim().chars().take(72).collect::<String>())
                                .filter(|s| !s.is_empty())
                                .unwrap_or_else(|| format!("@{name}"));
                            state.members.push(SwarmMember {
                                name,
                                role,
                                provider: thread
                                    .get("provider")
                                    .and_then(Value::as_str)
                                    .map(str::to_string),
                                model: meta.model.clone(),
                                effort: None,
                                workspace_mode: meta.workspace_mode.clone(),
                                state: "waiting".to_string(),
                                current_activity: None,
                                channels: vec![target_channel.clone()],
                                subagent_id: None,
                                child_thread_id: None,
                                brief: meta.brief.clone(),
                                last_read_seq: 0,
                                pending_wake: false,
                            });
                        }
                    }
                }
                "model" => {
                    if let Some(ref member_name) = meta.member_name {
                        if let Some(member) = state.members.iter_mut().find(|m| &m.name == member_name)
                        {
                            member.model = meta.model.clone();
                        }
                    } else if meta.model.is_some() {
                        state.coordinator_model = meta.model.clone();
                    }
                }
                "kill" => {
                    if let Some(ref member_name) = meta.member_name {
                        if let Some(member) = state.members.iter_mut().find(|m| &m.name == member_name)
                        {
                            member.state = "killed".to_string();
                        }
                    }
                }
                "post_message" => {
                    if let Some(ref text) = meta.post_text {
                        let next_seq = meta
                            .seq
                            .unwrap_or_else(|| state.posts.last().map(|p| p.seq + 1).unwrap_or(1));
                        if !state.posts.iter().any(|p| p.seq == next_seq) {
                            let author = meta
                                .member_name
                                .clone()
                                .unwrap_or_else(|| "coordinator".to_string());
                            let mentions = if meta.mentions.is_empty() {
                                extract_mentions(text)
                            } else {
                                meta.mentions.clone()
                            };
                            for mention in &mentions {
                                let name = mention.trim_start_matches('@');
                                if name == "all" {
                                    for m in &mut state.members {
                                        if m.state == "waiting" {
                                            m.state = "working".to_string();
                                        }
                                    }
                                } else if let Some(member) =
                                    state.members.iter_mut().find(|m| m.name == name)
                                {
                                    if member.state != "killed" {
                                        member.state = "working".to_string();
                                    }
                                }
                            }
                            state.posts.push(SwarmBoardPost {
                                seq: next_seq,
                                author,
                                channel: target_channel,
                                text: text.clone(),
                                mentions,
                                created_at_unix_ms: now,
                            });
                        }
                        if meta.seq.is_none() {
                            if let Some(item_id) = tool_item.get("id").and_then(Value::as_str) {
                                if let Some(items) = thread.get_mut("items").and_then(Value::as_array_mut) {
                                    if let Some(stored) = items.iter_mut().find(|it| it.get("id").and_then(Value::as_str) == Some(item_id)) {
                                        if let Some(meta_obj) = stored.get_mut("swarmMeta").and_then(Value::as_object_mut) {
                                            meta_obj.insert("seq".to_string(), json!(next_seq));
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                _ => {}
            }

            if let Ok(state_val) = serde_json::to_value(&state) {
                thread["swarmState"] = state_val.clone();
                touch(thread);
                updated_state = Some(state_val);
            }
        }
    }

    if let Some(ref state_val) = updated_state {
        emit_subagent_event(json!({
            "kind": "swarmStateUpdated",
            "threadId": thread_id,
            "swarmState": state_val,
        }));
    }
    updated_state
}

