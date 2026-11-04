//! Receipt and error contract for Dispatch. schemaVersion 1.

use serde::Serialize;

pub const SCHEMA_VERSION: u32 = 1;
pub const BODY_LIMIT: usize = 8000;
pub const QUEUE_DEPTH: usize = 8;
pub const STALL_MS: u64 = 5_000;
pub const DEFAULT_READ_LINES: usize = 80;
pub const NOTICE_TAIL_LINES: usize = 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Family {
    Terminal,
    Thread,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Caller {
    Human,
    Agent,
    Script,
}

impl Caller {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "human" => Some(Self::Human),
            "agent" => Some(Self::Agent),
            "script" => Some(Self::Script),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ReceiptStatus {
    Queued,
    Submitted,
    Rejected,
    Settled,
    Failed,
    Stalled,
}

/// Whether a run's pane became visible. Omitted on every other operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PaneVisibility {
    Shown,
    Hidden,
    /// An open event was sent. `run` does not wait for the desktop to confirm it.
    Pending,
    NotShown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DispatchError {
    UnknownAddress,
    NameTaken,
    NoLiveEndpoint,
    RuntimeOffline,
    DestinationBlocked,
    DestinationGone,
    NotReady,
    QueueFull,
    BodyTooLarge,
    ForceForbidden,
    MessagingDisabled,
    PathRejected,
    RoleNotFound,
    ProgramNotFound,
    Stalled,
    Timeout,
    ParentMissing,
    TransportUnsupported,
    BadArgs,
}

impl DispatchError {
    pub fn code(self) -> &'static str {
        match self {
            Self::UnknownAddress => "unknown_address",
            Self::NameTaken => "name_taken",
            Self::NoLiveEndpoint => "no_live_endpoint",
            Self::RuntimeOffline => "runtime_offline",
            Self::DestinationBlocked => "destination_blocked",
            Self::DestinationGone => "destination_gone",
            Self::NotReady => "not_ready",
            Self::QueueFull => "queue_full",
            Self::BodyTooLarge => "body_too_large",
            Self::ForceForbidden => "force_forbidden",
            Self::MessagingDisabled => "messaging_disabled",
            Self::PathRejected => "path_rejected",
            Self::RoleNotFound => "role_not_found",
            Self::ProgramNotFound => "program_not_found",
            Self::Stalled => "stalled",
            Self::Timeout => "timeout",
            Self::ParentMissing => "parent_missing",
            Self::TransportUnsupported => "transport_unsupported",
            Self::BadArgs => "bad_args",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub schema_version: u32,
    pub id: String,
    pub op: String,
    pub status: ReceiptStatus,
    pub address: String,
    pub submitted: bool,
    #[serde(rename = "presenceAtSubmit")]
    pub presence_at_submit: Option<String>,
    pub error: Option<String>,
    /// Present for `read` and `ls`. Absent on send receipts so they match the contract example.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// True when this call returned a receipt that was already stored. Not part of the wire example.
    #[serde(skip_serializing_if = "is_false", default)]
    pub replayed: bool,
    /// Present on `run`. Absent otherwise so older receipts stay unchanged.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane: Option<PaneVisibility>,
}

fn is_false(value: &bool) -> bool {
    !*value
}

impl Receipt {
    pub fn new(
        id: impl Into<String>,
        op: impl Into<String>,
        status: ReceiptStatus,
        address: impl Into<String>,
        submitted: bool,
        presence: Option<String>,
        error: Option<String>,
    ) -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            id: id.into(),
            op: op.into(),
            status,
            address: address.into(),
            submitted,
            presence_at_submit: presence,
            error,
            text: None,
            replayed: false,
            pane: None,
        }
    }
}

pub fn exit_code(receipt: &Receipt) -> i32 {
    match receipt.status {
        ReceiptStatus::Queued | ReceiptStatus::Submitted | ReceiptStatus::Settled => 0,
        ReceiptStatus::Rejected | ReceiptStatus::Stalled | ReceiptStatus::Failed => 1,
    }
}
