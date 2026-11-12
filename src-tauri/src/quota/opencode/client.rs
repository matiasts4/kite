use super::credentials::Credential;
use serde_json::Value;
use std::time::Duration;

pub const OPENCODE_GO_USAGE_ENDPOINT: &str = "https://opencode.ai/zen/go/v1/usage";
pub const OPENCODE_GO_MODELS_ENDPOINT: &str = "https://opencode.ai/zen/go/v1/models";
pub const OPENCODE_GO_CHAT_ENDPOINT: &str =
    "https://opencode.ai/inference/go/openai/v1/chat/completions";
pub const DEFAULT_CONSOLE_BASE: &str = "https://opencode.ai/console";
pub const CONSOLE_STATUS_PATH: &str = "api/go/status";
pub const REQUEST_TIMEOUT_SECS: u64 = 15;
pub const WINDOW_KEYS: [(&str, &str); 3] = [
    ("rolling", "5 horas"),
    ("weekly", "Semanal"),
    ("monthly", "Mensual"),
];

#[derive(Debug, Clone)]
pub struct WindowData {
    pub key: &'static str,
    pub name: &'static str,
    pub usage_percent: f64,
    pub resets_at: String,
    pub reset_ms: i64,
    pub exhausted: bool,
}

#[derive(Debug, Clone)]
pub struct FetchOutcome {
    pub http_status: Option<u16>,
    pub windows: Option<Vec<WindowData>>,
    pub error: Option<String>,
    pub unauthorized: bool,
    pub entitlement_error: bool,
}

/// One endpoint probe result. A probe verifies only the endpoint it was sent
/// to; success elsewhere never implies success here.
#[derive(Debug, Clone)]
pub struct EndpointProbe {
    pub endpoint_id: String,
    pub ok: bool,
    pub http_status: Option<u16>,
    /// Whether `x-opencode-session` was sent with the request. The Go chat
    /// gateway rejects requests without it, so it cannot be verified otherwise.
    pub session_header_sent: bool,
    /// A 403 `EntitlementError` on Go means the account has no Go subscription.
    pub entitlement_error: bool,
}

pub fn value_to_i64(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => number
            .as_i64()
            .or_else(|| number.as_f64().map(|value| value.round() as i64)),
        Value::String(raw) => raw
            .trim()
            .parse::<i64>()
            .ok()
            .or_else(|| raw.trim().parse::<f64>().ok().map(|value| value.round() as i64)),
        _ => None,
    }
}

pub fn fetch_usage(credential: &Credential) -> FetchOutcome {
    let client = match http_client() {
        Ok(client) => client,
        Err(error) => return failure(None, error, false),
    };

    let response = match client
        .get(OPENCODE_GO_USAGE_ENDPOINT)
        .header(
            reqwest::header::AUTHORIZATION,
            format!("Bearer {}", credential.token),
        )
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
    {
        Ok(response) => response,
        Err(error) => return failure(None, friendly_reqwest_error(&error), false),
    };

    let status = response.status().as_u16();
    let body = response.text().unwrap_or_default();

    if !(200..300).contains(&status) {
        return api_error(status, &body, &credential.token);
    }

    match serde_json::from_str::<Value>(&body)
        .map_err(|error| format!("Respuesta JSON inválida de OpenCode Go: {error}"))
        .and_then(|payload| parse_usage_payload(&payload))
    {
        Ok(windows) => FetchOutcome {
            http_status: Some(status),
            windows: Some(windows),
            error: None,
            unauthorized: false,
            entitlement_error: false,
        },
        Err(error) => failure(Some(status), error, false),
    }
}

pub fn fetch_console(credential: &Credential) -> FetchOutcome {
    let client = match http_client() {
        Ok(client) => client,
        Err(error) => return failure(None, error, false),
    };

    let base = credential
        .console_base
        .as_deref()
        .unwrap_or(DEFAULT_CONSOLE_BASE)
        .trim_end_matches('/');
    let url = format!("{base}/{CONSOLE_STATUS_PATH}");

    let mut request = client
        .get(&url)
        .header(
            reqwest::header::AUTHORIZATION,
            format!("Bearer {}", credential.token),
        )
        .header(reqwest::header::ACCEPT, "application/json");
    if let Some(org_id) = &credential.org_id {
        request = request.header("x-org-id", org_id);
    }

    let response = match request.send() {
        Ok(response) => response,
        Err(error) => return failure(None, friendly_reqwest_error(&error), false),
    };

    let status = response.status().as_u16();
    let body = response.text().unwrap_or_default();

    if !(200..300).contains(&status) {
        return api_error(status, &body, &credential.token);
    }

    match serde_json::from_str::<Value>(&body)
        .map_err(|error| format!("Respuesta JSON inválida de OpenCode Console: {error}"))
        .and_then(|payload| parse_console_payload(&payload))
    {
        Ok(windows) => FetchOutcome {
            http_status: Some(status),
            windows: Some(windows),
            error: None,
            unauthorized: false,
            entitlement_error: false,
        },
        Err(error) => failure(Some(status), error, false),
    }
}

