use super::*;
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

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
