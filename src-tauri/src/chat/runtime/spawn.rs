use crate::chat::drivers::declaration;
use crate::chat::normalize::follow_up_uses_delta_only;
use crate::chat::persistent::{opencode_model_arg, PersistentControls};
use crate::chat::recipe::snapshot_for_agent;
use crate::chat::session::{SessionMode, SessionSpec};
use crate::chat::utils::{chat_log, clip_argv, resolve_bin};
use crate::connections::EndpointVerification;
use crate::persist::workspace_path;
use serde_json::Value;
use std::path::{Path, PathBuf};

use super::pipeline::stream_child;
use super::settle::finish_run;
use super::state::{
    emit_notice_item, live_turns, persistent_fallback_notice, persistent_sessions_enabled,
    select_persistent_transport, send_route, session_manager, ManagedSendError, SendBinding,
    SendRoute,
};
use super::turn::{
    apply_agent_recipe, assemble_thread_context, managed_send_prepared, one_shot_notice,
    pump_persistent_session, starts_new_session,
};

pub fn compose_thread_dispatch_env(
    thread_id: &str,
    workspace_id: Option<&str>,
    skill_path: &Path,
    bin_dir: &Path,
    program_path: Option<&Path>,
    inherited_path: &str,
) -> Vec<(String, String)> {
    let mut env = vec![
        ("KITE_DISPATCH".to_string(), "1".to_string()),
        ("KITE_ADDRESS".to_string(), format!("thread:{thread_id}")),
        ("KITE_THREAD_ID".to_string(), thread_id.to_string()),
        (
            "KITE_SKILL_FILE".to_string(),
            skill_path.display().to_string(),
        ),
        (
            "AGY_CLI_DISABLE_AUTO_UPDATE".to_string(),
            "true".to_string(),
        ),
    ];
    if let Some(ws) = workspace_id.map(str::trim).filter(|s| !s.is_empty()) {
        env.push(("KITE_WORKSPACE_ID".to_string(), ws.to_string()));
    }

    let bin_str = bin_dir.display().to_string();
    let norm_bin = bin_str.trim_end_matches(['\\', '/']);
    let mut path_parts: Vec<String> = Vec::new();
    if !norm_bin.is_empty() {
        path_parts.push(bin_str.clone());
    }
    if let Some(parent) = program_path.and_then(|p| p.parent()) {
        let p_str = parent.display().to_string();
        let norm_p = p_str.trim_end_matches(['\\', '/']);
        if !norm_p.is_empty()
            && !norm_p.eq_ignore_ascii_case(norm_bin)
            && !inherited_path.to_lowercase().contains(&norm_p.to_lowercase())
        {
            path_parts.push(p_str);
        }
    }
    for segment in std::env::split_paths(inherited_path) {
        let seg_str = segment.display().to_string();
        let norm_seg = seg_str.trim_end_matches(['\\', '/']);
        if !norm_seg.is_empty() && !norm_seg.eq_ignore_ascii_case(norm_bin) {
            path_parts.push(seg_str);
        }
    }
    let sep = if cfg!(windows) { ";" } else { ":" };
    env.push(("PATH".to_string(), path_parts.join(sep)));
    env
}

fn upsert_env_var(env: &mut Vec<(String, String)>, key: &str, value: &str) {
    if let Some((_, existing)) = env.iter_mut().find(|(k, _)| k == key) {
        *existing = value.to_string();
    } else {
        env.push((key.to_string(), value.to_string()));
    }
}

/// Appends context-engine attribution environment variables so `kite ctx` calls
/// inside thread and subagent processes track the exact session, agent, provider,
/// model, and project workspace.
pub fn append_context_engine_env(
    env: &mut Vec<(String, String)>,
    session_id: &str,
    workspace_id: Option<&str>,
    agent_name: Option<&str>,
    provider: Option<&str>,
    model: Option<&str>,
) {
    let trimmed_sid = session_id.trim();
    if !trimmed_sid.is_empty() {
        upsert_env_var(env, "KITE_SESSION_ID", trimmed_sid);
    }
    if let Some(ws) = workspace_id.map(str::trim).filter(|s| !s.is_empty()) {
        upsert_env_var(env, "KITE_PROJECT", ws);
    }
    if let Some(prov) = provider.map(str::trim).filter(|s| !s.is_empty()) {
        upsert_env_var(env, "KITE_PROVIDER", prov);
    }
    let resolved_agent = agent_name
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or_else(|| provider.map(str::trim).filter(|s| !s.is_empty()));
    if let Some(agent) = resolved_agent {
        upsert_env_var(env, "KITE_AGENT_NAME", agent);
    }
    if let Some(mdl) = model.map(str::trim).filter(|s| !s.is_empty()) {
        upsert_env_var(env, "KITE_MODEL", mdl);
    }
}

pub fn build_thread_dispatch_env(
    thread_id: &str,
    workspace_id: Option<&str>,
    program_path: Option<&Path>,
) -> Vec<(String, String)> {
    build_thread_dispatch_env_for_agent(thread_id, workspace_id, program_path, None)
}

/// Apply `AgentProfile` permission flags, tool policies, authorized roots, and disabled-plugin exclusions to a spawn env vector.
pub fn apply_agent_permissions_to_env(
    env: &mut Vec<(String, String)>,
    agent: &crate::persist::AgentProfile,
) {
    let ws_from_env = env
        .iter()
        .find(|(k, _)| k == "KITE_WORKSPACE_ID")
        .and_then(|(_, ws_id)| workspace_path(ws_id))
        .map(PathBuf::from)
        .filter(|p| p.is_dir());
    apply_agent_permissions_to_env_with_workspace(env, agent, ws_from_env.as_deref());
}

