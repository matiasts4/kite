use crate::quota::types::{ProviderQuotaStatus, QuotaWindow};
use crate::quota::utils::{
    b64url_decode, chrono_parse_rfc3339, format_unix_to_rfc3339, now_ms, silent_command,
    user_home_dir,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

struct AntigravityProcessInfo {
    pid: u32,
    csrf_token: String,
    port: u16,
}

fn detect_antigravity_process() -> Option<AntigravityProcessInfo> {
    #[cfg(target_os = "windows")]
    {
        if let Ok(out) = crate::hidden_exec::run(std::path::Path::new("tasklist.exe"), &["/FO", "CSV", "/NH"], Duration::from_secs(5)) {
            let list_str = String::from_utf8_lossy(&out.stdout).to_lowercase();
            if !list_str.contains("language_server") && !list_str.contains("antigravity") {
                return None;
            }
        }

        let ps_cmd = r#"Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and ($_.CommandLine -like '*antigravity*' -or $_.Name -like '*language_server*') } | Select-Object ProcessId, Name, CommandLine | ConvertTo-Json -Compress"#;
        let output = crate::hidden_exec::run(
            std::path::Path::new("powershell.exe"),
            &["-NoProfile", "-NonInteractive", "-Command", ps_cmd],
            Duration::from_secs(6),
        )
        .ok()?;

        if output.code != Some(0) {
            return None;
        }

        let text = String::from_utf8_lossy(&output.stdout);
        let procs: Value = serde_json::from_str(&text).ok()?;
        let arr = if procs.is_array() {
            procs.as_array()?.clone()
        } else {
            vec![procs]
        };

        for p in arr {
            let cmd_line = p.get("CommandLine").and_then(|v| v.as_str()).unwrap_or("");
            let name = p.get("Name").and_then(|v| v.as_str()).unwrap_or("");
            if !cmd_line.to_lowercase().contains("antigravity") {
                continue;
            }
            if !name.to_lowercase().contains("language_server") && !cmd_line.contains("--csrf_token") {
                continue;
            }

            let pid = p.get("ProcessId").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            let csrf_token = extract_arg(cmd_line, "--csrf_token").unwrap_or_default();
            let port = extract_arg(cmd_line, "--extension_server_port")
                .and_then(|s| s.parse::<u16>().ok())
                .unwrap_or(0);

            if !csrf_token.is_empty() {
                return Some(AntigravityProcessInfo {
                    pid,
                    csrf_token,
                    port,
                });
            }
        }
    }
    None
}

fn extract_arg(cmd_line: &str, arg_name: &str) -> Option<String> {
    let mut parts = cmd_line.split_whitespace();
    while let Some(part) = parts.next() {
        if part == arg_name {
            return parts.next().map(|s| s.trim_matches('"').trim_matches('\'').to_string());
        }
        if let Some(rest) = part.strip_prefix(&format!("{}=", arg_name)) {
            return Some(rest.trim_matches('"').trim_matches('\'').to_string());
        }
    }
    None
}

fn discover_listening_ports(pid: u32) -> Vec<u16> {
    #[cfg(target_os = "windows")]
    {
        // Try netstat first for fast resolution (<50ms)
        if let Ok(out) = crate::hidden_exec::run(std::path::Path::new("netstat.exe"), &["-ano"], Duration::from_secs(5)) {
            let text = String::from_utf8_lossy(&out.stdout);
            let mut ports = Vec::new();
            let pid_str = pid.to_string();
            for line in text.lines() {
                if !line.contains("LISTENING") && !line.contains("LISTEN") {
                    continue;
                }
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 5 && parts[parts.len() - 1] == pid_str {
                    if let Some(pos) = parts[1].rfind(':') {
                        if let Ok(port) = parts[1][pos + 1..].parse::<u16>() {
                            if !ports.contains(&port) {
                                ports.push(port);
                            }
                        }
                    }
                }
            }
            if !ports.is_empty() {
                return ports;
            }
        }

        let ps_cmd = format!(
            "Get-NetTCPConnection -OwningProcess {} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort",
            pid
        );
        if let Ok(out) = crate::hidden_exec::run(
            std::path::Path::new("powershell.exe"),
            &["-NoProfile", "-NonInteractive", "-Command", &ps_cmd],
            Duration::from_secs(5),
        ) {
            if out.code == Some(0) {
                let text = String::from_utf8_lossy(&out.stdout);
                let mut ports = Vec::new();
                for line in text.lines() {
                    if let Ok(port) = line.trim().parse::<u16>() {
                        if !ports.contains(&port) {
                            ports.push(port);
                        }
                    }
                }
                return ports;
            }
        }
    }
    Vec::new()
}

fn probe_antigravity_rpc(port: u16, csrf_token: &str) -> Option<Value> {
    let auth_header = format!("X-Codeium-Csrf-Token: {}", csrf_token);

    // Try HTTPS first (self-signed cert), then HTTP fallback
    for proto in ["https", "http"] {
        let url = format!(
            "{}://127.0.0.1:{}/exa.language_server_pb.LanguageServerService/GetUserStatus",
            proto, port
        );

        let output = silent_command("curl.exe")
            .args([
                "-s",
                "-k",
                "-X",
                "POST",
                &url,
                "-H",
                "Content-Type: application/json",
                "-H",
                "Connect-Protocol-Version: 1",
                "-H",
                &auth_header,
                "--data-raw",
                r#"{"metadata":{"ideName":"antigravity","extensionName":"antigravity","locale":"en"}}"#,
                "--max-time",
                "3",
            ])
            .output()
            .ok();

        if let Some(out) = output {
            if out.status.success() {
                let body = String::from_utf8_lossy(&out.stdout);
                if let Ok(json_val) = serde_json::from_str::<Value>(&body) {
                    if json_val.get("userStatus").is_some() {
                        return Some(json_val);
                    }
                }
            }
        }
    }
    None
}

fn resolve_antigravity_binary() -> PathBuf {
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let p = PathBuf::from(local).join("agy").join("bin").join("agy.exe");
        if p.exists() {
            return p;
        }
    }
    if let Ok(profile) = std::env::var("USERPROFILE") {
        let p = PathBuf::from(profile).join("AppData").join("Local").join("agy").join("bin").join("agy.exe");
        if p.exists() {
            return p;
        }
    }
    let home = user_home_dir();
    let p = home.join(".local").join("bin").join("agy.exe");
    if p.exists() {
        return p;
    }
    let p_unix = home.join(".local").join("bin").join("agy");
    if p_unix.exists() {
        return p_unix;
    }
    PathBuf::from("agy")
}


