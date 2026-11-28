//! Centralized Shared Stdio MCP Multiplexer (`S4`).
//!
//! Hosts at most one shared upstream stdio child process per registered
//! `(server_name, command, args, env_fingerprint)` specification, multiplexing
//! concurrent JSON-RPC 2.0 clients with unique `u64` upstream request IDs,
//! bidirectional `(client_id, original_req_id) <-> upstream_id` remapping,
//! `initialize` / `tools/list` caching, `kite-ctx` response compression, and
//! idle process reaping.

use std::collections::HashMap;
use std::fmt;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use kite_ctx::mcp_proxy::{
    compress_mcp_jsonrpc_line_stateful, McpProxySessionState, DEFAULT_MCP_MIN_BYTES,
};
use kite_ctx::ContextEngine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// Default idle timeout before unused pooled stdio MCP upstream processes are reaped (`10m`).
pub const DEFAULT_MCP_IDLE_TIMEOUT: Duration = Duration::from_secs(600);
/// Default request timeout when waiting for a single upstream JSON-RPC response.
pub const DEFAULT_MCP_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum McpHubError {
    ServerNotRegistered(String),
    SpawnFailed(String),
    Io(String),
    Timeout(String),
    InvalidMessage(String),
}

impl fmt::Display for McpHubError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ServerNotRegistered(name) => {
                write!(f, "Pooled MCP server '{name}' is not registered")
            }
            Self::SpawnFailed(msg) => write!(f, "Failed to spawn pooled MCP server: {msg}"),
            Self::Io(msg) => write!(f, "Pooled MCP I/O error: {msg}"),
            Self::Timeout(msg) => write!(f, "Pooled MCP request timed out: {msg}"),
            Self::InvalidMessage(msg) => write!(f, "Invalid MCP JSON-RPC message: {msg}"),
        }
    }
}

impl std::error::Error for McpHubError {}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct PooledServerKey {
    pub server_name: String,
    pub command: String,
    pub args: Vec<String>,
    pub env_fingerprint: String,
}

#[derive(Debug, Clone)]
pub struct PooledServerSpec {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub env_fingerprint: String,
}

impl PooledServerSpec {
    pub fn key(&self) -> PooledServerKey {
        PooledServerKey {
            server_name: self.name.clone(),
            command: self.command.clone(),
            args: self.args.clone(),
            env_fingerprint: self.env_fingerprint.clone(),
        }
    }
}

/// Computes a deterministic SHA-256 fingerprint over `(key, value)` environment pairs.
pub fn compute_env_fingerprint(env: &[(String, String)]) -> String {
    let mut sorted: Vec<(&str, &str)> = env
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    sorted.sort_unstable();
    let mut hasher = Sha256::new();
    for (k, v) in sorted {
        hasher.update((k.len() as u64).to_le_bytes());
        hasher.update(k.as_bytes());
        hasher.update((v.len() as u64).to_le_bytes());
        hasher.update(v.as_bytes());
    }
    format!("{:x}", hasher.finalize())
}

/// Abstract stdio transport handle returned by an [`UpstreamSpawner`].
pub struct UpstreamTransport {
    pub writer: Box<dyn Write + Send>,
    pub reader: Box<dyn BufRead + Send>,
    pub terminator: Box<dyn FnOnce() + Send>,
    pub alive_probe: Option<Box<dyn Fn() -> bool + Send + Sync>>,
}

/// Pluggable spawner factory enabling mock stdio MCP upstreams in unit tests.
pub type UpstreamSpawner =
    Arc<dyn Fn(&PooledServerSpec) -> Result<UpstreamTransport, String> + Send + Sync>;

fn resolve_command_path(command: &str) -> PathBuf {
    let candidate = Path::new(command);
    if candidate.is_file() {
        return candidate.to_path_buf();
    }
    crate::chat::utils::find_in_path(command).unwrap_or_else(|| candidate.to_path_buf())
}

fn spawn_hidden_stdio_upstream(spec: &PooledServerSpec) -> Result<UpstreamTransport, String> {
    let program = resolve_command_path(&spec.command);
    let arg_refs: Vec<&str> = spec.args.iter().map(String::as_str).collect();
    let mut child =
        crate::hidden_exec::spawn_streaming_with_owned_env(&program, &arg_refs, None, &spec.env)
            .map_err(|err| format!("{} ({}): {err}", spec.name, program.display()))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| format!("missing stdin pipe for '{}'", spec.name))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("missing stdout pipe for '{}'", spec.name))?;
    if let Some(mut stderr) = child.stderr.take() {
        let server_label = spec.name.clone();
        let _ = std::thread::Builder::new()
            .name(format!("kite-mcp-stderr-{server_label}"))
            .spawn(move || {
                let mut sink = [0u8; 4096];
                while let Ok(n) = stderr.read(&mut sink) {
                    if n == 0 {
                        break;
                    }
                }
            });
    }

    let child_slot = Arc::new(Mutex::new(Some(child)));
    let terminator_slot = Arc::clone(&child_slot);
    let terminator: Box<dyn FnOnce() + Send> = Box::new(move || {
        if let Ok(mut guard) = terminator_slot.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    });

    Ok(UpstreamTransport {
        writer: stdin,
        reader: Box::new(BufReader::new(stdout)),
        terminator,
        alive_probe: None,
    })
}

fn default_context_engine() -> Option<Arc<ContextEngine>> {
    #[cfg(test)]
    let res = ContextEngine::open_in_memory();
    #[cfg(not(test))]
    let res = ContextEngine::open_default().or_else(|_| ContextEngine::open_in_memory());
    res.ok().map(Arc::new)
}

#[derive(Debug, Clone)]
struct PendingRoute {
    client_id: String,
    original_id: Value,
    client_req_key: String,
}

enum ReplyWaiter {
    Sync(std::sync::mpsc::SyncSender<Result<Value, String>>),
    Async(tokio::sync::oneshot::Sender<Result<Value, String>>),
}

impl ReplyWaiter {
    fn send(self, value: Result<Value, String>) {
        match self {
            Self::Sync(tx) => {
                let _ = tx.try_send(value);
            }
            Self::Async(tx) => {
                let _ = tx.send(value);
            }
        }
    }
}

#[derive(Default)]
struct PendingRegistry {
    by_upstream: HashMap<u64, (PendingRoute, ReplyWaiter)>,
    client_to_upstream: HashMap<(String, String), u64>,
}

impl PendingRegistry {
    fn insert(&mut self, upstream_id: u64, route: PendingRoute, waiter: ReplyWaiter) {
        let lookup_key = (route.client_id.clone(), route.client_req_key.clone());
        self.client_to_upstream.insert(lookup_key, upstream_id);
        self.by_upstream.insert(upstream_id, (route, waiter));
    }

    fn remove_by_upstream(&mut self, upstream_id: u64) -> Option<(PendingRoute, ReplyWaiter)> {
        let removed = self.by_upstream.remove(&upstream_id)?;
        let lookup_key = (removed.0.client_id.clone(), removed.0.client_req_key.clone());
        if self.client_to_upstream.get(&lookup_key).copied() == Some(upstream_id) {
            self.client_to_upstream.remove(&lookup_key);
        }
        Some(removed)
    }

    fn lookup_upstream_id(&self, client_id: &str, original_id: &Value) -> Option<u64> {
        let key = canonical_req_id_key(original_id);
        self.client_to_upstream
            .get(&(client_id.to_string(), key))
            .copied()
    }

    fn drain_all(&mut self) -> Vec<(PendingRoute, ReplyWaiter)> {
        self.client_to_upstream.clear();
        self.by_upstream.drain().map(|(_, entry)| entry).collect()
    }
}

fn canonical_req_id_key(id: &Value) -> String {
    serde_json::to_string(id).unwrap_or_else(|_| "null".to_string())
}

