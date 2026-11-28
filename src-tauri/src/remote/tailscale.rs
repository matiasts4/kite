use crate::remote::auth::is_tailscale_cgnat;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::Read;
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const STATUS_CACHE_TTL: Duration = Duration::from_secs(5);
const PROBE_TIMEOUT: Duration = Duration::from_secs(4);
const APPLY_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TailscaleStatus {
    pub installed: bool,
    pub cli_path: Option<String>,
    pub backend_state: String,
    pub running: bool,
    pub ipv4: Option<String>,
    pub dns_name: Option<String>,
    pub magic_dns_suffix: Option<String>,
    pub funnel_capable: bool,
    pub configured_mode: String,
    pub active_mode: String,
    pub https_url: Option<String>,
    pub direct_ip_url: Option<String>,
    pub approval_url: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ParsedTailscaleNode {
    pub backend_state: String,
    pub running: bool,
    pub ipv4: Option<String>,
    pub dns_name: Option<String>,
    pub magic_dns_suffix: Option<String>,
    pub funnel_capable: bool,
}

#[derive(Debug, Clone)]
struct CachedProbe {
    captured_at: Instant,
    port: u16,
    bind_mode: String,
    configured_mode: String,
    status: TailscaleStatus,
}

static PROBE_CACHE: Mutex<Option<CachedProbe>> = Mutex::new(None);
static LAST_APPLY_FEEDBACK: Mutex<Option<(Option<String>, Option<String>)>> = Mutex::new(None);

pub fn invalidate_cache() {
    if let Ok(mut guard) = PROBE_CACHE.lock() {
        *guard = None;
    }
}

fn set_apply_feedback(last_error: Option<String>, approval_url: Option<String>) {
    if let Ok(mut guard) = LAST_APPLY_FEEDBACK.lock() {
        if last_error.is_none() && approval_url.is_none() {
            *guard = None;
        } else {
            *guard = Some((last_error, approval_url));
        }
    }
}

fn get_apply_feedback() -> (Option<String>, Option<String>) {
    LAST_APPLY_FEEDBACK
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .unwrap_or((None, None))
}

pub fn normalize_tailscale_mode(raw: &str) -> Result<String, String> {
    let norm = raw.trim().to_ascii_lowercase();
    match norm.as_str() {
        "off" | "serve" | "funnel" => Ok(norm),
        _ => Err("tailscaleMode must be 'off', 'serve', or 'funnel'.".to_string()),
    }
}

pub fn validate_public_url(raw: &str) -> Result<Option<String>, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.chars().any(char::is_whitespace) {
        return Err("publicUrl must not contain whitespace.".to_string());
    }

    let lower = trimmed.to_ascii_lowercase();
    let (scheme, rest) = if let Some(r) = lower.strip_prefix("https://") {
        let orig_rest = &trimmed["https://".len()..];
        let _ = r;
        ("https", orig_rest)
    } else if let Some(r) = lower.strip_prefix("http://") {
        let orig_rest = &trimmed["http://".len()..];
        let _ = r;
        ("http", orig_rest)
    } else {
        return Err("publicUrl must start with https:// or http://.".to_string());
    };

    if rest.contains('@') {
        return Err("publicUrl must not contain credentials or '@'." .to_string());
    }
    if rest.contains('?') || rest.contains('#') {
        return Err("publicUrl must not contain query strings or fragments.".to_string());
    }

    let authority_trimmed = rest.trim_end_matches('/');
    if authority_trimmed.contains('/') {
        return Err("publicUrl must not include path segments.".to_string());
    }
    if authority_trimmed.is_empty() {
        return Err("publicUrl must include a hostname.".to_string());
    }

    let host_part = if authority_trimmed.starts_with('[') {
        let Some(end_bracket) = authority_trimmed.find(']') else {
            return Err("publicUrl has an unclosed IPv6 host bracket.".to_string());
        };
        let after = &authority_trimmed[end_bracket + 1..];
        if !after.is_empty() {
            let Some(port_str) = after.strip_prefix(':') else {
                return Err("publicUrl has an invalid authority after host.".to_string());
            };
            validate_port_str(port_str)?;
        }
        &authority_trimmed[..=end_bracket]
    } else if let Some((host, port_str)) = authority_trimmed.split_once(':') {
        if port_str.contains(':') {
            return Err("IPv6 hosts in publicUrl must be wrapped in brackets.".to_string());
        }
        validate_port_str(port_str)?;
        host
    } else {
        authority_trimmed
    };

    if host_part.is_empty() {
        return Err("publicUrl must include a non-empty hostname.".to_string());
    }

    Ok(Some(format!("{scheme}://{authority_trimmed}")))
}

