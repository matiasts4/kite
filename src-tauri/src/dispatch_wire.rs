//! Live ports and the loopback CLI. Policy stays in `dispatch` and does not import this file.

use std::collections::HashSet;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::Emitter;

use crate::dispatch::cli::{
    self, bad_token_receipt, check_token, offline_receipt, skill_text, ExecContext,
};
use crate::dispatch::policy::Service;
use crate::dispatch::port::{Port, StartRequest, Started, SubmitMeta};
use crate::dispatch::presence::{BlockKind, PresenceState};
use crate::dispatch::role::ensure_sample_role;
use crate::dispatch::types::{Caller, DispatchError, Family, PaneVisibility, Receipt};
use crate::dispatch::audit::{import_agent_messages, AuditRow};

static STOP: AtomicBool = AtomicBool::new(false);

struct LivePort;

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

fn emit_projectile(session_id: &str, text: &str, meta: &SubmitMeta) {
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

fn mark_pane_shown(session_id: &str) {
    let Ok(mut ids) = pane_ids().lock() else {
        return;
    };
    ids.insert(session_id.to_string());
    let _shown = ids.contains(session_id);
}

fn emit_open_pane(session_id: &str, engine: &str, alias: Option<&str>) {
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

fn terminal_tail(session_id: &str) -> String {
    crate::terminal::terminal_recent_text(session_id)
}

fn thread_tail(thread_id: &str) -> String {
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

fn service() -> &'static Mutex<Service<LivePort>> {
    static SERVICE: OnceLock<Mutex<Service<LivePort>>> = OnceLock::new();
    SERVICE.get_or_init(|| Mutex::new(Service::new(LivePort)))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn endpoint_path() -> PathBuf {
    crate::persist::roaming_app_dir().join("dispatch-endpoint.json")
}

fn import_marker() -> PathBuf {
    crate::persist::roaming_app_dir().join("dispatch-import.done")
}

pub fn start_background() {
    let _ = cli::install_kite_shim();
    let _ = cli::install_dispatch_skill();
    let _ = ensure_sample_role(&crate::persist::roaming_app_dir());
    let _ = import_historical();
    if STOP.swap(false, Ordering::SeqCst) {
        // A previous shutdown can be reversed when the window is opening.
    }
    let listener = match TcpListener::bind("127.0.0.1:0") {
        Ok(listener) => listener,
        Err(_) => return,
    };
    let port = match listener.local_addr() {
        Ok(addr) => addr.port(),
        Err(_) => return,
    };
    let token = uuid::Uuid::new_v4().to_string();
    let body = json!({ "token": token, "port": port });
    if let Some(parent) = endpoint_path().parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if std::fs::write(&endpoint_path(), serde_json::to_vec_pretty(&body).unwrap_or_default()).is_err()
    {
        return;
    }
    let _ = listener.set_nonblocking(true);
    thread::spawn(move || serve(listener, token));
}

pub fn shutdown() {
    STOP.store(true, Ordering::SeqCst);
    if let Ok(mut svc) = service().lock() {
        svc.set_online(false);
    }
    let _ = std::fs::remove_file(endpoint_path());
}

fn serve(listener: TcpListener, token: String) {
    while !STOP.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, _)) => {
                let token = token.clone();
                thread::spawn(move || handle_client(stream, &token));
            }
            Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(40));
            }
            Err(_) => break,
        }
    }
}

fn handle_client(stream: TcpStream, token: &str) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    if reader.read_line(&mut line).is_err() {
        return;
    }
    let request: Value = serde_json::from_str(line.trim()).unwrap_or(Value::Null);
    let presented = request.get("token").and_then(Value::as_str).unwrap_or("");
    let id = request
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("cli")
        .to_string();
    let response = if !check_token(token, presented) {
        bad_token_receipt(&id, "dispatch")
    } else if let Some(op) = request.get("op").and_then(Value::as_str) {
        direct_op(&request, op, &id)
    } else {
        let argv = request
            .get("argv")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(|s| s.to_string())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        match cli::parse_args(&argv) {
            Ok(cli::Command::Skill) => {
                let _ = write_response(&mut reader, &json!({ "skill": skill_text(), "exit": 0 }));
                return;
            }
            Ok(command) => {
                let response = execute_command(&request, &command, &id);
                if response.op == "programs" {
                    let text = response.text.clone().unwrap_or_default();
                    let _ = write_response(&mut reader, &json!({ "programs": text, "exit": 0 }));
                    return;
                }
                response
            }
            Err(_) => {
                let (code, body) = cli::render_result(Err(DispatchError::BadArgs), &id, "dispatch");
                let _ = write_response(&mut reader, &json!({ "exit": code, "receipt": serde_json::from_str::<Value>(&body).unwrap_or(Value::Null) }));
                return;
            }
        }
    };
    let exit = crate::dispatch::types::exit_code(&response);
    let _ = write_response(
        &mut reader,
        &json!({ "exit": exit, "receipt": response }),
    );
}

