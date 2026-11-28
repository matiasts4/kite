//! Native Rust Agent Fast Lane (`Phase 3` — `S1`–`S5`).
//!
//! Provides an ultra-lightweight in-process agentic turn engine strictly for
//! officially supported HTTPS/SSE API keys and OpenCode Go gateway sessions,
//! alongside persistent runtime resource settings and live transport telemetry.

pub mod compaction;
pub mod loop_engine;
pub mod mcp_client;
pub mod providers;
pub mod tools;
pub mod transport;
pub mod types;

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::chat::persistent::{agy_acp_pool_stats, grok_pool_stats, opencode_pool_stats};
use crate::chat::session::{
    global_process_governor, governor_snapshot, DEFAULT_HEAVY_PROCESS_LIMIT,
    MAX_HEAVY_PROCESS_LIMIT, MIN_HEAVY_PROCESS_LIMIT,
};
use crate::dispatch::mcp_http::mcp_http_hub_stats;
use crate::dispatch::mcp_hub::pooled_server_count;

const SETTINGS_FILENAME: &str = "runtime-resource-settings.json";

fn default_mcp_http_hub_enabled() -> bool {
    true
}

fn default_max_heavy_processes() -> usize {
    DEFAULT_HEAVY_PROCESS_LIMIT
}

/// Persisted runtime optimization & concurrency settings for the desktop client.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeResourceSettings {
    #[serde(default)]
    pub fast_lane_enabled: bool,
    #[serde(default = "default_mcp_http_hub_enabled")]
    pub mcp_http_hub_enabled: bool,
    #[serde(default = "default_max_heavy_processes")]
    pub max_heavy_processes: usize,
}

impl Default for RuntimeResourceSettings {
    fn default() -> Self {
        Self {
            fast_lane_enabled: false,
            mcp_http_hub_enabled: true,
            max_heavy_processes: DEFAULT_HEAVY_PROCESS_LIMIT,
        }
    }
}

impl RuntimeResourceSettings {
    /// Clamps `max_heavy_processes` to `1..=8`.
    pub fn normalized(mut self) -> Self {
        self.max_heavy_processes = self
            .max_heavy_processes
            .clamp(MIN_HEAVY_PROCESS_LIMIT, MAX_HEAVY_PROCESS_LIMIT);
        self
    }
}

/// Canonical settings file path inside `roaming_app_dir()`.
pub fn runtime_resource_settings_path() -> PathBuf {
    crate::persist::roaming_app_dir().join(SETTINGS_FILENAME)
}

pub(crate) fn load_runtime_resource_settings_at(path: &Path) -> RuntimeResourceSettings {
    let Ok(bytes) = std::fs::read(path) else {
        return RuntimeResourceSettings::default();
    };
    serde_json::from_slice::<RuntimeResourceSettings>(&bytes)
        .map(RuntimeResourceSettings::normalized)
        .unwrap_or_default()
}

pub(crate) fn save_runtime_resource_settings_at(
    path: &Path,
    settings: RuntimeResourceSettings,
) -> Result<RuntimeResourceSettings, String> {
    let normalized = settings.normalized();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create settings directory: {err}"))?;
    }

    let bytes = serde_json::to_vec_pretty(&normalized)
        .map_err(|err| format!("Failed to serialize runtime resource settings: {err}"))?;

    let tmp_name = format!(
        "{}.{}.tmp",
        path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(SETTINGS_FILENAME),
        uuid::Uuid::new_v4().simple()
    );
    let tmp_path = path.with_file_name(tmp_name);
    std::fs::write(&tmp_path, &bytes)
        .map_err(|err| format!("Failed to write temp runtime resource settings: {err}"))?;

    if let Err(rename_err) = std::fs::rename(&tmp_path, path) {
        if path.exists() {
            let _ = std::fs::remove_file(path);
        }
        if let Err(retry_err) = std::fs::rename(&tmp_path, path) {
            let write_fallback = std::fs::write(path, &bytes);
            let _ = std::fs::remove_file(&tmp_path);
            write_fallback.map_err(|err| {
                format!("Failed to persist runtime resource settings ({rename_err}; {retry_err}; {err})")
            })?;
        }
    }

    global_process_governor().set_heavy_limit(normalized.max_heavy_processes);
    Ok(normalized)
}

/// Loads persisted runtime resource settings (falling back to defaults when missing/corrupt).
pub fn load_runtime_resource_settings() -> RuntimeResourceSettings {
    load_runtime_resource_settings_at(&runtime_resource_settings_path())
}

/// Clamps, atomically persists, and applies `RuntimeResourceSettings` to the global governor.
#[tauri::command]
pub fn save_runtime_resource_settings(
    settings: RuntimeResourceSettings,
) -> Result<RuntimeResourceSettings, String> {
    save_runtime_resource_settings_at(&runtime_resource_settings_path(), settings)
}

/// Returns current runtime resource settings for Tauri IPC callers.
#[tauri::command]
pub fn get_runtime_resource_settings() -> RuntimeResourceSettings {
    load_runtime_resource_settings()
}

