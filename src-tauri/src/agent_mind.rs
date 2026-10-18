//! Local agent memory and skills.
//!
//! `{agents root}/{agentId}/memory.txt` and `user.txt` hold the two text
//! targets. Each skill is `{agentId}/skills/{skillId}.md`.

use crate::persist::agents;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

const MEMORY_BYTE_LIMIT: usize = 262_144;
const SKILL_BYTE_LIMIT: usize = 1_048_576;
const MEMORY_CHAR_BUDGET: usize = 2200;
const USER_CHAR_BUDGET: usize = 1375;
const SKILL_NAME_LIMIT: usize = 256;
const SKILL_DESCRIPTION_LIMIT: usize = 2000;
const MAX_SKILLS: usize = 512;

#[derive(Debug, Serialize)]
pub struct AgentMindError {
    pub code: String,
    pub message: String,
}

impl AgentMindError {
    fn new(code: &str, message: &str) -> Self {
        Self { code: code.chars().take(64).collect(), message: message.chars().take(500).collect() }
    }
}

struct Starter {
    id: &'static str,
    title: &'static str,
    summary: &'static str,
    name: &'static str,
    description: &'static str,
    body: &'static str,
}

const STARTERS: &[Starter] = &[
    Starter {
        id: "keep-a-memory",
        title: "Keep a memory",
        summary: "Save a fact that should still be true after this chat.",
        name: "Keep a memory",
        description: "Use when the builder states a preference, decision, or fact that should outlive this chat.",
        body: "Write one durable line into agent memory, newest last. Leave secrets out.",
    },
    Starter {
        id: "write-a-skill",
        title: "Write a skill",
        summary: "Turn a repeated procedure into a skill the agent can read back.",
        name: "Write a skill",
        description: "Use when the same procedure has worked twice and should be saved for the next matching task.",
        body: "Write a skill with a short name, a description of when it fires, and the steps.",
    },
    Starter {
        id: "research-a-question",
        title: "Research a question",
        summary: "Answer a question from the project files before guessing.",
        name: "Research a question",
        description: "Use when the builder asks what the code or documents actually say.",
        body: "Read the relevant files first, then answer with the paths you checked and what is still unknown.",
    },
    Starter {
        id: "draft-for-a-reader",
        title: "Draft for a reader",
        summary: "Draft text for a specific reader, then revise it once.",
        name: "Draft for a reader",
        description: "Use when the builder wants a draft written for someone else to read.",
        body: "Name the reader, write the draft, and revise it once for clarity.",
    },
    Starter {
        id: "root-cause",
        title: "Root cause",
        summary: "Trace a failure to the change that produced it.",
        name: "Root cause",
        description: "Use when something fails and the builder wants the cause, not a workaround.",
        body: "Reproduce the failure, find the producing change, and say what would prevent it.",
    },
];

struct TextRecord {
    text: String,
    revision: Option<String>,
    updated_at: Option<i64>,
    issue: Option<Value>,
}

pub fn agents_root() -> PathBuf {
    crate::persist::state_path()
        .parent()
        .map(|dir| dir.join("agents"))
        .unwrap_or_else(|| PathBuf::from("agents"))
}

pub fn get_agent_home_dir(agent_id: &str) -> PathBuf {
    agents_root().join(agent_id)
}

fn request_body(request: &Value) -> &Value {
    request.get("request").unwrap_or(request)
}

fn is_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    bytes.iter().enumerate().all(|(index, byte)| match index {
        8 | 13 | 18 | 23 => *byte == b'-',
        _ => byte.is_ascii_hexdigit(),
    })
}

