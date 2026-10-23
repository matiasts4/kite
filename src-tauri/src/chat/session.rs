//! Thread-owned provider sessions.
//!
//! The thread is the durable conversation. A session is the ephemeral process
//! that serves it. This module owns the contract only: it never spawns a real
//! provider. Driver adapters provide a [`SessionTransport`], and tests use the
//! deterministic [`ScriptedTransport`].

use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::chat::utils::now_ms;

/// How a driver keeps a session alive between turns.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionMode {
    /// One process stays open and receives the next message on it.
    Persistent,
    /// Each turn is a new process, continued through a provider handle.
    Resumable,
    /// Each turn is an independent command with no continuation.
    OneShot,
}

impl SessionMode {
    pub fn keeps_process(self) -> bool {
        matches!(self, SessionMode::Persistent)
    }

    pub fn accepts_another_turn(self) -> bool {
        !matches!(self, SessionMode::OneShot)
    }
}

/// Lifecycle state of one session. A thread is readable in every state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionState {
    /// The binding exists; no process has been started for it yet.
    Prepared,
    Starting,
    Running,
    /// Waiting for the user to answer an approval request.
    Waiting,
    Completed,
    Interrupted,
    Failed,
    /// A provider handle exists and the next turn may continue it.
    Resumable,
    /// No live session. The next turn starts a new one.
    Closed,
}

/// The recipe an agent thread starts with. It is copied before the process
/// starts and never read from the agent record again.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecipeSnapshot {
    pub agent_id: String,
    pub revision: String,
    pub role: String,
    pub memory: String,
    pub user: String,
    pub skills: Vec<String>,
}

/// What a thread asks for when it prepares a session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionSpec {
    pub thread_id: String,
    pub driver: String,
    pub connection_id: Option<String>,
    pub working_directory: Option<String>,
    pub mode: SessionMode,
    /// Present only for an agent thread. A loose chat starts from the CLI's
    /// own account and configuration.
    pub recipe: Option<RecipeSnapshot>,
}

/// Durable view of the session bound to one thread.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionRecord {
    pub thread_id: String,
    /// Internal identity of this generation. Never a provider handle.
    pub session_id: String,
    pub generation: u64,
    pub driver: String,
    pub connection_id: Option<String>,
    pub working_directory: Option<String>,
    pub mode: SessionMode,
    pub state: SessionState,
    pub recipe: Option<RecipeSnapshot>,
    /// Only ever set from a value the provider returned.
    pub resume_handle: Option<String>,
    pub started_at_ms: i64,
    pub next_sequence: u64,
    pub pending_approvals: Vec<String>,
}

impl SessionRecord {
    /// A provider handle is the only thing that makes a session continuable.
    pub fn can_resume(&self) -> bool {
        self.accepts_another_turn() && self.resume_handle.is_some()
    }

    fn accepts_another_turn(&self) -> bool {
        self.mode.accepts_another_turn()
    }
}

/// One ordered, durable projection of provider output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionEvent {
    pub sequence: u64,
    pub kind: String,
    pub payload: Value,
}

/// The approval vocabulary every adapter maps onto its driver.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalDecision {
    AllowOnce,
    AllowForSession,
    Deny,
    DenyAndStop,
}

impl ApprovalDecision {
    pub fn as_str(self) -> &'static str {
        match self {
            ApprovalDecision::AllowOnce => "allowOnce",
            ApprovalDecision::AllowForSession => "allowForSession",
            ApprovalDecision::Deny => "deny",
            ApprovalDecision::DenyAndStop => "denyAndStop",
        }
    }
}

