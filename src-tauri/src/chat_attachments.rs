use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use uuid::Uuid;

const ATTACHMENT_BYTE_LIMIT: usize = 10 * 1024 * 1024;
const PREVIEW_IMAGE_BYTE_LIMIT: usize = 2 * 1024 * 1024;
const STAGED_ATTACHMENT_TTL: Duration = Duration::from_secs(30 * 60);
const ATTACHED_FILES_HEADER: &str = "[Attached files]";

pub struct StagedAttachment {
    pub thread_id: String,
    pub directory: PathBuf,
    pub payload: Value,
    pub staged_at: Instant,
}

fn staged_attachments() -> &'static Mutex<HashMap<String, StagedAttachment>> {
    static CELL: std::sync::OnceLock<Mutex<HashMap<String, StagedAttachment>>> = std::sync::OnceLock::new();
    CELL.get_or_init(|| Mutex::new(HashMap::new()))
}

fn attachment_segment(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
}

fn attachment_root() -> PathBuf {
    crate::chat::utils::user_roaming_appdata_dir()
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

pub fn infer_mime_type(display_name: &str, explicit_mime: Option<&str>) -> String {
    if let Some(raw) = explicit_mime.map(str::trim).filter(|s| {
        !s.is_empty() && !s.eq_ignore_ascii_case("application/octet-stream")
    }) {
        return raw.chars().take(127).collect();
    }
    let ext = Path::new(display_name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png".to_string(),
        "jpg" | "jpeg" => "image/jpeg".to_string(),
        "gif" => "image/gif".to_string(),
        "webp" => "image/webp".to_string(),
        "bmp" => "image/bmp".to_string(),
        "svg" => "image/svg+xml".to_string(),
        "pdf" => "application/pdf".to_string(),
        "txt" | "md" | "log" | "csv" => "text/plain".to_string(),
        "json" => "application/json".to_string(),
        _ => "application/octet-stream".to_string(),
    }
}

fn ensure_filename_extension(name: &str, mime_type: &str) -> String {
    if Path::new(name).extension().is_some() {
        return name.to_string();
    }
    let ext = match mime_type.trim().to_ascii_lowercase().as_str() {
        "image/png" => Some("png"),
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        "image/bmp" => Some("bmp"),
        "image/svg+xml" => Some("svg"),
        "text/plain" => Some("txt"),
        "application/pdf" => Some("pdf"),
        _ => None,
    };
    match ext {
        Some(ext) => format!("{name}.{ext}"),
        None => name.to_string(),
    }
}

pub fn encode_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    let mut i = 0;
    while i + 3 <= bytes.len() {
        let n = ((bytes[i] as u32) << 16) | ((bytes[i + 1] as u32) << 8) | (bytes[i + 2] as u32);
        out.push(TABLE[((n >> 18) & 0x3f) as usize] as char);
        out.push(TABLE[((n >> 12) & 0x3f) as usize] as char);
        out.push(TABLE[((n >> 6) & 0x3f) as usize] as char);
        out.push(TABLE[(n & 0x3f) as usize] as char);
        i += 3;
    }
    let rem = bytes.len() - i;
    if rem == 1 {
        let n = (bytes[i] as u32) << 16;
        out.push(TABLE[((n >> 18) & 0x3f) as usize] as char);
        out.push(TABLE[((n >> 12) & 0x3f) as usize] as char);
        out.push('=');
        out.push('=');
    } else if rem == 2 {
        let n = ((bytes[i] as u32) << 16) | ((bytes[i + 1] as u32) << 8);
        out.push(TABLE[((n >> 18) & 0x3f) as usize] as char);
        out.push(TABLE[((n >> 12) & 0x3f) as usize] as char);
        out.push(TABLE[((n >> 6) & 0x3f) as usize] as char);
        out.push('=');
    }
    out
}

