use super::*;
use super::threads_cmd::{resolve_initial_provider, ARCHIVE_RETENTION_MS};
use crate::chat::threads::blank_thread;
use crate::chat::{
    archived_at_ms, create_thread, history, live_turns, remove_thread, TurnRun,
};
use crate::persist::threads;
use serde_json::{json, Value};

#[test]
fn test_live_chat_runs_and_approval() {
    let thread_id = "test-thread-uuid-1111-2222-333344445555";
    let run_id = "test-run-uuid-1111-2222-333344445555";
    let run = TurnRun {
        revision: "rev1".into(),
        events: Vec::new(),
        next_sequence: 1,
        assistant_id: "ast1".into(),
        assistant_text: "Thinking about the task...".into(),
        child: None,
        stdin: None,
        closing: false,
        finished: false,
        started_at_ms: 1234567890,
        finished_at_ms: None,
        routine_id: None,
        delivered_through: 0,
        file_baselines: Default::default(),
    };
    {
        let mut live = live_turns().lock().unwrap();
        live.runs.insert(run_id.into(), run);
        live.by_thread.insert(thread_id.into(), run_id.into());
    }

    let runs = turns_cmd::list_live_chat_runs(None);
    assert!(!runs.is_empty());
    let found = runs.iter().find(|r| r["threadId"] == thread_id).expect("run found");
    assert_eq!(found["runId"], run_id);
    assert_eq!(found["nextSequence"], 1);
    assert_eq!(found["line"], "Thinking about the task...");
    assert_eq!(found["startedAtUnixMs"], 1234567890);
    assert_eq!(found["needsYou"], false);

    // Test responding to approval
    let resp = turns_cmd::respond_chat_approval(Some(json!({
        "request": {
            "threadId": thread_id,
            "runId": run_id,
            "requestId": "req1",
            "decision": "approve"
        }
    })));
    assert_eq!(resp["pendingApproval"], Value::Null);

    // Clean up
    {
        let mut live = live_turns().lock().unwrap();
        live.runs.remove(run_id);
        live.by_thread.remove(thread_id);
    }
    crate::chat::remove_thread(thread_id);
}

struct RemoveThread(String);

impl Drop for RemoveThread {
    fn drop(&mut self) {
        remove_thread(&self.0);
    }
}

#[test]
fn archived_chat_is_hidden_then_restored_and_purged() {
    let created = create_thread(None, "Archive Probe", "claude", None);
    let thread_id = created.get("id").and_then(|value| value.as_str()).unwrap().to_string();
    let _cleanup = RemoveThread(thread_id.clone());

    let archived = threads_cmd::archive_chat_thread(Some(json!({ "threadId": thread_id })));
    assert_eq!(archived["deleted"], json!(true));
    let live = archived["history"]["summaries"].as_array().unwrap();
    assert!(live.iter().all(|row| row["id"] != thread_id));
    assert!(history(None)["summaries"]
        .as_array()
        .unwrap()
        .iter()
        .all(|row| row["id"] != thread_id));

    let listed = threads_cmd::list_archived_chats(Some(json!({ "profileId": Value::Null })));
    let row = listed.iter().find(|row| row["id"] == thread_id).expect("archived summary");
    assert_eq!(row["schemaVersion"], 1);
    assert_eq!(row["title"], "Archive Probe");
    assert_eq!(row["profileId"], Value::Null);
    let archived_at = row["archivedAtUnixMs"].as_i64().expect("archivedAtUnixMs");
    assert_eq!(row["expiresAtUnixMs"].as_i64().unwrap() - archived_at, ARCHIVE_RETENTION_MS);
    assert_eq!(row["revision"].as_str().map(|text| text.len()), Some(64));
    let stored = threads().lock().unwrap().iter().any(|thread| {
        thread.get("id").and_then(|value| value.as_str()) == Some(thread_id.as_str())
            && archived_at_ms(thread) == Some(archived_at)
    });
    assert!(stored, "archived thread stays stored");

    let restored = threads_cmd::restore_archived_chat(Some(json!({ "threadId": thread_id })));
    assert!(restored.is_null());
    assert!(history(None)["summaries"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["id"] == thread_id));
    assert!(threads_cmd::list_archived_chats(Some(json!({ "profileId": Value::Null })))
        .iter()
        .all(|row| row["id"] != thread_id));

    threads_cmd::archive_chat_thread(Some(json!({ "threadId": thread_id })));
    let purged = threads_cmd::purge_archived_chat(Some(json!({ "threadId": thread_id })));
    assert!(purged.is_null());
    assert!(threads_cmd::list_archived_chats(Some(json!({ "profileId": Value::Null })))
        .iter()
        .all(|row| row["id"] != thread_id));
    let gone = threads()
        .lock()
        .unwrap()
        .iter()
        .all(|thread| thread.get("id").and_then(|value| value.as_str()) != Some(thread_id.as_str()));
    assert!(gone);
}

