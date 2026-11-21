use crate::persist::{last_provider, next_revision, persist, threads};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::chat::models::{default_mode, mode_ok, normalize_model, provider_ok, sanitize_options};
use crate::chat::utils::{clip_title, now_ms};

/// Top-level fields of the durable thread JSON.
///
/// `blank_thread` writes exactly these names, and the renderer plus the native
/// readers depend on them. A projection that adds, drops, or renames one is a
/// compatibility break, so the event log fold is asserted against this list.
pub const THREAD_FIELD_NAMES: [&str; 30] = [
    "schemaVersion",
    "revision",
    "id",
    "profileId",
    "provider",
    "providerSessionId",
    "title",
    "items",
    "plans",
    "mode",
    "plan",
    "model",
    "providerOptions",
    "status",
    "usage",
    "workspaceId",
    "pinned",
    "pendingApproval",
    "parentThreadId",
    "parentToolCallId",
    "startedByAgent",
    "sideChat",
    "subagentRole",
    "workspaceMode",
    "swarmId",
    "swarmMemberName",
    "subagentRuns",
    "swarmState",
    "createdAtUnixMs",
    "updatedAtUnixMs",
];

pub fn blank_thread(
    id: &str,
    profile_id: Option<&str>,
    title: &str,
    provider: &str,
    workspace_id: Option<&str>,
) -> Value {
    let now = now_ms();
    let provider = if provider_ok(provider) { provider } else { "antigravity" };
    let last_model_raw = crate::persist::last_model().lock().unwrap().clone();
    let model_compatible = last_model_raw.as_deref().is_some_and(|m| {
        !m.trim().is_empty()
            && !crate::chat::models::model_likely_belongs_to_another_provider(provider, m)
    });
    let default_model_val = if model_compatible {
        last_model_raw
            .as_deref()
            .filter(|m| !m.trim().is_empty())
            .map(|m| json!(m))
            .unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    let default_effort_val = if model_compatible || last_model_raw.is_none() {
        crate::persist::last_effort().lock().unwrap().clone()
    } else {
        None
    };
    let provider_options = if let Some(ref effort) = default_effort_val {
        if !effort.trim().is_empty() {
            vec![json!({ "id": "effort", "value": effort })]
        } else {
            Vec::new()
        }
    } else {
        Vec::new()
    };
    let effort_json = default_effort_val
        .as_deref()
        .filter(|e| !e.trim().is_empty())
        .map(|e| json!(e))
        .unwrap_or(Value::Null);

    json!({
        "schemaVersion": 1,
        "revision": next_revision(),
        "id": id,
        "profileId": profile_id,
        "provider": provider,
        "providerSessionId": Value::Null,
        "title": clip_title(title),
        "items": [],
        "plans": [],
        "mode": default_mode(provider),
        "plan": false,
        "model": default_model_val,
        "effort": effort_json,
        "providerOptions": provider_options,
        "status": "idle",
        "usage": { "inputTokens": 0, "outputTokens": 0, "costUsd": 0.0 },
        "workspaceId": workspace_id,
        "pinned": false,
        "pendingApproval": Value::Null,
        "parentThreadId": Value::Null,
        "parentToolCallId": Value::Null,
        "startedByAgent": false,
        "sideChat": false,
        "subagentRole": Value::Null,
        "workspaceMode": Value::Null,
        "swarmId": Value::Null,
        "swarmMemberName": Value::Null,
        "subagentRuns": [],
        "swarmState": Value::Null,
        "createdAtUnixMs": now,
        "updatedAtUnixMs": now
    })
}

pub fn create_thread(
    profile_id: Option<&str>,
    title: &str,
    provider: &str,
    workspace_id: Option<&str>,
) -> Value {
    let id = Uuid::new_v4().to_string();
    let thread = blank_thread(&id, profile_id, title, provider, workspace_id);
    threads().lock().unwrap().push(thread.clone());
    crate::chat::thread_index::index_thread(&thread);
    persist();
    thread
}

pub fn load_thread(thread_id: &str, profile_id: Option<&str>, title: &str) -> Value {
    // Check runtime liveness before acquiring threads() so locks never nest.
    let runtime_active = crate::chat::runtime::is_thread_runtime_active(thread_id);
    let stale_cutoff_ms = now_ms().saturating_sub(5_000);
    let mut is_stale_for_heal = false;
    let mut items = threads().lock().unwrap();
    let mut thread = if let Some(thread) = items
        .iter_mut()
        .find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id))
    {
        let mut mutated = false;
        if let Some(profile_id) = profile_id {
            if thread.get("profileId").and_then(|v| v.as_str()) != Some(profile_id) {
                thread["profileId"] = json!(profile_id);
                touch(thread);
                mutated = true;
            }
        }
        if crate::chat::runtime::post_reply::heal_persisted_connection_loss_after_reply(thread) {
            touch(thread);
            mutated = true;
        }
        is_stale_for_heal = thread
            .get("updatedAtUnixMs")
            .and_then(|v| v.as_i64())
            .is_none_or(|ts| ts <= stale_cutoff_ms);
        if !runtime_active
            && is_stale_for_heal
            && crate::chat::runtime::heal_orphaned_running_thread(thread, false)
        {
            touch(thread);
            mutated = true;
        }
        if apply_derived_title_if_needed(thread, "generated", false) {
            mutated = true;
        }
        let cloned = thread.clone();
        drop(items);
        if mutated {
            persist();
        }
        cloned
    } else {
        drop(items);
        let provider = last_provider().lock().unwrap().clone();
        let created = blank_thread(thread_id, profile_id, title, &provider, None);
        let mut relocked = threads().lock().unwrap();
        if let Some(existing) = relocked
            .iter()
            .find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id))
        {
            existing.clone()
        } else {
            relocked.push(created.clone());
            drop(relocked);
            persist();
            created
        }
    };

    let status_str = thread.get("status").and_then(|v| v.as_str()).unwrap_or("idle");
    let (is_warm, session_state) = crate::chat::runtime::session_manager()
        .lock()
        .ok()
        .and_then(|mgr| mgr.status(thread_id))
        .map(|record| {
            let warm = record.is_warm();
            let state = if warm && record.is_idle() {
                "warm".to_string()
            } else {
                record.state.as_str().to_string()
            };
            (warm, state)
        })
        .unwrap_or_else(|| (false, "sleeping".to_string()));

    let is_settled = !is_warm && status_str != "running";
    thread["sessionState"] = json!(session_state);
    thread["isWarm"] = json!(is_warm);
    thread["isSettled"] = json!(is_settled);
    hydrate_thread_binding(&mut thread);
    let snapshot_revision = thread
        .get("revision")
        .and_then(Value::as_str)
        .map(str::to_string);
    let hydrated = crate::chat::subagents::hydrate_antigravity_subagents_on_load(&mut thread);

    // Check liveness outside threads() lock before reconciling idle orphans or persisting hydration.
    let runtime_now_active =
        runtime_active || crate::chat::runtime::is_thread_runtime_active(thread_id);
    let can_heal_idle_orphans = !runtime_now_active
        && is_stale_for_heal
        && thread.get("pendingApproval").is_none_or(Value::is_null)
        && thread.get("pendingUserInput").is_none_or(Value::is_null)
        && !has_live_subagent_activity(thread_id, &thread);
    if !runtime_now_active && (hydrated || can_heal_idle_orphans) {
        persist_loaded_thread_repairs(
            thread_id,
            &mut thread,
            snapshot_revision.as_deref(),
            hydrated,
            can_heal_idle_orphans,
            stale_cutoff_ms,
        );
    }

    thread
}

fn has_live_subagent_activity(thread_id: &str, thread: &Value) -> bool {
    let live_run = thread
        .get("subagentRuns")
        .and_then(Value::as_array)
        .is_some_and(|runs| {
            runs.iter().any(|r| {
                let status = r.get("status").and_then(Value::as_str);
                if matches!(status, Some("completed" | "failed" | "killed")) {
                    return false;
                }
                if let Some(cid) = r
                    .get("childThreadId")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    return crate::chat::runtime::is_thread_runtime_active(cid);
                }
                let sid = r.get("subagentId").and_then(Value::as_str).unwrap_or("");
                if !sid.is_empty() && crate::chat::subagents::has_active_tailer(thread_id, sid) {
                    return true;
                }
                r.get("transcriptUri")
                    .and_then(Value::as_str)
                    .and_then(crate::chat::subagents::resolve_local_transcript_path)
                    .and_then(|p| std::fs::metadata(p).ok())
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| std::time::SystemTime::now().duration_since(t).ok())
                    .is_some_and(|age| age.as_secs() < 30)
            })
        });
    if live_run {
        return true;
    }
    thread
        .pointer("/swarmState/members")
        .and_then(Value::as_array)
        .is_some_and(|members| {
            members.iter().any(|m| {
                m.get("state").and_then(Value::as_str) == Some("working")
                    && m.get("childThreadId")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .is_some_and(crate::chat::runtime::is_thread_runtime_active)
            })
        })
}

