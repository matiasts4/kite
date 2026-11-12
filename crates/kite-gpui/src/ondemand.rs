//! On-demand WebView2 host for settings, the browser dock, and account.
//!
//! The native deck does not start this host. Closing the host window exits
//! its process.

use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::{Mutex, OnceLock};

static ACTIVE_ONDEMAND_HOST: OnceLock<Mutex<Option<Child>>> = OnceLock::new();

fn active_host() -> &'static Mutex<Option<Child>> {
    ACTIVE_ONDEMAND_HOST.get_or_init(|| Mutex::new(None))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OnDemandPanel {
    Settings,
    Browser,
    Account,
}

impl OnDemandPanel {
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "settings" => Some(Self::Settings),
            "browser" => Some(Self::Browser),
            "account" => Some(Self::Account),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Settings => "settings",
            Self::Browser => "browser",
            Self::Account => "account",
        }
    }

    pub fn title(self) -> &'static str {
        match self {
            Self::Settings => "Settings",
            Self::Browser => "Browser",
            Self::Account => "Account",
        }
    }
}

pub fn host_path(current_exe: &Path) -> PathBuf {
    current_exe.with_file_name("kite-ondemand.exe")
}

pub fn resolve_host(current_exe: &Path) -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("KITE_ONDEMAND_EXE") {
        let path = PathBuf::from(explicit.trim());
        if path.is_file() {
            return Some(path);
        }
    }
    let sibling = host_path(current_exe);
    if sibling.is_file() {
        return Some(sibling);
    }
    if let Some(dir) = current_exe.parent() {
        let same_dir = dir.join("kite-code.exe");
        if same_dir.is_file() {
            return Some(same_dir);
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        for rel in [
            "src-tauri/target/release/kite-code.exe",
            "src-tauri/target/debug/kite-code.exe",
        ] {
            let candidate = cwd.join(rel);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

pub fn parse_panel_args(args: &[String]) -> Result<OnDemandPanel, String> {
    let mut index = 0;
    while index < args.len() {
        if args[index] == "--panel" {
            let name = args.get(index + 1).map(String::as_str).unwrap_or("");
            return OnDemandPanel::parse(name).ok_or_else(|| format!("unknown panel {name}"));
        }
        index += 1;
    }
    Err("missing --panel".into())
}

pub fn close_active_panel() -> bool {
    let Ok(mut slot) = active_host().lock() else {
        return false;
    };
    let Some(mut child) = slot.take() else {
        return false;
    };
    let _ = child.kill();
    let _ = child.wait();
    true
}

pub fn spawn_panel(panel: OnDemandPanel) -> Result<(), String> {
    let _ = close_active_panel();
    let current = std::env::current_exe().map_err(|err| err.to_string())?;
    let Some(host) = resolve_host(&current) else {
        let fallback = host_path(&current);
        return Err(format!("on-demand host is not built ({})", fallback.display()));
    };
    let child = Command::new(&host)
        .arg("--panel")
        .arg(panel.as_str())
        .spawn()
        .map_err(|err| err.to_string())?;
    if let Ok(mut slot) = active_host().lock() {
        *slot = Some(child);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_path_sits_beside_the_native_window() {
        let host = host_path(Path::new(r"E:\kite\target\kite-gpui.exe"));
        assert!(host.ends_with("kite-ondemand.exe"));
        assert_eq!(OnDemandPanel::parse("browser"), Some(OnDemandPanel::Browser));
        assert!(OnDemandPanel::parse("agent").is_none());
        let panel = parse_panel_args(&["--panel".into(), "account".into()]).unwrap();
        assert_eq!(panel, OnDemandPanel::Account);
    }
}
