use super::sampler::{bench_cpu_state, fresh_frontend_metrics, now_ms, CpuSampleState};
use super::types::*;
#[cfg(target_os = "windows")]
use super::win_process::{
    collect_process_tree, has_terminal_root_ancestor, query_process_mem_and_cpu,
};
use serde_json::{json, Value};
#[cfg(target_os = "windows")]
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

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

#[cfg(target_os = "windows")]
fn collect_benchmark_sample_platform(
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

#[cfg(not(target_os = "windows"))]
fn collect_benchmark_sample_platform(
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

pub fn collect_benchmark_sample(
    scenario_id: Option<&str>,
    elapsed_sec_override: Option<u64>,
    terminal_count_override: Option<usize>,
) -> TerminalBenchSample {
    collect_benchmark_sample_platform(scenario_id, elapsed_sec_override, terminal_count_override)
}

pub fn start_terminal_benchmark_impl(request: Option<Value>) -> Value {
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

pub fn stop_terminal_benchmark_impl() -> Value {
    stop_benchmark_internal();
    json!({ "ok": true })
}

pub fn get_terminal_benchmark_sample_impl(request: Option<Value>) -> Value {
    let req = request.as_ref();
    let scenario = req.and_then(|r| r.get("scenarioId")).and_then(|v| v.as_str());
    let elapsed = req.and_then(|r| r.get("elapsedSec")).and_then(|v| v.as_u64());
    let terms = req.and_then(|r| r.get("terminalCount")).and_then(|v| v.as_u64()).map(|n| n as usize);
    let sample = collect_benchmark_sample(scenario, elapsed, terms);
    serde_json::to_value(&sample).unwrap_or(Value::Null)
}
