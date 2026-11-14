use crate::dispatch::address::is_caller_endpoint;
use crate::dispatch::policy::{ChildrenMode, RunInput, SendInput, Service, WaitInput};
use crate::dispatch::port::Port;
use crate::dispatch::presence::PresenceState;
use crate::dispatch::types::{exit_code, Caller, DispatchError, Family, Receipt, ReceiptStatus};
use super::*;

pub fn execute<P: Port>(
    service: &mut Service<P>,
    command: &Command,
    ctx: &ExecContext<'_>,
) -> Result<Receipt, DispatchError> {
    match command {
        Command::Skill => Err(DispatchError::BadArgs),
        Command::Ls => {
            let mut receipt = Receipt::new(
                ctx.id,
                "ls",
                ReceiptStatus::Settled,
                "",
                false,
                None,
                None,
            );
            receipt.text = Some(service.ls().join("\n"));
            Ok(receipt)
        }
        Command::Programs => {
            let mut receipt = Receipt::new(
                ctx.id,
                "programs",
                ReceiptStatus::Settled,
                "",
                false,
                None,
                None,
            );
            receipt.text = Some(crate::dispatch::programs::lines());
            Ok(receipt)
        }
        Command::Providers { .. } => {
            let mut receipt = Receipt::new(
                ctx.id,
                "providers",
                ReceiptStatus::Settled,
                "",
                false,
                None,
                None,
            );
            receipt.text = Some(
                "antigravity\ngrok\ncodex\nclaude\ncursor\nopencode\ngemini".to_string(),
            );
            Ok(receipt)
        }
        Command::Models { provider, .. } => {
            let mut receipt = Receipt::new(
                ctx.id,
                "models",
                ReceiptStatus::Settled,
                provider.as_deref().unwrap_or(""),
                false,
                None,
                None,
            );
            receipt.text = Some(
                provider
                    .as_deref()
                    .map(|p| format!("{p}: run via live desktop runtime for dynamic model list"))
                    .unwrap_or_else(|| {
                        "Run via live desktop runtime (`kite dispatch models <provider>`) for dynamic model lists.".to_string()
                    }),
            );
            Ok(receipt)
        }
        Command::Run {
            via,
            explicit_via,
            engine,
            provider,
            model,
            effort,
            workspace,
            override_stack: _,
            name,
            explicit_name,
            parent,
            outlive,
            role,
            explicit_role,
            file,
            task,
            wait,
            timeout_ms: _,
            hidden,
            pane,
            program,
            words,
        } => {
            let file_text = match (file, ctx.workspace) {
                (Some(path), Some(workspace)) => {
                    Some(crate::dispatch::files::read_workspace_file(workspace, path)?)
                }
                (Some(_), None) => return Err(DispatchError::PathRejected),
                _ => None,
            };
            let effective_via = if *explicit_via {
                *via
            } else if ctx.from.starts_with("thread:") {
                Family::Thread
            } else {
                *via
            };
            if effective_via == Family::Terminal && (provider.is_some() || workspace.is_some()) {
                return Err(DispatchError::BadArgs);
            }
            let parent = inherited_parent(parent.as_ref(), ctx.from);
            let cwd = ctx.workspace.map(|p| p.display().to_string());
            let hide_pane = !show_pane(*hidden, *pane, ctx.caller);
            if effective_via == Family::Thread {
                let mut resolved_provider = provider.clone().or_else(|| engine.clone());
                let mut resolved_role = role.clone();
                let mut words_vec = words.clone();
                if let Some(word) = program {
                    if !*explicit_role && resolved_provider.is_none() {
                        if let Some(canon) = canonical_thread_provider(word) {
                            resolved_provider = Some(canon.to_string());
                        } else if resolved_role.is_none()
                            && crate::dispatch::role::find_role_across_roots(
                                ctx.config_dir,
                                ctx.workspace,
                                word,
                            )
                            .is_ok()
                        {
                            resolved_role = Some(word.clone());
                        } else {
                            words_vec.insert(0, word.clone());
                        }
                    } else {
                        words_vec.insert(0, word.clone());
                    }
                }
                let raw_words = if words_vec.is_empty() {
                    None
                } else {
                    Some(words_vec.join(" "))
                };
                let task = combine_task(file_text, raw_words.or_else(|| task.clone()));
                if *wait && task.as_deref().map(str::trim).unwrap_or("").is_empty() {
                    return Err(DispatchError::BadArgs);
                }
                let loaded_role = resolved_role.as_deref().and_then(|role_name| {
                    crate::dispatch::role::find_role_across_roots(
                        ctx.config_dir,
                        ctx.workspace,
                        role_name,
                    )
                    .ok()
                });
                let role_provider = loaded_role.as_ref().and_then(|rf| {
                    rf.provider
                        .as_deref()
                        .and_then(canonical_thread_provider)
                        .or_else(|| canonical_thread_provider(&rf.command))
                        .map(str::to_string)
                });
                let effective_provider = resolved_provider.or(role_provider);
                let effective_model = model
                    .clone()
                    .or_else(|| loaded_role.as_ref().and_then(|rf| rf.model.clone()));
                let effective_effort = effort
                    .clone()
                    .or_else(|| loaded_role.as_ref().and_then(|rf| rf.effort.clone()));
                let effective_workspace = workspace
                    .clone()
                    .or_else(|| loaded_role.as_ref().and_then(|rf| rf.workspace.clone()));
                let explicit_thread_name = if *explicit_name { name.clone() } else { None };
                let receipt = service.run(RunInput {
                    id: ctx.id.to_string(),
                    via: Family::Thread,
                    engine: effective_provider.clone(),
                    provider: effective_provider,
                    model: effective_model,
                    effort: effective_effort,
                    workspace: effective_workspace,
                    command: None,
                    name: explicit_thread_name,
                    parent,
                    outlive: *outlive,
                    role: loaded_role,
                    subagent_role: resolved_role,
                    role_missing: false,
                    task,
                    caller: ctx.caller,
                    cwd,
                    now_ms: ctx.now_ms,
                    hidden: hide_pane,
                    argv: Vec::new(),
                });
                if *wait && !receipt.address.is_empty() {
                    service.suppress_parent_notice_for(&receipt.address);
                }
                return Ok(receipt);
            }
            let task = combine_task(file_text, task.clone());
            if *explicit_role {
                let role_name = role.as_deref().ok_or(DispatchError::BadArgs)?;
                if let Ok(resolved_role) = crate::dispatch::role::find_role_across_roots(
                    ctx.config_dir,
                    ctx.workspace,
                    role_name,
                ) {
                    let role_provider = resolved_role
                        .provider
                        .clone()
                        .or_else(|| {
                            canonical_thread_provider(&resolved_role.command).map(str::to_string)
                        });
                    return Ok(service.run(RunInput {
                        id: ctx.id.to_string(),
                        via: Family::Terminal,
                        engine: engine.clone(),
                        provider: role_provider,
                        model: model.clone().or_else(|| resolved_role.model.clone()),
                        effort: effort.clone().or_else(|| resolved_role.effort.clone()),
                        workspace: resolved_role.workspace.clone(),
                        command: None,
                        name: Some(name.clone().unwrap_or_else(|| role_name.to_string())),
                        parent,
                        outlive: *outlive,
                        role: Some(resolved_role),
                        subagent_role: Some(role_name.to_string()),
                        role_missing: false,
                        task,
                        caller: ctx.caller,
                        cwd,
                        now_ms: ctx.now_ms,
                        hidden: hide_pane,
                        argv: Vec::new(),
                    }));
                }
                let dir = ctx.config_dir.ok_or(DispatchError::RoleNotFound)?;
                return Ok(service.run_role(
                    ctx.id,
                    dir,
                    role_name,
                    task,
                    parent.as_deref(),
                    ctx.caller,
                    ctx.now_ms,
                    name.clone(),
                    *outlive,
                    hide_pane,
                    cwd,
                ));
            }
            if let Some(word) = program {
                if crate::dispatch::address::is_alias_name(word) {
                    if let Ok(resolved_role) = crate::dispatch::role::find_role_across_roots(
                        ctx.config_dir,
                        ctx.workspace,
                        word,
                    ) {
                        let role_provider = resolved_role
                            .provider
                            .clone()
                            .or_else(|| {
                                canonical_thread_provider(&resolved_role.command).map(str::to_string)
                            });
                        return Ok(service.run(RunInput {
                            id: ctx.id.to_string(),
                            via: Family::Terminal,
                            engine: engine.clone(),
                            provider: role_provider,
                            model: model.clone().or_else(|| resolved_role.model.clone()),
                            effort: effort.clone().or_else(|| resolved_role.effort.clone()),
                            workspace: resolved_role.workspace.clone(),
                            command: None,
                            name: Some(name.clone().unwrap_or_else(|| word.clone())),
                            parent,
                            outlive: *outlive,
                            role: Some(resolved_role),
                            subagent_role: Some(word.clone()),
                            role_missing: false,
                            task,
                            caller: ctx.caller,
                            cwd,
                            now_ms: ctx.now_ms,
                            hidden: hide_pane,
                            argv: Vec::new(),
                        }));
                    }
                }
                let Some(engine_name) = crate::dispatch::programs::canonical(word) else {
                    let mut argv = vec![word.clone()];
                    if !words.is_empty() {
                        argv.extend(words.clone());
                    } else if let Some(rest) = task.clone().filter(|text| !text.is_empty()) {
                        argv.push(rest);
                    }
                    let alias = name.clone().filter(|n| crate::dispatch::address::is_alias_name(n));
                    return Ok(service.run(RunInput {
                        id: ctx.id.to_string(),
                        via: *via,
                        engine: Some(word.clone()),
                        provider: None,
                        model: None,
                        effort: None,
                        workspace: None,
                        command: Some(word.clone()),
                        name: alias,
                        parent,
                        outlive: *outlive,
                        role: None,
                        subagent_role: None,
                        role_missing: false,
                        task: None,
                        caller: ctx.caller,
                        cwd,
                        now_ms: ctx.now_ms,
                        hidden: hide_pane,
                        argv,
                    }));
                };
                return Ok(service.run(RunInput {
                    id: ctx.id.to_string(),
                    via: *via,
                    engine: Some(engine_name.to_string()),
                    provider: None,
                    model: None,
                    effort: None,
                    workspace: None,
                    command: None,
                    name: name.clone(),
                    parent,
                    outlive: *outlive,
                    role: None,
                    subagent_role: None,
                    role_missing: false,
                    task,
                    caller: ctx.caller,
                    cwd,
                    now_ms: ctx.now_ms,
                    hidden: hide_pane,
                    argv: Vec::new(),
                }));
            }
            Ok(service.run(RunInput {
                id: ctx.id.to_string(),
                via: *via,
                engine: engine.clone(),
                provider: None,
                model: None,
                effort: None,
                workspace: None,
                command: None,
                name: name.clone(),
                parent,
                outlive: *outlive,
                role: None,
                subagent_role: None,
                role_missing: false,
                task,
                caller: ctx.caller,
                cwd,
                now_ms: ctx.now_ms,
                hidden: hide_pane,
                argv: Vec::new(),
            }))
        }
        Command::Send {
            address,
            body,
            file,
            force,
            only_ready,
            allow_queue,
        } => {
            let input = SendInput {
                id: ctx.id.to_string(),
                address: address.clone(),
                body: body.clone().unwrap_or_default(),
                caller: ctx.caller,
                force: *force,
                allow_queue: *allow_queue,
                only_ready: *only_ready,
                wrap: None,
                from: ctx.from.to_string(),
                mounted: ctx.mounted,
                source: None,
                label: None,
                now_ms: ctx.now_ms,
                profile_id: None,
                system: false,
                presentation_emitted: false,
            };
            if let Some(path) = file {
                let workspace = ctx.workspace.ok_or(DispatchError::PathRejected)?;
                Ok(service.send_file(input, workspace, path))
            } else {
                Ok(service.send(input))
            }
        }
        Command::Wait {
            address,
            until,
            children,
            timeout_ms,
        } => Ok(service.wait(WaitInput {
            id: ctx.id.to_string(),
            address: address.clone().or_else(|| {
                if ctx.from.is_empty() {
                    None
                } else {
                    Some(ctx.from.to_string())
                }
            }),
            until: until.clone(),
            children: *children,
            timeout_ms: *timeout_ms,
            started_ms: ctx.now_ms,
            now_ms: ctx.now_ms,
        })),
        Command::Read {
            address,
            lines,
            last_assistant,
        } => Ok(service.read_with_mode(ctx.id, address, *lines, *last_assistant)),
        Command::Report {
            to,
            from,
            body,
            file,
        } => {
            let text = if let Some(path) = file {
                let workspace = ctx.workspace.ok_or(DispatchError::PathRejected)?;
                crate::dispatch::files::read_workspace_file(workspace, path)?
            } else {
                body.clone().unwrap_or_default()
            };
            Ok(service.report(
                ctx.id,
                from.as_deref().or(Some(ctx.from).filter(|s| !s.is_empty())),
                to.as_deref(),
                &text,
                ctx.caller,
                ctx.now_ms,
            ))
        }
        Command::Kill { address } => Ok(service.kill(ctx.id, address)),
        Command::Interrupt { address } => Ok(service.interrupt(ctx.id, address)),
        Command::Keys { address, keys } => Ok(service.keys(ctx.id, address, keys)),
        Command::Attach { address } => Ok(service.show(ctx.id, address)),
        Command::Swarm(swarm_cmd) => {
            let cwd = ctx.workspace.map(|p| p.display().to_string());
            Ok(service.swarm(ctx.id, ctx.from, cwd.as_deref(), swarm_cmd))
        }
    }
}

