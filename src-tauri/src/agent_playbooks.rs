use crate::persist::{agents, body, state_path};
use kite_ctx::{ContextEngine, ContextScope};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::Emitter;
use uuid::Uuid;

static ACTIVE_PLAYBOOK_AGENTS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn active_agents_lock() -> &'static Mutex<HashSet<String>> {
    ACTIVE_PLAYBOOK_AGENTS.get_or_init(|| Mutex::new(HashSet::new()))
}

pub fn active_playbook_agent_ids() -> HashSet<String> {
    active_agents_lock()
        .lock()
        .map(|s| s.clone())
        .unwrap_or_default()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlaybookStage {
    pub stage_id: String,
    pub title: String,
    pub agent_profile_id: String,
    pub prompt_template: String,
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default = "default_workspace_mode")]
    pub workspace_mode: String,
    #[serde(default)]
    pub handoff_keys: Vec<String>,
}

fn default_workspace_mode() -> String {
    "inherit".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlaybookDefinition {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub stages: Vec<PlaybookStage>,
    pub created_at_unix_ms: i64,
    pub updated_at_unix_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlaybookStageRun {
    pub stage_id: String,
    pub title: String,
    pub agent_profile_id: String,
    pub provider: String,
    pub model: Option<String>,
    pub status: String,
    pub thread_id: Option<String>,
    pub started_at_unix_ms: Option<i64>,
    pub finished_at_unix_ms: Option<i64>,
    #[serde(default)]
    pub handoff_keys: Vec<String>,
    pub summary: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlaybookRunRecord {
    pub run_id: String,
    pub playbook_id: String,
    pub playbook_name: String,
    pub status: String,
    pub started_at_unix_ms: i64,
    pub finished_at_unix_ms: Option<i64>,
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub stages: Vec<PlaybookStageRun>,
}

fn app_dir() -> PathBuf {
    state_path()
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn playbooks_file(dir: &Path) -> PathBuf {
    dir.join("playbooks.json")
}

fn playbook_runs_file(dir: &Path) -> PathBuf {
    dir.join("playbook-runs.json")
}

pub fn load_playbooks_at(dir: &Path) -> Vec<PlaybookDefinition> {
    fs::read_to_string(playbooks_file(dir))
        .ok()
        .and_then(|raw| serde_json::from_str::<Vec<PlaybookDefinition>>(&raw).ok())
        .unwrap_or_default()
}

pub fn save_playbooks_at(dir: &Path, items: &[PlaybookDefinition]) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("Could not create app directory: {e}"))?;
    let body = serde_json::to_string_pretty(items)
        .map_err(|e| format!("Could not serialize playbooks: {e}"))?;
    fs::write(playbooks_file(dir), body)
        .map_err(|e| format!("Could not write playbooks file: {e}"))
}

pub fn load_playbook_runs_at(dir: &Path) -> Vec<PlaybookRunRecord> {
    fs::read_to_string(playbook_runs_file(dir))
        .ok()
        .and_then(|raw| serde_json::from_str::<Vec<PlaybookRunRecord>>(&raw).ok())
        .unwrap_or_default()
}

pub fn save_playbook_runs_at(dir: &Path, runs: &[PlaybookRunRecord]) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("Could not create app directory: {e}"))?;
    let capped: Vec<PlaybookRunRecord> = runs.iter().take(100).cloned().collect();
    let body = serde_json::to_string_pretty(&capped)
        .map_err(|e| format!("Could not serialize playbook runs: {e}"))?;
    fs::write(playbook_runs_file(dir), body)
        .map_err(|e| format!("Could not write playbook runs file: {e}"))
}

