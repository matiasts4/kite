use crate::chat::threads::{
    apply_derived_title_if_needed, chat_item, human_user_prompt, load_thread, replace_thread,
    touch, upsert_item,
};
use crate::chat::utils::{chat_log, now_ms};
use crate::persist::{notifications, persist, threads};
use serde_json::{json, Value};
use uuid::Uuid;

use super::pipeline::{flush_pipeline_deltas, pipeline_runs};
use super::state::{live_cv, live_turns, prune_stale_runs};
use super::turn::{append_event, start_turn};

fn is_in_flight_status(status: Option<&str>) -> bool {
    matches!(
        status,
        Some("running" | "waiting" | "queued" | "inProgress" | "in_progress" | "pending" | "started")
    )
}

fn is_non_terminal_subagent_status(status: Option<&str>) -> bool {
    !matches!(status, Some("completed" | "failed" | "killed"))
}

fn has_pending_approval_or_input(thread: &Value) -> bool {
    thread.get("pendingApproval").is_some_and(|v| !v.is_null())
        || thread
            .get("pendingUserInput")
            .is_some_and(|v| !v.is_null())
}

fn is_quiet_turn_note(item: &Value) -> bool {
    item.get("kind").and_then(|v| v.as_str()) == Some("note")
        && item.get("text").and_then(|v| v.as_str()) == Some(super::turn::QUIET_TURN_NOTE_TEXT)
}

fn prune_quiet_turn_notes(items: &mut Vec<Value>) -> bool {
    let before = items.len();
    items.retain(|it| !is_quiet_turn_note(it));
    items.len() != before
}

fn settle_implementing_plan_slot(thread: &mut Value, target_status: &str) {
    let Some(aid) = thread
        .get("activePlanId")
        .and_then(|v| v.as_str())
        .map(str::to_string)
    else {
        return;
    };
    let Some(plans) = thread.get_mut("plans").and_then(|v| v.as_array_mut()) else {
        return;
    };
    if let Some(slot) = plans
        .iter_mut()
        .find(|p| p.get("id").and_then(|v| v.as_str()) == Some(aid.as_str()))
    {
        if slot.get("status").and_then(|v| v.as_str()) == Some("implementing") {
            slot["status"] = json!(target_status);
        }
    }
}

fn has_in_flight_thread_work(thread: &Value) -> bool {
    let has_item = thread
        .get("items")
        .and_then(Value::as_array)
        .is_some_and(|arr| {
            arr.iter().any(|it| {
                it.get("streaming").and_then(Value::as_bool) == Some(true)
                    || is_in_flight_status(it.get("status").and_then(Value::as_str))
                    || is_in_flight_status(it.pointer("/subagentMeta/status").and_then(Value::as_str))
                    || is_quiet_turn_note(it)
            })
        });
    let has_run = thread
        .get("subagentRuns")
        .and_then(Value::as_array)
        .is_some_and(|runs| {
            runs.iter()
                .any(|r| is_non_terminal_subagent_status(r.get("status").and_then(Value::as_str)))
        });
    let has_worker = thread
        .pointer("/swarmState/members")
        .and_then(Value::as_array)
        .is_some_and(|members| {
            members
                .iter()
                .any(|m| m.get("state").and_then(Value::as_str) == Some("working"))
        });
    has_item || has_run || has_worker
}

struct SettledSubagents {
    statuses: std::collections::HashMap<String, String>,
    preserved_async_child_ids: std::collections::HashSet<String>,
}

fn has_non_empty_child_thread_id(val: &Value) -> bool {
    val.get("childThreadId")
        .and_then(Value::as_str)
        .is_some_and(|s| !s.trim().is_empty())
}

fn settle_in_flight_subagent_runs(
    thread: &mut Value,
    fallback_status: &str,
    settle_async_children: bool,
) -> SettledSubagents {
    let mut out = SettledSubagents {
        statuses: std::collections::HashMap::new(),
        preserved_async_child_ids: std::collections::HashSet::new(),
    };
    let now = now_ms();
    let Some(runs) = thread.get_mut("subagentRuns").and_then(Value::as_array_mut) else {
        return out;
    };
    for run in runs.iter_mut() {
        let cur = run.get("status").and_then(Value::as_str);
        if !settle_async_children && has_non_empty_child_thread_id(run) && is_non_terminal_subagent_status(cur) {
            if let Some(sid) = run.get("subagentId").and_then(Value::as_str) {
                out.preserved_async_child_ids.insert(sid.to_string());
            }
            if let Some(call_id) = run.get("parentToolCallId").and_then(Value::as_str) {
                out.preserved_async_child_ids.insert(call_id.to_string());
            }
            continue;
        }
        let resolved = if is_non_terminal_subagent_status(cur) {
            let next = if fallback_status == "completed"
                || crate::chat::subagents::child_transcript_ended_with_final_response(
                    run.get("transcriptUri").and_then(Value::as_str),
                )
            {
                "completed"
            } else {
                fallback_status
            };
            run["status"] = json!(next);
            if run.get("completedAtUnixMs").is_none_or(Value::is_null) {
                run["completedAtUnixMs"] = json!(now);
            }
            run["updatedAtUnixMs"] = json!(now);
            next.to_string()
        } else {
            cur.unwrap_or("completed").to_string()
        };
        if let Some(sid) = run.get("subagentId").and_then(Value::as_str) {
            out.statuses.insert(sid.to_string(), resolved.clone());
        }
        if let Some(call_id) = run.get("parentToolCallId").and_then(Value::as_str) {
            out.statuses.insert(call_id.to_string(), resolved);
        }
    }
    out
}

