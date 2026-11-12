// Kite Code — Tickets Document Models & ID Helpers
// Domain types and pure ISO date formatting for ticket state

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketIssue {
    pub id: String,
    pub uuid: String,
    #[serde(default)]
    pub revision: i64,
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub state: String,
    pub priority: Value,
    pub assignee: Option<String>,
    pub delegate: Option<String>,
    pub project_id: Option<String>,
    pub parent_id: Option<String>,
    pub duplicate_of: Option<String>,
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default)]
    pub blocks: Vec<String>,
    #[serde(default)]
    pub related_to: Vec<String>,
    pub branch: Option<String>,
    pub due_date: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub archived_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketProject {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub revision: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketLabel {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub revision: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketComment {
    pub id: String,
    pub issue_id: String,
    pub parent_id: Option<String>,
    pub body: String,
    pub author: String,
    pub created_at: String,
    #[serde(default)]
    pub revision: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketHistoryEvent {
    pub id: String,
    pub issue_id: Option<String>,
    pub actor: String,
    pub action: String,
    pub created_at: String,
    #[serde(default)]
    pub changes: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketConnection {
    pub id: String,
    pub name: String,
    pub read_only: bool,
    pub created_at: String,
    pub revoked_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketDocument {
    pub schema_version: i64,
    pub revision: i64,
    pub issues: Vec<TicketIssue>,
    pub projects: Vec<TicketProject>,
    pub labels: Vec<TicketLabel>,
    pub comments: Vec<TicketComment>,
    pub history: Vec<TicketHistoryEvent>,
    pub connections: Vec<TicketConnection>,
}

pub fn now_iso() -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    format_iso(ms)
}

pub fn format_iso(ms: i64) -> String {
    let secs = if ms > 1_000_000_000_000 { ms / 1000 } else { ms };
    let days = (secs / 86400) as i64;
    let rem_secs = secs % 86400;
    let hours = rem_secs / 3600;
    let mins = (rem_secs % 3600) / 60;
    let s = rem_secs % 60;

    let z = days + 719468;
    let era = (if z >= 0 { z } else { z - 146096 }) / 146097;
    let doe = (z - era * 146097) as u32;
    let yoe = (doe - doe / 1024 + doe / 1461 - doe / 146096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, m, d, hours, mins, s)
}

pub fn next_issue_id(issues: &[TicketIssue]) -> String {
    let mut max_id = 100;
    for issue in issues {
        if let Some(num_str) = issue.id.strip_prefix("KITE-") {
            if let Ok(num) = num_str.parse::<i64>() {
                if num > max_id {
                    max_id = num;
                }
            }
        }
    }
    format!("KITE-{}", max_id + 1)
}
