use crate::connections::AccountIdentity;
use crate::quota::utils::user_home_dir;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::client::{
    value_to_i64, CONSOLE_STATUS_PATH, DEFAULT_CONSOLE_BASE, OPENCODE_GO_CHAT_ENDPOINT,
    OPENCODE_GO_MODELS_ENDPOINT, OPENCODE_GO_USAGE_ENDPOINT,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialKind {
    ApiKey,
    Console,
}

#[derive(Debug, Clone)]
pub struct Credential {
    pub token: String,
    pub kind: CredentialKind,
    pub source: String,
    pub console_base: Option<String>,
    pub org_id: Option<String>,
    pub expires_ms: Option<i64>,
}

impl Credential {
    pub fn connection_auth_method(&self) -> &'static str {
        match self.kind {
            CredentialKind::ApiKey => "api_key",
            CredentialKind::Console => "console_oauth",
        }
    }

    pub fn connection_identity(&self) -> AccountIdentity {
        AccountIdentity {
            email: None,
            org_id: self.org_id.clone(),
            account_id: None,
        }
    }

    pub fn connection_billing_mode(&self) -> Option<String> {
        match self.kind {
            CredentialKind::ApiKey => Some("subscription".to_string()),
            CredentialKind::Console => None,
        }
    }

    pub fn connection_display_name(&self) -> &'static str {
        match self.kind {
            CredentialKind::ApiKey => "OpenCode Go",
            CredentialKind::Console => "OpenCode Console",
        }
    }

    pub fn connection_credential_ref(&self) -> &'static str {
        if self.source.starts_with("Kite (") {
            "kite_file"
        } else if self.source.starts_with("Variable ") {
            "env"
        } else {
            "cli_file"
        }
    }

    pub fn console_status_url(&self) -> String {
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
    pub fn endpoint_supported(&self, endpoint_id: &str, session_header_sent: bool) -> bool {
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
pub fn go_api_key_credential(credential: Option<Credential>) -> Option<Credential> {
    credential.filter(|credential| credential.kind == CredentialKind::ApiKey)
}

pub fn go_api_key_from(credential: Option<Credential>) -> Option<(String, String)> {
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

pub fn resolve_credential(home: &Path) -> (Option<Credential>, Vec<String>) {
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

    if let Some((vault_key, source)) = crate::credentials::resolve_provider_credential("opencode") {
        let key = vault_key.trim();
        if !key.is_empty() {
            let label = match source {
                crate::credentials::CredentialSource::Vault => "Bóveda Local SQLite (Kite)".to_string(),
                crate::credentials::CredentialSource::Env => "Variable de Entorno (OPENCODE_API_KEY)".to_string(),
                _ => "Kite Vault".to_string(),
            };
            return (
                Some(api_key_credential(key.to_string(), label)),
                notes,
            );
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
pub fn console_credential_from_data_paths(home: &Path) -> Option<Credential> {
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

pub fn api_key_credential(token: String, source: String) -> Credential {
    Credential {
        token: token.trim().to_string(),
        kind: CredentialKind::ApiKey,
        source,
        console_base: None,
        org_id: None,
        expires_ms: None,
    }
}

pub fn opencode_data_paths(home: &Path) -> Vec<PathBuf> {
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

pub fn opencode_config_paths(home: &Path) -> Vec<PathBuf> {
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

pub fn dedupe_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for path in paths {
        if !out.contains(&path) {
            out.push(path);
        }
    }
    out
}

pub fn read_json_file(path: &Path) -> Option<Value> {
    let content = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&content)
        .ok()
        .or_else(|| serde_json::from_str(&strip_jsonc(&content)).ok())
}

pub fn strip_jsonc(input: &str) -> String {
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

pub fn normalize_api_key(raw: &str) -> Option<String> {
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

pub fn api_key_from_flat_config(value: &Value) -> Option<String> {
    for key in ["apiKey", "api_key", "key"] {
        if let Some(raw) = value.get(key).and_then(Value::as_str) {
            if let Some(key) = normalize_api_key(raw) {
                return Some(key);
            }
        }
    }
    None
}

pub fn api_key_from_opencode_config(value: &Value) -> Option<String> {
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

pub fn read_db_credentials(path: &Path) -> Vec<Credential> {
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

pub fn credential_from_auth_json(provider: &str, root: &Value) -> Option<Credential> {
    let entry = root.get(provider)?;
    let source = format!("OpenCode auth.json ({provider})");
    credential_from_value(provider, entry, source)
}

pub fn credential_from_value(integration_id: &str, value: &Value, source: String) -> Option<Credential> {
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
