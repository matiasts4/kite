use crate::agent_mind::memory::sync_agent_instructions;
use crate::agent_mind::types::AgentMindError;
use crate::agent_mind::utils::{agents_root, request_body, require_known_agent};
use crate::agents::{resolve_agent_authorized_roots, validate_path_within_authorized_roots};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const MANIFEST_MAX_CHARS: usize = 480; // <= 120 tokens (~4 chars/token)
pub const SEARCH_MAX_EXCERPT_CHARS: usize = 3200; // <= 800 tokens
const MAX_INDEXED_FILE_BYTES: u64 = 512 * 1024;
const MAX_CHUNKS_PER_PACK: usize = 400;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgePackDef {
    pub id: String,
    pub name: String,
    pub root: String,
    #[serde(default)]
    pub globs: Vec<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub created_at_unix_ms: i64,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeChunk {
    pub pack_id: String,
    pub pack_name: String,
    pub path: String,
    pub heading: String,
    pub line_start: usize,
    pub line_end: usize,
    pub preview: String,
    pub mtime_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgePackIndexEntry {
    pub pack_id: String,
    pub name: String,
    pub root: String,
    #[serde(default)]
    pub globs: Vec<String>,
    pub indexed_at_unix_ms: i64,
    pub file_count: usize,
    pub chunk_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeIndexFile {
    #[serde(default = "default_index_version")]
    pub version: u32,
    #[serde(default)]
    pub packs: Vec<KnowledgePackDef>,
    #[serde(default)]
    pub entries: Vec<KnowledgePackIndexEntry>,
    #[serde(default)]
    pub chunks: Vec<KnowledgeChunk>,
}

fn default_index_version() -> u32 {
    1
}

fn now_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn mtime_unix_ms(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn index_file_path(root: &Path, agent_id: &str) -> PathBuf {
    root.join(agent_id).join("knowledge-index.json")
}

pub fn load_knowledge_index_at(root: &Path, agent_id: &str) -> KnowledgeIndexFile {
    let path = index_file_path(root, agent_id);
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<KnowledgeIndexFile>(&raw).ok())
        .unwrap_or_default()
}

pub fn save_knowledge_index_at(
    root: &Path,
    agent_id: &str,
    index: &KnowledgeIndexFile,
) -> Result<(), AgentMindError> {
    let dir = root.join(agent_id);
    fs::create_dir_all(&dir).map_err(|_| {
        AgentMindError::new(
            "knowledge_io_failed",
            "Could not create agent knowledge directory.",
        )
    })?;
    let path = index_file_path(root, agent_id);
    let body = serde_json::to_string_pretty(index).map_err(|_| {
        AgentMindError::new(
            "knowledge_serialize_failed",
            "Could not serialize knowledge index.",
        )
    })?;
    fs::write(path, body).map_err(|_| {
        AgentMindError::new(
            "knowledge_io_failed",
            "Could not write agent knowledge index.",
        )
    })
}

/// Zero-dependency path glob matcher supporting `**`, `*`, and `?` over normalized `/` paths.
pub fn glob_matches(pattern: &str, candidate: &str) -> bool {
    let pat = pattern.trim().replace('\\', "/");
    let text = candidate.trim().replace('\\', "/");
    let pat = pat.trim_start_matches("./");
    let text = text.trim_start_matches("./");
    if pat.is_empty() {
        return false;
    }
    let pat_segs: Vec<&str> = pat.split('/').filter(|s| !s.is_empty()).collect();
    let txt_segs: Vec<&str> = text.split('/').filter(|s| !s.is_empty()).collect();
    match_segments(&pat_segs, &txt_segs)
}

fn match_segments(pat: &[&str], txt: &[&str]) -> bool {
    if pat.is_empty() {
        return txt.is_empty();
    }
    if pat[0] == "**" {
        if match_segments(&pat[1..], txt) {
            return true;
        }
        return !txt.is_empty() && match_segments(pat, &txt[1..]);
    }
    if txt.is_empty() {
        return false;
    }
    wildcard_match_segment(pat[0], txt[0]) && match_segments(&pat[1..], &txt[1..])
}

fn wildcard_match_segment(pattern: &str, value: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let v: Vec<char> = value.chars().collect();
    let (mut pi, mut vi) = (0usize, 0usize);
    let (mut star_idx, mut match_idx) = (None::<usize>, 0usize);
    while vi < v.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi].eq_ignore_ascii_case(&v[vi])) {
            pi += 1;
            vi += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star_idx = Some(pi);
            match_idx = vi;
            pi += 1;
        } else if let Some(si) = star_idx {
            pi = si + 1;
            match_idx += 1;
            vi = match_idx;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

fn default_globs() -> Vec<String> {
    vec![
        "**/*.md".to_string(),
        "**/*.txt".to_string(),
        "**/*.rs".to_string(),
        "**/*.ts".to_string(),
        "**/*.tsx".to_string(),
    ]
}

fn should_skip_dir(name: &str) -> bool {
    matches!(
        name,
        ".git" | "node_modules" | "target" | "dist" | "build" | ".next" | ".vite"
    )
}

fn is_supported_text_extension(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some(
            "md" | "txt"
                | "rs"
                | "ts"
                | "tsx"
                | "js"
                | "jsx"
                | "json"
                | "toml"
                | "yaml"
                | "yml"
                | "css"
                | "sql"
        )
    )
}

fn collect_matching_files(
    pack_root: &Path,
    globs: &[String],
    out: &mut Vec<(PathBuf, String, i64)>,
) {
    let active_globs = if globs.is_empty() {
        default_globs()
    } else {
        globs.to_vec()
    };
    let mut stack = vec![pack_root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let file_name = entry.file_name().to_string_lossy().to_string();
            if path.is_dir() {
                if !should_skip_dir(&file_name) && out.len() < 500 {
                    stack.push(path);
                }
                continue;
            }
            if !is_supported_text_extension(&path) {
                continue;
            }
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if meta.len() > MAX_INDEXED_FILE_BYTES {
                continue;
            }
            let rel = path
                .strip_prefix(pack_root)
                .map(|r| r.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|_| file_name.clone());
            if active_globs.iter().any(|g| glob_matches(g, &rel)) {
                out.push((path, rel, mtime_unix_ms(&meta)));
            }
        }
    }
    out.sort_by(|a, b| a.1.cmp(&b.1));
}

fn chunk_file_contents(
    pack: &KnowledgePackDef,
    abs_path: &Path,
    mtime_ms: i64,
    content: &str,
) -> Vec<KnowledgeChunk> {
    let mut chunks = Vec::new();
    let display_path = abs_path.to_string_lossy().replace('\\', "/");
    let mut current_heading = abs_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file")
        .to_string();
    let mut start_line = 1usize;
    let mut buf: Vec<&str> = Vec::new();

    let flush = |chunks: &mut Vec<KnowledgeChunk>,
                 heading: &str,
                 s_line: usize,
                 e_line: usize,
                 lines: &[&str]| {
        let body = lines
            .iter()
            .map(|l| l.trim())
            .filter(|l| !l.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        if body.is_empty() {
            return;
        }
        let preview: String = body.chars().take(280).collect();
        chunks.push(KnowledgeChunk {
            pack_id: pack.id.clone(),
            pack_name: pack.name.clone(),
            path: display_path.clone(),
            heading: heading.to_string(),
            line_start: s_line,
            line_end: e_line.max(s_line),
            preview,
            mtime_ms,
        });
    };

    let all_lines: Vec<&str> = content.lines().collect();
    for (idx, line) in all_lines.iter().enumerate() {
        let line_no = idx + 1;
        let trimmed = line.trim();
        let is_heading =
            trimmed.starts_with("# ") || trimmed.starts_with("## ") || trimmed.starts_with("### ");
        if is_heading && !buf.is_empty() {
            flush(&mut chunks, &current_heading, start_line, line_no - 1, &buf);
            buf.clear();
            current_heading = trimmed.trim_start_matches('#').trim().to_string();
            start_line = line_no;
        } else if is_heading {
            current_heading = trimmed.trim_start_matches('#').trim().to_string();
            start_line = line_no;
        }
        buf.push(line);
        if buf.len() >= 40 {
            flush(&mut chunks, &current_heading, start_line, line_no, &buf);
            buf.clear();
            start_line = line_no + 1;
        }
    }
    if !buf.is_empty() {
        flush(
            &mut chunks,
            &current_heading,
            start_line,
            all_lines.len().max(1),
            &buf,
        );
    }
    chunks
}

pub fn validate_pack_root(
    raw_root: &str,
    authorized_roots: &[PathBuf],
) -> Result<PathBuf, AgentMindError> {
    let trimmed = raw_root.trim();
    if trimmed.is_empty() {
        return Err(AgentMindError::new(
            "knowledge_invalid_root",
            "Knowledge Pack root path cannot be empty.",
        ));
    }
    if authorized_roots.is_empty() {
        return Err(AgentMindError::new(
            "knowledge_places_denied",
            "Agent has no authorized Places or active workspace configured.",
        ));
    }
    let validated = validate_path_within_authorized_roots(Path::new(trimmed), authorized_roots)
        .map_err(|msg| AgentMindError::new("knowledge_places_denied", &msg))?;
    if !validated.exists() {
        return Err(AgentMindError::new(
            "knowledge_invalid_root",
            "Knowledge Pack root directory does not exist.",
        ));
    }
    Ok(validated)
}

pub fn reindex_knowledge_packs_at(
    agents_dir: &Path,
    agent_id: &str,
    authorized_roots: &[PathBuf],
) -> Result<KnowledgeIndexFile, AgentMindError> {
    let mut index = load_knowledge_index_at(agents_dir, agent_id);
    let mut existing_by_key: HashMap<(String, String, i64), Vec<KnowledgeChunk>> = HashMap::new();
    for chunk in index.chunks.drain(..) {
        existing_by_key
            .entry((chunk.pack_id.clone(), chunk.path.clone(), chunk.mtime_ms))
            .or_default()
            .push(chunk);
    }

    let now = now_unix_ms();
    let mut new_entries = Vec::new();
    let mut new_chunks = Vec::new();

    for pack in &index.packs {
        if !pack.enabled {
            new_entries.push(KnowledgePackIndexEntry {
                pack_id: pack.id.clone(),
                name: pack.name.clone(),
                root: pack.root.clone(),
                globs: pack.globs.clone(),
                indexed_at_unix_ms: now,
                file_count: 0,
                chunk_count: 0,
            });
            continue;
        }
        let validated_root = validate_pack_root(&pack.root, authorized_roots)?;
        let mut files = Vec::new();
        collect_matching_files(&validated_root, &pack.globs, &mut files);
        let file_count = files.len();
        let mut pack_chunks = Vec::new();

        for (abs_path, _rel, mtime) in files {
            let display = abs_path.to_string_lossy().replace('\\', "/");
            if let Some(cached) = existing_by_key.get(&(pack.id.clone(), display, mtime)) {
                pack_chunks.extend(cached.iter().cloned());
            } else if let Ok(content) = fs::read_to_string(&abs_path) {
                pack_chunks.extend(chunk_file_contents(pack, &abs_path, mtime, &content));
            }
            if pack_chunks.len() >= MAX_CHUNKS_PER_PACK {
                pack_chunks.truncate(MAX_CHUNKS_PER_PACK);
                break;
            }
        }

        new_entries.push(KnowledgePackIndexEntry {
            pack_id: pack.id.clone(),
            name: pack.name.clone(),
            root: pack.root.clone(),
            globs: pack.globs.clone(),
            indexed_at_unix_ms: now,
            file_count,
            chunk_count: pack_chunks.len(),
        });
        new_chunks.extend(pack_chunks);
    }

    index.entries = new_entries;
    index.chunks = new_chunks;
    save_knowledge_index_at(agents_dir, agent_id, &index)?;
    Ok(index)
}

pub fn save_knowledge_pack_at(
    agents_dir: &Path,
    agent_id: &str,
    authorized_roots: &[PathBuf],
    id_opt: Option<&str>,
    name: &str,
    raw_root: &str,
    globs: Vec<String>,
    enabled: bool,
) -> Result<KnowledgeIndexFile, AgentMindError> {
    let clean_name = name.trim();
    if clean_name.is_empty() {
        return Err(AgentMindError::new(
            "knowledge_invalid_name",
            "Knowledge Pack name cannot be empty.",
        ));
    }
    let validated_root = validate_pack_root(raw_root, authorized_roots)?;
    let root_str = validated_root.to_string_lossy().to_string();
    let mut index = load_knowledge_index_at(agents_dir, agent_id);
    let pack_id = id_opt
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| {
            let slug: String = clean_name
                .to_ascii_lowercase()
                .chars()
                .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
                .collect();
            format!("kp-{}-{}", slug.trim_matches('-'), now_unix_ms())
        });
    let normalized_globs: Vec<String> = globs
        .into_iter()
        .map(|g| g.trim().to_string())
        .filter(|g| !g.is_empty())
        .collect();

    if let Some(existing) = index.packs.iter_mut().find(|p| p.id == pack_id) {
        existing.name = clean_name.to_string();
        existing.root = root_str;
        existing.globs = normalized_globs;
        existing.enabled = enabled;
    } else {
        index.packs.push(KnowledgePackDef {
            id: pack_id,
            name: clean_name.to_string(),
            root: root_str,
            globs: normalized_globs,
            enabled,
            created_at_unix_ms: now_unix_ms(),
        });
    }
    save_knowledge_index_at(agents_dir, agent_id, &index)?;
    let updated = reindex_knowledge_packs_at(agents_dir, agent_id, authorized_roots)?;
    let _ = sync_agent_instructions(agents_dir, agent_id);
    Ok(updated)
}

pub fn delete_knowledge_pack_at(
    agents_dir: &Path,
    agent_id: &str,
    pack_id: &str,
) -> Result<KnowledgeIndexFile, AgentMindError> {
    let mut index = load_knowledge_index_at(agents_dir, agent_id);
    index.packs.retain(|p| p.id != pack_id);
    index.entries.retain(|e| e.pack_id != pack_id);
    index.chunks.retain(|c| c.pack_id != pack_id);
    save_knowledge_index_at(agents_dir, agent_id, &index)?;
    let _ = sync_agent_instructions(agents_dir, agent_id);
    Ok(index)
}

/// Renders a compact Knowledge Pack manifest strictly capped at <= 120 tokens (~480 chars).
pub fn render_knowledge_manifest_at(agents_dir: &Path, agent_id: &str) -> String {
    let index = load_knowledge_index_at(agents_dir, agent_id);
    let enabled_packs: Vec<&KnowledgePackDef> =
        index.packs.iter().filter(|p| p.enabled).collect();
    if enabled_packs.is_empty() {
        return String::new();
    }
    let mut out = String::from(
        "## Knowledge Packs (Use kite_ctx search for excerpts)\n\n",
    );
    for pack in enabled_packs {
        let entry = index.entries.iter().find(|e| e.pack_id == pack.id);
        let chunk_count = entry.map(|e| e.chunk_count).unwrap_or(0);
        let glob_label = if pack.globs.is_empty() {
            "*".to_string()
        } else {
            pack.globs.join(",")
        };
        let line = format!(
            "- **{}** (`{}` · {} chunks)\n",
            pack.name, glob_label, chunk_count
        );
        if out.chars().count() + line.chars().count() + 1 > MANIFEST_MAX_CHARS {
            break;
        }
        out.push_str(&line);
    }
    if out.chars().count() > MANIFEST_MAX_CHARS {
        out = out.chars().take(MANIFEST_MAX_CHARS - 3).collect::<String>() + "...";
    }
    out.push('\n');
    out
}

/// Searches indexed Knowledge Pack chunks with cumulative excerpt output bounded to <= 800 tokens (~3200 chars).
pub fn search_knowledge_packs_at(
    agents_dir: &Path,
    agent_id: &str,
    query: &str,
    limit: usize,
) -> Value {
    let index = load_knowledge_index_at(agents_dir, agent_id);
    let terms: Vec<String> = query
        .split(|c: char| !c.is_alphanumeric() && c != '_' && c != '-')
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| s.len() >= 2)
        .collect();
    let max_items = limit.clamp(1, 15);
    let enabled_ids: HashSet<&str> = index
        .packs
        .iter()
        .filter(|p| p.enabled)
        .map(|p| p.id.as_str())
        .collect();

    let mut scored: Vec<(usize, &KnowledgeChunk)> = Vec::new();
    for chunk in &index.chunks {
        if !enabled_ids.contains(chunk.pack_id.as_str()) {
            continue;
        }
        if terms.is_empty() {
            scored.push((1, chunk));
            continue;
        }
        let haystack = format!(
            "{} {} {}",
            chunk.heading.to_ascii_lowercase(),
            chunk.path.to_ascii_lowercase(),
            chunk.preview.to_ascii_lowercase()
        );
        let mut score = 0usize;
        for term in &terms {
            if chunk.heading.to_ascii_lowercase().contains(term) {
                score += 3;
            }
            if chunk.path.to_ascii_lowercase().contains(term) {
                score += 2;
            }
            if haystack.contains(term) {
                score += 1;
            }
        }
        if score > 0 {
            scored.push((score, chunk));
        }
    }
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.line_start.cmp(&b.1.line_start)));

    let mut total_chars = 0usize;
    let mut matches = Vec::new();
    for (score, chunk) in scored.into_iter().take(max_items) {
        let excerpt_len = chunk.preview.chars().count();
        if total_chars + excerpt_len > SEARCH_MAX_EXCERPT_CHARS && !matches.is_empty() {
            break;
        }
        let allowed_len = SEARCH_MAX_EXCERPT_CHARS.saturating_sub(total_chars);
        let preview: String = chunk.preview.chars().take(allowed_len).collect();
        total_chars += preview.chars().count();
        matches.push(json!({
            "packId": chunk.pack_id,
            "packName": chunk.pack_name,
            "path": chunk.path,
            "heading": chunk.heading,
            "lineStart": chunk.line_start,
            "lineEnd": chunk.line_end,
            "preview": preview,
            "score": score,
        }));
    }

    json!({
        "query": query,
        "matches": matches,
        "totalChars": total_chars,
        "maxCharsBudget": SEARCH_MAX_EXCERPT_CHARS,
    })
}