fn require_known_agent(agent_id: &str) -> Result<(), AgentMindError> {
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

fn confirmed(request: &Value) -> bool {
    request.get("confirmedByBuilder").and_then(|value| value.as_bool()) == Some(true)
}

fn require_confirmation(request: &Value) -> Result<(), AgentMindError> {
    if confirmed(request) {
        Ok(())
    } else {
        Err(AgentMindError::new(
            "agent_data_failed",
            "The builder has not confirmed this edit.",
        ))
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn empty_revision() -> String {
    sha256_hex(b"")
}

fn modified_ms(path: &Path) -> Option<i64> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    let millis = modified.duration_since(UNIX_EPOCH).ok()?.as_millis();
    i64::try_from(millis).ok()
}

fn has_disallowed_control(text: &str) -> bool {
    text.chars().any(|ch| {
        let code = ch as u32;
        (code <= 31 && ch != '\n' && ch != '\t') || (127..=159).contains(&code)
    })
}

fn display_ok(text: &str, max_chars: usize) -> bool {
    text.chars().count() <= max_chars && !has_disallowed_control(text)
}

fn windows_device_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let base = lower.split('.').next().unwrap_or("");
    matches!(base, "con" | "prn" | "aux" | "nul" | "clock$")
        || ((base.starts_with("com") || base.starts_with("lpt"))
            && base.len() == 4
            && base.as_bytes()[3].is_ascii_digit()
            && base.as_bytes()[3] != b'0')
}

fn single_path_component(name: &str) -> bool {
    let path = Path::new(name);
    let mut components = path.components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(part)), None) => part == path.as_os_str(),
        _ => false,
    }
}

fn skill_id_ok(skill_id: &str) -> bool {
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

fn ensure_agent_id(agent_id: &str) -> Result<(), AgentMindError> {
    if is_uuid(agent_id) {
        Ok(())
    } else {
        Err(AgentMindError::new(
            "agent_data_failed",
            "That agent does not exist.",
        ))
    }
}

fn ensure_skill_id(skill_id: &str) -> Result<(), AgentMindError> {
    if skill_id_ok(skill_id) {
        Ok(())
    } else {
        Err(AgentMindError::new(
            "agent_data_unsafe",
            "That skill id is not safe to store.",
        ))
    }
}

fn issue(code: &str, skill_id: Option<&str>, raw_revision: Option<&str>) -> Value {
    json!({
        "code": code,
        "skillId": skill_id,
        "rawRevision": raw_revision,
    })
}

fn read_regular(path: &Path) -> io::Result<Option<Vec<u8>>> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
        Ok(meta) if !meta.file_type().is_file() => {
            Err(io::Error::new(io::ErrorKind::InvalidData, "not a regular file"))
        }
        Ok(_) => fs::read(path).map(Some),
    }
}