fn attachment_payload(
    resource_id: &str,
    display_name: &str,
    is_directory: bool,
    byte_size: Option<u64>,
    mime_type: Option<&str>,
    path: Option<&str>,
    preview_data_url: Option<&str>,
) -> Value {
    let mut payload = json!({
        "resourceId": resource_id,
        "displayName": display_name,
        "isDirectory": is_directory,
        "byteSize": byte_size
    });
    if let Some(mime) = mime_type.map(str::trim).filter(|s| !s.is_empty()) {
        payload["mimeType"] = json!(mime);
    }
    if let Some(p) = path.map(str::trim).filter(|s| !s.is_empty()) {
        payload["path"] = json!(p);
    }
    if let Some(preview) = preview_data_url.map(str::trim).filter(|s| !s.is_empty()) {
        payload["previewDataUrl"] = json!(preview);
    }
    payload
}

fn sweep_stale_staged_locked(map: &mut HashMap<String, StagedAttachment>, now: Instant) {
    map.retain(|_, item| now.saturating_duration_since(item.staged_at) < STAGED_ATTACHMENT_TTL);
}

fn remember_attachment(thread_id: &str, resource_id: String, directory: PathBuf, payload: Value) -> Value {
    let stored = payload.clone();
    let now = Instant::now();
    let mut map = staged_attachments().lock().unwrap();
    sweep_stale_staged_locked(&mut map, now);
    map.insert(
        resource_id,
        StagedAttachment {
            thread_id: thread_id.to_string(),
            directory,
            payload,
            staged_at: now,
        },
    );
    stored
}

/// Evicts consumed entries from the in-memory `staged_attachments()` map once a
/// turn is submitted, keeping the underlying files on disk for agent reads and
/// on-demand thumbnail previews.
pub fn consume_staged_attachments(attachments: &[Value]) {
    if attachments.is_empty() {
        return;
    }
    let now = Instant::now();
    let mut map = staged_attachments().lock().unwrap();
    for item in attachments {
        if let Some(resource_id) = item.get("resourceId").and_then(|v| v.as_str()) {
            map.remove(resource_id);
        }
    }
    sweep_stale_staged_locked(&mut map, now);
}

pub fn staged_attachment_count() -> usize {
    staged_attachments().lock().unwrap().len()
}

pub fn stage_blob_attachment(thread_id: &str, display_name: &str, data_base64: &str) -> Option<Value> {
    stage_blob_attachment_with_mime(thread_id, display_name, None, data_base64)
}

