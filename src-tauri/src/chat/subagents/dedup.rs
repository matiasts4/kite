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

#[derive(Clone, Debug)]
struct LiveChildRunMeta {
    status: String,
    has_pending_approval: bool,
    provider: Option<String>,
    model: Option<String>,
    updated_at_unix_ms: i64,
    has_items: bool,
}

fn dedupe_runs_for_read(raw_runs: &[Value]) -> Vec<Value> {
    if raw_runs.len() <= 1 {
        return raw_runs.to_vec();
    }
    let backed_keys: Vec<(String, String, String, String, bool)> = raw_runs
        .iter()
        .filter_map(|r| {
            let cid = r.get("childThreadId").and_then(Value::as_str)?.trim();
            if cid.is_empty() {
                return None;
            }
            let role = r.get("role").and_then(Value::as_str).unwrap_or("").trim().to_string();
            let prompt = r.get("prompt").and_then(Value::as_str).unwrap_or("").trim().to_string();
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
            Some((cid.to_string(), role, prompt, call_id, is_terminal))
        })
        .collect();

    let mut claimed_cids: HashSet<String> = HashSet::new();
    let mut out = Vec::with_capacity(raw_runs.len());
    for r in raw_runs {
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
            out.push(r.clone());
            continue;
        }
        let r_role = r.get("role").and_then(Value::as_str).unwrap_or("").trim();
        let r_prompt = r.get("prompt").and_then(Value::as_str).unwrap_or("").trim();
        let r_call = r
            .get("parentToolCallId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let r_is_active = matches!(
            r.get("status").and_then(Value::as_str),
            None | Some("running" | "waiting" | "inProgress" | "pending")
        );
        if let Some((cid, _, _, _, _)) = backed_keys.iter().find(|(b_cid, b_role, b_prompt, b_call, b_is_terminal)| {
            let text_match = (!r_prompt.is_empty() && r_prompt == b_prompt)
                || (!r_role.is_empty() && r_role == b_role);
            if !text_match {
                return false;
            }
            let exact_call = !r_call.is_empty() && r_call == *b_call;
            let unbound_b = b_call.is_empty() || b_call.starts_with("dispatch-subagent-");
            exact_call || (unbound_b && !claimed_cids.contains(b_cid) && !(r_is_active && *b_is_terminal))
        }) {
            claimed_cids.insert(cid.clone());
            continue;
        }
        out.push(r.clone());
    }
    out
}

fn subagent_status_priority(status: &str, has_pending_approval: bool) -> u8 {
    if has_pending_approval
        || matches!(
            status,
            "waiting" | "needsInput" | "blocked" | "pendingApproval"
        )
    {
        return 0;
    }
    if matches!(
        status,
        "running" | "pending" | "queued" | "inProgress" | "in_progress"
    ) {
        return 1;
    }
    2
}

