use crate::persist::{agents, body, state_path};
use kite_ctx::{ContextEngine, ContextScope};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::Emitter;
use uuid::Uuid;

static ACTIVE_PLAYBOOK_AGENTS: OnceLock<Mutex<HashMap<String, usize>>> = OnceLock::new();
static PLAYBOOK_RUNS_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn active_agents_lock() -> &'static Mutex<HashMap<String, usize>> {
    ACTIVE_PLAYBOOK_AGENTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn playbook_runs_lock() -> &'static Mutex<()> {
    PLAYBOOK_RUNS_LOCK.get_or_init(|| Mutex::new(()))
}

fn mark_stage_agent_active(agent_id: &str, active: bool) {
    if agent_id.trim().is_empty() {
        return;
    }
    if let Ok(mut map) = active_agents_lock().lock() {
        if active {
            *map.entry(agent_id.to_string()).or_insert(0) += 1;
        } else if let Some(count) = map.get_mut(agent_id) {
            if *count <= 1 {
                map.remove(agent_id);
            } else {
                *count -= 1;
            }
        }
    }
}

pub fn active_playbook_agent_ids() -> HashSet<String> {
    active_agents_lock()
        .lock()
        .map(|m| m.keys().cloned().collect())
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

fn upsert_playbook_run_at(dir: &Path, run: &PlaybookRunRecord) -> Result<(), String> {
    let _guard = playbook_runs_lock()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let mut all_runs = load_playbook_runs_at(dir);
    if let Some(existing) = all_runs.iter_mut().find(|r| r.run_id == run.run_id) {
        *existing = run.clone();
    } else {
        all_runs.insert(0, run.clone());
    }
    save_playbook_runs_at(dir, &all_runs)
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

fn resolve_workspace_dir(workspace_id: Option<&str>) -> Option<PathBuf> {
    let ws = workspace_id.map(str::trim).filter(|s| !s.is_empty())?;
    if let Some(p) = crate::persist::workspace_path(ws) {
        let pb = PathBuf::from(p);
        if pb.is_dir() {
            return Some(pb);
        }
    }
    let direct = PathBuf::from(ws);
    direct.is_dir().then_some(direct)
}

pub fn await_turn_settlement(
    thread_id: &str,
    run_id: &str,
    timeout: Duration,
) -> Result<String, String> {
    let deadline = Instant::now() + timeout;
    let mut timed_out = false;
    {
        let mut live = crate::chat::runtime::live_turns()
            .lock()
            .map_err(|_| "live_turns lock poisoned".to_string())?;
        loop {
            let finished = match live.runs.get(run_id) {
                Some(run) => run.finished,
                None => true,
            };
            if finished {
                break;
            }
            let now = Instant::now();
            if now >= deadline {
                timed_out = true;
                break;
            }
            let remaining = deadline.saturating_duration_since(now);
            let (guard, wait_res) = crate::chat::runtime::live_cv()
                .wait_timeout(live, remaining)
                .map_err(|_| "live_cv wait failed".to_string())?;
            live = guard;
            if wait_res.timed_out()
                && Instant::now() >= deadline
                && live.runs.get(run_id).is_some_and(|r| !r.finished)
            {
                timed_out = true;
                break;
            }
        }
    }

    if timed_out {
        crate::chat::cancel_turn(thread_id);
        return Err(format!(
            "Stage turn '{run_id}' on thread '{thread_id}' timed out after {}s.",
            timeout.as_secs()
        ));
    }

    let (status, failure_msg) = {
        let all = crate::persist::threads()
            .lock()
            .map_err(|_| "threads lock poisoned".to_string())?;
        let thread = all
            .iter()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(thread_id));
        let status = thread
            .and_then(|t| t.get("status").and_then(Value::as_str))
            .unwrap_or("idle")
            .to_string();
        let failure_msg = thread
            .and_then(|t| t.pointer("/turnFailure/message").and_then(Value::as_str))
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        (status, failure_msg)
    };

    if status == "waiting" {
        return Err(format!(
            "Stage turn on thread '{thread_id}' is waiting for interactive approval or input."
        ));
    }

    let mut output = crate::chat::subagents::extract_final_assistant_text(thread_id);
    if output.trim().is_empty() {
        output = crate::dispatch_wire::protocol::thread_tail(thread_id);
    }

    if status == "error" {
        let detail = failure_msg.unwrap_or_else(|| {
            if !output.trim().is_empty() {
                output.clone()
            } else {
                format!("Stage turn '{run_id}' failed on thread '{thread_id}'.")
            }
        });
        return Err(detail);
    }

    Ok(output)
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
        .map(ToString::to_string)
        .ok_or_else(|| format!("Failed to create thread for stage '{}'.", stage.title))?;

    let mut patch = json!({ "provider": provider });
    if let Some(ref ag) = agent {
        if let Some(mode) = ag.default_mode.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            patch["mode"] = json!(mode);
        }
        if let Some(plan) = ag.default_plan {
            patch["plan"] = json!(plan);
        }
        if let Some(model) = ag.default_model.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            patch["model"] = json!(model);
        }
        if !ag.default_provider_options.is_empty() {
            patch["providerOptions"] = json!(ag.default_provider_options);
            if let Some(effort) = ag
                .default_provider_options
                .iter()
                .find(|o| o.get("id").and_then(Value::as_str) == Some("effort"))
                .and_then(|o| o.get("value").and_then(Value::as_str))
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                patch["effort"] = json!(effort);
            }
        }
    }
    let _ = crate::chat::configure_thread(&thread_id, &patch);

    let mut provisioned_worktree = false;
    if matches!(stage.workspace_mode.as_str(), "share" | "branch") {
        if let Some(base_dir) = resolve_workspace_dir(run.workspace_id.as_deref()) {
            if let Some(repo_root) = crate::chat::subagents::resolve_git_repo_root(&base_dir) {
                let short_id = format!("pb-{}", &Uuid::new_v4().simple().to_string()[..8]);
                let wt_path = crate::chat::subagents::provision_subagent_worktree(
                    &repo_root,
                    &stage.workspace_mode,
                    &short_id,
                )?;
                let wt_str = wt_path.to_string_lossy().to_string();
                {
                    let mut all = crate::persist::threads()
                        .lock()
                        .map_err(|_| "threads lock poisoned".to_string())?;
                    if let Some(t) = all
                        .iter_mut()
                        .find(|t| t.get("id").and_then(Value::as_str) == Some(thread_id.as_str()))
                    {
                        t["workspaceMode"] = json!(stage.workspace_mode);
                        t["worktreePath"] = json!(wt_str);
                        t["workingDirectory"] = json!(wt_str);
                        crate::chat::threads::touch(t);
                    }
                }
                crate::persist::persist();
                provisioned_worktree = true;
            }
        }
    }

    let started = crate::chat::start_turn(
        &thread_id,
        Some(&stage.agent_profile_id),
        compiled_prompt,
        Vec::new(),
        Some(&run.run_id),
    );
    let chat_run_id = started
        .get("runId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("Stage '{}' failed to start chat turn.", stage.title))?
        .to_string();

    let timeout_secs = crate::agents::load_agent_autonomy_config(&stage.agent_profile_id)
        .max_duration_secs
        .unwrap_or(900)
        .clamp(30, 7200);
    let settled = await_turn_settlement(&thread_id, &chat_run_id, Duration::from_secs(timeout_secs));
    if provisioned_worktree {
        crate::chat::subagents::try_remove_clean_worktree(&thread_id);
    }
    settled.map(|output| (Some(thread_id), output))
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

fn read_upstream_handoffs(
    ctx: Option<&ContextEngine>,
    run_id: &str,
    stage: &PlaybookStage,
) -> Vec<String> {
    let mut handoffs = Vec::new();
    let Some(engine) = ctx else {
        return handoffs;
    };
    for dep in &stage.depends_on {
        let key = format!("playbook:{run_id}:stage:{dep}");
        if let Ok(Some(content)) = engine.share_get_with_telemetry(
            ContextScope::Session,
            run_id,
            &key,
            true,
            run_id,
            &stage.agent_profile_id,
            "kite",
            "playbook-runner",
        ) {
            handoffs.push(format!("[From {dep} ({key})]: {content}"));
        }
    }
    handoffs
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
        let handoffs = read_upstream_handoffs(ctx, run_id, stage);
        if !handoffs.is_empty() {
            parts.push(format!("Upstream SharedContext handoffs:\n{}", handoffs.join("\n")));
        }
    }
    parts.join("\n\n")
}

