//! Durable thread event log, receipts, replay, and fold.
//!
//! The thread JSON remains the durable conversation. This module records the
//! ordered events that produced it, so the same thread can be rebuilt without a
//! live provider process. Entries are append-only and carry `sequence`, `kind`,
//! `payload`, and `at_ms`. The sequence is the order: it is strictly
//! contiguous, so replay never depends on a clock. `at_ms` records when the
//! entry was appended. Folding the log over a thread is deterministic: the base
//! thread is copied, and every entry is applied in sequence order. Folding
//! twice, or folding after a reload, produces the same thread.
//!
//! Kinds and payloads:
//!
//! | kind | payload | projection |
//! | --- | --- | --- |
//! | `snapshot` | `{ "thread": <thread> }` | replaces the working thread |
//! | `field` | `{ "name": <string>, "value": <any> }` | sets one top-level field |
//! | `item.upsert` | `{ "item": <chat item> }` | upserts the item by id |
//! | `item.remove` | `{ "id": <string> }` | removes the item by id |
//! | `approval.opened` | `{ "approval": <approval> }` | sets `pendingApproval` and `waiting` |
//! | `approval.resolved` | `{ "requestId": <string>, "decision": <decision> }` | settles that request |
//! | `lifecycle` | `{ "state": <session state>, ... }` | sets `status` and settles on exit |
//!
//! `id` and `items` are not settable through a `field` event; the id never
//! changes and items go through the item events so the existing upsert rule is
//! the single writer. An approval event is keyed by `requestId`, and the fold
//! matches it against `pendingApproval.id`, which is the value existing readers
//! already use.
//!
//! Persistence follows [`crate::persist`]: the store lives under the same
//! application-data root, is a single JSON document per thread, and carries a
//! schema version. A save writes a temporary sibling and renames it over the
//! target, so a failed save leaves the previous store readable. A load and a
//! migration never write: a corrupt file, an unsupported version, or a failed
//! migration leaves the bytes on disk exactly as they were.

use std::collections::HashSet;
use std::fmt;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::chat::threads::upsert_item;
use crate::chat::utils::now_ms;
use crate::persist::roaming_app_dir;

/// Version of the on-disk document written by [`ThreadEventLog::save`].
pub const EVENT_LOG_SCHEMA_VERSION: u32 = 1;

/// How many recent entries a log keeps before it compacts itself.
pub const DEFAULT_COMPACTION_LIMIT: usize = 512;

/// Directory under the application-data root that holds the thread logs.
pub const EVENT_LOG_DIRECTORY: &str = "thread-events";

/// The session states a `lifecycle` event may carry.
pub const LIFECYCLE_STATES: [&str; 9] = [
    "prepared",
    "starting",
    "running",
    "waiting",
    "completed",
    "interrupted",
    "failed",
    "resumable",
    "closed",
];

/// The approval vocabulary an `approval.resolved` event may carry.
pub const APPROVAL_DECISIONS: [&str; 4] = ["allowOnce", "allowForSession", "deny", "denyAndStop"];

/// One durable event of a thread.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadEvent {
    pub sequence: u64,
    pub kind: String,
    pub payload: Value,
    pub at_ms: i64,
}

/// The stable receipt of one thread command.
///
/// `duplicate` describes the call that produced this value, not the stored
/// receipt: replaying a command id returns the same `sequence` with
/// `duplicate = true` and appends nothing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandReceipt {
    pub command_id: String,
    pub thread_id: String,
    pub sequence: u64,
    pub kind: String,
    pub duplicate: bool,
}

/// The kinds this version knows how to fold.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ThreadEventKind {
    Snapshot,
    Field,
    ItemUpsert,
    ItemRemove,
    ApprovalOpened,
    ApprovalResolved,
    Lifecycle,
}

impl ThreadEventKind {
    pub const ALL: [ThreadEventKind; 7] = [
        ThreadEventKind::Snapshot,
        ThreadEventKind::Field,
        ThreadEventKind::ItemUpsert,
        ThreadEventKind::ItemRemove,
        ThreadEventKind::ApprovalOpened,
        ThreadEventKind::ApprovalResolved,
        ThreadEventKind::Lifecycle,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            ThreadEventKind::Snapshot => "snapshot",
            ThreadEventKind::Field => "field",
            ThreadEventKind::ItemUpsert => "item.upsert",
            ThreadEventKind::ItemRemove => "item.remove",
            ThreadEventKind::ApprovalOpened => "approval.opened",
            ThreadEventKind::ApprovalResolved => "approval.resolved",
            ThreadEventKind::Lifecycle => "lifecycle",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.as_str() == raw)
    }
}

impl fmt::Display for ThreadEventKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Why a log operation was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EventLogError {
    /// The log has no thread id, so it has no durable location.
    EmptyThreadId,
    /// The command id was empty.
    InvalidCommandId,
    /// An entry, field, item, approval, decision, or state was malformed.
    InvalidPayload(String),
    /// The sequence was already used.
    DuplicateSequence(u64),
    /// The sequence skipped a value.
    Gap { expected: u64, found: u64 },
    /// The command id was already used with a different payload.
    CommandConflict(String),
    /// Compaction needs a snapshot to fold from.
    MissingBase,
    /// Compaction keeps at least one entry.
    InvalidCompactionLimit,
    /// The event or the store names another thread.
    ThreadMismatch { expected: String, found: String },
    /// The store was written by a newer schema version.
    UnsupportedVersion(u64),
    /// The stored document could not be read.
    Corrupt(String),
    /// A legacy store could not be converted.
    Migration(String),
    /// The filesystem refused the read or the write.
    Io(String),
}

impl fmt::Display for EventLogError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EventLogError::EmptyThreadId => write!(formatter, "a thread event log needs a thread id"),
            EventLogError::InvalidCommandId => write!(formatter, "a command needs a stable id"),
            EventLogError::InvalidPayload(reason) => write!(formatter, "invalid event payload: {reason}"),
            EventLogError::DuplicateSequence(sequence) => {
                write!(formatter, "sequence {sequence} was already used")
            }
            EventLogError::Gap { expected, found } => {
                write!(formatter, "sequence {found} skips the expected sequence {expected}")
            }
            EventLogError::CommandConflict(command) => {
                write!(formatter, "command {command} was already used with a different payload")
            }
            EventLogError::MissingBase => {
                write!(formatter, "compaction needs a snapshot to fold from")
            }
            EventLogError::InvalidCompactionLimit => {
                write!(formatter, "compaction keeps at least one entry")
            }
            EventLogError::ThreadMismatch { expected, found } => {
                write!(formatter, "the store belongs to thread {found}, not {expected}")
            }
            EventLogError::UnsupportedVersion(version) => {
                write!(formatter, "the store uses unsupported schema version {version}")
            }
            EventLogError::Corrupt(reason) => write!(formatter, "the store is corrupt: {reason}"),
            EventLogError::Migration(reason) => write!(formatter, "the store migration failed: {reason}"),
            EventLogError::Io(reason) => write!(formatter, "the store could not be read or written: {reason}"),
        }
    }
}

