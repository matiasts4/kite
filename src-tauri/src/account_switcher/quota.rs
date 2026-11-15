use super::registry::{canon_provider, now_ms, CachedQuotaWindow};

#[derive(Debug, Clone)]
pub(crate) struct LiveQuota {
    pub(crate) percent: f64,
    pub(crate) reset_at: Option<String>,
    pub(crate) until_ms: Option<i64>,
    pub(crate) email: Option<String>,
    pub(crate) plan: Option<String>,
    pub(crate) windows: Vec<CachedQuotaWindow>,
}

pub(crate) fn live_quota_from_status(q: &crate::quota::ProviderQuotaStatus) -> LiveQuota {
    let updated_at = if q.last_updated_ms > 0 { q.last_updated_ms } else { now_ms() };
    let windows = q
        .windows
        .iter()
        .map(|w| CachedQuotaWindow {
            name: w.name.clone(),
            remaining_percent: (w.remaining_fraction * 100.0).clamp(0.0, 100.0),
            is_exhausted: w.is_exhausted,
            resets_at: w.resets_at.clone(),
            time_until_reset_ms: w.time_until_reset_ms,
            updated_at_unix_ms: updated_at,
        })
        .collect();

    LiveQuota {
        percent: q.primary_remaining_percent,
        reset_at: q.primary_reset_at.clone(),
        until_ms: q.time_until_reset_ms,
        email: q
            .metadata
            .get("email")
            .and_then(|v| v.as_str())
            .map(String::from),
        plan: q
            .metadata
            .get("planType")
            .and_then(|v| v.as_str())
            .map(String::from),
        windows,
    }
}

pub(crate) fn get_cached_live_quota(provider: &str) -> Option<LiveQuota> {
    let canon = canon_provider(provider);
    let key = match canon.as_str() {
        "agy" => "antigravity",
        other => other,
    };
    let q = crate::quota::get_cached_provider_status(key)?;
    if !q.is_available {
        return None;
    }
    Some(live_quota_from_status(&q))
}
