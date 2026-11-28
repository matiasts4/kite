use crate::agent_mind::skills::{
    check_skill_eligibility, is_skill_enabled, parse_skill_frontmatter,
    read_linked_skill_content_in_roots, read_skill_source, read_skills, read_skills_meta,
};
use crate::agent_mind::types::{
    AgentMindError, TextRecord, MEMORY_BYTE_LIMIT, MEMORY_CHAR_BUDGET, USER_CHAR_BUDGET,
};
use crate::agent_mind::utils::{
    agents_root, empty_revision, ensure_agent_id, get_agent_home_dir,
    prepare_file, read_regular, read_text_record, sha256_hex,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

pub(crate) fn clamp_memory_budget(configured: Option<i64>) -> usize {
    match configured {
        Some(v) if v > 0 => (v as usize).min(MEMORY_BYTE_LIMIT),
        _ => MEMORY_CHAR_BUDGET,
    }
}

pub(crate) fn resolve_agent_memory_budget(agent_id: &str) -> usize {
    let configured = crate::persist::agents()
        .lock()
        .ok()
        .and_then(|items| {
            items
                .iter()
                .find(|a| a.id == agent_id)
                .and_then(|a| a.memory_budget)
        });
    clamp_memory_budget(configured)
}

fn read_shared_user_record(root: &Path, agent_id: &str) -> TextRecord {
    let shared = root.join("user.txt");
    if shared.exists() {
        return read_text_record(&shared, "userUnreadable");
    }
    let legacy = root.join(agent_id).join("user.txt");
    if legacy.exists() {
        return read_text_record(&legacy, "userUnreadable");
    }
    read_text_record(&shared, "userUnreadable")
}

pub fn load_agent_mind_at(root: &Path, agent_id: &str) -> Result<Value, AgentMindError> {
    ensure_agent_id(agent_id)?;
    let dir = root.join(agent_id);
    let memory = read_text_record(&dir.join("memory.txt"), "memoryUnreadable");
    let user = read_shared_user_record(root, agent_id);
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
    let memory_meta = load_memory_meta_map(root, agent_id);
    let linked_skill_refs = crate::persist::get_agent_linked_skill_refs(agent_id);
    Ok(json!({
        "schemaVersion": 1,
        "agentId": agent_id,
        "memory": memory.text,
        "user": user.text,
        "skills": skills,
        "linkedSkillRefs": linked_skill_refs,
        "memoryUpdatedAtUnixMs": memory.updated_at,
        "userUpdatedAtUnixMs": user.updated_at,
        "memoryRevision": memory.revision,
        "userRevision": user.revision,
        "memoryMeta": memory_meta,
        "readIssues": read_issues,
    }))
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEntryMeta {
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub last_verified_at_unix_ms: i64,
}

pub fn memory_entry_key(entry_text: &str) -> String {
    normalize_memory_line(entry_text)
        .chars()
        .take(160)
        .collect()
}

pub fn memory_meta_path(root: &Path, agent_id: &str) -> PathBuf {
    root.join(agent_id).join("memory-meta.json")
}

pub fn load_memory_meta_map(
    root: &Path,
    agent_id: &str,
) -> std::collections::HashMap<String, MemoryEntryMeta> {
    fs::read_to_string(memory_meta_path(root, agent_id))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn update_memory_meta_at(
    root: &Path,
    agent_id: &str,
    entry_text: &str,
    action: &str,
    now_unix_ms: i64,
) -> Result<std::collections::HashMap<String, MemoryEntryMeta>, AgentMindError> {
    ensure_agent_id(agent_id)?;
    let key = memory_entry_key(entry_text);
    let mut map = load_memory_meta_map(root, agent_id);
    let mut meta = map.get(&key).cloned().unwrap_or_default();
    match action {
        "pin" => meta.pinned = true,
        "unpin" => meta.pinned = false,
        "archive" => {
            meta.archived = true;
            meta.pinned = false;
        }
        "unarchive" => meta.archived = false,
        "verify" => meta.last_verified_at_unix_ms = now_unix_ms,
        _ => {
            return Err(AgentMindError::new(
                "agent_data_failed",
                "Unknown memory metadata action.",
            ))
        }
    }
    if meta.last_verified_at_unix_ms == 0 {
        meta.last_verified_at_unix_ms = now_unix_ms;
    }
    map.insert(key, meta);
    let dir = root.join(agent_id);
    fs::create_dir_all(&dir).map_err(|_| {
        AgentMindError::new("agent_data_failed", "Could not create agent directory.")
    })?;
    let body = serde_json::to_string_pretty(&map).map_err(|_| {
        AgentMindError::new("agent_data_failed", "Could not serialize memory metadata.")
    })?;
    fs::write(memory_meta_path(root, agent_id), body).map_err(|_| {
        AgentMindError::new("agent_data_failed", "Could not write memory metadata.")
    })?;
    Ok(map)
}

fn normalize_memory_line(raw: &str) -> String {
    let trimmed = raw.trim().trim_start_matches('-').trim();
    let stripped = trimmed
        .strip_prefix("Decision:")
        .or_else(|| trimmed.strip_prefix("Convention:"))
        .or_else(|| trimmed.strip_prefix("Constraint:"))
        .or_else(|| trimmed.strip_prefix("Preference:"))
        .unwrap_or(trimmed);
    stripped
        .split(|c: char| !c.is_alphanumeric())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_ascii_lowercase())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Computes normalized token Jaccard similarity in `[0.0, 1.0]` for fuzzy memory deduplication.
pub fn jaccard_similarity(a: &str, b: &str) -> f64 {
    let norm_a = normalize_memory_line(a);
    let norm_b = normalize_memory_line(b);
    let set_a: std::collections::HashSet<&str> = norm_a.split_whitespace().collect();
    let set_b: std::collections::HashSet<&str> = norm_b.split_whitespace().collect();
    if set_a.is_empty() && set_b.is_empty() {
        return 1.0;
    }
    if set_a.is_empty() || set_b.is_empty() {
        return 0.0;
    }
    let inter = set_a.intersection(&set_b).count() as f64;
    let union = set_a.union(&set_b).count() as f64;
    if union == 0.0 {
        0.0
    } else {
        inter / union
    }
}

pub fn find_similar_memory_entries(
    existing: &str,
    candidate: &str,
    threshold: f64,
) -> Vec<(usize, String, f64)> {
    let mut hits = Vec::new();
    for (idx, line) in existing.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let sim = jaccard_similarity(trimmed, candidate);
        if sim >= threshold {
            hits.push((idx, trimmed.to_string(), sim));
        }
    }
    hits.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));
    hits
}

