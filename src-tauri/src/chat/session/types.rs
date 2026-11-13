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
    pub extra_env: Vec<(String, String)>,
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

    pub fn with_extra_env(mut self, extra_env: Vec<(String, String)>) -> Self {
        self.extra_env = extra_env;
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
    pub extra_env: Vec<(String, String)>,
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
    pub extra_env: Vec<(String, String)>,
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
