use crate::logger::log_trace;
use crate::persist::workspace_path;
use crate::session_resolver::{
    canonical_agent_engine, claude_session_file_exists, detect_child_agent_in_shell,
    choose_restore_provider_id, get_persisted_terminal_session, is_generic_shell_engine,
    restore_grok_provider_id,
    read_persisted_terminal_sessions, remove_persisted_terminal_session,
    resolve_provider_session_id_with_context, upsert_persisted_terminal_session,
    upsert_persisted_terminal_session_clearing_provider, write_persisted_terminal_sessions,
    PersistedTerminalSession,
};
use portable_pty::{native_pty_system, Child as PtyChild, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use uuid::Uuid;

pub mod bench;
pub mod capture;
pub mod clipboard;
pub mod diagnostics;
pub mod launcher;
pub mod quiesce;
pub mod scrollback;
pub mod lifecycle;
pub mod commands;
pub mod viewport;
pub mod workspace;

pub use bench::*;
pub use capture::*;
pub use clipboard::*;
pub use diagnostics::*;
pub use launcher::*;
pub use quiesce::*;
pub use scrollback::*;
pub use lifecycle::*;
pub use commands::*;
pub use viewport::*;
pub use workspace::*;

#[derive(Debug, Clone)]
pub enum SpawnMode {
    Fresh,
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
        }
    }
}

