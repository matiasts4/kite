use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::chat::normalize::catalog_cache_key;
use crate::chat::utils::{binary_exists, resolve_bin};
use super::*;

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
            None,
            None,
        ));
        if models.len() >= 400 {
            break;
        }
    }
    models
}

pub fn sort_effort_levels(levels: &mut [String]) {
    fn rank(s: &str) -> i32 {
        match s.to_lowercase().as_str() {
            "none" | "off" => 0,
            "minimal" | "min" => 1,
            "low" => 2,
            "medium" | "med" => 3,
            "high" => 4,
            "xhigh" | "extra-high" | "extra_high" | "very-high" => 5,
            "max" | "maximum" => 6,
            "ultra" => 7,
            _ => 10,
        }
    }
    levels.sort_by(|a, b| {
        let ra = rank(a);
        let rb = rank(b);
        if ra != rb {
            ra.cmp(&rb)
        } else {
            a.cmp(b)
        }
    });
}

pub fn model_row(
    id: &str,
    name: &str,
    description: &str,
    supports_effort: bool,
    effort_levels: Option<Vec<String>>,
    default_effort: Option<&str>,
) -> Value {
    let mut obj = json!({
        "id": id,
        "name": name,
        "description": description,
        "supportsEffort": supports_effort,
    });
    if let Some(levels) = effort_levels {
        if !levels.is_empty() {
            obj["effortLevels"] = json!(levels);
        }
    }
    if let Some(def) = default_effort {
        obj["defaultEffort"] = json!(def);
    }
    obj
}

pub fn fetch_opencode_models_dynamic() -> Vec<Value> {
    query_opencode_models_cli().unwrap_or_default()
}

pub fn read_opencode_config() -> Option<Value> {
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
                    return Some(val);
                }
            }
        }
    }
    None
}

/// Parses the CLI's `provider/model` lines into catalog rows. Pure, so it is
/// testable without spawning the CLI.
pub fn parse_opencode_models(raw: &str) -> Vec<Value> {
    let config = read_opencode_config();
    parse_opencode_models_inner(raw, config.as_ref())
}

pub fn parse_opencode_models_inner(raw: &str, config: Option<&Value>) -> Vec<Value> {
    let mut seen = std::collections::HashSet::new();
    let mut models = Vec::new();
    let root_model = config.and_then(|c| c.get("model")).and_then(|v| v.as_str());
    let root_variant = config.and_then(|c| c.get("variant")).and_then(|v| v.as_str());

    for line in raw.lines() {
        let id = line.trim();
        if id.is_empty() || !id.contains('/') || id.chars().any(char::is_whitespace) {
            continue;
        }
        if !model_id_ok(id) || !seen.insert(id.to_string()) {
            continue;
        }
        let (provider, model_part) = id.split_once('/').unwrap_or(("", id));

        // Check if opencode.json defines this model under provider.<provider>.models.<model_part>
        let config_model_entry = config
            .and_then(|c| c.get("provider"))
            .and_then(|p| p.get(provider))
            .and_then(|p_obj| p_obj.get("models"))
            .and_then(|m_obj| m_obj.get(model_part));

        let display_name = config_model_entry
            .and_then(|m| m.get("name"))
            .and_then(|v| v.as_str())
            .unwrap_or(id);

        let mut variants = Vec::new();
        if let Some(variants_obj) = config_model_entry.and_then(|m| m.get("variants")).and_then(|v| v.as_object()) {
            for key in variants_obj.keys() {
                variants.push(key.clone());
            }
        }

        let is_root_configured = root_model == Some(id);
        let id_lower = id.to_lowercase();

        // If no explicit variants were configured, check if this is a known reasoning model
        if variants.is_empty() {
            if is_root_configured && root_variant.is_some() {
                variants.push(root_variant.unwrap().to_string());
                variants.push("low".to_string());
                variants.push("medium".to_string());
                variants.push("high".to_string());
            } else if id_lower.contains("o1") || id_lower.contains("o3") || id_lower.contains("o4") || id_lower.contains("reasoning") {
                variants = vec!["low".into(), "medium".into(), "high".into(), "xhigh".into()];
            } else if id_lower.contains("claude") && (id_lower.contains("thinking") || id_lower.contains("opus") || id_lower.contains("sonnet-4") || id_lower.contains("3-7")) {
                variants = vec!["low".into(), "medium".into(), "high".into(), "max".into()];
            } else if id_lower.contains("deepseek") || id_lower.contains("r1") {
                variants = vec!["low".into(), "medium".into(), "high".into(), "max".into()];
            } else if id_lower.contains("gemini") && (id_lower.contains("3") || id_lower.contains("4") || id_lower.contains("argon") || id_lower.contains("pro")) {
                variants = vec!["minimal".into(), "low".into(), "medium".into(), "high".into()];
            }
        }

        variants.sort();
        variants.dedup();
        sort_effort_levels(&mut variants);

        let supports_effort = variants.len() >= 2;
        let default_effort: Option<String> = if !supports_effort {
            None
        } else if let Some(rv) = root_variant {
            if is_root_configured || variants.iter().any(|v| v == rv) {
                Some(rv.to_string())
            } else if variants.iter().any(|v| v == "medium") {
                Some("medium".to_string())
            } else {
                variants.first().cloned()
            }
        } else if variants.iter().any(|v| v == "medium") {
            Some("medium".to_string())
        } else {
            variants.first().cloned()
        };

        models.push(model_row(
            id,
            display_name,
            &format!("{provider} through the OpenCode CLI"),
            supports_effort,
            if supports_effort { Some(variants) } else { None },
            default_effort.as_deref(),
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
