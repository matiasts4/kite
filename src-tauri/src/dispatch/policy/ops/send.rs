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
            if input.children.is_none() && !address.is_empty() {
                self.suppress_parent_notice_for(&address);
            }
            let settled_presence = if input.children.is_none() && !address.is_empty() {
                self.resolve(&address)
                    .ok()
                    .map(|k| self.effective(&k).state.as_str().to_string())
            } else {
                None
            };
            return self.finish(Receipt::new(
                &input.id,
                "wait",
                ReceiptStatus::Settled,
                &address,
                false,
                settled_presence,
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
        self.read_with_mode(id, address, lines, false)
    }

    pub fn read_with_mode(
        &mut self,
        id: &str,
        address: &str,
        lines: usize,
        last_assistant: bool,
    ) -> Receipt {
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
        if last_assistant && family == Family::Thread {
            let text = self
                .port
                .read_final_response(family, &raw)
                .unwrap_or_default();
            let after = self.effective(&key).state;
            debug_assert_eq!(before, after);
            let mut receipt =
                Receipt::new(id, "read", ReceiptStatus::Settled, address, false, None, None);
            receipt.text = Some(text);
            return self.finish(receipt);
        }
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
}
