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
pub const THREAD_FIELD_NAMES: [&str; 20] = [
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
        "model": Value::Null,
        "providerOptions": [],
        "status": "idle",
        "usage": { "inputTokens": 0, "outputTokens": 0, "costUsd": 0.0 },
        "workspaceId": workspace_id,
        "pinned": false,
        "pendingApproval": Value::Null,
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
    persist();
    thread
}

pub fn load_thread(thread_id: &str, profile_id: Option<&str>, title: &str) -> Value {
    let mut items = threads().lock().unwrap();
    if let Some(thread) = items
        .iter_mut()
        .find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id))
    {
        if let Some(profile_id) = profile_id {
            thread["profileId"] = json!(profile_id);
            touch(thread);
        }
        let cloned = thread.clone();
        drop(items);
        persist();
        return cloned;
    }
    let provider = last_provider().lock().unwrap().clone();
    let thread = blank_thread(thread_id, profile_id, title, &provider, None);
    items.push(thread.clone());
    drop(items);
    persist();
    thread
}

pub fn rename_thread(thread_id: &str, profile_id: Option<&str>, title: &str) -> Value {
    let mut items = threads().lock().unwrap();
    if let Some(thread) = items
        .iter_mut()
        .find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id))
    {
        thread["title"] = json!(clip_title(title));
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
        if patch.get("model").is_some() {
            thread["model"] = normalize_model(patch.get("model"));
        }
        if let Some(options) = patch.get("providerOptions").and_then(|v| v.as_array()) {
            thread["providerOptions"] = Value::Array(sanitize_options(options));
        }
        if provider != current_provider {
            thread["providerSessionId"] = Value::Null;
        }
        thread["provider"] = json!(provider);
        thread["mode"] = json!(mode);
        *last_provider().lock().unwrap() =
            thread["provider"].as_str().unwrap_or("antigravity").to_string();
        touch(thread);
        let cloned = thread.clone();
        drop(items);
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
    persist();
}

pub(crate) fn touch(thread: &mut Value) {
    if let Some(object) = thread.as_object_mut() {
        object.insert("revision".into(), Value::String(next_revision()));
        object.insert("updatedAtUnixMs".into(), json!(now_ms()));
    }
}

pub(crate) fn archived_at_ms(thread: &Value) -> Option<i64> {
    thread.get("archivedAtUnixMs").and_then(|value| value.as_i64())
}

pub fn history(agent_id: Option<&str>) -> Value {
    let items = threads().lock().unwrap();
    let summaries: Vec<Value> = items
        .iter()
        .filter(|thread| match agent_id {
            Some(id) => thread.get("profileId").and_then(|v| v.as_str()) == Some(id),
            None => {
                thread.get("profileId").is_none()
                    || thread.get("profileId").and_then(|v| v.as_str()).is_none()
                    || thread["profileId"].is_null()
            }
        })
        .filter(|thread| archived_at_ms(thread).is_none())
        .filter_map(|thread| summary_of(thread))
        .collect();
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

pub fn summary_of(thread: &Value) -> Option<Value> {
    Some(json!({
        "id": thread.get("id")?,
        "profileId": thread.get("profileId").cloned().unwrap_or(Value::Null),
        "title": thread.get("title").cloned().unwrap_or(json!("Chat")),
        "provider": thread.get("provider").cloned().unwrap_or(json!("antigravity")),
        "status": thread.get("status").cloned().unwrap_or(json!("idle")),
        "hasContent": thread.get("items").and_then(|v| v.as_array()).map(|items| !items.is_empty()).unwrap_or(false),
        "workspaceId": thread.get("workspaceId").cloned().unwrap_or(Value::Null),
        "pinned": thread.get("pinned").cloned().unwrap_or(json!(false)),
        "createdAtUnixMs": thread.get("createdAtUnixMs").cloned().unwrap_or(json!(now_ms())),
        "updatedAtUnixMs": thread.get("updatedAtUnixMs").cloned().unwrap_or(json!(now_ms()))
    }))
}

pub fn remove_thread(thread_id: &str) -> Value {
    threads()
        .lock()
        .unwrap()
        .retain(|thread| thread.get("id").and_then(|v| v.as_str()) != Some(thread_id));
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

pub fn sanitize_chat_text(text: &str) -> String {
    text.chars()
        .filter(|ch| *ch == '\n' || *ch == '\r' || *ch == '\t' || (*ch as u32) >= 32)
        .take(200_000)
        .collect()
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
    if let Some(slot) = list
        .iter_mut()
        .find(|existing| existing.get("id").and_then(|v| v.as_str()) == Some(id.as_str()))
    {
        *slot = item.clone();
    } else {
        list.push(item.clone());
    }
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
    if !patch.is_empty() {
        configure_thread(thread_id, &Value::Object(patch));
    }
}