/// The stable receipt of one thread command. Replaying the same id returns the
/// same receipt and never writes twice.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SendReceipt {
    pub command_id: String,
    pub thread_id: String,
    pub generation: u64,
    pub accepted: bool,
    pub duplicate: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AttachOutcome {
    Attached { generation: u64 },
    AlreadyAttached { generation: u64, state: SessionState },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionError {
    NotAttached(String),
    InvalidDriver,
    EmptyPrompt,
    /// The command id was already used with a different prompt.
    CommandConflict(String),
    NotResumable(String),
    NoResumeHandle(String),
    UnknownApproval(String),
    SpawnFailed(String),
    Transport(String),
}

impl fmt::Display for SessionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SessionError::NotAttached(thread) => {
                write!(formatter, "thread {thread} has no provider session")
            }
            SessionError::InvalidDriver => write!(formatter, "a session needs a driver"),
            SessionError::EmptyPrompt => write!(formatter, "a turn needs a message"),
            SessionError::CommandConflict(id) => {
                write!(formatter, "command {id} was already used with a different payload")
            }
            SessionError::NotResumable(thread) => {
                write!(formatter, "thread {thread} has no resumable session")
            }
            SessionError::NoResumeHandle(thread) => {
                write!(formatter, "thread {thread} has no provider-issued resume handle")
            }
            SessionError::UnknownApproval(id) => {
                write!(formatter, "approval request {id} is unknown or already settled")
            }
            SessionError::SpawnFailed(reason) => write!(formatter, "session failed to start: {reason}"),
            SessionError::Transport(reason) => write!(formatter, "session transport error: {reason}"),
        }
    }
}

impl std::error::Error for SessionError {}

/// What the transport is told exactly once, before its process starts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransportSpec {
    pub session_id: String,
    pub driver: String,
    pub working_directory: Option<String>,
    pub mode: SessionMode,
    /// Proof that the recipe was fixed before the spawn, not after it.
    pub recipe_revision: Option<String>,
    pub resume_handle: Option<String>,
}

/// Raw events a driver normalizes onto [`SessionEvent`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransportEvent {
    Text(String),
    Notice(String),
    ApprovalRequest { id: String, kind: String },
    Exit { code: Option<i32>, error: Option<String> },
}

/// One provider process, or the thing that will become one.
pub trait SessionTransport: fmt::Debug + Send {
    fn spawn(&mut self, spec: &TransportSpec) -> Result<(), String>;
    fn write_turn(&mut self, prompt: &str) -> Result<(), String>;
    fn interrupt(&mut self) -> Result<(), String>;
    fn stop(&mut self) -> Result<(), String>;
    fn spawn_count(&self) -> u32;
    fn resume_handle(&self) -> Option<String>;
    fn drain(&mut self) -> Vec<TransportEvent>;
}

#[derive(Debug, Default)]
struct ScriptedState {
    spawns: u32,
    specs: Vec<TransportSpec>,
    turns: Vec<String>,
    pending: Vec<TransportEvent>,
    resume_handle: Option<String>,
    fail_spawn: Option<String>,
}

/// Deterministic transport for tests. It records what it was asked to do and
/// replays a scripted event queue.
#[derive(Debug, Clone, Default)]
pub struct ScriptedTransport {
    state: Arc<Mutex<ScriptedState>>,
}

impl ScriptedTransport {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn script(&self, event: TransportEvent) {
        self.state.lock().unwrap().pending.push(event);
    }

    pub fn with_resume_handle(self, handle: &str) -> Self {
        self.state.lock().unwrap().resume_handle = Some(handle.to_string());
        self
    }

    pub fn failing_spawn(self, reason: &str) -> Self {
        self.state.lock().unwrap().fail_spawn = Some(reason.to_string());
        self
    }

    pub fn spawn_count(&self) -> u32 {
        self.state.lock().unwrap().spawns
    }

    pub fn spawned_specs(&self) -> Vec<TransportSpec> {
        self.state.lock().unwrap().specs.clone()
    }

    pub fn written_turns(&self) -> Vec<String> {
        self.state.lock().unwrap().turns.clone()
    }
}

impl SessionTransport for ScriptedTransport {
    fn spawn(&mut self, spec: &TransportSpec) -> Result<(), String> {
        let mut state = self.state.lock().unwrap();
        if let Some(reason) = state.fail_spawn.clone() {
            return Err(reason);
        }
        state.spawns += 1;
        state.specs.push(spec.clone());
        Ok(())
    }

    fn write_turn(&mut self, prompt: &str) -> Result<(), String> {
        self.state.lock().unwrap().turns.push(prompt.to_string());
        Ok(())
    }

    fn interrupt(&mut self) -> Result<(), String> {
        Ok(())
    }

    fn stop(&mut self) -> Result<(), String> {
        Ok(())
    }

    fn spawn_count(&self) -> u32 {
        self.state.lock().unwrap().spawns
    }

    fn resume_handle(&self) -> Option<String> {
        self.state.lock().unwrap().resume_handle.clone()
    }

