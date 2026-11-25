use crate::local_tasks::{
    is_uuid, load_store, publish, request_value, store_lock, strict_object, tasks_file_path,
    utf16_len, with_document, Load, ENGINES,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use tauri::Emitter;
use uuid::Uuid;

const UNAVAILABLE_REASON: &str =
    "Cloud autopilot is unavailable in this local build, so it cannot take an automatic action.";
const DEFAULT_MAX_TURNS: i64 = 12;
const DEFAULT_DREAM_MAX_TURNS: i64 = 240;
const DEFAULT_MAX_WALL_CLOCK_MINS: i64 = 20;

static ACTIVE_AUTOPILOT_AGENTS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn active_agents_set() -> &'static Mutex<HashSet<String>> {
    ACTIVE_AUTOPILOT_AGENTS.get_or_init(|| Mutex::new(HashSet::new()))
}

pub fn active_autopilot_agent_ids() -> HashSet<String> {
    active_agents_set()
        .lock()
        .map(|s| s.clone())
        .unwrap_or_default()
}

fn mark_autopilot_agent_active(agent_id: &str, active: bool) {
    if agent_id.trim().is_empty() {
        return;
    }
    if let Ok(mut set) = active_agents_set().lock() {
        if active {
            set.insert(agent_id.to_string());
        } else {
            set.remove(agent_id);
        }
    }
}

fn now_unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn autopilot_text(value: &Value, max_units: usize) -> bool {
    value.as_str().is_some_and(|text| {
        utf16_len(text) <= max_units
            && text.len() <= max_units
            && text.chars().all(|ch| {
                ch == '\n'
                    || ch == '\r'
                    || ch == '\t'
                    || {
                        let code = ch as u32;
                        code >= 32 && !(127..=159).contains(&code)
                    }
            })
    })
}

fn json_int(value: &Value, min: i64, max: i64) -> Option<i64> {
    let number = value.as_i64()?;
    (min..=max).contains(&number).then_some(number)
}

