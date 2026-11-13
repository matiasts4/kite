use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::chat::normalize::catalog_cache_key;
use crate::chat::utils::{binary_exists, resolve_bin};
use super::*;

/// `missing-binary` when the launcher is absent, `signed-out` when a known
/// auth file is absent, otherwise `ready`. An unknown sign-in signal stays
/// `ready` so the picker does not invent a signed-out state.
pub fn classify_catalog_availability(binary_present: bool, signed_in: Option<bool>) -> &'static str {
    if !binary_present {
        "missing-binary"
    } else if signed_in == Some(false) {
        "signed-out"
    } else {
        "ready"
    }
}

pub(super) fn provider_binary_present(canon: &str) -> bool {
    match canon {
        "antigravity" => binary_exists("agy") || binary_exists("antigravity"),
        "codex" => binary_exists("codex"),
        "cursor" => binary_exists("cursor") || binary_exists("agent"),
        "grok" => binary_exists("grok"),
        "opencode" => binary_exists("opencode"),
        "claude" => binary_exists("claude"),
        "gemini" => binary_exists("gemini"),
        _ => true,
    }
}

pub(super) fn provider_signed_in(canon: &str) -> Option<bool> {
    let home = crate::quota::utils::user_home_dir();
    match canon {
        "grok" => Some(
            home.join(".grok").join("auth.json").exists()
                || home.join(".grok").join("models_cache.json").exists(),
        ),
        "antigravity" => Some(crate::account_switcher::probe_live_provider_identity("agy").is_some()),
        "codex" => Some(home.join(".codex").join("auth.json").exists()),
        "claude" => Some(
            home.join(".claude.json").exists()
                || home.join(".claude").join(".credentials.json").exists(),
        ),
        "gemini" => Some(
            home.join(".gemini").join("oauth_creds.json").exists()
                || home.join(".gemini").join("google_accounts.json").exists(),
        ),
        _ => None,
    }
}

pub(super) fn catalog_payload(canon: &str, models: &[Value], cached: bool) -> Value {
    let state = if models.is_empty() {
        classify_catalog_availability(provider_binary_present(canon), provider_signed_in(canon))
    } else {
        "ready"
    };
    json!({
        "provider": canon,
        "models": models,
        "cached": cached,
        "catalogState": state,
    })
}

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

pub(super) fn models_cache_path() -> std::path::PathBuf {
    crate::persist::roaming_app_dir().join("provider_models_cache.json")
}

pub(super) fn now_unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub(super) fn load_provider_models_from_disk(provider: &str) -> Option<Vec<Value>> {
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

pub(super) fn save_provider_models_to_disk(provider: &str, models: &[Value]) {
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


/// Returns true when a cache key (plain provider, `"provider:suffix"`, or `"provider|conn"` from
/// `catalog_cache_key`) belongs to `provider`, normalizing `"agy"` <-> `"antigravity"` aliases.
pub(crate) fn provider_cache_key_matches(key: &str, provider: &str) -> bool {
    let k = key.trim().to_ascii_lowercase();
    let target = provider.trim().to_ascii_lowercase();
    let matches_single = |canon: &str| {
        k == canon
            || k.starts_with(&format!("{canon}:"))
            || k.starts_with(&format!("{canon}|"))
    };
    if target == "agy" || target == "antigravity" {
        matches_single("agy") || matches_single("antigravity")
    } else {
        matches_single(&target)
    }
}

/// Clears cached model catalogs for `provider` (including `"agy"` <-> `"antigravity"` aliases)
/// from memory and the given disk cache file so a newly activated account's models are discovered cleanly.
pub(crate) fn invalidate_provider_model_cache_in(path: &std::path::Path, provider: &str) {
    if let Ok(mut guard) = model_cache().lock() {
        guard.retain(|k, _| !provider_cache_key_matches(k, provider));
    }

    if let Ok(bytes) = std::fs::read(path) {
        if let Ok(mut root) = serde_json::from_slice::<Value>(&bytes) {
            if let Some(obj) = root.as_object_mut() {
                let before = obj.len();
                obj.retain(|k, _| !provider_cache_key_matches(k, provider));
                if obj.len() != before {
                    if let Ok(serialized) = serde_json::to_vec_pretty(&root) {
                        let _ = std::fs::write(path, serialized);
                    }
                }
            }
        }
    }
}

/// Clears cached model catalogs for `provider` (including `"agy"` <-> `"antigravity"` aliases)
/// from memory and disk so a newly activated account's models are discovered cleanly.
pub(crate) fn invalidate_provider_model_cache(provider: &str) {
    let path = models_cache_path();
    invalidate_provider_model_cache_in(&path, provider);
}

