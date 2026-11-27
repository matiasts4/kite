//! Managed process supervisor for Kite Code's external plugin sidecars.
//!
//! Spawns non-builtin sidecars via `hidden_exec` (hidden console + Windows Job
//! Object process-tree isolation), allocates ephemeral loopback ports, expands
//! plugin tokens, tees stdout/stderr to a 500-line ring buffer and `sidecar.log`,
//! tracks TCP readiness, and enforces restart policies with exponential backoff.

use crate::chat::utils::{find_in_path, now_ms};
use crate::hidden_exec::{spawn_streaming_with_owned_env, HiddenChild};
use crate::persist::roaming_app_dir;
use crate::plugin_runtime::types::{
    DiscoveredPlugin, SidecarRestartPolicy, SidecarSpec, SidecarStateKind, SidecarStatusSnapshot,
};
use std::collections::{HashMap, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

const MAX_LOG_RING_LINES: usize = 500;
const READY_POLL_INTERVAL_MS: u64 = 150;
const READY_CONNECT_TIMEOUT_MS: u64 = 80;
const BACKOFF_SCHEDULE_MS: [u64; 5] = [500, 1_000, 2_000, 5_000, 15_000];
const BACKOFF_RESET_UPTIME_SECS: u64 = 30;

static GLOBAL_SUPERVISOR: OnceLock<SidecarSupervisor> = OnceLock::new();

pub fn global_sidecar_supervisor() -> &'static SidecarSupervisor {
    GLOBAL_SUPERVISOR.get_or_init(SidecarSupervisor::new)
}

/// Thread-safe runtime supervisor managing external plugin sidecar processes.
pub struct SidecarSupervisor {
    data_root: PathBuf,
    entries: Mutex<HashMap<String, Arc<SidecarSlot>>>,
}

impl Default for SidecarSupervisor {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for SidecarSupervisor {
    fn drop(&mut self) {
        self.shutdown_all();
    }
}

struct ActiveProcess {
    child: HiddenChild,
    readers: Vec<JoinHandle<()>>,
}

struct SidecarEntry {
    spec: SidecarSpec,
    log_path: PathBuf,
    sidecar_data_dir: PathBuf,
    data_root: PathBuf,
    state: SidecarStateKind,
    pid: Option<u32>,
    upstream_port: Option<u16>,
    restart_count: u32,
    last_error: Option<String>,
    started_at_ms: Option<i64>,
    generation: u64,
    stop_requested: bool,
    manually_stopped: bool,
    logs: Arc<Mutex<VecDeque<String>>>,
}

impl SidecarEntry {
    fn to_snapshot(&self) -> SidecarStatusSnapshot {
        SidecarStatusSnapshot {
            namespaced_id: self.spec.namespaced_id.clone(),
            sidecar_id: self.spec.id.clone(),
            plugin_id: self.spec.plugin_id.clone(),
            plugin_name: self.spec.plugin_name.clone(),
            display_name: self.spec.display_name.clone(),
            description: self.spec.description.clone(),
            has_web_ui: self.spec.has_web_ui,
            views: self.spec.views.clone(),
            state: self.state,
            pid: self.pid,
            upstream_port: self.upstream_port,
            proxy_port: None,
            proxy_url: None,
            entry_url: None,
            log_path: self.log_path.to_string_lossy().into_owned(),
            restart_count: self.restart_count,
            last_error: self.last_error.clone(),
            started_at_ms: self.started_at_ms,
            builtin: self.spec.builtin.clone(),
        }
    }
}

struct SidecarSlot {
    lifecycle_lock: Mutex<()>,
    state_lock: Mutex<SidecarEntry>,
    child_lock: Mutex<Option<ActiveProcess>>,
    watcher_lock: Mutex<Option<JoinHandle<()>>>,
    backoff_signal: (Mutex<()>, Condvar),
}

impl SidecarSlot {
    fn new(spec: SidecarSpec, data_root: &Path) -> Self {
        let (sidecar_data_dir, log_path) = resolve_sidecar_dirs(data_root, &spec);
        let entry = SidecarEntry {
            spec,
            log_path,
            sidecar_data_dir,
            data_root: data_root.to_path_buf(),
            state: SidecarStateKind::Stopped,
            pid: None,
            upstream_port: None,
            restart_count: 0,
            last_error: None,
            started_at_ms: None,
            generation: 0,
            stop_requested: false,
            manually_stopped: false,
            logs: Arc::new(Mutex::new(VecDeque::with_capacity(MAX_LOG_RING_LINES))),
        };
        Self {
            lifecycle_lock: Mutex::new(()),
            state_lock: Mutex::new(entry),
            child_lock: Mutex::new(None),
            watcher_lock: Mutex::new(None),
            backoff_signal: (Mutex::new(()), Condvar::new()),
        }
    }
}

#[cfg(windows)]
struct ProcessSyncHandle(windows::Win32::Foundation::HANDLE);

#[cfg(windows)]
unsafe impl Send for ProcessSyncHandle {}

#[cfg(windows)]
impl ProcessSyncHandle {
    fn from_pid(pid: u32) -> Option<Self> {
        use windows::Win32::System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE};
        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, pid) }.ok()?;
        Some(Self(handle))
    }

    fn wait_exit(&self, timeout_ms: u32) -> bool {
        use windows::Win32::Foundation::WAIT_OBJECT_0;
        use windows::Win32::System::Threading::WaitForSingleObject;
        let result = unsafe { WaitForSingleObject(self.0, timeout_ms) };
        result == WAIT_OBJECT_0
    }
}

#[cfg(windows)]
impl Drop for ProcessSyncHandle {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

#[cfg(not(windows))]
struct ProcessSyncHandle {
    eof_count: Arc<(Mutex<usize>, Condvar)>,
}

#[cfg(not(windows))]
impl ProcessSyncHandle {
    fn wait_exit(&self, timeout_ms: u32) -> bool {
        let (lock, cvar) = &self.eof_count;
        let guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        if *guard >= 2 {
            return true;
        }
        let (guard, _) = cvar
            .wait_timeout(guard, Duration::from_millis(timeout_ms as u64))
            .unwrap_or_else(|e| e.into_inner());
        *guard >= 2
    }
}

struct SpawnedInstance {
    port: u16,
    sync_handle: Option<ProcessSyncHandle>,
    spawn_instant: Instant,
    snapshot: SidecarStatusSnapshot,
}

impl SidecarSupervisor {
    pub fn new() -> Self {
        Self::with_data_root(roaming_app_dir())
    }

    pub fn with_data_root(root: PathBuf) -> Self {
        Self {
            data_root: root,
            entries: Mutex::new(HashMap::new()),
        }
    }

