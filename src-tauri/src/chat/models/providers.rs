use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::chat::normalize::catalog_cache_key;
use crate::chat::utils::{binary_exists, resolve_bin};
use super::*;

pub fn provider_models(provider: &str, force_refresh: bool) -> Value {
    provider_models_for(provider, None, force_refresh)
}

pub const THREAD_PROVIDERS: [&str; 7] = [
    "antigravity",
    "grok",
    "codex",
    "claude",
    "cursor",
    "opencode",
    "gemini",
];

pub fn canonical_thread_provider_id(raw: &str) -> Option<&'static str> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "antigravity" | "agy" => Some("antigravity"),
        "claude" | "claude-code" => Some("claude"),
        "codex" => Some("codex"),
        "cursor" | "cursor-agent" => Some("cursor"),
        "gemini" => Some("gemini"),
        "grok" => Some("grok"),
        "opencode" | "open-code" => Some("opencode"),
        _ => None,
    }
}

pub fn provider_models_for(
    provider: &str,
    connection_id: Option<&str>,
    force_refresh: bool,
) -> Value {
    let canon = match provider {
        "agy" => "antigravity",
        "claude-code" => "claude",
        "open-code" => "opencode",
        "cursor-agent" => "cursor",
        other => other,
    };
    let cache_key = catalog_cache_key(canon, connection_id);

    // 1. Check in-memory cache first unless force_refresh is requested
    if !force_refresh {
        if let Ok(cache) = model_cache().lock() {
            if let Some(entry) = cache.get(&cache_key) {
                if entry.cached_at.elapsed() < MODEL_CACHE_TTL && !entry.models.is_empty() {
                    return catalog_payload(canon, &entry.models, true);
                }
            }
        }

        // 1b. Check disk cache if in-memory cache is cold
        if let Some(disk_models) = load_provider_models_from_disk(&cache_key) {
            if let Ok(mut cache) = model_cache().lock() {
                cache.insert(
                    cache_key.clone(),
                    CachedProviderModels {
                        models: disk_models.clone(),
                        cached_at: Instant::now(),
                    },
                );
            }
            return catalog_payload(canon, &disk_models, true);
        }

        // Skip spawning external CLIs when binary is absent or signed out.
        if !provider_binary_present(canon) || provider_signed_in(canon) == Some(false) {
            return catalog_payload(canon, &[], false);
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
                cache_key.clone(),
                CachedProviderModels {
                    models: fresh_models.clone(),
                    cached_at: Instant::now(),
                },
            );
        }
        save_provider_models_to_disk(&cache_key, &fresh_models);
    }

    catalog_payload(canon, &fresh_models, false)
}

pub fn provider_ok(provider: &str) -> bool {
    matches!(
        provider,
        "antigravity"
            | "agy"
            | "claude"
            | "claude-code"
            | "codex"
            | "cursor"
            | "cursor-agent"
            | "grok"
            | "opencode"
            | "open-code"
            | "gemini"
    )
}

