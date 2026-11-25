use crate::persist::{agents, body, db_connection, notifications, persist, routines};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{hash_map::DefaultHasher, HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex, OnceLock,
};
use tauri::Emitter;
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
const DEFAULT_PERMISSION_MODE: &str = "readOnly";
const ROUTINE_TICK_INTERVAL_SECS: u64 = 20;

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
static IN_FLIGHT_ROUTINES: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
static LAST_EVENT_TRIGGER_MS: OnceLock<Mutex<HashMap<String, i64>>> = OnceLock::new();
static SCHEDULER_STARTED: AtomicBool = AtomicBool::new(false);

fn in_flight_routines() -> &'static Mutex<HashSet<String>> {
    IN_FLIGHT_ROUTINES.get_or_init(|| Mutex::new(HashSet::new()))
}

fn last_event_trigger_map() -> &'static Mutex<HashMap<String, i64>> {
    LAST_EVENT_TRIGGER_MS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub const SUPPORTED_EVENT_KINDS: [&str; 5] = [
    "on_git_commit",
    "on_branch_change",
    "on_task_state_change",
    "on_teammate_message",
    "on_routine_complete",
];

pub const SUPPORTED_OUTPUT_ACTIONS: [&str; 4] = [
    "notify_desktop",
    "announce_via_argos",
    "create_kite_task_on_findings",
    "notify_teammate",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RoutineRunRecord {
    pub run_id: String,
    pub routine_id: String,
    pub agent_id: String,
    pub trigger_kind: String,
    pub status: String,
    pub started_at_unix_ms: i64,
    pub finished_at_unix_ms: Option<i64>,
    pub thread_id: Option<String>,
    pub summary: Option<String>,
    pub changed_files_count: i64,
    pub retry_attempt: i64,
    pub error: Option<String>,
}

/// Zero-dependency 5-field UTC cron schedule (`min hour dom month dow`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CronSchedule {
    pub minutes: Vec<u32>,
    pub hours: Vec<u32>,
    pub days: Vec<u32>,
    pub months: Vec<u32>,
    pub weekdays: Vec<u32>,
}

fn parse_cron_field(field: &str, min: u32, max: u32, map_seven_to_zero: bool) -> RoutineResult<Vec<u32>> {
    let mut allowed = vec![false; (max + 2) as usize];
    for part in field.split(',') {
        let part = part.trim();
        if part.is_empty() {
            return Err(invalid("Cron expression contains an empty segment."));
        }
        let (range_str, step) = match part.split_once('/') {
            Some((r, s)) => {
                let step_val: u32 = s
                    .trim()
                    .parse()
                    .ok()
                    .filter(|v| *v >= 1)
                    .ok_or_else(|| invalid("Cron step must be >= 1."))?;
                (r.trim(), step_val)
            }
            None => (part, 1),
        };
        let (start, end) = if range_str == "*" {
            (min, max)
        } else if let Some((a, b)) = range_str.split_once('-') {
            let sa: u32 = a.trim().parse().map_err(|_| invalid("Invalid cron range start."))?;
            let sb: u32 = b.trim().parse().map_err(|_| invalid("Invalid cron range end."))?;
            let norm_a = if map_seven_to_zero && sa == 7 { 0 } else { sa };
            let norm_b = if map_seven_to_zero && sb == 7 { 6 } else { sb };
            if norm_a < min || norm_b > max || norm_a > norm_b {
                return Err(invalid("Cron range out of bounds."));
            }
            (norm_a, norm_b)
        } else {
            let single: u32 = range_str.parse().map_err(|_| invalid("Invalid cron number."))?;
            let norm = if map_seven_to_zero && single == 7 { 0 } else { single };
            if norm < min || norm > max {
                return Err(invalid("Cron value out of bounds."));
            }
            if part.contains('/') {
                (norm, max)
            } else {
                (norm, norm)
            }
        };
        let mut cur = start;
        while cur <= end {
            allowed[cur as usize] = true;
            cur = cur.saturating_add(step);
        }
    }
    let result: Vec<u32> = (min..=max).filter(|v| allowed[*v as usize]).collect();
    if result.is_empty() {
        return Err(invalid("Cron field matched no valid values."));
    }
    Ok(result)
}

pub fn parse_cron_expr(expr: &str) -> RoutineResult<CronSchedule> {
    let fields: Vec<&str> = expr.split_whitespace().collect();
    if fields.len() != 5 {
        return Err(invalid("Cron expression must have exactly 5 whitespace-separated fields."));
    }
    Ok(CronSchedule {
        minutes: parse_cron_field(fields[0], 0, 59, false)?,
        hours: parse_cron_field(fields[1], 0, 23, false)?,
        days: parse_cron_field(fields[2], 1, 31, false)?,
        months: parse_cron_field(fields[3], 1, 12, false)?,
        weekdays: parse_cron_field(fields[4], 0, 6, true)?,
    })
}

/// Converts days since 1970-01-01 to `(year, month 1..=12, day 1..=31)`.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let year = y + if m <= 2 { 1 } else { 0 };
    (year, m, d)
}

