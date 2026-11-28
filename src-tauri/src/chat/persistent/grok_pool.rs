//! Shared multiplexed `grok agent stdio` ACP daemon pool.
//!
//! Concurrent Grok threads and child subagents sharing a `(connection_id, permission_mode)`
//! tuple multiplex over a single `grok --permission-mode <m> agent stdio` JSON-RPC 2.0
//! process via `session/new` / `session/load` and `sessionId`-scoped routing. Differing
//! permission modes (such as `bypassPermissions` vs `default`) are strictly isolated onto
//! separate daemon keys and never share a process.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fmt;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::chat::drivers::{declaration, DriverProbe, SystemDriverProbe};
use crate::chat::runtime::bounded_notice;
use crate::chat::session::{SessionTransport, TransportEvent, TransportSpec};
use crate::hidden_exec::{spawn_streaming_with_owned_env, HiddenChild};

use super::controls::{
    grok_permission_mode, grok_session_args, push_bounded, read_tail, tail_detail,
    unhandled_request_reply, verify_driver_version, PersistentControls, GROK_DRIVER,
    GROK_HANDSHAKE_TIMEOUT,
};
use super::grok::{
    grok_initialize_line, grok_session_load_line, grok_session_new_line, grok_turn_lines, json_id,
    parse_grok_line, resolve_grok_program, rpc_error_text, rpc_line, session_id_of,
};

type DaemonLauncher = Arc<
    dyn Fn(&Path, &[String], Option<&Path>, &[(String, String)]) -> Result<DaemonPipe, String>
        + Send
        + Sync,
>;

/// Builds the canonical pool key `(connection_id_or_default, permission_mode)`.
///
/// Differing effective permission modes (`default`, `bypassPermissions`, `auto`,
/// `dontAsk`) always resolve to distinct keys so privileged and supervised
/// sessions never share a `grok agent stdio` process.
pub fn grok_pool_key(
    connection_id: Option<&str>,
    permission_mode: Option<&str>,
) -> (String, String) {
    let conn = connection_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("default")
        .to_string();
    let mode = grok_permission_mode(permission_mode).to_string();
    (conn, mode)
}

/// Best-effort `session/close` frame releasing one multiplexed ACP session
/// without terminating sibling sessions on the same daemon.
pub fn grok_session_close_line(id: u64, session_id: &str) -> String {
    rpc_line(
        id,
        "session/close",
        json!({
            "sessionId": session_id,
        }),
    )
}

/// Low-level duplex stream pair backing one `grok agent stdio` daemon.
pub(crate) struct DaemonPipe {
    pub(crate) stdin: Box<dyn Write + Send>,
    pub(crate) stdout: Box<dyn Read + Send>,
    pub(crate) stderr: Option<Box<dyn Read + Send>>,
    pub(crate) child: Option<HiddenChild>,
    pub(crate) on_kill: Option<Box<dyn FnOnce() + Send>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum DaemonPhase {
    Starting,
    Ready,
    Dead(String),
}

struct DaemonLifecycle {
    phase: DaemonPhase,
    init_claimed: bool,
    stopping: bool,
    active_leases: usize,
    last_active_at: Instant,
    exit_outcome: Option<(Option<i32>, Option<String>)>,
}

struct RpcResultBox {
    response: Option<Value>,
    aborted: bool,
}

#[derive(Clone)]
struct RpcWaiter {
    slot: Arc<(Mutex<RpcResultBox>, Condvar)>,
}

impl RpcWaiter {
    fn new() -> Self {
        Self {
            slot: Arc::new((
                Mutex::new(RpcResultBox {
                    response: None,
                    aborted: false,
                }),
                Condvar::new(),
            )),
        }
    }

    fn deliver(&self, value: Value) {
        let (lock, cv) = &*self.slot;
        if let Ok(mut guard) = lock.lock() {
            guard.response = Some(value);
            cv.notify_all();
        }
    }

    fn abort(&self) {
        let (lock, cv) = &*self.slot;
        if let Ok(mut guard) = lock.lock() {
            guard.aborted = true;
            cv.notify_all();
        }
    }

    fn wait(&self, timeout: Duration) -> Result<Value, String> {
        let deadline = Instant::now() + timeout;
        let (lock, cv) = &*self.slot;
        let mut guard = lock
            .lock()
            .map_err(|_| "the grok daemon response queue lock was poisoned".to_string())?;
        loop {
            if let Some(value) = guard.response.take() {
                return Ok(value);
            }
            if guard.aborted {
                return Err("the grok daemon closed before it answered".to_string());
            }
            let now = Instant::now();
            if now >= deadline {
                return Err(format!(
                    "the grok daemon did not answer within {} ms",
                    timeout.as_millis()
                ));
            }
            let (next, _) = cv
                .wait_timeout(guard, deadline - now)
                .map_err(|_| "the grok daemon response queue lock was poisoned".to_string())?;
            guard = next;
        }
    }
}

struct PendingRpc {
    waiter: RpcWaiter,
    open_session: Option<(Option<String>, Arc<Mutex<VecDeque<TransportEvent>>>)>,
}

struct SessionRoute {
    events: Arc<Mutex<VecDeque<TransportEvent>>>,
    active_prompt_id: Option<u64>,
}

#[derive(Default)]
struct DaemonRoutingState {
    sessions: HashMap<String, SessionRoute>,
    pending_rpcs: HashMap<u64, PendingRpc>,
    prompt_owners: HashMap<u64, String>,
    config_owners: HashMap<u64, String>,
    close_ids: HashSet<u64>,
}

struct GrokDaemon {
    lifecycle: Mutex<DaemonLifecycle>,
    lifecycle_cv: Condvar,
    routing: Mutex<DaemonRoutingState>,
    stdin: Mutex<Option<Box<dyn Write + Send>>>,
    child: Mutex<Option<HiddenChild>>,
    on_kill: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    reader: Mutex<Option<JoinHandle<()>>>,
    stderr_reader: Mutex<Option<JoinHandle<()>>>,
    stderr_tail: Arc<Mutex<String>>,
    next_id: AtomicU64,
    eof: AtomicBool,
    reader_done: AtomicBool,
}

impl GrokDaemon {
    fn new_starting() -> Arc<Self> {
        Arc::new(Self {
            lifecycle: Mutex::new(DaemonLifecycle {
                phase: DaemonPhase::Starting,
                init_claimed: false,
                stopping: false,
                active_leases: 0,
                last_active_at: Instant::now(),
                exit_outcome: None,
            }),
            lifecycle_cv: Condvar::new(),
            routing: Mutex::new(DaemonRoutingState::default()),
            stdin: Mutex::new(None),
            child: Mutex::new(None),
            on_kill: Mutex::new(None),
            reader: Mutex::new(None),
            stderr_reader: Mutex::new(None),
            stderr_tail: Arc::new(Mutex::new(String::new())),
            next_id: AtomicU64::new(1),
            eof: AtomicBool::new(false),
            reader_done: AtomicBool::new(false),
        })
    }

