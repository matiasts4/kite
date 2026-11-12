use crate::chat::normalize::{
    automatic_approval_decision, effective_permission_mode, should_auto_approve,
    DeltaCoalescer, ProviderTurnEvent, ToolCallSnapshot, ToolCallTracker,
};
use crate::chat::threads::{chat_item, touch, upsert_item};
use crate::chat::utils::chat_log;
use crate::persist::{notifications, persist, threads};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use super::settle::finish_run;
use super::state::{emit_notice_item, live_cv, live_turns, session_manager};
use super::stream_json::{
    emit_deltas, read_pipe, read_stderr_ring, record_turn_failure, take_run_stderr,
};
use super::turn::{push_event, write_session_frame};

pub fn write_user_input_to_run(thread_id: &str, request_id: &str, answers: &Value) {
    let line = format!(
        "{}\n",
        json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "result": { "answers": answers }
        })
    );
    write_approval_to_run(thread_id, request_id, "allowOnce");
    let _ = write_session_frame(thread_id, &line);
    set_thread_field(thread_id, "pendingUserInput", Value::Null);
}

pub fn write_approval_to_run(thread_id: &str, request_id: &str, decision: &str) {
    {
        let mut live = live_turns().lock().unwrap();
        let run_id = live.by_thread.get(thread_id).cloned();
        if let Some(ref rid) = run_id {
            if let Some(run) = live.runs.get_mut(rid) {
                push_event(
                    run,
                    json!({
                        "kind": "approvalResolved",
                        "requestId": request_id,
                        "decision": decision
                    }),
                );
                if decision != "denyAndStop" {
                    push_event(run, json!({ "kind": "status", "status": "running" }));
                }
            }
        }
    }
    live_cv().notify_all();

    {
        let mut items = threads().lock().unwrap();
        if let Some(thread) = items.iter_mut().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id)) {
            thread["pendingApproval"] = Value::Null;
            if decision != "denyAndStop" {
                thread["status"] = json!("running");
            }
            touch(thread);
        }
    }
    {
        let mut notifs = notifications().lock().unwrap();
        if let Some(item) = notifs.iter_mut().find(|n| n.get("id").and_then(|v| v.as_str()) == Some(request_id)) {
            item["isWaitingForInput"] = json!(false);
            item["resolution"] = json!("attended");
            item["isRead"] = json!(true);
        }
    }
    persist();

    let line = crate::acp::format_acp_approval_response(request_id, decision);
    let _ = write_session_frame(thread_id, &line);
}

pub fn stream_child(thread_id: String, run_id: String, assistant_id: String, mut child: crate::hidden_exec::HiddenChild) {
    let pid = child.id();
    chat_log(&format!("stream_child: started for run_id={}, pid={}", run_id, pid));
    // Drop the stdin write pipe immediately so child processes (like `opencode run` and `codex exec`,
    // which check if stdin is a pipe and wait for EOF) receive EOF and do not hang.
    drop(child.stdin.take());
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let shared = Arc::new(Mutex::new(child));
    {
        let mut live = live_turns().lock().unwrap();
        if let Some(run) = live.runs.get_mut(&run_id) {
            run.child = Some(Arc::clone(&shared));
            run.stdin = None;
        }
    }
    let out_run = run_id.clone();
    let out_id = assistant_id.clone();
    let err_run = run_id.clone();
    let out_thread = thread_id.clone();
    let stdout_thread = std::thread::spawn(move || {
        if let Some(stdout) = stdout {
            read_pipe(stdout, &out_thread, &out_run, &out_id);
        }
    });
    let stderr_thread = std::thread::spawn(move || {
        if let Some(stderr) = stderr {
            read_stderr_ring(stderr, &err_run);
        }
    });
    let _ = stdout_thread.join();
    let _ = stderr_thread.join();
    {
        let mut live = live_turns().lock().unwrap();
        if let Some(run) = live.runs.get_mut(&run_id) {
            run.stdin = None;
        }
    }
    let status = shared.lock().ok().and_then(|mut child| child.wait().ok());
    let exit_code = status.map(|code| code as i32);
    let ok = exit_code.unwrap_or(1) == 0;
    chat_log(&format!("stream_child: process exited for run_id={}, pid={}, ok={}", run_id, pid, ok));
    let stderr_text = take_run_stderr(&run_id);
    let provider = threads()
        .lock()
        .unwrap()
        .iter()
        .find(|thread| thread.get("id").and_then(|value| value.as_str()) == Some(thread_id.as_str()))
        .and_then(|thread| thread.get("provider").and_then(|value| value.as_str()))
        .unwrap_or("")
        .to_string();
    let projected = crate::chat::normalize::project_process_failure(
        if ok { Some(0) } else { exit_code },
        &stderr_text,
        &provider,
        &[],
    );
    if let Some(failure) = projected.failure {
        record_turn_failure(&thread_id, &failure);
        finish_run(&run_id, false, false, "");
    } else {
        let message = if ok {
            String::new()
        } else {
            "The provider command exited with an error.".into()
        };
        finish_run(&run_id, ok, false, &message);
    }
}

