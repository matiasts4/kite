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
fn publish_synced_quota_effects(
    fresh_statuses: &[(String, ProviderQuotaStatus)],
    updated_providers: &[String],
) {
    use tauri::Emitter;

    if fresh_statuses.is_empty() && updated_providers.is_empty() {
        return;
    }

    let mut new_alerts = Vec::new();
    for (prov, status) in fresh_statuses {
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
        if !updated_providers.is_empty() {
            let targets: Vec<&str> = updated_providers.iter().map(|p| p.as_str()).collect();
            let updated_payload = build_cache_result(&targets);
            let _ = app.emit("kite://subscription-quotas-updated", updated_payload);
        }
    }
}

struct QuotaCache {
    entries: HashMap<String, (Option<Instant>, ProviderQuotaStatus)>,
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

fn has_usable_quota_data(status: &ProviderQuotaStatus) -> bool {
    status.is_available && status.is_auth && status.error.is_none()
}

fn is_usable_quota_update(
    prev: Option<&ProviderQuotaStatus>,
    incoming: &ProviderQuotaStatus,
) -> bool {
    if !has_usable_quota_data(incoming) {
        return false;
    }
    if let Some(previous) = prev {
        if !previous.windows.is_empty()
            && incoming.windows.is_empty()
            && !incoming.metadata.contains_key("note")
        {
            return false;
        }
    }
    true
}

fn merge_quota_status(
    prev: Option<&ProviderQuotaStatus>,
    incoming: ProviderQuotaStatus,
    now: i64,
) -> (ProviderQuotaStatus, bool) {
    if let Some(previous) = prev.filter(|p| has_usable_quota_data(p)) {
        if !is_usable_quota_update(Some(previous), &incoming) {
            let mut preserved = previous.clone();
            let err_msg = incoming
                .error
                .unwrap_or_else(|| "No se pudo obtener respuesta al actualizar la cuota".to_string());
            preserved
                .metadata
                .insert("lastRefreshError".to_string(), serde_json::json!(err_msg));
            preserved
                .metadata
                .insert("lastRefreshErrorAtMs".to_string(), serde_json::json!(now));
            return (preserved, false);
        }
    }
    (incoming, true)
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

fn commit_swr_results_with_freshness(
    cache: &mut QuotaCache,
    results: Vec<(String, u64, ProviderQuotaStatus)>,
) -> (Vec<String>, Vec<String>) {
    let mut updated = Vec::new();
    let mut fresh = Vec::new();
    let now = now_ms();
    for (p, captured_epoch, status) in results {
        let current_epoch = cache.epochs.get(&p).copied().unwrap_or(0);
        if current_epoch != captured_epoch {
            continue;
        }
        let prev = cache.entries.get(&p).map(|(_, s)| s);
        let (mut merged, is_fresh) = merge_quota_status(prev, status, now);
        if is_fresh {
            merged.metadata.remove("lastRefreshError");
            merged.metadata.remove("lastRefreshErrorAtMs");
            fresh.push(p.clone());
        }
        cache.entries.insert(p.clone(), (Some(Instant::now()), merged));
        updated.push(p);
    }
    (updated, fresh)
}

#[cfg_attr(not(test), allow(dead_code))]
fn commit_swr_results_if_epoch_matches(
    cache: &mut QuotaCache,
    results: Vec<(String, u64, ProviderQuotaStatus)>,
) -> Vec<String> {
    commit_swr_results_with_freshness(cache, results).0
}

static CACHE: Mutex<Option<QuotaCache>> = Mutex::new(None);
const CACHE_TTL_SECS: u64 = 180;
// OpenCode Go exposes short-lived 5-hour windows; refresh it more aggressively.
const OPENCODE_CACHE_TTL_SECS: u64 = 60;
const FAILED_RETRY_SECS: u64 = 30;

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

fn parse_persisted_cache_bytes(
    data: &[u8],
    now: i64,
) -> HashMap<String, (Option<Instant>, ProviderQuotaStatus)> {
    let mut map = HashMap::new();
    if let Ok(saved) = serde_json::from_slice::<HashMap<String, ProviderQuotaStatus>>(data) {
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
            if age_ms >= 0 && age_ms < ttl_ms && !v.metadata.contains_key("lastRefreshError") {
                let instant = Instant::now().checked_sub(Duration::from_millis(age_ms as u64));
                map.insert(k, (instant, v));
            } else if has_usable_quota_data(&v) {
                // Keep the last usable snapshot past TTL so SWR serves it immediately
                // while refreshing in the background instead of blanking out on failure.
                map.insert(k, (None, v));
            }
        }
    }
    map
}

fn load_persisted_cache() -> HashMap<String, (Option<Instant>, ProviderQuotaStatus)> {
    let p = quota_cache_path();
    let Ok(data) = std::fs::read(&p) else {
        return HashMap::new();
    };
    parse_persisted_cache_bytes(&data, now_ms())
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
    let (Some(cached_instant), s) = cache.entries.get(provider)? else {
        return None;
    };
    if s.metadata.contains_key("lastRefreshError") || s.error.is_some() {
        return None;
    }
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
            } else if let Some((Some(fetched_at), status)) = cache.entries.get(p) {
                let max_age_secs = if status.metadata.contains_key("lastRefreshError") {
                    FAILED_RETRY_SECS
                } else {
                    cache_ttl_secs(p)
                };
                fetched_at.elapsed() > Duration::from_secs(max_age_secs)
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

                    let (updated_providers, fresh_statuses) = commit_entries_to_cache(fresh_entries);
                    drop(_reset_guard);

                    #[cfg(not(test))]
                    publish_synced_quota_effects(&fresh_statuses, &updated_providers);
                    #[cfg(test)]
                    let _ = (updated_providers, fresh_statuses);
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

        let (updated_providers, fresh_statuses) = commit_entries_to_cache(newly_fetched);
        #[cfg(not(test))]
        publish_synced_quota_effects(&fresh_statuses, &updated_providers);
        #[cfg(test)]
        let _ = (updated_providers, fresh_statuses);
    }

