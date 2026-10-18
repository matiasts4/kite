use crate::persist::{all_workspace_paths, body, workspace_path};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use uuid::Uuid;

const TEXT_LIMIT: usize = 1_048_576;
const ENTRY_LIMIT: usize = 2000;
const NAME_LIMIT: usize = 1024;

#[derive(Debug, Serialize, Deserialize)]
pub struct FilesError {
    pub code: String,
    pub message: String,
}

impl FilesError {
    pub fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.chars().take(64).collect(),
            message: message.chars().take(500).collect(),
        }
    }
}

#[derive(Clone)]
struct FilesResource {
    workspace_id: String,
    root: PathBuf,
    root_entry_id: String,
    entries: HashMap<String, (PathBuf, bool)>,
}

fn files_resources() -> &'static Mutex<HashMap<String, FilesResource>> {
    static CELL: std::sync::OnceLock<Mutex<HashMap<String, FilesResource>>> = std::sync::OnceLock::new();
    CELL.get_or_init(|| Mutex::new(HashMap::new()))
}

fn workspace_root(workspace_id: &str) -> Result<PathBuf, FilesError> {
    if workspace_id == "global-files" {
        return std::env::temp_dir()
            .canonicalize()
            .map_err(|_| FilesError::new("files_workspace_unavailable", "That workspace folder is unavailable."));
    }
    let Some(raw) = workspace_path(workspace_id) else {
        return Err(FilesError::new("files_workspace_unavailable", "That workspace folder is unavailable."));
    };
    let path = PathBuf::from(raw);
    if !path.is_dir() {
        return Err(FilesError::new("files_workspace_unavailable", "That workspace folder is unavailable."));
    }
    path.canonicalize().map_err(|_| FilesError::new("files_workspace_unavailable", "That workspace folder is unavailable."))
}

fn entry_id(resource_id: &str, relative: &str) -> String {
    Uuid::new_v5(&Uuid::NAMESPACE_OID, format!("{resource_id}|{relative}").as_bytes()).to_string()
}

fn relative_key(root: &Path, path: &Path) -> String {
    let raw = path.strip_prefix(root).unwrap_or(path).to_string_lossy().replace('\\', "/");
    let trimmed = raw.strip_prefix("//?/").unwrap_or(&raw);
    trimmed.to_string()
}

fn display_name_ok(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains('/')
        && !name.contains('\\')
        && name.len() <= NAME_LIMIT
        && name.chars().all(|ch| (ch as u32) >= 32 && (ch as u32) != 127)
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}

fn encode_base64(data: &[u8]) -> String {
    const CHARSET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as usize;
        let b1 = chunk.get(1).copied().unwrap_or(0) as usize;
        let b2 = chunk.get(2).copied().unwrap_or(0) as usize;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(CHARSET[(triple >> 18) & 63] as char);
        out.push(CHARSET[(triple >> 12) & 63] as char);
        if chunk.len() > 1 {
            out.push(CHARSET[(triple >> 6) & 63] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(CHARSET[triple & 63] as char);
        } else {
            out.push('=');
        }
    }
    out
}

fn text_is_editable(text: &str) -> bool {
    text.chars().all(|ch| {
        let code = ch as u32;
        code >= 32 && code != 127 || matches!(ch, '\n' | '\r' | '\t')
    })
}

fn line_ending(text: &str) -> &'static str {
    let crlf = text.contains("\r\n");
    let lf = text.contains('\n');
    let cr = text.contains('\r');
    if crlf && text.replace("\r\n", "").contains('\n') {
        "mixed"
    } else if crlf {
        "crlf"
    } else if lf {
        "lf"
    } else if cr {
        "cr"
    } else {
        "lf"
    }
}

fn text_payload(resource_id: &str, entry_id: &str, text: &str, _path: &Path) -> Value {
    let bytes = text.as_bytes();
    json!({
        "schemaVersion": 1,
        "resourceId": resource_id,
        "entryId": entry_id,
        "revision": sha256_hex(bytes),
        "encoding": "utf8",
        "lineEnding": line_ending(text),
        "editable": true,
        "text": text
    })
}