fn sync_knowledge_packs_to_autonomy(agent_id: &str, index: &KnowledgeIndexFile) {
    let mut cfg = crate::agents::load_agent_autonomy_config(agent_id);
    cfg.knowledge_packs = index
        .packs
        .iter()
        .map(|p| crate::agents::KnowledgePackConfig {
            id: p.id.clone(),
            name: p.name.clone(),
            root_path: p.root.clone(),
            globs: p.globs.clone(),
            enabled: p.enabled,
        })
        .collect();
    let _ = crate::agents::save_agent_autonomy_config(agent_id, &cfg);
}

fn path_matches_or_inside(candidate: &Path, workspace_root: &Path) -> bool {
    let cand_norm = crate::agents::normalize_lexical_path(
        &candidate.canonicalize().unwrap_or_else(|_| candidate.to_path_buf()),
    );
    let ws_norm = crate::agents::normalize_lexical_path(
        &workspace_root
            .canonicalize()
            .unwrap_or_else(|_| workspace_root.to_path_buf()),
    );
    if cand_norm == ws_norm || cand_norm.starts_with(&ws_norm) {
        return true;
    }
    #[cfg(windows)]
    {
        let c = cand_norm.to_string_lossy().to_ascii_lowercase();
        let w = ws_norm.to_string_lossy().to_ascii_lowercase();
        let w_trim = w.trim_end_matches('\\');
        return c == w_trim || c.starts_with(&format!("{w_trim}\\"));
    }
    #[cfg(not(windows))]
    false
}