pub(crate) fn memory_path(root: &Path, agent_id: &str, target: &str) -> Result<PathBuf, AgentMindError> {
    match target {
        "memory" => Ok(root.join(agent_id).join("memory.txt")),
        "user" => Ok(root.join("user.txt")),
        _ => Err(AgentMindError::new(
            "agent_data_failed",
            "That memory target is not available.",
        )),
    }
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
    write_agent_memory_at_with_budget(
        root,
        agent_id,
        target,
        text,
        edit_kind,
        expected_revision,
        None,
    )
}

pub(crate) fn write_agent_memory_at_with_budget(
    root: &Path,
    agent_id: &str,
    target: &str,
    text: &str,
    edit_kind: &str,
    expected_revision: Option<&str>,
    memory_budget: Option<usize>,
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
            memory_budget
                .map(|b| b.clamp(1, MEMORY_BYTE_LIMIT))
                .unwrap_or_else(|| resolve_agent_memory_budget(agent_id))
        };
        if text.chars().count() > budget {
            return Err(AgentMindError::new(
                "memory_over_budget",
                "This edit exceeds the agent's memory budget.",
            ));
        }
    }
    let path = memory_path(root, agent_id, target)?;
    let revision_path = if target == "user" && !path.exists() {
        let legacy = root.join(agent_id).join("user.txt");
        if legacy.exists() {
            legacy
        } else {
            path.clone()
        }
    } else {
        path.clone()
    };
    revision_matches(&revision_path, expected_revision)?;
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
    pub(crate) context_mode: Option<&'a str>,
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
                    if skill.context_mode == Some("fork") {
                        doc.push_str("Context: `fork` (run in an isolated subagent context).\n\n");
                    }
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

