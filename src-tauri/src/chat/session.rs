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

use crate::chat::drivers::DriverDeclaration;
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

    pub fn as_str(self) -> &'static str {
        match self {
            SessionMode::Persistent => "persistent",
            SessionMode::Resumable => "resumable",
            SessionMode::OneShot => "one_shot",
        }
    }
}

/// Lifecycle state of one session. A thread is readable in every state.
pub const DEFAULT_MAX_WARM_SESSIONS: usize = 3;
pub const DEFAULT_IDLE_TIMEOUT_MS: i64 = 30 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionState {
    /// The binding exists; no process has been started for it yet.
    Prepared,
    Starting,
    Running,
    /// Waiting for the user to answer an approval request.
    Waiting,
    /// Warm process idle and waiting for the next turn.
    Idle,
    Completed,
    Interrupted,
    Failed,
    /// A provider handle exists and the next turn may continue it.
    Resumable,
    /// Process terminated by eviction reaper; resume handle retained.
    Reaped,
    /// Resurrecting from reaped state using provider resume handle.
    Resurrecting,
    /// No live session. The next turn starts a new one.
    Closed,
}

impl SessionState {
    pub fn as_str(self) -> &'static str {
        match self {
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
    pub resume_handle: Option<String>,
}

impl SessionSpec {
    /// Chooses the mode from the driver declaration instead of copying it
    /// from a driver id. A persistent declaration is honored only with the
    /// explicit opt-in; every other case keeps one command per turn.
    pub fn with_declared_mode(
        mut self,
        declaration: &DriverDeclaration,
        persistent_enabled: bool,
    ) -> Self {
        self.mode = declared_session_mode(declaration, persistent_enabled);
        self
    }

    pub fn with_resume_handle(mut self, resume_handle: Option<String>) -> Self {
        self.resume_handle = resume_handle;
        self
    }
}

/// The contract mode a declaration allows in this build.
///
/// `OneShot` here means today's one-command path, not a claim about the
/// driver: a resumable declaration has no provider handle wired yet, and an
/// unobserved driver is never classified as persistent.
pub fn declared_session_mode(
    declaration: &DriverDeclaration,
    persistent_enabled: bool,
) -> SessionMode {
    match declaration.session_mode {
        Some(SessionMode::Persistent) if persistent_enabled => SessionMode::Persistent,
        _ => SessionMode::OneShot,
    }
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
    pub last_active_at_ms: i64,
    pub next_sequence: u64,
    pub pending_approvals: Vec<String>,
}

impl SessionRecord {
    /// A provider handle is the only thing that makes a session continuable.
    pub fn can_resume(&self) -> bool {
        self.accepts_another_turn() && self.resume_handle.is_some()
    }

    pub fn is_warm(&self) -> bool {
        matches!(
            self.state,
            SessionState::Running | SessionState::Waiting | SessionState::Idle
        )
    }

    pub fn is_idle(&self) -> bool {
        self.state == SessionState::Idle
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
    /// A provider frame the transcript already knows how to draw as an action.
    /// The raw line is kept so the existing row builder can read it.
    Activity(String),
    /// A JSON-RPC request this build does not handle. It still has an id, so
    /// the session must answer or the provider waits forever.
    UnhandledRequest { id: String },
    ApprovalRequest { id: String, kind: String },
    /// The provider finished answering this turn but the process still serves
    /// the session. A later turn writes onto the same process.
    TurnEnded,
    /// The provider reported that this turn failed while its process still
    /// serves the session. The next turn may still be written to it.
    TurnFailed(String),
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
    /// A client frame for the process that already owns the session.
    /// One-shot runs keep their own stdin; a lasting session must use this.
    fn write_frame(&mut self, _frame: &str) -> Result<(), String> {
        Err("this session has no client frame channel".to_string())
    }
}

#[derive(Debug, Default)]
struct ScriptedState {
    spawns: u32,
    stops: u32,
    specs: Vec<TransportSpec>,
    turns: Vec<String>,
    frames: Vec<String>,
    pending: Vec<TransportEvent>,
    resume_handle: Option<String>,
    fail_spawn: Option<String>,
    fail_write: Option<String>,
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

    pub fn written_frames(&self) -> Vec<String> {
        self.state.lock().unwrap().frames.clone()
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

    /// Accepted the process but refused the turn. Reproduces a provider that
    /// started and then rejected the message.
    pub fn failing_write(self, reason: &str) -> Self {
        self.state.lock().unwrap().fail_write = Some(reason.to_string());
        self
    }

    pub fn spawn_count(&self) -> u32 {
        self.state.lock().unwrap().spawns
    }

    pub fn stop_count(&self) -> u32 {
        self.state.lock().unwrap().stops
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
        let mut state = self.state.lock().unwrap();
        if let Some(reason) = state.fail_write.clone() {
            return Err(reason);
        }
        state.turns.push(prompt.to_string());
        Ok(())
    }

    fn interrupt(&mut self) -> Result<(), String> {
        Ok(())
    }

    fn stop(&mut self) -> Result<(), String> {
        self.state.lock().unwrap().stops += 1;
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

    fn write_frame(&mut self, frame: &str) -> Result<(), String> {
        self.state.lock().unwrap().frames.push(frame.to_string());
        Ok(())
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
#[path = "session_tests.rs"]
mod tests;