/// Validates stage dependencies and returns topologically ordered parallel execution waves.
pub fn resolve_playbook_waves(def: &PlaybookDefinition) -> Result<Vec<Vec<PlaybookStage>>, String> {
    if def.stages.is_empty() {
        return Err("Playbook must contain at least one stage.".to_string());
    }
    let mut by_id: HashMap<String, PlaybookStage> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    for stage in &def.stages {
        let sid = stage.stage_id.trim().to_string();
        if sid.is_empty() {
            return Err("Playbook stage_id cannot be empty.".to_string());
        }
        if !matches!(
            stage.workspace_mode.as_str(),
            "inherit" | "share" | "branch"
        ) {
            return Err(format!(
                "Invalid workspaceMode '{}' on stage '{}'. Expected inherit, share, or branch.",
                stage.workspace_mode, sid
            ));
        }
        if by_id.contains_key(&sid) {
            return Err(format!("Duplicate playbook stage_id '{sid}'."));
        }
        by_id.insert(sid.clone(), stage.clone());
        order.push(sid);
    }

    let mut indegree: HashMap<String, usize> = HashMap::new();
    let mut dependents: HashMap<String, Vec<String>> = HashMap::new();
    for sid in &order {
        let stage = &by_id[sid];
        let mut unique_deps = HashSet::new();
        for dep in &stage.depends_on {
            if dep == sid {
                return Err(format!("Stage '{sid}' cannot depend on itself."));
            }
            if !by_id.contains_key(dep) {
                return Err(format!(
                    "Stage '{sid}' depends on unknown stage '{dep}'."
                ));
            }
            if unique_deps.insert(dep.clone()) {
                dependents.entry(dep.clone()).or_default().push(sid.clone());
            }
        }
        indegree.insert(sid.clone(), unique_deps.len());
    }

    let mut waves = Vec::new();
    let mut assigned = 0usize;
    let mut ready: Vec<String> = order
        .iter()
        .filter(|sid| indegree[*sid] == 0)
        .cloned()
        .collect();

    while !ready.is_empty() {
        let wave_ids = ready;
        ready = Vec::new();
        let mut wave_stages = Vec::with_capacity(wave_ids.len());
        for sid in &wave_ids {
            assigned += 1;
            wave_stages.push(by_id[sid].clone());
            if let Some(children) = dependents.get(sid) {
                for child in children {
                    if let Some(deg) = indegree.get_mut(child) {
                        *deg -= 1;
                        if *deg == 0 {
                            ready.push(child.clone());
                        }
                    }
                }
            }
        }
        ready.sort_by_key(|id| order.iter().position(|o| o == id).unwrap_or(usize::MAX));
        waves.push(wave_stages);
    }

    if assigned != order.len() {
        return Err("Playbook stage graph contains a dependency cycle.".to_string());
    }
    Ok(waves)
}

fn chat_provider_for_engine(engine: &str) -> &'static str {
    match engine.trim().to_ascii_lowercase().as_str() {
        "codex" => "codex",
        "cursor" | "cursor-agent" => "cursor",
        "grok" => "grok",
        "opencode" | "open-code" => "opencode",
        "antigravity" | "agy" => "antigravity",
        "gemini" => "gemini",
        _ => "claude",
    }
}

fn emit_playbook_run(run: &PlaybookRunRecord) {
    if let Some(app) = crate::get_app_handle() {
        let _ = app.emit("kite:playbook-run-updated", json!(run));
    }
}

pub fn default_stage_runner(
    stage: &PlaybookStage,
    run: &PlaybookRunRecord,
    compiled_prompt: &str,
) -> Result<(Option<String>, String), String> {
    let agent = agents()
        .lock()
        .ok()
        .and_then(|items| items.iter().find(|a| a.id == stage.agent_profile_id).cloned());
    let provider = agent
        .as_ref()
        .map(|a| chat_provider_for_engine(&a.engine))
        .unwrap_or("claude");
    if provider == "antigravity" {
        return Ok((
            None,
            format!(
                "Stage '{}' executed against antigravity specialist profile ({} chars prompt).",
                stage.title,
                compiled_prompt.len()
            ),
        ));
    }
    let thread = crate::chat::create_thread(
        Some(&stage.agent_profile_id),
        &format!("Playbook: {} · {}", run.playbook_name, stage.title),
        provider,
        run.workspace_id.as_deref(),
    );
    let thread_id = thread
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string);
    if let Some(tid) = &thread_id {
        let _ = crate::chat::start_turn(
            tid,
            Some(&stage.agent_profile_id),
            compiled_prompt,
            Vec::new(),
            Some(&run.run_id),
        );
    }
    let summary = format!(
        "Stage '{}' dispatched on {} ({})",
        stage.title,
        provider,
        thread_id.as_deref().unwrap_or("local")
    );
    Ok((thread_id, summary))
}

