//! Shared dependency-free dispatch CLI wire helpers used by both the `kite`
//! console binary (`SUBSYSTEM:CONSOLE`) and `kite-code` loopback CLI fallback.

use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};

#[path = "hook.rs"]
pub mod hook;
#[path = "mcp.rs"]
pub mod mcp;

pub fn app_data_folder() -> &'static str {
    if cfg!(debug_assertions) {
        "Kite Code Dev"
    } else {
        "Kite Code"
    }
}

pub fn roaming_app_dir() -> PathBuf {
    let base = std::env::var("APPDATA")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            std::env::var("USERPROFILE")
                .or_else(|_| std::env::var("HOME"))
                .ok()
                .filter(|v| !v.trim().is_empty())
                .map(|home| PathBuf::from(home).join("AppData").join("Roaming"))
                .unwrap_or_else(|| std::env::temp_dir().join("kite-appdata"))
        });
    base.join(app_data_folder())
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

fn last_timeout_flag_ms(tokens: &[&str]) -> Option<u64> {
    let mut last: Option<u64> = None;
    let mut i = 0;
    while i < tokens.len() {
        let tok = tokens[i];
        if tok == "--" {
            break;
        }
        if tok == "--timeout" || tok == "--timeout-ms" {
            if let Some(raw) = tokens.get(i + 1) {
                if let Ok(ms) = raw.parse::<u64>() {
                    last = Some(ms);
                }
            }
            i += 2;
            continue;
        }
        if let Some(raw) = tok
            .strip_prefix("--timeout-ms=")
            .or_else(|| tok.strip_prefix("--timeout="))
        {
            if let Ok(ms) = raw.parse::<u64>() {
                last = Some(ms);
            }
        }
        i += 1;
    }
    last
}

pub fn blocking_wait_ms(args: &[String]) -> Option<u64> {
    let slice = strip_cli_prefix(args);
    if slice.first().map(String::as_str) != Some("wait") {
        return None;
    }
    let tokens: Vec<&str> = slice[1..].iter().map(String::as_str).collect();
    Some(last_timeout_flag_ms(&tokens).unwrap_or(30_000))
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
    Some(last_timeout_flag_ms(&tokens).unwrap_or(300_000))
}

pub fn blocking_send_wait_ms(args: &[String]) -> Option<u64> {
    let slice = strip_cli_prefix(args);
    if slice.first().map(String::as_str) != Some("send") {
        return None;
    }
    let tokens: Vec<&str> = slice[1..].iter().map(String::as_str).collect();
    if !has_flag(&tokens, "--wait") {
        return None;
    }
    if !tokens.iter().any(|tok| tok.starts_with("thread:")) {
        return None;
    }
    Some(last_timeout_flag_ms(&tokens).unwrap_or(300_000))
}

fn strip_send_wait_flags(args: &[String]) -> Vec<String> {
    let slice = strip_cli_prefix(args);
    if slice.first().map(String::as_str) != Some("send") {
        return args.to_vec();
    }
    let mut out = Vec::with_capacity(args.len());
    let mut i = 0;
    let mut past_double_dash = false;
    while i < args.len() {
        let tok = args[i].as_str();
        if tok == "--" {
            past_double_dash = true;
            out.push(args[i].clone());
            i += 1;
            continue;
        }
        if !past_double_dash {
            if tok == "--wait" || tok.starts_with("--wait=") {
                i += 1;
                continue;
            }
            if tok == "--timeout-ms" || tok == "--timeout" {
                i += 2;
                continue;
            }
            if tok.starts_with("--timeout-ms=") || tok.starts_with("--timeout=") {
                i += 1;
                continue;
            }
        }
        out.push(args[i].clone());
        i += 1;
    }
    out
}