    fn drain(&mut self) -> Vec<TransportEvent> {
        let mut state = self.state.lock().unwrap();
        std::mem::take(&mut state.pending)
    }
}

struct CommandRecord {
    prompt: String,
    receipt: SendReceipt,
}

struct ManagedSession {
    record: SessionRecord,
    transport: Box<dyn SessionTransport>,
    events: Vec<SessionEvent>,
}

/// Owns every live session. One thread has at most one session at a time.
#[derive(Default)]
pub struct SessionManager {
    sessions: HashMap<String, ManagedSession>,
    commands: HashMap<String, CommandRecord>,
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
        let record = SessionRecord {
            thread_id: spec.thread_id.clone(),
            session_id,
            generation,
            driver: spec.driver,
            connection_id: spec.connection_id,
            working_directory: spec.working_directory,
            mode: spec.mode,
            state: SessionState::Prepared,
            recipe: spec.recipe,
            resume_handle: None,
            started_at_ms: now_ms(),
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
        let session = self
            .sessions
            .get_mut(thread_id)
            .ok_or_else(|| SessionError::NotAttached(thread_id.to_string()))?;
        if matches!(
            session.record.state,
            SessionState::Running | SessionState::Waiting
        ) {
            return Ok(session.record.generation);
        }
        let generation = session.record.generation;
        spawn_once(session, None)?;
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
            spawn_once(session, None)?;
        }
        session
            .transport
            .write_turn(prompt)
            .map_err(SessionError::Transport)?;
        session.record.state = SessionState::Running;
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
                TransportEvent::ApprovalRequest { id, kind } => {
                    session.record.pending_approvals.push(id.clone());
                    session.record.state = SessionState::Waiting;
                    push_event(
                        session,
                        "approvalOpened",
                        json!({ "requestId": id, "kind": kind }),
                    );
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
}

fn spawn_once(session: &mut ManagedSession, resume_handle: Option<String>) -> Result<(), SessionError> {
    session.record.state = SessionState::Starting;
    let spec = TransportSpec {
        session_id: session.record.session_id.clone(),
        driver: session.record.driver.clone(),
        working_directory: session.record.working_directory.clone(),
        mode: session.record.mode,
        recipe_revision: session.record.recipe.as_ref().map(|recipe| recipe.revision.clone()),
        resume_handle,
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

fn apply_exit(session: &mut ManagedSession, code: Option<i32>, error: Option<String>) {
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

fn settle_approvals(session: &mut ManagedSession, reason: &str) {
    let pending: Vec<String> = session.record.pending_approvals.drain(..).collect();
    for request_id in pending {
        push_event(
            session,
            "approvalSettled",
            json!({ "requestId": request_id, "decision": "deny", "reason": reason }),
        );
    }
}

fn push_event(session: &mut ManagedSession, kind: &str, payload: Value) {
    session.record.next_sequence += 1;
    session.events.push(SessionEvent {
        sequence: session.record.next_sequence,
        kind: kind.to_string(),
        payload,
    });
}

fn state_name(state: SessionState) -> &'static str {
    match state {
        SessionState::Prepared => "prepared",
        SessionState::Starting => "starting",
        SessionState::Running => "running",
        SessionState::Waiting => "waiting",
        SessionState::Completed => "completed",
        SessionState::Interrupted => "interrupted",
        SessionState::Failed => "failed",
        SessionState::Resumable => "resumable",
        SessionState::Closed => "closed",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn recipe(revision: &str, role: &str) -> RecipeSnapshot {
        RecipeSnapshot {
            agent_id: "agent-1".to_string(),
            revision: revision.to_string(),
            role: role.to_string(),
            memory: "memory".to_string(),
            user: "user".to_string(),
            skills: vec!["root-cause".to_string()],
        }
    }

    fn spec(thread_id: &str, mode: SessionMode, recipe: Option<RecipeSnapshot>) -> SessionSpec {
        SessionSpec {
            thread_id: thread_id.to_string(),
            driver: "codex".to_string(),
            connection_id: Some("connection-1".to_string()),
            working_directory: Some("E:/kite".to_string()),
            mode,
            recipe,
        }
    }

    fn attach(
        manager: &mut SessionManager,
        spec: SessionSpec,
        transport: ScriptedTransport,
    ) -> ScriptedTransport {
        manager.attach(spec, Box::new(transport.clone())).unwrap();
        transport
    }

    #[test]
    fn attaching_a_thread_twice_keeps_one_session_and_starts_nothing() {
        let mut manager = SessionManager::new();
        let transport = attach(&mut manager, spec("thread-1", SessionMode::Persistent, None), ScriptedTransport::new());

        let second = manager
            .attach(spec("thread-1", SessionMode::Persistent, None), Box::new(ScriptedTransport::new()))
            .unwrap();

        assert_eq!(second, AttachOutcome::AlreadyAttached { generation: 1, state: SessionState::Prepared });
        assert_eq!(manager.active_thread_count(), 1);
        assert_eq!(transport.spawn_count(), 0);
    }

    #[test]
    fn start_spawns_one_process_per_thread() {
        let mut manager = SessionManager::new();
        let transport = attach(&mut manager, spec("thread-1", SessionMode::Persistent, None), ScriptedTransport::new());

        assert_eq!(manager.start("thread-1").unwrap(), 1);
        assert_eq!(manager.start("thread-1").unwrap(), 1);

        assert_eq!(transport.spawn_count(), 1);
        assert_eq!(manager.status("thread-1").unwrap().state, SessionState::Running);
    }

    #[test]
    fn two_threads_of_one_agent_are_two_sessions() {
        let mut manager = SessionManager::new();
        let first = attach(&mut manager, spec("thread-1", SessionMode::Persistent, Some(recipe("r1", "role"))), ScriptedTransport::new());
        let second = attach(&mut manager, spec("thread-2", SessionMode::Persistent, Some(recipe("r1", "role"))), ScriptedTransport::new());

        manager.start("thread-1").unwrap();
        manager.start("thread-2").unwrap();

        assert_eq!(first.spawn_count(), 1);
        assert_eq!(second.spawn_count(), 1);
        assert_eq!(manager.active_thread_count(), 2);
        assert_ne!(
            first.spawned_specs()[0].session_id,
            second.spawned_specs()[0].session_id
        );
    }

    #[test]
    fn the_recipe_is_fixed_before_the_process_starts() {
        let mut manager = SessionManager::new();
        let mut source = recipe("r1", "original role");
        let transport = attach(&mut manager, spec("thread-1", SessionMode::Persistent, Some(source.clone())), ScriptedTransport::new());

        source.role = "edited later".to_string();
        manager.start("thread-1").unwrap();

        assert_eq!(transport.spawned_specs()[0].recipe_revision.as_deref(), Some("r1"));
        assert_eq!(
            manager.status("thread-1").unwrap().recipe.unwrap().role,
            "original role"
        );
    }

    #[test]
    fn a_later_turn_sends_only_the_new_message() {
        let mut manager = SessionManager::new();
        let transport = attach(&mut manager, spec("thread-1", SessionMode::Persistent, Some(recipe("r1", "role"))), ScriptedTransport::new());

        manager.start("thread-1").unwrap();
        manager.send_turn("thread-1", "command-1", "first").unwrap();
        manager.send_turn("thread-1", "command-2", "second").unwrap();

        assert_eq!(transport.written_turns(), vec!["first".to_string(), "second".to_string()]);
        assert_eq!(transport.spawn_count(), 1);
    }

    #[test]
    fn replaying_a_command_returns_the_same_receipt_without_writing_again() {
        let mut manager = SessionManager::new();
        let transport = attach(&mut manager, spec("thread-1", SessionMode::Persistent, None), ScriptedTransport::new());
        manager.start("thread-1").unwrap();

        let first = manager.send_turn("thread-1", "command-1", "hello").unwrap();
        let replay = manager.send_turn("thread-1", "command-1", "hello").unwrap();

        assert!(!first.duplicate);
        assert!(replay.duplicate);
        assert_eq!(first.command_id, replay.command_id);
        assert_eq!(transport.written_turns(), vec!["hello".to_string()]);
    }

    #[test]
    fn reusing_a_command_id_with_another_payload_is_rejected() {
        let mut manager = SessionManager::new();
        attach(&mut manager, spec("thread-1", SessionMode::Persistent, None), ScriptedTransport::new());
        manager.start("thread-1").unwrap();
        manager.send_turn("thread-1", "command-1", "hello").unwrap();

        let error = manager.send_turn("thread-1", "command-1", "other").unwrap_err();

        assert_eq!(error, SessionError::CommandConflict("command-1".to_string()));
    }

    #[test]
    fn events_carry_a_monotonic_sequence() {
        let mut manager = SessionManager::new();
        let transport = attach(&mut manager, spec("thread-1", SessionMode::Persistent, None), ScriptedTransport::new());
        manager.start("thread-1").unwrap();
        transport.script(TransportEvent::Text("hi".to_string()));
        transport.script(TransportEvent::Notice("note".to_string()));

        manager.poll("thread-1").unwrap();

        let events = manager.events_since("thread-1", 0);
        let sequences: Vec<u64> = events.iter().map(|event| event.sequence).collect();
        assert_eq!(sequences, vec![1, 2, 3]);
        assert_eq!(manager.events_since("thread-1", 2).len(), 1);
    }

    #[test]
    fn an_unknown_approval_does_not_mutate_the_session() {
        let mut manager = SessionManager::new();
        let transport = attach(&mut manager, spec("thread-1", SessionMode::Persistent, None), ScriptedTransport::new());
        manager.start("thread-1").unwrap();
        transport.script(TransportEvent::ApprovalRequest {
            id: "approval-1".to_string(),
            kind: "command".to_string(),
        });
        manager.poll("thread-1").unwrap();

        let error = manager
            .respond_approval("thread-1", "approval-unknown", ApprovalDecision::AllowOnce)
            .unwrap_err();

        assert_eq!(error, SessionError::UnknownApproval("approval-unknown".to_string()));
        let record = manager.status("thread-1").unwrap();
        assert_eq!(record.state, SessionState::Waiting);
        assert_eq!(record.pending_approvals, vec!["approval-1".to_string()]);
    }

    #[test]
    fn a_provider_exit_settles_pending_approvals_and_fails_the_turn() {
        let mut manager = SessionManager::new();
        let transport = attach(&mut manager, spec("thread-1", SessionMode::Persistent, None), ScriptedTransport::new());
        manager.start("thread-1").unwrap();
        transport.script(TransportEvent::ApprovalRequest {
            id: "approval-1".to_string(),
            kind: "command".to_string(),
        });
        manager.poll("thread-1").unwrap();

        manager.handle_exit("thread-1", Some(1), Some("boom".to_string())).unwrap();

        let record = manager.status("thread-1").unwrap();
        assert_eq!(record.state, SessionState::Failed);
        assert!(record.pending_approvals.is_empty());
        assert!(manager
            .events_since("thread-1", 0)
            .iter()
            .any(|event| event.kind == "approvalSettled"));
    }

    #[test]
    fn a_resumable_session_continues_only_with_a_provider_handle() {
        let mut manager = SessionManager::new();
        let transport = attach(
            &mut manager,
            spec("thread-1", SessionMode::Resumable, None),
            ScriptedTransport::new().with_resume_handle("provider-handle-1"),
        );
        manager.start("thread-1").unwrap();
        manager.handle_exit("thread-1", Some(0), None).unwrap();

        let record = manager.status("thread-1").unwrap();
        assert_eq!(record.state, SessionState::Resumable);
        assert_eq!(record.resume_handle.as_deref(), Some("provider-handle-1"));

        manager.resume("thread-1").unwrap();
        let specs = transport.spawned_specs();
        assert_eq!(specs.len(), 2);
        assert_eq!(specs[1].resume_handle.as_deref(), Some("provider-handle-1"));
    }

    #[test]
    fn a_one_shot_session_starts_a_new_command_per_send() {
        let mut manager = SessionManager::new();
        let transport = attach(&mut manager, spec("thread-1", SessionMode::OneShot, None), ScriptedTransport::new());
        manager.start("thread-1").unwrap();
        manager.handle_exit("thread-1", Some(0), None).unwrap();

        manager.send_turn("thread-1", "command-2", "next").unwrap();

        let record = manager.status("thread-1").unwrap();
        assert_eq!(record.state, SessionState::Running);
        assert_eq!(record.generation, 2);
        assert_eq!(transport.spawn_count(), 2);
        assert_eq!(transport.written_turns(), vec!["next".to_string()]);
    }
}
