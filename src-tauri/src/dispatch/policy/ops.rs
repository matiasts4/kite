use std::path::Path;

use super::service::Service;
use super::types::*;
use crate::dispatch::address::is_alias_name;
use crate::dispatch::envelope::{last_lines, wrap_envelope};
use crate::dispatch::files::read_workspace_file;
use crate::dispatch::keys::encode_key;
use crate::dispatch::port::{Port, StartRequest, SubmitMeta};
use crate::dispatch::presence::{choose_effective, is_ready, BlockKind, Presence, PresenceState};
use crate::dispatch::programs;
use crate::dispatch::role::load_role;
use crate::dispatch::trace::{handoff_event, record, Fields};
use crate::dispatch::types::{
    Caller, DispatchError, Family, Receipt, ReceiptStatus, BODY_LIMIT, DEFAULT_READ_LINES,
    QUEUE_DEPTH, STALL_MS,
};

impl<P: Port> Service<P> {
    pub fn send(&mut self, input: SendInput) -> Receipt {
        if let Some(existing) = self.receipts.get(&input.id) {
            let mut replay = existing.clone();
            replay.replayed = true;
            return replay;
        }
        let op = "send";
        if !self.online {
            return self.finish(rejected(&input.id, op, &input.address, DispatchError::RuntimeOffline));
        }
        if input.id.is_empty() {
            return self.finish(rejected(&input.id, op, &input.address, DispatchError::BadArgs));
        }
        if !input.system && self.messaging_blocks(input.caller, input.profile_id.as_deref(), &input.address)
        {
            return self.finish(rejected(
                &input.id,
                op,
                &input.address,
                DispatchError::MessagingDisabled,
            ));
        }
        let key = match self.resolve(&input.address) {
            Ok(key) => key,
            Err(err) => return self.finish(rejected(&input.id, op, &input.address, err)),
        };
        let label = self.display_label(&key, &input.address);
        let wrap = input.wrap.unwrap_or(matches!(input.caller, Caller::Agent | Caller::Script));
        let from = if input.from.is_empty() {
            label.clone()
        } else {
            input.from.clone()
        };
        let text = if wrap {
            wrap_envelope(&from, &input.body)
        } else {
            input.body.clone()
        };
        if text.chars().count() > BODY_LIMIT {
            return self.finish(rejected(&input.id, op, &label, DispatchError::BodyTooLarge));
        }
        if input.force && input.caller != Caller::Human {
            return self.finish(rejected(&input.id, op, &label, DispatchError::ForceForbidden));
        }
        let snap = self.effective(&key);
        if snap.state == PresenceState::Gone {
            return self.finish(rejected(&input.id, op, &label, DispatchError::DestinationGone));
        }
        let permission = snap.state == PresenceState::Blocked && snap.kind == Some(BlockKind::Permission);
        if permission || (snap.state == PresenceState::Blocked && !input.force) {
            return self.finish(rejected(
                &input.id,
                op,
                &label,
                DispatchError::DestinationBlocked,
            ));
        }
        let human_force = input.force && input.caller == Caller::Human;
        if input.only_ready && !is_ready(snap.state) && !human_force {
            return self.finish(rejected(&input.id, op, &label, DispatchError::NotReady));
        }
        let busy = self
            .endpoints
            .get(&key)
            .and_then(|ep| ep.in_flight.clone())
            .is_some();
        let ready_now = is_ready(snap.state) || human_force;
        if busy || !ready_now {
            if !input.allow_queue {
                return self.finish(rejected(&input.id, op, &label, DispatchError::NotReady));
            }
            let depth = self.endpoints.get(&key).map(|ep| ep.queue.len()).unwrap_or(0);
            if depth >= QUEUE_DEPTH {
                return self.finish(rejected(&input.id, op, &label, DispatchError::QueueFull));
            }
            if let Some(ep) = self.endpoints.get_mut(&key) {
                if ep.queue.is_empty() {
                    ep.queued_generation = ep.generation;
                }
                ep.queue.push_back(Queued {
                    id: input.id.clone(),
                    op: op.into(),
                    address_label: label.clone(),
                    text,
                    mounted: input.mounted,
                    source: input.source.clone(),
                    label: input.label.clone(),
                    presentation_emitted: input.presentation_emitted,
                });
            }
            return self.finish(Receipt::new(
                &input.id,
                op,
                ReceiptStatus::Queued,
                &label,
                false,
                Some(snap.state.as_str().into()),
                None,
            ));
        }
        self.submit_now(
            &input.id,
            op,
            &key,
            &label,
            text,
            SubmitMeta {
                mounted: input.mounted,
                source: input.source,
                label: input.label,
                presentation_emitted: input.presentation_emitted,
            },
            &snap,
            input.now_ms,
        )
    }

