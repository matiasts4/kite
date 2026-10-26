// Kite Code — Secure Unified Credentials Vault & Resolution Engine
// Stores encrypted API keys in kite.sqlite with OS/user-bound protection
// Fallback hierarchy: User Vault (SQLite) -> Environment (.env / System) -> CLI / Local Session

use crate::persist::{body, db_connection};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CredentialSource {
    Vault,
    Env,
    Cli,
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialStatus {
    pub provider: String,
    pub is_configured: bool,
    pub source: CredentialSource,
    pub preview: Option<String>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Derives a machine-and-user-bound encryption key using SHA-256.
/// This prevents trivial extraction of secrets if the database is copied to another machine or user.
fn derive_user_bound_key() -> [u8; 32] {
    let mut hasher = Sha256::new();
    let user_profile = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| "kite-default-user".to_string());
    let machine_hint = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "kite-host".to_string());

    hasher.update(b"kite-credentials-vault-salt-v1:");
    hasher.update(user_profile.as_bytes());
    hasher.update(b":");
    hasher.update(machine_hint.as_bytes());

    let result = hasher.finalize();
    let mut key = [0u8; 32];
    key.copy_from_slice(&result[..32]);
    key
}

/// Encrypts plaintext bytes using a keystream derived from the user-bound key.
pub(crate) fn encrypt_secret(plain: &str) -> String {
    let key = derive_user_bound_key();
    let plain_bytes = plain.as_bytes();
    let mut cipher = Vec::with_capacity(plain_bytes.len());

    for (i, &b) in plain_bytes.iter().enumerate() {
        let k = key[i % key.len()];
        // Shift with keystream byte and position offset
        cipher.push(b ^ k ^ ((i as u8).wrapping_mul(31)));
    }

    // Base64 encode for storage
    let mut s = String::new();
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    for chunk in cipher.chunks(3) {
        let b0 = chunk[0] as usize;
        let b1 = if chunk.len() > 1 { chunk[1] as usize } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as usize } else { 0 };

        s.push(CHARS[(b0 >> 2) & 0x3F] as char);
        s.push(CHARS[((b0 << 4) | (b1 >> 4)) & 0x3F] as char);
        if chunk.len() > 1 {
            s.push(CHARS[((b1 << 2) | (b2 >> 6)) & 0x3F] as char);
        } else {
            s.push('=');
        }
        if chunk.len() > 2 {
            s.push(CHARS[b2 & 0x3F] as char);
        } else {
            s.push('=');
        }
    }
    s
}

/// Decrypts ciphertext string using the user-bound key.
pub(crate) fn decrypt_secret(cipher_b64: &str) -> Option<String> {
    let trimmed = cipher_b64.trim();
    if trimmed.is_empty() {
        return None;
    }

    // Simple Base64 decode
    let mut bytes = Vec::new();
    let mut buf = 0u32;
    let mut bits = 0;
    for &ch in trimmed.as_bytes() {
        let val = match ch {
            b'A'..=b'Z' => ch - b'A',
            b'a'..=b'z' => ch - b'a' + 26,
            b'0'..=b'9' => ch - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => continue,
            _ => continue,
        } as u32;
        buf = (buf << 6) | val;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            bytes.push((buf >> bits) as u8);
            buf &= (1 << bits) - 1;
        }
    }

    let key = derive_user_bound_key();
    let mut plain_bytes = Vec::with_capacity(bytes.len());
    for (i, &b) in bytes.iter().enumerate() {
        let k = key[i % key.len()];
        plain_bytes.push(b ^ k ^ ((i as u8).wrapping_mul(31)));
    }

    String::from_utf8(plain_bytes).ok()
}

/// Creates a safe preview of an API key (e.g., "xai-...3f9a")
pub fn mask_key_preview(key: &str) -> String {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.len() <= 8 {
        return "••••••••".to_string();
    }
    let prefix = if let Some(idx) = trimmed.find('-') {
        &trimmed[..=idx]
    } else {
        &trimmed[..3.min(trimmed.len())]
    };
    let suffix = &trimmed[trimmed.len().saturating_sub(4)..];
    format!("{prefix}...{suffix}")
}

/// Ensures the credentials_vault table exists in kite.sqlite
pub fn ensure_credentials_table() {
    let conn = db_connection().lock().unwrap();
    let _ = conn.execute(
        "CREATE TABLE IF NOT EXISTS credentials_vault (
            provider TEXT PRIMARY KEY,
            ciphertext TEXT NOT NULL,
            updated_at_unix_ms INTEGER NOT NULL
        )",
        [],
    );
}

