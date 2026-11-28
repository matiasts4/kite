use crate::remote::auth::{percent_decode, percent_encode};
use crate::remote::rpc::{blocking, opt_str, req_str, RpcError};
use serde_json::{json, Value};
use std::fs::{File, Metadata};
use std::io::Read as _;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

pub const MAX_MARKDOWN_BYTES: usize = 1_048_576;
pub const MAX_IMAGE_BYTES: u64 = 15 * 1024 * 1024;
const MAX_DFS_ENTRIES: usize = 4_000;
const SKIP_DIR_NAMES: &[&str] = &[".git", "node_modules", "target", "dist", "build", "coverage"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreviewKind {
    Markdown,
    Image,
}

#[derive(Debug, Clone)]
pub struct ResolvedRawFile {
    pub canon_path: PathBuf,
    pub mime_type: &'static str,
    pub size_bytes: u64,
    pub workspace_id: Option<String>,
    pub relative_path: String,
    pub display_name: String,
    pub modified_at_ms: i64,
    pub kind: PreviewKind,
}

#[derive(Debug, Clone)]
pub struct RawPreviewHttpError {
    pub status: u16,
    pub reason: &'static str,
    pub code: &'static str,
    pub message: String,
}

#[derive(Debug, Clone)]
enum PreviewResolveError {
    InvalidParams(String),
    NotFound(String),
    PayloadTooLarge(String),
    UnsupportedFileType(String),
    Internal(String),
}

impl PreviewResolveError {
    fn into_rpc_error(self) -> RpcError {
        match self {
            Self::InvalidParams(msg) => RpcError::invalid_params(msg),
            Self::NotFound(msg) => RpcError::new("not_found", msg),
            Self::PayloadTooLarge(msg) => RpcError::new("payload_too_large", msg),
            Self::UnsupportedFileType(msg) => RpcError::new("unsupported_file_type", msg),
            Self::Internal(msg) => RpcError::internal(msg),
        }
    }

    fn into_http_error(self) -> RawPreviewHttpError {
        match self {
            Self::InvalidParams(msg) => RawPreviewHttpError {
                status: 400,
                reason: "Bad Request",
                code: "invalid_params",
                message: msg,
            },
            Self::NotFound(msg) => RawPreviewHttpError {
                status: 404,
                reason: "Not Found",
                code: "not_found",
                message: msg,
            },
            Self::PayloadTooLarge(msg) => RawPreviewHttpError {
                status: 413,
                reason: "Payload Too Large",
                code: "payload_too_large",
                message: msg,
            },
            Self::UnsupportedFileType(msg) => RawPreviewHttpError {
                status: 415,
                reason: "Unsupported Media Type",
                code: "unsupported_file_type",
                message: msg,
            },
            Self::Internal(msg) => RawPreviewHttpError {
                status: 500,
                reason: "Internal Server Error",
                code: "internal_error",
                message: msg,
            },
        }
    }
}

/// RPC handler for `workspace.file_preview`.
/// Resolves a Markdown or raster image file within an allowed workspace or Kite preview root
/// and returns either bounded Markdown text or image metadata + authenticated raw HTTP path.
pub async fn handle_workspace_file_preview(params: Value) -> Result<Value, RpcError> {
    let raw_path = req_str(&params, "path")?;
    let workspace_id = opt_str(&params, "workspaceId");
    let relative_to = opt_str(&params, "relativeTo");

    blocking(move || {
        build_preview_payload(workspace_id.as_deref(), &raw_path, relative_to.as_deref())
    })
    .await?
    .map_err(PreviewResolveError::into_rpc_error)
}

/// Resolves an HTTP `GET /api/v1/workspace/file/raw` request to a verified, contained file.
pub fn resolve_raw_preview_for_http(
    workspace_id: Option<&str>,
    raw_path: &str,
    relative_to: Option<&str>,
) -> Result<ResolvedRawFile, RawPreviewHttpError> {
    let ws = workspace_id.map(str::trim).filter(|s| !s.is_empty());
    let rel = relative_to.map(str::trim).filter(|s| !s.is_empty());
    let resolved = resolve_preview_file_inner(ws, raw_path, rel, false)
        .map_err(PreviewResolveError::into_http_error)?;
    if resolved.size_bytes > MAX_IMAGE_BYTES {
        return Err(PreviewResolveError::PayloadTooLarge(format!(
            "File exceeds the {} MiB mobile preview limit.",
            MAX_IMAGE_BYTES / (1024 * 1024)
        ))
        .into_http_error());
    }
    Ok(resolved)
}

/// Public preview resolver for direct unit tests and sibling modules.
pub fn resolve_preview_file(
    workspace_id: Option<&str>,
    raw_path: &str,
    relative_to: Option<&str>,
) -> Result<ResolvedRawFile, RpcError> {
    resolve_preview_file_inner(workspace_id, raw_path, relative_to, true)
        .map_err(PreviewResolveError::into_rpc_error)
}

fn build_preview_payload(
    workspace_id: Option<&str>,
    raw_path: &str,
    relative_to: Option<&str>,
) -> Result<Value, PreviewResolveError> {
    let resolved = resolve_preview_file_inner(workspace_id, raw_path, relative_to, true)?;

    match resolved.kind {
        PreviewKind::Markdown => {
            let file = File::open(&resolved.canon_path).map_err(|e| {
                PreviewResolveError::NotFound(format!("Unable to open Markdown file: {e}"))
            })?;
            let meta = file.metadata().map_err(|e| {
                PreviewResolveError::Internal(format!("Unable to read file metadata: {e}"))
            })?;
            let size_bytes = meta.len();
            let modified_at_ms = metadata_modified_ms(&meta);

            let mut buf = Vec::new();
            file.take((MAX_MARKDOWN_BYTES + 1) as u64)
                .read_to_end(&mut buf)
                .map_err(|e| {
                    PreviewResolveError::Internal(format!("Unable to read Markdown file: {e}"))
                })?;

            let truncated = buf.len() > MAX_MARKDOWN_BYTES;
            let slice = if truncated {
                truncate_utf8_boundary(&buf, MAX_MARKDOWN_BYTES)
            } else {
                &buf[..]
            };
            let text = String::from_utf8_lossy(slice).into_owned();

            Ok(json!({
                "kind": "markdown",
                "workspaceId": resolved.workspace_id,
                "relativePath": resolved.relative_path,
                "displayName": resolved.display_name,
                "mimeType": resolved.mime_type,
                "sizeBytes": size_bytes,
                "modifiedAtMs": modified_at_ms,
                "truncated": truncated,
                "text": text,
            }))
        }
        PreviewKind::Image => {
            if resolved.size_bytes > MAX_IMAGE_BYTES {
                return Err(PreviewResolveError::PayloadTooLarge(format!(
                    "Image exceeds the {} MiB mobile preview limit.",
                    MAX_IMAGE_BYTES / (1024 * 1024)
                )));
            }
            let mut raw_url = format!(
                "/api/v1/workspace/file/raw?path={}",
                percent_encode(&resolved.relative_path)
            );
            if let Some(ref ws_id) = resolved.workspace_id {
                raw_url.push_str("&workspaceId=");
                raw_url.push_str(&percent_encode(ws_id));
            }

            Ok(json!({
                "kind": "image",
                "workspaceId": resolved.workspace_id,
                "relativePath": resolved.relative_path,
                "displayName": resolved.display_name,
                "mimeType": resolved.mime_type,
                "sizeBytes": resolved.size_bytes,
                "modifiedAtMs": resolved.modified_at_ms,
                "rawPath": raw_url,
            }))
        }
    }
}

fn resolve_preview_file_inner(
    workspace_id: Option<&str>,
    raw_path: &str,
    relative_to: Option<&str>,
    decode_percent: bool,
) -> Result<ResolvedRawFile, PreviewResolveError> {
    let clean = sanitize_candidate_path(raw_path, decode_percent)?;
    let _ = classify_preview_extension(Path::new(&clean))?;

    let clean_rel_to = match relative_to {
        Some(rt) => Some(sanitize_relative_to(rt, decode_percent)?),
        None => None,
    };

    let candidate_path = Path::new(&clean);
    let is_abs = candidate_path.is_absolute();
    let has_traversal = has_parent_dir(candidate_path);

    // Reject explicit `..` components on absolute paths up front.
    if is_abs && has_traversal {
        return Err(PreviewResolveError::InvalidParams(
            "Path traversal ('..') is not allowed in absolute paths.".to_string(),
        ));
    }

    // 1. Requested workspaceId.
    let mut contained_rel_to_missed = false;
    if let Some(ws_id) = workspace_id.map(str::trim).filter(|s| !s.is_empty()) {
        if let Some(ws_root_str) = crate::persist::workspace_path(ws_id) {
            if let Ok(canon_root) = Path::new(&ws_root_str).canonicalize() {
                if canon_root.is_dir() {
                    match resolve_inside_workspace(
                        &canon_root,
                        &clean,
                        is_abs,
                        has_traversal,
                        clean_rel_to.as_deref(),
                        true,
                    )? {
                        WorkspaceLookup::Found(found) => {
                            return build_resolved_file(Some(ws_id.to_string()), Some(&canon_root), found);
                        }
                        WorkspaceLookup::ContainedMiss => {
                            contained_rel_to_missed = true;
                        }
                        WorkspaceLookup::NotFound => {}
                    }
                }
            }
        }
    }

    // Unresolved relative path with explicit `..` when no requested workspace contained it
    // (or when no workspaceId was provided at all, unless relativeTo resolves inside an allowed root).
    if !is_abs && has_traversal {
        if let Some(ref rt) = clean_rel_to {
            if let Some(found) = resolve_relative_to_allowed_non_workspace(&clean, rt)? {
                return build_resolved_file(None, None, found);
            }
        }
        if contained_rel_to_missed {
            return Err(PreviewResolveError::NotFound(
                "Preview file could not be found in an allowed workspace or Kite directory."
                    .to_string(),
            ));
        }
        return Err(PreviewResolveError::InvalidParams(
            "Path traversal outside allowed root is not permitted.".to_string(),
        ));
    }

    // 2. Any registered workspace from `all_workspace_paths()`.
    let mut all_ws: Vec<(String, String)> = crate::persist::all_workspace_paths()
        .into_iter()
        .filter(|(id, p)| !p.trim().is_empty() && workspace_id != Some(id.as_str()))
        .collect();
    all_ws.sort_by(|a, b| a.0.cmp(&b.0));

    let allow_dfs_across_all = workspace_id.is_none();
    for (other_ws_id, other_ws_path) in all_ws {
        let Ok(canon_root) = Path::new(&other_ws_path).canonicalize() else {
            continue;
        };
        if !canon_root.is_dir() {
            continue;
        }
        if let WorkspaceLookup::Found(found) = resolve_inside_workspace(
            &canon_root,
            &clean,
            is_abs,
            has_traversal,
            clean_rel_to.as_deref(),
            allow_dfs_across_all,
        )? {
            return build_resolved_file(Some(other_ws_id), Some(&canon_root), found);
        }
    }

    // 3. Allowed non-workspace roots (`roaming_app_dir`, `temp_dir`, `$USERPROFILE/.gemini/antigravity/brain`).
    if is_abs {
        for canon_allowed in allowed_non_workspace_roots() {
            if let Some(canon_file) = verify_contained_file(&canon_allowed, candidate_path) {
                return build_resolved_file(None, None, canon_file);
            }
        }
    } else if let Some(ref rt) = clean_rel_to {
        if let Some(found) = resolve_relative_to_allowed_non_workspace(&clean, rt)? {
            return build_resolved_file(None, None, found);
        }
    }

    Err(PreviewResolveError::NotFound(
        "Preview file could not be found in an allowed workspace or Kite directory.".to_string(),
    ))
}

enum WorkspaceLookup {
    Found(PathBuf),
    ContainedMiss,
    NotFound,
}

fn resolve_inside_workspace(
    canon_root: &Path,
    clean_candidate: &str,
    is_abs: bool,
    has_traversal: bool,
    clean_rel_to: Option<&str>,
    allow_dfs: bool,
) -> Result<WorkspaceLookup, PreviewResolveError> {
    let candidate_path = Path::new(clean_candidate);

    if is_abs {
        return Ok(match verify_contained_file(canon_root, candidate_path) {
            Some(found) => WorkspaceLookup::Found(found),
            None => WorkspaceLookup::NotFound,
        });
    }

    // 1a. Try joining with `Path::new(relativeTo).parent()` inside `canon_root` first.
    let mut rel_to_matched_root = false;
    if let Some(rt) = clean_rel_to {
        if let Some(base_rel_dir) = resolve_relative_to_base_in_root(canon_root, rt)? {
            rel_to_matched_root = true;
            if let Some(found) = lexical_resolve_inside_root(canon_root, &base_rel_dir, candidate_path)? {
                return Ok(WorkspaceLookup::Found(found));
            }
        }
    }

    if has_traversal && rel_to_matched_root {
        return Ok(WorkspaceLookup::ContainedMiss);
    }

    // 1b. Try direct join inside `canon_root`.
    // Note: if `clean_candidate` starts with `/` or `\` on Windows (`!is_absolute() && has_root()`),
    // strip the leading root slash so `Path::join` treats it as workspace-root-relative.
    let direct_rel = clean_candidate.trim_start_matches(['/', '\\']);
    if !direct_rel.is_empty() {
        if let Some(found) =
            lexical_resolve_inside_root(canon_root, Path::new(""), Path::new(direct_rel))?
        {
            return Ok(WorkspaceLookup::Found(found));
        }
    }

    // Never allow explicit `..` paths to fall through to DFS or other workspaces.
    if has_traversal {
        return Err(PreviewResolveError::InvalidParams(
            "Path traversal outside workspace root is not permitted.".to_string(),
        ));
    }

    // 1c. Bounded DFS tree search inside `canon_root`.
    if allow_dfs {
        return Ok(match dfs_find_in_workspace(canon_root, clean_candidate) {
            Some(found) => WorkspaceLookup::Found(found),
            None => WorkspaceLookup::NotFound,
        });
    }

    Ok(WorkspaceLookup::NotFound)
}

fn resolve_relative_to_allowed_non_workspace(
    clean_candidate: &str,
    clean_rel_to: &str,
) -> Result<Option<PathBuf>, PreviewResolveError> {
    let rt_path = Path::new(clean_rel_to);
    if !rt_path.is_absolute() {
        return Ok(None);
    }
    for canon_allowed in allowed_non_workspace_roots() {
        if let Some(base_rel_dir) = resolve_relative_to_base_in_root(&canon_allowed, clean_rel_to)? {
            let trimmed_cand = clean_candidate.trim_start_matches(['/', '\\']);
            if trimmed_cand.is_empty() {
                continue;
            }
            if let Some(found) =
                lexical_resolve_inside_root(&canon_allowed, &base_rel_dir, Path::new(trimmed_cand))?
            {
                return Ok(Some(found));
            }
        }
    }
    Ok(None)
}

fn resolve_relative_to_base_in_root(
    canon_root: &Path,
    clean_rel_to: &str,
) -> Result<Option<PathBuf>, PreviewResolveError> {
    let rt_path = Path::new(clean_rel_to);
    if rt_path.is_absolute() {
        let Some(parent) = rt_path.parent() else {
            return Ok(None);
        };
        let Ok(canon_parent) = parent.canonicalize() else {
            return Ok(None);
        };
        if let Ok(rel) = canon_parent.strip_prefix(canon_root) {
            return Ok(Some(rel.to_path_buf()));
        }
        return Ok(None);
    }

    if has_parent_dir(rt_path) {
        return Err(PreviewResolveError::InvalidParams(
            "relativeTo cannot contain '..' segments.".to_string(),
        ));
    }
    let trimmed = clean_rel_to.trim_start_matches(['/', '\\']);
    let parent = Path::new(trimmed).parent().unwrap_or_else(|| Path::new(""));
    Ok(Some(parent.to_path_buf()))
}

fn lexical_resolve_inside_root(
    canon_root: &Path,
    base_rel_dir: &Path,
    candidate: &Path,
) -> Result<Option<PathBuf>, PreviewResolveError> {
    let mut parts: Vec<std::ffi::OsString> = Vec::new();
    for comp in base_rel_dir.components() {
        match comp {
            Component::Normal(s) => parts.push(s.to_os_string()),
            Component::CurDir => {}
            Component::ParentDir => {
                if parts.pop().is_none() {
                    return Err(PreviewResolveError::InvalidParams(
                        "relativeTo escapes allowed root.".to_string(),
                    ));
                }
            }
            Component::Prefix(_) | Component::RootDir => return Ok(None),
        }
    }
    for comp in candidate.components() {
        match comp {
            Component::Normal(s) => parts.push(s.to_os_string()),
            Component::CurDir => {}
            Component::ParentDir => {
                if parts.pop().is_none() {
                    return Err(PreviewResolveError::InvalidParams(
                        "Path traversal outside allowed root is not permitted.".to_string(),
                    ));
                }
            }
            Component::Prefix(_) | Component::RootDir => return Ok(None),
        }
    }

    let mut joined = canon_root.to_path_buf();
    for part in parts {
        joined.push(part);
    }

    match joined.canonicalize() {
        Ok(canon_file) => {
            if !canon_file.starts_with(canon_root) {
                return Err(PreviewResolveError::InvalidParams(
                    "Resolved path escapes allowed root.".to_string(),
                ));
            }
            if canon_file.is_file() {
                Ok(Some(canon_file))
            } else {
                Ok(None)
            }
        }
        Err(_) => Ok(None),
    }
}

fn verify_contained_file(canon_root: &Path, candidate: &Path) -> Option<PathBuf> {
    let canon_file = candidate.canonicalize().ok()?;
    if canon_file.starts_with(canon_root) && canon_file.is_file() {
        Some(canon_file)
    } else {
        None
    }
}

fn build_resolved_file(
    workspace_id: Option<String>,
    canon_root: Option<&Path>,
    canon_file: PathBuf,
) -> Result<ResolvedRawFile, PreviewResolveError> {
    // Defense in depth: verify the canonicalized file extension is allowlisted.
    let (kind, mime_type) = classify_preview_extension(&canon_file)?;
    let meta = std::fs::metadata(&canon_file)
        .map_err(|e| PreviewResolveError::NotFound(format!("Unable to inspect file: {e}")))?;
    if !meta.is_file() {
        return Err(PreviewResolveError::NotFound(
            "Preview target is not a regular file.".to_string(),
        ));
    }
    let size_bytes = meta.len();
    let modified_at_ms = metadata_modified_ms(&meta);

    let display_name = canon_file
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();

    let relative_path = match canon_root.and_then(|root| canon_file.strip_prefix(root).ok()) {
        Some(rel) => rel.to_string_lossy().replace('\\', "/"),
        None => plain_path(&canon_file),
    };

    Ok(ResolvedRawFile {
        canon_path: canon_file,
        mime_type,
        size_bytes,
        workspace_id,
        relative_path,
        display_name,
        modified_at_ms,
        kind,
    })
}

fn dfs_find_in_workspace(canon_root: &Path, clean_candidate: &str) -> Option<PathBuf> {
    let norm_cand = clean_candidate
        .replace('\\', "/")
        .trim_start_matches("./")
        .trim_start_matches('/')
        .to_string();
    if norm_cand.is_empty() {
        return None;
    }
    let has_sep = norm_cand.contains('/');
    let norm_cand_lower = norm_cand.to_ascii_lowercase();
    let suffix_exact = format!("/{norm_cand}");
    let suffix_lower = format!("/{norm_cand_lower}");

    let mut stack: Vec<PathBuf> = vec![canon_root.to_path_buf()];
    let mut visited: usize = 0;
    let mut ci_fallback: Option<PathBuf> = None;

    while let Some(dir) = stack.pop() {
        let Ok(read_dir) = std::fs::read_dir(&dir) else {
            continue;
        };
        let mut entries: Vec<std::fs::DirEntry> = read_dir.flatten().collect();
        entries.sort_by(|a, b| a.file_name().cmp(&b.file_name()));

        let mut subdirs: Vec<PathBuf> = Vec::new();
        for entry in entries {
            visited += 1;
            if visited > MAX_DFS_ENTRIES {
                return ci_fallback;
            }
            let Ok(ft) = entry.file_type() else {
                continue;
            };
            let name_os = entry.file_name();
            let name = name_os.to_string_lossy();
            if ft.is_dir() {
                if name.starts_with('.')
                    || SKIP_DIR_NAMES.iter().any(|skip| name.as_ref() == *skip)
                {
                    continue;
                }
                subdirs.push(entry.path());
                continue;
            }
            if !ft.is_file() {
                continue;
            }
            let path = entry.path();
            if has_sep {
                let Ok(rel) = path.strip_prefix(canon_root) else {
                    continue;
                };
                let rel_slash = rel.to_string_lossy().replace('\\', "/");
                if rel_slash == norm_cand || rel_slash.ends_with(&suffix_exact) {
                    if let Some(verified) = verify_contained_file(canon_root, &path) {
                        return Some(verified);
                    }
                } else if ci_fallback.is_none() {
                    let rel_lower = rel_slash.to_ascii_lowercase();
                    if rel_lower == norm_cand_lower || rel_lower.ends_with(&suffix_lower) {
                        if let Some(verified) = verify_contained_file(canon_root, &path) {
                            ci_fallback = Some(verified);
                        }
                    }
                }
            } else if name.as_ref() == norm_cand {
                if let Some(verified) = verify_contained_file(canon_root, &path) {
                    return Some(verified);
                }
            } else if ci_fallback.is_none() && name.eq_ignore_ascii_case(&norm_cand) {
                if let Some(verified) = verify_contained_file(canon_root, &path) {
                    ci_fallback = Some(verified);
                }
            }
        }

        for sub in subdirs.into_iter().rev() {
            stack.push(sub);
        }
    }

    ci_fallback
}

fn allowed_non_workspace_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    let mut push_canon = |p: PathBuf| {
        if let Ok(canon) = p.canonicalize() {
            if canon.is_dir() && !roots.contains(&canon) {
                roots.push(canon);
            }
        }
    };
    push_canon(crate::persist::roaming_app_dir());
    push_canon(std::env::temp_dir());
    if let Ok(home) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
        let trimmed = home.trim();
        if !trimmed.is_empty() {
            push_canon(
                PathBuf::from(trimmed)
                    .join(".gemini")
                    .join("antigravity")
                    .join("brain"),
            );
        }
    }
    roots
}