    pub fn wait(&mut self, input: WaitInput) -> Receipt {
        if let Some(existing) = self.receipts.get(&input.id) {
            if existing.op == "wait" {
                return existing.clone();
            }
        }
        if !self.online {
            return self.finish(rejected(
                &input.id,
                "wait",
                input.address.as_deref().unwrap_or(""),
                DispatchError::RuntimeOffline,
            ));
        }
        let until = if input.until.is_empty() {
            vec![
                PresenceState::Idle,
                PresenceState::Done,
                PresenceState::Blocked,
            ]
        } else {
            input.until.clone()
        };
        let address = input.address.clone().unwrap_or_default();
        let resolved = match self.evaluate_wait(&address, &until, input.children) {
            Ok(value) => value,
            Err(err) => {
                return self.finish(rejected(&input.id, "wait", &address, err));
            }
        };
        if resolved {
            return self.finish(Receipt::new(
                &input.id,
                "wait",
                ReceiptStatus::Settled,
                &address,
                false,
                None,
                None,
            ));
        }
        if input.now_ms >= input.started_ms.saturating_add(input.timeout_ms) {
            return self.finish(Receipt::new(
                &input.id,
                "wait",
                ReceiptStatus::Failed,
                &address,
                false,
                None,
                Some(DispatchError::Timeout.code().into()),
            ));
        }
        Receipt::new(
            &input.id,
            "wait",
            ReceiptStatus::Queued,
            &address,
            false,
            None,
            None,
        )
    }

    pub fn settle(&mut self, id: &str, now_ms: u64) -> Option<Receipt> {
        let meta = self.inflight.get(id)?;
        let changed = meta.changed;
        let at_ms = meta.at_ms;
        let key = meta.key.clone();
        let current = self.receipts.get(id)?.clone();
        if !current.submitted {
            return Some(current);
        }
        if changed {
            let receipt = Receipt::new(
                id,
                &current.op,
                ReceiptStatus::Settled,
                &current.address,
                true,
                current.presence_at_submit.clone(),
                None,
            );
            self.receipts.insert(id.to_string(), receipt.clone());
            self.inflight.remove(id);
            self.clear_flight(&key, id);
            return Some(receipt);
        }
        if now_ms >= at_ms.saturating_add(STALL_MS) {
            let receipt = Receipt::new(
                id,
                &current.op,
                ReceiptStatus::Stalled,
                &current.address,
                true,
                current.presence_at_submit.clone(),
                Some(DispatchError::Stalled.code().into()),
            );
            self.receipts.insert(id.to_string(), receipt.clone());
            self.inflight.remove(id);
            self.clear_flight(&key, id);
            return Some(receipt);
        }
        Some(current)
    }

