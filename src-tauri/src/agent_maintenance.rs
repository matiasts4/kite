// Agent update detection, semver advisories, and background tool jobs.
// Complies with Kite Code architectural guidelines: silent background execution,
// TTL-based registry caching, and zero intrusive UI popups.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::hidden_exec;
use crate::logger::log_trace;
use crate::terminal;

const REGISTRY_CACHE_TTL: Duration = Duration::from_secs(3600); // 1 hour
const SUMMARY_CACHE_TTL: Duration = Duration::from_secs(60);
const MAX_CONCURRENT_ENGINE_PROBES: usize = 4;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUpdateAdvisory {
    pub engine: String,
    pub display_name: String,
    pub state: String, // "outdated" | "up_to_date" | "not_installed" | "unknown"
    pub current_version: Option<String>,
    pub latest_version: Option<String>,
    pub update_command: String,
    pub install_command: Option<String>,
    pub binary_path: Option<String>,
    pub checked_at_unix_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUpdatesSummary {
    pub total_supported: usize,
    pub installed_count: usize,
    pub outdated_count: usize,
    pub advisories: HashMap<String, AgentUpdateAdvisory>,
    pub last_checked_unix_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolJobProgress {
    pub job_id: String,
    pub engine: String,
    pub action: String, // "update" | "install"
    pub status: String, // "pending" | "running" | "succeeded" | "failed" | "cancelled"
    pub percent: Option<f32>,
    pub last_line: Option<String>,
    pub error: Option<String>,
    pub started_at_unix_ms: i64,
    pub finished_at_unix_ms: Option<i64>,
}

#[derive(Clone)]
struct CachedRemoteVersion {
    version: String,
    fetched_at: Instant,
}

static REMOTE_VERSION_CACHE: OnceLock<RwLock<HashMap<String, CachedRemoteVersion>>> = OnceLock::new();
static ACTIVE_TOOL_JOBS: OnceLock<Mutex<HashMap<String, ToolJobProgress>>> = OnceLock::new();

fn get_remote_cache() -> &'static RwLock<HashMap<String, CachedRemoteVersion>> {
    REMOTE_VERSION_CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

fn get_active_jobs() -> &'static Mutex<HashMap<String, ToolJobProgress>> {
    ACTIVE_TOOL_JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn now_unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Parses standard semantic versions (e.g. "1.4.12", "v2.1.316", "grok 1.0.70 (hash)") into numeric parts.
pub fn parse_semver(v: &str) -> Option<(u32, u32, u32)> {
    let clean = v.trim();
    let start_idx = clean.find(|c: char| c.is_ascii_digit())?;
    let slice = &clean[start_idx..];
    let end_idx = slice
        .find(|c: char| !c.is_ascii_digit() && c != '.')
        .unwrap_or(slice.len());
    let ver_str = &slice[..end_idx];
    let parts: Vec<&str> = ver_str.split('.').collect();
    if parts.is_empty() {
        return None;
    }
    let major = parts[0].parse::<u32>().ok()?;
    let minor = if parts.len() > 1 {
        parts[1].parse::<u32>().unwrap_or(0)
    } else {
        0
    };
    let patch = if parts.len() > 2 {
        parts[2].parse::<u32>().unwrap_or(0)
    } else {
        0
    };
    Some((major, minor, patch))
}

pub fn compare_semver(current: &str, latest: &str) -> Option<std::cmp::Ordering> {
    let c = parse_semver(current)?;
    let l = parse_semver(latest)?;
    Some(c.cmp(&l))
}

struct EngineConfig {
    engine_id: &'static str,
    display_name: &'static str,
    update_cmd: &'static str,
    install_cmd: &'static str,
}

const SUPPORTED_ENGINES: &[EngineConfig] = &[
    EngineConfig {
        engine_id: "antigravity",
        display_name: "Antigravity",
        update_cmd: "agy update",
        install_cmd: "irm https://antigravity.google/cli/install.ps1 | iex",
    },
    EngineConfig {
        engine_id: "claude",
        display_name: "Claude Code",
        update_cmd: "claude update",
        install_cmd: "irm https://claude.ai/install.ps1 | iex",
    },
    EngineConfig {
        engine_id: "codex",
        display_name: "Codex",
        update_cmd: "codex update",
        install_cmd: "irm https://chatgpt.com/codex/install.ps1 | iex",
    },
    EngineConfig {
        engine_id: "grok",
        display_name: "Grok Build",
        update_cmd: "grok update",
        install_cmd: "irm https://x.ai/cli/install.ps1 | iex",
    },
    EngineConfig {
        engine_id: "opencode",
        display_name: "OpenCode",
        update_cmd: "npm install -g opencode-ai",
        install_cmd: "npm install -g opencode-ai",
    },
    EngineConfig {
        engine_id: "gemini",
        display_name: "Gemini CLI",
        update_cmd: "npm install -g @google/gemini-cli",
        install_cmd: "npm install -g @google/gemini-cli",
    },
    EngineConfig {
        engine_id: "kimi",
        display_name: "Kimi Code",
        update_cmd: "kimi upgrade",
        install_cmd: "irm https://code.kimi.com/kimi-code/install.ps1 | iex",
    },
    EngineConfig {
        engine_id: "copilot",
        display_name: "GitHub Copilot",
        update_cmd: "winget upgrade --id GitHub.Copilot",
        install_cmd: "winget install --id GitHub.Copilot --exact",
    },
    EngineConfig {
        engine_id: "cursor",
        display_name: "Cursor",
        update_cmd: "cursor-agent update",
        install_cmd: "irm https://cursor.com/install?win32=true | iex",
    },
    EngineConfig {
        engine_id: "droid",
        display_name: "Factory Droid",
        update_cmd: "factory update",
        install_cmd: "irm https://app.factory.ai/cli/windows | iex",
    },
];

/// Probes the local installed version of an engine by executing `--version` with a short timeout.
pub fn read_installed_version(engine: &str) -> Option<(String, String)> {
    let bin_path = terminal::resolve_engine_program(engine)?;
    let p = Path::new(&bin_path);
    if !p.is_file() {
        return None;
    }

    let timeout = Duration::from_millis(2500);

    let output = if cfg!(windows) {
        let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
        if ext == "cmd" || ext == "bat" {
            hidden_exec::run(
                Path::new("cmd.exe"),
                &["/c", &bin_path, "--version"],
                timeout,
            )
        } else if ext == "ps1" {
            let cmd_str = format!("& '{}' --version", bin_path);
            hidden_exec::run(
                Path::new("powershell.exe"),
                &["-NoProfile", "-Command", &cmd_str],
                timeout,
            )
        } else {
            hidden_exec::run(p, &["--version"], timeout)
        }
    } else {
        hidden_exec::run(p, &["--version"], timeout)
    };

    if let Ok(out) = output {
        if out.success() || !out.stdout.is_empty() {
            let text = out.stdout_lossy();
            if let Some((maj, min, pat)) = parse_semver(&text) {
                return Some((format!("{maj}.{min}.{pat}"), bin_path));
            }
        }
    }

    None
}

/// Fetches the latest published version of an engine with in-memory caching.
fn fetch_latest_remote_version(engine: &str, force_refresh: bool) -> Option<String> {
    if !force_refresh {
        if let Ok(cache) = get_remote_cache().read() {
            if let Some(entry) = cache.get(engine) {
                if entry.fetched_at.elapsed() < REGISTRY_CACHE_TTL {
                    return Some(entry.version.clone());
                }
            }
        }
    }

    let resolved = match engine {
        "antigravity" => {
            // Antigravity official updater manifest
            let url = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/windows_amd64.json";
            fetch_version_from_json_key(url, "version")
        }
        "claude" | "claude-code" => {
            fetch_version_from_npm("@anthropic-ai/claude-code")
        }
        "codex" => {
            fetch_version_from_npm("@openai/codex")
        }
        "opencode" => {
            fetch_version_from_npm("opencode-ai")
        }
        "gemini" => {
            fetch_version_from_npm("@google/gemini-cli")
        }
        "grok" => {
            // Check via grok native json command if installed
            if let Some(bin) = terminal::resolve_engine_program("grok") {
                if let Ok(out) = hidden_exec::run(
                    Path::new(&bin),
                    &["update", "--check", "--json"],
                    Duration::from_millis(3000),
                ) {
                    if out.success() {
                        let text = out.stdout_lossy();
                        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&text) {
                            if let Some(v) = parsed.get("latestVersion").and_then(|v| v.as_str()) {
                                if !v.trim().is_empty() {
                                    return Some(v.trim().to_string());
                                }
                            }
                        }
                    }
                }
            }
            fetch_version_from_npm("grok-build")
        }
        "kimi" => {
            fetch_version_from_npm("kimi")
        }
        _ => None,
    };

    if let Some(ref ver) = resolved {
        if let Ok(mut cache) = get_remote_cache().write() {
            cache.insert(
                engine.to_string(),
                CachedRemoteVersion {
                    version: ver.clone(),
                    fetched_at: Instant::now(),
                },
            );
        }
    }

    resolved
}

fn fetch_version_from_npm(pkg_name: &str) -> Option<String> {
    let url = format!("https://registry.npmjs.org/{}/latest", pkg_name);
    fetch_version_from_json_key(&url, "version")
}

static MAINTENANCE_HTTP_CLIENT: OnceLock<Option<reqwest::blocking::Client>> = OnceLock::new();

fn maintenance_http_client() -> Option<&'static reqwest::blocking::Client> {
    MAINTENANCE_HTTP_CLIENT
        .get_or_init(|| {
            reqwest::blocking::Client::builder()
                .timeout(Duration::from_millis(3500))
                .build()
                .ok()
        })
        .as_ref()
}

