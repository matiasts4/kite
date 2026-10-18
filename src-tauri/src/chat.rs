use crate::persist::{last_provider, next_revision, notifications, persist, threads, workspace_path};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub struct TurnRun {
    pub revision: String,
    pub events: Vec<Value>,
    pub next_sequence: u64,
    pub assistant_id: String,
    pub assistant_text: String,
    pub child: Option<Arc<Mutex<std::process::Child>>>,
    pub stdin: Option<Arc<Mutex<std::process::ChildStdin>>>,
    pub closing: bool,
    pub finished: bool,
    pub started_at_ms: i64,
    pub routine_id: Option<String>,
}

pub struct LiveTurns {
    pub runs: HashMap<String, TurnRun>,
    pub by_thread: HashMap<String, String>,
}

pub fn live_turns() -> &'static Mutex<LiveTurns> {
    static CELL: std::sync::OnceLock<Mutex<LiveTurns>> = std::sync::OnceLock::new();
    CELL.get_or_init(|| {
        Mutex::new(LiveTurns {
            runs: HashMap::new(),
            by_thread: HashMap::new(),
        })
    })
}

pub fn live_cv() -> &'static Condvar {
    static CELL: std::sync::OnceLock<Condvar> = std::sync::OnceLock::new();
    CELL.get_or_init(Condvar::new)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub(crate) fn chat_log(msg: &str) {
    eprintln!("[Kite:Chat] {}", msg);
}

fn prune_stale_runs(live: &mut LiveTurns) {
    let now = now_ms();
    let stale_keys: Vec<String> = live
        .runs
        .iter()
        .filter(|(_, run)| run.finished && (now.saturating_sub(run.started_at_ms) > 120_000))
        .map(|(k, _)| k.clone())
        .collect();

    for k in stale_keys {
        live.runs.remove(&k);
        live.by_thread.retain(|_, rid| rid != &k);
    }
}

struct CachedProviderModels {
    models: Vec<Value>,
    cached_at: Instant,
}

static MODEL_CACHE: std::sync::OnceLock<Mutex<HashMap<String, CachedProviderModels>>> = std::sync::OnceLock::new();

fn model_cache() -> &'static Mutex<HashMap<String, CachedProviderModels>> {
    MODEL_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

const MODEL_CACHE_TTL: Duration = Duration::from_secs(900); // 15 minutes TTL

fn user_home_dir() -> PathBuf {
    if let Ok(profile) = std::env::var("USERPROFILE") {
        PathBuf::from(profile)
    } else if let Ok(home) = std::env::var("HOME") {
        PathBuf::from(home)
    } else {
        PathBuf::from(".")
    }
}

pub(crate) fn provider_models(provider: &str, force_refresh: bool) -> Value {
    let canon = match provider {
        "agy" => "antigravity",
        "claude-code" => "claude",
        "open-code" => "opencode",
        other => other,
    };

    // 1. Check cache first unless force_refresh is requested
    if !force_refresh {
        if let Ok(cache) = model_cache().lock() {
            if let Some(entry) = cache.get(canon) {
                if entry.cached_at.elapsed() < MODEL_CACHE_TTL && !entry.models.is_empty() {
                    return json!({
                        "provider": canon,
                        "models": entry.models,
                        "cached": true,
                    });
                }
            }
        }
    }

    // 2. Fetch fresh dynamic models per provider
    let fresh_models = match canon {
        "antigravity" => fetch_antigravity_models_dynamic(),
        "codex" => fetch_codex_models_dynamic(),
        "cursor" => vec![
            model_row("auto", "Auto", "Cursor picks a model", false),
            model_row("composer", "Composer", "Cursor coding model", false),
        ],
        "grok" => vec![
            model_row("grok-build", "Grok Build", "xAI Grok Build", true),
            model_row("grok-code", "Grok Code", "Fast coding and terminal execution", true),
        ],
        "opencode" => vec![
            model_row("auto", "Auto", "OpenCode default model", false),
        ],
        "claude" => vec![
            model_row("sonnet", "Claude Sonnet 5", "Balanced daily driver", true),
            model_row("opus", "Claude Opus (latest)", "Latest Opus release", true),
            model_row("claude-opus-5-5", "Claude Opus 5.5", "Long-running agentic work", true),
            model_row("fable", "Claude Fable 5.1", "Hardest problems", true),
            model_row("haiku", "Claude Haiku 4.5", "Fastest replies", false),
        ],
        "gemini" => vec![
            model_row("gemini-4-argon", "Gemini 4 Argon", "Frontier reasoning & agentic coding", true),
            model_row("gemini-3.8-flash", "Gemini 3.8 Flash", "Ultra-fast agentic execution", true),
        ],
        _ => Vec::new(),
    };

    // 3. Cache the results if non-empty
    if !fresh_models.is_empty() {
        if let Ok(mut cache) = model_cache().lock() {
            cache.insert(
                canon.to_string(),
                CachedProviderModels {
                    models: fresh_models.clone(),
                    cached_at: Instant::now(),
                },
            );
        }
    }

    json!({
        "provider": canon,
        "models": fresh_models,
        "cached": false,
    })
}

fn fetch_antigravity_models_dynamic() -> Vec<Value> {
    if let Some(live) = query_agy_models_cli() {
        if !live.is_empty() {
            return live;
        }
    }
    antigravity_fallback_models()
}

fn query_agy_models_cli() -> Option<Vec<Value>> {
    let program = resolve_bin("agy", &[r"C:\Users\PC\AppData\Local\agy\bin\agy.exe"])?;
    // `agy models` also boots the CLI's MCP servers. Run it inside a hidden
    // console so those console children can never surface as terminal windows
    // (see `crate::hidden_exec`).
    let out = crate::hidden_exec::run(&program, &["models"], Duration::from_secs(8)).ok()?;
    if !out.success() {
        return None;
    }
    let raw = out.stdout_lossy();

    let mut parsed: Vec<Value> = Vec::new();
    let mut seen_base_ids = std::collections::HashSet::new();

    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty()
            || trimmed.starts_with("Fetching")
            || trimmed.starts_with("Available")
            || trimmed.starts_with('-')
        {
            continue;
        }

        let (raw_id, raw_name) = if let Some(idx) = trimmed.find('\t') {
            (trimmed[..idx].trim(), trimmed[idx + 1..].trim())
        } else if let Some(idx) = trimmed.find("  ") {
            (trimmed[..idx].trim(), trimmed[idx..].trim())
        } else {
            (trimmed, trimmed)
        };

        if raw_id.is_empty() {
            continue;
        }

        // Clean effort suffixes (-low, -medium, -high, -xhigh, -max) to get clean base model ID
        let (base_id, has_effort_suffix) = if let Some(stripped) = raw_id.strip_suffix("-high") {
            (stripped, true)
        } else if let Some(stripped) = raw_id.strip_suffix("-medium") {
            (stripped, true)
        } else if let Some(stripped) = raw_id.strip_suffix("-low") {
            (stripped, true)
        } else if let Some(stripped) = raw_id.strip_suffix("-xhigh") {
            (stripped, true)
        } else if let Some(stripped) = raw_id.strip_suffix("-max") {
            (stripped, true)
        } else {
            (raw_id, false)
        };

        if !seen_base_ids.insert(base_id.to_string()) {
            continue;
        }

        // Clean display name by stripping effort parenthesis (e.g. "Gemini 3.8 Flash (Medium)" -> "Gemini 3.8 Flash")
        let clean_name = raw_name
            .replace(" (High)", "")
            .replace(" (Medium)", "")
            .replace(" (Low)", "")
            .replace(" (Adaptive)", "");

        let id_lower = base_id.to_lowercase();
        let description = if id_lower.contains("gemini-4") || id_lower.contains("argon") {
            "Frontier reasoning & agentic coding (Google DeepMind)"
        } else if id_lower.contains("flash") {
            "Ultra-fast, lightweight agentic execution (Google DeepMind)"
        } else if id_lower.contains("opus") {
            "Frontier reasoning for long-horizon agentic work (Anthropic)"
        } else if id_lower.contains("sonnet") {
            "Balanced high-speed coding & design (Anthropic)"
        } else if id_lower.contains("120b") {
            "Open-weights 120B parameter model hosted on Antigravity"
        } else {
            "Antigravity live model"
        };

        let supports_effort = has_effort_suffix
            || id_lower.contains("gemini")
            || id_lower.contains("claude")
            || id_lower.contains("argon")
            || id_lower.contains("flash");

        parsed.push(model_row(base_id, &clean_name, description, supports_effort));
    }

    if parsed.is_empty() {
        return None;
    }

    Some(parsed)
}

