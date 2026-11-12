//! TCP background loopback server, CLI execution, and daemon integration.

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};

use crate::dispatch::cli::{
    self, bad_token_receipt, check_token, offline_receipt, skill_text, ExecContext,
};
use crate::dispatch::role::ensure_sample_role;
use crate::dispatch::types::{Caller, DispatchError, Family, Receipt};

use super::audit::{audit_db, import_historical, record_audit};
use super::protocol::{
    apply_switches, caller_of, endpoint_path, guard_online, now_ms, online_flag, prepare, service,
    STOP,
};

static GUI_STOP: AtomicBool = AtomicBool::new(false);
static GUI_BRIDGE_PORT: AtomicU16 = AtomicU16::new(0);

fn bind_dispatch_listener(
    endpoint_file: &Path,
    stop_flag: &'static AtomicBool,
    track_gui_port: bool,
) {
    let _ = cli::install_kite_shim();
    let _ = cli::install_dispatch_skill();
    let _ = ensure_sample_role(&crate::persist::roaming_app_dir());
    let _ = import_historical();
    stop_flag.store(false, Ordering::SeqCst);
    if let Ok(mut svc) = service().lock() {
        svc.set_online(true);
    }
    let listener = match TcpListener::bind("127.0.0.1:0") {
        Ok(listener) => listener,
        Err(_) => return,
    };
    let port = match listener.local_addr() {
        Ok(addr) => addr.port(),
        Err(_) => return,
    };
    if track_gui_port {
        GUI_BRIDGE_PORT.store(port, Ordering::SeqCst);
    }
    let token = uuid::Uuid::new_v4().to_string();
    let body = json!({
        "token": token,
        "port": port,
        "pid": std::process::id(),
    });
    if let Some(parent) = endpoint_file.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if std::fs::write(endpoint_file, serde_json::to_vec_pretty(&body).unwrap_or_default()).is_err() {
        if track_gui_port {
            GUI_BRIDGE_PORT.store(0, Ordering::SeqCst);
        }
        return;
    }
    let _ = listener.set_nonblocking(true);
    thread::spawn(move || serve(listener, token, stop_flag));
}

pub fn start_background() {
    bind_dispatch_listener(&endpoint_path(), &STOP, false);
}

/// Starts the GUI-local dispatch listener (`gui-dispatch-endpoint.json`) so Thread, Swarm,
/// and live model/provider discovery always execute inside the active GUI process holding
/// `persist::threads()`, ACP sessions, and the WebView event handle.
pub fn start_gui_background() {
    bind_dispatch_listener(&crate::dispatch::cli_wire::gui_endpoint_path(), &GUI_STOP, true);
}

pub fn shutdown() {
    STOP.store(true, Ordering::SeqCst);
    if let Ok(mut svc) = service().lock() {
        svc.set_online(false);
    }
    let _ = std::fs::remove_file(endpoint_path());
}

pub fn shutdown_gui_bridge() {
    GUI_STOP.store(true, Ordering::SeqCst);
    GUI_BRIDGE_PORT.store(0, Ordering::SeqCst);
    let path = crate::dispatch::cli_wire::gui_endpoint_path();
    let remove_allowed = match std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
    {
        Some(file) => match file.get("pid").and_then(Value::as_u64) {
            Some(pid) => pid == u64::from(std::process::id()),
            None => true,
        },
        None => false,
    };
    if remove_allowed {
        let _ = std::fs::remove_file(path);
    }
}

