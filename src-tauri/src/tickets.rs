// Kite Code — Tickets & Tasks Subsystem and MCP Server
// Supports local task management, agent task execution, and stdio MCP server for agents

use crate::persist::body;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketIssue {
    pub id: String,
    pub uuid: String,
    #[serde(default)]
    pub revision: i64,
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub state: String,
    pub priority: Value,
    pub assignee: Option<String>,
    pub delegate: Option<String>,
    pub project_id: Option<String>,
    pub parent_id: Option<String>,
    pub duplicate_of: Option<String>,
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default)]
    pub blocks: Vec<String>,
    #[serde(default)]
    pub related_to: Vec<String>,
    pub branch: Option<String>,
    pub due_date: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub archived_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketProject {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub revision: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketLabel {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub revision: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketComment {
    pub id: String,
    pub issue_id: String,
    pub parent_id: Option<String>,
    pub body: String,
    pub author: String,
    pub created_at: String,
    #[serde(default)]
    pub revision: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketHistoryEvent {
    pub id: String,
    pub issue_id: Option<String>,
    pub actor: String,
    pub action: String,
    pub created_at: String,
    #[serde(default)]
    pub changes: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketConnection {
    pub id: String,
    pub name: String,
    pub read_only: bool,
    pub created_at: String,
    pub revoked_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketDocument {
    pub schema_version: i64,
    pub revision: i64,
    pub issues: Vec<TicketIssue>,
    pub projects: Vec<TicketProject>,
    pub labels: Vec<TicketLabel>,
    pub comments: Vec<TicketComment>,
    pub history: Vec<TicketHistoryEvent>,
    pub connections: Vec<TicketConnection>,
}

pub fn now_iso() -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    format_iso(ms)
}

pub fn format_iso(ms: i64) -> String {
    let secs = if ms > 1_000_000_000_000 { ms / 1000 } else { ms };
    let days = (secs / 86400) as i64;
    let rem_secs = secs % 86400;
    let hours = rem_secs / 3600;
    let mins = (rem_secs % 3600) / 60;
    let s = rem_secs % 60;

    let z = days + 719468;
    let era = (if z >= 0 { z } else { z - 146096 }) / 146097;
    let doe = (z - era * 146097) as u32;
    let yoe = (doe - doe / 1024 + doe / 1461 - doe / 146096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, m, d, hours, mins, s)
}

fn doc_lock() -> &'static Mutex<()> {
    static LOCK: Mutex<()> = Mutex::new(());
    &LOCK
}

pub fn tickets_file_path() -> PathBuf {
    crate::persist::roaming_app_dir().join("tickets.json")
}

pub fn tickets_backup_path() -> PathBuf {
    crate::persist::roaming_app_dir().join("tickets.backup.json")
}

fn create_default_document() -> TicketDocument {
    TicketDocument {
        schema_version: 1,
        revision: 1,
        projects: vec![],
        labels: vec![],
        issues: vec![],
        comments: vec![],
        history: vec![],
        connections: vec![],
    }
}

fn load_ticket_document_locked() -> TicketDocument {
    let path = tickets_file_path();
    if path.exists() {
        if let Ok(content) = fs::read_to_string(&path) {
            if let Ok(doc) = serde_json::from_str::<TicketDocument>(&content) {
                return doc;
            }
        }
    }

    let backup_path = tickets_backup_path();
    if backup_path.exists() {
        if let Ok(content) = fs::read_to_string(&backup_path) {
            if let Ok(doc) = serde_json::from_str::<TicketDocument>(&content) {
                return doc;
            }
        }
    }

    let default_doc = create_default_document();
    let _ = save_ticket_document_locked(&default_doc);
    default_doc
}

fn save_ticket_document_locked(doc: &TicketDocument) -> Result<(), String> {
    let path = tickets_file_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let data = serde_json::to_string_pretty(doc).map_err(|e| e.to_string())?;

    if path.exists() {
        let backup_path = tickets_backup_path();
        let _ = fs::copy(&path, &backup_path);
    }

    let tmp_path = path.with_extension("tmp");
    fs::write(&tmp_path, data).map_err(|e| e.to_string())?;
    fs::rename(&tmp_path, &path).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn load_ticket_document() -> TicketDocument {
    let _lock = doc_lock().lock().unwrap();
    load_ticket_document_locked()
}

pub fn save_ticket_document(doc: &TicketDocument) -> Result<(), String> {
    let _lock = doc_lock().lock().unwrap();
    save_ticket_document_locked(doc)
}

fn next_issue_id(issues: &[TicketIssue]) -> String {
    let mut max_id = 100;
    for issue in issues {
        if let Some(num_str) = issue.id.strip_prefix("KITE-") {
            if let Ok(num) = num_str.parse::<i64>() {
                if num > max_id {
                    max_id = num;
                }
            }
        }
    }
    format!("KITE-{}", max_id + 1)
}

#[tauri::command]
pub fn ticket_snapshot() -> Value {
    let _lock = doc_lock().lock().unwrap();
    let doc = load_ticket_document_locked();
    serde_json::to_value(&doc).unwrap_or(json!({
        "schemaVersion": 1,
        "revision": 1,
        "issues": [],
        "projects": [],
        "labels": [],
        "comments": [],
        "history": [],
        "connections": []
    }))
}

#[tauri::command]
pub fn ticket_call(request: Option<Value>) -> Value {
    let _lock = doc_lock().lock().unwrap();
    let mut doc = load_ticket_document_locked();
    let now = now_iso();

    let b = body(&request);
    let tool = b
        .and_then(|v| v.get("tool").or_else(|| v.get("action")))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    match tool {
        "save_issue" => {
            let issue_obj = b.and_then(|v| v.get("issue")).and_then(|v| v.as_object());
            let target_id = b
                .and_then(|v| v.get("id"))
                .and_then(|v| v.as_str())
                .or_else(|| issue_obj.and_then(|o| o.get("id")).and_then(|v| v.as_str()))
                .unwrap_or("")
                .trim();

            let target_uuid = b
                .and_then(|v| v.get("uuid"))
                .and_then(|v| v.as_str())
                .or_else(|| issue_obj.and_then(|o| o.get("uuid")).and_then(|v| v.as_str()))
                .unwrap_or("")
                .trim();

            let existing_idx = doc.issues.iter().position(|i| {
                (!target_id.is_empty() && i.id.eq_ignore_ascii_case(target_id))
                    || (!target_uuid.is_empty() && i.uuid.eq_ignore_ascii_case(target_uuid))
            });

            if let Some(idx) = existing_idx {
                let issue = &mut doc.issues[idx];
                let mut changes = serde_json::Map::new();

                if let Some(title) = b.and_then(|v| v.get("title")).and_then(|v| v.as_str()) {
                    changes.insert("title".into(), json!(title));
                    issue.title = title.to_string();
                } else if let Some(title) = issue_obj.and_then(|o| o.get("title")).and_then(|v| v.as_str()) {
                    changes.insert("title".into(), json!(title));
                    issue.title = title.to_string();
                }

                if let Some(desc) = b.and_then(|v| v.get("description")).and_then(|v| v.as_str()) {
                    changes.insert("description".into(), json!(desc));
                    issue.description = desc.to_string();
                } else if let Some(desc) = issue_obj.and_then(|o| o.get("description")).and_then(|v| v.as_str()) {
                    changes.insert("description".into(), json!(desc));
                    issue.description = desc.to_string();
                }

                if let Some(state) = b.and_then(|v| v.get("state")).and_then(|v| v.as_str()) {
                    changes.insert("state".into(), json!(state));
                    issue.state = state.to_string();
                } else if let Some(state) = issue_obj.and_then(|o| o.get("state")).and_then(|v| v.as_str()) {
                    changes.insert("state".into(), json!(state));
                    issue.state = state.to_string();
                }

                if let Some(priority) = b.and_then(|v| v.get("priority")) {
                    changes.insert("priority".into(), priority.clone());
                    issue.priority = priority.clone();
                } else if let Some(priority) = issue_obj.and_then(|o| o.get("priority")) {
                    changes.insert("priority".into(), priority.clone());
                    issue.priority = priority.clone();
                }

                if let Some(v) = b.and_then(|v| v.get("assignee")) {
                    issue.assignee = v.as_str().map(|s| s.to_string());
                    changes.insert("assignee".into(), v.clone());
                } else if let Some(v) = issue_obj.and_then(|o| o.get("assignee")) {
                    issue.assignee = v.as_str().map(|s| s.to_string());
                    changes.insert("assignee".into(), v.clone());
                }

                if let Some(v) = b.and_then(|v| v.get("delegate")) {
                    issue.delegate = v.as_str().map(|s| s.to_string());
                    changes.insert("delegate".into(), v.clone());
                } else if let Some(v) = issue_obj.and_then(|o| o.get("delegate")) {
                    issue.delegate = v.as_str().map(|s| s.to_string());
                    changes.insert("delegate".into(), v.clone());
                }

                if let Some(v) = b.and_then(|v| v.get("projectId")) {
                    issue.project_id = v.as_str().map(|s| s.to_string());
                    changes.insert("projectId".into(), v.clone());
                } else if let Some(v) = issue_obj.and_then(|o| o.get("projectId")) {
                    issue.project_id = v.as_str().map(|s| s.to_string());
                    changes.insert("projectId".into(), v.clone());
                }

                if let Some(v) = b.and_then(|v| v.get("parentId")) {
                    issue.parent_id = v.as_str().map(|s| s.to_string());
                    changes.insert("parentId".into(), v.clone());
                } else if let Some(v) = issue_obj.and_then(|o| o.get("parentId")) {
                    issue.parent_id = v.as_str().map(|s| s.to_string());
                    changes.insert("parentId".into(), v.clone());
                }

                if let Some(v) = b.and_then(|v| v.get("duplicateOf")) {
                    issue.duplicate_of = v.as_str().map(|s| s.to_string());
                    changes.insert("duplicateOf".into(), v.clone());
                } else if let Some(v) = issue_obj.and_then(|o| o.get("duplicateOf")) {
                    issue.duplicate_of = v.as_str().map(|s| s.to_string());
                    changes.insert("duplicateOf".into(), v.clone());
                }

                if let Some(v) = b.and_then(|v| v.get("dueDate")) {
                    issue.due_date = v.as_str().map(|s| s.to_string());
                    changes.insert("dueDate".into(), v.clone());
                } else if let Some(v) = issue_obj.and_then(|o| o.get("dueDate")) {
                    issue.due_date = v.as_str().map(|s| s.to_string());
                    changes.insert("dueDate".into(), v.clone());
                }

                if let Some(v) = b.and_then(|v| v.get("branch")) {
                    issue.branch = v.as_str().map(|s| s.to_string());
                    changes.insert("branch".into(), v.clone());
                } else if let Some(v) = issue_obj.and_then(|o| o.get("branch")) {
                    issue.branch = v.as_str().map(|s| s.to_string());
                    changes.insert("branch".into(), v.clone());
                }

                if let Some(labels) = b.and_then(|v| v.get("labels")).and_then(|v| v.as_array()) {
                    issue.labels = labels.iter().filter_map(|l| l.as_str().map(|s| s.to_string())).collect();
                    changes.insert("labels".into(), json!(issue.labels));
                } else if let Some(labels) = issue_obj.and_then(|o| o.get("labels")).and_then(|v| v.as_array()) {
                    issue.labels = labels.iter().filter_map(|l| l.as_str().map(|s| s.to_string())).collect();
                    changes.insert("labels".into(), json!(issue.labels));
                }

                if let Some(blocks) = b.and_then(|v| v.get("blocks")).and_then(|v| v.as_array()) {
                    issue.blocks = blocks.iter().filter_map(|l| l.as_str().map(|s| s.to_string())).collect();
                }

                if let Some(related) = b.and_then(|v| v.get("relatedTo")).and_then(|v| v.as_array()) {
                    issue.related_to = related.iter().filter_map(|l| l.as_str().map(|s| s.to_string())).collect();
                }

                issue.updated_at = now.clone();
                issue.revision += 1;
                doc.revision += 1;

                let issue_id = issue.id.clone();
                let issue_result = serde_json::to_value(&issue).unwrap_or(Value::Null);

                doc.history.push(TicketHistoryEvent {
                    id: Uuid::new_v4().to_string(),
                    issue_id: Some(issue_id),
                    actor: "User".into(),
                    action: "updated".into(),
                    created_at: now,
                    changes: Value::Object(changes),
                });

                let _ = save_ticket_document_locked(&doc);
                json!({ "ok": true, "result": issue_result })
            } else {
                let new_id = next_issue_id(&doc.issues);
                let title = b
                    .and_then(|v| v.get("title"))
                    .and_then(|v| v.as_str())
                    .or_else(|| issue_obj.and_then(|o| o.get("title")).and_then(|v| v.as_str()))
                    .unwrap_or("Nueva tarea")
                    .trim();

                let desc = b
                    .and_then(|v| v.get("description"))
                    .and_then(|v| v.as_str())
                    .or_else(|| issue_obj.and_then(|o| o.get("description")).and_then(|v| v.as_str()))
                    .unwrap_or("")
                    .trim();

                let state = b
                    .and_then(|v| v.get("state"))
                    .and_then(|v| v.as_str())
                    .or_else(|| issue_obj.and_then(|o| o.get("state")).and_then(|v| v.as_str()))
                    .unwrap_or("To Do");

                let priority = b
                    .and_then(|v| v.get("priority"))
                    .or_else(|| issue_obj.and_then(|o| o.get("priority")))
                    .cloned()
                    .unwrap_or(json!("Medium"));

                let assignee = b
                    .and_then(|v| v.get("assignee"))
                    .or_else(|| issue_obj.and_then(|o| o.get("assignee")))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());

                let project_id = b
                    .and_then(|v| v.get("projectId"))
                    .or_else(|| issue_obj.and_then(|o| o.get("projectId")))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());

                let labels: Vec<String> = b
                    .and_then(|v| v.get("labels"))
                    .or_else(|| issue_obj.and_then(|o| o.get("labels")))
                    .and_then(|v| v.as_array())
                    .map(|arr| arr.iter().filter_map(|l| l.as_str().map(|s| s.to_string())).collect())
                    .unwrap_or_default();

                let new_issue = TicketIssue {
                    id: new_id.clone(),
                    uuid: Uuid::new_v4().to_string(),
                    revision: 1,
                    title: title.to_string(),
                    description: desc.to_string(),
                    state: state.to_string(),
                    priority,
                    assignee,
                    delegate: None,
                    project_id,
                    parent_id: None,
                    duplicate_of: None,
                    labels,
                    blocks: vec![],
                    related_to: vec![],
                    branch: None,
                    due_date: None,
                    created_at: now.clone(),
                    updated_at: now.clone(),
                    archived_at: None,
                };

                doc.issues.push(new_issue.clone());
                doc.revision += 1;

                doc.history.push(TicketHistoryEvent {
                    id: Uuid::new_v4().to_string(),
                    issue_id: Some(new_id),
                    actor: "User".into(),
                    action: "created".into(),
                    created_at: now,
                    changes: json!({ "state": state }),
                });

                let _ = save_ticket_document_locked(&doc);
                json!({ "ok": true, "result": new_issue })
            }
        }
        "archive_issue" => {
            let id = b.and_then(|v| v.get("id")).and_then(|v| v.as_str()).unwrap_or("");
            if let Some(issue) = doc.issues.iter_mut().find(|i| i.id.eq_ignore_ascii_case(id) || i.uuid.eq_ignore_ascii_case(id)) {
                issue.archived_at = Some(now.clone());
                issue.updated_at = now.clone();
                issue.revision += 1;
                doc.revision += 1;

                doc.history.push(TicketHistoryEvent {
                    id: Uuid::new_v4().to_string(),
                    issue_id: Some(issue.id.clone()),
                    actor: "User".into(),
                    action: "archived".into(),
                    created_at: now,
                    changes: json!({ "archived": true }),
                });

                let _ = save_ticket_document_locked(&doc);
            }
            json!({ "ok": true })
        }
        "restore_issue" => {
            let id = b.and_then(|v| v.get("id")).and_then(|v| v.as_str()).unwrap_or("");
            if let Some(issue) = doc.issues.iter_mut().find(|i| i.id.eq_ignore_ascii_case(id) || i.uuid.eq_ignore_ascii_case(id)) {
                issue.archived_at = None;
                issue.updated_at = now.clone();
                issue.revision += 1;
                doc.revision += 1;

                doc.history.push(TicketHistoryEvent {
                    id: Uuid::new_v4().to_string(),
                    issue_id: Some(issue.id.clone()),
                    actor: "User".into(),
                    action: "restored".into(),
                    created_at: now,
                    changes: json!({ "archived": false }),
                });

                let _ = save_ticket_document_locked(&doc);
            }
            json!({ "ok": true })
        }
        "save_issue_label" => {
            let name = b.and_then(|v| v.get("name")).and_then(|v| v.as_str()).unwrap_or("").trim();
            if !name.is_empty() && !doc.labels.iter().any(|l| l.name.eq_ignore_ascii_case(name)) {
                let slug = name.to_lowercase().replace(' ', "-");
                doc.labels.push(TicketLabel {
                    id: format!("lbl-{}", slug),
                    name: name.to_string(),
                    revision: 1,
                });
                doc.revision += 1;
                let _ = save_ticket_document_locked(&doc);
            }
            json!({ "ok": true })
        }
        "save_project" => {
            let name = b.and_then(|v| v.get("name")).and_then(|v| v.as_str()).unwrap_or("").trim();
            if !name.is_empty() && !doc.projects.iter().any(|p| p.name.eq_ignore_ascii_case(name)) {
                let slug = name.to_lowercase().replace(' ', "-");
                doc.projects.push(TicketProject {
                    id: format!("proj-{}", slug),
                    name: name.to_string(),
                    key: None,
                    revision: 1,
                });
                doc.revision += 1;
                let _ = save_ticket_document_locked(&doc);
            }
            json!({ "ok": true })
        }
        "save_comment" => {
            let issue_id = b.and_then(|v| v.get("issueId")).and_then(|v| v.as_str()).unwrap_or("");
            let comment_body = b.and_then(|v| v.get("body")).and_then(|v| v.as_str()).unwrap_or("").trim();
            let author = b.and_then(|v| v.get("author")).and_then(|v| v.as_str()).unwrap_or("User");
            let parent_id = b.and_then(|v| v.get("parentId")).and_then(|v| v.as_str()).map(|s| s.to_string());

            if !issue_id.is_empty() && !comment_body.is_empty() {
                let comment = TicketComment {
                    id: Uuid::new_v4().to_string(),
                    issue_id: issue_id.to_string(),
                    parent_id,
                    body: comment_body.to_string(),
                    author: author.to_string(),
                    created_at: now.clone(),
                    revision: 1,
                };
                doc.comments.push(comment.clone());
                doc.revision += 1;

                doc.history.push(TicketHistoryEvent {
                    id: Uuid::new_v4().to_string(),
                    issue_id: Some(issue_id.to_string()),
                    actor: author.to_string(),
                    action: "commented".into(),
                    created_at: now,
                    changes: json!({ "body": comment_body }),
                });

                let _ = save_ticket_document_locked(&doc);
                json!({ "ok": true, "result": comment })
            } else {
                json!({ "ok": false, "error": "Missing issueId or body" })
            }
        }
        _ => json!({ "ok": true, "result": null }),
    }
}

#[tauri::command]
pub fn ticket_connect(request: Option<Value>) -> Value {
    let b = body(&request);
    let name = b
        .and_then(|v| v.get("name"))
        .and_then(|v| v.as_str())
        .unwrap_or("My coding agent")
        .trim();
    let read_only = b
        .and_then(|v| v.get("readOnly"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let id = format!("conn-{}", &Uuid::new_v4().to_string().replace('-', "")[..12]);
    let conn = TicketConnection {
        id: id.clone(),
        name: if name.is_empty() { "My coding agent".into() } else { name.into() },
        read_only,
        created_at: now_iso(),
        revoked_at: None,
    };

    let _lock = doc_lock().lock().unwrap();
    let mut doc = load_ticket_document_locked();
    doc.connections.push(conn.clone());
    doc.revision += 1;
    let _ = save_ticket_document_locked(&doc);

    let mut args = vec![
        "mcp".to_string(),
        "tasks".to_string(),
        "--connection-id".to_string(),
        id.clone(),
    ];
    if read_only {
        args.push("--read-only".to_string());
    }

    json!({
        "id": id,
        "name": conn.name,
        "readOnly": read_only,
        "mcpServers": {
            "kite-tasks": {
                "command": "kite-code",
                "args": args
            }
        }
    })
}

#[tauri::command]
pub fn ticket_configuration(request: Option<Value>) -> Value {
    let b = body(&request);
    let id = b.and_then(|v| v.get("id")).and_then(|v| v.as_str()).unwrap_or("");

    let _lock = doc_lock().lock().unwrap();
    let doc = load_ticket_document_locked();

    let conn = doc.connections.iter().find(|c| c.id == id);
    let read_only = conn.map(|c| c.read_only).unwrap_or(false);
    let name = conn.map(|c| c.name.as_str()).unwrap_or("Kite Tasks Agent");

    let mut args = vec![
        "mcp".to_string(),
        "tasks".to_string(),
        "--connection-id".to_string(),
        id.to_string(),
    ];
    if read_only {
        args.push("--read-only".to_string());
    }

    json!({
        "id": id,
        "name": name,
        "readOnly": read_only,
        "mcpServers": {
            "kite-tasks": {
                "command": "kite-code",
                "args": args
            }
        }
    })
}

#[tauri::command]
pub fn ticket_revoke(request: Option<Value>) -> Value {
    let b = body(&request);
    let id = b.and_then(|v| v.get("id")).and_then(|v| v.as_str()).unwrap_or("");

    let _lock = doc_lock().lock().unwrap();
    let mut doc = load_ticket_document_locked();
    if let Some(conn) = doc.connections.iter_mut().find(|c| c.id == id) {
        conn.revoked_at = Some(now_iso());
        doc.revision += 1;
        let _ = save_ticket_document_locked(&doc);
    }
    json!({ "ok": true })
}

#[tauri::command]
pub fn ticket_recover(_request: Option<Value>) -> Value {
    let _lock = doc_lock().lock().unwrap();
    let backup_path = tickets_backup_path();
    let path = tickets_file_path();
    if backup_path.exists() {
        let _ = fs::copy(&backup_path, &path);
    }
    json!({ "ok": true })
}

// ==========================================
// MCP SERVER IMPLEMENTATION (STDIO JSON-RPC)
// ==========================================

fn get_mcp_tools() -> Vec<Value> {
    vec![
        json!({
            "name": "list_tasks",
            "description": "List tasks from the Kite Tasks board. Filter by state ('To Do', 'In Progress', 'Review', 'Done'), priority, or label.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "state": {
                        "type": "string",
                        "description": "Filter by state: 'To Do', 'In Progress', 'Review', 'Done'"
                    },
                    "priority": {
                        "type": "string",
                        "description": "Filter by priority: 'Urgent', 'High', 'Medium', 'Low', 'No priority'"
                    },
                    "label": {
                        "type": "string",
                        "description": "Filter by tag/label name"
                    },
                    "includeArchived": {
                        "type": "boolean",
                        "description": "Whether to include archived tasks (default false)"
                    }
                }
            }
        }),
        json!({
            "name": "get_task",
            "description": "Retrieve complete details of a specific task by its ID (e.g. 'KITE-101') or UUID.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": {
                        "type": "string",
                        "description": "The task ID (e.g. 'KITE-101') or UUID"
                    }
                },
                "required": ["id"]
            }
        }),
        json!({
            "name": "create_task",
            "description": "Create a new task on the Kite Tasks board. Note: Keep titles simple, concise, and verifiable in under 1 minute.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "Short, clear, verifiable task title"
                    },
                    "description": {
                        "type": "string",
                        "description": "Requirements and acceptance criteria"
                    },
                    "state": {
                        "type": "string",
                        "enum": ["To Do", "In Progress", "Review", "Done"],
                        "description": "Initial state (default 'To Do')"
                    },
                    "priority": {
                        "type": "string",
                        "enum": ["Urgent", "High", "Medium", "Low", "No priority"],
                        "description": "Priority (default 'Medium')"
                    },
                    "labels": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Labels or tags"
                    },
                    "assignee": {
                        "type": "string",
                        "description": "Assignee name or agent handle"
                    }
                },
                "required": ["title"]
            }
        }),
        json!({
            "name": "update_task",
            "description": "Update state, priority, description, title, or assignee of an existing task.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": {
                        "type": "string",
                        "description": "Task ID (e.g. 'KITE-101') or UUID"
                    },
                    "state": {
                        "type": "string",
                        "enum": ["To Do", "In Progress", "Review", "Done"],
                        "description": "New state"
                    },
                    "priority": {
                        "type": "string",
                        "enum": ["Urgent", "High", "Medium", "Low", "No priority"],
                        "description": "New priority"
                    },
                    "title": {
                        "type": "string",
                        "description": "Updated title"
                    },
                    "description": {
                        "type": "string",
                        "description": "Updated description"
                    },
                    "labels": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Updated labels"
                    },
                    "assignee": {
                        "type": "string",
                        "description": "Updated assignee"
                    }
                },
                "required": ["id"]
            }
        }),
        json!({
            "name": "add_task_comment",
            "description": "Add a comment, progress note, or execution update to a task.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": {
                        "type": "string",
                        "description": "Task ID (e.g. 'KITE-101') or UUID"
                    },
                    "body": {
                        "type": "string",
                        "description": "Markdown comment text"
                    },
                    "author": {
                        "type": "string",
                        "description": "Name of the agent or user adding the comment"
                    }
                },
                "required": ["id", "body"]
            }
        }),
    ]
}

