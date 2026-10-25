use crate::logger::log_trace;
use crate::persist::workspace_path;
use crate::session_resolver::{
    canonical_agent_engine, claude_session_file_exists, detect_child_agent_in_shell,
    get_persisted_terminal_session, is_generic_shell_engine, read_persisted_terminal_sessions,
    remove_persisted_terminal_session, resolve_provider_session_id_with_context,
    upsert_persisted_terminal_session, write_persisted_terminal_sessions, PersistedTerminalSession,
};
use portable_pty::{native_pty_system, Child as PtyChild, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use uuid::Uuid;

pub fn to_base64(data: &[u8]) -> String {
    const CHARSET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as usize;
        let b1 = chunk.get(1).copied().unwrap_or(0) as usize;
        let b2 = chunk.get(2).copied().unwrap_or(0) as usize;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(CHARSET[(triple >> 18) & 63] as char);
        out.push(CHARSET[(triple >> 12) & 63] as char);
        if chunk.len() > 1 {
            out.push(CHARSET[(triple >> 6) & 63] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(CHARSET[triple & 63] as char);
        } else {
            out.push('=');
        }
    }
    out
}

const MAX_SCROLLBACK_BYTES: usize = 256 * 1024;
static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

fn now_unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

pub fn terminal_scrollback_dir() -> std::path::PathBuf {
    let base = std::env::var("APPDATA").unwrap_or_else(|_| r"C:\Users\PC\AppData\Roaming".into());
    let folder = if cfg!(debug_assertions) {
        "Kite Code Dev"
    } else {
        "Kite Code"
    };
    let dir = std::path::PathBuf::from(base).join(folder).join("terminals");
    let _ = std::fs::create_dir_all(&dir);
    static PRUNED: std::sync::OnceLock<()> = std::sync::OnceLock::new();
    PRUNED.get_or_init(|| {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            let now = std::time::SystemTime::now();
            for entry in entries.flatten() {
                if let Ok(meta) = entry.metadata() {
                    if let Ok(modified) = meta.modified() {
                        if let Ok(age) = now.duration_since(modified) {
                            if age.as_secs() > 7 * 86400 {
                                let _ = std::fs::remove_file(entry.path());
                            }
                        }
                    }
                }
            }
        }
    });
    dir
}

pub fn scrollback_path_for_session(session_id: &str) -> std::path::PathBuf {
    let safe_id: String = session_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    terminal_scrollback_dir().join(format!("{}.scrollback", safe_id))
}

pub fn read_scrollback_file(session_id: &str) -> Option<Vec<u8>> {
    let path = scrollback_path_for_session(session_id);
    if path.is_file() {
        std::fs::read(&path).ok().filter(|b| !b.is_empty())
    } else {
        None
    }
}

pub fn write_scrollback_file(session_id: &str, bytes: &[u8]) {
    let path = scrollback_path_for_session(session_id);
    let _ = std::fs::write(path, bytes);
}

pub fn delete_scrollback_file(session_id: &str) {
    let path = scrollback_path_for_session(session_id);
    let _ = std::fs::remove_file(path);
}

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
        }
    }
}

pub struct TerminalInstance {
    pub master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    pub writer: Arc<Mutex<Box<dyn Write + Send>>>,
    pub child: Arc<Mutex<Box<dyn PtyChild + Send>>>,
    pub buffer: Arc<Mutex<Vec<u8>>>,
    pub scrollback: Arc<Mutex<Vec<u8>>>,
    pub sequence: AtomicU64,
    pub cwd: String,
    pub live_cwd: Arc<Mutex<String>>,
    pub engine: String,
    pub detected_agent_engine: Arc<Mutex<Option<String>>>,
    pub provider_session_id: Arc<Mutex<Option<String>>>,
    pub workspace_id: Mutex<Option<String>>,
    pub pane_id: Mutex<Option<String>>,
    pub spawned_at_unix_ms: i64,
    pub had_user_activity: AtomicBool,
    pub input_line_buffer: Mutex<String>,
    pub last_user_input: Mutex<Option<String>>,
    pub last_bind_attempt_ms: AtomicU64,
    pub bind_attempts: std::sync::atomic::AtomicU32,
    pub cols: std::sync::atomic::AtomicU16,
    pub rows: std::sync::atomic::AtomicU16,
}

pub fn get_terminals() -> &'static Mutex<HashMap<String, Arc<TerminalInstance>>> {
    static INSTANCE: std::sync::OnceLock<Mutex<HashMap<String, Arc<TerminalInstance>>>> =
        std::sync::OnceLock::new();
    INSTANCE.get_or_init(|| Mutex::new(HashMap::new()))
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