impl std::error::Error for EventLogError {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredReceipt {
    command_id: String,
    sequence: u64,
    kind: String,
    payload_digest: String,
    at_ms: i64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredLog {
    schema_version: u32,
    thread_id: String,
    last_sequence: u64,
    entries: Vec<ThreadEvent>,
    #[serde(default)]
    receipts: Vec<StoredReceipt>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredLogView<'a> {
    schema_version: u32,
    thread_id: &'a str,
    last_sequence: u64,
    entries: &'a [ThreadEvent],
    receipts: &'a [StoredReceipt],
}

/// The append-only log of one thread.
///
/// `new` starts an empty log that folds over whatever base the caller supplies.
/// `from_thread` records the base snapshot, which makes the log self-contained
/// and lets it compact. A loaded log always has its base when it was saved with
/// one.
#[derive(Debug, Clone)]
pub struct ThreadEventLog {
    thread_id: String,
    entries: Vec<ThreadEvent>,
    receipts: Vec<StoredReceipt>,
    last_sequence: u64,
    compaction_limit: usize,
}

impl ThreadEventLog {
    /// An empty log for `thread_id`. Nothing is recorded until `from_thread` or
    /// `append` is called.
    pub fn new(thread_id: &str) -> Self {
        Self {
            thread_id: thread_id.to_string(),
            entries: Vec::new(),
            receipts: Vec::new(),
            last_sequence: 0,
            compaction_limit: DEFAULT_COMPACTION_LIMIT,
        }
    }

    /// A log whose first entry is the thread as it exists now.
    pub fn from_thread(thread: &Value) -> Result<Self, EventLogError> {
        let thread_id = thread
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| EventLogError::InvalidPayload("a thread needs a non-empty id".to_string()))?;
        let mut log = Self::new(thread_id);
        log.append(ThreadEventKind::Snapshot, json!({ "thread": thread }))?;
        Ok(log)
    }

    /// Sets how many recent entries survive before the log compacts itself.
    /// `0` disables automatic compaction.
    pub fn with_compaction_limit(mut self, limit: usize) -> Self {
        self.compaction_limit = limit;
        self
    }

    pub fn thread_id(&self) -> &str {
        &self.thread_id
    }

    pub fn last_sequence(&self) -> u64 {
        self.last_sequence
    }

    pub fn entries(&self) -> &[ThreadEvent] {
        &self.entries
    }

    /// Appends at the next sequence.
    pub fn append(
        &mut self,
        kind: ThreadEventKind,
        payload: Value,
    ) -> Result<ThreadEvent, EventLogError> {
        let sequence = self.last_sequence.saturating_add(1);
        self.append_at(sequence, kind, payload)
    }

    /// Appends at `sequence`. The value must be the next one: a used sequence is
    /// a duplicate and a later one is a gap, and neither is accepted.
    pub fn append_at(
        &mut self,
        sequence: u64,
        kind: ThreadEventKind,
        payload: Value,
    ) -> Result<ThreadEvent, EventLogError> {
        if sequence == 0 {
            return Err(EventLogError::InvalidPayload(
                "event sequences start at 1".to_string(),
            ));
        }
        let expected = self.last_sequence.saturating_add(1);
        if sequence < expected {
            return Err(EventLogError::DuplicateSequence(sequence));
        }
        if sequence > expected {
            return Err(EventLogError::Gap {
                expected,
                found: sequence,
            });
        }
        validate_payload(kind, &payload).map_err(EventLogError::InvalidPayload)?;
        if kind == ThreadEventKind::Snapshot && !self.thread_id.is_empty() {
            let found = payload
                .get("thread")
                .and_then(|thread| thread.get("id"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if found != self.thread_id {
                return Err(EventLogError::ThreadMismatch {
                    expected: self.thread_id.clone(),
                    found: found.to_string(),
                });
            }
        }
        let event = ThreadEvent {
            sequence,
            kind: kind.as_str().to_string(),
            payload,
            at_ms: now_ms(),
        };
        self.entries.push(event.clone());
        self.last_sequence = sequence;
        self.compact_if_needed();
        Ok(event)
    }

    /// Appends one command event, once. Replaying the same command id with the
    /// same payload returns the stored receipt with `duplicate = true` and
    /// changes nothing. Reusing the id with another payload is refused.
    pub fn append_command(
        &mut self,
        kind: ThreadEventKind,
        command_id: &str,
        payload: Value,
    ) -> Result<CommandReceipt, EventLogError> {
        if command_id.trim().is_empty() {
            return Err(EventLogError::InvalidCommandId);
        }
        let digest = payload_digest(kind, &payload);
        if let Some(existing) = self
            .receipts
            .iter()
            .find(|receipt| receipt.command_id == command_id)
        {
            if existing.payload_digest != digest {
                return Err(EventLogError::CommandConflict(command_id.to_string()));
            }
            return Ok(CommandReceipt {
                command_id: command_id.to_string(),
                thread_id: self.thread_id.clone(),
                sequence: existing.sequence,
                kind: existing.kind.clone(),
                duplicate: true,
            });
        }
        let event = self.append(kind, payload)?;
        self.receipts.push(StoredReceipt {
            command_id: command_id.to_string(),
            sequence: event.sequence,
            kind: event.kind.clone(),
            payload_digest: digest,
            at_ms: event.at_ms,
        });
        Ok(CommandReceipt {
            command_id: command_id.to_string(),
            thread_id: self.thread_id.clone(),
            sequence: event.sequence,
            kind: event.kind,
            duplicate: false,
        })
    }

    /// The stored receipt of a command, without replaying it.
    pub fn receipt(&self, command_id: &str) -> Option<CommandReceipt> {
        self.receipts
            .iter()
            .find(|receipt| receipt.command_id == command_id)
            .map(|receipt| CommandReceipt {
                command_id: receipt.command_id.clone(),
                thread_id: self.thread_id.clone(),
                sequence: receipt.sequence,
                kind: receipt.kind.clone(),
                duplicate: false,
            })
    }

    /// The retained entries after `sequence`. A compacted log starts at its
    /// snapshot, so an older cursor receives that snapshot first.
    pub fn since(&self, sequence: u64) -> Vec<ThreadEvent> {
        self.entries
            .iter()
            .filter(|entry| entry.sequence > sequence)
            .cloned()
            .collect()
    }

    /// Applies this log over `thread`. A non-object base folds from an empty
    /// object. Deterministic: no clock, no counter, no agent record is read.
    pub fn fold(&self, thread: &Value) -> Value {
        fold_entries(&self.entries, thread)
    }

    /// The thread as today's readers expect it, folded from the log alone.
    ///
    /// A log that starts with a snapshot carries the full thread shape; an
    /// empty log projects the base it was given, which is `{}`.
    pub fn compatibility_projection(&self) -> Value {
        self.fold(&Value::Object(serde_json::Map::new()))
    }

    /// Folds the oldest entries into one snapshot and keeps at most
    /// `max_entries` recent entries. The folded result is unchanged, the last
    /// sequence is unchanged, and receipts keep pointing at their commands.
    pub fn compact(&mut self, max_entries: usize) -> Result<(), EventLogError> {
        if max_entries == 0 {
            return Err(EventLogError::InvalidCompactionLimit);
        }
        if self.entries.len() <= max_entries.saturating_add(1) {
            return Ok(());
        }
        if !self.has_snapshot() {
            return Err(EventLogError::MissingBase);
        }
        let split = self.entries.len() - max_entries;
        let frontier = self.entries[split - 1].sequence;
        let at_ms = self.entries[split - 1].at_ms;
        let folded = fold_entries(&self.entries[..split], &Value::Object(serde_json::Map::new()));
        let snapshot = ThreadEvent {
            sequence: frontier,
            kind: ThreadEventKind::Snapshot.as_str().to_string(),
            payload: json!({ "thread": folded }),
            at_ms,
        };
        let mut retained = Vec::with_capacity(max_entries + 1);
        retained.push(snapshot);
        retained.extend_from_slice(&self.entries[split..]);
        self.entries = retained;
        Ok(())
    }

    /// Writes the store under the application-data root of [`crate::persist`].
    pub fn save(&self) -> Result<(), EventLogError> {
        if self.thread_id.trim().is_empty() {
            return Err(EventLogError::EmptyThreadId);
        }
        self.save_to(&Self::default_path(&self.thread_id))
    }

    /// Writes the store to `path` through a temporary sibling and a rename.
    /// A failed write leaves the previous store readable; a temporary sibling
    /// may remain next to it and is replaced by the next successful save.
    pub fn save_to(&self, path: &Path) -> Result<(), EventLogError> {
        if let Some(parent) = path.parent().filter(|parent| !parent.as_os_str().is_empty()) {
            fs::create_dir_all(parent).map_err(|error| EventLogError::Io(error.to_string()))?;
        }
        let body = serde_json::to_string(&StoredLogView {
            schema_version: EVENT_LOG_SCHEMA_VERSION,
            thread_id: &self.thread_id,
            last_sequence: self.last_sequence,
            entries: &self.entries,
            receipts: &self.receipts,
        })
        .map_err(|error| EventLogError::Io(error.to_string()))?;
        write_atomically(path, &body)
    }

    /// Reads the store for `thread_id` from `path`. A missing file is an empty
    /// log. A corrupt, unsupported, or unmigratable file is an error, and the
    /// file is left exactly as it was.
    pub fn load(thread_id: &str, path: &Path) -> Result<Self, EventLogError> {
        let text = match fs::read_to_string(path) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Self::new(thread_id))
            }
            Err(error) => return Err(EventLogError::Io(error.to_string())),
        };
        let value: Value = serde_json::from_str(&text)
            .map_err(|error| EventLogError::Corrupt(error.to_string()))?;
        let value = migrate_store(value)?;
        let stored: StoredLog = serde_json::from_value(value)
            .map_err(|error| EventLogError::Corrupt(error.to_string()))?;
        if !stored.thread_id.is_empty() && stored.thread_id != thread_id {
            return Err(EventLogError::ThreadMismatch {
                expected: thread_id.to_string(),
                found: stored.thread_id,
            });
        }
        validate_stored(&stored)?;
        Ok(Self {
            thread_id: thread_id.to_string(),
            entries: stored.entries,
            receipts: stored.receipts,
            last_sequence: stored.last_sequence,
            compaction_limit: DEFAULT_COMPACTION_LIMIT,
        })
    }

