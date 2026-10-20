use crate::quota::types::{ProviderQuotaStatus, QuotaWindow};
use crate::quota::utils::{
    chrono_parse_rfc3339, format_unix_to_iso, format_unix_to_rfc3339, now_ms, silent_command,
    user_home_dir,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;

fn grok_billing_request(url: &str, token: &str, user_id: Option<&str>) -> Option<(u16, String)> {
    let mut cmd = silent_command("curl.exe");
    cmd.args([
        "-s",
        "-w",
        "\n%{http_code}",
        url,
        "-H",
        &format!("Authorization: Bearer {}", token),
        "-H",
        "X-XAI-Token-Auth: xai-grok-cli",
        "-H",
        "Accept: application/json",
        "--max-time",
        "8",
    ]);
    if let Some(uid) = user_id {
        cmd.args(["-H", &format!("x-userid: {}", uid)]);
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let out = cmd.output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let (body, code) = text.rsplit_once('\n')?;
    let code: u16 = code.trim().parse().ok()?;
    if code == 0 {
        return None;
    }
    Some((code, body.to_string()))
}

fn grok_money(v: Option<&Value>) -> Option<f64> {
    let v = v?.get("val")?;
    v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse::<f64>().ok()))
}

/// Maps a Grok billing config onto a quota window. Returns true when a real
/// usage figure was found (weekly percent first, then monthly limit/used).
fn grok_apply_billing_config(status: &mut ProviderQuotaStatus, config: &Value, tier: &str) -> bool {
    let period_end = config
        .pointer("/currentPeriod/end")
        .or_else(|| config.get("billingPeriodEnd"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let time_res = period_end
        .as_ref()
        .and_then(|pe| chrono_parse_rfc3339(pe).ok())
        .map(|ms| (ms - now_ms()).max(0));

    let (used_pct, label) = if let Some(p) = config.get("creditUsagePercent").and_then(|v| v.as_f64()) {
        (p, "Créditos semanales")
    } else {
        let limit = grok_money(config.get("monthlyLimit"));
        let used = grok_money(config.get("used"));
        match (limit, used) {
            (Some(l), Some(u)) if l > 0.0 => ((u / l) * 100.0, "Límite mensual"),
            _ => return false,
        }
    };

    let used_pct = used_pct.clamp(0.0, 100.0);
    let rem_pct = 100.0 - used_pct;
    status.primary_usage_percent = (used_pct * 10.0).round() / 10.0;
    status.primary_remaining_percent = (rem_pct * 10.0).round() / 10.0;
    status.primary_reset_at = period_end.clone();
    status.time_until_reset_ms = time_res;
    status.windows.push(QuotaWindow {
        name: format!("{} ({})", tier, label),
        usage_percent: status.primary_usage_percent,
        remaining_fraction: (rem_pct / 100.0 * 100.0).round() / 100.0,
        resets_at: period_end,
        time_until_reset_ms: time_res,
        is_exhausted: rem_pct <= 0.0,
    });
    true
}

pub fn fetch_grok_quota() -> ProviderQuotaStatus {
    let mut status = ProviderQuotaStatus {
        provider_id: "grok".to_string(),
        display_name: "Grok".to_string(),
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
    let auth_file = if let Ok(custom) = std::env::var("GROK_HOME") {
        PathBuf::from(custom).join("auth.json")
    } else {
        home.join(".grok").join("auth.json")
    };

    if !auth_file.exists() {
        status.error = Some("No se encontraron credenciales de Grok en ~/.grok/auth.json".to_string());
        return status;
    }

    let content = match std::fs::read_to_string(&auth_file) {
        Ok(c) => c,
        Err(e) => {
            status.error = Some(format!("Error leyendo auth.json de Grok: {}", e));
            return status;
        }
    };

    let parsed: Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => {
            status.error = Some("Formato inválido en auth.json de Grok".to_string());
            return status;
        }
    };

    let mut access_token: Option<String> = None;
    let mut email: Option<String> = None;
    let mut auth_mode: Option<String> = None;
    let mut user_name: Option<String> = None;
    let mut expires_at: Option<String> = None;
    let mut refresh_token: Option<String> = None;
    let mut oidc_client_id: Option<String> = None;
    let mut entry_key: Option<String> = None;

    let mut user_id: Option<String> = None;

    if let Some(obj) = parsed.as_object() {
        for (k, entry) in obj {
            if let Some(token) = entry.get("key").or_else(|| entry.get("access_token")).and_then(|v| v.as_str()) {
                entry_key = Some(k.clone());
                access_token = Some(token.to_string());
                email = entry.get("email").and_then(|v| v.as_str()).map(|s| s.to_string());
                auth_mode = entry.get("auth_mode").and_then(|v| v.as_str()).map(|s| s.to_string());
                user_id = entry.get("user_id").and_then(|v| v.as_str()).map(|s| s.to_string());
                refresh_token = entry.get("refresh_token").and_then(|v| v.as_str()).map(|s| s.to_string());
                oidc_client_id = entry.get("oidc_client_id").and_then(|v| v.as_str()).map(|s| s.to_string());
                let first = entry.get("first_name").and_then(|v| v.as_str()).unwrap_or("");
                let last = entry.get("last_name").and_then(|v| v.as_str()).unwrap_or("");
                let full = format!("{} {}", first, last).trim().to_string();
                if !full.is_empty() {
                    user_name = Some(full);
                }
                expires_at = entry.get("expires_at").and_then(|v| v.as_str()).map(|s| s.to_string());
                break;
            }
        }
    }

    let mut token = match access_token {
        Some(t) => t,
        None => {
            status.error = Some("No se encontró token de acceso en ~/.grok/auth.json".to_string());
            return status;
        }
    };

    status.is_available = true;
    status.is_auth = true;

    if let Some(ref em) = email {
        status.metadata.insert("email".to_string(), json!(em));
    }
    if let Some(ref un) = user_name {
        status.metadata.insert("userName".to_string(), json!(un));
    }
    if let Some(ref am) = auth_mode {
        status.metadata.insert("authMode".to_string(), json!(am));
    }
    if let Some(ref uid) = user_id {
        status.metadata.insert("userId".to_string(), json!(uid));
    }
    status.metadata.insert("source".to_string(), json!("~/.grok/auth.json"));

    // Detect tier from settings_cache.json if available
    let settings_file = home.join(".grok").join("settings_cache.json");
    let mut detected_tier: Option<String> = None;
    if let Ok(settings_raw) = std::fs::read_to_string(&settings_file) {
        if let Ok(settings_val) = serde_json::from_str::<Value>(&settings_raw) {
            if let Some(payload_str) = settings_val.get("payload").and_then(|v| v.as_str()) {
                if let Ok(payload_json) = serde_json::from_str::<Value>(payload_str) {
                    if let Some(tier) = payload_json.pointer("/settings/subscription_tier_display").and_then(|v| v.as_str()) {
                        detected_tier = Some(tier.to_string());
                    }
                }
            }
        }
    }

    if let Some(ref tier) = detected_tier {
        status.metadata.insert("tier".to_string(), json!(tier));
    }

    // Check expiration
    let mut is_expired = false;
    let mut time_until_reset: Option<i64> = None;
    if let Some(ref exp) = expires_at {
        if let Ok(exp_ms) = chrono_parse_rfc3339(exp) {
            let diff = exp_ms - now_ms();
            if diff <= 0 {
                is_expired = true;
            } else {
                time_until_reset = Some(diff);
            }
        }
    }

    if is_expired {
        let mut refreshed_ok = false;
        if let (Some(ref rt), Some(ref cid)) = (&refresh_token, &oidc_client_id) {
            let form_data = format!("grant_type=refresh_token&client_id={}&refresh_token={}", cid, rt);
            let mut curl_cmd = silent_command("curl.exe");
            curl_cmd.args([
                "-s",
                "-X",
                "POST",
                "https://auth.x.ai/oauth2/token",
                "-H",
                "Content-Type: application/x-www-form-urlencoded",
                "-d",
                &form_data,
                "--max-time",
                "5",
            ]);
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                curl_cmd.creation_flags(0x08000000);
            }
            if let Ok(out) = curl_cmd.output() {
                if out.status.success() {
                    let body = String::from_utf8_lossy(&out.stdout);
                    if let Ok(refreshed) = serde_json::from_str::<Value>(&body) {
                        if let Some(new_at) = refreshed.get("access_token").and_then(|v| v.as_str()) {
                            token = new_at.to_string();
                            refreshed_ok = true;

                            let new_rt = refreshed.get("refresh_token").and_then(|v| v.as_str()).unwrap_or(rt);
                            let exp_secs = refreshed.get("expires_in").and_then(|v| v.as_i64()).unwrap_or(21600);
                            let new_exp = format_unix_to_rfc3339(now_ms() + exp_secs * 1000);
                            expires_at = Some(new_exp.clone());
                            time_until_reset = Some(exp_secs * 1000);

                            if let (Some(ref ek), Some(map)) = (&entry_key, parsed.as_object()) {
                                let mut updated = map.clone();
                                if let Some(ent_val) = updated.get_mut(ek) {
                                    if let Some(ent_obj) = ent_val.as_object_mut() {
                                        ent_obj.insert("key".to_string(), json!(token));
                                        ent_obj.insert("refresh_token".to_string(), json!(new_rt));
                                        ent_obj.insert("expires_at".to_string(), json!(new_exp));
                                    }
                                }
                                let _ = std::fs::write(&auth_file, serde_json::to_string_pretty(&updated).unwrap_or_default());
                            }
                        }
                    }
                }
            }
        }

        if !refreshed_ok {
            status.is_auth = false;
            status.error = Some("Sesión de Grok expirada. Ejecuta 'grok login' en la terminal para renovarla.".to_string());
            return status;
        }
    }

    // Billing endpoint of the Grok CLI proxy (the same one the CLI itself uses).
    // Never fabricate numbers: if the endpoint gives no usage, report why.
    let tier_name = detected_tier.clone().unwrap_or_else(|| "SuperGrok".to_string());
    status.metadata.insert("tier".to_string(), json!(tier_name));
    let credits_url = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
    let default_url = "https://cli-chat-proxy.grok.com/v1/billing";
    match grok_billing_request(credits_url, &token, user_id.as_deref()) {
        Some((code, body)) if (200..300).contains(&code) => {
            let data: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
            let config = data.get("config").unwrap_or(&data).clone();
            let mut mapped = grok_apply_billing_config(&mut status, &config, &tier_name);
            if !mapped {
                if let Some((c2, b2)) = grok_billing_request(default_url, &token, user_id.as_deref()) {
                    if (200..300).contains(&c2) {
                        let d2: Value = serde_json::from_str(&b2).unwrap_or(Value::Null);
                        let cfg2 = d2.get("config").unwrap_or(&d2).clone();
                        mapped = grok_apply_billing_config(&mut status, &cfg2, &tier_name);
                    }
                }
            }
            if !mapped {
                status.metadata.insert(
                    "note".to_string(),
                    json!("Grok no informó un porcentaje de uso para esta cuenta"),
                );
            }
        }
        Some((code, body)) => {
            if body.contains("privacy-mode:legacy") {
                status.metadata.insert("failureKind".to_string(), json!("privacy_mode"));
                status.error = Some("xAI no entrega los créditos porque la cuenta está en Privacy Mode 'Legacy'. Activa Privacy Mode en la configuración de Grok para ver el uso.".to_string());
            } else if code == 401 {
                status.is_auth = false;
                status.metadata.insert("failureKind".to_string(), json!("unauthorized"));
                status.error = Some("Sesión de Grok no autorizada (HTTP 401). Ejecuta 'grok login'.".to_string());
            } else {
                status.metadata.insert("failureKind".to_string(), json!("http"));
                status.error = Some(format!("La consulta de uso de Grok falló (HTTP {})", code));
            }
        }
        None => {
            status.metadata.insert("failureKind".to_string(), json!("network"));
            status.error = Some("No se pudo contactar el servicio de facturación de Grok".to_string());
        }
    }
    if let Some(ref ea) = expires_at {
        status.metadata.insert("sessionExpiresAt".to_string(), json!(ea));
    }
    let _ = time_until_reset;

    status
}