fn validate_port_str(port_str: &str) -> Result<u16, String> {
    if port_str.is_empty() || !port_str.chars().all(|c| c.is_ascii_digit()) {
        return Err("publicUrl port must be numeric.".to_string());
    }
    let port = port_str
        .parse::<u16>()
        .map_err(|_| "publicUrl port must be between 1 and 65535.".to_string())?;
    if port == 0 {
        return Err("publicUrl port must be between 1 and 65535.".to_string());
    }
    Ok(port)
}

pub fn parse_tailscale_status_json(raw: &str) -> ParsedTailscaleNode {
    let Ok(val) = serde_json::from_str::<Value>(raw) else {
        return ParsedTailscaleNode {
            backend_state: "Unknown".to_string(),
            ..Default::default()
        };
    };

    let backend_state = val
        .get("BackendState")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Unknown")
        .to_string();
    let running = backend_state.eq_ignore_ascii_case("Running");

    let self_node = val.get("Self");
    let dns_name = self_node
        .and_then(|s| s.get("DNSName"))
        .and_then(Value::as_str)
        .map(|s| s.trim().trim_end_matches('.').to_string())
        .filter(|s| !s.is_empty());

    let ipv4 = self_node
        .and_then(|s| s.get("TailscaleIPs"))
        .and_then(Value::as_array)
        .and_then(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .filter_map(|ip_str| ip_str.trim().parse::<Ipv4Addr>().ok())
                .find(|ip| is_tailscale_cgnat(*ip))
                .map(|ip| ip.to_string())
        });

    let magic_dns_suffix = val
        .get("MagicDNSSuffix")
        .or_else(|| val.get("CurrentTailnet").and_then(|ct| ct.get("MagicDNSSuffix")))
        .and_then(Value::as_str)
        .map(|s| s.trim().trim_end_matches('.').to_string())
        .filter(|s| !s.is_empty());

    let funnel_capable = self_node
        .and_then(|s| s.get("Capabilities"))
        .and_then(Value::as_array)
        .is_some_and(|caps| {
            caps.iter().filter_map(Value::as_str).any(|cap| {
                let lower = cap.trim().to_ascii_lowercase();
                lower == "funnel"
                    || lower == "https://tailscale.com/cap/funnel"
                    || lower.ends_with("/cap/funnel")
            })
        });

    ParsedTailscaleNode {
        backend_state,
        running,
        ipv4,
        dns_name,
        magic_dns_suffix,
        funnel_capable,
    }
}

fn proxy_matches_port(proxy_raw: &str, expected_port: u16) -> bool {
    let trimmed = proxy_raw.trim().trim_end_matches('/').to_ascii_lowercase();
    let port_suffix = format!(":{expected_port}");
    if !trimmed.ends_with(&port_suffix) {
        return false;
    }
    let prefix = &trimmed[..trimmed.len() - port_suffix.len()];
    matches!(
        prefix,
        "http://127.0.0.1"
            | "http://localhost"
            | "http://[::1]"
            | "https://127.0.0.1"
            | "https://localhost"
            | "127.0.0.1"
            | "localhost"
            | "[::1]"
            | "tcp://127.0.0.1"
            | "tcp://localhost"
    )
}

fn clean_serve_host_key(raw_key: &str, fallback_dns: Option<&str>) -> Option<String> {
    let no_port = raw_key
        .trim()
        .strip_suffix(":443")
        .unwrap_or_else(|| raw_key.trim())
        .trim_end_matches('.');
    if no_port.is_empty() || no_port.contains("${TS_CERT_DOMAIN}") {
        return fallback_dns
            .map(|d| d.trim().trim_end_matches('.').to_string())
            .filter(|d| !d.is_empty());
    }
    Some(no_port.to_string())
}

