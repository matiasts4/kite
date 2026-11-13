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

pub fn list_chat_summaries(_request: Option<Value>) -> Value {
    history(None)
}

pub fn list_agent_chat_summaries(request: Option<Value>) -> Value {
    let agent_id = body(&request).and_then(|req| req.get("agentId")).and_then(|v| v.as_str());
    history(agent_id)
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
        "history": history(None)
    })
}

pub fn archive_agent_chat_thread(request: Option<Value>) -> Value {
    if let Some(thread_id) = request_thread_id(&request) {
        archive_thread(&thread_id);
    }
    let agent_id = body(&request).and_then(|req| req.get("agentId")).and_then(|v| v.as_str());
    json!({
        "deleted": true,
        "history": history(agent_id)
    })
}

pub fn delete_chat_thread(request: Option<Value>) -> Value {
    forget_thread(&request);
    json!({
        "deleted": true,
        "history": history(None)
    })
}

pub fn delete_agent_chat_thread(request: Option<Value>) -> Value {
    forget_thread(&request);
    let agent_id = body(&request).and_then(|req| req.get("agentId")).and_then(|v| v.as_str());
    json!({
        "deleted": true,
        "history": history(agent_id)
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
