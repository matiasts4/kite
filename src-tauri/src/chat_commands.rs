use crate::chat::{
    apply_launch_choices, archived_at_ms, cancel_turn, configure_thread, create_thread, history, live_turns,
    load_thread, parse_attachments, provider_models, read_turn_updates, release_staged_attachment,
    remove_thread, rename_thread, set_agent_model, set_agent_plan, set_pinned, stage_blob_attachment,
    stage_dropped_path, stage_dropped_paths, start_turn, touch,
};
use crate::persist::{body, load_grid, persist, save_grid, threads};
use serde_json::{json, Value};
use uuid::Uuid;

pub(crate) fn forget_thread(request: &Option<Value>) {
    if let Some(thread_id) = body(request).and_then(|req| req.get("threadId")).and_then(|v| v.as_str()) {
        remove_thread(thread_id);
    }
}

#[tauri::command]
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

#[tauri::command]
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

    let initial_provider = if let Some(ref agent) = agent_opt {
        match agent.engine.as_str() {
            "claude" | "claude-code" => "claude",
            "codex" => "codex",
            "cursor" => "cursor",
            "gemini" => "gemini",
            "grok" => "grok",
            "opencode" | "open-code" => "opencode",
            "antigravity" | "agy" => "antigravity",
            _ => "antigravity",
        }
    } else {
        "antigravity"
    };

    let mut thread = create_thread(Some(agent_id), "New Agent Chat", initial_provider, None);

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

    thread
}

#[tauri::command]
pub fn load_chat_thread(request: Option<Value>) -> Value {
    let thread_id = body(&request)
        .and_then(|r| r.get("threadId"))
        .and_then(|v| v.as_str())
        .unwrap_or("11111111-1111-4111-8111-111111111111");
    load_thread(thread_id, None, "Chat Thread")
}

#[tauri::command]
pub fn load_agent_chat_thread(request: Option<Value>) -> Value {
    let req = body(&request);
    let agent_id = req.and_then(|r| r.get("agentId")).and_then(|v| v.as_str()).unwrap_or("c3333333-3333-4333-8333-333333333333");
    let thread_id = req.and_then(|r| r.get("threadId")).and_then(|v| v.as_str()).unwrap_or("11111111-1111-4111-8111-111111111111");
    load_thread(thread_id, Some(agent_id), "Agent Chat Thread")
}

#[tauri::command]
pub fn rename_chat_thread(request: Option<Value>) -> Value {
    let req = body(&request);
    let thread_id = req.and_then(|r| r.get("threadId")).and_then(|v| v.as_str()).unwrap_or("11111111-1111-4111-8111-111111111111");
    let title = req.and_then(|r| r.get("title")).and_then(|v| v.as_str()).unwrap_or("Chat");
    rename_thread(thread_id, None, title)
}

#[tauri::command]
pub fn rename_agent_chat_thread(request: Option<Value>) -> Value {
    let req = body(&request);
    let thread_id = req.and_then(|r| r.get("threadId")).and_then(|v| v.as_str()).unwrap_or("11111111-1111-4111-8111-111111111111");
    let agent_id = req.and_then(|r| r.get("agentId")).and_then(|v| v.as_str()).unwrap_or("c3333333-3333-4333-8333-333333333333");
    let title = req.and_then(|r| r.get("title")).and_then(|v| v.as_str()).unwrap_or("Agent Chat");
    rename_thread(thread_id, Some(agent_id), title)
}

#[tauri::command]
pub fn set_chat_thread_pinned(request: Option<Value>) -> Value {
    let req = body(&request);
    let thread_id = req.and_then(|r| r.get("threadId")).and_then(|v| v.as_str()).unwrap_or("11111111-1111-4111-8111-111111111111");
    let pinned = req.and_then(|r| r.get("pinned")).and_then(|v| v.as_bool()).unwrap_or(false);
    set_pinned(thread_id, pinned)
}

