use crate::chat::threads::{chat_item, load_thread, replace_thread, touch, upsert_item};
use crate::chat::utils::{chat_log, now_ms};
use crate::persist::{notifications, persist, threads};
use serde_json::{json, Value};
use uuid::Uuid;

use super::pipeline::{flush_pipeline_deltas, pipeline_runs};
use super::state::{live_cv, live_turns, prune_stale_runs};
use super::turn::{append_event, start_turn};

pub fn finish_run(run_id: &str, ok: bool, stopped: bool, error_text: &str) {
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
    let mut profile_for_routine: Option<String> = None;
    let mut reflection_task: Option<(String, String, String)> = None;
    let mut quota_events: Option<(Value, Value)> = None;

    let error_item = if !ok && !stopped && assistant_text.is_empty() && !error_text.is_empty() {
        Some(chat_item(&format!("e{}", Uuid::new_v4().simple()), "error", error_text, false))
    } else {
        None
    };

    let final_item = chat_item(&assistant_id, "assistant", &assistant_text, false);
    let mut waiting_for_permission = false;

    if !thread_id.is_empty() {
        let mut items = threads().lock().unwrap();
        if let Some(thread) = items.iter_mut().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id.as_str())) {
            waiting_for_permission = thread
                .get("pendingApproval")
                .and_then(|value| value.as_object())
                .is_some();
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

            if let Some(arr) = thread.get_mut("items").and_then(|v| v.as_array_mut()) {
                for it in arr.iter_mut() {
                    if it.get("streaming").and_then(|v| v.as_bool()) == Some(true) {
                        it["streaming"] = json!(false);
                    }
                }
            }

            let title = thread.get("title").and_then(|v| v.as_str()).unwrap_or("");
            if matches!(title, "New Chat" | "New Agent Chat" | "Chat" | "") {
                if let Some(first_user) = thread.get("items")
                    .and_then(|v| v.as_array())
                    .and_then(|arr| arr.iter().find(|it| it.get("kind").and_then(|k| k.as_str()) == Some("user")))
                    .and_then(|it| it.get("text").and_then(|t| t.as_str()))
                {
                    let first_line = first_user.lines().next().unwrap_or("").trim();
                    if !first_line.is_empty() {
                        let concise: String = first_line.chars().take(60).collect();
                        thread["title"] = json!(concise);
                        thread["titleOrigin"] = json!("generated");
                    }
                }
            }

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
                let aid = thread.get("activePlanId").and_then(|v| v.as_str()).map(|s| s.to_string());
                if let Some(aid) = aid {
                    if let Some(plans) = thread.get_mut("plans").and_then(|v| v.as_array_mut()) {
                        if let Some(slot) = plans.iter_mut().find(|p| p.get("id").and_then(|v| v.as_str()) == Some(aid.as_str())) {
                            if slot.get("status").and_then(|v| v.as_str()) == Some("implementing") {
                                slot["status"] = json!(if ok { "completed" } else if stopped { "interrupted" } else { "failed" });
                            }
                        }
                    }
                }
            }

            // ── Quota Exhaustion & Handoff Detection ──
            let current_provider = thread.get("provider").and_then(|v| v.as_str()).unwrap_or("antigravity").to_string();
            let combined_output = format!("{}\n{}", assistant_text, error_text);
            if !ok || !stopped {
                if let Some(reason) = crate::handoff::detect_quota_exhaustion(&current_provider, &combined_output) {
                    let workspace_id = thread.get("workspaceId").and_then(|v| v.as_str());
                    let handoff_capsule = crate::handoff::build_handoff_capsule_from_thread(
                        Some(thread),
                        &current_provider,
                        &assistant_text,
                        workspace_id,
                    );
                    let suggestions_val = crate::handoff::recommend_continuation_targets_direct(current_provider.clone());
                    let suggestions = suggestions_val.get("suggestions").cloned().unwrap_or(json!([]));

                    let offer = json!({
                        "failedProvider": current_provider,
                        "reason": reason,
                        "partialOutput": assistant_text,
                        "handoffPrompt": handoff_capsule,
                        "suggestions": suggestions,
                        "offeredAtUnixMs": now_ms()
                    });
                    thread["quotaHandoffOffer"] = offer.clone();

                    let handoff_item = json!({
                        "id": format!("qho_{}", Uuid::new_v4().simple()),
                        "kind": "quotaHandoff",
                        "text": format!("Se ha detectado agotamiento de cuota en {}: {}", current_provider, reason),
                        "title": "Límite de cuota alcanzado",
                        "detail": Value::Null,
                        "status": "ready",
                        "streaming": false,
                        "exitCode": Value::Null,
                        "createdAtUnixMs": now_ms(),
                        "attachments": [],
                        "handoffOffer": offer
                    });
                    upsert_item(thread, &handoff_item);
                    quota_events = Some((handoff_item, offer));
                }
            }

            profile_for_routine = thread.get("profileId").and_then(|v| v.as_str()).map(|s| s.to_string());
            if ok {
                if let Some(ref pid) = profile_for_routine {
                    let user_prompt = thread.get("items")
                        .and_then(|v| v.as_array())
                        .and_then(|arr| arr.iter().rev().find(|it| it.get("kind").and_then(|k| k.as_str()) == Some("user")))
                        .and_then(|it| it.get("text").and_then(|t| t.as_str()))
                        .unwrap_or("");
                    if !user_prompt.is_empty() {
                        reflection_task = Some((pid.clone(), user_prompt.to_string(), assistant_text.clone()));
                    }
                }
            }
        }
        drop(items);
    }

    if let Some((ref pid, ref user_prompt, ref a_text)) = reflection_task {
        crate::agent_mind::apply_post_turn_reflection(pid, user_prompt, a_text);
    }

    // The process already exited, but the person still has to answer. A settled
    // notice here would announce a finished turn, including a failure chime.
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
                    append_event(run, json!({ "kind": "finished", "ok": ok && !stopped, "stoppedByBuilder": stopped }), true);
                }
                run.finished = true;
            }
        }
        prune_stale_runs(&mut live);
    }

    live_cv().notify_all();
    persist();
    chat_log(&format!("finish_run: completed cleanly for run_id={}", run_id));
}

