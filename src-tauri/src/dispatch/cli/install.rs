use crate::dispatch::address::is_caller_endpoint;
use crate::dispatch::policy::{ChildrenMode, RunInput, SendInput, Service, WaitInput};
use crate::dispatch::port::Port;
use crate::dispatch::presence::PresenceState;
use crate::dispatch::types::{exit_code, Caller, DispatchError, Family, Receipt, ReceiptStatus};
use super::*;

pub fn check_token(expected: &str, presented: &str) -> bool {
    !expected.is_empty() && expected == presented
}

pub fn offline_receipt(id: &str, op: &str) -> Receipt {
    Receipt::new(
        id,
        op,
        ReceiptStatus::Failed,
        "",
        false,
        None,
        Some(DispatchError::RuntimeOffline.code().into()),
    )
}

pub fn bad_token_receipt(id: &str, op: &str) -> Receipt {
    Receipt::new(
        id,
        op,
        ReceiptStatus::Rejected,
        "",
        false,
        None,
        Some("bad_token".into()),
    )
}

pub(super) fn inherited_parent(explicit: Option<&String>, from: &str) -> Option<String> {
    if let Some(parent) = explicit.filter(|value| !value.is_empty()) {
        return Some(parent.clone());
    }
    if is_caller_endpoint(from) {
        Some(from.to_string())
    } else {
        None
    }
}

pub(super) fn is_test_binary_path(exe: &std::path::Path) -> bool {
    let in_deps = exe
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("deps"));
    let test_stem = exe
        .file_stem()
        .and_then(|s| s.to_str())
        .is_some_and(|stem| {
            stem.starts_with("kite_code-")
                || (stem.starts_with("kite-") && stem != "kite-code")
        });
    in_deps || test_stem
}

pub(super) fn running_under_test() -> bool {
    if cfg!(test) {
        return true;
    }
    std::env::current_exe()
        .map(|exe| is_test_binary_path(&exe))
        .unwrap_or(false)
}

fn shim_matches_metadata(src: &std::fs::Metadata, dest: &std::fs::Metadata) -> bool {
    if src.len() != dest.len() {
        return false;
    }
    match (src.modified(), dest.modified()) {
        (Ok(s_mod), Ok(d_mod)) => s_mod <= d_mod,
        _ => false,
    }
}

pub(crate) fn write_shim_to_dir(dir: &std::path::Path, current_exe: &std::path::Path) {
    let _ = std::fs::create_dir_all(dir);
    let console_name = if cfg!(windows) { "kite.exe" } else { "kite" };
    let sibling_console = current_exe.parent().map(|parent| parent.join(console_name));
    let target_exe = if let Some(src) = sibling_console.filter(|path| path.is_file()) {
        let dest = dir.join(console_name);
        if dest != src {
            let needs_copy = match (std::fs::metadata(&src), std::fs::metadata(&dest)) {
                (Ok(s), Ok(d)) => !shim_matches_metadata(&s, &d),
                (Ok(_), Err(_)) => true,
                _ => false,
            };
            if needs_copy {
                let tmp = dir.join(format!("{console_name}.tmp"));
                if std::fs::copy(&src, &tmp).is_ok() && std::fs::rename(&tmp, &dest).is_err() {
                    let _ = std::fs::remove_file(&tmp);
                    let _ = std::fs::copy(&src, &dest);
                }
            }
        }
        if dest.is_file() {
            dest
        } else {
            src
        }
    } else {
        current_exe.to_path_buf()
    };

    #[cfg(windows)]
    {
        let script = format!("@echo off\r\n\"{}\" %*\r\n", target_exe.display());
        let _ = std::fs::write(dir.join("kite.cmd"), script);
    }
    #[cfg(not(windows))]
    {
        let path = dir.join("kite");
        if path != target_exe {
            let script = format!("#!/usr/bin/env sh\nexec \"{}\" \"$@\"\n", target_exe.display());
            let _ = std::fs::write(&path, script);
        }
    }
}

