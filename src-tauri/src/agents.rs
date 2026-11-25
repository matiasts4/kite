use crate::chat::live_turns;
use crate::persist::{agents, db_connection, persist, threads, AgentProfile};
use crate::terminal::engine_installed;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};
use uuid::Uuid;

pub const CANONICAL_TOOL_FAMILIES: &[&str] = &[
    "thread",
    "memory",
    "routine",
    "teammate",
    "tasks",
    "ctx",
    "diff",
    "filesystem_write",
    "shell",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgePackConfig {
    pub id: String,
    pub name: String,
    pub root_path: String,
    #[serde(default)]
    pub globs: Vec<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentAutonomyConfig {
    #[serde(default)]
    pub tool_policies: BTreeMap<String, String>,
    #[serde(default)]
    pub max_turns_per_run: Option<u32>,
    #[serde(default)]
    pub max_duration_secs: Option<u64>,
    #[serde(default)]
    pub failover_engines: Vec<String>,
    #[serde(default)]
    pub knowledge_packs: Vec<KnowledgePackConfig>,
}

pub fn normalize_tool_policy_value(raw: &str) -> Option<&'static str> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "allow" => Some("allow"),
        "ask" => Some("ask"),
        "deny" => Some("deny"),
        _ => None,
    }
}

pub fn default_policy_for_family(family: &str) -> &'static str {
    match family {
        "filesystem_write" | "shell" => "ask",
        _ => "allow",
    }
}

pub(crate) fn load_agent_autonomy_config_from_conn(
    conn: &rusqlite::Connection,
    agent_id: &str,
) -> AgentAutonomyConfig {
    let raw: Option<String> = conn
        .query_row(
            "SELECT data FROM agent_autonomy_config WHERE agent_id = ?1 LIMIT 1",
            rusqlite::params![agent_id],
            |row| row.get(0),
        )
        .ok();
    raw.and_then(|text| serde_json::from_str::<AgentAutonomyConfig>(&text).ok())
        .unwrap_or_default()
}

pub(crate) fn save_agent_autonomy_config_to_conn(
    conn: &rusqlite::Connection,
    agent_id: &str,
    cfg: &AgentAutonomyConfig,
) -> Result<(), String> {
    let _ = conn.execute(
        "CREATE TABLE IF NOT EXISTS agent_autonomy_config (
            agent_id TEXT PRIMARY KEY,
            data TEXT NOT NULL,
            updated_at_unix_ms INTEGER NOT NULL
        )",
        [],
    );
    let data = serde_json::to_string(cfg).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO agent_autonomy_config (agent_id, data, updated_at_unix_ms)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(agent_id) DO UPDATE SET
             data = excluded.data,
             updated_at_unix_ms = excluded.updated_at_unix_ms",
        rusqlite::params![agent_id, data, now_ms()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn load_agent_autonomy_config(agent_id: &str) -> AgentAutonomyConfig {
    if agent_id.trim().is_empty() {
        return AgentAutonomyConfig::default();
    }
    let Ok(conn) = db_connection().lock() else {
        return AgentAutonomyConfig::default();
    };
    load_agent_autonomy_config_from_conn(&conn, agent_id)
}

pub fn save_agent_autonomy_config(agent_id: &str, cfg: &AgentAutonomyConfig) -> Result<(), String> {
    if agent_id.trim().is_empty() {
        return Err("agent_id is required".to_string());
    }
    let conn = db_connection().lock().map_err(|e| e.to_string())?;
    save_agent_autonomy_config_to_conn(&conn, agent_id, cfg)
}

fn sanitize_autonomy_config_patch(req: &Value, cfg: &mut AgentAutonomyConfig) {
    if let Some(policies_obj) = req.get("toolPolicies").and_then(Value::as_object) {
        let mut next = BTreeMap::new();
        for (k, v) in policies_obj {
            let fam = k.trim().to_ascii_lowercase();
            if CANONICAL_TOOL_FAMILIES.contains(&fam.as_str()) {
                if let Some(decision) = v.as_str().and_then(normalize_tool_policy_value) {
                    next.insert(fam, decision.to_string());
                }
            }
        }
        cfg.tool_policies = next;
    }
    if let Some(turns_val) = req.get("maxTurnsPerRun") {
        cfg.max_turns_per_run = turns_val.as_u64().map(|n| n.clamp(1, 100) as u32);
    }
    if let Some(dur_val) = req.get("maxDurationSecs") {
        cfg.max_duration_secs = dur_val.as_u64().map(|n| n.clamp(30, 7200));
    }
    if let Some(failovers) = req.get("failoverEngines").and_then(Value::as_array) {
        let mut list = Vec::new();
        for item in failovers {
            if let Some(raw) = item.as_str() {
                let norm = teammate_engine(Some(raw));
                if !list.contains(&norm) {
                    list.push(norm);
                }
            }
        }
        cfg.failover_engines = list;
    }
    if let Some(packs) = req.get("knowledgePacks").and_then(Value::as_array) {
        let mut parsed_packs = Vec::new();
        for item in packs {
            if let Ok(p) = serde_json::from_value::<KnowledgePackConfig>(item.clone()) {
                parsed_packs.push(p);
            }
        }
        cfg.knowledge_packs = parsed_packs;
    }
}

fn merge_autonomy_into_json(mut val: Value, agent_id: &str) -> Value {
    let cfg = load_agent_autonomy_config(agent_id);
    if let Some(obj) = val.as_object_mut() {
        obj.insert("toolPolicies".to_string(), json!(cfg.tool_policies));
        obj.insert("maxTurnsPerRun".to_string(), json!(cfg.max_turns_per_run));
        obj.insert("maxDurationSecs".to_string(), json!(cfg.max_duration_secs));
        obj.insert("failoverEngines".to_string(), json!(cfg.failover_engines));
        obj.insert("knowledgePacks".to_string(), json!(cfg.knowledge_packs));
    }
    val
}

pub fn normalize_lexical_path(path: &Path) -> PathBuf {
    let mut stack: Vec<Component<'_>> = Vec::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                if matches!(stack.last(), Some(Component::Normal(_))) {
                    stack.pop();
                } else {
                    stack.push(comp);
                }
            }
            other => stack.push(other),
        }
    }
    stack.iter().collect()
}

pub fn resolve_agent_authorized_roots(
    agent_id: Option<&str>,
    bound_workspace: Option<&Path>,
) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    let mut push_root = |p: PathBuf| {
        let norm = normalize_lexical_path(&p.canonicalize().unwrap_or(p));
        if !roots.iter().any(|existing| existing == &norm) {
            roots.push(norm);
        }
    };

    if let Some(ws) = bound_workspace {
        if ws.is_dir() {
            push_root(ws.to_path_buf());
        }
    }

    if let Some(aid) = agent_id.map(str::trim).filter(|s| !s.is_empty()) {
        let home = crate::agent_mind::get_agent_home_dir(aid);
        push_root(home);
        let place_names = agents()
            .lock()
            .ok()
            .and_then(|list| list.iter().find(|a| a.id == aid).map(|a| a.place_display_names.clone()))
            .unwrap_or_default();
        if !place_names.is_empty() {
            let workspaces = crate::persist::workspaces()
                .lock()
                .map(|w| w.clone())
                .unwrap_or_default();
            for raw in place_names {
                let place = raw.trim();
                if place.is_empty() {
                    continue;
                }
                if let Some(ws) = workspaces
                    .iter()
                    .find(|w| w.display_name.eq_ignore_ascii_case(place) || w.id == place)
                {
                    if let Some(path) = crate::persist::workspace_path(&ws.id) {
                        push_root(PathBuf::from(path));
                    }
                } else {
                    let direct = PathBuf::from(place);
                    if direct.is_dir() {
                        push_root(direct);
                    }
                }
            }
        }
    }

    roots
}

