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

use super::threads_cmd::request_thread_id;

pub fn list_chat_provider_models(request: Option<Value>) -> Value {
    let req = body(&request);
    let provider = req.and_then(|r| r.get("provider")).and_then(|v| v.as_str()).unwrap_or("");
    let force_refresh = req.and_then(|r| r.get("forceRefresh")).and_then(|v| v.as_bool()).unwrap_or(false);
    let connection_id = req
        .and_then(|r| r.get("connectionId").or_else(|| r.get("connection_id")))
        .and_then(|v| v.as_str());
    provider_models_for(provider, connection_id, force_refresh)
}

pub fn list_provider_agents(request: Option<Value>) -> Value {
    let req = body(&request);
    let provider = req.and_then(|r| r.get("provider")).and_then(|v| v.as_str()).unwrap_or("");
    json!({
        "provider": provider,
        "agents": crate::chat::models::provider_agents(provider),
    })
}

pub fn list_live_chat_runs(_request: Option<Value>) -> Vec<Value> {
    // Snapshot active runs under live_turns lock, then drop live_turns BEFORE acquiring threads
    let active_runs: Vec<(String, Option<String>, Option<String>, i64, u64)> = {
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
            list.push((
                run_id.clone(),
                thread_id,
                line,
                run.started_at_ms,
                run.next_sequence,
            ));
        }
        list
    };

    let items = threads().lock().unwrap();
    let mut active = Vec::new();
    for (run_id, thread_id, line, started_at_ms, next_sequence) in active_runs {
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
            "runId": run_id,
            "threadId": tid,
            "profileId": profile_id,
            "workspaceId": workspace_id,
            "provider": provider,
            "title": title,
            "needsYou": needs_you,
            "startedAtUnixMs": started_at_ms,
            "nextSequence": next_sequence,
            "line": line
        }));
    }
    active
}

pub fn get_chat_session_status(request: Option<Value>) -> Value {
    let req = body(&request);
    let thread_id = match req.and_then(|r| r.get("threadId")).and_then(|v| v.as_str()) {
        Some(id) if !id.trim().is_empty() => id.trim(),
        _ => return json!({ "error": "threadId is required" }),
    };

    let session_status = crate::chat::runtime::session_manager()
        .lock()
        .unwrap()
        .status(thread_id);

    if let Some(record) = session_status {
        json!({
            "threadId": thread_id,
            "state": record.state.as_str(),
            "mode": record.mode.as_str(),
            "isWarm": record.is_warm(),
            "isIdle": record.is_idle(),
            "hasResumeHandle": record.resume_handle.is_some(),
            "resumeHandle": record.resume_handle,
            "lastActiveAtMs": record.last_active_at_ms,
        })
    } else {
        let provider_session_id = {
            let list = threads().lock().unwrap();
            list.iter()
                .find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id))
                .and_then(|t| t.get("providerSessionId").and_then(|v| v.as_str()).map(|s| s.to_string()))
        };

        if let Some(handle) = provider_session_id {
            json!({
                "threadId": thread_id,
                "state": "reaped",
                "mode": "chat",
                "isWarm": false,
                "isIdle": false,
                "hasResumeHandle": true,
                "resumeHandle": handle,
                "lastActiveAtMs": 0,
            })
        } else {
            json!({
                "threadId": thread_id,
                "state": "closed",
                "mode": "chat",
                "isWarm": false,
                "isIdle": false,
                "hasResumeHandle": false,
                "resumeHandle": Value::Null,
                "lastActiveAtMs": 0,
            })
        }
    }
}

