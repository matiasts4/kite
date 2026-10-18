use crate::persist::body;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const LOCAL_SUMMARY: &str =
    "Local run record stored. No external agent ran, and no verification was reported.";
const STOP_SUMMARY: &str = "Stopped locally. No external agent was running.";
#[cfg(test)]
const VIEW_KEYS: &[&str] = &[
    "id",
    "taskId",
    "taskUuid",
    "title",
    "request",
    "sourceWorkspace",
    "agentId",
    "reviewerId",
    "receipt",
    "attempt",
    "revision",
    "newProject",
    "repositoryRoot",
    "baseCommit",
    "workspaceOwnerId",
    "initialTaskRevision",
    "state",
    "workspace",
    "branch",
    "threadId",
    "engineRunId",
    "implementationTaskId",
    "implementationTaskUuid",
    "reviewTaskId",
    "reviewTaskUuid",
    "reviewing",
    "implementationReply",
    "summary",
    "projectionPending",
    "announced",
    "stopReceipts",
    "createdAt",
    "updatedAt",
];

pub(crate) const ENGINES: &[&str] = &[
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
    "aider",
    "muse",
];

#[derive(Debug, Serialize)]
pub struct TaskCommandError {
    pub code: String,
    pub message: String,
}

impl TaskCommandError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: clip(code, 80),
            message: clip(&message.into(), 500),
        }
    }
}

fn clip(text: &str, max: usize) -> String {
    let mut out = String::new();
    for ch in text.chars() {
        if out.chars().count() + 1 > max {
            break;
        }
        out.push(ch);
    }
    if out.is_empty() {
        "invalid".into()
    } else {
        out
    }
}

pub(crate) fn store_lock() -> &'static Mutex<()> {
    static LOCK: Mutex<()> = Mutex::new(());
    &LOCK
}

fn path_override() -> &'static Mutex<Option<PathBuf>> {
    static PATH: Mutex<Option<PathBuf>> = Mutex::new(None);
    &PATH
}

pub fn default_tasks_path() -> PathBuf {
    crate::persist::state_path()
        .parent()
        .map(|dir| dir.join("tasks.json"))
        .unwrap_or_else(|| PathBuf::from("tasks.json"))
}

pub(crate) fn tasks_file_path() -> PathBuf {
    path_override()
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .clone()
        .unwrap_or_else(default_tasks_path)
}

#[cfg(test)]
fn set_tasks_path_override(path: Option<PathBuf>) {
    *path_override().lock().unwrap_or_else(|err| err.into_inner()) = path;
}

fn now_stamp() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or(0);
    millis.to_string()
}

pub(crate) fn utf16_len(text: &str) -> usize {
    text.chars()
        .map(|ch| if (ch as u32) > 0xFFFF { 2 } else { 1 })
        .sum()
}

pub(crate) fn is_uuid(value: &str) -> bool {
    if value.eq_ignore_ascii_case("00000000-0000-0000-0000-000000000000")
        || value.eq_ignore_ascii_case("ffffffff-ffff-ffff-ffff-ffffffffffff")
    {
        return true;
    }
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (index, byte) in bytes.iter().enumerate() {
        let dash = index == 8 || index == 13 || index == 18 || index == 23;
        if dash {
            if *byte != b'-' {
                return false;
            }
        } else if !byte.is_ascii_hexdigit() {
            return false;
        }
    }
    (b'1'..=b'8').contains(&bytes[14])
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b' | b'A' | b'B')
}

pub(crate) fn request_value(request: &Option<Value>) -> Value {
    body(request).cloned().unwrap_or(Value::Null)
}

pub(crate) enum Load {
    Missing,
    Ready(Value),
    Corrupt(String),
}

pub(crate) fn load_store(path: &Path) -> Load {
    match fs::read(path) {
        Err(err) if err.kind() == io::ErrorKind::NotFound => Load::Missing,
        Err(err) => Load::Corrupt(err.to_string()),
        Ok(bytes) if bytes.is_empty() => Load::Missing,
        Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
            Ok(Value::Object(object)) => Load::Ready(Value::Object(object)),
            Ok(_) => Load::Corrupt("tasks.json must be a JSON object.".into()),
            Err(err) => Load::Corrupt(format!("tasks.json could not be read: {err}")),
        },
    }
}