    /// Reconciles registered sidecar specs against discovered plugins:
    /// stops removed or disabled sidecars, updates changed specs, and starts
    /// enabled UI sidecars when `auto_start_ui` is true.
    pub fn sync_plugins(&self, plugins: &[DiscoveredPlugin], auto_start_ui: bool) {
        let mut desired: HashMap<String, SidecarSpec> = HashMap::new();
        for plugin in plugins {
            if !plugin.enabled {
                continue;
            }
            for spec in &plugin.sidecars {
                if spec.builtin.is_some() {
                    continue;
                }
                desired
                    .entry(spec.namespaced_id.clone())
                    .or_insert_with(|| spec.clone());
            }
        }

        let mut removed_slots: Vec<Arc<SidecarSlot>> = Vec::new();
        let mut updated_slots: Vec<(Arc<SidecarSlot>, SidecarSpec)> = Vec::new();
        let mut candidate_auto_start: Vec<Arc<SidecarSlot>> = Vec::new();

        {
            let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
            let stale_ids: Vec<String> = entries
                .keys()
                .filter(|id| !desired.contains_key(*id))
                .cloned()
                .collect();
            for stale_id in stale_ids {
                if let Some(slot) = entries.remove(&stale_id) {
                    removed_slots.push(slot);
                }
            }

            for (namespaced_id, spec) in desired {
                let slot = if let Some(existing) = entries.get(&namespaced_id) {
                    let cloned = Arc::clone(existing);
                    updated_slots.push((Arc::clone(&cloned), spec.clone()));
                    cloned
                } else {
                    let created = Arc::new(SidecarSlot::new(spec.clone(), &self.data_root));
                    entries.insert(namespaced_id, Arc::clone(&created));
                    created
                };

                if auto_start_ui && spec.has_web_ui {
                    candidate_auto_start.push(slot);
                }
            }
        }

        for slot in removed_slots {
            let _ = stop_slot(&slot, true);
        }

        for (slot, new_spec) in updated_slots {
            let _lifecycle = slot.lifecycle_lock.lock().unwrap_or_else(|e| e.into_inner());
            let needs_restart = {
                let state = slot.state_lock.lock().unwrap_or_else(|e| e.into_inner());
                let active = matches!(
                    state.state,
                    SidecarStateKind::Starting
                        | SidecarStateKind::Running
                        | SidecarStateKind::Unhealthy
                );
                active && launch_config_changed(&state.spec, &new_spec)
            };

            if needs_restart {
                stop_slot_locked(&slot, false);
            }

            let mut state = slot.state_lock.lock().unwrap_or_else(|e| e.into_inner());
            let (sidecar_data_dir, log_path) = resolve_sidecar_dirs(&state.data_root, &new_spec);
            state.spec = new_spec;
            state.sidecar_data_dir = sidecar_data_dir;
            state.log_path = log_path;
        }

        for slot in candidate_auto_start {
            let _lifecycle = slot.lifecycle_lock.lock().unwrap_or_else(|e| e.into_inner());
            let should_start = {
                let state = slot.state_lock.lock().unwrap_or_else(|e| e.into_inner());
                state.state == SidecarStateKind::Stopped
                    && !state.manually_stopped
                    && state.spec.builtin.is_none()
                    && state.spec.has_web_ui
            };
            if should_start {
                let _ = start_slot_locked(&slot);
            }
        }
    }

    pub fn start_sidecar(&self, namespaced_id: &str) -> Result<SidecarStatusSnapshot, String> {
        let slot = self.get_slot(namespaced_id)?;
        let _lifecycle = slot.lifecycle_lock.lock().unwrap_or_else(|e| e.into_inner());
        start_slot_locked(&slot)
    }

    pub fn stop_sidecar(&self, namespaced_id: &str) -> Result<SidecarStatusSnapshot, String> {
        let slot = self.get_slot(namespaced_id)?;
        Ok(stop_slot(&slot, true))
    }

    pub fn restart_sidecar(&self, namespaced_id: &str) -> Result<SidecarStatusSnapshot, String> {
        let slot = self.get_slot(namespaced_id)?;
        let _lifecycle = slot.lifecycle_lock.lock().unwrap_or_else(|e| e.into_inner());
        stop_slot_locked(&slot, false);
        start_slot_locked(&slot)
    }

    pub fn snapshot(&self, namespaced_id: &str) -> Option<SidecarStatusSnapshot> {
        let slot = {
            let entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
            entries.get(namespaced_id).cloned()
        }?;
        let state = slot.state_lock.lock().unwrap_or_else(|e| e.into_inner());
        Some(state.to_snapshot())
    }

    pub fn list_snapshots(&self) -> Vec<SidecarStatusSnapshot> {
        let slots: Vec<Arc<SidecarSlot>> = {
            let entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
            entries.values().cloned().collect()
        };
        let mut snapshots: Vec<SidecarStatusSnapshot> = slots
            .into_iter()
            .map(|slot| {
                slot.state_lock
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .to_snapshot()
            })
            .collect();
        snapshots.sort_by(|a, b| a.namespaced_id.cmp(&b.namespaced_id));
        snapshots
    }

    pub fn upstream_port(&self, namespaced_id: &str) -> Option<u16> {
        let slot = {
            let entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
            entries.get(namespaced_id).cloned()
        }?;
        let state = slot.state_lock.lock().unwrap_or_else(|e| e.into_inner());
        match state.state {
            SidecarStateKind::Starting
            | SidecarStateKind::Running
            | SidecarStateKind::Unhealthy => state.upstream_port,
            SidecarStateKind::Stopped
            | SidecarStateKind::Crashed
            | SidecarStateKind::Stopping => None,
        }
    }

    pub fn read_logs(&self, namespaced_id: &str, tail_lines: usize) -> Vec<String> {
        if tail_lines == 0 {
            return Vec::new();
        }
        let slot = {
            let entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
            entries.get(namespaced_id).cloned()
        };
        let Some(slot) = slot else {
            return Vec::new();
        };

        let (logs_arc, log_path) = {
            let state = slot.state_lock.lock().unwrap_or_else(|e| e.into_inner());
            (Arc::clone(&state.logs), state.log_path.clone())
        };

        let ring = logs_arc.lock().unwrap_or_else(|e| e.into_inner());
        if !ring.is_empty() {
            let skip = ring.len().saturating_sub(tail_lines);
            return ring.iter().skip(skip).cloned().collect();
        }
        drop(ring);

        read_tail_from_file(&log_path, tail_lines.min(MAX_LOG_RING_LINES))
    }

    /// Signals every managed sidecar to stop and terminates every active process tree.
    pub fn shutdown_all(&self) {
        let slots: Vec<Arc<SidecarSlot>> = {
            let entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
            entries.values().cloned().collect()
        };

        // Wake any watchers currently waiting in exponential backoff in parallel.
        for slot in &slots {
            {
                let mut state = slot.state_lock.lock().unwrap_or_else(|e| e.into_inner());
                state.stop_requested = true;
                state.generation = state.generation.wrapping_add(1);
            }
            let (_guard, cvar) = &slot.backoff_signal;
            cvar.notify_all();
        }

        for slot in slots {
            let _ = stop_slot(&slot, true);
        }
    }

    fn get_slot(&self, namespaced_id: &str) -> Result<Arc<SidecarSlot>, String> {
        let entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        entries
            .get(namespaced_id)
            .cloned()
            .ok_or_else(|| format!("Unknown or disabled sidecar '{namespaced_id}'"))
    }
}

fn launch_config_changed(a: &SidecarSpec, b: &SidecarSpec) -> bool {
    a.command != b.command
        || a.args != b.args
        || a.env != b.env
        || a.working_dir != b.working_dir
        || a.plugin_root != b.plugin_root
        || a.plugin_data != b.plugin_data
        || a.restart_policy != b.restart_policy
}

fn sanitize_path_segment(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '\0' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            other => other,
        })
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        "_".to_string()
    } else {
        trimmed.to_string()
    }
}

fn resolve_sidecar_dirs(data_root: &Path, spec: &SidecarSpec) -> (PathBuf, PathBuf) {
    let base = data_root
        .join("sidecar_data")
        .join(sanitize_path_segment(&spec.plugin_id))
        .join(sanitize_path_segment(&spec.id));
    let data_dir = base.join("data");
    let log_path = base.join("logs").join("sidecar.log");
    (data_dir, log_path)
}

