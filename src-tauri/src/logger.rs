use std::io::Write;

fn log_path() -> std::path::PathBuf {
    let folder = if cfg!(debug_assertions) {
        "Kite Code Dev"
    } else {
        "Kite Code"
    };
    let path = crate::chat::utils::user_local_appdata_dir().join(folder).join("app.log");
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    path
}

pub fn log_trace(msg: &str) {
    // In release builds, disable trace logging to disk to eliminate UI thread latency and file locks
    if !cfg!(debug_assertions) {
        return;
    }

    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path())
    {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let _ = writeln!(file, "[{}] {}", now, msg);
    }
}
