use crate::connections::{
    build_connection, connection_id_for, AccountIdentity, ConnectionDraft, ConnectionRecord,
    ConnectionRegistry, EndpointVerification,
};
use crate::logger::log_trace;
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

    // Record the auth methods this poll can see. Identity files and a stored key
    // never verify an endpoint by themselves.
    let google_identity = read_google_identity();
    let google_connection_identity = google_identity.as_ref().map(|identity| AccountIdentity {
        email: Some(identity.email.clone()),
        org_id: None,
        account_id: None,
    });
    if google_identity
        .as_ref()
        .map_or(false, google_identity_is_antigravity_owned)
    {
        record_google_oauth_connection(google_connection_identity.as_ref());
    }
    if antigravity_api_key_present() {
        persist_antigravity_connection("api_key", |registry| {
            record_api_key_selected(registry, &AccountIdentity::default())
        });
    }

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
                        let cli_identity = google_connection_identity.clone().unwrap_or_default();
                        // A successful CLI quota probe also proves Antigravity is
                        // installed, so shared Google files become attributable.
                        record_google_oauth_connection(google_connection_identity.as_ref());
                        persist_antigravity_connection("cli_session", |registry| {
                            record_cli_quota_probe(registry, &cli_identity)
                        });
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

    let rpc_email = user_status
        .get("email")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let rpc_identity = AccountIdentity {
        email: rpc_email.or_else(|| {
            google_connection_identity
                .as_ref()
                .and_then(|identity| identity.email.clone())
        }),
        org_id: None,
        account_id: None,
    };
    // The RPC responds, so Antigravity is present. Google files are still
    // identity only, and the RPC verifies the quota route, not CLI chat or ACP.
    record_google_oauth_connection(google_connection_identity.as_ref());
    persist_antigravity_connection("local_rpc", |registry| {
        record_local_rpc_probe(registry, &rpc_identity)
    });

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
// Antigravity connections
//
// One connection is one account plus one auth method. API key, ACP, Google
// OAuth, the CLI session, and the local language server each get their own
// connection, and each one verifies only the endpoints it actually served.
// ---------------------------------------------------------------------------

/// Quota through the `agy` CLI print mode.
pub const ANTIGRAVITY_CLI_QUOTA_ENDPOINT: &str = "cli:agy -p /usage";
/// Chat through `agy -p`. A quota probe does not verify this route.
pub const ANTIGRAVITY_CLI_CHAT_ENDPOINT: &str = "cli:agy -p";
/// Quota through the local language server, authenticated with
/// `X-Codeium-Csrf-Token`.
pub const ANTIGRAVITY_RPC_QUOTA_ENDPOINT: &str = "rpc:LanguageServerService/GetUserStatus";
/// ACP session route used by the subscription auth method.
pub const ANTIGRAVITY_ACP_CHAT_ENDPOINT: &str = "acp:session/new";

const ANTIGRAVITY_DRIVER_KIND: &str = "antigravity";

/// Every way into Antigravity. They verify different endpoints, so they are
/// stored as separate connections even when they share one account.
pub const ANTIGRAVITY_AUTH_METHODS: &[&str] = &[
    "api_key",
    "cli_session",
    "local_rpc",
    "google_oauth",
    "acp",
];

fn record_cli_quota_probe(
    registry: &mut ConnectionRegistry,
    identity: &AccountIdentity,
) -> Result<ConnectionRecord, String> {
    // `agy -p /usage` proves the CLI is signed in. It says nothing about
    // `agy -p` chat, so only the quota endpoint is written here.
    upsert_antigravity_connection(
        registry,
        "cli_session",
        identity,
        Some((ANTIGRAVITY_CLI_QUOTA_ENDPOINT, true, None)),
        "error",
    )
}

fn record_local_rpc_probe(
    registry: &mut ConnectionRegistry,
    identity: &AccountIdentity,
) -> Result<ConnectionRecord, String> {
    // The language server RPC is its own route. RPC success never verifies the
    // CLI chat route, and it is not an ACP session.
    upsert_antigravity_connection(
        registry,
        "local_rpc",
        identity,
        Some((ANTIGRAVITY_RPC_QUOTA_ENDPOINT, true, None)),
        "error",
    )
}

