use crate::agent_mind::memory::{load_agent_mind_at, write_agent_memory_at};
use crate::agent_mind::skills::{load_agent_skill_at, remove_agent_skill_at, write_agent_skill_at};
use crate::agent_mind::starters::{install_agent_starter_at, starter_summaries};
use crate::agent_mind::types::AgentMindError;
use crate::agent_mind::utils::{
    agents_root, ensure_agent_id, ensure_skill_id, request_body, require_confirmation,
    require_known_agent,
};
use serde_json::{json, Value};

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
