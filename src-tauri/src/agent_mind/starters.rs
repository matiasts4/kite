use crate::agent_mind::memory::load_agent_mind_at;
use crate::agent_mind::skills::store_skill_file;
use crate::agent_mind::types::{AgentMindError, Starter, STARTERS};
use crate::agent_mind::utils::{ensure_agent_id, issue, require_known_agent};
use serde_json::{json, Value};
use std::path::Path;

pub(crate) fn starter_by_id(starter_id: &str) -> Result<&'static Starter, AgentMindError> {
    STARTERS
        .iter()
        .find(|starter| starter.id == starter_id)
        .ok_or_else(|| AgentMindError::new("agent_data_failed", "That starter is not in the catalog."))
}

pub(crate) fn starter_source(starter: &Starter) -> String {
    format!(
        "---\nname: {name}\ndescription: {description}\n---\n{body}\n",
        name = starter.name,
        description = starter.description,
        body = starter.body,
    )
}

pub(crate) fn starter_summaries() -> Vec<Value> {
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

pub(crate) fn install_agent_starter_at(
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