fn handle_mcp_tool_call(name: &str, args: &Value, read_only: bool) -> Value {
    if read_only && matches!(name, "create_task" | "update_task" | "add_task_comment") {
        return json!({
            "isError": true,
            "content": [
                {
                    "type": "text",
                    "text": "Permission denied: Kite Tasks MCP connection is configured as read-only."
                }
            ]
        });
    }

    let _lock = doc_lock().lock().unwrap();
    let mut doc = load_ticket_document_locked();
    let now = now_iso();

    match name {
        "list_tasks" => {
            let filter_state = args.get("state").and_then(|v| v.as_str());
            let filter_priority = args.get("priority").and_then(|v| v.as_str());
            let filter_label = args.get("label").and_then(|v| v.as_str());
            let include_archived = args.get("includeArchived").and_then(|v| v.as_bool()).unwrap_or(false);

            let matching: Vec<&TicketIssue> = doc
                .issues
                .iter()
                .filter(|i| {
                    if !include_archived && i.archived_at.is_some() {
                        return false;
                    }
                    if let Some(state) = filter_state {
                        if !i.state.eq_ignore_ascii_case(state) {
                            return false;
                        }
                    }
                    if let Some(priority) = filter_priority {
                        let prio_str = i.priority.as_str().unwrap_or("");
                        if !prio_str.eq_ignore_ascii_case(priority) {
                            return false;
                        }
                    }
                    if let Some(label) = filter_label {
                        if !i.labels.iter().any(|l| l.eq_ignore_ascii_case(label)) {
                            return false;
                        }
                    }
                    true
                })
                .collect();

            if matching.is_empty() {
                return json!({
                    "content": [
                        {
                            "type": "text",
                            "text": "No tasks found matching the criteria."
                        }
                    ]
                });
            }

            let mut out = format!("### Kite Tasks ({} found)\n\n", matching.len());
            for issue in matching {
                let prio = match &issue.priority {
                    Value::String(s) => s.clone(),
                    Value::Number(n) => format!("P{}", n),
                    _ => "Normal".into(),
                };
                let assignee = issue.assignee.as_deref().unwrap_or("Unassigned");
                let labels = if issue.labels.is_empty() {
                    String::new()
                } else {
                    format!(" [{}]", issue.labels.join(", "))
                };

                out.push_str(&format!(
                    "- **{}** | **{}** | Priority: {} | Assignee: {}{}\n  {}\n",
                    issue.id, issue.state, prio, assignee, labels, issue.title
                ));
            }

            json!({
                "content": [
                    {
                        "type": "text",
                        "text": out
                    }
                ]
            })
        }
        "get_task" => {
            let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let issue = doc.issues.iter().find(|i| i.id.eq_ignore_ascii_case(id) || i.uuid.eq_ignore_ascii_case(id));

            if let Some(issue) = issue {
                let comments: Vec<&TicketComment> = doc.comments.iter().filter(|c| c.issue_id == issue.id).collect();
                let mut out = format!("# Task {}: {}\n\n", issue.id, issue.title);
                out.push_str(&format!("- **Status:** {}\n", issue.state));
                out.push_str(&format!("- **Priority:** {}\n", issue.priority));
                out.push_str(&format!("- **Assignee:** {}\n", issue.assignee.as_deref().unwrap_or("Unassigned")));
                if !issue.labels.is_empty() {
                    out.push_str(&format!("- **Labels:** {}\n", issue.labels.join(", ")));
                }
                if let Some(ref branch) = issue.branch {
                    out.push_str(&format!("- **Branch:** {}\n", branch));
                }
                out.push_str(&format!("- **Created:** {}\n", issue.created_at));
                out.push_str(&format!("- **Updated:** {}\n\n", issue.updated_at));

                out.push_str("## Description\n\n");
                out.push_str(if issue.description.is_empty() {
                    "_No description provided._\n"
                } else {
                    &issue.description
                });
                out.push_str("\n\n");

                if !comments.is_empty() {
                    out.push_str(&format!("## Comments ({})\n\n", comments.len()));
                    for c in comments {
                        out.push_str(&format!("> **{}** ({})\n> {}\n\n", c.author, c.created_at, c.body));
                    }
                }

                json!({
                    "content": [
                        {
                            "type": "text",
                            "text": out
                        }
                    ]
                })
            } else {
                json!({
                    "isError": true,
                    "content": [
                        {
                            "type": "text",
                            "text": format!("Task '{}' not found in Kite Tasks.", id)
                        }
                    ]
                })
            }
        }
        "create_task" => {
            let title = args.get("title").and_then(|v| v.as_str()).unwrap_or("").trim();
            if title.is_empty() {
                return json!({
                    "isError": true,
                    "content": [
                        {
                            "type": "text",
                            "text": "Task title cannot be empty."
                        }
                    ]
                });
            }

            let new_id = next_issue_id(&doc.issues);
            let desc = args.get("description").and_then(|v| v.as_str()).unwrap_or("").trim();
            let state = args.get("state").and_then(|v| v.as_str()).unwrap_or("To Do");
            let priority = args.get("priority").cloned().unwrap_or(json!("Medium"));
            let assignee = args.get("assignee").and_then(|v| v.as_str()).map(|s| s.to_string());
            let labels: Vec<String> = args
                .get("labels")
                .and_then(|v| v.as_array())
                .map(|arr| arr.iter().filter_map(|l| l.as_str().map(|s| s.to_string())).collect())
                .unwrap_or_default();

            let new_issue = TicketIssue {
                id: new_id.clone(),
                uuid: Uuid::new_v4().to_string(),
                revision: 1,
                title: title.to_string(),
                description: desc.to_string(),
                state: state.to_string(),
                priority,
                assignee,
                delegate: None,
                project_id: Some("proj-kite".into()),
                parent_id: None,
                duplicate_of: None,
                labels,
                blocks: vec![],
                related_to: vec![],
                branch: None,
                due_date: None,
                created_at: now.clone(),
                updated_at: now.clone(),
                archived_at: None,
            };

            doc.issues.push(new_issue);
            doc.revision += 1;

            doc.history.push(TicketHistoryEvent {
                id: Uuid::new_v4().to_string(),
                issue_id: Some(new_id.clone()),
                actor: "Agent".into(),
                action: "created".into(),
                created_at: now,
                changes: json!({ "state": state }),
            });

            let _ = save_ticket_document_locked(&doc);

            json!({
                "content": [
                    {
                        "type": "text",
                        "text": format!("Task {} ('{}') successfully created in state '{}'.", new_id, title, state)
                    }
                ]
            })
        }
        "update_task" => {
            let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let existing_idx = doc.issues.iter().position(|i| i.id.eq_ignore_ascii_case(id) || i.uuid.eq_ignore_ascii_case(id));

            if let Some(idx) = existing_idx {
                let issue = &mut doc.issues[idx];
                let mut changes = serde_json::Map::new();

                if let Some(title) = args.get("title").and_then(|v| v.as_str()) {
                    changes.insert("title".into(), json!(title));
                    issue.title = title.to_string();
                }
                if let Some(desc) = args.get("description").and_then(|v| v.as_str()) {
                    changes.insert("description".into(), json!(desc));
                    issue.description = desc.to_string();
                }
                if let Some(state) = args.get("state").and_then(|v| v.as_str()) {
                    changes.insert("state".into(), json!(state));
                    issue.state = state.to_string();
                }
                if let Some(priority) = args.get("priority") {
                    changes.insert("priority".into(), priority.clone());
                    issue.priority = priority.clone();
                }
                if let Some(assignee) = args.get("assignee").and_then(|v| v.as_str()) {
                    issue.assignee = Some(assignee.to_string());
                    changes.insert("assignee".into(), json!(assignee));
                }
                if let Some(labels) = args.get("labels").and_then(|v| v.as_array()) {
                    issue.labels = labels.iter().filter_map(|l| l.as_str().map(|s| s.to_string())).collect();
                    changes.insert("labels".into(), json!(issue.labels));
                }

                issue.updated_at = now.clone();
                issue.revision += 1;
                doc.revision += 1;

                let issue_id = issue.id.clone();
                let issue_state = issue.state.clone();

                doc.history.push(TicketHistoryEvent {
                    id: Uuid::new_v4().to_string(),
                    issue_id: Some(issue_id.clone()),
                    actor: "Agent".into(),
                    action: "updated".into(),
                    created_at: now,
                    changes: Value::Object(changes),
                });

                let _ = save_ticket_document_locked(&doc);

                json!({
                    "content": [
                        {
                            "type": "text",
                            "text": format!("Task {} successfully updated (state: '{}').", issue_id, issue_state)
                        }
                    ]
                })
            } else {
                json!({
                    "isError": true,
                    "content": [
                        {
                            "type": "text",
                            "text": format!("Task '{}' not found.", id)
                        }
                    ]
                })
            }
        }
        "add_task_comment" => {
            let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let body = args.get("body").and_then(|v| v.as_str()).unwrap_or("").trim();
            let author = args.get("author").and_then(|v| v.as_str()).unwrap_or("Agent");

            if id.is_empty() || body.is_empty() {
                return json!({
                    "isError": true,
                    "content": [
                        {
                            "type": "text",
                            "text": "Task ID and comment body are required."
                        }
                    ]
                });
            }

            let issue = doc.issues.iter().find(|i| i.id.eq_ignore_ascii_case(id) || i.uuid.eq_ignore_ascii_case(id));
            if let Some(issue) = issue {
                let issue_id = issue.id.clone();
                doc.comments.push(TicketComment {
                    id: Uuid::new_v4().to_string(),
                    issue_id: issue_id.clone(),
                    parent_id: None,
                    body: body.to_string(),
                    author: author.to_string(),
                    created_at: now.clone(),
                    revision: 1,
                });
                doc.revision += 1;

                doc.history.push(TicketHistoryEvent {
                    id: Uuid::new_v4().to_string(),
                    issue_id: Some(issue_id.clone()),
                    actor: author.to_string(),
                    action: "commented".into(),
                    created_at: now,
                    changes: json!({ "body": body }),
                });

                let _ = save_ticket_document_locked(&doc);

                json!({
                    "content": [
                        {
                            "type": "text",
                            "text": format!("Comment successfully added to task {}.", issue_id)
                        }
                    ]
                })
            } else {
                json!({
                    "isError": true,
                    "content": [
                        {
                            "type": "text",
                            "text": format!("Task '{}' not found.", id)
                        }
                    ]
                })
            }
        }
        _ => json!({
            "isError": true,
            "content": [
                {
                    "type": "text",
                    "text": format!("Unknown tool '{}'.", name)
                }
            ]
        }),
    }
}

