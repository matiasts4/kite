use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PersistedTerminalSession {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
    pub base_engine: String,
    pub active_engine: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_session_id: Option<String>,
    pub cwd: String,
    #[serde(default)]
    pub had_user_activity: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_user_input: Option<String>,
    pub spawned_at_unix_ms: i64,
    pub saved_at_unix_ms: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedTerminalSessionsFile {
    #[serde(default)]
    pub sessions: HashMap<String, PersistedTerminalSession>,
}

fn persisted_sessions_file_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

pub fn terminal_sessions_file_path() -> PathBuf {
    crate::persist::roaming_app_dir().join("terminal-sessions.json")
}

fn read_persisted_terminal_sessions_unlocked() -> HashMap<String, PersistedTerminalSession> {
    let path = terminal_sessions_file_path();
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return HashMap::new();
    };
    if let Ok(parsed) = serde_json::from_str::<PersistedTerminalSessionsFile>(&raw) {
        return parsed.sessions;
    }
    serde_json::from_str::<HashMap<String, PersistedTerminalSession>>(&raw).unwrap_or_default()
}

fn write_persisted_terminal_sessions_unlocked(
    sessions: &HashMap<String, PersistedTerminalSession>,
) {
    let path = terminal_sessions_file_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let payload = PersistedTerminalSessionsFile {
        sessions: sessions.clone(),
    };
    if let Ok(json) = serde_json::to_string_pretty(&payload) {
        let unique_ext = format!("json.{}.tmp", uuid::Uuid::new_v4().simple());
        let tmp_path = path.with_extension(unique_ext);
        if std::fs::write(&tmp_path, &json).is_ok() {
            if std::fs::rename(&tmp_path, &path).is_err() {
                let _ = std::fs::write(&path, &json);
                let _ = std::fs::remove_file(&tmp_path);
            }
        } else {
            let _ = std::fs::write(&path, &json);
        }
    }
}

pub fn read_persisted_terminal_sessions() -> HashMap<String, PersistedTerminalSession> {
    let _guard = persisted_sessions_file_lock()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    read_persisted_terminal_sessions_unlocked()
}

pub fn write_persisted_terminal_sessions(sessions: &HashMap<String, PersistedTerminalSession>) {
    let _guard = persisted_sessions_file_lock()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    write_persisted_terminal_sessions_unlocked(sessions);
}

pub fn get_persisted_terminal_session(session_id: &str) -> Option<PersistedTerminalSession> {
    let _guard = persisted_sessions_file_lock()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    read_persisted_terminal_sessions_unlocked().remove(session_id)
}

pub fn upsert_persisted_terminal_session(record: PersistedTerminalSession) {
    let _guard = persisted_sessions_file_lock()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let mut map = read_persisted_terminal_sessions_unlocked();
    let merged = if let Some(prev) = map.get(&record.session_id) {
        PersistedTerminalSession {
            session_id: record.session_id,
            workspace_id: record.workspace_id.or_else(|| prev.workspace_id.clone()),
            pane_id: record.pane_id.or_else(|| prev.pane_id.clone()),
            base_engine: if record.base_engine.is_empty() {
                prev.base_engine.clone()
            } else {
                record.base_engine
            },
            active_engine: if record.active_engine.is_empty() {
                prev.active_engine.clone()
            } else {
                record.active_engine
            },
            provider_session_id: record
                .provider_session_id
                .or_else(|| prev.provider_session_id.clone()),
            cwd: if record.cwd.is_empty() {
                prev.cwd.clone()
            } else {
                record.cwd
            },
            had_user_activity: record.had_user_activity || prev.had_user_activity,
            last_user_input: record
                .last_user_input
                .or_else(|| prev.last_user_input.clone()),
            spawned_at_unix_ms: if record.spawned_at_unix_ms > 0 {
                record.spawned_at_unix_ms
            } else {
                prev.spawned_at_unix_ms
            },
            saved_at_unix_ms: record.saved_at_unix_ms,
        }
    } else {
        record
    };
    map.insert(merged.session_id.clone(), merged);
    write_persisted_terminal_sessions_unlocked(&map);
}

pub fn remove_persisted_terminal_session(session_id: &str) {
    let _guard = persisted_sessions_file_lock()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let mut map = read_persisted_terminal_sessions_unlocked();
    if map.remove(session_id).is_some() {
        write_persisted_terminal_sessions_unlocked(&map);
    }
}

pub fn is_generic_shell_engine(engine: &str) -> bool {
    matches!(
        engine.trim().to_ascii_lowercase().as_str(),
        "" | "powershell" | "pwsh" | "cmd" | "terminal" | "bash" | "zsh" | "sh"
    )
}

pub fn canonical_agent_engine(engine: &str) -> String {
    match engine.trim().to_ascii_lowercase().as_str() {
        "claude" | "claude-code" => "claude-code".to_string(),
        "codex" => "codex".to_string(),
        "agy" | "antigravity" => "antigravity".to_string(),
        "gentle-shell" | "gentleshell" | "gentle" | "gentle-pi" => "gentle-shell".to_string(),
        "opencode" | "open-code" => "open-code".to_string(),
        "gemini" => "gemini".to_string(),
        "cursor" | "cursor-agent" => "cursor".to_string(),
        "droid" => "droid".to_string(),
        "kimi" => "kimi".to_string(),
        "aider" => "aider".to_string(),
        "qwen" | "qwen-code" => "qwen-code".to_string(),
        other => other.to_string(),
    }
}

