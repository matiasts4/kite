use crate::quota::types::ProviderQuotaStatus;
use crate::quota::utils::{now_ms, user_home_dir};
use crate::quota::{
    fetch_antigravity_quota, fetch_claude_quota, fetch_codex_quota, fetch_copilot_quota,
    fetch_cursor_quota, fetch_deepseek_quota, fetch_droid_quota, fetch_gemini_quota,
    fetch_grok_quota, fetch_kimi_quota, fetch_opencode_quota, fetch_qoder_quota,
};
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExhaustedQuotaAlert {
    pub provider_id: String,
    pub display_name: String,
    pub window_name: String,
    pub remaining_percent: f64,
    pub resets_at: Option<String>,
    pub time_until_reset_ms: Option<i64>,
    pub dedup_key: String,
}

#[cfg_attr(test, allow(dead_code))]
fn seen_exhausted_windows() -> &'static Mutex<HashSet<(String, String, Option<String>)>> {
    static CELL: OnceLock<Mutex<HashSet<(String, String, Option<String>)>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(HashSet::new()))
}

fn collect_new_exhausted_alerts_in(
    seen: &mut HashSet<(String, String, Option<String>)>,
    provider_id: &str,
    status: &ProviderQuotaStatus,
) -> Vec<ExhaustedQuotaAlert> {
    if !status.is_available || !status.is_auth {
        return Vec::new();
    }

    let exhausted_windows: Vec<(String, f64, Option<String>, Option<i64>)> =
        if status.windows.is_empty() {
            if status.primary_remaining_percent <= 0.0 {
                vec![(
                    status.display_name.clone(),
                    0.0,
                    status.primary_reset_at.clone(),
                    status.time_until_reset_ms,
                )]
            } else {
                Vec::new()
            }
        } else {
            status
                .windows
                .iter()
                .filter(|w| w.is_exhausted || w.remaining_fraction <= 0.0 || w.usage_percent >= 100.0)
                .map(|w| {
                    (
                        w.name.clone(),
                        (w.remaining_fraction * 100.0).clamp(0.0, 100.0).round(),
                        w.resets_at.clone(),
                        w.time_until_reset_ms,
                    )
                })
                .collect()
        };

    // Re-arm once a window recovers (> 0%) or advances to a new reset window.
    seen.retain(|(prov, win, rst)| {
        if prov != provider_id {
            return true;
        }
        exhausted_windows
            .iter()
            .any(|(ew, _, erst, _)| ew == win && erst == rst)
    });

    let mut alerts = Vec::new();
    for (window_name, remaining_percent, resets_at, time_until_reset_ms) in exhausted_windows {
        let key = (provider_id.to_string(), window_name.clone(), resets_at.clone());
        if seen.insert(key) {
            let dedup_key = format!(
                "{}:{}:{}",
                provider_id,
                window_name,
                resets_at.as_deref().unwrap_or("none")
            );
            alerts.push(ExhaustedQuotaAlert {
                provider_id: provider_id.to_string(),
                display_name: status.display_name.clone(),
                window_name,
                remaining_percent,
                resets_at,
                time_until_reset_ms,
                dedup_key,
            });
        }
    }
    alerts
}

#[cfg(not(test))]
fn publish_synced_quota_effects(synced_statuses: &[(String, ProviderQuotaStatus)]) {
    use tauri::Emitter;

    if synced_statuses.is_empty() {
        return;
    }

    let mut new_alerts = Vec::new();
    for (prov, status) in synced_statuses {
        crate::account_switcher::record_active_quota_snapshot_for_provider(prov, status);
        crate::account_switcher::auto_switch::on_fresh_quota_status(prov, status);

        if let Ok(mut guard) = seen_exhausted_windows().lock() {
            new_alerts.extend(collect_new_exhausted_alerts_in(&mut guard, prov, status));
        }
    }

    let app = crate::get_app_handle();
    for alert in &new_alerts {
        crate::notifications::upsert_model_quota_exhausted_notification(
            &alert.dedup_key,
            &alert.provider_id,
            &alert.display_name,
            &alert.window_name,
            alert.resets_at.as_deref(),
        );
        if let Some(app) = app.as_ref() {
            let _ = app.emit("kite://model-quota-exhausted", alert);
        }
    }

    if let Some(app) = app.as_ref() {
        let targets: Vec<&str> = synced_statuses.iter().map(|(p, _)| p.as_str()).collect();
        let updated_payload = build_cache_result(&targets);
        let _ = app.emit("kite://subscription-quotas-updated", updated_payload);
    }
}

struct QuotaCache {
    entries: HashMap<String, (Instant, ProviderQuotaStatus)>,
    epochs: HashMap<String, u64>,
}

impl QuotaCache {
    fn open() -> Self {
        Self {
            entries: load_persisted_cache(),
            epochs: HashMap::new(),
        }
    }
}

