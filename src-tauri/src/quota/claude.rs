use crate::quota::types::{ProviderQuotaStatus, QuotaWindow};
use crate::quota::utils::{chrono_parse_rfc3339, now_ms, silent_command, user_home_dir};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;

pub fn fetch_claude_quota() -> ProviderQuotaStatus {
    let mut status = ProviderQuotaStatus {
        provider_id: "claude".to_string(),
        display_name: "Claude Code".to_string(),
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
    let creds_file = home.join(".claude").join(".credentials.json");
    let token_file = home.join(".claude").join(".token");

    let mut token: Option<String> = std::env::var("ANTHROPIC_OAUTH_TOKEN")
        .or_else(|_| std::env::var("CLAUDE_CODE_TOKEN"))
        .ok();

    if token.is_none() && creds_file.exists() {
        if let Ok(content) = std::fs::read_to_string(&creds_file) {
            if let Ok(val) = serde_json::from_str::<Value>(&content) {
                if let Some(t) = val.pointer("/claudeAiOauth/accessToken").and_then(|v| v.as_str()) {
                    token = Some(t.to_string());
                }
            }
        }
    }

    if token.is_none() && token_file.exists() {
        if let Ok(content) = std::fs::read_to_string(&token_file) {
            let trimmed = content.trim();
            if !trimmed.is_empty() {
                if trimmed.starts_with('{') {
                    if let Ok(val) = serde_json::from_str::<Value>(trimmed) {
                        token = val.get("accessToken")
                            .or_else(|| val.get("oauth_token"))
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string());
                    }
                } else {
                    token = Some(trimmed.to_string());
                }
            }
        }
    }

    let claude_dir = home.join(".claude");
    let is_installed = claude_dir.exists();
    if is_installed {
        status.is_available = true;
        status.metadata.insert("source".to_string(), json!("~/.claude/"));
        status.metadata.insert("loginCommand".to_string(), json!("claude login"));
    }

    let token = match token {
        Some(t) => t,
        None => {
            if is_installed {
                status.is_auth = false;
                status.error = Some("Claude Code instalado pero sin sesión activa. Ejecuta 'claude login' en la terminal.".to_string());
            } else {
                status.error = Some("Claude Code no encontrado (~/.claude)".to_string());
            }
            return status;
        }
    };

    status.is_available = true;
    status.is_auth = true;

    let auth_header = format!("Authorization: Bearer {}", token);
    let output = silent_command("curl.exe")
        .args([
            "-s",
            "https://api.anthropic.com/api/oauth/usage",
            "-H",
            &auth_header,
            "-H",
            "anthropic-version: 2023-06-01",
            "--max-time",
            "5",
        ])
        .output();

    if let Ok(out) = output {
        if out.status.success() {
            let body = String::from_utf8_lossy(&out.stdout);
            if let Ok(data) = serde_json::from_str::<Value>(&body) {
                let window_defs = [
                    ("five_hour", "5-Hour Limit"),
                    ("seven_day", "Weekly All-Model"),
                    ("seven_day_sonnet", "Weekly Sonnet"),
                    ("monthly_limit", "Monthly Limit"),
                ];

                let mut max_usage = 0.0f64;
                let mut earliest_reset: Option<i64> = None;
                let mut primary_reset_at: Option<String> = None;

                for (key, label) in window_defs {
                    if let Some(entry) = data.get(key) {
                        if let Some(util) = entry.get("utilization").and_then(|v| v.as_f64()) {
                            let usage_pct = (util * 100.0).clamp(0.0, 100.0);
                            let remaining_fraction = (1.0 - util).clamp(0.0, 1.0);
                            let resets_at = entry.get("resets_at").and_then(|v| v.as_str()).map(|s| s.to_string());

                            let mut time_until_reset_ms: Option<i64> = None;
                            if let Some(ref rt) = resets_at {
                                if let Ok(parsed) = chrono_parse_rfc3339(rt) {
                                    let ms = (parsed - now_ms()).max(0);
                                    time_until_reset_ms = Some(ms);
                                    if earliest_reset.is_none() || ms < earliest_reset.unwrap() {
                                        earliest_reset = Some(ms);
                                        primary_reset_at = Some(rt.clone());
                                    }
                                }
                            }

                            if usage_pct > max_usage {
                                max_usage = usage_pct;
                            }

                            status.windows.push(QuotaWindow {
                                name: label.to_string(),
                                usage_percent: (usage_pct * 10.0).round() / 10.0,
                                remaining_fraction: (remaining_fraction * 100.0).round() / 100.0,
                                resets_at,
                                time_until_reset_ms,
                                is_exhausted: usage_pct >= 100.0,
                            });
                        }
                    }
                }

                let rem = (100.0 - max_usage).clamp(0.0, 100.0);
                status.primary_usage_percent = (max_usage * 10.0).round() / 10.0;
                status.primary_remaining_percent = (rem * 10.0).round() / 10.0;
                status.primary_reset_at = primary_reset_at;
                status.time_until_reset_ms = earliest_reset;
                return status;
            }
        }
    }

    status.is_auth = false;
    status.error = Some("Sesión de Claude Code expirada. Ejecuta 'claude login' en la terminal.".to_string());
    status
}

// ---------------------------------------------------------------------------
// 3. OpenAI Codex Quota Adapter
// ---------------------------------------------------------------------------

