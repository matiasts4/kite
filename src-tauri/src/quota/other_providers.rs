use crate::quota::types::{ProviderQuotaStatus, QuotaWindow};
use crate::quota::utils::{
    chrono_parse_rfc3339, format_unix_to_iso, format_unix_to_rfc3339, now_ms, silent_command,
    user_home_dir,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn fetch_droid_quota() -> ProviderQuotaStatus {
    let home = user_home_dir();
    let droid_dir = home.join(".factory");
    let is_avail = droid_dir.exists();
    let mut status = ProviderQuotaStatus {
        provider_id: "droid".to_string(),
        display_name: "Droid".to_string(),
        is_available: is_avail,
        is_auth: is_avail,
        primary_usage_percent: 0.0,
        primary_remaining_percent: 100.0,
        primary_reset_at: None,
        time_until_reset_ms: None,
        windows: Vec::new(),
        metadata: HashMap::new(),
        last_updated_ms: now_ms(),
        error: if is_avail { None } else { Some("Factory Droid credentials no detectadas".to_string()) },
    };
    if is_avail {
        status.metadata.insert("source".to_string(), json!("~/.factory/"));
        status.metadata.insert("note".to_string(), json!("Detectado localmente"));
    }
    status
}

pub fn fetch_copilot_quota() -> ProviderQuotaStatus {
    let home = user_home_dir();
    let copilot_dir = home.join(".copilot");
    let is_avail = copilot_dir.exists();
    let mut status = ProviderQuotaStatus {
        provider_id: "copilot".to_string(),
        display_name: "GitHub Copilot".to_string(),
        is_available: is_avail,
        is_auth: is_avail,
        primary_usage_percent: 0.0,
        primary_remaining_percent: 100.0,
        primary_reset_at: None,
        time_until_reset_ms: None,
        windows: Vec::new(),
        metadata: HashMap::new(),
        last_updated_ms: now_ms(),
        error: if is_avail { None } else { Some("GitHub Copilot CLI no conectado (~/.copilot)".to_string()) },
    };
    if is_avail {
        status.metadata.insert("source".to_string(), json!("~/.copilot/config.json"));
        status.metadata.insert("note".to_string(), json!("Detectado localmente"));
    }
    status
}

pub fn fetch_deepseek_quota() -> ProviderQuotaStatus {
    let key = crate::credentials::resolve_provider_key("deepseek");
    let mut status = ProviderQuotaStatus {
        provider_id: "deepseek".to_string(),
        display_name: "DeepSeek".to_string(),
        is_available: key.is_some(),
        is_auth: key.is_some(),
        primary_usage_percent: 0.0,
        primary_remaining_percent: 100.0,
        primary_reset_at: None,
        time_until_reset_ms: None,
        windows: Vec::new(),
        metadata: HashMap::new(),
        last_updated_ms: now_ms(),
        error: None,
    };
    let key = match key {
        Some(k) => k,
        None => {
            status.error = Some("DEEPSEEK_API_KEY no configurada".to_string());
            return status;
        }
    };
    status.metadata.insert("source".to_string(), json!("Bóveda / Entorno"));
    let mut cmd = silent_command("curl.exe");
    cmd.args([
        "-s",
        "-w",
        "\n%{http_code}",
        "https://api.deepseek.com/user/balance",
        "-H",
        &format!("Authorization: Bearer {}", key.trim()),
        "-H",
        "Accept: application/json",
        "--max-time",
        "8",
    ]);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let parsed = cmd.output().ok().and_then(|o| {
        let text = String::from_utf8_lossy(&o.stdout).to_string();
        let (body, code) = text.rsplit_once('\n')?;
        Some((code.trim().parse::<u16>().ok()?, serde_json::from_str::<Value>(body).unwrap_or(Value::Null)))
    });
    match parsed {
        Some((code, data)) if (200..300).contains(&code) => {
            if let Some(info) = data.pointer("/balance_infos/0") {
                let cur = info.get("currency").and_then(|v| v.as_str()).unwrap_or("");
                let total = info.get("total_balance").and_then(|v| v.as_str()).unwrap_or("?");
                status.metadata.insert("balance".to_string(), json!(format!("{} {}", total, cur).trim().to_string()));
            }
            if data.get("is_available").and_then(|v| v.as_bool()) == Some(false) {
                status.error = Some("Saldo insuficiente en la cuenta de DeepSeek".to_string());
            }
        }
        Some((401, _)) | Some((403, _)) => {
            status.is_auth = false;
            status.error = Some("DeepSeek rechazó la clave de API".to_string());
        }
        Some((code, _)) => status.error = Some(format!("La consulta de saldo de DeepSeek falló (HTTP {})", code)),
        None => status.error = Some("No se pudo contactar api.deepseek.com".to_string()),
    }
    status
}

// ---------------------------------------------------------------------------
// 5. Kimi Code Adapter with OAuth Refresh & Usages Parsing
// ---------------------------------------------------------------------------

pub fn fetch_kimi_quota() -> ProviderQuotaStatus {
    let mut status = ProviderQuotaStatus {
        provider_id: "kimi".to_string(),
        display_name: "Kimi Code".to_string(),
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
    let candidates = [
        home.join(".kimi-code").join("credentials").join("kimi-code.json"),
        home.join(".kimi").join("credentials").join("kimi-code.json"),
    ];

    let mut found_cred_file: Option<PathBuf> = None;
    let mut cred_data: Option<Value> = None;

    for c in &candidates {
        if c.exists() {
            if let Ok(raw) = std::fs::read_to_string(c) {
                if let Ok(parsed) = serde_json::from_str::<Value>(&raw) {
                    if parsed.get("access_token").and_then(|v| v.as_str()).is_some() {
                        found_cred_file = Some(c.clone());
                        cred_data = Some(parsed);
                        break;
                    }
                }
            }
        }
    }

    let (cred_path, mut cred_json) = match (found_cred_file, cred_data) {
        (Some(p), Some(d)) => (p, d),
        _ => {
            let api_key = crate::credentials::resolve_provider_key("kimi");
            if let Some(key) = api_key {
                status.is_available = true;
                return fetch_moonshot_balance(&key, status);
            }
            status.error = Some("No se encontraron credenciales de Kimi Code (~/.kimi-code)".to_string());
            return status;
        }
    };

    status.is_available = true;
    status.metadata.insert("source".to_string(), json!(cred_path.display().to_string()));
    status.metadata.insert("loginCommand".to_string(), json!("kimi login"));

    let mut access_token = cred_json.get("access_token").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let refresh_token = cred_json.get("refresh_token").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let expires_at_sec = cred_json.get("expires_at").and_then(|v| v.as_i64()).unwrap_or(0);

    let is_expired = if expires_at_sec > 0 {
        now_ms() / 1000 >= expires_at_sec - 60
    } else {
        false
    };

    if is_expired && !refresh_token.is_empty() {
        if let Some(new_tok) = refresh_kimi_token(&cred_path, &mut cred_json, &refresh_token) {
            access_token = new_tok;
        }
    }

    if access_token.is_empty() {
        status.is_auth = false;
        status.error = Some("Sesión de Kimi Code expirada. Ejecuta 'kimi login' en la terminal para renovarla.".to_string());
        return status;
    }

    let auth_header = format!("Authorization: Bearer {}", access_token);
    let out = silent_command("curl.exe")
        .args([
            "-s",
            "https://api.kimi.com/coding/v1/usages",
            "-H",
            &auth_header,
            "-H",
            "Accept: application/json",
            "-H",
            "User-Agent: Kite-QuotaEngine/1.0",
            "--max-time",
            "5",
        ])
        .output();

    if let Ok(resp) = out {
        if resp.status.success() {
            let body = String::from_utf8_lossy(&resp.stdout);
            if let Ok(payload) = serde_json::from_str::<Value>(&body) {
                if payload.get("usage").is_some() || payload.get("limits").is_some() {
                    status.is_auth = true;
                    return apply_kimi_usage_payload(status, &payload);
                }
                if let Some(err_msg) = payload.pointer("/error/message").and_then(|v| v.as_str()) {
                    if (err_msg.contains("invalid") || err_msg.contains("expired")) && !refresh_token.is_empty() {
                        if let Some(new_tok) = refresh_kimi_token(&cred_path, &mut cred_json, &refresh_token) {
                            let retry_header = format!("Authorization: Bearer {}", new_tok);
                            if let Ok(retry_resp) = silent_command("curl.exe")
                                .args([
                                    "-s",
                                    "https://api.kimi.com/coding/v1/usages",
                                    "-H",
                                    &retry_header,
                                    "-H",
                                    "Accept: application/json",
                                    "--max-time",
                                    "5",
                                ])
                                .output()
                            {
                                if retry_resp.status.success() {
                                    let retry_body = String::from_utf8_lossy(&retry_resp.stdout);
                                    if let Ok(retry_pay) = serde_json::from_str::<Value>(&retry_body) {
                                        if retry_pay.get("usage").is_some() || retry_pay.get("limits").is_some() {
                                            status.is_auth = true;
                                            return apply_kimi_usage_payload(status, &retry_pay);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    status.is_auth = false;
    status.error = Some("Sesión de Kimi Code expirada. Ejecuta 'kimi login' en la terminal para renovar.".to_string());
    status
}

fn refresh_kimi_token(path: &PathBuf, cred_json: &mut Value, refresh_token: &str) -> Option<String> {
    let body_data = format!(
        "client_id=17e5f671-d194-4dfb-9706-5516cb48c098&grant_type=refresh_token&refresh_token={}",
        refresh_token
    );
    let output = silent_command("curl.exe")
        .args([
            "-s",
            "-X",
            "POST",
            "https://auth.kimi.com/api/oauth/token",
            "-H",
            "Content-Type: application/x-www-form-urlencoded",
            "-H",
            "Accept: application/json",
            "-d",
            &body_data,
            "--max-time",
            "5",
        ])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let resp_str = String::from_utf8_lossy(&output.stdout);
    let res_json: Value = serde_json::from_str(&resp_str).ok()?;
    let new_access = res_json.get("access_token").and_then(|v| v.as_str())?.to_string();
    let new_refresh = res_json.get("refresh_token").and_then(|v| v.as_str()).map(|s| s.to_string());
    let expires_in = res_json.get("expires_in").and_then(|v| v.as_i64()).unwrap_or(3600);

    if let Some(obj) = cred_json.as_object_mut() {
        obj.insert("access_token".to_string(), json!(new_access));
        if let Some(r) = new_refresh {
            obj.insert("refresh_token".to_string(), json!(r));
        }
        obj.insert("expires_at".to_string(), json!(now_ms() / 1000 + expires_in));
        let _ = std::fs::write(path, serde_json::to_string_pretty(&obj).unwrap_or_default());
    }

    Some(new_access)
}

fn apply_kimi_usage_payload(mut status: ProviderQuotaStatus, payload: &Value) -> ProviderQuotaStatus {
    let mut max_usage = 0.0f64;
    let mut earliest_reset_ms: Option<i64> = None;
    let mut primary_reset_at: Option<String> = None;

    let mut process_row = |raw: Option<&Value>, label: &str| {
        let val = match raw {
            Some(v) => v,
            None => return,
        };
        let limit = val.get("limit").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let used = val.get("used").and_then(|v| v.as_f64());
        let remaining = val.get("remaining").and_then(|v| v.as_f64());

        let eff_used = match (used, remaining) {
            (Some(u), _) => u,
            (None, Some(r)) => (limit - r).max(0.0),
            _ => 0.0,
        };

        let usage_pct = if limit > 0.0 {
            (eff_used / limit * 100.0).clamp(0.0, 100.0)
        } else {
            0.0
        };

        let reset_at = val.get("resetTime")
            .or_else(|| val.get("reset_at"))
            .or_else(|| val.get("resetAt"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let mut reset_ms: Option<i64> = None;
        if let Some(ref rt) = reset_at {
            if let Ok(ms) = chrono_parse_rfc3339(rt) {
                let diff = (ms - now_ms()).max(0);
                reset_ms = Some(diff);
                if earliest_reset_ms.is_none() || diff < earliest_reset_ms.unwrap() {
                    earliest_reset_ms = Some(diff);
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
            remaining_fraction: ((100.0 - usage_pct) / 100.0).clamp(0.0, 1.0),
            resets_at: reset_at,
            time_until_reset_ms: reset_ms,
            is_exhausted: usage_pct >= 100.0,
        });
    };

    process_row(payload.get("usage"), "Límite Semanal");

    if let Some(arr) = payload.get("limits").and_then(|v| v.as_array()) {
        for (idx, item) in arr.iter().enumerate() {
            let detail = item.get("detail").unwrap_or(item);
            let name = item.get("name")
                .or_else(|| item.get("title"))
                .or_else(|| detail.get("name"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| format!("Límite #{}", idx + 1));
            process_row(Some(detail), &name);
        }
    }

    if let Some(membership) = payload.pointer("/user/membership/level").and_then(|v| v.as_str()) {
        let clean = membership.replace("LEVEL_", "").to_lowercase();
        let formatted = format!("{}{}", clean.chars().next().map(|c| c.to_ascii_uppercase()).unwrap_or('?'), &clean[1..]);
        status.metadata.insert("membership".to_string(), json!(formatted));
    }

    if let Some(region) = payload.pointer("/user/region").and_then(|v| v.as_str()) {
        status.metadata.insert("region".to_string(), json!(region.replace("REGION_", "")));
    }

    status.primary_usage_percent = (max_usage * 10.0).round() / 10.0;
    status.primary_remaining_percent = ((100.0 - max_usage) * 10.0).round() / 10.0;
    status.primary_reset_at = primary_reset_at;
    status.time_until_reset_ms = earliest_reset_ms;
    status.error = None;
    status
}

fn fetch_moonshot_balance(api_key: &str, mut status: ProviderQuotaStatus) -> ProviderQuotaStatus {
    let auth_header = format!("Bearer {}", api_key);
    let output = silent_command("curl.exe")
        .args([
            "-s",
            "https://api.moonshot.cn/v1/users/me/balance",
            "-H",
            &auth_header,
            "-H",
            "User-Agent: Kite-QuotaEngine/1.0",
            "--max-time",
            "5",
        ])
        .output();

    if let Ok(out) = output {
        if out.status.success() {
            let body = String::from_utf8_lossy(&out.stdout);
            if let Ok(data) = serde_json::from_str::<Value>(&body) {
                let avail = data.pointer("/data/available_balance").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let voucher = data.pointer("/data/voucher_balance").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let total = avail + voucher;

                status.is_auth = true;
                status.primary_usage_percent = 0.0;
                status.primary_remaining_percent = if total > 0.0 { 100.0 } else { 0.0 };
                status.metadata.insert("availableBalance".to_string(), json!(avail));
                status.metadata.insert("voucherBalance".to_string(), json!(voucher));
                status.windows.push(QuotaWindow {
                    name: "Saldo Moonshot API".to_string(),
                    usage_percent: 0.0,
                    remaining_fraction: if total > 0.0 { 1.0 } else { 0.0 },
                    resets_at: None,
                    time_until_reset_ms: None,
                    is_exhausted: total <= 0.0,
                });
                return status;
            }
        }
    }

    status.error = Some("Error consultando saldo de Moonshot API".to_string());
    status
}

