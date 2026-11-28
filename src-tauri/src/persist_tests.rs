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

#[test]
fn test_seed_routines_have_valid_uuid_and_heal_migrates_legacy_seed() {
    for routine in seed_routines() {
        let id = routine
            .get("id")
            .and_then(Value::as_str)
            .expect("seeded routine must have id");
        assert!(
            uuid::Uuid::parse_str(id).is_ok(),
            "seeded routine id '{id}' must be a valid UUID"
        );
    }

    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(SCHEMA_SQL).unwrap();
    let legacy_id = "r1111111-1111-4111-8111-111111111111";
    conn.execute(
        "INSERT INTO routine_runs (run_id, routine_id, agent_id, trigger_kind, status, started_at_unix_ms, finished_at_unix_ms, thread_id, summary, changed_files_count, retry_attempt, error)
         VALUES ('run-legacy-1', ?1, 'c3333333-3333-4333-8333-333333333333', 'schedule', 'succeeded', 100, 200, 'th-1', 'ok', 0, 0, NULL)",
        [legacy_id],
    )
    .unwrap();

    let mut loaded_routines = vec![json!({
        "id": legacy_id,
        "agentId": "c3333333-3333-4333-8333-333333333333",
        "name": "Daily Project Health Check",
        "enabled": true,
    })];
    let mut loaded_notifications = vec![json!({
        "id": "e1111111-1111-4111-8111-111111111111",
        "routineId": legacy_id,
    })];

    let changed = heal_loaded_routines_in_conn(&conn, &mut loaded_routines, &mut loaded_notifications);
    assert!(changed, "legacy non-UUID routine id should be migrated");
    let healed_id = loaded_routines[0]["id"].as_str().unwrap();
    assert_eq!(healed_id, SEEDED_HEALTH_CHECK_ROUTINE_ID);
    assert!(uuid::Uuid::parse_str(healed_id).is_ok());
    assert_eq!(loaded_notifications[0]["routineId"].as_str(), Some(healed_id));

    let migrated_runs: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM routine_runs WHERE routine_id = ?1",
            [healed_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(migrated_runs, 1);

    let changed_again =
        heal_loaded_routines_in_conn(&conn, &mut loaded_routines, &mut loaded_notifications);
    assert!(!changed_again, "healing legacy routine ids must be idempotent");
}

#[test]
fn test_stub_never_overwrites_full_row_or_gets_pruned_on_persist() {
    let mut conn = Connection::open_in_memory().unwrap();
    configure_sqlite_pragmas(&conn).unwrap();
    conn.execute_batch(SCHEMA_SQL).unwrap();

    let full_stub_target = json!({
        "id": "th-stubbed",
        "title": "Full Title",
        "status": "idle",
        "provider": "claude",
        "model": "claude-sonnet-4-5",
        "effort": "high",
        "providerOptions": [{ "id": "opt-1" }],
        "workspaceId": "ws-1",
        "profileId": "ag-1",
        "parentThreadId": "parent-0",
        "providerSessionId": "sess-1",
        "archived": false,
        "startedByAgent": true,
        "workingDirectory": "C:/repo",
        "worktreePath": "C:/repo/.wt",
        "createdAtUnixMs": 100,
        "updatedAtUnixMs": 200,
        "revision": "rev-1",
        "usage": { "inputTokens": 42 },
        "mode": "fullAccess",
        "permissionMode": "auto",
        "sessionState": "ready",
        "lastActiveAtUnixMs": 200,
        "worktreeBranch": "feat/test",
        "unread": true,
        "subagentRuns": [{
            "subagentId": "sub-1",
            "status": "completed",
            "stepCount": 1,
            "items": [{ "id": "si-1", "kind": "assistant", "text": "sub output" }]
        }],
        "items": [
            { "id": "u1", "kind": "user", "text": "hello" },
            { "id": "a1", "kind": "assistant", "text": "world" }
        ]
    });
    let active_thread = json!({
        "id": "th-active",
        "title": "Active",
        "status": "idle",
        "createdAtUnixMs": 150,
        "updatedAtUnixMs": 250,
        "revision": "rev-2",
        "items": [{ "id": "u2", "kind": "user", "text": "stay full" }]
    });

    let mut rev_cache = ThreadRevCache::new();
    let initial = DiskState {
        workspaces: vec![],
        paths: HashMap::new(),
        agents: vec![],
        threads: vec![full_stub_target.clone(), active_thread.clone()],
        last_provider: "claude".into(),
        last_model: None,
        last_effort: None,
        grid: Value::Null,
        revision: 1,
        routines: vec![],
        notifications: vec![],
    };
    write_disk_state_with_cache(&mut conn, &initial, Some(&mut rev_cache)).unwrap();

    let stub = to_thread_stub(&full_stub_target);
    assert!(is_thread_stub(&stub));
    assert_eq!(stub["_kiteStub"], json!(true));
    assert_eq!(stub["itemCount"], json!(2));
    assert_eq!(stub["items"], json!([]));
    assert_eq!(
        stub["subagentRuns"][0]
            .get("items")
            .and_then(Value::as_array)
            .map_or(0, Vec::len),
        0
    );
    for key in [
        "id",
        "title",
        "status",
        "provider",
        "model",
        "effort",
        "providerOptions",
        "workspaceId",
        "profileId",
        "parentThreadId",
        "providerSessionId",
        "archived",
        "startedByAgent",
        "workingDirectory",
        "worktreePath",
        "createdAtUnixMs",
        "updatedAtUnixMs",
        "revision",
        "usage",
        "mode",
        "permissionMode",
        "sessionState",
        "lastActiveAtUnixMs",
        "worktreeBranch",
        "unread",
    ] {
        assert_eq!(stub.get(key), full_stub_target.get(key), "stub must preserve {key}");
    }
    // Stubbing an already-stubbed thread must preserve itemCount.
    let stub_again = to_thread_stub(&stub);
    assert_eq!(stub_again["itemCount"], json!(2));

    // Even if a stub is mutated in memory without hydration (or lacks revision), persist must neither
    // overwrite the SQLite row nor prune it.
    let mut mutated_stub = stub.clone();
    mutated_stub["title"] = json!("Must Not Clobber");
    mutated_stub["revision"] = json!("rev-stub-mutated");
    mutated_stub["updatedAtUnixMs"] = json!(999);

    let mut mutated_active = active_thread.clone();
    mutated_active["title"] = json!("Active Updated");
    mutated_active["revision"] = json!("rev-3");
    mutated_active["updatedAtUnixMs"] = json!(350);

    let in_mem = vec![mutated_stub.clone(), mutated_active.clone()];
    let (dirty, live_ids) = collect_dirty_threads(&in_mem, &rev_cache);
    assert_eq!(live_ids, vec!["th-stubbed", "th-active"]);
    assert_eq!(dirty.len(), 1);
    assert_eq!(dirty[0]["id"], json!("th-active"));

    let snap = DirtyDiskSnapshot {
        workspaces: vec![],
        paths: HashMap::new(),
        agents: vec![],
        dirty_threads: dirty,
        live_thread_ids: live_ids,
        last_provider: "claude".into(),
        last_model: None,
        last_effort: None,
        grid: Value::Null,
        revision: 2,
        routines: vec![],
        notifications: vec![],
    };
    let written = write_dirty_disk_state_with_cache(&mut conn, &snap, Some(&mut rev_cache)).unwrap();
    assert_eq!(written, 1);

    // Also verify upsert_threads_into_tx directly skips stubs while collecting live_ids.
    let mut direct_no_cache_state = initial.clone();
    direct_no_cache_state.threads = vec![mutated_stub, mutated_active];
    let written_direct = write_disk_state_with_cache(&mut conn, &direct_no_cache_state, None).unwrap();
    assert_eq!(written_direct, 1);

    assert_eq!(count_where(&conn, "SELECT COUNT(*) FROM threads WHERE id = ?1", "th-stubbed"), 1);
    let stored = find_thread_from_conn(&conn, "th-stubbed").unwrap();
    assert!(!is_thread_stub(&stored));
    assert_eq!(stored["title"], json!("Full Title"));
    assert_eq!(stored["items"].as_array().unwrap().len(), 2);
    assert_eq!(stored["subagentRuns"][0]["items"].as_array().unwrap().len(), 1);
}

#[test]
fn test_hydrate_thread_restores_full_items_and_clears_stub() {
    let mut conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(SCHEMA_SQL).unwrap();

    let full = json!({
        "id": "th-hydrate-1",
        "title": "Original",
        "status": "idle",
        "createdAtUnixMs": 100,
        "updatedAtUnixMs": 200,
        "revision": "rev-1",
        "items": [
            { "id": "i1", "kind": "user", "text": "one" },
            { "id": "i2", "kind": "assistant", "text": "two" },
            { "id": "i3", "kind": "assistant", "text": "three" }
        ]
    });
    let mut rev_cache = ThreadRevCache::new();
    let state = DiskState {
        workspaces: vec![],
        paths: HashMap::new(),
        agents: vec![],
        threads: vec![full.clone()],
        last_provider: "claude".into(),
        last_model: None,
        last_effort: None,
        grid: Value::Null,
        revision: 1,
        routines: vec![],
        notifications: vec![],
    };
    write_disk_state_with_cache(&mut conn, &state, Some(&mut rev_cache)).unwrap();

    let mut touched_stub = to_thread_stub(&full);
    touched_stub["title"] = json!("Renamed In Stub");
    touched_stub["updatedAtUnixMs"] = json!(250);
    touched_stub["revision"] = json!("rev-2");

    let mut mem_threads = vec![touched_stub];
    let mut lru = std::collections::VecDeque::new();

    assert!(!hydrate_thread_in_state(
        &mut conn,
        &mut mem_threads,
        &mut lru,
        &mut rev_cache,
        "missing-thread",
    ));
    assert!(hydrate_thread_in_state(
        &mut conn,
        &mut mem_threads,
        &mut lru,
        &mut rev_cache,
        "th-hydrate-1",
    ));
    assert!(!is_thread_stub(&mem_threads[0]));
    assert!(mem_threads[0].get("_kiteStub").is_none());
    assert!(mem_threads[0].get("itemCount").is_none());
    assert_eq!(mem_threads[0]["items"].as_array().unwrap().len(), 3);
    assert_eq!(mem_threads[0]["title"], json!("Renamed In Stub"));
    assert_eq!(mem_threads[0]["updatedAtUnixMs"], json!(250));
    assert_eq!(lru.back().map(String::as_str), Some("th-hydrate-1"));

    // Public hydrate_thread smoke check against global db_connection() and threads().
    struct PublicThreadCleanup {
        id: String,
    }
    impl Drop for PublicThreadCleanup {
        fn drop(&mut self) {
            if let Ok(mut list) = threads().lock() {
                list.retain(|t| json_row_id(t) != Some(self.id.as_str()));
            }
            if let Ok(mut lru) = hydrated_lru().lock() {
                lru.retain(|id| id != &self.id);
            }
            if let Ok(mut revs) = persisted_thread_revs().lock() {
                revs.remove(&self.id);
            }
            if let Ok(conn) = db_connection().lock() {
                let _ = conn.execute("DELETE FROM threads WHERE id = ?1", [&self.id]);
            }
        }
    }

    let pub_tid = format!("th-pub-hydrate-{}", uuid::Uuid::new_v4().simple());
    let _cleanup = PublicThreadCleanup { id: pub_tid.clone() };
    let pub_full = json!({
        "id": pub_tid,
        "title": "Public Hydrate",
        "status": "idle",
        "createdAtUnixMs": 100,
        "updatedAtUnixMs": 200,
        "revision": "rev-pub-1",
        "items": [{ "id": "p1", "kind": "user", "text": "hi" }]
    });
    {
        let conn = db_connection().lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO threads (id, data, created_at_unix_ms, updated_at_unix_ms) VALUES (?1, ?2, 100, 200)",
            params![pub_tid, serde_json::to_string(&pub_full).unwrap()],
        )
        .unwrap();
    }
    {
        let mut list = threads().lock().unwrap();
        list.push(to_thread_stub(&pub_full));
    }

    assert!(!hydrate_thread("nonexistent-public-thread-xyz"));
    assert!(hydrate_thread(&pub_tid));
    let list = threads().lock().unwrap();
    let hydrated = list.iter().find(|t| json_row_id(t) == Some(pub_tid.as_str())).unwrap();
    assert!(!is_thread_stub(hydrated));
    assert!(hydrated.get("_kiteStub").is_none());
    assert_eq!(hydrated["items"].as_array().unwrap().len(), 1);
}

