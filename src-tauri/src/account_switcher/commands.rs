use crate::logger::log_trace;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use uuid::Uuid;

static SWITCH_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn switch_lock() -> &'static Mutex<()> {
    SWITCH_LOCK.get_or_init(|| Mutex::new(()))
}

const DETECTED_CLI_ACCOUNTS_TTL: Duration = Duration::from_secs(5);

pub(crate) struct DetectedCliAccountsCache {
    ttl: Duration,
    state: Mutex<Option<(Instant, Value)>>,
    fetch_lock: Mutex<()>,
}

impl DetectedCliAccountsCache {
    pub(crate) const fn new(ttl: Duration) -> Self {
        Self {
            ttl,
            state: Mutex::new(None),
            fetch_lock: Mutex::new(()),
        }
    }

    pub(crate) fn get_or_compute(
        &self,
        force_refresh: bool,
        bypass_time_ttl: bool,
        compute: impl FnOnce() -> Value,
    ) -> Value {
        if !force_refresh && !bypass_time_ttl {
            let guard = self.state.lock().unwrap();
            if let Some((cached_at, val)) = guard.as_ref() {
                if cached_at.elapsed() < self.ttl {
                    return val.clone();
                }
            }
        }

        let _singleflight = self.fetch_lock.lock().unwrap();
        if !force_refresh && !bypass_time_ttl {
            let guard = self.state.lock().unwrap();
            if let Some((cached_at, val)) = guard.as_ref() {
                if cached_at.elapsed() < self.ttl {
                    return val.clone();
                }
            }
        }

        let fresh = compute();
        if !bypass_time_ttl {
            *self.state.lock().unwrap() = Some((Instant::now(), fresh.clone()));
        }
        fresh
    }

    pub(crate) fn invalidate(&self) {
        *self.state.lock().unwrap() = None;
    }
}

static DETECTED_CLI_ACCOUNTS_CACHE: OnceLock<DetectedCliAccountsCache> = OnceLock::new();

fn detected_cli_accounts_cache() -> &'static DetectedCliAccountsCache {
    DETECTED_CLI_ACCOUNTS_CACHE
        .get_or_init(|| DetectedCliAccountsCache::new(DETECTED_CLI_ACCOUNTS_TTL))
}

pub(crate) fn invalidate_detected_cli_accounts_cache() {
    detected_cli_accounts_cache().invalidate();
    crate::chat::models::invalidate_thread_providers_cache();
}

use super::quota::{get_cached_live_quota, live_quota_from_status, LiveQuota};
use super::registry::{
    appdata_dir, canon_provider, compute_profile_credential_health, get_auto_switch_policy_in,
    hydrate_profile_credential_health, load_registry, load_registry_from, now_ms,
    profile_storage_dir, profile_storage_dir_in, profiles_root, same_provider,
    save_auto_switch_policy_in, save_registry, save_registry_to, user_home_dir,
    AccountProfilesRegistry, AutoSwitchPolicy, AutoSwitchRuntimeStatus, CachedQuotaWindow,
    SavedAccountProfile, REGISTRY_LOCK,
};
use super::storage::{
    apply_profile_to_active, close_residual_provider_processes_direct, copy_atomic,
    decode_jwt_payload, get_provider_file_mappings, inspect_external_provider_processes,
    probe_live_provider_identity, snapshot_active_to_profile, snapshot_active_to_profile_with,
    write_bytes_atomic, AntigravityCredStore, ExternalProcessInspection, FileMapping,
    LiveAntigravityCredStore, LiveIdentityProbe,
};

pub(crate) fn build_antigravity_auth_telemetry_from_parts(
    cred_details: Option<&crate::quota::AntigravityCredentialIdentity>,
    ide_email: Option<&str>,
    explicit_api_key: bool,
    ambient_gemini_env: bool,
) -> Value {
    let cred_email = cred_details
        .map(|d| d.email.trim().to_string())
        .filter(|s| !s.is_empty());

    let (auth_mode, auth_mode_label) = if explicit_api_key {
        ("api_key_override", "API Key (Anulación explícita)")
    } else if cred_email.is_some() {
        ("oauth", "OAuth (Google)")
    } else {
        ("none", "Sin sesión")
    };

    let ide_email_opt = ide_email.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let split_brain_message = match (&cred_email, &ide_email_opt) {
        (Some(c), Some(i)) if !c.eq_ignore_ascii_case(i) => Some(format!(
            "Credencial del sistema ({c}) no coincide con el estado del IDE ({i}). Cambia de cuenta o vuelve a guardar para sincronizar ambos."
        )),
        (None, Some(i)) => Some(format!(
            "Estado residual del IDE ({i}) sin token OAuth activo en el almacén del sistema."
        )),
        _ => None,
    };

    let has_refresh_token = cred_details.map(|d| d.has_refresh_token).unwrap_or(false);
    let expires_at_ms = cred_details
        .and_then(|d| d.expiry.as_deref())
        .and_then(|raw| {
            raw.trim()
                .parse::<i64>()
                .ok()
                .or_else(|| crate::quota::parse_rfc3339_ms(raw))
        });

    json!({
        "authMode": auth_mode,
        "authModeLabel": auth_mode_label,
        "cliEmail": cred_email,
        "credEmail": cred_email,
        "ideEmail": ide_email_opt,
        "splitBrainWarning": split_brain_message.is_some(),
        "splitBrainMessage": split_brain_message,
        "hasRefreshToken": has_refresh_token,
        "expiresAtMs": expires_at_ms,
        "hasExplicitApiKeyOverride": explicit_api_key,
        "ambientGeminiApiKeyDetected": ambient_gemini_env
    })
}

pub(crate) fn build_antigravity_auth_telemetry(live_ident: Option<&LiveIdentityProbe>) -> Value {
    let raw_cred = crate::quota::read_antigravity_raw_credential();
    let parsed_cred = raw_cred
        .as_deref()
        .and_then(crate::quota::parse_antigravity_credential_blob);
    let fallback_cred_ident = parsed_cred.or_else(|| {
        crate::quota::read_antigravity_credential().map(|(email, name)| {
            crate::quota::AntigravityCredentialIdentity {
                email,
                name,
                auth_method: None,
                has_access_token: false,
                has_refresh_token: false,
                expiry: None,
                source: "gemini:antigravity".to_string(),
            }
        })
    }).or_else(|| {
        live_ident
            .filter(|i| i.source != "Antigravity IDE")
            .map(|i| crate::quota::AntigravityCredentialIdentity {
                email: i.email.clone(),
                name: i.name.clone(),
                auth_method: None,
                has_access_token: false,
                has_refresh_token: false,
                expiry: None,
                source: i.source.clone(),
            })
    });
    let ide_ident = crate::quota::read_antigravity_ide_identity();
    let explicit_api_key = crate::credentials::resolve_explicit_antigravity_api_key().is_some();
    let ambient_gemini_env = std::env::var("GEMINI_API_KEY")
        .ok()
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);

    build_antigravity_auth_telemetry_from_parts(
        fallback_cred_ident.as_ref(),
        ide_ident.as_ref().map(|(e, _)| e.as_str()),
        explicit_api_key,
        ambient_gemini_env,
    )
}

pub(crate) fn apply_capabilities_to_profile(
    p: &mut SavedAccountProfile,
    live_q: Option<&LiveQuota>,
    cached_models: Option<&[String]>,
    models_updated_at: Option<i64>,
) -> bool {
    let mut changed = false;

    if let Some(q) = live_q {
        let email_matches = match (q.email.as_deref(), p.email.as_deref()) {
            (Some(qe), Some(pe)) => qe.eq_ignore_ascii_case(pe),
            (Some(_), None) => false,
            (None, _) => true,
        };
        if email_matches {
            if p.primary_remaining_percent != Some(q.percent)
                || p.primary_reset_at != q.reset_at
                || p.time_until_reset_ms != q.until_ms
                || (q.plan.is_some() && p.plan_name != q.plan)
                || (!q.windows.is_empty() && p.quota_windows != q.windows)
            {
                p.primary_remaining_percent = Some(q.percent);
                p.primary_reset_at = q.reset_at.clone();
                p.time_until_reset_ms = q.until_ms;
                if q.plan.is_some() {
                    p.plan_name = q.plan.clone();
                }
                if !q.windows.is_empty() {
                    p.quota_windows = q.windows.clone();
                }
                changed = true;
            }
        }
    }

    if let Some(models) = cached_models {
        if !models.is_empty() && p.available_model_ids != models {
            p.available_model_ids = models.to_vec();
            p.models_updated_at_unix_ms = Some(models_updated_at.unwrap_or_else(now_ms));
            changed = true;
        }
    }

    changed
}

pub(crate) fn sync_active_profile_capabilities_in(
    root: &Path,
    provider: &str,
    expected_email: Option<&str>,
    live_q: Option<&LiveQuota>,
    cached_models: Option<&[String]>,
    models_updated_at: Option<i64>,
) -> bool {
    let canon = canon_provider(provider);
    let _guard = REGISTRY_LOCK.lock().unwrap();
    let mut reg = load_registry_from(root);
    let mut changed = false;

    for p in &mut reg.profiles {
        if !same_provider(&p.provider, &canon) || !p.is_active {
            continue;
        }
        if let Some(exp) = expected_email {
            if let Some(ref pe) = p.email {
                if !exp.eq_ignore_ascii_case(pe) {
                    continue;
                }
            }
        }
        if apply_capabilities_to_profile(p, live_q, cached_models, models_updated_at) {
            changed = true;
        }
    }

    if changed {
        let _ = save_registry_to(root, &reg);
    }
    changed
}

#[cfg_attr(test, allow(dead_code))]
pub(crate) fn record_active_quota_snapshot_for_provider(
    quota_provider_key: &str,
    status: &crate::quota::ProviderQuotaStatus,
) {
    if !status.is_available {
        return;
    }
    let canon = canon_provider(quota_provider_key);
    let live_q = live_quota_from_status(status);
    let expected_email = live_q.email.as_deref();
    let cached_models = if canon == "agy" {
        crate::chat::models::cached_provider_model_ids("antigravity")
    } else {
        Vec::new()
    };
    let models_slice = (!cached_models.is_empty()).then_some(cached_models.as_slice());
    let models_ts = models_slice.map(|_| now_ms());
    let _ = sync_active_profile_capabilities_in(
        &profiles_root(),
        &canon,
        expected_email,
        Some(&live_q),
        models_slice,
        models_ts,
    );
}