fn persist_loaded_thread_repairs(
    thread_id: &str,
    thread: &mut Value,
    snapshot_revision: Option<&str>,
    hydrated: bool,
    can_heal_idle_orphans: bool,
    stale_cutoff_ms: i64,
) {
    let mut should_persist = false;
    {
        let mut items = threads().lock().unwrap();
        let child_states: std::collections::HashMap<String, (String, bool)> = items
            .iter()
            .filter_map(|t| {
                let id = t.get("id").and_then(Value::as_str)?;
                let status = t.get("status").and_then(Value::as_str).unwrap_or("idle");
                let fresh = t
                    .get("updatedAtUnixMs")
                    .and_then(Value::as_i64)
                    .is_some_and(|ts| ts > stale_cutoff_ms);
                Some((id.to_string(), (status.to_string(), fresh)))
            })
            .collect();
        if let Some(stored) = items
            .iter_mut()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(thread_id))
        {
            if stored.get("revision").and_then(Value::as_str) == snapshot_revision
                && stored.get("status").and_then(Value::as_str) != Some("running")
            {
                let mut mutated = false;
                if hydrated {
                    if let Some(v) = thread.get("items") {
                        stored["items"] = v.clone();
                    }
                    if let Some(v) = thread.get("subagentRuns") {
                        stored["subagentRuns"] = v.clone();
                    }
                    if let Some(v) = thread.get("swarmState") {
                        stored["swarmState"] = v.clone();
                    }
                    mutated = true;
                }
                if can_heal_idle_orphans {
                    let any_child_still_running_fresh = stored
                        .get("subagentRuns")
                        .and_then(Value::as_array)
                        .is_some_and(|runs| {
                            runs.iter().any(|r| {
                                let cur = r.get("status").and_then(Value::as_str);
                                if matches!(cur, Some("completed" | "failed" | "killed")) {
                                    return false;
                                }
                                let Some(cid) = r
                                    .get("childThreadId")
                                    .and_then(Value::as_str)
                                    .map(str::trim)
                                    .filter(|s| !s.is_empty())
                                else {
                                    return false;
                                };
                                child_states
                                    .get(cid)
                                    .is_some_and(|(st, fresh)| *fresh && matches!(st.as_str(), "running" | "waiting"))
                            })
                        });
                    if !any_child_still_running_fresh {
                        let now = now_ms();
                        if let Some(runs) = stored.get_mut("subagentRuns").and_then(Value::as_array_mut) {
                            for run in runs.iter_mut() {
                                let cur = run.get("status").and_then(Value::as_str);
                                if matches!(cur, Some("completed" | "failed" | "killed")) {
                                    continue;
                                }
                                let Some(cid) = run
                                    .get("childThreadId")
                                    .and_then(Value::as_str)
                                    .map(str::trim)
                                    .filter(|s| !s.is_empty())
                                else {
                                    continue;
                                };
                                let next_status = match child_states.get(cid).map(|(s, _)| s.as_str()) {
                                    Some("idle") => "completed",
                                    Some("error") => "failed",
                                    _ => continue,
                                };
                                run["status"] = json!(next_status);
                                run["updatedAtUnixMs"] = json!(now);
                                if run.get("completedAtUnixMs").is_none_or(Value::is_null) {
                                    run["completedAtUnixMs"] = json!(now);
                                }
                                mutated = true;
                            }
                        }
                        if crate::chat::runtime::heal_orphaned_thread_with_options(stored, false, true)
                        {
                            mutated = true;
                        }
                    }
                }
                if mutated {
                    touch(stored);
                    for field in [
                        "status",
                        "items",
                        "subagentRuns",
                        "swarmState",
                        "updatedAtUnixMs",
                        "revision",
                    ] {
                        if let Some(v) = stored.get(field) {
                            thread[field] = v.clone();
                        }
                    }
                    should_persist = true;
                }
            }
        }
    }
    if should_persist {
        persist();
    }
}

pub fn hydrate_thread_binding(thread: &mut Value) {
    if let Some(effort) = crate::chat::normalize::hydrated_effort(thread) {
        thread["effort"] = json!(effort);
    } else if thread.get("effort").and_then(|value| value.as_str()).is_none() {
        thread["effort"] = Value::Null;
    }
    if thread.get("connectionId").is_none() {
        thread["connectionId"] = Value::Null;
    }
    if thread.get("agent").is_none() {
        if let Some(agent) = thread.get("workMode").and_then(|value| value.as_str()) {
            thread["agent"] = json!(agent);
        }
    }
    if !thread.get("items").is_some_and(|value| value.is_array()) {
        thread["items"] = json!([]);
    }
    if let Some(items) = thread.get_mut("items").and_then(Value::as_array_mut) {
        for item in items.iter_mut() {
            if item.get("kind").and_then(Value::as_str) == Some("assistant") {
                if let Some(raw) = item.get("text").and_then(Value::as_str) {
                    if raw.contains("<SYSTEM_MESSAGE>") {
                        let cleaned = sanitize_chat_text(raw);
                        if cleaned != raw {
                            item["text"] = json!(cleaned);
                        }
                    }
                }
            }
        }
    }
    for (key, default) in [
        ("parentThreadId", Value::Null),
        ("parentToolCallId", Value::Null),
        ("startedByAgent", json!(false)),
        ("sideChat", json!(false)),
        ("subagentRole", Value::Null),
        ("workspaceMode", Value::Null),
        ("swarmId", Value::Null),
        ("swarmMemberName", Value::Null),
        ("subagentRuns", json!([])),
        ("swarmState", Value::Null),
    ] {
        if thread.get(key).is_none() {
            thread[key] = default;
        }
    }
    crate::chat::subagents::reconcile_duplicate_subagent_state(thread);
}

pub fn rename_thread(thread_id: &str, profile_id: Option<&str>, title: &str) -> Value {
    let mut items = threads().lock().unwrap();
    if let Some(thread) = items
        .iter_mut()
        .find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id))
    {
        let clipped = clip_title(title);
        thread["title"] = json!(clipped);
        if !is_placeholder_title(&clipped) {
            thread["titleOrigin"] = json!("user");
        }
        if let Some(profile_id) = profile_id {
            thread["profileId"] = json!(profile_id);
        }
        touch(thread);
        let cloned = thread.clone();
        drop(items);
        persist();
        return cloned;
    }
    drop(items);
    load_thread(thread_id, profile_id, title)
}

pub fn set_pinned(thread_id: &str, pinned: bool) -> Value {
    let mut items = threads().lock().unwrap();
    if let Some(thread) = items
        .iter_mut()
        .find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id))
    {
        thread["pinned"] = json!(pinned);
        touch(thread);
        let cloned = thread.clone();
        drop(items);
        persist();
        return cloned;
    }
    drop(items);
    load_thread(thread_id, None, "Chat")
}