pub fn parse_serve_status_json(
    raw: &str,
    expected_port: u16,
    fallback_dns: Option<&str>,
) -> (String, Option<String>) {
    let Ok(val) = serde_json::from_str::<Value>(raw) else {
        return ("off".to_string(), None);
    };
    let Some(web_map) = val.get("Web").and_then(Value::as_object) else {
        return ("off".to_string(), None);
    };

    let allow_funnel_map = val.get("AllowFunnel").and_then(Value::as_object);
    let mut matched_serve: Option<(String, String)> = None;

    for (web_key, entry) in web_map {
        let Some(handlers) = entry.get("Handlers").and_then(Value::as_object) else {
            continue;
        };
        let has_matching_proxy = handlers.values().any(|handler| {
            handler
                .get("Proxy")
                .and_then(Value::as_str)
                .is_some_and(|p| proxy_matches_port(p, expected_port))
        });
        if !has_matching_proxy {
            continue;
        }
        let Some(clean_host) = clean_serve_host_key(web_key, fallback_dns) else {
            continue;
        };

        let is_funnel = allow_funnel_map.is_some_and(|map| {
            let candidates = [
                web_key.as_str(),
                clean_host.as_str(),
            ];
            candidates
                .iter()
                .any(|k| map.get(*k).and_then(Value::as_bool) == Some(true))
                || map
                    .get(&format!("{clean_host}:443"))
                    .and_then(Value::as_bool)
                    == Some(true)
        });

        let https_url = format!("https://{clean_host}");
        if is_funnel {
            return ("funnel".to_string(), Some(https_url));
        }
        if matched_serve.is_none() {
            matched_serve = Some(("serve".to_string(), https_url));
        }
    }

    match matched_serve {
        Some((mode, url)) => (mode, Some(url)),
        None => ("off".to_string(), None),
    }
}

pub fn extract_tailscale_approval_url(text: &str) -> Option<String> {
    let needle = "https://login.tailscale.com/";
    let start = text.find(needle)?;
    let slice = &text[start..];
    let raw: String = slice
        .chars()
        .take_while(|c| !c.is_whitespace() && !matches!(c, '"' | '\'' | '<' | '>'))
        .collect();
    let trimmed = raw
        .trim_end_matches(|c: char| matches!(c, '.' | ',' | ')' | ']' | ';' | '"' | '\''));
    if trimmed.len() <= needle.len() {
        return None;
    }
    Some(trimmed.to_string())
}

fn find_tailscale_cli() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    let exe_name = if cfg!(windows) { "tailscale.exe" } else { "tailscale" };

    if let Some(path_env) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_env) {
            candidates.push(dir.join(exe_name));
        }
    }

    #[cfg(windows)]
    {
        for env_key in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
            if let Some(base) = std::env::var_os(env_key) {
                candidates.push(PathBuf::from(base).join("Tailscale").join("tailscale.exe"));
            }
        }
        candidates.push(PathBuf::from(r"C:\Program Files\Tailscale\tailscale.exe"));
        candidates.push(PathBuf::from(r"C:\Program Files (x86)\Tailscale\tailscale.exe"));
    }

    #[cfg(not(windows))]
    {
        candidates.push(PathBuf::from("/usr/bin/tailscale"));
        candidates.push(PathBuf::from("/usr/local/bin/tailscale"));
        candidates.push(PathBuf::from("/opt/homebrew/bin/tailscale"));
    }

    candidates.into_iter().find(|p| p.is_file())
}

struct CliOutput {
    success: bool,
    stdout: String,
    stderr: String,
}

