use super::service::ANTIGRAVITY_DRIVER_KIND;
use crate::connections::{connection_id_for, AccountIdentity, ConnectionRegistry};
use crate::quota::types::ProviderQuotaStatus;
use crate::quota::utils::{b64url_decode, now_ms, user_home_dir};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

pub const WIN32_CRED_MAX_BLOB_BYTES: usize = 2560;

pub const IDE_AUTH_STATE_KEYS: [&str; 4] = [
    "antigravityAuthStatus",
    "antigravityUnifiedStateSync.oauthToken",
    "antigravityUnifiedStateSync.userStatus",
    "antigravity.profileUrl",
];

#[cfg(windows)]
pub fn read_antigravity_raw_credential() -> Option<String> {
    use std::ptr::null_mut;

    #[repr(C)]
    struct CREDENTIALW {
        flags: u32,
        cred_type: u32,
        target_name: *mut u16,
        comment: *mut u16,
        last_written: [u32; 2],
        credential_blob_size: u32,
        credential_blob: *mut u8,
        persist: u32,
        attribute_count: u32,
        attributes: *mut std::ffi::c_void,
        target_alias: *mut u16,
        user_name: *mut u16,
    }

    #[link(name = "advapi32")]
    extern "system" {
        fn CredReadW(target_name: *const u16, cred_type: u32, flags: u32, credential: *mut *mut CREDENTIALW) -> i32;
        fn CredFree(credential: *mut std::ffi::c_void);
    }

    let target = "gemini:antigravity";
    let target_utf16: Vec<u16> = target.encode_utf16().chain(std::iter::once(0)).collect();
    let mut cred_ptr: *mut CREDENTIALW = null_mut();

    unsafe {
        if CredReadW(target_utf16.as_ptr(), 1 /* CRED_TYPE_GENERIC */, 0, &mut cred_ptr) != 0 && !cred_ptr.is_null() {
            let cred = &*cred_ptr;
            let slice = std::slice::from_raw_parts(cred.credential_blob, cred.credential_blob_size as usize);
            let raw_str = String::from_utf8_lossy(slice).to_string();
            CredFree(cred_ptr as *mut std::ffi::c_void);
            return Some(raw_str);
        }
    }
    None
}

#[cfg(not(windows))]
pub fn read_antigravity_raw_credential() -> Option<String> {
    None
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityCredentialIdentity {
    pub email: String,
    pub name: Option<String>,
    pub auth_method: Option<String>,
    #[serde(default)]
    pub has_access_token: bool,
    pub has_refresh_token: bool,
    pub expiry: Option<String>,
    pub source: String,
}

impl AntigravityCredentialIdentity {
    pub fn has_valid_tokens(&self) -> bool {
        self.has_access_token || self.has_refresh_token
    }
}

fn read_token_string_field(val: &Value, key: &str) -> Option<String> {
    val.get("token")
        .and_then(|t| t.get(key))
        .or_else(|| val.get(key))
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

pub fn parse_antigravity_credential_blob(raw: &str) -> Option<AntigravityCredentialIdentity> {
    let val: Value = serde_json::from_str(raw).ok()?;

    let mut email: Option<String> = None;
    let mut name: Option<String> = None;

    // 1. Try decoding id_token JWT if present
    let id_token_str = val
        .get("id_token")
        .or_else(|| val.pointer("/token/id_token"))
        .and_then(|v| v.as_str());

    if let Some(id_token) = id_token_str {
        let parts: Vec<&str> = id_token.split('.').collect();
        if parts.len() >= 2 {
            if let Some(payload_bytes) = b64url_decode(parts[1]) {
                if let Ok(jwt_json) = serde_json::from_slice::<Value>(&payload_bytes) {
                    if let Some(e) = jwt_json
                        .get("email")
                        .and_then(|v| v.as_str())
                        .map(|s| s.trim().to_string())
                    {
                        if !e.is_empty() {
                            email = Some(e);
                            name = jwt_json
                                .get("name")
                                .and_then(|v| v.as_str())
                                .map(|s| s.trim().to_string());
                        }
                    }
                }
            }
        }
    }

    // 2. If id_token had no email or wasn't present, check id_token_email or top-level email
    if email.is_none() {
        email = val
            .get("id_token_email")
            .or_else(|| val.pointer("/token/id_token_email"))
            .or_else(|| val.get("email"))
            .or_else(|| val.pointer("/token/email"))
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
    }

    let email = email?;

    let auth_method = val
        .get("auth_method")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string());

    let has_access_token = read_token_string_field(&val, "access_token").is_some();
    let has_refresh_token = read_token_string_field(&val, "refresh_token").is_some();

    let expiry = val
        .pointer("/token/expiry")
        .or_else(|| val.get("expiry"))
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string());

    Some(AntigravityCredentialIdentity {
        email,
        name,
        auth_method,
        has_access_token,
        has_refresh_token,
        expiry,
        source: "gemini:antigravity".to_string(),
    })
}

