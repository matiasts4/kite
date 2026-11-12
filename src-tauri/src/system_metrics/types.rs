use serde::{Deserialize, Serialize};

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
