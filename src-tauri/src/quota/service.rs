use crate::quota::types::ProviderQuotaStatus;
use crate::quota::utils::{now_ms, user_home_dir};
use crate::quota::{
    fetch_antigravity_quota, fetch_claude_quota, fetch_codex_quota, fetch_copilot_quota,
    fetch_cursor_quota, fetch_deepseek_quota, fetch_droid_quota, fetch_gemini_quota,
    fetch_grok_quota, fetch_kimi_quota, fetch_opencode_quota, fetch_qoder_quota,
};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

struct QuotaCache {
    entries: HashMap<String, (Instant, ProviderQuotaStatus)>,
}

static CACHE: Mutex<Option<QuotaCache>> = Mutex::new(None);
const CACHE_TTL_SECS: u64 = 180;
// OpenCode Go exposes short-lived 5-hour windows; refresh it more aggressively.
const OPENCODE_CACHE_TTL_SECS: u64 = 60;

fn cache_ttl_secs(provider: &str) -> u64 {
    if provider == "opencode" {
        OPENCODE_CACHE_TTL_SECS
    } else {
        CACHE_TTL_SECS
    }
}
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
                // Drop pre-v2 OpenCode entries: they reported a fake 0% without calling the API.
                if k == "opencode"
                    && v.metadata
                        .get("quotaSchema")
                        .and_then(|value| value.as_i64())
                        != Some(2)
                {
                    continue;
                }
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

pub fn invalidate_provider_cache(provider: &str) {
    if let Ok(mut cache_guard) = CACHE.lock() {
        if cache_guard.is_none() {
            *cache_guard = Some(QuotaCache {
                entries: load_persisted_cache(),
            });
        }
        if let Some(ref mut cache) = *cache_guard {
            cache.entries.remove(provider);
            save_persisted_cache(cache);
        }
    }
}


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
        "opencode" => "OpenCode Go",
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
pub async fn get_subscription_quotas(request: Option<Value>, force: Option<bool>) -> Value {
    tokio::task::spawn_blocking(move || {
        get_subscription_quotas_direct(request, force)
    })
    .await
    .unwrap_or_else(|_| Value::Object(serde_json::Map::new()))
}

pub fn get_subscription_quotas_direct(request: Option<Value>, force: Option<bool>) -> Value {
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
                fetched_at.elapsed() > Duration::from_secs(cache_ttl_secs(p))
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