#[tauri::command]
pub fn set_agent_chat_model(request: Option<Value>) -> Value {
    let req = body(&request);
    let thread_id = req.and_then(|r| r.get("threadId")).and_then(|v| v.as_str()).unwrap_or("11111111-1111-4111-8111-111111111111");
    let agent_id = req.and_then(|r| r.get("agentId")).and_then(|v| v.as_str()).unwrap_or("c3333333-3333-4333-8333-333333333333");
    let provider = req.and_then(|r| r.get("provider")).and_then(|v| v.as_str()).unwrap_or("antigravity");
    set_agent_model(agent_id, thread_id, provider, req.and_then(|r| r.get("model")))
}

#[tauri::command]
pub fn set_agent_chat_plan(request: Option<Value>) -> Value {
    let req = body(&request);
    let thread_id = req.and_then(|r| r.get("threadId")).and_then(|v| v.as_str()).unwrap_or("11111111-1111-4111-8111-111111111111");
    let agent_id = req.and_then(|r| r.get("agentId")).and_then(|v| v.as_str()).unwrap_or("c3333333-3333-4333-8333-333333333333");
    let plan = req.and_then(|r| r.get("plan")).and_then(|v| v.as_bool()).unwrap_or(false);
    set_agent_plan(agent_id, thread_id, plan)
}

#[tauri::command]
pub fn update_chat_configuration(request: Option<Value>) -> Value {
    let req = body(&request);
    let thread_id = req.and_then(|r| r.get("threadId")).and_then(|v| v.as_str()).unwrap_or("11111111-1111-4111-8111-111111111111");
    configure_thread(thread_id, req.unwrap_or(&Value::Null))
}

#[tauri::command]
pub fn list_chat_summaries(_request: Option<Value>) -> Value {
    history(None)
}

#[tauri::command]
pub fn list_agent_chat_summaries(request: Option<Value>) -> Value {
    let agent_id = body(&request).and_then(|req| req.get("agentId")).and_then(|v| v.as_str());
    history(agent_id)
}

const ARCHIVE_RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1000;

fn request_thread_id(request: &Option<Value>) -> Option<String> {
    body(request)
        .and_then(|req| req.get("threadId"))
        .and_then(|value| value.as_str())
        .map(|id| id.to_string())
}

fn archive_thread(thread_id: &str) {
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

fn clear_archived(thread_id: &str) {
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

fn purge_archived_thread(thread_id: &str) {
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

fn archived_owner(thread: &Value, owner: Option<&str>) -> bool {
    let profile_id = thread.get("profileId").and_then(|value| value.as_str());
    match owner {
        Some(id) => profile_id == Some(id),
        None => profile_id.is_none(),
    }
}

fn archived_summary(thread: &Value) -> Option<Value> {
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
        "expiresAtUnixMs": expires_at
    }))
}

#[tauri::command]
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

#[tauri::command]
pub fn restore_archived_chat(request: Option<Value>) -> Value {
    if let Some(thread_id) = request_thread_id(&request) {
        clear_archived(&thread_id);
    }
    Value::Null
}

#[tauri::command]
pub fn archive_chat_thread(request: Option<Value>) -> Value {
    if let Some(thread_id) = request_thread_id(&request) {
        archive_thread(&thread_id);
    }
    json!({
        "deleted": true,
        "history": history(None)
    })
}

#[tauri::command]
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

#[tauri::command]
pub fn delete_chat_thread(request: Option<Value>) -> Value {
    forget_thread(&request);
    json!({
        "deleted": true,
        "history": history(None)
    })
}

#[tauri::command]
pub fn delete_agent_chat_thread(request: Option<Value>) -> Value {
    forget_thread(&request);
    let agent_id = body(&request).and_then(|req| req.get("agentId")).and_then(|v| v.as_str());
    json!({
        "deleted": true,
        "history": history(agent_id)
    })
}

#[tauri::command]
pub fn purge_archived_chat(request: Option<Value>) -> Value {
    if let Some(thread_id) = request_thread_id(&request) {
        purge_archived_thread(&thread_id);
    }
    Value::Null
}

