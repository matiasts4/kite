use crate::local_tasks::{
    is_uuid, load_store, publish, request_value, store_lock, strict_object, tasks_file_path, utf16_len,
    with_document, Load, ENGINES,
};
use serde_json::{json, Value};

const UNAVAILABLE_REASON: &str =
    "Cloud autopilot is unavailable in this local build, so it cannot take an automatic action.";

fn autopilot_text(value: &Value, max_units: usize) -> bool {
    value.as_str().is_some_and(|text| {
        utf16_len(text) <= max_units
            && text.len() <= max_units
            && text.chars().all(|ch| {
                ch == '\n'
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

struct AcceptedTurn {
    mode: String,
    task: String,
    transcript: String,
    turns_completed: i64,
}

fn parse_autopilot(value: &Value) -> Option<AcceptedTurn> {
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
    if object.get("supportedSchemaVersion") != Some(&json!(1)) {
        return None;
    }
    for key in ["agentId", "paneId", "sessionId", "runId"] {
        let text = object.get(key)?.as_str()?;
        if !is_uuid(text) {
            return None;
        }
    }
    json_int(object.get("generation")?, 1, 65535)?;
    let turn = object.get("turn")?;
    let turn_object = strict_object(
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
    .ok()?;
    if turn_object.get("supportedSchemaVersion") != Some(&json!(1)) {
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
    if !ENGINES.contains(&engine) {
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
    match turn_object.get("objective")? {
        Value::Null => {}
        value if autopilot_text(value, 400) => {}
        _ => return None,
    }
    json_int(turn_object.get("objectivesCompleted")?, 0, 500)?;
    let completed = turn_object.get("completedObjectives")?.as_array()?;
    if completed.len() > 12 || completed.iter().any(|item| !autopilot_text(item, 400)) {
        return None;
    }
    let transcript = turn_object.get("transcript").and_then(Value::as_str).unwrap_or("").to_string();
    Some(AcceptedTurn {
        mode: mode.to_string(),
        task: task_text.to_string(),
        transcript,
        turns_completed,
    })
}

fn stuck_decision(turns_remaining: i64) -> Value {
    json!({
        "action": "stuck",
        "prompt": "",
        "reason": UNAVAILABLE_REASON,
        "objective": "",
        "model": "",
        "turnsRemaining": turns_remaining,
        "objectivesRemaining": 0
    })
}

fn turns_remaining(turn: &AcceptedTurn) -> i64 {
    let limit = if turn.mode == "dream" { 240 } else { 60 };
    (limit - turn.turns_completed).clamp(0, 65535)
}

pub fn autopilot_next(request: Option<Value>) -> Value {
    let value = request_value(&request);
    let accepted = parse_autopilot(&value);
    let Some(turn) = accepted else {
        return stuck_decision(0);
    };

    let remaining = turns_remaining(&turn);
    let _ = with_document(|document| {
        document["schemaVersion"] = json!(1);
        document["autopilotActive"] = json!(true);
        Ok(())
    });

    if cfg!(test) && std::env::var("KITE_LIVE_AUTOPILOT").is_err() {
        return stuck_decision(remaining);
    }

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

pub fn cancel_autopilot(_request: Option<Value>) -> Value {
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

