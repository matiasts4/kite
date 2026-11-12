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
    let default_model_val = crate::persist::last_model()
        .lock()
        .unwrap()
        .as_deref()
        .filter(|m| !m.trim().is_empty())
        .map(|m| json!(m))
        .unwrap_or(Value::Null);
    let default_effort_val = crate::persist::last_effort()
        .lock()
        .unwrap()
        .clone();
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
    persist();
    thread
}

pub fn load_thread(thread_id: &str, profile_id: Option<&str>, title: &str) -> Value {
    let mut items = threads().lock().unwrap();
    let mut thread = if let Some(thread) = items
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
        cloned
    } else {
        let provider = last_provider().lock().unwrap().clone();
        let thread = blank_thread(thread_id, profile_id, title, &provider, None);
        items.push(thread.clone());
        drop(items);
        persist();
        thread
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

    thread
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
        if patch.get("model").is_some() {
            let normalized = normalize_model(patch.get("model"));
            if let Some(m) = normalized.as_str() {
                if !m.trim().is_empty() {
                    *crate::persist::last_model().lock().unwrap() = Some(m.trim().to_string());
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
                    *crate::persist::last_effort().lock().unwrap() = Some(value.trim().to_string());
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
                    let text = row.get("text").and_then(|value| value.as_str())?.trim();
                    if text.is_empty() {
                        return None;
                    }
                    let id = row
                        .get("id")
                        .and_then(|value| value.as_str())
                        .filter(|id| !id.is_empty())
                        .unwrap_or("queued");
                    Some(json!({ "id": id, "text": text }))
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
            None => true,
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

    let is_settled = !is_warm && status_str != "running";

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
        let move_assistant_to_tail = item.get("kind").and_then(|v| v.as_str()) == Some("assistant")
            && new_text_len > prev_text_len
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
            remove_thread(&self.0);
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

        let refused = crate::chat_commands::restore_thread_checkpoint(Some(json!({
            "threadId": thread_id,
            "folder": "C:/this/path/must/not/be/used"
        })));
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
        let shared = crate::chat_commands::restore_thread_checkpoint(Some(json!({
            "threadId": thread_id,
            "worktree": "/tmp/not-a-worktree"
        })));
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
        let missing = crate::chat_commands::restore_thread_checkpoint(Some(json!({
            "threadId": unknown
        })));
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
}