/// A skill summary plus the body read from the agent home or linked skill root.
struct SkillRecord {
    id: String,
    name: String,
    description: String,
    body: Option<String>,
    context_mode: String,
}

/// A manual-only skill listed as a lightweight catalog entry without injecting its body.
struct ManualSkillCatalogEntry {
    ref_or_id: String,
    name: String,
    description: String,
    path: String,
    context_mode: String,
}

fn push_unique_dir(roots: &mut Vec<PathBuf>, candidate: PathBuf) {
    if candidate.is_dir() && !roots.iter().any(|existing| existing == &candidate) {
        roots.push(candidate);
    }
}

pub(crate) fn resolve_agent_workspace_roots(
    agent_opt: Option<&crate::persist::AgentProfile>,
    agent_id: &str,
) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    let workspaces = crate::persist::workspaces()
        .lock()
        .map(|w| w.clone())
        .unwrap_or_default();

    if let Some(agent) = agent_opt {
        for raw in &agent.place_display_names {
            let place = raw.trim();
            if place.is_empty() {
                continue;
            }
            if let Some(ws) = workspaces
                .iter()
                .find(|w| w.display_name.eq_ignore_ascii_case(place) || w.id == place)
            {
                if let Some(path) = crate::persist::workspace_path(&ws.id) {
                    push_unique_dir(&mut roots, PathBuf::from(path));
                }
            } else {
                push_unique_dir(&mut roots, PathBuf::from(place));
            }
        }
    }

    let thread_ws_ids: Vec<String> = crate::persist::threads()
        .lock()
        .map(|list| {
            let mut entries: Vec<(i64, String)> = list
                .iter()
                .filter(|t| t.get("profileId").and_then(Value::as_str) == Some(agent_id))
                .filter_map(|t| {
                    let ws_id = t.get("workspaceId").and_then(Value::as_str)?.trim();
                    if ws_id.is_empty() {
                        return None;
                    }
                    let updated = t.get("updatedAtUnixMs").and_then(Value::as_i64).unwrap_or(0);
                    Some((updated, ws_id.to_string()))
                })
                .collect();
            entries.sort_by(|a, b| b.0.cmp(&a.0));
            entries.into_iter().map(|(_, id)| id).collect()
        })
        .unwrap_or_default();
    for ws_id in thread_ws_ids {
        if let Some(path) = crate::persist::workspace_path(&ws_id) {
            push_unique_dir(&mut roots, PathBuf::from(path));
        }
    }

    let mut sorted_ws = workspaces;
    sorted_ws.sort_by(|a, b| b.last_opened_at_unix_ms.cmp(&a.last_opened_at_unix_ms));
    for ws in sorted_ws {
        if let Some(path) = crate::persist::workspace_path(&ws.id) {
            push_unique_dir(&mut roots, PathBuf::from(path));
        }
    }

    roots
}

/// Compiles agent instructions preserving snapshot isolation: `role`, `memory`, and `user`
/// are taken directly from the caller's arguments (e.g. from the frozen `RecipeSnapshot`),
/// while local and linked skills are checked for eligibility and separated by `manual_only`.
pub fn compile_snapshot_instructions_at(
    root: &Path,
    agent_id: &str,
    role: &str,
    memory: &str,
    user: &str,
    skill_ids: &[String],
) -> String {
    let agent_opt = {
        let items = crate::persist::agents().lock().unwrap();
        items.iter().find(|a| a.id == agent_id).cloned()
    };
    let linked_refs = crate::persist::get_agent_linked_skill_refs(agent_id);
    let workspace_roots = resolve_agent_workspace_roots(agent_opt.as_ref(), agent_id);
    let home = crate::chat::utils::user_home_dir();
    compile_snapshot_instructions_with_context_at(
        root,
        agent_id,
        role,
        memory,
        user,
        skill_ids,
        &linked_refs,
        &workspace_roots,
        &home,
    )
}

