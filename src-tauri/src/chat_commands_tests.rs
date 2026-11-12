use super::*;
use crate::chat::TurnRun;

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
        routine_id: None,
        delivered_through: 0,
        file_baselines: Default::default(),
    };
    {
        let mut live = live_turns().lock().unwrap();
        live.runs.insert(run_id.into(), run);
        live.by_thread.insert(thread_id.into(), run_id.into());
    }

    let runs = list_live_chat_runs(None);
    assert!(!runs.is_empty());
    let found = runs.iter().find(|r| r["threadId"] == thread_id).expect("run found");
    assert_eq!(found["line"], "Thinking about the task...");
    assert_eq!(found["startedAtUnixMs"], 1234567890);
    assert_eq!(found["needsYou"], false);

    // Test responding to approval
    let resp = respond_chat_approval(Some(json!({
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

    let archived = archive_chat_thread(Some(json!({ "threadId": thread_id })));
    assert_eq!(archived["deleted"], json!(true));
    let live = archived["history"]["summaries"].as_array().unwrap();
    assert!(live.iter().all(|row| row["id"] != thread_id));
    assert!(history(None)["summaries"]
        .as_array()
        .unwrap()
        .iter()
        .all(|row| row["id"] != thread_id));

    let listed = list_archived_chats(Some(json!({ "profileId": Value::Null })));
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

    let restored = restore_archived_chat(Some(json!({ "threadId": thread_id })));
    assert!(restored.is_null());
    assert!(history(None)["summaries"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["id"] == thread_id));
    assert!(list_archived_chats(Some(json!({ "profileId": Value::Null })))
        .iter()
        .all(|row| row["id"] != thread_id));

    archive_chat_thread(Some(json!({ "threadId": thread_id })));
    let purged = purge_archived_chat(Some(json!({ "threadId": thread_id })));
    assert!(purged.is_null());
    assert!(list_archived_chats(Some(json!({ "profileId": Value::Null })))
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
    let missing = get_chat_session_status(None);
    assert!(missing.get("error").is_some());

    let unknown = get_chat_session_status(Some(json!({ "threadId": "non-existent-thread-xyz" })));
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

    let detail = get_thread_subagent_detail(Some(json!({
        "threadId": parent_id,
        "subagentId": "sub_1"
    })));
    assert_eq!(detail["subagentId"], "sub_1");
    assert_eq!(detail["items"].as_array().map(|a| a.len()), Some(1));

    let swarm = get_thread_swarm_state(Some(json!({ "threadId": parent_id })));
    assert_eq!(swarm["title"], "Audit Swarm");
    assert_eq!(swarm["members"][0]["name"], "reviewer");
}