#[tauri::command]
pub fn list_chat_provider_models(request: Option<Value>) -> Value {
    let req = body(&request);
    let provider = req.and_then(|r| r.get("provider")).and_then(|v| v.as_str()).unwrap_or("");
    let force_refresh = req.and_then(|r| r.get("forceRefresh")).and_then(|v| v.as_bool()).unwrap_or(false);
    provider_models(provider, force_refresh)
}

#[tauri::command]
pub fn list_live_chat_runs(_request: Option<Value>) -> Vec<Value> {
    // Snapshot active runs under live_turns lock, then drop live_turns BEFORE acquiring threads
    let active_runs: Vec<(String, Option<String>, Option<String>, i64)> = {
        let live = live_turns().lock().unwrap();
        let mut list = Vec::new();
        for (run_id, run) in &live.runs {
            if run.finished {
                continue;
            }
            let thread_id = live
                .by_thread
                .iter()
                .find(|(_, id)| id.as_str() == run_id.as_str())
                .map(|(t, _)| t.clone());
            let line = run
                .assistant_text
                .lines()
                .last()
                .map(|s| s.chars().take(240).collect::<String>());
            list.push((run_id.clone(), thread_id, line, run.started_at_ms));
        }
        list
    };

    let items = threads().lock().unwrap();
    let mut active = Vec::new();
    for (_run_id, thread_id, line, started_at_ms) in active_runs {
        let thread = thread_id
            .as_deref()
            .and_then(|tid| items.iter().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(tid)));

        let tid = thread_id.unwrap_or_else(|| Uuid::new_v4().to_string());
        let profile_id = thread
            .and_then(|t| t.get("profileId").and_then(|v| v.as_str()))
            .map(|s| s.to_string());
        let workspace_id = thread
            .and_then(|t| t.get("workspaceId").and_then(|v| v.as_str()))
            .map(|s| s.to_string());
        let provider = thread
            .and_then(|t| t.get("provider").and_then(|v| v.as_str()))
            .unwrap_or("antigravity")
            .to_string();
        let title = thread
            .and_then(|t| t.get("title").and_then(|v| v.as_str()))
            .unwrap_or("Chat")
            .to_string();
        let needs_you = thread
            .map(|t| t.get("pendingApproval").is_some() && !t["pendingApproval"].is_null())
            .unwrap_or(false);

        active.push(json!({
            "threadId": tid,
            "profileId": profile_id,
            "workspaceId": workspace_id,
            "provider": provider,
            "title": title,
            "needsYou": needs_you,
            "startedAtUnixMs": started_at_ms,
            "line": line
        }));
    }
    active
}

fn handle_plan_action(thread_id: &str, plan_action: Option<&Value>) {
    let Some(action) = plan_action else { return };
    let kind = action.get("kind").and_then(|v| v.as_str()).unwrap_or("");
    let mut items = threads().lock().unwrap();
    if let Some(thread) = items.iter_mut().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id)) {
        match kind {
            "new" => {
                thread["plan"] = json!(true);
            }
            "revise" => {
                thread["plan"] = json!(true);
                if let Some(plan_id) = action.get("planId").and_then(|v| v.as_str()) {
                    if let Some(plans) = thread.get_mut("plans").and_then(|v| v.as_array_mut()) {
                        if let Some(slot) = plans.iter_mut().find(|p| p.get("id").and_then(|v| v.as_str()) == Some(plan_id)) {
                            slot["status"] = json!("revising");
                        }
                    }
                }
            }
            "implement" => {
                thread["plan"] = json!(false);
                if let Some(plan_id) = action.get("planId").and_then(|v| v.as_str()) {
                    if let Some(plans) = thread.get_mut("plans").and_then(|v| v.as_array_mut()) {
                        if let Some(slot) = plans.iter_mut().find(|p| p.get("id").and_then(|v| v.as_str()) == Some(plan_id)) {
                            slot["status"] = json!("implementing");
                        }
                    }
                }
            }
            _ => {}
        }
        touch(thread);
    }
}