pub fn extract_spawned_thread_addresses(value: &Value) -> Vec<String> {
    let receipt = value.get("receipt").unwrap_or(value);
    let mut out: Vec<String> = Vec::new();
    let mut push_from_raw = |raw: &str| {
        for part in raw.split(|c: char| {
            c.is_whitespace() || matches!(c, ',' | '[' | ']' | '(' | ')' | ';')
        }) {
            let tok = part.trim();
            if tok.starts_with("thread:") && tok.len() > "thread:".len() {
                let s = tok.to_string();
                if !out.contains(&s) {
                    out.push(s);
                }
            }
        }
    };
    if let Some(text) = receipt.get("text").and_then(Value::as_str) {
        if text.contains("thread:") {
            push_from_raw(text);
        }
    }
    if let Some(addr) = receipt.get("address").and_then(Value::as_str) {
        if addr.contains("thread:") {
            push_from_raw(addr);
        }
    }
    out
}

pub fn should_prefer_gui_endpoint(args: &[String], kite_address_env: Option<&str>) -> bool {
    should_prefer_gui_endpoint_with_thread_mode(args, kite_address_env, false)
}

pub fn should_prefer_gui_endpoint_with_thread_mode(
    args: &[String],
    kite_address_env: Option<&str>,
    thread_mode: bool,
) -> bool {
    let slice = strip_cli_prefix(args);
    let Some(sub) = slice.first().map(String::as_str) else {
        return false;
    };
    let rest: Vec<&str> = slice[1..].iter().map(String::as_str).collect();
    let from_thread = thread_mode
        || kite_address_env
            .map(str::trim)
            .is_some_and(|v| v.starts_with("thread:"));

    match sub {
        "swarm" | "providers" | "models" | "agent" | "browser" => true,
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

#[derive(Debug, Clone, Copy, Default)]
pub struct LoopbackCallOptions<'a> {
    pub from_override: Option<&'a str>,
    pub force_thread_mode: bool,
    pub force_multiplexed_daemon: bool,
}

pub(crate) fn build_loopback_request_payload(
    token: &str,
    args: &[String],
    options: LoopbackCallOptions<'_>,
) -> Value {
    let caller = if std::env::var("KITE_DISPATCH").ok().as_deref() == Some("1") {
        "agent"
    } else {
        "human"
    };
    let explicit_from = options
        .from_override
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let from_value = explicit_from.clone().unwrap_or_else(|| {
        if options.force_multiplexed_daemon {
            String::new()
        } else {
            std::env::var("KITE_ADDRESS").unwrap_or_default()
        }
    });
    let thread_mode = options.force_thread_mode
        || std::env::var("KITE_THREAD_MODE").ok().as_deref() == Some("1")
        || from_value.trim().starts_with("thread:");
    let multiplexed_daemon = explicit_from.is_none()
        && (options.force_multiplexed_daemon
            || std::env::var("KITE_MULTIPLEXED_DAEMON").ok().as_deref() == Some("1"));
    let mut payload = json!({
        "token": token,
        "argv": args,
        "id": uuid::Uuid::new_v4().to_string(),
        "caller": caller,
        "from": from_value,
        "workspace": std::env::current_dir().ok().map(|p| p.display().to_string()),
    });
    if let Some(obj) = payload.as_object_mut() {
        if thread_mode {
            obj.insert("threadMode".to_string(), json!(true));
        }
        if multiplexed_daemon {
            obj.insert("multiplexedDaemon".to_string(), json!(true));
        }
        if let Ok(agent_id) = std::env::var("KITE_AGENT_ID") {
            let trimmed = agent_id.trim();
            if !trimmed.is_empty() {
                obj.insert("agentId".to_string(), json!(trimmed));
            }
        }
        if let Ok(raw) = std::env::var("KITE_ALLOW_SCHEDULING") {
            match raw.trim().to_ascii_lowercase().as_str() {
                "true" | "1" | "yes" => {
                    obj.insert("allowAgentScheduling".to_string(), json!(true));
                }
                "false" | "0" | "no" => {
                    obj.insert("allowAgentScheduling".to_string(), json!(false));
                }
                _ => {}
            }
        }
        if let Ok(raw) = std::env::var("KITE_ALLOW_MESSAGING") {
            match raw.trim().to_ascii_lowercase().as_str() {
                "true" | "1" | "yes" => {
                    obj.insert("allowAgentMessaging".to_string(), json!(true));
                }
                "false" | "0" | "no" => {
                    obj.insert("allowAgentMessaging".to_string(), json!(false));
                }
                _ => {}
            }
        }
        if let Ok(raw) = std::env::var("KITE_DISABLED_PLUGINS") {
            let disabled: Vec<String> = raw
                .split(',')
                .map(|s| s.trim().to_ascii_lowercase())
                .filter(|s| !s.is_empty())
                .collect();
            if !disabled.is_empty() {
                obj.insert("disabledPluginIds".to_string(), json!(disabled));
            }
        }
    }
    payload
}

pub fn loopback_cli_response_from_file(path: &Path, args: &[String]) -> Option<Value> {
    loopback_cli_response_from_file_with_options(path, args, LoopbackCallOptions::default())
}

pub fn loopback_cli_response_from_file_with_from(
    path: &Path,
    args: &[String],
    from_override: Option<&str>,
) -> Option<Value> {
    loopback_cli_response_from_file_with_options(
        path,
        args,
        LoopbackCallOptions {
            from_override,
            ..LoopbackCallOptions::default()
        },
    )
}

pub fn loopback_cli_response_from_file_with_options(
    path: &Path,
    args: &[String],
    options: LoopbackCallOptions<'_>,
) -> Option<Value> {
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
    let payload = build_loopback_request_payload(token, args, options);
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
    loopback_cli_response_with_options(args, LoopbackCallOptions::default())
}

pub fn loopback_cli_response_with_from(args: &[String], from_override: Option<&str>) -> Option<Value> {
    loopback_cli_response_with_options(
        args,
        LoopbackCallOptions {
            from_override,
            ..LoopbackCallOptions::default()
        },
    )
}

pub fn loopback_cli_response_with_options(
    args: &[String],
    options: LoopbackCallOptions<'_>,
) -> Option<Value> {
    let env_address = if options.force_multiplexed_daemon {
        None
    } else {
        std::env::var("KITE_ADDRESS").ok()
    };
    let effective_address = options
        .from_override
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or(env_address.as_deref());
    let thread_mode = options.force_thread_mode
        || std::env::var("KITE_THREAD_MODE").ok().as_deref() == Some("1");
    let prefer_gui =
        should_prefer_gui_endpoint_with_thread_mode(args, effective_address, thread_mode);
    let endpoints = if prefer_gui {
        [gui_endpoint_path(), endpoint_path()]
    } else {
        [endpoint_path(), gui_endpoint_path()]
    };
    for path in endpoints {
        if let Some(resp) = loopback_cli_response_from_file_with_options(&path, args, options) {
            return Some(resp);
        }
    }
    None
}

fn format_receipt_or_value(value: &Value) -> String {
    if let Some(receipt) = value.get("receipt") {
        serde_json::to_string(receipt).unwrap_or_default()
    } else {
        value.to_string()
    }
}

fn query_dispatch_with_options<'a>(
    args: &[String],
    options: LoopbackCallOptions<'_>,
    fallback: Option<&'a dyn Fn(&[String]) -> Option<Value>>,
) -> Option<Value> {
    loopback_cli_response_with_options(args, options)
        .or_else(|| fallback.and_then(|f| f(args)))
}

