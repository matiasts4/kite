use crate::quota::types::{ProviderQuotaStatus, QuotaWindow};
use crate::quota::utils::{format_unix_to_iso, now_ms, silent_command, user_home_dir};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;

pub fn fetch_codex_quota() -> ProviderQuotaStatus {
    let mut status = ProviderQuotaStatus {
        provider_id: "codex".to_string(),
        display_name: "Codex".to_string(),
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
    let auth_file = home.join(".codex").join("auth.json");
    let config_file = home.join(".codex").join("config.toml");
    let is_installed = home.join(".codex").exists() || config_file.exists();

    if is_installed {
        status.is_available = true;
        status.metadata.insert("source".to_string(), json!("~/.codex/config.toml"));
    }

    let mut access_token: Option<String> = std::env::var("CODEX_ACCESS_TOKEN")
        .or_else(|_| std::env::var("CODEX_TOKEN"))
        .ok();
    let mut account_id: Option<String> = std::env::var("CODEX_ACCOUNT_ID").ok();

    if access_token.is_none() && auth_file.exists() {
        if let Ok(content) = std::fs::read_to_string(&auth_file) {
            if let Ok(val) = serde_json::from_str::<Value>(&content) {
                access_token = val.pointer("/tokens/access_token")
                    .or_else(|| val.get("access_token"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                account_id = val.pointer("/tokens/account_id")
                    .or_else(|| val.get("account_id"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
            }
        }
    }

    let token = match access_token {
        Some(t) => t,
        None => {
            if is_installed {
                status.is_auth = false;
                status.error = Some("Sesión OAuth de Codex no iniciada. Ejecuta 'codex login' en la terminal para conectar tu cuenta.".to_string());
                status.metadata.insert("loginCommand".to_string(), json!("codex login"));
            } else {
                status.error = Some("Codex no encontrado (~/.codex)".to_string());
            }
            return status;
        }
    };

    status.is_auth = true;

    let urls = [
        "https://chatgpt.com/backend-api/wham/usage",
        "https://chatgpt.com/api/codex/usage",
    ];

    let auth_header = format!("Authorization: Bearer {}", token);
    for u in &urls {
        let mut cmd = silent_command("curl.exe");
        cmd.args([
            "-s",
            u,
            "-H",
            &auth_header,
            "-H",
            "Accept: application/json",
            "-H",
            "User-Agent: Kite-QuotaEngine/1.0",
            "--max-time",
            "5",
        ]);
        if let Some(ref acc) = account_id {
            cmd.args(["-H", &format!("ChatGPT-Account-Id: {}", acc)]);
        }

        if let Ok(out) = cmd.output() {
            if out.status.success() {
                let body = String::from_utf8_lossy(&out.stdout);
                if let Ok(data) = serde_json::from_str::<Value>(&body) {
                    if data.get("rate_limit").is_some() || data.get("plan_type").is_some() {
                        return apply_codex_usage_payload(status, &data);
                    }
                }
            }
        }
    }

    status.error = Some("No se pudo obtener datos de uso de OpenAI Codex".to_string());
    status
}

fn apply_codex_usage_payload(mut status: ProviderQuotaStatus, data: &Value) -> ProviderQuotaStatus {
    if let Some(plan) = data.get("plan_type").and_then(|v| v.as_str()) {
        status.metadata.insert("planType".to_string(), json!(plan));
    }

    let mut max_used = 0.0f64;
    let mut earliest_reset: Option<i64> = None;
    let mut primary_reset_at: Option<String> = None;

    let windows_to_check = [
        ("primary_window", "5-Hour Session"),
        ("secondary_window", "Weekly Cap"),
    ];

    for (sub_key, label) in windows_to_check {
        if let Some(win) = data.pointer(&format!("/rate_limit/{}", sub_key)) {
            if let Some(used) = win.get("used_percent").and_then(|v| v.as_f64()) {
                let reset_sec = win.get("reset_at").and_then(|v| v.as_i64()).unwrap_or(0);
                let reset_ms = if reset_sec > 0 {
                    (reset_sec * 1000 - now_ms()).max(0)
                } else {
                    0
                };

                if reset_ms > 0 && (earliest_reset.is_none() || reset_ms < earliest_reset.unwrap()) {
                    earliest_reset = Some(reset_ms);
                    primary_reset_at = Some(format_unix_to_iso(reset_sec * 1000));
                }

                if used > max_used {
                    max_used = used;
                }

                status.windows.push(QuotaWindow {
                    name: label.to_string(),
                    usage_percent: used,
                    remaining_fraction: ((100.0 - used) / 100.0).clamp(0.0, 1.0),
                    resets_at: if reset_sec > 0 { Some(format_unix_to_iso(reset_sec * 1000)) } else { None },
                    time_until_reset_ms: if reset_ms > 0 { Some(reset_ms) } else { None },
                    is_exhausted: used >= 100.0,
                });
            }
        }
    }

    if let Some(rev) = data.pointer("/code_review_rate_limit/primary_window") {
        if let Some(used) = rev.get("used_percent").and_then(|v| v.as_f64()) {
            status.windows.push(QuotaWindow {
                name: "Review Requests".to_string(),
                usage_percent: used,
                remaining_fraction: ((100.0 - used) / 100.0).clamp(0.0, 1.0),
                resets_at: None,
                time_until_reset_ms: None,
                is_exhausted: used >= 100.0,
            });
        }
    }

    if let Some(bal) = data.pointer("/credits/balance").and_then(|v| v.as_f64()) {
        status.metadata.insert("creditsBalance".to_string(), json!(bal));
    }

    status.primary_usage_percent = max_used;
    status.primary_remaining_percent = (100.0 - max_used).clamp(0.0, 100.0);
    status.primary_reset_at = primary_reset_at;
    status.time_until_reset_ms = earliest_reset;
    status
}

// ---------------------------------------------------------------------------
// 4. OpenCode & Grok Adapters
// ---------------------------------------------------------------------------