/// Shared settlement pass for both live turn completion (`finish_run`, where async
/// child threads and swarm workers may still be active) and orphaned-turn recovery
/// (`heal_orphaned_running_thread`, where no runtime processes remain).
fn settle_in_flight_thread_work(
    thread: &mut Value,
    waiting_for_permission: bool,
    tool_settled_status: &str,
    subagent_fallback_status: &str,
    settle_async_children: bool,
) {
    let subagents = if waiting_for_permission {
        SettledSubagents {
            statuses: std::collections::HashMap::new(),
            preserved_async_child_ids: std::collections::HashSet::new(),
        }
    } else {
        settle_in_flight_subagent_runs(thread, subagent_fallback_status, settle_async_children)
    };

    const BOGUS_INTERRUPTED_TEXT: &str =
        "Interrupted before completion; retried in subsequent steps.";
    if let Some(arr) = thread.get_mut("items").and_then(|v| v.as_array_mut()) {
        prune_quiet_turn_notes(arr);
        for it in arr.iter_mut() {
            let is_subagent = it.get("toolKind").and_then(Value::as_str) == Some("subagent")
                || it.get("subagentMeta").is_some();
            if !waiting_for_permission && is_subagent {
                let item_id = it.get("id").and_then(Value::as_str);
                let meta_sid = it.pointer("/subagentMeta/subagentId").and_then(Value::as_str);
                let it_cur = it.get("status").and_then(Value::as_str);
                let meta_cur = it.pointer("/subagentMeta/status").and_then(Value::as_str);
                let is_preserved_async = !settle_async_children
                    && (meta_sid.is_some_and(|sid| subagents.preserved_async_child_ids.contains(sid))
                        || item_id.is_some_and(|id| subagents.preserved_async_child_ids.contains(id))
                        || (it
                            .get("subagentMeta")
                            .is_some_and(has_non_empty_child_thread_id)
                            && (is_in_flight_status(it_cur)
                                || is_non_terminal_subagent_status(meta_cur))));
                if is_preserved_async {
                    continue;
                }
            }
            if it.get("streaming").and_then(|v| v.as_bool()) == Some(true) {
                it["streaming"] = json!(false);
            }
            if waiting_for_permission {
                continue;
            }
            if is_subagent {
                let item_id = it.get("id").and_then(Value::as_str);
                let meta_sid = it.pointer("/subagentMeta/subagentId").and_then(Value::as_str);
                let it_cur = it.get("status").and_then(Value::as_str);
                let meta_cur = it.pointer("/subagentMeta/status").and_then(Value::as_str);
                if is_in_flight_status(it_cur)
                    || meta_cur.is_some_and(|s| is_non_terminal_subagent_status(Some(s)))
                {
                    let matched = meta_sid
                        .and_then(|sid| subagents.statuses.get(sid))
                        .or_else(|| item_id.and_then(|id| subagents.statuses.get(id)))
                        .map(String::as_str)
                        .unwrap_or(subagent_fallback_status);
                    if is_non_terminal_subagent_status(it_cur) {
                        it["status"] = json!(matched);
                    }
                    if matched == "completed"
                        && it.get("text").and_then(Value::as_str) == Some(BOGUS_INTERRUPTED_TEXT)
                    {
                        it["status"] = json!("completed");
                        it["text"] = json!("");
                        it["exitCode"] = Value::Null;
                    }
                    if let Some(meta) = it.get_mut("subagentMeta").and_then(Value::as_object_mut) {
                        let m_cur = meta.get("status").and_then(Value::as_str);
                        if is_non_terminal_subagent_status(m_cur) {
                            meta.insert("status".into(), json!(matched));
                        }
                    }
                }
            } else if is_in_flight_status(it.get("status").and_then(Value::as_str)) {
                it["status"] = json!(tool_settled_status);
            }
        }
    }

    if !waiting_for_permission && settle_async_children {
        if let Some(members) = thread
            .pointer_mut("/swarmState/members")
            .and_then(Value::as_array_mut)
        {
            for member in members.iter_mut() {
                if member.get("state").and_then(Value::as_str) == Some("working") {
                    member["state"] = json!("stopped");
                }
            }
        }
    }
}

/// Idempotently settles a persisted thread left in `"running"` (or, when
/// `settle_idle_work` is true, an idle/error thread still holding orphaned
/// streaming items, non-terminal subagent runs, or `"working"` swarm workers).
/// Returns `true` when any field changed so callers can persist safely.
pub fn heal_orphaned_thread_with_children(
    thread: &mut Value,
    stopped_by_user: bool,
    settle_idle_work: bool,
    settle_async_children: bool,
) -> bool {
    let status_str = thread.get("status").and_then(Value::as_str);
    let waiting_for_permission = has_pending_approval_or_input(thread);
    let is_running = status_str == Some("running");
    let has_in_flight = has_in_flight_thread_work(thread);
    if !is_running
        && !((stopped_by_user || settle_idle_work) && !waiting_for_permission && has_in_flight)
    {
        return false;
    }

    if waiting_for_permission {
        thread["status"] = json!("waiting");
    } else if status_str != Some("error") {
        thread["status"] = json!("idle");
    }
    if stopped_by_user && !waiting_for_permission && settle_async_children {
        thread["stoppedByBuilder"] = json!(true);
    }

    if !waiting_for_permission {
        settle_implementing_plan_slot(thread, "interrupted");
        settle_in_flight_thread_work(thread, false, "stopped", "killed", settle_async_children);
    }

    if is_running || stopped_by_user {
        apply_derived_title_if_needed(thread, "generated", true);
    }
    true
}

pub fn heal_orphaned_thread_with_options(
    thread: &mut Value,
    stopped_by_user: bool,
    settle_idle_work: bool,
) -> bool {
    heal_orphaned_thread_with_children(thread, stopped_by_user, settle_idle_work, true)
}

/// Idempotently settles a persisted thread left in `"running"` after an app
/// restart or forced stop without inventing error items or `turnFailure`.
/// Returns `true` when any field changed so callers can persist safely.
pub fn heal_orphaned_running_thread(thread: &mut Value, stopped_by_user: bool) -> bool {
    heal_orphaned_thread_with_options(thread, stopped_by_user, stopped_by_user)
}

pub fn finish_run(run_id: &str, ok: bool, stopped: bool, error_text: &str) {
    finish_run_with_options(run_id, ok, stopped, error_text, false);
}