fn sanitize_relative_to(raw: &str, decode_percent: bool) -> Result<String, PreviewResolveError> {
    sanitize_path_common(raw, decode_percent, "relativeTo")
}

fn sanitize_candidate_path(raw: &str, decode_percent: bool) -> Result<String, PreviewResolveError> {
    let clean = sanitize_path_common(raw, decode_percent, "File path")?;
    let p = Path::new(&clean);
    if clean == "." || clean == ".." || p.file_name().is_none() {
        return Err(PreviewResolveError::InvalidParams(
            "File path must name a file.".to_string(),
        ));
    }
    Ok(clean)
}

fn sanitize_path_common(
    raw: &str,
    decode_percent: bool,
    label: &str,
) -> Result<String, PreviewResolveError> {
    if has_nul_or_control(raw) {
        return Err(PreviewResolveError::InvalidParams(format!(
            "{label} contains invalid control characters."
        )));
    }
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(PreviewResolveError::InvalidParams(format!(
            "{label} cannot be empty."
        )));
    }

    let decoded = if decode_percent {
        percent_decode_uri_path(trimmed)
    } else {
        trimmed.to_string()
    };
    if has_nul_or_control(&decoded) {
        return Err(PreviewResolveError::InvalidParams(format!(
            "{label} contains invalid control characters."
        )));
    }

    let mut s = strip_surrounding_wrappers(&decoded).to_string();
    if s.is_empty() {
        return Err(PreviewResolveError::InvalidParams(format!(
            "{label} cannot be empty."
        )));
    }

    // Reject remote/non-local URI schemes early.
    let lower = s.to_ascii_lowercase();
    if lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("data:")
        || lower.starts_with("blob:")
        || lower.starts_with("javascript:")
    {
        return Err(PreviewResolveError::InvalidParams(
            "Only local workspace and Kite preview files are supported.".to_string(),
        ));
    }

    // Strip `file://` URI prefix.
    if let Some(rest) = strip_prefix_ascii_ci(&s, "file://localhost/") {
        s = format!("/{rest}");
    } else if let Some(rest) = strip_prefix_ascii_ci(&s, "file://") {
        s = rest.to_string();
    }

    // Strip Windows extended-length UNC prefix (`\\?\`) before scanning for `?query` params.
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        s = format!(r"\\{rest}");
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        s = rest.to_string();
    }

    // Strip Windows leading `/C:/` or `\C:\` slash.
    s = strip_windows_leading_drive_slash(&s).to_string();

    // Strip `#...` anchor and `?query` suffix.
    if let Some(idx) = s.find(['#', '?']) {
        s.truncate(idx);
    }

    // Strip `:line` / `:line:col` suffixes while preserving `C:` drive letters.
    s = strip_line_col_suffix(&s).to_string();
    s = strip_surrounding_wrappers(&s).to_string();
    s = strip_windows_leading_drive_slash(&s).to_string();

    if s.is_empty() {
        return Err(PreviewResolveError::InvalidParams(format!(
            "{label} cannot be empty."
        )));
    }
    Ok(s)
}

