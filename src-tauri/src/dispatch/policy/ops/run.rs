use std::path::Path;

use crate::dispatch::address::is_alias_name;
use crate::dispatch::envelope::{last_lines, wrap_envelope};
use crate::dispatch::files::read_workspace_file;
use crate::dispatch::keys::encode_key;
use crate::dispatch::policy::service::Service;
use crate::dispatch::policy::types::*;
use crate::dispatch::port::{Port, StartRequest, StartThreadRequest, SubmitMeta};
use crate::dispatch::presence::{choose_effective, is_ready, BlockKind, Presence, PresenceState};
use crate::dispatch::programs;
use crate::dispatch::role::load_role;
use crate::dispatch::trace::{handoff_event, record, Fields};
use crate::dispatch::types::{
    Caller, DispatchError, Family, Receipt, ReceiptStatus, BODY_LIMIT, DEFAULT_READ_LINES,
    QUEUE_DEPTH, STALL_MS,
};

impl<P: Port> Service<P> {
    pub fn swarm(
        &mut self,
        id: &str,
        from: &str,
        cwd: Option<&str>,
        command: &crate::dispatch::cli::SwarmCommand,
    ) -> Receipt {
        if let Some(existing) = self.receipts.get(id) {
            let mut replay = existing.clone();
            replay.replayed = true;
            return replay;
        }
        if !self.online {
            return self.finish(rejected(id, "swarm", from, DispatchError::RuntimeOffline));
        }
        match self.port.swarm(from, cwd, command) {
            Ok(text) => {
                let mut receipt =
                    Receipt::new(id, "swarm", ReceiptStatus::Settled, from, false, None, None);
                receipt.text = Some(text);
                self.finish(receipt)
            }
            Err(err) => self.finish(rejected(id, "swarm", from, err)),
        }
    }

    pub fn report(
        &mut self,
        id: &str,
        from: Option<&str>,
        to: Option<&str>,
        body: &str,
        caller: Caller,
        now_ms: u64,
    ) -> Receipt {
        if let Some(existing) = self.receipts.get(id) {
            return existing.clone();
        }
        let from_key = match from {
            Some(raw) => self.resolve(raw).ok(),
            None => None,
        };
        if let Some(ref key) = from_key {
            if let Some(ep) = self.endpoints.get_mut(key) {
                if ep.saw_working {
                    ep.sent_report_since_working = true;
                }
            }
        }
        let target = if let Some(raw) = to {
            raw.to_string()
        } else if let Some(key) = from_key.as_ref() {
            match self.endpoints.get(key).and_then(|ep| ep.parent.clone()) {
                Some(parent) => parent,
                None => {
                    return self.finish(rejected(id, "report", "", DispatchError::ParentMissing));
                }
            }
        } else {
            return self.finish(rejected(id, "report", "", DispatchError::ParentMissing));
        };
        if self.resolve(&target).is_err() {
            return self.finish(rejected(id, "report", &target, DispatchError::ParentMissing));
        }
        let from_label = from.unwrap_or("session:unknown").to_string();
        let effective_body = if body.chars().count() > 2400 && body.chars().count() <= BODY_LIMIT {
            kite_ctx::ContextEngine::open_default()
                .ok()
                .and_then(|eng| {
                    eng.compress_runtime_segment(
                        body,
                        2400,
                        "runtime:subagent_handoff",
                        &from_label,
                        &from_label,
                        "dispatch",
                        "subagent",
                    )
                    .ok()
                })
                .unwrap_or_else(|| body.to_string())
        } else {
            body.to_string()
        };
        let receipt = self.send(SendInput {
            id: id.to_string(),
            address: target,
            body: effective_body,
            caller,
            force: false,
            allow_queue: true,
            only_ready: false,
            wrap: Some(true),
            from: from_label,
            mounted: false,
            source: from.map(|s| s.to_string()),
            label: None,
            now_ms,
            profile_id: None,
            system: true,
            presentation_emitted: false,
        });
        if receipt.status == ReceiptStatus::Submitted || receipt.status == ReceiptStatus::Queued {
            if let Ok(parent_key) = self.resolve(&receipt.address) {
                if let Some(ep) = self.endpoints.get_mut(&parent_key) {
                    ep.report_arrived = true;
                }
            }
        }
        receipt
    }