fn antigravity_fallback_models() -> Vec<Value> {
    vec![
        model_row("gemini-4-argon", "Gemini 4 Argon", "Frontier reasoning & agentic coding (Google DeepMind)", true),
        model_row("gemini-3.8-flash", "Gemini 3.8 Flash", "Ultra-fast, lightweight agentic execution (Google DeepMind)", true),
        model_row("claude-opus-5-5", "Claude Opus 5.5", "Frontier reasoning on Antigravity (Anthropic)", true),
        model_row("claude-sonnet-5-5", "Claude Sonnet 5.5", "Balanced high-speed coding on Antigravity (Anthropic)", true),
        model_row("gpt-oss-120b", "GPT-OSS 120B", "Open-weights 120B model hosted on Antigravity", false),
    ]
}

fn fetch_codex_models_dynamic() -> Vec<Value> {
    let mut models = Vec::new();
    let mut seen = std::collections::HashSet::new();

    let home = user_home_dir();
    let config_path = home.join(".codex").join("config.toml");
    if let Ok(contents) = std::fs::read_to_string(config_path) {
        for line in contents.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with("model") && trimmed.contains('=') {
                if let Some(idx) = trimmed.find('=') {
                    let raw_val = trimmed[idx + 1..].trim().trim_matches('"').trim_matches('\'');
                    if !raw_val.is_empty() && seen.insert(raw_val.to_string()) {
                        let label = format!("{} (Configured Default)", raw_val);
                        models.push(model_row(raw_val, &label, "Configured in ~/.codex/config.toml", true));
                    }
                }
            }
        }
    }

    let default_codex = [
        ("gpt-6.1-sol", "GPT-6.1 Sol", "Latest frontier reasoning and coding agent", true),
        ("gpt-6-astra", "GPT-6 Astra", "Most capable for complex agentic workflows", true),
        ("gpt-6-sol", "GPT-6 Sol", "Complex coding and agentic work", true),
        ("gpt-6-luna", "GPT-6 Luna", "Fast, efficient work", false),
        ("gpt-5.6-sol", "GPT-5.6 Sol", "Frontier agentic work", true),
        ("gpt-5.6-terra", "GPT-5.6 Terra", "Balanced agentic work", true),
        ("gpt-5.6-luna", "GPT-5.6 Luna", "Fast, efficient work", false),
    ];

    for (id, name, desc, effort) in default_codex {
        if seen.insert(id.to_string()) {
            models.push(model_row(id, name, desc, effort));
        }
    }

    models
}

fn model_row(id: &str, name: &str, description: &str, supports_effort: bool) -> Value {
    json!({
        "id": id,
        "name": name,
        "description": description,
        "supportsEffort": supports_effort,
    })
}

fn provider_ok(provider: &str) -> bool {
    matches!(provider, "antigravity" | "agy" | "claude" | "codex" | "cursor" | "grok" | "opencode" | "gemini")
}

fn mode_ok(provider: &str, mode: &str) -> bool {
    match provider {
        "codex" => matches!(mode, "acceptEdits" | "readOnly"),
        "claude" | "cursor" | "grok" | "opencode" | "antigravity" | "agy" | "gemini" => {
            matches!(mode, "acceptEdits" | "fullAccess" | "readOnly")
        }
        _ => false,
    }
}

fn default_mode(provider: &str) -> &'static str {
    if provider == "codex" {
        "acceptEdits"
    } else {
        "fullAccess"
    }
}

fn blank_thread(id: &str, profile_id: Option<&str>, title: &str, provider: &str, workspace_id: Option<&str>) -> Value {
    let now = now_ms();
    let provider = if provider_ok(provider) { provider } else { "antigravity" };
    json!({
        "schemaVersion": 1,
        "revision": next_revision(),
        "id": id,
        "profileId": profile_id,
        "provider": provider,
        "providerSessionId": Value::Null,
        "title": clip_title(title),
        "items": [],
        "plans": [],
        "mode": default_mode(provider),
        "plan": false,
        "model": Value::Null,
        "providerOptions": [],
        "status": "idle",
        "usage": { "inputTokens": 0, "outputTokens": 0, "costUsd": 0.0 },
        "workspaceId": workspace_id,
        "pinned": false,
        "pendingApproval": Value::Null,
        "createdAtUnixMs": now,
        "updatedAtUnixMs": now
    })
}

fn clip_title(title: &str) -> String {
    let trimmed = title.trim();
    let text = if trimmed.is_empty() { "Chat" } else { trimmed };
    text.chars().take(120).collect()
}

pub(crate) fn touch(thread: &mut Value) {
    if let Some(object) = thread.as_object_mut() {
        object.insert("revision".into(), Value::String(next_revision()));
        object.insert("updatedAtUnixMs".into(), json!(now_ms()));
    }
}

pub fn create_thread(profile_id: Option<&str>, title: &str, provider: &str, workspace_id: Option<&str>) -> Value {
    let id = Uuid::new_v4().to_string();
    let thread = blank_thread(&id, profile_id, title, provider, workspace_id);
    if provider_ok(provider) {
        *last_provider().lock().unwrap() = provider.to_string();
    }
    threads().lock().unwrap().push(thread.clone());
    persist();
    thread
}

pub fn load_thread(thread_id: &str, profile_id: Option<&str>, title: &str) -> Value {
    let mut items = threads().lock().unwrap();
    if let Some(existing) = items.iter().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id)) {
        return existing.clone();
    }
    let default_provider = if let Some(pid) = profile_id {
        let ag_list = crate::persist::agents().lock().unwrap();
        ag_list.iter().find(|a| a.id == pid).map(|a| match a.engine.as_str() {
            "claude" | "claude-code" => "claude",
            "codex" => "codex",
            "cursor" => "cursor",
            "gemini" => "gemini",
            "grok" => "grok",
            "opencode" | "open-code" => "opencode",
            _ => "antigravity",
        }).unwrap_or("antigravity")
    } else {
        "antigravity"
    };
    let thread = blank_thread(thread_id, profile_id, title, default_provider, None);
    items.push(thread.clone());
    drop(items);
    persist();
    thread
}

pub fn rename_thread(thread_id: &str, profile_id: Option<&str>, title: &str) -> Value {
    let mut items = threads().lock().unwrap();
    if let Some(thread) = items.iter_mut().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id)) {
        thread["title"] = json!(clip_title(title));
        if let Some(profile_id) = profile_id {
            thread["profileId"] = json!(profile_id);
        }
        touch(thread);
        let cloned = thread.clone();
        drop(items);
        persist();
        return cloned;
    }
    drop(items);
    load_thread(thread_id, profile_id, title)
}

pub fn set_pinned(thread_id: &str, pinned: bool) -> Value {
    let mut items = threads().lock().unwrap();
    if let Some(thread) = items.iter_mut().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id)) {
        thread["pinned"] = json!(pinned);
        touch(thread);
        let cloned = thread.clone();
        drop(items);
        persist();
        return cloned;
    }
    drop(items);
    load_thread(thread_id, None, "Chat")
}

pub fn configure_thread(thread_id: &str, patch: &Value) -> Value {
    let mut items = threads().lock().unwrap();
    if items.iter().all(|t| t.get("id").and_then(|v| v.as_str()) != Some(thread_id)) {
        drop(items);
        let created = blank_thread(thread_id, None, "Chat", "antigravity", None);
        threads().lock().unwrap().push(created);
        items = threads().lock().unwrap();
    }
    if let Some(thread) = items.iter_mut().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id)) {
        let current_provider = thread.get("provider").and_then(|v| v.as_str()).unwrap_or("antigravity").to_string();
        let provider = patch.get("provider").and_then(|v| v.as_str()).filter(|p| provider_ok(p)).unwrap_or(&current_provider).to_string();
        let requested_mode = patch.get("mode").and_then(|v| v.as_str()).unwrap_or("");
        let mode = if mode_ok(&provider, requested_mode) {
            requested_mode.to_string()
        } else if mode_ok(&provider, thread.get("mode").and_then(|v| v.as_str()).unwrap_or("")) {
            thread.get("mode").and_then(|v| v.as_str()).unwrap_or(default_mode(&provider)).to_string()
        } else {
            default_mode(&provider).to_string()
        };
        if let Some(plan) = patch.get("plan").and_then(|v| v.as_bool()) {
            thread["plan"] = json!(plan);
        }
        if patch.get("model").is_some() {
            thread["model"] = normalize_model(patch.get("model"));
        }
        if let Some(options) = patch.get("providerOptions").and_then(|v| v.as_array()) {
            thread["providerOptions"] = Value::Array(sanitize_options(options));
        }
        if provider != current_provider {
            thread["providerSessionId"] = Value::Null;
        }
        thread["provider"] = json!(provider);
        thread["mode"] = json!(mode);
        *last_provider().lock().unwrap() = thread["provider"].as_str().unwrap_or("antigravity").to_string();
        touch(thread);
        let cloned = thread.clone();
        drop(items);
        persist();
        return cloned;
    }
    drop(items);
    load_thread(thread_id, None, "Chat")
}