pub fn compile_snapshot_instructions_with_context_at(
    root: &Path,
    agent_id: &str,
    role: &str,
    memory: &str,
    user: &str,
    skill_ids: &[String],
    linked_skill_refs: &[String],
    workspace_roots: &[PathBuf],
    home: &Path,
) -> String {
    let dir = root.join(agent_id);
    let agent_opt = {
        let items = crate::persist::agents().lock().unwrap();
        items.iter().find(|a| a.id == agent_id).cloned()
    };

    let skills_meta = read_skills_meta(&dir);
    let mut skill_records: Vec<SkillRecord> = Vec::new();
    let mut manual_skills: Vec<ManualSkillCatalogEntry> = Vec::new();
    let mut seen_local = HashSet::new();

    for id in skill_ids {
        if !seen_local.insert(id.as_str()) || !is_skill_enabled(&skills_meta, id) {
            continue;
        }
        let skill_file = dir.join("skills").join(format!("{id}.md"));
        if let Ok(Some(src)) = read_skill_source(&skill_file) {
            let (fm, body) = parse_skill_frontmatter(&src);
            let (eligible, _) = check_skill_eligibility(&fm);
            if !eligible {
                continue;
            }
            let name = fm
                .name
                .filter(|n| !n.trim().is_empty())
                .unwrap_or_else(|| id.to_string());
            let description = fm.description.unwrap_or_default();
            if fm.manual_only {
                manual_skills.push(ManualSkillCatalogEntry {
                    ref_or_id: id.to_string(),
                    name,
                    description,
                    path: skill_file.to_string_lossy().to_string(),
                    context_mode: fm.context_mode,
                });
            } else {
                let body_opt = (!body.is_empty()).then_some(body);
                skill_records.push(SkillRecord {
                    id: id.to_string(),
                    name,
                    description,
                    body: body_opt,
                    context_mode: fm.context_mode,
                });
            }
        } else {
            skill_records.push(SkillRecord {
                id: id.to_string(),
                name: id.to_string(),
                description: String::new(),
                body: None,
                context_mode: "inline".to_string(),
            });
        }
    }

    let mut seen_refs = HashSet::new();
    for raw_ref in linked_skill_refs {
        let ref_key = raw_ref.trim();
        if ref_key.is_empty() || !seen_refs.insert(ref_key.to_string()) {
            continue;
        }
        let Ok(loaded) = read_linked_skill_content_in_roots(ref_key, workspace_roots, home) else {
            continue;
        };
        let (eligible, _) = check_skill_eligibility(&loaded.frontmatter);
        if !eligible {
            continue;
        }
        let name = loaded
            .frontmatter
            .name
            .filter(|n| !n.trim().is_empty())
            .unwrap_or_else(|| loaded.id.clone());
        let description = loaded.frontmatter.description.unwrap_or_default();
        if loaded.frontmatter.manual_only {
            manual_skills.push(ManualSkillCatalogEntry {
                ref_or_id: loaded.ref_key,
                name,
                description,
                path: loaded.path,
                context_mode: loaded.frontmatter.context_mode,
            });
        } else {
            let body_opt = (!loaded.body.is_empty()).then_some(loaded.body);
            skill_records.push(SkillRecord {
                id: loaded.ref_key,
                name,
                description,
                body: body_opt,
                context_mode: loaded.frontmatter.context_mode,
            });
        }
    }

    let instruction_skills: Vec<InstructionSkill<'_>> = skill_records
        .iter()
        .map(|skill| InstructionSkill {
            id: &skill.id,
            name: Some(&skill.name),
            description: &skill.description,
            body: skill.body.as_deref(),
            context_mode: Some(skill.context_mode.as_str()),
        })
        .collect();

    let (title, engine) = match agent_opt.as_ref() {
        Some(agent) => (agent.name.as_str(), Some(agent.engine.as_str())),
        None => (WORKSPACE_RECIPE_TITLE, None),
    };

    let mut doc = instruction_document(&InstructionSource {
        agent_id,
        title,
        engine,
        role,
        memory,
        user,
        skills: &instruction_skills,
    });

    if !manual_skills.is_empty() {
        doc.push_str("## Manual-Trigger Skills (Explicit User Request Only)\n\n");
        doc.push_str("These skills require an explicit user command before running. Never auto-invoke them unprompted:\n\n");
        for entry in &manual_skills {
            let trigger = if entry.description.trim().is_empty() {
                "Explicit user trigger required".to_string()
            } else {
                entry.description.trim().to_string()
            };
            let fork_badge = if entry.context_mode == "fork" {
                " [context: fork]"
            } else {
                ""
            };
            doc.push_str(&format!(
                "- **{}** (`{}`){} — {} (`{}`)\n",
                entry.name, entry.ref_or_id, fork_badge, trigger, entry.path
            ));
        }
        doc.push('\n');
    }

    let allow_msg = agent_opt
        .as_ref()
        .and_then(|a| a.allow_agent_messaging)
        .unwrap_or(true);
    if allow_msg {
        let all_agents = {
            let items = crate::persist::agents().lock().unwrap();
            items.clone()
        };
        let teammates: Vec<_> = all_agents
            .iter()
            .filter(|a| a.id != agent_id && a.allow_agent_messaging != Some(false))
            .collect();
        if !teammates.is_empty() {
            doc.push_str("## Teammates\n\nYou can collaborate with other agents via Kite agent messaging:\n\n");
            for t in teammates {
                let r = if !t.brief.is_empty() {
                    &t.brief
                } else {
                    &t.purpose
                };
                let first_sentence = r
                    .lines()
                    .next()
                    .unwrap_or("")
                    .chars()
                    .take(120)
                    .collect::<String>();
                doc.push_str(&format!("- **{}** (`{}`): {}\n", t.name, t.id, first_sentence));
            }
            doc.push_str("\n");
        }
    }

    if let Some(agent) = agent_opt.as_ref() {
        let places = resolve_authorized_places(&agent.place_display_names);
        if !places.is_empty() {
            doc.push_str("## Places (Authorized Roots)\n\nYou have authorized access to these project roots:\n\n");
            for line in places {
                doc.push_str(&format!("- {line}\n"));
            }
            doc.push_str("\n");
        }
    }
    let knowledge_manifest =
        crate::agent_mind::knowledge::render_knowledge_manifest_at(root, agent_id);
    if !knowledge_manifest.is_empty() {
        doc.push_str(&knowledge_manifest);
    }
    doc
}