fn run_tailscale_cli(cli: &Path, args: &[&str], timeout: Duration) -> Result<CliOutput, String> {
    let mut cmd = Command::new(cli);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed starting Tailscale CLI ({}): {e}", cli.display()))?;

    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();

    let stdout_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut r) = stdout_pipe {
            let _ = r.read_to_end(&mut buf);
        }
        String::from_utf8_lossy(&buf).into_owned()
    });
    let stderr_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut r) = stderr_pipe {
            let _ = r.read_to_end(&mut buf);
        }
        String::from_utf8_lossy(&buf).into_owned()
    });

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    let stdout = stdout_handle.join().unwrap_or_default();
                    let stderr = stderr_handle.join().unwrap_or_default();
                    if !stdout.trim().is_empty() || !stderr.trim().is_empty() {
                        return Ok(CliOutput {
                            success: false,
                            stdout,
                            stderr,
                        });
                    }
                    return Err(format!(
                        "Tailscale command timed out after {}s.",
                        timeout.as_secs()
                    ));
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(err) => {
                let _ = child.kill();
                let _ = stdout_handle.join();
                let _ = stderr_handle.join();
                return Err(format!("Failed waiting for Tailscale CLI: {err}"));
            }
        }
    };

    let stdout = stdout_handle.join().unwrap_or_default();
    let stderr = stderr_handle.join().unwrap_or_default();
    Ok(CliOutput {
        success: status.success(),
        stdout,
        stderr,
    })
}

fn unconfigured_status(configured_mode: &str) -> TailscaleStatus {
    let (last_error, approval_url) = get_apply_feedback();
    TailscaleStatus {
        installed: false,
        cli_path: None,
        backend_state: "NotInstalled".to_string(),
        running: false,
        ipv4: None,
        dns_name: None,
        magic_dns_suffix: None,
        funnel_capable: false,
        configured_mode: configured_mode.to_string(),
        active_mode: "off".to_string(),
        https_url: None,
        direct_ip_url: None,
        approval_url,
        last_error,
    }
}

pub fn probe_status(
    port: u16,
    bind_mode: &str,
    configured_mode: &str,
    force_refresh: bool,
) -> TailscaleStatus {
    let norm_configured = normalize_tailscale_mode(configured_mode).unwrap_or_else(|_| "off".into());

    if !force_refresh {
        if let Ok(guard) = PROBE_CACHE.lock() {
            if let Some(cached) = guard.as_ref() {
                if cached.captured_at.elapsed() < STATUS_CACHE_TTL
                    && cached.port == port
                    && cached.bind_mode == bind_mode
                    && cached.configured_mode == norm_configured
                {
                    return cached.status.clone();
                }
            }
        }
    }

    let Some(cli) = find_tailscale_cli() else {
        let st = unconfigured_status(&norm_configured);
        if let Ok(mut guard) = PROBE_CACHE.lock() {
            *guard = Some(CachedProbe {
                captured_at: Instant::now(),
                port,
                bind_mode: bind_mode.to_string(),
                configured_mode: norm_configured,
                status: st.clone(),
            });
        }
        return st;
    };

    let (mut last_error, mut approval_url) = get_apply_feedback();
    let mut node = match run_tailscale_cli(&cli, &["status", "--json"], PROBE_TIMEOUT) {
        Ok(out) if out.success => parse_tailscale_status_json(&out.stdout),
        Ok(out) => {
            let combined = format!("{}\n{}", out.stdout.trim(), out.stderr.trim());
            if approval_url.is_none() {
                approval_url = extract_tailscale_approval_url(&combined);
            }
            if last_error.is_none() && !combined.trim().is_empty() {
                last_error = Some(combined.trim().to_string());
            }
            ParsedTailscaleNode {
                backend_state: "Error".to_string(),
                ..Default::default()
            }
        }
        Err(err) => {
            if last_error.is_none() {
                last_error = Some(err);
            }
            ParsedTailscaleNode {
                backend_state: "Error".to_string(),
                ..Default::default()
            }
        }
    };

    if node.running && node.ipv4.is_none() {
        if let Ok(ip_out) = run_tailscale_cli(&cli, &["ip", "-4"], PROBE_TIMEOUT) {
            if ip_out.success {
                node.ipv4 = crate::remote::auth::parse_tailscale_ipv4_from_text(&ip_out.stdout)
                    .into_iter()
                    .next();
            }
        }
    }

    let (active_mode, mut https_url) = if node.running {
        match run_tailscale_cli(&cli, &["serve", "status", "--json"], PROBE_TIMEOUT) {
            Ok(out) if out.success => {
                parse_serve_status_json(&out.stdout, port, node.dns_name.as_deref())
            }
            _ => ("off".to_string(), None),
        }
    } else {
        ("off".to_string(), None)
    };

    if https_url.is_none() && (active_mode == "serve" || active_mode == "funnel") {
        https_url = node.dns_name.as_ref().map(|d| format!("https://{d}"));
    }

    let direct_ip_url = if bind_mode != "loopback" {
        node.ipv4.as_ref().map(|ip| format!("http://{ip}:{port}"))
    } else {
        None
    };

    let status = TailscaleStatus {
        installed: true,
        cli_path: Some(cli.to_string_lossy().into_owned()),
        backend_state: node.backend_state,
        running: node.running,
        ipv4: node.ipv4,
        dns_name: node.dns_name,
        magic_dns_suffix: node.magic_dns_suffix,
        funnel_capable: node.funnel_capable,
        configured_mode: norm_configured.clone(),
        active_mode,
        https_url,
        direct_ip_url,
        approval_url,
        last_error,
    };

    if let Ok(mut guard) = PROBE_CACHE.lock() {
        *guard = Some(CachedProbe {
            captured_at: Instant::now(),
            port,
            bind_mode: bind_mode.to_string(),
            configured_mode: norm_configured,
            status: status.clone(),
        });
    }

    status
}