#[tauri::command]
pub fn start_chat_turn(request: Option<Value>) -> Value {
    let req = body(&request);
    let thread_id = req.and_then(|r| r.get("threadId")).and_then(|v| v.as_str()).unwrap_or("11111111-1111-4111-8111-111111111111");
    let prompt = req.and_then(|r| r.get("prompt")).and_then(|v| v.as_str()).unwrap_or("");
    apply_launch_choices(thread_id, req);
    handle_plan_action(thread_id, req.and_then(|r| r.get("planAction")));
    let attachments = parse_attachments(req);
    start_turn(thread_id, None, prompt, attachments, None)
}

#[tauri::command]
pub fn start_agent_chat_turn(request: Option<Value>) -> Value {
    let req = body(&request);
    let agent_id = req.and_then(|r| r.get("agentId")).and_then(|v| v.as_str()).unwrap_or("c3333333-3333-4333-8333-333333333333");
    let thread_id = req.and_then(|r| r.get("threadId")).and_then(|v| v.as_str()).unwrap_or("11111111-1111-4111-8111-111111111111");
    let prompt = req.and_then(|r| r.get("prompt")).and_then(|v| v.as_str()).unwrap_or("");
    apply_launch_choices(thread_id, req);
    handle_plan_action(thread_id, req.and_then(|r| r.get("planAction")));
    let attachments = parse_attachments(req);
    start_turn(thread_id, Some(agent_id), prompt, attachments, None)
}

#[tauri::command]
pub fn read_chat_turn_updates(request: Option<Value>) -> Value {
    read_agent_chat_turn_updates(request)
}

#[tauri::command]
pub fn read_agent_chat_turn_updates(request: Option<Value>) -> Value {
    let req = body(&request);
    let run_id = req.and_then(|r| r.get("runId")).and_then(|v| v.as_str()).unwrap_or("00000000-0000-4000-8000-000000000001");
    let after = req.and_then(|r| r.get("afterSequence")).and_then(|v| v.as_u64()).unwrap_or(0);
    let wait_ms = req.and_then(|r| r.get("waitMs")).and_then(|v| v.as_u64()).unwrap_or(0);
    read_turn_updates(run_id, after, wait_ms)
}

#[tauri::command]
pub fn cancel_chat_turn(request: Option<Value>) -> Value {
    if let Some(thread_id) = body(&request).and_then(|req| req.get("threadId")).and_then(|v| v.as_str()) {
        cancel_turn(thread_id);
    }
    Value::Null
}

#[tauri::command]
pub fn cancel_agent_chat_turn(request: Option<Value>) -> Value {
    if let Some(thread_id) = body(&request).and_then(|req| req.get("threadId")).and_then(|v| v.as_str()) {
        cancel_turn(thread_id);
    }
    Value::Null
}

#[tauri::command]
pub fn respond_chat_approval(request: Option<Value>) -> Value {
    let req = body(&request);
    let thread_id = req
        .and_then(|r| r.get("threadId"))
        .and_then(|v| v.as_str())
        .unwrap_or("11111111-1111-4111-8111-111111111111");
    let decision = req
        .and_then(|r| r.get("decision"))
        .and_then(|v| v.as_str())
        .unwrap_or("allowOnce");
    let request_id = req
        .and_then(|r| r.get("requestId"))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    crate::chat::write_approval_to_run(thread_id, request_id, decision);

    if decision == "denyAndStop" {
        cancel_turn(thread_id);
    }

    let mut items = threads().lock().unwrap();
    if let Some(thread) = items.iter_mut().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id)) {
        thread["pendingApproval"] = Value::Null;
        if decision != "denyAndStop" && thread.get("status").and_then(|v| v.as_str()) == Some("waiting") {
            thread["status"] = json!("running");
        }
        if decision == "allowForSession" || decision == "accept_for_session" {
            thread["mode"] = json!("fullAccess");
        }
        touch(thread);
        let updated = thread.clone();
        drop(items);
        persist();
        return updated;
    }
    drop(items);
    load_thread(thread_id, None, "Chat")
}