pub struct TerminalInstance {
    pub master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    pub writer: Arc<Mutex<Box<dyn Write + Send>>>,
    pub child: Arc<Mutex<Box<dyn PtyChild + Send>>>,
    pub buffer: Arc<Mutex<Vec<u8>>>,
    pub scrollback: Arc<Mutex<Vec<u8>>>,
    pub vt_engine: Arc<Mutex<crate::vt_engine::TerminalVtEngine>>,
    pub sequence: AtomicU64,
    pub output_byte_offset: AtomicU64,
    pub output_capture_order: Mutex<()>,
    pub ansi_scan_tail: Mutex<Vec<u8>>,
    pub cwd: String,
    pub live_cwd: Arc<Mutex<String>>,
    pub engine: String,
    pub detected_agent_engine: Arc<Mutex<Option<String>>>,
    pub provider_session_id: Arc<Mutex<Option<String>>>,
    pub workspace_id: Mutex<Option<String>>,
    pub pane_id: Mutex<Option<String>>,
    pub spawned_at_unix_ms: i64,
    /// OS process id of the PTY root child, captured at spawn time.
    pub root_pid: u32,
    pub had_user_activity: AtomicBool,
    pub input_line_buffer: Mutex<String>,
    pub last_user_input: Mutex<Option<String>>,
    pub last_bind_attempt_ms: AtomicU64,
    pub bind_attempts: std::sync::atomic::AtomicU32,
    pub cols: std::sync::atomic::AtomicU16,
    pub rows: std::sync::atomic::AtomicU16,
    /// When false, paint wakes stop. The PTY and the VT engine keep running.
    pub presentation_live: AtomicBool,
    pub exit_notified: AtomicBool,
    pub lifecycle_stop: AtomicBool,
    pub last_paint_emit_ms: AtomicU64,
    pub paint_flush_armed: AtomicBool,
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

pub fn get_globally_claimed_provider_ids(current_session_id: &str) -> HashSet<String> {
    let mut claimed = HashSet::new();

    if let Ok(map) = get_terminals().lock() {
        for (sid, inst) in map.iter() {
            if sid != current_session_id {
                if let Ok(p) = inst.provider_session_id.lock() {
                    if let Some(ref pid) = *p {
                        if !pid.is_empty() {
                            claimed.insert(pid.clone());
                        }
                    }
                }
            }
        }
    }

    let persisted_map = read_persisted_terminal_sessions();
    for (sid, session) in persisted_map {
        if sid != current_session_id {
            if let Some(ref pid) = session.provider_session_id {
                if !pid.is_empty() {
                    claimed.insert(pid.clone());
                }
            }
        }
    }

    claimed
}

pub(crate) fn snapshot_scrollback_for_attach(
    session_id: &str,
    inst: &TerminalInstance,
    preserve_unread_buffer: bool,
) -> Option<Vec<u8>> {
    let mut had_pending = false;
    let buf_guard = inst.buffer.lock().ok();
    let sb_guard = inst.scrollback.lock().ok();
    if let Some(mut buf) = buf_guard {
        if !buf.is_empty() {
            had_pending = true;
            if !preserve_unread_buffer {
                buf.clear();
            }
        }
    }
    if let Some(sb) = sb_guard {
        if had_pending && !sb.is_empty() {
            write_scrollback_file(session_id, &sb);
        }
        if sb.is_empty() {
            None
        } else {
            Some(sb.clone())
        }
    } else {
        None
    }
}

pub fn try_bind_provider_session_id(session_id: &str, inst: &TerminalInstance) -> Option<String> {
    let _resolve_guard = get_session_resolve_lock()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    inst.last_bind_attempt_ms
        .store(now_unix_ms() as u64, Ordering::Relaxed);

    let root_pid = inst.child.lock().ok().and_then(|c| c.process_id());
    let detected_child = if is_generic_shell_engine(&inst.engine) {
        let child = root_pid.and_then(detect_child_agent_in_shell);
        if let Some(ref c) = child {
            inst.had_user_activity.store(true, Ordering::Relaxed);
            if let Ok(mut det) = inst.detected_agent_engine.lock() {
                *det = Some(c.clone());
            }
        } else {
            // For a generic shell, if no child agent is running, don't allow a stale or
            // false-positive text detection to persist as an active agent engine.
            let has_bound_prov = inst
                .provider_session_id
                .lock()
                .ok()
                .and_then(|p| p.clone())
                .is_some();
            if !has_bound_prov {
                if let Ok(mut det) = inst.detected_agent_engine.lock() {
                    *det = None;
                }
            }
        }
        child
    } else {
        None
    };

    let engine = if is_generic_shell_engine(&inst.engine) {
        detected_child
            .or_else(|| {
                let has_bound = inst
                    .provider_session_id
                    .lock()
                    .ok()
                    .and_then(|p| p.clone())
                    .is_some();
                if has_bound {
                    inst.detected_agent_engine.lock().ok().and_then(|d| d.clone())
                } else {
                    None
                }
            })
            .unwrap_or_else(|| canonical_agent_engine(&inst.engine))
    } else {
        inst.detected_agent_engine
            .lock()
            .ok()
            .and_then(|d| d.clone())
            .unwrap_or_else(|| canonical_agent_engine(&inst.engine))
    };

    let cwd = inst
        .live_cwd
        .lock()
        .ok()
        .map(|c| c.clone())
        .filter(|c| !c.is_empty())
        .unwrap_or_else(|| inst.cwd.clone());

    let last_input = inst.last_user_input.lock().ok().and_then(|l| l.clone());
    let ws_id = inst.workspace_id.lock().ok().and_then(|w| w.clone());
    let p_id = inst.pane_id.lock().ok().and_then(|p| p.clone());
    let had_activity = inst.had_user_activity.load(Ordering::Relaxed);

    if is_generic_shell_engine(&engine) {
        if had_activity {
            upsert_persisted_terminal_session(PersistedTerminalSession {
                session_id: session_id.to_string(),
                workspace_id: ws_id,
                pane_id: p_id,
                base_engine: inst.engine.clone(),
                active_engine: engine,
                provider_session_id: None,
                cwd,
                had_user_activity: true,
                last_user_input: last_input,
                spawned_at_unix_ms: inst.spawned_at_unix_ms,
                saved_at_unix_ms: now_unix_ms(),
            });
        }
        return None;
    }

    // Flush any unread output into scrollback so transcript/scrollback matching has the latest bytes
    let _ = snapshot_scrollback_for_attach(session_id, inst, false);

    let existing_prov = inst.provider_session_id.lock().ok().and_then(|p| p.clone());
    if let Some(ref pid) = existing_prov {
        return Some(pid.clone());
    }

    let claimed_ids = get_globally_claimed_provider_ids(session_id);
    let resolved = resolve_provider_session_id_with_context(
        &engine,
        &cwd,
        session_id,
        existing_prov.as_deref(),
        inst.spawned_at_unix_ms,
        &claimed_ids,
        root_pid,
        last_input.as_deref(),
    );

    if let Some(ref pid) = resolved {
        if let Ok(mut p) = inst.provider_session_id.lock() {
            *p = Some(pid.clone());
        }
        log_trace(&format!(
            "try_bind_provider_session_id: bound session {} to provider id {}",
            session_id, pid
        ));
    }

    let final_prov = resolved.clone().or(existing_prov);
    if had_activity || final_prov.is_some() {
        upsert_persisted_terminal_session(PersistedTerminalSession {
            session_id: session_id.to_string(),
            workspace_id: ws_id,
            pane_id: p_id,
            base_engine: inst.engine.clone(),
            active_engine: engine,
            provider_session_id: final_prov.clone(),
            cwd,
            had_user_activity: had_activity || final_prov.is_some(),
            last_user_input: last_input,
            spawned_at_unix_ms: inst.spawned_at_unix_ms,
            saved_at_unix_ms: now_unix_ms(),
        });
    }

    final_prov
}

pub fn spawn_session(session_id: &str, cwd: &str, engine: &str) -> Arc<TerminalInstance> {
    spawn_session_with_size(session_id, cwd, engine, 80, 24)
}

pub fn spawn_session_with_size(
    session_id: &str,
    cwd: &str,
    engine: &str,
    cols: u16,
    rows: u16,
) -> Arc<TerminalInstance> {
    spawn_session_with_options(
        session_id,
        cwd,
        engine,
        SpawnOptions {
            cols,
            rows,
            auto_approve: is_agent_cli_engine(engine),
            ..Default::default()
        },
    )
}

/// Puts the complete dispatch manual on a system-prompt engine as that argument,
/// including on resume. Every other engine keeps the birth prompt as the task.
/// Those engines load the manual from `kite-dispatch/SKILL.md`. A raw argv is
/// left untouched.
fn attach_dispatch_manual(
    engine: &str,
    raw: bool,
    _resume: bool,
    system_prompt: Option<String>,
    initial_prompt: Option<String>,
) -> (Option<String>, Option<String>) {
    if raw {
        return (system_prompt, initial_prompt);
    }
    if crate::dispatch::programs::accepts_system_prompt(engine) {
        let system_prompt = system_prompt
            .map(|sys| sanitize_cli_system_prompt(&sys))
            .or_else(|| Some(crate::dispatch::cli::manual_text().to_string()));
        return (system_prompt, initial_prompt);
    }
    (system_prompt, initial_prompt)
}

pub fn spawn_session_with_options(
    session_id: &str,
    cwd: &str,
    engine: &str,
    options: SpawnOptions,
) -> Arc<TerminalInstance> {
    let requested_cols = options.cols;
    let requested_rows = options.rows;
    let hybrid_engine = match &options.mode {
        SpawnMode::Resume { hybrid_shell_agent, .. } => hybrid_shell_agent.as_deref(),
        SpawnMode::Fresh => None,
    };
    let is_agent_cli =
        is_agent_cli_engine(engine) || hybrid_engine.is_some_and(is_agent_cli_engine);
    // The agent is born at the geometry the pane measured. A wider spawn followed by
    // a resize to the real width raced the agent's startup: OpenCode read 80 columns,
    // then the host shrank to 42 before it listened, so it drew 80-column frames into
    // a 42-column ConPTY (captured 2026-11-01).
    let (cols, rows) = (requested_cols, requested_rows);
    log_trace(&format!(
        "spawn_session: session_id={}, cwd={}, engine={}, cols={}, rows={}, mode={:?}",
        session_id, cwd, engine, cols, rows, options.mode
    ));
    let current = std::env::current_dir().ok();
    let target_dir = if std::path::Path::new(cwd).is_dir() {
        std::path::PathBuf::from(cwd)
    } else {
        current.unwrap_or_else(|| std::path::PathBuf::from(cwd))
    };
    let target_dir_str = target_dir.to_string_lossy().into_owned();

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: if rows == 0 { 24 } else { rows },
            cols: if cols == 0 { 80 } else { cols },
            pixel_width: 0,
            pixel_height: 0,
        })
        .expect("failed to open pty");

    let hybrid_agent_opt = match &options.mode {
        SpawnMode::Resume {
            hybrid_shell_agent: Some(agent),
            provider_session_id: Some(_),
            ..
        } if is_generic_shell_engine(engine) && !is_generic_shell_engine(agent) => {
            Some(agent.clone())
        }
        _ => None,
    };

    let resume = matches!(options.mode, SpawnMode::Resume { .. });
    let raw = options
        .raw_argv
        .as_ref()
        .filter(|argv| !argv.is_empty())
        .is_some();
    let manual_engine = hybrid_agent_opt.as_deref().unwrap_or(engine);
    let (system_prompt, initial_prompt) = attach_dispatch_manual(
        manual_engine,
        raw,
        resume,
        options.system_prompt.clone(),
        options.initial_prompt.clone(),
    );

    let mut initial_provider_id: Option<String> = None;
    let mut initial_detected_agent: Option<String> = None;

    let mut agent_terminal = false;
    let mut launcher = "powershell";
    let mut resolved_program_path: Option<String> = None;
    let mut cmd = if let Some(argv) = options.raw_argv.as_ref().filter(|argv| !argv.is_empty()) {
        let mut c = CommandBuilder::new(&argv[0]);
        if argv.len() > 1 {
            c.args(&argv[1..]);
        }
        c.cwd(&target_dir);
        launcher = "raw";
        c
    } else if let Some(ref hybrid_agent) = hybrid_agent_opt {
        // Hybrid shell resume: open PowerShell in the saved CWD and automatically invoke the agent's resume command
        let (agent_args, bound_id) = build_agent_cli_args_ext(
            hybrid_agent,
            session_id,
            &target_dir_str,
            &options.mode,
            initial_prompt.as_deref(),
            options.auto_approve,
            system_prompt.as_deref(),
        );
        initial_provider_id = bound_id;
        initial_detected_agent = Some(canonical_agent_engine(hybrid_agent));

        if let Some(program) = resolve_engine_program(hybrid_agent) {
            resolved_program_path = Some(program.clone());
            agent_terminal = true;
            let (built, kind) = build_agent_command(&program, &agent_args, &target_dir);
            launcher = kind;
            built
        } else {
            let mut c = CommandBuilder::new("powershell.exe");
            c.cwd(&target_dir);
            c.args(["-NoLogo"]);
            c
        }
    } else if let Some(program) = resolve_engine_program(engine) {
        resolved_program_path = Some(program.clone());
        agent_terminal = true;
        let (agent_args, bound_id) = build_agent_cli_args_ext(
            engine,
            session_id,
            &target_dir_str,
            &options.mode,
            initial_prompt.as_deref(),
            options.auto_approve,
            system_prompt.as_deref(),
        );
        initial_provider_id = bound_id;
        initial_detected_agent = Some(canonical_agent_engine(engine));
        let (built, kind) = build_agent_command(&program, &agent_args, &target_dir);
        launcher = kind;
        built
    } else if is_generic_shell_engine(engine) {
        let mut c = CommandBuilder::new("powershell.exe");
        c.cwd(&target_dir);
        c.args(["-NoLogo"]);
        c
    } else {
        let mut c = CommandBuilder::new("powershell.exe");
        c.cwd(&target_dir);
        let looked_for = program_names(engine).join(", ");
        let hint = format!(
            "Write-Host '{engine} was not found ({looked_for}).' -ForegroundColor Yellow"
        );
        c.args([
            "-NoLogo",
            "-NoExit",
            "-Command",
            &hint,
        ]);
        c
    };

    cmd.env("KITE_ENV", "1");
    cmd.env("KITE_SESSION_ID", session_id);
    cmd.env("KITE_DISPATCH", "1");
    let dispatch_address = format!("session:{session_id}");
    cmd.env("KITE_ADDRESS", &dispatch_address);
    let skill = crate::dispatch::cli::install_dispatch_skill();
    cmd.env("KITE_SKILL_FILE", skill.display().to_string());
    let bin = crate::dispatch::cli::install_kite_shim();
    let inherited = std::env::var("PATH").unwrap_or_default();
    let mut path_parts = vec![bin.display().to_string()];
    if let Some(ref prog) = resolved_program_path {
        if let Some(parent) = std::path::Path::new(prog).parent() {
            let p_str = parent.display().to_string();
            if !inherited.to_lowercase().contains(&p_str.to_lowercase()) {
                path_parts.push(p_str);
            }
        }
    }
    if !inherited.is_empty() {
        path_parts.push(inherited);
    }
    let sep = if cfg!(windows) { ";" } else { ":" };
    let path_value = path_parts.join(sep);
    cmd.env("PATH", &path_value);
    cmd.env("AGY_CLI_DISABLE_AUTO_UPDATE", "true");
    if agent_terminal {
        cmd.env("TERM", AGENT_TERMINAL_TERM);
    }
    if let Some(ref ws_id) = options.workspace_id {
        cmd.env("KITE_WORKSPACE_ID", ws_id);
    }
    if let Some(ref p_id) = options.pane_id {
        cmd.env("KITE_PANE_ID", p_id);
    }

    // Inject API credentials from the Kite vault into the agent terminal if not already present in env
    for &var_name in crate::credentials::provider_env_vars(engine) {
        if std::env::var(var_name).is_err() {
            if let Some((key, _)) = crate::credentials::resolve_provider_credential(engine) {
                cmd.env(var_name, key);
                break;
            }
        }
    }

    let trace_engine = initial_detected_agent
        .clone()
        .unwrap_or_else(|| engine.to_string());
    let launch_text = initial_prompt.as_deref().unwrap_or("");
    crate::dispatch::trace::record(&crate::dispatch::trace::handoff_event(
        "launch",
        launch_text,
        crate::dispatch::trace::Fields {
            op: "launch",
            session: session_id,
            engine: &trace_engine,
            status: "",
            pane: "",
            writes: if initial_prompt.is_some() { 1 } else { 0 },
            launcher,
            manual: crate::dispatch::trace::manual_label(system_prompt.is_some(), launch_text),
        },
    ));

    let child = pair
        .slave
        .spawn_command(cmd)
        .expect("failed to spawn command in pty");
    drop(pair.slave);
    let root_pid = child.process_id().unwrap_or(0);

    let reader = pair
        .master
        .try_clone_reader()
        .expect("failed to clone pty reader");
    let writer = Arc::new(Mutex::new(
        pair.master
            .take_writer()
            .expect("failed to take pty writer"),
    ));

    let buffer = Arc::new(Mutex::new(Vec::new()));

    let initial_scrollback = if is_agent_cli {
        delete_scrollback_file(session_id);
        Vec::new()
    } else {
        read_scrollback_file(session_id).unwrap_or_default()
    };
    let scrollback = Arc::new(Mutex::new(initial_scrollback));
    let live_cwd = Arc::new(Mutex::new(target_dir_str.clone()));

    let initial_cols = if cols == 0 { 80 } else { cols };
    let initial_rows = if rows == 0 { 24 } else { rows };
    let mut vt_engine_init = crate::vt_engine::TerminalVtEngine::new(initial_cols, initial_rows);
    if !is_agent_cli {
        if let Ok(sb_guard) = scrollback.lock() {
            if !sb_guard.is_empty() {
                vt_engine_init.feed(&sb_guard);
                let _ = vt_engine_init.take_replies();
            }
        }
    }
    let vt_engine = Arc::new(Mutex::new(vt_engine_init));

    let spawned_at_ms = now_unix_ms();
    let had_initial_activity = match &options.mode {
        SpawnMode::Resume {
            provider_session_id,
            allow_continue_fallback,
            ..
        } => provider_session_id.is_some() || *allow_continue_fallback,
        SpawnMode::Fresh => false,
    };

    let instance = Arc::new(TerminalInstance {
        master: Arc::new(Mutex::new(pair.master)),
        writer,
        child: Arc::new(Mutex::new(child)),
        buffer,
        scrollback,
        vt_engine,
        sequence: AtomicU64::new(0),
        output_byte_offset: AtomicU64::new(0),
        output_capture_order: Mutex::new(()),
        ansi_scan_tail: Mutex::new(Vec::new()),
        cwd: target_dir_str.clone(),
        live_cwd,
        engine: engine.to_string(),
        detected_agent_engine: Arc::new(Mutex::new(initial_detected_agent.clone())),
        provider_session_id: Arc::new(Mutex::new(initial_provider_id.clone())),
        workspace_id: Mutex::new(options.workspace_id.clone()),
        pane_id: Mutex::new(options.pane_id.clone()),
        spawned_at_unix_ms: spawned_at_ms,
        root_pid,
        had_user_activity: AtomicBool::new(had_initial_activity),
        input_line_buffer: Mutex::new(String::new()),
        last_user_input: Mutex::new(None),
        last_bind_attempt_ms: AtomicU64::new(0),
        bind_attempts: std::sync::atomic::AtomicU32::new(0),
        cols: std::sync::atomic::AtomicU16::new(if cols == 0 { 80 } else { cols }),
        rows: std::sync::atomic::AtomicU16::new(if rows == 0 { 24 } else { rows }),
        presentation_live: AtomicBool::new(true),
        exit_notified: AtomicBool::new(false),
        lifecycle_stop: AtomicBool::new(false),
        last_paint_emit_ms: AtomicU64::new(0),
        paint_flush_armed: AtomicBool::new(false),
    });

    let mut start_reader = false;
    if let Ok(mut map) = get_terminals().lock() {
        if map.contains_key(session_id) {
            if let Ok(mut child) = instance.child.lock() {
                let _ = child.kill();
            }
            if let Some(existing) = map.get(session_id) {
                return Arc::clone(existing);
            }
        } else {
            map.insert(session_id.to_string(), Arc::clone(&instance));
            start_reader = true;
        }
    }
    if start_reader {
        spawn_pty_reader(reader, Arc::clone(&instance), session_id.to_string());
        spawn_terminal_lifecycle(session_id.to_string(), Arc::clone(&instance));
    }

    // Record initial session metadata in terminal-sessions.json
    let active_eng = initial_detected_agent.unwrap_or_else(|| engine.to_string());
    let record = PersistedTerminalSession {
        session_id: session_id.to_string(),
        workspace_id: options.workspace_id,
        pane_id: options.pane_id,
        base_engine: engine.to_string(),
        active_engine: active_eng,
        provider_session_id: initial_provider_id,
        cwd: target_dir_str,
        had_user_activity: had_initial_activity,
        last_user_input: None,
        spawned_at_unix_ms: spawned_at_ms,
        saved_at_unix_ms: spawned_at_ms,
    };
    if matches!(options.mode, SpawnMode::Fresh) {
        upsert_persisted_terminal_session_clearing_provider(record);
    } else {
        upsert_persisted_terminal_session(record);
    }

    instance
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