pub(crate) fn reconcile_live_identity_with_models(
    reg: &mut AccountProfilesRegistry,
    probe_target: &str,
    live_ident: Option<&LiveIdentityProbe>,
    live_q: Option<&LiveQuota>,
    cached_models: Option<&[String]>,
    models_updated_at: Option<i64>,
) -> (bool, Option<Value>) {
    let mut changed = false;
    let mut unregistered_live_session: Option<Value> = None;

    let authoritative_email = live_ident
        .map(|i| i.email.clone())
        .or_else(|| live_q.and_then(|q| q.email.clone()));

    if let Some(ref live_email) = authoritative_email {
        let matching_idx = reg.profiles.iter().position(|p| {
            same_provider(&p.provider, probe_target)
                && p.email
                    .as_ref()
                    .map_or(false, |e| e.eq_ignore_ascii_case(live_email))
        });

        let quota_matches_live = live_q.and_then(|q| match q.email.as_deref() {
            Some(q_email) if !q_email.eq_ignore_ascii_case(live_email) => None,
            _ => Some(q),
        });

        if let Some(idx) = matching_idx {
            for (i, p) in reg.profiles.iter_mut().enumerate() {
                if same_provider(&p.provider, probe_target) {
                    let should_be_active = i == idx;
                    if p.is_active != should_be_active {
                        p.is_active = should_be_active;
                        if should_be_active {
                            p.last_used_unix_ms = now_ms();
                        }
                        changed = true;
                    }
                    if should_be_active
                        && apply_capabilities_to_profile(
                            p,
                            quota_matches_live,
                            cached_models,
                            models_updated_at,
                        )
                    {
                        changed = true;
                    }
                }
            }
        } else {
            // The live account does not match any profile in the vault.
            for p in &mut reg.profiles {
                if same_provider(&p.provider, probe_target) && p.is_active {
                    p.is_active = false;
                    changed = true;
                }
            }
            unregistered_live_session = Some(json!({
                "provider": probe_target,
                "email": live_email,
                "name": live_ident.and_then(|i| i.name.clone()),
                "source": live_ident.map(|i| i.source.clone()),
                "planName": quota_matches_live.and_then(|q| q.plan.clone()),
                "primaryRemainingPercent": quota_matches_live.map(|q| q.percent),
                "primaryResetAt": quota_matches_live.and_then(|q| q.reset_at.clone()),
                "timeUntilResetMs": quota_matches_live.and_then(|q| q.until_ms),
            }));
        }
    } else {
        // Signed out / no live identity detected: clear stale active flags cleanly.
        for p in &mut reg.profiles {
            if same_provider(&p.provider, probe_target) && p.is_active {
                p.is_active = false;
                changed = true;
            }
        }
    }

    (changed, unregistered_live_session)
}

pub(crate) fn reconcile_live_identity_with_registry(
    reg: &mut AccountProfilesRegistry,
    probe_target: &str,
    live_ident: Option<&LiveIdentityProbe>,
    live_q: Option<&LiveQuota>,
) -> (bool, Option<Value>) {
    reconcile_live_identity_with_models(reg, probe_target, live_ident, live_q, None, None)
}

fn resolve_live_identity_and_quota(
    probe_target: &str,
) -> (Option<LiveIdentityProbe>, Option<LiveQuota>, Vec<String>) {
    let quota_key = if probe_target == "agy" {
        "antigravity"
    } else {
        probe_target
    };
    let live_ident = probe_live_provider_identity(probe_target);
    let mut live_q = get_cached_live_quota(probe_target);
    if let Some(ref ident) = live_ident {
        if let Some(ref q) = live_q {
            if let Some(ref cached_email) = q.email {
                if !cached_email.eq_ignore_ascii_case(&ident.email) {
                    crate::quota::invalidate_provider_cache(quota_key);
                    live_q = None;
                }
            }
        }
    } else if live_q
        .as_ref()
        .and_then(|q| q.email.as_ref())
        .is_some()
    {
        crate::quota::invalidate_provider_cache(quota_key);
        live_q = None;
    }

    let cached_models = if probe_target == "agy" && !cfg!(test) {
        crate::chat::models::cached_provider_model_ids("antigravity")
    } else {
        Vec::new()
    };

    (live_ident, live_q, cached_models)
}

pub fn list_saved_accounts_direct(request: Option<Value>) -> Value {
    let req = crate::persist::body(&request);
    let provider = req
        .and_then(|r| r.get("provider"))
        .and_then(|v| v.as_str())
        .map(String::from);

    let canon_prov = provider.as_deref().map(canon_provider);
    let probe_target = canon_prov.clone().unwrap_or_else(|| "agy".to_string());

    // Direct synchronous live OS identity + cached quota + non-blocking cached models.
    let (live_ident, live_q, cached_models) = resolve_live_identity_and_quota(&probe_target);
    let models_slice = (!cached_models.is_empty()).then_some(cached_models.as_slice());
    let models_ts = models_slice.map(|_| now_ms());

    // Phase 2: reconcile live identity with registry (short lock).
    let (filtered, unregistered_live_session) = {
        let _guard = REGISTRY_LOCK.lock().unwrap();
        let mut reg = load_registry();
        let (changed, unregistered_live_session_inner) = reconcile_live_identity_with_models(
            &mut reg,
            &probe_target,
            live_ident.as_ref(),
            live_q.as_ref(),
            models_slice,
            models_ts,
        );

        if changed {
            save_registry(&reg);
        }

        let filtered: Vec<SavedAccountProfile> = match canon_prov.as_deref() {
            Some(p) => reg
                .profiles
                .into_iter()
                .filter(|a| same_provider(&a.provider, p))
                .collect(),
            None => reg.profiles,
        };
        (filtered, unregistered_live_session_inner)
    };

    // Slow OS keyring / IDE SQLite / vault telemetry reads run outside REGISTRY_LOCK.
    let auth_telemetry = if probe_target == "agy" {
        build_antigravity_auth_telemetry(live_ident.as_ref())
    } else {
        Value::Null
    };

    json!({
        "schemaVersion": 1,
        "profiles": filtered,
        "unregisteredLiveSession": unregistered_live_session,
        "authTelemetry": auth_telemetry
    })
}

pub async fn list_saved_accounts_impl(request: Option<Value>) -> Value {
    tokio::task::spawn_blocking(move || list_saved_accounts_direct(request))
        .await
        .unwrap_or_else(|_| {
            json!({
                "schemaVersion": 1,
                "profiles": [],
                "unregisteredLiveSession": Value::Null,
                "authTelemetry": Value::Null
            })
        })
}

pub(crate) fn cleanup_stale_login_rollback(root: &Path, provider: &str) {
    let dir = root.join("_login_rollback").join(canon_provider(provider));
    if dir.exists() {
        let _ = fs::remove_dir_all(&dir);
    }
}