fn entry_path(workspace_id: &str, resource_id: &str, entry_id: &str, want_dir: bool) -> Result<PathBuf, FilesError> {
    let resources = files_resources().lock().unwrap();
    let Some(resource) = resources.get(resource_id) else {
        return Err(FilesError::new("files_resource_not_found", "That Files resource is no longer available."));
    };
    if resource.workspace_id != workspace_id {
        return Err(FilesError::new("files_resource_conflict", "That Files resource belongs to another workspace."));
    }
    let Some((path, is_dir)) = resource.entries.get(entry_id) else {
        return Err(FilesError::new("files_entry_not_found", "That Files entry is no longer available."));
    };
    if want_dir && !is_dir {
        return Err(FilesError::new("files_entry_type", "That Files entry does not support this operation."));
    }
    Ok(path.clone())
}

pub fn ensure_files(workspace_id: &str, resource_id: Option<&str>) -> Result<Value, FilesError> {
    let root = workspace_root(workspace_id)?;
    let mut resources = files_resources().lock().unwrap();

    let matched_id = if let Some(id) = resource_id {
        if resources.contains_key(id) {
            Some(id.to_string())
        } else {
            None
        }
    } else {
        resources
            .iter()
            .find(|(_, resource)| resource.workspace_id == workspace_id)
            .map(|(id, _)| id.clone())
    };

    if let Some(ref id) = matched_id {
        if let Some(existing) = resources.get_mut(id) {
            if existing.workspace_id != workspace_id {
                return Err(FilesError::new("files_resource_conflict", "That Files resource belongs to another workspace."));
            }
            let name = root.file_name().and_then(|n| n.to_str()).unwrap_or("Workspace");
            let root_entry_id = existing.root_entry_id.clone();
            return Ok(json!({
                "schemaVersion": 1,
                "resourceId": id,
                "root": {
                    "entryId": root_entry_id,
                    "displayName": name,
                    "kind": "directory"
                }
            }));
        }
    }

    let resource_id = resource_id.map(|s| s.to_string()).unwrap_or_else(|| Uuid::new_v4().to_string());
    let root_entry = entry_id(&resource_id, "");
    let mut entries = HashMap::new();
    entries.insert(root_entry.clone(), (root.clone(), true));
    resources.insert(
        resource_id.clone(),
        FilesResource {
            workspace_id: workspace_id.to_string(),
            root: root.clone(),
            root_entry_id: root_entry.clone(),
            entries,
        },
    );
    let name = root.file_name().and_then(|n| n.to_str()).unwrap_or("Workspace");
    Ok(json!({
        "schemaVersion": 1,
        "resourceId": resource_id,
        "root": {
            "entryId": root_entry,
            "displayName": name,
            "kind": "directory"
        }
    }))
}

pub fn list_files(workspace_id: &str, resource_id: &str, parent_id: Option<&str>) -> Result<Value, FilesError> {
    let (parent_id, parent_path, root) = {
        let resources = files_resources().lock().unwrap();
        let Some(resource) = resources.get(resource_id) else {
            return Err(FilesError::new("files_resource_not_found", "That Files resource is no longer available."));
        };
        if resource.workspace_id != workspace_id {
            return Err(FilesError::new("files_resource_conflict", "That Files resource belongs to another workspace."));
        }
        let parent_id = parent_id.unwrap_or(&resource.root_entry_id).to_string();
        let Some((path, is_dir)) = resource.entries.get(&parent_id) else {
            return Err(FilesError::new("files_entry_not_found", "That Files entry is no longer available."));
        };
        if !is_dir {
            return Err(FilesError::new("files_entry_type", "That Files entry does not support this operation."));
        }
        (parent_id, path.clone(), resource.root.clone())
    };
    let read_dir = fs::read_dir(&parent_path).map_err(|_| FilesError::new("files_workspace_unavailable", "That workspace folder is unavailable."))?;
    let mut entries = Vec::new();
    let mut seen_names = HashSet::new();
    let mut resources = files_resources().lock().unwrap();
    let Some(resource) = resources.get_mut(resource_id) else {
        return Err(FilesError::new("files_resource_not_found", "That Files resource is no longer available."));
    };
    for item in read_dir {
        if entries.len() >= ENTRY_LIMIT {
            return Err(FilesError::new("files_limit", "This Files directory exceeds safe entry limit."));
        }
        let Ok(item) = item else { continue };
        let name = item.file_name();
        let Some(name) = name.to_str() else { continue };
        if !display_name_ok(name) || !seen_names.insert(name.to_string()) {
            continue;
        }
        let path = parent_path.join(name);
        let Ok(canonical) = path.canonicalize() else { continue };
        if !canonical.starts_with(&root) {
            continue;
        }
        let is_dir = canonical.is_dir();
        let id = entry_id(resource_id, &relative_key(&root, &canonical));
        resource.entries.insert(id.clone(), (canonical, is_dir));
        if is_dir {
            entries.push(json!({ "entryId": id, "displayName": name, "kind": "directory" }));
        } else {
            let byte_size = item.metadata().ok().map(|meta| meta.len()).unwrap_or(0);
            entries.push(json!({ "entryId": id, "displayName": name, "kind": "file", "byteSize": byte_size }));
        }
    }
    Ok(json!({
        "schemaVersion": 1,
        "resourceId": resource_id,
        "parentEntryId": parent_id,
        "entries": entries
    }))
}

