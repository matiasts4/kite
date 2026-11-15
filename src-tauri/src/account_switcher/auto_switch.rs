use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use super::commands::{
    get_auto_switch_runtime_status, rank_auto_switch_candidates_in, set_auto_switch_runtime_status,
    switch_account_profile_direct_with_options, RankedSwitchCandidate,
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

pub const ROLLING_SWITCH_WINDOW_MS: i64 = 600_000;
const FAILED_TARGET_MIN_COOLDOWN_SECONDS: u64 = 30;

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

pub(crate) fn auto_switch_coordinator_lock() -> &'static Mutex<()> {
    AUTO_SWITCH_EVAL_LOCK.get_or_init(|| Mutex::new(()))
}

pub(crate) fn auto_switch_coordinator_state() -> &'static Mutex<AutoSwitchCoordinatorState> {
    AUTO_SWITCH_COORDINATOR_STATE.get_or_init(|| Mutex::new(AutoSwitchCoordinatorState::default()))
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

pub fn on_manual_switch_with<E: AutoSwitchEnv>(
    provider: &str,
    state: &mut AutoSwitchCoordinatorState,
    env: &E,
) {
    let canon = canon_provider(provider);
    if canon.trim().is_empty() {
        return;
    }
    clear_provider_state(state, &canon);
    let cleared = AutoSwitchRuntimeStatus::default();
    emit_status_via_env(env, &canon, &cleared);
}

/// Atomically clears coordinator state, runtime pause/cooldown fields, and emits updated status.
pub fn resume_auto_switch_state(provider: &str) -> AutoSwitchRuntimeStatus {
    let canon = canon_provider(provider);
    if canon.trim().is_empty() {
        return AutoSwitchRuntimeStatus::default();
    }
    let _eval_guard = auto_switch_coordinator_lock().lock().unwrap();
    let mut state = auto_switch_coordinator_state().lock().unwrap();
    let env = LiveAutoSwitchEnv;
    on_manual_switch_with(&canon, &mut state, &env);
    env.get_runtime_status(&canon)
}

/// Atomically clears pause/cooldown/error flags under `auto_switch_coordinator_lock`
/// when auto-switch policy is disabled, preventing in-flight evaluations from re-pausing.
pub fn clear_runtime_pause_on_policy_disable(provider: &str) -> AutoSwitchRuntimeStatus {
    let canon = canon_provider(provider);
    if canon.trim().is_empty() {
        return AutoSwitchRuntimeStatus::default();
    }
    let _eval_guard = auto_switch_coordinator_lock().lock().unwrap();
    let _state = auto_switch_coordinator_state().lock().unwrap();
    let env = LiveAutoSwitchEnv;
    let mut status = env.get_runtime_status(&canon);
    status.paused = false;
    status.pause_reason = None;
    status.cooldown_until_ms = None;
    status.last_error_code = None;
    status.residual_process_count = None;
    status.base_app_titles.clear();
    emit_status_via_env(&env, &canon, &status);
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
            emit_status_via_env(env, &canon, &status);
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

    // Record switch timing and apply anti-ping-pong cooldown on the source profile.
    state
        .last_switch_unix_ms
        .insert(canon.clone(), req.now_unix_ms);
    let recent_vec = state.recent_switches_ms.entry(canon.clone()).or_default();
    recent_vec.push(req.now_unix_ms);
    let recent_count = recent_vec.len() as u32;

    let cooldown_ms = (policy.cooldown_seconds as i64) * 1000;
    let cooldown_until_ms = if cooldown_ms > 0 {
        Some(req.now_unix_ms + cooldown_ms)
    } else {
        None
    };
    if let Some(ref src_id) = from_account_id {
        if cooldown_ms > 0 {
            state
                .target_cooldown_until_ms
                .insert((canon.clone(), src_id.clone()), req.now_unix_ms + cooldown_ms);
        }
    }

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
    emit_status_via_env(env, &canon, &status);

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

/// Serializes live auto-switch evaluations globally through `auto_switch_coordinator_lock`.
pub fn evaluate_auto_switch(req: AutoSwitchTriggerRequest) -> AutoSwitchOutcome {
    let _eval_guard = auto_switch_coordinator_lock().lock().unwrap();
    let mut state = auto_switch_coordinator_state().lock().unwrap();
    let env = LiveAutoSwitchEnv;
    evaluate_auto_switch_with(&req, &mut state, &env)
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