pub(crate) fn save_account_profile_with(
    root: &Path,
    provider: &str,
    label: String,
    mappings: &[FileMapping],
    state_vscdb: Option<&Path>,
    cred_store: &dyn AntigravityCredStore,
    live_ident: Option<LiveIdentityProbe>,
    live_q: Option<LiveQuota>,
) -> Value {
    let provider = canon_provider(provider);
    if mappings.is_empty() && provider != "agy" {
        return json!({ "success": false, "error": format!("Proveedor no soportado: {provider}") });
    }

    if provider == "agy" && live_ident.is_none() {
        return json!({
            "success": false,
            "error": "No se detectó una sesión activa de Antigravity en el sistema (gemini:antigravity). Inicia sesión primero."
        });
    }

    let email = live_ident
        .as_ref()
        .map(|i| i.email.clone())
        .or_else(|| live_q.as_ref().and_then(|q| q.email.clone()));

    let (plan_name, primary_remaining_percent, primary_reset_at, time_until_reset_ms, quota_windows) =
        match live_q {
            Some(q) => (q.plan, Some(q.percent), q.reset_at, q.until_ms, q.windows),
            None => (None, None, None, None, Vec::new()),
        };

    let (account_id, had_existing) = {
        let _guard = REGISTRY_LOCK.lock().unwrap();
        let reg = load_registry_from(root);

        // Match strictly by email against reg.profiles
        let existing_idx = if let Some(ref em) = email {
            reg.profiles.iter().position(|p| {
                same_provider(&p.provider, &provider)
                    && p.email.as_ref().map_or(false, |e| e.eq_ignore_ascii_case(em))
            })
        } else {
            None
        };

        if let Some(idx) = existing_idx {
            (reg.profiles[idx].id.clone(), true)
        } else {
            (Uuid::new_v4().to_string(), false)
        }
    };

    // 1. Snapshot files to account storage outside REGISTRY_LOCK; refuse empty/tokenless profiles.
    match snapshot_active_to_profile_with(
        root,
        &provider,
        &account_id,
        mappings,
        state_vscdb,
        cred_store,
    ) {
        Ok(true) => {}
        Ok(false) => {
            if !had_existing {
                let _ = fs::remove_dir_all(profile_storage_dir_in(root, &provider, &account_id));
            }
            return json!({
                "success": false,
                "error": "No se encontraron archivos de sesión para guardar. ¿Iniciaste sesión en este proveedor?"
            });
        }
        Err(err) => {
            if !had_existing {
                let _ = fs::remove_dir_all(profile_storage_dir_in(root, &provider, &account_id));
            }
            return json!({
                "success": false,
                "error": err
            });
        }
    }

    let now = now_ms();
    let profile = {
        let _guard = REGISTRY_LOCK.lock().unwrap();
        let mut reg = load_registry_from(root);
        let existing_idx = reg
            .profiles
            .iter()
            .position(|p| same_provider(&p.provider, &provider) && p.id == account_id)
            .or_else(|| {
                email.as_ref().and_then(|em| {
                    reg.profiles.iter().position(|p| {
                        same_provider(&p.provider, &provider)
                            && p.email.as_ref().map_or(false, |e| e.eq_ignore_ascii_case(em))
                    })
                })
            });

        // Other accounts for this provider are no longer active.
        for p in &mut reg.profiles {
            if same_provider(&p.provider, &provider) {
                p.is_active = false;
            }
        }

        let profile = if let Some(idx) = existing_idx {
            let p = &mut reg.profiles[idx];
            let trimmed_label = label.trim();
            if !trimmed_label.is_empty() {
                // Preserve a user-chosen label (e.g. "Personal Pro") when auto-save passes the raw email.
                let existing_is_custom = !p.label.trim().is_empty()
                    && email
                        .as_deref()
                        .map_or(true, |em| !p.label.trim().eq_ignore_ascii_case(em));
                let incoming_is_raw_email = email
                    .as_deref()
                    .map_or(false, |em| trimmed_label.eq_ignore_ascii_case(em));
                if !(existing_is_custom && incoming_is_raw_email) {
                    p.label = trimmed_label.to_string();
                }
            }
            if email.is_some() {
                p.email = email;
            }
            if plan_name.is_some() {
                p.plan_name = plan_name;
            }
            p.is_active = true;
            p.last_used_unix_ms = now;
            if primary_remaining_percent.is_some() {
                p.primary_remaining_percent = primary_remaining_percent;
                p.primary_reset_at = primary_reset_at;
                p.time_until_reset_ms = time_until_reset_ms;
            }
            if !quota_windows.is_empty() {
                p.quota_windows = quota_windows;
            }
            hydrate_profile_credential_health(root, std::slice::from_mut(p));
            p.clone()
        } else {
            let mut new_prof = SavedAccountProfile {
                id: account_id.clone(),
                provider: provider.clone(),
                label: if label.trim().is_empty() {
                    email
                        .clone()
                        .unwrap_or_else(|| format!("{provider} Profile"))
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
                credential_status: None,
                has_refresh_token: false,
                quota_windows,
                ..Default::default()
            };
            hydrate_profile_credential_health(root, std::slice::from_mut(&mut new_prof));
            reg.profiles.push(new_prof.clone());
            new_prof
        };

        if let Err(err) = save_registry_to(root, &reg) {
            return json!({
                "success": false,
                "error": err
            });
        }
        profile
    };

    if provider == "agy" {
        cleanup_stale_login_rollback(root, "agy");
    }
    invalidate_detected_cli_accounts_cache();

    log_trace(&format!(
        "account_switcher: Saved profile {} for provider {}",
        account_id, provider
    ));

    json!({
        "success": true,
        "profile": profile
    })
}

pub fn save_current_account_profile_direct(provider: String, label: String) -> Value {
    let _switch_guard = switch_lock().lock().unwrap();
    let provider = canon_provider(&provider);
    let mappings = get_provider_file_mappings(&provider);
    if mappings.is_empty() && provider != "agy" {
        return json!({ "success": false, "error": format!("Proveedor no soportado: {provider}") });
    }

    let live_ident = probe_live_provider_identity(&provider);
    if provider == "agy" && live_ident.is_none() {
        return json!({
            "success": false,
            "error": "No se detectó una sesión activa de Antigravity en el sistema (gemini:antigravity). Inicia sesión primero."
        });
    }

    let quota_key = if provider == "agy" { "antigravity" } else { &provider };
    let mut live_q = get_cached_live_quota(&provider);
    if let Some(ref ident) = live_ident {
        if let Some(ref q) = live_q {
            if let Some(ref cached_email) = q.email {
                if !cached_email.eq_ignore_ascii_case(&ident.email) {
                    crate::quota::invalidate_provider_cache(quota_key);
                    live_q = None;
                }
            }
        }
    } else if live_q
        .as_ref()
        .and_then(|q| q.email.as_ref())
        .is_some()
    {
        crate::quota::invalidate_provider_cache(quota_key);
        live_q = None;
    }

    let state_vscdb = if provider == "agy" {
        crate::quota::find_existing_state_vscdb()
    } else {
        None
    };

    let cached_models = if provider == "agy" && !cfg!(test) {
        crate::chat::models::cached_provider_model_ids("antigravity")
    } else {
        Vec::new()
    };
    let expected_email = live_ident.as_ref().map(|i| i.email.clone());

    let res = save_account_profile_with(
        &profiles_root(),
        &provider,
        label,
        &mappings,
        state_vscdb.as_deref(),
        &LiveAntigravityCredStore,
        live_ident,
        live_q,
    );

    if res.get("success").and_then(Value::as_bool) == Some(true) && !cached_models.is_empty() {
        let _ = sync_active_profile_capabilities_in(
            &profiles_root(),
            &provider,
            expected_email.as_deref(),
            None,
            Some(&cached_models),
            Some(now_ms()),
        );
    }

    res
}

pub async fn save_current_account_profile_impl(request: Option<Value>) -> Value {
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
    tauri::async_runtime::spawn_blocking(move || save_current_account_profile_direct(provider, label))
        .await
        .unwrap_or_else(|e| json!({ "success": false, "error": format!("Worker task failed: {e}") }))
}

pub(crate) fn validate_profile_switch_ready_in(
    root: &std::path::Path,
    provider: &str,
    account_id: &str,
) -> Result<(), String> {
    let canon = canon_provider(provider);
    let src_dir = root.join(&canon).join(account_id);
    if canon == "agy" {
        let cred_file = src_dir.join("gemini_antigravity_cred.json");
        if !cred_file.exists() {
            return Err("El perfil seleccionado no contiene credenciales válidas de Antigravity (gemini_antigravity_cred.json). Vuelve a iniciar sesión con esa cuenta y guárdala.".to_string());
        }
        let raw = fs::read_to_string(&cred_file)
            .map_err(|e| format!("No se pudo leer gemini_antigravity_cred.json: {e}"))?;
        crate::quota::parse_antigravity_credential_with_tokens(&raw).map_err(|code| match code {
            "missing_tokens" => "El perfil seleccionado no contiene tokens OAuth válidos (access_token o refresh_token). Vuelve a iniciar sesión con esa cuenta y guárdala.".to_string(),
            _ => "El archivo de credenciales de Antigravity está dañado o no contiene una identidad válida.".to_string(),
        })?;
        let ide_snap_path = src_dir.join("ide_auth_state.json");
        if ide_snap_path.is_file() {
            let ide_raw = fs::read_to_string(&ide_snap_path)
                .map_err(|e| format!("No se pudo leer ide_auth_state.json: {e}"))?;
            serde_json::from_str::<crate::quota::IdeAuthStateSnapshot>(&ide_raw)
                .map_err(|e| format!("ide_auth_state.json está corrupto: {e}"))?;
        }
        return Ok(());
    }

    let mappings = get_provider_file_mappings(&canon);
    if !mappings.iter().any(|m| src_dir.join(m.rel_dest).exists()) {
        return Err("El perfil guardado no contiene archivos de sesión.".to_string());
    }
    Ok(())
}

pub(crate) fn provider_busy_payload(external: &ExternalProcessInspection) -> Value {
    json!({
        "success": false,
        "code": "PROVIDER_BUSY",
        "error": external.message,
        "providerBusyKind": external.state,
        "canCloseProcesses": external.can_close_processes,
        "residualProcessCount": external.residual_processes.len(),
        "residualProcesses": external.residual_processes,
        "baseAppTitles": external.base_app_titles,
    })
}

pub(crate) fn switch_preflight_check_with(
    root: &std::path::Path,
    provider: &str,
    account_id: &str,
    force: bool,
    idle_check: Result<(), String>,
    inspection: &crate::terminal::ProviderSessionsInspection,
) -> Option<Value> {
    // 1. Validate target profile credential material BEFORE external process or PTY touches.
    if let Err(err) = validate_profile_switch_ready_in(root, provider, account_id) {
        return Some(json!({
            "success": false,
            "code": "INVALID_TARGET_PROFILE",
            "error": err,
        }));
    }

    // 2. Fail closed if an external IDE/CLI instance holds locks.
    if let Err(msg) = idle_check {
        return Some(json!({
            "success": false,
            "code": "PROVIDER_BUSY",
            "error": msg,
        }));
    }

    // 3. Guard against interrupting active Kite terminal turns unless confirmed with `force`.
    if !force && !inspection.managed_busy.is_empty() {
        return Some(json!({
            "success": false,
            "code": "CONFIRM_BUSY_TERMINALS",
            "error": "Hay terminales activas ejecutando una respuesta en este proveedor.",
            "busySessions": inspection.managed_busy,
            "managedIdleCount": inspection.managed_idle.len(),
            "unaffectedTerminalsCount": inspection.unaffected_terminals_count,
        }));
    }

    None
}

pub(crate) fn switch_preflight_check_with_external(
    root: &std::path::Path,
    provider: &str,
    account_id: &str,
    force: bool,
    external: &ExternalProcessInspection,
    inspection: &crate::terminal::ProviderSessionsInspection,
) -> Option<Value> {
    if let Some(mut rejection) = switch_preflight_check_with(
        root,
        provider,
        account_id,
        force,
        external.to_idle_result(),
        inspection,
    ) {
        if rejection.get("code").and_then(|v| v.as_str()) == Some("PROVIDER_BUSY") {
            rejection = provider_busy_payload(external);
        }
        return Some(rejection);
    }
    None
}

pub fn switch_account_profile_direct(provider: String, account_id: String) -> Value {
    switch_account_profile_direct_with_options(provider, account_id, false)
}

pub fn switch_account_profile_direct_with_options(
    provider: String,
    account_id: String,
    force: bool,
) -> Value {
    let _switch_guard = switch_lock().lock().unwrap();
    let provider = canon_provider(&provider);

    {
        let _guard = REGISTRY_LOCK.lock().unwrap();
        let reg = load_registry();
        let exists = reg
            .profiles
            .iter()
            .any(|p| same_provider(&p.provider, &provider) && p.id == account_id);
        if !exists {
            return json!({ "success": false, "error": "Profile not found" });
        }
    }

    // Preflight strictly in order (target validity -> external client lock -> managed busy PTYs)
    // OUTSIDE REGISTRY_LOCK BEFORE touching or terminating any Kite terminal.
    let external = inspect_external_provider_processes(&provider);
    let inspection = crate::terminal::inspect_provider_sessions(&provider);
    if let Some(rejection) = switch_preflight_check_with_external(
        &profiles_root(),
        &provider,
        &account_id,
        force,
        &external,
        &inspection,
    ) {
        return rejection;
    }

    // 0. Quiesce only Kite-managed terminals matching `provider`.
    let quiesced_terminals = crate::terminal::quiesce_provider_terminals(&provider);
    let targeted_session_ids: Vec<String> = quiesced_terminals
        .iter()
        .map(|q| q.session_id.clone())
        .collect();
    let skipped_unaffected_count = inspection.unaffected_terminals_count;

    // 1. Snapshot latest outgoing profile metadata under brief REGISTRY_LOCK, then snapshot files outside it.
    let live_ident = probe_live_provider_identity(&provider);
    let (matching_live_prof_id, active_prof_id, rollback_label, rollback_email) = {
        let _guard = REGISTRY_LOCK.lock().unwrap();
        let reg = load_registry();
        let matching_live = live_ident.as_ref().and_then(|ident| {
            reg.profiles
                .iter()
                .find(|p| {
                    same_provider(&p.provider, &provider)
                        && p.email
                            .as_ref()
                            .map_or(false, |e| e.eq_ignore_ascii_case(&ident.email))
                })
                .map(|p| p.id.clone())
        });
        let active_prof = reg
            .profiles
            .iter()
            .find(|p| same_provider(&p.provider, &provider) && p.is_active);
        let active_id = active_prof.map(|p| p.id.clone());
        let rb_label = active_prof
            .map(|p| p.label.clone())
            .unwrap_or_else(|| "Actual".to_string());
        let rb_email = active_prof.and_then(|p| p.email.clone());
        (matching_live, active_id, rb_label, rb_email)
    };

    if let Some(ref ident) = live_ident {
        if let Some(live_prof_id) = matching_live_prof_id {
            if live_prof_id != account_id {
                if let Err(err) = snapshot_active_to_profile(&provider, &live_prof_id) {
                    log_trace(&format!(
                        "account_switcher: could not snapshot outgoing profile {}: {}",
                        live_prof_id, err
                    ));
                }
            }
        } else {
            // Live session is unregistered: back up into _backups without overwriting any vault profile!
            let safe_email = ident.email.replace(|c: char| !c.is_alphanumeric() && c != '@' && c != '.', "_");
            let backup_dir = profiles_root()
                .join("_backups")
                .join(&provider)
                .join(format!("unregistered_{}_{}", safe_email, now_ms()));
            let _ = fs::create_dir_all(&backup_dir);
            for m in get_provider_file_mappings(&provider) {
                if m.source.exists() {
                    let _ = copy_atomic(&m.source, &backup_dir.join(m.rel_dest));
                }
            }
            if provider == "agy" {
                if let Some(raw) = crate::quota::read_antigravity_raw_credential() {
                    let _ = fs::write(backup_dir.join("gemini_antigravity_cred.json"), raw);
                }
            }
        }
    } else if let Some(active_id) = active_prof_id {
        if active_id != account_id {
            if let Err(err) = snapshot_active_to_profile(&provider, &active_id) {
                log_trace(&format!(
                    "account_switcher: could not snapshot active outgoing profile {}: {}",
                    active_id, err
                ));
            }
        }
    }

    // 2. Transactional restore outside REGISTRY_LOCK (backs up current state, rolls back on failure).
    if let Err(e) = apply_profile_to_active(&provider, &account_id) {
        log_trace(&format!("account_switcher: switch failed: {e}"));
        crate::terminal::respawn_provider_terminals(
            &provider,
            &rollback_label,
            rollback_email.as_deref(),
            &quiesced_terminals,
        );
        return json!({ "success": false, "error": e });
    }

    // 3. Update active flags and last_used atomically under brief REGISTRY_LOCK.
    let activated_profile = {
        let _guard = REGISTRY_LOCK.lock().unwrap();
        let mut reg = load_registry();
        let Some(idx) = reg
            .profiles
            .iter()
            .position(|p| same_provider(&p.provider, &provider) && p.id == account_id)
        else {
            return json!({ "success": false, "error": "Profile not found" });
        };

        for p in &mut reg.profiles {
            if same_provider(&p.provider, &provider) {
                p.is_active = p.id == account_id;
                if p.is_active {
                    p.last_used_unix_ms = now_ms();
                }
            }
        }

        hydrate_profile_credential_health(&profiles_root(), std::slice::from_mut(&mut reg.profiles[idx]));
        let activated = reg.profiles[idx].clone();
        // sibling sync decoupled
        save_registry(&reg);
        activated
    };

    // Invalidate quota cache, detected CLI account cache, and warm chat/model caches
    // so subsequent queries never use the previous account's state.
    let canon = canon_provider(&provider);
    let quota_key = match canon.as_str() {
        "agy" => "antigravity",
        other => other,
    };
    crate::quota::invalidate_provider_cache(quota_key);
    crate::quota::invalidate_provider_cache(&provider);
    crate::chat::runtime::state::evict_provider_runtime_state(quota_key);
    invalidate_detected_cli_accounts_cache();

    // 4. Respawn the quiesced terminals with the new account's credentials!
    crate::terminal::respawn_provider_terminals(
        &provider,
        &activated_profile.label,
        activated_profile.email.as_deref(),
        &quiesced_terminals,
    );

    log_trace(&format!(
        "account_switcher: Switched to profile {} ({}) for provider {} (restarted {} terminals)",
        account_id, activated_profile.label, provider, quiesced_terminals.len()
    ));

    let auth_telemetry = if canon == "agy" {
        let post_ident = probe_live_provider_identity("agy");
        build_antigravity_auth_telemetry(post_ident.as_ref())
    } else {
        Value::Null
    };

    json!({
        "success": true,
        "profile": activated_profile,
        "terminalsRestarted": quiesced_terminals.len(),
        "targetedSessionIds": targeted_session_ids,
        "skippedUnaffectedCount": skipped_unaffected_count,
        "authTelemetry": auth_telemetry
    })
}

pub async fn switch_account_profile_impl(request: Option<Value>) -> Value {
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
    let force = req
        .and_then(|r| r.get("force"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let provider_for_reset = provider.clone();
    tokio::task::spawn_blocking(move || {
        let res = switch_account_profile_direct_with_options(provider, account_id, force);
        if res
            .get("success")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            super::auto_switch::reset_auto_switch_state_on_manual_switch(&provider_for_reset);
        }
        res
    })
    .await
    .unwrap_or_else(|e| {
        json!({
            "success": false,
            "error": format!("Worker task failed: {e}")
        })
    })
}

pub async fn inspect_provider_sessions_impl(request: Option<Value>) -> Value {
    let req = crate::persist::body(&request);
    let provider = req
        .and_then(|r| r.get("provider"))
        .and_then(|v| v.as_str())
        .unwrap_or("antigravity")
        .to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let report = crate::terminal::inspect_provider_sessions(&provider);
        serde_json::to_value(report).unwrap_or_else(|_| {
            json!({
                "managedIdle": [],
                "managedBusy": [],
                "externalBlocking": [],
                "unaffectedTerminalsCount": 0
            })
        })
    })
    .await
    .unwrap_or_else(|_| {
        json!({
            "managedIdle": [],
            "managedBusy": [],
            "externalBlocking": [],
            "unaffectedTerminalsCount": 0
        })
    })
}

