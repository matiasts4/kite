use super::credentials::{
    antigravity_api_key_present, enrich_google_identity, google_identity_is_antigravity_owned,
    read_google_identity,
};
use super::process::{
    detect_antigravity_process, discover_listening_ports, probe_antigravity_rpc,
    resolve_antigravity_binary,
};
use crate::connections::{
    build_connection, connection_id_for, AccountIdentity, ConnectionDraft, ConnectionRecord,
    ConnectionRegistry, EndpointVerification,
};
use crate::logger::log_trace;
use crate::quota::types::{ProviderQuotaStatus, QuotaWindow};
use crate::quota::utils::{chrono_parse_rfc3339, now_ms};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::Duration;

pub fn fetch_antigravity_quota() -> ProviderQuotaStatus {
    let mut status = ProviderQuotaStatus {
        provider_id: "antigravity".to_string(),
        display_name: "Antigravity".to_string(),
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

    // Record the auth methods this poll can see. Identity files and a stored key
    // never verify an endpoint by themselves.
    let google_identity = read_google_identity();
    let google_connection_identity = google_identity.as_ref().map(|identity| AccountIdentity {
        email: Some(identity.email.clone()),
        org_id: None,
        account_id: None,
    });
    if google_identity
        .as_ref()
        .map_or(false, google_identity_is_antigravity_owned)
    {
        record_google_oauth_connection(google_connection_identity.as_ref());
    }
    if antigravity_api_key_present() {
        persist_antigravity_connection("api_key", |registry| {
            record_api_key_selected(registry, &AccountIdentity::default())
        });
    }

    // 1. Primary strategy: Antigravity CLI print-mode slash command
    // Runs `agy -p /usage --output-format json --print-timeout 12s`
    //
    // The probe runs inside a *hidden* console (`crate::hidden_exec`). `agy`
    // boots its configured MCP servers and helper processes on every run; when
    // the CLI is started with no console at all, those console children create
    // their own console and Windows shows it as an external terminal window for
    // a few milliseconds. Giving the CLI an invisible console keeps the whole
    // tree attached to it, so nothing can pop up while quotas are polled.
    //
    // In addition, `agy` spawns a detached `--bg-updater` daemon that calls
    // `agy.exe --version` without `CREATE_NO_WINDOW`, causing Windows 11 Console
    // Delegation to flash a terminal window. We ensure `AGY_CLI_DISABLE_AUTO_UPDATE=1`
    // is set in the environment to completely suppress updater activity.
    if std::env::var("AGY_CLI_DISABLE_AUTO_UPDATE").is_err() {
        std::env::set_var("AGY_CLI_DISABLE_AUTO_UPDATE", "true");
    }

    let agy_bin = resolve_antigravity_binary();
    let agy_args = ["-p", "/usage", "--output-format", "json", "--print-timeout", "12s"];

    if let Ok(out) = crate::hidden_exec::run(&agy_bin, &agy_args, Duration::from_secs(20)) {
        if out.success() {
            let stdout_str = String::from_utf8_lossy(&out.stdout);
            if let Ok(json_val) = serde_json::from_str::<Value>(&stdout_str) {
                if let Some(groups) = json_val.pointer("/command/data/groups").and_then(|v| v.as_array()) {
                    let mut min_remaining = 1.0f64;
                    let mut earliest_reset_ms: Option<i64> = None;
                    let mut primary_reset_at: Option<String> = None;

                    // Dedicated tracking for Gemini Models 5-hour limit
                    let mut gemini_5h_bucket: Option<(f64, Option<String>, Option<i64>)> = None;
                    let mut gemini_any_bucket: Option<(f64, Option<String>, Option<i64>)> = None;

                    for g in groups {
                        let group_name = g.get("name").and_then(|v| v.as_str()).unwrap_or("Model Pool");
                        let is_gemini_models = group_name.to_lowercase().contains("gemini")
                            && !group_name.to_lowercase().contains("argon");
                        let buckets = g.get("buckets").and_then(|v| v.as_array()).cloned().unwrap_or_default();

                        for b in buckets {
                            if b.get("disabled").and_then(|v| v.as_bool()).unwrap_or(false) {
                                continue;
                            }
                            let rem_fraction = match b.get("remaining_fraction").and_then(|v| v.as_f64()) {
                                Some(f) => f.clamp(0.0, 1.0),
                                None => continue,
                            };
                            let bucket_name = b.get("name").and_then(|v| v.as_str()).unwrap_or("Límite");
                            let reset_time = b.get("reset_time").and_then(|v| v.as_str()).map(|s| s.to_string());
                            let b_id = b.get("id").and_then(|v| v.as_str()).unwrap_or("");
                            let b_window = b.get("window").and_then(|v| v.as_str()).unwrap_or("");

                            let mut time_until_reset_ms: Option<i64> = None;
                            if let Some(ref rt) = reset_time {
                                if let Ok(parsed) = chrono_parse_rfc3339(rt) {
                                    let ms = (parsed - now_ms()).max(0);
                                    time_until_reset_ms = Some(ms);
                                    if earliest_reset_ms.is_none() || ms < earliest_reset_ms.unwrap() {
                                        earliest_reset_ms = Some(ms);
                                        primary_reset_at = Some(rt.clone());
                                    }
                                }
                            }

                            if rem_fraction < min_remaining {
                                min_remaining = rem_fraction;
                            }

                            // Detect 5-hour limit for Gemini Models
                            let is_5h = b_id.contains("5h")
                                || b_window == "5h"
                                || bucket_name.to_lowercase().contains("five hour")
                                || bucket_name.to_lowercase().contains("5 hour")
                                || bucket_name.to_lowercase().contains("5h");

                            if is_gemini_models {
                                if is_5h && gemini_5h_bucket.is_none() {
                                    gemini_5h_bucket = Some((rem_fraction, reset_time.clone(), time_until_reset_ms));
                                }
                                if gemini_any_bucket.is_none() {
                                    gemini_any_bucket = Some((rem_fraction, reset_time.clone(), time_until_reset_ms));
                                }
                            }

                            let usage_pct = ((1.0 - rem_fraction) * 100.0).round();
                            let clean_bucket = bucket_name.replace(" Limit Remaining", "");
                            let window_label = format!("{} ({})", group_name, clean_bucket);

                            status.windows.push(QuotaWindow {
                                name: window_label,
                                usage_percent: usage_pct,
                                remaining_fraction: (rem_fraction * 100.0).round() / 100.0,
                                resets_at: reset_time,
                                time_until_reset_ms,
                                is_exhausted: rem_fraction <= 0.0,
                            });
                        }
                    }

                    if !status.windows.is_empty() {
                        status.is_available = true;
                        status.is_auth = true;

                        // Prefer the 5-hour limit for Gemini Models as requested by user
                        if let Some((frac, reset_at, until_ms)) = gemini_5h_bucket {
                            let rem_pct = (frac * 100.0).round();
                            status.primary_remaining_percent = rem_pct;
                            status.primary_usage_percent = 100.0 - rem_pct;
                            status.primary_reset_at = reset_at;
                            status.time_until_reset_ms = until_ms;
                            status.metadata.insert("primaryWindow".to_string(), json!("5h"));
                            status.metadata.insert("primaryWindowLabel".to_string(), json!("5h"));
                        } else if let Some((frac, reset_at, until_ms)) = gemini_any_bucket {
                            let rem_pct = (frac * 100.0).round();
                            status.primary_remaining_percent = rem_pct;
                            status.primary_usage_percent = 100.0 - rem_pct;
                            status.primary_reset_at = reset_at;
                            status.time_until_reset_ms = until_ms;
                        } else {
                            let rem_pct = (min_remaining * 100.0).round();
                            status.primary_remaining_percent = rem_pct;
                            status.primary_usage_percent = 100.0 - rem_pct;
                            status.primary_reset_at = primary_reset_at;
                            status.time_until_reset_ms = earliest_reset_ms;
                        }

                        status.metadata.insert("source".to_string(), json!("agy CLI"));
                        enrich_google_identity(&mut status);
                        let cli_identity = google_connection_identity.clone().unwrap_or_default();
                        // A successful CLI quota probe also proves Antigravity is
                        // installed, so shared Google files become attributable.
                        record_google_oauth_connection(google_connection_identity.as_ref());
                        persist_antigravity_connection("cli_session", |registry| {
                            record_cli_quota_probe(registry, &cli_identity)
                        });
                        return status;
                    }
                }
            }
        }
    }

    // 2. Secondary Fallback: Antigravity Language Server Process RPC (if IDE is running)
    let proc_info = match detect_antigravity_process() {
        Some(info) => info,
        None => {
            status.error = Some("CLI de Antigravity (agy) no respondió y el servidor de lenguaje no está activo".to_string());
            return status;
        }
    };

    status.is_available = true;

    let mut ports = Vec::new();
    if proc_info.port > 0 {
        ports.push(proc_info.port);
    }
    for p in discover_listening_ports(proc_info.pid) {
        if !ports.contains(&p) {
            ports.push(p);
        }
    }

    let mut response_payload: Option<Value> = None;
    for port in ports {
        if let Some(val) = probe_antigravity_rpc(port, &proc_info.csrf_token) {
            response_payload = Some(val);
            break;
        }
    }

    let payload = match response_payload {
        Some(p) => p,
        None => {
            status.error = Some("Could not reach Antigravity Language Server RPC".to_string());
            return status;
        }
    };

    let user_status = match payload.get("userStatus") {
        Some(u) => u,
        None => {
            status.error = Some("Antigravity userStatus not returned".to_string());
            return status;
        }
    };

    status.is_auth = true;

    if let Some(email) = user_status.get("email").and_then(|v| v.as_str()) {
        status.metadata.insert("email".to_string(), json!(email));
    }
    if let Some(name) = user_status.get("name").and_then(|v| v.as_str()) {
        status.metadata.insert("name".to_string(), json!(name));
    }

    let rpc_email = user_status
        .get("email")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let rpc_identity = AccountIdentity {
        email: rpc_email.or_else(|| {
            google_connection_identity
                .as_ref()
                .and_then(|identity| identity.email.clone())
        }),
        org_id: None,
        account_id: None,
    };
    // The RPC responds, so Antigravity is present. Google files are still
    // identity only, and the RPC verifies the quota route, not CLI chat or ACP.
    record_google_oauth_connection(google_connection_identity.as_ref());
    persist_antigravity_connection("local_rpc", |registry| {
        record_local_rpc_probe(registry, &rpc_identity)
    });

    let plan_name = user_status
        .pointer("/planStatus/planInfo/planName")
        .and_then(|v| v.as_str())
        .unwrap_or("Pro");
    status.metadata.insert("planType".to_string(), json!(plan_name));

    let configs = user_status
        .pointer("/cascadeModelConfigData/clientModelConfigs")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut min_remaining = 1.0f64;
    let mut earliest_reset_ms: Option<i64> = None;
    let mut primary_reset_at: Option<String> = None;

    for cfg in configs {
        let quota = match cfg.get("quotaInfo") {
            Some(q) => q,
            None => continue,
        };
        let rem_fraction = match quota.get("remainingFraction").and_then(|v| v.as_f64()) {
            Some(f) => f.clamp(0.0, 1.0),
            None => continue,
        };

        let label = cfg
            .get("label")
            .and_then(|v| v.as_str())
            .unwrap_or("Model")
            .replace("(Thinking)", "")
            .trim()
            .to_string();

        let reset_time = quota.get("resetTime").and_then(|v| v.as_str()).map(|s| s.to_string());

        let mut time_until_reset_ms: Option<i64> = None;
        if let Some(ref rt) = reset_time {
            if let Ok(parsed) = chrono_parse_rfc3339(rt) {
                let ms = (parsed - now_ms()).max(0);
                time_until_reset_ms = Some(ms);
                if earliest_reset_ms.is_none() || ms < earliest_reset_ms.unwrap() {
                    earliest_reset_ms = Some(ms);
                    primary_reset_at = Some(rt.clone());
                }
            }
        }

        if rem_fraction < min_remaining {
            min_remaining = rem_fraction;
        }

        let usage_pct = ((1.0 - rem_fraction) * 100.0).round();

        status.windows.push(QuotaWindow {
            name: label,
            usage_percent: usage_pct,
            remaining_fraction: rem_fraction,
            resets_at: reset_time,
            time_until_reset_ms,
            is_exhausted: rem_fraction <= 0.0,
        });
    }

    if status.windows.is_empty() {
        status.windows.push(QuotaWindow {
            name: "Primary Quota".to_string(),
            usage_percent: 0.0,
            remaining_fraction: 1.0,
            resets_at: None,
            time_until_reset_ms: None,
            is_exhausted: false,
        });
    }

    let rem_pct = (min_remaining * 100.0).round();
    status.primary_remaining_percent = rem_pct;
    status.primary_usage_percent = 100.0 - rem_pct;
    status.primary_reset_at = primary_reset_at;
    status.time_until_reset_ms = earliest_reset_ms;

    status
}

// ---------------------------------------------------------------------------
// Antigravity connections
//
// One connection is one account plus one auth method. API key, ACP, Google
// OAuth, the CLI session, and the local language server each get their own
// connection, and each one verifies only the endpoints it actually served.
// ---------------------------------------------------------------------------

/// Quota through the `agy` CLI print mode.
pub const ANTIGRAVITY_CLI_QUOTA_ENDPOINT: &str = "cli:agy -p /usage";
/// Chat through `agy -p`. A quota probe does not verify this route.
pub const ANTIGRAVITY_CLI_CHAT_ENDPOINT: &str = "cli:agy -p";
/// Quota through the local language server, authenticated with
/// `X-Codeium-Csrf-Token`.
pub const ANTIGRAVITY_RPC_QUOTA_ENDPOINT: &str = "rpc:LanguageServerService/GetUserStatus";
/// ACP session route used by the subscription auth method.
pub const ANTIGRAVITY_ACP_CHAT_ENDPOINT: &str = "acp:session/new";

pub const ANTIGRAVITY_DRIVER_KIND: &str = "antigravity";

/// Every way into Antigravity. They verify different endpoints, so they are
/// stored as separate connections even when they share one account.
pub const ANTIGRAVITY_AUTH_METHODS: &[&str] = &[
    "api_key",
    "cli_session",
    "local_rpc",
    "google_oauth",
    "acp",
];

pub fn record_cli_quota_probe(
    registry: &mut ConnectionRegistry,
    identity: &AccountIdentity,
) -> Result<ConnectionRecord, String> {
    // `agy -p /usage` proves the CLI is signed in. It says nothing about
    // `agy -p` chat, so only the quota endpoint is written here.
    upsert_antigravity_connection(
        registry,
        "cli_session",
        identity,
        Some((ANTIGRAVITY_CLI_QUOTA_ENDPOINT, true, None)),
        "error",
    )
}

pub fn record_local_rpc_probe(
    registry: &mut ConnectionRegistry,
    identity: &AccountIdentity,
) -> Result<ConnectionRecord, String> {
    // The language server RPC is its own route. RPC success never verifies the
    // CLI chat route, and it is not an ACP session.
    upsert_antigravity_connection(
        registry,
        "local_rpc",
        identity,
        Some((ANTIGRAVITY_RPC_QUOTA_ENDPOINT, true, None)),
        "error",
    )
}

pub fn record_google_identity_probe(
    registry: &mut ConnectionRegistry,
    identity: &AccountIdentity,
) -> Result<ConnectionRecord, String> {
    // Google files and the Windows credential are identity. They are stored
    // without endpoints because Kite does not send that token anywhere.
    upsert_antigravity_connection(registry, "google_oauth", identity, None, "identity_only")
}

pub fn record_api_key_selected(
    registry: &mut ConnectionRegistry,
    identity: &AccountIdentity,
) -> Result<ConnectionRecord, String> {
    // A stored key identifies a connection but verifies no route by itself.
    upsert_antigravity_connection(registry, "api_key", identity, None, "unverified")
}

pub fn record_acp_selected(
    registry: &mut ConnectionRegistry,
    identity: &AccountIdentity,
) -> Result<ConnectionRecord, String> {
    // The method may be selected before any ACP process exists. Selection is
    // not a session, so every endpoint stays `ok = false`.
    upsert_antigravity_connection(registry, "acp", identity, None, "unverified")
}

pub fn record_acp_session_probe(
    registry: &mut ConnectionRegistry,
    identity: &AccountIdentity,
    session_id: &str,
) -> Result<ConnectionRecord, String> {
    if session_id.trim().is_empty() {
        return Err("antigravity: an ACP session id is required".to_string());
    }
    upsert_antigravity_connection(
        registry,
        "acp",
        identity,
        Some((ANTIGRAVITY_ACP_CHAT_ENDPOINT, true, None)),
        "error",
    )
}

/// Endpoint this auth method proves by itself. A stored API key, a Google
/// account file, or a resolved binary proves identity at most.
pub fn antigravity_endpoint_supported(auth_method: &str, endpoint_id: &str) -> bool {
    match auth_method {
        "cli_session" => endpoint_id == ANTIGRAVITY_CLI_QUOTA_ENDPOINT,
        "local_rpc" => endpoint_id == ANTIGRAVITY_RPC_QUOTA_ENDPOINT,
        "acp" => endpoint_id == ANTIGRAVITY_ACP_CHAT_ENDPOINT,
        _ => false,
    }
}

pub fn antigravity_display_name(auth_method: &str) -> &'static str {
    match auth_method {
        "api_key" => "Antigravity API key",
        "cli_session" => "Antigravity CLI",
        "local_rpc" => "Antigravity Language Server",
        "google_oauth" => "Antigravity Google",
        "acp" => "Antigravity ACP",
        _ => "Antigravity",
    }
}

