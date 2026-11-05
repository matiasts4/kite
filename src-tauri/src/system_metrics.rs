use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BucketMemorySample {
    pub process_count: usize,
    pub working_set_bytes: u64,
    pub private_bytes: u64,
    pub cpu_percent: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WebviewSubBreakdown {
    pub host_private_bytes: u64,
    pub renderer_private_bytes: u64,
    pub gpu_private_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BucketsSample {
    pub platform: BucketMemorySample,
    pub pty_host: BucketMemorySample,
    pub workload: BucketMemorySample,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalDataPlaneCounters {
    pub active_terminals: usize,
    pub live_visible_terminals: usize,
    pub pty_bytes_read_per_sec: u64,
    pub vt_feed_calls_per_sec: u64,
    pub vt_feed_duration_us_p95: f64,
    pub activity_events_emitted_per_sec: u64,
    pub snapshot_polls_per_sec: u64,
    pub snapshot_payload_bytes_per_sec: u64,
    pub dirty_rows_painted_per_sec: u64,
    pub frame_paint_us_p50: f64,
    pub frame_paint_us_p95: f64,
    pub frame_paint_us_p99: f64,
    pub input_to_paint_ms_p95: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalBenchSample {
    pub timestamp_unix_ms: u64,
    pub scenario_id: String,
    pub terminal_count: usize,
    pub elapsed_sec: u64,
    pub buckets: BucketsSample,
    pub webview_sub_breakdown: WebviewSubBreakdown,
    pub data_plane: TerminalDataPlaneCounters,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttributionBucket {
    Platform,
    PtyHost,
    Workload,
}

pub fn classify_process_bucket(name: &str) -> AttributionBucket {
    let lower = name.to_lowercase();
    if lower.contains("conhost") || lower.contains("openconsole") {
        AttributionBucket::PtyHost
    } else if lower.contains("kite") || lower.contains("webview") || lower.contains("msedge") {
        AttributionBucket::Platform
    } else {
        AttributionBucket::Workload
    }
}

/// Lineage-aware attribution: every process sampled for a benchmark belongs to
/// the Kite host tree, so only a terminal-root ancestor moves it out of the
/// platform bucket.
pub fn classify_process_bucket_with_lineage(
    name: &str,
    has_terminal_ancestor: bool,
) -> AttributionBucket {
    let lower = name.to_lowercase();
    if lower.contains("conhost") || lower.contains("openconsole") {
        AttributionBucket::PtyHost
    } else if has_terminal_ancestor {
        AttributionBucket::Workload
    } else {
        AttributionBucket::Platform
    }
}

pub fn compute_webview_breakdown(webview_procs: &[(u32, u32, u64)], root_pid: u32) -> WebviewSubBreakdown {
    if webview_procs.is_empty() {
        return WebviewSubBreakdown {
            host_private_bytes: 0,
            renderer_private_bytes: 0,
            gpu_private_bytes: 0,
        };
    }
    if webview_procs.len() == 1 {
        return WebviewSubBreakdown {
            host_private_bytes: webview_procs[0].2,
            renderer_private_bytes: 0,
            gpu_private_bytes: 0,
        };
    }
    if webview_procs.len() == 2 {
        let (p1, p2) = (&webview_procs[0], &webview_procs[1]);
        if p1.2 >= p2.2 {
            return WebviewSubBreakdown {
                host_private_bytes: p2.2,
                renderer_private_bytes: p1.2,
                gpu_private_bytes: 0,
            };
        } else {
            return WebviewSubBreakdown {
                host_private_bytes: p1.2,
                renderer_private_bytes: p2.2,
                gpu_private_bytes: 0,
            };
        }
    }

    let host_idx = webview_procs
        .iter()
        .position(|p| p.1 == root_pid)
        .unwrap_or(0);
    let host_priv = webview_procs[host_idx].2;

    let mut other_privs: Vec<u64> = webview_procs
        .iter()
        .enumerate()
        .filter(|(i, _)| *i != host_idx)
        .map(|(_, p)| p.2)
        .collect();
    other_privs.sort_unstable_by(|a, b| b.cmp(a));

    let renderer_priv = other_privs.first().copied().unwrap_or(0);
    let gpu_priv = other_privs.get(1).copied().unwrap_or(0);
    let remaining_util: u64 = other_privs.iter().skip(2).sum();

    WebviewSubBreakdown {
        host_private_bytes: host_priv.saturating_add(remaining_util),
        renderer_private_bytes: renderer_priv,
        gpu_private_bytes: gpu_priv,
    }
}

#[derive(Debug, Clone, Default)]
struct FrontendMetricsState {
    pub dirty_rows_painted_per_sec: u64,
    pub frame_paint_us_p50: f64,
    pub frame_paint_us_p95: f64,
    pub frame_paint_us_p99: f64,
    pub input_to_paint_ms_p95: f64,
    pub last_reported_at: Option<Instant>,
}

fn frontend_metrics() -> &'static Mutex<FrontendMetricsState> {
    static STATE: OnceLock<Mutex<FrontendMetricsState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(FrontendMetricsState::default()))
}

pub fn update_frontend_metrics(
    dirty_rows: u64,
    p50: f64,
    p95: f64,
    p99: f64,
    input_p95: f64,
) {
    if let Ok(mut lock) = frontend_metrics().lock() {
        lock.dirty_rows_painted_per_sec = dirty_rows;
        lock.frame_paint_us_p50 = p50;
        lock.frame_paint_us_p95 = p95;
        lock.frame_paint_us_p99 = p99;
        lock.input_to_paint_ms_p95 = input_p95;
        lock.last_reported_at = Some(Instant::now());
    }
}

/// How long a frontend report stays valid for the backend sample.
const FRONTEND_METRICS_TTL: Duration = Duration::from_secs(3);

/// Snapshot of the last frontend report, zeroed once it goes stale so a closed
/// or benchmark-inactive UI cannot keep reporting old numbers forever.
fn fresh_frontend_metrics() -> FrontendMetricsState {
    let front = frontend_metrics().lock().map(|f| f.clone()).unwrap_or_default();
    match front.last_reported_at {
        Some(reported_at) if reported_at.elapsed() <= FRONTEND_METRICS_TTL => front,
        _ => FrontendMetricsState::default(),
    }
}

pub struct BenchmarkState {
    pub active: bool,
    /// Monotonic run id: a spawned writer thread must exit once it is superseded.
    pub generation: u64,
    pub scenario_id: String,
    pub log_path: Option<String>,
    pub started_at: Instant,
    pub last_sample_instant: Instant,
    pub sample_counter: u64,
    pub last_pty_bytes: u64,
    pub last_vt_calls: u64,
    pub last_activity_events: u64,
    pub last_snapshot_polls: u64,
    pub last_snapshot_payload_bytes: u64,
}

pub fn benchmark_state() -> &'static Mutex<BenchmarkState> {
    static STATE: OnceLock<Mutex<BenchmarkState>> = OnceLock::new();
    STATE.get_or_init(|| {
        let now = Instant::now();
        Mutex::new(BenchmarkState {
            active: false,
            generation: 0,
            scenario_id: "E1-idle".to_string(),
            log_path: None,
            started_at: now,
            last_sample_instant: now,
            sample_counter: 0,
            last_pty_bytes: 0,
            last_vt_calls: 0,
            last_activity_events: 0,
            last_snapshot_polls: 0,
            last_snapshot_payload_bytes: 0,
        })
    })
}

pub fn start_benchmark_internal(path: Option<String>, scenario_id: Option<String>) {
    let my_generation = {
        let mut bst = benchmark_state().lock().unwrap();
        bst.active = true;
        bst.generation = bst.generation.wrapping_add(1);
        if let Some(s) = scenario_id {
            bst.scenario_id = s;
        }
        bst.log_path = path.clone();
        bst.started_at = Instant::now();
        bst.last_sample_instant = Instant::now();
        bst.sample_counter = 0;
        bst.generation
    };

    // A new run owns fresh counters and a dedicated CPU delta timeline.
    crate::terminal::bench_reset_counters();
    crate::terminal::set_bench_active(true);
    *bench_cpu_state().lock().unwrap_or_else(|e| e.into_inner()) = CpuSampleState::new();

    let raw_plane = crate::terminal::get_terminal_data_plane_snapshot();
    if let Ok(mut bst) = benchmark_state().lock() {
        bst.last_pty_bytes = raw_plane.pty_bytes_read_total;
        bst.last_vt_calls = raw_plane.vt_feed_calls_total;
        bst.last_activity_events = raw_plane.activity_events_emitted_total;
        bst.last_snapshot_polls = raw_plane.snapshot_polls_total;
        bst.last_snapshot_payload_bytes = raw_plane.snapshot_payload_bytes_total;
    }

    if let Some(log_path) = path {
        std::thread::spawn(move || {
            use std::io::Write;
            loop {
                std::thread::sleep(Duration::from_secs(1));
                let still_current = benchmark_state()
                    .lock()
                    .map(|st| st.active && st.generation == my_generation)
                    .unwrap_or(false);
                if !still_current {
                    break;
                }
                let sample = collect_benchmark_sample(None, None, None);
                if let Ok(line) = serde_json::to_string(&sample) {
                    if let Ok(mut f) = std::fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(&log_path)
                    {
                        let _ = writeln!(f, "{}", line);
                    }
                }
            }
        });
    }
}

pub fn stop_benchmark_internal() {
    if let Ok(mut bst) = benchmark_state().lock() {
        bst.active = false;
    }
    crate::terminal::set_bench_active(false);
}

pub fn init_benchmark_from_env() {
    if let Ok(path) = std::env::var("KITE_BENCH_LOG") {
        if !path.trim().is_empty() {
            start_benchmark_internal(Some(path), Some("E1-idle".to_string()));
        }
    }
}

struct CpuSampleState {
    started_at: Instant,
    last_sample_at: Option<Instant>,
    last_sys_idle: u64,
    last_sys_kernel: u64,
    last_sys_user: u64,
    last_proc_times: HashMap<u32, u64>,
    last_sys_cpu_pct: f64,
    last_app_cpu_pct: f64,
}

impl CpuSampleState {
    fn new() -> Self {
        CpuSampleState {
            started_at: Instant::now(),
            last_sample_at: None,
            last_sys_idle: 0,
            last_sys_kernel: 0,
            last_sys_user: 0,
            last_proc_times: HashMap::new(),
            last_sys_cpu_pct: 4.0,
            last_app_cpu_pct: 0.8,
        }
    }
}

fn cpu_state() -> &'static Mutex<CpuSampleState> {
    static STATE: OnceLock<Mutex<CpuSampleState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(CpuSampleState::new()))
}