fn write_stage_handoff(
    engine: Option<&ContextEngine>,
    run_id: &str,
    stage: &PlaybookStage,
    summary: &str,
) {
    let Some(ctx) = engine else {
        return;
    };
    let primary_key = format!("playbook:{run_id}:stage:{}", stage.stage_id);
    let _ = ctx.share_put_with_telemetry(
        ContextScope::Session,
        run_id,
        &primary_key,
        summary,
        &stage.agent_profile_id,
        "kite",
        None,
        run_id,
        "playbook-runner",
    );
    for alias in &stage.handoff_keys {
        let clean = alias.trim();
        if !clean.is_empty() && clean != primary_key {
            let _ = ctx.share_put_with_telemetry(
                ContextScope::Session,
                run_id,
                clean,
                summary,
                &stage.agent_profile_id,
                "kite",
                None,
                run_id,
                "playbook-runner",
            );
        }
    }
}

fn build_stage_prompt(
    ctx: Option<&ContextEngine>,
    run_id: &str,
    stage: &PlaybookStage,
    input_prompt: &str,
) -> String {
    let mut parts = vec![stage.prompt_template.trim().to_string()];
    if !input_prompt.trim().is_empty() {
        parts.push(format!("Task context:\n{}", input_prompt.trim()));
    }
    if !stage.depends_on.is_empty() {
        let mut handoffs = Vec::new();
        for dep in &stage.depends_on {
            let key = format!("playbook:{run_id}:stage:{dep}");
            if let Some(engine) = ctx {
                if let Ok(Some(content)) = engine.share_get_with_telemetry(
                    ContextScope::Session,
                    run_id,
                    &key,
                    true,
                    &stage.agent_profile_id,
                    "kite",
                    run_id,
                    "playbook-runner",
                ) {
                    handoffs.push(format!("[From {dep} ({key})]: {content}"));
                }
            }
        }
        if !handoffs.is_empty() {
            parts.push(format!("Upstream SharedContext handoffs:\n{}", handoffs.join("\n")));
        }
    }
    parts.join("\n\n")
}