/// Reads a stored credential from the SQLite vault
pub fn get_vault_credential(provider: &str) -> Option<String> {
    ensure_credentials_table();
    let conn = db_connection().lock().unwrap();
    let row: Option<String> = conn
        .query_row(
            "SELECT ciphertext FROM credentials_vault WHERE provider = ?1",
            params![provider],
            |r| r.get(0),
        )
        .ok();

    row.and_then(|cipher| decrypt_secret(&cipher))
        .filter(|k| !k.trim().is_empty())
}

/// Stores a credential into the SQLite vault with user-bound encryption
pub fn set_vault_credential(provider: &str, key: &str) -> Result<(), String> {
    ensure_credentials_table();
    let trimmed = key.trim();
    let conn = db_connection().lock().unwrap();

    if trimmed.is_empty() {
        let _ = conn.execute(
            "DELETE FROM credentials_vault WHERE provider = ?1",
            params![provider],
        );
        return Ok(());
    }

    let cipher = encrypt_secret(trimmed);
    let now = now_ms();
    conn.execute(
        "INSERT INTO credentials_vault (provider, ciphertext, updated_at_unix_ms)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(provider) DO UPDATE SET
            ciphertext = excluded.ciphertext,
            updated_at_unix_ms = excluded.updated_at_unix_ms",
        params![provider, cipher, now],
    )
    .map_err(|e| format!("Failed to save credential for '{provider}': {e}"))?;

    Ok(())
}

/// Removes a credential from the vault
pub fn remove_vault_credential(provider: &str) -> Result<(), String> {
    ensure_credentials_table();
    let conn = db_connection().lock().unwrap();
    conn.execute(
        "DELETE FROM credentials_vault WHERE provider = ?1",
        params![provider],
    )
    .map_err(|e| format!("Failed to delete credential for '{provider}': {e}"))?;
    Ok(())
}