pub fn set_agent_model(agent_id: &str, thread_id: &str, provider: &str, model: Option<&Value>) -> Value {
    let provider = if provider_ok(provider) { provider } else { "antigravity" };
    let patch = json!({
        "provider": provider,
        "model": model.cloned().unwrap_or(Value::Null)
    });
    let mut thread = configure_thread(thread_id, &patch);
    thread["profileId"] = json!(agent_id);
    replace_thread(&thread);
    thread
}

pub fn set_agent_plan(agent_id: &str, thread_id: &str, plan: bool) -> Value {
    let mut thread = load_thread(thread_id, Some(agent_id), "Agent Chat");
    thread["profileId"] = json!(agent_id);
    thread["plan"] = json!(plan);
    touch(&mut thread);
    replace_thread(&thread);
    thread
}

pub(crate) fn replace_thread(thread: &Value) {
    let id = thread.get("id").and_then(|v| v.as_str()).unwrap_or("");
    let mut items = threads().lock().unwrap();
    if let Some(slot) = items.iter_mut().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(id)) {
        *slot = thread.clone();
    } else {
        items.push(thread.clone());
    }
    drop(items);
    persist();
}

fn normalize_model(model: Option<&Value>) -> Value {
    match model {
        Some(Value::String(text)) if model_id_ok(text) => Value::String(text.clone()),
        _ => Value::Null,
    }
}

fn model_id_ok(text: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    if chars.is_empty() || chars.len() > 128 || !chars[0].is_ascii_alphanumeric() {
        return false;
    }
    chars[1..]
        .iter()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | ':' | '/' | '-'))
}

fn option_id_ok(text: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    if chars.is_empty() || chars.len() > 64 || !chars[0].is_ascii_alphabetic() {
        return false;
    }
    chars[1..].iter().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'))
}

fn option_value_ok(text: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    if chars.is_empty() || chars.len() > 64 || !chars[0].is_ascii_alphanumeric() {
        return false;
    }
    chars[1..]
        .iter()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
}

fn sanitize_options(options: &[Value]) -> Vec<Value> {
    options
        .iter()
        .filter_map(|option| {
            let id = option.get("id").and_then(|v| v.as_str())?;
            if !option_id_ok(id) {
                return None;
            }
            let value = option.get("value")?;
            if value.as_bool().is_some() {
                return Some(json!({ "id": id, "value": value }));
            }
            let text = value.as_str().filter(|text| option_value_ok(text))?;
            Some(json!({ "id": id, "value": text }))
        })
        .take(16)
        .collect()
}

pub(crate) fn archived_at_ms(thread: &Value) -> Option<i64> {
    thread.get("archivedAtUnixMs").and_then(|value| value.as_i64())
}

pub fn history(agent_id: Option<&str>) -> Value {
    let items = threads().lock().unwrap();
    let summaries: Vec<Value> = items
        .iter()
        .filter(|thread| match agent_id {
            Some(id) => thread.get("profileId").and_then(|v| v.as_str()) == Some(id),
            None => thread.get("profileId").is_none() || thread.get("profileId").and_then(|v| v.as_str()).is_none() || thread["profileId"].is_null(),
        })
        .filter(|thread| archived_at_ms(thread).is_none())
        .filter_map(|thread| summary_of(thread))
        .collect();
    let provider = last_provider().lock().unwrap().clone();
    json!({
        "schemaVersion": 1,
        "summaries": summaries,
        "lastProvider": provider,
        "readOnly": false,
        "skippedThreads": 0,
        "recoveryMessage": Value::Null
    })
}

fn summary_of(thread: &Value) -> Option<Value> {
    Some(json!({
        "id": thread.get("id")?,
        "profileId": thread.get("profileId").cloned().unwrap_or(Value::Null),
        "title": thread.get("title").cloned().unwrap_or(json!("Chat")),
        "provider": thread.get("provider").cloned().unwrap_or(json!("antigravity")),
        "status": thread.get("status").cloned().unwrap_or(json!("idle")),
        "hasContent": thread.get("items").and_then(|v| v.as_array()).map(|items| !items.is_empty()).unwrap_or(false),
        "workspaceId": thread.get("workspaceId").cloned().unwrap_or(Value::Null),
        "pinned": thread.get("pinned").cloned().unwrap_or(json!(false)),
        "createdAtUnixMs": thread.get("createdAtUnixMs").cloned().unwrap_or(json!(now_ms())),
        "updatedAtUnixMs": thread.get("updatedAtUnixMs").cloned().unwrap_or(json!(now_ms()))
    }))
}

pub fn remove_thread(thread_id: &str) -> Value {
    threads().lock().unwrap().retain(|thread| thread.get("id").and_then(|v| v.as_str()) != Some(thread_id));
    persist();
    history(None)
}

fn chat_item(id: &str, kind: &str, text: &str, streaming: bool) -> Value {
    json!({
        "id": id,
        "kind": kind,
        "text": sanitize_chat_text(text),
        "title": Value::Null,
        "detail": Value::Null,
        "status": Value::Null,
        "streaming": streaming,
        "exitCode": Value::Null,
        "createdAtUnixMs": now_ms(),
        "attachments": []
    })
}

fn sanitize_chat_text(text: &str) -> String {
    text.chars()
        .filter(|ch| *ch == '\n' || *ch == '\r' || *ch == '\t' || (*ch as u32) >= 32)
        .take(200_000)
        .collect()
}

fn upsert_item(thread: &mut Value, item: &Value) {
    let id = item.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let Some(list) = thread
        .as_object_mut()
        .and_then(|object| object.get_mut("items"))
        .and_then(|items| items.as_array_mut())
    else {
        return;
    };
    if let Some(slot) = list
        .iter_mut()
        .find(|existing| existing.get("id").and_then(|v| v.as_str()) == Some(id.as_str()))
    {
        *slot = item.clone();
    } else {
        list.push(item.clone());
    }
}

pub use crate::chat_attachments::{
    decode_base64, lookup_staged_attachment, parse_attachments, release_staged_attachment,
    stage_blob_attachment, stage_dropped_path, stage_dropped_paths, StagedAttachment,
};

pub fn apply_launch_choices(thread_id: &str, req: Option<&Value>) {
    let Some(req) = req else {
        return;
    };
    let mut patch = serde_json::Map::new();
    if let Some(provider) = req.get("provider").and_then(|v| v.as_str()) {
        patch.insert("provider".to_string(), json!(provider));
    }
    if let Some(mode) = req.get("mode").and_then(|v| v.as_str()) {
        patch.insert("mode".to_string(), json!(mode));
    }
    if !patch.is_empty() {
        configure_thread(thread_id, &Value::Object(patch));
    }
}