pub(super) fn handle_plan_action(thread_id: &str, plan_action: Option<&Value>) {
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

pub(super) fn read_send_text(request: Option<&Value>, key: &str) -> Option<String> {
    request
        .and_then(|req| req.get(key))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// A send names the connection and the endpoint it wants only when the UI has
/// them. Absent values keep the local CLI's own account and defaults.
pub(super) fn send_binding(request: Option<&Value>) -> SendBinding {
    SendBinding {
        connection_id: read_send_text(request, "connectionId"),
        supported_endpoint: read_send_text(request, "supportedEndpoint"),
    }
}

pub fn start_chat_turn(request: Option<Value>) -> Value {
    let req = body(&request);
    let thread_id = req.and_then(|r| r.get("threadId")).and_then(|v| v.as_str()).unwrap_or("11111111-1111-4111-8111-111111111111");
    let prompt = req.and_then(|r| r.get("prompt")).and_then(|v| v.as_str()).unwrap_or("");
    apply_launch_choices(thread_id, req);
    handle_plan_action(thread_id, req.and_then(|r| r.get("planAction")));
    let attachments = parse_attachments(req);
    crate::chat::consume_staged_attachments(&attachments);
    let binding = send_binding(req);
    start_turn_with_binding(thread_id, None, prompt, attachments, None, Some(&binding))
}

pub fn start_agent_chat_turn(request: Option<Value>) -> Value {
    let req = body(&request);
    let agent_id = req.and_then(|r| r.get("agentId")).and_then(|v| v.as_str()).unwrap_or("c3333333-3333-4333-8333-333333333333");
    let thread_id = req.and_then(|r| r.get("threadId")).and_then(|v| v.as_str()).unwrap_or("11111111-1111-4111-8111-111111111111");
    let prompt = req.and_then(|r| r.get("prompt")).and_then(|v| v.as_str()).unwrap_or("");
    apply_launch_choices(thread_id, req);
    handle_plan_action(thread_id, req.and_then(|r| r.get("planAction")));
    let attachments = parse_attachments(req);
    crate::chat::consume_staged_attachments(&attachments);
    let binding = send_binding(req);
    start_turn_with_binding(thread_id, Some(agent_id), prompt, attachments, None, Some(&binding))
}

pub fn read_chat_turn_updates(request: Option<Value>) -> Value {
    read_agent_chat_turn_updates(request)
}

pub fn read_agent_chat_turn_updates(request: Option<Value>) -> Value {
    let req = body(&request);
    let run_id = req.and_then(|r| r.get("runId")).and_then(|v| v.as_str()).unwrap_or("00000000-0000-4000-8000-000000000001");
    let after = req.and_then(|r| r.get("afterSequence")).and_then(|v| v.as_u64()).unwrap_or(0);
    let wait_ms = req.and_then(|r| r.get("waitMs")).and_then(|v| v.as_u64()).unwrap_or(0);
    read_turn_updates(run_id, after, wait_ms)
}

pub fn cancel_chat_turn(request: Option<Value>) -> Value {
    if let Some(req) = body(&request) {
        if let Some(thread_id) = req.get("threadId").and_then(|v| v.as_str()) {
            let preserve_children = req
                .get("preserveChildren")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            crate::chat::cancel_host_approvals_for_thread(thread_id);
            crate::chat::cancel_turn_with_options(thread_id, preserve_children);
        }
    }
    Value::Null
}

pub fn cancel_agent_chat_turn(request: Option<Value>) -> Value {
    if let Some(req) = body(&request) {
        if let Some(thread_id) = req.get("threadId").and_then(|v| v.as_str()) {
            let preserve_children = req
                .get("preserveChildren")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            crate::chat::cancel_host_approvals_for_thread(thread_id);
            crate::chat::cancel_turn_with_options(thread_id, preserve_children);
        }
    }
    Value::Null
}

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

    let parsed = crate::chat::approval::parse_decision(decision);
    if parsed == Some(crate::chat::ApprovalDecision::DenyAndStop) || decision == "denyAndStop" {
        crate::chat::cancel_host_approvals_for_thread(thread_id);
        cancel_turn(thread_id);
    }

    let mut items = threads().lock().unwrap();
    if let Some(thread) = items.iter_mut().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id)) {
        thread["pendingApproval"] = Value::Null;
        if parsed != Some(crate::chat::ApprovalDecision::DenyAndStop)
            && decision != "denyAndStop"
            && thread.get("status").and_then(|v| v.as_str()) == Some("waiting")
        {
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

pub fn respond_chat_user_input(request: Option<Value>) -> Value {
    let req = body(&request);
    let thread_id = req
        .and_then(|item| item.get("threadId"))
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let answers = req
        .and_then(|item| item.get("answers"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    if thread_id.is_empty() {
        return Value::Null;
    }
    let request_id = {
        let items = threads().lock().unwrap();
        items
            .iter()
            .find(|thread| thread.get("id").and_then(|value| value.as_str()) == Some(thread_id))
            .and_then(|thread| thread.get("pendingUserInput"))
            .and_then(|pending| pending.get("requestId").or_else(|| pending.get("request_id")))
            .and_then(|value| value.as_str())
            .unwrap_or("user-input")
            .to_string()
    };
    crate::chat::runtime::write_user_input_to_run(thread_id, &request_id, &answers);
    load_thread(thread_id, None, "Chat")
}

pub fn load_thread_grid(_request: Option<Value>) -> Value {
    load_grid()
}

pub fn save_thread_grid(request: Value) -> Value {
    let req = request.get("request").unwrap_or(&request);
    let grid = req.get("grid").cloned().unwrap_or(Value::Null);
    save_grid(grid);
    Value::Null
}