enum CacheWaiter {
    Sync(std::sync::mpsc::SyncSender<Result<Value, String>>),
    Async(tokio::sync::oneshot::Sender<Result<Value, String>>),
}

impl CacheWaiter {
    fn send(self, result: Result<Value, String>) {
        match self {
            Self::Sync(tx) => {
                let _ = tx.try_send(result);
            }
            Self::Async(tx) => {
                let _ = tx.send(result);
            }
        }
    }
}

enum CacheSlotState {
    Empty,
    InFlight(Vec<CacheWaiter>),
    Ready(Value),
}

struct CacheSlot {
    state: Mutex<CacheSlotState>,
}

impl Default for CacheSlot {
    fn default() -> Self {
        Self {
            state: Mutex::new(CacheSlotState::Empty),
        }
    }
}

enum CacheAcquire<W> {
    Hit(Value),
    Leader,
    Waiter(W),
}

impl CacheSlot {
    fn acquire_sync(
        &self,
    ) -> CacheAcquire<std::sync::mpsc::Receiver<Result<Value, String>>> {
        let mut guard = self.state.lock().unwrap_or_else(|p| p.into_inner());
        match &mut *guard {
            CacheSlotState::Ready(val) => CacheAcquire::Hit(val.clone()),
            CacheSlotState::Empty => {
                *guard = CacheSlotState::InFlight(Vec::new());
                CacheAcquire::Leader
            }
            CacheSlotState::InFlight(waiters) => {
                let (tx, rx) = std::sync::mpsc::sync_channel(1);
                waiters.push(CacheWaiter::Sync(tx));
                CacheAcquire::Waiter(rx)
            }
        }
    }

    fn acquire_async(
        &self,
    ) -> CacheAcquire<tokio::sync::oneshot::Receiver<Result<Value, String>>> {
        let mut guard = self.state.lock().unwrap_or_else(|p| p.into_inner());
        match &mut *guard {
            CacheSlotState::Ready(val) => CacheAcquire::Hit(val.clone()),
            CacheSlotState::Empty => {
                *guard = CacheSlotState::InFlight(Vec::new());
                CacheAcquire::Leader
            }
            CacheSlotState::InFlight(waiters) => {
                let (tx, rx) = tokio::sync::oneshot::channel();
                waiters.push(CacheWaiter::Async(tx));
                CacheAcquire::Waiter(rx)
            }
        }
    }

    fn complete_success(&self, result: Value) {
        let waiters = {
            let mut guard = self.state.lock().unwrap_or_else(|p| p.into_inner());
            let prev = std::mem::replace(&mut *guard, CacheSlotState::Ready(result.clone()));
            match prev {
                CacheSlotState::InFlight(waiters) => waiters,
                _ => Vec::new(),
            }
        };
        for waiter in waiters {
            waiter.send(Ok(result.clone()));
        }
    }

    fn abort_leader(&self, err_msg: &str) {
        let waiters = {
            let mut guard = self.state.lock().unwrap_or_else(|p| p.into_inner());
            let prev = std::mem::replace(&mut *guard, CacheSlotState::Empty);
            match prev {
                CacheSlotState::InFlight(waiters) => waiters,
                CacheSlotState::Ready(val) => {
                    *guard = CacheSlotState::Ready(val);
                    Vec::new()
                }
                CacheSlotState::Empty => Vec::new(),
            }
        };
        for waiter in waiters {
            waiter.send(Err(err_msg.to_string()));
        }
    }

    fn invalidate(&self) {
        let mut guard = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if matches!(&*guard, CacheSlotState::Ready(_)) {
            *guard = CacheSlotState::Empty;
        }
    }
}

struct CacheLeaderGuard<'a> {
    slot: &'a CacheSlot,
    finished: bool,
}

impl<'a> CacheLeaderGuard<'a> {
    fn new(slot: &'a CacheSlot) -> Self {
        Self {
            slot,
            finished: false,
        }
    }

    fn complete(mut self, result: Value) {
        self.finished = true;
        self.slot.complete_success(result);
    }

    fn abort(mut self, reason: &str) {
        self.finished = true;
        self.slot.abort_leader(reason);
    }
}

impl Drop for CacheLeaderGuard<'_> {
    fn drop(&mut self) {
        if !self.finished {
            self.slot.abort_leader("cached request aborted");
        }
    }
}

struct LiveUpstream {
    server_name: String,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    terminator: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    alive_probe: Option<Box<dyn Fn() -> bool + Send + Sync>>,
    alive: AtomicBool,
    next_upstream_id: AtomicU64,
    in_flight: AtomicUsize,
    last_used_at: Mutex<Instant>,
    pending: Mutex<PendingRegistry>,
    init_cache: CacheSlot,
    tools_list_cache: CacheSlot,
    sent_initialized: AtomicBool,
    ctx_engine: Option<Arc<ContextEngine>>,
    proxy_state: Mutex<McpProxySessionState>,
    min_compress_bytes: usize,
}

impl LiveUpstream {
    fn start(
        spec: &PooledServerSpec,
        transport: UpstreamTransport,
        ctx_engine: Option<Arc<ContextEngine>>,
        min_compress_bytes: usize,
    ) -> Arc<Self> {
        let UpstreamTransport {
            writer,
            reader,
            terminator,
            alive_probe,
        } = transport;

        let upstream = Arc::new(Self {
            server_name: spec.name.clone(),
            writer: Mutex::new(Some(writer)),
            terminator: Mutex::new(Some(terminator)),
            alive_probe,
            alive: AtomicBool::new(true),
            next_upstream_id: AtomicU64::new(1),
            in_flight: AtomicUsize::new(0),
            last_used_at: Mutex::new(Instant::now()),
            pending: Mutex::new(PendingRegistry::default()),
            init_cache: CacheSlot::default(),
            tools_list_cache: CacheSlot::default(),
            sent_initialized: AtomicBool::new(false),
            ctx_engine,
            proxy_state: Mutex::new(McpProxySessionState::new()),
            min_compress_bytes,
        });

        let reader_upstream = Arc::clone(&upstream);
        let thread_name = format!("kite-mcp-hub-{}", spec.name);
        let _ = std::thread::Builder::new()
            .name(thread_name)
            .spawn(move || reader_upstream.reader_loop(reader));

        upstream
    }

    fn is_alive(&self) -> bool {
        if !self.alive.load(Ordering::Acquire) {
            return false;
        }
        if let Some(probe) = self.alive_probe.as_ref() {
            if !probe() {
                self.alive.store(false, Ordering::Release);
                return false;
            }
        }
        true
    }

    fn touch(&self) {
        if let Ok(mut guard) = self.last_used_at.lock() {
            *guard = Instant::now();
        }
    }

    fn idle_elapsed(&self) -> Duration {
        self.last_used_at
            .lock()
            .map(|t| t.elapsed())
            .unwrap_or_default()
    }

    fn in_flight_count(&self) -> usize {
        self.in_flight.load(Ordering::Acquire)
    }

    #[cfg(test)]
    fn lookup_upstream_id(&self, client_id: &str, original_id: &Value) -> Option<u64> {
        self.pending
            .lock()
            .ok()?
            .lookup_upstream_id(client_id, original_id)
    }

    fn write_json_line(&self, msg: &Value) -> Result<(), McpHubError> {
        let payload =
            serde_json::to_string(msg).map_err(|e| McpHubError::InvalidMessage(e.to_string()))?;
        if let Ok(mut state) = self.proxy_state.lock() {
            state.observe_request_line(&payload);
        }
        let mut guard = self.writer.lock().unwrap_or_else(|p| p.into_inner());
        let Some(writer) = guard.as_mut() else {
            self.alive.store(false, Ordering::Release);
            return Err(McpHubError::Io("upstream stdin closed".to_string()));
        };
        if let Err(err) = writeln!(writer, "{payload}").and_then(|_| writer.flush()) {
            self.alive.store(false, Ordering::Release);
            return Err(McpHubError::Io(err.to_string()));
        }
        Ok(())
    }

