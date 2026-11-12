use crate::logger::log_trace;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use uuid::Uuid;

use super::quota::{get_cached_live_quota, LiveQuota};
use super::registry::{
    appdata_dir, canon_provider, hydrate_profile_credential_health, load_registry, now_ms,
    profile_storage_dir, profiles_root, same_provider, save_registry, user_home_dir,
    AccountProfilesRegistry, SavedAccountProfile, REGISTRY_LOCK,
};
use super::storage::{
    apply_profile_to_active, copy_atomic, decode_jwt_payload, ensure_provider_idle,
    get_provider_file_mappings, probe_live_provider_identity, snapshot_active_to_profile,
    terminate_provider_cli_processes, LiveIdentityProbe,
};

pub(crate) fn build_antigravity_auth_telemetry(live_ident: Option<&LiveIdentityProbe>) -> Value {
    let cred_ident = crate::quota::read_antigravity_credential();
    let ide_ident = crate::quota::read_antigravity_ide_identity();
    let explicit_api_key = crate::credentials::resolve_explicit_antigravity_api_key().is_some();
    let ambient_gemini_env = std::env::var("GEMINI_API_KEY")
        .ok()
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);

    let (auth_mode, auth_mode_label) = if explicit_api_key {
        ("api_key_override", "API Key (Anulación explícita)")
    } else if cred_ident.is_some() || live_ident.is_some() {
        ("oauth", "OAuth (Google)")
    } else {
        ("none", "Sin sesión")
    };

    let cred_email = cred_ident.as_ref().map(|(e, _)| e.clone());
    let ide_email = ide_ident.as_ref().map(|(e, _)| e.clone());
    let split_brain_warning = match (&cred_email, &ide_email) {
        (Some(c), Some(i)) if !c.eq_ignore_ascii_case(i) => Some(format!(
            "Credencial del sistema ({c}) no coincide con el estado del IDE ({i}). Cambia de cuenta o vuelve a guardar para sincronizar ambos."
        )),
        (None, Some(i)) => Some(format!(
            "Estado residual del IDE ({i}) sin token OAuth activo en el almacén del sistema."
        )),
        _ => None,
    };

    json!({
        "authMode": auth_mode,
        "authModeLabel": auth_mode_label,
        "credEmail": cred_email,
        "ideEmail": ide_email,
        "splitBrainWarning": split_brain_warning,
        "hasExplicitApiKeyOverride": explicit_api_key,
        "ambientGeminiApiKeyDetected": ambient_gemini_env
    })
}