pub fn normalize_fs_path_for_compare(raw: &str) -> String {
    let trimmed = raw.trim().trim_matches('"');
    let without_verbatim = trimmed
        .strip_prefix(r"\\?\")
        .or_else(|| trimmed.strip_prefix("//?/"))
        .unwrap_or(trimmed);
    let unified = without_verbatim.replace('\\', "/");
    let trimmed_slash = unified.trim_end_matches('/');
    if cfg!(windows) {
        trimmed_slash.to_ascii_lowercase()
    } else {
        trimmed_slash.to_string()
    }
}

pub fn path_to_file_uri_normalized(raw: &str) -> String {
    let norm = normalize_fs_path_for_compare(raw);
    if norm.starts_with("file://") {
        return norm.trim_end_matches('/').to_string();
    }
    if norm.starts_with('/') {
        format!("file://{}", norm)
    } else {
        format!("file:///{}", norm)
    }
}

pub fn paths_match(a: &str, b: &str) -> bool {
    let na = normalize_fs_path_for_compare(a);
    let nb = normalize_fs_path_for_compare(b);
    !na.is_empty() && na == nb
}

fn user_home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
}

pub fn normalize_terminal_text(raw: &[u8]) -> String {
    let text = String::from_utf8_lossy(raw);
    let mut out = String::with_capacity(text.len());
    let mut in_escape = false;
    let mut in_osc = false;
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if in_osc {
            if ch == '\x07' {
                in_osc = false;
            } else if ch == '\x1b' && chars.peek() == Some(&'\\') {
                let _ = chars.next();
                in_osc = false;
            }
            continue;
        }
        if ch == '\x1b' {
            if chars.peek() == Some(&']') {
                let _ = chars.next();
                in_osc = true;
            } else {
                in_escape = true;
            }
            continue;
        }
        if in_escape {
            if ch.is_ascii_alphabetic() || ch == '~' || ch == '@' {
                in_escape = false;
            }
            continue;
        }
        if ch.is_whitespace() {
            if !out.ends_with(' ') {
                out.push(' ');
            }
        } else {
            for lower in ch.to_lowercase() {
                out.push(lower);
            }
        }
    }
    out
}

/// Extracts distinctive multi-word phrase windows (~28 chars, at least 3 words) from normalized text.
fn extract_phrase_windows(norm_text: &str, max_windows: usize) -> Vec<String> {
    let trimmed = norm_text.trim();
    if trimmed.len() < 16 {
        return Vec::new();
    }
    let words: Vec<&str> = trimmed.split_whitespace().collect();
    if words.len() < 3 {
        return Vec::new();
    }
    let mut windows = Vec::new();
    let mut i = 0;
    while i + 2 < words.len() && windows.len() < max_windows {
        let mut phrase = String::new();
        let mut word_count = 0;
        let mut j = i;
        while j < words.len() && phrase.len() < 28 {
            if !phrase.is_empty() {
                phrase.push(' ');
            }
            phrase.push_str(words[j]);
            word_count += 1;
            j += 1;
        }
        if phrase.len() >= 16 && word_count >= 3 {
            windows.push(phrase);
        }
        i += 3;
    }
    windows
}

fn extract_user_request_block(text: &str) -> &str {
    if let Some(start) = text.find("<USER_REQUEST>") {
        let after = &text[start + "<USER_REQUEST>".len()..];
        if let Some(end) = after.find("</USER_REQUEST>") {
            return after[..end].trim();
        }
        return after.trim();
    }
    text.trim()
}

/// Resolves the provider-specific conversation/session ID for a given agent engine and CWD.
pub fn resolve_provider_session_id(
    engine: &str,
    cwd: &str,
    terminal_session_id: &str,
    existing_provider_id: Option<&str>,
    spawned_at_unix_ms: i64,
    claimed_ids: &HashSet<String>,
) -> Option<String> {
    resolve_provider_session_id_with_context(
        engine,
        cwd,
        terminal_session_id,
        existing_provider_id,
        spawned_at_unix_ms,
        claimed_ids,
        None,
        None,
    )
}

/// Resolves the provider-specific conversation/session ID using live process tree locks,
/// terminal scrollback, and recent user input context.
pub fn resolve_provider_session_id_with_context(
    engine: &str,
    cwd: &str,
    terminal_session_id: &str,
    existing_provider_id: Option<&str>,
    spawned_at_unix_ms: i64,
    claimed_ids: &HashSet<String>,
    root_pid: Option<u32>,
    last_user_input: Option<&str>,
) -> Option<String> {
    let canonical = canonical_agent_engine(engine);
    let valid_existing = existing_provider_id
        .map(str::trim)
        .filter(|id| !id.is_empty() && !claimed_ids.contains(*id));

    match canonical.as_str() {
        "antigravity" => resolve_antigravity_session_id(
            cwd,
            terminal_session_id,
            valid_existing,
            spawned_at_unix_ms,
            claimed_ids,
            root_pid,
            last_user_input,
        ),
        "codex" => {
            if let Some(existing) = valid_existing {
                return Some(existing.to_string());
            }
            resolve_codex_session_id(
                cwd,
                terminal_session_id,
                spawned_at_unix_ms,
                claimed_ids,
                last_user_input,
            )
        }
        "open-code" => {
            if let Some(existing) = valid_existing {
                return Some(existing.to_string());
            }
            resolve_opencode_session_id(
                cwd,
                terminal_session_id,
                spawned_at_unix_ms,
                claimed_ids,
                last_user_input,
            )
        }
        "claude-code" => resolve_claude_session_id(
            cwd,
            terminal_session_id,
            valid_existing,
            spawned_at_unix_ms,
            claimed_ids,
            last_user_input,
        ),
        "gemini" => resolve_gemini_session_id(
            cwd,
            terminal_session_id,
            valid_existing,
            spawned_at_unix_ms,
            claimed_ids,
        ),
        _ => valid_existing.map(|s| s.to_string()),
    }
}

