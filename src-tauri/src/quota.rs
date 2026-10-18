use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[allow(unused_mut)]
fn silent_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaWindow {
    pub name: String,
    pub usage_percent: f64,
    pub remaining_fraction: f64,
    pub resets_at: Option<String>,
    pub time_until_reset_ms: Option<i64>,
    pub is_exhausted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderQuotaStatus {
    pub provider_id: String,
    pub display_name: String,
    pub is_available: bool,
    pub is_auth: bool,
    pub primary_usage_percent: f64,
    pub primary_remaining_percent: f64,
    pub primary_reset_at: Option<String>,
    pub time_until_reset_ms: Option<i64>,
    pub windows: Vec<QuotaWindow>,
    pub metadata: HashMap<String, Value>,
    pub last_updated_ms: i64,
    pub error: Option<String>,
}

struct QuotaCache {
    entries: HashMap<String, (Instant, ProviderQuotaStatus)>,
}

static CACHE: Mutex<Option<QuotaCache>> = Mutex::new(None);
const CACHE_TTL_SECS: u64 = 180;
static IS_REFRESHING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn quota_cache_path() -> PathBuf {
    let base = if let Ok(appdata) = std::env::var("APPDATA") {
        PathBuf::from(appdata)
    } else {
        user_home_dir().join("AppData").join("Roaming")
    };
    let dir = base.join("Kite Code");
    let _ = std::fs::create_dir_all(&dir);
    dir.join("quota_cache.json")
}

fn load_persisted_cache() -> HashMap<String, (Instant, ProviderQuotaStatus)> {
    let p = quota_cache_path();
    let mut map = HashMap::new();
    if let Ok(data) = std::fs::read(&p) {
        if let Ok(saved) = serde_json::from_slice::<HashMap<String, ProviderQuotaStatus>>(&data) {
            for (k, v) in saved {
                map.insert(k, (Instant::now(), v));
            }
        }
    }
    map
}

fn save_persisted_cache(cache: &QuotaCache) {
    let p = quota_cache_path();
    let mut to_save = HashMap::new();
    for (k, (_, v)) in &cache.entries {
        to_save.insert(k.clone(), v.clone());
    }
    if let Ok(bytes) = serde_json::to_vec_pretty(&to_save) {
        let _ = std::fs::write(p, bytes);
    }
}

pub fn get_cached_provider_status(provider: &str) -> Option<ProviderQuotaStatus> {
    let mut cache_guard = CACHE.lock().ok()?;
    if cache_guard.is_none() {
        *cache_guard = Some(QuotaCache {
            entries: load_persisted_cache(),
        });
    }
    let cache = cache_guard.as_ref()?;
    cache.entries.get(provider).map(|(_, s)| s.clone())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn user_home_dir() -> PathBuf {
    if let Ok(profile) = std::env::var("USERPROFILE") {
        PathBuf::from(profile)
    } else if let Ok(home) = std::env::var("HOME") {
        PathBuf::from(home)
    } else {
        PathBuf::from(".")
    }
}

// ---------------------------------------------------------------------------
// 1. Antigravity Quota Adapter
// ---------------------------------------------------------------------------

struct AntigravityProcessInfo {
    pid: u32,
    csrf_token: String,
    port: u16,
}

fn detect_antigravity_process() -> Option<AntigravityProcessInfo> {
    #[cfg(target_os = "windows")]
    {
        if let Ok(out) = silent_command("tasklist").args(["/FO", "CSV", "/NH"]).output() {
            let list_str = String::from_utf8_lossy(&out.stdout).to_lowercase();
            if !list_str.contains("language_server") && !list_str.contains("antigravity") {
                return None;
            }
        }

        let ps_cmd = r#"Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and ($_.CommandLine -like '*antigravity*' -or $_.Name -like '*language_server*') } | Select-Object ProcessId, Name, CommandLine | ConvertTo-Json -Compress"#;
        let output = silent_command("powershell")
            .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", ps_cmd])
            .output()
            .ok()?;

        if !output.status.success() {
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
        if let Ok(out) = silent_command("netstat").args(["-ano"]).output() {
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
        if let Ok(out) = silent_command("powershell")
            .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", &ps_cmd])
            .output()
        {
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

fn enrich_google_identity(status: &mut ProviderQuotaStatus) {
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

    // 1. Primary Strategy: Antigravity CLI print-mode slash command (matching DevHub/Orca)
    // Runs `agy -p /usage --output-format json --print-timeout 12s`
    //
    // The probe runs inside a *hidden* console (`crate::hidden_exec`). `agy`
    // boots its configured MCP servers and helper processes on every run; when
    // the CLI is started with no console at all, those console children create
    // their own console and Windows shows it as an external terminal window for
    // a few milliseconds. Giving the CLI an invisible console keeps the whole
    // tree attached to it, so nothing can pop up while quotas are polled.
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

fn format_unix_to_rfc3339(ms: i64) -> String {
    let total_sec = ms / 1000;
    let days = total_sec / 86400;
    let rem_sec = total_sec % 86400;
    let hour = rem_sec / 3600;
    let min = (rem_sec % 3600) / 60;
    let sec = rem_sec % 60;

    let mut y = 1970;
    let mut d = days;
    loop {
        let leap = (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0);
        let days_in_y = if leap { 366 } else { 365 };
        if d < days_in_y {
            break;
        }
        d -= days_in_y;
        y += 1;
    }
    let leap = (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0);
    let days_in_m = [
        31,
        if leap { 29 } else { 28 },
        31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
    ];
    let mut m = 1;
    for &dim in &days_in_m {
        if d < dim {
            break;
        }
        d -= dim;
        m += 1;
    }
    let day = d + 1;
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, m, day, hour, min, sec)
}

fn parse_qoder_log_tail(path: &std::path::Path) -> Option<(Value, Option<String>)> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path).ok()?;
    let meta = file.metadata().ok()?;
    let file_len = meta.len();
    let max_tail: u64 = 256 * 1024;
    let start_pos = if file_len > max_tail { file_len - max_tail } else { 0 };
    file.seek(SeekFrom::Start(start_pos)).ok()?;

    let mut buffer = Vec::new();
    file.read_to_end(&mut buffer).ok()?;
    let content = String::from_utf8_lossy(&buffer);

    for line in content.lines().rev() {
        if line.contains("[qoderApi]") && line.contains("quota/usage response:") {
            if let Some(pos) = line.find('{') {
                let json_slice = &line[pos..];
                if let Ok(val) = serde_json::from_str::<Value>(json_slice) {
                    let ts = line.split_whitespace().next().map(|s| s.to_string());
                    return Some((val, ts));
                }
            }
        }
    }
    None
}

pub fn fetch_qoder_quota() -> ProviderQuotaStatus {
    let mut status = ProviderQuotaStatus {
        provider_id: "qoder".to_string(),
        display_name: "Qoder".to_string(),
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

    let home = user_home_dir();
    let qoder_dir = home.join(".qoder");
    let runs_dir = qoder_dir.join("logs").join("runs");

    if !qoder_dir.exists() {
        status.error = Some("Qoder no encontrado (~/.qoder)".to_string());
        return status;
    }

    status.is_available = true;

    if !runs_dir.exists() {
        status.error = Some("No se encontraron registros de Qoder en ~/.qoder/logs/runs".to_string());
        return status;
    }

    let mut log_files: Vec<(PathBuf, SystemTime)> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&runs_dir) {
        for entry in entries.flatten() {
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                let log_file = entry.path().join("qodercli.log");
                if log_file.exists() {
                    if let Ok(meta) = log_file.metadata() {
                        let mtime = meta.modified().unwrap_or(UNIX_EPOCH);
                        log_files.push((log_file, mtime));
                    }
                }
            }
        }
    }

    log_files.sort_by(|a, b| b.1.cmp(&a.1));

    let mut found: Option<(Value, Option<String>)> = None;
    for (file_path, _) in log_files.iter().take(60) {
        if let Some(res) = parse_qoder_log_tail(file_path) {
            found = Some(res);
            break;
        }
    }

    let (payload, timestamp) = match found {
        Some(p) => p,
        None => {
            status.error = Some("No se encontraron datos de cuota en logs de Qoder. Ejecuta 'qodercli'.".to_string());
            return status;
        }
    };

    status.is_auth = true;

    let expires_at_num = payload.get("expiresAt").and_then(|v| v.as_i64()).unwrap_or(0);
    let mut reset_at: Option<String> = None;
    let mut reset_ms: Option<i64> = None;

    if expires_at_num > 0 && expires_at_num < 4102444800000 {
        reset_at = Some(format_unix_to_rfc3339(expires_at_num));
        let ms = (expires_at_num - now_ms()).max(0);
        reset_ms = Some(ms);
    }

    let mut plan_usage = 0.0f64;
    if let Some(plan_quota) = payload.get("userQuota") {
        let total = plan_quota.get("total").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let used = plan_quota.get("used").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let pct = if total > 0.0 {
            (used / total * 100.0).clamp(0.0, 100.0)
        } else {
            plan_quota.get("percentage").and_then(|v| v.as_f64()).map(|p| if p <= 1.0 { p * 100.0 } else { p }).unwrap_or(0.0)
        };
        plan_usage = pct;
        status.windows.push(QuotaWindow {
            name: "Plan credits".to_string(),
            usage_percent: (pct * 10.0).round() / 10.0,
            remaining_fraction: ((100.0 - pct) / 100.0).clamp(0.0, 1.0),
            resets_at: reset_at.clone(),
            time_until_reset_ms: reset_ms,
            is_exhausted: pct >= 100.0,
        });

        status.metadata.insert("planCredits".to_string(), json!({
            "total": total,
            "used": used,
            "remaining": (total - used).max(0.0),
        }));
    }

    if let Some(addon) = payload.get("addOnQuota") {
        let total = addon.get("total").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let used = addon.get("used").and_then(|v| v.as_f64()).unwrap_or(0.0);
        if total > 0.0 {
            let pct = (used / total * 100.0).clamp(0.0, 100.0);
            status.windows.push(QuotaWindow {
                name: "Add-on credits".to_string(),
                usage_percent: (pct * 10.0).round() / 10.0,
                remaining_fraction: ((100.0 - pct) / 100.0).clamp(0.0, 1.0),
                resets_at: None,
                time_until_reset_ms: None,
                is_exhausted: pct >= 100.0,
            });
            status.metadata.insert("addOnCredits".to_string(), json!({
                "total": total,
                "used": used,
                "remaining": (total - used).max(0.0),
            }));
        }
    }

    let primary_usage = payload
        .get("totalUsagePercentage")
        .and_then(|v| v.as_f64())
        .map(|p| if p <= 1.0 { p * 100.0 } else { p })
        .unwrap_or(plan_usage);

    status.primary_usage_percent = (primary_usage * 10.0).round() / 10.0;
    status.primary_remaining_percent = ((100.0 - primary_usage) * 10.0).round() / 10.0;
    status.primary_reset_at = reset_at;
    status.time_until_reset_ms = reset_ms;

    if let Some(ut) = payload.get("userType").and_then(|v| v.as_str()) {
        status.metadata.insert("userType".to_string(), json!(ut));
    }
    if let Some(url) = payload.get("upgradeUrl").and_then(|v| v.as_str()) {
        status.metadata.insert("upgradeUrl".to_string(), json!(url));
    }
    status.metadata.insert("dataSource".to_string(), json!("cli-log"));
    if let Some(ts) = timestamp {
        status.metadata.insert("dataAsOf".to_string(), json!(ts));
    }

    status
}

// ---------------------------------------------------------------------------
// 2. Claude Code Quota Adapter
// ---------------------------------------------------------------------------

pub fn fetch_claude_quota() -> ProviderQuotaStatus {
    let mut status = ProviderQuotaStatus {
        provider_id: "claude".to_string(),
        display_name: "Claude Code".to_string(),
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

    let home = user_home_dir();
    let creds_file = home.join(".claude").join(".credentials.json");
    let token_file = home.join(".claude").join(".token");

    let mut token: Option<String> = std::env::var("ANTHROPIC_OAUTH_TOKEN")
        .or_else(|_| std::env::var("CLAUDE_CODE_TOKEN"))
        .ok();

    if token.is_none() && creds_file.exists() {
        if let Ok(content) = std::fs::read_to_string(&creds_file) {
            if let Ok(val) = serde_json::from_str::<Value>(&content) {
                if let Some(t) = val.pointer("/claudeAiOauth/accessToken").and_then(|v| v.as_str()) {
                    token = Some(t.to_string());
                }
            }
        }
    }

    if token.is_none() && token_file.exists() {
        if let Ok(content) = std::fs::read_to_string(&token_file) {
            let trimmed = content.trim();
            if !trimmed.is_empty() {
                if trimmed.starts_with('{') {
                    if let Ok(val) = serde_json::from_str::<Value>(trimmed) {
                        token = val.get("accessToken")
                            .or_else(|| val.get("oauth_token"))
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string());
                    }
                } else {
                    token = Some(trimmed.to_string());
                }
            }
        }
    }

    let claude_dir = home.join(".claude");
    let is_installed = claude_dir.exists();
    if is_installed {
        status.is_available = true;
        status.metadata.insert("source".to_string(), json!("~/.claude/"));
        status.metadata.insert("loginCommand".to_string(), json!("claude login"));
    }

    let token = match token {
        Some(t) => t,
        None => {
            if is_installed {
                status.is_auth = false;
                status.error = Some("Claude Code instalado pero sin sesión activa. Ejecuta 'claude login' en la terminal.".to_string());
            } else {
                status.error = Some("Claude Code no encontrado (~/.claude)".to_string());
            }
            return status;
        }
    };

    status.is_available = true;
    status.is_auth = true;

    let auth_header = format!("Authorization: Bearer {}", token);
    let output = silent_command("curl.exe")
        .args([
            "-s",
            "https://api.anthropic.com/api/oauth/usage",
            "-H",
            &auth_header,
            "-H",
            "anthropic-version: 2023-06-01",
            "--max-time",
            "5",
        ])
        .output();

    if let Ok(out) = output {
        if out.status.success() {
            let body = String::from_utf8_lossy(&out.stdout);
            if let Ok(data) = serde_json::from_str::<Value>(&body) {
                let window_defs = [
                    ("five_hour", "5-Hour Limit"),
                    ("seven_day", "Weekly All-Model"),
                    ("seven_day_sonnet", "Weekly Sonnet"),
                    ("monthly_limit", "Monthly Limit"),
                ];

                let mut max_usage = 0.0f64;
                let mut earliest_reset: Option<i64> = None;
                let mut primary_reset_at: Option<String> = None;

                for (key, label) in window_defs {
                    if let Some(entry) = data.get(key) {
                        if let Some(util) = entry.get("utilization").and_then(|v| v.as_f64()) {
                            let usage_pct = (util * 100.0).clamp(0.0, 100.0);
                            let remaining_fraction = (1.0 - util).clamp(0.0, 1.0);
                            let resets_at = entry.get("resets_at").and_then(|v| v.as_str()).map(|s| s.to_string());

                            let mut time_until_reset_ms: Option<i64> = None;
                            if let Some(ref rt) = resets_at {
                                if let Ok(parsed) = chrono_parse_rfc3339(rt) {
                                    let ms = (parsed - now_ms()).max(0);
                                    time_until_reset_ms = Some(ms);
                                    if earliest_reset.is_none() || ms < earliest_reset.unwrap() {
                                        earliest_reset = Some(ms);
                                        primary_reset_at = Some(rt.clone());
                                    }
                                }
                            }

                            if usage_pct > max_usage {
                                max_usage = usage_pct;
                            }

                            status.windows.push(QuotaWindow {
                                name: label.to_string(),
                                usage_percent: (usage_pct * 10.0).round() / 10.0,
                                remaining_fraction: (remaining_fraction * 100.0).round() / 100.0,
                                resets_at,
                                time_until_reset_ms,
                                is_exhausted: usage_pct >= 100.0,
                            });
                        }
                    }
                }

                let rem = (100.0 - max_usage).clamp(0.0, 100.0);
                status.primary_usage_percent = (max_usage * 10.0).round() / 10.0;
                status.primary_remaining_percent = (rem * 10.0).round() / 10.0;
                status.primary_reset_at = primary_reset_at;
                status.time_until_reset_ms = earliest_reset;
                return status;
            }
        }
    }

    status.is_auth = false;
    status.error = Some("Sesión de Claude Code expirada. Ejecuta 'claude login' en la terminal.".to_string());
    status
}

// ---------------------------------------------------------------------------
// 3. OpenAI Codex Quota Adapter
// ---------------------------------------------------------------------------

pub fn fetch_codex_quota() -> ProviderQuotaStatus {
    let mut status = ProviderQuotaStatus {
        provider_id: "codex".to_string(),
        display_name: "Codex".to_string(),
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

    let home = user_home_dir();
    let auth_file = home.join(".codex").join("auth.json");
    let config_file = home.join(".codex").join("config.toml");
    let is_installed = home.join(".codex").exists() || config_file.exists();

    if is_installed {
        status.is_available = true;
        status.metadata.insert("source".to_string(), json!("~/.codex/config.toml"));
    }

    let mut access_token: Option<String> = std::env::var("CODEX_ACCESS_TOKEN")
        .or_else(|_| std::env::var("CODEX_TOKEN"))
        .ok();
    let mut account_id: Option<String> = std::env::var("CODEX_ACCOUNT_ID").ok();

    if access_token.is_none() && auth_file.exists() {
        if let Ok(content) = std::fs::read_to_string(&auth_file) {
            if let Ok(val) = serde_json::from_str::<Value>(&content) {
                access_token = val.pointer("/tokens/access_token")
                    .or_else(|| val.get("access_token"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                account_id = val.pointer("/tokens/account_id")
                    .or_else(|| val.get("account_id"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
            }
        }
    }

    let token = match access_token {
        Some(t) => t,
        None => {
            if is_installed {
                status.is_auth = false;
                status.error = Some("Sesión OAuth de Codex no iniciada. Ejecuta 'codex login' en la terminal para conectar tu cuenta.".to_string());
                status.metadata.insert("loginCommand".to_string(), json!("codex login"));
            } else {
                status.error = Some("Codex no encontrado (~/.codex)".to_string());
            }
            return status;
        }
    };

    status.is_auth = true;

    let urls = [
        "https://chatgpt.com/backend-api/wham/usage",
        "https://chatgpt.com/api/codex/usage",
    ];

    let auth_header = format!("Authorization: Bearer {}", token);
    for u in &urls {
        let mut cmd = silent_command("curl.exe");
        cmd.args([
            "-s",
            u,
            "-H",
            &auth_header,
            "-H",
            "Accept: application/json",
            "-H",
            "User-Agent: Kite-QuotaEngine/1.0",
            "--max-time",
            "5",
        ]);
        if let Some(ref acc) = account_id {
            cmd.args(["-H", &format!("ChatGPT-Account-Id: {}", acc)]);
        }

        if let Ok(out) = cmd.output() {
            if out.status.success() {
                let body = String::from_utf8_lossy(&out.stdout);
                if let Ok(data) = serde_json::from_str::<Value>(&body) {
                    if data.get("rate_limit").is_some() || data.get("plan_type").is_some() {
                        return apply_codex_usage_payload(status, &data);
                    }
                }
            }
        }
    }

    status.error = Some("No se pudo obtener datos de uso de OpenAI Codex".to_string());
    status
}

fn apply_codex_usage_payload(mut status: ProviderQuotaStatus, data: &Value) -> ProviderQuotaStatus {
    if let Some(plan) = data.get("plan_type").and_then(|v| v.as_str()) {
        status.metadata.insert("planType".to_string(), json!(plan));
    }

    let mut max_used = 0.0f64;
    let mut earliest_reset: Option<i64> = None;
    let mut primary_reset_at: Option<String> = None;

    let windows_to_check = [
        ("primary_window", "5-Hour Session"),
        ("secondary_window", "Weekly Cap"),
    ];

    for (sub_key, label) in windows_to_check {
        if let Some(win) = data.pointer(&format!("/rate_limit/{}", sub_key)) {
            if let Some(used) = win.get("used_percent").and_then(|v| v.as_f64()) {
                let reset_sec = win.get("reset_at").and_then(|v| v.as_i64()).unwrap_or(0);
                let reset_ms = if reset_sec > 0 {
                    (reset_sec * 1000 - now_ms()).max(0)
                } else {
                    0
                };

                if reset_ms > 0 && (earliest_reset.is_none() || reset_ms < earliest_reset.unwrap()) {
                    earliest_reset = Some(reset_ms);
                    primary_reset_at = Some(format_unix_to_iso(reset_sec * 1000));
                }

                if used > max_used {
                    max_used = used;
                }

                status.windows.push(QuotaWindow {
                    name: label.to_string(),
                    usage_percent: used,
                    remaining_fraction: ((100.0 - used) / 100.0).clamp(0.0, 1.0),
                    resets_at: if reset_sec > 0 { Some(format_unix_to_iso(reset_sec * 1000)) } else { None },
                    time_until_reset_ms: if reset_ms > 0 { Some(reset_ms) } else { None },
                    is_exhausted: used >= 100.0,
                });
            }
        }
    }

    if let Some(rev) = data.pointer("/code_review_rate_limit/primary_window") {
        if let Some(used) = rev.get("used_percent").and_then(|v| v.as_f64()) {
            status.windows.push(QuotaWindow {
                name: "Review Requests".to_string(),
                usage_percent: used,
                remaining_fraction: ((100.0 - used) / 100.0).clamp(0.0, 1.0),
                resets_at: None,
                time_until_reset_ms: None,
                is_exhausted: used >= 100.0,
            });
        }
    }

    if let Some(bal) = data.pointer("/credits/balance").and_then(|v| v.as_f64()) {
        status.metadata.insert("creditsBalance".to_string(), json!(bal));
    }

    status.primary_usage_percent = max_used;
    status.primary_remaining_percent = (100.0 - max_used).clamp(0.0, 100.0);
    status.primary_reset_at = primary_reset_at;
    status.time_until_reset_ms = earliest_reset;
    status
}

// ---------------------------------------------------------------------------
// 4. OpenCode & Grok Adapters
// ---------------------------------------------------------------------------

pub fn fetch_opencode_quota() -> ProviderQuotaStatus {
    let mut status = ProviderQuotaStatus {
        provider_id: "opencode".to_string(),
        display_name: "OpenCode".to_string(),
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

    let home = user_home_dir();
    let opencode_dir = home.join(".opencode");
    let kite_quota_cfg = home.join(".kite").join("opencode-go-quota.json");
    let devhub_quota_cfg = home.join(".devhub").join("opencode-go-quota.json");

    let mut auth_cookie: Option<String> = std::env::var("OPENCODE_GO_AUTH_COOKIE").ok();
    let mut workspace_id: Option<String> = std::env::var("OPENCODE_GO_WORKSPACE_ID").ok();

    for cfg_file in [&kite_quota_cfg, &devhub_quota_cfg] {
        if auth_cookie.is_none() && cfg_file.exists() {
            if let Ok(content) = std::fs::read_to_string(cfg_file) {
                if let Ok(val) = serde_json::from_str::<Value>(&content) {
                    auth_cookie = val.get("authCookie").and_then(|v| v.as_str()).map(|s| s.to_string());
                    if workspace_id.is_none() {
                        workspace_id = val.get("workspaceId").and_then(|v| v.as_str()).map(|s| s.to_string());
                    }
                }
            }
        }
    }

    if opencode_dir.exists() || auth_cookie.is_some() {
        status.is_available = true;
    }

    if let Some(_cookie) = auth_cookie {
        status.is_available = true;
        status.is_auth = true;
        if let Some(ref w) = workspace_id {
            status.metadata.insert("workspaceId".to_string(), json!(w));
        }
        status.metadata.insert("source".to_string(), json!("Cookie de consola OpenCode Go configurada"));

        status.windows.push(QuotaWindow {
            name: "OpenCode Go (Consola activa)".to_string(),
            usage_percent: 0.0,
            remaining_fraction: 1.0,
            resets_at: None,
            time_until_reset_ms: None,
            is_exhausted: false,
        });
        return status;
    }

    if opencode_dir.exists() {
        status.is_auth = true;
        status.windows.push(QuotaWindow {
            name: "OpenCode CLI Local".to_string(),
            usage_percent: 0.0,
            remaining_fraction: 1.0,
            resets_at: None,
            time_until_reset_ms: None,
            is_exhausted: false,
        });
        return status;
    }

    status.error = Some("OpenCode Go no configurado. Ingresa tu cookie de consola en la configuración.".to_string());
    status
}

/// Calls the Grok CLI proxy billing endpoint. Returns (http_status, body).
fn grok_billing_request(url: &str, token: &str, user_id: Option<&str>) -> Option<(u16, String)> {
    let mut cmd = silent_command("curl.exe");
    cmd.args([
        "-s",
        "-w",
        "\n%{http_code}",
        url,
        "-H",
        &format!("Authorization: Bearer {}", token),
        "-H",
        "X-XAI-Token-Auth: xai-grok-cli",
        "-H",
        "Accept: application/json",
        "--max-time",
        "8",
    ]);
    if let Some(uid) = user_id {
        cmd.args(["-H", &format!("x-userid: {}", uid)]);
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let out = cmd.output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let (body, code) = text.rsplit_once('\n')?;
    let code: u16 = code.trim().parse().ok()?;
    if code == 0 {
        return None;
    }
    Some((code, body.to_string()))
}

fn grok_money(v: Option<&Value>) -> Option<f64> {
    let v = v?.get("val")?;
    v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse::<f64>().ok()))
}

/// Maps a Grok billing config onto a quota window. Returns true when a real
/// usage figure was found (weekly percent first, then monthly limit/used).
fn grok_apply_billing_config(status: &mut ProviderQuotaStatus, config: &Value, tier: &str) -> bool {
    let period_end = config
        .pointer("/currentPeriod/end")
        .or_else(|| config.get("billingPeriodEnd"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let time_res = period_end
        .as_ref()
        .and_then(|pe| chrono_parse_rfc3339(pe).ok())
        .map(|ms| (ms - now_ms()).max(0));

    let (used_pct, label) = if let Some(p) = config.get("creditUsagePercent").and_then(|v| v.as_f64()) {
        (p, "Créditos semanales")
    } else {
        let limit = grok_money(config.get("monthlyLimit"));
        let used = grok_money(config.get("used"));
        match (limit, used) {
            (Some(l), Some(u)) if l > 0.0 => ((u / l) * 100.0, "Límite mensual"),
            _ => return false,
        }
    };

    let used_pct = used_pct.clamp(0.0, 100.0);
    let rem_pct = 100.0 - used_pct;
    status.primary_usage_percent = (used_pct * 10.0).round() / 10.0;
    status.primary_remaining_percent = (rem_pct * 10.0).round() / 10.0;
    status.primary_reset_at = period_end.clone();
    status.time_until_reset_ms = time_res;
    status.windows.push(QuotaWindow {
        name: format!("{} ({})", tier, label),
        usage_percent: status.primary_usage_percent,
        remaining_fraction: (rem_pct / 100.0 * 100.0).round() / 100.0,
        resets_at: period_end,
        time_until_reset_ms: time_res,
        is_exhausted: rem_pct <= 0.0,
    });
    true
}

pub fn fetch_grok_quota() -> ProviderQuotaStatus {
    let mut status = ProviderQuotaStatus {
        provider_id: "grok".to_string(),
        display_name: "Grok".to_string(),
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

    let home = user_home_dir();
    let auth_file = if let Ok(custom) = std::env::var("GROK_HOME") {
        PathBuf::from(custom).join("auth.json")
    } else {
        home.join(".grok").join("auth.json")
    };

    if !auth_file.exists() {
        status.error = Some("No se encontraron credenciales de Grok en ~/.grok/auth.json".to_string());
        return status;
    }

    let content = match std::fs::read_to_string(&auth_file) {
        Ok(c) => c,
        Err(e) => {
            status.error = Some(format!("Error leyendo auth.json de Grok: {}", e));
            return status;
        }
    };

    let parsed: Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => {
            status.error = Some("Formato inválido en auth.json de Grok".to_string());
            return status;
        }
    };

    let mut access_token: Option<String> = None;
    let mut email: Option<String> = None;
    let mut auth_mode: Option<String> = None;
    let mut user_name: Option<String> = None;
    let mut expires_at: Option<String> = None;
    let mut refresh_token: Option<String> = None;
    let mut oidc_client_id: Option<String> = None;
    let mut entry_key: Option<String> = None;

    let mut user_id: Option<String> = None;

    if let Some(obj) = parsed.as_object() {
        for (k, entry) in obj {
            if let Some(token) = entry.get("key").or_else(|| entry.get("access_token")).and_then(|v| v.as_str()) {
                entry_key = Some(k.clone());
                access_token = Some(token.to_string());
                email = entry.get("email").and_then(|v| v.as_str()).map(|s| s.to_string());
                auth_mode = entry.get("auth_mode").and_then(|v| v.as_str()).map(|s| s.to_string());
                user_id = entry.get("user_id").and_then(|v| v.as_str()).map(|s| s.to_string());
                refresh_token = entry.get("refresh_token").and_then(|v| v.as_str()).map(|s| s.to_string());
                oidc_client_id = entry.get("oidc_client_id").and_then(|v| v.as_str()).map(|s| s.to_string());
                let first = entry.get("first_name").and_then(|v| v.as_str()).unwrap_or("");
                let last = entry.get("last_name").and_then(|v| v.as_str()).unwrap_or("");
                let full = format!("{} {}", first, last).trim().to_string();
                if !full.is_empty() {
                    user_name = Some(full);
                }
                expires_at = entry.get("expires_at").and_then(|v| v.as_str()).map(|s| s.to_string());
                break;
            }
        }
    }

    let mut token = match access_token {
        Some(t) => t,
        None => {
            status.error = Some("No se encontró token de acceso en ~/.grok/auth.json".to_string());
            return status;
        }
    };

    status.is_available = true;
    status.is_auth = true;

    if let Some(ref em) = email {
        status.metadata.insert("email".to_string(), json!(em));
    }
    if let Some(ref un) = user_name {
        status.metadata.insert("userName".to_string(), json!(un));
    }
    if let Some(ref am) = auth_mode {
        status.metadata.insert("authMode".to_string(), json!(am));
    }
    if let Some(ref uid) = user_id {
        status.metadata.insert("userId".to_string(), json!(uid));
    }
    status.metadata.insert("source".to_string(), json!("~/.grok/auth.json"));

    // Detect tier from settings_cache.json if available
    let settings_file = home.join(".grok").join("settings_cache.json");
    let mut detected_tier: Option<String> = None;
    if let Ok(settings_raw) = std::fs::read_to_string(&settings_file) {
        if let Ok(settings_val) = serde_json::from_str::<Value>(&settings_raw) {
            if let Some(payload_str) = settings_val.get("payload").and_then(|v| v.as_str()) {
                if let Ok(payload_json) = serde_json::from_str::<Value>(payload_str) {
                    if let Some(tier) = payload_json.pointer("/settings/subscription_tier_display").and_then(|v| v.as_str()) {
                        detected_tier = Some(tier.to_string());
                    }
                }
            }
        }
    }

    if let Some(ref tier) = detected_tier {
        status.metadata.insert("tier".to_string(), json!(tier));
    }

    // Check expiration
    let mut is_expired = false;
    let mut time_until_reset: Option<i64> = None;
    if let Some(ref exp) = expires_at {
        if let Ok(exp_ms) = chrono_parse_rfc3339(exp) {
            let diff = exp_ms - now_ms();
            if diff <= 0 {
                is_expired = true;
            } else {
                time_until_reset = Some(diff);
            }
        }
    }

    if is_expired {
        let mut refreshed_ok = false;
        if let (Some(ref rt), Some(ref cid)) = (&refresh_token, &oidc_client_id) {
            let form_data = format!("grant_type=refresh_token&client_id={}&refresh_token={}", cid, rt);
            let mut curl_cmd = silent_command("curl.exe");
            curl_cmd.args([
                "-s",
                "-X",
                "POST",
                "https://auth.x.ai/oauth2/token",
                "-H",
                "Content-Type: application/x-www-form-urlencoded",
                "-d",
                &form_data,
                "--max-time",
                "5",
            ]);
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                curl_cmd.creation_flags(0x08000000);
            }
            if let Ok(out) = curl_cmd.output() {
                if out.status.success() {
                    let body = String::from_utf8_lossy(&out.stdout);
                    if let Ok(refreshed) = serde_json::from_str::<Value>(&body) {
                        if let Some(new_at) = refreshed.get("access_token").and_then(|v| v.as_str()) {
                            token = new_at.to_string();
                            refreshed_ok = true;

                            let new_rt = refreshed.get("refresh_token").and_then(|v| v.as_str()).unwrap_or(rt);
                            let exp_secs = refreshed.get("expires_in").and_then(|v| v.as_i64()).unwrap_or(21600);
                            let new_exp = format_unix_to_rfc3339(now_ms() + exp_secs * 1000);
                            expires_at = Some(new_exp.clone());
                            time_until_reset = Some(exp_secs * 1000);

                            if let (Some(ref ek), Some(map)) = (&entry_key, parsed.as_object()) {
                                let mut updated = map.clone();
                                if let Some(ent_val) = updated.get_mut(ek) {
                                    if let Some(ent_obj) = ent_val.as_object_mut() {
                                        ent_obj.insert("key".to_string(), json!(token));
                                        ent_obj.insert("refresh_token".to_string(), json!(new_rt));
                                        ent_obj.insert("expires_at".to_string(), json!(new_exp));
                                    }
                                }
                                let _ = std::fs::write(&auth_file, serde_json::to_string_pretty(&updated).unwrap_or_default());
                            }
                        }
                    }
                }
            }
        }

        if !refreshed_ok {
            status.is_auth = false;
            status.error = Some("Sesión de Grok expirada. Ejecuta 'grok login' en la terminal para renovarla.".to_string());
            return status;
        }
    }

    // Billing endpoint of the Grok CLI proxy (the same one the CLI itself uses).
    // Never fabricate numbers: if the endpoint gives no usage, report why.
    let tier_name = detected_tier.clone().unwrap_or_else(|| "SuperGrok".to_string());
    status.metadata.insert("tier".to_string(), json!(tier_name));
    let credits_url = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
    let default_url = "https://cli-chat-proxy.grok.com/v1/billing";
    match grok_billing_request(credits_url, &token, user_id.as_deref()) {
        Some((code, body)) if (200..300).contains(&code) => {
            let data: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
            let config = data.get("config").unwrap_or(&data).clone();
            let mut mapped = grok_apply_billing_config(&mut status, &config, &tier_name);
            if !mapped {
                if let Some((c2, b2)) = grok_billing_request(default_url, &token, user_id.as_deref()) {
                    if (200..300).contains(&c2) {
                        let d2: Value = serde_json::from_str(&b2).unwrap_or(Value::Null);
                        let cfg2 = d2.get("config").unwrap_or(&d2).clone();
                        mapped = grok_apply_billing_config(&mut status, &cfg2, &tier_name);
                    }
                }
            }
            if !mapped {
                status.metadata.insert(
                    "note".to_string(),
                    json!("Grok no informó un porcentaje de uso para esta cuenta"),
                );
            }
        }
        Some((code, body)) => {
            if body.contains("privacy-mode:legacy") {
                status.metadata.insert("failureKind".to_string(), json!("privacy_mode"));
                status.error = Some("xAI no entrega los créditos porque la cuenta está en Privacy Mode 'Legacy'. Activa Privacy Mode en la configuración de Grok para ver el uso.".to_string());
            } else if code == 401 {
                status.is_auth = false;
                status.metadata.insert("failureKind".to_string(), json!("unauthorized"));
                status.error = Some("Sesión de Grok no autorizada (HTTP 401). Ejecuta 'grok login'.".to_string());
            } else {
                status.metadata.insert("failureKind".to_string(), json!("http"));
                status.error = Some(format!("La consulta de uso de Grok falló (HTTP {})", code));
            }
        }
        None => {
            status.metadata.insert("failureKind".to_string(), json!("network"));
            status.error = Some("No se pudo contactar el servicio de facturación de Grok".to_string());
        }
    }
    if let Some(ref ea) = expires_at {
        status.metadata.insert("sessionExpiresAt".to_string(), json!(ea));
    }
    let _ = time_until_reset;

    status
}

pub fn fetch_gemini_quota() -> ProviderQuotaStatus {
    let home = user_home_dir();
    let gemini_dir = home.join(".gemini");
    let has_key = std::env::var("GEMINI_API_KEY").is_ok();
    let is_avail = gemini_dir.exists() || has_key;
    let mut status = ProviderQuotaStatus {
        provider_id: "gemini".to_string(),
        display_name: "Gemini CLI".to_string(),
        is_available: is_avail,
        is_auth: is_avail,
        primary_usage_percent: 0.0,
        primary_remaining_percent: 100.0,
        primary_reset_at: None,
        time_until_reset_ms: None,
        windows: Vec::new(),
        metadata: HashMap::new(),
        last_updated_ms: now_ms(),
        error: if is_avail { None } else { Some("Google Gemini credentials no detectadas".to_string()) },
    };
    if is_avail {
        status.metadata.insert("source".to_string(), json!("~/.gemini/"));
        status.metadata.insert("note".to_string(), json!("Detectado localmente"));
        enrich_google_identity(&mut status);
    }
    status
}

fn b64url_decode(input: &str) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut buf: u32 = 0;
    let mut bits = 0u32;
    for c in input.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'-' | b'+' => 62,
            b'_' | b'/' => 63,
            b'=' => break,
            _ => return None,
        } as u32;
        buf = (buf << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buf >> bits) & 0xFF) as u8);
        }
    }
    Some(out)
}

/// Returns (subject, exp_seconds) from a JWT payload.
fn decode_jwt_claims(token: &str) -> Option<(String, Option<i64>)> {
    let payload = token.split('.').nth(1)?;
    let bytes = b64url_decode(payload)?;
    let v: Value = serde_json::from_slice(&bytes).ok()?;
    let sub = v.get("sub")?.as_str()?.trim().to_string();
    if sub.is_empty() {
        return None;
    }
    Some((sub, v.get("exp").and_then(|e| e.as_i64())))
}

fn url_encode_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// Reads the Cursor session: CLI auth.json first, then the IDE's state.vscdb.
/// Returns (access_token, email, membership_type).
fn read_cursor_session() -> Option<(String, Option<String>, Option<String>)> {
    let home = user_home_dir();
    let appdata = std::env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home.join("AppData").join("Roaming"));
    let mut email: Option<String> = None;

    if let Ok(raw) = std::fs::read_to_string(home.join(".cursor").join("cli-config.json")) {
        if let Ok(v) = serde_json::from_str::<Value>(&raw) {
            email = v.pointer("/authInfo/email").and_then(|e| e.as_str()).map(|s| s.to_string());
        }
    }
    for dir in [appdata.join("Cursor"), home.join(".cursor")] {
        if let Ok(raw) = std::fs::read_to_string(dir.join("auth.json")) {
            if let Ok(v) = serde_json::from_str::<Value>(&raw) {
                if let Some(t) = v.get("accessToken").and_then(|t| t.as_str()) {
                    if !t.is_empty() {
                        return Some((t.to_string(), email, None));
                    }
                }
            }
        }
    }

    let db = appdata.join("Cursor").join("User").join("globalStorage").join("state.vscdb");
    if !db.exists() {
        return None;
    }
    let uri = format!("file:{}?mode=ro&immutable=1", db.to_string_lossy().replace('\\', "/"));
    let conn = rusqlite::Connection::open_with_flags(
        uri,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    )
    .ok()?;
    let get = |key: &str| -> Option<String> {
        conn.query_row("SELECT value FROM ItemTable WHERE key = ?1", [key], |r| r.get::<_, String>(0))
            .ok()
            .filter(|s| !s.trim().is_empty())
    };
    let token = get("cursorAuth/accessToken")?;
    let em = get("cursorAuth/cachedEmail").or(email);
    Some((token, em, get("cursorAuth/stripeMembershipType")))
}

fn cursor_json(url: &str, cookie: &str) -> Option<(u16, Value)> {
    let mut cmd = silent_command("curl.exe");
    cmd.args([
        "-s",
        "-w",
        "\n%{http_code}",
        url,
        "-H",
        &format!("Cookie: {}", cookie),
        "-H",
        "Accept: application/json",
        "-H",
        "Origin: https://cursor.com",
        "-H",
        "Referer: https://cursor.com/dashboard",
        "--max-time",
        "10",
    ]);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let out = cmd.output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let (body, code) = text.rsplit_once('\n')?;
    let code: u16 = code.trim().parse().ok()?;
    if code == 0 {
        return None;
    }
    Some((code, serde_json::from_str(body).unwrap_or(Value::Null)))
}

fn cursor_pct(pool: &Value, pct_field: &str) -> Option<f64> {
    let used = pool.get("used").and_then(|v| v.as_f64());
    let limit = pool.get("limit").and_then(|v| v.as_f64());
    if let (Some(u), Some(l)) = (used, limit) {
        if l > 0.0 {
            return Some((u / l) * 100.0);
        }
    }
    pool.get(pct_field).and_then(|v| v.as_f64())
}

pub fn fetch_cursor_quota() -> ProviderQuotaStatus {
    let mut status = ProviderQuotaStatus {
        provider_id: "cursor".to_string(),
        display_name: "Cursor".to_string(),
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

    let (token, email, membership) = match read_cursor_session() {
        Some(s) => s,
        None => {
            status.error = Some("No hay sesión de Cursor en este equipo. Inicia sesión en Cursor IDE o con 'cursor-agent login'.".to_string());
            return status;
        }
    };
    status.is_available = true;
    status.is_auth = true;
    status.metadata.insert("source".to_string(), json!("Cursor IDE / cursor-agent"));
    if let Some(ref e) = email {
        status.metadata.insert("email".to_string(), json!(e));
    }

    let (subject, exp) = match decode_jwt_claims(&token) {
        Some(c) => c,
        None => {
            status.is_auth = false;
            status.error = Some("El token de Cursor no es válido. Vuelve a iniciar sesión.".to_string());
            return status;
        }
    };
    if let Some(exp) = exp {
        if exp * 1000 <= now_ms() {
            status.is_auth = false;
            status.error = Some("La sesión de Cursor expiró. Abre Cursor o ejecuta 'cursor-agent login'.".to_string());
            return status;
        }
    }

    let cookie = format!("WorkosCursorSessionToken={}%3A%3A{}", url_encode_component(&subject), token);
    let (code, data) = match cursor_json("https://cursor.com/api/usage-summary", &cookie) {
        Some(r) => r,
        None => {
            status.error = Some("No se pudo contactar cursor.com".to_string());
            return status;
        }
    };
    if code == 401 || code == 403 {
        status.is_auth = false;
        status.error = Some(format!("Cursor rechazó la sesión (HTTP {}). Vuelve a iniciar sesión.", code));
        return status;
    }
    if !(200..300).contains(&code) {
        status.error = Some(format!("La consulta de uso de Cursor falló (HTTP {})", code));
        return status;
    }

    let plan_type = data
        .get("membershipType")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or(membership);
    if let Some(ref p) = plan_type {
        status.metadata.insert("planType".to_string(), json!(p));
    }
    if data.get("isUnlimited").and_then(|v| v.as_bool()) == Some(true) {
        status.metadata.insert("note".to_string(), json!("Plan sin límite de uso"));
        return status;
    }

    let cycle_end = data.get("billingCycleEnd").and_then(|v| v.as_str()).map(|s| s.to_string());
    let time_res = cycle_end
        .as_ref()
        .and_then(|e| chrono_parse_rfc3339(e).ok())
        .map(|ms| (ms - now_ms()).max(0));

    let push = |status: &mut ProviderQuotaStatus, name: &str, pct: f64| {
        let used = pct.clamp(0.0, 100.0);
        let rem = 100.0 - used;
        status.windows.push(QuotaWindow {
            name: name.to_string(),
            usage_percent: (used * 10.0).round() / 10.0,
            remaining_fraction: (rem / 100.0 * 100.0).round() / 100.0,
            resets_at: cycle_end.clone(),
            time_until_reset_ms: time_res,
            is_exhausted: rem <= 0.0,
        });
    };

    let plan = data.pointer("/individualUsage/plan");
    let plan_enabled = plan.and_then(|p| p.get("enabled")).and_then(|v| v.as_bool()) != Some(false);
    let mut total_pct: Option<f64> = None;
    if let (Some(plan), true) = (plan, plan_enabled) {
        total_pct = plan
            .get("totalPercentUsed")
            .and_then(|v| v.as_f64())
            .or_else(|| cursor_pct(plan, "totalPercentUsed"));
        if let Some(p) = total_pct {
            push(&mut status, "Uso total incluido", p);
        }
        if let Some(p) = plan.get("autoPercentUsed").and_then(|v| v.as_f64()) {
            push(&mut status, "Modelos de Cursor (Auto)", p);
        }
        if let Some(p) = plan.get("apiPercentUsed").and_then(|v| v.as_f64()) {
            push(&mut status, "Otros modelos (API)", p);
        }
    }
    if let Some(od) = data.pointer("/individualUsage/onDemand") {
        if od.get("enabled").and_then(|v| v.as_bool()) == Some(true) {
            if let Some(p) = cursor_pct(od, "totalPercentUsed") {
                push(&mut status, "Uso bajo demanda", p);
            }
        }
    }

    if let Some(p) = total_pct {
        let used = p.clamp(0.0, 100.0);
        status.primary_usage_percent = (used * 10.0).round() / 10.0;
        status.primary_remaining_percent = ((100.0 - used) * 10.0).round() / 10.0;
        status.primary_reset_at = cycle_end;
        status.time_until_reset_ms = time_res;
    } else if let Some(w) = status.windows.first() {
        status.primary_usage_percent = w.usage_percent;
        status.primary_remaining_percent = 100.0 - w.usage_percent;
        status.primary_reset_at = w.resets_at.clone();
        status.time_until_reset_ms = w.time_until_reset_ms;
    } else {
        status.metadata.insert("note".to_string(), json!("Cursor no informó una cuota para esta cuenta"));
    }
    status
}

pub fn fetch_droid_quota() -> ProviderQuotaStatus {
    let home = user_home_dir();
    let droid_dir = home.join(".factory");
    let is_avail = droid_dir.exists();
    let mut status = ProviderQuotaStatus {
        provider_id: "droid".to_string(),
        display_name: "Droid".to_string(),
        is_available: is_avail,
        is_auth: is_avail,
        primary_usage_percent: 0.0,
        primary_remaining_percent: 100.0,
        primary_reset_at: None,
        time_until_reset_ms: None,
        windows: Vec::new(),
        metadata: HashMap::new(),
        last_updated_ms: now_ms(),
        error: if is_avail { None } else { Some("Factory Droid credentials no detectadas".to_string()) },
    };
    if is_avail {
        status.metadata.insert("source".to_string(), json!("~/.factory/"));
        status.metadata.insert("note".to_string(), json!("Detectado localmente"));
    }
    status
}

pub fn fetch_copilot_quota() -> ProviderQuotaStatus {
    let home = user_home_dir();
    let copilot_dir = home.join(".copilot");
    let is_avail = copilot_dir.exists();
    let mut status = ProviderQuotaStatus {
        provider_id: "copilot".to_string(),
        display_name: "GitHub Copilot".to_string(),
        is_available: is_avail,
        is_auth: is_avail,
        primary_usage_percent: 0.0,
        primary_remaining_percent: 100.0,
        primary_reset_at: None,
        time_until_reset_ms: None,
        windows: Vec::new(),
        metadata: HashMap::new(),
        last_updated_ms: now_ms(),
        error: if is_avail { None } else { Some("GitHub Copilot CLI no conectado (~/.copilot)".to_string()) },
    };
    if is_avail {
        status.metadata.insert("source".to_string(), json!("~/.copilot/config.json"));
        status.metadata.insert("note".to_string(), json!("Detectado localmente"));
    }
    status
}

pub fn fetch_deepseek_quota() -> ProviderQuotaStatus {
    let key = std::env::var("DEEPSEEK_API_KEY").ok().filter(|k| !k.trim().is_empty());
    let mut status = ProviderQuotaStatus {
        provider_id: "deepseek".to_string(),
        display_name: "DeepSeek".to_string(),
        is_available: key.is_some(),
        is_auth: key.is_some(),
        primary_usage_percent: 0.0,
        primary_remaining_percent: 100.0,
        primary_reset_at: None,
        time_until_reset_ms: None,
        windows: Vec::new(),
        metadata: HashMap::new(),
        last_updated_ms: now_ms(),
        error: None,
    };
    let key = match key {
        Some(k) => k,
        None => {
            status.error = Some("DEEPSEEK_API_KEY no configurada".to_string());
            return status;
        }
    };
    status.metadata.insert("source".to_string(), json!("DEEPSEEK_API_KEY"));
    let mut cmd = silent_command("curl.exe");
    cmd.args([
        "-s",
        "-w",
        "\n%{http_code}",
        "https://api.deepseek.com/user/balance",
        "-H",
        &format!("Authorization: Bearer {}", key.trim()),
        "-H",
        "Accept: application/json",
        "--max-time",
        "8",
    ]);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let parsed = cmd.output().ok().and_then(|o| {
        let text = String::from_utf8_lossy(&o.stdout).to_string();
        let (body, code) = text.rsplit_once('\n')?;
        Some((code.trim().parse::<u16>().ok()?, serde_json::from_str::<Value>(body).unwrap_or(Value::Null)))
    });
    match parsed {
        Some((code, data)) if (200..300).contains(&code) => {
            if let Some(info) = data.pointer("/balance_infos/0") {
                let cur = info.get("currency").and_then(|v| v.as_str()).unwrap_or("");
                let total = info.get("total_balance").and_then(|v| v.as_str()).unwrap_or("?");
                status.metadata.insert("balance".to_string(), json!(format!("{} {}", total, cur).trim().to_string()));
            }
            if data.get("is_available").and_then(|v| v.as_bool()) == Some(false) {
                status.error = Some("Saldo insuficiente en la cuenta de DeepSeek".to_string());
            }
        }
        Some((401, _)) | Some((403, _)) => {
            status.is_auth = false;
            status.error = Some("DeepSeek rechazó la clave de API".to_string());
        }
        Some((code, _)) => status.error = Some(format!("La consulta de saldo de DeepSeek falló (HTTP {})", code)),
        None => status.error = Some("No se pudo contactar api.deepseek.com".to_string()),
    }
    status
}

// ---------------------------------------------------------------------------
// 5. Kimi Code Adapter with OAuth Refresh & Usages Parsing
// ---------------------------------------------------------------------------

pub fn fetch_kimi_quota() -> ProviderQuotaStatus {
    let mut status = ProviderQuotaStatus {
        provider_id: "kimi".to_string(),
        display_name: "Kimi Code".to_string(),
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

    let home = user_home_dir();
    let candidates = [
        home.join(".kimi-code").join("credentials").join("kimi-code.json"),
        home.join(".kimi").join("credentials").join("kimi-code.json"),
    ];

    let mut found_cred_file: Option<PathBuf> = None;
    let mut cred_data: Option<Value> = None;

    for c in &candidates {
        if c.exists() {
            if let Ok(raw) = std::fs::read_to_string(c) {
                if let Ok(parsed) = serde_json::from_str::<Value>(&raw) {
                    if parsed.get("access_token").and_then(|v| v.as_str()).is_some() {
                        found_cred_file = Some(c.clone());
                        cred_data = Some(parsed);
                        break;
                    }
                }
            }
        }
    }

    let (cred_path, mut cred_json) = match (found_cred_file, cred_data) {
        (Some(p), Some(d)) => (p, d),
        _ => {
            let api_key = std::env::var("KIMI_API_KEY").or_else(|_| std::env::var("MOONSHOT_API_KEY")).ok();
            if let Some(key) = api_key {
                status.is_available = true;
                return fetch_moonshot_balance(&key, status);
            }
            status.error = Some("No se encontraron credenciales de Kimi Code (~/.kimi-code)".to_string());
            return status;
        }
    };

    status.is_available = true;
    status.metadata.insert("source".to_string(), json!(cred_path.display().to_string()));
    status.metadata.insert("loginCommand".to_string(), json!("kimi login"));

    let mut access_token = cred_json.get("access_token").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let refresh_token = cred_json.get("refresh_token").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let expires_at_sec = cred_json.get("expires_at").and_then(|v| v.as_i64()).unwrap_or(0);

    let is_expired = if expires_at_sec > 0 {
        now_ms() / 1000 >= expires_at_sec - 60
    } else {
        false
    };

    if is_expired && !refresh_token.is_empty() {
        if let Some(new_tok) = refresh_kimi_token(&cred_path, &mut cred_json, &refresh_token) {
            access_token = new_tok;
        }
    }

    if access_token.is_empty() {
        status.is_auth = false;
        status.error = Some("Sesión de Kimi Code expirada. Ejecuta 'kimi login' en la terminal para renovarla.".to_string());
        return status;
    }

    let auth_header = format!("Authorization: Bearer {}", access_token);
    let out = silent_command("curl.exe")
        .args([
            "-s",
            "https://api.kimi.com/coding/v1/usages",
            "-H",
            &auth_header,
            "-H",
            "Accept: application/json",
            "-H",
            "User-Agent: Kite-QuotaEngine/1.0",
            "--max-time",
            "5",
        ])
        .output();

    if let Ok(resp) = out {
        if resp.status.success() {
            let body = String::from_utf8_lossy(&resp.stdout);
            if let Ok(payload) = serde_json::from_str::<Value>(&body) {
                if payload.get("usage").is_some() || payload.get("limits").is_some() {
                    status.is_auth = true;
                    return apply_kimi_usage_payload(status, &payload);
                }
                if let Some(err_msg) = payload.pointer("/error/message").and_then(|v| v.as_str()) {
                    if (err_msg.contains("invalid") || err_msg.contains("expired")) && !refresh_token.is_empty() {
                        if let Some(new_tok) = refresh_kimi_token(&cred_path, &mut cred_json, &refresh_token) {
                            let retry_header = format!("Authorization: Bearer {}", new_tok);
                            if let Ok(retry_resp) = silent_command("curl.exe")
                                .args([
                                    "-s",
                                    "https://api.kimi.com/coding/v1/usages",
                                    "-H",
                                    &retry_header,
                                    "-H",
                                    "Accept: application/json",
                                    "--max-time",
                                    "5",
                                ])
                                .output()
                            {
                                if retry_resp.status.success() {
                                    let retry_body = String::from_utf8_lossy(&retry_resp.stdout);
                                    if let Ok(retry_pay) = serde_json::from_str::<Value>(&retry_body) {
                                        if retry_pay.get("usage").is_some() || retry_pay.get("limits").is_some() {
                                            status.is_auth = true;
                                            return apply_kimi_usage_payload(status, &retry_pay);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    status.is_auth = false;
    status.error = Some("Sesión de Kimi Code expirada. Ejecuta 'kimi login' en la terminal para renovar.".to_string());
    status
}

fn refresh_kimi_token(path: &PathBuf, cred_json: &mut Value, refresh_token: &str) -> Option<String> {
    let body_data = format!(
        "client_id=17e5f671-d194-4dfb-9706-5516cb48c098&grant_type=refresh_token&refresh_token={}",
        refresh_token
    );
    let output = silent_command("curl.exe")
        .args([
            "-s",
            "-X",
            "POST",
            "https://auth.kimi.com/api/oauth/token",
            "-H",
            "Content-Type: application/x-www-form-urlencoded",
            "-H",
            "Accept: application/json",
            "-d",
            &body_data,
            "--max-time",
            "5",
        ])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let resp_str = String::from_utf8_lossy(&output.stdout);
    let res_json: Value = serde_json::from_str(&resp_str).ok()?;
    let new_access = res_json.get("access_token").and_then(|v| v.as_str())?.to_string();
    let new_refresh = res_json.get("refresh_token").and_then(|v| v.as_str()).map(|s| s.to_string());
    let expires_in = res_json.get("expires_in").and_then(|v| v.as_i64()).unwrap_or(3600);

    if let Some(obj) = cred_json.as_object_mut() {
        obj.insert("access_token".to_string(), json!(new_access));
        if let Some(r) = new_refresh {
            obj.insert("refresh_token".to_string(), json!(r));
        }
        obj.insert("expires_at".to_string(), json!(now_ms() / 1000 + expires_in));
        let _ = std::fs::write(path, serde_json::to_string_pretty(&obj).unwrap_or_default());
    }

    Some(new_access)
}

fn apply_kimi_usage_payload(mut status: ProviderQuotaStatus, payload: &Value) -> ProviderQuotaStatus {
    let mut max_usage = 0.0f64;
    let mut earliest_reset_ms: Option<i64> = None;
    let mut primary_reset_at: Option<String> = None;

    let mut process_row = |raw: Option<&Value>, label: &str| {
        let val = match raw {
            Some(v) => v,
            None => return,
        };
        let limit = val.get("limit").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let used = val.get("used").and_then(|v| v.as_f64());
        let remaining = val.get("remaining").and_then(|v| v.as_f64());

        let eff_used = match (used, remaining) {
            (Some(u), _) => u,
            (None, Some(r)) => (limit - r).max(0.0),
            _ => 0.0,
        };

        let usage_pct = if limit > 0.0 {
            (eff_used / limit * 100.0).clamp(0.0, 100.0)
        } else {
            0.0
        };

        let reset_at = val.get("resetTime")
            .or_else(|| val.get("reset_at"))
            .or_else(|| val.get("resetAt"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let mut reset_ms: Option<i64> = None;
        if let Some(ref rt) = reset_at {
            if let Ok(ms) = chrono_parse_rfc3339(rt) {
                let diff = (ms - now_ms()).max(0);
                reset_ms = Some(diff);
                if earliest_reset_ms.is_none() || diff < earliest_reset_ms.unwrap() {
                    earliest_reset_ms = Some(diff);
                    primary_reset_at = Some(rt.clone());
                }
            }
        }

        if usage_pct > max_usage {
            max_usage = usage_pct;
        }

        status.windows.push(QuotaWindow {
            name: label.to_string(),
            usage_percent: (usage_pct * 10.0).round() / 10.0,
            remaining_fraction: ((100.0 - usage_pct) / 100.0).clamp(0.0, 1.0),
            resets_at: reset_at,
            time_until_reset_ms: reset_ms,
            is_exhausted: usage_pct >= 100.0,
        });
    };

    process_row(payload.get("usage"), "Límite Semanal");

    if let Some(arr) = payload.get("limits").and_then(|v| v.as_array()) {
        for (idx, item) in arr.iter().enumerate() {
            let detail = item.get("detail").unwrap_or(item);
            let name = item.get("name")
                .or_else(|| item.get("title"))
                .or_else(|| detail.get("name"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| format!("Límite #{}", idx + 1));
            process_row(Some(detail), &name);
        }
    }

    if let Some(membership) = payload.pointer("/user/membership/level").and_then(|v| v.as_str()) {
        let clean = membership.replace("LEVEL_", "").to_lowercase();
        let formatted = format!("{}{}", clean.chars().next().map(|c| c.to_ascii_uppercase()).unwrap_or('?'), &clean[1..]);
        status.metadata.insert("membership".to_string(), json!(formatted));
    }

    if let Some(region) = payload.pointer("/user/region").and_then(|v| v.as_str()) {
        status.metadata.insert("region".to_string(), json!(region.replace("REGION_", "")));
    }

    status.primary_usage_percent = (max_usage * 10.0).round() / 10.0;
    status.primary_remaining_percent = ((100.0 - max_usage) * 10.0).round() / 10.0;
    status.primary_reset_at = primary_reset_at;
    status.time_until_reset_ms = earliest_reset_ms;
    status.error = None;
    status
}

fn fetch_moonshot_balance(api_key: &str, mut status: ProviderQuotaStatus) -> ProviderQuotaStatus {
    let auth_header = format!("Bearer {}", api_key);
    let output = silent_command("curl.exe")
        .args([
            "-s",
            "https://api.moonshot.cn/v1/users/me/balance",
            "-H",
            &auth_header,
            "-H",
            "User-Agent: Kite-QuotaEngine/1.0",
            "--max-time",
            "5",
        ])
        .output();

    if let Ok(out) = output {
        if out.status.success() {
            let body = String::from_utf8_lossy(&out.stdout);
            if let Ok(data) = serde_json::from_str::<Value>(&body) {
                let avail = data.pointer("/data/available_balance").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let voucher = data.pointer("/data/voucher_balance").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let total = avail + voucher;

                status.is_auth = true;
                status.primary_usage_percent = 0.0;
                status.primary_remaining_percent = if total > 0.0 { 100.0 } else { 0.0 };
                status.metadata.insert("availableBalance".to_string(), json!(avail));
                status.metadata.insert("voucherBalance".to_string(), json!(voucher));
                status.windows.push(QuotaWindow {
                    name: "Saldo Moonshot API".to_string(),
                    usage_percent: 0.0,
                    remaining_fraction: if total > 0.0 { 1.0 } else { 0.0 },
                    resets_at: None,
                    time_until_reset_ms: None,
                    is_exhausted: total <= 0.0,
                });
                return status;
            }
        }
    }

    status.error = Some("Error consultando saldo de Moonshot API".to_string());
    status
}

#[tauri::command]
pub fn save_opencode_cookie(cookie: String, workspace_id: Option<String>) -> Result<bool, String> {
    let home = user_home_dir();
    let dir = home.join(".kite");
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("opencode-go-quota.json");
    let data = json!({
        "authCookie": cookie.trim(),
        "workspaceId": workspace_id.map(|w| w.trim().to_string()).unwrap_or_default()
    });
    std::fs::write(&path, serde_json::to_string_pretty(&data).unwrap_or_default())
        .map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub fn clear_opencode_cookie() -> Result<bool, String> {
    let home = user_home_dir();
    let path = home.join(".kite").join("opencode-go-quota.json");
    if path.exists() {
        let _ = std::fs::remove_file(path);
    }
    Ok(true)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn chrono_parse_rfc3339(s: &str) -> Result<i64, ()> {
    // Basic RFC3339 parser for timestamps like 2026-10-15T21:28:00Z
    let clean = s.trim();
    if clean.len() < 19 {
        return Err(());
    }
    let parts: Vec<&str> = clean.split('T').collect();
    if parts.len() != 2 {
        return Err(());
    }
    let ymd: Vec<&str> = parts[0].split('-').collect();
    if ymd.len() != 3 {
        return Err(());
    }
    let year: i32 = ymd[0].parse().map_err(|_| ())?;
    let month: u32 = ymd[1].parse().map_err(|_| ())?;
    let day: u32 = ymd[2].parse().map_err(|_| ())?;

    let time_part = parts[1].trim_end_matches('Z');
    let hms: Vec<&str> = time_part.split(':').collect();
    if hms.len() < 3 {
        return Err(());
    }
    let hour: u32 = hms[0].parse().map_err(|_| ())?;
    let min: u32 = hms[1].parse().map_err(|_| ())?;
    let sec_str = hms[2].split('.').next().unwrap_or("0");
    let sec: u32 = sec_str.parse().map_err(|_| ())?;

    // Approximate days since unix epoch (1970)
    let mut total_days = 0i64;
    for y in 1970..year {
        let is_leap = (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0);
        total_days += if is_leap { 366 } else { 365 };
    }
    let days_in_month = [
        31,
        if (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0) { 29 } else { 28 },
        31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
    ];
    for m in 1..month {
        total_days += days_in_month[(m - 1) as usize] as i64;
    }
    total_days += (day - 1) as i64;

    let total_secs = total_days * 86400 + (hour as i64) * 3600 + (min as i64) * 60 + (sec as i64);
    Ok(total_secs * 1000)
}

fn format_unix_to_iso(ms: i64) -> String {
    let total_sec = ms / 1000;
    let sec = total_sec % 60;
    let min = (total_sec / 60) % 60;
    let hour = (total_sec / 3600) % 24;
    format!("Reset at {:02}:{:02}:{:02} UTC", hour, min, sec)
}

// ---------------------------------------------------------------------------
// Public Tauri Command
// ---------------------------------------------------------------------------

pub fn fetch_single_provider(p: &str) -> ProviderQuotaStatus {
    match p {
        "antigravity" => fetch_antigravity_quota(),
        "qoder" => fetch_qoder_quota(),
        "claude" => fetch_claude_quota(),
        "codex" => fetch_codex_quota(),
        "opencode" => fetch_opencode_quota(),
        "grok" => fetch_grok_quota(),
        "gemini" => fetch_gemini_quota(),
        "cursor" => fetch_cursor_quota(),
        "droid" => fetch_droid_quota(),
        "copilot" => fetch_copilot_quota(),
        "deepseek" => fetch_deepseek_quota(),
        "kimi" => fetch_kimi_quota(),
        _ => fetch_antigravity_quota(),
    }
}

fn provider_name(p: &str) -> &str {
    match p {
        "antigravity" => "Antigravity",
        "qoder" => "Qoder",
        "claude" => "Claude",
        "codex" => "Codex",
        "opencode" => "OpenCode",
        "grok" => "Grok",
        "gemini" => "Gemini",
        "cursor" => "Cursor",
        "droid" => "Droid",
        "copilot" => "GitHub Copilot",
        "deepseek" => "DeepSeek",
        "kimi" => "Kimi",
        _ => p,
    }
}

fn default_provider_status(p: &str) -> ProviderQuotaStatus {
    ProviderQuotaStatus {
        provider_id: p.to_string(),
        display_name: provider_name(p).to_string(),
        is_available: false,
        is_auth: false,
        primary_usage_percent: 0.0,
        primary_remaining_percent: 100.0,
        primary_reset_at: None,
        time_until_reset_ms: None,
        windows: Vec::new(),
        metadata: HashMap::new(),
        last_updated_ms: 0,
        error: None,
    }
}

fn build_cache_result(providers: &[&str]) -> Value {
    let mut result = serde_json::Map::new();
    let cache_guard = CACHE.lock().unwrap();
    if let Some(cache) = cache_guard.as_ref() {
        for &p in providers {
            if let Some((_, status)) = cache.entries.get(p) {
                if let Ok(v) = serde_json::to_value(status) {
                    result.insert(p.to_string(), v);
                }
            } else {
                let def = default_provider_status(p);
                if let Ok(v) = serde_json::to_value(&def) {
                    result.insert(p.to_string(), v);
                }
            }
        }
    }
    Value::Object(result)
}

#[tauri::command]
pub fn get_subscription_quotas(request: Option<Value>, force: Option<bool>) -> Value {
    let is_force = force.unwrap_or(false)
        || request
            .as_ref()
            .and_then(|r| r.get("force").and_then(|v| v.as_bool()))
            .unwrap_or(false);

    let all_supported = [
        "antigravity",
        "qoder",
        "claude",
        "codex",
        "opencode",
        "grok",
        "gemini",
        "cursor",
        "droid",
        "copilot",
        "deepseek",
        "kimi",
    ];

    let requested_providers: Vec<String> = request
        .as_ref()
        .and_then(|r| r.get("providers").and_then(|v| v.as_array()))
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .filter(|s| all_supported.contains(&s.as_str()))
                .collect()
        })
        .unwrap_or_default();

    let target_providers: Vec<&str> = if !requested_providers.is_empty() {
        all_supported
            .iter()
            .copied()
            .filter(|p| requested_providers.iter().any(|req| req == p))
            .collect()
    } else {
        all_supported.to_vec()
    };

    {
        let mut cache_guard = CACHE.lock().unwrap();
        if cache_guard.is_none() {
            *cache_guard = Some(QuotaCache {
                entries: load_persisted_cache(),
            });
        }
    }

    let mut to_fetch: Vec<String> = Vec::new();
    {
        let cache_guard = CACHE.lock().unwrap();
        let cache = cache_guard.as_ref().unwrap();

        for &p in &target_providers {
            let needs_fetch = if is_force {
                true
            } else if let Some((fetched_at, _)) = cache.entries.get(p) {
                fetched_at.elapsed() > Duration::from_secs(CACHE_TTL_SECS)
            } else {
                true
            };

            if needs_fetch {
                to_fetch.push(p.to_string());
            }
        }
    }

    // Stale-While-Revalidate: ALWAYS return immediately if not forced, refresh in background
    if !is_force {
        if !to_fetch.is_empty() {
            if !IS_REFRESHING.swap(true, std::sync::atomic::Ordering::SeqCst) {
                let _target_list: Vec<String> = target_providers.iter().map(|&s| s.to_string()).collect();
                std::thread::spawn(move || {
                    let mut fresh_entries = Vec::new();
                    for p in to_fetch {
                        let status = fetch_single_provider(&p);
                        fresh_entries.push((p, status));
                    }
                    if let Ok(mut guard) = CACHE.lock() {
                        if let Some(cache) = guard.as_mut() {
                            for (p, status) in fresh_entries {
                                cache.entries.insert(p, (Instant::now(), status));
                            }
                            save_persisted_cache(cache);
                        }
                    }
                    IS_REFRESHING.store(false, std::sync::atomic::Ordering::SeqCst);

                    // Push live updated quotas to frontend WebView asynchronously
                    #[cfg(not(test))]
                    {
                        use tauri::Emitter;
                        if let Some(app) = crate::get_app_handle() {
                            let targets: Vec<&str> = _target_list.iter().map(|s| s.as_str()).collect();
                            let updated_payload = build_cache_result(&targets);
                            let _ = app.emit("kite://subscription-quotas-updated", updated_payload);
                        }
                    }
                });
            }
        }
        return build_cache_result(&target_providers);
    }

    // Synchronous fetch only when explicitly forced by user (e.g. Refresh button clicked or unit tests)
    if !to_fetch.is_empty() {
        let mut newly_fetched = Vec::new();
        std::thread::scope(|s| {
            let mut handles = Vec::new();
            for p in &to_fetch {
                let handle = s.spawn(|| {
                    let status = fetch_single_provider(p);
                    (p.clone(), status)
                });
                handles.push(handle);
            }

            for handle in handles {
                if let Ok((p, status)) = handle.join() {
                    newly_fetched.push((p, status));
                }
            }
        });

        let mut cache_guard = CACHE.lock().unwrap();
        if let Some(cache) = cache_guard.as_mut() {
            for (p, status) in newly_fetched {
                cache.entries.insert(p, (Instant::now(), status));
            }
            save_persisted_cache(cache);
        }
    }

    build_cache_result(&target_providers)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fetch_grok_quota() {
        let q = fetch_grok_quota();
        println!("GROK RESULT: is_available={}, is_auth={}, error={:?}, meta={:?}", q.is_available, q.is_auth, q.error, q.metadata);
        assert!(q.is_available);
        assert!(q.is_auth);
    }

    #[test]
    fn test_fetch_antigravity_quota() {
        let q = fetch_antigravity_quota();
        println!("ANTIGRAVITY RESULT: is_available={}, is_auth={}, remaining={}%", q.is_available, q.is_auth, q.primary_remaining_percent);
        println!("ANTIGRAVITY EMAIL: {:?}", q.metadata.get("email"));
        assert!(q.is_available);
        assert!(q.is_auth);
        assert_eq!(q.metadata.get("email").and_then(|v| v.as_str()), Some("arxonlabs@gmail.com"));
    }

    #[test]
    fn test_fetch_qoder_quota() {
        let q = fetch_qoder_quota();
        println!("QODER RESULT: is_available={}, is_auth={}, remaining={}%", q.is_available, q.is_auth, q.primary_remaining_percent);
        if q.is_available {
            assert!(q.is_auth);
        }
    }

    #[test]
    fn test_fetch_cursor_quota() {
        let q = fetch_cursor_quota();
        println!("CURSOR RESULT: is_available={}, is_auth={}, error={:?}, meta={:?}, windows={:?}", q.is_available, q.is_auth, q.error, q.metadata, q.windows);
        assert!(q.is_available);
    }

    #[test]
    fn test_all_quotas() {
        let val = get_subscription_quotas(None, Some(true));
        println!("ALL QUOTAS:\n{}", serde_json::to_string_pretty(&val).unwrap());
    }
}