pub fn configure_thread(thread_id: &str, patch: &Value) -> Value {
    let mut items = threads().lock().unwrap();
    if items
        .iter()
        .all(|t| t.get("id").and_then(|v| v.as_str()) != Some(thread_id))
    {
        drop(items);
        let created = blank_thread(thread_id, None, "Chat", "antigravity", None);
        threads().lock().unwrap().push(created);
        items = threads().lock().unwrap();
    }
    if let Some(thread) = items
        .iter_mut()
        .find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id))
    {
        let current_provider = thread
            .get("provider")
            .and_then(|v| v.as_str())
            .unwrap_or("antigravity")
            .to_string();
        let provider = patch
            .get("provider")
            .and_then(|v| v.as_str())
            .filter(|p| provider_ok(p))
            .unwrap_or(&current_provider)
            .to_string();
        let requested_mode = patch.get("mode").and_then(|v| v.as_str()).unwrap_or("");
        let mode = if mode_ok(&provider, requested_mode) {
            requested_mode.to_string()
        } else if mode_ok(
            &provider,
            thread.get("mode").and_then(|v| v.as_str()).unwrap_or(""),
        ) {
            thread
                .get("mode")
                .and_then(|v| v.as_str())
                .unwrap_or(default_mode(&provider))
                .to_string()
        } else {
            default_mode(&provider).to_string()
        };
        if let Some(plan) = patch.get("plan").and_then(|v| v.as_bool()) {
            thread["plan"] = json!(plan);
        }
        if let Some(agent) = patch
            .get("agent")
            .or_else(|| patch.get("workMode"))
            .and_then(|v| v.as_str())
        {
            thread["agent"] = json!(agent);
            thread["workMode"] = json!(agent);
            if agent == "plan" {
                thread["plan"] = json!(true);
            } else if agent == "build" {
                thread["plan"] = json!(false);
            }
        }
        let mut new_last_model: Option<String> = None;
        let mut new_last_effort: Option<String> = None;
        if patch.get("model").is_some() {
            let normalized = normalize_model(patch.get("model"));
            if let Some(m) = normalized.as_str() {
                if !m.trim().is_empty() {
                    new_last_model = Some(m.trim().to_string());
                }
            }
            thread["model"] = normalized;
        }
        if let Some(options) = patch.get("providerOptions").and_then(|v| v.as_array()) {
            thread["providerOptions"] = Value::Array(sanitize_options(options));
        }
        if patch.get("effort").is_some() {
            let effort = patch.get("effort").and_then(|value| value.as_str());
            thread["providerOptions"] = crate::chat::normalize::effort_option(
                &thread["providerOptions"],
                effort,
            );
            thread["effort"] = match effort {
                Some(value) if !value.trim().is_empty() => {
                    new_last_effort = Some(value.trim().to_string());
                    json!(value.trim())
                }
                _ => Value::Null,
            };
        }
        hydrate_thread_binding(thread);
        if provider != current_provider {
            thread["providerSessionId"] = Value::Null;
        }
        thread["provider"] = json!(provider);
        thread["mode"] = json!(mode);
        if let Some(queue) = patch.get("queuedRuns").and_then(|value| value.as_array()) {
            let rows: Vec<Value> = queue
                .iter()
                .filter_map(|row| {
                    let text = row
                        .get("text")
                        .and_then(|value| value.as_str())
                        .map(str::trim)
                        .unwrap_or("");
                    let attachments = crate::chat::parse_attachments(Some(row));
                    if text.is_empty() && attachments.is_empty() {
                        return None;
                    }
                    let id = row
                        .get("id")
                        .and_then(|value| value.as_str())
                        .filter(|id| !id.is_empty())
                        .unwrap_or("queued");
                    let mut entry = json!({ "id": id, "text": text });
                    if !attachments.is_empty() {
                        entry["attachments"] = Value::Array(attachments);
                    }
                    if let Some(ts) = row.get("createdAtUnixMs").and_then(|v| v.as_i64()) {
                        entry["createdAtUnixMs"] = json!(ts);
                    }
                    Some(entry)
                })
                .take(32)
                .collect();
            thread["queuedRuns"] = Value::Array(rows);
        }
        if let Some(ws) = patch.get("workspaceId") {
            thread["workspaceId"] = if ws.is_null() {
                Value::Null
            } else if let Some(ws_str) = ws.as_str() {
                if ws_str.is_empty() { Value::Null } else { json!(ws_str) }
            } else {
                ws.clone()
            };
        }
        let updated_provider = thread["provider"].as_str().unwrap_or("antigravity").to_string();
        touch(thread);
        let cloned = thread.clone();
        drop(items);
        if let Some(m) = new_last_model {
            *crate::persist::last_model().lock().unwrap() = Some(m);
        }
        if let Some(e) = new_last_effort {
            *crate::persist::last_effort().lock().unwrap() = Some(e);
        }
        *last_provider().lock().unwrap() = updated_provider;
        persist();
        return cloned;
    }
    drop(items);
    load_thread(thread_id, None, "Chat")
}

pub fn set_agent_model(
    agent_id: &str,
    thread_id: &str,
    provider: &str,
    model: Option<&Value>,
) -> Value {
    let provider = if provider_ok(provider) { provider } else { "antigravity" };
    let patch = json!({
        "provider": provider,
        "model": model.cloned().unwrap_or(Value::Null)
    });
    let mut thread = configure_thread(thread_id, &patch);
    thread["profileId"] = json!(agent_id);
    replace_thread(&thread);
    thread
}

pub fn set_agent_plan(agent_id: &str, thread_id: &str, plan: bool) -> Value {
    let mut thread = load_thread(thread_id, Some(agent_id), "Agent Chat");
    thread["profileId"] = json!(agent_id);
    thread["plan"] = json!(plan);
    touch(&mut thread);
    replace_thread(&thread);
    thread
}

pub(crate) fn replace_thread(thread: &Value) {
    let id = thread.get("id").and_then(|v| v.as_str()).unwrap_or("");
    let mut items = threads().lock().unwrap();
    if let Some(slot) = items
        .iter_mut()
        .find(|t| t.get("id").and_then(|v| v.as_str()) == Some(id))
    {
        *slot = thread.clone();
    } else {
        items.push(thread.clone());
    }
    drop(items);
    crate::chat::thread_index::index_thread(thread);
    persist();
}

pub(crate) fn touch(thread: &mut Value) {
    if let Some(object) = thread.as_object_mut() {
        object.insert("revision".into(), Value::String(next_revision()));
        object.insert("updatedAtUnixMs".into(), json!(now_ms()));
    }
    crate::chat::thread_index::index_thread(thread);
}

pub(crate) fn archived_at_ms(thread: &Value) -> Option<i64> {
    thread.get("archivedAtUnixMs").and_then(|value| value.as_i64())
}

pub fn history(agent_id: Option<&str>) -> Value {
    let (filtered, mutated): (Vec<Value>, bool) = {
        let mut items = threads().lock().unwrap();
        let mut mutated = false;
        let mut out = Vec::new();
        for thread in items.iter_mut() {
            let matches_agent = match agent_id {
                Some(id) => thread.get("profileId").and_then(|v| v.as_str()) == Some(id),
                None => true,
            };
            if !matches_agent || archived_at_ms(thread).is_some() {
                continue;
            }
            if apply_derived_title_if_needed(thread, "generated", false) {
                mutated = true;
            }
            out.push(thread.clone());
        }
        (out, mutated)
    };
    if mutated {
        persist();
    }
    let summaries: Vec<Value> = filtered.iter().filter_map(summary_of).collect();
    let provider = last_provider().lock().unwrap().clone();
    json!({
        "schemaVersion": 1,
        "summaries": summaries,
        "lastProvider": provider,
        "readOnly": false,
        "skippedThreads": 0,
        "recoveryMessage": Value::Null
    })
}

fn is_active_subagent_status(status: &str) -> bool {
    matches!(
        status.trim().to_ascii_lowercase().as_str(),
        "running"
            | "queued"
            | "pending"
            | "inprogress"
            | "in_progress"
            | "started"
            | "waiting"
            | "needsinput"
            | "pendingapproval"
            | "pending_approval"
            | "blocked"
    )
}

fn clip_subagent_summary_prompt(raw: &str) -> Option<String> {
    let clean = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if clean.is_empty() {
        return None;
    }
    let mut chars = clean.chars();
    let head: String = chars.by_ref().take(72).collect();
    if chars.next().is_some() {
        Some(format!("{}…", head.trim_end()))
    } else {
        Some(head)
    }
}

