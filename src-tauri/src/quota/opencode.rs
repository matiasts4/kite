use crate::connections::{
    build_connection, connection_id_for, AccountIdentity, ConnectionDraft, ConnectionRecord,
    ConnectionRegistry, EndpointVerification,
};
use crate::logger::log_trace;
use crate::quota::types::{ProviderQuotaStatus, QuotaWindow};
use crate::quota::utils::{now_ms, user_home_dir};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const OPENCODE_GO_USAGE_ENDPOINT: &str = "https://opencode.ai/zen/go/v1/usage";
pub const OPENCODE_GO_MODELS_ENDPOINT: &str = "https://opencode.ai/zen/go/v1/models";
pub const OPENCODE_GO_CHAT_ENDPOINT: &str =
    "https://opencode.ai/inference/go/openai/v1/chat/completions";
const DEFAULT_CONSOLE_BASE: &str = "https://opencode.ai/console";
const CONSOLE_STATUS_PATH: &str = "api/go/status";
const REQUEST_TIMEOUT_SECS: u64 = 15;
const WINDOW_KEYS: [(&str, &str); 3] = [
    ("rolling", "5 horas"),
    ("weekly", "Semanal"),
    ("monthly", "Mensual"),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CredentialKind {
    ApiKey,
    Console,
}

#[derive(Debug, Clone)]
struct Credential {
    token: String,
    kind: CredentialKind,
    source: String,
    console_base: Option<String>,
    org_id: Option<String>,
    expires_ms: Option<i64>,
}

#[derive(Debug, Clone)]
struct WindowData {
    key: &'static str,
    name: &'static str,
    usage_percent: f64,
    resets_at: String,
    reset_ms: i64,
    exhausted: bool,
}

struct FetchOutcome {
    http_status: Option<u16>,
    windows: Option<Vec<WindowData>>,
    error: Option<String>,
    unauthorized: bool,
    entitlement_error: bool,
}

/// One endpoint probe result. A probe verifies only the endpoint it was sent
/// to; success elsewhere never implies success here.
#[derive(Debug, Clone)]
struct EndpointProbe {
    endpoint_id: String,
    ok: bool,
    http_status: Option<u16>,
    /// Whether `x-opencode-session` was sent with the request. The Go chat
    /// gateway rejects requests without it, so it cannot be verified otherwise.
    session_header_sent: bool,
    /// A 403 `EntitlementError` on Go means the account has no Go subscription.
    entitlement_error: bool,
}

impl Credential {
    fn connection_auth_method(&self) -> &'static str {
        match self.kind {
            CredentialKind::ApiKey => "api_key",
            CredentialKind::Console => "console_oauth",
        }
    }

    fn connection_identity(&self) -> AccountIdentity {
        AccountIdentity {
            email: None,
            org_id: self.org_id.clone(),
            account_id: None,
        }
    }

    fn connection_billing_mode(&self) -> Option<String> {
        match self.kind {
            CredentialKind::ApiKey => Some("subscription".to_string()),
            CredentialKind::Console => None,
        }
    }

    fn connection_display_name(&self) -> &'static str {
        match self.kind {
            CredentialKind::ApiKey => "OpenCode Go",
            CredentialKind::Console => "OpenCode Console",
        }
    }

    fn connection_credential_ref(&self) -> &'static str {
        if self.source.starts_with("Kite (") {
            "kite_file"
        } else if self.source.starts_with("Variable ") {
            "env"
        } else {
            "cli_file"
        }
    }

    fn console_status_url(&self) -> String {
        let base = self
            .console_base
            .as_deref()
            .unwrap_or(DEFAULT_CONSOLE_BASE)
            .trim_end_matches('/');
        format!("{base}/{CONSOLE_STATUS_PATH}")
    }

    /// Endpoints this auth method can verify. Go API keys never verify a
    /// pay-as-you-go chat route, and a Console OAuth token never verifies a Go
    /// inference route.
    fn endpoint_supported(&self, endpoint_id: &str, session_header_sent: bool) -> bool {
        match self.kind {
            CredentialKind::ApiKey => match endpoint_id {
                OPENCODE_GO_USAGE_ENDPOINT | OPENCODE_GO_MODELS_ENDPOINT => true,
                OPENCODE_GO_CHAT_ENDPOINT => session_header_sent,
                _ => false,
            },
            CredentialKind::Console => endpoint_id == self.console_status_url(),
        }
    }
}

