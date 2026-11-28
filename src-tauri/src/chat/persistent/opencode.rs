//! Lasting OpenCode server session transport and client invocation.

use std::collections::VecDeque;
use std::fmt;
use std::io::{BufRead, BufReader, Read};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
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
use super::opencode_pool::{
    acquire_global_opencode_lease, acquire_shared_opencode_lease, opencode_pool_enabled,
    opencode_pool_key, PooledOpenCodeLease, SharedOpenCodeServerPool, SpawnedOpenCodeServer,
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
    for file_path in crate::chat::extract_attachment_file_paths(prompt) {
        args.push("--file".to_string());
        args.push(file_path);
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

#[cfg(test)]
type TestSpawnerHook = Arc<dyn Fn() -> Result<SpawnedOpenCodeServer, String> + Send + Sync>;

fn spawn_opencode_server_process(
    program: &Path,
    cwd: Option<&Path>,
    session_env: &[(String, String)],
) -> Result<SpawnedOpenCodeServer, String> {
    let port = reserve_local_port()?;
    let args = opencode_serve_args(port);
    let args_refs: Vec<&str> = args.iter().map(String::as_str).collect();

    let mut child = spawn_streaming_with_owned_env(program, &args_refs, cwd, session_env)
        .map_err(|error| {
            format!(
                "could not start the opencode server with {}: {error}",
                program.display()
            )
        })?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let eof = Arc::new(AtomicBool::new(false));
    let tail = Arc::new(Mutex::new(String::new()));
    let eof_for_thread = Arc::clone(&eof);
    let tail_for_thread = Arc::clone(&tail);
    let streams = Some(std::thread::spawn(move || {
        drain_server_streams(stdout, stderr, tail_for_thread, eof_for_thread)
    }));

    if let Err(reason) = wait_for_server(port, OPENCODE_HANDSHAKE_TIMEOUT) {
        let _ = child.kill();
        let _ = child.wait();
        if let Some(reader) = streams {
            let _ = reader.join();
        }
        let detail = tail.lock().map(|t| t.clone()).unwrap_or_default();
        return Err(format!(
            "the opencode server did not complete its handshake: {reason}{}",
            tail_detail(&detail)
        ));
    }

    Ok(SpawnedOpenCodeServer {
        port,
        program: program.to_path_buf(),
        server: Some(child),
        server_streams: streams,
        server_eof: eof,
        server_tail: tail,
    })
}

/// The OpenCode lasting session. By default, compatible threads/subagents lease
/// a shared `opencode serve` daemon from [`super::opencode_pool`]; isolated-test
/// constructors (`with_program`, `with_probe`) and `KITE_OPENCODE_POOL=0` keep
/// one dedicated server process per session.
pub struct OpenCodeServerSession {
    program: Option<PathBuf>,
    probe: Box<dyn DriverProbe>,
    connection_id: Option<String>,
    use_pool: bool,
    pool_override: Option<(Arc<Mutex<SharedOpenCodeServerPool>>, Arc<Condvar>)>,
    #[cfg(test)]
    spawner_override: Option<TestSpawnerHook>,
    working_directory: Option<PathBuf>,
    extra_env: Vec<(String, String)>,
    server: Option<HiddenChild>,
    server_streams: Option<JoinHandle<()>>,
    server_eof: Arc<AtomicBool>,
    server_tail: Arc<Mutex<String>>,
    lease: Option<PooledOpenCodeLease>,
    port: Option<u16>,
    session_key: Option<String>,
    /// Model id for each turn, including `#level` when a level was chosen.
    model_arg: Option<String>,
    controls: PersistentControls,
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
        Self::with_inner(None, Box::new(SystemDriverProbe), true)
    }

    /// `program` is injectable so failures can be tested without an installed
    /// provider. Isolated test constructors bypass the shared server pool.
    pub fn with_program(program: Option<PathBuf>) -> Self {
        Self::with_inner(program, Box::new(SystemDriverProbe), false)
    }

    /// Keeps the chosen model on the server session. Each later turn passes it
    /// as `--model`; the running server process is not rewritten.
    pub fn with_controls(controls: PersistentControls) -> Self {
        let mut session = Self::new();
        session.model_arg = controls.model.as_deref().filter(|model| !model.trim().is_empty()).map(|model| {
            opencode_model_arg(model.trim(), controls.effort.as_deref())
        });
        session.controls = controls;
        session
    }

    /// Binds an explicit connection identifier for shared-server pool isolation.
    pub fn with_connection_id(mut self, connection_id: Option<String>) -> Self {
        self.connection_id = connection_id
            .map(|id| id.trim().to_string())
            .filter(|id| !id.is_empty());
        self
    }

    #[cfg(test)]
    pub(super) fn model_arg_for_test(&self) -> Option<&str> {
        self.model_arg.as_deref()
    }

    #[cfg(test)]
    pub(super) fn use_pool_for_test(&self) -> bool {
        self.use_pool
    }

    #[cfg(test)]
    pub(super) fn port_for_test(&self) -> Option<u16> {
        self.port
    }

    #[cfg(test)]
    pub(super) fn with_pooled_test_harness(
        program: PathBuf,
        probe: Box<dyn DriverProbe>,
        pool: (Arc<Mutex<SharedOpenCodeServerPool>>, Arc<Condvar>),
        spawner: TestSpawnerHook,
    ) -> Self {
        let mut session = Self::with_inner(Some(program), probe, true);
        session.pool_override = Some(pool);
        session.spawner_override = Some(spawner);
        session
    }

    /// Isolated test constructor with an injectable driver probe. Bypasses the
    /// shared server pool so unit tests do not touch global daemon state.
    pub fn with_probe(program: Option<PathBuf>, probe: Box<dyn DriverProbe>) -> Self {
        Self::with_inner(program, probe, false)
    }

    fn with_inner(program: Option<PathBuf>, probe: Box<dyn DriverProbe>, use_pool: bool) -> Self {
        Self {
            program,
            probe,
            connection_id: None,
            use_pool,
            pool_override: None,
            #[cfg(test)]
            spawner_override: None,
            working_directory: None,
            extra_env: Vec::new(),
            server: None,
            server_streams: None,
            server_eof: Arc::new(AtomicBool::new(true)),
            server_tail: Arc::new(Mutex::new(String::new())),
            lease: None,
            port: None,
            session_key: None,
            model_arg: None,
            controls: PersistentControls::default(),
            turn: None,
            turn_streams: None,
            turn_eof: Arc::new(AtomicBool::new(true)),
            turn_tail: Arc::new(Mutex::new(String::new())),
            events: Arc::new(Mutex::new(VecDeque::new())),
            stopping: false,
            spawns: 0,
        }
    }

    #[cfg(not(test))]
    fn build_server_spawner(
        &self,
        program: PathBuf,
        cwd: Option<PathBuf>,
        env: Vec<(String, String)>,
    ) -> impl FnOnce() -> Result<SpawnedOpenCodeServer, String> + 'static {
        move || spawn_opencode_server_process(&program, cwd.as_deref(), &env)
    }

    #[cfg(test)]
    fn build_server_spawner(
        &self,
        program: PathBuf,
        cwd: Option<PathBuf>,
        env: Vec<(String, String)>,
    ) -> impl FnOnce() -> Result<SpawnedOpenCodeServer, String> + 'static {
        let hook = self.spawner_override.clone();
        move || match hook {
            Some(hook) => hook(),
            None => spawn_opencode_server_process(&program, cwd.as_deref(), &env),
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
        if let Some(lease) = self.lease.take() {
            lease.release();
        }
        if let Some(mut child) = self.server.take() {
            let _ = child.kill();
        }
        if let Some(reader) = self.server_streams.take() {
            let _ = reader.join();
        }
        // Replace rather than mutating the shared `AtomicBool` so sibling
        // sessions leasing the same pooled server keep observing live EOF state.
        self.server_eof = Arc::new(AtomicBool::new(true));
        self.server_tail = Arc::new(Mutex::new(String::new()));
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
            .field("pooled", &self.lease.is_some())
            .field("spawns", &self.spawns)
            .finish()
    }
}

