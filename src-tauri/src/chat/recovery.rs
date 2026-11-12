//! Thread reopening, fold over event log, and compatibility fallback.

use std::path::Path;
use serde_json::Value;

use crate::chat::event_log::{ThreadEvent, ThreadEventLog};

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

pub fn stored_thread_snapshot(thread_id: &str) -> Option<Value> {
    crate::persist::threads()
        .lock()
        .ok()?
        .iter()
        .find(|thread| thread.get("id").and_then(Value::as_str) == Some(thread_id))
        .cloned()
}

/// Reads the provider-issued handle the existing thread already stores. It
/// never derives a handle from a thread id, driver, or process.
pub fn provider_handle(thread: &Value) -> Option<String> {
    thread
        .get("providerSessionId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|handle| !handle.is_empty())
        .map(str::to_string)
}