#[tauri::command]
pub fn load_thread_grid(_request: Option<Value>) -> Value {
    load_grid()
}

#[tauri::command]
pub fn save_thread_grid(request: Value) -> Value {
    let req = request.get("request").unwrap_or(&request);
    let grid = req.get("grid").cloned().unwrap_or(Value::Null);
    save_grid(grid);
    Value::Null
}

#[tauri::command]
pub async fn pick_chat_attachments(app: tauri::AppHandle, request: Option<Value>) -> Value {
    let req = body(&request);
    let thread_id = req
        .and_then(|item| item.get("threadId"))
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string();
    let kind = req
        .and_then(|item| item.get("kind"))
        .and_then(|value| value.as_str())
        .unwrap_or("files")
        .to_string();
    if thread_id.is_empty() {
        return json!([]);
    }
    let picked = tokio::task::spawn_blocking(move || pick_attachment_paths(app, &kind))
        .await
        .ok()
        .flatten();
    let Some(paths) = picked else {
        return json!([]);
    };
    let staged = paths
        .iter()
        .take(16)
        .filter_map(|path| stage_dropped_path(&thread_id, path))
        .collect::<Vec<_>>();
    Value::Array(staged)
}

fn pick_attachment_paths(app: tauri::AppHandle, kind: &str) -> Option<Vec<std::path::PathBuf>> {
    use tauri_plugin_dialog::DialogExt;
    if kind == "folder" {
        let folder = app.dialog().file().set_title("Add folder").blocking_pick_folder()?;
        Some(vec![folder.into_path().ok()?])
    } else {
        let files = app.dialog().file().set_title("Add files").blocking_pick_files()?;
        let paths = files
            .into_iter()
            .filter_map(|file| file.into_path().ok())
            .take(16)
            .collect::<Vec<_>>();
        if paths.is_empty() {
            None
        } else {
            Some(paths)
        }
    }
}

#[tauri::command]
pub fn stage_chat_blob(request: Option<Value>) -> Value {
    let req = body(&request);
    let thread_id = req.and_then(|item| item.get("threadId")).and_then(|value| value.as_str()).unwrap_or("");
    let display_name = req
        .and_then(|item| item.get("displayName"))
        .and_then(|value| value.as_str())
        .unwrap_or("attachment");
    let data_base64 = req
        .and_then(|item| item.get("dataBase64"))
        .and_then(|value| value.as_str())
        .unwrap_or("");
    stage_blob_attachment(thread_id, display_name, data_base64).unwrap_or(Value::Null)
}

#[tauri::command]
pub fn stage_dropped_chat_attachments(request: Option<Value>) -> Value {
    let req = body(&request);
    let thread_id = req.and_then(|item| item.get("threadId")).and_then(|value| value.as_str()).unwrap_or("");
    let mut paths = Vec::new();
    if let Some(items) = req.and_then(|item| item.get("paths")).and_then(|value| value.as_array()) {
        for item in items.iter().take(16) {
            if let Some(path) = item.as_str() {
                if !path.is_empty() && path.len() <= 4096 {
                    paths.push(std::path::PathBuf::from(path));
                }
            }
        }
    }
    Value::Array(stage_dropped_paths(thread_id, &paths))
}

#[tauri::command]
pub fn release_chat_attachment(request: Option<Value>) -> Value {
    let req = body(&request);
    let thread_id = req.and_then(|item| item.get("threadId")).and_then(|value| value.as_str()).unwrap_or("");
    let resource_id = req
        .and_then(|item| item.get("resourceId"))
        .and_then(|value| value.as_str())
        .unwrap_or("");
    release_staged_attachment(thread_id, resource_id);
    Value::Null
}

