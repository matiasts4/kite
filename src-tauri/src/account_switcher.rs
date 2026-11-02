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
pub fn canon_provider(p: &str) -> String {
    match p {
        "antigravity" => "agy".to_string(),
        other => other.to_string(),
    }
}

pub fn same_provider(a: &str, b: &str) -> bool {
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
    let root = crate::connections::shared_account_profiles_root();
    let _ = fs::create_dir_all(&root);
    root
}

fn registry_file_in(root: &Path) -> PathBuf {
    root.join("profiles.json")
}

fn profile_storage_dir_in(root: &Path, provider: &str, account_id: &str) -> PathBuf {
    let dir = root.join(provider).join(account_id);
    let _ = fs::create_dir_all(&dir);
    dir
}

fn profile_storage_dir(provider: &str, account_id: &str) -> PathBuf {
    profile_storage_dir_in(&profiles_root(), provider, account_id)
}

fn load_registry_from(root: &Path) -> AccountProfilesRegistry {
    let file = registry_file_in(root);
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

fn load_registry() -> AccountProfilesRegistry {
    load_registry_from(&profiles_root())
}

fn save_registry_to(root: &Path, registry: &AccountProfilesRegistry) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|e| format!("cannot create {}: {e}", root.display()))?;
    let file = registry_file_in(root);
    let bytes = serde_json::to_vec_pretty(registry)
        .map_err(|e| format!("cannot serialize {}: {e}", file.display()))?;
    let tmp = staged_path(&file);
    if let Err(e) = fs::write(&tmp, bytes) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("cannot write {}: {e}", tmp.display()));
    }
    if let Err(e) = fs::rename(&tmp, &file) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("cannot replace {}: {e}", file.display()));
    }
    Ok(())
}

fn save_registry(registry: &AccountProfilesRegistry) {
    let _ = save_registry_to(&profiles_root(), registry);
}

// ---------------------------------------------------------------------------
// Import from a legacy per-install account-profiles tree
// ---------------------------------------------------------------------------

fn copy_tree(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| format!("cannot create {}: {e}", dst.display()))?;
    let entries = fs::read_dir(src).map_err(|e| format!("cannot read {}: {e}", src.display()))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let target = dst.join(entry.file_name());
        if path.is_dir() {
            copy_tree(&path, &target)?;
        } else if !copy_atomic(&path, &target) {
            return Err(format!("cannot copy {}", path.display()));
        }
    }
    Ok(())
}

fn snapshot_account_dirs(root: &Path) -> Vec<(String, String)> {
    let mut found = Vec::new();
    let Ok(providers) = fs::read_dir(root) else {
        return found;
    };
    for provider_entry in providers.flatten() {
        if !provider_entry.path().is_dir() {
            continue;
        }
        let provider = provider_entry.file_name().to_string_lossy().to_string();
        if provider == "_backups" {
            continue;
        }
        let Ok(accounts) = fs::read_dir(provider_entry.path()) else {
            continue;
        };
        for account_entry in accounts.flatten() {
            if account_entry.path().is_dir() {
                found.push((
                    provider.clone(),
                    account_entry.file_name().to_string_lossy().to_string(),
                ));
            }
        }
    }
    found
}

fn merge_profile(registry: &mut AccountProfilesRegistry, incoming: SavedAccountProfile) -> bool {
    let canonical_provider = canon_provider(&incoming.provider);
    let existing = registry.profiles.iter().position(|profile| {
        canon_provider(&profile.provider) == canonical_provider
            && match (&profile.email, &incoming.email) {
                (Some(a), Some(b)) => a.eq_ignore_ascii_case(b),
                _ => profile.id == incoming.id,
            }
    });
    let provider_has_active = registry
        .profiles
        .iter()
        .any(|profile| canon_provider(&profile.provider) == canonical_provider && profile.is_active);

    match existing {
        Some(index) => {
            let current = &mut registry.profiles[index];
            if incoming.last_used_unix_ms >= current.last_used_unix_ms {
                if !incoming.label.trim().is_empty() {
                    current.label = incoming.label;
                }
                if incoming.email.is_some() {
                    current.email = incoming.email;
                }
                if incoming.plan_name.is_some() {
                    current.plan_name = incoming.plan_name;
                }
                if incoming.primary_remaining_percent.is_some() {
                    current.primary_remaining_percent = incoming.primary_remaining_percent;
                }
                if incoming.primary_reset_at.is_some() {
                    current.primary_reset_at = incoming.primary_reset_at;
                }
                if incoming.time_until_reset_ms.is_some() {
                    current.time_until_reset_ms = incoming.time_until_reset_ms;
                }
                current.last_used_unix_ms = incoming.last_used_unix_ms;
            }
            if !provider_has_active && incoming.is_active {
                current.is_active = true;
            }
            false
        }
        None => {
            let mut profile = incoming;
            profile.provider = canonical_provider;
            profile.is_active = profile.is_active && !provider_has_active;
            registry.profiles.push(profile);
            true
        }
    }
}