fn active_subagent_summaries(thread: &Value) -> Vec<Value> {
    let Some(runs) = thread.get("subagentRuns").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut seen_ids = std::collections::HashSet::new();
    let mut seen_children = std::collections::HashSet::new();
    for run in runs {
        let status = run
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if !is_active_subagent_status(status) {
            continue;
        }
        let subagent_id = run
            .get("subagentId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let child_thread_id = run
            .get("childThreadId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        if let Some(ref sid) = subagent_id {
            if !seen_ids.insert(sid.clone()) {
                continue;
            }
        }
        if let Some(ref ctid) = child_thread_id {
            if !seen_children.insert(ctid.clone()) {
                continue;
            }
        }
        let prompt = run
            .get("prompt")
            .and_then(Value::as_str)
            .and_then(clip_subagent_summary_prompt);
        out.push(json!({
            "subagentId": subagent_id,
            "role": run.get("role").cloned().unwrap_or(Value::Null),
            "typeName": run.get("typeName").cloned().unwrap_or(Value::Null),
            "provider": run.get("provider").cloned().unwrap_or(Value::Null),
            "status": status,
            "childThreadId": child_thread_id,
            "swarmId": run.get("swarmId").cloned().unwrap_or(Value::Null),
            "swarmMemberName": run.get("swarmMemberName").cloned().unwrap_or(Value::Null),
            "prompt": prompt,
            "updatedAtUnixMs": run.get("updatedAtUnixMs").cloned().unwrap_or(Value::Null)
        }));
    }
    out
}

pub fn summary_of(thread: &Value) -> Option<Value> {
    let thread_id = thread.get("id")?.as_str()?;
    let status_val = thread.get("status").cloned().unwrap_or(json!("idle"));
    let status_str = status_val.as_str().unwrap_or("idle");

    let (is_warm, session_state) = crate::chat::runtime::session_manager()
        .lock()
        .ok()
        .and_then(|mgr| mgr.status(thread_id))
        .map(|record| {
            let warm = record.is_warm();
            let state = if warm && record.is_idle() {
                "warm".to_string()
            } else {
                record.state.as_str().to_string()
            };
            (warm, state)
        })
        .unwrap_or_else(|| (false, "sleeping".to_string()));

    let has_pending_approval = thread
        .get("pendingApproval")
        .is_some_and(|v| !v.is_null());
    let has_pending_user_input = thread
        .get("pendingUserInput")
        .is_some_and(|v| !v.is_null());
    let is_settled = !is_warm
        && !matches!(status_str, "running" | "waiting" | "pendingApproval")
        && !has_pending_approval
        && !has_pending_user_input;

    Some(json!({
        "id": thread_id,
        "profileId": thread.get("profileId").cloned().unwrap_or(Value::Null),
        "title": thread.get("title").cloned().unwrap_or(json!("Chat")),
        "provider": thread.get("provider").cloned().unwrap_or(json!("antigravity")),
        "status": status_val,
        "sessionState": session_state,
        "isWarm": is_warm,
        "isSettled": is_settled,
        "hasContent": thread.get("items").and_then(|v| v.as_array()).map(|items| !items.is_empty()).unwrap_or(false),
        "workspaceId": thread.get("workspaceId").cloned().unwrap_or(Value::Null),
        "pinned": thread.get("pinned").cloned().unwrap_or(json!(false)),
        "parentThreadId": thread.get("parentThreadId").cloned().unwrap_or(Value::Null),
        "parentToolCallId": thread.get("parentToolCallId").cloned().unwrap_or(Value::Null),
        "startedByAgent": thread.get("startedByAgent").cloned().unwrap_or(json!(false)),
        "sideChat": thread.get("sideChat").cloned().unwrap_or(json!(false)),
        "subagentRole": thread.get("subagentRole").cloned().unwrap_or(Value::Null),
        "workspaceMode": thread.get("workspaceMode").cloned().unwrap_or(Value::Null),
        "swarmId": thread.get("swarmId").cloned().unwrap_or(Value::Null),
        "swarmMemberName": thread.get("swarmMemberName").cloned().unwrap_or(Value::Null),
        "pendingApproval": thread.get("pendingApproval").cloned().unwrap_or(Value::Null),
        "pendingUserInput": thread.get("pendingUserInput").cloned().unwrap_or(Value::Null),
        "activeSubagents": active_subagent_summaries(thread),
        "createdAtUnixMs": thread.get("createdAtUnixMs").cloned().unwrap_or(json!(now_ms())),
        "updatedAtUnixMs": thread.get("updatedAtUnixMs").cloned().unwrap_or(json!(now_ms()))
    }))
}

pub fn remove_thread(thread_id: &str) -> Value {
    threads()
        .lock()
        .unwrap()
        .retain(|thread| thread.get("id").and_then(|v| v.as_str()) != Some(thread_id));
    crate::chat::thread_index::remove_from_index(thread_id);
    persist();
    history(None)
}

pub fn chat_item(id: &str, kind: &str, text: &str, streaming: bool) -> Value {
    json!({
        "id": id,
        "kind": kind,
        "text": sanitize_chat_text(text),
        "title": Value::Null,
        "detail": Value::Null,
        "status": Value::Null,
        "streaming": streaming,
        "exitCode": Value::Null,
        "createdAtUnixMs": now_ms(),
        "attachments": []
    })
}

const KITE_ENVELOPE_AGENT_HEADER: &str = "\nThis is another agent, not the person.\n";

/// Returns true when a prompt string is an internal agent-to-agent dispatch envelope
/// or Swarm coordinator wakeup rather than a human-entered message.
pub fn is_internal_dispatch_prompt(prompt: &str) -> bool {
    let normalized = prompt.replace("\r\n", "\n");
    let trimmed = normalized.trim_start();
    if trimmed.starts_with("[kite from=\"")
        && trimmed.contains(KITE_ENVELOPE_AGENT_HEADER)
        && (trimmed.contains("\nBODY:\n") || trimmed.ends_with("\nBODY:"))
    {
        return true;
    }
    trimmed.starts_with("[Swarm Coordinator Wakeup — ")
}

/// Returns true when a stored transcript item is an internal dispatch wakeup turn.
pub fn is_internal_dispatch_item(item: &Value) -> bool {
    if item.get("kind").and_then(|v| v.as_str()) != Some("user") {
        return false;
    }
    if item.get("internalDispatch").and_then(|v| v.as_bool()) == Some(true) {
        return true;
    }
    item.get("text")
        .and_then(|v| v.as_str())
        .is_some_and(is_internal_dispatch_prompt)
}

/// Returns true for genuine human user items (excluding internal dispatch wakeups).
pub fn is_human_user_item(item: &Value) -> bool {
    item.get("kind").and_then(|k| k.as_str()) == Some("user")
        && !is_internal_dispatch_item(item)
}

/// Finds the first (`latest = false`) or most recent (`latest = true`) human user prompt text.
pub fn human_user_prompt(thread: &Value, latest: bool) -> Option<&str> {
    let items = thread.get("items").and_then(|v| v.as_array())?;
    let matched = if latest {
        items.iter().rev().find(|it| is_human_user_item(it))
    } else {
        items.iter().find(|it| is_human_user_item(it))
    };
    matched.and_then(|it| it.get("text").and_then(|t| t.as_str()))
}

const DEFAULT_THREAD_TITLE_MAX_CHARS: usize = 60;

/// Returns true when `title` is still a default placeholder rather than a real conversation title.
pub fn is_placeholder_title(title: &str) -> bool {
    let trimmed = title.trim();
    trimmed.is_empty()
        || matches!(
            trimmed,
            "New Chat" | "New Agent Chat" | "Chat" | "Chat Thread"
        )
}

fn decode_base64url_bytes(input: &str) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut buf: u32 = 0;
    let mut bits: u8 = 0;
    for b in input.bytes() {
        let val = match b {
            b'A'..=b'Z' => b - b'A',
            b'a'..=b'z' => b - b'a' + 26,
            b'0'..=b'9' => b - b'0' + 52,
            b'-' | b'+' => 62,
            b'_' | b'/' => 63,
            b'=' => break,
            b' ' | b'\n' | b'\r' | b'\t' => continue,
            _ => return None,
        };
        buf = (buf << 6) | (val as u32);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buf >> bits) & 0xff) as u8);
        }
    }
    Some(out)
}

fn push_spaced_token(out: &mut String, token: &str) {
    let trimmed = token.trim();
    if trimmed.is_empty() {
        return;
    }
    if out
        .chars()
        .last()
        .is_some_and(|ch| !ch.is_whitespace())
    {
        out.push(' ');
    }
    out.push_str(trimmed);
}

/// Decodes Kite inline citation (`\u{E000}...\u{E001}`) and mention (`\u{E002}...\u{E003}`) tokens
/// into human-readable text so generated titles never contain raw PUA/base64 sequences.
fn replace_pua_tokens(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(idx) = rest.find(['\u{E000}', '\u{E002}']) {
        out.push_str(&rest[..idx]);
        let after_start = &rest[idx..];
        let mut chars = after_start.chars();
        let opener = chars.next().unwrap();
        let closer = if opener == '\u{E000}' { '\u{E001}' } else { '\u{E003}' };
        let body = &after_start[opener.len_utf8()..];
        if let Some(end_idx) = body.find(closer) {
            let payload_b64 = &body[..end_idx];
            if let Some(bytes) = decode_base64url_bytes(payload_b64) {
                if let Ok(parsed) = serde_json::from_slice::<Value>(&bytes) {
                    if opener == '\u{E000}' {
                        let snippet = parsed
                            .get("c")
                            .and_then(|v| v.as_str())
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .or_else(|| {
                                parsed
                                    .get("q")
                                    .and_then(|v| v.as_str())
                                    .map(str::trim)
                                    .filter(|s| !s.is_empty())
                            });
                        if let Some(s) = snippet {
                            push_spaced_token(&mut out, s);
                        }
                    } else if let Some(label) = parsed
                        .get("l")
                        .and_then(|v| v.as_str())
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                    {
                        if label.starts_with('@') {
                            push_spaced_token(&mut out, label);
                        } else {
                            push_spaced_token(&mut out, &format!("@{}", label));
                        }
                    }
                }
            }
            rest = &body[end_idx + closer.len_utf8()..];
        } else {
            rest = body;
        }
    }
    out.push_str(rest);
    out
}

fn strip_leading_markdown_markers(mut line: &str) -> &str {
    loop {
        let trimmed = line.trim_start();
        if let Some(after_hashes) = trimmed.strip_prefix('#') {
            let after_all_hashes = after_hashes.trim_start_matches('#');
            if after_all_hashes.starts_with(char::is_whitespace) {
                line = after_all_hashes.trim_start();
                continue;
            }
        }
        if let Some(rest) = trimmed
            .strip_prefix("- ")
            .or_else(|| trimmed.strip_prefix("* "))
            .or_else(|| trimmed.strip_prefix("+ "))
        {
            line = rest;
            continue;
        }
        if let Some(rest) = trimmed
            .strip_prefix("[ ] ")
            .or_else(|| trimmed.strip_prefix("[x] "))
            .or_else(|| trimmed.strip_prefix("[X] "))
        {
            line = rest;
            continue;
        }
        let digit_len = trimmed
            .bytes()
            .take_while(|b| b.is_ascii_digit())
            .count();
        if (1..=3).contains(&digit_len) {
            let after_digits = &trimmed[digit_len..];
            if let Some(rest) = after_digits
                .strip_prefix(". ")
                .or_else(|| after_digits.strip_prefix(") "))
            {
                line = rest;
                continue;
            }
        }
        return trimmed;
    }
}

