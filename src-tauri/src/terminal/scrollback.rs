pub const MAX_SCROLLBACK_BYTES: usize = 256 * 1024;

pub fn terminal_scrollback_dir() -> std::path::PathBuf {
    let base = std::env::var("APPDATA").unwrap_or_else(|_| r"C:\Users\PC\AppData\Roaming".into());
    let folder = if cfg!(debug_assertions) {
        "Kite Code Dev"
    } else {
        "Kite Code"
    };
    let dir = std::path::PathBuf::from(base).join(folder).join("terminals");
    let _ = std::fs::create_dir_all(&dir);
    static PRUNED: std::sync::OnceLock<()> = std::sync::OnceLock::new();
    PRUNED.get_or_init(|| {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            let now = std::time::SystemTime::now();
            for entry in entries.flatten() {
                if let Ok(meta) = entry.metadata() {
                    if let Ok(modified) = meta.modified() {
                        if let Ok(age) = now.duration_since(modified) {
                            if age.as_secs() > 7 * 86400 {
                                let _ = std::fs::remove_file(entry.path());
                            }
                        }
                    }
                }
            }
        }
    });
    dir
}

pub fn scrollback_path_for_session(session_id: &str) -> std::path::PathBuf {
    let safe_id: String = session_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    terminal_scrollback_dir().join(format!("{}.scrollback", safe_id))
}

pub fn read_scrollback_file(session_id: &str) -> Option<Vec<u8>> {
    let path = scrollback_path_for_session(session_id);
    if path.is_file() {
        std::fs::read(&path).ok().filter(|b| !b.is_empty())
    } else {
        None
    }
}

pub fn write_scrollback_file(session_id: &str, bytes: &[u8]) {
    let path = scrollback_path_for_session(session_id);
    let _ = std::fs::write(path, bytes);
}

pub fn delete_scrollback_file(session_id: &str) {
    let path = scrollback_path_for_session(session_id);
    let _ = std::fs::remove_file(path);
}

pub fn snapshot_scrollback_for_attach(
    session_id: &str,
    inst: &crate::terminal::TerminalInstance,
    preserve_unread_buffer: bool,
) -> Option<Vec<u8>> {
    let mut had_pending = false;
    let buf_guard = inst.buffer.lock().ok();
    let sb_guard = inst.scrollback.lock().ok();
    if let Some(mut buf) = buf_guard {
        if !buf.is_empty() {
            had_pending = true;
            if !preserve_unread_buffer {
                buf.clear();
            }
        }
    }
    if let Some(sb) = sb_guard {
        if had_pending && !sb.is_empty() {
            write_scrollback_file(session_id, &sb);
        }
        if sb.is_empty() {
            None
        } else {
            Some(sb.clone())
        }
    } else {
        None
    }
}

pub fn plain_terminal_text(bytes: &[u8]) -> String {
    let mut kept = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == 0x1b {
            i += 1;
            if i >= bytes.len() {
                break;
            }
            match bytes[i] {
                b'[' => {
                    i += 1;
                    while i < bytes.len() {
                        let c = bytes[i];
                        i += 1;
                        if (0x40..=0x7e).contains(&c) {
                            break;
                        }
                    }
                }
                b']' => {
                    i += 1;
                    while i < bytes.len() {
                        if bytes[i] == 0x07 {
                            i += 1;
                            break;
                        }
                        if bytes[i] == 0x1b && i + 1 < bytes.len() && bytes[i + 1] == b'\\' {
                            i += 2;
                            break;
                        }
                        i += 1;
                    }
                }
                _ => i += 1,
            }
            continue;
        }
        if b == b'\r' || b == 0x08 || (b < 0x20 && b != b'\n' && b != b'\t') {
            if b == 0x08 {
                kept.pop();
            }
            i += 1;
            continue;
        }
        kept.push(b);
        i += 1;
    }
    String::from_utf8_lossy(&kept).replace('\u{0}', "")
}

pub fn terminal_recent_text(session_id: &str) -> String {
    if session_id.is_empty() {
        return String::new();
    }
    if crate::terminal::should_proxy_to_core_daemon(session_id) {
        if let Ok(res) = crate::core_daemon::send_core_daemon_rpc(
            "session.recent_text",
            Some(serde_json::json!({ "sessionId": session_id })),
        ) {
            if let Some(text) = res.get("text").and_then(|v| v.as_str()) {
                return text.to_string();
            }
        }
    }
    terminal_recent_text_local(session_id)
}

pub fn terminal_recent_text_local(session_id: &str) -> String {
    if session_id.is_empty() {
        return String::new();
    }
    let inst = {
        let map = crate::terminal::get_terminals().lock().unwrap();
        map.get(session_id).cloned()
    };
    let bytes = if let Some(inst) = inst {
        let screen = inst
            .vt_engine
            .lock()
            .ok()
            .map(|vt| vt.screen_text())
            .unwrap_or_default();
        if !screen.trim().is_empty() {
            return screen.trim_end().to_string();
        }
        // Same lock order as the reader: buffer, then scrollback. The grid lock is already dropped.
        let pending = inst.buffer.lock().ok().map(|buf| buf.clone()).unwrap_or_default();
        let scroll = inst
            .scrollback
            .lock()
            .ok()
            .map(|buf| buf.clone())
            .unwrap_or_default();
        if scroll.is_empty() { pending } else { scroll }
    } else {
        read_scrollback_file(session_id).unwrap_or_default()
    };
    let start = bytes.len().saturating_sub(64 * 1024);
    plain_terminal_text(&bytes[start..])
}

#[cfg(test)]
mod plain_terminal_text_tests {
    use super::plain_terminal_text;

    #[test]
    fn dispatch_read_strips_color_and_keeps_lines() {
        let raw = b"hello \x1b[31mred\x1b[0m\r\nnext";
        assert_eq!(plain_terminal_text(raw), "hello red\nnext");
    }
}