pub fn start_turn(
    thread_id: &str,
    profile_id: Option<&str>,
    prompt: &str,
    attachments: Vec<Value>,
    routine_id: Option<&str>,
) -> Value {
    let mut thread = load_thread(thread_id, profile_id, "Chat");
    if let Some(profile_id) = profile_id {
        thread["profileId"] = json!(profile_id);
        let cur_prov = thread.get("provider").and_then(|v| v.as_str()).unwrap_or("");
        if cur_prov == "claude" || cur_prov.is_empty() {
            let ag_list = crate::persist::agents().lock().unwrap();
            if let Some(ag) = ag_list.iter().find(|a| a.id == profile_id) {
                if ag.engine != "claude" && ag.engine != "claude-code" {
                    let corrected = match ag.engine.as_str() {
                        "codex" => "codex",
                        "cursor" => "cursor",
                        "gemini" => "gemini",
                        "grok" => "grok",
                        "opencode" | "open-code" => "opencode",
                        _ => "antigravity",
                    };
                    thread["provider"] = json!(corrected);
                }
            }
        }
    }
    thread["status"] = json!("running");
    touch(&mut thread);
    replace_thread(&thread);
    let run_id = Uuid::new_v4().to_string();
    chat_log(&format!("start_turn: thread={}, run={}, provider={}, prompt_chars={}", thread_id, run_id, thread.get("provider").and_then(|v| v.as_str()).unwrap_or(""), prompt.len()));
    let user_id = format!("u{}", Uuid::new_v4().simple());
    let assistant_id = format!("a{}", Uuid::new_v4().simple());
    let revision = thread.get("revision").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let mut user_item = chat_item(&user_id, "user", prompt, false);
    if !attachments.is_empty() {
        user_item["attachments"] = Value::Array(attachments);
    }
    let assistant_item = chat_item(&assistant_id, "assistant", "", true);
    {
        let mut items = threads().lock().unwrap();
        if let Some(stored) = items.iter_mut().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id)) {
            upsert_item(stored, &user_item);
            upsert_item(stored, &assistant_item);
            thread = stored.clone();
        }
    }
    let mut run = TurnRun {
        revision,
        events: Vec::new(),
        next_sequence: 0,
        assistant_id: assistant_id.clone(),
        assistant_text: String::new(),
        child: None,
        stdin: None,
        closing: false,
        finished: false,
        started_at_ms: now_ms(),
        routine_id: routine_id.map(|id| id.to_string()),
    };
    push_event(&mut run, json!({ "kind": "status", "status": "running" }));
    push_event(&mut run, json!({ "kind": "upsert", "item": user_item }));
    push_event(&mut run, json!({ "kind": "upsert", "item": assistant_item }));
    {
        let mut live = live_turns().lock().unwrap();
        live.by_thread.insert(thread_id.to_string(), run_id.clone());
        live.runs.insert(run_id.clone(), run);
    }
    launch_provider(thread_id.to_string(), run_id.clone(), &thread, prompt);
    json!({
        "schemaVersion": 1,
        "runId": run_id,
        "thread": thread
    })
}

fn push_event(run: &mut TurnRun, event: Value) {
    append_event(run, event, false);
}

fn append_event(run: &mut TurnRun, mut event: Value, force: bool) {
    if run.finished || (!force && run.events.len() >= 400) {
        return;
    }
    run.next_sequence += 1;
    event["sequence"] = json!(run.next_sequence);
    run.events.push(event);
}

pub fn read_turn_updates(run_id: &str, after_sequence: u64, wait_ms: u64) -> Value {
    let wait = wait_ms.min(1000);
    let deadline = Instant::now() + Duration::from_millis(wait);
    loop {
        let mut live = live_turns().lock().unwrap();
        prune_stale_runs(&mut live);
        let (events, revision, finished) = match live.runs.get(run_id) {
            Some(run) => {
                let events: Vec<Value> = run
                    .events
                    .iter()
                    .filter(|event| event.get("sequence").and_then(|v| v.as_u64()).unwrap_or(0) > after_sequence)
                    .take(32)
                    .cloned()
                    .collect();
                (events, run.revision.clone(), run.finished)
            }
            None => (Vec::new(), format!("{:064x}", 1), true),
        };
        if !events.is_empty() || finished || Instant::now() >= deadline {
            let next = events
                .last()
                .and_then(|event| event.get("sequence"))
                .and_then(|v| v.as_u64())
                .unwrap_or(after_sequence);
            return json!({
                "schemaVersion": 1,
                "runId": run_id,
                "revision": revision,
                "afterSequence": after_sequence,
                "nextSequence": next,
                "events": events,
                "resyncRequired": false
            });
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        let (_guard, _) = live_cv().wait_timeout(live, remaining).unwrap();
    }
}

pub fn cancel_turn(thread_id: &str) {
    chat_log(&format!("cancel_turn: requested for thread={}", thread_id));
    let run_id = {
        let live = live_turns().lock().unwrap();
        live.by_thread.get(thread_id).cloned()
    };
    let Some(run_id) = run_id else {
        chat_log(&format!("cancel_turn: no live run for thread={}", thread_id));
        return;
    };
    let child = {
        let live = live_turns().lock().unwrap();
        live.runs.get(&run_id).and_then(|run| run.child.clone())
    };
    if let Some(child) = child {
        if let Ok(mut child) = child.lock() {
            let _ = child.kill();
        }
    }
    finish_run(&run_id, false, true, "Stopped.");
}

/// Compacts previous conversation history into a structured prompt context when native session resumption
/// is unavailable or when anchoring context across providers.
fn assemble_thread_context(thread: &Value, current_prompt: &str) -> String {
    let Some(items) = thread.get("items").and_then(|v| v.as_array()) else {
        return current_prompt.to_string();
    };

    // Filter past non-streaming items, excluding the current turn's freshly added user item and streaming assistant item
    let mut past_items: Vec<&Value> = items
        .iter()
        .filter(|it| {
            let streaming = it.get("streaming").and_then(|v| v.as_bool()).unwrap_or(false);
            let text = it.get("text").and_then(|v| v.as_str()).unwrap_or("");
            !streaming && !text.trim().is_empty()
        })
        .collect();

    // If the last past item has identical text to current_prompt and is from user, drop it from history
    // because start_turn inserts the current user prompt before launching the provider.
    if let Some(last) = past_items.last() {
        if last.get("kind").and_then(|v| v.as_str()) == Some("user")
            && last.get("text").and_then(|v| v.as_str()) == Some(current_prompt)
        {
            past_items.pop();
        }
    }

    if past_items.is_empty() {
        return current_prompt.to_string();
    }

    // Sliding window: keep the last 14 items to protect the prompt budget while preserving rich context
    if past_items.len() > 14 {
        let drain_count = past_items.len() - 14;
        past_items = past_items[drain_count..].to_vec();
    }

    let mut context_buffer = String::new();
    context_buffer.push_str("--- Previous Conversation History ---\n");

    for item in past_items {
        let kind = item.get("kind").and_then(|v| v.as_str()).unwrap_or("");
        let text = item.get("text").and_then(|v| v.as_str()).unwrap_or("");
        match kind {
            "user" => {
                context_buffer.push_str("\n[User]:\n");
                context_buffer.push_str(text.trim());
                context_buffer.push('\n');
            }
            "assistant" => {
                context_buffer.push_str("\n[Assistant]:\n");
                if text.len() > 4000 {
                    context_buffer.push_str(&text[..4000]);
                    context_buffer.push_str("\n... [output truncated for brevity] ...\n");
                } else {
                    context_buffer.push_str(text.trim());
                    context_buffer.push('\n');
                }
            }
            "tool" => {
                let tool_name = item.get("toolName").or_else(|| item.get("title")).and_then(|v| v.as_str()).unwrap_or("tool");
                let status = item.get("status").and_then(|v| v.as_str()).unwrap_or("completed");
                context_buffer.push_str(&format!("\n[Tool Call: {} ({})]\n", tool_name, status));
                if text.len() > 1500 {
                    context_buffer.push_str(&text[..1500]);
                    context_buffer.push_str(&format!("\n... [clipped {} characters] ...\n", text.len() - 1500));
                } else {
                    context_buffer.push_str(text.trim());
                    context_buffer.push('\n');
                }
            }
            _ => {}
        }
    }

    context_buffer.push_str("\n--- Current Request ---\n");
    context_buffer.push_str(current_prompt);
    context_buffer
}

fn launch_provider(thread_id: String, run_id: String, thread: &Value, prompt: &str) {
    let provider = thread.get("provider").and_then(|v| v.as_str()).unwrap_or("antigravity").to_string();
    let mode = thread.get("mode").and_then(|v| v.as_str()).unwrap_or("fullAccess").to_string();
    let model = thread.get("model").and_then(|v| v.as_str()).map(|s| s.to_string());
    let provider_session_id = thread.get("providerSessionId").and_then(|v| v.as_str()).map(|s| s.to_string());
    let effort = thread
        .get("providerOptions")
        .and_then(|v| v.as_array())
        .and_then(|arr| {
            arr.iter().find(|opt| opt.get("id").and_then(|v| v.as_str()) == Some("effort"))
        })
        .and_then(|opt| opt.get("value").and_then(|v| v.as_str()))
        .map(|s| s.to_string());
    let workspace_id = thread.get("workspaceId").and_then(|v| v.as_str()).map(|s| s.to_string());
    let profile_id = thread.get("profileId").and_then(|v| v.as_str()).map(|s| s.to_string());
    let prompt = prompt.to_string();
    let thread_clone = thread.clone();
    let assistant_id = {
        let live = live_turns().lock().unwrap();
        live.runs.get(&run_id).map(|run| run.assistant_id.clone()).unwrap_or_else(|| "aassistant".into())
    };
    std::thread::spawn(move || {
        let cwd = workspace_id
            .as_deref()
            .and_then(workspace_path)
            .map(PathBuf::from)
            .filter(|path| path.is_dir())
            .unwrap_or_else(|| {
                if let Some(ref aid) = profile_id {
                    let home = crate::agent_mind::get_agent_home_dir(aid);
                    let _ = std::fs::create_dir_all(&home);
                    let _ = crate::agent_mind::sync_agent_instructions(
                        home.parent().unwrap_or(Path::new(".")),
                        aid,
                    );
                    home
                } else {
                    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
                }
            });
        let effective_prompt = if provider_session_id.is_some() {
            prompt.clone()
        } else {
            assemble_thread_context(&thread_clone, &prompt)
        };
        match build_command(&provider, &mode, model.as_deref(), effort.as_deref(), provider_session_id.as_deref(), &effective_prompt, &cwd) {
            Ok(mut command) => match command.spawn() {
                Ok(child) => stream_child(thread_id, run_id, assistant_id, child),
                Err(err) => finish_run(&run_id, false, false, &format!("{provider} failed to start: {err}")),
            },
            Err(message) => finish_run(&run_id, false, false, &message),
        }
    });
}

fn list_available_providers() -> Vec<&'static str> {
    let mut available = Vec::new();
    if resolve_bin("agy", &[r"C:\Users\PC\AppData\Local\agy\bin\agy.exe"]).is_some() {
        available.push("Antigravity");
    }
    if resolve_bin("codex", &[
        r"C:\Users\PC\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe",
        r"C:\Users\PC\AppData\Local\Programs\OpenAI\codex.exe",
    ]).is_some() {
        available.push("Codex");
    }
    if resolve_bin("claude", &[]).is_some() {
        available.push("Claude");
    }
    if resolve_bin("agent", &[]).or_else(|| resolve_bin("cursor-agent", &[])).is_some() {
        available.push("Cursor");
    }
    if resolve_bin("grok", &[]).is_some() {
        available.push("Grok");
    }
    if resolve_bin("opencode", &[]).is_some() {
        available.push("OpenCode");
    }
    if resolve_bin("gemini", &[]).is_some() {
        available.push("Gemini CLI");
    }
    available
}