    fn remove_pending_entry(&self, upstream_id: u64) {
        if let Ok(mut reg) = self.pending.lock() {
            let _ = reg.remove_by_upstream(upstream_id);
        }
    }

    fn reader_loop(self: Arc<Self>, mut reader: Box<dyn BufRead + Send>) {
        while let Ok(Some(msg)) = read_upstream_jsonrpc_message(&mut reader) {
            let id_opt = msg.get("id").filter(|v| !v.is_null());
            let upstream_id_opt = id_opt.and_then(|v| {
                v.as_u64()
                    .or_else(|| v.as_str().and_then(|s| s.parse::<u64>().ok()))
            });

            if let Some(upstream_id) = upstream_id_opt {
                let entry = self
                    .pending
                    .lock()
                    .ok()
                    .and_then(|mut reg| reg.remove_by_upstream(upstream_id));
                if let Some((route, waiter)) = entry {
                    let mut out = self.maybe_compress_response(msg, &route.client_id);
                    if let Some(obj) = out.as_object_mut() {
                        obj.insert("id".to_string(), route.original_id);
                    }
                    waiter.send(Ok(out));
                }
            } else if msg.get("method").and_then(Value::as_str)
                == Some("notifications/tools/list_changed")
            {
                self.tools_list_cache.invalidate();
            }
        }

        self.alive.store(false, Ordering::Release);
        let remaining = self
            .pending
            .lock()
            .map(|mut reg| reg.drain_all())
            .unwrap_or_default();
        for (_, waiter) in remaining {
            waiter.send(Err("upstream MCP server disconnected".to_string()));
        }
    }

    fn maybe_compress_response(&self, msg: Value, session_id: &str) -> Value {
        let Some(engine) = self.ctx_engine.as_deref() else {
            return msg;
        };
        let Ok(raw_line) = serde_json::to_string(&msg) else {
            return msg;
        };
        if !raw_line.contains("\"result\"") || !raw_line.contains("\"content\"") {
            return msg;
        }
        let compressed = {
            let mut state = self.proxy_state.lock().unwrap_or_else(|p| p.into_inner());
            compress_mcp_jsonrpc_line_stateful(
                engine,
                &mut state,
                &raw_line,
                &self.server_name,
                self.min_compress_bytes,
                session_id,
                "kite-mcp-hub",
                "mcp",
                &self.server_name,
            )
        };
        if compressed == raw_line {
            msg
        } else {
            serde_json::from_str(&compressed).unwrap_or(msg)
        }
    }

    fn shutdown(&self) {
        self.alive.store(false, Ordering::Release);
        if let Ok(mut guard) = self.writer.lock() {
            drop(guard.take());
        }
        if let Ok(mut guard) = self.terminator.lock() {
            if let Some(term) = guard.take() {
                term();
            }
        }
        let remaining = self
            .pending
            .lock()
            .map(|mut reg| reg.drain_all())
            .unwrap_or_default();
        for (_, waiter) in remaining {
            waiter.send(Err("upstream MCP server shut down".to_string()));
        }
    }
}

impl Drop for LiveUpstream {
    fn drop(&mut self) {
        self.shutdown();
    }
}

struct InFlightGuard {
    upstream: Arc<LiveUpstream>,
    upstream_id: Option<u64>,
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        if let Some(uid) = self.upstream_id.take() {
            self.upstream.remove_pending_entry(uid);
        }
        self.upstream.in_flight.fetch_sub(1, Ordering::AcqRel);
        self.upstream.touch();
    }
}

fn read_upstream_jsonrpc_message<R: BufRead>(reader: &mut R) -> std::io::Result<Option<Value>> {
    let mut line = String::new();
    let mut content_length: Option<usize> = None;
    let mut in_headers = false;

    loop {
        line.clear();
        let n = reader.read_line(&mut line)?;
        if n == 0 {
            return Ok(None);
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            if in_headers {
                break;
            }
            continue;
        }
        if !in_headers && trimmed.starts_with('{') {
            if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
                return Ok(Some(parsed));
            }
            continue;
        }
        if let Some((k, v)) = trimmed.split_once(':') {
            if k.trim().eq_ignore_ascii_case("Content-Length") {
                in_headers = true;
                content_length = v.trim().parse::<usize>().ok();
                continue;
            }
            if in_headers || k.trim().eq_ignore_ascii_case("Content-Type") {
                in_headers = true;
                continue;
            }
        }
        if !in_headers {
            // Skip stray non-JSON startup diagnostics printed to stdout by an upstream MCP tool.
            crate::logger::log_trace(&format!("mcp_hub: skipped non-json stdout line: {trimmed}"));
            continue;
        }
    }

    let len = content_length.ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "missing Content-Length header",
        )
    })?;
    let mut buf = vec![0u8; len];
    reader.read_exact(&mut buf)?;
    let parsed = serde_json::from_slice::<Value>(&buf)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))?;
    Ok(Some(parsed))
}

struct UpstreamSlot {
    spec: PooledServerSpec,
    spawn_lock: Mutex<()>,
    live: Mutex<Option<Arc<LiveUpstream>>>,
}

impl UpstreamSlot {
    fn new(spec: PooledServerSpec) -> Self {
        Self {
            spec,
            spawn_lock: Mutex::new(()),
            live: Mutex::new(None),
        }
    }

    fn active_live(&self) -> Option<Arc<LiveUpstream>> {
        let guard = self.live.lock().unwrap_or_else(|p| p.into_inner());
        guard.as_ref().filter(|l| l.is_alive()).cloned()
    }

    fn get_or_spawn(
        &self,
        spawner: &UpstreamSpawner,
        ctx_engine: &Option<Arc<ContextEngine>>,
        min_compress_bytes: usize,
    ) -> Result<Arc<LiveUpstream>, McpHubError> {
        if let Some(existing) = self.active_live() {
            return Ok(existing);
        }
        let _spawn_guard = self.spawn_lock.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(existing) = self.active_live() {
            return Ok(existing);
        }
        let transport = (spawner)(&self.spec).map_err(McpHubError::SpawnFailed)?;
        let live = LiveUpstream::start(
            &self.spec,
            transport,
            ctx_engine.clone(),
            min_compress_bytes,
        );
        let mut guard = self.live.lock().unwrap_or_else(|p| p.into_inner());
        *guard = Some(Arc::clone(&live));
        Ok(live)
    }
}

#[derive(Default)]
struct HubRegistry {
    specs_by_name: HashMap<String, PooledServerSpec>,
    upstreams: HashMap<PooledServerKey, Arc<UpstreamSlot>>,
}

/// Shared pool of long-lived stdio MCP upstream processes indexed by
/// `(server_name, command, args, env_fingerprint)`.
pub struct SharedStdioMcpHub {
    registry: Mutex<HubRegistry>,
    spawner: UpstreamSpawner,
    ctx_engine: Option<Arc<ContextEngine>>,
    min_compress_bytes: usize,
}

impl Default for SharedStdioMcpHub {
    fn default() -> Self {
        Self::new()
    }
}

impl SharedStdioMcpHub {
    pub fn new() -> Self {
        Self::with_spawner(Arc::new(spawn_hidden_stdio_upstream))
    }

    pub fn with_spawner(spawner: UpstreamSpawner) -> Self {
        Self {
            registry: Mutex::new(HubRegistry::default()),
            spawner,
            ctx_engine: default_context_engine(),
            min_compress_bytes: DEFAULT_MCP_MIN_BYTES,
        }
    }

    #[cfg(test)]
    fn with_spawner_and_compress_threshold(
        spawner: UpstreamSpawner,
        min_compress_bytes: usize,
    ) -> Self {
        Self {
            registry: Mutex::new(HubRegistry::default()),
            spawner,
            ctx_engine: default_context_engine(),
            min_compress_bytes,
        }
    }