fn record_google_identity_probe(
    registry: &mut ConnectionRegistry,
    identity: &AccountIdentity,
) -> Result<ConnectionRecord, String> {
    // Google files and the Windows credential are identity. They are stored
    // without endpoints because Kite does not send that token anywhere.
    upsert_antigravity_connection(registry, "google_oauth", identity, None, "identity_only")
}

fn record_api_key_selected(
    registry: &mut ConnectionRegistry,
    identity: &AccountIdentity,
) -> Result<ConnectionRecord, String> {
    // A stored key identifies a connection but verifies no route by itself.
    upsert_antigravity_connection(registry, "api_key", identity, None, "unverified")
}

fn record_acp_selected(
    registry: &mut ConnectionRegistry,
    identity: &AccountIdentity,
) -> Result<ConnectionRecord, String> {
    // The method may be selected before any ACP process exists. Selection is
    // not a session, so every endpoint stays `ok = false`.
    upsert_antigravity_connection(registry, "acp", identity, None, "unverified")
}

fn record_acp_session_probe(
    registry: &mut ConnectionRegistry,
    identity: &AccountIdentity,
    session_id: &str,
) -> Result<ConnectionRecord, String> {
    if session_id.trim().is_empty() {
        return Err("antigravity: an ACP session id is required".to_string());
    }
    upsert_antigravity_connection(
        registry,
        "acp",
        identity,
        Some((ANTIGRAVITY_ACP_CHAT_ENDPOINT, true, None)),
        "error",
    )
}

/// Identity the Google files and the Windows credential expose. It is an
/// identity only: it never proves that an inference endpoint works.
struct GoogleIdentity {
    email: String,
    source: String,
}

fn read_google_identity() -> Option<GoogleIdentity> {
    // Reuse the quota enrichment precedence instead of reading the same files a
    // second way. The metadata it fills is the identity the quota surface shows.
    let mut status = ProviderQuotaStatus {
        provider_id: ANTIGRAVITY_DRIVER_KIND.to_string(),
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
    enrich_google_identity(&mut status);
    let email = status.metadata.get("email")?.as_str()?.trim().to_string();
    if email.is_empty() {
        return None;
    }
    let source = status
        .metadata
        .get("accountSource")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string();
    Some(GoogleIdentity { email, source })
}

/// Shared Gemini CLI files also name an account when no Antigravity install
/// exists. Only an Antigravity-owned source proves Antigravity is present.
fn google_identity_is_antigravity_owned(identity: &GoogleIdentity) -> bool {
    matches!(
        identity.source.as_str(),
        "gemini:antigravity" | "Antigravity IDE"
    )
}

/// Endpoint this auth method proves by itself. A stored API key, a Google
/// account file, or a resolved binary proves identity at most.
fn antigravity_endpoint_supported(auth_method: &str, endpoint_id: &str) -> bool {
    match auth_method {
        "cli_session" => endpoint_id == ANTIGRAVITY_CLI_QUOTA_ENDPOINT,
        "local_rpc" => endpoint_id == ANTIGRAVITY_RPC_QUOTA_ENDPOINT,
        "acp" => endpoint_id == ANTIGRAVITY_ACP_CHAT_ENDPOINT,
        _ => false,
    }
}

fn antigravity_display_name(auth_method: &str) -> &'static str {
    match auth_method {
        "api_key" => "Antigravity API key",
        "cli_session" => "Antigravity CLI",
        "local_rpc" => "Antigravity Language Server",
        "google_oauth" => "Antigravity Google",
        "acp" => "Antigravity ACP",
        _ => "Antigravity",
    }
}

fn antigravity_credential_ref(auth_method: &str) -> &'static str {
    if auth_method == "api_key" {
        "vault"
    } else {
        "cli_file"
    }
}