fn resolve_antigravity_session_id(
    cwd: &str,
    terminal_session_id: &str,
    existing_provider_id: Option<&str>,
    spawned_at_unix_ms: i64,
    claimed_ids: &HashSet<String>,
    root_pid: Option<u32>,
    last_user_input: Option<&str>,
) -> Option<String> {
    // 1. Live OS Process Lock matching: if this terminal has a live process tree,
    // check if a child agy.exe holds an active byte-range lock on ~/.gemini/antigravity-cli/presence/<conv_id>.lock.
    let mut tree_pids = HashSet::new();
    let locked_conversations = get_all_locked_antigravity_conversations();
    if let Some(pid) = root_pid.filter(|&p| p > 0) {
        tree_pids = collect_process_tree_pids(pid);
        if !tree_pids.is_empty() {
            for (conv_id, holder_pids) in &locked_conversations {
                if !claimed_ids.contains(conv_id)
                    && holder_pids.iter().any(|hp| tree_pids.contains(hp))
                {
                    return Some(conv_id.clone());
                }
            }
        }
    }

    // 2. If an unclaimed existing_provider_id was provided, keep it as long as it is not actively
    // locked by a DIFFERENT live process tree.
    if let Some(existing) = existing_provider_id {
        let locked_by_foreign_process = if let Some(holder_pids) = locked_conversations.get(existing)
        {
            !holder_pids.is_empty()
                && !tree_pids.is_empty()
                && !holder_pids.iter().any(|hp| tree_pids.contains(hp))
        } else {
            false
        };
        if !locked_by_foreign_process {
            return Some(existing.to_string());
        }
    }

    let home = user_home_dir()?;
    let agy_dir = home.join(".gemini").join("antigravity-cli");
    if !agy_dir.is_dir() {
        return None;
    }

    let is_locked_by_other = |conv_id: &str| -> bool {
        if let Some(holder_pids) = locked_conversations.get(conv_id) {
            if holder_pids.is_empty() {
                return false;
            }
            if tree_pids.is_empty() {
                return false;
            }
            !holder_pids.iter().any(|hp| tree_pids.contains(hp))
        } else {
            false
        }
    };

    // Gather candidate conversations matching `cwd` from conversation_summaries.db and history.jsonl
    let mut workspace_candidates: HashSet<String> = HashSet::new();
    let mut summary_meta: HashMap<String, (String, String)> = HashMap::new();

    let db_path = agy_dir.join("conversation_summaries.db");
    if db_path.is_file() {
        if let Ok(conn) = rusqlite::Connection::open_with_flags(
            &db_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        ) {
            let _ = conn.busy_timeout(std::time::Duration::from_millis(150));
            let target_uri = path_to_file_uri_normalized(cwd);
            if let Ok(mut stmt) = conn.prepare(
                "SELECT conversation_id, workspace_uris, title, preview
                 FROM conversation_summaries
                 WHERE nesting_depth = 0 AND (parent_conversation_id IS NULL OR parent_conversation_id = '')
                 ORDER BY last_modified_time DESC
                 LIMIT 80",
            ) {
                if let Ok(rows) = stmt.query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1).unwrap_or_default(),
                        row.get::<_, String>(2).unwrap_or_default(),
                        row.get::<_, String>(3).unwrap_or_default(),
                    ))
                }) {
                    for row in rows.flatten() {
                        let (conv_id, uris_raw, title, preview) = row;
                        if conv_id.is_empty()
                            || claimed_ids.contains(&conv_id)
                            || is_locked_by_other(&conv_id)
                        {
                            continue;
                        }
                        let uri_matched = serde_json::from_str::<Vec<String>>(&uris_raw)
                            .ok()
                            .map(|list| {
                                list.iter().any(|u| {
                                    u.trim_end_matches('/').eq_ignore_ascii_case(&target_uri)
                                })
                            })
                            .unwrap_or_else(|| {
                                uris_raw.to_ascii_lowercase().contains(&target_uri)
                            });
                        if uri_matched {
                            workspace_candidates.insert(conv_id.clone());
                            summary_meta.insert(conv_id, (title, preview));
                        }
                    }
                }
            }
        }
    }

    let history_path = agy_dir.join("history.jsonl");
    let history_content = std::fs::read_to_string(&history_path).ok();
    if let Some(ref content) = history_content {
        for line in content.lines().rev().take(600) {
            let Ok(val) = serde_json::from_str::<serde_json::Value>(line) else {
                continue;
            };
            let Some(conv_id) = val.get("conversationId").and_then(|v| v.as_str()) else {
                continue;
            };
            if conv_id.is_empty() || claimed_ids.contains(conv_id) || is_locked_by_other(conv_id) {
                continue;
            }
            let ws = val.get("workspace").and_then(|v| v.as_str()).unwrap_or("");
            if paths_match(ws, cwd) {
                workspace_candidates.insert(conv_id.to_string());
            }
        }
    }

    // 3. Score against terminal scrollback & last_user_input using multi-word phrase windows
    let sb_bytes = crate::terminal::read_scrollback_file(terminal_session_id);
    let norm_user_input = last_user_input
        .map(|s| normalize_terminal_text(s.as_bytes()))
        .filter(|s| s.trim().len() >= 8);

    if sb_bytes.is_some() || norm_user_input.is_some() {
        let raw_bytes = sb_bytes.unwrap_or_default();
        let norm_sb = normalize_terminal_text(&raw_bytes);
        let tail_start = raw_bytes.len().saturating_sub(64 * 1024);
        let norm_sb_tail = normalize_terminal_text(&raw_bytes[tail_start..]);

        if norm_sb.len() >= 25 || norm_user_input.is_some() {
            let mut scores: HashMap<String, u32> = HashMap::new();

            // A. Match against workspace candidate transcripts in brain/<conv_id>/.system_generated/logs/transcript.jsonl
            let brain_dir = agy_dir.join("brain");
            let mut brain_candidates: Vec<String> = workspace_candidates.iter().cloned().collect();

            // If workspace candidates are empty, look at at most 5 recently modified candidates
            if brain_candidates.is_empty() {
                if let Ok(entries) = std::fs::read_dir(&brain_dir) {
                    let mut recent: Vec<(u128, String)> = Vec::new();
                    for entry in entries.flatten() {
                        if let Some(conv_id) = entry.file_name().to_str().map(str::to_string) {
                            if !conv_id.is_empty()
                                && !claimed_ids.contains(&conv_id)
                                && !is_locked_by_other(&conv_id)
                            {
                                let tpath = brain_dir
                                    .join(&conv_id)
                                    .join(".system_generated")
                                    .join("logs")
                                    .join("transcript.jsonl");
                                if let Ok(meta) = std::fs::metadata(&tpath) {
                                    let mtime = meta
                                        .modified()
                                        .ok()
                                        .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
                                        .map(|d| d.as_millis())
                                        .unwrap_or(0);
                                    recent.push((mtime, conv_id));
                                }
                            }
                        }
                    }
                    recent.sort_by(|a, b| b.0.cmp(&a.0));
                    for (_, cid) in recent.into_iter().take(5) {
                        brain_candidates.push(cid);
                    }
                }
            }

            let min_mtime_ms = if spawned_at_unix_ms > 0 {
                spawned_at_unix_ms.saturating_sub(60_000) as u128
            } else {
                0
            };

            for conv_id in &brain_candidates {
                let transcript_path = brain_dir
                    .join(conv_id)
                    .join(".system_generated")
                    .join("logs")
                    .join("transcript.jsonl");
                let Ok(meta) = std::fs::metadata(&transcript_path) else {
                    continue;
                };
                let mod_ms = meta
                    .modified()
                    .ok()
                    .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis())
                    .unwrap_or(0);

                // Never read transcripts older than terminal spawn time
                if min_mtime_ms > 0 && mod_ms < min_mtime_ms {
                    continue;
                }
                // Cap single transcript read to 4MB to prevent memory exhaustion
                if meta.len() > 4 * 1024 * 1024 {
                    continue;
                }

                let recency_mult: u32 = if min_mtime_ms > 0 && mod_ms >= min_mtime_ms {
                    2
                } else {
                    1
                };
                let ws_bonus: u32 = if workspace_candidates.contains(conv_id) {
                    20
                } else {
                    0
                };

                let Ok(raw_transcript) = std::fs::read_to_string(&transcript_path) else {
                    continue;
                };
                let lines: Vec<&str> = raw_transcript.lines().collect();
                let mut conv_hits: u32 = 0;

                for (idx, line) in lines.iter().enumerate() {
                    // Inspect all USER_INPUT lines and the last 25 lines of the transcript
                    if !line.contains("\"USER_INPUT\"")
                        && !line.contains("\"PLANNER_RESPONSE\"")
                        && idx + 25 < lines.len()
                    {
                        continue;
                    }
                    let Ok(val) = serde_json::from_str::<serde_json::Value>(line) else {
                        continue;
                    };
                    let step_type = val.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    let content = val.get("content").and_then(|v| v.as_str()).unwrap_or("");
                    if content.is_empty() {
                        continue;
                    }

                    if step_type == "USER_INPUT" {
                        let req_text = extract_user_request_block(content);
                        let norm_req = normalize_terminal_text(req_text.as_bytes());
                        if let Some(ref ui) = norm_user_input {
                            let ui_trimmed = ui.trim();
                            if ui_trimmed.len() >= 10 && norm_req.contains(ui_trimmed) {
                                conv_hits += 120 * recency_mult;
                            }
                        }
                        for win in extract_phrase_windows(&norm_req, 8) {
                            if norm_sb_tail.contains(&win) {
                                conv_hits += 45 * recency_mult;
                            } else if norm_sb.contains(&win) {
                                conv_hits += 15 * recency_mult;
                            }
                        }
                    } else if step_type == "PLANNER_RESPONSE" && idx + 30 >= lines.len() {
                        let norm_resp = normalize_terminal_text(content.as_bytes());
                        for win in extract_phrase_windows(&norm_resp, 6) {
                            if norm_sb_tail.contains(&win) {
                                conv_hits += 35 * recency_mult;
                            } else if norm_sb.contains(&win) {
                                conv_hits += 12 * recency_mult;
                            }
                        }
                    }
                }

                if conv_hits > 0 {
                    *scores.entry(conv_id.clone()).or_default() += conv_hits + ws_bonus;
                }
            }

            // B. Score matching multi-word prompts from history.jsonl (no single-word noise!)
            if let Some(ref content) = history_content {
                for line in content.lines().rev().take(600) {
                    let Ok(val) = serde_json::from_str::<serde_json::Value>(line) else {
                        continue;
                    };
                    let Some(conv_id) = val.get("conversationId").and_then(|v| v.as_str()) else {
                        continue;
                    };
                    if conv_id.is_empty()
                        || claimed_ids.contains(conv_id)
                        || is_locked_by_other(conv_id)
                    {
                        continue;
                    }
                    let ws = val.get("workspace").and_then(|v| v.as_str()).unwrap_or("");
                    if !paths_match(ws, cwd) {
                        continue;
                    }
                    let disp = val
                        .get("display")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .trim();
                    if disp.len() >= 16 && !disp.starts_with('/') {
                        let norm_disp = normalize_terminal_text(disp.as_bytes());
                        for win in extract_phrase_windows(&norm_disp, 4) {
                            if norm_sb_tail.contains(&win) {
                                *scores.entry(conv_id.to_string()).or_default() += 50;
                            } else if norm_sb.contains(&win) {
                                *scores.entry(conv_id.to_string()).or_default() += 20;
                            }
                        }
                    }
                }
            }

            // C. Score matching titles & previews from conversation_summaries.db
            for (conv_id, (title, preview)) in &summary_meta {
                let norm_title = normalize_terminal_text(title.as_bytes());
                let title_trimmed = norm_title.trim();
                if title_trimmed.len() >= 14
                    && title_trimmed.split_whitespace().count() >= 3
                    && norm_sb.contains(title_trimmed)
                {
                    *scores.entry(conv_id.clone()).or_default() += 50;
                }
                let norm_preview = normalize_terminal_text(preview.as_bytes());
                for win in extract_phrase_windows(&norm_preview, 4) {
                    if norm_sb_tail.contains(&win) {
                        *scores.entry(conv_id.clone()).or_default() += 40;
                    } else if norm_sb.contains(&win) {
                        *scores.entry(conv_id.clone()).or_default() += 15;
                    }
                }
            }

            if let Some((best_id, score)) = scores.into_iter().max_by_key(|(_, s)| *s) {
                if score >= 30 {
                    return Some(best_id);
                }
            }
        }
    }

    None
}