pub fn pipeline_runs() -> &'static Mutex<HashMap<String, (ToolCallTracker, DeltaCoalescer)>> {
    static RUNS: std::sync::OnceLock<Mutex<HashMap<String, (ToolCallTracker, DeltaCoalescer)>>> =
        std::sync::OnceLock::new();
    RUNS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn apply_known_turn_pipeline(thread_id: &str, run_id: &str, assistant_id: &str, frame: &Value) -> bool {
    let now = Instant::now();
    let (events, message, reasoning, holding) = {
        let mut runs = pipeline_runs().lock().unwrap();
        let (tools, deltas) = runs
            .entry(run_id.to_string())
            .or_insert_with(|| (ToolCallTracker::default(), DeltaCoalescer::default()));
        let events = tools.ingest(frame);
        if events.is_empty()
            || (events.len() == 1
                && matches!(
                    events.first(),
                    Some(ProviderTurnEvent::Notice { code, .. }) if code == "unknownFrame"
                ))
        {
            return false;
        }
        let mut message = None;
        let mut reasoning = None;
        for event in &events {
            match event {
                ProviderTurnEvent::MessageDelta { text } => {
                    if let Some(flushed) = deltas.push_message(text, false, now) {
                        message = Some(flushed);
                    }
                }
                ProviderTurnEvent::ReasoningDelta { text } => {
                    if let Some(flushed) = deltas.push_reasoning(text, false, now) {
                        reasoning = Some(flushed);
                    }
                }
                _ => {}
            }
        }
        let (due_message, due_reasoning) = deltas.poll_split(now);
        if message.is_none() {
            message = due_message;
        }
        if reasoning.is_none() {
            reasoning = due_reasoning;
        }
        let holding = deltas.pending();
        (events, message, reasoning, holding)
    };
    if let Some(text) = message {
        emit_deltas(thread_id, run_id, assistant_id, &text);
    }
    if let Some(text) = reasoning {
        append_reasoning_delta(thread_id, run_id, &text);
    }
    for event in events {
        match event {
            ProviderTurnEvent::MessageDelta { .. } | ProviderTurnEvent::ReasoningDelta { .. } => {}
            ProviderTurnEvent::ToolCallUpdated { tool } => upsert_tool_snapshot(thread_id, run_id, &tool),
            ProviderTurnEvent::ApprovalRequested {
                request_id,
                tool_name,
                title,
            } => project_approval(thread_id, run_id, &request_id, &tool_name, &title),
            ProviderTurnEvent::UserInputRequested { request } => {
                let value = serde_json::to_value(&request).unwrap_or(Value::Null);
                set_thread_field(thread_id, "pendingUserInput", value);
                set_thread_field(thread_id, "status", json!("waiting"));
            }
            ProviderTurnEvent::PlanUpdated { title, status, body } => {
                project_plan(thread_id, run_id, &title, &status, &body);
                if matches!(
                    frame.get("method").and_then(Value::as_str),
                    Some("x.ai/exit_plan_mode") | Some("_x.ai/exit_plan_mode")
                ) {
                    if let Some(id) = frame
                        .get("id")
                        .and_then(|value| value.as_i64().map(|number| number.to_string()).or_else(|| value.as_str().map(str::to_string)))
                    {
                        let _ = write_session_frame(
                            thread_id,
                            &crate::chat::persistent::plan_request_ack(&id),
                        );
                    }
                }
            }
            ProviderTurnEvent::UsageUpdated { usage } => {
                if let Ok(value) = serde_json::to_value(&usage) {
                    set_thread_field(thread_id, "usage", value);
                }
            }
            ProviderTurnEvent::TurnTerminal { failure } => {
                if let Some(failure) = failure {
                    record_turn_failure(thread_id, &failure);
                }
            }
            ProviderTurnEvent::SessionStarted { provider_session_id } => {
                if let Some(id) = provider_session_id {
                    if !id.is_empty() {
                        set_thread_field(thread_id, "providerSessionId", json!(id));
                    }
                }
            }
            ProviderTurnEvent::Notice { message, .. } => emit_notice_item(thread_id, run_id, &message),
        }
    }
    if holding {
        let thread = thread_id.to_string();
        let run = run_id.to_string();
        let assistant = assistant_id.to_string();
        std::thread::spawn(move || {
            std::thread::sleep(crate::chat::normalize::DELTA_WINDOW);
            flush_pipeline_deltas(&thread, &run, &assistant);
        });
    }
    true
}

