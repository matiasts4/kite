//! TCP background loopback server, CLI execution, and daemon integration.

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};

use crate::dispatch::cli::{
    self, bad_token_receipt, check_token, offline_receipt, ExecContext,
};
use crate::dispatch::role::ensure_sample_role;
use crate::dispatch::types::{Caller, DispatchError, Family, Receipt};

use super::audit::{audit_db, import_historical, record_audit_with_target};
use super::protocol::{
    apply_switches, caller_of, endpoint_path, guard_online, now_ms, online_flag, prepare, service,
    STOP,
};

static GUI_STOP: AtomicBool = AtomicBool::new(false);
static GUI_BRIDGE_PORT: AtomicU16 = AtomicU16::new(0);
static DAEMON_DISPATCH_PORT: AtomicU16 = AtomicU16::new(0);

fn wake_blocking_listener(port_slot: &AtomicU16) {
    let port = port_slot.swap(0, Ordering::SeqCst);
    if port != 0 {
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
        let _ = TcpStream::connect_timeout(&addr, Duration::from_millis(50));
    }
}

fn spawn_dispatch_housekeeping() {
    thread::spawn(|| {
        let _ = cli::install_kite_shim();
        let _ = cli::install_dispatch_skill();
        cli::ensure_ctx_integrations_once();
        let _ = ensure_sample_role(&crate::persist::roaming_app_dir());
        let _ = import_historical();
    });
}

fn bind_dispatch_listener(
    endpoint_file: &Path,
    stop_flag: &'static AtomicBool,
    track_gui_port: bool,
) {
    stop_flag.store(false, Ordering::SeqCst);
    if let Ok(mut svc) = service().lock() {
        svc.set_online(true);
    }
    let listener = match TcpListener::bind("127.0.0.1:0") {
        Ok(listener) => listener,
        Err(_) => return,
    };
    let port = match listener.local_addr() {
        Ok(addr) => addr.port(),
        Err(_) => return,
    };
    if track_gui_port {
        GUI_BRIDGE_PORT.store(port, Ordering::SeqCst);
    } else {
        DAEMON_DISPATCH_PORT.store(port, Ordering::SeqCst);
    }
    let token = uuid::Uuid::new_v4().to_string();
    let body = json!({
        "token": token,
        "port": port,
        "pid": std::process::id(),
    });
    if let Some(parent) = endpoint_file.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if std::fs::write(endpoint_file, serde_json::to_vec_pretty(&body).unwrap_or_default()).is_err() {
        if track_gui_port {
            GUI_BRIDGE_PORT.store(0, Ordering::SeqCst);
        } else {
            DAEMON_DISPATCH_PORT.store(0, Ordering::SeqCst);
        }
        return;
    }
    // Keep listener blocking so idle threads sleep in the kernel with zero CPU wakeups;
    // shutdown() / shutdown_gui_bridge() send a local wakeup connection to unblock accept().
    thread::spawn(move || serve(listener, token, stop_flag));
    spawn_dispatch_housekeeping();
}

pub fn start_background() {
    bind_dispatch_listener(&endpoint_path(), &STOP, false);
}

/// Starts the GUI-local dispatch listener (`gui-dispatch-endpoint.json`) so Thread, Swarm,
/// and live model/provider discovery always execute inside the active GUI process holding
/// `persist::threads()`, ACP sessions, and the WebView event handle.
pub fn start_gui_background() {
    bind_dispatch_listener(&crate::dispatch::cli_wire::gui_endpoint_path(), &GUI_STOP, true);
}

pub fn shutdown() {
    STOP.store(true, Ordering::SeqCst);
    wake_blocking_listener(&DAEMON_DISPATCH_PORT);
    if let Ok(mut svc) = service().lock() {
        svc.set_online(false);
    }
    let _ = std::fs::remove_file(endpoint_path());
}

pub fn shutdown_gui_bridge() {
    GUI_STOP.store(true, Ordering::SeqCst);
    wake_blocking_listener(&GUI_BRIDGE_PORT);
    let path = crate::dispatch::cli_wire::gui_endpoint_path();
    let remove_allowed = match std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
    {
        Some(file) => match file.get("pid").and_then(Value::as_u64) {
            Some(pid) => pid == u64::from(std::process::id()),
            None => true,
        },
        None => false,
    };
    if remove_allowed {
        let _ = std::fs::remove_file(path);
    }
}

fn serve(listener: TcpListener, token: String, stop_flag: &'static AtomicBool) {
    while !stop_flag.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, _)) => {
                if stop_flag.load(Ordering::SeqCst) {
                    drop(stream);
                    break;
                }
                let token = token.clone();
                thread::spawn(move || handle_client(stream, &token));
            }
            Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
}

pub(crate) fn is_gui_action_payload(action: &str, payload: &Value) -> bool {
    if matches!(action, "swarm" | "providers" | "models" | "agent" | "browser") {
        return true;
    }
    if action == "run"
        && payload
            .get("via")
            .and_then(Value::as_str)
            .is_some_and(|v| v.eq_ignore_ascii_case("thread"))
    {
        return true;
    }
    for key in ["address", "to", "from", "parent"] {
        if payload
            .get(key)
            .and_then(Value::as_str)
            .is_some_and(|v| v.starts_with("thread:"))
        {
            return true;
        }
    }
    payload.get("children").and_then(Value::as_str).is_some()
}

pub(crate) fn request_targets_gui(request: &Value) -> bool {
    let thread_mode = request
        .get("threadMode")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if let Some(arr) = request.get("argv").and_then(Value::as_array) {
        let argv: Vec<String> = arr
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect();
        return crate::dispatch::cli_wire::should_prefer_gui_endpoint_with_thread_mode(
            &argv,
            request.get("from").and_then(Value::as_str),
            thread_mode,
        );
    }
    if thread_mode {
        return true;
    }
    if let Some(op) = request
        .get("action")
        .or_else(|| request.get("op"))
        .and_then(Value::as_str)
    {
        return is_gui_action_payload(op, request);
    }
    false
}

pub(crate) fn try_forward_to_gui_bridge_at(path: &Path, request: &Value) -> Option<Value> {
    if !request_targets_gui(request) {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    let endpoint = serde_json::from_slice::<Value>(&bytes).ok()?;
    let port = endpoint.get("port").and_then(Value::as_u64).unwrap_or(0) as u16;
    let token = endpoint.get("token").and_then(Value::as_str).unwrap_or("");
    if port == 0 || token.is_empty() {
        return None;
    }
    let addr = format!("127.0.0.1:{port}")
        .parse()
        .unwrap_or(std::net::SocketAddr::from(([127, 0, 0, 1], port)));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(400)).ok()?;
    let mut forwarded = request.clone();
    if let Some(obj) = forwarded.as_object_mut() {
        obj.insert("token".to_string(), json!(token));
    } else {
        forwarded = json!({ "token": token });
    }
    if stream
        .write_all(&serde_json::to_vec(&forwarded).unwrap_or_default())
        .is_err()
        || stream.write_all(b"\n").is_err()
    {
        return None;
    }
    let _ = stream.flush();
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    if reader.read_line(&mut line).is_err() {
        return None;
    }
    serde_json::from_str(line.trim()).ok()
}

pub fn try_forward_to_gui_bridge(request: &Value) -> Option<Value> {
    if cfg!(test) || GUI_BRIDGE_PORT.load(Ordering::SeqCst) != 0 {
        return None;
    }
    try_forward_to_gui_bridge_at(&crate::dispatch::cli_wire::gui_endpoint_path(), request)
}

fn read_thread_with<T, F>(thread_id: &str, extract: F) -> Option<T>
where
    F: FnOnce(&Value) -> Option<T>,
{
    if crate::persist::is_daemon_process() {
        return crate::persist::find_thread_direct(thread_id).and_then(|t| extract(&t));
    }
    let all = crate::persist::threads().lock().ok()?;
    let thread = all
        .iter()
        .find(|t| t.get("id").and_then(Value::as_str) == Some(thread_id))?;
    extract(thread)
}

fn lookup_thread_provider(from: &str) -> Option<String> {
    let tid = from.strip_prefix("thread:").unwrap_or(from).trim();
    if tid.is_empty() {
        return None;
    }
    read_thread_with(tid, |t| {
        t.get("provider")
            .or_else(|| t.get("engine"))
            .and_then(Value::as_str)
            .map(str::to_string)
    })
}

fn lookup_swarm_member_provider(from: &str, member_name: &str) -> Option<String> {
    if member_name.eq_ignore_ascii_case("coordinator") {
        return lookup_thread_provider(from);
    }
    let tid = from.strip_prefix("thread:").unwrap_or(from).trim();
    if tid.is_empty() {
        return None;
    }
    read_thread_with(tid, |coord| {
        coord
            .get("swarmState")
            .and_then(|s| s.get("members"))
            .and_then(Value::as_array)?
            .iter()
            .find(|m| {
                m.get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|n| n.eq_ignore_ascii_case(member_name))
            })
            .and_then(|m| m.get("provider").and_then(Value::as_str).map(str::to_string))
    })
}