    fn alloc_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::SeqCst)
    }

    fn touch_activity(&self) {
        if let Ok(mut life) = self.lifecycle.lock() {
            life.last_active_at = Instant::now();
        }
    }

    fn try_acquire_lease(&self) -> bool {
        if self.eof.load(Ordering::SeqCst) {
            return false;
        }
        let Ok(mut life) = self.lifecycle.lock() else {
            return false;
        };
        if life.stopping || matches!(life.phase, DaemonPhase::Dead(_)) {
            return false;
        }
        life.active_leases += 1;
        life.last_active_at = Instant::now();
        true
    }

    fn release_lease_count(&self) {
        if let Ok(mut life) = self.lifecycle.lock() {
            life.active_leases = life.active_leases.saturating_sub(1);
            life.last_active_at = Instant::now();
        }
    }

    fn is_dead(&self) -> bool {
        if self.eof.load(Ordering::SeqCst) {
            return true;
        }
        self.lifecycle
            .lock()
            .map(|life| life.stopping || matches!(life.phase, DaemonPhase::Dead(_)))
            .unwrap_or(true)
    }

    fn is_alive(&self) -> bool {
        if self.eof.load(Ordering::SeqCst) {
            return false;
        }
        let Ok(life) = self.lifecycle.lock() else {
            return false;
        };
        !life.stopping && matches!(life.phase, DaemonPhase::Ready)
    }

    fn is_eof(&self) -> bool {
        self.eof.load(Ordering::SeqCst) && self.reader_done.load(Ordering::SeqCst)
    }

    fn session_count(&self) -> usize {
        self.routing
            .lock()
            .map(|routing| routing.sessions.len())
            .unwrap_or(0)
    }

    fn try_mark_reaping(&self, now: Instant, idle_timeout: Duration) -> bool {
        let dead = self.eof.load(Ordering::SeqCst);
        let Ok(mut life) = self.lifecycle.lock() else {
            return false;
        };
        if life.stopping {
            return false;
        }
        if dead || matches!(life.phase, DaemonPhase::Dead(_)) {
            life.stopping = true;
            self.lifecycle_cv.notify_all();
            return true;
        }
        if life.active_leases == 0 && now.saturating_duration_since(life.last_active_at) >= idle_timeout
        {
            life.stopping = true;
            self.lifecycle_cv.notify_all();
            return true;
        }
        false
    }

    fn write_raw(&self, frame: &str) -> Result<(), String> {
        let mut guard = self
            .stdin
            .lock()
            .map_err(|_| "the grok daemon stdin lock was poisoned".to_string())?;
        let Some(stdin) = guard.as_mut() else {
            return Err("the grok daemon has no open input".to_string());
        };
        stdin.write_all(frame.as_bytes()).map_err(|error| {
            format!("could not write the message to the grok daemon: {error}")
        })?;
        stdin.write_all(b"\n").map_err(|error| {
            format!("could not write the message to the grok daemon: {error}")
        })?;
        stdin
            .flush()
            .map_err(|error| format!("could not flush the grok daemon input: {error}"))?;
        drop(guard);
        self.touch_activity();
        Ok(())
    }

    fn write_lines(&self, lines: &[String]) -> Result<(), String> {
        let mut guard = self
            .stdin
            .lock()
            .map_err(|_| "the grok daemon stdin lock was poisoned".to_string())?;
        let Some(stdin) = guard.as_mut() else {
            return Err("the grok daemon has no open input".to_string());
        };
        for line in lines {
            stdin.write_all(line.as_bytes()).map_err(|error| {
                format!("could not write the message to the grok daemon: {error}")
            })?;
            stdin.write_all(b"\n").map_err(|error| {
                format!("could not write the message to the grok daemon: {error}")
            })?;
        }
        stdin
            .flush()
            .map_err(|error| format!("could not flush the grok daemon input: {error}"))?;
        drop(guard);
        self.touch_activity();
        Ok(())
    }

    fn ensure_ready(
        self: &Arc<Self>,
        pool_key: &(String, String),
        spec: &TransportSpec,
        program: Option<&PathBuf>,
        probe: &dyn DriverProbe,
        launcher: Option<&DaemonLauncher>,
    ) -> Result<(), String> {
        let should_initialize = {
            let mut life = self
                .lifecycle
                .lock()
                .map_err(|_| "the grok daemon lifecycle lock was poisoned".to_string())?;
            loop {
                if life.stopping {
                    return Err("the grok daemon is shutting down".to_string());
                }
                match &life.phase {
                    DaemonPhase::Ready => return Ok(()),
                    DaemonPhase::Dead(err) => return Err(err.clone()),
                    DaemonPhase::Starting => {
                        if !life.init_claimed {
                            life.init_claimed = true;
                            break true;
                        }
                        life = self
                            .lifecycle_cv
                            .wait(life)
                            .map_err(|_| "the grok daemon lifecycle lock was poisoned".to_string())?;
                    }
                }
            }
        };

        if !should_initialize {
            return Ok(());
        }

        let init_result = self.start_and_initialize(&pool_key.1, spec, program, probe, launcher);
        match init_result {
            Ok(()) => {
                if let Ok(mut life) = self.lifecycle.lock() {
                    if life.stopping {
                        return Err("the grok daemon was stopped during initialization".to_string());
                    }
                    life.phase = DaemonPhase::Ready;
                    life.last_active_at = Instant::now();
                    self.lifecycle_cv.notify_all();
                }
                Ok(())
            }
            Err(err) => {
                if let Ok(mut life) = self.lifecycle.lock() {
                    life.phase = DaemonPhase::Dead(err.clone());
                    life.stopping = true;
                    self.lifecycle_cv.notify_all();
                }
                self.shutdown();
                Err(err)
            }
        }
    }

    fn start_and_initialize(
        self: &Arc<Self>,
        permission_mode: &str,
        spec: &TransportSpec,
        program: Option<&PathBuf>,
        probe: &dyn DriverProbe,
        launcher: Option<&DaemonLauncher>,
    ) -> Result<(), String> {
        let (resolved_program, args) =
            checked_daemon_launch(&spec.driver, permission_mode, program, probe)?;
        let cwd = spec.working_directory.as_deref().map(Path::new);
        let daemon_env = super::antigravity_acp::shared_daemon_env(&spec.extra_env);
        let pipe = match launcher {
            Some(custom) => custom(&resolved_program, &args, cwd, &daemon_env)?,
            None => spawn_real_grok_daemon(&resolved_program, &args, cwd, &daemon_env)?,
        };

        if let Ok(mut guard) = self.stdin.lock() {
            *guard = Some(pipe.stdin);
        }
        if let Ok(mut guard) = self.child.lock() {
            *guard = pipe.child;
        }
        if let Ok(mut guard) = self.on_kill.lock() {
            *guard = pipe.on_kill;
        }
        self.eof.store(false, Ordering::SeqCst);
        self.reader_done.store(false, Ordering::SeqCst);

        let daemon_for_reader = Arc::clone(self);
        let stdout = pipe.stdout;
        let reader_handle = std::thread::spawn(move || {
            read_daemon_stdout(daemon_for_reader, stdout);
        });
        if let Ok(mut guard) = self.reader.lock() {
            *guard = Some(reader_handle);
        }

        if let Some(mut stderr) = pipe.stderr {
            let tail = Arc::clone(&self.stderr_tail);
            let stderr_handle = std::thread::spawn(move || {
                read_tail(&mut stderr, tail);
            });
            if let Ok(mut guard) = self.stderr_reader.lock() {
                *guard = Some(stderr_handle);
            }
        }

        let init_id = self.alloc_id();
        let waiter = RpcWaiter::new();
        {
            let mut routing = self
                .routing
                .lock()
                .map_err(|_| "the grok daemon routing lock was poisoned".to_string())?;
            routing.pending_rpcs.insert(
                init_id,
                PendingRpc {
                    waiter: waiter.clone(),
                    open_session: None,
                },
            );
        }

        if let Err(err) = self.write_raw(&grok_initialize_line(init_id)) {
            if let Ok(mut routing) = self.routing.lock() {
                routing.pending_rpcs.remove(&init_id);
            }
            return Err(err);
        }

        let initialized = match waiter.wait(GROK_HANDSHAKE_TIMEOUT) {
            Ok(val) => val,
            Err(err) => {
                if let Ok(mut routing) = self.routing.lock() {
                    routing.pending_rpcs.remove(&init_id);
                }
                let tail = self
                    .stderr_tail
                    .lock()
                    .map(|t| t.clone())
                    .unwrap_or_default();
                return Err(format!("{err}{}", tail_detail(&tail)));
            }
        };

        if initialized.get("error").is_some() {
            return Err(format!(
                "the grok session refused initialize: {}",
                rpc_error_text(&initialized)
            ));
        }

        Ok(())
    }

    fn open_session(
        &self,
        cwd: Option<&str>,
        resume_handle: Option<&str>,
    ) -> Result<(String, Arc<Mutex<VecDeque<TransportEvent>>>), String> {
        if self.is_dead() {
            return Err("the grok daemon ended before the session could open".to_string());
        }
        let cwd_clean = cwd
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(".");
        let fallback_handle = resume_handle
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);

        let open_id = self.alloc_id();
        let open_line = match fallback_handle.as_deref() {
            Some(handle) => grok_session_load_line(open_id, handle, cwd_clean),
            None => grok_session_new_line(open_id, cwd_clean),
        };

        let events_arc = Arc::new(Mutex::new(VecDeque::new()));
        let waiter = RpcWaiter::new();
        {
            let mut routing = self
                .routing
                .lock()
                .map_err(|_| "the grok daemon routing lock was poisoned".to_string())?;
            routing.pending_rpcs.insert(
                open_id,
                PendingRpc {
                    waiter: waiter.clone(),
                    open_session: Some((fallback_handle.clone(), Arc::clone(&events_arc))),
                },
            );
        }

        if let Err(err) = self.write_raw(&open_line) {
            if let Ok(mut routing) = self.routing.lock() {
                routing.pending_rpcs.remove(&open_id);
            }
            return Err(err);
        }

        let opened = match waiter.wait(GROK_HANDSHAKE_TIMEOUT) {
            Ok(val) => val,
            Err(err) => {
                if let Ok(mut routing) = self.routing.lock() {
                    routing.pending_rpcs.remove(&open_id);
                }
                return Err(err);
            }
        };

        if opened.get("error").is_some() {
            return Err(format!(
                "the grok session refused to open: {}",
                rpc_error_text(&opened)
            ));
        }

        let Some(session_id) = session_id_of(&opened).or(fallback_handle) else {
            return Err("the grok session did not return a session id".to_string());
        };

        // The demux reader registers the session route before delivering `opened`,
        // but insert defensively if another caller path created a custom response.
        if let Ok(mut routing) = self.routing.lock() {
            routing
                .sessions
                .entry(session_id.clone())
                .or_insert_with(|| SessionRoute {
                    events: Arc::clone(&events_arc),
                    active_prompt_id: None,
                });
        }
        self.touch_activity();
        Ok((session_id, events_arc))
    }

    fn write_turn(
        &self,
        session_id: &str,
        controls: &PersistentControls,
        prompt: &str,
    ) -> Result<(), String> {
        if self.is_dead() {
            return Err("the grok session ended before the message was written".to_string());
        }
        let mut next = self.next_id.fetch_add(3, Ordering::SeqCst);
        let start_id = next;
        let lines = grok_turn_lines(session_id, controls, prompt, &mut next);
        let prompt_id = next.saturating_sub(1);

        {
            let mut routing = self
                .routing
                .lock()
                .map_err(|_| "the grok daemon routing lock was poisoned".to_string())?;
            let Some(route) = routing.sessions.get_mut(session_id) else {
                return Err("the grok session is no longer registered on the daemon".to_string());
            };
            route.active_prompt_id = Some(prompt_id);
            routing
                .prompt_owners
                .insert(prompt_id, session_id.to_string());
            for config_id in start_id..prompt_id {
                routing
                    .config_owners
                    .insert(config_id, session_id.to_string());
            }
        }

        if let Err(err) = self.write_lines(&lines) {
            if let Ok(mut routing) = self.routing.lock() {
                if let Some(route) = routing.sessions.get_mut(session_id) {
                    if route.active_prompt_id == Some(prompt_id) {
                        route.active_prompt_id = None;
                    }
                }
                routing.prompt_owners.remove(&prompt_id);
                for config_id in start_id..prompt_id {
                    routing.config_owners.remove(&config_id);
                }
            }
            return Err(err);
        }

        Ok(())
    }

    fn release_session(&self, session_id: &str) {
        let should_send_close = self.is_alive();
        let close_id = if should_send_close {
            let id = self.alloc_id();
            if let Ok(mut routing) = self.routing.lock() {
                routing.close_ids.insert(id);
            }
            Some(id)
        } else {
            None
        };

        if let Some(id) = close_id {
            if self.write_raw(&grok_session_close_line(id, session_id)).is_err() {
                if let Ok(mut routing) = self.routing.lock() {
                    routing.close_ids.remove(&id);
                }
            }
        }

        if let Ok(mut routing) = self.routing.lock() {
            routing.sessions.remove(session_id);
            routing
                .prompt_owners
                .retain(|_, owner| owner != session_id);
            routing
                .config_owners
                .retain(|_, owner| owner != session_id);
        }
        self.release_lease_count();
    }

    fn ensure_exit_outcome(&self) -> (Option<i32>, Option<String>) {
        if let Ok(life) = self.lifecycle.lock() {
            if let Some(outcome) = life.exit_outcome.clone() {
                return outcome;
            }
        }

        let code = self
            .child
            .lock()
            .ok()
            .and_then(|mut guard| guard.take())
            .and_then(|mut child| child.wait().ok());

        if let Ok(mut guard) = self.stderr_reader.lock() {
            if let Some(handle) = guard.take() {
                if handle.thread().id() != std::thread::current().id() {
                    let _ = handle.join();
                }
            }
        }

        let tail = self
            .stderr_tail
            .lock()
            .map(|t| t.clone())
            .unwrap_or_default();
        let error = match code {
            Some(0) => None,
            Some(other) => Some(format!("grok exited with code {other}{}", tail_detail(&tail))),
            None => None,
        };
        let outcome = (code, error);
        if let Ok(mut life) = self.lifecycle.lock() {
            if let Some(existing) = life.exit_outcome.clone() {
                return existing;
            }
            life.exit_outcome = Some(outcome.clone());
        }
        outcome
    }

    fn shutdown(&self) {
        if let Ok(mut life) = self.lifecycle.lock() {
            life.stopping = true;
            if matches!(life.phase, DaemonPhase::Starting) {
                life.phase = DaemonPhase::Dead("the grok daemon was shut down".to_string());
            }
            self.lifecycle_cv.notify_all();
        }

        if let Ok(mut guard) = self.stdin.lock() {
            *guard = None;
        }
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        if let Ok(mut guard) = self.on_kill.lock() {
            if let Some(callback) = guard.take() {
                callback();
            }
        }
        if let Ok(mut routing) = self.routing.lock() {
            for (_, pending) in routing.pending_rpcs.drain() {
                pending.waiter.abort();
            }
        }
        if let Ok(mut guard) = self.reader.lock() {
            if let Some(handle) = guard.take() {
                if handle.thread().id() != std::thread::current().id() {
                    let _ = handle.join();
                }
            }
        }
        if let Ok(mut guard) = self.stderr_reader.lock() {
            if let Some(handle) = guard.take() {
                if handle.thread().id() != std::thread::current().id() {
                    let _ = handle.join();
                }
            }
        }
    }
}

