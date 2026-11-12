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

pub fn build_thread_dispatch_env(
    thread_id: &str,
    workspace_id: Option<&str>,
    program_path: Option<&Path>,
) -> Vec<(String, String)> {
    let skill = crate::dispatch::cli::install_dispatch_skill();
    let bin = crate::dispatch::cli::install_kite_shim();
    let inherited = std::env::var("PATH").unwrap_or_default();
    compose_thread_dispatch_env(
        thread_id,
        workspace_id,
        &skill,
        &bin,
        program_path,
        &inherited,
    )
}

pub fn launch_provider(
    thread_id: String,
    run_id: String,
    thread: &Value,
    prompt: &str,
    binding: Option<&SendBinding>,
) {
    let provider = thread.get("provider").and_then(|v| v.as_str()).unwrap_or("antigravity").to_string();
    let mode = thread.get("mode").and_then(|v| v.as_str()).unwrap_or("fullAccess").to_string();
    let model = thread.get("model").and_then(|v| v.as_str()).map(|s| s.to_string());
    let provider_session_id = thread.get("providerSessionId").and_then(|v| v.as_str()).map(|s| s.to_string());
    let effort = thread
        .get("providerOptions")
        .and_then(|v| v.as_array())
        .and_then(|arr| {
            arr.iter().find(|opt| opt.get("id").and_then(|v| v.as_str()) == Some("effort"))
        })
        .and_then(|opt| opt.get("value").and_then(|v| v.as_str()))
        .map(|s| s.to_string());
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
        let values = SendValues {
            connection_id: binding.as_ref().and_then(|value| value.connection_id.as_deref()),
            model: model.as_deref(),
            session_id: provider_session_id.as_deref(),
            supported_endpoint: binding
                .as_ref()
                .and_then(|value| value.supported_endpoint.as_deref()),
            verified_endpoints: &verified_endpoints,
            agent: agent.as_deref(),
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
        // Snapshot once. The same value is written before the process starts
        // and stored on the session, so a later agent edit cannot reach it.
        let recipe = profile_id.as_deref().and_then(snapshot_for_agent);
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
        match build_spawn(&provider, &mode, &values, effort.as_deref(), &effective_prompt) {
            Ok(plan) => {
                chat_log(&format!(
                    "spawn: provider={}, endpoint={}, connection={}",
                    provider,
                    plan.endpoint.verified_endpoint(),
                    plan.connection_id.as_deref().unwrap_or("none"),
                ));
                let dispatch_env = build_thread_dispatch_env(
                    &thread_id,
                    workspace_id.as_deref(),
                    Some(&plan.program),
                );
                let persistent_enabled = persistent_sessions_enabled();
                let mut fallback_notice_emitted = false;
                if send_route(&provider, persistent_enabled) == SendRoute::Persistent {
                    if let Some(declared) = declaration(&provider) {
                        // The mode comes from the declaration, not from the
                        // driver id. The declaration and the flag both say
                        // persistent or this branch is never reached.
                        let spec = SessionSpec {
                            thread_id: thread_id.clone(),
                            driver: provider.clone(),
                            connection_id: values.connection_id.map(str::to_string),
                            working_directory: Some(cwd.to_string_lossy().to_string()),
                            mode: SessionMode::OneShot,
                            recipe: recipe.clone(),
                            resume_handle: provider_session_id.clone(),
                            extra_env: Vec::new(),
                        }
                        .with_declared_mode(&declared, persistent_enabled)
                        .with_extra_env(dispatch_env.clone());
                        let first_session = {
                            let manager = session_manager().lock().unwrap();
                            starts_new_session(manager.status(&thread_id).map(|record| record.state))
                        };
                        let controls = PersistentControls {
                            model: model.clone(),
                            effort: effort.clone(),
                            permission_mode: Some(mode.clone()),
                        };
                        let cwd_for_prepare = cwd.clone();
                        let recipe_for_prepare = recipe.clone();
                        let outcome = {
                            match select_persistent_transport(&provider, controls) {
                                Ok(selected) => {
                                    chat_log(&format!(
                                        "persistent transport: driver={}, kind={:?}, minimum={}",
                                        selected.driver, selected.kind, selected.version.minimum
                                    ));
                                    let mut manager = session_manager().lock().unwrap();
                                    managed_send_prepared(
                                        &mut manager,
                                        spec,
                                        selected.transport,
                                        &run_id,
                                        &prompt,
                                        move || {
                                            if !first_session {
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
                                // Selection reads the driver declaration and its
                                // version evidence. Nothing was attached and no
                                // process started, so the prompt can run on the
                                // one-command path below.
                                Err(reason) => Err(ManagedSendError::Start(reason)),
                            }
                        };
                        match outcome {
                            Ok(_) => {
                                // The lasting wire accepted the turn. Its frames
                                // are projected into this live run until the
                                // turn ends, fails, or the process exits.
                                pump_persistent_session(
                                    thread_id.clone(),
                                    run_id.clone(),
                                    assistant_id.clone(),
                                );
                                return;
                            }
                            Err(ManagedSendError::Prepare(reason)) => {
                                // The recipe never landed on disk, so neither
                                // the lasting session nor a one-command send may
                                // run without it.
                                emit_notice_item(
                                    &thread_id,
                                    &run_id,
                                    &format!(
                                        "The agent recipe could not be written, so the {provider} session did not start: {reason} Your message is still in the thread."
                                    ),
                                );
                                finish_run(&run_id, false, false, &reason);
                                return;
                            }
                            Err(error) if error.before_turn() => {
                                // Nothing was written to a provider, so the
                                // user prompt is still intact and can run on
                                // today's one-command path.
                                emit_notice_item(
                                    &thread_id,
                                    &run_id,
                                    &persistent_fallback_notice(&provider, error.reason()),
                                );
                                fallback_notice_emitted = true;
                            }
                            Err(error) => {
                                // The turn may have reached the provider, so
                                // it is never replayed as a second command.
                                emit_notice_item(
                                    &thread_id,
                                    &run_id,
                                    &format!(
                                        "{provider} failed while accepting the turn on its session: {}. Your message is still in the thread.",
                                        error.reason()
                                    ),
                                );
                                finish_run(&run_id, false, false, "");
                                return;
                            }
                        }
                    }
                }
                if !fallback_notice_emitted {
                    if let Some(notice) = one_shot_notice(&provider, persistent_enabled) {
                        emit_notice_item(&thread_id, &run_id, &notice);
                    }
                }
                if let Err(reason) = apply_agent_recipe(&cwd, recipe.as_ref()) {
                    emit_notice_item(
                        &thread_id,
                        &run_id,
                        &format!(
                            "The agent recipe could not be written before {provider} started: {reason} Your message is still in the thread."
                        ),
                    );
                    finish_run(&run_id, false, false, &reason);
                    return;
                }
                let args_refs: Vec<&str> = plan.args.iter().map(|s| s.as_str()).collect();
                match crate::hidden_exec::spawn_streaming_with_owned_env(
                    &plan.program,
                    &args_refs,
                    Some(&cwd),
                    &dispatch_env,
                ) {
                    Ok(child) => stream_child(thread_id, run_id, assistant_id, child),
                    Err(err) => finish_run(&run_id, false, false, &format!("{provider} failed to start: {err}")),
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
    let codex_path = home.join("AppData").join("Local").join("Programs").join("OpenAI").join("Codex").join("bin").join("codex.exe");
    let natives = crate::chat::persistent::opencode_native_paths();
    let opencode_fallbacks: Vec<&str> = natives.iter().map(String::as_str).collect();

    if resolve_bin("agy", &[r"C:\Users\PC\AppData\Local\agy\bin\agy.exe"]).is_some() {
        available.push("Antigravity");
    }
    if resolve_bin("codex", &[
        r"C:\Users\PC\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe",
        r"C:\Users\PC\AppData\Local\Programs\OpenAI\codex.exe",
        &codex_path.to_string_lossy(),
    ]).is_some() {
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

/// Builds the argument vector for one spawn endpoint. Program lookup is left to
/// `build_spawn`, so argument rules are testable without an installed CLI.
pub fn spawn_args(
    provider: &str,
    mode: &str,
    values: &SendValues<'_>,
    effort: Option<&str>,
    prompt: &str,
) -> Result<SpawnArgs, String> {
    let resolved = resolve_send(provider, values)?;
    let prompt = clip_argv(prompt);
    let read_only = mode == "readOnly";
    let sent = if read_only {
        format!("Read-only mode: do not create, edit, or delete files.\n\n{prompt}")
    } else {
        prompt
    };
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
            if let Some(effort) = effort {
                args.push("--effort".into());
                args.push(effort.into());
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
            let agy_user = home.join("AppData").join("Local").join("agy").join("bin").join("agy.exe");
            resolve_bin("agy", &[r"C:\Users\PC\AppData\Local\agy\bin\agy.exe", &agy_user.to_string_lossy()]).ok_or_else(|| {
                let avail = list_available_providers().join(", ");
                format!("Antigravity CLI (agy) is not installed. Available providers: {avail}")
            })?
        }
        "claude" => {
            let appdata_npm = std::env::var("APPDATA")
                .map(|a| PathBuf::from(a).join("npm").join("claude.cmd"))
                .ok();
            let mut fallbacks = Vec::new();
            if let Some(ref p) = appdata_npm {
                fallbacks.push(p.to_string_lossy().to_string());
            }
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
            let codex_user = home.join("AppData").join("Local").join("Programs").join("OpenAI").join("Codex").join("bin").join("codex.exe");
            resolve_bin("codex", &[
                r"C:\Users\PC\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe",
                r"C:\Users\PC\AppData\Local\Programs\OpenAI\codex.exe",
                &codex_user.to_string_lossy(),
            ]).ok_or_else(|| {
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
    let spawn = spawn_args(provider, mode, values, effort, prompt)?;
    let program = resolve_spawn_program(provider)?;
    Ok(SpawnPlan {
        endpoint: spawn.endpoint,
        program,
        args: spawn.args,
        connection_id: values.connection_id.filter(|id| !id.is_empty()).map(str::to_string),
    })
}