fn resolve_codex_session_id(
    cwd: &str,
    terminal_session_id: &str,
    spawned_at_unix_ms: i64,
    claimed_ids: &HashSet<String>,
    last_user_input: Option<&str>,
) -> Option<String> {
    let home = user_home_dir()?;
    let codex_dir = home.join(".codex");
    let db_path = codex_dir.join("state_5.sqlite");
    if !db_path.is_file() {
        return None;
    }
    let conn = rusqlite::Connection::open_with_flags(
        &db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    let _ = conn.busy_timeout(std::time::Duration::from_millis(150));

    let norm_sb = crate::terminal::read_scrollback_file(terminal_session_id)
        .map(|b| normalize_terminal_text(&b))
        .unwrap_or_default();
    let norm_input = last_user_input
        .map(|s| normalize_terminal_text(s.as_bytes()))
        .unwrap_or_default();

    let min_sec = (spawned_at_unix_ms / 1000).saturating_sub(30);
    if let Ok(mut stmt) = conn.prepare(
        "SELECT id, cwd, updated_at, title, first_user_message
         FROM threads
         WHERE archived = 0
         ORDER BY updated_at DESC
         LIMIT 50",
    ) {
        if let Ok(rows) = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1).unwrap_or_default(),
                row.get::<_, i64>(2).unwrap_or(0),
                row.get::<_, String>(3).unwrap_or_default(),
                row.get::<_, String>(4).unwrap_or_default(),
            ))
        }) {
            let mut candidates = Vec::new();
            for row in rows.flatten() {
                let (id, row_cwd, updated_at, title, first_msg) = row;
                if id.is_empty() || claimed_ids.contains(&id) || !paths_match(&row_cwd, cwd) {
                    continue;
                }
                if !norm_sb.is_empty() && norm_sb.contains(&id.to_ascii_lowercase()) {
                    return Some(id);
                }
                let mut score: u32 = 0;
                for text in [&title, &first_msg] {
                    let norm_t = normalize_terminal_text(text.as_bytes());
                    let trimmed = norm_t.trim();
                    if trimmed.len() >= 12 {
                        let snip = if trimmed.len() > 28 {
                            &trimmed[..28]
                        } else {
                            trimmed
                        };
                        if !norm_sb.is_empty() && norm_sb.contains(snip) {
                            score += 50;
                        }
                        if !norm_input.is_empty() && norm_input.contains(snip) {
                            score += 60;
                        }
                    }
                }
                let updated_sec = if updated_at > 1_000_000_000_000 {
                    updated_at / 1000
                } else {
                    updated_at
                };
                candidates.push((id, updated_sec, score));
            }

            if let Some((best_id, _, best_score)) =
                candidates.iter().max_by_key(|(_, _, score)| *score)
            {
                if *best_score >= 40 {
                    return Some(best_id.clone());
                }
            }

            if spawned_at_unix_ms > 0 {
                let recent: Vec<&(String, i64, u32)> = candidates
                    .iter()
                    .filter(|(_, sec, _)| *sec == 0 || *sec >= min_sec)
                    .collect();
                if recent.len() == 1 {
                    return Some(recent[0].0.clone());
                }
            }
        }
    }
    None
}