fn build_command(
    provider: &str,
    mode: &str,
    model: Option<&str>,
    effort: Option<&str>,
    session_id: Option<&str>,
    prompt: &str,
    cwd: &Path,
) -> Result<Command, String> {
    let prompt = clip_argv(prompt);
    let read_only = mode == "readOnly";
    let sent = if read_only {
        format!("Read-only mode: do not create, edit, or delete files.\n\n{prompt}")
    } else {
        prompt
    };
    let (program, args) = match provider {
        "antigravity" | "agy" => {
            let program = resolve_bin("agy", &[r"C:\Users\PC\AppData\Local\agy\bin\agy.exe"])
                .ok_or_else(|| {
                    let avail = list_available_providers().join(", ");
                    format!("Antigravity CLI (agy) is not installed. Available providers: {avail}")
                })?;
            let mut args = vec!["-p".into(), sent, "--output-format".into(), "stream-json".into()];
            if let Some(sid) = session_id.filter(|s| !s.is_empty()) {
                args.push("--conversation".into());
                args.push(sid.to_string());
            }
            match mode {
                "readOnly" => {
                    args.push("--mode".into());
                    args.push("plan".into());
                }
                "acceptEdits" => {
                    args.push("--mode".into());
                    args.push("accept-edits".into());
                }
                _ => {
                    args.push("--dangerously-skip-permissions".into());
                }
            }
            if let Some(model) = model {
                args.push("--model".into());
                args.push(model.into());
            }
            if let Some(effort) = effort {
                args.push("--effort".into());
                args.push(effort.into());
            }
            (program, args)
        }
        "claude" => {
            let program = resolve_bin("claude", &[]).ok_or_else(|| {
                let avail = list_available_providers().join(", ");
                if avail.is_empty() {
                    "Claude Code is not installed. Install it with 'npm install -g @anthropic-ai/claude-code'.".to_string()
                } else {
                    format!("Claude Code is not installed. Installed on this system: {avail}. Please switch providers in the dropdown.")
                }
            })?;
            let permission = match mode {
                "readOnly" => "plan",
                "acceptEdits" => "acceptEdits",
                _ => "bypassPermissions",
            };
            let mut args = vec!["-p".into(), "--output-format".into(), "text".into(), "--permission-mode".into(), permission.into()];
            if let Some(sid) = session_id.filter(|s| !s.is_empty()) {
                args.push("--resume".into());
                args.push(sid.to_string());
            }
            if let Some(model) = model {
                args.push("--model".into());
                args.push(model.into());
            }
            args.push(sent);
            (program, args)
        }
        "codex" => {
            let program = resolve_bin("codex", &[
                r"C:\Users\PC\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe",
                r"C:\Users\PC\AppData\Local\Programs\OpenAI\codex.exe",
            ]).ok_or_else(|| {
                let avail = list_available_providers().join(", ");
                format!("Codex is not installed. Available providers: {avail}")
            })?;
            let mut args = if let Some(sid) = session_id.filter(|s| !s.is_empty()) {
                vec!["exec".into(), "resume".into(), sid.to_string(), "--skip-git-repo-check".into()]
            } else {
                vec!["exec".into(), "--skip-git-repo-check".into()]
            };
            if read_only {
                args.push("--sandbox".into());
                args.push("read-only".into());
            } else {
                args.push("--full-auto".into());
            }
            if let Some(model) = model {
                args.push("--model".into());
                args.push(model.into());
            }
            args.push(sent);
            (program, args)
        }
        "cursor" => {
            let program = resolve_bin("agent", &[])
                .or_else(|| resolve_bin("cursor-agent", &[]))
                .ok_or_else(|| {
                    let avail = list_available_providers().join(", ");
                    format!("Cursor Agent is not installed. Available providers: {avail}")
                })?;
            (program, vec!["-p".into(), sent])
        }
        "grok" => {
            let program = resolve_bin("grok", &[]).ok_or_else(|| {
                let avail = list_available_providers().join(", ");
                format!("Grok is not installed. Available providers: {avail}")
            })?;
            (program, vec!["-p".into(), sent])
        }
        "opencode" => {
            let program = resolve_bin("opencode", &[]).ok_or_else(|| {
                let avail = list_available_providers().join(", ");
                format!("OpenCode is not installed. Available providers: {avail}")
            })?;
            (program, vec!["run".into(), sent])
        }
        "gemini" => {
            let program = resolve_bin("gemini", &[]).ok_or_else(|| {
                let avail = list_available_providers().join(", ");
                format!("Gemini CLI is not installed. Available providers: {avail}")
            })?;
            (program, vec!["--prompt".into(), sent])
        }
        other => return Err(format!("{other} has no local chat command in this build.")),
    };
    let mut command = Command::new(program);
    command.args(args).current_dir(cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    Ok(command)
}

fn clip_argv(prompt: &str) -> String {
    prompt.chars().take(12_000).collect()
}

fn resolve_bin(name: &str, fallbacks: &[&str]) -> Option<PathBuf> {
    for fallback in fallbacks {
        let path = PathBuf::from(fallback);
        if path.is_file() {
            return Some(path);
        }
    }
    let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
    let appdata = std::env::var("APPDATA").unwrap_or_default();
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    let env_candidates = [
        PathBuf::from(&local).join("agy").join("bin").join(format!("{name}.exe")),
        PathBuf::from(&local).join("Programs").join("OpenAI").join("Codex").join("bin").join(format!("{name}.exe")),
        PathBuf::from(&local).join("Programs").join("OpenAI").join(format!("{name}.exe")),
        PathBuf::from(&appdata).join("npm").join(format!("{name}.cmd")),
        PathBuf::from(&appdata).join("npm").join(format!("{name}.ps1")),
        PathBuf::from(&home).join(".local").join("bin").join(format!("{name}.exe")),
        PathBuf::from(&home).join(".cargo").join("bin").join(format!("{name}.exe")),
    ];
    for cand in env_candidates {
        if cand.is_file() {
            return Some(cand);
        }
    }
    if binary_exists(name) {
        Some(PathBuf::from(name))
    } else {
        None
    }
}

fn binary_exists(name: &str) -> bool {
    let mut command = Command::new("where");
    command.arg(name).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command.status().map(|status| status.success()).unwrap_or(false)
}

pub fn write_approval_to_run(thread_id: &str, request_id: &str, decision: &str) {
    let stdin_arc = {
        let mut live = live_turns().lock().unwrap();
        let run_id = live.by_thread.get(thread_id).cloned();
        let mut handle = None;
        if let Some(ref rid) = run_id {
            if let Some(run) = live.runs.get_mut(rid) {
                handle = run.stdin.clone();
                push_event(
                    run,
                    json!({
                        "kind": "approvalResolved",
                        "requestId": request_id,
                        "decision": decision
                    }),
                );
                if decision != "denyAndStop" {
                    push_event(run, json!({ "kind": "status", "status": "running" }));
                }
            }
        }
        handle
    };
    live_cv().notify_all();

    {
        let mut items = threads().lock().unwrap();
        if let Some(thread) = items.iter_mut().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id)) {
            thread["pendingApproval"] = Value::Null;
            if decision != "denyAndStop" {
                thread["status"] = json!("running");
            }
            touch(thread);
        }
    }
    persist();

    if let Some(stdin_mutex) = stdin_arc {
        if let Ok(mut stdin) = stdin_mutex.lock() {
            let line = crate::acp::format_acp_approval_response(request_id, decision);
            let _ = stdin.write_all(line.as_bytes());
            let _ = stdin.flush();
        }
    }
}

