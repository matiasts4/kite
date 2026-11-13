use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::chat::drivers::DriverDeclaration;
use crate::chat::utils::now_ms;

use super::*;

pub(super) struct CommandRecord {
    pub(super) prompt: String,
    pub(super) receipt: SendReceipt,
}

pub(super) struct ManagedSession {
    pub(super) record: SessionRecord,
    pub(super) transport: Box<dyn SessionTransport>,
    pub(super) events: Vec<SessionEvent>,
}

/// Owns every live session. One thread has at most one session at a time.
#[derive(Default)]
pub struct SessionManager {
    pub(super) sessions: HashMap<String, ManagedSession>,
    pub(super) commands: HashMap<String, CommandRecord>,
}

impl SessionManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Binds a session to a thread. It never starts a process: the first send
    /// does that after the recipe is already written.
    pub fn attach(
        &mut self,
        spec: SessionSpec,
        transport: Box<dyn SessionTransport>,
    ) -> Result<AttachOutcome, SessionError> {
        if spec.driver.trim().is_empty() {
            return Err(SessionError::InvalidDriver);
        }
        if spec.thread_id.trim().is_empty() {
            return Err(SessionError::NotAttached(spec.thread_id));
        }
        if let Some(existing) = self.sessions.get(&spec.thread_id) {
            if existing.record.state != SessionState::Closed {
                return Ok(AttachOutcome::AlreadyAttached {
                    generation: existing.record.generation,
                    state: existing.record.state,
                });
            }
        }

        let generation = self
            .sessions
            .get(&spec.thread_id)
            .map(|existing| existing.record.generation + 1)
            .unwrap_or(1);
        let session_id = format!("{}:{}", spec.thread_id, generation);
        let initial_state = if spec.resume_handle.is_some() && spec.mode == SessionMode::Persistent {
            SessionState::Reaped
        } else {
            SessionState::Prepared
        };
        let now = now_ms();
        let record = SessionRecord {
            thread_id: spec.thread_id.clone(),
            session_id,
            generation,
            driver: spec.driver,
            connection_id: spec.connection_id,
            working_directory: spec.working_directory,
            mode: spec.mode,
            state: initial_state,
            recipe: spec.recipe,
            resume_handle: spec.resume_handle,
            extra_env: spec.extra_env,
            started_at_ms: now,
            last_active_at_ms: now,
            next_sequence: 0,
            pending_approvals: Vec::new(),
        };
        self.sessions.insert(
            spec.thread_id,
            ManagedSession {
                record,
                transport,
                events: Vec::new(),
            },
        );
        Ok(AttachOutcome::Attached { generation })
    }

    /// Starts the bound process, once. A second start is a no-op.
    pub fn start(&mut self, thread_id: &str) -> Result<u64, SessionError> {
        let is_persistent_and_needs_spawn = self
            .sessions
            .get(thread_id)
            .map(|s| {
                s.record.mode == SessionMode::Persistent
                    && !matches!(
                        s.record.state,
                        SessionState::Running | SessionState::Waiting | SessionState::Idle
                    )
            })
            .unwrap_or(false);
        if is_persistent_and_needs_spawn {
            self.enforce_lru_capacity(DEFAULT_MAX_WARM_SESSIONS.saturating_sub(1));
        }

        let session = self
            .sessions
            .get_mut(thread_id)
            .ok_or_else(|| SessionError::NotAttached(thread_id.to_string()))?;
        if matches!(
            session.record.state,
            SessionState::Running | SessionState::Waiting | SessionState::Idle
        ) {
            return Ok(session.record.generation);
        }
        if session.record.state == SessionState::Reaped {
            session.record.state = SessionState::Resurrecting;
            let handle = session.record.resume_handle.clone();
            let generation = session.record.generation;
            if let Err(err) = spawn_once(session, handle) {
                if session.record.resume_handle.is_some() {
                    session.record.resume_handle = None;
                    spawn_once(session, None)?;
                } else {
                    return Err(err);
                }
            }
            session.record.last_active_at_ms = now_ms();
            return Ok(generation);
        }
        let generation = session.record.generation;
        spawn_once(session, None)?;
        session.record.last_active_at_ms = now_ms();
        Ok(generation)
    }

    /// Sends one turn. A persistent session receives only the new message.
    pub fn send_turn(
        &mut self,
        thread_id: &str,
        command_id: &str,
        prompt: &str,
    ) -> Result<SendReceipt, SessionError> {
        if prompt.trim().is_empty() {
            return Err(SessionError::EmptyPrompt);
        }
        if let Some(record) = self.commands.get(command_id) {
            if record.prompt != prompt {
                return Err(SessionError::CommandConflict(command_id.to_string()));
            }
            let mut receipt = record.receipt.clone();
            receipt.duplicate = true;
            return Ok(receipt);
        }

        let is_persistent_and_needs_spawn = self
            .sessions
            .get(thread_id)
            .map(|s| {
                s.record.mode == SessionMode::Persistent
                    && !matches!(
                        s.record.state,
                        SessionState::Running | SessionState::Waiting | SessionState::Idle
                    )
            })
            .unwrap_or(false);
        if is_persistent_and_needs_spawn {
            self.enforce_lru_capacity(DEFAULT_MAX_WARM_SESSIONS.saturating_sub(1));
        }

        let session = self
            .sessions
            .get_mut(thread_id)
            .ok_or_else(|| SessionError::NotAttached(thread_id.to_string()))?;

        let needs_new_command = session.record.mode == SessionMode::OneShot
            && matches!(
                session.record.state,
                SessionState::Completed | SessionState::Closed | SessionState::Interrupted
            );
        if needs_new_command {
            session.record.generation += 1;
            session.record.session_id =
                format!("{}:{}", session.record.thread_id, session.record.generation);
        }
        if !matches!(
            session.record.state,
            SessionState::Running | SessionState::Waiting
        ) {
            if session.record.state == SessionState::Reaped {
                session.record.state = SessionState::Resurrecting;
                let handle = session.record.resume_handle.clone();
                if let Err(_) = spawn_once(session, handle) {
                    session.record.resume_handle = None;
                    spawn_once(session, None)?;
                }
            } else {
                // A persistent process that already answered a turn still serves
                // the session: the next message is written onto it.
                let process_serves_the_thread = session.record.mode == SessionMode::Persistent
                    && matches!(session.record.state, SessionState::Completed | SessionState::Idle)
                    && session.transport.spawn_count() > 0;
                if !process_serves_the_thread {
                    spawn_once(session, None)?;
                }
            }
        }
        session
            .transport
            .write_turn(prompt)
            .map_err(SessionError::Transport)?;
        session.record.state = SessionState::Running;
        session.record.last_active_at_ms = now_ms();
        push_event(session, "turnAccepted", json!({ "commandId": command_id }));

        let receipt = SendReceipt {
            command_id: command_id.to_string(),
            thread_id: thread_id.to_string(),
            generation: session.record.generation,
            accepted: true,
            duplicate: false,
        };
        self.commands.insert(
            command_id.to_string(),
            CommandRecord {
                prompt: prompt.to_string(),
                receipt: receipt.clone(),
            },
        );
        Ok(receipt)
    }

    pub fn interrupt(&mut self, thread_id: &str) -> Result<(), SessionError> {
        let session = self
            .sessions
            .get_mut(thread_id)
            .ok_or_else(|| SessionError::NotAttached(thread_id.to_string()))?;
        session
            .transport
            .interrupt()
            .map_err(SessionError::Transport)?;
        session.record.state = SessionState::Interrupted;
        push_event(session, "interrupted", json!({}));
        Ok(())
    }

    pub fn respond_approval(
        &mut self,
        thread_id: &str,
        request_id: &str,
        decision: ApprovalDecision,
    ) -> Result<(), SessionError> {
        let session = self
            .sessions
            .get_mut(thread_id)
            .ok_or_else(|| SessionError::NotAttached(thread_id.to_string()))?;
        let Some(index) = session
            .record
            .pending_approvals
            .iter()
            .position(|id| id == request_id)
        else {
            return Err(SessionError::UnknownApproval(request_id.to_string()));
        };
        session.record.pending_approvals.remove(index);
        push_event(
            session,
            "approvalResolved",
            json!({ "requestId": request_id, "decision": decision.as_str() }),
        );
        if decision == ApprovalDecision::DenyAndStop {
            session.transport.stop().map_err(SessionError::Transport)?;
            session.record.state = SessionState::Interrupted;
            push_event(session, "stopped", json!({ "reason": "denyAndStop" }));
        } else if session.record.pending_approvals.is_empty() {
            session.record.state = SessionState::Running;
        }
        Ok(())
    }

    /// Writes one client frame to the process that owns this thread.
    pub fn write_frame(&mut self, thread_id: &str, frame: &str) -> Result<(), SessionError> {
        let session = self
            .sessions
            .get_mut(thread_id)
            .ok_or_else(|| SessionError::NotAttached(thread_id.to_string()))?;
        session
            .transport
            .write_frame(frame)
            .map_err(SessionError::Transport)
    }

    pub fn stop(&mut self, thread_id: &str) -> Result<(), SessionError> {
        let session = self
            .sessions
            .get_mut(thread_id)
            .ok_or_else(|| SessionError::NotAttached(thread_id.to_string()))?;
        session.transport.stop().map_err(SessionError::Transport)?;
        settle_approvals(session, "stopped");
        session.record.state = SessionState::Closed;
        push_event(session, "stopped", json!({}));
        Ok(())
    }

    pub fn poll(&mut self, thread_id: &str) -> Result<Vec<SessionEvent>, SessionError> {
        let session = self
            .sessions
            .get_mut(thread_id)
            .ok_or_else(|| SessionError::NotAttached(thread_id.to_string()))?;
        let from = session.record.next_sequence;
        let incoming = session.transport.drain();
        let mut exit = None;
        for event in incoming {
            match event {
                TransportEvent::Text(text) => {
                    push_event(session, "text", json!({ "text": text }));
                }
                TransportEvent::Notice(text) => {
                    push_event(session, "notice", json!({ "text": text }));
                }
                TransportEvent::Activity(line) => {
                    push_event(session, "activity", json!({ "line": line }));
                }
                TransportEvent::UnhandledRequest { id } => {
                    push_event(session, "unhandledRequest", json!({ "id": id }));
                }
                TransportEvent::ApprovalRequest { id, kind } => {
                    session.record.pending_approvals.push(id.clone());
                    session.record.state = SessionState::Waiting;
                    push_event(
                        session,
                        "approvalOpened",
                        json!({ "requestId": id, "kind": kind }),
                    );
                }
                TransportEvent::TurnEnded => {
                    if session.record.pending_approvals.is_empty() {
                        session.record.state = if session.record.mode == SessionMode::Persistent {
                            SessionState::Idle
                        } else {
                            SessionState::Completed
                        };
                    }
                    session.record.last_active_at_ms = now_ms();
                    if let Some(handle) = session.transport.resume_handle() {
                        if !handle.trim().is_empty() {
                            session.record.resume_handle = Some(handle);
                        }
                    }
                    push_event(session, "turnCompleted", json!({}));
                }
                TransportEvent::TurnFailed(reason) => {
                    // The process still serves the session, so the state is
                    // completed/idle rather than failed: only this turn failed.
                    settle_approvals(session, "turnFailed");
                    session.record.state = if session.record.mode == SessionMode::Persistent {
                        SessionState::Idle
                    } else {
                        SessionState::Completed
                    };
                    session.record.last_active_at_ms = now_ms();
                    if let Some(handle) = session.transport.resume_handle() {
                        if !handle.trim().is_empty() {
                            session.record.resume_handle = Some(handle);
                        }
                    }
                    push_event(session, "turnFailed", json!({ "reason": reason }));
                }
                TransportEvent::Exit { code, error } => {
                    exit = Some((code, error));
                }
            }
        }
        if let Some((code, error)) = exit {
            apply_exit(session, code, error);
        }
        Ok(session
            .events
            .iter()
            .filter(|event| event.sequence > from)
            .cloned()
            .collect())
    }

    /// Resumes only with a provider-issued handle. Never invents one.
    pub fn resume(&mut self, thread_id: &str) -> Result<(), SessionError> {
        let session = self
            .sessions
            .get_mut(thread_id)
            .ok_or_else(|| SessionError::NotAttached(thread_id.to_string()))?;
        if session.record.state != SessionState::Resumable || !session.record.can_resume() {
            return Err(SessionError::NotResumable(thread_id.to_string()));
        }
        let Some(handle) = session.record.resume_handle.clone() else {
            return Err(SessionError::NoResumeHandle(thread_id.to_string()));
        };
        session.record.generation += 1;
        session.record.session_id =
            format!("{}:{}", session.record.thread_id, session.record.generation);
        spawn_once(session, Some(handle))?;
        push_event(session, "resumed", json!({}));
        Ok(())
    }

}
