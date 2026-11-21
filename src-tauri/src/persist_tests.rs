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

#[test]
fn test_differential_thread_sync_skips_unchanged_revisions_and_pragmas() {
    let mut conn = Connection::open_in_memory().unwrap();
    configure_sqlite_pragmas(&conn).unwrap();
    conn.execute_batch(SCHEMA_SQL).unwrap();
    conn.execute_batch(
        "CREATE TABLE thread_events (id TEXT NOT NULL);
         CREATE TRIGGER thread_updated AFTER UPDATE ON threads BEGIN
             INSERT INTO thread_events (id) VALUES (NEW.id);
         END;",
    )
    .unwrap();

    let sync_mode: i64 = conn
        .query_row("PRAGMA synchronous", [], |row| row.get(0))
        .unwrap();
    let busy_ms: i64 = conn
        .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
        .unwrap();
    assert_eq!(sync_mode, 1, "PRAGMA synchronous should be NORMAL (1)");
    assert_eq!(busy_ms, 5000, "PRAGMA busy_timeout should be 5000ms");

    let mut rev_cache = HashMap::new();
    let mut state = default_disk_state();
    state.threads = vec![
        json!({ "id": "th-unchanged", "revision": "rev-1", "createdAtUnixMs": 10, "updatedAtUnixMs": 20, "title": "First" }),
        json!({ "id": "th-mutated", "revision": "rev-2", "createdAtUnixMs": 10, "updatedAtUnixMs": 20, "title": "Second" }),
    ];

    let serialized_initial =
        write_disk_state_with_cache(&mut conn, &state, Some(&mut rev_cache)).unwrap();
    assert_eq!(serialized_initial, 2);

    // Mutate only th-mutated; th-unchanged keeps its revision and should be skipped without serialization or SQL execution.
    state.threads[1]["revision"] = json!("rev-3");
    state.threads[1]["updatedAtUnixMs"] = json!(99);
    state.threads[1]["title"] = json!("Second Updated");

    let serialized_second =
        write_disk_state_with_cache(&mut conn, &state, Some(&mut rev_cache)).unwrap();
    assert_eq!(
        serialized_second, 1,
        "only the mutated thread should be serialized on incremental sync"
    );
    assert_eq!(
        count_where(
            &conn,
            "SELECT COUNT(*) FROM thread_events WHERE id = ?1",
            "th-unchanged"
        ),
        0
    );
    assert_eq!(
        count_where(
            &conn,
            "SELECT COUNT(*) FROM thread_events WHERE id = ?1",
            "th-mutated"
        ),
        1
    );

    // Mutate only updatedAtUnixMs on th-unchanged; (revision, updatedAtUnixMs) stamp must detect it.
    state.threads[0]["updatedAtUnixMs"] = json!(55);
    let serialized_third =
        write_disk_state_with_cache(&mut conn, &state, Some(&mut rev_cache)).unwrap();
    assert_eq!(serialized_third, 1);
}

#[test]
fn test_roaming_app_dir_isolates_default_appdata() {
    let fallback = Path::new(r"C:\Temp\kite-cargo-test-999");
    assert!(!is_isolated_test_appdata(r"C:\Users\PC\AppData\Roaming"));
    assert_eq!(
        resolve_test_roaming_app_dir(Some(r"C:\Users\PC\AppData\Roaming"), fallback),
        fallback.join(app_data_folder())
    );
    assert_eq!(
        resolve_test_roaming_app_dir(None, fallback),
        fallback.join(app_data_folder())
    );
    assert!(is_isolated_test_appdata(r"C:\Temp\f5-routines-test"));
    assert_eq!(
        resolve_test_roaming_app_dir(Some(r"C:\Temp\f5-routines-test"), fallback),
        PathBuf::from(r"C:\Temp\f5-routines-test").join(app_data_folder())
    );
    assert!(
        !roaming_app_dir()
            .to_string_lossy()
            .to_ascii_lowercase()
            .replace('\\', "/")
            .contains("/appdata/roaming/kite code dev"),
        "cargo test must never target the user's live Kite Code Dev AppData directory"
    );
}