fn antigravity_billing_mode(auth_method: &str) -> Option<String> {
    match auth_method {
        // An API key is not the subscription path; its entitlement is unknown
        // until an endpoint answers.
        "api_key" => None,
        _ => Some("subscription".to_string()),
    }
}

fn upsert_antigravity_connection(
    registry: &mut ConnectionRegistry,
    auth_method: &str,
    identity: &AccountIdentity,
    probe: Option<(&str, bool, Option<i64>)>,
    unverified_status: &str,
) -> Result<ConnectionRecord, String> {
    if !ANTIGRAVITY_AUTH_METHODS.contains(&auth_method) {
        return Err(format!("antigravity: unknown auth method {auth_method}"));
    }
    if let Some((endpoint_id, _, _)) = probe {
        if !antigravity_endpoint_supported(auth_method, endpoint_id) {
            return Err(format!(
                "antigravity: {auth_method} cannot verify {endpoint_id}"
            ));
        }
    }

    let connection_id = connection_id_for(ANTIGRAVITY_DRIVER_KIND, auth_method, identity);
    let existing = registry.load(&connection_id)?;

    // Merge before saving: keep every endpoint this auth method can own so a
    // probe for one route never drops another verified route.
    let mut endpoints: Vec<EndpointVerification> = existing
        .as_ref()
        .map(|record| record.endpoints.as_slice())
        .unwrap_or_default()
        .iter()
        .filter(|endpoint| antigravity_endpoint_supported(auth_method, &endpoint.endpoint_id))
        .cloned()
        .collect();

    if let Some((endpoint_id, ok, _)) = probe {
        endpoints.retain(|endpoint| endpoint.endpoint_id != endpoint_id);
        endpoints.push(EndpointVerification {
            endpoint_id: endpoint_id.to_string(),
            ok,
        });
    }
    endpoints.sort_by(|left, right| left.endpoint_id.cmp(&right.endpoint_id));

    let built = build_connection(ConnectionDraft {
        driver_kind: ANTIGRAVITY_DRIVER_KIND.to_string(),
        auth_method: auth_method.to_string(),
        account_identity: identity.clone(),
        billing_mode: antigravity_billing_mode(auth_method),
        endpoints,
    });
    for endpoint in &built.rejected {
        log_trace(&format!(
            "antigravity connections: dropped unsupported endpoint {endpoint}"
        ));
    }

    let status = if built.endpoints.iter().any(|endpoint| endpoint.ok) {
        "verified"
    } else {
        unverified_status
    };
    let (last_checked_ms, expires_ms, last_http_status) = match &existing {
        Some(record) => (
            record.last_checked_ms,
            record.expires_ms,
            record.last_http_status,
        ),
        None => (None, None, None),
    };
    let (checked_at, http_status) = match probe {
        Some((_, _, http_status)) => (Some(now_ms()), http_status),
        None => (last_checked_ms, last_http_status),
    };

    let record = ConnectionRecord {
        connection_id: built.connection_id,
        driver_kind: ANTIGRAVITY_DRIVER_KIND.to_string(),
        display_name: antigravity_display_name(auth_method).to_string(),
        auth_method: auth_method.to_string(),
        account_identity: identity.clone(),
        credential_ref: antigravity_credential_ref(auth_method).to_string(),
        billing_mode: antigravity_billing_mode(auth_method),
        endpoints: built.endpoints,
        status: status.to_string(),
        last_checked_ms: checked_at,
        expires_ms,
        last_http_status: http_status,
    };
    registry.save(&record)?;
    Ok(record)
}

/// Persists one connection and logs the error instead of failing the quota
/// call. The named probe builders below are the only writers.
fn persist_antigravity_connection<F>(label: &str, persist: F)
where
    F: FnOnce(&mut ConnectionRegistry) -> Result<ConnectionRecord, String>,
{
    let result = ConnectionRegistry::open().and_then(|mut registry| persist(&mut registry));
    if let Err(error) = result {
        log_trace(&format!("antigravity connections: {label}: {error}"));
    }
}