fn write_response(reader: &mut BufReader<TcpStream>, value: &Value) -> std::io::Result<()> {
    let stream = reader.get_mut();
    let bytes = serde_json::to_vec(value).unwrap_or_else(|_| b"{}".to_vec());
    stream.write_all(&bytes)?;
    stream.write_all(b"\n")?;
    stream.flush()
}

fn direct_op(request: &Value, op: &str, id: &str) -> Receipt {
    let address = request.get("address").and_then(Value::as_str).unwrap_or("");
    let mut guard = match service().lock() {
        Ok(guard) => guard,
        Err(poison) => poison.into_inner(),
    };
    if !guard_online(&guard) {
        return offline_receipt(id, op);
    }
    apply_switches(&mut guard, address);
    prepare(&mut guard, address, request.get("observed").and_then(Value::as_str));
    if let Some(alias) = request.get("alias").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
        if let Some(sid) = address.strip_prefix("session:") {
            let _ = guard.attach(Family::Terminal, sid, Some(alias), None, false);
        }
    }
    if let Some(engine) = request.get("engine").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
        if let Some(sid) = address.strip_prefix("session:") {
            let key = crate::dispatch::address::canonical(true, sid);
            guard.set_endpoint_engine(&key, engine);
        }
    }
    match op {
        "publish" => {
            let state = request.get("state").and_then(Value::as_str).unwrap_or("unknown");
            let seq = request.get("seq").and_then(Value::as_u64).unwrap_or_else(now_ms);
            let tail = request.get("tail").and_then(Value::as_str);
            let _ = guard.publish_pane(address, state, seq, now_ms(), tail, None);
            Receipt::new(id, "publish", crate::dispatch::ReceiptStatus::Settled, address, false, Some(state.into()), None)
        }
        "osc" => {
            let raw = request.get("raw").and_then(Value::as_str).unwrap_or("");
            let _ = guard.publish_osc(address, raw, now_ms());
            Receipt::new(id, "osc", crate::dispatch::ReceiptStatus::Settled, address, false, None, None)
        }
        _ => Receipt::new(
            id,
            op,
            crate::dispatch::ReceiptStatus::Rejected,
            address,
            false,
            None,
            Some(DispatchError::BadArgs.code().into()),
        ),
    }
}