#[test]
fn requested_provider_wins_over_agent_engine() {
    assert_eq!(
        resolve_initial_provider(Some("claude"), Some("codex")),
        "claude"
    );
}

#[test]
fn agent_engine_provider_applies_without_requested_provider() {
    assert_eq!(resolve_initial_provider(None, Some("codex")), "codex");
    assert_eq!(
        resolve_initial_provider(None, Some("claude-code")),
        "claude"
    );
}

#[test]
fn unknown_requested_provider_falls_back_to_agent_engine() {
    assert_eq!(
        resolve_initial_provider(Some("not-a-provider"), Some("gemini")),
        "gemini"
    );
}

#[test]
fn missing_agent_engine_falls_back_to_antigravity() {
    assert_eq!(resolve_initial_provider(None, None), "antigravity");
    assert_eq!(
        resolve_initial_provider(Some("not-a-provider"), None),
        "antigravity"
    );
}

#[test]
fn test_get_chat_session_status_command() {
    let missing = turns_cmd::get_chat_session_status(None);
    assert!(missing.get("error").is_some());

    let unknown = turns_cmd::get_chat_session_status(Some(json!({ "threadId": "non-existent-thread-xyz" })));
    assert_eq!(unknown["state"], "closed");
    assert_eq!(unknown["isWarm"], false);
    assert_eq!(unknown["hasResumeHandle"], false);
}

