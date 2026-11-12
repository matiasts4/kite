use crate::logger::log_trace;
use crate::session_resolver::{canonical_agent_engine, claude_session_file_exists};
use crate::terminal::SpawnMode;
use portable_pty::CommandBuilder;
use uuid::Uuid;

pub fn is_agent_cli_engine(engine: &str) -> bool {
    let canonical = canonical_agent_engine(engine);
    matches!(
        canonical.as_str(),
        "claude-code" | "codex" | "gemini" | "open-code" | "cursor" | "grok" | "antigravity"
    ) || !program_names(&canonical).is_empty()
        || !program_names(engine.trim()).is_empty()
}

pub fn program_names(engine: &str) -> &'static [&'static str] {
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

pub fn resolve_raw_program(word: &str) -> Option<String> {
    let path = std::path::Path::new(word);
    if path.is_file() {
        return Some(word.to_string());
    }
    where_program(word)
}

/// `Ok(None)` means this start is not a raw argv. `Err` means the executable is missing.
pub fn raw_argv_from_request(req: &serde_json::Value) -> Result<Option<Vec<String>>, ()> {
    let Some(items) = req.get("argv").and_then(|value| value.as_array()) else {
        return Ok(None);
    };
    let argv: Vec<String> = items
        .iter()
        .filter_map(|value| value.as_str().map(str::to_string))
        .collect();
    let Some(program) = argv.first().map(|word| word.trim()).filter(|word| !word.is_empty()) else {
        return Err(());
    };
    if resolve_raw_program(program).is_none() {
        return Err(());
    }
    Ok(Some(argv))
}

pub fn search_path_var(name: &str, path_var: Option<std::ffi::OsString>) -> Option<String> {
    let path_var = path_var?;
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

#[cfg(test)]
pub fn parse_reg_path_output(stdout: &str) -> Option<String> {
    for line in stdout.lines() {
        let marker = if line.contains("REG_EXPAND_SZ") {
            "REG_EXPAND_SZ"
        } else if line.contains("REG_SZ") {
            "REG_SZ"
        } else {
            continue;
        };
        if let Some(idx) = line.find(marker) {
            let val = line[idx + marker.len()..].trim();
            if !val.is_empty() {
                return Some(val.to_string());
            }
        }
    }
    None
}

#[cfg(windows)]
pub fn expand_environment_strings(raw: &str) -> Option<String> {
    use windows::core::HSTRING;
    use windows::Win32::System::Environment::ExpandEnvironmentStringsW;
    unsafe {
        let src = HSTRING::from(raw);
        let needed = ExpandEnvironmentStringsW(&src, None);
        if needed == 0 {
            return None;
        }
        let mut buf = vec![0u16; needed as usize];
        let written = ExpandEnvironmentStringsW(&src, Some(&mut buf));
        if written == 0 {
            return None;
        }
        let end = buf
            .iter()
            .position(|&c| c == 0)
            .unwrap_or((written as usize).saturating_sub(1));
        let expanded = String::from_utf16_lossy(&buf[..end]);
        if expanded.is_empty() {
            None
        } else {
            Some(expanded)
        }
    }
}

/// Reads a registry string without spawning `reg.exe` (console-subsystem
/// children flash Windows Terminal even with CREATE_NO_WINDOW).
#[cfg(windows)]
pub fn query_registry_path(key: &str, val_name: &str) -> Option<String> {
    use windows::core::HSTRING;
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE,
        KEY_READ, REG_EXPAND_SZ, REG_SZ, REG_VALUE_TYPE,
    };

    let (root, subkey) = if let Some(rest) = key.strip_prefix("HKCU\\") {
        (HKEY_CURRENT_USER, rest)
    } else if let Some(rest) = key.strip_prefix("HKLM\\") {
        (HKEY_LOCAL_MACHINE, rest)
    } else {
        return None;
    };

    unsafe {
        let mut hkey = HKEY::default();
        if RegOpenKeyExW(root, &HSTRING::from(subkey), None, KEY_READ, &mut hkey) != ERROR_SUCCESS {
            return None;
        }
        let name = HSTRING::from(val_name);
        let mut ty = REG_VALUE_TYPE(0);
        let mut size = 0u32;
        if RegQueryValueExW(hkey, &name, None, Some(&mut ty), None, Some(&mut size))
            != ERROR_SUCCESS
            || size == 0
            || (ty != REG_SZ && ty != REG_EXPAND_SZ)
        {
            let _ = RegCloseKey(hkey);
            return None;
        }
        let mut buf = vec![0u8; size as usize];
        let status = RegQueryValueExW(
            hkey,
            &name,
            None,
            Some(&mut ty),
            Some(buf.as_mut_ptr()),
            Some(&mut size),
        );
        let _ = RegCloseKey(hkey);
        if status != ERROR_SUCCESS {
            return None;
        }
        let word_count = (size as usize) / 2;
        let words = std::slice::from_raw_parts(buf.as_ptr() as *const u16, word_count);
        let trimmed = words.split(|&c| c == 0).next().unwrap_or(&[]);
        if trimmed.is_empty() {
            return None;
        }
        let raw = String::from_utf16_lossy(trimmed);
        if ty == REG_EXPAND_SZ {
            expand_environment_strings(&raw).or(Some(raw))
        } else if raw.is_empty() {
            None
        } else {
            Some(raw)
        }
    }
}

#[cfg(windows)]
pub fn fresh_registry_path() -> Option<std::ffi::OsString> {
    static CACHED: std::sync::OnceLock<Option<std::ffi::OsString>> = std::sync::OnceLock::new();
    CACHED
        .get_or_init(|| {
            let query_keys = [
                ("HKCU\\Environment", "Path"),
                (
                    "HKLM\\System\\CurrentControlSet\\Control\\Session Manager\\Environment",
                    "Path",
                ),
            ];
            let mut parts = Vec::new();
            for (key, val_name) in query_keys {
                if let Some(val) = query_registry_path(key, val_name) {
                    parts.push(val);
                }
            }
            if parts.is_empty() {
                None
            } else {
                Some(std::ffi::OsString::from(parts.join(";")))
            }
        })
        .clone()
}

pub fn where_program(name: &str) -> Option<String> {
    if let Some(found) = search_path_var(name, std::env::var_os("PATH")) {
        return Some(found);
    }
    #[cfg(windows)]
    {
        if let Some(fresh_path) = fresh_registry_path() {
            if let Some(found) = search_path_var(name, Some(fresh_path.clone())) {
                if let Ok(curr) = std::env::var("PATH") {
                    let updated = format!("{};{}", fresh_path.to_string_lossy(), curr);
                    std::env::set_var("PATH", updated);
                }
                return Some(found);
            }
        }
    }
    None
}

pub fn known_program_path(name: &str) -> Option<String> {
    let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
    let appdata = std::env::var("APPDATA").unwrap_or_default();
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
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
    if name == "grok" {
        candidates.push(
            std::path::PathBuf::from(&home)
                .join(".grok")
                .join("bin")
                .join("grok.exe"),
        );
        candidates.push(
            std::path::PathBuf::from(&home)
                .join(".grok")
                .join("bin")
                .join("grok"),
        );
    }
    candidates.push(
        std::path::PathBuf::from(&home)
            .join(format!(".{name}"))
            .join("bin")
            .join(format!("{name}.exe")),
    );
    candidates.push(
        std::path::PathBuf::from(&home)
            .join(format!(".{name}"))
            .join("bin")
            .join(name),
    );
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
            .join(".local")
            .join("bin")
            .join(name),
    );
    candidates.push(
        std::path::PathBuf::from(&home)
            .join(".cargo")
            .join("bin")
            .join(format!("{name}.exe")),
    );
    candidates.push(
        std::path::PathBuf::from(&home)
            .join(".cargo")
            .join("bin")
            .join(name),
    );
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .map(|path| path.to_string_lossy().into_owned())
}