pub fn finish_run_with_options(
    run_id: &str,
    ok: bool,
    stopped: bool,
    error_text: &str,
    preserve_async_children: bool,
) {
    chat_log(&format!("finish_run starting: run_id={}, ok={}, stopped={}", run_id, ok, stopped));
    if let Some((thread_id, assistant_id)) = {
        let live = live_turns().lock().unwrap();
        live.runs.get(run_id).map(|run| {
            let thread_id = live
                .by_thread
                .iter()
                .find(|(_, id)| id.as_str() == run_id)
                .map(|(thread, _)| thread.clone())
                .unwrap_or_default();
            (thread_id, run.assistant_id.clone())
        })
    } {
        flush_pipeline_deltas(&thread_id, run_id, &assistant_id);
        pipeline_runs().lock().unwrap().remove(run_id);
    }
    super::pipeline::clear_pending_delta_flush(run_id);
    super::stream_json::clear_stream_run_state(run_id);
    let (thread_id, assistant_id, assistant_text, routine_id) = {
        let mut live = live_turns().lock().unwrap();
        let thread_id = live.by_thread.iter().find(|(_, id)| id.as_str() == run_id).map(|(thread, _)| thread.clone());
        let Some(run) = live.runs.get_mut(run_id) else {
            chat_log(&format!("finish_run: run {} not found in live_turns", run_id));
            return;
        };
        if run.closing || run.finished {
            chat_log(&format!("finish_run: run {} already closing or finished", run_id));
            return;
        }
        run.closing = true;
        (thread_id, run.assistant_id.clone(), run.assistant_text.clone(), run.routine_id.clone())
    };
    let thread_id = thread_id.unwrap_or_default();
    // A dropped connection after the reply was delivered is a notice, not a failed turn.
    let ok = ok
        || (!stopped
            && super::post_reply::absorb_connection_loss_after_reply(&thread_id, run_id, error_text));
    let mut profile_for_routine: Option<String> = None;
    let mut reflection_task: Option<(String, String, String)> = None;
    let mut quota_events: Option<(Value, Value)> = None;
    let mut exhausted_turn_ctx: Option<ExhaustedThreadTurnContext> = None;

    let mut error_item = if !ok && !stopped && assistant_text.is_empty() && !error_text.is_empty() {
        Some(chat_item(&format!("e{}", Uuid::new_v4().simple()), "error", error_text, false))
    } else {
        None
    };

    let final_item = chat_item(&assistant_id, "assistant", &assistant_text, false);
    let mut waiting_for_permission = false;

    // Drain any queued/active non-blocking diffs for this turn before snapshotting thread items and settling.
    crate::chat::checkpoints::flush_run_diffs(run_id, std::time::Duration::from_secs(3));

    if !thread_id.is_empty() {
        let mut items = threads().lock().unwrap();
        if let Some(thread) = items.iter_mut().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id.as_str())) {
            waiting_for_permission = has_pending_approval_or_input(thread);
            if ok && !stopped && !waiting_for_permission {
                if let Some(obj) = thread.as_object_mut() {
                    obj.remove("turnFailure");
                }
            }
            if !ok && !stopped && !waiting_for_permission && error_item.is_none() {
                let transient_failure_msg = match thread.pointer("/turnFailure/kind").and_then(Value::as_str) {
                    Some("processError" | "cliUsageError") => thread
                        .pointer("/turnFailure/message")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|msg| !msg.is_empty())
                        .map(str::to_string),
                    _ => None,
                };
                if let Some(msg) = transient_failure_msg {
                    let already_in_items = thread
                        .get("items")
                        .and_then(Value::as_array)
                        .is_some_and(|arr| {
                            arr.iter()
                                .rev()
                                .take_while(|it| it.get("kind").and_then(Value::as_str) != Some("user"))
                                .any(|it| {
                                    it.get("kind").and_then(Value::as_str) == Some("error")
                                        && it.get("text").and_then(Value::as_str) == Some(msg.as_str())
                                })
                        });
                    if !already_in_items {
                        error_item = Some(chat_item(
                            &format!("e{}", Uuid::new_v4().simple()),
                            "error",
                            &msg,
                            false,
                        ));
                    }
                }
            }
            if let Some(ref err_it) = error_item {
                if !waiting_for_permission {
                    upsert_item(thread, err_it);
                }
            }
            if !assistant_text.is_empty() {
                upsert_item(thread, &final_item);
            }
            let final_status = if waiting_for_permission {
                "waiting"
            } else if ok || stopped {
                "idle"
            } else {
                "error"
            };
            thread["status"] = json!(final_status);
            if !waiting_for_permission && !stopped {
                let _ = crate::chat::kill_registry::try_mark_thread_settled(&thread_id);
            }

            let settled_tool_status = if ok && !stopped {
                "completed"
            } else if stopped {
                "stopped"
            } else {
                "failed"
            };
            let settled_subagent_status = if ok && !stopped {
                "completed"
            } else if stopped {
                "killed"
            } else {
                "failed"
            };
            settle_in_flight_thread_work(
                thread,
                waiting_for_permission,
                settled_tool_status,
                settled_subagent_status,
                stopped && !preserve_async_children,
            );
            crate::chat::subagents::reconcile_duplicate_subagent_state(thread);

            apply_derived_title_if_needed(thread, "generated", true);

            touch(thread);

            // Plan lifecycle handling
            let is_planning = thread.get("plan").and_then(|v| v.as_bool()).unwrap_or(false);
            let has_proposed_tag = assistant_text.contains("<proposed_plan>");
            if is_planning || has_proposed_tag {
                let plan_markdown = if let Some(start) = assistant_text.find("<proposed_plan>") {
                    let inner = &assistant_text[start + 15..];
                    if let Some(end) = inner.find("</proposed_plan>") {
                        inner[..end].trim().to_string()
                    } else {
                        inner.trim().to_string()
                    }
                } else {
                    assistant_text.trim().to_string()
                };

                if !plan_markdown.is_empty() {
                    let mut plans = thread.get("plans").and_then(|v| v.as_array()).cloned().unwrap_or_default();
                    let active_id = thread.get("activePlanId").and_then(|v| v.as_str()).map(|s| s.to_string());
                    let mut updated = false;

                    if let Some(ref aid) = active_id {
                        if let Some(slot) = plans.iter_mut().find(|p| p.get("id").and_then(|v| v.as_str()) == Some(aid.as_str())) {
                            let rev = slot.get("revision").and_then(|v| v.as_i64()).unwrap_or(1);
                            slot["revision"] = json!(rev + 1);
                            slot["markdown"] = json!(plan_markdown);
                            slot["status"] = json!("ready");
                            slot["sourceTurnId"] = json!(run_id);
                            updated = true;
                        }
                    }

                    if !updated {
                        let new_id = Uuid::new_v4().to_string();
                        plans.push(json!({
                            "id": new_id,
                            "revision": 1,
                            "sourceTurnId": run_id,
                            "markdown": plan_markdown,
                            "status": "ready"
                        }));
                        thread["activePlanId"] = json!(new_id);
                    }
                    thread["plans"] = Value::Array(plans);
                }
            } else {
                let target_plan_status = if ok {
                    "completed"
                } else if stopped {
                    "interrupted"
                } else {
                    "failed"
                };
                settle_implementing_plan_slot(thread, target_plan_status);
            }

            // ── Quota Exhaustion & Handoff Detection (snapshot only under lock) ──
            let current_provider = thread.get("provider").and_then(|v| v.as_str()).unwrap_or("antigravity").to_string();
            let combined_output = format!("{}\n{}", assistant_text, error_text);
            let quota_snapshot = if !ok && !stopped {
                crate::handoff::detect_quota_exhaustion(&current_provider, &combined_output).map(|reason| {
                    (
                        thread.clone(),
                        current_provider,
                        reason,
                        thread.get("workspaceId").and_then(|v| v.as_str()).map(String::from),
                        thread
                            .get("model")
                            .and_then(|v| v.as_str())
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .map(String::from),
                        thread
                            .get("profileId")
                            .and_then(|v| v.as_str())
                            .map(String::from),
                    )
                })
            } else {
                None
            };

            profile_for_routine = thread.get("profileId").and_then(|v| v.as_str()).map(|s| s.to_string());
            if ok {
                if let Some(ref pid) = profile_for_routine {
                    let user_prompt = human_user_prompt(&thread, true).unwrap_or("");
                    if !user_prompt.is_empty() {
                        reflection_task = Some((pid.clone(), user_prompt.to_string(), assistant_text.clone()));
                    }
                }
            }
            touch(thread);
            drop(items);

            if let Some((
                thread_snap,
                failed_provider,
                reason,
                workspace_id,
                requested_model,
                profile_id,
            )) = quota_snapshot
            {
                let handoff_capsule = crate::handoff::build_handoff_capsule_from_thread(
                    Some(&thread_snap),
                    &failed_provider,
                    &assistant_text,
                    workspace_id.as_deref(),
                );
                let suggestions_val =
                    crate::handoff::recommend_continuation_targets_direct(failed_provider.clone());
                let suggestions = suggestions_val
                    .get("suggestions")
                    .cloned()
                    .unwrap_or(json!([]));

                let offer = json!({
                    "failedProvider": failed_provider,
                    "reason": reason,
                    "partialOutput": assistant_text,
                    "handoffPrompt": handoff_capsule,
                    "suggestions": suggestions,
                    "offeredAtUnixMs": now_ms()
                });

                let handoff_item = json!({
                    "id": format!("qho_{}", Uuid::new_v4().simple()),
                    "kind": "quotaHandoff",
                    "text": format!("Quota exhausted on {}: {}", failed_provider, reason),
                    "title": "Quota limit reached",
                    "detail": Value::Null,
                    "status": "ready",
                    "streaming": false,
                    "exitCode": Value::Null,
                    "createdAtUnixMs": now_ms(),
                    "attachments": [],
                    "handoffOffer": offer
                });

                {
                    let mut relocked = threads().lock().unwrap();
                    if let Some(t) = relocked
                        .iter_mut()
                        .find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id.as_str()))
                    {
                        t["quotaHandoffOffer"] = offer.clone();
                        upsert_item(t, &handoff_item);
                        touch(t);
                    }
                }
                quota_events = Some((handoff_item, offer));

                if !waiting_for_permission && !stopped {
                    let account_provider =
                        crate::account_switcher::canon_provider(&failed_provider);
                    if !account_provider.is_empty() {
                        exhausted_turn_ctx = Some(ExhaustedThreadTurnContext {
                            thread_id: thread_id.clone(),
                            account_provider,
                            requested_model,
                            profile_id,
                            handoff_prompt: handoff_capsule,
                            now_unix_ms: now_ms(),
                        });
                    }
                }
            }
        } else {
            drop(items);
        }
    }

    let reflection_candidate = if let Some((ref pid, ref user_prompt, ref a_text)) = reflection_task {
        crate::agent_mind::apply_post_turn_reflection(pid, user_prompt, a_text)
    } else {
        None
    };

    // The process already exited, but the person still has to answer. A settled
    // notice here would announce a finished turn, including a failure chime.
    let mut resolved_waiting_notifs = false;
    if !waiting_for_permission && !thread_id.is_empty() {
        if let Ok(mut notifs) = notifications().lock() {
            let resolution = if stopped { "abandoned" } else { "runSettled" };
            for item in notifs.iter_mut() {
                let is_waiting = item
                    .get("isWaitingForInput")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if !is_waiting {
                    continue;
                }
                let matches_run = item
                    .get("runId")
                    .and_then(Value::as_str)
                    .is_some_and(|r| r == run_id);
                let matches_thread = item
                    .pointer("/target/id")
                    .and_then(Value::as_str)
                    .is_some_and(|t| t == thread_id);
                if matches_run || matches_thread {
                    item["isWaitingForInput"] = json!(false);
                    item["resolution"] = json!(resolution);
                    item["isRead"] = json!(true);
                    resolved_waiting_notifs = true;
                }
            }
        }
    }

    if !waiting_for_permission {
        if let Some(routine_id) = routine_id.as_deref() {
            if !thread_id.is_empty() {
                settle_routine(run_id, &thread_id, routine_id, profile_for_routine.as_deref(), ok, stopped);
            }
        } else if !thread_id.is_empty() {
            settle_turn_notification(run_id, &thread_id, profile_for_routine.as_deref(), ok, stopped);
        }
    }

    {
        let mut live = live_turns().lock().unwrap();
        if let Some(run) = live.runs.get_mut(run_id) {
            if let Some(ref err_it) = error_item {
                if !waiting_for_permission {
                    append_event(run, json!({ "kind": "upsert", "item": err_it }), true);
                }
            }
            if let Some((ref handoff_item, ref offer)) = quota_events {
                append_event(run, json!({ "kind": "upsert", "item": handoff_item }), true);
                append_event(run, json!({ "kind": "quotaHandoff", "offer": offer }), true);
            }
            if let Some(ref candidate) = reflection_candidate {
                append_event(run, json!({ "kind": "reflectionCandidate", "candidate": candidate }), true);
            }
            if !run.finished {
                if !assistant_text.is_empty() {
                    append_event(run, json!({ "kind": "upsert", "item": final_item }), true);
                }
                if waiting_for_permission {
                    // The open transcript treats `finished` or idle/error as the
                    // end of the turn and would hide the permission card.
                    append_event(run, json!({ "kind": "status", "status": "waiting" }), true);
                } else {
                    let final_status = if ok || stopped { "idle" } else { "error" };
                    append_event(run, json!({ "kind": "status", "status": final_status }), true);
                    append_event(
                        run,
                        json!({
                            "kind": "finished",
                            "ok": ok && !stopped,
                            "stoppedByBuilder": stopped && !preserve_async_children
                        }),
                        true,
                    );
                }
                run.finished = true;
                run.finished_at_ms = Some(now_ms());
            }
        }
        prune_stale_runs(&mut live);
    }

    live_cv().notify_all();
    if !thread_id.is_empty() {
        crate::chat::subagents::sync_child_thread_to_parent(&thread_id);
        crate::chat::subagents::reconcile_antigravity_subagents_for_thread(&thread_id, None);
    }
    persist();
    if resolved_waiting_notifs {
        crate::notifications::emit_notifications_updated();
    }
    if !thread_id.is_empty() {
        crate::chat::swarm::on_worker_turn_settled(&thread_id, ok && !stopped);
        crate::chat::swarm::cleanup_settled_wait_channel(&thread_id);
        crate::dispatch_wire::on_thread_settled(&thread_id);
        if !waiting_for_permission {
            super::pipeline::clear_acp_approval_wire(&thread_id);
            if let Ok(mut manager) = crate::chat::runtime::session_manager().lock() {
                let _ = manager.reap_if_ephemeral(&thread_id);
            }
        }
    }
    if let Some(ctx) = exhausted_turn_ctx {
        handle_thread_quota_exhaustion_after_settle(&ctx);
    }
    chat_log(&format!("finish_run: completed cleanly for run_id={}", run_id));
}