pub fn run_playbook_at(
    dir: &Path,
    def: &PlaybookDefinition,
    workspace_id: Option<&str>,
    input_prompt: &str,
    ctx_engine: Option<&ContextEngine>,
    runner: &dyn Fn(&PlaybookStage, &PlaybookRunRecord, &str) -> Result<(Option<String>, String), String>,
) -> Result<PlaybookRunRecord, String> {
    let waves = resolve_playbook_waves(def)?;
    let run_id = format!("pbrun-{}", Uuid::new_v4());
    let agent_lookup: HashMap<String, (String, Option<String>)> = agents()
        .lock()
        .ok()
        .map(|items| {
            items
                .iter()
                .map(|a| {
                    (
                        a.id.clone(),
                        (chat_provider_for_engine(&a.engine).to_string(), a.default_model.clone()),
                    )
                })
                .collect()
        })
        .unwrap_or_default();

    let stage_runs: Vec<PlaybookStageRun> = def
        .stages
        .iter()
        .map(|s| {
            let (provider, model) = agent_lookup
                .get(&s.agent_profile_id)
                .cloned()
                .unwrap_or_else(|| ("claude".to_string(), None));
            PlaybookStageRun {
                stage_id: s.stage_id.clone(),
                title: s.title.clone(),
                agent_profile_id: s.agent_profile_id.clone(),
                provider,
                model,
                status: "pending".to_string(),
                thread_id: None,
                started_at_unix_ms: None,
                finished_at_unix_ms: None,
                handoff_keys: {
                    let mut keys = vec![format!("playbook:{run_id}:stage:{}", s.stage_id)];
                    for k in &s.handoff_keys {
                        if !keys.contains(k) {
                            keys.push(k.clone());
                        }
                    }
                    keys
                },
                summary: None,
                error: None,
            }
        })
        .collect();

    let mut run = PlaybookRunRecord {
        run_id: run_id.clone(),
        playbook_id: def.id.clone(),
        playbook_name: def.name.clone(),
        status: "running".to_string(),
        started_at_unix_ms: now_ms(),
        finished_at_unix_ms: None,
        workspace_id: workspace_id.map(ToString::to_string),
        stages: stage_runs,
    };
    emit_playbook_run(&run);

    let default_ctx = if ctx_engine.is_none() {
        ContextEngine::open_default().ok()
    } else {
        None
    };
    let active_ctx = ctx_engine.or(default_ctx.as_ref());

    for wave in waves {
        for stage in wave {
            if let Ok(mut active) = active_agents_lock().lock() {
                active.insert(stage.agent_profile_id.clone());
            }
            if let Some(sr) = run.stages.iter_mut().find(|s| s.stage_id == stage.stage_id) {
                sr.status = "running".to_string();
                sr.started_at_unix_ms = Some(now_ms());
            }
            emit_playbook_run(&run);

            let prompt = build_stage_prompt(active_ctx, &run_id, &stage, input_prompt);
            let outcome = runner(&stage, &run, &prompt);

            if let Ok(mut active) = active_agents_lock().lock() {
                active.remove(&stage.agent_profile_id);
            }

            match outcome {
                Ok((thread_id, summary)) => {
                    write_stage_handoff(active_ctx, &run_id, &stage, &summary);
                    if let Some(sr) = run.stages.iter_mut().find(|s| s.stage_id == stage.stage_id) {
                        sr.status = "succeeded".to_string();
                        sr.thread_id = thread_id;
                        sr.summary = Some(summary);
                        sr.finished_at_unix_ms = Some(now_ms());
                    }
                    emit_playbook_run(&run);
                }
                Err(err) => {
                    if let Some(sr) = run.stages.iter_mut().find(|s| s.stage_id == stage.stage_id) {
                        sr.status = "failed".to_string();
                        sr.error = Some(err);
                        sr.finished_at_unix_ms = Some(now_ms());
                    }
                    run.status = "halted".to_string();
                    run.finished_at_unix_ms = Some(now_ms());
                    emit_playbook_run(&run);

                    let mut all_runs = load_playbook_runs_at(dir);
                    all_runs.insert(0, run.clone());
                    let _ = save_playbook_runs_at(dir, &all_runs);
                    return Ok(run);
                }
            }
        }
    }

    run.status = "succeeded".to_string();
    run.finished_at_unix_ms = Some(now_ms());
    emit_playbook_run(&run);

    let mut all_runs = load_playbook_runs_at(dir);
    all_runs.insert(0, run.clone());
    let _ = save_playbook_runs_at(dir, &all_runs);
    Ok(run)
}

