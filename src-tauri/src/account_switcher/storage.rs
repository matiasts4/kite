use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use super::registry::{canon_provider, now_ms, profile_storage_dir_in, profiles_root, user_home_dir};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Number of automatic pre-switch backups kept per provider.
const MAX_BACKUPS_PER_PROVIDER: usize = 5;

// ---------------------------------------------------------------------------
// Provider Files Definition for Snapshot / Restore
// ---------------------------------------------------------------------------

pub(crate) struct FileMapping {
    pub(crate) source: PathBuf,
    pub(crate) rel_dest: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveIdentityProbe {
    pub provider: String,
    pub email: String,
    pub name: Option<String>,
    pub source: String,
}

pub fn decode_jwt_payload(jwt: &str) -> Option<Value> {
    let parts: Vec<&str> = jwt.split('.').collect();
    if parts.len() < 2 {
        return None;
    }
    let mut payload_b64 = parts[1].replace('-', "+").replace('_', "/");
    while payload_b64.len() % 4 != 0 {
        payload_b64.push('=');
    }
    let bytes = crate::chat_attachments::decode_base64(&payload_b64)?;
    serde_json::from_slice(&bytes).ok()
}

pub fn probe_live_provider_identity(provider: &str) -> Option<LiveIdentityProbe> {
    let canon = canon_provider(provider);
    match canon.as_str() {
        "agy" => {
            if let Some((email, name)) = crate::quota::read_antigravity_credential() {
                return Some(LiveIdentityProbe {
                    provider: "agy".into(),
                    email,
                    name,
                    source: "gemini:antigravity".into(),
                });
            }
            if let Some((email, name)) = crate::quota::read_antigravity_ide_identity() {
                return Some(LiveIdentityProbe {
                    provider: "agy".into(),
                    email,
                    name,
                    source: "state.vscdb".into(),
                });
            }
            None
        }
        "gemini" => {
            let home = user_home_dir();
            let creds_file = home.join(".gemini").join("oauth_creds.json");
            if creds_file.exists() {
                if let Ok(bytes) = fs::read(&creds_file) {
                    if let Ok(val) = serde_json::from_slice::<Value>(&bytes) {
                        if let Some(id_tok) = val.get("id_token").and_then(|v| v.as_str()) {
                            if let Some(payload) = decode_jwt_payload(id_tok) {
                                let email = payload.get("email").and_then(|v| v.as_str()).map(String::from);
                                let name = payload.get("name").and_then(|v| v.as_str()).map(String::from);
                                if let Some(e) = email {
                                    return Some(LiveIdentityProbe {
                                        provider: "gemini".into(),
                                        email: e,
                                        name,
                                        source: "oauth_creds.json".into(),
                                    });
                                }
                            }
                        }
                    }
                }
            }
            let accounts_file = home.join(".gemini").join("google_accounts.json");
            if accounts_file.exists() {
                if let Ok(bytes) = fs::read(&accounts_file) {
                    if let Ok(val) = serde_json::from_slice::<Value>(&bytes) {
                        if let Some(active) = val.get("active").and_then(|v| v.as_str()) {
                            if !active.trim().is_empty() {
                                return Some(LiveIdentityProbe {
                                    provider: "gemini".into(),
                                    email: active.trim().to_string(),
                                    name: None,
                                    source: "google_accounts.json".into(),
                                });
                            }
                        }
                    }
                }
            }
            None
        }
        "codex" => {
            let home = user_home_dir();
            let auth_file = home.join(".codex").join("auth.json");
            if auth_file.exists() {
                if let Ok(bytes) = fs::read(&auth_file) {
                    if let Ok(val) = serde_json::from_slice::<Value>(&bytes) {
                        if let Some(id_tok) = val.get("id_token").and_then(|v| v.as_str()) {
                            if let Some(payload) = decode_jwt_payload(id_tok) {
                                if let Some(e) = payload.get("email").and_then(|v| v.as_str()).map(String::from) {
                                    let name = payload.get("name").and_then(|v| v.as_str()).map(String::from);
                                    return Some(LiveIdentityProbe {
                                        provider: "codex".into(),
                                        email: e,
                                        name,
                                        source: "auth.json".into(),
                                    });
                                }
                            }
                        }
                        if let Some(tokens) = val.get("tokens").and_then(|v| v.as_object()) {
                            if let Some(id_tok) = tokens.get("id_token").and_then(|v| v.as_str()) {
                                if let Some(payload) = decode_jwt_payload(id_tok) {
                                    if let Some(e) = payload.get("email").and_then(|v| v.as_str()).map(String::from) {
                                        let name = payload.get("name").and_then(|v| v.as_str()).map(String::from);
                                        return Some(LiveIdentityProbe {
                                            provider: "codex".into(),
                                            email: e,
                                            name,
                                            source: "tokens.id_token".into(),
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
            }
            None
        }
        "claude" => {
            let home = user_home_dir();
            let claude_json = home.join(".claude.json");
            if claude_json.exists() {
                if let Ok(bytes) = fs::read(&claude_json) {
                    if let Ok(val) = serde_json::from_slice::<Value>(&bytes) {
                        if let Some(email) = val.pointer("/oauthAccount/emailAddress").and_then(|v| v.as_str()) {
                            if !email.trim().is_empty() {
                                return Some(LiveIdentityProbe {
                                    provider: "claude".into(),
                                    email: email.trim().to_string(),
                                    name: None,
                                    source: "claude.json".into(),
                                });
                            }
                        }
                    }
                }
            }
            None
        }
        "grok" => {
            let home = user_home_dir();
            let auth_file = home.join(".grok").join("auth.json");
            if auth_file.exists() {
                if let Ok(bytes) = fs::read(&auth_file) {
                    if let Ok(val) = serde_json::from_slice::<Value>(&bytes) {
                        if let Some(email) = val.get("email").and_then(|v| v.as_str()) {
                            if !email.trim().is_empty() {
                                return Some(LiveIdentityProbe {
                                    provider: "grok".into(),
                                    email: email.trim().to_string(),
                                    name: None,
                                    source: "auth.json".into(),
                                });
                            }
                        }
                    }
                }
            }
            None
        }
        _ => None,
    }
}

pub(crate) fn get_provider_file_mappings(provider: &str) -> Vec<FileMapping> {
    let home = user_home_dir();
    match canon_provider(provider).as_str() {
        "agy" => vec![
            FileMapping {
                source: home.join(".gemini").join("antigravity").join("antigravity_state.pbtxt"),
                rel_dest: "antigravity_state.pbtxt",
            },
            FileMapping {
                source: home.join(".gemini").join("antigravity-cli").join("jetski_state.pbtxt"),
                rel_dest: "jetski_state.pbtxt",
            },
        ],
        "gemini" => vec![
            FileMapping {
                source: home.join(".gemini").join("oauth_creds.json"),
                rel_dest: "oauth_creds.json",
            },
            FileMapping {
                source: home.join(".gemini").join("google_accounts.json"),
                rel_dest: "google_accounts.json",
            },
        ],
        "claude" => vec![
            FileMapping {
                source: home.join(".claude").join(".credentials.json"),
                rel_dest: "credentials.json",
            },
            FileMapping {
                source: home.join(".claude.json"),
                rel_dest: "claude.json",
            },
        ],
        "codex" => vec![
            FileMapping {
                source: home.join(".codex").join("auth.json"),
                rel_dest: "auth.json",
            },
            FileMapping {
                source: home.join(".codex").join("config.json"),
                rel_dest: "config.json",
            },
        ],
        "grok" => vec![
            FileMapping {
                source: home.join(".grok").join("auth.json"),
                rel_dest: "auth.json",
            },
            FileMapping {
                source: home.join(".grok").join("config.json"),
                rel_dest: "config.json",
            },
        ],
        "opencode" => vec![
            FileMapping {
                source: home.join(".local").join("share").join("opencode").join("auth.json"),
                rel_dest: "auth.json",
            },
            FileMapping {
                source: home.join(".config").join("opencode").join("config.json"),
                rel_dest: "config.json",
            },
        ],
        _ => Vec::new(),
    }
}

/// Sibling path used to stage a file next to its destination.
pub(crate) fn staged_path(dst: &Path) -> PathBuf {
    let mut name = dst.file_name().unwrap_or_default().to_os_string();
    name.push(".bm_new");
    dst.with_file_name(name)
}

/// Copy through a temp file + rename so a reader never observes a half-written file.
pub(crate) fn copy_atomic(src: &Path, dst: &Path) -> bool {
    if !src.exists() {
        return false;
    }
    if let Some(parent) = dst.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let tmp = staged_path(dst);
    if fs::copy(src, &tmp).is_err() {
        let _ = fs::remove_file(&tmp);
        return false;
    }
    if fs::rename(&tmp, dst).is_err() {
        let _ = fs::remove_file(&tmp);
        return false;
    }
    true
}

pub(crate) trait AntigravityCredStore {
    fn read_raw(&self) -> Option<String>;
    fn write_checked(&self, blob_json: &str) -> Result<(), String>;
}

pub(crate) struct LiveAntigravityCredStore;

impl AntigravityCredStore for LiveAntigravityCredStore {
    fn read_raw(&self) -> Option<String> {
        crate::quota::read_antigravity_raw_credential()
    }

    fn write_checked(&self, blob_json: &str) -> Result<(), String> {
        crate::quota::write_antigravity_credential_checked(blob_json)
    }
}

pub(crate) fn write_bytes_atomic(dst: &Path, data: &[u8]) -> Result<(), String> {
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("No se pudo crear {}: {e}", parent.display()))?;
    }
    let tmp = staged_path(dst);
    if let Err(e) = fs::write(&tmp, data) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("No se pudo escribir {}: {e}", dst.display()));
    }
    if let Err(e) = fs::rename(&tmp, dst) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("No se pudo guardar {}: {e}", dst.display()));
    }
    Ok(())
}

pub(crate) fn snapshot_active_to_profile_with(
    root: &Path,
    provider: &str,
    account_id: &str,
    mappings: &[FileMapping],
    state_vscdb: Option<&Path>,
    cred_store: &dyn AntigravityCredStore,
) -> Result<bool, String> {
    let provider = canon_provider(provider);

    if provider == "agy" {
        let raw = cred_store.read_raw().ok_or_else(|| {
            "No se encontró una credencial activa de Antigravity en Windows Credential Manager (gemini:antigravity). Inicia sesión primero y vuelve a intentar.".to_string()
        })?;
        let ident = crate::quota::parse_antigravity_credential_with_tokens(&raw).map_err(|code| {
            match code {
                "missing_tokens" => "La sesión activa de Antigravity (gemini:antigravity) no contiene tokens OAuth válidos (access_token o refresh_token). Vuelve a iniciar sesión.".to_string(),
                _ => "La credencial activa de Antigravity (gemini:antigravity) está corrupta o no contiene un email válido.".to_string(),
            }
        })?;

        let dest_dir = profile_storage_dir_in(root, &provider, account_id);
        write_bytes_atomic(&dest_dir.join("gemini_antigravity_cred.json"), raw.as_bytes())?;

        for m in mappings {
            if m.source.exists() && !copy_atomic(&m.source, &dest_dir.join(m.rel_dest)) {
                return Err(format!(
                    "No se pudo respaldar {} al perfil {}.",
                    m.rel_dest, account_id
                ));
            }
        }

        let ide_snap_path = dest_dir.join("ide_auth_state.json");
        if let Some(db_path) = state_vscdb {
            match crate::quota::extract_ide_auth_state_from_db(db_path) {
                Ok(Some(ide_snap))
                    if ide_snap
                        .email
                        .as_deref()
                        .map_or(false, |e| e.eq_ignore_ascii_case(&ident.email)) =>
                {
                    let bytes = serde_json::to_vec_pretty(&ide_snap).map_err(|e| {
                        format!("No se pudo serializar ide_auth_state.json: {e}")
                    })?;
                    write_bytes_atomic(&ide_snap_path, &bytes)?;
                }
                _ => {
                    // Never keep an IDE snapshot belonging to a different account.
                    if ide_snap_path.exists() {
                        let _ = fs::remove_file(&ide_snap_path);
                    }
                }
            }
        }
        return Ok(true);
    }

    let dest_dir = profile_storage_dir_in(root, &provider, account_id);
    let mut copied_any = false;
    for m in mappings {
        if m.source.exists() {
            if !copy_atomic(&m.source, &dest_dir.join(m.rel_dest)) {
                return Err(format!(
                    "No se pudo copiar {} al perfil {}.",
                    m.rel_dest, account_id
                ));
            }
            copied_any = true;
        }
    }
    Ok(copied_any)
}

pub fn snapshot_active_to_profile(provider: &str, account_id: &str) -> Result<bool, String> {
    let canon = canon_provider(provider);
    let mappings = get_provider_file_mappings(&canon);
    let state_vscdb = if canon == "agy" {
        crate::quota::find_existing_state_vscdb()
    } else {
        None
    };
    snapshot_active_to_profile_with(
        &profiles_root(),
        &canon,
        account_id,
        &mappings,
        state_vscdb.as_deref(),
        &LiveAntigravityCredStore,
    )
}

// ---------------------------------------------------------------------------
// Process guard: never swap session files under a running client
// ---------------------------------------------------------------------------

/// Lower-cased image names of running processes, or `None` if they could not be listed.
pub(crate) fn running_process_names() -> Option<Vec<String>> {
    #[cfg(windows)]
    let mut cmd = {
        let mut c = Command::new("tasklist");
        c.args(["/FO", "CSV", "/NH"]);
        c.creation_flags(CREATE_NO_WINDOW);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = Command::new("ps");
        c.args(["-A", "-o", "comm="]);
        c
    };
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let names = text
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() {
                return None;
            }
            #[cfg(windows)]
            let name = line.trim_start_matches('"').split('"').next().unwrap_or("");
            #[cfg(not(windows))]
            let name = line.rsplit('/').next().unwrap_or(line);
            Some(name.to_lowercase())
        })
        .collect();
    Some(names)
}

pub(crate) fn is_blocking_process(provider: &str, name: &str) -> bool {
    // Note: CLI processes (agy.exe, claude.exe, codex.exe) are automatically
    // terminated and respawned during rotation. Only standalone external IDEs
    // (e.g. Antigravity IDE window) that cannot be safely terminated remain here.
    match canon_provider(provider).as_str() {
        "agy" => matches!(name, "antigravity" | "antigravity.exe"),
        _ => false,
    }
}

/// Automatically terminates any running background or terminal CLI processes
/// for this provider so they release locks on auth and session files before rotation.
pub fn terminate_provider_cli_processes(provider: &str) {
    let canon = canon_provider(provider);
    #[cfg(windows)]
    {
        let image_names: Vec<&str> = match canon.as_str() {
            "agy" => vec!["agy.exe", "language_server_windows_x64.exe"],
            "claude" => vec!["claude.exe"],
            "codex" => vec!["codex.exe"],
            "grok" => vec!["grok.exe"],
            "opencode" => vec!["opencode.exe"],
            _ => Vec::new(),
        };

        if !image_names.is_empty() {
            let mut args: Vec<&str> = vec!["/F", "/T"];
            for img in &image_names {
                args.push("/IM");
                args.push(img);
            }
            let _ = crate::hidden_exec::run(
                std::path::Path::new("taskkill.exe"),
                &args,
                std::time::Duration::from_millis(400),
            );
        }
    }
    #[cfg(not(windows))]
    {
        let pattern = match canon.as_str() {
            "agy" => "agy",
            "claude" => "claude",
            "codex" => "codex",
            "grok" => "grok",
            "opencode" => "opencode",
            _ => "",
        };
        if !pattern.is_empty() {
            let _ = std::process::Command::new("pkill")
                .args(["-9", "-f", pattern])
                .output();
        }
    }
    // Brief sleep to allow OS file handles to be released
    std::thread::sleep(std::time::Duration::from_millis(50));
}

/// Err(message) when a client that owns the session files is running.
/// If the process list is unavailable the check is skipped (best effort).
pub(crate) fn ensure_provider_idle(provider: &str) -> Result<(), String> {
    let Some(names) = running_process_names() else {
        return Ok(());
    };
    let mut busy: Vec<String> = names
        .into_iter()
        .filter(|n| is_blocking_process(provider, n))
        .collect();
    busy.sort();
    busy.dedup();
    if busy.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Cierra la aplicación externa de {} antes de cambiar de cuenta (procesos activos: {}).",
            canon_provider(provider),
            busy.join(", ")
        ))
    }
}

