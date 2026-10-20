use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use uuid::Uuid;

const ATTACHMENT_BYTE_LIMIT: usize = 10 * 1024 * 1024;

pub struct StagedAttachment {
    pub thread_id: String,
    pub directory: PathBuf,
    pub payload: Value,
}

fn staged_attachments() -> &'static Mutex<HashMap<String, StagedAttachment>> {
    static CELL: std::sync::OnceLock<Mutex<HashMap<String, StagedAttachment>>> = std::sync::OnceLock::new();
    CELL.get_or_init(|| Mutex::new(HashMap::new()))
}

fn attachment_segment(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
}

fn attachment_root() -> PathBuf {
    let base = std::env::var("APPDATA").unwrap_or_else(|_| r"C:\Users\PC\AppData\Roaming".into());
    PathBuf::from(base)
        .join(crate::persist::app_data_folder())
        .join("chat-attachments")
}

fn clip_attachment_name(name: &str) -> String {
    let trimmed = name.trim();
    let base = Path::new(trimmed)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(trimmed);
    let cleaned: String = base
        .chars()
        .filter(|ch| *ch != '/' && *ch != '\\' && *ch != '\0')
        .take(255)
        .collect();
    let cleaned = cleaned.trim();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        "attachment".to_string()
    } else {
        cleaned.to_string()
    }
}

fn attachment_payload(resource_id: &str, display_name: &str, is_directory: bool, byte_size: Option<u64>) -> Value {
    json!({
        "resourceId": resource_id,
        "displayName": display_name,
        "isDirectory": is_directory,
        "byteSize": byte_size
    })
}

fn remember_attachment(thread_id: &str, resource_id: String, directory: PathBuf, payload: Value) -> Value {
    let stored = payload.clone();
    staged_attachments().lock().unwrap().insert(
        resource_id,
        StagedAttachment {
            thread_id: thread_id.to_string(),
            directory,
            payload,
        },
    );
    stored
}

pub fn stage_blob_attachment(thread_id: &str, display_name: &str, data_base64: &str) -> Option<Value> {
    if !attachment_segment(thread_id) || data_base64.len() > (ATTACHMENT_BYTE_LIMIT / 3) * 4 + 4 {
        return None;
    }
    let bytes = decode_base64(data_base64.trim())?;
    if bytes.len() > ATTACHMENT_BYTE_LIMIT {
        return None;
    }
    let resource_id = Uuid::new_v4().to_string();
    let directory = attachment_root().join(thread_id).join(&resource_id);
    fs::create_dir_all(&directory).ok()?;
    let name = clip_attachment_name(display_name);
    if fs::write(directory.join(&name), &bytes).is_err() {
        let _ = fs::remove_dir_all(&directory);
        return None;
    }
    Some(remember_attachment(
        thread_id,
        resource_id.clone(),
        directory,
        attachment_payload(&resource_id, &name, false, Some(bytes.len() as u64)),
    ))
}

pub fn stage_dropped_paths(thread_id: &str, paths: &[PathBuf]) -> Vec<Value> {
    paths
        .iter()
        .take(16)
        .filter_map(|path| stage_dropped_path(thread_id, path))
        .collect()
}

pub fn stage_dropped_path(thread_id: &str, path: &Path) -> Option<Value> {
    if !attachment_segment(thread_id) {
        return None;
    }
    let path_text = path.to_string_lossy();
    if path_text.is_empty() || path_text.len() > 4096 || !path.exists() {
        return None;
    }
    let resource_id = Uuid::new_v4().to_string();
    let directory = attachment_root().join(thread_id).join(&resource_id);
    fs::create_dir_all(&directory).ok()?;
    let is_directory = path.is_dir();
    let display_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .map(clip_attachment_name)
        .unwrap_or_else(|| "attachment".to_string());
    let byte_size = if is_directory {
        if fs::write(directory.join("directory.txt"), path_text.as_bytes()).is_err() {
            let _ = fs::remove_dir_all(&directory);
            return None;
        }
        None
    } else {
        let dest = directory.join(&display_name);
        if fs::copy(path, &dest).is_err() {
            let _ = fs::remove_dir_all(&directory);
            return None;
        }
        fs::metadata(&dest).ok().map(|meta| meta.len())
    };
    Some(remember_attachment(
        thread_id,
        resource_id.clone(),
        directory,
        attachment_payload(&resource_id, &display_name, is_directory, byte_size),
    ))
}

pub fn release_staged_attachment(thread_id: &str, resource_id: &str) {
    let removed = {
        let mut staged = staged_attachments().lock().unwrap();
        match staged.get(resource_id) {
            Some(item) if item.thread_id == thread_id => staged.remove(resource_id),
            _ => None,
        }
    };
    if let Some(item) = removed {
        let _ = fs::remove_dir_all(item.directory);
    }
}

pub fn lookup_staged_attachment(resource_id: &str) -> Option<Value> {
    staged_attachments()
        .lock()
        .unwrap()
        .get(resource_id)
        .map(|item| item.payload.clone())
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
    let clean: Vec<u8> = input.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    if clean.is_empty() || clean.len() % 4 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(clean.len() / 4 * 3);
    let mut index = 0;
    while index < clean.len() {
        let (b0, b1, b2, b3) = (clean[index], clean[index + 1], clean[index + 2], clean[index + 3]);
        if b0 == b'=' || b1 == b'=' || (b2 == b'=' && b3 != b'=') {
            return None;
        }
        let n0 = value(b0)?;
        let n1 = value(b1)?;
        let n2 = if b2 == b'=' { 0 } else { value(b2)? };
        let n3 = if b3 == b'=' { 0 } else { value(b3)? };
        let triple = ((n0 as u32) << 18) | ((n1 as u32) << 12) | ((n2 as u32) << 6) | (n3 as u32);
        out.push((triple >> 16) as u8);
        if b2 != b'=' {
            out.push((triple >> 8) as u8);
        }
        if b3 != b'=' {
            out.push(triple as u8);
        }
        index += 4;
    }
    Some(out)
}

pub fn parse_attachments(req: Option<&Value>) -> Vec<Value> {
    let Some(req) = req else { return Vec::new(); };
    let mut res = Vec::new();
    if let Some(arr) = req.get("attachments").and_then(|v| v.as_array()) {
        for item in arr.iter().take(64) {
            if let Some(resource_id) = item.get("resourceId").and_then(|v| v.as_str()) {
                if let Some(staged) = lookup_staged_attachment(resource_id) {
                    res.push(staged);
                    continue;
                }
                let display_name = item.get("displayName").and_then(|v| v.as_str()).unwrap_or("attachment");
                let is_dir = item.get("isDirectory").and_then(|v| v.as_bool()).unwrap_or(false);
                let byte_size = item.get("byteSize").and_then(|v| v.as_u64());
                res.push(json!({
                    "resourceId": resource_id,
                    "displayName": display_name,
                    "isDirectory": is_dir,
                    "byteSize": byte_size
                }));
            }
        }
    } else if let Some(ids) = req.get("attachmentIds").and_then(|v| v.as_array()) {
        for id in ids.iter().take(16) {
            if let Some(uuid_str) = id.as_str() {
                if let Some(staged) = lookup_staged_attachment(uuid_str) {
                    res.push(staged);
                } else {
                    res.push(json!({
                        "resourceId": uuid_str,
                        "displayName": "attachment",
                        "isDirectory": false,
                        "byteSize": Value::Null
                    }));
                }
            }
        }
    }
    res
}