fn bump_epoch_in_cache(cache: &mut QuotaCache, provider: &str) -> u64 {
    let next = cache
        .epochs
        .get(provider)
        .copied()
        .unwrap_or(0)
        .wrapping_add(1)
        .max(1);
    cache.epochs.insert(provider.to_string(), next);
    next
}

fn commit_swr_results_if_epoch_matches(
    cache: &mut QuotaCache,
    results: Vec<(String, u64, ProviderQuotaStatus)>,
) -> Vec<String> {
    let mut updated = Vec::new();
    for (p, captured_epoch, status) in results {
        let current_epoch = cache.epochs.get(&p).copied().unwrap_or(0);
        if current_epoch != captured_epoch {
            continue;
        }
        cache.entries.insert(p.clone(), (Instant::now(), status));
        updated.push(p);
    }
    updated
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
    let now = now_ms();
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
                let ttl_ms = (cache_ttl_secs(&k) * 1000) as i64;
                let age_ms = now.saturating_sub(v.last_updated_ms);
                if age_ms >= 0 && age_ms < ttl_ms {
                    let instant = Instant::now()
                        .checked_sub(Duration::from_millis(age_ms as u64))
                        .unwrap_or_else(Instant::now);
                    map.insert(k, (instant, v));
                }
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
        *cache_guard = Some(QuotaCache::open());
    }
    let cache = cache_guard.as_ref()?;
    let (cached_instant, s) = cache.entries.get(provider)?;
    if cached_instant.elapsed() > Duration::from_secs(cache_ttl_secs(provider)) {
        return None;
    }
    Some(s.clone())
}