/// Aggregates live multiplexed daemon counts, MCP Hub telemetry, Native Fast Lane
/// active session counts, ProcessGovernor utilization, and persisted settings.
pub fn collect_runtime_transport_metrics() -> Value {
    let (agy_daemons, agy_sessions) = agy_acp_pool_stats();
    let (opencode_servers, opencode_leases) = opencode_pool_stats();
    let (grok_daemons, grok_sessions) = grok_pool_stats();
    let (mcp_http_running, mcp_http_port, mcp_http_requests) = mcp_http_hub_stats();
    let mcp_pooled_servers = pooled_server_count();
    let governor = governor_snapshot();
    let active_fast_lane_sessions = transport::active_fast_lane_count();
    let settings = load_runtime_resource_settings();
    let active_mux_daemons = agy_daemons + opencode_servers + grok_daemons;

    json!({
        "activeMuxDaemons": active_mux_daemons,
        "agyAcp": {
            "daemons": agy_daemons,
            "sessions": agy_sessions,
        },
        "opencode": {
            "servers": opencode_servers,
            "leases": opencode_leases,
        },
        "grok": {
            "daemons": grok_daemons,
            "sessions": grok_sessions,
        },
        "mcpHub": {
            "httpRunning": mcp_http_running,
            "port": mcp_http_port,
            "requestCount": mcp_http_requests,
            "pooledStdioServers": mcp_pooled_servers,
        },
        "activeFastLaneSessions": active_fast_lane_sessions,
        "governor": governor,
        "settings": settings,
    })
}

/// Tauri IPC command returning [`collect_runtime_transport_metrics`].
#[tauri::command]
pub fn get_runtime_transport_metrics() -> Value {
    collect_runtime_transport_metrics()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static SETTINGS_TEST_LOCK: Mutex<()> = Mutex::new(());

    struct GovernorLimitRestorer(usize);
    impl Drop for GovernorLimitRestorer {
        fn drop(&mut self) {
            global_process_governor().set_heavy_limit(self.0);
        }
    }

    fn temp_settings_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "kite-runtime-settings-{tag}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn runtime_resource_settings_defaults_and_clamping() {
        let defaults = RuntimeResourceSettings::default();
        assert!(!defaults.fast_lane_enabled);
        assert!(defaults.mcp_http_hub_enabled);
        assert_eq!(defaults.max_heavy_processes, 4);

        let too_low = RuntimeResourceSettings {
            fast_lane_enabled: true,
            mcp_http_hub_enabled: false,
            max_heavy_processes: 0,
        }
        .normalized();
        assert_eq!(too_low.max_heavy_processes, 1);

        let too_high = RuntimeResourceSettings {
            fast_lane_enabled: true,
            mcp_http_hub_enabled: true,
            max_heavy_processes: 99,
        }
        .normalized();
        assert_eq!(too_high.max_heavy_processes, 8);

        let encoded = serde_json::to_value(&defaults).unwrap();
        assert_eq!(encoded["fastLaneEnabled"], false);
        assert_eq!(encoded["mcpHttpHubEnabled"], true);
        assert_eq!(encoded["maxHeavyProcesses"], 4);
    }

    #[test]
    fn save_and_load_runtime_settings_persists_atomically_and_updates_governor() {
        let _guard = SETTINGS_TEST_LOCK.lock().unwrap();
        let prev_limit = governor_snapshot().heavy_limit;
        let _restore = GovernorLimitRestorer(prev_limit);

        let dir = temp_settings_dir("persist");
        let path = dir.join("runtime-resource-settings.json");

        // Missing file loads defaults
        assert_eq!(
            load_runtime_resource_settings_at(&path),
            RuntimeResourceSettings::default()
        );

        let saved = save_runtime_resource_settings_at(
            &path,
            RuntimeResourceSettings {
                fast_lane_enabled: true,
                mcp_http_hub_enabled: false,
                max_heavy_processes: 42,
            },
        )
        .unwrap();
        assert_eq!(saved.max_heavy_processes, 8);
        assert!(saved.fast_lane_enabled);
        assert!(!saved.mcp_http_hub_enabled);
        assert_eq!(governor_snapshot().heavy_limit, 8);

        let reloaded = load_runtime_resource_settings_at(&path);
        assert_eq!(reloaded, saved);

        // No leftover temp files remain next to settings file
        let entries: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(entries, vec!["runtime-resource-settings.json".to_string()]);

        // Out-of-bounds value on disk is clamped on load
        std::fs::write(
            &path,
            r#"{"fastLaneEnabled":false,"mcpHttpHubEnabled":true,"maxHeavyProcesses":0}"#,
        )
        .unwrap();
        let clamped_on_load = load_runtime_resource_settings_at(&path);
        assert_eq!(clamped_on_load.max_heavy_processes, 1);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn collect_runtime_transport_metrics_matches_frontend_contract() {
        let _guard = SETTINGS_TEST_LOCK.lock().unwrap();
        let metrics = collect_runtime_transport_metrics();
        assert!(metrics["activeMuxDaemons"].is_u64());
        assert!(metrics["agyAcp"]["daemons"].is_u64());
        assert!(metrics["agyAcp"]["sessions"].is_u64());
        assert!(metrics["opencode"]["servers"].is_u64());
        assert!(metrics["opencode"]["leases"].is_u64());
        assert!(metrics["grok"]["daemons"].is_u64());
        assert!(metrics["grok"]["sessions"].is_u64());
        assert!(metrics["mcpHub"]["httpRunning"].is_boolean());
        assert!(metrics["mcpHub"]["requestCount"].is_u64());
        assert!(metrics["mcpHub"]["pooledStdioServers"].is_u64());
        assert!(metrics["activeFastLaneSessions"].is_u64());
        assert!(metrics["governor"]["heavyActive"].is_u64());
        assert!(metrics["governor"]["heavyLimit"].is_u64());
        assert!(metrics["governor"]["multiplexedActive"].is_u64());
        assert!(metrics["governor"]["multiplexedLimit"].is_u64());
        assert!(metrics["governor"]["heavyQueued"].is_u64());
        assert!(metrics["settings"]["fastLaneEnabled"].is_boolean());
        assert!(metrics["settings"]["mcpHttpHubEnabled"].is_boolean());
        assert!(metrics["settings"]["maxHeavyProcesses"].is_u64());
    }
}
