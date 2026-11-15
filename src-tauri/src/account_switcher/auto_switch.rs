use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use super::commands::{
    get_auto_switch_runtime_status, models_match_exact_or_base, pick_suggested_fallback_model,
    rank_auto_switch_candidates_in, set_auto_switch_runtime_status,
    switch_account_profile_direct_with_options, sync_active_profile_capabilities_in,
    RankedSwitchCandidate,
};
use super::registry::{
    canon_provider, get_auto_switch_policy_in, load_registry_from, now_ms, profiles_root,
    same_provider, AutoSwitchPolicy, AutoSwitchRuntimeStatus, SavedAccountProfile,
};
use super::storage::{inspect_external_provider_processes, ExternalProcessInspection};
use crate::quota::{format_unix_to_rfc3339, parse_rfc3339_ms, ProviderQuotaStatus};
use crate::terminal::{
    inspect_provider_sessions, ProviderSessionSummary, ProviderSessionsInspection,
};
use uuid::Uuid;

pub const ROLLING_SWITCH_WINDOW_MS: i64 = 600_000;
pub const PENDING_CONFIRMATION_TTL_MS: i64 = 15 * 60_000;
const FAILED_TARGET_MIN_COOLDOWN_SECONDS: u64 = 30;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PendingAutoSwitchConfirmation {
    pub confirmation_id: String,
    pub provider: String,
    pub from_account_id: Option<String>,
    pub from_account_label: String,
    pub from_email: Option<String>,
    pub to_account_id: String,
    pub to_account_label: String,
    pub to_email: Option<String>,
    pub to_plan_name: Option<String>,
    pub source_plan_name: Option<String>,
    pub requested_model: Option<String>,
    pub suggested_fallback_model: Option<String>,
    pub available_target_models: Vec<String>,
    pub thread_id: Option<String>,
    pub handoff_prompt: Option<String>,
    pub busy_sessions: Vec<ProviderSessionSummary>,
    pub reason: String,
    pub created_at_unix_ms: i64,
    pub expires_at_unix_ms: i64,
}

/// Injectable dependency boundary so coordinator evaluations can be tested hermetically
/// in temp directories without spawning OS tools or requiring a live Tauri `AppHandle`.
pub trait AutoSwitchEnv {
    fn profiles_root(&self) -> PathBuf;
    fn inspect_external(&self, provider: &str) -> ExternalProcessInspection;
    fn inspect_sessions(&self, provider: &str) -> ProviderSessionsInspection;
    fn execute_switch(&self, provider: &str, account_id: &str, force_busy: bool) -> Value;
    fn get_runtime_status(&self, provider: &str) -> AutoSwitchRuntimeStatus;
    fn set_runtime_status(&self, provider: &str, status: AutoSwitchRuntimeStatus);
    fn emit_event(&self, event: &str, payload: Value);
    fn upsert_confirmation_notification(&self, confirmation: &PendingAutoSwitchConfirmation) {
        let _ = confirmation;
    }
    fn resolve_confirmation_notifications(&self, confirmation_ids: &[String], resolution: &str) {
        let _ = (confirmation_ids, resolution);
    }
}

#[derive(Debug, Default)]
pub struct LiveAutoSwitchEnv;

impl AutoSwitchEnv for LiveAutoSwitchEnv {
    fn profiles_root(&self) -> PathBuf {
        profiles_root()
    }

    fn inspect_external(&self, provider: &str) -> ExternalProcessInspection {
        inspect_external_provider_processes(provider)
    }

    fn inspect_sessions(&self, provider: &str) -> ProviderSessionsInspection {
        inspect_provider_sessions(provider)
    }

    fn execute_switch(&self, provider: &str, account_id: &str, force_busy: bool) -> Value {
        switch_account_profile_direct_with_options(
            provider.to_string(),
            account_id.to_string(),
            force_busy,
        )
    }

    fn get_runtime_status(&self, provider: &str) -> AutoSwitchRuntimeStatus {
        get_auto_switch_runtime_status(provider)
    }

    fn set_runtime_status(&self, provider: &str, status: AutoSwitchRuntimeStatus) {
        set_auto_switch_runtime_status(provider, status);
    }

    fn emit_event(&self, event: &str, payload: Value) {
        emit_tauri_event(event, payload);
    }

    fn upsert_confirmation_notification(&self, confirmation: &PendingAutoSwitchConfirmation) {
        crate::notifications::upsert_auto_switch_confirmation_notification(confirmation);
    }

    fn resolve_confirmation_notifications(&self, confirmation_ids: &[String], resolution: &str) {
        crate::notifications::resolve_auto_switch_notifications_for_ids(
            confirmation_ids,
            resolution,
        );
    }
}

#[derive(Debug, Default, Clone)]
pub struct AutoSwitchCoordinatorState {
    pub last_switch_unix_ms: HashMap<String, i64>,
    pub recent_switches_ms: HashMap<String, Vec<i64>>,
    pub target_cooldown_until_ms: HashMap<(String, String), i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AutoSwitchTriggerRequest {
    pub provider: String,
    pub trigger_source: String,
    pub requested_model: Option<String>,
    pub thread_id: Option<String>,
    pub current_remaining_percent: Option<f64>,
    pub has_exhausted_window: bool,
    pub now_unix_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AutoSwitchOutcome {
    Disabled,
    NotExhausted,
    SkippedCooldown {
        status: AutoSwitchRuntimeStatus,
    },
    Paused {
        status: AutoSwitchRuntimeStatus,
    },
    NeedsConfirmation {
        provider: String,
        from_account_id: Option<String>,
        from_account_label: String,
        from_email: Option<String>,
        source_plan_name: Option<String>,
        candidate: RankedSwitchCandidate,
        reason: String,
        requested_model: Option<String>,
        thread_id: Option<String>,
        busy_sessions: Vec<ProviderSessionSummary>,
        trigger_source: String,
    },
    Switched {
        provider: String,
        from_account_id: Option<String>,
        from_account_label: String,
        to_account_id: String,
        to_account_label: String,
        to_email: Option<String>,
        to_plan: Option<String>,
        requested_model: Option<String>,
        applied_model: Option<String>,
        model_adjusted: bool,
        auto_continue_chat_turn: bool,
        compatibility: String,
        status: AutoSwitchRuntimeStatus,
    },
    Failed {
        code: String,
        error: String,
        status: AutoSwitchRuntimeStatus,
    },
}

static AUTO_SWITCH_EVAL_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static AUTO_SWITCH_COORDINATOR_STATE: OnceLock<Mutex<AutoSwitchCoordinatorState>> = OnceLock::new();
static PENDING_AUTO_SWITCHES: OnceLock<Mutex<Vec<PendingAutoSwitchConfirmation>>> = OnceLock::new();

pub(crate) fn auto_switch_coordinator_lock() -> &'static Mutex<()> {
    AUTO_SWITCH_EVAL_LOCK.get_or_init(|| Mutex::new(()))
}

pub(crate) fn auto_switch_coordinator_state() -> &'static Mutex<AutoSwitchCoordinatorState> {
    AUTO_SWITCH_COORDINATOR_STATE.get_or_init(|| Mutex::new(AutoSwitchCoordinatorState::default()))
}