pub fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .user_agent(format!("kite-code/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| format!("No se pudo crear el cliente HTTP: {error}"))
}

pub fn friendly_reqwest_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "tiempo de espera agotado al consultar OpenCode Go.".to_string()
    } else if error.is_connect() {
        "no se pudo establecer conexión con OpenCode Go.".to_string()
    } else {
        format!("error de red al consultar OpenCode Go: {error}")
    }
}

pub fn failure(status: Option<u16>, message: String, unauthorized: bool) -> FetchOutcome {
    FetchOutcome {
        http_status: status,
        windows: None,
        error: Some(message),
        unauthorized,
        entitlement_error: false,
    }
}

pub fn api_error(status: u16, body: &str, token: &str) -> FetchOutcome {
    let detail = sanitize(body, token);
    let entitlement_error = status == 403 && body.contains("EntitlementError");
    let message = match status {
        401 => with_detail(
            "API key de OpenCode Go inválida o expirada (HTTP 401). Ejecutá `opencode auth login opencode-go` o guardá una key válida."
                .to_string(),
            &detail,
        ),
        403 if entitlement_error => {
            "La cuenta no tiene una suscripción OpenCode Go activa (HTTP 403).".to_string()
        }
        403 => with_detail(
            "OpenCode Go rechazó la solicitud (HTTP 403).".to_string(),
            &detail,
        ),
        404 => with_detail(
            "OpenCode Go no encontró una suscripción para esta cuenta (HTTP 404).".to_string(),
            &detail,
        ),
        _ => with_detail(format!("OpenCode Go respondió HTTP {status}."), &detail),
    };

    let mut outcome = failure(Some(status), message, status == 401);
    outcome.entitlement_error = entitlement_error;
    outcome
}

pub fn with_detail(base: String, detail: &str) -> String {
    if detail.is_empty() {
        base
    } else {
        format!("{base} {detail}")
    }
}

pub fn sanitize(text: &str, token: &str) -> String {
    let redacted = if token.is_empty() {
        text.to_string()
    } else {
        text.replace(token, "[redacted]")
    };
    redacted
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(240)
        .collect()
}

pub fn parse_usage_payload(payload: &Value) -> Result<Vec<WindowData>, String> {
    let usage = payload
        .get("usage")
        .and_then(Value::as_object)
        .ok_or_else(|| "Respuesta inválida de OpenCode Go: falta `usage`.".to_string())?;

    let mut windows = Vec::with_capacity(WINDOW_KEYS.len());
    for (key, name) in WINDOW_KEYS {
        let raw = usage.get(key).and_then(Value::as_object).ok_or_else(|| {
            format!("Respuesta inválida de OpenCode Go: falta la ventana `{key}`.")
        })?;

        let status = raw
            .get("status")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("Ventana `{key}` sin estado."))?;
        if status != "ok" && status != "rate-limited" {
            return Err(format!("Ventana `{key}` con estado desconocido: {status}."));
        }

        let percent = raw
            .get("percent")
            .and_then(Value::as_f64)
            .ok_or_else(|| format!("Ventana `{key}` sin porcentaje."))?;
        if !percent.is_finite() || !(0.0..=100.0).contains(&percent) {
            return Err(format!("Ventana `{key}` con porcentaje inválido: {percent}."));
        }

        let resets_at = raw
            .get("resetsAt")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("Ventana `{key}` sin `resetsAt`."))?;
        let reset_ms = parse_rfc3339_ms(resets_at)
            .ok_or_else(|| format!("Ventana `{key}` con `resetsAt` inválido: {resets_at}."))?;

        let exhausted = status == "rate-limited";
        windows.push(WindowData {
            key,
            name,
            usage_percent: if exhausted { 100.0 } else { percent },
            resets_at: resets_at.to_string(),
            reset_ms,
            exhausted,
        });
    }

    Ok(windows)
}

