use crate::persist::{agents, body, persist, routines};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::Mutex;
use uuid::Uuid;

const SCHEMA_VERSION: i64 = 1;
const NIL_UUID: &str = "00000000-0000-0000-0000-000000000000";
const MAX_ROUTINES_PER_AGENT: usize = 20;
const MAX_ROUTINES_TOTAL: usize = 4096;
const MAX_NAME_CHARS: usize = 160;
const MAX_NAME_BYTES: usize = 1024;
const MAX_PROMPT_CHARS: usize = 64_000;
const MAX_PROMPT_BYTES: usize = 262_144;
const MIN_INTERVAL_SECONDS: f64 = 900.0;
const MAX_INTERVAL_SECONDS: f64 = 9_007_199_254_740_991.0 / 1000.0;
const MAX_REMEMBERED_RUN_REQUESTS: usize = 256;
const MS_PER_MINUTE: i64 = 60_000;
const MS_PER_HOUR: i64 = 3_600_000;
const MS_PER_DAY: i64 = 86_400_000;
const INVALID_REQUEST: &str = "Routine request is invalid.";

type RoutineResult<T> = Result<T, RoutineCommandError>;

/// Serialized to the UI as `{ code, message }`. The UI maps known codes to its own copy.
#[derive(Debug, Serialize)]
pub struct RoutineCommandError {
    pub code: String,
    pub message: String,
}

impl RoutineCommandError {
    fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.to_string(),
            message: message.to_string(),
        }
    }
}

fn invalid(message: &str) -> RoutineCommandError {
    RoutineCommandError::new("invalid_request", message)
}

fn not_found() -> RoutineCommandError {
    RoutineCommandError::new(
        "routine_not_found",
        "That routine no longer exists. Reload the list and try again.",
    )
}

fn agent_not_found() -> RoutineCommandError {
    RoutineCommandError::new(
        "routine_agent_not_found",
        "That agent no longer exists. Reload the list and try again.",
    )
}

struct RunRequest {
    id: String,
    routine_id: String,
    thread_id: Option<String>,
}

// Remembers run request identifiers so a retried request replays instead of starting a second run.
static RUN_REQUESTS: Mutex<Vec<RunRequest>> = Mutex::new(Vec::new());

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

fn is_uuid(value: &str) -> bool {
    value.len() == 36 && Uuid::parse_str(value).is_ok()
}

fn request_uuid(req: &Value, key: &str) -> RoutineResult<String> {
    req.get(key)
        .and_then(Value::as_str)
        .filter(|value| is_uuid(value))
        .map(str::to_string)
        .ok_or_else(|| invalid(INVALID_REQUEST))
}