impl Drop for GrokDaemon {
    fn drop(&mut self) {
        self.shutdown();
    }
}

struct PendingLeaseGuard {
    daemon: Option<Arc<GrokDaemon>>,
}

impl PendingLeaseGuard {
    fn new(daemon: Arc<GrokDaemon>) -> Self {
        Self {
            daemon: Some(daemon),
        }
    }

    fn commit(mut self) -> Arc<GrokDaemon> {
        self.daemon.take().expect("pending lease guard already committed")
    }
}

impl Drop for PendingLeaseGuard {
    fn drop(&mut self) {
        if let Some(daemon) = self.daemon.take() {
            daemon.release_lease_count();
        }
    }
}

fn checked_daemon_launch(
    driver: &str,
    permission_mode: &str,
    program: Option<&PathBuf>,
    probe: &dyn DriverProbe,
) -> Result<(PathBuf, Vec<String>), String> {
    let declared = declaration(driver)
        .ok_or_else(|| format!("{driver} has no driver declaration in this build"))?;
    if declared.driver != GROK_DRIVER {
        return Err(format!("{driver} does not speak the grok stdio wire"));
    }
    let resolved = match program {
        Some(path) => path.clone(),
        None => resolve_grok_program()?,
    };
    verify_driver_version(GROK_DRIVER, &resolved, probe)?;
    let args = grok_session_args(Some(permission_mode));
    Ok((resolved, args))
}

fn spawn_real_grok_daemon(
    program: &Path,
    args: &[String],
    cwd: Option<&Path>,
    extra_env: &[(String, String)],
) -> Result<DaemonPipe, String> {
    let args_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let mut child = spawn_streaming_with_owned_env(program, &args_refs, cwd, extra_env)
        .map_err(|error| {
            format!(
                "could not start the grok daemon with {}: {error}",
                program.display()
            )
        })?;
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        return Err("the grok daemon started without a readable stdout".to_string());
    };
    let Some(stdin) = child.stdin.take() else {
        let _ = child.kill();
        return Err("the grok daemon started without a writable stdin".to_string());
    };
    let stderr = child.stderr.take();
    Ok(DaemonPipe {
        stdin,
        stdout,
        stderr,
        child: Some(child),
        on_kill: None,
    })
}

fn fallback_session_id(value: &Value) -> Option<String> {
    [
        "/params/session_id",
        "/params/update/sessionId",
        "/params/update/session_id",
        "/sessionId",
        "/session_id",
    ]
    .iter()
    .filter_map(|pointer| value.pointer(pointer).and_then(Value::as_str))
    .map(str::trim)
    .find(|candidate| !candidate.is_empty())
    .map(str::to_string)
}

fn push_events_to_session(
    daemon: &GrokDaemon,
    session_id: &str,
    events: Vec<TransportEvent>,
) {
    let has_terminal = events.iter().any(|ev| {
        matches!(
            ev,
            TransportEvent::TurnEnded | TransportEvent::TurnFailed(_)
        )
    });
    let target_queue = {
        let Ok(mut routing) = daemon.routing.lock() else {
            return;
        };
        let Some(route) = routing.sessions.get_mut(session_id) else {
            return;
        };
        if route.active_prompt_id.is_none() {
            return;
        }
        if has_terminal {
            route.active_prompt_id = None;
        }
        Arc::clone(&route.events)
    };
    if let Ok(mut queue) = target_queue.lock() {
        for event in events {
            push_bounded(&mut queue, event);
        }
    }
    daemon.touch_activity();
}

fn handle_daemon_line(daemon: &GrokDaemon, line: &str) {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return;
    }

    let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
        let parsed = parse_grok_line(line, None);
        if parsed.events.is_empty() {
            return;
        }
        let sole_queue = daemon.routing.lock().ok().and_then(|routing| {
            if routing.sessions.len() == 1 {
                routing.sessions.values().next().map(|r| Arc::clone(&r.events))
            } else {
                None
            }
        });
        if let Some(queue_arc) = sole_queue {
            if let Ok(mut queue) = queue_arc.lock() {
                for ev in parsed.events {
                    push_bounded(&mut queue, ev);
                }
            }
        }
        return;
    };

    let method = value.get("method").and_then(Value::as_str);
    if method.is_none() && (value.get("result").is_some() || value.get("error").is_some()) {
        if let Some(id) = json_id(&value) {
            enum ResponseAction {
                Pending {
                    pending: PendingRpc,
                    value: Value,
                },
                Prompt {
                    session_id: String,
                    active_prompt_id: Option<u64>,
                },
                ConfigError {
                    session_id: String,
                    message: String,
                },
                Ignored,
            }

            let action = {
                let Ok(mut routing) = daemon.routing.lock() else {
                    return;
                };
                if let Some(pending) = routing.pending_rpcs.remove(&id) {
                    if value.get("error").is_none() {
                        if let Some((fallback_sid, events_arc)) = &pending.open_session {
                            if let Some(sid) =
                                session_id_of(&value).or_else(|| fallback_sid.clone())
                            {
                                routing
                                    .sessions
                                    .entry(sid)
                                    .or_insert_with(|| SessionRoute {
                                        events: Arc::clone(events_arc),
                                        active_prompt_id: None,
                                    });
                            }
                        }
                    }
                    ResponseAction::Pending { pending, value }
                } else if routing.close_ids.remove(&id) {
                    ResponseAction::Ignored
                } else if let Some(session_id) = routing.prompt_owners.remove(&id) {
                    let active_prompt_id = routing
                        .sessions
                        .get(&session_id)
                        .and_then(|route| route.active_prompt_id);
                    ResponseAction::Prompt {
                        session_id,
                        active_prompt_id,
                    }
                } else if let Some(session_id) = routing.config_owners.remove(&id) {
                    if value.get("error").is_some() {
                        ResponseAction::ConfigError {
                            session_id,
                            message: bounded_notice(&format!(
                                "grok config update error: {}",
                                rpc_error_text(&value)
                            )),
                        }
                    } else {
                        ResponseAction::Ignored
                    }
                } else {
                    ResponseAction::Ignored
                }
            };

            match action {
                ResponseAction::Pending { pending, value } => {
                    pending.waiter.deliver(value);
                    daemon.touch_activity();
                }
                ResponseAction::Prompt {
                    session_id,
                    active_prompt_id,
                } => {
                    let parsed = parse_grok_line(line, active_prompt_id);
                    if !parsed.events.is_empty() {
                        push_events_to_session(daemon, &session_id, parsed.events);
                    } else if active_prompt_id == Some(id) {
                        if let Ok(mut routing) = daemon.routing.lock() {
                            if let Some(route) = routing.sessions.get_mut(&session_id) {
                                if route.active_prompt_id == Some(id) {
                                    route.active_prompt_id = None;
                                }
                            }
                        }
                    }
                }
                ResponseAction::ConfigError {
                    session_id,
                    message,
                } => {
                    push_events_to_session(
                        daemon,
                        &session_id,
                        vec![TransportEvent::Notice(message)],
                    );
                }
                ResponseAction::Ignored => {}
            }
            return;
        }
    }

    let parsed = parse_grok_line(line, None);
    let target_session_id = parsed
        .conversation_id
        .clone()
        .or_else(|| fallback_session_id(&value));

    if let Some(sid) = target_session_id {
        if !parsed.events.is_empty() {
            push_events_to_session(daemon, &sid, parsed.events);
        } else {
            daemon.touch_activity();
        }
        return;
    }

    for event in parsed.events {
        if let TransportEvent::UnhandledRequest { id } = event {
            let _ = daemon.write_raw(&unhandled_request_reply(&id));
        }
    }
}

fn read_daemon_stdout(daemon: Arc<GrokDaemon>, stdout: Box<dyn Read + Send>) {
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => handle_daemon_line(&daemon, &line),
            Err(_) => break,
        }
    }

    daemon.eof.store(true, Ordering::SeqCst);
    if let Ok(mut routing) = daemon.routing.lock() {
        for (_, pending) in routing.pending_rpcs.drain() {
            pending.waiter.abort();
        }
    }
    daemon.reader_done.store(true, Ordering::SeqCst);
    daemon.lifecycle_cv.notify_all();
}

/// Pool of shared permission-isolated `grok agent stdio` ACP daemons.
///
/// Keyed strictly by `(connection_id_or_default, permission_mode)` so sessions
/// with differing permission modes never share the same child process.
#[derive(Default)]
pub struct SharedGrokAcpPool {
    daemons: HashMap<(String, String), Arc<GrokDaemon>>,
    launcher: Option<DaemonLauncher>,
}

impl fmt::Debug for SharedGrokAcpPool {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SharedGrokAcpPool")
            .field("daemon_count", &self.daemons.len())
            .field("has_custom_launcher", &self.launcher.is_some())
            .finish()
    }
}

impl SharedGrokAcpPool {
    pub fn new() -> Self {
        Self::default()
    }

    #[cfg(test)]
    pub(crate) fn with_launcher(launcher: DaemonLauncher) -> Self {
        Self {
            daemons: HashMap::new(),
            launcher: Some(launcher),
        }
    }

    #[cfg(test)]
    pub(crate) fn set_launcher_for_test(&mut self, launcher: Option<DaemonLauncher>) {
        self.launcher = launcher;
    }

