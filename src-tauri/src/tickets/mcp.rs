// Kite Code — Tickets MCP Server Implementation (STDIO JSON-RPC)
// Provides list_tasks, get_task, create_task, update_task, add_task_comment tools to AI agents

use super::document::*;
use super::storage::*;
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use uuid::Uuid;

pub fn get_mcp_tools() -> Vec<Value> {
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

pub fn handle_mcp_tool_call(name: &str, args: &Value, read_only: bool) -> Value {
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