fn execute_command(request: &Value, command: &cli::Command, id: &str) -> Receipt {
    let mut guard = match service().lock() {
        Ok(guard) => guard,
        Err(poison) => poison.into_inner(),
    };
    if !matches!(
        command,
        cli::Command::Skill | cli::Command::Ls | cli::Command::Programs
    ) && !online_flag(&guard)
    {
        return offline_receipt(id, "dispatch");
    }
    let address = match command {
        cli::Command::Send { address, .. } => address.clone(),
        cli::Command::Read { address, .. } => address.clone(),
        cli::Command::Wait { address, .. } => address.clone().unwrap_or_default(),
        cli::Command::Report { to, .. } => to.clone().unwrap_or_default(),
        cli::Command::Kill { address }
        | cli::Command::Interrupt { address }
        | cli::Command::Keys { address, .. }
        | cli::Command::Attach { address } => address.clone(),
        _ => request.get("address").and_then(Value::as_str).unwrap_or("").to_string(),
    };
    apply_switches(&mut guard, &address);
    let observed = request.get("observed").and_then(Value::as_str);
    prepare(&mut guard, &address, observed);
    let caller = caller_of(request);
    let from = request
        .get("from")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or(if caller == Caller::Human { "human" } else { "agent" });
    if crate::dispatch::address::is_caller_endpoint(from) {
        prepare(&mut guard, from, None);
    }
    let workspace = request.get("workspace").and_then(Value::as_str).map(PathBuf::from);
    let ctx = ExecContext {
        id,
        caller,
        from,
        now_ms: now_ms(),
        config_dir: Some(&crate::persist::roaming_app_dir()),
        workspace: workspace.as_deref(),
        mounted: request.get("mounted").and_then(Value::as_bool).unwrap_or(false),
    };
    // presentationAlreadyEmitted is honored by rewriting mounted sends through SendInput in execute.
    // The CLI execute path sets presentation from the command, not this flag.
    // A frontend send passes presentationEmitted so the port does not emit a second flight.
    let receipt = if let cli::Command::Send {
        address,
        body,
        file,
        force,
        only_ready,
        allow_queue,
    } = command
    {
        let input = crate::dispatch::SendInput {
            id: id.to_string(),
            address: address.clone(),
            body: body.clone().unwrap_or_default(),
            caller,
            force: *force,
            allow_queue: *allow_queue,
            only_ready: *only_ready,
            wrap: None,
            from: from.to_string(),
            mounted: ctx.mounted,
            source: request.get("source").and_then(Value::as_str).map(|s| s.to_string()),
            label: request.get("label").and_then(Value::as_str).map(|s| s.to_string()),
            now_ms: now_ms(),
            profile_id: request.get("profileId").and_then(Value::as_str).map(|s| s.to_string()),
            system: false,
            presentation_emitted: request
                .get("presentationEmitted")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        };
        let receipt = if let Some(path) = file {
            match workspace.as_deref() {
                Some(dir) => guard.send_file(input, dir, path),
                None => guard.send(input),
            }
        } else {
            guard.send(input)
        };
        receipt
    } else {
        match cli::execute(&mut guard, command, &ctx) {
            Ok(receipt) => receipt,
            Err(err) => Receipt::new(id, "dispatch", crate::dispatch::ReceiptStatus::Rejected, "", false, None, Some(err.code().into())),
        }
    };
    record_audit(&receipt, request.get("body").and_then(Value::as_str).unwrap_or(""), caller);
    receipt
}

fn guard_online(svc: &Service<LivePort>) -> bool {
    online_flag(svc)
}

fn online_flag(svc: &Service<LivePort>) -> bool {
    // Service keeps online private. A shutdown flips it and send returns runtime_offline.
    let _ = svc;
    !STOP.load(Ordering::SeqCst)
}

fn apply_switches(svc: &mut Service<LivePort>, address: &str) {
    let (enabled, read_only) = messaging_flags();
    svc.set_messaging(enabled, read_only);
    if let Some(profile) = address.strip_prefix("agent:") {
        svc.set_profile_messaging(profile, profile_allows(profile));
    }
}

