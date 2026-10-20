use crate::quota::types::{ProviderQuotaStatus, QuotaWindow};
use crate::quota::utils::{
    b64url_decode, chrono_parse_rfc3339, decode_jwt_claims, now_ms, silent_command,
    url_encode_component, user_home_dir,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;

fn read_cursor_session() -> Option<(String, Option<String>, Option<String>)> {
    let home = user_home_dir();
    let appdata = std::env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home.join("AppData").join("Roaming"));
    let mut email: Option<String> = None;

    if let Ok(raw) = std::fs::read_to_string(home.join(".cursor").join("cli-config.json")) {
        if let Ok(v) = serde_json::from_str::<Value>(&raw) {
            email = v.pointer("/authInfo/email").and_then(|e| e.as_str()).map(|s| s.to_string());
        }
    }
    for dir in [appdata.join("Cursor"), home.join(".cursor")] {
        if let Ok(raw) = std::fs::read_to_string(dir.join("auth.json")) {
            if let Ok(v) = serde_json::from_str::<Value>(&raw) {
                if let Some(t) = v.get("accessToken").and_then(|t| t.as_str()) {
                    if !t.is_empty() {
                        return Some((t.to_string(), email, None));
                    }
                }
            }
        }
    }

    let db = appdata.join("Cursor").join("User").join("globalStorage").join("state.vscdb");
    if !db.exists() {
        return None;
    }
    let uri = format!("file:{}?mode=ro&immutable=1", db.to_string_lossy().replace('\\', "/"));
    let conn = rusqlite::Connection::open_with_flags(
        uri,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    )
    .ok()?;
    let get = |key: &str| -> Option<String> {
        conn.query_row("SELECT value FROM ItemTable WHERE key = ?1", [key], |r| r.get::<_, String>(0))
            .ok()
            .filter(|s| !s.trim().is_empty())
    };
    let token = get("cursorAuth/accessToken")?;
    let em = get("cursorAuth/cachedEmail").or(email);
    Some((token, em, get("cursorAuth/stripeMembershipType")))
}

fn cursor_json(url: &str, cookie: &str) -> Option<(u16, Value)> {
    let mut cmd = silent_command("curl.exe");
    cmd.args([
        "-s",
        "-w",
        "\n%{http_code}",
        url,
        "-H",
        &format!("Cookie: {}", cookie),
        "-H",
        "Accept: application/json",
        "-H",
        "Origin: https://cursor.com",
        "-H",
        "Referer: https://cursor.com/dashboard",
        "--max-time",
        "10",
    ]);
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
    Some((code, serde_json::from_str(body).unwrap_or(Value::Null)))
}

fn cursor_pct(pool: &Value, pct_field: &str) -> Option<f64> {
    let used = pool.get("used").and_then(|v| v.as_f64());
    let limit = pool.get("limit").and_then(|v| v.as_f64());
    if let (Some(u), Some(l)) = (used, limit) {
        if l > 0.0 {
            return Some((u / l) * 100.0);
        }
    }
    pool.get(pct_field).and_then(|v| v.as_f64())
}