    #[cfg(test)]
    pub(crate) fn backdate_daemon_idle_for_test(
        &self,
        key: &(String, String),
        elapsed: Duration,
    ) -> bool {
        let Some(daemon) = self.daemons.get(key) else {
            return false;
        };
        if let Ok(mut life) = daemon.lifecycle.lock() {
            life.last_active_at = Instant::now()
                .checked_sub(elapsed)
                .unwrap_or_else(Instant::now);
            return true;
        }
        false
    }

    #[cfg(test)]
    pub(crate) fn keys(&self) -> Vec<(String, String)> {
        self.daemons.keys().cloned().collect()
    }

    /// Returns `(active_daemon_count, active_session_count)`.
    pub fn stats(&self) -> (usize, usize) {
        let mut daemons = 0usize;
        let mut sessions = 0usize;
        for daemon in self.daemons.values() {
            if !daemon.is_dead() {
                daemons += 1;
                sessions += daemon.session_count();
            }
        }
        (daemons, sessions)
    }

    fn take_idle_at(&mut self, now: Instant, idle_timeout: Duration) -> Vec<Arc<GrokDaemon>> {
        let keys_to_reap: Vec<(String, String)> = self
            .daemons
            .iter()
            .filter_map(|(key, daemon)| {
                if daemon.try_mark_reaping(now, idle_timeout) {
                    Some(key.clone())
                } else {
                    None
                }
            })
            .collect();

        let mut removed = Vec::with_capacity(keys_to_reap.len());
        for key in keys_to_reap {
            if let Some(daemon) = self.daemons.remove(&key) {
                removed.push(daemon);
            }
        }
        removed
    }

    /// Reaps idle daemons with zero active sessions whose idle time exceeds `idle_timeout`
    /// (plus any crashed/dead daemons), returning the number of daemons reaped.
    pub fn reap_idle(&mut self, idle_timeout: Duration) -> usize {
        let removed = self.take_idle_at(Instant::now(), idle_timeout);
        let count = removed.len();
        for daemon in removed {
            daemon.shutdown();
        }
        count
    }

    #[cfg(test)]
    pub(crate) fn clear_all(&mut self) {
        let drained: Vec<Arc<GrokDaemon>> = self.daemons.drain().map(|(_, d)| d).collect();
        for daemon in drained {
            daemon.shutdown();
        }
    }
}

impl Drop for SharedGrokAcpPool {
    fn drop(&mut self) {
        let drained: Vec<Arc<GrokDaemon>> = self.daemons.drain().map(|(_, d)| d).collect();
        for daemon in drained {
            daemon.shutdown();
        }
    }
}

/// Global process-wide pool of shared `grok agent stdio` ACP daemons.
pub fn global_grok_pool() -> &'static Mutex<SharedGrokAcpPool> {
    static CELL: OnceLock<Mutex<SharedGrokAcpPool>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(SharedGrokAcpPool::new()))
}

/// Reaps zero-session idle Grok ACP daemons past `idle_timeout` from the global pool.
pub fn reap_idle_grok_daemons(idle_timeout: Duration) -> usize {
    let removed = {
        let Ok(mut pool) = global_grok_pool().lock() else {
            return 0;
        };
        pool.take_idle_at(Instant::now(), idle_timeout)
    };
    let count = removed.len();
    for daemon in removed {
        daemon.shutdown();
    }
    count
}

/// Returns `(active_daemon_count, active_session_count)` across the global Grok ACP pool.
pub fn grok_pool_stats() -> (usize, usize) {
    let Ok(pool) = global_grok_pool().lock() else {
        return (0, 0);
    };
    pool.stats()
}

#[derive(Clone)]
enum PoolTarget {
    Global,
    Scoped(Arc<Mutex<SharedGrokAcpPool>>),
}

impl PoolTarget {
    fn with_pool<R>(&self, f: impl FnOnce(&mut SharedGrokAcpPool) -> R) -> Result<R, String> {
        let mutex = match self {
            PoolTarget::Global => global_grok_pool(),
            PoolTarget::Scoped(arc) => arc.as_ref(),
        };
        let mut guard = mutex
            .lock()
            .map_err(|_| "the shared grok pool lock was poisoned".to_string())?;
        Ok(f(&mut guard))
    }
}

fn extra_env_value<'a>(extra_env: &'a [(String, String)], key: &str) -> Option<&'a str> {
    extra_env
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
}

fn acquire_daemon(
    pool_target: &PoolTarget,
    key: &(String, String),
    spec: &TransportSpec,
    program: Option<&PathBuf>,
    probe: &dyn DriverProbe,
) -> Result<(Arc<GrokDaemon>, PendingLeaseGuard), String> {
    let (daemon, launcher) = pool_target.with_pool(|pool| {
        let launcher = pool.launcher.clone();
        if let Some(existing) = pool.daemons.get(key).cloned() {
            if existing.try_acquire_lease() {
                return (existing, launcher);
            }
            pool.daemons.remove(key);
        }
        let fresh = GrokDaemon::new_starting();
        let reserved = fresh.try_acquire_lease();
        debug_assert!(reserved);
        pool.daemons.insert(key.clone(), Arc::clone(&fresh));
        (fresh, launcher)
    })?;

    let guard = PendingLeaseGuard::new(Arc::clone(&daemon));
    if let Err(err) = daemon.ensure_ready(key, spec, program, probe, launcher.as_ref()) {
        let _ = pool_target.with_pool(|pool| {
            if let Some(current) = pool.daemons.get(key) {
                if Arc::ptr_eq(current, &daemon) {
                    pool.daemons.remove(key);
                }
            }
        });
        return Err(err);
    }

    Ok((daemon, guard))
}

/// One multiplexed session lease on a shared `grok agent stdio` daemon.
pub struct GrokPooledSessionHandle {
    pool: PoolTarget,
    controls: PersistentControls,
    connection_id: Option<String>,
    program: Option<PathBuf>,
    probe: Box<dyn DriverProbe>,
    daemon: Option<Arc<GrokDaemon>>,
    session_id: Option<String>,
    events: Option<Arc<Mutex<VecDeque<TransportEvent>>>>,
    lease_active: bool,
    stopping: bool,
    exit_emitted: bool,
    spawns: u32,
}

impl GrokPooledSessionHandle {
    pub fn new(controls: PersistentControls) -> Self {
        Self::with_connection(controls, None)
    }

    pub fn with_connection(
        controls: PersistentControls,
        connection_id: Option<String>,
    ) -> Self {
        Self {
            pool: PoolTarget::Global,
            controls,
            connection_id,
            program: None,
            probe: Box::new(SystemDriverProbe),
            daemon: None,
            session_id: None,
            events: None,
            lease_active: false,
            stopping: false,
            exit_emitted: false,
            spawns: 0,
        }
    }

    pub fn with_connection_id(mut self, connection_id: Option<String>) -> Self {
        self.connection_id = connection_id;
        self
    }

    pub fn with_probe(
        controls: PersistentControls,
        program: Option<PathBuf>,
        probe: Box<dyn DriverProbe>,
    ) -> Self {
        let mut handle = Self::new(controls);
        handle.program = program;
        handle.probe = probe;
        handle
    }

    #[cfg(test)]
    pub(crate) fn with_pool(
        mut self,
        pool: Arc<Mutex<SharedGrokAcpPool>>,
    ) -> Self {
        self.pool = PoolTarget::Scoped(pool);
        self
    }

    fn release_lease(&mut self) {
        self.stopping = true;
        if self.lease_active {
            self.lease_active = false;
            if let (Some(daemon), Some(session_id)) =
                (self.daemon.as_ref(), self.session_id.as_deref())
            {
                daemon.release_session(session_id);
            }
        }
        self.events = None;
    }
}

impl fmt::Debug for GrokPooledSessionHandle {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GrokPooledSessionHandle")
            .field("controls", &self.controls)
            .field("connection_id", &self.connection_id)
            .field("session_id", &self.session_id)
            .field("lease_active", &self.lease_active)
            .field("spawns", &self.spawns)
            .finish()
    }
}

impl SessionTransport for GrokPooledSessionHandle {
    fn spawn(&mut self, spec: &TransportSpec) -> Result<(), String> {
        let declared = declaration(&spec.driver)
            .ok_or_else(|| format!("{} has no driver declaration in this build", spec.driver))?;
        if declared.driver != GROK_DRIVER {
            return Err(format!("{} does not speak the grok stdio wire", spec.driver));
        }

        if self.lease_active {
            if !self.stopping && self.daemon.as_ref().is_some_and(|d| d.is_alive()) {
                return Err("the grok pooled session already has an active lease".to_string());
            }
            self.release_lease();
        }

        let effective_conn = self
            .connection_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .or_else(|| extra_env_value(&spec.extra_env, "KITE_CONNECTION_ID"));
        let key = grok_pool_key(effective_conn, self.controls.permission_mode.as_deref());

        let (daemon, guard) = acquire_daemon(
            &self.pool,
            &key,
            spec,
            self.program.as_ref(),
            self.probe.as_ref(),
        )?;

        let (session_id, events_arc) = match daemon
            .open_session(spec.working_directory.as_deref(), spec.resume_handle.as_deref())
        {
            Ok(opened) => opened,
            Err(err) => {
                drop(guard);
                if daemon.is_dead() {
                    let _ = self.pool.with_pool(|pool| {
                        if let Some(current) = pool.daemons.get(&key) {
                            if Arc::ptr_eq(current, &daemon) {
                                pool.daemons.remove(&key);
                            }
                        }
                    });
                }
                return Err(err);
            }
        };

        let daemon = guard.commit();
        self.daemon = Some(daemon);
        self.session_id = Some(session_id);
        self.events = Some(events_arc);
        self.lease_active = true;
        self.stopping = false;
        self.exit_emitted = false;
        self.spawns += 1;
        Ok(())
    }

    fn write_turn(&mut self, prompt: &str) -> Result<(), String> {
        if self.stopping || !self.lease_active {
            return Err("the grok pooled session is not active".to_string());
        }
        let Some(daemon) = self.daemon.as_ref() else {
            return Err("the grok pooled session has no daemon".to_string());
        };
        let Some(session_id) = self.session_id.as_deref() else {
            return Err("the grok session has no id, so the message was not written".to_string());
        };
        daemon.write_turn(session_id, &self.controls, prompt)
    }

    fn write_frame(&mut self, frame: &str) -> Result<(), String> {
        if self.stopping || !self.lease_active {
            return Err("the grok pooled session ended before the frame was written".to_string());
        }
        let Some(daemon) = self.daemon.as_ref() else {
            return Err("the grok pooled session has no daemon".to_string());
        };
        if !daemon.is_alive() {
            return Err("the grok daemon ended before the frame was written".to_string());
        }
        let trimmed = frame.trim_end();
        if trimmed.trim().is_empty() {
            return Err("cannot write an empty frame to the grok daemon".to_string());
        }
        daemon.write_raw(trimmed)
    }