pub(crate) fn pending_auto_switches_store() -> &'static Mutex<Vec<PendingAutoSwitchConfirmation>> {
    PENDING_AUTO_SWITCHES.get_or_init(|| Mutex::new(Vec::new()))
}

#[cfg(not(test))]
pub(crate) fn emit_tauri_event(event: &str, payload: Value) {
    if let Some(app) = crate::get_app_handle() {
        use tauri::Emitter;
        let _ = app.emit(event, payload);
    }
}

#[cfg(test)]
pub(crate) fn emit_tauri_event(_event: &str, _payload: Value) {}

#[cfg_attr(test, allow(dead_code))]
pub(crate) fn emit_auto_switch_status_event(provider: &str, status: &AutoSwitchRuntimeStatus) {
    let canon = canon_provider(provider);
    emit_tauri_event(
        "kite://auto-switch-status",
        json!({
            "provider": canon,
            "status": status,
        }),
    );
}

fn emit_status_via_env<E: AutoSwitchEnv>(env: &E, canon: &str, status: &AutoSwitchRuntimeStatus) {
    env.set_runtime_status(canon, status.clone());
    env.emit_event(
        "kite://auto-switch-status",
        json!({
            "provider": canon,
            "status": status,
        }),
    );
}

fn consider_reset_candidate(
    best: &mut Option<(i64, Option<String>)>,
    resets_at: Option<&String>,
    time_until_reset_ms: Option<i64>,
    recorded_at_ms: i64,
    now_unix_ms: i64,
) {
    let remaining_ms = if let Some(ttl) = time_until_reset_ms.filter(|v| *v > 0) {
        let elapsed = if recorded_at_ms > 0 && now_unix_ms >= recorded_at_ms {
            now_unix_ms - recorded_at_ms
        } else {
            0
        };
        let rem = ttl - elapsed;
        if rem > 0 {
            Some(rem)
        } else {
            None
        }
    } else {
        None
    }
    .or_else(|| {
        resets_at
            .and_then(|ts| parse_rfc3339_ms(ts))
            .and_then(|reset_epoch| {
                let rem = reset_epoch - now_unix_ms;
                if rem > 0 {
                    Some(rem)
                } else {
                    None
                }
            })
    });

    let Some(rem) = remaining_ms else {
        return;
    };
    let label = resets_at
        .cloned()
        .or_else(|| Some(format_unix_to_rfc3339(now_unix_ms + rem)));

    let replace = match best {
        Some((best_ms, _)) => rem < *best_ms,
        None => true,
    };
    if replace {
        *best = Some((rem, label));
    }
}

fn compute_earliest_reset_eta(
    profiles: &[SavedAccountProfile],
    canon: &str,
    policy: &AutoSwitchPolicy,
    now_unix_ms: i64,
) -> (Option<String>, Option<i64>) {
    let mut best: Option<(i64, Option<String>)> = None;
    for p in profiles {
        if !same_provider(&p.provider, canon) {
            continue;
        }
        if policy.excluded_account_ids.iter().any(|id| id == &p.id) {
            continue;
        }
        consider_reset_candidate(
            &mut best,
            p.primary_reset_at.as_ref(),
            p.time_until_reset_ms,
            p.last_used_unix_ms,
            now_unix_ms,
        );
        for w in &p.quota_windows {
            consider_reset_candidate(
                &mut best,
                w.resets_at.as_ref(),
                w.time_until_reset_ms,
                w.updated_at_unix_ms,
                now_unix_ms,
            );
        }
    }
    match best {
        Some((ms, at)) => (at, Some(ms)),
        None => (None, None),
    }
}

fn clear_provider_state(state: &mut AutoSwitchCoordinatorState, canon: &str) {
    state.last_switch_unix_ms.remove(canon);
    state.recent_switches_ms.remove(canon);
    state.target_cooldown_until_ms.retain(|(p, _), _| p != canon);
}

pub(crate) fn drain_pending_confirmations_for_provider(
    canon: &str,
    store: &Mutex<Vec<PendingAutoSwitchConfirmation>>,
) -> Vec<String> {
    let mut items = store.lock().unwrap();
    let mut removed_ids = Vec::new();
    items.retain(|c| {
        if c.provider == canon {
            removed_ids.push(c.confirmation_id.clone());
            false
        } else {
            true
        }
    });
    removed_ids
}

#[cfg(test)]
pub(crate) fn clear_pending_confirmations_for_provider_global(provider: &str) {
    let canon = canon_provider(provider);
    if !canon.trim().is_empty() {
        let _ = drain_pending_confirmations_for_provider(&canon, pending_auto_switches_store());
    }
}

pub fn on_manual_switch_with_store<E: AutoSwitchEnv>(
    provider: &str,
    state: &mut AutoSwitchCoordinatorState,
    store: &Mutex<Vec<PendingAutoSwitchConfirmation>>,
    env: &E,
) {
    let canon = canon_provider(provider);
    if canon.trim().is_empty() {
        return;
    }
    clear_provider_state(state, &canon);
    let cleared = AutoSwitchRuntimeStatus::default();
    emit_status_via_env(env, &canon, &cleared);
    let drained_ids = drain_pending_confirmations_for_provider(&canon, store);
    env.resolve_confirmation_notifications(&drained_ids, "abandoned");
}

pub fn on_manual_switch_with<E: AutoSwitchEnv>(
    provider: &str,
    state: &mut AutoSwitchCoordinatorState,
    env: &E,
) {
    on_manual_switch_with_store(provider, state, pending_auto_switches_store(), env);
}

/// Atomically clears coordinator state, runtime pause/cooldown fields, and emits updated status.
pub fn resume_auto_switch_state(provider: &str) -> AutoSwitchRuntimeStatus {
    let canon = canon_provider(provider);
    if canon.trim().is_empty() {
        return AutoSwitchRuntimeStatus::default();
    }
    let env = LiveAutoSwitchEnv;
    let (status, drained_ids) = {
        let _eval_guard = auto_switch_coordinator_lock().lock().unwrap();
        let mut state = auto_switch_coordinator_state().lock().unwrap();
        clear_provider_state(&mut state, &canon);
        let cleared = AutoSwitchRuntimeStatus::default();
        emit_status_via_env(&env, &canon, &cleared);
        let ids = drain_pending_confirmations_for_provider(&canon, pending_auto_switches_store());
        (env.get_runtime_status(&canon), ids)
    };
    env.resolve_confirmation_notifications(&drained_ids, "abandoned");
    status
}