fn stop_slot(slot: &Arc<SidecarSlot>, manual: bool) -> SidecarStatusSnapshot {
    let _lifecycle = slot.lifecycle_lock.lock().unwrap_or_else(|e| e.into_inner());
    stop_slot_locked(slot, manual)
}

fn stop_slot_locked(slot: &Arc<SidecarSlot>, manual: bool) -> SidecarStatusSnapshot {
    {
        let mut state = slot.state_lock.lock().unwrap_or_else(|e| e.into_inner());
        state.stop_requested = true;
        if manual {
            state.manually_stopped = true;
        }
        state.generation = state.generation.wrapping_add(1);
        if matches!(
            state.state,
            SidecarStateKind::Starting | SidecarStateKind::Running | SidecarStateKind::Unhealthy
        ) {
            state.state = SidecarStateKind::Stopping;
        }
    }

    {
        let (_guard, cvar) = &slot.backoff_signal;
        cvar.notify_all();
    }

    let active = {
        let mut child_guard = slot.child_lock.lock().unwrap_or_else(|e| e.into_inner());
        child_guard.take()
    };

    if let Some(mut proc) = active {
        let _ = proc.child.kill();
        let _ = proc.child.wait();
        drop(proc.child);
        for reader in proc.readers {
            let _ = reader.join();
        }
    }

    let watcher = {
        let mut watcher_guard = slot.watcher_lock.lock().unwrap_or_else(|e| e.into_inner());
        watcher_guard.take()
    };
    if let Some(handle) = watcher {
        let _ = handle.join();
    }

    let mut state = slot.state_lock.lock().unwrap_or_else(|e| e.into_inner());
    state.state = SidecarStateKind::Stopped;
    state.pid = None;
    state.upstream_port = None;
    state.started_at_ms = None;
    state.to_snapshot()
}

fn start_slot_locked(slot: &Arc<SidecarSlot>) -> Result<SidecarStatusSnapshot, String> {
    let old_watcher = {
        let mut watcher_guard = slot.watcher_lock.lock().unwrap_or_else(|e| e.into_inner());
        watcher_guard.take()
    };
    if let Some(handle) = old_watcher {
        let _ = handle.join();
    }

    let (gen, spec, log_path, sidecar_data_dir, data_root, logs) = {
        let mut state = slot.state_lock.lock().unwrap_or_else(|e| e.into_inner());
        if state.spec.builtin.is_some() {
            return Err(format!(
                "Sidecar '{}' is builtin and does not spawn an external process",
                state.spec.namespaced_id
            ));
        }
        if matches!(
            state.state,
            SidecarStateKind::Starting | SidecarStateKind::Running | SidecarStateKind::Unhealthy
        ) {
            return Ok(state.to_snapshot());
        }
        state.generation = state.generation.wrapping_add(1);
        state.stop_requested = false;
        state.manually_stopped = false;
        state.restart_count = 0;
        state.last_error = None;
        (
            state.generation,
            state.spec.clone(),
            state.log_path.clone(),
            state.sidecar_data_dir.clone(),
            state.data_root.clone(),
            Arc::clone(&state.logs),
        )
    };

    let spawned = match spawn_instance(
        slot,
        &spec,
        &log_path,
        &sidecar_data_dir,
        &data_root,
        &logs,
        gen,
    ) {
        Ok(instance) => instance,
        Err(err) => {
            let mut state = slot.state_lock.lock().unwrap_or_else(|e| e.into_inner());
            if state.generation == gen {
                state.state = SidecarStateKind::Crashed;
                state.pid = None;
                state.upstream_port = None;
                state.started_at_ms = None;
                state.last_error = Some(err.clone());
            }
            return Err(err);
        }
    };

    let snapshot = spawned.snapshot.clone();
    let slot_clone = Arc::clone(slot);
    let thread_name = format!("kite-sidecar-watch-{}", sanitize_path_segment(&spec.id));
    let handle = std::thread::Builder::new()
        .name(thread_name)
        .spawn(move || watcher_loop(slot_clone, gen, spawned))
        .map_err(|err| format!("Failed to spawn sidecar watcher thread: {err}"))?;

    let mut watcher_guard = slot.watcher_lock.lock().unwrap_or_else(|e| e.into_inner());
    *watcher_guard = Some(handle);

    Ok(snapshot)
}

fn spawn_instance(
    slot: &Arc<SidecarSlot>,
    spec: &SidecarSpec,
    log_path: &Path,
    sidecar_data_dir: &Path,
    data_root: &Path,
    logs: &Arc<Mutex<VecDeque<String>>>,
    gen: u64,
) -> Result<SpawnedInstance, String> {
    let program = resolve_command(spec)?;
    let port = allocate_loopback_port()?;

    if !spec.plugin_data.as_os_str().is_empty() {
        fs::create_dir_all(&spec.plugin_data)
            .map_err(|err| format!("Failed to create plugin data dir: {err}"))?;
    }
    fs::create_dir_all(sidecar_data_dir)
        .map_err(|err| format!("Failed to create sidecar data dir: {err}"))?;
    if let Some(logs_dir) = log_path.parent() {
        fs::create_dir_all(logs_dir)
            .map_err(|err| format!("Failed to create sidecar logs dir: {err}"))?;
    }

    let log_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
        .map_err(|err| format!("Failed to open sidecar log '{}': {err}", log_path.display()))?;
    let log_file = Arc::new(Mutex::new(log_file));

    let expanded_args: Vec<String> = spec
        .args
        .iter()
        .map(|arg| expand_tokens(arg, spec))
        .collect();
    let arg_refs: Vec<&str> = expanded_args.iter().map(String::as_str).collect();

    let env_pairs = build_env_pairs(spec, port, data_root, sidecar_data_dir);
    let cwd = (!spec.working_dir.as_os_str().is_empty()).then_some(spec.working_dir.as_path());

    let spawn_instant = Instant::now();
    let started_at_ms = now_ms();
    let mut child = spawn_streaming_with_owned_env(&program, &arg_refs, cwd, &env_pairs)
        .map_err(|err| format!("Failed to spawn sidecar '{}': {err}", program.display()))?;
    let pid = child.id();

    #[cfg(windows)]
    let sync_handle = ProcessSyncHandle::from_pid(pid);

    #[cfg(not(windows))]
    let eof_count = Arc::new((Mutex::new(0usize), Condvar::new()));
    #[cfg(not(windows))]
    let sync_handle = Some(ProcessSyncHandle {
        eof_count: Arc::clone(&eof_count),
    });

    let mut readers = Vec::new();
    if let Some(stdout) = child.stdout.take() {
        let logs_ref = Arc::clone(logs);
        let file_ref = Arc::clone(&log_file);
        #[cfg(not(windows))]
        let eof_ref = Arc::clone(&eof_count);
        let name = format!("kite-sidecar-out-{}", sanitize_path_segment(&spec.id));
        if let Ok(handle) = std::thread::Builder::new().name(name).spawn(move || {
            read_stream_lines(stdout, None, logs_ref, file_ref);
            #[cfg(not(windows))]
            signal_stream_eof(&eof_ref);
        }) {
            readers.push(handle);
        }
    } else {
        #[cfg(not(windows))]
        signal_stream_eof(&eof_count);
    }

    if let Some(stderr) = child.stderr.take() {
        let logs_ref = Arc::clone(logs);
        let file_ref = Arc::clone(&log_file);
        #[cfg(not(windows))]
        let eof_ref = Arc::clone(&eof_count);
        let name = format!("kite-sidecar-err-{}", sanitize_path_segment(&spec.id));
        if let Ok(handle) = std::thread::Builder::new().name(name).spawn(move || {
            read_stream_lines(stderr, Some("[stderr] "), logs_ref, file_ref);
            #[cfg(not(windows))]
            signal_stream_eof(&eof_ref);
        }) {
            readers.push(handle);
        }
    } else {
        #[cfg(not(windows))]
        signal_stream_eof(&eof_count);
    }

    let snapshot = {
        let mut state = slot.state_lock.lock().unwrap_or_else(|e| e.into_inner());
        if state.stop_requested || state.generation != gen {
            drop(state);
            let _ = child.kill();
            let _ = child.wait();
            drop(child);
            for reader in readers {
                let _ = reader.join();
            }
            return Err("Sidecar stopped before startup completed".to_string());
        }
        {
            let mut child_guard = slot.child_lock.lock().unwrap_or_else(|e| e.into_inner());
            *child_guard = Some(ActiveProcess { child, readers });
        }
        state.state = SidecarStateKind::Starting;
        state.pid = Some(pid);
        state.upstream_port = Some(port);
        state.started_at_ms = Some(started_at_ms);
        state.last_error = None;
        state.to_snapshot()
    };

    Ok(SpawnedInstance {
        port,
        sync_handle,
        spawn_instant,
        snapshot,
    })
}