pub fn fetch_cursor_quota() -> ProviderQuotaStatus {
    let mut status = ProviderQuotaStatus {
        provider_id: "cursor".to_string(),
        display_name: "Cursor".to_string(),
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

    let (token, email, membership) = match read_cursor_session() {
        Some(s) => s,
        None => {
            status.error = Some("No hay sesión de Cursor en este equipo. Inicia sesión en Cursor IDE o con 'cursor-agent login'.".to_string());
            return status;
        }
    };
    status.is_available = true;
    status.is_auth = true;
    status.metadata.insert("source".to_string(), json!("Cursor IDE / cursor-agent"));
    if let Some(ref e) = email {
        status.metadata.insert("email".to_string(), json!(e));
    }

    let (subject, exp) = match decode_jwt_claims(&token) {
        Some(c) => c,
        None => {
            status.is_auth = false;
            status.error = Some("El token de Cursor no es válido. Vuelve a iniciar sesión.".to_string());
            return status;
        }
    };
    if let Some(exp) = exp {
        if exp * 1000 <= now_ms() {
            status.is_auth = false;
            status.error = Some("La sesión de Cursor expiró. Abre Cursor o ejecuta 'cursor-agent login'.".to_string());
            return status;
        }
    }

    let cookie = format!("WorkosCursorSessionToken={}%3A%3A{}", url_encode_component(&subject), token);
    let (code, data) = match cursor_json("https://cursor.com/api/usage-summary", &cookie) {
        Some(r) => r,
        None => {
            status.error = Some("No se pudo contactar cursor.com".to_string());
            return status;
        }
    };
    if code == 401 || code == 403 {
        status.is_auth = false;
        status.error = Some(format!("Cursor rechazó la sesión (HTTP {}). Vuelve a iniciar sesión.", code));
        return status;
    }
    if !(200..300).contains(&code) {
        status.error = Some(format!("La consulta de uso de Cursor falló (HTTP {})", code));
        return status;
    }

    let plan_type = data
        .get("membershipType")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or(membership);
    if let Some(ref p) = plan_type {
        status.metadata.insert("planType".to_string(), json!(p));
    }
    if data.get("isUnlimited").and_then(|v| v.as_bool()) == Some(true) {
        status.metadata.insert("note".to_string(), json!("Plan sin límite de uso"));
        return status;
    }

    let cycle_end = data.get("billingCycleEnd").and_then(|v| v.as_str()).map(|s| s.to_string());
    let time_res = cycle_end
        .as_ref()
        .and_then(|e| chrono_parse_rfc3339(e).ok())
        .map(|ms| (ms - now_ms()).max(0));

    let push = |status: &mut ProviderQuotaStatus, name: &str, pct: f64| {
        let used = pct.clamp(0.0, 100.0);
        let rem = 100.0 - used;
        status.windows.push(QuotaWindow {
            name: name.to_string(),
            usage_percent: (used * 10.0).round() / 10.0,
            remaining_fraction: (rem / 100.0 * 100.0).round() / 100.0,
            resets_at: cycle_end.clone(),
            time_until_reset_ms: time_res,
            is_exhausted: rem <= 0.0,
        });
    };

    let plan = data.pointer("/individualUsage/plan");
    let plan_enabled = plan.and_then(|p| p.get("enabled")).and_then(|v| v.as_bool()) != Some(false);
    let mut total_pct: Option<f64> = None;
    if let (Some(plan), true) = (plan, plan_enabled) {
        total_pct = plan
            .get("totalPercentUsed")
            .and_then(|v| v.as_f64())
            .or_else(|| cursor_pct(plan, "totalPercentUsed"));
        if let Some(p) = total_pct {
            push(&mut status, "Uso total incluido", p);
        }
        if let Some(p) = plan.get("autoPercentUsed").and_then(|v| v.as_f64()) {
            push(&mut status, "Modelos de Cursor (Auto)", p);
        }
        if let Some(p) = plan.get("apiPercentUsed").and_then(|v| v.as_f64()) {
            push(&mut status, "Otros modelos (API)", p);
        }
    }
    if let Some(od) = data.pointer("/individualUsage/onDemand") {
        if od.get("enabled").and_then(|v| v.as_bool()) == Some(true) {
            if let Some(p) = cursor_pct(od, "totalPercentUsed") {
                push(&mut status, "Uso bajo demanda", p);
            }
        }
    }

    if let Some(p) = total_pct {
        let used = p.clamp(0.0, 100.0);
        status.primary_usage_percent = (used * 10.0).round() / 10.0;
        status.primary_remaining_percent = ((100.0 - used) * 10.0).round() / 10.0;
        status.primary_reset_at = cycle_end;
        status.time_until_reset_ms = time_res;
    } else if let Some(w) = status.windows.first() {
        status.primary_usage_percent = w.usage_percent;
        status.primary_remaining_percent = 100.0 - w.usage_percent;
        status.primary_reset_at = w.resets_at.clone();
        status.time_until_reset_ms = w.time_until_reset_ms;
    } else {
        status.metadata.insert("note".to_string(), json!("Cursor no informó una cuota para esta cuenta"));
    }
    status
}