fn request_revision(req: &Value) -> RoutineResult<String> {
    req.get("expectedRevision")
        .and_then(Value::as_str)
        .filter(|value| {
            value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
        .map(str::to_string)
        .ok_or_else(|| invalid(INVALID_REQUEST))
}

fn has_disallowed_control(text: &str, allow_line_breaks: bool) -> bool {
    text.chars().any(|ch| {
        let code = ch as u32;
        if allow_line_breaks && matches!(code, 9 | 10 | 13) {
            return false;
        }
        code <= 31 || (127..=159).contains(&code)
    })
}

fn validate_text(
    raw: &str,
    label: &str,
    max_chars: usize,
    max_bytes: usize,
    allow_line_breaks: bool,
) -> RoutineResult<String> {
    let text = raw.trim();
    if text.is_empty() {
        return Err(invalid(&format!("{label} is required.")));
    }
    if text.chars().count() > max_chars
        || text.len() > max_bytes
        || has_disallowed_control(text, allow_line_breaks)
    {
        return Err(invalid(&format!("{label} exceeds safe limit.")));
    }
    Ok(text.to_string())
}

fn bounded_int(value: Option<&Value>, min: i64, max: i64) -> RoutineResult<i64> {
    value
        .and_then(Value::as_i64)
        .filter(|number| (min..=max).contains(number))
        .ok_or_else(|| invalid("Routine cadence is invalid."))
}

fn validate_cadence(value: Option<&Value>) -> RoutineResult<Value> {
    let cadence = value
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("Routine cadence is invalid."))?;
    match cadence.get("kind").and_then(Value::as_str) {
        Some("interval") => {
            if cadence.len() != 2 {
                return Err(invalid("Routine cadence is invalid."));
            }
            let seconds = cadence.get("seconds").cloned().unwrap_or(Value::Null);
            seconds
                .as_f64()
                .filter(|value| {
                    value.is_finite() && (MIN_INTERVAL_SECONDS..=MAX_INTERVAL_SECONDS).contains(value)
                })
                .ok_or_else(|| invalid("Routine cadence is invalid."))?;
            Ok(json!({ "kind": "interval", "seconds": seconds }))
        }
        Some("clock") => {
            if cadence.len() != 4 {
                return Err(invalid("Routine cadence is invalid."));
            }
            let hour = bounded_int(cadence.get("hour"), 0, 23)?;
            let minute = bounded_int(cadence.get("minute"), 0, 59)?;
            let weekdays = match cadence.get("weekdays") {
                Some(Value::Null) => Value::Null,
                Some(Value::Array(days)) if !days.is_empty() && days.len() <= 7 => {
                    let mut previous = 0;
                    let mut sorted = Vec::with_capacity(days.len());
                    for day in days {
                        let weekday = bounded_int(Some(day), 1, 7)?;
                        if weekday <= previous {
                            return Err(invalid("Routine weekdays must be unique and sorted."));
                        }
                        previous = weekday;
                        sorted.push(json!(weekday));
                    }
                    Value::Array(sorted)
                }
                _ => return Err(invalid("Routine cadence is invalid.")),
            };
            Ok(json!({ "kind": "clock", "hour": hour, "minute": minute, "weekdays": weekdays }))
        }
        _ => Err(invalid("Routine cadence is invalid.")),
    }
}

fn validate_workspace(value: Option<&Value>) -> RoutineResult<Value> {
    match value {
        None | Some(Value::Null) => Ok(Value::Null),
        Some(Value::String(id)) if is_uuid(id) => Ok(json!(id)),
        Some(_) => Err(invalid("Routine workspace is invalid.")),
    }
}

// Older records stored `author` as `{ "kind": "user" }`; the UI contract is "builder" | "agent".
fn normalize_record(record: &Value) -> Value {
    let agent_authored = match record.get("author") {
        Some(Value::String(kind)) => kind == "agent",
        Some(Value::Object(object)) => object.get("kind").and_then(Value::as_str) == Some("agent"),
        _ => false,
    };
    let mut normalized = record.clone();
    if let Some(object) = normalized.as_object_mut() {
        object.insert(
            "author".to_string(),
            json!(if agent_authored { "agent" } else { "builder" }),
        );
    }
    normalized
}

// Optimistic concurrency token: a content hash of one agent's routines (64 lowercase hex characters).
fn agent_revision(records: &[Value], agent_id: &str) -> String {
    let mut lines: Vec<String> = records
        .iter()
        .map(normalize_record)
        .filter(|record| record.get("agentId").and_then(Value::as_str) == Some(agent_id))
        .map(|record| record.to_string())
        .collect();
    lines.sort();
    let mut revision = String::with_capacity(64);
    for lane in 0u8..4 {
        let mut hasher = DefaultHasher::new();
        lane.hash(&mut hasher);
        agent_id.hash(&mut hasher);
        lines.hash(&mut hasher);
        revision.push_str(&format!("{:016x}", hasher.finish()));
    }
    revision
}

// Next scheduled time. Clock cadences are evaluated in UTC: Studio has no local-calendar dependency.
fn next_run_after(cadence: &Value, from_ms: i64) -> i64 {
    if cadence.get("kind").and_then(Value::as_str) == Some("interval") {
        let seconds = cadence.get("seconds").and_then(Value::as_f64).unwrap_or(3600.0);
        return from_ms.saturating_add((seconds * 1000.0).round() as i64);
    }
    let hour = cadence.get("hour").and_then(Value::as_i64).unwrap_or(0);
    let minute = cadence.get("minute").and_then(Value::as_i64).unwrap_or(0);
    let weekdays: Option<Vec<i64>> = cadence
        .get("weekdays")
        .and_then(Value::as_array)
        .map(|days| days.iter().filter_map(Value::as_i64).collect());
    let first_day = from_ms.div_euclid(MS_PER_DAY);
    for offset in 0..=8 {
        let day = first_day + offset;
        let candidate = day * MS_PER_DAY + hour * MS_PER_HOUR + minute * MS_PER_MINUTE;
        // 1970-01-01 was a Thursday; weekdays use the cadence contract (1 = Sunday ... 7 = Saturday).
        let weekday = (day + 4).rem_euclid(7) + 1;
        let allowed = weekdays.as_ref().map_or(true, |days| days.contains(&weekday));
        if candidate > from_ms && allowed {
            return candidate;
        }
    }
    from_ms.saturating_add(MS_PER_DAY)
}

// Only engines that map onto a chat provider can run a routine. Others are reported as unavailable.
fn chat_provider_for_engine(engine: &str) -> Option<&'static str> {
    match engine {
        "claude-code" => Some("claude"),
        "codex" => Some("codex"),
        "cursor" => Some("cursor"),
        "grok" => Some("grok"),
        "open-code" => Some("opencode"),
        _ => None,
    }
}

