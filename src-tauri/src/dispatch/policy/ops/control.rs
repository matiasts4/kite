use std::path::Path;

use crate::dispatch::address::is_alias_name;
use crate::dispatch::envelope::{last_lines, wrap_envelope};
use crate::dispatch::files::read_workspace_file;
use crate::dispatch::keys::encode_key;
use crate::dispatch::policy::service::{endpoint_wait_state, is_settled_child_state, Service};
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

    /// Sends an interrupt signal. Does not press Enter and does not use the send gate.
    pub fn interrupt(&mut self, id: &str, address: &str) -> Receipt {
        if let Some(existing) = self.receipts.get(id) {
            return existing.clone();
        }
        let (family, session) = match self.resolve_control_target(address) {
            Ok(target) => target,
            Err(err) => return self.finish(rejected(id, "interrupt", address, err)),
        };
        match self.port.interrupt(family, &session) {
            Ok(()) => self.finish(Receipt::new(
                id,
                "interrupt",
                ReceiptStatus::Submitted,
                address,
                true,
                None,
                None,
            )),
            Err(err) => self.finish(rejected(id, "interrupt", address, err)),
        }
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

    fn resolve_control_target(&mut self, address: &str) -> Result<(Family, String), DispatchError> {
        if !self.online {
            return Err(DispatchError::RuntimeOffline);
        }
        let key = self.resolve(address)?;
        let ep = self
            .endpoints
            .get(&key)
            .ok_or(DispatchError::UnknownAddress)?;
        Ok((ep.family, ep.id.clone()))
    }

    pub(crate) fn write_control(&mut self, id: &str, op: &str, address: &str, bytes: &str) -> Receipt {
        if let Some(existing) = self.receipts.get(id) {
            return existing.clone();
        }
        let (family, session) = match self.resolve_control_target(address) {
            Ok(target) => target,
            Err(err) => return self.finish(rejected(id, op, address, err)),
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
                    !matches!(
                        endpoint_wait_state(ep),
                        PresenceState::Working | PresenceState::Unknown
                    )
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
                        && is_settled_child_state(endpoint_wait_state(ep))
                }))
            }
        }
    }
}