pub fn apply_agent_permissions_to_env_with_workspace(
    env: &mut Vec<(String, String)>,
    agent: &crate::persist::AgentProfile,
    workspace_dir: Option<&Path>,
) {
    let allow_scheduling = agent.allow_agent_scheduling.unwrap_or(true);
    let allow_messaging = agent.allow_agent_messaging.unwrap_or(true);
    let disabled = crate::plugins::normalize_disabled_plugins(&agent.disabled_plugin_ids);

    upsert_env_var(env, "KITE_AGENT_ID", &agent.id);
    upsert_env_var(
        env,
        "KITE_ALLOW_SCHEDULING",
        if allow_scheduling { "true" } else { "false" },
    );
    upsert_env_var(
        env,
        "KITE_ALLOW_MESSAGING",
        if allow_messaging { "true" } else { "false" },
    );
    upsert_env_var(env, "KITE_DISABLED_PLUGINS", &disabled.join(","));

    let autonomy = crate::agents::load_agent_autonomy_config(&agent.id);
    let mut effective_policies = serde_json::Map::new();
    for fam in crate::agents::CANONICAL_TOOL_FAMILIES {
        let decision = autonomy
            .tool_policies
            .get(*fam)
            .map(String::as_str)
            .and_then(crate::agents::normalize_tool_policy_value)
            .unwrap_or_else(|| crate::agents::default_policy_for_family(fam));
        effective_policies.insert((*fam).to_string(), Value::String(decision.to_string()));
    }
    if let Ok(policies_json) = serde_json::to_string(&Value::Object(effective_policies)) {
        upsert_env_var(env, "KITE_TOOL_POLICIES", &policies_json);
    }

    let roots = crate::agents::resolve_agent_authorized_roots(Some(&agent.id), workspace_dir);
    let root_strings: Vec<String> = roots
        .into_iter()
        .map(|p| {
            let s = p.to_string_lossy().to_string();
            s.strip_prefix(r"\\?\").unwrap_or(&s).to_string()
        })
        .collect();
    if let Ok(roots_json) = serde_json::to_string(&root_strings) {
        upsert_env_var(env, "KITE_AUTHORIZED_ROOTS", &roots_json);
    }

    if crate::plugins::is_plugin_disabled(&disabled, "kite-dispatch") {
        env.retain(|(k, _)| {
            !matches!(
                k.as_str(),
                "KITE_DISPATCH"
                    | "KITE_SKILL_FILE"
                    | "KITE_TOOL_POLICIES"
                    | "KITE_AUTHORIZED_ROOTS"
            )
        });
    }
    if crate::plugins::is_plugin_disabled(&disabled, "kite-ctx") {
        env.retain(|(k, _)| {
            !matches!(
                k.as_str(),
                "KITE_SESSION_ID"
                    | "KITE_PROJECT"
                    | "KITE_PROVIDER"
                    | "KITE_AGENT_NAME"
                    | "KITE_MODEL"
            )
        });
    }
}

/// Build the thread dispatch environment, honoring an optional `AgentProfile`'s
/// permissions and `disabled_plugin_ids`.
pub fn build_thread_dispatch_env_for_agent(
    thread_id: &str,
    workspace_id: Option<&str>,
    program_path: Option<&Path>,
    agent: Option<&crate::persist::AgentProfile>,
) -> Vec<(String, String)> {
    let dispatch_disabled = agent
        .map(|a| crate::plugins::is_plugin_disabled(&a.disabled_plugin_ids, "kite-dispatch"))
        .unwrap_or(false);
    let ctx_disabled = agent
        .map(|a| crate::plugins::is_plugin_disabled(&a.disabled_plugin_ids, "kite-ctx"))
        .unwrap_or(false);

    let skill = if dispatch_disabled {
        PathBuf::new()
    } else {
        crate::dispatch::cli::ensure_dispatch_skill_once()
    };
    let bin = crate::dispatch::cli::install_kite_shim();
    if !ctx_disabled {
        crate::dispatch::cli::ensure_ctx_integrations_once();
    }
    let inherited = std::env::var("PATH").unwrap_or_default();
    let mut env = compose_thread_dispatch_env(
        thread_id,
        workspace_id,
        &skill,
        &bin,
        program_path,
        &inherited,
    );
    if let Some(profile) = agent {
        apply_agent_permissions_to_env(&mut env, profile);
    }
    let ws_dir = workspace_id
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .and_then(workspace_path)
        .map(PathBuf::from)
        .filter(|p| p.is_dir());
    let disabled_ids: Vec<String> = agent
        .map(|a| crate::plugins::normalize_disabled_plugins(&a.disabled_plugin_ids))
        .unwrap_or_default();
    if let Some(sidecars_json) =
        crate::plugin_runtime::context::active_sidecars_env_json(ws_dir.as_deref(), &disabled_ids)
    {
        upsert_env_var(&mut env, "KITE_ACTIVE_SIDECARS_JSON", &sidecars_json);
    }
    env
}

pub fn is_spawn_failover_eligible_error(err: &str) -> bool {
    let lower = err.trim().to_ascii_lowercase();
    if lower.is_empty() {
        return false;
    }
    lower.contains("is not installed")
        || lower.contains("not available")
        || lower.contains("no local chat command")
        || lower.contains("not verified")
        || lower.contains("not found")
        || lower.contains("cannot find the file")
        || lower.contains("enoent")
        || lower.contains("program not found")
        || crate::handoff::detect_quota_exhaustion("", err).is_some()
}

pub fn build_failover_provider_candidates(
    primary_provider: &str,
    failover_engines: &[String],
) -> Vec<String> {
    let mut out = Vec::new();
    let primary_canon = crate::chat::models::canonical_thread_provider_id(primary_provider)
        .unwrap_or(primary_provider)
        .to_string();
    out.push(primary_canon.clone());
    for eng in failover_engines {
        let Some(canon) = crate::chat::models::canonical_thread_provider_id(eng) else {
            continue;
        };
        if !out.iter().any(|p| p == canon) {
            out.push(canon.to_string());
        }
    }
    out
}

pub(crate) fn resolve_spawn_plan_with_failover_using<F>(
    primary_provider: &str,
    failover_engines: &[String],
    mut try_build: F,
) -> Result<(String, SpawnPlan, Option<String>), String>
where
    F: FnMut(&str, bool) -> Result<SpawnPlan, String>,
{
    let candidates = build_failover_provider_candidates(primary_provider, failover_engines);
    let mut primary_err: Option<String> = None;
    for (idx, candidate) in candidates.iter().enumerate() {
        let is_primary = idx == 0;
        match try_build(candidate, is_primary) {
            Ok(plan) => {
                return Ok((candidate.clone(), plan, primary_err));
            }
            Err(err) => {
                if is_primary {
                    if !is_spawn_failover_eligible_error(&err) || candidates.len() <= 1 {
                        return Err(err);
                    }
                    primary_err = Some(err);
                } else if !is_spawn_failover_eligible_error(&err) && idx + 1 == candidates.len() {
                    return Err(err);
                }
            }
        }
    }
    Err(primary_err.unwrap_or_else(|| "Provider spawn failed.".to_string()))
}

fn infer_settled_run_outcome(thread_id: &str, run_id: &str) -> &'static str {
    if let Ok(live) = live_turns().lock() {
        if let Some(run) = live.runs.get(run_id) {
            for ev in run.events.iter().rev() {
                if ev.get("kind").and_then(Value::as_str) == Some("finished") {
                    if ev.get("stoppedByBuilder").and_then(Value::as_bool) == Some(true) {
                        return "cancelled";
                    }
                    if ev.get("ok").and_then(Value::as_bool) == Some(true) {
                        return "completed";
                    }
                    return "failed";
                }
            }
        }
    }
    if let Ok(items) = crate::persist::threads().lock() {
        if let Some(t) = items
            .iter()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(thread_id))
        {
            return match t.get("status").and_then(Value::as_str) {
                Some("error") => "failed",
                _ => "completed",
            };
        }
    }
    "completed"
}

pub fn watch_agent_turn_lifecycle(
    thread_id: &str,
    run_id: &str,
    agent_id: &str,
    mind_root: &Path,
    skill_ids: &[String],
    max_duration: Option<std::time::Duration>,
) {
    let deadline = max_duration.map(|d| std::time::Instant::now() + d);
    let mut timed_out = false;

    {
        let mut guard = live_turns().lock().unwrap();
        loop {
            let still_active = guard
                .runs
                .get(run_id)
                .is_some_and(|r| !r.finished && !r.closing);
            if !still_active {
                break;
            }
            if let Some(dl) = deadline {
                let now = std::time::Instant::now();
                if now >= dl {
                    timed_out = true;
                    break;
                }
                let remaining = dl.saturating_duration_since(now);
                let (next_guard, _) = super::state::live_cv().wait_timeout(guard, remaining).unwrap();
                guard = next_guard;
            } else {
                let (next_guard, _) = super::state::live_cv()
                    .wait_timeout(guard, std::time::Duration::from_millis(500))
                    .unwrap();
                guard = next_guard;
            }
        }
    }

    if timed_out {
        let secs = max_duration.map(|d| d.as_secs()).unwrap_or(0);
        emit_notice_item(
            thread_id,
            run_id,
            &format!("Agent turn exceeded maxDurationSecs ({secs}s) and was stopped."),
        );
        super::pipeline::cancel_host_approvals_for_thread(thread_id);
        let child = {
            let live = live_turns().lock().unwrap();
            live.runs.get(run_id).and_then(|run| run.child.clone())
        };
        if let Some(child) = child {
            if let Ok(mut ch) = child.lock() {
                let _ = ch.kill();
            }
        }
        if let Ok(mut manager) = session_manager().lock() {
            let _ = manager.stop(thread_id);
        }
        finish_run(
            run_id,
            false,
            false,
            &format!("Agent turn exceeded maximum duration of {secs}s."),
        );
    }

    if !skill_ids.is_empty() {
        let outcome = if timed_out {
            "failed"
        } else {
            infer_settled_run_outcome(thread_id, run_id)
        };
        crate::agent_mind::skills::record_skills_used_at(
            mind_root,
            agent_id,
            skill_ids,
            Some(outcome),
        );
    }
}