/// Validates JSON structure, email identity, and presence of usable OAuth
/// token material (`access_token` or `refresh_token`).
pub fn parse_antigravity_credential_with_tokens(
    raw: &str,
) -> Result<AntigravityCredentialIdentity, &'static str> {
    let identity = parse_antigravity_credential_blob(raw).ok_or("corrupt")?;
    if !identity.has_valid_tokens() {
        return Err("missing_tokens");
    }
    Ok(identity)
}

pub fn has_valid_antigravity_oauth_tokens(raw: &str) -> bool {
    parse_antigravity_credential_with_tokens(raw).is_ok()
}

pub fn extract_antigravity_token_material(raw: &str) -> (Option<String>, Option<String>) {
    let Ok(val) = serde_json::from_str::<Value>(raw) else {
        return (None, None);
    };
    (
        read_token_string_field(&val, "refresh_token"),
        read_token_string_field(&val, "access_token"),
    )
}

pub fn inspect_antigravity_credential_file(cred_file: &Path) -> (&'static str, bool) {
    if !cred_file.exists() {
        return ("missing_file", false);
    }
    let Ok(raw) = std::fs::read_to_string(cred_file) else {
        return ("corrupt", false);
    };
    match parse_antigravity_credential_with_tokens(&raw) {
        Ok(ident) => ("valid", ident.has_refresh_token),
        Err(code) => (code, false),
    }
}

pub fn read_antigravity_credential() -> Option<(String, Option<String>)> {
    let raw = read_antigravity_raw_credential()?;
    let identity = parse_antigravity_credential_blob(&raw)?;
    Some((identity.email, identity.name))
}

#[cfg(windows)]
pub fn write_antigravity_credential_checked(blob_json: &str) -> Result<(), String> {
    #[repr(C)]
    struct CREDENTIALW {
        flags: u32,
        cred_type: u32,
        target_name: *mut u16,
        comment: *mut u16,
        last_written: [u32; 2],
        credential_blob_size: u32,
        credential_blob: *mut u8,
        persist: u32,
        attribute_count: u32,
        attributes: *mut std::ffi::c_void,
        target_alias: *mut u16,
        user_name: *mut u16,
    }

    #[link(name = "advapi32")]
    extern "system" {
        fn CredWriteW(credential: *const CREDENTIALW, flags: u32) -> i32;
    }

    let mut blob_bytes = blob_json.as_bytes().to_vec();
    if blob_bytes.len() > WIN32_CRED_MAX_BLOB_BYTES {
        return Err(format!(
            "La credencial de Antigravity ({} bytes) excede el límite de {} bytes del Administrador de credenciales de Windows.",
            blob_bytes.len(),
            WIN32_CRED_MAX_BLOB_BYTES
        ));
    }

    let mut target_utf16: Vec<u16> = "gemini:antigravity".encode_utf16().chain(std::iter::once(0)).collect();
    let mut user_utf16: Vec<u16> = "antigravity".encode_utf16().chain(std::iter::once(0)).collect();

    let cred = CREDENTIALW {
        flags: 0,
        cred_type: 1, // CRED_TYPE_GENERIC
        target_name: target_utf16.as_mut_ptr(),
        comment: std::ptr::null_mut(),
        last_written: [0, 0],
        credential_blob_size: blob_bytes.len() as u32,
        credential_blob: blob_bytes.as_mut_ptr(),
        persist: 2, // CRED_PERSIST_LOCAL_MACHINE
        attribute_count: 0,
        attributes: std::ptr::null_mut(),
        target_alias: std::ptr::null_mut(),
        user_name: user_utf16.as_mut_ptr(),
    };

    let ok = unsafe { CredWriteW(&cred, 0) != 0 };
    if ok {
        Ok(())
    } else {
        let err = std::io::Error::last_os_error();
        Err(format!(
            "Error del Administrador de credenciales de Windows al escribir gemini:antigravity ({} bytes, límite Win32 {} bytes): código {:?} — {}",
            blob_bytes.len(),
            WIN32_CRED_MAX_BLOB_BYTES,
            err.raw_os_error(),
            err
        ))
    }
}