pub fn read_text(workspace_id: &str, resource_id: &str, entry_id: &str) -> Result<Value, FilesError> {
    let path = entry_path(workspace_id, resource_id, entry_id, false)?;
    let bytes = fs::read(&path).map_err(|_| FilesError::new("files_entry_not_found", "That Files entry is no longer available."))?;
    if bytes.len() > TEXT_LIMIT {
        return Err(FilesError::new("files_text_too_large", "That file is too large to open as text."));
    }
    if bytes.contains(&0) {
        return Err(FilesError::new("files_binary", "That file is not supported as text."));
    }
    let text = String::from_utf8(bytes).map_err(|_| FilesError::new("files_edit_unsupported", "This file format cannot be saved safely."))?;
    if !text_is_editable(&text) {
        return Err(FilesError::new("files_edit_unsupported", "This file format cannot be saved safely."));
    }
    Ok(text_payload(resource_id, entry_id, &text, &path))
}

pub fn save_text(workspace_id: &str, resource_id: &str, entry_id: &str, expected_revision: &str, text: &str) -> Result<Value, FilesError> {
    let path = entry_path(workspace_id, resource_id, entry_id, false)?;
    let current = fs::read(&path).unwrap_or_default();
    let current_revision = sha256_hex(&current);
    if !expected_revision.is_empty() && expected_revision != current_revision {
        return Err(FilesError::new("files_revision_conflict", "The file changed on disk. Your draft is retained; reload the file before saving again."));
    }
    if text.len() > TEXT_LIMIT {
        return Err(FilesError::new("files_text_too_large", "This file is too large to show here."));
    }
    if !text_is_editable(text) {
        return Err(FilesError::new("files_edit_unsupported", "This file format cannot be saved safely."));
    }
    fs::write(&path, text.as_bytes()).map_err(|_| FilesError::new("files_workspace_unavailable", "That workspace folder is unavailable."))?;
    Ok(text_payload(resource_id, entry_id, text, &path))
}

pub fn read_preview(workspace_id: &str, resource_id: &str, entry_id: &str) -> Result<Value, FilesError> {
    let path = entry_path(workspace_id, resource_id, entry_id, false)?;
    let mime = match path.extension().and_then(|ext| ext.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        "tiff" | "tif" => "image/tiff",
        "avif" => "image/avif",
        "pdf" => "application/pdf",
        _ => return Err(FilesError::new("files_edit_unsupported", "This file format cannot be saved safely.")),
    };
    let bytes = fs::read(&path).map_err(|_| FilesError::new("files_entry_not_found", "That Files entry is no longer available."))?;
    if bytes.len() > 30_000_000 {
        return Err(FilesError::new("files_limit", "This Files resource exceeds safe file limit."));
    }
    Ok(json!({
        "schemaVersion": 1,
        "resourceId": resource_id,
        "entryId": entry_id,
        "mime": mime,
        "base64": encode_base64(&bytes)
    }))
}

pub fn close_files(resource_id: &str) -> Value {
    files_resources().lock().unwrap().remove(resource_id);
    json!({ "closed": true })
}

