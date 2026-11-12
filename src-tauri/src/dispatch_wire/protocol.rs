//! Protocol definitions, live ports, presence tracking, and session routing.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::Emitter;

use crate::dispatch::cli;
use crate::dispatch::policy::Service;
use crate::dispatch::port::{Port, StartRequest, Started, SubmitMeta};
use crate::dispatch::presence::{BlockKind, PresenceState};
use crate::dispatch::types::{Caller, DispatchError, Family, PaneVisibility};

pub static STOP: AtomicBool = AtomicBool::new(false);

pub struct LivePort;

impl Port for LivePort {
    fn submit(
        &mut self,
        family: Family,
        id: &str,
        text: &str,
        meta: &SubmitMeta,
    ) -> Result<(), DispatchError> {
        if family == Family::Terminal && !meta.presentation_emitted {
            emit_projectile(id, text, meta);
        }
        match family {
            Family::Terminal => {
                if meta.mounted {
                    return Ok(());
                }
                let bracketed = crate::dispatch::policy::format_terminal_paste(text);
                let written = crate::terminal::write_terminal_sync(json!({
                    "sessionId": id,
                    "input": bracketed,
                }));
                if written.get("error").is_some()
                    || written.get("ok") == Some(&Value::Bool(false))
                {
                    // No live PTY answered: never report a delivery that never happened.
                    return Err(DispatchError::DestinationGone);
                }
                thread::sleep(Duration::from_millis(45));
                let enter = crate::terminal::write_terminal_sync(json!({
                    "sessionId": id,
                    "input": "\r",
                }));
                if enter.get("error").is_some() || enter.get("ok") == Some(&Value::Bool(false)) {
                    return Err(DispatchError::DestinationGone);
                }
                Ok(())
            }
            Family::Thread => {
                let value = crate::chat::start_turn(id, None, text, Vec::new(), None);
                if value.get("error").is_some() {
                    Err(DispatchError::TransportUnsupported)
                } else {
                    Ok(())
                }
            }
        }
    }

    fn read(&mut self, family: Family, id: &str, lines: usize) -> Result<String, DispatchError> {
        let text = match family {
            Family::Terminal => terminal_tail(id),
            Family::Thread => thread_tail(id),
        };
        Ok(crate::dispatch::envelope::last_lines(&text, lines))
    }

    fn stop(&mut self, family: Family, id: &str) -> Result<(), DispatchError> {
        match family {
            Family::Terminal => {
                let _ = crate::terminal::terminate_terminal_sync(json!({ "sessionId": id }));
            }
            Family::Thread => {
                if let Ok(mut manager) = crate::chat::session_manager().lock() {
                    let _ = manager.interrupt(id);
                }
            }
        }
        Ok(())
    }