    fn interrupt(&mut self) -> Result<(), String> {
        // Release only this session lease without killing sibling sessions on the shared daemon.
        self.release_lease();
        Ok(())
    }

    fn stop(&mut self) -> Result<(), String> {
        self.release_lease();
        Ok(())
    }

    fn spawn_count(&self) -> u32 {
        self.spawns
    }

    fn resume_handle(&self) -> Option<String> {
        self.session_id.clone()
    }

    fn drain(&mut self) -> Vec<TransportEvent> {
        let mut events: Vec<TransportEvent> = self
            .events
            .as_ref()
            .and_then(|queue_arc| {
                queue_arc
                    .lock()
                    .ok()
                    .map(|mut queue| queue.drain(..).collect())
            })
            .unwrap_or_default();

        if !self.stopping && !self.exit_emitted {
            if let Some(daemon) = self.daemon.as_ref() {
                if daemon.is_eof() {
                    let (code, error) = daemon.ensure_exit_outcome();
                    self.exit_emitted = true;
                    self.lease_active = false;
                    daemon.release_lease_count();
                    events.push(TransportEvent::Exit { code, error });
                }
            }
        }
        events
    }

    fn is_alive(&self) -> bool {
        if self.spawns == 0 {
            return !self.stopping;
        }
        if self.stopping || !self.lease_active || self.exit_emitted {
            return false;
        }
        self.daemon.as_ref().is_some_and(|d| d.is_alive())
    }

    fn controls(&self) -> Option<PersistentControls> {
        Some(self.controls.clone())
    }

    fn update_controls(&mut self, next: &PersistentControls) -> bool {
        if self.spawns == 0 {
            self.controls = next.clone();
            return true;
        }
        if self.controls.permission_mode != next.permission_mode {
            return false;
        }
        self.controls.model = next.model.clone();
        self.controls.effort = next.effort.clone();
        true
    }
}