#[cfg(windows)]
pub fn read_antigravity_raw_credential() -> Option<String> {
    use std::ptr::null_mut;

    #[repr(C)]
    struct CREDENTIALW {
        flags: u32,
        cred_type: u32,
        target_name: *mut u16,
        comment: *mut u16,
        last_written: [u32; 2],
        credential_blob_size: u32,
        credential_blob: *mut u8,
        persist: u32,
        attribute_count: u32,
        attributes: *mut std::ffi::c_void,
        target_alias: *mut u16,
        user_name: *mut u16,
    }

    #[link(name = "advapi32")]
    extern "system" {
        fn CredReadW(target_name: *const u16, cred_type: u32, flags: u32, credential: *mut *mut CREDENTIALW) -> i32;
        fn CredFree(credential: *mut std::ffi::c_void);
    }

    let target = "gemini:antigravity";
    let target_utf16: Vec<u16> = target.encode_utf16().chain(std::iter::once(0)).collect();
    let mut cred_ptr: *mut CREDENTIALW = null_mut();

    unsafe {
        if CredReadW(target_utf16.as_ptr(), 1 /* CRED_TYPE_GENERIC */, 0, &mut cred_ptr) != 0 && !cred_ptr.is_null() {
            let cred = &*cred_ptr;
            let slice = std::slice::from_raw_parts(cred.credential_blob, cred.credential_blob_size as usize);
            let raw_str = String::from_utf8_lossy(slice).to_string();
            CredFree(cred_ptr as *mut std::ffi::c_void);
            return Some(raw_str);
        }
    }
    None
}

#[cfg(not(windows))]
pub fn read_antigravity_raw_credential() -> Option<String> {
    None
}

pub fn read_antigravity_credential() -> Option<(String, Option<String>)> {
    let raw = read_antigravity_raw_credential()?;
    if let Ok(val) = serde_json::from_str::<Value>(&raw) {
        let id_token_str = val.get("id_token")
            .or_else(|| val.pointer("/token/id_token"))
            .and_then(|v| v.as_str());

        if let Some(id_token) = id_token_str {
            let parts: Vec<&str> = id_token.split('.').collect();
            if parts.len() >= 2 {
                if let Some(payload_bytes) = b64url_decode(parts[1]) {
                    if let Ok(jwt_json) = serde_json::from_slice::<Value>(&payload_bytes) {
                        if let Some(email) = jwt_json.get("email").and_then(|v| v.as_str()).map(|s| s.trim().to_string()) {
                            if !email.is_empty() {
                                let name = jwt_json.get("name").and_then(|v| v.as_str()).map(|s| s.trim().to_string());
                                return Some((email, name));
                            }
                        }
                    }
                }
            }
        }
    }
    None
}

