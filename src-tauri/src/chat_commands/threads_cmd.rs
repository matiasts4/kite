use crate::chat::{
    apply_launch_choices, archived_at_ms, cancel_turn, configure_thread, create_thread, history, live_turns,
    load_thread, parse_attachments, provider_models_for, provider_ok, read_turn_updates, recover_thread,
    release_staged_attachment, remove_thread, rename_thread, set_agent_model, set_agent_plan, set_pinned,
    stage_blob_attachment, stage_dropped_path, stage_dropped_paths, start_turn_with_binding, touch,
    SendBinding, ThreadEventLog,
};
use crate::persist::{body, load_grid, persist, save_grid, threads};
use serde_json::{json, Value};
use uuid::Uuid;

pub(crate) fn forget_thread(request: &Option<Value>) {
    if let Some(thread_id) = body(request).and_then(|req| req.get("threadId")).and_then(|v| v.as_str()) {
        remove_thread(thread_id);
    }
}

pub fn create_general_chat(request: Option<Value>) -> Value {
    let req = body(&request);
    let provider = req.and_then(|r| r.get("provider")).and_then(|v| v.as_str()).unwrap_or("antigravity");
    let workspace_id = req.and_then(|r| r.get("workspaceId")).and_then(|v| v.as_str());
    let thread = create_thread(None, "New Chat", provider, workspace_id);
    let thread_id = thread.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if req.and_then(|r| r.get("mode")).and_then(|v| v.as_str()).is_some() {
        return configure_thread(&thread_id, req.unwrap_or(&Value::Null));
    }
    thread
}

pub(super) fn agent_engine_provider(engine: Option<&str>) -> &'static str {
    match engine {
        Some("claude") | Some("claude-code") => "claude",
        Some("codex") => "codex",
        Some("cursor") => "cursor",
        Some("gemini") => "gemini",
        Some("grok") => "grok",
        Some("opencode") | Some("open-code") => "opencode",
        Some("antigravity") | Some("agy") => "antigravity",
        _ => "antigravity",
    }
}

/// A provider explicitly chosen in the agent draft wins over the agent engine.
/// An invalid or absent choice keeps the engine mapping, then antigravity.
pub(super) fn resolve_initial_provider(requested: Option<&str>, engine: Option<&str>) -> String {
    match requested {
        Some(provider) if provider_ok(provider) => provider.to_string(),
        _ => agent_engine_provider(engine).to_string(),
    }
}

pub fn create_agent_chat(request: Option<Value>) -> Value {
    let req = body(&request);
    let agent_id = req
        .and_then(|r| r.get("agentId"))
        .and_then(|v| v.as_str())
        .unwrap_or("c3333333-3333-4333-8333-333333333333");

    let agent_opt = {
        let items = crate::persist::agents().lock().unwrap();
        items.iter().find(|a| a.id == agent_id).cloned()
    };

    let requested_provider = req.and_then(|r| r.get("provider")).and_then(|v| v.as_str());
    let engine = agent_opt.as_ref().map(|agent| agent.engine.as_str());
    let initial_provider = resolve_initial_provider(requested_provider, engine);

    let mut thread = create_thread(Some(agent_id), "New Agent Chat", &initial_provider, None);

    if let Some(agent) = agent_opt {
        if let Some(mode) = agent.default_mode {
            thread["mode"] = json!(mode);
        }
        if let Some(plan) = agent.default_plan {
            thread["plan"] = json!(plan);
        }
        if let Some(model) = agent.default_model {
            thread["model"] = json!(model);
        }
        if !agent.default_provider_options.is_empty() {
            thread["providerOptions"] = json!(agent.default_provider_options);
        }
        crate::chat::replace_thread(&thread);
    }

    let requested_mode = req.and_then(|r| r.get("mode")).and_then(|v| v.as_str());
    let requested_model = req.and_then(|r| r.get("model"));
    if requested_mode.is_some() || requested_model.is_some() {
        let mut patch = serde_json::Map::new();
        patch.insert("provider".into(), json!(initial_provider));
        if let Some(mode) = requested_mode {
            patch.insert("mode".into(), json!(mode));
        }
        if let Some(model) = requested_model {
            patch.insert("model".into(), model.clone());
        }
        let thread_id = thread.get("id").and_then(|v| v.as_str()).unwrap_or("");
        return configure_thread(thread_id, &Value::Object(patch));
    }

    thread
}

