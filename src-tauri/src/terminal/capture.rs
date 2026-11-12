use crate::terminal::TerminalInstance;
use serde::Serialize;
use std::collections::HashSet;
use std::io::Write;
use std::sync::atomic::Ordering;
use std::sync::Mutex;

pub use super::codec::{now_unix_ms, to_base64};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct TerminalAnsiMarkerCounts {
    #[serde(rename = "dec2026Start")]
    pub dec_2026_start: usize,
    #[serde(rename = "dec2026End")]
    pub dec_2026_end: usize,
    #[serde(rename = "altScreen1049Start")]
    pub alt_screen_1049_start: usize,
    #[serde(rename = "altScreen1049End")]
    pub alt_screen_1049_end: usize,
    #[serde(rename = "carriageReturn")]
    pub carriage_return: usize,
    #[serde(rename = "eraseJ")]
    pub erase_j: usize,
    #[serde(rename = "eraseK")]
    pub erase_k: usize,
    #[serde(rename = "cursorShow")]
    pub cursor_show: usize,
    #[serde(rename = "cursorHide")]
    pub cursor_hide: usize,
    pub osc: usize,
}

pub fn scan_terminal_ansi_markers(
    pending: &mut Vec<u8>,
    bytes: &[u8],
) -> TerminalAnsiMarkerCounts {
    let mut data = std::mem::take(pending);
    data.extend_from_slice(bytes);
    let mut counts = TerminalAnsiMarkerCounts::default();
    let mut index = 0;
    while index < data.len() {
        if data[index] != 0x1b {
            if data[index] == b'\r' {
                counts.carriage_return += 1;
            }
            index += 1;
            continue;
        }
        if index + 1 >= data.len() {
            *pending = data[index..].to_vec();
            break;
        }
        if data[index + 1] == b']' {
            let mut cursor = index + 2;
            let mut terminator_len = None;
            while cursor < data.len() {
                if data[cursor] == 0x07 {
                    terminator_len = Some(1);
                    break;
                }
                if data[cursor] == 0x1b && cursor + 1 < data.len() && data[cursor + 1] == b'\\' {
                    terminator_len = Some(2);
                    break;
                }
                cursor += 1;
            }
            let Some(length) = terminator_len else {
                *pending = data[index..].to_vec();
                break;
            };
            counts.osc += 1;
            index = cursor + length;
            continue;
        }
        if data[index + 1] != b'[' {
            index += 1;
            continue;
        }
        let mut cursor = index + 2;
        while cursor < data.len() && !(0x40..=0x7e).contains(&data[cursor]) {
            cursor += 1;
        }
        if cursor == data.len() {
            *pending = data[index..].to_vec();
            break;
        }
        let sequence = &data[index..=cursor];
        match sequence {
            b"\x1b[?2026h" => counts.dec_2026_start += 1,
            b"\x1b[?2026l" => counts.dec_2026_end += 1,
            b"\x1b[?1049h" => counts.alt_screen_1049_start += 1,
            b"\x1b[?1049l" => counts.alt_screen_1049_end += 1,
            b"\x1b[?25h" | b"\x1b[25h" => counts.cursor_show += 1,
            b"\x1b[?25l" | b"\x1b[25l" => counts.cursor_hide += 1,
            _ => {
                if data[cursor] == b'J' {
                    counts.erase_j += 1;
                } else if data[cursor] == b'K' {
                    counts.erase_k += 1;
                }
            }
        }
        index = cursor + 1;
    }
    counts
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn count_terminal_ansi_markers(bytes: &[u8]) -> TerminalAnsiMarkerCounts {
    let mut pending = Vec::new();
    scan_terminal_ansi_markers(&mut pending, bytes)
}

pub fn terminal_capture_safe_filename(session_id: &str) -> String {
    let safe_id: String = session_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '_'
            }
        })
        .collect();
    let safe_id = if safe_id.is_empty() { "session" } else { &safe_id };
    format!("{safe_id}.jsonl")
}

pub fn terminal_capture_dir() -> Option<std::path::PathBuf> {
    let value = std::env::var_os("KITE_TERMINAL_CAPTURE_DIR")?;
    if value.is_empty() {
        return None;
    }
    Some(std::path::PathBuf::from(value))
}

