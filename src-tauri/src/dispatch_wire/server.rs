//! TCP background loopback server, CLI execution, and daemon integration.

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
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

pub fn receipt_still_waiting(value: &Value) -> bool {
    let receipt = value.get("receipt").unwrap_or(value);
    receipt.get("op").and_then(Value::as_str) == Some("wait")
        && receipt.get("status").and_then(Value::as_str) == Some("queued")
}

pub fn timeout_receipt(value: &Value) -> Value {
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
