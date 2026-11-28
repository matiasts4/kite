use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::chat::normalize::catalog_cache_key;
use crate::chat::utils::{binary_exists, resolve_bin};
use super::*;

pub fn fetch_antigravity_models_dynamic() -> Vec<Value> {
    query_agy_models_cli().unwrap_or_default()
}

/// Returns true for Antigravity model IDs known not to accept `--effort` / `thought_level`.
pub fn is_antigravity_non_effort_model(model: &str) -> bool {
    let lower = model.trim().to_ascii_lowercase();
    if lower.is_empty() {
        return false;
    }
    lower.contains("orchestrator")
        || matches!(lower.as_str(), "gpt-oss-120b" | "gpt-oss-120b-medium")
}

/// Sanitizes an Antigravity CLI `--effort` value against model support and the
/// `agy --effort` accepted grammar (`low|medium|high|xhigh|max`).
pub fn sanitize_antigravity_cli_effort(
    model: Option<&str>,
    effort: Option<&str>,
) -> Option<String> {
    let raw = effort.map(str::trim).filter(|s| !s.is_empty())?;
    if model.is_some_and(is_antigravity_non_effort_model) {
        return None;
    }
    match raw.to_ascii_lowercase().as_str() {
        "none" | "off" => None,
        "minimal" | "min" | "low" => Some("low".to_string()),
        "medium" | "med" => Some("medium".to_string()),
        "high" => Some("high".to_string()),
        "xhigh" | "x-high" | "extra-high" | "extra_high" | "very-high" | "extra" | "ultra" => {
            Some("xhigh".to_string())
        }
        "max" | "maximum" => Some("max".to_string()),
        _ => Some(raw.to_string()),
    }
}

pub fn parse_agy_models(raw: &str) -> Vec<Value> {
    struct ModelEntry {
        base_id: String,
        clean_name: String,
        description: &'static str,
        tiers: Vec<String>,
    }

    let mut order: Vec<String> = Vec::new();
    let mut map: HashMap<String, ModelEntry> = HashMap::new();

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

        let (base_id, effort_tier) = if let Some(stripped) = raw_id.strip_suffix("-high") {
            (stripped, Some("high"))
        } else if let Some(stripped) = raw_id.strip_suffix("-medium") {
            (stripped, Some("medium"))
        } else if let Some(stripped) = raw_id.strip_suffix("-low") {
            (stripped, Some("low"))
        } else if let Some(stripped) = raw_id.strip_suffix("-xhigh") {
            (stripped, Some("xhigh"))
        } else if let Some(stripped) = raw_id.strip_suffix("-max") {
            (stripped, Some("max"))
        } else if let Some(stripped) = raw_id.strip_suffix("-minimal") {
            (stripped, Some("minimal"))
        } else if let Some(stripped) = raw_id.strip_suffix("-ultra") {
            (stripped, Some("ultra"))
        } else {
            (raw_id, None)
        };

        let clean_name = raw_name
            .replace(" (High)", "")
            .replace(" (Medium)", "")
            .replace(" (Low)", "")
            .replace(" (XHigh)", "")
            .replace(" (X-High)", "")
            .replace(" (Max)", "")
            .replace(" (Minimal)", "")
            .replace(" (Ultra)", "")
            .replace(" (Adaptive)", "");

        let id_lower = base_id.to_lowercase();
        let description = if id_lower.contains("orchestrator") {
            "Multi-agent orchestration model (Google DeepMind)"
        } else if id_lower.contains("gemini-4") || id_lower.contains("argon") {
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

        let entry = map.entry(base_id.to_string()).or_insert_with(|| {
            order.push(base_id.to_string());
            ModelEntry {
                base_id: base_id.to_string(),
                clean_name,
                description,
                tiers: Vec::new(),
            }
        });

        if let Some(tier) = effort_tier {
            if !entry.tiers.iter().any(|t| t == tier) {
                entry.tiers.push(tier.to_string());
            }
        }
    }

    let mut result = Vec::new();
    for id in order {
        if let Some(mut entry) = map.remove(&id) {
            sort_effort_levels(&mut entry.tiers);

            let supports_effort = entry.tiers.len() >= 2;
            let default_effort: Option<String> = if !supports_effort {
                None
            } else if entry.tiers.iter().any(|t| t == "medium") {
                Some("medium".to_string())
            } else {
                entry.tiers.first().cloned()
            };

            result.push(model_row(
                &entry.base_id,
                &entry.clean_name,
                entry.description,
                supports_effort,
                if supports_effort { Some(entry.tiers) } else { None },
                default_effort.as_deref(),
            ));
        }
    }

    result
}