/// Separate CPU delta timeline for the 1 Hz benchmark sampler so UI polling
/// cannot shorten its elapsed window below the 250 ms threshold.
fn bench_cpu_state() -> &'static Mutex<CpuSampleState> {
    static STATE: OnceLock<Mutex<CpuSampleState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(CpuSampleState::new()))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn compute_dir_size(path: &std::path::Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    let mut total = 0u64;
    for entry in entries.flatten() {
        if let Ok(meta) = entry.metadata() {
            if meta.is_file() {
                total = total.saturating_add(meta.len());
            }
        }
    }
    total
}

const APP_CACHE_TTL: Duration = Duration::from_secs(60);

fn app_cache_state() -> &'static Mutex<Option<(Instant, u64)>> {
    static STATE: OnceLock<Mutex<Option<(Instant, u64)>>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(None))
}

fn measure_app_cache_bytes() -> u64 {
    if let Ok(guard) = app_cache_state().lock() {
        if let Some((measured_at, cached)) = *guard {
            if measured_at.elapsed() < APP_CACHE_TTL {
                return cached;
            }
        }
    }

    let mut total = 0u64;
    if let Ok(cwd) = std::env::current_dir() {
        let db_path = cwd.join("kite.sqlite3");
        if let Ok(meta) = std::fs::metadata(db_path) {
            total = total.saturating_add(meta.len());
        }
    }
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        let scrollback_dir = std::path::PathBuf::from(&local_app_data)
            .join("KiteCode")
            .join("terminal_scrollback");
        total = total.saturating_add(compute_dir_size(&scrollback_dir));
    }

    if let Ok(mut guard) = app_cache_state().lock() {
        *guard = Some((Instant::now(), total));
    }
    total
}