pub fn stage_blob_attachment_with_mime(
    thread_id: &str,
    display_name: &str,
    mime_type: Option<&str>,
    data_base64: &str,
) -> Option<Value> {
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
    let mime = infer_mime_type(display_name, mime_type);
    let name = ensure_filename_extension(&clip_attachment_name(display_name), &mime);
    let dest = directory.join(&name);
    if fs::write(&dest, &bytes).is_err() {
        let _ = fs::remove_dir_all(&directory);
        return None;
    }
    let dest_str = dest.to_string_lossy().to_string();
    Some(remember_attachment(
        thread_id,
        resource_id.clone(),
        directory,
        attachment_payload(
            &resource_id,
            &name,
            false,
            Some(bytes.len() as u64),
            Some(&mime),
            Some(&dest_str),
            None,
        ),
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
    let (byte_size, mime_opt, resolved_path, preview_data_url) = if is_directory {
        if fs::write(directory.join("directory.txt"), path_text.as_bytes()).is_err() {
            let _ = fs::remove_dir_all(&directory);
            return None;
        }
        (None, None, path_text.to_string(), None)
    } else {
        let dest = directory.join(&display_name);
        if fs::copy(path, &dest).is_err() {
            let _ = fs::remove_dir_all(&directory);
            return None;
        }
        let size = fs::metadata(&dest).ok().map(|meta| meta.len());
        let mime = infer_mime_type(&display_name, None);
        (
            size,
            Some(mime),
            dest.to_string_lossy().to_string(),
            None::<String>,
        )
    };
    Some(remember_attachment(
        thread_id,
        resource_id.clone(),
        directory,
        attachment_payload(
            &resource_id,
            &display_name,
            is_directory,
            byte_size,
            mime_opt.as_deref(),
            Some(&resolved_path),
            preview_data_url.as_deref(),
        ),
    ))
}

pub fn release_staged_attachment(thread_id: &str, resource_id: &str) {
    let removed = {
        let mut staged = staged_attachments().lock().unwrap();
        match staged.get(resource_id) {
            Some(item) if item.thread_id == thread_id || thread_id.is_empty() => staged.remove(resource_id),
            _ => None,
        }
    };
    if let Some(item) = removed {
        let _ = fs::remove_dir_all(item.directory);
    } else if attachment_segment(thread_id) && attachment_segment(resource_id) {
        let fallback_dir = attachment_root().join(thread_id).join(resource_id);
        if fallback_dir.exists() {
            let _ = fs::remove_dir_all(fallback_dir);
        }
    }
}

pub fn lookup_staged_attachment(resource_id: &str) -> Option<Value> {
    if let Some(found) = staged_attachments()
        .lock()
        .unwrap()
        .get(resource_id)
        .map(|item| item.payload.clone())
    {
        return Some(found);
    }
    resolve_staged_on_disk(None, resource_id)
}

fn inspect_staged_resource_dir(resource_id: &str, dir: &Path) -> Option<Value> {
    if !dir.is_dir() {
        return None;
    }
    let dir_marker = dir.join("directory.txt");
    if dir_marker.is_file() {
        let target_path = fs::read_to_string(&dir_marker).ok()?;
        let display_name = Path::new(target_path.trim())
            .file_name()
            .and_then(|n| n.to_str())
            .map(clip_attachment_name)
            .unwrap_or_else(|| "folder".to_string());
        return Some(attachment_payload(
            resource_id,
            &display_name,
            true,
            None,
            None,
            Some(target_path.trim()),
            None,
        ));
    }
    let mut entries = fs::read_dir(dir).ok()?;
    while let Some(Ok(entry)) = entries.next() {
        let file_path = entry.path();
        if file_path.is_file() {
            let name = file_path
                .file_name()
                .and_then(|n| n.to_str())
                .map(clip_attachment_name)
                .unwrap_or_else(|| "attachment".to_string());
            let size = fs::metadata(&file_path).ok().map(|m| m.len());
            let mime = infer_mime_type(&name, None);
            let path_str = file_path.to_string_lossy().to_string();
            return Some(attachment_payload(
                resource_id,
                &name,
                false,
                size,
                Some(&mime),
                Some(&path_str),
                None,
            ));
        }
    }
    None
}

fn resolve_staged_on_disk(thread_id: Option<&str>, resource_id: &str) -> Option<Value> {
    if !attachment_segment(resource_id) {
        return None;
    }
    let root = attachment_root();
    if let Some(tid) = thread_id.filter(|t| attachment_segment(t)) {
        let candidate = root.join(tid).join(resource_id);
        if let Some(found) = inspect_staged_resource_dir(resource_id, &candidate) {
            return Some(found);
        }
    }
    let thread_dirs = fs::read_dir(&root).ok()?;
    for entry in thread_dirs.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let candidate = path.join(resource_id);
            if let Some(found) = inspect_staged_resource_dir(resource_id, &candidate) {
                return Some(found);
            }
        }
    }
    None
}

fn read_image_file_data_url(file_path: &Path) -> Option<String> {
    if !file_path.is_file() {
        return None;
    }
    let meta = fs::metadata(file_path).ok()?;
    if (meta.len() as usize) > PREVIEW_IMAGE_BYTE_LIMIT {
        return None;
    }
    let name = file_path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let mime = infer_mime_type(name, None);
    if !mime.starts_with("image/") {
        return None;
    }
    let bytes = fs::read(file_path).ok()?;
    Some(format!("data:{mime};base64,{}", encode_base64(&bytes)))
}

