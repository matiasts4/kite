use crate::quota::antigravity::enrich_google_identity;
use crate::quota::types::ProviderQuotaStatus;
use crate::quota::utils::{now_ms, user_home_dir};
use serde_json::json;
use std::collections::HashMap;
use std::path::PathBuf;

pub fn fetch_gemini_quota() -> ProviderQuotaStatus {
    let home = user_home_dir();
    let gemini_dir = home.join(".gemini");
    let has_key = crate::credentials::resolve_provider_key("gemini").is_some();
    let is_avail = gemini_dir.exists() || has_key;
    let mut status = ProviderQuotaStatus {
        provider_id: "gemini".to_string(),
        display_name: "Gemini CLI".to_string(),
        is_available: is_avail,
        is_auth: is_avail,
        primary_usage_percent: 0.0,
        primary_remaining_percent: 100.0,
        primary_reset_at: None,
        time_until_reset_ms: None,
        windows: Vec::new(),
        metadata: HashMap::new(),
        last_updated_ms: now_ms(),
        error: if is_avail { None } else { Some("Google Gemini credentials no detectadas".to_string()) },
    };
    if is_avail {
        status.metadata.insert("source".to_string(), json!("~/.gemini/"));
        status.metadata.insert("note".to_string(), json!("Detectado localmente"));
        enrich_google_identity(&mut status);
    }
    status
}