#[test]
fn test_hydrate_lru_flushes_dirty_and_dehydrates_oldest_non_running() {
    assert_eq!(MAX_HYDRATED_THREADS, 8);
    let mut conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(SCHEMA_SQL).unwrap();

    let mut full_threads = Vec::new();
    for idx in 1..=10 {
        let status = match idx {
            1 => "running",
            2 => "waiting",
            _ => "idle",
        };
        full_threads.push(json!({
            "id": format!("th-{idx}"),
            "title": format!("Thread {idx}"),
            "status": status,
            "createdAtUnixMs": idx as i64 * 10,
            "updatedAtUnixMs": idx as i64 * 100,
            "revision": format!("rev-{idx}-v1"),
            "items": [{ "id": format!("item-{idx}-1"), "kind": "user", "text": format!("msg {idx}") }]
        }));
    }

    let mut rev_cache = ThreadRevCache::new();
    let state = DiskState {
        workspaces: vec![],
        paths: HashMap::new(),
        agents: vec![],
        threads: full_threads.clone(),
        last_provider: "claude".into(),
        last_model: None,
        last_effort: None,
        grid: Value::Null,
        revision: 1,
        routines: vec![],
        notifications: vec![],
    };
    write_disk_state_with_cache(&mut conn, &state, Some(&mut rev_cache)).unwrap();

    let mut mem_threads: Vec<Value> = full_threads.iter().map(to_thread_stub).collect();
    let mut lru = std::collections::VecDeque::new();

    for idx in 1..=MAX_HYDRATED_THREADS {
        let tid = format!("th-{idx}");
        assert!(hydrate_thread_in_state(&mut conn, &mut mem_threads, &mut lru, &mut rev_cache, &tid));
    }
    assert!(mem_threads.iter().take(8).all(|t| !is_thread_stub(t)));

    // Mutate th-3 (oldest idle thread) in memory without calling persist() first.
    {
        let t3 = mem_threads.iter_mut().find(|t| t["id"] == "th-3").unwrap();
        t3["items"].as_array_mut().unwrap().push(json!({
            "id": "item-3-2",
            "kind": "assistant",
            "text": "unsaved reply"
        }));
        t3["revision"] = json!("rev-3-dirty");
        t3["updatedAtUnixMs"] = json!(9999);
    }

    // Hydrate th-9 -> exceeds MAX_HYDRATED_THREADS; must skip th-1 (running) & th-2 (waiting),
    // flush dirty th-3 to SQLite, and dehydrate th-3 to a stub.
    assert!(hydrate_thread_in_state(&mut conn, &mut mem_threads, &mut lru, &mut rev_cache, "th-9"));

    let t1 = mem_threads.iter().find(|t| t["id"] == "th-1").unwrap();
    let t2 = mem_threads.iter().find(|t| t["id"] == "th-2").unwrap();
    let t3 = mem_threads.iter().find(|t| t["id"] == "th-3").unwrap();
    let t9 = mem_threads.iter().find(|t| t["id"] == "th-9").unwrap();
    assert!(!is_thread_stub(t1), "running thread must never be dehydrated");
    assert!(!is_thread_stub(t2), "waiting thread must never be dehydrated");
    assert!(is_thread_stub(t3), "oldest idle thread must be dehydrated beyond MAX_HYDRATED_THREADS");
    assert_eq!(t3["itemCount"], json!(2));
    assert_eq!(t3["items"], json!([]));
    assert!(!is_thread_stub(t9));

    let persisted_t3 = find_thread_from_conn(&conn, "th-3").unwrap();
    assert_eq!(persisted_t3["revision"], json!("rev-3-dirty"));
    assert_eq!(persisted_t3["items"].as_array().unwrap().len(), 2);
    assert_eq!(persisted_t3["items"][1]["text"], json!("unsaved reply"));

    // Now dehydrate all idle threads except th-9 via dehydrate_idle_threads_in_state.
    let dehydrated = dehydrate_idle_threads_in_state(
        &mut conn,
        &mut mem_threads,
        &mut lru,
        &mut rev_cache,
        &["th-9"],
    );
    assert_eq!(dehydrated, 5, "th-4..=th-8 should dehydrate while th-1 (running), th-2 (waiting), th-9 (keep_ids) stay hydrated");
    assert!(!is_thread_stub(mem_threads.iter().find(|t| t["id"] == "th-1").unwrap()));
    assert!(!is_thread_stub(mem_threads.iter().find(|t| t["id"] == "th-2").unwrap()));
    assert!(!is_thread_stub(mem_threads.iter().find(|t| t["id"] == "th-9").unwrap()));
    for idx in 3..=8 {
        assert!(is_thread_stub(
            mem_threads.iter().find(|t| t["id"] == format!("th-{idx}")).unwrap()
        ));
    }
}