fn prepare_file(root: &Path, file: &Path) -> Result<(), AgentMindError> {
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

fn read_text_record(path: &Path, unreadable_code: &str) -> TextRecord {
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

fn unquote(value: &str) -> String {
    if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
        value[1..value.len() - 1].to_string()
    } else {
        value.to_string()
    }
}

fn frontmatter_fields(source: &str) -> (Option<String>, Option<String>) {
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

fn skill_summary(skill_id: &str, source: &str, path: &Path) -> (Value, Option<Value>) {
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

fn safe_issue_id(skill_id: &str) -> Option<&str> {
    if skill_id.len() <= 128 && !has_disallowed_control(skill_id) {
        Some(skill_id)
    } else {
        None
    }
}

fn read_skills(dir: &Path) -> (Vec<Value>, Vec<Value>) {
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

fn load_agent_mind_at(root: &Path, agent_id: &str) -> Result<Value, AgentMindError> {
    ensure_agent_id(agent_id)?;
    let dir = root.join(agent_id);
    let memory = read_text_record(&dir.join("memory.txt"), "memoryUnreadable");
    let user = read_text_record(&dir.join("user.txt"), "userUnreadable");
    let (skills, mut read_issues) = read_skills(&dir.join("skills"));
    if !dir.join("AGENTS.md").exists() {
        let _ = sync_agent_instructions(root, agent_id);
    }
    if let Some(issue) = memory.issue {
        read_issues.push(issue);
    }
    if let Some(issue) = user.issue {
        read_issues.push(issue);
    }
    read_issues.truncate(515);
    Ok(json!({
        "schemaVersion": 1,
        "agentId": agent_id,
        "memory": memory.text,
        "user": user.text,
        "skills": skills,
        "memoryUpdatedAtUnixMs": memory.updated_at,
        "userUpdatedAtUnixMs": user.updated_at,
        "memoryRevision": memory.revision,
        "userRevision": user.revision,
        "readIssues": read_issues,
    }))
}

fn memory_path(root: &Path, agent_id: &str, target: &str) -> Result<PathBuf, AgentMindError> {
    let file = match target {
        "memory" => "memory.txt",
        "user" => "user.txt",
        _ => {
            return Err(AgentMindError::new(
                "agent_data_failed",
                "That memory target is not available.",
            ))
        }
    };
    Ok(root.join(agent_id).join(file))
}

fn revision_matches(path: &Path, expected: Option<&str>) -> Result<(), AgentMindError> {
    match read_regular(path) {
        Ok(None) if expected.is_none() || expected == Some(empty_revision().as_str()) => Ok(()),
        Ok(None) => Err(AgentMindError::new(
            "agent_data_conflict",
            "This agent data changed. Reload it before saving again.",
        )),
        Ok(Some(bytes)) => {
            let current = sha256_hex(&bytes);
            if expected == Some(current.as_str()) {
                Ok(())
            } else {
                Err(AgentMindError::new(
                    "agent_data_conflict",
                    "This agent data changed. Reload it before saving again.",
                ))
            }
        }
        Err(_) => Err(AgentMindError::new(
            "agent_data_unreadable",
            "Agent data could not be read, so Kite left it unchanged.",
        )),
    }
}

fn write_agent_memory_at(
    root: &Path,
    agent_id: &str,
    target: &str,
    text: &str,
    edit_kind: &str,
    expected_revision: Option<&str>,
) -> Result<Value, AgentMindError> {
    ensure_agent_id(agent_id)?;
    if edit_kind != "structured" && edit_kind != "rawBuilderEdit" {
        return Err(AgentMindError::new(
            "agent_data_failed",
            "That memory edit could not be saved.",
        ));
    }
    if text.len() > MEMORY_BYTE_LIMIT {
        return Err(AgentMindError::new(
            "agent_data_too_large",
            "The agent data exceeds Kite's safe limit.",
        ));
    }
    if edit_kind == "structured" {
        let budget = if target == "user" {
            USER_CHAR_BUDGET
        } else {
            MEMORY_CHAR_BUDGET
        };
        if text.chars().count() > budget {
            return Err(AgentMindError::new(
                "memory_over_budget",
                "This edit exceeds the agent's memory budget.",
            ));
        }
    }
    let path = memory_path(root, agent_id, target)?;
    revision_matches(&path, expected_revision)?;
    prepare_file(root, &path)?;
    fs::write(&path, text).map_err(|_| {
        AgentMindError::new(
            "agent_data_failed",
            "Kite could not store this agent data.",
        )
    })?;
    let _ = sync_agent_instructions(root, agent_id);
    load_agent_mind_at(root, agent_id)
}

fn skill_path(root: &Path, agent_id: &str, skill_id: &str) -> PathBuf {
    root.join(agent_id)
        .join("skills")
        .join(format!("{skill_id}.md"))
}

fn read_skill_source(path: &Path) -> Result<Option<String>, AgentMindError> {
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

pub fn sync_agent_instructions(root: &Path, agent_id: &str) -> io::Result<()> {
    let dir = root.join(agent_id);
    let _ = fs::create_dir_all(&dir);
    let mem = read_text_record(&dir.join("memory.txt"), "memoryUnreadable").text;
    let usr = read_text_record(&dir.join("user.txt"), "userUnreadable").text;
    let (skills, _) = read_skills(&dir.join("skills"));

    let agent_opt = {
        let items = crate::persist::agents().lock().unwrap();
        items.iter().find(|a| a.id == agent_id).cloned()
    };

    let mut doc = String::new();
    if let Some(ref agent) = agent_opt {
        doc.push_str(&format!("# {}\n\n", agent.name));
        doc.push_str(&format!("Agent ID: `{agent_id}`\nEngine: `{}`\n\n", agent.engine));
        let brief_text = if !agent.brief.trim().is_empty() {
            agent.brief.trim()
        } else {
            agent.purpose.trim()
        };
        if !brief_text.is_empty() {
            if brief_text.starts_with('#') {
                doc.push_str(brief_text);
                doc.push_str("\n\n");
            } else {
                doc.push_str("## Role & Charter\n\n");
                doc.push_str(brief_text);
                doc.push_str("\n\n");
            }
        }
    } else {
        doc.push_str(&format!("# Agent Instructions\n\nAgent ID: `{agent_id}`\n\n"));
    }

    doc.push_str("Kite Code automatically synchronizes this context from memory, builder context, skills, and teammates.\n\n");

    if !mem.trim().is_empty() {
        doc.push_str("## Long-Term Memory (memory.txt)\n\n");
        doc.push_str(mem.trim());
        doc.push_str("\n\n");
    }
    if !usr.trim().is_empty() {
        doc.push_str("## Builder Context & Preferences (user.txt)\n\n");
        doc.push_str(usr.trim());
        doc.push_str("\n\n");
    }
    if !skills.is_empty() {
        doc.push_str("## Learned Skills\n\n");
        for skill in &skills {
            let id = skill.get("id").and_then(|v| v.as_str()).unwrap_or("skill");
            let name = skill.get("name").and_then(|v| v.as_str()).unwrap_or(id);
            let desc = skill.get("description").and_then(|v| v.as_str()).unwrap_or("");
            doc.push_str(&format!("### {name} (`{id}`)\n"));
            if !desc.is_empty() {
                doc.push_str(&format!("{desc}\n\n"));
            }
            let spath = dir.join("skills").join(format!("{id}.md"));
            if let Ok(Some(src)) = read_skill_source(&spath) {
                let body = src.split("---").nth(2).map(str::trim).unwrap_or(src.trim());
                if !body.is_empty() {
                    doc.push_str("```markdown\n");
                    doc.push_str(body);
                    doc.push_str("\n```\n\n");
                }
            }
        }
    }

    let allow_msg = agent_opt.as_ref().and_then(|a| a.allow_agent_messaging).unwrap_or(true);
    if allow_msg {
        let all_agents = {
            let items = crate::persist::agents().lock().unwrap();
            items.clone()
        };
        let teammates: Vec<_> = all_agents.iter().filter(|a| a.id != agent_id && a.allow_agent_messaging != Some(false)).collect();
        if !teammates.is_empty() {
            doc.push_str("## Teammates\n\nYou can collaborate with other agents via Kite agent messaging:\n\n");
            for t in teammates {
                let role = if !t.brief.is_empty() { &t.brief } else { &t.purpose };
                let first_sentence = role.lines().next().unwrap_or("").chars().take(120).collect::<String>();
                doc.push_str(&format!("- **{}** (`{}`): {}\n", t.name, t.id, first_sentence));
            }
            doc.push_str("\n");
        }
    }

    let _ = fs::write(dir.join("AGENTS.md"), &doc);
    let _ = fs::write(dir.join("CLAUDE.md"), &doc);
    let _ = fs::write(dir.join("README.md"), &doc);
    Ok(())
}

pub fn apply_post_turn_reflection(agent_id: &str, user_prompt: &str, _assistant_reply: &str) {
    let agent_opt = {
        let items = crate::persist::agents().lock().unwrap();
        items.iter().find(|a| a.id == agent_id).cloned()
    };
    let Some(agent) = agent_opt else { return };
    if agent.reflection_mode.as_deref() != Some("auto") {
        return;
    }

    let lower = user_prompt.to_lowercase();
    let has_intent = lower.contains("remember ")
        || lower.contains("always ")
        || lower.contains("never ")
        || lower.contains("prefer ")
        || lower.contains("from now on")
        || lower.contains("recuerda ")
        || lower.contains("guarda en memoria")
        || lower.contains("ten en cuenta");

    if !has_intent {
        return;
    }

    let note = user_prompt.trim().replace('\r', "");
    if note.is_empty() || note.len() > 600 {
        return;
    }

    let root = agents_root();
    let dir = root.join(agent_id);
    let mem_file = dir.join("memory.txt");
    let existing = fs::read_to_string(&mem_file).unwrap_or_default();
    let budget = agent.memory_budget.unwrap_or(2200) as usize;

    let new_entry = format!("- Preference: {}\n", note.lines().next().unwrap_or(&note).trim());
    if existing.contains(&new_entry.trim()) {
        return;
    }

    let mut combined = existing;
    if !combined.is_empty() && !combined.ends_with('\n') {
        combined.push('\n');
    }
    combined.push_str(&new_entry);

    if combined.len() <= budget {
        let _ = fs::write(&mem_file, &combined);
        let _ = sync_agent_instructions(&root, agent_id);
    }
}

fn store_skill_file(
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

fn skill_document(skill_id: &str, source: &str, path: &Path) -> Value {
    let (summary, _) = skill_summary(skill_id, source, path);
    let mut document = summary;
    if let Some(object) = document.as_object_mut() {
        object.insert("schemaVersion".to_string(), json!(1));
        object.insert("source".to_string(), json!(source));
    }
    document
}

fn load_agent_skill_at(root: &Path, agent_id: &str, skill_id: &str) -> Result<Value, AgentMindError> {
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

fn write_agent_skill_at(
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

fn remove_agent_skill_at(
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

fn starter_by_id(starter_id: &str) -> Result<&'static Starter, AgentMindError> {
    STARTERS
        .iter()
        .find(|starter| starter.id == starter_id)
        .ok_or_else(|| AgentMindError::new("agent_data_failed", "That starter is not in the catalog."))
}

fn starter_source(starter: &Starter) -> String {
    format!(
        "---\nname: {name}\ndescription: {description}\n---\n{body}\n",
        name = starter.name,
        description = starter.description,
        body = starter.body,
    )
}

fn starter_summaries() -> Vec<Value> {
    STARTERS
        .iter()
        .map(|starter| {
            json!({
                "id": starter.id,
                "title": starter.title,
                "summary": starter.summary,
            })
        })
        .collect()
}

fn install_agent_starter_at(
    root: &Path,
    agent_id: &str,
    starter_id: &str,
) -> Result<Value, AgentMindError> {
    let starter = starter_by_id(starter_id)?;
    store_skill_file(root, agent_id, starter.id, &starter_source(starter))?;
    let mind = load_agent_mind_at(root, agent_id)?;
    Ok(json!({
        "installed": true,
        "mind": mind,
    }))
}

#[tauri::command]
pub fn load_agent_mind(request: Value) -> Result<Value, AgentMindError> {
    let req = request_body(&request);
    let agent_id = req.get("agentId").and_then(|value| value.as_str()).unwrap_or("");
    require_known_agent(agent_id)?;
    load_agent_mind_at(&agents_root(), agent_id)
}

#[tauri::command]
pub fn write_agent_memory(request: Value) -> Result<Value, AgentMindError> {
    let req = request_body(&request);
    require_confirmation(req)?;
    let agent_id = req.get("agentId").and_then(|value| value.as_str()).unwrap_or("");
    require_known_agent(agent_id)?;
    let target = req.get("target").and_then(|value| value.as_str()).unwrap_or("");
    let text = req.get("text").and_then(|value| value.as_str()).unwrap_or("");
    let edit_kind = req.get("editKind").and_then(|value| value.as_str()).unwrap_or("");
    let expected = req.get("expectedRevision").and_then(|value| value.as_str());
    write_agent_memory_at(&agents_root(), agent_id, target, text, edit_kind, expected)
}

#[tauri::command]
pub fn load_agent_skill(request: Value) -> Result<Value, AgentMindError> {
    let req = request_body(&request);
    let agent_id = req.get("agentId").and_then(|value| value.as_str()).unwrap_or("");
    let skill_id = req.get("skillId").and_then(|value| value.as_str()).unwrap_or("");
    require_known_agent(agent_id)?;
    load_agent_skill_at(&agents_root(), agent_id, skill_id)
}

#[tauri::command]
pub fn write_agent_skill(request: Value) -> Result<Value, AgentMindError> {
    let req = request_body(&request);
    require_confirmation(req)?;
    let agent_id = req.get("agentId").and_then(|value| value.as_str()).unwrap_or("");
    let skill_id = req.get("skillId").and_then(|value| value.as_str()).unwrap_or("");
    let source = req.get("source").and_then(|value| value.as_str()).unwrap_or("");
    let expected = req.get("expectedRevision").and_then(|value| value.as_str());
    require_known_agent(agent_id)?;
    write_agent_skill_at(&agents_root(), agent_id, skill_id, source, expected)
}

#[tauri::command]
pub fn remove_agent_skill(request: Value) -> Result<Value, AgentMindError> {
    let req = request_body(&request);
    require_confirmation(req)?;
    let agent_id = req.get("agentId").and_then(|value| value.as_str()).unwrap_or("");
    let skill_id = req.get("skillId").and_then(|value| value.as_str()).unwrap_or("");
    let expected = req
        .get("expectedRevision")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    require_known_agent(agent_id)?;
    remove_agent_skill_at(&agents_root(), agent_id, skill_id, expected)
}

#[tauri::command]
pub fn list_agent_starters(request: Value) -> Vec<Value> {
    let _req = request_body(&request);
    starter_summaries()
}

#[tauri::command]
pub fn install_agent_starter(request: Value) -> Result<Value, AgentMindError> {
    let req = request_body(&request);
    require_confirmation(req)?;
    let agent_id = req.get("agentId").and_then(|value| value.as_str()).unwrap_or("");
    let starter_id = req.get("starterId").and_then(|value| value.as_str()).unwrap_or("");
    require_known_agent(agent_id)?;
    install_agent_starter_at(&agents_root(), agent_id, starter_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new() -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "kite-agent-mind-{}-{nanos}",
                std::process::id()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn writes_memory_installs_starter_and_removes_one_skill() {
        let root = TempRoot::new();
        let agent_id = "c3333333-3333-4333-8333-333333333333";

        let fresh = load_agent_mind_at(&root.0, agent_id).unwrap();
        assert!(!fresh.is_null());
        assert_eq!(fresh["memory"].as_str(), Some(""));
        assert!(fresh["memoryUpdatedAtUnixMs"].is_null());
        assert_eq!(fresh["memoryRevision"].as_str(), Some(empty_revision().as_str()));
        assert_eq!(fresh["skills"].as_array().map(|items| items.len()), Some(0));

        let written = write_agent_memory_at(
            &root.0,
            agent_id,
            "memory",
            "Ship the local note.",
            "rawBuilderEdit",
            fresh["memoryRevision"].as_str(),
        )
        .unwrap();
        assert!(!written.is_null());
        assert_eq!(written["memory"].as_str(), Some("Ship the local note."));
        assert_eq!(
            written["memoryRevision"].as_str().map(|revision| revision.len()),
            Some(64)
        );

        let loaded = load_agent_mind_at(&root.0, agent_id).unwrap();
        assert_eq!(loaded["memory"], written["memory"]);
        assert_eq!(loaded["memoryRevision"], written["memoryRevision"]);
        assert_eq!(
            fs::read_to_string(root.0.join(agent_id).join("memory.txt")).unwrap(),
            "Ship the local note."
        );

        let installed = install_agent_starter_at(&root.0, agent_id, "keep-a-memory").unwrap();
        assert_eq!(installed["installed"], json!(true));
        assert_eq!(
            installed["mind"]["memory"].as_str(),
            Some("Ship the local note.")
        );
        let starter = load_agent_skill_at(&root.0, agent_id, "keep-a-memory").unwrap();
        assert!(starter["source"]
            .as_str()
            .unwrap()
            .contains("Write one durable line into agent memory"));
        assert_eq!(starter["name"].as_str(), Some("Keep a memory"));

        let extra = "---\nname: Local notes\ndescription: Notes that stay on this machine.\n---\nKeep the extra procedure.\n";
        write_agent_skill_at(&root.0, agent_id, "local-notes", extra, None).unwrap();
        let kept = load_agent_skill_at(&root.0, agent_id, "local-notes").unwrap();
        assert_eq!(kept["source"].as_str(), Some(extra));

        let revision = starter["revision"].as_str().unwrap();
        let removed = remove_agent_skill_at(&root.0, agent_id, "keep-a-memory", revision).unwrap();
        assert_eq!(removed["removed"], json!(true));
        assert_eq!(removed["mind"]["memory"].as_str(), Some("Ship the local note."));
        let remaining: Vec<&str> = removed["mind"]["skills"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|skill| skill["id"].as_str())
            .collect();
        assert_eq!(remaining, vec!["local-notes"]);
        assert!(!root
            .0
            .join(agent_id)
            .join("skills")
            .join("keep-a-memory.md")
            .exists());
        assert_eq!(
            fs::read_to_string(root.0.join(agent_id).join("skills").join("local-notes.md")).unwrap(),
            extra
        );
        assert!(root.0.join(agent_id).join("AGENTS.md").exists());
        let agents_md = fs::read_to_string(root.0.join(agent_id).join("AGENTS.md")).unwrap();
        assert!(agents_md.contains("Ship the local note."));
        assert!(agents_md.contains("local-notes"));

        let missing = load_agent_skill_at(&root.0, agent_id, "keep-a-memory").unwrap_err();
        assert_eq!(missing.code, "agent_data_unreadable");
        assert!(!missing.message.is_empty());

        let unknown = load_agent_mind_at(&root.0, "not-an-agent").unwrap_err();
        assert_eq!(unknown.code, "agent_data_failed");
        assert!(!unknown.message.is_empty());

        let starters = list_agent_starters(json!({ "request": { "supportedCatalogVersion": 1 } }));
        assert_eq!(
            starters.iter().filter_map(|s| s["id"].as_str()).collect::<Vec<_>>(),
            vec!["keep-a-memory", "write-a-skill", "research-a-question", "draft-for-a-reader", "root-cause"]
        );
    }
}
