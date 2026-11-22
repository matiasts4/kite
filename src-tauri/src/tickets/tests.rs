// Kite Code — Tickets Tests

use super::*;
use serde_json::json;
use uuid::Uuid;

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
        odd_path: None,
        source_agent: None,
        source_thread_id: None,
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

struct EnvGuard {
    name: &'static str,
    previous: Option<std::ffi::OsString>,
}

impl EnvGuard {
    fn set(name: &'static str, value: &str) -> Self {
        let previous = std::env::var_os(name);
        std::env::set_var(name, value);
        Self { name, previous }
    }

    fn clear(name: &'static str) -> Self {
        let previous = std::env::var_os(name);
        std::env::remove_var(name);
        Self { name, previous }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        match self.previous.take() {
            Some(v) => std::env::set_var(self.name, v),
            None => std::env::remove_var(self.name),
        }
    }
}

fn extract_created_id(mcp_resp: &serde_json::Value) -> String {
    let text = mcp_resp["content"][0]["text"]
        .as_str()
        .expect("mcp response text");
    text.split_whitespace()
        .find(|w| w.starts_with("KITE-"))
        .expect("KITE- id in response")
        .trim_end_matches(|c: char| !c.is_ascii_alphanumeric() && c != '-')
        .to_string()
}

#[test]
fn test_legacy_ticket_issue_deserialization_without_new_fields() {
    let legacy_json = json!({
        "schemaVersion": 1,
        "revision": 3,
        "issues": [{
            "id": "KITE-101",
            "uuid": "uuid-legacy-1",
            "revision": 1,
            "title": "Legacy Task",
            "description": "Old format",
            "state": "To Do",
            "priority": "High",
            "assignee": "User",
            "delegate": null,
            "projectId": "proj-kite",
            "parentId": null,
            "duplicateOf": null,
            "labels": ["bug"],
            "blocks": [],
            "relatedTo": [],
            "branch": "main",
            "dueDate": null,
            "createdAt": "2026-10-01T00:00:00Z",
            "updatedAt": "2026-10-01T00:00:00Z",
            "archivedAt": null
        }],
        "projects": [],
        "labels": [],
        "comments": [],
        "history": [],
        "connections": []
    });

    let doc: TicketDocument = serde_json::from_value(legacy_json).expect("legacy tickets.json should deserialize");
    assert_eq!(doc.issues.len(), 1);
    assert_eq!(doc.issues[0].id, "KITE-101");
    assert_eq!(doc.issues[0].odd_path, None);
    assert_eq!(doc.issues[0].source_agent, None);
    assert_eq!(doc.issues[0].source_thread_id, None);
}

#[test]
fn test_save_issue_create_and_update_traceability_fields() {
    let created = ticket_call(Some(json!({
        "tool": "save_issue",
        "title": "Verify voice handoff",
        "description": "Test description",
        "state": "Review",
        "oddPath": "odd/tasks/voice-mode.md",
        "sourceAgent": "antigravity",
        "sourceThreadId": "thread:thr-save-1"
    })));
    assert_eq!(created["ok"], true);
    let id = created["result"]["id"].as_str().expect("created id").to_string();
    assert_eq!(created["result"]["oddPath"], "odd/tasks/voice-mode.md");
    assert_eq!(created["result"]["sourceAgent"], "antigravity");
    assert_eq!(created["result"]["sourceThreadId"], "thread:thr-save-1");

    let updated = ticket_call(Some(json!({
        "tool": "save_issue",
        "issue": {
            "id": id,
            "oddPath": "odd/tasks/qa-task-handoff-and-tickets-ux.md",
            "sourceAgent": "opencode",
            "sourceThreadId": "ses_nested_99"
        }
    })));
    assert_eq!(updated["ok"], true);
    assert_eq!(updated["result"]["oddPath"], "odd/tasks/qa-task-handoff-and-tickets-ux.md");
    assert_eq!(updated["result"]["sourceAgent"], "opencode");
    assert_eq!(updated["result"]["sourceThreadId"], "ses_nested_99");

    let snap = ticket_snapshot();
    let issues = snap["issues"].as_array().expect("issues array");
    let found = issues.iter().find(|i| i["id"] == id).expect("persisted issue");
    assert_eq!(found["oddPath"], "odd/tasks/qa-task-handoff-and-tickets-ux.md");
    assert_eq!(found["sourceAgent"], "opencode");
    assert_eq!(found["sourceThreadId"], "ses_nested_99");
}

#[test]
fn test_ticket_connect_and_configuration_use_kite_command() {
    let connected = ticket_connect(Some(json!({
        "name": "OpenCode QA",
        "readOnly": true
    })));
    let conn_id = connected["id"].as_str().expect("connection id").to_string();
    assert_eq!(connected["mcpServers"]["kite-tasks"]["command"], "kite");
    let args = connected["mcpServers"]["kite-tasks"]["args"]
        .as_array()
        .expect("args array");
    assert_eq!(args[0], "mcp");
    assert_eq!(args[1], "tasks");
    assert_eq!(args[2], "--connection-id");
    assert_eq!(args[3], conn_id);
    assert_eq!(args[4], "--read-only");

    let cfg = ticket_configuration(Some(json!({ "id": conn_id })));
    assert_eq!(cfg["mcpServers"]["kite-tasks"]["command"], "kite");
    assert_eq!(cfg["mcpServers"]["kite-tasks"]["args"][0], "mcp");
    assert_eq!(cfg["mcpServers"]["kite-tasks"]["args"][1], "tasks");
}