fn fetch_version_from_json_key(url: &str, key: &str) -> Option<String> {
    let client = maintenance_http_client()?;

    let resp = client
        .get(url)
        .header("accept", "application/json")
        .header("user-agent", "Kite-Code-Agent-Maintenance/1.0")
        .send()
        .ok()?;

    if !resp.status().is_success() {
        return None;
    }

    let json: serde_json::Value = resp.json().ok()?;
    json.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
}

pub(crate) struct AgentUpdatesSummaryCache {
    ttl: Duration,
    state: Mutex<Option<(Instant, AgentUpdatesSummary)>>,
    in_flight: Mutex<()>,
}

impl AgentUpdatesSummaryCache {
    pub(crate) const fn new(ttl: Duration) -> Self {
        Self {
            ttl,
            state: Mutex::new(None),
            in_flight: Mutex::new(()),
        }
    }

    pub(crate) fn get_or_compute(
        &self,
        force_refresh: bool,
        bypass_time_ttl: bool,
        compute: impl FnOnce() -> AgentUpdatesSummary,
    ) -> AgentUpdatesSummary {
        if !force_refresh && !bypass_time_ttl {
            let guard = self.state.lock().unwrap();
            if let Some((cached_at, summary)) = guard.as_ref() {
                if cached_at.elapsed() < self.ttl {
                    return summary.clone();
                }
            }
        }

        let _singleflight = self.in_flight.lock().unwrap();
        if !force_refresh && !bypass_time_ttl {
            let guard = self.state.lock().unwrap();
            if let Some((cached_at, summary)) = guard.as_ref() {
                if cached_at.elapsed() < self.ttl {
                    return summary.clone();
                }
            }
        }

        let fresh = compute();
        if !bypass_time_ttl {
            *self.state.lock().unwrap() = Some((Instant::now(), fresh.clone()));
        }
        fresh
    }