pub fn load_chat_thread(request: Option<Value>) -> Value {
    let thread_id = body(&request)
        .and_then(|r| r.get("threadId"))
        .and_then(|v| v.as_str())
        .unwrap_or("11111111-1111-4111-8111-111111111111");
    load_thread(thread_id, None, "Chat Thread")
}

pub fn load_agent_chat_thread(request: Option<Value>) -> Value {
    let req = body(&request);
    let agent_id = req.and_then(|r| r.get("agentId")).and_then(|v| v.as_str()).unwrap_or("c3333333-3333-4333-8333-333333333333");
    let thread_id = req.and_then(|r| r.get("threadId")).and_then(|v| v.as_str()).unwrap_or("11111111-1111-4111-8111-111111111111");
    load_thread(thread_id, Some(agent_id), "Agent Chat Thread")
}

/// Reopens a thread from its durable event log without starting a provider.
///
/// The recovered thread falls back to the stored compatibility snapshot when
/// the log is absent or unreadable. The response separates "a provider handle
/// exists" from "the renderer may resume": a session is offered only when the
/// recovered thread carries a provider-issued handle.
pub fn recover_chat_thread(request: Option<Value>) -> Value {
    let Some(thread_id) = request_thread_id(&request) else {
        return json!({
            "threadId": Value::Null,
            "thread": Value::Null,
            "events": [],
            "source": "snapshot",
            "resumeAvailable": false,
            "resumeHandle": Value::Null,
            "diagnostic": "a thread id is required",
            "readOnly": true
        });
    };
    let path = ThreadEventLog::default_path(&thread_id);
    let recovered = recover_thread(&thread_id, &path);
    let resume_available = recovered.resume_available();
    json!({
        "threadId": recovered.thread_id,
        "thread": recovered.thread,
        "events": recovered.events,
        "source": recovered.source.as_str(),
        "resumeAvailable": resume_available,
        "resumeHandle": recovered.resume_handle,
        "diagnostic": recovered.diagnostic,
        "readOnly": true
    })
}

pub fn rename_chat_thread(request: Option<Value>) -> Value {
    let req = body(&request);
    let thread_id = req.and_then(|r| r.get("threadId")).and_then(|v| v.as_str()).unwrap_or("11111111-1111-4111-8111-111111111111");
    let title = req.and_then(|r| r.get("title")).and_then(|v| v.as_str()).unwrap_or("Chat");
    rename_thread(thread_id, None, title)
}

pub fn rename_agent_chat_thread(request: Option<Value>) -> Value {
    let req = body(&request);
    let thread_id = req.and_then(|r| r.get("threadId")).and_then(|v| v.as_str()).unwrap_or("11111111-1111-4111-8111-111111111111");
    let agent_id = req.and_then(|r| r.get("agentId")).and_then(|v| v.as_str()).unwrap_or("c3333333-3333-4333-8333-333333333333");
    let title = req.and_then(|r| r.get("title")).and_then(|v| v.as_str()).unwrap_or("Agent Chat");
    rename_thread(thread_id, Some(agent_id), title)
}

pub fn set_chat_thread_pinned(request: Option<Value>) -> Value {
    let req = body(&request);
    let thread_id = req.and_then(|r| r.get("threadId")).and_then(|v| v.as_str()).unwrap_or("11111111-1111-4111-8111-111111111111");
    let pinned = req.and_then(|r| r.get("pinned")).and_then(|v| v.as_bool()).unwrap_or(false);
    set_pinned(thread_id, pinned)
}

pub fn set_agent_chat_model(request: Option<Value>) -> Value {
    let req = body(&request);
    let thread_id = req.and_then(|r| r.get("threadId")).and_then(|v| v.as_str()).unwrap_or("11111111-1111-4111-8111-111111111111");
    let agent_id = req.and_then(|r| r.get("agentId")).and_then(|v| v.as_str()).unwrap_or("c3333333-3333-4333-8333-333333333333");
    let provider = req.and_then(|r| r.get("provider")).and_then(|v| v.as_str()).unwrap_or("antigravity");
    set_agent_model(agent_id, thread_id, provider, req.and_then(|r| r.get("model")))
}

pub fn set_agent_chat_plan(request: Option<Value>) -> Value {
    let req = body(&request);
    let thread_id = req.and_then(|r| r.get("threadId")).and_then(|v| v.as_str()).unwrap_or("11111111-1111-4111-8111-111111111111");
    let agent_id = req.and_then(|r| r.get("agentId")).and_then(|v| v.as_str()).unwrap_or("c3333333-3333-4333-8333-333333333333");
    let plan = req.and_then(|r| r.get("plan")).and_then(|v| v.as_bool()).unwrap_or(false);
    set_agent_plan(agent_id, thread_id, plan)
}