fn empty_document() -> Value {
    json!({
        "schemaVersion": 1,
        "selections": [],
        "runs": [],
        "lastError": null,
        "autopilotActive": false
    })
}

pub(crate) fn publish(path: &Path, document: &Value) -> Result<(), TaskCommandError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| {
            TaskCommandError::new("store_unavailable", format!("Could not prepare the task store: {err}"))
        })?;
    }
    let bytes = serde_json::to_vec_pretty(document).map_err(|err| {
        TaskCommandError::new("store_unavailable", format!("Could not encode the task store: {err}"))
    })?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &bytes).map_err(|err| {
        TaskCommandError::new("store_unavailable", format!("Could not write the task store: {err}"))
    })?;
    if path.exists() {
        if let Err(err) = fs::remove_file(path) {
            let _ = fs::remove_file(&tmp);
            return Err(TaskCommandError::new(
                "store_unavailable",
                format!("Could not replace the task store: {err}"),
            ));
        }
    }
    if let Err(err) = fs::rename(&tmp, path) {
        let _ = fs::rename(&tmp, path);
        return Err(TaskCommandError::new(
            "store_unavailable",
            format!("Could not publish the task store: {err}"),
        ));
    }
    Ok(())
}

pub(crate) fn with_document<T>(
    mutate: impl FnOnce(&mut Value) -> Result<T, TaskCommandError>,
) -> Result<T, TaskCommandError> {
    let _guard = store_lock().lock().unwrap_or_else(|err| err.into_inner());
    let path = tasks_file_path();
    let mut document = match load_store(&path) {
        Load::Missing => empty_document(),
        Load::Ready(document) => document,
        Load::Corrupt(message) => {
            return Err(TaskCommandError::new("store_unavailable", message));
        }
    };
    let result = mutate(&mut document)?;
    publish(&path, &document)?;
    Ok(result)
}

fn project_snapshot(document: &Value) -> Value {
    let runs = document
        .get("runs")
        .and_then(Value::as_array)
        .map(|runs| {
            runs.iter()
                .filter(|run| run.as_object().is_some_and(|object| object.contains_key("state")))
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let last_error = document
        .get("lastError")
        .and_then(Value::as_str)
        .map(|text| Value::String(text.to_string()))
        .unwrap_or(Value::Null);
    json!({
        "schemaVersion": 1,
        "available": true,
        "runs": runs,
        "lastError": last_error
    })
}

fn snapshot_value() -> Value {
    let _guard = store_lock().lock().unwrap_or_else(|err| err.into_inner());
    match load_store(&tasks_file_path()) {
        Load::Missing => json!({
            "schemaVersion": 1,
            "available": true,
            "runs": [],
            "lastError": null
        }),
        Load::Ready(document) => project_snapshot(&document),
        Load::Corrupt(message) => json!({
            "schemaVersion": 1,
            "available": false,
            "runs": [],
            "lastError": clip(&message, 500)
        }),
    }
}

pub fn task_execution_snapshot() -> Value {
    snapshot_value()
}

pub fn task_execution_refresh() -> Value {
    snapshot_value()
}

pub fn task_execution_clear_error() -> Value {
    {
        let _guard = store_lock().lock().unwrap_or_else(|err| err.into_inner());
        let path = tasks_file_path();
        if let Load::Ready(mut document) = load_store(&path) {
            let has_error = document
                .get("lastError")
                .is_some_and(|value| !value.is_null());
            if has_error {
                document["lastError"] = Value::Null;
                document["schemaVersion"] = json!(1);
                let _ = publish(&path, &document);
            }
        }
    }
    snapshot_value()
}

struct Selection {
    workspace_id: String,
    agent_id: String,
    reviewer_id: Option<String>,
    usable: bool,
    reason: String,
}

pub(crate) fn strict_object<'a>(value: &'a Value, allowed: &[&str]) -> Result<&'a Map<String, Value>, String> {
    let Some(object) = value.as_object() else {
        return Err("Expected an object.".into());
    };
    if let Some(extra) = object.keys().find(|key| !allowed.iter().any(|allowed| allowed == key)) {
        return Err(format!("Unexpected field `{extra}`."));
    }
    Ok(object)
}