fn is_horizontal_rule(line: &str) -> bool {
    let compact: String = line.chars().filter(|c| !c.is_whitespace()).collect();
    compact.len() >= 3 && (compact.chars().all(|c| c == '-') || compact.chars().all(|c| c == '*') || compact.chars().all(|c| c == '='))
}

fn truncate_title_cleanly(text: &str, max_chars: usize) -> String {
    let total = text.chars().count();
    if total <= max_chars || max_chars == 0 {
        return text.to_string();
    }
    if max_chars <= 1 {
        return "…".to_string();
    }
    let prefix: String = text.chars().take(max_chars - 1).collect();
    let trimmed = if let Some(last_space) = prefix.rfind(' ') {
        if prefix[..last_space].chars().count() >= max_chars / 2 {
            prefix[..last_space].trim_end()
        } else {
            prefix.trim_end()
        }
    } else {
        prefix.trim_end()
    };
    format!("{}…", trimmed)
}

/// Cleans a raw prompt or response snippet into a concise single-line thread title.
pub fn clean_title_candidate(raw: &str, max_chars: usize) -> Option<String> {
    let normalized = replace_pua_tokens(raw)
        .replace("\r\n", "\n")
        .replace('\r', "\n");

    let mut prose_line: Option<String> = None;
    let mut quote_line: Option<String> = None;
    let mut fenced_line: Option<String> = None;
    let mut in_fence = false;

    for raw_line in normalized.lines() {
        let trimmed = raw_line.trim();
        if trimmed.is_empty() || is_horizontal_rule(trimmed) {
            continue;
        }
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            if fenced_line.is_none() {
                let collapsed = trimmed.split_whitespace().collect::<Vec<_>>().join(" ");
                if !collapsed.is_empty() {
                    fenced_line = Some(collapsed);
                }
            }
            continue;
        }
        if trimmed.starts_with('>') {
            if quote_line.is_none() {
                let unquoted = trimmed.trim_start_matches(|c: char| c == '>' || c.is_whitespace());
                let stripped = strip_leading_markdown_markers(unquoted);
                let collapsed = stripped.split_whitespace().collect::<Vec<_>>().join(" ");
                if !collapsed.is_empty() {
                    quote_line = Some(collapsed);
                }
            }
            continue;
        }
        let stripped = strip_leading_markdown_markers(trimmed);
        let collapsed = stripped.split_whitespace().collect::<Vec<_>>().join(" ");
        if !collapsed.is_empty() {
            prose_line = Some(collapsed);
            break;
        }
    }

    let chosen = prose_line.or(quote_line).or(fenced_line)?;
    if chosen.is_empty() {
        return None;
    }
    Some(truncate_title_cleanly(&chosen, max_chars))
}

fn attachment_label_from_item(item: &Value) -> Option<String> {
    let attachments = item.get("attachments").and_then(|v| v.as_array())?;
    for att in attachments {
        let candidate = att
            .get("fileName")
            .or_else(|| att.get("name"))
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .or_else(|| {
                att.get("path")
                    .and_then(|v| v.as_str())
                    .and_then(|p| std::path::Path::new(p).file_name())
                    .and_then(|os| os.to_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
            });
        if let Some(label) = candidate {
            return Some(truncate_title_cleanly(label, DEFAULT_THREAD_TITLE_MAX_CHARS));
        }
    }
    None
}

fn is_low_signal_greeting(candidate: &str) -> bool {
    let normalized: String = candidate
        .trim()
        .trim_end_matches(|c: char| matches!(c, '!' | '.' | '?' | ',' | '…'))
        .to_lowercase();
    matches!(
        normalized.as_str(),
        "hi" | "hey" | "hello" | "hola" | "buenas" | "ok" | "okay" | "test" | "ping"
    )
}

/// Derives a concise non-placeholder title from a thread's human prompts, attachments, or response.
pub fn derive_thread_title_from_thread(thread: &Value) -> Option<String> {
    let items = thread.get("items").and_then(|v| v.as_array())?;

    let mut first_cleaned_human: Option<String> = None;
    for item in items.iter().filter(|it| is_human_user_item(it)) {
        if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
            if let Some(cleaned) = clean_title_candidate(text, DEFAULT_THREAD_TITLE_MAX_CHARS) {
                if !is_low_signal_greeting(&cleaned) {
                    return Some(cleaned);
                }
                if first_cleaned_human.is_none() {
                    first_cleaned_human = Some(cleaned);
                }
            }
        }
    }

    for item in items.iter().filter(|it| is_human_user_item(it)) {
        if let Some(label) = attachment_label_from_item(item) {
            return Some(label);
        }
    }

    for item in items {
        if item.get("kind").and_then(|v| v.as_str()) != Some("assistant") {
            continue;
        }
        if item.get("streaming").and_then(|v| v.as_bool()) == Some(true) {
            continue;
        }
        if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
            if let Some(cleaned) = clean_title_candidate(text, DEFAULT_THREAD_TITLE_MAX_CHARS) {
                return Some(cleaned);
            }
        }
    }

    first_cleaned_human
}

/// Sets a derived thread title when the current title is still a placeholder or provisional.
/// Never overwrites user-authored (`"user"`) renames.
pub fn apply_derived_title_if_needed(
    thread: &mut Value,
    origin: &str,
    refine_provisional: bool,
) -> bool {
    let current_origin = thread
        .get("titleOrigin")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if current_origin == "user" {
        return false;
    }

    let current_title = thread
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let should_derive = is_placeholder_title(current_title)
        || (refine_provisional && current_origin == "provisional");
    if !should_derive {
        return false;
    }

    let Some(derived) = derive_thread_title_from_thread(thread) else {
        return false;
    };

    let changed = current_title != derived || current_origin != origin;
    if changed {
        thread["title"] = json!(derived);
        thread["titleOrigin"] = json!(origin);
    }
    changed
}

/// Re-derives and persists a thread's title from its stored transcript items.
pub fn regenerate_thread_title(thread_id: &str, profile_id: Option<&str>) -> Value {
    let mut items = threads().lock().unwrap();
    if let Some(thread) = items
        .iter_mut()
        .find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id))
    {
        if let Some(derived) = derive_thread_title_from_thread(thread) {
            thread["title"] = json!(derived);
            thread["titleOrigin"] = json!("generated");
            if let Some(pid) = profile_id {
                thread["profileId"] = json!(pid);
            }
            touch(thread);
            let cloned = thread.clone();
            drop(items);
            persist();
            return cloned;
        }
        let cloned = thread.clone();
        drop(items);
        return cloned;
    }
    drop(items);
    load_thread(thread_id, profile_id, "New Chat")
}

const SYSTEM_MESSAGE_CASE1_HEADER: &str =
    "The following is a <SYSTEM_MESSAGE> not actually sent by the user";
const SYSTEM_MESSAGE_OPEN_TAG: &str = "<SYSTEM_MESSAGE>";
const SYSTEM_MESSAGE_CLOSE_TAG: &str = "</SYSTEM_MESSAGE>";

pub(crate) fn starts_with_system_message_envelope_header(text: &str) -> bool {
    let trimmed = text.trim_start_matches([' ', '\t', '\r', '\n']);
    if trimmed.starts_with(SYSTEM_MESSAGE_CASE1_HEADER) {
        return true;
    }
    if let Some(after_open) = trimmed.strip_prefix(SYSTEM_MESSAGE_OPEN_TAG) {
        return has_newline_then_message_tag(after_open);
    }
    false
}

fn has_newline_then_message_tag(after_open: &str) -> bool {
    let mut rest = after_open.trim_start_matches([' ', '\t']);
    let Some(next) = rest
        .strip_prefix("\r\n")
        .or_else(|| rest.strip_prefix('\n'))
    else {
        return false;
    };
    rest = next;
    loop {
        let trimmed_h = rest.trim_start_matches([' ', '\t']);
        if let Some(after_nl) = trimmed_h
            .strip_prefix("\r\n")
            .or_else(|| trimmed_h.strip_prefix('\n'))
        {
            rest = after_nl;
            continue;
        }
        return trimmed_h.starts_with("[Message]");
    }
}

