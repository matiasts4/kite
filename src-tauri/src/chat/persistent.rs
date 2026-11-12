//! Lasting CLI transports for drivers whose wire can stay open.
//!
//! Three lasting wires are wired in this build, each from what its own CLI help
//! documents:
//!
//! - Antigravity's `agy` pair `--input-format stream-json` /
//!   `--output-format stream-json`: one NDJSON user message per line on stdin,
//!   one JSON frame per line on stdout. The exact input frame is this adapter's
//!   own and was not probed, so it stays a single, explicit shape instead of a
//!   guess spread across the runtime.
//! - OpenCode's `serve` command plus its documented client flags `--server`,
//!   `--session`, and `--prompt`: one server process holds the thread's session
//!   and each turn is one documented client invocation against that server.
//!
//! - The grok lasting channel is `agent stdio`. `--permission-mode` is a
//!   top-level flag, so it sits before `agent`. Model and effort are set on
//!   the open session before the message. A stored accept-edits mode runs as
//!   ask, not as auto-accept.
//!
//! Codex documents `app-server` as a transport but no request frame that
//! accepts a user turn, so this build records that command and refuses the
//! wire instead of inventing a protocol. Every other driver keeps one command
//! per turn.

use std::collections::VecDeque;
use std::fmt;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::chat::drivers::{
    declaration, evaluate_version, DriverDeclaration, DriverProbe, SystemDriverProbe, Version,
};
use crate::chat::runtime::bounded_notice;
use crate::chat::session::{SessionTransport, TransportEvent, TransportSpec};
use crate::chat::utils::resolve_bin;
use crate::hidden_exec::{spawn_streaming, HiddenChild};

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

/// Upper bound for the server or client stderr kept for a diagnostics message.
const MAX_TAIL_CHARS: usize = 4_000;

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

/// Builds the lasting Antigravity command line. Controls are gated by the
/// declaration instead of being inferred from the driver id. The prompt is not
/// part of argv: a lasting session receives it on stdin, so nothing pastes the
/// thread into every turn.
pub fn antigravity_args(
    declared: &DriverDeclaration,
    controls: &PersistentControls,
    resume_handle: Option<&str>,
) -> Vec<String> {
    let mut args: Vec<String> = ANTIGRAVITY_STREAM_ARGS
        .iter()
        .map(|arg| arg.to_string())
        .collect();

    if let Some(handle) = resume_handle.map(str::trim).filter(|handle| !handle.is_empty()) {
        if declared.accepts_resume {
            args.push("--conversation".to_string());
            args.push(handle.to_string());
        }
    }

    match controls.permission_mode.as_deref() {
        Some("readOnly") if declared.has_work_mode("plan") => {
            args.push("--mode".to_string());
            args.push("plan".to_string());
            if declared.accepts_permission {
                args.push("--dangerously-skip-permissions".to_string());
            }
        }
        Some("acceptEdits") if declared.has_work_mode("accept-edits") => {
            args.push("--mode".to_string());
            args.push("accept-edits".to_string());
            if declared.accepts_permission {
                args.push("--dangerously-skip-permissions".to_string());
            }
        }
        Some("auto") if declared.accepts_permission => {
            args.push("--mode".to_string());
            args.push("auto".to_string());
            args.push("--dangerously-skip-permissions".to_string());
        }
        Some("fullAccess") if declared.accepts_permission => {
            args.push("--dangerously-skip-permissions".to_string());
        }
        // A value the declaration does not map is omitted, never approximated.
        _ => {}
    }

    if declared.accepts_model {
        if let Some(model) = controls.model.as_deref().map(str::trim).filter(|model| !model.is_empty()) {
            args.push("--model".to_string());
            args.push(model.to_string());
        }
    }
    if declared.accepts_effort {
        if let Some(effort) = controls.effort.as_deref().map(str::trim).filter(|effort| !effort.is_empty()) {
            args.push("--effort".to_string());
            args.push(effort.to_string());
        }
    }

    args
}

/// One user message as one NDJSON line. `serde_json` escapes embedded newlines,
/// so a multi-line prompt stays a single frame and a single turn.
pub fn turn_line(prompt: &str) -> String {
    let message = json!({
        "event": "user",
        "message": {
            "content": prompt
        }
    });
    format!("{message}\n")
}

/// One parsed stdout line. A frame may carry an observable conversation id and
/// any number of transport events, because one provider line can both report a
/// failure and end the turn.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ParsedLine {
    pub conversation_id: Option<String>,
    pub events: Vec<TransportEvent>,
}

