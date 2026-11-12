use std::collections::HashSet;
use std::path::{Path, PathBuf};

use super::matching::{
    choose_restore_provider_id, extract_phrase_windows, normalize_terminal_text, paths_match,
};
use super::process::{process_is_alive, user_home_dir};

/// Percent-encode a cwd the same way Grok CLI names `~/.grok/sessions/<encoded>`.
/// Matches JavaScript `encodeURIComponent` on the raw path bytes.
pub fn grok_encode_cwd(cwd: &str) -> String {
    let mut out = String::with_capacity(cwd.len() * 3);
    for &b in cwd.as_bytes() {
        match b {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

pub fn grok_home_dir() -> Option<PathBuf> {
    std::env::var_os("GROK_HOME")
        .map(PathBuf::from)
        .or_else(|| user_home_dir().map(|home| home.join(".grok")))
}

#[derive(Debug, Clone)]
pub struct GrokActiveOwner {
    pub session_id: String,
    pub pid: u32,
}

pub fn grok_parse_active_owners(raw: &str) -> Vec<GrokActiveOwner> {
    let Ok(val) = serde_json::from_str::<serde_json::Value>(raw) else {
        return Vec::new();
    };
    let Some(arr) = val.as_array() else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|item| {
            let session_id = item
                .get("session_id")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|id| !id.is_empty())?
                .to_string();
            let pid = item.get("pid").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            Some(GrokActiveOwner { session_id, pid })
        })
        .collect()
}

pub fn grok_parse_active_session_ids(raw: &str) -> HashSet<String> {
    grok_parse_active_owners(raw)
        .into_iter()
        .map(|owner| owner.session_id)
        .collect()
}

pub fn grok_active_owners_from_home(grok_home: &Path) -> Vec<GrokActiveOwner> {
    let Ok(raw) = std::fs::read_to_string(grok_home.join("active_sessions.json")) else {
        return Vec::new();
    };
    grok_parse_active_owners(&raw)
}

/// The session this process tree is actually running. A cwd guess is not an owner.
pub fn grok_owned_session_id(owners: &[GrokActiveOwner], pids: &HashSet<u32>) -> Option<String> {
    owners
        .iter()
        .find(|owner| owner.pid > 0 && pids.contains(&owner.pid))
        .map(|owner| owner.session_id.clone())
}

/// Resume the id saved for this pane. A live foreign owner blocks it.
/// A dead active-session record does not, and a missing id is not replaced.
pub fn choose_grok_restore_id(
    saved: Option<&str>,
    claimed: &HashSet<String>,
    owners: &[GrokActiveOwner],
    pid_alive: impl Fn(u32) -> bool,
) -> Option<String> {
    let saved = saved.map(str::trim).filter(|id| !id.is_empty())?;
    if claimed.contains(saved) {
        return None;
    }
    let live_owner = owners.iter().any(|owner| {
        owner.session_id == saved && owner.pid > 0 && pid_alive(owner.pid)
    });
    if live_owner {
        return None;
    }
    Some(saved.to_string())
}

pub fn grok_active_session_ids_from_home(grok_home: &Path) -> HashSet<String> {
    let Ok(raw) = std::fs::read_to_string(grok_home.join("active_sessions.json")) else {
        return HashSet::new();
    };
    grok_parse_active_session_ids(&raw)
}

/// Mouse SGR (`[<btn;x;yM`) is not conversation text. Using it as a match key
/// binds the pane to whichever Grok session happens to be last-active.
pub fn usable_grok_user_input(raw: Option<&str>) -> Option<&str> {
    let trimmed = raw.map(str::trim).filter(|s| !s.is_empty())?;
    if trimmed.matches("[<").count() >= 3 {
        return None;
    }
    Some(trimmed)
}

/// Resume the Grok conversation saved for this pane. Never a sibling conversation.
pub fn restore_grok_provider_id(
    saved: Option<&str>,
    claimed: &HashSet<String>,
    cwd: &str,
    terminal_session_id: &str,
    spawned_at_unix_ms: i64,
    last_user_input: Option<&str>,
) -> Option<String> {
    match grok_home_dir() {
        Some(home) => restore_grok_provider_id_from_home(
            &home,
            saved,
            claimed,
            cwd,
            terminal_session_id,
            spawned_at_unix_ms,
            last_user_input,
        ),
        None => choose_restore_provider_id(saved, claimed),
    }
}

pub fn restore_grok_provider_id_from_home(
    grok_home: &Path,
    saved: Option<&str>,
    claimed: &HashSet<String>,
    _cwd: &str,
    _terminal_session_id: &str,
    _spawned_at_unix_ms: i64,
    _last_user_input: Option<&str>,
) -> Option<String> {
    let owners = grok_active_owners_from_home(grok_home);
    choose_grok_restore_id(saved, claimed, &owners, process_is_alive)
}

pub fn grok_cwd_path_variants(cwd: &str) -> Vec<String> {
    let mut variants = Vec::new();
    let push_unique = |list: &mut Vec<String>, value: String| {
        if !value.is_empty() && !list.iter().any(|existing| existing == &value) {
            list.push(value);
        }
    };
    push_unique(&mut variants, cwd.to_string());
    push_unique(&mut variants, cwd.replace('\\', "/"));
    push_unique(&mut variants, cwd.replace('/', "\\"));
    variants
}

pub fn grok_rfc3339_to_unix_ms(raw: &str) -> Option<i64> {
    let s = raw.trim();
    let bytes = s.as_bytes();
    if bytes.len() < 19 {
        return None;
    }
    let year: i32 = std::str::from_utf8(&bytes[0..4]).ok()?.parse().ok()?;
    let month: u32 = std::str::from_utf8(&bytes[5..7]).ok()?.parse().ok()?;
    let day: u32 = std::str::from_utf8(&bytes[8..10]).ok()?.parse().ok()?;
    let hour: u32 = std::str::from_utf8(&bytes[11..13]).ok()?.parse().ok()?;
    let minute: u32 = std::str::from_utf8(&bytes[14..16]).ok()?.parse().ok()?;
    let second: u32 = std::str::from_utf8(&bytes[17..19]).ok()?.parse().ok()?;
    Some(civil_utc_to_unix_ms(year, month, day, hour, minute, second))
}

pub fn civil_utc_to_unix_ms(
    year: i32,
    month: u32,
    day: u32,
    hour: u32,
    minute: u32,
    second: u32,
) -> i64 {
    let y = if month <= 2 { year - 1 } else { year } as i64;
    let m = month as i64;
    let d = day as i64;
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    days * 86_400_000
        + hour as i64 * 3_600_000
        + minute as i64 * 60_000
        + second as i64 * 1_000
}

pub struct GrokSessionCandidate {
    pub id: String,
    pub created_at_ms: i64,
    pub last_active_ms: i64,
    pub title: String,
    pub summary: String,
}

pub fn read_grok_session_candidate(dir: &Path) -> Option<GrokSessionCandidate> {
    let summary_path = dir.join("summary.json");
    let raw = std::fs::read_to_string(&summary_path).ok()?;
    let val: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let info = val.get("info");
    let folder_id = dir.file_name()?.to_str()?.to_string();
    let id = info
        .and_then(|info| info.get("id"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .unwrap_or(&folder_id)
        .to_string();
    let created_at_ms = val
        .get("created_at")
        .and_then(|v| v.as_str())
        .and_then(grok_rfc3339_to_unix_ms)
        .unwrap_or(0);
    let last_active_ms = val
        .get("last_active_at")
        .and_then(|v| v.as_str())
        .and_then(grok_rfc3339_to_unix_ms)
        .unwrap_or(created_at_ms);
    let title = val
        .get("generated_title")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let summary = val
        .get("session_summary")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    Some(GrokSessionCandidate {
        id,
        created_at_ms,
        last_active_ms,
        title,
        summary,
    })
}

pub fn grok_candidate_matches_cwd(summary_path: &Path, cwd: &str) -> bool {
    let Ok(raw) = std::fs::read_to_string(summary_path) else {
        return false;
    };
    let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return false;
    };
    let Some(session_cwd) = val
        .get("info")
        .and_then(|info| info.get("cwd"))
        .and_then(|v| v.as_str())
    else {
        return true;
    };
    paths_match(session_cwd, cwd)
}

pub fn score_grok_candidate(
    candidate: &GrokSessionCandidate,
    spawned_at_unix_ms: i64,
    norm_user_input: Option<&str>,
    norm_scrollback: &str,
) -> u32 {
    let mut score = 0u32;
    if spawned_at_unix_ms > 0 && candidate.created_at_ms > 0 {
        let delta = (candidate.created_at_ms - spawned_at_unix_ms).unsigned_abs();
        if delta <= 120_000 {
            score += 200;
            score += ((120_000 - delta) / 1_000) as u32;
        }
    }
    let haystack = format!(
        "{} {}",
        normalize_terminal_text(candidate.title.as_bytes()),
        normalize_terminal_text(candidate.summary.as_bytes())
    );
    if let Some(input) = norm_user_input {
        if input.len() >= 8 && haystack.contains(input) {
            score += 80;
        }
        for phrase in extract_phrase_windows(input, 4) {
            if haystack.contains(&phrase) {
                score += 40;
            }
        }
    }
    if norm_scrollback.len() >= 16 {
        for phrase in extract_phrase_windows(norm_scrollback, 4) {
            if haystack.contains(&phrase) {
                score += 25;
            }
        }
    }
    score
}

pub fn resolve_grok_session_id_from_home(
    grok_home: &Path,
    cwd: &str,
    terminal_session_id: &str,
    spawned_at_unix_ms: i64,
    claimed_ids: &HashSet<String>,
    last_user_input: Option<&str>,
) -> Option<String> {
    let mut session_dir = None;
    for variant in grok_cwd_path_variants(cwd) {
        let encoded = grok_home
            .join("sessions")
            .join(grok_encode_cwd(&variant));
        if encoded.is_dir() {
            session_dir = Some(encoded);
            break;
        }
    }
    let session_dir = session_dir?;
    let entries = std::fs::read_dir(&session_dir).ok()?;

    let sb_bytes = crate::terminal::read_scrollback_file(terminal_session_id);
    let norm_scrollback = sb_bytes
        .as_deref()
        .map(normalize_terminal_text)
        .unwrap_or_default();
    let norm_user_input = usable_grok_user_input(last_user_input)
        .map(|s| normalize_terminal_text(s.as_bytes()))
        .filter(|s| s.trim().len() >= 8);
    let active_ids = grok_active_session_ids_from_home(grok_home);

    let mut best: Option<(u32, i64, i64, String)> = None;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let summary_path = path.join("summary.json");
        if !summary_path.is_file() {
            continue;
        }
        if !grok_candidate_matches_cwd(&summary_path, cwd) {
            continue;
        }
        let Some(candidate) = read_grok_session_candidate(&path) else {
            continue;
        };
        if candidate.id.is_empty()
            || claimed_ids.contains(&candidate.id)
            || active_ids.contains(&candidate.id)
        {
            continue;
        }
        let score = score_grok_candidate(
            &candidate,
            spawned_at_unix_ms,
            norm_user_input.as_deref(),
            &norm_scrollback,
        );
        let rank = (
            score,
            if spawned_at_unix_ms > 0 && candidate.created_at_ms > 0 {
                -((candidate.created_at_ms - spawned_at_unix_ms).abs())
            } else {
                0
            },
            candidate.last_active_ms,
            candidate.id.clone(),
        );
        match &best {
            None => best = Some(rank),
            Some(current) => {
                if rank.0 > current.0
                    || (rank.0 == current.0 && rank.1 > current.1)
                    || (rank.0 == current.0 && rank.1 == current.1 && rank.2 > current.2)
                {
                    best = Some(rank);
                }
            }
        }
    }
    best.map(|(_, _, _, id)| id)
}
