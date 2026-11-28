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
    "browser",
    "filesystem_write",
    "shell",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgePackConfig {
    #[serde(default)]
    pub id: String,
    pub name: String,
    #[serde(default, alias = "root")]
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

pub fn set_agent_tool_policy_allow(agent_id: &str, family: &str) -> Result<(), String> {
    let aid = agent_id.trim();
    if aid.is_empty() {
        return Err("agent_id is required".to_string());
    }
    let fam = family.trim().to_ascii_lowercase();
    if !CANONICAL_TOOL_FAMILIES.contains(&fam.as_str()) {
        return Err(format!("Unsupported tool family '{family}'."));
    }
    let mut cfg = load_agent_autonomy_config(aid);
    cfg.tool_policies.insert(fam, "allow".to_string());
    save_agent_autonomy_config(aid, &cfg)
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
        for (idx, item) in packs.iter().enumerate() {
            if let Ok(mut p) = serde_json::from_value::<KnowledgePackConfig>(item.clone()) {
                if p.id.trim().is_empty() {
                    let slug: String = p
                        .name
                        .to_ascii_lowercase()
                        .chars()
                        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
                        .collect();
                    p.id = format!("kp-{}-{}", slug.trim_matches('-'), idx + 1);
                }
                parsed_packs.push(p);
            }
        }
        cfg.knowledge_packs = parsed_packs;
    }
}

fn sync_autonomy_knowledge_packs_to_mind(
    mind_root: &Path,
    agent_id: &str,
    cfg: &AgentAutonomyConfig,
    fallback_workspace: Option<&Path>,
) {
    let mut index = crate::agent_mind::knowledge::load_knowledge_index_at(mind_root, agent_id);
    let created_map: BTreeMap<String, i64> = index
        .packs
        .iter()
        .map(|p| (p.id.clone(), p.created_at_unix_ms))
        .collect();
    let now = now_unix_ms();
    index.packs = cfg
        .knowledge_packs
        .iter()
        .map(|p| crate::agent_mind::knowledge::KnowledgePackDef {
            id: p.id.clone(),
            name: p.name.clone(),
            root: p.root_path.clone(),
            globs: p.globs.clone(),
            enabled: p.enabled,
            created_at_unix_ms: created_map.get(&p.id).copied().unwrap_or(now),
        })
        .collect();
    let _ = crate::agent_mind::knowledge::save_knowledge_index_at(mind_root, agent_id, &index);
    let roots = resolve_agent_authorized_roots(Some(agent_id), fallback_workspace);
    let can_reindex = index.packs.iter().all(|p| {
        !p.enabled
            || (!p.root.trim().is_empty()
                && validate_path_within_authorized_roots(Path::new(&p.root), &roots).is_ok()
                && Path::new(&p.root).exists())
    });
    if can_reindex && !index.packs.is_empty() {
        let _ = crate::agent_mind::knowledge::reindex_knowledge_packs_at(
            mind_root,
            agent_id,
            &roots,
        );
    }
}

