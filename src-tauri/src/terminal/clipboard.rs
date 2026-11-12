use uuid::Uuid;

pub fn quote_path(path: &str) -> Option<String> {
    let trimmed = path.trim();
    if trimmed.is_empty() || trimmed.chars().any(|ch| ch.is_control()) {
        return None;
    }
    Some(format!("'{}' ", trimmed.replace('\'', "''")))
}

pub fn decode_base64(input: &str) -> Option<Vec<u8>> {
    fn value(byte: u8) -> Option<u8> {
        match byte {
            b'A'..=b'Z' => Some(byte - b'A'),
            b'a'..=b'z' => Some(byte - b'a' + 26),
            b'0'..=b'9' => Some(byte - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let bytes = input.as_bytes();
    if bytes.is_empty() || bytes.len() % 4 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for chunk in bytes.chunks(4) {
        let pad = chunk.iter().filter(|byte| **byte == b'=').count();
        if pad > 2 {
            return None;
        }
        let a = value(chunk[0])?;
        let b = value(chunk[1])?;
        let c = if chunk[2] == b'=' { 0 } else { value(chunk[2])? };
        let d = if chunk[3] == b'=' { 0 } else { value(chunk[3])? };
        out.push((a << 2) | (b >> 4));
        if pad < 2 {
            out.push((b << 4) | (c >> 2));
        }
        if pad < 1 {
            out.push((c << 6) | d);
        }
    }
    Some(out)
}

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