    pub(crate) fn invalidate(&self) {
        *self.state.lock().unwrap() = None;
    }
}

static SUMMARY_CACHE: OnceLock<AgentUpdatesSummaryCache> = OnceLock::new();

fn get_summary_cache() -> &'static AgentUpdatesSummaryCache {
    SUMMARY_CACHE.get_or_init(|| AgentUpdatesSummaryCache::new(SUMMARY_CACHE_TTL))
}

pub fn invalidate_summary_cache() {
    get_summary_cache().invalidate();
}

pub fn invalidate_remote_cache(engine: &str) {
    if let Ok(mut cache) = get_remote_cache().write() {
        cache.remove(engine);
    }
    invalidate_summary_cache();
    crate::chat::models::invalidate_thread_providers_cache();
}

fn probe_single_engine_advisory(
    cfg: &EngineConfig,
    force_refresh: bool,
    now: i64,
    read_installed: &(dyn Fn(&str) -> Option<(String, String)> + Sync),
    check_installed: &(dyn Fn(&str) -> bool + Sync),
    resolve_program: &(dyn Fn(&str) -> Option<String> + Sync),
    fetch_remote: &(dyn Fn(&str, bool) -> Option<String> + Sync),
) -> (bool, bool, AgentUpdateAdvisory) {
    let installed_info = read_installed(cfg.engine_id);
    let is_installed = installed_info.is_some() || check_installed(cfg.engine_id);
    let (current_ver, bin_path) = match installed_info {
        Some((ver, path)) => (Some(ver), Some(path)),
        None => (None, resolve_program(cfg.engine_id)),
    };

    let latest_ver = if is_installed || force_refresh {
        fetch_remote(cfg.engine_id, force_refresh)
    } else {
        None
    };

    let mut outdated = false;
    let state = if !is_installed {
        "not_installed".to_string()
    } else if let (Some(cur), Some(lat)) = (&current_ver, &latest_ver) {
        match compare_semver(cur, lat) {
            Some(std::cmp::Ordering::Less) => {
                outdated = true;
                "outdated".to_string()
            }
            Some(_) => "up_to_date".to_string(),
            None => "up_to_date".to_string(),
        }
    } else {
        // Binary exists, latest version not yet fetched or check failed
        "up_to_date".to_string()
    };

    let advisory = AgentUpdateAdvisory {
        engine: cfg.engine_id.to_string(),
        display_name: cfg.display_name.to_string(),
        state,
        current_version: current_ver,
        latest_version: latest_ver,
        update_command: cfg.update_cmd.to_string(),
        install_command: Some(cfg.install_cmd.to_string()),
        binary_path: bin_path,
        checked_at_unix_ms: now,
    };
    (is_installed, outdated, advisory)
}

fn compute_agent_updates_summary_with(
    engines: &[EngineConfig],
    max_concurrency: usize,
    force_refresh: bool,
    read_installed: &(dyn Fn(&str) -> Option<(String, String)> + Sync),
    check_installed: &(dyn Fn(&str) -> bool + Sync),
    resolve_program: &(dyn Fn(&str) -> Option<String> + Sync),
    fetch_remote: &(dyn Fn(&str, bool) -> Option<String> + Sync),
) -> AgentUpdatesSummary {
    let now = now_unix_ms();
    let total_supported = engines.len();
    let next_idx = AtomicUsize::new(0);
    let worker_count = max_concurrency.max(1).min(total_supported.max(1));

    let per_worker: Vec<Vec<(String, bool, bool, AgentUpdateAdvisory)>> =
        std::thread::scope(|s| {
            let handles: Vec<_> = (0..worker_count)
                .map(|_| {
                    s.spawn(|| {
                        let mut local = Vec::new();
                        loop {
                            let idx = next_idx.fetch_add(1, Ordering::Relaxed);
                            if idx >= engines.len() {
                                break;
                            }
                            let cfg = &engines[idx];
                            let (installed, outdated, advisory) = probe_single_engine_advisory(
                                cfg,
                                force_refresh,
                                now,
                                read_installed,
                                check_installed,
                                resolve_program,
                                fetch_remote,
                            );
                            local.push((cfg.engine_id.to_string(), installed, outdated, advisory));
                        }
                        local
                    })
                })
                .collect();

            handles
                .into_iter()
                .map(|h| h.join().unwrap_or_default())
                .collect()
        });

    let mut advisories = HashMap::with_capacity(total_supported);
    let mut installed_count = 0usize;
    let mut outdated_count = 0usize;
    for chunk in per_worker {
        for (engine_id, installed, outdated, advisory) in chunk {
            if installed {
                installed_count += 1;
            }
            if outdated {
                outdated_count += 1;
            }
            advisories.insert(engine_id, advisory);
        }
    }

    AgentUpdatesSummary {
        total_supported,
        installed_count,
        outdated_count,
        advisories,
        last_checked_unix_ms: now,
    }
}

