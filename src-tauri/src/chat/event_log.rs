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
pub use super::recovery::*;
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
#[path = "event_log_tests.rs"]
mod tests;