#[test]
fn test_heal_loaded_threads_persists_cleaned_post_reply_connection_loss() {
    let mut conn = Connection::open_in_memory().unwrap();
    configure_sqlite_pragmas(&conn).unwrap();
    conn.execute_batch(SCHEMA_SQL).unwrap();

    let mut state = default_disk_state();
    state.threads = vec![
        json!({
            "id": "th-post-reply",
            "revision": "rev-1",
            "createdAtUnixMs": 10,
            "updatedAtUnixMs": 20,
            "status": "error",
            "turnFailure": {
                "kind": "processError",
                "exit_code": 1,
                "message": "API error (attempt 5): dial tcp: lookup daily-cloudcode-pa.googleapis.com: no such host"
            },
            "items": [
                { "id": "u1", "kind": "user", "text": "hola" },
                { "id": "a1", "kind": "assistant", "text": "Todo listo." },
                { "id": "n1", "kind": "notice", "text": "antigravity ended the turn with status ERROR" }
            ]
        }),
        json!({
            "id": "th-healthy",
            "revision": "rev-2",
            "createdAtUnixMs": 10,
            "updatedAtUnixMs": 20,
            "status": "idle",
            "items": []
        }),
    ];
    write_disk_state(&mut conn, &state).unwrap();

    let healed_ids = heal_loaded_threads(&mut state.threads);
    assert!(healed_ids.contains("th-post-reply"));
    assert!(!healed_ids.contains("th-healthy"));

    let mut rev_cache = HashMap::new();
    let unhealed: Vec<Value> = state
        .threads
        .iter()
        .filter(|t| json_row_id(t).is_none_or(|id| !healed_ids.contains(id)))
        .cloned()
        .collect();
    for t in &unhealed {
        if let (Some(id), Some(stamp)) = (json_row_id(t), thread_sync_stamp(t)) {
            rev_cache.insert(id.to_string(), stamp);
        }
    }
    let written = write_disk_state_with_cache(&mut conn, &state, Some(&mut rev_cache)).unwrap();
    assert_eq!(written, 1, "only the healed thread should be rewritten to SQLite");

    let persisted_json: String = conn
        .query_row("SELECT data FROM threads WHERE id = 'th-post-reply'", [], |r| r.get(0))
        .unwrap();
    let persisted: Value = serde_json::from_str(&persisted_json).unwrap();
    assert_eq!(persisted["status"], json!("idle"));
    assert!(persisted.get("turnFailure").is_none());
}

