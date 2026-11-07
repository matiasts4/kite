//! Dispatch policy. This module does not import a terminal, a chat runtime, or a projectile.

use std::collections::{HashMap, VecDeque};
use std::path::Path;

use super::address::{canonical, is_alias_name, parse_address, AddrRef};
use super::envelope::{last_lines, wrap_envelope};
use super::files::read_workspace_file;
use super::keys::encode_key;
use super::osc::{parse_osc_7501, OscReport};
use super::port::{Port, StartRequest, SubmitMeta};
use super::programs::accepts_system_prompt;
use super::presence::{
    choose_effective, is_ready, map_pane_state, Authority, BlockKind, Presence, PresenceState,
};
use super::role::{load_role, RoleFile};
use super::trace::{handoff_event, record, Fields};
use super::types::{
    exit_code, Caller, DispatchError, Family, PaneVisibility, Receipt, ReceiptStatus, BODY_LIMIT,
    DEFAULT_READ_LINES, NOTICE_TAIL_LINES, QUEUE_DEPTH, STALL_MS,
};

#[derive(Clone)]
struct Queued {
    id: String,
    op: String,
    address_label: String,
    text: String,
    mounted: bool,
    source: Option<String>,
    label: Option<String>,
    presentation_emitted: bool,
}

struct InflightMeta {
    at_ms: u64,
    changed: bool,
    key: String,
}

struct Endpoint {
    family: Family,
    id: String,
    alias: Option<String>,
    engine: Option<String>,
    parent: Option<String>,
    outlive: bool,
    observed: Option<Presence>,
    reported: Option<Presence>,
    queue: VecDeque<Queued>,
    in_flight: Option<String>,
    generation: u64,
    queued_generation: u64,
    saw_working: bool,
    sent_report_since_working: bool,
    exit_fact: Option<String>,
    tail: String,
    /// Last state that already produced a parent notice. Cleared on entry to working.
    last_noticed: Option<PresenceState>,
    live: bool,
    any_signal: bool,
    report_arrived: bool,
}

pub struct SendInput {
    pub id: String,
    pub address: String,
    pub body: String,
    pub caller: Caller,
    pub force: bool,
    pub allow_queue: bool,
    pub only_ready: bool,
    pub wrap: Option<bool>,
    pub from: String,
    pub mounted: bool,
    pub source: Option<String>,
    pub label: Option<String>,
    pub now_ms: u64,
    pub profile_id: Option<String>,
    pub system: bool,
    /// The desktop already showed the flight. A later flush must not show a second one.
    pub presentation_emitted: bool,
}

pub struct RunInput {
    pub id: String,
    pub via: Family,
    pub engine: Option<String>,
    pub command: Option<String>,
    pub name: Option<String>,
    pub parent: Option<String>,
    pub outlive: bool,
    pub role: Option<RoleFile>,
    pub role_missing: bool,
    pub task: Option<String>,
    pub caller: Caller,
    pub cwd: Option<String>,
    pub now_ms: u64,
    pub hidden: bool,
    /// Non-empty means the process argv. The task is not also a birth prompt.
    pub argv: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChildrenMode {
    All,
    Any,
}

pub struct WaitInput {
    pub id: String,
    pub address: Option<String>,
    pub until: Vec<PresenceState>,
    pub children: Option<ChildrenMode>,
    pub timeout_ms: u64,
    pub started_ms: u64,
    pub now_ms: u64,
}

pub struct Service<P: Port> {
    endpoints: HashMap<String, Endpoint>,
    aliases: HashMap<String, String>,
    agents: HashMap<String, String>,
    receipts: HashMap<String, Receipt>,
    inflight: HashMap<String, InflightMeta>,
    messaging_enabled: bool,
    read_only: bool,
    profile_messaging: HashMap<String, bool>,
    online: bool,
    port: P,
}

impl<P: Port> Service<P> {
    pub fn new(port: P) -> Self {
        Self {
            endpoints: HashMap::new(),
            aliases: HashMap::new(),
            agents: HashMap::new(),
            receipts: HashMap::new(),
            inflight: HashMap::new(),
            messaging_enabled: true,
            read_only: false,
            profile_messaging: HashMap::new(),
            online: true,
            port,
        }
    }

    pub fn port_mut(&mut self) -> &mut P {
        &mut self.port
    }

    pub fn set_online(&mut self, online: bool) {
        self.online = online;
    }

    pub fn set_messaging(&mut self, enabled: bool, read_only: bool) {
        self.messaging_enabled = enabled;
        self.read_only = read_only;
    }

    pub fn set_profile_messaging(&mut self, profile_id: &str, allow: bool) {
        self.profile_messaging.insert(profile_id.to_string(), allow);
    }

    pub fn receipt(&self, id: &str) -> Option<&Receipt> {
        self.receipts.get(id)
    }

    pub fn attach(
        &mut self,
        family: Family,
        id: &str,
        alias: Option<&str>,
        parent: Option<&str>,
        outlive: bool,
    ) -> Result<String, DispatchError> {
        let key = canonical(family == Family::Terminal, id);
        if self.endpoints.contains_key(&key) {
            return Ok(key);
        }
        let parent_key = self.resolve_parent(parent)?;
        let alias = self.claim_alias(alias, &key)?;
        self.endpoints.insert(
            key.clone(),
            Endpoint::new(family, id, alias, parent_key, outlive),
        );
        Ok(key)
    }

    pub fn bind_agent(&mut self, profile_id: &str, thread_id: &str) -> Result<(), DispatchError> {
        let key = canonical(false, thread_id);
        if !self.endpoints.get(&key).map(|e| e.live).unwrap_or(false) {
            return Err(DispatchError::NoLiveEndpoint);
        }
        self.agents.insert(profile_id.to_string(), key);
        Ok(())
    }