pub fn retry_playbook_stage_at(
    dir: &Path,
    run_id: &str,
    stage_id: &str,
    input_prompt: &str,
    ctx_engine: Option<&ContextEngine>,
    runner: &dyn Fn(&PlaybookStage, &PlaybookRunRecord, &str) -> Result<(Option<String>, String), String>,
) -> Result<PlaybookRunRecord, String> {
    let mut runs = load_playbook_runs_at(dir);
    let idx = runs
        .iter()
        .position(|r| r.run_id == run_id)
        .ok_or_else(|| format!("Playbook run '{run_id}' not found."))?;
    let playbook = load_playbooks_at(dir)
        .into_iter()
        .find(|p| p.id == runs[idx].playbook_id)
        .ok_or_else(|| "Playbook definition no longer exists.".to_string())?;
    let waves = resolve_playbook_waves(&playbook)?;
    let default_ctx = if ctx_engine.is_none() {
        ContextEngine::open_default().ok()
    } else {
        None
    };
    let active_ctx = ctx_engine.or(default_ctx.as_ref());

    let mut run = runs[idx].clone();
    run.status = "running".to_string();
    run.finished_at_unix_ms = None;

    let mut resuming = false;
    for wave in waves {
        for stage in wave {
            let current_status = run
                .stages
                .iter()
                .find(|s| s.stage_id == stage.stage_id)
                .map(|s| s.status.as_str())
                .unwrap_or("pending");
            if stage.stage_id == stage_id {
                resuming = true;
            }
            if !resuming && current_status == "succeeded" {
                continue;
            }
            if current_status == "succeeded" {
                continue;
            }
            if let Some(sr) = run.stages.iter_mut().find(|s| s.stage_id == stage.stage_id) {
                sr.status = "running".to_string();
                sr.error = None;
                sr.started_at_unix_ms = Some(now_ms());
            }
            let prompt = build_stage_prompt(active_ctx, run_id, &stage, input_prompt);
            match runner(&stage, &run, &prompt) {
                Ok((thread_id, summary)) => {
                    write_stage_handoff(active_ctx, run_id, &stage, &summary);
                    if let Some(sr) = run.stages.iter_mut().find(|s| s.stage_id == stage.stage_id) {
                        sr.status = "succeeded".to_string();
                        sr.thread_id = thread_id;
                        sr.summary = Some(summary);
                        sr.finished_at_unix_ms = Some(now_ms());
                    }
                }
                Err(err) => {
                    if let Some(sr) = run.stages.iter_mut().find(|s| s.stage_id == stage.stage_id) {
                        sr.status = "failed".to_string();
                        sr.error = Some(err);
                        sr.finished_at_unix_ms = Some(now_ms());
                    }
                    run.status = "halted".to_string();
                    run.finished_at_unix_ms = Some(now_ms());
                    runs[idx] = run.clone();
                    let _ = save_playbook_runs_at(dir, &runs);
                    emit_playbook_run(&run);
                    return Ok(run);
                }
            }
        }
    }

    run.status = "succeeded".to_string();
    run.finished_at_unix_ms = Some(now_ms());
    runs[idx] = run.clone();
    let _ = save_playbook_runs_at(dir, &runs);
    emit_playbook_run(&run);
    Ok(run)
}

#[tauri::command]
pub fn list_agent_playbooks() -> Value {
    let dir = app_dir();
    json!({ "playbooks": load_playbooks_at(&dir) })
}

#[tauri::command]
pub fn save_agent_playbook(request: Option<Value>) -> Result<Value, String> {
    let req = body(&request).ok_or_else(|| "Playbook request body is required.".to_string())?;
    let payload = req.get("playbook").unwrap_or(req);
    let mut def: PlaybookDefinition = serde_json::from_value(payload.clone())
        .map_err(|e| format!("Invalid playbook payload: {e}"))?;
    if def.name.trim().is_empty() {
        return Err("Playbook name cannot be empty.".to_string());
    }
    let now = now_ms();
    if def.id.trim().is_empty() {
        def.id = format!("pb-{}", Uuid::new_v4());
        def.created_at_unix_ms = now;
    }
    def.updated_at_unix_ms = now;
    resolve_playbook_waves(&def)?;

    let dir = app_dir();
    let mut items = load_playbooks_at(&dir);
    if let Some(existing) = items.iter_mut().find(|p| p.id == def.id) {
        *existing = def.clone();
    } else {
        items.push(def.clone());
    }
    save_playbooks_at(&dir, &items)?;
    Ok(json!({ "playbook": def, "playbooks": items }))
}

