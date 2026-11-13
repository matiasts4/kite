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

pub fn get_thread_subagent_detail(request: Option<Value>) -> Value {
    let req = body(&request);
    let thread_id = req
        .and_then(|r| r.get("threadId").or_else(|| r.get("thread_id")))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let subagent_id = req
        .and_then(|r| r.get("subagentId").or_else(|| r.get("subagent_id")))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let (Some(tid), Some(sid)) = (thread_id, subagent_id) else {
        return json!({ "error": "threadId and subagentId are required" });
    };
    crate::chat::subagents::build_subagent_detail(tid, sid).unwrap_or(Value::Null)
}

pub fn get_thread_swarm_state(request: Option<Value>) -> Value {
    let req = body(&request);
    let Some(tid) = req
        .and_then(|r| r.get("threadId").or_else(|| r.get("thread_id")))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return json!({ "error": "threadId is required" });
    };
    crate::chat::subagents::build_swarm_state(tid)
}

pub fn send_subagent_message(request: Option<Value>) -> Value {
    let req = body(&request);
    let tid = req
        .and_then(|r| r.get("threadId").or_else(|| r.get("thread_id")))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let sid = req
        .and_then(|r| r.get("subagentId").or_else(|| r.get("subagent_id")))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let message = req
        .and_then(|r| r.get("message"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let (Some(tid), Some(sid), Some(msg)) = (tid, sid, message) else {
        return json!({ "error": "threadId, subagentId, and non-empty message are required" });
    };
    match crate::chat::subagents::steer_subagent_thread(tid, sid, msg) {
        Ok(run) => json!({ "ok": true, "run": run }),
        Err(error) => json!({ "error": error }),
    }
}

pub fn stop_subagent_run(request: Option<Value>) -> Value {
    let req = body(&request);
    let tid = req
        .and_then(|r| r.get("threadId").or_else(|| r.get("thread_id")))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let sid = req
        .and_then(|r| r.get("subagentId").or_else(|| r.get("subagent_id")))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let (Some(tid), Some(sid)) = (tid, sid) else {
        return json!({ "error": "threadId and subagentId are required" });
    };
    match crate::chat::subagents::cancel_subagent_thread(tid, sid) {
        Ok(run) => json!({ "ok": true, "run": run }),
        Err(error) => json!({ "error": error }),
    }
}

pub fn swarm_post_from_ui(request: Option<Value>) -> Value {
    let req = body(&request);
    let tid = req
        .and_then(|r| r.get("threadId").or_else(|| r.get("thread_id")))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let message = req
        .and_then(|r| r.get("message"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let channel = req
        .and_then(|r| r.get("channel"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let (Some(tid), Some(msg)) = (tid, message) else {
        return json!({ "error": "threadId and non-empty message are required" });
    };
    let from = format!("thread:{tid}");
    match crate::chat::swarm::execute_swarm_action(
        &crate::dispatch::cli::SwarmCommand::Post {
            channel,
            text: msg.to_string(),
        },
        &from,
        None,
        None,
    ) {
        Ok(result) => json!({
            "ok": true,
            "result": result,
            "swarmState": crate::chat::subagents::build_swarm_state(tid),
        }),
        Err(err) => json!({ "error": err.code() }),
    }
}

pub fn swarm_switch_worker_model(request: Option<Value>) -> Value {
    let req = body(&request);
    let tid = req
        .and_then(|r| r.get("threadId").or_else(|| r.get("thread_id")))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let name = req
        .and_then(|r| r.get("name"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let model = req
        .and_then(|r| r.get("model"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let raw_provider = req
        .and_then(|r| r.get("provider"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let provider = match raw_provider {
        Some(raw) => match crate::dispatch::cli::canonical_thread_provider(raw) {
            Some(canon) => Some(canon.to_string()),
            None => return json!({ "error": "invalid provider" }),
        },
        None => None,
    };
    let raw_effort = req
        .and_then(|r| r.get("effort"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let effort = match raw_effort {
        Some(raw) => match crate::dispatch::cli::normalize_effort(raw) {
            Some(norm) => Some(norm),
            None => return json!({ "error": "invalid effort" }),
        },
        None => None,
    };
    let (Some(tid), Some(name), Some(model)) = (tid, name, model) else {
        return json!({ "error": "threadId, name, and model are required" });
    };
    let from = format!("thread:{tid}");
    match crate::chat::swarm::execute_swarm_action(
        &crate::dispatch::cli::SwarmCommand::Model {
            name: name.to_string(),
            provider,
            model: model.to_string(),
            effort,
        },
        &from,
        None,
        None,
    ) {
        Ok(result) => json!({
            "ok": true,
            "result": result,
            "swarmState": crate::chat::subagents::build_swarm_state(tid),
        }),
        Err(err) => json!({ "error": err.code() }),
    }
}

pub fn swarm_kill_worker_from_ui(request: Option<Value>) -> Value {
    let req = body(&request);
    let tid = req
        .and_then(|r| r.get("threadId").or_else(|| r.get("thread_id")))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let name = req
        .and_then(|r| r.get("name"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let (Some(tid), Some(name)) = (tid, name) else {
        return json!({ "error": "threadId and name are required" });
    };
    let from = format!("thread:{tid}");
    match crate::chat::swarm::execute_swarm_action(
        &crate::dispatch::cli::SwarmCommand::Kill {
            name: name.to_string(),
        },
        &from,
        None,
        None,
    ) {
        Ok(result) => json!({
            "ok": true,
            "result": result,
            "swarmState": crate::chat::subagents::build_swarm_state(tid),
        }),
        Err(err) => json!({ "error": err.code() }),
    }
}