pub fn next_wait_poll_delay(elapsed: Duration) -> Duration {
    if elapsed < Duration::from_secs(2) {
        Duration::from_millis(200)
    } else if elapsed < Duration::from_secs(10) {
        Duration::from_millis(500)
    } else {
        Duration::from_millis(1_000)
    }
}

fn is_wait_timeout_json(raw: &str) -> bool {
    let Ok(val) = serde_json::from_str::<Value>(raw.trim()) else {
        return false;
    };
    let receipt = val.get("receipt").unwrap_or(&val);
    receipt
        .get("error")
        .and_then(Value::as_str)
        .is_some_and(|e| e.trim().eq_ignore_ascii_case("timeout"))
}

fn wait_and_read_single_child<'a>(
    child_address: &str,
    started: std::time::Instant,
    wait_timeout_ms: u64,
    options: LoopbackCallOptions<'_>,
    fallback: Option<&'a dyn Fn(&[String]) -> Option<Value>>,
) -> Result<(String, String), (i32, String)> {
    let wait_args = vec![
        "kite".to_string(),
        "dispatch".to_string(),
        "wait".to_string(),
        child_address.to_string(),
        "--until".to_string(),
        "done,error,gone,blocked".to_string(),
        "--timeout".to_string(),
        wait_timeout_ms.to_string(),
    ];
    let settled_presence;
    loop {
        let Some(wait_val) = query_dispatch_with_options(&wait_args, options, fallback) else {
            return Err((1, offline_receipt_json("cli", "dispatch").to_string()));
        };
        if receipt_still_waiting(&wait_val) {
            let elapsed = started.elapsed();
            if elapsed >= Duration::from_millis(wait_timeout_ms) {
                return Err((1, timeout_receipt(&wait_val).to_string()));
            }
            let remaining = Duration::from_millis(wait_timeout_ms).saturating_sub(elapsed);
            std::thread::sleep(next_wait_poll_delay(elapsed).min(remaining));
            continue;
        }
        let wait_exit = wait_val.get("exit").and_then(Value::as_i64).unwrap_or(1) as i32;
        if wait_exit != 0 {
            return Err((wait_exit, format_receipt_or_value(&wait_val)));
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
        child_address.to_string(),
        "--last".to_string(),
    ];
    let read_val = query_dispatch_with_options(&read_args, options, fallback);
    let final_text = read_val
        .as_ref()
        .and_then(|v| v.get("receipt"))
        .and_then(|r| r.get("text"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    Ok((settled_presence, final_text))
}

fn run_blocking_subagent_dispatch_captured<'a>(
    args: &[String],
    wait_timeout_ms: u64,
    options: LoopbackCallOptions<'_>,
    fallback: Option<&'a dyn Fn(&[String]) -> Option<Value>>,
) -> (i32, String) {
    let Some(mut value) = query_dispatch_with_options(args, options, fallback) else {
        return (1, offline_receipt_json("cli", "dispatch").to_string());
    };
    if value
        .pointer("/receipt/error")
        .and_then(Value::as_str)
        == Some("bad_args")
        && strip_cli_prefix(args).first().map(String::as_str) == Some("send")
    {
        let stripped = strip_send_wait_flags(args);
        if stripped != args {
            if let Some(retry_val) = query_dispatch_with_options(&stripped, options, fallback) {
                value = retry_val;
            }
        }
    }
    let run_exit = value.get("exit").and_then(Value::as_i64).unwrap_or(1) as i32;
    let addresses = extract_spawned_thread_addresses(&value);
    if run_exit != 0 || addresses.is_empty() {
        return (run_exit, format_receipt_or_value(&value));
    }

    let started = std::time::Instant::now();
    if addresses.len() == 1 {
        let child_address = &addresses[0];
        let (settled_presence, final_text) = match wait_and_read_single_child(
            child_address,
            started,
            wait_timeout_ms,
            options,
            fallback,
        ) {
            Ok(pair) => pair,
            Err(err_out) => return err_out,
        };
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
            return (1, failure.to_string());
        }
        let child_id = child_address
            .strip_prefix("thread:")
            .unwrap_or(child_address);
        let formatted = format_subagent_wait_output(&final_text, child_id);
        return (0, formatted);
    }

    let mut sections = Vec::with_capacity(addresses.len());
    let mut any_failed = false;
    for (idx, child_address) in addresses.iter().enumerate() {
        match wait_and_read_single_child(
            child_address,
            started,
            wait_timeout_ms,
            options,
            fallback,
        ) {
            Ok((settled_presence, final_text)) => {
                if matches!(settled_presence.as_str(), "error" | "gone" | "blocked") {
                    any_failed = true;
                }
                let child_id = child_address
                    .strip_prefix("thread:")
                    .unwrap_or(child_address);
                let formatted = format_subagent_wait_output(&final_text, child_id);
                sections.push(format!(
                    "=== Subagent {} ({child_address}) ===\n{formatted}",
                    idx + 1
                ));
            }
            Err((_code, err_text)) => {
                if is_wait_timeout_json(&err_text) {
                    let child_id = child_address
                        .strip_prefix("thread:")
                        .unwrap_or(child_address);
                    sections.push(format!(
                        "=== Subagent {} ({child_address}) ===\nSubagent {child_address} is still running after {wait_timeout_ms}ms wait slice. Call `kite_subagent_wait` with targets=[\"{child_address}\"] to continue waiting.\n\n[subagent_id: thread:{child_id}]",
                        idx + 1
                    ));
                } else {
                    any_failed = true;
                    sections.push(format!(
                        "=== Subagent {} ({child_address}) ===\n{err_text}",
                        idx + 1
                    ));
                }
            }
        }
    }
    (if any_failed { 1 } else { 0 }, sections.join("\n\n"))
}

pub fn execute_cli_captured<'a>(
    args: &[String],
    fallback: Option<&'a dyn Fn(&[String]) -> Option<Value>>,
) -> (i32, String) {
    execute_cli_captured_with_options(args, LoopbackCallOptions::default(), fallback)
}