fn build_connection_record(
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

fn persist_probe(
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
fn persist_known_console_connection(
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

fn ensure_known_console_connection(credential: &Credential) {
    let result = ConnectionRegistry::open()
        .and_then(|mut registry| persist_known_console_connection(&mut registry, credential));
    if let Err(error) = result {
        log_trace(&format!(
            "opencode connections: could not record the Console session: {error}"
        ));
    }
}

fn probe_from_outcome(endpoint_id: &str, outcome: &FetchOutcome) -> Option<EndpointProbe> {
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

fn record_quota_probe(credential: &Credential, endpoint_id: &str, outcome: &FetchOutcome) {
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

/// Resolves the OpenCode Go API key from the same sources the quota monitor
/// uses (Kite file, OPENCODE_API_KEY, OpenCode config, SQLite credential store,
/// or legacy auth.json). Returns the token and a human-readable source.
///
/// Only API-key credentials are returned; an OpenCode Console OAuth session is
/// not valid for the Go inference gateway.
pub fn resolve_opencode_go_api_key() -> Option<(String, String)> {
    let home = user_home_dir();
    go_api_key_from(resolve_credential(&home).0)
}

/// The single gate that keeps a Console OAuth session out of the Go inference
/// credential. Console OAuth proves the Console account; it never proves the Go
/// gateway.
fn go_api_key_credential(credential: Option<Credential>) -> Option<Credential> {
    credential.filter(|credential| credential.kind == CredentialKind::ApiKey)
}

fn go_api_key_from(credential: Option<Credential>) -> Option<(String, String)> {
    go_api_key_credential(credential).map(|credential| (credential.token, credential.source))
}

/// IPC: tells the UI whether a Go credential is already available locally,
/// without exposing the token to the webview.
#[tauri::command]
pub fn opencode_go_credential_status() -> Value {
    match resolve_opencode_go_api_key() {
        Some((_token, source)) => json!({
            "available": true,
            "source": source,
        }),
        None => json!({
            "available": false,
            "source": null,
        }),
    }
}

fn base_status() -> ProviderQuotaStatus {
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

fn opencode_detected(home: &Path) -> bool {
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

fn resolve_credential(home: &Path) -> (Option<Credential>, Vec<String>) {
    let mut notes = Vec::new();

    for config in [
        home.join(".kite").join("opencode-go-quota.json"),
        home.join(".devhub").join("opencode-go-quota.json"),
    ] {
        if let Some(value) = read_json_file(&config) {
            if let Some(key) = api_key_from_flat_config(&value) {
                return (
                    Some(api_key_credential(
                        key,
                        format!("Kite ({})", config.display()),
                    )),
                    notes,
                );
            }
            if value.get("authCookie").is_some() {
                notes.push(
                    "Se detectó una cookie legacy de OpenCode Go. El método actual usa API key: ejecutá `opencode auth login opencode-go`."
                        .to_string(),
                );
            }
        }
    }

    if let Ok(key) = std::env::var("OPENCODE_API_KEY") {
        let key = key.trim();
        if !key.is_empty() {
            return (
                Some(api_key_credential(
                    key.to_string(),
                    "Variable OPENCODE_API_KEY".to_string(),
                )),
                notes,
            );
        }
    }

    for config in opencode_config_paths(home) {
        if let Some(value) = read_json_file(&config) {
            if let Some(key) = api_key_from_opencode_config(&value) {
                return (
                    Some(api_key_credential(
                        key,
                        format!("OpenCode config ({})", config.display()),
                    )),
                    notes,
                );
            }
        }
    }

    let mut console_fallback: Option<Credential> = None;

    for db in opencode_data_paths(home)
        .into_iter()
        .map(|dir| dir.join("opencode.db"))
    {
        for credential in read_db_credentials(&db) {
            if credential.kind == CredentialKind::ApiKey {
                return (Some(credential), notes);
            }
            if credential.kind == CredentialKind::Console && console_fallback.is_none() {
                console_fallback = Some(credential);
            }
        }
    }

    for auth in opencode_data_paths(home)
        .into_iter()
        .map(|dir| dir.join("auth.json"))
    {
        if let Some(value) = read_json_file(&auth) {
            for provider in ["opencode-go", "opencode"] {
                if let Some(credential) = credential_from_auth_json(provider, &value) {
                    if credential.kind == CredentialKind::ApiKey {
                        return (Some(credential), notes);
                    }
                    if credential.kind == CredentialKind::Console && console_fallback.is_none() {
                        console_fallback = Some(credential);
                    }
                }
            }
        }
    }

    (console_fallback, notes)
}

/// Finds an OpenCode Console OAuth session without changing which credential
/// the quota probe prefers. A Go API key wins for inference; the Console
/// account is still persisted as its own connection.
fn console_credential_from_data_paths(home: &Path) -> Option<Credential> {
    for db in opencode_data_paths(home)
        .into_iter()
        .map(|dir| dir.join("opencode.db"))
    {
        if let Some(credential) = read_db_credentials(&db)
            .into_iter()
            .find(|credential| credential.kind == CredentialKind::Console)
        {
            return Some(credential);
        }
    }

    for auth in opencode_data_paths(home)
        .into_iter()
        .map(|dir| dir.join("auth.json"))
    {
        if let Some(value) = read_json_file(&auth) {
            for provider in ["opencode-go", "opencode"] {
                if let Some(credential) = credential_from_auth_json(provider, &value) {
                    if credential.kind == CredentialKind::Console {
                        return Some(credential);
                    }
                }
            }
        }
    }

    None
}

fn api_key_credential(token: String, source: String) -> Credential {
    Credential {
        token: token.trim().to_string(),
        kind: CredentialKind::ApiKey,
        source,
        console_base: None,
        org_id: None,
        expires_ms: None,
    }
}

fn opencode_data_paths(home: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(xdg) = std::env::var_os("XDG_DATA_HOME") {
        paths.push(PathBuf::from(xdg).join("opencode"));
    }
    paths.push(home.join(".local").join("share").join("opencode"));
    if let Some(appdata) = std::env::var_os("APPDATA") {
        paths.push(PathBuf::from(appdata).join("opencode"));
    }
    paths.push(home.join(".opencode"));
    dedupe_paths(paths)
}

fn opencode_config_paths(home: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
        dirs.push(PathBuf::from(xdg).join("opencode"));
    }
    dirs.push(home.join(".config").join("opencode"));
    if let Some(appdata) = std::env::var_os("APPDATA") {
        dirs.push(PathBuf::from(appdata).join("opencode"));
    }

    let mut paths = Vec::new();
    for dir in dedupe_paths(dirs) {
        paths.push(dir.join("opencode.json"));
        paths.push(dir.join("opencode.jsonc"));
    }
    paths
}

fn dedupe_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for path in paths {
        if !out.contains(&path) {
            out.push(path);
        }
    }
    out
}

fn read_json_file(path: &Path) -> Option<Value> {
    let content = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&content)
        .ok()
        .or_else(|| serde_json::from_str(&strip_jsonc(&content)).ok())
}

fn strip_jsonc(input: &str) -> String {
    let mut without_comments = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    let mut in_string = false;
    let mut escaped = false;

    while let Some(ch) = chars.next() {
        if in_string {
            without_comments.push(ch);
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }

        if ch == '"' {
            in_string = true;
            without_comments.push(ch);
            continue;
        }

        if ch == '/' {
            match chars.peek() {
                Some('/') => {
                    for next in chars.by_ref() {
                        if next == '\n' {
                            without_comments.push('\n');
                            break;
                        }
                    }
                    continue;
                }
                Some('*') => {
                    chars.next();
                    let mut previous = '\0';
                    for next in chars.by_ref() {
                        if previous == '*' && next == '/' {
                            break;
                        }
                        if next == '\n' {
                            without_comments.push('\n');
                        }
                        previous = next;
                    }
                    continue;
                }
                _ => {}
            }
        }

        without_comments.push(ch);
    }

    let mut out = String::with_capacity(without_comments.len());
    let chars: Vec<char> = without_comments.chars().collect();
    let mut in_string = false;
    let mut escaped = false;

    for (index, ch) in chars.iter().enumerate() {
        if in_string {
            out.push(*ch);
            if escaped {
                escaped = false;
            } else if *ch == '\\' {
                escaped = true;
            } else if *ch == '"' {
                in_string = false;
            }
            continue;
        }

        if *ch == '"' {
            in_string = true;
            out.push(*ch);
            continue;
        }

        if *ch == ',' {
            let next_non_whitespace = chars
                .iter()
                .skip(index + 1)
                .find(|candidate| !candidate.is_whitespace());
            if matches!(next_non_whitespace, Some('}') | Some(']')) {
                continue;
            }
        }

        out.push(*ch);
    }

    out
}

fn normalize_api_key(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if let Some(name) = raw
        .strip_prefix("{env:")
        .and_then(|rest| rest.strip_suffix('}'))
    {
        let value = std::env::var(name).ok()?;
        let value = value.trim();
        if value.is_empty() {
            None
        } else {
            Some(value.to_string())
        }
    } else if raw.is_empty() {
        None
    } else {
        Some(raw.to_string())
    }
}

fn api_key_from_flat_config(value: &Value) -> Option<String> {
    for key in ["apiKey", "api_key", "key"] {
        if let Some(raw) = value.get(key).and_then(Value::as_str) {
            if let Some(key) = normalize_api_key(raw) {
                return Some(key);
            }
        }
    }
    None
}

fn api_key_from_opencode_config(value: &Value) -> Option<String> {
    for provider in ["opencode-go", "opencode"] {
        let pointer = format!("/provider/{provider}/options/apiKey");
        if let Some(raw) = value.pointer(&pointer).and_then(Value::as_str) {
            if let Some(key) = normalize_api_key(raw) {
                return Some(key);
            }
        }
    }
    None
}

fn read_db_credentials(path: &Path) -> Vec<Credential> {
    if !path.exists() {
        return Vec::new();
    }

    let uri = format!("file:{}?mode=ro", path.to_string_lossy().replace('\\', "/"));
    let connection = match rusqlite::Connection::open_with_flags(
        uri,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    ) {
        Ok(connection) => connection,
        Err(_) => return Vec::new(),
    };
    let _ = connection.busy_timeout(Duration::from_millis(400));

    let mut statement = match connection.prepare(
        "SELECT integration_id, value FROM credential \
         WHERE integration_id IN ('opencode-go', 'opencode') \
         ORDER BY CASE integration_id WHEN 'opencode-go' THEN 0 ELSE 1 END, \
         COALESCE(active, 0) DESC",
    ) {
        Ok(statement) => statement,
        Err(_) => return Vec::new(),
    };

    let rows = match statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    }) {
        Ok(rows) => rows,
        Err(_) => return Vec::new(),
    };

    let mut credentials = Vec::new();
    for (integration_id, raw) in rows.flatten() {
        if let Ok(value) = serde_json::from_str::<Value>(&raw) {
            let source = format!("OpenCode DB ({integration_id})");
            if let Some(credential) = credential_from_value(&integration_id, &value, source) {
                credentials.push(credential);
            }
        }
    }
    credentials
}

fn credential_from_auth_json(provider: &str, root: &Value) -> Option<Credential> {
    let entry = root.get(provider)?;
    let source = format!("OpenCode auth.json ({provider})");
    credential_from_value(provider, entry, source)
}

fn credential_from_value(integration_id: &str, value: &Value, source: String) -> Option<Credential> {
    let kind = value.get("type").and_then(Value::as_str).unwrap_or("");

    if kind == "key" || kind == "api" || value.get("key").is_some() {
        let token = value.get("key").and_then(Value::as_str)?.trim();
        if token.is_empty() {
            return None;
        }
        return Some(api_key_credential(token.to_string(), source));
    }

    if kind == "oauth" || value.get("access").is_some() {
        let token = value.get("access").and_then(Value::as_str)?.trim();
        if token.is_empty() {
            return None;
        }
        let metadata = value.get("metadata");
        return Some(Credential {
            token: token.to_string(),
            kind: CredentialKind::Console,
            source: format!("OpenCode Console ({integration_id})"),
            console_base: metadata
                .and_then(|meta| meta.get("server"))
                .and_then(Value::as_str)
                .map(str::to_string),
            org_id: metadata
                .and_then(|meta| meta.get("orgID"))
                .and_then(Value::as_str)
                .map(str::to_string),
            expires_ms: value.get("expires").and_then(value_to_i64),
        });
    }

    None
}

fn value_to_i64(value: &Value) -> Option<i64> {
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

fn fetch_usage(credential: &Credential) -> FetchOutcome {
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

fn fetch_console(credential: &Credential) -> FetchOutcome {
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

fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .user_agent(format!("kite-code/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| format!("No se pudo crear el cliente HTTP: {error}"))
}

fn friendly_reqwest_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "tiempo de espera agotado al consultar OpenCode Go.".to_string()
    } else if error.is_connect() {
        "no se pudo establecer conexión con OpenCode Go.".to_string()
    } else {
        format!("error de red al consultar OpenCode Go: {error}")
    }
}

fn failure(status: Option<u16>, message: String, unauthorized: bool) -> FetchOutcome {
    FetchOutcome {
        http_status: status,
        windows: None,
        error: Some(message),
        unauthorized,
        entitlement_error: false,
    }
}

fn api_error(status: u16, body: &str, token: &str) -> FetchOutcome {
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

fn with_detail(base: String, detail: &str) -> String {
    if detail.is_empty() {
        base
    } else {
        format!("{base} {detail}")
    }
}

fn sanitize(text: &str, token: &str) -> String {
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

fn parse_usage_payload(payload: &Value) -> Result<Vec<WindowData>, String> {
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

fn parse_console_payload(payload: &Value) -> Result<Vec<WindowData>, String> {
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

fn apply_windows(status: &mut ProviderQuotaStatus, windows: Vec<WindowData>) {
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

fn parse_rfc3339_ms(value: &str) -> Option<i64> {
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

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_prime = (month + 9) % 12;
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

#[tauri::command]
pub fn save_opencode_api_key(api_key: String) -> Result<bool, String> {
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err("La API key de OpenCode Go no puede estar vacía.".to_string());
    }

    let home = user_home_dir();
    let dir = home.join(".kite");
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("opencode-go-quota.json");
    let data = json!({ "apiKey": api_key });
    std::fs::write(&path, serde_json::to_string_pretty(&data).unwrap_or_default())
        .map_err(|error| error.to_string())?;
    Ok(true)
}

#[tauri::command]
pub fn clear_opencode_api_key() -> Result<bool, String> {
    let home = user_home_dir();
    let path = home.join(".kite").join("opencode-go-quota.json");
    if path.exists() {
        let _ = std::fs::remove_file(path);
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_usage_payload_windows() {
        let payload = json!({
            "usage": {
                "rolling": { "status": "ok", "percent": 12, "resetsAt": "2026-10-22T23:02:11.000Z" },
                "weekly": { "status": "ok", "percent": 34, "resetsAt": "2026-10-26T00:00:00.000Z" },
                "monthly": { "status": "ok", "percent": 56, "resetsAt": "2026-11-22T17:06:30.000Z" }
            }
        });

        let windows = parse_usage_payload(&payload).expect("valid payload");
        assert_eq!(windows.len(), 3);
        assert_eq!(windows[0].usage_percent, 12.0);
        assert_eq!(windows[1].usage_percent, 34.0);
        assert_eq!(windows[2].usage_percent, 56.0);
        assert!(!windows[0].exhausted);
    }

    #[test]
    fn rate_limited_window_is_exhausted() {
        let payload = json!({
            "usage": {
                "rolling": { "status": "rate-limited", "percent": 42, "resetsAt": "2026-10-22T23:02:11.000Z" },
                "weekly": { "status": "ok", "percent": 10, "resetsAt": "2026-10-26T00:00:00.000Z" },
                "monthly": { "status": "ok", "percent": 10, "resetsAt": "2026-11-22T17:06:30.000Z" }
            }
        });

        let windows = parse_usage_payload(&payload).expect("valid payload");
        assert_eq!(windows[0].usage_percent, 100.0);
        assert!(windows[0].exhausted);
    }

    #[test]
    fn rejects_invalid_percent() {
        let payload = json!({
            "usage": {
                "rolling": { "status": "ok", "percent": 120, "resetsAt": "2026-10-22T23:02:11.000Z" },
                "weekly": { "status": "ok", "percent": 10, "resetsAt": "2026-10-26T00:00:00.000Z" },
                "monthly": { "status": "ok", "percent": 10, "resetsAt": "2026-11-22T17:06:30.000Z" }
            }
        });

        assert!(parse_usage_payload(&payload).is_err());
    }

    #[test]
    fn parses_timestamps_with_offsets() {
        let utc = parse_rfc3339_ms("2026-10-22T23:02:11.000Z").expect("utc timestamp");
        let offset = parse_rfc3339_ms("2026-10-23T01:02:11+02:00").expect("offset timestamp");
        assert_eq!(utc, offset);
    }

    #[test]
    fn reads_api_key_from_kite_config_shape() {
        let value = json!({ "apiKey": "  sk-test  " });
        assert_eq!(api_key_from_flat_config(&value).as_deref(), Some("sk-test"));
    }

    #[test]
    fn reads_api_key_from_opencode_config() {
        let value = json!({
            "provider": {
                "opencode-go": { "options": { "apiKey": "sk-config" } }
            }
        });
        assert_eq!(api_key_from_opencode_config(&value).as_deref(), Some("sk-config"));
    }

    #[test]
    fn detects_entitlement_error() {
        let outcome = api_error(
            403,
            r#"{"type":"error","error":{"type":"EntitlementError"}}"#,
            "sk-secret",
        );
        assert!(!outcome.unauthorized);
        assert!(
            outcome.entitlement_error,
            "a 403 EntitlementError means no Go subscription"
        );
        assert!(outcome
            .error
            .unwrap_or_default()
            .contains("no tiene una suscripción"));

        let record = build_connection_record(
            &go_credential("oc_sk_live"),
            &EndpointProbe {
                endpoint_id: OPENCODE_GO_USAGE_ENDPOINT.to_string(),
                ok: false,
                http_status: Some(403),
                session_header_sent: false,
                entitlement_error: true,
            },
            None,
        );
        assert_eq!(record.status, "entitlement_error");
        assert!(record.endpoints.iter().all(|endpoint| !endpoint.ok));
    }

    #[test]
    fn parses_console_meters() {
        let payload = json!({
            "access": {
                "endsAt": "2026-11-22T17:06:30.000Z",
                "meters": {
                    "fiveHour": {
                        "limitMicroCents": 1_000,
                        "usedMicroCents": 250,
                        "resetsAt": "2026-10-22T23:02:11.000Z"
                    },
                    "week": {
                        "limitMicroCents": "2000",
                        "usedMicroCents": "500",
                        "resetsAt": "2026-10-26T00:00:00.000Z"
                    },
                    "month": {
                        "limitMicroCents": 4_000,
                        "usedMicroCents": 1_000
                    }
                }
            }
        });

        let windows = parse_console_payload(&payload).expect("valid console payload");
        assert_eq!(windows.len(), 3);
        assert_eq!(windows[0].usage_percent, 25.0);
        assert_eq!(windows[1].resets_at, "2026-10-26T00:00:00.000Z");
        assert_eq!(windows[2].resets_at, "2026-11-22T17:06:30.000Z");
    }

    #[test]
    fn normalizes_plain_api_keys() {
        assert_eq!(normalize_api_key("  sk-test  ").as_deref(), Some("sk-test"));
        assert_eq!(normalize_api_key("   "), None);
    }

    #[test]
    fn strips_jsonc_comments_and_trailing_commas() {
        let input = r#"
        {
          // line comment
          "provider": {
            "opencode-go": { "options": { "apiKey": "sk-jsonc" } },
          },
        }
        "#;
        let value: Value = serde_json::from_str(&strip_jsonc(input)).expect("valid jsonc");
        assert_eq!(
            value.pointer("/provider/opencode-go/options/apiKey").and_then(Value::as_str),
            Some("sk-jsonc")
        );
    }

    // --- OpenCode Go, Console, and pay-as-you-go endpoint rows (T3 / S3, S5) ---

    use crate::connections::{
        connection_id_for, ConnectionRecord, ConnectionRegistry, EndpointVerification,
    };

    struct TempRegistry(PathBuf);

    impl TempRegistry {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "kite-opencode-connections-{}",
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&dir).expect("create temp app data");
            Self(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempRegistry {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn go_credential(token: &str) -> Credential {
        api_key_credential(token.to_string(), "Kite (test)".to_string())
    }

    fn console_credential(token: &str, org_id: Option<&str>) -> Credential {
        Credential {
            token: token.to_string(),
            kind: CredentialKind::Console,
            source: "OpenCode Console (opencode)".to_string(),
            console_base: None,
            org_id: org_id.map(str::to_string),
            expires_ms: None,
        }
    }

    fn probe(endpoint_id: &str, ok: bool, session_header_sent: bool) -> EndpointProbe {
        EndpointProbe {
            endpoint_id: endpoint_id.to_string(),
            ok,
            http_status: Some(if ok { 200 } else { 401 }),
            session_header_sent,
            entitlement_error: false,
        }
    }

    #[test]
    fn go_inference_resolver_rejects_console_oauth() {
        let console = console_credential("console-access-token", Some("org-42"));
        assert_eq!(
            go_api_key_from(Some(console)),
            None,
            "a Console OAuth access token must not become the Go inference credential"
        );

        let resolved = go_api_key_from(Some(go_credential("oc_sk_live")))
            .expect("an API key is the Go inference credential");
        assert_eq!(resolved.0, "oc_sk_live");
        assert_eq!(resolved.1, "Kite (test)");
    }

    #[test]
    fn usage_probe_does_not_mark_a_payg_chat_endpoint_ok() {
        let temp = TempRegistry::new();
        let mut registry = ConnectionRegistry::open_at(temp.path()).expect("open registry");
        let credential = go_credential("oc_sk_live");
        let identity = credential.connection_identity();
        let connection_id = connection_id_for("opencode", "api_key", &identity);

        // A row from an older store that wrongly claims the pay-as-you-go chat
        // route for a Go key.
        registry
            .save(&ConnectionRecord {
                connection_id: connection_id.clone(),
                driver_kind: "opencode".into(),
                display_name: "OpenCode Go".into(),
                auth_method: "api_key".into(),
                account_identity: identity,
                credential_ref: "vault".into(),
                billing_mode: Some("subscription".into()),
                endpoints: vec![
                    EndpointVerification {
                        endpoint_id: OPENCODE_GO_USAGE_ENDPOINT.into(),
                        ok: false,
                    },
                    EndpointVerification {
                        endpoint_id: "https://opencode.ai/inference/v1/chat/completions".into(),
                        ok: true,
                    },
                    EndpointVerification {
                        endpoint_id: "https://opencode.ai/inference/openai/v1/chat/completions"
                            .into(),
                        ok: true,
                    },
                ],
                status: "imported".into(),
                last_checked_ms: None,
                expires_ms: None,
                last_http_status: None,
            })
            .expect("seed stale row");

        persist_probe(
            &mut registry,
            &credential,
            &probe(OPENCODE_GO_USAGE_ENDPOINT, true, false),
        )
        .expect("persist usage probe");

        let saved = registry
            .load(&connection_id)
            .expect("load connection")
            .expect("connection exists");
        let usage = saved
            .endpoints
            .iter()
            .find(|endpoint| endpoint.endpoint_id == OPENCODE_GO_USAGE_ENDPOINT)
            .expect("usage endpoint");
        assert!(usage.ok, "the verified usage endpoint stays ok");
        for payg in [
            "https://opencode.ai/inference/v1/chat/completions",
            "https://opencode.ai/inference/openai/v1/chat/completions",
        ] {
            assert!(
                saved
                    .endpoints
                    .iter()
                    .all(|endpoint| endpoint.endpoint_id != payg),
                "a usage probe must not keep {payg} for a Go key"
            );
        }
        assert_eq!(saved.billing_mode.as_deref(), Some("subscription"));
        assert_eq!(saved.status, "verified");
    }

    #[test]
    fn go_chat_endpoint_requires_an_opencode_session_header() {
        let credential = go_credential("oc_sk_live");

        let without_session = build_connection_record(
            &credential,
            &probe(OPENCODE_GO_CHAT_ENDPOINT, true, false),
            None,
        );
        assert!(
            without_session
                .endpoints
                .iter()
                .all(|endpoint| endpoint.endpoint_id != OPENCODE_GO_CHAT_ENDPOINT),
            "the Go chat endpoint cannot be verified without x-opencode-session"
        );

        let with_session = build_connection_record(
            &credential,
            &probe(OPENCODE_GO_CHAT_ENDPOINT, true, true),
            None,
        );
        let chat = with_session
            .endpoints
            .iter()
            .find(|endpoint| endpoint.endpoint_id == OPENCODE_GO_CHAT_ENDPOINT)
            .expect("chat endpoint");
        assert!(chat.ok);

        // The plan catalog does not need a session header, and it is a different
        // endpoint from the chat gateway.
        let models = build_connection_record(
            &credential,
            &probe(OPENCODE_GO_MODELS_ENDPOINT, true, false),
            None,
        );
        assert_eq!(
            models.endpoints,
            vec![EndpointVerification {
                endpoint_id: OPENCODE_GO_MODELS_ENDPOINT.into(),
                ok: true,
            }]
        );
    }

    #[test]
    fn go_and_console_persist_as_separate_connections() {
        let temp = TempRegistry::new();
        let mut registry = ConnectionRegistry::open_at(temp.path()).expect("open registry");

        let go = go_credential("oc_sk_live");
        persist_probe(
            &mut registry,
            &go,
            &probe(OPENCODE_GO_USAGE_ENDPOINT, true, false),
        )
        .expect("persist Go usage probe");

        let console = console_credential("console-access-token", Some("org-42"));
        let console_endpoint = console.console_status_url();
        persist_probe(
            &mut registry,
            &console,
            &probe(&console_endpoint, true, false),
        )
        .expect("persist Console status probe");
        // A Console OAuth token is not the Go inference credential, so probing a
        // Go endpoint with it records nothing.
        persist_probe(
            &mut registry,
            &console,
            &probe(OPENCODE_GO_USAGE_ENDPOINT, true, false),
        )
        .expect("reject Console probe of a Go endpoint");

        let records = registry.list().expect("list connections");
        assert_eq!(records.len(), 2, "Go and Console are different connections");

        let go_record = records
            .iter()
            .find(|record| record.auth_method == "api_key")
            .expect("Go connection");
        assert_eq!(go_record.account_identity.org_id, None);
        assert_eq!(go_record.billing_mode.as_deref(), Some("subscription"));
        assert_eq!(go_record.credential_ref, "kite_file");
        assert_eq!(
            go_record.endpoints,
            vec![EndpointVerification {
                endpoint_id: OPENCODE_GO_USAGE_ENDPOINT.into(),
                ok: true,
            }]
        );

        let console_record = records
            .iter()
            .find(|record| record.auth_method == "console_oauth")
            .expect("Console connection");
        assert_eq!(
            console_record.account_identity.org_id.as_deref(),
            Some("org-42")
        );
        assert_eq!(
            console_record.endpoints,
            vec![EndpointVerification {
                endpoint_id: console_endpoint,
                ok: true,
            }],
            "Console OAuth verifies only the Console status endpoint"
        );
        assert_ne!(go_record.connection_id, console_record.connection_id);
    }

    #[test]
    fn a_failed_request_does_not_rewrite_an_endpoint_verification() {
        let timeout = FetchOutcome {
            http_status: None,
            windows: None,
            error: Some("temporal".to_string()),
            unauthorized: false,
            entitlement_error: false,
        };
        assert!(
            probe_from_outcome(OPENCODE_GO_USAGE_ENDPOINT, &timeout).is_none(),
            "a transport failure is not endpoint evidence"
        );

        let rejected = FetchOutcome {
            http_status: Some(401),
            windows: None,
            error: Some("unauthorized".to_string()),
            unauthorized: true,
            entitlement_error: false,
        };
        let probe = probe_from_outcome(OPENCODE_GO_USAGE_ENDPOINT, &rejected)
            .expect("an HTTP response is endpoint evidence");
        assert!(!probe.ok);
        assert_eq!(probe.http_status, Some(401));
    }

    #[test]
    fn console_session_is_persisted_next_to_a_go_key() {
        let temp = TempRegistry::new();
        let mut registry = ConnectionRegistry::open_at(temp.path()).expect("open registry");

        persist_probe(
            &mut registry,
            &go_credential("oc_sk_live"),
            &probe(OPENCODE_GO_USAGE_ENDPOINT, true, false),
        )
        .expect("persist Go usage probe");

        // A Console session is a different connection even when a Go key is the
        // credential the quota probe prefers.
        let console = console_credential("console-access-token", Some("org-42"));
        persist_known_console_connection(&mut registry, &console)
            .expect("record the Console session");

        let records = registry.list().expect("list connections");
        assert_eq!(records.len(), 2, "Go and Console stay separate connections");
        let console_id = connection_id_for(
            "opencode",
            "console_oauth",
            &console.connection_identity(),
        );
        let console_record = records
            .iter()
            .find(|record| record.connection_id == console_id)
            .expect("Console connection");
        assert_eq!(console_record.status, "unverified");
        assert!(
            console_record.endpoints.is_empty(),
            "a discovered Console session has no verified endpoint yet"
        );
        assert_eq!(
            console_record.account_identity.org_id.as_deref(),
            Some("org-42")
        );
        assert_eq!(console_record.credential_ref, "cli_file");

        // A later successful probe must survive the next discovery pass.
        persist_probe(
            &mut registry,
            &console,
            &probe(&console.console_status_url(), true, false),
        )
        .expect("persist Console status probe");
        persist_known_console_connection(&mut registry, &console)
            .expect("refresh the known row");

        let verified = registry
            .load(&console_id)
            .expect("load Console connection")
            .expect("Console connection exists");
        assert_eq!(verified.status, "verified");
        assert_eq!(verified.endpoints.len(), 1);
    }
}