fn compute_agent_updates_summary_uncached(force_refresh: bool) -> AgentUpdatesSummary {
    compute_agent_updates_summary_with(
        SUPPORTED_ENGINES,
        MAX_CONCURRENT_ENGINE_PROBES,
        force_refresh,
        &read_installed_version,
        &terminal::engine_installed,
        &terminal::resolve_engine_program,
        &fetch_latest_remote_version,
    )
}

/// Generates the complete summary of all supported engines and their update advisories.
pub fn compute_agent_updates_summary(force_refresh: bool) -> AgentUpdatesSummary {
    get_summary_cache().get_or_compute(force_refresh, cfg!(test), || {
        compute_agent_updates_summary_uncached(force_refresh)
    })
}

// ── Background Tool Execution ──────────────────────────────────────────────────

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PreparedToolCommand {
    pub(crate) program: PathBuf,
    pub(crate) args: Vec<String>,
    pub(crate) extra_path_dir: Option<PathBuf>,
}

fn normalize_path_key(seg: &str) -> String {
    if cfg!(windows) {
        seg.trim()
            .trim_matches('"')
            .trim_end_matches(['\\', '/'])
            .to_ascii_lowercase()
    } else {
        seg.trim().trim_end_matches('/').to_string()
    }
}

/// Deduplicates `PATH`, drops stale `kite-e2e-` sandbox entries, and prepends `prepend_dir`
/// so child shells (`cmd.exe`) stay safely below Windows' 8191-character variable ceiling.
pub(crate) fn compact_path_env(raw_path: &str, prepend_dir: Option<&Path>) -> String {
    let sep = if cfg!(windows) { ';' } else { ':' };
    let mut seen = HashSet::new();
    let mut entries: Vec<String> = Vec::new();

    if let Some(dir) = prepend_dir {
        let dir_str = dir.to_string_lossy().trim().to_string();
        if !dir_str.is_empty() {
            let key = normalize_path_key(&dir_str);
            if !key.is_empty() && seen.insert(key) {
                entries.push(dir_str);
            }
        }
    }

    for part in raw_path.split(sep) {
        let trimmed = part.trim();
        if trimmed.is_empty() || trimmed.to_ascii_lowercase().contains("kite-e2e-") {
            continue;
        }
        let key = normalize_path_key(trimmed);
        if !key.is_empty() && seen.insert(key) {
            entries.push(trimmed.to_string());
        }
    }

    let sep_str = if cfg!(windows) { ";" } else { ":" };
    let mut joined = entries.join(sep_str);
    if cfg!(windows) && joined.len() > 7500 {
        let prepend_key = prepend_dir
            .map(|d| normalize_path_key(&d.to_string_lossy()))
            .unwrap_or_default();
        entries.retain(|seg| {
            let norm = normalize_path_key(seg);
            norm == prepend_key || norm.contains("\\windows") || Path::new(seg).is_dir()
        });
        joined = entries.join(sep_str);
    }
    joined
}

fn resolve_windows_system_binary(rel_under_system32: &str, fallback_name: &str) -> PathBuf {
    if let Ok(root) = std::env::var("SystemRoot").or_else(|_| std::env::var("WINDIR")) {
        let candidate = PathBuf::from(root).join("System32").join(rel_under_system32);
        if candidate.is_file() {
            return candidate;
        }
    }
    PathBuf::from(fallback_name)
}

fn path_stem_matches(path: &str, expected_token: &str) -> bool {
    Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .is_some_and(|stem| stem.eq_ignore_ascii_case(expected_token))
}

fn has_shell_metachars(cmd: &str) -> bool {
    cmd.contains('|')
        || cmd.contains('&')
        || cmd.contains(';')
        || cmd.contains('>')
        || cmd.contains('<')
        || cmd.contains('$')
        || cmd.contains('`')
}