pub fn execute_cli_captured_with_from<'a>(
    args: &[String],
    from_override: Option<&str>,
    fallback: Option<&'a dyn Fn(&[String]) -> Option<Value>>,
) -> (i32, String) {
    execute_cli_captured_with_options(
        args,
        LoopbackCallOptions {
            from_override,
            ..LoopbackCallOptions::default()
        },
        fallback,
    )
}

pub fn execute_cli_captured_with_options<'a>(
    args: &[String],
    options: LoopbackCallOptions<'_>,
    fallback: Option<&'a dyn Fn(&[String]) -> Option<Value>>,
) -> (i32, String) {
    if let Some(wait_timeout_ms) =
        blocking_run_wait_ms(args).or_else(|| blocking_send_wait_ms(args))
    {
        return run_blocking_subagent_dispatch_captured(
            args,
            wait_timeout_ms,
            options,
            fallback,
        );
    }
    let wait_for = blocking_wait_ms(args);
    let started = std::time::Instant::now();
    loop {
        let Some(value) = query_dispatch_with_options(args, options, fallback) else {
            return (1, offline_receipt_json("cli", "dispatch").to_string());
        };
        if let Some(skill) = value.get("skill").and_then(Value::as_str) {
            return (0, skill.to_string());
        }
        if let Some(programs) = value.get("programs").and_then(Value::as_str) {
            return (0, programs.to_string());
        }
        if let Some(text_out) = value.get("textOut").and_then(Value::as_str) {
            let code = value.get("exit").and_then(Value::as_i64).unwrap_or(0) as i32;
            return (code, text_out.to_string());
        }
        if receipt_still_waiting(&value) {
            let elapsed = started.elapsed();
            let timed_out = wait_for
                .map(|timeout_ms| elapsed >= Duration::from_millis(timeout_ms))
                .unwrap_or(true);
            if timed_out {
                return (1, timeout_receipt(&value).to_string());
            }
            let delay = match wait_for {
                Some(timeout_ms) => {
                    let remaining = Duration::from_millis(timeout_ms).saturating_sub(elapsed);
                    next_wait_poll_delay(elapsed).min(remaining)
                }
                None => next_wait_poll_delay(elapsed),
            };
            std::thread::sleep(delay);
            continue;
        }
        let code = value.get("exit").and_then(Value::as_i64).unwrap_or(1) as i32;
        return (code, format_receipt_or_value(&value));
    }
}

