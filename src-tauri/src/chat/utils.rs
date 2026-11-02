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
    find_in_path(name)
}

pub fn find_in_path(name: &str) -> Option<PathBuf> {
    let path_var = match std::env::var_os("PATH") {
        Some(p) => p,
        None => return None,
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

    let has_ext = name.contains('.');
    for dir in std::env::split_paths(&path_var) {
        let direct = dir.join(name);
        if direct.is_file() {
            return Some(direct);
        }
        if cfg!(windows) && !has_ext {
            // First check .exe for best execution
            let with_exe = dir.join(format!("{name}.exe"));
            if with_exe.is_file() {
                return Some(with_exe);
            }
            for ext in &path_exts {
                let with_ext = dir.join(format!("{}{}", name, ext));
                if with_ext.is_file() {
                    return Some(with_ext);
                }
            }
        }
    }
    None
}

pub fn binary_exists(name: &str) -> bool {
    find_in_path(name).is_some()
}