    fn start_terminal(&mut self, request: &StartRequest) -> Result<Started, DispatchError> {
        let mut payload = json!({
            "engine": request.engine,
            "cwd": request.cwd,
            "autoApprove": true,
        });
        if let Some(prompt) = request.prompt.as_ref() {
            payload["initialPrompt"] = Value::String(prompt.clone());
        }
        if request.manual_as_system {
            payload["systemPrompt"] = Value::String(cli::manual_text().to_string());
        }
        if !request.argv.is_empty() {
            payload["argv"] = Value::Array(
                request
                    .argv
                    .iter()
                    .cloned()
                    .map(Value::String)
                    .collect(),
            );
        }
        let value = crate::terminal::start_terminal_sync(payload);
        if value.get("error").and_then(Value::as_str) == Some("program_not_found") {
            return Err(DispatchError::ProgramNotFound);
        }
        let id = value
            .get("sessionId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .map(|id| id.to_string())
            .ok_or(DispatchError::TransportUnsupported)?;
        let pane = if request.hidden {
            PaneVisibility::Hidden
        } else {
            emit_open_pane(&id, &request.engine, request.name.as_deref());
            PaneVisibility::Pending
        };
        Ok(Started {
            session_id: id,
            pane,
        })
    }

    fn type_bytes(&mut self, family: Family, id: &str, text: &str) -> Result<(), DispatchError> {
        match family {
            Family::Terminal => {
                let written = crate::terminal::write_terminal_sync(json!({
                    "sessionId": id,
                    "input": text,
                }));
                if written.get("error").is_some() || written.get("ok") == Some(&Value::Bool(false))
                {
                    return Err(DispatchError::DestinationGone);
                }
                Ok(())
            }
            Family::Thread => Err(DispatchError::TransportUnsupported),
        }
    }

    fn reveal(&mut self, id: &str, engine: &str, name: Option<&str>) -> Result<(), DispatchError> {
        emit_open_pane(id, engine, name);
        Ok(())
    }
}

pub fn emit_projectile(session_id: &str, text: &str, meta: &SubmitMeta) {
    let payload = json!({
        "sessionId": session_id,
        "targetSessionId": session_id,
        "sourceSessionId": meta.source,
        "prompt": text,
        "label": meta.label,
        "visualOnly": !meta.mounted,
    });
    if let Some(app) = crate::get_app_handle() {
        let _ = app.emit("dispatch-prompt-projectile", payload);
    } else {
        crate::core_daemon::broadcast_daemon_ui_event("dispatch-prompt-projectile", payload);
    }
}

pub fn register_terminal_session(session_id: &str, engine: &str, alias: Option<&str>) {
    if session_id.trim().is_empty() {
        return;
    }
    let mut guard = match service().lock() {
        Ok(guard) => guard,
        Err(poison) => poison.into_inner(),
    };
    let clean_alias = alias
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("terminal"));
    let _ = guard.attach(Family::Terminal, session_id, clean_alias, None, false);
    let key = crate::dispatch::address::canonical(true, session_id);
    guard.set_endpoint_engine(&key, engine);
}

fn pane_ids() -> &'static Mutex<HashSet<String>> {
    static IDS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    IDS.get_or_init(|| Mutex::new(HashSet::new()))
}

pub fn mark_pane_shown(session_id: &str) {
    let Ok(mut ids) = pane_ids().lock() else {
        return;
    };
    ids.insert(session_id.to_string());
    let _shown = ids.contains(session_id);
}

pub fn emit_open_pane(session_id: &str, engine: &str, alias: Option<&str>) {
    let payload = json!({
        "sessionId": session_id,
        "engine": engine,
        "alias": alias,
    });
    if let Some(app) = crate::get_app_handle() {
        let _ = app.emit("dispatch-open-pane", payload);
    } else {
        crate::core_daemon::broadcast_daemon_ui_event("dispatch-open-pane", payload);
    }
}

pub fn terminal_tail(session_id: &str) -> String {
    crate::terminal::terminal_recent_text(session_id)
}