pub fn settle_routine(run_id: &str, thread_id: &str, routine_id: &str, profile_id: Option<&str>, ok: bool, stopped: bool) {
    if Uuid::parse_str(thread_id).is_err() || Uuid::parse_str(run_id).is_err() {
        return;
    }
    if ok && !stopped {
        let assistant_text = crate::chat::subagents::extract_final_assistant_text(thread_id);
        if crate::routines::is_heartbeat_ok(&assistant_text) {
            return;
        }
    }
    let outcome = if stopped {
        "cancelled"
    } else if ok {
        "completed"
    } else {
        "failed"
    };
    let profile = profile_id.filter(|id| Uuid::parse_str(id).is_ok());
    let routine = if Uuid::parse_str(routine_id).is_ok() {
        json!(routine_id)
    } else {
        Value::Null
    };
    let meta = crate::notifications::resolve_notification_context(
        Some(thread_id),
        profile_id,
        Some(routine_id),
    );
    let source = if profile.is_some() { "agentChat" } else { "codeThread" };
    let module = if profile.is_some() { "agent" } else { "chat" };
    let notice = json!({
        "id": Uuid::new_v4().to_string(),
        "runId": run_id,
        "target": { "source": source, "id": thread_id },
        "profileId": profile,
        "routineId": routine,
        "actorName": meta.actor_name,
        "threadTitle": meta.thread_title,
        "workspaceId": meta.workspace_id,
        "module": module,
        "kind": { "kind": "settled", "outcome": outcome },
        "resolution": "runSettled",
        "createdAtUnixMs": now_ms(),
        "isRead": false,
        "isWaitingForInput": false
    });
    {
        let mut items = notifications().lock().unwrap();
        items.insert(0, notice);
        if items.len() > 100 {
            items.truncate(100);
        }
    }
    crate::notifications::emit_notifications_updated();
}

fn is_subagent_child_thread(thread: &Value) -> bool {
    if thread.get("startedByAgent").and_then(Value::as_bool) == Some(true)
        || thread.get("sideChat").and_then(Value::as_bool) == Some(true)
    {
        return true;
    }
    ["parentThreadId", "swarmParentThreadId", "subagentRole", "swarmMemberName"]
        .iter()
        .any(|key| {
            thread
                .get(*key)
                .and_then(Value::as_str)
                .is_some_and(|s| !s.trim().is_empty())
        })
}

fn is_subagent_thread_by_id(thread_id: &str) -> bool {
    // Acquire and drop `threads()` before `notifications()` is ever locked in callers.
    let Ok(items) = threads().lock() else {
        return false;
    };
    items.iter().any(|t| {
        if t.get("id").and_then(Value::as_str) == Some(thread_id) {
            return is_subagent_child_thread(t);
        }
        let in_subagent_runs = t
            .get("subagentRuns")
            .and_then(Value::as_array)
            .is_some_and(|runs| {
                runs.iter().any(|run| {
                    run.get("childThreadId").and_then(Value::as_str) == Some(thread_id)
                })
            });
        if in_subagent_runs {
            return true;
        }
        t.pointer("/swarmState/members")
            .and_then(Value::as_array)
            .is_some_and(|members| {
                members.iter().any(|member| {
                    member.get("childThreadId").and_then(Value::as_str) == Some(thread_id)
                })
            })
    })
}