fn build_initial_playbook_run(
    def: &PlaybookDefinition,
    workspace_id: Option<&str>,
) -> PlaybookRunRecord {
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

    PlaybookRunRecord {
        run_id,
        playbook_id: def.id.clone(),
        playbook_name: def.name.clone(),
        status: "running".to_string(),
        started_at_unix_ms: now_ms(),
        finished_at_unix_ms: None,
        workspace_id: workspace_id.map(ToString::to_string),
        stages: stage_runs,
    }
}

fn execute_playbook_waves_at(
    dir: &Path,
    waves: Vec<Vec<PlaybookStage>>,
    run: &mut PlaybookRunRecord,
    input_prompt: &str,
    ctx_engine: Option<&ContextEngine>,
    skip_succeeded: bool,
    runner: &(dyn Fn(&PlaybookStage, &PlaybookRunRecord, &str) -> Result<(Option<String>, String), String> + Sync),
) {
    let default_ctx = if ctx_engine.is_none() {
        ContextEngine::open_default().ok()
    } else {
        None
    };
    let active_ctx = ctx_engine.or(default_ctx.as_ref());
    let run_id = run.run_id.clone();

    for wave in waves {
        let mut wave_jobs: Vec<(PlaybookStage, String)> = Vec::new();
        for stage in wave {
            if skip_succeeded {
                let is_done = run
                    .stages
                    .iter()
                    .find(|s| s.stage_id == stage.stage_id)
                    .is_some_and(|s| s.status == "succeeded");
                if is_done {
                    continue;
                }
            }
            mark_stage_agent_active(&stage.agent_profile_id, true);
            if let Some(sr) = run.stages.iter_mut().find(|s| s.stage_id == stage.stage_id) {
                sr.status = "running".to_string();
                sr.error = None;
                sr.started_at_unix_ms = Some(now_ms());
                sr.finished_at_unix_ms = None;
            }
            let prompt = build_stage_prompt(active_ctx, &run_id, &stage, input_prompt);
            wave_jobs.push((stage, prompt));
        }

        if wave_jobs.is_empty() {
            continue;
        }

        let _ = upsert_playbook_run_at(dir, run);
        emit_playbook_run(run);

        let run_snapshot = run.clone();
        let stage_by_id: HashMap<String, PlaybookStage> = wave_jobs
            .iter()
            .map(|(st, _)| (st.stage_id.clone(), st.clone()))
            .collect();

        let mut wave_failed = false;
        std::thread::scope(|scope| {
            let (tx, rx) = mpsc::channel::<(String, String, Result<(Option<String>, String), String>)>();
            let total = wave_jobs.len();
            for (stage, prompt) in &wave_jobs {
                let tx_clone = tx.clone();
                let run_ref = &run_snapshot;
                scope.spawn(move || {
                    let outcome = runner(stage, run_ref, prompt);
                    let _ = tx_clone.send((
                        stage.stage_id.clone(),
                        stage.agent_profile_id.clone(),
                        outcome,
                    ));
                });
            }
            drop(tx);

            for _ in 0..total {
                let Ok((stage_id, agent_id, outcome)) = rx.recv() else {
                    break;
                };
                mark_stage_agent_active(&agent_id, false);
                match outcome {
                    Ok((thread_id, summary)) => {
                        if let Some(stage_def) = stage_by_id.get(&stage_id) {
                            write_stage_handoff(active_ctx, &run_id, stage_def, &summary);
                        }
                        if let Some(sr) = run.stages.iter_mut().find(|s| s.stage_id == stage_id) {
                            sr.status = "succeeded".to_string();
                            sr.thread_id = thread_id;
                            sr.summary = Some(summary);
                            sr.finished_at_unix_ms = Some(now_ms());
                        }
                    }
                    Err(err) => {
                        wave_failed = true;
                        if let Some(sr) = run.stages.iter_mut().find(|s| s.stage_id == stage_id) {
                            sr.status = "failed".to_string();
                            sr.error = Some(err);
                            sr.finished_at_unix_ms = Some(now_ms());
                        }
                    }
                }
                let _ = upsert_playbook_run_at(dir, run);
                emit_playbook_run(run);
            }
        });

        if wave_failed {
            run.status = "halted".to_string();
            run.finished_at_unix_ms = Some(now_ms());
            let _ = upsert_playbook_run_at(dir, run);
            emit_playbook_run(run);
            return;
        }
    }

    run.status = "succeeded".to_string();
    run.finished_at_unix_ms = Some(now_ms());
    let _ = upsert_playbook_run_at(dir, run);
    emit_playbook_run(run);
}