pub fn thread_tail(thread_id: &str) -> String {
    let Ok(items) = crate::persist::threads().lock() else {
        return String::new();
    };
    let Some(thread) = items
        .iter()
        .find(|thread| thread.get("id").and_then(Value::as_str) == Some(thread_id))
    else {
        return String::new();
    };
    let Some(list) = thread.get("items").and_then(Value::as_array) else {
        return String::new();
    };
    list.iter()
        .filter_map(|item| item.get("text").and_then(Value::as_str))
        .filter(|text| !text.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn service() -> &'static Mutex<Service<LivePort>> {
    static SERVICE: OnceLock<Mutex<Service<LivePort>>> = OnceLock::new();
    SERVICE.get_or_init(|| Mutex::new(Service::new(LivePort)))
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn endpoint_path() -> PathBuf {
    crate::persist::roaming_app_dir().join("dispatch-endpoint.json")
}

pub fn import_marker() -> PathBuf {
    crate::persist::roaming_app_dir().join("dispatch-import.done")
}

pub fn guard_online(svc: &Service<LivePort>) -> bool {
    online_flag(svc)
}

pub fn online_flag(svc: &Service<LivePort>) -> bool {
    // Service keeps online private. A shutdown flips it and send returns runtime_offline.
    let _ = svc;
    !STOP.load(Ordering::SeqCst)
}

pub fn apply_switches(svc: &mut Service<LivePort>, address: &str) {
    let (enabled, read_only) = messaging_flags();
    svc.set_messaging(enabled, read_only);
    if let Some(profile) = address.strip_prefix("agent:") {
        svc.set_profile_messaging(profile, profile_allows(profile));
    }
}

pub fn prepare(svc: &mut Service<LivePort>, address: &str, observed: Option<&str>) {
    if let Some(id) = address.strip_prefix("session:") {
        let _ = svc.attach(Family::Terminal, id, None, None, false);
        if let Some(state) = observed {
            let _ = svc.publish_pane(address, state, now_ms(), now_ms(), None, None);
        }
    } else if let Some(id) = address.strip_prefix("thread:") {
        let _ = svc.attach(Family::Thread, id, None, None, false);
        publish_thread(svc, id);
    } else if let Some(profile) = address.strip_prefix("agent:") {
        if let Some(thread_id) = live_thread_for_profile(profile) {
            let _ = svc.attach(Family::Thread, &thread_id, None, None, false);
            let _ = svc.bind_agent(profile, &thread_id);
            publish_thread(svc, &thread_id);
        }
    }
}

pub fn publish_thread(svc: &mut Service<LivePort>, thread_id: &str) {
    let (state, kind) = thread_presence(thread_id);
    let address = format!("thread:{thread_id}");
    let _ = svc.publish_reported(&address, state, kind, now_ms(), now_ms());
}

pub fn thread_presence(thread_id: &str) -> (PresenceState, Option<BlockKind>) {
    let Ok(manager) = crate::chat::session_manager().lock() else {
        return (PresenceState::Idle, None);
    };
    let Some(record) = manager.status(thread_id) else {
        return (PresenceState::Idle, None);
    };
    if !record.pending_approvals.is_empty() || record.state == crate::chat::SessionState::Waiting {
        return (PresenceState::Blocked, Some(BlockKind::Permission));
    }
    let state = match record.state {
        crate::chat::SessionState::Running
        | crate::chat::SessionState::Starting
        | crate::chat::SessionState::Resurrecting => PresenceState::Working,
        crate::chat::SessionState::Completed => PresenceState::Done,
        crate::chat::SessionState::Failed => PresenceState::Error,
        crate::chat::SessionState::Closed => PresenceState::Gone,
        _ => PresenceState::Idle,
    };
    (state, None)
}

pub fn live_thread_for_profile(profile: &str) -> Option<String> {
    let items = crate::persist::threads().lock().ok()?;
    for thread in items.iter() {
        if thread.get("profileId").and_then(Value::as_str) != Some(profile) {
            continue;
        }
        if thread.get("archivedAtUnixMs").and_then(Value::as_i64).is_some() {
            continue;
        }
        let id = thread.get("id").and_then(Value::as_str)?;
        let attached = crate::chat::session_manager()
            .lock()
            .ok()
            .and_then(|manager| manager.status(id))
            .is_some();
        if attached {
            return Some(id.to_string());
        }
    }
    None
}

pub fn caller_of(request: &Value) -> Caller {
    request
        .get("caller")
        .and_then(Value::as_str)
        .and_then(Caller::parse)
        .unwrap_or(Caller::Human)
}

pub fn messaging_flags() -> (bool, bool) {
    let pref = crate::agents::agent_messaging_preference();
    let enabled = pref.get("enabled").and_then(Value::as_bool).unwrap_or(true);
    let read_only = pref.get("readOnly").and_then(Value::as_bool).unwrap_or(false);
    (enabled, read_only)
}

pub fn profile_allows(profile: &str) -> bool {
    crate::persist::agents()
        .lock()
        .ok()
        .and_then(|agents| {
            agents
                .iter()
                .find(|agent| agent.id == profile)
                .map(|agent| agent.allow_agent_messaging.unwrap_or(true))
        })
        .unwrap_or(true)
}
