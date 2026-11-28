//! Shared `opencode serve` daemon pool with refcounted thread/session leases.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

use crate::hidden_exec::HiddenChild;

use super::opencode::apply_opencode_password_env_aliases;

/// Environment flag controlling whether `OpenCodeServerSession` shares
/// pooled `opencode serve` instances. Defaults to enabled unless set to `"0"`.
pub const OPENCODE_POOL_ENV: &str = "KITE_OPENCODE_POOL";

/// Canonical pool lookup key: `(connection_id_or_default, env_fingerprint)`.
pub type OpenCodePoolKey = (String, String);

/// Per-thread/per-turn environment variables that must not prevent concurrent
/// OpenCode threads or subagents from sharing a compatible `opencode serve`.
const EPHEMERAL_THREAD_ENV_KEYS: [&str; 8] = [
    "KITE_ADDRESS",
    "KITE_THREAD_ID",
    "KITE_SESSION_ID",
    "KITE_MODEL",
    "KITE_AGENT_NAME",
    "KITE_CONNECTION_ID",
    "KITE_THREAD_MODE",
    "KITE_MULTIPLEXED_DAEMON",
];

/// Scrubs per-thread identity variables before spawning a pooled `opencode serve`
/// process while keeping Thread Mode and multiplexed daemon markers intact.
pub fn shared_opencode_server_env(extra_env: &[(String, String)]) -> Vec<(String, String)> {
    let mut is_thread_mode = false;
    let mut out: Vec<(String, String)> = Vec::with_capacity(extra_env.len() + 2);
    for (key, value) in extra_env {
        let trimmed = key.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.eq_ignore_ascii_case("KITE_ADDRESS") {
            if value.trim().starts_with("thread:") {
                is_thread_mode = true;
            }
            continue;
        }
        if trimmed.eq_ignore_ascii_case("KITE_THREAD_ID")
            || trimmed.eq_ignore_ascii_case("KITE_SESSION_ID")
            || trimmed.eq_ignore_ascii_case("KITE_MODEL")
            || trimmed.eq_ignore_ascii_case("KITE_AGENT_NAME")
        {
            continue;
        }
        if (trimmed.eq_ignore_ascii_case("KITE_THREAD_MODE")
            || trimmed.eq_ignore_ascii_case("KITE_DISPATCH"))
            && value.trim() == "1"
        {
            is_thread_mode = true;
        }
        if trimmed.eq_ignore_ascii_case("KITE_THREAD_MODE")
            || trimmed.eq_ignore_ascii_case("KITE_MULTIPLEXED_DAEMON")
        {
            continue;
        }
        out.push((key.clone(), value.clone()));
    }
    if is_thread_mode {
        out.push(("KITE_THREAD_MODE".to_string(), "1".to_string()));
    }
    out.push(("KITE_MULTIPLEXED_DAEMON".to_string(), "1".to_string()));
    out
}

/// Returns `true` unless `raw` is explicitly `"0"`.
pub fn opencode_pool_enabled_from(raw: Option<&str>) -> bool {
    raw.map(str::trim) != Some("0")
}

/// Returns whether the shared OpenCode server pool is enabled in this process.
pub fn opencode_pool_enabled() -> bool {
    opencode_pool_enabled_from(std::env::var(OPENCODE_POOL_ENV).ok().as_deref())
}

/// Resolves the connection component of the pool key, falling back to `"default"`.
pub fn opencode_connection_key(
    connection_id: Option<&str>,
    extra_env: &[(String, String)],
) -> String {
    if let Some(id) = connection_id.map(str::trim).filter(|id| !id.is_empty()) {
        return id.to_string();
    }
    if let Some(id) = extra_env.iter().rev().find_map(|(k, v)| {
        (k.eq_ignore_ascii_case("KITE_CONNECTION_ID") && !v.trim().is_empty())
            .then(|| v.trim().to_string())
    }) {
        return id;
    }
    "default".to_string()
}

