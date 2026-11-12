use std::collections::HashMap;

use super::types::*;
use crate::dispatch::address::{canonical, is_alias_name, parse_address, AddrRef};
use crate::dispatch::osc::{parse_osc_7501, OscReport};
use crate::dispatch::port::Port;
use crate::dispatch::presence::{
    choose_effective, map_pane_state, Authority, BlockKind, Presence, PresenceState,
};
use crate::dispatch::programs;
use crate::dispatch::types::{exit_code, Caller, DispatchError, Family, Receipt, ReceiptStatus, NOTICE_TAIL_LINES};

pub struct Service<P: Port> {
    pub(crate) endpoints: HashMap<String, Endpoint>,
    pub(crate) aliases: HashMap<String, String>,
    pub(crate) agents: HashMap<String, String>,
    pub(crate) receipts: HashMap<String, Receipt>,
    pub(crate) inflight: HashMap<String, InflightMeta>,
    pub(crate) messaging_enabled: bool,
    pub(crate) read_only: bool,
    pub(crate) profile_messaging: HashMap<String, bool>,
    pub(crate) online: bool,
    pub(crate) port: P,
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
        if let Some(existing_has_alias) = self
            .endpoints
            .get(&key)
            .filter(|ep| ep.live)
            .map(|ep| ep.alias.is_some())
        {
            if !existing_has_alias {
                if let Some(raw_alias) = alias {
                    let normalized = if programs::is_codename(raw_alias) {
                        raw_alias.to_ascii_lowercase()
                    } else {
                        raw_alias.to_string()
                    };
                    if let Ok(claimed) = self.claim_alias(Some(&normalized), &key) {
                        if let Some(ep) = self.endpoints.get_mut(&key) {
                            ep.alias = claimed;
                        }
                    }
                }
            } else if let Some(raw_alias) = alias {
                if !is_alias_name(raw_alias) && !programs::is_codename(raw_alias) {
                    return Err(DispatchError::BadArgs);
                }
                let normalized = raw_alias.to_ascii_lowercase();
                if let Some(owner) = self.aliases.get(&normalized) {
                    if owner != &key {
                        return Err(DispatchError::NameTaken);
                    }
                }
            }
            return Ok(key);
        }
        let parent_key = self.resolve_parent(parent)?;
        let normalized_alias = alias.map(|raw| {
            if programs::is_codename(raw) {
                raw.to_ascii_lowercase()
            } else {
                raw.to_string()
            }
        });
        let alias = self.claim_alias(normalized_alias.as_deref(), &key)?;
        self.endpoints.insert(
            key.clone(),
            Endpoint::new(family, id, alias, parent_key, outlive),
        );
        Ok(key)
    }

    pub fn set_endpoint_engine(&mut self, key: &str, engine: &str) {
        if let Some(ep) = self.endpoints.get_mut(key) {
            if ep.engine.is_none() && !engine.trim().is_empty() {
                ep.engine = Some(engine.to_string());
            }
        }
    }

    pub(crate) fn next_codename(&self) -> String {
        for &name in programs::codenames() {
            if !self.aliases.contains_key(name) {
                return name.to_string();
            }
        }
        let mut num = 2usize;
        loop {
            for &name in programs::codenames() {
                let candidate = format!("{name}-{num}");
                if !self.aliases.contains_key(&candidate) {
                    return candidate;
                }
            }
            num += 1;
        }
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

    pub(crate) fn publish(
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

    pub(crate) fn note_transition(&mut self, key: &str, before: PresenceState, after: PresenceState) {
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

    pub(crate) fn maybe_notice(&mut self, key: &str, state: PresenceState, now_ms: u64) {
        if !matches!(
            state,
            PresenceState::Blocked | PresenceState::Done | PresenceState::Error | PresenceState::Gone
        ) {
            return;
        }
        let (family, raw_id) = match self.endpoints.get(key) {
            Some(ep) => {
                if ep.last_noticed == Some(state) || ep.sent_report_since_working || ep.parent.is_none() {
                    return;
                }
                (ep.family, ep.id.clone())
            }
            None => return,
        };
        let loaded = self
            .port
            .read(family, &raw_id, NOTICE_TAIL_LINES)
            .unwrap_or_default();
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
            let source = if !loaded.trim().is_empty() {
                loaded.as_str()
            } else {
                ep.tail.as_str()
            };
            let tail = clean_notice_tail(source, NOTICE_TAIL_LINES);
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

    pub(crate) fn stop_key(&mut self, key: &str) -> Result<(), DispatchError> {
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
        self.aliases.retain(|_, target| target != key);
        self.agents.retain(|_, target| target != key);
        self.port.stop(family, &id)?;
        Ok(())
    }

    pub(crate) fn resolve(&self, raw: &str) -> Result<String, DispatchError> {
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

    pub(crate) fn live_key(&self, key: &str) -> Result<String, DispatchError> {
        if self.endpoints.get(key).map(|ep| ep.live).unwrap_or(false) {
            Ok(key.to_string())
        } else {
            Err(DispatchError::UnknownAddress)
        }
    }

    pub(crate) fn resolve_parent(&self, parent: Option<&str>) -> Result<Option<String>, DispatchError> {
        match parent {
            None => Ok(None),
            Some(raw) => self.resolve(raw).map(Some).map_err(|_| DispatchError::ParentMissing),
        }
    }

    pub(crate) fn claim_alias(
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

    pub(crate) fn effective(&self, key: &str) -> Presence {
        match self.endpoints.get(key) {
            Some(ep) => choose_effective(ep.reported.as_ref(), ep.observed.as_ref()),
            None => Presence::unknown(0),
        }
    }

    pub(crate) fn display_label(&self, key: &str, requested: &str) -> String {
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

    pub(crate) fn messaging_blocks(&self, caller: Caller, profile: Option<&str>, address: &str) -> bool {
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

    pub(crate) fn clear_flight(&mut self, key: &str, id: &str) {
        if let Some(ep) = self.endpoints.get_mut(key) {
            if ep.in_flight.as_deref() == Some(id) {
                ep.in_flight = None;
            }
        }
    }

    pub(crate) fn finish(&mut self, receipt: Receipt) -> Receipt {
        self.receipts.insert(receipt.id.clone(), receipt.clone());
        receipt
    }
}