pub fn invalidate_provider_cache(provider: &str) {
    if let Ok(mut cache_guard) = CACHE.lock() {
        if cache_guard.is_none() {
            *cache_guard = Some(QuotaCache::open());
        }
        if let Some(ref mut cache) = *cache_guard {
            cache.entries.remove(provider);
            bump_epoch_in_cache(cache, provider);
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
    tauri::async_runtime::spawn_blocking(move || get_subscription_quotas_direct(request, force))
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
            *cache_guard = Some(QuotaCache::open());
        }
    }

    let mut to_fetch_epochs: Vec<(String, u64)> = Vec::new();
    {
        let mut cache_guard = CACHE.lock().unwrap();
        let cache = cache_guard.as_mut().unwrap();

        for &p in &target_providers {
            let needs_fetch = if is_force {
                true
            } else if let Some((fetched_at, _)) = cache.entries.get(p) {
                fetched_at.elapsed() > Duration::from_secs(cache_ttl_secs(p))
            } else {
                true
            };

            if needs_fetch {
                let epoch = if is_force {
                    bump_epoch_in_cache(cache, p)
                } else {
                    cache.epochs.get(p).copied().unwrap_or(0)
                };
                to_fetch_epochs.push((p.to_string(), epoch));
            }
        }
    }

    // Stale-While-Revalidate: ALWAYS return immediately if not forced, refresh in background
    if !is_force {
        if !to_fetch_epochs.is_empty() {
            if !IS_REFRESHING.swap(true, std::sync::atomic::Ordering::SeqCst) {
                std::thread::spawn(move || {
                    struct RefreshingResetGuard;
                    impl Drop for RefreshingResetGuard {
                        fn drop(&mut self) {
                            IS_REFRESHING.store(false, std::sync::atomic::Ordering::SeqCst);
                        }
                    }
                    let _reset_guard = RefreshingResetGuard;

                    let fresh_entries: Vec<(String, u64, ProviderQuotaStatus)> =
                        std::thread::scope(|s| {
                        let handles: Vec<_> = to_fetch_epochs
                            .into_iter()
                            .map(|(p, epoch)| {
                                s.spawn(move || {
                                    let status = fetch_single_provider(&p);
                                    (p, epoch, status)
                                })
                            })
                            .collect();

                        handles
                            .into_iter()
                            .filter_map(|handle| handle.join().ok())
                            .collect()
                    });

                    #[cfg_attr(test, allow(unused_variables, unused_assignments))]
                    let mut updated_providers: Vec<String> = Vec::new();
                    #[cfg_attr(test, allow(unused_variables, unused_mut))]
                    let mut synced_statuses: Vec<(String, ProviderQuotaStatus)> = Vec::new();
                    if let Ok(mut guard) = CACHE.lock() {
                        if let Some(cache) = guard.as_mut() {
                            updated_providers =
                                commit_swr_results_if_epoch_matches(cache, fresh_entries);
                            if !updated_providers.is_empty() {
                                save_persisted_cache(cache);
                                for prov in &updated_providers {
                                    if let Some((_, status)) = cache.entries.get(prov) {
                                        synced_statuses.push((prov.clone(), status.clone()));
                                    }
                                }
                            }
                        }
                    }
                    drop(_reset_guard);

                    #[cfg(not(test))]
                    publish_synced_quota_effects(&synced_statuses);
                });
            }
        }
        return build_cache_result(&target_providers);
    }

    // Synchronous fetch only when explicitly forced by user (e.g. Refresh button clicked or unit tests)
    if !to_fetch_epochs.is_empty() {
        let mut newly_fetched: Vec<(String, u64, ProviderQuotaStatus)> = Vec::new();
        std::thread::scope(|s| {
            let mut handles = Vec::new();
            for (p, epoch) in &to_fetch_epochs {
                let epoch = *epoch;
                let handle = s.spawn(move || {
                    let status = fetch_single_provider(p);
                    (p.clone(), epoch, status)
                });
                handles.push(handle);
            }

            for handle in handles {
                if let Ok((p, epoch, status)) = handle.join() {
                    newly_fetched.push((p, epoch, status));
                }
            }
        });

        #[cfg_attr(test, allow(unused_variables))]
        let mut synced_statuses: Vec<(String, ProviderQuotaStatus)> = Vec::new();
        {
            let mut cache_guard = CACHE.lock().unwrap();
            if let Some(cache) = cache_guard.as_mut() {
                let updated_providers =
                    commit_swr_results_if_epoch_matches(cache, newly_fetched);
                if !updated_providers.is_empty() {
                    save_persisted_cache(cache);
                    for prov in &updated_providers {
                        if let Some((_, status)) = cache.entries.get(prov) {
                            synced_statuses.push((prov.clone(), status.clone()));
                        }
                    }
                }
            }
        }
        #[cfg(not(test))]
        publish_synced_quota_effects(&synced_statuses);
    }

    build_cache_result(&target_providers)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_swr_stale_epoch_writer_skips_insert_after_invalidation() {
        let mut cache = QuotaCache {
            entries: HashMap::new(),
            epochs: HashMap::new(),
        };
        cache.epochs.insert("antigravity".to_string(), 1);

        let captured_epoch = cache.epochs.get("antigravity").copied().unwrap_or(0);
        // Simulate account switch bumping the provider epoch while SWR was fetching
        bump_epoch_in_cache(&mut cache, "antigravity");

        let mut stale_status = default_provider_status("antigravity");
        stale_status.is_auth = true;
        stale_status.metadata.insert("email".to_string(), serde_json::json!("old@example.com"));

        let inserted = commit_swr_results_if_epoch_matches(
            &mut cache,
            vec![("antigravity".to_string(), captured_epoch, stale_status)],
        );
        assert!(inserted.is_empty(), "stale SWR fetch must be discarded after invalidation");
        assert!(!cache.entries.contains_key("antigravity"));
    }

    #[test]
    fn test_collect_new_exhausted_alerts_dedupes_same_reset_window_and_rearms() {
        let mut seen: HashSet<(String, String, Option<String>)> = HashSet::new();
        let mut status = default_provider_status("antigravity");
        status.is_available = true;
        status.is_auth = true;
        status.primary_remaining_percent = 73.0;
        status.windows = vec![
            crate::quota::types::QuotaWindow {
                name: "Gemini Models (Five Hour)".to_string(),
                usage_percent: 27.0,
                remaining_fraction: 0.73,
                resets_at: Some("2026-11-16T23:00:00Z".to_string()),
                time_until_reset_ms: Some(1_000),
                is_exhausted: false,
            },
            crate::quota::types::QuotaWindow {
                name: "Gemini 4 Argon (Gemini 4 Argon Weekly Limit)".to_string(),
                usage_percent: 100.0,
                remaining_fraction: 0.0,
                resets_at: Some("2026-11-22T05:16:50Z".to_string()),
                time_until_reset_ms: Some(500_000),
                is_exhausted: true,
            },
        ];

        let first = collect_new_exhausted_alerts_in(&mut seen, "antigravity", &status);
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].window_name, "Gemini 4 Argon (Gemini 4 Argon Weekly Limit)");

        // Repeating the same exhausted window with the same reset timestamp must NOT re-alert.
        let second = collect_new_exhausted_alerts_in(&mut seen, "antigravity", &status);
        assert!(second.is_empty());

        // Recovery clears the armed entry so a future drop to 0% alerts again.
        status.windows[1].is_exhausted = false;
        status.windows[1].remaining_fraction = 1.0;
        assert!(collect_new_exhausted_alerts_in(&mut seen, "antigravity", &status).is_empty());

        status.windows[1].is_exhausted = true;
        status.windows[1].remaining_fraction = 0.0;
        status.windows[1].resets_at = Some("2026-11-29T05:16:50Z".to_string());
        let rearmed = collect_new_exhausted_alerts_in(&mut seen, "antigravity", &status);
        assert_eq!(rearmed.len(), 1);
    }
}
