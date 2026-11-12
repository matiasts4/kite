use std::collections::{HashMap, HashSet};

use super::matching::{
    extract_phrase_windows, extract_user_request_block, normalize_terminal_text,
    path_to_file_uri_normalized, paths_match,
};
use super::process::{
    collect_process_tree_pids, get_all_locked_antigravity_conversations, user_home_dir,
};

pub use super::grok::*;

pub fn resolve_antigravity_session_id(
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

    let keep_existing = |existing: Option<&str>| -> Option<String> {
        let existing = existing?;
        let locked_by_foreign_process = if let Some(holder_pids) = locked_conversations.get(existing)
        {
            !holder_pids.is_empty()
                && !tree_pids.is_empty()
                && !holder_pids.iter().any(|hp| tree_pids.contains(hp))
        } else {
            false
        };
        if locked_by_foreign_process {
            None
        } else {
            Some(existing.to_string())
        }
    };

    let Some(home) = user_home_dir() else {
        return keep_existing(existing_provider_id);
    };
    let agy_dir = home.join(".gemini").join("antigravity-cli");
    if !agy_dir.is_dir() {
        return keep_existing(existing_provider_id);
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
                            if root_pid.is_some() && locked_conversations.contains_key(&conv_id) {
                                return Some(conv_id);
                            }
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

    keep_existing(existing_provider_id)
}

pub fn resolve_codex_session_id(
    cwd: &str,
    terminal_session_id: &str,
    _spawned_at_unix_ms: i64,
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
                let (id, row_cwd, _updated_at, title, first_msg) = row;
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
                candidates.push((id, score));
            }

            if let Some((best_id, best_score)) = candidates.iter().max_by_key(|(_, score)| *score) {
                if *best_score >= 40 {
                    return Some(best_id.clone());
                }
            }
        }
    }
    None
}

pub fn resolve_opencode_session_id(
    cwd: &str,
    terminal_session_id: &str,
    _spawned_at_unix_ms: i64,
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
                    let (id, dir, _time_updated, title) = row;
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
                    candidates.push((id, score));
                }

                if let Some((best_id, best_score)) = candidates.iter().max_by_key(|(_, score)| *score)
                {
                    if *best_score >= 40 {
                        return Some(best_id.clone());
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

pub fn resolve_claude_session_id(
    cwd: &str,
    terminal_session_id: &str,
    existing_provider_id: Option<&str>,
    spawned_at_unix_ms: i64,
    claimed_ids: &HashSet<String>,
    last_user_input: Option<&str>,
) -> Option<String> {
    let home = user_home_dir();
    if let Some(home) = home {
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
    }
    if uuid::Uuid::parse_str(terminal_session_id).is_ok()
        && !claimed_ids.contains(terminal_session_id)
        && claude_session_file_exists(cwd, terminal_session_id)
    {
        return Some(terminal_session_id.to_string());
    }
    if let Some(existing) = existing_provider_id {
        if claude_session_file_exists(cwd, existing) {
            return Some(existing.to_string());
        }
    }
    None
}

pub fn resolve_gemini_session_id(
    _cwd: &str,
    terminal_session_id: &str,
    existing_provider_id: Option<&str>,
    _spawned_at_unix_ms: i64,
    claimed_ids: &HashSet<String>,
) -> Option<String> {
    if let Some(home) = user_home_dir() {
        let tmp_dir = home.join(".gemini").join("tmp");
        if tmp_dir.is_dir() {
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
                        let path_str = path.to_string_lossy().to_string();
                        if claimed_ids.contains(&path_str) {
                            continue;
                        }
                        if let Ok(raw) = std::fs::read_to_string(&path) {
                            if raw.contains(terminal_session_id) {
                                return Some(path_str);
                            }
                        }
                    }
                }
            }
        }
    }
    existing_provider_id
        .map(str::trim)
        .filter(|id| !id.is_empty() && !claimed_ids.contains(*id))
        .map(|id| id.to_string())
}