    pub fn publish_pane(
        &mut self,
        address: &str,
        pane_state: &str,
        seq: u64,
        now_ms: u64,
        tail: Option<&str>,
        exit_fact: Option<&str>,
    ) -> Result<(), DispatchError> {
        let kind = if map_pane_state(pane_state) == PresenceState::Blocked {
            Some(BlockKind::Question)
        } else {
            None
        };
        self.publish(
            address,
            Authority::Observed,
            map_pane_state(pane_state),
            kind,
            None,
            seq,
            now_ms,
            tail,
            exit_fact,
        )
    }

    pub fn publish_reported(
        &mut self,
        address: &str,
        state: PresenceState,
        kind: Option<BlockKind>,
        seq: u64,
        now_ms: u64,
    ) -> Result<(), DispatchError> {
        self.publish(
            address,
            Authority::Reported,
            state,
            kind,
            None,
            seq,
            now_ms,
            None,
            None,
        )
    }

    pub fn publish_osc(&mut self, address: &str, raw: &str, now_ms: u64) -> Result<bool, DispatchError> {
        let Some(report) = parse_osc_7501(raw) else {
            return Ok(false);
        };
        let key = self.resolve(address)?;
        match report {
            OscReport::Clear { seq } => {
                let stale = {
                    let ep = self
                        .endpoints
                        .get_mut(&key)
                        .ok_or(DispatchError::UnknownAddress)?;
                    if let Some(prev) = &ep.reported {
                        if seq < prev.seq {
                            true
                        } else {
                            ep.reported = None;
                            false
                        }
                    } else {
                        ep.reported = None;
                        false
                    }
                };
                if stale {
                    return Ok(false);
                }
                self.after_presence(&key, now_ms);
                Ok(true)
            }
            OscReport::State(mut presence) => {
                presence.at_ms = now_ms;
                let ep = self.endpoints.get(&key).ok_or(DispatchError::UnknownAddress)?;
                if let Some(prev) = &ep.reported {
                    if presence.seq <= prev.seq {
                        return Ok(false);
                    }
                }
                self.publish(
                    address,
                    Authority::Reported,
                    presence.state,
                    presence.kind,
                    presence.message,
                    presence.seq,
                    now_ms,
                    None,
                    None,
                )?;
                Ok(true)
            }
        }
    }

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
        if let Some(name) = input.name.as_deref() {
            if !is_alias_name(name) {
                return self.finish(rejected(&input.id, "run", name, DispatchError::BadArgs));
            }
            if self.aliases.contains_key(name) {
                return self.finish(rejected(&input.id, "run", name, DispatchError::NameTaken));
            }
        }
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
        let raw = !input.argv.is_empty();
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
        let manual_as_system = !raw && accepts_system_prompt(&engine);
        let prompt = if raw {
            None
        } else {
            birth_prompt(&opening, manual_as_system)
        };
        let started = self.port.start_terminal(&StartRequest {
            engine: engine.clone(),
            command: input.command.clone().or(input.role.as_ref().map(|r| r.command.clone())),
            name: input.name.clone(),
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
            input.name.as_deref(),
            input.parent.as_deref(),
            input.outlive,
        ) {
            Ok(key) => key,
            Err(err) => return self.finish(rejected(&input.id, "run", &session_id, err)),
        };
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
                manual: super::trace::manual_label(manual_as_system, handed),
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

    pub fn stop(&mut self, address: &str) -> Result<(), DispatchError> {
        let key = self.resolve(address)?;
        self.stop_key(&key)
    }

    /// Ends the session. An unseen `session:` id is still stopped.
    pub fn kill(&mut self, id: &str, address: &str) -> Receipt {
        if let Some(existing) = self.receipts.get(id) {
            return existing.clone();
        }
        if !self.online {
            return self.finish(rejected(id, "kill", address, DispatchError::RuntimeOffline));
        }
        match self.resolve(address) {
            Ok(key) => match self.stop_key(&key) {
                Ok(()) => self.finish(Receipt::new(
                    id,
                    "kill",
                    ReceiptStatus::Settled,
                    address,
                    false,
                    Some(PresenceState::Gone.as_str().into()),
                    None,
                )),
                Err(err) => self.finish(rejected(id, "kill", address, err)),
            },
            Err(err) => {
                if let Some(session) = address.strip_prefix("session:") {
                    if session.is_empty() {
                        return self.finish(rejected(id, "kill", address, DispatchError::BadArgs));
                    }
                    return match self.port.stop(Family::Terminal, session) {
                        Ok(()) => self.finish(Receipt::new(
                            id,
                            "kill",
                            ReceiptStatus::Settled,
                            address,
                            false,
                            Some(PresenceState::Gone.as_str().into()),
                            None,
                        )),
                        Err(stop_err) => self.finish(rejected(id, "kill", address, stop_err)),
                    };
                }
                self.finish(rejected(id, "kill", address, err))
            }
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

    fn write_control(&mut self, id: &str, op: &str, address: &str, bytes: &str) -> Receipt {
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

    pub fn ls(&self) -> Vec<String> {
        let mut rows: Vec<String> = self
            .endpoints
            .iter()
            .filter(|(_, ep)| ep.live)
            .map(|(key, ep)| {
                let state = choose_effective(ep.reported.as_ref(), ep.observed.as_ref());
                match (&ep.alias, &ep.engine) {
                    (Some(alias), Some(engine)) => {
                        format!("{key} alias:{alias} {engine} {}", state.state.as_str())
                    }
                    (Some(alias), None) => format!("{key} alias:{alias} {}", state.state.as_str()),
                    (None, Some(engine)) => format!("{key} {engine} {}", state.state.as_str()),
                    (None, None) => format!("{key} {}", state.state.as_str()),
                }
            })
            .collect();
        rows.sort();
        rows
    }

    pub fn exit_of(&self, id: &str) -> i32 {
        self.receipts.get(id).map(exit_code).unwrap_or(1)
    }

    fn publish(
        &mut self,
        address: &str,
        authority: Authority,
        state: PresenceState,
        kind: Option<BlockKind>,
        message: Option<String>,
        seq: u64,
        now_ms: u64,
        tail: Option<&str>,
        exit_fact: Option<&str>,
    ) -> Result<(), DispatchError> {
        let key = self.resolve(address)?;
        let before = self.effective(&key);
        {
            let ep = self.endpoints.get_mut(&key).ok_or(DispatchError::UnknownAddress)?;
            if authority == Authority::Reported {
                if let Some(prev) = &ep.reported {
                    if seq <= prev.seq {
                        return Ok(());
                    }
                }
            }
            let record = Presence {
                state,
                kind,
                message,
                app: None,
                seq,
                authority,
                at_ms: now_ms,
            };
            match authority {
                Authority::Reported => ep.reported = Some(record),
                Authority::Observed => ep.observed = Some(record),
            }
            if let Some(tail) = tail {
                ep.tail = tail.to_string();
            }
            if let Some(fact) = exit_fact {
                ep.exit_fact = Some(fact.to_string());
            }
        }
        let after = self.effective(&key);
        if after.state != before.state || after.seq != before.seq || after.kind != before.kind {
            self.note_transition(&key, before.state, after.state);
            self.after_presence(&key, now_ms);
            self.maybe_notice(&key, after.state, now_ms);
        }
        Ok(())
    }

    fn note_transition(&mut self, key: &str, before: PresenceState, after: PresenceState) {
        let parent = self.endpoints.get(key).and_then(|ep| ep.parent.clone());
        if let Some(ep) = self.endpoints.get_mut(key) {
            ep.generation = ep.generation.wrapping_add(1);
            if after == PresenceState::Working && before != PresenceState::Working {
                ep.saw_working = true;
                ep.sent_report_since_working = false;
                ep.last_noticed = None;
            }
            if matches!(
                after,
                PresenceState::Blocked | PresenceState::Done | PresenceState::Error | PresenceState::Gone
            ) && after != before
            {
                ep.any_signal = true;
            }
        }
        if let Some(parent) = parent {
            if matches!(
                after,
                PresenceState::Blocked | PresenceState::Done | PresenceState::Error | PresenceState::Gone
            ) && after != before
            {
                if let Some(ep) = self.endpoints.get_mut(&parent) {
                    ep.any_signal = true;
                }
            }
            if matches!(after, PresenceState::Gone | PresenceState::Error) && after != before {
                // Parent lifetime is handled when the parent itself stops.
            }
        }
        if matches!(after, PresenceState::Gone) && after != before {
            let children: Vec<String> = self
                .endpoints
                .iter()
                .filter(|(_, ep)| ep.parent.as_deref() == Some(key) && ep.live && !ep.outlive)
                .map(|(k, _)| k.clone())
                .collect();
            for child in children {
                let _ = self.stop_key(&child);
            }
        }
    }

    fn maybe_notice(&mut self, key: &str, state: PresenceState, now_ms: u64) {
        if !matches!(
            state,
            PresenceState::Blocked | PresenceState::Done | PresenceState::Error | PresenceState::Gone
        ) {
            return;
        }
        let planned = {
            let ep = match self.endpoints.get_mut(key) {
                Some(ep) => ep,
                None => return,
            };
            if ep.last_noticed == Some(state) || ep.sent_report_since_working {
                return;
            }
            let Some(parent) = ep.parent.clone() else {
                return;
            };
            ep.last_noticed = Some(state);
            let from = ep
                .alias
                .clone()
                .map(|alias| format!("alias:{alias}"))
                .unwrap_or_else(|| key.to_string());
            let tail = last_lines(&ep.tail, NOTICE_TAIL_LINES);
            let fact = ep.exit_fact.clone().unwrap_or_else(|| "unknown".into());
            let body = format!("state: {}\nexit: {}\n{}", state.as_str(), fact, tail);
            (parent, from, body)
        };
        let (parent, from, body) = planned;
        let _ = self.send(SendInput {
            id: format!("notice:{key}:{}:{now_ms}", state.as_str()),
            address: parent,
            body,
            caller: Caller::Agent,
            force: false,
            allow_queue: true,
            only_ready: false,
            wrap: Some(true),
            from,
            mounted: false,
            source: Some(key.to_string()),
            label: None,
            now_ms,
            profile_id: None,
            system: true,
            presentation_emitted: false,
        });
    }

    fn after_presence(&mut self, key: &str, now_ms: u64) {
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

    fn maybe_flush(&mut self, key: &str, now_ms: u64) {
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

    fn submit_now(
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
                record(&handoff_event(
                    channel,
                    &text,
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

    fn evaluate_wait(
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

    fn stop_key(&mut self, key: &str) -> Result<(), DispatchError> {
        let children: Vec<String> = self
            .endpoints
            .iter()
            .filter(|(_, ep)| ep.parent.as_deref() == Some(key) && ep.live && !ep.outlive)
            .map(|(k, _)| k.clone())
            .collect();
        for child in children {
            self.stop_key(&child)?;
        }
        let (family, id, alias) = {
            let ep = self.endpoints.get_mut(key).ok_or(DispatchError::UnknownAddress)?;
            if !ep.live {
                return Ok(());
            }
            ep.live = false;
            let seq = ep
                .reported
                .as_ref()
                .map(|presence| presence.seq.saturating_add(1))
                .unwrap_or(1);
            let gone = |authority| Presence {
                state: PresenceState::Gone,
                kind: None,
                message: None,
                app: None,
                seq,
                authority,
                at_ms: 0,
            };
            ep.reported = Some(gone(Authority::Reported));
            ep.observed = Some(gone(Authority::Observed));
            (ep.family, ep.id.clone(), ep.alias.clone())
        };
        if let Some(alias) = alias {
            self.aliases.remove(&alias);
        }
        self.agents.retain(|_, target| target != key);
        self.port.stop(family, &id)?;
        Ok(())
    }

    fn resolve(&self, raw: &str) -> Result<String, DispatchError> {
        match parse_address(raw)? {
            AddrRef::Session(id) => {
                let key = canonical(true, &id);
                self.live_key(&key)
            }
            AddrRef::Thread(id) => {
                let key = canonical(false, &id);
                self.live_key(&key)
            }
            AddrRef::Agent(profile) => self
                .agents
                .get(&profile)
                .cloned()
                .ok_or(DispatchError::NoLiveEndpoint)
                .and_then(|key| self.live_key(&key)),
            AddrRef::Alias(name) => self
                .aliases
                .get(&name)
                .cloned()
                .ok_or(DispatchError::UnknownAddress)
                .and_then(|key| self.live_key(&key)),
        }
    }

    fn live_key(&self, key: &str) -> Result<String, DispatchError> {
        if self.endpoints.get(key).map(|ep| ep.live).unwrap_or(false) {
            Ok(key.to_string())
        } else {
            Err(DispatchError::UnknownAddress)
        }
    }

    fn resolve_parent(&self, parent: Option<&str>) -> Result<Option<String>, DispatchError> {
        match parent {
            None => Ok(None),
            Some(raw) => self.resolve(raw).map(Some).map_err(|_| DispatchError::ParentMissing),
        }
    }

    fn claim_alias(
        &mut self,
        alias: Option<&str>,
        key: &str,
    ) -> Result<Option<String>, DispatchError> {
        let Some(alias) = alias else {
            return Ok(None);
        };
        if !is_alias_name(alias) {
            return Err(DispatchError::BadArgs);
        }
        if let Some(owner) = self.aliases.get(alias) {
            if owner != key {
                return Err(DispatchError::NameTaken);
            }
        }
        self.aliases.insert(alias.to_string(), key.to_string());
        Ok(Some(alias.to_string()))
    }

    fn effective(&self, key: &str) -> Presence {
        match self.endpoints.get(key) {
            Some(ep) => choose_effective(ep.reported.as_ref(), ep.observed.as_ref()),
            None => Presence::unknown(0),
        }
    }

    fn display_label(&self, key: &str, requested: &str) -> String {
        if let Ok(AddrRef::Alias(name)) = parse_address(requested) {
            return format!("alias:{name}");
        }
        if let Some(alias) = self.endpoints.get(key).and_then(|ep| ep.alias.clone()) {
            if requested == alias {
                return format!("alias:{alias}");
            }
        }
        key.to_string()
    }

    fn messaging_blocks(&self, caller: Caller, profile: Option<&str>, address: &str) -> bool {
        if caller == Caller::Human {
            return false;
        }
        if !self.messaging_enabled || self.read_only {
            return true;
        }
        if let Some(profile) = profile {
            if self.profile_messaging.get(profile) == Some(&false) {
                return true;
            }
        }
        if let Ok(AddrRef::Agent(profile)) = parse_address(address) {
            if self.profile_messaging.get(&profile) == Some(&false) {
                return true;
            }
        }
        false
    }

    fn clear_flight(&mut self, key: &str, id: &str) {
        if let Some(ep) = self.endpoints.get_mut(key) {
            if ep.in_flight.as_deref() == Some(id) {
                ep.in_flight = None;
            }
        }
    }

    fn finish(&mut self, receipt: Receipt) -> Receipt {
        self.receipts.insert(receipt.id.clone(), receipt.clone());
        receipt
    }
}

impl Endpoint {
    fn new(
        family: Family,
        id: &str,
        alias: Option<String>,
        parent: Option<String>,
        outlive: bool,
    ) -> Self {
        Self {
            family,
            id: id.to_string(),
            alias,
            engine: None,
            parent,
            outlive,
            observed: None,
            reported: None,
            queue: VecDeque::new(),
            in_flight: None,
            generation: 0,
            queued_generation: 0,
            saw_working: false,
            sent_report_since_working: false,
            exit_fact: None,
            tail: String::new(),
            last_noticed: None,
            live: true,
            any_signal: false,
            report_arrived: false,
        }
    }
}

/// The process argument. A system-prompt engine keeps the manual out of this text.
fn receipt_status_label(status: ReceiptStatus) -> &'static str {
    match status {
        ReceiptStatus::Queued => "queued",
        ReceiptStatus::Submitted => "submitted",
        ReceiptStatus::Rejected => "rejected",
        ReceiptStatus::Settled => "settled",
        ReceiptStatus::Failed => "failed",
        ReceiptStatus::Stalled => "stalled",
    }
}

fn pane_label(pane: PaneVisibility) -> &'static str {
    match pane {
        PaneVisibility::Shown => "shown",
        PaneVisibility::Hidden => "hidden",
        PaneVisibility::Pending => "pending",
        PaneVisibility::NotShown => "not_shown",
    }
}

fn birth_prompt(body: &str, manual_as_system: bool) -> Option<String> {
    let body = body.trim();
    if manual_as_system {
        if body.is_empty() {
            None
        } else {
            Some(body.to_string())
        }
    } else if body.is_empty() {
        Some("The manual is in KITE_SKILL_FILE.".into())
    } else {
        Some(format!("{body}\n\nThe manual is in KITE_SKILL_FILE."))
    }
}

fn rejected(id: &str, op: &str, address: &str, err: DispatchError) -> Receipt {
    Receipt::new(
        id,
        op,
        if err == DispatchError::Timeout {
            ReceiptStatus::Failed
        } else {
            ReceiptStatus::Rejected
        },
        address,
        false,
        None,
        Some(err.code().into()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch::port::FakePort;

    fn service() -> Service<FakePort> {
        Service::new(FakePort::default())
    }

    fn send_to(address: &str, id: &str, body: &str, caller: Caller) -> SendInput {
        SendInput {
            id: id.into(),
            address: address.into(),
            body: body.into(),
            caller,
            force: false,
            allow_queue: true,
            only_ready: false,
            wrap: None,
            from: "alias:source".into(),
            mounted: false,
            source: None,
            label: None,
            now_ms: 1_000,
            profile_id: None,
            system: false,
            presentation_emitted: false,
        }
    }

    #[test]
    fn alias_uniqueness_release_and_agent_resolution() {
        let mut svc = service();
        svc.attach(Family::Terminal, "s1", Some("review"), None, false)
            .unwrap();
        let err = svc
            .attach(Family::Terminal, "s2", Some("review"), None, false)
            .unwrap_err();
        assert_eq!(err, DispatchError::NameTaken);
        svc.stop("review").unwrap();
        svc.attach(Family::Terminal, "s3", Some("review"), None, false)
            .unwrap();

        let missing = svc.send(send_to("agent:p1", "a1", "hi", Caller::Human));
        assert_eq!(missing.error.as_deref(), Some("no_live_endpoint"));
        assert_eq!(svc.port_mut().pty_writes(), 0);
        svc.attach(Family::Thread, "t1", None, None, false).unwrap();
        svc.bind_agent("p1", "t1").unwrap();
        svc.publish_pane("thread:t1", "idle", 1, 1_000, None, None)
            .unwrap();
        let ok = svc.send(send_to("agent:p1", "a2", "hi", Caller::Human));
        assert_eq!(ok.status, ReceiptStatus::Submitted);
        assert_eq!(svc.port_mut().pty_writes(), 1);
    }

    #[test]
    fn repeated_id_writes_once() {
        let mut svc = service();
        svc.attach(Family::Terminal, "s1", Some("review"), None, false)
            .unwrap();
        svc.publish_pane("review", "idle", 1, 1_000, None, None).unwrap();
        let first = svc.send(send_to("review", "same", "once", Caller::Human));
        let second = svc.send(send_to("review", "same", "once", Caller::Human));
        assert_eq!(first.status, second.status);
        assert!(second.replayed);
        assert!(!first.replayed);
        assert_eq!(svc.port_mut().pty_writes(), 1);
    }

    #[test]
    fn blocked_permission_and_timeout_write_nothing() {
        let mut svc = service();
        svc.attach(Family::Terminal, "s1", Some("review"), None, false)
            .unwrap();
        svc.publish_reported("review", PresenceState::Blocked, Some(BlockKind::Permission), 2, 1_000)
            .unwrap();
        let mut forced = send_to("review", "b1", "approve", Caller::Human);
        forced.force = true;
        let blocked = svc.send(forced);
        assert_eq!(blocked.error.as_deref(), Some("destination_blocked"));
        assert_eq!(svc.port_mut().pty_writes(), 0);

        let mut agent_force = send_to("review", "b2", "approve", Caller::Agent);
        agent_force.force = true;
        let forbidden = svc.send(agent_force);
        assert_eq!(forbidden.error.as_deref(), Some("force_forbidden"));

        let wait = svc.wait(WaitInput {
            id: "w1".into(),
            address: Some("review".into()),
            until: vec![PresenceState::Idle],
            children: None,
            timeout_ms: 0,
            started_ms: 1_000,
            now_ms: 1_000,
        });
        assert_eq!(wait.error.as_deref(), Some("timeout"));
        assert!(!wait.submitted);
        assert_eq!(svc.port_mut().pty_writes(), 0);
    }

    #[test]
    fn stall_is_submitted_and_does_not_write_again() {
        let mut svc = service();
        svc.attach(Family::Terminal, "s1", Some("review"), None, false)
            .unwrap();
        svc.publish_pane("review", "idle", 1, 1_000, None, None).unwrap();
        let sent = svc.send(send_to("review", "st", "body", Caller::Human));
        assert!(sent.submitted);
        let stalled = svc.settle("st", 1_000 + STALL_MS).unwrap();
        assert_eq!(stalled.status, ReceiptStatus::Stalled);
        assert!(stalled.submitted);
        assert_eq!(svc.port_mut().pty_writes(), 1);
        let replay = svc.send(send_to("review", "st", "body", Caller::Human));
        assert_eq!(replay.status, ReceiptStatus::Stalled);
        assert_eq!(svc.port_mut().pty_writes(), 1);
    }

    #[test]
    fn queue_full_keeps_the_tail_and_unknown_is_queued() {
        let mut svc = service();
        svc.attach(Family::Terminal, "s1", Some("review"), None, false)
            .unwrap();
        svc.publish_pane("review", "working", 1, 1_000, None, None)
            .unwrap();
        for n in 0..QUEUE_DEPTH {
            let receipt = svc.send(send_to("review", &format!("q{n}"), "x", Caller::Human));
            assert_eq!(receipt.status, ReceiptStatus::Queued);
        }
        let full = svc.send(send_to("review", "overflow", "x", Caller::Human));
        assert_eq!(full.error.as_deref(), Some("queue_full"));
        let queued = svc.endpoints.get("session:s1").unwrap().queue.len();
        assert_eq!(queued, QUEUE_DEPTH);
        assert!(svc
            .endpoints
            .get("session:s1")
            .unwrap()
            .queue
            .iter()
            .all(|item| item.id != "overflow"));
        assert_eq!(svc.port_mut().pty_writes(), 0);

        svc.publish_pane("review", "done", 2, 2_000, None, None).unwrap();
        assert_eq!(svc.port_mut().pty_writes(), 1);
    }

    #[test]
    fn mounted_submit_does_not_count_as_a_pty_write() {
        let mut svc = service();
        svc.attach(Family::Terminal, "s1", Some("review"), None, false)
            .unwrap();
        svc.publish_pane("review", "idle", 1, 1_000, None, None).unwrap();
        let mut input = send_to("review", "m1", "fly", Caller::Human);
        input.mounted = true;
        let receipt = svc.send(input);
        assert!(receipt.submitted);
        assert_eq!(svc.port_mut().pty_writes(), 0);
        assert_eq!(svc.port_mut().writes.len(), 1);
    }

    #[test]
    fn child_notice_outlive_and_dead_parent() {
        let mut svc = service();
        svc.attach(Family::Terminal, "parent", Some("lead"), None, false)
            .unwrap();
        svc.publish_pane("lead", "idle", 1, 1_000, None, None).unwrap();
        svc.attach(Family::Terminal, "child", Some("helper"), Some("lead"), false)
            .unwrap();
        svc.attach(Family::Terminal, "kept", Some("keeper"), Some("lead"), true)
            .unwrap();
        svc.publish_pane("helper", "working", 1, 1_000, None, None)
            .unwrap();
        svc.publish_pane("helper", "exited", 2, 2_000, Some("last line"), Some("exit 1"))
            .unwrap();
        let notices = svc
            .port_mut()
            .writes
            .iter()
            .filter(|w| w.text.contains("state: gone"))
            .count();
        assert_eq!(notices, 1);
        assert!(svc.port_mut().writes[0].text.contains("This is another agent, not the person."));
        assert!(!svc.port_mut().writes[0].text.contains("callee transcript"));

        svc.publish_pane("helper", "exited", 3, 3_000, None, None).unwrap();
        let notices = svc
            .port_mut()
            .writes
            .iter()
            .filter(|w| w.text.contains("state: gone"))
            .count();
        assert_eq!(notices, 1);

        let missing = svc.report(
            "r-dead",
            Some("keeper"),
            Some("alias:ghost"),
            "done",
            Caller::Agent,
            4_000,
        );
        assert_eq!(missing.error.as_deref(), Some("parent_missing"));
        assert_eq!(svc.port_mut().pty_writes(), notices);

        svc.stop("lead").unwrap();
        let stopped: Vec<&str> = svc.port_mut().stops.iter().map(|(_, id)| id.as_str()).collect();
        assert!(stopped.contains(&"child"));
        assert!(!stopped.contains(&"kept"));
    }

    #[test]
    fn role_starts_one_command_and_one_first_send_after_idle() {
        let mut svc = service();
        let dir = std::env::temp_dir().join(format!("kite-dispatch-run-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let missing = svc.run_role(
            "missing",
            &dir,
            "reviewer",
            None,
            None,
            Caller::Human,
            1_000,
            None,
            false,
            false,
            None,
        );
        assert_eq!(missing.error.as_deref(), Some("role_not_found"));
        assert!(svc.port_mut().starts.is_empty());

        crate::dispatch::role::ensure_sample_role(&dir).unwrap();
        let started = svc.run_role(
            "run-1",
            &dir,
            "reviewer",
            Some("Task body".into()),
            None,
            Caller::Human,
            1_000,
            None,
            false,
            false,
            None,
        );
        assert_eq!(started.status, ReceiptStatus::Submitted);
        assert_eq!(svc.port_mut().starts.len(), 1);
        assert_eq!(svc.port_mut().starts[0].engine, "codex");
        let prompt = svc.port_mut().starts[0].prompt.clone().unwrap_or_default();
        assert!(prompt.contains("Task body"));
        assert!(prompt.contains("The manual is in KITE_SKILL_FILE."));
        assert!(!prompt.contains("kite dispatch run <role>"));
        assert!(!svc.port_mut().starts[0].manual_as_system);
        assert_eq!(svc.port_mut().pty_writes(), 0);
        svc.publish_pane("reviewer", "idle", 1, 2_000, None, None)
            .unwrap();
        assert_eq!(svc.port_mut().pty_writes(), 0);
        assert!(svc.port_mut().writes.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn engine_run_queues_one_task_and_lists_the_engine() {
        let mut svc = service();
        let started = svc.run(RunInput {
            id: "run-task".into(),
            via: Family::Terminal,
            engine: Some("codex".into()),
            command: None,
            name: Some("helper".into()),
            parent: None,
            outlive: false,
            role: None,
            role_missing: false,
            task: Some("Look at the tests".into()),
            caller: Caller::Agent,
            cwd: None,
            now_ms: 1_000,
            hidden: false,
            argv: Vec::new(),
        });
        assert_eq!(started.status, ReceiptStatus::Submitted);
        let prompt = svc.port_mut().starts[0].prompt.clone().unwrap_or_default();
        assert!(prompt.contains("Look at the tests"));
        assert!(prompt.contains("The manual is in KITE_SKILL_FILE."));
        assert!(!prompt.contains("kite dispatch run <role>"));
        assert!(!svc.port_mut().starts[0].manual_as_system);
        assert_eq!(svc.port_mut().pty_writes(), 0);
        svc.publish_pane("helper", "idle", 1, 2_000, None, None).unwrap();
        assert_eq!(svc.port_mut().pty_writes(), 0);
        assert!(svc.port_mut().writes.is_empty());
        let row = svc.ls().into_iter().next().unwrap_or_default();
        assert!(row.contains("alias:helper"));
        assert!(row.contains("codex"));
        assert!(row.contains("idle"));

        let grok = svc.run(RunInput {
            id: "run-grok".into(),
            via: Family::Terminal,
            engine: Some("grok".into()),
            command: None,
            name: Some("grok".into()),
            parent: None,
            outlive: false,
            role: None,
            role_missing: false,
            task: Some("Look at the login bug".into()),
            caller: Caller::Agent,
            cwd: None,
            now_ms: 3_000,
            hidden: true,
            argv: Vec::new(),
        });
        assert_eq!(grok.status, ReceiptStatus::Submitted);
        assert_eq!(grok.pane, Some(crate::dispatch::types::PaneVisibility::Hidden));
        let start = &svc.port_mut().starts[1];
        assert_eq!(start.engine, "grok");
        assert!(start.manual_as_system);
        assert_eq!(start.prompt.as_deref(), Some("Look at the login bug"));
        assert!(!start.prompt.as_deref().unwrap_or("").contains("KITE_SKILL_FILE"));
        svc.publish_pane("grok", "idle", 2, 4_000, None, None).unwrap();
        assert_eq!(svc.port_mut().pty_writes(), 0);
        assert!(svc.port_mut().writes.is_empty());
    }

    #[test]
    fn read_prefers_live_text_over_a_published_tail() {
        let mut svc = service();
        svc.attach(Family::Terminal, "s1", Some("review"), None, false)
            .unwrap();
        svc.publish_pane("review", "idle", 1, 1_000, Some("old tail"), None)
            .unwrap();
        svc.port_mut()
            .buffers
            .push(((Family::Terminal, "s1".into()), "live line".into()));
        let receipt = svc.read("rd-live", "review", 80);
        assert_eq!(receipt.text.as_deref(), Some("live line"));
        assert_eq!(svc.port_mut().pty_writes(), 0);
    }

    #[test]
    fn read_does_not_clear_done() {
        let mut svc = service();
        svc.attach(Family::Terminal, "s1", Some("review"), None, false)
            .unwrap();
        svc.publish_pane("review", "done", 1, 1_000, None, None).unwrap();
        svc.port_mut()
            .buffers
            .push(((Family::Terminal, "s1".into()), "one\ntwo\nthree".into()));
        let receipt = svc.read("rd", "review", 2);
        assert_eq!(receipt.text.as_deref(), Some("two\nthree"));
        assert_eq!(svc.effective("session:s1").state, PresenceState::Done);
        assert_eq!(svc.port_mut().pty_writes(), 0);
    }

    #[test]
    fn osc_clear_restores_observed_and_stale_report_is_ignored() {
        let mut svc = service();
        svc.attach(Family::Terminal, "s1", Some("review"), None, false)
            .unwrap();
        svc.publish_pane("review", "idle", 1, 1_000, None, None).unwrap();
        assert!(svc
            .publish_osc("review", "state=working:seq=5", 1_100)
            .unwrap());
        assert_eq!(svc.effective("session:s1").state, PresenceState::Working);
        assert!(!svc.publish_osc("review", "state=done:seq=4", 1_200).unwrap());
        assert_eq!(svc.effective("session:s1").state, PresenceState::Working);
        assert!(svc.publish_osc("review", "state=clear:seq=6", 1_300).unwrap());
        assert_eq!(svc.effective("session:s1").state, PresenceState::Idle);
        assert!(!svc.publish_osc("review", "state=working:broken", 1_400).unwrap());
        assert_eq!(svc.effective("session:s1").state, PresenceState::Idle);
    }

    #[test]
    fn offline_and_messaging_do_not_write() {
        let mut svc = service();
        svc.attach(Family::Terminal, "s1", Some("review"), None, false)
            .unwrap();
        svc.publish_pane("review", "idle", 1, 1_000, None, None).unwrap();
        svc.set_online(false);
        let off = svc.send(send_to("review", "off", "x", Caller::Agent));
        assert_eq!(off.error.as_deref(), Some("runtime_offline"));
        svc.set_online(true);
        svc.set_messaging(false, false);
        let denied = svc.send(send_to("review", "msg", "x", Caller::Agent));
        assert_eq!(denied.error.as_deref(), Some("messaging_disabled"));
        let human = svc.send(send_to("review", "human", "x", Caller::Human));
        assert_eq!(human.status, ReceiptStatus::Submitted);
        svc.set_messaging(true, true);
        let readonly = svc.send(send_to("review", "ro", "x", Caller::Script));
        assert_eq!(readonly.error.as_deref(), Some("messaging_disabled"));
        assert_eq!(svc.port_mut().pty_writes(), 1);
    }

    #[test]
    fn parent_hears_blocked_then_gone_once_each() {
        let mut svc = service();
        svc.attach(Family::Terminal, "parent", Some("lead"), None, false)
            .unwrap();
        svc.publish_pane("lead", "idle", 1, 1_000, None, None).unwrap();
        svc.attach(Family::Terminal, "child", Some("helper"), Some("lead"), false)
            .unwrap();
        svc.publish_pane("helper", "waitingForYou", 1, 1_100, None, None)
            .unwrap();
        let blocked = svc
            .port_mut()
            .writes
            .iter()
            .filter(|w| w.text.contains("state: blocked"))
            .count();
        assert_eq!(blocked, 1);
        svc.publish_pane("lead", "idle", 2, 1_150, None, None).unwrap();

        svc.publish_pane("helper", "working", 2, 1_200, None, None)
            .unwrap();
        svc.publish_pane("helper", "waitingForYou", 3, 1_300, None, None)
            .unwrap();
        svc.publish_pane("lead", "idle", 3, 1_350, None, None).unwrap();
        svc.publish_pane("helper", "exited", 4, 1_400, Some("last line"), Some("exit 1"))
            .unwrap();
        svc.publish_pane("helper", "exited", 5, 1_500, None, None)
            .unwrap();
        let blocked = svc
            .port_mut()
            .writes
            .iter()
            .filter(|w| w.text.contains("state: blocked"))
            .count();
        let gone = svc
            .port_mut()
            .writes
            .iter()
            .filter(|w| w.text.contains("state: gone"))
            .count();
        assert_eq!(blocked, 2);
        assert_eq!(gone, 1);
    }

    #[test]
    fn a_report_since_working_suppresses_the_parent_notice() {
        let mut svc = service();
        svc.attach(Family::Terminal, "parent", Some("lead"), None, false)
            .unwrap();
        svc.publish_pane("lead", "idle", 1, 1_000, None, None).unwrap();
        svc.attach(Family::Terminal, "child", Some("helper"), Some("lead"), false)
            .unwrap();
        svc.publish_pane("helper", "working", 1, 1_100, None, None)
            .unwrap();
        let reported = svc.report(
            "rep",
            Some("helper"),
            None,
            "Findings are in.",
            Caller::Agent,
            1_200,
        );
        assert_eq!(reported.status, ReceiptStatus::Submitted);
        svc.publish_pane("helper", "waitingForYou", 2, 1_300, None, None)
            .unwrap();
        svc.publish_pane("helper", "exited", 3, 1_400, None, None)
            .unwrap();
        assert!(svc
            .port_mut()
            .writes
            .iter()
            .all(|w| !w.text.contains("state: blocked") && !w.text.contains("state: gone")));
    }

    #[test]
    fn a_report_blocks_send_until_the_session_is_killed() {
        let mut svc = service();
        svc.attach(Family::Terminal, "s1", Some("review"), None, false)
            .unwrap();
        assert!(svc
            .publish_osc("review", "state=blocked:seq=2", 1_000)
            .unwrap());
        svc.publish_pane("review", "idle", 1_700_000_000_000, 1_100, None, None)
            .unwrap();
        let blocked = svc.send(send_to("review", "blocked-send", "hi", Caller::Agent));
        assert_eq!(blocked.error.as_deref(), Some("destination_blocked"));
        assert_eq!(svc.port_mut().pty_writes(), 0);

        let killed = svc.kill("kill-review", "review");
        assert_eq!(killed.status, ReceiptStatus::Settled);
        assert_eq!(killed.presence_at_submit.as_deref(), Some("gone"));
        assert!(svc.ls().is_empty());
        assert!(svc.port_mut().stops.iter().any(|(_, id)| id == "s1"));
    }

    #[test]
    fn kill_stops_a_session_the_service_has_not_attached() {
        let mut svc = service();
        let killed = svc.kill("kill-raw", "session:missing-pane");
        assert_eq!(killed.status, ReceiptStatus::Settled);
        assert!(svc
            .port_mut()
            .stops
            .iter()
            .any(|(family, id)| *family == Family::Terminal && id == "missing-pane"));
    }

    #[test]
    fn interrupt_writes_ctrl_c_while_blocked_and_keys_do_not_add_enter() {
        let mut svc = service();
        svc.attach(Family::Terminal, "s1", Some("review"), None, false)
            .unwrap();
        svc.publish_osc("review", "state=working:seq=3", 1_000)
            .unwrap();
        let interrupted = svc.interrupt("int-1", "review");
        assert_eq!(interrupted.status, ReceiptStatus::Submitted);
        assert_eq!(svc.port_mut().writes.len(), 1);
        assert_eq!(svc.port_mut().writes[0].text, "\u{3}");
        assert!(svc.port_mut().writes[0].pty);
        assert!(!svc.port_mut().writes[0].presentation);

        let typed = svc.keys("keys-1", "review", &["up".into(), "enter".into()]);
        assert_eq!(typed.status, ReceiptStatus::Submitted);
        assert_eq!(svc.port_mut().writes[1].text, "\u{1b}[A\r");

        let rejected = svc.keys("keys-bad", "review", &["not-a-key".into()]);
        assert_eq!(rejected.error.as_deref(), Some("bad_args"));
        assert_eq!(svc.port_mut().writes.len(), 2);
    }

    #[test]
    fn attach_reveals_the_session_and_raw_argv_is_not_a_prompt() {
        let mut svc = service();
        svc.attach(Family::Terminal, "s1", Some("review"), None, false)
            .unwrap();
        if let Some(ep) = svc.endpoints.get_mut("session:s1") {
            ep.engine = Some("codex".into());
        }
        let shown = svc.show("show-1", "review");
        assert_eq!(shown.status, ReceiptStatus::Settled);
        assert_eq!(
            svc.port_mut().reveals,
            vec![("s1".into(), "codex".into(), Some("review".into()))]
        );

        let started = svc.run(RunInput {
            id: "raw-1".into(),
            via: Family::Terminal,
            engine: Some("cargo".into()),
            command: Some("cargo".into()),
            name: None,
            parent: None,
            outlive: false,
            role: None,
            role_missing: false,
            task: Some("do not type this".into()),
            caller: Caller::Agent,
            cwd: None,
            now_ms: 10,
            hidden: true,
            argv: vec!["cargo".into(), "test".into()],
        });
        assert_eq!(started.status, ReceiptStatus::Submitted);
        let start = &svc.port_mut().starts[0];
        assert_eq!(start.argv, vec!["cargo".to_string(), "test".to_string()]);
        assert!(start.prompt.is_none());
    }
}
