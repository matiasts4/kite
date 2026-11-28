use crate::agent_mind::memory::{
    find_similar_memory_entries, load_agent_mind_at, memory_path, sync_agent_instructions,
    update_memory_meta_at, write_agent_memory_at,
};
use crate::agent_mind::skills::{
    capture_skill_from_chat_at, discover_available_skills_at, load_agent_skill_at,
    remove_agent_skill_at, set_agent_skill_enabled_at, validate_linked_skill_ref,
    write_agent_skill_at,
};
use crate::agent_mind::starters::{install_agent_starter_at, starter_summaries};
use crate::agent_mind::types::AgentMindError;
use crate::agent_mind::utils::{
    agents_root, request_body, require_confirmation, require_known_agent,
};
use serde_json::{json, Value};
use std::path::PathBuf;

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
pub fn set_agent_skill_enabled(request: Value) -> Result<Value, AgentMindError> {
    let req = request_body(&request);
    require_confirmation(req)?;
    let agent_id = req.get("agentId").and_then(|value| value.as_str()).unwrap_or("");
    let skill_id = req.get("skillId").and_then(|value| value.as_str()).unwrap_or("");
    let enabled = req.get("enabled").and_then(|value| value.as_bool()).unwrap_or(true);
    require_known_agent(agent_id)?;
    set_agent_skill_enabled_at(&agents_root(), agent_id, skill_id, enabled)
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

#[tauri::command]
pub fn update_agent_memory_meta(request: Value) -> Result<Value, AgentMindError> {
    let req = request_body(&request);
    let agent_id = req.get("agentId").and_then(|v| v.as_str()).unwrap_or("");
    require_known_agent(agent_id)?;
    let entry_text = req.get("entryText").and_then(|v| v.as_str()).unwrap_or("");
    let action = req.get("action").and_then(|v| v.as_str()).unwrap_or("");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    let map = update_memory_meta_at(&agents_root(), agent_id, entry_text, action, now)?;
    Ok(json!({ "agentId": agent_id, "memoryMeta": map }))
}

#[tauri::command]
pub fn check_memory_duplicate(request: Value) -> Result<Value, AgentMindError> {
    let req = request_body(&request);
    let agent_id = req.get("agentId").and_then(|v| v.as_str()).unwrap_or("");
    require_known_agent(agent_id)?;
    let target = req.get("target").and_then(|v| v.as_str()).unwrap_or("memory");
    let candidate = req.get("candidate").and_then(|v| v.as_str()).unwrap_or("");
    let threshold = req
        .get("threshold")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.85)
        .clamp(0.1, 1.0);
    let root = agents_root();
    let path = memory_path(&root, agent_id, target)?;
    let existing = std::fs::read_to_string(path).unwrap_or_default();
    let hits: Vec<Value> = find_similar_memory_entries(&existing, candidate, threshold)
        .into_iter()
        .map(|(index, entry, similarity)| {
            json!({ "index": index, "entry": entry, "similarity": similarity })
        })
        .collect();
    Ok(json!({ "isDuplicate": !hits.is_empty(), "matches": hits }))
}

fn resolve_discovery_workspace_root(
    workspace_id: Option<&str>,
    agent_id: Option<&str>,
) -> Option<PathBuf> {
    if let Some(ws_id) = workspace_id.map(str::trim).filter(|s| !s.is_empty()) {
        return crate::persist::workspace_path(ws_id)
            .map(PathBuf::from)
            .filter(|p| p.is_dir());
    }
    if let Some(aid) = agent_id.map(str::trim).filter(|s| !s.is_empty()) {
        let agent_opt = crate::persist::agents()
            .lock()
            .ok()
            .and_then(|list| list.iter().find(|a| a.id == aid).cloned());
        let roots = crate::agent_mind::memory::resolve_agent_workspace_roots(agent_opt.as_ref(), aid);
        if let Some(first) = roots.into_iter().next() {
            return Some(first);
        }
    }
    let mut workspaces = crate::persist::workspaces()
        .lock()
        .map(|w| w.clone())
        .unwrap_or_default();
    workspaces.sort_by(|a, b| b.last_opened_at_unix_ms.cmp(&a.last_opened_at_unix_ms));
    for ws in workspaces {
        if let Some(path) = crate::persist::workspace_path(&ws.id) {
            let pb = PathBuf::from(path);
            if pb.is_dir() {
                return Some(pb);
            }
        }
    }
    None
}

#[tauri::command]
pub fn list_discoverable_skills(request: Option<Value>) -> Result<Value, AgentMindError> {
    let req = request.as_ref().map(request_body);
    let workspace_id = req
        .and_then(|r| r.get("workspaceId").or_else(|| r.get("workspace_id")))
        .and_then(Value::as_str);
    let agent_id = req
        .and_then(|r| r.get("agentId").or_else(|| r.get("agent_id")))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let workspace_root = resolve_discovery_workspace_root(workspace_id, agent_id);
    let home = crate::chat::utils::user_home_dir();
    let skills = discover_available_skills_at(workspace_root.as_deref(), &home);
    let linked_skill_refs = agent_id
        .map(crate::persist::get_agent_linked_skill_refs)
        .unwrap_or_default();

    Ok(json!({
        "skills": skills,
        "workspaceRoot": workspace_root.map(|p| p.to_string_lossy().to_string()),
        "linkedSkillRefs": linked_skill_refs,
    }))
}

#[tauri::command]
pub fn set_agent_linked_skills(request: Value) -> Result<Value, AgentMindError> {
    let req = request_body(&request);
    let agent_id = req
        .get("agentId")
        .or_else(|| req.get("agent_id"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    require_known_agent(agent_id)?;

    let raw_refs = req
        .get("linkedSkillRefs")
        .or_else(|| req.get("linked_skill_refs"))
        .and_then(Value::as_array)
        .ok_or_else(|| {
            AgentMindError::new("agent_data_failed", "linkedSkillRefs array is required.")
        })?;

    let mut clean_refs: Vec<String> = Vec::new();
    for item in raw_refs {
        let Some(raw) = item.as_str() else {
            return Err(AgentMindError::new(
                "agent_data_unsafe",
                "Each linked skill reference must be a string.",
            ));
        };
        let validated = validate_linked_skill_ref(raw)?;
        if !clean_refs.iter().any(|existing| existing == &validated) {
            clean_refs.push(validated);
        }
    }

    crate::persist::set_agent_linked_skill_refs(agent_id, &clean_refs)
        .map_err(|msg| AgentMindError::new("agent_data_failed", &msg))?;
    let root = agents_root();
    let _ = sync_agent_instructions(&root, agent_id);
    load_agent_mind_at(&root, agent_id)
}

#[tauri::command]
pub fn capture_agent_skill_from_chat(request: Value) -> Result<Value, AgentMindError> {
    let req = request_body(&request);
    let agent_id = req
        .get("agentId")
        .or_else(|| req.get("agent_id"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    require_known_agent(agent_id)?;

    let name = req.get("name").and_then(Value::as_str).unwrap_or("");
    let description = req.get("description").and_then(Value::as_str).unwrap_or("");
    let messages = req
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let manual_only = req
        .get("manualOnly")
        .or_else(|| req.get("manual_only"))
        .and_then(Value::as_bool)
        .unwrap_or(false);

    capture_skill_from_chat_at(
        &agents_root(),
        agent_id,
        name,
        description,
        &messages,
        manual_only,
    )
}