fn resolve_opencode_session_id(
    cwd: &str,
    terminal_session_id: &str,
    spawned_at_unix_ms: i64,
    claimed_ids: &HashSet<String>,
    last_user_input: Option<&str>,
) -> Option<String> {
    let home = user_home_dir()?;
    let db_path = home
        .join(".local")
        .join("share")
        .join("opencode")
        .join("opencode.db");
    if !db_path.is_file() {
        return None;
    }
    let conn = rusqlite::Connection::open_with_flags(
        &db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    let _ = conn.busy_timeout(std::time::Duration::from_millis(150));

    let norm_sb = crate::terminal::read_scrollback_file(terminal_session_id)
        .map(|b| normalize_terminal_text(&b))
        .unwrap_or_default();
    let norm_input = last_user_input
        .map(|s| normalize_terminal_text(s.as_bytes()))
        .unwrap_or_default();

    let min_ms = spawned_at_unix_ms.saturating_sub(30_000);
    for table in ["session_v2", "session"] {
        let query = format!(
            "SELECT id, directory, time_updated, title FROM {} WHERE parent_id IS NULL ORDER BY time_updated DESC LIMIT 50",
            table
        );
        if let Ok(mut stmt) = conn.prepare(&query) {
            if let Ok(rows) = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1).unwrap_or_default(),
                    row.get::<_, i64>(2).unwrap_or(0),
                    row.get::<_, String>(3).unwrap_or_default(),
                ))
            }) {
                let mut candidates = Vec::new();
                for row in rows.flatten() {
                    let (id, dir, time_updated, title) = row;
                    if id.is_empty() || claimed_ids.contains(&id) || !paths_match(&dir, cwd) {
                        continue;
                    }
                    if !norm_sb.is_empty() && norm_sb.contains(&id.to_ascii_lowercase()) {
                        return Some(id);
                    }
                    let mut score: u32 = 0;
                    let norm_t = normalize_terminal_text(title.as_bytes());
                    let trimmed = norm_t.trim();
                    if trimmed.len() >= 10 {
                        let snip = if trimmed.len() > 28 {
                            &trimmed[..28]
                        } else {
                            trimmed
                        };
                        if !norm_sb.is_empty() && norm_sb.contains(snip) {
                            score += 50;
                        }
                        if !norm_input.is_empty() && norm_input.contains(snip) {
                            score += 60;
                        }
                    }
                    let ts_ms = if time_updated > 0 && time_updated < 1_000_000_000_000 {
                        time_updated * 1000
                    } else {
                        time_updated
                    };
                    candidates.push((id, ts_ms, score));
                }

                if let Some((best_id, _, best_score)) =
                    candidates.iter().max_by_key(|(_, _, score)| *score)
                {
                    if *best_score >= 40 {
                        return Some(best_id.clone());
                    }
                }

                if spawned_at_unix_ms > 0 {
                    let recent: Vec<&(String, i64, u32)> = candidates
                        .iter()
                        .filter(|(_, ts, _)| *ts == 0 || *ts >= min_ms)
                        .collect();
                    if recent.len() == 1 {
                        return Some(recent[0].0.clone());
                    }
                }
            }
        }
    }
    None
}