#[test]
fn test_heal_loaded_threads_settles_orphaned_running_threads_without_errors() {
    let mut conn = Connection::open_in_memory().unwrap();
    configure_sqlite_pragmas(&conn).unwrap();
    conn.execute_batch(SCHEMA_SQL).unwrap();

    let mut state = default_disk_state();
    state.threads = vec![
        json!({
            "id": "th-orphan-running",
            "revision": "rev-1",
            "createdAtUnixMs": 10,
            "updatedAtUnixMs": 20,
            "title": "Build update",
            "titleOrigin": "provisional",
            "status": "running",
            "activePlanId": "p1",
            "plans": [{ "id": "p1", "status": "implementing" }],
            "swarmState": {
                "title": "Workers",
                "members": [{ "name": "worker-1", "state": "working" }]
            },
            "subagentRuns": [
                {
                    "subagentId": "sub-done",
                    "parentThreadId": "th-orphan-running",
                    "parentToolCallId": "call-done",
                    "role": "Spec Verifier",
                    "status": "completed",
                    "completedAtUnixMs": 123
                },
                {
                    "subagentId": "sub-live",
                    "parentThreadId": "th-orphan-running",
                    "parentToolCallId": "call-live",
                    "role": "Worker",
                    "status": "running",
                    "startedAtUnixMs": 50
                },
                {
                    "subagentId": "sub-waiting",
                    "parentThreadId": "th-orphan-running",
                    "parentToolCallId": "call-waiting",
                    "role": "Waiting Worker",
                    "status": "waiting",
                    "startedAtUnixMs": 60
                },
                {
                    "subagentId": "sub-queued",
                    "parentThreadId": "th-orphan-running",
                    "parentToolCallId": "call-queued",
                    "role": "Queued Worker",
                    "status": "queued",
                    "startedAtUnixMs": 70
                }
            ],
            "items": [
                { "id": "u1", "kind": "user", "text": "Genera la actualizacion" },
                { "id": "a1", "kind": "assistant", "text": "El build termino...", "streaming": true },
                { "id": "cmd1", "kind": "tool", "toolKind": "commandExecution", "toolName": "run_command", "status": "running", "streaming": true },
                {
                    "id": "call-done",
                    "kind": "tool",
                    "toolKind": "subagent",
                    "toolName": "invoke_subagent",
                    "status": "completed",
                    "streaming": false,
                    "subagentMeta": { "subagentId": "sub-done", "status": "completed" }
                },
                {
                    "id": "call-live",
                    "kind": "tool",
                    "toolKind": "subagent",
                    "toolName": "invoke_subagent",
                    "status": "running",
                    "streaming": true,
                    "subagentMeta": { "subagentId": "sub-live", "status": "running" }
                },
                {
                    "id": "call-waiting",
                    "kind": "tool",
                    "toolKind": "subagent",
                    "toolName": "invoke_subagent",
                    "status": "running",
                    "streaming": true,
                    "subagentMeta": { "subagentId": "sub-waiting", "status": "waiting" }
                },
                {
                    "id": "call-queued",
                    "kind": "tool",
                    "toolKind": "subagent",
                    "toolName": "invoke_subagent",
                    "status": "queued",
                    "streaming": false,
                    "subagentMeta": { "subagentId": "sub-queued", "status": "queued" }
                },
                { "id": "nq", "kind": "note", "text": "The provider has not sent an update. Stop the turn if this stays quiet." }
            ]
        }),
        json!({
            "id": "th-orphan-waiting-approval",
            "revision": "rev-2",
            "createdAtUnixMs": 10,
            "updatedAtUnixMs": 20,
            "status": "running",
            "pendingApproval": { "requestId": "req-1", "toolName": "run_command" },
            "items": [
                { "id": "u1", "kind": "user", "text": "run check" }
            ]
        }),
        json!({
            "id": "th-already-waiting",
            "revision": "rev-3",
            "createdAtUnixMs": 10,
            "updatedAtUnixMs": 20,
            "status": "waiting",
            "pendingUserInput": { "requestId": "ask-1", "questions": [] },
            "items": [
                { "id": "u1", "kind": "user", "text": "ask" },
                { "id": "t_ask", "kind": "tool", "status": "pending", "streaming": false }
            ]
        }),
    ];
    write_disk_state(&mut conn, &state).unwrap();

    let healed_ids = heal_loaded_threads(&mut state.threads);
    assert!(healed_ids.contains("th-orphan-running"));
    assert!(healed_ids.contains("th-orphan-waiting-approval"));
    assert!(!healed_ids.contains("th-already-waiting"));

    let mut rev_cache = HashMap::new();
    for t in &state.threads {
        if let (Some(id), Some(stamp)) = (json_row_id(t), thread_sync_stamp(t)) {
            if !healed_ids.contains(id) {
                rev_cache.insert(id.to_string(), stamp);
            }
        }
    }
    let written = write_disk_state_with_cache(&mut conn, &state, Some(&mut rev_cache)).unwrap();
    assert_eq!(written, 2, "only the 2 healed threads should be rewritten to SQLite");

    let persisted_running_json: String = conn
        .query_row("SELECT data FROM threads WHERE id = 'th-orphan-running'", [], |r| r.get(0))
        .unwrap();
    let persisted: Value = serde_json::from_str(&persisted_running_json).unwrap();
    assert_eq!(persisted["status"], json!("idle"));
    assert!(persisted.get("turnFailure").is_none());
    assert!(persisted.get("stoppedByBuilder").is_none_or(|v| v == false));
    assert_eq!(persisted["titleOrigin"], json!("generated"));
    assert_eq!(persisted["plans"][0]["status"], json!("interrupted"));
    assert_eq!(persisted["swarmState"]["members"][0]["state"], json!("stopped"));

    let items = persisted["items"].as_array().unwrap();
    assert!(
        items.iter().all(|it| it["id"] != "nq"),
        "quiet note must be removed when healing orphaned running thread: {items:?}"
    );
    assert_eq!(items.iter().find(|it| it["id"] == "a1").unwrap()["streaming"], json!(false));
    let cmd = items.iter().find(|it| it["id"] == "cmd1").unwrap();
    assert_eq!(cmd["streaming"], json!(false));
    assert_eq!(cmd["status"], json!("stopped"));
    assert_eq!(
        items.iter().find(|it| it["id"] == "call-done").unwrap()["subagentMeta"]["status"],
        json!("completed")
    );
    let live_sub_item = items.iter().find(|it| it["id"] == "call-live").unwrap();
    assert_eq!(live_sub_item["streaming"], json!(false));
    assert_eq!(live_sub_item["subagentMeta"]["status"], json!("killed"));
    let waiting_sub_item = items.iter().find(|it| it["id"] == "call-waiting").unwrap();
    assert_eq!(waiting_sub_item["streaming"], json!(false));
    assert_eq!(waiting_sub_item["status"], json!("killed"));
    assert_eq!(waiting_sub_item["subagentMeta"]["status"], json!("killed"));
    let queued_sub_item = items.iter().find(|it| it["id"] == "call-queued").unwrap();
    assert_eq!(queued_sub_item["status"], json!("killed"));
    assert_eq!(queued_sub_item["subagentMeta"]["status"], json!("killed"));

    let runs = persisted["subagentRuns"].as_array().unwrap();
    assert_eq!(runs[0]["status"], json!("completed"));
    assert_eq!(runs[0]["completedAtUnixMs"], json!(123));
    assert_eq!(runs[1]["status"], json!("killed"));
    assert!(runs[1]["completedAtUnixMs"].as_i64().is_some());
    assert_eq!(runs[2]["status"], json!("killed"));
    assert!(runs[2]["completedAtUnixMs"].as_i64().is_some());
    assert_eq!(runs[3]["status"], json!("killed"));
    assert!(runs[3]["completedAtUnixMs"].as_i64().is_some());

    let waiting_json: String = conn
        .query_row("SELECT data FROM threads WHERE id = 'th-orphan-waiting-approval'", [], |r| r.get(0))
        .unwrap();
    let waiting: Value = serde_json::from_str(&waiting_json).unwrap();
    assert_eq!(waiting["status"], json!("waiting"));
}