pub(crate) fn reconcile_live_identity_with_registry(
    reg: &mut AccountProfilesRegistry,
    probe_target: &str,
    live_ident: Option<&LiveIdentityProbe>,
    live_q: Option<&LiveQuota>,
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
                    if should_be_active {
                        if let Some(q) = quota_matches_live {
                            if p.primary_remaining_percent != Some(q.percent)
                                || p.primary_reset_at != q.reset_at
                                || p.time_until_reset_ms != q.until_ms
                                || (q.plan.is_some() && p.plan_name != q.plan)
                            {
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

pub fn list_saved_accounts_direct(request: Option<Value>) -> Value {
    let req = crate::persist::body(&request);
    let provider = req
        .and_then(|r| r.get("provider"))
        .and_then(|v| v.as_str())
        .map(String::from);

    let canon_prov = provider.as_deref().map(canon_provider);
    let probe_target = canon_prov.clone().unwrap_or_else(|| "agy".to_string());
    let quota_key = if probe_target == "agy" { "antigravity" } else { &probe_target };

    // Direct synchronous live OS identity probe (fast, non-blocking).
    let live_ident = probe_live_provider_identity(&probe_target);

    // Check cached quota; invalidate immediately on email mismatch or external sign-out.
    // Never fall back to a synchronous `/usage` CLI subprocess here.
    let mut live_q = get_cached_live_quota(&probe_target);
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

    // Phase 2: reconcile live identity with registry (short lock).
    let _guard = REGISTRY_LOCK.lock().unwrap();
    let mut reg = load_registry();
    let (changed, unregistered_live_session) = reconcile_live_identity_with_registry(
        &mut reg,
        &probe_target,
        live_ident.as_ref(),
        live_q.as_ref(),
    );

    if changed {
        save_registry(&reg);
    }

    let auth_telemetry = if probe_target == "agy" {
        build_antigravity_auth_telemetry(live_ident.as_ref())
    } else {
        Value::Null
    };

    let filtered: Vec<SavedAccountProfile> = match canon_prov.as_deref() {
        Some(p) => reg.profiles.into_iter().filter(|a| same_provider(&a.provider, p)).collect(),
        None => reg.profiles,
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

pub fn save_current_account_profile_direct(provider: String, label: String) -> Value {
    let provider = canon_provider(&provider);
    if get_provider_file_mappings(&provider).is_empty() && provider != "agy" {
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

    let email = live_ident.as_ref().map(|i| i.email.clone())
        .or_else(|| live_q.as_ref().and_then(|q| q.email.clone()));

    let (plan_name, primary_remaining_percent, primary_reset_at, time_until_reset_ms) = match live_q {
        Some(q) => (q.plan, Some(q.percent), q.reset_at, q.until_ms),
        None => (None, None, None, None),
    };

    let _guard = REGISTRY_LOCK.lock().unwrap();
    let mut reg = load_registry();
    let now = now_ms();

    // Match strictly by email against reg.profiles
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

    // 1. Snapshot files to account storage; refuse to create an empty or tokenless profile.
    match snapshot_active_to_profile(&provider, &account_id) {
        Ok(true) => {}
        Ok(false) => {
            if existing_idx.is_none() {
                let _ = fs::remove_dir_all(profile_storage_dir(&provider, &account_id));
            }
            return json!({
                "success": false,
                "error": "No se encontraron archivos de sesión para guardar. ¿Iniciaste sesión en este proveedor?"
            });
        }
        Err(err) => {
            if existing_idx.is_none() {
                let _ = fs::remove_dir_all(profile_storage_dir(&provider, &account_id));
            }
            return json!({
                "success": false,
                "error": err
            });
        }
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
        hydrate_profile_credential_health(&profiles_root(), std::slice::from_mut(p));
        p.clone()
    } else {
        let mut new_prof = SavedAccountProfile {
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
            credential_status: None,
            has_refresh_token: false,
        };
        hydrate_profile_credential_health(&profiles_root(), std::slice::from_mut(&mut new_prof));
        reg.profiles.push(new_prof.clone());
        new_prof
    };

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

pub fn save_current_account_profile_impl(request: Option<Value>) -> Value {
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

    // 1. Persist latest state of active profile before leaving it, with live identity verification
    let live_ident = probe_live_provider_identity(&provider);
    if let Some(ref ident) = live_ident {
        let matching_live_idx = reg.profiles.iter().position(|p| {
            same_provider(&p.provider, &provider)
                && p.email.as_ref().map_or(false, |e| e.eq_ignore_ascii_case(&ident.email))
        });

        if let Some(l_idx) = matching_live_idx {
            let live_prof_id = reg.profiles[l_idx].id.clone();
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
    } else if let Some(active_prof) = reg.profiles.iter().find(|p| same_provider(&p.provider, &provider) && p.is_active) {
        if active_prof.id != account_id {
            if let Err(err) = snapshot_active_to_profile(&provider, &active_prof.id) {
                log_trace(&format!(
                    "account_switcher: could not snapshot active outgoing profile {}: {}",
                    active_prof.id, err
                ));
            }
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

    hydrate_profile_credential_health(&profiles_root(), std::slice::from_mut(&mut reg.profiles[idx]));
    let activated_profile = reg.profiles[idx].clone();
    // sibling sync decoupled
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

pub fn delete_account_profile_direct(provider: &str, account_id: &str) -> Value {
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

pub fn delete_account_profile_impl(request: Option<Value>) -> Value {
    let req = crate::persist::body(&request);
    let provider = req
        .and_then(|r| r.get("provider"))
        .and_then(|v| v.as_str())
        .unwrap_or("agy");
    let account_id = req
        .and_then(|r| r.get("accountId").or_else(|| r.get("account_id")))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    delete_account_profile_direct(provider, account_id)
}

pub fn get_active_account_profile_direct(provider: &str) -> Value {
    let canon_p = canon_provider(provider);
    let quota_key = if canon_p == "agy" { "antigravity" } else { &canon_p };

    let live_ident = probe_live_provider_identity(&canon_p);
    let mut live_q = get_cached_live_quota(&canon_p);
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

    let _guard = REGISTRY_LOCK.lock().unwrap();
    let mut reg = load_registry();
    let (changed, unregistered_live_session) = reconcile_live_identity_with_registry(
        &mut reg,
        &canon_p,
        live_ident.as_ref(),
        live_q.as_ref(),
    );
    if changed {
        save_registry(&reg);
    }

    let auth_telemetry = if canon_p == "agy" {
        build_antigravity_auth_telemetry(live_ident.as_ref())
    } else {
        Value::Null
    };

    if let Some(profile) = reg
        .profiles
        .iter()
        .find(|p| same_provider(&p.provider, &canon_p) && p.is_active)
    {
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

pub fn get_active_account_profile_impl(request: Option<Value>) -> Value {
    let req = crate::persist::body(&request);
    let provider = req
        .and_then(|r| r.get("provider"))
        .and_then(|v| v.as_str())
        .unwrap_or("agy");
    get_active_account_profile_direct(provider)
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

pub fn list_detected_cli_accounts_impl() -> Value {
    let home = user_home_dir();
    let appdata = appdata_dir();
    let mut accounts: Vec<DetectedCliAccount> = Vec::new();

    // 1. Antigravity (Google)
    {
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

        accounts.push(DetectedCliAccount {
            provider: "antigravity".into(),
            display_name: "Antigravity".into(),
            auth_state: auth_state.into(),
            account_label: email.clone().or(name).or_else(|| Some("Antigravity Account".into())),
            email,
            plan_name: get_cached_live_quota("agy").and_then(|q| q.plan),
            binary_path: bin,
            config_path: if source.is_empty() { None } else { Some(source.into()) },
            details: if source.is_empty() { None } else { Some(format!("Sesión detectada en {source}")) },
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

    // 7. Standalone Gemini CLI (isolated from Antigravity)
    {
        let bin = crate::chat::resolve_bin("gemini", &[])
            .map(|p| p.to_string_lossy().to_string());
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

        accounts.push(DetectedCliAccount {
            provider: "gemini".into(),
            display_name: "Gemini CLI".into(),
            auth_state: auth_state.into(),
            account_label: email
                .clone()
                .or_else(|| Some("Gemini CLI".into())),
            email,
            plan_name: get_cached_live_quota("gemini").and_then(|q| q.plan),
            binary_path: bin,
            config_path,
            details: if has_oauth {
                Some("Sesión OAuth CLI en ~/.gemini".into())
            } else {
                None
            },
        });
    }

    json!({
        "schemaVersion": 1,
        "accounts": accounts
    })
}

pub fn prepare_new_account_login_direct(provider: String) -> Value {
    let provider = canon_provider(&provider);
    if provider == "agy" {
        let live_ident = probe_live_provider_identity("agy");
        let previous_email = live_ident.as_ref().map(|i| i.email.clone());

        // 1. If active identity exists, snapshot/save it to vault first
        if let Some(ref em) = previous_email {
            let _ = save_current_account_profile_direct("agy".into(), em.clone());
        }

        // 2. Quiesce Kite terminals for agy
        crate::terminal::quiesce_provider_terminals("agy");

        // 3. Terminate running agy CLI processes so credentials are unlocked
        terminate_provider_cli_processes("agy");

        // 4. Clear generic credential from Windows Credential Manager
        let deleted = crate::quota::delete_antigravity_credential();

        // 5. Mark all agy profiles in profiles.json as is_active = false
        {
            let _guard = REGISTRY_LOCK.lock().unwrap();
            let mut reg = load_registry();
            for p in &mut reg.profiles {
                if same_provider(&p.provider, "agy") {
                    p.is_active = false;
                }
            }
            let _ = save_registry(&reg);
        }

        // 6. Invalidate antigravity quota cache
        crate::quota::invalidate_provider_cache("antigravity");

        json!({
            "success": true,
            "previousEmailSaved": previous_email,
            "loginCommand": "agy",
            "keyringDeleted": deleted
        })
    } else {
        json!({
            "success": false,
            "error": format!("Preparación de nuevo login no soportada para proveedor: {provider}")
        })
    }
}

pub fn prepare_new_account_login_impl(request: Option<Value>) -> Value {
    let req = crate::persist::body(&request);
    let provider = req
        .and_then(|r| r.get("provider"))
        .and_then(|v| v.as_str())
        .unwrap_or("antigravity")
        .to_string();
    prepare_new_account_login_direct(provider)
}