pub fn query_agy_models_cli() -> Option<Vec<Value>> {
    let local_app_data = std::env::var("LOCALAPPDATA")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| crate::quota::utils::user_home_dir().join("AppData").join("Local"));
    let fallback_agy = local_app_data.join("agy").join("bin").join("agy.exe");
    let fallback_str = fallback_agy.to_string_lossy().into_owned();
    let program = resolve_bin("agy", &[fallback_str.as_str()])?;
    if std::env::var("AGY_CLI_DISABLE_AUTO_UPDATE").is_err() {
        std::env::set_var("AGY_CLI_DISABLE_AUTO_UPDATE", "true");
    }
    let out = crate::hidden_exec::run(&program, &["models"], Duration::from_secs(8)).ok()?;
    if !out.success() {
        return None;
    }
    let raw = out.stdout_lossy();
    let models = parse_agy_models(&raw);
    if models.is_empty() {
        None
    } else {
        Some(models)
    }
}

/// Codex has no model-list command wired here. The configured `model` key in
/// `config.toml` is one saved choice, not the catalog, so it is not expanded
/// into a menu.
pub fn fetch_codex_models_dynamic() -> Vec<Value> {
    Vec::new()
}

pub fn fetch_grok_models_dynamic() -> Vec<Value> {
    // The text `grok models` list is often empty on current CLIs
    // (`Default model: <id> (not in list below)` then no bullets). The
    // on-disk catalog is the account's live menu, so it is the first source.
    if let Some(raw) = read_grok_models_cache_raw() {
        let models = parse_grok_catalog_models(&raw);
        if !models.is_empty() {
            return models;
        }
    }
    if let Some(program) = resolve_bin("grok", &[]) {
        if let Ok(out) = crate::hidden_exec::run(&program, &["models"], Duration::from_secs(10)) {
            if out.success() {
                let mut models = parse_grok_models(&out.stdout_lossy());
                if !models.is_empty() {
                    if let Some(menus) = read_grok_effort_menus() {
                        apply_grok_effort_menus(&mut models, &menus);
                    }
                    return models;
                }
            }
        }
    }
    Vec::new()
}

pub(super) fn grok_models_cache_path() -> std::path::PathBuf {
    crate::quota::utils::user_home_dir()
        .join(".grok")
        .join("models_cache.json")
}

pub(super) fn read_grok_models_cache_raw() -> Option<String> {
    std::fs::read_to_string(grok_models_cache_path()).ok()
}

/// Reads the Grok CLI catalog (`~/.grok/models_cache.json`) that records each
/// model's `reasoning_efforts` menu. The text `grok models` list names ids
/// only. A missing file leaves those rows without levels.
pub(super) fn read_grok_effort_menus() -> Option<HashMap<String, GrokEffortMenu>> {
    let raw = read_grok_models_cache_raw()?;
    let menus = parse_grok_effort_menus(&raw);
    if menus.is_empty() {
        None
    } else {
        Some(menus)
    }
}

pub struct GrokEffortMenu {
    pub levels: Vec<String>,
    pub default_effort: Option<String>,
}