fn resolve_authorized_places(place_display_names: &[String]) -> Vec<String> {
    if place_display_names.is_empty() {
        return Vec::new();
    }
    let workspaces = crate::persist::workspaces()
        .lock()
        .map(|w| w.clone())
        .unwrap_or_default();
    let mut resolved = Vec::new();
    for raw in place_display_names {
        let place = raw.trim();
        if place.is_empty() {
            continue;
        }
        if let Some(ws) = workspaces
            .iter()
            .find(|w| w.display_name.eq_ignore_ascii_case(place) || w.id == place)
        {
            if let Some(path) = crate::persist::workspace_path(&ws.id) {
                resolved.push(format!("**{}** (`{}`)", ws.display_name, path));
            } else {
                resolved.push(format!("**{}**", ws.display_name));
            }
        } else if Path::new(place).is_dir() {
            resolved.push(format!("`{place}`"));
        }
    }
    resolved
}

/// Builds the complete compiled agent instruction document reading current state on disk.
pub fn build_compiled_agent_instructions(root: &Path, agent_id: &str) -> String {
    let dir = root.join(agent_id);
    let mem = read_text_record(&dir.join("memory.txt"), "memoryUnreadable").text;
    let usr = read_shared_user_record(root, agent_id).text;
    let (skills, _) = read_skills(&dir.join("skills"));
    let skill_ids: Vec<String> = skills
        .iter()
        .filter(|s| s.get("enabled").and_then(Value::as_bool).unwrap_or(true))
        .filter_map(|s| s.get("id").and_then(Value::as_str).map(str::to_string))
        .collect();

    let agent_opt = {
        let items = crate::persist::agents().lock().unwrap();
        items.iter().find(|a| a.id == agent_id).cloned()
    };
    let role = match agent_opt.as_ref() {
        Some(agent) => {
            if !agent.brief.trim().is_empty() {
                agent.brief.trim()
            } else {
                agent.purpose.trim()
            }
        }
        None => "",
    };
    compile_snapshot_instructions_at(root, agent_id, role, &mem, &usr, &skill_ids)
}