fn prepare(svc: &mut Service<LivePort>, address: &str, observed: Option<&str>) {
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

fn publish_thread(svc: &mut Service<LivePort>, thread_id: &str) {
    let (state, kind) = thread_presence(thread_id);
    let address = format!("thread:{thread_id}");
    let _ = svc.publish_reported(&address, state, kind, now_ms(), now_ms());
}

fn thread_presence(thread_id: &str) -> (PresenceState, Option<BlockKind>) {
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

fn live_thread_for_profile(profile: &str) -> Option<String> {
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

fn caller_of(request: &Value) -> Caller {
    request
        .get("caller")
        .and_then(Value::as_str)
        .and_then(Caller::parse)
        .unwrap_or(Caller::Human)
}

fn messaging_flags() -> (bool, bool) {
    let pref = crate::agents::agent_messaging_preference();
    let enabled = pref.get("enabled").and_then(Value::as_bool).unwrap_or(true);
    let read_only = pref.get("readOnly").and_then(Value::as_bool).unwrap_or(false);
    (enabled, read_only)
}

fn profile_allows(profile: &str) -> bool {
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

fn record_audit(receipt: &Receipt, body: &str, caller: Caller) {
    if receipt.replayed {
        return;
    }
    let row = AuditRow {
        id: receipt.id.clone(),
        op: receipt.op.clone(),
        address: receipt.address.clone(),
        body: body.to_string(),
        status: format!("{:?}", receipt.status).to_lowercase(),
        submitted: receipt.submitted,
        historical: false,
        sender_name: match caller {
            Caller::Human => "Builder".into(),
            Caller::Agent => "Agent".into(),
            Caller::Script => "Script".into(),
        },
        profile_id: receipt
            .address
            .strip_prefix("agent:")
            .unwrap_or("")
            .to_string(),
        created_ms: now_ms(),
    };
    let _ = insert_audit(&row);
}

fn audit_db() -> Option<rusqlite::Connection> {
    let path = crate::persist::db_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let conn = rusqlite::Connection::open(path).ok()?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS dispatch_audit (
            id TEXT PRIMARY KEY,
            op TEXT NOT NULL,
            address TEXT NOT NULL,
            body TEXT NOT NULL,
            status TEXT NOT NULL,
            submitted INTEGER NOT NULL,
            historical INTEGER NOT NULL,
            sender_name TEXT NOT NULL,
            profile_id TEXT NOT NULL,
            error TEXT,
            created_ms INTEGER NOT NULL
        );",
    )
    .ok()?;
    Some(conn)
}

fn insert_audit(row: &AuditRow) -> Option<()> {
    let conn = audit_db()?;
    conn.execute(
        "INSERT OR IGNORE INTO dispatch_audit
         (id, op, address, body, status, submitted, historical, sender_name, profile_id, error, created_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?10)",
        rusqlite::params![
            row.id,
            row.op,
            row.address,
            row.body,
            row.status,
            row.submitted as i64,
            row.historical as i64,
            row.sender_name,
            row.profile_id,
            row.created_ms as i64,
        ],
    )
    .ok()?;
    Some(())
}

pub fn import_historical() -> bool {
    if import_marker().exists() {
        return true;
    }
    let path = crate::persist::roaming_app_dir().join("agent-messages.json");
    let Ok(bytes) = std::fs::read(&path) else {
        return false;
    };
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return false;
    };
    let rows = import_agent_messages(&value);
    let Some(conn) = audit_db() else {
        return false;
    };
    for row in &rows {
        let inserted = conn.execute(
            "INSERT OR IGNORE INTO dispatch_audit
             (id, op, address, body, status, submitted, historical, sender_name, profile_id, error, created_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, 0, 1, ?6, ?7, NULL, ?8)",
            rusqlite::params![
                row.id,
                row.op,
                row.address,
                row.body,
                row.status,
                row.sender_name,
                row.profile_id,
                row.created_ms as i64,
            ],
        );
        if inserted.is_err() {
            return false;
        }
    }
    let _ = std::fs::write(import_marker(), b"ok");
    let _ = path;
    true
}

pub fn inbox(profile_id: &str, before_seq: Option<u64>) -> Value {
    let _ = import_historical();
    let Some(conn) = audit_db() else {
        return json!({ "schemaVersion": 1, "profileId": profile_id, "messages": [], "nextCursor": null });
    };
    let mut stmt = match conn.prepare(
        "SELECT id, sender_name, body, status, submitted, historical, created_ms
         FROM dispatch_audit
         WHERE profile_id = ?1 OR address = ?2
         ORDER BY created_ms DESC
         LIMIT 40",
    ) {
        Ok(stmt) => stmt,
        Err(_) => {
            return json!({ "schemaVersion": 1, "profileId": profile_id, "messages": [], "nextCursor": null });
        }
    };
    let address = format!("agent:{profile_id}");
    let rows = stmt
        .query_map(rusqlite::params![profile_id, address], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
            ))
        })
        .ok();
    let mut messages = Vec::new();
    if let Some(rows) = rows {
        for row in rows.flatten() {
            let created = row.6 as u64;
            if let Some(before) = before_seq {
                if created >= before {
                    continue;
                }
            }
            let delivered = row.4 != 0 || row.5 != 0 || row.3 == "submitted" || row.3 == "historical";
            messages.push(json!({
                "id": row.0,
                "senderName": row.1,
                "body": row.2,
                "delivered": delivered,
                "status": if delivered { "submitted" } else { "queued" },
            }));
            if messages.len() == 20 {
                break;
            }
        }
    }
    json!({
        "schemaVersion": 1,
        "profileId": profile_id,
        "messages": messages,
        "nextCursor": null
    })
}

