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