pub fn claude_project_slug(cwd: &str) -> String {
    let trimmed = cwd.trim().trim_matches('"');
    let without_verbatim = trimmed
        .strip_prefix(r"\\?\")
        .or_else(|| trimmed.strip_prefix("//?/"))
        .unwrap_or(trimmed);
    let mut out = String::with_capacity(without_verbatim.len());
    for ch in without_verbatim.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' {
            out.push(ch);
        } else {
            out.push('-');
        }
    }
    out
}

pub fn claude_session_file_exists(cwd: &str, session_uuid: &str) -> bool {
    let Some(home) = user_home_dir() else {
        return false;
    };
    let projects_dir = home.join(".claude").join("projects");
    if !projects_dir.is_dir() {
        return false;
    }
    let slug = claude_project_slug(cwd);
    let direct = projects_dir
        .join(&slug)
        .join(format!("{}.jsonl", session_uuid));
    if direct.is_file() {
        return true;
    }
    if let Ok(entries) = std::fs::read_dir(&projects_dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir()
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n.eq_ignore_ascii_case(&slug))
                    .unwrap_or(false)
            {
                if p.join(format!("{}.jsonl", session_uuid)).is_file() {
                    return true;
                }
            }
        }
    }
    false
}

fn resolve_claude_session_id(
    cwd: &str,
    terminal_session_id: &str,
    existing_provider_id: Option<&str>,
    spawned_at_unix_ms: i64,
    claimed_ids: &HashSet<String>,
    last_user_input: Option<&str>,
) -> Option<String> {
    if let Some(existing) = existing_provider_id {
        if claude_session_file_exists(cwd, existing) {
            return Some(existing.to_string());
        }
    }
    if uuid::Uuid::parse_str(terminal_session_id).is_ok()
        && !claimed_ids.contains(terminal_session_id)
        && claude_session_file_exists(cwd, terminal_session_id)
    {
        return Some(terminal_session_id.to_string());
    }
    let home = user_home_dir()?;
    let projects_dir = home.join(".claude").join("projects");
    let slug = claude_project_slug(cwd);
    let mut candidate_dirs = Vec::new();
    let exact_dir = projects_dir.join(&slug);
    if exact_dir.is_dir() {
        candidate_dirs.push(exact_dir);
    } else if let Ok(entries) = std::fs::read_dir(&projects_dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir()
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n.eq_ignore_ascii_case(&slug))
                    .unwrap_or(false)
            {
                candidate_dirs.push(p);
            }
        }
    }

    let norm_sb = crate::terminal::read_scrollback_file(terminal_session_id)
        .map(|b| normalize_terminal_text(&b))
        .unwrap_or_default();
    let norm_input = last_user_input
        .map(|s| normalize_terminal_text(s.as_bytes()))
        .unwrap_or_default();

    let min_ms = spawned_at_unix_ms.saturating_sub(30_000) as u128;
    let mut scored: Vec<(u32, u128, String)> = Vec::new();

    for dir in candidate_dirs {
        let Ok(files) = std::fs::read_dir(&dir) else {
            continue;
        };
        for file in files.flatten() {
            let path = file.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            if claimed_ids.contains(stem) {
                continue;
            }
            let Ok(meta) = file.metadata() else {
                continue;
            };
            let mod_ms = meta
                .modified()
                .ok()
                .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis())
                .unwrap_or(0);

            let mut score: u32 = 0;
            if (!norm_sb.is_empty() || !norm_input.is_empty())
                && meta.len() <= 8 * 1024 * 1024
            {
                if let Ok(raw) = std::fs::read_to_string(&path) {
                    let norm_file = normalize_terminal_text(raw.as_bytes());
                    for win in extract_phrase_windows(&norm_file, 10) {
                        if !norm_sb.is_empty() && norm_sb.contains(&win) {
                            score += 30;
                        }
                        if !norm_input.is_empty() && norm_input.contains(&win) {
                            score += 45;
                        }
                    }
                }
            }
            if score > 0 || mod_ms >= min_ms {
                scored.push((score, mod_ms, stem.to_string()));
            }
        }
    }

    if let Some((best_score, _, best_id)) = scored.iter().max_by_key(|(s, m, _)| (*s, *m)) {
        if *best_score >= 30 {
            return Some(best_id.clone());
        }
    }
    if spawned_at_unix_ms > 0 && scored.len() == 1 {
        return Some(scored[0].2.clone());
    }
    None
}

fn resolve_gemini_session_id(
    _cwd: &str,
    terminal_session_id: &str,
    existing_provider_id: Option<&str>,
    spawned_at_unix_ms: i64,
    claimed_ids: &HashSet<String>,
) -> Option<String> {
    if let Some(existing) = existing_provider_id {
        if std::path::Path::new(existing).is_file() {
            return Some(existing.to_string());
        }
    }
    let home = user_home_dir()?;
    let tmp_dir = home.join(".gemini").join("tmp");
    if !tmp_dir.is_dir() {
        return existing_provider_id.map(|s| s.to_string());
    }
    let min_ms = spawned_at_unix_ms.saturating_sub(30_000) as u128;
    let mut candidates: Vec<(u128, String)> = Vec::new();

    if let Ok(buckets) = std::fs::read_dir(&tmp_dir) {
        for bucket in buckets.flatten() {
            let chats_dir = bucket.path().join("chats");
            if !chats_dir.is_dir() {
                continue;
            }
            let Ok(files) = std::fs::read_dir(&chats_dir) else {
                continue;
            };
            for file in files.flatten() {
                let path = file.path();
                if path.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue;
                }
                let Ok(meta) = file.metadata() else {
                    continue;
                };
                let mod_ms = meta
                    .modified()
                    .ok()
                    .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis())
                    .unwrap_or(0);
                if mod_ms < min_ms {
                    continue;
                }
                let path_str = path.to_string_lossy().to_string();
                if claimed_ids.contains(&path_str) {
                    continue;
                }
                if let Ok(raw) = std::fs::read_to_string(&path) {
                    if let Some(existing) = existing_provider_id {
                        if raw.contains(existing) {
                            return Some(path_str);
                        }
                    }
                    if raw.contains(terminal_session_id) {
                        return Some(path_str);
                    }
                }
                candidates.push((mod_ms, path_str));
            }
        }
    }
    if spawned_at_unix_ms > 0 && candidates.len() == 1 {
        return Some(candidates[0].1.clone());
    }
    existing_provider_id.map(|s| s.to_string())
}