pub(crate) fn prepare_tool_command_with(
    engine: &str,
    command_to_run: &str,
    is_windows: bool,
    resolve_engine: &dyn Fn(&str) -> Option<String>,
    known_path: &dyn Fn(&str) -> Option<String>,
    where_prog: &dyn Fn(&str) -> Option<String>,
) -> PreparedToolCommand {
    if is_windows {
        if command_to_run.contains("| iex")
            || command_to_run.contains("irm ")
            || command_to_run.trim_end().ends_with(".ps1")
        {
            return PreparedToolCommand {
                program: resolve_windows_system_binary(
                    r"WindowsPowerShell\v1.0\powershell.exe",
                    "powershell.exe",
                ),
                args: vec![
                    "-NoProfile".to_string(),
                    "-ExecutionPolicy".to_string(),
                    "Bypass".to_string(),
                    "-Command".to_string(),
                    command_to_run.to_string(),
                ],
                extra_path_dir: None,
            };
        }

        let mut parts = command_to_run.split_whitespace();
        if let Some(program_token) = parts.next() {
            if !has_shell_metachars(command_to_run) {
                let resolved = resolve_engine(engine)
                    .filter(|p| path_stem_matches(p, program_token))
                    .or_else(|| known_path(program_token))
                    .or_else(|| where_prog(program_token));

                if let Some(bin_str) = resolved {
                    let bin_path = PathBuf::from(&bin_str);
                    let extra_path_dir = bin_path
                        .parent()
                        .filter(|p| !p.as_os_str().is_empty())
                        .map(Path::to_path_buf);
                    let rest: Vec<String> = parts.map(str::to_string).collect();
                    let ext = bin_path
                        .extension()
                        .and_then(|e| e.to_str())
                        .unwrap_or("")
                        .to_ascii_lowercase();

                    if ext == "cmd" || ext == "bat" {
                        let mut args = vec!["/c".to_string(), bin_str];
                        args.extend(rest);
                        return PreparedToolCommand {
                            program: resolve_windows_system_binary("cmd.exe", "cmd.exe"),
                            args,
                            extra_path_dir,
                        };
                    }
                    if ext == "ps1" {
                        let mut args = vec![
                            "-NoProfile".to_string(),
                            "-ExecutionPolicy".to_string(),
                            "Bypass".to_string(),
                            "-File".to_string(),
                            bin_str,
                        ];
                        args.extend(rest);
                        return PreparedToolCommand {
                            program: resolve_windows_system_binary(
                                r"WindowsPowerShell\v1.0\powershell.exe",
                                "powershell.exe",
                            ),
                            args,
                            extra_path_dir,
                        };
                    }
                    return PreparedToolCommand {
                        program: bin_path,
                        args: rest,
                        extra_path_dir,
                    };
                }
            }
        }

        return PreparedToolCommand {
            program: resolve_windows_system_binary("cmd.exe", "cmd.exe"),
            args: vec!["/c".to_string(), command_to_run.to_string()],
            extra_path_dir: None,
        };
    }

    if !has_shell_metachars(command_to_run) {
        let mut parts = command_to_run.split_whitespace();
        if let Some(program_token) = parts.next() {
            let resolved = resolve_engine(engine)
                .filter(|p| path_stem_matches(p, program_token))
                .or_else(|| known_path(program_token))
                .or_else(|| where_prog(program_token));
            if let Some(bin_str) = resolved {
                let bin_path = PathBuf::from(&bin_str);
                let extra_path_dir = bin_path
                    .parent()
                    .filter(|p| !p.as_os_str().is_empty())
                    .map(Path::to_path_buf);
                return PreparedToolCommand {
                    program: bin_path,
                    args: parts.map(str::to_string).collect(),
                    extra_path_dir,
                };
            }
        }
    }

    PreparedToolCommand {
        program: PathBuf::from("sh"),
        args: vec!["-c".to_string(), command_to_run.to_string()],
        extra_path_dir: None,
    }
}

pub(crate) fn validate_post_update_advisory(
    engine: &str,
    action: &str,
    summary: &AgentUpdatesSummary,
    fallback_output: Option<&str>,
) -> Option<String> {
    if action != "update" {
        return None;
    }
    let advisory = summary.advisories.get(engine)?;
    if advisory.state != "outdated" {
        return None;
    }
    let detail = match (&advisory.current_version, &advisory.latest_version) {
        (Some(cur), Some(lat)) => {
            format!("El comando terminó sin actualizar (sigue en v{cur}, disponible v{lat})")
        }
        _ => "El comando terminó pero la versión instalada sigue desactualizada".to_string(),
    };
    if let Some(line) = fallback_output.map(str::trim).filter(|s| !s.is_empty()) {
        let clipped: String = line.chars().take(140).collect();
        Some(format!("{detail}: {clipped}"))
    } else {
        Some(detail)
    }
}