    /// Reads the store from the application-data root.
    pub fn load_default(thread_id: &str) -> Result<Self, EventLogError> {
        Self::load(thread_id, &Self::default_path(thread_id))
    }

    /// The durable location of one thread's log.
    pub fn default_path(thread_id: &str) -> PathBuf {
        let mut name = String::with_capacity(thread_id.len() * 2 + 5);
        for byte in thread_id.as_bytes() {
            name.push_str(&format!("{byte:02x}"));
        }
        name.push_str(".json");
        roaming_app_dir().join(EVENT_LOG_DIRECTORY).join(name)
    }

    fn has_snapshot(&self) -> bool {
        self.entries
            .first()
            .map(|entry| entry.kind == ThreadEventKind::Snapshot.as_str())
            .unwrap_or(false)
    }

    fn compact_if_needed(&mut self) {
        if self.compaction_limit == 0
            || self.entries.len() <= self.compaction_limit.saturating_add(1)
        {
            return;
        }
        if !self.has_snapshot() {
            return;
        }
        // A log with a snapshot folds without a clock and without a counter, so
        // this can only fail on an invalid limit, which cannot happen here.
        let _ = self.compact(self.compaction_limit);
    }
}

/// Where a recovered thread came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoverySource {
    /// The log was readable and produced the thread.
    Log,
    /// The compatibility snapshot was returned because the log was absent or
    /// could not be read.
    Snapshot,
}

impl RecoverySource {
    pub fn as_str(self) -> &'static str {
        match self {
            RecoverySource::Log => "log",
            RecoverySource::Snapshot => "snapshot",
        }
    }
}

/// A thread that can be rendered after a reopen, together with the ordered
/// events that produced it.
///
/// Recovery never spawns a provider, never writes a file, and never invents a
/// resume handle. `resume_handle` is only the stored provider-issued value; its
/// presence is the only reason the renderer may offer a resume.
#[derive(Debug, Clone, PartialEq)]
pub struct RecoveredThread {
    pub thread_id: String,
    pub thread: Value,
    pub events: Vec<ThreadEvent>,
    pub source: RecoverySource,
    pub resume_handle: Option<String>,
    /// Set when the log could not be read. The compatibility snapshot is still
    /// returned, so the previous data stays readable.
    pub diagnostic: Option<String>,
}

impl RecoveredThread {
    /// True only when the recovered thread carries a non-empty provider handle.
    pub fn resume_available(&self) -> bool {
        self.resume_handle.is_some()
    }
}

/// Reopens `thread_id` from its log, falling back to the stored compatibility
/// snapshot when the log is absent or unreadable.
///
/// This is read-only: it never saves, migrates, repairs, or deletes the store.
pub fn recover_thread(thread_id: &str, path: &Path) -> RecoveredThread {
    let snapshot = stored_thread_snapshot(thread_id);
    recover_thread_with_snapshot(thread_id, path, snapshot.as_ref())
}

/// Reopens a thread over an explicit compatibility snapshot.
///
/// The application uses [`recover_thread`]; tests use this form to supply the
/// snapshot without touching application state.
pub fn recover_thread_with_snapshot(
    thread_id: &str,
    path: &Path,
    snapshot: Option<&Value>,
) -> RecoveredThread {
    let base = snapshot.cloned().unwrap_or_else(|| Value::Object(serde_json::Map::new()));
    match ThreadEventLog::load(thread_id, path) {
        Ok(log) => {
            let thread = log.fold(&base);
            let resume_handle = provider_handle(&thread);
            RecoveredThread {
                thread_id: thread_id.to_string(),
                thread,
                source: if log.entries().is_empty() {
                    RecoverySource::Snapshot
                } else {
                    RecoverySource::Log
                },
                events: log.entries().to_vec(),
                resume_handle,
                diagnostic: None,
            }
        }
        Err(error) => RecoveredThread {
            thread_id: thread_id.to_string(),
            thread: base,
            events: Vec::new(),
            source: RecoverySource::Snapshot,
            resume_handle: snapshot.and_then(provider_handle),
            diagnostic: Some(error.to_string()),
        },
    }
}

fn stored_thread_snapshot(thread_id: &str) -> Option<Value> {
    crate::persist::threads()
        .lock()
        .ok()?
        .iter()
        .find(|thread| thread.get("id").and_then(Value::as_str) == Some(thread_id))
        .cloned()
}