/// Normalizes one Antigravity stream line. Known turn text becomes `Text`, a
/// finished turn becomes `TurnEnded`, and anything this session does not
/// project becomes a bounded `Notice` that names the provider and the frame
/// schema.
pub fn parse_antigravity_line(line: &str) -> ParsedLine {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return ParsedLine::default();
    }

    let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
        return ParsedLine {
            conversation_id: None,
            events: vec![TransportEvent::Notice(bounded_notice(&format!(
                "antigravity wrote a non-JSON line (schema=non-json): {trimmed}"
            )))],
        };
    };

    let Some(event) = value.get("event").and_then(Value::as_str) else {
        return ParsedLine {
            conversation_id: None,
            events: vec![TransportEvent::Notice(bounded_notice(&format!(
                "antigravity sent an unknown frame (schema={})",
                frame_schema(&value)
            )))],
        };
    };

    match event {
        "init" => ParsedLine {
            conversation_id: conversation_id(&value),
            events: Vec::new(),
        },
        "step_update" => {
            let step = value.get("step_update").cloned().unwrap_or(Value::Null);
            let step_type = step.get("step_type").and_then(Value::as_str).unwrap_or("unknown");
            if step_type == "user_input" {
                ParsedLine::default()
            } else if step_type == "agent_response" {
                let text = step
                    .get("text_delta")
                    .or_else(|| step.get("text"))
                    .or_else(|| step.get("content"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let thought = step
                    .get("thinking")
                    .or_else(|| step.get("thought"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if !text.is_empty() {
                    ParsedLine {
                        conversation_id: None,
                        events: vec![TransportEvent::Text(text.to_string())],
                    }
                } else if !thought.is_empty() {
                    ParsedLine {
                        conversation_id: None,
                        events: vec![TransportEvent::Activity(trimmed.to_string())],
                    }
                } else {
                    ParsedLine::default()
                }
            } else {
                ParsedLine {
                    conversation_id: None,
                    events: vec![TransportEvent::Activity(trimmed.to_string())],
                }
            }
        }
        "result" => {
            let status = value
                .pointer("/result/status")
                .and_then(Value::as_str)
                .unwrap_or("SUCCESS");
            let mut events = Vec::new();
            if !status.eq_ignore_ascii_case("SUCCESS") {
                events.push(TransportEvent::Notice(bounded_notice(&format!(
                    "antigravity ended the turn with status {status}"
                ))));
            }
            if let Some(err) = value.pointer("/result/error").and_then(Value::as_str) {
                let trimmed_err = err.trim();
                if !trimmed_err.is_empty() {
                    events.push(TransportEvent::Notice(bounded_notice(&format!(
                        "antigravity error: {trimmed_err}"
                    ))));
                }
            }
            if let Some(denied) = value.pointer("/result/denied_actions").and_then(Value::as_array) {
                if !denied.is_empty() {
                    let actions: Vec<&str> = denied
                        .iter()
                        .filter_map(|d| d.get("action").or_else(|| d.get("display_name")).and_then(Value::as_str))
                        .collect();
                    events.push(TransportEvent::Notice(bounded_notice(&format!(
                        "antigravity auto-denied tools in headless mode: {}",
                        actions.join(", ")
                    ))));
                }
            }
            events.push(TransportEvent::TurnEnded);
            ParsedLine {
                conversation_id: None,
                events,
            }
        }
        "error" => ParsedLine {
            conversation_id: None,
            events: vec![TransportEvent::Notice(bounded_notice(&format!(
                "antigravity reported an error: {}",
                error_detail(&value)
            )))],
        },
        other => ParsedLine {
            conversation_id: None,
            events: vec![TransportEvent::Notice(bounded_notice(&format!(
                "antigravity frame `{other}` is not recognized (schema={})",
                frame_schema(&value)
            )))],
        },
    }
}

fn conversation_id(value: &Value) -> Option<String> {
    [
        "/conversation_id",
        "/conversationId",
        "/init/conversation_id",
        "/init/conversationId",
        "/init/session_id",
        "/init/sessionId",
    ]
        .iter()
        .filter_map(|pointer| value.pointer(pointer).and_then(Value::as_str))
        .map(str::trim)
        .find(|candidate| !candidate.is_empty())
        .map(str::to_string)
}

fn error_detail(value: &Value) -> String {
    ["/error/message", "/message", "/error"]
        .iter()
        .filter_map(|pointer| value.pointer(pointer))
        .find_map(|detail| detail.as_str().map(str::to_string))
        .unwrap_or_else(|| "no detail was reported".to_string())
}

/// A short, bounded description of the top-level keys, used as schema metadata
/// for a frame this session does not understand.
fn frame_schema(value: &Value) -> String {
    let Some(object) = value.as_object() else {
        return "non-object".to_string();
    };
    let mut keys: Vec<&str> = object.keys().take(6).map(String::as_str).collect();
    if object.len() > keys.len() {
        keys.push("...");
    }
    keys.join(",")
}

/// Resolves the observed launcher. A missing binary is a hard error: the caller
/// falls back to one command per turn instead of pretending a session exists.
pub fn resolve_antigravity_program() -> Result<PathBuf, String> {
    resolve_bin("agy", &[r"C:\Users\PC\AppData\Local\agy\bin\agy.exe"]).ok_or_else(|| {
        "Antigravity CLI (agy) is not installed; a lasting session cannot start without it"
            .to_string()
    })
}

/// The real Antigravity session. It owns one child process, its stdin, and the
/// thread that drains stdout into the bounded event queue.
pub struct AntigravitySession {
    controls: PersistentControls,
    program: Option<PathBuf>,
    probe: Box<dyn DriverProbe>,
    child: Option<HiddenChild>,
    stdin: Option<Box<dyn Write + Send>>,
    reader: Option<JoinHandle<()>>,
    stderr_reader: Option<JoinHandle<()>>,
    stderr_tail: Arc<Mutex<String>>,
    events: Arc<Mutex<VecDeque<TransportEvent>>>,
    resume: Arc<Mutex<Option<String>>>,
    eof: Arc<AtomicBool>,
    stopping: bool,
    spawns: u32,
}

impl AntigravitySession {
    pub fn new(controls: PersistentControls) -> Self {
        Self::with_probe(controls, None, Box::new(SystemDriverProbe))
    }

    /// `program` is injectable so argv and failure behavior can be tested
    /// without resolving or starting a real provider.
    pub fn with_program(controls: PersistentControls, program: Option<PathBuf>) -> Self {
        Self::with_probe(controls, program, Box::new(SystemDriverProbe))
    }

    /// The version probe is injectable for the same reason as `program`: a test
    /// can decide the reported version without starting a process.
    pub fn with_probe(
        controls: PersistentControls,
        program: Option<PathBuf>,
        probe: Box<dyn DriverProbe>,
    ) -> Self {
        Self {
            controls,
            program,
            probe,
            child: None,
            stdin: None,
            reader: None,
            stderr_reader: None,
            stderr_tail: Arc::new(Mutex::new(String::new())),
            events: Arc::new(Mutex::new(VecDeque::new())),
            resume: Arc::new(Mutex::new(None)),
            eof: Arc::new(AtomicBool::new(false)),
            stopping: false,
            spawns: 0,
        }
    }

    fn stop_process(&mut self) {
        self.stopping = true;
        self.stdin = None;
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
        }
        if let Some(reader) = self.stderr_reader.take() {
            let _ = reader.join();
        }
    }
}

impl fmt::Debug for AntigravitySession {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AntigravitySession")
            .field("controls", &self.controls)
            .field("program", &self.program)
            .field("spawns", &self.spawns)
            .finish()
    }
}

impl SessionTransport for AntigravitySession {
    fn spawn(&mut self, spec: &TransportSpec) -> Result<(), String> {
        if let Some(reader) = self.reader.take() {
            if reader.is_finished() {
                // The process is gone; the handle is reaped below.
            } else if self.stopping {
                // A stop already killed the process, so its reader is about to
                // observe EOF. Joining it keeps one reader per session.
                let _ = reader.join();
            } else {
                self.reader = Some(reader);
                return Err("the antigravity session already has a running process".to_string());
            }
        }
        if let Some(mut child) = self.child.take() {
            let _ = child.wait();
        }
        self.stdin = None;

        let declared = declaration(&spec.driver)
            .ok_or_else(|| format!("{} has no driver declaration in this build", spec.driver))?;
        if declared.driver != ANTIGRAVITY_DRIVER {
            return Err(format!("{} does not speak the antigravity wire", spec.driver));
        }

        let program = match self.program.clone() {
            Some(program) => program,
            None => resolve_antigravity_program()?,
        };
        verify_driver_version(ANTIGRAVITY_DRIVER, &program, self.probe.as_ref())?;
        let args = antigravity_args(&declared, &self.controls, spec.resume_handle.as_deref());
        let args_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let cwd = spec.working_directory.as_deref().map(Path::new);

        let mut child = spawn_streaming(&program, &args_refs, cwd).map_err(|error| {
            format!(
                "could not start the antigravity session with {}: {error}",
                program.display()
            )
        })?;
        let Some(stdout) = child.stdout.take() else {
            let _ = child.kill();
            return Err("the antigravity session started without a readable stdout".to_string());
        };
        let stderr = child.stderr.take();

        self.stdin = child.stdin.take();
        self.child = Some(child);
        self.events.lock().unwrap().clear();
        *self.resume.lock().unwrap() = spec.resume_handle.clone();
        self.eof.store(false, Ordering::SeqCst);
        self.stopping = false;
        self.spawns += 1;

        let events = Arc::clone(&self.events);
        let resume = Arc::clone(&self.resume);
        let eof = Arc::clone(&self.eof);
        self.reader = Some(std::thread::spawn(move || {
            read_antigravity_stdout(stdout, events, resume, eof)
        }));

        let tail = Arc::new(Mutex::new(String::new()));
        self.stderr_tail = Arc::clone(&tail);
        self.stderr_reader = stderr.map(|mut pipe| {
            std::thread::spawn(move || read_tail(&mut pipe, tail))
        });
        Ok(())
    }

    fn write_turn(&mut self, prompt: &str) -> Result<(), String> {
        if self.eof.load(Ordering::SeqCst) {
            return Err("the antigravity session ended before the message was written".to_string());
        }
        let Some(stdin) = self.stdin.as_mut() else {
            return Err("the antigravity session has no open input".to_string());
        };
        stdin
            .write_all(turn_line(prompt).as_bytes())
            .map_err(|error| format!("could not write the message to the antigravity session: {error}"))?;
        stdin
            .flush()
            .map_err(|error| format!("could not flush the antigravity session input: {error}"))
    }

    fn write_frame(&mut self, frame: &str) -> Result<(), String> {
        if self.eof.load(Ordering::SeqCst) {
            return Err("the antigravity session ended before the frame was written".to_string());
        }
        let Some(stdin) = self.stdin.as_mut() else {
            return Err("the antigravity session has no open input".to_string());
        };
        let line = format!("{}\n", frame.trim_end());
        stdin.write_all(line.as_bytes()).map_err(|error| {
            format!("could not write the frame to the antigravity session: {error}")
        })?;
        stdin.flush().map_err(|error| {
            format!("could not flush the antigravity session input: {error}")
        })
    }

    fn interrupt(&mut self) -> Result<(), String> {
        self.stop_process();
        Ok(())
    }

    fn stop(&mut self) -> Result<(), String> {
        self.stop_process();
        Ok(())
    }

    fn spawn_count(&self) -> u32 {
        self.spawns
    }

    fn resume_handle(&self) -> Option<String> {
        self.resume.lock().ok().and_then(|handle| handle.clone())
    }

    fn drain(&mut self) -> Vec<TransportEvent> {
        let mut events: Vec<TransportEvent> = self
            .events
            .lock()
            .map(|mut queue| queue.drain(..).collect())
            .unwrap_or_default();

        let reader_finished = self.reader.as_ref().map(JoinHandle::is_finished).unwrap_or(false);
        if reader_finished && !self.stopping && self.eof.load(Ordering::SeqCst) {
            if let Some(mut child) = self.child.take() {
                let code = child.wait().ok();
                let tail = self
                    .stderr_tail
                    .lock()
                    .map(|tail| tail.clone())
                    .unwrap_or_default();
                let error = match code {
                    Some(0) => None,
                    Some(other) => Some(format!("antigravity exited with code {other}{}", tail_detail(&tail))),
                    None => None,
                };
                events.push(TransportEvent::Exit { code, error });
            }
            self.reader = None;
            self.stdin = None;
            if let Some(reader) = self.stderr_reader.take() {
                let _ = reader.join();
            }
        }

        events
    }
}

impl Drop for AntigravitySession {
    fn drop(&mut self) {
        self.stdin = None;
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
        }
    }
}