pub fn send_agent(
    recipient_id: &str,
    body: &str,
    caller: &str,
    sender_name: &str,
    id: Option<String>,
) -> Value {
    let id = id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let request = json!({
        "id": id,
        "caller": caller,
        "from": sender_name,
        "address": format!("agent:{recipient_id}"),
        "body": body,
        "profileId": recipient_id,
    });
    let command = cli::Command::Send {
        address: format!("agent:{recipient_id}"),
        body: Some(body.to_string()),
        file: None,
        force: false,
        only_ready: false,
        allow_queue: true,
    };
    let receipt = execute_command(&request, &command, &id);
    json!({
        "schemaVersion": 1,
        "delivered": receipt.submitted,
        "messageId": receipt.id,
        "status": receipt_status(&receipt),
        "error": receipt.error,
        "receipt": receipt,
    })
}

fn receipt_status(receipt: &Receipt) -> String {
    match receipt.status {
        crate::dispatch::ReceiptStatus::Queued => "queued",
        crate::dispatch::ReceiptStatus::Submitted => "submitted",
        crate::dispatch::ReceiptStatus::Rejected => "rejected",
        crate::dispatch::ReceiptStatus::Settled => "settled",
        crate::dispatch::ReceiptStatus::Failed => "failed",
        crate::dispatch::ReceiptStatus::Stalled => "stalled",
    }
    .into()
}

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

#[tauri::command]
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

#[tauri::command]
pub fn dispatch_publish(request: Option<Value>) -> Value {
    if let Some(res) = proxy_dispatch("publish", request.clone()) {
        return res;
    }
    let request = req_value(request);
    let id = "publish".to_string();
    serde_json::to_value(direct_op(&request, "publish", &id)).unwrap_or(Value::Null)
}

#[tauri::command]
pub fn dispatch_osc(request: Option<Value>) -> Value {
    if let Some(res) = proxy_dispatch("osc", request.clone()) {
        return res;
    }
    let request = req_value(request);
    serde_json::to_value(direct_op(&request, "osc", "osc")).unwrap_or(Value::Null)
}

#[tauri::command]
pub fn dispatch_ls(request: Option<Value>) -> Value {
    if let Some(res) = proxy_dispatch("ls", request.clone()) {
        return res;
    }
    let request = req_value(request);
    let id = request.get("id").and_then(Value::as_str).unwrap_or("ls");
    serde_json::to_value(execute_command(&request, &cli::Command::Ls, id)).unwrap_or(Value::Null)
}

