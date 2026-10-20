use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn user_home_dir() -> PathBuf {
    if let Ok(profile) = std::env::var("USERPROFILE") {
        PathBuf::from(profile)
    } else if let Ok(home) = std::env::var("HOME") {
        PathBuf::from(home)
    } else {
        PathBuf::from(".")
    }
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub(crate) fn chat_log(msg: &str) {
    eprintln!("[Kite:Chat] {}", msg);
}

pub fn clip_argv(prompt: &str) -> String {
    prompt.chars().take(12_000).collect()
}

pub fn clip_title(title: &str) -> String {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        "Chat".to_string()
    } else {
        trimmed.to_string()
    }
}

pub fn resolve_bin(name: &str, fallbacks: &[&str]) -> Option<PathBuf> {
    for fallback in fallbacks {
        let path = PathBuf::from(fallback);
        if path.is_file() {
            return Some(path);
        }
    }
    let has_ext = name.contains('.');
    if binary_exists(name) {
        return Some(PathBuf::from(name));
    }
    if !has_ext && cfg!(windows) {
        let with_exe = format!("{name}.exe");
        if binary_exists(&with_exe) {
            return Some(PathBuf::from(with_exe));
        }
        let with_cmd = format!("{name}.cmd");
        if binary_exists(&with_cmd) {
            return Some(PathBuf::from(with_cmd));
        }
    }
    None
}

pub fn binary_exists(name: &str) -> bool {
    let path_var = match std::env::var_os("PATH") {
        Some(p) => p,
        None => return false,
    };
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
            return true;
        }
        if cfg!(windows) {
            for ext in &path_exts {
                let with_ext = dir.join(format!("{}{}", name, ext));
                if with_ext.is_file() {
                    return true;
                }
            }
        }
    }
    false
}