impl SessionTransport for OpenCodeServerSession {
    fn spawn(&mut self, spec: &TransportSpec) -> Result<(), String> {
        if (self.server.is_some() || self.lease.is_some())
            && !self.server_eof.load(Ordering::SeqCst)
        {
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

        let working_directory = spec.working_directory.as_deref().map(PathBuf::from);
        let mut session_env = spec.extra_env.clone();
        apply_opencode_password_env_aliases(&mut session_env, |k| std::env::var(k).ok());

        if self.use_pool && opencode_pool_enabled() {
            let key = opencode_pool_key(self.connection_id.as_deref(), &session_env);
            let lease_id = if spec.session_id.trim().is_empty() {
                format!("opencode-{}", uuid::Uuid::new_v4().simple())
            } else {
                spec.session_id.clone()
            };
            let server_env = super::opencode_pool::shared_opencode_server_env(&session_env);
            let spawner = self.build_server_spawner(
                program,
                working_directory.clone(),
                server_env,
            );
            let lease = match &self.pool_override {
                Some(override_pool) => acquire_shared_opencode_lease(
                    &override_pool.0,
                    override_pool.1.as_ref(),
                    key,
                    lease_id,
                    spawner,
                )?,
                None => acquire_global_opencode_lease(key, lease_id, spawner)?,
            };

            self.program = Some(lease.program().to_path_buf());
            self.working_directory = working_directory;
            self.extra_env = session_env;
            self.port = Some(lease.port());
            self.server_eof = lease.server_eof();
            self.server_tail = lease.server_tail();
            self.lease = Some(lease);
            self.session_key = spec.resume_handle.clone().or_else(|| Some(spec.session_id.clone()));
            self.events.lock().unwrap().clear();
            self.spawns += 1;
            return Ok(());
        }

        let spawned = spawn_opencode_server_process(
            &program,
            working_directory.as_deref(),
            &session_env,
        )?;
        self.program = Some(program);
        self.working_directory = working_directory;
        self.extra_env = session_env;
        self.server = spawned.server;
        self.server_streams = spawned.server_streams;
        self.server_eof = spawned.server_eof;
        self.server_tail = spawned.server_tail;
        self.port = Some(spawned.port);
        self.session_key = spec.resume_handle.clone().or_else(|| Some(spec.session_id.clone()));
        self.events.lock().unwrap().clear();
        self.spawns += 1;
        Ok(())
    }

    fn write_turn(&mut self, prompt: &str) -> Result<(), String> {
        if (self.server.is_none() && self.lease.is_none()) || self.server_eof.load(Ordering::SeqCst)
        {
            return Err("the opencode server exited before the message was written".to_string());
        }
        if self.turn.is_some() && !self.turn_eof.load(Ordering::SeqCst) {
            return Err("the opencode session is still answering the previous turn".to_string());
        }
        if let Some(lease) = &self.lease {
            lease.touch();
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
            if let Some(lease) = &self.lease {
                lease.touch();
            }
            self.turn_streams = None;
        }

        if !self.stopping && self.lease.is_some() && self.server_eof.load(Ordering::SeqCst) {
            if let Some(lease) = self.lease.take() {
                let code = lease.wait_dead_exit_code();
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
                lease.release();
            }
            self.port = None;
            self.session_key = None;
        } else {
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
        }

        events
    }

    fn is_alive(&self) -> bool {
        if self.spawns == 0 {
            return !self.stopping;
        }
        if self.stopping || self.server_eof.load(Ordering::SeqCst) {
            return false;
        }
        if self.lease.is_some() {
            return true;
        }
        self.server.is_some()
            && !self
                .server_streams
                .as_ref()
                .map(JoinHandle::is_finished)
                .unwrap_or(false)
    }

    fn controls(&self) -> Option<PersistentControls> {
        Some(self.controls.clone())
    }

    fn update_controls(&mut self, next: &PersistentControls) -> bool {
        self.controls = next.clone();
        self.model_arg = next
            .model
            .as_deref()
            .map(str::trim)
            .filter(|model| !model.is_empty())
            .map(|model| opencode_model_arg(model, next.effort.as_deref()));
        true
    }
}

impl Drop for OpenCodeServerSession {
    fn drop(&mut self) {
        self.stopping = true;
        if let Some(mut child) = self.turn.take() {
            let _ = child.kill();
        }
        if let Some(lease) = self.lease.take() {
            lease.release();
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
                if let Ok(mut manager) = crate::chat::runtime::session_manager().lock() {
                    let reaped = manager.reap_idle_sessions(crate::chat::session::DEFAULT_IDLE_TIMEOUT_MS);
                    if !reaped.is_empty() {
                        crate::chat::utils::chat_log(&format!(
                            "reaped {} idle session(s): {:?}",
                            reaped.len(),
                            reaped
                        ));
                    }
                }
                if crate::operator_runtime::reap_idle_warm_operator() {
                    crate::chat::utils::chat_log("reaped idle warm operator antigravity session");
                }
                let idle_ttl = std::time::Duration::from_secs(180);
                let _ = super::antigravity_acp::reap_idle_agy_acp_daemons(idle_ttl);
                let _ = super::opencode_pool::reap_idle_opencode_servers(idle_ttl);
                let _ = super::grok_pool::reap_idle_grok_daemons(idle_ttl);
                let _ = crate::dispatch::mcp_hub::reap_idle_upstream_servers(
                    crate::dispatch::mcp_hub::DEFAULT_MCP_IDLE_TIMEOUT,
                );
            })
            .expect("failed to spawn chat session reaper thread");
    });
}

