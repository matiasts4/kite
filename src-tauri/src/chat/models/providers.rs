use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const THREAD_PROVIDERS_CACHE_TTL: Duration = Duration::from_secs(10);

use crate::chat::normalize::catalog_cache_key;
use crate::chat::utils::{binary_exists, resolve_bin};
use super::*;

pub fn provider_models(provider: &str, force_refresh: bool) -> Value {
    provider_models_for(provider, None, force_refresh)
}

/// Reads already-cached model IDs (memory or disk cache) without spawning a CLI binary.
pub fn cached_provider_model_ids(provider: &str) -> Vec<String> {
    let Some(canon) = canonical_thread_provider_id(provider) else {
        return Vec::new();
    };
    let cache_key = catalog_cache_key(canon, None);
    let models = {
        if let Ok(cache) = model_cache().lock() {
            if let Some(entry) = cache.get(&cache_key) {
                if !entry.models.is_empty() {
                    Some(entry.models.clone())
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            None
        }
    }
    .or_else(|| load_provider_models_from_disk(&cache_key));

    let mut ids: Vec<String> = models
        .unwrap_or_default()
        .into_iter()
        .filter_map(|m| {
            m.get("id")
                .and_then(Value::as_str)
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        })
        .collect();
    ids.sort();
    ids.dedup();
    ids
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

pub(crate) struct ThreadProvidersCache {
    ttl: Duration,
    state: Mutex<Option<(String, Instant, Value)>>,
    fetch_lock: Mutex<()>,
}

impl ThreadProvidersCache {
    pub(crate) const fn new(ttl: Duration) -> Self {
        Self {
            ttl,
            state: Mutex::new(None),
            fetch_lock: Mutex::new(()),
        }
    }

    pub(crate) fn get_or_compute(
        &self,
        settings_key: &str,
        refresh: bool,
        bypass_time_ttl: bool,
        compute: impl FnOnce() -> Value,
    ) -> Value {
        if !refresh && !bypass_time_ttl {
            let guard = self.state.lock().unwrap();
            if let Some((cached_key, cached_at, val)) = guard.as_ref() {
                if cached_key == settings_key && cached_at.elapsed() < self.ttl {
                    return val.clone();
                }
            }
        }

        let _singleflight = self.fetch_lock.lock().unwrap();
        if !refresh && !bypass_time_ttl {
            let guard = self.state.lock().unwrap();
            if let Some((cached_key, cached_at, val)) = guard.as_ref() {
                if cached_key == settings_key && cached_at.elapsed() < self.ttl {
                    return val.clone();
                }
            }
        }

        let fresh = compute();
        if !bypass_time_ttl {
            *self.state.lock().unwrap() =
                Some((settings_key.to_string(), Instant::now(), fresh.clone()));
        }
        fresh
    }

    pub(crate) fn invalidate(&self) {
        *self.state.lock().unwrap() = None;
    }
}

static THREAD_PROVIDERS_CACHE: OnceLock<ThreadProvidersCache> = OnceLock::new();

fn thread_providers_cache() -> &'static ThreadProvidersCache {
    THREAD_PROVIDERS_CACHE
        .get_or_init(|| ThreadProvidersCache::new(THREAD_PROVIDERS_CACHE_TTL))
}

pub fn invalidate_thread_providers_cache() {
    thread_providers_cache().invalidate();
}

pub fn discover_thread_providers(refresh: bool) -> Value {
    let settings = crate::subagent_settings::get_subagent_settings();
    discover_thread_providers_with_settings(refresh, &settings)
}

fn build_thread_provider_row(
    canon: &str,
    refresh: bool,
    enabled_stack: &[&crate::subagent_settings::SubagentStackEntry],
    stack_active: bool,
    default_provider: Option<&str>,
) -> Value {
    let (binary_present, signed_in, state, models) = if cfg!(test) {
        (false, None, "missing-binary", Vec::new())
    } else {
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
        (binary_present, signed_in, state, models)
    };
    let sample_ids: Vec<String> = models
        .iter()
        .filter_map(|m| m.get("id").and_then(Value::as_str).map(str::to_string))
        .take(5)
        .collect();
    let stack_models: Vec<String> = enabled_stack
        .iter()
        .filter(|e| e.provider == canon)
        .map(|e| e.model.clone())
        .collect();
    let in_stack = !stack_active || !stack_models.is_empty();
    let is_default_delegation = default_provider == Some(canon);
    let supports_discovery = !matches!(canon, "claude" | "gemini");
    json!({
        "provider": canon,
        "state": state,
        "binaryPresent": binary_present,
        "signedIn": signed_in,
        "supportsModelDiscovery": supports_discovery,
        "modelCount": models.len(),
        "sampleModels": sample_ids,
        "inStack": in_stack,
        "stackModels": stack_models,
        "isDefaultDelegation": is_default_delegation,
    })
}

fn discover_thread_providers_with_settings_uncached(
    refresh: bool,
    settings: &crate::subagent_settings::SubagentSettings,
) -> Value {
    let enabled_stack: Vec<&crate::subagent_settings::SubagentStackEntry> =
        settings.stack.iter().filter(|e| e.enabled).collect();
    let stack_active = !enabled_stack.is_empty();
    let default_provider = settings
        .default_delegation
        .as_ref()
        .map(|d| d.provider.as_str());

    let rows: Vec<Value> = std::thread::scope(|s| {
        let handles: Vec<_> = THREAD_PROVIDERS
            .iter()
            .map(|&canon| {
                let stack_ref = &enabled_stack;
                s.spawn(move || {
                    build_thread_provider_row(
                        canon,
                        refresh,
                        stack_ref,
                        stack_active,
                        default_provider,
                    )
                })
            })
            .collect();

        THREAD_PROVIDERS
            .iter()
            .zip(handles)
            .map(|(&canon, handle)| {
                handle.join().unwrap_or_else(|_| {
                    build_thread_provider_row(
                        canon,
                        refresh,
                        &enabled_stack,
                        stack_active,
                        default_provider,
                    )
                })
            })
            .collect()
    });

    json!({
        "providers": rows,
        "stackActive": stack_active,
        "overridePolicy": settings.override_policy.as_str(),
        "defaultDelegation": settings.default_delegation,
    })
}

pub fn discover_thread_providers_with_settings(
    refresh: bool,
    settings: &crate::subagent_settings::SubagentSettings,
) -> Value {
    let settings_key = serde_json::to_string(settings).unwrap_or_default();
    thread_providers_cache().get_or_compute(&settings_key, refresh, cfg!(test), || {
        discover_thread_providers_with_settings_uncached(refresh, settings)
    })
}

pub fn format_providers_text(discovery: &Value) -> String {
    let settings = crate::subagent_settings::get_subagent_settings();
    format_providers_text_with_settings(discovery, &settings)
}

pub fn format_providers_text_with_settings(
    discovery: &Value,
    settings: &crate::subagent_settings::SubagentSettings,
) -> String {
    let rows = discovery
        .get("providers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let enabled_stack: Vec<&crate::subagent_settings::SubagentStackEntry> =
        settings.stack.iter().filter(|e| e.enabled).collect();
    let stack_active = discovery
        .get("stackActive")
        .and_then(Value::as_bool)
        .unwrap_or(!enabled_stack.is_empty());
    let policy_str = discovery
        .get("overridePolicy")
        .and_then(Value::as_str)
        .unwrap_or(settings.override_policy.as_str());

    let mut lines = vec![
        "Thread providers (use with `--via thread --provider <name>` or `kite dispatch swarm add`):"
            .to_string(),
    ];
    if stack_active || settings.default_delegation.is_some() {
        let def_desc = settings
            .default_delegation
            .as_ref()
            .map(|d| format!(" | default delegation: {}/{}", d.provider, d.model))
            .unwrap_or_default();
        lines.push(format!(
            "  Subagent stack: {} enabled model(s) | override policy: {policy_str}{def_desc}",
            enabled_stack.len()
        ));
        lines.push(
            "  Delegation rule: omit `--provider` and `--model` in `kite dispatch run --via thread` to use your configured default automatically, or choose an enabled `[stack]` model below."
                .to_string(),
        );
    }
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
        let stack_models: Vec<String> = row
            .get("stackModels")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        let in_stack = row
            .get("inStack")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let is_default = row
            .get("isDefaultDelegation")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let stack_tag = if !stack_active {
            if is_default {
                " [default]".to_string()
            } else {
                String::new()
            }
        } else if !stack_models.is_empty() {
            let mut tags = vec![format!("stack: {}", stack_models.join(", "))];
            if is_default {
                tags.push("default".to_string());
            }
            format!(" [{}]", tags.join(" | "))
        } else if !in_stack {
            match policy_str {
                "strict" => " [blocked by strict stack]".to_string(),
                "ask" => " [outside stack; requires --override-stack]".to_string(),
                _ => " [outside curated stack]".to_string(),
            }
        } else {
            String::new()
        };
        let detail = if state != "ready" {
            format!("({})", state)
        } else if stack_active && !in_stack && policy_str != "allow" {
            "outside configured stack (omit --provider/--model or pick a [stack] model)".to_string()
        } else if count > 0 {
            format!("{count} models (e.g. {})", samples.join(", "))
        } else if !supports {
            "CLI manages default model (omit `--model` or pass an explicit id)".to_string()
        } else {
            "0 cached models (run with `--refresh` or omit `--model`)".to_string()
        };
        lines.push(format!("  {provider:<12} {state:<14} {detail}{stack_tag}"));
    }
    lines.join("\n")
}

pub fn format_models_text(catalog: &Value) -> String {
    let settings = crate::subagent_settings::get_subagent_settings();
    format_models_text_with_settings(catalog, &settings)
}

pub fn format_models_text_with_settings(
    catalog: &Value,
    settings: &crate::subagent_settings::SubagentSettings,
) -> String {
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
    let enabled_stack: Vec<&crate::subagent_settings::SubagentStackEntry> =
        settings.stack.iter().filter(|e| e.enabled).collect();
    let stack_active = !enabled_stack.is_empty() || settings.default_delegation.is_some();
    let policy_note = if stack_active {
        format!(" [stack policy: {}]", settings.override_policy.as_str())
    } else {
        String::new()
    };
    if models.is_empty() {
        if state != "ready" {
            return format!("{provider} ({state}): provider is unavailable on this machine.");
        }
        return format!(
            "{provider} (ready{policy_note}): provider CLI manages its default model dynamically; omit `--model` or pass a known account model id."
        );
    }
    let mut lines = vec![format!(
        "{provider} ({state}, {} models{policy_note}):",
        models.len()
    )];
    if stack_active {
        let def_desc = settings
            .default_delegation
            .as_ref()
            .map(|d| format!(" | default delegation: {}/{}", d.provider, d.model))
            .unwrap_or_default();
        lines.push(format!(
            "  Subagent stack: {} enabled model(s) | override policy: {}{def_desc}",
            enabled_stack.len(),
            settings.override_policy.as_str()
        ));
    }
    let mut hidden_non_stack = 0usize;
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
        let is_default = settings
            .default_delegation
            .as_ref()
            .is_some_and(|d| d.provider == provider && d.model.eq_ignore_ascii_case(id));
        let in_stack = enabled_stack
            .iter()
            .any(|e| e.provider == provider && e.model.eq_ignore_ascii_case(id));
        if stack_active
            && !is_default
            && !in_stack
            && settings.override_policy == crate::subagent_settings::OverridePolicy::Strict
        {
            hidden_non_stack += 1;
            continue;
        }
        let stack_badge = if is_default {
            " [default][stack]"
        } else if in_stack {
            " [stack]"
        } else if stack_active
            && settings.override_policy == crate::subagent_settings::OverridePolicy::Ask
        {
            " [outside stack; requires --override-stack]"
        } else {
            ""
        };
        if name != id {
            lines.push(format!("  {id}  ({name}){effort_suffix}{stack_badge}"));
        } else {
            lines.push(format!("  {id}{effort_suffix}{stack_badge}"));
        }
    }
    if hidden_non_stack > 0 {
        lines.push(format!(
            "  ({hidden_non_stack} non-stack models hidden by strict policy)"
        ));
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::subagent_settings::{
        DefaultDelegation, OverridePolicy, SubagentSettings, SubagentStackEntry,
    };

    #[test]
    fn format_providers_and_models_highlight_stack_and_default_badges() {
        let settings = SubagentSettings {
            stack: vec![
                SubagentStackEntry {
                    provider: "grok".to_string(),
                    model: "grok-4.7-build-fast".to_string(),
                    effort: Some("low".to_string()),
                    enabled: true,
                },
                SubagentStackEntry {
                    provider: "antigravity".to_string(),
                    model: "gemini-3-flash".to_string(),
                    effort: None,
                    enabled: true,
                },
            ],
            default_delegation: Some(DefaultDelegation {
                provider: "antigravity".to_string(),
                model: "gemini-3-flash".to_string(),
                effort: None,
            }),
            override_policy: OverridePolicy::Ask,
        };

        let discovery = json!({
            "stackActive": true,
            "overridePolicy": "ask",
            "providers": [
                {
                    "provider": "grok",
                    "state": "ready",
                    "supportsModelDiscovery": true,
                    "sampleModels": ["grok-4.7-build-fast"],
                    "inStack": true,
                    "stackModels": ["grok-4.7-build-fast"],
                    "isDefaultDelegation": false
                },
                {
                    "provider": "claude",
                    "state": "ready",
                    "supportsModelDiscovery": false,
                    "sampleModels": [],
                    "inStack": false,
                    "stackModels": [],
                    "isDefaultDelegation": false
                }
            ]
        });
        let providers_text = format_providers_text_with_settings(&discovery, &settings);
        assert!(providers_text.contains("ask"), "got: {providers_text}");
        assert!(providers_text.contains("grok-4.7-build-fast"), "got: {providers_text}");

        let catalog = json!({
            "provider": "antigravity",
            "catalogState": "ready",
            "models": [
                {
                    "id": "gemini-3-flash",
                    "name": "Gemini 3 Flash",
                    "effortLevels": ["low", "medium"]
                },
                {
                    "id": "claude-sonnet-4-6",
                    "name": "Claude Sonnet 4.6",
                    "effortLevels": []
                }
            ]
        });
        let models_text = format_models_text_with_settings(&catalog, &settings);
        assert!(models_text.contains("[stack policy: ask]"), "got: {models_text}");
        assert!(
            models_text.contains("Subagent stack: 2 enabled model(s) | override policy: ask | default delegation: antigravity/gemini-3-flash"),
            "got: {models_text}"
        );
        assert!(
            models_text.contains("gemini-3-flash  (Gemini 3 Flash) [effort: low,medium] [default][stack]"),
            "got: {models_text}"
        );
        assert!(
            models_text.contains("claude-sonnet-4-6  (Claude Sonnet 4.6) [outside stack; requires --override-stack]"),
            "got: {models_text}"
        );

        let mut strict_settings = settings.clone();
        strict_settings.override_policy = crate::subagent_settings::OverridePolicy::Strict;
        let strict_models_text = format_models_text_with_settings(&catalog, &strict_settings);
        assert!(strict_models_text.contains("[stack policy: strict]"), "got: {strict_models_text}");
        assert!(!strict_models_text.contains("claude-sonnet-4-6"), "got: {strict_models_text}");
        assert!(
            strict_models_text.contains("  (1 non-stack models hidden by strict policy)"),
            "got: {strict_models_text}"
        );
    }
}