#[test]
fn test_mcp_create_get_update_list_traceability_and_kite_address_fallback() {
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _env_lock = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());

    // Verify tool schemas advertise the new properties
    let tools = get_mcp_tools();
    for tool_name in ["create_task", "update_task"] {
        let schema = tools
            .iter()
            .find(|t| t["name"] == tool_name)
            .expect("tool schema");
        let props = schema["inputSchema"]["properties"]
            .as_object()
            .expect("properties");
        for key in ["oddPath", "sourceAgent", "sourceThreadId", "branch", "projectId"] {
            assert!(props.contains_key(key), "{tool_name} schema missing {key}");
        }
    }

    // 1. Explicit traceability fields + custom projectId/branch + actor = sourceAgent
    let create_res = handle_mcp_tool_call(
        "create_task",
        &json!({
            "title": "Test QA task traceability",
            "state": "Review",
            "oddPath": "odd/tasks/seth-voice-roadmap.md",
            "sourceAgent": "antigravity",
            "sourceThreadId": "thread:thr-explicit-1",
            "branch": "feat/response-thread",
            "projectId": "proj-voice"
        }),
        false,
    );
    assert!(create_res.get("isError").is_none());
    let created_id = extract_created_id(&create_res);

    let doc = load_ticket_document();
    let issue = doc.issues.iter().find(|i| i.id == created_id).expect("created issue");
    assert_eq!(issue.odd_path.as_deref(), Some("odd/tasks/seth-voice-roadmap.md"));
    assert_eq!(issue.source_agent.as_deref(), Some("antigravity"));
    assert_eq!(issue.source_thread_id.as_deref(), Some("thread:thr-explicit-1"));
    assert_eq!(issue.branch.as_deref(), Some("feat/response-thread"));
    assert_eq!(issue.project_id.as_deref(), Some("proj-voice"));

    let created_evt = doc
        .history
        .iter()
        .rev()
        .find(|h| h.issue_id.as_deref() == Some(created_id.as_str()) && h.action == "created")
        .expect("created history event");
    assert_eq!(created_evt.actor, "antigravity");

    let get_res = handle_mcp_tool_call("get_task", &json!({ "id": created_id }), false);
    let get_text = get_res["content"][0]["text"].as_str().expect("get_task text");
    assert!(get_text.contains("odd/tasks/seth-voice-roadmap.md"));
    assert!(get_text.contains("antigravity"));
    assert!(get_text.contains("thread:thr-explicit-1"));

    let list_res = handle_mcp_tool_call("list_tasks", &json!({ "state": "Review" }), false);
    let list_text = list_res["content"][0]["text"].as_str().expect("list_tasks text");
    assert!(list_text.contains("odd/tasks/seth-voice-roadmap.md"));
    assert!(list_text.contains("antigravity"));
    assert!(list_text.contains("thread:thr-explicit-1"));

    // 2. Update traceability fields
    let update_res = handle_mcp_tool_call(
        "update_task",
        &json!({
            "id": created_id,
            "oddPath": "odd/tasks/qa-task-handoff-and-tickets-ux.md",
            "sourceAgent": "claude-code",
            "sourceThreadId": "thread:thr-updated-2",
            "branch": "main",
            "projectId": "proj-kite"
        }),
        false,
    );
    assert!(update_res.get("isError").is_none());
    let doc_after_update = load_ticket_document();
    let updated_issue = doc_after_update
        .issues
        .iter()
        .find(|i| i.id == created_id)
        .expect("updated issue");
    assert_eq!(
        updated_issue.odd_path.as_deref(),
        Some("odd/tasks/qa-task-handoff-and-tickets-ux.md")
    );
    assert_eq!(updated_issue.source_agent.as_deref(), Some("claude-code"));
    assert_eq!(updated_issue.source_thread_id.as_deref(), Some("thread:thr-updated-2"));
    assert_eq!(updated_issue.branch.as_deref(), Some("main"));
    assert_eq!(updated_issue.project_id.as_deref(), Some("proj-kite"));

    // 3. KITE_ADDRESS fallback when sourceThreadId omitted, default projectId, default actor "Agent"
    let _guard = EnvGuard::set("KITE_ADDRESS", "thread:thr-env-42");
    let fallback_res = handle_mcp_tool_call(
        "create_task",
        &json!({
            "title": "Fallback env thread task",
            "sourceThreadId": "   ",
            "projectId": ""
        }),
        false,
    );
    drop(_guard);
    let fallback_id = extract_created_id(&fallback_res);
    let doc_fallback = load_ticket_document();
    let fallback_issue = doc_fallback
        .issues
        .iter()
        .find(|i| i.id == fallback_id)
        .expect("fallback issue");
    assert_eq!(fallback_issue.source_thread_id.as_deref(), Some("thread:thr-env-42"));
    assert_eq!(fallback_issue.project_id.as_deref(), Some("proj-kite"));
    let fallback_evt = doc_fallback
        .history
        .iter()
        .rev()
        .find(|h| h.issue_id.as_deref() == Some(fallback_id.as_str()) && h.action == "created")
        .expect("fallback created event");
    assert_eq!(fallback_evt.actor, "Agent");

    // Verify helper returns None when KITE_ADDRESS is unset
    let _clear_guard = EnvGuard::clear("KITE_ADDRESS");
    assert_eq!(resolve_source_thread_id(None), None);
}