#[test]
fn thread_persists_subagent_and_swarm_metadata_and_serves_detail_commands() {
    use crate::chat::threads::{blank_thread, create_thread, summary_of, THREAD_FIELD_NAMES};

    let sample = blank_thread("blank-subagent-check", None, "Check", "claude", None);
    for key in [
        "parentThreadId",
        "parentToolCallId",
        "startedByAgent",
        "sideChat",
        "subagentRole",
        "workspaceMode",
        "swarmId",
        "swarmMemberName",
        "subagentRuns",
        "swarmState",
    ] {
        assert!(THREAD_FIELD_NAMES.contains(&key), "missing {key} in THREAD_FIELD_NAMES");
        assert!(sample.get(key).is_some(), "missing {key} in blank_thread");
    }

    let parent = create_thread(None, "Parent Thread", "claude", None);
    let parent_id = parent["id"].as_str().unwrap().to_string();
    let _cleanup_parent = RemoveThread(parent_id.clone());

    let child = create_thread(None, "Child Subagent", "grok", None);
    let child_id = child["id"].as_str().unwrap().to_string();
    let _cleanup_child = RemoveThread(child_id.clone());

    {
        let mut all = threads().lock().unwrap();
        if let Some(ch) = all.iter_mut().find(|t| t["id"] == child_id) {
            ch["parentThreadId"] = json!(parent_id);
            ch["parentToolCallId"] = json!("call_sub_1");
            ch["startedByAgent"] = json!(true);
            ch["subagentRole"] = json!("Code Reviewer");
            ch["workspaceMode"] = json!("share");
            ch["swarmId"] = json!("swarm_1");
            ch["swarmMemberName"] = json!("reviewer");
            ch["items"] = json!([{
                "id": "step_1",
                "kind": "tool",
                "title": "Read main.rs",
                "status": "completed",
                "text": "ok",
                "streaming": false,
                "exitCode": Value::Null,
                "createdAtUnixMs": 1,
                "attachments": []
            }]);
        }
        if let Some(p) = all.iter_mut().find(|t| t["id"] == parent_id) {
            p["subagentRuns"] = json!([{
                "subagentId": "sub_1",
                "parentThreadId": parent_id,
                "parentToolCallId": "call_sub_1",
                "role": "Code Reviewer",
                "provider": "grok",
                "model": "grok-mini",
                "workspaceMode": "share",
                "status": "running",
                "childThreadId": child_id,
                "stepCount": 1,
                "items": [],
                "startedAtUnixMs": 100,
                "updatedAtUnixMs": 100
            }]);
            p["swarmState"] = json!({
                "swarmId": "swarm_1",
                "title": "Audit Swarm",
                "coordinatorModel": "claude-opus-4-6",
                "members": [{
                    "name": "reviewer",
                    "role": "Code Reviewer",
                    "provider": "grok",
                    "model": "grok-mini",
                    "workspaceMode": "share",
                    "state": "working",
                    "channels": ["main"],
                    "childThreadId": child_id
                }],
                "posts": [{
                    "seq": 1,
                    "author": "coordinator",
                    "channel": "main",
                    "text": "@reviewer check src-tauri",
                    "mentions": ["@reviewer"],
                    "createdAtUnixMs": 100
                }],
                "channels": [{ "name": "main", "archived": false }]
            });
        }
    }

    let child_snap = threads()
        .lock()
        .unwrap()
        .iter()
        .find(|t| t["id"] == child_id)
        .cloned()
        .unwrap();
    let child_summary = summary_of(&child_snap).expect("summary_of");
    assert_eq!(child_summary["parentThreadId"], parent_id);
    assert_eq!(child_summary["startedByAgent"], true);
    assert_eq!(child_summary["swarmMemberName"], "reviewer");

    let parent_snap = threads()
        .lock()
        .unwrap()
        .iter()
        .find(|t| t["id"] == parent_id)
        .cloned()
        .unwrap();
    let parent_summary = summary_of(&parent_snap).expect("parent summary_of");
    let active_subs = parent_summary["activeSubagents"].as_array().expect("activeSubagents array");
    assert_eq!(active_subs.len(), 1);
    assert_eq!(active_subs[0]["subagentId"], "sub_1");
    assert_eq!(active_subs[0]["role"], "Code Reviewer");

    let detail = subagents_ui::get_thread_subagent_detail(Some(json!({
        "threadId": parent_id,
        "subagentId": "sub_1"
    })));
    assert_eq!(detail["subagentId"], "sub_1");
    assert_eq!(detail["items"].as_array().map(|a| a.len()), Some(1));

    let swarm = subagents_ui::get_thread_swarm_state(Some(json!({ "threadId": parent_id })));
    assert_eq!(swarm["title"], "Audit Swarm");
    assert_eq!(swarm["members"][0]["name"], "reviewer");

    // Verify async command wrapper roundtrips cleanly too.
    let detail_async = tauri::async_runtime::block_on(get_thread_subagent_detail(Some(json!({
        "threadId": parent_id,
        "subagentId": "sub_1"
    }))));
    assert_eq!(detail_async["subagentId"], "sub_1");
}