pub fn validate_path_within_authorized_roots(
    target: &Path,
    roots: &[PathBuf],
) -> Result<PathBuf, String> {
    if roots.is_empty() {
        return Err("No authorized workspace or Places roots are configured for path access.".to_string());
    }
    let candidate = if target.is_absolute() {
        target.to_path_buf()
    } else {
        roots[0].join(target)
    };
    let normalized_candidate = if candidate.exists() {
        candidate.canonicalize().map_err(|e| format!("Invalid target path: {e}"))?
    } else if let Some(parent) = candidate.parent() {
        if parent.exists() {
            let canon_parent = parent.canonicalize().map_err(|e| format!("Invalid parent path: {e}"))?;
            match candidate.file_name() {
                Some(name) => canon_parent.join(name),
                None => canon_parent,
            }
        } else {
            normalize_lexical_path(&candidate)
        }
    } else {
        normalize_lexical_path(&candidate)
    };

    for root in roots {
        let norm_root = normalize_lexical_path(&root.canonicalize().unwrap_or_else(|_| root.clone()));
        if normalized_candidate == norm_root || normalized_candidate.starts_with(&norm_root) {
            return Ok(normalized_candidate);
        }
        #[cfg(windows)]
        {
            let cand_lower = normalized_candidate.to_string_lossy().to_ascii_lowercase();
            let root_lower = norm_root.to_string_lossy().to_ascii_lowercase();
            if cand_lower == root_lower
                || cand_lower.starts_with(&format!("{}\\", root_lower.trim_end_matches('\\')))
            {
                return Ok(normalized_candidate);
            }
        }
    }

    Err(format!(
        "Path '{}' is outside the agent's bound workspace and authorized Places roots.",
        target.display()
    ))
}

const TEAMMATE_ENGINES: &[&str] = &[
    "claude-code",
    "codex",
    "cursor",
    "gemini",
    "github-copilot",
    "droid",
    "open-code",
    "deep-seek",
    "grok",
    "kimi",
    "amp",
    "antigravity",
    "gentle-shell",
    "aider",
    "muse",
];

pub fn agent_profile_json(agent_id: &str) -> Value {
    let found = {
        let items = agents().lock().unwrap();
        items.iter().find(|a| a.id == agent_id).cloned()
    };
    if let Some(agent) = found {
        let base = serde_json::to_value(&agent).unwrap_or_else(|_| json!({
            "id": agent.id,
            "name": agent.name,
            "engine": agent.engine,
            "purpose": if agent.purpose.is_empty() { &agent.brief } else { &agent.purpose },
            "brief": if agent.brief.is_empty() { &agent.purpose } else { &agent.brief },
            "avatar": agent.avatar,
            "createdAtUnixMs": agent.created_at_unix_ms,
            "pinned": agent.pinned,
            "order": agent.order,
            "memoryBudget": agent.memory_budget.unwrap_or(2200),
            "reflectionMode": agent.reflection_mode.as_deref().unwrap_or("ask"),
            "allowAgentScheduling": agent.allow_agent_scheduling.unwrap_or(true),
            "allowAgentMessaging": agent.allow_agent_messaging.unwrap_or(true),
            "defaultMode": agent.default_mode,
            "defaultPlan": agent.default_plan,
            "defaultModel": agent.default_model,
            "defaultProviderOptions": agent.default_provider_options,
            "placeDisplayNames": agent.place_display_names,
            "disabledPluginIds": agent.disabled_plugin_ids,
        }));
        return merge_autonomy_into_json(base, agent_id);
    }
    merge_autonomy_into_json(json!({
        "id": agent_id,
        "name": "Orion",
        "engine": "antigravity",
        "purpose": "Autonomous software engineering and code analysis assistant",
        "brief": "Autonomous software engineering and code analysis assistant",
        "avatar": Value::Null,
        "createdAtUnixMs": 1791770226543i64,
        "pinned": true,
        "order": 0,
        "memoryBudget": 2200,
        "reflectionMode": "ask",
        "allowAgentScheduling": true,
        "allowAgentMessaging": true,
        "defaultMode": "fullAccess",
        "defaultPlan": Value::Null,
        "defaultModel": Value::Null,
        "defaultProviderOptions": [],
        "placeDisplayNames": [],
        "disabledPluginIds": []
    }), agent_id)
}