fn stream_child(thread_id: String, run_id: String, assistant_id: String, mut child: std::process::Child) {
    let pid = child.id();
    chat_log(&format!("stream_child: started for run_id={}, pid={}", run_id, pid));
    let stdin = child.stdin.take().map(|s| Arc::new(Mutex::new(s)));
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let shared = Arc::new(Mutex::new(child));
    {
        let mut live = live_turns().lock().unwrap();
        if let Some(run) = live.runs.get_mut(&run_id) {
            run.child = Some(Arc::clone(&shared));
            run.stdin = stdin;
        }
    }
    let out_run = run_id.clone();
    let out_id = assistant_id.clone();
    let err_run = run_id.clone();
    let err_id = assistant_id.clone();
    let out_thread = thread_id.clone();
    let err_thread = thread_id.clone();
    let stdout_thread = std::thread::spawn(move || {
        if let Some(stdout) = stdout {
            read_pipe(stdout, &out_thread, &out_run, &out_id);
        }
    });
    let stderr_thread = std::thread::spawn(move || {
        if let Some(stderr) = stderr {
            read_pipe(stderr, &err_thread, &err_run, &err_id);
        }
    });
    let _ = stdout_thread.join();
    let _ = stderr_thread.join();
    {
        let mut live = live_turns().lock().unwrap();
        if let Some(run) = live.runs.get_mut(&run_id) {
            run.stdin = None;
        }
    }
    let status = shared.lock().ok().and_then(|mut child| child.wait().ok());
    let ok = status.map(|status| status.success()).unwrap_or(false);
    chat_log(&format!("stream_child: process exited for run_id={}, pid={}, ok={}", run_id, pid, ok));
    let message = if ok { String::new() } else { "The provider command exited with an error.".into() };
    finish_run(&run_id, ok, false, &message);
}

fn handle_stream_json_line(thread_id: &str, run_id: &str, assistant_id: &str, line: &str) -> bool {
    let trimmed = line.trim();
    if !trimmed.starts_with('{') || !trimmed.ends_with('}') {
        return false;
    }
    let Ok(val) = serde_json::from_str::<Value>(trimmed) else {
        return false;
    };

    if let Some(acp_event) = crate::acp::parse_acp_stream_line(thread_id, run_id, trimmed) {
        match acp_event {
            crate::acp::AcpStreamEvent::Init { conversation_id, model } => {
                if !conversation_id.is_empty() {
                    let mut items = threads().lock().unwrap();
                    if let Some(thread) = items.iter_mut().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id)) {
                        thread["providerSessionId"] = json!(conversation_id);
                        if !model.is_empty() && (thread.get("model").is_none() || thread["model"].is_null()) {
                            thread["model"] = json!(model);
                        }
                        touch(thread);
                    }
                    drop(items);
                    persist();
                }
                return true;
            }
            crate::acp::AcpStreamEvent::ContentDelta { text } => {
                emit_deltas(thread_id, run_id, assistant_id, &text);
                return true;
            }
            crate::acp::AcpStreamEvent::ThoughtDelta {
                text,
                is_done,
                duration_seconds,
            } => {
                let step_index = val
                    .pointer("/step_update/step_index")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0);
                let thought_id = format!("r_{}_{}", run_id, step_index);
                let mut reasoning_item = chat_item(&thought_id, "reasoning", &text, !is_done);
                if let Some(dur) = duration_seconds {
                    reasoning_item["durationSeconds"] = json!(dur);
                }
                {
                    let mut live = live_turns().lock().unwrap();
                    if let Some(run) = live.runs.get_mut(run_id) {
                        push_event(run, json!({ "kind": "upsert", "item": reasoning_item.clone() }));
                    }
                }
                live_cv().notify_all();
                let mut items = threads().lock().unwrap();
                if let Some(thread) = items.iter_mut().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id)) {
                    upsert_item(thread, &reasoning_item);
                }
                return true;
            }
            crate::acp::AcpStreamEvent::ToolUpdate { tool } => {
                let is_streaming = tool.status == "running" || tool.status == "pending";
                let is_terminal = tool.status == "completed" || tool.status == "failed";
                let output_str = tool.output.as_deref().unwrap_or("");
                let mut tool_item = chat_item(&tool.id, "tool", output_str, is_streaming);
                tool_item["title"] = json!(if tool.title.is_empty() { tool.name.clone() } else { tool.title.clone() });
                tool_item["detail"] = json!(tool.detail);
                tool_item["status"] = json!(tool.status);
                tool_item["toolName"] = json!(tool.name);
                tool_item["toolKind"] = json!(tool.tool_kind);
                if let Some(srv) = tool.server_name {
                    tool_item["serverName"] = json!(srv);
                }
                if let Some(cmd) = tool.command {
                    tool_item["command"] = json!(cmd);
                }
                if let Some(fp) = tool.file_path {
                    tool_item["filePath"] = json!(fp);
                }
                if let Some(add) = tool.added_lines {
                    tool_item["addedLines"] = json!(add);
                }
                if let Some(rem) = tool.removed_lines {
                    tool_item["removedLines"] = json!(rem);
                }
                if let Some(dur) = tool.duration_seconds {
                    tool_item["durationSeconds"] = json!(dur);
                }

                {
                    let mut live = live_turns().lock().unwrap();
                    if let Some(run) = live.runs.get_mut(run_id) {
                        push_event(run, json!({ "kind": "upsert", "item": tool_item.clone() }));
                    }
                }
                live_cv().notify_all();
                {
                    let mut items = threads().lock().unwrap();
                    if let Some(thread) = items.iter_mut().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id)) {
                        upsert_item(thread, &tool_item);
                        touch(thread);
                    }
                }
                if is_terminal {
                    persist();
                }
                return true;
            }
            crate::acp::AcpStreamEvent::PermissionRequired { approval } => {
                let approval_val = json!({
                    "id": approval.request_id,
                    "toolName": approval.tool_name,
                    "title": approval.title,
                    "detail": approval.description,
                    "risk": approval.risk,
                    "impact": approval.impact,
                    "text": approval.description,
                    "command": approval.command,
                    "path": approval.path,
                    "tool": approval.tool_name,
                    "parameters": approval.details,
                    "status": "pending"
                });
                {
                    let mut live = live_turns().lock().unwrap();
                    if let Some(run) = live.runs.get_mut(run_id) {
                        push_event(run, json!({ "kind": "approvalOpened", "approval": approval_val.clone() }));
                        push_event(run, json!({ "kind": "status", "status": "waiting" }));
                    }
                }
                live_cv().notify_all();
                {
                    let mut items = threads().lock().unwrap();
                    if let Some(thread) = items.iter_mut().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id)) {
                        thread["pendingApproval"] = approval_val;
                        thread["status"] = json!("waiting");
                        touch(thread);
                    }
                }
                persist();
                return true;
            }
            crate::acp::AcpStreamEvent::PlanUpdate { step, status } => {
                let plan_item_id = format!("plan_{}", run_id);
                let is_streaming = status == "running" || status == "pending";
                let mut plan_item = chat_item(&plan_item_id, "tool", &step, is_streaming);
                plan_item["title"] = json!(format!("Plan · {}", step));
                plan_item["status"] = json!(status);
                plan_item["toolKind"] = json!("planUpdate");
                {
                    let mut live = live_turns().lock().unwrap();
                    if let Some(run) = live.runs.get_mut(run_id) {
                        push_event(run, json!({ "kind": "upsert", "item": plan_item.clone() }));
                    }
                }
                live_cv().notify_all();
                let mut items = threads().lock().unwrap();
                if let Some(thread) = items.iter_mut().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id)) {
                    upsert_item(thread, &plan_item);
                }
                return true;
            }
            crate::acp::AcpStreamEvent::Result {
                input_tokens,
                output_tokens,
                duration_seconds,
                ..
            } => {
                let usage_val = json!({
                    "inputTokens": input_tokens,
                    "outputTokens": output_tokens,
                    "durationSeconds": duration_seconds,
                    "costUsd": (input_tokens as f64 * 0.000003) + (output_tokens as f64 * 0.000015)
                });
                {
                    let mut live = live_turns().lock().unwrap();
                    if let Some(run) = live.runs.get_mut(run_id) {
                        push_event(run, json!({ "kind": "usage", "usage": usage_val.clone() }));
                    }
                }
                live_cv().notify_all();
                {
                    let mut items = threads().lock().unwrap();
                    if let Some(thread) = items.iter_mut().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id)) {
                        thread["usage"] = usage_val;
                        touch(thread);
                    }
                }
                persist();
                return true;
            }
            crate::acp::AcpStreamEvent::Raw { .. } => {}
        }
    }

    // Consume known envelope lines that did not map to a specific UI item so raw JSON is never dumped into assistant prose
    if val.get("event").is_some() || val.get("jsonrpc").is_some() {
        return true;
    }

    false
}