    pub fn run(&mut self, input: RunInput) -> Receipt {
        if let Some(existing) = self.receipts.get(&input.id) {
            return existing.clone();
        }
        if !self.online {
            return self.finish(rejected(&input.id, "run", "", DispatchError::RuntimeOffline));
        }
        if input.role_missing {
            return self.finish(rejected(&input.id, "run", "", DispatchError::RoleNotFound));
        }
        if input.via == Family::Thread {
            let requested_name = input
                .name
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty());
            let effective_name = if let Some(name) = requested_name {
                let normalized = if programs::is_codename(name) {
                    name.to_ascii_lowercase()
                } else {
                    name.to_string()
                };
                if !is_alias_name(&normalized) {
                    return self.finish(rejected(&input.id, "run", name, DispatchError::BadArgs));
                }
                if self.aliases.contains_key(&normalized) {
                    return self.finish(rejected(&input.id, "run", name, DispatchError::NameTaken));
                }
                Some(normalized)
            } else {
                None
            };
            if let Some(parent) = input.parent.as_deref() {
                if self.resolve(parent).is_err() {
                    if let Some(raw_thread_id) = parent
                        .strip_prefix("thread:")
                        .filter(|s| !s.is_empty())
                    {
                        let _ = self.attach(Family::Thread, raw_thread_id, None, None, false);
                    } else {
                        return self.finish(rejected(
                            &input.id,
                            "run",
                            parent,
                            DispatchError::ParentMissing,
                        ));
                    }
                }
            }
            let raw_opening = input.task.clone().unwrap_or_default();
            let opening = match input.role.as_ref() {
                Some(role) if !role.body.trim().is_empty() => {
                    if raw_opening.trim().is_empty() {
                        role.body.trim().to_string()
                    } else {
                        format!("{}\n\n{}", role.body.trim(), raw_opening.trim())
                    }
                }
                _ => raw_opening,
            };
            if opening.chars().count() > BODY_LIMIT {
                return self.finish(rejected(&input.id, "run", "", DispatchError::BodyTooLarge));
            }
            let provider = input
                .provider
                .clone()
                .or_else(|| input.engine.clone());
            let started = self.port.start_thread(&StartThreadRequest {
                parent: input.parent.clone(),
                provider: provider.clone(),
                model: input.model.clone(),
                effort: input.effort.clone(),
                role: input.subagent_role.clone(),
                workspace_mode: input.workspace.clone(),
                name: effective_name.clone(),
                task: opening.clone(),
                cwd: input.cwd.clone(),
                caller: input.caller,
                hidden: input.hidden,
            });
            let started = match started {
                Ok(started) => started,
                Err(err) => return self.finish(rejected(&input.id, "run", "", err)),
            };
            let session_id = started.session_id.clone();
            let pane = started.pane;
            let key = match self.attach(
                Family::Thread,
                &session_id,
                effective_name.as_deref(),
                input.parent.as_deref(),
                input.outlive,
            ) {
                Ok(key) => key,
                Err(err) => return self.finish(rejected(&input.id, "run", &session_id, err)),
            };
            if let Some(ep) = self.endpoints.get_mut(&key) {
                ep.engine = provider.clone();
            }
            let initial_presence = if opening.trim().is_empty() {
                PresenceState::Idle
            } else {
                PresenceState::Working
            };
            let _ = self.publish_pane(
                &key,
                initial_presence.as_str(),
                1,
                input.now_ms.max(1),
                None,
                None,
            );
            let thread_address = format!("thread:{session_id}");
            let mut receipt = Receipt::new(
                &input.id,
                "run",
                ReceiptStatus::Submitted,
                &thread_address,
                true,
                Some(initial_presence.as_str().into()),
                None,
            );
            receipt.pane = Some(pane);
            receipt.text = Some(format!(
                "started {thread_address}\n[subagent_id: {thread_address}]"
            ));
            record(&handoff_event(
                "thread",
                &opening,
                Fields {
                    op: "run",
                    session: &session_id,
                    engine: provider.as_deref().unwrap_or("inherit"),
                    status: receipt_status_label(receipt.status),
                    pane: pane_label(pane),
                    writes: 1,
                    launcher: "",
                    manual: crate::dispatch::trace::manual_label(false, &opening),
                },
            ));
            return self.finish(receipt);
        }
        let raw = !input.argv.is_empty();
        let requested_name = input
            .name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let auto_codename = !raw
            && input.role.is_none()
            && requested_name
                .map(|n| programs::canonical(n).is_some())
                .unwrap_or(true);
        let effective_name = if auto_codename {
            Some(self.next_codename())
        } else if let Some(name) = requested_name {
            let normalized = if programs::is_codename(name) {
                name.to_ascii_lowercase()
            } else {
                name.to_string()
            };
            if !is_alias_name(&normalized) {
                return self.finish(rejected(&input.id, "run", name, DispatchError::BadArgs));
            }
            if self.aliases.contains_key(&normalized) {
                return self.finish(rejected(&input.id, "run", name, DispatchError::NameTaken));
            }
            Some(normalized)
        } else {
            None
        };
        if let Some(parent) = input.parent.as_deref() {
            if self.resolve(parent).is_err() {
                return self.finish(rejected(
                    &input.id,
                    "run",
                    parent,
                    DispatchError::ParentMissing,
                ));
            }
        }
        let role_command = input
            .role
            .as_ref()
            .map(|role| role.command.trim())
            .filter(|cmd| !cmd.is_empty() && !cmd.eq_ignore_ascii_case("auto"))
            .map(str::to_string);
        let role_provider_engine = input
            .role
            .as_ref()
            .and_then(|role| role.provider.as_deref())
            .map(str::trim)
            .filter(|prov| !prov.is_empty())
            .map(|prov| programs::canonical(prov).unwrap_or(prov).to_string());
        if input.role.is_some()
            && input.engine.is_none()
            && input.command.is_none()
            && role_command.is_none()
            && role_provider_engine.is_none()
        {
            return self.finish(rejected(
                &input.id,
                "run",
                "",
                DispatchError::ProgramNotFound,
            ));
        }
        let engine = input
            .engine
            .clone()
            .or_else(|| role_command.clone())
            .or_else(|| role_provider_engine.clone())
            .or_else(|| input.command.clone())
            .unwrap_or_else(|| "powershell".into());
        let opening = if raw {
            String::new()
        } else {
            match input.role.as_ref() {
                Some(role) => {
                    let mut body = role.body.clone();
                    if let Some(task) = input.task.as_deref() {
                        if !body.is_empty() && !task.is_empty() {
                            body.push_str("\n\n");
                        }
                        body.push_str(task);
                    }
                    body
                }
                None => input.task.clone().unwrap_or_default(),
            }
        };
        if opening.chars().count() > BODY_LIMIT {
            return self.finish(rejected(&input.id, "run", "", DispatchError::BodyTooLarge));
        }
        let manual_as_system = !raw && programs::accepts_system_prompt(&engine);
        let prompt = if raw {
            None
        } else {
            birth_prompt(&opening, manual_as_system)
        };
        let request_command = input.command.clone().or_else(|| {
            if input.engine.is_some() {
                None
            } else {
                role_command
            }
        });
        let started = self.port.start_terminal(&StartRequest {
            engine: engine.clone(),
            command: request_command,
            name: effective_name.clone(),
            cwd: input.cwd.clone(),
            prompt: prompt.clone(),
            hidden: input.hidden,
            manual_as_system,
            argv: input.argv.clone(),
        });
        let started = match started {
            Ok(started) => started,
            Err(err) => return self.finish(rejected(&input.id, "run", "", err)),
        };
        let session_id = started.session_id.clone();
        let pane = started.pane;
        let key = match self.attach(
            Family::Terminal,
            &session_id,
            effective_name.as_deref(),
            input.parent.as_deref(),
            input.outlive,
        ) {
            Ok(key) => key,
            Err(err) => return self.finish(rejected(&input.id, "run", &session_id, err)),
        };
        if auto_codename {
            if let Some(engine_alias) = requested_name.filter(|n| is_alias_name(n)) {
                self.aliases
                    .entry(engine_alias.to_string())
                    .or_insert_with(|| key.clone());
            }
        }
        if let Some(ep) = self.endpoints.get_mut(&key) {
            ep.engine = Some(engine.clone());
        }
        let label = self.display_label(&key, &key);
        let mut receipt = Receipt::new(
            &input.id,
            "run",
            ReceiptStatus::Submitted,
            &label,
            true,
            Some(PresenceState::Unknown.as_str().into()),
            None,
        );
        receipt.pane = Some(pane);
        let handed = prompt.as_deref().unwrap_or("");
        record(&handoff_event(
            "argv",
            handed,
            Fields {
                op: "run",
                session: &session_id,
                engine: &engine,
                status: receipt_status_label(receipt.status),
                pane: pane_label(pane),
                writes: if prompt.is_some() { 1 } else { 0 },
                launcher: "",
                manual: crate::dispatch::trace::manual_label(manual_as_system, handed),
            },
        ));
        self.finish(receipt)
    }

    pub fn run_role(
        &mut self,
        id: &str,
        config_dir: &Path,
        name: &str,
        task: Option<String>,
        parent: Option<&str>,
        caller: Caller,
        now_ms: u64,
        alias: Option<String>,
        outlive: bool,
        hidden: bool,
        cwd: Option<String>,
    ) -> Receipt {
        let alias = alias.unwrap_or_else(|| name.to_string());
        match crate::dispatch::role::find_role_across_roots(
            Some(config_dir),
            cwd.as_deref().map(Path::new),
            name,
        ) {
            Ok(role) => {
                let role_provider = role
                    .provider
                    .clone()
                    .or_else(|| {
                        crate::chat::models::canonical_thread_provider_id(&role.command)
                            .map(str::to_string)
                    });
                let role_model = role.model.clone();
                let role_effort = role.effort.clone();
                let role_workspace = role.workspace.clone();
                self.run(RunInput {
                    id: id.to_string(),
                    via: Family::Terminal,
                    engine: None,
                    provider: role_provider,
                    model: role_model,
                    effort: role_effort,
                    workspace: role_workspace,
                    command: None,
                    name: Some(alias.clone()),
                    parent: parent.map(|s| s.to_string()),
                    outlive,
                    role: Some(role),
                    subagent_role: Some(name.to_string()),
                    role_missing: false,
                    task,
                    caller,
                    cwd: cwd.clone(),
                    now_ms,
                    hidden,
                    argv: Vec::new(),
                })
            }
            Err(_) => self.run(RunInput {
                id: id.to_string(),
                via: Family::Terminal,
                engine: None,
                provider: None,
                model: None,
                effort: None,
                workspace: None,
                command: None,
                name: Some(alias),
                parent: parent.map(|s| s.to_string()),
                outlive,
                role: None,
                subagent_role: None,
                role_missing: true,
                task: None,
                caller,
                cwd,
                now_ms,
                hidden,
                argv: Vec::new(),
            }),
        }
    }
}