#[test]
fn interactive_subagent_and_swarm_ui_commands_drive_lifecycle() {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let parent_id = format!("chat-cmd-ui-parent-{suffix}");
    let child_id = format!("chat-cmd-ui-child-{suffix}");
    let worker_id = format!("chat-cmd-ui-worker-{suffix}");
    let scratch = std::env::temp_dir().join(format!("kite-ui-cmd-{suffix}"));
    let _ = std::fs::create_dir_all(&scratch);
    struct UiCmdCleanup {
        ids: Vec<String>,
        dir: std::path::PathBuf,
    }
    impl Drop for UiCmdCleanup {
        fn drop(&mut self) {
            for id in &self.ids {
                crate::dispatch_wire::protocol::clear_thread_killed(id);
            }
            if let Ok(mut all) = threads().lock() {
                all.retain(|t| {
                    let id = t.get("id").and_then(Value::as_str).unwrap_or("");
                    !self.ids.iter().any(|x| x == id)
                });
            }
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
    let _cleanup = UiCmdCleanup {
        ids: vec![parent_id.clone(), child_id.clone(), worker_id.clone()],
        dir: scratch.clone(),
    };
    {
        let mut all = threads().lock().unwrap();
        let mut parent = blank_thread(&parent_id, None, "Coordinator", "antigravity", None);
        parent["workingDirectory"] = json!(scratch.to_string_lossy().to_string());
        parent["subagentRuns"] = json!([{
            "subagentId": "sub_ui_1",
            "parentThreadId": parent_id,
            "parentToolCallId": "call_ui_1",
            "role": "Grok Verifier",
            "provider": "grok",
            "model": "grok-3-mini",
            "workspaceMode": "inherit",
            "status": "running",
            "childThreadId": child_id,
            "stepCount": 0,
            "items": [],
            "startedAtUnixMs": 100,
            "updatedAtUnixMs": 100
        }]);
        parent["items"] = json!([{
            "id": "call_ui_1",
            "kind": "tool",
            "toolKind": "subagent",
            "toolName": "Task",
            "title": "Grok Verifier",
            "status": "running"
        }]);
        all.push(parent);
        all.push(blank_thread(&child_id, None, "Child", "grok", None));
        let mut worker = blank_thread(&worker_id, None, "Worker", "grok", None);
        worker["workingDirectory"] = json!(scratch.to_string_lossy().to_string());
        worker["swarmParentThreadId"] = json!(parent_id);
        worker["swarmMemberName"] = json!("analyst");
        worker["status"] = json!("error");
        all.push(worker);
    }

    // Seed swarm state cleanly
    let seeded = subagents_ui::swarm_post_from_ui(Some(json!({
        "threadId": parent_id,
        "channel": "main",
        "message": "Initial board note"
    })));
    assert_eq!(seeded["ok"], true);
    assert_eq!(seeded["swarmState"]["posts"].as_array().unwrap().len(), 1);

    // Register a stopped member directly on the swarm state so UI switch & kill can operate
    {
        let mut all = threads().lock().unwrap();
        let p = all.iter_mut().find(|t| t["id"] == parent_id).unwrap();
        p["swarmState"]["members"] = json!([{
            "name": "analyst",
            "role": "Analyst",
            "provider": "grok",
            "model": "grok-3-mini",
            "workspaceMode": "inherit",
            "state": "stopped",
            "channels": ["main"],
            "childThreadId": worker_id,
            "subagentId": worker_id
        }]);
    }

    // Stop active subagent run from UI
    let stopped = subagents_ui::stop_subagent_run(Some(json!({
        "threadId": parent_id,
        "subagentId": "sub_ui_1"
    })));
    assert_eq!(stopped["ok"], true);
    assert_eq!(stopped["run"]["status"], "killed");

    // Empty message on send_subagent_message must error cleanly
    let bad_send = subagents_ui::send_subagent_message(Some(json!({
        "threadId": parent_id,
        "subagentId": "sub_ui_1",
        "message": "   "
    })));
    assert!(bad_send.get("error").is_some());

    // Invalid provider on switch errors cleanly
    let bad_switch = subagents_ui::swarm_switch_worker_model(Some(json!({
        "threadId": parent_id,
        "name": "analyst",
        "provider": "not-a-provider",
        "model": "foo"
    })));
    assert!(bad_switch.get("error").is_some());

    let bad_kill = subagents_ui::swarm_kill_worker_from_ui(Some(json!({
        "threadId": parent_id,
        "name": "missing-member"
    })));
    assert!(bad_kill.get("error").is_some());

    let killed = subagents_ui::swarm_kill_worker_from_ui(Some(json!({
        "threadId": parent_id,
        "name": "analyst"
    })));
    assert_eq!(killed["ok"], true);
    assert_eq!(killed["swarmState"]["members"][0]["state"], "killed");
}

#[test]
fn list_all_subagent_runs_groups_active_first_and_excludes_archived() {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let ws_a = format!("ws-a-{suffix}");
    let ws_b = format!("ws-b-{suffix}");
    let parent_done = format!("parent-done-{suffix}");
    let parent_live = format!("parent-live-{suffix}");
    let parent_arch = format!("parent-arch-{suffix}");
    let child_wait = format!("child-wait-{suffix}");
    struct MultiCleanup {
        ids: Vec<String>,
    }
    impl Drop for MultiCleanup {
        fn drop(&mut self) {
            if let Ok(mut all) = threads().lock() {
                all.retain(|t| {
                    let id = t.get("id").and_then(Value::as_str).unwrap_or("");
                    !self.ids.iter().any(|x| x == id)
                });
            }
        }
    }
    let _cleanup = MultiCleanup {
        ids: vec![
            parent_done.clone(),
            parent_live.clone(),
            parent_arch.clone(),
            child_wait.clone(),
        ],
    };

    {
        let mut all = threads().lock().unwrap();
        all.push(json!({
            "id": parent_done,
            "title": "Completed Thread",
            "workspaceId": ws_a,
            "provider": "claude",
            "model": "claude-opus-4-6",
            "subagentRuns": [{
                "subagentId": format!("sub-done-{suffix}"),
                "parentThreadId": parent_done,
                "parentToolCallId": "call-done",
                "role": "Researcher",
                "status": "completed",
                "stepCount": 3,
                "items": [{ "id": "heavy-1", "kind": "assistant", "text": "huge payload" }],
                "startedAtUnixMs": 1000,
                "updatedAtUnixMs": 5000
            }]
        }));
        all.push(json!({
            "id": child_wait,
            "title": "Waiting Child",
            "workspaceId": ws_b,
            "parentThreadId": parent_live,
            "startedByAgent": true,
            "status": "waiting",
            "provider": "grok",
            "model": "grok-4.7-build-fast",
            "pendingApproval": { "id": "apr-1", "title": "Approve tool" }
        }));
        all.push(json!({
            "id": parent_live,
            "title": "Live Thread",
            "workspaceId": ws_b,
            "provider": "gemini",
            "model": "gemini-3-pro",
            "subagentRuns": [{
                "subagentId": format!("sub-wait-{suffix}"),
                "parentThreadId": parent_live,
                "parentToolCallId": "call-wait",
                "childThreadId": child_wait,
                "role": "Security Auditor",
                "status": "running",
                "stepCount": 1,
                "items": [{ "id": "heavy-2", "kind": "tool", "title": "Read file" }],
                "startedAtUnixMs": 2000,
                "updatedAtUnixMs": 3000
            }]
        }));
        all.push(json!({
            "id": parent_arch,
            "title": "Archived Thread",
            "workspaceId": ws_a,
            "archivedAtUnixMs": 4000,
            "subagentRuns": [{
                "subagentId": format!("sub-arch-{suffix}"),
                "parentThreadId": parent_arch,
                "parentToolCallId": "call-arch",
                "role": "Old Agent",
                "status": "running",
                "stepCount": 0,
                "items": [],
                "startedAtUnixMs": 9000,
                "updatedAtUnixMs": 9000
            }]
        }));
    }

    let snap_all = subagents_ui::list_all_subagent_runs(Some(json!({ "limit": 500 })));
    assert_eq!(snap_all["ok"], true);
    let runs = snap_all["runs"].as_array().expect("runs array");
    let matching: Vec<&Value> = runs
        .iter()
        .filter(|e| {
            let tid = e.get("threadId").and_then(Value::as_str).unwrap_or("");
            tid == parent_done || tid == parent_live || tid == parent_arch
        })
        .collect();
    assert_eq!(matching.len(), 2, "archived parent must be excluded");
    assert_eq!(matching[0]["threadId"], parent_live);
    assert_eq!(matching[0]["hasPendingApproval"], true);
    assert_eq!(matching[0]["run"]["status"], "waiting");
    assert_eq!(matching[0]["run"]["items"].as_array().map(|a| a.len()), Some(0));
    assert_eq!(matching[1]["threadId"], parent_done);

    let snap_ws_a = subagents_ui::list_all_subagent_runs(Some(json!({ "workspaceId": ws_a })));
    let ws_a_runs = snap_ws_a["runs"].as_array().expect("ws_a runs");
    assert_eq!(ws_a_runs.len(), 1);
    assert_eq!(ws_a_runs[0]["threadId"], parent_done);
}

#[test]
fn regenerate_chat_thread_title_derives_concise_title_from_transcript() {
    let tid = format!("regen-title-{}", uuid::Uuid::new_v4().simple());
    struct Cleanup(String);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            if let Ok(mut list) = threads().lock() {
                list.retain(|t| t.get("id").and_then(Value::as_str) != Some(self.0.as_str()));
            }
        }
    }
    let _cleanup = Cleanup(tid.clone());
    {
        let mut all = threads().lock().unwrap();
        let mut thread = blank_thread(&tid, None, "New Chat", "claude", None);
        thread["items"] = json!([
            crate::chat::chat_item("u1", "user", "\n# Associate new thread with selected workspace", false),
            crate::chat::chat_item("a1", "assistant", "Done.", false)
        ]);
        all.push(thread);
    }

    let updated = threads_cmd::regenerate_chat_thread_title(Some(json!({
        "supportedSchemaVersion": 1,
        "threadId": tid
    })));
    assert_eq!(
        updated.get("title").and_then(Value::as_str),
        Some("Associate new thread with selected workspace")
    );
    assert_eq!(
        updated.get("titleOrigin").and_then(Value::as_str),
        Some("generated")
    );
}

