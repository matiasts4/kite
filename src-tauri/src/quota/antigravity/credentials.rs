use super::service::ANTIGRAVITY_DRIVER_KIND;
use crate::connections::{connection_id_for, AccountIdentity, ConnectionRegistry};
use crate::quota::types::ProviderQuotaStatus;
use crate::quota::utils::{b64url_decode, now_ms, user_home_dir};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;

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
    pub has_refresh_token: bool,
    pub expiry: Option<String>,
    pub source: String,
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

    let has_refresh_token = val
        .pointer("/token/refresh_token")
        .or_else(|| val.get("refresh_token"))
        .and_then(|v| v.as_str())
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);

    let expiry = val
        .pointer("/token/expiry")
        .or_else(|| val.get("expiry"))
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string());

    Some(AntigravityCredentialIdentity {
        email,
        name,
        auth_method,
        has_refresh_token,
        expiry,
        source: "gemini:antigravity".to_string(),
    })
}

pub fn read_antigravity_credential() -> Option<(String, Option<String>)> {
    let raw = read_antigravity_raw_credential()?;
    let identity = parse_antigravity_credential_blob(&raw)?;
    Some((identity.email, identity.name))
}

#[cfg(windows)]
pub fn write_antigravity_credential(blob_json: &str) -> bool {
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

    let mut target_utf16: Vec<u16> = "gemini:antigravity".encode_utf16().chain(std::iter::once(0)).collect();
    let mut user_utf16: Vec<u16> = "antigravity".encode_utf16().chain(std::iter::once(0)).collect();
    let mut blob_bytes = blob_json.as_bytes().to_vec();

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

    unsafe { CredWriteW(&cred, 0) != 0 }
}

#[cfg(not(windows))]
pub fn write_antigravity_credential(_blob_json: &str) -> bool {
    false
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

pub fn read_antigravity_ide_identity() -> Option<(String, Option<String>)> {
    let home = user_home_dir();
    let appdata = std::env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home.join("AppData").join("Roaming"));

    let candidates = vec![
        appdata.join("Antigravity").join("User").join("globalStorage").join("state.vscdb"),
        home.join(".config").join("Antigravity").join("User").join("globalStorage").join("state.vscdb"),
        home.join("Library").join("Application Support").join("Antigravity").join("User").join("globalStorage").join("state.vscdb"),
    ];

    for db in candidates {
        if !db.exists() {
            continue;
        }
        let uri = format!("file:{}?mode=ro&immutable=1", db.to_string_lossy().replace('\\', "/"));
        if let Ok(conn) = rusqlite::Connection::open_with_flags(
            &uri,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
        ) {
            if let Ok(raw) = conn.query_row(
                "SELECT value FROM ItemTable WHERE key = 'antigravityAuthStatus'",
                [],
                |r| r.get::<_, String>(0),
            ) {
                if let Ok(val) = serde_json::from_str::<Value>(&raw) {
                    if let Some(email) = val.get("email").and_then(|v| v.as_str()).map(|s| s.trim().to_string()) {
                        if !email.is_empty() {
                            let name = val.get("name").and_then(|v| v.as_str()).map(|s| s.trim().to_string());
                            return Some((email, name));
                        }
                    }
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