/// Reads an image attachment preview on demand from disk under `chat-attachments/`
/// so base64 payloads never have to be persisted inside `threads.data` JSON.
pub fn read_attachment_preview(
    thread_id: Option<&str>,
    resource_id: &str,
    path_hint: Option<&str>,
) -> Option<String> {
    if let Some(raw_path) = path_hint.map(str::trim).filter(|p| !p.is_empty()) {
        if let (Ok(root_canon), Ok(target_canon)) = (
            fs::canonicalize(attachment_root()),
            fs::canonicalize(Path::new(raw_path)),
        ) {
            if target_canon.starts_with(&root_canon) {
                if let Some(url) = read_image_file_data_url(&target_canon) {
                    return Some(url);
                }
            }
        }
    }
    if let Some(resolved) = resolve_staged_on_disk(thread_id, resource_id) {
        if let Some(disk_path) = resolved.get("path").and_then(|v| v.as_str()) {
            return read_image_file_data_url(Path::new(disk_path));
        }
    }
    None
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
    let thread_id = req.get("threadId").and_then(|v| v.as_str());
    let mut res = Vec::new();
    if let Some(arr) = req.get("attachments").and_then(|v| v.as_array()) {
        for item in arr.iter().take(64) {
            if let Some(resource_id) = item.get("resourceId").and_then(|v| v.as_str()) {
                if let Some(staged) = lookup_staged_attachment(resource_id)
                    .or_else(|| resolve_staged_on_disk(thread_id, resource_id))
                {
                    res.push(staged);
                    continue;
                }
                let display_name = item.get("displayName").and_then(|v| v.as_str()).unwrap_or("attachment");
                let is_dir = item.get("isDirectory").and_then(|v| v.as_bool()).unwrap_or(false);
                let byte_size = item.get("byteSize").and_then(|v| v.as_u64());
                let mime_type = item.get("mimeType").and_then(|v| v.as_str());
                let path = item.get("path").and_then(|v| v.as_str());
                // Only preserve legacy inline previewDataUrl when no external disk file backs it.
                let has_disk_file = path.is_some_and(|p| Path::new(p).is_file());
                let preview = if has_disk_file {
                    None
                } else {
                    item.get("previewDataUrl").and_then(|v| v.as_str())
                };
                res.push(attachment_payload(
                    resource_id,
                    display_name,
                    is_dir,
                    byte_size,
                    mime_type,
                    path,
                    preview,
                ));
            }
        }
    } else if let Some(ids) = req.get("attachmentIds").and_then(|v| v.as_array()) {
        for id in ids.iter().take(16) {
            if let Some(uuid_str) = id.as_str() {
                if let Some(staged) = lookup_staged_attachment(uuid_str)
                    .or_else(|| resolve_staged_on_disk(thread_id, uuid_str))
                {
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

/// Formats a user prompt together with any staged file/image attachments so
/// every connected provider receives the exact local disk paths, MIME types,
/// and sizes, and an attachment-only message is never sent as an empty prompt.
pub fn format_prompt_with_attachments(prompt: &str, attachments: &[Value]) -> String {
    if attachments.is_empty() {
        return prompt.to_string();
    }
    let mut lines = Vec::new();
    for item in attachments {
        let resource_id = item.get("resourceId").and_then(|v| v.as_str()).unwrap_or("");
        let resolved = if item.get("path").and_then(|v| v.as_str()).is_none() && !resource_id.is_empty() {
            lookup_staged_attachment(resource_id)
        } else {
            None
        };
        let source = resolved.as_ref().unwrap_or(item);
        let name = source
            .get("displayName")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or("attachment");
        let is_dir = source
            .get("isDirectory")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let byte_size = source.get("byteSize").and_then(|v| v.as_u64());
        let mime = source
            .get("mimeType")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| {
                if is_dir {
                    "directory".to_string()
                } else {
                    infer_mime_type(name, None)
                }
            });
        let path = source
            .get("path")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty());

        let meta = match byte_size {
            Some(bytes) => format!("{mime}, {bytes} bytes"),
            None => mime,
        };
        match path {
            Some(p) => lines.push(format!("- {name} ({meta}): {p}")),
            None => lines.push(format!("- {name} ({meta})")),
        }
    }
    if lines.is_empty() {
        return prompt.to_string();
    }
    let base = if prompt.trim().is_empty() {
        "Please inspect the attached file(s) and image(s)."
    } else {
        prompt.trim_end()
    };
    format!("{base}\n\n{ATTACHED_FILES_HEADER}\n{}", lines.join("\n"))
}

/// Extracts existing on-disk file paths from a prompt formatted with
/// `format_prompt_with_attachments` so CLI transports with native `--file`
/// flags (such as OpenCode) can pass them directly in addition to the prompt.
pub fn extract_attachment_file_paths(prompt: &str) -> Vec<String> {
    let Some((_, block)) = prompt.rsplit_once(&format!("\n{ATTACHED_FILES_HEADER}\n")) else {
        return Vec::new();
    };
    let mut paths = Vec::new();
    for line in block.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with("- ") {
            break;
        }
        if let Some((_, path_part)) = trimmed.rsplit_once("): ") {
            let candidate = path_part.trim();
            if !candidate.is_empty() && Path::new(candidate).is_file() {
                paths.push(candidate.to_string());
            }
        }
    }
    paths
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stage_blob_resolves_disk_path_mime_extension_and_preview() {
        let thread_id = format!("test-att-{}", Uuid::new_v4().simple());
        // 1x1 transparent PNG
        let png_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
        let staged = stage_blob_attachment_with_mime(
            &thread_id,
            "clipboard-image",
            Some("image/png"),
            png_b64,
        )
        .expect("staged blob");

        let resource_id = staged["resourceId"].as_str().expect("resourceId").to_string();
        assert_eq!(staged["displayName"], json!("clipboard-image.png"));
        assert_eq!(staged["mimeType"], json!("image/png"));
        let path_str = staged["path"].as_str().expect("resolved disk path");
        assert!(Path::new(path_str).is_file(), "staged file exists on disk");
        assert!(
            staged.get("previewDataUrl").is_none(),
            "staged attachment JSON must not persist inline base64 previewDataUrl"
        );

        let on_demand_preview = read_attachment_preview(Some(&thread_id), &resource_id, Some(path_str))
            .expect("on-demand image preview from disk");
        assert!(on_demand_preview.starts_with("data:image/png;base64,"));

        // Consuming on send evicts the in-memory staged map entry while keeping disk file intact.
        assert!(staged_attachment_count() >= 1);
        consume_staged_attachments(std::slice::from_ref(&staged));
        assert!(
            !staged_attachments().lock().unwrap().contains_key(&resource_id),
            "consumed attachment must be evicted from staged_attachments()"
        );
        assert!(Path::new(path_str).is_file(), "disk file remains for agent and previews");

        // parse_attachments strips inline previewDataUrl when backed by a disk file.
        let req = json!({
            "threadId": thread_id,
            "attachments": [{
                "resourceId": resource_id,
                "displayName": "clipboard-image.png",
                "mimeType": "image/png",
                "path": path_str,
                "previewDataUrl": "data:image/png;base64,SHOULD_BE_STRIPPED"
            }]
        });
        let parsed = parse_attachments(Some(&req));
        assert_eq!(parsed.len(), 1);
        assert!(parsed[0].get("previewDataUrl").is_none());

        let formatted = format_prompt_with_attachments("", std::slice::from_ref(&staged));
        assert!(formatted.contains("Please inspect the attached file(s) and image(s)."));
        assert!(formatted.contains("[Attached files]"));
        assert!(formatted.contains(path_str));

        let extracted = extract_attachment_file_paths(&formatted);
        assert_eq!(extracted, vec![path_str.to_string()]);

        release_staged_attachment(&thread_id, &resource_id);
        assert!(!Path::new(path_str).exists(), "released file removed");
    }

    #[test]
    fn stage_blob_accepts_underscored_agent_draft_thread_ids_and_rejects_traversal() {
        let draft_id = format!("draft-agent_builder_{}", Uuid::new_v4().simple());
        let png_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
        let staged = stage_blob_attachment_with_mime(
            &draft_id,
            "draft-shot",
            Some("image/png"),
            png_b64,
        )
        .expect("underscored draft thread id stages cleanly");
        let resource_id = staged["resourceId"].as_str().expect("resourceId");
        let path_str = staged["path"].as_str().expect("path");
        assert!(Path::new(path_str).is_file());
        release_staged_attachment(&draft_id, resource_id);

        assert!(!attachment_segment("../escape"));
        assert!(!attachment_segment("draft/sub"));
        assert!(attachment_segment("draft-agent_builder_1"));
    }
}