/// Atomically clears pause/cooldown/error flags under `auto_switch_coordinator_lock`
/// when auto-switch policy is disabled, preventing in-flight evaluations from re-pausing.
pub fn clear_runtime_pause_on_policy_disable(provider: &str) -> AutoSwitchRuntimeStatus {
    let canon = canon_provider(provider);
    if canon.trim().is_empty() {
        return AutoSwitchRuntimeStatus::default();
    }
    let env = LiveAutoSwitchEnv;
    let (status, drained_ids) = {
        let _eval_guard = auto_switch_coordinator_lock().lock().unwrap();
        let _state = auto_switch_coordinator_state().lock().unwrap();
        let mut status = env.get_runtime_status(&canon);
        status.paused = false;
        status.pause_reason = None;
        status.cooldown_until_ms = None;
        status.last_error_code = None;
        status.residual_process_count = None;
        status.base_app_titles.clear();
        emit_status_via_env(&env, &canon, &status);
        let ids = drain_pending_confirmations_for_provider(&canon, pending_auto_switches_store());
        (status, ids)
    };
    env.resolve_confirmation_notifications(&drained_ids, "abandoned");
    status
}

/// Clears coordinator pause, rolling switch history, and cooldowns after a user-initiated
/// manual switch so the user always retains direct override control.
pub fn reset_auto_switch_state_on_manual_switch(provider: &str) {
    let _ = resume_auto_switch_state(provider);
}

