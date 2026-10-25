use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::chat::utils::resolve_bin;

pub(crate) struct CachedProviderModels {
    pub(crate) models: Vec<Value>,
    pub(crate) cached_at: Instant,
}

static MODEL_CACHE: std::sync::OnceLock<Mutex<HashMap<String, CachedProviderModels>>> =
    std::sync::OnceLock::new();

pub(crate) fn model_cache() -> &'static Mutex<HashMap<String, CachedProviderModels>> {
    MODEL_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) const MODEL_CACHE_TTL: Duration = Duration::from_secs(900); // 15 minutes in-memory TTL
pub(crate) const DISK_CACHE_TTL_MS: i64 = 4 * 3600 * 1000; // 4 hours disk TTL

fn models_cache_path() -> std::path::PathBuf {
    crate::persist::roaming_app_dir().join("provider_models_cache.json")
}

fn now_unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn load_provider_models_from_disk(provider: &str) -> Option<Vec<Value>> {
    let path = models_cache_path();
    let bytes = std::fs::read(&path).ok()?;
    let val: Value = serde_json::from_slice(&bytes).ok()?;
    let entry = val.get(provider)?;
    let cached_at = entry.get("cachedAtUnixMs").and_then(|v| v.as_i64())?;
    if now_unix_ms().saturating_sub(cached_at) > DISK_CACHE_TTL_MS {
        return None;
    }
    let models = entry.get("models")?.as_array()?.clone();
    if models.is_empty() {
        return None;
    }
    Some(models)
}

fn save_provider_models_to_disk(provider: &str, models: &[Value]) {
    if models.is_empty() {
        return;
    }
    let path = models_cache_path();
    let mut root: Value = std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_else(|| json!({}));

    if let Some(obj) = root.as_object_mut() {
        obj.insert(
            provider.to_string(),
            json!({
                "models": models,
                "cachedAtUnixMs": now_unix_ms(),
            }),
        );
        if let Ok(serialized) = serde_json::to_vec_pretty(&root) {
            let _ = std::fs::create_dir_all(crate::persist::roaming_app_dir());
            let _ = std::fs::write(&path, serialized);
        }
    }
}

pub fn provider_models(provider: &str, force_refresh: bool) -> Value {
    let canon = match provider {
        "agy" => "antigravity",
        "claude-code" => "claude",
        "open-code" => "opencode",
        other => other,
    };

    // 1. Check in-memory cache first unless force_refresh is requested
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

        // 1b. Check disk cache if in-memory cache is cold
        if let Some(disk_models) = load_provider_models_from_disk(canon) {
            if let Ok(mut cache) = model_cache().lock() {
                cache.insert(
                    canon.to_string(),
                    CachedProviderModels {
                        models: disk_models.clone(),
                        cached_at: Instant::now(),
                    },
                );
            }
            return json!({
                "provider": canon,
                "models": disk_models,
                "cached": true,
            });
        }
    }

    // 2. Fetch fresh dynamic models per provider
    let fresh_models = match canon {
        "antigravity" => fetch_antigravity_models_dynamic(),
        "codex" => fetch_codex_models_dynamic(),
        "cursor" => fetch_cursor_models_dynamic(),
        "grok" => fetch_grok_models_dynamic(),
        "opencode" => fetch_opencode_models_dynamic(),
        // Claude and Gemini have no list command wired here. An empty list
        // means the menu offers Automatic, not a stand-in catalog.
        "claude" | "gemini" => Vec::new(),
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
        save_provider_models_to_disk(canon, &fresh_models);
    }

    json!({
        "provider": canon,
        "models": fresh_models,
        "cached": false,
    })
}

pub fn fetch_antigravity_models_dynamic() -> Vec<Value> {
    query_agy_models_cli().unwrap_or_default()
}

