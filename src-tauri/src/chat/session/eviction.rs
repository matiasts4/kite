use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::chat::drivers::DriverDeclaration;
use crate::chat::utils::now_ms;

use super::*;

impl SessionManager {
    /// A provider exit settles pending approvals and ends the turn.
    pub fn handle_exit(
        &mut self,
        thread_id: &str,
        code: Option<i32>,
        error: Option<String>,
    ) -> Result<(), SessionError> {
        let session = self
            .sessions
            .get_mut(thread_id)
            .ok_or_else(|| SessionError::NotAttached(thread_id.to_string()))?;
        apply_exit(session, code, error);
        Ok(())
    }

    pub fn status(&self, thread_id: &str) -> Option<SessionRecord> {
        self.sessions
            .get(thread_id)
            .map(|session| session.record.clone())
    }

    /// Returns the active conversation handle from either the session record or its
    /// underlying transport (surviving mid-turn account-switch handle clears on future turns).
    pub fn transport_resume_handle(&self, thread_id: &str) -> Option<String> {
        self.sessions.get(thread_id).and_then(|session| {
            session
                .record
                .resume_handle
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .or_else(|| {
                    session
                        .transport
                        .resume_handle()
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                })
        })
    }

    pub fn events_since(&self, thread_id: &str, sequence: u64) -> Vec<SessionEvent> {
        self.sessions
            .get(thread_id)
            .map(|session| {
                session
                    .events
                    .iter()
                    .filter(|event| event.sequence > sequence)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn active_thread_count(&self) -> usize {
        self.sessions
            .values()
            .filter(|session| session.record.state != SessionState::Closed)
            .count()
    }

    /// Stops warm/idle sessions matching `canonical_driver` (normalizing `agy` <-> `antigravity`)
    /// and clears stored `resume_handle` values so subsequent turns never reuse stale credentials.
    pub fn evict_provider_sessions(&mut self, canonical_driver: &str) -> Vec<String> {
        let norm = |s: &str| match s.trim().to_ascii_lowercase().as_str() {
            "agy" => "antigravity".to_string(),
            other => other.to_string(),
        };
        let target = norm(canonical_driver);
        let matching_ids: Vec<String> = self
            .sessions
            .iter()
            .filter(|(_, session)| norm(&session.record.driver) == target)
            .map(|(id, _)| id.clone())
            .collect();

        let mut evicted = Vec::new();
        for thread_id in matching_ids {
            let Some(session) = self.sessions.get_mut(&thread_id) else {
                continue;
            };
            // Always clear persisted resume handle so no subsequent turn passes an old account handle.
            session.record.resume_handle = None;

            // Leave actively streaming turns running until they settle cleanly.
            if matches!(
                session.record.state,
                SessionState::Running | SessionState::Waiting | SessionState::Starting
            ) {
                continue;
            }

            if !matches!(
                session.record.state,
                SessionState::Reaped
                    | SessionState::Closed
                    | SessionState::Failed
                    | SessionState::Resumable
            ) {
                let _ = session.transport.stop();
            }
            if session.record.state != SessionState::Closed {
                session.record.state = SessionState::Reaped;
                clear_heavy_session_payloads(session);
                settle_approvals(session, "accountSwitch");
                push_event(
                    session,
                    "evicted",
                    json!({ "driver": session.record.driver, "reason": "accountSwitch" }),
                );
            } else {
                settle_approvals(session, "accountSwitch");
            }
            evicted.push(thread_id);
        }
        evicted
    }

    pub fn reap_session(&mut self, thread_id: &str) -> Result<Option<String>, SessionError> {
        let session = self
            .sessions
            .get_mut(thread_id)
            .ok_or_else(|| SessionError::NotAttached(thread_id.to_string()))?;
        if let Some(handle) = session.transport.resume_handle() {
            if !handle.trim().is_empty() {
                session.record.resume_handle = Some(handle);
            }
        }
        session.transport.stop().map_err(SessionError::Transport)?;
        session.record.state = SessionState::Reaped;
        let handle = session.record.resume_handle.clone();
        clear_heavy_session_payloads(session);
        settle_approvals(session, "reaped");
        push_event(session, "reaped", json!({ "resumeHandle": handle }));
        Ok(handle)
    }

    /// Immediately reaps an ephemeral subagent session once its turn settles,
    /// stopping any active transport and clearing heavy buffered event payloads
    /// while preserving `resume_handle` for subsequent follow-up turns.
    pub fn reap_if_ephemeral(&mut self, thread_id: &str) -> bool {
        if !self.is_ephemeral(thread_id) {
            return false;
        }
        self.ephemeral_threads.remove(thread_id);

        let Some(session) = self.sessions.get_mut(thread_id) else {
            return false;
        };
        if session.record.state == SessionState::Closed {
            return false;
        }

        capture_resume_handle(session);
        let should_stop = session.record.state != SessionState::Reaped
            && session.record.state != SessionState::Prepared
            && (session.transport.is_alive()
                || matches!(
                    session.record.state,
                    SessionState::Starting
                        | SessionState::Running
                        | SessionState::Waiting
                        | SessionState::Idle
                        | SessionState::Resurrecting
                        | SessionState::Completed
                ));
        if should_stop {
            let _ = session.transport.stop();
        }

        session.record.state = SessionState::Reaped;
        let handle = session.record.resume_handle.clone();
        clear_heavy_session_payloads(session);
        settle_approvals(session, "ephemeralReap");
        push_event(
            session,
            "reaped",
            json!({ "resumeHandle": handle, "reason": "ephemeralReap" }),
        );
        true
    }

    pub fn reap_idle_sessions(&mut self, idle_timeout_ms: i64) -> Vec<String> {
        let now = now_ms();
        let to_reap: Vec<String> = self
            .sessions
            .iter()
            .filter(|(_, session)| {
                session.record.mode == SessionMode::Persistent
                    && session.record.is_idle()
                    && (now - session.record.last_active_at_ms) >= idle_timeout_ms
            })
            .map(|(id, _)| id.clone())
            .collect();

        let mut reaped = Vec::new();
        for thread_id in to_reap {
            if self.reap_session(&thread_id).is_ok() {
                reaped.push(thread_id);
            }
        }
        reaped
    }

    pub fn warm_count(&self) -> usize {
        self.sessions
            .values()
            .filter(|session| session.record.is_warm())
            .count()
    }

    pub fn enforce_lru_capacity(&mut self, max_warm: usize) -> Vec<String> {
        if self.warm_count() <= max_warm {
            return Vec::new();
        }
        let mut idle_sessions: Vec<(String, i64)> = self
            .sessions
            .iter()
            .filter(|(_, session)| {
                session.record.mode == SessionMode::Persistent && session.record.is_idle()
            })
            .map(|(id, session)| (id.clone(), session.record.last_active_at_ms))
            .collect();

        // Oldest first (smallest timestamp)
        idle_sessions.sort_by_key(|(_, ts)| *ts);

        let mut reaped = Vec::new();
        for (thread_id, _) in idle_sessions {
            if self.warm_count() <= max_warm {
                break;
            }
            if self.reap_session(&thread_id).is_ok() {
                reaped.push(thread_id);
            }
        }
        reaped
    }

    pub fn stop_all(&mut self) -> Vec<String> {
        let thread_ids: Vec<String> = self
            .sessions
            .iter()
            .filter(|(_, session)| session.record.state != SessionState::Closed)
            .map(|(id, _)| id.clone())
            .collect();

        let mut stopped = Vec::new();
        for thread_id in thread_ids {
            if self.stop(&thread_id).is_ok() {
                stopped.push(thread_id);
            }
        }
        stopped
    }

    pub(super) fn record_command(
        &mut self,
        command_id: &str,
        prompt: &str,
        receipt: SendReceipt,
    ) {
        if !self.commands.contains_key(command_id) {
            while self.commands.len() >= DEFAULT_MAX_COMMAND_RECORDS {
                let Some(oldest) = self.command_order.pop_front() else {
                    break;
                };
                self.commands.remove(&oldest);
            }
            self.command_order.push_back(command_id.to_string());
        }
        self.commands.insert(
            command_id.to_string(),
            CommandRecord {
                prompt: prompt.to_string(),
                receipt,
            },
        );
    }

    pub(super) fn prune_terminal_sessions(&mut self, max_terminal: usize) -> usize {
        let mut terminal: Vec<(String, i64)> = self
            .sessions
            .iter()
            .filter(|(_, session)| {
                matches!(
                    session.record.state,
                    SessionState::Closed
                        | SessionState::Failed
                        | SessionState::Interrupted
                        | SessionState::Completed
                )
            })
            .map(|(id, session)| (id.clone(), session.record.last_active_at_ms))
            .collect();
        if terminal.len() <= max_terminal {
            return 0;
        }
        terminal.sort_by_key(|(_, ts)| *ts);
        let to_remove = terminal.len() - max_terminal;
        let mut removed = 0;
        for (thread_id, _) in terminal.into_iter().take(to_remove) {
            if self.sessions.remove(&thread_id).is_some() {
                self.ephemeral_threads.remove(&thread_id);
                removed += 1;
            }
        }
        removed
    }
}

pub(super) fn spawn_once(session: &mut ManagedSession, resume_handle: Option<String>) -> Result<(), SessionError> {
    session.record.state = SessionState::Starting;
    let spec = TransportSpec {
        session_id: session.record.session_id.clone(),
        driver: session.record.driver.clone(),
        working_directory: session.record.working_directory.clone(),
        mode: session.record.mode,
        recipe_revision: session.record.recipe.as_ref().map(|recipe| recipe.revision.clone()),
        resume_handle,
        extra_env: session.record.extra_env.clone(),
    };
    if let Err(reason) = session.transport.spawn(&spec) {
        session.record.state = SessionState::Failed;
        push_event(session, "failed", json!({ "reason": reason }));
        return Err(SessionError::SpawnFailed(reason));
    }
    if let Some(handle) = session.transport.resume_handle() {
        if !handle.trim().is_empty() {
            session.record.resume_handle = Some(handle);
        }
    }
    session.record.state = SessionState::Running;
    push_event(session, "started", json!({ "sessionId": session.record.session_id }));
    Ok(())
}

pub(super) fn apply_exit(session: &mut ManagedSession, code: Option<i32>, error: Option<String>) {
    // The provider may announce its handle after the spawn returned.
    if let Some(handle) = session.transport.resume_handle() {
        if !handle.trim().is_empty() {
            session.record.resume_handle = Some(handle);
        }
    }
    session.record.state = if error.is_some() {
        SessionState::Failed
    } else if session.record.mode != SessionMode::OneShot && session.record.resume_handle.is_some() {
        SessionState::Resumable
    } else {
        SessionState::Closed
    };
    if matches!(
        session.record.state,
        SessionState::Closed | SessionState::Failed
    ) {
        clear_heavy_session_payloads(session);
    }
    settle_approvals(session, "sessionExit");
    push_event(
        session,
        "exited",
        json!({ "code": code, "error": error, "state": state_name(session.record.state) }),
    );
}

pub(super) fn settle_approvals(session: &mut ManagedSession, reason: &str) {
    let pending: Vec<String> = session.record.pending_approvals.drain(..).collect();
    for request_id in pending {
        push_event(
            session,
            "approvalSettled",
            json!({ "requestId": request_id, "decision": "deny", "reason": reason }),
        );
    }
}

pub(super) fn clear_heavy_session_payloads(session: &mut ManagedSession) {
    session.events.clear();
    session.events.shrink_to_fit();
}

pub(super) fn push_event(session: &mut ManagedSession, kind: &str, payload: Value) {
    session.record.next_sequence += 1;
    while session.events.len() >= DEFAULT_MAX_SESSION_EVENTS {
        session.events.pop_front();
    }
    session.events.push_back(SessionEvent {
        sequence: session.record.next_sequence,
        kind: kind.to_string(),
        payload,
    });
}

pub(super) fn state_name(state: SessionState) -> &'static str {
    match state {
        SessionState::Prepared => "prepared",
        SessionState::Starting => "starting",
        SessionState::Running => "running",
        SessionState::Waiting => "waiting",
        SessionState::Idle => "idle",
        SessionState::Completed => "completed",
        SessionState::Interrupted => "interrupted",
        SessionState::Failed => "failed",
        SessionState::Resumable => "resumable",
        SessionState::Reaped => "reaped",
        SessionState::Resurrecting => "resurrecting",
        SessionState::Closed => "closed",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_persistent_spec(thread_id: &str) -> SessionSpec {
        SessionSpec {
            thread_id: thread_id.to_string(),
            driver: "antigravity".to_string(),
            connection_id: Some("conn-1".to_string()),
            working_directory: Some("E:/kite".to_string()),
            mode: SessionMode::Persistent,
            recipe: None,
            resume_handle: None,
            extra_env: Vec::new(),
        }
    }

    #[test]
    fn reap_if_ephemeral_stops_subagent_preserving_handle_and_ignores_regular_sessions() {
        let mut manager = SessionManager::new();

        let sub_transport = ScriptedTransport::new().with_resume_handle("handle-sub-1");
        manager
            .attach(make_persistent_spec("sub-1"), Box::new(sub_transport.clone()))
            .unwrap();
        manager.set_ephemeral("sub-1", true);
        assert!(manager.is_ephemeral("sub-1"));

        let main_transport = ScriptedTransport::new().with_resume_handle("handle-main-1");
        manager
            .attach(make_persistent_spec("main-1"), Box::new(main_transport.clone()))
            .unwrap();
        assert!(!manager.is_ephemeral("main-1"));

        manager.send_turn("sub-1", "cmd-sub-1", "inspect").unwrap();
        sub_transport.script(TransportEvent::Text("heavy output".to_string()));
        sub_transport.script(TransportEvent::TurnEnded);
        manager.poll("sub-1").unwrap();

        manager.send_turn("main-1", "cmd-main-1", "chat").unwrap();
        main_transport.script(TransportEvent::Text("keep me".to_string()));
        main_transport.script(TransportEvent::TurnEnded);
        manager.poll("main-1").unwrap();

        assert!(!manager.reap_if_ephemeral("main-1"));
        assert_eq!(manager.status("main-1").unwrap().state, SessionState::Idle);
        assert_eq!(main_transport.stop_count(), 0);
        assert!(manager.events_since("main-1", 0).len() >= 2);

        assert!(manager.reap_if_ephemeral("sub-1"));
        assert!(!manager.is_ephemeral("sub-1"));
        assert_eq!(sub_transport.stop_count(), 1);
        let sub_record = manager.status("sub-1").unwrap();
        assert_eq!(sub_record.state, SessionState::Reaped);
        assert_eq!(sub_record.resume_handle.as_deref(), Some("handle-sub-1"));

        let post_reap_events = manager.events_since("sub-1", 0);
        assert_eq!(post_reap_events.len(), 1);
        assert_eq!(post_reap_events[0].kind, "reaped");
        assert_eq!(post_reap_events[0].payload["reason"], "ephemeralReap");

        // Follow-up turn resurrects using the preserved resume handle.
        manager
            .send_turn("sub-1", "cmd-sub-2", "follow-up")
            .unwrap();
        assert_eq!(sub_transport.spawn_count(), 2);
        assert_eq!(
            sub_transport.spawned_specs()[1].resume_handle.as_deref(),
            Some("handle-sub-1")
        );
    }

    #[test]
    fn reap_if_ephemeral_settles_pending_approvals_and_honors_unset() {
        let mut manager = SessionManager::new();

        let waiting_t = ScriptedTransport::new().with_resume_handle("handle-wait");
        manager
            .attach(make_persistent_spec("sub-wait"), Box::new(waiting_t.clone()))
            .unwrap();
        manager.set_ephemeral("sub-wait", true);
        manager.send_turn("sub-wait", "cmd-w", "run").unwrap();
        waiting_t.script(TransportEvent::ApprovalRequest {
            id: "apr-1".to_string(),
            kind: "exec".to_string(),
        });
        manager.poll("sub-wait").unwrap();
        assert_eq!(
            manager.status("sub-wait").unwrap().state,
            SessionState::Waiting
        );

        assert!(manager.reap_if_ephemeral("sub-wait"));
        assert_eq!(waiting_t.stop_count(), 1);
        assert_eq!(
            manager.status("sub-wait").unwrap().state,
            SessionState::Reaped
        );
        let events = manager.events_since("sub-wait", 0);
        assert!(events.iter().any(|ev| {
            ev.kind == "approvalSettled"
                && ev.payload["requestId"] == "apr-1"
                && ev.payload["reason"] == "ephemeralReap"
        }));

        // Toggling ephemeral off prevents reaping.
        let cleared_t = ScriptedTransport::new();
        manager
            .attach(make_persistent_spec("sub-cleared"), Box::new(cleared_t.clone()))
            .unwrap();
        manager.set_ephemeral("sub-cleared", true);
        manager.set_ephemeral("sub-cleared", false);
        manager.start("sub-cleared").unwrap();
        assert!(!manager.reap_if_ephemeral("sub-cleared"));
        assert_eq!(cleared_t.stop_count(), 0);
        assert_eq!(
            manager.status("sub-cleared").unwrap().state,
            SessionState::Running
        );
    }
}
