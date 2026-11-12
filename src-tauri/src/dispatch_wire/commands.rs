//! Command implementations for dispatch operations.

use serde_json::{json, Value};

use crate::dispatch::cli::{self, skill_text};
use crate::dispatch::presence::PresenceState;
use crate::dispatch::types::{DispatchError, Family};

use super::protocol::mark_pane_shown;
use super::server::{direct_op, execute_command};

fn req_value(request: Option<Value>) -> Value {
    let Some(request) = request else {
        return Value::Null;
    };
    request.get("request").cloned().unwrap_or(request)
}

fn proxy_dispatch(action: &str, request: Option<Value>) -> Option<Value> {
    if !crate::core_daemon::is_external_daemon_owner() {
        return None;
    }
    let mut payload = req_value(request);
    if payload.is_null() {
        payload = json!({});
    }
    if let Some(obj) = payload.as_object_mut() {
        obj.insert("action".to_string(), json!(action));
    }
    crate::core_daemon::send_core_daemon_rpc("agent.dispatch", Some(payload)).ok()
}

pub fn dispatch_send(request: Option<Value>) -> Value {
    if let Some(res) = proxy_dispatch("send", request.clone()) {
        return res;
    }
    let request = req_value(request);
    let id = request
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("send")
        .to_string();
    let address = request.get("address").and_then(Value::as_str).unwrap_or("").to_string();
    let body = request.get("body").and_then(Value::as_str).map(|s| s.to_string());
    let command = cli::Command::Send {
        address,
        body,
        file: request.get("file").and_then(Value::as_str).map(|s| s.to_string()),
        force: request.get("force").and_then(Value::as_bool).unwrap_or(false),
        only_ready: request.get("onlyReady").and_then(Value::as_bool).unwrap_or(false),
        allow_queue: request.get("allowQueue").and_then(Value::as_bool).unwrap_or(true),
    };
    let receipt = execute_command(&request, &command, &id);
    serde_json::to_value(&receipt).unwrap_or(Value::Null)
}

pub fn dispatch_publish(request: Option<Value>) -> Value {
    if let Some(res) = proxy_dispatch("publish", request.clone()) {
        return res;
    }
    let request = req_value(request);
    let id = "publish".to_string();
    serde_json::to_value(direct_op(&request, "publish", &id)).unwrap_or(Value::Null)
}

pub fn dispatch_osc(request: Option<Value>) -> Value {
    if let Some(res) = proxy_dispatch("osc", request.clone()) {
        return res;
    }
    let request = req_value(request);
    serde_json::to_value(direct_op(&request, "osc", "osc")).unwrap_or(Value::Null)
}

pub fn dispatch_ls(request: Option<Value>) -> Value {
    if let Some(res) = proxy_dispatch("ls", request.clone()) {
        return res;
    }
    let request = req_value(request);
    let id = request.get("id").and_then(Value::as_str).unwrap_or("ls");
    serde_json::to_value(execute_command(&request, &cli::Command::Ls, id)).unwrap_or(Value::Null)
}

pub fn dispatch_run(request: Option<Value>) -> Value {
    if let Some(res) = proxy_dispatch("run", request.clone()) {
        return res;
    }
    let request = req_value(request);
    let id = request.get("id").and_then(Value::as_str).unwrap_or("run").to_string();
    let raw_via = request.get("via").and_then(Value::as_str);
    let from_str = request.get("from").and_then(Value::as_str).unwrap_or("");
    let explicit_via = raw_via.is_some();
    let explicit_name = request.get("name").and_then(Value::as_str).is_some();
    let via = match raw_via {
        Some("thread") => Family::Thread,
        Some("terminal") => Family::Terminal,
        Some(_) => {
            return serde_json::to_value(&crate::dispatch::types::Receipt::new(
                &id,
                "run",
                crate::dispatch::types::ReceiptStatus::Rejected,
                "",
                false,
                None,
                Some(DispatchError::BadArgs.code().into()),
            ))
            .unwrap_or(Value::Null);
        }
        None if from_str.starts_with("thread:") => Family::Thread,
        None => Family::Terminal,
    };
    let role = request.get("role").and_then(Value::as_str).map(|s| s.to_string());
    let explicit_role = role.is_some();
    let provider = match request.get("provider").and_then(Value::as_str) {
        Some(raw) if !raw.trim().is_empty() => match cli::canonical_thread_provider(raw) {
            Some(canon) => Some(canon.to_string()),
            None => {
                return serde_json::to_value(&crate::dispatch::types::Receipt::new(
                    &id,
                    "run",
                    crate::dispatch::types::ReceiptStatus::Rejected,
                    "",
                    false,
                    None,
                    Some(DispatchError::BadArgs.code().into()),
                ))
                .unwrap_or(Value::Null);
            }
        },
        _ => None,
    };
    let model = request.get("model").and_then(Value::as_str).map(str::to_string);
    let effort = match request.get("effort").and_then(Value::as_str) {
        Some(raw) if !raw.trim().is_empty() => match cli::normalize_effort(raw) {
            Some(norm) => Some(norm),
            None => {
                return serde_json::to_value(&crate::dispatch::types::Receipt::new(
                    &id,
                    "run",
                    crate::dispatch::types::ReceiptStatus::Rejected,
                    "",
                    false,
                    None,
                    Some(DispatchError::BadArgs.code().into()),
                ))
                .unwrap_or(Value::Null);
            }
        },
        _ => None,
    };
    let workspace = match request.get("workspace").and_then(Value::as_str) {
        Some(raw) if !raw.trim().is_empty() => match cli::normalize_workspace_mode(raw) {
            Some(norm) => Some(norm),
            None => {
                return serde_json::to_value(&crate::dispatch::types::Receipt::new(
                    &id,
                    "run",
                    crate::dispatch::types::ReceiptStatus::Rejected,
                    "",
                    false,
                    None,
                    Some(DispatchError::BadArgs.code().into()),
                ))
                .unwrap_or(Value::Null);
            }
        },
        _ => None,
    };
    let command = cli::Command::Run {
        via,
        explicit_via,
        engine: request.get("engine").and_then(Value::as_str).map(|s| s.to_string()),
        provider,
        model,
        effort,
        workspace,
        name: request.get("name").and_then(Value::as_str).map(|s| s.to_string()),
        explicit_name,
        parent: request.get("parent").and_then(Value::as_str).map(|s| s.to_string()),
        outlive: request.get("outlive").and_then(Value::as_bool).unwrap_or(false),
        role,
        explicit_role,
        file: request.get("file").and_then(Value::as_str).map(|s| s.to_string()),
        task: request.get("task").and_then(Value::as_str).map(|s| s.to_string()),
        wait: request.get("wait").and_then(Value::as_bool).unwrap_or(false),
        timeout_ms: request.get("timeoutMs").and_then(Value::as_u64),
        hidden: request.get("hidden").and_then(Value::as_bool).unwrap_or(false),
        pane: request.get("pane").and_then(Value::as_bool).unwrap_or(false),
        program: request.get("program").and_then(Value::as_str).map(|s| s.to_string()),
        words: request
            .get("words")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default(),
    };
    serde_json::to_value(execute_command(&request, &command, &id)).unwrap_or(Value::Null)
}