fn drain_buffer_into_scrollback(session_id: &str, inst: &TerminalInstance) -> Option<Vec<u8>> {
    let mut pending = Vec::new();
    if let Ok(mut buf) = inst.buffer.lock() {
        if !buf.is_empty() {
            pending = std::mem::take(&mut *buf);
        }
    }
    if let Ok(mut sb) = inst.scrollback.lock() {
        if !pending.is_empty() {
            sb.extend_from_slice(&pending);
            if sb.len() > MAX_SCROLLBACK_BYTES {
                let excess = sb.len() - MAX_SCROLLBACK_BYTES;
                sb.drain(0..excess);
            }
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
    if is_generic_shell_engine(&inst.engine) {
        if let Some(detected_child) = root_pid.and_then(detect_child_agent_in_shell) {
            inst.had_user_activity.store(true, Ordering::Relaxed);
            if let Ok(mut det) = inst.detected_agent_engine.lock() {
                *det = Some(detected_child);
            }
        }
    }

    let engine = inst
        .detected_agent_engine
        .lock()
        .ok()
        .and_then(|d| d.clone())
        .unwrap_or_else(|| canonical_agent_engine(&inst.engine));

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
    let _ = drain_buffer_into_scrollback(session_id, inst);

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

fn program_names(engine: &str) -> &'static [&'static str] {
    match engine {
        "claude-code" | "claude" => &["claude"],
        "codex" => &["codex"],
        "cursor" => &["cursor-agent", "agent"],
        "gemini" => &["gemini"],
        "github-copilot" => &["copilot"],
        "droid" => &["droid"],
        "open-code" | "opencode" => &["opencode"],
        "deep-seek" | "deepseek" => &["deepseek"],
        "grok" => &["grok"],
        "kimi" => &["kimi"],
        "amp" => &["amp"],
        "antigravity" | "agy" => &["agy"],
        "gentle-shell" | "gentleshell" | "gentle" | "gentle-pi" => &["gentle-shell", "pi"],
        "aider" => &["aider"],
        "muse" => &["muse"],
        _ => &[],
    }
}

fn where_program(name: &str) -> Option<String> {
    let path_var = std::env::var_os("PATH")?;
    let path_exts: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC".to_string())
            .split(';')
            .filter(|ext| !ext.is_empty())
            .map(|ext| ext.to_lowercase())
            .collect()
    } else {
        Vec::new()
    };

    for dir in std::env::split_paths(&path_var) {
        let direct = dir.join(name);
        if direct.is_file() {
            return Some(direct.to_string_lossy().to_string());
        }
        if cfg!(windows) {
            for ext in &path_exts {
                let with_ext = dir.join(format!("{}{}", name, ext));
                if with_ext.is_file() {
                    return Some(with_ext.to_string_lossy().to_string());
                }
            }
        }
    }
    None
}

fn known_program_path(name: &str) -> Option<String> {
    let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
    let appdata = std::env::var("APPDATA").unwrap_or_default();
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    let mut candidates = Vec::new();
    if name == "agy" {
        candidates.push(
            std::path::PathBuf::from(&local)
                .join("agy")
                .join("bin")
                .join("agy.exe"),
        );
    }
    if name == "codex" {
        candidates.push(
            std::path::PathBuf::from(&local)
                .join("Programs")
                .join("OpenAI")
                .join("codex.exe"),
        );
    }
    candidates.push(
        std::path::PathBuf::from(&appdata)
            .join("npm")
            .join(format!("{name}.cmd")),
    );
    candidates.push(
        std::path::PathBuf::from(&home)
            .join(".local")
            .join("bin")
            .join(format!("{name}.exe")),
    );
    candidates.push(
        std::path::PathBuf::from(&home)
            .join(".cargo")
            .join("bin")
            .join(format!("{name}.exe")),
    );
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .map(|path| path.to_string_lossy().into_owned())
}

pub fn engine_installed(engine: &str) -> bool {
    resolve_engine_program(engine).is_some()
}

fn resolve_engine_program(engine: &str) -> Option<String> {
    for name in program_names(engine) {
        if let Some(path) = known_program_path(name).or_else(|| where_program(name)) {
            return Some(path);
        }
    }
    None
}

/// Builds the CLI arguments for launching or resuming an AI agent engine.
/// Note: We intentionally avoid `--continue` / `resume --last` when `provider_session_id` is `None`,
/// because in multi-pane workspaces `--continue` causes panes without a bound ID to hijack
/// whichever other conversation happens to be unlocked or second-most-recent in the workspace.
pub fn build_agent_cli_args(
    engine: &str,
    session_id: &str,
    cwd: &str,
    mode: &SpawnMode,
) -> (Vec<String>, Option<String>) {
    build_agent_cli_args_ext(engine, session_id, cwd, mode, None, false, None)
}

pub fn build_agent_cli_args_ext(
    engine: &str,
    session_id: &str,
    cwd: &str,
    mode: &SpawnMode,
    initial_prompt: Option<&str>,
    auto_approve: bool,
    system_prompt: Option<&str>,
) -> (Vec<String>, Option<String>) {
    let canonical = canonical_agent_engine(engine);
    let mut args: Vec<String> = Vec::new();
    let mut bound_id: Option<String> = None;

    match mode {
        SpawnMode::Fresh => {
            match canonical.as_str() {
                "grok" => {
                    if auto_approve {
                        args.push("--always-approve".to_string());
                    }
                    if let Some(sys) = system_prompt {
                        args.push("--system-prompt-override".to_string());
                        args.push(sys.to_string());
                    }
                    if let Some(prompt) = initial_prompt {
                        args.push(prompt.to_string());
                    }
                }
                "codex" => {
                    if auto_approve {
                        args.push("--approve-for-me".to_string());
                    }
                    if let Some(prompt) = initial_prompt {
                        args.push(prompt.to_string());
                    }
                }
                "antigravity" => {
                    if auto_approve {
                        args.push("--dangerously-skip-permissions".to_string());
                    }
                    if let Some(prompt) = initial_prompt {
                        args.push("-i".to_string());
                        args.push(prompt.to_string());
                    }
                }
                "claude-code" => {
                    let target_uuid = if Uuid::parse_str(session_id).is_ok() {
                        session_id.to_string()
                    } else {
                        Uuid::new_v4().to_string()
                    };
                    args.push("--session-id".to_string());
                    args.push(target_uuid.clone());
                    bound_id = Some(target_uuid);

                    if auto_approve {
                        args.push("--permission-mode".to_string());
                        args.push("bypassPermissions".to_string());
                    }
                    if let Some(sys) = system_prompt {
                        args.push("--system-prompt".to_string());
                        args.push(sys.to_string());
                    }
                    if let Some(prompt) = initial_prompt {
                        args.push(prompt.to_string());
                    }
                }
                "open-code" => {
                    if auto_approve {
                        args.push("--auto".to_string());
                    }
                    if let Some(prompt) = initial_prompt {
                        args.push("--prompt".to_string());
                        args.push(prompt.to_string());
                    }
                }
                "gentle-shell" => {
                    args.push("--tui-mode".to_string());
                    args.push("regular".to_string());
                    if auto_approve {
                        args.push("--approve".to_string());
                    }
                    if let Some(prompt) = initial_prompt {
                        args.push(prompt.to_string());
                    }
                }
                _ => {
                    if let Some(prompt) = initial_prompt {
                        args.push(prompt.to_string());
                    }
                }
            }
        }
        SpawnMode::Resume {
            provider_session_id,
            allow_continue_fallback,
            ..
        } => {
            match canonical.as_str() {
                "antigravity" => {
                    if let Some(id) = provider_session_id.as_deref().filter(|s| !s.is_empty()) {
                        args.push("--conversation".to_string());
                        args.push(id.to_string());
                        bound_id = Some(id.to_string());
                    }
                    if auto_approve {
                        args.push("--dangerously-skip-permissions".to_string());
                    }
                    if let Some(prompt) = initial_prompt {
                        args.push("-i".to_string());
                        args.push(prompt.to_string());
                    }
                }
                "codex" => {
                    if let Some(id) = provider_session_id.as_deref().filter(|s| !s.is_empty()) {
                        args.push("resume".to_string());
                        args.push(id.to_string());
                        bound_id = Some(id.to_string());
                    }
                    if auto_approve {
                        args.push("--approve-for-me".to_string());
                    }
                    if let Some(prompt) = initial_prompt {
                        args.push(prompt.to_string());
                    }
                }
                "claude-code" => {
                    let candidate_id = provider_session_id
                        .as_deref()
                        .filter(|s| !s.is_empty())
                        .or_else(|| {
                            if Uuid::parse_str(session_id).is_ok() {
                                Some(session_id)
                            } else {
                                None
                            }
                        });
                    if let Some(id) = candidate_id {
                        if claude_session_file_exists(cwd, id) {
                            args.push("--resume".to_string());
                            args.push(id.to_string());
                            bound_id = Some(id.to_string());
                        } else {
                            let fresh_uuid = candidate_id
                                .filter(|id| Uuid::parse_str(id).is_ok())
                                .map(str::to_string)
                                .unwrap_or_else(|| Uuid::new_v4().to_string());
                            args.push("--session-id".to_string());
                            args.push(fresh_uuid.clone());
                            bound_id = Some(fresh_uuid);
                        }
                    } else {
                        let fresh_uuid = Uuid::new_v4().to_string();
                        args.push("--session-id".to_string());
                        args.push(fresh_uuid.clone());
                        bound_id = Some(fresh_uuid);
                    }
                    if auto_approve {
                        args.push("--permission-mode".to_string());
                        args.push("bypassPermissions".to_string());
                    }
                    if let Some(prompt) = initial_prompt {
                        args.push(prompt.to_string());
                    }
                }
                "open-code" => {
                    if let Some(id) = provider_session_id.as_deref().filter(|s| !s.is_empty()) {
                        args.push("--session".to_string());
                        args.push(id.to_string());
                        bound_id = Some(id.to_string());
                    }
                    if auto_approve {
                        args.push("--auto".to_string());
                    }
                    if let Some(prompt) = initial_prompt {
                        args.push("--prompt".to_string());
                        args.push(prompt.to_string());
                    }
                }
                "grok" => {
                    if let Some(id) = provider_session_id.as_deref().filter(|s| !s.is_empty()) {
                        args.push("-r".to_string());
                        args.push(id.to_string());
                        bound_id = Some(id.to_string());
                    }
                    if auto_approve {
                        args.push("--always-approve".to_string());
                    }
                    if let Some(prompt) = initial_prompt {
                        args.push(prompt.to_string());
                    }
                }
                "gemini" => {
                    if let Some(id_or_path) = provider_session_id.as_deref().filter(|s| !s.is_empty()) {
                        if std::path::Path::new(id_or_path).is_file() {
                            args.push("--session-file".to_string());
                            args.push(id_or_path.to_string());
                            bound_id = Some(id_or_path.to_string());
                        }
                    }
                }
                "kimi" => {
                    if let Some(id) = provider_session_id.as_deref().filter(|s| !s.is_empty()) {
                        args.push("--session".to_string());
                        args.push(id.to_string());
                        bound_id = Some(id.to_string());
                    }
                }
                "cursor" | "droid" => {
                    if let Some(id) = provider_session_id.as_deref().filter(|s| !s.is_empty()) {
                        args.push("--resume".to_string());
                        args.push(id.to_string());
                        bound_id = Some(id.to_string());
                    }
                }
                "aider" => {
                    if *allow_continue_fallback || provider_session_id.is_some() {
                        args.push("--restore-chat-history".to_string());
                    }
                }
                "gentle-shell" => {
                    args.push("--tui-mode".to_string());
                    args.push("regular".to_string());
                    if let Some(id) = provider_session_id.as_deref().filter(|s| !s.is_empty()) {
                        args.push("--session".to_string());
                        args.push(id.to_string());
                        bound_id = Some(id.to_string());
                    } else if *allow_continue_fallback {
                        args.push("--continue".to_string());
                    }
                    if auto_approve {
                        args.push("--approve".to_string());
                    }
                    if let Some(prompt) = initial_prompt {
                        args.push(prompt.to_string());
                    }
                }
                _ => {}
            }
        }
    }

    (args, bound_id)
}

/// Scans PTY output chunks for OSC 9;9;<path>\x07 or OSC 7;file://... sequences to track live CWD.
pub fn extract_osc_cwd(bytes: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(bytes);
    // Look for OSC 9;9;<path> terminated by BEL (\x07) or ST (\x1b\\)
    if let Some(idx) = text.rfind("\x1b]9;9;") {
        let after = &text[idx + 6..];
        let end = after
            .find('\x07')
            .or_else(|| after.find("\x1b\\"))
            .unwrap_or(0);
        if end > 0 {
            let candidate = after[..end].trim().trim_matches('"');
            if !candidate.is_empty() && std::path::Path::new(candidate).is_dir() {
                return Some(candidate.to_string());
            }
        }
    }
    None
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
            ..Default::default()
        },
    )
}