fn thread_workspace_path_by_ref(thread_ref: &str) -> Option<PathBuf> {
    let tid = thread_ref.strip_prefix("thread:").unwrap_or(thread_ref).trim();
    if tid.is_empty() {
        return None;
    }
    let (direct_dir, ws_id) = read_thread_with(tid, |thread| {
        let direct = thread
            .get("worktreePath")
            .or_else(|| thread.get("workingDirectory"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(PathBuf::from);
        let ws = thread
            .get("workspaceId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        Some((direct, ws))
    })?;
    if let Some(dir) = direct_dir {
        return Some(dir);
    }
    ws_id
        .as_deref()
        .and_then(crate::persist::workspace_path)
        .map(PathBuf::from)
}

pub(crate) fn resolve_request_workspace_path(request: &Value) -> Option<PathBuf> {
    if let Some(explicit) = request
        .get("workspacePath")
        .or_else(|| request.get("workspace_path"))
        .or_else(|| request.get("cwd"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return Some(PathBuf::from(explicit));
    }
    if let Some(ws) = request
        .get("workspace")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty() && cli::normalize_workspace_mode(s).is_none())
    {
        return Some(PathBuf::from(ws));
    }
    if let Some(ws_path) = request
        .get("workspaceId")
        .or_else(|| request.get("workspace_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .and_then(crate::persist::workspace_path)
    {
        return Some(PathBuf::from(ws_path));
    }
    for key in ["from", "parent"] {
        if let Some(tref) = request.get(key).and_then(Value::as_str) {
            if let Some(path) = thread_workspace_path_by_ref(tref) {
                return Some(path);
            }
        }
    }
    None
}

fn effective_run_via(request: &Value, via: Family, explicit_via: bool) -> Family {
    let from = request.get("from").and_then(Value::as_str).unwrap_or("");
    if explicit_via {
        via
    } else if from.starts_with("thread:") {
        Family::Thread
    } else {
        via
    }
}

fn is_provider_quota_exhausted(provider: &str) -> bool {
    if let Some(status) = crate::quota::service::get_cached_provider_status(provider) {
        return !status.is_available || status.primary_remaining_percent <= 0.0;
    }
    false
}

pub(crate) fn is_provider_healthy_for_dispatch(provider: &str) -> bool {
    crate::chat::models::validate_provider_connection(provider).is_ok()
        && !is_provider_quota_exhausted(provider)
}

fn pick_healthy_failover_target<F>(
    exhausted_provider: &str,
    settings: &crate::subagent_settings::SubagentSettings,
    override_stack: bool,
    is_healthy: &F,
) -> Option<(String, Option<String>, Option<String>)>
where
    F: Fn(&str) -> bool,
{
    if let Some(def) = settings.default_delegation.as_ref() {
        if !def.provider.eq_ignore_ascii_case(exhausted_provider)
            && is_healthy(&def.provider)
            && crate::subagent_settings::check_stack_policy(
                settings,
                Some(&def.provider),
                Some(&def.model),
                override_stack,
            )
            .is_ok()
        {
            return Some((
                def.provider.clone(),
                Some(def.model.clone()),
                def.effort.clone(),
            ));
        }
    }
    for entry in settings.stack.iter().filter(|e| e.enabled) {
        if !entry.provider.eq_ignore_ascii_case(exhausted_provider)
            && is_healthy(&entry.provider)
            && crate::subagent_settings::check_stack_policy(
                settings,
                Some(&entry.provider),
                Some(&entry.model),
                override_stack,
            )
            .is_ok()
        {
            return Some((
                entry.provider.clone(),
                Some(entry.model.clone()),
                entry.effort.clone(),
            ));
        }
    }
    if settings.stack.is_empty() && settings.default_delegation.is_none() {
        for cand in crate::chat::models::THREAD_PROVIDERS {
            if !cand.eq_ignore_ascii_case(exhausted_provider)
                && is_healthy(cand)
                && crate::subagent_settings::check_stack_policy(
                    settings,
                    Some(cand),
                    None,
                    override_stack,
                )
                .is_ok()
            {
                return Some((cand.to_string(), None, None));
            }
        }
    }
    None
}

#[allow(clippy::too_many_arguments)]
fn apply_role_target_and_failover<F>(
    cfg_dir: Option<&std::path::Path>,
    ws_path: Option<&std::path::Path>,
    role_name: Option<&str>,
    provider: &mut Option<String>,
    model: &mut Option<String>,
    effort: &mut Option<String>,
    workspace: &mut Option<String>,
    settings: &crate::subagent_settings::SubagentSettings,
    override_stack: bool,
    is_healthy: &F,
) where
    F: Fn(&str) -> bool,
{
    let explicit_provider = provider.is_some();
    let mut from_agent_profile = false;
    if let Some(rname) = role_name {
        match crate::dispatch::role::resolve_role_target(cfg_dir, ws_path, rname) {
            Some(crate::dispatch::role::ResolvedRoleTarget::AgentProfile(ap)) => {
                from_agent_profile = true;
                if provider.is_none() {
                    *provider = ap.provider;
                }
                if model.is_none() {
                    *model = ap.model;
                }
                if effort.is_none() {
                    *effort = ap.effort;
                }
            }
            Some(crate::dispatch::role::ResolvedRoleTarget::MarkdownRole(rf)) => {
                if provider.is_none() {
                    *provider = rf
                        .provider
                        .as_deref()
                        .and_then(cli::canonical_thread_provider)
                        .or_else(|| cli::canonical_thread_provider(&rf.command))
                        .map(str::to_string);
                }
                if model.is_none() {
                    *model = rf.model;
                }
                if effort.is_none() {
                    *effort = rf.effort;
                }
                if workspace.is_none() {
                    *workspace = rf.workspace;
                }
            }
            None => {}
        }
    }

    if !explicit_provider && from_agent_profile {
        if let Some(ref target_p) = *provider {
            if !is_healthy(target_p) {
                if let Some((fb_p, fb_m, fb_e)) =
                    pick_healthy_failover_target(target_p, settings, override_stack, is_healthy)
                {
                    crate::chat::utils::chat_log(&format!(
                        "dispatch failover: AgentProfile role `{}` provider `{target_p}` unavailable/exhausted; falling back to `{fb_p}`",
                        role_name.unwrap_or("")
                    ));
                    *provider = Some(fb_p);
                    *model = fb_m;
                    if fb_e.is_some() {
                        *effort = fb_e;
                    }
                }
            }
        }
    }
}

pub(crate) fn resolve_command_with_subagent_settings(
    request: &Value,
    command: &cli::Command,
    settings: &crate::subagent_settings::SubagentSettings,
) -> cli::Command {
    resolve_command_with_subagent_settings_using(
        request,
        command,
        settings,
        is_provider_healthy_for_dispatch,
    )
}

pub(crate) fn resolve_command_with_subagent_settings_using<F>(
    request: &Value,
    command: &cli::Command,
    settings: &crate::subagent_settings::SubagentSettings,
    is_healthy: F,
) -> cli::Command
where
    F: Fn(&str) -> bool,
{
    let ws_path = resolve_request_workspace_path(request);
    let cfg_dir = if cfg!(test) {
        None
    } else {
        Some(crate::persist::roaming_app_dir())
    };
    match command.clone() {
        cli::Command::Run {
            via,
            explicit_via,
            mut engine,
            mut provider,
            mut model,
            mut effort,
            mut workspace,
            override_stack,
            name,
            explicit_name,
            parent,
            outlive,
            mut role,
            mut explicit_role,
            file,
            task,
            tasks,
            count,
            wait,
            timeout_ms,
            hidden,
            pane,
            mut program,
            words,
        } => {
            if effective_run_via(request, via, explicit_via) == Family::Thread {
                if !explicit_role && provider.is_none() && engine.is_none() {
                    if let Some(word) = program.take() {
                        if let Some(canon) = cli::canonical_thread_provider(&word) {
                            provider = Some(canon.to_string());
                        } else if role.is_none()
                            && crate::dispatch::role::resolve_role_target(
                                cfg_dir.as_deref(),
                                ws_path.as_deref(),
                                &word,
                            )
                            .is_some()
                        {
                            role = Some(word);
                            explicit_role = true;
                        } else {
                            program = Some(word);
                        }
                    }
                }
                if provider.is_none() {
                    provider = engine.clone();
                }
                apply_role_target_and_failover(
                    cfg_dir.as_deref(),
                    ws_path.as_deref(),
                    role.as_deref(),
                    &mut provider,
                    &mut model,
                    &mut effort,
                    &mut workspace,
                    settings,
                    override_stack,
                    &is_healthy,
                );
                let (next_p, next_m, next_e) =
                    crate::subagent_settings::resolve_thread_selection_defaults(
                        settings,
                        provider,
                        model,
                        effort,
                    );
                provider = next_p;
                model = next_m;
                effort = next_e;
            } else {
                let role_name = if explicit_role {
                    role.as_deref()
                } else {
                    role.as_deref().or_else(|| {
                        program.as_deref().filter(|word| {
                            engine.is_none()
                                && crate::dispatch::role::find_role_across_roots(
                                    cfg_dir.as_deref(),
                                    ws_path.as_deref(),
                                    word,
                                )
                                .is_ok()
                        })
                    })
                };
                if let Some(rf) = role_name.and_then(|name| {
                    crate::dispatch::role::find_role_across_roots(
                        cfg_dir.as_deref(),
                        ws_path.as_deref(),
                        name,
                    )
                    .ok()
                }) {
                    if model.is_none() {
                        model = rf.model.clone();
                    }
                    if effort.is_none() {
                        effort = rf.effort.clone();
                    }
                    if engine.is_none() && rf.command.trim().eq_ignore_ascii_case("auto") {
                        let role_provider = rf
                            .provider
                            .as_deref()
                            .and_then(cli::canonical_thread_provider)
                            .map(str::to_string);
                        let (next_p, next_m, next_e) =
                            crate::subagent_settings::resolve_thread_selection_defaults(
                                settings,
                                role_provider,
                                model.clone(),
                                effort.clone(),
                            );
                        if let Some(prov) = next_p {
                            let canonical_eng = crate::dispatch::programs::canonical(&prov)
                                .unwrap_or(prov.as_str())
                                .to_string();
                            engine = Some(canonical_eng);
                        }
                        if model.is_none() {
                            model = next_m;
                        }
                        if effort.is_none() {
                            effort = next_e;
                        }
                    }
                }
            }
            cli::Command::Run {
                via,
                explicit_via,
                engine,
                provider,
                model,
                effort,
                workspace,
                override_stack,
                name,
                explicit_name,
                parent,
                outlive,
                role,
                explicit_role,
                file,
                task,
                tasks,
                count,
                wait,
                timeout_ms,
                hidden,
                pane,
                program,
                words,
            }
        }
        cli::Command::Swarm(cli::SwarmCommand::Add {
            name,
            mut provider,
            mut model,
            mut effort,
            mut workspace,
            channels,
            fork,
            role,
            override_stack,
            brief,
        }) => {
            apply_role_target_and_failover(
                cfg_dir.as_deref(),
                ws_path.as_deref(),
                role.as_deref(),
                &mut provider,
                &mut model,
                &mut effort,
                &mut workspace,
                settings,
                override_stack,
                &is_healthy,
            );
            let (next_p, next_m, next_e) =
                crate::subagent_settings::resolve_thread_selection_defaults(
                    settings,
                    provider,
                    model,
                    effort,
                );
            provider = next_p;
            model = next_m;
            effort = next_e;
            cli::Command::Swarm(cli::SwarmCommand::Add {
                name,
                provider,
                model,
                effort,
                workspace,
                channels,
                fork,
                role,
                override_stack,
                brief,
            })
        }
        other => other,
    }
}

pub(crate) fn validate_live_command_models_with_settings(
    request: &Value,
    command: &cli::Command,
    settings: &crate::subagent_settings::SubagentSettings,
) -> Result<(), String> {
    let from = request.get("from").and_then(Value::as_str).unwrap_or("");
    match command {
        cli::Command::Run {
            via,
            explicit_via,
            engine,
            provider,
            model,
            override_stack,
            explicit_role,
            program,
            ..
        } => {
            if effective_run_via(request, *via, *explicit_via) != Family::Thread {
                return Ok(());
            }
            let mut explicit_provider = provider.clone().or_else(|| engine.clone());
            if let Some(word) = program {
                if !*explicit_role && explicit_provider.is_none() {
                    if let Some(canon) = cli::canonical_thread_provider(word) {
                        explicit_provider = Some(canon.to_string());
                    }
                }
            }
            let effective_provider = explicit_provider.clone().or_else(|| lookup_thread_provider(from));
            crate::subagent_settings::check_stack_policy(
                settings,
                effective_provider.as_deref(),
                model.as_deref(),
                *override_stack,
            )?;
            if let Some(ref p) = explicit_provider {
                crate::chat::models::validate_provider_connection(p)?;
            }
            if let Some(ref m) = model {
                if let Some(ref p) = effective_provider {
                    crate::chat::models::validate_provider_model_selection(p, m)?;
                } else if !crate::chat::models::model_id_ok(m) {
                    return Err(format!("Invalid model id `{m}`."));
                }
            }
        }
        cli::Command::Swarm(cli::SwarmCommand::Add {
            provider,
            model,
            override_stack,
            ..
        }) => {
            let effective_provider = provider.clone().or_else(|| lookup_thread_provider(from));
            crate::subagent_settings::check_stack_policy(
                settings,
                effective_provider.as_deref(),
                model.as_deref(),
                *override_stack,
            )?;
            if let Some(ref p) = provider {
                crate::chat::models::validate_provider_connection(p)?;
            }
            if let Some(ref m) = model {
                if let Some(ref p) = effective_provider {
                    crate::chat::models::validate_provider_model_selection(p, m)?;
                } else if !crate::chat::models::model_id_ok(m) {
                    return Err(format!("Invalid model id `{m}`."));
                }
            }
        }
        cli::Command::Swarm(cli::SwarmCommand::Model {
            name,
            provider,
            model,
            override_stack,
            ..
        }) => {
            let effective_provider = provider
                .clone()
                .or_else(|| lookup_swarm_member_provider(from, name))
                .or_else(|| lookup_thread_provider(from));
            crate::subagent_settings::check_stack_policy(
                settings,
                effective_provider.as_deref(),
                Some(model.as_str()),
                *override_stack,
            )?;
            if let Some(ref p) = provider {
                crate::chat::models::validate_provider_connection(p)?;
            }
            if let Some(ref p) = effective_provider {
                crate::chat::models::validate_provider_model_selection(p, model)?;
            } else if !crate::chat::models::model_id_ok(model) {
                return Err(format!("Invalid model id `{model}`."));
            }
        }
        _ => {}
    }
    Ok(())
}

#[derive(Debug, Clone)]
pub(crate) struct CallerPermissions {
    pub agent_id: Option<String>,
    pub allow_scheduling: bool,
    pub allow_messaging: bool,
    pub disabled_plugins: Vec<String>,
}

impl Default for CallerPermissions {
    fn default() -> Self {
        Self {
            agent_id: None,
            allow_scheduling: true,
            allow_messaging: true,
            disabled_plugins: Vec::new(),
        }
    }
}

pub(crate) fn resolve_caller_permissions(request: &Value) -> CallerPermissions {
    let explicit_agent_id = request
        .get("agentId")
        .or_else(|| request.get("profileId"))
        .or_else(|| request.pointer("/env/KITE_AGENT_ID"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let thread_agent_id = if explicit_agent_id.is_none() {
        request
            .get("from")
            .and_then(Value::as_str)
            .and_then(|from| from.strip_prefix("thread:"))
            .map(str::trim)
            .filter(|tid| !tid.is_empty())
            .and_then(|tid| {
                read_thread_with(tid, |t| {
                    t.get("profileId")
                        .or_else(|| t.get("agentId"))
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(str::to_string)
                })
            })
    } else {
        None
    };

    let agent_id = explicit_agent_id.or(thread_agent_id);
    if let Some(ref aid) = agent_id {
        if let Some(profile) = crate::persist::find_agent_by_id(aid) {
            return CallerPermissions {
                agent_id: Some(profile.id.clone()),
                allow_scheduling: profile.allow_agent_scheduling.unwrap_or(true),
                allow_messaging: profile.allow_agent_messaging.unwrap_or(true),
                disabled_plugins: crate::plugins::normalize_disabled_plugins(
                    &profile.disabled_plugin_ids,
                ),
            };
        }
    }

    let allow_scheduling = request
        .get("allowAgentScheduling")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let allow_messaging = request
        .get("allowAgentMessaging")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let disabled_plugins = request
        .get("disabledPluginIds")
        .and_then(Value::as_array)
        .map(|arr| {
            let raw: Vec<String> = arr
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect();
            crate::plugins::normalize_disabled_plugins(&raw)
        })
        .unwrap_or_default();

    CallerPermissions {
        agent_id,
        allow_scheduling,
        allow_messaging,
        disabled_plugins,
    }
}

fn agent_error_envelope(id: &str, message: impl Into<String>) -> Value {
    let msg = message.into();
    let receipt = Receipt::new(
        id,
        "agent",
        crate::dispatch::ReceiptStatus::Rejected,
        "",
        false,
        None,
        Some("permission_denied".to_string()),
    );
    let mut val = json!({
        "exit": 1,
        "textOut": msg,
        "receipt": receipt,
    });
    if let Some(obj) = val.get_mut("receipt").and_then(Value::as_object_mut) {
        obj.insert("text".to_string(), json!(msg));
    }
    val
}

fn agent_ok_envelope(payload: Value) -> Value {
    let text = serde_json::to_string_pretty(&payload).unwrap_or_else(|_| payload.to_string());
    json!({
        "exit": 0,
        "textOut": text,
        "result": payload,
    })
}

fn map_memory_target(raw: &str) -> Result<&'static str, String> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "" | "agent" | "memory" => Ok("memory"),
        "user" => Ok("user"),
        other => Err(format!("Unsupported memory target '{other}'. Expected: agent or user.")),
    }
}

fn resolve_routine_revision(snapshot: &Value, agent_id: &str) -> String {
    snapshot
        .get("agentRevisions")
        .and_then(Value::as_array)
        .and_then(|arr| {
            arr.iter()
                .find(|entry| entry.get("agentId").and_then(Value::as_str) == Some(agent_id))
                .and_then(|entry| entry.get("revision").and_then(Value::as_str))
        })
        .unwrap_or("")
        .to_string()
}

fn resolve_teammate_profile(raw_target: &str) -> Option<crate::persist::AgentProfile> {
    let needle = raw_target.trim();
    let stripped = needle.strip_prefix("agent:").unwrap_or(needle).trim();
    if stripped.is_empty() {
        return None;
    }
    let agents = crate::persist::list_agents_snapshot();
    agents
        .into_iter()
        .find(|a| a.id == stripped || a.name.eq_ignore_ascii_case(stripped))
}

fn request_thread_id(request: &Value) -> Option<&str> {
    request
        .get("from")
        .and_then(Value::as_str)
        .map(str::trim)
        .map(|s| s.strip_prefix("thread:").unwrap_or(s))
        .filter(|s| !s.is_empty() && !matches!(*s, "human" | "agent" | "script"))
}

fn resolve_audit_agent_id(request: &Value) -> Option<String> {
    if let Some(explicit) = request
        .get("agentId")
        .or_else(|| request.pointer("/env/KITE_AGENT_ID"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return Some(explicit.to_string());
    }
    if let Some(tid) = request
        .get("from")
        .and_then(Value::as_str)
        .and_then(|s| s.trim().strip_prefix("thread:"))
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if let Some(found) = read_thread_with(tid, |t| {
            t.get("profileId")
                .or_else(|| t.get("agentId"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        }) {
            return Some(found);
        }
    }
    let targeting_agent = request
        .get("address")
        .and_then(Value::as_str)
        .is_some_and(|a| a.starts_with("agent:"));
    if caller_of(request) != Caller::Human && !targeting_agent {
        return request
            .get("profileId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
    }
    None
}

fn normalize_cmp_path(raw: &str) -> String {
    let trimmed = raw.trim();
    let stripped = trimmed
        .strip_prefix(r"\\?\")
        .unwrap_or(trimmed)
        .replace('\\', "/");
    let no_trail = stripped.trim_end_matches('/');
    if cfg!(windows) {
        no_trail.to_ascii_lowercase()
    } else {
        no_trail.to_string()
    }
}

fn resolve_launch_workspace(
    workspace_arg: Option<&str>,
    request: &Value,
) -> (Option<String>, Option<PathBuf>) {
    if let Some(raw) = workspace_arg.map(str::trim).filter(|s| !s.is_empty()) {
        let workspaces_snap = if crate::persist::is_daemon_process() {
            crate::persist::list_workspaces_direct()
        } else {
            crate::persist::workspaces()
                .lock()
                .map(|w| w.clone())
                .unwrap_or_default()
        };
        if let Some(ws) = workspaces_snap
            .iter()
            .find(|w| w.id == raw || w.display_name.eq_ignore_ascii_case(raw))
        {
            let dir = crate::persist::workspace_path(&ws.id).map(PathBuf::from);
            return (Some(ws.id.clone()), dir);
        }

        let target_norm = normalize_cmp_path(raw);
        let canon_target_norm = std::fs::canonicalize(raw)
            .ok()
            .map(|p| normalize_cmp_path(&p.to_string_lossy()));

        let mut all_paths = if crate::persist::is_daemon_process() {
            crate::persist::all_workspace_paths_direct()
        } else {
            crate::persist::all_workspace_paths()
        };
        for ws in &workspaces_snap {
            if !all_paths.contains_key(&ws.id) {
                if let Some(p) = crate::persist::workspace_path(&ws.id) {
                    all_paths.insert(ws.id.clone(), p);
                }
            }
        }
        for (ws_id, ws_path) in all_paths {
            let ws_norm = normalize_cmp_path(&ws_path);
            let canon_ws_norm = std::fs::canonicalize(&ws_path)
                .ok()
                .map(|p| normalize_cmp_path(&p.to_string_lossy()));
            let matches_raw = ws_norm == target_norm
                || canon_target_norm
                    .as_ref()
                    .is_some_and(|c| c == &ws_norm)
                || canon_ws_norm.as_ref().is_some_and(|c| {
                    c == &target_norm
                        || canon_target_norm.as_ref().is_some_and(|ct| ct == c)
                });
            if matches_raw {
                return (Some(ws_id), Some(PathBuf::from(ws_path)));
            }
        }

        let direct = Path::new(raw);
        if direct.is_dir() {
            return (None, Some(direct.to_path_buf()));
        }
        return (None, None);
    }

    let caller_ws_id = request_thread_id(request).and_then(|tid| {
        read_thread_with(tid, |t| {
            t.get("workspaceId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        })
    });
    let caller_dir = request_thread_id(request)
        .and_then(thread_workspace_path_by_ref)
        .or_else(|| {
            caller_ws_id
                .as_deref()
                .and_then(crate::persist::workspace_path)
                .map(PathBuf::from)
        })
        .or_else(|| resolve_request_workspace_path(request));
    (caller_ws_id, caller_dir)
}

fn resolve_launch_provider(requested_provider: Option<&str>, perms: &CallerPermissions) -> String {
    if let Some(raw) = requested_provider.map(str::trim).filter(|s| !s.is_empty()) {
        if let Some(canon) = crate::chat::models::canonical_thread_provider_id(raw) {
            return canon.to_string();
        }
        if let Some(canon) = cli::canonical_thread_provider(raw) {
            return canon.to_string();
        }
    }
    if let Some(aid) = perms.agent_id.as_deref() {
        if let Some(profile) = crate::persist::find_agent_by_id(aid) {
            if let Some(canon) = crate::chat::models::canonical_thread_provider_id(&profile.engine) {
                return canon.to_string();
            }
        }
    }
    "antigravity".to_string()
}

fn derive_launch_title(explicit_title: Option<&str>, prompt: &str) -> String {
    if let Some(t) = explicit_title.map(str::trim).filter(|s| !s.is_empty()) {
        return t.to_string();
    }
    let first_line = prompt
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("Launched Thread");
    let clipped: String = first_line.chars().take(60).collect();
    if clipped.is_empty() {
        "Launched Thread".to_string()
    } else {
        clipped
    }
}

fn agent_command_tool_meta(cmd: &cli::AgentCommand) -> (String, &'static str) {
    match cmd {
        cli::AgentCommand::ThreadList { .. }
        | cli::AgentCommand::ThreadSearch { .. }
        | cli::AgentCommand::ThreadRead { .. }
        | cli::AgentCommand::ThreadLaunch { .. } => ("kite_thread".to_string(), "thread"),
        cli::AgentCommand::MemoryRead { .. }
        | cli::AgentCommand::MemoryAdd { .. }
        | cli::AgentCommand::MemorySearch { .. } => ("kite_memory".to_string(), "memory"),
        cli::AgentCommand::RoutineList { .. }
        | cli::AgentCommand::RoutineCreate { .. }
        | cli::AgentCommand::RoutineToggle { .. }
        | cli::AgentCommand::RoutineRun { .. } => ("kite_routine".to_string(), "routine"),
        cli::AgentCommand::TeammateList
        | cli::AgentCommand::TeammateSend { .. }
        | cli::AgentCommand::TeammateDelegate { .. } => ("kite_teammate".to_string(), "teammate"),
        cli::AgentCommand::Tool(tool_cmd) => {
            let family = cli::tool_family_for_command(tool_cmd);
            (format!("kite_{family}"), family)
        }
    }
}

fn describe_agent_command(cmd: &cli::AgentCommand) -> String {
    match cmd {
        cli::AgentCommand::ThreadList { .. } => "kite_thread.list".to_string(),
        cli::AgentCommand::ThreadSearch { query, .. } => {
            format!("kite_thread.search query=\"{}\"", query.chars().take(60).collect::<String>())
        }
        cli::AgentCommand::ThreadRead { thread_id, .. } => {
            format!("kite_thread.read thread={thread_id}")
        }
        cli::AgentCommand::ThreadLaunch { title, odd_path, .. } => format!(
            "kite_thread.launch title=\"{}\" odd={}",
            title.as_deref().unwrap_or("(auto)").chars().take(60).collect::<String>(),
            odd_path.as_deref().unwrap_or("-")
        ),
        cli::AgentCommand::MemoryRead { target, .. } => format!("kite_memory.read target={target}"),
        cli::AgentCommand::MemoryAdd { target, .. } => format!("kite_memory.add target={target}"),
        cli::AgentCommand::MemorySearch { target, query, .. } => format!(
            "kite_memory.search target={target} query=\"{}\"",
            query.chars().take(60).collect::<String>()
        ),
        cli::AgentCommand::RoutineList { .. } => "kite_routine.list".to_string(),
        cli::AgentCommand::RoutineCreate { name, .. } => {
            format!("kite_routine.create name=\"{}\"", name.chars().take(60).collect::<String>())
        }
        cli::AgentCommand::RoutineToggle { routine_id, enabled, .. } => {
            format!("kite_routine.toggle id={routine_id} enabled={enabled}")
        }
        cli::AgentCommand::RoutineRun { routine_id, .. } => {
            format!("kite_routine.run id={routine_id}")
        }
        cli::AgentCommand::TeammateList => "kite_teammate.list".to_string(),
        cli::AgentCommand::TeammateSend { target, .. } => {
            format!("kite_teammate.send target={target}")
        }
        cli::AgentCommand::TeammateDelegate { target, .. } => {
            format!("kite_teammate.delegate target={target}")
        }
        cli::AgentCommand::Tool(_) => "kite_tool".to_string(),
    }
}

fn dispatch_command_tool_name(cmd: &cli::Command, op: &str) -> String {
    match cmd {
        cli::Command::Run { .. } => "kite_subagent_run".to_string(),
        cli::Command::Send { .. } => "kite_subagent_send".to_string(),
        cli::Command::Wait { .. } => "kite_subagent_wait".to_string(),
        cli::Command::Read { .. } => "kite_subagent_read".to_string(),
        cli::Command::Swarm(..) => "kite_swarm".to_string(),
        _ => format!("kite_dispatch_{op}"),
    }
}

fn execute_agent_command(
    request: &Value,
    id: &str,
    cmd: &cli::AgentCommand,
    perms: &CallerPermissions,
) -> Value {
    let started = std::time::Instant::now();
    let (tool_name, family) = agent_command_tool_meta(cmd);
    let aid_str = perms
        .agent_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("anonymous");
    let caller_tid = request_thread_id(request);

    let denied_msg: Option<String> = match cmd {
        cli::AgentCommand::ThreadList { .. }
        | cli::AgentCommand::ThreadSearch { .. }
        | cli::AgentCommand::ThreadRead { .. }
        | cli::AgentCommand::ThreadLaunch { .. } => {
            if crate::plugins::is_plugin_disabled(&perms.disabled_plugins, "kite-thread")
                || crate::plugins::is_plugin_disabled(&perms.disabled_plugins, "thread")
                || crate::plugins::is_plugin_disabled(&perms.disabled_plugins, "kite_thread")
            {
                Some("Permission denied: thread tool pack is disabled for this agent.".to_string())
            } else {
                None
            }
        }
        cli::AgentCommand::MemoryRead { .. }
        | cli::AgentCommand::MemoryAdd { .. }
        | cli::AgentCommand::MemorySearch { .. } => {
            if crate::plugins::is_plugin_disabled(&perms.disabled_plugins, "kite-memory")
                || crate::plugins::is_plugin_disabled(&perms.disabled_plugins, "memory")
                || crate::plugins::is_plugin_disabled(&perms.disabled_plugins, "kite_memory")
            {
                Some("Permission denied: memory tool pack is disabled for this agent.".to_string())
            } else {
                None
            }
        }
        cli::AgentCommand::RoutineList { .. }
        | cli::AgentCommand::RoutineCreate { .. }
        | cli::AgentCommand::RoutineToggle { .. }
        | cli::AgentCommand::RoutineRun { .. } => {
            if !perms.allow_scheduling {
                Some("Permission denied: allowAgentScheduling is disabled for this agent.".to_string())
            } else if crate::plugins::is_plugin_disabled(&perms.disabled_plugins, "kite-routine")
                || crate::plugins::is_plugin_disabled(&perms.disabled_plugins, "routine")
                || crate::plugins::is_plugin_disabled(&perms.disabled_plugins, "routines")
                || crate::plugins::is_plugin_disabled(&perms.disabled_plugins, "kite_routine")
            {
                Some("Permission denied: routine tool pack is disabled for this agent.".to_string())
            } else {
                None
            }
        }
        cli::AgentCommand::TeammateList
        | cli::AgentCommand::TeammateSend { .. }
        | cli::AgentCommand::TeammateDelegate { .. } => {
            if !perms.allow_messaging {
                Some("Permission denied: allowAgentMessaging is disabled for this agent.".to_string())
            } else if crate::plugins::is_plugin_disabled(&perms.disabled_plugins, "kite-teammate")
                || crate::plugins::is_plugin_disabled(&perms.disabled_plugins, "teammate")
                || crate::plugins::is_plugin_disabled(&perms.disabled_plugins, "teammates")
                || crate::plugins::is_plugin_disabled(&perms.disabled_plugins, "kite_teammate")
            {
                Some("Permission denied: teammate tool pack is disabled for this agent.".to_string())
            } else {
                None
            }
        }
        cli::AgentCommand::Tool(_) => {
            if crate::plugins::is_plugin_disabled(&perms.disabled_plugins, family)
                || crate::plugins::is_plugin_disabled(&perms.disabled_plugins, &format!("kite-{family}"))
                || crate::plugins::is_plugin_disabled(&perms.disabled_plugins, &format!("kite_{family}"))
            {
                Some(format!("Permission denied: {family} tool pack is disabled for this agent."))
            } else {
                None
            }
        }
    };

    if let Some(msg) = denied_msg {
        crate::agents::record_agent_audit_event(
            aid_str,
            caller_tid,
            &tool_name,
            family,
            "denied",
            Some(&msg),
            started.elapsed().as_millis() as i64,
            None,
        );
        return agent_error_envelope(id, msg);
    }

    let approved = request
        .get("approved")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || request
            .get("argv")
            .and_then(Value::as_array)
            .is_some_and(|arr| arr.iter().any(|a| a.as_str() == Some("--approved")));

    if let cli::AgentCommand::Tool(tool_cmd) = cmd {
        let caller_from = request
            .get("from")
            .and_then(Value::as_str)
            .unwrap_or("");
        let ws_path = resolve_request_workspace_path(request);
        return match cli::execute_agent_tool(
            tool_cmd,
            perms.agent_id.as_deref(),
            caller_from,
            ws_path.as_deref(),
            approved,
        ) {
            Ok(val) => agent_ok_envelope(val),
            Err(msg) => agent_error_envelope(id, msg),
        };
    }

    let detail = describe_agent_command(cmd);
    let _ = approved;
    let policy_decision = match cli::check_agent_tool_policy_interactive(
        perms.agent_id.as_deref(),
        caller_tid,
        family,
        &tool_name,
        &detail,
    ) {
        Ok(decision) => decision,
        Err(err) => {
            let verdict_label = if err.starts_with("Approval required:") {
                "asked"
            } else {
                "denied"
            };
            crate::agents::record_agent_audit_event(
                aid_str,
                caller_tid,
                &tool_name,
                family,
                verdict_label,
                Some(&err),
                started.elapsed().as_millis() as i64,
                None,
            );
            return agent_error_envelope(id, err);
        }
    };

    let response = execute_agent_command_inner(request, id, cmd, perms);
    let verdict_label = if policy_decision == "ask" {
        "asked"
    } else {
        "allowed"
    };
    let exit_ok = response.get("exit").and_then(Value::as_i64).unwrap_or(1) == 0;
    let reason = if exit_ok {
        None
    } else {
        response
            .get("textOut")
            .and_then(Value::as_str)
            .or_else(|| response.pointer("/receipt/text").and_then(Value::as_str))
            .or_else(|| response.pointer("/receipt/error").and_then(Value::as_str))
            .map(str::to_string)
    };
    let audit_thread_id = caller_tid.or_else(|| {
        response
            .pointer("/result/threadId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
    });
    crate::agents::record_agent_audit_event(
        aid_str,
        audit_thread_id,
        &tool_name,
        family,
        verdict_label,
        reason.as_deref(),
        started.elapsed().as_millis() as i64,
        None,
    );
    response
}

fn execute_agent_command_inner(
    request: &Value,
    id: &str,
    cmd: &cli::AgentCommand,
    perms: &CallerPermissions,
) -> Value {
    match cmd {
        cli::AgentCommand::ThreadList {
            workspace_id,
            agent_id,
            cursor,
            limit,
        } => {
            let val = crate::chat::thread_index::list_threads_paged(
                workspace_id.as_deref(),
                agent_id.as_deref(),
                *cursor,
                *limit,
            );
            agent_ok_envelope(val)
        }
        cli::AgentCommand::ThreadSearch {
            query,
            workspace_id,
            agent_id,
            cursor,
            limit,
        } => {
            let val = crate::chat::thread_index::search_threads(
                query,
                workspace_id.as_deref(),
                agent_id.as_deref(),
                *cursor,
                *limit,
            );
            agent_ok_envelope(val)
        }
        cli::AgentCommand::ThreadRead {
            thread_id,
            cursor,
            limit,
        } => {
            let val = crate::chat::thread_index::read_thread_items_paged(
                thread_id, *cursor, *limit,
            );
            agent_ok_envelope(val)
        }
        cli::AgentCommand::ThreadLaunch {
            title,
            prompt,
            workspace_id,
            provider,
            model,
            mode,
            effort,
            worktree,
            odd_path,
            open,
            orchestrate,
        } => {
            let (resolved_workspace_id, resolved_ws_dir) =
                resolve_launch_workspace(workspace_id.as_deref(), request);
            let safe_provider = resolve_launch_provider(provider.as_deref(), perms);
            let safe_title = derive_launch_title(title.as_deref(), prompt);
            let created = crate::chat::create_thread(
                None,
                &safe_title,
                &safe_provider,
                resolved_workspace_id.as_deref(),
            );
            let tid = created
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if tid.is_empty() {
                return agent_error_envelope(id, "Failed to create top-level thread.");
            }

            let mut patch = serde_json::Map::new();
            patch.insert("provider".to_string(), json!(safe_provider));
            if let Some(m) = model.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                patch.insert("model".to_string(), json!(m));
            }
            let effective_mode = match mode.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                Some(m) if m.eq_ignore_ascii_case("auto") => {
                    crate::chat::models::default_mode(&safe_provider).to_string()
                }
                Some(m) => m.to_string(),
                None => crate::chat::models::default_mode(&safe_provider).to_string(),
            };
            patch.insert("mode".to_string(), json!(effective_mode));
            if let Some(eff) = effort.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                patch.insert("effort".to_string(), json!(eff));
            }
            crate::chat::configure_thread(&tid, &Value::Object(patch));

            let mut wt_path_opt: Option<String> = None;
            let mut worktree_error: Option<String> = None;
            if *worktree {
                if let Some(dir) = resolved_ws_dir.as_deref() {
                    if let Some(repo_root) = crate::chat::subagents::resolve_git_repo_root(dir) {
                        let short_id: String =
                            tid.chars().filter(|c| *c != '-').take(8).collect();
                        match crate::chat::subagents::provision_subagent_worktree(
                            &repo_root,
                            "branch",
                            &short_id,
                        ) {
                            Ok(wt_path) => {
                                wt_path_opt = Some(wt_path.to_string_lossy().to_string());
                            }
                            Err(err) => {
                                worktree_error = Some(err);
                            }
                        }
                    }
                }
            }
            if let Some(err) = worktree_error {
                crate::chat::threads::remove_thread(&tid);
                return agent_error_envelope(
                    id,
                    format!("Failed to provision git worktree for launched thread: {err}"),
                );
            }

            let clean_odd_path = odd_path
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            let needs_thread_patch = clean_odd_path.is_some()
                || wt_path_opt.is_some()
                || (resolved_workspace_id.is_none() && resolved_ws_dir.is_some());
            if needs_thread_patch {
                let mut mutated_thread: Option<Value> = None;
                crate::persist::hydrate_thread(&tid);
                {
                    if let Ok(mut list) = crate::persist::threads().lock() {
                        if let Some(thread) = list
                            .iter_mut()
                            .find(|t| t.get("id").and_then(Value::as_str) == Some(tid.as_str()))
                        {
                            if let Some(ref odd) = clean_odd_path {
                                thread["oddPath"] = json!(odd);
                            }
                            if let Some(ref wt_str) = wt_path_opt {
                                thread["worktreePath"] = json!(wt_str);
                                thread["workingDirectory"] = json!(wt_str);
                                thread["workspaceMode"] = json!("branch");
                            } else if resolved_workspace_id.is_none() {
                                if let Some(ref dir) = resolved_ws_dir {
                                    thread["workingDirectory"] =
                                        json!(dir.to_string_lossy().to_string());
                                }
                            }
                            crate::chat::threads::touch(thread);
                            mutated_thread = Some(thread.clone());
                        }
                    }
                }
                if let Some(ref t) = mutated_thread {
                    crate::chat::thread_index::index_thread(t);
                    crate::persist::persist();
                }
            }

            let final_prompt = if *orchestrate {
                let odd_line = clean_odd_path
                    .as_deref()
                    .map(|p| format!("Linked ODD spec: `{p}`. Read and follow it end-to-end.\n"))
                    .unwrap_or_default();
                format!(
                    "[Orchestrator Mode]\n\
                     {odd_line}\
                     Coordinate subtasks via `kite_subagent_run` or `kite_swarm` (`kite dispatch run --via thread` / `kite dispatch swarm`), verify changes proportionally, and report verified outcomes.\n\n\
                     {prompt}"
                )
            } else {
                prompt.clone()
            };

            let turn_res = crate::chat::start_turn(&tid, None, &final_prompt, vec![], None);
            if let Some(err) = turn_res.get("error").and_then(Value::as_str) {
                return agent_error_envelope(id, err.to_string());
            }
            let run_id = turn_res.get("runId").cloned().unwrap_or(Value::Null);

            let event_payload = json!({
                "threadId": tid,
                "workspaceId": resolved_workspace_id,
                "title": safe_title,
                "open": *open,
                "oddPath": clean_odd_path,
            });
            if let Some(app) = crate::get_app_handle() {
                use tauri::Emitter;
                let _ = app.emit("chat:thread-created", event_payload.clone());
            }
            crate::core_daemon::broadcast_daemon_ui_event("chat:thread-created", event_payload);

            agent_ok_envelope(json!({
                "schema": "kite.thread-launch/v1",
                "threadId": tid,
                "runId": run_id,
                "provider": safe_provider,
                "workspaceId": resolved_workspace_id,
                "worktreePath": wt_path_opt,
                "open": *open,
                "status": "running",
            }))
        }
        cli::AgentCommand::MemoryRead { target, agent_id } => {
            let Some(aid) = agent_id.as_deref().or(perms.agent_id.as_deref()) else {
                return agent_error_envelope(id, "Memory command requires an agentId (or KITE_AGENT_ID).");
            };
            let mapped = match map_memory_target(target) {
                Ok(t) => t,
                Err(e) => return agent_error_envelope(id, e),
            };
            let root = crate::agent_mind::agents_root();
            match crate::agent_mind::load_agent_mind_at(&root, aid) {
                Ok(mind) => {
                    let (text, rev) = if mapped == "user" {
                        (
                            mind.get("user").and_then(Value::as_str).unwrap_or("").to_string(),
                            mind.get("userRevision").cloned().unwrap_or(Value::Null),
                        )
                    } else {
                        (
                            mind.get("memory").and_then(Value::as_str).unwrap_or("").to_string(),
                            mind.get("memoryRevision").cloned().unwrap_or(Value::Null),
                        )
                    };
                    agent_ok_envelope(json!({
                        "agentId": aid,
                        "target": target,
                        "text": text,
                        "revision": rev,
                    }))
                }
                Err(e) => agent_error_envelope(id, e.message),
            }
        }
        cli::AgentCommand::MemoryAdd {
            text,
            target,
            agent_id,
        } => {
            let Some(aid) = agent_id.as_deref().or(perms.agent_id.as_deref()) else {
                return agent_error_envelope(id, "Memory command requires an agentId (or KITE_AGENT_ID).");
            };
            let mapped = match map_memory_target(target) {
                Ok(t) => t,
                Err(e) => return agent_error_envelope(id, e),
            };
            let root = crate::agent_mind::agents_root();
            let mind = match crate::agent_mind::load_agent_mind_at(&root, aid) {
                Ok(m) => m,
                Err(e) => return agent_error_envelope(id, e.message),
            };
            let (current, current_rev) = if mapped == "user" {
                (
                    mind.get("user").and_then(Value::as_str).unwrap_or(""),
                    mind.get("userRevision").and_then(Value::as_str).map(str::to_string),
                )
            } else {
                (
                    mind.get("memory").and_then(Value::as_str).unwrap_or(""),
                    mind.get("memoryRevision").and_then(Value::as_str).map(str::to_string),
                )
            };
            let updated = if current.trim().is_empty() {
                text.clone()
            } else {
                format!("{}\n{}", current.trim_end(), text)
            };
            match crate::agent_mind::memory::write_agent_memory_at_with_budget(
                &root,
                aid,
                mapped,
                &updated,
                "structured",
                current_rev.as_deref(),
                None,
            ) {
                Ok(saved_mind) => {
                    let rev_key = if mapped == "user" { "userRevision" } else { "memoryRevision" };
                    agent_ok_envelope(json!({
                        "agentId": aid,
                        "target": target,
                        "saved": true,
                        "revision": saved_mind.get(rev_key).cloned().unwrap_or(Value::Null),
                    }))
                }
                Err(e) => agent_error_envelope(id, format!("{}: {}", e.code, e.message)),
            }
        }
        cli::AgentCommand::MemorySearch {
            query,
            target,
            agent_id,
            limit,
        } => {
            let Some(aid) = agent_id.as_deref().or(perms.agent_id.as_deref()) else {
                return agent_error_envelope(id, "Memory command requires an agentId (or KITE_AGENT_ID).");
            };
            let mapped = match map_memory_target(target) {
                Ok(t) => t,
                Err(e) => return agent_error_envelope(id, e),
            };
            let root = crate::agent_mind::agents_root();
            let mind = match crate::agent_mind::load_agent_mind_at(&root, aid) {
                Ok(m) => m,
                Err(e) => return agent_error_envelope(id, e.message),
            };
            let current = if mapped == "user" {
                mind.get("user").and_then(Value::as_str).unwrap_or("")
            } else {
                mind.get("memory").and_then(Value::as_str).unwrap_or("")
            };
            let needle = query.trim().to_ascii_lowercase();
            let all_matches: Vec<String> = current
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty() && line.to_ascii_lowercase().contains(&needle))
                .map(str::to_string)
                .collect();
            let total = all_matches.len();
            let matches: Vec<String> = all_matches.into_iter().take((*limit).clamp(1, 200)).collect();
            agent_ok_envelope(json!({
                "agentId": aid,
                "target": target,
                "query": query,
                "matches": matches,
                "totalMatches": total,
            }))
        }
        cli::AgentCommand::RoutineList { agent_id } => {
            let aid = agent_id.as_deref().or(perms.agent_id.as_deref());
            let snapshot = crate::routines::list_routines(None);
            let routines: Vec<Value> = snapshot
                .get("routines")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter(|r| match aid {
                            Some(id_filter) => r.get("agentId").and_then(Value::as_str) == Some(id_filter),
                            None => true,
                        })
                        .cloned()
                        .collect()
                })
                .unwrap_or_default();
            agent_ok_envelope(json!({
                "agentId": aid,
                "routines": routines,
            }))
        }
        cli::AgentCommand::RoutineCreate {
            agent_id,
            name,
            prompt,
            cadence_seconds,
            workspace_id,
        } => {
            let Some(aid) = agent_id.as_deref().or(perms.agent_id.as_deref()) else {
                return agent_error_envelope(id, "Routine create requires an agentId (or KITE_AGENT_ID).");
            };
            let snapshot = crate::routines::list_routines(None);
            let rev = resolve_routine_revision(&snapshot, aid);
            let req = json!({
                "agentId": aid,
                "expectedRevision": rev,
                "draft": {
                    "name": name,
                    "prompt": prompt,
                    "cadence": { "kind": "interval", "seconds": cadence_seconds },
                    "workspaceId": workspace_id,
                }
            });
            match crate::routines::create_routine(Some(req)) {
                Ok(snap) => agent_ok_envelope(snap),
                Err(e) => agent_error_envelope(id, format!("{}: {}", e.code, e.message)),
            }
        }
        cli::AgentCommand::RoutineToggle {
            agent_id,
            routine_id,
            enabled,
        } => {
            let snapshot = crate::routines::list_routines(None);
            let resolved_aid = agent_id
                .as_deref()
                .or(perms.agent_id.as_deref())
                .map(str::to_string)
                .or_else(|| {
                    snapshot.get("routines").and_then(Value::as_array).and_then(|arr| {
                        arr.iter()
                            .find(|r| r.get("id").and_then(Value::as_str) == Some(routine_id.as_str()))
                            .and_then(|r| r.get("agentId").and_then(Value::as_str))
                            .map(str::to_string)
                    })
                });
            let Some(aid) = resolved_aid else {
                return agent_error_envelope(id, "Routine toggle could not resolve agentId.");
            };
            let rev = resolve_routine_revision(&snapshot, &aid);
            let req = json!({
                "agentId": aid,
                "routineId": routine_id,
                "expectedRevision": rev,
                "enabled": enabled,
            });
            match crate::routines::set_routine_enabled(Some(req)) {
                Ok(snap) => agent_ok_envelope(snap),
                Err(e) => agent_error_envelope(id, format!("{}: {}", e.code, e.message)),
            }
        }
        cli::AgentCommand::RoutineRun {
            agent_id,
            routine_id,
        } => {
            let snapshot = crate::routines::list_routines(None);
            let resolved_aid = agent_id
                .as_deref()
                .or(perms.agent_id.as_deref())
                .map(str::to_string)
                .or_else(|| {
                    snapshot.get("routines").and_then(Value::as_array).and_then(|arr| {
                        arr.iter()
                            .find(|r| r.get("id").and_then(Value::as_str) == Some(routine_id.as_str()))
                            .and_then(|r| r.get("agentId").and_then(Value::as_str))
                            .map(str::to_string)
                    })
                });
            let Some(aid) = resolved_aid else {
                return agent_error_envelope(id, "Routine run could not resolve agentId.");
            };
            let rev = resolve_routine_revision(&snapshot, &aid);
            let req = json!({
                "agentId": aid,
                "routineId": routine_id,
                "expectedRevision": rev,
                "requestId": uuid::Uuid::new_v4().to_string(),
            });
            match crate::routines::run_routine_now(Some(req)) {
                Ok(res) => agent_ok_envelope(res),
                Err(e) => agent_error_envelope(id, format!("{}: {}", e.code, e.message)),
            }
        }
        cli::AgentCommand::TeammateList => {
            let list: Vec<Value> = crate::persist::list_agents_snapshot()
                .iter()
                .map(|a| {
                    json!({
                        "id": a.id,
                        "name": a.name,
                        "engine": a.engine,
                        "purpose": a.purpose,
                        "allowAgentMessaging": a.allow_agent_messaging.unwrap_or(true),
                        "allowAgentScheduling": a.allow_agent_scheduling.unwrap_or(true),
                        "pinned": a.pinned,
                        "isSelf": perms.agent_id.as_deref() == Some(a.id.as_str()),
                    })
                })
                .collect();
            agent_ok_envelope(json!({ "teammates": list }))
        }
        cli::AgentCommand::TeammateSend { target, message } => {
            let recipient_id = if let Some(profile) = resolve_teammate_profile(target) {
                profile.id
            } else if let Some(stripped) = target.strip_prefix("agent:") {
                let s = stripped.trim();
                if s.is_empty() {
                    return agent_error_envelope(id, "Teammate send requires a valid target.");
                }
                s.to_string()
            } else {
                return agent_error_envelope(id, format!("Unknown teammate '{target}'."));
            };
            let sender = request
                .get("from")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .or(perms.agent_id.as_deref())
                .unwrap_or("agent");
            let res = send_agent(&recipient_id, message, "agent", sender, Some(id.to_string()));
            if res.get("delivered").and_then(Value::as_bool) == Some(true) {
                agent_ok_envelope(res)
            } else {
                let err = res
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("teammate_send_failed");
                agent_error_envelope(id, format!("Teammate send failed: {err}"))
            }
        }
        cli::AgentCommand::TeammateDelegate {
            target,
            task,
            wait,
            timeout_ms,
        } => {
            let Some(profile) = resolve_teammate_profile(target) else {
                return agent_error_envelope(id, format!("Unknown teammate '{target}'."));
            };
            let command = cli::Command::Run {
                via: Family::Thread,
                explicit_via: true,
                engine: None,
                provider: Some(profile.engine.clone()),
                model: profile.default_model.clone(),
                effort: None,
                workspace: Some("inherit".to_string()),
                override_stack: true,
                name: None,
                explicit_name: false,
                parent: request
                    .get("from")
                    .and_then(Value::as_str)
                    .filter(|s| !s.trim().is_empty())
                    .map(str::to_string),
                outlive: false,
                role: Some(profile.id.clone()),
                explicit_role: true,
                file: None,
                task: Some(task.clone()),
                tasks: Vec::new(),
                count: None,
                wait: *wait,
                timeout_ms: *timeout_ms,
                hidden: true,
                pane: false,
                program: None,
                words: Vec::new(),
            };
            let receipt = execute_command_inner(request, &command, id, false);
            let exit = crate::dispatch::types::exit_code(&receipt);
            json!({ "exit": exit, "receipt": receipt })
        }
        cli::AgentCommand::Tool(_) => unreachable!("AgentCommand::Tool handled above"),
    }
}

fn build_correlation_query_from_argv(
    argv: &[String],
) -> Option<crate::chat::runtime::DispatchCorrelationQuery> {
    let mut query = crate::chat::runtime::DispatchCorrelationQuery::default();
    let command_hint = argv.join(" ");
    if !command_hint.trim().is_empty() {
        query.command_hint = Some(command_hint);
    }
    if cli::is_agent_argv(argv) {
        if let Ok(agent_cmd) = cli::parse_agent_args(argv) {
            match agent_cmd {
                cli::AgentCommand::Tool(
                    cli::AgentToolCommand::TasksList { .. }
                    | cli::AgentToolCommand::TasksGet { .. }
                    | cli::AgentToolCommand::TasksCreate { .. }
                    | cli::AgentToolCommand::TasksUpdate { .. }
                    | cli::AgentToolCommand::TasksMoveState { .. },
                ) => {
                    query.expected_tools.push("kite_tasks".to_string());
                }
                cli::AgentCommand::ThreadList { .. }
                | cli::AgentCommand::ThreadRead { .. }
                | cli::AgentCommand::ThreadLaunch { .. } => {
                    query.expected_tools.push("kite_thread".to_string());
                }
                cli::AgentCommand::MemoryRead { .. }
                | cli::AgentCommand::MemoryAdd { .. }
                | cli::AgentCommand::MemorySearch { .. } => {
                    query.expected_tools.push("kite_memory".to_string());
                }
                cli::AgentCommand::RoutineList { .. }
                | cli::AgentCommand::RoutineCreate { .. }
                | cli::AgentCommand::RoutineToggle { .. }
                | cli::AgentCommand::RoutineRun { .. } => {
                    query.expected_tools.push("kite_routine".to_string());
                }
                cli::AgentCommand::TeammateList
                | cli::AgentCommand::TeammateSend { .. }
                | cli::AgentCommand::TeammateDelegate { .. } => {
                    query.expected_tools.push("kite_teammate".to_string());
                }
                cli::AgentCommand::Tool(cli::AgentToolCommand::Browser { .. }) => {
                    query.expected_tools.push("kite_browser".to_string());
                }
                _ => {}
            }
        }
        return Some(query);
    }

    match cli::parse_args_detailed(argv) {
        Ok(cli::Command::Run {
            parent,
            role,
            task,
            tasks,
            ..
        }) => {
            if parent
                .as_deref()
                .is_some_and(|p| !p.trim().is_empty())
            {
                return None;
            }
            query.expected_tools.push("kite_subagent_run".to_string());
            query.role = role;
            query.prompt = task;
            query.tasks = tasks;
            query.consume_claim = true;
            Some(query)
        }
        Ok(cli::Command::Swarm(swarm_cmd)) => {
            query.expected_tools.push("kite_swarm".to_string());
            match swarm_cmd {
                cli::SwarmCommand::Title { title } => {
                    query.swarm_action = Some("title".to_string());
                    query.swarm_title = Some(title);
                }
                cli::SwarmCommand::Add {
                    name,
                    role,
                    brief,
                    ..
                } => {
                    query.swarm_action = Some("add".to_string());
                    query.swarm_member = Some(name);
                    query.role = role;
                    query.prompt = Some(brief);
                    query.consume_claim = true;
                }
                cli::SwarmCommand::Post { text, .. } => {
                    query.swarm_action = Some("post".to_string());
                    query.prompt = Some(text);
                }
                cli::SwarmCommand::Read { .. } => {
                    query.swarm_action = Some("read".to_string());
                }
                cli::SwarmCommand::Wait { .. } => {
                    query.swarm_action = Some("wait".to_string());
                }
                cli::SwarmCommand::Status => {
                    query.swarm_action = Some("status".to_string());
                }
                cli::SwarmCommand::Model { name, .. } => {
                    query.swarm_action = Some("model".to_string());
                    query.swarm_member = Some(name);
                }
                cli::SwarmCommand::Kill { name } => {
                    query.swarm_action = Some("kill".to_string());
                    query.swarm_member = Some(name);
                }
                cli::SwarmCommand::Channel { .. } => {
                    query.swarm_action = Some("channel".to_string());
                }
            }
            Some(query)
        }
        Ok(cli::Command::Wait { .. }) => {
            query.expected_tools.push("kite_subagent_wait".to_string());
            Some(query)
        }
        Ok(cli::Command::Read { .. }) => {
            query.expected_tools.push("kite_subagent_read".to_string());
            Some(query)
        }
        Ok(cli::Command::Send { body, .. }) => {
            query.expected_tools.push("kite_subagent_send".to_string());
            query.prompt = body;
            Some(query)
        }
        _ => Some(query),
    }
}

/// Resolves the originating thread ID for a multiplexed daemon request whose per-thread
/// `KITE_ADDRESS` was scrubbed (or flagged `multiplexedDaemon: true`). Uses in-flight ACP
/// tool-call correlation first (with a brief race-guard window outside tests), falling back
/// to `single_active_live_thread_id()` only when exactly one turn is running. Never guesses
/// across multiple concurrent threads.
pub(crate) fn resolve_multiplexed_caller_thread(request: &Value, argv: &[String]) -> Option<String> {
    let raw_from = request
        .get("from")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    let is_mux = request
        .get("multiplexedDaemon")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let is_thread_mode = request
        .get("threadMode")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !is_mux && raw_from.starts_with("thread:") {
        return None;
    }
    if !is_mux && !is_thread_mode && !raw_from.is_empty() {
        return None;
    }
    let query = build_correlation_query_from_argv(argv)?;
    if let Some(tid) = crate::chat::runtime::claim_matching_in_flight_dispatch_thread(&query) {
        return Some(tid);
    }
    if !cfg!(test) && (is_mux || is_thread_mode) {
        for _ in 0..10 {
            thread::sleep(Duration::from_millis(15));
            if let Some(tid) =
                crate::chat::runtime::claim_matching_in_flight_dispatch_thread(&query)
            {
                return Some(tid);
            }
        }
    }
    if is_mux || is_thread_mode {
        return crate::chat::runtime::single_active_live_thread_id();
    }
    None
}

fn execute_argv_dispatch(request: &Value, id: &str, argv: &[String]) -> Value {
    let resolved_owned = resolve_multiplexed_caller_thread(request, argv).map(|tid| {
        let mut cloned = request.clone();
        if let Some(obj) = cloned.as_object_mut() {
            obj.insert("from".to_string(), json!(format!("thread:{tid}")));
        }
        cloned
    });
    let request = resolved_owned.as_ref().unwrap_or(request);
    let perms = resolve_caller_permissions(request);
    if cli::is_agent_argv(argv) {
        return match cli::parse_agent_args(argv) {
            Ok(agent_cmd) => execute_agent_command(request, id, &agent_cmd, &perms),
            Err((err, detail)) => {
                let (code, receipt) = cli::render_detailed_error(id, "agent", err, &detail);
                json!({ "exit": code, "receipt": receipt })
            }
        };
    }
    if crate::plugins::is_plugin_disabled(&perms.disabled_plugins, "kite-dispatch") {
        let msg = "Permission denied: plugin 'kite-dispatch' is disabled for this agent.";
        crate::agents::record_agent_audit_event(
            perms
                .agent_id
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or("anonymous"),
            request_thread_id(request),
            "kite_dispatch",
            "subagents",
            "denied",
            Some(msg),
            0,
            None,
        );
        return agent_error_envelope(id, msg);
    }
    match cli::parse_args_detailed(argv) {
        Ok(cli::Command::Skill) => {
            let ws_path = resolve_request_workspace_path(request);
            json!({ "skill": cli::skill_text_for_workspace(ws_path.as_deref()), "exit": 0 })
        }
        Ok(cli::Command::Providers { refresh }) => {
            let discovery = crate::chat::models::discover_thread_providers(refresh);
            let text = crate::chat::models::format_providers_text(&discovery);
            json!({ "exit": 0, "textOut": text, "providers": discovery })
        }
        Ok(cli::Command::Models { provider, refresh }) => {
            if let Some(prov) = provider {
                let catalog = crate::chat::models::provider_models(&prov, refresh);
                let text = crate::chat::models::format_models_text(&catalog);
                json!({ "exit": 0, "textOut": text, "models": catalog })
            } else {
                let mut sections = Vec::new();
                for prov in crate::chat::models::THREAD_PROVIDERS {
                    let catalog = crate::chat::models::provider_models(prov, refresh);
                    sections.push(crate::chat::models::format_models_text(&catalog));
                }
                json!({ "exit": 0, "textOut": sections.join("\n\n") })
            }
        }
        Ok(command) => {
            let settings = crate::subagent_settings::get_subagent_settings();
            let command = resolve_command_with_subagent_settings(request, &command, &settings);
            let online = service()
                .lock()
                .map(|g| online_flag(&g))
                .unwrap_or(false);
            if online {
                if let Err(detail) =
                    validate_live_command_models_with_settings(request, &command, &settings)
                {
                    let (code, receipt) =
                        cli::render_detailed_error(id, "dispatch", DispatchError::BadArgs, &detail);
                    return json!({ "exit": code, "receipt": receipt });
                }
            }
            let response = match command {
                cli::Command::Swarm(ref swarm_cmd) => execute_swarm_command(request, id, swarm_cmd),
                _ => execute_command(request, &command, id),
            };
            if response.op == "programs" {
                return json!({
                    "programs": response.text.clone().unwrap_or_default(),
                    "exit": 0,
                });
            }
            let exit = crate::dispatch::types::exit_code(&response);
            json!({ "exit": exit, "receipt": response })
        }
        Err((err, detail)) => {
            let (code, receipt) = cli::render_detailed_error(id, "dispatch", err, &detail);
            json!({ "exit": code, "receipt": receipt })
        }
    }
}

fn handle_client(stream: TcpStream, token: &str) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    if reader.read_line(&mut line).is_err() {
        return;
    }
    let request: Value = serde_json::from_str(line.trim()).unwrap_or(Value::Null);
    let presented = request.get("token").and_then(Value::as_str).unwrap_or("");
    let id = request
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("cli")
        .to_string();
    let response = if !check_token(token, presented) {
        bad_token_receipt(&id, "dispatch")
    } else if let Some(forwarded) = try_forward_to_gui_bridge(&request) {
        let _ = write_response(&mut reader, &forwarded);
        return;
    } else if let Some(op) = request.get("op").and_then(Value::as_str) {
        direct_op(&request, op, &id)
    } else {
        let argv = request
            .get("argv")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(|s| s.to_string())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let envelope = execute_argv_dispatch(&request, &id, &argv);
        let _ = write_response(&mut reader, &envelope);
        return;
    };
    let exit = crate::dispatch::types::exit_code(&response);
    let _ = write_response(
        &mut reader,
        &json!({ "exit": exit, "receipt": response }),
    );
}

fn write_response(reader: &mut BufReader<TcpStream>, value: &Value) -> std::io::Result<()> {
    let stream = reader.get_mut();
    let bytes = serde_json::to_vec(value).unwrap_or_else(|_| b"{}".to_vec());
    stream.write_all(&bytes)?;
    stream.write_all(b"\n")?;
    stream.flush()
}

pub fn direct_op(request: &Value, op: &str, id: &str) -> Receipt {
    let address = request.get("address").and_then(Value::as_str).unwrap_or("");
    let mut guard = match service().lock() {
        Ok(guard) => guard,
        Err(poison) => poison.into_inner(),
    };
    if !guard_online(&guard) {
        return offline_receipt(id, op);
    }
    apply_switches(&mut guard, address);
    prepare(&mut guard, address, request.get("observed").and_then(Value::as_str));
    if let Some(alias) = request.get("alias").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
        if let Some(sid) = address.strip_prefix("session:") {
            let _ = guard.attach(Family::Terminal, sid, Some(alias), None, false);
        }
    }
    if let Some(engine) = request.get("engine").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
        if let Some(sid) = address.strip_prefix("session:") {
            let key = crate::dispatch::address::canonical(true, sid);
            guard.set_endpoint_engine(&key, engine);
        }
    }
    match op {
        "publish" => {
            let state = request.get("state").and_then(Value::as_str).unwrap_or("unknown");
            let seq = request.get("seq").and_then(Value::as_u64).unwrap_or_else(now_ms);
            let tail = request.get("tail").and_then(Value::as_str);
            let _ = guard.publish_pane(address, state, seq, now_ms(), tail, None);
            Receipt::new(id, "publish", crate::dispatch::ReceiptStatus::Settled, address, false, Some(state.into()), None)
        }
        "osc" => {
            let raw = request.get("raw").and_then(Value::as_str).unwrap_or("");
            let _ = guard.publish_osc(address, raw, now_ms());
            Receipt::new(id, "osc", crate::dispatch::ReceiptStatus::Settled, address, false, None, None)
        }
        _ => Receipt::new(
            id,
            op,
            crate::dispatch::ReceiptStatus::Rejected,
            address,
            false,
            None,
            Some(DispatchError::BadArgs.code().into()),
        ),
    }
}

pub fn execute_swarm_command(
    request: &Value,
    id: &str,
    swarm_cmd: &cli::SwarmCommand,
) -> Receipt {
    let started = std::time::Instant::now();
    {
        let guard = match service().lock() {
            Ok(guard) => guard,
            Err(poison) => poison.into_inner(),
        };
        if !online_flag(&guard) {
            return offline_receipt(id, "swarm");
        }
    }
    let caller = caller_of(request);
    let from = request
        .get("from")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or(if caller == Caller::Human { "human" } else { "agent" });
    let cwd_buf = resolve_request_workspace_path(request);
    let cwd = cwd_buf.as_ref().and_then(|p| p.to_str());
    let receipt = match crate::chat::swarm::execute_swarm_action(swarm_cmd, from, cwd, None) {
        Ok(text) => {
            let mut receipt = Receipt::new(
                id,
                "swarm",
                crate::dispatch::ReceiptStatus::Settled,
                from,
                false,
                None,
                None,
            );
            receipt.text = Some(text);
            receipt
        }
        Err(err) => Receipt::new(
            id,
            "swarm",
            crate::dispatch::ReceiptStatus::Rejected,
            from,
            false,
            None,
            Some(err.code().into()),
        ),
    };
    if let Some(aid) = resolve_audit_agent_id(request) {
        let verdict = if receipt.status == crate::dispatch::ReceiptStatus::Rejected
            && matches!(
                receipt.error.as_deref(),
                Some("force_forbidden" | "messaging_disabled" | "permission_denied")
            ) {
            "denied"
        } else {
            "allowed"
        };
        crate::agents::record_agent_audit_event(
            &aid,
            request_thread_id(request),
            "kite_swarm",
            "subagents",
            verdict,
            receipt.error.as_deref(),
            started.elapsed().as_millis() as i64,
            None,
        );
    }
    receipt
}

pub fn execute_command(request: &Value, command: &cli::Command, id: &str) -> Receipt {
    execute_command_inner(request, command, id, true)
}

fn execute_command_inner(
    request: &Value,
    command: &cli::Command,
    id: &str,
    record_agent_audit: bool,
) -> Receipt {
    let started = std::time::Instant::now();
    let mut guard = match service().lock() {
        Ok(guard) => guard,
        Err(poison) => poison.into_inner(),
    };
    if !matches!(
        command,
        cli::Command::Skill | cli::Command::Ls | cli::Command::Programs
    ) && !online_flag(&guard)
    {
        return offline_receipt(id, "dispatch");
    }
    let address = match command {
        cli::Command::Send { address, .. } => address.clone(),
        cli::Command::Read { address, .. } => address.clone(),
        cli::Command::Wait { address, .. } => address.clone().unwrap_or_default(),
        cli::Command::Report { to, .. } => to.clone().unwrap_or_default(),
        cli::Command::Kill { address }
        | cli::Command::Interrupt { address }
        | cli::Command::Keys { address, .. }
        | cli::Command::Attach { address } => address.clone(),
        _ => request.get("address").and_then(Value::as_str).unwrap_or("").to_string(),
    };
    apply_switches(&mut guard, &address);
    let caller = caller_of(request);
    let skip_agent_wake = matches!(command, cli::Command::Send { .. })
        && caller != Caller::Human
        && address
            .strip_prefix("agent:")
            .is_some_and(|profile| {
                let (enabled, read_only) = super::protocol::messaging_flags();
                !enabled || read_only || !super::protocol::profile_allows(profile)
            });
    let observed = request.get("observed").and_then(Value::as_str);
    if !skip_agent_wake {
        prepare(&mut guard, &address, observed);
    }
    let from = request
        .get("from")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or(if caller == Caller::Human { "human" } else { "agent" });
    if crate::dispatch::address::is_caller_endpoint(from) {
        prepare(&mut guard, from, None);
    }
    let workspace = resolve_request_workspace_path(request);
    let ctx = ExecContext {
        id,
        caller,
        from,
        now_ms: now_ms(),
        config_dir: Some(&crate::persist::roaming_app_dir()),
        workspace: workspace.as_deref(),
        mounted: request.get("mounted").and_then(Value::as_bool).unwrap_or(false),
    };
    // presentationAlreadyEmitted is honored by rewriting mounted sends through SendInput in execute.
    // The CLI execute path sets presentation from the command, not this flag.
    // A frontend send passes presentationEmitted so the port does not emit a second flight.
    let receipt = if let cli::Command::Send {
        address,
        body,
        file,
        force,
        only_ready,
        allow_queue,
        wait,
        timeout_ms: _,
    } = command
    {
        let input = crate::dispatch::SendInput {
            id: id.to_string(),
            address: address.clone(),
            body: body.clone().unwrap_or_default(),
            caller,
            force: *force,
            allow_queue: *allow_queue,
            only_ready: *only_ready,
            wrap: None,
            from: from.to_string(),
            mounted: ctx.mounted,
            source: request.get("source").and_then(Value::as_str).map(|s| s.to_string()),
            label: request.get("label").and_then(Value::as_str).map(|s| s.to_string()),
            now_ms: now_ms(),
            profile_id: request.get("profileId").and_then(Value::as_str).map(|s| s.to_string()),
            system: false,
            presentation_emitted: request
                .get("presentationEmitted")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        };
        let receipt = if let Some(path) = file {
            match workspace.as_deref() {
                Some(dir) => guard.send_file(input, dir, path),
                None => guard.send(input),
            }
        } else {
            guard.send(input)
        };
        if receipt.submitted {
            if let Some(tid) = receipt.address.strip_prefix("thread:") {
                super::protocol::publish_thread(&mut guard, tid);
            }
            if *wait && (address.starts_with("thread:") || receipt.address.starts_with("thread:")) {
                guard.suppress_parent_notice_for(&receipt.address);
            }
        }
        receipt
    } else {
        match cli::execute(&mut guard, command, &ctx) {
            Ok(receipt) => receipt,
            Err(err) => Receipt::new(id, "dispatch", crate::dispatch::ReceiptStatus::Rejected, "", false, None, Some(err.code().into())),
        }
    };
    drop(guard);
    if !(receipt.op == "wait" && receipt.status == crate::dispatch::ReceiptStatus::Queued) {
        record_audit_with_target(
            &receipt,
            request.get("body").and_then(Value::as_str).unwrap_or(""),
            caller,
            &address,
            request.get("profileId").and_then(Value::as_str),
        );
        if record_agent_audit && !receipt.replayed {
            if let Some(aid) = resolve_audit_agent_id(request) {
                let tool_name = dispatch_command_tool_name(command, &receipt.op);
                let verdict = if receipt.status == crate::dispatch::ReceiptStatus::Rejected
                    && matches!(
                        receipt.error.as_deref(),
                        Some("force_forbidden" | "messaging_disabled" | "permission_denied")
                    ) {
                    "denied"
                } else {
                    "allowed"
                };
                crate::agents::record_agent_audit_event(
                    &aid,
                    request_thread_id(request),
                    &tool_name,
                    "subagents",
                    verdict,
                    receipt.error.as_deref(),
                    started.elapsed().as_millis() as i64,
                    None,
                );
            }
        }
    }
    receipt
}

pub fn inbox(profile_id: &str, before_seq: Option<u64>) -> Value {
    let _ = import_historical();
    let Some(conn) = audit_db() else {
        return json!({ "schemaVersion": 1, "profileId": profile_id, "messages": [], "nextCursor": null });
    };
    let mut stmt = match conn.prepare(
        "SELECT id, sender_name, body, status, submitted, historical, created_ms, thread_id
         FROM dispatch_audit
         WHERE profile_id = ?1 OR address = ?2
         ORDER BY created_ms DESC
         LIMIT 40",
    ) {
        Ok(stmt) => stmt,
        Err(_) => {
            return json!({ "schemaVersion": 1, "profileId": profile_id, "messages": [], "nextCursor": null });
        }
    };
    let address = format!("agent:{profile_id}");
    let rows = stmt
        .query_map(rusqlite::params![profile_id, address], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, Option<String>>(7)?,
            ))
        })
        .ok();
    let mut messages = Vec::new();
    if let Some(rows) = rows {
        for row in rows.flatten() {
            let created = row.6 as u64;
            if let Some(before) = before_seq {
                if created >= before {
                    continue;
                }
            }
            let delivered = row.4 != 0 || row.5 != 0 || row.3 == "submitted" || row.3 == "historical";
            messages.push(json!({
                "id": row.0,
                "senderName": row.1,
                "body": row.2,
                "delivered": delivered,
                "status": if delivered { "submitted" } else { "queued" },
                "threadId": row.7,
            }));
            if messages.len() == 20 {
                break;
            }
        }
    }
    json!({
        "schemaVersion": 1,
        "profileId": profile_id,
        "messages": messages,
        "nextCursor": null
    })
}

pub fn send_agent(
    recipient_id: &str,
    body: &str,
    caller: &str,
    sender_name: &str,
    id: Option<String>,
) -> Value {
    let id = id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let request = json!({
        "id": id,
        "caller": caller,
        "from": sender_name,
        "address": format!("agent:{recipient_id}"),
        "body": body,
        "profileId": recipient_id,
    });
    let command = cli::Command::Send {
        address: format!("agent:{recipient_id}"),
        body: Some(body.to_string()),
        file: None,
        force: false,
        only_ready: false,
        allow_queue: true,
        wait: false,
        timeout_ms: None,
    };
    let receipt = execute_command(&request, &command, &id);
    if receipt.submitted {
        let target_thread_id = receipt
            .address
            .strip_prefix("thread:")
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        crate::routines::dispatch_routine_event_async(
            "on_teammate_message",
            json!({
                "agentId": recipient_id,
                "threadId": target_thread_id,
                "from": sender_name,
                "caller": caller,
            }),
        );
    }
    json!({
        "schemaVersion": 1,
        "delivered": receipt.submitted,
        "messageId": receipt.id,
        "status": receipt_status(&receipt),
        "error": receipt.error,
        "receipt": receipt,
    })
}

fn receipt_status(receipt: &Receipt) -> String {
    match receipt.status {
        crate::dispatch::ReceiptStatus::Queued => "queued",
        crate::dispatch::ReceiptStatus::Submitted => "submitted",
        crate::dispatch::ReceiptStatus::Rejected => "rejected",
        crate::dispatch::ReceiptStatus::Settled => "settled",
        crate::dispatch::ReceiptStatus::Failed => "failed",
        crate::dispatch::ReceiptStatus::Stalled => "stalled",
    }
    .into()
}

fn attach_parent_console() {
    #[cfg(windows)]
    {
        #[link(name = "kernel32")]
        extern "system" {
            fn AttachConsole(dw_process_id: u32) -> i32;
        }
        const ATTACH_PARENT_PROCESS: u32 = 0xFFFFFFFF;
        unsafe {
            let _ = AttachConsole(ATTACH_PARENT_PROCESS);
        }
    }
}

pub use crate::dispatch::cli_wire::{receipt_still_waiting, timeout_receipt};

fn dispatch_over_core_pipe(args: &[String]) -> Option<Value> {
    let caller = if std::env::var("KITE_DISPATCH").ok().as_deref() == Some("1") {
        "agent"
    } else {
        "human"
    };
    // The daemon parses the same argv the loopback endpoint accepts, so an
    // external script keeps dispatching while no GUI window is open (S5).
    let cwd = std::env::current_dir().ok().map(|path| path.display().to_string());
    let mut envelope = json!({
        "argv": args,
        "id": uuid::Uuid::new_v4().to_string(),
        "caller": caller,
        "from": std::env::var("KITE_ADDRESS").unwrap_or_default(),
        "workspacePath": cwd.clone(),
        "workspace": cwd,
    });
    if let Some(obj) = envelope.as_object_mut() {
        if let Ok(agent_id) = std::env::var("KITE_AGENT_ID") {
            let trimmed = agent_id.trim();
            if !trimmed.is_empty() {
                obj.insert("agentId".to_string(), json!(trimmed));
            }
        }
        if let Ok(raw) = std::env::var("KITE_ALLOW_SCHEDULING") {
            match raw.trim().to_ascii_lowercase().as_str() {
                "true" | "1" | "yes" => {
                    obj.insert("allowAgentScheduling".to_string(), json!(true));
                }
                "false" | "0" | "no" => {
                    obj.insert("allowAgentScheduling".to_string(), json!(false));
                }
                _ => {}
            }
        }
        if let Ok(raw) = std::env::var("KITE_ALLOW_MESSAGING") {
            match raw.trim().to_ascii_lowercase().as_str() {
                "true" | "1" | "yes" => {
                    obj.insert("allowAgentMessaging".to_string(), json!(true));
                }
                "false" | "0" | "no" => {
                    obj.insert("allowAgentMessaging".to_string(), json!(false));
                }
                _ => {}
            }
        }
        if let Ok(raw) = std::env::var("KITE_DISABLED_PLUGINS") {
            let disabled: Vec<String> = raw
                .split(',')
                .map(|s| s.trim().to_ascii_lowercase())
                .filter(|s| !s.is_empty())
                .collect();
            if !disabled.is_empty() {
                obj.insert("disabledPluginIds".to_string(), json!(disabled));
            }
        }
    }
    crate::core_daemon::send_core_daemon_rpc("agent.dispatch", Some(envelope)).ok()
}

/// Executes a full dispatch argv envelope, mirroring the loopback endpoint so a
/// daemon-owned core reaches its live PTYs over the pipe.
pub fn execute_argv_envelope(request: &Value) -> Value {
    if let Some(forwarded) = try_forward_to_gui_bridge(request) {
        return forwarded;
    }
    let id = request
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("cli")
        .to_string();
    let argv: Vec<String> = request
        .get("argv")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    execute_argv_dispatch(request, &id, &argv)
}

pub fn run_dispatch_cli(args: &[String]) -> i32 {
    attach_parent_console();
    crate::dispatch::cli_wire::run_cli(args, Some(&dispatch_over_core_pipe))
}