pub fn query_agy_models_cli() -> Option<Vec<Value>> {
    let program = resolve_bin("agy", &[r"C:\Users\PC\AppData\Local\agy\bin\agy.exe"])?;
    if std::env::var("AGY_CLI_DISABLE_AUTO_UPDATE").is_err() {
        std::env::set_var("AGY_CLI_DISABLE_AUTO_UPDATE", "true");
    }
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

/// Codex has no model-list command wired here. The configured `model` key in
/// `config.toml` is one saved choice, not the catalog, so it is not expanded
/// into a menu.
pub fn fetch_codex_models_dynamic() -> Vec<Value> {
    Vec::new()
}

pub fn fetch_grok_models_dynamic() -> Vec<Value> {
    if let Some(program) = resolve_bin("grok", &[]) {
        if let Ok(out) = crate::hidden_exec::run(&program, &["models"], Duration::from_secs(10)) {
            if out.success() {
                let models = parse_grok_models(&out.stdout_lossy());
                if !models.is_empty() {
                    return models;
                }
            }
        }
    }
    Vec::new()
}

/// Parses `grok models`: a bulleted list under an `Available models:` header.
pub fn parse_grok_models(raw: &str) -> Vec<Value> {
    let mut seen = std::collections::HashSet::new();
    let mut models = Vec::new();
    for line in raw.lines() {
        let trimmed = line.trim();
        let entry = trimmed
            .strip_prefix("* ")
            .or_else(|| trimmed.strip_prefix("- "));
        let Some(entry) = entry else {
            continue;
        };
        let id = entry.split_whitespace().next().unwrap_or("").trim();
        if id.is_empty() || !model_id_ok(id) || !seen.insert(id.to_string()) {
            continue;
        }
        models.push(model_row(id, id, "Listed by the Grok CLI", true));
    }
    models
}

pub fn fetch_cursor_models_dynamic() -> Vec<Value> {
    if let Some(program) = resolve_bin("cursor-agent", &[]) {
        if let Ok(out) = crate::hidden_exec::run(&program, &["models"], Duration::from_secs(10)) {
            if out.success() {
                let models = parse_cursor_models(&out.stdout_lossy());
                if !models.is_empty() {
                    return models;
                }
            }
        }
    }
    Vec::new()
}

/// Parses `cursor-agent models`: `id - Name` rows under an `Available models`
/// header.
pub fn parse_cursor_models(raw: &str) -> Vec<Value> {
    let mut seen = std::collections::HashSet::new();
    let mut models = Vec::new();
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("Available models") {
            continue;
        }
        let Some((id, name)) = trimmed.split_once(" - ") else {
            continue;
        };
        let id = id.split_whitespace().next().unwrap_or("").trim();
        if id.is_empty() || !model_id_ok(id) || !seen.insert(id.to_string()) {
            continue;
        }
        models.push(model_row(
            id,
            name.trim(),
            "Listed by the Cursor Agent CLI",
            false,
        ));
        if models.len() >= 400 {
            break;
        }
    }
    models
}

pub fn model_row(id: &str, name: &str, description: &str, supports_effort: bool) -> Value {
    json!({
        "id": id,
        "name": name,
        "description": description,
        "supportsEffort": supports_effort,
    })
}

pub fn fetch_opencode_models_dynamic() -> Vec<Value> {
    query_opencode_models_cli().unwrap_or_default()
}

/// Parses the CLI's `provider/model` lines into catalog rows. Pure, so it is
/// testable without spawning the CLI.
pub fn parse_opencode_models(raw: &str) -> Vec<Value> {
    let mut seen = std::collections::HashSet::new();
    let mut models = Vec::new();
    for line in raw.lines() {
        let id = line.trim();
        if id.is_empty() || !id.contains('/') || id.chars().any(char::is_whitespace) {
            continue;
        }
        if !model_id_ok(id) || !seen.insert(id.to_string()) {
            continue;
        }
        let provider = id.split_once('/').map(|(provider, _)| provider).unwrap_or("");
        models.push(model_row(
            id,
            id,
            &format!("{provider} through the OpenCode CLI"),
            false,
        ));
        if models.len() >= 400 {
            break;
        }
    }
    models
}

/// Reads the CLI's own model list. Read-only: it never selects, downloads, or
/// authenticates a provider.
pub fn query_opencode_models_cli() -> Option<Vec<Value>> {
    let program = crate::chat::persistent::resolve_opencode_program().ok()?;
    let out = crate::hidden_exec::run(&program, &["models"], Duration::from_secs(10)).ok()?;
    if !out.success() {
        return None;
    }
    let raw = out.stdout_lossy();
    let models = parse_opencode_models(&raw);
    if models.is_empty() {
        None
    } else {
        Some(models)
    }
}