pub fn files_entry_path(workspace_id: &str, resource_id: &str, entry_id: &str) -> Option<PathBuf> {
    let resources = files_resources().lock().unwrap();
    let resource = resources.get(resource_id)?;
    if resource.workspace_id != workspace_id {
        return None;
    }
    resource.entries.get(entry_id).map(|(path, _)| path.clone())
}

fn origin_workspace_id(origin: &Value) -> Result<String, FilesError> {
    let kind = origin.get("kind").and_then(|value| value.as_str()).unwrap_or("");
    let workspace_id = match kind {
        "workspace" => origin.get("workspaceId").and_then(|value| value.as_str()),
        "terminal" => {
            let owner = origin.get("owner");
            if let Some(owner) = owner {
                let owner_kind = owner.get("kind").and_then(|value| value.as_str()).unwrap_or("");
                if owner_kind == "workspace" || owner_kind == "workspaceLaunch" {
                    owner.get("workspaceId").and_then(|value| value.as_str())
                } else {
                    None
                }
            } else {
                None
            }
        }
        _ => None,
    };
    if let Some(id) = workspace_id.filter(|id| !id.is_empty()) {
        Ok(id.to_string())
    } else {
        Err(FilesError::new("no_origin_workspace", "No direct workspace origin provided."))
    }
}

fn candidate_text(candidate: &str) -> Result<String, FilesError> {
    if candidate.is_empty() || candidate.len() > 4096 || candidate.chars().any(|ch| ch.is_control()) {
        return Err(FilesError::new("invalid_request", "That file link request is invalid."));
    }
    let mut text = candidate.trim();
    if let Some(stripped) = text.strip_prefix("file:///") {
        text = stripped;
    } else if let Some(stripped) = text.strip_prefix("file://") {
        text = stripped;
    }
    // Strip surrounding quotes and brackets
    text = text.trim_matches(|c| matches!(c, '\'' | '"' | '`' | '(' | ')' | '[' | ']' | '<' | '>'));
    text = text.trim();
    // On Windows, if path looks like /C:/path or \C:\path, strip leading slash
    if (text.starts_with('/') || text.starts_with('\\'))
        && text.len() >= 3
        && text.chars().nth(2) == Some(':')
    {
        text = &text[1..];
    }
    Ok(text.replace("%20", " "))
}

fn parse_line_and_strip(path: &str) -> (String, Option<u32>, Option<u32>) {
    let mut text = path.trim().to_string();
    text = text.trim_matches(|c| matches!(c, '\'' | '"' | '`' | '(' | ')' | '[' | ']' | '<' | '>')).trim().to_string();
    let mut line: Option<u32> = None;
    let mut column: Option<u32> = None;

    // Check for #L123 or #L123-L145 anchor (common in Markdown or GitHub / Antigravity links)
    if let Some((head, tail)) = text.rsplit_once('#') {
        let t = tail.to_ascii_lowercase();
        if t.starts_with('l') {
            let num_part = t.strip_prefix('l').unwrap_or("");
            let num_str = num_part.split('-').next().unwrap_or("");
            if let Ok(l) = num_str.parse::<u32>() {
                line = Some(l);
                text = head.to_string();
            }
        }
    }

    // Check for :line:column or :line
    for _ in 0..2 {
        let Some((head, tail)) = text.rsplit_once(':') else { break };
        if tail.is_empty() || !tail.chars().all(|ch| ch.is_ascii_digit()) {
            break;
        }
        if head.len() == 1 && head.chars().all(|ch| ch.is_ascii_alphabetic()) {
            // Windows drive letter like C:
            break;
        }
        if let Ok(num) = tail.parse::<u32>() {
            if line.is_none() {
                line = Some(num);
            } else if column.is_none() {
                column = line;
                line = Some(num);
            }
        }
        text = head.to_string();
    }

    // Also check for (line,col) or (line) pattern
    if let Some((head, tail)) = text.rsplit_once('(') {
        if let Some(inside) = tail.strip_suffix(')') {
            let parts: Vec<&str> = inside.split(',').collect();
            if !parts.is_empty() && parts[0].trim().chars().all(|c| c.is_ascii_digit()) {
                if let Ok(l) = parts[0].trim().parse::<u32>() {
                    line = Some(l);
                    if parts.len() > 1 && parts[1].trim().chars().all(|c| c.is_ascii_digit()) {
                        if let Ok(c) = parts[1].trim().parse::<u32>() {
                            column = Some(c);
                        }
                    }
                    text = head.trim_end().to_string();
                }
            }
        }
    }

    text = text.trim_matches(|c| matches!(c, '\'' | '"' | '`' | '(' | ')' | '[' | ']' | '<' | '>')).trim().to_string();

    (text, line, column)
}

