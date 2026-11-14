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

pub fn has_active_child_subagent(thread_id: &str) -> bool {
    let Ok(all_threads) = threads().lock() else {
        return false;
    };
    let Some(thread) = all_threads
        .iter()
        .find(|t| t.get("id").and_then(Value::as_str) == Some(thread_id))
    else {
        return false;
    };
    thread
        .get("subagentRuns")
        .and_then(Value::as_array)
        .is_some_and(|runs| {
            runs.iter().any(|r| {
                matches!(
                    r.get("status").and_then(Value::as_str),
                    Some("running" | "waiting" | "inProgress" | "pending")
                )
            })
        })
}

pub fn reconcile_duplicate_subagent_state(thread: &mut Value) {
    if let Some(runs) = thread.get_mut("subagentRuns").and_then(Value::as_array_mut) {
        let backed_keys: Vec<(String, String, String, String, String, bool)> = runs
            .iter()
            .filter_map(|r| {
                let cid = r.get("childThreadId").and_then(Value::as_str)?.trim();
                if cid.is_empty() {
                    return None;
                }
                let sid = r
                    .get("subagentId")
                    .and_then(Value::as_str)
                    .unwrap_or(cid)
                    .to_string();
                let role = r
                    .get("role")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_string();
                let prompt = r
                    .get("prompt")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_string();
                let call_id = r
                    .get("parentToolCallId")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_string();
                let is_terminal = matches!(
                    r.get("status").and_then(Value::as_str),
                    Some("completed" | "failed" | "killed")
                );
                Some((cid.to_string(), sid, role, prompt, call_id, is_terminal))
            })
            .collect();

        let mut claimed_cids: HashSet<String> = HashSet::new();
        let mut claimed_call_for_cid: Vec<(String, String)> = Vec::new();
        runs.retain(|r| {
            let has_cid = r
                .get("childThreadId")
                .and_then(Value::as_str)
                .is_some_and(|s| !s.trim().is_empty());
            let has_uri = r
                .get("transcriptUri")
                .and_then(Value::as_str)
                .is_some_and(|s| !s.trim().is_empty());
            let has_items = r
                .get("items")
                .and_then(Value::as_array)
                .is_some_and(|a| !a.is_empty());
            if has_cid || has_uri || has_items {
                return true;
            }
            let r_role = r.get("role").and_then(Value::as_str).unwrap_or("").trim();
            let r_prompt = r.get("prompt").and_then(Value::as_str).unwrap_or("").trim();
            let r_call = r
                .get("parentToolCallId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let r_is_active = matches!(
                r.get("status").and_then(Value::as_str),
                None | Some("running" | "waiting" | "inProgress" | "pending")
            );
            if let Some((cid, _, _, _, _, _)) = backed_keys.iter().find(|(b_cid, _, b_role, b_prompt, b_call, b_is_terminal)| {
                let text_match = (!r_prompt.is_empty() && r_prompt == b_prompt)
                    || (!r_role.is_empty() && r_role == b_role);
                if !text_match {
                    return false;
                }
                let exact_call = !r_call.is_empty() && r_call == *b_call;
                let unbound_b = b_call.is_empty() || b_call.starts_with("dispatch-subagent-");
                if !exact_call && (!unbound_b || claimed_cids.contains(b_cid) || (r_is_active && *b_is_terminal)) {
                    return false;
                }
                true
            }) {
                claimed_cids.insert(cid.clone());
                if !r_call.is_empty() && !r_call.starts_with("dispatch-subagent-") {
                    claimed_call_for_cid.push((cid.clone(), r_call));
                }
                return false;
            }
            true
        });

        for (cid, call_id) in claimed_call_for_cid {
            if let Some(run) = runs
                .iter_mut()
                .find(|r| r.get("childThreadId").and_then(Value::as_str) == Some(cid.as_str()))
            {
                let cur = run
                    .get("parentToolCallId")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if cur.is_empty() || cur.starts_with("dispatch-subagent-") {
                    run["parentToolCallId"] = json!(call_id);
                }
            }
        }
    }

    let bound_calls_by_cid: Vec<(String, String)> = thread
        .get("subagentRuns")
        .and_then(Value::as_array)
        .map(|runs| {
            runs.iter()
                .filter_map(|r| {
                    let cid = r.get("childThreadId").and_then(Value::as_str)?.trim();
                    let call = r.get("parentToolCallId").and_then(Value::as_str)?.trim();
                    if cid.is_empty() || call.is_empty() || call.starts_with("dispatch-subagent-") {
                        return None;
                    }
                    Some((call.to_string(), cid.to_string()))
                })
                .collect()
        })
        .unwrap_or_default();

    if let Some(items) = thread.get_mut("items").and_then(Value::as_array_mut) {
        for it in items.iter_mut() {
            if it.get("toolKind").and_then(Value::as_str) == Some("subagent") {
                let detail = it.get("detail").and_then(Value::as_str).unwrap_or("");
                if detail.trim_start().starts_with('$') || detail.contains("kite dispatch") {
                    let prompt = it
                        .pointer("/subagentMeta/prompt")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    it["detail"] = json!(prompt);
                }
            }
        }

        // If both a provider tool item (`t_...`) and a synthetic `dispatch-subagent-<cid>` item
        // exist for the same subagent run, fold the synthetic item's metadata into the provider
        // tool item and drop the duplicate synthetic item.
        let synthetic: Vec<(usize, Value)> = items
            .iter()
            .enumerate()
            .filter(|(_, it)| {
                it.get("id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| id.starts_with("dispatch-subagent-"))
            })
            .map(|(i, it)| (i, it.clone()))
            .collect();

        let mut drop_ids: Vec<String> = Vec::new();
        let mut claimed_host_ids: HashSet<String> = HashSet::new();
        for (_, syn) in &synthetic {
            let syn_id = syn.get("id").and_then(Value::as_str).unwrap_or("");
            let syn_cid = syn
                .pointer("/subagentMeta/childThreadId")
                .and_then(Value::as_str)
                .unwrap_or("");
            let syn_role = syn
                .pointer("/subagentMeta/role")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            let syn_prompt = syn
                .pointer("/subagentMeta/prompt")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();

            if let Some(host_item) = items.iter_mut().find(|it| {
                let id = it.get("id").and_then(Value::as_str).unwrap_or("");
                if id.starts_with("dispatch-subagent-")
                    || claimed_host_ids.contains(id)
                    || it.get("toolKind").and_then(Value::as_str) != Some("subagent")
                {
                    return false;
                }
                let it_cid = it
                    .pointer("/subagentMeta/childThreadId")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if !syn_cid.is_empty() && it_cid == syn_cid {
                    return true;
                }
                if bound_calls_by_cid
                    .iter()
                    .any(|(call, cid)| call == id && !syn_cid.is_empty() && cid != syn_cid)
                {
                    return false;
                }
                if bound_calls_by_cid
                    .iter()
                    .any(|(call, cid)| call == id && !syn_cid.is_empty() && cid == syn_cid)
                {
                    return true;
                }
                if it_cid.is_empty() {
                    if is_terminal_subagent_item(it) {
                        return false;
                    }
                    let it_role = it
                        .pointer("/subagentMeta/role")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .trim();
                    let it_prompt = it
                        .pointer("/subagentMeta/prompt")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .trim();
                    return (!syn_prompt.is_empty() && it_prompt == syn_prompt)
                        || (!syn_role.is_empty() && it_role == syn_role);
                }
                false
            }) {
                if let Some(host_id) = host_item.get("id").and_then(Value::as_str) {
                    claimed_host_ids.insert(host_id.to_string());
                }
                if let Some(title) = syn.get("title").and_then(Value::as_str) {
                    if !title.is_empty() {
                        host_item["title"] = json!(title);
                    }
                }
                if !syn_prompt.is_empty() {
                    host_item["detail"] = json!(syn_prompt);
                }
                if let Some(syn_meta) = syn.get("subagentMeta") {
                    host_item["subagentMeta"] = syn_meta.clone();
                }
                if let Some(syn_status) = syn.get("status").and_then(Value::as_str) {
                    host_item["status"] = json!(syn_status);
                }
                drop_ids.push(syn_id.to_string());
            }
        }
        if !drop_ids.is_empty() {
            items.retain(|it| {
                let id = it.get("id").and_then(Value::as_str).unwrap_or("");
                !drop_ids.iter().any(|d| d == id)
            });
        }
    }
}