fn percent_decode_uri_path(input: &str) -> String {
    // Reuse `auth::percent_decode` per `+`-separated segment so literal `+` in filenames
    // is never turned into a space inside URI or filesystem paths.
    input
        .split('+')
        .map(percent_decode)
        .collect::<Vec<_>>()
        .join("+")
}

fn has_nul_or_control(s: &str) -> bool {
    s.contains('\0') || s.chars().any(char::is_control)
}

fn strip_surrounding_wrappers(mut s: &str) -> &str {
    loop {
        let trimmed = s.trim();
        let next = if let Some(inner) = trimmed.strip_prefix('\'').and_then(|r| r.strip_suffix('\'')) {
            inner
        } else if let Some(inner) = trimmed.strip_prefix('"').and_then(|r| r.strip_suffix('"')) {
            inner
        } else if let Some(inner) = trimmed.strip_prefix('`').and_then(|r| r.strip_suffix('`')) {
            inner
        } else if let Some(inner) = trimmed.strip_prefix('(').and_then(|r| r.strip_suffix(')')) {
            inner
        } else if let Some(inner) = trimmed.strip_prefix('[').and_then(|r| r.strip_suffix(']')) {
            inner
        } else if let Some(inner) = trimmed.strip_prefix('<').and_then(|r| r.strip_suffix('>')) {
            inner
        } else {
            trimmed.trim_matches(|c| {
                matches!(c, '\'' | '"' | '`' | '(' | ')' | '[' | ']' | '<' | '>')
            })
        };
        if next == s {
            return next;
        }
        s = next;
    }
}