#[tauri::command]
pub fn dispatch_run(request: Option<Value>) -> Value {
    if let Some(res) = proxy_dispatch("run", request.clone()) {
        return res;
    }
    let request = req_value(request);
    let id = request.get("id").and_then(Value::as_str).unwrap_or("run").to_string();
    let via = match request.get("via").and_then(Value::as_str) {
        Some("thread") => Family::Thread,
        _ => Family::Terminal,
    };
    let role = request.get("role").and_then(Value::as_str).map(|s| s.to_string());
    let explicit_role = role.is_some();
    let command = cli::Command::Run {
        via,
        engine: request.get("engine").and_then(Value::as_str).map(|s| s.to_string()),
        name: request.get("name").and_then(Value::as_str).map(|s| s.to_string()),
        parent: request.get("parent").and_then(Value::as_str).map(|s| s.to_string()),
        outlive: request.get("outlive").and_then(Value::as_bool).unwrap_or(false),
        role,
        explicit_role,
        file: request.get("file").and_then(Value::as_str).map(|s| s.to_string()),
        task: request.get("task").and_then(Value::as_str).map(|s| s.to_string()),
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

#[tauri::command]
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

#[tauri::command]
pub fn dispatch_read(request: Option<Value>) -> Value {
    if let Some(res) = proxy_dispatch("read", request.clone()) {
        return res;
    }
    let request = req_value(request);
    let id = request.get("id").and_then(Value::as_str).unwrap_or("read").to_string();
    let command = cli::Command::Read {
        address: request.get("address").and_then(Value::as_str).unwrap_or("").to_string(),
        lines: request.get("lines").and_then(Value::as_u64).unwrap_or(80) as usize,
    };
    serde_json::to_value(execute_command(&request, &command, &id)).unwrap_or(Value::Null)
}

#[tauri::command]
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

#[tauri::command]
pub fn dispatch_kill(request: Option<Value>) -> Value {
    dispatch_address_command("kill", request, |address, _| cli::Command::Kill { address })
}

#[tauri::command]
pub fn dispatch_interrupt(request: Option<Value>) -> Value {
    dispatch_address_command("interrupt", request, |address, _| cli::Command::Interrupt {
        address,
    })
}

#[tauri::command]
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

#[tauri::command]
pub fn dispatch_attach(request: Option<Value>) -> Value {
    dispatch_address_command("attach", request, |address, _| cli::Command::Attach { address })
}

#[tauri::command]
pub fn dispatch_skill() -> Value {
    json!({ "schemaVersion": 1, "text": skill_text() })
}

/// Records that a pane attached. Does not take the policy lock.
#[tauri::command]
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

fn attach_parent_console() {
    #[cfg(windows)]
    {
        #[link(name = "kernel32")]
        extern "system" {
            fn AttachConsole(dw_process_id: u32) -> i32;
        }
        const ATTACH_PARENT_PROCESS: u32 = 0xFFFFFFFF;
        unsafe {
            let _ = AttachConsole(ATTACH_PARENT_PROCESS);
        }
    }
}

fn emit_cli_line(text: &str) {
    let mut stdout = std::io::stdout();
    if writeln!(stdout, "{text}").is_ok() && stdout.flush().is_ok() {
        return;
    }
    #[cfg(windows)]
    {
        if let Ok(mut file) = std::fs::OpenOptions::new().write(true).open("CONOUT$") {
            let _ = writeln!(file, "{text}");
            let _ = file.flush();
        }
    }
}

fn receipt_still_waiting(value: &Value) -> bool {
    let receipt = value.get("receipt").unwrap_or(value);
    receipt.get("op").and_then(Value::as_str) == Some("wait")
        && receipt.get("status").and_then(Value::as_str) == Some("queued")
}

fn timeout_receipt(value: &Value) -> Value {
    let mut receipt = value.get("receipt").cloned().unwrap_or_else(|| json!({}));
    if let Some(obj) = receipt.as_object_mut() {
        obj.insert("status".to_string(), json!("failed"));
        obj.insert("error".to_string(), json!("timeout"));
        obj.insert("submitted".to_string(), json!(false));
    }
    receipt
}

fn dispatch_over_core_pipe(args: &[String]) -> Option<Value> {
    let caller = if std::env::var("KITE_DISPATCH").ok().as_deref() == Some("1") {
        "agent"
    } else {
        "human"
    };
    // The daemon parses the same argv the loopback endpoint accepts, so an
    // external script keeps dispatching while no GUI window is open (S5).
    let envelope = json!({
        "argv": args,
        "id": uuid::Uuid::new_v4().to_string(),
        "caller": caller,
        "from": std::env::var("KITE_ADDRESS").unwrap_or_default(),
        "workspace": std::env::current_dir().ok().map(|path| path.display().to_string()),
    });
    crate::core_daemon::send_core_daemon_rpc("agent.dispatch", Some(envelope)).ok()
}

/// Executes a full dispatch argv envelope, mirroring the loopback endpoint so a
/// daemon-owned core reaches its live PTYs over the pipe.
pub fn execute_argv_envelope(request: &Value) -> Value {
    let id = request
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("cli")
        .to_string();
    let argv: Vec<String> = request
        .get("argv")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();

    match cli::parse_args(&argv) {
        Ok(cli::Command::Skill) => json!({ "exit": 0, "skill": skill_text() }),
        Ok(command) => {
            let response = execute_command(request, &command, &id);
            if response.op == "programs" {
                return json!({
                    "exit": 0,
                    "programs": response.text.clone().unwrap_or_default(),
                });
            }
            let exit = crate::dispatch::types::exit_code(&response);
            json!({ "exit": exit, "receipt": response })
        }
        Err(_) => {
            let (code, body) = cli::render_result(Err(DispatchError::BadArgs), &id, "dispatch");
            json!({
                "exit": code,
                "receipt": serde_json::from_str::<Value>(&body).unwrap_or(Value::Null),
            })
        }
    }
}

fn loopback_cli_response(args: &[String]) -> Option<Value> {
    let path = endpoint_path();
    let bytes = std::fs::read(&path).ok()?;
    let file = serde_json::from_slice::<Value>(&bytes).ok()?;
    let port = file.get("port").and_then(Value::as_u64).unwrap_or(0) as u16;
    let token = file.get("token").and_then(Value::as_str).unwrap_or("");
    if port == 0 || token.is_empty() {
        return None;
    }
    let mut stream = TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}")
            .parse()
            .unwrap_or(std::net::SocketAddr::from(([127, 0, 0, 1], port))),
        Duration::from_millis(400),
    )
    .ok()?;
    let caller = if std::env::var("KITE_DISPATCH").ok().as_deref() == Some("1") {
        "agent"
    } else {
        "human"
    };
    let payload = json!({
        "token": token,
        "argv": args,
        "id": uuid::Uuid::new_v4().to_string(),
        "caller": caller,
        "from": std::env::var("KITE_ADDRESS").unwrap_or_default(),
        "workspace": std::env::current_dir().ok().map(|path| path.display().to_string()),
    });
    if stream.write_all(&serde_json::to_vec(&payload).unwrap_or_default()).is_err()
        || stream.write_all(b"\n").is_err()
    {
        return None;
    }
    let _ = stream.flush();
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    if reader.read_line(&mut line).is_err() {
        return None;
    }
    Some(serde_json::from_str(line.trim()).unwrap_or(Value::Null))
}

