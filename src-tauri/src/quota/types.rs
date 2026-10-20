use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;


#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaWindow {
    pub name: String,
    pub usage_percent: f64,
    pub remaining_fraction: f64,
    pub resets_at: Option<String>,
    pub time_until_reset_ms: Option<i64>,
    pub is_exhausted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderQuotaStatus {
    pub provider_id: String,
    pub display_name: String,
    pub is_available: bool,
    pub is_auth: bool,
    pub primary_usage_percent: f64,
    pub primary_remaining_percent: f64,
    pub primary_reset_at: Option<String>,
    pub time_until_reset_ms: Option<i64>,
    pub windows: Vec<QuotaWindow>,
    pub metadata: HashMap<String, Value>,
    pub last_updated_ms: i64,
    pub error: Option<String>,
}