#[test]
fn test_direct_helpers_do_not_initialize_stores() {
    // Verify isolated _from_conn behavior first.
    let conn_mem = Connection::open_in_memory().unwrap();
    conn_mem.execute_batch(SCHEMA_SQL).unwrap();
    conn_mem.execute(
        "INSERT INTO workspaces (id, display_name, folder_path, created_at_unix_ms, last_opened_at_unix_ms, pinned, available, sort_order)
         VALUES ('ws-m1', 'Mem WS', 'C:/mem/ws', 1, 2, 0, 1, 0)",
        [],
    ).unwrap();
    conn_mem.execute(
        "INSERT INTO threads (id, data, created_at_unix_ms, updated_at_unix_ms)
         VALUES ('th-m1', ?1, 1, 2)",
        [serde_json::to_string(&json!({
            "id": "th-m1",
            "title": "Direct Query",
            "updatedAtUnixMs": 2,
            "items": [{ "id": "x1", "kind": "user", "text": "hello" }, { "id": "x2", "kind": "assistant", "text": "world" }]
        })).unwrap()],
    ).unwrap();

    assert_eq!(all_workspace_paths_from_conn(&conn_mem).get("ws-m1").map(String::as_str), Some("C:/mem/ws"));
    assert_eq!(find_thread_from_conn(&conn_mem, "th-m1").unwrap()["items"].as_array().unwrap().len(), 2);
    let mem_summaries = list_threads_summaries_from_conn(&conn_mem);
    assert_eq!(mem_summaries.len(), 1);
    assert!(is_thread_stub(&mem_summaries[0]));
    assert_eq!(mem_summaries[0]["itemCount"], json!(2));

    // Verify public *_direct helpers against db_connection() never touch stores().
    struct DirectDbCleanup {
        ws_id: String,
        th_id: String,
    }
    impl Drop for DirectDbCleanup {
        fn drop(&mut self) {
            if let Ok(conn) = db_connection().lock() {
                let _ = conn.execute("DELETE FROM workspaces WHERE id = ?1", [&self.ws_id]);
                let _ = conn.execute("DELETE FROM threads WHERE id = ?1", [&self.th_id]);
            }
        }
    }

    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let ws_id = format!("ws-direct-no-stores-{suffix}");
    let th_id = format!("th-direct-no-stores-{suffix}");
    let _cleanup = DirectDbCleanup { ws_id: ws_id.clone(), th_id: th_id.clone() };
    {
        let conn = db_connection().lock().unwrap();
        conn.execute(
            "INSERT INTO workspaces (id, display_name, folder_path, created_at_unix_ms, last_opened_at_unix_ms, pinned, available, sort_order)
             VALUES (?1, 'Direct Test WS', 'C:/direct/test', 10, 20, 0, 1, 999)",
            [&ws_id],
        ).unwrap();
        conn.execute(
            "INSERT INTO threads (id, data, created_at_unix_ms, updated_at_unix_ms)
             VALUES (?1, ?2, 10, 20)",
            params![
                th_id,
                serde_json::to_string(&json!({
                    "id": th_id,
                    "title": "Daemon Direct Thread",
                    "updatedAtUnixMs": 20,
                    "items": [{ "id": "d1", "kind": "user", "text": "one" }, { "id": "d2", "kind": "assistant", "text": "two" }]
                })).unwrap()
            ],
        ).unwrap();
    }

    reset_test_thread_touched_stores();
    let found = find_thread_direct(&th_id).expect("find_thread_direct must return inserted row");
    assert_eq!(found["items"].as_array().unwrap().len(), 2);

    let summaries = list_threads_direct_summaries();
    let summary = summaries.iter().find(|t| json_row_id(t) == Some(th_id.as_str())).expect("summary present");
    assert!(is_thread_stub(summary));
    assert_eq!(summary["items"], json!([]));
    assert_eq!(summary["itemCount"], json!(2));

    let ws_paths = all_workspace_paths_direct();
    assert_eq!(ws_paths.get(&ws_id).map(String::as_str), Some("C:/direct/test"));

    let ws_list = list_workspaces_direct();
    assert!(ws_list.iter().any(|w| w.id == ws_id));

    assert!(
        !test_thread_touched_stores(),
        "direct SQLite helpers must NEVER call stores() / initialize PersistStores"
    );
}