pub fn run_mcp_server(args: &[String]) {
    #[cfg(windows)]
    {
        #[link(name = "kernel32")]
        extern "system" {
            fn AttachConsole(dw_process_id: u32) -> i32;
        }
        const ATTACH_PARENT_PROCESS: u32 = 0xFFFFFFFF;
        unsafe {
            let _ = AttachConsole(ATTACH_PARENT_PROCESS);
        }
    }

    let mut read_only = false;
    let mut connection_id: Option<String> = None;
    let mut i = 0;
    while i < args.len() {
        if args[i] == "--read-only" {
            read_only = true;
        } else if args[i] == "--connection-id" && i + 1 < args.len() {
            connection_id = Some(args[i + 1].clone());
            i += 1;
        }
        i += 1;
    }

    if let Some(ref cid) = connection_id {
        let doc = load_ticket_document();
        if let Some(conn) = doc.connections.iter().find(|c| &c.id == cid) {
            if conn.revoked_at.is_some() {
                eprintln!("Connection {} has been revoked", cid);
                return;
            }
            if conn.read_only {
                read_only = true;
            }
        }
    }

    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    let reader = stdin.lock();

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let msg: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let id = msg.get("id").cloned();
        let method = msg.get("method").and_then(|v| v.as_str()).unwrap_or("");

        if id.is_none() {
            if method == "notifications/initialized" {
                // Initialized notification
            }
            continue;
        }

        let req_id = id.unwrap();

        match method {
            "initialize" => {
                let resp = json!({
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {
                        "protocolVersion": "2024-11-05",
                        "capabilities": {
                            "tools": {}
                        },
                        "serverInfo": {
                            "name": "kite-tasks",
                            "version": "1.0.0"
                        }
                    }
                });
                let _ = writeln!(stdout, "{}", resp);
                let _ = stdout.flush();
            }
            "ping" => {
                let resp = json!({
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {}
                });
                let _ = writeln!(stdout, "{}", resp);
                let _ = stdout.flush();
            }
            "tools/list" => {
                let tools = get_mcp_tools();
                let resp = json!({
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {
                        "tools": tools
                    }
                });
                let _ = writeln!(stdout, "{}", resp);
                let _ = stdout.flush();
            }
            "tools/call" => {
                let params = msg.get("params");
                let tool_name = params.and_then(|p| p.get("name")).and_then(|v| v.as_str()).unwrap_or("");
                let tool_args = params.and_then(|p| p.get("arguments")).cloned().unwrap_or(json!({}));

                let result = handle_mcp_tool_call(tool_name, &tool_args, read_only);
                let resp = json!({
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": result
                });
                let _ = writeln!(stdout, "{}", resp);
                let _ = stdout.flush();
            }
            _ => {
                let resp = json!({
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "error": {
                        "code": -32601,
                        "message": format!("Method not found: {}", method)
                    }
                });
                let _ = writeln!(stdout, "{}", resp);
                let _ = stdout.flush();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_create_default_document_empty() {
        let doc = create_default_document();
        assert_eq!(doc.schema_version, 1);
        assert_eq!(doc.revision, 1);
        assert!(doc.issues.is_empty());
        assert!(doc.projects.is_empty());
        assert!(doc.labels.is_empty());
        assert!(doc.comments.is_empty());
        assert!(doc.history.is_empty());
    }

    #[test]
    fn test_next_issue_id() {
        let doc = create_default_document();
        let next = next_issue_id(&doc.issues);
        assert_eq!(next, "KITE-101");

        let sample = vec![TicketIssue {
            id: "KITE-105".into(),
            uuid: Uuid::new_v4().to_string(),
            revision: 1,
            title: "Sample".into(),
            description: "".into(),
            state: "To Do".into(),
            priority: json!("Medium"),
            assignee: None,
            delegate: None,
            project_id: None,
            parent_id: None,
            duplicate_of: None,
            labels: vec![],
            blocks: vec![],
            related_to: vec![],
            branch: None,
            due_date: None,
            created_at: "".into(),
            updated_at: "".into(),
            archived_at: None,
        }];
        assert_eq!(next_issue_id(&sample), "KITE-106");
    }

    #[test]
    fn test_format_iso() {
        let ts = 1791770226543; // sample timestamp
        let formatted = format_iso(ts);
        assert!(formatted.contains('T'));
        assert!(formatted.ends_with('Z'));
        assert_eq!(formatted.len(), 20); // YYYY-MM-DDTHH:MM:SSZ
    }

    #[test]
    fn test_mcp_tools_list() {
        let tools = get_mcp_tools();
        assert_eq!(tools.len(), 5);
        let names: Vec<&str> = tools.iter().filter_map(|t| t.get("name").and_then(|v| v.as_str())).collect();
        assert!(names.contains(&"list_tasks"));
        assert!(names.contains(&"get_task"));
        assert!(names.contains(&"create_task"));
        assert!(names.contains(&"update_task"));
        assert!(names.contains(&"add_task_comment"));
    }

    #[test]
    fn test_mcp_read_only_enforcement() {
        let res = handle_mcp_tool_call("create_task", &json!({ "title": "Test" }), true);
        assert_eq!(res.get("isError").and_then(|v| v.as_bool()), Some(true));

        let res2 = handle_mcp_tool_call("update_task", &json!({ "id": "KITE-101" }), true);
        assert_eq!(res2.get("isError").and_then(|v| v.as_bool()), Some(true));

        let res3 = handle_mcp_tool_call("add_task_comment", &json!({ "id": "KITE-101", "body": "test" }), true);
        assert_eq!(res3.get("isError").and_then(|v| v.as_bool()), Some(true));
    }
}

