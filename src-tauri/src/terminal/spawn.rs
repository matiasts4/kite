use crate::logger::log_trace;
use crate::session_resolver::{
    canonical_agent_engine, is_generic_shell_engine, upsert_persisted_terminal_session,
    upsert_persisted_terminal_session_clearing_provider, PersistedTerminalSession,
};
use crate::terminal::codec::now_unix_ms;
use crate::terminal::launcher::{
    build_agent_cli_args_ext, build_agent_command, is_agent_cli_engine, program_names,
    resolve_engine_program, sanitize_cli_system_prompt, AGENT_TERMINAL_TERM,
};
use crate::terminal::lifecycle::{spawn_pty_reader, spawn_terminal_lifecycle};
use crate::terminal::scrollback::{delete_scrollback_file, read_scrollback_file};
use crate::terminal::{get_terminals, SpawnMode, SpawnOptions, TerminalInstance};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

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
pub fn attach_dispatch_manual(
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