fn find_system_message_envelope(s: &str, from: usize) -> Option<(usize, usize, bool)> {
    let mut pos1 = from;
    let case1 = loop {
        let Some(rel) = s[pos1..].find(SYSTEM_MESSAGE_CASE1_HEADER) else {
            break None;
        };
        let idx = pos1 + rel;
        if idx > 0 && s.as_bytes()[idx - 1] == b'`' {
            pos1 = idx + SYSTEM_MESSAGE_CASE1_HEADER.len();
            continue;
        }
        break Some((idx, idx + SYSTEM_MESSAGE_CASE1_HEADER.len()));
    };

    let mut pos2 = from;
    let case2 = loop {
        let Some(rel) = s[pos2..].find(SYSTEM_MESSAGE_OPEN_TAG) else {
            break None;
        };
        let idx = pos2 + rel;
        if idx > 0 && s.as_bytes()[idx - 1] == b'`' {
            pos2 = idx + SYSTEM_MESSAGE_OPEN_TAG.len();
            continue;
        }
        let after_open_idx = idx + SYSTEM_MESSAGE_OPEN_TAG.len();
        if has_newline_then_message_tag(&s[after_open_idx..]) {
            break Some((idx, after_open_idx));
        }
        pos2 = after_open_idx;
    };

    let (header_start, after_header) = match (case1, case2) {
        (Some(a), Some(b)) => {
            if a.0 <= b.0 {
                a
            } else {
                b
            }
        }
        (Some(a), None) => a,
        (None, Some(b)) => b,
        (None, None) => return None,
    };

    let mut block_start = header_start;
    if let Some(before_nl) = s[..header_start].strip_suffix('\n') {
        let before_line = before_nl.strip_suffix('\r').unwrap_or(before_nl);
        let line_start = before_line.rfind('\n').map_or(0, |p| p + 1);
        if before_line[line_start..].trim() == "user" {
            block_start = line_start;
        }
    }

    if let Some(rel_close) = s[after_header..].find(SYSTEM_MESSAGE_CLOSE_TAG) {
        Some((
            block_start,
            after_header + rel_close + SYSTEM_MESSAGE_CLOSE_TAG.len(),
            false,
        ))
    } else {
        Some((block_start, s.len(), true))
    }
}

pub(crate) struct SanitizedChatText {
    pub text: String,
    pub in_system_message: bool,
    pub stripped_leading: bool,
}

/// Sanitizes chat text, stripping leaked `<SYSTEM_MESSAGE>` protocol envelopes while preserving
/// genuine inline mentions and repairing paragraph seams.
pub(crate) fn sanitize_chat_text_with_state(
    text: &str,
    starts_in_system_message: bool,
) -> SanitizedChatText {
    let owned_filtered;
    let s: &str = if text
        .chars()
        .all(|ch| ch == '\n' || ch == '\r' || ch == '\t' || (ch as u32) >= 32)
    {
        text
    } else {
        owned_filtered = text
            .chars()
            .filter(|ch| *ch == '\n' || *ch == '\r' || *ch == '\t' || (*ch as u32) >= 32)
            .collect::<String>();
        &owned_filtered
    };

    let mut cursor = 0usize;
    let mut out = String::new();
    let mut stripped_any = false;
    let mut stripped_leading = starts_in_system_message;
    let mut pending_seam = false;
    let mut in_sys = false;

    if starts_in_system_message {
        stripped_any = true;
        if let Some(rel_close) = s.find(SYSTEM_MESSAGE_CLOSE_TAG) {
            cursor = rel_close + SYSTEM_MESSAGE_CLOSE_TAG.len();
            pending_seam = true;
        } else {
            return SanitizedChatText {
                text: String::new(),
                in_system_message: true,
                stripped_leading: true,
            };
        }
    }

    while cursor < s.len() {
        let Some((block_start, block_end, is_unclosed)) = find_system_message_envelope(s, cursor)
        else {
            break;
        };
        let before = &s[cursor..block_start];
        if before.trim().is_empty() {
            if !stripped_any {
                stripped_leading = true;
                pending_seam = true;
            }
        } else {
            if pending_seam {
                let trimmed_len = out.trim_end().len();
                out.truncate(trimmed_len);
                if !out.is_empty() {
                    out.push_str("\n\n");
                }
                out.push_str(before.trim_start());
            } else {
                out.push_str(before);
            }
            pending_seam = true;
        }
        stripped_any = true;
        in_sys = is_unclosed;
        cursor = block_end;
    }

    if !stripped_any {
        let bounded = if s.chars().count() <= 200_000 {
            s.to_string()
        } else {
            s.chars().take(200_000).collect()
        };
        return SanitizedChatText {
            text: bounded,
            in_system_message: false,
            stripped_leading: false,
        };
    }

    let tail = &s[cursor..];
    if tail.trim().is_empty() {
        let trimmed_len = out.trim_end().len();
        out.truncate(trimmed_len);
    } else if pending_seam {
        let trimmed_len = out.trim_end().len();
        out.truncate(trimmed_len);
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        out.push_str(tail.trim_start());
    } else {
        out.push_str(tail);
    }

    if out.chars().count() > 200_000 {
        out = out.chars().take(200_000).collect();
    }
    SanitizedChatText {
        text: out,
        in_system_message: in_sys,
        stripped_leading,
    }
}

pub fn sanitize_chat_text(text: &str) -> String {
    sanitize_chat_text_with_state(text, false).text
}

pub fn upsert_item(thread: &mut Value, item: &Value) {
    let id = item.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let Some(list) = thread
        .as_object_mut()
        .and_then(|object| object.get_mut("items"))
        .and_then(|items| items.as_array_mut())
    else {
        return;
    };
    if let Some(pos) = list
        .iter()
        .position(|existing| existing.get("id").and_then(|v| v.as_str()) == Some(id.as_str()))
    {
        let prev_text_len = list[pos]
            .get("text")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .len();
        let new_text_len = item
            .get("text")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .len();
        let has_tools_after = list[pos + 1..].iter().any(|later| {
            matches!(
                later.get("kind").and_then(|v| v.as_str()),
                Some("tool" | "command")
            )
        });
        let is_streaming_update =
            item.get("streaming").and_then(|v| v.as_bool()) == Some(true) && new_text_len > 0;
        let move_assistant_to_tail = item.get("kind").and_then(|v| v.as_str()) == Some("assistant")
            && (new_text_len > prev_text_len || (has_tools_after && is_streaming_update))
            && pos + 1 < list.len()
            && !list[pos + 1..]
                .iter()
                .any(|later| later.get("kind").and_then(|v| v.as_str()) == Some("user"));
        let slot = &mut list[pos];
        if let (Some(existing_obj), Some(new_obj)) = (slot.as_object_mut(), item.as_object()) {
            for (k, v) in new_obj {
                if v.is_null() {
                    continue;
                }
                if k == "createdAtUnixMs"
                    && existing_obj
                        .get(k)
                        .and_then(|x| x.as_i64())
                        .is_some_and(|x| x > 0)
                {
                    continue;
                }
                if let Some(s) = v.as_str() {
                    if (s.is_empty() || s == "tool")
                        && existing_obj
                            .get(k)
                            .and_then(|x| x.as_str())
                            .map(|x| !x.is_empty() && x != "tool")
                            .unwrap_or(false)
                    {
                        continue;
                    }
                }
                existing_obj.insert(k.clone(), v.clone());
            }
        } else {
            *slot = item.clone();
        }
        if move_assistant_to_tail {
            let moved = list.remove(pos);
            list.push(moved);
        }
    } else {
        list.push(item.clone());
    }
    crate::chat::thread_index::index_thread(thread);
}

pub const REWIND_THREAD_MISSING: &str = "That thread is not stored.";
pub const REWIND_MESSAGE_MISSING: &str = "That message is not in this thread.";

/// Drops the chosen user message and every later item.
///
/// This does not touch git and does not delete the thread. A missing thread or
/// a missing user message leaves the stored thread unchanged.
pub fn rewind_thread_transcript(thread_id: &str, message_id: &str) -> Result<String, String> {
    if thread_id.is_empty() {
        return Err(REWIND_THREAD_MISSING.to_string());
    }
    if message_id.is_empty() {
        return Err(REWIND_MESSAGE_MISSING.to_string());
    }
    let mut stored = threads().lock().unwrap();
    let Some(thread) = stored
        .iter_mut()
        .find(|thread| thread.get("id").and_then(|value| value.as_str()) == Some(thread_id))
    else {
        return Err(REWIND_THREAD_MISSING.to_string());
    };
    let text = {
        let Some(items) = thread.get_mut("items").and_then(|value| value.as_array_mut()) else {
            return Err(REWIND_MESSAGE_MISSING.to_string());
        };
        let Some(index) = items.iter().position(|item| {
            item.get("id").and_then(|value| value.as_str()) == Some(message_id)
                && item.get("kind").and_then(|value| value.as_str()) == Some("user")
        }) else {
            return Err(REWIND_MESSAGE_MISSING.to_string());
        };
        let text = items
            .get(index)
            .and_then(|item| item.get("text"))
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string();
        items.truncate(index);
        text
    };
    touch(thread);
    drop(stored);
    persist();
    Ok(text)
}