fn record_google_oauth_connection(identity: Option<&AccountIdentity>) {
    if let Some(identity) = identity {
        persist_antigravity_connection("google_oauth", |registry| {
            record_google_identity_probe(registry, identity)
        });
    }
}

/// Records the ACP subscription method as selected. Resolving a binary or
/// selecting the method is not a session, so this never marks an endpoint `ok`.
pub fn select_antigravity_acp_connection(
    identity: &AccountIdentity,
) -> Result<ConnectionRecord, String> {
    let mut registry = ConnectionRegistry::open()?;
    record_acp_selected(&mut registry, identity)
}

/// Records a verified ACP endpoint. Call it only after the ACP process returns a
/// session id, never from the binary resolver.
pub fn record_antigravity_acp_session_established(
    identity: &AccountIdentity,
    session_id: &str,
) -> Result<ConnectionRecord, String> {
    let mut registry = ConnectionRegistry::open()?;
    record_acp_session_probe(&mut registry, identity, session_id)
}

fn antigravity_api_key_present() -> bool {
    if crate::credentials::get_vault_credential(ANTIGRAVITY_DRIVER_KIND)
        .map_or(false, |key| !key.trim().is_empty())
    {
        return true;
    }
    let connection_id =
        connection_id_for(ANTIGRAVITY_DRIVER_KIND, "api_key", &AccountIdentity::default());
    ConnectionRegistry::open()
        .ok()
        .and_then(|registry| registry.get_secret(&connection_id))
        .is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connections::{connection_id_for, ConnectionRegistry};

    struct TempAppData(PathBuf);

    impl TempAppData {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "kite-antigravity-connections-{}",
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&dir).expect("create temp app data");
            Self(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempAppData {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn account(email: &str) -> AccountIdentity {
        AccountIdentity {
            email: Some(email.to_string()),
            org_id: None,
            account_id: None,
        }
    }

    /// RPC success is quota evidence for the language server only. The chat
    /// route stays unverified even though both talk to the same product.
    #[test]
    fn rpc_quota_success_does_not_verify_the_cli_chat_endpoint() {
        let temp = TempAppData::new();
        let identity = account("rpc@example.com");
        let mut registry = ConnectionRegistry::open_at(temp.path()).expect("open registry");

        let recorded = record_local_rpc_probe(&mut registry, &identity).expect("record RPC probe");

        assert_eq!(recorded.auth_method, "local_rpc");
        assert_eq!(recorded.status, "verified");
        assert!(recorded
            .endpoints
            .iter()
            .any(|endpoint| endpoint.endpoint_id == ANTIGRAVITY_RPC_QUOTA_ENDPOINT && endpoint.ok));
        assert!(!recorded
            .endpoints
            .iter()
            .any(|endpoint| endpoint.endpoint_id == ANTIGRAVITY_CLI_CHAT_ENDPOINT));
        assert!(!recorded
            .endpoints
            .iter()
            .any(|endpoint| endpoint.endpoint_id == ANTIGRAVITY_CLI_QUOTA_ENDPOINT));

        let stored = registry
            .load(&connection_id_for("antigravity", "local_rpc", &identity))
            .expect("load connection")
            .expect("stored connection");
        assert_eq!(stored, recorded);

        for connection in registry.list().expect("list connections") {
            assert!(
                !connection
                    .endpoints
                    .iter()
                    .any(|endpoint| endpoint.endpoint_id == ANTIGRAVITY_CLI_CHAT_ENDPOINT && endpoint.ok),
                "{} must not claim CLI chat",
                connection.connection_id
            );
        }
    }

    /// Selecting the ACP auth method is not an ACP session. Endpoints stay
    /// unverified until a handshake actually succeeds.
    #[test]
    fn selecting_acp_without_a_session_leaves_endpoints_unverified() {
        let temp = TempAppData::new();
        let identity = account("acp@example.com");
        let mut registry = ConnectionRegistry::open_at(temp.path()).expect("open registry");

        let selected = record_acp_selected(&mut registry, &identity).expect("select ACP");

        assert_eq!(selected.auth_method, "acp");
        assert_eq!(selected.billing_mode.as_deref(), Some("subscription"));
        assert_eq!(selected.status, "unverified");
        assert!(selected.endpoints.iter().all(|endpoint| !endpoint.ok));
        assert!(!selected
            .endpoints
            .iter()
            .any(|endpoint| endpoint.endpoint_id == ANTIGRAVITY_ACP_CHAT_ENDPOINT && endpoint.ok));

        let stored = registry
            .load(&selected.connection_id)
            .expect("load connection")
            .expect("stored connection");
        assert_eq!(stored, selected);
    }

    /// A real ACP session is the only path that verifies the ACP endpoint, and
    /// re-selecting the method must not drop that verification.
    #[test]
    fn only_an_established_acp_session_verifies_the_acp_endpoint() {
        let temp = TempAppData::new();
        let identity = account("acp@example.com");
        let mut registry = ConnectionRegistry::open_at(temp.path()).expect("open registry");

        record_acp_selected(&mut registry, &identity).expect("select ACP");
        let verified =
            record_acp_session_probe(&mut registry, &identity, "session-1").expect("record session");

        assert_eq!(verified.status, "verified");
        assert!(verified
            .endpoints
            .iter()
            .any(|endpoint| endpoint.endpoint_id == ANTIGRAVITY_ACP_CHAT_ENDPOINT && endpoint.ok));

        let reselected = record_acp_selected(&mut registry, &identity).expect("select again");
        assert!(reselected
            .endpoints
            .iter()
            .any(|endpoint| endpoint.endpoint_id == ANTIGRAVITY_ACP_CHAT_ENDPOINT && endpoint.ok));
        assert_eq!(reselected.status, "verified");
        assert!(record_acp_session_probe(&mut registry, &identity, "  ").is_err());
    }

    /// API key, CLI session, Google identity, RPC, and ACP for one account are
    /// five connections, never one driver-wide row.
    #[test]
    fn antigravity_auth_methods_keep_separate_connections() {
        let temp = TempAppData::new();
        let identity = account("user@example.com");
        let mut registry = ConnectionRegistry::open_at(temp.path()).expect("open registry");

        record_cli_quota_probe(&mut registry, &identity).expect("record CLI");
        record_local_rpc_probe(&mut registry, &identity).expect("record RPC");
        record_google_identity_probe(&mut registry, &identity).expect("record Google");
        record_acp_selected(&mut registry, &identity).expect("select ACP");
        record_api_key_selected(&mut registry, &AccountIdentity::default()).expect("record API key");

        let records = registry.list().expect("list connections");
        assert_eq!(records.len(), 5);
        let mut ids: Vec<&str> = records.iter().map(|record| record.connection_id.as_str()).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), 5);

        for expected in ANTIGRAVITY_AUTH_METHODS {
            assert!(
                records.iter().any(|record| record.auth_method == *expected),
                "missing {expected} connection"
            );
        }

        let google = records
            .iter()
            .find(|record| record.auth_method == "google_oauth")
            .expect("google connection");
        assert!(google.endpoints.is_empty(), "identity must not verify an endpoint");
        let api_key = records
            .iter()
            .find(|record| record.auth_method == "api_key")
            .expect("api key connection");
        assert!(api_key.endpoints.is_empty());

        let cli = records
            .iter()
            .find(|record| record.auth_method == "cli_session")
            .expect("cli connection");
        assert!(cli
            .endpoints
            .iter()
            .any(|endpoint| endpoint.endpoint_id == ANTIGRAVITY_CLI_QUOTA_ENDPOINT && endpoint.ok));
        assert!(!cli
            .endpoints
            .iter()
            .any(|endpoint| endpoint.endpoint_id == ANTIGRAVITY_CLI_CHAT_ENDPOINT && endpoint.ok));

        let acp = records
            .iter()
            .find(|record| record.auth_method == "acp")
            .expect("acp connection");
        assert!(acp.endpoints.iter().all(|endpoint| !endpoint.ok));
    }
}

// ---------------------------------------------------------------------------
// Qoder CLI Quota Adapter
// ---------------------------------------------------------------------------