fn serve(listener: TcpListener, token: String, stop_flag: &'static AtomicBool) {
    while !stop_flag.load(Ordering::SeqCst) {
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

pub(crate) fn is_gui_action_payload(action: &str, payload: &Value) -> bool {
    if matches!(action, "swarm" | "providers" | "models") {
        return true;
    }
    if action == "run"
        && payload
            .get("via")
            .and_then(Value::as_str)
            .is_some_and(|v| v.eq_ignore_ascii_case("thread"))
    {
        return true;
    }
    for key in ["address", "to", "from", "parent"] {
        if payload
            .get(key)
            .and_then(Value::as_str)
            .is_some_and(|v| v.starts_with("thread:"))
        {
            return true;
        }
    }
    payload.get("children").and_then(Value::as_str).is_some()
}

pub(crate) fn request_targets_gui(request: &Value) -> bool {
    if let Some(arr) = request.get("argv").and_then(Value::as_array) {
        let argv: Vec<String> = arr
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect();
        return crate::dispatch::cli_wire::should_prefer_gui_endpoint(
            &argv,
            request.get("from").and_then(Value::as_str),
        );
    }
    if let Some(op) = request
        .get("action")
        .or_else(|| request.get("op"))
        .and_then(Value::as_str)
    {
        return is_gui_action_payload(op, request);
    }
    false
}

pub(crate) fn try_forward_to_gui_bridge_at(path: &Path, request: &Value) -> Option<Value> {
    if !request_targets_gui(request) {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    let endpoint = serde_json::from_slice::<Value>(&bytes).ok()?;
    let port = endpoint.get("port").and_then(Value::as_u64).unwrap_or(0) as u16;
    let token = endpoint.get("token").and_then(Value::as_str).unwrap_or("");
    if port == 0 || token.is_empty() {
        return None;
    }
    let addr = format!("127.0.0.1:{port}")
        .parse()
        .unwrap_or(std::net::SocketAddr::from(([127, 0, 0, 1], port)));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(400)).ok()?;
    let mut forwarded = request.clone();
    if let Some(obj) = forwarded.as_object_mut() {
        obj.insert("token".to_string(), json!(token));
    } else {
        forwarded = json!({ "token": token });
    }
    if stream
        .write_all(&serde_json::to_vec(&forwarded).unwrap_or_default())
        .is_err()
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
    serde_json::from_str(line.trim()).ok()
}

pub fn try_forward_to_gui_bridge(request: &Value) -> Option<Value> {
    if cfg!(test) || GUI_BRIDGE_PORT.load(Ordering::SeqCst) != 0 {
        return None;
    }
    try_forward_to_gui_bridge_at(&crate::dispatch::cli_wire::gui_endpoint_path(), request)
}

fn lookup_thread_provider(from: &str) -> Option<String> {
    let tid = from.strip_prefix("thread:").unwrap_or(from).trim();
    if tid.is_empty() {
        return None;
    }
    let all = crate::persist::threads().lock().ok()?;
    all.iter()
        .find(|t| t.get("id").and_then(Value::as_str) == Some(tid))
        .and_then(|t| {
            t.get("provider")
                .or_else(|| t.get("engine"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
}

fn lookup_swarm_member_provider(from: &str, member_name: &str) -> Option<String> {
    if member_name.eq_ignore_ascii_case("coordinator") {
        return lookup_thread_provider(from);
    }
    let tid = from.strip_prefix("thread:").unwrap_or(from).trim();
    if tid.is_empty() {
        return None;
    }
    let all = crate::persist::threads().lock().ok()?;
    let coord = all
        .iter()
        .find(|t| t.get("id").and_then(Value::as_str) == Some(tid))?;
    coord
        .get("swarmState")
        .and_then(|s| s.get("members"))
        .and_then(Value::as_array)?
        .iter()
        .find(|m| {
            m.get("name")
                .and_then(Value::as_str)
                .is_some_and(|n| n.eq_ignore_ascii_case(member_name))
        })
        .and_then(|m| m.get("provider").and_then(Value::as_str).map(str::to_string))
}

fn validate_live_command_models(request: &Value, command: &cli::Command) -> Result<(), String> {
    let from = request.get("from").and_then(Value::as_str).unwrap_or("");
    match command {
        cli::Command::Run {
            via,
            explicit_via,
            engine,
            provider,
            model,
            explicit_role,
            program,
            ..
        } => {
            let effective_via = if *explicit_via {
                *via
            } else if from.starts_with("thread:") {
                Family::Thread
            } else {
                *via
            };
            if effective_via != Family::Thread {
                return Ok(());
            }
            let mut explicit_provider = provider.clone().or_else(|| engine.clone());
            if let Some(word) = program {
                if !*explicit_role && explicit_provider.is_none() {
                    if let Some(canon) = cli::canonical_thread_provider(word) {
                        explicit_provider = Some(canon.to_string());
                    }
                }
            }
            if let Some(ref p) = explicit_provider {
                crate::chat::models::validate_provider_connection(p)?;
            }
            let effective_provider = explicit_provider.or_else(|| lookup_thread_provider(from));
            if let Some(ref m) = model {
                if let Some(ref p) = effective_provider {
                    crate::chat::models::validate_provider_model_selection(p, m)?;
                } else if !crate::chat::models::model_id_ok(m) {
                    return Err(format!("Invalid model id `{m}`."));
                }
            }
        }
        cli::Command::Swarm(cli::SwarmCommand::Add {
            provider, model, ..
        }) => {
            if let Some(ref p) = provider {
                crate::chat::models::validate_provider_connection(p)?;
            }
            let effective_provider = provider.clone().or_else(|| lookup_thread_provider(from));
            if let Some(ref m) = model {
                if let Some(ref p) = effective_provider {
                    crate::chat::models::validate_provider_model_selection(p, m)?;
                } else if !crate::chat::models::model_id_ok(m) {
                    return Err(format!("Invalid model id `{m}`."));
                }
            }
        }
        cli::Command::Swarm(cli::SwarmCommand::Model {
            name,
            provider,
            model,
            ..
        }) => {
            if let Some(ref p) = provider {
                crate::chat::models::validate_provider_connection(p)?;
            }
            let effective_provider = provider
                .clone()
                .or_else(|| lookup_swarm_member_provider(from, name))
                .or_else(|| lookup_thread_provider(from));
            if let Some(ref p) = effective_provider {
                crate::chat::models::validate_provider_model_selection(p, model)?;
            } else if !crate::chat::models::model_id_ok(model) {
                return Err(format!("Invalid model id `{model}`."));
            }
        }
        _ => {}
    }
    Ok(())
}

fn execute_argv_dispatch(request: &Value, id: &str, argv: &[String]) -> Value {
    match cli::parse_args_detailed(argv) {
        Ok(cli::Command::Skill) => json!({ "skill": skill_text(), "exit": 0 }),
        Ok(cli::Command::Providers { refresh }) => {
            let discovery = crate::chat::models::discover_thread_providers(refresh);
            let text = crate::chat::models::format_providers_text(&discovery);
            json!({ "exit": 0, "textOut": text, "providers": discovery })
        }
        Ok(cli::Command::Models { provider, refresh }) => {
            if let Some(prov) = provider {
                let catalog = crate::chat::models::provider_models(&prov, refresh);
                let text = crate::chat::models::format_models_text(&catalog);
                json!({ "exit": 0, "textOut": text, "models": catalog })
            } else {
                let mut sections = Vec::new();
                for prov in crate::chat::models::THREAD_PROVIDERS {
                    let catalog = crate::chat::models::provider_models(prov, refresh);
                    sections.push(crate::chat::models::format_models_text(&catalog));
                }
                json!({ "exit": 0, "textOut": sections.join("\n\n") })
            }
        }
        Ok(command) => {
            let online = service()
                .lock()
                .map(|g| online_flag(&g))
                .unwrap_or(false);
            if online {
                if let Err(detail) = validate_live_command_models(request, &command) {
                    let (code, receipt) =
                        cli::render_detailed_error(id, "dispatch", DispatchError::BadArgs, &detail);
                    return json!({ "exit": code, "receipt": receipt });
                }
            }
            let response = match command {
                cli::Command::Swarm(ref swarm_cmd) => execute_swarm_command(request, id, swarm_cmd),
                _ => execute_command(request, &command, id),
            };
            if response.op == "programs" {
                return json!({
                    "programs": response.text.clone().unwrap_or_default(),
                    "exit": 0,
                });
            }
            let exit = crate::dispatch::types::exit_code(&response);
            json!({ "exit": exit, "receipt": response })
        }
        Err((err, detail)) => {
            let (code, receipt) = cli::render_detailed_error(id, "dispatch", err, &detail);
            json!({ "exit": code, "receipt": receipt })
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
    } else if let Some(forwarded) = try_forward_to_gui_bridge(&request) {
        let _ = write_response(&mut reader, &forwarded);
        return;
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
        let envelope = execute_argv_dispatch(&request, &id, &argv);
        let _ = write_response(&mut reader, &envelope);
        return;
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

pub fn direct_op(request: &Value, op: &str, id: &str) -> Receipt {
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

pub fn execute_swarm_command(
    request: &Value,
    id: &str,
    swarm_cmd: &cli::SwarmCommand,
) -> Receipt {
    {
        let guard = match service().lock() {
            Ok(guard) => guard,
            Err(poison) => poison.into_inner(),
        };
        if !online_flag(&guard) {
            return offline_receipt(id, "swarm");
        }
    }
    let caller = caller_of(request);
    let from = request
        .get("from")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or(if caller == Caller::Human { "human" } else { "agent" });
    let cwd = request.get("workspace").and_then(Value::as_str);
    match crate::chat::swarm::execute_swarm_action(swarm_cmd, from, cwd, None) {
        Ok(text) => {
            let mut receipt = Receipt::new(
                id,
                "swarm",
                crate::dispatch::ReceiptStatus::Settled,
                from,
                false,
                None,
                None,
            );
            receipt.text = Some(text);
            receipt
        }
        Err(err) => Receipt::new(
            id,
            "swarm",
            crate::dispatch::ReceiptStatus::Rejected,
            from,
            false,
            None,
            Some(err.code().into()),
        ),
    }
}

pub fn execute_command(request: &Value, command: &cli::Command, id: &str) -> Receipt {
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

pub use crate::dispatch::cli_wire::{receipt_still_waiting, timeout_receipt};

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
    if let Some(forwarded) = try_forward_to_gui_bridge(request) {
        return forwarded;
    }
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
    execute_argv_dispatch(request, &id, &argv)
}

pub fn run_dispatch_cli(args: &[String]) -> i32 {
    attach_parent_console();
    crate::dispatch::cli_wire::run_cli(args, Some(&dispatch_over_core_pipe))
}