pub async fn close_residual_provider_processes_impl(request: Option<Value>) -> Value {
    let req = crate::persist::body(&request);
    let provider = req
        .and_then(|r| r.get("provider"))
        .and_then(|v| v.as_str())
        .unwrap_or("antigravity")
        .to_string();
    tauri::async_runtime::spawn_blocking(move || close_residual_provider_processes_direct(provider))
        .await
        .unwrap_or_else(|e| json!({ "success": false, "error": format!("Worker task failed: {e}") }))
}

pub fn delete_account_profile_direct(provider: &str, account_id: &str) -> Value {
    let provider = canon_provider(provider);
    let removed = {
        let _guard = REGISTRY_LOCK.lock().unwrap();
        let mut reg = load_registry();

        let before_len = reg.profiles.len();
        reg.profiles
            .retain(|p| !(same_provider(&p.provider, &provider) && p.id == account_id));

        if reg.profiles.len() < before_len {
            let dir = profile_storage_dir(&provider, account_id);
            let _ = fs::remove_dir_all(dir);
            save_registry(&reg);
            true
        } else {
            false
        }
    };

    if removed {
        invalidate_detected_cli_accounts_cache();
        json!({ "success": true })
    } else {
        json!({ "success": false, "error": "Profile not found" })
    }
}

pub async fn delete_account_profile_impl(request: Option<Value>) -> Value {
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
    tauri::async_runtime::spawn_blocking(move || delete_account_profile_direct(&provider, &account_id))
        .await
        .unwrap_or_else(|e| json!({ "success": false, "error": format!("Worker task failed: {e}") }))
}

pub fn rename_account_profile_with(
    root: &Path,
    provider: &str,
    account_id: &str,
    label: String,
) -> Value {
    let trimmed = label.trim();
    if trimmed.is_empty() {
        return json!({
            "success": false,
            "error": "El nombre del perfil no puede estar vacío."
        });
    }

    let canon_p = canon_provider(provider);
    let updated_profile = {
        let _guard = REGISTRY_LOCK.lock().unwrap();
        let mut reg = load_registry_from(root);

        let Some(idx) = reg
            .profiles
            .iter()
            .position(|p| same_provider(&p.provider, &canon_p) && p.id == account_id)
        else {
            return json!({ "success": false, "error": "Profile not found" });
        };

        reg.profiles[idx].label = trimmed.to_string();
        hydrate_profile_credential_health(root, std::slice::from_mut(&mut reg.profiles[idx]));
        let updated_profile = reg.profiles[idx].clone();

        if let Err(err) = save_registry_to(root, &reg) {
            return json!({ "success": false, "error": err });
        }
        updated_profile
    };

    invalidate_detected_cli_accounts_cache();

    log_trace(&format!(
        "account_switcher: Renamed profile {} ({}) for provider {}",
        account_id, updated_profile.label, canon_p
    ));

    json!({
        "success": true,
        "profile": updated_profile
    })
}

pub fn rename_account_profile_direct(
    provider: String,
    account_id: String,
    label: String,
) -> Value {
    rename_account_profile_with(&profiles_root(), &provider, &account_id, label)
}