pub fn run_playbook_at(
    dir: &Path,
    def: &PlaybookDefinition,
    workspace_id: Option<&str>,
    input_prompt: &str,
    ctx_engine: Option<&ContextEngine>,
    runner: &(dyn Fn(&PlaybookStage, &PlaybookRunRecord, &str) -> Result<(Option<String>, String), String> + Sync),
) -> Result<PlaybookRunRecord, String> {
    let waves = resolve_playbook_waves(def)?;
    let mut run = build_initial_playbook_run(def, workspace_id);
    let _ = upsert_playbook_run_at(dir, &run);
    emit_playbook_run(&run);
    execute_playbook_waves_at(dir, waves, &mut run, input_prompt, ctx_engine, false, runner);
    Ok(run)
}

pub fn retry_playbook_stage_at(
    dir: &Path,
    run_id: &str,
    stage_id: &str,
    input_prompt: &str,
    ctx_engine: Option<&ContextEngine>,
    runner: &(dyn Fn(&PlaybookStage, &PlaybookRunRecord, &str) -> Result<(Option<String>, String), String> + Sync),
) -> Result<PlaybookRunRecord, String> {
    let runs = load_playbook_runs_at(dir);
    let mut run = runs
        .into_iter()
        .find(|r| r.run_id == run_id)
        .ok_or_else(|| format!("Playbook run '{run_id}' not found."))?;
    let playbook = load_playbooks_at(dir)
        .into_iter()
        .find(|p| p.id == run.playbook_id)
        .ok_or_else(|| "Playbook definition no longer exists.".to_string())?;
    let waves = resolve_playbook_waves(&playbook)?;
    let target_wave_idx = waves
        .iter()
        .position(|w| w.iter().any(|s| s.stage_id == stage_id))
        .ok_or_else(|| format!("Stage '{stage_id}' no longer exists in playbook."))?;

    run.status = "running".to_string();
    run.finished_at_unix_ms = None;
    if let Some(sr) = run.stages.iter_mut().find(|s| s.stage_id == stage_id) {
        sr.status = "pending".to_string();
        sr.error = None;
        sr.finished_at_unix_ms = None;
    }
    let _ = upsert_playbook_run_at(dir, &run);
    emit_playbook_run(&run);

    let remaining_waves = waves.into_iter().skip(target_wave_idx).collect();
    execute_playbook_waves_at(
        dir,
        remaining_waves,
        &mut run,
        input_prompt,
        ctx_engine,
        true,
        runner,
    );
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
    let input_prompt = req
        .get("prompt")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let workspace_id = req
        .get("workspaceId")
        .and_then(Value::as_str)
        .map(str::to_string);
    let dir = app_dir();
    let def = load_playbooks_at(&dir)
        .into_iter()
        .find(|p| p.id == playbook_id)
        .ok_or_else(|| format!("Playbook '{playbook_id}' not found."))?;
    let waves = resolve_playbook_waves(&def)?;
    let run = build_initial_playbook_run(&def, workspace_id.as_deref());
    upsert_playbook_run_at(&dir, &run)?;
    emit_playbook_run(&run);

    let mut bg_run = run.clone();
    let bg_dir = dir.clone();
    std::thread::spawn(move || {
        execute_playbook_waves_at(
            &bg_dir,
            waves,
            &mut bg_run,
            &input_prompt,
            None,
            false,
            &default_stage_runner,
        );
    });

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
        .ok_or_else(|| "runId is required.".to_string())?
        .to_string();
    let stage_id = req
        .get("stageId")
        .and_then(Value::as_str)
        .ok_or_else(|| "stageId is required.".to_string())?
        .to_string();
    let input_prompt = req
        .get("prompt")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let dir = app_dir();
    let runs = load_playbook_runs_at(&dir);
    let mut run = runs
        .into_iter()
        .find(|r| r.run_id == run_id)
        .ok_or_else(|| format!("Playbook run '{run_id}' not found."))?;
    let playbook = load_playbooks_at(&dir)
        .into_iter()
        .find(|p| p.id == run.playbook_id)
        .ok_or_else(|| "Playbook definition no longer exists.".to_string())?;
    let waves = resolve_playbook_waves(&playbook)?;
    let target_wave_idx = waves
        .iter()
        .position(|w| w.iter().any(|s| s.stage_id == stage_id))
        .ok_or_else(|| format!("Stage '{stage_id}' no longer exists in playbook."))?;

    run.status = "running".to_string();
    run.finished_at_unix_ms = None;
    if let Some(sr) = run.stages.iter_mut().find(|s| s.stage_id == stage_id) {
        sr.status = "pending".to_string();
        sr.error = None;
        sr.finished_at_unix_ms = None;
    }
    upsert_playbook_run_at(&dir, &run)?;
    emit_playbook_run(&run);

    let remaining_waves: Vec<Vec<PlaybookStage>> = waves.into_iter().skip(target_wave_idx).collect();
    let mut bg_run = run.clone();
    let bg_dir = dir.clone();
    std::thread::spawn(move || {
        execute_playbook_waves_at(
            &bg_dir,
            remaining_waves,
            &mut bg_run,
            &input_prompt,
            None,
            true,
            &default_stage_runner,
        );
    });

    Ok(json!({ "run": run }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

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

        let fail_second = AtomicBool::new(true);
        let seen_prompts: Mutex<Vec<String>> = Mutex::new(Vec::new());
        let runner = |stage: &PlaybookStage, _run: &PlaybookRunRecord, prompt: &str| {
            seen_prompts.lock().unwrap().push(prompt.to_string());
            if stage.stage_id == "fix" && fail_second.load(Ordering::SeqCst) {
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
        assert!(seen_prompts.lock().unwrap()[1].contains("Output from scan"));

        // Retry Stage 2 now succeeding
        fail_second.store(false, Ordering::SeqCst);
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

    #[test]
    fn parallel_wave_execution_runs_independent_stages_concurrently_and_propagates_real_output() {
        let dir = std::env::temp_dir().join(format!("kite-pb-par-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let ctx = ContextEngine::open_in_memory().unwrap();

        let pb = PlaybookDefinition {
            id: "pb-par".into(),
            name: "Parallel Wave".into(),
            description: "Two wave-0 stages in parallel then wave-1".into(),
            stages: vec![
                PlaybookStage {
                    stage_id: "s1".into(),
                    title: "Stage One".into(),
                    agent_profile_id: "ag-a".into(),
                    prompt_template: "Part A".into(),
                    depends_on: vec![],
                    workspace_mode: "inherit".into(),
                    handoff_keys: vec!["a-key".into()],
                },
                PlaybookStage {
                    stage_id: "s2".into(),
                    title: "Stage Two".into(),
                    agent_profile_id: "ag-b".into(),
                    prompt_template: "Part B".into(),
                    depends_on: vec![],
                    workspace_mode: "inherit".into(),
                    handoff_keys: vec![],
                },
                PlaybookStage {
                    stage_id: "s3".into(),
                    title: "Combine".into(),
                    agent_profile_id: "ag-c".into(),
                    prompt_template: "Synthesize".into(),
                    depends_on: vec!["s1".into(), "s2".into()],
                    workspace_mode: "inherit".into(),
                    handoff_keys: vec![],
                },
            ],
            created_at_unix_ms: 1,
            updated_at_unix_ms: 1,
        };
        save_playbooks_at(&dir, &[pb.clone()]).unwrap();

        let in_wave_zero = AtomicUsize::new(0);
        let max_concurrent = AtomicUsize::new(0);
        let wave_one_prompt = Mutex::new(String::new());

        let runner = |stage: &PlaybookStage, _run: &PlaybookRunRecord, prompt: &str| {
            if stage.stage_id == "s1" || stage.stage_id == "s2" {
                let cur = in_wave_zero.fetch_add(1, Ordering::SeqCst) + 1;
                max_concurrent.fetch_max(cur, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(80));
                in_wave_zero.fetch_sub(1, Ordering::SeqCst);
                return Ok((Some(format!("th-{}", stage.stage_id)), format!("Real output {}", stage.stage_id)));
            }
            *wave_one_prompt.lock().unwrap() = prompt.to_string();
            Ok((Some("th-s3".into()), "Combined synthesis".into()))
        };

        let run = run_playbook_at(&dir, &pb, None, "Ship", Some(&ctx), &runner).unwrap();
        assert_eq!(run.status, "succeeded");
        assert_eq!(max_concurrent.load(Ordering::SeqCst), 2, "wave 0 stages must execute concurrently");

        let combined_prompt = wave_one_prompt.lock().unwrap().clone();
        assert!(combined_prompt.contains("Real output s1"));
        assert!(combined_prompt.contains("Real output s2"));

        // Verify SharedContextStore telemetry retrieval uses canonical (run_id, agent_id, "kite", "playbook-runner") order
        let fetched = read_upstream_handoffs(Some(&ctx), &run.run_id, &pb.stages[2]);
        assert_eq!(fetched.len(), 2);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn antigravity_stage_runner_executes_real_thread_and_propagates_errors() {
        let ag_id = format!("ag-agy-{}", Uuid::new_v4().simple());
        struct CleanupGuard {
            agent_id: String,
            prefix: String,
        }
        impl Drop for CleanupGuard {
            fn drop(&mut self) {
                if let Ok(mut list) = agents().lock() {
                    list.retain(|a| a.id != self.agent_id);
                }
                if let Ok(mut list) = crate::persist::threads().lock() {
                    list.retain(|t| {
                        !t.get("title")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .starts_with(&self.prefix)
                    });
                }
            }
        }
        let prefix = format!("Playbook: AgyReal-{}", Uuid::new_v4().simple());
        let _guard = CleanupGuard {
            agent_id: ag_id.clone(),
            prefix: prefix.clone(),
        };

        {
            let mut list = agents().lock().unwrap();
            list.push(crate::persist::AgentProfile {
                id: ag_id.clone(),
                name: "Ship Guard".into(),
                engine: "antigravity".into(),
                purpose: "Verify".into(),
                brief: "Verify".into(),
                avatar: None,
                created_at_unix_ms: 1,
                pinned: false,
                order: 99,
                memory_budget: None,
                reflection_mode: None,
                allow_agent_scheduling: Some(true),
                allow_agent_messaging: Some(true),
                default_mode: Some("acceptEdits".into()),
                default_plan: Some(false),
                default_model: Some("claude-sonnet-4-6".into()),
                default_provider_options: vec![json!({ "id": "effort", "value": "high" })],
                place_display_names: Vec::new(),
                disabled_plugin_ids: Vec::new(),
            });
        }

        let stage = PlaybookStage {
            stage_id: "agy-stage".into(),
            title: "Agy Stage".into(),
            agent_profile_id: ag_id.clone(),
            prompt_template: "Inspect".into(),
            depends_on: vec![],
            workspace_mode: "inherit".into(),
            handoff_keys: vec![],
        };
        let run = PlaybookRunRecord {
            run_id: format!("pbrun-{}", Uuid::new_v4()),
            playbook_id: "pb-agy".into(),
            playbook_name: prefix.clone(),
            status: "running".into(),
            started_at_unix_ms: 1,
            finished_at_unix_ms: None,
            workspace_id: None,
            stages: vec![],
        };

        // Background settler watches for the newly created Antigravity thread's live turn and settles it with real output
        let expected_title = format!("Playbook: {prefix} · Agy Stage");
        let settler = std::thread::spawn(move || {
            for _ in 0..100 {
                let found = {
                    let all = crate::persist::threads().lock().unwrap();
                    all.iter()
                        .find(|t| t.get("title").and_then(Value::as_str) == Some(expected_title.as_str()))
                        .and_then(|t| t.get("id").and_then(Value::as_str).map(str::to_string))
                };
                if let Some(tid) = found {
                    let run_id_opt = {
                        let live = crate::chat::runtime::live_turns().lock().unwrap();
                        live.by_thread.get(&tid).cloned()
                    };
                    if let Some(rid) = run_id_opt {
                        {
                            let mut live = crate::chat::runtime::live_turns().lock().unwrap();
                            if let Some(r) = live.runs.get_mut(&rid) {
                                r.assistant_text = "Verified clean diff on antigravity.".to_string();
                            }
                        }
                        crate::chat::runtime::finish_run(&rid, true, false, "");
                        return tid;
                    }
                }
                std::thread::sleep(Duration::from_millis(15));
            }
            panic!("timed out waiting for antigravity stage thread turn");
        });

        let (tid_opt, settled_output) = default_stage_runner(&stage, &run, "Run check")
            .expect("antigravity stage must run through real chat turn");
        let settled_tid = settler.join().unwrap();
        assert_eq!(tid_opt.as_deref(), Some(settled_tid.as_str()));
        assert_eq!(settled_output, "Verified clean diff on antigravity.");

        // Confirm configure_thread applied profile defaults on the created antigravity thread
        let thread_snapshot = {
            let all = crate::persist::threads().lock().unwrap();
            all.iter()
                .find(|t| t.get("id").and_then(Value::as_str) == Some(settled_tid.as_str()))
                .cloned()
                .unwrap()
        };
        assert_eq!(thread_snapshot["provider"], "antigravity");
        assert_eq!(thread_snapshot["model"], "claude-sonnet-4-6");
        assert_eq!(thread_snapshot["mode"], "acceptEdits");
        assert_eq!(thread_snapshot["effort"], "high");

        // Error propagation via await_turn_settlement
        let err_tid = crate::chat::create_thread(Some(&ag_id), &format!("{prefix}-err"), "antigravity", None)["id"]
            .as_str()
            .unwrap()
            .to_string();
        let err_run = crate::chat::start_turn(&err_tid, Some(&ag_id), "Fail", Vec::new(), None)["runId"]
            .as_str()
            .unwrap()
            .to_string();
        let err_run_clone = err_run.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            crate::chat::runtime::finish_run(&err_run_clone, false, false, "CLI failed with exit 1");
        });
        let err = await_turn_settlement(&err_tid, &err_run, Duration::from_secs(5))
            .expect_err("error turn must fail stage");
        assert!(err.contains("CLI failed"), "got: {err}");
    }
}
