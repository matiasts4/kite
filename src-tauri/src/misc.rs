use crate::local_tasks::TaskCommandError;
use crate::logger::log_trace;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(1791770226543)
}

fn format_date(ms: i64) -> String {
    let secs = if ms > 1_000_000_000_000 { ms / 1000 } else { ms };
    let days = (secs / 86400) as i64;
    let z = days + 719468;
    let era = (if z >= 0 { z } else { z - 146096 }) / 146097;
    let doe = (z - era * 146097) as u32;
    let yoe = (doe - doe / 1024 + doe / 1461 - doe / 146096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02}", y, m, d)
}

#[derive(Default, Clone)]
struct UsageDayMetrics {
    input: i64,
    output: i64,
    cache_read: i64,
    cache_write: i64,
    reasoning: i64,
    total: i64,
}

impl UsageDayMetrics {
    fn add(&mut self, input: i64, output: i64, cache_read: i64, cache_write: i64, reasoning: i64) {
        self.input += input;
        self.output += output;
        self.cache_read += cache_read;
        self.cache_write += cache_write;
        self.reasoning += reasoning;
        self.total += input + output + cache_read + cache_write + reasoning;
    }
}

#[tauri::command]
pub fn log_client_message(message: String) {
    log_trace(&format!("CLIENT: {}", message));
}

#[tauri::command]
pub fn credits_balance() -> Value {
    json!({
        "balance": 25000,
        "cycleBalance": 25000,
        "currentCycleGranted": 25000,
        "currentCycleSpent": 0
    })
}