#[cfg(windows)]
pub fn write_antigravity_credential(blob_json: &str) -> bool {
    #[repr(C)]
    struct CREDENTIALW {
        flags: u32,
        cred_type: u32,
        target_name: *mut u16,
        comment: *mut u16,
        last_written: [u32; 2],
        credential_blob_size: u32,
        credential_blob: *mut u8,
        persist: u32,
        attribute_count: u32,
        attributes: *mut std::ffi::c_void,
        target_alias: *mut u16,
        user_name: *mut u16,
    }

    #[link(name = "advapi32")]
    extern "system" {
        fn CredWriteW(credential: *const CREDENTIALW, flags: u32) -> i32;
    }

    let mut target_utf16: Vec<u16> = "gemini:antigravity".encode_utf16().chain(std::iter::once(0)).collect();
    let mut user_utf16: Vec<u16> = "antigravity".encode_utf16().chain(std::iter::once(0)).collect();
    let mut blob_bytes = blob_json.as_bytes().to_vec();

    let cred = CREDENTIALW {
        flags: 0,
        cred_type: 1, // CRED_TYPE_GENERIC
        target_name: target_utf16.as_mut_ptr(),
        comment: std::ptr::null_mut(),
        last_written: [0, 0],
        credential_blob_size: blob_bytes.len() as u32,
        credential_blob: blob_bytes.as_mut_ptr(),
        persist: 2, // CRED_PERSIST_LOCAL_MACHINE
        attribute_count: 0,
        attributes: std::ptr::null_mut(),
        target_alias: std::ptr::null_mut(),
        user_name: user_utf16.as_mut_ptr(),
    };

    unsafe { CredWriteW(&cred, 0) != 0 }
}

#[cfg(not(windows))]
pub fn write_antigravity_credential(_blob_json: &str) -> bool {
    false
}

fn read_antigravity_ide_identity() -> Option<(String, Option<String>)> {
    let home = user_home_dir();
    let appdata = std::env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home.join("AppData").join("Roaming"));

    let candidates = vec![
        appdata.join("Antigravity").join("User").join("globalStorage").join("state.vscdb"),
        home.join(".config").join("Antigravity").join("User").join("globalStorage").join("state.vscdb"),
        home.join("Library").join("Application Support").join("Antigravity").join("User").join("globalStorage").join("state.vscdb"),
    ];

    for db in candidates {
        if !db.exists() {
            continue;
        }
        let uri = format!("file:{}?mode=ro&immutable=1", db.to_string_lossy().replace('\\', "/"));
        if let Ok(conn) = rusqlite::Connection::open_with_flags(
            &uri,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
        ) {
            if let Ok(raw) = conn.query_row(
                "SELECT value FROM ItemTable WHERE key = 'antigravityAuthStatus'",
                [],
                |r| r.get::<_, String>(0),
            ) {
                if let Ok(val) = serde_json::from_str::<Value>(&raw) {
                    if let Some(email) = val.get("email").and_then(|v| v.as_str()).map(|s| s.trim().to_string()) {
                        if !email.is_empty() {
                            let name = val.get("name").and_then(|v| v.as_str()).map(|s| s.trim().to_string());
                            return Some((email, name));
                        }
                    }
                }
            }
        }
    }
    None
}

