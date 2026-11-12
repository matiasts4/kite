use super::registry::canon_provider;

pub(crate) struct LiveQuota {
    pub(crate) percent: f64,
    pub(crate) reset_at: Option<String>,
    pub(crate) until_ms: Option<i64>,
    pub(crate) email: Option<String>,
    pub(crate) plan: Option<String>,
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
    Some(LiveQuota {
        percent: q.primary_remaining_percent,
        reset_at: q.primary_reset_at,
        until_ms: q.time_until_reset_ms,
        email: q.metadata.get("email").and_then(|v| v.as_str()).map(String::from),
        plan: q.metadata.get("planType").and_then(|v| v.as_str()).map(String::from),
    })
}