pub fn update_agent(agent_id: &str, name: &str, brief: &str, engine: Option<&str>) -> Value {
    let req = json!({
        "agentId": agent_id,
        "name": name,
        "brief": brief,
        "engine": engine
    });
    update_agent_profile(Some(req))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn studio_dir() -> PathBuf {
    crate::persist::db_path()
        .parent()
        .map(|dir| dir.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."))
}

fn teammate_engine(value: Option<&str>) -> String {
    value
        .filter(|engine| TEAMMATE_ENGINES.contains(engine))
        .unwrap_or("antigravity")
        .to_string()
}

fn availability_snapshot() -> Value {
    let teammates: Vec<Value> = TEAMMATE_ENGINES
        .iter()
        .map(|engine| {
            json!({
                "engine": engine,
                "installed": engine_installed(engine),
                "verified": true
            })
        })
        .collect();
    json!({
        "schemaVersion": 1,
        "scope": "native",
        "phase": "ready",
        "hasProbed": true,
        "isLoading": false,
        "issue": Value::Null,
        "teammates": teammates
    })
}

#[tauri::command]
pub fn get_agent_availability(_request: Option<Value>) -> Value {
    availability_snapshot()
}

#[tauri::command]
pub fn probe_agent_availability(_request: Option<Value>) -> Value {
    availability_snapshot()
}

#[tauri::command]
pub fn reprobe_agent_availability(_request: Option<Value>) -> Value {
    availability_snapshot()
}

#[tauri::command]
pub fn list_agent_profiles() -> Vec<AgentProfile> {
    agents().lock().unwrap().clone()
}

#[tauri::command]
pub fn list_agent_arrangement(_request: Option<Value>) -> Vec<AgentProfile> {
    agents().lock().unwrap().clone()
}

#[tauri::command]
pub fn set_agent_pinned(request: Value) -> Vec<AgentProfile> {
    let req = request.get("request").unwrap_or(&request);
    let agent_id = req.get("agentId").and_then(|v| v.as_str()).unwrap_or("");
    let pinned = req.get("pinned").and_then(|v| v.as_bool()).unwrap_or(false);

    let cloned = {
        let mut state = agents().lock().unwrap();
        if let Some(a) = state.iter_mut().find(|a| a.id == agent_id) {
            a.pinned = pinned;
        }
        state.clone()
    };
    persist();
    cloned
}

#[tauri::command]
pub fn move_agent(request: Value) -> Vec<AgentProfile> {
    let req = request.get("request").unwrap_or(&request);
    let agent_id = req.get("agentId").and_then(|v| v.as_str()).unwrap_or("");
    let to_index = req.get("toIndex").and_then(|v| v.as_u64()).unwrap_or(0) as usize;

    let cloned = {
        let mut state = agents().lock().unwrap();
        if let Some(pos) = state.iter().position(|a| a.id == agent_id) {
            let item = state.remove(pos);
            let insert_idx = to_index.min(state.len());
            state.insert(insert_idx, item);
            for (i, agent) in state.iter_mut().enumerate() {
                agent.order = i as i32;
            }
        }
        state.clone()
    };
    persist();
    cloned
}

#[tauri::command]
pub fn load_agent_profile(request: Value) -> Value {
    let req = request.get("request").unwrap_or(&request);
    let agent_id = req.get("agentId")
        .and_then(|v| v.as_str())
        .unwrap_or("c3333333-3333-4333-8333-333333333333");
    agent_profile_json(agent_id)
}

fn request_body(request: &Option<Value>) -> Option<&Value> {
    request.as_ref().map(|value| value.get("request").unwrap_or(value))
}

fn plain_text(value: &str, limit: usize) -> String {
    value
        .chars()
        .filter(|ch| {
            let code = *ch as u32;
            *ch == '\n' || *ch == '\r' || *ch == '\t' || (code >= 32 && !(127..=159).contains(&code))
        })
        .take(limit)
        .collect::<String>()
        .trim()
        .to_string()
}

#[derive(Default)]
struct CreateAgentOptions {
    avatar: Option<String>,
    default_model: Option<String>,
    default_mode: Option<String>,
    default_provider_options: Vec<Value>,
}

fn parse_create_options(req: Option<&Value>) -> CreateAgentOptions {
    let avatar = req
        .and_then(|r| r.get("avatar"))
        .and_then(|v| {
            if v.is_null() {
                None
            } else if let Some(s) = v.as_str() {
                let trimmed = s.trim();
                if trimmed.is_empty() { None } else { Some(trimmed.to_string()) }
            } else {
                Some(v.to_string())
            }
        });
    let default_model = req
        .and_then(|r| r.get("defaultModel"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let default_mode = req
        .and_then(|r| r.get("defaultMode"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let mut default_provider_options = req
        .and_then(|r| r.get("defaultProviderOptions"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if let Some(effort) = req
        .and_then(|r| r.get("effort"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let has_effort = default_provider_options
            .iter()
            .any(|o| o.get("id").and_then(|v| v.as_str()) == Some("effort"));
        if !has_effort {
            default_provider_options.push(json!({ "id": "effort", "value": effort }));
        }
    }
    CreateAgentOptions {
        avatar,
        default_model,
        default_mode,
        default_provider_options,
    }
}

fn push_agent(name: &str, engine: &str, purpose: &str) -> Value {
    push_agent_with_options(name, engine, purpose, CreateAgentOptions::default())
}

fn push_agent_with_options(
    name: &str,
    engine: &str,
    purpose: &str,
    options: CreateAgentOptions,
) -> Value {
    let agent_id = Uuid::new_v4().to_string();
    let now = now_ms();
    let safe_name = {
        let trimmed = plain_text(name, 80);
        if trimmed.is_empty() { "New Agent".to_string() } else { trimmed }
    };
    let safe_engine = teammate_engine(Some(engine));
    let safe_purpose = plain_text(purpose, 4000);
    let safe_brief = safe_purpose.clone();
    let profile = {
        let mut state = agents().lock().unwrap();
        let next_order = state.len() as i32;
        let p = AgentProfile {
            id: agent_id.clone(),
            name: safe_name.clone(),
            engine: safe_engine.clone(),
            purpose: safe_purpose.clone(),
            brief: safe_brief.clone(),
            avatar: options.avatar.clone(),
            created_at_unix_ms: now,
            pinned: false,
            order: next_order,
            memory_budget: None,
            reflection_mode: None,
            allow_agent_scheduling: None,
            allow_agent_messaging: None,
            default_mode: options.default_mode.clone(),
            default_plan: None,
            default_model: options.default_model.clone(),
            default_provider_options: options.default_provider_options.clone(),
            place_display_names: vec![],
            disabled_plugin_ids: vec![],
        };
        state.push(p.clone());
        p
    };
    persist();
    let _ = crate::agent_mind::sync_agent_instructions(&crate::agent_mind::agents_root(), &agent_id);
    serde_json::to_value(&profile).unwrap_or_else(|_| json!({
        "id": agent_id,
        "name": safe_name,
        "engine": safe_engine,
        "purpose": safe_purpose,
        "brief": safe_brief,
        "avatar": options.avatar,
        "createdAtUnixMs": now,
        "pinned": false,
        "order": profile.order,
        "defaultMode": options.default_mode,
        "defaultModel": options.default_model,
        "defaultProviderOptions": options.default_provider_options,
        "placeDisplayNames": [],
        "disabledPluginIds": []
    }))
}

#[tauri::command]
pub fn create_agent(request: Option<Value>) -> Value {
    let req = request_body(&request);
    let name = req.and_then(|r| r.get("name")).and_then(|v| v.as_str()).unwrap_or("New Agent");
    let engine = req.and_then(|r| r.get("engine")).and_then(|v| v.as_str()).unwrap_or("antigravity");
    let purpose = req.and_then(|r| r.get("purpose")).or_else(|| req.and_then(|r| r.get("brief"))).and_then(|v| v.as_str()).unwrap_or("");
    let options = parse_create_options(req);
    push_agent_with_options(name, engine, purpose, options)
}

#[tauri::command]
pub fn update_agent_profile(request: Option<Value>) -> Value {
    let req = crate::persist::body(&request);
    let agent_id = req.and_then(|r| r.get("agentId")).and_then(|v| v.as_str()).unwrap_or("c3333333-3333-4333-8333-333333333333");
    let name = req.and_then(|r| r.get("name")).and_then(|v| v.as_str()).unwrap_or("");
    let brief = req.and_then(|r| r.get("brief")).or_else(|| req.and_then(|r| r.get("purpose"))).and_then(|v| v.as_str()).unwrap_or("");
    let new_engine = req.and_then(|r| r.get("engine")).and_then(|v| v.as_str());
    let avatar = req.and_then(|r| r.get("avatar")).and_then(|v| if v.is_null() { None } else if v.is_string() { v.as_str().map(|s| s.to_string()) } else { Some(v.to_string()) });
    let memory_budget = req.and_then(|r| r.get("memoryBudget")).and_then(|v| v.as_i64());
    let reflection_mode = req.and_then(|r| r.get("reflectionMode")).and_then(|v| v.as_str()).map(|s| s.to_string());
    let allow_agent_scheduling = req.and_then(|r| r.get("allowAgentScheduling")).and_then(|v| v.as_bool());
    let allow_agent_messaging = req.and_then(|r| r.get("allowAgentMessaging")).and_then(|v| v.as_bool());
    let default_mode = req.and_then(|r| r.get("defaultMode")).and_then(|v| v.as_str()).map(|s| s.to_string());
    let default_plan = req.and_then(|r| r.get("defaultPlan")).and_then(|v| {
        if let Some(b) = v.as_bool() {
            Some(b)
        } else if let Some(s) = v.as_str() {
            Some(s == "true" || s == "1")
        } else {
            None
        }
    });
    let default_model = req.and_then(|r| r.get("defaultModel")).and_then(|v| if v.is_null() { None } else { v.as_str().map(|s| s.to_string()) });
    let default_provider_options: Option<Vec<Value>> = req
        .and_then(|r| r.get("defaultProviderOptions"))
        .and_then(|v| v.as_array())
        .map(|arr| arr.clone());
    let place_display_names: Option<Vec<String>> = req
        .and_then(|r| r.get("placeDisplayNames"))
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|s| s.as_str().map(String::from)).collect());
    let disabled_plugin_ids: Option<Vec<String>> = req
        .and_then(|r| r.get("disabledPluginIds").or_else(|| r.get("disabledPluginIDs")))
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|s| s.as_str().map(String::from)).collect());

    let mut items = agents().lock().unwrap();
    if let Some(agent) = items.iter_mut().find(|a| a.id == agent_id) {
        if !name.trim().is_empty() {
            agent.name = name.trim().to_string();
        }
        if !brief.trim().is_empty() {
            agent.purpose = brief.trim().to_string();
            agent.brief = brief.trim().to_string();
        }
        if let Some(eng) = new_engine {
            let eng_clean = teammate_engine(Some(eng));
            if agent.engine != eng_clean {
                agent.engine = eng_clean.clone();
                // Sanitization rule for engine transition from AgentSettingsPane
                if eng_clean == "codex" && agent.default_mode.as_deref() == Some("fullAccess") {
                    agent.default_mode = Some("acceptEdits".to_string());
                }
                if eng_clean != "claude-code" {
                    agent.default_plan = Some(false);
                }
                agent.default_model = None;
                agent.default_provider_options = vec![];
            }
        }
        if avatar.is_some() {
            agent.avatar = avatar;
        }
        if let Some(mb) = memory_budget {
            agent.memory_budget = Some(mb);
        }
        if reflection_mode.is_some() {
            agent.reflection_mode = reflection_mode;
        }
        if let Some(sched) = allow_agent_scheduling {
            agent.allow_agent_scheduling = Some(sched);
        }
        if let Some(msg) = allow_agent_messaging {
            agent.allow_agent_messaging = Some(msg);
        }
        if default_mode.is_some() {
            if agent.engine == "codex" && default_mode.as_deref() == Some("fullAccess") {
                agent.default_mode = Some("acceptEdits".to_string());
            } else {
                agent.default_mode = default_mode;
            }
        }
        if default_plan.is_some() {
            if agent.engine == "claude-code" {
                agent.default_plan = default_plan;
            } else {
                agent.default_plan = Some(false);
            }
        }
        if default_model.is_some() {
            agent.default_model = default_model;
        }
        if let Some(opts) = default_provider_options {
            agent.default_provider_options = opts;
        }
        if let Some(places) = place_display_names {
            agent.place_display_names = places;
        }
        if let Some(plugins) = disabled_plugin_ids {
            agent.disabled_plugin_ids = plugins;
        }

        let cloned = agent.clone();
        drop(items);
        if let Some(req_val) = req {
            let mut cfg = load_agent_autonomy_config(agent_id);
            sanitize_autonomy_config_patch(req_val, &mut cfg);
            let _ = save_agent_autonomy_config(agent_id, &cfg);
        }
        persist();
        let _ = crate::agent_mind::sync_agent_instructions(&crate::agent_mind::agents_root(), agent_id);
        let base = serde_json::to_value(&cloned).unwrap_or_else(|_| agent_profile_json(agent_id));
        return merge_autonomy_into_json(base, agent_id);
    }
    drop(items);
    agent_profile_json(agent_id)
}

#[tauri::command]
pub fn delete_agent_profile(request: Option<Value>) -> Value {
    let req = request.as_ref().and_then(|r| r.get("request")).or(request.as_ref());
    let agent_id = req.and_then(|r| r.get("agentId")).and_then(|v| v.as_str()).unwrap_or("c3333333-3333-4333-8333-333333333333");
    {
        let mut state = agents().lock().unwrap();
        state.retain(|a| a.id != agent_id);
    }
    persist();
    json!({
        "schemaVersion": 1,
        "agentId": agent_id,
        "deleted": true,
        "cleanupPending": false
    })
}

fn drafts_path() -> PathBuf {
    studio_dir().join("agent-drafts.json")
}

fn installs_path() -> PathBuf {
    studio_dir().join("agent-installs.json")
}

fn read_json_array(path: &PathBuf) -> Vec<Value> {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Vec<Value>>(&bytes).ok())
        .unwrap_or_default()
}

fn write_json_array(path: &PathBuf, items: &[Value]) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(bytes) = serde_json::to_vec_pretty(items) {
        let _ = std::fs::write(path, bytes);
    }
}

fn clean_role_name(seed: &str) -> String {
    let lower = seed.to_lowercase();

    // 1. Semantic role detection (Spanish & English)
    let archetypes: &[(&[&str], &str)] = &[
        (&["arquitect", "architect", "estructura", "system design", "codegraph"], "Software Architect"),
        (&["frontend", "ui", "ux", "react", "css", "interfaz", "visual", "diseño", "tailwind"], "Frontend & UI Specialist"),
        (&["backend", "rust", "tauri", "api", "base de datos", "database", "sql", "servidor"], "Backend & Systems Engineer"),
        (&["seguridad", "security", "audit", "vulnerab", "pentest", "auth"], "Security Auditor"),
        (&["bug", "debug", "error", "fallo", "crash", "root cause", "arreglar", "corregir"], "Root-Cause Debugger"),
        (&["test", "qa", "prueba", "calidad", "vitest", "playwright", "coverage"], "QA & Testing Specialist"),
        (&["review", "revis", "pr", "pull request", "calidad de código", "code quality"], "Code Reviewer"),
        (&["release", "deploy", "ci/cd", "version", "actualizacion", "build", "devops"], "Release & DevOps Engineer"),
        (&["doc", "readme", "guía", "guide", "redac", "writer", "content", "post"], "Technical Writer"),
        (&["performance", "rendimiento", "optimiz", "bundle", "velocidad", "memory"], "Performance Optimizer"),
    ];

    for (keywords, role_title) in archetypes {
        if keywords.iter().any(|k| lower.contains(k)) {
            return (*role_title).to_string();
        }
    }

    // 2. Fallback: strip conversational filler (ES + EN) and extract meaningful nouns
    let first_line = seed.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
    if first_line.is_empty() {
        return "Specialist Agent".to_string();
    }

    let stopwords = [
        "quiero", "necesito", "busco", "crea", "crear", "hacer", "un", "una", "el", "la", "los", "las",
        "agente", "agent", "asistente", "bot", "que", "se", "encargue", "dedique", "ayude", "para",
        "por", "favor", "con", "en", "de", "del", "al", "como", "no", "hay", "solamente", "solo",
        "también", "tambien", "este", "esta", "eso", "algo", "así", "asi", "todo", "toda", "parte",
        "i", "need", "want", "an", "a", "the", "to", "that", "who", "can", "will", "for", "own",
        "write", "create", "build", "review", "maintain", "develop", "manage", "inspect", "handle",
    ];

    let meaningful: Vec<String> = first_line
        .split(|c: char| !c.is_alphanumeric() && c != '-' && c != '/')
        .filter(|w| !w.is_empty())
        .filter(|w| {
            let lw = w.to_lowercase();
            lw.len() > 2 && !stopwords.contains(&lw.as_str())
        })
        .take(3)
        .map(|w| {
            let mut chars = w.chars();
            match chars.next() {
                Some(first) => {
                    let mut s = String::new();
                    s.extend(first.to_uppercase());
                    for rest in chars {
                        s.push(rest.to_ascii_lowercase());
                    }
                    s
                }
                None => String::new(),
            }
        })
        .filter(|w| !w.is_empty())
        .collect();

    if meaningful.is_empty() {
        "Specialist Agent".to_string()
    } else {
        plain_text(&meaningful.join(" "), 48)
    }
}

fn draft_copy(seed: &str) -> (String, String) {
    let brief_source = plain_text(seed, 8000);
    if brief_source.is_empty() {
        return ("Specialist Agent".to_string(), "Autonomous specialist assistant for project tasks.".to_string());
    }
    let name = clean_role_name(&brief_source);
    let brief = if brief_source.contains("## Role") || brief_source.contains("## Standards") {
        brief_source
    } else {
        format!(
            "{}\n\n## Execution Standards\n- Analyze relevant files and context before proposing or applying changes.\n- Follow existing codebase architecture, naming conventions, and typing rules.\n- Verify changes with concrete checks or tests and explain trade-offs clearly.",
            brief_source
        )
    };
    (name, brief)
}

fn draft_provider_for_engine(engine: &str) -> Option<&'static str> {
    match engine.trim().to_ascii_lowercase().as_str() {
        "antigravity" | "agy" => Some("antigravity"),
        "claude-code" | "claude" => Some("claude"),
        "codex" => Some("codex"),
        "cursor" => Some("cursor"),
        "grok" => Some("grok"),
        "open-code" | "opencode" => Some("opencode"),
        "gemini" => Some("gemini"),
        _ => None,
    }
}

fn draft_provider_id_from_label(label: &str) -> Option<&'static str> {
    match label.trim().to_ascii_lowercase().as_str() {
        "antigravity" => Some("antigravity"),
        "codex" => Some("codex"),
        "claude" => Some("claude"),
        "cursor" => Some("cursor"),
        "grok" => Some("grok"),
        "opencode" => Some("opencode"),
        "gemini" => Some("gemini"),
        _ => None,
    }
}

fn extract_json_object_str(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    // Strip markdown code fences if present
    let without_fences = if trimmed.starts_with("```") {
        let mut lines: Vec<&str> = trimmed.lines().collect();
        if !lines.is_empty() && lines[0].trim().starts_with("```") {
            lines.remove(0);
        }
        if lines.last().is_some_and(|l| l.trim() == "```") {
            lines.pop();
        }
        lines.join("\n")
    } else {
        trimmed.to_string()
    };
    let start = without_fences.find('{')?;
    let end = without_fences.rfind('}')?;
    if end <= start {
        return None;
    }
    Some(without_fences[start..=end].to_string())
}

fn parse_draft_json(raw: &str) -> Option<(String, String)> {
    // Direct JSON or fenced JSON
    if let Some(json_str) = extract_json_object_str(raw) {
        if let Ok(val) = serde_json::from_str::<Value>(&json_str) {
            let name = val.get("name").and_then(Value::as_str).map(|s| plain_text(s, 48)).unwrap_or_default();
            let brief = val.get("brief").and_then(Value::as_str).map(|s| plain_text(s, 8000)).unwrap_or_default();
            if !name.is_empty() && !brief.is_empty() {
                return Some((name, brief));
            }
        }
    }
    // NDJSON stream fallback: collect assistant text chunks
    let mut collected = String::new();
    for line in raw.lines() {
        let Ok(val) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        if let Some(text) = val
            .get("text")
            .or_else(|| val.get("delta"))
            .or_else(|| val.get("content"))
            .and_then(Value::as_str)
        {
            collected.push_str(text);
        } else if let Some(msg) = val
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(Value::as_array)
        {
            for part in msg {
                if let Some(t) = part.get("text").and_then(Value::as_str) {
                    collected.push_str(t);
                }
            }
        }
    }
    if !collected.is_empty() {
        if let Some(json_str) = extract_json_object_str(&collected) {
            if let Ok(val) = serde_json::from_str::<Value>(&json_str) {
                let name = val.get("name").and_then(Value::as_str).map(|s| plain_text(s, 48)).unwrap_or_default();
                let brief = val.get("brief").and_then(Value::as_str).map(|s| plain_text(s, 8000)).unwrap_or_default();
                if !name.is_empty() && !brief.is_empty() {
                    return Some((name, brief));
                }
            }
        }
    }
    None
}

fn run_provider_draft_prompt(provider: &str, prompt: &str) -> Result<String, String> {
    use std::time::Duration;

    if cfg!(test) {
        let _ = (provider, prompt);
        return Err("live provider draft disabled in unit tests".to_string());
    }

    let values = crate::chat::runtime::spawn::SendValues {
        connection_id: None,
        model: None,
        session_id: None,
        supported_endpoint: None,
        verified_endpoints: &[],
        agent: None,
    };
    let plan = crate::chat::runtime::spawn::build_spawn(provider, "readOnly", &values, None, prompt)?;
    let args_refs: Vec<&str> = plan.args.iter().map(String::as_str).collect();
    let output = crate::hidden_exec::run(&plan.program, &args_refs, Duration::from_secs(12))
        .map_err(|e| format!("spawn failed: {e}"))?;
    if output.timed_out {
        return Err("draft generation timed out".to_string());
    }
    let stdout = output.stdout_lossy();
    if output.success() && !stdout.trim().is_empty() {
        return Ok(stdout);
    }
    Err(format!("provider exited with status {:?}", output.code))
}

pub(crate) fn draft_agent_with_runner<F>(seed: &str, desired_engine: &str, mut runner: F) -> (String, String)
where
    F: FnMut(&str, &str) -> Result<String, String>,
{
    let brief_source = plain_text(seed, 8000);
    if brief_source.is_empty() {
        return draft_copy(seed);
    }

    let prompt = format!(
        "Create a concise specialist AI agent profile for this request:\n\"{}\"\n\nRespond ONLY with valid JSON matching:\n{{\"name\":\"<2-4 word role name>\",\"brief\":\"<clear markdown charter with ## Role and ## Execution Standards>\"}}",
        brief_source
    );

    let mut candidates: Vec<&'static str> = Vec::new();
    if let Some(preferred) = draft_provider_for_engine(desired_engine) {
        candidates.push(preferred);
    }
    for label in crate::chat::runtime::spawn::list_available_providers() {
        if let Some(pid) = draft_provider_id_from_label(label) {
            if !candidates.contains(&pid) {
                candidates.push(pid);
            }
        }
    }

    for provider in candidates {
        if let Ok(raw) = runner(provider, &prompt) {
            if let Some((name, brief)) = parse_draft_json(&raw) {
                return (name, brief);
            }
        }
    }

    draft_copy(seed)
}

#[tauri::command]
pub fn draft_agent_with_ai(request: Option<Value>) -> Value {
    let req = request_body(&request);
    let request_id = req
        .and_then(|r| r.get("requestId"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let seed = req.and_then(|r| r.get("seed")).and_then(|v| v.as_str()).unwrap_or("");
    let engine = teammate_engine(req.and_then(|r| r.get("desiredEngine")).and_then(|v| v.as_str()));
    let (name, brief) = draft_agent_with_runner(seed, &engine, run_provider_draft_prompt);
    let mut drafts = read_json_array(&drafts_path());
    drafts.retain(|draft| draft.get("requestId").and_then(|v| v.as_str()) != Some(request_id.as_str()));
    drafts.push(json!({
        "requestId": request_id,
        "name": name,
        "brief": brief,
        "engine": engine,
        "agentId": Value::Null,
        "idempotencyKey": Value::Null,
        "cleanupPending": false
    }));
    write_json_array(&drafts_path(), &drafts);
    json!({
        "schemaVersion": 1,
        "requestId": request_id,
        "draft": { "name": name, "brief": brief }
    })
}

#[tauri::command]
pub fn accept_agent_draft(request: Option<Value>) -> Value {
    let req = request_body(&request);
    let request_id = req.and_then(|r| r.get("requestId")).and_then(|v| v.as_str()).unwrap_or("");
    let idempotency_key = req.and_then(|r| r.get("idempotencyKey")).and_then(|v| v.as_str()).unwrap_or("");
    let custom_name = req.and_then(|r| r.get("name")).and_then(|v| v.as_str()).map(|s| s.trim()).filter(|s| !s.is_empty());
    let custom_brief = req.and_then(|r| r.get("brief")).and_then(|v| v.as_str()).map(|s| s.trim()).filter(|s| !s.is_empty());
    let custom_engine = req.and_then(|r| r.get("engine")).and_then(|v| v.as_str()).map(|s| s.trim()).filter(|s| !s.is_empty());
    let options = parse_create_options(req);

    let mut drafts = read_json_array(&drafts_path());
    let position = drafts.iter().position(|draft| {
        draft.get("requestId").and_then(|v| v.as_str()) == Some(request_id) && !request_id.is_empty()
    });
    let Some(index) = position else {
        return push_agent_with_options(
            custom_name.unwrap_or("New Agent"),
            custom_engine.unwrap_or("antigravity"),
            custom_brief.unwrap_or(""),
            options,
        );
    };
    if let Some(agent_id) = drafts[index].get("agentId").and_then(|v| v.as_str()) {
        if !agent_id.is_empty() {
            return agent_profile_json(agent_id);
        }
    }
    let name = custom_name
        .map(|s| s.to_string())
        .or_else(|| drafts[index].get("name").and_then(|v| v.as_str()).map(|s| s.to_string()))
        .unwrap_or_else(|| "New Agent".to_string());
    let brief = custom_brief
        .map(|s| s.to_string())
        .or_else(|| drafts[index].get("brief").and_then(|v| v.as_str()).map(|s| s.to_string()))
        .unwrap_or_default();
    let engine = custom_engine
        .map(|s| teammate_engine(Some(s)))
        .or_else(|| drafts[index].get("engine").and_then(|v| v.as_str()).map(|s| s.to_string()))
        .unwrap_or_else(|| "antigravity".to_string());
    let created = push_agent_with_options(&name, &engine, &brief, options);
    drafts[index]["agentId"] = created.get("id").cloned().unwrap_or(Value::Null);
    drafts[index]["idempotencyKey"] = json!(idempotency_key);
    drafts[index]["cleanupPending"] = json!(false);
    write_json_array(&drafts_path(), &drafts);
    created
}

#[tauri::command]
pub fn abandon_agent_draft(request: Option<Value>) -> Value {
    let req = request_body(&request);
    let request_id = req.and_then(|r| r.get("requestId")).and_then(|v| v.as_str()).unwrap_or("");
    let mut drafts = read_json_array(&drafts_path());
    if let Some(draft) = drafts.iter_mut().find(|draft| draft.get("requestId").and_then(|v| v.as_str()) == Some(request_id)) {
        draft["cleanupPending"] = json!(true);
        draft["name"] = json!("");
        draft["brief"] = json!("");
    }
    write_json_array(&drafts_path(), &drafts);
    Value::Null
}

#[tauri::command]
pub fn cancel_agent_draft(request: Option<Value>) -> Value {
    let req = request_body(&request);
    let request_id = req.and_then(|r| r.get("requestId")).and_then(|v| v.as_str()).unwrap_or("");
    let mut drafts = read_json_array(&drafts_path());
    drafts.retain(|draft| {
        draft.get("requestId").and_then(|v| v.as_str()) != Some(request_id)
            || draft.get("agentId").and_then(|v| v.as_str()).is_some()
    });
    write_json_array(&drafts_path(), &drafts);
    Value::Null
}

#[tauri::command]
pub fn retry_agent_draft_cleanup(_request: Option<Value>) -> Value {
    let mut drafts = read_json_array(&drafts_path());
    drafts.retain(|draft| draft.get("cleanupPending").and_then(|v| v.as_bool()) != Some(true));
    write_json_array(&drafts_path(), &drafts);
    Value::Null
}

#[tauri::command]
pub async fn list_agent_rail_activity(request: Option<Value>) -> Result<Vec<Value>, String> {
    tokio::task::spawn_blocking(move || list_agent_rail_activity_sync(request))
        .await
        .map_err(|e| e.to_string())
}

pub fn list_agent_rail_activity_sync(_request: Option<Value>) -> Vec<Value> {
    let agent_rows = agents().lock().unwrap().clone();
    let thread_rows = threads().lock().unwrap().clone();
    let running = {
        let live = live_turns().lock().unwrap();
        let mut rows = Vec::new();
        for (thread_id, run_id) in &live.by_thread {
            let Some(run) = live.runs.get(run_id) else { continue };
            if run.finished {
                continue;
            }
            let line = run
                .assistant_text
                .lines()
                .rev()
                .find(|line| !line.trim().is_empty())
                .map(|line| line.chars().take(240).collect::<String>());
            rows.push((thread_id.clone(), line, run.started_at_ms));
        }
        rows
    };

    agent_rows
        .into_iter()
        .map(|agent| {
            let mine: Vec<&Value> = thread_rows
                .iter()
                .filter(|thread| thread.get("profileId").and_then(|v| v.as_str()) == Some(agent.id.as_str()))
                .collect();
            let mut running_count = 0u64;
            let mut line = None;
            let mut at_unix_ms = None;
            let mut needs_you = false;
            for thread in &mine {
                let thread_id = thread.get("id").and_then(|v| v.as_str()).unwrap_or("");
                if let Some((_, run_line, started)) = running.iter().find(|(id, _, _)| id == thread_id) {
                    running_count += 1;
                    if line.is_none() {
                        line = run_line.clone();
                    }
                    at_unix_ms = Some(at_unix_ms.map(|current: i64| current.max(*started)).unwrap_or(*started));
                }
                if thread.get("pendingApproval").map(|value| !value.is_null()).unwrap_or(false) {
                    needs_you = true;
                }
                if let Some(updated) = thread.get("updatedAtUnixMs").and_then(|v| v.as_i64()) {
                    at_unix_ms = Some(at_unix_ms.map(|current: i64| current.max(updated)).unwrap_or(updated));
                }
            }
            json!({
                "agentId": agent.id,
                "line": line,
                "atUnixMs": at_unix_ms,
                "needsYou": needs_you,
                "runningCount": running_count
            })
        })
        .collect()
}

fn install_action(value: Option<&str>) -> String {
    match value {
        Some("signIn") => "signIn".to_string(),
        Some("prerequisite") => "prerequisite".to_string(),
        _ => "install".to_string(),
    }
}

fn display_line(action: &str, engine: &str) -> String {
    match action {
        "signIn" => format!("Sign in to {engine}"),
        "prerequisite" => format!("Install prerequisite for {engine}"),
        _ => format!("Install {engine}"),
    }
}

#[tauri::command]
pub fn start_agent_install(request: Option<Value>) -> Value {
    let req = request_body(&request);
    let engine = teammate_engine(req.and_then(|r| r.get("engine")).and_then(|v| v.as_str()));
    let session_id = req
        .and_then(|r| r.get("sessionId"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let install_id = Uuid::new_v4().to_string();
    let action = install_action(req.and_then(|r| r.get("action")).and_then(|v| v.as_str()));
    let mut jobs = read_json_array(&installs_path());
    jobs.retain(|job| job.get("sessionId").and_then(|v| v.as_str()) != Some(session_id.as_str()));
    jobs.push(json!({
        "installId": install_id,
        "sessionId": session_id,
        "engine": engine,
        "action": action
    }));
    write_json_array(&installs_path(), &jobs);
    json!({
        "schemaVersion": 1,
        "installId": install_id,
        "sessionId": session_id,
        "engine": engine,
        "action": action,
        "displayLine": display_line(&action, &engine)
    })
}

#[tauri::command]
pub fn complete_agent_install(request: Option<Value>) -> Value {
    let req = request_body(&request);
    let engine = teammate_engine(req.and_then(|r| r.get("engine")).and_then(|v| v.as_str()));
    let install_id = req.and_then(|r| r.get("installId")).and_then(|v| v.as_str()).unwrap_or("");
    let jobs = read_json_array(&installs_path());
    let action = jobs
        .iter()
        .find(|job| job.get("installId").and_then(|v| v.as_str()) == Some(install_id))
        .and_then(|job| job.get("action").and_then(|v| v.as_str()))
        .map(|s| s.to_string())
        .unwrap_or_else(|| "install".to_string());
    let mut remaining = jobs;
    remaining.retain(|job| job.get("installId").and_then(|v| v.as_str()) != Some(install_id));
    write_json_array(&installs_path(), &remaining);
    json!({
        "schemaVersion": 1,
        "engine": engine,
        "action": action,
        "detected": engine_installed(&engine),
        "availability": availability_snapshot()
    })
}

#[tauri::command]
pub fn agent_install_open_docs(request: Option<Value>) -> Value {
    let req = request_body(&request);
    let engine = teammate_engine(req.and_then(|r| r.get("engine")).and_then(|v| v.as_str()));
    let folder = studio_dir().join("agent-docs");
    let _ = std::fs::create_dir_all(&folder);
    let note = folder.join(format!("{engine}.txt"));
    if !note.exists() {
        let _ = std::fs::write(&note, format!("{engine} docs are kept on this computer.\n"));
    }
    let _ = std::process::Command::new("explorer").arg(&folder).spawn();
    Value::Null
}

fn is_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

fn catalog_engine(value: &str) -> Option<&'static str> {
    match value {
        "claude" | "claude-code" => Some("claude-code"),
        "codex" => Some("codex"),
        "cursor" => Some("cursor"),
        "gemini" => Some("gemini"),
        "copilot" | "github-copilot" => Some("github-copilot"),
        "droid" => Some("droid"),
        "opencode" | "open-code" => Some("open-code"),
        "deepseek" | "deep-seek" => Some("deep-seek"),
        "grok" => Some("grok"),
        "kimi" => Some("kimi"),
        "amp" => Some("amp"),
        "antigravity" => Some("antigravity"),
        "aider" => Some("aider"),
        "muse" => Some("muse"),
        _ => None,
    }
}

#[tauri::command]
pub fn legacy_agent_sessions(request: Option<Value>) -> Value {
    let req = request_body(&request);
    let workspace_id = req.and_then(|r| r.get("workspaceId")).and_then(|v| v.as_str()).unwrap_or("");
    let thread_rows = threads().lock().unwrap().clone();
    let mut sessions = Vec::new();
    for thread in thread_rows {
        if thread.get("workspaceId").and_then(|v| v.as_str()) != Some(workspace_id) {
            continue;
        }
        let Some(pane_id) = thread.get("id").and_then(|v| v.as_str()).filter(|id| is_uuid(id)) else { continue };
        let provider = thread
            .get("provider")
            .or_else(|| thread.get("engine"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let Some(engine) = catalog_engine(provider) else { continue };
        let title = thread
            .get("title")
            .and_then(|v| v.as_str())
            .map(|title| plain_text(title, 80))
            .filter(|title| !title.is_empty());
        let updated = thread.get("updatedAtUnixMs").and_then(|v| v.as_i64()).unwrap_or(0).max(0);
        sessions.push(json!({
            "paneId": pane_id,
            "engine": engine,
            "title": title,
            "updatedAtUnixMs": updated
        }));
        if sessions.len() == 200 {
            break;
        }
    }
    json!({
        "schemaVersion": 1,
        "sessions": sessions
    })
}

fn messaging_pref_path() -> PathBuf {
    studio_dir().join("agent-messaging-preference.json")
}

#[tauri::command]
pub fn agent_messaging_preference() -> Value {
    let pref_path = messaging_pref_path();
    let val: Value = std::fs::read_to_string(&pref_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null);
    let enabled = val.get("enabled").and_then(Value::as_bool).unwrap_or(true);
    let read_only = val.get("readOnly").and_then(Value::as_bool).unwrap_or(false);
    let revision = val
        .get("revision")
        .and_then(Value::as_str)
        .unwrap_or("rev-1")
        .to_string();
    json!({
        "schemaVersion": 1,
        "enabled": enabled,
        "readOnly": read_only,
        "revision": revision
    })
}

#[tauri::command]
pub fn set_agent_messaging_preference(request: Option<Value>) -> Value {
    let req = request.as_ref().and_then(|r| r.get("request")).or(request.as_ref());
    let enabled = req.and_then(|r| r.get("enabled")).and_then(Value::as_bool).unwrap_or(true);
    let read_only = req.and_then(|r| r.get("readOnly")).and_then(Value::as_bool).unwrap_or(false);
    let next_rev = format!("rev-{}", now_ms());
    let data = json!({
        "enabled": enabled,
        "readOnly": read_only,
        "revision": next_rev
    });
    let pref_path = messaging_pref_path();
    if let Some(parent) = pref_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&pref_path, serde_json::to_string_pretty(&data).unwrap_or_default());
    json!({
        "schemaVersion": 1,
        "enabled": enabled,
        "readOnly": read_only,
        "revision": next_rev
    })
}

#[tauri::command]
pub fn agent_message_inbox(request: Option<Value>) -> Value {
    let req = request.as_ref().and_then(|r| r.get("request")).or(request.as_ref());
    let profile_id = req.and_then(|r| r.get("profileId")).and_then(Value::as_str).unwrap_or("");
    let before_seq: Option<u64> = req
        .and_then(|r| r.get("beforeSequence"))
        .and_then(Value::as_str)
        .and_then(|s| s.parse().ok())
        .or_else(|| req.and_then(|r| r.get("beforeSequence")).and_then(Value::as_u64));
    crate::dispatch_wire::inbox(profile_id, before_seq)
}

#[tauri::command]
pub fn send_agent_message(request: Option<Value>) -> Result<Value, String> {
    let req = request.as_ref().and_then(|r| r.get("request")).or(request.as_ref());
    let recipient_id = req
        .and_then(|r| r.get("recipientId").or_else(|| r.get("profileId")))
        .and_then(Value::as_str)
        .ok_or_else(|| "recipientId is required".to_string())?;
    let sender_id = req.and_then(|r| r.get("senderId")).and_then(Value::as_str).unwrap_or("user");
    let sender_name = req.and_then(|r| r.get("senderName")).and_then(Value::as_str).unwrap_or("Builder");
    let body = req.and_then(|r| r.get("body")).and_then(Value::as_str).ok_or_else(|| "body is required".to_string())?;
    let caller = if sender_id.is_empty() || sender_id == "user" || sender_id == "human" {
        "human"
    } else {
        "agent"
    };
    Ok(crate::dispatch_wire::send_agent(
        recipient_id,
        body,
        caller,
        sender_name,
        None,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn create_agent_persists_avatar_model_mode_and_effort() {
        let created = create_agent(Some(json!({
            "name": "Creation Integrity Agent",
            "engine": "claude-code",
            "purpose": "Verify create_agent persistence",
            "avatar": "{\"glyph\":\"rocket\"}",
            "defaultModel": "claude-sonnet-4-5",
            "defaultMode": "acceptEdits",
            "effort": "high"
        })));
        let id = created.get("id").and_then(Value::as_str).unwrap().to_string();
        assert_eq!(created.get("avatar").and_then(Value::as_str), Some("{\"glyph\":\"rocket\"}"));
        assert_eq!(created.get("defaultModel").and_then(Value::as_str), Some("claude-sonnet-4-5"));
        assert_eq!(created.get("defaultMode").and_then(Value::as_str), Some("acceptEdits"));
        let opts = created.get("defaultProviderOptions").and_then(Value::as_array).unwrap();
        assert!(opts.iter().any(|o| o.get("id").and_then(Value::as_str) == Some("effort") && o.get("value").and_then(Value::as_str) == Some("high")));

        // Clean up from in-memory roster
        let mut items = agents().lock().unwrap();
        items.retain(|a| a.id != id);
    }

    #[test]
    fn accept_agent_draft_persists_avatar_model_mode_and_effort() {
        let req_id = Uuid::new_v4().to_string();
        let drafted = draft_agent_with_ai(Some(json!({
            "requestId": req_id,
            "seed": "Security auditor",
            "desiredEngine": "codex"
        })));
        assert!(drafted.get("draft").is_some());

        let accepted = accept_agent_draft(Some(json!({
            "requestId": req_id,
            "idempotencyKey": "idem-1",
            "name": "Security Auditor",
            "brief": "Audit security.",
            "engine": "codex",
            "avatar": "shield",
            "defaultModel": "gpt-5",
            "defaultMode": "readOnly",
            "effort": "medium"
        })));
        let id = accepted.get("id").and_then(Value::as_str).unwrap().to_string();
        assert_eq!(accepted.get("avatar").and_then(Value::as_str), Some("shield"));
        assert_eq!(accepted.get("defaultModel").and_then(Value::as_str), Some("gpt-5"));
        assert_eq!(accepted.get("defaultMode").and_then(Value::as_str), Some("readOnly"));
        let opts = accepted.get("defaultProviderOptions").and_then(Value::as_array).unwrap();
        assert!(opts.iter().any(|o| o.get("id").and_then(Value::as_str) == Some("effort") && o.get("value").and_then(Value::as_str) == Some("medium")));

        let mut items = agents().lock().unwrap();
        items.retain(|a| a.id != id);
    }

    #[test]
    fn draft_agent_with_runner_parses_live_json_and_falls_back_on_error() {
        let (name, brief) = draft_agent_with_runner(
            "Build a release engineer",
            "claude-code",
            |_provider, _prompt| {
                Ok("```json\n{\"name\":\"Release Engineer\",\"brief\":\"## Role\\nManage releases safely.\"}\n```".to_string())
            },
        );
        assert_eq!(name, "Release Engineer");
        assert!(brief.contains("Manage releases safely."));

        let (fallback_name, fallback_brief) = draft_agent_with_runner(
            "Create a frontend accessibility reviewer",
            "claude-code",
            |_provider, _prompt| Err("provider unavailable".to_string()),
        );
        assert!(!fallback_name.is_empty());
        assert!(fallback_brief.contains("## Execution Standards"));
    }

    #[test]
    fn run_provider_draft_prompt_refuses_live_cli_spawn_in_tests() {
        let err = run_provider_draft_prompt("grok", "Security auditor")
            .expect_err("unit tests must never spawn live external provider CLIs");
        assert!(err.contains("disabled in unit tests"), "got: {err}");
    }

    #[test]
    fn autonomy_config_roundtrips_and_places_sandbox_rejects_outside_paths() {
        let agent_id = format!("test-autonomy-{}", Uuid::new_v4());
        let mut cfg = AgentAutonomyConfig::default();
        cfg.tool_policies.insert("tasks".into(), "deny".into());
        cfg.tool_policies.insert("shell".into(), "ask".into());
        cfg.max_turns_per_run = Some(15);
        cfg.max_duration_secs = Some(600);
        cfg.failover_engines = vec!["codex".into(), "grok".into()];
        save_agent_autonomy_config(&agent_id, &cfg).expect("save autonomy config");

        let loaded = load_agent_autonomy_config(&agent_id);
        assert_eq!(loaded, cfg);

        let temp_root = std::env::temp_dir().join(format!("kite_places_root_{}", Uuid::new_v4()));
        let outside_root = std::env::temp_dir().join(format!("kite_places_out_{}", Uuid::new_v4()));
        std::fs::create_dir_all(&temp_root).unwrap();
        std::fs::create_dir_all(&outside_root).unwrap();
        let inside_file = temp_root.join("notes.md");
        let outside_file = outside_root.join("secret.txt");
        std::fs::write(&inside_file, "ok").unwrap();
        std::fs::write(&outside_file, "secret").unwrap();

        let roots = vec![temp_root.clone()];
        assert!(validate_path_within_authorized_roots(&inside_file, &roots).is_ok());
        assert!(validate_path_within_authorized_roots(&outside_file, &roots).is_err());

        let _ = std::fs::remove_dir_all(&temp_root);
        let _ = std::fs::remove_dir_all(&outside_root);
    }
}