pub fn provider_ok(provider: &str) -> bool {
    matches!(provider, "antigravity" | "agy" | "claude" | "codex" | "cursor" | "grok" | "opencode" | "gemini")
}

pub fn mode_ok(provider: &str, mode: &str) -> bool {
    match provider {
        "codex" => matches!(mode, "acceptEdits" | "readOnly"),
        "claude" | "cursor" | "grok" | "opencode" | "antigravity" | "agy" | "gemini" => {
            matches!(mode, "acceptEdits" | "fullAccess" | "readOnly")
        }
        _ => false,
    }
}

pub fn default_mode(provider: &str) -> &'static str {
    if provider == "codex" {
        "acceptEdits"
    } else {
        "fullAccess"
    }
}

pub fn normalize_model(model: Option<&Value>) -> Value {
    match model {
        Some(Value::String(text)) if model_id_ok(text) => Value::String(text.clone()),
        _ => Value::Null,
    }
}

pub fn model_id_ok(text: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    if chars.is_empty() || chars.len() > 128 || !chars[0].is_ascii_alphanumeric() {
        return false;
    }
    chars[1..]
        .iter()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | ':' | '/' | '-'))
}

pub fn option_id_ok(text: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    if chars.is_empty() || chars.len() > 64 || !chars[0].is_ascii_alphabetic() {
        return false;
    }
    chars[1..].iter().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'))
}

pub fn option_value_ok(text: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    if chars.is_empty() || chars.len() > 64 || !chars[0].is_ascii_alphanumeric() {
        return false;
    }
    chars[1..]
        .iter()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
}

pub fn sanitize_options(options: &[Value]) -> Vec<Value> {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(raw: &str) -> Vec<String> {
        parse_opencode_models(raw)
            .iter()
            .filter_map(|model| model.get("id").and_then(|value| value.as_str()))
            .map(str::to_string)
            .collect()
    }

    #[test]
    fn providers_without_a_list_command_return_no_invented_models() {
        for provider in ["claude", "gemini", "codex"] {
            let value = provider_models(provider, true);
            let models = value
                .get("models")
                .and_then(|entry| entry.as_array())
                .cloned()
                .unwrap_or_default();
            assert!(
                models.is_empty(),
                "{provider} returned invented models: {models:?}"
            );
        }
    }

    #[test]
    fn parses_provider_model_lines_and_drops_duplicates() {
        let raw = "google/gemini-3.1-pro-preview\n\nnot-a-model\ngoogle/gemini-3.1-pro-preview\nopenai/gpt-5.6-sol\n";
        assert_eq!(
            ids(raw),
            vec![
                "google/gemini-3.1-pro-preview".to_string(),
                "openai/gpt-5.6-sol".to_string()
            ]
        );
    }

    #[test]
    fn rejects_ids_with_whitespace_or_an_invalid_start() {
        let raw = "google/gemini 3\n-/bad\n/model\nok/model-1\n";
        assert_eq!(ids(raw), vec!["ok/model-1".to_string()]);
    }

    #[test]
    fn a_list_without_a_provider_prefix_yields_no_models() {
        assert!(ids("auto\ncomposer\ndefault\n").is_empty());
    }

    #[test]
    fn parses_grok_models_output() {
        let raw = "You are logged in with grok.com.\n\nDefault model: grok-4.7\n\nAvailable models:\n  * grok-4.7 (default)\n  - grok-4.7-build-fast\n  - grok-4.6\n  - grok-4.5\n";
        let parsed: Vec<String> = parse_grok_models(raw)
            .iter()
            .filter_map(|model| model.get("id").and_then(|value| value.as_str()))
            .map(str::to_string)
            .collect();
        assert_eq!(
            parsed,
            vec![
                "grok-4.7".to_string(),
                "grok-4.7-build-fast".to_string(),
                "grok-4.6".to_string(),
                "grok-4.5".to_string()
            ]
        );
    }

    #[test]
    fn parses_cursor_models_output() {
        let raw = "Available models\n\nauto - Auto (current, default)\ngpt-5.3-codex-low - Codex 5.3 Low\ngpt-5.3-codex - Codex 5.3\n";
        let parsed = parse_cursor_models(raw);
        let ids: Vec<&str> = parsed
            .iter()
            .filter_map(|model| model.get("id").and_then(|value| value.as_str()))
            .collect();
        assert_eq!(ids, vec!["auto", "gpt-5.3-codex-low", "gpt-5.3-codex"]);
        let names: Vec<&str> = parsed
            .iter()
            .filter_map(|model| model.get("name").and_then(|value| value.as_str()))
            .collect();
        assert_eq!(names[1], "Codex 5.3 Low");
    }

    #[test]
    fn parses_opencode_agents_default_and_custom() {
        let agents = provider_agents("opencode");
        assert!(agents.iter().any(|a| a.get("id").and_then(|v| v.as_str()) == Some("build")));
        assert!(agents.iter().any(|a| a.get("id").and_then(|v| v.as_str()) == Some("plan")));
        // If local opencode.json exists, gentle-orchestrator should be present
        if std::path::Path::new(&format!("{}/.config/opencode/opencode.json", std::env::var("USERPROFILE").unwrap_or_default())).is_file() {
            assert!(agents.iter().any(|a| a.get("id").and_then(|v| v.as_str()) == Some("gentle-orchestrator")));
        }
    }
}