pub async fn rename_account_profile_impl(request: Option<Value>) -> Value {
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
    let label = req
        .and_then(|r| r.get("label"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    tauri::async_runtime::spawn_blocking(move || {
        rename_account_profile_direct(provider, account_id, label)
    })
    .await
    .unwrap_or_else(|e| json!({ "success": false, "error": format!("Worker task failed: {e}") }))
}

pub fn get_active_account_profile_direct(provider: &str) -> Value {
    let canon_p = canon_provider(provider);

    let (live_ident, live_q, cached_models) = resolve_live_identity_and_quota(&canon_p);
    let models_slice = (!cached_models.is_empty()).then_some(cached_models.as_slice());
    let models_ts = models_slice.map(|_| now_ms());

    let (active_profile, unregistered_live_session) = {
        let _guard = REGISTRY_LOCK.lock().unwrap();
        let mut reg = load_registry();
        let (changed, unregistered_live_session) = reconcile_live_identity_with_models(
            &mut reg,
            &canon_p,
            live_ident.as_ref(),
            live_q.as_ref(),
            models_slice,
            models_ts,
        );
        if changed {
            save_registry(&reg);
        }

        let active_profile = reg
            .profiles
            .into_iter()
            .find(|p| same_provider(&p.provider, &canon_p) && p.is_active);
        (active_profile, unregistered_live_session)
    };

    // Slow OS keyring / IDE SQLite / vault telemetry reads run outside REGISTRY_LOCK.
    let auth_telemetry = if canon_p == "agy" {
        build_antigravity_auth_telemetry(live_ident.as_ref())
    } else {
        Value::Null
    };

    if let Some(profile) = active_profile {
        json!({
            "found": true,
            "profile": profile,
            "authTelemetry": auth_telemetry
        })
    } else {
        json!({
            "found": false,
            "unregisteredLiveSession": unregistered_live_session,
            "authTelemetry": auth_telemetry
        })
    }
}

pub async fn get_active_account_profile_impl(request: Option<Value>) -> Value {
    let req = crate::persist::body(&request);
    let provider = req
        .and_then(|r| r.get("provider"))
        .and_then(|v| v.as_str())
        .unwrap_or("agy")
        .to_string();
    tauri::async_runtime::spawn_blocking(move || get_active_account_profile_direct(&provider))
        .await
        .unwrap_or_else(|_| {
            json!({
                "found": false,
                "unregisteredLiveSession": Value::Null,
                "authTelemetry": Value::Null
            })
        })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RankedSwitchCandidate {
    pub profile: SavedAccountProfile,
    pub compatibility: String,
    pub requested_model: Option<String>,
    pub suggested_fallback_model: Option<String>,
    pub available_target_models: Vec<String>,
    pub source_plan: Option<String>,
    pub target_plan: Option<String>,
    pub remaining_percent: Option<f64>,
    pub known_healthy_quota: bool,
    pub quota_confidence: u8,
    pub relevant_window_name: Option<String>,
}

fn strip_model_effort_suffix(model: &str) -> &str {
    for suffix in ["-xhigh", "-minimal", "-medium", "-ultra", "-high", "-low", "-max"] {
        if let Some(stripped) = model.strip_suffix(suffix) {
            return stripped;
        }
    }
    model
}

fn models_match_exact_or_base(candidate_id: &str, requested_model: &str) -> bool {
    if candidate_id.eq_ignore_ascii_case(requested_model) {
        return true;
    }
    let cand_base = strip_model_effort_suffix(candidate_id.trim());
    let req_base = strip_model_effort_suffix(requested_model.trim());
    cand_base.eq_ignore_ascii_case(req_base)
}

fn relevant_quota_window<'a>(
    windows: &'a [CachedQuotaWindow],
    requested_model: Option<&str>,
) -> Option<&'a CachedQuotaWindow> {
    if windows.is_empty() {
        return None;
    }
    let Some(req) = requested_model.map(str::trim).filter(|s| !s.is_empty()) else {
        return windows
            .iter()
            .find(|w| w.name.eq_ignore_ascii_case("Primary Quota"))
            .or_else(|| (windows.len() == 1).then_some(&windows[0]));
    };
    let lower = req.to_ascii_lowercase();
    if lower.contains("claude") || lower.contains("sonnet") || lower.contains("opus") || lower.contains("haiku") {
        if let Some(w) = windows.iter().find(|w| {
            let n = w.name.to_ascii_lowercase();
            n.contains("claude") || n.contains("sonnet") || n.contains("opus") || n.contains("haiku")
        }) {
            return Some(w);
        }
    }
    if lower.contains("flash") {
        if let Some(w) = windows
            .iter()
            .find(|w| w.name.to_ascii_lowercase().contains("flash"))
        {
            return Some(w);
        }
    }
    if lower.contains("gemini") {
        if let Some(w) = windows.iter().find(|w| {
            let n = w.name.to_ascii_lowercase();
            (n.contains("gemini") || n.contains("pro")) && !n.contains("flash")
        }) {
            return Some(w);
        }
        if let Some(w) = windows
            .iter()
            .find(|w| w.name.to_ascii_lowercase().contains("gemini"))
        {
            return Some(w);
        }
    }
    if lower.contains("gpt") || lower.contains("openai") {
        if let Some(w) = windows.iter().find(|w| {
            let n = w.name.to_ascii_lowercase();
            n.contains("gpt") || n.contains("openai")
        }) {
            return Some(w);
        }
    }
    None
}

fn is_window_reset_elapsed(w: &CachedQuotaWindow, now_unix_ms: i64) -> bool {
    w.time_until_reset_ms.unwrap_or(0) > 0
        && w.updated_at_unix_ms > 0
        && now_unix_ms >= w.updated_at_unix_ms.saturating_add(w.time_until_reset_ms.unwrap_or(0))
}

fn is_window_healthy(w: &CachedQuotaWindow, threshold: f64, now_unix_ms: i64) -> bool {
    (!w.is_exhausted && w.remaining_percent > threshold) || is_window_reset_elapsed(w, now_unix_ms)
}

fn pick_suggested_fallback_model(
    requested_model: &str,
    available_models: &[String],
    windows: &[CachedQuotaWindow],
    threshold: f64,
    now_unix_ms: i64,
) -> Option<String> {
    if available_models.is_empty() {
        return None;
    }

    let req_lower = requested_model.trim().to_ascii_lowercase();
    let eligible: Vec<&String> = available_models
        .iter()
        .filter(|id| {
            if let Some(w) = relevant_quota_window(windows, Some(id)) {
                is_window_healthy(w, threshold, now_unix_ms)
            } else {
                true
            }
        })
        .collect();
    let pool: Vec<&String> = if eligible.is_empty() {
        available_models.iter().collect()
    } else {
        eligible
    };

    let prefer_flash = req_lower.contains("flash") || req_lower.contains("haiku") || req_lower.contains("mini");
    let tier_score_for = |id: &str| -> i32 {
        let lower = id.to_ascii_lowercase();
        if !models_match_exact_or_base(id, requested_model) && req_lower.contains("claude") && lower.contains("claude") {
            0
        } else if !models_match_exact_or_base(id, requested_model) && req_lower.contains("gemini") && lower.contains("gemini") {
            1
        } else if prefer_flash && lower.contains("flash") {
            2
        } else if !prefer_flash && (lower.contains("pro") || lower.contains("opus") || lower.contains("sonnet")) {
            2
        } else if lower.contains("pro") {
            3
        } else if lower.contains("flash") {
            4
        } else {
            5
        }
    };

    pool.into_iter()
        .min_by(|a, b| (tier_score_for(a), a.as_str()).cmp(&(tier_score_for(b), b.as_str())))
        .cloned()
}

pub(crate) fn rank_auto_switch_candidates_in(
    root: &Path,
    provider: &str,
    requested_model: Option<&str>,
    policy: &AutoSwitchPolicy,
    runtime_cooldowns: &HashMap<String, i64>,
    now_unix_ms: i64,
) -> Vec<RankedSwitchCandidate> {
    let canon = canon_provider(provider);
    let _guard = REGISTRY_LOCK.lock().unwrap();
    let reg = load_registry_from(root);

    let source_plan = reg
        .profiles
        .iter()
        .find(|p| same_provider(&p.provider, &canon) && p.is_active)
        .and_then(|p| p.plan_name.clone());

    let req_trimmed = requested_model
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let mut ranked: Vec<RankedSwitchCandidate> = Vec::new();

    for p in reg.profiles {
        if !same_provider(&p.provider, &canon) || p.is_active {
            continue;
        }
        if policy.excluded_account_ids.iter().any(|id| id == &p.id) {
            continue;
        }
        if let Some(&cooldown_until) = runtime_cooldowns.get(&p.id) {
            if cooldown_until > now_unix_ms {
                continue;
            }
        }
        let health = p
            .credential_status
            .clone()
            .unwrap_or_else(|| compute_profile_credential_health(root, &p).0);
        if health != "valid" {
            continue;
        }

        let primary_reset_elapsed = p.time_until_reset_ms.unwrap_or(0) > 0
            && p.last_used_unix_ms > 0
            && now_unix_ms >= p.last_used_unix_ms.saturating_add(p.time_until_reset_ms.unwrap_or(0));

        let other_healthy_window = p
            .quota_windows
            .iter()
            .find(|w| is_window_healthy(w, policy.trigger_threshold_percent, now_unix_ms));

        let relevant_win = relevant_quota_window(&p.quota_windows, req_trimmed.as_deref());

        let (relevant_bucket_exhausted, remaining_percent, quota_confidence, relevant_window_name) =
            if let Some(w) = relevant_win {
                let win_ok = is_window_healthy(w, policy.trigger_threshold_percent, now_unix_ms);
                if win_ok {
                    let conf = if !w.is_exhausted && w.remaining_percent > policy.trigger_threshold_percent {
                        2u8
                    } else {
                        1u8
                    };
                    let eff = if conf == 2 {
                        Some(w.remaining_percent)
                    } else {
                        Some(1.0)
                    };
                    (false, eff, conf, Some(w.name.clone()))
                } else if let Some(alt_win) = other_healthy_window {
                    let conf = if !alt_win.is_exhausted && alt_win.remaining_percent > policy.trigger_threshold_percent {
                        2u8
                    } else {
                        1u8
                    };
                    (
                        true,
                        Some(alt_win.remaining_percent),
                        conf,
                        Some(w.name.clone()),
                    )
                } else {
                    continue;
                }
            } else if let Some(primary_pct) = p.primary_remaining_percent {
                if primary_pct > policy.trigger_threshold_percent {
                    (false, Some(primary_pct), 2u8, None)
                } else if primary_reset_elapsed {
                    (false, Some(1.0), 1u8, None)
                } else if let Some(alt_win) = other_healthy_window {
                    (false, Some(alt_win.remaining_percent), 2u8, None)
                } else {
                    continue;
                }
            } else if let Some(alt_win) = other_healthy_window {
                (false, Some(alt_win.remaining_percent), 2u8, None)
            } else {
                (false, None, 0u8, None)
            };

        let (compatibility, suggested_fallback_model) = match req_trimmed.as_deref() {
            None => ("exact".to_string(), None),
            Some(req) if relevant_bucket_exhausted => (
                "model_mismatch".to_string(),
                pick_suggested_fallback_model(
                    req,
                    &p.available_model_ids,
                    &p.quota_windows,
                    policy.trigger_threshold_percent,
                    now_unix_ms,
                ),
            ),
            Some(_) if p.available_model_ids.is_empty() => ("unverified_catalog".to_string(), None),
            Some(req)
                if p.available_model_ids
                    .iter()
                    .any(|id| models_match_exact_or_base(id, req)) =>
            {
                ("exact".to_string(), None)
            }
            Some(req) => (
                "model_mismatch".to_string(),
                pick_suggested_fallback_model(
                    req,
                    &p.available_model_ids,
                    &p.quota_windows,
                    policy.trigger_threshold_percent,
                    now_unix_ms,
                ),
            ),
        };

        let target_plan = p.plan_name.clone();
        let available_target_models = p.available_model_ids.clone();
        ranked.push(RankedSwitchCandidate {
            profile: p,
            compatibility,
            requested_model: req_trimmed.clone(),
            suggested_fallback_model,
            available_target_models,
            source_plan: source_plan.clone(),
            target_plan,
            remaining_percent,
            known_healthy_quota: quota_confidence > 0,
            quota_confidence,
            relevant_window_name,
        });
    }

    let strategy_priority = policy.selection_strategy == "priority_order";
    ranked.sort_by(|a, b| {
        let compat_rank = |c: &str| match c {
            "exact" => 0u8,
            "unverified_catalog" => 1u8,
            _ => 2u8,
        };
        let ca = compat_rank(&a.compatibility);
        let cb = compat_rank(&b.compatibility);
        if ca != cb {
            return ca.cmp(&cb);
        }

        // Known healthy quota strictly ranks ahead of unknown (`None`) cached quota.
        if a.known_healthy_quota != b.known_healthy_quota {
            return b.known_healthy_quota.cmp(&a.known_healthy_quota);
        }

        if strategy_priority {
            let pa = policy
                .priority_order
                .iter()
                .position(|id| id == &a.profile.id)
                .unwrap_or(usize::MAX);
            let pb = policy
                .priority_order
                .iter()
                .position(|id| id == &b.profile.id)
                .unwrap_or(usize::MAX);
            if pa != pb {
                return pa.cmp(&pb);
            }
        }

        if a.quota_confidence != b.quota_confidence {
            return b.quota_confidence.cmp(&a.quota_confidence);
        }

        let ra = a.remaining_percent.unwrap_or(-1.0);
        let rb = b.remaining_percent.unwrap_or(-1.0);
        rb.partial_cmp(&ra)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.profile.id.cmp(&b.profile.id))
    });

    ranked
}

/// Helper for handoff module: get list of alternative accounts for a provider that have quota available.
pub fn get_alternative_accounts_with_quota(provider: &str) -> Vec<SavedAccountProfile> {
    let root = profiles_root();
    let policy = get_auto_switch_policy_in(&root, provider);
    let mut list_policy = AutoSwitchPolicy {
        excluded_account_ids: policy.excluded_account_ids,
        ..Default::default()
    };
    list_policy.trigger_threshold_percent = 0.0;
    rank_auto_switch_candidates_in(
        &root,
        provider,
        None,
        &list_policy,
        &HashMap::new(),
        now_ms(),
    )
    .into_iter()
    .map(|c| c.profile)
    .collect()
}

static AUTO_SWITCH_RUNTIME_STATUS: OnceLock<Mutex<HashMap<String, AutoSwitchRuntimeStatus>>> =
    OnceLock::new();

pub(crate) fn auto_switch_runtime_map() -> &'static Mutex<HashMap<String, AutoSwitchRuntimeStatus>> {
    AUTO_SWITCH_RUNTIME_STATUS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn get_auto_switch_runtime_status(provider: &str) -> AutoSwitchRuntimeStatus {
    let canon = canon_provider(provider);
    auto_switch_runtime_map()
        .lock()
        .unwrap()
        .get(&canon)
        .cloned()
        .unwrap_or_default()
}

pub(crate) fn set_auto_switch_runtime_status(provider: &str, status: AutoSwitchRuntimeStatus) {
    let canon = canon_provider(provider);
    auto_switch_runtime_map()
        .lock()
        .unwrap()
        .insert(canon, status);
}

pub(crate) fn get_auto_switch_policy_with(root: &Path, provider: &str) -> Value {
    let canon = canon_provider(provider);
    let policy = get_auto_switch_policy_in(root, &canon);
    let status = get_auto_switch_runtime_status(&canon);
    json!({
        "provider": canon,
        "policy": policy,
        "status": status,
    })
}

pub(crate) fn save_auto_switch_policy_with(root: &Path, provider: &str, policy_val: Value) -> Value {
    let canon = canon_provider(provider);
    if canon.trim().is_empty() {
        return json!({
            "success": false,
            "error": "Provider cannot be empty."
        });
    }
    let parsed: AutoSwitchPolicy = match serde_json::from_value(policy_val) {
        Ok(p) => p,
        Err(err) => {
            return json!({
                "success": false,
                "error": format!("Invalid auto-switch policy payload: {err}")
            });
        }
    };
    match save_auto_switch_policy_in(root, &canon, parsed) {
        Ok(saved) => {
            let status = if !saved.enabled {
                super::auto_switch::clear_runtime_pause_on_policy_disable(&canon)
            } else {
                get_auto_switch_runtime_status(&canon)
            };
            json!({
                "success": true,
                "provider": canon,
                "policy": saved,
                "status": status,
            })
        }
        Err(err) => json!({
            "success": false,
            "error": err,
        }),
    }
}

pub(crate) fn resume_auto_switch_with(_root: &Path, provider: &str) -> Value {
    let canon = canon_provider(provider);
    if canon.trim().is_empty() {
        return json!({
            "success": false,
            "error": "Provider cannot be empty."
        });
    }
    let status = super::auto_switch::resume_auto_switch_state(&canon);
    json!({
        "success": true,
        "provider": canon,
        "status": status,
    })
}

pub fn get_auto_switch_policy_direct(provider: &str) -> Value {
    get_auto_switch_policy_with(&profiles_root(), provider)
}

pub fn save_auto_switch_policy_direct(provider: &str, policy: Value) -> Value {
    save_auto_switch_policy_with(&profiles_root(), provider, policy)
}

pub fn resume_auto_switch_direct(provider: &str) -> Value {
    resume_auto_switch_with(&profiles_root(), provider)
}

pub async fn get_auto_switch_policy_impl(request: Option<Value>) -> Value {
    let req = crate::persist::body(&request);
    let provider = req
        .and_then(|r| r.get("provider"))
        .and_then(|v| v.as_str())
        .unwrap_or("agy")
        .to_string();
    tokio::task::spawn_blocking(move || get_auto_switch_policy_direct(&provider))
        .await
        .unwrap_or_else(|e| json!({ "success": false, "error": format!("Worker failed: {e}") }))
}