    /// Registers (or updates) a named stdio MCP server definition without spawning it yet.
    pub fn register_server(
        &self,
        name: &str,
        command: &str,
        args: &[String],
        env: &[(String, String)],
    ) {
        let clean_name = name.trim().to_string();
        let clean_cmd = command.trim().to_string();
        if clean_name.is_empty() || clean_cmd.is_empty() {
            return;
        }
        let spec = PooledServerSpec {
            name: clean_name.clone(),
            command: clean_cmd,
            args: args.to_vec(),
            env: env.to_vec(),
            env_fingerprint: compute_env_fingerprint(env),
        };
        let key = spec.key();
        let mut old_live_to_shutdown = None;
        {
            let mut reg = self.registry.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(prev) = reg.specs_by_name.insert(clean_name, spec.clone()) {
                let prev_key = prev.key();
                if prev_key != key {
                    if let Some(old_slot) = reg.upstreams.remove(&prev_key) {
                        if let Ok(mut guard) = old_slot.live.lock() {
                            old_live_to_shutdown = guard.take();
                        }
                    }
                }
            }
            reg.upstreams
                .entry(key)
                .or_insert_with(|| Arc::new(UpstreamSlot::new(spec)));
        }
        if let Some(live) = old_live_to_shutdown {
            live.shutdown();
        }
    }

    /// Unregisters a named stdio MCP server definition and shuts down any live
    /// upstream process for its key if no other registered spec shares it.
    pub fn unregister_server(&self, server_name: &str) -> bool {
        let clean_name = server_name.trim();
        if clean_name.is_empty() {
            return false;
        }
        let mut slot_to_shutdown: Option<Arc<UpstreamSlot>> = None;
        let existed = {
            let mut reg = self.registry.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(prev) = reg.specs_by_name.remove(clean_name) {
                let prev_key = prev.key();
                let still_in_use = reg.specs_by_name.values().any(|s| s.key() == prev_key);
                if !still_in_use {
                    slot_to_shutdown = reg.upstreams.remove(&prev_key);
                }
                true
            } else {
                false
            }
        };
        if let Some(slot) = slot_to_shutdown {
            let live_to_shutdown = {
                let _spawn_guard = slot.spawn_lock.lock().unwrap_or_else(|p| p.into_inner());
                let mut guard = slot.live.lock().unwrap_or_else(|p| p.into_inner());
                guard.take()
            };
            if let Some(live) = live_to_shutdown {
                live.shutdown();
            }
        }
        existed
    }

    pub fn has_registered_server(&self, name: &str) -> bool {
        let reg = self.registry.lock().unwrap_or_else(|p| p.into_inner());
        reg.specs_by_name.contains_key(name.trim())
    }

    pub fn registered_server_count(&self) -> usize {
        let reg = self.registry.lock().unwrap_or_else(|p| p.into_inner());
        reg.specs_by_name.len()
    }

    /// Number of currently live upstream stdio child processes hosted by this hub.
    pub fn active_upstream_count(&self) -> usize {
        let slots: Vec<Arc<UpstreamSlot>> = {
            let reg = self.registry.lock().unwrap_or_else(|p| p.into_inner());
            reg.upstreams.values().cloned().collect()
        };
        slots
            .into_iter()
            .filter(|slot| slot.active_live().is_some())
            .count()
    }

    fn resolve_or_spawn_upstream(&self, server_name: &str) -> Result<Arc<LiveUpstream>, McpHubError> {
        let clean_name = server_name.trim();
        let slot = {
            let mut reg = self.registry.lock().unwrap_or_else(|p| p.into_inner());
            let spec = reg
                .specs_by_name
                .get(clean_name)
                .cloned()
                .ok_or_else(|| McpHubError::ServerNotRegistered(clean_name.to_string()))?;
            let key = spec.key();
            Arc::clone(
                reg.upstreams
                    .entry(key)
                    .or_insert_with(|| Arc::new(UpstreamSlot::new(spec))),
            )
        };
        slot.get_or_spawn(&self.spawner, &self.ctx_engine, self.min_compress_bytes)
    }

    /// Reaps live upstream processes that have been idle (with zero in-flight requests)
    /// for at least `idle_timeout`, preserving registered server specs for lazy respawn.
    pub fn reap_idle(&self, idle_timeout: Duration) -> usize {
        let candidates: Vec<(PooledServerKey, Arc<UpstreamSlot>)> = {
            let reg = self.registry.lock().unwrap_or_else(|p| p.into_inner());
            reg.upstreams
                .iter()
                .map(|(k, v)| (k.clone(), Arc::clone(v)))
                .collect()
        };

        let mut to_shutdown: Vec<Arc<LiveUpstream>> = Vec::new();
        for (_key, slot) in candidates {
            let Ok(_spawn_guard) = slot.spawn_lock.try_lock() else {
                continue;
            };
            let mut guard = slot.live.lock().unwrap_or_else(|p| p.into_inner());
            let should_reap = guard.as_ref().is_some_and(|live| {
                !live.is_alive()
                    || (live.in_flight_count() == 0 && live.idle_elapsed() >= idle_timeout)
            });
            if should_reap {
                if let Some(live) = guard.take() {
                    to_shutdown.push(live);
                }
            }
        }

        let reaped = to_shutdown.len();
        for live in to_shutdown {
            live.shutdown();
        }
        reaped
    }

    pub fn shutdown_all(&self) {
        let slots: Vec<Arc<UpstreamSlot>> = {
            let mut reg = self.registry.lock().unwrap_or_else(|p| p.into_inner());
            reg.upstreams.drain().map(|(_, slot)| slot).collect()
        };
        for slot in slots {
            if let Ok(mut guard) = slot.live.lock() {
                if let Some(live) = guard.take() {
                    live.shutdown();
                }
            }
        }
    }

    fn should_cache_request(method: &str, msg: &Value) -> CacheTarget {
        match method {
            "initialize" => CacheTarget::Initialize,
            "tools/list" => {
                let has_cursor = msg
                    .get("params")
                    .and_then(|p| p.get("cursor"))
                    .is_some_and(|c| !c.is_null());
                if has_cursor {
                    CacheTarget::None
                } else {
                    CacheTarget::ToolsList
                }
            }
            _ => CacheTarget::None,
        }
    }

    fn send_raw_blocking(
        upstream: &Arc<LiveUpstream>,
        client_id: &str,
        msg: &Value,
        timeout: Duration,
    ) -> Result<Option<Value>, McpHubError> {
        let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
        let original_id = msg.get("id").cloned();

        if method.starts_with("notifications/") || original_id.is_none() {
            if method == "notifications/initialized"
                && upstream.sent_initialized.swap(true, Ordering::AcqRel)
            {
                upstream.touch();
                return Ok(None);
            }
            upstream.write_json_line(msg)?;
            upstream.touch();
            return Ok(None);
        }

        let original_id = original_id.unwrap_or(Value::Null);
        let upstream_id = upstream.next_upstream_id.fetch_add(1, Ordering::Relaxed);
        let mut outbound = msg.clone();
        let Some(obj) = outbound.as_object_mut() else {
            return Err(McpHubError::InvalidMessage(
                "JSON-RPC request must be an object".to_string(),
            ));
        };
        obj.insert("id".to_string(), json!(upstream_id));

        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        let route = PendingRoute {
            client_id: client_id.to_string(),
            client_req_key: canonical_req_id_key(&original_id),
            original_id,
        };

        upstream.in_flight.fetch_add(1, Ordering::AcqRel);
        upstream.touch();
        {
            let mut reg = upstream.pending.lock().unwrap_or_else(|p| p.into_inner());
            reg.insert(upstream_id, route, ReplyWaiter::Sync(tx));
        }
        let mut guard = InFlightGuard {
            upstream: Arc::clone(upstream),
            upstream_id: Some(upstream_id),
        };

        if let Err(err) = upstream.write_json_line(&outbound) {
            return Err(err);
        }

        match rx.recv_timeout(timeout) {
            Ok(Ok(resp)) => {
                guard.upstream_id = None;
                Ok(Some(resp))
            }
            Ok(Err(err_msg)) => {
                guard.upstream_id = None;
                Err(McpHubError::Io(err_msg))
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                Err(McpHubError::Timeout(format!(
                    "upstream '{}' exceeded {:?} waiting for id={upstream_id}",
                    upstream.server_name, timeout
                )))
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                guard.upstream_id = None;
                Err(McpHubError::Io("upstream response channel closed".to_string()))
            }
        }
    }