    pub fn read(&mut self, id: &str, address: &str, lines: usize) -> Receipt {
        if let Some(existing) = self.receipts.get(id) {
            return existing.clone();
        }
        let lines = if lines == 0 { DEFAULT_READ_LINES } else { lines };
        let key = match self.resolve(address) {
            Ok(key) => key,
            Err(err) => return self.finish(rejected(id, "read", address, err)),
        };
        let (family, raw, stored, before) = {
            let ep = match self.endpoints.get(&key) {
                Some(ep) => ep,
                None => {
                    return self.finish(rejected(id, "read", address, DispatchError::UnknownAddress))
                }
            };
            (
                ep.family,
                ep.id.clone(),
                ep.tail.clone(),
                self.effective(&key).state,
            )
        };
        let loaded = self.port.read(family, &raw, lines).unwrap_or_default();
        let source = if !loaded.is_empty() { loaded } else { stored };
        let text = last_lines(&source, lines);
        if let Some(ep) = self.endpoints.get_mut(&key) {
            if ep.tail.is_empty() {
                ep.tail = text.clone();
            }
        }
        let after = self.effective(&key).state;
        debug_assert_eq!(before, after);
        let mut receipt = Receipt::new(id, "read", ReceiptStatus::Settled, address, false, None, None);
        receipt.text = Some(text);
        self.finish(receipt)
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
        let receipt = self.send(SendInput {
            id: id.to_string(),
            address: target,
            body: body.to_string(),
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
            return self.finish(rejected(
                &input.id,
                "run",
                "",
                DispatchError::TransportUnsupported,
            ));
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
        let engine = input
            .role
            .as_ref()
            .map(|role| role.command.clone())
            .or(input.engine.clone())
            .or(input.command.clone())
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
        let started = self.port.start_terminal(&StartRequest {
            engine: engine.clone(),
            command: input.command.clone().or(input.role.as_ref().map(|r| r.command.clone())),
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
        match load_role(config_dir, name) {
            Ok(role) => self.run(RunInput {
                id: id.to_string(),
                via: Family::Terminal,
                engine: None,
                command: None,
                name: Some(alias.clone()),
                parent: parent.map(|s| s.to_string()),
                outlive,
                role: Some(role),
                role_missing: false,
                task,
                caller,
                cwd: cwd.clone(),
                now_ms,
                hidden,
                argv: Vec::new(),
            }),
            Err(_) => self.run(RunInput {
                id: id.to_string(),
                via: Family::Terminal,
                engine: None,
                command: None,
                name: Some(alias),
                parent: parent.map(|s| s.to_string()),
                outlive,
                role: None,
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

    pub fn send_file(
        &mut self,
        input: SendInput,
        workspace: &Path,
        rel: &str,
    ) -> Receipt {
        if let Some(existing) = self.receipts.get(&input.id) {
            return existing.clone();
        }
        match read_workspace_file(workspace, rel) {
            Ok(body) => {
                let mut next = input;
                next.body = body;
                self.send(next)
            }
            Err(err) => self.finish(rejected(&input.id, "send", &input.address, err)),
        }
    }

    /// Writes Ctrl+C. Does not press Enter and does not use the send gate.
    pub fn interrupt(&mut self, id: &str, address: &str) -> Receipt {
        self.write_control(id, "interrupt", address, "\u{3}")
    }

    /// Writes the named keys. Enter is written only when a key is `enter`.
    pub fn keys(&mut self, id: &str, address: &str, names: &[String]) -> Receipt {
        if let Some(existing) = self.receipts.get(id) {
            return existing.clone();
        }
        if names.is_empty() {
            return self.finish(rejected(id, "keys", address, DispatchError::BadArgs));
        }
        let mut bytes = String::new();
        for name in names {
            match encode_key(name) {
                Some(part) => bytes.push_str(&part),
                None => return self.finish(rejected(id, "keys", address, DispatchError::BadArgs)),
            }
        }
        self.write_control(id, "keys", address, &bytes)
    }

    /// Asks the desktop to show a session that already exists.
    pub fn show(&mut self, id: &str, address: &str) -> Receipt {
        if let Some(existing) = self.receipts.get(id) {
            return existing.clone();
        }
        if !self.online {
            return self.finish(rejected(id, "attach", address, DispatchError::RuntimeOffline));
        }
        let key = match self.resolve(address) {
            Ok(key) => key,
            Err(err) => return self.finish(rejected(id, "attach", address, err)),
        };
        let (session, engine, name) = {
            let ep = match self.endpoints.get(&key) {
                Some(ep) => ep,
                None => {
                    return self.finish(rejected(id, "attach", address, DispatchError::UnknownAddress))
                }
            };
            if ep.family != Family::Terminal {
                return self.finish(rejected(
                    id,
                    "attach",
                    address,
                    DispatchError::TransportUnsupported,
                ));
            }
            (
                ep.id.clone(),
                ep.engine.clone().unwrap_or_default(),
                ep.alias.clone(),
            )
        };
        match self.port.reveal(&session, &engine, name.as_deref()) {
            Ok(()) => self.finish(Receipt::new(
                id,
                "attach",
                ReceiptStatus::Settled,
                address,
                false,
                None,
                None,
            )),
            Err(err) => self.finish(rejected(id, "attach", address, err)),
        }
    }

    pub(crate) fn write_control(&mut self, id: &str, op: &str, address: &str, bytes: &str) -> Receipt {
        if let Some(existing) = self.receipts.get(id) {
            return existing.clone();
        }
        if !self.online {
            return self.finish(rejected(id, op, address, DispatchError::RuntimeOffline));
        }
        let key = match self.resolve(address) {
            Ok(key) => key,
            Err(err) => return self.finish(rejected(id, op, address, err)),
        };
        let (family, session) = {
            let ep = match self.endpoints.get(&key) {
                Some(ep) => ep,
                None => return self.finish(rejected(id, op, address, DispatchError::UnknownAddress)),
            };
            (ep.family, ep.id.clone())
        };
        match self.port.type_bytes(family, &session, bytes) {
            Ok(()) => self.finish(Receipt::new(
                id,
                op,
                ReceiptStatus::Submitted,
                address,
                true,
                None,
                None,
            )),
            Err(err) => self.finish(rejected(id, op, address, err)),
        }
    }

    pub(crate) fn after_presence(&mut self, key: &str, now_ms: u64) {
        let flight = self.endpoints.get(key).and_then(|ep| ep.in_flight.clone());
        if let Some(id) = flight {
            if let Some(meta) = self.inflight.get_mut(&id) {
                meta.changed = true;
            }
            if let Some(ep) = self.endpoints.get_mut(key) {
                ep.in_flight = None;
            }
        }
        self.maybe_flush(key, now_ms);
    }

    pub(crate) fn maybe_flush(&mut self, key: &str, now_ms: u64) {
        let Some(ep) = self.endpoints.get(key) else {
            return;
        };
        if ep.in_flight.is_some() || ep.queue.is_empty() {
            return;
        }
        if !is_ready(choose_effective(ep.reported.as_ref(), ep.observed.as_ref()).state) {
            return;
        }
        if ep.generation <= ep.queued_generation {
            return;
        }
        let item = match self.endpoints.get_mut(key).and_then(|ep| ep.queue.pop_front()) {
            Some(item) => item,
            None => return,
        };
        if let Some(ep) = self.endpoints.get_mut(key) {
            ep.queued_generation = ep.generation;
        }
        let snap = self.effective(key);
        let _ = self.submit_now(
            &item.id,
            &item.op,
            key,
            &item.address_label,
            item.text,
            SubmitMeta {
                mounted: item.mounted,
                source: item.source,
                label: item.label,
                presentation_emitted: item.presentation_emitted,
            },
            &snap,
            now_ms,
        );
    }

    pub(crate) fn submit_now(
        &mut self,
        id: &str,
        op: &str,
        key: &str,
        label: &str,
        text: String,
        meta: SubmitMeta,
        snap: &Presence,
        now_ms: u64,
    ) -> Receipt {
        let (family, raw) = match self.endpoints.get(key) {
            Some(ep) => (ep.family, ep.id.clone()),
            None => {
                return self.finish(rejected(id, op, label, DispatchError::UnknownAddress));
            }
        };
        match self.port.submit(family, &raw, &text, &meta) {
            Ok(()) => {
                if let Some(ep) = self.endpoints.get_mut(key) {
                    ep.in_flight = Some(id.to_string());
                }
                self.inflight.insert(
                    id.to_string(),
                    InflightMeta {
                        at_ms: now_ms,
                        changed: false,
                        key: key.to_string(),
                    },
                );
                let receipt = Receipt::new(
                    id,
                    op,
                    ReceiptStatus::Submitted,
                    label,
                    true,
                    Some(snap.state.as_str().into()),
                    None,
                );
                let engine = self
                    .endpoints
                    .get(key)
                    .and_then(|ep| ep.engine.clone())
                    .unwrap_or_default();
                let channel = match family {
                    Family::Terminal => "pty",
                    Family::Thread => "thread",
                };
                let traced = match family {
                    Family::Terminal => format_terminal_paste(&text),
                    Family::Thread => text.clone(),
                };
                record(&handoff_event(
                    channel,
                    &traced,
                    Fields {
                        op: "submit",
                        session: &raw,
                        engine: &engine,
                        status: "",
                        pane: "",
                        writes: 1,
                        launcher: "",
                        manual: "none",
                    },
                ));
                self.finish(receipt)
            }
            Err(err) => self.finish(rejected(id, op, label, err)),
        }
    }

    pub(crate) fn evaluate_wait(
        &self,
        address: &str,
        until: &[PresenceState],
        children: Option<ChildrenMode>,
    ) -> Result<bool, DispatchError> {
        if children.is_none() && address.is_empty() {
            return Err(DispatchError::BadArgs);
        }
        let key = if address.is_empty() {
            None
        } else {
            Some(self.resolve(address)?)
        };
        match children {
            None => {
                let key = key.ok_or(DispatchError::BadArgs)?;
                Ok(until.contains(&self.effective(&key).state))
            }
            Some(ChildrenMode::All) => {
                let parent = key.ok_or(DispatchError::UnknownAddress)?;
                let kids: Vec<&Endpoint> = self
                    .endpoints
                    .values()
                    .filter(|ep| ep.live && ep.parent.as_deref() == Some(parent.as_str()))
                    .collect();
                Ok(kids.iter().all(|ep| {
                    let state = choose_effective(ep.reported.as_ref(), ep.observed.as_ref()).state;
                    let counted = if ep.reported.is_none() && ep.observed.is_none() {
                        PresenceState::Working
                    } else {
                        state
                    };
                    !matches!(counted, PresenceState::Working | PresenceState::Unknown)
                }))
            }
            Some(ChildrenMode::Any) => {
                let parent = key.ok_or(DispatchError::UnknownAddress)?;
                let parent_ep = self.endpoints.get(&parent).ok_or(DispatchError::UnknownAddress)?;
                if parent_ep.report_arrived || parent_ep.any_signal {
                    return Ok(true);
                }
                Ok(self.endpoints.values().any(|ep| {
                    ep.live
                        && ep.parent.as_deref() == Some(parent.as_str())
                        && matches!(
                            choose_effective(ep.reported.as_ref(), ep.observed.as_ref()).state,
                            PresenceState::Blocked
                                | PresenceState::Done
                                | PresenceState::Error
                                | PresenceState::Gone
                        )
                }))
            }
        }
    }
}