fn strip_prefix_ascii_ci<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    if s.len() >= prefix.len() && s[..prefix.len()].eq_ignore_ascii_case(prefix) {
        Some(&s[prefix.len()..])
    } else {
        None
    }
}

fn strip_windows_leading_drive_slash(s: &str) -> &str {
    let b = s.as_bytes();
    if b.len() >= 4
        && matches!(b[0], b'/' | b'\\')
        && b[1].is_ascii_alphabetic()
        && b[2] == b':'
        && matches!(b[3], b'/' | b'\\')
    {
        &s[1..]
    } else {
        s
    }
}

fn strip_line_col_suffix(mut s: &str) -> &str {
    for _ in 0..2 {
        let Some(colon_idx) = s.rfind(':') else {
            break;
        };
        // Never strip a Windows drive letter (`C:`).
        if colon_idx == 1 && s.as_bytes()[0].is_ascii_alphabetic() {
            break;
        }
        let tail = &s[colon_idx + 1..];
        if !tail.is_empty() && tail.bytes().all(|b| b.is_ascii_digit()) {
            s = &s[..colon_idx];
        } else {
            break;
        }
    }
    s
}

fn has_parent_dir(path: &Path) -> bool {
    path.components().any(|c| matches!(c, Component::ParentDir))
}