pub fn next_cron_after(expr: &str, from_ms: i64) -> i64 {
    let Ok(schedule) = parse_cron_expr(expr) else {
        return from_ms.saturating_add(MS_PER_HOUR);
    };
    let start_min_epoch = from_ms.div_euclid(MS_PER_MINUTE) + 1;
    let start_day = start_min_epoch.div_euclid(1440);
    for day_offset in 0..=400 {
        let day = start_day + day_offset;
        let (_year, month, dom) = civil_from_days(day);
        // 1970-01-01 was Thursday (dow=4)
        let dow = (day + 4).rem_euclid(7) as u32;
        if !schedule.months.contains(&month)
            || !schedule.days.contains(&dom)
            || !schedule.weekdays.contains(&dow)
        {
            continue;
        }
        for &hour in &schedule.hours {
            for &minute in &schedule.minutes {
                let candidate_min = day * 1440 + (hour as i64) * 60 + (minute as i64);
                if candidate_min >= start_min_epoch {
                    return candidate_min * MS_PER_MINUTE;
                }
            }
        }
    }
    from_ms.saturating_add(MS_PER_DAY)
}

pub fn retry_backoff_secs(attempt: u32) -> u64 {
    match attempt {
        0 => 0,
        1 => 15,
        2 => 60,
        _ => 240,
    }
}

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
        Some("cron") => {
            let expr = cadence
                .get("expr")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| invalid("Cron cadence requires non-empty 'expr'."))?;
            let _ = parse_cron_expr(expr)?;
            Ok(json!({ "kind": "cron", "expr": expr }))
        }
        Some("event") => {
            let event_kind = cadence
                .get("eventKind")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|k| SUPPORTED_EVENT_KINDS.contains(k))
                .ok_or_else(|| invalid("Routine eventKind is unsupported."))?;
            let debounce_secs = cadence
                .get("debounceSecs")
                .and_then(Value::as_u64)
                .unwrap_or(30)
                .min(86_400);
            let source_routine_id = cadence
                .get("sourceRoutineId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty());
            let mut out = json!({
                "kind": "event",
                "eventKind": event_kind,
                "debounceSecs": debounce_secs,
            });
            if let Some(src) = source_routine_id {
                out["sourceRoutineId"] = json!(src);
            }
            Ok(out)
        }
        _ => Err(invalid("Routine cadence is invalid.")),
    }
}

fn validate_output_actions(value: Option<&Value>) -> RoutineResult<Vec<String>> {
    match value {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(arr)) => {
            let mut out = Vec::new();
            for item in arr {
                let Some(act) = item.as_str().map(str::trim) else {
                    return Err(invalid("Routine outputActions entries must be strings."));
                };
                if !SUPPORTED_OUTPUT_ACTIONS.contains(&act) {
                    return Err(invalid("Routine outputAction is unsupported."));
                }
                if !out.iter().any(|existing: &String| existing == act) {
                    out.push(act.to_string());
                }
            }
            Ok(out)
        }
        Some(_) => Err(invalid("Routine outputActions must be an array.")),
    }
}

fn validate_max_retries(value: Option<&Value>) -> RoutineResult<u64> {
    match value {
        None | Some(Value::Null) => Ok(0),
        Some(v) => match v.as_u64() {
            Some(n) if n <= 3 => Ok(n),
            _ => Err(invalid("Routine maxRetries must be between 0 and 3.")),
        },
    }
}

fn validate_workspace(value: Option<&Value>) -> RoutineResult<Value> {
    match value {
        None | Some(Value::Null) => Ok(Value::Null),
        Some(Value::String(id)) if is_uuid(id) => Ok(json!(id)),
        Some(_) => Err(invalid("Routine workspace is invalid.")),
    }
}

fn validate_permission_mode(value: Option<&Value>) -> RoutineResult<String> {
    match value {
        None | Some(Value::Null) => Ok(DEFAULT_PERMISSION_MODE.to_string()),
        Some(Value::String(mode)) if matches!(mode.as_str(), "readOnly" | "auto" | "fullAccess") => {
            Ok(mode.clone())
        }
        Some(_) => Err(invalid("Routine permission mode is invalid.")),
    }
}