#[cfg(not(windows))]
fn signal_stream_eof(eof: &Arc<(Mutex<usize>, Condvar)>) {
    let (lock, cvar) = &**eof;
    let mut count = lock.lock().unwrap_or_else(|e| e.into_inner());
    *count += 1;
    cvar.notify_all();
}

fn read_stream_lines(
    stream: Box<dyn std::io::Read + Send>,
    prefix: Option<&'static str>,
    logs: Arc<Mutex<VecDeque<String>>>,
    log_file: Arc<Mutex<File>>,
) {
    let mut reader = BufReader::new(stream);
    let mut buf = Vec::with_capacity(512);
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) => break,
            Ok(_) => {
                let raw = String::from_utf8_lossy(&buf);
                let trimmed = raw.trim_end_matches(&['\r', '\n'][..]);
                let formatted = match prefix {
                    Some(p) => format!("{p}{trimmed}"),
                    None => trimmed.to_string(),
                };
                {
                    let mut ring = logs.lock().unwrap_or_else(|e| e.into_inner());
                    while ring.len() >= MAX_LOG_RING_LINES {
                        ring.pop_front();
                    }
                    ring.push_back(formatted.clone());
                }
                {
                    let mut file = log_file.lock().unwrap_or_else(|e| e.into_inner());
                    let _ = writeln!(file, "{formatted}");
                    let _ = file.flush();
                }
            }
            Err(_) => break,
        }
    }
}

fn read_tail_from_file(path: &Path, max_lines: usize) -> Vec<String> {
    let Ok(file) = File::open(path) else {
        return Vec::new();
    };
    let mut reader = BufReader::new(file);
    let mut ring = VecDeque::with_capacity(max_lines);
    let mut buf = Vec::with_capacity(256);
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) => break,
            Ok(_) => {
                let line = String::from_utf8_lossy(&buf)
                    .trim_end_matches(&['\r', '\n'][..])
                    .to_string();
                while ring.len() >= max_lines {
                    ring.pop_front();
                }
                ring.push_back(line);
            }
            Err(_) => break,
        }
    }
    ring.into_iter().collect()
}

fn watcher_loop(slot: Arc<SidecarSlot>, gen: u64, initial: SpawnedInstance) {
    let mut current_port = initial.port;
    let mut sync_handle = initial.sync_handle;
    let mut spawn_instant = initial.spawn_instant;
    let mut backoff_step: usize = 0;

    loop {
        // Phase 1: poll TCP readiness every 150ms while waiting for process exit.
        loop {
            let current_state = {
                let state = slot.state_lock.lock().unwrap_or_else(|e| e.into_inner());
                if state.stop_requested || state.generation != gen {
                    return;
                }
                state.state
            };

            if current_state == SidecarStateKind::Starting {
                let addr = SocketAddr::from(([127, 0, 0, 1], current_port));
                if TcpStream::connect_timeout(&addr, Duration::from_millis(READY_CONNECT_TIMEOUT_MS))
                    .is_ok()
                {
                    let mut state = slot.state_lock.lock().unwrap_or_else(|e| e.into_inner());
                    if !state.stop_requested
                        && state.generation == gen
                        && state.state == SidecarStateKind::Starting
                    {
                        state.state = SidecarStateKind::Running;
                    }
                }
            }

            let exited = if let Some(ref handle) = sync_handle {
                handle.wait_exit(READY_POLL_INTERVAL_MS as u32)
            } else {
                std::thread::sleep(Duration::from_millis(READY_POLL_INTERVAL_MS));
                false
            };

            if exited {
                break;
            }
        }

        // Phase 2: reap exited process and drain stdout/stderr readers.
        let active = {
            let state = slot.state_lock.lock().unwrap_or_else(|e| e.into_inner());
            if state.stop_requested || state.generation != gen {
                return;
            }
            drop(state);
            let mut child_guard = slot.child_lock.lock().unwrap_or_else(|e| e.into_inner());
            child_guard.take()
        };

        let Some(mut proc) = active else {
            return;
        };

        let exit_res = proc.child.wait();
        drop(proc.child);
        drop(sync_handle.take());
        for reader in proc.readers {
            let _ = reader.join();
        }

        let uptime = spawn_instant.elapsed();
        let exit_code = match exit_res {
            Ok(code) => code,
            Err(_) => -1,
        };

        let (should_restart, spec, log_path, sidecar_data_dir, data_root, logs) = {
            let mut state = slot.state_lock.lock().unwrap_or_else(|e| e.into_inner());
            if state.stop_requested || state.generation != gen {
                return;
            }

            let restart = match state.spec.restart_policy {
                SidecarRestartPolicy::Never => false,
                SidecarRestartPolicy::OnFailure => exit_code != 0,
                SidecarRestartPolicy::Always => true,
            };

            state.pid = None;
            state.upstream_port = None;
            state.started_at_ms = None;
            if exit_code != 0 {
                state.state = SidecarStateKind::Crashed;
                state.last_error = Some(format!("Sidecar exited with code {exit_code}"));
            } else {
                state.state = SidecarStateKind::Stopped;
                state.last_error = None;
            }

            (
                restart,
                state.spec.clone(),
                state.log_path.clone(),
                state.sidecar_data_dir.clone(),
                state.data_root.clone(),
                Arc::clone(&state.logs),
            )
        };

        if !should_restart {
            return;
        }

        // Phase 3: exponential backoff sleep interruptible by stop/shutdown.
        let (delay, next_step) = compute_next_backoff(uptime, backoff_step);
        backoff_step = next_step;

        if !wait_backoff_interruptible(&slot, gen, delay) {
            return;
        }

        // Phase 4: spawn replacement instance (retry with backoff if spawn itself fails).
        loop {
            {
                let mut state = slot.state_lock.lock().unwrap_or_else(|e| e.into_inner());
                if state.stop_requested || state.generation != gen {
                    return;
                }
                state.restart_count = state.restart_count.saturating_add(1);
            }

            match spawn_instance(
                &slot,
                &spec,
                &log_path,
                &sidecar_data_dir,
                &data_root,
                &logs,
                gen,
            ) {
                Ok(next) => {
                    current_port = next.port;
                    sync_handle = next.sync_handle;
                    spawn_instant = next.spawn_instant;
                    break;
                }
                Err(err) => {
                    {
                        let mut state = slot.state_lock.lock().unwrap_or_else(|e| e.into_inner());
                        if state.stop_requested || state.generation != gen {
                            return;
                        }
                        state.state = SidecarStateKind::Crashed;
                        state.last_error = Some(err);
                    }
                    let (retry_delay, next_step) = compute_next_backoff(Duration::ZERO, backoff_step);
                    backoff_step = next_step;
                    if !wait_backoff_interruptible(&slot, gen, retry_delay) {
                        return;
                    }
                }
            }
        }
    }
}