pub fn execute_tool_job_background(
    app: AppHandle,
    job_id: String,
    engine: String,
    action: String,
) {
    let cfg = SUPPORTED_ENGINES.iter().find(|e| e.engine_id == engine);
    let command_to_run = match (cfg, action.as_str()) {
        (Some(c), "update") => c.update_cmd.to_string(),
        (Some(c), "install") => c.install_cmd.to_string(),
        _ => {
            let mut jobs = get_active_jobs().lock().unwrap();
            if let Some(job) = jobs.get_mut(&job_id) {
                job.status = "failed".to_string();
                job.error = Some("Motor o acción no soportada".to_string());
                job.finished_at_unix_ms = Some(now_unix_ms());
                let _ = app.emit("agent:tool-job-changed", &*job);
            }
            return;
        }
    };

    std::thread::spawn(move || {
        let prepared = prepare_tool_command_with(
            &engine,
            &command_to_run,
            cfg!(windows),
            &terminal::resolve_engine_program,
            &terminal::known_program_path,
            &terminal::where_program,
        );
        log_trace(&format!(
            "[agent_maintenance] Starting {action} for {engine}: {:?} {:?}",
            prepared.program, prepared.args
        ));

        let mut cmd = std::process::Command::new(&prepared.program);
        cmd.args(&prepared.args);
        if let Ok(raw_path) = std::env::var("PATH") {
            let compacted = compact_path_env(&raw_path, prepared.extra_path_dir.as_deref());
            if !compacted.is_empty() {
                cmd.env("PATH", compacted);
            }
        }
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        cmd.stdin(std::process::Stdio::null());
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());

        match cmd.spawn() {
            Ok(mut child) => {
                use std::io::{BufRead, BufReader};

                let stdout_reader = child.stdout.take().map(BufReader::new);
                let stderr_reader = child.stderr.take().map(BufReader::new);
                let last_stdout: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

                // Pipe stdout tracking
                let stdout_thread = stdout_reader.map(|reader| {
                    let job_id_clone = job_id.clone();
                    let app_clone = app.clone();
                    let last_stdout_clone = Arc::clone(&last_stdout);
                    std::thread::spawn(move || {
                        for line in reader.lines().flatten() {
                            let trimmed = line.trim();
                            if !trimmed.is_empty() {
                                if let Ok(mut guard) = last_stdout_clone.lock() {
                                    *guard = Some(trimmed.to_string());
                                }
                                let mut jobs = get_active_jobs().lock().unwrap();
                                if let Some(job) = jobs.get_mut(&job_id_clone) {
                                    job.last_line = Some(trimmed.to_string());
                                    let _ = app_clone.emit("agent:tool-job-changed", &*job);
                                }
                            }
                        }
                    })
                });

                let mut stderr_accum = String::new();
                if let Some(reader) = stderr_reader {
                    for line in reader.lines().flatten() {
                        stderr_accum.push_str(&line);
                        stderr_accum.push('\n');
                    }
                }

                let status = child.wait();
                if let Some(handle) = stdout_thread {
                    let _ = handle.join();
                }

                let (success, exit_code) = match status {
                    Ok(exit_status) => (exit_status.success(), exit_status.code()),
                    Err(_) => (false, None),
                };

                let last_stdout_line = last_stdout.lock().ok().and_then(|g| g.clone());
                let stderr_trimmed = stderr_accum.trim().to_string();
                let fallback_output = if !stderr_trimmed.is_empty() {
                    Some(stderr_trimmed.as_str())
                } else {
                    last_stdout_line.as_deref()
                };

                if success {
                    // Recompute summary before finalizing job status so an update that exited 0
                    // without advancing the version never reports false success.
                    invalidate_remote_cache(&engine);
                    crate::account_switcher::invalidate_detected_cli_accounts_cache();
                    let summary = compute_agent_updates_summary(true);
                    let post_check_err =
                        validate_post_update_advisory(&engine, &action, &summary, fallback_output);

                    let finished_now = now_unix_ms();
                    {
                        let mut jobs = get_active_jobs().lock().unwrap();
                        if let Some(job) = jobs.get_mut(&job_id) {
                            job.finished_at_unix_ms = Some(finished_now);
                            if let Some(err_msg) = post_check_err {
                                job.status = "failed".to_string();
                                job.error = Some(err_msg);
                            } else {
                                job.status = "succeeded".to_string();
                                job.percent = Some(100.0);
                            }
                            let _ = app.emit("agent:tool-job-changed", &*job);
                        }
                    }
                    let _ = app.emit("agent:updates-summary-changed", &summary);
                } else {
                    let finished_now = now_unix_ms();
                    let mut jobs = get_active_jobs().lock().unwrap();
                    if let Some(job) = jobs.get_mut(&job_id) {
                        job.finished_at_unix_ms = Some(finished_now);
                        job.status = "failed".to_string();
                        job.error = Some(if let Some(msg) = fallback_output {
                            msg.chars().take(240).collect()
                        } else if let Some(code) = exit_code {
                            format!("El proceso finalizó con error (código {code})")
                        } else {
                            "El proceso finalizó con error".to_string()
                        });
                        let _ = app.emit("agent:tool-job-changed", &*job);
                    }
                }
            }
            Err(e) => {
                log_trace(&format!(
                    "[agent_maintenance] Failed to spawn {:?}: {e}",
                    prepared.program
                ));
                let mut jobs = get_active_jobs().lock().unwrap();
                if let Some(job) = jobs.get_mut(&job_id) {
                    job.status = "failed".to_string();
                    job.error = Some(e.to_string());
                    job.finished_at_unix_ms = Some(now_unix_ms());
                    let _ = app.emit("agent:tool-job-changed", &*job);
                }
            }
        }
    });
}

// ── Tauri Commands ─────────────────────────────────────────────────────────────

fn extract_payload(req: &Option<serde_json::Value>) -> Option<&serde_json::Value> {
    req.as_ref().map(|v| v.get("request").unwrap_or(v))
}

