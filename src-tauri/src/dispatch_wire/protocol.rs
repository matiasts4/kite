//! Protocol definitions, live ports, presence tracking, and session routing.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::Emitter;

use crate::dispatch::cli;
use crate::dispatch::policy::Service;
use crate::dispatch::port::{Port, StartRequest, StartThreadRequest, Started, SubmitMeta};
use crate::dispatch::presence::{BlockKind, PresenceState};
use crate::dispatch::types::{Caller, DispatchError, Family, PaneVisibility};

pub static STOP: AtomicBool = AtomicBool::new(false);
static PUBLISH_SEQ: AtomicU64 = AtomicU64::new(0);

fn next_publish_seq() -> u64 {
    let ts = now_ms();
    loop {
        let prev = PUBLISH_SEQ.load(Ordering::Relaxed);
        let next = prev.max(ts).saturating_add(1);
        if PUBLISH_SEQ
            .compare_exchange_weak(prev, next, Ordering::Relaxed, Ordering::Relaxed)
            .is_ok()
        {
            return next;
        }
    }
}

pub use crate::chat::kill_registry::{clear_thread_killed, is_thread_killed, mark_thread_killed};

pub struct LivePort;

std::thread_local! {
    static IN_LIVE_PORT_DEPTH: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

struct LivePortReentrancyGuard;

impl LivePortReentrancyGuard {
    fn enter() -> Self {
        IN_LIVE_PORT_DEPTH.with(|depth| depth.set(depth.get() + 1));
        Self
    }
}

impl Drop for LivePortReentrancyGuard {
    fn drop(&mut self) {
        IN_LIVE_PORT_DEPTH.with(|depth| depth.set(depth.get().saturating_sub(1)));
    }
}

fn in_live_port() -> bool {
    IN_LIVE_PORT_DEPTH.with(|depth| depth.get() > 0)
}

fn with_service_ordered<F>(op: F)
where
    F: FnOnce(&mut Service<LivePort>) + Send + 'static,
{
    if in_live_port() {
        std::thread::spawn(move || {
            if let Ok(mut svc) = service().lock() {
                op(&mut svc);
            }
        });
    } else if let Ok(mut svc) = service().lock() {
        op(&mut svc);
    }
}

impl Port for LivePort {
    fn submit(
        &mut self,
        family: Family,
        id: &str,
        text: &str,
        meta: &SubmitMeta,
    ) -> Result<(), DispatchError> {
        let _reentrant = LivePortReentrancyGuard::enter();
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
            Family::Thread => start_thread_turn(id, text),
        }
    }

    fn read(&mut self, family: Family, id: &str, lines: usize) -> Result<String, DispatchError> {
        let text = match family {
            Family::Terminal => terminal_tail(id),
            Family::Thread => thread_tail(id),
        };
        Ok(crate::dispatch::envelope::last_lines(&text, lines))
    }

    fn read_final_response(&mut self, family: Family, id: &str) -> Result<String, DispatchError> {
        match family {
            Family::Thread => {
                let is_working = thread_presence(id).0 == PresenceState::Working
                    || thread_status(id).as_deref() == Some("running");
                if is_working {
                    return Ok(live_thread_progress_summary(id));
                }
                let text = crate::chat::subagents::extract_final_assistant_text(id);
                if text.is_empty() {
                    Ok(thread_tail(id))
                } else if let Some(failure_msg) = thread_turn_failure_message(id) {
                    if text.contains(&failure_msg) {
                        Ok(text)
                    } else {
                        Ok(format!("{text}\n\n{failure_msg}"))
                    }
                } else {
                    Ok(text)
                }
            }
            Family::Terminal => self.read(family, id, 200),
        }
    }

    fn stop(&mut self, family: Family, id: &str) -> Result<(), DispatchError> {
        let _reentrant = LivePortReentrancyGuard::enter();
        match family {
            Family::Terminal => {
                let _ = crate::terminal::terminate_terminal_sync(json!({ "sessionId": id }));
            }
            Family::Thread => {
                mark_thread_killed(id);
                crate::chat::cancel_turn(id);
                if let Ok(mut manager) = crate::chat::session_manager().lock() {
                    let already_closed = manager
                        .status(id)
                        .is_some_and(|r| r.state == crate::chat::SessionState::Closed);
                    if !already_closed {
                        let _ = manager.stop(id);
                    }
                }
                crate::chat::subagents::sync_child_thread_to_parent(id);
            }
        }
        Ok(())
    }

    fn interrupt(&mut self, family: Family, id: &str) -> Result<(), DispatchError> {
        let _reentrant = LivePortReentrancyGuard::enter();
        match family {
            Family::Terminal => self.type_bytes(family, id, "\u{3}"),
            Family::Thread => {
                crate::chat::cancel_turn(id);
                if let Ok(mut manager) = crate::chat::session_manager().lock() {
                    let state = manager.status(id).map(|r| r.state);
                    if matches!(state, Some(s) if s != crate::chat::SessionState::Closed) {
                        let _ = manager.interrupt(id);
                    }
                    // `interrupt()` leaves persistent servers (e.g. OpenCode) in `Interrupted`,
                    // which blocks `SessionManager::attach` on the next turn; closing it to
                    // `Closed` keeps the thread resumable (`Done`/`Idle`, not `Gone`).
                    if manager
                        .status(id)
                        .is_some_and(|r| r.state == crate::chat::SessionState::Interrupted)
                    {
                        let _ = manager.stop(id);
                    }
                }
                Ok(())
            }
        }
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

    fn start_thread(&mut self, request: &StartThreadRequest) -> Result<Started, DispatchError> {
        let _reentrant = LivePortReentrancyGuard::enter();
        let parent_thread_id = request
            .parent
            .as_deref()
            .map(|p| p.strip_prefix("thread:").unwrap_or(p).to_string());
        let workspace_mode = request
            .workspace_mode
            .as_deref()
            .unwrap_or("inherit")
            .to_string();
        let profile_role = request
            .role
            .as_deref()
            .and_then(crate::dispatch::role::resolve_agent_profile_role);
        let role_label = profile_role
            .as_ref()
            .map(|p| p.display_name.clone())
            .or_else(|| request.role.clone());
        let spawned = crate::chat::subagents::spawn_child_subagent_thread(
            crate::chat::subagents::ChildSubagentSpawnParams {
                parent_thread_id,
                provider: request
                    .provider
                    .clone()
                    .or_else(|| profile_role.as_ref().and_then(|p| p.provider.clone())),
                model: request
                    .model
                    .clone()
                    .or_else(|| profile_role.as_ref().and_then(|p| p.model.clone())),
                effort: request
                    .effort
                    .clone()
                    .or_else(|| profile_role.as_ref().and_then(|p| p.effort.clone())),
                role: role_label.clone(),
                agent_id: profile_role.as_ref().map(|p| p.agent_id.clone()),
                mode: profile_role.as_ref().and_then(|p| p.mode.clone()),
                workspace_mode,
                fallback_cwd: request.cwd.clone(),
                task: request.task.clone(),
            },
        )
        .map_err(|err| {
            crate::chat::utils::chat_log(&format!("start_thread failed: {err}"));
            DispatchError::TransportUnsupported
        })?;

        clear_thread_killed(&spawned.child_thread_id);
        let turn_prompt = match request
            .role
            .as_deref()
            .map(str::trim)
            .filter(|r| !r.is_empty())
        {
            Some(role) if !request.task.trim().is_empty() => {
                format!("[Subagent Role: {role}]\n\n{}", request.task)
            }
            _ => request.task.clone(),
        };
        if !turn_prompt.trim().is_empty() {
            if let Err(err) = start_direct_thread_turn(&spawned.child_thread_id, &turn_prompt) {
                crate::persist::hydrate_thread(&spawned.child_thread_id);
                if let Ok(mut all) = crate::persist::threads().lock() {
                    if let Some(child) = all.iter_mut().find(|t| {
                        t.get("id").and_then(Value::as_str)
                            == Some(spawned.child_thread_id.as_str())
                    }) {
                        child["status"] = json!("error");
                        crate::chat::threads::touch(child);
                    }
                }
                crate::chat::subagents::sync_child_thread_to_parent(&spawned.child_thread_id);
                return Err(err);
            }
        } else {
            crate::persist::hydrate_thread(&spawned.child_thread_id);
            if let Ok(mut all) = crate::persist::threads().lock() {
                if let Some(child) = all.iter_mut().find(|t| {
                    t.get("id").and_then(Value::as_str) == Some(spawned.child_thread_id.as_str())
                }) {
                    child["status"] = json!("idle");
                    crate::chat::threads::touch(child);
                }
            }
            crate::chat::subagents::sync_child_thread_to_parent(&spawned.child_thread_id);
        }

        let pane = if request.hidden {
            PaneVisibility::Hidden
        } else {
            PaneVisibility::Pending
        };
        Ok(Started {
            session_id: spawned.child_thread_id,
            pane,
        })
    }

    fn type_bytes(&mut self, family: Family, id: &str, text: &str) -> Result<(), DispatchError> {
        let _reentrant = LivePortReentrancyGuard::enter();
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
            Family::Thread => {
                if text == "\u{3}" {
                    self.interrupt(family, id)
                } else {
                    Err(DispatchError::TransportUnsupported)
                }
            }
        }
    }

    fn reveal(&mut self, id: &str, engine: &str, name: Option<&str>) -> Result<(), DispatchError> {
        emit_open_pane(id, engine, name);
        Ok(())
    }

    fn swarm(
        &mut self,
        from: &str,
        cwd: Option<&str>,
        command: &cli::SwarmCommand,
    ) -> Result<String, DispatchError> {
        let _reentrant = LivePortReentrancyGuard::enter();
        crate::chat::swarm::execute_swarm_action(command, from, cwd, None)
    }
}

