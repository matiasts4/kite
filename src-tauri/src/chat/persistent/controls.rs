//! Shared controls, constants, and utilities for lasting CLI transports.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

use crate::chat::drivers::{
    declaration, evaluate_version, DriverProbe, Version,
};
use crate::chat::session::TransportEvent;

/// The canonical driver id whose lasting wire this module implements.
pub const ANTIGRAVITY_DRIVER: &str = "antigravity";

/// The canonical OpenCode driver id.
pub const OPENCODE_DRIVER: &str = "opencode";

/// The canonical grok driver id.
pub const GROK_DRIVER: &str = "grok";

/// The argument prefix the lasting Antigravity wire needs. It is sourced directly from
/// the observed flags: `--input-format stream-json` reads one NDJSON message per line, and the
/// matching output format is required by the observed launcher.
pub const ANTIGRAVITY_STREAM_ARGS: [&str; 4] =
    ["--input-format", "stream-json", "--output-format", "stream-json"];

/// The command `codex app-server --help` documents for its transport. The help
/// output stops at the transport: no request frame that carries a user turn is
/// documented, so this constant is evidence, not a launch this build performs.
pub const CODEX_APP_SERVER_ARGS: [&str; 3] = ["app-server", "--listen", "stdio://"];

/// The host the documented `opencode serve --hostname` flag is given.
pub const OPENCODE_SERVE_HOST: &str = "127.0.0.1";

/// How long a freshly started OpenCode server may take to accept a connection.
/// A server that never answers fails the handshake before any turn is written.
pub const OPENCODE_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);

/// How long `agent stdio` may take to answer `initialize` and `session/new`.
/// A process that never answers fails before a message is written.
pub const GROK_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);

/// Ask. The installed CLI documents this as `--permission-mode default`.
pub const GROK_SUPERVISED_MODE: &str = "default";

/// The lasting channel `grok agent stdio --help` documents. Permission flags
/// from `grok --help` sit before `agent`. Model and effort are not argv here:
/// they are set on the open session before the message.
pub const GROK_STDIO_TAIL: [&str; 2] = ["agent", "stdio"];

/// Upper bound for the server or client stderr kept for a diagnostics message.
pub const MAX_TAIL_CHARS: usize = 4_000;

/// A session queue that never grows without bound. Provider output is
/// operational, so an unread session drops the oldest frames instead of
/// retaining an unbounded transcript in memory.
pub const MAX_PENDING_EVENTS: usize = 512;

/// The composer values a lasting session may pass to its driver. Each one
/// reaches the command line only when the driver declaration accepts it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PersistentControls {
    pub model: Option<String>,
    pub effort: Option<String>,
    /// `readOnly`, `acceptEdits`, or `fullAccess`.
    pub permission_mode: Option<String>,
}

/// Env overrides this session applies. Empty on purpose: this build does not
/// set `GROK_OAUTH2_REFERRER` or any other referrer.
pub fn grok_session_env_overrides() -> &'static [(&'static str, &'static str)] {
    &[]
}

/// Maps a stored mode onto a permission value the installed CLI documents.
/// Accept-edits is not offered on this channel, so it runs as ask. `plan` is
/// ignored by `agent stdio`, so a read-only store also runs as ask.
pub fn grok_permission_mode(mode: Option<&str>) -> &'static str {
    match mode.unwrap_or("").trim() {
        "fullAccess" | "bypassPermissions" => "bypassPermissions",
        "auto" => "auto",
        "dontAsk" => "dontAsk",
        _ => GROK_SUPERVISED_MODE,
    }
}

/// Argv for one lasting process. Nothing here is invented: `--permission-mode`
/// is a top-level flag, and `agent stdio` is the documented channel.
pub fn grok_session_args(permission_mode: Option<&str>) -> Vec<String> {
    let mut args = vec![
        "--permission-mode".to_string(),
        grok_permission_mode(permission_mode).to_string(),
    ];
    args.extend(GROK_STDIO_TAIL.iter().map(|arg| arg.to_string()));
    args
}