fn read_antigravity_stdout(
    stdout: Box<dyn Read + Send>,
    events: Arc<Mutex<VecDeque<TransportEvent>>>,
    resume: Arc<Mutex<Option<String>>>,
    eof: Arc<AtomicBool>,
) {
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {
                let parsed = parse_antigravity_line(&line);
                if let Some(conversation) = parsed.conversation_id {
                    if let Ok(mut handle) = resume.lock() {
                        *handle = Some(conversation);
                    }
                }
                if let Ok(mut queue) = events.lock() {
                    for event in parsed.events {
                        push_bounded(&mut queue, event);
                    }
                }
            }
            Err(_) => break,
        }
    }
    eof.store(true, Ordering::SeqCst);
}

fn push_bounded(queue: &mut VecDeque<TransportEvent>, event: TransportEvent) {
    if queue.len() >= MAX_PENDING_EVENTS {
        queue.pop_front();
    }
    queue.push_back(event);
}

/// Native launcher paths for a global npm install on Windows. The
/// extensionless `opencode` entry on PATH is a shell script, which the process
/// helper cannot start, so the packaged executable is preferred when present.
pub fn opencode_native_paths() -> Vec<String> {
    let mut paths = Vec::new();
    if let Ok(appdata) = std::env::var("APPDATA") {
        paths.push(
            PathBuf::from(appdata)
                .join("npm")
                .join("node_modules")
                .join("@opencode")
                .join("cli")
                .join("bin")
                .join("opencode.exe")
                .to_string_lossy()
                .to_string(),
        );
    }
    paths
}

/// Resolves the observed OpenCode launcher. A missing binary is a hard error so
/// the caller keeps one command per turn instead of pretending a server exists.
pub fn resolve_opencode_program() -> Result<PathBuf, String> {
    let natives = opencode_native_paths();
    let fallbacks: Vec<&str> = natives.iter().map(String::as_str).collect();
    resolve_bin("opencode", &fallbacks).ok_or_else(|| {
        "OpenCode CLI (opencode) is not installed; a lasting session cannot start without it"
            .to_string()
    })
}

/// The documented `opencode serve` invocation. `--hostname` and `--port` are
/// the CLI's own flags; a bound, dropped listener picks the port so two threads
/// do not collide.
pub fn opencode_serve_args(port: u16) -> Vec<String> {
    vec![
        "serve".to_string(),
        "--hostname".to_string(),
        OPENCODE_SERVE_HOST.to_string(),
        "--port".to_string(),
        port.to_string(),
    ]
}

/// The server URL the documented `--server` client flag connects to.
pub fn opencode_server_url(port: u16) -> String {
    format!("http://{OPENCODE_SERVE_HOST}:{port}")
}

/// One turn is one documented client invocation against the server that owns
/// the thread's session. `run` is the documented "run with a message" entry,
/// `--server` and `--session` are its documented flags, and the message is its
/// documented positional. `--session` documents that a missing id is created.
/// The prompt is in argv, not stdin, because the client documents no stdin
/// frame.
pub fn opencode_turn_args(port: u16, session_key: &str, prompt: &str) -> Vec<String> {
    opencode_turn_args_with_model(port, session_key, prompt, None)
}

/// `opencode run --help` documents `--model provider/model#variant` on the same
/// command that continues a server session. The variant is the effort level.
pub fn opencode_model_arg(model: &str, effort: Option<&str>) -> String {
    let Some(level) = effort.map(str::trim).filter(|level| !level.is_empty()) else {
        return model.to_string();
    };
    match model.split_once('#') {
        Some((base, _)) if !base.is_empty() => format!("{base}#{level}"),
        _ => format!("{model}#{level}"),
    }
}

pub fn opencode_turn_args_with_model(
    port: u16,
    session_key: &str,
    prompt: &str,
    model: Option<&str>,
) -> Vec<String> {
    let mut args = vec![
        "run".to_string(),
        "--server".to_string(),
        opencode_server_url(port),
        "--session".to_string(),
        session_key.to_string(),
    ];
    if let Some(model) = model.map(str::trim).filter(|model| !model.is_empty()) {
        args.push("--model".to_string());
        args.push(model.to_string());
    }
    args.push(prompt.to_string());
    args
}

/// Picks a free loopback port for one thread's server by binding and releasing
/// it. The small reuse window is covered by the handshake below: a server that
/// cannot bind fails the handshake and the turn falls back.
pub fn reserve_local_port() -> Result<u16, String> {
    let listener = TcpListener::bind((OPENCODE_SERVE_HOST, 0)).map_err(|error| {
        format!("could not reserve a local port for the opencode server: {error}")
    })?;
    listener
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| format!("could not read the reserved opencode port: {error}"))
}

