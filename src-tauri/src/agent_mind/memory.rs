use crate::agent_mind::skills::{read_skill_source, read_skills};
use crate::agent_mind::types::{
    AgentMindError, MEMORY_BYTE_LIMIT, MEMORY_CHAR_BUDGET, USER_CHAR_BUDGET,
};
use crate::agent_mind::utils::{
    agents_root, empty_revision, ensure_agent_id, get_agent_home_dir, has_disallowed_control,
    issue, prepare_file, read_regular, read_text_record, require_confirmation,
    require_known_agent, sha256_hex,
};
use serde_json::{json, Value};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

pub fn load_agent_mind_at(root: &Path, agent_id: &str) -> Result<Value, AgentMindError> {
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

pub(crate) fn memory_path(root: &Path, agent_id: &str, target: &str) -> Result<PathBuf, AgentMindError> {
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

pub(crate) fn revision_matches(path: &Path, expected: Option<&str>) -> Result<(), AgentMindError> {
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

pub(crate) fn write_agent_memory_at(
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


/// One skill as it appears in an instruction document.
pub(crate) struct InstructionSkill<'a> {
    pub(crate) id: &'a str,
    /// `None` when only the identity of the skill is known, as in a recipe
    /// snapshot. The document then lists the id without a body.
    pub(crate) name: Option<&'a str>,
    pub(crate) description: &'a str,
    pub(crate) body: Option<&'a str>,
}

/// The recipe fields an instruction document is built from.
pub(crate) struct InstructionSource<'a> {
    pub(crate) agent_id: &'a str,
    pub(crate) title: &'a str,
    pub(crate) engine: Option<&'a str>,
    pub(crate) role: &'a str,
    pub(crate) memory: &'a str,
    pub(crate) user: &'a str,
    pub(crate) skills: &'a [InstructionSkill<'a>],
}

/// Title used when the document is written outside the agent home and the
/// agent display name is not part of the recipe.
pub(crate) const WORKSPACE_RECIPE_TITLE: &str = "Agent Instructions";

/// The document body shared by the agent-home sync and the workspace apply.
pub(crate) fn instruction_document(source: &InstructionSource<'_>) -> String {
    let mut doc = String::new();
    doc.push_str(&format!("# {}\n\n", source.title));
    match source.engine {
        Some(engine) => doc.push_str(&format!(
            "Agent ID: `{}`\nEngine: `{engine}`\n\n",
            source.agent_id
        )),
        None => doc.push_str(&format!("Agent ID: `{}`\n\n", source.agent_id)),
    }

    let role = source.role.trim();
    if !role.is_empty() {
        if role.starts_with('#') {
            doc.push_str(role);
            doc.push_str("\n\n");
        } else {
            doc.push_str("## Role & Charter\n\n");
            doc.push_str(role);
            doc.push_str("\n\n");
        }
    }

    doc.push_str("Kite Code automatically synchronizes this context from memory, builder context, skills, and teammates.\n\n");

    if !source.memory.trim().is_empty() {
        doc.push_str("## Long-Term Memory (memory.txt)\n\n");
        doc.push_str(source.memory.trim());
        doc.push_str("\n\n");
    }
    if !source.user.trim().is_empty() {
        doc.push_str("## Builder Context & Preferences (user.txt)\n\n");
        doc.push_str(source.user.trim());
        doc.push_str("\n\n");
    }
    if !source.skills.is_empty() {
        doc.push_str("## Learned Skills\n\n");
        for skill in source.skills {
            match skill.name {
                Some(name) => {
                    doc.push_str(&format!("### {name} (`{}`)\n", skill.id));
                    if !skill.description.is_empty() {
                        doc.push_str(&format!("{}\n\n", skill.description));
                    }
                    if let Some(body) = skill.body.filter(|body| !body.is_empty()) {
                        doc.push_str("```markdown\n");
                        doc.push_str(body);
                        doc.push_str("\n```\n\n");
                    }
                }
                None => doc.push_str(&format!("- `{}`\n\n", skill.id)),
            }
        }
    }
    doc
}

/// A skill summary plus the body read from the agent home.
struct SkillRecord {
    id: String,
    name: String,
    description: String,
    body: Option<String>,
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

    let skill_records: Vec<SkillRecord> = skills
        .iter()
        .map(|skill| {
            let id = skill
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("skill")
                .to_string();
            let name = skill
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or(id.as_str())
                .to_string();
            let description = skill
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let body = read_skill_source(&dir.join("skills").join(format!("{id}.md")))
                .ok()
                .flatten()
                .map(|src| {
                    src.split("---")
                        .nth(2)
                        .map(str::trim)
                        .unwrap_or(src.trim())
                        .to_string()
                })
                .filter(|body| !body.is_empty());
            SkillRecord {
                id,
                name,
                description,
                body,
            }
        })
        .collect();
    let instruction_skills: Vec<InstructionSkill<'_>> = skill_records
        .iter()
        .map(|skill| InstructionSkill {
            id: &skill.id,
            name: Some(&skill.name),
            description: &skill.description,
            body: skill.body.as_deref(),
        })
        .collect();

    let (title, engine, role) = match agent_opt.as_ref() {
        Some(agent) => (
            agent.name.as_str(),
            Some(agent.engine.as_str()),
            if !agent.brief.trim().is_empty() {
                agent.brief.trim()
            } else {
                agent.purpose.trim()
            },
        ),
        None => (WORKSPACE_RECIPE_TITLE, None, ""),
    };

    let mut doc = instruction_document(&InstructionSource {
        agent_id,
        title,
        engine,
        role,
        memory: &mem,
        user: &usr,
        skills: &instruction_skills,
    });

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

/// The recipe fields that live in the agent home. Unreadable files read as
/// empty text, the same way the instruction sync treats them.
pub(crate) struct AgentRecipeFiles {
    pub(crate) memory: String,
    pub(crate) user: String,
    pub(crate) skills: Vec<String>,
}

pub(crate) fn read_agent_recipe_at(root: &Path, agent_id: &str) -> AgentRecipeFiles {
    let dir = root.join(agent_id);
    let memory = read_text_record(&dir.join("memory.txt"), "memoryUnreadable").text;
    let user = read_text_record(&dir.join("user.txt"), "userUnreadable").text;
    let (skills, _) = read_skills(&dir.join("skills"));
    let skills = skills
        .iter()
        .filter_map(|skill| {
            skill
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect();
    AgentRecipeFiles {
        memory,
        user,
        skills,
    }
}

/// Writes a recipe into a workspace through the same document builder the
/// agent home uses. `AGENTS.md` and `CLAUDE.md` belong to the recipe;
/// `README.md` belongs to the workspace and is never touched here.
pub(crate) fn write_recipe_instructions(
    target: &Path,
    agent_id: &str,
    role: &str,
    memory: &str,
    user: &str,
    skills: &[String],
) -> io::Result<()> {
    let instruction_skills: Vec<InstructionSkill<'_>> = skills
        .iter()
        .map(|id| InstructionSkill {
            id,
            name: None,
            description: "",
            body: None,
        })
        .collect();
    let doc = instruction_document(&InstructionSource {
        agent_id,
        title: WORKSPACE_RECIPE_TITLE,
        engine: None,
        role,
        memory,
        user,
        skills: &instruction_skills,
    });
    fs::write(target.join("AGENTS.md"), &doc)?;
    fs::write(target.join("CLAUDE.md"), &doc)?;
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