pub fn spawn_session_with_options(
    session_id: &str,
    cwd: &str,
    engine: &str,
    options: SpawnOptions,
) -> Arc<TerminalInstance> {
    let cols = options.cols;
    let rows = options.rows;
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
            ..
        } if is_generic_shell_engine(engine) && !is_generic_shell_engine(agent) => {
            Some(agent.clone())
        }
        _ => None,
    };

    let mut initial_provider_id: Option<String> = None;
    let mut initial_detected_agent: Option<String> = None;

    let mut cmd = if let Some(ref hybrid_agent) = hybrid_agent_opt {
        // Hybrid shell resume: open PowerShell in the saved CWD and automatically invoke the agent's resume command
        let (agent_args, bound_id) = build_agent_cli_args_ext(
            hybrid_agent,
            session_id,
            &target_dir_str,
            &options.mode,
            options.initial_prompt.as_deref(),
            options.auto_approve,
            options.system_prompt.as_deref(),
        );
        initial_provider_id = bound_id;
        initial_detected_agent = Some(canonical_agent_engine(hybrid_agent));

        let mut c = CommandBuilder::new("powershell.exe");
        c.cwd(&target_dir);
        if let Some(program) = resolve_engine_program(hybrid_agent) {
            let quoted_prog = program.replace('\'', "''");
            let quoted_args: Vec<String> = agent_args
                .iter()
                .map(|a| format!("'{}'", a.replace('\'', "''")))
                .collect();
            let launch_cmd = if quoted_args.is_empty() {
                format!("& '{quoted_prog}'")
            } else {
                format!("& '{quoted_prog}' {}", quoted_args.join(" "))
            };
            c.args([
                "-NoLogo",
                "-NoExit",
                "-Command",
                &launch_cmd,
            ]);
        } else {
            c.args(["-NoLogo"]);
        }
        c
    } else if let Some(program) = resolve_engine_program(engine) {
        let (agent_args, bound_id) = build_agent_cli_args_ext(
            engine,
            session_id,
            &target_dir_str,
            &options.mode,
            options.initial_prompt.as_deref(),
            options.auto_approve,
            options.system_prompt.as_deref(),
        );
        initial_provider_id = bound_id;
        initial_detected_agent = Some(canonical_agent_engine(engine));
        let mut c = CommandBuilder::new("powershell.exe");
        c.cwd(&target_dir);
        let quoted = program.replace('\'', "''");
        let quoted_args: Vec<String> = agent_args
            .iter()
            .map(|a| format!("'{}'", a.replace('\'', "''")))
            .collect();
        let launch = if quoted_args.is_empty() {
            format!("& '{quoted}'")
        } else {
            format!("& '{quoted}' {}", quoted_args.join(" "))
        };
        c.args([
            "-NoLogo",
            "-NoExit",
            "-Command",
            &launch,
        ]);
        c
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
    cmd.env("AGY_CLI_DISABLE_AUTO_UPDATE", "true");
    if let Some(ref ws_id) = options.workspace_id {
        cmd.env("KITE_WORKSPACE_ID", ws_id);
    }
    if let Some(ref p_id) = options.pane_id {
        cmd.env("KITE_PANE_ID", p_id);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .expect("failed to spawn command in pty");
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .expect("failed to clone pty reader");
    let writer = pair
        .master
        .take_writer()
        .expect("failed to take pty writer");

    let buffer = Arc::new(Mutex::new(Vec::new()));
    let buf_reader = Arc::clone(&buffer);

    let initial_scrollback = read_scrollback_file(session_id).unwrap_or_default();
    let scrollback = Arc::new(Mutex::new(initial_scrollback));
    let scrollback_reader = Arc::clone(&scrollback);
    let live_cwd = Arc::new(Mutex::new(target_dir_str.clone()));
    let live_cwd_reader = Arc::clone(&live_cwd);
    let session_id_owned = session_id.to_string();

    std::thread::spawn(move || {
        let mut temp = [0u8; 32768];
        let mut dirty = false;
        let mut last_flush = std::time::Instant::now();
        while let Ok(n) = reader.read(&mut temp) {
            if n == 0 {
                break;
            }
            if let Some(osc_dir) = extract_osc_cwd(&temp[..n]) {
                if let Ok(mut cwd_guard) = live_cwd_reader.lock() {
                    *cwd_guard = osc_dir;
                }
            }
            if let Ok(mut b) = buf_reader.lock() {
                b.extend_from_slice(&temp[..n]);
            }
            if let Ok(mut s) = scrollback_reader.lock() {
                s.extend_from_slice(&temp[..n]);
                if s.len() > MAX_SCROLLBACK_BYTES {
                    let excess = s.len() - MAX_SCROLLBACK_BYTES;
                    s.drain(0..excess);
                }
                dirty = true;
            }
            if dirty && last_flush.elapsed() >= std::time::Duration::from_millis(500) {
                if let Ok(s) = scrollback_reader.lock() {
                    write_scrollback_file(&session_id_owned, &s);
                }
                dirty = false;
                last_flush = std::time::Instant::now();
            }
        }
        if dirty {
            if let Ok(s) = scrollback_reader.lock() {
                write_scrollback_file(&session_id_owned, &s);
            }
        }
    });

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
        writer: Arc::new(Mutex::new(writer)),
        child: Arc::new(Mutex::new(child)),
        buffer,
        scrollback,
        sequence: AtomicU64::new(0),
        cwd: target_dir_str.clone(),
        live_cwd,
        engine: engine.to_string(),
        detected_agent_engine: Arc::new(Mutex::new(initial_detected_agent.clone())),
        provider_session_id: Arc::new(Mutex::new(initial_provider_id.clone())),
        workspace_id: Mutex::new(options.workspace_id.clone()),
        pane_id: Mutex::new(options.pane_id.clone()),
        spawned_at_unix_ms: spawned_at_ms,
        had_user_activity: AtomicBool::new(had_initial_activity),
        input_line_buffer: Mutex::new(String::new()),
        last_user_input: Mutex::new(None),
        last_bind_attempt_ms: AtomicU64::new(0),
        bind_attempts: std::sync::atomic::AtomicU32::new(0),
        cols: std::sync::atomic::AtomicU16::new(if cols == 0 { 80 } else { cols }),
        rows: std::sync::atomic::AtomicU16::new(if rows == 0 { 24 } else { rows }),
    });

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
        }
    }

    // Record initial session metadata in terminal-sessions.json
    let active_eng = initial_detected_agent.unwrap_or_else(|| engine.to_string());
    upsert_persisted_terminal_session(PersistedTerminalSession {
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
    });

    instance
}

