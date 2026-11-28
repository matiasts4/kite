//! Cron-scheduled sidecar runner (`builtin: schedule`) reusing `routines::CronSchedule`.

use crate::chat::utils::{find_in_path, now_ms};
use crate::hidden_exec;
use crate::persist::roaming_app_dir;
use crate::plugin_runtime::types::{DiscoveredPlugin, SidecarSpec};
use crate::routines::{next_cron_after, parse_cron_expr};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::{Duration, Instant};

const MINUTE_MS: i64 = 60_000;
const DEFAULT_RUN_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledSidecarStatusDto {
    pub namespaced_id: String,
    pub plugin_id: String,
    pub plugin_name: String,
    pub sidecar_id: String,
    pub display_name: String,
    pub cron_expr: String,
    pub enabled: bool,
    pub last_run_at_ms: Option<i64>,
    pub next_run_at_ms: Option<i64>,
    pub last_exit_code: Option<i32>,
    pub last_error: Option<String>,
    pub run_count: u64,
    pub log_path: String,
}

#[derive(Debug, Clone, Default)]
struct ScheduledRunRecord {
    last_minute_bucket: Option<i64>,
    last_run_at_ms: Option<i64>,
    last_exit_code: Option<i32>,
    last_error: Option<String>,
    run_count: u64,
    in_flight: bool,
    last_log_path: Option<PathBuf>,
}

/// Thread-safe state and runner for cron-scheduled plugin sidecars.
pub struct ScheduledSidecarRunner {
    data_root: PathBuf,
    timeout: Duration,
    records: Mutex<HashMap<String, ScheduledRunRecord>>,
}

static GLOBAL_SCHEDULER: OnceLock<ScheduledSidecarRunner> = OnceLock::new();

pub fn global_scheduled_runner() -> &'static ScheduledSidecarRunner {
    GLOBAL_SCHEDULER.get_or_init(ScheduledSidecarRunner::new)
}

impl Default for ScheduledSidecarRunner {
    fn default() -> Self {
        Self::new()
    }
}

impl ScheduledSidecarRunner {
    pub fn new() -> Self {
        Self::with_data_root(roaming_app_dir())
    }

    pub fn with_data_root(data_root: PathBuf) -> Self {
        Self {
            data_root,
            timeout: DEFAULT_RUN_TIMEOUT,
            records: Mutex::new(HashMap::new()),
        }
    }

    #[cfg(test)]
    fn with_data_root_and_timeout(data_root: PathBuf, timeout: Duration) -> Self {
        Self {
            data_root,
            timeout,
            records: Mutex::new(HashMap::new()),
        }
    }

    pub fn tick_with_plugins(&self, plugins: &[DiscoveredPlugin], now_ms: i64) -> usize {
        let minute_bucket = now_ms.div_euclid(MINUTE_MS);
        let mut triggered = 0usize;

        for plugin in plugins {
            if !plugin.enabled {
                continue;
            }
            for spec in &plugin.sidecars {
                if !is_schedule_builtin(spec) {
                    continue;
                }

                let cron_expr = spec.args.first().map(|s| s.trim()).unwrap_or("");
                let schedule = match parse_schedule_from_arg(cron_expr) {
                    Ok(sched) => sched,
                    Err(err_msg) => {
                        self.record_validation_error(&spec.namespaced_id, err_msg);
                        continue;
                    }
                };

                if !schedule.matches_unix_ms(now_ms) {
                    continue;
                }

                {
                    let mut guard = self.records.lock().unwrap_or_else(|e| e.into_inner());
                    let entry = guard.entry(spec.namespaced_id.clone()).or_default();
                    if entry.in_flight || entry.last_minute_bucket == Some(minute_bucket) {
                        continue;
                    }
                    entry.in_flight = true;
                    entry.last_minute_bucket = Some(minute_bucket);
                }

                let outcome = execute_scheduled_sidecar(
                    spec,
                    cron_expr,
                    now_ms,
                    &self.data_root,
                    self.timeout,
                );

                {
                    let mut guard = self.records.lock().unwrap_or_else(|e| e.into_inner());
                    let entry = guard.entry(spec.namespaced_id.clone()).or_default();
                    entry.in_flight = false;
                    entry.last_run_at_ms = Some(now_ms);
                    entry.last_log_path = Some(outcome.log_path);
                    entry.last_exit_code = outcome.exit_code;
                    entry.last_error = outcome.error;
                    if outcome.spawned {
                        entry.run_count = entry.run_count.saturating_add(1);
                        triggered = triggered.saturating_add(1);
                    }
                }
            }
        }

        triggered
    }