pub fn evaluate_auto_switch_with<E: AutoSwitchEnv>(
    req: &AutoSwitchTriggerRequest,
    state: &mut AutoSwitchCoordinatorState,
    env: &E,
) -> AutoSwitchOutcome {
    let canon = canon_provider(&req.provider);
    if canon.trim().is_empty() {
        return AutoSwitchOutcome::Disabled;
    }

    let root = env.profiles_root();
    let policy = get_auto_switch_policy_in(&root, &canon);
    if !policy.enabled {
        return AutoSwitchOutcome::Disabled;
    }

    // 2. Healthy quota-poll evaluation never triggers a switch, and only auto-clears
    // recovery-eligible pause reasons (never `CIRCUIT_BREAKER_PAUSED`).
    if req.trigger_source == "quota_poll"
        && req.current_remaining_percent.unwrap_or(100.0) > policy.trigger_threshold_percent
        && !req.has_exhausted_window
    {
        let prev = env.get_runtime_status(&canon);
        if prev.paused && prev.pause_reason.as_deref() == Some("ALL_ACCOUNTS_EXHAUSTED") {
            state.target_cooldown_until_ms.retain(|(p, _), _| p != &canon);
            let cleared = AutoSwitchRuntimeStatus {
                paused: false,
                pause_reason: None,
                cooldown_until_ms: prev.cooldown_until_ms,
                recent_switch_count: prev.recent_switch_count,
                next_reset_at: None,
                next_reset_ms: None,
                last_error_code: None,
                residual_process_count: None,
                base_app_titles: Vec::new(),
            };
            emit_status_via_env(env, &canon, &cleared);
        }
        return AutoSwitchOutcome::NotExhausted;
    }

    let reg = {
        let _guard = super::registry::REGISTRY_LOCK.lock().unwrap();
        load_registry_from(&root)
    };
    let prev_status = env.get_runtime_status(&canon);

    // 3. Rolling 10-minute circuit breaker.
    let window_start = req.now_unix_ms - ROLLING_SWITCH_WINDOW_MS;
    if let Some(entries) = state.recent_switches_ms.get_mut(&canon) {
        entries.retain(|ts| *ts >= window_start);
    }
    let recent_len = state
        .recent_switches_ms
        .get(&canon)
        .map(|v| v.len())
        .unwrap_or(0);

    let breaker_already_paused =
        prev_status.paused && prev_status.pause_reason.as_deref() == Some("CIRCUIT_BREAKER_PAUSED");
    if breaker_already_paused || recent_len >= policy.max_consecutive_switches as usize {
        let (next_reset_at, next_reset_ms) =
            compute_earliest_reset_eta(&reg.profiles, &canon, &policy, req.now_unix_ms);
        let status = AutoSwitchRuntimeStatus {
            paused: true,
            pause_reason: Some("CIRCUIT_BREAKER_PAUSED".to_string()),
            cooldown_until_ms: prev_status.cooldown_until_ms,
            recent_switch_count: if breaker_already_paused {
                (recent_len as u32).max(prev_status.recent_switch_count)
            } else {
                recent_len as u32
            },
            next_reset_at,
            next_reset_ms,
            last_error_code: None,
            residual_process_count: None,
            base_app_titles: Vec::new(),
        };
        emit_status_via_env(env, &canon, &status);
        return AutoSwitchOutcome::Paused { status };
    }

    // Prune expired target cooldowns before evaluating provider cooldown & ranking.
    state
        .target_cooldown_until_ms
        .retain(|_, until| *until > req.now_unix_ms);

    // 4. Provider switch cooldown check.
    if policy.cooldown_seconds > 0 {
        if let Some(&last_ms) = state.last_switch_unix_ms.get(&canon) {
            let cooldown_until = last_ms + (policy.cooldown_seconds as i64) * 1000;
            if req.now_unix_ms < cooldown_until {
                let status = AutoSwitchRuntimeStatus {
                    paused: false,
                    pause_reason: None,
                    cooldown_until_ms: Some(cooldown_until),
                    recent_switch_count: recent_len as u32,
                    next_reset_at: None,
                    next_reset_ms: None,
                    last_error_code: prev_status.last_error_code,
                    residual_process_count: None,
                    base_app_titles: Vec::new(),
                };
                emit_status_via_env(env, &canon, &status);
                return AutoSwitchOutcome::SkippedCooldown { status };
            }
        }
    }

    // Active source profile metadata for outcome & notification payloads.
    let active_source = reg
        .profiles
        .iter()
        .find(|p| same_provider(&p.provider, &canon) && p.is_active)
        .cloned();
    let from_account_id = active_source.as_ref().map(|p| p.id.clone());
    let from_account_label = active_source
        .as_ref()
        .map(|p| p.label.clone())
        .unwrap_or_default();
    let from_email = active_source.as_ref().and_then(|p| p.email.clone());
    let source_plan_name = active_source.as_ref().and_then(|p| p.plan_name.clone());

    // 5. Rank eligible fallback candidates.
    let provider_target_cooldowns: HashMap<String, i64> = state
        .target_cooldown_until_ms
        .iter()
        .filter(|((p, _), until)| p == &canon && **until > req.now_unix_ms)
        .map(|((_, id), until)| (id.clone(), *until))
        .collect();

    let mut candidates = rank_auto_switch_candidates_in(
        &root,
        &canon,
        req.requested_model.as_deref(),
        &policy,
        &provider_target_cooldowns,
        req.now_unix_ms,
    );

    if candidates.is_empty() {
        let (next_reset_at, next_reset_ms) =
            compute_earliest_reset_eta(&reg.profiles, &canon, &policy, req.now_unix_ms);
        let status = AutoSwitchRuntimeStatus {
            paused: true,
            pause_reason: Some("ALL_ACCOUNTS_EXHAUSTED".to_string()),
            cooldown_until_ms: None,
            recent_switch_count: recent_len as u32,
            next_reset_at,
            next_reset_ms,
            last_error_code: None,
            residual_process_count: None,
            base_app_titles: Vec::new(),
        };
        emit_status_via_env(env, &canon, &status);
        return AutoSwitchOutcome::Paused { status };
    }

    let best = candidates.remove(0);

    // 6. Inspect external provider apps/processes and managed Kite PTY terminals.
    let external = env.inspect_external(&canon);
    if external.state == "base_app_open" {
        let status = AutoSwitchRuntimeStatus {
            paused: true,
            pause_reason: Some("IDE_PROCESS_BUSY".to_string()),
            cooldown_until_ms: None,
            recent_switch_count: recent_len as u32,
            next_reset_at: None,
            next_reset_ms: None,
            last_error_code: Some("PROVIDER_BUSY".to_string()),
            residual_process_count: None,
            base_app_titles: external.base_app_titles,
        };
        emit_status_via_env(env, &canon, &status);
        return AutoSwitchOutcome::Paused { status };
    }
    if external.state == "residual_only" {
        let status = AutoSwitchRuntimeStatus {
            paused: true,
            pause_reason: Some("RESIDUAL_PROCESSES_BLOCKING".to_string()),
            cooldown_until_ms: None,
            recent_switch_count: recent_len as u32,
            next_reset_at: None,
            next_reset_ms: None,
            last_error_code: Some("PROVIDER_BUSY".to_string()),
            residual_process_count: Some(external.residual_processes.len()),
            base_app_titles: Vec::new(),
        };
        emit_status_via_env(env, &canon, &status);
        return AutoSwitchOutcome::Paused { status };
    }

    let sessions = env.inspect_sessions(&canon);
    let mut force_busy = false;
    if !sessions.managed_busy.is_empty() {
        match policy.busy_terminals_policy.as_str() {
            "ask" => {
                return AutoSwitchOutcome::NeedsConfirmation {
                    provider: canon,
                    from_account_id,
                    from_account_label,
                    from_email,
                    source_plan_name,
                    candidate: best,
                    reason: "busy_terminals_ask".to_string(),
                    requested_model: req.requested_model.clone(),
                    thread_id: req.thread_id.clone(),
                    busy_sessions: sessions.managed_busy,
                    trigger_source: req.trigger_source.clone(),
                };
            }
            "interrupt" => {
                force_busy = true;
            }
            _ => {
                let status = AutoSwitchRuntimeStatus {
                    paused: true,
                    pause_reason: Some("BUSY_TERMINALS_DEFERRED".to_string()),
                    cooldown_until_ms: None,
                    recent_switch_count: recent_len as u32,
                    next_reset_at: None,
                    next_reset_ms: None,
                    last_error_code: None,
                    residual_process_count: None,
                    base_app_titles: Vec::new(),
                };
                emit_status_via_env(env, &canon, &status);
                return AutoSwitchOutcome::Paused { status };
            }
        }
    }

    // 7. Model compatibility gate before touching live credentials.
    if (best.compatibility == "model_mismatch" || best.compatibility == "unverified_catalog")
        && policy.model_mismatch_policy == "confirm_notification"
    {
        return AutoSwitchOutcome::NeedsConfirmation {
            provider: canon,
            from_account_id,
            from_account_label,
            from_email,
            source_plan_name,
            reason: best.compatibility.clone(),
            candidate: best,
            requested_model: req.requested_model.clone(),
            thread_id: req.thread_id.clone(),
            busy_sessions: Vec::new(),
            trigger_source: req.trigger_source.clone(),
        };
    }

    // 8. Execute credential switch.
    let res = env.execute_switch(&canon, &best.profile.id, force_busy);
    let succeeded = res
        .get("success")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if !succeeded {
        let code = res
            .get("code")
            .and_then(|v| v.as_str())
            .unwrap_or("SWITCH_FAILED")
            .to_string();

        if code == "PROVIDER_BUSY" {
            let status = apply_provider_busy_pause(env, &canon, &res, recent_len);
            return AutoSwitchOutcome::Paused { status };
        }

        let err_msg = res
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("Account switch failed.")
            .to_string();
        let target_cd_ms =
            (policy.cooldown_seconds.max(FAILED_TARGET_MIN_COOLDOWN_SECONDS) as i64) * 1000;
        state
            .target_cooldown_until_ms
            .insert((canon.clone(), best.profile.id.clone()), req.now_unix_ms + target_cd_ms);

        let status = AutoSwitchRuntimeStatus {
            paused: false,
            pause_reason: None,
            cooldown_until_ms: None,
            recent_switch_count: recent_len as u32,
            next_reset_at: None,
            next_reset_ms: None,
            last_error_code: Some(code.clone()),
            residual_process_count: None,
            base_app_titles: Vec::new(),
        };
        emit_status_via_env(env, &canon, &status);
        return AutoSwitchOutcome::Failed {
            code,
            error: err_msg,
            status,
        };
    }

    let status = record_successful_switch_in_state(
        env,
        state,
        &canon,
        from_account_id.as_deref(),
        &policy,
        req.now_unix_ms,
    );

    let (applied_model, model_adjusted) = if best.compatibility == "model_mismatch"
        && policy.model_mismatch_policy == "auto_fallback"
        && best.suggested_fallback_model.is_some()
    {
        let fallback = best.suggested_fallback_model.clone();
        let changed = fallback.as_deref() != req.requested_model.as_deref();
        (fallback, changed)
    } else {
        (req.requested_model.clone(), false)
    };

    env.emit_event(
        "kite://auto-switch-executed",
        json!({
            "provider": canon,
            "fromAccountId": from_account_id,
            "fromAccountLabel": from_account_label,
            "toAccountId": best.profile.id,
            "toAccountLabel": best.profile.label,
            "appliedModel": applied_model,
            "modelAdjusted": model_adjusted,
            "autoContinueChatTurn": policy.auto_continue_chat_turn,
            "compatibility": best.compatibility,
            "triggerSource": req.trigger_source,
            "threadId": req.thread_id,
        }),
    );

    AutoSwitchOutcome::Switched {
        provider: canon,
        from_account_id,
        from_account_label,
        to_account_id: best.profile.id,
        to_account_label: best.profile.label,
        to_email: best.profile.email,
        to_plan: best.profile.plan_name,
        requested_model: req.requested_model.clone(),
        applied_model,
        model_adjusted,
        auto_continue_chat_turn: policy.auto_continue_chat_turn,
        compatibility: best.compatibility,
        status,
    }
}

