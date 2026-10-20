use crate::agent_mind::memory::{load_agent_mind_at, revision_matches, sync_agent_instructions};
use crate::agent_mind::types::{
    AgentMindError, MAX_SKILLS, SKILL_BYTE_LIMIT, SKILL_DESCRIPTION_LIMIT, SKILL_NAME_LIMIT,
};
use crate::agent_mind::utils::{
    display_ok, ensure_agent_id, ensure_skill_id, has_disallowed_control, issue, modified_ms,
    prepare_file, read_regular, require_confirmation, require_known_agent, sha256_hex,
    skill_id_ok,
};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

pub(crate) fn unquote(value: &str) -> String {
    if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
        value[1..value.len() - 1].to_string()
    } else {
        value.to_string()
    }
}

pub(crate) fn frontmatter_fields(source: &str) -> (Option<String>, Option<String>) {
    let mut lines = source.split('\n');
    let Some(first) = lines.next() else {
        return (None, None);
    };
    if first.trim_end_matches('\r').trim() != "---" {
        return (None, None);
    }
    let mut name = None;
    let mut description = None;
    for line in lines {
        let trimmed = line.trim_end_matches('\r').trim();
        if trimmed == "---" {
            break;
        }
        let Some((key, value)) = trimmed.split_once(':') else {
            continue;
        };
        let parsed = unquote(value.trim());
        match key.trim() {
            "name" if name.is_none() => name = Some(parsed),
            "description" if description.is_none() => description = Some(parsed),
            _ => {}
        }
    }
    (name, description)
}

pub(crate) fn skill_summary(skill_id: &str, source: &str, path: &Path) -> (Value, Option<Value>) {
    let (raw_name, raw_description) = frontmatter_fields(source);
    let mut invalid = false;
    let name = match raw_name {
        Some(name) if display_ok(&name, SKILL_NAME_LIMIT) && !name.is_empty() => name,
        Some(_) => {
            invalid = true;
            if display_ok(skill_id, SKILL_NAME_LIMIT) {
                skill_id.to_string()
            } else {
                "Skill".to_string()
            }
        }
        None => skill_id.to_string(),
    };
    let description = match raw_description {
        Some(description) if display_ok(&description, SKILL_DESCRIPTION_LIMIT) => description,
        Some(_) => {
            invalid = true;
            String::new()
        }
        None => String::new(),
    };
    let summary = json!({
        "id": skill_id,
        "name": name,
        "description": description,
        "updatedAtUnixMs": modified_ms(path).unwrap_or(0),
        "revision": sha256_hex(source.as_bytes()),
        "uses": 0,
        "lastUsed": Value::Null,
        "lastOutcome": Value::Null,
    });
    let issue = if invalid {
        Some(issue("skillInvalid", Some(skill_id), None))
    } else {
        None
    };
    (summary, issue)
}

pub(crate) fn safe_issue_id(skill_id: &str) -> Option<&str> {
    if skill_id.len() <= 128 && !has_disallowed_control(skill_id) {
        Some(skill_id)
    } else {
        None
    }
}

pub(crate) fn read_skills(dir: &Path) -> (Vec<Value>, Vec<Value>) {
    if !dir.exists() {
        return (Vec::new(), Vec::new());
    }
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return (Vec::new(), vec![issue("skillsUnreadable", None, None)]),
    };
    let mut paths = Vec::new();
    for entry in entries {
        let Ok(entry) = entry else {
            return (Vec::new(), vec![issue("skillsUnreadable", None, None)]);
        };
        paths.push(entry.path());
    }
    paths.sort();
    let mut skills = Vec::new();
    let mut issues = Vec::new();
    let mut truncated = false;
    for path in paths {
        let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
            issues.push(issue("skillPathRejected", None, None));
            continue;
        };
        if !file_name.ends_with(".md") {
            continue;
        }
        let skill_id = &file_name[..file_name.len() - 3];
        let meta = match fs::symlink_metadata(&path) {
            Ok(meta) => meta,
            Err(_) => {
                issues.push(issue("skillUnreadable", safe_issue_id(skill_id), None));
                continue;
            }
        };
        if !meta.file_type().is_file() || !skill_id_ok(skill_id) {
            issues.push(issue(
                "skillPathRejected",
                safe_issue_id(skill_id),
                None,
            ));
            continue;
        }
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(_) => {
                issues.push(issue("skillUnreadable", Some(skill_id), None));
                continue;
            }
        };
        if bytes.len() > SKILL_BYTE_LIMIT {
            issues.push(issue(
                "skillUnreadable",
                Some(skill_id),
                Some(&sha256_hex(&bytes)),
            ));
            continue;
        }
        let Ok(source) = String::from_utf8(bytes) else {
            issues.push(issue("skillUnreadable", Some(skill_id), None));
            continue;
        };
        if skills.len() >= MAX_SKILLS {
            truncated = true;
            continue;
        }
        let (summary, skill_issue) = skill_summary(skill_id, &source, &path);
        skills.push(summary);
        if let Some(skill_issue) = skill_issue {
            issues.push(skill_issue);
        }
    }
    if truncated {
        issues.push(issue("skillsTruncated", None, None));
    }
    (skills, issues)
}


