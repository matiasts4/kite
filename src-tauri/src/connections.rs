//! Connection identity and endpoint verification. A connection is one account
//! plus one auth method. A verified endpoint is not implied by the driver id.
//!
//! Every connection lives in one native registry shared by the installed and
//! dev builds: `%APPDATA%\Kite Code\connections\`. Threads, tickets, terminal
//! sessions, and chat attachments stay in the per-install app-data folder.

use crate::logger::log_trace;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

pub const OPENCODE_PAYG_CHAT_ENDPOINT: &str = "https://opencode.ai/inference/v1/chat/completions";

const OPENCODE_PAYG_CHAT_ENDPOINTS: &[&str] = &[
    OPENCODE_PAYG_CHAT_ENDPOINT,
    "https://opencode.ai/inference/openai/v1/chat/completions",
];

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountIdentity {
    pub email: Option<String>,
    pub org_id: Option<String>,
    pub account_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointVerification {
    pub endpoint_id: String,
    pub ok: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectionDraft {
    pub driver_kind: String,
    pub auth_method: String,
    pub account_identity: AccountIdentity,
    pub billing_mode: Option<String>,
    pub endpoints: Vec<EndpointVerification>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuiltConnection {
    pub connection_id: String,
    pub endpoints: Vec<EndpointVerification>,
    pub rejected: Vec<String>,
}

/// One persisted connection. The store is keyed by `connection_id`, never by
/// driver kind alone, because two connections of one driver may differ in auth
/// method and account.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionRecord {
    pub connection_id: String,
    pub driver_kind: String,
    pub display_name: String,
    pub auth_method: String,
    pub account_identity: AccountIdentity,
    pub credential_ref: String,
    pub billing_mode: Option<String>,
    pub endpoints: Vec<EndpointVerification>,
    pub status: String,
    pub last_checked_ms: Option<i64>,
    pub expires_ms: Option<i64>,
    pub last_http_status: Option<i64>,
}

fn identity_part(value: &Option<String>) -> String {
    value.as_deref().unwrap_or("").trim().to_string()
}

pub fn connection_id_for(driver_kind: &str, auth_method: &str, identity: &AccountIdentity) -> String {
    let email = identity_part(&identity.email).to_lowercase();
    let org_id = identity_part(&identity.org_id);
    let account_id = identity_part(&identity.account_id);
    format!("{driver_kind}:{auth_method}:email={email}|org={org_id}|account={account_id}")
}

fn is_opencode_go_key(draft: &ConnectionDraft) -> bool {
    draft.driver_kind == "opencode"
        && draft.auth_method == "api_key"
        && draft.billing_mode.as_deref() == Some("subscription")
}

pub fn build_connection(draft: ConnectionDraft) -> BuiltConnection {
    let mut rejected = Vec::new();
    let mut endpoints = Vec::new();
    for endpoint in draft.endpoints.iter().cloned() {
        let blocked = endpoint.ok
            && is_opencode_go_key(&draft)
            && OPENCODE_PAYG_CHAT_ENDPOINTS.contains(&endpoint.endpoint_id.as_str());
        if blocked {
            rejected.push(endpoint.endpoint_id);
            continue;
        }
        endpoints.push(endpoint);
    }
    BuiltConnection {
        connection_id: connection_id_for(
            &draft.driver_kind,
            &draft.auth_method,
            &draft.account_identity,
        ),
        endpoints,
        rejected,
    }
}

// ---------------------------------------------------------------------------
// Shared connection registry
// ---------------------------------------------------------------------------

/// App-data folder owned by the installed build. The dev build joins it for
/// connections only; other per-install data keeps using its own folder.
pub const SHARED_INSTALL_FOLDER: &str = "Kite Code";
pub const DEV_INSTALL_FOLDER: &str = "Kite Code Dev";
pub const CONNECTIONS_FOLDER: &str = "connections";
pub const ACCOUNT_PROFILES_FOLDER: &str = "account-profiles";
pub const REGISTRY_FILE_NAME: &str = "registry.sqlite";

const LEGACY_IMPORT_MARKER: &str = "legacy_import_v1";

const REGISTRY_SCHEMA_SQL: &str = "
CREATE TABLE IF NOT EXISTS connections (
    connection_id TEXT PRIMARY KEY,
    driver_kind TEXT NOT NULL,
    display_name TEXT NOT NULL,
    auth_method TEXT NOT NULL,
    account_email TEXT,
    account_org_id TEXT,
    account_account_id TEXT,
    credential_ref TEXT NOT NULL DEFAULT 'vault',
    billing_mode TEXT,
    status TEXT NOT NULL DEFAULT 'unknown',
    last_checked_ms INTEGER,
    expires_ms INTEGER,
    last_http_status INTEGER,
    source_app TEXT NOT NULL DEFAULT 'kite',
    imported_at_unix_ms INTEGER
);
CREATE TABLE IF NOT EXISTS connection_endpoints (
    connection_id TEXT NOT NULL,
    endpoint_id TEXT NOT NULL,
    ok INTEGER NOT NULL DEFAULT 0,
    http_status INTEGER,
    verified_at_ms INTEGER,
    PRIMARY KEY (connection_id, endpoint_id)
);
CREATE TABLE IF NOT EXISTS connection_secrets (
    connection_id TEXT PRIMARY KEY,
    ciphertext TEXT NOT NULL,
    updated_at_unix_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS registry_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
";

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn appdata_base() -> PathBuf {
    if let Ok(appdata) = std::env::var("APPDATA") {
        PathBuf::from(appdata)
    } else if let Ok(profile) = std::env::var("USERPROFILE") {
        PathBuf::from(profile).join("AppData").join("Roaming")
    } else {
        PathBuf::from(".")
    }
}

/// Root of the shared registry, independent of which build is running.
pub fn shared_connections_root(appdata: &Path) -> PathBuf {
    appdata.join(SHARED_INSTALL_FOLDER).join(CONNECTIONS_FOLDER)
}

/// Path-scoped variant that accepts an install flag so callers cannot drift.
/// The installed and dev builds share one registry, so the flag is ignored.
pub fn shared_connections_root_for(appdata: &Path, install_is_dev: bool) -> PathBuf {
    let _ = install_is_dev;
    shared_connections_root(appdata)
}

pub fn connections_root() -> PathBuf {
    shared_connections_root(&appdata_base())
}

pub fn registry_path_for(appdata: &Path, install_is_dev: bool) -> PathBuf {
    shared_connections_root_for(appdata, install_is_dev).join(REGISTRY_FILE_NAME)
}

pub fn registry_path() -> PathBuf {
    shared_connections_root(&appdata_base()).join(REGISTRY_FILE_NAME)
}

/// Account-profile snapshots that belong to connections, shared by both builds.
pub fn shared_account_profiles_root() -> PathBuf {
    shared_connections_root(&appdata_base()).join(ACCOUNT_PROFILES_FOLDER)
}

fn open_registry_file(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("cannot create {}: {error}", parent.display()))?;
    }
    let conn = Connection::open(path)
        .map_err(|error| format!("cannot open {}: {error}", path.display()))?;
    conn.execute_batch(&format!(
        "PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;{REGISTRY_SCHEMA_SQL}"
    ))
    .map_err(|error| format!("cannot initialize {}: {error}", path.display()))?;
    Ok(conn)
}

fn write_connection_row(
    tx: &Transaction<'_>,
    record: &ConnectionRecord,
    source_app: &str,
    imported_at_unix_ms: Option<i64>,
) -> rusqlite::Result<()> {
    tx.execute(
        "INSERT INTO connections (
             connection_id, driver_kind, display_name, auth_method,
             account_email, account_org_id, account_account_id,
             credential_ref, billing_mode, status,
             last_checked_ms, expires_ms, last_http_status,
             source_app, imported_at_unix_ms
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
         ON CONFLICT(connection_id) DO UPDATE SET
             driver_kind = excluded.driver_kind,
             display_name = excluded.display_name,
             auth_method = excluded.auth_method,
             account_email = excluded.account_email,
             account_org_id = excluded.account_org_id,
             account_account_id = excluded.account_account_id,
             credential_ref = excluded.credential_ref,
             billing_mode = excluded.billing_mode,
             status = excluded.status,
             last_checked_ms = excluded.last_checked_ms,
             expires_ms = excluded.expires_ms,
             last_http_status = excluded.last_http_status,
             source_app = excluded.source_app,
             imported_at_unix_ms = excluded.imported_at_unix_ms",
        params![
            record.connection_id,
            record.driver_kind,
            record.display_name,
            record.auth_method,
            record.account_identity.email,
            record.account_identity.org_id,
            record.account_identity.account_id,
            record.credential_ref,
            record.billing_mode,
            record.status,
            record.last_checked_ms,
            record.expires_ms,
            record.last_http_status,
            source_app,
            imported_at_unix_ms,
        ],
    )?;
    tx.execute(
        "DELETE FROM connection_endpoints WHERE connection_id = ?1",
        params![record.connection_id],
    )?;
    for endpoint in &record.endpoints {
        tx.execute(
            "INSERT INTO connection_endpoints (connection_id, endpoint_id, ok)
             VALUES (?1, ?2, ?3)",
            params![record.connection_id, endpoint.endpoint_id, i64::from(endpoint.ok)],
        )?;
    }
    Ok(())
}

fn read_endpoints(
    conn: &Connection,
    connection_id: &str,
) -> rusqlite::Result<Vec<EndpointVerification>> {
    let mut statement = conn.prepare(
        "SELECT endpoint_id, ok FROM connection_endpoints
         WHERE connection_id = ?1 ORDER BY endpoint_id ASC",
    )?;
    let rows = statement.query_map(params![connection_id], |row| {
        let endpoint_id: String = row.get(0)?;
        let ok: i64 = row.get(1)?;
        Ok(EndpointVerification {
            endpoint_id,
            ok: ok != 0,
        })
    })?;
    let mut endpoints = Vec::new();
    for row in rows {
        endpoints.push(row?);
    }
    Ok(endpoints)
}

fn read_connection(
    conn: &Connection,
    connection_id: &str,
) -> rusqlite::Result<Option<ConnectionRecord>> {
    let record = conn
        .query_row(
            "SELECT connection_id, driver_kind, display_name, auth_method,
                    account_email, account_org_id, account_account_id,
                    credential_ref, billing_mode, status,
                    last_checked_ms, expires_ms, last_http_status
             FROM connections WHERE connection_id = ?1",
            params![connection_id],
            |row| {
                Ok(ConnectionRecord {
                    connection_id: row.get(0)?,
                    driver_kind: row.get(1)?,
                    display_name: row.get(2)?,
                    auth_method: row.get(3)?,
                    account_identity: AccountIdentity {
                        email: row.get(4)?,
                        org_id: row.get(5)?,
                        account_id: row.get(6)?,
                    },
                    credential_ref: row.get(7)?,
                    billing_mode: row.get(8)?,
                    status: row.get(9)?,
                    last_checked_ms: row.get(10)?,
                    expires_ms: row.get(11)?,
                    last_http_status: row.get(12)?,
                    endpoints: Vec::new(),
                })
            },
        )
        .optional()?;
    match record {
        Some(mut record) => {
            record.endpoints = read_endpoints(conn, connection_id)?;
            Ok(Some(record))
        }
        None => Ok(None),
    }
}

/// Native store for connections. Both builds open the same file.
pub struct ConnectionRegistry {
    path: PathBuf,
    conn: Connection,
}

impl ConnectionRegistry {
    pub fn open() -> Result<Self, String> {
        Self::open_at(&appdata_base())
    }

    pub fn open_at(appdata: &Path) -> Result<Self, String> {
        let path = registry_path_for(appdata, false);
        let conn = open_registry_file(&path)?;
        Ok(Self { path, conn })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn save(&mut self, record: &ConnectionRecord) -> Result<(), String> {
        let tx = self
            .conn
            .transaction()
            .map_err(|error| format!("connection registry: {error}"))?;
        write_connection_row(&tx, record, "kite", None)
            .map_err(|error| format!("connection registry: {error}"))?;
        tx.commit()
            .map_err(|error| format!("connection registry: {error}"))
    }

    pub fn load(&self, connection_id: &str) -> Result<Option<ConnectionRecord>, String> {
        read_connection(&self.conn, connection_id)
            .map_err(|error| format!("connection registry: {error}"))
    }

    pub fn list(&self) -> Result<Vec<ConnectionRecord>, String> {
        let mut statement = self
            .conn
            .prepare(
                "SELECT connection_id FROM connections
                 ORDER BY driver_kind ASC, auth_method ASC, connection_id ASC",
            )
            .map_err(|error| format!("connection registry: {error}"))?;
        let ids = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| format!("connection registry: {error}"))?;
        let mut records = Vec::new();
        for id in ids {
            let id = id.map_err(|error| format!("connection registry: {error}"))?;
            if let Some(record) = read_connection(&self.conn, &id)
                .map_err(|error| format!("connection registry: {error}"))?
            {
                records.push(record);
            }
        }
        Ok(records)
    }

    pub fn set_secret(&mut self, connection_id: &str, secret: &str) -> Result<(), String> {
        let trimmed = secret.trim();
        if trimmed.is_empty() {
            self.conn
                .execute(
                    "DELETE FROM connection_secrets WHERE connection_id = ?1",
                    params![connection_id],
                )
                .map(|_| ())
                .map_err(|error| format!("connection registry: {error}"))?;
            return Ok(());
        }
        let ciphertext = crate::credentials::encrypt_secret(trimmed);
        self.conn
            .execute(
                "INSERT INTO connection_secrets (connection_id, ciphertext, updated_at_unix_ms)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(connection_id) DO UPDATE SET
                     ciphertext = excluded.ciphertext,
                     updated_at_unix_ms = excluded.updated_at_unix_ms",
                params![connection_id, ciphertext, now_ms()],
            )
            .map(|_| ())
            .map_err(|error| format!("connection registry: {error}"))
    }

    pub fn get_secret(&self, connection_id: &str) -> Option<String> {
        let ciphertext: Option<String> = self
            .conn
            .query_row(
                "SELECT ciphertext FROM connection_secrets WHERE connection_id = ?1",
                params![connection_id],
                |row| row.get(0),
            )
            .optional()
            .ok()
            .flatten();
        ciphertext.and_then(|value| crate::credentials::decrypt_secret(&value))
    }
}

/// Drivers whose saved API key also identifies a chat connection in the shared
/// registry. Other product keys stay in the vault only.
const API_KEY_CONNECTION_DRIVERS: &[&str] = &["opencode", "grok"];

fn is_api_key_connection_driver(driver_kind: &str) -> bool {
    API_KEY_CONNECTION_DRIVERS.contains(&driver_kind)
}

/// Records a vault-backed API key as a shared-registry connection. A key proves
/// possession, not that any endpoint answers, so a new row carries no verified
/// endpoint and no billing mode. A key saved again over an existing connection
/// only replaces the secret: verification belongs to probes, so the stored
/// endpoints, status, billing mode, and timing fields are kept, and the shared
/// builder still drops routes this connection may never hold.
fn persist_api_key_connection(
    registry: &mut ConnectionRegistry,
    driver_kind: &str,
    secret: &str,
) -> Result<(), String> {
    let trimmed = secret.trim();
    if trimmed.is_empty() || !is_api_key_connection_driver(driver_kind) {
        return Ok(());
    }
    let identity = AccountIdentity::default();
    let connection_id = connection_id_for(driver_kind, "api_key", &identity);
    let record = match registry.load(&connection_id)? {
        Some(mut existing) => {
            let kept = build_connection(ConnectionDraft {
                driver_kind: existing.driver_kind.clone(),
                auth_method: existing.auth_method.clone(),
                account_identity: existing.account_identity.clone(),
                billing_mode: existing.billing_mode.clone(),
                endpoints: existing.endpoints.clone(),
            });
            existing.endpoints = kept.endpoints;
            existing
        }
        None => ConnectionRecord {
            connection_id,
            driver_kind: driver_kind.to_string(),
            display_name: driver_kind.to_string(),
            auth_method: "api_key".to_string(),
            account_identity: identity,
            credential_ref: "vault".to_string(),
            billing_mode: None,
            endpoints: Vec::new(),
            status: "unverified".to_string(),
            last_checked_ms: None,
            expires_ms: None,
            last_http_status: None,
        },
    };
    registry.save(&record)?;
    registry.set_secret(&record.connection_id, trimmed)
}

/// Applies a saved provider key to the shared registry. Only chat drivers with a
/// non-empty key touch the registry, so vault-only providers keep today's
/// behavior even when the registry is unavailable.
pub fn sync_api_key_connection(driver_kind: &str, secret: &str) -> Result<(), String> {
    if secret.trim().is_empty() || !is_api_key_connection_driver(driver_kind) {
        return Ok(());
    }
    let mut registry = ConnectionRegistry::open()?;
    persist_api_key_connection(&mut registry, driver_kind, secret)
}

/// Read command for both UI builds. It exposes persisted rows as they are; each
/// surface decides which of its own endpoints is verified, so no driver-wide
/// flag is added here.
#[tauri::command]
pub fn list_connections() -> Result<Vec<ConnectionRecord>, String> {
    ConnectionRegistry::open()?.list()
}

#[derive(Debug, Clone, Default)]
pub struct ImportSourceReport {
    pub source: String,
    pub connections_imported: usize,
    pub secrets_imported: usize,
    pub account_profiles_imported: usize,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ImportReport {
    pub registry_path: PathBuf,
    pub already_imported: bool,
    pub connections_total: usize,
    pub sources: Vec<ImportSourceReport>,
    pub error: Option<String>,
}

fn import_completed(conn: &Connection) -> bool {
    let value: Option<String> = conn
        .query_row(
            "SELECT value FROM registry_meta WHERE key = ?1",
            params![LEGACY_IMPORT_MARKER],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten();
    value.as_deref() == Some("done")
}

fn count_connections(conn: &Connection) -> rusqlite::Result<usize> {
    let total: i64 = conn.query_row("SELECT COUNT(*) FROM connections", [], |row| row.get(0))?;
    Ok(total as usize)
}

fn mark_import_complete(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "INSERT INTO registry_meta (key, value) VALUES (?1, 'done')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![LEGACY_IMPORT_MARKER],
    )
    .map(|_| ())
    .map_err(|error| format!("connection registry: {error}"))
}

/// Copies `credentials_vault` rows from one legacy per-install database into the
/// shared registry. The source is opened read-only, so a failed import cannot
/// change its bytes.
fn import_vault_file(
    registry: &mut Connection,
    vault_path: &Path,
    source: &str,
) -> Result<(usize, usize), String> {
    if !vault_path.is_file() {
        return Ok((0, 0));
    }
    let source_conn = Connection::open_with_flags(
        vault_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|error| format!("cannot open {} read-only: {error}", vault_path.display()))?;
    let has_table: i64 = source_conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'credentials_vault'",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("cannot read {}: {error}", vault_path.display()))?;
    if has_table == 0 {
        return Ok((0, 0));
    }

    let mut statement = source_conn
        .prepare("SELECT provider, ciphertext, updated_at_unix_ms FROM credentials_vault")
        .map_err(|error| format!("cannot read {}: {error}", vault_path.display()))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .map_err(|error| format!("cannot read {}: {error}", vault_path.display()))?;
    let mut records = Vec::new();
    for row in rows {
        records.push(row.map_err(|error| format!("cannot read {}: {error}", vault_path.display()))?);
    }
    drop(statement);
    drop(source_conn);

    let imported_at = now_ms();
    let tx = registry
        .transaction()
        .map_err(|error| format!("connection registry: {error}"))?;
    let mut connections = 0usize;
    let mut secrets = 0usize;
    for (provider, ciphertext, updated_at) in records {
        let identity = AccountIdentity::default();
        let connection_id = connection_id_for(&provider, "api_key", &identity);
        let inserted = tx
            .execute(
                "INSERT OR IGNORE INTO connections (
                     connection_id, driver_kind, display_name, auth_method,
                     account_email, account_org_id, account_account_id,
                     credential_ref, billing_mode, status,
                     last_checked_ms, expires_ms, last_http_status,
                     source_app, imported_at_unix_ms
                 ) VALUES (?1, ?2, ?2, ?3, NULL, NULL, NULL, 'vault', NULL, 'imported',
                           NULL, NULL, NULL, ?4, ?5)",
                params![connection_id, provider, "api_key", source, imported_at],
            )
            .map_err(|error| format!("connection registry: {error}"))?;
        connections += inserted;
        let secret_inserted = tx
            .execute(
                "INSERT OR IGNORE INTO connection_secrets
                     (connection_id, ciphertext, updated_at_unix_ms)
                 VALUES (?1, ?2, ?3)",
                params![connection_id, ciphertext, updated_at],
            )
            .map_err(|error| format!("connection registry: {error}"))?;
        secrets += secret_inserted;
    }
    tx.commit()
        .map_err(|error| format!("connection registry: {error}"))?;
    Ok((connections, secrets))
}

/// Imports the per-install connection stores into the shared registry. Called by
/// whichever build opens first; the marker in the shared registry makes the
/// second build a no-op. Source databases, profile trees, and CLI auth files are
/// only ever read.
pub fn import_legacy_connections(appdata: &Path) -> ImportReport {
    let path = registry_path_for(appdata, false);
    let mut report = ImportReport {
        registry_path: path.clone(),
        ..ImportReport::default()
    };

    let mut conn = match open_registry_file(&path) {
        Ok(conn) => conn,
        Err(error) => {
            report.error = Some(error);
            return report;
        }
    };

    if import_completed(&conn) {
        report.already_imported = true;
        report.connections_total = count_connections(&conn).unwrap_or(0);
        return report;
    }

    let shared_profiles_root = shared_connections_root_for(appdata, false)
        .join(ACCOUNT_PROFILES_FOLDER);

    for (label, root) in [
        ("installed", appdata.join(SHARED_INSTALL_FOLDER)),
        ("dev", appdata.join(DEV_INSTALL_FOLDER)),
    ] {
        let mut source = ImportSourceReport {
            source: label.to_string(),
            ..ImportSourceReport::default()
        };
        match import_vault_file(&mut conn, &root.join("kite.sqlite"), label) {
            Ok((connections, secrets)) => {
                source.connections_imported = connections;
                source.secrets_imported = secrets;
            }
            Err(error) => source.error = Some(error),
        }
        match crate::account_switcher::import_account_profiles_from(
            &root.join(ACCOUNT_PROFILES_FOLDER),
            &shared_profiles_root,
        ) {
            Ok(profiles) => source.account_profiles_imported = profiles,
            Err(error) => {
                if source.error.is_none() {
                    source.error = Some(error);
                }
            }
        }
        report.sources.push(source);
    }

    if report.sources.iter().all(|source| source.error.is_none()) {
        if let Err(error) = mark_import_complete(&conn) {
            report.error = Some(error);
        }
    }
    report.connections_total = count_connections(&conn).unwrap_or(0);
    report
}

/// Startup entry point for both builds. The first one imports; the shared
/// marker keeps later launches from copying again.
pub fn ensure_shared_registry() -> &'static ImportReport {
    static IMPORT: OnceLock<ImportReport> = OnceLock::new();
    let report = IMPORT.get_or_init(|| import_legacy_connections(&appdata_base()));
    if let Some(error) = &report.error {
        log_trace(&format!("connections: registry import failed: {error}"));
    }
    for source in &report.sources {
        if let Some(error) = &source.error {
            log_trace(&format!(
                "connections: {} source import failed: {error}",
                source.source
            ));
        }
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity(org_id: &str) -> AccountIdentity {
        AccountIdentity {
            email: None,
            org_id: Some(org_id.to_string()),
            account_id: None,
        }
    }

    #[test]
    fn two_opencode_auth_methods_get_two_connection_ids() {
        let go_key = build_connection(ConnectionDraft {
            driver_kind: "opencode".into(),
            auth_method: "api_key".into(),
            account_identity: identity("org-1"),
            billing_mode: Some("subscription".into()),
            endpoints: vec![],
        });
        let console = build_connection(ConnectionDraft {
            driver_kind: "opencode".into(),
            auth_method: "console_oauth".into(),
            account_identity: identity("org-1"),
            billing_mode: Some("payg".into()),
            endpoints: vec![],
        });

        assert_ne!(go_key.connection_id, console.connection_id);
        assert!(go_key.rejected.is_empty());
        assert!(console.rejected.is_empty());
    }

    #[test]
    fn go_key_is_not_stored_as_valid_for_payg_chat() {
        let stored = build_connection(ConnectionDraft {
            driver_kind: "opencode".into(),
            auth_method: "api_key".into(),
            account_identity: identity("org-1"),
            billing_mode: Some("subscription".into()),
            endpoints: vec![EndpointVerification {
                endpoint_id: OPENCODE_PAYG_CHAT_ENDPOINT.into(),
                ok: true,
            }],
        });

        assert!(stored.rejected.contains(&OPENCODE_PAYG_CHAT_ENDPOINT.to_string()));
        assert!(stored
            .endpoints
            .iter()
            .all(|endpoint| endpoint.endpoint_id != OPENCODE_PAYG_CHAT_ENDPOINT));
    }

    // --- Shared registry across the installed and dev installs (T2 / S6) ----

    use serde_json::Value;

    struct TempAppData(PathBuf);

    impl TempAppData {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "kite-connections-test-{}",
                uuid::Uuid::new_v4()
            ));
            fs::create_dir_all(&dir).expect("create temp app data");
            Self(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempAppData {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn write_legacy_vault(path: &Path, rows: &[(&str, &str)]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create legacy vault dir");
        }
        let conn = Connection::open(path).expect("create legacy vault");
        conn.execute_batch(
            "CREATE TABLE credentials_vault (
                 provider TEXT PRIMARY KEY,
                 ciphertext TEXT NOT NULL,
                 updated_at_unix_ms INTEGER NOT NULL
             );",
        )
        .expect("create credentials_vault");
        for (provider, secret) in rows {
            conn.execute(
                "INSERT INTO credentials_vault (provider, ciphertext, updated_at_unix_ms)
                 VALUES (?1, ?2, ?3)",
                rusqlite::params![provider, crate::credentials::encrypt_secret(secret), 1i64],
            )
            .expect("insert legacy credential");
        }
        drop(conn);
    }

    fn write_legacy_profiles(root: &Path, profiles: &[(&str, &str, &str)]) {
        fs::create_dir_all(root).expect("create legacy profiles root");
        let items: Vec<Value> = profiles
            .iter()
            .map(|(provider, id, email)| {
                serde_json::json!({
                    "id": id,
                    "provider": provider,
                    "label": format!("{provider} {id}"),
                    "email": email,
                    "planName": Value::Null,
                    "isActive": true,
                    "lastUsedUnixMs": 1,
                    "primaryRemainingPercent": Value::Null,
                    "primaryResetAt": Value::Null,
                    "timeUntilResetMs": Value::Null
                })
            })
            .collect();
        let registry = serde_json::json!({ "profiles": items });
        fs::write(
            root.join("profiles.json"),
            serde_json::to_vec_pretty(&registry).expect("serialize profiles"),
        )
        .expect("write legacy profiles");
    }

    #[test]
    fn shared_connections_root_ignores_the_dev_flag() {
        let base = std::env::temp_dir().join(format!(
            "kite-connections-path-{}",
            uuid::Uuid::new_v4()
        ));
        let dev = shared_connections_root_for(&base, true);
        let installed = shared_connections_root_for(&base, false);

        assert_eq!(dev, installed, "dev and installed must resolve the same root");
        let normalized = dev.to_string_lossy().replace('\\', "/");
        assert!(
            normalized.ends_with("Kite Code/connections"),
            "unexpected shared root: {normalized}"
        );
        assert_eq!(
            registry_path_for(&base, true),
            dev.join(REGISTRY_FILE_NAME)
        );
    }

    #[test]
    fn import_reads_both_legacy_vaults_and_keeps_sources_byte_identical() {
        let temp = TempAppData::new();
        let installed_root = temp.path().join(SHARED_INSTALL_FOLDER);
        let dev_root = temp.path().join(DEV_INSTALL_FOLDER);

        let installed_vault = installed_root.join("kite.sqlite");
        let dev_vault = dev_root.join("kite.sqlite");
        write_legacy_vault(
            &installed_vault,
            &[("claude", "sk-ant-installed"), ("opencode", "oc_sk_installed")],
        );
        write_legacy_vault(&dev_vault, &[("codex", "codex-dev-secret")]);

        let installed_profiles = installed_root.join(ACCOUNT_PROFILES_FOLDER);
        write_legacy_profiles(
            &installed_profiles,
            &[("claude", "installed-claude", "installed@example.com")],
        );
        let installed_snapshot = installed_profiles.join("claude").join("installed-claude");
        fs::create_dir_all(&installed_snapshot).expect("create installed snapshot dir");
        fs::write(
            installed_snapshot.join("session.json"),
            b"installed-claude-session",
        )
        .expect("write installed snapshot");

        let dev_profiles = dev_root.join(ACCOUNT_PROFILES_FOLDER);
        write_legacy_profiles(
            &dev_profiles,
            &[("codex", "dev-codex", "dev@example.com")],
        );

        let cli_auth = temp.path().join("user-home").join(".codex").join("auth.json");
        fs::create_dir_all(cli_auth.parent().unwrap()).expect("create cli fixture dir");
        fs::write(&cli_auth, br#"{"token":"cli-fixture"}"#).expect("write cli fixture");

        let installed_vault_before = fs::read(&installed_vault).expect("read installed vault");
        let dev_vault_before = fs::read(&dev_vault).expect("read dev vault");
        let cli_auth_before = fs::read(&cli_auth).expect("read cli fixture");

        let report = import_legacy_connections(temp.path());
        assert!(report.error.is_none(), "import error: {:?}", report.error);
        assert!(!report.already_imported);
        assert_eq!(report.sources.len(), 2);
        for source in &report.sources {
            assert!(
                source.error.is_none(),
                "source {} failed: {:?}",
                source.source,
                source.error
            );
        }

        let registry = ConnectionRegistry::open_at(temp.path()).expect("open shared registry");
        let records = registry.list().expect("list connections");
        assert_eq!(records.len(), 3);

        let claude_id = connection_id_for("claude", "api_key", &AccountIdentity::default());
        let opencode_id = connection_id_for("opencode", "api_key", &AccountIdentity::default());
        let codex_id = connection_id_for("codex", "api_key", &AccountIdentity::default());

        let claude = registry
            .load(&claude_id)
            .expect("load claude")
            .expect("claude connection");
        assert_eq!(claude.driver_kind, "claude");
        assert_eq!(claude.auth_method, "api_key");
        assert_eq!(claude.credential_ref, "vault");
        assert!(claude.endpoints.is_empty());
        assert_eq!(
            registry.get_secret(&claude_id).as_deref(),
            Some("sk-ant-installed")
        );
        assert_eq!(
            registry.get_secret(&opencode_id).as_deref(),
            Some("oc_sk_installed")
        );
        assert_eq!(
            registry.get_secret(&codex_id).as_deref(),
            Some("codex-dev-secret")
        );

        let shared_profiles =
            shared_connections_root_for(temp.path(), false).join(ACCOUNT_PROFILES_FOLDER);
        let profiles: Value = serde_json::from_slice(
            &fs::read(shared_profiles.join("profiles.json")).expect("read shared profiles"),
        )
        .expect("parse shared profiles");
        let profiles = profiles["profiles"].as_array().expect("profiles array");
        assert_eq!(profiles.len(), 2);
        let ids: Vec<&str> = profiles.iter().filter_map(|p| p["id"].as_str()).collect();
        assert!(ids.contains(&"installed-claude"));
        assert!(ids.contains(&"dev-codex"));
        assert_eq!(
            fs::read(
                shared_profiles
                    .join("claude")
                    .join("installed-claude")
                    .join("session.json")
            )
            .expect("read shared snapshot"),
            b"installed-claude-session"
        );

        assert_eq!(fs::read(&installed_vault).unwrap(), installed_vault_before);
        assert_eq!(fs::read(&dev_vault).unwrap(), dev_vault_before);
        assert_eq!(fs::read(&cli_auth).unwrap(), cli_auth_before);

        let second = import_legacy_connections(temp.path());
        assert!(second.already_imported, "import marker must stop a second copy");
    }

    #[test]
    fn partial_import_leaves_sources_and_cli_auth_byte_identical() {
        let temp = TempAppData::new();
        let installed_root = temp.path().join(SHARED_INSTALL_FOLDER);
        let dev_root = temp.path().join(DEV_INSTALL_FOLDER);

        let installed_vault = installed_root.join("kite.sqlite");
        write_legacy_vault(&installed_vault, &[("gemini", "gemini-installed")]);

        let dev_vault = dev_root.join("kite.sqlite");
        fs::create_dir_all(&dev_root).expect("create dev root");
        fs::write(&dev_vault, b"not a sqlite database").expect("write invalid vault");

        let cli_auth = temp.path().join("user-home").join(".codex").join("auth.json");
        fs::create_dir_all(cli_auth.parent().unwrap()).expect("create cli fixture dir");
        fs::write(&cli_auth, br#"{"token":"cli-fixture"}"#).expect("write cli fixture");

        let installed_before = fs::read(&installed_vault).unwrap();
        let dev_before = fs::read(&dev_vault).unwrap();
        let cli_before = fs::read(&cli_auth).unwrap();

        let report = import_legacy_connections(temp.path());
        assert!(
            report.sources.iter().any(|source| source.error.is_some()),
            "an unreadable dev vault must be reported"
        );
        assert_eq!(fs::read(&installed_vault).unwrap(), installed_before);
        assert_eq!(fs::read(&dev_vault).unwrap(), dev_before);
        assert_eq!(fs::read(&cli_auth).unwrap(), cli_before);

        let gemini_id = connection_id_for("gemini", "api_key", &AccountIdentity::default());
        let registry = ConnectionRegistry::open_at(temp.path()).expect("open shared registry");
        assert_eq!(registry.list().unwrap().len(), 1);
        assert_eq!(
            registry.get_secret(&gemini_id).as_deref(),
            Some("gemini-installed")
        );

        let retry = import_legacy_connections(temp.path());
        assert!(
            retry.sources.iter().any(|source| source.error.is_some()),
            "a partial import must not mark the registry complete"
        );

        fs::remove_file(&dev_vault).expect("replace invalid vault");
        write_legacy_vault(&dev_vault, &[("codex", "codex-dev")]);
        let recovered = import_legacy_connections(temp.path());
        assert!(
            recovered.sources.iter().all(|source| source.error.is_none()),
            "retry after fixing the dev vault must succeed: {:?}",
            recovered.sources
        );
        assert_eq!(registry.list().unwrap().len(), 2);
        assert_eq!(fs::read(&cli_auth).unwrap(), cli_before);
    }

    #[test]
    fn saved_connections_land_in_the_shared_registry() {
        let temp = TempAppData::new();
        let identity = AccountIdentity::default();
        let record = ConnectionRecord {
            connection_id: connection_id_for("opencode", "api_key", &identity),
            driver_kind: "opencode".into(),
            display_name: "OpenCode Go".into(),
            auth_method: "api_key".into(),
            account_identity: identity,
            credential_ref: "vault".into(),
            billing_mode: Some("subscription".into()),
            endpoints: vec![EndpointVerification {
                endpoint_id: "https://opencode.ai/zen/go/v1/usage".into(),
                ok: true,
            }],
            status: "verified".into(),
            last_checked_ms: Some(7),
            expires_ms: None,
            last_http_status: Some(200),
        };

        let mut registry = ConnectionRegistry::open_at(temp.path()).expect("open shared registry");
        registry.save(&record).expect("save connection");
        registry
            .set_secret(&record.connection_id, "oc_sk_test")
            .expect("save secret");

        assert_eq!(
            registry.path(),
            registry_path_for(temp.path(), false).as_path()
        );
        assert_eq!(
            registry.load(&record.connection_id).unwrap(),
            Some(record.clone())
        );
        assert_eq!(
            registry.get_secret(&record.connection_id).as_deref(),
            Some("oc_sk_test")
        );
        assert_eq!(registry.list().unwrap().len(), 1);
    }

    #[test]
    fn connection_record_projects_endpoint_rows_without_a_driver_flag() {
        let identity = AccountIdentity::default();
        let record = ConnectionRecord {
            connection_id: connection_id_for("opencode", "api_key", &identity),
            driver_kind: "opencode".into(),
            display_name: "OpenCode Go".into(),
            auth_method: "api_key".into(),
            account_identity: identity,
            credential_ref: "vault".into(),
            billing_mode: Some("subscription".into()),
            endpoints: vec![
                EndpointVerification {
                    endpoint_id: "https://opencode.ai/zen/go/v1/usage".into(),
                    ok: true,
                },
                EndpointVerification {
                    endpoint_id: "https://opencode.ai/inference/go/openai/v1/chat/completions"
                        .into(),
                    ok: false,
                },
            ],
            status: "verified".into(),
            last_checked_ms: Some(7),
            expires_ms: None,
            last_http_status: Some(200),
        };

        let value = serde_json::to_value(&record).expect("serialize connection");
        assert_eq!(value["connectionId"], record.connection_id);
        assert_eq!(value["driverKind"], "opencode");
        assert_eq!(
            value["endpoints"][0]["endpointId"],
            "https://opencode.ai/zen/go/v1/usage"
        );
        assert_eq!(value["endpoints"][0]["ok"], true);
        assert_eq!(value["endpoints"][1]["ok"], false);
        assert!(
            value.get("connected").is_none(),
            "a connection never exposes a driver-wide connected flag"
        );
        assert!(
            value.get("provider").is_none(),
            "the driver id is not the connection key"
        );
    }

    // --- A provider-key save writes the shared registry (T11 / S5, S6) ------

    #[test]
    fn saving_an_api_key_creates_a_shared_connection_without_endpoints() {
        let temp = TempAppData::new();
        let mut registry = ConnectionRegistry::open_at(temp.path()).expect("open shared registry");

        persist_api_key_connection(&mut registry, "opencode", "oc_sk_saved")
            .expect("record the saved key");

        let identity = AccountIdentity::default();
        let connection_id = connection_id_for("opencode", "api_key", &identity);
        let record = registry
            .load(&connection_id)
            .expect("load connection")
            .expect("a saved key must create a connection");

        assert_eq!(record.driver_kind, "opencode");
        assert_eq!(record.display_name, "opencode");
        assert_eq!(record.auth_method, "api_key");
        assert_eq!(record.account_identity, identity);
        assert_eq!(record.credential_ref, "vault");
        assert_eq!(record.status, "unverified");
        assert!(
            record.endpoints.is_empty(),
            "saving a key verifies no endpoint: {:?}",
            record.endpoints
        );
        assert_eq!(
            registry.get_secret(&connection_id).as_deref(),
            Some("oc_sk_saved")
        );

        // The other build opens the same shared file by app-data root.
        let other_build =
            ConnectionRegistry::open_at(temp.path()).expect("reopen the shared registry");
        assert!(
            other_build.load(&connection_id).unwrap().is_some(),
            "both builds must see the saved key connection"
        );
    }

    #[test]
    fn re_saving_an_api_key_keeps_a_verified_endpoint_and_replaces_the_secret() {
        let temp = TempAppData::new();
        let mut registry = ConnectionRegistry::open_at(temp.path()).expect("open shared registry");
        let identity = AccountIdentity::default();
        let connection_id = connection_id_for("opencode", "api_key", &identity);
        let verified_endpoint = "https://opencode.ai/zen/go/v1/usage";

        registry
            .save(&ConnectionRecord {
                connection_id: connection_id.clone(),
                driver_kind: "opencode".into(),
                display_name: "OpenCode Go".into(),
                auth_method: "api_key".into(),
                account_identity: identity.clone(),
                credential_ref: "vault".into(),
                billing_mode: Some("subscription".into()),
                endpoints: vec![EndpointVerification {
                    endpoint_id: verified_endpoint.into(),
                    ok: true,
                }],
                status: "verified".into(),
                last_checked_ms: Some(11),
                expires_ms: Some(22),
                last_http_status: Some(200),
            })
            .expect("seed a verified connection");
        registry
            .set_secret(&connection_id, "oc_sk_old")
            .expect("seed the old secret");

        persist_api_key_connection(&mut registry, "opencode", "oc_sk_new")
            .expect("re-save the api key");

        assert_eq!(
            registry.get_secret(&connection_id).as_deref(),
            Some("oc_sk_new"),
            "re-saving a key must replace the stored secret"
        );
        let record = registry
            .load(&connection_id)
            .expect("load connection")
            .expect("the connection still exists");
        assert!(
            record
                .endpoints
                .iter()
                .any(|endpoint| endpoint.endpoint_id == verified_endpoint && endpoint.ok),
            "re-saving a key must not erase an endpoint a probe already verified: {:?}",
            record.endpoints
        );
        assert!(
            record.endpoints.iter().filter(|endpoint| endpoint.ok).count() == 1,
            "re-saving a key must not mark any new endpoint ok: {:?}",
            record.endpoints
        );
        assert_eq!(record.display_name, "OpenCode Go");
        assert_eq!(record.account_identity, identity);
        assert_eq!(record.billing_mode.as_deref(), Some("subscription"));
        assert_eq!(record.status, "verified");
        assert_eq!(record.last_checked_ms, Some(11));
        assert_eq!(record.expires_ms, Some(22));
        assert_eq!(record.last_http_status, Some(200));
    }

    #[test]
    fn saving_an_opencode_key_never_leaves_a_payg_chat_endpoint_ok() {
        let temp = TempAppData::new();
        let mut registry = ConnectionRegistry::open_at(temp.path()).expect("open shared registry");
        let identity = AccountIdentity::default();
        let connection_id = connection_id_for("opencode", "api_key", &identity);

        // A row from an older store that wrongly claims pay-as-you-go chat for
        // a Go key.
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
                        endpoint_id: OPENCODE_PAYG_CHAT_ENDPOINT.into(),
                        ok: true,
                    },
                    EndpointVerification {
                        endpoint_id: "https://opencode.ai/inference/openai/v1/chat/completions"
                            .into(),
                        ok: true,
                    },
                ],
                status: "verified".into(),
                last_checked_ms: Some(1),
                expires_ms: None,
                last_http_status: Some(200),
            })
            .expect("seed stale row");

        persist_api_key_connection(&mut registry, "opencode", "oc_sk_go_key")
            .expect("record the saved key");

        let record = registry
            .load(&connection_id)
            .unwrap()
            .expect("connection exists");
        assert!(
            record.endpoints.iter().all(|endpoint| !endpoint.ok),
            "a key save must not leave any endpoint verified: {:?}",
            record.endpoints
        );
        for endpoint_id in [
            OPENCODE_PAYG_CHAT_ENDPOINT,
            "https://opencode.ai/inference/openai/v1/chat/completions",
        ] {
            assert!(
                !record
                    .endpoints
                    .iter()
                    .any(|endpoint| endpoint.endpoint_id == endpoint_id && endpoint.ok),
                "pay-as-you-go chat endpoint {endpoint_id} must not be ok after a key save"
            );
        }
    }

    #[test]
    fn saving_a_grok_key_uses_its_own_api_key_connection() {
        let temp = TempAppData::new();
        let mut registry = ConnectionRegistry::open_at(temp.path()).expect("open shared registry");

        persist_api_key_connection(&mut registry, "grok", "xai-test-key")
            .expect("record the saved key");

        let identity = AccountIdentity::default();
        let grok_id = connection_id_for("grok", "api_key", &identity);
        let record = registry
            .load(&grok_id)
            .expect("load connection")
            .expect("grok key must create a connection");
        assert_eq!(record.driver_kind, "grok");
        assert_eq!(record.auth_method, "api_key");
        assert_eq!(record.credential_ref, "vault");
        assert_eq!(
            registry.get_secret(&grok_id).as_deref(),
            Some("xai-test-key")
        );
        assert_ne!(
            grok_id,
            connection_id_for("opencode", "api_key", &identity),
            "connections are not keyed by auth method alone"
        );
    }

    #[test]
    fn an_empty_api_key_creates_no_connection() {
        let temp = TempAppData::new();
        let mut registry = ConnectionRegistry::open_at(temp.path()).expect("open shared registry");

        persist_api_key_connection(&mut registry, "opencode", "   ").expect("empty key is a no-op");

        assert!(
            registry.list().unwrap().is_empty(),
            "an empty key must not create a connection"
        );
        let connection_id = connection_id_for("opencode", "api_key", &AccountIdentity::default());
        assert!(registry.get_secret(&connection_id).is_none());
    }

    #[test]
    fn non_chat_provider_keys_stay_vault_only() {
        let temp = TempAppData::new();
        let mut registry = ConnectionRegistry::open_at(temp.path()).expect("open shared registry");

        for provider in [
            "grok_transcription",
            "vercel",
            "cloudflare",
            "cloudflare_account_id",
        ] {
            persist_api_key_connection(&mut registry, provider, "secret-value")
                .expect("a vault-only key is not a connection");
        }

        assert!(
            registry.list().unwrap().is_empty(),
            "only opencode and grok keys own a shared chat connection"
        );
    }

    #[test]
    fn a_failed_registry_write_is_reported() {
        let temp = TempAppData::new();
        let mut registry = ConnectionRegistry::open_at(temp.path()).expect("open shared registry");
        registry
            .conn
            .execute_batch(
                "CREATE TRIGGER deny_connection_insert BEFORE INSERT ON connections
                 BEGIN SELECT RAISE(ABORT, 'denied by test'); END;",
            )
            .expect("install failing trigger");

        let error = persist_api_key_connection(&mut registry, "opencode", "oc_sk_saved")
            .expect_err("a failed registry write must not look like success");
        assert!(
            error.contains("connection registry") || error.contains("denied by test"),
            "unexpected registry error: {error}"
        );
    }
}
