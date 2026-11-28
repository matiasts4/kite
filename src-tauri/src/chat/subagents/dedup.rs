use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

static APP_SESSION_STARTED_AT_MS: OnceLock<i64> = OnceLock::new();

/// Initializes and returns the app-session baseline timestamp (Unix ms).
pub fn app_session_started_at_ms() -> i64 {
    *APP_SESSION_STARTED_AT_MS.get_or_init(now_ms)
}

/// Filter and inclusion options for cross-thread subagent snapshots.
pub struct GlobalSubagentRunsOptions<'a> {
    pub workspace_id: Option<&'a str>,
    pub limit: usize,
    pub include_history: bool,
    pub active_thread_ids: Option<&'a HashSet<String>>,
    pub session_started_at_ms: Option<i64>,
}

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
    merge_same_subagent_id_runs(&mut out);
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
    list_all_subagent_runs_snapshot_with_options(GlobalSubagentRunsOptions {
        workspace_id,
        limit,
        include_history: true,
        active_thread_ids: None,
        session_started_at_ms: None,
    })
}

/// Returns lightweight deduplicated subagent run summaries, defaulting to the current app session
/// unless `include_history` is true or the parent thread has been resumed/activated in this session.
pub fn list_all_subagent_runs_snapshot_with_options(opts: GlobalSubagentRunsOptions<'_>) -> Value {
    let session_cutoff_ms = opts
        .session_started_at_ms
        .unwrap_or_else(app_session_started_at_ms);

    let raw_entries: Vec<(u8, i64, i64, bool, String, Value)> = {
        let Ok(all_threads) = threads().lock() else {
            return json!({
                "ok": true,
                "runs": [],
                "totalCount": 0,
                "activeCount": 0,
                "waitingCount": 0,
                "historyCount": 0,
                "sessionStartedAtMs": session_cutoff_ms,
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

        let mut collected = Vec::new();
        for thread in all_threads.iter() {
            if crate::chat::archived_at_ms(thread).is_some() {
                continue;
            }
            let thread_ws = thread.get("workspaceId").and_then(Value::as_str);
            if let Some(filter_ws) = opts.workspace_id.map(str::trim).filter(|s| !s.is_empty()) {
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

            let parent_resumed_in_session = opts
                .active_thread_ids
                .is_some_and(|ids| ids.contains(thread_id))
                || crate::chat::threads::last_turn_at_unix_ms(thread)
                    .is_some_and(|ts| ts >= session_cutoff_ms);

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
                let started_at = run
                    .get("startedAtUnixMs")
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                let updated_at = run
                    .get("updatedAtUnixMs")
                    .and_then(Value::as_i64)
                    .unwrap_or(started_at);

                // Deliberately ignore updatedAtUnixMs here because startup/lazy orphan healing stamps now_ms().
                let prelim_in_session =
                    priority < 2 || started_at >= session_cutoff_ms || parent_resumed_in_session;

                collected.push((
                    priority,
                    updated_at,
                    started_at,
                    prelim_in_session,
                    thread_id.to_string(),
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
        collected
    };

    // Check live/warm session status outside `threads()` lock to keep lock order acyclic.
    let warm_thread_ids: HashSet<String> = if opts.include_history {
        HashSet::new()
    } else {
        let candidate_tids: HashSet<&str> = raw_entries
            .iter()
            .filter(|(_, _, _, prelim, _, _)| !*prelim)
            .map(|(_, _, _, _, tid, _)| tid.as_str())
            .collect();
        if candidate_tids.is_empty() {
            HashSet::new()
        } else if let Ok(mgr) = crate::chat::runtime::session_manager().lock() {
            candidate_tids
                .into_iter()
                .filter(|tid| {
                    mgr.status(tid)
                        .is_some_and(|record| record.is_warm() || !record.is_idle())
                })
                .map(str::to_string)
                .collect()
        } else {
            HashSet::new()
        }
    };

    let mut entries: Vec<(u8, i64, i64, Value)> = Vec::new();
    let mut active_count = 0usize;
    let mut waiting_count = 0usize;
    let mut history_count = 0usize;

    for (priority, updated_at, started_at, prelim_in_session, thread_id, entry) in raw_entries {
        let in_current_session = prelim_in_session || warm_thread_ids.contains(&thread_id);
        if !opts.include_history && !in_current_session {
            history_count += 1;
            continue;
        }
        if priority < 2 {
            active_count += 1;
        }
        if priority == 0 {
            waiting_count += 1;
        }
        entries.push((priority, updated_at, started_at, entry));
    }

    entries.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then_with(|| b.1.cmp(&a.1))
            .then_with(|| b.2.cmp(&a.2))
    });

    let total_count = entries.len();
    let max_entries = opts.limit.clamp(1, 500);
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
        "historyCount": history_count,
        "sessionStartedAtMs": session_cutoff_ms,
    })
}

fn is_settled_run(run: &Value) -> bool {
    matches!(
        run.get("status").and_then(Value::as_str),
        Some("completed" | "failed" | "killed")
    )
}

fn run_child_thread_id(run: &Value) -> Option<&str> {
    run.get("childThreadId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn run_has_transcript_uri(run: &Value) -> bool {
    run.get("transcriptUri")
        .and_then(Value::as_str)
        .is_some_and(|s| !s.trim().is_empty())
}

fn run_items_len(run: &Value) -> usize {
    run.get("items").and_then(Value::as_array).map_or(0, Vec::len)
}

/// Empties `items` on a run whose step transcript is recoverable through
/// `build_subagent_detail` (child thread or transcript file), keeping `stepCount` so cards
/// still report progress. Runs without an external source keep their inline items.
pub fn strip_external_run_items(run: &mut Value) -> bool {
    if run_items_len(run) == 0 || (run_child_thread_id(run).is_none() && !run_has_transcript_uri(run)) {
        return false;
    }
    let reported = run.get("stepCount").and_then(Value::as_u64).unwrap_or(0);
    if reported == 0 {
        let items = run
            .get("items")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let (steps, latest) = summarize_run_progress(items);
        run["stepCount"] = json!(steps);
        if run.get("latestActivity").is_none_or(Value::is_null) {
            if let Some(l) = latest {
                run["latestActivity"] = json!(l);
            }
        }
    }
    run["items"] = json!([]);
    run["itemsOmitted"] = json!(true);
    true
}

fn ensure_item_text_string(items: &mut [Value]) {
    for item in items.iter_mut() {
        if let Some(obj) = item.as_object_mut() {
            if !obj.get("text").is_some_and(Value::is_string) {
                obj.insert("text".into(), Value::String(String::new()));
            }
        }
    }
}

/// Renderer-facing thread projection: subagent step transcripts are hydrated on demand
/// instead of riding along with every thread load, and every item carries a string `text`.
pub fn project_thread_for_ipc(mut thread: Value) -> Value {
    if let Some(items) = thread.get_mut("items").and_then(Value::as_array_mut) {
        ensure_item_text_string(items);
    }
    if let Some(runs) = thread.get_mut("subagentRuns").and_then(Value::as_array_mut) {
        for run in runs.iter_mut() {
            strip_external_run_items(run);
            if let Some(run_items) = run.get_mut("items").and_then(Value::as_array_mut) {
                ensure_item_text_string(run_items);
            }
        }
    }
    thread
}

/// Drops step transcripts that settled child-thread-backed runs duplicate inside their
/// parent thread. The child thread persists the same steps and `build_subagent_detail`
/// prefers them, so nothing visible is lost. Runs with a transcript file keep their items.
pub fn compact_settled_child_backed_run_items(all_threads: &mut [Value], parent_id: &str) -> bool {
    let Some(parent_idx) = all_threads
        .iter()
        .position(|t| t.get("id").and_then(Value::as_str) == Some(parent_id))
    else {
        return false;
    };
    let candidates: HashSet<String> = all_threads[parent_idx]
        .get("subagentRuns")
        .and_then(Value::as_array)
        .map(|runs| {
            runs.iter()
                .filter(|r| is_settled_run(r) && !run_has_transcript_uri(r) && run_items_len(r) > 0)
                .filter_map(|r| run_child_thread_id(r).map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    if candidates.is_empty() {
        return false;
    }
    let backed: HashSet<String> = all_threads
        .iter()
        .filter_map(|t| {
            let id = t.get("id").and_then(Value::as_str)?;
            let has_items = t
                .get("items")
                .and_then(Value::as_array)
                .is_some_and(|items| !items.is_empty());
            (has_items && candidates.contains(id)).then(|| id.to_string())
        })
        .collect();
    if backed.is_empty() {
        return false;
    }
    let mut changed = false;
    if let Some(runs) = all_threads[parent_idx]
        .get_mut("subagentRuns")
        .and_then(Value::as_array_mut)
    {
        for run in runs.iter_mut() {
            let compactable = is_settled_run(run)
                && !run_has_transcript_uri(run)
                && run_child_thread_id(run).is_some_and(|cid| backed.contains(cid));
            if compactable && strip_external_run_items(run) {
                if let Some(obj) = run.as_object_mut() {
                    obj.remove("itemsOmitted");
                }
                changed = true;
            }
        }
    }
    changed
}

fn run_progress_rank(run: &Value) -> (usize, u64, i64) {
    (
        run_items_len(run),
        run.get("stepCount").and_then(Value::as_u64).unwrap_or(0),
        run.get("updatedAtUnixMs").and_then(Value::as_i64).unwrap_or(0),
    )
}

pub(crate) fn extract_started_thread_id_from_text(text: &str) -> Option<String> {
    for marker in [
        "started thread:",
        "[subagent_id: thread:",
        "\"address\":\"thread:",
        "\"address\": \"thread:",
    ] {
        if let Some(pos) = text.find(marker) {
            let rest = &text[pos + marker.len()..];
            let token: String = rest
                .chars()
                .take_while(|c| c.is_ascii_hexdigit() || *c == '-')
                .collect();
            if token.len() >= 8 {
                return Some(token);
            }
        }
    }
    None
}

/// Collapses stored runs that share a `subagentId` into one record: the most advanced
/// record wins, missing fields are filled from the other, and lifecycle fields follow the
/// most recent update.
pub fn merge_same_subagent_id_runs(runs: &mut Vec<Value>) {
    let mut index_by_id: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut merged: Vec<Value> = Vec::with_capacity(runs.len());
    for run in runs.drain(..) {
        let sid = run
            .get("subagentId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .or_else(|| {
                run.get("childThreadId")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
            })
            .unwrap_or("")
            .to_string();
        let Some(&idx) = (!sid.is_empty()).then(|| index_by_id.get(&sid)).flatten() else {
            if !sid.is_empty() {
                index_by_id.insert(sid, merged.len());
            }
            merged.push(run);
            continue;
        };
        let existing = merged[idx].clone();
        let (mut winner, loser) = if run_progress_rank(&run) > run_progress_rank(&existing) {
            (run, existing)
        } else {
            (existing, run)
        };
        let loser_newer = run_progress_rank(&loser).2 > run_progress_rank(&winner).2;
        // A newer placeholder must never resurrect a run that already settled.
        let keep_settled_status = is_settled_run(&winner) && !is_settled_run(&loser);
        let loser_is_settled = is_settled_run(&loser) && !is_settled_run(&winner);
        if let (Some(w), Some(l)) = (winner.as_object_mut(), loser.as_object()) {
            for (key, value) in l {
                if !value.is_null() && w.get(key).is_none_or(Value::is_null) {
                    w.insert(key.clone(), value.clone());
                }
            }
            let w_call = w
                .get("parentToolCallId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            let l_call = l
                .get("parentToolCallId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            if (w_call.is_empty() || w_call.starts_with("dispatch-subagent-"))
                && !l_call.is_empty()
                && !l_call.starts_with("dispatch-subagent-")
            {
                w.insert("parentToolCallId".to_string(), json!(l_call));
            }
            let w_start = w.get("startedAtUnixMs").and_then(Value::as_i64).unwrap_or(0);
            let l_start = l.get("startedAtUnixMs").and_then(Value::as_i64).unwrap_or(0);
            if w_start > 0 && l_start > 0 && l_start < w_start {
                w.insert("startedAtUnixMs".to_string(), json!(l_start));
            }
            if loser_is_settled {
                for key in ["status", "completedAtUnixMs"] {
                    if let Some(value) = l.get(key) {
                        if !value.is_null() {
                            w.insert(key.to_string(), value.clone());
                        }
                    }
                }
            }
            if loser_newer {
                for key in ["status", "latestActivity", "completedAtUnixMs", "updatedAtUnixMs"] {
                    if keep_settled_status && matches!(key, "status" | "completedAtUnixMs") {
                        continue;
                    }
                    if let Some(value) = l.get(key) {
                        w.insert(key.to_string(), value.clone());
                    }
                }
            }
        }
        merged[idx] = winner;
    }
    *runs = merged;
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
        merge_same_subagent_id_runs(runs);
    }

    let receipt_bindings: Vec<(String, String)> = thread
        .get("items")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|it| {
                    let id = it.get("id").and_then(Value::as_str)?.trim();
                    if id.is_empty() || id.starts_with("dispatch-subagent-") {
                        return None;
                    }
                    let text = it.get("text").and_then(Value::as_str)?;
                    let cid = extract_started_thread_id_from_text(text)?;
                    Some((id.to_string(), cid))
                })
                .collect()
        })
        .unwrap_or_default();

    if !receipt_bindings.is_empty() {
        if let Some(runs) = thread.get_mut("subagentRuns").and_then(Value::as_array_mut) {
            for (call_id, true_cid) in &receipt_bindings {
                if let Some(run) = runs.iter_mut().find(|r| {
                    r.get("childThreadId").and_then(Value::as_str) == Some(true_cid.as_str())
                        || r.get("subagentId").and_then(Value::as_str) == Some(true_cid.as_str())
                }) {
                    run["parentToolCallId"] = json!(call_id);
                }
            }
            for run in runs.iter_mut() {
                let r_cid = run
                    .get("childThreadId")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_string();
                let r_call = run
                    .get("parentToolCallId")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if r_cid.is_empty() || r_call.is_empty() {
                    continue;
                }
                let call_owned_by_other = receipt_bindings
                    .iter()
                    .any(|(call_id, owner_cid)| call_id == &r_call && owner_cid != &r_cid);
                if call_owned_by_other {
                    if let Some((own_call, _)) = receipt_bindings
                        .iter()
                        .find(|(_, owner_cid)| owner_cid == &r_cid)
                    {
                        run["parentToolCallId"] = json!(own_call);
                    }
                }
            }
        }

        let run_snapshots: std::collections::HashMap<String, Value> = thread
            .get("subagentRuns")
            .and_then(Value::as_array)
            .map(|runs| {
                runs.iter()
                    .filter_map(|r| {
                        let cid = r.get("childThreadId").and_then(Value::as_str)?.trim();
                        (!cid.is_empty()).then(|| (cid.to_string(), r.clone()))
                    })
                    .collect()
            })
            .unwrap_or_default();

        if let Some(items) = thread.get_mut("items").and_then(Value::as_array_mut) {
            for (call_id, true_cid) in &receipt_bindings {
                let Some(item) = items
                    .iter_mut()
                    .find(|it| it.get("id").and_then(Value::as_str) == Some(call_id.as_str()))
                else {
                    continue;
                };
                let cur_meta_cid = item
                    .pointer("/subagentMeta/childThreadId")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if cur_meta_cid != true_cid {
                    let mut top_terminal_status: Option<String> = None;
                    if let Some(meta_obj) =
                        item.get_mut("subagentMeta").and_then(Value::as_object_mut)
                    {
                        meta_obj.insert("subagentId".to_string(), json!(true_cid));
                        meta_obj.insert("childThreadId".to_string(), json!(true_cid));
                        if let Some(run) = run_snapshots.get(true_cid) {
                            if let Some(st) = run.get("status").and_then(Value::as_str) {
                                meta_obj.insert("status".to_string(), json!(st));
                                let top_terminal = matches!(st, "completed" | "failed" | "killed");
                                if top_terminal {
                                    top_terminal_status =
                                        Some(if st == "killed" { "error" } else { st }.to_string());
                                }
                            }
                            if let Some(steps) = run.get("stepCount") {
                                meta_obj.insert("stepCount".to_string(), steps.clone());
                            }
                            if let Some(latest) = run.get("latestActivity") {
                                meta_obj.insert("latestActivity".to_string(), latest.clone());
                            }
                        }
                    }
                    if let Some(top_st) = top_terminal_status {
                        item["status"] = json!(top_st);
                        item["streaming"] = json!(false);
                    }
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

    // Retroactively heal persisted subagent runs & timeline items that were falsely marked
    // `"failed"` solely because a blocking `wait` slice timed out while the child subagent
    // remained running or settled cleanly.
    let mut healed_run_states: std::collections::HashMap<String, (String, Option<String>, u64)> =
        std::collections::HashMap::new();
    let timeout_item_ids: HashSet<String> = thread
        .get("items")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|it| {
                    let is_timeout = it
                        .get("text")
                        .and_then(Value::as_str)
                        .is_some_and(|t| crate::acp::is_wait_timeout_receipt(Some(t)));
                    if !is_timeout {
                        return None;
                    }
                    it.get("id").and_then(Value::as_str).map(str::to_string)
                })
                .collect()
        })
        .unwrap_or_default();

    if let Some(runs) = thread.get_mut("subagentRuns").and_then(Value::as_array_mut) {
        for run in runs.iter_mut() {
            let r_status = run.get("status").and_then(Value::as_str).unwrap_or("");
            let r_cid = run
                .get("childThreadId")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("")
                .to_string();
            let r_sid = run
                .get("subagentId")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("")
                .to_string();
            let r_ptc = run
                .get("parentToolCallId")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("")
                .to_string();
            let latest_is_timeout = run
                .get("latestActivity")
                .and_then(Value::as_str)
                .is_some_and(|la| crate::acp::is_wait_timeout_receipt(Some(la)));
            let linked_timeout =
                latest_is_timeout || (!r_ptc.is_empty() && timeout_item_ids.contains(&r_ptc));
            if r_status == "failed" && linked_timeout {
                let items_arr = run.get("items").and_then(Value::as_array);
                let has_real_error_item = items_arr.is_some_and(|arr| {
                    arr.iter().any(|it| {
                        it.get("kind").and_then(Value::as_str) == Some("error")
                            && !it
                                .get("text")
                                .and_then(Value::as_str)
                                .is_some_and(|t| crate::acp::is_wait_timeout_receipt(Some(t)))
                    })
                });
                let has_assistant_reply = items_arr.is_some_and(|arr| {
                    arr.iter().any(|it| {
                        it.get("kind").and_then(Value::as_str) == Some("assistant")
                            && it
                                .get("text")
                                .and_then(Value::as_str)
                                .is_some_and(|t| !t.trim().is_empty())
                    })
                });
                let steps = run.get("stepCount").and_then(Value::as_u64).unwrap_or(0);
                if !has_real_error_item && (has_assistant_reply || steps > 0) {
                    run["status"] = json!("completed");
                    if latest_is_timeout {
                        if let Some(obj) = run.as_object_mut() {
                            obj.remove("latestActivity");
                        }
                    }
                }
            }
            let effective_status = run
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let effective_latest = run
                .get("latestActivity")
                .and_then(Value::as_str)
                .filter(|la| !crate::acp::is_wait_timeout_receipt(Some(la)))
                .map(str::to_string);
            let effective_steps = run.get("stepCount").and_then(Value::as_u64).unwrap_or(0);
            if !effective_status.is_empty() && effective_status != "failed" {
                for key in [r_cid, r_sid, r_ptc] {
                    if !key.is_empty() {
                        healed_run_states.insert(
                            key,
                            (
                                effective_status.clone(),
                                effective_latest.clone(),
                                effective_steps,
                            ),
                        );
                    }
                }
            }
        }
    }

    if !healed_run_states.is_empty() {
        if let Some(items) = thread.get_mut("items").and_then(Value::as_array_mut) {
            for it in items.iter_mut() {
                if it.get("toolKind").and_then(Value::as_str) != Some("subagent") {
                    continue;
                }
                let is_timeout_item = it
                    .get("text")
                    .and_then(Value::as_str)
                    .is_some_and(|t| crate::acp::is_wait_timeout_receipt(Some(t)));
                if !is_timeout_item {
                    continue;
                }
                let cur_status = it.get("status").and_then(Value::as_str).unwrap_or("");
                let meta_status = it
                    .pointer("/subagentMeta/status")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if cur_status != "failed" && meta_status != "failed" {
                    continue;
                }
                let item_id = it
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_string();
                let cid = it
                    .pointer("/subagentMeta/childThreadId")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .or_else(|| {
                        it.get("text")
                            .and_then(Value::as_str)
                            .and_then(extract_started_thread_id_from_text)
                    });
                let sid = it
                    .pointer("/subagentMeta/subagentId")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .unwrap_or("")
                    .to_string();
                let matched = cid
                    .as_deref()
                    .and_then(|k| healed_run_states.get(k))
                    .or_else(|| (!sid.is_empty()).then(|| healed_run_states.get(sid.as_str())).flatten())
                    .or_else(|| {
                        (!item_id.is_empty())
                            .then(|| healed_run_states.get(item_id.as_str()))
                            .flatten()
                    })
                    .cloned();
                if let Some((run_status, latest, steps)) = matched {
                    let top_status = match run_status.as_str() {
                        "running" | "waiting" => "running",
                        "killed" => "error",
                        _ => "completed",
                    };
                    it["status"] = json!(top_status);
                    it["streaming"] = json!(false);
                    if let Some(meta_obj) =
                        it.get_mut("subagentMeta").and_then(Value::as_object_mut)
                    {
                        meta_obj.insert("status".to_string(), json!(run_status));
                        if let Some(ref c) = cid {
                            meta_obj.insert("childThreadId".to_string(), json!(c));
                            if sid.is_empty() || sid == item_id {
                                meta_obj.insert("subagentId".to_string(), json!(c));
                            }
                        }
                        if steps > 0 {
                            meta_obj.insert("stepCount".to_string(), json!(steps));
                        }
                        if let Some(ref la) = latest {
                            meta_obj.insert("latestActivity".to_string(), json!(la));
                        } else if meta_obj
                            .get("latestActivity")
                            .and_then(Value::as_str)
                            .is_some_and(|la| crate::acp::is_wait_timeout_receipt(Some(la)))
                        {
                            meta_obj.remove("latestActivity");
                        }
                    }
                }
            }
        }
    }
}