fn apply_provider_busy_pause<E: AutoSwitchEnv>(
    env: &E,
    canon: &str,
    res: &Value,
    recent_len: usize,
) -> AutoSwitchRuntimeStatus {
    let busy_kind = res
        .get("providerBusyKind")
        .and_then(|v| v.as_str())
        .unwrap_or("base_app_open");
    let status = if busy_kind == "residual_only" {
        let count = res
            .get("residualProcessCount")
            .and_then(|v| v.as_u64())
            .map(|c| c as usize)
            .or_else(|| {
                res.get("residualProcesses")
                    .and_then(|v| v.as_array())
                    .map(|arr| arr.len())
            });
        AutoSwitchRuntimeStatus {
            paused: true,
            pause_reason: Some("RESIDUAL_PROCESSES_BLOCKING".to_string()),
            cooldown_until_ms: None,
            recent_switch_count: recent_len as u32,
            next_reset_at: None,
            next_reset_ms: None,
            last_error_code: Some("PROVIDER_BUSY".to_string()),
            residual_process_count: count,
            base_app_titles: Vec::new(),
        }
    } else {
        let titles = res
            .get("baseAppTitles")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|item| item.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        AutoSwitchRuntimeStatus {
            paused: true,
            pause_reason: Some("IDE_PROCESS_BUSY".to_string()),
            cooldown_until_ms: None,
            recent_switch_count: recent_len as u32,
            next_reset_at: None,
            next_reset_ms: None,
            last_error_code: Some("PROVIDER_BUSY".to_string()),
            residual_process_count: None,
            base_app_titles: titles,
        }
    };
    emit_status_via_env(env, canon, &status);
    status
}

fn record_successful_switch_in_state<E: AutoSwitchEnv>(
    env: &E,
    state: &mut AutoSwitchCoordinatorState,
    canon: &str,
    from_account_id: Option<&str>,
    policy: &AutoSwitchPolicy,
    now_unix_ms: i64,
) -> AutoSwitchRuntimeStatus {
    state
        .last_switch_unix_ms
        .insert(canon.to_string(), now_unix_ms);
    let recent_vec = state.recent_switches_ms.entry(canon.to_string()).or_default();
    recent_vec.push(now_unix_ms);
    let recent_count = recent_vec.len() as u32;

    let cooldown_ms = (policy.cooldown_seconds as i64) * 1000;
    let cooldown_until_ms = if cooldown_ms > 0 {
        Some(now_unix_ms + cooldown_ms)
    } else {
        None
    };
    if let Some(src_id) = from_account_id {
        if cooldown_ms > 0 {
            state
                .target_cooldown_until_ms
                .insert((canon.to_string(), src_id.to_string()), now_unix_ms + cooldown_ms);
        }
    }

    let status = AutoSwitchRuntimeStatus {
        paused: false,
        pause_reason: None,
        cooldown_until_ms,
        recent_switch_count: recent_count,
        next_reset_at: None,
        next_reset_ms: None,
        last_error_code: None,
        residual_process_count: None,
        base_app_titles: Vec::new(),
    };
    emit_status_via_env(env, canon, &status);
    status
}

fn prune_expired_confirmations(
    items: &mut Vec<PendingAutoSwitchConfirmation>,
    now_unix_ms: i64,
) -> Vec<String> {
    let mut expired_ids = Vec::new();
    items.retain(|c| {
        if now_unix_ms > c.expires_at_unix_ms {
            expired_ids.push(c.confirmation_id.clone());
            false
        } else {
            true
        }
    });
    expired_ids
}

fn build_pending_confirmation_from_outcome(
    outcome: &AutoSwitchOutcome,
    handoff_prompt: Option<String>,
    now_unix_ms: i64,
) -> Option<PendingAutoSwitchConfirmation> {
    let AutoSwitchOutcome::NeedsConfirmation {
        provider,
        from_account_id,
        from_account_label,
        from_email,
        source_plan_name,
        candidate,
        reason,
        requested_model,
        thread_id,
        busy_sessions,
        ..
    } = outcome
    else {
        return None;
    };

    let canon = canon_provider(provider);
    if canon.trim().is_empty() {
        return None;
    }

    Some(PendingAutoSwitchConfirmation {
        confirmation_id: format!("asc_{}", Uuid::new_v4().simple()),
        provider: canon,
        from_account_id: from_account_id.clone(),
        from_account_label: from_account_label.clone(),
        from_email: from_email.clone(),
        to_account_id: candidate.profile.id.clone(),
        to_account_label: candidate.profile.label.clone(),
        to_email: candidate.profile.email.clone(),
        to_plan_name: candidate.profile.plan_name.clone(),
        source_plan_name: source_plan_name.clone(),
        requested_model: requested_model.clone(),
        suggested_fallback_model: candidate.suggested_fallback_model.clone(),
        available_target_models: candidate.available_target_models.clone(),
        thread_id: thread_id.clone(),
        handoff_prompt: handoff_prompt.filter(|s| !s.trim().is_empty()),
        busy_sessions: busy_sessions.clone(),
        reason: reason.clone(),
        created_at_unix_ms: now_unix_ms,
        expires_at_unix_ms: now_unix_ms.saturating_add(PENDING_CONFIRMATION_TTL_MS),
    })
}

pub(crate) fn publish_confirmation_record_in<E: AutoSwitchEnv>(
    incoming: PendingAutoSwitchConfirmation,
    now_unix_ms: i64,
    store: &Mutex<Vec<PendingAutoSwitchConfirmation>>,
    env: &E,
) -> PendingAutoSwitchConfirmation {
    let (saved, expired_ids) = {
        let mut items = store.lock().unwrap();
        let expired_ids = prune_expired_confirmations(&mut items, now_unix_ms);

        // Deduplicate by (provider, to_account_id, reason, thread_id), while allowing a
        // thread-enriched confirmation and a generic quota_poll confirmation to merge
        // instead of creating duplicate confirmation cards.
        let match_idx = items
            .iter()
            .position(|c| {
                c.provider == incoming.provider
                    && c.to_account_id == incoming.to_account_id
                    && c.reason == incoming.reason
                    && c.thread_id == incoming.thread_id
            })
            .or_else(|| {
                if incoming.thread_id.is_some() {
                    items.iter().position(|c| {
                        c.provider == incoming.provider
                            && c.to_account_id == incoming.to_account_id
                            && c.reason == incoming.reason
                            && c.thread_id.is_none()
                    })
                } else {
                    items.iter().position(|c| {
                        c.provider == incoming.provider
                            && c.to_account_id == incoming.to_account_id
                            && c.reason == incoming.reason
                    })
                }
            });

        let saved = if let Some(idx) = match_idx {
            let existing = items.remove(idx);
            let mut merged = incoming;
            merged.confirmation_id = existing.confirmation_id;
            merged.thread_id = merged.thread_id.or(existing.thread_id);
            merged.handoff_prompt = merged.handoff_prompt.or(existing.handoff_prompt);
            merged.source_plan_name = merged.source_plan_name.or(existing.source_plan_name);
            merged.from_account_id = merged.from_account_id.or(existing.from_account_id);
            merged.from_email = merged.from_email.or(existing.from_email);
            merged.requested_model = merged.requested_model.or(existing.requested_model);
            merged.suggested_fallback_model = merged
                .suggested_fallback_model
                .or(existing.suggested_fallback_model);
            if merged.available_target_models.is_empty() {
                merged.available_target_models = existing.available_target_models;
            }
            if merged.busy_sessions.is_empty() && merged.reason == "busy_terminals_ask" {
                merged.busy_sessions = existing.busy_sessions;
            }
            items.insert(0, merged.clone());
            merged
        } else {
            items.insert(0, incoming.clone());
            incoming
        };

        (saved, expired_ids)
    };

    env.resolve_confirmation_notifications(&expired_ids, "abandoned");
    env.upsert_confirmation_notification(&saved);
    env.emit_event(
        "kite://auto-switch-confirmation",
        serde_json::to_value(&saved).unwrap_or(Value::Null),
    );
    saved
}

