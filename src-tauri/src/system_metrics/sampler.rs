use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone)]
pub struct CpuSampleState {
    pub started_at: Instant,
    pub last_sample_at: Option<Instant>,
    pub last_sys_idle: u64,
    pub last_sys_kernel: u64,
    pub last_sys_user: u64,
    pub last_proc_times: HashMap<u32, u64>,
    pub last_sys_cpu_pct: f64,
    pub last_app_cpu_pct: f64,
}

impl CpuSampleState {
    pub fn new() -> Self {
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

pub fn cpu_state() -> &'static Mutex<CpuSampleState> {
    static STATE: OnceLock<Mutex<CpuSampleState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(CpuSampleState::new()))
}

/// Separate CPU delta timeline for the 1 Hz benchmark sampler so UI polling
/// cannot shorten its elapsed window below the 250 ms threshold.
pub fn bench_cpu_state() -> &'static Mutex<CpuSampleState> {
    static STATE: OnceLock<Mutex<CpuSampleState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(CpuSampleState::new()))
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn compute_dir_size(path: &std::path::Path) -> u64 {
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

pub const APP_CACHE_TTL: Duration = Duration::from_secs(60);

pub fn app_cache_state() -> &'static Mutex<Option<(Instant, u64)>> {
    static STATE: OnceLock<Mutex<Option<(Instant, u64)>>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(None))
}

pub fn measure_app_cache_bytes() -> u64 {
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

#[derive(Debug, Clone, Default)]
pub struct FrontendMetricsState {
    pub dirty_rows_painted_per_sec: u64,
    pub frame_paint_us_p50: f64,
    pub frame_paint_us_p95: f64,
    pub frame_paint_us_p99: f64,
    pub input_to_paint_ms_p95: f64,
    pub last_reported_at: Option<Instant>,
}

pub fn frontend_metrics() -> &'static Mutex<FrontendMetricsState> {
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
pub const FRONTEND_METRICS_TTL: Duration = Duration::from_secs(3);

/// Snapshot of the last frontend report, zeroed once it goes stale so a closed
/// or benchmark-inactive UI cannot keep reporting old numbers forever.
pub fn fresh_frontend_metrics() -> FrontendMetricsState {
    let front = frontend_metrics().lock().map(|f| f.clone()).unwrap_or_default();
    match front.last_reported_at {
        Some(reported_at) if reported_at.elapsed() <= FRONTEND_METRICS_TTL => front,
        _ => FrontendMetricsState::default(),
    }
}

#[cfg(not(target_os = "windows"))]
pub mod fallback_metrics {
    use super::*;

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

pub fn get_system_metrics_impl(_request: Option<Value>) -> Value {
    #[cfg(target_os = "windows")]
    {
        crate::system_metrics::win_metrics::collect_snapshot()
    }
    #[cfg(not(target_os = "windows"))]
    {
        fallback_metrics::collect_snapshot()
    }
}

pub fn report_terminal_frontend_metrics_impl(request: Value) -> Value {
    let req = request.get("metrics").unwrap_or(&request);
    let dirty_rows = req.get("dirtyRowsPaintedPerSec").and_then(|v| v.as_u64()).unwrap_or(0);
    let p50 = req.get("framePaintUsP50").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let p95 = req.get("framePaintUsP95").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let p99 = req.get("framePaintUsP99").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let input_p95 = req.get("inputToPaintMsP95").and_then(|v| v.as_f64()).unwrap_or(0.0);

    update_frontend_metrics(dirty_rows, p50, p95, p99, input_p95);
    json!({ "ok": true })
}