pub fn apply_tailscale_mode(
    mode: &str,
    port: u16,
    bind_mode: &str,
) -> Result<TailscaleStatus, String> {
    let norm_mode = normalize_tailscale_mode(mode)?;
    let Some(cli) = find_tailscale_cli() else {
        let msg = "Tailscale CLI no está instalado en este equipo. Instálalo con: winget install Tailscale.Tailscale".to_string();
        set_apply_feedback(Some(msg.clone()), None);
        invalidate_cache();
        return Err(msg);
    };

    let target = format!("http://127.0.0.1:{port}");
    match norm_mode.as_str() {
        "off" => {
            let _ = run_tailscale_cli(&cli, &["funnel", "--https=443", "off"], APPLY_TIMEOUT);
            let _ = run_tailscale_cli(&cli, &["serve", "--https=443", "off"], APPLY_TIMEOUT);
            set_apply_feedback(None, None);
        }
        "serve" => {
            let _ = run_tailscale_cli(&cli, &["funnel", "--https=443", "off"], APPLY_TIMEOUT);
            let out = run_tailscale_cli(
                &cli,
                &["serve", "--bg", "--yes", "--https=443", &target],
                APPLY_TIMEOUT,
            )?;
            if !out.success {
                return handle_apply_failure(out, &norm_mode, port, bind_mode);
            }
            set_apply_feedback(None, None);
        }
        "funnel" => {
            let out = run_tailscale_cli(
                &cli,
                &["funnel", "--bg", "--yes", "--https=443", &target],
                APPLY_TIMEOUT,
            )?;
            if !out.success {
                return handle_apply_failure(out, &norm_mode, port, bind_mode);
            }
            set_apply_feedback(None, None);
        }
        _ => unreachable!(),
    }

    invalidate_cache();
    Ok(probe_status(port, bind_mode, &norm_mode, true))
}

fn handle_apply_failure(
    out: CliOutput,
    configured_mode: &str,
    port: u16,
    bind_mode: &str,
) -> Result<TailscaleStatus, String> {
    let combined = format!("{}\n{}", out.stdout.trim(), out.stderr.trim())
        .trim()
        .to_string();
    let approval_url = extract_tailscale_approval_url(&combined);
    let err_msg = if let Some(ref url) = approval_url {
        format!(
            "Tailscale requiere autorización en tu cuenta para activar {configured_mode}: {url}"
        )
    } else if !combined.is_empty() {
        combined
    } else {
        format!("No se pudo aplicar el modo Tailscale '{configured_mode}'.")
    };
    set_apply_feedback(Some(err_msg.clone()), approval_url);
    invalidate_cache();
    let _ = probe_status(port, bind_mode, configured_mode, true);
    Err(err_msg)
}