/// The handshake for a local server: a TCP connection must be accepted before a
/// turn is written. It reads no bytes and sends no frame, so nothing about the
/// server's protocol is guessed.
pub fn wait_for_server(port: u16, timeout: Duration) -> Result<(), String> {
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let deadline = Instant::now() + timeout;
    let mut last_error;
    loop {
        match TcpStream::connect_timeout(&address, Duration::from_millis(250)) {
            Ok(stream) => {
                drop(stream);
                return Ok(());
            }
            Err(error) => last_error = error.to_string(),
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "no connection was accepted on {} within {} ms: {last_error}",
                opencode_server_url(port),
                timeout.as_millis()
            ));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Structured provider JSON frames (`tool_call`, `tool_use`, `tool_result`,
/// `thinking`, `reasoning`, `step_start`, `step_finish`, `session/update`)
/// are routed as `Activity`; plain text and unrecognized objects stay `Text`.
pub fn opencode_line_event(line: &str) -> Option<TransportEvent> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.starts_with('{') {
        if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
            let kind = value
                .get("type")
                .or_else(|| value.get("event"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let method = value.get("method").and_then(Value::as_str).unwrap_or("");
            if matches!(
                kind,
                "tool_call"
                    | "tool_use"
                    | "tool_result"
                    | "thinking"
                    | "reasoning"
                    | "text_delta"
                    | "content_block_delta"
                    | "step_start"
                    | "step_finish"
                    | "turn.completed"
                    | "turn_completed"
            ) || matches!(
                method,
                "session/update"
                    | "_x.ai/session/update"
                    | "x.ai/session/update"
                    | "session/request_permission"
                    | "permission/request"
            ) {
                return Some(TransportEvent::Activity(trimmed.to_string()));
            }
        }
    }
    Some(TransportEvent::Text(trimmed.to_string()))
}

/// The OpenCode lasting session. One server process owns the thread's session;
/// each turn is one documented client invocation against that server. The
/// server is the process this transport spawns and counts.
pub struct OpenCodeServerSession {
    program: Option<PathBuf>,
    probe: Box<dyn DriverProbe>,
    working_directory: Option<PathBuf>,
    server: Option<HiddenChild>,
    server_streams: Option<JoinHandle<()>>,
    server_eof: Arc<AtomicBool>,
    server_tail: Arc<Mutex<String>>,
    port: Option<u16>,
    session_key: Option<String>,
    /// Model id for each turn, including `#level` when a level was chosen.
    model_arg: Option<String>,
    turn: Option<HiddenChild>,
    turn_streams: Option<JoinHandle<()>>,
    turn_eof: Arc<AtomicBool>,
    turn_tail: Arc<Mutex<String>>,
    events: Arc<Mutex<VecDeque<TransportEvent>>>,
    stopping: bool,
    spawns: u32,
}

impl OpenCodeServerSession {
    pub fn new() -> Self {
        Self::with_probe(None, Box::new(SystemDriverProbe))
    }

    /// `program` is injectable so failures can be tested without an installed
    /// provider.
    pub fn with_program(program: Option<PathBuf>) -> Self {
        Self::with_probe(program, Box::new(SystemDriverProbe))
    }

    /// Keeps the chosen model on the server session. Each later turn passes it
    /// as `--model`; the running server process is not rewritten.
    pub fn with_controls(controls: PersistentControls) -> Self {
        let mut session = Self::new();
        session.model_arg = controls.model.as_deref().filter(|model| !model.trim().is_empty()).map(|model| {
            opencode_model_arg(model.trim(), controls.effort.as_deref())
        });
        session
    }

    pub fn with_probe(program: Option<PathBuf>, probe: Box<dyn DriverProbe>) -> Self {
        Self {
            program,
            probe,
            working_directory: None,
            server: None,
            server_streams: None,
            server_eof: Arc::new(AtomicBool::new(true)),
            server_tail: Arc::new(Mutex::new(String::new())),
            port: None,
            session_key: None,
            model_arg: None,
            turn: None,
            turn_streams: None,
            turn_eof: Arc::new(AtomicBool::new(true)),
            turn_tail: Arc::new(Mutex::new(String::new())),
            events: Arc::new(Mutex::new(VecDeque::new())),
            stopping: false,
            spawns: 0,
        }
    }

    fn take_events(&self) -> Vec<TransportEvent> {
        self.events
            .lock()
            .map(|mut queue| queue.drain(..).collect())
            .unwrap_or_default()
    }

    fn stop_turn(&mut self) {
        self.turn_eof.store(true, Ordering::SeqCst);
        if let Some(mut child) = self.turn.take() {
            let _ = child.kill();
        }
        // The killed client closes its pipes, so its reader observes EOF and
        // can be joined before the next turn writes into the same queue.
        if let Some(reader) = self.turn_streams.take() {
            let _ = reader.join();
        }
    }

    fn stop_process(&mut self) {
        self.stopping = true;
        self.stop_turn();
        if let Some(mut child) = self.server.take() {
            let _ = child.kill();
        }
        if let Some(reader) = self.server_streams.take() {
            let _ = reader.join();
        }
        self.port = None;
        self.session_key = None;
    }
}

impl Default for OpenCodeServerSession {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Debug for OpenCodeServerSession {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OpenCodeServerSession")
            .field("program", &self.program)
            .field("port", &self.port)
            .field("spawns", &self.spawns)
            .finish()
    }
}

impl SessionTransport for OpenCodeServerSession {
    fn spawn(&mut self, spec: &TransportSpec) -> Result<(), String> {
        if self.server.is_some() && !self.server_eof.load(Ordering::SeqCst) {
            return Err("the opencode session already has a running server".to_string());
        }
        self.stop_process();
        self.stopping = false;

        let declared = declaration(&spec.driver)
            .ok_or_else(|| format!("{} has no driver declaration in this build", spec.driver))?;
        if declared.driver != OPENCODE_DRIVER {
            return Err(format!(
                "{} does not speak the opencode server wire",
                spec.driver
            ));
        }

        let program = match self.program.clone() {
            Some(program) => program,
            None => resolve_opencode_program()?,
        };
        verify_driver_version(OPENCODE_DRIVER, &program, self.probe.as_ref())?;

        let port = reserve_local_port()?;
        let args = opencode_serve_args(port);
        let args_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let working_directory = spec.working_directory.as_deref().map(PathBuf::from);
        let cwd = working_directory.as_deref();

        let mut child = spawn_streaming(&program, &args_refs, cwd).map_err(|error| {
            format!(
                "could not start the opencode server with {}: {error}",
                program.display()
            )
        })?;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        self.program = Some(program);
        self.working_directory = working_directory;
        self.server = Some(child);
        self.port = Some(port);
        self.session_key = spec.resume_handle.clone().or_else(|| Some(spec.session_id.clone()));
        self.events.lock().unwrap().clear();

        let eof = Arc::new(AtomicBool::new(false));
        let tail = Arc::new(Mutex::new(String::new()));
        self.server_eof = Arc::clone(&eof);
        self.server_tail = Arc::clone(&tail);
        self.server_streams = Some(std::thread::spawn(move || {
            drain_server_streams(stdout, stderr, tail, eof)
        }));
        self.spawns += 1;

        if let Err(reason) = wait_for_server(port, OPENCODE_HANDSHAKE_TIMEOUT) {
            let tail = self
                .server_tail
                .lock()
                .map(|tail| tail.clone())
                .unwrap_or_default();
            self.stop_process();
            return Err(format!(
                "the opencode server did not complete its handshake: {reason}{}",
                tail_detail(&tail)
            ));
        }
        Ok(())
    }

    fn write_turn(&mut self, prompt: &str) -> Result<(), String> {
        if self.server.is_none() || self.server_eof.load(Ordering::SeqCst) {
            return Err("the opencode server exited before the message was written".to_string());
        }
        if self.turn.is_some() && !self.turn_eof.load(Ordering::SeqCst) {
            return Err("the opencode session is still answering the previous turn".to_string());
        }
        let port = self
            .port
            .ok_or_else(|| "the opencode server has no port".to_string())?;
        let session_key = self
            .session_key
            .clone()
            .ok_or_else(|| "the opencode server has no session".to_string())?;
        let program = self
            .program
            .clone()
            .ok_or_else(|| "the opencode server has no program".to_string())?;

        self.stop_turn();

        let args = opencode_turn_args_with_model(port, &session_key, prompt, self.model_arg.as_deref());
        let args_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let mut child = spawn_streaming(&program, &args_refs, self.working_directory.as_deref())
            .map_err(|error| {
                format!(
                    "could not write the turn to the opencode server with {}: {error}",
                    program.display()
                )
            })?;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        self.turn = Some(child);
        let eof = Arc::new(AtomicBool::new(false));
        let tail = Arc::new(Mutex::new(String::new()));
        self.turn_eof = Arc::clone(&eof);
        self.turn_tail = Arc::clone(&tail);
        let events = Arc::clone(&self.events);
        self.turn_streams = Some(std::thread::spawn(move || {
            drain_turn_streams(stdout, stderr, events, tail, eof)
        }));
        Ok(())
    }

    fn interrupt(&mut self) -> Result<(), String> {
        // The turn client is the interruption point; the server keeps the
        // session so a later turn can continue it.
        self.stop_turn();
        Ok(())
    }

    fn stop(&mut self) -> Result<(), String> {
        self.stop_process();
        Ok(())
    }

    fn spawn_count(&self) -> u32 {
        self.spawns
    }

    fn resume_handle(&self) -> Option<String> {
        self.session_key.clone()
    }

    fn drain(&mut self) -> Vec<TransportEvent> {
        let mut events = self.take_events();

        let turn_finished = self.turn.is_some()
            && self.turn_eof.load(Ordering::SeqCst)
            && self
                .turn_streams
                .as_ref()
                .map(JoinHandle::is_finished)
                .unwrap_or(false);
        if turn_finished {
            if let Some(mut child) = self.turn.take() {
                let code = child.wait().ok();
                let tail = self
                    .turn_tail
                    .lock()
                    .map(|tail| tail.clone())
                    .unwrap_or_default();
                events.push(match code {
                    Some(0) => TransportEvent::TurnEnded,
                    Some(other) => TransportEvent::TurnFailed(format!(
                        "opencode exited with code {other}{}",
                        tail_detail(&tail)
                    )),
                    None => TransportEvent::TurnFailed(format!(
                        "opencode exited without a status code{}",
                        tail_detail(&tail)
                    )),
                });
            }
            self.turn_streams = None;
        }

        let server_finished = !self.stopping
            && self.server.is_some()
            && self.server_eof.load(Ordering::SeqCst)
            && self
                .server_streams
                .as_ref()
                .map(JoinHandle::is_finished)
                .unwrap_or(false);
        if server_finished {
            if let Some(mut child) = self.server.take() {
                let code = child.wait().ok();
                let tail = self
                    .server_tail
                    .lock()
                    .map(|tail| tail.clone())
                    .unwrap_or_default();
                let error = if code == Some(0) {
                    None
                } else {
                    Some(format!(
                        "opencode serve exited with code {}{}",
                        code.map(|code| code.to_string())
                            .unwrap_or_else(|| "unknown".to_string()),
                        tail_detail(&tail)
                    ))
                };
                events.push(TransportEvent::Exit { code, error });
            }
            self.server_streams = None;
            self.port = None;
            self.session_key = None;
        }

        events
    }
}

impl Drop for OpenCodeServerSession {
    fn drop(&mut self) {
        self.stopping = true;
        if let Some(mut child) = self.turn.take() {
            let _ = child.kill();
        }
        if let Some(mut child) = self.server.take() {
            let _ = child.kill();
        }
    }
}

fn drain_turn_streams(
    stdout: Option<Box<dyn Read + Send>>,
    stderr: Option<Box<dyn Read + Send>>,
    events: Arc<Mutex<VecDeque<TransportEvent>>>,
    tail: Arc<Mutex<String>>,
    eof: Arc<AtomicBool>,
) {
    let stderr_tail = Arc::clone(&tail);
    let stderr_reader = stderr.map(|mut pipe| {
        std::thread::spawn(move || read_tail(&mut pipe, stderr_tail))
    });
    if let Some(stdout) = stdout {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {
                    if let Some(event) = opencode_line_event(&line) {
                        if let Ok(mut queue) = events.lock() {
                            push_bounded(&mut queue, event);
                        }
                    }
                }
                Err(_) => break,
            }
        }
    }
    if let Some(reader) = stderr_reader {
        let _ = reader.join();
    }
    eof.store(true, Ordering::SeqCst);
}

