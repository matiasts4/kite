//! Lasting OpenCode server session transport and client invocation.

use std::collections::VecDeque;
use std::fmt;
use std::io::{BufRead, BufReader, Read};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::chat::drivers::{declaration, DriverProbe, SystemDriverProbe};
use crate::chat::session::{SessionTransport, TransportEvent, TransportSpec};
use crate::chat::utils::resolve_bin;
use crate::hidden_exec::{spawn_streaming_with_owned_env, HiddenChild};

use super::controls::{
    push_bounded, read_tail, tail_detail, verify_driver_version, OPENCODE_DRIVER,
    OPENCODE_HANDSHAKE_TIMEOUT, OPENCODE_SERVE_HOST, PersistentControls,
};

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
    extra_env: Vec<(String, String)>,
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
            extra_env: Vec::new(),
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

        let mut child = spawn_streaming_with_owned_env(&program, &args_refs, cwd, &spec.extra_env)
            .map_err(|error| {
            format!(
                "could not start the opencode server with {}: {error}",
                program.display()
            )
        })?;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        self.program = Some(program);
        self.working_directory = working_directory;
        self.extra_env = spec.extra_env.clone();
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
        let mut child = spawn_streaming_with_owned_env(
            &program,
            &args_refs,
            self.working_directory.as_deref(),
            &self.extra_env,
        )
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