pub fn engine_installed(engine: &str) -> bool {
    resolve_engine_program(engine).is_some()
}

pub fn resolve_engine_program(engine: &str) -> Option<String> {
    for name in program_names(engine) {
        if let Some(path) = known_program_path(name).or_else(|| where_program(name)) {
            return Some(path);
        }
    }
    None
}

pub const AGENT_TERMINAL_TERM: &str = "xterm-256color";
pub const AGENT_TERMINAL_UTF8_PREAMBLE: &str =
    "$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); chcp 65001 > $null; $env:TERM = 'xterm-256color';";

pub fn build_agent_launch_command(program: &str, agent_args: &[String]) -> String {
    let quoted_program = program.replace('\'', "''");
    let quoted_args: Vec<String> = agent_args
        .iter()
        .map(|arg| format!("'{}'", arg.replace('\'', "''")))
        .collect();
    let launch = if quoted_args.is_empty() {
        format!("& '{quoted_program}'")
    } else {
        format!("& '{quoted_program}' {}", quoted_args.join(" "))
    };
    format!("{AGENT_TERMINAL_UTF8_PREAMBLE} {launch}")
}

/// Returns the native executable that should be the ConPTY child for an agent.
/// A `.exe`/`.com` is used as-is. An npm `.cmd` shim is followed to the `.exe`
/// it launches (`"%dp0%\...\tool.exe" %*`). Anything else (scripts run through
/// an interpreter) yields `None` and keeps the PowerShell wrapper.
pub fn resolve_direct_agent_executable(program: &str) -> Option<std::path::PathBuf> {
    let path = std::path::Path::new(program);
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "exe" | "com" => path.is_file().then(|| path.to_path_buf()),
        "cmd" | "bat" => {
            let shim_dir = path.parent()?;
            let text = std::fs::read_to_string(path).ok()?;
            text.lines().find_map(|line| {
                let lower = line.to_lowercase();
                let start = lower.find("%dp0%")?;
                let rest = &line[start + "%dp0%".len()..];
                let end = rest.to_lowercase().find(".exe")? + ".exe".len();
                let relative = rest[..end].trim_start_matches(['\\', '/']);
                let candidate = shim_dir.join(relative.replace('/', "\\"));
                candidate.is_file().then_some(candidate)
            })
        }
        _ => None,
    }
}