#[tauri::command]
pub fn delete_agent_playbook(request: Option<Value>) -> Result<Value, String> {
    let req = body(&request).ok_or_else(|| "Playbook request body is required.".to_string())?;
    let playbook_id = req
        .get("playbookId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "playbookId is required.".to_string())?;
    let dir = app_dir();
    let mut items = load_playbooks_at(&dir);
    items.retain(|p| p.id != playbook_id);
    save_playbooks_at(&dir, &items)?;
    Ok(json!({ "deleted": true, "playbooks": items }))
}

#[tauri::command]
pub fn run_agent_playbook(request: Option<Value>) -> Result<Value, String> {
    let req = body(&request).ok_or_else(|| "Playbook run request is required.".to_string())?;
    let playbook_id = req
        .get("playbookId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "playbookId is required.".to_string())?;
    let input_prompt = req.get("prompt").and_then(Value::as_str).unwrap_or("");
    let workspace_id = req.get("workspaceId").and_then(Value::as_str);
    let dir = app_dir();
    let def = load_playbooks_at(&dir)
        .into_iter()
        .find(|p| p.id == playbook_id)
        .ok_or_else(|| format!("Playbook '{playbook_id}' not found."))?;
    let run = run_playbook_at(&dir, &def, workspace_id, input_prompt, None, &default_stage_runner)?;
    Ok(json!({ "run": run }))
}

#[tauri::command]
pub fn list_playbook_runs(request: Option<Value>) -> Value {
    let req = body(&request);
    let playbook_id = req.and_then(|r| r.get("playbookId")).and_then(Value::as_str);
    let dir = app_dir();
    let runs: Vec<PlaybookRunRecord> = load_playbook_runs_at(&dir)
        .into_iter()
        .filter(|r| playbook_id.is_none_or(|id| r.playbook_id == id))
        .collect();
    json!({ "runs": runs })
}

#[tauri::command]
pub fn retry_playbook_stage(request: Option<Value>) -> Result<Value, String> {
    let req = body(&request).ok_or_else(|| "Retry request is required.".to_string())?;
    let run_id = req
        .get("runId")
        .and_then(Value::as_str)
        .ok_or_else(|| "runId is required.".to_string())?;
    let stage_id = req
        .get("stageId")
        .and_then(Value::as_str)
        .ok_or_else(|| "stageId is required.".to_string())?;
    let input_prompt = req.get("prompt").and_then(Value::as_str).unwrap_or("");
    let dir = app_dir();
    let run = retry_playbook_stage_at(&dir, run_id, stage_id, input_prompt, None, &default_stage_runner)?;
    Ok(json!({ "run": run }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn resolve_playbook_waves_orders_parallel_and_serial_stages_and_rejects_cycles() {
        let valid = PlaybookDefinition {
            id: "pb-1".into(),
            name: "Feature Pipeline".into(),
            description: "Explore -> Implement -> Review".into(),
            stages: vec![
                PlaybookStage {
                    stage_id: "explore-code".into(),
                    title: "Explore Code".into(),
                    agent_profile_id: "a1".into(),
                    prompt_template: "Map files".into(),
                    depends_on: vec![],
                    workspace_mode: "inherit".into(),
                    handoff_keys: vec![],
                },
                PlaybookStage {
                    stage_id: "explore-docs".into(),
                    title: "Explore Docs".into(),
                    agent_profile_id: "a2".into(),
                    prompt_template: "Check ODDs".into(),
                    depends_on: vec![],
                    workspace_mode: "inherit".into(),
                    handoff_keys: vec![],
                },
                PlaybookStage {
                    stage_id: "implement".into(),
                    title: "Implement".into(),
                    agent_profile_id: "a3".into(),
                    prompt_template: "Write patch".into(),
                    depends_on: vec!["explore-code".into(), "explore-docs".into()],
                    workspace_mode: "share".into(),
                    handoff_keys: vec!["patch-notes".into()],
                },
            ],
            created_at_unix_ms: 1,
            updated_at_unix_ms: 1,
        };
        let waves = resolve_playbook_waves(&valid).unwrap();
        assert_eq!(waves.len(), 2);
        assert_eq!(waves[0].len(), 2);
        assert_eq!(waves[1][0].stage_id, "implement");

        let cycle = PlaybookDefinition {
            stages: vec![
                PlaybookStage {
                    stage_id: "a".into(),
                    title: "A".into(),
                    agent_profile_id: "a1".into(),
                    prompt_template: "A".into(),
                    depends_on: vec!["b".into()],
                    workspace_mode: "inherit".into(),
                    handoff_keys: vec![],
                },
                PlaybookStage {
                    stage_id: "b".into(),
                    title: "B".into(),
                    agent_profile_id: "a2".into(),
                    prompt_template: "B".into(),
                    depends_on: vec!["a".into()],
                    workspace_mode: "inherit".into(),
                    handoff_keys: vec![],
                },
            ],
            ..valid
        };
        assert!(resolve_playbook_waves(&cycle).unwrap_err().contains("cycle"));
    }

    #[test]
    fn playbook_runner_writes_shared_context_handoffs_and_halts_on_failure_with_retry() {
        let dir = std::env::temp_dir().join(format!("kite-pb-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let ctx = ContextEngine::open_in_memory().unwrap();

        let pb = PlaybookDefinition {
            id: "pb-2".into(),
            name: "Audit & Fix".into(),
            description: "Two-stage test".into(),
            stages: vec![
                PlaybookStage {
                    stage_id: "scan".into(),
                    title: "Scan".into(),
                    agent_profile_id: "ag-1".into(),
                    prompt_template: "Scan repo".into(),
                    depends_on: vec![],
                    workspace_mode: "inherit".into(),
                    handoff_keys: vec!["scan-findings".into()],
                },
                PlaybookStage {
                    stage_id: "fix".into(),
                    title: "Fix".into(),
                    agent_profile_id: "ag-2".into(),
                    prompt_template: "Fix findings".into(),
                    depends_on: vec!["scan".into()],
                    workspace_mode: "share".into(),
                    handoff_keys: vec![],
                },
            ],
            created_at_unix_ms: 1,
            updated_at_unix_ms: 1,
        };
        save_playbooks_at(&dir, &[pb.clone()]).unwrap();

        let fail_second = RefCell::new(true);
        let seen_prompts: RefCell<Vec<String>> = RefCell::new(Vec::new());
        let runner = |stage: &PlaybookStage, _run: &PlaybookRunRecord, prompt: &str| {
            seen_prompts.borrow_mut().push(prompt.to_string());
            if stage.stage_id == "fix" && *fail_second.borrow() {
                return Err("Transient compile failure".to_string());
            }
            Ok((
                Some(format!("thread-{}", stage.stage_id)),
                format!("Output from {}", stage.stage_id),
            ))
        };

        let halted = run_playbook_at(&dir, &pb, None, "Check crate", Some(&ctx), &runner).unwrap();
        assert_eq!(halted.status, "halted");
        assert_eq!(halted.stages[0].status, "succeeded");
        assert_eq!(halted.stages[1].status, "failed");
        // Stage 2 received SharedContext handoff from Stage 1
        assert!(seen_prompts.borrow()[1].contains("Output from scan"));

        // Retry Stage 2 now succeeding
        *fail_second.borrow_mut() = false;
        let resumed = retry_playbook_stage_at(
            &dir,
            &halted.run_id,
            "fix",
            "Check crate",
            Some(&ctx),
            &runner,
        )
        .unwrap();
        assert_eq!(resumed.status, "succeeded");
        assert_eq!(resumed.stages[1].status, "succeeded");

        let _ = fs::remove_dir_all(&dir);
    }
}