fn drain_server_streams(
    stdout: Option<Box<dyn Read + Send>>,
    stderr: Option<Box<dyn Read + Send>>,
    tail: Arc<Mutex<String>>,
    eof: Arc<AtomicBool>,
) {
    let stderr_tail = Arc::clone(&tail);
    let stderr_reader = stderr.map(|mut pipe| {
        std::thread::spawn(move || read_tail(&mut pipe, stderr_tail))
    });
    if let Some(mut stdout) = stdout {
        // The server's own output is not the turn transcript. It is drained so
        // the pipe cannot fill and block the server; only stderr is kept for a
        // bounded exit diagnostic.
        let mut buffer = [0u8; 4096];
        loop {
            match stdout.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
        }
    }
    if let Some(reader) = stderr_reader {
        let _ = reader.join();
    }
    eof.store(true, Ordering::SeqCst);
}

fn read_tail(pipe: &mut Box<dyn Read + Send>, tail: Arc<Mutex<String>>) {
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

fn tail_detail(tail: &str) -> String {
    let trimmed = tail.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let clipped: String = trimmed.chars().take(400).collect();
    format!(": {clipped}")
}

/// Spawns a background thread that periodically reaps idle sessions
/// exceeding `DEFAULT_IDLE_TIMEOUT_MS`.
pub fn start_idle_reaper() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        std::thread::Builder::new()
            .name("chat-session-reaper".to_string())
            .spawn(|| loop {
                std::thread::sleep(std::time::Duration::from_secs(60));
                let mut manager = match crate::chat::runtime::session_manager().lock() {
                    Ok(m) => m,
                    Err(_) => continue,
                };
                let reaped = manager.reap_idle_sessions(crate::chat::session::DEFAULT_IDLE_TIMEOUT_MS);
                if !reaped.is_empty() {
                    crate::chat::utils::chat_log(&format!(
                        "reaped {} idle session(s): {:?}",
                        reaped.len(),
                        reaped
                    ));
                }
            })
            .expect("failed to spawn chat session reaper thread");
    });
}

/// The lasting channel `grok agent stdio --help` documents. Permission flags
/// from `grok --help` sit before `agent`. Model and effort are not argv here:
/// they are set on the open session before the message.
pub const GROK_STDIO_TAIL: [&str; 2] = ["agent", "stdio"];

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

fn rpc_line(id: u64, method: &str, params: Value) -> String {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    })
    .to_string()
}

/// `initialize` for ACP stdio. Client `fs` and `terminal` overrides are omitted
/// so the provider executes its native filesystem and shell tools directly.
pub fn grok_initialize_line(id: u64) -> String {
    rpc_line(
        id,
        "initialize",
        json!({
            "protocolVersion": 1,
            "clientCapabilities": {}
        }),
    )
}

