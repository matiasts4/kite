use crate::chat::live_turns;
use crate::persist::{agents, persist, threads, AgentProfile};
use crate::terminal::engine_installed;
use serde_json::{json, Value};
use std::path::PathBuf;
use uuid::Uuid;

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
    let items = agents().lock().unwrap();
    if let Some(agent) = items.iter().find(|a| a.id == agent_id) {
        return serde_json::to_value(agent).unwrap_or_else(|_| json!({
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
    }
    json!({
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
        "defaultMode": "acceptEdits",
        "defaultPlan": Value::Null,
        "defaultModel": Value::Null,
        "defaultProviderOptions": [],
        "placeDisplayNames": [],
        "disabledPluginIds": []
    })
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

fn push_agent(name: &str, engine: &str, purpose: &str) -> Value {
    let agent_id = Uuid::new_v4().to_string();
    let now = now_ms();
    let safe_name = {
        let trimmed = plain_text(name, 80);
        if trimmed.is_empty() { "New Agent".to_string() } else { trimmed }
    };
    let safe_engine = teammate_engine(Some(engine));
    let safe_purpose = plain_text(purpose, 4000);
    let safe_brief = safe_purpose.clone();
    let order = {
        let mut state = agents().lock().unwrap();
        let next_order = state.len() as i32;
        state.push(AgentProfile {
            id: agent_id.clone(),
            name: safe_name.clone(),
            engine: safe_engine.clone(),
            purpose: safe_purpose.clone(),
            brief: safe_brief.clone(),
            avatar: None,
            created_at_unix_ms: now,
            pinned: false,
            order: next_order,
            memory_budget: None,
            reflection_mode: None,
            allow_agent_scheduling: None,
            allow_agent_messaging: None,
            default_mode: None,
            default_plan: None,
            default_model: None,
            default_provider_options: vec![],
            place_display_names: vec![],
            disabled_plugin_ids: vec![],
        });
        next_order
    };
    persist();
    let _ = crate::agent_mind::sync_agent_instructions(&crate::agent_mind::agents_root(), &agent_id);
    json!({
        "id": agent_id,
        "name": safe_name,
        "engine": safe_engine,
        "purpose": safe_purpose,
        "brief": safe_brief,
        "avatar": Value::Null,
        "createdAtUnixMs": now,
        "pinned": false,
        "order": order,
        "defaultProviderOptions": [],
        "placeDisplayNames": [],
        "disabledPluginIds": []
    })
}

#[tauri::command]
pub fn create_agent(request: Option<Value>) -> Value {
    let req = request_body(&request);
    let name = req.and_then(|r| r.get("name")).and_then(|v| v.as_str()).unwrap_or("New Agent");
    let engine = req.and_then(|r| r.get("engine")).and_then(|v| v.as_str()).unwrap_or("antigravity");
    let purpose = req.and_then(|r| r.get("purpose")).or_else(|| req.and_then(|r| r.get("brief"))).and_then(|v| v.as_str()).unwrap_or("");
    push_agent(name, engine, purpose)
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
        persist();
        let _ = crate::agent_mind::sync_agent_instructions(&crate::agent_mind::agents_root(), agent_id);
        return serde_json::to_value(&cloned).unwrap_or_else(|_| agent_profile_json(agent_id));
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
    let (name, brief) = draft_copy(seed);
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

    let mut drafts = read_json_array(&drafts_path());
    let position = drafts.iter().position(|draft| {
        draft.get("requestId").and_then(|v| v.as_str()) == Some(request_id) && !request_id.is_empty()
    });
    let Some(index) = position else {
        return push_agent(custom_name.unwrap_or("New Agent"), custom_engine.unwrap_or("antigravity"), custom_brief.unwrap_or(""));
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
    let created = push_agent(&name, &engine, &brief);
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
pub fn list_agent_rail_activity(_request: Option<Value>) -> Vec<Value> {
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

fn messaging_store_path() -> PathBuf {
    studio_dir().join("agent-messages.json")
}

#[tauri::command]
pub fn agent_messaging_preference() -> Value {
    let pref_path = messaging_pref_path();
    let val: Value = std::fs::read_to_string(&pref_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null);
    let enabled = val.get("enabled").and_then(Value::as_bool).unwrap_or(true);
    let revision = val
        .get("revision")
        .and_then(Value::as_str)
        .unwrap_or("rev-1")
        .to_string();
    json!({
        "schemaVersion": 1,
        "enabled": enabled,
        "readOnly": false,
        "revision": revision
    })
}

#[tauri::command]
pub fn set_agent_messaging_preference(request: Option<Value>) -> Value {
    let req = request.as_ref().and_then(|r| r.get("request")).or(request.as_ref());
    let enabled = req.and_then(|r| r.get("enabled")).and_then(Value::as_bool).unwrap_or(true);
    let next_rev = format!("rev-{}", now_ms());
    let data = json!({
        "enabled": enabled,
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
        "readOnly": false,
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
        .and_then(|s| s.parse().ok());

    let messages_path = messaging_store_path();
    let all_messages = read_json_array(&messages_path);

    let mut matching: Vec<&Value> = all_messages
        .iter()
        .filter(|m| m.get("profileId").and_then(Value::as_str) == Some(profile_id))
        .filter(|m| {
            if let Some(before) = before_seq {
                let seq = m.get("sequence").and_then(Value::as_u64).unwrap_or(0);
                seq < before
            } else {
                true
            }
        })
        .collect();

    matching.sort_by(|a, b| {
        let seq_a = a.get("sequence").and_then(Value::as_u64).unwrap_or(0);
        let seq_b = b.get("sequence").and_then(Value::as_u64).unwrap_or(0);
        seq_b.cmp(&seq_a)
    });

    let limit = 20;
    let slice = if matching.len() > limit { &matching[..limit] } else { &matching[..] };
    let has_more = matching.len() > limit;
    let next_cursor = if has_more {
        slice.last().and_then(|m| m.get("sequence").and_then(Value::as_u64)).map(|s| s.to_string())
    } else {
        None
    };

    let items: Vec<Value> = slice
        .iter()
        .map(|m| {
            json!({
                "id": m.get("id").and_then(Value::as_str).unwrap_or(""),
                "senderName": m.get("senderName").and_then(Value::as_str).unwrap_or("Teammate"),
                "body": m.get("body").and_then(Value::as_str).unwrap_or(""),
                "delivered": m.get("delivered").and_then(Value::as_bool).unwrap_or(true),
            })
        })
        .collect();

    json!({
        "schemaVersion": 1,
        "profileId": profile_id,
        "messages": items,
        "nextCursor": next_cursor
    })
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

    let messages_path = messaging_store_path();
    let mut all_messages = read_json_array(&messages_path);
    let next_seq = all_messages
        .iter()
        .filter_map(|m| m.get("sequence").and_then(Value::as_u64))
        .max()
        .unwrap_or(0) + 1;

    let msg_id = Uuid::new_v4().to_string();
    let now = now_ms();
    let new_msg = json!({
        "sequence": next_seq,
        "id": msg_id,
        "profileId": recipient_id,
        "senderId": sender_id,
        "senderName": sender_name,
        "body": plain_text(body, 8000),
        "delivered": true,
        "createdAtUnixMs": now,
    });
    all_messages.push(new_msg);
    write_json_array(&messages_path, &all_messages);

    Ok(json!({
        "schemaVersion": 1,
        "delivered": true,
        "messageId": msg_id,
        "sequence": next_seq
    }))
}