/// Convenience helper to compile agent instructions against the canonical agents root directory.
pub fn compile_agent_instructions(agent_id: &str) -> String {
    let root = agents_root();
    build_compiled_agent_instructions(&root, agent_id)
}

pub fn sync_agent_instructions(root: &Path, agent_id: &str) -> io::Result<()> {
    let dir = root.join(agent_id);
    let _ = fs::create_dir_all(&dir);
    let doc = build_compiled_agent_instructions(root, agent_id);

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
    let user = read_shared_user_record(root, agent_id).text;
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

/// Detects whether a path resides inside a Git repository.
pub(crate) fn is_git_repository(dir: &Path) -> bool {
    let mut current = Some(dir);
    while let Some(path) = current {
        if path.join(".git").exists() {
            return true;
        }
        current = path.parent();
    }
    false
}

/// Writes a recipe into a target directory non-destructively.
///
/// To protect developer codebases and agent homes:
/// 1. Agent home directories are never overwritten with stripped `InstructionSkill` records;
///    instead, complete instructions are safely synced.
/// 2. Repository `AGENTS.md` and `CLAUDE.md` files are NEVER overwritten or created on disk.
/// 3. In non-repository sandbox directories, writes standard instruction files.
pub(crate) fn write_recipe_instructions(
    target: &Path,
    agent_id: &str,
    role: &str,
    memory: &str,
    user: &str,
    skills: &[String],
) -> io::Result<()> {
    // 1. If target is an agent's dedicated home directory, sync complete instructions rather
    // than overwriting with stripped InstructionSkill payloads.
    let home = get_agent_home_dir(agent_id);
    if target == home || (target.join("skills").is_dir() && target.join("memory.txt").is_file()) {
        let root = home.parent().unwrap_or(Path::new("."));
        return sync_agent_instructions(root, agent_id);
    }

    // 2. Never overwrite existing repository instruction files
    if target.join("AGENTS.md").exists() || target.join("CLAUDE.md").exists() {
        return Ok(());
    }

    // 3. Never write recipe instructions directly into a git repository
    if is_git_repository(target) {
        return Ok(());
    }

    let instruction_skills: Vec<InstructionSkill<'_>> = skills
        .iter()
        .map(|id| InstructionSkill {
            id,
            name: None,
            description: "",
            body: None,
            context_mode: None,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReflectionCandidate {
    pub agent_id: String,
    pub note: String,
    pub summary: String,
}

fn contains_sensitive_token(text: &str) -> bool {
    let lower = text.to_lowercase();
    lower.contains("sk-")
        || lower.contains("ghp_")
        || lower.contains("password=")
        || lower.contains("token=")
        || lower.contains("api_key=")
}

fn clean_single_line(raw: &str, max_chars: usize) -> String {
    raw.replace('\r', " ")
        .replace('\n', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max_chars)
        .collect()
}

pub(crate) fn extract_reflection_candidate(
    user_prompt: &str,
    assistant_reply: &str,
) -> Option<(String, String)> {
    let prompt_clean = clean_single_line(user_prompt, 400);
    if prompt_clean.is_empty() || contains_sensitive_token(&prompt_clean) {
        return None;
    }
    let lower = prompt_clean.to_lowercase();

    let (category, body) = if lower.contains("our convention")
        || lower.contains("convention:")
        || lower.contains("coding standard")
        || lower.contains("style rule")
    {
        ("Convention", prompt_clean.clone())
    } else if lower.contains("constraint:")
        || lower.contains("never ")
        || lower.contains("do not ")
        || lower.contains("don't ")
        || lower.contains("nunca ")
        || lower.contains("must not ")
    {
        ("Constraint", prompt_clean.clone())
    } else if lower.contains("we decided")
        || lower.contains("decision:")
        || lower.contains("let's go with")
        || lower.contains("use ") && lower.contains(" instead of ")
    {
        ("Decision", prompt_clean.clone())
    } else if lower.contains("remember ")
        || lower.contains("always ")
        || lower.contains("prefer ")
        || lower.contains("from now on")
        || lower.contains("recuerda ")
        || lower.contains("guarda en memoria")
        || lower.contains("ten en cuenta")
        || lower.contains("siempre ")
        || lower.contains("prefiero ")
    {
        ("Preference", prompt_clean.clone())
    } else {
        // Check assistant reply for explicit structured Decision/Convention/Constraint lines
        let mut found: Option<(&'static str, String)> = None;
        for line in assistant_reply.lines() {
            let trimmed = line.trim().trim_start_matches('-').trim();
            if let Some(rest) = trimmed.strip_prefix("Decision:") {
                let c = clean_single_line(rest, 240);
                if !c.is_empty() && !contains_sensitive_token(&c) {
                    found = Some(("Decision", c));
                    break;
                }
            } else if let Some(rest) = trimmed.strip_prefix("Convention:") {
                let c = clean_single_line(rest, 240);
                if !c.is_empty() && !contains_sensitive_token(&c) {
                    found = Some(("Convention", c));
                    break;
                }
            } else if let Some(rest) = trimmed.strip_prefix("Constraint:") {
                let c = clean_single_line(rest, 240);
                if !c.is_empty() && !contains_sensitive_token(&c) {
                    found = Some(("Constraint", c));
                    break;
                }
            }
        }
        found?
    };

    let summary = clean_single_line(&body, 140);
    let note = format!("- {category}: {body}");
    Some((note, summary))
}

pub fn apply_post_turn_reflection_at(
    root: &Path,
    agent_id: &str,
    user_prompt: &str,
    assistant_reply: &str,
) -> Option<ReflectionCandidate> {
    let agent_opt = {
        let items = crate::persist::agents().lock().unwrap();
        items.iter().find(|a| a.id == agent_id).cloned()
    };
    let agent = agent_opt?;
    let mode = agent.reflection_mode.as_deref().unwrap_or("ask");
    if mode != "auto" && mode != "ask" {
        return None;
    }

    let (new_entry, summary) = extract_reflection_candidate(user_prompt, assistant_reply)?;

    let dir = root.join(agent_id);
    let mem_file = dir.join("memory.txt");
    let existing = fs::read_to_string(&mem_file).unwrap_or_default();
    let budget = clamp_memory_budget(agent.memory_budget);

    let normalized_new = new_entry.trim().to_lowercase();
    if existing.lines().any(|line| {
        let line_lower = line.trim().to_lowercase();
        line_lower == normalized_new || jaccard_similarity(line, &new_entry) >= 0.85
    }) || existing.to_lowercase().contains(&normalized_new)
    {
        return None;
    }

    let mut combined = existing;
    if !combined.is_empty() && !combined.ends_with('\n') {
        combined.push('\n');
    }
    combined.push_str(&new_entry);
    combined.push('\n');

    if combined.chars().count() > budget || combined.len() > MEMORY_BYTE_LIMIT {
        return None;
    }

    if mode == "auto" {
        let _ = fs::create_dir_all(&dir);
        let _ = fs::write(&mem_file, &combined);
        let _ = sync_agent_instructions(root, agent_id);
        return None;
    }

    Some(ReflectionCandidate {
        agent_id: agent_id.to_string(),
        note: new_entry,
        summary,
    })
}

pub fn apply_post_turn_reflection(
    agent_id: &str,
    user_prompt: &str,
    assistant_reply: &str,
) -> Option<ReflectionCandidate> {
    apply_post_turn_reflection_at(&agents_root(), agent_id, user_prompt, assistant_reply)
}