/// Declines a request this build does not handle, so the provider cannot wait
/// on an answer that will never be written.
pub fn unhandled_request_reply(id: &str) -> String {
    let rpc_id = id
        .parse::<i64>()
        .map(|number| json!(number))
        .unwrap_or_else(|_| json!(id));
    json!({
        "jsonrpc": "2.0",
        "id": rpc_id,
        "error": { "code": -32601, "message": "method not handled" }
    })
    .to_string()
}

/// Acknowledges a plan request so the provider gate opens. The plan stays in
/// the transcript; this does not approve implementation.
pub fn plan_request_ack(id: &str) -> String {
    let rpc_id = id
        .parse::<i64>()
        .map(|number| json!(number))
        .unwrap_or_else(|_| json!(id));
    json!({
        "jsonrpc": "2.0",
        "id": rpc_id,
        "result": {}
    })
    .to_string()
}

/// Whether this build has an adapter for the driver's lasting wire. The driver
/// declaration records what the driver offers; this records what is actually
/// implemented here, so a declared-but-refused wire never looks persistent.
pub fn has_persistent_wire(driver: &str) -> bool {
    declaration(driver)
        .map(|declared| declared.wire.is_supported())
        .unwrap_or(false)
}

/// The bounded refusal for a driver whose documented wire this build does not
/// speak, or `None` when the wire is implemented.
pub fn unsupported_wire(driver: &str) -> Option<String> {
    declaration(driver).and_then(|declared| {
        declared
            .wire
            .unsupported_reason()
            .map(|reason| format!("Unsupported: {reason}"))
    })
}

/// Runs the driver's own documented version probe and compares it with the
/// declaration before any process starts. A missing binary, a failing probe, an
/// unreadable version, and a version below the minimum all return an error, so
/// the caller can keep one command per turn with a bounded diagnostic.
pub fn verify_driver_version(
    driver: &str,
    program: &Path,
    probe: &dyn DriverProbe,
) -> Result<Version, String> {
    let declared = declaration(driver)
        .ok_or_else(|| format!("{driver} has no driver declaration in this build"))?;
    let evidence = declared.version.as_ref().ok_or_else(|| {
        format!(
            "{} declares no version evidence, so a lasting session cannot start",
            declared.driver
        )
    })?;
    let raw = probe.probe(&declared.driver, program, evidence)?;
    evaluate_version(&raw, evidence)
        .map_err(|reason| format!("{} version check failed: {reason}", declared.driver))
}

/// A short, bounded description of the top-level keys, used as schema metadata
/// for a frame this session does not understand.
pub(crate) fn frame_schema(value: &Value) -> String {
    let Some(object) = value.as_object() else {
        return "non-object".to_string();
    };
    let mut keys: Vec<&str> = object.keys().take(6).map(String::as_str).collect();
    if object.len() > keys.len() {
        keys.push("...");
    }
    keys.join(",")
}

pub(crate) fn push_bounded(queue: &mut VecDeque<TransportEvent>, event: TransportEvent) {
    if queue.len() >= MAX_PENDING_EVENTS {
        queue.pop_front();
    }
    queue.push_back(event);
}

pub(crate) fn read_tail(pipe: &mut Box<dyn Read + Send>, tail: Arc<Mutex<String>>) {
    let mut reader = BufReader::new(pipe);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {
                if let Ok(mut tail) = tail.lock() {
                    tail.push_str(&line);
                    let count = tail.chars().count();
                    if count > MAX_TAIL_CHARS {
                        *tail = tail.chars().skip(count - MAX_TAIL_CHARS).collect();
                    }
                }
            }
            Err(_) => break,
        }
    }
}

pub(crate) fn tail_detail(tail: &str) -> String {
    let trimmed = tail.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let clipped: String = trimmed.chars().take(400).collect();
    format!(": {clipped}")
}