pub fn update_chat_configuration(request: Option<Value>) -> Value {
    let req = body(&request);
    let thread_id = req.and_then(|r| r.get("threadId")).and_then(|v| v.as_str()).unwrap_or("11111111-1111-4111-8111-111111111111");
    configure_thread(thread_id, req.unwrap_or(&Value::Null))
}

struct FlatThreadMeta {
    side_chat: bool,
    started_by_agent: bool,
    has_parent: bool,
    status: String,
    has_approval: bool,
    has_user_input: bool,
}

fn filter_flat_history(mut res: Value, is_agent_chat: bool) -> Value {
    let raw_meta: std::collections::HashMap<String, FlatThreadMeta> = threads()
        .lock()
        .ok()
        .map(|all| {
            all.iter()
                .filter_map(|t| {
                    let id = t.get("id").and_then(Value::as_str)?.to_string();
                    let side_chat = t.get("sideChat").and_then(Value::as_bool).unwrap_or(false);
                    let started_by_agent = t
                        .get("startedByAgent")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    let has_parent = t
                        .get("parentThreadId")
                        .and_then(Value::as_str)
                        .is_some_and(|p| !p.trim().is_empty());
                    let status = t
                        .get("status")
                        .and_then(Value::as_str)
                        .unwrap_or("idle")
                        .to_string();
                    let has_approval = t
                        .get("pendingApproval")
                        .is_some_and(|v| !v.is_null());
                    let has_user_input = t
                        .get("pendingUserInput")
                        .is_some_and(|v| !v.is_null());
                    Some((
                        id,
                        FlatThreadMeta {
                            side_chat,
                            started_by_agent,
                            has_parent,
                            status,
                            has_approval,
                            has_user_input,
                        },
                    ))
                })
                .collect()
        })
        .unwrap_or_default();

    if let Some(arr) = res.get_mut("summaries").and_then(Value::as_array_mut) {
        arr.retain(|s| {
            let id = s.get("id").and_then(Value::as_str).unwrap_or("");
            let raw = raw_meta.get(id);
            let side_chat = s
                .get("sideChat")
                .and_then(Value::as_bool)
                .or_else(|| raw.map(|r| r.side_chat))
                .unwrap_or(false);
            let started_by_agent = s
                .get("startedByAgent")
                .and_then(Value::as_bool)
                .or_else(|| raw.map(|r| r.started_by_agent))
                .unwrap_or(false);
            let has_parent = s
                .get("parentThreadId")
                .and_then(Value::as_str)
                .is_some_and(|p| !p.trim().is_empty())
                || raw.is_some_and(|r| r.has_parent);

            if is_agent_chat {
                return !side_chat && !(started_by_agent && has_parent);
            }

            if !side_chat && !(started_by_agent && has_parent) {
                return true;
            }
            let status = s
                .get("status")
                .and_then(Value::as_str)
                .or_else(|| raw.map(|r| r.status.as_str()))
                .unwrap_or("idle");
            let has_pending_approval = s
                .get("pendingApproval")
                .is_some_and(|v| !v.is_null())
                || raw.is_some_and(|r| r.has_approval);
            let has_pending_user_input = s
                .get("pendingUserInput")
                .is_some_and(|v| !v.is_null())
                || raw.is_some_and(|r| r.has_user_input);
            has_parent
                && (started_by_agent || side_chat)
                && (matches!(status, "running" | "waiting" | "pendingApproval")
                    || has_pending_approval
                    || has_pending_user_input)
        });
    }
    res
}

pub fn list_chat_summaries(_request: Option<Value>) -> Value {
    filter_flat_history(history(None), false)
}

pub fn list_agent_chat_summaries(request: Option<Value>) -> Value {
    let agent_id = body(&request).and_then(|req| req.get("agentId")).and_then(|v| v.as_str());
    filter_flat_history(history(agent_id), true)
}

pub(super) const ARCHIVE_RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1000;

pub(super) fn request_thread_id(request: &Option<Value>) -> Option<String> {
    body(request)
        .and_then(|req| req.get("threadId"))
        .and_then(|value| value.as_str())
        .map(|id| id.to_string())
}

pub(super) fn archive_thread(thread_id: &str) {
    let mut items = threads().lock().unwrap();
    let Some(thread) = items
        .iter_mut()
        .find(|thread| thread.get("id").and_then(|value| value.as_str()) == Some(thread_id))
    else {
        return;
    };
    touch(thread);
    let archived_at = thread.get("updatedAtUnixMs").and_then(|value| value.as_i64()).unwrap_or(0);
    thread["archivedAtUnixMs"] = json!(archived_at);
    drop(items);
    persist();
}