pub(crate) fn enrich_google_identity(status: &mut ProviderQuotaStatus) {
    // 1. Try Windows Credential Manager gemini:antigravity first (real active Antigravity session)
    if let Some((email, name)) = read_antigravity_credential() {
        status.metadata.insert("email".to_string(), json!(email));
        if let Some(n) = name {
            status.metadata.insert("userName".to_string(), json!(n));
        }
        status.metadata.insert("accountSource".to_string(), json!("gemini:antigravity"));
    }

    // 2. If no email yet, try oauth_creds.json
    if !status.metadata.contains_key("email") {
        let home = user_home_dir();
        let creds_file = home.join(".gemini").join("oauth_creds.json");
        if let Ok(data) = std::fs::read(&creds_file) {
            if let Ok(val) = serde_json::from_slice::<Value>(&data) {
                if let Some(id_token) = val.get("id_token").and_then(|v| v.as_str()) {
                    let parts: Vec<&str> = id_token.split('.').collect();
                    if parts.len() >= 2 {
                        if let Some(payload_bytes) = b64url_decode(parts[1]) {
                            if let Ok(jwt_json) = serde_json::from_slice::<Value>(&payload_bytes) {
                                if let Some(email) = jwt_json.get("email").and_then(|v| v.as_str()) {
                                    status.metadata.insert("email".to_string(), json!(email));
                                    status.metadata.insert("accountSource".to_string(), json!("oauth_creds.json"));
                                }
                                if !status.metadata.contains_key("userName") {
                                    if let Some(name) = jwt_json.get("name").and_then(|v| v.as_str()) {
                                        status.metadata.insert("userName".to_string(), json!(name));
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // 3. Fallback to google_accounts.json
    if !status.metadata.contains_key("email") {
        let home = user_home_dir();
        let accounts_file = home.join(".gemini").join("google_accounts.json");
        if let Ok(data) = std::fs::read(&accounts_file) {
            if let Ok(val) = serde_json::from_slice::<Value>(&data) {
                if let Some(active_email) = val.get("active").and_then(|v| v.as_str()) {
                    if !active_email.trim().is_empty() {
                        status.metadata.insert("email".to_string(), json!(active_email.trim()));
                        status.metadata.insert("accountSource".to_string(), json!("google_accounts.json"));
                    }
                }
            }
        }
    }

    // 4. Fallback to Antigravity IDE state.vscdb
    if !status.metadata.contains_key("email") {
        if let Some((email, name)) = read_antigravity_ide_identity() {
            status.metadata.insert("email".to_string(), json!(email));
            if let Some(n) = name {
                status.metadata.insert("userName".to_string(), json!(n));
            }
            status.metadata.insert("accountSource".to_string(), json!("Antigravity IDE"));
        }
    }

    // Default planType if not already present
    if !status.metadata.contains_key("planType") {
        status.metadata.insert("planType".to_string(), json!("Google AI Pro"));
    }
}

pub fn fetch_antigravity_quota() -> ProviderQuotaStatus {
    let mut status = ProviderQuotaStatus {
        provider_id: "antigravity".to_string(),
        display_name: "Antigravity".to_string(),
        is_available: false,
        is_auth: false,
        primary_usage_percent: 0.0,
        primary_remaining_percent: 100.0,
        primary_reset_at: None,
        time_until_reset_ms: None,
        windows: Vec::new(),
        metadata: HashMap::new(),
        last_updated_ms: now_ms(),
        error: None,
    };

    // 1. Primary strategy: Antigravity CLI print-mode slash command
    // Runs `agy -p /usage --output-format json --print-timeout 12s`
    //
    // The probe runs inside a *hidden* console (`crate::hidden_exec`). `agy`
    // boots its configured MCP servers and helper processes on every run; when
    // the CLI is started with no console at all, those console children create
    // their own console and Windows shows it as an external terminal window for
    // a few milliseconds. Giving the CLI an invisible console keeps the whole
    // tree attached to it, so nothing can pop up while quotas are polled.
    //
    // In addition, `agy` spawns a detached `--bg-updater` daemon that calls
    // `agy.exe --version` without `CREATE_NO_WINDOW`, causing Windows 11 Console
    // Delegation to flash a terminal window. We ensure `AGY_CLI_DISABLE_AUTO_UPDATE=1`
    // is set in the environment to completely suppress updater activity.
    if std::env::var("AGY_CLI_DISABLE_AUTO_UPDATE").is_err() {
        std::env::set_var("AGY_CLI_DISABLE_AUTO_UPDATE", "true");
    }

    let agy_bin = resolve_antigravity_binary();
    let agy_args = ["-p", "/usage", "--output-format", "json", "--print-timeout", "12s"];

    if let Ok(out) = crate::hidden_exec::run(&agy_bin, &agy_args, Duration::from_secs(20)) {
        if out.success() {
            let stdout_str = String::from_utf8_lossy(&out.stdout);
            if let Ok(json_val) = serde_json::from_str::<Value>(&stdout_str) {
                if let Some(groups) = json_val.pointer("/command/data/groups").and_then(|v| v.as_array()) {
                    let mut min_remaining = 1.0f64;
                    let mut earliest_reset_ms: Option<i64> = None;
                    let mut primary_reset_at: Option<String> = None;

                    // Dedicated tracking for Gemini Models 5-hour limit
                    let mut gemini_5h_bucket: Option<(f64, Option<String>, Option<i64>)> = None;
                    let mut gemini_any_bucket: Option<(f64, Option<String>, Option<i64>)> = None;

                    for g in groups {
                        let group_name = g.get("name").and_then(|v| v.as_str()).unwrap_or("Model Pool");
                        let is_gemini_models = group_name.to_lowercase().contains("gemini")
                            && !group_name.to_lowercase().contains("argon");
                        let buckets = g.get("buckets").and_then(|v| v.as_array()).cloned().unwrap_or_default();

                        for b in buckets {
                            if b.get("disabled").and_then(|v| v.as_bool()).unwrap_or(false) {
                                continue;
                            }
                            let rem_fraction = match b.get("remaining_fraction").and_then(|v| v.as_f64()) {
                                Some(f) => f.clamp(0.0, 1.0),
                                None => continue,
                            };
                            let bucket_name = b.get("name").and_then(|v| v.as_str()).unwrap_or("Límite");
                            let reset_time = b.get("reset_time").and_then(|v| v.as_str()).map(|s| s.to_string());
                            let b_id = b.get("id").and_then(|v| v.as_str()).unwrap_or("");
                            let b_window = b.get("window").and_then(|v| v.as_str()).unwrap_or("");

                            let mut time_until_reset_ms: Option<i64> = None;
                            if let Some(ref rt) = reset_time {
                                if let Ok(parsed) = chrono_parse_rfc3339(rt) {
                                    let ms = (parsed - now_ms()).max(0);
                                    time_until_reset_ms = Some(ms);
                                    if earliest_reset_ms.is_none() || ms < earliest_reset_ms.unwrap() {
                                        earliest_reset_ms = Some(ms);
                                        primary_reset_at = Some(rt.clone());
                                    }
                                }
                            }

                            if rem_fraction < min_remaining {
                                min_remaining = rem_fraction;
                            }

                            // Detect 5-hour limit for Gemini Models
                            let is_5h = b_id.contains("5h")
                                || b_window == "5h"
                                || bucket_name.to_lowercase().contains("five hour")
                                || bucket_name.to_lowercase().contains("5 hour")
                                || bucket_name.to_lowercase().contains("5h");

                            if is_gemini_models {
                                if is_5h && gemini_5h_bucket.is_none() {
                                    gemini_5h_bucket = Some((rem_fraction, reset_time.clone(), time_until_reset_ms));
                                }
                                if gemini_any_bucket.is_none() {
                                    gemini_any_bucket = Some((rem_fraction, reset_time.clone(), time_until_reset_ms));
                                }
                            }

                            let usage_pct = ((1.0 - rem_fraction) * 100.0).round();
                            let clean_bucket = bucket_name.replace(" Limit Remaining", "");
                            let window_label = format!("{} ({})", group_name, clean_bucket);

                            status.windows.push(QuotaWindow {
                                name: window_label,
                                usage_percent: usage_pct,
                                remaining_fraction: (rem_fraction * 100.0).round() / 100.0,
                                resets_at: reset_time,
                                time_until_reset_ms,
                                is_exhausted: rem_fraction <= 0.0,
                            });
                        }
                    }

                    if !status.windows.is_empty() {
                        status.is_available = true;
                        status.is_auth = true;

                        // Prefer the 5-hour limit for Gemini Models as requested by user
                        if let Some((frac, reset_at, until_ms)) = gemini_5h_bucket {
                            let rem_pct = (frac * 100.0).round();
                            status.primary_remaining_percent = rem_pct;
                            status.primary_usage_percent = 100.0 - rem_pct;
                            status.primary_reset_at = reset_at;
                            status.time_until_reset_ms = until_ms;
                            status.metadata.insert("primaryWindow".to_string(), json!("5h"));
                            status.metadata.insert("primaryWindowLabel".to_string(), json!("5h"));
                        } else if let Some((frac, reset_at, until_ms)) = gemini_any_bucket {
                            let rem_pct = (frac * 100.0).round();
                            status.primary_remaining_percent = rem_pct;
                            status.primary_usage_percent = 100.0 - rem_pct;
                            status.primary_reset_at = reset_at;
                            status.time_until_reset_ms = until_ms;
                        } else {
                            let rem_pct = (min_remaining * 100.0).round();
                            status.primary_remaining_percent = rem_pct;
                            status.primary_usage_percent = 100.0 - rem_pct;
                            status.primary_reset_at = primary_reset_at;
                            status.time_until_reset_ms = earliest_reset_ms;
                        }

                        status.metadata.insert("source".to_string(), json!("agy CLI"));
                        enrich_google_identity(&mut status);
                        return status;
                    }
                }
            }
        }
    }

    // 2. Secondary Fallback: Antigravity Language Server Process RPC (if IDE is running)
    let proc_info = match detect_antigravity_process() {
        Some(info) => info,
        None => {
            status.error = Some("CLI de Antigravity (agy) no respondió y el servidor de lenguaje no está activo".to_string());
            return status;
        }
    };

    status.is_available = true;

    let mut ports = Vec::new();
    if proc_info.port > 0 {
        ports.push(proc_info.port);
    }
    for p in discover_listening_ports(proc_info.pid) {
        if !ports.contains(&p) {
            ports.push(p);
        }
    }

    let mut response_payload: Option<Value> = None;
    for port in ports {
        if let Some(val) = probe_antigravity_rpc(port, &proc_info.csrf_token) {
            response_payload = Some(val);
            break;
        }
    }

    let payload = match response_payload {
        Some(p) => p,
        None => {
            status.error = Some("Could not reach Antigravity Language Server RPC".to_string());
            return status;
        }
    };

    let user_status = match payload.get("userStatus") {
        Some(u) => u,
        None => {
            status.error = Some("Antigravity userStatus not returned".to_string());
            return status;
        }
    };

    status.is_auth = true;

    if let Some(email) = user_status.get("email").and_then(|v| v.as_str()) {
        status.metadata.insert("email".to_string(), json!(email));
    }
    if let Some(name) = user_status.get("name").and_then(|v| v.as_str()) {
        status.metadata.insert("name".to_string(), json!(name));
    }

    let plan_name = user_status
        .pointer("/planStatus/planInfo/planName")
        .and_then(|v| v.as_str())
        .unwrap_or("Pro");
    status.metadata.insert("planType".to_string(), json!(plan_name));

    let configs = user_status
        .pointer("/cascadeModelConfigData/clientModelConfigs")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut min_remaining = 1.0f64;
    let mut earliest_reset_ms: Option<i64> = None;
    let mut primary_reset_at: Option<String> = None;

    for cfg in configs {
        let quota = match cfg.get("quotaInfo") {
            Some(q) => q,
            None => continue,
        };
        let rem_fraction = match quota.get("remainingFraction").and_then(|v| v.as_f64()) {
            Some(f) => f.clamp(0.0, 1.0),
            None => continue,
        };

        let label = cfg
            .get("label")
            .and_then(|v| v.as_str())
            .unwrap_or("Model")
            .replace("(Thinking)", "")
            .trim()
            .to_string();

        let reset_time = quota.get("resetTime").and_then(|v| v.as_str()).map(|s| s.to_string());

        let mut time_until_reset_ms: Option<i64> = None;
        if let Some(ref rt) = reset_time {
            if let Ok(parsed) = chrono_parse_rfc3339(rt) {
                let ms = (parsed - now_ms()).max(0);
                time_until_reset_ms = Some(ms);
                if earliest_reset_ms.is_none() || ms < earliest_reset_ms.unwrap() {
                    earliest_reset_ms = Some(ms);
                    primary_reset_at = Some(rt.clone());
                }
            }
        }

        if rem_fraction < min_remaining {
            min_remaining = rem_fraction;
        }

        let usage_pct = ((1.0 - rem_fraction) * 100.0).round();

        status.windows.push(QuotaWindow {
            name: label,
            usage_percent: usage_pct,
            remaining_fraction: rem_fraction,
            resets_at: reset_time,
            time_until_reset_ms,
            is_exhausted: rem_fraction <= 0.0,
        });
    }

    if status.windows.is_empty() {
        status.windows.push(QuotaWindow {
            name: "Primary Quota".to_string(),
            usage_percent: 0.0,
            remaining_fraction: 1.0,
            resets_at: None,
            time_until_reset_ms: None,
            is_exhausted: false,
        });
    }

    let rem_pct = (min_remaining * 100.0).round();
    status.primary_remaining_percent = rem_pct;
    status.primary_usage_percent = 100.0 - rem_pct;
    status.primary_reset_at = primary_reset_at;
    status.time_until_reset_ms = earliest_reset_ms;

    status
}

// ---------------------------------------------------------------------------
// Qoder CLI Quota Adapter
// ---------------------------------------------------------------------------