    pub fn list_status(
        &self,
        plugins: &[DiscoveredPlugin],
        now_ms: i64,
    ) -> Vec<ScheduledSidecarStatusDto> {
        let guard = self.records.lock().unwrap_or_else(|e| e.into_inner());
        let mut out = Vec::new();

        for plugin in plugins {
            for spec in &plugin.sidecars {
                if !is_schedule_builtin(spec) {
                    continue;
                }

                let cron_expr = spec
                    .args
                    .first()
                    .map(|s| s.trim().to_string())
                    .unwrap_or_default();
                let validation = parse_schedule_from_arg(&cron_expr);
                let next_run_at_ms = if plugin.enabled && validation.is_ok() {
                    Some(next_cron_after(&cron_expr, now_ms))
                } else {
                    None
                };

                let record = guard.get(&spec.namespaced_id);
                let (_, default_log_path) = resolve_sidecar_dirs(&self.data_root, spec);
                let log_path = record
                    .and_then(|r| r.last_log_path.as_ref())
                    .unwrap_or(&default_log_path)
                    .to_string_lossy()
                    .into_owned();

                let last_error = record
                    .and_then(|r| r.last_error.clone())
                    .or_else(|| validation.err());

                out.push(ScheduledSidecarStatusDto {
                    namespaced_id: spec.namespaced_id.clone(),
                    plugin_id: spec.plugin_id.clone(),
                    plugin_name: spec.plugin_name.clone(),
                    sidecar_id: spec.id.clone(),
                    display_name: spec.display_name.clone(),
                    cron_expr,
                    enabled: plugin.enabled,
                    last_run_at_ms: record.and_then(|r| r.last_run_at_ms),
                    next_run_at_ms,
                    last_exit_code: record.and_then(|r| r.last_exit_code),
                    last_error,
                    run_count: record.map(|r| r.run_count).unwrap_or(0),
                    log_path,
                });
            }
        }

        out.sort_by(|a, b| a.namespaced_id.cmp(&b.namespaced_id));
        out
    }

    fn record_validation_error(&self, namespaced_id: &str, err_msg: String) {
        let mut guard = self.records.lock().unwrap_or_else(|e| e.into_inner());
        let entry = guard.entry(namespaced_id.to_string()).or_default();
        entry.last_error = Some(err_msg);
    }
}

fn is_schedule_builtin(spec: &SidecarSpec) -> bool {
    spec.builtin
        .as_deref()
        .map(str::trim)
        .is_some_and(|b| b.eq_ignore_ascii_case("schedule"))
}

fn parse_schedule_from_arg(cron_expr: &str) -> Result<crate::routines::CronSchedule, String> {
    let trimmed = cron_expr.trim();
    if trimmed.is_empty() {
        return Err("Scheduled sidecar requires a 5-field cron expression in args[0].".to_string());
    }
    parse_cron_expr(trimmed).map_err(|err| err.message)
}

struct ScheduledExecOutcome {
    spawned: bool,
    exit_code: Option<i32>,
    error: Option<String>,
    log_path: PathBuf,
}

fn sanitize_path_segment(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '\0' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            other => other,
        })
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        "_".to_string()
    } else {
        trimmed.to_string()
    }
}

fn resolve_sidecar_dirs(data_root: &Path, spec: &SidecarSpec) -> (PathBuf, PathBuf) {
    let base = data_root
        .join("sidecar_data")
        .join(sanitize_path_segment(&spec.plugin_id))
        .join(sanitize_path_segment(&spec.id));
    (base.join("data"), base.join("logs").join("sidecar.log"))
}

