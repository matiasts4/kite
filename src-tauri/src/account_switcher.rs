use crate::logger::log_trace;
use crate::quota::{fetch_antigravity_quota, fetch_claude_quota, fetch_codex_quota, fetch_gemini_quota};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Number of automatic pre-switch backups kept per provider.
const MAX_BACKUPS_PER_PROVIDER: usize = 5;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedAccountProfile {
    pub id: String,
    pub provider: String,
    pub label: String,
    pub email: Option<String>,
    pub plan_name: Option<String>,
    pub is_active: bool,
    pub last_used_unix_ms: i64,
    pub primary_remaining_percent: Option<f64>,
    pub primary_reset_at: Option<String>,
    pub time_until_reset_ms: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct AccountProfilesRegistry {
    profiles: Vec<SavedAccountProfile>,
}

static REGISTRY_LOCK: Mutex<()> = Mutex::new(());

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// `antigravity` and `agy` are the same product; keep a single identity so
/// profiles / active flags / vault folders never diverge.
fn canon_provider(p: &str) -> String {
    match p {
        "antigravity" => "agy".to_string(),
        other => other.to_string(),
    }
}

fn same_provider(a: &str, b: &str) -> bool {
    canon_provider(a) == canon_provider(b)
}

fn user_home_dir() -> PathBuf {
    if let Ok(profile) = std::env::var("USERPROFILE") {
        PathBuf::from(profile)
    } else if let Ok(home) = std::env::var("HOME") {
        PathBuf::from(home)
    } else {
        PathBuf::from(".")
    }
}

fn appdata_dir() -> PathBuf {
    if let Ok(appdata) = std::env::var("APPDATA") {
        PathBuf::from(appdata)
    } else {
        user_home_dir().join("AppData").join("Roaming")
    }
}

fn profiles_root() -> PathBuf {
    let folder = if cfg!(debug_assertions) {
        "Kite Code Dev"
    } else {
        "Kite Code"
    };
    let root = appdata_dir().join(folder).join("account-profiles");
    let _ = fs::create_dir_all(&root);
    root
}

fn registry_file() -> PathBuf {
    profiles_root().join("profiles.json")
}

fn profile_storage_dir(provider: &str, account_id: &str) -> PathBuf {
    let dir = profiles_root().join(provider).join(account_id);
    let _ = fs::create_dir_all(&dir);
    dir
}

fn load_registry() -> AccountProfilesRegistry {
    let file = registry_file();
    if file.exists() {
        if let Ok(data) = fs::read(&file) {
            if let Ok(mut reg) = serde_json::from_slice::<AccountProfilesRegistry>(&data) {
                // Deduplicate profiles by provider + email (case-insensitive) or by id
                let mut deduplicated: Vec<SavedAccountProfile> = Vec::new();
                for p in reg.profiles {
                    let canon_prov = canon_provider(&p.provider);
                    let existing_pos = deduplicated.iter().position(|e| {
                        canon_provider(&e.provider) == canon_prov
                            && match (&e.email, &p.email) {
                                (Some(a), Some(b)) => a.eq_ignore_ascii_case(b),
                                _ => e.id == p.id,
                            }
                    });
                    if let Some(pos) = existing_pos {
                        // Keep the active one or the most recently used one
                        if p.is_active || (!deduplicated[pos].is_active && p.last_used_unix_ms > deduplicated[pos].last_used_unix_ms) {
                            deduplicated[pos] = p;
                        }
                    } else {
                        deduplicated.push(p);
                    }
                }
                reg.profiles = deduplicated;
                return reg;
            }
        }
    }
    AccountProfilesRegistry::default()
}

fn save_registry(registry: &AccountProfilesRegistry) {
    let file = registry_file();
    if let Ok(bytes) = serde_json::to_vec_pretty(registry) {
        let tmp = staged_path(&file);
        if fs::write(&tmp, bytes).is_ok() && fs::rename(&tmp, &file).is_err() {
            let _ = fs::remove_file(&tmp);
        }
    }
}

// ---------------------------------------------------------------------------
// Provider Files Definition for Snapshot / Restore
// ---------------------------------------------------------------------------

struct FileMapping {
    source: PathBuf,
    rel_dest: &'static str,
}

fn get_provider_file_mappings(provider: &str) -> Vec<FileMapping> {
    let home = user_home_dir();
    let appdata = appdata_dir();
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
            FileMapping {
                source: home.join(".gemini").join("antigravity-cli").join("settings.json"),
                rel_dest: "cli_settings.json",
            },
            FileMapping {
                source: appdata.join("Antigravity").join("User").join("globalStorage").join("state.vscdb"),
                rel_dest: "state.vscdb",
            },
            FileMapping {
                source: appdata.join("Antigravity").join("User").join("globalStorage").join("storage.json"),
                rel_dest: "storage.json",
            },
            FileMapping {
                source: home.join(".gemini").join("google_accounts.json"),
                rel_dest: "google_accounts.json",
            },
            FileMapping {
                source: home.join(".gemini").join("oauth_creds.json"),
                rel_dest: "oauth_creds.json",
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
            FileMapping {
                source: home.join(".gemini").join("state.json"),
                rel_dest: "state.json",
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
        _ => Vec::new(),
    }
}

/// Sibling path used to stage a file next to its destination.
fn staged_path(dst: &Path) -> PathBuf {
    let mut name = dst.file_name().unwrap_or_default().to_os_string();
    name.push(".bm_new");
    dst.with_file_name(name)
}

/// Copy through a temp file + rename so a reader never observes a half-written file.
fn copy_atomic(src: &Path, dst: &Path) -> bool {
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
fn running_process_names() -> Option<Vec<String>> {
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

fn is_blocking_process(provider: &str, name: &str) -> bool {
    match canon_provider(provider).as_str() {
        // agy and gemini share ~/.gemini/oauth_creds.json, so either client blocks both.
        "agy" | "gemini" => {
            name.contains("antigravity")
                || name.starts_with("language_server")
                || matches!(name, "agy" | "agy.exe" | "gemini" | "gemini.exe")
        }
        "claude" => matches!(name, "claude" | "claude.exe"),
        "codex" => matches!(name, "codex" | "codex.exe"),
        _ => false,
    }
}

/// Err(message) when a client that owns the session files is running.
/// If the process list is unavailable the check is skipped (best effort).
fn ensure_provider_idle(provider: &str) -> Result<(), String> {
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
            "Cierra el cliente de {} antes de cambiar de cuenta (procesos activos: {}).",
            canon_provider(provider),
            busy.join(", ")
        ))
    }
}

// ---------------------------------------------------------------------------
// Transactional restore (backup -> stage -> commit -> rollback on failure)
// ---------------------------------------------------------------------------

fn prune_backups(provider: &str) {
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
fn apply_profile_to_active(provider: &str, account_id: &str) -> Result<(), String> {
    let provider = canon_provider(provider);
    let src_dir = profile_storage_dir(&provider, account_id);
    let mappings = get_provider_file_mappings(&provider);

    if !mappings.iter().any(|m| src_dir.join(m.rel_dest).exists()) {
        return Err("El perfil guardado no contiene archivos de sesión.".to_string());
    }

    // 1. Back up the current live state (also protects an unsaved current session).
    let backup_dir = profiles_root()
        .join("_backups")
        .join(&provider)
        .join(now_ms().to_string());
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

    prune_backups(&provider);

    if provider == "agy" {
        let cred_file = src_dir.join("gemini_antigravity_cred.json");
        if cred_file.exists() {
            if let Ok(raw) = fs::read_to_string(&cred_file) {
                crate::quota::write_antigravity_credential(&raw);
            }
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Live quota helper
// ---------------------------------------------------------------------------

struct LiveQuota {
    percent: f64,
    reset_at: Option<String>,
    until_ms: Option<i64>,
    email: Option<String>,
    plan: Option<String>,
}

fn get_cached_live_quota(provider: &str) -> Option<LiveQuota> {
    let canon = canon_provider(provider);
    let key = match canon.as_str() {
        "agy" => "antigravity",
        other => other,
    };
    let q = crate::quota::get_cached_provider_status(key)?;
    if !q.is_available {
        return None;
    }
    Some(LiveQuota {
        percent: q.primary_remaining_percent,
        reset_at: q.primary_reset_at,
        until_ms: q.time_until_reset_ms,
        email: q.metadata.get("email").and_then(|v| v.as_str()).map(String::from),
        plan: q.metadata.get("planType").and_then(|v| v.as_str()).map(String::from),
    })
}

fn fetch_live_quota(provider: &str) -> Option<LiveQuota> {
    macro_rules! build {
        ($q:expr) => {{
            let q = $q;
            if !q.is_available {
                return None;
            }
            Some(LiveQuota {
                percent: q.primary_remaining_percent,
                reset_at: q.primary_reset_at,
                until_ms: q.time_until_reset_ms,
                email: q.metadata.get("email").and_then(|v| v.as_str()).map(String::from),
                plan: q.metadata.get("planType").and_then(|v| v.as_str()).map(String::from),
            })
        }};
    }
    match canon_provider(provider).as_str() {
        "agy" => build!(fetch_antigravity_quota()),
        "gemini" => build!(fetch_gemini_quota()),
        "claude" => build!(fetch_claude_quota()),
        "codex" => build!(fetch_codex_quota()),
        _ => None,
    }
}

/// agy and gemini share one Google identity file: after switching either, mark the
/// sibling provider's profile for the same email as the active one.
fn sync_google_siblings(reg: &mut AccountProfilesRegistry, provider: &str, activated: &SavedAccountProfile) {
    let sibling = match canon_provider(provider).as_str() {
        "agy" => "gemini",
        "gemini" => "agy",
        _ => return,
    };
    for p in &mut reg.profiles {
        if p.provider == sibling {
            p.is_active = activated.email.is_some() && p.email == activated.email;
        }
    }
}

// ---------------------------------------------------------------------------
// Public Tauri Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_saved_accounts(request: Option<Value>) -> Value {
    let req = crate::persist::body(&request);
    let provider = req
        .and_then(|r| r.get("provider"))
        .and_then(|v| v.as_str())
        .map(String::from);

    // Phase 1: read the registry (short lock).
    let active: Vec<(String, String, Option<String>)> = {
        let _guard = REGISTRY_LOCK.lock().unwrap();
        load_registry()
            .profiles
            .iter()
            .filter(|p| p.is_active)
            .filter(|p| provider.as_deref().map_or(true, |want| same_provider(&p.provider, want)))
            .map(|p| (p.id.clone(), p.provider.clone(), p.email.clone()))
            .collect()
    };

    // Phase 2: probe live quota WITHOUT holding the registry lock (spawns `agy`, can be slow).
    let live: Vec<(String, LiveQuota)> = active
        .into_iter()
        .filter_map(|(id, prov, saved_email)| {
            let q = get_cached_live_quota(&prov)?;
            // The live identity differs from the profile marked active (user logged in
            // outside Kite Code): don't attribute this quota/email to the wrong profile.
            if let (Some(saved), Some(now)) = (saved_email.as_deref(), q.email.as_deref()) {
                if !saved.eq_ignore_ascii_case(now) {
                    return None;
                }
            }
            Some((id, q))
        })
        .collect();

    // Phase 3: apply and persist (short lock, re-read to avoid clobbering concurrent edits).
    let _guard = REGISTRY_LOCK.lock().unwrap();
    let mut reg = load_registry();
    if !live.is_empty() {
        for (id, q) in live {
            if let Some(profile) = reg.profiles.iter_mut().find(|p| p.id == id) {
                profile.primary_remaining_percent = Some(q.percent);
                profile.primary_reset_at = q.reset_at;
                profile.time_until_reset_ms = q.until_ms;
                if q.email.is_some() {
                    profile.email = q.email;
                }
                if q.plan.is_some() {
                    profile.plan_name = q.plan;
                }
            }
        }
        save_registry(&reg);
    }

    let filtered: Vec<SavedAccountProfile> = match provider.as_deref() {
        Some(p) => reg.profiles.into_iter().filter(|a| same_provider(&a.provider, p)).collect(),
        None => reg.profiles,
    };

    json!({
        "schemaVersion": 1,
        "profiles": filtered
    })
}

pub fn save_current_account_profile_direct(provider: String, label: String) -> Value {
    let provider = canon_provider(&provider);
    if get_provider_file_mappings(&provider).is_empty() {
        return json!({ "success": false, "error": format!("Proveedor no soportado: {provider}") });
    }

    // Probe quota before taking the lock (slow, spawns `agy`).
    let live = get_cached_live_quota(&provider).or_else(|| fetch_live_quota(&provider));

    let _guard = REGISTRY_LOCK.lock().unwrap();
    let mut reg = load_registry();
    let now = now_ms();

    let (email, plan_name, primary_remaining_percent, primary_reset_at, time_until_reset_ms) = match live {
        Some(q) => (q.email, q.plan, Some(q.percent), q.reset_at, q.until_ms),
        None => (None, None, None, None, None),
    };

    // Upsert: check if a profile with the same provider and email already exists
    let existing_idx = if let Some(ref em) = email {
        reg.profiles.iter().position(|p| {
            same_provider(&p.provider, &provider)
                && p.email.as_ref().map_or(false, |e| e.eq_ignore_ascii_case(em))
        })
    } else {
        None
    };

    let account_id = if let Some(idx) = existing_idx {
        reg.profiles[idx].id.clone()
    } else {
        Uuid::new_v4().to_string()
    };

    // 1. Snapshot files to account storage; refuse to create an empty profile.
    if !snapshot_active_to_profile(&provider, &account_id) {
        if existing_idx.is_none() {
            let _ = fs::remove_dir_all(profile_storage_dir(&provider, &account_id));
        }
        return json!({
            "success": false,
            "error": "No se encontraron archivos de sesión para guardar. ¿Iniciaste sesión en este proveedor?"
        });
    }

    // Other accounts for this provider are no longer active.
    for p in &mut reg.profiles {
        if same_provider(&p.provider, &provider) {
            p.is_active = false;
        }
    }

    let profile = if let Some(idx) = existing_idx {
        let p = &mut reg.profiles[idx];
        if !label.trim().is_empty() {
            p.label = label.trim().to_string();
        }
        if email.is_some() {
            p.email = email;
        }
        if plan_name.is_some() {
            p.plan_name = plan_name;
        }
        p.is_active = true;
        p.last_used_unix_ms = now;
        p.primary_remaining_percent = primary_remaining_percent;
        p.primary_reset_at = primary_reset_at;
        p.time_until_reset_ms = time_until_reset_ms;
        p.clone()
    } else {
        let new_prof = SavedAccountProfile {
            id: account_id.clone(),
            provider: provider.clone(),
            label: if label.trim().is_empty() {
                email.clone().unwrap_or_else(|| format!("{provider} Profile"))
            } else {
                label.trim().to_string()
            },
            email,
            plan_name,
            is_active: true,
            last_used_unix_ms: now,
            primary_remaining_percent,
            primary_reset_at,
            time_until_reset_ms,
        };
        reg.profiles.push(new_prof.clone());
        new_prof
    };

    sync_google_siblings(&mut reg, &provider, &profile);
    save_registry(&reg);

    log_trace(&format!(
        "account_switcher: Saved profile {} for provider {}",
        account_id, provider
    ));

    json!({
        "success": true,
        "profile": profile
    })
}

#[tauri::command]
pub fn save_current_account_profile(request: Option<Value>) -> Value {
    let req = crate::persist::body(&request);
    let provider = req
        .and_then(|r| r.get("provider"))
        .and_then(|v| v.as_str())
        .unwrap_or("agy")
        .to_string();
    let label = req
        .and_then(|r| r.get("label"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    save_current_account_profile_direct(provider, label)
}

pub fn switch_account_profile_direct(provider: String, account_id: String) -> Value {
    let provider = canon_provider(&provider);
    let _guard = REGISTRY_LOCK.lock().unwrap();
    let mut reg = load_registry();

    let target_idx = reg
        .profiles
        .iter()
        .position(|p| same_provider(&p.provider, &provider) && p.id == account_id);
    let Some(idx) = target_idx else {
        return json!({ "success": false, "error": "Profile not found" });
    };

    // 0. Never swap session files under a running client.
    if let Err(msg) = ensure_provider_idle(&provider) {
        return json!({ "success": false, "code": "PROVIDER_BUSY", "error": msg });
    }

    // 1. Persist the latest state of the currently active profile before leaving it.
    if let Some(active_prof) = reg
        .profiles
        .iter()
        .find(|p| same_provider(&p.provider, &provider) && p.is_active)
    {
        if active_prof.id != account_id && !snapshot_active_to_profile(&provider, &active_prof.id) {
            log_trace(&format!(
                "account_switcher: could not refresh snapshot of active profile {}",
                active_prof.id
            ));
        }
    }

    // 2. Transactional restore (backs up current state, rolls back on failure).
    if let Err(e) = apply_profile_to_active(&provider, &account_id) {
        log_trace(&format!("account_switcher: switch failed: {e}"));
        return json!({ "success": false, "error": e });
    }

    // 3. Update active flags and last_used.
    for p in &mut reg.profiles {
        if same_provider(&p.provider, &provider) {
            p.is_active = p.id == account_id;
            if p.is_active {
                p.last_used_unix_ms = now_ms();
            }
        }
    }

    let activated_profile = reg.profiles[idx].clone();
    sync_google_siblings(&mut reg, &provider, &activated_profile);
    save_registry(&reg);

    log_trace(&format!(
        "account_switcher: Switched to profile {} ({}) for provider {}",
        account_id, activated_profile.label, provider
    ));

    json!({
        "success": true,
        "profile": activated_profile
    })
}

#[tauri::command]
pub fn switch_account_profile(request: Option<Value>) -> Value {
    let req = crate::persist::body(&request);
    let provider = req
        .and_then(|r| r.get("provider"))
        .and_then(|v| v.as_str())
        .unwrap_or("agy")
        .to_string();
    let account_id = req
        .and_then(|r| r.get("accountId").or_else(|| r.get("account_id")))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    switch_account_profile_direct(provider, account_id)
}

#[tauri::command]
pub fn delete_account_profile(request: Option<Value>) -> Value {
    let req = crate::persist::body(&request);
    let provider = req
        .and_then(|r| r.get("provider"))
        .and_then(|v| v.as_str())
        .unwrap_or("agy");
    let account_id = req
        .and_then(|r| r.get("accountId").or_else(|| r.get("account_id")))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let provider = canon_provider(provider);
    let _guard = REGISTRY_LOCK.lock().unwrap();
    let mut reg = load_registry();

    let before_len = reg.profiles.len();
    reg.profiles
        .retain(|p| !(same_provider(&p.provider, &provider) && p.id == account_id));

    if reg.profiles.len() < before_len {
        let dir = profile_storage_dir(&provider, account_id);
        let _ = fs::remove_dir_all(dir);
        save_registry(&reg);
        json!({ "success": true })
    } else {
        json!({ "success": false, "error": "Profile not found" })
    }
}

#[tauri::command]
pub fn get_active_account_profile(request: Option<Value>) -> Value {
    let req = crate::persist::body(&request);
    let provider = req
        .and_then(|r| r.get("provider"))
        .and_then(|v| v.as_str())
        .unwrap_or("agy");
    let _guard = REGISTRY_LOCK.lock().unwrap();
    let reg = load_registry();
    if let Some(profile) = reg
        .profiles
        .iter()
        .find(|p| same_provider(&p.provider, provider) && p.is_active)
    {
        json!({ "found": true, "profile": profile })
    } else {
        json!({ "found": false })
    }
}

/// Helper for handoff module: get list of alternative accounts for a provider that have quota available
pub fn get_alternative_accounts_with_quota(provider: &str) -> Vec<SavedAccountProfile> {
    let _guard = REGISTRY_LOCK.lock().unwrap();
    let reg = load_registry();
    let now = now_ms();
    reg.profiles
        .into_iter()
        .filter(|p| {
            if !same_provider(&p.provider, provider) || p.is_active {
                return false;
            }
            // Check quota: if primary_remaining_percent > 0.0 or reset time has passed
            let remaining = p.primary_remaining_percent.unwrap_or(100.0);
            let time_until_reset = p.time_until_reset_ms.unwrap_or(0);
            remaining > 0.0 || (time_until_reset > 0 && now >= (p.last_used_unix_ms + time_until_reset))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_saved_account_profile_serialization() {
        let profile = SavedAccountProfile {
            id: "test-id-123".to_string(),
            provider: "agy".to_string(),
            label: "Work Account".to_string(),
            email: Some("dev@company.com".to_string()),
            plan_name: Some("Google AI Pro".to_string()),
            is_active: true,
            last_used_unix_ms: 1729000000000,
            primary_remaining_percent: Some(85.5),
            primary_reset_at: Some("18:00".to_string()),
            time_until_reset_ms: Some(3600000),
        };

        let json_val = serde_json::to_value(&profile).expect("serialize profile");
        assert_eq!(json_val["id"], "test-id-123");
        assert_eq!(json_val["provider"], "agy");
        assert_eq!(json_val["label"], "Work Account");
        assert_eq!(json_val["email"], "dev@company.com");
        assert_eq!(json_val["isActive"], true);
        assert_eq!(json_val["primaryRemainingPercent"], 85.5);

        let deserialized: SavedAccountProfile = serde_json::from_value(json_val).expect("deserialize profile");
        assert_eq!(deserialized.id, profile.id);
        assert_eq!(deserialized.primary_remaining_percent, Some(85.5));
    }

    #[test]
    fn test_provider_canonicalisation() {
        assert_eq!(canon_provider("antigravity"), "agy");
        assert!(same_provider("antigravity", "agy"));
        assert!(!same_provider("agy", "gemini"));
    }

    #[test]
    fn test_blocking_process_detection() {
        assert!(is_blocking_process("agy", "antigravity.exe"));
        assert!(is_blocking_process("agy", "language_server_windows_x64.exe"));
        assert!(is_blocking_process("gemini", "agy.exe"));
        assert!(!is_blocking_process("agy", "geminiapplauncher.exe"));
        assert!(!is_blocking_process("claude", "agy.exe"));
        assert!(is_blocking_process("claude", "claude.exe"));
    }

    #[test]
    fn test_copy_atomic_and_staged_path() {
        let dir = std::env::temp_dir().join(format!("bm-switcher-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let src = dir.join("a.json");
        let dst = dir.join("sub").join("b.json");
        fs::write(&src, b"hello").unwrap();

        assert!(copy_atomic(&src, &dst));
        assert_eq!(fs::read(&dst).unwrap(), b"hello");
        assert!(!staged_path(&dst).exists(), "temp file must not linger");
        assert!(!copy_atomic(&dir.join("missing"), &dst));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_save_current_account_profile_antigravity() {
        let mut reg = AccountProfilesRegistry::default();
        let p1 = SavedAccountProfile {
            id: "id-1".to_string(),
            provider: "agy".to_string(),
            label: "aloha".to_string(),
            email: Some("test@example.com".to_string()),
            plan_name: Some("Pro".to_string()),
            is_active: true,
            last_used_unix_ms: 100,
            primary_remaining_percent: Some(90.0),
            primary_reset_at: None,
            time_until_reset_ms: None,
        };
        reg.profiles.push(p1);

        // A duplicate with same email should match existing and update instead of push
        let email = Some("test@example.com".to_string());
        let existing = reg.profiles.iter().position(|p| {
            p.provider == "agy" && p.email.as_ref().map_or(false, |e| e.eq_ignore_ascii_case(email.as_ref().unwrap()))
        });
        assert_eq!(existing, Some(0));
    }
}