pub fn dispatch_wait(request: Option<Value>) -> Value {
    if let Some(res) = proxy_dispatch("wait", request.clone()) {
        return res;
    }
    let request = req_value(request);
    let id = request.get("id").and_then(Value::as_str).unwrap_or("wait").to_string();
    let until = request
        .get("until")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .filter_map(PresenceState::parse)
                .collect()
        })
        .unwrap_or_default();
    let children = match request.get("children").and_then(Value::as_str) {
        Some("all") => Some(crate::dispatch::ChildrenMode::All),
        Some("any") => Some(crate::dispatch::ChildrenMode::Any),
        _ => None,
    };
    let command = cli::Command::Wait {
        address: request.get("address").and_then(Value::as_str).map(|s| s.to_string()),
        until,
        children,
        timeout_ms: request.get("timeoutMs").and_then(Value::as_u64).unwrap_or(0),
    };
    serde_json::to_value(execute_command(&request, &command, &id)).unwrap_or(Value::Null)
}

pub fn dispatch_read(request: Option<Value>) -> Value {
    if let Some(res) = proxy_dispatch("read", request.clone()) {
        return res;
    }
    let request = req_value(request);
    let id = request.get("id").and_then(Value::as_str).unwrap_or("read").to_string();
    let command = cli::Command::Read {
        address: request.get("address").and_then(Value::as_str).unwrap_or("").to_string(),
        lines: request.get("lines").and_then(Value::as_u64).unwrap_or(80) as usize,
        last_assistant: request
            .get("last")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    };
    serde_json::to_value(execute_command(&request, &command, &id)).unwrap_or(Value::Null)
}

pub fn dispatch_report(request: Option<Value>) -> Value {
    if let Some(res) = proxy_dispatch("report", request.clone()) {
        return res;
    }
    let request = req_value(request);
    let id = request.get("id").and_then(Value::as_str).unwrap_or("report").to_string();
    let command = cli::Command::Report {
        to: request.get("to").and_then(Value::as_str).map(|s| s.to_string()),
        from: request.get("from").and_then(Value::as_str).map(|s| s.to_string()),
        body: request.get("body").and_then(Value::as_str).map(|s| s.to_string()),
        file: request.get("file").and_then(Value::as_str).map(|s| s.to_string()),
    };
    serde_json::to_value(execute_command(&request, &command, &id)).unwrap_or(Value::Null)
}

fn dispatch_address_command(
    action: &str,
    request: Option<Value>,
    build: impl FnOnce(String, &Value) -> cli::Command,
) -> Value {
    if let Some(res) = proxy_dispatch(action, request.clone()) {
        return res;
    }
    let request = req_value(request);
    let id = request
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or(action)
        .to_string();
    let address = request
        .get("address")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let command = build(address, &request);
    serde_json::to_value(execute_command(&request, &command, &id)).unwrap_or(Value::Null)
}

pub fn dispatch_kill(request: Option<Value>) -> Value {
    dispatch_address_command("kill", request, |address, _| cli::Command::Kill { address })
}

pub fn dispatch_interrupt(request: Option<Value>) -> Value {
    dispatch_address_command("interrupt", request, |address, _| cli::Command::Interrupt {
        address,
    })
}

pub fn dispatch_keys(request: Option<Value>) -> Value {
    dispatch_address_command("keys", request, |address, request| cli::Command::Keys {
        address,
        keys: request
            .get("keys")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default(),
    })
}

pub fn dispatch_attach(request: Option<Value>) -> Value {
    dispatch_address_command("attach", request, |address, _| cli::Command::Attach { address })
}

pub fn dispatch_skill() -> Value {
    json!({ "schemaVersion": 1, "text": skill_text() })
}

/// Records that a pane attached. Does not take the policy lock.
pub fn dispatch_pane_shown(request: Option<Value>) -> Value {
    if let Some(res) = proxy_dispatch("pane_shown", request.clone()) {
        return res;
    }
    let request = req_value(request);
    if let Some(id) = request.get("sessionId").and_then(Value::as_str) {
        mark_pane_shown(id);
    }
    json!({ "ok": true })
}