pub fn apply_launch_choices(thread_id: &str, req: Option<&Value>) {
    let Some(req) = req else {
        return;
    };
    let mut patch = serde_json::Map::new();
    if let Some(provider) = req.get("provider").and_then(|v| v.as_str()) {
        patch.insert("provider".to_string(), json!(provider));
    }
    if let Some(mode) = req.get("mode").and_then(|v| v.as_str()) {
        patch.insert("mode".to_string(), json!(mode));
    }
    if let Some(model) = req.get("model") {
        patch.insert("model".to_string(), model.clone());
    }
    if let Some(effort) = req.get("effort") {
        patch.insert("effort".to_string(), effort.clone());
    }
    if !patch.is_empty() {
        configure_thread(thread_id, &Value::Object(patch));
    }
}

#[cfg(test)]
mod rewind {
    use super::*;

    struct RemoveThread(String);

    impl Drop for RemoveThread {
        fn drop(&mut self) {
            if !threads().is_poisoned() && !std::thread::panicking() {
                remove_thread(&self.0);
            } else if let Ok(mut list) = threads().lock() {
                list.retain(|thread| thread.get("id").and_then(|v| v.as_str()) != Some(&self.0));
            }
        }
    }

    fn item_ids(thread: &Value) -> Vec<String> {
        thread
            .get("items")
            .and_then(|value| value.as_array())
            .unwrap_or(&Vec::new())
            .iter()
            .filter_map(|item| item.get("id").and_then(|value| value.as_str()).map(str::to_string))
            .collect()
    }

    #[test]
    fn truncation_removes_the_chosen_user_message_and_later_items_without_git() {
        let created = create_thread(None, "Rewind Probe", "claude", None);
        let thread_id = created
            .get("id")
            .and_then(|value| value.as_str())
            .unwrap()
            .to_string();
        let _cleanup = RemoveThread(thread_id.clone());
        {
            let mut stored = threads().lock().unwrap();
            let thread = stored
                .iter_mut()
                .find(|thread| thread.get("id").and_then(|value| value.as_str()) == Some(thread_id.as_str()))
                .expect("created thread");
            thread["items"] = json!([
                chat_item("early", "user", "keep me", false),
                chat_item("mid", "assistant", "earlier answer", false),
                chat_item("target", "user", "rewrite this", false),
                chat_item("later", "assistant", "later answer", false),
                chat_item("tail", "tool", "later tool", false)
            ]);
        }

        let before = {
            let stored = threads().lock().unwrap();
            stored
                .iter()
                .find(|thread| thread.get("id").and_then(|value| value.as_str()) == Some(thread_id.as_str()))
                .cloned()
                .expect("thread before rewind")
        };
        let missing = rewind_thread_transcript(&thread_id, "missing-message").expect_err("missing id");
        assert!(!missing.is_empty());
        let assistant = rewind_thread_transcript(&thread_id, "mid").expect_err("not a user message");
        assert!(!assistant.is_empty());
        let unchanged = {
            let stored = threads().lock().unwrap();
            stored
                .iter()
                .find(|thread| thread.get("id").and_then(|value| value.as_str()) == Some(thread_id.as_str()))
                .cloned()
                .expect("thread still stored")
        };
        assert_eq!(unchanged, before, "a missing id must not change the thread");
        assert_eq!(item_ids(&unchanged), vec!["early", "mid", "target", "later", "tail"]);

        let text = rewind_thread_transcript(&thread_id, "target").expect("rewind");
        assert_eq!(text, "rewrite this");
        let after = {
            let stored = threads().lock().unwrap();
            stored
                .iter()
                .find(|thread| thread.get("id").and_then(|value| value.as_str()) == Some(thread_id.as_str()))
                .cloned()
                .expect("thread survives rewind")
        };
        assert_eq!(after.get("id").and_then(|value| value.as_str()), Some(thread_id.as_str()));
        assert_eq!(after.get("title").and_then(|value| value.as_str()), Some("Rewind Probe"));
        assert_eq!(item_ids(&after), vec!["early", "mid"]);
        assert_eq!(after["items"][0]["text"], "keep me");
        assert_eq!(after["items"][1]["text"], "earlier answer");
    }

    #[test]
    fn restore_command_refuses_before_git_when_flags_are_false() {
        let created = create_thread(None, "Restore Probe", "claude", None);
        let thread_id = created
            .get("id")
            .and_then(|value| value.as_str())
            .unwrap()
            .to_string();
        let _cleanup = RemoveThread(thread_id.clone());
        {
            let mut stored = threads().lock().unwrap();
            let thread = stored
                .iter_mut()
                .find(|thread| thread.get("id").and_then(|value| value.as_str()) == Some(thread_id.as_str()))
                .expect("created thread");
            thread["providerCanRewind"] = json!(false);
            thread["isolatedCheckout"] = json!(true);
            thread["checkpointRef"] = json!("refs/kite/checkpoints/thread-1/run-1");
            thread["items"] = json!([chat_item("keep", "user", "stay", false)]);
        }
        let before = {
            let stored = threads().lock().unwrap();
            stored
                .iter()
                .find(|thread| thread.get("id").and_then(|value| value.as_str()) == Some(thread_id.as_str()))
                .cloned()
                .expect("thread before restore")
        };

        let refused = tauri::async_runtime::block_on(crate::chat_commands::restore_thread_checkpoint(Some(json!({
            "threadId": thread_id,
            "folder": "C:/this/path/must/not/be/used"
        }))));
        assert_eq!(refused["restored"], json!(false));
        assert_eq!(
            refused["error"],
            json!("The provider cannot rewind this conversation.")
        );

        {
            let mut stored = threads().lock().unwrap();
            let thread = stored
                .iter_mut()
                .find(|thread| thread.get("id").and_then(|value| value.as_str()) == Some(thread_id.as_str()))
                .expect("thread still stored");
            thread["providerCanRewind"] = json!(true);
            thread["isolatedCheckout"] = json!(false);
        }
        let shared = tauri::async_runtime::block_on(crate::chat_commands::restore_thread_checkpoint(Some(json!({
            "threadId": thread_id,
            "worktree": "/tmp/not-a-worktree"
        }))));
        assert_eq!(shared["restored"], json!(false));
        assert_eq!(
            shared["error"],
            json!("File restore stays off unless this thread has its own isolated checkout.")
        );

        let after = {
            let stored = threads().lock().unwrap();
            stored
                .iter()
                .find(|thread| thread.get("id").and_then(|value| value.as_str()) == Some(thread_id.as_str()))
                .cloned()
                .expect("restore must not delete the thread")
        };
        assert_eq!(item_ids(&after), item_ids(&before));
        assert_eq!(after["items"][0]["text"], "stay");

        let unknown = "missing-rewind-thread-does-not-exist";
        let missing = tauri::async_runtime::block_on(crate::chat_commands::restore_thread_checkpoint(Some(json!({
            "threadId": unknown
        }))));
        assert_eq!(missing["restored"], json!(false));
        assert!(missing["error"].as_str().is_some_and(|text| !text.is_empty()));
        let created_anyway = threads().lock().unwrap().iter().any(|thread| {
            thread.get("id").and_then(|value| value.as_str()) == Some(unknown)
        });
        assert!(!created_anyway, "a missing thread must not be created");
    }

    #[test]
    fn blank_thread_remembers_last_selected_model_and_effort() {
        let tid = "temp-thread-model-memory";
        let _cleanup = RemoveThread(tid.to_string());
        configure_thread(tid, &json!({
            "model": "gemini-3.8-flash",
            "effort": "medium"
        }));
        let blank = blank_thread("blank-probe-id", None, "New Chat", "antigravity", None);
        assert_eq!(blank["model"], json!("gemini-3.8-flash"));
        assert_eq!(blank["effort"], json!("medium"));
        assert!(blank["providerOptions"].as_array().unwrap().iter().any(|opt| {
            opt["id"] == "effort" && opt["value"] == "medium"
        }));
    }

    #[test]
    fn upsert_item_moves_assistant_to_tail_when_new_text_arrives_after_tools() {
        let mut thread = json!({
            "id": "t-order",
            "items": [
                { "id": "u1", "kind": "user", "text": "check status" },
                { "id": "a1", "kind": "assistant", "text": "Checking repository...", "streaming": true },
                { "id": "tool-1", "kind": "tool", "title": "Read README.md", "text": "" },
                { "id": "tool-2", "kind": "tool", "title": "Searched status", "text": "" }
            ]
        });

        upsert_item(
            &mut thread,
            &json!({
                "id": "a1",
                "kind": "assistant",
                "text": "Checking repository...\n\nAll checks passed.",
                "streaming": true
            }),
        );

        assert_eq!(
            item_ids(&thread),
            vec!["u1", "tool-1", "tool-2", "a1"],
            "assistant response must move below tools when new text arrives after tools"
        );
    }