fn compute_next_backoff(uptime: Duration, current_step: usize) -> (Duration, usize) {
    let step = if uptime >= Duration::from_secs(BACKOFF_RESET_UPTIME_SECS) {
        0
    } else {
        current_step
    };
    let delay_ms = BACKOFF_SCHEDULE_MS[step.min(BACKOFF_SCHEDULE_MS.len() - 1)];
    let next_step = (step + 1).min(BACKOFF_SCHEDULE_MS.len() - 1);
    (Duration::from_millis(delay_ms), next_step)
}

fn wait_backoff_interruptible(slot: &Arc<SidecarSlot>, gen: u64, duration: Duration) -> bool {
    let deadline = Instant::now() + duration;
    let (lock, cvar) = &slot.backoff_signal;
    let mut guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    loop {
        {
            let state = slot.state_lock.lock().unwrap_or_else(|e| e.into_inner());
            if state.stop_requested || state.generation != gen {
                return false;
            }
        }
        let now = Instant::now();
        if now >= deadline {
            return true;
        }
        let remaining = deadline - now;
        let (next_guard, _) = cvar
            .wait_timeout(guard, remaining)
            .unwrap_or_else(|e| e.into_inner());
        guard = next_guard;
    }
}

fn allocate_loopback_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|err| format!("Failed to allocate loopback port: {err}"))?;
    listener
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|err| format!("Failed to inspect allocated loopback port: {err}"))
}

fn expand_tokens(input: &str, spec: &SidecarSpec) -> String {
    let plugin_root = spec.plugin_root.to_string_lossy();
    let plugin_data = spec.plugin_data.to_string_lossy();

    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after_open = &rest[start + 2..];
        let Some(end) = after_open.find('}') else {
            out.push_str(&rest[start..]);
            return out;
        };
        let token = &after_open[..end];
        if token == "PLUGIN_ROOT" {
            out.push_str(&plugin_root);
        } else if token == "PLUGIN_DATA" {
            out.push_str(&plugin_data);
        } else if token.starts_with("flag:") {
            out.push_str("false");
        } else {
            out.push_str("${");
            out.push_str(token);
            out.push('}');
        }
        rest = &after_open[end + 1..];
    }
    out.push_str(rest);
    out
}

fn build_env_pairs(
    spec: &SidecarSpec,
    port: u16,
    data_root: &Path,
    sidecar_data_dir: &Path,
) -> Vec<(String, String)> {
    let mut env_pairs: Vec<(String, String)> = spec
        .env
        .iter()
        .map(|(k, v)| (k.clone(), expand_tokens(v, spec)))
        .collect();

    let port_str = port.to_string();
    env_pairs.push(("KITE_SIDECAR_WEB_PORT".to_string(), port_str.clone()));
    // Compatibility env aliases expected by external sidecar bundles.
    env_pairs.push(("ANTIGRAVITY_SIDECAR_WEB_PORT".to_string(), port_str));
    env_pairs.push(("KITE_SIDECAR_ID".to_string(), spec.namespaced_id.clone()));
    env_pairs.push((
        "PLUGIN_ROOT".to_string(),
        spec.plugin_root.to_string_lossy().into_owned(),
    ));
    env_pairs.push((
        "PLUGIN_DATA".to_string(),
        spec.plugin_data.to_string_lossy().into_owned(),
    ));
    env_pairs.push((
        "KITE_EXECUTABLE_DATA_DIR".to_string(),
        data_root.to_string_lossy().into_owned(),
    ));
    env_pairs.push((
        "ANTIGRAVITY_EXECUTABLE_DATA_DIR".to_string(),
        sidecar_data_dir.to_string_lossy().into_owned(),
    ));
    env_pairs
}