/// Computes a deterministic SHA-256 fingerprint over environment variables that
/// govern server behavior, normalizing OpenCode password aliases and ignoring
/// per-thread identity/tracking variables.
pub fn opencode_env_fingerprint(extra_env: &[(String, String)]) -> String {
    let mut normalized = extra_env.to_vec();
    apply_opencode_password_env_aliases(&mut normalized, |_| None);

    let mut canonical: BTreeMap<String, String> = BTreeMap::new();
    for (key, value) in normalized {
        let upper = key.trim().to_ascii_uppercase();
        if upper.is_empty()
            || EPHEMERAL_THREAD_ENV_KEYS
                .iter()
                .any(|ignored| upper == *ignored)
        {
            continue;
        }
        canonical.insert(upper, value);
    }

    let mut hasher = Sha256::new();
    for (key, value) in canonical {
        hasher.update(key.as_bytes());
        hasher.update(b"=");
        hasher.update(value.as_bytes());
        hasher.update(b"\0");
    }
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Builds the `(connection_id_or_default, env_fingerprint)` pool key.
pub fn opencode_pool_key(
    connection_id: Option<&str>,
    extra_env: &[(String, String)],
) -> OpenCodePoolKey {
    (
        opencode_connection_key(connection_id, extra_env),
        opencode_env_fingerprint(extra_env),
    )
}

/// Artifacts produced by spawning a fresh `opencode serve` daemon (or a test
/// hook representing one).
pub struct SpawnedOpenCodeServer {
    pub port: u16,
    pub program: PathBuf,
    pub server: Option<HiddenChild>,
    pub server_streams: Option<JoinHandle<()>>,
    pub server_eof: Arc<AtomicBool>,
    pub server_tail: Arc<Mutex<String>>,
}

impl fmt::Debug for SpawnedOpenCodeServer {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SpawnedOpenCodeServer")
            .field("port", &self.port)
            .field("program", &self.program)
            .field("has_server", &self.server.is_some())
            .finish()
    }
}

#[derive(Clone)]
enum PoolTarget {
    Global,
    Shared(Arc<Mutex<SharedOpenCodeServerPool>>),
    Detached,
}

/// Active lease tying one thread/session to a pooled `opencode serve` entry.
/// Dropping or releasing the lease decrements its refcount without stopping the
/// shared server while sibling leases remain active.
pub struct PooledOpenCodeLease {
    key: OpenCodePoolKey,
    lease_id: String,
    server_id: u64,
    port: u16,
    program: PathBuf,
    server_eof: Arc<AtomicBool>,
    server_tail: Arc<Mutex<String>>,
    spawn_count: u32,
    released: AtomicBool,
    target: PoolTarget,
}

impl fmt::Debug for PooledOpenCodeLease {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PooledOpenCodeLease")
            .field("key", &self.key)
            .field("lease_id", &self.lease_id)
            .field("server_id", &self.server_id)
            .field("port", &self.port)
            .field("released", &self.released.load(Ordering::SeqCst))
            .finish()
    }
}

impl PooledOpenCodeLease {
    pub fn key(&self) -> &OpenCodePoolKey {
        &self.key
    }

    pub fn lease_id(&self) -> &str {
        &self.lease_id
    }

    pub fn server_id(&self) -> u64 {
        self.server_id
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn program(&self) -> &Path {
        &self.program
    }

    pub fn server_eof(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.server_eof)
    }

    pub fn server_tail(&self) -> Arc<Mutex<String>> {
        Arc::clone(&self.server_tail)
    }

    pub fn server_spawn_count(&self) -> u32 {
        self.spawn_count
    }

    /// Refreshes the pooled server's `last_active_at` timestamp.
    pub fn touch(&self) {
        if self.released.load(Ordering::SeqCst) {
            return;
        }
        match &self.target {
            PoolTarget::Global => {
                let mut pool = global_opencode_pool()
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                pool.touch_lease(self);
            }
            PoolTarget::Shared(arc) => {
                let mut pool = arc
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                pool.touch_lease(self);
            }
            PoolTarget::Detached => {}
        }
    }

    /// Collects the server's exit status once if it died unexpectedly.
    pub fn wait_dead_exit_code(&self) -> Option<i32> {
        match &self.target {
            PoolTarget::Global => {
                let mut pool = global_opencode_pool()
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                pool.record_dead_server_exit(self)
            }
            PoolTarget::Shared(arc) => {
                let mut pool = arc
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                pool.record_dead_server_exit(self)
            }
            PoolTarget::Detached => None,
        }
    }

    /// Releases this lease back to its pool immediately.
    pub fn release(self) {
        self.release_inner();
    }

    fn release_inner(&self) {
        if self.released.swap(true, Ordering::SeqCst) {
            return;
        }
        match &self.target {
            PoolTarget::Global => {
                let mut pool = global_opencode_pool()
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                pool.release_lease_by_ids(&self.key, self.server_id, &self.lease_id);
            }
            PoolTarget::Shared(arc) => {
                let mut pool = arc
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                pool.release_lease_by_ids(&self.key, self.server_id, &self.lease_id);
            }
            PoolTarget::Detached => {}
        }
    }
}

impl Drop for PooledOpenCodeLease {
    fn drop(&mut self) {
        self.release_inner();
    }
}