    async fn send_raw_async(
        upstream: &Arc<LiveUpstream>,
        client_id: &str,
        msg: &Value,
        timeout: Duration,
    ) -> Result<Option<Value>, McpHubError> {
        let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
        let original_id = msg.get("id").cloned();

        if method.starts_with("notifications/") || original_id.is_none() {
            if method == "notifications/initialized"
                && upstream.sent_initialized.swap(true, Ordering::AcqRel)
            {
                upstream.touch();
                return Ok(None);
            }
            upstream.write_json_line(msg)?;
            upstream.touch();
            return Ok(None);
        }

        let original_id = original_id.unwrap_or(Value::Null);
        let upstream_id = upstream.next_upstream_id.fetch_add(1, Ordering::Relaxed);
        let mut outbound = msg.clone();
        let Some(obj) = outbound.as_object_mut() else {
            return Err(McpHubError::InvalidMessage(
                "JSON-RPC request must be an object".to_string(),
            ));
        };
        obj.insert("id".to_string(), json!(upstream_id));

        let (tx, rx) = tokio::sync::oneshot::channel();
        let route = PendingRoute {
            client_id: client_id.to_string(),
            client_req_key: canonical_req_id_key(&original_id),
            original_id,
        };

        upstream.in_flight.fetch_add(1, Ordering::AcqRel);
        upstream.touch();
        {
            let mut reg = upstream.pending.lock().unwrap_or_else(|p| p.into_inner());
            reg.insert(upstream_id, route, ReplyWaiter::Async(tx));
        }
        let mut guard = InFlightGuard {
            upstream: Arc::clone(upstream),
            upstream_id: Some(upstream_id),
        };

        if let Err(err) = upstream.write_json_line(&outbound) {
            return Err(err);
        }

        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(Ok(resp))) => {
                guard.upstream_id = None;
                Ok(Some(resp))
            }
            Ok(Ok(Err(err_msg))) => {
                guard.upstream_id = None;
                Err(McpHubError::Io(err_msg))
            }
            Ok(Err(_closed)) => {
                guard.upstream_id = None;
                Err(McpHubError::Io("upstream response channel closed".to_string()))
            }
            Err(_elapsed) => Err(McpHubError::Timeout(format!(
                "upstream '{}' exceeded {:?} waiting for id={upstream_id}",
                upstream.server_name, timeout
            ))),
        }
    }

    /// Synchronous blocking JSON-RPC forwarding (for OS threads / sync tests).
    pub fn forward_jsonrpc_blocking(
        &self,
        server_name: &str,
        client_id: &str,
        msg: &Value,
        timeout: Duration,
    ) -> Result<Option<Value>, McpHubError> {
        let upstream = self.resolve_or_spawn_upstream(server_name)?;
        let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
        let original_id = msg.get("id").cloned();

        let Some(orig_id) = original_id.as_ref().filter(|_| !method.starts_with("notifications/")) else {
            return Self::send_raw_blocking(&upstream, client_id, msg, timeout);
        };

        let cache_slot = match Self::should_cache_request(method, msg) {
            CacheTarget::Initialize => &upstream.init_cache,
            CacheTarget::ToolsList => &upstream.tools_list_cache,
            CacheTarget::None => {
                return Self::send_raw_blocking(&upstream, client_id, msg, timeout);
            }
        };

        match cache_slot.acquire_sync() {
            CacheAcquire::Hit(cached_result) => {
                upstream.touch();
                Ok(Some(json!({
                    "jsonrpc": "2.0",
                    "id": orig_id,
                    "result": cached_result,
                })))
            }
            CacheAcquire::Waiter(rx) => match rx.recv_timeout(timeout) {
                Ok(Ok(cached_result)) => {
                    upstream.touch();
                    Ok(Some(json!({
                        "jsonrpc": "2.0",
                        "id": orig_id,
                        "result": cached_result,
                    })))
                }
                Ok(Err(err)) => Err(McpHubError::Io(err)),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => Err(McpHubError::Timeout(
                    format!("timed out waiting for cached '{method}' on '{}'", upstream.server_name),
                )),
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    Err(McpHubError::Io("cache waiter channel closed".to_string()))
                }
            },
            CacheAcquire::Leader => {
                let leader_guard = CacheLeaderGuard::new(cache_slot);
                match Self::send_raw_blocking(&upstream, client_id, msg, timeout) {
                    Ok(Some(resp)) => {
                        if let Some(result_val) = resp.get("result").cloned() {
                            leader_guard.complete(result_val);
                        } else {
                            leader_guard.abort("upstream returned non-result response");
                        }
                        Ok(Some(resp))
                    }
                    Ok(None) => {
                        leader_guard.abort("upstream returned empty response");
                        Ok(None)
                    }
                    Err(err) => {
                        let msg = err.to_string();
                        leader_guard.abort(&msg);
                        Err(err)
                    }
                }
            }
        }
    }

    /// Async non-blocking JSON-RPC forwarding (for the loopback HTTP Hub).
    pub async fn forward_jsonrpc(
        &self,
        server_name: &str,
        client_id: &str,
        msg: &Value,
        timeout: Duration,
    ) -> Result<Option<Value>, McpHubError> {
        let upstream = self.resolve_or_spawn_upstream(server_name)?;
        let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
        let original_id = msg.get("id").cloned();

        let Some(orig_id) = original_id.as_ref().filter(|_| !method.starts_with("notifications/")) else {
            return Self::send_raw_async(&upstream, client_id, msg, timeout).await;
        };

        let cache_slot = match Self::should_cache_request(method, msg) {
            CacheTarget::Initialize => &upstream.init_cache,
            CacheTarget::ToolsList => &upstream.tools_list_cache,
            CacheTarget::None => {
                return Self::send_raw_async(&upstream, client_id, msg, timeout).await;
            }
        };

        match cache_slot.acquire_async() {
            CacheAcquire::Hit(cached_result) => {
                upstream.touch();
                Ok(Some(json!({
                    "jsonrpc": "2.0",
                    "id": orig_id,
                    "result": cached_result,
                })))
            }
            CacheAcquire::Waiter(rx) => match tokio::time::timeout(timeout, rx).await {
                Ok(Ok(Ok(cached_result))) => {
                    upstream.touch();
                    Ok(Some(json!({
                        "jsonrpc": "2.0",
                        "id": orig_id,
                        "result": cached_result,
                    })))
                }
                Ok(Ok(Err(err))) => Err(McpHubError::Io(err)),
                Ok(Err(_)) => Err(McpHubError::Io("cache waiter channel closed".to_string())),
                Err(_) => Err(McpHubError::Timeout(format!(
                    "timed out waiting for cached '{method}' on '{}'",
                    upstream.server_name
                ))),
            },
            CacheAcquire::Leader => {
                let leader_guard = CacheLeaderGuard::new(cache_slot);
                match Self::send_raw_async(&upstream, client_id, msg, timeout).await {
                    Ok(Some(resp)) => {
                        if let Some(result_val) = resp.get("result").cloned() {
                            leader_guard.complete(result_val);
                        } else {
                            leader_guard.abort("upstream returned non-result response");
                        }
                        Ok(Some(resp))
                    }
                    Ok(None) => {
                        leader_guard.abort("upstream returned empty response");
                        Ok(None)
                    }
                    Err(err) => {
                        let msg = err.to_string();
                        leader_guard.abort(&msg);
                        Err(err)
                    }
                }
            }
        }
    }
}

