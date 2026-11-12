use crate::connections::{
    build_connection, connection_id_for, ConnectionDraft, ConnectionRecord, ConnectionRegistry,
    EndpointVerification,
};
use crate::logger::log_trace;
use crate::quota::types::{ProviderQuotaStatus, QuotaWindow};
use crate::quota::utils::{now_ms, user_home_dir};
use serde_json::json;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use super::client::{
    fetch_console, fetch_usage, EndpointProbe, FetchOutcome, WindowData,
    OPENCODE_GO_USAGE_ENDPOINT,
};
use super::credentials::{
    console_credential_from_data_paths, go_api_key_credential, resolve_credential, Credential,
    CredentialKind,
};

pub fn build_connection_record(
    credential: &Credential,
    probe: &EndpointProbe,
    existing: Option<ConnectionRecord>,
) -> ConnectionRecord {
    let driver_kind = "opencode".to_string();
    let auth_method = credential.connection_auth_method().to_string();
    let account_identity = credential.connection_identity();
    let connection_id = connection_id_for(&driver_kind, &auth_method, &account_identity);

    let mut endpoints: Vec<EndpointVerification> = existing
        .filter(|record| record.connection_id == connection_id)
        .map(|record| record.endpoints)
        .unwrap_or_default()
        .into_iter()
        .filter(|endpoint| endpoint.endpoint_id != probe.endpoint_id)
        .collect();

    if credential.endpoint_supported(&probe.endpoint_id, probe.session_header_sent) {
        endpoints.push(EndpointVerification {
            endpoint_id: probe.endpoint_id.clone(),
            ok: probe.ok,
        });
    }
    endpoints.sort_by(|left, right| left.endpoint_id.cmp(&right.endpoint_id));

    let billing_mode = credential.connection_billing_mode();
    let draft = ConnectionDraft {
        driver_kind,
        auth_method,
        account_identity,
        billing_mode: billing_mode.clone(),
        endpoints,
    };
    // The shared builder owns the rule that a Go key is never valid on a
    // pay-as-you-go chat route. Rebuilding through it also drops rows an older
    // store may have written under that combination.
    let built = build_connection(draft);
    for endpoint in &built.rejected {
        log_trace(&format!(
            "opencode connections: dropped unsupported endpoint {endpoint}"
        ));
    }

    let status = if probe.ok {
        "verified"
    } else if probe.entitlement_error {
        "entitlement_error"
    } else if probe.http_status == Some(401) {
        "unauthenticated"
    } else {
        "error"
    };

    ConnectionRecord {
        connection_id: built.connection_id,
        driver_kind: "opencode".to_string(),
        display_name: credential.connection_display_name().to_string(),
        auth_method: credential.connection_auth_method().to_string(),
        account_identity: credential.connection_identity(),
        credential_ref: credential.connection_credential_ref().to_string(),
        billing_mode,
        endpoints: built.endpoints,
        status: status.to_string(),
        last_checked_ms: Some(now_ms()),
        expires_ms: credential.expires_ms,
        last_http_status: probe.http_status.map(i64::from),
    }
}

pub fn persist_probe(
    registry: &mut ConnectionRegistry,
    credential: &Credential,
    probe: &EndpointProbe,
) -> Result<(), String> {
    let connection_id = connection_id_for(
        "opencode",
        credential.connection_auth_method(),
        &credential.connection_identity(),
    );
    let existing = registry.load(&connection_id)?;
    let record = build_connection_record(credential, probe, existing);
    registry.save(&record)
}

/// Stores a discovered Console session as its own connection with no verified
/// endpoint. It never overwrites an existing row, so a later successful probe
/// is not replaced by the discovery pass.
pub fn persist_known_console_connection(
    registry: &mut ConnectionRegistry,
    credential: &Credential,
) -> Result<(), String> {
    if credential.kind != CredentialKind::Console {
        return Ok(());
    }
    let connection_id = connection_id_for(
        "opencode",
        "console_oauth",
        &credential.connection_identity(),
    );
    if registry.load(&connection_id)?.is_some() {
        return Ok(());
    }
    registry.save(&ConnectionRecord {
        connection_id,
        driver_kind: "opencode".to_string(),
        display_name: credential.connection_display_name().to_string(),
        auth_method: "console_oauth".to_string(),
        account_identity: credential.connection_identity(),
        credential_ref: credential.connection_credential_ref().to_string(),
        billing_mode: None,
        endpoints: Vec::new(),
        status: "unverified".to_string(),
        last_checked_ms: None,
        expires_ms: credential.expires_ms,
        last_http_status: None,
    })
}