/// Parses the CLI catalog. A model is included only when it advertises at
/// least two reasoning levels. Fewer than two leaves the control disabled.
pub fn parse_grok_effort_menus(raw: &str) -> HashMap<String, GrokEffortMenu> {
    let mut menus = HashMap::new();
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return menus;
    };
    let Some(models) = value.get("models").and_then(|entry| entry.as_object()) else {
        return menus;
    };
    for (id, entry) in models {
        let info = entry.get("info").unwrap_or(entry);
        if info
            .get("supports_reasoning_effort")
            .and_then(|flag| flag.as_bool())
            != Some(true)
        {
            continue;
        }
        let mut levels: Vec<String> = info
            .get("reasoning_efforts")
            .and_then(|rows| rows.as_array())
            .map(|rows| {
                rows.iter()
                    .filter_map(|row| row.get("id").and_then(|value| value.as_str()))
                    .map(str::trim)
                    .filter(|level| !level.is_empty())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        sort_effort_levels(&mut levels);
        levels.dedup();
        if levels.len() < 2 {
            continue;
        }
        let default_effort = info
            .get("reasoning_effort")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|level| levels.iter().any(|known| known == level))
            .map(str::to_string);
        menus.insert(
            id.clone(),
            GrokEffortMenu {
                levels,
                default_effort,
            },
        );
    }
    menus
}

pub fn apply_grok_effort_menus(models: &mut [Value], menus: &HashMap<String, GrokEffortMenu>) {
    for model in models.iter_mut() {
        let Some(id) = model.get("id").and_then(|value| value.as_str()) else {
            continue;
        };
        let Some(menu) = menus.get(id) else {
            continue;
        };
        model["supportsEffort"] = json!(true);
        model["effortLevels"] = json!(menu.levels);
        if let Some(default_effort) = &menu.default_effort {
            model["defaultEffort"] = json!(default_effort);
        }
    }
}

/// Parses the Grok CLI catalog into picker rows. Hidden models stay out.
/// Effort menus attach only when the catalog advertises at least two levels.
pub fn parse_grok_catalog_models(raw: &str) -> Vec<Value> {
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return Vec::new();
    };
    let Some(models) = value.get("models").and_then(|entry| entry.as_object()) else {
        return Vec::new();
    };
    let menus = parse_grok_effort_menus(raw);
    let mut rows = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (id, entry) in models {
        if !model_id_ok(id) || !seen.insert(id.clone()) {
            continue;
        }
        let info = entry.get("info").unwrap_or(entry);
        if info.get("hidden").and_then(|flag| flag.as_bool()) == Some(true) {
            continue;
        }
        let name = info
            .get("name")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(id);
        let description = info
            .get("description")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("Listed by the Grok CLI");
        let menu = menus.get(id);
        rows.push(model_row(
            id,
            name,
            description,
            menu.is_some(),
            menu.map(|entry| entry.levels.clone()),
            menu.and_then(|entry| entry.default_effort.as_deref()),
        ));
    }
    rows
}

/// Parses `grok models`: the default-model line, then a bulleted list under
/// `Available models:`. Current CLIs often print the default as
/// `(not in list below)` with an empty bullet list.
pub fn parse_grok_models(raw: &str) -> Vec<Value> {
    let mut seen = std::collections::HashSet::new();
    let mut models = Vec::new();
    for line in raw.lines() {
        let trimmed = line.trim();
        let Some(rest) = trimmed.strip_prefix("Default model:") else {
            continue;
        };
        let id = rest.split_whitespace().next().unwrap_or("").trim();
        if id.is_empty() || !model_id_ok(id) || !seen.insert(id.to_string()) {
            break;
        }
        models.push(model_row(
            id,
            id,
            "Listed by the Grok CLI",
            false,
            None,
            None,
        ));
        break;
    }
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
        models.push(model_row(
            id,
            id,
            "Listed by the Grok CLI",
            false,
            None,
            None,
        ));
    }
    models
}