fn owned_by(record: &Value, agent_id: &str) -> bool {
    record.get("agentId").and_then(Value::as_str) == Some(agent_id)
}

fn is_routine(record: &Value, agent_id: &str, routine_id: &str) -> bool {
    owned_by(record, agent_id) && record.get("id").and_then(Value::as_str) == Some(routine_id)
}

fn ensure_revision(list: &[Value], agent_id: &str, expected: &str) -> RoutineResult<()> {
    if agent_revision(list, agent_id) == expected {
        return Ok(());
    }
    Err(RoutineCommandError::new(
        "routine_conflict",
        "These routines changed. Reload them before saving again.",
    ))
}

fn ensure_name_free(
    list: &[Value],
    agent_id: &str,
    name: &str,
    except_id: Option<&str>,
) -> RoutineResult<()> {
    let wanted = name.to_lowercase();
    let taken = list.iter().any(|record| {
        owned_by(record, agent_id)
            && record.get("id").and_then(Value::as_str) != except_id
            && record
                .get("name")
                .and_then(Value::as_str)
                .is_some_and(|existing| existing.to_lowercase() == wanted)
    });
    if taken {
        return Err(RoutineCommandError::new(
            "routine_duplicate_name",
            "This agent already has a routine with that name.",
        ));
    }
    Ok(())
}

fn ensure_capacity(list: &[Value], agent_id: &str) -> RoutineResult<()> {
    if list.len() >= MAX_ROUTINES_TOTAL {
        return Err(RoutineCommandError::new(
            "routine_total_limit",
            "Kite Code already stores the maximum number of routines.",
        ));
    }
    if list.iter().filter(|record| owned_by(record, agent_id)).count() >= MAX_ROUTINES_PER_AGENT {
        return Err(RoutineCommandError::new(
            "routine_limit",
            "This agent already has 20 routines. Pause or remove one first.",
        ));
    }
    Ok(())
}

fn agent_exists(agent_id: &str) -> bool {
    agents().lock().unwrap().iter().any(|agent| agent.id == agent_id)
}

pub fn routine_collection_snapshot() -> Value {
    let mut owner_ids: Vec<String> = agents()
        .lock()
        .unwrap()
        .iter()
        .map(|agent| agent.id.clone())
        .collect();
    let records: Vec<Value> = routines()
        .lock()
        .unwrap()
        .iter()
        .map(normalize_record)
        .collect();
    for record in &records {
        if let Some(owner) = record.get("agentId").and_then(Value::as_str) {
            if !owner_ids.iter().any(|id| id == owner) {
                owner_ids.push(owner.to_string());
            }
        }
    }
    let agent_revisions: Vec<Value> = owner_ids
        .iter()
        .map(|id| json!({ "agentId": id, "revision": agent_revision(&records, id) }))
        .collect();
    json!({
        "schemaVersion": SCHEMA_VERSION,
        "routines": records,
        "agentRevisions": agent_revisions,
        "runNowAvailability": { "available": true, "reason": "" }
    })
}