const OPENCODE_PASSWORD_ENV_ALIASES: [&str; 2] =
    ["OPENCODE_SERVER_PASSWORD", "OPENCODE_PASSWORD"];

pub(crate) fn apply_opencode_password_env_aliases(
    session_env: &mut Vec<(String, String)>,
    env_lookup: impl Fn(&str) -> Option<String>,
) {
    let resolved_password = OPENCODE_PASSWORD_ENV_ALIASES
        .iter()
        .find_map(|alias| {
            session_env.iter().find_map(|(k, v)| {
                (k.eq_ignore_ascii_case(alias) && !v.trim().is_empty()).then(|| v.clone())
            })
        })
        .or_else(|| {
            OPENCODE_PASSWORD_ENV_ALIASES
                .iter()
                .find_map(|alias| env_lookup(alias).filter(|v| !v.trim().is_empty()))
        });

    let Some(password) = resolved_password else {
        return;
    };

    for alias in OPENCODE_PASSWORD_ENV_ALIASES {
        let mut found = false;
        for (k, existing_val) in session_env.iter_mut() {
            if k.eq_ignore_ascii_case(alias) {
                found = true;
                if existing_val.trim().is_empty() {
                    *existing_val = password.clone();
                }
            }
        }
        if !found {
            session_env.push((alias.to_string(), password.clone()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::opencode_pool::opencode_pool_enabled_from;
    use super::*;
    use crate::chat::drivers::DriverVersion;
    use crate::chat::session::SessionMode;
    use std::sync::atomic::AtomicUsize;

    #[derive(Debug)]
    struct OkVersionProbe;

    impl DriverProbe for OkVersionProbe {
        fn probe(
            &self,
            _driver: &str,
            _program: &Path,
            _evidence: &DriverVersion,
        ) -> Result<String, String> {
            Ok("opencode v2.1.4".to_string())
        }
    }

    fn opencode_spec(session_id: &str, env: Vec<(String, String)>) -> TransportSpec {
        TransportSpec {
            session_id: session_id.to_string(),
            driver: OPENCODE_DRIVER.to_string(),
            working_directory: None,
            mode: SessionMode::Persistent,
            recipe_revision: Some("r1".to_string()),
            resume_handle: None,
            extra_env: env,
        }
    }

    #[test]
    fn opencode_password_env_aliases_sync_from_env_and_replace_empty_entries() {
        let mut env = vec![
            ("OPENCODE_SERVER_PASSWORD".to_string(), "   ".to_string()),
            ("OTHER".to_string(), "1".to_string()),
        ];
        apply_opencode_password_env_aliases(&mut env, |k| match k {
            "OPENCODE_PASSWORD" => Some("secret-123".to_string()),
            _ => None,
        });
        assert_eq!(
            env,
            vec![
                (
                    "OPENCODE_SERVER_PASSWORD".to_string(),
                    "secret-123".to_string()
                ),
                ("OTHER".to_string(), "1".to_string()),
                ("OPENCODE_PASSWORD".to_string(), "secret-123".to_string()),
            ]
        );
    }

    #[test]
    fn opencode_password_env_aliases_match_case_insensitively_and_ignore_blank_values() {
        let mut env = vec![("opencode_password".to_string(), "cli-secret".to_string())];
        apply_opencode_password_env_aliases(&mut env, |_| None);
        assert_eq!(
            env,
            vec![
                ("opencode_password".to_string(), "cli-secret".to_string()),
                (
                    "OPENCODE_SERVER_PASSWORD".to_string(),
                    "cli-secret".to_string()
                ),
            ]
        );

        let mut blank_only = vec![("OPENCODE_PASSWORD".to_string(), "  \t ".to_string())];
        apply_opencode_password_env_aliases(&mut blank_only, |_| Some("   ".to_string()));
        assert_eq!(
            blank_only,
            vec![("OPENCODE_PASSWORD".to_string(), "  \t ".to_string())]
        );
    }

    #[test]
    fn opencode_pool_enabled_from_defaults_on_and_honors_zero_opt_out() {
        assert!(opencode_pool_enabled_from(None));
        assert!(opencode_pool_enabled_from(Some("")));
        assert!(opencode_pool_enabled_from(Some("1")));
        assert!(!opencode_pool_enabled_from(Some("0")));
        assert!(!opencode_pool_enabled_from(Some(" 0 ")));
    }

    #[test]
    fn opencode_constructors_use_pool_by_default_unless_isolated() {
        let default_session = OpenCodeServerSession::new();
        assert!(default_session.use_pool_for_test());

        let controlled = OpenCodeServerSession::with_controls(PersistentControls::default());
        assert!(controlled.use_pool_for_test());

        let with_prog = OpenCodeServerSession::with_program(Some(PathBuf::from("kite-opencode")));
        assert!(!with_prog.use_pool_for_test());

        let with_probe = OpenCodeServerSession::with_probe(
            Some(PathBuf::from("kite-opencode")),
            Box::new(OkVersionProbe),
        );
        assert!(!with_probe.use_pool_for_test());
    }

    #[test]
    fn pooled_opencode_sessions_share_server_and_preserve_siblings_on_stop_and_drop() {
        let pool = (
            Arc::new(Mutex::new(SharedOpenCodeServerPool::new())),
            Arc::new(Condvar::new()),
        );
        let listeners: Arc<Mutex<Vec<TcpListener>>> = Arc::new(Mutex::new(Vec::new()));
        let spawn_calls = Arc::new(AtomicUsize::new(0));
        let shared_eof = Arc::new(Mutex::new(None::<Arc<AtomicBool>>));

        let make_session = |conn: Option<&str>| {
            let listeners = Arc::clone(&listeners);
            let spawn_calls = Arc::clone(&spawn_calls);
            let shared_eof = Arc::clone(&shared_eof);
            let hook: TestSpawnerHook = Arc::new(move || {
                spawn_calls.fetch_add(1, Ordering::SeqCst);
                let listener = TcpListener::bind((OPENCODE_SERVE_HOST, 0))
                    .map_err(|e| format!("bind test listener: {e}"))?;
                let port = listener
                    .local_addr()
                    .map_err(|e| format!("local addr: {e}"))?
                    .port();
                listeners.lock().unwrap().push(listener);
                wait_for_server(port, Duration::from_millis(500))?;
                let eof = Arc::new(AtomicBool::new(false));
                *shared_eof.lock().unwrap() = Some(Arc::clone(&eof));
                Ok(SpawnedOpenCodeServer {
                    port,
                    program: PathBuf::from("kite-fake-opencode"),
                    server: None,
                    server_streams: None,
                    server_eof: eof,
                    server_tail: Arc::new(Mutex::new(String::new())),
                })
            });
            OpenCodeServerSession::with_pooled_test_harness(
                PathBuf::from("kite-fake-opencode"),
                Box::new(OkVersionProbe),
                (Arc::clone(&pool.0), Arc::clone(&pool.1)),
                hook,
            )
            .with_connection_id(conn.map(str::to_string))
        };

        let mut s1 = make_session(Some("conn-shared"));
        let mut s2 = make_session(Some("conn-shared"));
        let mut s3 = make_session(Some("conn-shared"));

        s1.spawn(&opencode_spec(
            "t1:1",
            vec![
                ("KITE_THREAD_ID".to_string(), "t1".to_string()),
                ("KITE_ADDRESS".to_string(), "thread:t1".to_string()),
                ("KITE_WORKSPACE_ID".to_string(), "ws-a".to_string()),
            ],
        ))
        .expect("s1 spawn");
        s2.spawn(&opencode_spec(
            "t2:1",
            vec![
                ("KITE_THREAD_ID".to_string(), "t2".to_string()),
                ("KITE_ADDRESS".to_string(), "thread:t2".to_string()),
                ("KITE_WORKSPACE_ID".to_string(), "ws-a".to_string()),
            ],
        ))
        .expect("s2 spawn");
        s3.spawn(&opencode_spec(
            "t3:1",
            vec![
                ("KITE_THREAD_ID".to_string(), "t3".to_string()),
                ("KITE_ADDRESS".to_string(), "thread:t3".to_string()),
                ("KITE_WORKSPACE_ID".to_string(), "ws-a".to_string()),
            ],
        ))
        .expect("s3 spawn");

        assert_eq!(spawn_calls.load(Ordering::SeqCst), 1);
        assert_eq!(s1.spawn_count(), 1);
        assert_eq!(s2.spawn_count(), 1);
        assert_eq!(s3.spawn_count(), 1);
        assert!(s1.port_for_test().is_some());
        assert_eq!(s1.port_for_test(), s2.port_for_test());
        assert_eq!(s2.port_for_test(), s3.port_for_test());
        assert_eq!(pool.0.lock().unwrap().stats(), (1, 3));

        // Stopping s1 releases only s1's lease and leaves s2/s3 alive.
        s1.stop().expect("s1 stop");
        assert!(!s1.is_alive());
        assert!(s2.is_alive());
        assert!(s3.is_alive());
        assert_eq!(pool.0.lock().unwrap().stats(), (1, 2));
        let eof = shared_eof.lock().unwrap().clone().unwrap();
        assert!(!eof.load(Ordering::SeqCst));

        // Dropping s2 releases s2's lease and leaves s3 alive.
        drop(s2);
        assert!(s3.is_alive());
        assert_eq!(pool.0.lock().unwrap().stats(), (1, 1));
        assert!(!eof.load(Ordering::SeqCst));

        // Stopping s3 drops lease count to 0; idle reaper then reaps the server.
        s3.stop().expect("s3 stop");
        assert_eq!(pool.0.lock().unwrap().stats(), (1, 0));
        assert_eq!(pool.0.lock().unwrap().reap_idle(Duration::ZERO), 1);
        assert!(eof.load(Ordering::SeqCst));
        assert_eq!(pool.0.lock().unwrap().stats(), (0, 0));
    }

    #[test]
    fn pooled_opencode_session_emits_exit_when_shared_server_terminates() {
        let pool = (
            Arc::new(Mutex::new(SharedOpenCodeServerPool::new())),
            Arc::new(Condvar::new()),
        );
        let eof = Arc::new(AtomicBool::new(false));
        let eof_for_hook = Arc::clone(&eof);

        let hook: TestSpawnerHook = Arc::new(move || {
            Ok(SpawnedOpenCodeServer {
                port: 42_123,
                program: PathBuf::from("kite-fake-opencode"),
                server: None,
                server_streams: None,
                server_eof: Arc::clone(&eof_for_hook),
                server_tail: Arc::new(Mutex::new("server crashed".to_string())),
            })
        });

        let mut session = OpenCodeServerSession::with_pooled_test_harness(
            PathBuf::from("kite-fake-opencode"),
            Box::new(OkVersionProbe),
            (Arc::clone(&pool.0), Arc::clone(&pool.1)),
            hook,
        );
        session
            .spawn(&opencode_spec("t-crash:1", Vec::new()))
            .expect("spawn succeeds");
        assert!(session.is_alive());

        eof.store(true, Ordering::SeqCst);
        assert!(!session.is_alive());
        let events = session.drain();
        assert!(matches!(
            events.as_slice(),
            [TransportEvent::Exit { code: None, error: Some(err) }] if err.contains("server crashed")
        ));
        assert_eq!(pool.0.lock().unwrap().stats(), (0, 0));
    }
}

