//! Lasting CLI transports for drivers whose wire can stay open.
//!
//! Two lasting wires are wired in this build, each from what its own CLI help
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
use std::sync::{Arc, Mutex};
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

/// The argument prefix the lasting Antigravity wire needs. It is copied from
/// the observed flags: `--print` runs one turn without a prompt positional,
/// `--input-format stream-json` reads one NDJSON message per line, and the
/// matching output format is required by the observed launcher.
pub const ANTIGRAVITY_STREAM_ARGS: [&str; 5] =
    ["--print", "--input-format", "stream-json", "--output-format", "stream-json"];

/// The command `codex app-server --help` documents for its transport. The help
/// output stops at the transport: no request frame that carries a user turn is
/// documented, so this constant is evidence, not a launch this build performs.
pub const CODEX_APP_SERVER_ARGS: [&str; 3] = ["app-server", "--listen", "stdio://"];

/// The host the documented `opencode serve --hostname` flag is given.
pub const OPENCODE_SERVE_HOST: &str = "127.0.0.1";

/// How long a freshly started OpenCode server may take to accept a connection.
/// A server that never answers fails the handshake before any turn is written.
pub const OPENCODE_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);

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
        }
        Some("acceptEdits") if declared.has_work_mode("accept-edits") => {
            args.push("--mode".to_string());
            args.push("accept-edits".to_string());
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
    let message = json!({ "type": "user", "content": prompt });
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
            if step_type == "agent_response" {
                let text = step
                    .get("text_delta")
                    .or_else(|| step.get("text"))
                    .or_else(|| step.get("content"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if text.is_empty() {
                    ParsedLine::default()
                } else {
                    ParsedLine {
                        conversation_id: None,
                        events: vec![TransportEvent::Text(text.to_string())],
                    }
                }
            } else {
                let state = step.get("state").and_then(Value::as_str).unwrap_or("unknown");
                ParsedLine {
                    conversation_id: None,
                    events: vec![TransportEvent::Notice(bounded_notice(&format!(
                        "antigravity {step_type} step ({state}) is not projected by this session yet"
                    )))],
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
    ["/init/conversation_id", "/init/conversationId", "/init/session_id", "/init/sessionId"]
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

        self.stdin = child.stdin.take();
        self.child = Some(child);
        self.events.lock().unwrap().clear();
        *self.resume.lock().unwrap() = None;
        self.eof.store(false, Ordering::SeqCst);
        self.stopping = false;
        self.spawns += 1;

        let events = Arc::clone(&self.events);
        let resume = Arc::clone(&self.resume);
        let eof = Arc::clone(&self.eof);
        self.reader = Some(std::thread::spawn(move || {
            read_antigravity_stdout(stdout, events, resume, eof)
        }));
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
                let error = match code {
                    Some(0) => None,
                    Some(other) => Some(format!("antigravity exited with code {other}")),
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
    vec![
        "run".to_string(),
        "--server".to_string(),
        opencode_server_url(port),
        "--session".to_string(),
        session_key.to_string(),
        prompt.to_string(),
    ]
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

/// The CLI documents flags, not output frames, so a turn's output is projected
/// as plain text. No JSON shape is invented for it.
pub fn opencode_line_event(line: &str) -> Option<TransportEvent> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
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
        self.session_key = Some(spec.session_id.clone());
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

        let args = opencode_turn_args(port, &session_key, prompt);
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
        // The session id is created through the documented create-if-absent
        // flag, so it is not reported as a provider-issued resume handle.
        None
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::drivers::declaration;
    use crate::chat::runtime::MAX_NOTICE_CHARS;
    use crate::chat::session::SessionMode;

    fn controls(
        model: Option<&str>,
        effort: Option<&str>,
        permission_mode: Option<&str>,
    ) -> PersistentControls {
        PersistentControls {
            model: model.map(str::to_string),
            effort: effort.map(str::to_string),
            permission_mode: permission_mode.map(str::to_string),
        }
    }

    fn spec(driver: &str) -> TransportSpec {
        TransportSpec {
            session_id: "thread-1:1".to_string(),
            driver: driver.to_string(),
            working_directory: None,
            mode: SessionMode::Persistent,
            recipe_revision: Some("r1".to_string()),
            resume_handle: None,
        }
    }

    #[test]
    fn the_wire_is_the_observed_stream_json_pair() {
        let declared = declaration("antigravity").expect("antigravity declaration");
        let args = antigravity_args(&declared, &PersistentControls::default(), None);

        assert_eq!(
            args,
            vec![
                "--print".to_string(),
                "--input-format".to_string(),
                "stream-json".to_string(),
                "--output-format".to_string(),
                "stream-json".to_string(),
            ]
        );
    }

    #[test]
    fn controls_reach_the_wire_only_when_the_declaration_accepts_them() {
        let declared = declaration("antigravity").expect("antigravity declaration");
        let args = antigravity_args(
            &declared,
            &controls(Some("gemini-4-argon"), Some("high"), Some("fullAccess")),
            None,
        );
        assert!(args.windows(2).any(|pair| pair == ["--model", "gemini-4-argon"]));
        assert!(args.windows(2).any(|pair| pair == ["--effort", "high"]));
        assert!(args.iter().any(|arg| arg == "--dangerously-skip-permissions"));

        let mut closed = declared.clone();
        closed.accepts_model = false;
        closed.accepts_effort = false;
        closed.accepts_permission = false;
        closed.work_modes.clear();
        let args = antigravity_args(
            &closed,
            &controls(Some("gemini-4-argon"), Some("high"), Some("fullAccess")),
            None,
        );
        for flag in ["--model", "--effort", "--mode", "--dangerously-skip-permissions"] {
            assert!(!args.iter().any(|arg| arg == flag), "{flag} must be omitted");
        }
    }

    #[test]
    fn declared_work_modes_map_to_the_observed_mode_flag() {
        let declared = declaration("antigravity").expect("antigravity declaration");

        let read_only = antigravity_args(&declared, &controls(None, None, Some("readOnly")), None);
        assert!(read_only.windows(2).any(|pair| pair == ["--mode", "plan"]));

        let edits = antigravity_args(&declared, &controls(None, None, Some("acceptEdits")), None);
        assert!(edits.windows(2).any(|pair| pair == ["--mode", "accept-edits"]));

        let unknown = antigravity_args(&declared, &controls(None, None, Some("somethingElse")), None);
        assert!(!unknown.iter().any(|arg| arg == "--mode"));
        assert!(!unknown.iter().any(|arg| arg == "--dangerously-skip-permissions"));
    }

    #[test]
    fn a_resume_handle_is_passed_only_when_the_declaration_accepts_it() {
        let declared = declaration("antigravity").expect("antigravity declaration");
        let args = antigravity_args(&declared, &PersistentControls::default(), Some("conversation-1"));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--conversation", "conversation-1"]));

        let mut closed = declared;
        closed.accepts_resume = false;
        let args = antigravity_args(&closed, &PersistentControls::default(), Some("conversation-1"));
        assert!(!args.iter().any(|arg| arg == "--conversation"));
    }

    #[test]
    fn one_turn_is_one_ndjson_user_line() {
        let line = turn_line("first line\nsecond line");

        assert!(line.ends_with('\n'));
        assert_eq!(line.matches('\n').count(), 1, "a prompt stays one frame");
        let value: Value = serde_json::from_str(line.trim_end()).expect("one JSON object");
        assert_eq!(value.get("type").and_then(Value::as_str), Some("user"));
        assert_eq!(
            value.get("content").and_then(Value::as_str),
            Some("first line\nsecond line")
        );
    }

    #[test]
    fn stream_frames_become_text_notice_and_turn_end() {
        let text = parse_antigravity_line(
            r#"{"event":"step_update","step_update":{"step_type":"agent_response","text_delta":"hello"}}"#,
        );
        assert_eq!(text.events, vec![TransportEvent::Text("hello".to_string())]);

        let init = parse_antigravity_line(r#"{"event":"init","init":{"conversation_id":"conv-1"}}"#);
        assert_eq!(init.conversation_id.as_deref(), Some("conv-1"));
        assert!(init.events.is_empty());

        let success = parse_antigravity_line(r#"{"event":"result","result":{"status":"SUCCESS"}}"#);
        assert_eq!(success.events, vec![TransportEvent::TurnEnded]);

        let failed = parse_antigravity_line(r#"{"event":"result","result":{"status":"ERROR"}}"#);
        assert!(matches!(failed.events.first(), Some(TransportEvent::Notice(_))));
        assert_eq!(failed.events.last(), Some(&TransportEvent::TurnEnded));
    }

    #[test]
    fn unknown_frames_are_bounded_notices_with_provider_and_schema() {
        let huge = format!(
            r#"{{"event":"unheard_of","payload":"{}"}}"#,
            "x".repeat(MAX_NOTICE_CHARS * 2)
        );
        let parsed = parse_antigravity_line(&huge);
        let Some(TransportEvent::Notice(notice)) = parsed.events.first() else {
            panic!("an unknown frame must be a notice");
        };
        assert!(notice.contains("antigravity"));
        assert!(notice.contains("unheard_of"));
        assert!(notice.contains("schema="));
        assert!(notice.chars().count() <= MAX_NOTICE_CHARS);

        let non_json = parse_antigravity_line(&"y".repeat(MAX_NOTICE_CHARS + 100));
        let Some(TransportEvent::Notice(notice)) = non_json.events.first() else {
            panic!("a non-JSON line must be a notice");
        };
        assert!(notice.contains("non-json"));
        assert!(notice.chars().count() <= MAX_NOTICE_CHARS);
    }

    #[test]
    fn a_missing_binary_fails_before_a_process_starts() {
        let mut session = AntigravitySession::with_program(
            PersistentControls::default(),
            Some(PathBuf::from("kite-missing-agy-binary")),
        );

        let error = session.spawn(&spec("antigravity")).expect_err("no binary, no session");

        assert!(
            error.contains("kite-missing-agy-binary"),
            "the failure must name the missing program: {error}"
        );
        assert_eq!(session.spawn_count(), 0);
        assert!(session.drain().is_empty());
    }

    #[test]
    fn the_implemented_wires_are_antigravity_and_opencode() {
        assert!(has_persistent_wire("antigravity"));
        assert!(has_persistent_wire("agy"));
        assert!(has_persistent_wire("opencode"));
        for driver in ["codex", "claude", "gemini", "grok", "cursor", "unknown"] {
            assert!(!has_persistent_wire(driver), "{driver} has no implemented wire");
        }
    }

    #[test]
    fn codex_records_the_documented_app_server_command_and_refuses_it() {
        assert_eq!(CODEX_APP_SERVER_ARGS, ["app-server", "--listen", "stdio://"]);

        let refusal = unsupported_wire("codex").expect("codex must be refused");
        assert!(refusal.starts_with("Unsupported:"), "{refusal}");
        assert!(refusal.contains("app-server"), "{refusal}");
        assert!(refusal.contains("request frame"), "{refusal}");
        assert!(unsupported_wire("antigravity").is_none());
        assert!(unsupported_wire("opencode").is_none());
    }

    #[test]
    fn opencode_serve_uses_the_documented_flags() {
        assert_eq!(
            opencode_serve_args(45871),
            vec![
                "serve".to_string(),
                "--hostname".to_string(),
                "127.0.0.1".to_string(),
                "--port".to_string(),
                "45871".to_string(),
            ]
        );
        assert_eq!(opencode_server_url(45871), "http://127.0.0.1:45871");
    }

    #[test]
    fn an_opencode_turn_is_one_documented_client_invocation() {
        assert_eq!(
            opencode_turn_args(45871, "thread-1:1", "hello"),
            vec![
                "run".to_string(),
                "--server".to_string(),
                "http://127.0.0.1:45871".to_string(),
                "--session".to_string(),
                "thread-1:1".to_string(),
                "hello".to_string(),
            ]
        );
        // `--prompt` is a top-level flag, not a `run` flag, so a turn never
        // forwards it.
        assert!(!opencode_turn_args(45871, "thread-1:1", "hello")
            .iter()
            .any(|arg| arg == "--prompt"));
    }

    #[test]
    fn opencode_output_is_text_and_no_frame_is_invented() {
        assert_eq!(
            opencode_line_event("hello there"),
            Some(TransportEvent::Text("hello there".to_string()))
        );
        assert_eq!(opencode_line_event("   "), None);
        assert_eq!(
            opencode_line_event(r#"{"kind":"unheard_of"}"#),
            Some(TransportEvent::Text(r#"{"kind":"unheard_of"}"#.to_string()))
        );
    }

    #[derive(Debug, Clone)]
    struct FakeProbe {
        raw: Result<String, String>,
    }

    impl crate::chat::drivers::DriverProbe for FakeProbe {
        fn probe(
            &self,
            _driver: &str,
            _program: &Path,
            _evidence: &crate::chat::drivers::DriverVersion,
        ) -> Result<String, String> {
            self.raw.clone()
        }
    }

    fn fake_probe(raw: Result<&str, &str>) -> Box<dyn crate::chat::drivers::DriverProbe> {
        Box::new(FakeProbe {
            raw: raw.map(str::to_string).map_err(str::to_string),
        })
    }

    #[test]
    fn a_version_mismatch_fails_before_any_process_starts() {
        let mut session = AntigravitySession::with_probe(
            PersistentControls::default(),
            Some(PathBuf::from("kite-fake-agy")),
            fake_probe(Ok("agy 1.0.0")),
        );

        let error = session.spawn(&spec("antigravity")).expect_err("stale version");

        assert!(error.contains("older than the minimum"), "{error}");
        assert!(error.contains("1.4.5"), "{error}");
        assert_eq!(session.spawn_count(), 0);
        assert!(session.drain().is_empty());
    }

    #[test]
    fn a_version_probe_that_cannot_run_fails_closed() {
        let mut session = OpenCodeServerSession::with_probe(
            Some(PathBuf::from("kite-fake-opencode")),
            fake_probe(Err("could not run the opencode version probe")),
        );

        let error = session.spawn(&spec("opencode")).expect_err("probe failed");

        assert!(error.contains("version probe"), "{error}");
        assert_eq!(session.spawn_count(), 0);
        assert!(session.drain().is_empty());
    }

    #[test]
    fn a_documented_version_does_not_prove_the_binary_exists() {
        let mut session = OpenCodeServerSession::with_probe(
            Some(PathBuf::from("kite-missing-opencode-binary")),
            fake_probe(Ok("opencode v2.1.4")),
        );

        let error = session.spawn(&spec("opencode")).expect_err("no binary, no server");

        assert!(error.contains("could not start the opencode server"), "{error}");
        assert_eq!(session.spawn_count(), 0);
    }

    #[test]
    fn the_handshake_requires_an_accepting_server() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("test listener");
        let port = listener.local_addr().expect("test address").port();

        wait_for_server(port, Duration::from_millis(500)).expect("a bound listener is ready");
        drop(listener);

        let error = wait_for_server(port, Duration::from_millis(150))
            .expect_err("no listener must fail the handshake");
        assert!(error.contains("127.0.0.1"), "{error}");
        assert!(error.contains("150 ms"), "{error}");
    }
}
