use portable_pty::{Child as PtyChild, MasterPty};
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{Arc, Mutex};

pub mod bench;
pub mod capture;
pub mod clipboard;
pub mod codec;
pub mod diagnostics;
pub mod launcher;
pub mod quiesce;
pub mod scrollback;
pub mod spawn;
pub mod lifecycle;
pub mod commands;
pub mod viewport;
pub mod workspace;

pub use bench::*;
pub use capture::*;
pub use clipboard::*;
pub use codec::*;
pub use diagnostics::*;
pub use launcher::*;
pub use quiesce::*;
pub use scrollback::*;
pub use spawn::*;
pub use lifecycle::*;
pub use commands::*;
pub use viewport::*;
pub use workspace::*;

#[derive(Debug, Clone)]
pub enum SpawnMode {
    Fresh,
    /// Fresh provider session without resuming any prior `--conversation` id,
    /// supporting both direct agent CLIs and hybrid generic-shell launches.
    Agent {
        hybrid_shell_agent: Option<String>,
    },
    Resume {
        provider_session_id: Option<String>,
        allow_continue_fallback: bool,
        hybrid_shell_agent: Option<String>,
    },
}

#[derive(Debug, Clone)]
pub struct SpawnOptions {
    pub cols: u16,
    pub rows: u16,
    pub workspace_id: Option<String>,
    pub pane_id: Option<String>,
    pub mode: SpawnMode,
    pub initial_prompt: Option<String>,
    pub auto_approve: bool,
    pub system_prompt: Option<String>,
    /// When set, this argv is the process. The agent CLI is not also started.
    pub raw_argv: Option<Vec<String>>,
    /// Keep existing disk scrollback when respawning an agent session (e.g. account rotation).
    pub preserve_scrollback_on_agent: bool,
}

impl Default for SpawnOptions {
    fn default() -> Self {
        Self {
            cols: 80,
            rows: 24,
            workspace_id: None,
            pane_id: None,
            mode: SpawnMode::Fresh,
            initial_prompt: None,
            auto_approve: false,
            system_prompt: None,
            raw_argv: None,
            preserve_scrollback_on_agent: false,
        }
    }
}

pub struct TerminalInstance {
    pub(crate) master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    pub(crate) writer: Arc<Mutex<Box<dyn Write + Send>>>,
    pub(crate) child: Arc<Mutex<Box<dyn PtyChild + Send>>>,
    pub(crate) buffer: Arc<Mutex<Vec<u8>>>,
    pub(crate) scrollback: Arc<Mutex<Vec<u8>>>,
    pub(crate) vt_engine: Arc<Mutex<crate::vt_engine::TerminalVtEngine>>,
    pub(crate) sequence: AtomicU64,
    pub(crate) output_byte_offset: AtomicU64,
    pub(crate) output_capture_order: Mutex<()>,
    pub(crate) ansi_scan_tail: Mutex<Vec<u8>>,
    pub(crate) cwd: String,
    pub(crate) live_cwd: Arc<Mutex<String>>,
    pub(crate) engine: String,
    pub(crate) detected_agent_engine: Arc<Mutex<Option<String>>>,
    pub(crate) provider_session_id: Arc<Mutex<Option<String>>>,
    pub(crate) workspace_id: Mutex<Option<String>>,
    pub(crate) pane_id: Mutex<Option<String>>,
    pub(crate) spawned_at_unix_ms: i64,
    /// OS process id of the PTY root child, captured at spawn time.
    pub(crate) root_pid: u32,
    pub(crate) had_user_activity: AtomicBool,
    pub(crate) input_line_buffer: Mutex<String>,
    pub(crate) last_user_input: Mutex<Option<String>>,
    pub(crate) last_bind_attempt_ms: AtomicU64,
    pub(crate) bind_attempts: std::sync::atomic::AtomicU32,
    pub(crate) cols: std::sync::atomic::AtomicU16,
    pub(crate) rows: std::sync::atomic::AtomicU16,
    /// When false, paint wakes stop. The PTY and the VT engine keep running.
    pub(crate) presentation_live: AtomicBool,
    pub(crate) exit_notified: AtomicBool,
    pub(crate) lifecycle_stop: AtomicBool,
    /// Set during planned account rotation so PTY termination does not show a crash/exit bar.
    pub(crate) suppress_exit_event: AtomicBool,
    pub(crate) last_output_ms: AtomicU64,
    pub(crate) last_paint_emit_ms: AtomicU64,
    pub(crate) paint_flush_armed: AtomicBool,
}

pub fn get_terminals() -> &'static Mutex<HashMap<String, Arc<TerminalInstance>>> {
    static INSTANCE: std::sync::OnceLock<Mutex<HashMap<String, Arc<TerminalInstance>>>> =
        std::sync::OnceLock::new();
    INSTANCE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Root shell PIDs of every open terminal session. Benchmark attribution uses