    #[test]
    fn load_thread_read_does_not_persist_when_unmodified() {
        let created = create_thread(None, "Read Perf Probe", "claude", None);
        let tid = created
            .get("id")
            .and_then(|value| value.as_str())
            .expect("created id")
            .to_string();
        let _cleanup = RemoveThread(tid.clone());

        let persists_before = crate::persist::persist_calls_count();
        let loaded = load_thread(&tid, None, "Chat Thread");
        assert_eq!(loaded.get("id").and_then(|v| v.as_str()), Some(tid.as_str()));
        let persists_after = crate::persist::persist_calls_count();
        assert_eq!(
            persists_after, persists_before,
            "reading an existing unmodified thread must not trigger a full SQLite persist"
        );
    }

    #[test]
    fn load_thread_normalizes_missing_items_to_empty_array() {
        let tid = format!("legacy-no-items-{}", uuid::Uuid::new_v4().simple());
        let _cleanup = RemoveThread(tid.clone());
        {
            let mut list = threads().lock().unwrap();
            list.push(json!({
                "id": tid,
                "title": "Completed Thread",
                "provider": "claude"
            }));
        }

        let loaded = load_thread(&tid, None, "Chat Thread");
        assert_eq!(
            loaded.get("items").and_then(|v| v.as_array()).map(|a| a.len()),
            Some(0),
            "load_thread must guarantee items is always a JSON array"
        );
    }

    #[test]
    fn internal_dispatch_helpers_distinguish_envelopes_and_human_prompts() {
        let envelope = "[kite from=\"thread:child-1\"]\nThis is another agent, not the person.\nTo reply: kite dispatch send thread:child-1 \"<reply>\"\nIrreversible and privileged actions still wait for the person.\nBODY:\nstate: done";
        let wakeup = "[Swarm Coordinator Wakeup — Swarm #main]\n@worker finished.";
        assert!(is_internal_dispatch_prompt(envelope));
        assert!(is_internal_dispatch_prompt(wakeup));
        assert!(!is_internal_dispatch_prompt("Run two subagents in parallel"));

        let mut env_item = chat_item("u-env", "user", envelope, false);
        assert!(is_internal_dispatch_item(&env_item));
        assert!(!is_human_user_item(&env_item));

        env_item["internalDispatch"] = json!(true);
        let tagged = json!({ "id": "u-tag", "kind": "user", "text": "plain wakeup", "internalDispatch": true });
        assert!(is_internal_dispatch_item(&tagged));

        let thread = json!({
            "items": [
                chat_item("u-env-first", "user", envelope, false),
                chat_item("u-human-first", "user", "Real first prompt", false),
                chat_item("a1", "assistant", "Done", false),
                tagged,
                chat_item("u-human-last", "user", "Follow-up question", false),
                chat_item("u-wakeup", "user", wakeup, false)
            ]
        });
        assert_eq!(human_user_prompt(&thread, false), Some("Real first prompt"));
        assert_eq!(human_user_prompt(&thread, true), Some("Follow-up question"));
    }

    #[test]
    fn clean_title_candidate_handles_leading_newlines_markdown_fences_quotes_and_pua_tokens() {
        assert_eq!(
            clean_title_candidate("\n\n  # Fix thread sidebar routing\nDetails below", 60).as_deref(),
            Some("Fix thread sidebar routing")
        );
        assert_eq!(
            clean_title_candidate("> Quoted context\n\nWhy does workspaceId stay null?", 60).as_deref(),
            Some("Why does workspaceId stay null?")
        );
        assert_eq!(
            clean_title_candidate("```ts\nconst x = 1;\n```", 60).as_deref(),
            Some("const x = 1;")
        );
        // Mention chip payload: {"k":"file","i":"src/App.tsx","l":"App.tsx"}
        // Citation chip payload: {"m":"q","q":"quoted text","c":"Explain this hook"}
        let with_pua = "\u{E002}eyJrIjoiZmlsZSIsImkiOiJzcmMvQXBwLnRzeCIsImwiOiJBcHAudHN4In0\u{E003} \u{E000}eyJtIjoicSIsInEiOiJxdW90ZWQgdGV4dCIsImMiOiJFeHBsYWluIHRoaXMgaG9vayJ9\u{E001}";
        assert_eq!(
            clean_title_candidate(with_pua, 60).as_deref(),
            Some("@App.tsx Explain this hook")
        );
    }

    #[test]
    fn apply_derived_title_heals_placeholders_and_preserves_user_renames() {
        let mut stale = json!({
            "id": "stale-1",
            "title": "New Chat",
            "items": [
                chat_item("u1", "user", "\n- Debug workspace association in ThreadRoster", false)
            ]
        });
        assert!(apply_derived_title_if_needed(&mut stale, "generated", false));
        assert_eq!(
            stale.get("title").and_then(|v| v.as_str()),
            Some("Debug workspace association in ThreadRoster")
        );
        assert_eq!(
            stale.get("titleOrigin").and_then(|v| v.as_str()),
            Some("generated")
        );

        let mut manual = json!({
            "id": "manual-1",
            "title": "My Custom Name",
            "titleOrigin": "user",
            "items": [
                chat_item("u1", "user", "Some long prompt that should not overwrite manual title", false)
            ]
        });
        assert!(!apply_derived_title_if_needed(&mut manual, "generated", true));
        assert_eq!(
            manual.get("title").and_then(|v| v.as_str()),
            Some("My Custom Name")
        );
    }

    #[test]
    fn load_thread_and_history_heal_persisted_placeholder_titles() {
        let tid = format!("heal-placeholder-{}", uuid::Uuid::new_v4().simple());
        let _cleanup = RemoveThread(tid.clone());
        {
            let mut list = threads().lock().unwrap();
            list.push(json!({
                "id": tid,
                "title": "New Chat",
                "provider": "claude",
                "status": "idle",
                "items": [
                    chat_item("u1", "user", "Hola", false),
                    chat_item("u2", "user", "Fix missing thread titles on New Chat", false)
                ]
            }));
        }

        let loaded = load_thread(&tid, None, "New Chat");
        assert_eq!(
            loaded.get("title").and_then(|v| v.as_str()),
            Some("Fix missing thread titles on New Chat")
        );

        let renamed = rename_thread(&tid, None, "Pinned Manual Title");
        assert_eq!(renamed.get("title").and_then(|v| v.as_str()), Some("Pinned Manual Title"));
        assert_eq!(renamed.get("titleOrigin").and_then(|v| v.as_str()), Some("user"));

        let regenerated = regenerate_thread_title(&tid, None);
        assert_eq!(
            regenerated.get("title").and_then(|v| v.as_str()),
            Some("Fix missing thread titles on New Chat")
        );
        assert_eq!(
            regenerated.get("titleOrigin").and_then(|v| v.as_str()),
            Some("generated")
        );
    }

    #[test]
    fn derive_title_falls_back_to_attachment_or_assistant_when_prompt_empty() {
        let mut att_item = chat_item("u1", "user", "   ", false);
        att_item["attachments"] = json!([{ "fileName": "architecture-diagram.png" }]);
        let att_thread = json!({ "items": [att_item] });
        assert_eq!(
            derive_thread_title_from_thread(&att_thread).as_deref(),
            Some("architecture-diagram.png")
        );

        let assistant_only = json!({
            "items": [
                chat_item("u1", "user", "   ", false),
                chat_item("a1", "assistant", "Here is the summary of your repository setup", false)
            ]
        });
        assert_eq!(
            derive_thread_title_from_thread(&assistant_only).as_deref(),
            Some("Here is the summary of your repository setup")
        );
    }

    #[test]
    fn sanitize_chat_text_strips_system_message_envelopes_and_repairs_paragraph_seams() {
        let complete = "Checking files.\n\nuser\nThe following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-18T01:00:00Z sender=sub1 content=OK\n</SYSTEM_MESSAGE>Confirmado, ya terminó.";
        assert_eq!(
            sanitize_chat_text(complete),
            "Checking files.\n\nConfirmado, ya terminó."
        );

        let crlf_standalone = "Before.\r\n\r\nuser\r\n<SYSTEM_MESSAGE>\r\n[Message] sender=task-1 content=done\r\n</SYSTEM_MESSAGE>After.";
        assert_eq!(sanitize_chat_text(crlf_standalone), "Before.\n\nAfter.");

        let unclosed = "Partial answer.\n\nuser\nThe following is a <SYSTEM_MESSAGE> not actually sent by the user.\n<SYSTEM_MESSAGE>\n[Message] sender=sub2";
        assert_eq!(sanitize_chat_text(unclosed), "Partial answer.");

        let unclosed_only = "user\nThe following is a <SYSTEM_MESSAGE> not actually sent by the user.\n<SYSTEM_MESSAGE>\n[Message] pending";
        assert_eq!(sanitize_chat_text(unclosed_only), "");

        let code_mention = "We sanitize `<SYSTEM_MESSAGE>` and prose mentioning <SYSTEM_MESSAGE> tags safely.";
        assert_eq!(sanitize_chat_text(code_mention), code_mention);

        let world_delta = " world";
        assert_eq!(sanitize_chat_text(world_delta), " world");
    }
}