fn read_pipe(mut pipe: impl Read, thread_id: &str, run_id: &str, assistant_id: &str) {
    let mut pending = Vec::new();
    let mut buf = [0u8; 4096];
    loop {
        let read = pipe.read(&mut buf);
        let Ok(count) = read else { break };
        if count == 0 {
            break;
        }
        pending.extend_from_slice(&buf[..count]);
        while let Some(pos) = pending.iter().position(|&b| b == b'\n') {
            let line_bytes: Vec<u8> = pending.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line_bytes);
            if !handle_stream_json_line(thread_id, run_id, assistant_id, &line) {
                emit_deltas(thread_id, run_id, assistant_id, &line);
            }
        }
    }
    if !pending.is_empty() {
        let text = String::from_utf8_lossy(&pending);
        if !handle_stream_json_line(thread_id, run_id, assistant_id, &text) {
            emit_deltas(thread_id, run_id, assistant_id, &text);
        }
    }
}

fn emit_deltas(thread_id: &str, run_id: &str, assistant_id: &str, text: &str) {
    let clean = sanitize_chat_text(text);
    if clean.is_empty() {
        return;
    }
    for chunk in chars_chunks(&clean, 8000) {
        let appended = {
            let mut live = live_turns().lock().unwrap();
            let Some(run) = live.runs.get_mut(run_id) else { return };
            if run.closing || run.finished {
                return;
            }
            if run.assistant_text.chars().count() >= 200_000 {
                return;
            }
            let room = 200_000 - run.assistant_text.chars().count();
            let piece: String = chunk.chars().take(room).collect();
            run.assistant_text.push_str(&piece);
            push_event(run, json!({ "kind": "delta", "itemId": assistant_id, "text": piece }));
            run.assistant_text.clone()
        };
        live_cv().notify_all();
        let item = chat_item(assistant_id, "assistant", &appended, true);
        let mut items = threads().lock().unwrap();
        if let Some(thread) = items.iter_mut().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id)) {
            upsert_item(thread, &item);
        }
    }
}

fn chars_chunks(text: &str, size: usize) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut current = String::new();
    for ch in text.chars() {
        current.push(ch);
        if current.len() >= size {
            chunks.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

fn finish_run(run_id: &str, ok: bool, stopped: bool, error_text: &str) {
    chat_log(&format!("finish_run starting: run_id={}, ok={}, stopped={}", run_id, ok, stopped));
    let (thread_id, assistant_id, assistant_text, routine_id) = {
        let mut live = live_turns().lock().unwrap();
        let thread_id = live.by_thread.iter().find(|(_, id)| id.as_str() == run_id).map(|(thread, _)| thread.clone());
        let Some(run) = live.runs.get_mut(run_id) else {
            chat_log(&format!("finish_run: run {} not found in live_turns", run_id));
            return;
        };
        if run.closing || run.finished {
            chat_log(&format!("finish_run: run {} already closing or finished", run_id));
            return;
        }
        run.closing = true;
        (thread_id, run.assistant_id.clone(), run.assistant_text.clone(), run.routine_id.clone())
    };
    let thread_id = thread_id.unwrap_or_default();
    let mut profile_for_routine: Option<String> = None;
    let mut reflection_task: Option<(String, String, String)> = None;
    let mut quota_events: Option<(Value, Value)> = None;

    let error_item = if !ok && !stopped && assistant_text.is_empty() && !error_text.is_empty() {
        Some(chat_item(&format!("e{}", Uuid::new_v4().simple()), "error", error_text, false))
    } else {
        None
    };

    let final_item = chat_item(&assistant_id, "assistant", &assistant_text, false);

    if !thread_id.is_empty() {
        let mut items = threads().lock().unwrap();
        if let Some(thread) = items.iter_mut().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id.as_str())) {
            if let Some(ref err_it) = error_item {
                upsert_item(thread, err_it);
            }
            if !assistant_text.is_empty() {
                upsert_item(thread, &final_item);
            }
            let final_status = if ok || stopped { "idle" } else { "error" };
            thread["status"] = json!(final_status);

            if let Some(arr) = thread.get_mut("items").and_then(|v| v.as_array_mut()) {
                for it in arr.iter_mut() {
                    if it.get("streaming").and_then(|v| v.as_bool()) == Some(true) {
                        it["streaming"] = json!(false);
                    }
                }
            }

            let has_existing_usage = thread
                .get("usage")
                .and_then(|u| u.get("inputTokens"))
                .and_then(|v| v.as_i64())
                .unwrap_or(0) > 0;

            if !has_existing_usage {
                let out_tokens = (assistant_text.len() / 4).max(1) as i64;
                let in_tokens = thread
                    .get("items")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|it| it.get("text").and_then(|t| t.as_str()))
                            .map(|s| s.len() / 4)
                            .sum::<usize>() as i64
                    })
                    .unwrap_or(0);

                let total_in = in_tokens.max(10);
                let total_out = out_tokens;
                thread["usage"] = json!({
                    "inputTokens": total_in,
                    "outputTokens": total_out,
                    "costUsd": (total_in as f64 * 0.000003) + (total_out as f64 * 0.000015)
                });
            }

            let title = thread.get("title").and_then(|v| v.as_str()).unwrap_or("");
            if matches!(title, "New Chat" | "New Agent Chat" | "Chat" | "") {
                if let Some(first_user) = thread.get("items")
                    .and_then(|v| v.as_array())
                    .and_then(|arr| arr.iter().find(|it| it.get("kind").and_then(|k| k.as_str()) == Some("user")))
                    .and_then(|it| it.get("text").and_then(|t| t.as_str()))
                {
                    let first_line = first_user.lines().next().unwrap_or("").trim();
                    if !first_line.is_empty() {
                        let concise: String = first_line.chars().take(60).collect();
                        thread["title"] = json!(concise);
                        thread["titleOrigin"] = json!("generated");
                    }
                }
            }

            touch(thread);

            // Plan lifecycle handling
            let is_planning = thread.get("plan").and_then(|v| v.as_bool()).unwrap_or(false);
            let has_proposed_tag = assistant_text.contains("<proposed_plan>");
            if is_planning || has_proposed_tag {
                let plan_markdown = if let Some(start) = assistant_text.find("<proposed_plan>") {
                    let inner = &assistant_text[start + 15..];
                    if let Some(end) = inner.find("</proposed_plan>") {
                        inner[..end].trim().to_string()
                    } else {
                        inner.trim().to_string()
                    }
                } else {
                    assistant_text.trim().to_string()
                };

                if !plan_markdown.is_empty() {
                    let mut plans = thread.get("plans").and_then(|v| v.as_array()).cloned().unwrap_or_default();
                    let active_id = thread.get("activePlanId").and_then(|v| v.as_str()).map(|s| s.to_string());
                    let mut updated = false;

                    if let Some(ref aid) = active_id {
                        if let Some(slot) = plans.iter_mut().find(|p| p.get("id").and_then(|v| v.as_str()) == Some(aid.as_str())) {
                            let rev = slot.get("revision").and_then(|v| v.as_i64()).unwrap_or(1);
                            slot["revision"] = json!(rev + 1);
                            slot["markdown"] = json!(plan_markdown);
                            slot["status"] = json!("ready");
                            slot["sourceTurnId"] = json!(run_id);
                            updated = true;
                        }
                    }

                    if !updated {
                        let new_id = Uuid::new_v4().to_string();
                        plans.push(json!({
                            "id": new_id,
                            "revision": 1,
                            "sourceTurnId": run_id,
                            "markdown": plan_markdown,
                            "status": "ready"
                        }));
                        thread["activePlanId"] = json!(new_id);
                    }
                    thread["plans"] = Value::Array(plans);
                }
            } else {
                let aid = thread.get("activePlanId").and_then(|v| v.as_str()).map(|s| s.to_string());
                if let Some(aid) = aid {
                    if let Some(plans) = thread.get_mut("plans").and_then(|v| v.as_array_mut()) {
                        if let Some(slot) = plans.iter_mut().find(|p| p.get("id").and_then(|v| v.as_str()) == Some(aid.as_str())) {
                            if slot.get("status").and_then(|v| v.as_str()) == Some("implementing") {
                                slot["status"] = json!(if ok { "completed" } else if stopped { "interrupted" } else { "failed" });
                            }
                        }
                    }
                }
            }

            // ── Quota Exhaustion & Handoff Detection ──
            let current_provider = thread.get("provider").and_then(|v| v.as_str()).unwrap_or("antigravity").to_string();
            let combined_output = format!("{}\n{}", assistant_text, error_text);
            if !ok || !stopped {
                if let Some(reason) = crate::handoff::detect_quota_exhaustion(&current_provider, &combined_output) {
                    let workspace_id = thread.get("workspaceId").and_then(|v| v.as_str());
                    let handoff_capsule = crate::handoff::build_handoff_capsule_from_thread(
                        Some(thread),
                        &current_provider,
                        &assistant_text,
                        workspace_id,
                    );
                    let suggestions_val = crate::handoff::recommend_continuation_targets_direct(current_provider.clone());
                    let suggestions = suggestions_val.get("suggestions").cloned().unwrap_or(json!([]));

                    let offer = json!({
                        "failedProvider": current_provider,
                        "reason": reason,
                        "partialOutput": assistant_text,
                        "handoffPrompt": handoff_capsule,
                        "suggestions": suggestions,
                        "offeredAtUnixMs": now_ms()
                    });
                    thread["quotaHandoffOffer"] = offer.clone();

                    let handoff_item = json!({
                        "id": format!("qho_{}", Uuid::new_v4().simple()),
                        "kind": "quotaHandoff",
                        "text": format!("Se ha detectado agotamiento de cuota en {}: {}", current_provider, reason),
                        "title": "Límite de cuota alcanzado",
                        "detail": Value::Null,
                        "status": "ready",
                        "streaming": false,
                        "exitCode": Value::Null,
                        "createdAtUnixMs": now_ms(),
                        "attachments": [],
                        "handoffOffer": offer
                    });
                    upsert_item(thread, &handoff_item);
                    quota_events = Some((handoff_item, offer));
                }
            }

            profile_for_routine = thread.get("profileId").and_then(|v| v.as_str()).map(|s| s.to_string());
            if ok {
                if let Some(ref pid) = profile_for_routine {
                    let user_prompt = thread.get("items")
                        .and_then(|v| v.as_array())
                        .and_then(|arr| arr.iter().rev().find(|it| it.get("kind").and_then(|k| k.as_str()) == Some("user")))
                        .and_then(|it| it.get("text").and_then(|t| t.as_str()))
                        .unwrap_or("");
                    if !user_prompt.is_empty() {
                        reflection_task = Some((pid.clone(), user_prompt.to_string(), assistant_text.clone()));
                    }
                }
            }
        }
        drop(items); // CRITICAL: Release threads lock before any other operations!
    }

    if let Some((ref pid, ref user_prompt, ref a_text)) = reflection_task {
        crate::agent_mind::apply_post_turn_reflection(pid, user_prompt, a_text);
    }

    if let Some(routine_id) = routine_id.as_deref() {
        if !thread_id.is_empty() {
            settle_routine(run_id, &thread_id, routine_id, profile_for_routine.as_deref(), ok, stopped);
        }
    }

    {
        let mut live = live_turns().lock().unwrap();
        if let Some(run) = live.runs.get_mut(run_id) {
            if let Some(ref err_it) = error_item {
                append_event(run, json!({ "kind": "upsert", "item": err_it }), true);
            }
            if let Some((ref handoff_item, ref offer)) = quota_events {
                append_event(run, json!({ "kind": "upsert", "item": handoff_item }), true);
                append_event(run, json!({ "kind": "quotaHandoff", "offer": offer }), true);
            }
            if !run.finished {
                if !assistant_text.is_empty() {
                    append_event(run, json!({ "kind": "upsert", "item": final_item }), true);
                }
                let final_status = if ok || stopped { "idle" } else { "error" };
                append_event(run, json!({ "kind": "status", "status": final_status }), true);
                append_event(run, json!({ "kind": "finished", "ok": ok && !stopped, "stoppedByBuilder": stopped }), true);
                run.finished = true;
            }
        }
        prune_stale_runs(&mut live);
    }

    live_cv().notify_all();
    persist();
    chat_log(&format!("finish_run: completed cleanly for run_id={}", run_id));
}

