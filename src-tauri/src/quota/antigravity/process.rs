use crate::quota::utils::{silent_command, user_home_dir};
use serde_json::Value;
use std::path::PathBuf;
use std::time::Duration;

pub struct AntigravityProcessInfo {
    pub pid: u32,
    pub csrf_token: String,
    pub port: u16,
}

pub fn detect_antigravity_process() -> Option<AntigravityProcessInfo> {
    #[cfg(target_os = "windows")]
    {
        if let Ok(out) = crate::hidden_exec::run(std::path::Path::new("tasklist.exe"), &["/FO", "CSV", "/NH"], Duration::from_secs(5)) {
            let list_str = String::from_utf8_lossy(&out.stdout).to_lowercase();
            if !list_str.contains("language_server") && !list_str.contains("antigravity") {
                return None;
            }
        }

        let ps_cmd = r#"Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and ($_.CommandLine -like '*antigravity*' -or $_.Name -like '*language_server*') } | Select-Object ProcessId, Name, CommandLine | ConvertTo-Json -Compress"#;
        let output = crate::hidden_exec::run(
            std::path::Path::new("powershell.exe"),
            &["-NoProfile", "-NonInteractive", "-Command", ps_cmd],
            Duration::from_secs(6),
        )
        .ok()?;

        if output.code != Some(0) {
            return None;
        }

        let text = String::from_utf8_lossy(&output.stdout);
        let procs: Value = serde_json::from_str(&text).ok()?;
        let arr = if procs.is_array() {
            procs.as_array()?.clone()
        } else {
            vec![procs]
        };

        for p in arr {
            let cmd_line = p.get("CommandLine").and_then(|v| v.as_str()).unwrap_or("");
            let name = p.get("Name").and_then(|v| v.as_str()).unwrap_or("");
            if !cmd_line.to_lowercase().contains("antigravity") {
                continue;
            }
            if !name.to_lowercase().contains("language_server") && !cmd_line.contains("--csrf_token") {
                continue;
            }

            let pid = p.get("ProcessId").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            let csrf_token = extract_arg(cmd_line, "--csrf_token").unwrap_or_default();
            let port = extract_arg(cmd_line, "--extension_server_port")
                .and_then(|s| s.parse::<u16>().ok())
                .unwrap_or(0);

            if !csrf_token.is_empty() {
                return Some(AntigravityProcessInfo {
                    pid,
                    csrf_token,
                    port,
                });
            }
        }
    }
    None
}

pub fn extract_arg(cmd_line: &str, arg_name: &str) -> Option<String> {
    let mut parts = cmd_line.split_whitespace();
    while let Some(part) = parts.next() {
        if part == arg_name {
            return parts.next().map(|s| s.trim_matches('"').trim_matches('\'').to_string());
        }
        if let Some(rest) = part.strip_prefix(&format!("{}=", arg_name)) {
            return Some(rest.trim_matches('"').trim_matches('\'').to_string());
        }
    }
    None
}

pub fn discover_listening_ports(pid: u32) -> Vec<u16> {
    #[cfg(target_os = "windows")]
    {
        // Try netstat first for fast resolution (<50ms)
        if let Ok(out) = crate::hidden_exec::run(std::path::Path::new("netstat.exe"), &["-ano"], Duration::from_secs(5)) {
            let text = String::from_utf8_lossy(&out.stdout);
            let mut ports = Vec::new();
            let pid_str = pid.to_string();
            for line in text.lines() {
                if !line.contains("LISTENING") && !line.contains("LISTEN") {
                    continue;
                }
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 5 && parts[parts.len() - 1] == pid_str {
                    if let Some(pos) = parts[1].rfind(':') {
                        if let Ok(port) = parts[1][pos + 1..].parse::<u16>() {
                            if !ports.contains(&port) {
                                ports.push(port);
                            }
                        }
                    }
                }
            }
            if !ports.is_empty() {
                return ports;
            }
        }

        let ps_cmd = format!(
            "Get-NetTCPConnection -OwningProcess {} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort",
            pid
        );
        if let Ok(out) = crate::hidden_exec::run(
            std::path::Path::new("powershell.exe"),
            &["-NoProfile", "-NonInteractive", "-Command", &ps_cmd],
            Duration::from_secs(5),
        ) {
            if out.code == Some(0) {
                let text = String::from_utf8_lossy(&out.stdout);
                let mut ports = Vec::new();
                for line in text.lines() {
                    if let Ok(port) = line.trim().parse::<u16>() {
                        if !ports.contains(&port) {
                            ports.push(port);
                        }
                    }
                }
                return ports;
            }
        }
    }
    Vec::new()
}

pub fn probe_antigravity_rpc(port: u16, csrf_token: &str) -> Option<Value> {
    let auth_header = format!("X-Codeium-Csrf-Token: {}", csrf_token);

    // Try HTTPS first (self-signed cert), then HTTP fallback
    for proto in ["https", "http"] {
        let url = format!(
            "{}://127.0.0.1:{}/exa.language_server_pb.LanguageServerService/GetUserStatus",
            proto, port
        );

        let output = silent_command("curl.exe")
            .args([
                "-s",
                "-k",
                "-X",
                "POST",
                &url,
                "-H",
                "Content-Type: application/json",
                "-H",
                "Connect-Protocol-Version: 1",
                "-H",
                &auth_header,
                "--data-raw",
                r#"{"metadata":{"ideName":"antigravity","extensionName":"antigravity","locale":"en"}}"#,
                "--max-time",
                "3",
            ])
            .output()
            .ok();

        if let Some(out) = output {
            if out.status.success() {
                let body = String::from_utf8_lossy(&out.stdout);
                if let Ok(json_val) = serde_json::from_str::<Value>(&body) {
                    if json_val.get("userStatus").is_some() {
                        return Some(json_val);
                    }
                }
            }
        }
    }
    None
}

pub fn resolve_antigravity_binary() -> PathBuf {
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let p = PathBuf::from(local).join("agy").join("bin").join("agy.exe");
        if p.exists() {
            return p;
        }
    }
    if let Ok(profile) = std::env::var("USERPROFILE") {
        let p = PathBuf::from(profile).join("AppData").join("Local").join("agy").join("bin").join("agy.exe");
        if p.exists() {
            return p;
        }
    }
    let home = user_home_dir();
    let p = home.join(".local").join("bin").join("agy.exe");
    if p.exists() {
        return p;
    }
    let p_unix = home.join(".local").join("bin").join("agy");
    if p_unix.exists() {
        return p_unix;
    }
    PathBuf::from("agy")
}