pub fn settle_turn_notification(run_id: &str, thread_id: &str, profile_id: Option<&str>, ok: bool, stopped: bool) {
    if thread_id.is_empty() || stopped || is_subagent_thread_by_id(thread_id) {
        return;
    }
    let outcome = if stopped {
        "cancelled"
    } else if ok {
        "completed"
    } else {
        "failed"
    };
    let meta = crate::notifications::resolve_notification_context(Some(thread_id), profile_id, None);
    let source = if profile_id.is_some() { "agentChat" } else { "codeThread" };
    let module = if profile_id.is_some() { "agent" } else { "chat" };
    let notice = json!({
        "id": Uuid::new_v4().to_string(),
        "runId": run_id,
        "target": { "source": source, "id": thread_id },
        "profileId": profile_id,
        "routineId": Value::Null,
        "actorName": meta.actor_name,
        "threadTitle": meta.thread_title,
        "workspaceId": meta.workspace_id,
        "module": module,
        "kind": { "kind": "settled", "outcome": outcome },
        "resolution": "runSettled",
        "createdAtUnixMs": now_ms(),
        "isRead": false,
        "isWaitingForInput": false
    });
    {
        let mut items = notifications().lock().unwrap();
        items.insert(0, notice);
        if items.len() > 100 {
            items.truncate(100);
        }
    }
    crate::notifications::emit_notifications_updated();
}

pub(crate) fn canonical_handoff_provider(raw: Option<&str>) -> String {
    match raw.map(str::trim).filter(|s| !s.is_empty()) {
        None | Some("agy") | Some("antigravity") => "antigravity".to_string(),
        Some(other) => other.to_string(),
    }
}

pub fn continue_turn_with_handoff(request: Option<Value>) -> Result<Value, String> {
    let req = crate::persist::body(&request);
    let thread_id = req
        .and_then(|r| r.get("threadId").or_else(|| r.get("thread_id")))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let target_provider = canonical_handoff_provider(
        req.and_then(|r| r.get("targetProvider").or_else(|| r.get("target_provider")))
            .and_then(|v| v.as_str()),
    );
    let target_account_id = req
        .and_then(|r| r.get("targetAccountId").or_else(|| r.get("target_account_id")))
        .and_then(|v| v.as_str())
        .map(String::from);
    let custom_handoff_prompt = req
        .and_then(|r| r.get("customHandoffPrompt").or_else(|| r.get("custom_handoff_prompt")))
        .and_then(|v| v.as_str())
        .map(String::from);

    if let Some(ref acc_id) = target_account_id {
        let res = crate::account_switcher::switch_account_profile_direct(target_provider.clone(), acc_id.clone());
        if res.get("success").and_then(|v| v.as_bool()) != Some(true) {
            let msg = res
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("Could not switch accounts.")
                .to_string();
            return Err(msg);
        }
    }

    let mut thread = {
        let items = threads().lock().unwrap();
        items.iter().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(&thread_id)).cloned()
    }.unwrap_or_else(|| load_thread(&thread_id, None, "Chat"));

    let handoff_prompt = if let Some(p) = custom_handoff_prompt.filter(|s| !s.trim().is_empty()) {
        p
    } else if let Some(saved) = thread.pointer("/quotaHandoffOffer/handoffPrompt").and_then(|v| v.as_str()) {
        saved.to_string()
    } else {
        let from_p = thread.get("provider").and_then(|v| v.as_str()).unwrap_or("antigravity");
        let ws_id = thread.get("workspaceId").and_then(|v| v.as_str());
        crate::handoff::build_handoff_capsule(&thread_id, from_p, "", ws_id)
    };

    thread["quotaHandoffOffer"] = Value::Null;
    thread["providerSessionId"] = Value::Null;
    thread["provider"] = json!(target_provider);
    touch(&mut thread);
    replace_thread(&thread);

    let profile_id = thread.get("profileId").and_then(|v| v.as_str()).map(|s| s.to_string());
    Ok(start_turn(&thread_id, profile_id.as_deref(), &handoff_prompt, Vec::new(), None))
}

#[derive(Debug, Clone)]
pub(crate) struct ExhaustedThreadTurnContext {
    pub thread_id: String,
    pub account_provider: String,
    pub requested_model: Option<String>,
    pub profile_id: Option<String>,
    pub handoff_prompt: String,
    pub now_unix_ms: i64,
}

fn format_provider_display_name(account_provider: &str) -> &str {
    match account_provider {
        "agy" | "antigravity" => "Antigravity",
        other => other,
    }
}

fn load_thread_snapshot(thread_id: &str) -> Value {
    let existing = {
        let items = threads().lock().unwrap();
        items
            .iter()
            .find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id))
            .cloned()
    };
    existing.unwrap_or_else(|| load_thread(thread_id, None, "Chat"))
}

fn resolve_thread_handoff_prompt(thread_id: &str, account_provider: &str) -> String {
    let thread = load_thread_snapshot(thread_id);
    if let Some(saved) = thread
        .pointer("/quotaHandoffOffer/handoffPrompt")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return saved.to_string();
    }
    let from_p = thread
        .get("provider")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| {
            if account_provider == "agy" {
                "antigravity"
            } else {
                account_provider
            }
        });
    let ws_id = thread.get("workspaceId").and_then(|v| v.as_str());
    crate::handoff::build_handoff_capsule(thread_id, from_p, "", ws_id)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn apply_thread_auto_switch_and_continue<C>(
    thread_id: &str,
    account_provider: &str,
    to_account_label: &str,
    applied_model: Option<&str>,
    requested_model: Option<&str>,
    model_adjusted: bool,
    fallback_profile_id: Option<&str>,
    handoff_prompt: &str,
    auto_continue: bool,
    continue_turn: C,
) -> Option<String>
where
    C: FnOnce(&str, Option<&str>, &str) -> Value,
{
    let mut thread = load_thread_snapshot(thread_id);
    thread["quotaHandoffOffer"] = Value::Null;
    thread["providerSessionId"] = Value::Null;
    if let Some(model_id) = applied_model.map(str::trim).filter(|s| !s.is_empty()) {
        thread["model"] = json!(model_id);
    }

    let provider_label = format_provider_display_name(account_provider);
    let mut note_text = match (model_adjusted, requested_model, applied_model) {
        (true, Some(req), Some(app)) if !req.eq_ignore_ascii_case(app) => format!(
            "Switched {} account to {} and updated model from {} to {}.",
            provider_label, to_account_label, req, app
        ),
        (_, _, Some(app)) if !app.trim().is_empty() => format!(
            "Switched {} account to {} (model {}).",
            provider_label, to_account_label, app
        ),
        _ => format!("Switched {} account to {}.", provider_label, to_account_label),
    };
    if !auto_continue {
        note_text.push_str(" Auto-continue is disabled; send a message when ready to continue.");
    }

    let note_id = format!("as_{}", Uuid::new_v4().simple());
    let note_item = chat_item(&note_id, "note", &note_text, false);
    upsert_item(&mut thread, &note_item);
    touch(&mut thread);
    replace_thread(&thread);

    let profile_id = thread
        .get("profileId")
        .and_then(|v| v.as_str())
        .map(String::from)
        .or_else(|| fallback_profile_id.map(String::from));

    if auto_continue && !handoff_prompt.trim().is_empty() {
        let _ = continue_turn(thread_id, profile_id.as_deref(), handoff_prompt);
        Some(thread_id.to_string())
    } else {
        persist();
        None
    }
}