struct PooledOpenCodeServer {
    server_id: u64,
    port: u16,
    program: PathBuf,
    server: Option<HiddenChild>,
    server_streams: Option<JoinHandle<()>>,
    server_eof: Arc<AtomicBool>,
    server_tail: Arc<Mutex<String>>,
    exit_code: Option<i32>,
    leases: HashMap<String, usize>,
    last_active_at: Instant,
    spawn_count: u32,
}

impl PooledOpenCodeServer {
    fn is_dead(&self) -> bool {
        self.server_eof.load(Ordering::SeqCst)
    }

    fn lease_count(&self) -> usize {
        self.leases.values().sum()
    }

    fn add_lease(&mut self, lease_id: &str) {
        *self.leases.entry(lease_id.to_string()).or_insert(0) += 1;
        self.last_active_at = Instant::now();
    }

    fn remove_lease(&mut self, lease_id: &str) -> bool {
        let Some(count) = self.leases.get_mut(lease_id) else {
            return false;
        };
        if *count > 1 {
            *count -= 1;
        } else {
            self.leases.remove(lease_id);
        }
        self.last_active_at = Instant::now();
        true
    }

    fn terminate(&mut self) {
        self.server_eof.store(true, Ordering::SeqCst);
        if let Some(mut child) = self.server.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Some(reader) = self.server_streams.take() {
            let _ = reader.join();
        }
    }
}

impl Drop for PooledOpenCodeServer {
    fn drop(&mut self) {
        self.terminate();
    }
}

/// Process-wide pool sharing `opencode serve` instances across concurrent threads
/// and subagents with matching `(connection_id_or_default, env_fingerprint)`.
pub struct SharedOpenCodeServerPool {
    entries: HashMap<OpenCodePoolKey, PooledOpenCodeServer>,
    starting_keys: HashSet<OpenCodePoolKey>,
    next_server_id: u64,
    total_spawns: u32,
    epoch: u64,
}

impl Default for SharedOpenCodeServerPool {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Debug for SharedOpenCodeServerPool {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let (servers, leases) = self.stats();
        formatter
            .debug_struct("SharedOpenCodeServerPool")
            .field("active_servers", &servers)
            .field("active_leases", &leases)
            .field("total_spawns", &self.total_spawns)
            .finish()
    }
}

impl SharedOpenCodeServerPool {
    pub fn new() -> Self {
        Self {
            entries: HashMap::new(),
            starting_keys: HashSet::new(),
            next_server_id: 1,
            total_spawns: 0,
            epoch: 0,
        }
    }

    /// Acquires a lease on an existing healthy server for `key`, or runs
    /// `spawner` synchronously to start and register a new pooled server.
    pub fn acquire_with<F>(
        &mut self,
        key: OpenCodePoolKey,
        lease_id: impl Into<String>,
        spawner: F,
    ) -> Result<PooledOpenCodeLease, String>
    where
        F: FnOnce() -> Result<SpawnedOpenCodeServer, String>,
    {
        let lease_id = lease_id.into();
        if let Some(lease) = self.try_acquire_existing(&key, &lease_id, PoolTarget::Detached) {
            return Ok(lease);
        }
        let spawned = spawner()?;
        Ok(self.insert_spawned(key, lease_id, spawned, PoolTarget::Detached))
    }

    /// Releases a lease obtained from this pool, preserving the underlying
    /// server while sibling leases stay active.
    pub fn release_lease(&mut self, lease: &PooledOpenCodeLease) -> bool {
        if lease.released.swap(true, Ordering::SeqCst) {
            return false;
        }
        self.release_lease_by_ids(&lease.key, lease.server_id, &lease.lease_id)
    }

    /// Refreshes `last_active_at` for the server associated with `lease`.
    pub fn touch_lease(&mut self, lease: &PooledOpenCodeLease) {
        if let Some(entry) = self.entries.get_mut(&lease.key) {
            if entry.server_id == lease.server_id {
                entry.last_active_at = Instant::now();
            }
        }
    }

    /// Kills and removes servers with zero active leases whose idle duration
    /// has reached or exceeded `idle_timeout`.
    pub fn reap_idle(&mut self, idle_timeout: Duration) -> usize {
        self.reap_idle_at(idle_timeout, Instant::now())
    }

    /// Deterministic clock variant of [`Self::reap_idle`].
    pub fn reap_idle_at(&mut self, idle_timeout: Duration, now: Instant) -> usize {
        let mut removed = self.take_idle_entries(idle_timeout, now);
        let count = removed.len();
        for mut entry in removed.drain(..) {
            entry.terminate();
        }
        count
    }