pub fn ensure_known_console_connection(credential: &Credential) {
    let result = ConnectionRegistry::open()
        .and_then(|mut registry| persist_known_console_connection(&mut registry, credential));
    if let Err(error) = result {
        log_trace(&format!(
            "opencode connections: could not record the Console session: {error}"
        ));
    }
}

pub fn probe_from_outcome(endpoint_id: &str, outcome: &FetchOutcome) -> Option<EndpointProbe> {
    // No HTTP response means the request never reached the endpoint. That is
    // not evidence against a previous verification.
    let http_status = outcome.http_status?;
    Some(EndpointProbe {
        endpoint_id: endpoint_id.to_string(),
        ok: outcome.windows.is_some(),
        http_status: Some(http_status),
        session_header_sent: false,
        entitlement_error: outcome.entitlement_error,
    })
}

pub fn record_quota_probe(credential: &Credential, endpoint_id: &str, outcome: &FetchOutcome) {
    let Some(probe) = probe_from_outcome(endpoint_id, outcome) else {
        return;
    };
    let result = ConnectionRegistry::open()
        .and_then(|mut registry| persist_probe(&mut registry, credential, &probe));
    if let Err(error) = result {
        log_trace(&format!(
            "opencode connections: could not record the quota probe: {error}"
        ));
    }
}

/// Records one OpenCode Go endpoint after a real request. The caller passes the
/// `x-opencode-session` value it actually sent; the chat endpoint is only
/// verifiable with one. Endpoints this auth method cannot serve are ignored.
pub fn record_opencode_go_probe(
    endpoint_id: &str,
    session_header: Option<&str>,
    ok: bool,
    http_status: Option<u16>,
) {
    let session_sent = session_header
        .map(str::trim)
        .is_some_and(|value| !value.is_empty());

    let home = user_home_dir();
    let Some(credential) = go_api_key_credential(resolve_credential(&home).0) else {
        return;
    };
    if !credential.endpoint_supported(endpoint_id, session_sent) {
        return;
    }
    let probe = EndpointProbe {
        endpoint_id: endpoint_id.to_string(),
        ok,
        http_status,
        session_header_sent: session_sent,
        entitlement_error: false,
    };
    let result = ConnectionRegistry::open()
        .and_then(|mut registry| persist_probe(&mut registry, &credential, &probe));
    if let Err(error) = result {
        log_trace(&format!(
            "opencode connections: could not record the Go probe: {error}"
        ));
    }
}