fn is_supported_engine(engine: &str) -> bool {
    let lower = engine.trim().to_ascii_lowercase();
    ENGINES.contains(&lower.as_str())
        || matches!(
            lower.as_str(),
            "claude" | "opencode" | "open-code" | "agy" | "antigravity" | "gemini" | "grok" | "codex" | "cursor"
        )
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VerificationGateResult {
    pub command: String,
    pub passed: bool,
    #[serde(default)]
    pub output: String,
}

#[derive(Debug, Clone)]
pub(crate) struct AcceptedTurn {
    agent_id: String,
    agent_name: String,
    surface: String,
    thread_id: Option<String>,
    mode: String,
    task: String,
    engine: String,
    transcript: String,
    turns_completed: i64,
    previous_prompts: Vec<String>,
    objective: Option<String>,
    max_turns: i64,
    max_wall_clock_mins: i64,
    started_at_unix_ms: Option<i64>,
    verification_gates: Vec<String>,
    verification_results: Vec<VerificationGateResult>,
    announce_via_argos: bool,
    is_v2: bool,
}

fn parse_autopilot(value: &Value) -> Option<AcceptedTurn> {
    let obj = value.as_object()?;
    let supported_v = obj.get("supportedSchemaVersion")?.as_i64()?;
    if supported_v != 1 && supported_v != 2 {
        return None;
    }

    let surface = obj
        .get("surface")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| matches!(*s, "terminal" | "thread"))
        .unwrap_or("terminal")
        .to_string();

    let is_v2 = supported_v == 2
        || obj.contains_key("surface")
        || obj.contains_key("threadId")
        || obj.contains_key("verificationGates")
        || obj.contains_key("verificationResults")
        || obj.contains_key("maxTurns")
        || obj.contains_key("maxWallClockMins")
        || obj.contains_key("announceViaArgos");

    // Legacy strict validation for v1 schema when no v2 fields are present
    if !is_v2 {
        let object = strict_object(
            value,
            &[
                "supportedSchemaVersion",
                "agentId",
                "paneId",
                "sessionId",
                "runId",
                "generation",
                "turn",
            ],
        )
        .ok()?;
        for key in ["agentId", "paneId", "sessionId", "runId"] {
            let text = object.get(key)?.as_str()?;
            if !is_uuid(text) {
                return None;
            }
        }
        json_int(object.get("generation")?, 1, 65535)?;
    } else {
        let agent_id = obj.get("agentId").and_then(Value::as_str).unwrap_or("").trim();
        if agent_id.is_empty() {
            return None;
        }
        if surface == "terminal" {
            for key in ["paneId", "sessionId"] {
                if let Some(v) = obj.get(key).and_then(Value::as_str) {
                    if v.trim().is_empty() {
                        return None;
                    }
                }
            }
        }
    }

    let turn = obj.get("turn")?;
    let turn_object = if is_v2 {
        turn.as_object()?
    } else {
        strict_object(
            turn,
            &[
                "supportedSchemaVersion",
                "task",
                "mode",
                "engine",
                "transcript",
                "turnsCompleted",
                "previousPrompts",
                "objective",
                "objectivesCompleted",
                "completedObjectives",
            ],
        )
        .ok()?
    };

    let turn_sv = turn_object.get("supportedSchemaVersion")?.as_i64()?;
    if turn_sv != 1 && turn_sv != 2 {
        return None;
    }

    let task = turn_object.get("task")?;
    if !autopilot_text(task, 4000) {
        return None;
    }
    let mode = turn_object.get("mode")?.as_str()?;
    if !matches!(mode, "complete" | "dream" | "harden" | "review" | "task") {
        return None;
    }
    let task_text = task.as_str().unwrap_or("");
    if mode == "task" {
        if task_text.trim().is_empty() {
            return None;
        }
    } else if !task_text.is_empty() {
        return None;
    }

    let engine = turn_object.get("engine")?.as_str()?;
    if !is_supported_engine(engine) {
        return None;
    }
    if !autopilot_text(turn_object.get("transcript")?, 16_000) {
        return None;
    }
    let turns_completed = json_int(turn_object.get("turnsCompleted")?, 0, 500)?;
    let prompts = turn_object.get("previousPrompts")?.as_array()?;
    if prompts.len() > 5 || prompts.iter().any(|prompt| !autopilot_text(prompt, 1000)) {
        return None;
    }
    let previous_prompts: Vec<String> = prompts
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect();

    let objective = match turn_object.get("objective")? {
        Value::Null => None,
        value if autopilot_text(value, 400) => value.as_str().map(str::to_string),
        _ => return None,
    };
    json_int(turn_object.get("objectivesCompleted")?, 0, 500)?;
    let completed = turn_object.get("completedObjectives")?.as_array()?;
    if completed.len() > 12 || completed.iter().any(|item| !autopilot_text(item, 400)) {
        return None;
    }

    let agent_id = obj
        .get("agentId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let agent_name = obj
        .get("agentName")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Agent")
        .to_string();
    let thread_id = obj
        .get("threadId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let default_limit = if mode == "dream" {
        DEFAULT_DREAM_MAX_TURNS
    } else if is_v2 {
        DEFAULT_MAX_TURNS
    } else {
        60
    };
    let max_turns = obj
        .get("maxTurns")
        .and_then(|v| json_int(v, 1, 500))
        .unwrap_or(default_limit);
    let max_wall_clock_mins = obj
        .get("maxWallClockMins")
        .and_then(|v| json_int(v, 1, 480))
        .unwrap_or(DEFAULT_MAX_WALL_CLOCK_MINS);
    let started_at_unix_ms = obj.get("startedAtUnixMs").and_then(Value::as_i64);
    let verification_gates = obj
        .get("verificationGates")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .take(8)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let verification_results: Vec<VerificationGateResult> = obj
        .get("verificationResults")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|item| serde_json::from_value::<VerificationGateResult>(item.clone()).ok())
                .take(8)
                .collect()
        })
        .unwrap_or_default();
    let announce_via_argos = obj
        .get("announceViaArgos")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let transcript = turn_object
        .get("transcript")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    Some(AcceptedTurn {
        agent_id,
        agent_name,
        surface,
        thread_id,
        mode: mode.to_string(),
        task: task_text.to_string(),
        engine: engine.to_string(),
        transcript,
        turns_completed,
        previous_prompts,
        objective,
        max_turns,
        max_wall_clock_mins,
        started_at_unix_ms,
        verification_gates,
        verification_results,
        announce_via_argos,
        is_v2,
    })
}

fn stuck_decision_with_reason(turns_remaining: i64, reason: &str) -> Value {
    json!({
        "action": "stuck",
        "prompt": "",
        "reason": reason,
        "objective": "",
        "model": "",
        "turnsRemaining": turns_remaining,
        "objectivesRemaining": 0
    })
}

fn stuck_decision(turns_remaining: i64) -> Value {
    stuck_decision_with_reason(turns_remaining, UNAVAILABLE_REASON)
}

fn turns_remaining(turn: &AcceptedTurn) -> i64 {
    (turn.max_turns - turn.turns_completed).clamp(0, 65535)
}

fn resolve_turn_transcript(transcript: &str, session_id: &str) -> String {
    if !transcript.trim().is_empty() {
        return transcript.to_string();
    }
    if session_id.trim().is_empty() {
        return String::new();
    }
    crate::terminal::scrollback::terminal_recent_text(session_id)
}