fn reserve_run_request(request_id: &str, routine_id: &str) -> RoutineResult<Option<String>> {
    let mut requests = RUN_REQUESTS.lock().unwrap();
    if let Some(existing) = requests.iter().find(|item| item.id == request_id) {
        if existing.routine_id != routine_id {
            return Err(invalid("The routine run request identifier is already in use."));
        }
        return match &existing.thread_id {
            Some(thread_id) => Ok(Some(thread_id.clone())),
            None => Err(RoutineCommandError::new(
                "routine_run_pending",
                "That routine run is already starting.",
            )),
        };
    }
    requests.push(RunRequest {
        id: request_id.to_string(),
        routine_id: routine_id.to_string(),
        thread_id: None,
    });
    if requests.len() > MAX_REMEMBERED_RUN_REQUESTS {
        requests.remove(0);
    }
    Ok(None)
}

fn complete_run_request(request_id: &str, routine_id: &str, thread_id: &str) {
    let mut requests = RUN_REQUESTS.lock().unwrap();
    if let Some(item) = requests.iter_mut().find(|item| item.id == request_id) {
        item.thread_id = Some(thread_id.to_string());
        return;
    }
    requests.push(RunRequest {
        id: request_id.to_string(),
        routine_id: routine_id.to_string(),
        thread_id: Some(thread_id.to_string()),
    });
}

fn release_run_request(request_id: &str) {
    let mut requests = RUN_REQUESTS.lock().unwrap();
    requests.retain(|item| !(item.id == request_id && item.thread_id.is_none()));
}

fn start_routine_run(agent_id: &str, routine_id: &str, expected: &str) -> RoutineResult<(String, String)> {
    let routine = {
        let list = routines().lock().unwrap();
        ensure_revision(&list, agent_id, expected)?;
        let found = list
            .iter()
            .find(|record| is_routine(record, agent_id, routine_id))
            .cloned();
        found.ok_or_else(not_found)?
    };
    let prompt = routine
        .get("prompt")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if prompt.is_empty() {
        return Err(invalid("Routine prompt is required."));
    }
    let name = routine
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("Routine")
        .to_string();
    let workspace = routine
        .get("workspaceId")
        .and_then(Value::as_str)
        .map(str::to_string);
    let engine = {
        let roster = agents().lock().unwrap();
        let found = roster
            .iter()
            .find(|agent| agent.id == agent_id)
            .map(|agent| agent.engine.clone());
        found.ok_or_else(agent_not_found)?
    };
    let provider = chat_provider_for_engine(&engine).ok_or_else(|| {
        RoutineCommandError::new(
            "routine_runtime_unavailable",
            "Routine runs are unavailable in this Kite Code build.",
        )
    })?;

    let thread = crate::chat::create_thread(
        Some(agent_id),
        &format!("Routine: {name}"),
        provider,
        workspace.as_deref(),
    );
    let thread_id = thread
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    crate::chat::configure_thread(&thread_id, &json!({ "provider": provider, "mode": "readOnly" }));
    let started = crate::chat::start_turn(&thread_id, Some(agent_id), &prompt, Vec::new(), Some(routine_id));
    let run_id = started
        .get("runId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if thread_id.is_empty() || run_id.is_empty() {
        return Err(RoutineCommandError::new(
            "routine_run_failed",
            "The routine could not start a chat run.",
        ));
    }

    let now = now_ms();
    {
        let mut list = routines().lock().unwrap();
        if let Some(record) = list
            .iter_mut()
            .find(|record| is_routine(record, agent_id, routine_id))
        {
            record["lastRunAtUnixMs"] = json!(now);
            record["lastRunThreadId"] = json!(thread_id);
            record["lastError"] = Value::Null;
            if record.get("enabled").and_then(Value::as_bool) == Some(true) {
                let next = next_run_after(&record["cadence"], now);
                record["nextRunAtUnixMs"] = json!(next);
            }
        }
    }
    persist();
    Ok((thread_id, run_id))
}

#[tauri::command]
pub fn list_routines(_request: Option<Value>) -> Value {
    routine_collection_snapshot()
}