pub fn launch_provider(
    thread_id: String,
    run_id: String,
    thread: &Value,
    prompt: &str,
    binding: Option<&SendBinding>,
) {
    if cfg!(test) {
        let _ = (thread_id, run_id, thread, prompt, binding);
        return;
    }
    let provider = thread.get("provider").and_then(|v| v.as_str()).unwrap_or("antigravity").to_string();
    let mode = thread.get("mode").and_then(|v| v.as_str()).unwrap_or("fullAccess").to_string();
    let model = thread.get("model").and_then(|v| v.as_str()).map(|s| s.to_string());
    let provider_session_id = thread.get("providerSessionId").and_then(|v| v.as_str()).map(|s| s.to_string());
    let raw_effort = thread
        .get("providerOptions")
        .and_then(|v| v.as_array())
        .and_then(|arr| {
            arr.iter().find(|opt| opt.get("id").and_then(|v| v.as_str()) == Some("effort"))
        })
        .and_then(|opt| opt.get("value").and_then(|v| v.as_str()))
        .or_else(|| thread.get("effort").and_then(|v| v.as_str()))
        .map(|s| s.to_string());
    let effort = crate::chat::models::resolve_effective_effort_for_provider(
        &provider,
        binding.and_then(|b| b.connection_id.as_deref()),
        model.as_deref(),
        raw_effort.as_deref(),
    );
    let workspace_id = thread.get("workspaceId").and_then(|v| v.as_str()).map(|s| s.to_string());
    let custom_cwd = thread
        .get("worktreePath")
        .or_else(|| thread.get("workingDirectory"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let profile_id = thread.get("profileId").and_then(|v| v.as_str()).map(|s| s.to_string());
    let agent = thread
        .get("agent")
        .or_else(|| thread.get("workMode"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let subagent_role = thread
        .get("subagentRole")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let resolved_agent_name = subagent_role
        .or_else(|| agent.clone().filter(|s| !s.trim().is_empty()))
        .or_else(|| profile_id.clone().filter(|s| !s.trim().is_empty()))
        .or_else(|| Some(provider.clone()));
    let prompt = prompt.to_string();
    let thread_clone = thread.clone();
    let binding = binding.cloned();
    let assistant_id = {
        let live = live_turns().lock().unwrap();
        live.runs.get(&run_id).map(|run| run.assistant_id.clone()).unwrap_or_else(|| "aassistant".into())
    };
    std::thread::spawn(move || {
        let verified_endpoints = match verified_endpoints_for(
            binding.as_ref().and_then(|value| value.connection_id.as_deref()),
        ) {
            Ok(endpoints) => endpoints,
            Err(message) => {
                finish_run(&run_id, false, false, &message);
                return;
            }
        };
        let cwd = custom_cwd
            .as_deref()
            .map(PathBuf::from)
            .filter(|path| path.is_dir())
            .or_else(|| {
                workspace_id
                    .as_deref()
                    .and_then(workspace_path)
                    .map(PathBuf::from)
                    .filter(|path| path.is_dir())
            })
            .unwrap_or_else(|| {
                if let Some(ref aid) = profile_id {
                    let home = crate::agent_mind::get_agent_home_dir(aid);
                    let _ = std::fs::create_dir_all(&home);
                    let _ = crate::agent_mind::sync_agent_instructions(
                        home.parent().unwrap_or(Path::new(".")),
                        aid,
                    );
                    home
                } else {
                    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
                }
            });
        let is_attached_workspace = workspace_id.is_some()
            || custom_cwd.is_some()
            || crate::agent_mind::memory::is_git_repository(&cwd);
        let agent_profile = profile_id.as_deref().and_then(|aid| {
            crate::persist::agents()
                .lock()
                .ok()
                .and_then(|list| list.iter().find(|a| a.id == aid).cloned())
        });
        let disabled_plugin_ids: Vec<String> = agent_profile
            .as_ref()
            .map(|a| crate::plugins::normalize_disabled_plugins(&a.disabled_plugin_ids))
            .unwrap_or_default();

        // Snapshot once. The same value is written before the process starts
        // and stored on the session, so a later agent edit cannot reach it.
        let recipe = profile_id.as_deref().and_then(snapshot_for_agent);
        let base_instructions = recipe
            .as_ref()
            .map(|r| r.compile_instructions())
            .or_else(|| {
                profile_id
                    .as_deref()
                    .map(crate::agent_mind::memory::compile_agent_instructions)
            });
        let plugin_ctx = crate::plugin_runtime::context::build_active_plugin_context(
            Some(&cwd),
            &disabled_plugin_ids,
        );
        let compiled_instructions =
            merge_instructions_with_plugin_context(base_instructions, plugin_ctx);

        let autonomy_cfg = profile_id
            .as_deref()
            .map(crate::agents::load_agent_autonomy_config)
            .unwrap_or_default();

        if let Some(aid) = profile_id.as_deref() {
            let root = crate::agent_mind::agents_root();
            let skill_ids: Vec<String> = if let Some(ref r) = recipe {
                r.skills.clone()
            } else {
                let (skills, _) = crate::agent_mind::skills::read_skills(&root.join(aid).join("skills"));
                skills
                    .iter()
                    .filter(|s| s.get("enabled").and_then(Value::as_bool).unwrap_or(true))
                    .filter_map(|s| s.get("id").and_then(Value::as_str).map(str::to_string))
                    .collect()
            };
            let max_dur = autonomy_cfg
                .max_duration_secs
                .filter(|&s| s > 0)
                .map(std::time::Duration::from_secs);
            let watch_tid = thread_id.clone();
            let watch_rid = run_id.clone();
            let watch_aid = aid.to_string();
            std::thread::spawn(move || {
                watch_agent_turn_lifecycle(
                    &watch_tid,
                    &watch_rid,
                    &watch_aid,
                    &root,
                    &skill_ids,
                    max_dur,
                );
            });
        }

        let is_session_warm_or_has_handle = {
            let manager = session_manager().lock().unwrap();
            manager
                .status(&thread_id)
                .map(|r| r.is_warm() || r.resume_handle.is_some())
                .unwrap_or(false)
        };
        let effective_prompt = if follow_up_uses_delta_only(
            provider_session_id.as_deref(),
            is_session_warm_or_has_handle,
        ) {
            prompt.clone()
        } else {
            assemble_thread_context(&thread_clone, &prompt)
        };

        let build_for_candidate = |cand_provider: &str, is_primary: bool| -> Result<SpawnPlan, String> {
            if let Some(status) = crate::quota::service::get_cached_provider_status(cand_provider) {
                if !status.is_available || status.primary_remaining_percent <= 0.0 {
                    return Err(format!("Provider '{cand_provider}' quota is exhausted or unavailable."));
                }
            }
            let cand_values = if is_primary {
                SendValues {
                    connection_id: binding.as_ref().and_then(|value| value.connection_id.as_deref()),
                    model: model.as_deref(),
                    session_id: provider_session_id.as_deref(),
                    supported_endpoint: binding
                        .as_ref()
                        .and_then(|value| value.supported_endpoint.as_deref()),
                    verified_endpoints: &verified_endpoints,
                    agent: agent.as_deref(),
                }
            } else {
                SendValues {
                    connection_id: None,
                    model: None,
                    session_id: None,
                    supported_endpoint: None,
                    verified_endpoints: &[],
                    agent: agent.as_deref(),
                }
            };
            build_spawn_with_instructions(
                cand_provider,
                &mode,
                &cand_values,
                if is_primary { effort.as_deref() } else { None },
                &effective_prompt,
                compiled_instructions.as_deref(),
            )
        };

        match resolve_spawn_plan_with_failover_using(
            &provider,
            &autonomy_cfg.failover_engines,
            build_for_candidate,
        ) {
            Ok((active_provider, plan, failover_reason)) => {
                let switched_provider = active_provider != provider;
                if let Some(reason) = failover_reason {
                    emit_notice_item(
                        &thread_id,
                        &run_id,
                        &format!(
                            "Primary provider '{provider}' unavailable ({reason}); failing over to '{active_provider}'."
                        ),
                    );
                    if switched_provider {
                        crate::persist::hydrate_thread(&thread_id);
                        let mut items = crate::persist::threads().lock().unwrap();
                        if let Some(t) = items
                            .iter_mut()
                            .find(|t| t.get("id").and_then(Value::as_str) == Some(thread_id.as_str()))
                        {
                            t["provider"] = serde_json::json!(active_provider);
                            t["providerSessionId"] = Value::Null;
                            t["model"] = Value::Null;
                            crate::chat::threads::touch(t);
                        }
                    }
                }
                chat_log(&format!(
                    "spawn: provider={}, endpoint={}, connection={}",
                    active_provider,
                    plan.endpoint.verified_endpoint(),
                    plan.connection_id.as_deref().unwrap_or("none"),
                ));
                let ctx_disabled = agent_profile
                    .as_ref()
                    .is_some_and(|a| crate::plugins::is_plugin_disabled(&a.disabled_plugin_ids, "kite-ctx"));
                let mut dispatch_env = build_thread_dispatch_env_for_agent(
                    &thread_id,
                    workspace_id.as_deref(),
                    Some(&plan.program),
                    agent_profile.as_ref(),
                );
                if let Some(ref profile) = agent_profile {
                    apply_agent_permissions_to_env_with_workspace(
                        &mut dispatch_env,
                        profile,
                        Some(&cwd),
                    );
                }
                if let Some(sidecars_json) =
                    crate::plugin_runtime::context::active_sidecars_env_json(
                        Some(&cwd),
                        &disabled_plugin_ids,
                    )
                {
                    upsert_env_var(&mut dispatch_env, "KITE_ACTIVE_SIDECARS_JSON", &sidecars_json);
                }
                if !ctx_disabled {
                    append_context_engine_env(
                        &mut dispatch_env,
                        &thread_id,
                        workspace_id.as_deref(),
                        resolved_agent_name.as_deref(),
                        Some(&active_provider),
                        if switched_provider { None } else { model.as_deref() },
                    );
                }
                let persistent_enabled = persistent_sessions_enabled();
                let mut fallback_notice_emitted = false;
                if send_route(&active_provider, persistent_enabled) == SendRoute::Persistent {
                    if let Some(declared) = declaration(&active_provider) {
                        let spec = SessionSpec {
                            thread_id: thread_id.clone(),
                            driver: active_provider.clone(),
                            connection_id: if switched_provider {
                                None
                            } else {
                                binding.as_ref().and_then(|v| v.connection_id.clone())
                            },
                            working_directory: Some(cwd.to_string_lossy().to_string()),
                            mode: SessionMode::OneShot,
                            recipe: recipe.clone(),
                            resume_handle: if switched_provider {
                                None
                            } else {
                                provider_session_id.clone()
                            },
                            extra_env: Vec::new(),
                        }
                        .with_declared_mode(&declared, persistent_enabled)
                        .with_extra_env(dispatch_env.clone());
                        let first_session = {
                            let manager = session_manager().lock().unwrap();
                            starts_new_session(manager.status(&thread_id).map(|record| record.state))
                        };
                        let controls = PersistentControls {
                            model: if switched_provider { None } else { model.clone() },
                            effort: if switched_provider { None } else { effort.clone() },
                            permission_mode: Some(mode.clone()),
                        };
                        let cwd_for_prepare = cwd.clone();
                        let recipe_for_prepare = recipe.clone();
                        let effective_managed_prompt = if first_session {
                            if let Some(ref inst) = compiled_instructions {
                                format_instruction_envelope(inst, &prompt)
                            } else {
                                prompt.clone()
                            }
                        } else {
                            prompt.clone()
                        };
                        let is_ephemeral_subagent = crate::persist::threads()
                            .lock()
                            .ok()
                            .and_then(|all| {
                                all.iter()
                                    .find(|t| t.get("id").and_then(Value::as_str) == Some(thread_id.as_str()))
                                    .map(|t| {
                                        t.get("ephemeral").and_then(Value::as_bool) == Some(true)
                                            || t.get("startedByAgent").and_then(Value::as_bool) == Some(true)
                                            || t.get("sideChat").and_then(Value::as_bool) == Some(true)
                                    })
                            })
                            .unwrap_or(false);
                        let mut persistent_permit = None;
                        let outcome = {
                            match select_persistent_transport(&active_provider, controls) {
                                Ok(selected) => {
                                    chat_log(&format!(
                                        "persistent transport: driver={}, kind={:?}, minimum={}",
                                        selected.driver, selected.kind, selected.version.minimum
                                    ));
                                    let weight = match selected.kind {
                                        super::state::TransportKind::Antigravity
                                        | super::state::TransportKind::OpenCodeServer
                                        | super::state::TransportKind::GrokAgent => {
                                            crate::chat::session::SessionWeight::Multiplexed
                                        }
                                    };
                                    persistent_permit = crate::chat::session::global_process_governor()
                                        .acquire(weight, None)
                                        .ok();
                                    let mut manager = session_manager().lock().unwrap();
                                    if is_ephemeral_subagent {
                                        manager.set_ephemeral(&thread_id, true);
                                    }
                                    managed_send_prepared(
                                        &mut manager,
                                        spec,
                                        selected.transport,
                                        &run_id,
                                        &effective_managed_prompt,
                                        move || {
                                            if !first_session || is_attached_workspace {
                                                return Ok(());
                                            }
                                            apply_agent_recipe(
                                                &cwd_for_prepare,
                                                recipe_for_prepare.as_ref(),
                                            )
                                            .map(|_| ())
                                        },
                                    )
                                }
                                Err(reason) => Err(ManagedSendError::Start(reason)),
                            }
                        };
                        match outcome {
                            Ok(_) => {
                                super::turn::pump_persistent_session_with_permit(
                                    thread_id.clone(),
                                    run_id.clone(),
                                    assistant_id.clone(),
                                    persistent_permit,
                                );
                                return;
                            }
                            Err(ManagedSendError::Prepare(reason)) => {
                                emit_notice_item(
                                    &thread_id,
                                    &run_id,
                                    &format!(
                                        "The agent recipe could not be written, so the {active_provider} session did not start: {reason} Your message is still in the thread."
                                    ),
                                );
                                finish_run(&run_id, false, false, &reason);
                                return;
                            }
                            Err(error) if error.before_turn() => {
                                emit_notice_item(
                                    &thread_id,
                                    &run_id,
                                    &persistent_fallback_notice(&active_provider, error.reason()),
                                );
                                fallback_notice_emitted = true;
                            }
                            Err(error) => {
                                emit_notice_item(
                                    &thread_id,
                                    &run_id,
                                    &format!(
                                        "{active_provider} failed while accepting the turn on its session: {}. Your message is still in the thread.",
                                        error.reason()
                                    ),
                                );
                                finish_run(&run_id, false, false, error.reason());
                                return;
                            }
                        }
                    }
                }
                if !fallback_notice_emitted {
                    if let Some(notice) = one_shot_notice(&active_provider, persistent_enabled) {
                        emit_notice_item(&thread_id, &run_id, &notice);
                    }
                }
                if !is_attached_workspace {
                    if let Err(reason) = apply_agent_recipe(&cwd, recipe.as_ref()) {
                        emit_notice_item(
                            &thread_id,
                            &run_id,
                            &format!(
                                "The agent recipe could not be written before {active_provider} started: {reason} Your message is still in the thread."
                            ),
                        );
                        finish_run(&run_id, false, false, &reason);
                        return;
                    }
                }
                let args_refs: Vec<&str> = plan.args.iter().map(|s| s.as_str()).collect();
                let _heavy_governor_permit = crate::chat::session::global_process_governor()
                    .acquire(crate::chat::session::SessionWeight::HeavyProcess, None)
                    .ok();
                match crate::hidden_exec::spawn_streaming_with_owned_env(
                    &plan.program,
                    &args_refs,
                    Some(&cwd),
                    &dispatch_env,
                ) {
                    Ok(child) => stream_child(thread_id, run_id, assistant_id, child),
                    Err(err) => {
                        let err_str = err.to_string();
                        if !switched_provider && !autonomy_cfg.failover_engines.is_empty() && is_spawn_failover_eligible_error(&err_str) {
                            let remaining_engines: Vec<String> = autonomy_cfg
                                .failover_engines
                                .iter()
                                .filter(|e| {
                                    crate::chat::models::canonical_thread_provider_id(e)
                                        != Some(active_provider.as_str())
                                })
                                .cloned()
                                .collect();
                            for eng in remaining_engines {
                                let Some(fb) = crate::chat::models::canonical_thread_provider_id(&eng) else {
                                    continue;
                                };
                                let fb_values = SendValues {
                                    connection_id: None,
                                    model: None,
                                    session_id: None,
                                    supported_endpoint: None,
                                    verified_endpoints: &[],
                                    agent: agent.as_deref(),
                                };
                                if let Ok(fb_plan) = build_spawn_with_instructions(
                                    fb,
                                    &mode,
                                    &fb_values,
                                    None,
                                    &effective_prompt,
                                    compiled_instructions.as_deref(),
                                ) {
                                    let fb_args: Vec<&str> = fb_plan.args.iter().map(|s| s.as_str()).collect();
                                    if let Ok(fb_child) = crate::hidden_exec::spawn_streaming_with_owned_env(
                                        &fb_plan.program,
                                        &fb_args,
                                        Some(&cwd),
                                        &dispatch_env,
                                    ) {
                                        emit_notice_item(
                                            &thread_id,
                                            &run_id,
                                            &format!("Primary provider '{active_provider}' failed to launch ({err}); failing over to '{fb}'."),
                                        );
                                        stream_child(thread_id, run_id, assistant_id, fb_child);
                                        return;
                                    }
                                }
                            }
                        }
                        finish_run(&run_id, false, false, &format!("{active_provider} failed to start: {err}"));
                    }
                }
            }
            Err(message) => finish_run(&run_id, false, false, &message),
        }
    });
}

/// Endpoints verified on the connection named by the send. An empty list is
/// returned when the send does not select a connection, so no endpoint can be
/// claimed as supported.
pub fn verified_endpoints_for(connection_id: Option<&str>) -> Result<Vec<EndpointVerification>, String> {
    let Some(connection_id) = connection_id.filter(|id| !id.is_empty()) else {
        return Ok(Vec::new());
    };
    let registry = crate::connections::ConnectionRegistry::open()?;
    let record = registry
        .load(connection_id)?
        .ok_or_else(|| format!("connection {connection_id} is not in the shared registry"))?;
    Ok(record.endpoints)
}

pub fn list_available_providers() -> Vec<&'static str> {
    let mut available = Vec::new();
    let home = crate::quota::utils::user_home_dir();
    let grok_path = home.join(".grok").join("bin").join("grok.exe");
    let natives = crate::chat::persistent::opencode_native_paths();
    let opencode_fallbacks: Vec<&str> = natives.iter().map(String::as_str).collect();

    if crate::chat::utils::resolve_agy_bin().is_some() {
        available.push("Antigravity");
    }
    if crate::chat::utils::resolve_codex_bin().is_some() {
        available.push("Codex");
    }
    if resolve_bin("claude", &[]).is_some() {
        available.push("Claude");
    }
    if resolve_bin("agent", &[]).or_else(|| resolve_bin("cursor-agent", &[])).is_some() {
        available.push("Cursor");
    }
    if resolve_bin("grok", &[&grok_path.to_string_lossy()]).is_some() {
        available.push("Grok");
    }
    if resolve_bin("opencode", &opencode_fallbacks).is_some() {
        available.push("OpenCode");
    }
    available
}

/// One local chat spawn form. A driver id is not a permission: each endpoint
/// declares which send values its command line can consume, and the spawn is
/// evidence for that endpoint only.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SpawnEndpoint {
    pub endpoint_id: &'static str,
    /// This spawn form selects a model without an extra opt-in. It reflects
    /// existing supported behavior, not a capability inherited from the driver.
    pub model_by_default: bool,
    pub accepts_model: bool,
    pub accepts_session: bool,
}

impl SpawnEndpoint {
    /// The only endpoint a completed spawn is evidence for. It is never a
    /// network route, so a CLI start cannot verify a chat API endpoint.
    pub fn verified_endpoint(&self) -> &'static str {
        self.endpoint_id
    }
}

pub fn spawn_endpoint(provider: &str) -> Option<SpawnEndpoint> {
    let endpoint = match provider {
        "antigravity" | "agy" => SpawnEndpoint {
            endpoint_id: "agy -p",
            model_by_default: true,
            accepts_model: true,
            accepts_session: true,
        },
        "claude" => SpawnEndpoint {
            endpoint_id: "claude -p",
            model_by_default: true,
            accepts_model: true,
            accepts_session: true,
        },
        "codex" => SpawnEndpoint {
            endpoint_id: "codex exec",
            model_by_default: true,
            accepts_model: true,
            accepts_session: true,
        },
        "cursor" => SpawnEndpoint {
            endpoint_id: "cursor-agent -p",
            model_by_default: false,
            accepts_model: false,
            accepts_session: false,
        },
        // `grok --help` 1.0.70 documents `-m/--model`. The selected model is
        // sent without a separate endpoint claim.
        "grok" => SpawnEndpoint {
            endpoint_id: "grok -p",
            model_by_default: true,
            accepts_model: true,
            accepts_session: false,
        },
        // `opencode run` accepts `--model` (documented by the CLI), but it does
        // not select the Go session header. It is a CLI spawn, not the Go chat
        // endpoint, and the connection registry keeps that split.
        "opencode" => SpawnEndpoint {
            endpoint_id: "opencode run",
            model_by_default: true,
            accepts_model: true,
            accepts_session: false,
        },
        "gemini" => SpawnEndpoint {
            endpoint_id: "gemini --prompt",
            model_by_default: false,
            accepts_model: false,
            accepts_session: false,
        },
        _ => return None,
    };
    Some(endpoint)
}

/// Values a chat or agent send may pass to a spawn. A value reaches the command
/// line only when the endpoint declares it and, for a model on an endpoint that
/// does not select one by default, when the send names the endpoint explicitly.
#[derive(Debug, Clone, Copy, Default)]
pub struct SendValues<'a> {
    pub connection_id: Option<&'a str>,
    pub model: Option<&'a str>,
    pub session_id: Option<&'a str>,
    /// Explicit supported-endpoint flag. It must name this spawn's endpoint and
    /// that endpoint must be verified on `connection_id`.
    pub supported_endpoint: Option<&'a str>,
    pub verified_endpoints: &'a [EndpointVerification],
    pub agent: Option<&'a str>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResolvedSend<'a> {
    pub endpoint: SpawnEndpoint,
    pub connection_id: Option<&'a str>,
    pub model: Option<&'a str>,
    pub session_id: Option<&'a str>,
    pub agent: Option<&'a str>,
}

/// Resolves the send values a spawn may forward. An explicit request is never
/// downgraded to a silent omission: when the supported-endpoint flag cannot be
/// honored, this returns an error.
pub fn resolve_send<'a>(
    provider: &str,
    values: &SendValues<'a>,
) -> Result<ResolvedSend<'a>, String> {
    let endpoint =
        spawn_endpoint(provider).ok_or_else(|| format!("{provider} has no local chat command in this build."))?;
    let supported_endpoint = values.supported_endpoint.filter(|id| !id.is_empty());
    let connection_id = values.connection_id.filter(|id| !id.is_empty());

    if let Some(claimed) = supported_endpoint {
        if claimed != endpoint.endpoint_id {
            return Err(format!(
                "{claimed} is not the endpoint the {provider} spawn uses ({})",
                endpoint.endpoint_id
            ));
        }
        if !endpoint.accepts_model {
            return Err(format!(
                "the {provider} spawn endpoint {claimed} does not support model selection"
            ));
        }
        let connection_id = connection_id.ok_or_else(|| {
            format!("endpoint {claimed} must belong to a connection before a send can use it")
        })?;
        let verified = values
            .verified_endpoints
            .iter()
            .any(|endpoint| endpoint.endpoint_id == claimed && endpoint.ok);
        if !verified {
            return Err(format!(
                "endpoint {claimed} is not verified for connection {connection_id}"
            ));
        }
    } else if connection_id.is_some() {
        return Err(
            "a send cannot pass a connection without naming the endpoint that supports it".to_string(),
        );
    }

    let model = values
        .model
        .filter(|model| !model.is_empty())
        .filter(|_| endpoint.accepts_model && (supported_endpoint.is_some() || endpoint.model_by_default));
    let session_id = values
        .session_id
        .filter(|session| !session.is_empty())
        .filter(|_| endpoint.accepts_session);

    Ok(ResolvedSend {
        endpoint,
        connection_id,
        model,
        session_id,
        agent: values.agent,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpawnArgs {
    pub endpoint: SpawnEndpoint,
    pub args: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct SpawnPlan {
    pub endpoint: SpawnEndpoint,
    pub program: PathBuf,
    pub args: Vec<String>,
    pub connection_id: Option<String>,
}

/// Formats a structured context envelope for non-destructive agent instruction injection
/// into providers that do not accept system prompt CLI flags.
pub fn format_instruction_envelope(instructions: &str, prompt: &str) -> String {
    let trimmed = instructions.trim();
    if trimmed.is_empty() {
        return prompt.to_string();
    }
    format!(
        "--- Agent Instructions & Context ---\n{}\n--- End Agent Instructions ---\n\n{}",
        trimmed, prompt
    )
}

fn merge_instructions_with_plugin_context(
    base: Option<String>,
    plugin_ctx: Option<String>,
) -> Option<String> {
    match (
        base.filter(|s| !s.trim().is_empty()),
        plugin_ctx.filter(|s| !s.trim().is_empty()),
    ) {
        (Some(existing), Some(ctx)) => Some(format!("{}\n\n{}", existing.trim_end(), ctx)),
        (Some(existing), None) => Some(existing),
        (None, Some(ctx)) => Some(ctx),
        (None, None) => None,
    }
}

fn prepare_prompt_arg(
    provider: &str,
    mode: &str,
    prompt: &str,
    instructions: Option<&str>,
) -> String {
    let prompt = clip_argv(prompt);
    let sent = if mode == "readOnly" {
        format!("Read-only mode: do not create, edit, or delete files.\n\n{prompt}")
    } else {
        prompt
    };
    if let Some(inst) = instructions.filter(|s| !s.trim().is_empty()) {
        if !crate::dispatch::programs::accepts_system_prompt(provider) {
            clip_argv(&format_instruction_envelope(inst, &sent))
        } else {
            sent
        }
    } else {
        sent
    }
}

/// Builds verified CLI resume and structured stream-json argument vectors for
/// `"claude"`, `"gemini"`, and `"cursor"` without altering [`spawn_endpoint`]
/// or legacy [`spawn_args`] contract defaults, and delegates all other
/// providers through [`spawn_args_with_instructions`].
pub fn build_verified_resume_args(
    provider: &str,
    mode: &str,
    session_id: Option<&str>,
    model: Option<&str>,
    effort: Option<&str>,
    prompt: &str,
    instructions: Option<&str>,
) -> Result<Vec<String>, String> {
    let trimmed_sid = session_id.map(str::trim).filter(|s| !s.is_empty());
    let trimmed_model = model.map(str::trim).filter(|s| !s.is_empty());

    match provider {
        "claude" => {
            let sent = prepare_prompt_arg(provider, mode, prompt, instructions);
            let permission = match mode {
                "readOnly" => "plan",
                "acceptEdits" => "acceptEdits",
                _ => "bypassPermissions",
            };
            let mut args = vec![
                "-p".into(),
                "--output-format".into(),
                "stream-json".into(),
                "--verbose".into(),
                "--permission-mode".into(),
                permission.into(),
            ];
            if let Some(sid) = trimmed_sid {
                args.push("--resume".into());
                args.push(sid.to_string());
            }
            if let Some(mdl) = trimmed_model {
                args.push("--model".into());
                args.push(mdl.to_string());
            }
            if let Some(inst) = instructions.filter(|s| !s.trim().is_empty()) {
                let sanitized = crate::terminal::launcher::sanitize_cli_system_prompt(inst);
                args.push("--append-system-prompt".into());
                args.push(clip_argv(&sanitized));
            }
            args.push(sent);
            Ok(args)
        }
        "gemini" => {
            let sent = prepare_prompt_arg(provider, mode, prompt, instructions);
            let mut args = Vec::new();
            if let Some(sid) = trimmed_sid {
                args.push("--resume".into());
                args.push(sid.to_string());
            }
            args.push("--output-format".into());
            args.push("stream-json".into());
            args.push("--prompt".into());
            args.push(sent);
            Ok(args)
        }
        "cursor" => {
            let sent = prepare_prompt_arg(provider, mode, prompt, instructions);
            let mut args = vec!["-p".into(), sent];
            if let Some(sid) = trimmed_sid {
                args.push("--resume".into());
                args.push(sid.to_string());
            }
            Ok(args)
        }
        other => {
            let values = SendValues {
                connection_id: None,
                model: trimmed_model,
                session_id: trimmed_sid,
                supported_endpoint: None,
                verified_endpoints: &[],
                agent: None,
            };
            spawn_args_with_instructions(other, mode, &values, effort, prompt, instructions)
                .map(|spawn| spawn.args)
        }
    }
}

/// Builds the argument vector for one spawn endpoint. Program lookup is left to
/// `build_spawn`, so argument rules are testable without an installed CLI.
pub fn spawn_args(
    provider: &str,
    mode: &str,
    values: &SendValues<'_>,
    effort: Option<&str>,
    prompt: &str,
) -> Result<SpawnArgs, String> {
    spawn_args_with_instructions(provider, mode, values, effort, prompt, None)
}

/// Builds the argument vector for one spawn endpoint, optionally injecting compiled agent instructions
/// non-destructively through provider-native CLI flags or structured envelope.
pub fn spawn_args_with_instructions(
    provider: &str,
    mode: &str,
    values: &SendValues<'_>,
    effort: Option<&str>,
    prompt: &str,
    instructions: Option<&str>,
) -> Result<SpawnArgs, String> {
    let resolved = resolve_send(provider, values)?;
    let read_only = mode == "readOnly";
    let sent = prepare_prompt_arg(provider, mode, prompt, instructions);
    let args = match provider {
        "antigravity" | "agy" => {
            let mut args = vec!["-p".into(), sent, "--output-format".into(), "stream-json".into()];
            if let Some(sid) = resolved.session_id {
                args.push("--conversation".into());
                args.push(sid.to_string());
            }
            match mode {
                "readOnly" => {
                    args.push("--mode".into());
                    args.push("plan".into());
                }
                "acceptEdits" => {
                    args.push("--mode".into());
                    args.push("accept-edits".into());
                }
                _ => {
                    args.push("--dangerously-skip-permissions".into());
                }
            }
            if let Some(model) = resolved.model {
                args.push("--model".into());
                args.push(model.into());
            }
            if let Some(effort) =
                crate::chat::models::sanitize_antigravity_cli_effort(resolved.model, effort)
            {
                args.push("--effort".into());
                args.push(effort);
            }
            args
        }
        "claude" => {
            let permission = match mode {
                "readOnly" => "plan",
                "acceptEdits" => "acceptEdits",
                _ => "bypassPermissions",
            };
            let format = if resolved.session_id.is_some() {
                "stream-json"
            } else {
                "text"
            };
            let mut args = vec!["-p".into(), "--output-format".into(), format.into(), "--permission-mode".into(), permission.into()];
            if let Some(sid) = resolved.session_id {
                args.push("--resume".into());
                args.push(sid.to_string());
            }
            if let Some(model) = resolved.model {
                args.push("--model".into());
                args.push(model.into());
            }
            if let Some(inst) = instructions.filter(|s| !s.trim().is_empty()) {
                let sanitized = crate::terminal::launcher::sanitize_cli_system_prompt(inst);
                args.push("--append-system-prompt".into());
                args.push(clip_argv(&sanitized));
            }
            args.push(sent);
            args
        }
        "codex" => {
            let mut args = if let Some(sid) = resolved.session_id {
                vec!["exec".into(), "resume".into(), sid.to_string(), "--skip-git-repo-check".into()]
            } else {
                vec!["exec".into(), "--skip-git-repo-check".into()]
            };
            if read_only {
                args.push("--sandbox".into());
                args.push("read-only".into());
            } else {
                args.push("--dangerously-bypass-approvals-and-sandbox".into());
            }
            if let Some(model) = resolved.model {
                args.push("--model".into());
                args.push(model.into());
            }
            args.push("--json".into());
            args.push(sent);
            args
        }
        "grok" => {
            let effective = crate::chat::normalize::effective_permission_mode("grok", mode);
            let permission = if mode == "readOnly" {
                "plan"
            } else {
                crate::chat::normalize::grok_permission_flag(effective.effective)
            };
            // `-p` is `--single <PROMPT>`. The prompt is the next argument.
            // A flag in that slot makes the CLI reject the turn before it runs.
            let mut args = vec![
                "-p".into(),
                sent,
                "--permission-mode".into(),
                permission.into(),
            ];
            if let Some(model) = resolved.model {
                args.push("--model".into());
                args.push(model.into());
            }
            // `--effort` is the documented alias of `--reasoning-effort`.
            if let Some(effort) = effort.map(str::trim).filter(|level| !level.is_empty()) {
                args.push("--effort".into());
                args.push(effort.into());
            }
            if let Some(inst) = instructions.filter(|s| !s.trim().is_empty()) {
                let sanitized = crate::terminal::launcher::sanitize_cli_system_prompt(inst);
                args.push("--system-prompt-override".into());
                args.push(clip_argv(&sanitized));
            }
            args
        }
        "cursor" => {
            let mut args = vec!["-p".into(), sent];
            if let Some(sid) = resolved.session_id {
                args.push("--resume".into());
                args.push(sid.to_string());
            }
            args
        }
        "opencode" => {
            let mut args = vec!["run".into(), "--format".into(), "json".into()];
            if let Some(agent) = resolved.agent.or(values.agent) {
                if !agent.is_empty() && agent != "build" {
                    args.push("--agent".into());
                    args.push(agent.into());
                }
            }
            if let Some(model) = resolved.model {
                args.push("--model".into());
                args.push(opencode_model_arg(model, effort));
            }
            for file_path in crate::chat::extract_attachment_file_paths(&sent) {
                args.push("--file".into());
                args.push(file_path);
            }
            args.push(sent);
            args
        }
        "gemini" => vec!["--prompt".into(), sent],
        other => return Err(format!("{other} has no local chat command in this build.")),
    };
    Ok(SpawnArgs {
        endpoint: resolved.endpoint,
        args,
    })
}

pub fn resolve_spawn_program(provider: &str) -> Result<PathBuf, String> {
    let home = crate::quota::utils::user_home_dir();
    let program = match provider {
        "antigravity" | "agy" => {
            crate::chat::utils::resolve_agy_bin().ok_or_else(|| {
                let avail = list_available_providers().join(", ");
                format!("Antigravity CLI (agy) is not installed. Available providers: {avail}")
            })?
        }
        "claude" => {
            let appdata_npm = crate::chat::utils::user_roaming_appdata_dir()
                .join("npm")
                .join("claude.cmd");
            let mut fallbacks = vec![appdata_npm.to_string_lossy().to_string()];
            fallbacks.push(home.join(".local").join("bin").join("claude.exe").to_string_lossy().to_string());
            let fb_refs: Vec<&str> = fallbacks.iter().map(String::as_str).collect();
            resolve_bin("claude", &fb_refs).ok_or_else(|| {
                let avail = list_available_providers().join(", ");
                if avail.is_empty() {
                    "Claude Code is not installed. Install it with 'npm install -g @anthropic-ai/claude-code'.".to_string()
                } else {
                    format!("Claude Code is not installed. Installed on this system: {avail}. Please switch providers in the dropdown.")
                }
            })?
        }
        "codex" => {
            crate::chat::utils::resolve_codex_bin().ok_or_else(|| {
                let avail = list_available_providers().join(", ");
                format!("Codex is not installed. Available providers: {avail}")
            })?
        }
        "cursor" => resolve_bin("cursor-agent", &[])
            .or_else(|| resolve_bin("agent", &[]))
            .ok_or_else(|| {
                let avail = list_available_providers().join(", ");
                format!("Cursor Agent is not installed. Available providers: {avail}")
            })?,
        "grok" => {
            let grok_user = home.join(".grok").join("bin").join("grok.exe");
            resolve_bin("grok", &[&grok_user.to_string_lossy()]).ok_or_else(|| {
                let avail = list_available_providers().join(", ");
                format!("Grok is not installed. Available providers: {avail}")
            })?
        }
        "opencode" => {
            let natives = crate::chat::persistent::opencode_native_paths();
            let fallbacks: Vec<&str> = natives.iter().map(String::as_str).collect();
            resolve_bin("opencode", &fallbacks).ok_or_else(|| {
                let avail = list_available_providers().join(", ");
                format!("OpenCode is not installed. Available providers: {avail}")
            })?
        }
        "gemini" => resolve_bin("gemini", &[]).ok_or_else(|| {
            let avail = list_available_providers().join(", ");
            format!("Gemini CLI is not installed. Available providers: {avail}")
        })?,
        other => return Err(format!("{other} has no local chat command in this build.")),
    };
    Ok(program)
}

pub fn build_spawn(
    provider: &str,
    mode: &str,
    values: &SendValues<'_>,
    effort: Option<&str>,
    prompt: &str,
) -> Result<SpawnPlan, String> {
    build_spawn_with_instructions(provider, mode, values, effort, prompt, None)
}

pub fn build_spawn_with_instructions(
    provider: &str,
    mode: &str,
    values: &SendValues<'_>,
    effort: Option<&str>,
    prompt: &str,
    instructions: Option<&str>,
) -> Result<SpawnPlan, String> {
    let spawn = spawn_args_with_instructions(provider, mode, values, effort, prompt, instructions)?;
    let program = resolve_spawn_program(provider)?;
    Ok(SpawnPlan {
        endpoint: spawn.endpoint,
        program,
        args: spawn.args,
        connection_id: values.connection_id.filter(|id| !id.is_empty()).map(str::to_string),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_profile(disabled: Vec<&str>) -> crate::persist::AgentProfile {
        crate::persist::AgentProfile {
            id: "agent-perm-test".to_string(),
            name: "PermTester".to_string(),
            engine: "codex".to_string(),
            purpose: "Testing".to_string(),
            brief: "Test".to_string(),
            avatar: None,
            created_at_unix_ms: 1_000,
            pinned: false,
            order: 0,
            memory_budget: Some(4_000),
            reflection_mode: None,
            allow_agent_scheduling: Some(false),
            allow_agent_messaging: Some(true),
            default_mode: None,
            default_plan: None,
            default_model: None,
            default_provider_options: Vec::new(),
            place_display_names: Vec::new(),
            disabled_plugin_ids: disabled.into_iter().map(str::to_string).collect(),
        }
    }

    #[test]
    fn build_thread_dispatch_env_for_agent_injects_permissions_and_strips_disabled_plugins() {
        let profile = test_profile(vec!["kite-dispatch", "kite-ctx"]);
        let mut env = build_thread_dispatch_env_for_agent(
            "th-perm-1",
            Some("ws-1"),
            None,
            Some(&profile),
        );
        append_context_engine_env(&mut env, "th-perm-1", Some("ws-1"), Some("PermTester"), Some("codex"), None);
        apply_agent_permissions_to_env(&mut env, &profile);

        let get_env = |key: &str| -> Option<String> {
            env.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone())
        };
        assert_eq!(get_env("KITE_AGENT_ID").as_deref(), Some("agent-perm-test"));
        assert_eq!(get_env("KITE_ALLOW_SCHEDULING").as_deref(), Some("false"));
        assert_eq!(get_env("KITE_ALLOW_MESSAGING").as_deref(), Some("true"));
        assert_eq!(
            get_env("KITE_DISABLED_PLUGINS").as_deref(),
            Some("kite-dispatch,kite-ctx")
        );
        assert_eq!(get_env("KITE_DISPATCH"), None, "kite-dispatch must be omitted when disabled");
        assert_eq!(get_env("KITE_SKILL_FILE"), None, "KITE_SKILL_FILE must be omitted when disabled");
        assert_eq!(get_env("KITE_SESSION_ID"), None, "kite-ctx env must be omitted when disabled");
        assert_eq!(get_env("KITE_PROJECT"), None, "kite-ctx env must be omitted when disabled");

        let enabled_profile = test_profile(vec![]);
        let env_ok = build_thread_dispatch_env_for_agent(
            "th-perm-2",
            Some("ws-1"),
            None,
            Some(&enabled_profile),
        );
        assert!(env_ok.iter().any(|(k, v)| k == "KITE_DISPATCH" && v == "1"));
    }

    #[test]
    fn apply_agent_permissions_injects_tool_policies_and_authorized_roots() {
        let aid = format!("ag-env-{}", uuid::Uuid::new_v4());
        let mut cfg = crate::agents::AgentAutonomyConfig::default();
        cfg.tool_policies.insert("shell".into(), "deny".into());
        cfg.tool_policies.insert("tasks".into(), "allow".into());
        crate::agents::save_agent_autonomy_config(&aid, &cfg).unwrap();

        let ws_dir = std::env::temp_dir().join(format!("kite-spawn-ws-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&ws_dir).unwrap();

        let mut profile = test_profile(vec![]);
        profile.id = aid.clone();

        let mut env = Vec::new();
        apply_agent_permissions_to_env_with_workspace(&mut env, &profile, Some(&ws_dir));
        let policies_str = env
            .iter()
            .find(|(k, _)| k == "KITE_TOOL_POLICIES")
            .map(|(_, v)| v.as_str())
            .expect("KITE_TOOL_POLICIES must be injected");
        let policies_val: Value = serde_json::from_str(policies_str).unwrap();
        assert_eq!(policies_val["shell"], "deny");
        assert_eq!(policies_val["tasks"], "allow");
        assert_eq!(policies_val["filesystem_write"], "ask");

        let roots_str = env
            .iter()
            .find(|(k, _)| k == "KITE_AUTHORIZED_ROOTS")
            .map(|(_, v)| v.as_str())
            .expect("KITE_AUTHORIZED_ROOTS must be injected");
        let roots_val: Vec<String> = serde_json::from_str(roots_str).unwrap();
        assert!(!roots_val.is_empty());

        // Stripped when kite-dispatch is disabled
        profile.disabled_plugin_ids = vec!["kite-dispatch".into()];
        let mut stripped_env = vec![("KITE_DISPATCH".into(), "1".into())];
        apply_agent_permissions_to_env_with_workspace(&mut stripped_env, &profile, Some(&ws_dir));
        assert!(!stripped_env.iter().any(|(k, _)| k == "KITE_TOOL_POLICIES"));
        assert!(!stripped_env.iter().any(|(k, _)| k == "KITE_AUTHORIZED_ROOTS"));
        assert!(!stripped_env.iter().any(|(k, _)| k == "KITE_DISPATCH"));

        let _ = std::fs::remove_dir_all(&ws_dir);
    }

    #[test]
    fn spawn_failover_selects_configured_fallback_on_availability_error() {
        let mut tried = Vec::new();
        let res = resolve_spawn_plan_with_failover_using(
            "antigravity",
            &["claude-code".into(), "codex".into()],
            |cand, is_primary| {
                tried.push((cand.to_string(), is_primary));
                if cand == "antigravity" {
                    Err("Antigravity CLI (agy) is not installed.".to_string())
                } else {
                    Ok(SpawnPlan {
                        endpoint: spawn_endpoint("claude").unwrap(),
                        program: PathBuf::from("claude"),
                        args: vec!["-p".into(), "hi".into()],
                        connection_id: None,
                    })
                }
            },
        )
        .expect("should failover to claude");
        assert_eq!(res.0, "claude");
        assert!(res.2.is_some());
        assert_eq!(
            tried,
            vec![("antigravity".into(), true), ("claude".into(), false)]
        );
    }

    #[test]
    fn duration_watch_stops_timed_out_run_and_records_skill_outcome() {
        let root = std::env::temp_dir().join(format!("kite-spawn-skill-{}", uuid::Uuid::new_v4()));
        let aid = uuid::Uuid::new_v4().to_string();
        let skills_dir = root.join(&aid).join("skills");
        std::fs::create_dir_all(&skills_dir).unwrap();
        std::fs::write(
            skills_dir.join("check-ship.md"),
            "---\nname: Check Ship\ndescription: Ship guard\n---\nSteps.\n",
        )
        .unwrap();

        let tid = format!("th-dur-{}", uuid::Uuid::new_v4());
        let rid = format!("run-dur-{}", uuid::Uuid::new_v4());
        {
            let mut list = crate::persist::threads().lock().unwrap();
            list.push(serde_json::json!({
                "id": tid,
                "status": "running",
                "profileId": aid,
                "items": [],
            }));
        }
        {
            let mut live = live_turns().lock().unwrap();
            live.by_thread.insert(tid.clone(), rid.clone());
            live.runs.insert(
                rid.clone(),
                super::super::state::TurnRun {
                    revision: "rev".into(),
                    events: Vec::new(),
                    next_sequence: 0,
                    assistant_id: "a1".into(),
                    assistant_text: String::new(),
                    child: None,
                    stdin: None,
                    closing: false,
                    finished: false,
                    started_at_ms: crate::chat::utils::now_ms(),
                    finished_at_ms: None,
                    routine_id: None,
                    delivered_through: 0,
                    file_baselines: std::collections::HashMap::new(),
                },
            );
        }

        watch_agent_turn_lifecycle(
            &tid,
            &rid,
            &aid,
            &root,
            &["check-ship".to_string()],
            Some(std::time::Duration::from_millis(40)),
        );

        let finished = live_turns()
            .lock()
            .unwrap()
            .runs
            .get(&rid)
            .map(|r| r.finished)
            .unwrap_or(false);
        assert!(finished, "duration watchdog must settle overdue turn");

        let (skills, _) = crate::agent_mind::skills::read_skills(&skills_dir);
        assert_eq!(skills[0]["uses"], 1);
        assert_eq!(skills[0]["lastOutcome"], "failed");

        {
            let mut live = live_turns().lock().unwrap();
            live.runs.remove(&rid);
            live.by_thread.remove(&tid);
        }
        crate::persist::threads()
            .lock()
            .unwrap()
            .retain(|t| t.get("id").and_then(Value::as_str) != Some(tid.as_str()));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn build_verified_resume_args_wires_claude_stream_json_verbose_and_resume() {
        let args = build_verified_resume_args(
            "claude",
            "acceptEdits",
            Some("claude-sess-42"),
            Some("claude-sonnet-4-5"),
            Some("high"),
            "fix tests",
            Some("---\nname: helper\n---\n-Be careful"),
        )
        .expect("claude args");
        assert_eq!(
            args,
            vec![
                "-p",
                "--output-format",
                "stream-json",
                "--verbose",
                "--permission-mode",
                "acceptEdits",
                "--resume",
                "claude-sess-42",
                "--model",
                "claude-sonnet-4-5",
                "--append-system-prompt",
                " -Be careful",
                "fix tests",
            ]
        );

        let turn_one = build_verified_resume_args(
            "claude",
            "readOnly",
            None,
            None,
            None,
            "inspect",
            None,
        )
        .expect("claude turn 1");
        assert_eq!(
            turn_one,
            vec![
                "-p",
                "--output-format",
                "stream-json",
                "--verbose",
                "--permission-mode",
                "plan",
                "Read-only mode: do not create, edit, or delete files.\n\ninspect",
            ]
        );
    }

    #[test]
    fn build_verified_resume_args_wires_gemini_resume_and_stream_json() {
        let resumed = build_verified_resume_args(
            "gemini",
            "fullAccess",
            Some("gem-sess-9"),
            Some("gemini-2.5-pro"),
            None,
            "continue work",
            Some("Role: Analyst"),
        )
        .expect("gemini resumed");
        assert_eq!(
            resumed,
            vec![
                "--resume",
                "gem-sess-9",
                "--output-format",
                "stream-json",
                "--prompt",
                "--- Agent Instructions & Context ---\nRole: Analyst\n--- End Agent Instructions ---\n\ncontinue work",
            ]
        );

        let initial = build_verified_resume_args(
            "gemini",
            "readOnly",
            Some("   "),
            None,
            None,
            "start",
            None,
        )
        .expect("gemini initial");
        assert_eq!(
            initial,
            vec![
                "--output-format",
                "stream-json",
                "--prompt",
                "Read-only mode: do not create, edit, or delete files.\n\nstart",
            ]
        );
    }

    #[test]
    fn build_verified_resume_args_wires_cursor_resume_and_delegates_others() {
        let cursor_resumed = build_verified_resume_args(
            "cursor",
            "fullAccess",
            Some("cur-sess-7"),
            Some("ignored-model"),
            None,
            "check status",
            None,
        )
        .expect("cursor resumed");
        assert_eq!(
            cursor_resumed,
            vec!["-p", "check status", "--resume", "cur-sess-7"]
        );

        let cursor_initial = build_verified_resume_args(
            "cursor",
            "acceptEdits",
            None,
            None,
            None,
            "hello",
            None,
        )
        .expect("cursor initial");
        assert_eq!(cursor_initial, vec!["-p", "hello"]);

        let codex = build_verified_resume_args(
            "codex",
            "acceptEdits",
            Some("codex-sess-1"),
            Some("gpt-5"),
            None,
            "run check",
            None,
        )
        .expect("codex delegated");
        assert_eq!(
            codex,
            vec![
                "exec",
                "resume",
                "codex-sess-1",
                "--skip-git-repo-check",
                "--dangerously-bypass-approvals-and-sandbox",
                "--model",
                "gpt-5",
                "--json",
                "run check",
            ]
        );

        let err = build_verified_resume_args(
            "not-a-provider",
            "fullAccess",
            None,
            None,
            None,
            "hello",
            None,
        )
        .expect_err("unknown provider must fail");
        assert!(err.contains("no local chat command"), "{err}");
    }

    #[test]
    fn dispatch_env_injects_active_sidecars_json_and_instructions_merge_wraps_none() {
        let ws_id = format!("ws-sidecar-test-{}", uuid::Uuid::new_v4());
        let ws_dir =
            std::env::temp_dir().join(format!("kite-spawn-sidecar-{}", uuid::Uuid::new_v4()));
        let sidecar_dir = ws_dir
            .join(".agents")
            .join("plugins")
            .join("ws-ext")
            .join("sidecars")
            .join("panel");
        std::fs::create_dir_all(&sidecar_dir).unwrap();
        std::fs::write(
            ws_dir
                .join(".agents")
                .join("plugins")
                .join("ws-ext")
                .join("plugin.json"),
            r#"{"name":"ws-ext","displayName":"WS Ext"}"#,
        )
        .unwrap();
        std::fs::write(
            sidecar_dir.join("sidecar.json"),
            r#"{"command":"node","args":["s.mjs"],"display_name":"Panel","has_web_ui":true,"ui_config":{"views":[{"title":"Panel","path":"/hub"}]}}"#,
        )
        .unwrap();

        struct WorkspacePathCleanup(String, PathBuf);
        impl Drop for WorkspacePathCleanup {
            fn drop(&mut self) {
                if let Ok(mut paths) = crate::persist::paths().lock() {
                    paths.remove(&self.0);
                }
                let _ = std::fs::remove_dir_all(&self.1);
            }
        }
        let _cleanup = WorkspacePathCleanup(ws_id.clone(), ws_dir.clone());
        crate::persist::paths()
            .lock()
            .unwrap()
            .insert(ws_id.clone(), ws_dir.to_string_lossy().to_string());

        let enabled_profile = test_profile(vec![]);
        let env = build_thread_dispatch_env_for_agent(
            "th-sidecar-1",
            Some(&ws_id),
            None,
            Some(&enabled_profile),
        );
        let sidecars_raw = env
            .iter()
            .find(|(k, _)| k == "KITE_ACTIVE_SIDECARS_JSON")
            .map(|(_, v)| v.as_str())
            .expect("KITE_ACTIVE_SIDECARS_JSON must be injected");
        let parsed: Vec<Value> = serde_json::from_str(sidecars_raw).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0]["namespacedId"], "ws-ext/panel");
        assert_eq!(parsed[0]["sidecarUri"], "sidecar://ws-ext/panel/hub");

        let disabled_profile = test_profile(vec!["ws-ext"]);
        let env_disabled = build_thread_dispatch_env_for_agent(
            "th-sidecar-2",
            Some(&ws_id),
            None,
            Some(&disabled_profile),
        );
        assert!(
            !env_disabled
                .iter()
                .any(|(k, _)| k == "KITE_ACTIVE_SIDECARS_JSON"),
            "disabled plugin sidecars must not be injected"
        );

        assert_eq!(
            merge_instructions_with_plugin_context(None, Some("<plugin_skills>x</plugin_skills>".into())).as_deref(),
            Some("<plugin_skills>x</plugin_skills>")
        );
        assert_eq!(
            merge_instructions_with_plugin_context(
                Some("Agent Role".into()),
                Some("<plugin_rules>y</plugin_rules>".into())
            )
            .as_deref(),
            Some("Agent Role\n\n<plugin_rules>y</plugin_rules>")
        );
    }
}