pub fn publish_needs_confirmation_in<E: AutoSwitchEnv>(
    outcome: &AutoSwitchOutcome,
    handoff_prompt: Option<String>,
    now_unix_ms: i64,
    store: &Mutex<Vec<PendingAutoSwitchConfirmation>>,
    env: &E,
) -> Option<PendingAutoSwitchConfirmation> {
    let incoming = build_pending_confirmation_from_outcome(outcome, handoff_prompt, now_unix_ms)?;
    Some(publish_confirmation_record_in(incoming, now_unix_ms, store, env))
}

pub fn publish_needs_confirmation_with<E: AutoSwitchEnv>(
    outcome: &AutoSwitchOutcome,
    handoff_prompt: Option<String>,
    now_unix_ms: i64,
    env: &E,
) -> Option<PendingAutoSwitchConfirmation> {
    publish_needs_confirmation_in(
        outcome,
        handoff_prompt,
        now_unix_ms,
        pending_auto_switches_store(),
        env,
    )
}

pub(crate) fn publish_needs_confirmation(
    outcome: &AutoSwitchOutcome,
    handoff_prompt: Option<String>,
    now_unix_ms: i64,
) -> Option<PendingAutoSwitchConfirmation> {
    publish_needs_confirmation_with(outcome, handoff_prompt, now_unix_ms, &LiveAutoSwitchEnv)
}

fn json_opt_str(req: Option<&Value>, keys: &[&str]) -> Option<String> {
    let obj = req?;
    for key in keys {
        if let Some(s) = obj.get(*key).and_then(|v| v.as_str()) {
            let trimmed = s.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn json_opt_bool(req: Option<&Value>, keys: &[&str]) -> Option<bool> {
    let obj = req?;
    for key in keys {
        if let Some(b) = obj.get(*key).and_then(|v| v.as_bool()) {
            return Some(b);
        }
    }
    None
}

pub fn list_pending_auto_switches_in<E: AutoSwitchEnv>(
    provider_filter: Option<&str>,
    now_unix_ms: i64,
    store: &Mutex<Vec<PendingAutoSwitchConfirmation>>,
    env: &E,
) -> Value {
    let canon_filter = provider_filter
        .map(canon_provider)
        .filter(|s| !s.trim().is_empty());
    let (confirmations, expired_ids) = {
        let mut items = store.lock().unwrap();
        let expired_ids = prune_expired_confirmations(&mut items, now_unix_ms);
        let filtered: Vec<PendingAutoSwitchConfirmation> = items
            .iter()
            .filter(|c| canon_filter.as_deref().map_or(true, |p| c.provider == p))
            .cloned()
            .collect();
        (filtered, expired_ids)
    };
    env.resolve_confirmation_notifications(&expired_ids, "abandoned");
    json!({
        "success": true,
        "confirmations": confirmations,
    })
}

pub fn list_pending_auto_switches_direct(request: Option<Value>) -> Value {
    let req = crate::persist::body(&request);
    let provider = json_opt_str(req, &["provider"]);
    list_pending_auto_switches_in(
        provider.as_deref(),
        now_ms(),
        pending_auto_switches_store(),
        &LiveAutoSwitchEnv,
    )
}

pub fn dismiss_pending_auto_switch_in<E: AutoSwitchEnv>(
    request: Option<Value>,
    now_unix_ms: i64,
    store: &Mutex<Vec<PendingAutoSwitchConfirmation>>,
    env: &E,
) -> Value {
    let req = crate::persist::body(&request);
    let Some(cid) = json_opt_str(req, &["confirmationId", "confirmation_id"]) else {
        return json!({
            "success": false,
            "dismissed": false,
            "error": "confirmationId is required.",
        });
    };

    let (removed, expired_ids) = {
        let mut items = store.lock().unwrap();
        let expired_ids = prune_expired_confirmations(&mut items, now_unix_ms);
        let before = items.len();
        items.retain(|c| c.confirmation_id != cid);
        (items.len() < before, expired_ids)
    };

    env.resolve_confirmation_notifications(&expired_ids, "abandoned");
    if removed {
        env.resolve_confirmation_notifications(&[cid.clone()], "abandoned");
        json!({
            "success": true,
            "dismissed": true,
            "confirmationId": cid,
        })
    } else {
        json!({
            "success": false,
            "dismissed": false,
            "confirmationId": cid,
            "error": "Pending auto-switch confirmation not found.",
        })
    }
}

pub fn dismiss_pending_auto_switch_direct(request: Option<Value>) -> Value {
    dismiss_pending_auto_switch_in(
        request,
        now_ms(),
        pending_auto_switches_store(),
        &LiveAutoSwitchEnv,
    )
}

fn to_chat_provider_id(account_provider: &str) -> &str {
    match account_provider.trim().to_ascii_lowercase().as_str() {
        "agy" | "antigravity" => "antigravity",
        other => crate::chat::models::canonical_thread_provider_id(other).unwrap_or(account_provider),
    }
}

/// Queries a fresh model catalog (without test-mode validation bypasses), syncs active profile
/// model capabilities, validates `desired_model`, and picks the closest available model if needed.
pub fn verify_fresh_model_catalog_with_fetcher<F>(
    root: &Path,
    account_provider: &str,
    desired_model: &str,
    expected_email: Option<&str>,
    fetch_catalog: F,
) -> Result<(String, bool, Vec<String>), String>
where
    F: FnOnce(&str) -> Value,
{
    let canon = canon_provider(account_provider);
    let chat_prov = to_chat_provider_id(&canon);
    let catalog = fetch_catalog(chat_prov);
    let available_ids: Vec<String> = catalog
        .get("models")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|entry| entry.get("id").and_then(|v| v.as_str()).map(String::from))
                .filter(|s| !s.trim().is_empty())
                .collect()
        })
        .unwrap_or_default();

    if !available_ids.is_empty() && root.exists() {
        let _ = sync_active_profile_capabilities_in(
            root,
            &canon,
            expected_email,
            None,
            Some(&available_ids),
            Some(now_ms()),
        );
    }

    let trimmed = desired_model.trim();
    if trimmed.is_empty() {
        let first = available_ids.first().cloned().unwrap_or_default();
        return Ok((first, false, available_ids));
    }

    match crate::chat::models::validate_provider_model_with_catalog(chat_prov, trimmed, &catalog) {
        Ok(()) => {
            let exact = available_ids
                .iter()
                .find(|id| id.eq_ignore_ascii_case(trimmed))
                .cloned()
                .unwrap_or_else(|| trimmed.to_string());
            Ok((exact, false, available_ids))
        }
        Err(err) => {
            let state = catalog
                .get("catalogState")
                .and_then(|v| v.as_str())
                .unwrap_or("ready");
            if matches!(state, "missing-binary" | "signed-out") || available_ids.is_empty() {
                return Err(err);
            }
            let fallback = available_ids
                .iter()
                .find(|id| models_match_exact_or_base(id, trimmed))
                .cloned()
                .or_else(|| pick_suggested_fallback_model(trimmed, &available_ids, &[], 0.0, now_ms()))
                .or_else(|| available_ids.first().cloned())
                .unwrap_or_else(|| trimmed.to_string());
            let adjusted = !fallback.eq_ignore_ascii_case(trimmed);
            Ok((fallback, adjusted, available_ids))
        }
    }
}