/// Builds the ConPTY child command for an agent CLI. Preferred: the agent
/// executable itself, with no intermediate PowerShell console host. Fallback:
/// the historical `powershell.exe -NoExit -Command` wrapper, logged so a
/// fallback is never mistaken for a direct launch.
pub fn build_agent_command(
    program: &str,
    agent_args: &[String],
    cwd: &std::path::Path,
) -> (CommandBuilder, &'static str) {
    if let Some(exe) = resolve_direct_agent_executable(program) {
        log_trace(&format!(
            "agent_launch: direct ConPTY child exe={} args={}",
            exe.display(),
            agent_args.len()
        ));
        let mut c = CommandBuilder::new(exe.as_os_str());
        c.cwd(cwd);
        c.args(agent_args);
        return (c, "direct");
    }
    log_trace(&format!(
        "WARN agent_launch: no native executable behind {program}; using PowerShell wrapper"
    ));
    let mut c = CommandBuilder::new("powershell.exe");
    c.cwd(cwd);
    let launch = build_agent_launch_command(program, agent_args);
    c.args(["-NoLogo", "-NoExit", "-Command", &launch]);
    (c, "powershell")
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

pub fn sanitize_cli_system_prompt(sys: &str) -> String {
    let body = crate::dispatch::cli::strip_skill_frontmatter(sys);
    if body.starts_with('-') {
        format!(" {body}")
    } else {
        body.to_string()
    }
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
        SpawnMode::Fresh | SpawnMode::Agent { .. } => {
            match canonical.as_str() {
                "grok" => {
                    if auto_approve {
                        args.push("--always-approve".to_string());
                    }
                    if let Some(sys) = system_prompt {
                        args.push("--system-prompt-override".to_string());
                        args.push(sanitize_cli_system_prompt(sys));
                    }
                    if let Some(prompt) = initial_prompt {
                        if prompt.trim_start().starts_with('-') {
                            args.push("--".to_string());
                        }
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
                        args.push(sanitize_cli_system_prompt(sys));
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
                    if let Some(sys) = system_prompt {
                        args.push("--system-prompt".to_string());
                        args.push(sanitize_cli_system_prompt(sys));
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
                    if let Some(sys) = system_prompt {
                        args.push("--system-prompt-override".to_string());
                        args.push(sanitize_cli_system_prompt(sys));
                    }
                    if let Some(prompt) = initial_prompt {
                        if prompt.trim_start().starts_with('-') {
                            args.push("--".to_string());
                        }
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