pub fn parse_console_payload(payload: &Value) -> Result<Vec<WindowData>, String> {
    let access = payload
        .get("access")
        .and_then(Value::as_object)
        .ok_or_else(|| "La cuenta de OpenCode Console no tiene una suscripción Go activa.".to_string())?;
    let meters = access
        .get("meters")
        .and_then(Value::as_object)
        .ok_or_else(|| "OpenCode Console no devolvió medidores de cuota.".to_string())?;
    let ends_at = access.get("endsAt").and_then(Value::as_str);

    let mut windows = Vec::with_capacity(WINDOW_KEYS.len());
    for (key, name, meter_key) in [
        ("rolling", "5 horas", "fiveHour"),
        ("weekly", "Semanal", "week"),
        ("monthly", "Mensual", "month"),
    ] {
        let meter = meters
            .get(meter_key)
            .and_then(Value::as_object)
            .ok_or_else(|| format!("OpenCode Console no devolvió el medidor `{meter_key}`."))?;

        let limit = meter.get("limitMicroCents").and_then(value_to_i64);
        let used = meter.get("usedMicroCents").and_then(value_to_i64);
        let (Some(limit), Some(used)) = (limit, used) else {
            return Err(format!("El medidor `{meter_key}` tiene microcents inválidos."));
        };
        if limit < 0 || used < 0 {
            return Err(format!("El medidor `{meter_key}` tiene valores negativos."));
        }

        let percent = if limit == 0 {
            if used > 0 {
                100.0
            } else {
                0.0
            }
        } else {
            ((used as f64 / limit as f64) * 100.0).round().clamp(0.0, 100.0)
        };

        let resets_at = meter
            .get("resetsAt")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .or(ends_at)
            .ok_or_else(|| format!("El medidor `{meter_key}` no tiene fecha de reset."))?;
        let reset_ms = parse_rfc3339_ms(resets_at)
            .ok_or_else(|| format!("El medidor `{meter_key}` tiene un reset inválido: {resets_at}."))?;

        windows.push(WindowData {
            key,
            name,
            usage_percent: percent,
            resets_at: resets_at.to_string(),
            reset_ms,
            exhausted: percent >= 100.0,
        });
    }

    Ok(windows)
}

pub fn parse_rfc3339_ms(value: &str) -> Option<i64> {
    let value = value.trim();
    let (date, rest) = value
        .split_once('T')
        .or_else(|| value.split_once(' '))?;

    let mut date_parts = date.split('-');
    let year: i64 = date_parts.next()?.parse().ok()?;
    let month: i64 = date_parts.next()?.parse().ok()?;
    let day: i64 = date_parts.next()?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }

    let (time, offset_seconds) = if let Some(time) = rest.strip_suffix('Z').or_else(|| rest.strip_suffix('z')) {
        (time, 0)
    } else {
        let offset_index = rest.rfind(|ch| ch == '+' || ch == '-')?;
        let (time, offset) = rest.split_at(offset_index);
        let sign = if offset.starts_with('-') { -1 } else { 1 };
        let (hours, minutes) = offset[1..].split_once(':').unwrap_or((&offset[1..], "0"));
        let hours: i64 = hours.parse().ok()?;
        let minutes: i64 = minutes.parse().ok()?;
        if hours > 23 || minutes > 59 {
            return None;
        }
        (time, sign * (hours * 3600 + minutes * 60))
    };

    let (time, millis) = match time.split_once('.') {
        Some((time, fraction)) => {
            let digits: String = fraction.chars().take(3).collect();
            let mut millis: i64 = digits.parse().ok()?;
            if digits.len() == 1 {
                millis *= 100;
            } else if digits.len() == 2 {
                millis *= 10;
            }
            (time, millis)
        }
        None => (time, 0),
    };

    let mut time_parts = time.split(':');
    let hour: i64 = time_parts.next()?.parse().ok()?;
    let minute: i64 = time_parts.next()?.parse().ok()?;
    let second: i64 = time_parts.next()?.parse().ok()?;
    if hour > 23 || minute > 59 || second > 60 {
        return None;
    }

    let days = days_from_civil(year, month, day);
    Some((days * 86_400 + hour * 3_600 + minute * 60 + second - offset_seconds) * 1_000 + millis)
}

pub fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_prime = (month + 9) % 12;
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}
