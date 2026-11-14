// Agent update detection, semver advisories, and background tool jobs.
// Complies with Kite Code architectural guidelines: silent background execution,
// TTL-based registry caching, and zero intrusive UI popups.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock, RwLock};
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
        log_trace(&format!("[agent_maintenance] Starting {action} for {engine}: '{command_to_run}'"));

        let child_res = if cfg!(windows) {
            let mut cmd = if command_to_run.contains("| iex") || command_to_run.contains("irm ") || command_to_run.ends_with(".ps1") {
                let mut c = std::process::Command::new("powershell.exe");
                c.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &command_to_run]);
                c
            } else {
                let mut c = std::process::Command::new("cmd.exe");
                c.args(["/c", &command_to_run]);
                c
            };
            #[cfg(windows)]
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
            cmd.stdout(std::process::Stdio::piped());
            cmd.stderr(std::process::Stdio::piped());
            cmd.spawn()
        } else {
            let mut cmd = std::process::Command::new("sh");
            cmd.args(["-c", &command_to_run]);
            cmd.stdout(std::process::Stdio::piped());
            cmd.stderr(std::process::Stdio::piped());
            cmd.spawn()
        };

        match child_res {
            Ok(mut child) => {
                use std::io::{BufRead, BufReader};

                let stdout_reader = child.stdout.take().map(BufReader::new);
                let stderr_reader = child.stderr.take().map(BufReader::new);

                // Pipe stdout tracking
                if let Some(reader) = stdout_reader {
                    let job_id_clone = job_id.clone();
                    let app_clone = app.clone();
                    std::thread::spawn(move || {
                        for line in reader.lines().flatten() {
                            let trimmed = line.trim();
                            if !trimmed.is_empty() {
                                let mut jobs = get_active_jobs().lock().unwrap();
                                if let Some(job) = jobs.get_mut(&job_id_clone) {
                                    job.last_line = Some(trimmed.to_string());
                                    let _ = app_clone.emit("agent:tool-job-changed", &*job);
                                }
                            }
                        }
                    });
                }

                let mut stderr_accum = String::new();
                if let Some(reader) = stderr_reader {
                    for line in reader.lines().flatten() {
                        stderr_accum.push_str(&line);
                        stderr_accum.push('\n');
                    }
                }

                let status = child.wait();
                let success = match status {
                    Ok(exit_status) => exit_status.success(),
                    Err(_) => false,
                };

                let finished_now = now_unix_ms();
                {
                    let mut jobs = get_active_jobs().lock().unwrap();
                    if let Some(job) = jobs.get_mut(&job_id) {
                        job.finished_at_unix_ms = Some(finished_now);
                        if success {
                            job.status = "succeeded".to_string();
                            job.percent = Some(100.0);
                        } else {
                            job.status = "failed".to_string();
                            job.error = Some(if !stderr_accum.is_empty() {
                                stderr_accum.chars().take(200).collect()
                            } else {
                                "El proceso finalizó con error".to_string()
                            });
                        }
                        let _ = app.emit("agent:tool-job-changed", &*job);
                    }
                }

                if success {
                    // Invalidate caches and broadcast fresh summary
                    invalidate_remote_cache(&engine);
                    crate::account_switcher::invalidate_detected_cli_accounts_cache();
                    let summary = compute_agent_updates_summary(true);
                    let _ = app.emit("agent:updates-summary-changed", &summary);
                }
            }
            Err(e) => {
                log_trace(&format!("[agent_maintenance] Failed to spawn {command_to_run}: {e}"));
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
}