fn find_file_in_tree(root: &Path, relative_suffix: &str) -> Option<PathBuf> {
    let mut stack = vec![root.to_path_buf()];
    let target_norm = relative_suffix.to_ascii_lowercase().replace('\\', "/");
    let target_trimmed = target_norm.trim_start_matches('/');
    let suffix_slash = format!("/{}", target_trimmed);
    let bare_name = target_trimmed.rsplit('/').next().unwrap_or(target_trimmed);

    let mut exact_suffix_match = None;
    let mut bare_name_match = None;

    while let Some(dir) = stack.pop() {
        let Ok(read_dir) = fs::read_dir(&dir) else { continue };
        for entry in read_dir.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let name_lower = name.to_ascii_lowercase();
            if name.starts_with('.') || name == "node_modules" || name == "target" || name == "dist" || name == "build" || name == "coverage" {
                continue;
            }
            if path.is_dir() {
                stack.push(path);
            } else if path.is_file() {
                let norm = path.to_string_lossy().replace('\\', "/").to_ascii_lowercase();
                if norm.ends_with(&suffix_slash) || norm.ends_with(target_trimmed) {
                    if let Ok(canon) = path.canonicalize() {
                        if canon.starts_with(root) {
                            exact_suffix_match = Some(canon);
                            break;
                        }
                    }
                }
                if bare_name_match.is_none() && (name_lower == bare_name || norm.ends_with(&format!("/{}", bare_name))) {
                    if let Ok(canon) = path.canonicalize() {
                        if canon.starts_with(root) {
                            bare_name_match = Some(canon);
                        }
                    }
                }
            }
        }
        if exact_suffix_match.is_some() {
            break;
        }
    }
    exact_suffix_match.or(bare_name_match)
}

fn locate_candidate_with_root(root: &Path, candidate: &str) -> Option<(PathBuf, Option<u32>, Option<u32>)> {
    let (stripped_path, line, col) = parse_line_and_strip(candidate);
    let clean = stripped_path
        .trim_matches(|c| matches!(c, '\'' | '"' | '`' | '(' | ')' | '[' | ']' | '<' | '>'))
        .trim();

    let attempts = vec![
        clean.to_string(),
        clean.replace('\\', "/"),
        clean.replace('/', "\\"),
        candidate.to_string(),
    ];

    for attempt in &attempts {
        let trimmed_attempt = attempt.trim_matches(|c| matches!(c, '\'' | '"' | '`' | '(' | ')' | '[' | ']' | '<' | '>'));
        let raw = PathBuf::from(trimmed_attempt);
        let joined = if raw.is_absolute() { raw } else { root.join(trimmed_attempt) };
        if let Ok(canonical) = joined.canonicalize() {
            if canonical.is_file() && canonical.starts_with(root) {
                return Some((canonical, line, col));
            }
        }
    }

    // Fallback: search for file by suffix or filename in workspace tree
    let target_norm = clean.replace('\\', "/").trim_start_matches("./").trim_start_matches('/').to_string();
    if !target_norm.is_empty() && !target_norm.contains("..") {
        if let Some(found) = find_file_in_tree(root, &target_norm) {
            return Some((found, line, col));
        }
    }

    None
}

fn remember_file(resource_id: &str, root: &Path, file: &Path) -> Result<(String, String, String), FilesError> {
    let relative = relative_key(root, file);
    let display = file.file_name().and_then(|name| name.to_str()).unwrap_or("").to_string();
    if relative.is_empty() || display.is_empty() {
        return Err(FilesError::new(
            "file_link_unresolved",
            "That file link could not be resolved.",
        ));
    }
    let id = entry_id(resource_id, &relative);
    let mut resources = files_resources().lock().unwrap();
    let Some(resource) = resources.get_mut(resource_id) else {
        return Err(FilesError::new(
            "file_link_unavailable",
            "File links are unavailable for this workspace.",
        ));
    };
    let mut cursor = file.to_path_buf();
    loop {
        let rel = relative_key(root, &cursor);
        let entry = entry_id(resource_id, &rel);
        resource.entries.insert(entry, (cursor.clone(), cursor.is_dir()));
        if &cursor == root {
            break;
        }
        let Some(parent) = cursor.parent() else { break };
        if parent == cursor {
            break;
        }
        cursor = parent.to_path_buf();
    }
    Ok((id, relative, display))
}