pub(super) fn clear_archived(thread_id: &str) {
    let mut items = threads().lock().unwrap();
    let Some(thread) = items
        .iter_mut()
        .find(|thread| thread.get("id").and_then(|value| value.as_str()) == Some(thread_id))
    else {
        return;
    };
    if archived_at_ms(thread).is_none() {
        return;
    }
    if let Some(object) = thread.as_object_mut() {
        object.remove("archivedAtUnixMs");
        object.remove("expiresAtUnixMs");
    }
    touch(thread);
    drop(items);
    persist();
}

pub(super) fn purge_archived_thread(thread_id: &str) {
    let mut items = threads().lock().unwrap();
    let before = items.len();
    items.retain(|thread| {
        let same = thread.get("id").and_then(|value| value.as_str()) == Some(thread_id);
        !(same && archived_at_ms(thread).is_some())
    });
    let removed = items.len() != before;
    drop(items);
    if removed {
        persist();
    }
}

pub(super) fn archived_owner(thread: &Value, owner: Option<&str>) -> bool {
    let profile_id = thread.get("profileId").and_then(|value| value.as_str());
    match owner {
        Some(id) => profile_id == Some(id),
        None => profile_id.is_none(),
    }
}

pub(super) fn archived_summary(thread: &Value) -> Option<Value> {
    let archived_at = archived_at_ms(thread)?;
    let expires_at = archived_at.saturating_add(ARCHIVE_RETENTION_MS);
    let expires_at = if expires_at > archived_at {
        expires_at
    } else {
        archived_at.saturating_add(1)
    };
    let title = thread
        .get("title")
        .and_then(|value| value.as_str())
        .filter(|title| !title.is_empty())
        .unwrap_or("Chat");
    Some(json!({
        "schemaVersion": 1,
        "id": thread.get("id")?,
        "profileId": thread.get("profileId").and_then(|value| value.as_str()),
        "title": title,
        "revision": thread.get("revision")?,
        "archivedAtUnixMs": archived_at,
        "expiresAtUnixMs": expires_at,
        "provider": thread.get("provider").and_then(|value| value.as_str()).unwrap_or("antigravity"),
        "model": thread.get("model").and_then(|value| value.as_str())
    }))
}

pub fn list_archived_chats(request: Option<Value>) -> Vec<Value> {
    let owner = body(&request)
        .and_then(|req| req.get("profileId"))
        .and_then(|value| value.as_str())
        .map(|id| id.to_string());
    let items = threads().lock().unwrap();
    items
        .iter()
        .filter(|thread| archived_owner(thread, owner.as_deref()))
        .filter_map(archived_summary)
        .take(1000)
        .collect()
}

pub fn restore_archived_chat(request: Option<Value>) -> Value {
    if let Some(thread_id) = request_thread_id(&request) {
        clear_archived(&thread_id);
    }
    Value::Null
}

pub fn archive_chat_thread(request: Option<Value>) -> Value {
    if let Some(thread_id) = request_thread_id(&request) {
        archive_thread(&thread_id);
    }
    json!({
        "deleted": true,
        "history": filter_flat_history(history(None), false)
    })
}

pub fn archive_agent_chat_thread(request: Option<Value>) -> Value {
    if let Some(thread_id) = request_thread_id(&request) {
        archive_thread(&thread_id);
    }
    let agent_id = body(&request).and_then(|req| req.get("agentId")).and_then(|v| v.as_str());
    json!({
        "deleted": true,
        "history": filter_flat_history(history(agent_id), true)
    })
}

pub fn delete_chat_thread(request: Option<Value>) -> Value {
    forget_thread(&request);
    json!({
        "deleted": true,
        "history": filter_flat_history(history(None), false)
    })
}

pub fn delete_agent_chat_thread(request: Option<Value>) -> Value {
    forget_thread(&request);
    let agent_id = body(&request).and_then(|req| req.get("agentId")).and_then(|v| v.as_str());
    json!({
        "deleted": true,
        "history": filter_flat_history(history(agent_id), true)
    })
}

pub fn purge_archived_chat(request: Option<Value>) -> Value {
    if let Some(thread_id) = request_thread_id(&request) {
        purge_archived_thread(&thread_id);
    }
    Value::Null
}