#[tauri::command]
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
    use crate::chat::TurnRun;

    #[test]
    fn test_live_chat_runs_and_approval() {
        let thread_id = "test-thread-uuid-1111-2222-333344445555";
        let run_id = "test-run-uuid-1111-2222-333344445555";
        let run = TurnRun {
            revision: "rev1".into(),
            events: Vec::new(),
            next_sequence: 1,
            assistant_id: "ast1".into(),
            assistant_text: "Thinking about the task...".into(),
            child: None,
            stdin: None,
            closing: false,
            finished: false,
            started_at_ms: 1234567890,
            routine_id: None,
        };
        {
            let mut live = live_turns().lock().unwrap();
            live.runs.insert(run_id.into(), run);
            live.by_thread.insert(thread_id.into(), run_id.into());
        }

        let runs = list_live_chat_runs(None);
        assert!(!runs.is_empty());
        let found = runs.iter().find(|r| r["threadId"] == thread_id).expect("run found");
        assert_eq!(found["line"], "Thinking about the task...");
        assert_eq!(found["startedAtUnixMs"], 1234567890);
        assert_eq!(found["needsYou"], false);

        // Test responding to approval
        let resp = respond_chat_approval(Some(json!({
            "request": {
                "threadId": thread_id,
                "runId": run_id,
                "requestId": "req1",
                "decision": "approve"
            }
        })));
        assert_eq!(resp["pendingApproval"], Value::Null);

        // Clean up
        {
            let mut live = live_turns().lock().unwrap();
            live.runs.remove(run_id);
            live.by_thread.remove(thread_id);
        }
        crate::chat::remove_thread(thread_id);
    }

    struct RemoveThread(String);

    impl Drop for RemoveThread {
        fn drop(&mut self) {
            remove_thread(&self.0);
        }
    }

    #[test]
    fn archived_chat_is_hidden_then_restored_and_purged() {
        let created = create_thread(None, "Archive Probe", "claude", None);
        let thread_id = created.get("id").and_then(|value| value.as_str()).unwrap().to_string();
        let _cleanup = RemoveThread(thread_id.clone());

        let archived = archive_chat_thread(Some(json!({ "threadId": thread_id })));
        assert_eq!(archived["deleted"], json!(true));
        let live = archived["history"]["summaries"].as_array().unwrap();
        assert!(live.iter().all(|row| row["id"] != thread_id));
        assert!(history(None)["summaries"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["id"] != thread_id));

        let listed = list_archived_chats(Some(json!({ "profileId": Value::Null })));
        let row = listed.iter().find(|row| row["id"] == thread_id).expect("archived summary");
        assert_eq!(row["schemaVersion"], 1);
        assert_eq!(row["title"], "Archive Probe");
        assert_eq!(row["profileId"], Value::Null);
        let archived_at = row["archivedAtUnixMs"].as_i64().expect("archivedAtUnixMs");
        assert_eq!(row["expiresAtUnixMs"].as_i64().unwrap() - archived_at, ARCHIVE_RETENTION_MS);
        assert_eq!(row["revision"].as_str().map(|text| text.len()), Some(64));
        let stored = threads().lock().unwrap().iter().any(|thread| {
            thread.get("id").and_then(|value| value.as_str()) == Some(thread_id.as_str())
                && archived_at_ms(thread) == Some(archived_at)
        });
        assert!(stored, "archived thread stays stored");

        let restored = restore_archived_chat(Some(json!({ "threadId": thread_id })));
        assert!(restored.is_null());
        assert!(history(None)["summaries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["id"] == thread_id));
        assert!(list_archived_chats(Some(json!({ "profileId": Value::Null })))
            .iter()
            .all(|row| row["id"] != thread_id));

        archive_chat_thread(Some(json!({ "threadId": thread_id })));
        let purged = purge_archived_chat(Some(json!({ "threadId": thread_id })));
        assert!(purged.is_null());
        assert!(list_archived_chats(Some(json!({ "profileId": Value::Null })))
            .iter()
            .all(|row| row["id"] != thread_id));
        let gone = threads()
            .lock()
            .unwrap()
            .iter()
            .all(|thread| thread.get("id").and_then(|value| value.as_str()) != Some(thread_id.as_str()));
        assert!(gone);
    }
}