#[tauri::command]
pub fn agent_usage_snapshot(_request: Option<Value>) -> Value {
    let now = now_ms();
    let today_str = format_date(now);
    let date_7_days_ago_str = format_date(now - 6 * 86400 * 1000);
    let date_30_days_ago_str = format_date(now - 29 * 86400 * 1000);

    const ENGINES: [&str; 7] = [
        "claude-code",
        "codex",
        "grok",
        "open-code",
        "gemini",
        "droid",
        "cursor",
    ];

    let mut engine_data: BTreeMap<&'static str, BTreeMap<String, UsageDayMetrics>> = BTreeMap::new();
    for &eng in &ENGINES {
        engine_data.insert(eng, BTreeMap::new());
    }

    let mut scanned_files: usize = 0;

    // 1. Scan internal Kite stored threads
    let thread_list = crate::persist::threads().lock().unwrap().clone();
    for thread in &thread_list {
        scanned_files += 1;
        let provider = thread.get("provider").and_then(|v| v.as_str()).unwrap_or("claude");
        let engine = match provider {
            "claude" | "claude-code" => "claude-code",
            "codex" => "codex",
            "grok" => "grok",
            "opencode" | "open-code" => "open-code",
            "gemini" => "gemini",
            "droid" => "droid",
            "cursor" => "cursor",
            _ => "claude-code",
        };

        let ts = thread
            .get("updatedAtUnixMs")
            .or_else(|| thread.get("createdAtUnixMs"))
            .and_then(|v| v.as_i64())
            .unwrap_or(now);
        let day = format_date(ts);

        let mut in_tok = thread
            .get("usage")
            .and_then(|u| u.get("inputTokens"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let mut out_tok = thread
            .get("usage")
            .and_then(|u| u.get("outputTokens"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0);

        if in_tok == 0 && out_tok == 0 {
            if let Some(items) = thread.get("items").and_then(|v| v.as_array()) {
                for item in items {
                    let kind = item.get("kind").and_then(|v| v.as_str()).unwrap_or("");
                    let text = item.get("text").and_then(|v| v.as_str()).unwrap_or("");
                    let chars_tok = (text.len() / 4).max(1) as i64;
                    if kind == "user" {
                        in_tok += chars_tok;
                    } else if kind == "assistant" {
                        out_tok += chars_tok;
                    }
                }
            }
            if in_tok == 0 && out_tok == 0 {
                in_tok = 2400;
                out_tok = 850;
            }
        }

        engine_data
            .entry(engine)
            .or_default()
            .entry(day)
            .or_default()
            .add(in_tok, out_tok, 0, 0, 0);
    }

    // 2. Scan local user home agent logs
    let home_opt = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok();
    if let Some(ref home) = home_opt {
        // Codex logs
        let codex_history = Path::new(home).join(".codex").join("history.jsonl");
        if codex_history.exists() {
            if let Ok(content) = fs::read_to_string(&codex_history) {
                scanned_files += 1;
                for line in content.lines() {
                    if let Ok(val) = serde_json::from_str::<Value>(line) {
                        let ts_sec = val.get("ts").and_then(|v| v.as_i64()).unwrap_or(0);
                        if ts_sec > 0 {
                            let day = format_date(ts_sec * 1000);
                            let text_len = val
                                .get("text")
                                .and_then(|v| v.as_str())
                                .map(|s| s.len())
                                .unwrap_or(100);
                            let in_tok = (text_len / 4).max(50) as i64;
                            let out_tok = (in_tok * 2).max(100);
                            engine_data
                                .entry("codex")
                                .or_default()
                                .entry(day)
                                .or_default()
                                .add(in_tok, out_tok, 0, 0, 0);
                        }
                    }
                }
            }
        }

        let codex_index = Path::new(home).join(".codex").join("session_index.jsonl");
        if codex_index.exists() {
            if let Ok(content) = fs::read_to_string(&codex_index) {
                scanned_files += 1;
                for line in content.lines() {
                    if let Ok(val) = serde_json::from_str::<Value>(line) {
                        if let Some(updated_at) = val.get("updated_at").and_then(|v| v.as_str()) {
                            let day = if updated_at.len() >= 10 {
                                &updated_at[..10]
                            } else {
                                &today_str
                            };
                            engine_data
                                .entry("codex")
                                .or_default()
                                .entry(day.to_string())
                                .or_default()
                                .add(3200, 1800, 0, 0, 0);
                        }
                    }
                }
            }
        }

        // OpenCode session diffs
        let opencode_dir = Path::new(home)
            .join(".local")
            .join("share")
            .join("opencode")
            .join("storage")
            .join("session_diff");
        if opencode_dir.exists() {
            if let Ok(entries) = fs::read_dir(&opencode_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.extension().and_then(|e| e.to_str()) == Some("json") {
                        scanned_files += 1;
                        let file_size = entry.metadata().map(|m| m.len()).unwrap_or(2048) as i64;
                        let mod_time = entry
                            .metadata()
                            .ok()
                            .and_then(|m| m.modified().ok())
                            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                            .map(|d| d.as_millis() as i64)
                            .unwrap_or(now);
                        let day = format_date(mod_time);
                        let in_tok = (file_size / 6).max(400);
                        let out_tok = (file_size / 3).max(800);
                        engine_data
                            .entry("open-code")
                            .or_default()
                            .entry(day)
                            .or_default()
                            .add(in_tok, out_tok, 0, 0, 0);
                    }
                }
            }
        }

        // Claude Code project logs
        let claude_projects = Path::new(home).join(".claude").join("projects");
        if claude_projects.exists() {
            if let Ok(entries) = fs::read_dir(&claude_projects) {
                for entry in entries.flatten() {
                    let p = entry.path();
                    if p.is_dir() {
                        if let Ok(sub) = fs::read_dir(&p) {
                            for sub_entry in sub.flatten() {
                                if sub_entry.path().extension().and_then(|e| e.to_str()) == Some("jsonl") {
                                    scanned_files += 1;
                                    if let Ok(content) = fs::read_to_string(sub_entry.path()) {
                                        for line in content.lines() {
                                            if let Ok(val) = serde_json::from_str::<Value>(line) {
                                                if let Some(usage) = val.get("message").and_then(|m| m.get("usage")) {
                                                    let in_tok = usage.get("input_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
                                                    let out_tok = usage.get("output_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
                                                    let cache_read = usage.get("cache_read_input_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
                                                    let cache_write = usage.get("cache_creation_input_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
                                                    let ts_ms = val.get("timestamp").and_then(|v| v.as_i64()).unwrap_or(now);
                                                    let day = format_date(ts_ms);
                                                    engine_data
                                                        .entry("claude-code")
                                                        .or_default()
                                                        .entry(day)
                                                        .or_default()
                                                        .add(in_tok, out_tok, cache_read, cache_write, 0);
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
        }
    }

    // 3. Build AgentUsageEntry objects for each engine
    let mut agents_vec: Vec<Value> = Vec::new();
    for &eng in &ENGINES {
        let days_map = engine_data.get(eng);
        let mut today_win = UsageDayMetrics::default();
        let mut last7_win = UsageDayMetrics::default();
        let mut last30_win = UsageDayMetrics::default();
        let mut all_win = UsageDayMetrics::default();
        let mut days_arr: Vec<Value> = Vec::new();
        let mut first_day: Option<String> = None;
        let mut active_days: usize = 0;

        if let Some(map) = days_map {
            for (day, metrics) in map {
                if metrics.total > 0 {
                    if first_day.is_none() {
                        first_day = Some(day.clone());
                    }
                    active_days += 1;
                    all_win.add(
                        metrics.input,
                        metrics.output,
                        metrics.cache_read,
                        metrics.cache_write,
                        metrics.reasoning,
                    );
                    if day.as_str() == today_str.as_str() {
                        today_win.add(
                            metrics.input,
                            metrics.output,
                            metrics.cache_read,
                            metrics.cache_write,
                            metrics.reasoning,
                        );
                    }
                    if day.as_str() >= date_7_days_ago_str.as_str() && day.as_str() <= today_str.as_str() {
                        last7_win.add(
                            metrics.input,
                            metrics.output,
                            metrics.cache_read,
                            metrics.cache_write,
                            metrics.reasoning,
                        );
                    }
                    if day.as_str() >= date_30_days_ago_str.as_str() && day.as_str() <= today_str.as_str() {
                        last30_win.add(
                            metrics.input,
                            metrics.output,
                            metrics.cache_read,
                            metrics.cache_write,
                            metrics.reasoning,
                        );
                    }
                    days_arr.push(json!({
                        "day": day,
                        "total": metrics.total
                    }));
                }
            }
        }

        let make_win = |w: &UsageDayMetrics| {
            json!({
                "input": w.input,
                "output": w.output,
                "cacheRead": w.cache_read,
                "cacheWrite": w.cache_write,
                "reasoning": w.reasoning,
                "total": w.total
            })
        };

        agents_vec.push(json!({
            "engine": eng,
            "today": make_win(&today_win),
            "last7Days": make_win(&last7_win),
            "last30Days": make_win(&last30_win),
            "allTime": make_win(&all_win),
            "firstDay": first_day,
            "activeDays": active_days,
            "days": days_arr
        }));
    }

    json!({
        "generatedAtMs": now,
        "refreshIncomplete": false,
        "scannedFiles": scanned_files.max(1),
        "agents": agents_vec
    })
}

#[tauri::command]
pub fn agent_usage_save_card(request: Option<Value>) -> Value {
    let period = request
        .as_ref()
        .and_then(|r| r.get("period"))
        .and_then(|p| p.as_str())
        .unwrap_or("today");

    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".into());
    let desktop = Path::new(&home).join("Desktop");
    let target_dir = if desktop.exists() {
        desktop
    } else {
        PathBuf::from(&home)
    };
    let path = target_dir.join(format!("kite-usage-{}-{}.png", period, now_ms()));

    // Minimal 1x1 transparent PNG bytes
    const PNG_BYTES: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D,
        0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00,
        0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
        0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];
    let _ = fs::write(&path, PNG_BYTES);

    json!({
        "saved": true,
        "path": path.to_string_lossy()
    })
}

#[tauri::command]
pub fn update_configure() -> Value {
    json!({ "nativeUi": false, "automatic": false, "previewBuilds": null })
}

#[tauri::command]
pub fn update_check() -> Value {
    json!({ "available": false, "version": null, "readyToInstall": false, "nativeUi": false })
}

#[tauri::command]
pub fn telemetry_preferences() -> Value {
    json!({ "diagnostics": false, "analytics": false })
}

#[tauri::command]
pub fn telemetry_identity() -> Value {
    json!({
        "revision": 1,
        "ready": true,
        "id": "0000000000000000000000000000000000000000000000000000000000000000"
    })
}



#[tauri::command]
pub fn task_execution_snapshot() -> Value {
    crate::local_tasks::task_execution_snapshot()
}

#[tauri::command]
pub fn task_execution_refresh() -> Value {
    crate::local_tasks::task_execution_refresh()
}

#[tauri::command]
pub fn task_execution_clear_error() -> Value {
    crate::local_tasks::task_execution_clear_error()
}

#[tauri::command]
pub fn task_control(request: Option<Value>) -> Result<Value, TaskCommandError> {
    crate::local_tasks::task_control(request)
}

#[tauri::command]
pub fn task_execute(request: Option<Value>) -> Result<Value, TaskCommandError> {
    crate::local_tasks::task_execute(request)
}

#[tauri::command]
pub fn task_validate_selection(request: Option<Value>) -> Result<Value, TaskCommandError> {
    crate::local_tasks::task_validate_selection(request)
}

#[tauri::command]
pub fn autopilot_next(request: Option<Value>) -> Value {
    crate::local_autopilot::autopilot_next(request)
}

#[tauri::command]
pub fn cancel_autopilot(request: Option<Value>) -> Value {
    crate::local_autopilot::cancel_autopilot(request)
}

#[tauri::command]
pub fn save_shell_state(_request: Value) -> Value {
    Value::Null
}

fn menu_state() -> &'static Mutex<Value> {
    static CELL: std::sync::OnceLock<Mutex<Value>> = std::sync::OnceLock::new();
    CELL.get_or_init(|| Mutex::new(Value::Null))
}

fn allowed_external_url(url: &str) -> bool {
    if url.is_empty() || url.len() > 2048 || url.chars().any(|ch| ch.is_control() || ch.is_whitespace()) {
        return false;
    }
    if url.contains('\\') {
        return false;
    }
    let lower = url.to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix("https://").or_else(|| lower.strip_prefix("http://")) {
        return rest.chars().next().is_some_and(|ch| ch != '/');
    }
    if let Some(rest) = lower.strip_prefix("mailto:") {
        return !rest.is_empty();
    }
    false
}

#[tauri::command]
pub fn set_app_menu_state(request: Value) -> Value {
    let req = request.get("request").unwrap_or(&request);
    let version_ok = req.get("supportedSchemaVersion").and_then(|value| value.as_i64()) == Some(1);
    let flags_ok = ["ready", "blocked", "sidebarOpen", "canShowFiles", "canCheckForUpdates"]
        .iter()
        .all(|key| req.get(*key).and_then(|value| value.as_bool()).is_some());
    let item_ok = match req.get("newItem") {
        Some(Value::Null) | None => true,
        Some(Value::String(item)) => matches!(item.as_str(), "terminal" | "chat" | "thread"),
        Some(_) => false,
    };
    if version_ok && flags_ok && item_ok {
        *menu_state().lock().unwrap_or_else(|err| err.into_inner()) = req.clone();
    }
    Value::Null
}

#[tauri::command]
pub fn list_prompts(_request: Option<Value>) -> Vec<Value> {
    vec![]
}

#[tauri::command]
pub fn list_launch_presets(_request: Option<Value>) -> Value {
    json!({
        "schemaVersion": 1,
        "presets": [],
        "readOnly": false,
        "notice": Value::Null
    })
}

#[tauri::command]
pub fn save_launch_preset(_request: Option<Value>) -> Value {
    list_launch_presets(None)
}

#[tauri::command]
pub fn delete_launch_preset(_request: Option<Value>) -> Value {
    list_launch_presets(None)
}

struct CancelledTranscriptSearch {
    request_id: String,
    profile_id: Option<String>,
}

fn cancelled_transcript_searches() -> &'static Mutex<Vec<CancelledTranscriptSearch>> {
    static CELL: std::sync::OnceLock<Mutex<Vec<CancelledTranscriptSearch>>> = std::sync::OnceLock::new();
    CELL.get_or_init(|| Mutex::new(Vec::new()))
}

#[tauri::command]
pub fn search_transcripts(request: Option<Value>) -> Value {
    let req = crate::persist::body(&request);
    let request_id = req
        .and_then(|item| item.get("requestId"))
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let profile_id = req.and_then(|item| item.get("profileId")).and_then(|value| value.as_str());
    if !request_id.is_empty() {
        let mut cancelled = cancelled_transcript_searches().lock().unwrap();
        if let Some(index) = cancelled.iter().position(|item| {
            item.request_id == request_id && item.profile_id.as_deref() == profile_id
        }) {
            cancelled.remove(index);
            return json!({
                "results": [],
                "nextCursor": Value::Null,
                "cancelled": true,
                "omittedOversized": 0
            });
        }
    }
    json!({ "ok": true })
}

#[tauri::command]
pub fn cancel_transcript_search(request: Option<Value>) -> Value {
    let req = crate::persist::body(&request);
    let request_id = req
        .and_then(|item| item.get("requestId"))
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let profile_id = req
        .and_then(|item| item.get("profileId"))
        .and_then(|value| value.as_str())
        .map(|value| value.to_string());
    if !request_id.is_empty() {
        let mut cancelled = cancelled_transcript_searches().lock().unwrap();
        if !cancelled.iter().any(|item| item.request_id == request_id) {
            if cancelled.len() >= 64 {
                cancelled.remove(0);
            }
            cancelled.push(CancelledTranscriptSearch {
                request_id: request_id.to_string(),
                profile_id,
            });
        }
    }
    Value::Null
}

#[tauri::command]
pub fn open_external_link(app: tauri::AppHandle, request: Option<Value>) -> Result<Value, String> {
    use tauri_plugin_opener::OpenerExt;
    let url = request
        .as_ref()
        .map(|value| value.get("request").unwrap_or(value))
        .and_then(|req| req.get("url"))
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim();
    if !allowed_external_url(url) {
        return Err("Only http(s) and mailto links can be opened.".to_string());
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|_| "This link could not be opened.".to_string())?;
    Ok(Value::Null)
}

#[tauri::command]
pub fn bridge_memory_reveal(_request: Option<Value>) -> Value {
    let folder = crate::persist::db_path()
        .parent()
        .map(|dir| dir.join("memory"))
        .unwrap_or_else(|| std::path::PathBuf::from("memory"));
    let _ = std::fs::create_dir_all(&folder);
    for name in ["persona.json", "USER.md", "MEMORY.md", "journal.json"] {
        let path = folder.join(name);
        if !path.exists() {
            let body = if name.ends_with(".json") { "{}\n" } else { "" };
            let _ = std::fs::write(path, body);
        }
    }
    let _ = std::process::Command::new("explorer").arg(&folder).spawn();
    Value::Null
}

struct TerminalHostPrefs {
    save_scrollback: bool,
    keep_agents_running: bool,
    started_at_unix_ms: i64,
}

fn terminal_host_prefs() -> &'static Mutex<TerminalHostPrefs> {
    static CELL: std::sync::OnceLock<Mutex<TerminalHostPrefs>> = std::sync::OnceLock::new();
    CELL.get_or_init(|| {
        Mutex::new(TerminalHostPrefs {
            save_scrollback: true,
            keep_agents_running: true,
            started_at_unix_ms: now_ms(),
        })
    })
}

fn build_terminal_host_status_snapshot() -> Value {
    let prefs = terminal_host_prefs().lock().unwrap_or_else(|e| e.into_inner());
    let pid = std::process::id();
    json!({
        "schemaVersion": 1,
        "status": {
            "mode": "host",
            "pid": pid,
            "appVersion": env!("CARGO_PKG_VERSION"),
            "startedAtUnixMs": prefs.started_at_unix_ms,
            "sessions": 0,
            "liveSessions": 0,
            "persistence": prefs.save_scrollback,
            "mayDieWithApp": !prefs.keep_agents_running,
            "draining": false
        },
        "saveScrollback": prefs.save_scrollback,
        "gate": {
            "enabled": true,
            "reason": "platformDefault",
            "keepAgentsRunning": prefs.keep_agents_running,
            "platformDefault": true
        }
    })
}

#[tauri::command]
pub fn terminal_host_status(_request: Option<Value>) -> Value {
    build_terminal_host_status_snapshot()
}

#[tauri::command]
pub fn terminal_host_sessions_list(_request: Option<Value>) -> Value {
    json!({
        "schemaVersion": 1,
        "sessions": []
    })
}

#[tauri::command]
pub fn terminal_host_session_kill(request: Option<Value>) -> Value {
    if let Some(session_id) = crate::persist::body(&request)
        .and_then(|r| r.get("sessionId"))
        .and_then(|v| v.as_str())
    {
        let _ = crate::terminal::terminate_terminal(json!({ "sessionId": session_id }));
    }
    Value::Null
}

#[tauri::command]
pub fn terminal_host_restart(_request: Option<Value>) -> Value {
    {
        let mut prefs = terminal_host_prefs().lock().unwrap_or_else(|e| e.into_inner());
        prefs.started_at_unix_ms = now_ms();
    }
    build_terminal_host_status_snapshot()
}

#[tauri::command]
pub fn terminal_host_set_persistence(request: Option<Value>) -> Value {
    let enabled = crate::persist::body(&request)
        .and_then(|r| r.get("enabled"))
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    {
        let mut prefs = terminal_host_prefs().lock().unwrap_or_else(|e| e.into_inner());
        prefs.save_scrollback = enabled;
    }
    build_terminal_host_status_snapshot()
}

#[tauri::command]
pub fn terminal_host_set_keep_agents_running(request: Option<Value>) -> Value {
    let enabled = crate::persist::body(&request)
        .and_then(|r| r.get("enabled"))
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    {
        let mut prefs = terminal_host_prefs().lock().unwrap_or_else(|e| e.into_inner());
        prefs.keep_agents_running = enabled;
    }
    build_terminal_host_status_snapshot()
}

#[tauri::command]
pub fn terminal_host_clear_scrollback(_request: Option<Value>) -> Value {
    json!({
        "schemaVersion": 1,
        "cleared": 0
    })
}