pub fn reorder_agent_chat_tabs(request: Option<Value>) -> Value {
    let req = body(&request);
    let agent_id = req.and_then(|r| r.get("agentId")).and_then(|v| v.as_str());
    let ids: Vec<String> = req
        .and_then(|r| r.get("threadIds"))
        .and_then(|v| v.as_array())
        .map(|items| items.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default();
    if ids.is_empty() {
        return Value::Null;
    }
    {
        let mut items = threads().lock().unwrap();
        for (index, id) in ids.iter().enumerate() {
            if let Some(thread) = items.iter_mut().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(id.as_str())) {
                if let Some(agent_id) = agent_id {
                    if thread.get("profileId").and_then(|v| v.as_str()) != Some(agent_id) {
                        continue;
                    }
                }
                thread["tabOrder"] = json!(index);
            }
        }
    }
    persist();
    Value::Null
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flat_history_filtering_excludes_side_chats_and_settled_children() {
        let agent_id = format!("prof-flat-{}", Uuid::new_v4().simple());
        let side_tid = format!("side-{}", Uuid::new_v4().simple());
        let settled_child_tid = format!("child-idle-{}", Uuid::new_v4().simple());
        let active_child_tid = format!("child-run-{}", Uuid::new_v4().simple());
        let input_child_tid = format!("child-input-{}", Uuid::new_v4().simple());
        let top_tid = format!("top-{}", Uuid::new_v4().simple());

        {
            let mut all = threads().lock().unwrap();
            all.push(json!({
                "id": side_tid,
                "title": "Side Chat",
                "profileId": agent_id,
                "provider": "grok",
                "status": "running",
                "sideChat": true,
                "startedByAgent": false,
                "updatedAtUnixMs": 100
            }));
            all.push(json!({
                "id": settled_child_tid,
                "title": "Settled Subagent",
                "profileId": agent_id,
                "provider": "grok",
                "status": "idle",
                "sideChat": true,
                "startedByAgent": true,
                "parentThreadId": top_tid,
                "updatedAtUnixMs": 200
            }));
            all.push(json!({
                "id": active_child_tid,
                "title": "Active Subagent",
                "profileId": agent_id,
                "provider": "grok",
                "status": "running",
                "sideChat": true,
                "startedByAgent": true,
                "parentThreadId": top_tid,
                "updatedAtUnixMs": 300
            }));
            all.push(json!({
                "id": input_child_tid,
                "title": "Input Child",
                "profileId": agent_id,
                "provider": "codex",
                "status": "idle",
                "sideChat": true,
                "startedByAgent": false,
                "parentThreadId": top_tid,
                "pendingUserInput": { "requestId": "req-1", "questions": [] },
                "updatedAtUnixMs": 350
            }));
            all.push(json!({
                "id": top_tid,
                "title": "Top Thread",
                "profileId": agent_id,
                "provider": "antigravity",
                "status": "idle",
                "updatedAtUnixMs": 400
            }));
        }

        let top_res = list_chat_summaries(None);
        let top_ids: Vec<&str> = top_res["summaries"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|s| s.get("id").and_then(Value::as_str))
            .collect();
        assert!(!top_ids.contains(&side_tid.as_str()), "ids={top_ids:?}");
        assert!(!top_ids.contains(&settled_child_tid.as_str()), "ids={top_ids:?}");
        assert!(top_ids.contains(&active_child_tid.as_str()), "ids={top_ids:?}");
        assert!(top_ids.contains(&input_child_tid.as_str()), "ids={top_ids:?}");
        assert!(top_ids.contains(&top_tid.as_str()), "ids={top_ids:?}");

        let agent_res = list_agent_chat_summaries(Some(json!({ "agentId": agent_id })));
        let agent_ids: Vec<&str> = agent_res["summaries"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|s| s.get("id").and_then(Value::as_str))
            .collect();
        assert!(!agent_ids.contains(&side_tid.as_str()), "ids={agent_ids:?}");
        assert!(!agent_ids.contains(&settled_child_tid.as_str()), "ids={agent_ids:?}");
        assert!(!agent_ids.contains(&active_child_tid.as_str()), "ids={agent_ids:?}");
        assert!(!agent_ids.contains(&input_child_tid.as_str()), "ids={agent_ids:?}");
        assert!(agent_ids.contains(&top_tid.as_str()), "ids={agent_ids:?}");

        threads().lock().unwrap().retain(|t| {
            let id = t.get("id").and_then(Value::as_str).unwrap_or("");
            id != side_tid
                && id != settled_child_tid
                && id != active_child_tid
                && id != input_child_tid
                && id != top_tid
        });
    }
}