pub fn provider_agents(provider: &str) -> Vec<Value> {
    let canon = match provider {
        "agy" => "antigravity",
        "claude-code" => "claude",
        "open-code" => "opencode",
        other => other,
    };

    let mut modes = vec![
        json!({
            "id": "build",
            "label": "Build",
            "detail": "Works with the permission mode below",
            "plan": false,
        }),
        json!({
            "id": "plan",
            "label": "Plan",
            "detail": "Reads and plans, changes nothing",
            "plan": true,
        }),
    ];

    if canon == "opencode" {
        if let Some(custom_agents) = read_opencode_config_agents() {
            for agent in custom_agents {
                let id = agent.get("id").and_then(|v| v.as_str()).unwrap_or("");
                if id != "build" && id != "plan" {
                    modes.push(agent);
                }
            }
        }
    }

    modes
}

fn read_opencode_config_agents() -> Option<Vec<Value>> {
    let mut candidates = Vec::new();
    if let Ok(user) = std::env::var("USERPROFILE") {
        candidates.push(std::path::PathBuf::from(&user).join(".config").join("opencode").join("opencode.json"));
    }
    if let Ok(home) = std::env::var("HOME") {
        candidates.push(std::path::PathBuf::from(&home).join(".config").join("opencode").join("opencode.json"));
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        candidates.push(std::path::PathBuf::from(&local).join("opencode").join("opencode.json"));
    }
    candidates.push(std::path::PathBuf::from(".opencode").join("opencode.json"));

    for path in candidates {
        if path.is_file() {
            if let Ok(content) = std::fs::read_to_string(&path) {
                if let Ok(val) = serde_json::from_str::<Value>(&content) {
                    if let Some(agents_obj) = val.get("agent").and_then(|v| v.as_object()) {
                        let mut list = Vec::new();
                        for (key, agent_data) in agents_obj {
                            let hidden = agent_data
                                .get("hidden")
                                .and_then(|v| v.as_bool())
                                .unwrap_or(false);
                            if hidden {
                                continue;
                            }
                            let desc = agent_data
                                .get("description")
                                .and_then(|v| v.as_str())
                                .unwrap_or("");
                            let mode = agent_data
                                .get("mode")
                                .and_then(|v| v.as_str())
                                .unwrap_or("subagent");
                            let model = agent_data
                                .get("model")
                                .and_then(|v| v.as_str());

                            // Generate human-friendly label
                            let label = key
                                .split(&['-', '_'][..])
                                .map(|w| {
                                    let mut chars = w.chars();
                                    match chars.next() {
                                        None => String::new(),
                                        Some(f) => f.to_uppercase().collect::<String>() + chars.as_str(),
                                    }
                                })
                                .collect::<Vec<_>>()
                                .join(" ");

                            let detail = if !desc.is_empty() {
                                desc.to_string()
                            } else {
                                format!("Mode: {mode}")
                            };

                            let mut entry = json!({
                                "id": key,
                                "label": label,
                                "detail": detail,
                                "plan": false,
                                "mode": mode,
                            });
                            if let Some(m) = model {
                                entry["model"] = json!(m);
                            }
                            list.push(entry);
                        }
                        return Some(list);
                    }
                }
            }
        }
    }
    None
}