pub fn antigravity_credential_ref(auth_method: &str) -> &'static str {
    if auth_method == "api_key" {
        "vault"
    } else {
        "cli_file"
    }
}

pub fn antigravity_billing_mode(auth_method: &str) -> Option<String> {
    match auth_method {
        // An API key is not the subscription path; its entitlement is unknown
        // until an endpoint answers.
        "api_key" => None,
        _ => Some("subscription".to_string()),
    }
}

pub fn upsert_antigravity_connection(
    registry: &mut ConnectionRegistry,
    auth_method: &str,
    identity: &AccountIdentity,
    probe: Option<(&str, bool, Option<i64>)>,
    unverified_status: &str,
) -> Result<ConnectionRecord, String> {
    if !ANTIGRAVITY_AUTH_METHODS.contains(&auth_method) {
        return Err(format!("antigravity: unknown auth method {auth_method}"));
    }
    if let Some((endpoint_id, _, _)) = probe {
        if !antigravity_endpoint_supported(auth_method, endpoint_id) {
            return Err(format!(
                "antigravity: {auth_method} cannot verify {endpoint_id}"
            ));
        }
    }

    let connection_id = connection_id_for(ANTIGRAVITY_DRIVER_KIND, auth_method, identity);
    let existing = registry.load(&connection_id)?;

    // Merge before saving: keep every endpoint this auth method can own so a
    // probe for one route never drops another verified route.
    let mut endpoints: Vec<EndpointVerification> = existing
        .as_ref()
        .map(|record| record.endpoints.as_slice())
        .unwrap_or_default()
        .iter()
        .filter(|endpoint| antigravity_endpoint_supported(auth_method, &endpoint.endpoint_id))
        .cloned()
        .collect();

    if let Some((endpoint_id, ok, _)) = probe {
        endpoints.retain(|endpoint| endpoint.endpoint_id != endpoint_id);
        endpoints.push(EndpointVerification {
            endpoint_id: endpoint_id.to_string(),
            ok,
        });
    }
    endpoints.sort_by(|left, right| left.endpoint_id.cmp(&right.endpoint_id));

    let built = build_connection(ConnectionDraft {
        driver_kind: ANTIGRAVITY_DRIVER_KIND.to_string(),
        auth_method: auth_method.to_string(),
        account_identity: identity.clone(),
        billing_mode: antigravity_billing_mode(auth_method),
        endpoints,
    });
    for endpoint in &built.rejected {
        log_trace(&format!(
            "antigravity connections: dropped unsupported endpoint {endpoint}"
        ));
    }

    let status = if built.endpoints.iter().any(|endpoint| endpoint.ok) {
        "verified"
    } else {
        unverified_status
    };
    let (last_checked_ms, expires_ms, last_http_status) = match &existing {
        Some(record) => (
            record.last_checked_ms,
            record.expires_ms,
            record.last_http_status,
        ),
        None => (None, None, None),
    };
    let (checked_at, http_status) = match probe {
        Some((_, _, http_status)) => (Some(now_ms()), http_status),
        None => (last_checked_ms, last_http_status),
    };

    let record = ConnectionRecord {
        connection_id: built.connection_id,
        driver_kind: ANTIGRAVITY_DRIVER_KIND.to_string(),
        display_name: antigravity_display_name(auth_method).to_string(),
        auth_method: auth_method.to_string(),
        account_identity: identity.clone(),
        credential_ref: antigravity_credential_ref(auth_method).to_string(),
        billing_mode: antigravity_billing_mode(auth_method),
        endpoints: built.endpoints,
        status: status.to_string(),
        last_checked_ms: checked_at,
        expires_ms,
        last_http_status: http_status,
    };
    registry.save(&record)?;
    Ok(record)
}