fn settle_routine(run_id: &str, thread_id: &str, routine_id: &str, profile_id: Option<&str>, ok: bool, stopped: bool) {
    if Uuid::parse_str(thread_id).is_err() || Uuid::parse_str(run_id).is_err() {
        return;
    }
    let outcome = if stopped {
        "cancelled"
    } else if ok {
        "completed"
    } else {
        "failed"
    };
    let profile = profile_id.filter(|id| Uuid::parse_str(id).is_ok());
    let routine = if Uuid::parse_str(routine_id).is_ok() {
        json!(routine_id)
    } else {
        Value::Null
    };
    let notice = json!({
        "id": Uuid::new_v4().to_string(),
        "runId": run_id,
        "target": { "source": "codeThread", "id": thread_id },
        "profileId": profile,
        "routineId": routine,
        "kind": { "kind": "settled", "outcome": outcome },
        "resolution": "runSettled",
        "createdAtUnixMs": now_ms(),
        "isRead": false,
        "isWaitingForInput": false
    });
    let mut items = notifications().lock().unwrap();
    items.insert(0, notice);
    if items.len() > 100 {
        items.truncate(100);
    }
}

#[tauri::command]
pub fn continue_turn_with_handoff(request: Option<Value>) -> Result<Value, String> {
    let req = crate::persist::body(&request);
    let thread_id = req
        .and_then(|r| r.get("threadId").or_else(|| r.get("thread_id")))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let target_provider = req
        .and_then(|r| r.get("targetProvider").or_else(|| r.get("target_provider")))
        .and_then(|v| v.as_str())
        .unwrap_or("agy")
        .to_string();
    let target_account_id = req
        .and_then(|r| r.get("targetAccountId").or_else(|| r.get("target_account_id")))
        .and_then(|v| v.as_str())
        .map(String::from);
    let custom_handoff_prompt = req
        .and_then(|r| r.get("customHandoffPrompt").or_else(|| r.get("custom_handoff_prompt")))
        .and_then(|v| v.as_str())
        .map(String::from);

    // 1. If an accountId was specified, perform native profile switch (abort on failure)
    if let Some(ref acc_id) = target_account_id {
        let res = crate::account_switcher::switch_account_profile_direct(target_provider.clone(), acc_id.clone());
        if res.get("success").and_then(|v| v.as_bool()) != Some(true) {
            let msg = res
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("No se pudo cambiar de cuenta.")
                .to_string();
            return Err(msg);
        }
    }

    // 2. Load thread and get handoff prompt
    let mut thread = {
        let items = threads().lock().unwrap();
        items.iter().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(&thread_id)).cloned()
    }.unwrap_or_else(|| load_thread(&thread_id, None, "Chat"));

    let handoff_prompt = if let Some(p) = custom_handoff_prompt.filter(|s| !s.trim().is_empty()) {
        p
    } else if let Some(saved) = thread.pointer("/quotaHandoffOffer/handoffPrompt").and_then(|v| v.as_str()) {
        saved.to_string()
    } else {
        let from_p = thread.get("provider").and_then(|v| v.as_str()).unwrap_or("antigravity");
        let ws_id = thread.get("workspaceId").and_then(|v| v.as_str());
        crate::handoff::build_handoff_capsule(&thread_id, from_p, "", ws_id)
    };

    // 3. Clear pending offer, reset session ID, and update provider
    thread["quotaHandoffOffer"] = Value::Null;
    thread["providerSessionId"] = Value::Null;
    thread["provider"] = json!(target_provider);
    touch(&mut thread);
    replace_thread(&thread);

    // 4. Start turn with handoff context
    let profile_id = thread.get("profileId").and_then(|v| v.as_str()).map(|s| s.to_string());
    Ok(start_turn(&thread_id, profile_id.as_deref(), &handoff_prompt, Vec::new(), None))
}
