use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::chat::utils::{resolve_bin, user_home_dir};

pub(crate) struct CachedProviderModels {
    pub(crate) models: Vec<Value>,
    pub(crate) cached_at: Instant,
}

static MODEL_CACHE: std::sync::OnceLock<Mutex<HashMap<String, CachedProviderModels>>> =
    std::sync::OnceLock::new();

pub(crate) fn model_cache() -> &'static Mutex<HashMap<String, CachedProviderModels>> {
    MODEL_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) const MODEL_CACHE_TTL: Duration = Duration::from_secs(900); // 15 minutes TTL

pub fn provider_models(provider: &str, force_refresh: bool) -> Value {
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
        "cursor" => fetch_cursor_models_dynamic(),
        "grok" => fetch_grok_models_dynamic(),
        "opencode" => fetch_opencode_models_dynamic(),
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

pub fn fetch_antigravity_models_dynamic() -> Vec<Value> {
    if let Some(live) = query_agy_models_cli() {
        if !live.is_empty() {
            return live;
        }
    }
    antigravity_fallback_models()
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

pub fn antigravity_fallback_models() -> Vec<Value> {
    vec![
        model_row("gemini-4-argon", "Gemini 4 Argon", "Frontier reasoning & agentic coding (Google DeepMind)", true),
        model_row("gemini-3.8-flash", "Gemini 3.8 Flash", "Ultra-fast, lightweight agentic execution (Google DeepMind)", true),
        model_row("claude-opus-5-5", "Claude Opus 5.5", "Frontier reasoning on Antigravity (Anthropic)", true),
        model_row("claude-sonnet-5-5", "Claude Sonnet 5.5", "Balanced high-speed coding on Antigravity (Anthropic)", true),
        model_row("gpt-oss-120b", "GPT-OSS 120B", "Open-weights 120B model hosted on Antigravity", false),
    ]
}

pub fn fetch_codex_models_dynamic() -> Vec<Value> {
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
    grok_fallback_models()
}

pub fn grok_fallback_models() -> Vec<Value> {
    vec![
        model_row("grok-4.7", "Grok 4.7", "xAI Grok default model", true),
        model_row(
            "grok-4.7-build-fast",
            "Grok 4.7 Build Fast",
            "Fast agentic build model",
            true,
        ),
        model_row("grok-4.6", "Grok 4.6", "Previous Grok model", true),
        model_row("grok-4.5", "Grok 4.5", "Legacy Grok model", true),
    ]
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
    cursor_fallback_models()
}

pub fn cursor_fallback_models() -> Vec<Value> {
    vec![model_row("auto", "Auto", "Cursor picks a model", false)]
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
    if let Some(live) = query_opencode_models_cli() {
        if !live.is_empty() {
            return live;
        }
    }
    vec![model_row("auto", "Auto", "OpenCode default model", false)]
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
}