fn provider_for_engine(engine: &str) -> Option<&'static str> {
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

fn extract_json_object_str(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
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

fn parse_llm_decision_json(raw: &str, remaining: i64) -> Option<Value> {
    let mut try_parse = |text: &str| -> Option<Value> {
        let json_str = extract_json_object_str(text)?;
        let val = serde_json::from_str::<Value>(&json_str).ok()?;
        let action = val.get("action").and_then(Value::as_str)?.trim().to_ascii_lowercase();
        if !matches!(action.as_str(), "prompt" | "wait" | "complete" | "advance" | "stuck") {
            return None;
        }
        let prompt = val
            .get("prompt")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .chars()
            .take(1000)
            .collect::<String>();
        let reason = val
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or("Auto evaluated turn with active provider.")
            .trim()
            .chars()
            .take(400)
            .collect::<String>();
        let objective = val
            .get("objective")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .chars()
            .take(200)
            .collect::<String>();
        if matches!(action.as_str(), "prompt" | "advance") && prompt.is_empty() {
            return None;
        }
        Some(json!({
            "action": action,
            "prompt": prompt,
            "reason": reason,
            "objective": objective,
            "model": "",
            "turnsRemaining": remaining,
            "objectivesRemaining": 0
        }))
    };

    if let Some(direct) = try_parse(raw) {
        return Some(direct);
    }

    // NDJSON stream fallback
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
        return try_parse(&collected);
    }
    None
}