    build_cache_result(&target_providers)
}

fn commit_entries_to_cache(
    entries: Vec<(String, u64, ProviderQuotaStatus)>,
) -> (Vec<String>, Vec<(String, ProviderQuotaStatus)>) {
    let mut updated_providers: Vec<String> = Vec::new();
    let mut fresh_statuses: Vec<(String, ProviderQuotaStatus)> = Vec::new();
    if let Ok(mut guard) = CACHE.lock() {
        if let Some(cache) = guard.as_mut() {
            let (updated, fresh) = commit_swr_results_with_freshness(cache, entries);
            updated_providers = updated;
            if !updated_providers.is_empty() {
                save_persisted_cache(cache);
                for prov in &fresh {
                    if let Some((_, status)) = cache.entries.get(prov) {
                        fresh_statuses.push((prov.clone(), status.clone()));
                    }
                }
            }
        }
    }
    (updated_providers, fresh_statuses)
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

    #[test]
    fn test_failed_refresh_preserves_last_valid_quota_and_records_refresh_error() {
        let mut cache = QuotaCache {
            entries: HashMap::new(),
            epochs: HashMap::new(),
        };
        let mut valid_status = default_provider_status("antigravity");
        valid_status.is_available = true;
        valid_status.is_auth = true;
        valid_status.primary_usage_percent = 28.0;
        valid_status.primary_remaining_percent = 72.0;
        valid_status.last_updated_ms = 1_000_000;
        valid_status
            .metadata
            .insert("email".to_string(), serde_json::json!("user@example.com"));
        valid_status.windows = vec![crate::quota::types::QuotaWindow {
            name: "Gemini Models (Five Hour)".to_string(),
            usage_percent: 28.0,
            remaining_fraction: 0.72,
            resets_at: Some("2026-11-17T22:00:00Z".to_string()),
            time_until_reset_ms: Some(300_000),
            is_exhausted: false,
        }];
        cache
            .entries
            .insert("antigravity".to_string(), (Some(Instant::now()), valid_status));

        let mut failed_status = default_provider_status("antigravity");
        failed_status.is_available = false;
        failed_status.is_auth = false;
        failed_status.error = Some("CLI de Antigravity (agy) no respondió".to_string());
        failed_status.last_updated_ms = 2_000_000;

        let (updated, fresh) = commit_swr_results_with_freshness(
            &mut cache,
            vec![("antigravity".to_string(), 0, failed_status)],
        );

        assert_eq!(updated, vec!["antigravity".to_string()]);
        assert!(
            fresh.is_empty(),
            "preserved fallback must NOT trigger fresh-quota effects like auto-switch or alerts"
        );

        let (_, preserved) = cache
            .entries
            .get("antigravity")
            .expect("cached entry must remain present");
        assert!(preserved.is_available);
        assert!(preserved.is_auth);
        assert_eq!(preserved.primary_remaining_percent, 72.0);
        assert_eq!(preserved.windows.len(), 1);
        assert_eq!(preserved.last_updated_ms, 1_000_000);
        assert_eq!(preserved.error, None);
        assert_eq!(
            preserved.metadata.get("email").and_then(|v| v.as_str()),
            Some("user@example.com")
        );
        assert_eq!(
            preserved
                .metadata
                .get("lastRefreshError")
                .and_then(|v| v.as_str()),
            Some("CLI de Antigravity (agy) no respondió")
        );
        assert!(preserved
            .metadata
            .get("lastRefreshErrorAtMs")
            .and_then(|v| v.as_i64())
            .is_some());
    }

    #[test]
    fn test_successful_refresh_clears_previous_refresh_error() {
        let mut cache = QuotaCache {
            entries: HashMap::new(),
            epochs: HashMap::new(),
        };
        let mut stale_with_err = default_provider_status("codex");
        stale_with_err.is_available = true;
        stale_with_err.is_auth = true;
        stale_with_err.primary_remaining_percent = 70.0;
        stale_with_err.last_updated_ms = 1_000_000;
        stale_with_err.windows = vec![crate::quota::types::QuotaWindow {
            name: "5-Hour Session".to_string(),
            usage_percent: 30.0,
            remaining_fraction: 0.70,
            resets_at: None,
            time_until_reset_ms: None,
            is_exhausted: false,
        }];
        stale_with_err.metadata.insert(
            "lastRefreshError".to_string(),
            serde_json::json!("Timeout"),
        );
        stale_with_err
            .metadata
            .insert("lastRefreshErrorAtMs".to_string(), serde_json::json!(1_500_000));
        cache
            .entries
            .insert("codex".to_string(), (Some(Instant::now()), stale_with_err));

        let mut fresh_status = default_provider_status("codex");
        fresh_status.is_available = true;
        fresh_status.is_auth = true;
        fresh_status.primary_usage_percent = 35.0;
        fresh_status.primary_remaining_percent = 65.0;
        fresh_status.last_updated_ms = 2_000_000;
        fresh_status.windows = vec![crate::quota::types::QuotaWindow {
            name: "5-Hour Session".to_string(),
            usage_percent: 35.0,
            remaining_fraction: 0.65,
            resets_at: None,
            time_until_reset_ms: None,
            is_exhausted: false,
        }];

        let (updated, fresh) = commit_swr_results_with_freshness(
            &mut cache,
            vec![("codex".to_string(), 0, fresh_status)],
        );

        assert_eq!(updated, vec!["codex".to_string()]);
        assert_eq!(fresh, vec!["codex".to_string()]);
        let (_, current) = cache.entries.get("codex").unwrap();
        assert_eq!(current.primary_remaining_percent, 65.0);
        assert_eq!(current.last_updated_ms, 2_000_000);
        assert!(!current.metadata.contains_key("lastRefreshError"));
        assert!(!current.metadata.contains_key("lastRefreshErrorAtMs"));
    }

    #[test]
    fn test_load_persisted_cache_preserves_expired_valid_entries_for_swr() {
        let mut stale_valid = default_provider_status("claude");
        stale_valid.is_available = true;
        stale_valid.is_auth = true;
        stale_valid.primary_usage_percent = 22.0;
        stale_valid.primary_remaining_percent = 78.0;
        stale_valid.last_updated_ms = 1_000_000;
        stale_valid.windows = vec![crate::quota::types::QuotaWindow {
            name: "5-Hour Limit".to_string(),
            usage_percent: 22.0,
            remaining_fraction: 0.78,
            resets_at: None,
            time_until_reset_ms: None,
            is_exhausted: false,
        }];

        let mut map = HashMap::new();
        map.insert("claude".to_string(), stale_valid);
        let bytes = serde_json::to_vec(&map).unwrap();

        // Simulate startup 1 hour later (well past CACHE_TTL_SECS)
        let loaded = parse_persisted_cache_bytes(&bytes, 1_000_000 + 3_600_000);
        let (instant_opt, entry) = loaded
            .get("claude")
            .expect("expired valid entry must still hydrate for SWR");
        assert!(
            instant_opt.is_none(),
            "expired persisted entry must be marked stale (None) so SWR triggers refresh"
        );
        assert_eq!(entry.primary_remaining_percent, 78.0);
        assert_eq!(entry.windows.len(), 1);
    }
}