pub fn verify_fresh_model_catalog_live(
    account_provider: &str,
    desired_model: &str,
) -> Result<(String, bool, Vec<String>), String> {
    let canon = canon_provider(account_provider);
    let root = profiles_root();
    let expected_email = load_registry_from(&root)
        .profiles
        .into_iter()
        .find(|p| same_provider(&p.provider, &canon) && p.is_active)
        .and_then(|p| p.email);
    verify_fresh_model_catalog_with_fetcher(
        &root,
        &canon,
        desired_model,
        expected_email.as_deref(),
        |chat_prov| crate::chat::models::provider_models(chat_prov, true),
    )
}

#[allow(clippy::too_many_arguments)]
pub fn confirm_pending_auto_switch_in<E, V, R>(
    request: Option<Value>,
    now_unix_ms: i64,
    eval_lock: &Mutex<()>,
    state_mutex: &Mutex<AutoSwitchCoordinatorState>,
    store: &Mutex<Vec<PendingAutoSwitchConfirmation>>,
    env: &E,
    verify_catalog: V,
    resume_thread: R,
) -> Value
where
    E: AutoSwitchEnv,
    V: FnOnce(&str, &str) -> Result<(String, bool, Vec<String>), String>,
    R: FnOnce(&PendingAutoSwitchConfirmation, Option<&str>, bool, bool) -> Option<String>,
{
    let req = crate::persist::body(&request);
    let Some(cid) = json_opt_str(req, &["confirmationId", "confirmation_id"]) else {
        return json!({
            "success": false,
            "error": "confirmationId is required.",
        });
    };
    let selected_model = json_opt_str(
        req,
        &[
            "selectedModelId",
            "selected_model_id",
            "selectedModel",
            "selected_model",
        ],
    );
    let req_force_busy = json_opt_bool(req, &["forceBusy", "force_busy"]);
    let req_auto_resume = json_opt_bool(req, &["autoResumeTurn", "auto_resume_turn"]);

    enum StepOutcome {
        EarlyReturn(Value, Vec<String>),
        Confirmed {
            conf: PendingAutoSwitchConfirmation,
            canon: String,
            applied_model: Option<String>,
            model_adjusted: bool,
            fresh_models: Vec<String>,
            auto_resume: bool,
            status: AutoSwitchRuntimeStatus,
            expired_ids: Vec<String>,
        },
    }

    let step = {
        let _eval_guard = eval_lock.lock().unwrap();
        let (conf_opt, was_expired, expired_ids) = {
            let mut items = store.lock().unwrap();
            let expired_here = prune_expired_confirmations(&mut items, now_unix_ms);
            let expired_target = expired_here.iter().any(|id| id == &cid);
            let found = items.iter().find(|c| c.confirmation_id == cid).cloned();
            (found, expired_target, expired_here)
        };

        match conf_opt {
            None => {
                let err = if was_expired {
                    "Pending auto-switch confirmation has expired."
                } else {
                    "Pending auto-switch confirmation not found."
                };
                let mut body = json!({
                    "success": false,
                    "error": err,
                    "confirmationId": cid,
                });
                if was_expired {
                    body["expired"] = json!(true);
                }
                StepOutcome::EarlyReturn(body, expired_ids)
            }
            Some(conf) => {
                let canon = canon_provider(&conf.provider);
                let root = env.profiles_root();
                let policy = get_auto_switch_policy_in(&root, &canon);
                let reg = load_registry_from(&root);
                let already_active_target = conf.reason == "model_mismatch"
                    && reg.profiles.iter().any(|p| {
                        same_provider(&p.provider, &canon)
                            && p.is_active
                            && p.id == conf.to_account_id
                    });

                let recent_len = {
                    let mut state = state_mutex.lock().unwrap();
                    let list = state.recent_switches_ms.entry(canon.clone()).or_default();
                    list.retain(|&ts| now_unix_ms - ts < ROLLING_SWITCH_WINDOW_MS);
                    list.len()
                };

                let force_busy =
                    req_force_busy.unwrap_or_else(|| conf.reason == "busy_terminals_ask");
                let auto_resume = req_auto_resume.unwrap_or(policy.auto_continue_chat_turn);

                let switch_status_or_err = if already_active_target {
                    Ok(env.get_runtime_status(&canon))
                } else {
                    let res = env.execute_switch(&canon, &conf.to_account_id, force_busy);
                    let succeeded = res
                        .get("success")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    if !succeeded {
                        let code = res
                            .get("code")
                            .and_then(|v| v.as_str())
                            .unwrap_or("SWITCH_FAILED")
                            .to_string();
                        if code == "PROVIDER_BUSY" {
                            let status = apply_provider_busy_pause(env, &canon, &res, recent_len);
                            Err(json!({
                                "success": false,
                                "code": "PROVIDER_BUSY",
                                "error": res
                                    .get("error")
                                    .cloned()
                                    .unwrap_or_else(|| json!("Provider processes are busy.")),
                                "confirmationId": conf.confirmation_id,
                                "providerBusyKind": res.get("providerBusyKind").cloned().unwrap_or(Value::Null),
                                "canCloseProcesses": res.get("canCloseProcesses").cloned().unwrap_or(Value::Null),
                                "residualProcesses": res.get("residualProcesses").cloned().unwrap_or(json!([])),
                                "residualProcessCount": res.get("residualProcessCount").cloned().unwrap_or(Value::Null),
                                "baseAppTitles": res.get("baseAppTitles").cloned().unwrap_or(json!([])),
                                "status": status,
                            }))
                        } else {
                            let err_msg = res
                                .get("error")
                                .and_then(|v| v.as_str())
                                .unwrap_or("Account switch failed.")
                                .to_string();
                            Err(json!({
                                "success": false,
                                "code": code,
                                "error": err_msg,
                                "confirmationId": conf.confirmation_id,
                            }))
                        }
                    } else {
                        let mut state = state_mutex.lock().unwrap();
                        Ok(record_successful_switch_in_state(
                            env,
                            &mut state,
                            &canon,
                            conf.from_account_id.as_deref(),
                            &policy,
                            now_unix_ms,
                        ))
                    }
                };

                match switch_status_or_err {
                    Err(err_body) => StepOutcome::EarlyReturn(err_body, expired_ids),
                    Ok(status) => {
                        let desired_model = selected_model
                            .clone()
                            .or_else(|| conf.suggested_fallback_model.clone())
                            .or_else(|| conf.requested_model.clone());
                        let (applied_model, fresh_adjusted, fresh_models) =
                            match verify_catalog(&canon, desired_model.as_deref().unwrap_or("")) {
                                Ok((verified_id, adjusted, models)) => {
                                    if !models.is_empty() && root.exists() {
                                        let _ = sync_active_profile_capabilities_in(
                                            &root,
                                            &canon,
                                            conf.to_email.as_deref(),
                                            None,
                                            Some(&models),
                                            Some(now_unix_ms),
                                        );
                                    }
                                    let applied =
                                        (!verified_id.trim().is_empty()).then_some(verified_id);
                                    (applied, adjusted, models)
                                }
                                Err(_) => (desired_model.clone(), false, Vec::new()),
                            };
                        let model_adjusted = fresh_adjusted
                            || conf
                                .requested_model
                                .as_deref()
                                .zip(applied_model.as_deref())
                                .is_some_and(|(req_m, app_m)| !req_m.eq_ignore_ascii_case(app_m));

                        {
                            let mut items = store.lock().unwrap();
                            items.retain(|c| c.confirmation_id != conf.confirmation_id);
                        }

                        StepOutcome::Confirmed {
                            conf,
                            canon,
                            applied_model,
                            model_adjusted,
                            fresh_models,
                            auto_resume,
                            status,
                            expired_ids,
                        }
                    }
                }
            }
        }
    };

    match step {
        StepOutcome::EarlyReturn(body, expired_ids) => {
            env.resolve_confirmation_notifications(&expired_ids, "abandoned");
            body
        }
        StepOutcome::Confirmed {
            conf,
            canon,
            applied_model,
            model_adjusted,
            fresh_models,
            auto_resume,
            status,
            expired_ids,
        } => {
            env.resolve_confirmation_notifications(&expired_ids, "abandoned");
            env.resolve_confirmation_notifications(
                &[conf.confirmation_id.clone()],
                "attended",
            );

            let resumed_thread_id = if conf.thread_id.is_some() {
                resume_thread(&conf, applied_model.as_deref(), model_adjusted, auto_resume)
            } else {
                None
            };

            env.emit_event(
                "kite://auto-switch-executed",
                json!({
                    "provider": canon,
                    "confirmationId": conf.confirmation_id,
                    "fromAccountId": conf.from_account_id,
                    "fromAccountLabel": conf.from_account_label,
                    "toAccountId": conf.to_account_id,
                    "toAccountLabel": conf.to_account_label,
                    "appliedModel": applied_model,
                    "modelAdjusted": model_adjusted,
                    "autoContinueChatTurn": auto_resume,
                    "compatibility": if model_adjusted { "model_adjusted" } else { "confirmed" },
                    "triggerSource": "confirmation",
                    "threadId": conf.thread_id,
                    "resumedThreadId": resumed_thread_id,
                }),
            );

            json!({
                "success": true,
                "confirmationId": conf.confirmation_id,
                "provider": canon,
                "toAccountId": conf.to_account_id,
                "toAccountLabel": conf.to_account_label,
                "appliedModel": applied_model,
                "modelAdjusted": model_adjusted,
                "freshCatalogModels": fresh_models,
                "resumedThreadId": resumed_thread_id,
                "status": status,
            })
        }
    }
}