    /// Terminates and removes every server in the pool regardless of leases.
    pub fn shutdown_all(&mut self) -> usize {
        let mut drained = self.take_all_entries();
        let count = drained.len();
        for mut entry in drained.drain(..) {
            entry.terminate();
        }
        count
    }

    /// Returns `(active_server_count, active_lease_count)`.
    pub fn stats(&self) -> (usize, usize) {
        let servers = self.entries.len();
        let leases = self.entries.values().map(PooledOpenCodeServer::lease_count).sum();
        (servers, leases)
    }

    /// Total number of `opencode serve` spawns performed across this pool.
    pub fn total_spawns(&self) -> u32 {
        self.total_spawns
    }

    /// Spawn count recorded on the current active entry for `key`, if any.
    pub fn server_spawn_count(&self, key: &OpenCodePoolKey) -> u32 {
        self.entries.get(key).map(|entry| entry.spawn_count).unwrap_or(0)
    }

    /// Active lease count on the entry for `key`.
    pub fn active_leases_for(&self, key: &OpenCodePoolKey) -> usize {
        self.entries
            .get(key)
            .map(PooledOpenCodeServer::lease_count)
            .unwrap_or(0)
    }

    /// Port bound by the active server for `key`, if present.
    pub fn port_for(&self, key: &OpenCodePoolKey) -> Option<u16> {
        self.entries.get(key).map(|entry| entry.port)
    }

    fn try_acquire_existing(
        &mut self,
        key: &OpenCodePoolKey,
        lease_id: &str,
        target: PoolTarget,
    ) -> Option<PooledOpenCodeLease> {
        if let Some(entry) = self.entries.get(key) {
            if entry.is_dead() {
                if let Some(mut dead) = self.entries.remove(key) {
                    dead.terminate();
                }
                return None;
            }
        }
        let entry = self.entries.get_mut(key)?;
        entry.add_lease(lease_id);
        Some(PooledOpenCodeLease {
            key: key.clone(),
            lease_id: lease_id.to_string(),
            server_id: entry.server_id,
            port: entry.port,
            program: entry.program.clone(),
            server_eof: Arc::clone(&entry.server_eof),
            server_tail: Arc::clone(&entry.server_tail),
            spawn_count: entry.spawn_count,
            released: AtomicBool::new(false),
            target,
        })
    }

    fn insert_spawned(
        &mut self,
        key: OpenCodePoolKey,
        lease_id: String,
        spawned: SpawnedOpenCodeServer,
        target: PoolTarget,
    ) -> PooledOpenCodeLease {
        let server_id = self.next_server_id;
        self.next_server_id = self.next_server_id.saturating_add(1);
        self.total_spawns = self.total_spawns.saturating_add(1);

        let mut leases = HashMap::new();
        leases.insert(lease_id.clone(), 1);

        let entry = PooledOpenCodeServer {
            server_id,
            port: spawned.port,
            program: spawned.program.clone(),
            server: spawned.server,
            server_streams: spawned.server_streams,
            server_eof: Arc::clone(&spawned.server_eof),
            server_tail: Arc::clone(&spawned.server_tail),
            exit_code: None,
            leases,
            last_active_at: Instant::now(),
            spawn_count: 1,
        };
        self.entries.insert(key.clone(), entry);

        PooledOpenCodeLease {
            key,
            lease_id,
            server_id,
            port: spawned.port,
            program: spawned.program,
            server_eof: spawned.server_eof,
            server_tail: spawned.server_tail,
            spawn_count: 1,
            released: AtomicBool::new(false),
            target,
        }
    }

    fn release_lease_by_ids(
        &mut self,
        key: &OpenCodePoolKey,
        server_id: u64,
        lease_id: &str,
    ) -> bool {
        let Some(entry) = self.entries.get_mut(key) else {
            return false;
        };
        if entry.server_id != server_id {
            return false;
        }
        let removed = entry.remove_lease(lease_id);
        if removed && entry.leases.is_empty() && entry.is_dead() {
            if let Some(mut dead) = self.entries.remove(key) {
                dead.terminate();
            }
        }
        removed
    }

    fn record_dead_server_exit(&mut self, lease: &PooledOpenCodeLease) -> Option<i32> {
        let entry = self.entries.get_mut(&lease.key)?;
        if entry.server_id != lease.server_id {
            return None;
        }
        if entry.exit_code.is_none() {
            if let Some(mut child) = entry.server.take() {
                entry.exit_code = child.wait().ok();
            }
            if let Some(reader) = entry.server_streams.take() {
                let _ = reader.join();
            }
        }
        entry.exit_code
    }