#[cfg(not(windows))]
pub fn write_antigravity_credential_checked(blob_json: &str) -> Result<(), String> {
    let byte_len = blob_json.as_bytes().len();
    if byte_len > WIN32_CRED_MAX_BLOB_BYTES {
        return Err(format!(
            "La credencial de Antigravity ({byte_len} bytes) excede el límite de {} bytes.",
            WIN32_CRED_MAX_BLOB_BYTES
        ));
    }
    Err("La escritura de credenciales en gemini:antigravity solo está soportada en Windows en esta versión.".to_string())
}

pub fn write_antigravity_credential(blob_json: &str) -> bool {
    write_antigravity_credential_checked(blob_json).is_ok()
}

#[cfg(windows)]
pub fn delete_antigravity_credential() -> bool {
    #[link(name = "advapi32")]
    extern "system" {
        fn CredDeleteW(target_name: *const u16, cred_type: u32, flags: u32) -> i32;
    }

    let target_utf16: Vec<u16> = "gemini:antigravity".encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        if CredDeleteW(target_utf16.as_ptr(), 1 /* CRED_TYPE_GENERIC */, 0) != 0 {
            true
        } else {
            let err = std::io::Error::last_os_error().raw_os_error();
            err == Some(1168)
        }
    }
}

#[cfg(not(windows))]
pub fn delete_antigravity_credential() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdeAuthStateSnapshot {
    pub email: Option<String>,
    pub keys: BTreeMap<String, String>,
}

pub fn state_vscdb_candidates() -> Vec<PathBuf> {
    let home = user_home_dir();
    let appdata = std::env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home.join("AppData").join("Roaming"));

    vec![
        appdata
            .join("Antigravity")
            .join("User")
            .join("globalStorage")
            .join("state.vscdb"),
        home.join(".config")
            .join("Antigravity")
            .join("User")
            .join("globalStorage")
            .join("state.vscdb"),
        home.join("Library")
            .join("Application Support")
            .join("Antigravity")
            .join("User")
            .join("globalStorage")
            .join("state.vscdb"),
    ]
}

pub fn find_existing_state_vscdb() -> Option<PathBuf> {
    state_vscdb_candidates().into_iter().find(|p| p.is_file())
}

fn open_state_db_readonly(db_path: &Path) -> Result<rusqlite::Connection, String> {
    if let Ok(conn) =
        rusqlite::Connection::open_with_flags(db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
    {
        return Ok(conn);
    }
    let uri = format!(
        "file:{}?mode=ro&immutable=1",
        db_path.to_string_lossy().replace('\\', "/")
    );
    rusqlite::Connection::open_with_flags(
        &uri,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|e| format!("No se pudo abrir {} en modo solo lectura: {e}", db_path.display()))
}

fn read_value_as_utf8(value_ref: rusqlite::types::ValueRef<'_>) -> Option<String> {
    match value_ref {
        rusqlite::types::ValueRef::Text(bytes) | rusqlite::types::ValueRef::Blob(bytes) => {
            std::str::from_utf8(bytes).ok().map(String::from)
        }
        _ => None,
    }
}

fn has_item_table(conn: &rusqlite::Connection) -> Result<bool, String> {
    conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'ItemTable'",
        [],
        |r| r.get::<_, i64>(0),
    )
    .map(|count| count > 0)
    .map_err(|e| format!("No se pudo inspeccionar sqlite_master en state.vscdb: {e}"))
}

fn parse_ide_auth_status_email(raw: &str) -> Option<(String, Option<String>)> {
    let val: Value = serde_json::from_str(raw).ok()?;
    let email = val
        .get("email")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())?;
    let name = val
        .get("name")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    Some((email, name))
}

pub fn extract_ide_auth_rows_from_db(db_path: &Path) -> Result<BTreeMap<String, String>, String> {
    if !db_path.exists() {
        return Ok(BTreeMap::new());
    }
    let conn = open_state_db_readonly(db_path)?;
    if !has_item_table(&conn)? {
        return Ok(BTreeMap::new());
    }

    let mut stmt = conn
        .prepare("SELECT key, value FROM ItemTable WHERE key IN (?1, ?2, ?3, ?4)")
        .map_err(|e| format!("No se pudo consultar ItemTable en {}: {e}", db_path.display()))?;
    let mut rows = stmt
        .query(rusqlite::params![
            IDE_AUTH_STATE_KEYS[0],
            IDE_AUTH_STATE_KEYS[1],
            IDE_AUTH_STATE_KEYS[2],
            IDE_AUTH_STATE_KEYS[3],
        ])
        .map_err(|e| format!("Error leyendo filas de auth en {}: {e}", db_path.display()))?;

    let mut extracted = BTreeMap::new();
    while let Some(row) = rows
        .next()
        .map_err(|e| format!("Error iterando ItemTable en {}: {e}", db_path.display()))?
    {
        let key: String = row
            .get(0)
            .map_err(|e| format!("Clave inválida en ItemTable: {e}"))?;
        let val_ref = row
            .get_ref(1)
            .map_err(|e| format!("Valor inválido en ItemTable para {key}: {e}"))?;
        if let Some(val_str) = read_value_as_utf8(val_ref) {
            extracted.insert(key, val_str);
        }
    }
    Ok(extracted)
}