fn resolve_link(req: &Value) -> Result<Value, FilesError> {
    if let Some(version) = req.get("supportedSchemaVersion").and_then(|value| value.as_i64()) {
        if version != 1 {
            return Err(FilesError::new("invalid_request", "That file link request is invalid."));
        }
    }
    let candidate = req
        .get("candidate")
        .and_then(|value| value.as_str())
        .ok_or_else(|| FilesError::new("invalid_request", "That file link request is invalid."))?;
    let candidate = candidate_text(candidate)?;

    let mut direct_workspace_id = req
        .get("origin")
        .and_then(|origin| origin_workspace_id(origin).ok());

    if direct_workspace_id.is_none() {
        if let Some(ws_val) = req.get("workspaceId").and_then(|v| v.as_str()) {
            if !ws_val.is_empty() {
                direct_workspace_id = Some(ws_val.to_string());
            }
        }
    }

    // Attempt 1: If we have a direct workspace ID, try locating in that workspace
    let mut resolved: Option<(String, PathBuf, PathBuf, Option<u32>, Option<u32>)> = None;

    if let Some(ws_id) = &direct_workspace_id {
        if let Ok(root) = workspace_root(ws_id) {
            if let Some((file, line, col)) = locate_candidate_with_root(&root, &candidate) {
                resolved = Some((ws_id.clone(), root, file, line, col));
            }
        }
    }

    // Attempt 2: If candidate is absolute or workspace lookup didn't match, check all registered workspaces
    if resolved.is_none() {
        let (raw_path, line, col) = parse_line_and_strip(&candidate);
        let raw_buf = PathBuf::from(&raw_path);
        let all_paths = all_workspace_paths();

        for (ws_id, path_str) in all_paths {
            let ws_root = PathBuf::from(&path_str);
            if let Ok(canon_root) = ws_root.canonicalize() {
                if let Some((file, found_line, found_col)) = locate_candidate_with_root(&canon_root, &candidate) {
                    resolved = Some((ws_id, canon_root, file, found_line.or(line), found_col.or(col)));
                    break;
                }
                if raw_buf.is_absolute() {
                    if let Ok(canon_file) = raw_buf.canonicalize() {
                        if canon_file.is_file() && canon_file.starts_with(&canon_root) {
                            resolved = Some((ws_id, canon_root, canon_file, line, col));
                            break;
                        }
                    }
                }
            }
        }
    }

    // Attempt 3: If candidate points to an existing file anywhere on disk (e.g. Temp/clipboard image, external file)
    if resolved.is_none() {
        let (raw_path, line, col) = parse_line_and_strip(&candidate);
        let mut clean = raw_path
            .trim_matches(|c| matches!(c, '\'' | '"' | '`' | '(' | ')' | '[' | ']' | '<' | '>'))
            .trim()
            .to_string();

        if (clean.starts_with('/') || clean.starts_with('\\'))
            && clean.len() >= 3
            && clean.chars().nth(2) == Some(':')
        {
            clean = clean[1..].to_string();
        }

        let raw_buf = PathBuf::from(&clean);
        let mut canon_opt = if raw_buf.is_absolute() {
            raw_buf.canonicalize().ok()
        } else {
            None
        };

        if canon_opt.is_none() {
            if let Ok(temp_canon) = std::env::temp_dir().join(&clean).canonicalize() {
                if temp_canon.is_file() {
                    canon_opt = Some(temp_canon);
                }
            }
        }

        if let Some(canon_file) = canon_opt {
            if canon_file.is_file() {
                let (ws_id, ws_root) = if let Some(ws_id) = direct_workspace_id.as_ref() {
                    let r = workspace_root(ws_id).unwrap_or_else(|_| canon_file.parent().unwrap_or(&canon_file).to_path_buf());
                    (ws_id.clone(), r)
                } else if let Some((first_id, first_path)) = all_workspace_paths().into_iter().find(|(_, p)| std::path::Path::new(p).is_dir()) {
                    let r = PathBuf::from(first_path).canonicalize().unwrap_or_else(|_| canon_file.parent().unwrap_or(&canon_file).to_path_buf());
                    (first_id, r)
                } else {
                    let r = canon_file.parent().unwrap_or(&canon_file).to_path_buf();
                    ("global-files".to_string(), r)
                };
                resolved = Some((ws_id, ws_root, canon_file, line, col));
            }
        }
    }

    let Some((workspace_id, root, file, line, column)) = resolved else {
        return Err(FilesError::new(
            "file_link_unresolved",
            "That file link could not be resolved.",
        ));
    };

    let existing = {
        let resources = files_resources().lock().unwrap();
        resources
            .iter()
            .find(|(_, resource)| resource.workspace_id == workspace_id)
            .map(|(id, _)| id.clone())
    };
    let ensured = ensure_files(&workspace_id, existing.as_deref())?;
    let resource_id = ensured
        .get("resourceId")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string();
    if resource_id.is_empty() {
        return Err(FilesError::new(
            "file_link_unavailable",
            "File links are unavailable for this workspace.",
        ));
    }
    let (entry_id, relative, display) = remember_file(&resource_id, &root, &file)?;
    Ok(json!({
        "schemaVersion": 1,
        "workspaceId": workspace_id,
        "resourceId": resource_id,
        "entryId": entry_id,
        "relativePath": relative,
        "displayName": display,
        "line": line,
        "column": column
    }))
}