/// these as lineage anchors for the workload and PTY-host buckets.
pub fn get_terminal_root_pids() -> HashSet<u32> {
    let mut roots = HashSet::new();
    if let Ok(map) = get_terminals().lock() {
        for inst in map.values() {
            if let Ok(child) = inst.child.lock() {
                if let Some(pid) = child.process_id() {
                    roots.insert(pid);
                }
            }
        }
    }
    roots.extend(crate::core_daemon::get_client_session_root_pids());
    roots
}

pub fn get_session_resolve_lock() -> &'static Mutex<()> {
    static LOCK: std::sync::OnceLock<Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}


pub(crate) fn instance_exists(session_id: &str) -> bool {
    get_terminals()
        .lock()
        .ok()
        .and_then(|map| map.get(session_id).cloned())
        .is_some()
}

/// True when this process owns a live PTY registry entry for the session.
pub fn has_local_terminal_instance(session_id: &str) -> bool {
    instance_exists(session_id)
}

/// True when a detached `kite-core` owns the PTYs and this process must forward
/// terminal operations over the control pipe instead of touching a local map.
pub(crate) fn should_proxy_to_core_daemon(session_id: &str) -> bool {
    !session_id.is_empty()
        && crate::core_daemon::is_external_daemon_owner()
        && !has_local_terminal_instance(session_id)
}

#[tauri::command]
pub async fn start_terminal(request: serde_json::Value) -> serde_json::Value {
    commands::start_terminal_sync(request)
}

#[tauri::command]
pub async fn attach_terminal(request: serde_json::Value) -> serde_json::Value {
    commands::attach_terminal_sync(request)
}

#[tauri::command]
pub async fn read_terminal_output(request: serde_json::Value) -> serde_json::Value {
    commands::read_terminal_output_sync(request)
}

#[tauri::command]
pub async fn write_terminal(request: serde_json::Value) -> serde_json::Value {
    commands::write_terminal_sync(request)
}

#[tauri::command]
pub async fn resize_terminal(request: serde_json::Value) -> serde_json::Value {
    commands::resize_terminal_sync(request)
}

#[tauri::command]
pub async fn poll_terminal_snapshot(request: serde_json::Value) -> serde_json::Value {
    viewport::poll_terminal_snapshot_sync(request)
}

#[tauri::command]
pub async fn set_terminal_presentation(request: serde_json::Value) -> serde_json::Value {
    viewport::set_terminal_presentation_sync(request)
}

#[tauri::command]
pub async fn scroll_terminal_viewport(
    request: serde_json::Value,
) -> Result<crate::vt_engine::RenderSnapshot, String> {
    viewport::scroll_terminal_viewport_sync(request)
}

#[tauri::command]
pub async fn scroll_terminal_viewport_bin(
    request: serde_json::Value,
) -> Result<Vec<u8>, String> {
    viewport::scroll_terminal_viewport_bin_bytes(request)
}

#[tauri::command]
pub async fn find_terminal_text(request: serde_json::Value) -> Result<serde_json::Value, String> {
    diagnostics::find_terminal_text_sync(request)
}

#[tauri::command]
pub async fn get_terminal_selection_text(
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    diagnostics::get_terminal_selection_text_sync(request)
}

#[tauri::command]
pub async fn dump_terminal_diagnostics(request: serde_json::Value) -> Result<String, String> {
    diagnostics::dump_terminal_diagnostics(request).await
}

#[tauri::command]
pub async fn clear_terminal_vt(request: serde_json::Value) -> serde_json::Value {
    diagnostics::clear_terminal_vt_sync(request)
}

#[tauri::command]
pub fn report_terminal_agent_detected(request: serde_json::Value) -> serde_json::Value {
    diagnostics::report_terminal_agent_detected(request)
}

#[tauri::command]
pub async fn terminate_terminal(request: serde_json::Value) -> serde_json::Value {
    commands::terminate_terminal_sync(request)
}

#[tauri::command]
pub fn launch_workspace_terminals(request: serde_json::Value) -> serde_json::Value {
    workspace::launch_workspace_terminals(request)
}

#[tauri::command]
pub fn list_terminal_profiles() -> serde_json::Value {
    workspace::list_terminal_profiles()
}

#[tauri::command]
pub fn insert_terminal_drop_paths(request: Option<serde_json::Value>) -> serde_json::Value {
    clipboard::insert_terminal_drop_paths(request)
}

#[tauri::command]
pub fn insert_terminal_files_entry(request: Option<serde_json::Value>) -> serde_json::Value {
    clipboard::insert_terminal_files_entry(request)
}

#[tauri::command]
pub fn restart_agent_terminal_for_autopilot(request: serde_json::Value) -> serde_json::Value {
    workspace::restart_agent_terminal_for_autopilot(request)
}

#[tauri::command]
pub fn stage_terminal_clipboard_image(request: Option<serde_json::Value>) -> serde_json::Value {
    clipboard::stage_terminal_clipboard_image(request)
}
#[cfg(test)]
#[path = "terminal_tests.rs"]
mod tests;