/// Reads the provider-issued handle the existing thread already stores. It
/// never derives a handle from a thread id, driver, or process.
fn provider_handle(thread: &Value) -> Option<String> {
    thread
        .get("providerSessionId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|handle| !handle.is_empty())
        .map(str::to_string)
}

fn validate_payload(kind: ThreadEventKind, payload: &Value) -> Result<(), String> {
    let object = payload
        .as_object()
        .ok_or_else(|| "an event payload must be an object".to_string())?;
    match kind {
        ThreadEventKind::Snapshot => {
            let thread = object
                .get("thread")
                .ok_or_else(|| "a snapshot needs a thread".to_string())?;
            if !thread.is_object() {
                return Err("a snapshot thread must be an object".to_string());
            }
            let id = thread.get("id").and_then(Value::as_str).unwrap_or("");
            if id.is_empty() {
                return Err("a snapshot thread needs a non-empty id".to_string());
            }
        }
        ThreadEventKind::Field => {
            let name = object.get("name").and_then(Value::as_str).unwrap_or("");
            if name.trim().is_empty() {
                return Err("a field event needs a name".to_string());
            }
            if name == "id" || name == "items" {
                return Err(format!("a field event cannot set {name}"));
            }
            if !object.contains_key("value") {
                return Err("a field event needs a value".to_string());
            }
        }
        ThreadEventKind::ItemUpsert => {
            let item = object
                .get("item")
                .ok_or_else(|| "an item event needs an item".to_string())?;
            let id = item.get("id").and_then(Value::as_str).unwrap_or("");
            if id.is_empty() {
                return Err("an item needs a non-empty id".to_string());
            }
        }
        ThreadEventKind::ItemRemove => {
            let id = object.get("id").and_then(Value::as_str).unwrap_or("");
            if id.is_empty() {
                return Err("a remove event needs an item id".to_string());
            }
        }
        ThreadEventKind::ApprovalOpened => {
            let approval = object
                .get("approval")
                .ok_or_else(|| "an approval event needs an approval".to_string())?;
            let id = approval.get("id").and_then(Value::as_str).unwrap_or("");
            if id.is_empty() {
                return Err("an approval needs a non-empty id".to_string());
            }
        }
        ThreadEventKind::ApprovalResolved => {
            let request_id = object.get("requestId").and_then(Value::as_str).unwrap_or("");
            if request_id.is_empty() {
                return Err("a resolved approval needs a request id".to_string());
            }
            let decision = object.get("decision").and_then(Value::as_str).unwrap_or("");
            if !APPROVAL_DECISIONS.contains(&decision) {
                return Err(format!("{decision:?} is not an approval decision"));
            }
        }
        ThreadEventKind::Lifecycle => {
            let state = object.get("state").and_then(Value::as_str).unwrap_or("");
            if !LIFECYCLE_STATES.contains(&state) {
                return Err(format!("{state:?} is not a session state"));
            }
        }
    }
    Ok(())
}

fn fold_entries(entries: &[ThreadEvent], thread: &Value) -> Value {
    let mut current = match thread {
        Value::Object(map) => Value::Object(map.clone()),
        _ => Value::Object(serde_json::Map::new()),
    };
    for entry in entries {
        apply_entry(&mut current, entry);
    }
    current
}

fn apply_entry(thread: &mut Value, entry: &ThreadEvent) {
    let Some(kind) = ThreadEventKind::parse(&entry.kind) else {
        return;
    };
    match kind {
        ThreadEventKind::Snapshot => {
            if let Some(snapshot) = entry.payload.get("thread") {
                if snapshot.is_object() {
                    *thread = snapshot.clone();
                }
            }
        }
        ThreadEventKind::Field => {
            let Some(name) = entry.payload.get("name").and_then(Value::as_str) else {
                return;
            };
            if name == "id" || name == "items" {
                return;
            }
            let value = entry.payload.get("value").cloned().unwrap_or(Value::Null);
            if let Some(object) = thread.as_object_mut() {
                object.insert(name.to_string(), value);
            }
        }
        ThreadEventKind::ItemUpsert => {
            let Some(item) = entry.payload.get("item") else {
                return;
            };
            let id = item.get("id").and_then(Value::as_str).unwrap_or("");
            if id.is_empty() {
                return;
            }
            if thread.get("items").and_then(Value::as_array).is_none() {
                if let Some(object) = thread.as_object_mut() {
                    object.insert("items".to_string(), Value::Array(Vec::new()));
                }
            }
            upsert_item(thread, item);
        }
        ThreadEventKind::ItemRemove => {
            let Some(id) = entry.payload.get("id").and_then(Value::as_str) else {
                return;
            };
            if let Some(items) = thread.get_mut("items").and_then(Value::as_array_mut) {
                items.retain(|item| item.get("id").and_then(Value::as_str) != Some(id));
            }
        }
        ThreadEventKind::ApprovalOpened => {
            let Some(approval) = entry.payload.get("approval") else {
                return;
            };
            if let Some(object) = thread.as_object_mut() {
                object.insert("pendingApproval".to_string(), approval.clone());
                object.insert("status".to_string(), json!("waiting"));
            }
        }
        ThreadEventKind::ApprovalResolved => {
            let Some(request_id) = entry.payload.get("requestId").and_then(Value::as_str) else {
                return;
            };
            let Some(decision) = entry.payload.get("decision").and_then(Value::as_str) else {
                return;
            };
            let pending = thread
                .get("pendingApproval")
                .and_then(|approval| approval.get("id"))
                .and_then(Value::as_str)
                .unwrap_or("");
            // An unknown or already-settled request does not touch the thread.
            if pending != request_id {
                return;
            }
            if let Some(object) = thread.as_object_mut() {
                object.insert("pendingApproval".to_string(), Value::Null);
                if decision != "denyAndStop" {
                    object.insert("status".to_string(), json!("running"));
                }
            }
        }
        ThreadEventKind::Lifecycle => {
            let Some(state) = entry.payload.get("state").and_then(Value::as_str) else {
                return;
            };
            let status = thread_status_for_state(state);
            let settles = lifecycle_settles_approvals(state);
            if let Some(object) = thread.as_object_mut() {
                object.insert("status".to_string(), json!(status));
                if settles {
                    object.insert("pendingApproval".to_string(), Value::Null);
                }
            }
        }
    }
}

/// A session state maps onto the thread status vocabulary existing readers use.
fn thread_status_for_state(state: &str) -> &'static str {
    match state {
        "waiting" => "waiting",
        "failed" => "error",
        "completed" | "interrupted" | "resumable" | "closed" => "idle",
        _ => "running",
    }
}

/// A state that is not live ends the turn, so a pending approval cannot survive
/// it.
fn lifecycle_settles_approvals(state: &str) -> bool {
    !matches!(state, "prepared" | "starting" | "running" | "waiting")
}

fn payload_digest(kind: ThreadEventKind, payload: &Value) -> String {
    let mut hasher = Sha256::new();
    hasher.update(kind.as_str().as_bytes());
    hasher.update(b"\n");
    hasher.update(canonical_json(payload).as_bytes());
    format!("{:x}", hasher.finalize())
}

fn canonical_json(value: &Value) -> String {
    serde_json::to_string(&canonical_value(value)).unwrap_or_else(|_| "null".to_string())
}

/// Sorts object keys so a command's payload digest does not depend on the
/// insertion order or on the map implementation.
fn canonical_value(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_unstable();
            let mut sorted = serde_json::Map::new();
            for key in keys {
                if let Some(inner) = map.get(key) {
                    sorted.insert(key.clone(), canonical_value(inner));
                }
            }
            Value::Object(sorted)
        }
        Value::Array(items) => Value::Array(items.iter().map(canonical_value).collect()),
        other => other.clone(),
    }
}