pub fn extract_ide_auth_state_from_db(
    db_path: &Path,
) -> Result<Option<IdeAuthStateSnapshot>, String> {
    let keys = extract_ide_auth_rows_from_db(db_path)?;
    if keys.is_empty() {
        return Ok(None);
    }
    let email = keys
        .get("antigravityAuthStatus")
        .and_then(|raw| parse_ide_auth_status_email(raw))
        .map(|(email, _)| email);
    if email.is_none() {
        return Ok(None);
    }
    Ok(Some(IdeAuthStateSnapshot { email, keys }))
}

fn delete_ide_auth_keys_in_tx(tx: &rusqlite::Transaction<'_>) -> Result<(), String> {
    tx.execute(
        "DELETE FROM ItemTable WHERE key IN (?1, ?2, ?3, ?4)",
        rusqlite::params![
            IDE_AUTH_STATE_KEYS[0],
            IDE_AUTH_STATE_KEYS[1],
            IDE_AUTH_STATE_KEYS[2],
            IDE_AUTH_STATE_KEYS[3],
        ],
    )
    .map_err(|e| format!("No se pudieron limpiar las claves de sesión en state.vscdb: {e}"))?;
    Ok(())
}

pub fn apply_ide_auth_state_to_db(
    db_path: &Path,
    expected_email: &str,
    snapshot: Option<&IdeAuthStateSnapshot>,
) -> Result<(), String> {
    if !db_path.exists() {
        return Ok(());
    }
    let mut conn = rusqlite::Connection::open(db_path)
        .map_err(|e| format!("No se pudo abrir {} para actualizar sesión del IDE: {e}", db_path.display()))?;
    if !has_item_table(&conn)? {
        return Ok(());
    }

    let tx = conn
        .transaction()
        .map_err(|e| format!("No se pudo iniciar transacción en state.vscdb: {e}"))?;

    match snapshot {
        Some(snap)
            if snap
                .email
                .as_deref()
                .map_or(true, |e| e.eq_ignore_ascii_case(expected_email))
                && !snap.keys.is_empty() =>
        {
            delete_ide_auth_keys_in_tx(&tx)?;
            for (k, v) in &snap.keys {
                if !IDE_AUTH_STATE_KEYS.contains(&k.as_str()) {
                    continue;
                }
                tx.execute(
                    "INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?1, ?2)",
                    rusqlite::params![k, v],
                )
                .map_err(|e| format!("No se pudo restaurar {k} en state.vscdb: {e}"))?;
            }
        }
        _ => {
            let existing_raw: Option<String> = tx
                .query_row(
                    "SELECT value FROM ItemTable WHERE key = 'antigravityAuthStatus'",
                    [],
                    |r| match r.get_ref(0) {
                        Ok(vr) => Ok(read_value_as_utf8(vr)),
                        Err(e) => Err(e),
                    },
                )
                .ok()
                .flatten();

            let should_clear = match existing_raw {
                Some(ref raw) => match parse_ide_auth_status_email(raw) {
                    Some((ide_email, _)) => !ide_email.eq_ignore_ascii_case(expected_email),
                    None => true,
                },
                None => true,
            };

            if should_clear {
                delete_ide_auth_keys_in_tx(&tx)?;
            }
        }
    }

    tx.commit()
        .map_err(|e| format!("No se pudo confirmar la transacción de state.vscdb: {e}"))?;
    Ok(())
}