    fn take_idle_entries(
        &mut self,
        idle_timeout: Duration,
        now: Instant,
    ) -> Vec<PooledOpenCodeServer> {
        let expired_keys: Vec<OpenCodePoolKey> = self
            .entries
            .iter()
            .filter(|(_, entry)| {
                entry.leases.is_empty()
                    && now.saturating_duration_since(entry.last_active_at) >= idle_timeout
            })
            .map(|(key, _)| key.clone())
            .collect();

        let mut removed = Vec::with_capacity(expired_keys.len());
        for key in expired_keys {
            if let Some(entry) = self.entries.remove(&key) {
                removed.push(entry);
            }
        }
        removed
    }

    fn take_all_entries(&mut self) -> Vec<PooledOpenCodeServer> {
        self.epoch = self.epoch.saturating_add(1);
        self.entries.drain().map(|(_, entry)| entry).collect()
    }
}

/// Returns the global shared OpenCode server pool singleton.
pub fn global_opencode_pool() -> &'static Mutex<SharedOpenCodeServerPool> {
    static POOL: OnceLock<Mutex<SharedOpenCodeServerPool>> = OnceLock::new();
    POOL.get_or_init(|| Mutex::new(SharedOpenCodeServerPool::new()))
}

fn global_pool_cv() -> &'static Condvar {
    static CV: OnceLock<Condvar> = OnceLock::new();
    CV.get_or_init(Condvar::new)
}

struct StartingKeyGuard<'a> {
    pool: &'a Mutex<SharedOpenCodeServerPool>,
    cv: &'a Condvar,
    key: OpenCodePoolKey,
    active: bool,
}

impl Drop for StartingKeyGuard<'_> {
    fn drop(&mut self) {
        if self.active {
            let mut guard = self
                .pool
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            guard.starting_keys.remove(&self.key);
            self.cv.notify_all();
        }
    }
}

pub(crate) fn acquire_shared_opencode_lease<F>(
    pool_arc: &Arc<Mutex<SharedOpenCodeServerPool>>,
    cv: &Condvar,
    key: OpenCodePoolKey,
    lease_id: impl Into<String>,
    spawner: F,
) -> Result<PooledOpenCodeLease, String>
where
    F: FnOnce() -> Result<SpawnedOpenCodeServer, String>,
{
    let target_arc = Arc::clone(pool_arc);
    acquire_coalesced_from(
        pool_arc.as_ref(),
        cv,
        move || PoolTarget::Shared(Arc::clone(&target_arc)),
        key,
        lease_id.into(),
        spawner,
    )
}

/// Acquires a lease from `global_opencode_pool()`, coalescing concurrent
/// startups for the same key without holding the pool mutex across slow
/// server handshakes.
pub fn acquire_global_opencode_lease<F>(
    key: OpenCodePoolKey,
    lease_id: impl Into<String>,
    spawner: F,
) -> Result<PooledOpenCodeLease, String>
where
    F: FnOnce() -> Result<SpawnedOpenCodeServer, String>,
{
    acquire_coalesced_from(
        global_opencode_pool(),
        global_pool_cv(),
        || PoolTarget::Global,
        key,
        lease_id.into(),
        spawner,
    )
}

fn acquire_coalesced_from<F>(
    pool: &Mutex<SharedOpenCodeServerPool>,
    cv: &Condvar,
    target_for_lease: impl Fn() -> PoolTarget,
    key: OpenCodePoolKey,
    lease_id: String,
    spawner: F,
) -> Result<PooledOpenCodeLease, String>
where
    F: FnOnce() -> Result<SpawnedOpenCodeServer, String>,
{
    let captured_epoch = {
        let mut guard = pool
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        loop {
            if let Some(lease) = guard.try_acquire_existing(&key, &lease_id, target_for_lease()) {
                return Ok(lease);
            }
            if guard.starting_keys.contains(&key) {
                guard = cv
                    .wait(guard)
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                continue;
            }
            guard.starting_keys.insert(key.clone());
            break guard.epoch;
        }
    };

    let mut starting_guard = StartingKeyGuard {
        pool,
        cv,
        key: key.clone(),
        active: true,
    };

    let mut spawned = spawner()?;

    let mut guard = pool
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    guard.starting_keys.remove(&key);
    starting_guard.active = false;

    if guard.epoch != captured_epoch {
        drop(guard);
        spawned.server_eof.store(true, Ordering::SeqCst);
        if let Some(mut child) = spawned.server.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Some(reader) = spawned.server_streams.take() {
            let _ = reader.join();
        }
        cv.notify_all();
        return Err("opencode server pool shut down during startup".to_string());
    }

    let lease = guard.insert_spawned(key, lease_id, spawned, target_for_lease());
    cv.notify_all();
    Ok(lease)
}