fn migrate_store(value: Value) -> Result<Value, EventLogError> {
    if value.is_array() {
        return migrate_legacy_entries(value);
    }
    let Some(object) = value.as_object() else {
        return Err(EventLogError::Corrupt(
            "the store is neither an object nor an entry array".to_string(),
        ));
    };
    let version_value = object.get("schemaVersion");
    let version = version_value.and_then(Value::as_u64);
    if version_value.is_some() && version.is_none() {
        return Err(EventLogError::Corrupt(
            "schemaVersion is not a number".to_string(),
        ));
    }
    match version {
        Some(version) if version == EVENT_LOG_SCHEMA_VERSION as u64 => Ok(value),
        Some(version) if version > EVENT_LOG_SCHEMA_VERSION as u64 => {
            Err(EventLogError::UnsupportedVersion(version))
        }
        Some(0) | None => {
            if object.get("entries").and_then(Value::as_array).is_none() {
                return Err(EventLogError::Corrupt(
                    "the store has no schema version and no entries".to_string(),
                ));
            }
            let mut migrated = object.clone();
            migrated.insert("schemaVersion".to_string(), json!(EVENT_LOG_SCHEMA_VERSION));
            if migrated.get("threadId").and_then(Value::as_str).is_none() {
                migrated.insert("threadId".to_string(), json!(""));
            }
            if migrated.get("lastSequence").and_then(Value::as_u64).is_none() {
                let last = object
                    .get("entries")
                    .and_then(Value::as_array)
                    .and_then(|entries| entries.last())
                    .and_then(|entry| entry.get("sequence"))
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                migrated.insert("lastSequence".to_string(), json!(last));
            }
            if migrated.get("receipts").is_none() {
                migrated.insert("receipts".to_string(), json!([]));
            }
            Ok(Value::Object(migrated))
        }
        Some(version) => Err(EventLogError::UnsupportedVersion(version)),
    }
}

/// A pre-schema store was a bare entry array. The conversion stays in memory:
/// the file is only written by an explicit save.
fn migrate_legacy_entries(value: Value) -> Result<Value, EventLogError> {
    let entries = value.as_array().cloned().unwrap_or_default();
    for entry in &entries {
        serde_json::from_value::<ThreadEvent>(entry.clone()).map_err(|error| {
            EventLogError::Migration(format!("an entry does not match the event shape: {error}"))
        })?;
    }
    let last_sequence = entries
        .last()
        .and_then(|entry| entry.get("sequence"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    Ok(json!({
        "schemaVersion": EVENT_LOG_SCHEMA_VERSION,
        "threadId": "",
        "lastSequence": last_sequence,
        "entries": entries,
        "receipts": [],
    }))
}

fn validate_stored(stored: &StoredLog) -> Result<(), EventLogError> {
    let mut previous: Option<u64> = None;
    for entry in &stored.entries {
        if entry.sequence == 0 {
            return Err(EventLogError::Corrupt(
                "an entry sequence starts at zero".to_string(),
            ));
        }
        if let Some(previous) = previous {
            if entry.sequence != previous.saturating_add(1) {
                return Err(EventLogError::Corrupt(format!(
                    "entry sequence {} does not follow {previous}",
                    entry.sequence
                )));
            }
        }
        let Some(kind) = ThreadEventKind::parse(&entry.kind) else {
            return Err(EventLogError::Corrupt(format!(
                "unknown event kind {:?}",
                entry.kind
            )));
        };
        validate_payload(kind, &entry.payload).map_err(EventLogError::Corrupt)?;
        previous = Some(entry.sequence);
    }
    if stored.last_sequence != previous.unwrap_or(0) {
        return Err(EventLogError::Corrupt(format!(
            "lastSequence {} does not match the last entry",
            stored.last_sequence
        )));
    }
    let mut seen: HashSet<&str> = HashSet::new();
    for receipt in &stored.receipts {
        if receipt.command_id.trim().is_empty() {
            return Err(EventLogError::Corrupt(
                "a receipt has no command id".to_string(),
            ));
        }
        if !seen.insert(receipt.command_id.as_str()) {
            return Err(EventLogError::Corrupt(format!(
                "command {} has two receipts",
                receipt.command_id
            )));
        }
        if receipt.sequence == 0 || receipt.sequence > stored.last_sequence {
            return Err(EventLogError::Corrupt(format!(
                "command {} has an invalid sequence",
                receipt.command_id
            )));
        }
        if ThreadEventKind::parse(&receipt.kind).is_none() {
            return Err(EventLogError::Corrupt(format!(
                "command {} has an unknown event kind",
                receipt.command_id
            )));
        }
    }
    Ok(())
}

fn temp_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".tmp");
    path.with_file_name(name)
}