fn ensure_agent_place_authorized(agent_id: &str, place_label: &str) {
    let clean = place_label.trim();
    if clean.is_empty() {
        return;
    }
    let changed = {
        let Ok(mut items) = crate::persist::agents().lock() else {
            return;
        };
        let Some(agent) = items.iter_mut().find(|a| a.id == agent_id) else {
            return;
        };
        if agent
            .place_display_names
            .iter()
            .any(|p| p.trim().eq_ignore_ascii_case(clean))
        {
            false
        } else {
            agent.place_display_names.push(clean.to_string());
            true
        }
    };
    if changed {
        crate::persist::persist();
    }
}

fn resolve_and_auto_authorize_workspace(
    agent_id: &str,
    workspace_id: Option<&str>,
    raw_root: &str,
    explicit_auto_authorize: Option<bool>,
) -> Option<PathBuf> {
    let workspaces = crate::persist::workspaces()
        .lock()
        .map(|w| w.clone())
        .unwrap_or_default();

    let mut matched_ws: Option<(String, PathBuf)> = None;
    if let Some(ws_id) = workspace_id.map(str::trim).filter(|s| !s.is_empty()) {
        if let Some(ws) = workspaces
            .iter()
            .find(|w| w.id == ws_id || w.display_name.eq_ignore_ascii_case(ws_id))
        {
            if let Some(p) = crate::persist::workspace_path(&ws.id) {
                matched_ws = Some((ws.display_name.clone(), PathBuf::from(p)));
            }
        }
    }

    let trimmed_root = raw_root.trim();
    if matched_ws.is_none() && !trimmed_root.is_empty() {
        let candidate = PathBuf::from(trimmed_root);
        for ws in &workspaces {
            if let Some(p) = crate::persist::workspace_path(&ws.id) {
                let ws_path = PathBuf::from(p);
                if path_matches_or_inside(&candidate, &ws_path) {
                    matched_ws = Some((ws.display_name.clone(), ws_path));
                    break;
                }
            }
        }
    }

    let auto_authorize = explicit_auto_authorize.unwrap_or(true);
    if let Some((display_name, ws_path)) = matched_ws {
        if auto_authorize {
            ensure_agent_place_authorized(agent_id, &display_name);
        }
        return ws_path.is_dir().then_some(ws_path);
    }

    if explicit_auto_authorize == Some(true) && !trimmed_root.is_empty() {
        let direct = PathBuf::from(trimmed_root);
        if direct.is_dir() {
            ensure_agent_place_authorized(agent_id, trimmed_root);
            return Some(direct);
        }
    }

    None
}