fn required_text<'a>(
    object: &'a Map<String, Value>,
    key: &str,
    min: usize,
    max: Option<usize>,
) -> Result<&'a str, String> {
    let Some(value) = object.get(key) else {
        return Err(format!("`{key}` is required."));
    };
    let Some(text) = value.as_str() else {
        return Err(format!("`{key}` must be a string."));
    };
    let len = utf16_len(text);
    if len < min {
        return Err(format!("`{key}` is too short."));
    }
    if max.is_some_and(|max| len > max) {
        return Err(format!("`{key}` is too long."));
    }
    Ok(text)
}

fn optional_uuid(object: &Map<String, Value>, key: &str) -> Result<Option<String>, String> {
    match object.get(key) {
        None => Ok(None),
        Some(Value::String(text)) if is_uuid(text) => Ok(Some(text.clone())),
        Some(_) => Err(format!("`{key}` must be a UUID.")),
    }
}

fn raw_string(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn parse_selection(value: &Value) -> Selection {
    let workspace_id = raw_string(value, "workspaceId");
    let agent_id = raw_string(value, "agentId");
    let reviewer_text = value.get("reviewerId").and_then(Value::as_str).map(str::to_string);
    let parsed = (|| {
        let object = strict_object(value, &["workspaceId", "agentId", "reviewerId"])?;
        let workspace_id = required_text(object, "workspaceId", 1, None)?.to_string();
        let agent_id = required_text(object, "agentId", 1, None)?;
        if !is_uuid(agent_id) {
            return Err("`agentId` must be a UUID.".into());
        }
        let reviewer_id = optional_uuid(object, "reviewerId")?;
        Ok(Selection {
            workspace_id,
            agent_id: agent_id.to_string(),
            reviewer_id,
            usable: true,
            reason: String::new(),
        })
    })();
    match parsed {
        Ok(selection) => selection,
        Err(reason) => Selection {
            workspace_id,
            agent_id,
            reviewer_id: reviewer_text,
            usable: false,
            reason,
        },
    }
}

fn selection_key_matches(record: &Value, selection: &Selection) -> bool {
    record.get("workspaceId").and_then(Value::as_str) == Some(selection.workspace_id.as_str())
        && record.get("agentId").and_then(Value::as_str) == Some(selection.agent_id.as_str())
        && record.get("reviewerId").and_then(Value::as_str) == selection.reviewer_id.as_deref()
}

fn record_selection(document: &mut Value, selection: &Selection) {
    document["schemaVersion"] = json!(1);
    if !document.get("selections").and_then(Value::as_array).is_some() {
        document["selections"] = json!([]);
    }
    let Some(selections) = document.get_mut("selections").and_then(Value::as_array_mut) else {
        return;
    };
    let record = json!({
        "workspaceId": selection.workspace_id,
        "agentId": selection.agent_id,
        "reviewerId": selection.reviewer_id,
        "usable": selection.usable
    });
    if let Some(existing) = selections.iter_mut().find(|record| selection_key_matches(record, selection)) {
        *existing = record;
    } else {
        selections.push(record);
    }
}

fn stored_selection_usable(document: &Value, selection: &Selection) -> Option<bool> {
    document
        .get("selections")
        .and_then(Value::as_array)
        .and_then(|records| {
            records
                .iter()
                .find(|record| selection_key_matches(record, selection))
                .and_then(|record| record.get("usable"))
                .and_then(Value::as_bool)
        })
}

pub fn task_validate_selection(request: Option<Value>) -> Result<Value, TaskCommandError> {
    let value = request_value(&request);
    if !value.is_object() {
        return Err(TaskCommandError::new(
            "invalid_selection",
            "Task selection must be an object.",
        ));
    }
    let selection = parse_selection(&value);
    let reason = selection.reason.clone();
    let usable = selection.usable;
    with_document(|document| {
        record_selection(document, &selection);
        Ok(())
    })?;
    if usable {
        Ok(json!({ "ok": true }))
    } else {
        Err(TaskCommandError::new("invalid_selection", reason))
    }
}

struct ExecuteInput {
    task_id: String,
    workspace_id: String,
    agent_id: String,
    reviewer_id: Option<String>,
    receipt: String,
    new_project: bool,
}

fn parse_execute(value: &Value) -> Result<ExecuteInput, TaskCommandError> {
    let object = strict_object(
        value,
        &[
            "taskId",
            "workspaceId",
            "agentId",
            "reviewerId",
            "receipt",
            "newProject",
        ],
    )
    .map_err(|message| TaskCommandError::new("invalid_execution", message))?;
    let task_id = required_text(object, "taskId", 1, None)
        .map_err(|message| TaskCommandError::new("invalid_execution", message))?
        .to_string();
    let workspace_id = required_text(object, "workspaceId", 1, None)
        .map_err(|message| TaskCommandError::new("invalid_execution", message))?
        .to_string();
    let agent_id = required_text(object, "agentId", 1, None)
        .map_err(|message| TaskCommandError::new("invalid_execution", message))?;
    if !is_uuid(agent_id) {
        return Err(TaskCommandError::new(
            "invalid_execution",
            "`agentId` must be a UUID.",
        ));
    }
    let reviewer_id = optional_uuid(object, "reviewerId")
        .map_err(|message| TaskCommandError::new("invalid_execution", message))?;
    let receipt = required_text(object, "receipt", 1, Some(200))
        .map_err(|message| TaskCommandError::new("invalid_execution", message))?
        .to_string();
    let Some(new_project) = object.get("newProject").and_then(Value::as_bool) else {
        return Err(TaskCommandError::new(
            "invalid_execution",
            "`newProject` must be a boolean.",
        ));
    };
    Ok(ExecuteInput {
        task_id,
        workspace_id,
        agent_id: agent_id.to_string(),
        reviewer_id,
        receipt,
        new_project,
    })
}

fn build_view(input: &ExecuteInput) -> Value {
    let stamp = now_stamp();
    let task_uuid = if is_uuid(&input.task_id) {
        input.task_id.clone()
    } else {
        Uuid::new_v4().to_string()
    };
    json!({
        "id": Uuid::new_v4().to_string(),
        "taskId": input.task_id,
        "taskUuid": task_uuid,
        "title": input.task_id,
        "request": "Local task record",
        "sourceWorkspace": input.workspace_id,
        "agentId": input.agent_id,
        "reviewerId": input.reviewer_id,
        "receipt": input.receipt,
        "attempt": 1,
        "revision": 1,
        "newProject": input.new_project,
        "repositoryRoot": null,
        "baseCommit": null,
        "workspaceOwnerId": null,
        "initialTaskRevision": 1,
        "state": "succeeded",
        "workspace": input.workspace_id,
        "branch": null,
        "threadId": null,
        "engineRunId": null,
        "implementationTaskId": null,
        "implementationTaskUuid": null,
        "reviewTaskId": null,
        "reviewTaskUuid": null,
        "reviewing": false,
        "implementationReply": LOCAL_SUMMARY,
        "summary": LOCAL_SUMMARY,
        "projectionPending": false,
        "announced": false,
        "stopReceipts": [],
        "createdAt": stamp,
        "updatedAt": stamp
    })
}

fn runs_array(document: &Value) -> Vec<Value> {
    document
        .get("runs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn latest_run_index(runs: &[Value], task_id: &str) -> Option<usize> {
    runs.iter().enumerate().rev().find_map(|(index, run)| {
        (run.get("taskId").and_then(Value::as_str) == Some(task_id)).then_some(index)
    })
}

pub fn task_execute(request: Option<Value>) -> Result<Value, TaskCommandError> {
    let input = parse_execute(&request_value(&request))?;
    let selection = Selection {
        workspace_id: input.workspace_id.clone(),
        agent_id: input.agent_id.clone(),
        reviewer_id: input.reviewer_id.clone(),
        usable: true,
        reason: String::new(),
    };
    let view = build_view(&input);
    let run_id = view["id"].as_str().unwrap_or_default().to_string();
    with_document(|document| {
        match stored_selection_usable(document, &selection) {
            Some(true) => {}
            Some(false) => {
                return Err(TaskCommandError::new(
                    "selection_unusable",
                    "This selection is not usable.",
                ));
            }
            None => {
                return Err(TaskCommandError::new(
                    "selection_unusable",
                    "Validate the selection before starting a local run.",
                ));
            }
        }
        if !document.get("runs").and_then(Value::as_array).is_some() {
            document["runs"] = json!([]);
        }
        document["schemaVersion"] = json!(1);
        document
            .get_mut("runs")
            .and_then(Value::as_array_mut)
            .ok_or_else(|| TaskCommandError::new("store_unavailable", "Task runs could not be stored."))?
            .push(view);
        Ok(())
    })?;
    let stored = snapshot_value();
    stored
        .get("runs")
        .and_then(Value::as_array)
        .and_then(|runs| {
            runs.iter()
                .find(|run| run.get("id").and_then(Value::as_str) == Some(run_id.as_str()))
                .cloned()
        })
        .filter(|run| run.get("state").and_then(Value::as_str) == Some("succeeded"))
        .ok_or_else(|| {
            TaskCommandError::new(
                "store_unavailable",
                "The local run was not stored, so it was not marked completed.",
            )
        })
}

struct ControlInput {
    task_id: String,
    action: String,
    receipt: String,
}

fn parse_control(value: &Value) -> Result<ControlInput, TaskCommandError> {
    let object = strict_object(value, &["taskId", "action", "receipt"])
        .map_err(|message| TaskCommandError::new("invalid_control", message))?;
    let task_id = required_text(object, "taskId", 1, None)
        .map_err(|message| TaskCommandError::new("invalid_control", message))?
        .to_string();
    let action = required_text(object, "action", 1, None)
        .map_err(|message| TaskCommandError::new("invalid_control", message))?;
    if !matches!(action, "stop" | "resume" | "retry") {
        return Err(TaskCommandError::new(
            "invalid_control",
            "`action` must be stop, resume, or retry.",
        ));
    }
    let receipt = required_text(object, "receipt", 1, Some(200))
        .map_err(|message| TaskCommandError::new("invalid_control", message))?
        .to_string();
    Ok(ControlInput {
        task_id,
        action: action.to_string(),
        receipt,
    })
}

fn apply_control(run: &mut Value, input: &ControlInput) -> Result<(), TaskCommandError> {
    let object = run
        .as_object_mut()
        .ok_or_else(|| TaskCommandError::new("task_not_found", "The stored run is not an object."))?;
    match input.action.as_str() {
        "stop" => {
            object.insert("state".into(), json!("cancelled"));
            object.insert("summary".into(), json!(STOP_SUMMARY));
            object.insert("implementationReply".into(), json!(STOP_SUMMARY));
            let receipts = object
                .entry("stopReceipts")
                .or_insert_with(|| json!([]));
            if !receipts.as_array().is_some() {
                *receipts = json!([]);
            }
            if let Some(receipts) = receipts.as_array_mut() {
                receipts.push(json!(input.receipt));
            }
        }
        "resume" | "retry" => {
            let attempt = object.get("attempt").and_then(Value::as_i64).unwrap_or(1).saturating_add(1);
            object.insert("attempt".into(), json!(attempt));
            object.insert("state".into(), json!("succeeded"));
            object.insert("summary".into(), json!(LOCAL_SUMMARY));
            object.insert("implementationReply".into(), json!(LOCAL_SUMMARY));
        }
        _ => {
            return Err(TaskCommandError::new(
                "invalid_control",
                "`action` must be stop, resume, or retry.",
            ));
        }
    }
    let revision = object
        .get("revision")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        .saturating_add(1);
    object.insert("revision".into(), json!(revision));
    object.insert("receipt".into(), json!(input.receipt));
    object.insert("updatedAt".into(), json!(now_stamp()));
    Ok(())
}

pub fn task_control(request: Option<Value>) -> Result<Value, TaskCommandError> {
    let input = parse_control(&request_value(&request))?;
    let task_id = input.task_id.clone();
    with_document(|document| {
        let mut runs = runs_array(document);
        let Some(index) = latest_run_index(&runs, &task_id) else {
            return Err(TaskCommandError::new(
                "task_not_found",
                "No local run is stored for that task.",
            ));
        };
        apply_control(&mut runs[index], &input)?;
        document["runs"] = json!(runs);
        document["schemaVersion"] = json!(1);
        Ok(())
    })?;
    let stored = snapshot_value();
    stored
        .get("runs")
        .and_then(Value::as_array)
        .and_then(|runs| {
            latest_run_index(runs, &task_id).and_then(|index| runs.get(index).cloned())
        })
        .ok_or_else(|| {
            TaskCommandError::new(
                "store_unavailable",
                "The updated run was not stored, so its status was not changed.",
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempStore {
        dir: PathBuf,
    }

    impl Drop for TempStore {
        fn drop(&mut self) {
            set_tasks_path_override(None);
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    fn temp_store() -> TempStore {
        let dir = std::env::temp_dir().join(format!("kite-tasks-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        set_tasks_path_override(Some(dir.join("tasks.json")));
        TempStore { dir }
    }

    fn wrapped(value: Value) -> Option<Value> {
        Some(json!({ "request": value }))
    }

    const AGENT: &str = "c3333333-3333-4333-8333-333333333333";

    #[test]
    fn validate_execute_and_second_control_use_a_temp_file() {
        let user_path = default_tasks_path();
        let user_before = fs::read(&user_path).ok();
        let store = temp_store();
        let tasks_path = store.dir.join("tasks.json");
        assert_eq!(tasks_file_path(), tasks_path);

        let blocked = task_validate_selection(wrapped(json!({
            "workspaceId": "local-folder",
            "agentId": AGENT,
            "unexpected": true
        })));
        assert!(blocked.is_err());
        assert_ne!(
            serde_json::to_value(blocked.as_ref().err().unwrap()).ok(),
            Some(json!({ "ok": true }))
        );
        let early = task_execute(wrapped(json!({
            "taskId": "task-local-1",
            "workspaceId": "local-folder",
            "agentId": AGENT,
            "receipt": "receipt-execute",
            "newProject": false
        })));
        assert!(early.is_err());
        assert!(snapshot_value()["runs"].as_array().unwrap().is_empty());

        let validated = task_validate_selection(wrapped(json!({
            "workspaceId": "local-folder",
            "agentId": AGENT
        })))
        .expect("usable selection");
        assert_eq!(validated, json!({ "ok": true }));

        let invalid = task_validate_selection(wrapped(json!({
            "workspaceId": "",
            "agentId": "not-a-uuid"
        })));
        assert!(invalid.is_err());
        let stored_text = fs::read_to_string(&tasks_path).unwrap();
        assert!(stored_text.contains("\"usable\": false"));
        assert!(stored_text.contains("\"usable\": true"));

        let view = task_execute(wrapped(json!({
            "taskId": "task-local-1",
            "workspaceId": "local-folder",
            "agentId": AGENT,
            "receipt": "receipt-execute",
            "newProject": false
        })))
        .expect("stored run");
        let view_object = view.as_object().unwrap();
        assert_eq!(view_object.len(), VIEW_KEYS.len());
        for key in VIEW_KEYS {
            assert!(view_object.contains_key(*key), "{key}");
        }
        assert_eq!(view["state"], "succeeded");
        assert_eq!(view["engineRunId"], Value::Null);
        assert_eq!(view["threadId"], Value::Null);
        assert!(view["summary"].as_str().unwrap().contains("No external agent ran"));
        let run_id = view["id"].as_str().unwrap().to_string();
        let on_disk = fs::read_to_string(&tasks_path).unwrap();
        assert!(on_disk.contains(&run_id));
        assert!(on_disk.contains("\"state\": \"succeeded\""));

        let snapshot = task_execution_snapshot();
        let mut snapshot_keys: Vec<&str> = snapshot
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        snapshot_keys.sort_unstable();
        assert_eq!(
            snapshot_keys,
            ["available", "lastError", "runs", "schemaVersion"]
        );
        assert_eq!(snapshot["schemaVersion"], 1);
        assert_eq!(snapshot["available"], true);
        assert_eq!(snapshot["lastError"], Value::Null);
        assert_eq!(task_execution_refresh()["runs"][0]["id"], view["id"]);

        let stopped = task_control(wrapped(json!({
            "taskId": "task-local-1",
            "action": "stop",
            "receipt": "receipt-stop"
        })))
        .expect("stop");
        assert_eq!(stopped["state"], "cancelled");
        assert_eq!(stopped["id"], view["id"]);
        assert_eq!(stopped["stopReceipts"][0], "receipt-stop");

        let resumed = task_control(wrapped(json!({
            "taskId": "task-local-1",
            "action": "resume",
            "receipt": "receipt-resume"
        })))
        .expect("second control");
        assert_eq!(resumed["state"], "succeeded");
        assert_eq!(resumed["attempt"], 2);
        assert_eq!(resumed["receipt"], "receipt-resume");
        assert_eq!(resumed["id"], view["id"]);
        let after_second = fs::read_to_string(&tasks_path).unwrap();
        assert!(after_second.contains("\"attempt\": 2"));
        assert!(after_second.contains("\"state\": \"succeeded\""));

        let decision = crate::local_autopilot::autopilot_next(wrapped(json!({
            "supportedSchemaVersion": 1,
            "agentId": AGENT,
            "paneId": "a1111111-1111-4111-8111-111111111111",
            "sessionId": "b2222222-2222-4222-8222-222222222222",
            "runId": "d4444444-4444-4444-8444-444444444444",
            "generation": 1,
            "turn": {
                "supportedSchemaVersion": 1,
                "task": "",
                "mode": "complete",
                "engine": "codex",
                "transcript": "",
                "turnsCompleted": 0,
                "previousPrompts": [],
                "objective": null,
                "objectivesCompleted": 0,
                "completedObjectives": []
            }
        })));
        assert_ne!(decision, json!({ "ok": true }));
        assert_eq!(decision["action"], "stuck");
        assert_eq!(decision["prompt"], "");
        assert_eq!(decision["turnsRemaining"], 60);
        assert_eq!(decision["objectivesRemaining"], 0);
        assert!(decision["reason"].as_str().unwrap().contains("unavailable"));
        assert!(fs::read_to_string(&tasks_path).unwrap().contains("\"autopilotActive\": true"));

        let cancelled = crate::local_autopilot::cancel_autopilot(wrapped(json!({ "supportedSchemaVersion": 1 })));
        assert_eq!(cancelled, Value::Null);
        let after_cancel = fs::read_to_string(&tasks_path).unwrap();
        assert!(after_cancel.contains("\"autopilotActive\": false"));
        assert!(after_cancel.contains(&run_id));
        assert_eq!(task_execution_clear_error()["lastError"], Value::Null);

        let refused = crate::local_autopilot::autopilot_next(Some(json!({ "request": { "supportedSchemaVersion": 1 } })));
        assert_eq!(refused["action"], "stuck");
        assert_ne!(refused, json!({ "ok": true }));

        drop(store);
        assert!(tasks_file_path() != tasks_path);
        assert!(!tasks_path.exists());
        assert_eq!(fs::read(&user_path).ok(), user_before);
    }
}