fn resolve_executable_candidate(path: &Path) -> Option<PathBuf> {
    if path.is_file() {
        return Some(path.to_path_buf());
    }
    #[cfg(windows)]
    if path.extension().is_none() {
        for ext in [".exe", ".cmd", ".bat"] {
            let mut os = path.as_os_str().to_os_string();
            os.push(ext);
            let candidate = PathBuf::from(os);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn resolve_command(spec: &SidecarSpec) -> Result<PathBuf, String> {
    let expanded = expand_tokens(&spec.command, spec);
    let cmd = expanded.trim();
    if cmd.is_empty() {
        return Err(format!("Sidecar '{}' has an empty command", spec.namespaced_id));
    }

    let cmd_path = Path::new(cmd);
    if cmd_path.is_absolute() {
        return resolve_executable_candidate(cmd_path)
            .ok_or_else(|| format!("Sidecar command not found: {}", cmd_path.display()));
    }

    let is_path_like = cmd.contains('/') || cmd.contains('\\') || cmd.starts_with('.');
    if is_path_like {
        let joined = if spec.working_dir.as_os_str().is_empty() {
            cmd_path.to_path_buf()
        } else {
            spec.working_dir.join(cmd_path)
        };
        return resolve_executable_candidate(&joined)
            .ok_or_else(|| format!("Sidecar command not found: {}", joined.display()));
    }

    if !spec.working_dir.as_os_str().is_empty() {
        let in_cwd = spec.working_dir.join(cmd);
        if let Some(found) = resolve_executable_candidate(&in_cwd) {
            return Ok(found);
        }
    }

    if let Some(found) = find_in_path(cmd) {
        return Ok(found);
    }

    #[cfg(windows)]
    if cmd.eq_ignore_ascii_case("node") || cmd.eq_ignore_ascii_case("node.exe") {
        let default_node = PathBuf::from(r"C:\Program Files\nodejs\node.exe");
        if default_node.is_file() {
            return Ok(default_node);
        }
        if let Some(program_files) = std::env::var_os("ProgramFiles") {
            let pf_node = PathBuf::from(program_files).join("nodejs").join("node.exe");
            if pf_node.is_file() {
                return Ok(pf_node);
            }
        }
    }

    Err(format!("Unable to resolve sidecar command '{cmd}'"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_runtime::types::{
        PluginManifestFormat, PluginSourceKind, SidecarUiView,
    };
    use std::collections::BTreeMap;

    struct TempTestDir {
        path: PathBuf,
    }

    impl TempTestDir {
        fn new(label: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "kite-sidecar-test-{label}-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4().simple()
            ));
            fs::create_dir_all(&dir).expect("create temp test dir");
            Self { path: dir }
        }
    }

    impl Drop for TempTestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn make_spec(
        root: &Path,
        plugin_id: &str,
        sidecar_id: &str,
        command: &str,
        args: Vec<String>,
        restart_policy: SidecarRestartPolicy,
        has_web_ui: bool,
    ) -> SidecarSpec {
        let plugin_root = root.join("plugins").join(plugin_id);
        let plugin_data = root.join("plugin_data").join(plugin_id);
        fs::create_dir_all(&plugin_root).expect("create plugin root");
        fs::create_dir_all(&plugin_data).expect("create plugin data");
        SidecarSpec {
            id: sidecar_id.to_string(),
            namespaced_id: format!("{plugin_id}:{sidecar_id}"),
            plugin_id: plugin_id.to_string(),
            plugin_name: plugin_id.to_string(),
            display_name: format!("{sidecar_id} Sidecar"),
            description: "Test sidecar".to_string(),
            command: command.to_string(),
            args,
            env: BTreeMap::new(),
            builtin: None,
            restart_policy,
            has_web_ui,
            views: if has_web_ui {
                vec![SidecarUiView {
                    title: "Main".to_string(),
                    path: "/".to_string(),
                    entrypoint: "/".to_string(),
                }]
            } else {
                Vec::new()
            },
            working_dir: plugin_root.clone(),
            plugin_root,
            plugin_data,
            allows_user_interactions: false,
        }
    }

    fn make_plugin(spec: SidecarSpec, enabled: bool) -> DiscoveredPlugin {
        DiscoveredPlugin {
            dir_id: spec.plugin_id.clone(),
            name: spec.plugin_name.clone(),
            display_name: spec.plugin_name.clone(),
            description: "Test plugin".to_string(),
            version: Some("1.0.0".to_string()),
            author: None,
            homepage: None,
            repository: None,
            license: None,
            keywords: Vec::new(),
            suggested_prompts: Vec::new(),
            logo_data_uri: None,
            source: PluginSourceKind::GlobalKite,
            format: PluginManifestFormat::Native,
            root_path: spec.plugin_root.clone(),
            data_path: spec.plugin_data.clone(),
            enabled,
            manifest_disabled: false,
            can_uninstall: true,
            has_hooks: false,
            hooks_path: None,
            sidecars: vec![spec],
            mcp_servers: Vec::new(),
            skills: Vec::new(),
            rules: Vec::new(),
            agents: Vec::new(),
        }
    }

    fn wait_until<F>(timeout: Duration, mut predicate: F) -> bool
    where
        F: FnMut() -> bool,
    {
        let start = Instant::now();
        while start.elapsed() < timeout {
            if predicate() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(30));
        }
        predicate()
    }

    #[cfg(windows)]
    fn is_pid_alive(pid: u32) -> bool {
        use windows::Win32::Foundation::{CloseHandle, WAIT_TIMEOUT};
        use windows::Win32::System::Threading::{
            OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
        };
        unsafe {
            let Ok(handle) = OpenProcess(PROCESS_SYNCHRONIZE, false, pid) else {
                return false;
            };
            let wait = WaitForSingleObject(handle, 0);
            let _ = CloseHandle(handle);
            wait == WAIT_TIMEOUT
        }
    }

    #[test]
    fn expands_tokens_and_converts_unknown_flags() {
        let tmp = TempTestDir::new("tokens");
        let spec = make_spec(
            &tmp.path,
            "alpha",
            "srv",
            "node",
            Vec::new(),
            SidecarRestartPolicy::Never,
            false,
        );
        let expanded = expand_tokens(
            "--root=${PLUGIN_ROOT}/dist --data=${PLUGIN_DATA} --flag=${flag:experimental_ui} --keep=${OTHER} ${UNCLOSED",
            &spec,
        );
        let expected = format!(
            "--root={}/dist --data={} --flag=false --keep=${{OTHER}} ${{UNCLOSED",
            spec.plugin_root.display(),
            spec.plugin_data.display()
        );
        assert_eq!(expanded, expected);
    }

    #[test]
    fn resolves_relative_working_dir_and_path_commands() {
        let tmp = TempTestDir::new("resolve");
        let mut spec = make_spec(
            &tmp.path,
            "resolver",
            "srv",
            "./bin/run.cmd",
            Vec::new(),
            SidecarRestartPolicy::Never,
            false,
        );
        let bin_dir = spec.working_dir.join("bin");
        fs::create_dir_all(&bin_dir).expect("create bin dir");
        let script = bin_dir.join("run.cmd");
        fs::write(&script, "@echo off\r\n").expect("write run.cmd");

        let resolved_rel = resolve_command(&spec).expect("resolve relative path-like command");
        assert_eq!(resolved_rel, script);

        spec.command = "bin".to_string();
        let bare_tool = spec.working_dir.join("localtool.cmd");
        fs::write(&bare_tool, "@echo off\r\n").expect("write localtool.cmd");
        spec.command = "localtool".to_string();
        let resolved_bare_cwd = resolve_command(&spec).expect("resolve bare command in working_dir");
        assert_eq!(resolved_bare_cwd, bare_tool);

        spec.command = "node".to_string();
        let resolved_node = resolve_command(&spec).expect("resolve node command");
        assert!(resolved_node.is_file());
    }

    #[test]
    fn injects_port_and_runtime_env_vars_with_token_expansion() {
        let tmp = TempTestDir::new("env");
        let data_root = tmp.path.join("roaming");
        let supervisor = SidecarSupervisor::with_data_root(data_root.clone());

        let js = r#"
console.log(JSON.stringify({
  kitePort: process.env.KITE_SIDECAR_WEB_PORT,
  compatPort: process.env.ANTIGRAVITY_SIDECAR_WEB_PORT,
  sidecarId: process.env.KITE_SIDECAR_ID,
  pluginRoot: process.env.PLUGIN_ROOT,
  pluginData: process.env.PLUGIN_DATA,
  kiteDataDir: process.env.KITE_EXECUTABLE_DATA_DIR,
  compatDataDir: process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR,
  customEnv: process.env.CUSTOM_CFG,
  arg0: process.argv[1],
  arg1: process.argv[2]
}));
setTimeout(() => {}, 5000);
"#;
        let mut spec = make_spec(
            &tmp.path,
            "env-plugin",
            "worker",
            "node",
            vec![
                "-e".to_string(),
                js.to_string(),
                "${PLUGIN_ROOT}/entry.js".to_string(),
                "${flag:telemetry}".to_string(),
            ],
            SidecarRestartPolicy::Never,
            false,
        );
        spec.env.insert(
            "CUSTOM_CFG".to_string(),
            "${PLUGIN_DATA}/settings.json".to_string(),
        );
        let id = spec.namespaced_id.clone();
        let expected_plugin_root = spec.plugin_root.to_string_lossy().into_owned();
        let expected_plugin_data = spec.plugin_data.to_string_lossy().into_owned();
        let expected_compat_dir = data_root
            .join("sidecar_data")
            .join("env-plugin")
            .join("worker")
            .join("data")
            .to_string_lossy()
            .into_owned();

        supervisor.sync_plugins(&[make_plugin(spec, true)], false);
        let snap = supervisor.start_sidecar(&id).expect("start sidecar");
        let port = snap.upstream_port.expect("upstream port allocated");
        assert!(port > 0);

        let found = wait_until(Duration::from_secs(5), || {
            !supervisor.read_logs(&id, 10).is_empty()
        });
        assert!(found, "expected stdout log line from node sidecar");

        let logs = supervisor.read_logs(&id, 10);
        let payload: serde_json::Value =
            serde_json::from_str(&logs[0]).expect("parse env json output");

        assert_eq!(payload["kitePort"].as_str(), Some(port.to_string().as_str()));
        assert_eq!(
            payload["compatPort"].as_str(),
            Some(port.to_string().as_str())
        );
        assert_eq!(payload["sidecarId"].as_str(), Some(id.as_str()));
        assert_eq!(
            payload["pluginRoot"].as_str(),
            Some(expected_plugin_root.as_str())
        );
        assert_eq!(
            payload["pluginData"].as_str(),
            Some(expected_plugin_data.as_str())
        );
        assert_eq!(
            payload["kiteDataDir"].as_str(),
            Some(data_root.to_string_lossy().as_ref())
        );
        assert_eq!(
            payload["compatDataDir"].as_str(),
            Some(expected_compat_dir.as_str())
        );
        assert_eq!(
            payload["customEnv"].as_str(),
            Some(format!("{expected_plugin_data}/settings.json").as_str())
        );
        assert_eq!(
            payload["arg0"].as_str(),
            Some(format!("{expected_plugin_root}/entry.js").as_str())
        );
        assert_eq!(payload["arg1"].as_str(), Some("false"));

        supervisor.shutdown_all();
    }

    #[test]
    fn tees_logs_to_500_line_ring_buffer_and_sidecar_log_file() {
        let tmp = TempTestDir::new("logs");
        let data_root = tmp.path.join("roaming");
        let supervisor = SidecarSupervisor::with_data_root(data_root.clone());

        let js = r#"
for (let i = 1; i <= 560; i++) {
  console.log('line-' + String(i).padStart(3, '0'));
}
console.error('err-marker-1');
process.exit(0);
"#;
        let spec = make_spec(
            &tmp.path,
            "log-plugin",
            "logger",
            "node",
            vec!["-e".to_string(), js.to_string()],
            SidecarRestartPolicy::Never,
            false,
        );
        let id = spec.namespaced_id.clone();

        supervisor.sync_plugins(&[make_plugin(spec, true)], false);
        let snap = supervisor.start_sidecar(&id).expect("start sidecar");

        let finished = wait_until(Duration::from_secs(5), || {
            supervisor
                .snapshot(&id)
                .is_some_and(|s| s.state == SidecarStateKind::Stopped)
        });
        assert!(finished, "expected logger process to exit cleanly");

        let all_ring = supervisor.read_logs(&id, 1000);
        assert_eq!(all_ring.len(), 500, "ring buffer must cap at 500 lines");
        assert!(all_ring.iter().any(|l| l == "line-560"));
        assert!(all_ring.iter().any(|l| l == "[stderr] err-marker-1"));
        assert!(!all_ring.iter().any(|l| l == "line-001"));

        let tail5 = supervisor.read_logs(&id, 5);
        assert_eq!(tail5.len(), 5);

        let disk_log = fs::read_to_string(&snap.log_path).expect("read sidecar.log from disk");
        let disk_lines: Vec<&str> = disk_log.lines().collect();
        assert_eq!(disk_lines.len(), 561);
        assert_eq!(disk_lines.first().copied(), Some("line-001"));
        assert!(disk_lines.contains(&"[stderr] err-marker-1"));
    }

    #[test]
    fn transitions_to_running_when_tcp_listener_accepts_connections() {
        let tmp = TempTestDir::new("tcp-ready");
        let supervisor = SidecarSupervisor::with_data_root(tmp.path.join("roaming"));

        let js = r#"
const net = require('net');
const port = Number(process.env.KITE_SIDECAR_WEB_PORT);
setTimeout(() => {
  const srv = net.createServer((sock) => sock.end());
  srv.listen(port, '127.0.0.1', () => {
    console.log('LISTENING:' + port);
  });
}, 250);
"#;
        let spec = make_spec(
            &tmp.path,
            "ui-plugin",
            "web",
            "node",
            vec!["-e".to_string(), js.to_string()],
            SidecarRestartPolicy::Never,
            true,
        );
        let id = spec.namespaced_id.clone();

        supervisor.sync_plugins(&[make_plugin(spec, true)], false);
        let initial = supervisor.start_sidecar(&id).expect("start ui sidecar");
        assert_eq!(initial.state, SidecarStateKind::Starting);
        let port = initial.upstream_port.expect("upstream port set");

        let became_running = wait_until(Duration::from_secs(6), || {
            supervisor
                .snapshot(&id)
                .is_some_and(|s| s.state == SidecarStateKind::Running)
        });
        assert!(became_running, "expected transition from Starting to Running");
        assert_eq!(supervisor.upstream_port(&id), Some(port));

        supervisor.shutdown_all();
    }

    #[test]
    fn restarts_on_crash_with_exponential_backoff() {
        let tmp = TempTestDir::new("backoff");
        let supervisor = SidecarSupervisor::with_data_root(tmp.path.join("roaming"));

        let js = r#"
const fs = require('fs');
const path = require('path');
const net = require('net');
const markerFile = path.join(process.env.PLUGIN_DATA, 'attempts.txt');
let count = 0;
if (fs.existsSync(markerFile)) {
  count = fs.readFileSync(markerFile, 'utf8').trim().split(/\r?\n/).filter(Boolean).length;
}
count += 1;
fs.appendFileSync(markerFile, count + ':' + Date.now() + '\n');
if (count <= 2) {
  console.error('crash attempt ' + count);
  process.exit(1);
}
const port = Number(process.env.KITE_SIDECAR_WEB_PORT);
net.createServer((s) => s.end()).listen(port, '127.0.0.1');
"#;
        let spec = make_spec(
            &tmp.path,
            "crash-plugin",
            "daemon",
            "node",
            vec!["-e".to_string(), js.to_string()],
            SidecarRestartPolicy::OnFailure,
            true,
        );
        let id = spec.namespaced_id.clone();
        let marker_file = spec.plugin_data.join("attempts.txt");

        let started_at = Instant::now();
        supervisor.sync_plugins(&[make_plugin(spec, true)], false);
        supervisor.start_sidecar(&id).expect("start crashing sidecar");

        let recovered = wait_until(Duration::from_secs(10), || {
            supervisor
                .snapshot(&id)
                .is_some_and(|s| s.state == SidecarStateKind::Running && s.restart_count >= 2)
        });
        let elapsed = started_at.elapsed();
        assert!(recovered, "expected sidecar to recover on attempt 3");
        assert!(
            elapsed >= Duration::from_millis(1_300),
            "expected >= 500ms + 1000ms exponential backoff, got {elapsed:?}"
        );

        let lines: Vec<String> = fs::read_to_string(&marker_file)
            .expect("read attempts marker")
            .lines()
            .map(str::to_string)
            .collect();
        assert_eq!(lines.len(), 3);

        supervisor.shutdown_all();
    }

    #[test]
    fn never_restart_policy_keeps_crashed_state() {
        let tmp = TempTestDir::new("never-restart");
        let supervisor = SidecarSupervisor::with_data_root(tmp.path.join("roaming"));

        let spec = make_spec(
            &tmp.path,
            "oneshot",
            "fail",
            "node",
            vec!["-e".to_string(), "process.exit(2)".to_string()],
            SidecarRestartPolicy::Never,
            false,
        );
        let id = spec.namespaced_id.clone();

        supervisor.sync_plugins(&[make_plugin(spec, true)], false);
        supervisor.start_sidecar(&id).expect("start failing sidecar");

        let crashed = wait_until(Duration::from_secs(5), || {
            supervisor
                .snapshot(&id)
                .is_some_and(|s| s.state == SidecarStateKind::Crashed)
        });
        assert!(crashed, "expected Crashed state");
        let snap = supervisor.snapshot(&id).expect("snapshot");
        assert_eq!(snap.restart_count, 0);
        assert_eq!(snap.pid, None);
        assert_eq!(snap.upstream_port, None);
        assert!(snap.last_error.is_some());
    }

    #[test]
    fn sync_plugins_filters_disabled_and_builtin_and_auto_starts_ui() {
        let tmp = TempTestDir::new("sync");
        let supervisor = SidecarSupervisor::with_data_root(tmp.path.join("roaming"));

        let js = "require('net').createServer(s=>s.end()).listen(Number(process.env.KITE_SIDECAR_WEB_PORT),'127.0.0.1');";
        let enabled_ui = make_spec(
            &tmp.path,
            "enabled-ui",
            "panel",
            "node",
            vec!["-e".to_string(), js.to_string()],
            SidecarRestartPolicy::Never,
            true,
        );
        let enabled_id = enabled_ui.namespaced_id.clone();

        let disabled_ui = make_spec(
            &tmp.path,
            "disabled-ui",
            "panel",
            "node",
            vec!["-e".to_string(), js.to_string()],
            SidecarRestartPolicy::Never,
            true,
        );

        let mut builtin_spec = make_spec(
            &tmp.path,
            "builtin-plugin",
            "internal",
            "node",
            Vec::new(),
            SidecarRestartPolicy::Never,
            true,
        );
        builtin_spec.builtin = Some("native-view".to_string());

        supervisor.sync_plugins(
            &[
                make_plugin(enabled_ui.clone(), true),
                make_plugin(disabled_ui, false),
                make_plugin(builtin_spec, true),
            ],
            true,
        );

        let list = supervisor.list_snapshots();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].namespaced_id, enabled_id);

        let running = wait_until(Duration::from_secs(5), || {
            supervisor
                .snapshot(&enabled_id)
                .is_some_and(|s| s.state == SidecarStateKind::Running)
        });
        assert!(running, "expected auto-started web UI sidecar to run");

        // Disabling the plugin stops and unregisters its sidecar.
        supervisor.sync_plugins(&[make_plugin(enabled_ui, false)], true);
        assert!(supervisor.list_snapshots().is_empty());
        assert_eq!(supervisor.upstream_port(&enabled_id), None);
    }

    #[test]
    fn shutdown_all_kills_parent_and_child_process_tree() {
        let tmp = TempTestDir::new("tree-kill");
        let supervisor = SidecarSupervisor::with_data_root(tmp.path.join("roaming"));

        let js = r#"
const { spawn } = require('child_process');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  stdio: 'ignore'
});
console.log('CHILD_PID=' + child.pid);
setInterval(() => {}, 1000);
"#;
        let spec = make_spec(
            &tmp.path,
            "tree-plugin",
            "parent",
            "node",
            vec!["-e".to_string(), js.to_string()],
            SidecarRestartPolicy::Always,
            false,
        );
        let id = spec.namespaced_id.clone();

        supervisor.sync_plugins(&[make_plugin(spec, true)], false);
        let snap = supervisor.start_sidecar(&id).expect("start tree parent");
        let parent_pid = snap.pid.expect("parent pid");

        let got_child = wait_until(Duration::from_secs(5), || {
            supervisor
                .read_logs(&id, 10)
                .iter()
                .any(|l| l.starts_with("CHILD_PID="))
        });
        assert!(got_child, "expected parent to log grandchild PID");

        let grandchild_pid: u32 = supervisor
            .read_logs(&id, 10)
            .into_iter()
            .find_map(|l| l.strip_prefix("CHILD_PID=").and_then(|s| s.parse().ok()))
            .expect("parse grandchild pid");

        supervisor.shutdown_all();

        let after = supervisor.snapshot(&id).expect("snapshot after shutdown");
        assert_eq!(after.state, SidecarStateKind::Stopped);
        assert_eq!(after.pid, None);
        assert_eq!(after.upstream_port, None);

        #[cfg(windows)]
        {
            let dead = wait_until(Duration::from_secs(3), || {
                !is_pid_alive(parent_pid) && !is_pid_alive(grandchild_pid)
            });
            assert!(
                dead,
                "expected both parent ({parent_pid}) and grandchild ({grandchild_pid}) to be terminated"
            );
        }
        #[cfg(not(windows))]
        let _ = (parent_pid, grandchild_pid);
    }

    #[test]
    fn backoff_schedule_resets_after_30s_uptime() {
        let short = Duration::from_secs(2);
        let (d0, s1) = compute_next_backoff(short, 0);
        let (d1, s2) = compute_next_backoff(short, s1);
        let (d2, s3) = compute_next_backoff(short, s2);
        let (d3, s4) = compute_next_backoff(short, s3);
        let (d4, s5) = compute_next_backoff(short, s4);
        let (d5, s6) = compute_next_backoff(short, s5);

        assert_eq!(d0, Duration::from_millis(500));
        assert_eq!(d1, Duration::from_millis(1_000));
        assert_eq!(d2, Duration::from_millis(2_000));
        assert_eq!(d3, Duration::from_millis(5_000));
        assert_eq!(d4, Duration::from_millis(15_000));
        assert_eq!(d5, Duration::from_millis(15_000));
        assert_eq!(s6, 4);

        let (reset_delay, next_step) = compute_next_backoff(Duration::from_secs(30), s6);
        assert_eq!(reset_delay, Duration::from_millis(500));
        assert_eq!(next_step, 1);
    }

    #[test]
    fn always_restart_policy_restarts_clean_exit_and_stop_restart_lifecycle() {
        let tmp = TempTestDir::new("always-restart");
        let supervisor = SidecarSupervisor::with_data_root(tmp.path.join("roaming"));

        let js = r#"
const fs = require('fs');
const path = require('path');
const net = require('net');
const marker = path.join(process.env.PLUGIN_DATA, 'clean_exits.txt');
let count = 0;
if (fs.existsSync(marker)) {
  count = fs.readFileSync(marker, 'utf8').trim().split(/\r?\n/).filter(Boolean).length;
}
count += 1;
fs.appendFileSync(marker, 'run-' + count + '\n');
if (count === 1) {
  process.exit(0);
}
net.createServer((s) => s.end()).listen(Number(process.env.KITE_SIDECAR_WEB_PORT), '127.0.0.1');
"#;
        let spec = make_spec(
            &tmp.path,
            "always-plugin",
            "web",
            "node",
            vec!["-e".to_string(), js.to_string()],
            SidecarRestartPolicy::Always,
            true,
        );
        let id = spec.namespaced_id.clone();

        let plugins = vec![make_plugin(spec, true)];
        supervisor.sync_plugins(&plugins, false);
        supervisor.start_sidecar(&id).expect("start always sidecar");

        let running = wait_until(Duration::from_secs(6), || {
            supervisor
                .snapshot(&id)
                .is_some_and(|s| s.state == SidecarStateKind::Running && s.restart_count >= 1)
        });
        assert!(running, "Always policy must restart even after exit 0");

        let first_pid = supervisor.snapshot(&id).and_then(|s| s.pid).expect("pid");
        let restarted = supervisor.restart_sidecar(&id).expect("restart sidecar");
        assert_eq!(restarted.restart_count, 0);
        let second_pid = restarted.pid.expect("new pid");
        assert_ne!(first_pid, second_pid);

        let running_again = wait_until(Duration::from_secs(5), || {
            supervisor
                .snapshot(&id)
                .is_some_and(|s| s.state == SidecarStateKind::Running)
        });
        assert!(running_again, "restarted sidecar should become Running");

        let stopped = supervisor.stop_sidecar(&id).expect("stop sidecar");
        assert_eq!(stopped.state, SidecarStateKind::Stopped);
        assert_eq!(stopped.pid, None);

        // Manual stop stays stopped across sync_plugins(..., true).
        supervisor.sync_plugins(&plugins, true);
        assert_eq!(
            supervisor.snapshot(&id).map(|s| s.state),
            Some(SidecarStateKind::Stopped)
        );
    }

    #[test]
    fn global_sidecar_supervisor_is_singleton() {
        let a = global_sidecar_supervisor() as *const SidecarSupervisor;
        let b = global_sidecar_supervisor() as *const SidecarSupervisor;
        assert_eq!(a, b);
    }
}