fn snapshot_json(agent_id: &str, index: &KnowledgeIndexFile) -> Value {
    let total_chunks = index.chunks.len();
    let manifest_preview = render_knowledge_manifest_at(&agents_root(), agent_id);
    json!({
        "agentId": agent_id,
        "packs": index.packs,
        "entries": index.entries,
        "totalChunks": total_chunks,
        "manifestPreview": manifest_preview,
    })
}

#[tauri::command]
pub fn list_agent_knowledge_packs(request: Value) -> Result<Value, AgentMindError> {
    let req = request_body(&request);
    let agent_id = req.get("agentId").and_then(Value::as_str).unwrap_or("");
    require_known_agent(agent_id)?;
    let index = load_knowledge_index_at(&agents_root(), agent_id);
    Ok(snapshot_json(agent_id, &index))
}

#[tauri::command]
pub fn save_agent_knowledge_pack(request: Value) -> Result<Value, AgentMindError> {
    let req = request_body(&request);
    let agent_id = req.get("agentId").and_then(Value::as_str).unwrap_or("");
    require_known_agent(agent_id)?;
    let id = req.get("id").and_then(Value::as_str);
    let name = req.get("name").and_then(Value::as_str).unwrap_or("");
    let raw_root = req.get("root").and_then(Value::as_str).unwrap_or("");
    let workspace_id = req
        .get("workspaceId")
        .or_else(|| req.get("workspace_id"))
        .and_then(Value::as_str);
    let explicit_auto = req
        .get("autoAuthorizePlace")
        .or_else(|| req.get("auto_authorize_place"))
        .and_then(Value::as_bool);
    let enabled = req.get("enabled").and_then(Value::as_bool).unwrap_or(true);
    let globs: Vec<String> = req
        .get("globs")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default();

    let matched_ws_path =
        resolve_and_auto_authorize_workspace(agent_id, workspace_id, raw_root, explicit_auto);
    let effective_root = if raw_root.trim().is_empty() {
        matched_ws_path
            .as_ref()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default()
    } else {
        raw_root.to_string()
    };
    let bound_ws = if explicit_auto == Some(false) {
        None
    } else {
        matched_ws_path.as_deref()
    };
    let allowed = resolve_agent_authorized_roots(Some(agent_id), bound_ws);
    let index = save_knowledge_pack_at(
        &agents_root(),
        agent_id,
        &allowed,
        id,
        name,
        &effective_root,
        globs,
        enabled,
    )?;
    sync_knowledge_packs_to_autonomy(agent_id, &index);
    Ok(snapshot_json(agent_id, &index))
}

