use uuid::Uuid;

pub fn quote_path(path: &str) -> Option<String> {
    let trimmed = path.trim();
    if trimmed.is_empty() || trimmed.chars().any(|ch| ch.is_control()) {
        return None;
    }
    Some(format!("'{}' ", trimmed.replace('\'', "''")))
}

pub use super::codec::decode_base64;

pub fn stage_clipboard_file(
    _owner: Option<&serde_json::Value>,
    session_id: &str,
    format: &str,
    bytes_b64: &str,
) -> Option<String> {
    let ext = match format {
        "png" | "gif" | "webp" | "bmp" => format,
        "jpeg" => "jpg",
        _ => return None,
    };
    let bytes = decode_base64(bytes_b64)?;
    if bytes.is_empty() || bytes.len() > 12_000_000 {
        return None;
    }
    let dir = std::env::temp_dir().join("kite-clipboard");
    std::fs::create_dir_all(&dir).ok()?;
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
    let name = format!(
        "{}-{}.{}",
        if safe_id.is_empty() {
            "image"
        } else {
            &safe_id
        },
        &Uuid::new_v4().to_string()[..8],
        ext
    );
    let path = dir.join(name);
    std::fs::write(&path, bytes).ok()?;
    Some(path.to_string_lossy().into_owned())
}

pub fn insert_terminal_drop_paths(request: Option<serde_json::Value>) -> serde_json::Value {
    if let Some(req) = crate::terminal::option_body(&request) {
        let session_id = req
            .get("sessionId")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let mut text = String::new();
        if let Some(paths) = req.get("paths").and_then(|value| value.as_array()) {
            for path in paths.iter().take(20) {
                let Some(path) = path.as_str() else { continue };
                if let Some(quoted) = quote_path(path) {
                    text.push_str(&quoted);
                }
            }
        }
        let _ = crate::terminal::write_session(session_id, &text);
    }
    serde_json::Value::Null
}

pub fn insert_terminal_files_entry(request: Option<serde_json::Value>) -> serde_json::Value {
    if let Some(req) = crate::terminal::option_body(&request) {
        let session_id = req
            .get("sessionId")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let workspace_id = req
            .get("workspaceId")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let resource_id = req
            .get("resourceId")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let entry_id = req
            .get("entryId")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        if let Some(path) = crate::files::files_entry_path(workspace_id, resource_id, entry_id) {
            if let Some(quoted) = quote_path(&path.to_string_lossy()) {
                let _ = crate::terminal::write_session(session_id, &quoted);
            }
        }
    }
    serde_json::Value::Null
}

pub fn stage_terminal_clipboard_image(request: Option<serde_json::Value>) -> serde_json::Value {
    if let Some(req) = crate::terminal::option_body(&request) {
        let session_id = req
            .get("sessionId")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let format = req
            .get("format")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let bytes = req
            .get("bytesBase64")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        if let Some(path) = stage_clipboard_file(req.get("owner"), session_id, format, bytes) {
            if let Some(quoted) = quote_path(&path) {
                let _ = crate::terminal::write_session(session_id, &quoted);
            }
        }
    }
    serde_json::Value::Null
}