/// `session/new` as the installed session guide documents it. No `_meta`.
pub fn grok_session_new_line(id: u64, cwd: &str) -> String {
    rpc_line(
        id,
        "session/new",
        json!({
            "cwd": cwd,
            "mcpServers": []
        }),
    )
}

/// `session/load` as the installed session guide documents it.
pub fn grok_session_load_line(id: u64, session_id: &str, cwd: &str) -> String {
    rpc_line(
        id,
        "session/load",
        json!({
            "sessionId": session_id,
            "cwd": cwd,
            "mcpServers": []
        }),
    )
}

/// `session/set_config_option` for `model` or `reasoning_effort`.
pub fn grok_config_line(id: u64, session_id: &str, config_id: &str, value: &str) -> String {
    rpc_line(
        id,
        "session/set_config_option",
        json!({
            "sessionId": session_id,
            "configId": config_id,
            "value": { "value": value }
        }),
    )
}

/// `session/prompt` as the installed agent-mode example documents it.
pub fn grok_prompt_line(id: u64, session_id: &str, prompt: &str) -> String {
    rpc_line(
        id,
        "session/prompt",
        json!({
            "sessionId": session_id,
            "prompt": [{ "type": "text", "text": prompt }]
        }),
    )
}

fn trimmed_control(value: &Option<String>) -> Option<&str> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

/// Model, then effort, then the message. Each line is one documented request.
pub fn grok_turn_lines(
    session_id: &str,
    controls: &PersistentControls,
    prompt: &str,
    next_id: &mut u64,
) -> Vec<String> {
    let mut lines = Vec::new();
    if let Some(model) = trimmed_control(&controls.model) {
        lines.push(grok_config_line(*next_id, session_id, "model", model));
        *next_id += 1;
    }
    if let Some(effort) = trimmed_control(&controls.effort) {
        lines.push(grok_config_line(
            *next_id,
            session_id,
            "reasoning_effort",
            effort,
        ));
        *next_id += 1;
    }
    lines.push(grok_prompt_line(*next_id, session_id, prompt));
    *next_id += 1;
    lines
}

fn rpc_request_id(value: &Value) -> Option<String> {
    let id = value.get("id")?;
    if id.is_null() {
        return None;
    }
    if let Some(number) = id.as_u64() {
        return Some(number.to_string());
    }
    if let Some(number) = id.as_i64() {
        return Some(number.to_string());
    }
    let text = id.as_str()?.trim();
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
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

fn json_id(value: &Value) -> Option<u64> {
    value.get("id").and_then(|id| {
        id.as_u64()
            .or_else(|| id.as_str().and_then(|text| text.parse().ok()))
    })
}

fn session_id_of(value: &Value) -> Option<String> {
    ["/result/sessionId", "/params/sessionId"]
        .iter()
        .filter_map(|pointer| value.pointer(pointer).and_then(Value::as_str))
        .map(str::trim)
        .find(|candidate| !candidate.is_empty())
        .map(str::to_string)
}

fn rpc_error_text(value: &Value) -> String {
    value
        .get("error")
        .and_then(|error| {
            error
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| error.as_str().map(str::to_string))
        })
        .unwrap_or_else(|| "no detail was reported".to_string())
}

/// One stdout line from `agent stdio`. A known message chunk becomes text.
/// A prompt response ends the turn. Anything else stays a notice.
pub fn parse_grok_line(line: &str, prompt_id: Option<u64>) -> ParsedLine {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return ParsedLine::default();
    }
    let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
        return ParsedLine {
            conversation_id: None,
            events: vec![TransportEvent::Notice(bounded_notice(&format!(
                "grok wrote a non-JSON line (schema=non-json): {trimmed}"
            )))],
        };
    };

    let id = json_id(&value);
    let method = value.get("method").and_then(Value::as_str);
    if method.is_none() && (value.get("result").is_some() || value.get("error").is_some()) {
        let conversation_id = session_id_of(&value);
        if prompt_id.is_some() && id == prompt_id {
            if value.get("error").is_some() {
                return ParsedLine {
                    conversation_id,
                    events: vec![TransportEvent::TurnFailed(bounded_notice(&format!(
                        "grok reported an error: {}",
                        rpc_error_text(&value)
                    )))],
                };
            }
            return ParsedLine {
                conversation_id,
                events: vec![TransportEvent::TurnEnded],
            };
        }
        return ParsedLine {
            conversation_id,
            events: Vec::new(),
        };
    }

    if matches!(
        method,
        Some("session/update") | Some("_x.ai/session/update") | Some("x.ai/session/update")
    ) {
        return parse_grok_update(trimmed, &value);
    }
    if matches!(
        method,
        Some("session/request_permission")
            | Some("permission/request")
            | Some("x.ai/ask_user_question")
            | Some("_x.ai/ask_user_question")
            | Some("AskUserQuestion")
            | Some("x.ai/exit_plan_mode")
            | Some("_x.ai/exit_plan_mode")
    ) {
        return ParsedLine {
            conversation_id: session_id_of(&value),
            events: vec![TransportEvent::Activity(trimmed.to_string())],
        };
    }

    if method.is_some() {
        if let Some(id) = rpc_request_id(&value) {
            return ParsedLine {
                conversation_id: session_id_of(&value),
                events: vec![TransportEvent::UnhandledRequest { id }],
            };
        }
    }

    ParsedLine {
        conversation_id: session_id_of(&value),
        events: vec![TransportEvent::Notice(bounded_notice(&format!(
            "grok sent an unknown frame (schema={})",
            frame_schema(&value)
        )))],
    }
}

fn parse_grok_update(raw: &str, value: &Value) -> ParsedLine {
    let update = value.pointer("/params/update").cloned().unwrap_or(Value::Null);
    let kind = update
        .get("sessionUpdate")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let text = update
        .pointer("/content/text")
        .and_then(Value::as_str)
        .unwrap_or("");
    let events = match kind {
        "agent_message_chunk" if !text.is_empty() => {
            vec![TransportEvent::Text(text.to_string())]
        }
        "agent_message_chunk" => Vec::new(),
        // These frames are actions. A notice is not drawn in the transcript.
        "agent_thought_chunk"
        | "tool_call"
        | "tool_call_update"
        | "tool_call_content_chunk"
        | "plan"
        | "plan_update"
        | "usage_update" => {
            vec![TransportEvent::Activity(raw.to_string())]
        }
        "turn_completed" | "turn_complete" => {
            let mut out = Vec::new();
            if update.get("usage").is_some() {
                out.push(TransportEvent::Activity(raw.to_string()));
            }
            out.push(TransportEvent::TurnEnded);
            out
        }
        "available_commands_update"
        | "session_info_update"
        | "hook_execution"
        | "config_option_update"
        | "current_mode_update"
        | "mode_update"
        | "commands_update"
        | "user_message_chunk" => Vec::new(),
        other => vec![TransportEvent::Notice(bounded_notice(&format!(
            "grok session update `{other}` is not projected (schema={})",
            frame_schema(&update)
        )))],
    };
    ParsedLine {
        conversation_id: session_id_of(value),
        events,
    }
}