pub fn settle_routine(run_id: &str, thread_id: &str, routine_id: &str, profile_id: Option<&str>, ok: bool, stopped: bool) {
    if Uuid::parse_str(thread_id).is_err() || Uuid::parse_str(run_id).is_err() {
        return;
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
    let notice = json!({
        "id": Uuid::new_v4().to_string(),
        "runId": run_id,
        "target": { "source": "codeThread", "id": thread_id },
        "profileId": profile,
        "routineId": routine,
        "kind": { "kind": "settled", "outcome": outcome },
        "resolution": "runSettled",
        "createdAtUnixMs": now_ms(),
        "isRead": false,
        "isWaitingForInput": false
    });
    let mut items = notifications().lock().unwrap();
    items.insert(0, notice);
    if items.len() > 100 {
        items.truncate(100);
    }
}

pub fn settle_turn_notification(run_id: &str, thread_id: &str, profile_id: Option<&str>, ok: bool, stopped: bool) {
    if thread_id.is_empty() || stopped {
        return;
    }
    let outcome = if stopped {
        "cancelled"
    } else if ok {
        "completed"
    } else {
        "failed"
    };
    let source = if profile_id.is_some() { "agentChat" } else { "codeThread" };
    let notice = json!({
        "id": Uuid::new_v4().to_string(),
        "runId": run_id,
        "target": { "source": source, "id": thread_id },
        "profileId": profile_id,
        "routineId": Value::Null,
        "kind": { "kind": "settled", "outcome": outcome },
        "resolution": "runSettled",
        "createdAtUnixMs": now_ms(),
        "isRead": false,
        "isWaitingForInput": false
    });
    let mut items = notifications().lock().unwrap();
    items.insert(0, notice);
    if items.len() > 100 {
        items.truncate(100);
    }
}

pub fn continue_turn_with_handoff(request: Option<Value>) -> Result<Value, String> {
    let req = crate::persist::body(&request);
    let thread_id = req
        .and_then(|r| r.get("threadId").or_else(|| r.get("thread_id")))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let target_provider = req
        .and_then(|r| r.get("targetProvider").or_else(|| r.get("target_provider")))
        .and_then(|v| v.as_str())
        .unwrap_or("agy")
        .to_string();
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
                .unwrap_or("No se pudo cambiar de cuenta.")
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