#[tauri::command]
pub fn delete_agent_knowledge_pack(request: Value) -> Result<Value, AgentMindError> {
    let req = request_body(&request);
    let agent_id = req.get("agentId").and_then(Value::as_str).unwrap_or("");
    require_known_agent(agent_id)?;
    let pack_id = req.get("packId").and_then(Value::as_str).unwrap_or("");
    let index = delete_knowledge_pack_at(&agents_root(), agent_id, pack_id)?;
    sync_knowledge_packs_to_autonomy(agent_id, &index);
    Ok(snapshot_json(agent_id, &index))
}

#[tauri::command]
pub fn reindex_agent_knowledge_packs(request: Value) -> Result<Value, AgentMindError> {
    let req = request_body(&request);
    let agent_id = req.get("agentId").and_then(Value::as_str).unwrap_or("");
    require_known_agent(agent_id)?;
    let workspace_id = req
        .get("workspaceId")
        .or_else(|| req.get("workspace_id"))
        .and_then(Value::as_str);
    let explicit_auto = req
        .get("autoAuthorizePlace")
        .or_else(|| req.get("auto_authorize_place"))
        .and_then(Value::as_bool);

    let root_dir = agents_root();
    let existing = load_knowledge_index_at(&root_dir, agent_id);
    let mut bound_ws =
        resolve_and_auto_authorize_workspace(agent_id, workspace_id, "", explicit_auto);
    for pack in existing.packs.iter().filter(|p| p.enabled) {
        let matched =
            resolve_and_auto_authorize_workspace(agent_id, workspace_id, &pack.root, explicit_auto);
        if bound_ws.is_none() {
            bound_ws = matched;
        }
    }
    let effective_bound = if explicit_auto == Some(false) {
        None
    } else {
        bound_ws.as_deref()
    };
    let allowed = resolve_agent_authorized_roots(Some(agent_id), effective_bound);
    let index = reindex_knowledge_packs_at(&root_dir, agent_id, &allowed)?;
    sync_knowledge_packs_to_autonomy(agent_id, &index);
    Ok(snapshot_json(agent_id, &index))
}

