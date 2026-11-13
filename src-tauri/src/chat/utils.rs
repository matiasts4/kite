use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn user_home_dir() -> PathBuf {
    if let Some(profile) = std::env::var("USERPROFILE").ok().filter(|v| !v.trim().is_empty()) {
        PathBuf::from(profile)
    } else if let Some(home) = std::env::var("HOME").ok().filter(|v| !v.trim().is_empty()) {
        PathBuf::from(home)
    } else {
        std::env::temp_dir().join("kite-home")
    }
}

pub fn user_local_appdata_dir() -> PathBuf {
    if let Some(local) = std::env::var("LOCALAPPDATA").ok().filter(|v| !v.trim().is_empty()) {
        PathBuf::from(local)
    } else {
        user_home_dir().join("AppData").join("Local")
    }
}

pub fn user_roaming_appdata_dir() -> PathBuf {
    if let Some(roaming) = std::env::var("APPDATA").ok().filter(|v| !v.trim().is_empty()) {
        PathBuf::from(roaming)
    } else {
        user_home_dir().join("AppData").join("Roaming")
    }
}

pub fn resolve_agy_bin() -> Option<PathBuf> {
    let agy_local = user_local_appdata_dir().join("agy").join("bin").join("agy.exe");
    let local_str = agy_local.to_string_lossy().to_string();
    resolve_bin("agy", &[&local_str])
}

pub fn resolve_codex_bin() -> Option<PathBuf> {
    let local = user_local_appdata_dir();
    let p1 = local.join("Programs").join("OpenAI").join("Codex").join("bin").join("codex.exe");
    let p2 = local.join("Programs").join("OpenAI").join("codex.exe");
    let s1 = p1.to_string_lossy().to_string();
    let s2 = p2.to_string_lossy().to_string();
    resolve_bin("codex", &[&s1, &s2])
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