pub fn map_executable_name_to_agent_engine(exe_name: &str) -> Option<String> {
    let lower = Path::new(exe_name)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(exe_name)
        .trim()
        .to_ascii_lowercase();
    let stem = lower.strip_suffix(".exe").unwrap_or(&lower);
    let stem = stem.strip_suffix(".cmd").unwrap_or(stem);
    match stem {
        "agy" | "antigravity" => Some("antigravity".to_string()),
        "gentle-shell" | "gentleshell" | "gentle" | "gentle-pi" | "pi" => Some("gentle-shell".to_string()),
        "claude" | "claude-code" => Some("claude-code".to_string()),
        "codex" => Some("codex".to_string()),
        "gemini" => Some("gemini".to_string()),
        "opencode" | "open-code" => Some("open-code".to_string()),
        "cursor-agent" => Some("cursor".to_string()),
        "droid" => Some("droid".to_string()),
        "kimi" => Some("kimi".to_string()),
        "aider" => Some("aider".to_string()),
        "qwen" | "qwen-code" => Some("qwen-code".to_string()),
        _ => None,
    }
}

/// Collects all process IDs in the OS process tree rooted at `root_pid` (including `root_pid`).
#[cfg(windows)]
pub fn collect_process_tree_pids(root_pid: u32) -> HashSet<u32> {
    let mut visited = HashSet::new();
    if root_pid == 0 {
        return visited;
    }

    const TH32CS_SNAPPROCESS: u32 = 0x00000002;
    const INVALID_HANDLE_VALUE: isize = -1;

    #[repr(C)]
    struct PROCESSENTRY32W {
        dw_size: u32,
        cnt_usage: u32,
        th32_process_id: u32,
        th32_default_heap_id: usize,
        th32_module_id: u32,
        cnt_threads: u32,
        th32_parent_process_id: u32,
        pc_pri_class_base: i32,
        dw_flags: u32,
        sz_exe_file: [u16; 260],
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateToolhelp32Snapshot(dw_flags: u32, th32_process_id: u32) -> isize;
        fn Process32FirstW(h_snapshot: isize, lppe: *mut PROCESSENTRY32W) -> i32;
        fn Process32NextW(h_snapshot: isize, lppe: *mut PROCESSENTRY32W) -> i32;
        fn CloseHandle(h_object: isize) -> i32;
    }

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE || snapshot == 0 {
        return visited;
    }

    let mut children_map: HashMap<u32, Vec<u32>> = HashMap::new();
    let mut entry = PROCESSENTRY32W {
        dw_size: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        cnt_usage: 0,
        th32_process_id: 0,
        th32_default_heap_id: 0,
        th32_module_id: 0,
        cnt_threads: 0,
        th32_parent_process_id: 0,
        pc_pri_class_base: 0,
        dw_flags: 0,
        sz_exe_file: [0; 260],
    };

    unsafe {
        if Process32FirstW(snapshot, &mut entry) != 0 {
            loop {
                children_map
                    .entry(entry.th32_parent_process_id)
                    .or_default()
                    .push(entry.th32_process_id);
                if Process32NextW(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
    }

    let mut queue = std::collections::VecDeque::new();
    queue.push_back(root_pid);
    visited.insert(root_pid);

    while let Some(pid) = queue.pop_front() {
        if let Some(children) = children_map.get(&pid) {
            for &child_pid in children {
                if visited.insert(child_pid) {
                    queue.push_back(child_pid);
                }
            }
        }
    }

    visited
}

#[cfg(not(windows))]
pub fn collect_process_tree_pids(root_pid: u32) -> HashSet<u32> {
    let mut set = HashSet::new();
    if root_pid > 0 {
        set.insert(root_pid);
    }
    set
}

/// Scans `~/.gemini/antigravity-cli/presence/*.lock` and detects which conversations currently
/// have an active byte-range lock held by an Antigravity process, without invoking blocking system APIs.
#[cfg(windows)]
pub fn get_all_locked_antigravity_conversations() -> HashMap<String, Vec<u32>> {
    let mut map = HashMap::new();
    let Some(home) = user_home_dir() else {
        return map;
    };
    let presence_dir = home
        .join(".gemini")
        .join("antigravity-cli")
        .join("presence");
    let Ok(entries) = std::fs::read_dir(&presence_dir) else {
        return map;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("lock") {
            continue;
        }
        let Some(conv_id) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let Ok(mut file) = std::fs::File::open(&path) else {
            continue;
        };
        let mut buf = [0u8; 1];
        // Antigravity CLI holds an exclusive LockFileEx on byte 0 while running;
        // reading 1 byte fails with ERROR_LOCK_VIOLATION (33) if and only if an agy process holds the lock.
        if file.read(&mut buf).is_err() {
            map.insert(conv_id.to_string(), Vec::new());
        }
    }
    map
}

#[cfg(not(windows))]
pub fn get_all_locked_antigravity_conversations() -> HashMap<String, Vec<u32>> {
    HashMap::new()
}

/// Inspects the OS process tree rooted at `root_pid` and returns the canonical agent engine
/// if the user manually invoked an AI CLI inside a generic shell (e.g., PowerShell -> agy.exe).
#[cfg(windows)]
pub fn detect_child_agent_in_shell(root_pid: u32) -> Option<String> {
    if root_pid == 0 {
        return None;
    }

    const TH32CS_SNAPPROCESS: u32 = 0x00000002;
    const INVALID_HANDLE_VALUE: isize = -1;

    #[repr(C)]
    struct PROCESSENTRY32W {
        dw_size: u32,
        cnt_usage: u32,
        th32_process_id: u32,
        th32_default_heap_id: usize,
        th32_module_id: u32,
        cnt_threads: u32,
        th32_parent_process_id: u32,
        pc_pri_class_base: i32,
        dw_flags: u32,
        sz_exe_file: [u16; 260],
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateToolhelp32Snapshot(dw_flags: u32, th32_process_id: u32) -> isize;
        fn Process32FirstW(h_snapshot: isize, lppe: *mut PROCESSENTRY32W) -> i32;
        fn Process32NextW(h_snapshot: isize, lppe: *mut PROCESSENTRY32W) -> i32;
        fn CloseHandle(h_object: isize) -> i32;
    }

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE || snapshot == 0 {
        return None;
    }

    let mut children_map: HashMap<u32, Vec<(u32, String)>> = HashMap::new();
    let mut entry = PROCESSENTRY32W {
        dw_size: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        cnt_usage: 0,
        th32_process_id: 0,
        th32_default_heap_id: 0,
        th32_module_id: 0,
        cnt_threads: 0,
        th32_parent_process_id: 0,
        pc_pri_class_base: 0,
        dw_flags: 0,
        sz_exe_file: [0; 260],
    };

    unsafe {
        if Process32FirstW(snapshot, &mut entry) != 0 {
            loop {
                let len = entry
                    .sz_exe_file
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(entry.sz_exe_file.len());
                let exe_name = String::from_utf16_lossy(&entry.sz_exe_file[..len]);
                children_map
                    .entry(entry.th32_parent_process_id)
                    .or_default()
                    .push((entry.th32_process_id, exe_name));

                if Process32NextW(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
    }

    // Breadth-first traversal from root_pid
    let mut queue = std::collections::VecDeque::new();
    let mut visited = HashSet::new();
    queue.push_back(root_pid);
    visited.insert(root_pid);

    let mut detected: Option<String> = None;
    while let Some(pid) = queue.pop_front() {
        if let Some(children) = children_map.get(&pid) {
            for (child_pid, exe_name) in children {
                if visited.insert(*child_pid) {
                    if let Some(engine) = map_executable_name_to_agent_engine(exe_name) {
                        detected = Some(engine);
                    }
                    queue.push_back(*child_pid);
                }
            }
        }
    }

    detected
}

#[cfg(not(windows))]
pub fn detect_child_agent_in_shell(_root_pid: u32) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_paths_and_file_uris_consistently() {
        assert!(paths_match(r"E:\kite\", "e:/kite"));
        assert!(paths_match(r"\\?\E:\kite", "E:/kite"));
        assert_eq!(
            path_to_file_uri_normalized(r"E:\kite\"),
            "file:///e:/kite"
        );
    }

    #[test]
    fn computes_claude_project_slug_accurately() {
        assert_eq!(claude_project_slug(r"E:\kite"), "E--kite");
        assert_eq!(
            claude_project_slug(r"\\?\C:\Users\PC\my_repo"),
            "C--Users-PC-my-repo"
        );
    }

    #[test]
    fn maps_executable_names_to_canonical_engines() {
        assert_eq!(
            map_executable_name_to_agent_engine("agy.exe"),
            Some("antigravity".to_string())
        );
        assert_eq!(
            map_executable_name_to_agent_engine("codex.exe"),
            Some("codex".to_string())
        );
        assert_eq!(
            map_executable_name_to_agent_engine("claude.exe"),
            Some("claude-code".to_string())
        );
        assert_eq!(
            map_executable_name_to_agent_engine("opencode.exe"),
            Some("open-code".to_string())
        );
        assert_eq!(
            map_executable_name_to_agent_engine("gentle-shell.cmd"),
            Some("gentle-shell".to_string())
        );
        assert_eq!(
            canonical_agent_engine("gentle-shell"),
            "gentle-shell".to_string()
        );
        assert_eq!(map_executable_name_to_agent_engine("powershell.exe"), None);
    }

    #[test]
    fn test_normalize_terminal_text_strips_ansi_and_normalizes_whitespace() {
        let raw = b"\x1b[32m\x1b[1m  Hello   World!\x1b[0m\r\nThis is   ANTIGRAVITY\t\ttest.  ";
        let norm = normalize_terminal_text(raw);
        assert_eq!(norm, " hello world! this is antigravity test. ");
    }

    #[test]
    fn test_extract_phrase_windows_produces_multi_word_phrases() {
        let norm = "quiero que investigues y explores exhaustivamente que esta sucediendo con las terminales";
        let wins = extract_phrase_windows(norm, 5);
        assert!(!wins.is_empty());
        assert!(wins[0].len() >= 16);
        assert!(wins[0].split_whitespace().count() >= 3);
    }

    #[test]
    fn test_resolve_provider_session_id_rejects_claimed_existing_id() {
        let mut claimed = HashSet::new();
        claimed.insert("existing-uuid-1234".to_string());

        // When existing_provider_id is claimed, antigravity should not return it directly
        let res = resolve_provider_session_id(
            "antigravity",
            r"C:\non_existent_folder_xyz_123",
            "dummy-term-session",
            Some("existing-uuid-1234"),
            0,
            &claimed,
        );
        assert_ne!(res.as_deref(), Some("existing-uuid-1234"));

        // When not claimed, it should return it
        let empty_claimed = HashSet::new();
        let res_ok = resolve_provider_session_id(
            "antigravity",
            r"C:\non_existent_folder_xyz_123",
            "dummy-term-session",
            Some("existing-uuid-1234"),
            0,
            &empty_claimed,
        );
        assert_eq!(res_ok.as_deref(), Some("existing-uuid-1234"));
    }
}