pub fn run_dispatch_cli(args: &[String]) -> i32 {
    attach_parent_console();
    let wait_for = cli::blocking_wait_ms(args);
    let started = std::time::Instant::now();
    loop {
        let response = loopback_cli_response(args).or_else(|| dispatch_over_core_pipe(args));
        let Some(value) = response else {
            emit_cli_line(
                &serde_json::to_string(&offline_receipt("cli", "dispatch")).unwrap_or_default(),
            );
            return 1;
        };
        if let Some(skill) = value.get("skill").and_then(Value::as_str) {
            emit_cli_line(skill);
            return 0;
        }
        if let Some(programs) = value.get("programs").and_then(Value::as_str) {
            emit_cli_line(programs);
            return 0;
        }
        if receipt_still_waiting(&value) {
            let timed_out = wait_for
                .map(|timeout_ms| started.elapsed() >= Duration::from_millis(timeout_ms))
                .unwrap_or(true);
            if timed_out {
                emit_cli_line(&serde_json::to_string(&timeout_receipt(&value)).unwrap_or_default());
                return 1;
            }
            thread::sleep(Duration::from_millis(200));
            continue;
        }
        if let Some(receipt) = value.get("receipt") {
            emit_cli_line(&serde_json::to_string(receipt).unwrap_or_default());
        } else {
            emit_cli_line(&value.to_string());
        }
        return value.get("exit").and_then(Value::as_i64).unwrap_or(1) as i32;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn submit_rejects_a_terminal_session_that_does_not_exist() {
        let mut port = LivePort;
        let meta = SubmitMeta {
            mounted: false,
            source: None,
            label: None,
            presentation_emitted: true,
        };
        let err = port
            .submit(
                Family::Terminal,
                "missing-dispatch-terminal",
                "hello",
                &meta,
            )
            .expect_err("a missing terminal must reject the dispatch");
        assert!(
            matches!(err, DispatchError::DestinationGone),
            "expected DestinationGone, got {err:?}"
        );
    }

    #[test]
    fn argv_envelope_runs_the_dispatch_command_path() {
        let argv: Vec<String> = ["kite", "dispatch", "ls"]
            .iter()
            .map(|part| (*part).to_string())
            .collect();
        let out = execute_argv_envelope(&json!({ "argv": argv, "id": "test-ls" }));
        assert!(out.get("exit").is_some(), "envelope must report an exit code");
        assert_eq!(out["receipt"]["op"], "ls");
    }

    #[test]
    fn a_queued_wait_is_still_waiting_until_it_times_out() {
        let queued = json!({ "exit": 0, "receipt": { "op": "wait", "status": "queued", "submitted": false } });
        assert!(receipt_still_waiting(&queued));
        let settled = json!({ "exit": 0, "receipt": { "op": "wait", "status": "settled" } });
        assert!(!receipt_still_waiting(&settled));
        let timed = timeout_receipt(&queued);
        assert_eq!(timed["status"], "failed");
        assert_eq!(timed["error"], "timeout");
        assert_eq!(timed["submitted"], false);
    }
}