pub fn get_agent_updates_summary_direct(
    request: Option<serde_json::Value>,
) -> Result<AgentUpdatesSummary, String> {
    let force_refresh = extract_payload(&request)
        .and_then(|b| b.get("forceRefresh"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    Ok(compute_agent_updates_summary(force_refresh))
}

#[tauri::command]
pub async fn get_agent_updates_summary(
    request: Option<serde_json::Value>,
) -> Result<AgentUpdatesSummary, String> {
    tauri::async_runtime::spawn_blocking(move || get_agent_updates_summary_direct(request))
        .await
        .map_err(|e| format!("agent updates task failed: {e}"))?
}

pub fn start_agent_tool_job_direct(
    app: AppHandle,
    request: Option<serde_json::Value>,
) -> Result<ToolJobProgress, String> {
    let payload = extract_payload(&request);
    let engine = payload
        .and_then(|b| b.get("engine"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let action = payload
        .and_then(|b| b.get("action"))
        .and_then(|v| v.as_str())
        .unwrap_or("update")
        .to_string();

    if engine.is_empty() {
        return Err("Engine ID es requerido".to_string());
    }

    let job_id = Uuid::new_v4().to_string();
    let initial_job = ToolJobProgress {
        job_id: job_id.clone(),
        engine: engine.clone(),
        action: action.clone(),
        status: "running".to_string(),
        percent: Some(0.0),
        last_line: Some(format!("Iniciando {}...", action)),
        error: None,
        started_at_unix_ms: now_unix_ms(),
        finished_at_unix_ms: None,
    };

    {
        let mut jobs = get_active_jobs().lock().unwrap();
        jobs.insert(job_id.clone(), initial_job.clone());
    }

    let _ = app.emit("agent:tool-job-changed", &initial_job);
    execute_tool_job_background(app, job_id, engine, action);

    Ok(initial_job)
}

#[tauri::command]
pub async fn start_agent_tool_job(
    app: AppHandle,
    request: Option<serde_json::Value>,
) -> Result<ToolJobProgress, String> {
    tauri::async_runtime::spawn_blocking(move || start_agent_tool_job_direct(app, request))
        .await
        .map_err(|e| format!("start agent tool job failed: {e}"))?
}

pub fn get_active_agent_tool_jobs_direct() -> Vec<ToolJobProgress> {
    let jobs = get_active_jobs().lock().unwrap();
    jobs.values().cloned().collect()
}

#[tauri::command]
pub async fn get_active_agent_tool_jobs() -> Vec<ToolJobProgress> {
    tauri::async_runtime::spawn_blocking(get_active_agent_tool_jobs_direct)
        .await
        .unwrap_or_default()
}

pub fn cancel_agent_tool_job_direct(request: Option<serde_json::Value>) -> Result<(), String> {
    let payload = extract_payload(&request);
    let job_id = payload
        .and_then(|b| b.get("jobId").or_else(|| b.get("job_id")))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    if job_id.is_empty() {
        return Err("Job ID es requerido".to_string());
    }

    let mut jobs = get_active_jobs().lock().unwrap();
    if let Some(job) = jobs.get_mut(job_id) {
        job.status = "cancelled".to_string();
        job.finished_at_unix_ms = Some(now_unix_ms());
        Ok(())
    } else {
        Err("Job no encontrado".to_string())
    }
}

#[tauri::command]
pub async fn cancel_agent_tool_job(request: Option<serde_json::Value>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || cancel_agent_tool_job_direct(request))
        .await
        .map_err(|e| format!("cancel agent tool job failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semver_parsing_and_comparison() {
        assert_eq!(parse_semver("1.4.5"), Some((1, 4, 5)));
        assert_eq!(parse_semver("v2.1.316"), Some((2, 1, 316)));
        assert_eq!(parse_semver("grok 1.0.70 (f50904)"), Some((1, 0, 70)));
        assert_eq!(parse_semver("codex-cli 0.164.0"), Some((0, 164, 0)));

        assert_eq!(compare_semver("1.4.5", "1.4.12"), Some(std::cmp::Ordering::Less));
        assert_eq!(compare_semver("1.4.12", "1.4.5"), Some(std::cmp::Ordering::Greater));
        assert_eq!(compare_semver("1.0.70", "1.0.70"), Some(std::cmp::Ordering::Equal));
    }

    #[test]
    fn summary_probes_engines_with_bounded_concurrency_and_caches_until_invalidated() {
        let active = AtomicUsize::new(0);
        let peak = AtomicUsize::new(0);
        let probe_calls = AtomicUsize::new(0);
        let engines = &SUPPORTED_ENGINES[..6.min(SUPPORTED_ENGINES.len())];

        let summary = compute_agent_updates_summary_with(
            engines,
            3,
            false,
            &|engine_id| {
                let cur = active.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(cur, Ordering::SeqCst);
                probe_calls.fetch_add(1, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(15));
                active.fetch_sub(1, Ordering::SeqCst);
                if engine_id == engines[0].engine_id {
                    Some(("1.0.0".to_string(), "/bin/agent0".to_string()))
                } else {
                    None
                }
            },
            &|_| false,
            &|_| None,
            &|engine_id, _| {
                if engine_id == engines[0].engine_id {
                    Some("1.1.0".to_string())
                } else {
                    None
                }
            },
        );

        assert_eq!(summary.total_supported, engines.len());
        assert_eq!(summary.installed_count, 1);
        assert_eq!(summary.outdated_count, 1);
        assert_eq!(probe_calls.load(Ordering::SeqCst), engines.len());
        assert!(peak.load(Ordering::SeqCst) <= 3);
        assert!(peak.load(Ordering::SeqCst) >= 2, "probes should run concurrently");

        // Cache hit, force_refresh refresh, write invalidation, and test bypass behavior.
        let cache = AgentUpdatesSummaryCache::new(Duration::from_secs(60));
        let compute_count = AtomicUsize::new(0);
        let _ = cache.get_or_compute(false, false, || {
            let n = compute_count.fetch_add(1, Ordering::SeqCst) + 1;
            let mut s = summary.clone();
            s.last_checked_unix_ms = n as i64;
            s
        });
        let cached = cache.get_or_compute(false, false, || {
            compute_count.fetch_add(1, Ordering::SeqCst);
            summary.clone()
        });
        assert_eq!(compute_count.load(Ordering::SeqCst), 1);
        assert_eq!(cached.last_checked_unix_ms, 1);

        let forced = cache.get_or_compute(true, false, || {
            let n = compute_count.fetch_add(1, Ordering::SeqCst) + 1;
            let mut s = summary.clone();
            s.last_checked_unix_ms = n as i64;
            s
        });
        assert_eq!(compute_count.load(Ordering::SeqCst), 2);
        assert_eq!(forced.last_checked_unix_ms, 2);

        cache.invalidate();
        let after_inv = cache.get_or_compute(false, false, || {
            let n = compute_count.fetch_add(1, Ordering::SeqCst) + 1;
            let mut s = summary.clone();
            s.last_checked_unix_ms = n as i64;
            s
        });
        assert_eq!(compute_count.load(Ordering::SeqCst), 3);
        assert_eq!(after_inv.last_checked_unix_ms, 3);
    }

    #[test]
    fn compact_path_env_strips_e2e_entries_dedups_and_prepends_binary_dir() {
        let raw = r"C:\Windows\System32;C:\Users\PC\AppData\Local\Temp\kite-e2e-1\bin;C:\WINDOWS\system32;C:\Tools\bin";
        let extra = Path::new(r"C:\Users\PC\AppData\Local\agy\bin");
        let compacted = compact_path_env(raw, Some(extra));
        assert_eq!(
            compacted,
            r"C:\Users\PC\AppData\Local\agy\bin;C:\Windows\System32;C:\Tools\bin"
        );
    }

    #[test]
    fn resolve_command_invocation_executes_matching_exe_directly_without_cmd_shell() {
        let prepared = prepare_tool_command_with(
            "antigravity",
            "agy update",
            true,
            &|engine| {
                if engine == "antigravity" {
                    Some(r"C:\Users\PC\AppData\Local\agy\bin\agy.exe".to_string())
                } else {
                    None
                }
            },
            &|_| None,
            &|_| None,
        );
        assert_eq!(
            prepared.program,
            std::path::PathBuf::from(r"C:\Users\PC\AppData\Local\agy\bin\agy.exe")
        );
        assert_eq!(prepared.args, vec!["update".to_string()]);
        assert_eq!(
            prepared.extra_path_dir,
            Some(std::path::PathBuf::from(r"C:\Users\PC\AppData\Local\agy\bin"))
        );

        // Non-engine binary (e.g., npm for opencode) uses `where` rather than `opencode.exe`.
        let npm_cmd = prepare_tool_command_with(
            "opencode",
            "npm install -g opencode-ai",
            true,
            &|_| Some(r"C:\Users\PC\.opencode\bin\opencode.exe".to_string()),
            &|_| None,
            &|name| {
                if name == "npm" {
                    Some(r"C:\Program Files\nodejs\npm.cmd".to_string())
                } else {
                    None
                }
            },
        );
        assert!(
            npm_cmd
                .program
                .file_name()
                .and_then(|s| s.to_str())
                .is_some_and(|s| s.eq_ignore_ascii_case("cmd.exe")),
            "expected cmd.exe wrapper for .cmd shim, got {:?}",
            npm_cmd.program
        );
        assert_eq!(
            npm_cmd.args,
            vec![
                "/c".to_string(),
                r"C:\Program Files\nodejs\npm.cmd".to_string(),
                "install".to_string(),
                "-g".to_string(),
                "opencode-ai".to_string(),
            ]
        );
    }

    #[test]
    fn evaluate_update_completion_rejects_exit_zero_when_still_outdated() {
        let mut advisories = HashMap::new();
        advisories.insert(
            "antigravity".to_string(),
            AgentUpdateAdvisory {
                engine: "antigravity".to_string(),
                display_name: "Antigravity".to_string(),
                state: "outdated".to_string(),
                current_version: Some("1.5.17".to_string()),
                latest_version: Some("1.5.18".to_string()),
                update_command: "agy update".to_string(),
                install_command: None,
                binary_path: Some(r"C:\Users\PC\AppData\Local\agy\bin\agy.exe".to_string()),
                checked_at_unix_ms: 1,
            },
        );
        let summary = AgentUpdatesSummary {
            total_supported: 1,
            installed_count: 1,
            outdated_count: 1,
            advisories,
            last_checked_unix_ms: 1,
        };
        let err = validate_post_update_advisory("antigravity", "update", &summary, None);
        assert!(err.is_some());
        assert!(err.unwrap().contains("1.5.17"));
    }
}