fn classify_preview_extension(
    path: &Path,
) -> Result<(PreviewKind, &'static str), PreviewResolveError> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    match ext.as_deref() {
        Some("md" | "markdown" | "mdx") => Ok((PreviewKind::Markdown, "text/markdown")),
        Some("png") => Ok((PreviewKind::Image, "image/png")),
        Some("jpg" | "jpeg") => Ok((PreviewKind::Image, "image/jpeg")),
        Some("webp") => Ok((PreviewKind::Image, "image/webp")),
        Some("gif") => Ok((PreviewKind::Image, "image/gif")),
        Some("bmp") => Ok((PreviewKind::Image, "image/bmp")),
        _ => Err(PreviewResolveError::UnsupportedFileType(
            "Only Markdown and image files can be previewed on mobile.".to_string(),
        )),
    }
}

fn truncate_utf8_boundary(bytes: &[u8], max_bytes: usize) -> &[u8] {
    if bytes.len() <= max_bytes {
        return bytes;
    }
    let mut end = max_bytes;
    let mut back = 0usize;
    while end > 0 && back < 3 && (bytes[end - 1] & 0b1100_0000) == 0b1000_0000 {
        end -= 1;
        back += 1;
    }
    if end > 0 {
        let lead = bytes[end - 1];
        let expected_len = if lead < 0x80 {
            1
        } else if (lead & 0b1110_0000) == 0b1100_0000 {
            2
        } else if (lead & 0b1111_0000) == 0b1110_0000 {
            3
        } else if (lead & 0b1111_1000) == 0b1111_0000 {
            4
        } else {
            return &bytes[..max_bytes];
        };
        let actual_len = max_bytes - (end - 1);
        if actual_len < expected_len {
            return &bytes[..(end - 1)];
        }
    }
    &bytes[..max_bytes]
}

fn metadata_modified_ms(meta: &Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn plain_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else {
        text.strip_prefix(r"\\?\").unwrap_or(text.as_ref()).to_string()
    }
}