#[tauri::command]
pub fn ensure_files_resource(request: Option<Value>) -> Result<Value, FilesError> {
    let req = body(&request);
    let workspace_id = req.and_then(|r| r.get("workspaceId")).and_then(|v| v.as_str()).unwrap_or("");
    let resource_id = req.and_then(|r| r.get("resourceId")).and_then(|v| v.as_str());
    ensure_files(workspace_id, resource_id)
}

#[tauri::command]
pub fn list_files_directory(request: Option<Value>) -> Result<Value, FilesError> {
    let req = body(&request);
    let workspace_id = req.and_then(|r| r.get("workspaceId")).and_then(|v| v.as_str()).unwrap_or("");
    let resource_id = req.and_then(|r| r.get("resourceId")).and_then(|v| v.as_str()).unwrap_or("");
    let parent_id = req
        .and_then(|r| r.get("parentEntryId").or_else(|| r.get("entryId")))
        .and_then(|v| v.as_str());
    list_files(workspace_id, resource_id, parent_id)
}

#[tauri::command]
pub fn read_files_text(request: Option<Value>) -> Result<Value, FilesError> {
    let req = body(&request);
    let workspace_id = req.and_then(|r| r.get("workspaceId")).and_then(|v| v.as_str()).unwrap_or("");
    let resource_id = req.and_then(|r| r.get("resourceId")).and_then(|v| v.as_str()).unwrap_or("");
    let entry_id = req.and_then(|r| r.get("entryId")).and_then(|v| v.as_str()).unwrap_or("");
    read_text(workspace_id, resource_id, entry_id)
}

#[tauri::command]
pub fn save_files_text(request: Option<Value>) -> Result<Value, FilesError> {
    let req = body(&request);
    let workspace_id = req.and_then(|r| r.get("workspaceId")).and_then(|v| v.as_str()).unwrap_or("");
    let resource_id = req.and_then(|r| r.get("resourceId")).and_then(|v| v.as_str()).unwrap_or("");
    let entry_id = req.and_then(|r| r.get("entryId")).and_then(|v| v.as_str()).unwrap_or("");
    let expected = req
        .and_then(|r| r.get("expectedRevision").or_else(|| r.get("revision")))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let text = req.and_then(|r| r.get("text")).and_then(|v| v.as_str()).unwrap_or("");
    save_text(workspace_id, resource_id, entry_id, expected, text)
}

#[tauri::command]
pub fn read_files_preview(request: Option<Value>) -> Result<Value, FilesError> {
    let req = body(&request);
    let workspace_id = req.and_then(|r| r.get("workspaceId")).and_then(|v| v.as_str()).unwrap_or("");
    let resource_id = req.and_then(|r| r.get("resourceId")).and_then(|v| v.as_str()).unwrap_or("");
    let entry_id = req.and_then(|r| r.get("entryId")).and_then(|v| v.as_str()).unwrap_or("");
    read_preview(workspace_id, resource_id, entry_id)
}

