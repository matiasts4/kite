use crate::quota::types::ProviderQuotaStatus;
use crate::quota::utils::{b64url_decode, now_ms, user_home_dir};
use serde_json::{json, Value};
use std::collections::HashMap;

pub(crate) fn enrich_gemini_cli_identity(status: &mut ProviderQuotaStatus) {
    let home = user_home_dir();
    let creds_file = home.join(".gemini").join("oauth_creds.json");
    if let Ok(data) = std::fs::read(&creds_file) {
        if let Ok(val) = serde_json::from_slice::<Value>(&data) {
            if let Some(id_token) = val.get("id_token").and_then(|v| v.as_str()) {
                let parts: Vec<&str> = id_token.split('.').collect();
                if parts.len() >= 2 {
                    if let Some(payload_bytes) = b64url_decode(parts[1]) {
                        if let Ok(jwt_json) = serde_json::from_slice::<Value>(&payload_bytes) {
                            if let Some(email) = jwt_json.get("email").and_then(|v| v.as_str()) {
                                status.metadata.insert("email".to_string(), json!(email));
                                status.metadata.insert("accountSource".to_string(), json!("oauth_creds.json"));
                            }
                            if !status.metadata.contains_key("userName") {
                                if let Some(name) = jwt_json.get("name").and_then(|v| v.as_str()) {
                                    status.metadata.insert("userName".to_string(), json!(name));
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if !status.metadata.contains_key("email") {
        let accounts_file = home.join(".gemini").join("google_accounts.json");
        if let Ok(data) = std::fs::read(&accounts_file) {
            if let Ok(val) = serde_json::from_slice::<Value>(&data) {
                if let Some(active_email) = val.get("active").and_then(|v| v.as_str()) {
                    if !active_email.trim().is_empty() {
                        status.metadata.insert("email".to_string(), json!(active_email.trim()));
                        status.metadata.insert("accountSource".to_string(), json!("google_accounts.json"));
                    }
                }
            }
        }
    }

    if !status.metadata.contains_key("planType") {
        status.metadata.insert("planType".to_string(), json!("Google Gemini"));
    }
}

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
        enrich_gemini_cli_identity(&mut status);
    }
    status
}