fn run_provider_autopilot_prompt(provider: &str, prompt: &str) -> Result<String, String> {
    use std::time::Duration;

    if cfg!(test) {
        let _ = (provider, prompt);
        return Err("live provider autopilot disabled in unit tests".to_string());
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
    let output = crate::hidden_exec::run(&plan.program, &args_refs, Duration::from_secs(15))
        .map_err(|e| format!("spawn failed: {e}"))?;
    if output.timed_out {
        return Err("autopilot provider evaluation timed out".to_string());
    }
    let stdout = output.stdout_lossy();
    if output.success() && !stdout.trim().is_empty() {
        return Ok(stdout);
    }
    Err(format!("provider exited with status {:?}", output.code))
}

fn build_autopilot_eval_prompt(turn: &AcceptedTurn) -> String {
    let tail_transcript: String = turn
        .transcript
        .chars()
        .rev()
        .take(4000)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    let prev = if turn.previous_prompts.is_empty() {
        "(none)".to_string()
    } else {
        turn.previous_prompts.join(" | ")
    };
    let gates = if turn.verification_gates.is_empty() {
        "(none)".to_string()
    } else {
        turn.verification_gates.join(", ")
    };
    format!(
        "You are Kite Code's autonomous AutoPilot supervisor.\nMode: {}\nSurface: {}\nTask: {}\nTurns completed: {} / {}\nObjective: {}\nPrevious prompts: {}\nVerification gates: {}\n\nRecent transcript:\n{}\n\nDecide the next single step. Respond ONLY with JSON:\n{{\"action\":\"prompt|wait|complete|advance|stuck\",\"prompt\":\"<next concise instruction if prompt/advance>\",\"reason\":\"<short reason>\",\"objective\":\"<short objective>\"}}",
        turn.mode,
        turn.surface,
        if turn.task.is_empty() { "(mode-driven)" } else { &turn.task },
        turn.turns_completed,
        turn.max_turns,
        turn.objective.as_deref().unwrap_or("(none)"),
        prev,
        gates,
        if tail_transcript.trim().is_empty() { "(empty transcript)" } else { &tail_transcript }
    )
}

fn evaluate_autopilot_turn(turn: &AcceptedTurn, remaining: i64) -> Value {
    let transcript_lower = turn.transcript.to_lowercase();
    let is_busy = transcript_lower.contains("compiling ")
        || transcript_lower.contains("building ")
        || transcript_lower.contains("downloading ")
        || transcript_lower.contains("installing ")
        || transcript_lower.contains("running check")
        || transcript_lower.ends_with("...")
        || transcript_lower.ends_with("…");

    if is_busy {
        return json!({
            "action": "wait",
            "prompt": "",
            "reason": "The Agent is still working. Auto will check again.",
            "objective": "",
            "model": "",
            "turnsRemaining": remaining,
            "objectivesRemaining": 0
        });
    }

    if turn.turns_completed >= 1 {
        let is_completed = transcript_lower.contains("build succeeded")
            || transcript_lower.contains("all tests passed")
            || transcript_lower.contains("done in ")
            || transcript_lower.contains("finished successfully")
            || transcript_lower.contains("0 errors")
            || transcript_lower.contains("verification complete");

        if is_completed {
            if turn.mode == "dream" {
                return json!({
                    "action": "advance",
                    "prompt": "Identify and implement the next highest-leverage improvement for this project, then verify it.",
                    "reason": "Previous improvement verified. Advancing to the next objective.",
                    "objective": "Next project improvement",
                    "model": "",
                    "turnsRemaining": remaining,
                    "objectivesRemaining": 0
                });
            } else {
                return json!({
                    "action": "complete",
                    "prompt": "",
                    "reason": "Auto verified that the objective is complete.",
                    "objective": "Objective complete",
                    "model": "",
                    "turnsRemaining": remaining,
                    "objectivesRemaining": 0
                });
            }
        }
    }

    let (prompt, objective) = match turn.mode.as_str() {
        "complete" => (
            "Continue and complete the remaining steps of the current task, then verify the result.".to_string(),
            "Finish current task".to_string(),
        ),
        "dream" => (
            "Identify and implement the next highest-leverage improvement for this project, then verify it.".to_string(),
            "Next project improvement".to_string(),
        ),
        "harden" => (
            "Run the project's build and test checks, and fix any failures found.".to_string(),
            "Run checks and fix failures".to_string(),
        ),
        "review" => (
            "Review the recent changes and git diff for bugs, edge cases, or regressions, and fix any defects.".to_string(),
            "Review diff and fix defects".to_string(),
        ),
        "task" => (
            format!("Continue driving toward the goal: {}. Test and verify each step.", turn.task),
            turn.task.clone(),
        ),
        _ => (
            "Continue the task and verify the result.".to_string(),
            "Continue task".to_string(),
        ),
    };

    json!({
        "action": "prompt",
        "prompt": prompt,
        "reason": format!("Auto started turn {}.", turn.turns_completed + 1),
        "objective": objective,
        "model": "",
        "turnsRemaining": remaining,
        "objectivesRemaining": 0
    })
}

fn check_loop_guardrails(turn: &AcceptedTurn, remaining: i64, now_ms: i64) -> Option<Value> {
    if turn.turns_completed >= turn.max_turns {
        return Some(stuck_decision_with_reason(
            0,
            &format!(
                "Turn limit reached ({} of {} turns). Review progress before continuing.",
                turn.turns_completed, turn.max_turns
            ),
        ));
    }

    if let Some(started) = turn.started_at_unix_ms {
        let elapsed_ms = now_ms.saturating_sub(started);
        let limit_ms = turn.max_wall_clock_mins.saturating_mul(60_000);
        if limit_ms > 0 && elapsed_ms >= limit_ms {
            return Some(stuck_decision_with_reason(
                remaining,
                &format!(
                    "Wall-clock limit reached ({} mins). Escalating for builder review.",
                    turn.max_wall_clock_mins
                ),
            ));
        }
    }

    if turn.previous_prompts.len() >= 2 {
        let last = turn.previous_prompts[turn.previous_prompts.len() - 1]
            .trim()
            .to_ascii_lowercase();
        let prev = turn.previous_prompts[turn.previous_prompts.len() - 2]
            .trim()
            .to_ascii_lowercase();
        if !last.is_empty() && last == prev {
            return Some(stuck_decision_with_reason(
                remaining,
                "Loop detected: agent received identical consecutive prompts without settling.",
            ));
        }
    }

    None
}

fn apply_verification_gates(turn: &AcceptedTurn, mut decision: Value, remaining: i64) -> Value {
    let action = decision.get("action").and_then(Value::as_str).unwrap_or("");
    if action != "complete" || turn.verification_gates.is_empty() {
        return decision;
    }

    if turn.verification_results.is_empty() {
        return json!({
            "action": "verify",
            "prompt": "",
            "reason": format!("Running {} deterministic verification gate(s) before completion.", turn.verification_gates.len()),
            "objective": decision.get("objective").cloned().unwrap_or(json!("Verify gates")),
            "gates": turn.verification_gates,
            "model": "",
            "turnsRemaining": remaining,
            "objectivesRemaining": 0
        });
    }

    let failed: Vec<&VerificationGateResult> = turn
        .verification_results
        .iter()
        .filter(|r| !r.passed)
        .collect();
    if !failed.is_empty() {
        let summary = failed
            .iter()
            .map(|r| {
                let tail: String = r.output.chars().take(400).collect();
                format!("- `{}` failed: {}", r.command, tail.trim())
            })
            .collect::<Vec<_>>()
            .join("\n");
        let fix_prompt = format!(
            "Verification gate(s) failed before completion:\n{summary}\n\nFix these failures and re-verify."
        );
        return json!({
            "action": "prompt",
            "prompt": fix_prompt,
            "reason": format!("{} verification gate(s) failed; prompting agent to fix.", failed.len()),
            "objective": "Fix verification gate failures",
            "model": "",
            "turnsRemaining": remaining,
            "objectivesRemaining": 0
        });
    }

    decision["reason"] = json!(format!(
        "Auto verified objective and passed {} verification gate(s).",
        turn.verification_results.len()
    ));
    decision
}

pub(crate) fn evaluate_autopilot_with_runner<F>(
    turn: &AcceptedTurn,
    remaining: i64,
    now_ms: i64,
    mut runner: F,
) -> Value
where
    F: FnMut(&str, &str) -> Result<String, String>,
{
    if let Some(guardrail) = check_loop_guardrails(turn, remaining, now_ms) {
        return guardrail;
    }

    // If verification results were supplied directly after a `verify` action, resolve immediately
    if !turn.verification_results.is_empty() && !turn.verification_gates.is_empty() {
        let synthetic_complete = json!({
            "action": "complete",
            "prompt": "",
            "reason": "Verification gates evaluated.",
            "objective": "Verify gates",
            "model": "",
            "turnsRemaining": remaining,
            "objectivesRemaining": 0
        });
        return apply_verification_gates(turn, synthetic_complete, remaining);
    }

    let eval_prompt = build_autopilot_eval_prompt(turn);
    let mut candidates: Vec<&'static str> = Vec::new();
    if let Some(preferred) = provider_for_engine(&turn.engine) {
        candidates.push(preferred);
    }
    for label in crate::chat::runtime::spawn::list_available_providers() {
        if let Some(pid) = provider_for_engine(label) {
            if !candidates.contains(&pid) {
                candidates.push(pid);
            }
        }
    }

    let mut chosen: Option<(Value, String)> = None;
    for provider in candidates {
        if let Ok(raw) = runner(provider, &eval_prompt) {
            if let Some(mut parsed) = parse_llm_decision_json(&raw, remaining) {
                parsed["model"] = json!(provider);
                chosen = Some((parsed, provider.to_string()));
                break;
            }
        }
    }

    let decision = chosen
        .map(|(v, _)| v)
        .unwrap_or_else(|| evaluate_autopilot_turn(turn, remaining));

    // Check candidate prompt repetition against the last prompt
    let decision_action = decision.get("action").and_then(Value::as_str).unwrap_or("");
    if matches!(decision_action, "prompt" | "advance") && turn.turns_completed >= 2 {
        let cand_prompt = decision
            .get("prompt")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        let repeated_prev = turn
            .previous_prompts
            .iter()
            .rev()
            .take(2)
            .filter(|p| p.trim().to_ascii_lowercase() == cand_prompt && !cand_prompt.is_empty())
            .count();
        if repeated_prev >= 2 {
            return stuck_decision_with_reason(
                remaining,
                "Loop detected: AutoPilot selected the same prompt repeatedly without progress.",
            );
        }
    }

    apply_verification_gates(turn, decision, remaining)
}

fn emit_autopilot_terminal_notice(turn: &AcceptedTurn, decision: &Value) {
    if cfg!(test) {
        return;
    }
    let action = decision.get("action").and_then(Value::as_str).unwrap_or("");
    if action != "complete" && action != "stuck" {
        return;
    }
    let reason = decision
        .get("reason")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let outcome = if action == "complete" {
        "completed"
    } else {
        "failed"
    };
    let target = if let Some(tid) = turn.thread_id.as_deref() {
        json!({ "source": "agentChat", "id": tid })
    } else {
        json!({ "source": "terminal", "id": turn.agent_id })
    };
    let title = if action == "complete" {
        format!("AutoPilot finished · {}", turn.agent_name)
    } else {
        format!("AutoPilot needs attention · {}", turn.agent_name)
    };
    let notice = json!({
        "id": Uuid::new_v4().to_string(),
        "runId": Value::Null,
        "target": target,
        "profileId": turn.agent_id,
        "routineId": Value::Null,
        "kind": { "kind": "settled", "outcome": outcome },
        "title": title,
        "body": reason,
        "resolution": Value::Null,
        "createdAtUnixMs": now_unix_ms(),
        "isRead": false,
        "isWaitingForInput": action == "stuck"
    });
    if let Ok(mut items) = crate::persist::notifications().lock() {
        items.insert(0, notice);
        if items.len() > 100 {
            items.truncate(100);
        }
    }
    crate::persist::persist();

    if turn.announce_via_argos {
        if let Some(app) = crate::get_app_handle() {
            let _ = app.emit(
                "kite:agent-announce",
                json!({
                    "source": "autopilot",
                    "agentId": turn.agent_id,
                    "agentName": turn.agent_name,
                    "status": action,
                    "message": format!("{title}: {reason}"),
                    "threadId": turn.thread_id,
                }),
            );
        }
    }
}

pub fn autopilot_next(request: Option<Value>) -> Value {
    let value = request_value(&request);
    let Some(mut turn) = parse_autopilot(&value) else {
        return stuck_decision(0);
    };

    let remaining = turns_remaining(&turn);
    let _ = with_document(|document| {
        document["schemaVersion"] = json!(1);
        document["autopilotActive"] = json!(true);
        Ok(())
    });

    if cfg!(test) && std::env::var("KITE_LIVE_AUTOPILOT").is_err() && !turn.is_v2 {
        return stuck_decision(remaining);
    }

    let session_id = value.get("sessionId").and_then(Value::as_str).unwrap_or("");
    if turn.surface == "terminal" {
        turn.transcript = resolve_turn_transcript(&turn.transcript, session_id);
    }

    let decision = evaluate_autopilot_with_runner(
        &turn,
        remaining,
        now_unix_ms(),
        run_provider_autopilot_prompt,
    );
    let action = decision.get("action").and_then(Value::as_str).unwrap_or("");
    let is_active = !matches!(action, "complete" | "stuck");
    mark_autopilot_agent_active(&turn.agent_id, is_active);
    emit_autopilot_terminal_notice(&turn, &decision);
    decision
}

pub fn cancel_autopilot(request: Option<Value>) -> Value {
    if let Some(req) = request.as_ref().map(|v| v.get("request").unwrap_or(v)) {
        if let Some(agent_id) = req.get("agentId").and_then(Value::as_str) {
            mark_autopilot_agent_active(agent_id, false);
        } else if let Ok(mut set) = active_agents_set().lock() {
            set.clear();
        }
    } else if let Ok(mut set) = active_agents_set().lock() {
        set.clear();
    }

    let path = tasks_file_path();
    let _guard = store_lock().lock().unwrap_or_else(|err| err.into_inner());
    if let Load::Ready(mut document) = load_store(&path) {
        if document.get("autopilotActive").and_then(Value::as_bool) == Some(true) {
            document["autopilotActive"] = json!(false);
            let _ = publish(&path, &document);
        }
    }
    Value::Null
}

fn is_safe_verification_gate(cmd: &str) -> Result<Vec<String>, String> {
    let trimmed = cmd.trim();
    if trimmed.is_empty() {
        return Err("Verification gate command cannot be empty.".to_string());
    }
    if [';', '&', '|', '`', '$', '>', '<', '\n', '\r']
        .iter()
        .any(|c| trimmed.contains(*c))
    {
        return Err(format!(
            "Verification gate command contains disallowed shell operators: '{trimmed}'"
        ));
    }
    let allowed_prefixes = [
        "npx tsc",
        "npx vitest",
        "npm test",
        "npm run",
        "cargo test",
        "cargo check",
        "pytest",
        "go test",
    ];
    let lower = trimmed.to_ascii_lowercase();
    if !allowed_prefixes.iter().any(|p| lower.starts_with(p)) {
        return Err(format!(
            "Verification gate '{trimmed}' is not in the deterministic allowlist (npx tsc/vitest, npm test/run, cargo test/check, pytest, go test)."
        ));
    }
    let parts: Vec<String> = trimmed
        .split_whitespace()
        .map(str::to_string)
        .collect();
    if parts.is_empty() {
        return Err("Verification gate command is empty.".to_string());
    }
    Ok(parts)
}

fn resolve_gate_cwd(workspace_id: Option<&str>) -> Option<PathBuf> {
    let ws = workspace_id.map(str::trim).filter(|s| !s.is_empty())?;
    if let Some(p) = crate::persist::workspace_path(ws) {
        let pb = PathBuf::from(p);
        if pb.is_dir() {
            return Some(pb);
        }
    }
    let direct = PathBuf::from(ws);
    if direct.is_dir() {
        Some(direct)
    } else {
        None
    }
}

pub(crate) fn execute_verification_gates_with<F>(
    gates: &[String],
    cwd: Option<&PathBuf>,
    mut runner: F,
) -> Result<Value, String>
where
    F: FnMut(&str, &[&str], Option<&PathBuf>) -> Result<(bool, String), String>,
{
    let mut results = Vec::with_capacity(gates.len());
    let mut all_passed = true;
    for gate in gates.iter().take(8) {
        let parts = is_safe_verification_gate(gate)?;
        let prog = &parts[0];
        let args: Vec<&str> = parts[1..].iter().map(String::as_str).collect();
        match runner(prog, &args, cwd) {
            Ok((passed, output)) => {
                if !passed {
                    all_passed = false;
                }
                results.push(json!({
                    "command": gate,
                    "passed": passed,
                    "output": output.chars().take(2000).collect::<String>(),
                }));
            }
            Err(err) => {
                all_passed = false;
                results.push(json!({
                    "command": gate,
                    "passed": false,
                    "output": err,
                }));
            }
        }
    }
    Ok(json!({
        "allPassed": all_passed,
        "results": results,
    }))
}

#[tauri::command]
pub fn run_autopilot_verification_gates(request: Option<Value>) -> Result<Value, String> {
    let req = request
        .as_ref()
        .map(|v| v.get("request").unwrap_or(v))
        .ok_or_else(|| "Verification gate request is required.".to_string())?;
    let gates: Vec<String> = req
        .get("gates")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    if gates.is_empty() {
        return Ok(json!({ "allPassed": true, "results": [] }));
    }
    let cwd = resolve_gate_cwd(req.get("workspaceId").and_then(Value::as_str));
    execute_verification_gates_with(&gates, cwd.as_ref(), |prog, args, dir| {
        if cfg!(test) {
            let _ = (prog, args, dir);
            return Err("live gate execution disabled in unit tests".to_string());
        }
        let mut cmd = std::process::Command::new(prog);
        cmd.args(args);
        if let Some(d) = dir {
            cmd.current_dir(d);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        let out = cmd.output().map_err(|e| format!("Failed to run '{prog}': {e}"))?;
        let combined = format!(
            "{}\n{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        Ok((out.status.success(), combined.trim().to_string()))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_turn(mode: &str, turns_completed: i64, transcript: &str) -> AcceptedTurn {
        AcceptedTurn {
            agent_id: "agent-1".to_string(),
            agent_name: "Builder".to_string(),
            surface: "thread".to_string(),
            thread_id: Some("thread-1".to_string()),
            mode: mode.to_string(),
            task: "Ship feature".to_string(),
            engine: "claude-code".to_string(),
            transcript: transcript.to_string(),
            turns_completed,
            previous_prompts: Vec::new(),
            objective: None,
            max_turns: 12,
            max_wall_clock_mins: 20,
            started_at_unix_ms: None,
            verification_gates: Vec::new(),
            verification_results: Vec::new(),
            announce_via_argos: false,
            is_v2: true,
        }
    }

    #[test]
    fn evaluate_autopilot_turn_handles_wait_prompt_advance_and_complete() {
        let busy = sample_turn("complete", 1, "Compiling kite-code v0.1.0...");
        let wait_res = evaluate_autopilot_turn(&busy, 59);
        assert_eq!(wait_res["action"], "wait");

        let first = sample_turn("complete", 0, "");
        let prompt_res = evaluate_autopilot_turn(&first, 60);
        assert_eq!(prompt_res["action"], "prompt");
        assert!(!prompt_res["prompt"].as_str().unwrap().is_empty());

        let done_turn = sample_turn("complete", 1, "All tests passed in 1.2s");
        let complete_res = evaluate_autopilot_turn(&done_turn, 59);
        assert_eq!(complete_res["action"], "complete");

        let dream_turn = sample_turn("dream", 1, "All tests passed in 1.2s");
        let advance_res = evaluate_autopilot_turn(&dream_turn, 239);
        assert_eq!(advance_res["action"], "advance");
    }

    #[test]
    fn evaluate_autopilot_with_runner_uses_provider_json_and_falls_back_offline() {
        let turn = sample_turn("complete", 1, "Implemented auth handler.");
        let llm_res = evaluate_autopilot_with_runner(&turn, 11, 10_000, |_prov, _prompt| {
            Ok("```json\n{\"action\":\"prompt\",\"prompt\":\"Add unit tests for auth\",\"reason\":\"Missing tests\",\"objective\":\"Verify auth\"}\n```".to_string())
        });
        assert_eq!(llm_res["action"], "prompt");
        assert_eq!(llm_res["prompt"], "Add unit tests for auth");
        assert_eq!(llm_res["model"], "claude");

        let fallback_turn = sample_turn("complete", 1, "All tests passed");
        let offline_res =
            evaluate_autopilot_with_runner(&fallback_turn, 11, 10_000, |_p, _q| Err("offline".into()));
        assert_eq!(offline_res["action"], "complete");
    }

    #[test]
    fn guardrails_stop_on_max_turns_wall_clock_and_repeated_prompt_loop() {
        let mut max_turn = sample_turn("complete", 12, "");
        max_turn.max_turns = 12;
        let res_turns = evaluate_autopilot_with_runner(&max_turn, 0, 100_000, |_, _| Err("off".into()));
        assert_eq!(res_turns["action"], "stuck");
        assert!(res_turns["reason"].as_str().unwrap().contains("Turn limit"));

        let mut wall_turn = sample_turn("complete", 1, "");
        wall_turn.max_wall_clock_mins = 10;
        wall_turn.started_at_unix_ms = Some(1_000);
        let res_wall =
            evaluate_autopilot_with_runner(&wall_turn, 10, 1_000 + 10 * 60_000, |_, _| Err("off".into()));
        assert_eq!(res_wall["action"], "stuck");
        assert!(res_wall["reason"].as_str().unwrap().contains("Wall-clock"));

        let mut loop_turn = sample_turn("complete", 2, "");
        loop_turn.previous_prompts = vec!["Run tests".into(), "Run tests".into()];
        let res_loop = evaluate_autopilot_with_runner(&loop_turn, 10, 10_000, |_, _| Err("off".into()));
        assert_eq!(res_loop["action"], "stuck");
        assert!(res_loop["reason"].as_str().unwrap().contains("Loop detected"));
    }

    #[test]
    fn verification_gates_require_verify_step_and_prompt_on_failure() {
        let mut turn = sample_turn("complete", 1, "All tests passed");
        turn.verification_gates = vec!["npx tsc --noEmit".to_string()];

        let verify_res = evaluate_autopilot_with_runner(&turn, 10, 10_000, |_, _| Err("off".into()));
        assert_eq!(verify_res["action"], "verify");
        assert_eq!(verify_res["gates"], json!(["npx tsc --noEmit"]));

        turn.verification_results = vec![VerificationGateResult {
            command: "npx tsc --noEmit".to_string(),
            passed: false,
            output: "TS2322 type mismatch".to_string(),
        }];
        let fail_res = evaluate_autopilot_with_runner(&turn, 10, 10_000, |_, _| Err("off".into()));
        assert_eq!(fail_res["action"], "prompt");
        assert!(fail_res["prompt"].as_str().unwrap().contains("TS2322"));

        turn.verification_results = vec![VerificationGateResult {
            command: "npx tsc --noEmit".to_string(),
            passed: true,
            output: "ok".to_string(),
        }];
        let pass_res = evaluate_autopilot_with_runner(&turn, 10, 10_000, |_, _| Err("off".into()));
        assert_eq!(pass_res["action"], "complete");
    }

    #[test]
    fn verification_gate_allowlist_blocks_shell_injection_and_runs_safe_commands() {
        let unsafe_err =
            execute_verification_gates_with(&["npx tsc && rm -rf /".to_string()], None, |_, _, _| {
                Ok((true, String::new()))
            })
            .expect_err("must reject shell operators");
        assert!(unsafe_err.contains("disallowed shell operators"));

        let ok = execute_verification_gates_with(
            &["npx tsc --noEmit".to_string(), "cargo test agents".to_string()],
            None,
            |prog, _args, _dir| Ok((prog == "npx", format!("ran {prog}"))),
        )
        .unwrap();
        assert_eq!(ok["allPassed"], false);
        assert_eq!(ok["results"][0]["passed"], true);
        assert_eq!(ok["results"][1]["passed"], false);
    }

    #[test]
    fn parse_autopilot_accepts_thread_surface_without_terminal_uuids() {
        let req = json!({
            "supportedSchemaVersion": 2,
            "surface": "thread",
            "agentId": "agent-1",
            "agentName": "Orion",
            "threadId": "thread-abc",
            "maxTurns": 8,
            "verificationGates": ["npx tsc --noEmit"],
            "announceViaArgos": true,
            "turn": {
                "supportedSchemaVersion": 1,
                "task": "",
                "mode": "complete",
                "engine": "antigravity",
                "transcript": "assistant: ready",
                "turnsCompleted": 0,
                "previousPrompts": [],
                "objective": null,
                "objectivesCompleted": 0,
                "completedObjectives": []
            }
        });
        let parsed = parse_autopilot(&req).expect("should parse thread payload");
        assert_eq!(parsed.surface, "thread");
        assert_eq!(parsed.thread_id.as_deref(), Some("thread-abc"));
        assert_eq!(parsed.max_turns, 8);
        assert!(parsed.announce_via_argos);
    }

    #[test]
    fn resolve_turn_transcript_uses_non_empty_input_or_terminal_fallback() {
        assert_eq!(resolve_turn_transcript("live output", ""), "live output");
        assert_eq!(resolve_turn_transcript("   ", ""), "");
    }
}