pub fn restore_ide_auth_rows_to_db(
    db_path: &Path,
    rows: &BTreeMap<String, String>,
) -> Result<(), String> {
    if !db_path.exists() {
        return Ok(());
    }
    let mut conn = rusqlite::Connection::open(db_path)
        .map_err(|e| format!("No se pudo abrir {} para revertir sesión del IDE: {e}", db_path.display()))?;
    if !has_item_table(&conn)? {
        return Ok(());
    }
    let tx = conn
        .transaction()
        .map_err(|e| format!("No se pudo iniciar transacción de reversión en state.vscdb: {e}"))?;
    delete_ide_auth_keys_in_tx(&tx)?;
    for (k, v) in rows {
        if !IDE_AUTH_STATE_KEYS.contains(&k.as_str()) {
            continue;
        }
        tx.execute(
            "INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?1, ?2)",
            rusqlite::params![k, v],
        )
        .map_err(|e| format!("No se pudo revertir {k} en state.vscdb: {e}"))?;
    }
    tx.commit()
        .map_err(|e| format!("No se pudo confirmar reversión de state.vscdb: {e}"))?;
    Ok(())
}

pub fn read_antigravity_ide_identity() -> Option<(String, Option<String>)> {
    for db in state_vscdb_candidates() {
        if !db.exists() {
            continue;
        }
        if let Ok(conn) = open_state_db_readonly(&db) {
            if let Ok(Some(raw)) = conn.query_row(
                "SELECT value FROM ItemTable WHERE key = 'antigravityAuthStatus'",
                [],
                |r| match r.get_ref(0) {
                    Ok(vr) => Ok(read_value_as_utf8(vr)),
                    Err(e) => Err(e),
                },
            ) {
                if let Some(parsed) = parse_ide_auth_status_email(&raw) {
                    return Some(parsed);
                }
            }
        }
    }
    None
}

pub fn enrich_antigravity_identity(status: &mut ProviderQuotaStatus) {
    // 1. Try Windows Credential Manager gemini:antigravity first (authoritative active CLI session)
    if let Some((email, name)) = read_antigravity_credential() {
        status.metadata.insert("email".to_string(), json!(email));
        if let Some(n) = name {
            status.metadata.insert("userName".to_string(), json!(n));
        }
        status.metadata.insert("accountSource".to_string(), json!("gemini:antigravity"));
    }

    // 2. Check Antigravity IDE state.vscdb
    if let Some((ide_email, ide_name)) = read_antigravity_ide_identity() {
        if let Some(cli_email) = status.metadata.get("email").and_then(|v| v.as_str()).map(|s| s.to_string()) {
            if !cli_email.eq_ignore_ascii_case(&ide_email) {
                status.metadata.insert("ideEmail".to_string(), json!(ide_email));
                status.metadata.insert("splitBrainWarning".to_string(), json!(true));
            }
        } else {
            status.metadata.insert("email".to_string(), json!(ide_email));
            if let Some(n) = ide_name {
                status.metadata.insert("userName".to_string(), json!(n));
            }
            status.metadata.insert("accountSource".to_string(), json!("Antigravity IDE"));
        }
    }

    // Default planType if not already present
    if !status.metadata.contains_key("planType") {
        status.metadata.insert("planType".to_string(), json!("Google AI Pro"));
    }
}

pub fn enrich_google_identity(status: &mut ProviderQuotaStatus) {
    enrich_antigravity_identity(status);
}

/// Identity the Google files and the Windows credential expose. It is an
/// identity only: it never proves that an inference endpoint works.
pub struct GoogleIdentity {
    pub email: String,
    pub source: String,
}

pub fn read_google_identity() -> Option<GoogleIdentity> {
    // Reuse the quota enrichment precedence instead of reading the same files a
    // second way. The metadata it fills is the identity the quota surface shows.
    let mut status = ProviderQuotaStatus {
        provider_id: ANTIGRAVITY_DRIVER_KIND.to_string(),
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
    enrich_google_identity(&mut status);
    let email = status.metadata.get("email")?.as_str()?.trim().to_string();
    if email.is_empty() {
        return None;
    }
    let source = status
        .metadata
        .get("accountSource")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string();
    Some(GoogleIdentity { email, source })
}

/// Shared Gemini CLI files also name an account when no Antigravity install
/// exists. Only an Antigravity-owned source proves Antigravity is present.
pub fn google_identity_is_antigravity_owned(identity: &GoogleIdentity) -> bool {
    matches!(
        identity.source.as_str(),
        "gemini:antigravity" | "Antigravity IDE"
    )
}

pub fn antigravity_api_key_present() -> bool {
    if crate::credentials::get_vault_credential(ANTIGRAVITY_DRIVER_KIND)
        .map_or(false, |key| !key.trim().is_empty())
    {
        return true;
    }
    let connection_id =
        connection_id_for(ANTIGRAVITY_DRIVER_KIND, "api_key", &AccountIdentity::default());
    ConnectionRegistry::open()
        .ok()
        .and_then(|registry| registry.get_secret(&connection_id))
        .is_some()
}