pub async fn save_auto_switch_policy_impl(request: Option<Value>) -> Value {
    let req = crate::persist::body(&request);
    let provider = req
        .as_ref()
        .and_then(|r| r.get("provider"))
        .and_then(|v| v.as_str())
        .unwrap_or("agy")
        .to_string();
    let policy_val = req
        .as_ref()
        .and_then(|r| r.get("policy"))
        .cloned()
        .unwrap_or(Value::Null);
    tokio::task::spawn_blocking(move || save_auto_switch_policy_direct(&provider, policy_val))
        .await
        .unwrap_or_else(|e| json!({ "success": false, "error": format!("Worker failed: {e}") }))
}

pub async fn resume_auto_switch_impl(request: Option<Value>) -> Value {
    let req = crate::persist::body(&request);
    let provider = req
        .and_then(|r| r.get("provider"))
        .and_then(|v| v.as_str())
        .unwrap_or("agy")
        .to_string();
    tokio::task::spawn_blocking(move || resume_auto_switch_direct(&provider))
        .await
        .unwrap_or_else(|e| json!({ "success": false, "error": format!("Worker failed: {e}") }))
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

fn detect_antigravity_cli_account() -> DetectedCliAccount {
    let bin = crate::acp::resolve_antigravity_acp_binary()
        .map(|p| p.to_string_lossy().to_string());
    let (email, name, source) = if let Some((e, n)) = crate::quota::read_antigravity_credential() {
        (Some(e), n, "Windows Credential Manager (gemini:antigravity)")
    } else if let Some((e, n)) = crate::quota::read_antigravity_ide_identity() {
        (Some(e), n, "Antigravity IDE (state.vscdb)")
    } else {
        (None, None, "")
    };

    let auth_state = if email.is_some() {
        "authenticated"
    } else if bin.is_some() {
        "unauthenticated"
    } else {
        "not_installed"
    };

    DetectedCliAccount {
        provider: "antigravity".into(),
        display_name: "Antigravity".into(),
        auth_state: auth_state.into(),
        account_label: email.clone().or(name).or_else(|| Some("Antigravity Account".into())),
        email,
        plan_name: get_cached_live_quota("agy").and_then(|q| q.plan),
        binary_path: bin,
        config_path: if source.is_empty() { None } else { Some(source.into()) },
        details: if source.is_empty() {
            None
        } else {
            Some(format!("Sesión detectada en {source}"))
        },
    }
}

fn detect_codex_cli_account(home: &Path) -> DetectedCliAccount {
    let bin = crate::chat::utils::resolve_codex_bin().map(|p| p.to_string_lossy().to_string());
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
                        if let Some(plan_type) = payload
                            .pointer("/https:~1~1api.openai.com~1auth/chatgpt_plan_type")
                            .and_then(|v| v.as_str())
                        {
                            plan = Some(match plan_type {
                                "plus" => "ChatGPT Plus".into(),
                                "pro" => "ChatGPT Pro".into(),
                                "team" => "ChatGPT Team".into(),
                                other => format!("ChatGPT {}", other),
                            });
                        }
                    }
                } else if val.pointer("/tokens/access_token").is_some()
                    || val
                        .get("OPENAI_API_KEY")
                        .and_then(|v| v.as_str())
                        .map_or(false, |k| !k.is_empty())
                {
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

    DetectedCliAccount {
        provider: "codex".into(),
        display_name: "Codex".into(),
        auth_state: auth_state.into(),
        account_label: email.clone().or_else(|| Some("ChatGPT Account".into())),
        email,
        plan_name: plan.or_else(|| Some("ChatGPT Plus / OpenAI".into())),
        binary_path: bin,
        config_path: Some(auth_file.to_string_lossy().to_string()),
        details: Some("Tokens CLI detectados en ~/.codex/auth.json".into()),
    }
}

fn detect_grok_cli_account(home: &Path) -> DetectedCliAccount {
    let bin = crate::chat::resolve_bin("grok", &[]).map(|p| p.to_string_lossy().to_string());
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

    DetectedCliAccount {
        provider: "grok".into(),
        display_name: "Grok".into(),
        auth_state: auth_state.into(),
        account_label: email.clone().or_else(|| Some("xAI Account".into())),
        email,
        plan_name: Some("xAI Grok CLI".into()),
        binary_path: bin,
        config_path: Some(auth_file.to_string_lossy().to_string()),
        details: Some("Sesión OIDC detectada en ~/.grok/auth.json".into()),
    }
}

fn detect_opencode_cli_account(home: &Path) -> DetectedCliAccount {
    let bin = crate::chat::resolve_bin("opencode", &[]).map(|p| p.to_string_lossy().to_string());
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

    DetectedCliAccount {
        provider: "opencode".into(),
        display_name: "OpenCode".into(),
        auth_state: auth_state.into(),
        account_label,
        email: None,
        plan_name: Some("Multi-proveedor / OpenCode Go".into()),
        binary_path: bin,
        config_path: Some(auth_file.to_string_lossy().to_string()),
        details,
    }
}

fn detect_cursor_cli_account(home: &Path, appdata: &Path) -> DetectedCliAccount {
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

    DetectedCliAccount {
        provider: "cursor".into(),
        display_name: "Cursor".into(),
        auth_state: auth_state.into(),
        account_label: email.clone().or_else(|| Some("Cursor CLI / Agent".into())),
        email,
        plan_name: Some("Cursor Pro / Agent".into()),
        binary_path: bin,
        config_path: auth_file.map(|p| p.to_string_lossy().to_string()),
        details: Some("cursor-agent en PATH".into()),
    }
}

