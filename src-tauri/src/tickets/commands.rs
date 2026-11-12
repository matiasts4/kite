// Kite Code — Tickets Tauri Command Handlers
// Implementations for ticket CRUD, snapshotting, connections, and recovery

use crate::persist::body;
use super::document::*;
use super::storage::*;
use serde_json::{json, Value};
use std::fs;
use uuid::Uuid;

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

pub fn ticket_recover(_request: Option<Value>) -> Value {
    let _lock = doc_lock().lock().unwrap();
    let backup_path = tickets_backup_path();
    let path = tickets_file_path();
    if backup_path.exists() {
        let _ = fs::copy(&backup_path, &path);
    }
    json!({ "ok": true })
}
