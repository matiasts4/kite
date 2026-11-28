use std::io::Write;

fn app_log_folder() -> &'static str {
    if cfg!(debug_assertions) {
        "Kite Code Dev"
    } else {
        "Kite Code"
    }
}

fn log_path() -> std::path::PathBuf {
    crate::chat::utils::user_local_appdata_dir()
        .join(app_log_folder())
        .join("app.log")
}

pub fn crash_log_path() -> std::path::PathBuf {
    crate::chat::utils::user_local_appdata_dir()
        .join(app_log_folder())
        .join("crash.log")
}

fn append_log_line(path: &std::path::Path, msg: &str) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let _ = writeln!(file, "[{}] {}", now, msg);
    }
}

pub fn log_trace(msg: &str) {
    // In release builds, disable trace logging to disk to eliminate UI thread latency and file locks
    if !cfg!(debug_assertions) {
        return;
    }

    append_log_line(&log_path(), msg);
}

/// Persists fatal startup or panic messages in both debug and release builds.
pub fn log_fatal(msg: &str) {
    append_log_line(&crash_log_path(), msg);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn append_log_line_creates_parent_dirs_and_appends_timestamped_lines() {
        let root = std::env::temp_dir().join(format!(
            "kite-logger-test-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        let nested = root.join("nested").join("crash.log");

        append_log_line(&nested, "first fatal entry");
        append_log_line(&nested, "second fatal entry");

        let content = std::fs::read_to_string(&nested).expect("log file should exist");
        let lines: Vec<&str> = content.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].starts_with('[') && lines[0].ends_with("] first fatal entry"));
        assert!(lines[1].starts_with('[') && lines[1].ends_with("] second fatal entry"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn crash_log_path_points_to_crash_log_under_app_folder() {
        let path = crash_log_path();
        assert_eq!(path.file_name().and_then(|s| s.to_str()), Some("crash.log"));
        let expected_folder = if cfg!(debug_assertions) {
            "Kite Code Dev"
        } else {
            "Kite Code"
        };
        assert_eq!(
            path.parent()
                .and_then(|p| p.file_name())
                .and_then(|s| s.to_str()),
            Some(expected_folder)
        );
    }
}
