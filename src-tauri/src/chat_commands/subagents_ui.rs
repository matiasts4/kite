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

pub fn list_all_subagent_runs(request: Option<Value>) -> Value {
    let req = body(&request);
    let workspace_id = req
        .and_then(|r| r.get("workspaceId").or_else(|| r.get("workspace_id")))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let limit = req
        .and_then(|r| r.get("limit"))
        .and_then(Value::as_u64)
        .map(|n| n as usize)
        .unwrap_or(120);
    let include_history = req
        .and_then(|r| r.get("includeHistory").or_else(|| r.get("include_history")))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let active_thread_ids: std::collections::HashSet<String> = req
        .and_then(|r| r.get("activeThreadIds").or_else(|| r.get("active_thread_ids")))
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    crate::chat::subagents::list_all_subagent_runs_snapshot_with_options(
        crate::chat::subagents::GlobalSubagentRunsOptions {
            workspace_id,
            limit,
            include_history,
            active_thread_ids: if active_thread_ids.is_empty() {
                None
            } else {
                Some(&active_thread_ids)
            },
            session_started_at_ms: None,
        },
    )
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
    let override_stack = req
        .and_then(|r| r.get("overrideStack").or_else(|| r.get("override_stack")))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let (Some(tid), Some(name), Some(model)) = (tid, name, model) else {
        return json!({ "error": "threadId, name, and model are required" });
    };
    let settings = crate::subagent_settings::get_subagent_settings();
    let effective_provider = provider.clone().or_else(|| {
        let all = crate::persist::threads().lock().ok()?;
        let coord = all
            .iter()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(tid))?;
        if name.eq_ignore_ascii_case("coordinator") {
            return coord
                .get("provider")
                .or_else(|| coord.get("engine"))
                .and_then(Value::as_str)
                .map(str::to_string);
        }
        coord
            .get("swarmState")
            .and_then(|s| s.get("members"))
            .and_then(Value::as_array)?
            .iter()
            .find(|m| {
                m.get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|n| n.eq_ignore_ascii_case(name))
            })
            .and_then(|m| m.get("provider").and_then(Value::as_str).map(str::to_string))
    });
    if let Err(detail) = crate::subagent_settings::check_stack_policy(
        &settings,
        effective_provider.as_deref(),
        Some(model),
        override_stack,
    ) {
        return json!({ "error": detail });
    }
    let from = format!("thread:{tid}");
    match crate::chat::swarm::execute_swarm_action(
        &crate::dispatch::cli::SwarmCommand::Model {
            name: name.to_string(),
            provider,
            model: model.to_string(),
            effort,
            override_stack,
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

fn resolve_workspace_path_from_req(req: Option<&Value>) -> Option<std::path::PathBuf> {
    let explicit = req
        .and_then(|r| r.get("workspacePath").or_else(|| r.get("workspace_path")))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if let Some(path) = explicit {
        return Some(std::path::PathBuf::from(path));
    }
    let workspace_id = req
        .and_then(|r| r.get("workspaceId").or_else(|| r.get("workspace_id")))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| {
            load_grid()
                .get("grid")
                .and_then(|g| g.get("activeWorkspaceId"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        });
    workspace_id
        .as_deref()
        .and_then(crate::persist::workspace_path)
        .map(std::path::PathBuf::from)
}

pub fn get_subagent_settings(request: Option<Value>) -> Value {
    let req = body(&request);
    let workspace_path = resolve_workspace_path_from_req(req);
    let settings = crate::subagent_settings::get_subagent_settings();
    let discovery =
        crate::chat::models::discover_thread_providers_with_settings(false, &settings);
    let providers = discovery
        .get("providers")
        .cloned()
        .unwrap_or_else(|| json!([]));
    let roles = crate::subagent_settings::list_roles(workspace_path.as_deref());
    json!({
        "ok": true,
        "settings": settings,
        "providers": providers,
        "roles": roles,
        "workspacePath": workspace_path.as_ref().map(|p| p.to_string_lossy().to_string()),
    })
}

pub fn save_subagent_settings(request: Option<Value>) -> Value {
    let req = body(&request);
    let workspace_path = resolve_workspace_path_from_req(req);
    let raw_settings = req
        .and_then(|r| r.get("settings").cloned())
        .or_else(|| req.cloned())
        .unwrap_or(Value::Null);
    let parsed: crate::subagent_settings::SubagentSettings =
        match serde_json::from_value(raw_settings) {
            Ok(v) => v,
            Err(err) => return json!({ "error": format!("Invalid subagent settings: {err}") }),
        };
    match crate::subagent_settings::save_subagent_settings(parsed) {
        Ok(settings) => {
            crate::chat::models::invalidate_thread_providers_cache();
            let _ = crate::dispatch::cli::install_dispatch_skill();
            let discovery =
                crate::chat::models::discover_thread_providers_with_settings(
                    false,
                    &settings,
                );
            let providers = discovery
                .get("providers")
                .cloned()
                .unwrap_or_else(|| json!([]));
            let roles = crate::subagent_settings::list_roles(workspace_path.as_deref());
            json!({
                "ok": true,
                "settings": settings,
                "providers": providers,
                "roles": roles,
                "workspacePath": workspace_path.as_ref().map(|p| p.to_string_lossy().to_string()),
            })
        }
        Err(err) => json!({ "error": err }),
    }
}

pub fn list_subagent_roles(request: Option<Value>) -> Value {
    let req = body(&request);
    let workspace_path = resolve_workspace_path_from_req(req);
    let roles = crate::subagent_settings::list_roles(workspace_path.as_deref());
    json!({
        "ok": true,
        "roles": roles,
        "workspacePath": workspace_path.as_ref().map(|p| p.to_string_lossy().to_string()),
    })
}

pub fn save_subagent_role(request: Option<Value>) -> Value {
    let req = body(&request);
    let workspace_path = resolve_workspace_path_from_req(req);
    let raw_role = req
        .and_then(|r| r.get("role").cloned())
        .or_else(|| req.cloned())
        .unwrap_or(Value::Null);
    let input: crate::subagent_settings::SaveSubagentRoleInput =
        match serde_json::from_value(raw_role) {
            Ok(v) => v,
            Err(err) => return json!({ "error": format!("Invalid role payload: {err}") }),
        };
    match crate::subagent_settings::save_role(workspace_path.as_deref(), input) {
        Ok(role) => {
            let _ = crate::dispatch::cli::install_dispatch_skill();
            let roles = crate::subagent_settings::list_roles(workspace_path.as_deref());
            json!({
                "ok": true,
                "role": role,
                "roles": roles,
            })
        }
        Err(err) => json!({ "error": err }),
    }
}

pub fn delete_subagent_role(request: Option<Value>) -> Value {
    let req = body(&request);
    let workspace_path = resolve_workspace_path_from_req(req);
    let scope = req
        .and_then(|r| r.get("scope"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let slug = req
        .and_then(|r| r.get("slug"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let (Some(scope), Some(slug)) = (scope, slug) else {
        return json!({ "error": "scope and slug are required" });
    };
    match crate::subagent_settings::delete_role(workspace_path.as_deref(), scope, slug) {
        Ok(()) => {
            let _ = crate::dispatch::cli::install_dispatch_skill();
            let roles = crate::subagent_settings::list_roles(workspace_path.as_deref());
            json!({
                "ok": true,
                "roles": roles,
            })
        }
        Err(err) => json!({ "error": err }),
    }
}