pub fn mode_ok(provider: &str, mode: &str) -> bool {
    match provider {
        "codex" => matches!(mode, "acceptEdits" | "readOnly"),
        "claude"
        | "claude-code"
        | "cursor"
        | "cursor-agent"
        | "grok"
        | "opencode"
        | "open-code"
        | "antigravity"
        | "agy"
        | "gemini" => {
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

pub fn validate_provider_connection_with_status(
    canon: &str,
    binary_present: bool,
    signed_in: Option<bool>,
) -> Result<(), String> {
    let state = classify_catalog_availability(binary_present, signed_in);
    match state {
        "missing-binary" => Err(format!(
            "Provider `{canon}` is not installed or its CLI binary was not found on PATH. Run `kite dispatch providers` to check connected providers."
        )),
        "signed-out" => Err(format!(
            "Provider `{canon}` is installed but not signed in. Sign in to `{canon}` first or run `kite dispatch providers` to choose another connected provider."
        )),
        _ => Ok(()),
    }
}

pub fn validate_provider_connection(provider: &str) -> Result<(), String> {
    let Some(canon) = canonical_thread_provider_id(provider) else {
        return Err(format!(
            "Unknown thread provider `{provider}`. Allowed thread providers: {}. Run `kite dispatch providers` to see available providers.",
            THREAD_PROVIDERS.join(", ")
        ));
    };
    if cfg!(test) {
        return Ok(());
    }
    validate_provider_connection_with_status(
        canon,
        provider_binary_present(canon),
        provider_signed_in(canon),
    )
}

pub fn validate_provider_model_with_catalog(
    canon: &str,
    model: &str,
    catalog: &Value,
) -> Result<(), String> {
    if !model_id_ok(model) {
        return Err(format!(
            "Invalid model id `{model}` for provider `{canon}`."
        ));
    }
    let state = catalog
        .get("catalogState")
        .and_then(Value::as_str)
        .unwrap_or("ready");
    if matches!(state, "missing-binary" | "signed-out") {
        return Err(format!(
            "Provider `{canon}` is `{state}`. Run `kite dispatch providers` to inspect connected providers."
        ));
    }
    let models = catalog
        .get("models")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if !models.is_empty() {
        let matched = models.iter().any(|entry| {
            entry
                .get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| id.eq_ignore_ascii_case(model))
        });
        if !matched {
            let sample: Vec<&str> = models
                .iter()
                .filter_map(|entry| entry.get("id").and_then(Value::as_str))
                .take(8)
                .collect();
            let more = if models.len() > sample.len() {
                format!(" (+{} more)", models.len() - sample.len())
            } else {
                String::new()
            };
            return Err(format!(
                "Model `{model}` is not available for provider `{canon}`. Available models: {}{more}. Run `kite dispatch models {canon}` to list all or omit `--model`.",
                sample.join(", ")
            ));
        }
    } else if model_likely_belongs_to_another_provider(canon, model) {
        return Err(format!(
            "Model `{model}` does not belong to provider `{canon}`. Run `kite dispatch models {canon}` to inspect supported models or omit `--model`."
        ));
    }
    Ok(())
}

pub fn model_likely_belongs_to_another_provider(provider: &str, model: &str) -> bool {
    let canon = canonical_thread_provider_id(provider).unwrap_or(provider);
    let raw = model.trim().to_ascii_lowercase();
    let m = raw.rsplit('/').next().unwrap_or(&raw);
    if m.is_empty() {
        return false;
    }
    let looks_claude = m.starts_with("claude-")
        || m.contains("sonnet")
        || m.contains("haiku")
        || m.contains("opus");
    let looks_gemini = m.starts_with("gemini-") || m.starts_with("models/gemini-");
    let looks_grok = m.starts_with("grok-");
    let looks_openai = m.starts_with("gpt-")
        || m.starts_with("o1")
        || m.starts_with("o3")
        || m.starts_with("o4")
        || m.contains("-codex");

    match canon {
        "grok" => looks_claude || looks_gemini || looks_openai,
        "claude" => looks_grok || looks_gemini || looks_openai,
        "gemini" => looks_grok || looks_claude || looks_openai,
        "codex" => looks_grok || looks_claude || looks_gemini,
        "antigravity" => looks_grok || m.contains("-codex"),
        _ => false,
    }
}

pub fn validate_provider_model_selection(provider: &str, model: &str) -> Result<(), String> {
    let Some(canon) = canonical_thread_provider_id(provider) else {
        return Err(format!(
            "Unknown thread provider `{provider}`. Allowed thread providers: {}.",
            THREAD_PROVIDERS.join(", ")
        ));
    };
    if cfg!(test) {
        if !model_id_ok(model) {
            return Err(format!("Invalid model id `{model}`."));
        }
        return Ok(());
    }
    let catalog = provider_models(canon, false);
    validate_provider_model_with_catalog(canon, model, &catalog)
}

pub fn discover_thread_providers(refresh: bool) -> Value {
    let mut rows = Vec::with_capacity(THREAD_PROVIDERS.len());
    for canon in THREAD_PROVIDERS {
        let binary_present = provider_binary_present(canon);
        let signed_in = provider_signed_in(canon);
        let state = classify_catalog_availability(binary_present, signed_in);
        let catalog = if state == "ready" {
            provider_models(canon, refresh)
        } else {
            catalog_payload(canon, &[], false)
        };
        let models: Vec<Value> = catalog
            .get("models")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let sample_ids: Vec<String> = models
            .iter()
            .filter_map(|m| m.get("id").and_then(Value::as_str).map(str::to_string))
            .take(5)
            .collect();
        let supports_discovery = !matches!(canon, "claude" | "gemini");
        rows.push(json!({
            "provider": canon,
            "state": state,
            "binaryPresent": binary_present,
            "signedIn": signed_in,
            "supportsModelDiscovery": supports_discovery,
            "modelCount": models.len(),
            "sampleModels": sample_ids,
        }));
    }
    json!({
        "providers": rows,
    })
}

pub fn format_providers_text(discovery: &Value) -> String {
    let rows = discovery
        .get("providers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut lines = vec![
        "Thread providers (use with `--via thread --provider <name>` or `kite dispatch swarm add`):"
            .to_string(),
    ];
    for row in rows {
        let provider = row.get("provider").and_then(Value::as_str).unwrap_or("");
        let state = row.get("state").and_then(Value::as_str).unwrap_or("unknown");
        let count = row.get("modelCount").and_then(Value::as_u64).unwrap_or(0);
        let supports = row
            .get("supportsModelDiscovery")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let samples: Vec<&str> = row
            .get("sampleModels")
            .and_then(Value::as_array)
            .map(|arr| arr.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        let detail = if state != "ready" {
            format!("({})", state)
        } else if count > 0 {
            format!("{count} models (e.g. {})", samples.join(", "))
        } else if !supports {
            "CLI manages default model (omit `--model` or pass an explicit id)".to_string()
        } else {
            "0 cached models (run with `--refresh` or omit `--model`)".to_string()
        };
        lines.push(format!("  {provider:<12} {state:<14} {detail}"));
    }
    lines.join("\n")
}

pub fn format_models_text(catalog: &Value) -> String {
    let provider = catalog.get("provider").and_then(Value::as_str).unwrap_or("");
    let state = catalog
        .get("catalogState")
        .and_then(Value::as_str)
        .unwrap_or("ready");
    let models = catalog
        .get("models")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if models.is_empty() {
        if state != "ready" {
            return format!("{provider} ({state}): provider is unavailable on this machine.");
        }
        return format!(
            "{provider} (ready): provider CLI manages its default model dynamically; omit `--model` or pass a known account model id."
        );
    }
    let mut lines = vec![format!("{provider} ({state}, {} models):", models.len())];
    for entry in models {
        let id = entry.get("id").and_then(Value::as_str).unwrap_or("");
        if id.is_empty() {
            continue;
        }
        let name = entry.get("name").and_then(Value::as_str).unwrap_or(id);
        let efforts: Vec<&str> = entry
            .get("effortLevels")
            .and_then(Value::as_array)
            .map(|arr| arr.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        let effort_suffix = if efforts.is_empty() {
            String::new()
        } else {
            format!(" [effort: {}]", efforts.join(","))
        };
        if name != id {
            lines.push(format!("  {id}  ({name}){effort_suffix}"));
        } else {
            lines.push(format!("  {id}{effort_suffix}"));
        }
    }
    lines.join("\n")
}