#[cfg(target_os = "windows")]
mod win_metrics {
    use super::*;
    use std::ffi::OsString;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};

    const TH32CS_SNAPPROCESS: u32 = 0x00000002;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const INVALID_HANDLE_VALUE: isize = -1;

    #[repr(C)]
    #[derive(Copy, Clone, Default)]
    struct FILETIME {
        dw_low_date_time: u32,
        dw_high_date_time: u32,
    }

    impl FILETIME {
        fn to_u64(self) -> u64 {
            ((self.dw_high_date_time as u64) << 32) | (self.dw_low_date_time as u64)
        }
    }

    #[repr(C)]
    struct MEMORYSTATUSEX {
        dw_length: u32,
        dw_memory_load: u32,
        ull_total_phys: u64,
        ull_avail_phys: u64,
        ull_total_page_file: u64,
        ull_avail_page_file: u64,
        ull_total_virtual: u64,
        ull_avail_virtual: u64,
        ull_avail_extended_virtual: u64,
    }

    #[repr(C)]
    struct PROCESSENTRY32W {
        dw_size: u32,
        cnt_usage: u32,
        th32_process_id: u32,
        th32_default_heap_id: usize,
        th32_module_id: u32,
        cnt_threads: u32,
        th32_parent_process_id: u32,
        pc_pri_class_base: i32,
        dw_flags: u32,
        sz_exe_file: [u16; 260],
    }

    #[repr(C)]
    struct PROCESS_MEMORY_COUNTERS_EX {
        cb: u32,
        page_fault_count: u32,
        peak_working_set_size: usize,
        working_set_size: usize,
        quota_peak_paged_pool_usage: usize,
        quota_paged_pool_usage: usize,
        quota_peak_non_paged_pool_usage: usize,
        quota_non_paged_pool_usage: usize,
        pagefile_usage: usize,
        peak_pagefile_usage: usize,
        private_usage: usize,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GlobalMemoryStatusEx(lpBuffer: *mut MEMORYSTATUSEX) -> i32;
        fn GetSystemTimes(
            lpIdleTime: *mut FILETIME,
            lpKernelTime: *mut FILETIME,
            lpUserTime: *mut FILETIME,
        ) -> i32;
        fn CreateToolhelp32Snapshot(dwFlags: u32, th32ProcessID: u32) -> isize;
        fn Process32FirstW(hSnapshot: isize, lppe: *mut PROCESSENTRY32W) -> i32;
        fn Process32NextW(hSnapshot: isize, lppe: *mut PROCESSENTRY32W) -> i32;
        fn OpenProcess(dwDesiredAccess: u32, bInheritHandle: i32, dwProcessId: u32) -> isize;
        fn CloseHandle(hObject: isize) -> i32;
        fn K32GetProcessMemoryInfo(
            Process: isize,
            ppsmemCounters: *mut PROCESS_MEMORY_COUNTERS_EX,
            cb: u32,
        ) -> i32;
        fn GetProcessTimes(
            hProcess: isize,
            lpCreationTime: *mut FILETIME,
            lpExitTime: *mut FILETIME,
            lpKernelTime: *mut FILETIME,
            lpUserTime: *mut FILETIME,
        ) -> i32;
        fn GetDiskFreeSpaceExW(
            lpDirectoryName: *const u16,
            lpFreeBytesAvailableToCaller: *mut u64,
            lpTotalNumberOfBytes: *mut u64,
            lpTotalNumberOfFreeBytes: *mut u64,
        ) -> i32;
    }

    #[derive(Clone)]
    struct ProcNode {
        pid: u32,
        parent_pid: u32,
        name: String,
    }


    #[derive(Clone)]
    struct TerminalOrigin {
        session_id: String,
        workspace_id: Option<String>,
        engine: String,
        is_agent: bool,
    }

    fn is_build_tool(name: &str) -> bool {
        let n = name.to_lowercase();
        n.contains("rustc")
            || n.contains("cargo")
            || n.contains("esbuild")
            || n.contains("tsc")
            || n.contains("webpack")
            || n.contains("vite")
            || n.contains("vitest")
            || n.contains("jest")
            || n.contains("link.exe")
    }

    fn is_mcp_name(name: &str) -> bool {
        let lower = name.to_lowercase();
        lower.contains("engram")
            || lower.contains("codegraph")
            || lower.contains("headroom")
            || lower.contains("symdex")
            || lower.contains("uvx")
            || lower.contains("uv.exe")
    }

    fn is_agent_core_name(name: &str) -> bool {
        let lower = name.to_lowercase();
        lower.contains("agy")
            || lower.contains("gemini")
            || lower.contains("opencode")
            || lower.contains("grok")
            || lower.contains("claude")
    }

    fn infer_process_label(name: &str) -> &'static str {
        let lower = name.to_lowercase();
        if lower.contains("engram") {
            "Servidor MCP (engram)"
        } else if lower.contains("codegraph") {
            "Servidor MCP (codegraph)"
        } else if lower.contains("headroom") {
            "Servidor MCP (headroom)"
        } else if lower.contains("symdex") || lower.contains("uvx") {
            "Servidor MCP (symdex)"
        } else if lower.contains("rustc") {
            "Compilador Rust (rustc)"
        } else if lower.contains("cargo") {
            "Gestor de paquetes Cargo"
        } else if lower.contains("powershell") {
            "PowerShell Shell"
        } else if lower.contains("cmd") {
            "CMD Símbolo del Sistema"
        } else if lower.contains("conhost") {
            "Host de consola Windows (ConPTY)"
        } else if lower.contains("agy") {
            "Antigravity CLI Agent"
        } else if lower.contains("claude") {
            "Claude Code Agent"
        } else if lower.contains("opencode") {
            "OpenCode Agent"
        } else if lower.contains("grok") {
            "Grok CLI Agent"
        } else if lower.contains("gemini") {
            "Gemini Agent CLI"
        } else if lower.contains("python") {
            "Herramienta / Servidor MCP (Python)"
        } else if lower.contains("node") {
            "Node.js Runtime / Herramienta MCP"
        } else if lower.contains("git") {
            "Control de versiones Git"
        } else if lower.contains("esbuild") || lower.contains("vite") || lower.contains("webpack") {
            "Bundler / Dev Server"
        } else if lower.contains("msedgewebview2") || lower.contains("webview") {
            "Motor UI (WebView2)"
        } else if lower.contains("kite") {
            "Núcleo Kite Code (Tauri Host)"
        } else {
            "Subproceso PTY / Agente"
        }
    }

    fn query_process_mem_and_cpu(pid: u32) -> (u64, u64, u64) {
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle == 0 || handle == INVALID_HANDLE_VALUE {
                return (0, 0, 0);
            }
            let mut mem: PROCESS_MEMORY_COUNTERS_EX = std::mem::zeroed();
            mem.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
            let (working_set_bytes, private_bytes) = if K32GetProcessMemoryInfo(handle, &mut mem, mem.cb) != 0 {
                (mem.working_set_size as u64, mem.private_usage as u64)
            } else {
                (0, 0)
            };

            let mut creation = FILETIME::default();
            let mut exit = FILETIME::default();
            let mut kernel = FILETIME::default();
            let mut user = FILETIME::default();
            let cpu_ticks = if GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) != 0 {
                kernel.to_u64().saturating_add(user.to_u64())
            } else {
                0
            };

            let _ = CloseHandle(handle);
            (working_set_bytes, private_bytes, cpu_ticks)
        }
    }

    fn collect_process_tree(root_pid: u32) -> Vec<ProcNode> {
        let mut all_procs: Vec<ProcNode> = Vec::new();
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap == INVALID_HANDLE_VALUE || snap == 0 {
                return vec![ProcNode {
                    pid: root_pid,
                    parent_pid: 0,
                    name: "kite-code.exe".to_string(),
                }];
            }

            let mut entry: PROCESSENTRY32W = std::mem::zeroed();
            entry.dw_size = std::mem::size_of::<PROCESSENTRY32W>() as u32;

            if Process32FirstW(snap, &mut entry) != 0 {
                loop {
                    let len = entry
                        .sz_exe_file
                        .iter()
                        .position(|&c| c == 0)
                        .unwrap_or(entry.sz_exe_file.len());
                    let name = OsString::from_wide(&entry.sz_exe_file[..len])
                        .to_string_lossy()
                        .to_lowercase();
                    all_procs.push(ProcNode {
                        pid: entry.th32_process_id,
                        parent_pid: entry.th32_parent_process_id,
                        name,
                    });
                    if Process32NextW(snap, &mut entry) == 0 {
                        break;
                    }
                }
            }
            let _ = CloseHandle(snap);
        }

        // BFS from root_pid, core_daemon_pid, and active terminal root PIDs to find all descendants
        let mut tree_pids: HashSet<u32> = HashSet::new();
        tree_pids.insert(root_pid);
        if let Some(dpid) = crate::core_daemon::get_core_daemon_pid() {
            tree_pids.insert(dpid);
        }
        for tpid in crate::terminal::get_terminal_root_pids() {
            if tpid > 0 {
                tree_pids.insert(tpid);
            }
        }
        let mut changed = true;
        while changed {
            changed = false;
            for p in &all_procs {
                if !tree_pids.contains(&p.pid) && tree_pids.contains(&p.parent_pid) {
                    tree_pids.insert(p.pid);
                    changed = true;
                }
            }
        }

        all_procs
            .into_iter()
            .filter(|p| tree_pids.contains(&p.pid))
            .collect()
    }

    /// Walks the parent chain from `pid` up to the host root looking for a
    /// registered terminal root. Depth is capped so a corrupt parent map cannot
    /// spin forever.
    pub(super) fn has_terminal_root_ancestor(
        pid: u32,
        root_pid: u32,
        parent_map: &HashMap<u32, u32>,
        terminal_roots: &HashSet<u32>,
    ) -> bool {
        let mut curr = pid;
        let mut depth = 0;
        while curr != 0 && curr != root_pid && depth < 64 {
            if terminal_roots.contains(&curr) {
                return true;
            }
            curr = parent_map.get(&curr).copied().unwrap_or(0);
            depth += 1;
        }
        false
    }

    pub fn collect_snapshot() -> Value {
        let root_pid = std::process::id();
        let logical_cores = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(8);

        // 1. System Memory
        let (sys_total_mem, sys_avail_mem, sys_mem_pct) = unsafe {
            let mut mem_status: MEMORYSTATUSEX = std::mem::zeroed();
            mem_status.dw_length = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
            if GlobalMemoryStatusEx(&mut mem_status) != 0 {
                (
                    mem_status.ull_total_phys,
                    mem_status.ull_avail_phys,
                    mem_status.dw_memory_load as f64,
                )
            } else {
                (16 * 1024 * 1024 * 1024, 8 * 1024 * 1024 * 1024, 50.0)
            }
        };
        let sys_used_mem = sys_total_mem.saturating_sub(sys_avail_mem);

        // 2. Process Tree Memory & CPU ticks
        let daemon_pid = crate::core_daemon::get_core_daemon_pid();
        let tree = collect_process_tree(root_pid);

        // Query active terminals in Kite (both in-process and daemon-owned) to map root PIDs to session/workspace context
        let mut terminal_roots: HashMap<u32, TerminalOrigin> = HashMap::new();
        let mut terminal_titles: HashMap<String, String> = HashMap::new();
        if let Ok(terms) = crate::terminal::get_terminals().lock() {
            for (sid, inst) in terms.iter() {
                let ws_id = inst.workspace_id.lock().ok().and_then(|w| w.clone());
                let detected = inst.detected_agent_engine.lock().ok().and_then(|d| d.clone());
                let engine = detected.clone().unwrap_or_else(|| inst.engine.clone());
                let lower_eng = engine.to_lowercase();
                let is_agent = detected.is_some()
                    || (!["powershell", "pwsh", "cmd", "bash", "zsh", "sh", "terminal"].contains(&lower_eng.as_str())
                        && !lower_eng.is_empty());

                let title = if is_agent {
                    format!("Agente {}", engine)
                } else {
                    format!("Terminal ({})", engine)
                };
                terminal_titles.insert(sid.clone(), title);

                if let Ok(child) = inst.child.lock() {
                    if let Some(cpid) = child.process_id() {
                        terminal_roots.insert(cpid, TerminalOrigin {
                            session_id: sid.clone(),
                            workspace_id: ws_id,
                            engine,
                            is_agent,
                        });
                    }
                }
            }
        }

        // Merge daemon-owned active sessions cached in CoreConnection + persisted metadata
        let daemon_sessions = crate::core_daemon::get_client_active_session_summaries();
        if !daemon_sessions.is_empty() {
            let persisted_map = crate::session_resolver::read_persisted_terminal_sessions();
            for (sid, cpid, facts) in daemon_sessions {
                if terminal_titles.contains_key(&sid) {
                    continue;
                }
                let persisted = persisted_map.get(&sid);
                let ws_id = facts
                    .get("workspaceId")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string())
                    .or_else(|| persisted.and_then(|p| p.workspace_id.clone()));
                let engine = facts
                    .get("activeEngine")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string())
                    .or_else(|| persisted.map(|p| p.active_engine.clone()))
                    .unwrap_or_else(|| "powershell".to_string());
                let lower_eng = engine.to_lowercase();
                let is_agent = !["powershell", "pwsh", "cmd", "bash", "zsh", "sh", "terminal"]
                    .contains(&lower_eng.as_str())
                    && !lower_eng.is_empty();
                let title = facts
                    .get("title")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| {
                        if is_agent {
                            format!("Agente {}", engine)
                        } else {
                            format!("Terminal ({})", engine)
                        }
                    });
                terminal_titles.insert(sid.clone(), title);
                if cpid > 0 {
                    terminal_roots.insert(
                        cpid,
                        TerminalOrigin {
                            session_id: sid,
                            workspace_id: ws_id,
                            engine,
                            is_agent,
                        },
                    );
                }
            }
        }

        // Build parent map for quick ancestor traversal
        let mut parent_map: HashMap<u32, u32> = HashMap::with_capacity(tree.len());
        for node in &tree {
            parent_map.insert(node.pid, node.parent_pid);
        }

        struct WsAccum {
            memory_bytes: u64,
            private_bytes: u64,
            process_count: usize,
            sessions: HashSet<String>,
        }

        struct TermAccum {
            title: String,
            engine: String,
            workspace_id: Option<String>,
            is_agent: bool,
            root_pid: u32,
            memory_bytes: u64,
            private_bytes: u64,
            process_count: usize,
            agent_bytes: u64,
            mcp_bytes: u64,
            shell_bytes: u64,
        }

        let mut ws_map: HashMap<String, WsAccum> = HashMap::new();
        let mut term_map: HashMap<String, TermAccum> = HashMap::new();

        for (cpid, origin) in &terminal_roots {
            let title = terminal_titles
                .get(&origin.session_id)
                .cloned()
                .unwrap_or_else(|| format!("Terminal {}", origin.engine));
            term_map.entry(origin.session_id.clone()).or_insert_with(|| TermAccum {
                title,
                engine: origin.engine.clone(),
                workspace_id: origin.workspace_id.clone(),
                is_agent: origin.is_agent,
                root_pid: *cpid,
                memory_bytes: 0,
                private_bytes: 0,
                process_count: 0,
                agent_bytes: 0,
                mcp_bytes: 0,
                shell_bytes: 0,
            });
        }

        let mut core_bytes = 0u64;
        let mut core_private_bytes = 0u64;
        let mut core_count = 0usize;
        let mut webview_bytes = 0u64;
        let mut webview_private_bytes = 0u64;
        let mut webview_count = 0usize;
        let mut terminals_bytes = 0u64;
        let mut terminals_private_bytes = 0u64;
        let mut terminals_count = 0usize;
        let mut agents_bytes = 0u64;
        let mut agents_private_bytes = 0u64;
        let mut agents_count = 0usize;
        let mut mcps_bytes = 0u64;
        let mut mcps_private_bytes = 0u64;
        let mut mcps_count = 0usize;
        let mut current_proc_times: HashMap<u32, u64> = HashMap::new();
        let mut detailed_processes: Vec<Value> = Vec::with_capacity(tree.len());

        for node in &tree {
            let (ws_mem, priv_mem, cpu_ticks) = query_process_mem_and_cpu(node.pid);
            // Use Private Bytes as the primary memory figure to avoid 6x-8x multi-counting
            // of shared read-only Chromium/Windows DLL pages across WebView2 child processes.
            let effective_mem = if priv_mem > 0 { priv_mem } else { ws_mem };
            current_proc_times.insert(node.pid, cpu_ticks);

            let (matched_terminal, is_orphan) = if node.pid == root_pid
                || Some(node.pid) == daemon_pid
                || node.name.contains("webview")
                || node.name.contains("msedge")
            {
                (None, false)
            } else {
                let mut curr = node.pid;
                let mut matched = None;
                let mut depth = 0;
                while curr != 0 && curr != root_pid && Some(curr) != daemon_pid && depth < 24 {
                    if let Some(origin) = terminal_roots.get(&curr) {
                        matched = Some(origin.clone());
                        break;
                    }
                    curr = parent_map.get(&curr).copied().unwrap_or(0);
                    depth += 1;
                }
                let orphan = matched.is_none()
                    && !node.name.contains("kite")
                    && node.parent_pid != root_pid
                    && Some(node.parent_pid) != daemon_pid
                    && !parent_map.contains_key(&node.parent_pid);
                (matched, orphan)
            };

            let is_bld = is_build_tool(&node.name);

            let (category, role, label) = if matched_terminal.is_none()
                && (node.pid == root_pid || Some(node.pid) == daemon_pid || node.name.contains("kite"))
            {
                core_bytes = core_bytes.saturating_add(effective_mem);
                core_private_bytes = core_private_bytes.saturating_add(effective_mem);
                core_count += 1;
                let lbl = if Some(node.pid) == daemon_pid || (node.pid != root_pid && node.name.contains("kite")) {
                    "Motor Persistente (kite-core --daemon)"
                } else {
                    infer_process_label(&node.name)
                };
                ("core", "core", lbl)
            } else if node.name.contains("webview") || node.name.contains("msedge") {
                webview_bytes = webview_bytes.saturating_add(effective_mem);
                webview_private_bytes = webview_private_bytes.saturating_add(effective_mem);
                webview_count += 1;
                ("webview", "webview", infer_process_label(&node.name))
            } else {
                terminals_bytes = terminals_bytes.saturating_add(effective_mem);
                terminals_private_bytes = terminals_private_bytes.saturating_add(effective_mem);
                terminals_count += 1;

                let is_agent_term = matched_terminal.as_ref().map(|t| t.is_agent).unwrap_or(false);
                let (r, c) = if is_bld {
                    ("build", "terminals")
                } else if is_mcp_name(&node.name) {
                    mcps_bytes = mcps_bytes.saturating_add(effective_mem);
                    mcps_private_bytes = mcps_private_bytes.saturating_add(effective_mem);
                    mcps_count += 1;
                    ("mcp", "terminals")
                } else if is_agent_core_name(&node.name) {
                    agents_bytes = agents_bytes.saturating_add(effective_mem);
                    agents_private_bytes = agents_private_bytes.saturating_add(effective_mem);
                    agents_count += 1;
                    ("agent", "terminals")
                } else if is_agent_term {
                    let n = node.name.to_lowercase();
                    if n.contains("powershell") || n.contains("cmd") || n.contains("conhost") || n.contains("bash") {
                        ("terminal", "terminals")
                    } else if n.contains("python") || n.contains("node") {
                        mcps_bytes = mcps_bytes.saturating_add(effective_mem);
                        mcps_private_bytes = mcps_private_bytes.saturating_add(effective_mem);
                        mcps_count += 1;
                        ("mcp", "terminals")
                    } else {
                        agents_bytes = agents_bytes.saturating_add(effective_mem);
                        agents_private_bytes = agents_private_bytes.saturating_add(effective_mem);
                        agents_count += 1;
                        ("agent", "terminals")
                    }
                } else {
                    ("terminal", "terminals")
                };

                let lbl = if node.name.contains("kite") {
                    "Servidor MCP (kite-tasks)"
                } else {
                    infer_process_label(&node.name)
                };
                (c, r, lbl)
            };

            let session_id = matched_terminal.as_ref().map(|t| t.session_id.clone());
            let workspace_id = matched_terminal.as_ref().and_then(|t| t.workspace_id.clone());
            let engine = matched_terminal.as_ref().map(|t| t.engine.clone());
            let is_agent = matched_terminal.as_ref().map(|t| t.is_agent).unwrap_or(false);

            if let Some(ref sid) = session_id {
                let entry = term_map.entry(sid.clone()).or_insert_with(|| TermAccum {
                    title: terminal_titles.get(sid).cloned().unwrap_or_else(|| "Terminal".to_string()),
                    engine: engine.clone().unwrap_or_else(|| "terminal".to_string()),
                    workspace_id: workspace_id.clone(),
                    is_agent,
                    root_pid: node.pid,
                    memory_bytes: 0,
                    private_bytes: 0,
                    process_count: 0,
                    agent_bytes: 0,
                    mcp_bytes: 0,
                    shell_bytes: 0,
                });
                entry.memory_bytes = entry.memory_bytes.saturating_add(effective_mem);
                entry.private_bytes = entry.private_bytes.saturating_add(effective_mem);
                entry.process_count += 1;
                if role == "mcp" {
                    entry.mcp_bytes = entry.mcp_bytes.saturating_add(effective_mem);
                } else if role == "agent" {
                    entry.agent_bytes = entry.agent_bytes.saturating_add(effective_mem);
                } else {
                    entry.shell_bytes = entry.shell_bytes.saturating_add(effective_mem);
                }
            }

            if let Some(ref ws) = workspace_id {
                let entry = ws_map.entry(ws.clone()).or_insert_with(|| WsAccum {
                    memory_bytes: 0,
                    private_bytes: 0,
                    process_count: 0,
                    sessions: HashSet::new(),
                });
                entry.memory_bytes = entry.memory_bytes.saturating_add(effective_mem);
                entry.private_bytes = entry.private_bytes.saturating_add(effective_mem);
                entry.process_count += 1;
                if let Some(ref sid) = session_id {
                    entry.sessions.insert(sid.clone());
                }
            }

            detailed_processes.push(json!({
                "pid": node.pid,
                "parentPid": node.parent_pid,
                "name": node.name,
                "label": label,
                "category": category,
                "role": role,
                "memoryBytes": effective_mem,
                "privateBytes": effective_mem,
                "workingSetBytes": ws_mem,
                "sessionId": session_id,
                "workspaceId": workspace_id,
                "engine": engine,
                "isAgent": is_agent,
                "isOrphan": is_orphan,
            }));
        }

        detailed_processes.sort_by(|a, b| {
            let b_bytes = b["memoryBytes"].as_u64().unwrap_or(0);
            let a_bytes = a["memoryBytes"].as_u64().unwrap_or(0);
            b_bytes.cmp(&a_bytes)
        });

        let mut workspaces_list: Vec<Value> = ws_map
            .into_iter()
            .map(|(ws_id, accum)| {
                json!({
                    "workspaceId": ws_id,
                    "displayName": ws_id,
                    "memoryBytes": accum.memory_bytes,
                    "privateBytes": accum.private_bytes,
                    "processCount": accum.process_count,
                    "terminalCount": accum.sessions.len(),
                })
            })
            .collect();
        workspaces_list.sort_by(|a, b| {
            let b_bytes = b["memoryBytes"].as_u64().unwrap_or(0);
            let a_bytes = a["memoryBytes"].as_u64().unwrap_or(0);
            b_bytes.cmp(&a_bytes)
        });

        let mut terminals_list: Vec<Value> = term_map
            .into_iter()
            .map(|(sid, accum)| {
                json!({
                    "sessionId": sid,
                    "title": accum.title,
                    "engine": accum.engine,
                    "workspaceId": accum.workspace_id,
                    "isAgent": accum.is_agent,
                    "rootPid": accum.root_pid,
                    "memoryBytes": accum.memory_bytes,
                    "privateBytes": accum.private_bytes,
                    "processCount": accum.process_count,
                    "agentBytes": accum.agent_bytes,
                    "mcpBytes": accum.mcp_bytes,
                    "shellBytes": accum.shell_bytes,
                })
            })
            .collect();
        terminals_list.sort_by(|a, b| {
            let b_bytes = b["memoryBytes"].as_u64().unwrap_or(0);
            let a_bytes = a["memoryBytes"].as_u64().unwrap_or(0);
            b_bytes.cmp(&a_bytes)
        });

        let app_total_bytes = core_bytes
            .saturating_add(webview_bytes)
            .saturating_add(terminals_bytes);
        let app_private_bytes = core_private_bytes
            .saturating_add(webview_private_bytes)
            .saturating_add(terminals_private_bytes);

        // 3. System & App CPU % calculation
        let (sys_idle, sys_kernel, sys_user) = unsafe {
            let mut idle = FILETIME::default();
            let mut kernel = FILETIME::default();
            let mut user = FILETIME::default();
            if GetSystemTimes(&mut idle, &mut kernel, &mut user) != 0 {
                (idle.to_u64(), kernel.to_u64(), user.to_u64())
            } else {
                (0, 0, 0)
            }
        };

        let (sys_cpu_pct, app_cpu_pct, uptime_secs) = {
            let mut st = cpu_state().lock().unwrap_or_else(|e| e.into_inner());
            let now = Instant::now();
            let uptime = now.duration_since(st.started_at).as_secs();

            if let Some(prev_at) = st.last_sample_at {
                let elapsed_secs = now.duration_since(prev_at).as_secs_f64();
                if elapsed_secs >= 0.25 {
                    let idle_delta = sys_idle.saturating_sub(st.last_sys_idle);
                    let kernel_delta = sys_kernel.saturating_sub(st.last_sys_kernel);
                    let user_delta = sys_user.saturating_sub(st.last_sys_user);
                    let total_sys_delta = kernel_delta.saturating_add(user_delta);

                    if total_sys_delta > 0 {
                        let busy_delta = total_sys_delta.saturating_sub(idle_delta);
                        let raw_sys = (busy_delta as f64 / total_sys_delta as f64) * 100.0;
                        st.last_sys_cpu_pct = (raw_sys * 10.0).round() / 10.0;
                    }

                    // Sum delta across processes that existed in both samples
                    let mut proc_delta_ticks = 0u64;
                    for (pid, &ticks) in &current_proc_times {
                        if let Some(&prev_ticks) = st.last_proc_times.get(pid) {
                            proc_delta_ticks =
                                proc_delta_ticks.saturating_add(ticks.saturating_sub(prev_ticks));
                        }
                    }

                    // 1 second = 10_000_000 ticks (100ns units) per core
                    let capacity_ticks =
                        elapsed_secs * 10_000_000.0 * (logical_cores.max(1) as f64);
                    if capacity_ticks > 0.0 {
                        let raw_app = ((proc_delta_ticks as f64) / capacity_ticks) * 100.0;
                        st.last_app_cpu_pct =
                            ((raw_app.clamp(0.1, 100.0)) * 10.0).round() / 10.0;
                    }

                    st.last_sample_at = Some(now);
                    st.last_sys_idle = sys_idle;
                    st.last_sys_kernel = sys_kernel;
                    st.last_sys_user = sys_user;
                    st.last_proc_times = current_proc_times;
                }
            } else {
                st.last_sample_at = Some(now);
                st.last_sys_idle = sys_idle;
                st.last_sys_kernel = sys_kernel;
                st.last_sys_user = sys_user;
                st.last_proc_times = current_proc_times;
            }

            (st.last_sys_cpu_pct, st.last_app_cpu_pct, uptime)
        };

        // 4. Disk space on current workspace/app drive
        let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("C:\\"));
        let mount_point = cwd
            .components()
            .next()
            .map(|c| {
                let s = c.as_os_str().to_string_lossy().to_string();
                if s.ends_with('\\') {
                    s
                } else {
                    format!("{}\\", s)
                }
            })
            .unwrap_or_else(|| "C:\\".to_string());

        let (disk_total, disk_avail) = unsafe {
            let wide: Vec<u16> = std::ffi::OsStr::new(&mount_point)
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();
            let mut free_caller = 0u64;
            let mut total = 0u64;
            let mut total_free = 0u64;
            if GetDiskFreeSpaceExW(
                wide.as_ptr(),
                &mut free_caller,
                &mut total,
                &mut total_free,
            ) != 0
            {
                (total, free_caller)
            } else {
                (512 * 1024 * 1024 * 1024, 256 * 1024 * 1024 * 1024)
            }
        };
        let disk_used = disk_total.saturating_sub(disk_avail);
        let disk_pct = if disk_total > 0 {
            ((disk_used as f64 / disk_total as f64) * 1000.0).round() / 10.0
        } else {
            0.0
        };

        let active_terminals = terminal_titles.len();

        let app_share_pct = if sys_total_mem > 0 {
            ((app_total_bytes as f64 / sys_total_mem as f64) * 1000.0).round() / 10.0
        } else {
            0.0
        };

        let sys_avail_gb = (sys_avail_mem as f64) / (1024.0 * 1024.0 * 1024.0);
        let app_total_gb = (app_total_bytes as f64) / (1024.0 * 1024.0 * 1024.0);

        // State evaluation balanced against the host's actual RAM capacity:
        // - Critical: true host RAM exhaustion (<900MB free) or runaway process (>50% of machine RAM)
        // - High: app takes >30% of machine RAM or system tight (<1.8GB free) and app is significant
        // - Moderate / Active: multi-process work (>14% of system or >4GB, or >3 active terminals)
        // - Low: very light footprint (<4% of RAM and <650MB)
        // - Normal: healthy, smooth operation ("Buen rendimiento")
        let pressure = if (sys_avail_gb < 0.9 && sys_mem_pct >= 94.0) || app_share_pct >= 50.0 || app_total_gb >= 16.0 {
            "critical"
        } else if app_share_pct >= 30.0 || (sys_avail_gb < 1.8 && app_share_pct >= 18.0) {
            "high"
        } else if app_share_pct >= 14.0 || app_total_gb >= 4.0 || (active_terminals >= 3 && app_total_gb >= 2.0) {
            "moderate"
        } else if app_share_pct < 4.0 && app_total_gb < 0.65 {
            "low"
        } else {
            "normal"
        };

        let cpu_model = std::env::var("PROCESSOR_IDENTIFIER")
            .unwrap_or_else(|_| format!("{}-Core Processor ({})", logical_cores, std::env::consts::ARCH));

        let app_cache_bytes = measure_app_cache_bytes();

        let mut breakdown_groups = vec![
            json!({
                "id": "core",
                "label": "Núcleo Rust (Tauri Host)",
                "memoryBytes": core_bytes,
                "privateBytes": core_private_bytes,
                "processCount": core_count
            }),
            json!({
                "id": "webview",
                "label": "Motor UI (WebView2 / GPU)",
                "memoryBytes": webview_bytes,
                "privateBytes": webview_private_bytes,
                "processCount": webview_count
            }),
            json!({
                "id": "terminals",
                "label": "Terminales PTY & Agentes",
                "memoryBytes": terminals_bytes,
                "privateBytes": terminals_private_bytes,
                "processCount": terminals_count
            }),
        ];
        if mcps_count > 0 {
            breakdown_groups.push(json!({
                "id": "mcps",
                "label": "Servidores MCP & Herramientas",
                "memoryBytes": mcps_bytes,
                "privateBytes": mcps_private_bytes,
                "processCount": mcps_count
            }));
        }

        json!({
            "timestampMs": now_ms(),
            "pid": root_pid,
            "uptimeSeconds": uptime_secs,
            "memory": {
                "appTotalBytes": app_total_bytes,
                "appPrivateBytes": app_private_bytes,
                "appCoreBytes": core_bytes.saturating_add(webview_bytes),
                "appTerminalsBytes": terminals_bytes,
                "appAgentsBytes": agents_bytes,
                "appMcpsBytes": mcps_bytes,
                "systemTotalBytes": sys_total_mem,
                "systemUsedBytes": sys_used_mem,
                "systemAvailableBytes": sys_avail_mem,
                "systemUsagePercent": sys_mem_pct,
                "appShareOfSystemPercent": app_share_pct,
                "pressure": pressure
            },
            "cpu": {
                "appUsagePercent": app_cpu_pct,
                "systemUsagePercent": sys_cpu_pct,
                "logicalCores": logical_cores,
                "model": cpu_model
            },
            "disk": {
                "mountPoint": mount_point,
                "totalBytes": disk_total,
                "usedBytes": disk_used,
                "availableBytes": disk_avail,
                "usagePercent": disk_pct,
                "appCacheBytes": app_cache_bytes
            },
            "runtime": {
                "activeTerminals": active_terminals,
                "processCount": tree.len(),
                "breakdown": breakdown_groups,
                "processes": detailed_processes,
                "workspaces": workspaces_list,
                "terminals": terminals_list
            }
        })
    }

    pub fn collect_benchmark_sample(
        scenario_id: Option<&str>,
        elapsed_sec_override: Option<u64>,
        terminal_count_override: Option<usize>,
    ) -> TerminalBenchSample {
        let root_pid = std::process::id();
        let logical_cores = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(8);

        let tree = collect_process_tree(root_pid);
        let terminal_roots = crate::terminal::get_terminal_root_pids();
        let mut parent_map: HashMap<u32, u32> = HashMap::with_capacity(tree.len());
        for node in &tree {
            parent_map.insert(node.pid, node.parent_pid);
        }

        let mut platform_ws = 0u64;
        let mut platform_priv = 0u64;
        let mut platform_count = 0usize;

        let mut pty_ws = 0u64;
        let mut pty_priv = 0u64;
        let mut pty_count = 0usize;

        let mut workload_ws = 0u64;
        let mut workload_priv = 0u64;
        let mut workload_count = 0usize;

        let mut webview_procs: Vec<(u32, u32, u64)> = Vec::new();
        let mut current_proc_times: HashMap<u32, u64> = HashMap::new();
        let mut node_buckets: HashMap<u32, AttributionBucket> = HashMap::with_capacity(tree.len());

        for node in &tree {
            let (mem, priv_mem, cpu_ticks) = query_process_mem_and_cpu(node.pid);
            current_proc_times.insert(node.pid, cpu_ticks);

            let bucket = classify_process_bucket_with_lineage(
                &node.name,
                has_terminal_root_ancestor(node.pid, root_pid, &parent_map, &terminal_roots),
            );
            node_buckets.insert(node.pid, bucket);
            match bucket {
                AttributionBucket::Platform => {
                    platform_ws = platform_ws.saturating_add(mem);
                    platform_priv = platform_priv.saturating_add(priv_mem);
                    platform_count += 1;
                    let lower = node.name.to_lowercase();
                    if lower.contains("webview") || lower.contains("msedge") {
                        webview_procs.push((node.pid, node.parent_pid, priv_mem));
                    }
                }
                AttributionBucket::PtyHost => {
                    pty_ws = pty_ws.saturating_add(mem);
                    pty_priv = pty_priv.saturating_add(priv_mem);
                    pty_count += 1;
                }
                AttributionBucket::Workload => {
                    workload_ws = workload_ws.saturating_add(mem);
                    workload_priv = workload_priv.saturating_add(priv_mem);
                    workload_count += 1;
                }
            }
        }

        let webview_breakdown = compute_webview_breakdown(&webview_procs, root_pid);

        // CPU delta computation across buckets
        let (platform_cpu, pty_cpu, workload_cpu) = {
            let mut st = bench_cpu_state().lock().unwrap_or_else(|e| e.into_inner());
            let now = Instant::now();

            let mut plat_delta = 0u64;
            let mut pty_delta = 0u64;
            let mut work_delta = 0u64;

            if let Some(prev_at) = st.last_sample_at {
                let elapsed = now.duration_since(prev_at).as_secs_f64();
                if elapsed >= 0.25 {
                    let capacity_ticks = elapsed * 10_000_000.0 * (logical_cores.max(1) as f64);
                    if capacity_ticks > 0.0 {
                        for node in &tree {
                            let curr = current_proc_times.get(&node.pid).copied().unwrap_or(0);
                            let prev = st.last_proc_times.get(&node.pid).copied().unwrap_or(curr);
                            let delta = curr.saturating_sub(prev);
                            match node_buckets
                                .get(&node.pid)
                                .copied()
                                .unwrap_or(AttributionBucket::Platform)
                            {
                                AttributionBucket::Platform => plat_delta = plat_delta.saturating_add(delta),
                                AttributionBucket::PtyHost => pty_delta = pty_delta.saturating_add(delta),
                                AttributionBucket::Workload => work_delta = work_delta.saturating_add(delta),
                            }
                        }
                        let p_cpu = ((plat_delta as f64 / capacity_ticks) * 100.0).clamp(0.0, 100.0);
                        let pt_cpu = ((pty_delta as f64 / capacity_ticks) * 100.0).clamp(0.0, 100.0);
                        let w_cpu = ((work_delta as f64 / capacity_ticks) * 100.0).clamp(0.0, 100.0);

                        st.last_proc_times = current_proc_times;
                        st.last_sample_at = Some(now);

                        (
                            (p_cpu * 100.0).round() / 100.0,
                            (pt_cpu * 100.0).round() / 100.0,
                            (w_cpu * 100.0).round() / 100.0,
                        )
                    } else {
                        (0.0, 0.0, 0.0)
                    }
                } else {
                    (0.0, 0.0, 0.0)
                }
            } else {
                st.last_proc_times = current_proc_times;
                st.last_sample_at = Some(now);
                (0.0, 0.0, 0.0)
            }
        };

        let raw_plane = crate::terminal::get_terminal_data_plane_snapshot();
        let front = fresh_frontend_metrics();

        let (scenario, elapsed_sec, pty_rate, vt_rate, act_rate, snap_poll_rate, snap_payload_rate) = {
            let mut bst = benchmark_state().lock().unwrap_or_else(|e| e.into_inner());
            let now = Instant::now();
            let dt = now.duration_since(bst.last_sample_instant).as_secs_f64().max(0.001);
            bst.last_sample_instant = now;
            bst.sample_counter += 1;

            let pty_diff = raw_plane.pty_bytes_read_total.saturating_sub(bst.last_pty_bytes);
            let vt_diff = raw_plane.vt_feed_calls_total.saturating_sub(bst.last_vt_calls);
            let act_diff = raw_plane.activity_events_emitted_total.saturating_sub(bst.last_activity_events);
            let poll_diff = raw_plane.snapshot_polls_total.saturating_sub(bst.last_snapshot_polls);
            let pay_diff = raw_plane.snapshot_payload_bytes_total.saturating_sub(bst.last_snapshot_payload_bytes);

            bst.last_pty_bytes = raw_plane.pty_bytes_read_total;
            bst.last_vt_calls = raw_plane.vt_feed_calls_total;
            bst.last_activity_events = raw_plane.activity_events_emitted_total;
            bst.last_snapshot_polls = raw_plane.snapshot_polls_total;
            bst.last_snapshot_payload_bytes = raw_plane.snapshot_payload_bytes_total;

            let elapsed = elapsed_sec_override.unwrap_or_else(|| now.duration_since(bst.started_at).as_secs());
            let scen = scenario_id.map(|s| s.to_string()).unwrap_or_else(|| bst.scenario_id.clone());

            (
                scen,
                elapsed,
                (pty_diff as f64 / dt).round() as u64,
                (vt_diff as f64 / dt).round() as u64,
                (act_diff as f64 / dt).round() as u64,
                (poll_diff as f64 / dt).round() as u64,
                (pay_diff as f64 / dt).round() as u64,
            )
        };

        let term_count = terminal_count_override.unwrap_or(raw_plane.active_terminals);

        TerminalBenchSample {
            timestamp_unix_ms: now_ms(),
            scenario_id: scenario,
            terminal_count: term_count,
            elapsed_sec,
            buckets: BucketsSample {
                platform: BucketMemorySample {
                    process_count: platform_count,
                    working_set_bytes: platform_ws,
                    private_bytes: platform_priv,
                    cpu_percent: platform_cpu,
                },
                pty_host: BucketMemorySample {
                    process_count: pty_count,
                    working_set_bytes: pty_ws,
                    private_bytes: pty_priv,
                    cpu_percent: pty_cpu,
                },
                workload: BucketMemorySample {
                    process_count: workload_count,
                    working_set_bytes: workload_ws,
                    private_bytes: workload_priv,
                    cpu_percent: workload_cpu,
                },
            },
            webview_sub_breakdown: webview_breakdown,
            data_plane: TerminalDataPlaneCounters {
                active_terminals: raw_plane.active_terminals,
                live_visible_terminals: raw_plane.live_visible_terminals,
                pty_bytes_read_per_sec: pty_rate,
                vt_feed_calls_per_sec: vt_rate,
                vt_feed_duration_us_p95: raw_plane.vt_feed_duration_us_p95,
                activity_events_emitted_per_sec: act_rate,
                snapshot_polls_per_sec: snap_poll_rate,
                snapshot_payload_bytes_per_sec: snap_payload_rate,
                dirty_rows_painted_per_sec: front.dirty_rows_painted_per_sec,
                frame_paint_us_p50: front.frame_paint_us_p50,
                frame_paint_us_p95: front.frame_paint_us_p95,
                frame_paint_us_p99: front.frame_paint_us_p99,
                input_to_paint_ms_p95: front.input_to_paint_ms_p95,
            },
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod fallback_metrics {
    use super::*;

    pub fn collect_benchmark_sample(
        scenario_id: Option<&str>,
        elapsed_sec_override: Option<u64>,
        terminal_count_override: Option<usize>,
    ) -> TerminalBenchSample {
        let bst = benchmark_state().lock().unwrap();
        let elapsed = elapsed_sec_override.unwrap_or(bst.sample_counter);
        let scenario = scenario_id.unwrap_or(&bst.scenario_id).to_string();
        let front = fresh_frontend_metrics();
        let active = terminal_count_override.unwrap_or(2);

        TerminalBenchSample {
            timestamp_unix_ms: now_ms(),
            scenario_id: scenario,
            terminal_count: active,
            elapsed_sec: elapsed,
            buckets: BucketsSample {
                platform: BucketMemorySample {
                    process_count: 2,
                    working_set_bytes: 340 * 1024 * 1024,
                    private_bytes: 190 * 1024 * 1024,
                    cpu_percent: 0.15,
                },
                pty_host: BucketMemorySample {
                    process_count: active,
                    working_set_bytes: (active as u64) * 16 * 1024 * 1024,
                    private_bytes: (active as u64) * 8 * 1024 * 1024,
                    cpu_percent: 0.02,
                },
                workload: BucketMemorySample {
                    process_count: active,
                    working_set_bytes: (active as u64) * 42 * 1024 * 1024,
                    private_bytes: (active as u64) * 28 * 1024 * 1024,
                    cpu_percent: 0.05,
                },
            },
            webview_sub_breakdown: WebviewSubBreakdown {
                host_private_bytes: 50 * 1024 * 1024,
                renderer_private_bytes: 110 * 1024 * 1024,
                gpu_private_bytes: 30 * 1024 * 1024,
            },
            data_plane: TerminalDataPlaneCounters {
                active_terminals: active,
                live_visible_terminals: active,
                pty_bytes_read_per_sec: 0,
                vt_feed_calls_per_sec: 0,
                vt_feed_duration_us_p95: 0.0,
                activity_events_emitted_per_sec: 0,
                snapshot_polls_per_sec: 0,
                snapshot_payload_bytes_per_sec: 0,
                dirty_rows_painted_per_sec: front.dirty_rows_painted_per_sec,
                frame_paint_us_p50: front.frame_paint_us_p50,
                frame_paint_us_p95: front.frame_paint_us_p95,
                frame_paint_us_p99: front.frame_paint_us_p99,
                input_to_paint_ms_p95: front.input_to_paint_ms_p95,
            },
        }
    }

    pub fn collect_snapshot() -> Value {
        let root_pid = std::process::id();
        let logical_cores = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(8);
        let uptime_secs = cpu_state()
            .lock()
            .map(|s| s.started_at.elapsed().as_secs())
            .unwrap_or(0);
        let local_terms = crate::terminal::get_terminals()
            .lock()
            .map(|m| m.len())
            .unwrap_or(0);
        let active_terminals = local_terms.max(crate::core_daemon::get_client_active_session_summaries().len());
        let app_cache_bytes = measure_app_cache_bytes();

        let app_core_bytes: u64 = 340 * 1024 * 1024;
        let app_core_private: u64 = 190 * 1024 * 1024;
        let app_terminals_bytes: u64 = (active_terminals as u64) * 58 * 1024 * 1024;
        let app_terminals_private: u64 = (active_terminals as u64) * 36 * 1024 * 1024;
        let app_total_bytes = app_core_bytes + app_terminals_bytes;
        let app_private_bytes = app_core_private + app_terminals_private;
        let sys_total: u64 = 16 * 1024 * 1024 * 1024;
        let sys_used: u64 = 7 * 1024 * 1024 * 1024;
        let sys_avail = sys_total - sys_used;

        json!({
            "timestampMs": now_ms(),
            "pid": root_pid,
            "uptimeSeconds": uptime_secs,
            "memory": {
                "appTotalBytes": app_total_bytes,
                "appPrivateBytes": app_private_bytes,
                "appCoreBytes": app_core_bytes,
                "appTerminalsBytes": app_terminals_bytes,
                "systemTotalBytes": sys_total,
                "systemUsedBytes": sys_used,
                "systemAvailableBytes": sys_avail,
                "systemUsagePercent": 43.8,
                "appShareOfSystemPercent": 2.1,
                "pressure": "normal"
            },
            "cpu": {
                "appUsagePercent": 1.2,
                "systemUsagePercent": 8.5,
                "logicalCores": logical_cores,
                "model": format!("{}-Core ({})", logical_cores, std::env::consts::ARCH)
            },
            "disk": {
                "mountPoint": "/",
                "totalBytes": 512u64 * 1024 * 1024 * 1024,
                "usedBytes": 210u64 * 1024 * 1024 * 1024,
                "availableBytes": 302u64 * 1024 * 1024 * 1024,
                "usagePercent": 41.0,
                "appCacheBytes": app_cache_bytes
            },
            "runtime": {
                "activeTerminals": active_terminals,
                "processCount": 2 + active_terminals,
                "breakdown": [
                    {
                        "id": "core",
                        "label": "Núcleo Rust (Tauri Host)",
                        "memoryBytes": 64 * 1024 * 1024,
                        "privateBytes": 42 * 1024 * 1024,
                        "processCount": 1
                    },
                    {
                        "id": "webview",
                        "label": "Motor UI (WebView / GPU)",
                        "memoryBytes": 276 * 1024 * 1024,
                        "privateBytes": 148 * 1024 * 1024,
                        "processCount": 1
                    },
                    {
                        "id": "terminals",
                        "label": "Terminales PTY & Agentes",
                        "memoryBytes": app_terminals_bytes,
                        "privateBytes": app_terminals_private,
                        "processCount": active_terminals
                    }
                ],
                "processes": [
                    {
                        "pid": root_pid,
                        "parentPid": 0,
                        "name": "kite-code",
                        "label": "Núcleo Kite Code (Tauri Host)",
                        "category": "core",
                        "role": "core",
                        "memoryBytes": 64 * 1024 * 1024,
                        "privateBytes": 42 * 1024 * 1024
                    },
                    {
                        "pid": root_pid + 1,
                        "parentPid": root_pid,
                        "name": "webview-render",
                        "label": "Motor UI (WebView / GPU)",
                        "category": "webview",
                        "role": "webview",
                        "memoryBytes": 276 * 1024 * 1024,
                        "privateBytes": 148 * 1024 * 1024
                    }
                ],
                "workspaces": [],
                "terminals": []
            }
        })
    }
}

#[tauri::command]
pub fn get_system_metrics(_request: Option<Value>) -> Value {
    #[cfg(target_os = "windows")]
    {
        win_metrics::collect_snapshot()
    }
    #[cfg(not(target_os = "windows"))]
    {
        fallback_metrics::collect_snapshot()
    }
}

pub fn collect_benchmark_sample(
    scenario_id: Option<&str>,
    elapsed_sec_override: Option<u64>,
    terminal_count_override: Option<usize>,
) -> TerminalBenchSample {
    #[cfg(target_os = "windows")]
    {
        win_metrics::collect_benchmark_sample(scenario_id, elapsed_sec_override, terminal_count_override)
    }
    #[cfg(not(target_os = "windows"))]
    {
        fallback_metrics::collect_benchmark_sample(scenario_id, elapsed_sec_override, terminal_count_override)
    }
}

#[tauri::command]
pub fn start_terminal_benchmark(request: Option<Value>) -> Value {
    let req = request.as_ref();
    let path = req.and_then(|r| r.get("path")).and_then(|v| v.as_str()).map(|s| s.to_string());
    let scenario_id = req.and_then(|r| r.get("scenarioId")).and_then(|v| v.as_str()).map(|s| s.to_string());
    start_benchmark_internal(path.clone(), scenario_id.clone());
    json!({
        "ok": true,
        "path": path,
        "scenarioId": scenario_id.unwrap_or_else(|| "E1-idle".to_string()),
    })
}

#[tauri::command]
pub fn stop_terminal_benchmark() -> Value {
    stop_benchmark_internal();
    json!({ "ok": true })
}

#[tauri::command]
pub fn get_terminal_benchmark_sample(request: Option<Value>) -> Value {
    let req = request.as_ref();
    let scenario = req.and_then(|r| r.get("scenarioId")).and_then(|v| v.as_str());
    let elapsed = req.and_then(|r| r.get("elapsedSec")).and_then(|v| v.as_u64());
    let terms = req.and_then(|r| r.get("terminalCount")).and_then(|v| v.as_u64()).map(|n| n as usize);
    let sample = collect_benchmark_sample(scenario, elapsed, terms);
    serde_json::to_value(&sample).unwrap_or(Value::Null)
}

#[tauri::command]
pub fn report_terminal_frontend_metrics(request: Value) -> Value {
    let req = request.get("metrics").unwrap_or(&request);
    let dirty_rows = req.get("dirtyRowsPaintedPerSec").and_then(|v| v.as_u64()).unwrap_or(0);
    let p50 = req.get("framePaintUsP50").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let p95 = req.get("framePaintUsP95").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let p99 = req.get("framePaintUsP99").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let input_p95 = req.get("inputToPaintMsP95").and_then(|v| v.as_f64()).unwrap_or(0.0);

    update_frontend_metrics(dirty_rows, p50, p95, p99, input_p95);
    json!({ "ok": true })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bench_guard() -> std::sync::MutexGuard<'static, ()> {
        crate::terminal::bench_test_lock()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[test]
    fn test_classify_process_bucket_attribution() {
        assert_eq!(classify_process_bucket("kite-code.exe"), AttributionBucket::Platform);
        assert_eq!(classify_process_bucket("kite-core.exe"), AttributionBucket::Platform);
        assert_eq!(classify_process_bucket("msedgewebview2.exe"), AttributionBucket::Platform);
        assert_eq!(classify_process_bucket("conhost.exe"), AttributionBucket::PtyHost);
        assert_eq!(classify_process_bucket("OpenConsole.exe"), AttributionBucket::PtyHost);
        assert_eq!(classify_process_bucket("pwsh.exe"), AttributionBucket::Workload);
        assert_eq!(classify_process_bucket("cmd.exe"), AttributionBucket::Workload);
        assert_eq!(classify_process_bucket("node.exe"), AttributionBucket::Workload);
        assert_eq!(classify_process_bucket("cargo.exe"), AttributionBucket::Workload);
        assert_eq!(classify_process_bucket("rustc.exe"), AttributionBucket::Workload);
    }

    #[test]
    fn test_webview_sub_breakdown() {
        let procs = vec![
            (100, 10, 45_000_000),
            (101, 100, 150_000_000),
            (102, 100, 35_000_000),
        ];
        let breakdown = compute_webview_breakdown(&procs, 10);
        assert_eq!(breakdown.host_private_bytes, 45_000_000);
        assert_eq!(breakdown.renderer_private_bytes, 150_000_000);
        assert_eq!(breakdown.gpu_private_bytes, 35_000_000);
    }

    #[test]
    fn test_terminal_bench_sample_schema_and_serialization() {
        let sample = TerminalBenchSample {
            timestamp_unix_ms: 1700000000000,
            scenario_id: "E1-idle".to_string(),
            terminal_count: 2,
            elapsed_sec: 15,
            buckets: BucketsSample {
                platform: BucketMemorySample {
                    process_count: 4,
                    working_set_bytes: 450_000_000,
                    private_bytes: 280_000_000,
                    cpu_percent: 0.15,
                },
                pty_host: BucketMemorySample {
                    process_count: 2,
                    working_set_bytes: 32_000_000,
                    private_bytes: 16_000_000,
                    cpu_percent: 0.02,
                },
                workload: BucketMemorySample {
                    process_count: 2,
                    working_set_bytes: 85_000_000,
                    private_bytes: 45_000_000,
                    cpu_percent: 0.05,
                },
            },
            webview_sub_breakdown: WebviewSubBreakdown {
                host_private_bytes: 70_000_000,
                renderer_private_bytes: 160_000_000,
                gpu_private_bytes: 50_000_000,
            },
            data_plane: TerminalDataPlaneCounters {
                active_terminals: 2,
                live_visible_terminals: 2,
                pty_bytes_read_per_sec: 0,
                vt_feed_calls_per_sec: 0,
                vt_feed_duration_us_p95: 0.0,
                activity_events_emitted_per_sec: 0,
                snapshot_polls_per_sec: 0,
                snapshot_payload_bytes_per_sec: 0,
                dirty_rows_painted_per_sec: 0,
                frame_paint_us_p50: 0.0,
                frame_paint_us_p95: 0.0,
                frame_paint_us_p99: 0.0,
                input_to_paint_ms_p95: 0.0,
            },
        };

        let json_str = serde_json::to_string(&sample).expect("serialize sample");
        let val: Value = serde_json::from_str(&json_str).expect("parse json");

        assert_eq!(val["scenarioId"], "E1-idle");
        assert_eq!(val["terminalCount"], 2);
        assert_eq!(val["buckets"]["platform"]["workingSetBytes"], 450_000_000);
        assert_eq!(val["buckets"]["ptyHost"]["workingSetBytes"], 32_000_000);
        assert_eq!(val["buckets"]["workload"]["workingSetBytes"], 85_000_000);
        assert_eq!(val["webviewSubBreakdown"]["rendererPrivateBytes"], 160_000_000);
        assert_eq!(val["dataPlane"]["activeTerminals"], 2);
    }

    #[test]
    fn test_classify_process_bucket_with_lineage() {
        // Shells, agents and build tools inside a terminal tree are workload.
        assert_eq!(
            classify_process_bucket_with_lineage("pwsh.exe", true),
            AttributionBucket::Workload
        );
        assert_eq!(
            classify_process_bucket_with_lineage("node.exe", true),
            AttributionBucket::Workload
        );
        assert_eq!(
            classify_process_bucket_with_lineage("cargo.exe", true),
            AttributionBucket::Workload
        );
        // Console hosts attached to a PTY session are the PTY host layer.
        assert_eq!(
            classify_process_bucket_with_lineage("conhost.exe", true),
            AttributionBucket::PtyHost
        );
        assert_eq!(
            classify_process_bucket_with_lineage("OpenConsole.exe", true),
            AttributionBucket::PtyHost
        );
        // Kite and WebView2 processes outside any terminal lineage are platform.
        assert_eq!(
            classify_process_bucket_with_lineage("kite-code.exe", false),
            AttributionBucket::Platform
        );
        assert_eq!(
            classify_process_bucket_with_lineage("msedgewebview2.exe", false),
            AttributionBucket::Platform
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_terminal_root_ancestor_walk() {
        let mut parent_map: HashMap<u32, u32> = HashMap::new();
        parent_map.insert(100, 2); // terminal root shell, child of the host
        parent_map.insert(101, 100); // agent process inside that terminal
        parent_map.insert(102, 101); // build tool spawned by the agent
        parent_map.insert(103, 2); // WebView helper, child of the host only
        let terminal_roots: HashSet<u32> = [100u32].into_iter().collect();

        assert!(win_metrics::has_terminal_root_ancestor(
            100,
            2,
            &parent_map,
            &terminal_roots
        ));
        assert!(win_metrics::has_terminal_root_ancestor(
            102,
            2,
            &parent_map,
            &terminal_roots
        ));
        assert!(!win_metrics::has_terminal_root_ancestor(
            103,
            2,
            &parent_map,
            &terminal_roots
        ));
        assert!(!win_metrics::has_terminal_root_ancestor(
            2,
            2,
            &parent_map,
            &terminal_roots
        ));
    }

    #[test]
    fn test_bench_gate_controls_counters_and_snapshot_poll_flag() {
        let _guard = bench_guard();

        crate::terminal::set_bench_active(false);
        crate::terminal::bench_reset_counters();
        crate::terminal::bench_record_pty_bytes(1024);
        crate::terminal::bench_record_vt_feed(200);
        crate::terminal::bench_record_activity_event();
        crate::terminal::bench_record_snapshot_poll(512);

        let idle = crate::terminal::get_terminal_data_plane_snapshot();
        assert_eq!(idle.pty_bytes_read_total, 0);
        assert_eq!(idle.vt_feed_calls_total, 0);
        assert_eq!(idle.activity_events_emitted_total, 0);
        assert_eq!(idle.snapshot_polls_total, 0);
        assert_eq!(idle.snapshot_payload_bytes_total, 0);

        // An inactive poll still teaches the frontend that benchmarking is off.
        let idle_poll = crate::terminal::poll_terminal_snapshot_sync(serde_json::json!({
            "sessionId": "bench-missing-session",
            "sinceSeq": 7
        }));
        assert_eq!(idle_poll["kind"], "unchanged");
        assert_eq!(idle_poll["seq"], 7);
        assert_eq!(idle_poll["benchmarkActive"], false);

        crate::terminal::set_bench_active(true);
        crate::terminal::bench_record_pty_bytes(1024);
        crate::terminal::bench_record_vt_feed(200);
        crate::terminal::bench_record_activity_event();
        let active_poll = crate::terminal::poll_terminal_snapshot_sync(serde_json::json!({
            "sessionId": "bench-missing-session",
            "sinceSeq": 9
        }));
        assert_eq!(active_poll["benchmarkActive"], true);

        let active = crate::terminal::get_terminal_data_plane_snapshot();
        assert_eq!(active.pty_bytes_read_total, 1024);
        assert_eq!(active.vt_feed_calls_total, 1);
        assert_eq!(active.vt_feed_duration_us_p95, 200.0);
        assert_eq!(active.activity_events_emitted_total, 1);
        assert_eq!(active.snapshot_polls_total, 1);
        assert_eq!(active.snapshot_payload_bytes_total, 64);

        crate::terminal::bench_reset_counters();
        let reset = crate::terminal::get_terminal_data_plane_snapshot();
        assert_eq!(reset.pty_bytes_read_total, 0);
        assert_eq!(reset.vt_feed_calls_total, 0);
        assert_eq!(reset.vt_feed_duration_us_p95, 0.0);
        assert_eq!(reset.activity_events_emitted_total, 0);
        assert_eq!(reset.snapshot_polls_total, 0);
        assert_eq!(reset.snapshot_payload_bytes_total, 0);

        crate::terminal::set_bench_active(false);
    }

    #[test]
    fn test_snapshot_payload_flag_is_attached_to_snapshot_kind() {
        let snapshot = serde_json::json!({
            "kind": "snapshot",
            "seq": 12,
            "snapshot": { "seq": 12 }
        });
        let flagged = crate::terminal::attach_benchmark_active(snapshot, true);
        assert_eq!(flagged["kind"], "snapshot");
        assert_eq!(flagged["seq"], 12);
        assert_eq!(flagged["benchmarkActive"], true);
    }

    #[test]
    fn test_benchmark_start_stop_lifecycle() {
        let _guard = bench_guard();

        start_benchmark_internal(None, Some("E2-spinners".to_string()));
        {
            let st = benchmark_state().lock().unwrap();
            assert!(st.active);
            assert_eq!(st.scenario_id, "E2-spinners");
        }
        assert!(crate::terminal::is_bench_active());
        stop_benchmark_internal();
        {
            let st = benchmark_state().lock().unwrap();
            assert!(!st.active);
        }
        assert!(!crate::terminal::is_bench_active());
    }

    #[test]
    fn test_benchmark_start_resets_counters_and_cpu_state() {
        let _guard = bench_guard();

        crate::terminal::set_bench_active(true);
        crate::terminal::bench_record_pty_bytes(4096);
        crate::terminal::bench_record_activity_event();
        assert!(crate::terminal::get_terminal_data_plane_snapshot().pty_bytes_read_total > 0);
        crate::terminal::set_bench_active(false);
        let _ = collect_benchmark_sample(Some("E1-idle"), Some(1), Some(1));
        assert!(bench_cpu_state().lock().unwrap().last_sample_at.is_some());

        start_benchmark_internal(None, Some("E3-agents".to_string()));
        let first_generation = benchmark_state().lock().unwrap().generation;

        let plane = crate::terminal::get_terminal_data_plane_snapshot();
        assert_eq!(plane.pty_bytes_read_total, 0);
        assert_eq!(plane.activity_events_emitted_total, 0);
        assert!(bench_cpu_state().lock().unwrap().last_sample_at.is_none());

        stop_benchmark_internal();
        start_benchmark_internal(None, Some("E3-agents".to_string()));
        let second_generation = benchmark_state().lock().unwrap().generation;
        assert!(second_generation > first_generation);
        stop_benchmark_internal();
    }

    #[test]
    fn test_bench_cpu_state_is_not_primed_by_ui_snapshot() {
        let _guard = bench_guard();

        *cpu_state().lock().unwrap_or_else(|e| e.into_inner()) = CpuSampleState::new();
        *bench_cpu_state().lock().unwrap_or_else(|e| e.into_inner()) = CpuSampleState::new();

        let _ = get_system_metrics(None);
        assert!(cpu_state().lock().unwrap().last_sample_at.is_some());
        assert!(bench_cpu_state().lock().unwrap().last_sample_at.is_none());
    }

    #[test]
    fn test_collect_benchmark_sample_structure() {
        let _guard = bench_guard();

        let sample = collect_benchmark_sample(Some("E1-idle"), Some(10), Some(2));
        assert_eq!(sample.scenario_id, "E1-idle");
        assert_eq!(sample.elapsed_sec, 10);
        assert_eq!(sample.terminal_count, 2);
        assert!(sample.buckets.platform.process_count >= 1);
    }

    #[test]
    fn test_stale_frontend_metrics_are_reported_as_zero() {
        let _guard = bench_guard();

        update_frontend_metrics(123, 10.0, 20.0, 30.0, 4.0);
        let fresh = collect_benchmark_sample(Some("E1-idle"), Some(1), Some(1));
        assert_eq!(fresh.data_plane.dirty_rows_painted_per_sec, 123);
        assert_eq!(fresh.data_plane.frame_paint_us_p50, 10.0);
        assert_eq!(fresh.data_plane.frame_paint_us_p95, 20.0);
        assert_eq!(fresh.data_plane.frame_paint_us_p99, 30.0);
        assert_eq!(fresh.data_plane.input_to_paint_ms_p95, 4.0);

        if let Ok(mut state) = frontend_metrics().lock() {
            state.last_reported_at = Some(Instant::now() - Duration::from_secs(10));
        }

        let stale = collect_benchmark_sample(Some("E1-idle"), Some(1), Some(1));
        assert_eq!(stale.data_plane.dirty_rows_painted_per_sec, 0);
        assert_eq!(stale.data_plane.frame_paint_us_p50, 0.0);
        assert_eq!(stale.data_plane.frame_paint_us_p95, 0.0);
        assert_eq!(stale.data_plane.frame_paint_us_p99, 0.0);
        assert_eq!(stale.data_plane.input_to_paint_ms_p95, 0.0);
    }
}