fn expand_tokens(input: &str, spec: &SidecarSpec) -> String {
    let plugin_root = spec.plugin_root.to_string_lossy();
    let plugin_data = spec.plugin_data.to_string_lossy();

    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after_open = &rest[start + 2..];
        let Some(end) = after_open.find('}') else {
            out.push_str(&rest[start..]);
            return out;
        };
        let token = &after_open[..end];
        if token == "PLUGIN_ROOT" {
            out.push_str(&plugin_root);
        } else if token == "PLUGIN_DATA" {
            out.push_str(&plugin_data);
        } else if token.starts_with("flag:") {
            out.push_str("false");
        } else {
            out.push_str("${");
            out.push_str(token);
            out.push('}');
        }
        rest = &after_open[end + 1..];
    }
    out.push_str(rest);
    out
}

fn resolve_executable_candidate(path: &Path) -> Option<PathBuf> {
    if path.is_file() {
        return Some(path.to_path_buf());
    }
    #[cfg(windows)]
    if path.extension().is_none() {
        for ext in [".exe", ".cmd", ".bat"] {
            let mut os = path.as_os_str().to_os_string();
            os.push(ext);
            let candidate = PathBuf::from(os);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn resolve_command_str(raw_cmd: &str, spec: &SidecarSpec) -> Result<PathBuf, String> {
    let expanded = expand_tokens(raw_cmd, spec);
    let cmd = expanded.trim();
    if cmd.is_empty() {
        return Err(format!(
            "Scheduled sidecar '{}' has an empty command.",
            spec.namespaced_id
        ));
    }

    let cmd_path = Path::new(cmd);
    if cmd_path.is_absolute() {
        return resolve_executable_candidate(cmd_path).ok_or_else(|| {
            format!("Scheduled sidecar command not found: {}", cmd_path.display())
        });
    }

    let is_path_like = cmd.contains('/') || cmd.contains('\\') || cmd.starts_with('.');
    if is_path_like {
        let joined = if spec.working_dir.as_os_str().is_empty() {
            cmd_path.to_path_buf()
        } else {
            spec.working_dir.join(cmd_path)
        };
        return resolve_executable_candidate(&joined).ok_or_else(|| {
            format!("Scheduled sidecar command not found: {}", joined.display())
        });
    }

    if !spec.working_dir.as_os_str().is_empty() {
        let in_cwd = spec.working_dir.join(cmd);
        if let Some(found) = resolve_executable_candidate(&in_cwd) {
            return Ok(found);
        }
    }

    if let Some(found) = find_in_path(cmd) {
        return Ok(found);
    }

    #[cfg(windows)]
    if cmd.eq_ignore_ascii_case("node") || cmd.eq_ignore_ascii_case("node.exe") {
        let default_node = PathBuf::from(r"C:\Program Files\nodejs\node.exe");
        if default_node.is_file() {
            return Ok(default_node);
        }
        if let Some(program_files) = std::env::var_os("ProgramFiles") {
            let pf_node = PathBuf::from(program_files).join("nodejs").join("node.exe");
            if pf_node.is_file() {
                return Ok(pf_node);
            }
        }
    }

    Err(format!("Unable to resolve scheduled sidecar command '{cmd}'"))
}

fn resolve_program_and_args(spec: &SidecarSpec) -> Result<(PathBuf, Vec<String>), String> {
    let (raw_cmd, rest_args) = if !spec.command.trim().is_empty() {
        (spec.command.as_str(), spec.args.get(1..).unwrap_or(&[]))
    } else if spec.args.len() >= 2 {
        (spec.args[1].as_str(), spec.args.get(2..).unwrap_or(&[]))
    } else {
        return Err(format!(
            "Scheduled sidecar '{}' is missing an executable command.",
            spec.namespaced_id
        ));
    };

    let program = resolve_command_str(raw_cmd, spec)?;
    let expanded_args = rest_args
        .iter()
        .map(|arg| expand_tokens(arg, spec))
        .collect();
    Ok((program, expanded_args))
}

fn build_env_pairs(
    spec: &SidecarSpec,
    data_root: &Path,
    sidecar_data_dir: &Path,
) -> Vec<(String, String)> {
    let mut env_pairs: Vec<(String, String)> = spec
        .env
        .iter()
        .map(|(k, v)| (k.clone(), expand_tokens(v, spec)))
        .collect();

    env_pairs.push(("KITE_SIDECAR_ID".to_string(), spec.namespaced_id.clone()));
    env_pairs.push((
        "PLUGIN_ROOT".to_string(),
        spec.plugin_root.to_string_lossy().into_owned(),
    ));
    env_pairs.push((
        "PLUGIN_DATA".to_string(),
        spec.plugin_data.to_string_lossy().into_owned(),
    ));
    env_pairs.push((
        "KITE_EXECUTABLE_DATA_DIR".to_string(),
        data_root.to_string_lossy().into_owned(),
    ));
    // Compatibility env alias expected by external sidecar bundles.
    env_pairs.push((
        "ANTIGRAVITY_EXECUTABLE_DATA_DIR".to_string(),
        sidecar_data_dir.to_string_lossy().into_owned(),
    ));
    env_pairs
}

fn append_log_block(log_path: &Path, lines: &[String]) {
    if let Some(parent) = log_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(log_path) else {
        return;
    };
    for line in lines {
        let _ = writeln!(file, "{line}");
    }
    let _ = file.flush();
}

fn read_all_pipe(reader: Option<Box<dyn Read + Send>>, done_tx: mpsc::Sender<()>) -> Vec<u8> {
    let mut out = Vec::new();
    if let Some(mut stream) = reader {
        let _ = stream.read_to_end(&mut out);
    }
    let _ = done_tx.send(());
    out
}

fn run_hidden_with_env_and_timeout(
    program: &Path,
    args: &[&str],
    cwd: Option<&Path>,
    env_pairs: &[(String, String)],
    timeout: Duration,
) -> Result<(Option<i32>, Vec<u8>, Vec<u8>, bool), String> {
    let mut child = hidden_exec::spawn_streaming_with_owned_env(program, args, cwd, env_pairs)
        .map_err(|err| format!("Failed to launch scheduled sidecar '{}': {err}", program.display()))?;

    // Close stdin immediately so non-interactive scheduled jobs receive EOF.
    drop(child.stdin.take());

    let (done_tx, done_rx) = mpsc::channel::<()>();
    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();

    let tx_out = done_tx.clone();
    let out_handle = std::thread::Builder::new()
        .name("kite-sched-stdout".to_string())
        .spawn(move || read_all_pipe(stdout_pipe, tx_out))
        .map_err(|err| format!("Failed spawning stdout reader: {err}"))?;

    let err_handle = std::thread::Builder::new()
        .name("kite-sched-stderr".to_string())
        .spawn(move || read_all_pipe(stderr_pipe, done_rx_tx(done_tx)))
        .map_err(|err| format!("Failed spawning stderr reader: {err}"))?;

    let deadline = Instant::now() + timeout;
    let mut finished_streams = 0usize;
    let mut timed_out = false;

    while finished_streams < 2 {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            timed_out = true;
            break;
        }
        match done_rx.recv_timeout(remaining) {
            Ok(()) => finished_streams += 1,
            Err(_) => {
                timed_out = true;
                break;
            }
        }
    }

    if timed_out {
        let _ = child.kill();
    }

    let exit_code = match child.wait() {
        Ok(code) => (!timed_out).then_some(code),
        Err(_) if timed_out => None,
        Err(err) => {
            let stdout = out_handle.join().unwrap_or_default();
            let stderr = err_handle.join().unwrap_or_default();
            let _ = (stdout, stderr);
            return Err(format!("Failed waiting on scheduled sidecar: {err}"));
        }
    };

    let stdout = out_handle.join().unwrap_or_default();
    let stderr = err_handle.join().unwrap_or_default();
    Ok((exit_code, stdout, stderr, timed_out))
}

fn done_rx_tx(tx: mpsc::Sender<()>) -> mpsc::Sender<()> {
    tx
}

fn execute_scheduled_sidecar(
    spec: &SidecarSpec,
    cron_expr: &str,
    now_ms: i64,
    data_root: &Path,
    timeout: Duration,
) -> ScheduledExecOutcome {
    let (sidecar_data_dir, log_path) = resolve_sidecar_dirs(data_root, spec);

    if !spec.plugin_data.as_os_str().is_empty() {
        let _ = fs::create_dir_all(&spec.plugin_data);
    }
    let _ = fs::create_dir_all(&sidecar_data_dir);

    let (program, expanded_args) = match resolve_program_and_args(spec) {
        Ok(resolved) => resolved,
        Err(err) => {
            append_log_block(
                &log_path,
                &[
                    format!("[scheduled unix_ms={now_ms} cron=\"{cron_expr}\"] resolve_failed"),
                    format!("[scheduled error=\"{err}\"]"),
                ],
            );
            return ScheduledExecOutcome {
                spawned: false,
                exit_code: None,
                error: Some(err),
                log_path,
            };
        }
    };

    let arg_refs: Vec<&str> = expanded_args.iter().map(String::as_str).collect();
    let env_pairs = build_env_pairs(spec, data_root, &sidecar_data_dir);
    let cwd = (!spec.working_dir.as_os_str().is_empty()).then_some(spec.working_dir.as_path());

    let mut log_lines = vec![format!(
        "[scheduled unix_ms={now_ms} cron=\"{cron_expr}\"] command=\"{}\"",
        program.display()
    )];

    match run_hidden_with_env_and_timeout(&program, &arg_refs, cwd, &env_pairs, timeout) {
        Ok((exit_code, stdout, stderr, timed_out)) => {
            let stdout_str = String::from_utf8_lossy(&stdout);
            for line in stdout_str.lines() {
                log_lines.push(line.to_string());
            }
            let stderr_str = String::from_utf8_lossy(&stderr);
            for line in stderr_str.lines() {
                log_lines.push(format!("[stderr] {line}"));
            }

            let error = if timed_out {
                let msg = format!(
                    "Scheduled sidecar '{}' timed out after {}s.",
                    spec.namespaced_id,
                    timeout.as_secs()
                );
                log_lines.push(format!("[scheduled status=timeout error=\"{msg}\"]"));
                Some(msg)
            } else if exit_code != Some(0) {
                let code_desc = exit_code
                    .map(|c| c.to_string())
                    .unwrap_or_else(|| "unknown".to_string());
                let msg = format!("Scheduled sidecar exited with code {code_desc}");
                log_lines.push(format!("[scheduled exit_code={code_desc}]"));
                Some(msg)
            } else {
                log_lines.push("[scheduled exit_code=0]".to_string());
                None
            };

            append_log_block(&log_path, &log_lines);

            ScheduledExecOutcome {
                spawned: true,
                exit_code,
                error,
                log_path,
            }
        }
        Err(err) => {
            log_lines.push(format!("[scheduled error=\"{err}\"]"));
            append_log_block(&log_path, &log_lines);
            ScheduledExecOutcome {
                spawned: false,
                exit_code: None,
                error: Some(err),
                log_path,
            }
        }
    }
}

/// Evaluates all due scheduled plugin sidecars for `now_ms`.
pub fn tick_scheduled_sidecars_at(now_ms: i64) -> usize {
    let plugins = {
        let cached = crate::plugin_runtime::cached_discovered_plugins();
        if cached.is_empty() {
            let ws = crate::plugin_runtime::current_workspace_dir();
            crate::plugin_runtime::registry::discover_plugins(ws.as_deref())
        } else {
            cached
        }
    };
    tick_scheduled_sidecars_with_plugins(&plugins, now_ms)
}

/// Evaluates all due scheduled plugin sidecars from an explicit plugin list for `now_ms`.
pub fn tick_scheduled_sidecars_with_plugins(plugins: &[DiscoveredPlugin], now_ms: i64) -> usize {
    global_scheduled_runner().tick_with_plugins(plugins, now_ms)
}

/// Lists status snapshots for all discovered scheduled (`builtin: schedule`) sidecars.
pub fn list_scheduled_sidecars_status(workspace_dir: Option<&Path>) -> Vec<ScheduledSidecarStatusDto> {
    let plugins = {
        let cached = crate::plugin_runtime::cached_discovered_plugins();
        let active_ws = crate::plugin_runtime::current_workspace_dir();
        if cached.is_empty()
            || (workspace_dir.is_some() && active_ws.as_deref() != workspace_dir)
        {
            crate::plugin_runtime::registry::discover_plugins(workspace_dir)
        } else {
            cached
        }
    };
    global_scheduled_runner().list_status(&plugins, now_ms())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_runtime::types::{
        PluginManifestFormat, PluginSourceKind, SidecarRestartPolicy,
    };
    use std::collections::BTreeMap;

    struct TempTestDir {
        path: PathBuf,
    }

    impl TempTestDir {
        fn new(label: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "kite-sched-test-{label}-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4().simple()
            ));
            fs::create_dir_all(&dir).expect("create temp test dir");
            Self { path: dir }
        }
    }

    impl Drop for TempTestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn make_scheduled_plugin(
        root: &Path,
        plugin_id: &str,
        sidecar_id: &str,
        command: &str,
        args: Vec<String>,
        enabled: bool,
    ) -> DiscoveredPlugin {
        let plugin_root = root.join("plugins").join(plugin_id);
        let plugin_data = root.join("plugin_data").join(plugin_id);
        fs::create_dir_all(&plugin_root).expect("create plugin root");
        fs::create_dir_all(&plugin_data).expect("create plugin data");

        let spec = SidecarSpec {
            id: sidecar_id.to_string(),
            namespaced_id: format!("{plugin_id}/{sidecar_id}"),
            plugin_id: plugin_id.to_string(),
            plugin_name: plugin_id.to_string(),
            display_name: format!("{sidecar_id} Job"),
            description: "Scheduled sidecar test".to_string(),
            command: command.to_string(),
            args,
            env: BTreeMap::new(),
            builtin: Some("schedule".to_string()),
            restart_policy: SidecarRestartPolicy::Never,
            has_web_ui: false,
            views: Vec::new(),
            working_dir: plugin_root.clone(),
            plugin_root: plugin_root.clone(),
            plugin_data: plugin_data.clone(),
            allows_user_interactions: false,
        };

        DiscoveredPlugin {
            dir_id: plugin_id.to_string(),
            name: plugin_id.to_string(),
            display_name: plugin_id.to_string(),
            description: "Scheduled plugin".to_string(),
            version: Some("1.0.0".to_string()),
            author: None,
            homepage: None,
            repository: None,
            license: None,
            keywords: Vec::new(),
            suggested_prompts: Vec::new(),
            logo_data_uri: None,
            source: PluginSourceKind::GlobalKite,
            format: PluginManifestFormat::Native,
            root_path: plugin_root,
            data_path: plugin_data,
            enabled,
            manifest_disabled: false,
            can_uninstall: true,
            has_hooks: false,
            hooks_path: None,
            sidecars: vec![spec],
            mcp_servers: Vec::new(),
            skills: Vec::new(),
            rules: Vec::new(),
            agents: Vec::new(),
        }
    }

    #[cfg(windows)]
    fn write_echo_script(dir: &Path, name: &str, message: &str, exit_code: i32) -> PathBuf {
        let script = dir.join(name);
        let body = format!("@echo off\r\necho {message}\r\nexit /b {exit_code}\r\n");
        fs::write(&script, body).expect("write test cmd script");
        script
    }

    #[cfg(not(windows))]
    fn write_echo_script(dir: &Path, name: &str, message: &str, exit_code: i32) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let script = dir.join(name);
        let body = format!("#!/bin/sh\necho \"{message}\"\nexit {exit_code}\n");
        fs::write(&script, body).expect("write test sh script");
        let mut perms = fs::metadata(&script).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&script, perms).unwrap();
        script
    }

    #[test]
    fn validates_cron_expression_from_args0_and_skips_invalid() {
        let tmp = TempTestDir::new("invalid-cron");
        let runner = ScheduledSidecarRunner::with_data_root(tmp.path.join("data"));

        let missing_cron = make_scheduled_plugin(
            &tmp.path,
            "missing-cron-plugin",
            "job",
            "node",
            Vec::new(),
            true,
        );
        let invalid_cron = make_scheduled_plugin(
            &tmp.path,
            "bad-cron-plugin",
            "job",
            "node",
            vec!["* *".to_string(), "noop.js".to_string()],
            true,
        );

        let plugins = vec![missing_cron, invalid_cron];
        let now = 1_767_344_400_000i64; // 2026-01-02 09:00:00 UTC
        let count = runner.tick_with_plugins(&plugins, now);
        assert_eq!(count, 0);

        let statuses = runner.list_status(&plugins, now);
        assert_eq!(statuses.len(), 2);
        for status in statuses {
            assert!(status.next_run_at_ms.is_none());
            assert!(
                status.last_error.as_deref().is_some_and(|e| !e.is_empty()),
                "expected cron validation error for {}",
                status.namespaced_id
            );
            assert_eq!(status.run_count, 0);
        }
    }

    #[test]
    fn dedupes_due_runs_within_same_minute_bucket_and_logs_output_to_temp_dir() {
        let tmp = TempTestDir::new("dedupe-log");
        let data_root = tmp.path.join("roaming");
        let runner = ScheduledSidecarRunner::with_data_root(data_root.clone());

        let script_name = if cfg!(windows) { "job.cmd" } else { "job.sh" };
        let plugin = make_scheduled_plugin(
            &tmp.path,
            "sync-plugin",
            "hourly-sync",
            &format!("./{script_name}"),
            vec!["15 9 * * 1-5".to_string()],
            true,
        );
        write_echo_script(&plugin.root_path, script_name, "SCHEDULER_RAN_OK", 0);

        // 2026-01-02 09:00:00 UTC (Friday)
        let friday_0900 = 1_767_344_400_000i64;
        let friday_0915_s0 = friday_0900 + 15 * MINUTE_MS;
        let friday_0915_s45 = friday_0915_s0 + 45_000;
        let saturday_0915 = friday_0915_s0 + 24 * 60 * MINUTE_MS;

        // Before due minute -> 0 runs
        assert_eq!(runner.tick_with_plugins(&[plugin.clone()], friday_0900), 0);

        // First tick inside 09:15 UTC -> runs once
        assert_eq!(runner.tick_with_plugins(&[plugin.clone()], friday_0915_s0), 1);

        // Second tick 45s later in the same minute bucket -> deduped
        assert_eq!(runner.tick_with_plugins(&[plugin.clone()], friday_0915_s45), 0);

        // Saturday 09:15 UTC does not match 1-5 -> 0 runs
        assert_eq!(runner.tick_with_plugins(&[plugin.clone()], saturday_0915), 0);

        let statuses = runner.list_status(&[plugin], friday_0915_s45);
        assert_eq!(statuses.len(), 1);
        let st = &statuses[0];
        assert_eq!(st.namespaced_id, "sync-plugin/hourly-sync");
        assert_eq!(st.cron_expr, "15 9 * * 1-5");
        assert!(st.enabled);
        assert_eq!(st.run_count, 1);
        assert_eq!(st.last_run_at_ms, Some(friday_0915_s0));
        assert_eq!(st.last_exit_code, Some(0));
        assert!(st.last_error.is_none());
        assert!(st.next_run_at_ms.is_some_and(|n| n > friday_0915_s45));

        let log_content = fs::read_to_string(&st.log_path).expect("sidecar.log should exist");
        assert!(
            log_content.contains("SCHEDULER_RAN_OK"),
            "log missing output: {log_content}"
        );
        assert!(
            log_content.contains("exit_code=0"),
            "log missing exit status: {log_content}"
        );
    }

    #[test]
    fn skips_disabled_plugins_and_records_nonzero_exit_error() {
        let tmp = TempTestDir::new("disabled-nonzero");
        let data_root = tmp.path.join("roaming");
        let runner = ScheduledSidecarRunner::with_data_root(data_root);

        let script_name = if cfg!(windows) { "fail.cmd" } else { "fail.sh" };
        let enabled_fail = make_scheduled_plugin(
            &tmp.path,
            "failing-plugin",
            "nightly",
            &format!("./{script_name}"),
            vec!["* * * * *".to_string()],
            true,
        );
        write_echo_script(&enabled_fail.root_path, script_name, "JOB_FAILURE_MSG", 7);

        let disabled_ok = make_scheduled_plugin(
            &tmp.path,
            "disabled-plugin",
            "never-run",
            &format!("./{script_name}"),
            vec!["* * * * *".to_string()],
            false,
        );
        write_echo_script(&disabled_ok.root_path, script_name, "SHOULD_NOT_RUN", 0);

        let plugins = vec![enabled_fail, disabled_ok];
        let now = 1_767_344_400_000i64;
        assert_eq!(runner.tick_with_plugins(&plugins, now), 1);

        let statuses = runner.list_status(&plugins, now);
        assert_eq!(statuses.len(), 2);

        let disabled_st = statuses
            .iter()
            .find(|s| s.plugin_id == "disabled-plugin")
            .unwrap();
        assert!(!disabled_st.enabled);
        assert_eq!(disabled_st.run_count, 0);
        assert!(disabled_st.next_run_at_ms.is_none());

        let failing_st = statuses
            .iter()
            .find(|s| s.plugin_id == "failing-plugin")
            .unwrap();
        assert!(failing_st.enabled);
        assert_eq!(failing_st.run_count, 1);
        assert_eq!(failing_st.last_exit_code, Some(7));
        assert!(
            failing_st
                .last_error
                .as_deref()
                .is_some_and(|e| e.contains("7")),
            "expected exit code 7 error, got: {:?}",
            failing_st.last_error
        );
        let log_content = fs::read_to_string(&failing_st.log_path).expect("log exists");
        assert!(log_content.contains("JOB_FAILURE_MSG"));
        assert!(log_content.contains("exit_code=7"));
    }

    #[test]
    fn public_wrapper_tracks_minute_dedupe_against_isolated_test_roaming_dir() {
        let tmp = TempTestDir::new("global-wrapper");
        let script_name = if cfg!(windows) { "pulse.cmd" } else { "pulse.sh" };
        let plugin = make_scheduled_plugin(
            &tmp.path,
            &format!("global-test-{}", uuid::Uuid::new_v4().simple()),
            "pulse",
            &format!("./{script_name}"),
            vec!["0 12 * * *".to_string()],
            true,
        );
        write_echo_script(&plugin.root_path, script_name, "GLOBAL_PULSE_OK", 0);

        let noon_utc = 1_767_355_200_000i64; // 2026-01-02 12:00:00 UTC
        assert_eq!(tick_scheduled_sidecars_with_plugins(&[plugin.clone()], noon_utc), 1);
        assert_eq!(
            tick_scheduled_sidecars_with_plugins(&[plugin], noon_utc + 10_000),
            0
        );
    }

    #[test]
    fn enforces_timeout_and_kills_hanging_scheduled_job() {
        let tmp = TempTestDir::new("timeout");
        let runner = ScheduledSidecarRunner::with_data_root_and_timeout(
            tmp.path.join("roaming"),
            Duration::from_millis(250),
        );

        let plugin = if cfg!(windows) {
            make_scheduled_plugin(
                &tmp.path,
                "hang-plugin",
                "sleeper",
                "powershell",
                vec![
                    "* * * * *".to_string(),
                    "-NoProfile".to_string(),
                    "-NonInteractive".to_string(),
                    "-Command".to_string(),
                    "Start-Sleep -Seconds 10".to_string(),
                ],
                true,
            )
        } else {
            make_scheduled_plugin(
                &tmp.path,
                "hang-plugin",
                "sleeper",
                "sh",
                vec![
                    "* * * * *".to_string(),
                    "-c".to_string(),
                    "sleep 10".to_string(),
                ],
                true,
            )
        };

        let now = 1_767_344_400_000i64;
        assert_eq!(runner.tick_with_plugins(&[plugin.clone()], now), 1);

        let statuses = runner.list_status(&[plugin], now);
        assert_eq!(statuses.len(), 1);
        assert_eq!(statuses[0].run_count, 1);
        assert!(statuses[0].last_exit_code.is_none());
        assert!(
            statuses[0]
                .last_error
                .as_deref()
                .is_some_and(|e| e.contains("timed out")),
            "expected timeout error, got {:?}",
            statuses[0].last_error
        );
    }
}