#[test]
fn test_migrate_compact_legacy_sqlite() {
    struct TempDirCleanup(PathBuf);
    impl Drop for TempDirCleanup {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    let root = std::env::temp_dir().join(format!("kite-compact-test-{}", uuid::Uuid::new_v4().simple()));
    fs::create_dir_all(&root).unwrap();
    let _cleanup = TempDirCleanup(root.clone());

    let db_file = root.join("compact.sqlite");
    let attachments_dir = root.join("chat-attachments");
    let existing_img = root.join("existing-preview.png");
    fs::write(&existing_img, b"existing-png-bytes").unwrap();
    let existing_img_str = existing_img.to_string_lossy().to_string();

    let raw_png_bytes = b"\x89PNG\r\n\x1a\nfake-legacy-image-payload";
    let b64_png = base64::engine::general_purpose::STANDARD.encode(raw_png_bytes);
    let data_url = format!("data:image/png;base64,{b64_png}");

    let mut conn = Connection::open(&db_file).unwrap();
    configure_sqlite_pragmas(&conn).unwrap();
    conn.execute_batch(SCHEMA_SQL).unwrap();
    conn.execute_batch(
        "CREATE TABLE dispatch_audit (
            id TEXT PRIMARY KEY,
            op TEXT NOT NULL,
            address TEXT NOT NULL,
            body TEXT NOT NULL,
            status TEXT NOT NULL,
            submitted INTEGER NOT NULL,
            historical INTEGER NOT NULL,
            sender_name TEXT NOT NULL,
            profile_id TEXT NOT NULL,
            error TEXT,
            created_ms INTEGER NOT NULL,
            thread_id TEXT
        );",
    ).unwrap();

    // Insert 2,050 dispatch_audit rows inside a transaction for speed.
    {
        let tx = conn.transaction().unwrap();
        let mut stmt = tx.prepare(
            "INSERT INTO dispatch_audit (id, op, address, body, status, submitted, historical, sender_name, profile_id, error, created_ms, thread_id)
             VALUES (?1, 'send', 'thread:t1', 'msg', 'ok', 1, 0, 'Agent', '', NULL, ?2, 't1')"
        ).unwrap();
        for i in 1..=2050i64 {
            stmt.execute(params![format!("aud-{i:04}"), i]).unwrap();
        }
        drop(stmt);
        tx.commit().unwrap();
    }

    // Create > 8 MiB of freelist pages so VACUUM runs as part of compaction.
    conn.execute_batch(
        "CREATE TABLE bloat_scratch (payload BLOB);
         INSERT INTO bloat_scratch (payload) VALUES (zeroblob(9 * 1024 * 1024));
         DROP TABLE bloat_scratch;",
    ).unwrap();
    let freelist_before: i64 = conn.query_row("PRAGMA freelist_count", [], |r| r.get(0)).unwrap();
    assert!(freelist_before > 0);

    let legacy_thread = json!({
        "id": "th-legacy-compact",
        "title": "Legacy Thread",
        "status": "idle",
        "createdAtUnixMs": 100,
        "updatedAtUnixMs": 200,
        "subagentRuns": [
            {
                "subagentId": "sub-child-done",
                "status": "completed",
                "childThreadId": "child-1",
                "items": [
                    { "id": "si-tool", "kind": "tool", "title": "Read file" },
                    { "id": "si-1", "kind": "assistant", "text": "duplicated child item" }
                ]
            },
            {
                "subagentId": "sub-transcript-killed",
                "status": "killed",
                "transcriptUri": "file:///tmp/transcript.jsonl",
                "items": [{ "id": "si-2", "kind": "assistant", "text": "duplicated transcript item" }]
            },
            {
                "subagentId": "sub-still-running",
                "status": "running",
                "childThreadId": "child-2",
                "items": [{ "id": "si-3", "kind": "assistant", "text": "keep while running" }]
            },
            {
                "subagentId": "sub-inline-only",
                "status": "completed",
                "items": [{ "id": "si-4", "kind": "assistant", "text": "keep inline without child or transcript" }]
            }
        ],
        "items": [
            {
                "id": "u1",
                "kind": "user",
                "text": "check attachments",
                "attachments": [
                    {
                        "resourceId": "att-existing",
                        "displayName": "existing-preview.png",
                        "path": existing_img_str,
                        "previewDataUrl": data_url
                    },
                    {
                        "resourceId": "att-inline-only",
                        "displayName": "pasted.png",
                        "previewDataUrl": data_url
                    }
                ]
            }
        ]
    });
    conn.execute(
        "INSERT INTO threads (id, data, created_at_unix_ms, updated_at_unix_ms) VALUES ('th-legacy-compact', ?1, 100, 200)",
        [serde_json::to_string(&legacy_thread).unwrap()],
    ).unwrap();

    let ran = migrate_compact_legacy_sqlite_with_attachments_dir(&mut conn, &attachments_dir).unwrap();
    assert!(ran, "first compaction must execute");
    assert_eq!(app_value(&conn, "legacy_bloat_compacted_v1"), "1");

    // Verify dispatch_audit trimmed to latest 2,000 rows.
    let audit_count: i64 = conn.query_row("SELECT COUNT(*) FROM dispatch_audit", [], |r| r.get(0)).unwrap();
    assert_eq!(audit_count, 2000);
    let min_created: i64 = conn.query_row("SELECT MIN(created_ms) FROM dispatch_audit", [], |r| r.get(0)).unwrap();
    assert_eq!(min_created, 51);

    // Verify freelist was reclaimed by VACUUM.
    let freelist_after: i64 = conn.query_row("PRAGMA freelist_count", [], |r| r.get(0)).unwrap();
    assert_eq!(freelist_after, 0);

    // Verify subagentRuns and attachments compaction.
    let compacted = find_thread_from_conn(&conn, "th-legacy-compact").unwrap();
    assert_eq!(compacted["subagentRuns"][0]["items"], json!([]));
    assert_eq!(compacted["subagentRuns"][0]["stepCount"], json!(1));
    assert_eq!(compacted["subagentRuns"][1]["items"], json!([]));
    assert_eq!(compacted["subagentRuns"][2]["items"].as_array().unwrap().len(), 1);
    assert_eq!(compacted["subagentRuns"][3]["items"].as_array().unwrap().len(), 1);

    let atts = compacted["items"][0]["attachments"].as_array().unwrap();
    assert!(atts[0].get("previewDataUrl").is_none());
    assert_eq!(atts[0]["path"], json!(existing_img.to_string_lossy().to_string()));

    assert!(atts[1].get("previewDataUrl").is_none());
    let written_path = atts[1]["path"].as_str().expect("externalized path must be set");
    assert!(written_path.ends_with("att-inline-only.png"), "unexpected path: {written_path}");
    assert_eq!(fs::read(written_path).unwrap(), raw_png_bytes);

    // Second run must short-circuit via app_state guard.
    let ran_again = migrate_compact_legacy_sqlite_with_attachments_dir(&mut conn, &attachments_dir).unwrap();
    assert!(!ran_again);
}