fn extract_clean_dispatch_body(text: &str) -> &str {
    if text.starts_with("[kite from=\"") {
        if let Some((_, body)) = text.split_once("\nBODY:\n") {
            return body;
        }
    }
    text
}

fn read_thread_with<T, F>(thread_id: &str, hydrate_gui: bool, extract: F) -> Option<T>
where
    F: FnOnce(&Value) -> Option<T>,
{
    if crate::persist::is_daemon_process() {
        return crate::persist::find_thread_direct(thread_id).and_then(|t| extract(&t));
    }
    if hydrate_gui {
        crate::persist::hydrate_thread(thread_id);
    }
    let list = crate::persist::threads().lock().ok()?;
    let thread = list
        .iter()
        .find(|t| t.get("id").and_then(Value::as_str) == Some(thread_id))?;
    extract(thread)
}

fn start_thread_turn(id: &str, text: &str) -> Result<(), DispatchError> {
    let parent_id = read_thread_with(id, true, |t| {
        t.get("parentThreadId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    });
    let parent_tid = parent_id.and_then(|pid| {
        let has_subagent_run = read_thread_with(&pid, false, |parent| {
            let found = parent
                .get("subagentRuns")
                .and_then(Value::as_array)
                .is_some_and(|runs| {
                    runs.iter().any(|r| {
                        r.get("childThreadId").and_then(Value::as_str) == Some(id)
                            || r.get("subagentId").and_then(Value::as_str) == Some(id)
                    })
                });
            Some(found)
        })
        .unwrap_or(false);
        has_subagent_run.then_some(pid)
    });
    if let Some(parent_tid) = parent_tid {
        let clean_body = extract_clean_dispatch_body(text);
        return crate::chat::subagents::steer_subagent_thread(&parent_tid, id, clean_body)
            .map(|_| ())
            .map_err(|_| DispatchError::TransportUnsupported);
    }
    start_direct_thread_turn(id, text)
}

fn start_direct_thread_turn(id: &str, text: &str) -> Result<(), DispatchError> {
    clear_thread_killed(id);
    let profile_id = read_thread_with(id, true, |t| {
        t.get("profileId")
            .and_then(Value::as_str)
            .map(str::to_string)
    });
    let value = crate::chat::start_turn(id, profile_id.as_deref(), text, Vec::new(), None);
    if value.get("error").is_some() {
        Err(DispatchError::TransportUnsupported)
    } else {
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

fn turn_failure_message(thread: &Value) -> Option<String> {
    thread
        .pointer("/turnFailure/message")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn thread_turn_failure_message(thread_id: &str) -> Option<String> {
    read_thread_with(thread_id, true, turn_failure_message)
}

const MAX_LIVE_SUMMARY_CHARS: usize = 8_000;
const MAX_THREAD_TAIL_CHARS: usize = 12_000;

fn thread_status(thread_id: &str) -> Option<String> {
    read_thread_with(thread_id, false, |thread| {
        thread
            .get("status")
            .and_then(Value::as_str)
            .map(str::to_string)
    })
}

fn live_thread_progress_summary(thread_id: &str) -> String {
    use crate::dispatch::mcp::truncate_tail_chars;

    let items_snapshot: Vec<Value> = read_thread_with(thread_id, true, |t| {
        t.get("items").and_then(Value::as_array).cloned()
    })
    .unwrap_or_default();

    let latest_assistant = items_snapshot
        .iter()
        .rev()
        .find(|it| {
            it.get("kind").and_then(Value::as_str) == Some("assistant")
                && it
                    .get("text")
                    .and_then(Value::as_str)
                    .is_some_and(|s| !s.trim().is_empty())
        })
        .and_then(|it| it.get("text").and_then(Value::as_str))
        .map(|s| truncate_tail_chars(s.trim(), 1_500));

    let latest_reasoning = items_snapshot
        .iter()
        .rev()
        .find(|it| {
            it.get("kind").and_then(Value::as_str) == Some("reasoning")
                && it
                    .get("text")
                    .and_then(Value::as_str)
                    .is_some_and(|s| !s.trim().is_empty())
        })
        .and_then(|it| it.get("text").and_then(Value::as_str))
        .map(|s| truncate_tail_chars(s.trim(), 800));

    let tool_items: Vec<&Value> = items_snapshot
        .iter()
        .filter(|it| {
            matches!(
                it.get("kind").and_then(Value::as_str),
                Some("tool" | "command")
            )
        })
        .collect();
    let total_tools = tool_items.len();
    let recent_tools: Vec<String> = tool_items
        .into_iter()
        .rev()
        .take(5)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .map(|it| {
            let title = it
                .get("title")
                .or_else(|| it.get("toolName"))
                .or_else(|| it.get("command"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or("tool");
            let status = it
                .get("status")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or("running");
            let snippet = it
                .get("output")
                .or_else(|| it.get("text"))
                .or_else(|| it.get("detail"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| truncate_tail_chars(s, 600));
            match snippet {
                Some(s) => format!("- [{status}] {title}: {s}"),
                None => format!("- [{status}] {title}"),
            }
        })
        .collect();

    let mut sections = vec![
        "Status: working (subagent thread is actively running; final response not completed yet)."
            .to_string(),
    ];
    if let Some(reasoning) = latest_reasoning {
        sections.push(format!("Latest reasoning:\n{reasoning}"));
    }
    if let Some(assistant) = latest_assistant {
        sections.push(format!("Latest assistant excerpt:\n{assistant}"));
    }
    if !recent_tools.is_empty() {
        sections.push(format!(
            "Recent tool activity (last {} of {total_tools}):\n{}",
            recent_tools.len(),
            recent_tools.join("\n")
        ));
    }
    sections.push(
        "Call `kite_subagent_wait` to wait for completion rather than polling `kite_subagent_read`."
            .to_string(),
    );
    truncate_tail_chars(&sections.join("\n\n"), MAX_LIVE_SUMMARY_CHARS)
}

pub fn thread_tail(thread_id: &str) -> String {
    use crate::dispatch::mcp::truncate_tail_chars;

    let Some((failure_msg, lines)) = read_thread_with(thread_id, true, |thread| {
        let failure_msg = turn_failure_message(thread);
        let lines: Vec<String> = thread
            .get("items")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter(|item| {
                        let kind = item.get("kind").and_then(Value::as_str);
                        if matches!(kind, Some("notice" | "note")) {
                            return false;
                        }
                        if failure_msg.is_some() && kind == Some("user") {
                            return false;
                        }
                        true
                    })
                    .filter_map(|item| item.get("text").and_then(Value::as_str))
                    .map(str::trim)
                    .filter(|text| !text.is_empty())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        Some((failure_msg, lines))
    }) else {
        return String::new();
    };
    let body = lines.join("\n");
    let Some(msg) = failure_msg else {
        return truncate_tail_chars(&body, MAX_THREAD_TAIL_CHARS);
    };
    if body.is_empty() {
        return truncate_tail_chars(&msg, MAX_THREAD_TAIL_CHARS);
    }
    let bounded = truncate_tail_chars(&body, MAX_THREAD_TAIL_CHARS);
    if bounded.contains(&msg) {
        return bounded;
    }
    let msg_chars = msg.chars().count();
    if msg_chars >= MAX_THREAD_TAIL_CHARS {
        return truncate_tail_chars(&msg, MAX_THREAD_TAIL_CHARS);
    }
    let body_budget = MAX_THREAD_TAIL_CHARS.saturating_sub(msg_chars + 1);
    let trimmed_body = truncate_tail_chars(&body, body_budget);
    if trimmed_body.is_empty() {
        msg
    } else {
        format!("{trimmed_body}\n{msg}")
    }
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
        if let Some(thread_id) = resolve_or_wake_thread_for_profile(profile) {
            let _ = svc.attach(Family::Thread, &thread_id, None, None, false);
            let _ = svc.bind_agent(profile, &thread_id);
            publish_thread(svc, &thread_id);
        }
    }
}

pub fn publish_thread(svc: &mut Service<LivePort>, thread_id: &str) {
    let (state, kind) = thread_presence(thread_id);
    let address = format!("thread:{thread_id}");
    let _ = svc.publish_reported(&address, state, kind, next_publish_seq(), now_ms());
}

pub fn on_thread_started(thread_id: &str) {
    if thread_id.trim().is_empty() {
        return;
    }
    let tid = thread_id.to_string();
    with_service_ordered(move |svc| {
        publish_thread(svc, &tid);
    });
}

pub fn restore_parent_notices_for_active_children(parent_thread_id: &str) {
    if parent_thread_id.trim().is_empty() {
        return;
    }
    let parent_address = format!("thread:{parent_thread_id}");
    with_service_ordered(move |svc| {
        svc.restore_parent_notices_for_active_children(&parent_address);
    });
}

pub fn on_thread_settled(thread_id: &str) {
    if thread_id.trim().is_empty() {
        return;
    }
    // Non-reentrant callers synchronize on `service().lock()` so presence
    // transitions stay strictly ordered under concurrent subagent turns;
    // re-entrant calls from inside `LivePort` (`stop`/`interrupt`/`submit`)
    // defer to a worker thread to avoid same-thread self-deadlock.
    let tid = thread_id.to_string();
    with_service_ordered(move |svc| {
        publish_thread(svc, &tid);
    });
}

pub fn thread_presence(thread_id: &str) -> (PresenceState, Option<BlockKind>) {
    let persisted = read_thread_with(thread_id, false, |t| {
        let has_approval = t
            .get("pendingApproval")
            .map(|v| !v.is_null())
            .unwrap_or(false);
        let has_input = t
            .get("pendingUserInput")
            .map(|v| !v.is_null())
            .unwrap_or(false);
        let status = t
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let has_items = t
            .get("items")
            .and_then(Value::as_array)
            .is_some_and(|arr| !arr.is_empty())
            || (crate::persist::is_thread_stub(t)
                && (t
                    .get("hasContent")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                    || t.get("itemCount")
                        .and_then(Value::as_u64)
                        .unwrap_or(0)
                        > 0));
        Some((has_approval, has_input, status, has_items))
    });

    let live_running = crate::chat::is_turn_running(thread_id);
    let session_info = crate::chat::session_manager().lock().ok().and_then(|manager| {
        manager
            .status(thread_id)
            .map(|record| (record.state, !record.pending_approvals.is_empty()))
    });

    let approval_pending = persisted.as_ref().map(|p| p.0).unwrap_or(false)
        || session_info.map(|(_, pending)| pending).unwrap_or(false);
    if approval_pending {
        return (PresenceState::Blocked, Some(BlockKind::Permission));
    }

    if persisted.as_ref().map(|p| p.1).unwrap_or(false) {
        return (PresenceState::Blocked, Some(BlockKind::Question));
    }

    if session_info
        .map(|(state, _)| state == crate::chat::SessionState::Waiting)
        .unwrap_or(false)
        || persisted.as_ref().map(|p| p.2.as_str()) == Some("waiting")
    {
        return (PresenceState::Blocked, Some(BlockKind::Permission));
    }

    let session_state = session_info.map(|(state, _)| state);
    if live_running
        || matches!(
            session_state,
            Some(
                crate::chat::SessionState::Running
                    | crate::chat::SessionState::Starting
                    | crate::chat::SessionState::Resurrecting
            )
        )
    {
        return (PresenceState::Working, None);
    }

    if is_thread_killed(thread_id) {
        return (PresenceState::Gone, None);
    }

    if persisted.as_ref().map(|p| p.2.as_str()) == Some("running") {
        return (PresenceState::Working, None);
    }

    if persisted.as_ref().map(|p| p.2.as_str()) == Some("error") {
        return (PresenceState::Error, None);
    }

    if persisted.as_ref().map(|p| p.2.as_str()) == Some("idle")
        && persisted.as_ref().map(|p| p.3).unwrap_or(false)
    {
        return (PresenceState::Done, None);
    }

    if session_state == Some(crate::chat::SessionState::Completed) {
        return (PresenceState::Done, None);
    }

    if session_state == Some(crate::chat::SessionState::Failed) {
        return (PresenceState::Error, None);
    }

    (PresenceState::Idle, None)
}

fn is_eligible_profile_thread(thread: &Value, profile: &str) -> bool {
    if thread.get("profileId").and_then(Value::as_str) != Some(profile) {
        return false;
    }
    if thread.get("archivedAtUnixMs").and_then(Value::as_i64).is_some() {
        return false;
    }
    if thread.get("sideChat").and_then(Value::as_bool) == Some(true) {
        return false;
    }
    let started_by_agent = thread.get("startedByAgent").and_then(Value::as_bool) == Some(true);
    let has_parent = thread
        .get("parentThreadId")
        .and_then(Value::as_str)
        .is_some_and(|p| !p.trim().is_empty());
    !(started_by_agent && has_parent)
}

pub fn live_thread_for_profile(profile: &str) -> Option<String> {
    let candidate_ids: Vec<String> = if crate::persist::is_daemon_process() {
        crate::persist::list_threads_direct_summaries()
            .into_iter()
            .filter(|thread| is_eligible_profile_thread(thread, profile))
            .filter_map(|thread| thread.get("id").and_then(Value::as_str).map(ToString::to_string))
            .collect()
    } else {
        let items = crate::persist::threads().lock().ok()?;
        items
            .iter()
            .filter(|thread| is_eligible_profile_thread(thread, profile))
            .filter_map(|thread| thread.get("id").and_then(Value::as_str).map(ToString::to_string))
            .collect()
    };

    let manager = crate::chat::session_manager().lock().ok()?;
    for id in candidate_ids {
        if manager.status(&id).is_some() {
            return Some(id);
        }
    }
    None
}

fn persisted_thread_for_profile(profile: &str) -> Option<String> {
    let pick_best = |threads_slice: &[Value]| -> Option<String> {
        threads_slice
            .iter()
            .filter(|thread| is_eligible_profile_thread(thread, profile))
            .filter_map(|thread| {
                let id = thread.get("id").and_then(Value::as_str)?.to_string();
                let updated = thread
                    .get("updatedAtUnixMs")
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                let created = thread
                    .get("createdAtUnixMs")
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                Some(((updated, created), id))
            })
            .max_by_key(|(ts, _)| *ts)
            .map(|(_, id)| id)
    };
    if crate::persist::is_daemon_process() {
        let summaries = crate::persist::list_threads_direct_summaries();
        return pick_best(&summaries);
    }
    let items = crate::persist::threads().lock().ok()?;
    pick_best(&items)
}

fn resolve_workspace_for_agent(agent: &crate::persist::AgentProfile) -> Option<String> {
    if agent.place_display_names.is_empty() {
        return None;
    }
    let workspaces = crate::persist::list_workspaces_snapshot();
    for place in &agent.place_display_names {
        let trimmed = place.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Some(ws) = workspaces.iter().find(|ws| {
            ws.id == trimmed
                || ws.display_name == trimmed
                || ws.display_name.eq_ignore_ascii_case(trimmed)
        }) {
            return Some(ws.id.clone());
        }
    }
    None
}

fn create_canonical_thread_for_profile(profile: &str) -> Option<String> {
    let agent = crate::persist::find_agent_by_id(profile)?;
    let provider =
        crate::dispatch::cli::canonical_thread_provider(&agent.engine).unwrap_or("antigravity");
    let workspace_id = resolve_workspace_for_agent(&agent);
    let title = if agent.name.trim().is_empty() {
        "New Agent Chat".to_string()
    } else {
        agent.name.clone()
    };
    let mut thread =
        crate::chat::create_thread(Some(profile), &title, provider, workspace_id.as_deref());
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
        if let Some(effort) = agent
            .default_provider_options
            .iter()
            .find(|o| o.get("id").and_then(Value::as_str) == Some("effort"))
            .and_then(|o| o.get("value").and_then(Value::as_str))
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            thread["effort"] = json!(effort);
        }
    }
    let thread_id = thread
        .get("id")
        .and_then(Value::as_str)
        .map(ToString::to_string)?;
    crate::chat::replace_thread(&thread);
    Some(thread_id)
}

pub fn resolve_or_wake_thread_for_profile(profile: &str) -> Option<String> {
    live_thread_for_profile(profile)
        .or_else(|| persisted_thread_for_profile(profile))
        .or_else(|| create_canonical_thread_for_profile(profile))
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
    crate::persist::find_agent_by_id(profile)
        .and_then(|agent| agent.allow_agent_messaging)
        .unwrap_or(true)
}
