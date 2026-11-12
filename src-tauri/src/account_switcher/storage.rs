use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use super::registry::{canon_provider, now_ms, profile_storage_dir, profiles_root, user_home_dir};

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

pub fn snapshot_active_to_profile(provider: &str, account_id: &str) -> bool {
    let provider = canon_provider(provider);
    let dest_dir = profile_storage_dir(&provider, account_id);
    let mut copied_any = false;
    for m in get_provider_file_mappings(&provider) {
        if copy_atomic(&m.source, &dest_dir.join(m.rel_dest)) {
            copied_any = true;
        }
    }
    if provider == "agy" {
        if let Some(raw) = crate::quota::read_antigravity_raw_credential() {
            let _ = fs::write(dest_dir.join("gemini_antigravity_cred.json"), raw);
            copied_any = true;
        }
    }
    copied_any
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

pub(crate) fn prune_backups(provider: &str) {
    let dir = profiles_root().join("_backups").join(provider);
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

/// Replace the live session files with the snapshot of `account_id`.
/// Either every file is applied, or the previous state is restored and an error returned.
/// Files absent from the snapshot are removed so identities never get mixed.
pub(crate) fn apply_profile_to_active(provider: &str, account_id: &str) -> Result<(), String> {
    let provider = canon_provider(provider);
    let src_dir = profile_storage_dir(&provider, account_id);
    let mappings = get_provider_file_mappings(&provider);
    let is_agy = provider == "agy";
    let cred_file = src_dir.join("gemini_antigravity_cred.json");

    if is_agy {
        if !cred_file.exists() {
            return Err("El perfil seleccionado no contiene credenciales válidas de Antigravity (gemini_antigravity_cred.json). Vuelve a iniciar sesión con esa cuenta y guárdala.".to_string());
        }
        let raw = fs::read_to_string(&cred_file).map_err(|e| format!("No se pudo leer gemini_antigravity_cred.json: {e}"))?;
        if crate::quota::parse_antigravity_credential_blob(&raw).is_none() {
            return Err("El archivo de credenciales de Antigravity está dañado o no contiene una identidad válida.".to_string());
        }
    } else if !mappings.iter().any(|m| src_dir.join(m.rel_dest).exists()) {
        return Err("El perfil guardado no contiene archivos de sesión.".to_string());
    }

    // 1. Back up the current live state (also protects an unsaved current session).
    let backup_dir = profiles_root()
        .join("_backups")
        .join(&provider)
        .join(now_ms().to_string());
    let _ = fs::create_dir_all(&backup_dir);

    let mut live_agy_backup: Option<String> = None;
    if is_agy {
        if let Some(raw) = crate::quota::read_antigravity_raw_credential() {
            let _ = fs::write(backup_dir.join("gemini_antigravity_cred.json"), &raw);
            live_agy_backup = Some(raw);
        }
    }

    let mut existed: Vec<bool> = Vec::with_capacity(mappings.len());
    for m in &mappings {
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
    for m in &mappings {
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
        for (i, m) in mappings.iter().enumerate() {
            if let Some(tmp) = &staged[i] {
                let _ = fs::remove_file(tmp);
            }
            if existed[i] {
                let _ = copy_atomic(&backup_dir.join(m.rel_dest), &m.source);
            } else {
                let _ = fs::remove_file(&m.source);
            }
        }
        return Err(format!("Cambio revertido, falló {err}"));
    }

    // 5. Apply and verify credential for agy
    if is_agy {
        if let Ok(raw) = fs::read_to_string(&cred_file) {
            let expected_identity = crate::quota::parse_antigravity_credential_blob(&raw);
            let written = crate::quota::write_antigravity_credential(&raw);
            let verified = if written {
                if let Some(expected) = expected_identity {
                    crate::quota::read_antigravity_credential()
                        .map(|(e, _)| e.eq_ignore_ascii_case(&expected.email))
                        .unwrap_or(false)
                } else {
                    true
                }
            } else {
                false
            };

            if !verified {
                if let Some(prev) = live_agy_backup {
                    crate::quota::write_antigravity_credential(&prev);
                }
                for (i, m) in mappings.iter().enumerate() {
                    if existed[i] {
                        let _ = copy_atomic(&backup_dir.join(m.rel_dest), &m.source);
                    } else {
                        let _ = fs::remove_file(&m.source);
                    }
                }
                return Err("No se pudo escribir o verificar la credencial de Antigravity en el Administrador de credenciales de Windows.".to_string());
            }
        }
    }

    prune_backups(&provider);
    Ok(())
}
