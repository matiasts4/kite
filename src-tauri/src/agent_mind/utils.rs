use crate::persist::agents;
use sha2::{Digest, Sha256};
use std::io;
use std::path::Component;
use crate::agent_mind::types::{AgentMindError, TextRecord, MEMORY_BYTE_LIMIT};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

pub fn agents_root() -> PathBuf {
    crate::persist::state_path()
        .parent()
        .map(|dir| dir.join("agents"))
        .unwrap_or_else(|| PathBuf::from("agents"))
}

pub fn get_agent_home_dir(agent_id: &str) -> PathBuf {
    agents_root().join(agent_id)
}

pub(crate) fn request_body(request: &Value) -> &Value {
    request.get("request").unwrap_or(request)
}

pub(crate) fn is_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    bytes.iter().enumerate().all(|(index, byte)| match index {
        8 | 13 | 18 | 23 => *byte == b'-',
        _ => byte.is_ascii_hexdigit(),
    })
}

pub(crate) fn require_known_agent(agent_id: &str) -> Result<(), AgentMindError> {
    if !is_uuid(agent_id) {
        return Err(AgentMindError::new(
            "agent_data_failed",
            "That agent does not exist.",
        ));
    }
    let items = agents().lock().map_err(|_| {
        AgentMindError::new("agent_data_failed", "Agent data could not be read.")
    })?;
    if items.iter().any(|agent| agent.id == agent_id) {
        Ok(())
    } else {
        Err(AgentMindError::new(
            "agent_data_failed",
            "That agent does not exist.",
        ))
    }
}

pub(crate) fn confirmed(request: &Value) -> bool {
    request.get("confirmedByBuilder").and_then(|value| value.as_bool()) == Some(true)
}

pub(crate) fn require_confirmation(request: &Value) -> Result<(), AgentMindError> {
    if confirmed(request) {
        Ok(())
    } else {
        Err(AgentMindError::new(
            "agent_data_failed",
            "The builder has not confirmed this edit.",
        ))
    }
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(crate) fn empty_revision() -> String {
    sha256_hex(b"")
}

pub(crate) fn modified_ms(path: &Path) -> Option<i64> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    let millis = modified.duration_since(UNIX_EPOCH).ok()?.as_millis();
    i64::try_from(millis).ok()
}

pub(crate) fn has_disallowed_control(text: &str) -> bool {
    text.chars().any(|ch| {
        let code = ch as u32;
        (code <= 31 && ch != '\n' && ch != '\t') || (127..=159).contains(&code)
    })
}

pub(crate) fn display_ok(text: &str, max_chars: usize) -> bool {
    text.chars().count() <= max_chars && !has_disallowed_control(text)
}

pub(crate) fn windows_device_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let base = lower.split('.').next().unwrap_or("");
    matches!(base, "con" | "prn" | "aux" | "nul" | "clock$")
        || ((base.starts_with("com") || base.starts_with("lpt"))
            && base.len() == 4
            && base.as_bytes()[3].is_ascii_digit()
            && base.as_bytes()[3] != b'0')
}

pub(crate) fn single_path_component(name: &str) -> bool {
    let path = Path::new(name);
    let mut components = path.components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(part)), None) => part == path.as_os_str(),
        _ => false,
    }
}

pub(crate) fn skill_id_ok(skill_id: &str) -> bool {
    !skill_id.is_empty()
        && skill_id == skill_id.trim()
        && skill_id.chars().count() <= 128
        && !skill_id.to_ascii_lowercase().starts_with(".kite-deleted-")
        && !skill_id.chars().any(|ch| "<>:\"/\\|?*".contains(ch))
        && !has_disallowed_control(skill_id)
        && skill_id != "."
        && skill_id != ".."
        && !skill_id.ends_with('.')
        && !skill_id.ends_with(' ')
        && !windows_device_name(skill_id)
        && single_path_component(skill_id)
}

pub(crate) fn ensure_agent_id(agent_id: &str) -> Result<(), AgentMindError> {
    if is_uuid(agent_id) {
        Ok(())
    } else {
        Err(AgentMindError::new(
            "agent_data_failed",
            "That agent does not exist.",
        ))
    }
}

pub(crate) fn ensure_skill_id(skill_id: &str) -> Result<(), AgentMindError> {
    if skill_id_ok(skill_id) {
        Ok(())
    } else {
        Err(AgentMindError::new(
            "agent_data_unsafe",
            "That skill id is not safe to store.",
        ))
    }
}

pub(crate) fn issue(code: &str, skill_id: Option<&str>, raw_revision: Option<&str>) -> Value {
    json!({
        "code": code,
        "skillId": skill_id,
        "rawRevision": raw_revision,
    })
}

pub(crate) fn read_regular(path: &Path) -> io::Result<Option<Vec<u8>>> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
        Ok(meta) if !meta.file_type().is_file() => {
            Err(io::Error::new(io::ErrorKind::InvalidData, "not a regular file"))
        }
        Ok(_) => fs::read(path).map(Some),
    }
}

pub(crate) fn prepare_file(root: &Path, file: &Path) -> Result<(), AgentMindError> {
    if fs::symlink_metadata(file).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err(AgentMindError::new(
            "agent_data_unsafe",
            "Agent data could not be opened safely.",
        ));
    }
    let parent = file.parent().ok_or_else(|| {
        AgentMindError::new("agent_data_unsafe", "Agent data could not be opened safely.")
    })?;
    fs::create_dir_all(root).map_err(|_| {
        AgentMindError::new("agent_data_failed", "Kite could not store this agent data.")
    })?;
    fs::create_dir_all(parent).map_err(|_| {
        AgentMindError::new("agent_data_failed", "Kite could not store this agent data.")
    })?;
    let root_canon = root.canonicalize().map_err(|_| {
        AgentMindError::new("agent_data_failed", "Kite could not store this agent data.")
    })?;
    let parent_canon = parent.canonicalize().map_err(|_| {
        AgentMindError::new("agent_data_failed", "Kite could not store this agent data.")
    })?;
    if parent_canon.starts_with(&root_canon) {
        Ok(())
    } else {
        Err(AgentMindError::new(
            "agent_data_unsafe",
            "Agent data could not be opened safely.",
        ))
    }
}

pub(crate) fn read_text_record(path: &Path, unreadable_code: &str) -> TextRecord {
    match read_regular(path) {
        Ok(None) => TextRecord {
            text: String::new(),
            revision: Some(empty_revision()),
            updated_at: None,
            issue: None,
        },
        Ok(Some(bytes)) => match String::from_utf8(bytes.clone()) {
            Ok(text) if text.len() <= MEMORY_BYTE_LIMIT => TextRecord {
                text,
                revision: Some(sha256_hex(&bytes)),
                updated_at: modified_ms(path),
                issue: None,
            },
            Ok(_) | Err(_) => TextRecord {
                text: String::new(),
                revision: None,
                updated_at: None,
                issue: Some(issue(unreadable_code, None, Some(&sha256_hex(&bytes)))),
            },
        },
        Err(_) => TextRecord {
            text: String::new(),
            revision: None,
            updated_at: None,
            issue: Some(issue(unreadable_code, None, None)),
        },
    }
}