pub fn flush_pipeline_deltas(thread_id: &str, run_id: &str, assistant_id: &str) {
    let (message, reasoning) = {
        let mut runs = pipeline_runs().lock().unwrap();
        let Some((_, deltas)) = runs.get_mut(run_id) else {
            return;
        };
        deltas.flush_split()
    };
    if let Some(text) = message {
        emit_deltas(thread_id, run_id, assistant_id, &text);
    }
    if let Some(text) = reasoning {
        append_reasoning_delta(thread_id, run_id, &text);
    }
}

pub fn set_thread_field(thread_id: &str, field: &str, value: Value) {
    let mut items = threads().lock().unwrap();
    if let Some(thread) = items
        .iter_mut()
        .find(|thread| thread.get("id").and_then(|v| v.as_str()) == Some(thread_id))
    {
        thread[field] = value;
        touch(thread);
    }
    drop(items);
    persist();
}

pub fn append_reasoning_delta(thread_id: &str, run_id: &str, text: &str) {
    if text.is_empty() {
        return;
    }
    let thought_id = format!("r_{run_id}_live");
    let combined = {
        let items = threads().lock().unwrap();
        items
            .iter()
            .find(|thread| thread.get("id").and_then(|v| v.as_str()) == Some(thread_id))
            .and_then(|thread| thread.get("items"))
            .and_then(|v| v.as_array())
            .and_then(|list| list.iter().find(|it| it.get("id").and_then(|v| v.as_str()) == Some(thought_id.as_str())))
            .and_then(|it| it.get("text"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    } + text;
    let item = chat_item(&thought_id, "reasoning", &combined, true);
    {
        let mut live = live_turns().lock().unwrap();
        if let Some(run) = live.runs.get_mut(run_id) {
            push_event(run, json!({ "kind": "upsert", "item": item.clone() }));
        }
    }
    live_cv().notify_all();
    let mut items = threads().lock().unwrap();
    if let Some(thread) = items
        .iter_mut()
        .find(|thread| thread.get("id").and_then(|v| v.as_str()) == Some(thread_id))
    {
        upsert_item(thread, &item);
    }
}

pub fn upsert_tool_snapshot(thread_id: &str, run_id: &str, snap: &ToolCallSnapshot) {
    let streaming = matches!(
        snap.status.as_str(),
        "inProgress" | "running" | "pending" | "in_progress"
    );
    let mut item = chat_item(&snap.id, "tool", &snap.output, streaming);
    let title = if snap.title.is_empty() {
        snap.kind.clone()
    } else {
        snap.title.clone()
    };
    item["title"] = json!(title);
    item["status"] = json!(snap.status);
    item["toolKind"] = json!(snap.kind);
    if let Some(path) = &snap.path {
        item["filePath"] = json!(path);
    }
    if let Some(command) = &snap.command {
        item["command"] = json!(command);
    }
    if let Some(query) = &snap.query {
        item["query"] = json!(query);
    }
    if let Some(additions) = snap.additions {
        item["addedLines"] = json!(additions);
    }
    if let Some(deletions) = snap.deletions {
        item["removedLines"] = json!(deletions);
    }
    {
        let items = threads().lock().unwrap();
        if let Some(existing) = items
            .iter()
            .find(|thread| thread.get("id").and_then(|v| v.as_str()) == Some(thread_id))
            .and_then(|thread| thread.get("items"))
            .and_then(|v| v.as_array())
            .and_then(|list| list.iter().find(|it| it.get("id").and_then(|v| v.as_str()) == Some(snap.id.as_str())))
        {
            if snap.output.is_empty() {
                if let Some(text) = existing.get("text") {
                    item["text"] = text.clone();
                }
            }
            for key in [
                "createdAtUnixMs",
                "serverName",
                "toolName",
                "detail",
                "query",
                "filePath",
                "command",
            ] {
                if item.get(key).is_none() {
                    if let Some(value) = existing.get(key) {
                        item[key] = value.clone();
                    }
                }
            }
        }
    }
    {
        let mut live = live_turns().lock().unwrap();
        if let Some(run) = live.runs.get_mut(run_id) {
            push_event(run, json!({ "kind": "upsert", "item": item.clone() }));
        }
    }
    live_cv().notify_all();
    {
        let mut items = threads().lock().unwrap();
        if let Some(thread) = items
            .iter_mut()
            .find(|thread| thread.get("id").and_then(|v| v.as_str()) == Some(thread_id))
        {
            upsert_item(thread, &item);
            touch(thread);
        }
    }
    if !streaming {
        persist();
    }
}

pub fn project_approval(thread_id: &str, run_id: &str, request_id: &str, tool_name: &str, title: &str) {
    let (provider, mode) = {
        let items = threads().lock().unwrap();
        let thread = items
            .iter()
            .find(|thread| thread.get("id").and_then(|v| v.as_str()) == Some(thread_id));
        (
            thread
                .and_then(|thread| thread.get("provider"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            thread
                .and_then(|thread| thread.get("mode"))
                .and_then(|v| v.as_str())
                .unwrap_or("supervised")
                .to_string(),
        )
    };
    let effective = effective_permission_mode(&provider, &mode);
    if should_auto_approve(effective.effective.as_str(), tool_name) {
        let decision = automatic_approval_decision().as_str();
        let _ = session_manager()
            .lock()
            .unwrap()
            .respond_approval(thread_id, request_id, automatic_approval_decision());
        write_approval_to_run(thread_id, request_id, decision);
        return;
    }
    let approval_val = json!({
        "id": request_id,
        "toolName": tool_name,
        "title": title,
        "detail": title,
        "status": "pending"
    });
    {
        let mut live = live_turns().lock().unwrap();
        if let Some(run) = live.runs.get_mut(run_id) {
            push_event(run, json!({ "kind": "approvalOpened", "approval": approval_val.clone() }));
            push_event(run, json!({ "kind": "status", "status": "waiting" }));
        }
    }
    live_cv().notify_all();
    set_thread_field(thread_id, "pendingApproval", approval_val);
    set_thread_field(thread_id, "status", json!("waiting"));
}

pub fn project_plan(thread_id: &str, run_id: &str, title: &str, status: &str, body: &str) {
    let plan_item_id = format!("plan_{run_id}");
    let streaming = status == "running" || status == "pending";
    let mut plan_item = chat_item(&plan_item_id, "tool", body, streaming);
    plan_item["title"] = json!(format!("Plan · {title}"));
    plan_item["status"] = json!(status);
    plan_item["toolKind"] = json!("planUpdate");
    {
        let mut live = live_turns().lock().unwrap();
        if let Some(run) = live.runs.get_mut(run_id) {
            push_event(run, json!({ "kind": "upsert", "item": plan_item.clone() }));
        }
    }
    live_cv().notify_all();
    let mut items = threads().lock().unwrap();
    if let Some(thread) = items
        .iter_mut()
        .find(|thread| thread.get("id").and_then(|v| v.as_str()) == Some(thread_id))
    {
        upsert_item(thread, &plan_item);
    }
}