#[tauri::command]
pub fn search_agent_knowledge_packs(request: Value) -> Result<Value, AgentMindError> {
    let req = request_body(&request);
    let agent_id = req.get("agentId").and_then(Value::as_str).unwrap_or("");
    require_known_agent(agent_id)?;
    let query = req.get("query").and_then(Value::as_str).unwrap_or("");
    let limit = req.get("limit").and_then(Value::as_u64).unwrap_or(8) as usize;
    Ok(search_knowledge_packs_at(&agents_root(), agent_id, query, limit))
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn save_and_reindex_knowledge_pack_auto_authorizes_registered_workspace_and_syncs_autonomy() {
        let ws_dir = std::env::temp_dir().join(format!("kite-kp-ws-{}", Uuid::new_v4()));
        std::fs::create_dir_all(ws_dir.join("docs")).unwrap();
        std::fs::write(ws_dir.join("docs").join("guide.md"), "# Guide\nClean docs.\n").unwrap();

        let ws_id = format!("ws-kp-{}", Uuid::new_v4().simple());
        let ws_name = format!("WorkspaceKP-{}", Uuid::new_v4().simple());
        let agent_id = Uuid::new_v4().to_string();

        {
            let mut wss = crate::persist::workspaces().lock().unwrap();
            wss.push(crate::persist::Workspace {
                id: ws_id.clone(),
                display_name: ws_name.clone(),
                created_at_unix_ms: 1_700_000_000_000,
                last_opened_at_unix_ms: 1_700_000_000_000,
                pinned: false,
                available: true,
            });
        }
        crate::persist::paths()
            .lock()
            .unwrap()
            .insert(ws_id.clone(), ws_dir.to_string_lossy().to_string());
        {
            let mut list = crate::persist::agents().lock().unwrap();
            list.push(crate::persist::AgentProfile {
                id: agent_id.clone(),
                name: "Knowledge Tester".into(),
                engine: "antigravity".into(),
                purpose: "Test KP".into(),
                brief: "Test KP".into(),
                avatar: None,
                created_at_unix_ms: 1_700_000_000_000,
                pinned: false,
                order: 99,
                memory_budget: None,
                reflection_mode: None,
                allow_agent_scheduling: None,
                allow_agent_messaging: None,
                default_mode: None,
                default_plan: None,
                default_model: None,
                default_provider_options: Vec::new(),
                place_display_names: Vec::new(),
                disabled_plugin_ids: Vec::new(),
            });
        }

        // Unregistered external directory with default autoAuthorizePlace must still be denied
        let outside_dir = std::env::temp_dir().join(format!("kite-kp-out-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&outside_dir).unwrap();
        let denied_err = save_agent_knowledge_pack(json!({
            "request": {
                "agentId": agent_id,
                "name": "Outside",
                "root": outside_dir.to_string_lossy(),
                "globs": ["**/*.md"]
            }
        }))
        .expect_err("unregistered random root must still require Places authorization");
        assert_eq!(denied_err.code, "knowledge_places_denied");

        // Registered workspace with autoAuthorizePlace: false stays denied
        let explicit_false_err = save_agent_knowledge_pack(json!({
            "request": {
                "agentId": agent_id,
                "name": "No Auto",
                "workspaceId": ws_id,
                "root": ws_dir.join("docs").to_string_lossy(),
                "autoAuthorizePlace": false,
                "globs": ["**/*.md"]
            }
        }))
        .expect_err("autoAuthorizePlace=false must keep knowledge_places_denied");
        assert_eq!(explicit_false_err.code, "knowledge_places_denied");

        // Registered workspace with default autoAuthorizePlace authorizes Place & syncs SQLite
        let snap = save_agent_knowledge_pack(json!({
            "request": {
                "agentId": agent_id,
                "name": "Docs Pack",
                "workspaceId": ws_id,
                "root": ws_dir.join("docs").to_string_lossy(),
                "globs": ["**/*.md"]
            }
        }))
        .expect("auto-authorized Place should allow saving Knowledge Pack");
        assert_eq!(snap["totalChunks"].as_u64(), Some(1));

        let places = crate::persist::agents()
            .lock()
            .unwrap()
            .iter()
            .find(|a| a.id == agent_id)
            .map(|a| a.place_display_names.clone())
            .unwrap_or_default();
        assert!(places.iter().any(|p| p == &ws_name));

        let autonomy = crate::agents::load_agent_autonomy_config(&agent_id);
        assert_eq!(autonomy.knowledge_packs.len(), 1);
        assert_eq!(autonomy.knowledge_packs[0].name, "Docs Pack");

        let reindexed = reindex_agent_knowledge_packs(json!({
            "request": { "agentId": agent_id, "workspaceId": ws_id }
        }))
        .expect("reindex should succeed");
        assert_eq!(reindexed["totalChunks"].as_u64(), Some(1));

        crate::persist::agents().lock().unwrap().retain(|a| a.id != agent_id);
        crate::persist::workspaces().lock().unwrap().retain(|w| w.id != ws_id);
        crate::persist::paths().lock().unwrap().remove(&ws_id);
        let _ = fs::remove_dir_all(&ws_dir);
        let _ = fs::remove_dir_all(&outside_dir);
        let _ = fs::remove_dir_all(agents_root().join(&agent_id));
    }
}