pub fn append_terminal_capture_record(session_id: &str, record: serde_json::Value) {
    let Some(directory) = terminal_capture_dir() else {
        return;
    };
    static CAPTURE_LOCK: std::sync::OnceLock<Mutex<()>> = std::sync::OnceLock::new();
    let lock = CAPTURE_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if std::fs::create_dir_all(&directory).is_err() {
        return;
    }
    let path = directory.join(terminal_capture_safe_filename(session_id));
    static INITIALIZED_FILES: std::sync::OnceLock<Mutex<HashSet<std::path::PathBuf>>> =
        std::sync::OnceLock::new();
    let initialized = INITIALIZED_FILES.get_or_init(|| Mutex::new(HashSet::new()));
    let mut initialized_guard = initialized
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if !initialized_guard.contains(&path) {
        let Ok(_) = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&path)
        else {
            return;
        };
        initialized_guard.insert(path.clone());
    }
    drop(initialized_guard);
    let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) else {
        return;
    };
    let Ok(mut line) = serde_json::to_vec(&record) else {
        return;
    };
    line.push(b'\n');
    let _ = file.write_all(&line);
}

pub fn capture_terminal_lifecycle(
    session_id: &str,
    attached_to_existing: bool,
    requested_engine: Option<&str>,
    restore_kind: &str,
    scrollback_bytes: Option<usize>,
) {
    let Some(_) = terminal_capture_dir() else {
        return;
    };
    let (effective_engine, provider_session_id, workspace_id, pane_id, columns, rows) = {
        let map = crate::terminal::get_terminals().lock().ok();
        let Some(map) = map else { return };
        let Some(instance) = map.get(session_id) else { return };
        (
            instance.engine.clone(),
            instance.provider_session_id.lock().ok().and_then(|id| id.clone()),
            instance.workspace_id.lock().ok().and_then(|id| id.clone()),
            instance.pane_id.lock().ok().and_then(|id| id.clone()),
            instance.cols.load(Ordering::Relaxed),
            instance.rows.load(Ordering::Relaxed),
        )
    };
    append_terminal_capture_record(
        session_id,
        serde_json::json!({
            "kind": "lifecycle",
            "sessionId": session_id,
            "attachedToExisting": attached_to_existing,
            "requestedEngine": requested_engine,
            "effectiveEngine": effective_engine,
            "providerSessionId": provider_session_id,
            "workspaceId": workspace_id,
            "paneId": pane_id,
            "columns": columns,
            "rows": rows,
            "restoreKind": restore_kind,
            "scrollbackBytes": scrollback_bytes,
            "resume": restore_kind == "restoredFromDisk",
            "capturedAtUnixMs": now_unix_ms(),
        }),
    );
}

pub fn capture_terminal_output(
    session_id: &str,
    instance: &TerminalInstance,
    bytes: &[u8],
    captured_at_unix_ms: i64,
) -> u64 {
    if bytes.is_empty() {
        return instance.sequence.fetch_add(1, Ordering::SeqCst);
    }
    if terminal_capture_dir().is_none() {
        return instance.sequence.fetch_add(1, Ordering::SeqCst);
    }
    let sequence = instance.sequence.fetch_add(1, Ordering::SeqCst);
    let provider_session_id = instance
        .provider_session_id
        .lock()
        .ok()
        .and_then(|id| id.clone());
    let workspace_id = instance.workspace_id.lock().ok().and_then(|id| id.clone());
    let pane_id = instance.pane_id.lock().ok().and_then(|id| id.clone());
    let ansi_markers = instance
        .ansi_scan_tail
        .lock()
        .map(|mut pending| scan_terminal_ansi_markers(&mut pending, bytes))
        .unwrap_or_default();
    append_terminal_capture_record(
        session_id,
        serde_json::json!({
            "kind": "output",
            "sessionId": session_id,
            "engine": instance.engine.clone(),
            "providerSessionId": provider_session_id,
            "workspaceId": workspace_id,
            "paneId": pane_id,
            "columns": instance.cols.load(Ordering::Relaxed),
            "rows": instance.rows.load(Ordering::Relaxed),
            "capturedAtUnixMs": captured_at_unix_ms,
            "sequence": sequence,
            "byteOffset": instance
                .output_byte_offset
                .fetch_add(bytes.len() as u64, Ordering::SeqCst),
            "byteLength": bytes.len(),
            "rawBytesBase64": to_base64(bytes),
            "ansiMarkers": ansi_markers,
        }),
    );
    sequence
}