fn merge_autonomy_into_json(mut val: Value, agent_id: &str) -> Value {
    let mut cfg = load_agent_autonomy_config(agent_id);
    if cfg.knowledge_packs.is_empty() {
        let idx = crate::agent_mind::knowledge::load_knowledge_index_at(
            &crate::agent_mind::agents_root(),
            agent_id,
        );
        if !idx.packs.is_empty() {
            cfg.knowledge_packs = idx
                .packs
                .into_iter()
                .map(|p| KnowledgePackConfig {
                    id: p.id,
                    name: p.name,
                    root_path: p.root,
                    globs: p.globs,
                    enabled: p.enabled,
                })
                .collect();
        }
    }
    let linked_skill_refs = crate::persist::get_agent_linked_skill_refs(agent_id);
    if let Some(obj) = val.as_object_mut() {
        obj.insert("toolPolicies".to_string(), json!(cfg.tool_policies));
        obj.insert("maxTurnsPerRun".to_string(), json!(cfg.max_turns_per_run));
        obj.insert("maxDurationSecs".to_string(), json!(cfg.max_duration_secs));
        obj.insert("failoverEngines".to_string(), json!(cfg.failover_engines));
        obj.insert("knowledgePacks".to_string(), json!(cfg.knowledge_packs));
        obj.insert("linkedSkillRefs".to_string(), json!(linked_skill_refs));
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

fn parse_optional_bool(val: &Value) -> Option<bool> {
    if let Some(b) = val.as_bool() {
        Some(b)
    } else if let Some(s) = val.as_str() {
        Some(s == "true" || s == "1")
    } else {
        None
    }
}

fn parse_string_list(req: Option<&Value>, keys: &[&str]) -> Option<Vec<String>> {
    let r = req?;
    for key in keys {
        if let Some(arr) = r.get(*key).and_then(Value::as_array) {
            let mut out = Vec::new();
            for item in arr {
                if let Some(s) = item.as_str() {
                    let trimmed = s.trim();
                    if !trimmed.is_empty() && !out.iter().any(|e| e == trimmed) {
                        out.push(trimmed.to_string());
                    }
                }
            }
            return Some(out);
        }
    }
    None
}

fn filter_valid_linked_skill_refs(refs: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for raw in refs {
        if let Ok(valid) = crate::agent_mind::skills::validate_linked_skill_ref(raw) {
            if !out.iter().any(|e| e == &valid) {
                out.push(valid);
            }
        }
    }
    out
}

#[derive(Default)]
struct CreateAgentOptions {
    avatar: Option<String>,
    memory_budget: Option<i64>,
    reflection_mode: Option<String>,
    allow_agent_scheduling: Option<bool>,
    allow_agent_messaging: Option<bool>,
    default_model: Option<String>,
    default_mode: Option<String>,
    default_plan: Option<bool>,
    default_provider_options: Vec<Value>,
    place_display_names: Vec<String>,
    disabled_plugin_ids: Vec<String>,
    linked_skill_refs: Vec<String>,
    autonomy_patch: Option<Value>,
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
    let memory_budget = req.and_then(|r| r.get("memoryBudget")).and_then(Value::as_i64);
    let reflection_mode = req
        .and_then(|r| r.get("reflectionMode"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let allow_agent_scheduling = req
        .and_then(|r| r.get("allowAgentScheduling"))
        .and_then(Value::as_bool);
    let allow_agent_messaging = req
        .and_then(|r| r.get("allowAgentMessaging"))
        .and_then(Value::as_bool);
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
    let default_plan = req
        .and_then(|r| r.get("defaultPlan"))
        .and_then(parse_optional_bool);
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
    let place_display_names = parse_string_list(req, &["placeDisplayNames", "place_display_names"])
        .unwrap_or_default();
    let disabled_plugin_ids = parse_string_list(
        req,
        &["disabledPluginIds", "disabledPluginIDs", "disabled_plugin_ids"],
    )
    .unwrap_or_default();
    let linked_skill_refs = filter_valid_linked_skill_refs(
        &parse_string_list(req, &["linkedSkillRefs", "linked_skill_refs"]).unwrap_or_default(),
    );
    CreateAgentOptions {
        avatar,
        memory_budget,
        reflection_mode,
        allow_agent_scheduling,
        allow_agent_messaging,
        default_model,
        default_mode,
        default_plan,
        default_provider_options,
        place_display_names,
        disabled_plugin_ids,
        linked_skill_refs,
        autonomy_patch: req.cloned(),
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
    let default_plan = if safe_engine == "claude-code" {
        options.default_plan
    } else {
        options.default_plan.map(|_| false)
    };
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
            memory_budget: options.memory_budget,
            reflection_mode: options.reflection_mode.clone(),
            allow_agent_scheduling: options.allow_agent_scheduling,
            allow_agent_messaging: options.allow_agent_messaging,
            default_mode: options.default_mode.clone(),
            default_plan,
            default_model: options.default_model.clone(),
            default_provider_options: options.default_provider_options.clone(),
            place_display_names: options.place_display_names.clone(),
            disabled_plugin_ids: options.disabled_plugin_ids.clone(),
        };
        state.push(p.clone());
        p
    };
    persist();

    if !options.linked_skill_refs.is_empty() {
        let _ = crate::persist::set_agent_linked_skill_refs(&agent_id, &options.linked_skill_refs);
    }

    let mind_root = crate::agent_mind::agents_root();
    if let Some(ref patch) = options.autonomy_patch {
        let has_autonomy_fields = patch.get("toolPolicies").is_some()
            || patch.get("maxTurnsPerRun").is_some()
            || patch.get("maxDurationSecs").is_some()
            || patch.get("failoverEngines").is_some()
            || patch.get("knowledgePacks").is_some();
        if has_autonomy_fields {
            let mut cfg = AgentAutonomyConfig::default();
            sanitize_autonomy_config_patch(patch, &mut cfg);
            let _ = save_agent_autonomy_config(&agent_id, &cfg);
            if patch.get("knowledgePacks").is_some() {
                sync_autonomy_knowledge_packs_to_mind(&mind_root, &agent_id, &cfg, None);
            }
        }
    }

    let _ = crate::agent_mind::sync_agent_instructions(&mind_root, &agent_id);
    let base = serde_json::to_value(&profile).unwrap_or_else(|_| json!({
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
        "placeDisplayNames": options.place_display_names,
        "disabledPluginIds": options.disabled_plugin_ids,
    }));
    merge_autonomy_into_json(base, &agent_id)
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
            agent.default_mode = default_mode;
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
        let mind_root = crate::agent_mind::agents_root();
        if let Some(req_val) = req {
            if let Some(raw_refs) = parse_string_list(Some(req_val), &["linkedSkillRefs", "linked_skill_refs"]) {
                let clean_refs = filter_valid_linked_skill_refs(&raw_refs);
                let _ = crate::persist::set_agent_linked_skill_refs(agent_id, &clean_refs);
            }
            let mut cfg = load_agent_autonomy_config(agent_id);
            sanitize_autonomy_config_patch(req_val, &mut cfg);
            let _ = save_agent_autonomy_config(agent_id, &cfg);
            if req_val.get("knowledgePacks").is_some() {
                sync_autonomy_knowledge_packs_to_mind(&mind_root, agent_id, &cfg, None);
            }
        }
        persist();
        let _ = crate::agent_mind::sync_agent_instructions(&mind_root, agent_id);
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
    let active_autopilot = crate::local_autopilot::active_autopilot_agent_ids();
    let active_routines = crate::routines::active_routine_agent_ids();
    let active_playbooks = crate::agent_playbooks::active_playbook_agent_ids();

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
            let mut running_sources: Vec<&'static str> = Vec::new();
            for thread in &mine {
                let thread_id = thread.get("id").and_then(|v| v.as_str()).unwrap_or("");
                if let Some((_, run_line, started)) = running.iter().find(|(id, _, _)| id == thread_id) {
                    running_count += 1;
                    if !running_sources.contains(&"chat") {
                        running_sources.push("chat");
                    }
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
            if active_autopilot.contains(&agent.id) {
                running_sources.push("autopilot");
                running_count = running_count.max(1);
                if line.is_none() {
                    line = Some("AutoPilot loop running".to_string());
                }
            }
            if active_routines.contains(&agent.id) {
                running_sources.push("routine");
                running_count = running_count.max(1);
                if line.is_none() {
                    line = Some("Routine active".to_string());
                }
            }
            if active_playbooks.contains(&agent.id) {
                running_sources.push("playbook");
                running_count = running_count.max(1);
                if line.is_none() {
                    line = Some("Playbook stage running".to_string());
                }
            }
            json!({
                "agentId": agent.id,
                "line": line,
                "atUnixMs": at_unix_ms,
                "needsYou": needs_you,
                "runningCount": running_count,
                "runningSources": running_sources
            })
        })
        .collect()
}

#[tauri::command]
pub fn get_agent_autonomy_summary(request: Option<Value>) -> Value {
    let req = request_body(&request);
    let agent_id = req
        .and_then(|r| r.get("agentId"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let (recent_routine_runs, audit_entries) = db_connection()
        .lock()
        .ok()
        .map(|conn| {
            let runs = crate::routines::list_routine_runs_in_conn(&conn, None, agent_id, 10)
                .unwrap_or_default();
            let audits = list_agent_audit_log_in_conn(&conn, agent_id, None, None, 50)
                .unwrap_or_default();
            (runs, audits)
        })
        .unwrap_or_default();

    let allowed_count = audit_entries.iter().filter(|a| a.verdict == "allowed").count();
    let asked_count = audit_entries.iter().filter(|a| a.verdict == "asked").count();
    let denied_count = audit_entries.iter().filter(|a| a.verdict == "denied").count();

    let playbooks = crate::agent_playbooks::list_agent_playbooks();
    let playbook_runs = crate::agent_playbooks::list_playbook_runs(None);

    json!({
        "agentId": agent_id,
        "activeAutopilotCount": crate::local_autopilot::active_autopilot_agent_ids().len(),
        "activeRoutineCount": crate::routines::active_routine_agent_ids().len(),
        "activePlaybookAgentCount": crate::agent_playbooks::active_playbook_agent_ids().len(),
        "recentRoutineRuns": recent_routine_runs,
        "auditCounts": {
            "allowed": allowed_count,
            "asked": asked_count,
            "denied": denied_count,
            "total": audit_entries.len(),
        },
        "playbooksCount": playbooks.get("playbooks").and_then(Value::as_array).map(|a| a.len()).unwrap_or(0),
        "recentPlaybookRuns": playbook_runs.get("runs").and_then(Value::as_array).map(|a| a.iter().take(5).cloned().collect::<Vec<_>>()).unwrap_or_default(),
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentAuditLogEntry {
    pub id: String,
    pub agent_id: String,
    pub thread_id: Option<String>,
    pub tool_name: String,
    pub tool_family: String,
    pub verdict: String,
    pub reason: Option<String>,
    pub duration_ms: i64,
    pub skill_event: Option<String>,
    pub created_at_unix_ms: i64,
}

fn now_unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn record_agent_audit_in_conn(
    conn: &rusqlite::Connection,
    entry: &AgentAuditLogEntry,
) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO agent_audit_log (
            id, agent_id, thread_id, tool_name, tool_family,
            verdict, reason, duration_ms, skill_event, created_at_unix_ms
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        rusqlite::params![
            entry.id,
            entry.agent_id,
            entry.thread_id,
            entry.tool_name,
            entry.tool_family,
            entry.verdict,
            entry.reason,
            entry.duration_ms,
            entry.skill_event,
            entry.created_at_unix_ms,
        ],
    )
    .map(|_| ())
    .map_err(|e| format!("Failed to persist agent_audit_log: {e}"))
}

pub fn record_agent_audit_event(
    agent_id: &str,
    thread_id: Option<&str>,
    tool_name: &str,
    tool_family: &str,
    verdict: &str,
    reason: Option<&str>,
    duration_ms: i64,
    skill_event: Option<&str>,
) {
    let entry = AgentAuditLogEntry {
        id: Uuid::new_v4().to_string(),
        agent_id: agent_id.to_string(),
        thread_id: thread_id.map(ToString::to_string),
        tool_name: tool_name.to_string(),
        tool_family: tool_family.to_string(),
        verdict: verdict.to_string(),
        reason: reason.map(|r| r.chars().take(500).collect()),
        duration_ms,
        skill_event: skill_event.map(ToString::to_string),
        created_at_unix_ms: now_unix_ms(),
    };
    if let Ok(conn) = db_connection().lock() {
        let _ = record_agent_audit_in_conn(&conn, &entry);
    }
}

pub fn list_agent_audit_log_in_conn(
    conn: &rusqlite::Connection,
    agent_id: Option<&str>,
    verdict: Option<&str>,
    tool_family: Option<&str>,
    limit: usize,
) -> Result<Vec<AgentAuditLogEntry>, String> {
    let capped = limit.clamp(1, 500) as i64;
    let mut sql = String::from(
        "SELECT id, agent_id, thread_id, tool_name, tool_family, verdict, reason, duration_ms, skill_event, created_at_unix_ms FROM agent_audit_log WHERE 1=1",
    );
    let mut params_vec: Vec<rusqlite::types::Value> = Vec::new();
    if let Some(aid) = agent_id.map(str::trim).filter(|s| !s.is_empty()) {
        sql.push_str(" AND agent_id = ?");
        params_vec.push(rusqlite::types::Value::Text(aid.to_string()));
    }
    if let Some(v) = verdict.map(str::trim).filter(|s| !s.is_empty() && *s != "all") {
        sql.push_str(" AND verdict = ?");
        params_vec.push(rusqlite::types::Value::Text(v.to_string()));
    }
    if let Some(fam) = tool_family.map(str::trim).filter(|s| !s.is_empty() && *s != "all") {
        sql.push_str(" AND tool_family = ?");
        params_vec.push(rusqlite::types::Value::Text(fam.to_string()));
    }
    sql.push_str(" ORDER BY created_at_unix_ms DESC LIMIT ?");
    params_vec.push(rusqlite::types::Value::Integer(capped));

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(params_vec.iter()), |row| {
            Ok(AgentAuditLogEntry {
                id: row.get(0)?,
                agent_id: row.get(1)?,
                thread_id: row.get(2)?,
                tool_name: row.get(3)?,
                tool_family: row.get(4)?,
                verdict: row.get(5)?,
                reason: row.get(6)?,
                duration_ms: row.get(7)?,
                skill_event: row.get(8)?,
                created_at_unix_ms: row.get(9)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for item in rows {
        if let Ok(rec) = item {
            out.push(rec);
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn list_agent_audit_log(request: Option<Value>) -> Value {
    let req = request_body(&request);
    let agent_id = req.and_then(|r| r.get("agentId")).and_then(Value::as_str);
    let verdict = req.and_then(|r| r.get("verdict")).and_then(Value::as_str);
    let tool_family = req.and_then(|r| r.get("toolFamily")).and_then(Value::as_str);
    let limit = req.and_then(|r| r.get("limit")).and_then(Value::as_u64).unwrap_or(100) as usize;
    let entries = db_connection()
        .lock()
        .ok()
        .and_then(|conn| list_agent_audit_log_in_conn(&conn, agent_id, verdict, tool_family, limit).ok())
        .unwrap_or_default();
    json!({ "entries": entries })
}

fn compute_readiness_pillars(
    mind_root: &Path,
    agent_id: &str,
    agent_opt: Option<&AgentProfile>,
    role: &str,
    memory: &str,
    skills: &[Value],
    cfg: &AgentAutonomyConfig,
) -> (u64, Vec<Value>) {
    let lower_role = role.to_ascii_lowercase();
    let lower_mem = memory.to_ascii_lowercase();
    let combined = format!("{lower_role}\n{lower_mem}");

    // 1. job_brief (max 15)
    let brief_len = role.trim().chars().count();
    let has_brief_structure = brief_len >= 160
        || lower_role.contains("## job")
        || lower_role.contains("## role")
        || lower_role.contains("## deliverable")
        || lower_role.contains("## execution standards")
        || lower_role.contains("job:")
        || lower_role.contains("deliverable:");
    let job_score = if brief_len >= 40 && has_brief_structure {
        15
    } else if brief_len >= 40 {
        8
    } else if brief_len >= 15 {
        4
    } else {
        0
    };

    // 2. never_list (max 15)
    let never_cues = [
        "never ",
        "never-",
        "never:",
        "do not ",
        "don't ",
        "must not ",
        "forbid",
        "prohibit",
        "## never-list",
        "## never list",
    ];
    let never_hits = never_cues.iter().filter(|c| combined.contains(*c)).count();
    let has_never_section =
        lower_role.contains("never-list") || lower_role.contains("never list");
    let never_score = if has_never_section || never_hits >= 2 {
        15
    } else if never_hits >= 1 {
        8
    } else {
        0
    };

    // 3. places_sources (max 10)
    let places_count = agent_opt.map(|a| a.place_display_names.len()).unwrap_or(0);
    let has_sources_section =
        lower_role.contains("## sources") || lower_role.contains("sources:");
    let places_score = if places_count >= 1 {
        10
    } else if has_sources_section {
        4
    } else {
        0
    };

    // 4. skills (max 15)
    let active_local_skills = skills
        .iter()
        .filter(|s| {
            s.get("enabled").and_then(Value::as_bool).unwrap_or(true)
                && s.get("eligible").and_then(Value::as_bool).unwrap_or(true)
        })
        .count();
    let linked_refs = crate::persist::get_agent_linked_skill_refs(agent_id);
    let total_skills = active_local_skills + linked_refs.len();
    let skills_score = if total_skills >= 2 || !linked_refs.is_empty() && total_skills >= 1 {
        15
    } else if total_skills >= 1 {
        8
    } else {
        0
    };

    // 5. knowledge_packs (max 15)
    let kp_index = crate::agent_mind::knowledge::load_knowledge_index_at(mind_root, agent_id);
    let enabled_packs = kp_index
        .packs
        .iter()
        .filter(|p| p.enabled)
        .count()
        .max(cfg.knowledge_packs.iter().filter(|p| p.enabled).count());
    let indexed_chunks = kp_index.chunks.len();
    let has_pack_globs = kp_index.packs.iter().any(|p| p.enabled && !p.globs.is_empty())
        || cfg
            .knowledge_packs
            .iter()
            .any(|p| p.enabled && !p.globs.is_empty());
    let kp_score = if enabled_packs > 0 && indexed_chunks > 0 {
        15
    } else if enabled_packs > 0 && has_pack_globs {
        11
    } else if enabled_packs > 0 {
        8
    } else {
        0
    };

    // 6. tool_policy_posture (max 10)
    let has_shell_policy = cfg.tool_policies.contains_key("shell");
    let has_write_policy = cfg.tool_policies.contains_key("filesystem_write");
    let policy_score = if cfg.tool_policies.len() >= 3 && has_shell_policy && has_write_policy {
        10
    } else if has_shell_policy || has_write_policy || !cfg.tool_policies.is_empty() {
        5
    } else {
        0
    };

    // 7. first_task (max 10)
    let has_first_task = lower_role.contains("## first task")
        || lower_role.contains("first task:")
        || lower_role.contains("first_task")
        || lower_role.contains("kickoff");
    let has_deliverable = lower_role.contains("## deliverable")
        || lower_role.contains("deliverable:")
        || lower_role.contains("checklist");
    let first_task_score = if has_first_task {
        10
    } else if has_deliverable {
        5
    } else {
        0
    };

    // 8. autonomy_guardrails (max 10)
    let has_turns = cfg.max_turns_per_run.is_some();
    let has_dur = cfg.max_duration_secs.is_some();
    let has_refl_or_sched = agent_opt
        .and_then(|a| a.reflection_mode.as_deref())
        .is_some_and(|m| !m.trim().is_empty())
        || !cfg.failover_engines.is_empty()
        || agent_opt
            .and_then(|a| a.allow_agent_scheduling)
            .is_some();
    let guardrails_score = (if has_turns { 4 } else { 0 })
        + (if has_dur { 3 } else { 0 })
        + (if has_refl_or_sched { 3 } else { 0 });

    let pillars = vec![
        json!({
            "id": "job_brief",
            "label": "Job Brief",
            "score": job_score,
            "maxScore": 15,
            "passed": job_score >= 8,
            "hint": "Define clear role, deliverable, and standards (>= 40 chars)."
        }),
        json!({
            "id": "never_list",
            "label": "Never-List",
            "score": never_score,
            "maxScore": 15,
            "passed": never_score >= 8,
            "hint": "Specify explicit boundaries and prohibited actions."
        }),
        json!({
            "id": "places_sources",
            "label": "Places & Sources",
            "score": places_score,
            "maxScore": 10,
            "passed": places_score >= 8,
            "hint": "Authorize at least one workspace Place or document Sources."
        }),
        json!({
            "id": "skills",
            "label": "Active Skills",
            "score": skills_score,
            "maxScore": 15,
            "passed": skills_score >= 8,
            "hint": "Link workspace/global skills or create local agent skills."
        }),
        json!({
            "id": "knowledge_packs",
            "label": "Knowledge Packs",
            "score": kp_score,
            "maxScore": 15,
            "passed": kp_score >= 8,
            "hint": "Configure and index at least one scoped Knowledge Pack."
        }),
        json!({
            "id": "tool_policy_posture",
            "label": "Tool Policy Posture",
            "score": policy_score,
            "maxScore": 10,
            "passed": policy_score >= 5,
            "hint": "Configure explicit policies for shell, filesystem_write, and Kite tools."
        }),
        json!({
            "id": "first_task",
            "label": "First Task",
            "score": first_task_score,
            "maxScore": 10,
            "passed": first_task_score >= 5,
            "hint": "Include a concrete First Task / kickoff checklist in the contract."
        }),
        json!({
            "id": "autonomy_guardrails",
            "label": "Autonomy Guardrails",
            "score": guardrails_score,
            "maxScore": 10,
            "passed": guardrails_score >= 7,
            "hint": "Set maxTurnsPerRun, maxDurationSecs, and reflection mode."
        }),
    ];
    let total: u64 = job_score
        + never_score
        + places_score
        + skills_score
        + kp_score
        + policy_score
        + first_task_score
        + guardrails_score;
    (total.min(100), pillars)
}

pub fn eval_agent_prompts_at(
    mind_root: &Path,
    agent_id: &str,
    prompts: &[String],
) -> Value {
    let cfg = load_agent_autonomy_config(agent_id);
    let agent_opt = agents()
        .lock()
        .ok()
        .and_then(|items| items.iter().find(|a| a.id == agent_id).cloned());
    let role = agent_opt
        .as_ref()
        .map(|a| if !a.brief.trim().is_empty() { a.brief.trim() } else { a.purpose.trim() })
        .unwrap_or("");
    let mem_dir = mind_root.join(agent_id);
    let memory = std::fs::read_to_string(mem_dir.join("memory.txt")).unwrap_or_default();
    let user = std::fs::read_to_string(mind_root.join("user.txt")).unwrap_or_default();
    let (skills, _) = crate::agent_mind::skills::read_skills(&mem_dir.join("skills"));
    let skill_ids: Vec<String> = skills
        .iter()
        .filter(|s| s.get("enabled").and_then(Value::as_bool).unwrap_or(true))
        .filter_map(|s| s.get("id").and_then(Value::as_str).map(ToString::to_string))
        .collect();
    let compiled = crate::agent_mind::memory::compile_snapshot_instructions_at(
        mind_root,
        agent_id,
        role,
        &memory,
        &user,
        &skill_ids,
    );
    let compiled_chars = compiled.chars().count();
    let estimated_tokens = compiled_chars.div_ceil(4);

    let mut total_blocked_mutations = 0usize;
    let mut results = Vec::new();

    for prompt in prompts {
        let lower = prompt.to_ascii_lowercase();
        let mut predicted_calls: Vec<(&'static str, &'static str, bool)> = Vec::new();
        if lower.contains("search") || lower.contains("read") || lower.contains("doc") || lower.contains("spec") {
            predicted_calls.push(("kite_ctx", "ctx", false));
        }
        if lower.contains("diff") || lower.contains("status") || lower.contains("commit") || lower.contains("git") {
            predicted_calls.push(("kite_diff", "diff", false));
        }
        if lower.contains("create task") || lower.contains("file ticket") || lower.contains("update task") {
            predicted_calls.push(("kite_tasks.create", "tasks", true));
        } else if lower.contains("task") || lower.contains("ticket") || lower.contains("issue") {
            predicted_calls.push(("kite_tasks.list", "tasks", false));
        }
        if lower.contains("write") || lower.contains("edit") || lower.contains("modify") || lower.contains("delete") {
            predicted_calls.push(("filesystem_write", "filesystem_write", true));
        }
        if lower.contains("run ") || lower.contains("shell") || lower.contains("cargo") || lower.contains("vitest") {
            predicted_calls.push(("shell", "shell", true));
        }

        let mut evaluations = Vec::new();
        let mut violations = Vec::new();
        for (tool_name, family, mutating) in predicted_calls {
            let policy = cfg
                .tool_policies
                .get(family)
                .map(String::as_str)
                .unwrap_or_else(|| default_policy_for_family(family));
            let blocked_by_dry_run = mutating;
            if blocked_by_dry_run {
                total_blocked_mutations += 1;
            }
            if policy == "deny" {
                violations.push(format!("Policy denies '{tool_name}' ({family})."));
            } else if blocked_by_dry_run {
                violations.push(format!(
                    "Dry-run read-only guard blocked mutating call '{tool_name}'."
                ));
            }
            evaluations.push(json!({
                "tool": tool_name,
                "family": family,
                "policy": policy,
                "mutating": mutating,
                "blockedInDryRun": blocked_by_dry_run,
            }));
        }

        let matched_skills: Vec<String> = skills
            .iter()
            .filter_map(|s| {
                let sid = s.get("id").and_then(Value::as_str)?;
                let desc = s.get("description").and_then(Value::as_str).unwrap_or("");
                let hay = format!("{sid} {desc}").to_ascii_lowercase();
                let hit = lower
                    .split(|c: char| !c.is_alphanumeric())
                    .filter(|w| w.len() >= 4)
                    .any(|w| hay.contains(w));
                if hit { Some(sid.to_string()) } else { None }
            })
            .collect();

        results.push(json!({
            "prompt": prompt,
            "predictedTools": evaluations,
            "policyViolations": violations,
            "matchedSkills": matched_skills,
            "passed": violations.is_empty(),
        }));
    }

    let passed_cases = results
        .iter()
        .filter(|r| r.get("passed").and_then(Value::as_bool) == Some(true))
        .count();
    let (readiness_score, readiness_pillars) = compute_readiness_pillars(
        mind_root,
        agent_id,
        agent_opt.as_ref(),
        role,
        &memory,
        &skills,
        &cfg,
    );

    json!({
        "agentId": agent_id,
        "compiledPromptChars": compiled_chars,
        "estimatedPromptTokens": estimated_tokens,
        "totalCases": results.len(),
        "passedCases": passed_cases,
        "blockedMutations": total_blocked_mutations,
        "readinessScore": readiness_score,
        "readinessPillars": readiness_pillars,
        "results": results,
    })
}

#[tauri::command]
pub fn dry_run_agent_eval(request: Option<Value>) -> Result<Value, String> {
    let req = request_body(&request).ok_or_else(|| "Eval request is required.".to_string())?;
    let agent_id = req
        .get("agentId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "agentId is required.".to_string())?;
    let prompts: Vec<String> = req
        .get("prompts")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default();
    if prompts.is_empty() {
        return Err("Provide at least one prompt for dry-run eval.".to_string());
    }
    Ok(eval_agent_prompts_at(
        &crate::agent_mind::agents_root(),
        agent_id,
        &prompts,
    ))
}

fn is_token_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.')
}

fn is_path_stop_char(c: char) -> bool {
    c.is_whitespace() || matches!(c, '"' | '\'' | '`' | ',' | ')' | ']' | '>' | ';')
}

/// Strips API keys/secrets and local absolute paths from exported `.kite-agent.json` bundle strings.
pub fn strip_bundle_secrets_and_paths(raw: &str) -> String {
    let mut pass1 = String::with_capacity(raw.len());
    let bytes = raw.as_bytes();
    let mut i = 0usize;
    let secret_prefixes = ["sk-", "ghp_", "gho_", "AIza", "xoxb-", "xoxp-"];
    let kv_prefixes = [
        "bearer ",
        "api_key=",
        "api_key:",
        "apikey=",
        "apikey:",
        "access_token=",
        "access_token:",
        "secret=",
        "secret:",
        "password=",
        "password:",
    ];

    while i < bytes.len() {
        let rest = &raw[i..];
        let mut matched_secret = false;
        for pref in secret_prefixes {
            if rest.starts_with(pref) {
                let mut end = i + pref.len();
                while end < bytes.len() && is_token_char(bytes[end]) {
                    end += 1;
                }
                pass1.push_str("[REDACTED]");
                i = end;
                matched_secret = true;
                break;
            }
        }
        if matched_secret {
            continue;
        }
        let rest_lower = rest.to_ascii_lowercase();
        let mut matched_kv = false;
        for kv in kv_prefixes {
            if rest_lower.starts_with(kv) {
                pass1.push_str(&raw[i..i + kv.len()]);
                let mut j = i + kv.len();
                while j < bytes.len() && bytes[j] == b' ' {
                    pass1.push(' ');
                    j += 1;
                }
                while j < bytes.len() && !bytes[j].is_ascii_whitespace() && bytes[j] != b'"' && bytes[j] != b'\'' {
                    j += 1;
                }
                pass1.push_str("[REDACTED]");
                i = j;
                matched_kv = true;
                break;
            }
        }
        if matched_kv {
            continue;
        }
        let ch = rest.chars().next().unwrap();
        pass1.push(ch);
        i += ch.len_utf8();
    }

    // Strip absolute local filesystem paths (`C:\...`, `/Users/...`, `/home/...`)
    let mut pass2 = String::with_capacity(pass1.len());
    let chars: Vec<(usize, char)> = pass1.char_indices().collect();
    let mut ci = 0usize;
    while ci < chars.len() {
        let (byte_pos, c) = chars[ci];
        let rem = &pass1[byte_pos..];
        let is_win_abs = ci + 2 < chars.len()
            && c.is_ascii_alphabetic()
            && chars[ci + 1].1 == ':'
            && (chars[ci + 2].1 == '\\' || chars[ci + 2].1 == '/');
        let is_unix_abs = rem.starts_with("/Users/") || rem.starts_with("/home/");
        if is_win_abs || is_unix_abs {
            pass2.push_str("<workspace>");
            while ci < chars.len() && !is_path_stop_char(chars[ci].1) {
                ci += 1;
            }
            continue;
        }
        pass2.push(c);
        ci += 1;
    }
    pass2
}

pub fn export_agent_bundle_at(mind_root: &Path, agent_id: &str) -> Result<Value, String> {
    let profile = agents()
        .lock()
        .ok()
        .and_then(|items| items.iter().find(|a| a.id == agent_id).cloned())
        .ok_or_else(|| format!("Agent '{agent_id}' not found."))?;
    let autonomy = load_agent_autonomy_config(agent_id);
    let safe_places: Vec<String> = profile
        .place_display_names
        .iter()
        .filter(|p| {
            let trimmed = p.trim();
            !trimmed.contains(":\\")
                && !trimmed.contains(":/")
                && !trimmed.starts_with("/Users/")
                && !trimmed.starts_with("/home/")
        })
        .cloned()
        .collect();
    let (skills_meta, _) = crate::agent_mind::skills::read_skills(&mind_root.join(agent_id).join("skills"));
    let exported_skills: Vec<Value> = skills_meta
        .into_iter()
        .filter_map(|s| {
            let sid = s.get("id")?.as_str()?.to_string();
            let src = std::fs::read_to_string(
                mind_root.join(agent_id).join("skills").join(format!("{sid}.md")),
            )
            .unwrap_or_default();
            Some(json!({
                "id": sid,
                "name": s.get("name").and_then(Value::as_str).unwrap_or(&sid),
                "source": strip_bundle_secrets_and_paths(&src),
            }))
        })
        .collect();
    let kp_idx = crate::agent_mind::knowledge::load_knowledge_index_at(mind_root, agent_id);
    let exported_packs: Vec<Value> = kp_idx
        .packs
        .into_iter()
        .map(|p| {
            json!({
                "name": p.name,
                "globs": p.globs,
                "enabled": p.enabled,
            })
        })
        .collect();
    let routine_templates: Vec<Value> = crate::persist::routines()
        .lock()
        .ok()
        .map(|list| {
            list.iter()
                .filter(|r| r.get("agentId").and_then(Value::as_str) == Some(agent_id))
                .map(|r| {
                    json!({
                        "name": strip_bundle_secrets_and_paths(r.get("name").and_then(Value::as_str).unwrap_or("")),
                        "prompt": strip_bundle_secrets_and_paths(r.get("prompt").and_then(Value::as_str).unwrap_or("")),
                        "cadence": r.get("cadence").cloned().unwrap_or_else(|| json!({ "kind": "interval", "seconds": 3600 })),
                        "triggerType": r.get("triggerType").and_then(Value::as_str).unwrap_or("schedule"),
                        "outputActions": r.get("outputActions").cloned().unwrap_or_else(|| json!([])),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let linked_skill_refs = crate::persist::get_agent_linked_skill_refs(agent_id);
    Ok(json!({
        "schema": "kite-agent/v1",
        "bundleVersion": 1,
        "exportedAtUnixMs": now_unix_ms(),
        "agent": {
            "name": profile.name,
            "engine": profile.engine,
            "purpose": strip_bundle_secrets_and_paths(&profile.purpose),
            "brief": strip_bundle_secrets_and_paths(&profile.brief),
            "memoryBudget": profile.memory_budget,
            "reflectionMode": profile.reflection_mode,
            "allowAgentScheduling": profile.allow_agent_scheduling,
            "allowAgentMessaging": profile.allow_agent_messaging,
            "defaultMode": profile.default_mode,
            "defaultPlan": profile.default_plan,
            "defaultModel": profile.default_model,
            "defaultProviderOptions": profile.default_provider_options,
            "placeDisplayNames": safe_places,
            "disabledPluginIds": profile.disabled_plugin_ids,
            "linkedSkillRefs": linked_skill_refs,
            "toolPolicies": autonomy.tool_policies,
            "maxTurnsPerRun": autonomy.max_turns_per_run,
            "maxDurationSecs": autonomy.max_duration_secs,
            "failoverEngines": autonomy.failover_engines,
        },
        "skills": exported_skills,
        "knowledgePacks": exported_packs,
        "routineTemplates": routine_templates,
    }))
}

#[tauri::command]
pub fn export_agent_bundle(request: Option<Value>) -> Result<Value, String> {
    let req = request_body(&request).ok_or_else(|| "Export request is required.".to_string())?;
    let agent_id = req
        .get("agentId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "agentId is required.".to_string())?;
    export_agent_bundle_at(&crate::agent_mind::agents_root(), agent_id)
}

#[tauri::command]
pub fn import_agent_bundle(request: Option<Value>) -> Result<Value, String> {
    let req = request_body(&request).ok_or_else(|| "Import request is required.".to_string())?;
    let bundle = req.get("bundle").unwrap_or(req);
    let schema = bundle.get("schema").and_then(Value::as_str).unwrap_or("");
    if schema != "kite-agent/v1" && bundle.get("bundleVersion").and_then(Value::as_u64) != Some(1) {
        return Err("Invalid .kite-agent.json bundle schema. Expected 'kite-agent/v1'.".to_string());
    }
    let agent_obj = bundle
        .get("agent")
        .and_then(Value::as_object)
        .ok_or_else(|| "Bundle missing 'agent' object.".to_string())?;
    let raw_name = agent_obj
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("Imported Specialist");
    let engine = agent_obj
        .get("engine")
        .and_then(Value::as_str)
        .unwrap_or("claude-code");
    let brief = strip_bundle_secrets_and_paths(
        agent_obj
            .get("brief")
            .or_else(|| agent_obj.get("purpose"))
            .and_then(Value::as_str)
            .unwrap_or(""),
    );
    let linked_refs = parse_string_list(
        Some(&Value::Object(agent_obj.clone())),
        &["linkedSkillRefs", "linked_skill_refs"],
    )
    .or_else(|| parse_string_list(Some(bundle), &["linkedSkillRefs", "linked_skill_refs"]))
    .unwrap_or_default();
    let created = create_agent(Some(json!({
        "name": raw_name,
        "engine": engine,
        "brief": brief,
        "defaultMode": agent_obj.get("defaultMode").cloned().unwrap_or(Value::Null),
        "defaultModel": agent_obj.get("defaultModel").cloned().unwrap_or(Value::Null),
        "defaultPlan": agent_obj.get("defaultPlan").cloned().unwrap_or(Value::Null),
        "defaultProviderOptions": agent_obj.get("defaultProviderOptions").cloned().unwrap_or(json!([])),
        "memoryBudget": agent_obj.get("memoryBudget").cloned().unwrap_or(Value::Null),
        "reflectionMode": agent_obj.get("reflectionMode").cloned().unwrap_or(Value::Null),
        "allowAgentScheduling": agent_obj.get("allowAgentScheduling").cloned().unwrap_or(Value::Null),
        "allowAgentMessaging": agent_obj.get("allowAgentMessaging").cloned().unwrap_or(Value::Null),
        "placeDisplayNames": agent_obj.get("placeDisplayNames").cloned().unwrap_or(json!([])),
        "disabledPluginIds": agent_obj.get("disabledPluginIds").cloned().unwrap_or(json!([])),
        "linkedSkillRefs": linked_refs,
    })));
    let new_id = created
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if new_id.is_empty() {
        return Err("Failed to create imported agent profile.".to_string());
    }
    let mut autonomy = AgentAutonomyConfig::default();
    sanitize_autonomy_config_patch(&Value::Object(agent_obj.clone()), &mut autonomy);
    if autonomy.knowledge_packs.is_empty() {
        if let Some(packs) = bundle.get("knowledgePacks").and_then(Value::as_array) {
            let mut patch_val = serde_json::Map::new();
            patch_val.insert("knowledgePacks".to_string(), Value::Array(packs.clone()));
            sanitize_autonomy_config_patch(&Value::Object(patch_val), &mut autonomy);
        }
    }
    let fallback_ws_root = resolve_agent_authorized_roots(Some(&new_id), None)
        .into_iter()
        .find(|p| p != &crate::agent_mind::get_agent_home_dir(&new_id));
    for pack in &mut autonomy.knowledge_packs {
        if pack.root_path.trim().is_empty() {
            if let Some(ref ws_root) = fallback_ws_root {
                pack.root_path = ws_root.to_string_lossy().to_string();
            }
        }
    }
    save_agent_autonomy_config(&new_id, &autonomy)?;

    let root = crate::agent_mind::agents_root();
    if !autonomy.knowledge_packs.is_empty() {
        sync_autonomy_knowledge_packs_to_mind(
            &root,
            &new_id,
            &autonomy,
            fallback_ws_root.as_deref(),
        );
    }

    if let Some(skills) = bundle.get("skills").and_then(Value::as_array) {
        let skills_dir = root.join(&new_id).join("skills");
        let _ = std::fs::create_dir_all(&skills_dir);
        for sk in skills {
            if let (Some(id), Some(src)) = (
                sk.get("id").and_then(Value::as_str),
                sk.get("source").and_then(Value::as_str),
            ) {
                let safe_id: String = id
                    .chars()
                    .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
                    .collect();
                if !safe_id.is_empty() {
                    let _ = std::fs::write(
                        skills_dir.join(format!("{safe_id}.md")),
                        strip_bundle_secrets_and_paths(src),
                    );
                }
            }
        }
    }
    let _ = crate::agent_mind::sync_agent_instructions(&root, &new_id);

    Ok(json!({
        "imported": true,
        "agent": load_agent_profile(json!({ "agentId": new_id })),
    }))
}

#[tauri::command]
pub fn list_curated_agent_templates() -> Value {
    json!({
        "templates": [
            {
                "id": "odd-architect",
                "name": "ODD Architect",
                "engine": "antigravity",
                "roleBadge": "Architecture & ODDs",
                "summary": "Writes clean-room ODD specs, maps dependencies, and plans reviewable slices.",
                "brief": "Author concise Organic Driven Development specifications, enforce clean module boundaries, and keep Risk assessments explicit.",
                "toolPolicies": { "ctx": "allow", "diff": "allow", "tasks": "allow", "filesystem_write": "ask", "shell": "ask" },
                "knowledgePackGlobs": ["odd/tasks/*.md", "docs/**/*.md"]
            },
            {
                "id": "security-policy-auditor",
                "name": "Security & Policy Auditor",
                "engine": "claude-code",
                "roleBadge": "Security Auditor",
                "summary": "Audits diffs, tool permissions, credential handling, and Places sandboxes.",
                "brief": "Inspect diffs and permission boundaries for privilege escalation, secret leaks, path traversal, and missing input validation.",
                "toolPolicies": { "ctx": "allow", "diff": "allow", "tasks": "ask", "filesystem_write": "deny", "shell": "deny" },
                "knowledgePackGlobs": ["src-tauri/src/**/*.rs", "odd/tasks/*.md"]
            },
            {
                "id": "test-regression-runner",
                "name": "Test & Regression Runner",
                "engine": "codex",
                "roleBadge": "Test & QA Engineer",
                "summary": "Reproduces failures RED-first and runs focused Cargo/Vitest/TSC verification suites.",
                "brief": "Verify changes through RED->GREEN tests across Rust Cargo suites, Vitest specs, and TypeScript checks without mocking away assertions.",
                "toolPolicies": { "ctx": "allow", "diff": "allow", "tasks": "allow", "filesystem_write": "allow", "shell": "ask" },
                "knowledgePackGlobs": ["src/**/*.test.ts*", "scripts/e2e/**/*.mjs"]
            },
            {
                "id": "pr-diff-reviewer",
                "name": "PR Diff Reviewer",
                "engine": "claude-code",
                "roleBadge": "PR Reviewer",
                "summary": "Reviews slices for correctness, edge cases, UI token adherence, and clean-room hygiene.",
                "brief": "Perform adversarial read-only diff reviews highlighting concrete bugs, contract breaks, and design token drift.",
                "toolPolicies": { "ctx": "allow", "diff": "allow", "tasks": "ask", "filesystem_write": "deny", "shell": "deny" },
                "knowledgePackGlobs": ["AGENTS.md", "docs/**/*.md"]
            },
            {
                "id": "research-librarian",
                "name": "Research Librarian",
                "engine": "grok",
                "roleBadge": "Codebase Librarian",
                "summary": "Indexes documentation and ODD specs into concise SharedContext handoffs.",
                "brief": "Use Knowledge Packs and compact kite_ctx reads to synthesize grounded architecture maps without mutating repository files.",
                "toolPolicies": { "ctx": "allow", "diff": "allow", "memory": "allow", "filesystem_write": "deny", "shell": "deny" },
                "knowledgePackGlobs": ["docs/**/*.md", "odd/tasks/*.md", "README.md"]
            },
            {
                "id": "ship-guard",
                "name": "Ship Guard",
                "engine": "antigravity",
                "roleBadge": "Release & Clean-Room Gate",
                "summary": "Slices dirty trees into Conventional Commits, verifies quality gates, and blocks clean-room leaks before push.",
                "brief": "## Job\nPrepare safe, reviewable Conventional Commit slices, run proportional Tier 1/2/3 verification gates, and enforce clean-room hygiene before any commit or push.\n\n## Sources\n- AGENTS.md, odd/tasks/*.md, docs/qa/*.md, CHANGELOG.md\n- git status / kite_diff / node .kite/sanitizer/audit-references.mjs --check\n\n## Never-List\n- Never run git commit or git push without running `node .kite/sanitizer/audit-references.mjs --check` and confirming `[AUDIT CLEAN]`.\n- Never include Co-Authored-By trailers, AI attribution, external reference names, or `.kite/` internal files in public commits.\n- Never run git push without explicit user approval after presenting the commit slice plan and test output.\n- Never mark an ODD verification task complete when verify:gate fails or is incomplete.\n\n## Deliverable\nClean commit slice ledger (`git diff --stat`), observed verification gate outputs (`verify:ipc`, `verify:design`, `tsc`, Vitest, Cargo), `[AUDIT CLEAN]` proof, and push approval request.\n\n## First Task\nInspect `git status --short`, run `node .kite/sanitizer/audit-references.mjs --check`, group unstaged work into self-contained slices (~400 lines max), and report passing vs pending checks before committing.\n\n## Autonomy\nmaxTurnsPerRun: 16 | maxDurationSecs: 900 | reflectionMode: ask | shell: ask | filesystem_write: ask",
                "defaultMode": "acceptEdits",
                "memoryBudget": 2800,
                "reflectionMode": "ask",
                "maxTurnsPerRun": 16,
                "maxDurationSecs": 900,
                "failoverEngines": [],
                "places": ["Current Workspace"],
                "linkedSkillRefs": [
                    "workspace:work-unit-commits",
                    "workspace:kite-delivery-loop",
                    "workspace:pre-push-cleanroom-gate"
                ],
                "toolPolicies": {
                    "ctx": "allow",
                    "diff": "allow",
                    "tasks": "allow",
                    "memory": "allow",
                    "thread": "allow",
                    "routine": "allow",
                    "teammate": "allow",
                    "filesystem_write": "ask",
                    "shell": "ask"
                },
                "knowledgePackGlobs": ["AGENTS.md", "odd/tasks/*.md", "docs/qa/*.md", "CHANGELOG.md"]
            },
            {
                "id": "discovery-architect",
                "name": "Discovery Architect",
                "engine": "antigravity",
                "roleBadge": "Discovery & ODD Architect",
                "summary": "Researches features and architecture, drafts clean-room ODD specs, and launches orchestrator threads.",
                "brief": "## Job\nInvestigate product capabilities, codebase architecture, and docs; produce clean-room Organic Driven Development (`odd/tasks/<slug>.md`) specifications; and launch top-level orchestrator threads via `kite_thread launch` when ready.\n\n## Sources\n- AGENTS.md, odd/tasks/*.md, docs/**/*.md\n- kite_ctx compact reads/searches and linked discovery/ODD skills\n\n## Never-List\n- Never write external reference names into public `odd/tasks/*.md`, `docs/`, UI copy, or source code (keep reference notes strictly inside gitignored `.kite/tasks/`).\n- Never implement a single partial slice as the entire feature without inventorying all user-visible behaviors first.\n- Never execute unrequested destructive mutations or skip `Risk:` classification.\n- Never dump raw file trees when compact `kite_ctx` reads and concise ODD specs suffice.\n\n## Deliverable\nClean-room ODD spec (`## Specs` with verbatim quotes, `## Tasks` with `S#` & `Risk:` lines, `## Log`) and optional launched orchestrator thread (`kite_thread launch` receipt).\n\n## First Task\nInventory the requested capability across existing codebase files and docs, ask at most one clarifying product question if a real fork exists, draft `odd/tasks/<slug>.md`, and offer to launch it in a new orchestrator thread.\n\n## Autonomy\nmaxTurnsPerRun: 20 | maxDurationSecs: 1200 | reflectionMode: ask | shell: ask | filesystem_write: ask",
                "defaultMode": "acceptEdits",
                "memoryBudget": 3200,
                "reflectionMode": "ask",
                "maxTurnsPerRun": 20,
                "maxDurationSecs": 1200,
                "failoverEngines": [],
                "places": ["Current Workspace"],
                "linkedSkillRefs": [
                    "workspace:port-from-product",
                    "workspace:odd-workflow",
                    "workspace:cognitive-doc-design"
                ],
                "toolPolicies": {
                    "ctx": "allow",
                    "diff": "allow",
                    "tasks": "allow",
                    "memory": "allow",
                    "thread": "allow",
                    "routine": "allow",
                    "teammate": "allow",
                    "filesystem_write": "ask",
                    "shell": "ask"
                },
                "knowledgePackGlobs": ["odd/tasks/*.md", "docs/**/*.md", "AGENTS.md"]
            }
        ]
    })
}

pub fn install_curated_agent_template_core(
    template_id: &str,
    workspace_path: Option<&str>,
    extra_places: &[String],
) -> Result<Value, String> {
    let clean_tpl_id = template_id.trim();
    let templates_val = list_curated_agent_templates();
    let tpl = templates_val
        .get("templates")
        .and_then(Value::as_array)
        .and_then(|arr| {
            arr.iter().find(|t| {
                t.get("id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| id.eq_ignore_ascii_case(clean_tpl_id))
            })
        })
        .cloned()
        .ok_or_else(|| format!("Unknown curated agent template '{clean_tpl_id}'."))?;

    let tpl_id = tpl.get("id").and_then(Value::as_str).unwrap_or(clean_tpl_id);
    let tpl_name = tpl.get("name").and_then(Value::as_str).unwrap_or("Specialist");
    let tpl_engine = tpl.get("engine").and_then(Value::as_str).unwrap_or("antigravity");
    let tpl_brief = tpl.get("brief").and_then(Value::as_str).unwrap_or("");
    let tpl_default_mode = tpl
        .get("defaultMode")
        .and_then(Value::as_str)
        .unwrap_or("fullAccess");
    let tpl_memory_budget = tpl
        .get("memoryBudget")
        .and_then(Value::as_i64)
        .unwrap_or(2800);
    let tpl_reflection_mode = tpl
        .get("reflectionMode")
        .and_then(Value::as_str)
        .unwrap_or("ask");
    let tpl_max_turns = tpl
        .get("maxTurnsPerRun")
        .and_then(Value::as_u64)
        .map(|n| n.clamp(1, 100) as u32)
        .or(Some(16));
    let tpl_max_duration = tpl
        .get("maxDurationSecs")
        .and_then(Value::as_u64)
        .map(|n| n.clamp(30, 7200))
        .or(Some(900));

    let linked_refs = filter_valid_linked_skill_refs(
        &parse_string_list(Some(&tpl), &["linkedSkillRefs"]).unwrap_or_default(),
    );
    let pack_globs = parse_string_list(Some(&tpl), &["knowledgePackGlobs"]).unwrap_or_default();

    let mut places: Vec<String> = Vec::new();
    let mut resolved_ws_root: Option<PathBuf> = None;

    let workspaces = crate::persist::workspaces()
        .lock()
        .map(|w| w.clone())
        .unwrap_or_default();

    for ep in extra_places {
        let clean = ep.trim();
        if clean.is_empty() {
            continue;
        }
        if !places.iter().any(|p| p.eq_ignore_ascii_case(clean)) {
            places.push(clean.to_string());
        }
        if resolved_ws_root.is_none() {
            if let Some(ws) = workspaces
                .iter()
                .find(|w| w.id == clean || w.display_name.eq_ignore_ascii_case(clean))
            {
                if let Some(p) = crate::persist::workspace_path(&ws.id) {
                    let pb = PathBuf::from(p);
                    if pb.is_dir() {
                        resolved_ws_root = Some(pb);
                    }
                }
            } else {
                let pb = PathBuf::from(clean);
                if pb.is_dir() {
                    resolved_ws_root = Some(pb);
                }
            }
        }
    }

    if let Some(ws_arg) = workspace_path.map(str::trim).filter(|s| !s.is_empty()) {
        if let Some(ws) = workspaces.iter().find(|w| {
            w.id == ws_arg
                || w.display_name.eq_ignore_ascii_case(ws_arg)
                || crate::persist::workspace_path(&w.id)
                    .is_some_and(|p| PathBuf::from(&p) == PathBuf::from(ws_arg))
        }) {
            if !places.iter().any(|p| p.eq_ignore_ascii_case(&ws.display_name)) {
                places.push(ws.display_name.clone());
            }
            if let Some(p) = crate::persist::workspace_path(&ws.id) {
                let pb = PathBuf::from(p);
                if pb.is_dir() {
                    resolved_ws_root = Some(pb);
                }
            }
        } else {
            if !places.iter().any(|p| p.eq_ignore_ascii_case(ws_arg)) {
                places.push(ws_arg.to_string());
            }
            let pb = PathBuf::from(ws_arg);
            if pb.is_dir() {
                resolved_ws_root = Some(pb);
            }
        }
    } else if places.is_empty() {
        let mut sorted_ws = workspaces;
        sorted_ws.sort_by(|a, b| b.last_opened_at_unix_ms.cmp(&a.last_opened_at_unix_ms));
        for ws in sorted_ws {
            if let Some(p) = crate::persist::workspace_path(&ws.id) {
                let pb = PathBuf::from(p);
                if pb.is_dir() {
                    places.push(ws.display_name);
                    resolved_ws_root = Some(pb);
                    break;
                }
            }
        }
    }

    let existing_id = {
        let list = agents().lock().unwrap();
        list.iter()
            .find(|a| a.name.eq_ignore_ascii_case(tpl_name) || a.id == tpl_id)
            .map(|a| a.id.clone())
    };

    let (agent_id, created) = if let Some(aid) = existing_id {
        let mut merged_places = {
            let mut list = agents().lock().unwrap();
            if let Some(a) = list.iter_mut().find(|a| a.id == aid) {
                a.engine = teammate_engine(Some(tpl_engine));
                a.purpose = tpl_brief.to_string();
                a.brief = tpl_brief.to_string();
                a.memory_budget = Some(tpl_memory_budget);
                a.reflection_mode = Some(tpl_reflection_mode.to_string());
                a.default_mode = Some(tpl_default_mode.to_string());
                a.allow_agent_scheduling = Some(true);
                a.allow_agent_messaging = Some(true);
                for p in &places {
                    if !a.place_display_names.iter().any(|e| e.eq_ignore_ascii_case(p)) {
                        a.place_display_names.push(p.clone());
                    }
                }
                a.place_display_names.clone()
            } else {
                places.clone()
            }
        };
        if merged_places.is_empty() && !places.is_empty() {
            merged_places = places.clone();
        }
        let _ = merged_places;
        persist();
        (aid, false)
    } else {
        let created_val = create_agent(Some(json!({
            "name": tpl_name,
            "engine": tpl_engine,
            "brief": tpl_brief,
            "defaultMode": tpl_default_mode,
            "memoryBudget": tpl_memory_budget,
            "reflectionMode": tpl_reflection_mode,
            "allowAgentScheduling": true,
            "allowAgentMessaging": true,
            "placeDisplayNames": places,
            "linkedSkillRefs": linked_refs,
        })));
        let new_id = created_val
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| "Failed to allocate curated agent id.".to_string())?
            .to_string();
        (new_id, true)
    };

    if !linked_refs.is_empty() {
        crate::persist::set_agent_linked_skill_refs(&agent_id, &linked_refs)?;
    }

    let mut cfg = load_agent_autonomy_config(&agent_id);
    sanitize_autonomy_config_patch(&tpl, &mut cfg);
    cfg.max_turns_per_run = tpl_max_turns;
    cfg.max_duration_secs = tpl_max_duration;

    let authorized_roots = resolve_agent_authorized_roots(Some(&agent_id), resolved_ws_root.as_deref());
    let pack_root = resolved_ws_root
        .clone()
        .or_else(|| {
            authorized_roots
                .iter()
                .find(|p| p != &&crate::agent_mind::get_agent_home_dir(&agent_id) && p.is_dir())
                .cloned()
        });

    let mind_root = crate::agent_mind::agents_root();
    if let Some(ref kp_dir) = pack_root {
        let kp_id = format!("kp-{tpl_id}-workspace");
        let kp_name = format!("{tpl_name} Context");
        let kp_root_str = kp_dir.to_string_lossy().to_string();
        if let Some(existing_kp) = cfg.knowledge_packs.iter_mut().find(|p| p.id == kp_id) {
            existing_kp.name = kp_name.clone();
            existing_kp.root_path = kp_root_str.clone();
            existing_kp.globs = pack_globs.clone();
            existing_kp.enabled = true;
        } else {
            cfg.knowledge_packs.push(KnowledgePackConfig {
                id: kp_id.clone(),
                name: kp_name.clone(),
                root_path: kp_root_str.clone(),
                globs: pack_globs.clone(),
                enabled: true,
            });
        }
        save_agent_autonomy_config(&agent_id, &cfg)?;
        crate::agent_mind::knowledge::save_knowledge_pack_at(
            &mind_root,
            &agent_id,
            &authorized_roots,
            Some(&kp_id),
            &kp_name,
            &kp_root_str,
            pack_globs,
            true,
        )
        .map_err(|e| format!("{}: {}", e.code, e.message))?;
    } else {
        save_agent_autonomy_config(&agent_id, &cfg)?;
    }

    let _ = crate::agent_mind::sync_agent_instructions(&mind_root, &agent_id);
    let eval = eval_agent_prompts_at(
        &mind_root,
        &agent_id,
        &["Verify status and check documentation".to_string()],
    );

    Ok(json!({
        "installed": true,
        "created": created,
        "templateId": tpl_id,
        "agentId": agent_id,
        "agent": agent_profile_json(&agent_id),
        "readinessScore": eval["readinessScore"],
        "readinessPillars": eval["readinessPillars"],
    }))
}

#[tauri::command]
pub fn install_curated_agent_template(request: Value) -> Result<Value, String> {
    let req = request.get("request").unwrap_or(&request);
    let template_id = req
        .get("templateId")
        .or_else(|| req.get("template_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "templateId is required.".to_string())?;
    let workspace_path = req
        .get("workspacePath")
        .or_else(|| req.get("workspace_path"))
        .or_else(|| req.get("workspaceId"))
        .or_else(|| req.get("workspace_id"))
        .and_then(Value::as_str);
    let extra_places = parse_string_list(Some(req), &["extraPlaces", "extra_places", "places"])
        .unwrap_or_default();
    install_curated_agent_template_core(template_id, workspace_path, &extra_places)
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

    #[test]
    fn audit_log_roundtrips_dry_run_eval_blocks_mutations_and_bundle_strips_secrets() {
        // 1. Audit log SQLite CRUD + filtering
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE agent_audit_log (
                id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, thread_id TEXT,
                tool_name TEXT NOT NULL, tool_family TEXT NOT NULL, verdict TEXT NOT NULL,
                reason TEXT, duration_ms INTEGER NOT NULL DEFAULT 0, skill_event TEXT,
                created_at_unix_ms INTEGER NOT NULL
            );",
        )
        .unwrap();
        record_agent_audit_in_conn(
            &conn,
            &AgentAuditLogEntry {
                id: "aud-1".into(),
                agent_id: "ag-audit".into(),
                thread_id: Some("t-1".into()),
                tool_name: "kite_diff".into(),
                tool_family: "diff".into(),
                verdict: "denied".into(),
                reason: Some("Policy denied".into()),
                duration_ms: 4,
                skill_event: None,
                created_at_unix_ms: 1000,
            },
        )
        .unwrap();
        let denied = list_agent_audit_log_in_conn(&conn, Some("ag-audit"), Some("denied"), None, 10).unwrap();
        assert_eq!(denied.len(), 1);
        assert_eq!(denied[0].tool_name, "kite_diff");

        // 2. Dry-run eval blocks mutating calls & computes token budget
        let mind_root = std::env::temp_dir().join(format!("kite_eval_mind_{}", Uuid::new_v4()));
        let eval_agent_id = format!("test-eval-{}", Uuid::new_v4());
        std::fs::create_dir_all(mind_root.join(&eval_agent_id)).unwrap();
        let res = eval_agent_prompts_at(
            &mind_root,
            &eval_agent_id,
            &[
                "Read diff status".to_string(),
                "Write file and run cargo test".to_string(),
            ],
        );
        assert_eq!(res["totalCases"], 2);
        assert!(res["blockedMutations"].as_u64().unwrap() >= 2);
        assert_eq!(res["results"][0]["passed"], true);
        assert_eq!(res["results"][1]["passed"], false);

        // 3. Bundle secret & path stripping + curated 5 templates
        let raw_secret = "Use key sk-testsecret12345 and Bearer abcdef99 in C:\\Users\\Dev\\secret\\repo or /home/dev/project.";
        let sanitized = strip_bundle_secrets_and_paths(raw_secret);
        assert!(!sanitized.contains("sk-testsecret12345"));
        assert!(!sanitized.contains("abcdef99"));
        assert!(!sanitized.contains("C:\\Users\\Dev"));
        assert!(!sanitized.contains("/home/dev/project"));
        assert!(sanitized.contains("[REDACTED]"));
        assert!(sanitized.contains("<workspace>"));

        let templates = list_curated_agent_templates();
        let tpl_arr = templates["templates"].as_array().unwrap();
        assert_eq!(tpl_arr.len(), 7);
        assert!(tpl_arr.iter().any(|t| t["id"] == "ship-guard" && t["engine"] == "antigravity"));
        assert!(tpl_arr.iter().any(|t| t["id"] == "discovery-architect" && t["engine"] == "antigravity"));
        assert!(!tpl_arr.iter().any(|t| {
            let name = t["name"].as_str().unwrap_or("");
            name.contains("Blind Judge") || name.contains("QA Hunter") || name.contains("Watchdog")
        }));

        let summary = get_agent_autonomy_summary(None);
        assert!(summary["auditCounts"].is_object());
        assert!(summary["recentRoutineRuns"].is_array());
        let rail = list_agent_rail_activity_sync(None);
        if let Some(first) = rail.first() {
            assert!(first["runningSources"].is_array());
        }

        let _ = std::fs::remove_dir_all(&mind_root);
    }

    #[test]
    fn create_update_and_import_preserve_full_agent_fields_and_readiness_rubric() {
        let ws_dir = std::env::temp_dir().join(format!("kite-ag-rt-ws-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&ws_dir).unwrap();
        std::fs::write(ws_dir.join("AGENTS.md"), "# Workspace Rules\nClean room.\n").unwrap();

        let created = create_agent(Some(json!({
            "name": "Full Roundtrip Agent",
            "engine": "antigravity",
            "brief": "## Job\nKeep code clean.\n\n## Never-List\n- Never leak secrets.\n\n## First Task\nInspect status.",
            "memoryBudget": 3200,
            "reflectionMode": "auto",
            "allowAgentScheduling": true,
            "allowAgentMessaging": false,
            "placeDisplayNames": [ws_dir.to_string_lossy()],
            "disabledPluginIds": ["kite-ctx"],
            "linkedSkillRefs": ["workspace:odd-workflow"],
            "toolPolicies": { "shell": "ask", "filesystem_write": "ask", "ctx": "allow" },
            "maxTurnsPerRun": 12,
            "maxDurationSecs": 600,
            "failoverEngines": ["codex"],
            "knowledgePacks": [{ "name": "Agents", "rootPath": ws_dir.to_string_lossy(), "globs": ["AGENTS.md"], "enabled": true }]
        })));
        let id = created["id"].as_str().unwrap().to_string();
        assert_eq!(created["memoryBudget"], 3200);
        assert_eq!(created["reflectionMode"], "auto");
        assert_eq!(created["allowAgentMessaging"], false);
        assert_eq!(created["linkedSkillRefs"], json!(["workspace:odd-workflow"]));
        assert_eq!(created["toolPolicies"]["shell"], "ask");
        assert_eq!(created["failoverEngines"], json!(["codex"]));
        assert_eq!(created["knowledgePacks"][0]["name"], "Agents");

        let updated = update_agent_profile(Some(json!({
            "agentId": id,
            "linkedSkillRefs": ["workspace:odd-workflow", "workspace:kite-delivery-loop"],
            "toolPolicies": { "shell": "deny", "filesystem_write": "ask", "ctx": "allow" },
            "failoverEngines": ["claude-code"]
        })));
        assert_eq!(
            updated["linkedSkillRefs"],
            json!(["workspace:odd-workflow", "workspace:kite-delivery-loop"])
        );
        assert_eq!(updated["toolPolicies"]["shell"], "deny");
        assert_eq!(updated["failoverEngines"], json!(["claude-code"]));

        let bundle = export_agent_bundle(Some(json!({ "agentId": id }))).unwrap();
        let imported = import_agent_bundle(Some(json!({ "bundle": bundle }))).unwrap();
        let imported_id = imported["agent"]["id"].as_str().unwrap().to_string();
        assert_eq!(imported["agent"]["reflectionMode"], "auto");
        assert_eq!(imported["agent"]["memoryBudget"], 3200);
        assert_eq!(imported["agent"]["toolPolicies"]["shell"], "deny");
        assert_eq!(
            imported["agent"]["linkedSkillRefs"],
            json!(["workspace:odd-workflow", "workspace:kite-delivery-loop"])
        );

        let bare = create_agent(Some(json!({
            "name": "Bare Agent",
            "engine": "antigravity",
            "brief": "Helper"
        })));
        let bare_id = bare["id"].as_str().unwrap().to_string();
        let bare_eval = eval_agent_prompts_at(
            &crate::agent_mind::agents_root(),
            &bare_id,
            &["Read diff".to_string()],
        );
        assert!(bare_eval["readinessScore"].as_u64().unwrap() < 30);
        assert_eq!(bare_eval["readinessPillars"].as_array().unwrap().len(), 8);

        let rich_eval = eval_agent_prompts_at(
            &crate::agent_mind::agents_root(),
            &id,
            &["Read diff".to_string()],
        );
        assert!(
            rich_eval["readinessScore"].as_u64().unwrap() >= 85,
            "richly configured specialist should score >= 85, got {}",
            rich_eval["readinessScore"]
        );

        agents().lock().unwrap().retain(|a| a.id != id && a.id != imported_id && a.id != bare_id);
        let _ = std::fs::remove_dir_all(&ws_dir);
        let _ = std::fs::remove_dir_all(crate::agent_mind::agents_root().join(&id));
        let _ = std::fs::remove_dir_all(crate::agent_mind::agents_root().join(&imported_id));
        let _ = std::fs::remove_dir_all(crate::agent_mind::agents_root().join(&bare_id));
    }

    #[test]
    fn install_curated_agent_template_is_idempotent_for_ship_guard_and_discovery_architect() {
        let ws_dir = std::env::temp_dir().join(format!("kite-curated-ws-{}", Uuid::new_v4()));
        std::fs::create_dir_all(ws_dir.join("odd").join("tasks")).unwrap();
        std::fs::create_dir_all(ws_dir.join("docs")).unwrap();
        std::fs::write(ws_dir.join("AGENTS.md"), "# Kite Agents\n").unwrap();
        std::fs::write(ws_dir.join("odd").join("tasks").join("sample.md"), "# Sample ODD\n").unwrap();

        let ws_str = ws_dir.to_string_lossy().to_string();

        // Install Ship Guard twice (idempotent)
        let first_sg = install_curated_agent_template_core("ship-guard", Some(&ws_str), &[]).unwrap();
        assert_eq!(first_sg["created"], true);
        assert_eq!(first_sg["agent"]["engine"], "antigravity");
        assert!(
            first_sg["readinessScore"].as_u64().unwrap() >= 85,
            "ship-guard readiness must be >= 85, got {}",
            first_sg["readinessScore"]
        );
        let sg_id = first_sg["agentId"].as_str().unwrap().to_string();

        let second_sg = install_curated_agent_template_core("ship-guard", Some(&ws_str), &[]).unwrap();
        assert_eq!(second_sg["created"], false);
        assert_eq!(second_sg["agentId"].as_str(), Some(sg_id.as_str()));
        assert_eq!(
            second_sg["agent"]["linkedSkillRefs"],
            json!([
                "workspace:work-unit-commits",
                "workspace:kite-delivery-loop",
                "workspace:pre-push-cleanroom-gate"
            ])
        );

        // Install Discovery Architect via IPC entrypoint
        let da = install_curated_agent_template(json!({
            "request": {
                "templateId": "discovery-architect",
                "workspacePath": ws_str
            }
        }))
        .unwrap();
        assert_eq!(da["created"], true);
        assert_eq!(da["agent"]["engine"], "antigravity");
        assert!(
            da["readinessScore"].as_u64().unwrap() >= 85,
            "discovery-architect readiness must be >= 85, got {}",
            da["readinessScore"]
        );
        let da_id = da["agentId"].as_str().unwrap().to_string();
        assert_eq!(
            da["agent"]["linkedSkillRefs"],
            json!([
                "workspace:port-from-product",
                "workspace:odd-workflow",
                "workspace:cognitive-doc-design"
            ])
        );

        agents().lock().unwrap().retain(|a| a.id != sg_id && a.id != da_id);
        let _ = std::fs::remove_dir_all(&ws_dir);
        let _ = std::fs::remove_dir_all(crate::agent_mind::agents_root().join(&sg_id));
        let _ = std::fs::remove_dir_all(crate::agent_mind::agents_root().join(&da_id));
    }
}