pub fn confirm_pending_auto_switch_direct(request: Option<Value>) -> Value {
    confirm_pending_auto_switch_in(
        request,
        now_ms(),
        auto_switch_coordinator_lock(),
        auto_switch_coordinator_state(),
        pending_auto_switches_store(),
        &LiveAutoSwitchEnv,
        verify_fresh_model_catalog_live,
        |conf, applied_model, model_adjusted, auto_resume| {
            crate::chat::runtime::settle::resume_thread_after_auto_switch(
                conf,
                applied_model,
                model_adjusted,
                auto_resume,
            )
        },
    )
}

/// Serializes live auto-switch evaluations globally without auto-publishing confirmations.
pub fn evaluate_auto_switch_raw(req: AutoSwitchTriggerRequest) -> AutoSwitchOutcome {
    let _eval_guard = auto_switch_coordinator_lock().lock().unwrap();
    let mut state = auto_switch_coordinator_state().lock().unwrap();
    let env = LiveAutoSwitchEnv;
    evaluate_auto_switch_with(&req, &mut state, &env)
}

/// Serializes live auto-switch evaluations globally and publishes pending confirmations
/// outside coordinator locks when `NeedsConfirmation` is returned.
pub fn evaluate_auto_switch(req: AutoSwitchTriggerRequest) -> AutoSwitchOutcome {
    let outcome = evaluate_auto_switch_raw(req.clone());
    if matches!(outcome, AutoSwitchOutcome::NeedsConfirmation { .. }) {
        let _ = publish_needs_confirmation(&outcome, None, req.now_unix_ms);
    }
    outcome
}

pub fn build_quota_poll_trigger_request(
    provider: &str,
    status: &ProviderQuotaStatus,
    now_unix_ms: i64,
) -> Option<AutoSwitchTriggerRequest> {
    if !status.is_available || !status.is_auth {
        return None;
    }
    let canon = canon_provider(provider);
    if canon.trim().is_empty() {
        return None;
    }
    let has_exhausted_window = status
        .windows
        .iter()
        .any(|w| w.is_exhausted || w.remaining_fraction <= 0.0);

    Some(AutoSwitchTriggerRequest {
        provider: canon,
        trigger_source: "quota_poll".to_string(),
        requested_model: None,
        thread_id: None,
        current_remaining_percent: Some(status.primary_remaining_percent),
        has_exhausted_window,
        now_unix_ms,
    })
}

/// Evaluates whether a freshly fetched quota snapshot should trigger or recover auto-switch
/// without blocking `quota::service` IPC callers.
#[cfg_attr(test, allow(dead_code))]
pub(crate) fn on_fresh_quota_status(provider: &str, status: &ProviderQuotaStatus) {
    let now = now_ms();
    let Some(req) = build_quota_poll_trigger_request(provider, status, now) else {
        return;
    };

    let root = profiles_root();
    let policy = get_auto_switch_policy_in(&root, &req.provider);
    if !policy.enabled {
        return;
    }

    let runtime = get_auto_switch_runtime_status(&req.provider);
    let exhausted = req.current_remaining_percent.unwrap_or(100.0)
        <= policy.trigger_threshold_percent
        || req.has_exhausted_window;
    let recovering_all_exhausted = !exhausted
        && runtime.paused
        && runtime.pause_reason.as_deref() == Some("ALL_ACCOUNTS_EXHAUSTED");
    if !exhausted && !recovering_all_exhausted {
        return;
    }

    std::thread::spawn(move || {
        let _ = evaluate_auto_switch(req);
    });
}