#[test]
fn create_agent_chat_preserves_workspace_id_and_overrides() {
    let agent_id = format!("test-agent-{}", uuid::Uuid::new_v4().simple());
    let ws_id = format!("test-ws-{}", uuid::Uuid::new_v4().simple());
    {
        let mut agents = crate::persist::agents().lock().unwrap();
        agents.push(crate::persist::AgentProfile {
            id: agent_id.clone(),
            name: "Workspace Agent".into(),
            engine: "claude".into(),
            purpose: "Test".into(),
            brief: "Test brief".into(),
            avatar: None,
            created_at_unix_ms: 1_700_000_000_000,
            pinned: false,
            order: 99,
            memory_budget: Some(6000),
            reflection_mode: None,
            allow_agent_scheduling: None,
            allow_agent_messaging: None,
            default_mode: Some("readOnly".into()),
            default_plan: Some(false),
            default_model: Some("claude-sonnet-4-5".into()),
            default_provider_options: Vec::new(),
            place_display_names: Vec::new(),
            disabled_plugin_ids: Vec::new(),
        });
    }
    struct AgentCleanup(String);
    impl Drop for AgentCleanup {
        fn drop(&mut self) {
            if let Ok(mut agents) = crate::persist::agents().lock() {
                agents.retain(|a| a.id != self.0);
            }
        }
    }
    let _agent_cleanup = AgentCleanup(agent_id.clone());

    let created = threads_cmd::create_agent_chat(Some(json!({
        "request": {
            "agentId": agent_id,
            "workspaceId": format!("  {}  ", ws_id),
            "plan": true,
            "effort": "high"
        }
    })));
    let tid = created.get("id").and_then(Value::as_str).unwrap().to_string();
    let _thread_cleanup = RemoveThread(tid);

    assert_eq!(created.get("workspaceId").and_then(Value::as_str), Some(ws_id.as_str()));
    assert_eq!(created.get("profileId").and_then(Value::as_str), Some(agent_id.as_str()));
    assert_eq!(created.get("plan").and_then(Value::as_bool), Some(true));
    assert_eq!(created.get("effort").and_then(Value::as_str), Some("high"));

    let blank_ws = threads_cmd::create_agent_chat(Some(json!({
        "request": {
            "agentId": agent_id,
            "workspaceId": "   "
        }
    })));
    let tid2 = blank_ws.get("id").and_then(Value::as_str).unwrap().to_string();
    let _thread_cleanup2 = RemoveThread(tid2);
    assert!(blank_ws.get("workspaceId").is_none_or(Value::is_null));
}