#[tauri::command]
pub fn create_routine(request: Option<Value>) -> RoutineResult<Value> {
    let req = body(&request).ok_or_else(|| invalid("Routine request is required."))?;
    let agent_id = request_uuid(req, "agentId")?;
    let expected = request_revision(req)?;
    let draft = req
        .get("draft")
        .filter(|value| value.is_object())
        .ok_or_else(|| invalid("Routine draft is required."))?;
    let name = validate_text(
        draft.get("name").and_then(Value::as_str).unwrap_or(""),
        "Routine name",
        MAX_NAME_CHARS,
        MAX_NAME_BYTES,
        false,
    )?;
    let prompt = validate_text(
        draft.get("prompt").and_then(Value::as_str).unwrap_or(""),
        "Routine prompt",
        MAX_PROMPT_CHARS,
        MAX_PROMPT_BYTES,
        true,
    )?;
    let cadence = validate_cadence(draft.get("cadence"))?;
    let workspace = validate_workspace(draft.get("workspaceId"))?;
    if !agent_exists(&agent_id) {
        return Err(agent_not_found());
    }
    let now = now_ms();
    let record = json!({
        "id": Uuid::new_v4().to_string(),
        "agentId": agent_id,
        "name": name,
        "prompt": prompt,
        "cadence": cadence,
        "enabled": true,
        "author": "builder",
        "workspaceId": workspace,
        "createdAtUnixMs": now,
        "nextRunAtUnixMs": next_run_after(&cadence, now),
        "lastRunAtUnixMs": Value::Null,
        "lastRunThreadId": Value::Null,
        "lastError": Value::Null
    });
    {
        let mut list = routines().lock().unwrap();
        ensure_revision(&list, &agent_id, &expected)?;
        ensure_capacity(&list, &agent_id)?;
        ensure_name_free(&list, &agent_id, &name, None)?;
        list.push(record);
    }
    persist();
    Ok(routine_collection_snapshot())
}

#[tauri::command]
pub fn update_routine(request: Option<Value>) -> RoutineResult<Value> {
    let req = body(&request).ok_or_else(|| invalid("Routine request is required."))?;
    let agent_id = request_uuid(req, "agentId")?;
    let routine_id = request_uuid(req, "routineId")?;
    let expected = request_revision(req)?;
    let update = req
        .get("update")
        .filter(|value| value.is_object())
        .ok_or_else(|| invalid("Routine update is required."))?;
    let name = validate_text(
        update.get("name").and_then(Value::as_str).unwrap_or(""),
        "Routine name",
        MAX_NAME_CHARS,
        MAX_NAME_BYTES,
        false,
    )?;
    let prompt = validate_text(
        update.get("prompt").and_then(Value::as_str).unwrap_or(""),
        "Routine prompt",
        MAX_PROMPT_CHARS,
        MAX_PROMPT_BYTES,
        true,
    )?;
    let cadence = validate_cadence(update.get("cadence"))?;
    let workspace = validate_workspace(update.get("workspaceId"))?;
    {
        let mut list = routines().lock().unwrap();
        ensure_revision(&list, &agent_id, &expected)?;
        ensure_name_free(&list, &agent_id, &name, Some(routine_id.as_str()))?;
        let index = list
            .iter()
            .position(|record| is_routine(record, &agent_id, &routine_id))
            .ok_or_else(not_found)?;
        let now = now_ms();
        let record = &mut list[index];
        record["name"] = json!(name);
        record["prompt"] = json!(prompt);
        record["cadence"] = cadence.clone();
        record["workspaceId"] = workspace;
        if record.get("enabled").and_then(Value::as_bool) == Some(true) {
            record["nextRunAtUnixMs"] = json!(next_run_after(&cadence, now));
        }
    }
    persist();
    Ok(routine_collection_snapshot())
}

#[tauri::command]
pub fn delete_routine(request: Option<Value>) -> RoutineResult<Value> {
    let req = body(&request).ok_or_else(|| invalid("Routine request is required."))?;
    let agent_id = request_uuid(req, "agentId")?;
    let routine_id = request_uuid(req, "routineId")?;
    let expected = request_revision(req)?;
    {
        let mut list = routines().lock().unwrap();
        ensure_revision(&list, &agent_id, &expected)?;
        let before = list.len();
        list.retain(|record| !is_routine(record, &agent_id, &routine_id));
        if list.len() == before {
            return Err(not_found());
        }
    }
    persist();
    Ok(json!({
        "deleted": true,
        "snapshot": routine_collection_snapshot()
    }))
}