fn write_atomically(path: &Path, body: &str) -> Result<(), EventLogError> {
    let temp = temp_path(path);
    let mut file = fs::File::create(&temp).map_err(|error| EventLogError::Io(error.to_string()))?;
    file.write_all(body.as_bytes())
        .map_err(|error| EventLogError::Io(error.to_string()))?;
    file.sync_all()
        .map_err(|error| EventLogError::Io(error.to_string()))?;
    drop(file);
    fs::rename(&temp, path).map_err(|error| EventLogError::Io(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::threads::{chat_item, upsert_item, THREAD_FIELD_NAMES};

    /// A thread shaped like the one the existing code writes. The projection
    /// test pins it to the canonical field list.
    fn thread_fixture() -> Value {
        json!({
            "schemaVersion": 1,
            "revision": "rev-1",
            "id": "thread-1",
            "profileId": Value::Null,
            "provider": "codex",
            "providerSessionId": Value::Null,
            "title": "First",
            "items": [],
            "plans": [],
            "mode": "acceptEdits",
            "plan": false,
            "model": Value::Null,
            "providerOptions": [],
            "status": "idle",
            "usage": { "inputTokens": 0, "outputTokens": 0, "costUsd": 0.0 },
            "workspaceId": Value::Null,
            "pinned": false,
            "pendingApproval": Value::Null,
            "createdAtUnixMs": 1_700_000_000_000i64,
            "updatedAtUnixMs": 1_700_000_000_000i64
        })
    }

    fn approval() -> Value {
        json!({
            "id": "approval-1",
            "toolName": "shell",
            "title": "Run a command",
            "detail": Value::Null,
            "risk": "low",
            "impact": "writes a file",
            "status": "pending"
        })
    }

    fn populated_log() -> ThreadEventLog {
        let mut log = ThreadEventLog::from_thread(&thread_fixture()).expect("thread log");
        log.append(
            ThreadEventKind::Field,
            json!({ "name": "title", "value": "Renamed" }),
        )
        .unwrap();
        log.append(
            ThreadEventKind::Field,
            json!({ "name": "status", "value": "running" }),
        )
        .unwrap();
        log.append(
            ThreadEventKind::ItemUpsert,
            json!({ "item": chat_item("user-1", "user", "do the thing", false) }),
        )
        .unwrap();
        log.append(
            ThreadEventKind::ItemUpsert,
            json!({ "item": chat_item("assistant-1", "assistant", "working on it", false) }),
        )
        .unwrap();
        log.append(ThreadEventKind::ApprovalOpened, json!({ "approval": approval() }))
            .unwrap();
        log.append(
            ThreadEventKind::ApprovalResolved,
            json!({ "requestId": "approval-1", "decision": "allowOnce" }),
        )
        .unwrap();
        log.append(ThreadEventKind::Lifecycle, json!({ "state": "running" }))
            .unwrap();
        log
    }

    /// A scratch directory under the system temp directory, removed on drop.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "kite-event-log-{tag}-{}",
                uuid::Uuid::new_v4().simple()
            ));
            fs::create_dir_all(&path).expect("create temp dir");
            Self(path)
        }

        fn join(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn the_projection_keeps_the_thread_shape_existing_readers_expect() {
        let item = chat_item("assistant-1", "assistant", "hello", false);
        let mut log = ThreadEventLog::from_thread(&thread_fixture()).unwrap();
        log.append(
            ThreadEventKind::Field,
            json!({ "name": "title", "value": "Renamed" }),
        )
        .unwrap();
        log.append(
            ThreadEventKind::Field,
            json!({ "name": "status", "value": "running" }),
        )
        .unwrap();
        log.append(ThreadEventKind::ItemUpsert, json!({ "item": item.clone() }))
            .unwrap();

        let mut expected = thread_fixture();
        expected["title"] = json!("Renamed");
        expected["status"] = json!("running");
        upsert_item(&mut expected, &item);

        let projection = log.compatibility_projection();
        assert_eq!(projection, expected);

        let mut projected: Vec<&str> = projection
            .as_object()
            .expect("projection is an object")
            .keys()
            .map(String::as_str)
            .collect();
        projected.sort_unstable();
        let mut canonical: Vec<&str> = THREAD_FIELD_NAMES.to_vec();
        canonical.sort_unstable();
        assert_eq!(projected, canonical);
    }

    #[test]
    fn folding_the_same_log_twice_produces_the_same_thread() {
        let log = populated_log();
        let first = log.fold(&thread_fixture());
        let second = log.fold(&thread_fixture());
        assert_eq!(first, second);
        assert_eq!(log.compatibility_projection(), log.compatibility_projection());

        let dir = TempDir::new("determinism");
        let path = dir.join("thread.json");
        log.save_to(&path).unwrap();
        let loaded = ThreadEventLog::load("thread-1", &path).unwrap();
        assert_eq!(loaded.entries(), log.entries());
        assert_eq!(loaded.compatibility_projection(), log.compatibility_projection());
    }

    #[test]
    fn the_sequence_is_monotonic_and_refuses_a_duplicate_or_a_gap() {
        let mut log = ThreadEventLog::from_thread(&thread_fixture()).unwrap();
        assert_eq!(log.last_sequence(), 1);
        assert_eq!(
            log.append(ThreadEventKind::Field, json!({ "name": "title", "value": "Two" }))
                .unwrap()
                .sequence,
            2
        );

        let before = log.entries().len();
        assert_eq!(
            log.append_at(
                2,
                ThreadEventKind::Field,
                json!({ "name": "title", "value": "Again" })
            )
            .unwrap_err(),
            EventLogError::DuplicateSequence(2)
        );
        assert_eq!(
            log.append_at(
                4,
                ThreadEventKind::Field,
                json!({ "name": "title", "value": "Gap" })
            )
            .unwrap_err(),
            EventLogError::Gap {
                expected: 3,
                found: 4
            }
        );
        assert_eq!(
            log.append_at(0, ThreadEventKind::Field, json!({ "name": "title", "value": "Zero" }))
                .unwrap_err(),
            EventLogError::InvalidPayload("event sequences start at 1".to_string())
        );
        assert_eq!(log.entries().len(), before);
        assert_eq!(log.last_sequence(), 2);
        assert_eq!(log.compatibility_projection()["title"], "Two");

        assert_eq!(
            log.append_at(
                3,
                ThreadEventKind::Field,
                json!({ "name": "title", "value": "Three" })
            )
            .unwrap()
            .sequence,
            3
        );
        assert!(
            log.entries().iter().all(|entry| entry.at_ms > 0),
            "every durable entry carries a timestamp"
        );
    }

    #[test]
    fn replaying_a_command_returns_the_same_receipt_without_appending() {
        let mut log = ThreadEventLog::from_thread(&thread_fixture()).unwrap();
        let item = chat_item("assistant-1", "assistant", "hello", false);
        let payload = json!({ "item": item });

        let first = log
            .append_command(ThreadEventKind::ItemUpsert, "command-1", payload.clone())
            .unwrap();
        let entries = log.entries().len();
        let replay = log
            .append_command(ThreadEventKind::ItemUpsert, "command-1", payload)
            .unwrap();

        assert!(!first.duplicate);
        assert!(replay.duplicate);
        assert_eq!(first.sequence, replay.sequence);
        assert_eq!(log.entries().len(), entries);
        assert_eq!(log.receipt("command-1").unwrap().sequence, first.sequence);
    }

    #[test]
    fn reusing_a_command_id_with_another_payload_is_rejected() {
        let mut log = ThreadEventLog::from_thread(&thread_fixture()).unwrap();
        log.append_command(
            ThreadEventKind::ItemUpsert,
            "command-1",
            json!({ "item": chat_item("assistant-1", "assistant", "hello", false) }),
        )
        .unwrap();
        let entries = log.entries().len();

        let error = log
            .append_command(
                ThreadEventKind::ItemUpsert,
                "command-1",
                json!({ "item": chat_item("assistant-1", "assistant", "different", false) }),
            )
            .unwrap_err();

        assert_eq!(error, EventLogError::CommandConflict("command-1".to_string()));
        assert_eq!(log.entries().len(), entries);
    }

    #[test]
    fn receipts_are_stable_after_reopening_the_store() {
        let dir = TempDir::new("receipts");
        let path = dir.join("thread.json");
        let payload = json!({ "item": chat_item("assistant-1", "assistant", "hello", false) });
        let mut log = ThreadEventLog::from_thread(&thread_fixture()).unwrap();
        let first = log
            .append_command(ThreadEventKind::ItemUpsert, "command-1", payload.clone())
            .unwrap();
        log.save_to(&path).unwrap();

        let mut loaded = ThreadEventLog::load("thread-1", &path).unwrap();
        let stored = loaded.receipt("command-1").expect("the receipt survives");
        assert_eq!(stored.sequence, first.sequence);
        assert_eq!(stored.kind, "item.upsert");

        let replay = loaded
            .append_command(ThreadEventKind::ItemUpsert, "command-1", payload)
            .unwrap();
        assert!(replay.duplicate);
        assert_eq!(loaded.entries(), log.entries());
    }

    #[test]
    fn compaction_preserves_the_folded_result_and_the_next_sequence() {
        let mut log = ThreadEventLog::from_thread(&thread_fixture()).unwrap();
        for index in 0..8 {
            log.append(
                ThreadEventKind::Field,
                json!({ "name": "title", "value": format!("title-{index}") }),
            )
            .unwrap();
            log.append(
                ThreadEventKind::ItemUpsert,
                json!({ "item": chat_item(
                    &format!("item-{index}"),
                    "assistant",
                    &format!("text {index}"),
                    false
                ) }),
            )
            .unwrap();
        }
        let before = log.compatibility_projection();
        let frontier = log.last_sequence();
        assert_eq!(log.entries().len(), 17);

        log.compact(3).unwrap();

        assert_eq!(log.compatibility_projection(), before);
        assert_eq!(log.last_sequence(), frontier);
        assert_eq!(log.entries().len(), 4);
        assert_eq!(log.entries()[0].kind, "snapshot");
        assert_eq!(log.entries()[0].sequence, frontier - 3);
        assert_eq!(
            log.entries().last().unwrap().sequence,
            frontier,
            "the tail keeps every retained entry in order"
        );
        assert_eq!(
            log.append(ThreadEventKind::Field, json!({ "name": "title", "value": "after" }))
                .unwrap()
                .sequence,
            frontier + 1
        );
        assert_eq!(log.compatibility_projection()["title"], "after");
    }

    #[test]
    fn compaction_without_a_base_changes_nothing() {
        let mut log = ThreadEventLog::new("thread-1");
        for index in 0..5 {
            log.append(
                ThreadEventKind::Field,
                json!({ "name": "title", "value": format!("title-{index}") }),
            )
            .unwrap();
        }

        assert_eq!(log.compact(1).unwrap_err(), EventLogError::MissingBase);
        assert_eq!(log.entries().len(), 5);
        assert_eq!(log.last_sequence(), 5);
        assert_eq!(log.compact(0).unwrap_err(), EventLogError::InvalidCompactionLimit);
    }

    #[test]
    fn a_bounded_log_compacts_itself_and_keeps_the_same_fold() {
        let mut log = ThreadEventLog::from_thread(&thread_fixture())
            .unwrap()
            .with_compaction_limit(4);
        let mut longest = 0;
        for index in 0..12 {
            log.append(
                ThreadEventKind::Field,
                json!({ "name": "title", "value": format!("title-{index}") }),
            )
            .unwrap();
            longest = longest.max(log.entries().len());
        }

        assert!(longest <= 5, "the log stays bounded to its limit plus one entry");
        assert_eq!(log.entries()[0].kind, "snapshot");
        assert_eq!(log.last_sequence(), 13);
        assert_eq!(log.compatibility_projection()["title"], "title-11");
    }

    #[test]
    fn a_corrupt_store_fails_to_load_without_being_rewritten() {
        let dir = TempDir::new("corrupt");
        let path = dir.join("thread.json");
        let garbage = b"{ not json".to_vec();
        fs::write(&path, &garbage).unwrap();

        let error = ThreadEventLog::load("thread-1", &path).unwrap_err();

        assert!(matches!(error, EventLogError::Corrupt(_)));
        assert_eq!(fs::read(&path).unwrap(), garbage);
    }

    #[test]
    fn a_stored_log_with_a_gap_is_rejected_and_left_alone() {
        let dir = TempDir::new("stored-gap");
        let path = dir.join("thread.json");
        let body = serde_json::to_vec(&json!({
            "schemaVersion": EVENT_LOG_SCHEMA_VERSION,
            "threadId": "thread-1",
            "lastSequence": 3,
            "entries": [
                { "sequence": 1, "kind": "snapshot", "payload": { "thread": thread_fixture() }, "atMs": 10 },
                { "sequence": 3, "kind": "field", "payload": { "name": "title", "value": "three" }, "atMs": 11 }
            ],
            "receipts": []
        }))
        .unwrap();
        fs::write(&path, &body).unwrap();

        let error = ThreadEventLog::load("thread-1", &path).unwrap_err();

        assert!(matches!(error, EventLogError::Corrupt(_)));
        assert_eq!(fs::read(&path).unwrap(), body);
    }

    #[test]
    fn a_failed_write_leaves_the_previous_store_readable() {
        let dir = TempDir::new("failed-write");
        let path = dir.join("thread.json");
        let mut log = ThreadEventLog::from_thread(&thread_fixture()).unwrap();
        log.append(
            ThreadEventKind::Field,
            json!({ "name": "title", "value": "Saved" }),
        )
        .unwrap();
        log.save_to(&path).unwrap();
        let saved = fs::read(&path).unwrap();

        // The temporary sibling is a directory, so the replace cannot happen.
        fs::create_dir(temp_path(&path)).unwrap();
        log.append(
            ThreadEventKind::Field,
            json!({ "name": "title", "value": "Not saved" }),
        )
        .unwrap();
        assert!(log.save_to(&path).is_err());

        assert_eq!(fs::read(&path).unwrap(), saved);
        let loaded = ThreadEventLog::load("thread-1", &path).unwrap();
        assert_eq!(loaded.compatibility_projection()["title"], "Saved");
    }

    #[test]
    fn a_legacy_entry_array_migrates_in_memory_and_the_file_is_not_rewritten() {
        let dir = TempDir::new("legacy");
        let path = dir.join("thread.json");
        let legacy = serde_json::to_vec(&json!([
            { "sequence": 1, "kind": "snapshot", "payload": { "thread": thread_fixture() }, "atMs": 10 },
            { "sequence": 2, "kind": "field", "payload": { "name": "title", "value": "Legacy" }, "atMs": 11 }
        ]))
        .unwrap();
        fs::write(&path, &legacy).unwrap();

        let loaded = ThreadEventLog::load("thread-1", &path).unwrap();

        assert_eq!(loaded.entries().len(), 2);
        assert_eq!(loaded.compatibility_projection()["title"], "Legacy");
        assert_eq!(fs::read(&path).unwrap(), legacy);
    }

    #[test]
    fn a_failed_migration_leaves_the_previous_store_untouched() {
        let dir = TempDir::new("migration");
        let path = dir.join("thread.json");
        let broken = serde_json::to_vec(&json!([
            { "sequence": 1, "kind": "field", "payload": { "name": "title", "value": "no time" } }
        ]))
        .unwrap();
        fs::write(&path, &broken).unwrap();

        let error = ThreadEventLog::load("thread-1", &path).unwrap_err();

        assert!(matches!(error, EventLogError::Migration(_)));
        assert_eq!(fs::read(&path).unwrap(), broken);
    }

    #[test]
    fn a_newer_store_is_rejected_without_being_rewritten() {
        let dir = TempDir::new("newer");
        let path = dir.join("thread.json");
        let newer = serde_json::to_vec(&json!({
            "schemaVersion": 99,
            "threadId": "thread-1",
            "lastSequence": 0,
            "entries": [],
            "receipts": []
        }))
        .unwrap();
        fs::write(&path, &newer).unwrap();

        let error = ThreadEventLog::load("thread-1", &path).unwrap_err();

        assert_eq!(error, EventLogError::UnsupportedVersion(99));
        assert_eq!(fs::read(&path).unwrap(), newer);
    }

    #[test]
    fn a_store_belongs_to_one_thread() {
        let dir = TempDir::new("thread-id");
        let path = dir.join("thread.json");
        ThreadEventLog::from_thread(&thread_fixture())
            .unwrap()
            .save_to(&path)
            .unwrap();

        assert_eq!(
            ThreadEventLog::load("thread-2", &path).unwrap_err(),
            EventLogError::ThreadMismatch {
                expected: "thread-2".to_string(),
                found: "thread-1".to_string()
            }
        );

        let mut log = ThreadEventLog::from_thread(&thread_fixture()).unwrap();
        assert!(matches!(
            log.append(
                ThreadEventKind::Snapshot,
                json!({ "thread": { "id": "thread-9" } })
            ),
            Err(EventLogError::ThreadMismatch { .. })
        ));
        assert_eq!(log.last_sequence(), 1);
    }

    #[test]
    fn a_settled_or_unknown_approval_does_not_change_the_projection() {
        let mut log = ThreadEventLog::from_thread(&thread_fixture()).unwrap();
        log.append(ThreadEventKind::ApprovalOpened, json!({ "approval": approval() }))
            .unwrap();
        let opened = log.compatibility_projection();
        assert_eq!(opened["status"], "waiting");
        assert_eq!(opened["pendingApproval"]["id"], "approval-1");

        log.append(
            ThreadEventKind::ApprovalResolved,
            json!({ "requestId": "approval-unknown", "decision": "deny" }),
        )
        .unwrap();
        assert_eq!(log.compatibility_projection(), opened);

        log.append(
            ThreadEventKind::ApprovalResolved,
            json!({ "requestId": "approval-1", "decision": "allowOnce" }),
        )
        .unwrap();
        let resolved = log.compatibility_projection();
        assert!(resolved["pendingApproval"].is_null());
        assert_eq!(resolved["status"], "running");

        log.append(
            ThreadEventKind::ApprovalResolved,
            json!({ "requestId": "approval-1", "decision": "deny" }),
        )
        .unwrap();
        assert_eq!(log.compatibility_projection(), resolved);

        assert!(matches!(
            log.append(
                ThreadEventKind::ApprovalResolved,
                json!({ "requestId": "approval-1", "decision": "maybe" })
            ),
            Err(EventLogError::InvalidPayload(_))
        ));
    }

    #[test]
    fn a_provider_exit_settles_approvals_and_keeps_the_prompt() {
        let mut log = ThreadEventLog::from_thread(&thread_fixture()).unwrap();
        log.append(
            ThreadEventKind::ItemUpsert,
            json!({ "item": chat_item("user-1", "user", "do the thing", false) }),
        )
        .unwrap();
        log.append(ThreadEventKind::ApprovalOpened, json!({ "approval": approval() }))
            .unwrap();

        log.append(
            ThreadEventKind::Lifecycle,
            json!({ "state": "failed", "code": 1, "reason": "provider exited" }),
        )
        .unwrap();
        let failed = log.compatibility_projection();
        assert!(failed["pendingApproval"].is_null());
        assert_eq!(failed["status"], "error");
        assert_eq!(
            failed["items"][0]["text"], "do the thing",
            "a failed turn keeps the user's prompt readable"
        );
        assert!(log
            .entries()
            .iter()
            .any(|entry| entry.kind == "lifecycle" && entry.payload["state"] == "failed"));

        log.append(ThreadEventKind::Lifecycle, json!({ "state": "interrupted" }))
            .unwrap();
        assert_eq!(log.compatibility_projection()["status"], "idle");
        assert_eq!(log.compatibility_projection(), log.fold(&thread_fixture()));
    }

    #[test]
    fn item_removal_removes_an_item_by_id() {
        let mut log = ThreadEventLog::from_thread(&thread_fixture()).unwrap();
        log.append(
            ThreadEventKind::ItemUpsert,
            json!({ "item": chat_item("assistant-1", "assistant", "hello", false) }),
        )
        .unwrap();
        log.append(ThreadEventKind::ItemRemove, json!({ "id": "assistant-1" }))
            .unwrap();

        assert!(log.compatibility_projection()["items"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn recovery_is_idempotent_across_two_loads() {
        let dir = TempDir::new("recovery-idempotent");
        let path = dir.join("thread.json");
        populated_log().save_to(&path).unwrap();
        let snapshot = thread_fixture();

        let first = recover_thread_with_snapshot("thread-1", &path, Some(&snapshot));
        let second = recover_thread_with_snapshot("thread-1", &path, Some(&snapshot));

        assert_eq!(first, second);
        assert_eq!(first.source, RecoverySource::Log);
        assert_eq!(first.events.len(), 8);
        assert_eq!(first.thread["title"], "Renamed");
        assert_eq!(first.thread["status"], "running");
        assert_eq!(first.thread["items"][0]["text"], "do the thing");
        assert!(first.diagnostic.is_none());
    }

    #[test]
    fn a_corrupted_log_falls_back_to_the_snapshot_and_is_left_alone() {
        let dir = TempDir::new("recovery-corrupt");
        let path = dir.join("thread.json");
        let garbage = b"{ not json".to_vec();
        fs::write(&path, &garbage).unwrap();
        let snapshot = thread_fixture();

        let recovered = recover_thread_with_snapshot("thread-1", &path, Some(&snapshot));

        assert_eq!(recovered.source, RecoverySource::Snapshot);
        assert_eq!(recovered.thread, snapshot);
        assert!(recovered.events.is_empty());
        assert!(recovered.diagnostic.is_some());
        assert_eq!(fs::read(&path).unwrap(), garbage);
    }

    #[test]
    fn a_missing_log_falls_back_to_the_snapshot_without_creating_a_file() {
        let dir = TempDir::new("recovery-missing");
        let path = dir.join("thread.json");
        let snapshot = thread_fixture();

        let recovered = recover_thread_with_snapshot("thread-1", &path, Some(&snapshot));

        assert_eq!(recovered.thread, snapshot);
        assert_eq!(recovered.source, RecoverySource::Snapshot);
        assert!(recovered.events.is_empty());
        assert!(recovered.diagnostic.is_none());
        assert!(!path.exists(), "recovery is read-only");
    }

    #[test]
    fn the_fold_and_the_compatibility_snapshot_agree() {
        let snapshot = thread_fixture();
        let log = populated_log();
        let projection = log.compatibility_projection();

        assert_eq!(log.fold(&snapshot), projection);

        let dir = TempDir::new("recovery-agree");
        let path = dir.join("thread.json");
        log.save_to(&path).unwrap();

        let recovered = recover_thread_with_snapshot("thread-1", &path, Some(&snapshot));

        assert_eq!(recovered.thread, log.fold(&snapshot));
        assert_eq!(recovered.thread, projection);
        assert_eq!(recovered.thread["title"], "Renamed");
        assert_eq!(recovered.thread["items"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn the_public_recovery_reads_a_self_contained_log_without_writing() {
        let dir = TempDir::new("recovery-public");
        let path = dir.join("thread.json");
        let log = populated_log();
        log.save_to(&path).unwrap();
        let before = fs::read(&path).unwrap();

        let recovered = recover_thread("thread-1", &path);

        assert_eq!(recovered.source, RecoverySource::Log);
        assert_eq!(recovered.thread, log.compatibility_projection());
        assert_eq!(fs::read(&path).unwrap(), before);
    }

    #[test]
    fn recovery_reports_only_a_stored_provider_handle() {
        let dir = TempDir::new("recovery-handle");
        let path = dir.join("thread.json");
        let mut log = ThreadEventLog::from_thread(&thread_fixture()).unwrap();
        log.append(
            ThreadEventKind::Field,
            json!({ "name": "providerSessionId", "value": "provider-session-9" }),
        )
        .unwrap();
        log.save_to(&path).unwrap();

        let recovered = recover_thread_with_snapshot("thread-1", &path, Some(&thread_fixture()));
        assert!(recovered.resume_available());
        assert_eq!(recovered.resume_handle.as_deref(), Some("provider-session-9"));

        let blank = recover_thread_with_snapshot("thread-1", &path, None);
        assert!(blank.resume_available());

        let mut blank_log = ThreadEventLog::from_thread(&thread_fixture()).unwrap();
        blank_log
            .append(
                ThreadEventKind::Field,
                json!({ "name": "providerSessionId", "value": "   " }),
            )
            .unwrap();
        let blank_path = dir.join("blank.json");
        blank_log.save_to(&blank_path).unwrap();

        let empty = recover_thread_with_snapshot("thread-1", &blank_path, Some(&thread_fixture()));
        assert!(!empty.resume_available());
        assert_eq!(empty.resume_handle, None);
    }
}