#[test]
fn heal_loaded_threads_settles_idle_parents_holding_orphaned_subagents_items_and_swarms() {
    struct TempDirGuard(std::path::PathBuf);
    impl Drop for TempDirGuard {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    let dir = std::env::temp_dir().join(format!(
        "kite-persist-idle-heal-{}",
        uuid::Uuid::new_v4().simple()
    ));
    let _guard = TempDirGuard(dir.clone());
    let done_logs = dir.join("done-sub").join(".system_generated").join("logs");
    fs::create_dir_all(&done_logs).unwrap();
    let done_file = done_logs.join("transcript.jsonl");
    fs::write(
        &done_file,
        format!(
            "{}\n",
            json!({
                "step_index": 8,
                "type": "PLANNER_RESPONSE",
                "status": "DONE",
                "tool_calls": [],
                "content": "Final verdict: PASS."
            })
        ),
    )
    .unwrap();
    let done_uri = format!("file:///{}", done_file.to_string_lossy().replace('\\', "/"));

    let mut conn = Connection::open_in_memory().unwrap();
    configure_sqlite_pragmas(&conn).unwrap();
    conn.execute_batch(SCHEMA_SQL).unwrap();
    let mut state = default_disk_state();
    state.threads = vec![
        json!({
            "id": "parent-idle-orphans",
            "revision": "rev-p1",
            "createdAtUnixMs": 10,
            "updatedAtUnixMs": 20,
            "status": "idle",
            "provider": "antigravity",
            "providerSessionId": null,
            "swarmState": {
                "members": [{ "name": "worker-1", "state": "working" }]
            },
            "subagentRuns": [
                {
                    "subagentId": "done-sub",
                    "parentThreadId": "parent-idle-orphans",
                    "parentToolCallId": "call-done-sub",
                    "role": "Spec Verifier",
                    "status": "running",
                    "transcriptUri": done_uri,
                    "startedAtUnixMs": 100,
                    "updatedAtUnixMs": 110
                },
                {
                    "subagentId": "aborted-sub",
                    "parentThreadId": "parent-idle-orphans",
                    "parentToolCallId": "call-aborted-sub",
                    "role": "Aborted Worker",
                    "status": "running",
                    "startedAtUnixMs": 100,
                    "updatedAtUnixMs": 110
                },
                {
                    "subagentId": "child-settled",
                    "parentThreadId": "parent-idle-orphans",
                    "parentToolCallId": "call-child-settled",
                    "childThreadId": "child-settled",
                    "role": "Settled Child",
                    "status": "running",
                    "startedAtUnixMs": 100,
                    "updatedAtUnixMs": 110
                },
                {
                    "subagentId": "child-crashed",
                    "parentThreadId": "parent-idle-orphans",
                    "parentToolCallId": "call-child-crashed",
                    "childThreadId": "child-crashed",
                    "role": "Crashed Child",
                    "status": "running",
                    "startedAtUnixMs": 100,
                    "updatedAtUnixMs": 110
                },
                {
                    "subagentId": "killed-sub",
                    "parentThreadId": "parent-idle-orphans",
                    "parentToolCallId": "call-463",
                    "role": "Split Verifier",
                    "status": "killed",
                    "startedAtUnixMs": 100,
                    "updatedAtUnixMs": 200,
                    "completedAtUnixMs": 200
                },
                {
                    "subagentId": "child-post-reply-healed",
                    "parentThreadId": "parent-idle-orphans",
                    "parentToolCallId": "call-child-healed",
                    "childThreadId": "child-post-reply-healed",
                    "role": "Post Reply Healed Child",
                    "status": "running",
                    "startedAtUnixMs": 100,
                    "updatedAtUnixMs": 110
                }
            ],
            "items": [
                {
                    "id": "call-done-sub",
                    "kind": "tool",
                    "toolKind": "subagent",
                    "toolName": "invoke_subagent",
                    "status": "failed",
                    "streaming": false,
                    "text": "Interrupted before completion; retried in subsequent steps.",
                    "subagentMeta": { "subagentId": "done-sub", "status": "running", "transcriptUri": done_uri }
                },
                {
                    "id": "call-267-split",
                    "kind": "tool",
                    "toolKind": "subagent",
                    "toolName": "invoke_subagent",
                    "status": "failed",
                    "streaming": true,
                    "subagentMeta": { "subagentId": "killed-sub", "status": "running" }
                }
            ]
        }),
        json!({
            "id": "child-settled",
            "revision": "rev-c1",
            "createdAtUnixMs": 10,
            "updatedAtUnixMs": 20,
            "status": "idle",
            "parentThreadId": "parent-idle-orphans",
            "items": [{ "id": "a1", "kind": "assistant", "text": "Done", "streaming": false }]
        }),
        json!({
            "id": "child-crashed",
            "revision": "rev-c2",
            "createdAtUnixMs": 10,
            "updatedAtUnixMs": 20,
            "status": "running",
            "parentThreadId": "parent-idle-orphans",
            "items": [{ "id": "a2", "kind": "assistant", "text": "Working...", "streaming": true }]
        }),
        json!({
            "id": "child-post-reply-healed",
            "revision": "rev-c3",
            "createdAtUnixMs": 10,
            "updatedAtUnixMs": 20,
            "status": "error",
            "parentThreadId": "parent-idle-orphans",
            "turnFailure": {
                "kind": "processError",
                "exit_code": 1,
                "message": "API error (attempt 5): dial tcp: lookup daily-cloudcode-pa.googleapis.com: no such host"
            },
            "items": [
                { "id": "u3", "kind": "user", "text": "Run task" },
                { "id": "a3", "kind": "assistant", "text": "Completed work.", "streaming": false }
            ]
        }),
    ];
    write_disk_state(&mut conn, &state).unwrap();

    let healed = heal_loaded_threads(&mut state.threads);
    assert!(healed.contains("parent-idle-orphans"));
    assert!(healed.contains("child-crashed"));
    assert!(healed.contains("child-post-reply-healed"));

    let parent = state.threads.iter().find(|t| t["id"] == "parent-idle-orphans").unwrap();
    assert_eq!(parent["swarmState"]["members"][0]["state"], json!("stopped"));
    assert_eq!(parent["subagentRuns"][0]["status"], json!("completed"));
    assert_eq!(parent["subagentRuns"][1]["status"], json!("killed"));
    assert_eq!(parent["subagentRuns"][2]["status"], json!("completed"));
    assert_eq!(parent["subagentRuns"][3]["status"], json!("killed"));
    assert_eq!(parent["subagentRuns"][4]["status"], json!("killed"));
    assert_eq!(parent["subagentRuns"][5]["status"], json!("completed"));
    assert_eq!(parent["items"][0]["status"], json!("completed"));
    assert_eq!(parent["items"][0]["text"], json!(""));
    assert_eq!(parent["items"][0]["subagentMeta"]["status"], json!("completed"));
    assert_eq!(parent["items"][1]["streaming"], json!(false));
    assert_eq!(parent["items"][1]["subagentMeta"]["status"], json!("killed"));
}

#[test]
fn test_dirty_only_thread_snapshot_and_delete() {
    let mut conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(SCHEMA_SQL).unwrap();

    let mut threads = vec![
        json!({ "id": "t-dirty", "revision": "rev-1", "createdAtUnixMs": 10, "updatedAtUnixMs": 100, "title": "first" }),
        json!({ "id": "t-clean", "revision": "rev-1", "createdAtUnixMs": 20, "updatedAtUnixMs": 200, "title": "untouched" }),
    ];
    let mut rev_cache = ThreadRevCache::new();

    let (dirty_1, ids_1) = collect_dirty_threads(&threads, &rev_cache);
    assert_eq!(dirty_1.len(), 2);
    assert_eq!(ids_1, vec!["t-dirty", "t-clean"]);

    let snap_1 = DirtyDiskSnapshot {
        workspaces: vec![],
        paths: HashMap::new(),
        agents: vec![],
        dirty_threads: dirty_1,
        live_thread_ids: ids_1,
        last_provider: "claude".into(),
        last_model: None,
        last_effort: None,
        grid: Value::Null,
        revision: 1,
        routines: vec![],
        notifications: vec![],
    };
    let written_1 = write_dirty_disk_state_with_cache(&mut conn, &snap_1, Some(&mut rev_cache)).unwrap();
    assert_eq!(written_1, 2);

    // Mutate only t-dirty; t-clean stays untouched.
    threads[0]["title"] = json!("updated-first");
    threads[0]["revision"] = json!("rev-2");
    threads[0]["updatedAtUnixMs"] = json!(150);

    let (dirty_2, ids_2) = collect_dirty_threads(&threads, &rev_cache);
    assert_eq!(dirty_2.len(), 1);
    assert_eq!(dirty_2[0]["id"], json!("t-dirty"));
    assert_eq!(ids_2, vec!["t-dirty", "t-clean"]);

    let snap_2 = DirtyDiskSnapshot {
        dirty_threads: dirty_2,
        live_thread_ids: ids_2,
        ..snap_1
    };
    let written_2 = write_dirty_disk_state_with_cache(&mut conn, &snap_2, Some(&mut rev_cache)).unwrap();
    assert_eq!(written_2, 1);

    let clean_title: String = conn
        .query_row("SELECT json_extract(data, '$.title') FROM threads WHERE id = 't-clean'", [], |r| r.get(0))
        .unwrap();
    let dirty_title: String = conn
        .query_row("SELECT json_extract(data, '$.title') FROM threads WHERE id = 't-dirty'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(clean_title, "untouched");
    assert_eq!(dirty_title, "updated-first");

    // Delete t-clean and flush; t-clean must be removed while t-dirty remains.
    threads.retain(|t| t["id"] != "t-clean");
    let (dirty_3, ids_3) = collect_dirty_threads(&threads, &rev_cache);
    assert!(dirty_3.is_empty());
    assert_eq!(ids_3, vec!["t-dirty"]);
    let snap_3 = DirtyDiskSnapshot {
        dirty_threads: dirty_3,
        live_thread_ids: ids_3,
        ..snap_2
    };
    let written_3 = write_dirty_disk_state_with_cache(&mut conn, &snap_3, Some(&mut rev_cache)).unwrap();
    assert_eq!(written_3, 0);
    assert_eq!(count_where(&conn, "SELECT COUNT(*) FROM threads WHERE id = ?1", "t-clean"), 0);
    assert_eq!(count_where(&conn, "SELECT COUNT(*) FROM threads WHERE id = ?1", "t-dirty"), 1);
}

#[test]
fn test_sqlite_pragmas_and_wal_checkpoint() {
    let dir = std::env::temp_dir().join(format!("kite-wal-test-{}", uuid::Uuid::new_v4().simple()));
    fs::create_dir_all(&dir).unwrap();
    let db_file = dir.join("test.sqlite");
    let wal_file = PathBuf::from(format!("{}-wal", db_file.display()));

    let conn = Connection::open(&db_file).unwrap();
    configure_sqlite_pragmas(&conn).unwrap();
    conn.execute_batch(SCHEMA_SQL).unwrap();

    let cache_size: i64 = conn.query_row("PRAGMA cache_size", [], |r| r.get(0)).unwrap();
    assert_eq!(cache_size, -8000);
    let journal_mode: String = conn.query_row("PRAGMA journal_mode", [], |r| r.get(0)).unwrap();
    assert_eq!(journal_mode.to_ascii_lowercase(), "wal");

    conn.execute(
        "INSERT INTO app_state (key, value) VALUES ('k1', 'v1')",
        [],
    )
    .unwrap();
    let (busy, _log, _checkpointed) =
        checkpoint_wal_on_conn(&conn, Some(&wal_file), true).unwrap();
    assert_eq!(busy, 0);

    drop(conn);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn test_daemon_direct_sql_reads_without_stores() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(SCHEMA_SQL).unwrap();
    conn.execute(
        "INSERT INTO workspaces (id, display_name, folder_path, created_at_unix_ms, last_opened_at_unix_ms, pinned, available, sort_order)
         VALUES ('ws-direct', 'Direct WS', 'C:/repo/direct', 1, 2, 1, 1, 0)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO agents (id, name, engine, purpose, brief, created_at_unix_ms, pinned, sort_order)
         VALUES ('ag-direct', 'Direct Agent', 'claude', 'purpose', 'brief text', 1, 0, 0)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO threads (id, data, created_at_unix_ms, updated_at_unix_ms)
         VALUES ('th-unloaded', '{\"id\":\"th-unloaded\"}', 1, 2)",
        [],
    )
    .unwrap();

    let (workspaces, _paths) = read_workspaces_from_conn(&conn).unwrap();
    assert_eq!(workspaces.len(), 1);
    assert_eq!(workspaces[0].id, "ws-direct");
    assert_eq!(
        read_workspace_path_from_conn(&conn, "ws-direct").as_deref(),
        Some("C:/repo/direct")
    );
    let agents = read_agents_from_conn(&conn).unwrap();
    assert_eq!(agents.len(), 1);
    assert_eq!(agents[0].id, "ag-direct");
    assert_eq!(
        read_agent_by_id_from_conn(&conn, "ag-direct").map(|a| a.brief),
        Some("brief text".to_string())
    );
}

#[test]
fn test_initial_state_moves_into_stores_once() {
    let _: () = initial_state();
    assert!(stores_initialized());
    // Calling initial_state() a second time is an idempotent no-op and all moved stores stay readable.
    let _: () = initial_state();
    assert!(stores_initialized());
    let _ws_len = workspaces().lock().unwrap().len();
    let _ag_len = agents().lock().unwrap().len();
    let _th_len = threads().lock().unwrap().len();
}