/// Returns lightweight deduplicated subagent run summaries across non-archived parent threads.
pub fn list_all_subagent_runs_snapshot(workspace_id: Option<&str>, limit: usize) -> Value {
    let Ok(all_threads) = threads().lock() else {
        return json!({
            "ok": true,
            "runs": [],
            "totalCount": 0,
            "activeCount": 0,
            "waitingCount": 0
        });
    };

    let child_meta_by_id: std::collections::HashMap<&str, LiveChildRunMeta> = all_threads
        .iter()
        .filter_map(|t| {
            let id = t.get("id").and_then(Value::as_str)?;
            let status = t
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("idle")
                .to_string();
            let has_pending_approval = t
                .get("pendingApproval")
                .is_some_and(|v| !v.is_null())
                || t.get("pendingUserInput").is_some_and(|v| !v.is_null());
            let provider = t
                .get("provider")
                .and_then(Value::as_str)
                .map(str::to_string);
            let model = t.get("model").and_then(Value::as_str).map(str::to_string);
            let updated_at_unix_ms = t
                .get("updatedAtUnixMs")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let has_items = t
                .get("items")
                .and_then(Value::as_array)
                .is_some_and(|arr| !arr.is_empty());
            Some((
                id,
                LiveChildRunMeta {
                    status,
                    has_pending_approval,
                    provider,
                    model,
                    updated_at_unix_ms,
                    has_items,
                },
            ))
        })
        .collect();

    let mut entries: Vec<(u8, i64, i64, Value)> = Vec::new();
    let mut active_count = 0usize;
    let mut waiting_count = 0usize;

    for thread in all_threads.iter() {
        if crate::chat::archived_at_ms(thread).is_some() {
            continue;
        }
        let thread_ws = thread.get("workspaceId").and_then(Value::as_str);
        if let Some(filter_ws) = workspace_id.map(str::trim).filter(|s| !s.is_empty()) {
            if thread_ws != Some(filter_ws) {
                continue;
            }
        }
        let Some(raw_runs) = thread.get("subagentRuns").and_then(Value::as_array) else {
            continue;
        };
        if raw_runs.is_empty() {
            continue;
        }
        let Some(thread_id) = thread.get("id").and_then(Value::as_str) else {
            continue;
        };
        let thread_title = thread
            .get("title")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("Untitled Thread");
        let parent_provider = thread.get("provider").and_then(Value::as_str);
        let parent_model = thread.get("model").and_then(Value::as_str);
        let swarm_id = thread
            .pointer("/swarmState/swarmId")
            .and_then(Value::as_str)
            .or_else(|| thread.get("swarmId").and_then(Value::as_str));

        for mut run in dedupe_runs_for_read(raw_runs) {
            let child_tid = run
                .get("childThreadId")
                .and_then(Value::as_str)
                .map(str::to_string);
            let mut has_pending_approval = false;
            if let Some(ref cid) = child_tid {
                if let Some(child_meta) = child_meta_by_id.get(cid.as_str()) {
                    has_pending_approval = child_meta.has_pending_approval;
                    if has_pending_approval {
                        run["status"] = json!("waiting");
                    } else if matches!(
                        child_meta.status.as_str(),
                        "running" | "waiting" | "pendingApproval"
                    ) {
                        run["status"] = json!(if child_meta.status == "pendingApproval" {
                            "waiting"
                        } else {
                            child_meta.status.as_str()
                        });
                    } else if matches!(
                        run.get("status").and_then(Value::as_str),
                        Some("running" | "waiting" | "queued" | "pending" | "inProgress" | "in_progress")
                    ) && (child_meta.status == "error"
                        || (child_meta.status == "idle"
                            && (child_meta.has_items
                                || now_ms().saturating_sub(child_meta.updated_at_unix_ms) >= 5_000
                                || run
                                    .get("updatedAtUnixMs")
                                    .and_then(Value::as_i64)
                                    .is_some_and(|ts| now_ms().saturating_sub(ts) >= 5_000))))
                    {
                        let settled = if child_meta.status == "error" {
                            "failed"
                        } else {
                            "completed"
                        };
                        run["status"] = json!(settled);
                        if run.get("completedAtUnixMs").is_none_or(Value::is_null) {
                            let done_ts = if child_meta.updated_at_unix_ms > 0 {
                                child_meta.updated_at_unix_ms
                            } else {
                                run.get("updatedAtUnixMs")
                                    .and_then(Value::as_i64)
                                    .unwrap_or_else(now_ms)
                            };
                            run["completedAtUnixMs"] = json!(done_ts);
                        }
                    }
                    if run.get("model").and_then(Value::as_str).is_none() {
                        if let Some(ref m) = child_meta.model {
                            run["model"] = json!(m);
                        }
                    }
                    if run.get("provider").and_then(Value::as_str).is_none() {
                        if let Some(ref p) = child_meta.provider {
                            run["provider"] = json!(p);
                        }
                    }
                }
            }
            // Strip large step transcripts so the cross-thread summary remains fast.
            if let Some(obj) = run.as_object_mut() {
                obj.insert("items".to_string(), json!([]));
                obj.entry("parentThreadId".to_string())
                    .or_insert_with(|| json!(thread_id));
            }
            let status = run
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("completed")
                .to_string();
            let priority = subagent_status_priority(&status, has_pending_approval);
            if priority < 2 {
                active_count += 1;
            }
            if priority == 0 {
                waiting_count += 1;
            }
            let started_at = run
                .get("startedAtUnixMs")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let updated_at = run
                .get("updatedAtUnixMs")
                .and_then(Value::as_i64)
                .unwrap_or(started_at);

            entries.push((
                priority,
                updated_at,
                started_at,
                json!({
                    "run": run,
                    "threadId": thread_id,
                    "threadTitle": thread_title,
                    "workspaceId": thread_ws,
                    "parentProvider": parent_provider,
                    "parentModel": parent_model,
                    "swarmId": swarm_id,
                    "hasPendingApproval": has_pending_approval,
                }),
            ));
        }
    }

    entries.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then_with(|| b.1.cmp(&a.1))
            .then_with(|| b.2.cmp(&a.2))
    });

    let total_count = entries.len();
    let max_entries = limit.clamp(1, 500);
    let runs: Vec<Value> = entries
        .into_iter()
        .take(max_entries)
        .map(|(_, _, _, entry)| entry)
        .collect();

    json!({
        "ok": true,
        "runs": runs,
        "totalCount": total_count,
        "activeCount": active_count,
        "waitingCount": waiting_count,
    })
}

pub fn reconcile_duplicate_subagent_state(thread: &mut Value) {
    let (non_delegating_ids, _) = super::antigravity::downgrade_non_delegating_subagent_items(thread);
    super::antigravity::prune_non_delegating_or_orphaned_placeholder_runs(
        thread,
        &non_delegating_ids,
    );
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