#[tauri::command]
pub fn start_terminal(request: serde_json::Value) -> serde_json::Value {
    let req = request.get("request").unwrap_or(&request);
    let session_id = req
        .get("sessionId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    let cwd = workspace_cwd(req);
    let workspace_id = extract_workspace_id(req);
    let pane_id = extract_pane_id(req);

    let engine = req
        .get("engine")
        .or_else(|| req.get("owner").and_then(|o| o.get("engine")))
        .and_then(|e| e.as_str())
        .unwrap_or("powershell");

    let cols = req.get("columns").and_then(|v| v.as_u64()).unwrap_or(80) as u16;
    let rows = req.get("rows").and_then(|v| v.as_u64()).unwrap_or(24) as u16;

    {
        let map = get_terminals().lock().unwrap();
        if let Some(inst) = map.get(&session_id) {
            if let Some(ref ws_id) = workspace_id {
                if let Ok(mut w) = inst.workspace_id.lock() {
                    if w.is_none() {
                        *w = Some(ws_id.clone());
                    }
                }
            }
            if let Some(ref p_id) = pane_id {
                if let Ok(mut p) = inst.pane_id.lock() {
                    if p.is_none() {
                        *p = Some(p_id.clone());
                    }
                }
            }
            let sb = drain_buffer_into_scrollback(&session_id, inst);
            return serde_json::json!({
                "sessionId": session_id,
                "attachedToExisting": true,
                "scrollbackBase64": sb.as_deref().map(to_base64),
                "host": { "backend": "conpty", "buildNumber": 22631 },
                "restore": { "kind": "reattached" }
            });
        }
    }

    let initial_prompt = req
        .get("initialPrompt")
        .or_else(|| req.get("prompt"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let auto_approve = req
        .get("autoApprove")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let system_prompt = req
        .get("systemPrompt")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    spawn_session_with_options(
        &session_id,
        &cwd,
        engine,
        SpawnOptions {
            cols,
            rows,
            workspace_id,
            pane_id,
            mode: SpawnMode::Fresh,
            initial_prompt,
            auto_approve,
            system_prompt,
        },
    );

    let disk_scrollback = read_scrollback_file(&session_id).map(|b| to_base64(&b));

    serde_json::json!({
        "sessionId": session_id,
        "attachedToExisting": false,
        "scrollbackBase64": disk_scrollback,
        "host": { "backend": "conpty", "buildNumber": 22631 },
        "restore": { "kind": "startedFresh", "reason": "noConversation" }
    })
}

#[tauri::command]
pub fn attach_terminal(request: serde_json::Value) -> serde_json::Value {
    let req = request.get("request").unwrap_or(&request);
    let session_id = req
        .get("sessionId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    let workspace_id = extract_workspace_id(req);
    let pane_id = extract_pane_id(req);

    let (attached_to_existing, initial_scrollback) = {
        let mut map = get_terminals().lock().unwrap();
        if let Some(inst) = map.get(&session_id) {
            let is_alive = if let Ok(mut child) = inst.child.lock() {
                child.try_wait().ok().flatten().is_none()
            } else {
                true
            };

            if is_alive {
                if let Some(ref ws_id) = workspace_id {
                    if let Ok(mut w) = inst.workspace_id.lock() {
                        if w.is_none() {
                            *w = Some(ws_id.clone());
                        }
                    }
                }
                if let Some(ref p_id) = pane_id {
                    if let Ok(mut p) = inst.pane_id.lock() {
                        if p.is_none() {
                            *p = Some(p_id.clone());
                        }
                    }
                }
                let sb = drain_buffer_into_scrollback(&session_id, inst);
                (true, sb)
            } else {
                map.remove(&session_id);
                (false, None)
            }
        } else {
            (false, None)
        }
    };

    let scrollback_base64 = if attached_to_existing {
        initial_scrollback.as_deref().map(to_base64)
    } else {
        let _resolve_guard = get_session_resolve_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let claimed_ids = get_globally_claimed_provider_ids(&session_id);

        let disk_bytes = read_scrollback_file(&session_id);
        let persisted = get_persisted_terminal_session(&session_id);
        let default_cwd = workspace_cwd(req);
        let cwd = persisted
            .as_ref()
            .map(|p| p.cwd.as_str())
            .filter(|dir| !dir.is_empty() && std::path::Path::new(dir).is_dir())
            .unwrap_or(&default_cwd)
            .to_string();

        let requested_engine = req
            .get("engine")
            .and_then(|value| value.as_str())
            .filter(|engine| !engine.is_empty());
        let engine = requested_engine
            .or_else(|| persisted.as_ref().map(|p| p.base_engine.as_str()))
            .filter(|e| !e.is_empty())
            .unwrap_or("powershell")
            .to_string();

        let cols = req
            .get("columns")
            .and_then(|value| value.as_u64())
            .unwrap_or(80) as u16;
        let rows = req
            .get("rows")
            .and_then(|value| value.as_u64())
            .unwrap_or(24) as u16;

        let mut is_agent_cli_restore = !is_generic_shell_engine(&engine);

        // Determine if we should spawn in Resume mode (either from persisted session record or existing scrollback)
        let mode = if let Some(ref saved) = persisted {
            let hybrid_shell_agent = if is_generic_shell_engine(&engine)
                && !is_generic_shell_engine(&saved.active_engine)
            {
                is_agent_cli_restore = true;
                Some(saved.active_engine.clone())
            } else {
                None
            };
            let effective_engine = hybrid_shell_agent.as_deref().unwrap_or(&engine);
            let valid_saved_prov_id = saved.provider_session_id.clone().filter(|id| {
                let is_claimed = claimed_ids.contains(id);
                if is_claimed {
                    log_trace(&format!(
                        "attach_terminal: saved provider session {} for terminal {} is already claimed by another terminal; invalidating and re-resolving",
                        id, session_id
                    ));
                }
                !is_claimed
            });
            let resolved_provider_id = valid_saved_prov_id.or_else(|| {
                if !is_generic_shell_engine(effective_engine) {
                    resolve_provider_session_id_with_context(
                        effective_engine,
                        &cwd,
                        &session_id,
                        None,
                        saved.spawned_at_unix_ms,
                        &claimed_ids,
                        None,
                        saved.last_user_input.as_deref(),
                    )
                } else {
                    None
                }
            });
            SpawnMode::Resume {
                provider_session_id: resolved_provider_id,
                allow_continue_fallback: saved.had_user_activity,
                hybrid_shell_agent,
            }
        } else if disk_bytes.is_some() && !is_generic_shell_engine(&engine) {
            let resolved_provider_id = resolve_provider_session_id_with_context(
                &engine,
                &cwd,
                &session_id,
                None,
                0,
                &claimed_ids,
                None,
                None,
            );
            SpawnMode::Resume {
                provider_session_id: resolved_provider_id,
                allow_continue_fallback: false,
                hybrid_shell_agent: None,
            }
        } else {
            SpawnMode::Fresh
        };

        // For AI agent CLIs (agy, claude, codex, opencode), the CLI renders its own TUI upon
        // spawning/resuming. Clear the pre-restart .scrollback file after resolving the session ID
        // so the old TUI screen is not concatenated with the newly spawned TUI screen.
        if is_agent_cli_restore {
            delete_scrollback_file(&session_id);
        }

        let resolved_ws_id = workspace_id
            .or_else(|| persisted.as_ref().and_then(|p| p.workspace_id.clone()));
        let resolved_pane_id = pane_id
            .or_else(|| persisted.as_ref().and_then(|p| p.pane_id.clone()));

        spawn_session_with_options(
            &session_id,
            &cwd,
            &engine,
            SpawnOptions {
                cols,
                rows,
                workspace_id: resolved_ws_id,
                pane_id: resolved_pane_id,
                mode,
                ..Default::default()
            },
        );

        if is_agent_cli_restore {
            None
        } else {
            disk_bytes.as_deref().map(to_base64)
        }
    };

    serde_json::json!({
        "sessionId": session_id,
        "attachedToExisting": attached_to_existing,
        "scrollbackBase64": scrollback_base64,
        "host": { "backend": "conpty", "buildNumber": 22631 },
        "restore": { "kind": if attached_to_existing { "reattached" } else { "restoredFromDisk" } }
    })
}

#[tauri::command]
pub fn read_terminal_output(request: serde_json::Value) -> serde_json::Value {
    let req = request.get("request").unwrap_or(&request);
    let session_id = req.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
    let instance = {
        let map = get_terminals().lock().unwrap();
        map.get(session_id).cloned()
    };

    if let Some(inst) = instance {
        let mut bytes = Vec::new();
        if let Ok(mut buf) = inst.buffer.lock() {
            if !buf.is_empty() {
                bytes = std::mem::take(&mut *buf);
            }
        }

        let now = now_unix_ms();

        // Periodically check if an active terminal still needs its providerSessionId bound.
        // Generic shells (PowerShell, cmd) never need binding unless a child agent was detected.
        // AI agents attempt binding with progressive backoff and stop after 4 attempts.
        let needs_bind = inst
            .provider_session_id
            .lock()
            .ok()
            .and_then(|p| p.clone())
            .is_none();
        let is_shell = is_generic_shell_engine(&inst.engine);
        let shell_has_agent = is_shell
            && inst
                .detected_agent_engine
                .lock()
                .ok()
                .and_then(|d| d.clone())
                .is_some();
        let should_attempt = needs_bind && (!is_shell || shell_has_agent);

        if should_attempt {
            let attempts = inst.bind_attempts.load(Ordering::Relaxed);
            if attempts < 4 {
                let last_attempt = inst.last_bind_attempt_ms.load(Ordering::Relaxed) as i64;
                let required_gap_ms = match attempts {
                    0 => 1_200,
                    1 => 3_500,
                    2 => 8_000,
                    _ => 18_000,
                };
                if now.saturating_sub(last_attempt) >= required_gap_ms {
                    inst.last_bind_attempt_ms
                        .store(now as u64, Ordering::Relaxed);
                    inst.bind_attempts.fetch_add(1, Ordering::Relaxed);
                    let sid = session_id.to_string();
                    let inst_clone = Arc::clone(&inst);
                    std::thread::spawn(move || {
                        let _ = try_bind_provider_session_id(&sid, &inst_clone);
                    });
                }
            }
        }

        if !bytes.is_empty() {
            let seq = inst.sequence.fetch_add(1, Ordering::SeqCst);
            return serde_json::json!({
                "kind": "output",
                "sequence": seq,
                "bytesBase64": to_base64(&bytes),
                "turnStartedAtUnixMs": now,
                "waitingForInput": false
            });
        }

        if let Ok(mut child) = inst.child.lock() {
            if let Ok(Some(status)) = child.try_wait() {
                return serde_json::json!({
                    "kind": "exited",
                    "status": {
                        "code": status.exit_code() as i64,
                        "signal": serde_json::Value::Null
                    }
                });
            }
        }

        return serde_json::json!({
            "kind": "idle",
            "turnStartedAtUnixMs": now,
            "waitingForInput": true
        });
    }

    serde_json::json!({
        "kind": "idle",
        "turnStartedAtUnixMs": 0,
        "waitingForInput": true
    })
}

#[tauri::command]
pub fn write_terminal(request: serde_json::Value) -> serde_json::Value {
    let req = request.get("request").unwrap_or(&request);
    let session_id = req.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
    let input = req.get("input").and_then(|v| v.as_str()).unwrap_or("");

    let instance = {
        let map = get_terminals().lock().unwrap();
        map.get(session_id).cloned()
    };

    if let Some(inst) = instance {
        let mut submitted_line = false;
        if !input.is_empty() {
            inst.had_user_activity.store(true, Ordering::Relaxed);
            if let Ok(mut line_buf) = inst.input_line_buffer.lock() {
                for ch in input.chars() {
                    if ch == '\r' || ch == '\n' {
                        submitted_line = true;
                        let trimmed = line_buf.trim().to_string();
                        if trimmed.len() >= 2 && !trimmed.starts_with('\x1b') {
                            if let Ok(mut last) = inst.last_user_input.lock() {
                                *last = Some(trimmed);
                            }
                        }
                        line_buf.clear();
                    } else if ch == '\x08' || ch == '\x7f' {
                        let _ = line_buf.pop();
                    } else if !ch.is_control() && line_buf.len() < 4096 {
                        line_buf.push(ch);
                    }
                }
            }
        }
        if let Ok(mut writer) = inst.writer.lock() {
            let _ = writer.write_all(input.as_bytes());
            let _ = writer.flush();
        }

        if submitted_line {
            inst.bind_attempts.store(0, Ordering::Relaxed);
            let sid = session_id.to_string();
            let inst_clone = Arc::clone(&inst);
            std::thread::spawn(move || {
                // Retry binding across progressive intervals as the CLI creates its lock/transcript
                for delay_ms in [350_u64, 900, 2000, 4000] {
                    std::thread::sleep(std::time::Duration::from_millis(delay_ms));
                    if try_bind_provider_session_id(&sid, &inst_clone).is_some() {
                        break;
                    }
                }
            });
        }
    }

    serde_json::Value::Null
}

#[tauri::command]
pub fn resize_terminal(request: serde_json::Value) -> serde_json::Value {
    let req = request.get("request").unwrap_or(&request);
    let session_id = req.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
    let cols = req.get("columns").and_then(|v| v.as_u64()).unwrap_or(80) as u16;
    let rows = req.get("rows").and_then(|v| v.as_u64()).unwrap_or(24) as u16;

    let instance = {
        let map = get_terminals().lock().unwrap();
        map.get(session_id).cloned()
    };

    if let Some(inst) = instance {
        inst.cols.store(cols, Ordering::Relaxed);
        inst.rows.store(rows, Ordering::Relaxed);
        let _ = inst.master.lock().unwrap().resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        });
    }

    serde_json::Value::Null
}

#[tauri::command]
pub fn report_terminal_agent_detected(request: serde_json::Value) -> serde_json::Value {
    let req = request.get("request").unwrap_or(&request);
    let session_id = req.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
    let engine = req.get("engine").and_then(|v| v.as_str()).unwrap_or("");
    if session_id.is_empty() || engine.is_empty() || is_generic_shell_engine(engine) {
        return serde_json::Value::Null;
    }

    let canonical = canonical_agent_engine(engine);
    let instance = {
        let map = get_terminals().lock().unwrap();
        map.get(session_id).cloned()
    };
    if let Some(inst) = instance {
        inst.had_user_activity.store(true, Ordering::Relaxed);
        if let Ok(mut det) = inst.detected_agent_engine.lock() {
            *det = Some(canonical);
        }
        let _ = try_bind_provider_session_id(session_id, &inst);
    }
    serde_json::Value::Null
}

/// Synchronously flushes all terminal scrollbacks, captures live CWDs, child agent processes,
/// and provider session IDs into `terminal-sessions.json`, and terminates ConPTY processes
/// cleanly WITHOUT deleting `.scrollback` files.
pub fn snapshot_and_shutdown_all_terminals(reason: &str) {
    if SHUTTING_DOWN.swap(true, Ordering::SeqCst) {
        return;
    }
    log_trace(&format!(
        "snapshot_and_shutdown_all_terminals invoked: reason={}",
        reason
    ));

    let active_instances: Vec<(String, Arc<TerminalInstance>)> = {
        let Ok(mut map) = get_terminals().lock() else {
            return;
        };
        map.drain().collect()
    };

    if active_instances.is_empty() {
        return;
    }

    let mut persisted_map = read_persisted_terminal_sessions();
    let mut claimed_provider_ids: HashSet<String> = HashSet::new();
    let now = now_unix_ms();
    let mut pids_to_kill: Vec<u32> = Vec::new();

    for (session_id, inst) in &active_instances {
        // 1. Flush any unread buffer into scrollback and write .scrollback to disk
        let _ = drain_buffer_into_scrollback(session_id, inst);

        // 2. Inspect child process PID & detect if a manual agent CLI is running inside a shell
        let mut root_pid: Option<u32> = None;
        if let Ok(child) = inst.child.lock() {
            root_pid = child.process_id();
        }
        if let Some(pid) = root_pid {
            pids_to_kill.push(pid);
        }

        let child_agent = if is_generic_shell_engine(&inst.engine) {
            root_pid
                .and_then(detect_child_agent_in_shell)
                .or_else(|| inst.detected_agent_engine.lock().ok().and_then(|d| d.clone()))
        } else {
            None
        };

        let active_engine = child_agent
            .clone()
            .unwrap_or_else(|| canonical_agent_engine(&inst.engine));

        let cwd = inst
            .live_cwd
            .lock()
            .ok()
            .map(|c| c.clone())
            .filter(|c| !c.is_empty())
            .unwrap_or_else(|| inst.cwd.clone());

        let existing_prov = inst
            .provider_session_id
            .lock()
            .ok()
            .and_then(|p| p.clone())
            .or_else(|| {
                persisted_map
                    .get(session_id)
                    .and_then(|p| p.provider_session_id.clone())
            });

        let last_input = inst
            .last_user_input
            .lock()
            .ok()
            .and_then(|l| l.clone())
            .or_else(|| {
                persisted_map
                    .get(session_id)
                    .and_then(|p| p.last_user_input.clone())
            });

        let resolved_provider_id = if !is_generic_shell_engine(&active_engine) {
            resolve_provider_session_id_with_context(
                &active_engine,
                &cwd,
                session_id,
                existing_prov.as_deref(),
                inst.spawned_at_unix_ms,
                &claimed_provider_ids,
                root_pid,
                last_input.as_deref(),
            )
        } else {
            None
        };

        if let Some(ref pid) = resolved_provider_id {
            claimed_provider_ids.insert(pid.clone());
        }

        let ws_id = inst
            .workspace_id
            .lock()
            .ok()
            .and_then(|w| w.clone())
            .or_else(|| {
                persisted_map
                    .get(session_id)
                    .and_then(|p| p.workspace_id.clone())
            });
        let p_id = inst
            .pane_id
            .lock()
            .ok()
            .and_then(|p| p.clone())
            .or_else(|| {
                persisted_map
                    .get(session_id)
                    .and_then(|p| p.pane_id.clone())
            });

        let had_activity = inst.had_user_activity.load(Ordering::Relaxed)
            || child_agent.is_some()
            || resolved_provider_id.is_some();

        persisted_map.insert(
            session_id.clone(),
            PersistedTerminalSession {
                session_id: session_id.clone(),
                workspace_id: ws_id,
                pane_id: p_id,
                base_engine: inst.engine.clone(),
                active_engine,
                provider_session_id: resolved_provider_id,
                cwd,
                had_user_activity: had_activity,
                last_user_input: last_input,
                spawned_at_unix_ms: inst.spawned_at_unix_ms,
                saved_at_unix_ms: now,
            },
        );
    }

    // 3. Atomically persist terminal-sessions.json before killing child processes
    write_persisted_terminal_sessions(&persisted_map);

    // 4. Terminate child process trees so no orphaned ConPTY/node/agent processes remain
    #[cfg(windows)]
    if !pids_to_kill.is_empty() {
        let mut kill_args: Vec<String> = vec!["/F".into(), "/T".into()];
        for pid in &pids_to_kill {
            kill_args.push("/PID".into());
            kill_args.push(pid.to_string());
        }
        let kill_refs: Vec<&str> = kill_args.iter().map(|s| s.as_str()).collect();
        let _ = crate::hidden_exec::run(
            std::path::Path::new("taskkill.exe"),
            &kill_refs,
            std::time::Duration::from_secs(5),
        );
    }

    for (_session_id, inst) in active_instances {
        if let Ok(mut child) = inst.child.lock() {
            let _ = child.kill();
        }
    }
}

#[tauri::command]
pub fn terminate_terminal(request: serde_json::Value) -> serde_json::Value {
    let req = request.get("request").unwrap_or(&request);
    let session_id = req.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
    let preserve_state = req
        .get("preserveState")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
        || SHUTTING_DOWN.load(Ordering::SeqCst);

    let instance = {
        let mut map = get_terminals().lock().unwrap();
        map.remove(session_id)
    };

    if let Some(inst) = instance {
        if preserve_state {
            if let Ok(sb) = inst.scrollback.lock() {
                if !sb.is_empty() {
                    write_scrollback_file(session_id, &sb);
                }
            }
        }
        std::thread::spawn(move || {
            if let Ok(mut child) = inst.child.lock() {
                #[cfg(windows)]
                if let Some(pid) = child.process_id() {
                    let pid_str = pid.to_string();
                    let _ = crate::hidden_exec::run(
                        std::path::Path::new("taskkill.exe"),
                        &["/F", "/T", "/PID", &pid_str],
                        std::time::Duration::from_secs(5),
                    );
                }
                let _ = child.kill();
            }
        });
    }

    if !session_id.is_empty() && !preserve_state {
        delete_scrollback_file(session_id);
        remove_persisted_terminal_session(session_id);
    }

    serde_json::json!({ "terminated": true })
}

#[tauri::command]
pub fn launch_workspace_terminals(request: serde_json::Value) -> serde_json::Value {
    log_trace(&format!("Invoked launch_workspace_terminals: {:?}", request));
    let req = request.get("request").unwrap_or(&request);
    let request_id = req.get("requestId").cloned().unwrap_or_else(|| {
        serde_json::Value::String(Uuid::new_v4().to_string())
    });

    let count = req
        .get("count")
        .and_then(|v| v.as_u64())
        .unwrap_or_else(|| {
            req.get("seats")
                .and_then(|s| s.as_array())
                .map(|a| a.len() as u64)
                .unwrap_or(1)
        })
        .clamp(1, 6) as usize;

    let default_engine = req
        .get("engine")
        .and_then(|e| e.as_str())
        .unwrap_or("terminal");

    let seats = req.get("seats").and_then(|s| s.as_array());
    let workspace_id = extract_workspace_id(req);

    static CODENAME_COUNTER: std::sync::atomic::AtomicUsize =
        std::sync::atomic::AtomicUsize::new(0);

    const AGENT_CODENAMES: &[&str] = &[
        "Orion", "Nova", "Atlas", "Vega", "Titan", "Echo", "Phoenix", "Lyra", "Apex", "Zenith",
        "Cygnus", "Helios", "Falcon", "Sirius", "Altair", "Polaris", "Castor", "Pollux", "Astra",
        "Cosmo", "Vortex", "Nebula", "Specter", "Sol", "Aura", "Quantum", "Nexus", "Pulse",
        "Ranger", "Draco",
    ];

    let mut slots = Vec::new();
    for i in 0..count {
        let session_id = Uuid::new_v4().to_string();
        let pane_id = Uuid::new_v4().to_string();

        let engine = seats
            .and_then(|s| s.get(i))
            .and_then(|seat| seat.get("engine"))
            .and_then(|e| e.as_str())
            .unwrap_or(default_engine);

        let is_plain_shell = matches!(engine, "powershell" | "terminal" | "cmd" | "bash" | "zsh");

        let provided_agent_name = seats
            .and_then(|s| s.get(i))
            .and_then(|seat| seat.get("agentName"))
            .and_then(|a| a.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty());

        let codename = if is_plain_shell {
            "Terminal".to_string()
        } else if let Some(custom) = provided_agent_name {
            custom.to_string()
        } else {
            let next_idx = CODENAME_COUNTER.fetch_add(1, Ordering::SeqCst);
            AGENT_CODENAMES[next_idx % AGENT_CODENAMES.len()].to_string()
        };

        let work_title = codename.clone();

        let seat_label = seats
            .and_then(|s| s.get(i))
            .and_then(|seat| seat.get("label"))
            .and_then(|l| l.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty() && *s != "Terminal" && *s != engine)
            .map(|s| s.to_string())
            .unwrap_or_else(|| work_title.clone());

        let cwd = workspace_cwd(req);
        spawn_session_with_options(
            &session_id,
            &cwd,
            engine,
            SpawnOptions {
                cols: 80,
                rows: 24,
                workspace_id: workspace_id.clone(),
                pane_id: Some(pane_id.clone()),
                mode: SpawnMode::Fresh,
                ..Default::default()
            },
        );

        slots.push(serde_json::json!({
            "index": i,
            "sessionId": session_id,
            "paneId": pane_id,
            "engine": engine,
            "displayName": seat_label,
            "agentName": if is_plain_shell { serde_json::Value::Null } else { serde_json::Value::String(codename) },
            "roleLabel": serde_json::Value::Null,
            "workTitle": work_title
        }));
    }

    serde_json::json!({
        "requestId": request_id,
        "attachedToExisting": false,
        "slots": slots
    })
}

#[tauri::command]
pub fn list_terminal_profiles() -> serde_json::Value {
    serde_json::json!({
        "schemaVersion": 1,
        "profiles": [
            { "kind": "default" },
            { "kind": "powerShell" },
            { "kind": "commandPrompt" }
        ]
    })
}

fn request_body(request: &serde_json::Value) -> &serde_json::Value {
    request.get("request").unwrap_or(request)
}

fn option_body(request: &Option<serde_json::Value>) -> Option<&serde_json::Value> {
    request.as_ref().map(request_body)
}

fn owner_workspace_id(owner: &serde_json::Value) -> Option<&str> {
    let kind = owner.get("kind").and_then(|value| value.as_str())?;
    if kind == "workspace" || kind == "workspaceLaunch" {
        owner
            .get("workspaceId")
            .and_then(|value| value.as_str())
            .filter(|id| !id.is_empty())
    } else {
        None
    }
}

fn owner_agent_id(owner: &serde_json::Value) -> Option<&str> {
    let kind = owner.get("kind").and_then(|value| value.as_str())?;
    if kind == "agent" || kind == "agentLaunch" {
        owner
            .get("agentId")
            .and_then(|value| value.as_str())
            .filter(|id| !id.is_empty())
    } else {
        None
    }
}

fn extract_workspace_id(req: &serde_json::Value) -> Option<String> {
    req.get("workspaceId")
        .and_then(|value| value.as_str())
        .filter(|id| !id.is_empty())
        .or_else(|| req.get("owner").and_then(owner_workspace_id))
        .map(str::to_string)
}

fn extract_pane_id(req: &serde_json::Value) -> Option<String> {
    req.get("paneId")
        .and_then(|value| value.as_str())
        .filter(|id| !id.is_empty())
        .or_else(|| {
            req.get("owner")
                .and_then(|o| o.get("paneId"))
                .and_then(|v| v.as_str())
                .filter(|id| !id.is_empty())
        })
        .map(str::to_string)
}

fn workspace_cwd(req: &serde_json::Value) -> String {
    let workspace_id = req
        .get("workspaceId")
        .and_then(|value| value.as_str())
        .filter(|id| !id.is_empty())
        .or_else(|| req.get("owner").and_then(owner_workspace_id));
    if let Some(path) = workspace_id
        .and_then(workspace_path)
        .filter(|path| std::path::Path::new(path).is_dir())
    {
        return path;
    }

    let agent_id = req
        .get("agentId")
        .and_then(|value| value.as_str())
        .filter(|id| !id.is_empty())
        .or_else(|| req.get("owner").and_then(owner_agent_id));
    if let Some(aid) = agent_id {
        let home = crate::agent_mind::get_agent_home_dir(aid);
        let _ = std::fs::create_dir_all(&home);
        let _ = crate::agent_mind::sync_agent_instructions(
            home.parent().unwrap_or(std::path::Path::new(".")),
            aid,
        );
        return home.to_string_lossy().into_owned();
    }

    std::env::current_dir()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|_| ".".into())
}

fn write_session(session_id: &str, text: &str) -> bool {
    if session_id.is_empty() || text.is_empty() {
        return false;
    }
    let instance = {
        let map = get_terminals().lock().unwrap();
        map.get(session_id).cloned()
    };
    let Some(instance) = instance else {
        return false;
    };
    instance.had_user_activity.store(true, Ordering::Relaxed);
    if let Ok(mut writer) = instance.writer.lock() {
        let _ = writer.write_all(text.as_bytes());
        let _ = writer.flush();
        return true;
    }
    false
}

fn quote_path(path: &str) -> Option<String> {
    let trimmed = path.trim();
    if trimmed.is_empty() || trimmed.chars().any(|ch| ch.is_control()) {
        return None;
    }
    Some(format!("'{}' ", trimmed.replace('\'', "''")))
}

fn remove_session(session_id: &str) -> Option<(String, String)> {
    if session_id.is_empty() {
        return None;
    }
    let instance = {
        let mut map = get_terminals().lock().unwrap();
        map.remove(session_id)
    }?;
    let live_dir = instance
        .live_cwd
        .lock()
        .ok()
        .map(|c| c.clone())
        .filter(|c| !c.is_empty())
        .unwrap_or_else(|| instance.cwd.clone());
    let home = (live_dir, instance.engine.clone());
    if let Ok(mut child) = instance.child.lock() {
        let _ = child.kill();
    }
    delete_scrollback_file(session_id);
    remove_persisted_terminal_session(session_id);
    Some(home)
}

fn decode_base64(input: &str) -> Option<Vec<u8>> {
    fn value(byte: u8) -> Option<u8> {
        match byte {
            b'A'..=b'Z' => Some(byte - b'A'),
            b'a'..=b'z' => Some(byte - b'a' + 26),
            b'0'..=b'9' => Some(byte - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let bytes = input.as_bytes();
    if bytes.is_empty() || bytes.len() % 4 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for chunk in bytes.chunks(4) {
        let pad = chunk.iter().filter(|byte| **byte == b'=').count();
        if pad > 2 {
            return None;
        }
        let a = value(chunk[0])?;
        let b = value(chunk[1])?;
        let c = if chunk[2] == b'=' { 0 } else { value(chunk[2])? };
        let d = if chunk[3] == b'=' { 0 } else { value(chunk[3])? };
        out.push((a << 2) | (b >> 4));
        if pad < 2 {
            out.push((b << 4) | (c >> 2));
        }
        if pad < 1 {
            out.push((c << 6) | d);
        }
    }
    Some(out)
}

fn stage_clipboard_file(
    _owner: Option<&serde_json::Value>,
    session_id: &str,
    format: &str,
    bytes_b64: &str,
) -> Option<String> {
    let ext = match format {
        "png" | "gif" | "webp" | "bmp" => format,
        "jpeg" => "jpg",
        _ => return None,
    };
    let bytes = decode_base64(bytes_b64)?;
    if bytes.is_empty() || bytes.len() > 12_000_000 {
        return None;
    }
    let dir = std::env::temp_dir().join("kite-clipboard");
    std::fs::create_dir_all(&dir).ok()?;
    let safe_id: String = session_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let name = format!(
        "{}-{}.{}",
        if safe_id.is_empty() {
            "image"
        } else {
            &safe_id
        },
        &Uuid::new_v4().to_string()[..8],
        ext
    );
    let path = dir.join(name);
    std::fs::write(&path, bytes).ok()?;
    Some(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn insert_terminal_drop_paths(request: Option<serde_json::Value>) -> serde_json::Value {
    if let Some(req) = option_body(&request) {
        let session_id = req
            .get("sessionId")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let mut text = String::new();
        if let Some(paths) = req.get("paths").and_then(|value| value.as_array()) {
            for path in paths.iter().take(20) {
                let Some(path) = path.as_str() else { continue };
                if let Some(quoted) = quote_path(path) {
                    text.push_str(&quoted);
                }
            }
        }
        let _ = write_session(session_id, &text);
    }
    serde_json::Value::Null
}

#[tauri::command]
pub fn insert_terminal_files_entry(request: Option<serde_json::Value>) -> serde_json::Value {
    if let Some(req) = option_body(&request) {
        let session_id = req
            .get("sessionId")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let workspace_id = req
            .get("workspaceId")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let resource_id = req
            .get("resourceId")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let entry_id = req
            .get("entryId")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        if let Some(path) = crate::files::files_entry_path(workspace_id, resource_id, entry_id) {
            if let Some(quoted) = quote_path(&path.to_string_lossy()) {
                let _ = write_session(session_id, &quoted);
            }
        }
    }
    serde_json::Value::Null
}

#[tauri::command]
pub fn restart_agent_terminal_for_autopilot(request: serde_json::Value) -> serde_json::Value {
    let req = request_body(&request);
    let old_id = req
        .get("oldSessionId")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let new_id = req
        .get("newSessionId")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let prompt = req
        .get("prompt")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let cols = req
        .get("columns")
        .and_then(|value| value.as_u64())
        .unwrap_or(80)
        .clamp(2, 512) as u16;
    let rows = req
        .get("rows")
        .and_then(|value| value.as_u64())
        .unwrap_or(24)
        .clamp(1, 256) as u16;
    let previous = remove_session(old_id);
    let (cwd, engine) = previous.unwrap_or_else(|| (workspace_cwd(req), "powershell".to_string()));
    if !new_id.is_empty() && new_id != old_id {
        remove_session(new_id);
        spawn_session_with_size(new_id, &cwd, &engine, cols, rows);
        let prompt = prompt.trim();
        if !prompt.is_empty() {
            let _ = write_session(new_id, &format!("{prompt}\r\n"));
        }
    }
    serde_json::json!({
        "sessionId": new_id,
        "attachedToExisting": false,
        "host": { "backend": "conpty", "buildNumber": 22631 },
        "restore": { "kind": "startedFresh", "reason": "noConversation" }
    })
}

#[tauri::command]
pub fn stage_terminal_clipboard_image(request: Option<serde_json::Value>) -> serde_json::Value {
    if let Some(req) = option_body(&request) {
        let session_id = req
            .get("sessionId")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let format = req
            .get("format")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let bytes = req
            .get("bytesBase64")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        if let Some(path) = stage_clipboard_file(req.get("owner"), session_id, format, bytes) {
            if let Some(quoted) = quote_path(&path) {
                let _ = write_session(session_id, &quoted);
            }
        }
    }
    serde_json::Value::Null
}

// ---------------------------------------------------------------------------
// Targeted Provider Terminal Orchestration (Account Switcher)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuiescedTerminal {
    pub session_id: String,
    pub cwd: String,
    pub base_engine: String,
    pub effective_engine: String,
    pub provider_session_id: Option<String>,
    pub workspace_id: Option<String>,
    pub pane_id: Option<String>,
    pub cols: u16,
    pub rows: u16,
}

pub fn terminal_matches_provider(inst: &TerminalInstance, provider: &str) -> bool {
    let canon_p = crate::account_switcher::canon_provider(provider);

    // 1. Direct engine match (e.g. engine == "antigravity" or "agy")
    if crate::account_switcher::same_provider(&inst.engine, &canon_p) {
        return true;
    }

    // 2. Detected agent engine match
    if let Ok(det) = inst.detected_agent_engine.lock() {
        if let Some(ref d) = *det {
            if crate::account_switcher::same_provider(d, &canon_p) {
                return true;
            }
        }
    }

    // 3. Process tree inspection for generic shell engines (PowerShell / Bash / CMD)
    if is_generic_shell_engine(&inst.engine) {
        if let Ok(child) = inst.child.lock() {
            if let Some(pid) = child.process_id() {
                if let Some(detected) = detect_child_agent_in_shell(pid) {
                    if crate::account_switcher::same_provider(&detected, &canon_p) {
                        return true;
                    }
                }
            }
        }
    }

    false
}

/// Drains output buffer to scrollback and gracefully terminates Kite terminals associated with `provider`.
/// Returns the list of quiesced terminals so they can be respawned after credentials swap.
pub fn quiesce_provider_terminals(provider: &str) -> Vec<QuiescedTerminal> {
    log_trace(&format!("quiesce_provider_terminals invoked for provider={}", provider));

    let matching_sessions: Vec<(String, Arc<TerminalInstance>)> = {
        let Ok(mut map) = get_terminals().lock() else {
            return Vec::new();
        };
        let mut matching_keys = Vec::new();
        for (sid, inst) in map.iter() {
            if terminal_matches_provider(inst, provider) {
                matching_keys.push(sid.clone());
            }
        }
        let mut extracted = Vec::new();
        for k in matching_keys {
            if let Some(inst) = map.remove(&k) {
                extracted.push((k, inst));
            }
        }
        extracted
    };

    if matching_sessions.is_empty() {
        return Vec::new();
    }

    let mut quiesced = Vec::new();
    let mut pids_to_kill = Vec::new();
    let mut persisted_map = read_persisted_terminal_sessions();
    let now = now_unix_ms();

    for (session_id, inst) in &matching_sessions {
        // 1. Drain in-memory buffer into durable scrollback so zero history is lost
        let _ = drain_buffer_into_scrollback(session_id, inst);

        // 2. Collect child PID
        let mut root_pid: Option<u32> = None;
        if let Ok(child) = inst.child.lock() {
            if let Some(pid) = child.process_id() {
                pids_to_kill.push(pid);
                root_pid = Some(pid);
            }
        }

        let cwd = inst
            .live_cwd
            .lock()
            .ok()
            .and_then(|c| if !c.is_empty() { Some(c.clone()) } else { None })
            .unwrap_or_else(|| inst.cwd.clone());

        let ws_id = inst.workspace_id.lock().ok().and_then(|w| w.clone());
        let p_id = inst.pane_id.lock().ok().and_then(|p| p.clone());

        // Resolve the real agent engine (e.g. "antigravity" / "agy") even if wrapped in a shell
        let effective_engine = if is_generic_shell_engine(&inst.engine) {
            inst.detected_agent_engine
                .lock()
                .ok()
                .and_then(|d| d.clone())
                .unwrap_or_else(|| provider.to_string())
        } else {
            inst.engine.clone()
        };

        // Capture and preserve the live conversation/session ID of this terminal
        let prov_id = inst
            .provider_session_id
            .lock()
            .ok()
            .and_then(|p| p.clone())
            .or_else(|| {
                persisted_map
                    .get(session_id)
                    .and_then(|p| p.provider_session_id.clone())
            })
            .or_else(|| {
                if !is_generic_shell_engine(&effective_engine) {
                    let claimed = get_globally_claimed_provider_ids(session_id);
                    let last_input = inst.last_user_input.lock().ok().and_then(|l| l.clone());
                    resolve_provider_session_id_with_context(
                        &effective_engine,
                        &cwd,
                        session_id,
                        None,
                        inst.spawned_at_unix_ms,
                        &claimed,
                        root_pid,
                        last_input.as_deref(),
                    )
                } else {
                    None
                }
            });

        // Persist to disk so that attach_terminal or app restarts know this session belongs to effective_engine
        persisted_map.insert(
            session_id.clone(),
            PersistedTerminalSession {
                session_id: session_id.clone(),
                workspace_id: ws_id.clone(),
                pane_id: p_id.clone(),
                base_engine: inst.engine.clone(),
                active_engine: effective_engine.clone(),
                provider_session_id: prov_id.clone(),
                cwd: cwd.clone(),
                had_user_activity: true,
                last_user_input: None,
                spawned_at_unix_ms: inst.spawned_at_unix_ms,
                saved_at_unix_ms: now,
            },
        );

        let c = inst.cols.load(Ordering::Relaxed);
        let r = inst.rows.load(Ordering::Relaxed);

        quiesced.push(QuiescedTerminal {
            session_id: session_id.clone(),
            cwd,
            base_engine: inst.engine.clone(),
            effective_engine,
            provider_session_id: prov_id,
            workspace_id: ws_id,
            pane_id: p_id,
            cols: if c == 0 { 80 } else { c },
            rows: if r == 0 { 24 } else { r },
        });
    }

    write_persisted_terminal_sessions(&persisted_map);

    // Terminate child processes to release OS file locks
    #[cfg(windows)]
    if !pids_to_kill.is_empty() {
        let mut kill_args: Vec<String> = vec!["/F".into(), "/T".into()];
        for pid in &pids_to_kill {
            kill_args.push("/PID".into());
            kill_args.push(pid.to_string());
        }
        let kill_refs: Vec<&str> = kill_args.iter().map(|s| s.as_str()).collect();
        let _ = crate::hidden_exec::run(
            std::path::Path::new("taskkill.exe"),
            &kill_refs,
            std::time::Duration::from_millis(400),
        );
    }

    for (_session_id, inst) in &matching_sessions {
        if let Ok(mut child) = inst.child.lock() {
            let _ = child.kill();
        }
    }

    // Yield briefly for OS file handle release
    std::thread::sleep(std::time::Duration::from_millis(30));

    quiesced
}

/// Respawns quiesced terminals with the updated environment and launches the provider agent.
pub fn respawn_provider_terminals(
    _provider: &str,
    _new_account_label: &str,
    quiesced: &[QuiescedTerminal],
) {
    if quiesced.is_empty() {
        return;
    }

    for (i, q) in quiesced.iter().enumerate() {
        // Clear stale scrollback so the agent CLI can paint its fresh interactive TUI
        delete_scrollback_file(&q.session_id);

        let is_agent = !is_generic_shell_engine(&q.effective_engine);
        let (engine_to_spawn, mode) = if is_generic_shell_engine(&q.base_engine) && is_agent {
            (
                q.base_engine.clone(),
                SpawnMode::Resume {
                    provider_session_id: q.provider_session_id.clone(),
                    allow_continue_fallback: true,
                    hybrid_shell_agent: Some(q.effective_engine.clone()),
                },
            )
        } else if is_agent {
            (
                q.effective_engine.clone(),
                SpawnMode::Resume {
                    provider_session_id: q.provider_session_id.clone(),
                    allow_continue_fallback: true,
                    hybrid_shell_agent: None,
                },
            )
        } else {
            (
                q.effective_engine.clone(),
                SpawnMode::Fresh,
            )
        };

        spawn_session_with_options(
            &q.session_id,
            &q.cwd,
            &engine_to_spawn,
            SpawnOptions {
                workspace_id: q.workspace_id.clone(),
                pane_id: q.pane_id.clone(),
                cols: q.cols,
                rows: q.rows,
                mode,
                auto_approve: true,
                ..Default::default()
            },
        );

        // Throttle subsequent terminal spawns by 30ms to prevent ConPTY CPU storms
        if i + 1 < quiesced.len() {
            std::thread::sleep(std::time::Duration::from_millis(30));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_agent_cli_args_resume_flags() {
        let (agy_args, agy_id) = build_agent_cli_args(
            "antigravity",
            "sess-1",
            r"E:\kite",
            &SpawnMode::Resume {
                provider_session_id: Some("5094dc56-5a10-42ba-86a6-49565d2e6569".to_string()),
                allow_continue_fallback: true,
                hybrid_shell_agent: None,
            },
        );
        assert_eq!(
            agy_args,
            vec!["--conversation", "5094dc56-5a10-42ba-86a6-49565d2e6569"]
        );
        assert_eq!(
            agy_id.as_deref(),
            Some("5094dc56-5a10-42ba-86a6-49565d2e6569")
        );

        let (codex_args, _) = build_agent_cli_args(
            "codex",
            "sess-2",
            r"E:\kite",
            &SpawnMode::Resume {
                provider_session_id: Some("019d976b-21c5-71d2-9078-fd9428c0219c".to_string()),
                allow_continue_fallback: true,
                hybrid_shell_agent: None,
            },
        );
        assert_eq!(
            codex_args,
            vec!["resume", "019d976b-21c5-71d2-9078-fd9428c0219c"]
        );

        let (opencode_args, _) = build_agent_cli_args(
            "open-code",
            "sess-3",
            r"E:\kite",
            &SpawnMode::Resume {
                provider_session_id: Some("ses_12345".to_string()),
                allow_continue_fallback: true,
                hybrid_shell_agent: None,
            },
        );
        assert_eq!(opencode_args, vec!["--session", "ses_12345"]);

        // Verify that missing provider_session_id never falls back to --continue / resume --last
        let (agy_none_args, agy_none_id) = build_agent_cli_args(
            "antigravity",
            "sess-4",
            r"E:\kite",
            &SpawnMode::Resume {
                provider_session_id: None,
                allow_continue_fallback: true,
                hybrid_shell_agent: None,
            },
        );
        assert!(agy_none_args.is_empty());
        assert!(agy_none_id.is_none());
    }

    #[test]
    fn test_build_agent_cli_args_fresh_with_prompt_and_auto_approve() {
        let (grok_args, _) = build_agent_cli_args_ext(
            "grok",
            "sess-grok",
            r"E:\kite",
            &SpawnMode::Fresh,
            Some("Desarrolla la tarea ODD"),
            true,
            None,
        );
        assert_eq!(
            grok_args,
            vec!["--always-approve", "Desarrolla la tarea ODD"]
        );

        let (codex_args, _) = build_agent_cli_args_ext(
            "codex",
            "sess-codex",
            r"E:\kite",
            &SpawnMode::Fresh,
            Some("Desarrolla la tarea ODD"),
            true,
            None,
        );
        assert_eq!(
            codex_args,
            vec!["--approve-for-me", "Desarrolla la tarea ODD"]
        );

        let (agy_args, _) = build_agent_cli_args_ext(
            "antigravity",
            "sess-agy",
            r"E:\kite",
            &SpawnMode::Fresh,
            Some("Desarrolla la tarea ODD"),
            true,
            None,
        );
        assert_eq!(
            agy_args,
            vec!["--dangerously-skip-permissions", "-i", "Desarrolla la tarea ODD"]
        );

        let (claude_args, bound_id) = build_agent_cli_args_ext(
            "claude-code",
            "sess-claude",
            r"E:\kite",
            &SpawnMode::Fresh,
            Some("Desarrolla la tarea ODD"),
            true,
            None,
        );
        assert!(bound_id.is_some());
        assert_eq!(claude_args[0], "--session-id");
        assert_eq!(claude_args[2], "--permission-mode");
        assert_eq!(claude_args[3], "bypassPermissions");
        assert_eq!(claude_args[4], "Desarrolla la tarea ODD");

        let (opencode_args, _) = build_agent_cli_args_ext(
            "open-code",
            "sess-oc",
            r"E:\kite",
            &SpawnMode::Fresh,
            Some("Desarrolla la tarea ODD"),
            true,
            None,
        );
        assert_eq!(
            opencode_args,
            vec!["--auto", "--prompt", "Desarrolla la tarea ODD"]
        );
    }

    #[test]
    fn test_terminal_session_lifecycle() {
        let session_id = format!("test-sess-{}", Uuid::new_v4());

        // 1. Start terminal session
        let start_res = start_terminal(serde_json::json!({
            "sessionId": session_id,
            "engine": "powershell",
            "columns": 80,
            "rows": 24,
            "confirmedByBuilder": true
        }));

        assert_eq!(start_res["sessionId"], session_id);
        assert_eq!(start_res["attachedToExisting"], false);
        assert_eq!(start_res["host"]["backend"], "conpty");
        assert_eq!(start_res["restore"]["kind"], "startedFresh");

        // Verify session is recorded in active instances
        {
            let map = get_terminals().lock().unwrap();
            assert!(map.contains_key(&session_id));
        }

        // 2. Attach / reconnect to existing session
        let attach_res = attach_terminal(serde_json::json!({
            "sessionId": session_id
        }));
        assert_eq!(attach_res["sessionId"], session_id);
        assert_eq!(attach_res["attachedToExisting"], true);
        assert_eq!(attach_res["restore"]["kind"], "reattached");

        // 3. Write input
        let write_res = write_terminal(serde_json::json!({
            "sessionId": session_id,
            "input": "echo 'kite_test_lifecycle'\r\n"
        }));
        assert!(write_res.is_null());

        // 4. Resize terminal
        let resize_res = resize_terminal(serde_json::json!({
            "sessionId": session_id,
            "columns": 120,
            "rows": 40
        }));
        assert!(resize_res.is_null());

        // 5. Read output (PTY output is asynchronous, give it a few polling iterations)
        let mut got_output = false;
        for _ in 0..50 {
            std::thread::sleep(std::time::Duration::from_millis(100));
            let read_res = read_terminal_output(serde_json::json!({
                "sessionId": session_id
            }));
            let kind = read_res["kind"].as_str().unwrap_or("");
            if kind == "output" {
                got_output = true;
                assert!(read_res["bytesBase64"].as_str().is_some());
                assert!(read_res["sequence"].as_u64().is_some());
                break;
            }
        }
        assert!(got_output, "ConPTY terminal should produce output");

        // 6. Terminate terminal
        let term_res = terminate_terminal(serde_json::json!({
            "sessionId": session_id
        }));
        assert_eq!(term_res["terminated"], true);

        // Verify session is removed from active instances
        {
            let map = get_terminals().lock().unwrap();
            assert!(!map.contains_key(&session_id));
        }

        // 7. Reading terminated session returns idle without error
        let read_after_term = read_terminal_output(serde_json::json!({
            "sessionId": session_id
        }));
        assert_eq!(read_after_term["kind"], "idle");
    }

    #[test]
    fn test_fresh_powershell_terminal_produces_prompt_without_input() {
        let session_id = format!("test-fresh-ps-{}", Uuid::new_v4());
        let _ = start_terminal(serde_json::json!({
            "sessionId": session_id,
            "engine": "powershell",
            "columns": 80,
            "rows": 24,
            "confirmedByBuilder": true
        }));

        let mut output_str = String::new();
        let mut answered_cpr = false;
        for _ in 0..30 {
            std::thread::sleep(std::time::Duration::from_millis(100));
            let read_res = read_terminal_output(serde_json::json!({
                "sessionId": session_id
            }));
            if let Some(b64) = read_res["bytesBase64"].as_str() {
                if let Some(bytes) = decode_base64(b64) {
                    let chunk = String::from_utf8_lossy(&bytes);
                    output_str.push_str(&chunk);
                    if chunk.contains("\x1b[6n") && !answered_cpr {
                        answered_cpr = true;
                        let _ = write_terminal(serde_json::json!({
                            "sessionId": session_id,
                            "input": "\x1b[1;1R"
                        }));
                    }
                }
            }
            if output_str.contains("PS ") || output_str.contains(">") {
                break;
            }
        }

        println!("FRESH PS OUTPUT: {:?}", output_str);
        let _ = terminate_terminal(serde_json::json!({ "sessionId": session_id }));
        assert!(!output_str.is_empty(), "Fresh PowerShell terminal must produce prompt output without waiting for input");
    }

    #[test]
    fn test_fresh_agent_spawn_produces_output() {
        if !engine_installed("antigravity") {
            return;
        }
        let session_id = format!("test-fresh-agy-{}", Uuid::new_v4());
        let _ = start_terminal(serde_json::json!({
            "sessionId": session_id,
            "engine": "antigravity",
            "columns": 80,
            "rows": 24,
            "confirmedByBuilder": true
        }));

        let mut output_str = String::new();
        let mut answered_cpr = false;
        for _ in 0..40 {
            std::thread::sleep(std::time::Duration::from_millis(100));
            let read_res = read_terminal_output(serde_json::json!({
                "sessionId": session_id
            }));
            if let Some(b64) = read_res["bytesBase64"].as_str() {
                if let Some(bytes) = decode_base64(b64) {
                    let chunk = String::from_utf8_lossy(&bytes);
                    output_str.push_str(&chunk);
                    if chunk.contains("\x1b[6n") && !answered_cpr {
                        answered_cpr = true;
                        let _ = write_terminal(serde_json::json!({
                            "sessionId": session_id,
                            "input": "\x1b[1;1R"
                        }));
                    }
                }
            }
            if output_str.contains("Antigravity") {
                break;
            }
        }

        println!("FRESH AGY OUTPUT: {:?}", output_str);
        let _ = terminate_terminal(serde_json::json!({ "sessionId": session_id }));
        assert!(output_str.contains("Antigravity"), "Fresh agent terminal must produce Antigravity banner upon CPR response");
    }

    #[test]
    fn test_terminal_missing_or_unknown_session_safety() {
        let fake_id = "non-existent-session-xyz";

        // Writing to non-existent session returns null without panic
        let write_res = write_terminal(serde_json::json!({
            "sessionId": fake_id,
            "input": "test"
        }));
        assert!(write_res.is_null());

        // Resizing non-existent session returns null without panic
        let resize_res = resize_terminal(serde_json::json!({
            "sessionId": fake_id,
            "columns": 80,
            "rows": 24
        }));
        assert!(resize_res.is_null());

        // Terminating non-existent session returns terminated: true
        let term_res = terminate_terminal(serde_json::json!({
            "sessionId": fake_id
        }));
        assert_eq!(term_res["terminated"], true);

        // Reading non-existent session returns idle
        let read_res = read_terminal_output(serde_json::json!({
            "sessionId": fake_id
        }));
        assert_eq!(read_res["kind"], "idle");
    }

    #[test]
    fn test_list_terminal_profiles() {
        let res = list_terminal_profiles();
        assert_eq!(res["schemaVersion"], 1);
        assert!(res["profiles"].as_array().unwrap().len() >= 3);
    }

    #[test]
    fn test_terminal_scrollback_persistence() {
        let test_session = format!("test-sb-{}", Uuid::new_v4());
        let sample_output = b"\x1b[32mKite ConPTY Test Output\x1b[0m\r\n";
        write_scrollback_file(&test_session, sample_output);

        let read_back = read_scrollback_file(&test_session);
        assert!(read_back.is_some());
        assert_eq!(read_back.unwrap(), sample_output);

        // attach_terminal on new session should find the scrollback on disk
        let attach_res = attach_terminal(serde_json::json!({
            "sessionId": test_session,
            "engine": "powershell"
        }));
        assert_eq!(attach_res["sessionId"], test_session);
        assert_eq!(attach_res["restore"]["kind"], "restoredFromDisk");
        let b64 = attach_res["scrollbackBase64"]
            .as_str()
            .expect("scrollbackBase64 should be present");
        assert_eq!(b64, to_base64(sample_output));

        // Terminating should delete the scrollback file from disk
        let _ = terminate_terminal(serde_json::json!({
            "sessionId": test_session
        }));
        assert!(read_scrollback_file(&test_session).is_none());
    }

    #[test]
    fn test_stage_clipboard_file_and_sanitization() {
        let fake_png_bytes = b"\x89PNG\r\n\x1a\nfakeimagebytes";
        let b64 = to_base64(fake_png_bytes);

        // Test with session_id that contains invalid filename characters
        let dirty_session = "agent:session/test\\1?*";
        let path = stage_clipboard_file(None, dirty_session, "png", &b64);
        assert!(path.is_some());
        let staged_path = path.unwrap();
        assert!(staged_path.ends_with(".png"));
        assert!(std::path::Path::new(&staged_path).is_file());

        // Verify content matches
        let read_bytes = std::fs::read(&staged_path).unwrap();
        assert_eq!(read_bytes, fake_png_bytes);

        // Clean up
        let _ = std::fs::remove_file(staged_path);
    }
}