// ---------------------------------------------------------------------------
// Transactional restore (backup -> stage -> commit -> rollback on failure)
// ---------------------------------------------------------------------------

pub(crate) fn prune_backups_in(root: &Path, provider: &str) {
    let dir = root.join("_backups").join(provider);
    let Ok(read) = fs::read_dir(&dir) else { return };
    let mut entries: Vec<PathBuf> = read.filter_map(|e| e.ok().map(|e| e.path())).collect();
    entries.sort_by_key(|p| {
        p.file_name()
            .and_then(|n| n.to_str())
            .and_then(|n| n.parse::<i64>().ok())
            .unwrap_or(0)
    });
    if entries.len() > MAX_BACKUPS_PER_PROVIDER {
        for old in &entries[..entries.len() - MAX_BACKUPS_PER_PROVIDER] {
            let _ = fs::remove_dir_all(old);
        }
    }
}

fn restore_mappings_backup(mappings: &[FileMapping], existed: &[bool], backup_dir: &Path) {
    for (i, m) in mappings.iter().enumerate() {
        if existed.get(i).copied().unwrap_or(false) {
            let _ = copy_atomic(&backup_dir.join(m.rel_dest), &m.source);
        } else {
            let _ = fs::remove_file(&m.source);
        }
    }
}

pub(crate) fn apply_profile_to_active_with(
    root: &Path,
    provider: &str,
    account_id: &str,
    mappings: &[FileMapping],
    state_vscdb: Option<&Path>,
    cred_store: &dyn AntigravityCredStore,
) -> Result<(), String> {
    let provider = canon_provider(provider);
    let src_dir = profile_storage_dir_in(root, &provider, account_id);
    let is_agy = provider == "agy";
    let cred_file = src_dir.join("gemini_antigravity_cred.json");

    let mut agy_payload: Option<(
        String,
        crate::quota::AntigravityCredentialIdentity,
        Option<crate::quota::IdeAuthStateSnapshot>,
    )> = None;

    if is_agy {
        if !cred_file.exists() {
            return Err("El perfil seleccionado no contiene credenciales válidas de Antigravity (gemini_antigravity_cred.json). Vuelve a iniciar sesión con esa cuenta y guárdala.".to_string());
        }
        let raw = fs::read_to_string(&cred_file)
            .map_err(|e| format!("No se pudo leer gemini_antigravity_cred.json: {e}"))?;
        let expected_ident =
            crate::quota::parse_antigravity_credential_with_tokens(&raw).map_err(|code| match code {
                "missing_tokens" => "El perfil seleccionado no contiene tokens OAuth válidos (access_token o refresh_token). Vuelve a iniciar sesión con esa cuenta y guárdala.".to_string(),
                _ => "El archivo de credenciales de Antigravity está dañado o no contiene una identidad válida.".to_string(),
            })?;

        let ide_snap_path = src_dir.join("ide_auth_state.json");
        let ide_snapshot = if ide_snap_path.is_file() {
            let ide_raw = fs::read_to_string(&ide_snap_path)
                .map_err(|e| format!("No se pudo leer ide_auth_state.json: {e}"))?;
            let parsed: crate::quota::IdeAuthStateSnapshot = serde_json::from_str(&ide_raw)
                .map_err(|e| format!("ide_auth_state.json está corrupto: {e}"))?;
            Some(parsed)
        } else {
            None
        };

        agy_payload = Some((raw, expected_ident, ide_snapshot));
    } else if !mappings.iter().any(|m| src_dir.join(m.rel_dest).exists()) {
        return Err("El perfil guardado no contiene archivos de sesión.".to_string());
    }

    // 1. Back up the current live state (also protects an unsaved current session).
    let backup_dir = root
        .join("_backups")
        .join(&provider)
        .join(now_ms().to_string());
    fs::create_dir_all(&backup_dir)
        .map_err(|e| format!("No se pudo crear directorio de respaldo: {e}"))?;

    let mut live_agy_backup: Option<String> = None;
    let mut live_ide_backup: Option<std::collections::BTreeMap<String, String>> = None;
    if is_agy {
        if let Some(raw) = cred_store.read_raw() {
            write_bytes_atomic(&backup_dir.join("gemini_antigravity_cred.json"), raw.as_bytes())?;
            live_agy_backup = Some(raw);
        }
        if let Some(db_path) = state_vscdb {
            if db_path.exists() {
                if let Ok(rows) = crate::quota::extract_ide_auth_rows_from_db(db_path) {
                    if !rows.is_empty() {
                        if let Ok(bytes) = serde_json::to_vec_pretty(&rows) {
                            let _ = write_bytes_atomic(&backup_dir.join("ide_auth_state_backup.json"), &bytes);
                        }
                    }
                    live_ide_backup = Some(rows);
                }
            }
        }
    }

    let mut existed: Vec<bool> = Vec::with_capacity(mappings.len());
    for m in mappings {
        let present = m.source.exists();
        if present && !copy_atomic(&m.source, &backup_dir.join(m.rel_dest)) {
            return Err(format!(
                "No se pudo respaldar {} (¿archivo en uso?). No se hizo ningún cambio.",
                m.rel_dest
            ));
        }
        existed.push(present);
    }

    // 2. Stage every new file next to its destination.
    let mut staged: Vec<Option<PathBuf>> = Vec::with_capacity(mappings.len());
    for m in mappings {
        let snap = src_dir.join(m.rel_dest);
        if !snap.exists() {
            staged.push(None);
            continue;
        }
        if let Some(parent) = m.source.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let tmp = staged_path(&m.source);
        if let Err(e) = fs::copy(&snap, &tmp) {
            let _ = fs::remove_file(&tmp);
            for t in staged.iter().flatten() {
                let _ = fs::remove_file(t);
            }
            return Err(format!(
                "No se pudo preparar {}: {e}. No se hizo ningún cambio.",
                m.rel_dest
            ));
        }
        staged.push(Some(tmp));
    }

    // 3. Commit.
    let mut failure: Option<String> = None;
    for (i, m) in mappings.iter().enumerate() {
        let res = match &staged[i] {
            Some(tmp) => fs::rename(tmp, &m.source),
            None if m.source.exists() => fs::remove_file(&m.source),
            None => Ok(()),
        };
        if let Err(e) = res {
            failure = Some(format!("{}: {e}", m.rel_dest));
            break;
        }
    }

    // 4. Roll back on any failure.
    if let Some(err) = failure {
        for tmp in staged.iter().flatten() {
            let _ = fs::remove_file(tmp);
        }
        restore_mappings_backup(mappings, &existed, &backup_dir);
        return Err(format!("Cambio revertido, falló {err}"));
    }

    // 5. Apply and strictly verify OS credential + sync/clean Antigravity IDE state.vscdb.
    if let Some((raw, expected_ident, ide_snapshot)) = agy_payload {
        if let Err(write_err) = cred_store.write_checked(&raw) {
            restore_mappings_backup(mappings, &existed, &backup_dir);
            return Err(write_err);
        }

        let expected_tokens = crate::quota::extract_antigravity_token_material(&raw);
        let verify_result = cred_store.read_raw().and_then(|verify_raw| {
            let verified_ident =
                crate::quota::parse_antigravity_credential_with_tokens(&verify_raw).ok()?;
            let actual_tokens = crate::quota::extract_antigravity_token_material(&verify_raw);
            if verified_ident.email.eq_ignore_ascii_case(&expected_ident.email)
                && actual_tokens == expected_tokens
                && (actual_tokens.0.is_some() || actual_tokens.1.is_some())
            {
                Some(())
            } else {
                None
            }
        });

        if verify_result.is_none() {
            if let Some(ref prev) = live_agy_backup {
                let _ = cred_store.write_checked(prev);
            }
            restore_mappings_backup(mappings, &existed, &backup_dir);
            return Err("No se pudo verificar la nueva credencial en gemini:antigravity tras escribirla (la identidad o los tokens no coincidieron). Se revirtió al perfil anterior.".to_string());
        }

        if let Some(db_path) = state_vscdb {
            if let Err(sql_err) = crate::quota::apply_ide_auth_state_to_db(
                db_path,
                &expected_ident.email,
                ide_snapshot.as_ref(),
            ) {
                if let Some(ref prev_rows) = live_ide_backup {
                    let _ = crate::quota::restore_ide_auth_rows_to_db(db_path, prev_rows);
                }
                if let Some(ref prev) = live_agy_backup {
                    let _ = cred_store.write_checked(prev);
                }
                restore_mappings_backup(mappings, &existed, &backup_dir);
                return Err(format!(
                    "Cambio revertido porque falló la sincronización de state.vscdb: {sql_err}"
                ));
            }
        }
    }

    prune_backups_in(root, &provider);
    Ok(())
}

pub(crate) fn apply_profile_to_active(provider: &str, account_id: &str) -> Result<(), String> {
    let canon = canon_provider(provider);
    let mappings = get_provider_file_mappings(&canon);
    let state_vscdb = if canon == "agy" {
        crate::quota::find_existing_state_vscdb()
    } else {
        None
    };
    apply_profile_to_active_with(
        &profiles_root(),
        &canon,
        account_id,
        &mappings,
        state_vscdb.as_deref(),
        &LiveAntigravityCredStore,
    )
}