/// Resolves the grok launcher. A missing binary is a hard error so the caller
/// keeps one command per turn instead of pretending a session exists.
pub fn resolve_grok_program() -> Result<PathBuf, String> {
    let home = crate::quota::utils::user_home_dir();
    let grok_user = home.join(".grok").join("bin").join("grok.exe");
    resolve_bin("grok", &[&grok_user.to_string_lossy()]).ok_or_else(|| {
        "grok is not installed; a lasting session cannot start without it".to_string()
    })
}

/// Lines a test session wrote, and the argv of the one process it spawned.
#[derive(Debug, Clone, Default)]
pub struct GrokRecord {
    inner: Arc<Mutex<GrokRecordState>>,
}

#[derive(Debug, Default)]
struct GrokRecordState {
    spawns: u32,
    args: Vec<String>,
    written: Vec<String>,
}

impl GrokRecord {
    fn new() -> Self {
        Self::default()
    }

    pub fn spawn_count(&self) -> u32 {
        self.inner.lock().map(|state| state.spawns).unwrap_or(0)
    }

    pub fn args(&self) -> Vec<String> {
        self.inner
            .lock()
            .map(|state| state.args.clone())
            .unwrap_or_default()
    }

    pub fn written(&self) -> Vec<String> {
        self.inner
            .lock()
            .map(|state| state.written.clone())
            .unwrap_or_default()
    }

    fn note_spawn(&self, args: &[String]) {
        if let Ok(mut state) = self.inner.lock() {
            state.spawns += 1;
            state.args = args.to_vec();
        }
    }

    fn note_written(&self, lines: &[String]) {
        if let Ok(mut state) = self.inner.lock() {
            state.written.extend(lines.iter().cloned());
        }
    }
}

/// One grok process on `agent stdio`. A second turn writes to that process.
pub struct GrokSession {
    controls: PersistentControls,
    program: Option<PathBuf>,
    probe: Box<dyn DriverProbe>,
    record: Option<GrokRecord>,
    child: Option<HiddenChild>,
    stdin: Option<Box<dyn Write + Send>>,
    reader: Option<JoinHandle<()>>,
    events: Arc<Mutex<VecDeque<TransportEvent>>>,
    responses: Arc<Mutex<VecDeque<Value>>>,
    ready: Arc<Condvar>,
    resume: Arc<Mutex<Option<String>>>,
    prompt_id: Arc<Mutex<Option<u64>>>,
    eof: Arc<AtomicBool>,
    stopping: bool,
    spawns: u32,
    next_id: u64,
}

impl GrokSession {
    pub fn new(controls: PersistentControls) -> Self {
        Self::with_probe(controls, None, Box::new(SystemDriverProbe))
    }

    pub fn with_probe(
        controls: PersistentControls,
        program: Option<PathBuf>,
        probe: Box<dyn DriverProbe>,
    ) -> Self {
        Self {
            controls,
            program,
            probe,
            record: None,
            child: None,
            stdin: None,
            reader: None,
            events: Arc::new(Mutex::new(VecDeque::new())),
            responses: Arc::new(Mutex::new(VecDeque::new())),
            ready: Arc::new(Condvar::new()),
            resume: Arc::new(Mutex::new(None)),
            prompt_id: Arc::new(Mutex::new(None)),
            eof: Arc::new(AtomicBool::new(false)),
            stopping: false,
            spawns: 0,
            next_id: 1,
        }
    }

    /// Records argv and session frames without starting a process.
    #[cfg(test)]
    pub fn recorded(controls: PersistentControls) -> (Self, GrokRecord) {
        let record = GrokRecord::new();
        let mut session = Self::with_probe(
            controls,
            Some(PathBuf::from("kite-recorded-grok")),
            Box::new(RecordedProbe),
        );
        session.record = Some(record.clone());
        (session, record)
    }

    fn alloc_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    fn provider_session_id(&self) -> Option<String> {
        self.resume.lock().ok().and_then(|handle| handle.clone())
    }

    fn stop_process(&mut self) {
        self.stopping = true;
        self.stdin = None;
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
        }
    }

    fn fail_start(&mut self, reason: String) -> Result<(), String> {
        self.stop_process();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
        if let Ok(mut handle) = self.resume.lock() {
            *handle = None;
        }
        Err(reason)
    }

    fn checked_launch(&self, spec: &TransportSpec) -> Result<(PathBuf, Vec<String>), String> {
        let declared = declaration(&spec.driver)
            .ok_or_else(|| format!("{} has no driver declaration in this build", spec.driver))?;
        if declared.driver != GROK_DRIVER {
            return Err(format!("{} does not speak the grok stdio wire", spec.driver));
        }
        let program = match self.program.clone() {
            Some(program) => program,
            None => resolve_grok_program()?,
        };
        verify_driver_version(GROK_DRIVER, &program, self.probe.as_ref())?;
        let args = grok_session_args(self.controls.permission_mode.as_deref());
        Ok((program, args))
    }

    fn spawn_recorded(&mut self, spec: &TransportSpec) -> Result<(), String> {
        let (_program, args) = self.checked_launch(spec)?;
        let record = self
            .record
            .clone()
            .ok_or_else(|| "the recorded grok session has no record".to_string())?;
        let session_id = spec
            .resume_handle
            .clone()
            .filter(|handle| !handle.trim().is_empty())
            .unwrap_or_else(|| "recorded-session".to_string());
        if let Ok(mut handle) = self.resume.lock() {
            *handle = Some(session_id);
        }
        record.note_spawn(&args);
        self.spawns += 1;
        self.stopping = false;
        self.eof.store(false, Ordering::SeqCst);
        Ok(())
    }

    fn write_raw(&mut self, frame: &str) -> Result<(), String> {
        let Some(stdin) = self.stdin.as_mut() else {
            return Err("the grok session has no open input".to_string());
        };
        stdin.write_all(frame.as_bytes()).map_err(|error| {
            format!("could not write the message to the grok session: {error}")
        })?;
        stdin.write_all(b"\n").map_err(|error| {
            format!("could not write the message to the grok session: {error}")
        })?;
        stdin
            .flush()
            .map_err(|error| format!("could not flush the grok session input: {error}"))
    }

    fn wait_response(&self, id: u64) -> Result<Value, String> {
        let deadline = Instant::now() + GROK_HANDSHAKE_TIMEOUT;
        let mut queue = self
            .responses
            .lock()
            .map_err(|_| "the session queue lock was poisoned".to_string())?;
        loop {
            if let Some(index) = queue.iter().position(|value| json_id(value) == Some(id)) {
                return Ok(queue.remove(index).expect("the matched response is present"));
            }
            if self.eof.load(Ordering::SeqCst) {
                return Err("the session ended before it answered".to_string());
            }
            let now = Instant::now();
            if now >= deadline {
                return Err(format!(
                    "the session did not answer within {} ms",
                    GROK_HANDSHAKE_TIMEOUT.as_millis()
                ));
            }
            let (next, _) = self
                .ready
                .wait_timeout(queue, deadline - now)
                .map_err(|_| "the session queue lock was poisoned".to_string())?;
            queue = next;
        }
    }

    fn open_session(&mut self, spec: &TransportSpec) -> Result<(), String> {
        let cwd = spec
            .working_directory
            .as_deref()
            .map(str::trim)
            .filter(|cwd| !cwd.is_empty())
            .unwrap_or(".");
        let init_id = self.alloc_id();
        self.write_raw(&grok_initialize_line(init_id))?;
        let initialized = self.wait_response(init_id)?;
        if initialized.get("error").is_some() {
            return Err(format!(
                "the grok session refused initialize: {}",
                rpc_error_text(&initialized)
            ));
        }
        let open_id = self.alloc_id();
        let open = if let Some(handle) = spec
            .resume_handle
            .as_deref()
            .map(str::trim)
            .filter(|handle| !handle.is_empty())
        {
            grok_session_load_line(open_id, handle, cwd)
        } else {
            grok_session_new_line(open_id, cwd)
        };
        self.write_raw(&open)?;
        let opened = self.wait_response(open_id)?;
        if opened.get("error").is_some() {
            return Err(format!(
                "the grok session refused to open: {}",
                rpc_error_text(&opened)
            ));
        }
        let session_id = session_id_of(&opened).or_else(|| {
            spec.resume_handle
                .as_deref()
                .map(str::trim)
                .filter(|handle| !handle.is_empty())
                .map(str::to_string)
        });
        let Some(session_id) = session_id else {
            return Err("the grok session did not return a session id".to_string());
        };
        if let Ok(mut handle) = self.resume.lock() {
            *handle = Some(session_id);
        }
        Ok(())
    }
}

