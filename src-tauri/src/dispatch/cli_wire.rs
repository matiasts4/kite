//! Shared dependency-free dispatch CLI wire helpers used by both the `kite`
//! console binary (`SUBSYSTEM:CONSOLE`) and `kite-code` loopback CLI fallback.

use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};

pub fn app_data_folder() -> &'static str {
    if cfg!(debug_assertions) {
        "Kite Code Dev"
    } else {
        "Kite Code"
    }
}

pub fn roaming_app_dir() -> PathBuf {
    let base = std::env::var("APPDATA").unwrap_or_else(|_| r"C:\Users\PC\AppData\Roaming".into());
    PathBuf::from(base).join(app_data_folder())
}

pub fn endpoint_path() -> PathBuf {
    roaming_app_dir().join("dispatch-endpoint.json")
}

pub fn gui_endpoint_path() -> PathBuf {
    roaming_app_dir().join("gui-dispatch-endpoint.json")
}

pub fn offline_receipt_json(id: &str, op: &str) -> Value {
    json!({
        "schemaVersion": 1,
        "id": id,
        "op": op,
        "status": "failed",
        "address": "",
        "submitted": false,
        "error": "runtime_offline"
    })
}

pub fn format_subagent_wait_output(response_text: &str, child_thread_id: &str) -> String {
    let trimmed = response_text.trim();
    if trimmed.is_empty() {
        format!("[subagent_id: thread:{child_thread_id}]")
    } else {
        format!("{trimmed}\n\n[subagent_id: thread:{child_thread_id}]")
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

#[cfg(windows)]
fn try_write_win32_handle(bytes: &[u8], include_char: bool) -> bool {
    const STD_OUTPUT_HANDLE: u32 = 0xFFFF_FFF5u32;
    const FILE_TYPE_DISK: u32 = 0x0001;
    const FILE_TYPE_CHAR: u32 = 0x0002;
    const FILE_TYPE_PIPE: u32 = 0x0003;

    extern "system" {
        fn GetStdHandle(nStdHandle: u32) -> *mut core::ffi::c_void;
        fn GetFileType(hFile: *mut core::ffi::c_void) -> u32;
        fn WriteFile(
            hFile: *mut core::ffi::c_void,
            lpBuffer: *const u8,
            nNumberOfBytesToWrite: u32,
            lpNumberOfBytesWritten: *mut u32,
            lpOverlapped: *mut core::ffi::c_void,
        ) -> i32;
    }

    unsafe {
        let handle = GetStdHandle(STD_OUTPUT_HANDLE);
        if handle.is_null() || handle as isize == -1 {
            return false;
        }
        let ftype = GetFileType(handle);
        let supported = ftype == FILE_TYPE_DISK
            || ftype == FILE_TYPE_PIPE
            || (include_char && ftype == FILE_TYPE_CHAR);
        if !supported {
            return false;
        }
        let mut total_written = 0usize;
        while total_written < bytes.len() {
            let chunk = &bytes[total_written..];
            let len = chunk.len().min(u32::MAX as usize) as u32;
            let mut written: u32 = 0;
            let ok = WriteFile(
                handle,
                chunk.as_ptr(),
                len,
                &mut written,
                core::ptr::null_mut(),
            );
            if ok == 0 || written == 0 {
                return false;
            }
            total_written += written as usize;
        }
        true
    }
}

pub fn emit_cli_line(text: &str) {
    #[cfg(windows)]
    {
        let mut line = String::with_capacity(text.len() + 1);
        line.push_str(text);
        line.push('\n');
        // Prefer raw Win32 handle when stdout is redirected to a pipe or disk file,
        // bypassing SUBSYSTEM:WINDOWS CRT stdout buffering edge cases.
        if try_write_win32_handle(line.as_bytes(), false) {
            return;
        }
    }

    let mut stdout = std::io::stdout();
    if writeln!(stdout, "{text}").is_ok() && stdout.flush().is_ok() {
        return;
    }

    #[cfg(windows)]
    {
        let mut line = String::with_capacity(text.len() + 1);
        line.push_str(text);
        line.push('\n');
        if try_write_win32_handle(line.as_bytes(), true) {
            return;
        }
        if let Ok(mut file) = std::fs::OpenOptions::new().write(true).open("CONOUT$") {
            let _ = writeln!(file, "{text}");
            let _ = file.flush();
        }
    }
}

fn flag_value<'a>(tokens: &'a [&'a str], flag: &str) -> Option<&'a str> {
    let mut i = 0;
    while i < tokens.len() {
        let tok = tokens[i];
        if tok == "--" {
            break;
        }
        if tok == flag {
            return tokens.get(i + 1).copied();
        }
        if let Some(rest) = tok.strip_prefix(flag).and_then(|r| r.strip_prefix('=')) {
            return Some(rest);
        }
        i += 1;
    }
    None
}

fn has_flag(tokens: &[&str], flag: &str) -> bool {
    for &tok in tokens {
        if tok == "--" {
            break;
        }
        if tok == flag || tok.starts_with(&format!("{flag}=")) {
            return true;
        }
    }
    false
}

fn strip_cli_prefix(args: &[String]) -> &[String] {
    let mut start = 0usize;
    if args.get(start).map(String::as_str) == Some("kite") {
        start += 1;
    }
    if args.get(start).map(String::as_str) == Some("dispatch") {
        start += 1;
    }
    &args[start..]
}

pub fn blocking_wait_ms(args: &[String]) -> Option<u64> {
    let slice = strip_cli_prefix(args);
    if slice.first().map(String::as_str) != Some("wait") {
        return None;
    }
    let tokens: Vec<&str> = slice[1..].iter().map(String::as_str).collect();
    let timeout = flag_value(&tokens, "--timeout")
        .or_else(|| flag_value(&tokens, "--timeout-ms"))
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(30_000);
    Some(timeout)
}

pub fn blocking_run_wait_ms(args: &[String]) -> Option<u64> {
    let slice = strip_cli_prefix(args);
    if slice.first().map(String::as_str) != Some("run") {
        return None;
    }
    let tokens: Vec<&str> = slice[1..].iter().map(String::as_str).collect();
    if !has_flag(&tokens, "--wait") {
        return None;
    }
    let timeout = flag_value(&tokens, "--timeout-ms")
        .or_else(|| flag_value(&tokens, "--timeout"))
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(300_000);
    Some(timeout)
}

pub fn should_prefer_gui_endpoint(args: &[String], kite_address_env: Option<&str>) -> bool {
    let slice = strip_cli_prefix(args);
    let Some(sub) = slice.first().map(String::as_str) else {
        return false;
    };
    let rest: Vec<&str> = slice[1..].iter().map(String::as_str).collect();
    let from_thread = kite_address_env
        .map(str::trim)
        .is_some_and(|v| v.starts_with("thread:"));

    match sub {
        "swarm" | "providers" | "models" => true,
        "run" => {
            if let Some(via) = flag_value(&rest, "--via") {
                return via.eq_ignore_ascii_case("thread");
            }
            from_thread
        }
        "send" | "read" | "kill" | "interrupt" | "attach" => {
            rest.iter().any(|tok| tok.starts_with("thread:"))
        }
        "wait" => {
            rest.iter().any(|tok| tok.starts_with("thread:"))
                || has_flag(&rest, "--children")
                || (from_thread && !rest.iter().any(|tok| !tok.starts_with('-')))
        }
        "report" => {
            flag_value(&rest, "--to").is_some_and(|v| v.starts_with("thread:")) || from_thread
        }
        _ => false,
    }
}

pub fn loopback_cli_response_from_file(path: &Path, args: &[String]) -> Option<Value> {
    let bytes = std::fs::read(path).ok()?;
    let file = serde_json::from_slice::<Value>(&bytes).ok()?;
    let port = file.get("port").and_then(Value::as_u64).unwrap_or(0) as u16;
    let token = file.get("token").and_then(Value::as_str).unwrap_or("");
    if port == 0 || token.is_empty() {
        return None;
    }
    let addr = format!("127.0.0.1:{port}")
        .parse()
        .unwrap_or(std::net::SocketAddr::from(([127, 0, 0, 1], port)));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(400)).ok()?;
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
        "workspace": std::env::current_dir().ok().map(|p| p.display().to_string()),
    });
    if stream
        .write_all(&serde_json::to_vec(&payload).unwrap_or_default())
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
    Some(serde_json::from_str(line.trim()).unwrap_or(Value::Null))
}

