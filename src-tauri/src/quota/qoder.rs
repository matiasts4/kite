use crate::quota::types::{ProviderQuotaStatus, QuotaWindow};
use crate::quota::utils::{format_unix_to_rfc3339, now_ms, user_home_dir};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

fn parse_qoder_log_tail(path: &std::path::Path) -> Option<(Value, Option<String>)> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path).ok()?;
    let meta = file.metadata().ok()?;
    let file_len = meta.len();
    let max_tail: u64 = 256 * 1024;
    let start_pos = if file_len > max_tail { file_len - max_tail } else { 0 };
    file.seek(SeekFrom::Start(start_pos)).ok()?;

    let mut buffer = Vec::new();
    file.read_to_end(&mut buffer).ok()?;
    let content = String::from_utf8_lossy(&buffer);

    for line in content.lines().rev() {
        if line.contains("[qoderApi]") && line.contains("quota/usage response:") {
            if let Some(pos) = line.find('{') {
                let json_slice = &line[pos..];
                if let Ok(val) = serde_json::from_str::<Value>(json_slice) {
                    let ts = line.split_whitespace().next().map(|s| s.to_string());
                    return Some((val, ts));
                }
            }
        }
    }
    None
}

pub fn fetch_qoder_quota() -> ProviderQuotaStatus {
    let mut status = ProviderQuotaStatus {
        provider_id: "qoder".to_string(),
        display_name: "Qoder".to_string(),
        is_available: false,
        is_auth: false,
        primary_usage_percent: 0.0,
        primary_remaining_percent: 100.0,
        primary_reset_at: None,
        time_until_reset_ms: None,
        windows: Vec::new(),
        metadata: HashMap::new(),
        last_updated_ms: now_ms(),
        error: None,
    };

    let home = user_home_dir();
    let qoder_dir = home.join(".qoder");
    let runs_dir = qoder_dir.join("logs").join("runs");

    if !qoder_dir.exists() {
        status.error = Some("Qoder no encontrado (~/.qoder)".to_string());
        return status;
    }

    status.is_available = true;

    if !runs_dir.exists() {
        status.error = Some("No se encontraron registros de Qoder en ~/.qoder/logs/runs".to_string());
        return status;
    }

    let mut log_files: Vec<(PathBuf, SystemTime)> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&runs_dir) {
        for entry in entries.flatten() {
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                let log_file = entry.path().join("qodercli.log");
                if log_file.exists() {
                    if let Ok(meta) = log_file.metadata() {
                        let mtime = meta.modified().unwrap_or(UNIX_EPOCH);
                        log_files.push((log_file, mtime));
                    }
                }
            }
        }
    }

    log_files.sort_by(|a, b| b.1.cmp(&a.1));

    let mut found: Option<(Value, Option<String>)> = None;
    for (file_path, _) in log_files.iter().take(60) {
        if let Some(res) = parse_qoder_log_tail(file_path) {
            found = Some(res);
            break;
        }
    }

    let (payload, timestamp) = match found {
        Some(p) => p,
        None => {
            status.error = Some("No se encontraron datos de cuota en logs de Qoder. Ejecuta 'qodercli'.".to_string());
            return status;
        }
    };

    status.is_auth = true;

    let expires_at_num = payload.get("expiresAt").and_then(|v| v.as_i64()).unwrap_or(0);
    let mut reset_at: Option<String> = None;
    let mut reset_ms: Option<i64> = None;

    if expires_at_num > 0 && expires_at_num < 4102444800000 {
        reset_at = Some(format_unix_to_rfc3339(expires_at_num));
        let ms = (expires_at_num - now_ms()).max(0);
        reset_ms = Some(ms);
    }

    let mut plan_usage = 0.0f64;
    if let Some(plan_quota) = payload.get("userQuota") {
        let total = plan_quota.get("total").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let used = plan_quota.get("used").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let pct = if total > 0.0 {
            (used / total * 100.0).clamp(0.0, 100.0)
        } else {
            plan_quota.get("percentage").and_then(|v| v.as_f64()).map(|p| if p <= 1.0 { p * 100.0 } else { p }).unwrap_or(0.0)
        };
        plan_usage = pct;
        status.windows.push(QuotaWindow {
            name: "Plan credits".to_string(),
            usage_percent: (pct * 10.0).round() / 10.0,
            remaining_fraction: ((100.0 - pct) / 100.0).clamp(0.0, 1.0),
            resets_at: reset_at.clone(),
            time_until_reset_ms: reset_ms,
            is_exhausted: pct >= 100.0,
        });

        status.metadata.insert("planCredits".to_string(), json!({
            "total": total,
            "used": used,
            "remaining": (total - used).max(0.0),
        }));
    }

    if let Some(addon) = payload.get("addOnQuota") {
        let total = addon.get("total").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let used = addon.get("used").and_then(|v| v.as_f64()).unwrap_or(0.0);
        if total > 0.0 {
            let pct = (used / total * 100.0).clamp(0.0, 100.0);
            status.windows.push(QuotaWindow {
                name: "Add-on credits".to_string(),
                usage_percent: (pct * 10.0).round() / 10.0,
                remaining_fraction: ((100.0 - pct) / 100.0).clamp(0.0, 1.0),
                resets_at: None,
                time_until_reset_ms: None,
                is_exhausted: pct >= 100.0,
            });
            status.metadata.insert("addOnCredits".to_string(), json!({
                "total": total,
                "used": used,
                "remaining": (total - used).max(0.0),
            }));
        }
    }

    let primary_usage = payload
        .get("totalUsagePercentage")
        .and_then(|v| v.as_f64())
        .map(|p| if p <= 1.0 { p * 100.0 } else { p })
        .unwrap_or(plan_usage);

    status.primary_usage_percent = (primary_usage * 10.0).round() / 10.0;
    status.primary_remaining_percent = ((100.0 - primary_usage) * 10.0).round() / 10.0;
    status.primary_reset_at = reset_at;
    status.time_until_reset_ms = reset_ms;

    if let Some(ut) = payload.get("userType").and_then(|v| v.as_str()) {
        status.metadata.insert("userType".to_string(), json!(ut));
    }
    if let Some(url) = payload.get("upgradeUrl").and_then(|v| v.as_str()) {
        status.metadata.insert("upgradeUrl".to_string(), json!(url));
    }
    status.metadata.insert("dataSource".to_string(), json!("cli-log"));
    if let Some(ts) = timestamp {
        status.metadata.insert("dataAsOf".to_string(), json!(ts));
    }

    status
}

// ---------------------------------------------------------------------------
// 2. Claude Code Quota Adapter
// ---------------------------------------------------------------------------