// Older records stored `author` as `{ "kind": "user" }`; the UI contract is "builder" | "agent".
fn normalize_record(record: &Value) -> Value {
    let agent_authored = match record.get("author") {
        Some(Value::String(kind)) => kind == "agent",
        Some(Value::Object(object)) => object.get("kind").and_then(Value::as_str) == Some("agent"),
        _ => false,
    };
    let permission_mode = validate_permission_mode(record.get("permissionMode"))
        .unwrap_or_else(|_| DEFAULT_PERMISSION_MODE.to_string());
    let mut normalized = record.clone();
    if let Some(object) = normalized.as_object_mut() {
        object.insert(
            "author".to_string(),
            json!(if agent_authored { "agent" } else { "builder" }),
        );
        object.insert("permissionMode".to_string(), json!(permission_mode));
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

// Next scheduled time. Clock/cron cadences are evaluated in UTC: Studio has no local-calendar dependency.
fn next_run_after(cadence: &Value, from_ms: i64) -> i64 {
    match cadence.get("kind").and_then(Value::as_str) {
        Some("interval") => {
            let seconds = cadence.get("seconds").and_then(Value::as_f64).unwrap_or(3600.0);
            return from_ms.saturating_add((seconds * 1000.0).round() as i64);
        }
        Some("cron") => {
            let expr = cadence
                .get("expr")
                .and_then(Value::as_str)
                .unwrap_or("0 * * * *");
            return next_cron_after(expr, from_ms);
        }
        Some("event") => {
            return from_ms.saturating_add(MS_PER_DAY * 365);
        }
        _ => {}
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

// Map all 7 supported agent engines (and aliases) onto their chat provider.
fn chat_provider_for_engine(engine: &str) -> Option<&'static str> {
    match engine.trim().to_ascii_lowercase().as_str() {
        "claude" | "claude-code" => Some("claude"),
        "codex" => Some("codex"),
        "cursor" | "cursor-agent" => Some("cursor"),
        "grok" => Some("grok"),
        "opencode" | "open-code" => Some("opencode"),
        "antigravity" | "agy" => Some("antigravity"),
        "gemini" => Some("gemini"),
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

fn execute_routine_record(
    agent_id: &str,
    routine_id: &str,
    routine: &Value,
) -> RoutineResult<(String, String)> {
    execute_routine_record_with_meta(agent_id, routine_id, routine, "schedule", 0)
}

fn execute_routine_record_with_meta(
    agent_id: &str,
    routine_id: &str,
    routine: &Value,
    trigger_kind: &str,
    retry_attempt: i64,
) -> RoutineResult<(String, String)> {
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
    let permission_mode = validate_permission_mode(routine.get("permissionMode"))
        .unwrap_or_else(|_| DEFAULT_PERMISSION_MODE.to_string());
    let engine = {
        let roster = agents().lock().unwrap();
        let found = roster
            .iter()
            .find(|agent| agent.id == agent_id)
            .map(|agent| agent.engine.clone());
        found.ok_or_else(agent_not_found)?
    };
    let provider = match chat_provider_for_engine(&engine) {
        Some(p) => p,
        None => {
            let err = RoutineCommandError::new(
                "routine_runtime_unavailable",
                "Routine runs are unavailable in this Kite Code build.",
            );
            let now = now_ms();
            let _ = record_routine_run(&RoutineRunRecord {
                run_id: Uuid::new_v4().to_string(),
                routine_id: routine_id.to_string(),
                agent_id: agent_id.to_string(),
                trigger_kind: trigger_kind.to_string(),
                status: "failed".to_string(),
                started_at_unix_ms: now,
                finished_at_unix_ms: Some(now),
                thread_id: None,
                summary: Some(format!("Routine '{name}' skipped: provider runtime unavailable.")),
                changed_files_count: 0,
                retry_attempt,
                error: Some(err.message.clone()),
            });
            return Err(err);
        }
    };

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
    crate::chat::configure_thread(
        &thread_id,
        &json!({ "provider": provider, "mode": permission_mode }),
    );
    let started = crate::chat::start_turn(&thread_id, Some(agent_id), &prompt, Vec::new(), Some(routine_id));
    let run_id = started
        .get("runId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let now = now_ms();
    if thread_id.is_empty() || run_id.is_empty() {
        let _ = record_routine_run(&RoutineRunRecord {
            run_id: Uuid::new_v4().to_string(),
            routine_id: routine_id.to_string(),
            agent_id: agent_id.to_string(),
            trigger_kind: trigger_kind.to_string(),
            status: "failed".to_string(),
            started_at_unix_ms: now,
            finished_at_unix_ms: Some(now),
            thread_id: None,
            summary: Some(format!("Routine '{name}' could not start chat turn.")),
            changed_files_count: 0,
            retry_attempt,
            error: Some("The routine could not start a chat run.".to_string()),
        });
        return Err(RoutineCommandError::new(
            "routine_run_failed",
            "The routine could not start a chat run.",
        ));
    }

    let _ = record_routine_run(&RoutineRunRecord {
        run_id: run_id.clone(),
        routine_id: routine_id.to_string(),
        agent_id: agent_id.to_string(),
        trigger_kind: trigger_kind.to_string(),
        status: "succeeded".to_string(),
        started_at_unix_ms: now,
        finished_at_unix_ms: Some(now),
        thread_id: Some(thread_id.clone()),
        summary: Some(format!("Routine '{name}' triggered on {trigger_kind}.")),
        changed_files_count: 0,
        retry_attempt,
        error: None,
    });

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
    dispatch_output_actions(
        agent_id,
        routine_id,
        routine,
        Some(&thread_id),
        &format!("Routine '{name}' started thread {thread_id} ({trigger_kind})."),
        false,
        0,
    );
    Ok((thread_id, run_id))
}

pub fn record_routine_run_in_conn(
    conn: &rusqlite::Connection,
    run: &RoutineRunRecord,
) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO routine_runs (
            run_id, routine_id, agent_id, trigger_kind, status,
            started_at_unix_ms, finished_at_unix_ms, thread_id,
            summary, changed_files_count, retry_attempt, error
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        rusqlite::params![
            run.run_id,
            run.routine_id,
            run.agent_id,
            run.trigger_kind,
            run.status,
            run.started_at_unix_ms,
            run.finished_at_unix_ms,
            run.thread_id,
            run.summary,
            run.changed_files_count,
            run.retry_attempt,
            run.error,
        ],
    )
    .map(|_| ())
    .map_err(|e| format!("Failed to persist routine_runs record: {e}"))
}

pub fn record_routine_run(run: &RoutineRunRecord) -> Result<(), String> {
    let conn = db_connection().lock().map_err(|_| "DB lock poisoned".to_string())?;
    record_routine_run_in_conn(&conn, run)
}

pub fn list_routine_runs_in_conn(
    conn: &rusqlite::Connection,
    routine_id: Option<&str>,
    agent_id: Option<&str>,
    limit: usize,
) -> Result<Vec<RoutineRunRecord>, String> {
    let capped = limit.clamp(1, 200) as i64;
    let (sql, p1, p2): (&str, Option<String>, Option<String>) = match (routine_id, agent_id) {
        (Some(rid), Some(aid)) => (
            "SELECT run_id, routine_id, agent_id, trigger_kind, status, started_at_unix_ms, finished_at_unix_ms, thread_id, summary, changed_files_count, retry_attempt, error FROM routine_runs WHERE routine_id = ?1 AND agent_id = ?2 ORDER BY started_at_unix_ms DESC LIMIT ?3",
            Some(rid.to_string()),
            Some(aid.to_string()),
        ),
        (Some(rid), None) => (
            "SELECT run_id, routine_id, agent_id, trigger_kind, status, started_at_unix_ms, finished_at_unix_ms, thread_id, summary, changed_files_count, retry_attempt, error FROM routine_runs WHERE routine_id = ?1 ORDER BY started_at_unix_ms DESC LIMIT ?2",
            Some(rid.to_string()),
            None,
        ),
        (None, Some(aid)) => (
            "SELECT run_id, routine_id, agent_id, trigger_kind, status, started_at_unix_ms, finished_at_unix_ms, thread_id, summary, changed_files_count, retry_attempt, error FROM routine_runs WHERE agent_id = ?1 ORDER BY started_at_unix_ms DESC LIMIT ?2",
            None,
            Some(aid.to_string()),
        ),
        (None, None) => (
            "SELECT run_id, routine_id, agent_id, trigger_kind, status, started_at_unix_ms, finished_at_unix_ms, thread_id, summary, changed_files_count, retry_attempt, error FROM routine_runs ORDER BY started_at_unix_ms DESC LIMIT ?1",
            None,
            None,
        ),
    };
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let mapper = |row: &rusqlite::Row<'_>| -> rusqlite::Result<RoutineRunRecord> {
        Ok(RoutineRunRecord {
            run_id: row.get(0)?,
            routine_id: row.get(1)?,
            agent_id: row.get(2)?,
            trigger_kind: row.get(3)?,
            status: row.get(4)?,
            started_at_unix_ms: row.get(5)?,
            finished_at_unix_ms: row.get(6)?,
            thread_id: row.get(7)?,
            summary: row.get(8)?,
            changed_files_count: row.get(9)?,
            retry_attempt: row.get(10)?,
            error: row.get(11)?,
        })
    };
    let rows = match (p1, p2) {
        (Some(a), Some(b)) => stmt.query_map(rusqlite::params![a, b, capped], mapper),
        (Some(a), None) => stmt.query_map(rusqlite::params![a, capped], mapper),
        (None, Some(b)) => stmt.query_map(rusqlite::params![b, capped], mapper),
        (None, None) => stmt.query_map(rusqlite::params![capped], mapper),
    }
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
pub fn list_routine_runs(request: Option<Value>) -> RoutineResult<Value> {
    let req = body(&request);
    let routine_id = req.and_then(|r| r.get("routineId")).and_then(Value::as_str);
    let agent_id = req.and_then(|r| r.get("agentId")).and_then(Value::as_str);
    let limit = req
        .and_then(|r| r.get("limit"))
        .and_then(Value::as_u64)
        .unwrap_or(50) as usize;
    let conn = db_connection()
        .lock()
        .map_err(|_| invalid("Database lock unavailable."))?;
    let runs = list_routine_runs_in_conn(&conn, routine_id, agent_id, limit).map_err(|e| invalid(&e))?;
    Ok(json!({ "runs": runs }))
}

pub fn dispatch_output_actions(
    agent_id: &str,
    routine_id: &str,
    routine: &Value,
    thread_id: Option<&str>,
    summary: &str,
    failed: bool,
    chain_depth: u8,
) {
    let actions: Vec<String> = routine
        .get("outputActions")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default();
    let routine_name = routine
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("Routine");

    for action in &actions {
        match action.as_str() {
            "notify_desktop" => {
                if let Ok(mut list) = notifications().lock() {
                    list.insert(
                        0,
                        json!({
                            "id": Uuid::new_v4().to_string(),
                            "title": format!("Routine: {routine_name}"),
                            "body": summary,
                            "agentId": agent_id,
                            "routineId": routine_id,
                            "threadId": thread_id,
                            "createdAtUnixMs": now_ms(),
                            "isRead": false,
                            "isWaitingForInput": false,
                        }),
                    );
                }
                persist();
            }
            "announce_via_argos" => {
                if let Some(app) = crate::get_app_handle() {
                    let _ = app.emit(
                        "kite:agent-announce",
                        json!({
                            "source": "routine",
                            "agentId": agent_id,
                            "routineId": routine_id,
                            "routineName": routine_name,
                            "threadId": thread_id,
                            "summary": summary,
                            "failed": failed,
                        }),
                    );
                }
            }
            "create_kite_task_on_findings" => {
                if failed || !summary.trim().is_empty() {
                    let _ = crate::tickets::ticket_call(Some(json!({
                        "tool": "save_issue",
                        "title": format!("[Routine] {routine_name}"),
                        "description": summary,
                        "state": "Todo",
                        "priority": if failed { "high" } else { "medium" },
                        "labels": ["routine-finding"],
                        "sourceAgent": agent_id,
                        "sourceThreadId": thread_id,
                    })));
                }
            }
            "notify_teammate" => {
                if let Some(target_id) = routine
                    .get("notifyTeammateId")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    let _ = crate::dispatch_wire::send_agent(
                        target_id,
                        summary,
                        agent_id,
                        routine_name,
                        None,
                    );
                }
            }
            _ => {}
        }
    }

    if !failed && chain_depth < 3 {
        let _ = dispatch_routine_event_internal(
            "on_routine_complete",
            &json!({
                "sourceRoutineId": routine_id,
                "agentId": agent_id,
                "threadId": thread_id,
                "summary": summary,
            }),
            now_ms(),
            chain_depth + 1,
        );
    }
}

pub fn dispatch_routine_event_internal(
    event_kind: &str,
    payload: &Value,
    now: i64,
    chain_depth: u8,
) -> RoutineResult<Value> {
    if !SUPPORTED_EVENT_KINDS.contains(&event_kind) {
        return Err(invalid("Unsupported routine eventKind."));
    }
    let source_routine_filter = payload.get("sourceRoutineId").and_then(Value::as_str);
    let candidates: Vec<(String, String, Value, u64)> = {
        let list = routines().lock().unwrap();
        list.iter()
            .filter_map(|rec| {
                if rec.get("enabled").and_then(Value::as_bool) != Some(true) {
                    return None;
                }
                let cad = rec.get("cadence")?;
                if cad.get("kind").and_then(Value::as_str) != Some("event") {
                    return None;
                }
                if cad.get("eventKind").and_then(Value::as_str) != Some(event_kind) {
                    return None;
                }
                if let Some(req_src) = cad.get("sourceRoutineId").and_then(Value::as_str) {
                    if source_routine_filter != Some(req_src) {
                        return None;
                    }
                }
                let aid = rec.get("agentId").and_then(Value::as_str)?.to_string();
                let rid = rec.get("id").and_then(Value::as_str)?.to_string();
                if !agent_allows_scheduling(&aid) || is_routine_currently_running(rec) {
                    return None;
                }
                let debounce = cad.get("debounceSecs").and_then(Value::as_u64).unwrap_or(30);
                Some((aid, rid, rec.clone(), debounce))
            })
            .collect()
    };

    let mut triggered = Vec::new();
    let mut skipped = Vec::new();

    for (agent_id, routine_id, record, debounce_secs) in candidates {
        let debounced = {
            let mut map = last_event_trigger_map().lock().unwrap();
            let cooldown_ms = (debounce_secs as i64).saturating_mul(1000);
            if let Some(prev_ms) = map.get(&routine_id) {
                if cooldown_ms > 0 && now.saturating_sub(*prev_ms) < cooldown_ms {
                    true
                } else {
                    map.insert(routine_id.clone(), now);
                    false
                }
            } else {
                map.insert(routine_id.clone(), now);
                false
            }
        };

        if debounced {
            let _ = record_routine_run(&RoutineRunRecord {
                run_id: Uuid::new_v4().to_string(),
                routine_id: routine_id.clone(),
                agent_id: agent_id.clone(),
                trigger_kind: event_kind.to_string(),
                status: "skipped".to_string(),
                started_at_unix_ms: now,
                finished_at_unix_ms: Some(now),
                thread_id: None,
                summary: Some("Debounced within cooldown window.".to_string()),
                changed_files_count: 0,
                retry_attempt: 0,
                error: None,
            });
            skipped.push(routine_id);
            continue;
        }

        let max_retries = record
            .get("maxRetries")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .min(3);
        let mut last_err = None;
        let mut succeeded_thread = None;
        for attempt in 0..=max_retries {
            match execute_routine_record_with_meta(
                &agent_id,
                &routine_id,
                &record,
                event_kind,
                attempt as i64,
            ) {
                Ok((tid, _)) => {
                    succeeded_thread = Some(tid);
                    last_err = None;
                    break;
                }
                Err(err) => {
                    last_err = Some(err);
                    // Only sleep backoff between retries for transient errors outside runtime_unavailable
                    if attempt < max_retries && last_err.as_ref().map(|e| e.code.as_str()) != Some("routine_runtime_unavailable") {
                        let _delay = retry_backoff_secs((attempt + 1) as u32);
                    } else {
                        break;
                    }
                }
            }
        }
        if let Some(tid) = succeeded_thread {
            let _ = chain_depth;
            triggered.push(json!({ "routineId": routine_id, "threadId": tid }));
        } else if let Some(err) = last_err {
            dispatch_output_actions(
                &agent_id,
                &routine_id,
                &record,
                None,
                &err.message,
                true,
                chain_depth,
            );
            skipped.push(routine_id);
        }
    }

    Ok(json!({
        "eventKind": event_kind,
        "triggered": triggered,
        "skipped": skipped,
    }))
}

#[tauri::command]
pub fn dispatch_routine_event(request: Option<Value>) -> RoutineResult<Value> {
    let req = body(&request).ok_or_else(|| invalid("Event dispatch request is required."))?;
    let event_kind = req
        .get("eventKind")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    let payload = req.get("payload").cloned().unwrap_or_else(|| json!({}));
    dispatch_routine_event_internal(event_kind, &payload, now_ms(), 0)
}

pub fn active_routine_agent_ids() -> HashSet<String> {
    let mut out = HashSet::new();
    let active_ids: HashSet<String> = in_flight_routines()
        .lock()
        .map(|s| s.clone())
        .unwrap_or_default();
    if let Ok(list) = routines().lock() {
        for rec in list.iter() {
            let Some(rid) = rec.get("id").and_then(Value::as_str) else {
                continue;
            };
            let Some(aid) = rec.get("agentId").and_then(Value::as_str) else {
                continue;
            };
            if active_ids.contains(rid)
                || rec
                    .get("lastRunThreadId")
                    .and_then(Value::as_str)
                    .is_some_and(crate::chat::is_turn_running)
            {
                out.insert(aid.to_string());
            }
        }
    }
    out
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
    execute_routine_record(agent_id, routine_id, &routine)
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
    let permission_mode = validate_permission_mode(draft.get("permissionMode"))?;
    let max_retries = validate_max_retries(draft.get("maxRetries"))?;
    let output_actions = validate_output_actions(draft.get("outputActions"))?;
    let trigger_type = draft
        .get("triggerType")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| match cadence.get("kind").and_then(Value::as_str) {
            Some("event") => "event".to_string(),
            Some("cron") => "cron".to_string(),
            _ => "schedule".to_string(),
        });
    let notify_teammate_id = draft
        .get("notifyTeammateId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| json!(s))
        .unwrap_or(Value::Null);
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
        "triggerType": trigger_type,
        "maxRetries": max_retries,
        "outputActions": output_actions,
        "notifyTeammateId": notify_teammate_id,
        "enabled": true,
        "author": "builder",
        "workspaceId": workspace,
        "permissionMode": permission_mode,
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
    let next_permission_mode = if update.get("permissionMode").is_some() {
        Some(validate_permission_mode(update.get("permissionMode"))?)
    } else {
        None
    };
    let next_max_retries = if update.get("maxRetries").is_some() {
        Some(validate_max_retries(update.get("maxRetries"))?)
    } else {
        None
    };
    let next_output_actions = if update.get("outputActions").is_some() {
        Some(validate_output_actions(update.get("outputActions"))?)
    } else {
        None
    };
    let next_trigger_type = update
        .get("triggerType")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string);
    let next_teammate_id = update
        .get("notifyTeammateId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string);
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
        if let Some(mode) = next_permission_mode {
            record["permissionMode"] = json!(mode);
        }
        if let Some(retries) = next_max_retries {
            record["maxRetries"] = json!(retries);
        }
        if let Some(actions) = next_output_actions {
            record["outputActions"] = json!(actions);
        }
        if let Some(tt) = next_trigger_type {
            record["triggerType"] = json!(tt);
        }
        if let Some(tm) = next_teammate_id {
            record["notifyTeammateId"] = json!(tm);
        }
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

fn agent_allows_scheduling(agent_id: &str) -> bool {
    let roster = agents().lock().unwrap();
    let Some(agent) = roster.iter().find(|agent| agent.id == agent_id) else {
        return false;
    };
    agent.allow_agent_scheduling != Some(false)
}

fn is_routine_currently_running(record: &Value) -> bool {
    let Some(routine_id) = record.get("id").and_then(Value::as_str) else {
        return false;
    };
    if in_flight_routines()
        .lock()
        .map(|set| set.contains(routine_id))
        .unwrap_or(false)
    {
        return true;
    }
    if let Some(thread_id) = record.get("lastRunThreadId").and_then(Value::as_str) {
        if crate::chat::is_turn_running(thread_id) {
            return true;
        }
    }
    false
}

fn select_and_advance_due_routines<F, G>(
    list: &mut [Value],
    now: i64,
    allows_scheduling: F,
    is_running: G,
) -> Vec<(String, String)>
where
    F: Fn(&str) -> bool,
    G: Fn(&Value) -> bool,
{
    let mut due = Vec::new();
    for record in list.iter_mut() {
        if record.get("enabled").and_then(Value::as_bool) != Some(true) {
            continue;
        }
        if record
            .get("cadence")
            .and_then(|c| c.get("kind"))
            .and_then(Value::as_str)
            == Some("event")
        {
            continue;
        }
        let Some(next_at) = record.get("nextRunAtUnixMs").and_then(Value::as_i64) else {
            continue;
        };
        if next_at > now {
            continue;
        }
        let Some(agent_id) = record.get("agentId").and_then(Value::as_str).map(str::to_string) else {
            continue;
        };
        let Some(routine_id) = record.get("id").and_then(Value::as_str).map(str::to_string) else {
            continue;
        };
        if !allows_scheduling(&agent_id) || is_running(record) {
            continue;
        }
        // Missed-run guard: advance strictly into the future so overdue routines never fire catch-up bursts.
        let mut next = next_run_after(&record["cadence"], now);
        if next <= now {
            next = now.saturating_add(MS_PER_MINUTE);
        }
        record["nextRunAtUnixMs"] = json!(next);
        due.push((agent_id, routine_id));
    }
    due
}

pub fn tick_due_routines_at(now: i64) -> usize {
    let due: Vec<(String, String, Value)> = {
        let mut list = routines().lock().unwrap();
        let selected = select_and_advance_due_routines(
            &mut list,
            now,
            agent_allows_scheduling,
            is_routine_currently_running,
        );
        if selected.is_empty() {
            return 0;
        }
        let mut pairs = Vec::with_capacity(selected.len());
        if let Ok(mut in_flight) = in_flight_routines().lock() {
            for (agent_id, routine_id) in selected {
                if !in_flight.insert(routine_id.clone()) {
                    continue;
                }
                if let Some(record) = list
                    .iter()
                    .find(|record| is_routine(record, &agent_id, &routine_id))
                    .cloned()
                {
                    pairs.push((agent_id, routine_id, record));
                } else {
                    in_flight.remove(&routine_id);
                }
            }
        }
        pairs
    };

    if due.is_empty() {
        return 0;
    }
    persist();

    let mut triggered = 0usize;
    for (agent_id, routine_id, record) in due {
        let outcome = execute_routine_record(&agent_id, &routine_id, &record);
        if let Ok(mut in_flight) = in_flight_routines().lock() {
            in_flight.remove(&routine_id);
        }
        match outcome {
            Ok(_) => {
                triggered += 1;
            }
            Err(err) => {
                {
                    let mut list = routines().lock().unwrap();
                    if let Some(item) = list
                        .iter_mut()
                        .find(|item| is_routine(item, &agent_id, &routine_id))
                    {
                        item["lastError"] = json!(err.message);
                    }
                }
                persist();
            }
        }
    }
    triggered
}

pub fn start_routine_scheduler() {
    if SCHEDULER_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(
            ROUTINE_TICK_INTERVAL_SECS,
        ));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        // Skip the immediate startup tick so initial state loading finishes before evaluating due routines.
        interval.tick().await;
        loop {
            interval.tick().await;
            let now = now_ms();
            let _ = tokio::task::spawn_blocking(move || tick_due_routines_at(now)).await;
        }
    });
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
        assert_eq!(chat_provider_for_engine("claude"), Some("claude"));
        assert_eq!(chat_provider_for_engine("claude-code"), Some("claude"));
        assert_eq!(chat_provider_for_engine("codex"), Some("codex"));
        assert_eq!(chat_provider_for_engine("cursor"), Some("cursor"));
        assert_eq!(chat_provider_for_engine("cursor-agent"), Some("cursor"));
        assert_eq!(chat_provider_for_engine("grok"), Some("grok"));
        assert_eq!(chat_provider_for_engine("opencode"), Some("opencode"));
        assert_eq!(chat_provider_for_engine("open-code"), Some("opencode"));
        assert_eq!(chat_provider_for_engine("antigravity"), Some("antigravity"));
        assert_eq!(chat_provider_for_engine("agy"), Some("antigravity"));
        assert_eq!(chat_provider_for_engine("gemini"), Some("gemini"));
        assert_eq!(chat_provider_for_engine("terminal"), None);
        assert_eq!(chat_provider_for_engine("powershell"), None);
    }

    #[test]
    fn permission_mode_validation_defaults_to_read_only_and_rejects_invalid() {
        assert_eq!(validate_permission_mode(None).unwrap(), "readOnly");
        assert_eq!(validate_permission_mode(Some(&Value::Null)).unwrap(), "readOnly");
        assert_eq!(validate_permission_mode(Some(&json!("readOnly"))).unwrap(), "readOnly");
        assert_eq!(validate_permission_mode(Some(&json!("auto"))).unwrap(), "auto");
        assert_eq!(validate_permission_mode(Some(&json!("fullAccess"))).unwrap(), "fullAccess");
        assert!(validate_permission_mode(Some(&json!("invalidMode"))).is_err());
    }

    #[test]
    fn routine_scheduler_tick_respects_due_enabled_overlapping_and_scheduling_permission() {
        let agent_ok = "11111111-1111-4111-8111-111111111111";
        let agent_blocked = "22222222-2222-4222-8222-222222222222";
        let now = 10_000_000i64;

        let mut list = vec![
            json!({
                "id": "r-due",
                "agentId": agent_ok,
                "name": "Due",
                "prompt": "Run check",
                "cadence": { "kind": "interval", "seconds": 900 },
                "enabled": true,
                "nextRunAtUnixMs": now - 5_000_000,
                "permissionMode": "auto"
            }),
            json!({
                "id": "r-disabled",
                "agentId": agent_ok,
                "name": "Disabled",
                "prompt": "Skip",
                "cadence": { "kind": "interval", "seconds": 900 },
                "enabled": false,
                "nextRunAtUnixMs": now - 1000
            }),
            json!({
                "id": "r-future",
                "agentId": agent_ok,
                "name": "Future",
                "prompt": "Skip",
                "cadence": { "kind": "interval", "seconds": 900 },
                "enabled": true,
                "nextRunAtUnixMs": now + 60_000
            }),
            json!({
                "id": "r-disallowed",
                "agentId": agent_blocked,
                "name": "Disallowed",
                "prompt": "Skip",
                "cadence": { "kind": "interval", "seconds": 900 },
                "enabled": true,
                "nextRunAtUnixMs": now - 1000
            }),
        ];

        let allowed_fn = |id: &str| id != agent_blocked;
        let running_fn = |record: &Value| record.get("id").and_then(Value::as_str) == Some("r-running");
        let due = select_and_advance_due_routines(&mut list, now, allowed_fn, running_fn);
        assert_eq!(due, vec![(agent_ok.to_string(), "r-due".to_string())]);
        let next_due = list[0]["nextRunAtUnixMs"].as_i64().unwrap();
        assert!(next_due > now, "overdue routine must advance into the future");
        assert_eq!(next_due, now + 900_000);

        // Running again at the same `now` must not re-fire (no catch-up burst).
        let due_again = select_and_advance_due_routines(&mut list, now, allowed_fn, running_fn);
        assert!(due_again.is_empty());
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

    #[test]
    fn cron_parser_evaluates_5_field_utc_schedules() {
        let sched = parse_cron_expr("15 9 * * 1-5").expect("valid weekday 9:15 cron");
        assert_eq!(sched.minutes, vec![15]);
        assert_eq!(sched.hours, vec![9]);
        assert_eq!(sched.weekdays, vec![1, 2, 3, 4, 5]);
        assert!(parse_cron_expr("invalid cron").is_err());

        // 2026-01-02 09:00:00 UTC (Friday -> dow=5)
        let friday_0900 = 1_767_344_400_000i64;
        let next = next_cron_after("15 9 * * 1-5", friday_0900);
        assert_eq!(next, friday_0900 + 15 * 60_000);

        // Next at */30 minutes
        let next_half = next_cron_after("*/30 * * * *", friday_0900);
        assert_eq!(next_half, friday_0900 + 30 * 60_000);
    }

    #[test]
    fn routine_runs_sqlite_persistence_debounce_and_backoff_work() {
        assert_eq!(retry_backoff_secs(0), 0);
        assert_eq!(retry_backoff_secs(1), 15);
        assert_eq!(retry_backoff_secs(2), 60);
        assert_eq!(retry_backoff_secs(3), 240);

        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE routine_runs (
                run_id TEXT PRIMARY KEY,
                routine_id TEXT NOT NULL,
                agent_id TEXT NOT NULL,
                trigger_kind TEXT NOT NULL,
                status TEXT NOT NULL,
                started_at_unix_ms INTEGER NOT NULL,
                finished_at_unix_ms INTEGER,
                thread_id TEXT,
                summary TEXT,
                changed_files_count INTEGER NOT NULL DEFAULT 0,
                retry_attempt INTEGER NOT NULL DEFAULT 0,
                error TEXT
            );",
        )
        .unwrap();

        let rec = RoutineRunRecord {
            run_id: "run-1".into(),
            routine_id: "r-1".into(),
            agent_id: "a-1".into(),
            trigger_kind: "on_git_commit".into(),
            status: "succeeded".into(),
            started_at_unix_ms: 1000,
            finished_at_unix_ms: Some(2000),
            thread_id: Some("thread-1".into()),
            summary: Some("Checked commit".into()),
            changed_files_count: 3,
            retry_attempt: 1,
            error: None,
        };
        record_routine_run_in_conn(&conn, &rec).unwrap();
        let listed = list_routine_runs_in_conn(&conn, Some("r-1"), None, 10).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0], rec);

        // Validate cron and event cadences in validate_cadence
        assert!(validate_cadence(Some(&json!({ "kind": "cron", "expr": "0 */2 * * *" }))).is_ok());
        assert!(validate_cadence(Some(&json!({
            "kind": "event",
            "eventKind": "on_git_commit",
            "debounceSecs": 45
        })))
        .is_ok());
        assert!(validate_cadence(Some(&json!({
            "kind": "event",
            "eventKind": "unsupported_event"
        })))
        .is_err());
    }
}
