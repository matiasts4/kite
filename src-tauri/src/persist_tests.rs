use super::*;
use serde_json::json;

fn count_where(conn: &Connection, sql: &str, id: &str) -> i64 {
    conn.query_row(sql, [id], |row| row.get(0)).unwrap()
}

fn app_value(conn: &Connection, key: &str) -> String {
    conn.query_row(
        "SELECT value FROM app_state WHERE key = ?1",
        [key],
        |row| row.get(0),
    )
    .unwrap()
}

#[test]
fn test_sqlite_round_trip() {
    let mut conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(SCHEMA_SQL).unwrap();
    conn.execute_batch(
        "CREATE TABLE workspace_events (kind TEXT NOT NULL);
         CREATE TRIGGER workspace_deleted AFTER DELETE ON workspaces BEGIN
             INSERT INTO workspace_events (kind) VALUES ('delete');
         END;
         CREATE TRIGGER workspace_updated AFTER UPDATE ON workspaces BEGIN
             INSERT INTO workspace_events (kind) VALUES ('update');
         END;",
    )
    .unwrap();

    let workspace_id = "ws-round-trip";
    let thread_id = "th-round-trip";
    let routine_id = "rt-round-trip";
    let notification_id = "nt-round-trip";
    let mut state = DiskState {
        workspaces: vec![Workspace {
            id: workspace_id.into(),
            display_name: "Round Trip".into(),
            created_at_unix_ms: 11,
            last_opened_at_unix_ms: 22,
            pinned: true,
            available: false,
        }],
        paths: HashMap::from([(workspace_id.into(), r"E:\round-trip".into())]),
        agents: vec![AgentProfile {
            id: "ag-round-trip".into(), name: "Round Agent".into(), engine: "claude".into(),
            purpose: "round trip".into(), brief: "round trip".into(), avatar: None, created_at_unix_ms: 11, pinned: false, order: 0,
            memory_budget: None, reflection_mode: None, allow_agent_scheduling: None,
            allow_agent_messaging: None, default_mode: None, default_plan: None, default_model: None,
            default_provider_options: vec![], place_display_names: vec![], disabled_plugin_ids: vec![],
        }],
        threads: vec![json!({ "id": thread_id, "createdAtUnixMs": 11, "updatedAtUnixMs": 33, "title": "kept" })],
        last_provider: "claude".into(),
        last_model: None,
        last_effort: None,
        grid: json!({ "cols": 2 }),
        revision: 4,
        routines: vec![json!({ "id": routine_id, "enabled": true, "name": "once" })],
        notifications: vec![json!({ "id": notification_id, "isRead": false, "createdAtUnixMs": 44 })],
    };

    write_disk_state(&mut conn, &state).unwrap();

    let (name, folder, pinned, available): (String, String, i64, i64) = conn
        .query_row(
            "SELECT display_name, folder_path, pinned, available FROM workspaces WHERE id = ?1",
            [workspace_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(name, "Round Trip");
    assert_eq!(folder, r"E:\round-trip");
    assert_eq!(pinned, 1);
    assert_eq!(available, 0);

    let (data, created, updated): (String, i64, i64) = conn
        .query_row(
            "SELECT data, created_at_unix_ms, updated_at_unix_ms FROM threads WHERE id = ?1",
            [thread_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    let parsed: Value = serde_json::from_str(&data).unwrap();
    assert_eq!(parsed["id"], thread_id);
    assert_eq!(parsed["title"], "kept");
    assert_eq!(created, 11);
    assert_eq!(updated, 33);
    assert_eq!(count_where(&conn, "SELECT COUNT(*) FROM workspace_events WHERE kind = ?1", "delete"), 0);

    state.workspaces[0].display_name = "Still here".into();
    state.threads[0]["title"] = json!("renamed");
    write_disk_state(&mut conn, &state).unwrap();

    let renamed: String = conn
        .query_row(
            "SELECT data FROM threads WHERE id = ?1",
            [thread_id],
            |row| row.get(0),
        )
        .unwrap();
    let renamed: Value = serde_json::from_str(&renamed).unwrap();
    assert_eq!(renamed["title"], "renamed");
    assert_eq!(count_where(&conn, "SELECT COUNT(*) FROM threads WHERE id = ?1", thread_id), 1);
    assert_eq!(count_where(&conn, "SELECT COUNT(*) FROM workspace_events WHERE kind = ?1", "update"), 1);
    assert_eq!(count_where(&conn, "SELECT COUNT(*) FROM workspace_events WHERE kind = ?1", "delete"), 0);

    state.threads.clear();
    state.routines.clear();
    state.notifications.clear();
    write_disk_state(&mut conn, &state).unwrap();

    assert_eq!(count_where(&conn, "SELECT COUNT(*) FROM threads WHERE id = ?1", thread_id), 0);
    assert_eq!(count_where(&conn, "SELECT COUNT(*) FROM routines WHERE id = ?1", routine_id), 0);
    assert_eq!(count_where(&conn, "SELECT COUNT(*) FROM notifications WHERE id = ?1", notification_id), 0);
    let routine_total: i64 = conn.query_row("SELECT COUNT(*) FROM routines", [], |row| row.get(0)).unwrap();
    let notification_total: i64 = conn
        .query_row("SELECT COUNT(*) FROM notifications", [], |row| row.get(0))
        .unwrap();
    assert_eq!(routine_total, 0);
    assert_eq!(notification_total, 0);

    let (name_after, workspace_total): (String, i64) = conn
        .query_row(
            "SELECT display_name, (SELECT COUNT(*) FROM workspaces) FROM workspaces WHERE id = ?1",
            [workspace_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(name_after, "Still here");
    assert_eq!(workspace_total, 1);
    assert_eq!(count_where(&conn, "SELECT COUNT(*) FROM workspace_events WHERE kind = ?1", "delete"), 0);
    assert_eq!(count_where(&conn, "SELECT COUNT(*) FROM workspace_events WHERE kind = ?1", "update"), 1);
    let agent_name: String = conn
        .query_row(
            "SELECT name FROM agents WHERE id = 'ag-round-trip'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(agent_name, "Round Agent");

    write_disk_state(&mut conn, &state).unwrap();
    assert_eq!(count_where(&conn, "SELECT COUNT(*) FROM workspace_events WHERE kind = ?1", "update"), 1);
    assert_eq!(count_where(&conn, "SELECT COUNT(*) FROM workspace_events WHERE kind = ?1", "delete"), 0);

    assert_eq!(app_value(&conn, "lastProvider"), "claude");
    assert_eq!(app_value(&conn, "revision"), "4");
    assert_eq!(app_value(&conn, "routinesSeeded"), "1");
    assert_eq!(app_value(&conn, "notificationsSeeded"), "1");
    let grid: Value = serde_json::from_str(&app_value(&conn, "grid")).unwrap();
    assert_eq!(grid["cols"], 2);
}