pub fn render_result(result: Result<Receipt, DispatchError>, id: &str, op: &str) -> (i32, String) {
    match result {
        Ok(receipt) => {
            let code = exit_code(&receipt);
            let json = serde_json::to_string(&receipt).unwrap_or_else(|_| "{}".into());
            (code, json)
        }
        Err(DispatchError::BadArgs) => (2, bad_args_line(id, op)),
        Err(err) => {
            let receipt = Receipt::new(
                id,
                op,
                ReceiptStatus::Rejected,
                "",
                false,
                None,
                Some(err.code().into()),
            );
            (exit_code(&receipt), serde_json::to_string(&receipt).unwrap_or_default())
        }
    }
}

pub fn render_detailed_error(id: &str, op: &str, err: DispatchError, detail: &str) -> (i32, Receipt) {
    let mut receipt = Receipt::new(
        id,
        op,
        ReceiptStatus::Rejected,
        "",
        false,
        None,
        Some(err.code().into()),
    );
    if !detail.trim().is_empty() {
        receipt.text = Some(detail.to_string());
    }
    let code = if err == DispatchError::BadArgs { 2 } else { exit_code(&receipt) };
    (code, receipt)
}

pub(super) fn bad_args_line(id: &str, op: &str) -> String {
    let receipt = Receipt::new(
        id,
        op,
        ReceiptStatus::Failed,
        "",
        false,
        None,
        Some(DispatchError::BadArgs.code().into()),
    );
    serde_json::to_string(&receipt).unwrap_or_default()
}

/// Client helper: if the app is not reachable, return runtime_offline and do not spawn anything.
pub fn client_when_unreachable(spawned: &mut u32) -> (i32, Receipt) {
    let _ = spawned;
    let receipt = offline_receipt("offline", "send");
    (exit_code(&receipt), receipt)
}

