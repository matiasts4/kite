use std::io::Write;

fn log_path() -> std::path::PathBuf {
    let base = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| r"C:\Users\PC\AppData\Local".into());
    let folder = if cfg!(debug_assertions) {
        "Kite Code Dev"
    } else {
        "Kite Code"
    };
    let path = std::path::PathBuf::from(base).join(folder).join("app.log");
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    path
}

pub fn log_trace(msg: &str) {
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