#[tauri::command]
pub fn close_files_resource(request: Option<Value>) -> Value {
    let resource_id = body(&request)
        .and_then(|req| req.get("resourceId"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    close_files(resource_id)
}

#[tauri::command]
pub fn resolve_file_link(request: Option<Value>) -> Result<Value, FilesError> {
    let req = body(&request).ok_or_else(|| FilesError::new("invalid_request", "That file link request is invalid."))?;
    resolve_link(req)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_line_and_strip_plain() {
        let (path, line, col) = parse_line_and_strip("README.md");
        assert_eq!(path, "README.md");
        assert_eq!(line, None);
        assert_eq!(col, None);
    }

    #[test]
    fn test_parse_line_and_strip_with_line_and_col() {
        let (path, line, col) = parse_line_and_strip("src/components/views/FilesView.tsx:120:5");
        assert_eq!(path, "src/components/views/FilesView.tsx");
        assert_eq!(line, Some(120));
        assert_eq!(col, Some(5));
    }

    #[test]
    fn test_parse_line_and_strip_with_quotes_and_brackets() {
        let (path, line, col) = parse_line_and_strip("(\"src/App.tsx:42\")");
        assert_eq!(path, "src/App.tsx");
        assert_eq!(line, Some(42));
        assert_eq!(col, None);
    }

    #[test]
    fn test_parse_line_and_strip_markdown_anchor() {
        let (path, line, col) = parse_line_and_strip("src/main.rs#L85-L100");
        assert_eq!(path, "src/main.rs");
        assert_eq!(line, Some(85));
        assert_eq!(col, None);
    }

    #[test]
    fn test_locate_candidate_with_root_bare_and_case_insensitive() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf();
        let canon_root = root.canonicalize().unwrap();

        // Direct root file
        let direct = locate_candidate_with_root(&canon_root, "README.md");
        assert!(direct.is_some(), "README.md should be located");

        // Relative path with line
        let rel = locate_candidate_with_root(&canon_root, "src/App.tsx:10");
        assert!(rel.is_some(), "src/App.tsx should be located");
        let (path, line, _) = rel.unwrap();
        assert!(path.ends_with("App.tsx"));
        assert_eq!(line, Some(10));

        // Bare filename without directory
        let bare = locate_candidate_with_root(&canon_root, "FilesView.tsx");
        assert!(bare.is_some(), "Bare FilesView.tsx should be found via tree search");

        // Case-insensitive bare filename
        let lower = locate_candidate_with_root(&canon_root, "filesview.tsx");
        assert!(lower.is_some(), "Case-insensitive filesview.tsx should be found");
    }

    #[test]
    fn test_resolve_link_and_preview_external_temp_image() {
        let temp_dir = std::env::temp_dir();
        let sub_dir = temp_dir.join("kite-clipboard-test");
        let _ = fs::create_dir_all(&sub_dir);
        let test_file = sub_dir.join("sample-preview-test.png");
        let dummy_png_bytes = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15c4\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82";
        fs::write(&test_file, dummy_png_bytes).unwrap();

        let req = json!({
            "supportedSchemaVersion": 1,
            "origin": { "kind": "global" },
            "candidate": format!("'{}'", test_file.to_string_lossy())
        });

        let res = resolve_link(&req).expect("External temp image should resolve");
        assert_eq!(res.get("displayName").unwrap().as_str().unwrap(), "sample-preview-test.png");
        let ws_id = res.get("workspaceId").unwrap().as_str().unwrap();
        let resource_id = res.get("resourceId").unwrap().as_str().unwrap();
        let entry_id = res.get("entryId").unwrap().as_str().unwrap();

        let preview = read_preview(ws_id, resource_id, entry_id).expect("Preview should be readable");
        assert_eq!(preview.get("mime").unwrap().as_str().unwrap(), "image/png");
        assert!(!preview.get("base64").unwrap().as_str().unwrap().is_empty());

        let _ = fs::remove_file(test_file);
        let _ = fs::remove_dir(sub_dir);
    }
}