pub fn run_cli<'a>(
    args: &[String],
    fallback: Option<&'a dyn Fn(&[String]) -> Option<Value>>,
) -> i32 {
    let slice = strip_cli_prefix(args);
    match slice.first().map(String::as_str) {
        Some("mcp") => return mcp::run_mcp_cli(&slice[1..]),
        Some("hook-subagent") => return hook::run_hook_cli(&slice[1..]),
        _ => {}
    }
    let (code, output) = execute_cli_captured(args, fallback);
    emit_cli_line(&output);
    code
}

#[cfg(test)]
mod wire_tests {
    use super::*;

    fn owned(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn blocking_send_wait_ms_detects_thread_target_and_wait_flag() {
        assert_eq!(
            blocking_send_wait_ms(&owned(&[
                "kite",
                "dispatch",
                "send",
                "thread:child-1",
                "Follow up prompt",
                "--wait",
                "--timeout-ms",
                "45000"
            ])),
            Some(45_000)
        );
        assert_eq!(
            blocking_send_wait_ms(&owned(&[
                "kite",
                "dispatch",
                "send",
                "thread:child-1",
                "Follow up prompt"
            ])),
            None
        );
        assert_eq!(
            blocking_send_wait_ms(&owned(&[
                "kite",
                "dispatch",
                "send",
                "session:term-1",
                "Follow up prompt",
                "--wait"
            ])),
            None
        );
    }

    #[test]
    fn multi_address_blocking_run_waits_and_formats_every_spawned_subagent() {
        let args = owned(&[
            "kite",
            "dispatch",
            "run",
            "--via",
            "thread",
            "--task",
            "Task A",
            "--task",
            "Task B",
            "--wait",
        ]);
        let fallback = |argv: &[String]| -> Option<Value> {
            let sub = strip_cli_prefix(argv);
            match sub.first().map(String::as_str) {
                Some("run") => Some(json!({
                    "exit": 0,
                    "receipt": {
                        "op": "run",
                        "status": "submitted",
                        "address": "thread:c1",
                        "text": "started thread:c1,thread:c2"
                    }
                })),
                Some("wait") => {
                    let target = sub.get(1).cloned().unwrap_or_default();
                    Some(json!({
                        "exit": 0,
                        "receipt": {
                            "op": "wait",
                            "status": "settled",
                            "address": target,
                            "presenceAtSubmit": "done"
                        }
                    }))
                }
                Some("read") => {
                    let target = sub.get(1).map(String::as_str).unwrap_or("");
                    let reply = if target == "thread:c1" {
                        "First subagent answer"
                    } else {
                        "Second subagent answer"
                    };
                    Some(json!({
                        "exit": 0,
                        "receipt": {
                            "op": "read",
                            "status": "settled",
                            "address": target,
                            "text": reply
                        }
                    }))
                }
                _ => None,
            }
        };

        let (code, output) = execute_cli_captured(&args, Some(&fallback));
        assert_eq!(code, 0);
        assert_eq!(
            output,
            "=== Subagent 1 (thread:c1) ===\nFirst subagent answer\n\n[subagent_id: thread:c1]\n\n=== Subagent 2 (thread:c2) ===\nSecond subagent answer\n\n[subagent_id: thread:c2]"
        );
    }

    #[test]
    fn adaptive_wait_poll_delay_scales_with_elapsed_time() {
        assert_eq!(next_wait_poll_delay(Duration::from_millis(0)), Duration::from_millis(200));
        assert_eq!(next_wait_poll_delay(Duration::from_millis(1_999)), Duration::from_millis(200));
        assert_eq!(next_wait_poll_delay(Duration::from_secs(2)), Duration::from_millis(500));
        assert_eq!(next_wait_poll_delay(Duration::from_millis(9_999)), Duration::from_millis(500));
        assert_eq!(next_wait_poll_delay(Duration::from_secs(10)), Duration::from_millis(1_000));
        assert_eq!(next_wait_poll_delay(Duration::from_secs(60)), Duration::from_millis(1_000));
    }

    #[test]
    fn thread_mode_prefers_gui_endpoint_even_without_kite_address() {
        let run_args = owned(&["kite", "dispatch", "run", "Check files"]);
        assert!(!should_prefer_gui_endpoint_with_thread_mode(&run_args, None, false));
        assert!(should_prefer_gui_endpoint_with_thread_mode(&run_args, None, true));

        let wait_args = owned(&["kite", "dispatch", "wait"]);
        assert!(!should_prefer_gui_endpoint_with_thread_mode(&wait_args, None, false));
        assert!(should_prefer_gui_endpoint_with_thread_mode(&wait_args, None, true));
    }

    #[test]
    fn multi_address_blocking_run_treats_wait_timeout_as_non_error_still_running() {
        let args = owned(&[
            "kite",
            "dispatch",
            "run",
            "--via",
            "thread",
            "--task",
            "Fast task",
            "--task",
            "Long task",
            "--wait",
            "--timeout-ms",
            "5",
        ]);
        let fallback = |argv: &[String]| -> Option<Value> {
            let sub = strip_cli_prefix(argv);
            match sub.first().map(String::as_str) {
                Some("run") => Some(json!({
                    "exit": 0,
                    "receipt": {
                        "op": "run",
                        "status": "submitted",
                        "address": "thread:c-fast",
                        "text": "started thread:c-fast,thread:c-long"
                    }
                })),
                Some("wait") => {
                    let target = sub.get(1).map(String::as_str).unwrap_or("");
                    if target == "thread:c-fast" {
                        Some(json!({
                            "exit": 0,
                            "receipt": {
                                "op": "wait",
                                "status": "settled",
                                "address": target,
                                "presenceAtSubmit": "done"
                            }
                        }))
                    } else {
                        Some(json!({
                            "exit": 0,
                            "receipt": {
                                "op": "wait",
                                "status": "queued",
                                "address": target
                            }
                        }))
                    }
                }
                Some("read") => Some(json!({
                    "exit": 0,
                    "receipt": {
                        "op": "read",
                        "status": "settled",
                        "address": "thread:c-fast",
                        "text": "Fast result"
                    }
                })),
                _ => None,
            }
        };

        let (code, output) = run_blocking_subagent_dispatch_captured(
            &args,
            5,
            LoopbackCallOptions::default(),
            Some(&fallback),
        );
        assert_eq!(code, 0, "still-running child timeout must not fail multi-run: {output}");
        assert!(output.contains("Fast result"));
        assert!(output.contains("[subagent_id: thread:c-long]"));
        assert!(output.contains("still running after 5ms wait slice"));
    }

    #[test]
    fn loopback_call_options_marks_multiplexed_http_hub_without_from_header() {
        let args = owned(&["kite", "dispatch", "run", "Check files"]);
        let mux_payload = build_loopback_request_payload(
            "tok-1",
            &args,
            LoopbackCallOptions {
                from_override: None,
                force_thread_mode: true,
                force_multiplexed_daemon: true,
            },
        );
        assert_eq!(mux_payload["threadMode"], json!(true));
        assert_eq!(mux_payload["multiplexedDaemon"], json!(true));

        let explicit_thread_payload = build_loopback_request_payload(
            "tok-1",
            &args,
            LoopbackCallOptions {
                from_override: Some("thread:t-explicit"),
                force_thread_mode: false,
                force_multiplexed_daemon: false,
            },
        );
        assert_eq!(explicit_thread_payload["from"], json!("thread:t-explicit"));
        assert_eq!(explicit_thread_payload["threadMode"], json!(true));
        assert!(explicit_thread_payload.get("multiplexedDaemon").is_none());

        let explicit_session_payload = build_loopback_request_payload(
            "tok-1",
            &args,
            LoopbackCallOptions {
                from_override: Some("session:term-1"),
                force_thread_mode: false,
                force_multiplexed_daemon: false,
            },
        );
        assert_eq!(explicit_session_payload["from"], json!("session:term-1"));
        assert!(explicit_session_payload.get("multiplexedDaemon").is_none());
    }
}