/// Copies account profiles from a legacy per-install `account-profiles` tree
/// into the shared connections tree. The source tree is only read: files are
/// copied, never moved or deleted.
pub fn import_account_profiles_from(
    source_root: &Path,
    destination_root: &Path,
) -> Result<usize, String> {
    if !source_root.is_dir() {
        return Ok(0);
    }

    let profiles_file = registry_file_in(source_root);
    let mut incoming = if profiles_file.is_file() {
        let bytes = fs::read(&profiles_file)
            .map_err(|e| format!("cannot read {}: {e}", profiles_file.display()))?;
        serde_json::from_slice::<AccountProfilesRegistry>(&bytes)
            .map_err(|e| format!("cannot parse {}: {e}", profiles_file.display()))?
            .profiles
    } else {
        Vec::new()
    };

    // Snapshots whose index entry was already lost still belong to an account.
    for (provider, account_id) in snapshot_account_dirs(source_root) {
        if !incoming
            .iter()
            .any(|profile| same_provider(&profile.provider, &provider) && profile.id == account_id)
        {
            incoming.push(SavedAccountProfile {
                id: account_id,
                label: format!("{provider} Profile"),
                provider,
                email: None,
                plan_name: None,
                is_active: false,
                last_used_unix_ms: 0,
                primary_remaining_percent: None,
                primary_reset_at: None,
                time_until_reset_ms: None,
            });
        }
    }

    if incoming.is_empty() {
        return Ok(0);
    }

    for profile in &incoming {
        let provider = canon_provider(&profile.provider);
        let mut source = source_root.join(&provider).join(&profile.id);
        if !source.is_dir() && provider != profile.provider {
            source = source_root.join(&profile.provider).join(&profile.id);
        }
        if source.is_dir() {
            let destination = profile_storage_dir_in(destination_root, &provider, &profile.id);
            copy_tree(&source, &destination)?;
        }
    }

    let _guard = REGISTRY_LOCK.lock().unwrap();
    let mut registry = load_registry_from(destination_root);
    let mut imported = 0;
    for profile in incoming {
        if merge_profile(&mut registry, profile) {
            imported += 1;
        }
    }
    if imported > 0 {
        save_registry_to(destination_root, &registry)?;
    }
    Ok(imported)
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
            "Cierra la aplicación externa de {} antes de cambiar de cuenta (procesos activos: {}).",
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

    let canon_prov = provider.as_deref().map(canon_provider);
    let probe_target = canon_prov.clone().unwrap_or_else(|| "agy".to_string());

    // Phase 1: probe live quota (reads real OS credentials / token).
    let live_q = get_cached_live_quota(&probe_target).or_else(|| fetch_live_quota(&probe_target));

    // Phase 2: reconcile live identity with registry (short lock).
    let _guard = REGISTRY_LOCK.lock().unwrap();
    let mut reg = load_registry();
    let mut changed = false;
    let mut unregistered_live_session: Option<Value> = None;

    if let Some(ref q) = live_q {
        if let Some(ref live_email) = q.email {
            let matching_idx = reg.profiles.iter().position(|p| {
                same_provider(&p.provider, &probe_target)
                    && p.email.as_ref().map_or(false, |e| e.eq_ignore_ascii_case(live_email))
            });

            if let Some(idx) = matching_idx {
                for (i, p) in reg.profiles.iter_mut().enumerate() {
                    if same_provider(&p.provider, &probe_target) {
                        let should_be_active = i == idx;
                        if p.is_active != should_be_active {
                            p.is_active = should_be_active;
                            changed = true;
                        }
                        if should_be_active {
                            p.primary_remaining_percent = Some(q.percent);
                            p.primary_reset_at = q.reset_at.clone();
                            p.time_until_reset_ms = q.until_ms;
                            if q.plan.is_some() {
                                p.plan_name = q.plan.clone();
                            }
                            p.last_used_unix_ms = now_ms();
                            changed = true;
                        }
                    }
                }
            } else {
                // The live account does not match any profile in the vault.
                // Avoid false active badges and expose unregistered session to frontend.
                for p in &mut reg.profiles {
                    if same_provider(&p.provider, &probe_target) && p.is_active {
                        p.is_active = false;
                        changed = true;
                    }
                }
                unregistered_live_session = Some(json!({
                    "provider": probe_target,
                    "email": live_email,
                    "planName": q.plan,
                    "primaryRemainingPercent": q.percent,
                    "primaryResetAt": q.reset_at,
                    "timeUntilResetMs": q.until_ms,
                }));
            }
        } else {
            // Live email not detected, but update active profile quota if available
            for p in &mut reg.profiles {
                if same_provider(&p.provider, &probe_target) && p.is_active {
                    p.primary_remaining_percent = Some(q.percent);
                    p.primary_reset_at = q.reset_at.clone();
                    p.time_until_reset_ms = q.until_ms;
                    if q.plan.is_some() {
                        p.plan_name = q.plan.clone();
                    }
                    changed = true;
                }
            }
        }
    }

    if changed {
        save_registry(&reg);
    }

    let filtered: Vec<SavedAccountProfile> = match canon_prov.as_deref() {
        Some(p) => reg.profiles.into_iter().filter(|a| same_provider(&a.provider, p)).collect(),
        None => reg.profiles,
    };

    json!({
        "schemaVersion": 1,
        "profiles": filtered,
        "unregisteredLiveSession": unregistered_live_session
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

    // 0. Quiesce Kite-managed terminals for this provider so they flush scrollback and release file locks
    let quiesced_terminals = crate::terminal::quiesce_provider_terminals(&provider);

    // Terminate any CLI processes of this provider so credentials files are completely unlocked
    terminate_provider_cli_processes(&provider);

    // If external processes outside Kite are still running and blocking:
    if let Err(msg) = ensure_provider_idle(&provider) {
        let current_label = reg
            .profiles
            .iter()
            .find(|p| same_provider(&p.provider, &provider) && p.is_active)
            .map(|p| p.label.as_str())
            .unwrap_or("Actual");
        crate::terminal::respawn_provider_terminals(&provider, current_label, &quiesced_terminals);
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
        let current_label = reg
            .profiles
            .iter()
            .find(|p| same_provider(&p.provider, &provider) && p.is_active)
            .map(|p| p.label.as_str())
            .unwrap_or("Actual");
        crate::terminal::respawn_provider_terminals(&provider, current_label, &quiesced_terminals);
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

    // Invalidate quota cache for this provider so stale in-memory cached identity does not shadow the newly switched account
    let canon = canon_provider(&provider);
    let quota_key = match canon.as_str() {
        "agy" => "antigravity",
        other => other,
    };
    crate::quota::invalidate_provider_cache(quota_key);
    crate::quota::invalidate_provider_cache(&provider);

    // 4. Respawn the quiesced terminals with the new account's credentials!
    crate::terminal::respawn_provider_terminals(&provider, &activated_profile.label, &quiesced_terminals);

    log_trace(&format!(
        "account_switcher: Switched to profile {} ({}) for provider {} (restarted {} terminals)",
        account_id, activated_profile.label, provider, quiesced_terminals.len()
    ));

    json!({
        "success": true,
        "profile": activated_profile,
        "terminalsRestarted": quiesced_terminals.len()
    })
}

#[tauri::command]
pub async fn switch_account_profile(request: Option<Value>) -> Value {
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

    tokio::task::spawn_blocking(move || {
        switch_account_profile_direct(provider, account_id)
    })
    .await
    .unwrap_or_else(|e| {
        json!({
            "success": false,
            "error": format!("Worker task failed: {e}")
        })
    })
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
    let canon_p = canon_provider(provider);

    // Reconcile if live quota has an authenticated email
    if let Some(q) = get_cached_live_quota(&canon_p) {
        if let Some(ref live_email) = q.email {
            let _guard = REGISTRY_LOCK.lock().unwrap();
            let mut reg = load_registry();
            let matching_idx = reg.profiles.iter().position(|p| {
                same_provider(&p.provider, &canon_p)
                    && p.email.as_ref().map_or(false, |e| e.eq_ignore_ascii_case(live_email))
            });
            if let Some(idx) = matching_idx {
                let mut changed = false;
                for (i, p) in reg.profiles.iter_mut().enumerate() {
                    if same_provider(&p.provider, &canon_p) {
                        let should_be_active = i == idx;
                        if p.is_active != should_be_active {
                            p.is_active = should_be_active;
                            changed = true;
                        }
                    }
                }
                if changed {
                    save_registry(&reg);
                }
            }
        }
    }

    let _guard = REGISTRY_LOCK.lock().unwrap();
    let reg = load_registry();
    if let Some(profile) = reg
        .profiles
        .iter()
        .find(|p| same_provider(&p.provider, &canon_p) && p.is_active)
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

// ---------------------------------------------------------------------------
// Detected CLI Accounts (auto-discovery across local CLI files / tools)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedCliAccount {
    pub provider: String,
    pub display_name: String,
    pub auth_state: String, // "authenticated" | "unauthenticated" | "not_installed"
    pub account_label: Option<String>,
    pub email: Option<String>,
    pub plan_name: Option<String>,
    pub binary_path: Option<String>,
    pub config_path: Option<String>,
    pub details: Option<String>,
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

#[tauri::command]
pub fn list_detected_cli_accounts() -> Value {
    let home = user_home_dir();
    let appdata = appdata_dir();
    let mut accounts: Vec<DetectedCliAccount> = Vec::new();

    // 1. Antigravity (Google)
    {
        let bin = crate::acp::resolve_antigravity_acp_binary()
            .map(|p| p.to_string_lossy().to_string());
        let creds_file = home.join(".gemini").join("oauth_creds.json");
        let accounts_file = home.join(".gemini").join("google_accounts.json");
        let mut email: Option<String> = None;
        let mut name: Option<String> = None;

        if creds_file.exists() {
            if let Ok(bytes) = fs::read(&creds_file) {
                if let Ok(val) = serde_json::from_slice::<Value>(&bytes) {
                    if let Some(id_tok) = val.get("id_token").and_then(|v| v.as_str()) {
                        if let Some(payload) = decode_jwt_payload(id_tok) {
                            email = payload.get("email").and_then(|v| v.as_str()).map(String::from);
                            name = payload.get("name").and_then(|v| v.as_str()).map(String::from);
                        }
                    }
                }
            }
        }
        if email.is_none() && accounts_file.exists() {
            if let Ok(bytes) = fs::read(&accounts_file) {
                if let Ok(val) = serde_json::from_slice::<Value>(&bytes) {
                    email = val.get("active").and_then(|v| v.as_str()).map(String::from);
                }
            }
        }

        let auth_state = if email.is_some() || creds_file.exists() {
            "authenticated"
        } else if bin.is_some() {
            "unauthenticated"
        } else {
            "not_installed"
        };

        accounts.push(DetectedCliAccount {
            provider: "antigravity".into(),
            display_name: "Antigravity".into(),
            auth_state: auth_state.into(),
            account_label: email.clone().or(name).or_else(|| Some("Google Account".into())),
            email,
            plan_name: Some("Google Cloud AI / Gemini".into()),
            binary_path: bin,
            config_path: Some(creds_file.to_string_lossy().to_string()),
            details: Some("Sesión OAuth detectada en ~/.gemini/oauth_creds.json".into()),
        });
    }

    // 2. Codex (OpenAI)
    {
        let bin = crate::chat::resolve_bin("codex", &[
            r"C:\Users\PC\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe",
            r"C:\Users\PC\AppData\Local\Programs\OpenAI\codex.exe",
        ]).map(|p| p.to_string_lossy().to_string());
        let auth_file = home.join(".codex").join("auth.json");
        let mut email: Option<String> = None;
        let mut plan: Option<String> = None;
        let mut has_auth = false;

        if auth_file.exists() {
            if let Ok(bytes) = fs::read(&auth_file) {
                if let Ok(val) = serde_json::from_slice::<Value>(&bytes) {
                    if let Some(id_tok) = val.pointer("/tokens/id_token").and_then(|v| v.as_str()) {
                        has_auth = true;
                        if let Some(payload) = decode_jwt_payload(id_tok) {
                            email = payload.get("email").and_then(|v| v.as_str()).map(String::from);
                            if let Some(plan_type) = payload.pointer("/https:~1~1api.openai.com~1auth/chatgpt_plan_type").and_then(|v| v.as_str()) {
                                plan = Some(match plan_type {
                                    "plus" => "ChatGPT Plus".into(),
                                    "pro" => "ChatGPT Pro".into(),
                                    "team" => "ChatGPT Team".into(),
                                    other => format!("ChatGPT {}", other),
                                });
                            }
                        }
                    } else if val.pointer("/tokens/access_token").is_some() || val.get("OPENAI_API_KEY").and_then(|v| v.as_str()).map_or(false, |k| !k.is_empty()) {
                        has_auth = true;
                    }
                }
            }
        }

        let auth_state = if has_auth {
            "authenticated"
        } else if bin.is_some() {
            "unauthenticated"
        } else {
            "not_installed"
        };

        accounts.push(DetectedCliAccount {
            provider: "codex".into(),
            display_name: "Codex".into(),
            auth_state: auth_state.into(),
            account_label: email.clone().or_else(|| Some("ChatGPT Account".into())),
            email,
            plan_name: plan.or_else(|| Some("ChatGPT Plus / OpenAI".into())),
            binary_path: bin,
            config_path: Some(auth_file.to_string_lossy().to_string()),
            details: Some("Tokens CLI detectados en ~/.codex/auth.json".into()),
        });
    }

    // 3. Grok (xAI)
    {
        let bin = crate::chat::resolve_bin("grok", &[])
            .map(|p| p.to_string_lossy().to_string());
        let auth_file = home.join(".grok").join("auth.json");
        let mut email: Option<String> = None;
        let mut has_auth = false;

        if auth_file.exists() {
            if let Ok(bytes) = fs::read(&auth_file) {
                if let Ok(val) = serde_json::from_slice::<Value>(&bytes) {
                    if let Some(obj) = val.as_object() {
                        for (_k, v) in obj {
                            if let Some(em) = v.get("email").and_then(|e| e.as_str()) {
                                email = Some(em.to_string());
                                has_auth = true;
                                break;
                            }
                            if v.get("key").is_some() || v.get("refresh_token").is_some() {
                                has_auth = true;
                            }
                        }
                    }
                    if !has_auth && (val.get("api_key").is_some() || val.get("email").is_some()) {
                        email = val.get("email").and_then(|e| e.as_str()).map(String::from);
                        has_auth = true;
                    }
                }
            }
        }

        let auth_state = if has_auth {
            "authenticated"
        } else if bin.is_some() {
            "unauthenticated"
        } else {
            "not_installed"
        };

        accounts.push(DetectedCliAccount {
            provider: "grok".into(),
            display_name: "Grok".into(),
            auth_state: auth_state.into(),
            account_label: email.clone().or_else(|| Some("xAI Account".into())),
            email,
            plan_name: Some("xAI Grok CLI".into()),
            binary_path: bin,
            config_path: Some(auth_file.to_string_lossy().to_string()),
            details: Some("Sesión OIDC detectada en ~/.grok/auth.json".into()),
        });
    }

    // 4. OpenCode
    {
        let bin = crate::chat::resolve_bin("opencode", &[])
            .map(|p| p.to_string_lossy().to_string());
        let auth_file = home.join(".local").join("share").join("opencode").join("auth.json");
        let mut providers_list: Vec<String> = Vec::new();
        let mut has_auth = false;

        if auth_file.exists() {
            if let Ok(bytes) = fs::read(&auth_file) {
                if let Ok(val) = serde_json::from_slice::<Value>(&bytes) {
                    if let Some(obj) = val.as_object() {
                        providers_list = obj.keys().cloned().collect();
                        has_auth = !providers_list.is_empty();
                    }
                }
            }
        }

        let auth_state = if has_auth {
            "authenticated"
        } else if bin.is_some() {
            "unauthenticated"
        } else {
            "not_installed"
        };

        let account_label = if !providers_list.is_empty() {
            let cap = 3;
            let shown = providers_list.iter().take(cap).cloned().collect::<Vec<_>>().join(", ");
            if providers_list.len() > cap {
                Some(format!("{} (+{})", shown, providers_list.len() - cap))
            } else {
                Some(shown)
            }
        } else {
            Some("OpenCode CLI".into())
        };

        let details = if !providers_list.is_empty() {
            Some(format!("Proveedores autenticados: {}", providers_list.join(", ")))
        } else {
            Some("Sesión local en ~/.local/share/opencode".into())
        };

        accounts.push(DetectedCliAccount {
            provider: "opencode".into(),
            display_name: "OpenCode".into(),
            auth_state: auth_state.into(),
            account_label,
            email: None,
            plan_name: Some("Multi-proveedor / OpenCode Go".into()),
            binary_path: bin,
            config_path: Some(auth_file.to_string_lossy().to_string()),
            details,
        });
    }

    // 5. Cursor
    {
        let bin = crate::chat::resolve_bin("cursor-agent", &[])
            .or_else(|| crate::chat::resolve_bin("agent", &[]))
            .map(|p| p.to_string_lossy().to_string());
        let cursor_auth1 = appdata.join("Cursor").join("auth.json");
        let cursor_auth2 = home.join(".cursor").join("auth.json");
        let auth_file = if cursor_auth1.exists() {
            Some(cursor_auth1)
        } else if cursor_auth2.exists() {
            Some(cursor_auth2)
        } else {
            None
        };

        let mut email: Option<String> = None;
        let mut has_auth = false;

        if let Some(ref af) = auth_file {
            if let Ok(bytes) = fs::read(af) {
                if let Ok(val) = serde_json::from_slice::<Value>(&bytes) {
                    if let Some(tok) = val.get("accessToken").and_then(|v| v.as_str()) {
                        if let Some(payload) = decode_jwt_payload(tok) {
                            email = payload.get("email").and_then(|v| v.as_str()).map(String::from);
                        }
                        has_auth = true;
                    } else if val.get("apiKey").is_some() {
                        has_auth = true;
                    }
                }
            }
        }

        let auth_state = if has_auth || bin.is_some() {
            "authenticated"
        } else {
            "not_installed"
        };

        accounts.push(DetectedCliAccount {
            provider: "cursor".into(),
            display_name: "Cursor".into(),
            auth_state: auth_state.into(),
            account_label: email.clone().or_else(|| Some("Cursor CLI / Agent".into())),
            email,
            plan_name: Some("Cursor Pro / Agent".into()),
            binary_path: bin,
            config_path: auth_file.map(|p| p.to_string_lossy().to_string()),
            details: Some("cursor-agent en PATH".into()),
        });
    }

    // 6. Claude Code
    {
        let bin = crate::chat::resolve_bin("claude", &[])
            .map(|p| p.to_string_lossy().to_string());
        let creds_file = home.join(".claude").join(".credentials.json");
        let conf_file = home.join(".claude.json");
        let mut email: Option<String> = None;
        let mut has_auth = false;

        if creds_file.exists() {
            if let Ok(bytes) = fs::read(&creds_file) {
                if let Ok(val) = serde_json::from_slice::<Value>(&bytes) {
                    if val.pointer("/claudeAiOauth/accessToken").is_some() {
                        has_auth = true;
                    }
                }
            }
        }
        if conf_file.exists() {
            if let Ok(bytes) = fs::read(&conf_file) {
                if let Ok(val) = serde_json::from_slice::<Value>(&bytes) {
                    if let Some(em) = val.pointer("/oauthAccount/emailAddress").and_then(|v| v.as_str()) {
                        email = Some(em.to_string());
                        has_auth = true;
                    }
                }
            }
        }

        let auth_state = if has_auth {
            "authenticated"
        } else if bin.is_some() {
            "unauthenticated"
        } else {
            "not_installed"
        };

        accounts.push(DetectedCliAccount {
            provider: "claude".into(),
            display_name: "Claude Code".into(),
            auth_state: auth_state.into(),
            account_label: email.clone().or_else(|| Some("Claude CLI".into())),
            email,
            plan_name: Some("Anthropic Claude Code".into()),
            binary_path: bin,
            config_path: Some(creds_file.to_string_lossy().to_string()),
            details: Some("Sesión OAuth en ~/.claude".into()),
        });
    }

    json!({
        "schemaVersion": 1,
        "accounts": accounts
    })
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
        assert!(is_blocking_process("agy", "antigravity"));
        assert!(!is_blocking_process("agy", "geminiapplauncher.exe"));
        assert!(!is_blocking_process("agy", "agy.exe"));
        assert!(!is_blocking_process("claude", "agy.exe"));
        assert!(!is_blocking_process("claude", "claude.exe"));
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
