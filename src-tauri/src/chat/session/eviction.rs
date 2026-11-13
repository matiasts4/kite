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

            let _ = session.transport.stop();
            settle_approvals(session, "accountSwitch");
            if session.record.state != SessionState::Closed {
                session.record.state = SessionState::Reaped;
                push_event(
                    session,
                    "evicted",
                    json!({ "driver": session.record.driver, "reason": "accountSwitch" }),
                );
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
        settle_approvals(session, "reaped");
        session.record.state = SessionState::Reaped;
        let handle = session.record.resume_handle.clone();
        push_event(session, "reaped", json!({ "resumeHandle": handle }));
        Ok(handle)
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
    settle_approvals(session, "sessionExit");
    session.record.state = if error.is_some() {
        SessionState::Failed
    } else if session.record.mode != SessionMode::OneShot && session.record.resume_handle.is_some() {
        SessionState::Resumable
    } else {
        SessionState::Closed
    };
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

pub(super) fn push_event(session: &mut ManagedSession, kind: &str, payload: Value) {
    session.record.next_sequence += 1;
    session.events.push(SessionEvent {
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