pub fn loopback_cli_response(args: &[String]) -> Option<Value> {
    let kite_address = std::env::var("KITE_ADDRESS").ok();
    let prefer_gui = should_prefer_gui_endpoint(args, kite_address.as_deref());
    let endpoints = if prefer_gui {
        [gui_endpoint_path(), endpoint_path()]
    } else {
        [endpoint_path(), gui_endpoint_path()]
    };
    for path in endpoints {
        if let Some(resp) = loopback_cli_response_from_file(&path, args) {
            return Some(resp);
        }
    }
    None
}

fn emit_receipt_or_value(value: &Value) {
    if let Some(receipt) = value.get("receipt") {
        emit_cli_line(&serde_json::to_string(receipt).unwrap_or_default());
    } else {
        emit_cli_line(&value.to_string());
    }
}

fn query_dispatch<'a>(
    args: &[String],
    fallback: Option<&'a dyn Fn(&[String]) -> Option<Value>>,
) -> Option<Value> {
    loopback_cli_response(args).or_else(|| fallback.and_then(|f| f(args)))
}

fn run_blocking_subagent_dispatch<'a>(
    args: &[String],
    wait_timeout_ms: u64,
    fallback: Option<&'a dyn Fn(&[String]) -> Option<Value>>,
) -> i32 {
    let Some(value) = query_dispatch(args, fallback) else {
        emit_cli_line(&offline_receipt_json("cli", "dispatch").to_string());
        return 1;
    };
    let run_exit = value.get("exit").and_then(Value::as_i64).unwrap_or(1) as i32;
    let child_address = value
        .get("receipt")
        .and_then(|r| r.get("address"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if run_exit != 0 || !child_address.starts_with("thread:") {
        emit_receipt_or_value(&value);
        return run_exit;
    }

    let started = std::time::Instant::now();
    let wait_args = vec![
        "kite".to_string(),
        "dispatch".to_string(),
        "wait".to_string(),
        child_address.clone(),
        "--until".to_string(),
        "done,error,gone,blocked".to_string(),
        "--timeout".to_string(),
        wait_timeout_ms.to_string(),
    ];
    let settled_presence;
    loop {
        let Some(wait_val) = query_dispatch(&wait_args, fallback) else {
            emit_cli_line(&offline_receipt_json("cli", "dispatch").to_string());
            return 1;
        };
        if receipt_still_waiting(&wait_val) {
            if started.elapsed() >= Duration::from_millis(wait_timeout_ms) {
                emit_cli_line(&timeout_receipt(&wait_val).to_string());
                return 1;
            }
            std::thread::sleep(Duration::from_millis(200));
            continue;
        }
        let wait_exit = wait_val.get("exit").and_then(Value::as_i64).unwrap_or(1) as i32;
        if wait_exit != 0 {
            emit_receipt_or_value(&wait_val);
            return wait_exit;
        }
        settled_presence = wait_val
            .get("receipt")
            .and_then(|r| r.get("presenceAtSubmit"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        break;
    }

    let read_args = vec![
        "kite".to_string(),
        "dispatch".to_string(),
        "read".to_string(),
        child_address.clone(),
        "--last".to_string(),
    ];
    let read_val = query_dispatch(&read_args, fallback);
    let final_text = read_val
        .as_ref()
        .and_then(|v| v.get("receipt"))
        .and_then(|r| r.get("text"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if matches!(settled_presence.as_str(), "error" | "gone" | "blocked") {
        let failure = json!({
            "schemaVersion": 1,
            "id": "run",
            "op": "run",
            "status": "failed",
            "address": child_address,
            "submitted": true,
            "presenceAtSubmit": settled_presence,
            "error": format!("subagent_{settled_presence}"),
            "text": final_text,
        });
        emit_cli_line(&failure.to_string());
        return 1;
    }
    let child_id = child_address.strip_prefix("thread:").unwrap_or(&child_address);
    let formatted = format_subagent_wait_output(final_text, child_id);
    emit_cli_line(&formatted);
    0
}

pub fn run_cli<'a>(
    args: &[String],
    fallback: Option<&'a dyn Fn(&[String]) -> Option<Value>>,
) -> i32 {
    if let Some(wait_timeout_ms) = blocking_run_wait_ms(args) {
        return run_blocking_subagent_dispatch(args, wait_timeout_ms, fallback);
    }
    let wait_for = blocking_wait_ms(args);
    let started = std::time::Instant::now();
    loop {
        let Some(value) = query_dispatch(args, fallback) else {
            emit_cli_line(&offline_receipt_json("cli", "dispatch").to_string());
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
        if let Some(text_out) = value.get("textOut").and_then(Value::as_str) {
            emit_cli_line(text_out);
            return value.get("exit").and_then(Value::as_i64).unwrap_or(0) as i32;
        }
        if receipt_still_waiting(&value) {
            let timed_out = wait_for
                .map(|timeout_ms| started.elapsed() >= Duration::from_millis(timeout_ms))
                .unwrap_or(true);
            if timed_out {
                emit_cli_line(&timeout_receipt(&value).to_string());
                return 1;
            }
            std::thread::sleep(Duration::from_millis(200));
            continue;
        }
        emit_receipt_or_value(&value);
        return value.get("exit").and_then(Value::as_i64).unwrap_or(1) as i32;
    }
}