/// Environment variable names associated with each provider
fn provider_env_vars(provider: &str) -> &'static [&'static str] {
    match provider {
        "deepseek" => &["DEEPSEEK_API_KEY"],
        "grok" => &["GROK_API_KEY", "XAI_API_KEY"],
        "grok_transcription" => &["GROK_TRANSCRIPTION_API_KEY", "GROK_API_KEY", "XAI_API_KEY"],
        "opencode" => &["OPENCODE_API_KEY"],
        "vercel" => &["VERCEL_API_KEY", "VERCEL_AI_GATEWAY_TOKEN"],
        "cloudflare" => &["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_AUTH_TOKEN"],
        "cloudflare_account_id" => &["CLOUDFLARE_ACCOUNT_ID"],
        "gemini" => &["GEMINI_API_KEY"],
        "kimi" => &["KIMI_API_KEY", "MOONSHOT_API_KEY"],
        "claude" => &["CLAUDE_CODE_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
        "codex" => &["CODEX_ACCESS_TOKEN", "CODEX_TOKEN", "OPENAI_API_KEY"],
        _ => &[],
    }
}

/// Resolves an API key for any provider following the 3-tier hierarchy:
/// 1. User Vault (SQLite)
/// 2. Environment Variables (.env / OS)
/// 3. Returns None (caller can check local CLI if applicable)
pub fn resolve_provider_credential(provider: &str) -> Option<(String, CredentialSource)> {
    // 1. User Vault
    if let Some(key) = get_vault_credential(provider) {
        if !key.trim().is_empty() {
            return Some((key, CredentialSource::Vault));
        }
    }

    // 2. Environment Variables
    for &var_name in provider_env_vars(provider) {
        if let Ok(val) = std::env::var(var_name) {
            let trimmed = val.trim();
            if !trimmed.is_empty() {
                return Some((trimmed.to_string(), CredentialSource::Env));
            }
        }
    }

    None
}

/// Convenience helper to get just the key string if available
pub fn resolve_provider_key(provider: &str) -> Option<String> {
    resolve_provider_credential(provider).map(|(k, _)| k)
}

// -----------------------------------------------------------------------------
// Tauri IPC Handlers
// -----------------------------------------------------------------------------

/// IPC: Get status and previews of all known providers
#[tauri::command]
pub fn get_provider_credentials() -> Value {
    let known_providers = [
        "grok",
        "grok_transcription",
        "opencode",
        "deepseek",
        "vercel",
        "cloudflare",
        "cloudflare_account_id",
        "gemini",
        "kimi",
        "claude",
        "codex",
    ];

    let mut list = Vec::new();
    for &p in &known_providers {
        let (is_configured, source, preview) = match resolve_provider_credential(p) {
            Some((key, src)) => (true, src, Some(mask_key_preview(&key))),
            None => (false, CredentialSource::None, None),
        };
        list.push(CredentialStatus {
            provider: p.to_string(),
            is_configured,
            source,
            preview,
        });
    }

    json!({
        "success": true,
        "credentials": list
    })
}

/// IPC: Get active key for execution (e.g. Zed Operator)
#[tauri::command]
pub fn get_active_provider_key(request: Option<Value>) -> Value {
    let provider = body(&request)
        .and_then(|b| b.get("provider"))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    if provider.is_empty() {
        return json!({ "success": false, "error": "Provider name is required" });
    }

    match resolve_provider_credential(provider) {
        Some((key, source)) => json!({
            "success": true,
            "provider": provider,
            "key": key,
            "source": source
        }),
        None => json!({
            "success": false,
            "provider": provider,
            "key": Value::Null,
            "source": "none"
        }),
    }
}

/// IPC: Save a key into the local SQLite vault
#[tauri::command]
pub fn save_provider_credential(request: Option<Value>) -> Value {
    let b = match body(&request) {
        Some(b) => b,
        None => return json!({ "success": false, "error": "Missing request payload" }),
    };

    let provider = b.get("provider").and_then(|v| v.as_str()).unwrap_or("");
    let key = b.get("key").and_then(|v| v.as_str()).unwrap_or("");

    if provider.is_empty() {
        return json!({ "success": false, "error": "Provider name is required" });
    }

    match set_vault_credential(provider, key) {
        Ok(_) => {
            // The key is already in the vault; also record the chat connection
            // both builds share. A failure here must not look like a failed
            // save of the key itself.
            if let Err(error) = crate::connections::sync_api_key_connection(provider, key) {
                return json!({
                    "success": false,
                    "provider": provider,
                    "error": format!(
                        "The key was saved to the local vault, but the shared connection registry could not be updated: {error}"
                    )
                });
            }
            json!({
                "success": true,
                "provider": provider,
                "preview": mask_key_preview(key)
            })
        }
        Err(e) => json!({ "success": false, "error": e }),
    }
}

/// IPC: Delete a key from the vault
#[tauri::command]
pub fn delete_provider_credential(request: Option<Value>) -> Value {
    let provider = body(&request)
        .and_then(|b| b.get("provider"))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    if provider.is_empty() {
        return json!({ "success": false, "error": "Provider name is required" });
    }

    match remove_vault_credential(provider) {
        Ok(_) => json!({ "success": true, "provider": provider }),
        Err(e) => json!({ "success": false, "error": e }),
    }
}

/// IPC: One-time migration of credentials found in localStorage to the native SQLite vault
#[tauri::command]
pub fn migrate_localstorage_credentials(request: Option<Value>) -> Value {
    let b = match body(&request) {
        Some(b) => b,
        None => return json!({ "success": false, "migrated": 0 }),
    };

    let records = match b.get("records").and_then(|v| v.as_object()) {
        Some(obj) => obj,
        None => return json!({ "success": false, "migrated": 0 }),
    };

    let mut migrated = 0;
    for (k, v) in records {
        if let Some(val_str) = v.as_str() {
            let trimmed = val_str.trim();
            // Only migrate if not empty and not already present in the vault
            if !trimmed.is_empty() && get_vault_credential(k).is_none() {
                if set_vault_credential(k, trimmed).is_ok() {
                    migrated += 1;
                }
            }
        }
    }

    json!({ "success": true, "migrated": migrated })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encryption_roundtrip() {
        let original = "sk-test-secret-1234567890-xyz";
        let encrypted = encrypt_secret(original);
        assert_ne!(original, encrypted);
        let decrypted = decrypt_secret(&encrypted).expect("decryption failed");
        assert_eq!(original, decrypted);
    }

    #[test]
    fn test_mask_preview() {
        assert_eq!(mask_key_preview("xai-1234567890abcdef"), "xai-...cdef");
        assert_eq!(mask_key_preview("sk-ant-1234567890"), "sk-...7890");
        assert_eq!(mask_key_preview("short"), "••••••••");
        assert_eq!(mask_key_preview(""), "");
    }

    #[test]
    fn test_vault_persistence_and_resolution() {
        let test_provider = "test_custom_provider";
        let test_key = "sk-vault-test-key-5555";

        // Save
        set_vault_credential(test_provider, test_key).expect("save failed");

        // Read
        let read_back = get_vault_credential(test_provider).expect("read failed");
        assert_eq!(read_back, test_key);

        // Resolve
        let (resolved, source) = resolve_provider_credential(test_provider).expect("resolve failed");
        assert_eq!(resolved, test_key);
        assert_eq!(source, CredentialSource::Vault);

        // Delete
        remove_vault_credential(test_provider).expect("delete failed");
        assert_eq!(get_vault_credential(test_provider), None);
    }
}