pub(crate) fn skill_path(root: &Path, agent_id: &str, skill_id: &str) -> PathBuf {
    root.join(agent_id)
        .join("skills")
        .join(format!("{skill_id}.md"))
}

pub(crate) fn read_skill_source(path: &Path) -> Result<Option<String>, AgentMindError> {
    match read_regular(path) {
        Ok(None) => Ok(None),
        Ok(Some(bytes)) if bytes.len() > SKILL_BYTE_LIMIT => Err(AgentMindError::new(
            "agent_data_too_large",
            "The agent data exceeds Kite's safe limit.",
        )),
        Ok(Some(bytes)) => String::from_utf8(bytes).map(Some).map_err(|_| {
            AgentMindError::new(
                "agent_data_unreadable",
                "Agent data could not be read, so Kite left it unchanged.",
            )
        }),
        Err(_) => Err(AgentMindError::new(
            "agent_data_unreadable",
            "Agent data could not be read, so Kite left it unchanged.",
        )),
    }
}


pub(crate) fn store_skill_file(
    root: &Path,
    agent_id: &str,
    skill_id: &str,
    source: &str,
) -> Result<(), AgentMindError> {
    ensure_agent_id(agent_id)?;
    ensure_skill_id(skill_id)?;
    if source.len() > SKILL_BYTE_LIMIT {
        return Err(AgentMindError::new(
            "agent_data_too_large",
            "The agent data exceeds Kite's safe limit.",
        ));
    }
    let path = skill_path(root, agent_id, skill_id);
    prepare_file(root, &path)?;
    fs::write(&path, source).map_err(|_| {
        AgentMindError::new(
            "agent_data_failed",
            "Kite could not store this agent data.",
        )
    })?;
    let _ = sync_agent_instructions(root, agent_id);
    Ok(())
}

pub(crate) fn skill_document(skill_id: &str, source: &str, path: &Path) -> Value {
    let (summary, _) = skill_summary(skill_id, source, path);
    let mut document = summary;
    if let Some(object) = document.as_object_mut() {
        object.insert("schemaVersion".to_string(), json!(1));
        object.insert("source".to_string(), json!(source));
    }
    document
}

pub(crate) fn load_agent_skill_at(root: &Path, agent_id: &str, skill_id: &str) -> Result<Value, AgentMindError> {
    ensure_agent_id(agent_id)?;
    ensure_skill_id(skill_id)?;
    let path = skill_path(root, agent_id, skill_id);
    let Some(source) = read_skill_source(&path)? else {
        return Err(AgentMindError::new(
            "agent_data_unreadable",
            "That skill does not exist.",
        ));
    };
    Ok(skill_document(skill_id, &source, &path))
}

pub(crate) fn write_agent_skill_at(
    root: &Path,
    agent_id: &str,
    skill_id: &str,
    source: &str,
    expected_revision: Option<&str>,
) -> Result<Value, AgentMindError> {
    ensure_agent_id(agent_id)?;
    ensure_skill_id(skill_id)?;
    let path = skill_path(root, agent_id, skill_id);
    if source.trim().is_empty() {
        if let Some(existing) = read_skill_source(&path)? {
            if !existing.trim().is_empty() {
                return Err(AgentMindError::new(
                    "empty_skill_overwrite",
                    "Re-open the skill before replacing it with an empty draft.",
                ));
            }
        }
    }
    revision_matches(&path, expected_revision)?;
    store_skill_file(root, agent_id, skill_id, source)?;
    load_agent_mind_at(root, agent_id)
}

pub(crate) fn remove_agent_skill_at(
    root: &Path,
    agent_id: &str,
    skill_id: &str,
    expected_revision: &str,
) -> Result<Value, AgentMindError> {
    ensure_agent_id(agent_id)?;
    ensure_skill_id(skill_id)?;
    let path = skill_path(root, agent_id, skill_id);
    let Some(source) = read_skill_source(&path)? else {
        return Err(AgentMindError::new(
            "agent_data_unreadable",
            "That skill does not exist.",
        ));
    };
    if sha256_hex(source.as_bytes()) != expected_revision {
        return Err(AgentMindError::new(
            "agent_data_conflict",
            "This agent data changed. Reload it before saving again.",
        ));
    }
    if fs::symlink_metadata(&path).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err(AgentMindError::new(
            "agent_data_unsafe",
            "Agent data could not be opened safely.",
        ));
    }
    fs::remove_file(&path).map_err(|_| {
        AgentMindError::new(
            "agent_data_failed",
            "Kite could not complete the agent data operation.",
        )
    })?;
    let _ = sync_agent_instructions(root, agent_id);
    let mind = load_agent_mind_at(root, agent_id)?;
    Ok(json!({
        "removed": true,
        "mind": mind,
    }))
}