impl Drop for GrokPooledSessionHandle {
    fn drop(&mut self) {
        self.release_lease();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::drivers::DriverVersion;
    use crate::chat::persistent::controls::plan_request_ack;
    use crate::chat::persistent::grok::use_shared_grok_mux_from;
    use crate::chat::session::SessionMode;

    #[derive(Debug)]
    struct TestGrokProbe;

    impl DriverProbe for TestGrokProbe {
        fn probe(
            &self,
            _driver: &str,
            _program: &Path,
            _evidence: &DriverVersion,
        ) -> Result<String, String> {
            Ok("grok 1.0.77 (50ca579fa996)".to_string())
        }
    }

    #[derive(Debug)]
    struct StaleGrokProbe;

    impl DriverProbe for StaleGrokProbe {
        fn probe(
            &self,
            _driver: &str,
            _program: &Path,
            _evidence: &DriverVersion,
        ) -> Result<String, String> {
            Ok("grok 0.9.0".to_string())
        }
    }

    struct PipeBuffer {
        bytes: VecDeque<u8>,
        closed: bool,
    }

    #[derive(Clone)]
    struct MemoryPipe {
        inner: Arc<(Mutex<PipeBuffer>, Condvar)>,
    }

    impl MemoryPipe {
        fn pair() -> (MemoryPipeWriter, MemoryPipeReader) {
            let inner = Arc::new((
                Mutex::new(PipeBuffer {
                    bytes: VecDeque::new(),
                    closed: false,
                }),
                Condvar::new(),
            ));
            (
                MemoryPipeWriter {
                    pipe: Self {
                        inner: Arc::clone(&inner),
                    },
                },
                MemoryPipeReader {
                    pipe: Self { inner },
                },
            )
        }

        fn close(&self) {
            let (lock, cv) = &*self.inner;
            if let Ok(mut guard) = lock.lock() {
                guard.closed = true;
                cv.notify_all();
            }
        }
    }

    struct MemoryPipeWriter {
        pipe: MemoryPipe,
    }

    impl MemoryPipeWriter {
        fn write_line(&mut self, line: &str) -> std::io::Result<()> {
            self.write_all(line.as_bytes())?;
            self.write_all(b"\n")?;
            self.flush()
        }
    }

    impl Write for MemoryPipeWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            let (lock, cv) = &*self.pipe.inner;
            let mut guard = lock
                .lock()
                .map_err(|_| std::io::Error::new(std::io::ErrorKind::Other, "poisoned"))?;
            if guard.closed {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::BrokenPipe,
                    "pipe closed",
                ));
            }
            guard.bytes.extend(buf);
            cv.notify_all();
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl Drop for MemoryPipeWriter {
        fn drop(&mut self) {
            self.pipe.close();
        }
    }

    struct MemoryPipeReader {
        pipe: MemoryPipe,
    }

    impl Read for MemoryPipeReader {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            let (lock, cv) = &*self.pipe.inner;
            let mut guard = lock
                .lock()
                .map_err(|_| std::io::Error::new(std::io::ErrorKind::Other, "poisoned"))?;
            while guard.bytes.is_empty() && !guard.closed {
                guard = cv
                    .wait(guard)
                    .map_err(|_| std::io::Error::new(std::io::ErrorKind::Other, "poisoned"))?;
            }
            if guard.bytes.is_empty() && guard.closed {
                return Ok(0);
            }
            let count = buf.len().min(guard.bytes.len());
            for slot in buf.iter_mut().take(count) {
                *slot = guard.bytes.pop_front().expect("bounded byte");
            }
            Ok(count)
        }
    }

    #[derive(Clone, Default)]
    struct RecordedDaemonState {
        spawn_args: Arc<Mutex<Vec<Vec<String>>>>,
        written_frames: Arc<Mutex<Vec<String>>>,
        killed_count: Arc<AtomicU64>,
    }

    impl RecordedDaemonState {
        fn spawn_count(&self) -> usize {
            self.spawn_args.lock().unwrap().len()
        }

        fn args(&self) -> Vec<Vec<String>> {
            self.spawn_args.lock().unwrap().clone()
        }

        fn written(&self) -> Vec<String> {
            self.written_frames.lock().unwrap().clone()
        }

        fn kills(&self) -> u64 {
            self.killed_count.load(Ordering::SeqCst)
        }
    }

    enum ScriptMode {
        InterleavedThreeSessions,
        SimpleEcho,
        CloseImmediatelyOnTurn,
        ReplayOnLoad,
    }

    fn scripted_launcher(
        state: RecordedDaemonState,
        mode: ScriptMode,
    ) -> DaemonLauncher {
        let mode = Arc::new(mode);
        let next_session_seq = Arc::new(AtomicU64::new(1));
        Arc::new(move |_program, args, _cwd, _env| {
            state.spawn_args.lock().unwrap().push(args.to_vec());
            let (client_stdin_tx, daemon_stdin_rx) = MemoryPipe::pair();
            let (mut daemon_stdout_tx, client_stdout_rx) = MemoryPipe::pair();
            let stdin_closer = client_stdin_tx.pipe.clone();
            let stdout_closer = daemon_stdout_tx.pipe.clone();
            let state_clone = state.clone();
            let mode_clone = Arc::clone(&mode);
            let seq_clone = Arc::clone(&next_session_seq);

            std::thread::spawn(move || {
                let mut reader = BufReader::new(daemon_stdin_rx);
                let mut line = String::new();
                let mut active_prompts: HashMap<String, u64> = HashMap::new();
                loop {
                    line.clear();
                    match reader.read_line(&mut line) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {
                            let trimmed = line.trim();
                            if trimmed.is_empty() {
                                continue;
                            }
                            state_clone
                                .written_frames
                                .lock()
                                .unwrap()
                                .push(trimmed.to_string());
                            let Ok(val) = serde_json::from_str::<Value>(trimmed) else {
                                continue;
                            };
                            let method = val.get("method").and_then(Value::as_str);
                            let id = val.get("id").cloned();

                            if method == Some("initialize") {
                                let _ = daemon_stdout_tx.write_line(
                                    &json!({
                                        "jsonrpc": "2.0",
                                        "id": id,
                                        "result": { "protocolVersion": 1 }
                                    })
                                    .to_string(),
                                );
                                continue;
                            }

                            if method == Some("session/new") {
                                let num = seq_clone.fetch_add(1, Ordering::SeqCst);
                                let sid = format!("grok-sess-{num}");
                                let _ = daemon_stdout_tx.write_line(
                                    &json!({
                                        "jsonrpc": "2.0",
                                        "id": id,
                                        "result": { "sessionId": sid }
                                    })
                                    .to_string(),
                                );
                                continue;
                            }

                            if method == Some("session/load") {
                                let sid = val
                                    .pointer("/params/sessionId")
                                    .and_then(Value::as_str)
                                    .unwrap_or("loaded-session");
                                if matches!(*mode_clone, ScriptMode::ReplayOnLoad) {
                                    for update in [
                                        json!({
                                            "sessionUpdate": "user_message_chunk",
                                            "content": { "type": "text", "text": "Prior prompt" }
                                        }),
                                        json!({
                                            "sessionUpdate": "agent_thought_chunk",
                                            "content": { "type": "text", "text": "Prior thought" }
                                        }),
                                        json!({
                                            "sessionUpdate": "tool_call",
                                            "toolCallId": "tc-old-1",
                                            "title": "Prior tool"
                                        }),
                                        json!({
                                            "sessionUpdate": "agent_message_chunk",
                                            "content": { "type": "text", "text": "Prior assistant reply M1" }
                                        }),
                                    ] {
                                        let _ = daemon_stdout_tx.write_line(
                                            &json!({
                                                "jsonrpc": "2.0",
                                                "method": "session/update",
                                                "params": {
                                                    "sessionId": sid,
                                                    "update": update
                                                }
                                            })
                                            .to_string(),
                                        );
                                    }
                                }
                                let _ = daemon_stdout_tx.write_line(
                                    &json!({
                                        "jsonrpc": "2.0",
                                        "id": id,
                                        "result": { "sessionId": sid }
                                    })
                                    .to_string(),
                                );
                                continue;
                            }

                            if method == Some("session/set_config_option") {
                                let _ = daemon_stdout_tx.write_line(
                                    &json!({
                                        "jsonrpc": "2.0",
                                        "id": id,
                                        "result": {}
                                    })
                                    .to_string(),
                                );
                                continue;
                            }

                            if method == Some("session/close") {
                                let _ = daemon_stdout_tx.write_line(
                                    &json!({
                                        "jsonrpc": "2.0",
                                        "id": id,
                                        "result": {}
                                    })
                                    .to_string(),
                                );
                                continue;
                            }

                            if method == Some("session/prompt") {
                                let sid = val
                                    .pointer("/params/sessionId")
                                    .and_then(Value::as_str)
                                    .unwrap_or("")
                                    .to_string();
                                let prompt_text = val
                                    .pointer("/params/prompt/0/text")
                                    .and_then(Value::as_str)
                                    .unwrap_or("");
                                let rpc_id = id.as_ref().and_then(Value::as_u64).unwrap_or(0);

                                match &*mode_clone {
                                    ScriptMode::CloseImmediatelyOnTurn => {
                                        daemon_stdout_tx.pipe.close();
                                        break;
                                    }
                                    ScriptMode::SimpleEcho | ScriptMode::ReplayOnLoad => {
                                        let _ = daemon_stdout_tx.write_line(
                                            &json!({
                                                "jsonrpc": "2.0",
                                                "method": "session/update",
                                                "params": {
                                                    "sessionId": sid,
                                                    "update": {
                                                        "sessionUpdate": "agent_message_chunk",
                                                        "content": { "type": "text", "text": format!("echo:{prompt_text}") }
                                                    }
                                                }
                                            })
                                            .to_string(),
                                        );
                                        let _ = daemon_stdout_tx.write_line(
                                            &json!({
                                                "jsonrpc": "2.0",
                                                "id": rpc_id,
                                                "result": { "stopReason": "end_turn" }
                                            })
                                            .to_string(),
                                        );
                                    }
                                    ScriptMode::InterleavedThreeSessions => {
                                        active_prompts.insert(sid.clone(), rpc_id);
                                        if active_prompts.len() == 3 {
                                            // Interleave updates and reverse requests across all 3 sessions.
                                            let _ = daemon_stdout_tx.write_line(
                                                &json!({
                                                    "jsonrpc": "2.0",
                                                    "method": "session/update",
                                                    "params": {
                                                        "sessionId": "grok-sess-1",
                                                        "update": {
                                                            "sessionUpdate": "agent_message_chunk",
                                                            "content": { "type": "text", "text": "alpha" }
                                                        }
                                                    }
                                                })
                                                .to_string(),
                                            );
                                            let _ = daemon_stdout_tx.write_line(
                                                &json!({
                                                    "jsonrpc": "2.0",
                                                    "id": "perm-1",
                                                    "method": "session/request_permission",
                                                    "params": {
                                                        "sessionId": "grok-sess-1",
                                                        "toolCall": { "toolName": "bash", "title": "Run cargo check" }
                                                    }
                                                })
                                                .to_string(),
                                            );
                                            let _ = daemon_stdout_tx.write_line(
                                                &json!({
                                                    "jsonrpc": "2.0",
                                                    "id": "q-2",
                                                    "method": "x.ai/ask_user_question",
                                                    "params": {
                                                        "sessionId": "grok-sess-2",
                                                        "questions": [{ "id": "target", "header": "Target" }]
                                                    }
                                                })
                                                .to_string(),
                                            );
                                            let _ = daemon_stdout_tx.write_line(
                                                &json!({
                                                    "jsonrpc": "2.0",
                                                    "id": 77,
                                                    "method": "x.ai/exit_plan_mode",
                                                    "params": {
                                                        "sessionId": "grok-sess-3",
                                                        "title": "Plan S3"
                                                    }
                                                })
                                                .to_string(),
                                            );
                                            let _ = daemon_stdout_tx.write_line(
                                                &json!({
                                                    "jsonrpc": "2.0",
                                                    "method": "x.ai/session/update",
                                                    "params": {
                                                        "sessionId": "grok-sess-2",
                                                        "update": {
                                                            "sessionUpdate": "agent_message_chunk",
                                                            "content": { "type": "text", "text": "beta" }
                                                        }
                                                    }
                                                })
                                                .to_string(),
                                            );
                                            let _ = daemon_stdout_tx.write_line(
                                                &json!({
                                                    "jsonrpc": "2.0",
                                                    "method": "_x.ai/session/update",
                                                    "params": {
                                                        "sessionId": "grok-sess-3",
                                                        "update": {
                                                            "sessionUpdate": "agent_message_chunk",
                                                            "content": { "type": "text", "text": "gamma" }
                                                        }
                                                    }
                                                })
                                                .to_string(),
                                            );
                                        }
                                        continue;
                                    }
                                }
                            } else if method.is_none() && id.is_some() {
                                // Interactive reverse RPC response sent via `write_frame`!
                                if id == Some(json!("perm-1")) {
                                    if let Some(pid) = active_prompts.remove("grok-sess-1") {
                                        let _ = daemon_stdout_tx.write_line(
                                            &json!({
                                                "jsonrpc": "2.0",
                                                "method": "_x.ai/session/update",
                                                "params": {
                                                    "sessionId": "grok-sess-1",
                                                    "update": { "sessionUpdate": "turn_completed" }
                                                }
                                            })
                                            .to_string(),
                                        );
                                        let _ = daemon_stdout_tx.write_line(
                                            &json!({
                                                "jsonrpc": "2.0",
                                                "id": pid,
                                                "result": { "stopReason": "end_turn" }
                                            })
                                            .to_string(),
                                        );
                                    }
                                } else if id == Some(json!("q-2")) {
                                    if let Some(pid) = active_prompts.remove("grok-sess-2") {
                                        let _ = daemon_stdout_tx.write_line(
                                            &json!({
                                                "jsonrpc": "2.0",
                                                "id": pid,
                                                "result": { "stopReason": "end_turn" }
                                            })
                                            .to_string(),
                                        );
                                    }
                                } else if id == Some(json!(77)) {
                                    if let Some(pid) = active_prompts.remove("grok-sess-3") {
                                        let _ = daemon_stdout_tx.write_line(
                                            &json!({
                                                "jsonrpc": "2.0",
                                                "method": "_x.ai/session/update",
                                                "params": {
                                                    "sessionId": "grok-sess-3",
                                                    "update": { "sessionUpdate": "turn_completed" }
                                                }
                                            })
                                            .to_string(),
                                        );
                                        let _ = daemon_stdout_tx.write_line(
                                            &json!({
                                                "jsonrpc": "2.0",
                                                "id": pid,
                                                "result": { "stopReason": "end_turn" }
                                            })
                                            .to_string(),
                                        );
                                    }
                                }
                            }
                        }
                    }
                }
            });

            let killed_counter = Arc::clone(&state.killed_count);
            Ok(DaemonPipe {
                stdin: Box::new(client_stdin_tx),
                stdout: Box::new(client_stdout_rx),
                stderr: None,
                child: None,
                on_kill: Some(Box::new(move || {
                    killed_counter.fetch_add(1, Ordering::SeqCst);
                    stdin_closer.close();
                    stdout_closer.close();
                })),
            })
        })
    }

    fn test_spec(session_id: &str, resume_handle: Option<&str>) -> TransportSpec {
        TransportSpec {
            session_id: session_id.to_string(),
            driver: "grok".to_string(),
            working_directory: Some("C:\\work".to_string()),
            mode: SessionMode::Persistent,
            recipe_revision: None,
            resume_handle: resume_handle.map(str::to_string),
            extra_env: Vec::new(),
        }
    }

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

    fn drain_until<F>(handle: &mut GrokPooledSessionHandle, mut pred: F) -> Vec<TransportEvent>
    where
        F: FnMut(&[TransportEvent]) -> bool,
    {
        let mut collected = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            collected.extend(handle.drain());
            if pred(&collected) {
                return collected;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        collected
    }

    fn global_pool_test_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|p| p.into_inner())
    }

    struct GlobalPoolResetGuard;

    impl Drop for GlobalPoolResetGuard {
        fn drop(&mut self) {
            if let Ok(mut pool) = global_grok_pool().lock() {
                pool.set_launcher_for_test(None);
                pool.clear_all();
            }
        }
    }

    #[test]
    fn three_sessions_multiplex_and_isolate_demux_frames_and_reverse_rpcs() {
        let recorded = RecordedDaemonState::default();
        let pool = Arc::new(Mutex::new(SharedGrokAcpPool::with_launcher(
            scripted_launcher(recorded.clone(), ScriptMode::InterleavedThreeSessions),
        )));

        let mut s1 = GrokPooledSessionHandle::with_probe(
            controls(Some("grok-4.7"), Some("high"), Some("acceptEdits")),
            Some(PathBuf::from("kite-test-grok")),
            Box::new(TestGrokProbe),
        )
        .with_pool(Arc::clone(&pool));
        let mut s2 = GrokPooledSessionHandle::with_probe(
            controls(None, None, Some("default")),
            Some(PathBuf::from("kite-test-grok")),
            Box::new(TestGrokProbe),
        )
        .with_pool(Arc::clone(&pool));
        let mut s3 = GrokPooledSessionHandle::with_probe(
            controls(None, None, None),
            Some(PathBuf::from("kite-test-grok")),
            Box::new(TestGrokProbe),
        )
        .with_pool(Arc::clone(&pool));

        s1.spawn(&test_spec("t1:1", None)).expect("spawn s1");
        s2.spawn(&test_spec("t2:1", None)).expect("spawn s2");
        s3.spawn(&test_spec("t3:1", None)).expect("spawn s3");

        assert_eq!(recorded.spawn_count(), 1, "all 3 sessions share 1 daemon");
        assert_eq!(pool.lock().unwrap().stats(), (1, 3));
        assert_eq!(s1.resume_handle().as_deref(), Some("grok-sess-1"));
        assert_eq!(s2.resume_handle().as_deref(), Some("grok-sess-2"));
        assert_eq!(s3.resume_handle().as_deref(), Some("grok-sess-3"));

        s1.write_turn("turn one").expect("turn 1");
        s2.write_turn("turn two").expect("turn 2");
        s3.write_turn("turn three").expect("turn 3");

        let mut e1 = drain_until(&mut s1, |evs| {
            evs.iter().any(|e| *e == TransportEvent::Text("alpha".to_string()))
                && evs.iter().any(|e| matches!(e, TransportEvent::Activity(raw) if raw.contains("session/request_permission")))
        });
        let mut e2 = drain_until(&mut s2, |evs| {
            evs.iter().any(|e| *e == TransportEvent::Text("beta".to_string()))
                && evs.iter().any(|e| matches!(e, TransportEvent::Activity(raw) if raw.contains("x.ai/ask_user_question")))
        });
        let mut e3 = drain_until(&mut s3, |evs| {
            evs.iter().any(|e| *e == TransportEvent::Text("gamma".to_string()))
                && evs.iter().any(|e| matches!(e, TransportEvent::Activity(raw) if raw.contains("x.ai/exit_plan_mode")))
        });

        assert!(e1.iter().any(|e| *e == TransportEvent::Text("alpha".to_string())));
        assert!(e2.iter().any(|e| *e == TransportEvent::Text("beta".to_string())));
        assert!(e3.iter().any(|e| *e == TransportEvent::Text("gamma".to_string())));

        // Strictly zero cross-session leaks.
        assert!(!e1.iter().any(|e| format!("{e:?}").contains("beta") || format!("{e:?}").contains("gamma") || format!("{e:?}").contains("q-2")));
        assert!(!e2.iter().any(|e| format!("{e:?}").contains("alpha") || format!("{e:?}").contains("gamma") || format!("{e:?}").contains("perm-1")));
        assert!(!e3.iter().any(|e| format!("{e:?}").contains("alpha") || format!("{e:?}").contains("beta") || format!("{e:?}").contains("perm-1")));

        // Answer interactive permission, question, and plan requests over shared stdin.
        s1.write_frame(r#"{"jsonrpc":"2.0","id":"perm-1","result":{"outcome":{"outcome":"selected","optionId":"allow_once"}}}"#)
            .expect("perm reply");
        s2.write_frame(r#"{"jsonrpc":"2.0","id":"q-2","result":{"answers":{"target":"rust"}}}"#)
            .expect("question reply");
        s3.write_frame(&plan_request_ack("77")).expect("plan ack");

        e1.extend(drain_until(&mut s1, |evs| {
            evs.iter().any(|e| *e == TransportEvent::TurnEnded)
        }));
        e2.extend(drain_until(&mut s2, |evs| {
            evs.iter().any(|e| *e == TransportEvent::TurnEnded)
        }));
        e3.extend(drain_until(&mut s3, |evs| {
            evs.iter().any(|e| *e == TransportEvent::TurnEnded)
        }));

        assert_eq!(
            e1.iter().filter(|e| **e == TransportEvent::TurnEnded).count(),
            1,
            "turn_completed + JSON-RPC prompt result must not duplicate TurnEnded: {e1:?}"
        );
        assert_eq!(
            e2.iter().filter(|e| **e == TransportEvent::TurnEnded).count(),
            1
        );
        assert_eq!(
            e3.iter().filter(|e| **e == TransportEvent::TurnEnded).count(),
            1
        );

        let written = recorded.written();
        assert!(written.iter().any(|l| l.contains("\"id\":\"perm-1\"") && l.contains("allow_once")));
        assert!(written.iter().any(|l| l.contains("\"id\":\"q-2\"") && l.contains("rust")));
        assert!(written.iter().any(|l| l.contains("\"id\":77") && l.contains("\"result\":{}")));
    }

    #[test]
    fn permission_mode_keys_isolate_daemons_and_never_mix_modes() {
        assert_ne!(
            grok_pool_key(None, Some("bypassPermissions")),
            grok_pool_key(None, Some("default"))
        );
        assert_eq!(
            grok_pool_key(None, Some("fullAccess")),
            grok_pool_key(None, Some("bypassPermissions"))
        );
        assert_eq!(
            grok_pool_key(None, Some("acceptEdits")),
            grok_pool_key(None, Some("default"))
        );
        assert_ne!(
            grok_pool_key(Some("conn-a"), Some("default")),
            grok_pool_key(Some("conn-b"), Some("default"))
        );

        let recorded = RecordedDaemonState::default();
        let pool = Arc::new(Mutex::new(SharedGrokAcpPool::with_launcher(
            scripted_launcher(recorded.clone(), ScriptMode::SimpleEcho),
        )));

        let mut bypass_one = GrokPooledSessionHandle::with_probe(
            controls(None, None, Some("bypassPermissions")),
            Some(PathBuf::from("kite-test-grok")),
            Box::new(TestGrokProbe),
        )
        .with_pool(Arc::clone(&pool));
        let mut default_one = GrokPooledSessionHandle::with_probe(
            controls(None, None, Some("default")),
            Some(PathBuf::from("kite-test-grok")),
            Box::new(TestGrokProbe),
        )
        .with_pool(Arc::clone(&pool));
        let mut bypass_alias = GrokPooledSessionHandle::with_probe(
            controls(None, None, Some("fullAccess")),
            Some(PathBuf::from("kite-test-grok")),
            Box::new(TestGrokProbe),
        )
        .with_pool(Arc::clone(&pool));
        let mut conn_b_bypass = GrokPooledSessionHandle::with_probe(
            controls(None, None, Some("bypassPermissions")),
            Some(PathBuf::from("kite-test-grok")),
            Box::new(TestGrokProbe),
        )
        .with_connection_id(Some("conn-b".to_string()))
        .with_pool(Arc::clone(&pool));

        bypass_one.spawn(&test_spec("b1:1", None)).unwrap();
        default_one.spawn(&test_spec("d1:1", None)).unwrap();
        assert_eq!(recorded.spawn_count(), 2);

        bypass_alias.spawn(&test_spec("b2:1", None)).unwrap();
        assert_eq!(
            recorded.spawn_count(),
            2,
            "fullAccess shares the bypassPermissions daemon"
        );

        conn_b_bypass.spawn(&test_spec("c1:1", None)).unwrap();
        assert_eq!(
            recorded.spawn_count(),
            3,
            "distinct connection_id spawns an isolated daemon"
        );

        let keys = pool.lock().unwrap().keys();
        assert!(keys.contains(&("default".to_string(), "bypassPermissions".to_string())));
        assert!(keys.contains(&("default".to_string(), "default".to_string())));
        assert!(keys.contains(&("conn-b".to_string(), "bypassPermissions".to_string())));

        let args = recorded.args();
        assert!(args.iter().any(|a| a == &vec![
            "--permission-mode".to_string(),
            "bypassPermissions".to_string(),
            "agent".to_string(),
            "stdio".to_string(),
        ]));
        assert!(args.iter().any(|a| a == &vec![
            "--permission-mode".to_string(),
            "default".to_string(),
            "agent".to_string(),
            "stdio".to_string(),
        ]));

        assert!(
            !default_one.update_controls(&controls(None, None, Some("bypassPermissions"))),
            "changing permission mode must force reattach onto an isolated daemon"
        );
        assert!(
            default_one.update_controls(&controls(Some("grok-4.7"), Some("high"), Some("default"))),
            "changing model/effort keeps the existing pooled daemon lease"
        );
    }

    #[test]
    fn closing_session_keeps_siblings_intact_and_reap_idle_grok_daemons_respects_ttl() {
        let _guard = global_pool_test_lock();
        let _reset = GlobalPoolResetGuard;

        let recorded = RecordedDaemonState::default();
        {
            let mut pool = global_grok_pool().lock().unwrap();
            pool.clear_all();
            pool.set_launcher_for_test(Some(scripted_launcher(
                recorded.clone(),
                ScriptMode::SimpleEcho,
            )));
        }

        let mut d1_s1 = GrokPooledSessionHandle::with_probe(
            controls(None, None, Some("default")),
            Some(PathBuf::from("kite-test-grok")),
            Box::new(TestGrokProbe),
        );
        let mut d1_s2 = GrokPooledSessionHandle::with_probe(
            controls(None, None, Some("default")),
            Some(PathBuf::from("kite-test-grok")),
            Box::new(TestGrokProbe),
        );
        let mut d2_s1 = GrokPooledSessionHandle::with_probe(
            controls(None, None, Some("bypassPermissions")),
            Some(PathBuf::from("kite-test-grok")),
            Box::new(TestGrokProbe),
        );

        d1_s1.spawn(&test_spec("t1:1", None)).unwrap();
        d1_s2.spawn(&test_spec("t2:1", None)).unwrap();
        d2_s1.spawn(&test_spec("t3:1", None)).unwrap();

        assert_eq!(grok_pool_stats(), (2, 3));
        assert_eq!(recorded.spawn_count(), 2);

        // Stop d1_s1: sibling d1_s2 must stay alive and working.
        let s1_id = d1_s1.resume_handle().unwrap();
        d1_s1.stop().unwrap();
        assert!(!d1_s1.is_alive());
        assert!(d1_s2.is_alive());
        assert_eq!(grok_pool_stats(), (2, 2));
        assert_eq!(recorded.kills(), 0);

        d1_s2.write_turn("sibling ping").unwrap();
        let s2_events = drain_until(&mut d1_s2, |evs| {
            evs.iter().any(|e| *e == TransportEvent::TurnEnded)
        });
        assert!(s2_events
            .iter()
            .any(|e| *e == TransportEvent::Text("echo:sibling ping".to_string())));

        // Drop d2_s1 so daemon D2 drops to 0 active sessions.
        let d2_sid = d2_s1.resume_handle().unwrap();
        drop(d2_s1);
        assert_eq!(grok_pool_stats(), (2, 1));
        assert_eq!(recorded.kills(), 0);

        // Wait briefly so the daemon receives session/close frames on stdin.
        let close_deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < close_deadline {
            let written = recorded.written();
            let has_s1 = written
                .iter()
                .any(|l| l.contains("\"method\":\"session/close\"") && l.contains(&s1_id));
            let has_d2 = written
                .iter()
                .any(|l| l.contains("\"method\":\"session/close\"") && l.contains(&d2_sid));
            if has_s1 && has_d2 {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let written = recorded.written();
        assert!(written
            .iter()
            .any(|l| l.contains("\"method\":\"session/close\"") && l.contains(&s1_id)));
        assert!(written
            .iter()
            .any(|l| l.contains("\"method\":\"session/close\"") && l.contains(&d2_sid)));

        // Before TTL expires, zero-session D2 is NOT reaped.
        let ttl = Duration::from_secs(60);
        assert_eq!(reap_idle_grok_daemons(ttl), 0);
        assert_eq!(grok_pool_stats(), (2, 1));

        // Backdate BOTH D1 and D2 past TTL: ONLY zero-session D2 is reaped; D1 stays alive for d1_s2!
        {
            let pool = global_grok_pool().lock().unwrap();
            assert!(pool.backdate_daemon_idle_for_test(
                &("default".to_string(), "default".to_string()),
                Duration::from_secs(120),
            ));
            assert!(pool.backdate_daemon_idle_for_test(
                &("default".to_string(), "bypassPermissions".to_string()),
                Duration::from_secs(120),
            ));
        }

        assert_eq!(reap_idle_grok_daemons(ttl), 1);
        assert_eq!(grok_pool_stats(), (1, 1));
        assert_eq!(recorded.kills(), 1);
        assert!(d1_s2.is_alive());

        // Once d1_s2 stops and D1 ages past TTL, D1 is reaped cleanly too.
        d1_s2.stop().unwrap();
        assert_eq!(grok_pool_stats(), (1, 0));
        assert_eq!(reap_idle_grok_daemons(ttl), 0);
        {
            let pool = global_grok_pool().lock().unwrap();
            assert!(pool.backdate_daemon_idle_for_test(
                &("default".to_string(), "default".to_string()),
                Duration::from_secs(120),
            ));
        }
        assert_eq!(reap_idle_grok_daemons(ttl), 1);
        assert_eq!(grok_pool_stats(), (0, 0));
        assert_eq!(recorded.kills(), 2);
    }

    #[test]
    fn concurrent_spawns_share_single_initialize_and_resume_uses_session_load() {
        let recorded = RecordedDaemonState::default();
        let pool = Arc::new(Mutex::new(SharedGrokAcpPool::with_launcher(
            scripted_launcher(recorded.clone(), ScriptMode::SimpleEcho),
        )));

        let mut joins = Vec::new();
        for idx in 0..3 {
            let pool_clone = Arc::clone(&pool);
            joins.push(std::thread::spawn(move || {
                let mut handle = GrokPooledSessionHandle::with_probe(
                    controls(None, None, Some("default")),
                    Some(PathBuf::from("kite-test-grok")),
                    Box::new(TestGrokProbe),
                )
                .with_pool(pool_clone);
                let resume = if idx == 2 { Some("resumed-sid-99") } else { None };
                handle.spawn(&test_spec(&format!("c-{idx}:1"), resume)).unwrap();
                handle
            }));
        }

        let mut handles: Vec<GrokPooledSessionHandle> =
            joins.into_iter().map(|j| j.join().unwrap()).collect();

        assert_eq!(recorded.spawn_count(), 1);
        assert_eq!(pool.lock().unwrap().stats(), (1, 3));
        let init_count = recorded
            .written()
            .iter()
            .filter(|l| l.contains("\"method\":\"initialize\""))
            .count();
        assert_eq!(init_count, 1, "initialize must be sent once per daemon");
        assert!(recorded
            .written()
            .iter()
            .any(|l| l.contains("\"method\":\"session/load\"") && l.contains("resumed-sid-99")));
        assert_eq!(handles[2].resume_handle().as_deref(), Some("resumed-sid-99"));

        for h in &mut handles {
            h.stop().unwrap();
        }
    }

    #[test]
    fn stale_version_fails_before_spawning_and_daemon_crash_notifies_all_sessions() {
        let recorded = RecordedDaemonState::default();
        let pool = Arc::new(Mutex::new(SharedGrokAcpPool::with_launcher(
            scripted_launcher(recorded.clone(), ScriptMode::CloseImmediatelyOnTurn),
        )));

        let mut stale = GrokPooledSessionHandle::with_probe(
            controls(None, None, Some("default")),
            Some(PathBuf::from("kite-test-grok")),
            Box::new(StaleGrokProbe),
        )
        .with_pool(Arc::clone(&pool));
        let err = stale.spawn(&test_spec("stale:1", None)).unwrap_err();
        assert!(err.contains("version check failed"), "{err}");
        assert_eq!(recorded.spawn_count(), 0);
        assert_eq!(pool.lock().unwrap().stats(), (0, 0));

        let mut s1 = GrokPooledSessionHandle::with_probe(
            controls(None, None, Some("default")),
            Some(PathBuf::from("kite-test-grok")),
            Box::new(TestGrokProbe),
        )
        .with_pool(Arc::clone(&pool));
        let mut s2 = GrokPooledSessionHandle::with_probe(
            controls(None, None, Some("default")),
            Some(PathBuf::from("kite-test-grok")),
            Box::new(TestGrokProbe),
        )
        .with_pool(Arc::clone(&pool));
        s1.spawn(&test_spec("crash-1:1", None)).unwrap();
        s2.spawn(&test_spec("crash-2:1", None)).unwrap();
        assert_eq!(pool.lock().unwrap().stats(), (1, 2));

        s1.write_turn("trigger crash").unwrap();

        let e1 = drain_until(&mut s1, |evs| {
            evs.iter().any(|e| matches!(e, TransportEvent::Exit { .. }))
        });
        let e2 = drain_until(&mut s2, |evs| {
            evs.iter().any(|e| matches!(e, TransportEvent::Exit { .. }))
        });
        assert!(e1.iter().any(|e| matches!(e, TransportEvent::Exit { .. })));
        assert!(e2.iter().any(|e| matches!(e, TransportEvent::Exit { .. })));
        assert!(!s1.is_alive());
        assert!(!s2.is_alive());
        assert_eq!(pool.lock().unwrap().stats(), (0, 0));
    }

    #[test]
    fn shared_mux_env_gate_matches_grok_module() {
        assert!(use_shared_grok_mux_from(None));
        assert!(!use_shared_grok_mux_from(Some("0")));
    }

    #[test]
    fn demux_routes_all_notification_aliases_and_bounds_queue_at_max_pending_events() {
        use crate::chat::persistent::controls::MAX_PENDING_EVENTS;

        let daemon = GrokDaemon::new_starting();
        let q1 = Arc::new(Mutex::new(VecDeque::new()));
        let q2 = Arc::new(Mutex::new(VecDeque::new()));
        {
            let mut routing = daemon.routing.lock().unwrap();
            routing.sessions.insert(
                "s-alias".to_string(),
                SessionRoute {
                    events: Arc::clone(&q1),
                    active_prompt_id: Some(1),
                },
            );
            routing.sessions.insert(
                "s-other".to_string(),
                SessionRoute {
                    events: Arc::clone(&q2),
                    active_prompt_id: Some(2),
                },
            );
        }

        let alias_frames = [
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s-alias","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"u1"}}}}"#,
            r#"{"jsonrpc":"2.0","method":"_x.ai/session/update","params":{"sessionId":"s-alias","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"u2"}}}}"#,
            r#"{"jsonrpc":"2.0","method":"x.ai/session/update","params":{"sessionId":"s-alias","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"u3"}}}}"#,
            r#"{"jsonrpc":"2.0","id":"p1","method":"session/request_permission","params":{"sessionId":"s-alias"}}"#,
            r#"{"jsonrpc":"2.0","id":"p2","method":"permission/request","params":{"sessionId":"s-alias"}}"#,
            r#"{"jsonrpc":"2.0","id":"q1","method":"x.ai/ask_user_question","params":{"sessionId":"s-alias"}}"#,
            r#"{"jsonrpc":"2.0","id":"q2","method":"_x.ai/ask_user_question","params":{"sessionId":"s-alias"}}"#,
            r#"{"jsonrpc":"2.0","id":"q3","method":"AskUserQuestion","params":{"sessionId":"s-alias"}}"#,
            r#"{"jsonrpc":"2.0","id":"pl1","method":"x.ai/exit_plan_mode","params":{"sessionId":"s-alias"}}"#,
            r#"{"jsonrpc":"2.0","id":"pl2","method":"_x.ai/exit_plan_mode","params":{"sessionId":"s-alias"}}"#,
        ];

        for frame in alias_frames {
            handle_daemon_line(&daemon, frame);
        }

        assert_eq!(q1.lock().unwrap().len(), alias_frames.len());
        assert!(q2.lock().unwrap().is_empty(), "sibling queue must stay empty");
        q1.lock().unwrap().clear();

        for i in 0..(MAX_PENDING_EVENTS + 50) {
            let line = format!(
                r#"{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"s-alias","update":{{"sessionUpdate":"agent_message_chunk","content":{{"type":"text","text":"chunk-{i}"}}}}}}}}"#
            );
            handle_daemon_line(&daemon, &line);
        }
        handle_daemon_line(
            &daemon,
            r#"{"jsonrpc":"2.0","method":"_x.ai/session/update","params":{"sessionId":"s-alias","update":{"sessionUpdate":"turn_completed"}}}"#,
        );

        let guard = q1.lock().unwrap();
        assert_eq!(guard.len(), MAX_PENDING_EVENTS);
        assert_eq!(guard.back(), Some(&TransportEvent::TurnEnded));
        assert!(q2.lock().unwrap().is_empty());
    }

    #[test]
    fn resumed_session_load_history_replay_does_not_leak_into_next_turn() {
        let daemon = GrokDaemon::new_starting();
        let idle_queue = Arc::new(Mutex::new(VecDeque::new()));
        {
            let mut routing = daemon.routing.lock().unwrap();
            routing.sessions.insert(
                "s-idle".to_string(),
                SessionRoute {
                    events: Arc::clone(&idle_queue),
                    active_prompt_id: None,
                },
            );
        }
        for frame in [
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s-idle","update":{"sessionUpdate":"user_message_chunk","content":{"text":"Prior prompt"}}}}"#,
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s-idle","update":{"sessionUpdate":"agent_message_chunk","content":{"text":"Prior reply"}}}}"#,
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s-idle","update":{"sessionUpdate":"agent_thought_chunk","content":{"text":"Prior thought"}}}}"#,
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s-idle","update":{"sessionUpdate":"tool_call","toolCallId":"old-tc"}}}"#,
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s-idle","update":{"sessionUpdate":"turn_completed"}}}"#,
        ] {
            handle_daemon_line(&daemon, frame);
        }
        assert!(
            idle_queue.lock().unwrap().is_empty(),
            "idle/unprompted ACP session/update notifications must not enqueue into route.events"
        );

        let recorded = RecordedDaemonState::default();
        let pool = Arc::new(Mutex::new(SharedGrokAcpPool::with_launcher(
            scripted_launcher(recorded, ScriptMode::ReplayOnLoad),
        )));

        let mut handle = GrokPooledSessionHandle::with_probe(
            controls(None, None, Some("default")),
            Some(PathBuf::from("kite-test-grok")),
            Box::new(TestGrokProbe),
        )
        .with_pool(Arc::clone(&pool));
        handle
            .spawn(&test_spec("replay-1:1", Some("resumed-sid-replay")))
            .unwrap();

        let pre_turn = handle.drain();
        assert!(
            pre_turn.is_empty(),
            "session/load history replay must produce zero turn events before write_turn: {pre_turn:?}"
        );

        handle.write_turn("Turn 2 prompt").unwrap();
        let events = drain_until(&mut handle, |evs| {
            evs.iter().any(|ev| matches!(ev, TransportEvent::TurnEnded))
        });
        assert_eq!(
            events,
            vec![
                TransportEvent::Text("echo:Turn 2 prompt".to_string()),
                TransportEvent::TurnEnded,
            ]
        );

        handle.stop().unwrap();
    }
}
