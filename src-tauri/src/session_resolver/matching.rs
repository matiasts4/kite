use std::collections::HashSet;

use super::grok::*;
use super::process::collect_process_tree_pids;
use super::providers::*;

pub fn provider_id_if_unclaimed(id: Option<&str>, claimed: &HashSet<String>) -> Option<String> {
    let trimmed = id.map(str::trim).filter(|value| !value.is_empty())?;
    if claimed.contains(trimmed) {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// A strong discovery replaces the stored id. No discovery keeps the stored unclaimed id.
pub fn pick_bound_provider_id(
    existing: Option<&str>,
    discovered: Option<&str>,
    claimed: &HashSet<String>,
) -> Option<String> {
    if let Some(id) = provider_id_if_unclaimed(discovered, claimed) {
        return Some(id);
    }
    provider_id_if_unclaimed(existing, claimed)
}

/// Restore resumes only the id saved for this terminal. A missing or claimed id starts fresh.
pub fn choose_restore_provider_id(
    saved: Option<&str>,
    claimed: &HashSet<String>,
) -> Option<String> {
    provider_id_if_unclaimed(saved, claimed)
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
pub fn extract_phrase_windows(norm_text: &str, max_windows: usize) -> Vec<String> {
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

pub fn extract_user_request_block(text: &str) -> &str {
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
            let discovered = resolve_codex_session_id(
                cwd,
                terminal_session_id,
                spawned_at_unix_ms,
                claimed_ids,
                last_user_input,
            );
            pick_bound_provider_id(valid_existing, discovered.as_deref(), claimed_ids)
        }
        "open-code" => {
            let discovered = resolve_opencode_session_id(
                cwd,
                terminal_session_id,
                spawned_at_unix_ms,
                claimed_ids,
                last_user_input,
            );
            pick_bound_provider_id(valid_existing, discovered.as_deref(), claimed_ids)
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
        "grok" => {
            let pids = root_pid
                .filter(|&pid| pid > 0)
                .map(collect_process_tree_pids)
                .unwrap_or_default();
            if !pids.is_empty() {
                if let Some(home) = grok_home_dir() {
                    let owners = grok_active_owners_from_home(&home);
                    if let Some(owned) = grok_owned_session_id(&owners, &pids) {
                        if let Some(id) = provider_id_if_unclaimed(Some(&owned), claimed_ids) {
                            return Some(id);
                        }
                    }
                }
            }
            valid_existing.map(|id| id.to_string())
        }
        _ => valid_existing.map(|s| s.to_string()),
    }
}