fn pause_thread_for_fresh_catalog_mismatch(
    thread_id: &str,
    account_provider: &str,
    to_account_label: &str,
    requested_model: &str,
) {
    let mut thread = load_thread_snapshot(thread_id);
    let provider_label = format_provider_display_name(account_provider);
    let note_text = format!(
        "Switched {} account to {}, but model {} is unavailable in the target catalog. Confirm a fallback model in Notifications to continue.",
        provider_label, to_account_label, requested_model
    );
    let note_id = format!("as_{}", Uuid::new_v4().simple());
    let note_item = chat_item(&note_id, "note", &note_text, false);
    upsert_item(&mut thread, &note_item);
    touch(&mut thread);
    replace_thread(&thread);
    persist();
}

pub(crate) fn resume_thread_after_auto_switch(
    conf: &crate::account_switcher::PendingAutoSwitchConfirmation,
    applied_model: Option<&str>,
    model_adjusted: bool,
    auto_resume: bool,
) -> Option<String> {
    let tid = conf.thread_id.as_deref()?.trim();
    if tid.is_empty() {
        return None;
    }
    let handoff_prompt = conf
        .handoff_prompt
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .unwrap_or_else(|| resolve_thread_handoff_prompt(tid, &conf.provider));
    apply_thread_auto_switch_and_continue(
        tid,
        &conf.provider,
        &conf.to_account_label,
        applied_model,
        conf.requested_model.as_deref(),
        model_adjusted,
        None,
        &handoff_prompt,
        auto_resume,
        |id, pid, prompt| start_turn(id, pid, prompt, Vec::new(), None),
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn handle_thread_quota_exhaustion_after_settle_with<E, Eval, Pol, Ver, Cont>(
    ctx: &ExhaustedThreadTurnContext,
    store: &std::sync::Mutex<Vec<crate::account_switcher::PendingAutoSwitchConfirmation>>,
    publish_env: &E,
    evaluate: Eval,
    get_mismatch_policy: Pol,
    verify_catalog: Ver,
    continue_turn: Cont,
) where
    E: crate::account_switcher::AutoSwitchEnv,
    Eval: FnOnce(crate::account_switcher::AutoSwitchTriggerRequest) -> crate::account_switcher::AutoSwitchOutcome,
    Pol: FnOnce() -> String,
    Ver: FnOnce(&str, &str) -> Result<(String, bool, Vec<String>), String>,
    Cont: FnOnce(&str, Option<&str>, &str) -> Value,
{
    if ctx.thread_id.trim().is_empty() || ctx.account_provider.trim().is_empty() {
        return;
    }
    let req = crate::account_switcher::AutoSwitchTriggerRequest {
        provider: ctx.account_provider.clone(),
        trigger_source: "chat_turn".to_string(),
        requested_model: ctx.requested_model.clone(),
        thread_id: Some(ctx.thread_id.clone()),
        current_remaining_percent: Some(0.0),
        has_exhausted_window: true,
        now_unix_ms: ctx.now_unix_ms,
    };

    let outcome = evaluate(req);
    match outcome {
        crate::account_switcher::AutoSwitchOutcome::Switched {
            from_account_id,
            from_account_label,
            to_account_id,
            to_account_label,
            to_email,
            to_plan,
            requested_model,
            applied_model,
            model_adjusted,
            auto_continue_chat_turn,
            ..
        } => {
            let desired_model = applied_model
                .as_deref()
                .or(requested_model.as_deref())
                .unwrap_or("");
            let mismatch_policy = get_mismatch_policy();
            let (verified_model, fresh_adjusted, fresh_models) =
                match verify_catalog(&ctx.account_provider, desired_model) {
                    Ok((id, adjusted, models)) => (
                        (!id.trim().is_empty()).then_some(id),
                        adjusted,
                        models,
                    ),
                    Err(_) => (applied_model.clone(), false, Vec::new()),
                };

            if !model_adjusted
                && fresh_adjusted
                && mismatch_policy == "confirm_notification"
            {
                if let Some(ref req_m) = ctx.requested_model {
                    pause_thread_for_fresh_catalog_mismatch(
                        &ctx.thread_id,
                        &ctx.account_provider,
                        &to_account_label,
                        req_m,
                    );
                    let conf = crate::account_switcher::PendingAutoSwitchConfirmation {
                        confirmation_id: format!("asc_{}", Uuid::new_v4().simple()),
                        provider: ctx.account_provider.clone(),
                        from_account_id,
                        from_account_label,
                        from_email: None,
                        to_account_id,
                        to_account_label,
                        to_email,
                        to_plan_name: to_plan,
                        source_plan_name: None,
                        requested_model: ctx.requested_model.clone(),
                        suggested_fallback_model: verified_model,
                        available_target_models: fresh_models,
                        thread_id: Some(ctx.thread_id.clone()),
                        handoff_prompt: Some(ctx.handoff_prompt.clone()),
                        busy_sessions: Vec::new(),
                        reason: "model_mismatch".to_string(),
                        created_at_unix_ms: ctx.now_unix_ms,
                        expires_at_unix_ms: ctx
                            .now_unix_ms
                            .saturating_add(crate::account_switcher::PENDING_CONFIRMATION_TTL_MS),
                    };
                    let _ = crate::account_switcher::auto_switch::publish_confirmation_record_in(
                        conf,
                        ctx.now_unix_ms,
                        store,
                        publish_env,
                    );
                    return;
                }
            }

            let final_model = verified_model.or(applied_model);
            let final_adjusted = model_adjusted
                || fresh_adjusted
                || ctx
                    .requested_model
                    .as_deref()
                    .zip(final_model.as_deref())
                    .is_some_and(|(req_m, app_m)| !req_m.eq_ignore_ascii_case(app_m));

            let _ = apply_thread_auto_switch_and_continue(
                &ctx.thread_id,
                &ctx.account_provider,
                &to_account_label,
                final_model.as_deref(),
                ctx.requested_model.as_deref(),
                final_adjusted,
                ctx.profile_id.as_deref(),
                &ctx.handoff_prompt,
                auto_continue_chat_turn,
                continue_turn,
            );
        }
        crate::account_switcher::AutoSwitchOutcome::NeedsConfirmation { .. } => {
            let _ = crate::account_switcher::auto_switch::publish_needs_confirmation_in(
                &outcome,
                Some(ctx.handoff_prompt.clone()),
                ctx.now_unix_ms,
                store,
                publish_env,
            );
        }
        _ => {}
    }
}

pub(crate) fn handle_thread_quota_exhaustion_after_settle(ctx: &ExhaustedThreadTurnContext) {
    let provider = ctx.account_provider.clone();
    handle_thread_quota_exhaustion_after_settle_with(
        ctx,
        crate::account_switcher::auto_switch::pending_auto_switches_store(),
        &crate::account_switcher::LiveAutoSwitchEnv,
        crate::account_switcher::evaluate_auto_switch_raw,
        move || {
            let policy_val = crate::account_switcher::get_auto_switch_policy_direct(&provider);
            policy_val
                .pointer("/policy/modelMismatchPolicy")
                .and_then(|v| v.as_str())
                .unwrap_or("confirm_notification")
                .to_string()
        },
        crate::account_switcher::verify_fresh_model_catalog_live,
        |tid, pid, prompt| start_turn(tid, pid, prompt, Vec::new(), None),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account_switcher::{
        AutoSwitchEnv, AutoSwitchOutcome, AutoSwitchRuntimeStatus,
        PendingAutoSwitchConfirmation, RankedSwitchCandidate, SavedAccountProfile,
    };

    #[derive(Default)]
    struct NoopPublishEnv;
    impl AutoSwitchEnv for NoopPublishEnv {
        fn profiles_root(&self) -> std::path::PathBuf {
            std::env::temp_dir()
        }
        fn inspect_external(&self, _provider: &str) -> crate::account_switcher::ExternalProcessInspection {
            crate::account_switcher::ExternalProcessInspection::idle()
        }
        fn inspect_sessions(&self, _provider: &str) -> crate::terminal::ProviderSessionsInspection {
            crate::terminal::ProviderSessionsInspection::default()
        }
        fn execute_switch(&self, _provider: &str, _account_id: &str, _force_busy: bool) -> Value {
            json!({ "success": true })
        }
        fn get_runtime_status(&self, _provider: &str) -> AutoSwitchRuntimeStatus {
            AutoSwitchRuntimeStatus::default()
        }
        fn set_runtime_status(&self, _provider: &str, _status: AutoSwitchRuntimeStatus) {}
        fn emit_event(&self, _event: &str, _payload: Value) {}
    }

    struct ThreadCleanupGuard(String);
    impl Drop for ThreadCleanupGuard {
        fn drop(&mut self) {
            let mut items = threads().lock().unwrap();
            items.retain(|t| t.get("id").and_then(|v| v.as_str()) != Some(self.0.as_str()));
        }
    }

    fn seed_test_thread(thread_id: &str, model: &str) -> ThreadCleanupGuard {
        let mut items = threads().lock().unwrap();
        items.retain(|t| t.get("id").and_then(|v| v.as_str()) != Some(thread_id));
        items.push(json!({
            "id": thread_id,
            "provider": "antigravity",
            "model": model,
            "providerSessionId": "sess-old-1",
            "quotaHandoffOffer": {
                "failedProvider": "antigravity",
                "reason": "quota exhausted",
                "handoffPrompt": "Resume exact task",
            },
            "items": [],
            "updatedAtUnixMs": 1_000,
        }));
        ThreadCleanupGuard(thread_id.to_string())
    }

    #[test]
    fn test_handle_thread_quota_exhaustion_after_settle_exact_switch_updates_model_and_continues() {
        let tid = format!("th-as-exact-{}", Uuid::new_v4());
        let _guard = seed_test_thread(&tid, "claude-opus-4-6");

        let ctx = ExhaustedThreadTurnContext {
            thread_id: tid.clone(),
            account_provider: "agy".to_string(),
            requested_model: Some("claude-opus-4-6".to_string()),
            profile_id: Some("prof-1".to_string()),
            handoff_prompt: "Continue debugging module X".to_string(),
            now_unix_ms: 9_000_000,
        };

        let continued: std::sync::Mutex<Vec<(String, Option<String>, String)>> =
            std::sync::Mutex::new(Vec::new());
        let store: std::sync::Mutex<Vec<PendingAutoSwitchConfirmation>> =
            std::sync::Mutex::new(Vec::new());

        handle_thread_quota_exhaustion_after_settle_with(
            &ctx,
            &store,
            &NoopPublishEnv,
            |_req| AutoSwitchOutcome::Switched {
                provider: "agy".to_string(),
                from_account_id: Some("acc-1".to_string()),
                from_account_label: "Pro 1".to_string(),
                to_account_id: "acc-2".to_string(),
                to_account_label: "Pro 2".to_string(),
                to_email: Some("p2@kite.local".to_string()),
                to_plan: Some("Google AI Pro".to_string()),
                requested_model: Some("claude-opus-4-6".to_string()),
                applied_model: Some("claude-opus-4-6".to_string()),
                model_adjusted: false,
                auto_continue_chat_turn: true,
                compatibility: "exact".to_string(),
                status: AutoSwitchRuntimeStatus::default(),
            },
            || "confirm_notification".to_string(),
            |_prov, model| Ok((model.to_string(), false, vec![model.to_string()])),
            |thread_id, profile_id, prompt| {
                continued
                    .lock()
                    .unwrap()
                    .push((thread_id.to_string(), profile_id.map(String::from), prompt.to_string()));
                json!({ "runId": "run-continued-1" })
            },
        );

        let updated = {
            let items = threads().lock().unwrap();
            items
                .iter()
                .find(|t| t.get("id").and_then(|v| v.as_str()) == Some(tid.as_str()))
                .cloned()
                .unwrap()
        };
        assert_eq!(updated["model"], "claude-opus-4-6");
        assert!(updated["quotaHandoffOffer"].is_null());
        assert!(updated["providerSessionId"].is_null());
        let thread_items = updated["items"].as_array().unwrap();
        assert!(thread_items
            .iter()
            .any(|it| it["kind"] == "note"
                && it["text"].as_str().unwrap_or("").contains("Pro 2")));
        assert_eq!(
            *continued.lock().unwrap(),
            vec![(
                tid.clone(),
                Some("prof-1".to_string()),
                "Continue debugging module X".to_string()
            )]
        );
        assert!(store.lock().unwrap().is_empty());
    }

    #[test]
    fn test_handle_thread_quota_exhaustion_after_settle_needs_confirmation_leaves_offer_intact() {
        let tid = format!("th-as-confirm-{}", Uuid::new_v4());
        let _guard = seed_test_thread(&tid, "claude-opus-4-6");

        let ctx = ExhaustedThreadTurnContext {
            thread_id: tid.clone(),
            account_provider: "agy".to_string(),
            requested_model: Some("claude-opus-4-6".to_string()),
            profile_id: None,
            handoff_prompt: "Continue prompt preserved".to_string(),
            now_unix_ms: 9_100_000,
        };

        let continued = std::sync::atomic::AtomicBool::new(false);
        let store: std::sync::Mutex<Vec<PendingAutoSwitchConfirmation>> =
            std::sync::Mutex::new(Vec::new());

        handle_thread_quota_exhaustion_after_settle_with(
            &ctx,
            &store,
            &NoopPublishEnv,
            |_req| AutoSwitchOutcome::NeedsConfirmation {
                provider: "agy".to_string(),
                from_account_id: Some("acc-1".to_string()),
                from_account_label: "Pro".to_string(),
                from_email: Some("pro@kite.local".to_string()),
                source_plan_name: Some("Google AI Pro".to_string()),
                candidate: RankedSwitchCandidate {
                    profile: SavedAccountProfile {
                        id: "acc-free".to_string(),
                        provider: "agy".to_string(),
                        label: "Free".to_string(),
                        plan_name: Some("Free".to_string()),
                        available_model_ids: vec!["gemini-2.5-pro".to_string()],
                        ..Default::default()
                    },
                    compatibility: "model_mismatch".to_string(),
                    requested_model: Some("claude-opus-4-6".to_string()),
                    suggested_fallback_model: Some("gemini-2.5-pro".to_string()),
                    available_target_models: vec!["gemini-2.5-pro".to_string()],
                    source_plan: Some("Google AI Pro".to_string()),
                    target_plan: Some("Free".to_string()),
                    remaining_percent: Some(100.0),
                    known_healthy_quota: true,
                    quota_confidence: 2,
                    relevant_window_name: None,
                },
                reason: "model_mismatch".to_string(),
                requested_model: Some("claude-opus-4-6".to_string()),
                thread_id: Some(tid.clone()),
                busy_sessions: Vec::new(),
                trigger_source: "chat_turn".to_string(),
            },
            || "confirm_notification".to_string(),
            |_prov, _model| unreachable!("verify_catalog should not run before confirmation"),
            |_tid, _pid, _prompt| {
                continued.store(true, std::sync::atomic::Ordering::SeqCst);
                json!({})
            },
        );

        assert!(!continued.load(std::sync::atomic::Ordering::SeqCst));
        let stored_thread = {
            let items = threads().lock().unwrap();
            items
                .iter()
                .find(|t| t.get("id").and_then(|v| v.as_str()) == Some(tid.as_str()))
                .cloned()
                .unwrap()
        };
        assert_eq!(stored_thread["model"], "claude-opus-4-6");
        assert!(!stored_thread["quotaHandoffOffer"].is_null());

        let pending = store.lock().unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].thread_id.as_deref(), Some(tid.as_str()));
        assert_eq!(
            pending[0].handoff_prompt.as_deref(),
            Some("Continue prompt preserved")
        );
        assert_eq!(
            pending[0].suggested_fallback_model.as_deref(),
            Some("gemini-2.5-pro")
        );
    }

    #[test]
    fn test_handle_thread_quota_exhaustion_after_settle_unexpected_fresh_mismatch_pauses_confirm() {
        let tid = format!("th-as-fresh-mismatch-{}", Uuid::new_v4());
        let _guard = seed_test_thread(&tid, "claude-opus-4-6");

        let ctx = ExhaustedThreadTurnContext {
            thread_id: tid.clone(),
            account_provider: "agy".to_string(),
            requested_model: Some("claude-opus-4-6".to_string()),
            profile_id: None,
            handoff_prompt: "Keep prompt for fallback confirm".to_string(),
            now_unix_ms: 9_200_000,
        };

        let continued = std::sync::atomic::AtomicBool::new(false);
        let store: std::sync::Mutex<Vec<PendingAutoSwitchConfirmation>> =
            std::sync::Mutex::new(Vec::new());

        handle_thread_quota_exhaustion_after_settle_with(
            &ctx,
            &store,
            &NoopPublishEnv,
            |_req| AutoSwitchOutcome::Switched {
                provider: "agy".to_string(),
                from_account_id: Some("acc-1".to_string()),
                from_account_label: "Pro".to_string(),
                to_account_id: "acc-2".to_string(),
                to_account_label: "Next Account".to_string(),
                to_email: Some("next@kite.local".to_string()),
                to_plan: Some("Free".to_string()),
                requested_model: Some("claude-opus-4-6".to_string()),
                applied_model: Some("claude-opus-4-6".to_string()),
                model_adjusted: false,
                auto_continue_chat_turn: true,
                compatibility: "exact".to_string(),
                status: AutoSwitchRuntimeStatus::default(),
            },
            || "confirm_notification".to_string(),
            |_prov, _model| {
                Ok((
                    "gemini-2.5-pro".to_string(),
                    true,
                    vec!["gemini-2.5-pro".to_string()],
                ))
            },
            |_tid, _pid, _prompt| {
                continued.store(true, std::sync::atomic::Ordering::SeqCst);
                json!({})
            },
        );

        assert!(!continued.load(std::sync::atomic::Ordering::SeqCst));
        let stored_thread = {
            let items = threads().lock().unwrap();
            items
                .iter()
                .find(|t| t.get("id").and_then(|v| v.as_str()) == Some(tid.as_str()))
                .cloned()
                .unwrap()
        };
        assert_eq!(stored_thread["model"], "claude-opus-4-6");
        assert!(!stored_thread["quotaHandoffOffer"].is_null());
        assert!(stored_thread["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|it| it["kind"] == "note"));

        let pending = store.lock().unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].reason, "model_mismatch");
        assert_eq!(
            pending[0].suggested_fallback_model.as_deref(),
            Some("gemini-2.5-pro")
        );
        assert_eq!(
            pending[0].handoff_prompt.as_deref(),
            Some("Keep prompt for fallback confirm")
        );
    }

    #[test]
    fn finish_run_clears_stream_json_run_maps() {
        let run_id = format!("s4-stream-clean-{}", Uuid::new_v4().simple());
        super::super::stream_json::seed_stream_run_state_for_test(&run_id, 42);
        assert!(super::super::stream_json::has_stream_run_state_for_test(&run_id));

        finish_run(&run_id, true, false, "");

        assert!(
            !super::super::stream_json::has_stream_run_state_for_test(&run_id),
            "finish_run must remove finished run_id from streaming_sys_msg_runs, last_agent_step_by_run, and fallback_projected_steps_by_run"
        );
    }

    #[test]
    fn finish_run_resolves_lingering_waiting_approval_notifications_on_cancel_or_settle() {
        let tid = Uuid::new_v4().to_string();
        let run_id = Uuid::new_v4().to_string();
        let notif_id = format!("req-{}", Uuid::new_v4().simple());

        {
            let mut list = threads().lock().unwrap();
            let mut t = crate::chat::threads::blank_thread(&tid, None, "Test approval settle", "antigravity", None);
            t["status"] = json!("running");
            list.push(t);
        }
        {
            let mut live = live_turns().lock().unwrap();
            live.by_thread.insert(tid.clone(), run_id.clone());
            live.runs.insert(
                run_id.clone(),
                super::super::state::TurnRun {
                    revision: "rev-1".into(),
                    assistant_id: "asst-1".into(),
                    assistant_text: String::new(),
                    events: Vec::new(),
                    next_sequence: 0,
                    delivered_through: 0,
                    started_at_ms: now_ms(),
                    finished_at_ms: None,
                    closing: false,
                    finished: false,
                    child: None,
                    stdin: None,
                    routine_id: None,
                    file_baselines: std::collections::HashMap::new(),
                },
            );
        }
        {
            let mut notifs = notifications().lock().unwrap();
            notifs.insert(
                0,
                json!({
                    "id": notif_id,
                    "runId": run_id,
                    "target": { "source": "codeThread", "id": tid },
                    "kind": { "kind": "needsInput", "requestKind": "toolApproval" },
                    "resolution": Value::Null,
                    "createdAtUnixMs": now_ms(),
                    "isRead": false,
                    "isWaitingForInput": true
                }),
            );
        }

        finish_run(&run_id, false, true, "");

        let updated = {
            let notifs = notifications().lock().unwrap();
            notifs
                .iter()
                .find(|n| n.get("id").and_then(Value::as_str) == Some(notif_id.as_str()))
                .cloned()
                .expect("notification record still present")
        };
        assert_eq!(updated["isWaitingForInput"], json!(false));
        assert_eq!(updated["isRead"], json!(true));
        assert_eq!(updated["resolution"], json!("abandoned"));

        // Clean up test fixtures
        notifications().lock().unwrap().retain(|n| {
            n.get("id").and_then(Value::as_str) != Some(notif_id.as_str())
                && n.get("runId").and_then(Value::as_str) != Some(run_id.as_str())
        });
        threads()
            .lock()
            .unwrap()
            .retain(|t| t.get("id").and_then(Value::as_str) != Some(tid.as_str()));
        let mut live = live_turns().lock().unwrap();
        live.by_thread.remove(&tid);
        live.runs.remove(&run_id);
    }
}