/// Reaps pooled OpenCode servers whose active lease list is empty and whose
/// idle duration is at least `idle_timeout`.
pub fn reap_idle_opencode_servers(idle_timeout: Duration) -> usize {
    let mut removed = {
        let mut pool = global_opencode_pool()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        pool.take_idle_entries(idle_timeout, Instant::now())
    };
    let count = removed.len();
    for mut entry in removed.drain(..) {
        entry.terminate();
    }
    count
}

/// Shuts down all pooled OpenCode servers immediately.
pub fn shutdown_all_opencode_servers() -> usize {
    let mut removed = {
        let mut pool = global_opencode_pool()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        pool.take_all_entries()
    };
    let count = removed.len();
    for mut entry in removed.drain(..) {
        entry.terminate();
    }
    count
}

/// Returns `(active_server_count, active_lease_count)` for `global_opencode_pool()`.
pub fn opencode_pool_stats() -> (usize, usize) {
    let pool = global_opencode_pool()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    pool.stats()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU16;

    static NEXT_FAKE_PORT: AtomicU16 = AtomicU16::new(41_000);
    static GLOBAL_POOL_TEST_LOCK: Mutex<()> = Mutex::new(());

    fn fake_server() -> (SpawnedOpenCodeServer, Arc<AtomicBool>) {
        let port = NEXT_FAKE_PORT.fetch_add(1, Ordering::SeqCst);
        let eof = Arc::new(AtomicBool::new(false));
        let spawned = SpawnedOpenCodeServer {
            port,
            program: PathBuf::from("kite-fake-opencode"),
            server: None,
            server_streams: None,
            server_eof: Arc::clone(&eof),
            server_tail: Arc::new(Mutex::new(String::new())),
        };
        (spawned, eof)
    }

    #[test]
    fn three_concurrent_sessions_with_same_key_share_one_server_and_one_port() {
        let pool = Arc::new(Mutex::new(SharedOpenCodeServerPool::new()));
        let cv = Arc::new(Condvar::new());
        let key = opencode_pool_key(
            Some("conn-primary"),
            &[("OPENCODE_API_KEY".to_string(), "sk-test".to_string())],
        );

        let barrier = Arc::new(std::sync::Barrier::new(3));
        let handles: Vec<_> = (1..=3)
            .map(|idx| {
                let pool = Arc::clone(&pool);
                let cv = Arc::clone(&cv);
                let key = key.clone();
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    acquire_shared_opencode_lease(
                        &pool,
                        &cv,
                        key,
                        format!("thread-{idx}:1"),
                        || {
                            // Slow startup simulates handshake latency so siblings coalesce cleanly.
                            std::thread::sleep(Duration::from_millis(20));
                            Ok(fake_server().0)
                        },
                    )
                    .expect("lease should succeed")
                })
            })
            .collect();

        let leases: Vec<PooledOpenCodeLease> =
            handles.into_iter().map(|h| h.join().unwrap()).collect();

        assert_eq!(leases[0].port(), leases[1].port());
        assert_eq!(leases[1].port(), leases[2].port());
        assert_eq!(leases[0].server_id(), leases[1].server_id());
        assert_eq!(leases[1].server_id(), leases[2].server_id());

        let guard = pool.lock().unwrap();
        assert_eq!(guard.total_spawns(), 1);
        assert_eq!(guard.server_spawn_count(&key), 1);
        assert_eq!(guard.stats(), (1, 3));
        drop(guard);

        drop(leases);
        let guard = pool.lock().unwrap();
        assert_eq!(guard.stats(), (1, 0));
    }

    #[test]
    fn releasing_one_lease_preserves_server_while_sibling_leases_stay_active() {
        let mut pool = SharedOpenCodeServerPool::new();
        let key = opencode_pool_key(None, &[]);

        let (srv, eof) = fake_server();
        let l1 = pool
            .acquire_with(key.clone(), "thread-1:1", move || Ok(srv))
            .expect("lease 1");
        let l2 = pool
            .acquire_with(key.clone(), "thread-2:1", || {
                panic!("sibling 2 must reuse server")
            })
            .expect("lease 2");
        let l3 = pool
            .acquire_with(key.clone(), "thread-3:1", || {
                panic!("sibling 3 must reuse server")
            })
            .expect("lease 3");

        assert_eq!(pool.total_spawns(), 1);
        assert_eq!(pool.stats(), (1, 3));
        assert_eq!(l1.port(), l2.port());
        assert_eq!(l2.port(), l3.port());

        assert!(pool.release_lease(&l1));
        assert_eq!(pool.stats(), (1, 2));
        assert_eq!(pool.active_leases_for(&key), 2);
        assert!(
            !eof.load(Ordering::SeqCst),
            "server must stay alive while 2 sibling leases remain"
        );
        assert_eq!(
            pool.reap_idle_at(Duration::ZERO, Instant::now() + Duration::from_secs(600)),
            0,
            "idle reaper must never kill a server with active sibling leases"
        );
        assert_eq!(pool.stats(), (1, 2));

        assert!(pool.release_lease(&l2));
        assert!(pool.release_lease(&l3));
        assert_eq!(pool.stats(), (1, 0));
    }

    #[test]
    fn idle_reaper_reaps_unleased_servers_past_ttl_without_touching_active_ones() {
        let mut pool = SharedOpenCodeServerPool::new();
        let key_idle = opencode_pool_key(Some("conn-a"), &[]);
        let key_active = opencode_pool_key(Some("conn-b"), &[]);

        let (idle_srv, idle_eof) = fake_server();
        let idle_lease = pool
            .acquire_with(key_idle.clone(), "thread-idle:1", move || Ok(idle_srv))
            .expect("idle lease");

        let (active_srv, active_eof) = fake_server();
        let active_lease = pool
            .acquire_with(key_active.clone(), "thread-active:1", move || Ok(active_srv))
            .expect("active lease");

        assert_ne!(idle_lease.port(), active_lease.port());
        assert_eq!(pool.stats(), (2, 2));

        // Release only the first server's lease.
        assert!(pool.release_lease(&idle_lease));
        assert_eq!(pool.stats(), (2, 1));

        let ttl = Duration::from_secs(300);
        let before_ttl = Instant::now() + Duration::from_secs(60);
        assert_eq!(pool.reap_idle_at(ttl, before_ttl), 0);
        assert!(!idle_eof.load(Ordering::SeqCst));
        assert_eq!(pool.stats(), (2, 1));

        let past_ttl = Instant::now() + Duration::from_secs(301);
        assert_eq!(pool.reap_idle_at(ttl, past_ttl), 1);
        assert!(idle_eof.load(Ordering::SeqCst));
        assert!(!active_eof.load(Ordering::SeqCst));
        assert_eq!(pool.stats(), (1, 1));
        assert_eq!(pool.port_for(&key_idle), None);
        assert_eq!(pool.port_for(&key_active), Some(active_lease.port()));

        // Releasing the active server's lease lets it be reaped once past TTL.
        assert!(pool.release_lease(&active_lease));
        let final_reap_at = Instant::now() + Duration::from_secs(301);
        assert_eq!(pool.reap_idle_at(ttl, final_reap_at), 1);
        assert!(active_eof.load(Ordering::SeqCst));
        assert_eq!(pool.stats(), (0, 0));
    }

    #[test]
    fn env_fingerprint_normalizes_order_aliases_and_ignores_per_thread_tracking_vars() {
        let env_thread_1 = vec![
            ("KITE_ADDRESS".to_string(), "thread:t1".to_string()),
            ("KITE_THREAD_ID".to_string(), "t1".to_string()),
            ("KITE_SESSION_ID".to_string(), "t1:1".to_string()),
            ("KITE_MODEL".to_string(), "openai/gpt-5".to_string()),
            ("KITE_AGENT_NAME".to_string(), "explore".to_string()),
            ("OPENCODE_PASSWORD".to_string(), "pw-1".to_string()),
            ("KITE_WORKSPACE_ID".to_string(), "ws-1".to_string()),
        ];
        let env_thread_2 = vec![
            ("KITE_WORKSPACE_ID".to_string(), "ws-1".to_string()),
            ("OPENCODE_SERVER_PASSWORD".to_string(), "pw-1".to_string()),
            ("KITE_AGENT_NAME".to_string(), "review".to_string()),
            ("KITE_MODEL".to_string(), "xai/grok-4.7".to_string()),
            ("KITE_SESSION_ID".to_string(), "t2:1".to_string()),
            ("KITE_THREAD_ID".to_string(), "t2".to_string()),
            ("KITE_ADDRESS".to_string(), "thread:t2".to_string()),
        ];
        assert_eq!(
            opencode_pool_key(None, &env_thread_1),
            opencode_pool_key(None, &env_thread_2),
            "per-thread vars and password alias spelling must share one pool key"
        );

        let env_different_secret = vec![
            ("OPENCODE_SERVER_PASSWORD".to_string(), "pw-2".to_string()),
            ("KITE_WORKSPACE_ID".to_string(), "ws-1".to_string()),
        ];
        assert_ne!(
            opencode_pool_key(None, &env_thread_1),
            opencode_pool_key(None, &env_different_secret),
            "different auth secrets must never share a server"
        );

        let via_env_conn = vec![("KITE_CONNECTION_ID".to_string(), "conn-42".to_string())];
        assert_eq!(
            opencode_pool_key(Some("conn-42"), &[]),
            opencode_pool_key(None, &via_env_conn)
        );
    }

    #[test]
    fn dead_server_is_evicted_on_next_acquire_and_stale_lease_does_not_affect_replacement() {
        let pool = Arc::new(Mutex::new(SharedOpenCodeServerPool::new()));
        let cv = Arc::new(Condvar::new());
        let key = opencode_pool_key(Some("conn-crash"), &[]);

        let (srv1, eof1) = fake_server();
        let port1 = srv1.port;
        let stale_lease = acquire_shared_opencode_lease(
            &pool,
            &cv,
            key.clone(),
            "thread-stale:1",
            move || Ok(srv1),
        )
        .expect("initial lease");

        // Simulate unexpected server exit.
        eof1.store(true, Ordering::SeqCst);

        let (srv2, _eof2) = fake_server();
        let port2 = srv2.port;
        assert_ne!(port1, port2);
        let fresh_lease = acquire_shared_opencode_lease(
            &pool,
            &cv,
            key.clone(),
            "thread-fresh:1",
            move || Ok(srv2),
        )
        .expect("replacement lease");

        assert_eq!(fresh_lease.port(), port2);
        assert_ne!(fresh_lease.server_id(), stale_lease.server_id());

        // Dropping the stale lease from the crashed server must preserve the new server's lease.
        drop(stale_lease);
        {
            let guard = pool.lock().unwrap();
            assert_eq!(guard.stats(), (1, 1));
            assert_eq!(guard.total_spawns(), 2);
            assert_eq!(guard.port_for(&key), Some(port2));
        }

        drop(fresh_lease);
        let guard = pool.lock().unwrap();
        assert_eq!(guard.stats(), (1, 0));
    }

    #[test]
    fn global_pool_exports_reap_idle_and_report_stats() {
        let _serial = GLOBAL_POOL_TEST_LOCK.lock().unwrap();
        shutdown_all_opencode_servers();
        assert_eq!(opencode_pool_stats(), (0, 0));

        let key = opencode_pool_key(Some("conn-global-export"), &[]);
        let (srv, eof) = fake_server();
        let port = srv.port;
        let lease1 = acquire_global_opencode_lease(key.clone(), "g-1", move || Ok(srv))
            .expect("global lease 1");
        let lease2 = acquire_global_opencode_lease(key.clone(), "g-2", || {
            panic!("global lease 2 should reuse")
        })
        .expect("global lease 2");

        assert_eq!(lease1.port(), port);
        assert_eq!(lease2.port(), port);
        assert_eq!(opencode_pool_stats(), (1, 2));

        lease1.release();
        assert_eq!(opencode_pool_stats(), (1, 1));
        assert_eq!(reap_idle_opencode_servers(Duration::ZERO), 0);
        assert!(!eof.load(Ordering::SeqCst));

        drop(lease2);
        assert_eq!(opencode_pool_stats(), (1, 0));
        assert_eq!(reap_idle_opencode_servers(Duration::from_secs(60)), 0);
        assert_eq!(reap_idle_opencode_servers(Duration::ZERO), 1);
        assert!(eof.load(Ordering::SeqCst));
        assert_eq!(opencode_pool_stats(), (0, 0));
    }

    #[test]
    fn failed_spawner_clears_inflight_marker_for_retry() {
        let pool = Arc::new(Mutex::new(SharedOpenCodeServerPool::new()));
        let cv = Arc::new(Condvar::new());
        let key = opencode_pool_key(Some("conn-fail-retry"), &[]);

        let err = acquire_shared_opencode_lease(&pool, &cv, key.clone(), "t-fail", || {
            Err("simulated launch failure".to_string())
        })
        .expect_err("first attempt fails");
        assert!(err.contains("simulated launch failure"));

        let (srv, _) = fake_server();
        let port = srv.port;
        let ok_lease = acquire_shared_opencode_lease(&pool, &cv, key, "t-retry", move || Ok(srv))
            .expect("retry after failure must not deadlock");
        assert_eq!(ok_lease.port(), port);
    }
}