/// Writes `kite.cmd` (and copies companion console `kite.exe`) next to app data so a terminal can call `kite` with synchronous stdio.
pub fn install_kite_shim() -> std::path::PathBuf {
    let dir = crate::persist::roaming_app_dir().join("bin");
    if running_under_test() {
        return dir;
    }
    if let Ok(exe) = std::env::current_exe() {
        write_shim_to_dir(&dir, &exe);
    }
    dir
}

pub(super) fn user_home_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(std::path::PathBuf::from)
}

pub(super) fn existing_skill_roots(home: &std::path::Path) -> Vec<std::path::PathBuf> {
    [
        home.join(".claude").join("skills"),
        home.join(".grok").join("skills"),
        home.join(".codex").join("skills"),
        home.join(".cursor").join("skills"),
        home.join(".gemini").join("antigravity-cli").join("skills"),
        home.join(".gemini").join("antigravity").join("skills"),
        home.join(".gemini").join("skills"),
        home.join(".agents").join("skills"),
        home.join(".config").join("agents").join("skills"),
        home.join(".config").join("opencode").join("skills"),
        home.join(".copilot").join("skills"),
        home.join(".kimi").join("skills"),
        home.join(".amp").join("skills"),
        home.join(".config").join("amp").join("skills"),
        home.join(".factory").join("skills"),
        home.join(".droid").join("skills"),
    ]
    .into_iter()
    .filter(|root| root.is_dir())
    .collect()
}

/// Copies the manual into each existing user skill root as `kite-dispatch/SKILL.md`.
/// A missing root is left untouched.
pub(crate) fn copy_skill_into_existing_roots(home: &std::path::Path, text: &str) {
    for root in existing_skill_roots(home) {
        let dest = root.join("kite-dispatch");
        if std::fs::create_dir_all(&dest).is_ok() {
            let _ = std::fs::write(dest.join("SKILL.md"), text);
        }
    }
}

/// Writes the same manual `kite dispatch skill` prints, copies it into existing
/// agent skill directories, and returns the app-data path.
pub fn install_dispatch_skill() -> std::path::PathBuf {
    let dir = crate::persist::roaming_app_dir().join("dispatch");
    let path = dir.join("SKILL.md");
    if running_under_test() {
        return path;
    }
    let _ = std::fs::create_dir_all(&dir);
    let text = skill_text();
    let _ = std::fs::write(&path, &text);
    if let Some(home) = user_home_dir() {
        copy_skill_into_existing_roots(&home, &text);
    }
    path
}

/// Installs non-destructive `kite ctx` hooks and `kite-ctx/SKILL.md` across all
/// detected agent directories on the host.
pub fn install_ctx_integrations() -> Vec<kite_ctx::HookInstallAction> {
    if running_under_test() {
        return Vec::new();
    }
    let Some(home) = user_home_dir() else {
        return Vec::new();
    };
    let workspace = std::env::current_dir().unwrap_or_else(|_| home.clone());
    kite_ctx::apply_agent_setup(kite_ctx::AgentTarget::All, &home, &workspace, false)
        .unwrap_or_default()
}

/// Runs `install_ctx_integrations` at most once per desktop app process.
pub fn ensure_ctx_integrations_once() {
    if running_under_test() {
        return;
    }
    static ONCE: std::sync::OnceLock<()> = std::sync::OnceLock::new();
    ONCE.get_or_init(|| {
        let _ = install_ctx_integrations();
    });
}

/// `--hidden` wins. Otherwise `--pane` or a human caller asks for a pane.
pub(super) fn show_pane(hidden: bool, pane: bool, caller: Caller) -> bool {
    if hidden {
        return false;
    }
    if pane {
        return true;
    }
    caller == Caller::Human
}

pub(super) fn combine_task(file_text: Option<String>, words: Option<String>) -> Option<String> {
    match (file_text, words.filter(|value| !value.is_empty())) {
        (Some(mut file), Some(words)) => {
            file.push_str("\n\n");
            file.push_str(&words);
            Some(file)
        }
        (Some(file), None) => Some(file),
        (None, Some(words)) => Some(words),
        (None, None) => None,
    }
}