fn detect_claude_cli_account(home: &Path) -> DetectedCliAccount {
    let bin = crate::chat::resolve_bin("claude", &[]).map(|p| p.to_string_lossy().to_string());
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
                if let Some(em) = val
                    .pointer("/oauthAccount/emailAddress")
                    .and_then(|v| v.as_str())
                {
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

    DetectedCliAccount {
        provider: "claude".into(),
        display_name: "Claude Code".into(),
        auth_state: auth_state.into(),
        account_label: email.clone().or_else(|| Some("Claude CLI".into())),
        email,
        plan_name: Some("Anthropic Claude Code".into()),
        binary_path: bin,
        config_path: Some(creds_file.to_string_lossy().to_string()),
        details: Some("Sesión OAuth en ~/.claude".into()),
    }
}

fn detect_gemini_cli_account(home: &Path) -> DetectedCliAccount {
    let bin = crate::chat::resolve_bin("gemini", &[]).map(|p| p.to_string_lossy().to_string());
    let gemini_dir = home.join(".gemini");
    let oauth_file = gemini_dir.join("oauth_creds.json");
    let accounts_file = gemini_dir.join("google_accounts.json");
    let probe = probe_live_provider_identity("gemini");
    let has_oauth = oauth_file.exists() || probe.is_some();
    let email = probe.as_ref().map(|p| p.email.clone());

    let auth_state = if has_oauth {
        "authenticated"
    } else if bin.is_some() {
        "unauthenticated"
    } else {
        "not_installed"
    };

    let config_path = if oauth_file.exists() {
        Some(oauth_file.to_string_lossy().to_string())
    } else if accounts_file.exists() {
        Some(accounts_file.to_string_lossy().to_string())
    } else {
        None
    };

    DetectedCliAccount {
        provider: "gemini".into(),
        display_name: "Gemini CLI".into(),
        auth_state: auth_state.into(),
        account_label: email.clone().or_else(|| Some("Gemini CLI".into())),
        email,
        plan_name: get_cached_live_quota("gemini").and_then(|q| q.plan),
        binary_path: bin,
        config_path,
        details: if has_oauth {
            Some("Sesión OAuth CLI en ~/.gemini".into())
        } else {
            None
        },
    }
}

fn detect_all_cli_accounts_uncached() -> Value {
    let home = user_home_dir();
    let appdata = appdata_dir();
    let accounts = std::thread::scope(|s| {
        let h_agy = s.spawn(detect_antigravity_cli_account);
        let h_codex = s.spawn(|| detect_codex_cli_account(&home));
        let h_grok = s.spawn(|| detect_grok_cli_account(&home));
        let h_opencode = s.spawn(|| detect_opencode_cli_account(&home));
        let h_cursor = s.spawn(|| detect_cursor_cli_account(&home, &appdata));
        let h_claude = s.spawn(|| detect_claude_cli_account(&home));
        let h_gemini = s.spawn(|| detect_gemini_cli_account(&home));

        vec![
            h_agy.join().unwrap_or_else(|_| detect_antigravity_cli_account()),
            h_codex.join().unwrap_or_else(|_| detect_codex_cli_account(&home)),
            h_grok.join().unwrap_or_else(|_| detect_grok_cli_account(&home)),
            h_opencode.join().unwrap_or_else(|_| detect_opencode_cli_account(&home)),
            h_cursor.join().unwrap_or_else(|_| detect_cursor_cli_account(&home, &appdata)),
            h_claude.join().unwrap_or_else(|_| detect_claude_cli_account(&home)),
            h_gemini.join().unwrap_or_else(|_| detect_gemini_cli_account(&home)),
        ]
    });

    json!({
        "schemaVersion": 1,
        "accounts": accounts
    })
}

pub fn list_detected_cli_accounts_direct() -> Value {
    detected_cli_accounts_cache().get_or_compute(false, cfg!(test), detect_all_cli_accounts_uncached)
}

pub async fn list_detected_cli_accounts_impl() -> Value {
    tauri::async_runtime::spawn_blocking(list_detected_cli_accounts_direct)
        .await
        .unwrap_or_else(|_| json!({ "schemaVersion": 1, "accounts": [] }))
}

pub(crate) trait LoginFlowOps {
    fn quiesce_and_evict(&self) -> Vec<crate::terminal::QuiescedTerminal>;
    fn invalidate_and_evict(&self);
    fn respawn(
        &self,
        account_label: &str,
        email: Option<&str>,
        quiesced: &[crate::terminal::QuiescedTerminal],
    );
}

pub(crate) struct LiveLoginFlowOps;

impl LoginFlowOps for LiveLoginFlowOps {
    fn quiesce_and_evict(&self) -> Vec<crate::terminal::QuiescedTerminal> {
        let quiesced = crate::terminal::quiesce_provider_terminals("agy");
        self.invalidate_and_evict();
        quiesced
    }

    fn invalidate_and_evict(&self) {
        crate::quota::invalidate_provider_cache("antigravity");
        crate::quota::invalidate_provider_cache("agy");
        crate::chat::runtime::state::evict_provider_runtime_state("antigravity");
    }

    fn respawn(
        &self,
        account_label: &str,
        email: Option<&str>,
        quiesced: &[crate::terminal::QuiescedTerminal],
    ) {
        crate::terminal::respawn_provider_terminals("agy", account_label, email, quiesced);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginRollbackMapping {
    source_path: String,
    rel_dest: String,
    had_file: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginRollbackBundle {
    flow_id: String,
    provider: String,
    created_at_ms: i64,
    previous_email: Option<String>,
    had_cred: bool,
    had_ide_rows: bool,
    mappings: Vec<LoginRollbackMapping>,
    quiesced_terminals: Vec<crate::terminal::QuiescedTerminal>,
}

fn write_login_rollback_bundle(
    rollback_dir: &Path,
    bundle: &LoginRollbackBundle,
) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(bundle)
        .map_err(|e| format!("No se pudo serializar rollback.json: {e}"))?;
    write_bytes_atomic(&rollback_dir.join("rollback.json"), &bytes)
}

fn resolve_rollback_dir(root: &Path, flow_id: Option<&str>) -> Option<PathBuf> {
    let base = root.join("_login_rollback").join("agy");
    if let Some(id) = flow_id.map(str::trim).filter(|s| !s.is_empty()) {
        let candidate = base.join(id);
        if candidate.join("rollback.json").exists() {
            return Some(candidate);
        }
    }
    let latest_path = base.join("latest.txt");
    if let Ok(latest) = fs::read_to_string(&latest_path) {
        let trimmed = latest.trim();
        if !trimmed.is_empty() {
            let candidate = base.join(trimmed);
            if candidate.join("rollback.json").exists() {
                return Some(candidate);
            }
        }
    }
    let Ok(entries) = fs::read_dir(&base) else {
        return None;
    };
    let mut best: Option<(i64, PathBuf)> = None;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let meta_path = path.join("rollback.json");
        if let Ok(raw) = fs::read(&meta_path) {
            if let Ok(bundle) = serde_json::from_slice::<LoginRollbackBundle>(&raw) {
                if best
                    .as_ref()
                    .map_or(true, |(ts, _)| bundle.created_at_ms >= *ts)
                {
                    best = Some((bundle.created_at_ms, path));
                }
            }
        }
    }
    best.map(|(_, path)| path)
}

/// Computes the interactive CLI login argv and display command from `acp --help`
/// output, wrapping Windows `.cmd`/`.bat` shims with `cmd.exe /C`.
pub(crate) fn build_antigravity_login_argv_from_help(
    binary: Option<&Path>,
    acp_help_text: Option<&str>,
) -> (Vec<String>, String) {
    let supports_login = acp_help_text.map_or(false, |text| text.contains("--login"));
    let bin_str = binary
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "agy".to_string());
    let is_batch_script = binary
        .and_then(|p| p.extension())
        .and_then(|e| e.to_str())
        .map_or(false, |ext| {
            ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat")
        });

    let mut argv = if is_batch_script {
        vec!["cmd.exe".to_string(), "/C".to_string(), bin_str]
    } else {
        vec![bin_str]
    };

    if supports_login {
        argv.push("acp".to_string());
        argv.push("--login".to_string());
        (argv, "agy acp --login".to_string())
    } else {
        (argv, "agy".to_string())
    }
}

pub(crate) fn resolve_antigravity_login_argv() -> (Vec<String>, String) {
    let binary = crate::acp::resolve_antigravity_acp_binary()
        .or_else(|| crate::terminal::resolve_engine_program("antigravity").map(PathBuf::from));
    let help_text = binary.as_deref().and_then(|bin| {
        crate::hidden_exec::run(bin, &["acp", "--help"], std::time::Duration::from_millis(3500))
            .ok()
            .and_then(|out| {
                // `agy acp --help` writes flags to stderr on Windows, so combine both streams.
                let combined = format!(
                    "{}\n{}",
                    String::from_utf8_lossy(&out.stdout),
                    String::from_utf8_lossy(&out.stderr)
                );
                if combined.trim().is_empty() {
                    None
                } else {
                    Some(combined)
                }
            })
    });
    build_antigravity_login_argv_from_help(binary.as_deref(), help_text.as_deref())
}

pub(crate) fn start_account_login_flow_with(
    root: &Path,
    provider: &str,
    force: bool,
    mappings: &[FileMapping],
    state_vscdb: Option<&Path>,
    cred_store: &dyn AntigravityCredStore,
    idle_check: Result<(), String>,
    inspection: &crate::terminal::ProviderSessionsInspection,
    login_argv: Vec<String>,
    login_command: String,
    ops: &dyn LoginFlowOps,
) -> Value {
    let canon = canon_provider(provider);
    if canon != "agy" {
        return json!({
            "success": false,
            "code": "UNSUPPORTED_PROVIDER",
            "error": format!("Inicio de sesión guiado no soportado para proveedor: {canon}")
        });
    }

    // 1. Check external client lock & active Kite turns BEFORE touching any credentials or terminals.
    if let Err(msg) = idle_check {
        return json!({
            "success": false,
            "code": "PROVIDER_BUSY",
            "error": msg
        });
    }

    if !force && !inspection.managed_busy.is_empty() {
        return json!({
            "success": false,
            "code": "CONFIRM_BUSY_TERMINALS",
            "error": "Hay terminales activas ejecutando una respuesta en este proveedor.",
            "busySessions": inspection.managed_busy,
            "managedIdleCount": inspection.managed_idle.len(),
            "unaffectedTerminalsCount": inspection.unaffected_terminals_count,
        });
    }

    // 1b. If a previous login attempt never saved or cancelled cleanly, recover its prior
    // auth snapshot before inspecting or creating a fresh rollback bundle.
    let mut prior_quiesced: Vec<crate::terminal::QuiescedTerminal> = Vec::new();
    let (_, initial_cred_valid, _) = {
        let raw = cred_store.read_raw();
        let (st, _, em) = crate::quota::inspect_raw_antigravity_credential_health(raw.as_deref());
        (raw, st == "valid", em)
    };
    if let Some(prev_rollback_dir) = resolve_rollback_dir(root, None) {
        if !initial_cred_valid {
            if let Ok((prev_bundle, _)) = restore_rollback_artifacts_from_dir(
                root,
                &prev_rollback_dir,
                mappings,
                state_vscdb,
                cred_store,
            ) {
                prior_quiesced = prev_bundle.quiesced_terminals;
            }
        }
        let _ = fs::remove_dir_all(root.join("_login_rollback").join("agy"));
    }

    // 2. Inspect existing credential health and auto-save valid previous account before clearing.
    let raw_cred = cred_store.read_raw();
    let (cred_status, _, previous_email) =
        crate::quota::inspect_raw_antigravity_credential_health(raw_cred.as_deref());

    let mut previous_email_saved: Option<String> = None;
    let mut previous_save_warning: Option<String> = None;
    if cred_status == "valid" {
        if let Some(ref em) = previous_email {
            let live_ident = Some(LiveIdentityProbe {
                provider: "agy".to_string(),
                email: em.clone(),
                name: None,
                source: "gemini:antigravity".to_string(),
            });
            let saved = save_account_profile_with(
                root,
                "agy",
                String::new(),
                mappings,
                state_vscdb,
                cred_store,
                live_ident,
                None,
            );
            if saved.get("success").and_then(|v| v.as_bool()) == Some(true) {
                previous_email_saved = Some(em.clone());
            } else {
                previous_save_warning = saved
                    .get("error")
                    .and_then(|v| v.as_str())
                    .map(String::from)
                    .or_else(|| {
                        Some("No se pudo guardar automáticamente la cuenta anterior.".to_string())
                    });
            }
        }
    }

    // 3. Persist transactional rollback bundle BEFORE clearing credentials or quiescing terminals.
    let flow_id = Uuid::new_v4().to_string();
    let rollback_dir = root.join("_login_rollback").join("agy").join(&flow_id);
    if let Err(err) = fs::create_dir_all(&rollback_dir) {
        return json!({
            "success": false,
            "error": format!("No se pudo crear respaldo previo de inicio de sesión: {err}")
        });
    }

    let mut had_cred = false;
    if let Some(ref raw) = raw_cred {
        if let Err(err) =
            write_bytes_atomic(&rollback_dir.join("gemini_antigravity_cred.json"), raw.as_bytes())
        {
            let _ = fs::remove_dir_all(&rollback_dir);
            return json!({ "success": false, "error": err });
        }
        had_cred = true;
    }

    let mut had_ide_rows = false;
    if let Some(db_path) = state_vscdb {
        match crate::quota::extract_ide_auth_rows_from_db(db_path) {
            Ok(rows) if !rows.is_empty() => {
                let bytes = match serde_json::to_vec_pretty(&rows) {
                    Ok(b) => b,
                    Err(e) => {
                        let _ = fs::remove_dir_all(&rollback_dir);
                        return json!({
                            "success": false,
                            "error": format!("No se pudo respaldar estado IDE: {e}")
                        });
                    }
                };
                if let Err(err) = write_bytes_atomic(&rollback_dir.join("ide_auth_rows.json"), &bytes)
                {
                    let _ = fs::remove_dir_all(&rollback_dir);
                    return json!({ "success": false, "error": err });
                }
                had_ide_rows = true;
            }
            Ok(_) => {}
            Err(err) => {
                let _ = fs::remove_dir_all(&rollback_dir);
                return json!({ "success": false, "error": err });
            }
        }
    }

    let mut rollback_mappings = Vec::with_capacity(mappings.len());
    for m in mappings {
        let had_file = m.source.exists();
        if had_file && !copy_atomic(&m.source, &rollback_dir.join(m.rel_dest)) {
            let _ = fs::remove_dir_all(&rollback_dir);
            return json!({
                "success": false,
                "error": format!("No se pudo respaldar {} antes de iniciar sesión.", m.rel_dest)
            });
        }
        rollback_mappings.push(LoginRollbackMapping {
            source_path: m.source.to_string_lossy().to_string(),
            rel_dest: m.rel_dest.to_string(),
            had_file,
        });
    }

    let mut bundle = LoginRollbackBundle {
        flow_id: flow_id.clone(),
        provider: "agy".to_string(),
        created_at_ms: now_ms(),
        previous_email: previous_email.clone(),
        had_cred,
        had_ide_rows,
        mappings: rollback_mappings,
        quiesced_terminals: Vec::new(),
    };
    if let Err(err) = write_login_rollback_bundle(&rollback_dir, &bundle) {
        let _ = fs::remove_dir_all(&rollback_dir);
        return json!({ "success": false, "error": err });
    }
    let _ = write_bytes_atomic(
        &root.join("_login_rollback").join("agy").join("latest.txt"),
        flow_id.as_bytes(),
    );

    // 4. Quiesce only Kite-owned agy terminals and evict stale quota/runtime state.
    let mut quiesced = ops.quiesce_and_evict();
    for prev in prior_quiesced {
        if !quiesced.iter().any(|q| q.session_id == prev.session_id) {
            quiesced.push(prev);
        }
    }
    let quiesced_count = quiesced.len();
    bundle.quiesced_terminals = quiesced;
    if let Err(err) = write_login_rollback_bundle(&rollback_dir, &bundle) {
        log_trace(&format!(
            "account_switcher: could not update quiesced terminals in rollback bundle {flow_id}: {err}"
        ));
    }

    // 5. Clear CLI + IDE auth cleanly and mark all agy Vault profiles inactive.
    let keyring_deleted = cred_store.delete();
    for m in mappings {
        if m.source.exists() {
            let _ = fs::remove_file(&m.source);
        }
    }
    let ide_cleared = if let Some(db_path) = state_vscdb {
        crate::quota::clear_ide_auth_state_from_db(db_path).unwrap_or(false)
    } else {
        false
    };

    {
        let _guard = REGISTRY_LOCK.lock().unwrap();
        let mut reg = load_registry_from(root);
        for p in &mut reg.profiles {
            if same_provider(&p.provider, "agy") {
                p.is_active = false;
            }
        }
        let _ = save_registry_to(root, &reg);
    }

    invalidate_detected_cli_accounts_cache();

    json!({
        "success": true,
        "flowId": flow_id,
        "previousEmail": previous_email,
        "previousEmailSaved": previous_email_saved,
        "previousSaveWarning": previous_save_warning,
        "engine": "agy",
        "loginArgv": login_argv,
        "loginCommand": login_command,
        "keyringDeleted": keyring_deleted,
        "ideCleared": ide_cleared,
        "quiescedTerminalsCount": quiesced_count,
        "unaffectedTerminalsCount": inspection.unaffected_terminals_count,
    })
}

pub fn start_account_login_flow_direct(provider: String, force: bool) -> Value {
    let canon = canon_provider(&provider);
    if canon != "agy" {
        return json!({
            "success": false,
            "code": "UNSUPPORTED_PROVIDER",
            "error": format!("Inicio de sesión guiado no soportado para proveedor: {canon}")
        });
    }
    let mappings = get_provider_file_mappings("agy");
    let (state_vscdb, external_proc, inspection, (login_argv, login_command)) =
        std::thread::scope(|s| {
            let h_vscdb = s.spawn(crate::quota::find_existing_state_vscdb);
            let h_ext = s.spawn(|| inspect_external_provider_processes("agy"));
            let h_inspect = s.spawn(|| crate::terminal::inspect_provider_sessions("agy"));
            let h_argv = s.spawn(resolve_antigravity_login_argv);
            (
                h_vscdb.join().unwrap_or(None),
                h_ext.join().unwrap_or_else(|_| ExternalProcessInspection {
                    state: "unknown".to_string(),
                    can_close_processes: false,
                    base_app_pids: Vec::new(),
                    base_app_titles: Vec::new(),
                    residual_processes: Vec::new(),
                    message: "idle check panicked".to_string(),
                }),
                h_inspect
                    .join()
                    .unwrap_or_else(|_| crate::terminal::inspect_provider_sessions("agy")),
                h_argv.join().unwrap_or_else(|_| resolve_antigravity_login_argv()),
            )
        });
    if external_proc.state != "idle" {
        return provider_busy_payload(&external_proc);
    }
    start_account_login_flow_with(
        &profiles_root(),
        &canon,
        force,
        &mappings,
        state_vscdb.as_deref(),
        &LiveAntigravityCredStore,
        external_proc.to_idle_result(),
        &inspection,
        login_argv,
        login_command,
        &LiveLoginFlowOps,
    )
}

pub async fn start_account_login_flow_impl(request: Option<Value>) -> Value {
    let req = crate::persist::body(&request);
    let provider = req
        .and_then(|r| r.get("provider"))
        .and_then(|v| v.as_str())
        .unwrap_or("antigravity")
        .to_string();
    let force = req
        .and_then(|r| r.get("force"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    tokio::task::spawn_blocking(move || start_account_login_flow_direct(provider, force))
        .await
        .unwrap_or_else(|e| {
            json!({
                "success": false,
                "error": format!("Worker task failed: {e}")
            })
        })
}

fn restore_rollback_artifacts_from_dir(
    root: &Path,
    rollback_dir: &Path,
    mappings: &[FileMapping],
    state_vscdb: Option<&Path>,
    cred_store: &dyn AntigravityCredStore,
) -> Result<(LoginRollbackBundle, String), Value> {
    let bundle_bytes = fs::read(rollback_dir.join("rollback.json")).map_err(|e| {
        json!({
            "success": false,
            "restored": false,
            "error": format!("No se pudo leer respaldo de inicio de sesión: {e}")
        })
    })?;
    let bundle: LoginRollbackBundle = serde_json::from_slice(&bundle_bytes).map_err(|e| {
        json!({
            "success": false,
            "restored": false,
            "error": format!("Respaldo de inicio de sesión corrupto: {e}")
        })
    })?;

    if bundle.had_cred {
        let cred_raw =
            fs::read_to_string(rollback_dir.join("gemini_antigravity_cred.json")).map_err(|e| {
                json!({
                    "success": false,
                    "restored": false,
                    "error": format!("No se pudo leer la credencial respaldada: {e}")
                })
            })?;
        if let Err(err) = cred_store.write_checked(&cred_raw) {
            return Err(json!({
                "success": false,
                "restored": false,
                "error": err
            }));
        }
    } else {
        let _ = cred_store.delete();
    }

    if let Some(db_path) = state_vscdb {
        if bundle.had_ide_rows {
            let bytes = fs::read(rollback_dir.join("ide_auth_rows.json")).map_err(|e| {
                json!({
                    "success": false,
                    "restored": false,
                    "error": format!("No se pudo abrir respaldo IDE: {e}")
                })
            })?;
            let rows: BTreeMap<String, String> = serde_json::from_slice(&bytes).map_err(|e| {
                json!({
                    "success": false,
                    "restored": false,
                    "error": format!("No se pudo leer respaldo IDE: {e}")
                })
            })?;
            if let Err(err) = crate::quota::restore_ide_auth_rows_to_db(db_path, &rows) {
                return Err(json!({ "success": false, "restored": false, "error": err }));
            }
        } else if let Err(err) = crate::quota::clear_ide_auth_state_from_db(db_path) {
            return Err(json!({ "success": false, "restored": false, "error": err }));
        }
    }

    // Prefer live `mappings` destination paths when supplied (tests pass isolated paths),
    // falling back to paths stored inside the rollback bundle.
    for bm in &bundle.mappings {
        let target_path = mappings
            .iter()
            .find(|m| m.rel_dest == bm.rel_dest)
            .map(|m| m.source.clone())
            .unwrap_or_else(|| PathBuf::from(&bm.source_path));
        if bm.had_file {
            if !copy_atomic(&rollback_dir.join(&bm.rel_dest), &target_path) {
                return Err(json!({
                    "success": false,
                    "restored": false,
                    "error": format!("No se pudo restaurar {}", bm.rel_dest)
                }));
            }
        } else if target_path.exists() {
            let _ = fs::remove_file(&target_path);
        }
    }

    let restored_label = {
        let _guard = REGISTRY_LOCK.lock().unwrap();
        let mut reg = load_registry_from(root);
        let mut label: Option<String> = None;
        for p in &mut reg.profiles {
            if same_provider(&p.provider, "agy") {
                let matches_prev = bundle.previous_email.as_deref().map_or(false, |prev| {
                    p.email
                        .as_deref()
                        .map_or(false, |em| em.eq_ignore_ascii_case(prev))
                });
                p.is_active = matches_prev;
                if matches_prev && label.is_none() {
                    label = Some(p.label.clone());
                }
            }
        }
        let _ = save_registry_to(root, &reg);
        label
            .or_else(|| bundle.previous_email.clone())
            .unwrap_or_else(|| "Antigravity".to_string())
    };

    Ok((bundle, restored_label))
}

pub(crate) fn cancel_account_login_flow_with(
    root: &Path,
    provider: &str,
    flow_id: Option<&str>,
    mappings: &[FileMapping],
    state_vscdb: Option<&Path>,
    cred_store: &dyn AntigravityCredStore,
    ops: &dyn LoginFlowOps,
) -> Value {
    let canon = canon_provider(provider);
    if canon != "agy" {
        return json!({
            "success": false,
            "restored": false,
            "error": format!("Cancelación de inicio de sesión no soportada para proveedor: {canon}")
        });
    }

    let Some(rollback_dir) = resolve_rollback_dir(root, flow_id) else {
        return json!({
            "success": false,
            "restored": false,
            "error": "No se encontró respaldo previo de inicio de sesión para restaurar."
        });
    };

    let (bundle, restored_label) = match restore_rollback_artifacts_from_dir(
        root,
        &rollback_dir,
        mappings,
        state_vscdb,
        cred_store,
    ) {
        Ok(res) => res,
        Err(err_val) => return err_val,
    };

    ops.invalidate_and_evict();
    if !bundle.quiesced_terminals.is_empty() {
        ops.respawn(
            &restored_label,
            bundle.previous_email.as_deref(),
            &bundle.quiesced_terminals,
        );
    }

    let _ = fs::remove_dir_all(&rollback_dir);
    let latest_path = root.join("_login_rollback").join("agy").join("latest.txt");
    if let Ok(latest) = fs::read_to_string(&latest_path) {
        if latest.trim() == bundle.flow_id {
            let _ = fs::remove_file(&latest_path);
        }
    }

    invalidate_detected_cli_accounts_cache();

    json!({
        "success": true,
        "restored": true,
        "restoredEmail": bundle.previous_email,
        "terminalsRestarted": bundle.quiesced_terminals.len(),
    })
}

pub fn cancel_account_login_flow_direct(provider: String, flow_id: Option<String>) -> Value {
    let canon = canon_provider(&provider);
    let mappings = get_provider_file_mappings(&canon);
    let state_vscdb = crate::quota::find_existing_state_vscdb();
    cancel_account_login_flow_with(
        &profiles_root(),
        &canon,
        flow_id.as_deref(),
        &mappings,
        state_vscdb.as_deref(),
        &LiveAntigravityCredStore,
        &LiveLoginFlowOps,
    )
}

pub async fn cancel_account_login_flow_impl(request: Option<Value>) -> Value {
    let req = crate::persist::body(&request);
    let provider = req
        .and_then(|r| r.get("provider"))
        .and_then(|v| v.as_str())
        .unwrap_or("antigravity")
        .to_string();
    let flow_id = req
        .and_then(|r| r.get("flowId").or_else(|| r.get("flow_id")))
        .and_then(|v| v.as_str())
        .map(String::from);

    tokio::task::spawn_blocking(move || cancel_account_login_flow_direct(provider, flow_id))
        .await
        .unwrap_or_else(|e| {
            json!({
                "success": false,
                "restored": false,
                "error": format!("Worker task failed: {e}")
            })
        })
}

pub(crate) fn probe_live_account_login_status_with(
    provider: &str,
    previous_email: Option<&str>,
    cred_store: &dyn AntigravityCredStore,
) -> Value {
    let canon = canon_provider(provider);
    if canon != "agy" {
        return json!({
            "provider": canon,
            "authenticated": false,
            "credentialStatus": "unsupported",
            "email": null,
            "hasRefreshToken": false,
            "sameAsPrevious": false,
        });
    }

    // Strictly check the live OS credential store; never fall back to stale IDE DBs or spawn CLI usage checks.
    let raw = cred_store.read_raw();
    let (credential_status, has_refresh_token, email) =
        crate::quota::inspect_raw_antigravity_credential_health(raw.as_deref());
    let authenticated = credential_status == "valid";
    let same_as_previous = match (&email, previous_email) {
        (Some(curr), Some(prev)) => curr.trim().eq_ignore_ascii_case(prev.trim()),
        _ => false,
    };

    json!({
        "provider": canon,
        "authenticated": authenticated,
        "credentialStatus": credential_status,
        "email": email,
        "hasRefreshToken": has_refresh_token,
        "sameAsPrevious": same_as_previous,
    })
}

pub async fn probe_live_account_login_status_impl(request: Option<Value>) -> Value {
    let req = crate::persist::body(&request);
    let provider = req
        .and_then(|r| r.get("provider"))
        .and_then(|v| v.as_str())
        .unwrap_or("antigravity")
        .to_string();
    let previous_email = req
        .and_then(|r| r.get("previousEmail").or_else(|| r.get("previous_email")))
        .and_then(|v| v.as_str())
        .map(String::from);

    tokio::task::spawn_blocking(move || {
        probe_live_account_login_status_with(
            &provider,
            previous_email.as_deref(),
            &LiveAntigravityCredStore,
        )
    })
    .await
    .unwrap_or_else(|e| {
        json!({
            "provider": "agy",
            "authenticated": false,
            "credentialStatus": "error",
            "email": null,
            "hasRefreshToken": false,
            "sameAsPrevious": false,
            "error": format!("Worker task failed: {e}")
        })
    })
}

pub fn prepare_new_account_login_direct(provider: String) -> Value {
    start_account_login_flow_direct(provider, false)
}

pub async fn prepare_new_account_login_impl(request: Option<Value>) -> Value {
    let req = crate::persist::body(&request);
    let provider = req
        .and_then(|r| r.get("provider"))
        .and_then(|v| v.as_str())
        .unwrap_or("antigravity")
        .to_string();
    tauri::async_runtime::spawn_blocking(move || prepare_new_account_login_direct(provider))
        .await
        .unwrap_or_else(|e| json!({ "success": false, "error": format!("Worker task failed: {e}") }))
}