enum CacheTarget {
    None,
    Initialize,
    ToolsList,
}

static GLOBAL_STDIO_MCP_HUB: OnceLock<SharedStdioMcpHub> = OnceLock::new();

pub fn global_stdio_mcp_hub() -> &'static SharedStdioMcpHub {
    GLOBAL_STDIO_MCP_HUB.get_or_init(SharedStdioMcpHub::new)
}

pub fn register_pooled_server(
    name: &str,
    command: &str,
    args: &[String],
    env: &[(String, String)],
) {
    global_stdio_mcp_hub().register_server(name, command, args, env);
}

pub fn unregister_pooled_server(name: &str) -> bool {
    global_stdio_mcp_hub().unregister_server(name)
}

pub fn reap_idle_upstream_servers(idle_timeout: Duration) -> usize {
    global_stdio_mcp_hub().reap_idle(idle_timeout)
}

pub fn pooled_server_count() -> usize {
    global_stdio_mcp_hub().active_upstream_count()
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use std::io::Cursor;

    struct ChannelWriter {
        tx: std::sync::mpsc::Sender<Vec<u8>>,
    }

    impl Write for ChannelWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.tx
                .send(buf.to_vec())
                .map_err(|_| std::io::Error::new(std::io::ErrorKind::BrokenPipe, "channel closed"))?;
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    struct ChannelReader {
        rx: std::sync::mpsc::Receiver<Vec<u8>>,
        cur: Cursor<Vec<u8>>,
    }

    impl Read for ChannelReader {
        fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
            loop {
                let n = self.cur.read(out)?;
                if n > 0 {
                    return Ok(n);
                }
                match self.rx.recv() {
                    Ok(bytes) => {
                        self.cur = Cursor::new(bytes);
                    }
                    Err(_) => return Ok(0),
                }
            }
        }
    }

    #[derive(Default)]
    pub struct MockUpstreamMetrics {
        pub spawn_count: AtomicUsize,
        pub initialize_count: AtomicUsize,
        pub tools_list_count: AtomicUsize,
        pub tool_call_count: AtomicUsize,
        pub shutdown_count: AtomicUsize,
    }

    pub fn make_mock_spawner(
        metrics: Arc<MockUpstreamMetrics>,
        extra_delay_ms: u64,
    ) -> UpstreamSpawner {
        Arc::new(move |_spec: &PooledServerSpec| {
            metrics.spawn_count.fetch_add(1, Ordering::SeqCst);
            let (in_tx, in_rx) = std::sync::mpsc::channel::<Vec<u8>>();
            let (out_tx, out_rx) = std::sync::mpsc::channel::<Vec<u8>>();
            let closed = Arc::new(AtomicBool::new(false));
            let closed_term = Arc::clone(&closed);
            let metrics_srv = Arc::clone(&metrics);
            let metrics_term = Arc::clone(&metrics);

            std::thread::spawn(move || {
                let mut reader = BufReader::new(ChannelReader {
                    rx: in_rx,
                    cur: Cursor::new(Vec::new()),
                });
                let mut line = String::new();
                while !closed.load(Ordering::Acquire) {
                    line.clear();
                    match reader.read_line(&mut line) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {}
                    }
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    let Ok(req) = serde_json::from_str::<Value>(trimmed) else {
                        continue;
                    };
                    let method = req.get("method").and_then(Value::as_str).unwrap_or("");
                    let Some(id) = req.get("id").cloned() else {
                        continue;
                    };
                    let out_tx_worker = out_tx.clone();
                    let metrics_worker = Arc::clone(&metrics_srv);
                    let method_owned = method.to_string();
                    let params = req.get("params").cloned().unwrap_or_else(|| json!({}));

                    // Spawn per-request handler so out-of-order concurrent replies prove zero ID collision!
                    std::thread::spawn(move || {
                        if extra_delay_ms > 0 {
                            std::thread::sleep(Duration::from_millis(extra_delay_ms));
                        }
                        let resp = match method_owned.as_str() {
                            "initialize" => {
                                metrics_worker.initialize_count.fetch_add(1, Ordering::SeqCst);
                                json!({
                                    "jsonrpc": "2.0",
                                    "id": id,
                                    "result": {
                                        "protocolVersion": "2024-11-05",
                                        "serverInfo": { "name": "mock-mcp", "version": "1.0.0" },
                                        "capabilities": { "tools": {} }
                                    }
                                })
                            }
                            "tools/list" => {
                                metrics_worker.tools_list_count.fetch_add(1, Ordering::SeqCst);
                                json!({
                                    "jsonrpc": "2.0",
                                    "id": id,
                                    "result": {
                                        "tools": [
                                            { "name": "mock_echo", "description": "Echoes input" }
                                        ]
                                    }
                                })
                            }
                            "tools/call" => {
                                metrics_worker.tool_call_count.fetch_add(1, Ordering::SeqCst);
                                let arg_tag = params
                                    .pointer("/arguments/tag")
                                    .and_then(Value::as_str)
                                    .unwrap_or("none");
                                if let Some(big_rows) =
                                    params.pointer("/arguments/big_rows").and_then(Value::as_u64)
                                {
                                    let rows: Vec<Value> = (0..big_rows)
                                        .map(|idx| {
                                            json!({
                                                "index": idx,
                                                "status": "ok",
                                                "workspace": "kite-desktop",
                                                "detail": format!("row {idx} from pooled mock server")
                                            })
                                        })
                                        .collect();
                                    let text = serde_json::to_string_pretty(&rows).unwrap();
                                    json!({
                                        "jsonrpc": "2.0",
                                        "id": id,
                                        "result": {
                                            "content": [{ "type": "text", "text": text }]
                                        }
                                    })
                                } else {
                                    json!({
                                        "jsonrpc": "2.0",
                                        "id": id,
                                        "result": {
                                            "content": [{
                                                "type": "text",
                                                "text": format!("echo:{arg_tag}")
                                            }]
                                        }
                                    })
                                }
                            }
                            other => json!({
                                "jsonrpc": "2.0",
                                "id": id,
                                "error": { "code": -32601, "message": format!("unknown method: {other}") }
                            }),
                        };
                        let mut encoded = serde_json::to_string(&resp).unwrap();
                        encoded.push('\n');
                        let _ = out_tx_worker.send(encoded.into_bytes());
                    });
                }
            });

            Ok(UpstreamTransport {
                writer: Box::new(ChannelWriter { tx: in_tx }),
                reader: Box::new(BufReader::new(ChannelReader {
                    rx: out_rx,
                    cur: Cursor::new(Vec::new()),
                })),
                terminator: Box::new(move || {
                    if !closed_term.swap(true, Ordering::SeqCst) {
                        metrics_term.shutdown_count.fetch_add(1, Ordering::SeqCst);
                    }
                }),
                alive_probe: None,
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::{make_mock_spawner, MockUpstreamMetrics};
    use super::*;

    #[test]
    fn five_concurrent_clients_share_one_upstream_with_zero_id_collisions_and_tools_list_cache() {
        let metrics = Arc::new(MockUpstreamMetrics::default());
        let hub = Arc::new(SharedStdioMcpHub::with_spawner(make_mock_spawner(
            Arc::clone(&metrics),
            10,
        )));
        hub.register_server("mock", "mock-mcp", &[], &[]);
        assert_eq!(hub.active_upstream_count(), 0);

        // Launch 5 concurrent clients all using the exact same original req id `1` and `2`
        let handles: Vec<_> = (0..5)
            .map(|idx| {
                let hub_ref = Arc::clone(&hub);
                std::thread::spawn(move || {
                    let client_id = format!("client-{idx}");
                    let init_resp = hub_ref
                        .forward_jsonrpc_blocking(
                            "mock",
                            &client_id,
                            &json!({
                                "jsonrpc": "2.0",
                                "id": 1,
                                "method": "initialize",
                                "params": { "protocolVersion": "2024-11-05" }
                            }),
                            Duration::from_secs(5),
                        )
                        .expect("init ok")
                        .expect("init response");
                    assert_eq!(init_resp["id"], 1);
                    assert_eq!(init_resp["result"]["serverInfo"]["name"], "mock-mcp");

                    let notif = hub_ref
                        .forward_jsonrpc_blocking(
                            "mock",
                            &client_id,
                            &json!({
                                "jsonrpc": "2.0",
                                "method": "notifications/initialized"
                            }),
                            Duration::from_secs(5),
                        )
                        .expect("notif ok");
                    assert!(notif.is_none());

                    let list_resp = hub_ref
                        .forward_jsonrpc_blocking(
                            "mock",
                            &client_id,
                            &json!({
                                "jsonrpc": "2.0",
                                "id": 1,
                                "method": "tools/list",
                                "params": {}
                            }),
                            Duration::from_secs(5),
                        )
                        .expect("tools/list ok")
                        .expect("tools/list response");
                    assert_eq!(list_resp["id"], 1);
                    assert_eq!(list_resp["result"]["tools"][0]["name"], "mock_echo");

                    // Each client calls `tools/call` concurrently with the SAME original id `42`
                    // (and string id variant) to verify zero ID collisions on multiplexed responses.
                    let tag = format!("payload-from-{idx}");
                    let call_resp = hub_ref
                        .forward_jsonrpc_blocking(
                            "mock",
                            &client_id,
                            &json!({
                                "jsonrpc": "2.0",
                                "id": 42,
                                "method": "tools/call",
                                "params": {
                                    "name": "mock_echo",
                                    "arguments": { "tag": tag }
                                }
                            }),
                            Duration::from_secs(5),
                        )
                        .expect("tools/call ok")
                        .expect("tools/call response");
                    assert_eq!(call_resp["id"], 42);
                    assert_eq!(
                        call_resp["result"]["content"][0]["text"],
                        format!("echo:payload-from-{idx}")
                    );
                })
            })
            .collect();

        for handle in handles {
            handle.join().expect("client thread should not panic");
        }

        assert_eq!(metrics.spawn_count.load(Ordering::SeqCst), 1);
        assert_eq!(metrics.initialize_count.load(Ordering::SeqCst), 1);
        assert_eq!(metrics.tools_list_count.load(Ordering::SeqCst), 1);
        assert_eq!(metrics.tool_call_count.load(Ordering::SeqCst), 5);
        assert_eq!(hub.active_upstream_count(), 1);
    }

    #[test]
    fn reaps_idle_upstream_servers_and_lazily_respawns_on_next_request() {
        let metrics = Arc::new(MockUpstreamMetrics::default());
        let hub = SharedStdioMcpHub::with_spawner(make_mock_spawner(Arc::clone(&metrics), 0));
        hub.register_server("engram", "engram-bin", &["mcp".to_string()], &[]);

        let resp = hub
            .forward_jsonrpc_blocking(
                "engram",
                "c1",
                &json!({ "jsonrpc": "2.0", "id": "req-a", "method": "tools/list" }),
                Duration::from_secs(5),
            )
            .unwrap()
            .unwrap();
        assert_eq!(resp["id"], "req-a");
        assert_eq!(hub.active_upstream_count(), 1);
        assert_eq!(metrics.spawn_count.load(Ordering::SeqCst), 1);

        // Long idle timeout does NOT reap recently active server
        assert_eq!(hub.reap_idle(DEFAULT_MCP_IDLE_TIMEOUT), 0);
        assert_eq!(hub.active_upstream_count(), 1);

        // Expired idle timeout reaps the upstream child while preserving the registration
        std::thread::sleep(Duration::from_millis(25));
        assert_eq!(hub.reap_idle(Duration::from_millis(10)), 1);
        assert_eq!(hub.active_upstream_count(), 0);
        assert_eq!(metrics.shutdown_count.load(Ordering::SeqCst), 1);
        assert!(hub.has_registered_server("engram"));

        // Subsequent request lazily spawns a fresh upstream and refreshes tools/list cache
        let resp2 = hub
            .forward_jsonrpc_blocking(
                "engram",
                "c2",
                &json!({ "jsonrpc": "2.0", "id": "req-b", "method": "tools/list" }),
                Duration::from_secs(5),
            )
            .unwrap()
            .unwrap();
        assert_eq!(resp2["id"], "req-b");
        assert_eq!(metrics.spawn_count.load(Ordering::SeqCst), 2);
        assert_eq!(metrics.tools_list_count.load(Ordering::SeqCst), 2);
        assert_eq!(hub.active_upstream_count(), 1);
    }

    #[test]
    fn compresses_large_upstream_tool_responses_via_kite_ctx() {
        let metrics = Arc::new(MockUpstreamMetrics::default());
        let hub = SharedStdioMcpHub::with_spawner_and_compress_threshold(
            make_mock_spawner(Arc::clone(&metrics), 0),
            256,
        );
        hub.register_server("context7", "context7-bin", &[], &[]);

        let resp = hub
            .forward_jsonrpc_blocking(
                "context7",
                "sess-ctx-1",
                &json!({
                    "jsonrpc": "2.0",
                    "id": 99,
                    "method": "tools/call",
                    "params": {
                        "name": "mock_echo",
                        "arguments": { "big_rows": 45 }
                    }
                }),
                Duration::from_secs(5),
            )
            .unwrap()
            .unwrap();
        assert_eq!(resp["id"], 99);
        let text = resp["result"]["content"][0]["text"].as_str().unwrap_or("");
        assert!(
            text.contains("<<ccr:") || text.contains("compressed by kite-ctx") || text.len() < 3000,
            "expected large response to be compressed by kite-ctx, len={}, text={text}",
            text.len()
        );
    }

    #[test]
    fn env_fingerprint_is_order_independent_and_distinct_per_env() {
        let a = compute_env_fingerprint(&[
            ("FOO".to_string(), "1".to_string()),
            ("BAR".to_string(), "2".to_string()),
        ]);
        let b = compute_env_fingerprint(&[
            ("BAR".to_string(), "2".to_string()),
            ("FOO".to_string(), "1".to_string()),
        ]);
        let c = compute_env_fingerprint(&[
            ("FOO".to_string(), "1".to_string()),
            ("BAR".to_string(), "3".to_string()),
        ]);
        assert_eq!(a, b);
        assert_ne!(a, c);
    }

    #[test]
    fn pending_registry_maintains_bidirectional_client_req_and_upstream_id_mapping() {
        let metrics = Arc::new(MockUpstreamMetrics::default());
        let live = LiveUpstream::start(
            &PooledServerSpec {
                name: "map-test".to_string(),
                command: "mock".to_string(),
                args: vec![],
                env: vec![],
                env_fingerprint: "fp".to_string(),
            },
            (make_mock_spawner(metrics, 0))(&PooledServerSpec {
                name: "map-test".to_string(),
                command: "mock".to_string(),
                args: vec![],
                env: vec![],
                env_fingerprint: "fp".to_string(),
            })
            .unwrap(),
            None,
            1024,
        );
        let (tx1, _rx1) = std::sync::mpsc::sync_channel(1);
        let (tx2, _rx2) = std::sync::mpsc::sync_channel(1);
        {
            let mut reg = live.pending.lock().unwrap();
            reg.insert(
                100,
                PendingRoute {
                    client_id: "c1".to_string(),
                    original_id: json!(1),
                    client_req_key: canonical_req_id_key(&json!(1)),
                },
                ReplyWaiter::Sync(tx1),
            );
            reg.insert(
                101,
                PendingRoute {
                    client_id: "c2".to_string(),
                    original_id: json!(1),
                    client_req_key: canonical_req_id_key(&json!(1)),
                },
                ReplyWaiter::Sync(tx2),
            );
        }
        assert_eq!(live.lookup_upstream_id("c1", &json!(1)), Some(100));
        assert_eq!(live.lookup_upstream_id("c2", &json!(1)), Some(101));
        live.remove_pending_entry(100);
        assert_eq!(live.lookup_upstream_id("c1", &json!(1)), None);
        assert_eq!(live.lookup_upstream_id("c2", &json!(1)), Some(101));
        live.shutdown();
    }

    #[test]
    fn unregistered_server_returns_not_registered_error() {
        let hub = SharedStdioMcpHub::with_spawner(make_mock_spawner(
            Arc::new(MockUpstreamMetrics::default()),
            0,
        ));
        let err = hub
            .forward_jsonrpc_blocking(
                "missing-server",
                "c1",
                &json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }),
                Duration::from_secs(1),
            )
            .unwrap_err();
        assert_eq!(
            err,
            McpHubError::ServerNotRegistered("missing-server".to_string())
        );
    }

    #[test]
    fn unregister_server_shuts_down_active_upstream_cleanly() {
        let metrics = Arc::new(MockUpstreamMetrics::default());
        let hub = SharedStdioMcpHub::with_spawner(make_mock_spawner(Arc::clone(&metrics), 0));
        assert!(!hub.unregister_server("missing-plugin-srv"));

        hub.register_server("plugin_ext_srv", "mock-bin", &["mcp".to_string()], &[]);
        assert!(hub.has_registered_server("plugin_ext_srv"));
        assert_eq!(hub.registered_server_count(), 1);

        let resp = hub
            .forward_jsonrpc_blocking(
                "plugin_ext_srv",
                "c1",
                &json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }),
                Duration::from_secs(5),
            )
            .unwrap()
            .unwrap();
        assert_eq!(resp["id"], 1);
        assert_eq!(hub.active_upstream_count(), 1);
        assert_eq!(metrics.spawn_count.load(Ordering::SeqCst), 1);

        assert!(hub.unregister_server("plugin_ext_srv"));
        assert!(!hub.has_registered_server("plugin_ext_srv"));
        assert_eq!(hub.registered_server_count(), 0);
        assert_eq!(hub.active_upstream_count(), 0);
        assert_eq!(metrics.shutdown_count.load(Ordering::SeqCst), 1);
        assert!(!hub.unregister_server("plugin_ext_srv"));

        let err = hub
            .forward_jsonrpc_blocking(
                "plugin_ext_srv",
                "c1",
                &json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
                Duration::from_secs(1),
            )
            .unwrap_err();
        assert_eq!(
            err,
            McpHubError::ServerNotRegistered("plugin_ext_srv".to_string())
        );
    }

    #[test]
    fn global_hub_exports_smoke_check() {
        let _hub = global_stdio_mcp_hub();
        register_pooled_server("smoke-unspawned", "nonexistent-binary-xyz", &[], &[]);
        assert!(global_stdio_mcp_hub().has_registered_server("smoke-unspawned"));
        assert!(unregister_pooled_server("smoke-unspawned"));
        assert!(!global_stdio_mcp_hub().has_registered_server("smoke-unspawned"));
        let _ = reap_idle_upstream_servers(DEFAULT_MCP_IDLE_TIMEOUT);
        let _ = pooled_server_count();
    }

    #[test]
    fn stateful_proxy_deduplicates_identical_browser_screenshots_by_sha256() {
        let img_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=".repeat(8);
        let img_b64_srv = img_b64.clone();
        let spawner: UpstreamSpawner = Arc::new(move |_spec: &PooledServerSpec| {
            let (in_tx, in_rx) = std::sync::mpsc::channel::<Vec<u8>>();
            let (out_tx, out_rx) = std::sync::mpsc::channel::<Vec<u8>>();
            let img = img_b64_srv.clone();
            std::thread::spawn(move || {
                struct ChanReader {
                    rx: std::sync::mpsc::Receiver<Vec<u8>>,
                    cur: std::io::Cursor<Vec<u8>>,
                }
                impl Read for ChanReader {
                    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
                        loop {
                            let n = self.cur.read(out)?;
                            if n > 0 {
                                return Ok(n);
                            }
                            match self.rx.recv() {
                                Ok(bytes) => self.cur = std::io::Cursor::new(bytes),
                                Err(_) => return Ok(0),
                            }
                        }
                    }
                }
                let mut reader = BufReader::new(ChanReader {
                    rx: in_rx,
                    cur: std::io::Cursor::new(Vec::new()),
                });
                let mut line = String::new();
                while let Ok(n) = reader.read_line(&mut line) {
                    if n == 0 {
                        break;
                    }
                    if let Ok(req) = serde_json::from_str::<Value>(line.trim()) {
                        let id = req.get("id").cloned().unwrap_or(Value::Null);
                        let resp = json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": {
                                "content": [
                                    { "type": "image", "data": img, "mimeType": "image/png" }
                                ]
                            }
                        });
                        let mut bytes = serde_json::to_vec(&resp).unwrap();
                        bytes.push(b'\n');
                        let _ = out_tx.send(bytes);
                    }
                    line.clear();
                }
            });
            struct ChanWriter(std::sync::mpsc::Sender<Vec<u8>>);
            impl Write for ChanWriter {
                fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                    self.0.send(buf.to_vec()).map_err(|_| {
                        std::io::Error::new(std::io::ErrorKind::BrokenPipe, "closed")
                    })?;
                    Ok(buf.len())
                }
                fn flush(&mut self) -> std::io::Result<()> {
                    Ok(())
                }
            }
            struct OutReader {
                rx: std::sync::mpsc::Receiver<Vec<u8>>,
                cur: std::io::Cursor<Vec<u8>>,
            }
            impl Read for OutReader {
                fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
                    loop {
                        let n = self.cur.read(out)?;
                        if n > 0 {
                            return Ok(n);
                        }
                        match self.rx.recv() {
                            Ok(bytes) => self.cur = std::io::Cursor::new(bytes),
                            Err(_) => return Ok(0),
                        }
                    }
                }
            }
            Ok(UpstreamTransport {
                writer: Box::new(ChanWriter(in_tx)),
                reader: Box::new(BufReader::new(OutReader {
                    rx: out_rx,
                    cur: std::io::Cursor::new(Vec::new()),
                })),
                terminator: Box::new(|| {}),
                alive_probe: None,
            })
        });

        let hub = SharedStdioMcpHub::with_spawner_and_compress_threshold(spawner, 128);
        hub.register_server("ext_browser_mcp", "mock-browser", &[], &[]);

        let req1 = json!({
            "jsonrpc": "2.0",
            "id": 10,
            "method": "tools/call",
            "params": {
                "name": "browser_screenshot",
                "arguments": { "tab_id": "tab-img-1" }
            }
        });
        let resp1 = hub
            .forward_jsonrpc_blocking("ext_browser_mcp", "sess-img", &req1, Duration::from_secs(5))
            .unwrap()
            .unwrap();
        assert_eq!(resp1["result"]["content"][0]["type"], "image");

        let req2 = json!({
            "jsonrpc": "2.0",
            "id": 11,
            "method": "tools/call",
            "params": {
                "name": "browser_screenshot",
                "arguments": { "tab_id": "tab-img-1" }
            }
        });
        let resp2 = hub
            .forward_jsonrpc_blocking("ext_browser_mcp", "sess-img", &req2, Duration::from_secs(5))
            .unwrap()
            .unwrap();
        assert_eq!(resp2["result"]["content"][0]["type"], "text");
        let stub = resp2["result"]["content"][0]["text"].as_str().unwrap_or("");
        assert!(
            stub.contains("Screenshot unchanged") && stub.contains("tab:tab-img-1"),
            "second identical screenshot must deduplicate via SHA-256: {stub}"
        );
    }
}