/// Persists one connection and logs the error instead of failing the quota
/// call. The named probe builders below are the only writers.
pub fn persist_antigravity_connection<F>(label: &str, persist: F)
where
    F: FnOnce(&mut ConnectionRegistry) -> Result<ConnectionRecord, String>,
{
    let result = ConnectionRegistry::open().and_then(|mut registry| persist(&mut registry));
    if let Err(error) = result {
        log_trace(&format!("antigravity connections: {label}: {error}"));
    }
}

pub fn record_google_oauth_connection(identity: Option<&AccountIdentity>) {
    if let Some(identity) = identity {
        persist_antigravity_connection("google_oauth", |registry| {
            record_google_identity_probe(registry, identity)
        });
    }
}

/// Records the ACP subscription method as selected. Resolving a binary or
/// selecting the method is not a session, so this never marks an endpoint `ok`.
pub fn select_antigravity_acp_connection(
    identity: &AccountIdentity,
) -> Result<ConnectionRecord, String> {
    let mut registry = ConnectionRegistry::open()?;
    record_acp_selected(&mut registry, identity)
}

/// Records a verified ACP endpoint. Call it only after the ACP process returns a
/// session id, never from the binary resolver.
pub fn record_antigravity_acp_session_established(
    identity: &AccountIdentity,
    session_id: &str,
) -> Result<ConnectionRecord, String> {
    let mut registry = ConnectionRegistry::open()?;
    record_acp_session_probe(&mut registry, identity, session_id)
}