pub fn fetch_opencode_quota() -> ProviderQuotaStatus {
    let home = user_home_dir();
    let mut status = base_status();
    status.is_available = opencode_detected(&home);
    status
        .metadata
        .insert("quotaSchema".to_string(), json!(2));

    let (credential, notes) = resolve_credential(&home);
    if let Some(note) = notes.first() {
        status.metadata.insert("legacyNote".to_string(), json!(note));
    }

    let Some(cred) = credential else {
        status.error = Some(
            "OpenCode Go no tiene credenciales. Ejecutá `opencode auth login opencode-go` o guardá una API key en Kite."
                .to_string(),
        );
        return status;
    };

    status.is_available = true;
    status.is_auth = true;
    status.metadata.insert("authSource".to_string(), json!(cred.source));

    if cred.kind == CredentialKind::ApiKey {
        if let Some(console) = console_credential_from_data_paths(&home) {
            ensure_known_console_connection(&console);
        }
    } else {
        ensure_known_console_connection(&cred);
    }

    if cred.kind == CredentialKind::Console {
        if let Some(expires) = cred.expires_ms {
            if expires <= now_ms() {
                status.is_auth = false;
                status.error = Some(
                    "La sesión de OpenCode Console expiró. Ejecutá `opencode auth login opencode` o guardá una API key de Go."
                        .to_string(),
                );
                return status;
            }
        }
    }

    let endpoint = match cred.kind {
        CredentialKind::ApiKey => OPENCODE_GO_USAGE_ENDPOINT.to_string(),
        CredentialKind::Console => cred.console_status_url(),
    };
    status.metadata.insert("source".to_string(), json!(cred.source));

    let outcome = match cred.kind {
        CredentialKind::ApiKey => fetch_usage(&cred),
        CredentialKind::Console => fetch_console(&cred),
    };

    // Persist the endpoint this probe actually reached. A successful usage
    // probe never marks a chat route, and a Console probe never marks a Go
    // inference route.
    record_quota_probe(&cred, &endpoint, &outcome);
    status.metadata.insert("endpoint".to_string(), json!(endpoint));

    if let Some(code) = outcome.http_status {
        status.metadata.insert("httpStatus".to_string(), json!(code));
    }

    match outcome.windows {
        Some(windows) => apply_windows(&mut status, windows),
        None => {
            if outcome.unauthorized {
                status.is_auth = false;
            }
            status.error = Some(
                outcome
                    .error
                    .unwrap_or_else(|| "No se pudo consultar la cuota de OpenCode Go.".to_string()),
            );
        }
    }

    status
}

pub fn base_status() -> ProviderQuotaStatus {
    ProviderQuotaStatus {
        provider_id: "opencode".to_string(),
        display_name: "OpenCode Go".to_string(),
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
    }
}

pub fn opencode_detected(home: &Path) -> bool {
    let mut paths = vec![
        home.join(".opencode"),
        home.join(".local").join("share").join("opencode"),
        home.join(".config").join("opencode"),
        home.join(".config").join("opencode").join("opencode.json"),
        home.join(".config").join("opencode").join("opencode.jsonc"),
    ];
    if let Some(appdata) = std::env::var_os("APPDATA") {
        paths.push(PathBuf::from(appdata).join("opencode"));
    }
    paths.iter().any(|path| path.exists())
}

pub fn apply_windows(status: &mut ProviderQuotaStatus, windows: Vec<WindowData>) {
    if windows.is_empty() {
        status.error = Some("OpenCode Go no devolvió ventanas de cuota.".to_string());
        return;
    }

    let now = now_ms();
    let mut primary = 0usize;
    for (index, window) in windows.iter().enumerate() {
        if window.usage_percent > windows[primary].usage_percent {
            primary = index;
        }
    }

    status.windows = windows
        .iter()
        .map(|window| QuotaWindow {
            name: window.name.to_string(),
            usage_percent: window.usage_percent,
            remaining_fraction: ((100.0 - window.usage_percent) / 100.0).clamp(0.0, 1.0),
            resets_at: Some(window.resets_at.clone()),
            time_until_reset_ms: Some((window.reset_ms - now).max(0)),
            is_exhausted: window.exhausted || window.usage_percent >= 100.0,
        })
        .collect();

    let selected = &windows[primary];
    status.primary_usage_percent = selected.usage_percent;
    status.primary_remaining_percent = (100.0 - selected.usage_percent).clamp(0.0, 100.0);
    status.primary_reset_at = Some(selected.resets_at.clone());
    status.time_until_reset_ms = Some((selected.reset_ms - now).max(0));
    status.error = None;

    status.metadata.insert(
        "primaryWindow".to_string(),
        json!(if selected.key == "rolling" {
            "5h"
        } else {
            selected.key
        }),
    );
    status.metadata.insert(
        "primaryWindowLabel".to_string(),
        json!(selected.name),
    );
    status.metadata.insert(
        "windowStatuses".to_string(),
        json!(windows
            .iter()
            .map(|window| json!({
                "name": window.name,
                "usagePercent": window.usage_percent,
                "exhausted": window.exhausted
            }))
            .collect::<Vec<_>>()),
    );
}