#[tauri::command]
pub fn run_routine_now(request: Option<Value>) -> RoutineResult<Value> {
    let req = body(&request).ok_or_else(|| invalid("Routine request is required."))?;
    let agent_id = request_uuid(req, "agentId")?;
    let routine_id = request_uuid(req, "routineId")?;
    let expected = request_revision(req)?;
    let request_id = request_uuid(req, "requestId")?;
    if request_id == NIL_UUID {
        return Err(invalid("The routine run request identifier is invalid."));
    }
    if let Some(thread_id) = reserve_run_request(&request_id, &routine_id)? {
        return Ok(json!({
            "started": false,
            "replayed": true,
            "threadId": thread_id,
            "runId": Value::Null,
            "snapshot": routine_collection_snapshot()
        }));
    }
    match start_routine_run(&agent_id, &routine_id, &expected) {
        Ok((thread_id, run_id)) => {
            complete_run_request(&request_id, &routine_id, &thread_id);
            Ok(json!({
                "started": true,
                "replayed": false,
                "threadId": thread_id,
                "runId": run_id,
                "snapshot": routine_collection_snapshot()
            }))
        }
        Err(error) => {
            release_run_request(&request_id);
            Err(error)
        }
    }
}

#[tauri::command]
pub fn set_routine_enabled(request: Option<Value>) -> RoutineResult<Value> {
    let req = body(&request).ok_or_else(|| invalid("Routine request is required."))?;
    let agent_id = request_uuid(req, "agentId")?;
    let routine_id = request_uuid(req, "routineId")?;
    let expected = request_revision(req)?;
    let enabled = req
        .get("enabled")
        .and_then(Value::as_bool)
        .ok_or_else(|| invalid(INVALID_REQUEST))?;
    {
        let mut list = routines().lock().unwrap();
        ensure_revision(&list, &agent_id, &expected)?;
        let index = list
            .iter()
            .position(|record| is_routine(record, &agent_id, &routine_id))
            .ok_or_else(not_found)?;
        let now = now_ms();
        let record = &mut list[index];
        record["enabled"] = json!(enabled);
        if enabled {
            let next = next_run_after(&record["cadence"], now);
            record["nextRunAtUnixMs"] = json!(next);
        }
    }
    persist();
    Ok(routine_collection_snapshot())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(id: &str, agent: &str, name: &str, author: Value) -> Value {
        json!({
            "id": id,
            "agentId": agent,
            "name": name,
            "prompt": "Check the build",
            "cadence": { "kind": "interval", "seconds": 3600 },
            "enabled": true,
            "author": author,
            "workspaceId": null,
            "createdAtUnixMs": 1000,
            "nextRunAtUnixMs": 3601000,
            "lastRunAtUnixMs": null,
            "lastRunThreadId": null,
            "lastError": null
        })
    }

    fn revision_of(snapshot: &Value, agent_id: &str) -> String {
        snapshot["agentRevisions"]
            .as_array()
            .expect("revisions")
            .iter()
            .find(|entry| entry["agentId"] == agent_id)
            .and_then(|entry| entry["revision"].as_str())
            .expect("revision for agent")
            .to_string()
    }

    #[test]
    fn text_validation_trims_and_rejects_empty_or_control_characters() {
        assert_eq!(validate_text("  Morning inbox  ", "Routine name", 160, 1024, false).unwrap(), "Morning inbox");
        assert!(validate_text("   ", "Routine name", 160, 1024, false).is_err());
        assert!(validate_text("bad\u{7}name", "Routine name", 160, 1024, false).is_err());
        assert!(validate_text("line one\nline two", "Routine name", 160, 1024, false).is_err());
        assert!(validate_text("line one\nline two", "Routine prompt", 64000, 262144, true).is_ok());
        assert!(validate_text(&"x".repeat(161), "Routine name", 160, 1024, false).is_err());
    }

    #[test]
    fn cadence_validation_enforces_interval_floor_and_clock_bounds() {
        let interval = |seconds: Value| json!({ "kind": "interval", "seconds": seconds });
        assert!(validate_cadence(Some(&interval(json!(899)))).is_err());
        assert!(validate_cadence(Some(&interval(json!(900)))).is_ok());
        assert!(validate_cadence(Some(&json!({ "kind": "interval", "seconds": 900, "extra": 1 }))).is_err());

        let clock = |hour: Value, minute: Value, weekdays: Value| {
            json!({ "kind": "clock", "hour": hour, "minute": minute, "weekdays": weekdays })
        };
        assert!(validate_cadence(Some(&clock(json!(9), json!(0), Value::Null))).is_ok());
        assert!(validate_cadence(Some(&clock(json!(9), json!(0), json!([2, 3, 4, 5, 6])))).is_ok());
        assert!(validate_cadence(Some(&clock(json!(24), json!(0), Value::Null))).is_err());
        assert!(validate_cadence(Some(&clock(json!(9), json!(60), Value::Null))).is_err());
        assert!(validate_cadence(Some(&clock(json!(9), json!(0), json!([3, 2])))).is_err());
        assert!(validate_cadence(Some(&clock(json!(9), json!(0), json!([2, 2])))).is_err());
        assert!(validate_cadence(Some(&clock(json!(9), json!(0), json!([])))).is_err());
        assert!(validate_cadence(Some(&json!({ "kind": "clock", "hour": 9, "minute": 0 }))).is_err());
    }

    #[test]
    fn next_run_uses_interval_offsets_and_utc_clock_slots() {
        let hourly = json!({ "kind": "interval", "seconds": 3600 });
        assert_eq!(next_run_after(&hourly, 1000), 1000 + 3_600_000);

        // 1970-01-01 (Thursday) 00:00 UTC is the epoch origin.
        let daily_nine = json!({ "kind": "clock", "hour": 9, "minute": 0, "weekdays": null });
        assert_eq!(next_run_after(&daily_nine, 0), 9 * MS_PER_HOUR);
        // From 09:00 on a Thursday, the next Thursday slot is seven days later.
        let thursday_nine = json!({ "kind": "clock", "hour": 9, "minute": 0, "weekdays": [5] });
        assert_eq!(next_run_after(&thursday_nine, 9 * MS_PER_HOUR), 7 * MS_PER_DAY + 9 * MS_PER_HOUR);
        // Sunday (1) is three days after the Thursday epoch origin.
        let sunday_nine = json!({ "kind": "clock", "hour": 9, "minute": 0, "weekdays": [1] });
        assert_eq!(next_run_after(&sunday_nine, 0), 3 * MS_PER_DAY + 9 * MS_PER_HOUR);
    }

    #[test]
    fn revision_is_stable_per_agent_content_and_ignores_legacy_author_shape() {
        let legacy = vec![record("r1", "agent-a", "Health", json!({ "kind": "user" }))];
        let current = vec![record("r1", "agent-a", "Health", json!("builder"))];
        let first = agent_revision(&legacy, "agent-a");
        assert_eq!(first.len(), 64);
        assert!(first.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
        assert_eq!(first, agent_revision(&current, "agent-a"));
        assert_ne!(first, agent_revision(&current, "agent-b"));

        let renamed = vec![record("r1", "agent-a", "Renamed", json!("builder"))];
        assert_ne!(first, agent_revision(&renamed, "agent-a"));
        assert_eq!(agent_revision(&[], "agent-a"), agent_revision(&[], "agent-a"));
    }

    #[test]
    fn legacy_author_objects_normalize_to_contract_values() {
        assert_eq!(normalize_record(&record("r", "a", "n", json!({ "kind": "agent" })))["author"], "agent");
        assert_eq!(normalize_record(&record("r", "a", "n", json!("agent")))["author"], "agent");
        assert_eq!(normalize_record(&record("r", "a", "n", json!({ "kind": "user" })))["author"], "builder");
    }

    #[test]
    fn only_chat_backed_engines_can_run_a_routine() {
        assert_eq!(chat_provider_for_engine("claude-code"), Some("claude"));
        assert_eq!(chat_provider_for_engine("open-code"), Some("opencode"));
        assert_eq!(chat_provider_for_engine("antigravity"), None);
        assert_eq!(chat_provider_for_engine("terminal"), None);
    }

    // Exercises the commands against the Studio store. It only runs when APPDATA points at an isolated
    // directory whose name contains "f5-routines-test", so it never writes to the user's real state.
    // It uses an engine without a chat provider, so no provider process is spawned.
    #[test]
    fn command_lifecycle_runs_against_isolated_store() {
        if !crate::persist::state_path().to_string_lossy().contains("f5-routines-test") {
            eprintln!("skipped: set APPDATA to an isolated directory containing 'f5-routines-test'");
            return;
        }
        let antigravity = "c3333333-3333-4333-8333-333333333333";
        let snapshot = list_routines(None);
        assert_eq!(snapshot["schemaVersion"], 1);
        let revision = revision_of(&snapshot, antigravity);

        let name = format!("F5 probe {}", Uuid::new_v4());
        let created = create_routine(Some(json!({
            "request": {
                "supportedSchemaVersion": 1,
                "agentId": antigravity,
                "expectedRevision": revision,
                "draft": {
                    "name": name,
                    "prompt": "Probe prompt",
                    "cadence": { "kind": "interval", "seconds": 3600 },
                    "workspaceId": null
                }
            }
        })))
        .expect("create should succeed");
        let created_routine = created["routines"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["name"] == name.as_str())
            .expect("created routine present")
            .clone();
        let routine_id = created_routine["id"].as_str().unwrap().to_string();
        assert_eq!(created_routine["enabled"], true);
        assert_eq!(created_routine["author"], "builder");

        let stale = create_routine(Some(json!({
            "request": {
                "agentId": antigravity,
                "expectedRevision": revision,
                "draft": { "name": "Stale", "prompt": "Stale", "cadence": { "kind": "interval", "seconds": 3600 }, "workspaceId": null }
            }
        })))
        .expect_err("stale revision must conflict");
        assert_eq!(stale.code, "routine_conflict");

        let fresh = revision_of(&created, antigravity);
        let updated = update_routine(Some(json!({
            "request": {
                "agentId": antigravity,
                "routineId": routine_id,
                "expectedRevision": fresh,
                "update": { "name": format!("{name} edited"), "prompt": "Probe prompt", "cadence": { "kind": "clock", "hour": 9, "minute": 0, "weekdays": null }, "workspaceId": null }
            }
        })))
        .expect("update should succeed");
        let edited = updated["routines"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == routine_id.as_str())
            .expect("updated routine present")
            .clone();
        assert_eq!(edited["name"], format!("{name} edited").as_str());

        let paused = set_routine_enabled(Some(json!({
            "request": {
                "agentId": antigravity,
                "routineId": routine_id,
                "expectedRevision": revision_of(&updated, antigravity),
                "enabled": false
            }
        })))
        .expect("toggle should succeed");
        let paused_routine = paused["routines"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == routine_id.as_str())
            .unwrap()
            .clone();
        assert_eq!(paused_routine["enabled"], false);

        let run_request = Uuid::new_v4().to_string();
        let run_error = run_routine_now(Some(json!({
            "request": {
                "agentId": antigravity,
                "routineId": routine_id,
                "expectedRevision": revision_of(&paused, antigravity),
                "requestId": run_request
            }
        })))
        .expect_err("antigravity has no chat provider");
        assert_eq!(run_error.code, "routine_runtime_unavailable");
        // A failed run releases its request id, so a retry is not reported as pending.
        let retry_error = run_routine_now(Some(json!({
            "request": {
                "agentId": antigravity,
                "routineId": routine_id,
                "expectedRevision": revision_of(&paused, antigravity),
                "requestId": run_request
            }
        })))
        .expect_err("retry still reports the missing provider");
        assert_eq!(retry_error.code, "routine_runtime_unavailable");

        let deleted = delete_routine(Some(json!({
            "request": {
                "agentId": antigravity,
                "routineId": routine_id,
                "expectedRevision": revision_of(&paused, antigravity)
            }
        })))
        .expect("delete should succeed");
        assert_eq!(deleted["deleted"], true);
        let gone = deleted["snapshot"]["routines"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["id"] != routine_id.as_str());
        assert!(gone);
    }
}