impl fmt::Debug for GrokSession {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GrokSession")
            .field("controls", &self.controls)
            .field("program", &self.program)
            .field("spawns", &self.spawns)
            .finish()
    }
}

impl SessionTransport for GrokSession {
    fn spawn(&mut self, spec: &TransportSpec) -> Result<(), String> {
        if self.record.is_some() {
            return self.spawn_recorded(spec);
        }
        if let Some(reader) = self.reader.take() {
            if reader.is_finished() {
                // The process is gone; the handle is reaped below.
            } else if self.stopping {
                let _ = reader.join();
            } else {
                self.reader = Some(reader);
                return Err("the grok session already has a running process".to_string());
            }
        }
        if let Some(mut child) = self.child.take() {
            let _ = child.wait();
        }
        self.stdin = None;

        let (program, args) = self.checked_launch(spec)?;
        let args_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let cwd = spec.working_directory.as_deref().map(Path::new);
        let mut child = spawn_streaming(&program, &args_refs, cwd).map_err(|error| {
            format!(
                "could not start the grok session with {}: {error}",
                program.display()
            )
        })?;
        let Some(stdout) = child.stdout.take() else {
            let _ = child.kill();
            return Err("the grok session started without a readable stdout".to_string());
        };
        let stderr = child.stderr.take();
        self.stdin = child.stdin.take();
        self.child = Some(child);
        self.events.lock().unwrap().clear();
        self.responses.lock().unwrap().clear();
        self.eof.store(false, Ordering::SeqCst);
        self.stopping = false;
        self.next_id = 1;

        let events = Arc::clone(&self.events);
        let responses = Arc::clone(&self.responses);
        let ready = Arc::clone(&self.ready);
        let resume = Arc::clone(&self.resume);
        let prompt_id = Arc::clone(&self.prompt_id);
        let eof = Arc::clone(&self.eof);
        self.reader = Some(std::thread::spawn(move || {
            read_grok_stdout(stdout, events, responses, ready, resume, prompt_id, eof)
        }));
        if let Some(mut stderr) = stderr {
            std::thread::spawn(move || {
                let tail = Arc::new(Mutex::new(String::new()));
                read_tail(&mut stderr, tail);
            });
        }

        if let Err(reason) = self.open_session(spec) {
            return self.fail_start(reason);
        }
        self.spawns += 1;
        Ok(())
    }

    fn write_frame(&mut self, frame: &str) -> Result<(), String> {
        self.write_raw(frame.trim_end())
    }

    fn write_turn(&mut self, prompt: &str) -> Result<(), String> {
        let session_id = self
            .provider_session_id()
            .ok_or_else(|| "the grok session has no id, so the message was not written".to_string())?;
        let lines = grok_turn_lines(&session_id, &self.controls, prompt, &mut self.next_id);
        let prompt_line_id = self.next_id.saturating_sub(1);
        if let Some(record) = &self.record {
            record.note_written(&lines);
            return Ok(());
        }
        if self.eof.load(Ordering::SeqCst) {
            return Err("the grok session ended before the message was written".to_string());
        }
        if let Ok(mut id) = self.prompt_id.lock() {
            *id = Some(prompt_line_id);
        }
        for line in &lines {
            self.write_raw(line)?;
        }
        Ok(())
    }

    fn interrupt(&mut self) -> Result<(), String> {
        self.stop_process();
        Ok(())
    }

    fn stop(&mut self) -> Result<(), String> {
        self.stop_process();
        Ok(())
    }

    fn spawn_count(&self) -> u32 {
        self.spawns
    }

    fn resume_handle(&self) -> Option<String> {
        self.provider_session_id()
    }

    fn drain(&mut self) -> Vec<TransportEvent> {
        let mut events: Vec<TransportEvent> = self
            .events
            .lock()
            .map(|mut queue| queue.drain(..).collect())
            .unwrap_or_default();
        let reader_finished = self.reader.as_ref().map(JoinHandle::is_finished).unwrap_or(false);
        if reader_finished && !self.stopping && self.eof.load(Ordering::SeqCst) {
            if let Some(mut child) = self.child.take() {
                let code = child.wait().ok();
                let error = match code {
                    Some(0) => None,
                    Some(other) => Some(format!("grok exited with code {other}")),
                    None => None,
                };
                events.push(TransportEvent::Exit { code, error });
            }
            self.reader = None;
            self.stdin = None;
        }
        events
    }
}

impl Drop for GrokSession {
    fn drop(&mut self) {
        self.stdin = None;
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
        }
    }
}

#[cfg(test)]
#[derive(Debug)]
struct RecordedProbe;

#[cfg(test)]
impl DriverProbe for RecordedProbe {
    fn probe(
        &self,
        _driver: &str,
        _program: &Path,
        _evidence: &crate::chat::drivers::DriverVersion,
    ) -> Result<String, String> {
        Ok("grok 1.0.77 (50ca579fa996)".to_string())
    }
}

fn read_grok_stdout(
    stdout: Box<dyn Read + Send>,
    events: Arc<Mutex<VecDeque<TransportEvent>>>,
    responses: Arc<Mutex<VecDeque<Value>>>,
    ready: Arc<Condvar>,
    resume: Arc<Mutex<Option<String>>>,
    prompt_id: Arc<Mutex<Option<u64>>>,
    eof: Arc<AtomicBool>,
) {
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {
                let current = prompt_id.lock().ok().and_then(|id| *id);
                let parsed = parse_grok_line(&line, current);
                if let Some(conversation) = parsed.conversation_id.clone() {
                    if let Ok(mut handle) = resume.lock() {
                        *handle = Some(conversation);
                    }
                }
                if let Ok(value) = serde_json::from_str::<Value>(line.trim()) {
                    if value.get("method").is_none()
                        && (value.get("result").is_some() || value.get("error").is_some())
                    {
                        if let Ok(mut queue) = responses.lock() {
                            queue.push_back(value);
                        }
                        ready.notify_all();
                    }
                }
                if let Ok(mut queue) = events.lock() {
                    for event in parsed.events {
                        if matches!(
                            event,
                            TransportEvent::TurnEnded | TransportEvent::TurnFailed(_)
                        ) {
                            if let Ok(mut id) = prompt_id.lock() {
                                *id = None;
                            }
                        }
                        push_bounded(&mut queue, event);
                    }
                }
            }
            Err(_) => break,
        }
    }
    eof.store(true, Ordering::SeqCst);
    ready.notify_all();
}

#[cfg(test)]
#[path = "persistent_tests.rs"]
mod tests;

