use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use super::storage::{copy_atomic, staged_path};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CachedQuotaWindow {
    pub name: String,
    pub remaining_percent: f64,
    pub is_exhausted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_until_reset_ms: Option<i64>,
    #[serde(default)]
    pub updated_at_unix_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AutoSwitchPolicy {
    pub enabled: bool,
    pub trigger_threshold_percent: f64,
    pub selection_strategy: String,
    pub priority_order: Vec<String>,
    pub excluded_account_ids: Vec<String>,
    pub model_mismatch_policy: String,
    pub busy_terminals_policy: String,
    pub auto_continue_chat_turn: bool,
    pub cooldown_seconds: u64,
    pub max_consecutive_switches: u32,
}

impl Default for AutoSwitchPolicy {
    fn default() -> Self {
        Self {
            enabled: false,
            trigger_threshold_percent: 0.0,
            selection_strategy: "highest_quota".to_string(),
            priority_order: Vec::new(),
            excluded_account_ids: Vec::new(),
            model_mismatch_policy: "confirm_notification".to_string(),
            busy_terminals_policy: "wait_idle".to_string(),
            auto_continue_chat_turn: true,
            cooldown_seconds: 120,
            max_consecutive_switches: 3,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AutoSwitchRuntimeStatus {
    pub paused: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pause_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cooldown_until_ms: Option<i64>,
    pub recent_switch_count: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_reset_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_reset_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub residual_process_count: Option<usize>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub base_app_titles: Vec<String>,
}

fn normalize_id_list(ids: Vec<String>) -> Vec<String> {
    let mut out = Vec::new();
    for raw in ids {
        let trimmed = raw.trim();
        if !trimmed.is_empty() && !out.iter().any(|existing: &String| existing == trimmed) {
            out.push(trimmed.to_string());
        }
    }
    out
}

pub(crate) fn validate_and_normalize_auto_switch_policy(
    mut policy: AutoSwitchPolicy,
) -> Result<AutoSwitchPolicy, String> {
    if !policy.trigger_threshold_percent.is_finite()
        || policy.trigger_threshold_percent < 0.0
        || policy.trigger_threshold_percent > 100.0
    {
        return Err("triggerThresholdPercent must be between 0 and 100.".to_string());
    }

    policy.selection_strategy = policy.selection_strategy.trim().to_string();
    if !matches!(
        policy.selection_strategy.as_str(),
        "highest_quota" | "priority_order"
    ) {
        return Err(format!(
            "Unsupported selectionStrategy '{}'. Allowed: highest_quota, priority_order.",
            policy.selection_strategy
        ));
    }

    policy.model_mismatch_policy = policy.model_mismatch_policy.trim().to_string();
    if !matches!(
        policy.model_mismatch_policy.as_str(),
        "confirm_notification" | "auto_fallback"
    ) {
        return Err(format!(
            "Unsupported modelMismatchPolicy '{}'. Allowed: confirm_notification, auto_fallback.",
            policy.model_mismatch_policy
        ));
    }

    policy.busy_terminals_policy = policy.busy_terminals_policy.trim().to_string();
    if !matches!(
        policy.busy_terminals_policy.as_str(),
        "wait_idle" | "ask" | "interrupt"
    ) {
        return Err(format!(
            "Unsupported busyTerminalsPolicy '{}'. Allowed: wait_idle, ask, interrupt.",
            policy.busy_terminals_policy
        ));
    }

    if policy.cooldown_seconds > 86_400 {
        return Err("cooldownSeconds cannot exceed 86400 seconds.".to_string());
    }
    if policy.max_consecutive_switches == 0 || policy.max_consecutive_switches > 50 {
        return Err("maxConsecutiveSwitches must be between 1 and 50.".to_string());
    }

    policy.priority_order = normalize_id_list(policy.priority_order);
    policy.excluded_account_ids = normalize_id_list(policy.excluded_account_ids);
    Ok(policy)
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential_status: Option<String>,
    #[serde(default)]
    pub has_refresh_token: bool,
    #[serde(default)]
    pub quota_windows: Vec<CachedQuotaWindow>,
    #[serde(default)]
    pub available_model_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub models_updated_at_unix_ms: Option<i64>,
}

pub(crate) fn compute_profile_credential_health(
    root: &Path,
    profile: &SavedAccountProfile,
) -> (String, bool) {
    let canon = canon_provider(&profile.provider);
    let prof_dir = root.join(&canon).join(&profile.id);
    if canon == "agy" {
        let (status, has_refresh) = crate::quota::inspect_antigravity_credential_file(
            &prof_dir.join("gemini_antigravity_cred.json"),
        );
        return (status.to_string(), has_refresh);
    }
    let mappings = super::storage::get_provider_file_mappings(&canon);
    let has_any = mappings
        .iter()
        .any(|m| prof_dir.join(m.rel_dest).is_file());
    let status = if has_any { "valid" } else { "missing_file" };
    (status.to_string(), false)
}

pub(crate) fn hydrate_profile_credential_health(
    root: &Path,
    profiles: &mut [SavedAccountProfile],
) {
    for p in profiles.iter_mut() {
        let (status, has_refresh) = compute_profile_credential_health(root, p);
        p.credential_status = Some(status);
        p.has_refresh_token = has_refresh;
    }
}

#[derive(Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccountProfilesRegistry {
    #[serde(default)]
    pub(crate) profiles: Vec<SavedAccountProfile>,
    #[serde(default, alias = "auto_switch_policies")]
    pub(crate) auto_switch_policies: HashMap<String, AutoSwitchPolicy>,
}

pub(crate) static REGISTRY_LOCK: Mutex<()> = Mutex::new(());

pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// `antigravity` and `agy` are the same product; keep a single identity so
/// profiles / active flags / vault folders never diverge.
pub fn canon_provider(p: &str) -> String {
    let trimmed = p.trim();
    match trimmed.to_ascii_lowercase().as_str() {
        "antigravity" | "agy" => "agy".to_string(),
        _ => trimmed.to_string(),
    }
}

pub fn same_provider(a: &str, b: &str) -> bool {
    canon_provider(a) == canon_provider(b)
}

pub(crate) fn user_home_dir() -> PathBuf {
    if let Ok(profile) = std::env::var("USERPROFILE") {
        PathBuf::from(profile)
    } else if let Ok(home) = std::env::var("HOME") {
        PathBuf::from(home)
    } else {
        PathBuf::from(".")
    }
}

pub(crate) fn appdata_dir() -> PathBuf {
    if let Ok(appdata) = std::env::var("APPDATA") {
        PathBuf::from(appdata)
    } else {
        user_home_dir().join("AppData").join("Roaming")
    }
}

pub(crate) fn profiles_root() -> PathBuf {
    let root = crate::connections::shared_account_profiles_root();
    let _ = fs::create_dir_all(&root);
    root
}

pub(crate) fn registry_file_in(root: &Path) -> PathBuf {
    root.join("profiles.json")
}

pub(crate) fn profile_storage_dir_in(root: &Path, provider: &str, account_id: &str) -> PathBuf {
    let dir = root.join(provider).join(account_id);
    let _ = fs::create_dir_all(&dir);
    dir
}

pub(crate) fn profile_storage_dir(provider: &str, account_id: &str) -> PathBuf {
    profile_storage_dir_in(&profiles_root(), provider, account_id)
}

pub(crate) fn reconcile_agy_profile_integrity(root: &Path, profiles: &mut Vec<SavedAccountProfile>) -> bool {
    let mut modified = false;
    for p in profiles.iter_mut() {
        if canon_provider(&p.provider) == "agy" {
            let prof_dir = root.join("agy").join(&p.id);
            let cred_path = prof_dir.join("gemini_antigravity_cred.json");
            if cred_path.exists() {
                if let Ok(raw) = fs::read_to_string(&cred_path) {
                    if let Some(identity) = crate::quota::parse_antigravity_credential_blob(&raw) {
                        let cred_email = identity.email.trim();
                        if !cred_email.is_empty() {
                            let curr_email = p.email.as_deref().unwrap_or("").trim();
                            if !curr_email.eq_ignore_ascii_case(cred_email) {
                                if p.label.trim().is_empty() || p.label.trim().eq_ignore_ascii_case(curr_email) {
                                    p.label = cred_email.to_string();
                                }
                                p.email = Some(cred_email.to_string());
                                modified = true;
                            }
                        }
                    }
                }
            }
            // Clean up legacy contaminated files
            for legacy in &["oauth_creds.json", "google_accounts.json", "cli_settings.json", "settings.json", "storage.json"] {
                let leg_path = prof_dir.join(legacy);
                if leg_path.exists() {
                    let _ = fs::remove_file(leg_path);
                }
            }
        }
    }
    modified
}

pub(crate) fn load_registry_from(root: &Path) -> AccountProfilesRegistry {
    let file = registry_file_in(root);
    if file.exists() {
        if let Ok(data) = fs::read(&file) {
            if let Ok(mut reg) = serde_json::from_slice::<AccountProfilesRegistry>(&data) {
                let repaired = reconcile_agy_profile_integrity(root, &mut reg.profiles);
                let orig_len = reg.profiles.len();
                let mut dedup_replaced = false;
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
                        let cur = &deduplicated[pos];
                        let cur_valid = compute_profile_credential_health(root, cur).0 == "valid";
                        let new_valid = compute_profile_credential_health(root, &p).0 == "valid";
                        let cur_has_cred = root.join(&canon_prov).join(&cur.id).join("gemini_antigravity_cred.json").exists();
                        let new_has_cred = root.join(&canon_prov).join(&p.id).join("gemini_antigravity_cred.json").exists();
                        if (!cur_valid && new_valid)
                            || (!cur_has_cred && new_has_cred)
                            || ((new_valid == cur_valid)
                                && (p.is_active || (!cur.is_active && p.last_used_unix_ms > cur.last_used_unix_ms)))
                        {
                            deduplicated[pos] = p;
                            dedup_replaced = true;
                        }
                    } else {
                        deduplicated.push(p);
                    }
                }
                let dedup_changed = dedup_replaced || deduplicated.len() != orig_len;
                reg.profiles = deduplicated;
                hydrate_profile_credential_health(root, &mut reg.profiles);
                if repaired || dedup_changed {
                    let _ = save_registry_to(root, &reg);
                }
                return reg;
            }
        }
    }
    AccountProfilesRegistry::default()
}

pub(crate) fn load_registry() -> AccountProfilesRegistry {
    load_registry_from(&profiles_root())
}

pub(crate) fn save_registry_to(root: &Path, registry: &AccountProfilesRegistry) -> Result<(), String> {
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

pub(crate) fn save_registry(registry: &AccountProfilesRegistry) {
    let _ = save_registry_to(&profiles_root(), registry);
}

pub(crate) fn get_auto_switch_policy_in(root: &Path, provider: &str) -> AutoSwitchPolicy {
    let canon = canon_provider(provider);
    let _guard = REGISTRY_LOCK.lock().unwrap();
    let reg = load_registry_from(root);
    reg.auto_switch_policies
        .get(&canon)
        .cloned()
        .or_else(|| {
            reg.auto_switch_policies
                .iter()
                .find(|(k, _)| same_provider(k, &canon))
                .map(|(_, v)| v.clone())
        })
        .unwrap_or_default()
}

pub(crate) fn save_auto_switch_policy_in(
    root: &Path,
    provider: &str,
    policy: AutoSwitchPolicy,
) -> Result<AutoSwitchPolicy, String> {
    let canon = canon_provider(provider);
    if canon.trim().is_empty() {
        return Err("Provider cannot be empty.".to_string());
    }
    let normalized = validate_and_normalize_auto_switch_policy(policy)?;

    let _guard = REGISTRY_LOCK.lock().unwrap();
    let mut reg = load_registry_from(root);
    reg.auto_switch_policies.retain(|k, _| !same_provider(k, &canon));
    reg.auto_switch_policies.insert(canon, normalized.clone());
    save_registry_to(root, &reg)?;
    Ok(normalized)
}

// ---------------------------------------------------------------------------
// Import from a legacy per-install account-profiles tree
// ---------------------------------------------------------------------------

pub(crate) fn copy_tree(src: &Path, dst: &Path) -> Result<(), String> {
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

pub(crate) fn snapshot_account_dirs(root: &Path) -> Vec<(String, String)> {
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

pub(crate) fn merge_profile(registry: &mut AccountProfilesRegistry, incoming: SavedAccountProfile) -> bool {
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
                if !incoming.quota_windows.is_empty() {
                    current.quota_windows = incoming.quota_windows;
                }
                if !incoming.available_model_ids.is_empty() {
                    current.available_model_ids = incoming.available_model_ids;
                    current.models_updated_at_unix_ms = incoming.models_updated_at_unix_ms;
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
                credential_status: None,
                has_refresh_token: false,
                ..Default::default()
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
