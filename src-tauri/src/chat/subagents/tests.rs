use serde_json::{json, Value};

use super::*;
use crate::acp::build_acp_tool_call;
use crate::chat::threads::{blank_thread, remove_thread, upsert_item};
use crate::persist::threads;

struct CleanupThread(String);
impl Drop for CleanupThread {
    fn drop(&mut self) {
        remove_thread(&self.0);
    }
}

#[test]
fn parses_local_transcript_jsonl_into_canonical_chat_items() {
    let content = concat!(
        r#"{"type":"USER_INPUT","content":"Check RightDock responsiveness"}"#, "\n",
        r#"{"type":"PLANNER_RESPONSE","thinking":"Inspecting dockConfig","tool_calls":[{"id":"tc-1","name":"read_file","arguments":{"path":"src/components/RightDock.tsx"},"status":"completed"}],"content":"RightDock uses clamp widths."}"#, "\n"
    );
    let items = parse_transcript_jsonl(content, "sub-jsonl-1");
    assert_eq!(items.len(), 4);
    assert_eq!(items[0]["kind"], "user");
    assert_eq!(items[1]["kind"], "reasoning");
    assert_eq!(items[2]["kind"], "tool");
    assert_eq!(items[2]["filePath"], "src/components/RightDock.tsx");
    assert_eq!(items[3]["kind"], "assistant");
}

#[test]
fn routes_parent_tool_use_id_frames_into_nested_subagent_run() {
    let tid = format!("subagent-nest-{}", uuid::Uuid::new_v4().simple());
    let _cleanup = CleanupThread(tid.clone());
    let thread = blank_thread(&tid, None, "Main Thread", "claude", None);
    threads().lock().unwrap().push(thread);

    let parent_tool = build_acp_tool_call(
        "toolu_task_1".to_string(),
        "Task",
        json!({
            "description": "Codebase Explorer",
            "prompt": "Find dock config",
            "subagent_type": "Explore",
            "model": "haiku"
        }),
        "running".to_string(),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    );
    let parent_item = acp_tool_to_chat_item(&parent_tool);
    {
        let mut list = threads().lock().unwrap();
        let t = list.iter_mut().find(|t| t["id"] == tid).unwrap();
        upsert_item(t, &parent_item);
    }
    record_subagent_tool_call(&tid, &parent_item);

    let nested_tool = json!({
        "type": "assistant",
        "parent_tool_use_id": "toolu_task_1",
        "message": {
            "content": [{
                "type": "tool_use",
                "id": "toolu_inner_1",
                "name": "read_file",
                "input": { "file_path": "src/components/dock/dockConfig.tsx" }
            }]
        }
    });
    assert!(ingest_nested_subagent_frame(
        &tid,
        "run-1",
        "toolu_task_1",
        &nested_tool
    ));

    let detail = build_subagent_detail(&tid, "toolu_task_1").expect("detail");
    assert_eq!(detail["role"], "Codebase Explorer");
    assert_eq!(detail["stepCount"], 1);
    assert_eq!(detail["items"].as_array().unwrap().len(), 1);
    assert_eq!(detail["items"][0]["filePath"], "src/components/dock/dockConfig.tsx");

    // Parent thread must NOT have the nested inner tool flattened into its top-level items!
    let list = threads().lock().unwrap();
    let parent = list.iter().find(|t| t["id"] == tid).unwrap();
    assert_eq!(parent["items"].as_array().unwrap().len(), 1);
    assert_eq!(parent["items"][0]["subagentMeta"]["stepCount"], 1);
}

#[test]
fn records_swarm_state_channels_members_and_mentions() {
    let tid = format!("swarm-state-{}", uuid::Uuid::new_v4().simple());
    let _cleanup = CleanupThread(tid.clone());
    let mut thread = blank_thread(&tid, None, "Main", "antigravity", None);
    thread["model"] = json!("claude-opus-4-6");
    threads().lock().unwrap().push(thread);

    let title_tool = acp_tool_to_chat_item(&build_acp_tool_call(
        "sw-1".into(),
        "swarm",
        json!({ "action": "title", "title": "Parser Rewrite" }),
        "completed".into(),
        None, None, None, None, None, None, None, None,
    ));
    record_swarm_tool_call(&tid, &title_tool);

    let add_tool = acp_tool_to_chat_item(&build_acp_tool_call(
        "sw-2".into(),
        "swarm",
        json!({
            "action": "add",
            "name": "verifier",
            "model": "flash",
            "workspace": "share",
            "brief": "Audit parser invariants"
        }),
        "completed".into(),
        None, None, None, None, None, None, None, None,
    ));
    record_swarm_tool_call(&tid, &add_tool);

    let post_tool = acp_tool_to_chat_item(&build_acp_tool_call(
        "sw-3".into(),
        "post_message",
        json!({ "channel": "parser", "message": "@verifier check #1" }),
        "completed".into(),
        None, None, None, None, None, None, None, None,
    ));
    record_swarm_tool_call(&tid, &post_tool);

    let state = build_swarm_state(&tid);
    assert_eq!(state["title"], "Parser Rewrite");
    assert_eq!(state["coordinatorModel"], "claude-opus-4-6");
    assert_eq!(state["members"][0]["name"], "verifier");
    assert_eq!(state["members"][0]["state"], "working");
    assert_eq!(state["posts"][0]["seq"], 1);
    assert_eq!(state["posts"][0]["channel"], "parser");
    assert_eq!(state["posts"][0]["mentions"][0], "@verifier");
}

#[test]
fn send_and_stop_subagent_helpers_update_parent_and_child_runs() {
    let parent_id = format!("steer-parent-{}", uuid::Uuid::new_v4().simple());
    let child_id = format!("steer-child-{}", uuid::Uuid::new_v4().simple());
    let _cleanup_p = CleanupThread(parent_id.clone());
    let _cleanup_c = CleanupThread(child_id.clone());

    let mut parent = blank_thread(&parent_id, None, "Parent", "antigravity", None);
    parent["subagentRuns"] = json!([{
        "subagentId": "sub_steer_1",
        "parentThreadId": parent_id,
        "parentToolCallId": "call_steer_1",
        "childThreadId": child_id,
        "role": "Researcher",
        "status": "completed",
        "stepCount": 1,
        "items": [],
        "startedAtUnixMs": 100,
        "updatedAtUnixMs": 200,
        "completedAtUnixMs": 200
    }]);
    parent["items"] = json!([{
        "id": "call_steer_1",
        "kind": "tool",
        "toolKind": "subagent",
        "toolName": "Task",
        "status": "completed"
    }]);
    threads().lock().unwrap().push(parent);
    threads()
        .lock()
        .unwrap()
        .push(blank_thread(&child_id, None, "Child", "grok", None));

    let sent_prompts = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let sent_clone = std::sync::Arc::clone(&sent_prompts);
    let mock_launcher = move |_cid: &str, prompt: &str| -> Result<(), String> {
        sent_clone.lock().unwrap().push(prompt.to_string());
        Ok(())
    };

    let steered = send_subagent_message_with_launcher(
        &parent_id,
        "sub_steer_1",
        "Verify edge case #2",
        Some(&mock_launcher),
    )
    .unwrap();
    assert_eq!(steered["status"], "running");
    assert_eq!(sent_prompts.lock().unwrap().as_slice(), &["Verify edge case #2"]);

    let stopped = cancel_subagent_thread(&parent_id, "sub_steer_1").unwrap();
    assert_eq!(stopped["status"], "killed");
    assert_eq!(stopped["latestActivity"], "Stopped by user");
    crate::chat::kill_registry::clear_thread_killed(&child_id);
}

#[test]
fn remembered_defaults_reject_incompatible_cross_provider_models() {
    assert!(crate::chat::models::model_likely_belongs_to_another_provider(
        "grok",
        "claude-opus-4-6"
    ));
    assert!(crate::chat::models::model_likely_belongs_to_another_provider(
        "grok",
        "gemini-3-flash"
    ));
    assert!(!crate::chat::models::model_likely_belongs_to_another_provider(
        "grok",
        "grok-code-fast"
    ));
    assert!(!crate::chat::models::model_likely_belongs_to_another_provider(
        "antigravity",
        "claude-opus-4-6"
    ));

    let poisoned_id = format!("poison-grok-{}", uuid::Uuid::new_v4().simple());
    let valid_id = format!("valid-grok-{}", uuid::Uuid::new_v4().simple());
    let _c1 = CleanupThread(poisoned_id.clone());
    let _c2 = CleanupThread(valid_id.clone());

    let mut valid_grok = blank_thread(&valid_id, None, "Valid Grok", "grok", None);
    valid_grok["model"] = json!("grok-code-fast");
    valid_grok["effort"] = json!("low");
    valid_grok["updatedAtUnixMs"] = json!(i64::MAX - 100);

    let mut poisoned_grok = blank_thread(&poisoned_id, None, "Poisoned Grok", "grok", None);
    poisoned_grok["model"] = json!("claude-opus-4-6");
    poisoned_grok["effort"] = json!("high");
    poisoned_grok["updatedAtUnixMs"] = json!(i64::MAX - 50);

    let profile_grok_id = format!("profile-grok-{}", uuid::Uuid::new_v4().simple());
    let _c3 = CleanupThread(profile_grok_id.clone());
    let mut profile_grok = blank_thread(&profile_grok_id, Some("agent-123"), "Profile Grok", "grok", None);
    profile_grok["model"] = json!("grok-4.20-beta");
    profile_grok["effort"] = json!("xhigh");
    profile_grok["updatedAtUnixMs"] = json!(i64::MAX - 10);

    threads().lock().unwrap().push(valid_grok);
    threads().lock().unwrap().push(poisoned_grok);
    threads().lock().unwrap().push(profile_grok);

    let (model, effort) = remembered_provider_defaults("grok");
    assert_eq!(model.as_deref(), Some("grok-code-fast"));
    assert_eq!(effort.as_deref(), Some("low"));
}

#[test]
fn nested_stream_deltas_preserve_order_and_tool_result_preserves_metadata() {
    let parent_id = format!("nested-parent-{}", uuid::Uuid::new_v4().simple());
    let _cleanup = CleanupThread(parent_id.clone());
    let mut parent = blank_thread(&parent_id, None, "Parent", "antigravity", None);
    parent["subagentRuns"] = json!([{
        "subagentId": "sub_nested_1",
        "parentThreadId": parent_id,
        "role": "Researcher",
        "status": "running",
        "stepCount": 0,
        "items": [],
        "startedAtUnixMs": 100,
        "updatedAtUnixMs": 100
    }]);
    threads().lock().unwrap().push(parent);

    // 1. Two thought delta chunks accumulate cleanly.
    ingest_nested_subagent_frame(
        &parent_id,
        "run_parent_1",
        "sub_nested_1",
        &json!({
            "method": "session/update",
            "params": { "update": { "sessionUpdate": "agent_thought_chunk", "content": { "text": "Checking " } } }
        }),
    );
    ingest_nested_subagent_frame(
        &parent_id,
        "run_parent_1",
        "sub_nested_1",
        &json!({
            "method": "session/update",
            "params": { "update": { "sessionUpdate": "agent_thought_chunk", "content": { "text": "Cargo.toml" } } }
        }),
    );

    // 2. A tool_use seals reasoning and creates a tool item with rich metadata.
    ingest_nested_subagent_frame(
        &parent_id,
        "run_parent_1",
        "sub_nested_1",
        &json!({
            "type": "tool_use",
            "id": "call_read_1",
            "name": "read_file",
            "title": "Read Cargo.toml",
            "input": { "path": "Cargo.toml" }
        }),
    );

    // 3. A bare tool_result keeps existing toolName/toolKind/title.
    ingest_nested_subagent_frame(
        &parent_id,
        "run_parent_1",
        "sub_nested_1",
        &json!({
            "type": "tool_result",
            "tool_use_id": "call_read_1",
            "content": "[package]\nname = \"kite-code\""
        }),
    );

    // 4. Two message chunks accumulate into a new assistant item after the tool call.
    ingest_nested_subagent_frame(
        &parent_id,
        "run_parent_1",
        "sub_nested_1",
        &json!({
            "method": "session/update",
            "params": { "update": { "sessionUpdate": "agent_message_chunk", "content": { "text": "Found " } } }
        }),
    );
    ingest_nested_subagent_frame(
        &parent_id,
        "run_parent_1",
        "sub_nested_1",
        &json!({
            "method": "session/update",
            "params": { "update": { "sessionUpdate": "agent_message_chunk", "content": { "text": "kite-code." } } }
        }),
    );

    let detail = build_subagent_detail(&parent_id, "sub_nested_1").unwrap();
    let items = detail["items"].as_array().unwrap();
    assert_eq!(items.len(), 3, "items={items:?}");
    assert_eq!(items[0]["kind"], "reasoning");
    assert_eq!(items[0]["text"], "Checking Cargo.toml");
    assert_eq!(items[0]["streaming"], false);
    assert_eq!(items[1]["kind"], "tool");
    assert_eq!(items[1]["id"], "call_read_1");
    assert_eq!(items[1]["toolName"], "read_file");
    assert_eq!(items[1]["title"], "Read Cargo.toml");
    assert_eq!(items[1]["status"], "completed");
    assert_eq!(items[2]["kind"], "assistant");
    assert_eq!(items[2]["text"], "Found kite-code.");
}

#[test]
fn cancel_subagent_thread_does_not_overwrite_already_completed_run() {
    let parent_id = format!("done-parent-{}", uuid::Uuid::new_v4().simple());
    let child_id = format!("done-child-{}", uuid::Uuid::new_v4().simple());
    let _cleanup_p = CleanupThread(parent_id.clone());
    let _cleanup_c = CleanupThread(child_id.clone());

    let mut parent = blank_thread(&parent_id, None, "Parent", "antigravity", None);
    parent["subagentRuns"] = json!([{
        "subagentId": "sub_done_1",
        "parentThreadId": parent_id,
        "parentToolCallId": "call_done_1",
        "childThreadId": child_id,
        "role": "Verifier",
        "status": "completed",
        "latestActivity": "All 5 checks passed",
        "stepCount": 2,
        "items": [],
        "startedAtUnixMs": 100,
        "updatedAtUnixMs": 200,
        "completedAtUnixMs": 200
    }]);
    parent["items"] = json!([{
        "id": "call_done_1",
        "kind": "tool",
        "toolKind": "subagent",
        "toolName": "Task",
        "status": "completed",
        "subagentMeta": {
            "subagentId": "sub_done_1",
            "status": "completed",
            "latestActivity": "All 5 checks passed"
        }
    }]);
    threads().lock().unwrap().push(parent);
    threads()
        .lock()
        .unwrap()
        .push(blank_thread(&child_id, None, "Done Child", "grok", None));

    let res = cancel_subagent_thread(&parent_id, "sub_done_1").unwrap();
    assert_eq!(res["status"], "completed");
    assert_eq!(res["latestActivity"], "All 5 checks passed");
    assert!(!crate::chat::kill_registry::is_thread_killed(&child_id));

    let all = threads().lock().unwrap();
    let stored = all.iter().find(|t| t["id"] == parent_id).unwrap();
    assert_eq!(stored["items"][0]["status"], "completed");
    assert_eq!(stored["items"][0]["subagentMeta"]["status"], "completed");
}

#[test]
fn incremental_transcript_tail_state_parses_appends_and_flushes_eof() {
    let dir = std::env::temp_dir().join(format!("kite-tail-test-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("transcript.jsonl");

    let mut state = TranscriptTailState::new();
    std::fs::write(
        &path,
        concat!(
            "{\"type\":\"USER_INPUT\",\"content\":\"Inspect lib\"}\n",
            "{\"type\":\"PLANNER_RESPONSE\",\"content\":\"Partial",
        ),
    )
    .unwrap();
    let first = state.read_incremental_items(&path, "sub_tail_1", false);
    assert_eq!(first.len(), 1);
    assert_eq!(first[0]["kind"], "user");
    assert_eq!(first[0]["text"], "Inspect lib");

    // Append remaining bytes without trailing newline, then flush on EOF.
    {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        f.write_all(b" answer\"}").unwrap();
    }
    let before_eof = state.read_incremental_items(&path, "sub_tail_1", false);
    assert!(before_eof.is_empty());
    let flushed = state.read_incremental_items(&path, "sub_tail_1", true);
    assert_eq!(flushed.len(), 1);
    assert_eq!(flushed[0]["kind"], "assistant");
    assert_eq!(flushed[0]["text"], "Partial answer");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn nested_deltas_and_frames_split_cleanly_across_intervening_tools() {
    let mut items: Vec<Value> = Vec::new();
    let mut pre = crate::chat::threads::chat_item("sub_x_step_0_msg", "assistant", "Checking...", true);
    pre["_appendDelta"] = json!(true);
    upsert_nested_item(&mut items, &pre);

    upsert_nested_item(
        &mut items,
        &json!({
            "id": "call_1",
            "kind": "tool",
            "toolName": "read_file",
            "status": "completed"
        }),
    );

    let mut post1 = crate::chat::threads::chat_item("sub_x_step_0_msg", "assistant", "Done reading", true);
    post1["_appendDelta"] = json!(true);
    upsert_nested_item(&mut items, &post1);

    let mut post2 = crate::chat::threads::chat_item("sub_x_step_0_msg", "assistant", " cleanly.", true);
    post2["_appendDelta"] = json!(true);
    upsert_nested_item(&mut items, &post2);

    assert_eq!(items.len(), 3, "items={items:?}");
    assert_eq!(items[0]["text"], "Checking...");
    assert_eq!(items[0]["streaming"], false);
    assert_eq!(items[1]["kind"], "tool");
    assert_eq!(items[2]["text"], "Done reading cleanly.");
    assert_ne!(items[2]["id"], items[0]["id"]);
}

#[test]
fn cancel_subagent_thread_honors_natural_settlement_and_preserves_kill_with_live_turn() {
    let parent_id = format!("race-parent-{}", uuid::Uuid::new_v4().simple());
    let settled_child = format!("race-settled-{}", uuid::Uuid::new_v4().simple());
    let killed_child = format!("race-killed-{}", uuid::Uuid::new_v4().simple());
    let _cleanup_p = CleanupThread(parent_id.clone());
    let _cleanup_s = CleanupThread(settled_child.clone());
    let _cleanup_k = CleanupThread(killed_child.clone());

    let mut parent = blank_thread(&parent_id, None, "Parent", "antigravity", None);
    parent["subagentRuns"] = json!([
        {
            "subagentId": "sub_settled_race",
            "parentThreadId": parent_id,
            "parentToolCallId": "call_settled",
            "childThreadId": settled_child,
            "role": "Worker A",
            "status": "running",
            "latestActivity": "Running step",
            "stepCount": 1,
            "items": [],
            "startedAtUnixMs": 100,
            "updatedAtUnixMs": 150
        },
        {
            "subagentId": "sub_kill_live",
            "parentThreadId": parent_id,
            "parentToolCallId": "call_killed",
            "childThreadId": killed_child,
            "role": "Worker B",
            "status": "running",
            "latestActivity": "Running tool",
            "stepCount": 1,
            "items": [],
            "startedAtUnixMs": 100,
            "updatedAtUnixMs": 150
        }
    ]);
    parent["items"] = json!([
        {
            "id": "call_settled",
            "kind": "tool",
            "toolKind": "subagent",
            "status": "running",
            "subagentMeta": { "subagentId": "sub_settled_race", "childThreadId": settled_child, "status": "running" }
        },
        {
            "id": "call_killed",
            "kind": "tool",
            "toolKind": "subagent",
            "status": "running",
            "subagentMeta": { "subagentId": "sub_kill_live", "childThreadId": killed_child, "status": "running" }
        }
    ]);
    threads().lock().unwrap().push(parent);

    let mut c1 = blank_thread(&settled_child, None, "Child S", "grok", None);
    c1["parentThreadId"] = json!(parent_id);
    c1["status"] = json!("idle");
    c1["items"] = json!([{ "id": "a1", "kind": "assistant", "text": "Finished output" }]);
    let mut c2 = blank_thread(&killed_child, None, "Child K", "grok", None);
    c2["parentThreadId"] = json!(parent_id);
    c2["status"] = json!("running");
    c2["items"] = json!([{ "id": "t1", "kind": "tool", "toolName": "shell", "status": "running" }]);
    threads().lock().unwrap().push(c1);
    threads().lock().unwrap().push(c2);

    // 1. Natural settlement already won before Stop click -> Stop must NOT mark killed.
    assert!(crate::chat::kill_registry::try_mark_thread_settled(&settled_child));
    let settled_res = cancel_subagent_thread(&parent_id, "sub_settled_race").unwrap();
    assert_eq!(settled_res["status"], "completed");
    assert!(!crate::chat::kill_registry::is_thread_killed(&settled_child));

    // 2. Live child with active TurnRun: cancel_turn synchronously calls finish_run + sync_child_thread_to_parent,
    // and Stop must still preserve "killed" and "Stopped by user".
    let live_run_id = format!("run-live-kill-{}", uuid::Uuid::new_v4().simple());
    {
        use crate::chat::runtime::state::{live_turns, TurnRun};
        let mut live = live_turns().lock().unwrap();
        live.by_thread.insert(killed_child.clone(), live_run_id.clone());
        live.runs.insert(
            live_run_id.clone(),
            TurnRun {
                revision: "1".into(),
                events: Vec::new(),
                next_sequence: 0,
                assistant_id: "asst_k".into(),
                assistant_text: String::new(),
                child: None,
                stdin: None,
                closing: false,
                finished: false,
                started_at_ms: 100,
                finished_at_ms: None,
                routine_id: None,
                delivered_through: 0,
                file_baselines: std::collections::HashMap::new(),
            },
        );
    }
    let killed_res = cancel_subagent_thread(&parent_id, "sub_kill_live").unwrap();
    assert_eq!(killed_res["status"], "killed");
    assert_eq!(killed_res["latestActivity"], "Stopped by user");
    {
        use crate::chat::runtime::state::live_turns;
        let mut live = live_turns().lock().unwrap();
        live.by_thread.remove(&killed_child);
        live.runs.remove(&live_run_id);
    }
    crate::chat::kill_registry::clear_thread_killed(&settled_child);
    crate::chat::kill_registry::clear_thread_killed(&killed_child);
}

#[test]
fn sequential_retries_with_identical_role_and_prompt_stay_separate() {
    let parent_id = format!("parent-retry-{}", uuid::Uuid::new_v4().simple());
    let _cleanup = CleanupThread(parent_id.clone());
    let parent = blank_thread(&parent_id, None, "Parent", "antigravity", None);
    threads().lock().unwrap().push(parent.clone());

    let unbound_failed_item = json!({
        "id": "call_retry_0_unbound",
        "kind": "toolCall",
        "toolKind": "subagent",
        "toolName": "kite dispatch run",
        "status": "error",
        "text": "initial dispatch validation failed",
        "subagentMeta": {
            "parentThreadId": parent_id,
            "role": "Fast Executor",
            "prompt": "Inspect package.json",
            "provider": "grok",
            "model": "grok-4.7",
            "status": "failed"
        }
    });
    {
        let mut guard = threads().lock().unwrap();
        let stored_parent = guard
            .iter_mut()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(parent_id.as_str()))
            .unwrap();
        upsert_item(stored_parent, &unbound_failed_item);
        let items = stored_parent.get("items").and_then(Value::as_array).unwrap();
        assert_eq!(
            super::find_reclaimable_unbound_subagent_call_id(
                items,
                "Fast Executor",
                "Inspect package.json",
            ),
            None,
            "terminal unbound subagent tool calls must never be reclaimed"
        );
    }

    for idx in 1..=3 {
        let sub_id = format!("sub_retry_{idx}");
        let child_id = format!("child_retry_{idx}_{}", uuid::Uuid::new_v4().simple());
        let call_id = format!("call_retry_{idx}");
        let tool_item = json!({
            "id": call_id,
            "kind": "toolCall",
            "toolKind": "subagent",
            "toolName": "kite dispatch run",
            "status": "error",
            "text": format!("attempt {idx} failed"),
            "subagentMeta": {
                "subagentId": sub_id,
                "parentThreadId": parent_id,
                "childThreadId": child_id,
                "role": "Fast Executor",
                "prompt": "Inspect package.json",
                "provider": "grok",
                "model": "grok-4.7",
                "status": "failed"
            }
        });
        record_subagent_tool_call(&parent_id, &tool_item);
        {
            let mut guard = threads().lock().unwrap();
            let stored_parent = guard
                .iter_mut()
                .find(|t| t.get("id").and_then(Value::as_str) == Some(parent_id.as_str()))
                .unwrap();
            upsert_item(stored_parent, &tool_item);
        }

        // Simulated dispatch-subagent mirror card from subagent card emitter
        let mirror_item = json!({
            "id": format!("dispatch-subagent-{child_id}"),
            "kind": "toolCall",
            "toolKind": "subagent",
            "toolName": "Subagent: Fast Executor",
            "status": "error",
            "text": format!("attempt {idx} failed"),
            "subagentMeta": {
                "subagentId": sub_id,
                "parentThreadId": parent_id,
                "childThreadId": child_id,
                "role": "Fast Executor",
                "prompt": "Inspect package.json",
                "provider": "grok",
                "model": "grok-4.7",
                "status": "failed"
            }
        });
        {
            let mut guard = threads().lock().unwrap();
            let stored_parent = guard
                .iter_mut()
                .find(|t| t.get("id").and_then(Value::as_str) == Some(parent_id.as_str()))
                .unwrap();
            upsert_item(stored_parent, &mirror_item);
        }
    }

    let mut stored = {
        let guard = threads().lock().unwrap();
        guard
            .iter()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(parent_id.as_str()))
            .cloned()
            .unwrap()
    };
    reconcile_duplicate_subagent_state(&mut stored);

    let runs = stored["subagentRuns"].as_array().expect("subagentRuns array");
    assert_eq!(runs.len(), 3, "sequential retries must not collapse: {runs:?}");
    let items = stored["items"].as_array().expect("items array");
    let dispatch_items = items
        .iter()
        .filter(|it| {
            it.get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| id.starts_with("dispatch-subagent-"))
        })
        .count();
    let real_items = items
        .iter()
        .filter(|it| {
            it.get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| id.starts_with("call_retry_"))
        })
        .count();
    assert_eq!(real_items, 4, "terminal unbound retry and all 3 real tool call items must remain separate");
    let unbound_zero = items
        .iter()
        .find(|it| it.get("id").and_then(Value::as_str) == Some("call_retry_0_unbound"))
        .expect("unbound failed card must still exist");
    assert!(
        unbound_zero
            .pointer("/subagentMeta/childThreadId")
            .and_then(Value::as_str)
            .is_none_or(|s| s.trim().is_empty()),
        "reconcile_duplicate_subagent_state must not hijack a terminal unbound item: {unbound_zero:?}"
    );
    assert_eq!(
        dispatch_items, 0,
        "mirror cards with matching childThreadId should fold cleanly into their bound real tool calls"
    );
}

#[test]
fn sync_child_thread_to_parent_surfaces_turn_failure_message() {
    let parent_id = format!("parent-fail-{}", uuid::Uuid::new_v4().simple());
    let child_id = format!("child-fail-{}", uuid::Uuid::new_v4().simple());
    let _c1 = CleanupThread(parent_id.clone());
    let _c2 = CleanupThread(child_id.clone());

    let mut parent = blank_thread(&parent_id, None, "Parent", "antigravity", None);
    parent["subagentRuns"] = json!([{
        "subagentId": "sub_fail_1",
        "parentThreadId": parent_id,
        "childThreadId": child_id,
        "role": "Fast Executor",
        "status": "running",
        "stepCount": 0,
        "items": [],
        "startedAtUnixMs": 100,
        "updatedAtUnixMs": 100
    }]);

    let mut child = blank_thread(&child_id, None, "Child", "grok", None);
    child["startedByAgent"] = json!(true);
    child["parentThreadId"] = json!(parent_id);
    child["status"] = json!("error");
    child["turnFailure"] = json!({ "message": "Provider rate limit exceeded" });
    child["items"] = json!([{
        "id": "u-1",
        "kind": "user",
        "text": "Do something quick"
    }]);

    {
        let mut guard = threads().lock().unwrap();
        guard.push(parent);
        guard.push(child);
    }

    sync_child_thread_to_parent(&child_id);

    let guard = threads().lock().unwrap();
    let updated = guard
        .iter()
        .find(|t| t.get("id").and_then(Value::as_str) == Some(parent_id.as_str()))
        .unwrap();
    let run = &updated["subagentRuns"][0];
    assert_eq!(run["status"], "failed");
    assert_eq!(run["latestActivity"], "Provider rate limit exceeded");
    let run_items = run["items"].as_array().expect("run items");
    assert!(
        run_items.iter().any(|it| {
            it.get("kind").and_then(Value::as_str) == Some("error")
                && it.get("text").and_then(Value::as_str) == Some("Provider rate limit exceeded")
        }),
        "expected canonical error item in run items, got: {run_items:?}"
    );
}

#[test]
fn reconcile_duplicate_subagent_state_downgrades_manage_subagents_and_inherits_parent_model() {
    let tid = format!("phantom-clean-{}", uuid::Uuid::new_v4().simple());
    let _cleanup = CleanupThread(tid.clone());
    let mut thread = blank_thread(&tid, None, "Parent", "antigravity", None);
    thread["model"] = json!("gemini-4-argon");
    thread["items"] = json!([
        {
            "id": "t_manage_1",
            "kind": "tool",
            "toolName": "manage_subagents",
            "toolKind": "subagent",
            "title": "Subagent · Subagent",
            "detail": "",
            "text": "You have 1 active subagent(s):\n[]",
            "status": "completed",
            "subagentMeta": {
                "subagentId": "t_manage_1",
                "role": "Subagent",
                "provider": "antigravity",
                "model": null,
                "status": "completed",
                "stepCount": 0
            }
        }
    ]);
    thread["subagentRuns"] = json!([
        {
            "subagentId": "t_manage_1",
            "parentThreadId": tid,
            "parentToolCallId": "t_manage_1",
            "role": "Subagent",
            "provider": "antigravity",
            "model": null,
            "status": "completed",
            "stepCount": 0,
            "items": [],
            "startedAtUnixMs": 100,
            "updatedAtUnixMs": 100
        }
    ]);

    reconcile_duplicate_subagent_state(&mut thread);

    assert_eq!(thread["items"][0]["toolKind"], "dynamicToolCall");
    assert!(thread["items"][0].get("subagentMeta").is_none());
    assert!(
        thread["subagentRuns"].as_array().unwrap().is_empty(),
        "phantom manage_subagents run must be pruned"
    );

    // Also verify record_subagent_tool_call resolves "inherit"/missing model to parent's model
    threads().lock().unwrap().push(thread);
    let invoke_item = acp_tool_to_chat_item(&build_acp_tool_call(
        "t_invoke_1".into(),
        "invoke_subagent",
        json!({
            "Role": "Spec Verifier",
            "TypeName": "research",
            "Prompt": "Verify ODD",
            "Model": "inherit"
        }),
        "running".into(),
        None, None, None, None, None, None, None, None,
    ));
    {
        let mut guard = threads().lock().unwrap();
        let t = guard.iter_mut().find(|t| t["id"] == tid).unwrap();
        upsert_item(t, &invoke_item);
    }
    record_subagent_tool_call(&tid, &invoke_item);

    let (run_model, item_model) = {
        let guard = threads().lock().unwrap();
        let updated = guard.iter().find(|t| t["id"] == tid).unwrap();
        let run_model = updated["subagentRuns"][0]["model"].clone();
        let item_model = updated["items"]
            .as_array()
            .and_then(|arr| arr.iter().find(|it| it["id"] == "t_invoke_1"))
            .and_then(|it| it.pointer("/subagentMeta/model"))
            .cloned()
            .unwrap_or(Value::Null);
        (run_model, item_model)
    };
    assert_eq!(run_model, "gemini-4-argon");
    assert_eq!(item_model, "gemini-4-argon");
}

#[test]
fn reconcile_native_antigravity_subagents_surfaces_missed_invoke_with_inherited_model_and_transcript() {
    struct TempDirGuard(std::path::PathBuf);
    impl Drop for TempDirGuard {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    let root = std::env::temp_dir().join(format!("kite-agy-reconcile-{}", uuid::Uuid::new_v4().simple()));
    let _dir_guard = TempDirGuard(root.clone());
    let parent_logs = root.join("parent").join(".system_generated").join("logs");
    let cid = format!("cid-agy-{}", uuid::Uuid::new_v4().simple());
    let child_logs = root.join(&cid).join(".system_generated").join("logs");
    std::fs::create_dir_all(&parent_logs).unwrap();
    std::fs::create_dir_all(&child_logs).unwrap();

    let child_transcript = child_logs.join("transcript.jsonl");
    let child_lines = [
        json!({
            "type": "PLANNER_RESPONSE",
            "created_at": "2026-11-15T12:00:05Z",
            "tool_calls": [
                {
                    "id": "child_tc_1",
                    "name": "run_command",
                    "args": { "CommandLine": "npx vitest run" }
                }
            ]
        })
        .to_string(),
        json!({
            "type": "PLANNER_RESPONSE",
            "created_at": "2026-11-15T12:00:08Z",
            "content": "Verified thread checks cleanly."
        })
        .to_string(),
    ]
    .join("\n");
    std::fs::write(&child_transcript, child_lines).unwrap();

    let child_uri = child_transcript.to_string_lossy().to_string();
    let parent_lines = [
        json!({
            "type": "PLANNER_RESPONSE",
            "created_at": "2026-11-15T12:00:01Z",
            "tool_calls": [
                {
                    "id": "call_invoke_1",
                    "name": "invoke_subagent",
                    "args": {
                        "Role": "Spec Verifier",
                        "TypeName": "research",
                        "Prompt": "Audit thread",
                        "Model": "inherit"
                    }
                }
            ]
        })
        .to_string(),
        json!({
            "type": "TOOL_RESPONSE",
            "created_at": "2026-11-15T12:00:02Z",
            "content": json!({
                "conversationId": cid,
                "logAbsoluteUri": child_uri
            }).to_string()
        })
        .to_string(),
    ]
    .join("\n");
    std::fs::write(parent_logs.join("transcript_full.jsonl"), parent_lines).unwrap();

    let tid = format!("agy-parent-{}", uuid::Uuid::new_v4().simple());
    let mut thread = blank_thread(&tid, None, "Parent", "antigravity", None);
    thread["model"] = json!("gemini-4-argon");
    thread["providerSessionId"] = json!("parent-session-test");
    thread["items"] = json!([
        {
            "id": "u_1",
            "kind": "user",
            "text": "Audit thread",
            "createdAtUnixMs": 100
        },
        {
            "id": "t_manage_1",
            "kind": "tool",
            "toolName": "manage_subagents",
            "toolKind": "subagent",
            "title": "Subagent · Subagent",
            "detail": "",
            "text": json!([{
                "conversationId": cid,
                "role": "Spec Verifier",
                "type": "research",
                "state": "idle",
                "transcript": child_uri
            }]).to_string(),
            "status": "completed",
            "createdAtUnixMs": 200,
            "subagentMeta": {
                "subagentId": "t_manage_1",
                "role": "Subagent",
                "provider": "antigravity",
                "model": null,
                "status": "completed",
                "stepCount": 0
            }
        }
    ]);
    thread["subagentRuns"] = json!([
        {
            "subagentId": "t_manage_1",
            "parentThreadId": tid,
            "parentToolCallId": "t_manage_1",
            "role": "Subagent",
            "provider": "antigravity",
            "model": null,
            "status": "completed",
            "stepCount": 0,
            "items": [],
            "startedAtUnixMs": 200,
            "updatedAtUnixMs": 200
        }
    ]);

    hydrate_antigravity_subagents_with_logs_dir(&mut thread, Some(&parent_logs));

    let items = thread["items"].as_array().unwrap();
    let manage_item = items.iter().find(|it| it["id"] == "t_manage_1").unwrap();
    assert_eq!(manage_item["toolKind"], "dynamicToolCall");
    assert!(manage_item.get("subagentMeta").is_none());

    let invoke_item = items
        .iter()
        .find(|it| it.pointer("/subagentMeta/subagentId").and_then(Value::as_str) == Some(cid.as_str()))
        .expect("reconciled invoke_subagent item must exist");
    assert_eq!(invoke_item["toolKind"], "subagent");
    assert_eq!(invoke_item["subagentMeta"]["role"], "Spec Verifier");
    assert_eq!(invoke_item["subagentMeta"]["typeName"], "research");
    assert_eq!(invoke_item["subagentMeta"]["model"], "gemini-4-argon");
    assert_eq!(invoke_item["subagentMeta"]["prompt"], "Audit thread");
    assert!(invoke_item["subagentMeta"]["stepCount"].as_u64().unwrap_or(0) > 0);

    let runs = thread["subagentRuns"].as_array().unwrap();
    assert_eq!(runs.len(), 1, "phantom run must be gone and canonical run kept: {runs:?}");
    let run = &runs[0];
    assert_eq!(run["subagentId"], cid);
    assert_eq!(run["model"], "gemini-4-argon");
    assert_eq!(run["role"], "Spec Verifier");
    assert!(run["stepCount"].as_u64().unwrap_or(0) > 0);
    assert!(!run["items"].as_array().unwrap().is_empty());
}

#[test]
fn reconcile_native_antigravity_settles_running_discoveries_on_idle_parent_and_skips_clean_reload() {
    struct TempDirGuard(std::path::PathBuf);
    impl Drop for TempDirGuard {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    let root = std::env::temp_dir().join(format!("kite-agy-settled-{}", uuid::Uuid::new_v4().simple()));
    let _dir_guard = TempDirGuard(root.clone());
    let parent_logs = root.join("parent").join(".system_generated").join("logs");
    let cid = format!("cid-settled-{}", uuid::Uuid::new_v4().simple());
    let child_logs = root.join(&cid).join(".system_generated").join("logs");
    std::fs::create_dir_all(&parent_logs).unwrap();
    std::fs::create_dir_all(&child_logs).unwrap();

    let child_transcript = child_logs.join("transcript.jsonl");
    std::fs::write(
        &child_transcript,
        json!({
            "type": "PLANNER_RESPONSE",
            "created_at": "2026-11-15T12:00:05Z",
            "content": "Completed verification."
        })
        .to_string(),
    )
    .unwrap();
    let child_uri = child_transcript.to_string_lossy().to_string();

    // Parent transcript has TOOL_RESPONSE without manage_subagents status rows
    let parent_lines = [
        json!({
            "type": "PLANNER_RESPONSE",
            "created_at": "2026-11-15T12:00:01Z",
            "tool_calls": [{
                "id": "call_inv_settled",
                "name": "invoke_subagent",
                "args": { "Role": "Idle Checker", "TypeName": "research", "Prompt": "Check", "Model": "inherit" }
            }]
        })
        .to_string(),
        json!({
            "type": "TOOL_RESPONSE",
            "created_at": "2026-11-15T12:00:02Z",
            "content": json!({
                "conversationId": cid,
                "logAbsoluteUri": child_uri
            }).to_string()
        })
        .to_string(),
    ]
    .join("\n");
    std::fs::write(parent_logs.join("transcript_full.jsonl"), parent_lines).unwrap();

    let tid = format!("agy-idle-{}", uuid::Uuid::new_v4().simple());
    let mut thread = blank_thread(&tid, None, "Settled Parent", "antigravity", None);
    thread["model"] = json!("gemini-4-argon");
    thread["providerSessionId"] = json!("parent-session-settled");
    thread["status"] = json!("idle");

    hydrate_antigravity_subagents_with_logs_dir(&mut thread, Some(&parent_logs));

    let items = thread["items"].as_array().unwrap();
    let invoke_item = items
        .iter()
        .find(|it| it.pointer("/subagentMeta/subagentId").and_then(Value::as_str) == Some(cid.as_str()))
        .expect("discovered invoke_subagent item");
    assert_eq!(invoke_item["status"], "completed");
    assert_eq!(invoke_item["streaming"], false);
    assert_eq!(invoke_item["subagentMeta"]["status"], "completed");

    let run = &thread["subagentRuns"][0];
    assert_eq!(run["status"], "completed");
    assert!(run.get("completedAtUnixMs").and_then(Value::as_i64).is_some());

    // Once hydrated, ordinary settled Antigravity thread must NOT re-trigger transcript reload
    assert!(
        !needs_antigravity_transcript_reconcile(&thread),
        "clean settled Antigravity thread must skip disk transcript parsing on load"
    );

    // An ordinary Antigravity thread without subagent items/runs must also skip disk reconcile
    let clean_settled = blank_thread("clean-agy-1", None, "Clean", "antigravity", None);
    assert!(!needs_antigravity_transcript_reconcile(&clean_settled));
}

#[test]
fn reconcile_preserves_real_terminal_zero_step_unmodeled_subagent_and_filters_spawn_inherit() {
    let tid = format!("real-zero-step-{}", uuid::Uuid::new_v4().simple());
    let _cleanup = CleanupThread(tid.clone());
    let mut thread = blank_thread(&tid, None, "Unmodeled Parent", "antigravity", None);
    thread["model"] = json!("automatic");
    thread["items"] = json!([
        {
            "id": "t_real_fail",
            "kind": "tool",
            "toolName": "invoke_subagent",
            "toolKind": "subagent",
            "title": "Subagent · Subagent",
            "detail": "",
            "text": "Timed out",
            "status": "failed",
            "streaming": false,
            "subagentMeta": {
                "subagentId": "t_real_fail",
                "role": "Subagent",
                "provider": "antigravity",
                "model": null,
                "status": "failed",
                "stepCount": 0
            }
        }
    ]);
    thread["subagentRuns"] = json!([
        {
            "subagentId": "t_real_fail",
            "parentThreadId": tid,
            "parentToolCallId": "t_real_fail",
            "role": "Subagent",
            "provider": "antigravity",
            "model": null,
            "status": "failed",
            "stepCount": 0,
            "items": [],
            "startedAtUnixMs": 100,
            "updatedAtUnixMs": 100,
            "completedAtUnixMs": 150
        },
        {
            "subagentId": "t_orphan_ghost",
            "parentThreadId": tid,
            "parentToolCallId": "t_orphan_ghost",
            "role": "Subagent",
            "provider": "antigravity",
            "model": null,
            "status": "completed",
            "stepCount": 0,
            "items": [],
            "startedAtUnixMs": 100,
            "updatedAtUnixMs": 100,
            "completedAtUnixMs": 150
        }
    ]);

    reconcile_duplicate_subagent_state(&mut thread);

    let runs = thread["subagentRuns"].as_array().unwrap();
    assert_eq!(runs.len(), 1, "real 0-step failed run must survive while orphan ghost is pruned: {runs:?}");
    assert_eq!(runs[0]["subagentId"], "t_real_fail");
    assert!(!needs_antigravity_transcript_reconcile(&thread));

    // Also verify spawn_child_subagent_thread filters literal "inherit" model and routes heavy parent to lightweight tier (S15)
    let pid = format!("spawn-inherit-parent-{}", uuid::Uuid::new_v4().simple());
    let _p_cleanup = CleanupThread(pid.clone());
    let mut parent = blank_thread(&pid, None, "Parent", "antigravity", None);
    parent["model"] = json!("gemini-4-argon");
    threads().lock().unwrap().push(parent);

    let spawned = spawn_child_subagent_thread(ChildSubagentSpawnParams {
        parent_thread_id: Some(pid),
        provider: Some("antigravity".into()),
        model: Some("inherit".into()),
        effort: None,
        role: Some("Spawned Worker".into()),
        agent_id: None,
        mode: None,
        workspace_mode: "inherit".into(),
        fallback_cwd: None,
        task: "Check".into(),
    })
    .expect("spawn child");
    let _c_cleanup = CleanupThread(spawned.child_thread_id.clone());
    assert_eq!(spawned.model.as_deref(), Some("gemini-4-hydrogen"));
}

#[test]
fn errored_parent_keeps_child_completed_when_its_transcript_ended_with_a_final_response() {
    struct TempDirGuard(std::path::PathBuf);
    impl Drop for TempDirGuard {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    let root = std::env::temp_dir().join(format!("kite-agy-errored-{}", uuid::Uuid::new_v4().simple()));
    let _dir_guard = TempDirGuard(root.clone());
    let parent_logs = root.join("parent").join(".system_generated").join("logs");
    std::fs::create_dir_all(&parent_logs).unwrap();

    let make_child = |name: &str, last_step: Value| -> (String, String) {
        let cid = format!("cid-{name}-{}", uuid::Uuid::new_v4().simple());
        let logs = root.join(&cid).join(".system_generated").join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        let transcript = logs.join("transcript.jsonl");
        std::fs::write(&transcript, last_step.to_string()).unwrap();
        (cid, transcript.to_string_lossy().to_string())
    };
    let (done_cid, done_uri) = make_child(
        "done",
        json!({ "type": "PLANNER_RESPONSE", "status": "DONE", "content": "{\"findings\":[]}" }),
    );
    let (cut_cid, cut_uri) = make_child(
        "cut",
        json!({
            "type": "PLANNER_RESPONSE",
            "status": "DONE",
            "content": "Reading files",
            "tool_calls": [{ "id": "c1", "name": "view_file", "args": {} }]
        }),
    );

    let mut lines = Vec::new();
    for (idx, (cid, uri)) in [(&done_cid, &done_uri), (&cut_cid, &cut_uri)].into_iter().enumerate() {
        lines.push(
            json!({
                "type": "PLANNER_RESPONSE",
                "created_at": format!("2026-11-15T12:00:0{}Z", idx * 2 + 1),
                "tool_calls": [{
                    "id": format!("call_inv_{idx}"),
                    "name": "invoke_subagent",
                    "args": { "Role": format!("Checker {idx}"), "TypeName": "research", "Prompt": "Check", "Model": "inherit" }
                }]
            })
            .to_string(),
        );
        lines.push(
            json!({
                "type": "TOOL_RESPONSE",
                "created_at": format!("2026-11-15T12:00:0{}Z", idx * 2 + 2),
                "content": json!({ "conversationId": cid, "logAbsoluteUri": uri }).to_string()
            })
            .to_string(),
        );
    }
    std::fs::write(parent_logs.join("transcript_full.jsonl"), lines.join("\n")).unwrap();

    let tid = format!("agy-errored-{}", uuid::Uuid::new_v4().simple());
    let mut thread = blank_thread(&tid, None, "Errored Parent", "antigravity", None);
    thread["model"] = json!("gemini-4-argon");
    thread["providerSessionId"] = json!("parent-session-errored");
    thread["status"] = json!("error");

    hydrate_antigravity_subagents_with_logs_dir(&mut thread, Some(&parent_logs));

    let status_of = |cid: &str| {
        thread["subagentRuns"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["subagentId"] == cid)
            .map(|r| r["status"].clone())
    };
    assert_eq!(status_of(&done_cid), Some(json!("completed")));
    assert_eq!(status_of(&cut_cid), Some(json!("failed")));
}

#[test]
fn latest_activity_never_surfaces_raw_json_reports() {
    let report = json!({
        "findings": [{ "location": "a.rs:1", "claim": "x" }, { "location": "b.rs:2", "claim": "y" }]
    })
    .to_string();
    let (_, activity) = summarize_run_progress(&[json!({ "kind": "assistant", "text": report })]);
    assert_eq!(activity.as_deref(), Some("Reported 2 findings"));

    let (_, truncated) =
        summarize_run_progress(&[json!({ "kind": "assistant", "text": "{\"findings\":[{\"loc" })]);
    assert_eq!(truncated.as_deref(), Some("Returned a structured report"));

    let (_, prose) =
        summarize_run_progress(&[json!({ "kind": "assistant", "text": "All good.\nDetails follow." })]);
    assert_eq!(prose.as_deref(), Some("All good."));
}

#[test]
fn reconcile_native_antigravity_preserves_completed_subagent_while_parent_is_running_and_ignores_missing_uri() {
    struct TempDirGuard(std::path::PathBuf);
    impl Drop for TempDirGuard {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    let root = std::env::temp_dir().join(format!(
        "kite-agy-completed-parent-active-{}",
        uuid::Uuid::new_v4().simple()
    ));
    let _dir_guard = TempDirGuard(root.clone());
    let parent_logs = root.join("parent").join(".system_generated").join("logs");
    let cid_existing = format!("cid-done-{}", uuid::Uuid::new_v4().simple());
    let cid_new_done = format!("cid-new-done-{}", uuid::Uuid::new_v4().simple());
    let logs_existing = root.join(&cid_existing).join(".system_generated").join("logs");
    let logs_new_done = root.join(&cid_new_done).join(".system_generated").join("logs");
    std::fs::create_dir_all(&parent_logs).unwrap();
    std::fs::create_dir_all(&logs_existing).unwrap();
    std::fs::create_dir_all(&logs_new_done).unwrap();

    // Existing subagent already completed earlier; another newly discovered invoke's transcript also finished.
    let existing_uri = logs_existing.join("transcript.jsonl").to_string_lossy().to_string();
    let new_done_uri = logs_new_done.join("transcript.jsonl").to_string_lossy().to_string();
    std::fs::write(
        &new_done_uri,
        json!({ "type": "PLANNER_RESPONSE", "status": "DONE", "content": "Finished check." }).to_string(),
    )
    .unwrap();

    let parent_lines = [
        json!({
            "type": "PLANNER_RESPONSE",
            "created_at": "2026-11-17T20:00:01Z",
            "tool_calls": [
                { "id": "inv_1", "name": "invoke_subagent", "args": { "Role": "First Verifier", "TypeName": "research", "Prompt": "P1" } },
                { "id": "inv_2", "name": "invoke_subagent", "args": { "Role": "Second Verifier", "TypeName": "research", "Prompt": "P2" } }
            ]
        })
        .to_string(),
        json!({
            "type": "GENERIC",
            "created_at": "2026-11-17T20:00:02Z",
            "content": format!("Created the following subagent:\n{}", json!({ "conversationId": cid_existing, "logAbsoluteUri": existing_uri }))
        })
        .to_string(),
        json!({
            "type": "GENERIC",
            "created_at": "2026-11-17T20:00:03Z",
            "content": format!("Created the following subagent:\n{}", json!({ "conversationId": cid_new_done, "logAbsoluteUri": new_done_uri }))
        })
        .to_string(),
    ]
    .join("\n");
    std::fs::write(parent_logs.join("transcript_full.jsonl"), parent_lines).unwrap();

    let tid = format!("agy-active-parent-{}", uuid::Uuid::new_v4().simple());
    let mut thread = blank_thread(&tid, None, "Active Parent", "antigravity", None);
    thread["model"] = json!("gemini-4-hydrogen");
    thread["providerSessionId"] = json!("parent-session-active");
    thread["status"] = json!("running");
    thread["items"] = json!([
        {
            "id": "call_1",
            "kind": "tool",
            "toolKind": "subagent",
            "toolName": "invoke_subagent",
            "title": "Subagent · First Verifier",
            "status": "completed",
            "streaming": false,
            "subagentMeta": {
                "subagentId": cid_existing,
                "role": "First Verifier",
                "model": "gemini-4-hydrogen",
                "status": "completed",
                "transcriptUri": existing_uri,
                "stepCount": 5
            }
        }
    ]);
    thread["subagentRuns"] = json!([
        {
            "subagentId": cid_existing,
            "parentThreadId": tid,
            "parentToolCallId": "call_1",
            "role": "First Verifier",
            "model": "gemini-4-hydrogen",
            "status": "completed",
            "transcriptUri": existing_uri,
            "stepCount": 5,
            "items": [{ "id": "s1", "kind": "assistant", "text": "Done" }],
            "completedAtUnixMs": 1000
        }
    ]);

    hydrate_antigravity_subagents_with_logs_dir(&mut thread, Some(&parent_logs));

    let runs = thread["subagentRuns"].as_array().unwrap();
    let existing_run = runs.iter().find(|r| r["subagentId"] == cid_existing).unwrap();
    assert_eq!(existing_run["status"], json!("completed"), "existing completed run must never regress to running");
    let new_done_run = runs.iter().find(|r| r["subagentId"] == cid_new_done).unwrap();
    assert_eq!(new_done_run["status"], json!("completed"), "completed child transcript must stay completed even while parent is running");

    let items = thread["items"].as_array().unwrap();
    let existing_item = items.iter().find(|it| it["id"] == "call_1").unwrap();
    assert_eq!(existing_item["status"], json!("completed"));
    assert_eq!(existing_item["streaming"], json!(false));
    assert_eq!(existing_item["subagentMeta"]["status"], json!("completed"));

    // Missing local transcript files with empty items must not infinitely re-trigger disk reconcile
    let mut missing_uri_thread = blank_thread("missing-uri-thread", None, "Missing URI", "antigravity", None);
    missing_uri_thread["providerSessionId"] = json!("parent-session-active");
    missing_uri_thread["subagentRuns"] = json!([{
        "subagentId": "sub-missing",
        "role": "Subagent",
        "status": "completed",
        "transcriptUri": root.join("nonexistent-missing-transcript.jsonl").to_string_lossy().to_string(),
        "items": []
    }]);
    assert!(
        !needs_antigravity_transcript_reconcile(&missing_uri_thread),
        "nonexistent local transcriptUri must not trigger endless reconcile loops on load"
    );
}

#[test]
fn parse_antigravity_parent_transcript_ignores_command_stdout_conversation_ids() {
    struct TempDirGuard(std::path::PathBuf);
    impl Drop for TempDirGuard {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    let root = std::env::temp_dir().join(format!(
        "kite-agy-stdout-{}",
        uuid::Uuid::new_v4().simple()
    ));
    let _dir_guard = TempDirGuard(root.clone());
    let parent_logs = root.join("parent").join(".system_generated").join("logs");
    std::fs::create_dir_all(&parent_logs).unwrap();

    // Parent ran a shell test printing conversationId JSON without ever calling invoke_subagent
    let parent_lines = [
        json!({
            "type": "PLANNER_RESPONSE",
            "created_at": "2026-11-17T20:00:01Z",
            "tool_calls": [
                { "id": "call_cmd", "name": "run_command", "args": { "CommandLine": "cargo test" } }
            ]
        })
        .to_string(),
        json!({
            "type": "GENERIC",
            "created_at": "2026-11-17T20:00:02Z",
            "content": "let agy_out = r#\"{\"conversationId\":\"sub-conv-42\",\"logAbsoluteUri\":\"file:///tmp/transcript.jsonl\"}\"#;"
        })
        .to_string(),
        json!({
            "type": "SYSTEM_MESSAGE",
            "created_at": "2026-11-17T20:00:03Z",
            "content": "{\"conversationId\":\"sys-conv-99\"}"
        })
        .to_string(),
    ]
    .join("\n");
    std::fs::write(parent_logs.join("transcript_full.jsonl"), parent_lines).unwrap();

    let tid = format!("agy-stdout-{}", uuid::Uuid::new_v4().simple());
    let mut thread = blank_thread(&tid, None, "Cmd Stdout", "antigravity", None);
    thread["providerSessionId"] = json!("parent-session-stdout");

    hydrate_antigravity_subagents_with_logs_dir(&mut thread, Some(&parent_logs));

    let runs = thread["subagentRuns"].as_array().cloned().unwrap_or_default();
    assert!(runs.is_empty(), "command stdout must never invent phantom subagentRuns: {runs:?}");
    let subagent_items: Vec<_> = thread["items"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|it| it.get("toolKind").and_then(Value::as_str) == Some("subagent") || it.get("subagentMeta").is_some())
        .collect();
    assert!(subagent_items.is_empty(), "command stdout must never invent phantom subagent items: {subagent_items:?}");
}

#[test]
fn parse_transcript_jsonl_strips_system_message_envelopes_and_skips_protocol_only_entries() {
    let lines = [
        json!({
            "type": "PLANNER_RESPONSE",
            "content": "user\nThe following is a <SYSTEM_MESSAGE> not actually sent by the user.\n<SYSTEM_MESSAGE>\n[Message] sender=sub1\n</SYSTEM_MESSAGE>"
        })
        .to_string(),
        json!({
            "type": "PLANNER_RESPONSE",
            "content": "Part one.\n<SYSTEM_MESSAGE>\n[Message] sender=sub2\n</SYSTEM_MESSAGE>Part two."
        })
        .to_string(),
        json!({
            "type": "PLANNER_RESPONSE",
            "content": "Discussing `<SYSTEM_MESSAGE>` tags in prose."
        })
        .to_string(),
        json!({
            "type": "assistant",
            "message": {
                "content": [
                    {
                        "type": "text",
                        "text": "user\nThe following is a <SYSTEM_MESSAGE> not actually sent by the user.\n<SYSTEM_MESSAGE>\n[Message] sender=sub3\n</SYSTEM_MESSAGE>"
                    }
                ]
            }
        })
        .to_string(),
    ]
    .join("\n");

    let items = parse_transcript_jsonl(&lines, "sub-clean");
    assert_eq!(items.len(), 2, "protocol-only entry must not produce an empty assistant item: {items:?}");
    assert_eq!(items[0]["text"], json!("Part one.\n\nPart two."));
    assert_eq!(items[1]["text"], json!("Discussing `<SYSTEM_MESSAGE>` tags in prose."));
}

#[test]
fn transcript_sync_and_reconcile_settle_completed_subagents_flush_unterminated_lines_prune_phantoms_and_downgrade_send_message() {
    let root = std::env::temp_dir().join(format!("kite-sub-settle-{}", uuid::Uuid::new_v4().simple()));
    let parent_logs = root.join("parent").join(".system_generated").join("logs");
    let eof_cid = format!("sub-eof-{}", uuid::Uuid::new_v4().simple());
    let eof_logs = root.join(&eof_cid).join(".system_generated").join("logs");
    let prior_cid = format!("sub-prior-{}", uuid::Uuid::new_v4().simple());
    let prior_logs = root.join(&prior_cid).join(".system_generated").join("logs");
    let active_cid = format!("sub-disc-{}", uuid::Uuid::new_v4().simple());
    let active_logs = root.join(&active_cid).join(".system_generated").join("logs");
    std::fs::create_dir_all(&parent_logs).unwrap();
    std::fs::create_dir_all(&eof_logs).unwrap();
    std::fs::create_dir_all(&prior_logs).unwrap();
    std::fs::create_dir_all(&active_logs).unwrap();

    // 1. Write child transcript WITHOUT a trailing newline on the final PLANNER_RESPONSE line.
    let eof_file = eof_logs.join("transcript.jsonl");
    let eof_content = format!(
        "{}\n{}",
        json!({ "step_index": 0, "type": "USER_INPUT", "status": "DONE", "content": "implement T15" }),
        json!({ "step_index": 1, "type": "PLANNER_RESPONSE", "status": "DONE", "tool_calls": [], "content": "Implemented and verified T15." })
    );
    std::fs::write(&eof_file, eof_content.as_bytes()).unwrap();

    let mut tail = TranscriptTailState::new();
    let ended = child_transcript_ended_with_final_response(Some(&format!(
        "file:///{}",
        eof_file.to_string_lossy().replace('\\', "/")
    )));
    assert!(ended, "child_transcript_ended_with_final_response must detect final PLANNER_RESPONSE without trailing newline");
    let inc_items = tail.read_incremental_items(&eof_file, &eof_cid, ended);
    assert_eq!(
        inc_items.len(),
        2,
        "read_incremental_items with ended=true must flush a complete final JSON line even without trailing newline: {inc_items:?}"
    );

    // 2. Write prior-session child transcript and current-session discovered child transcript.
    let prior_file = prior_logs.join("transcript.jsonl");
    std::fs::write(
        &prior_file,
        format!(
            "{}\n",
            json!({ "step_index": 10, "type": "PLANNER_RESPONSE", "status": "DONE", "tool_calls": [], "content": "Prior session subagent finished." })
        ),
    )
    .unwrap();
    let active_file = active_logs.join("transcript.jsonl");
    std::fs::write(
        &active_file,
        format!(
            "{}\n",
            json!({ "step_index": 5, "type": "PLANNER_RESPONSE", "status": "DONE", "tool_calls": [], "content": "Discovered subagent finished." })
        ),
    )
    .unwrap();

    // 3. Parent transcript has invoke_subagent for `active_cid` AND a completed background task `task-508`.
    let parent_lines = [
        json!({
            "step_index": 1,
            "type": "PLANNER_RESPONSE",
            "created_at": "2026-11-18T00:00:01Z",
            "tool_calls": [{
                "name": "invoke_subagent",
                "args": { "Role": "Spec Verifier", "Prompt": "Verify specs", "Model": "inherit" }
            }]
        })
        .to_string(),
        json!({
            "step_index": 2,
            "type": "GENERIC",
            "created_at": "2026-11-18T00:00:02Z",
            "content": format!("Created the following subagent:\n{}", json!({
                "conversationId": active_cid,
                "logAbsoluteUri": format!("file:///{}", active_file.to_string_lossy().replace('\\', "/"))
            }))
        })
        .to_string(),
        json!({
            "step_index": 508,
            "type": "GENERIC",
            "status": "RUNNING",
            "created_at": "2026-11-18T00:01:00Z",
            "content": "Tool is running as a background task with task id: parent-sess/task-508\n"
        })
        .to_string(),
        json!({
            "step_index": 514,
            "type": "SYSTEM_MESSAGE",
            "status": "DONE",
            "created_at": "2026-11-18T00:01:10Z",
            "content": "The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-18T00:01:10Z sender=parent-sess/task-508 priority=MESSAGE_PRIORITY_HIGH content=Task id \"parent-sess/task-508\" finished with result:\nCommand exited with code 0.\n\nCommand output:\nTSC CLEAN\n</SYSTEM_MESSAGE>"
        })
        .to_string(),
    ]
    .join("\n");
    std::fs::write(parent_logs.join("transcript_full.jsonl"), parent_lines).unwrap();

    let tid = format!("thread-sub-settle-{}", uuid::Uuid::new_v4().simple());
    let _cleanup = CleanupThread(tid.clone());
    let eof_uri = format!("file:///{}", eof_file.to_string_lossy().replace('\\', "/"));
    let prior_uri = format!("file:///{}", prior_file.to_string_lossy().replace('\\', "/"));
    let active_uri = format!("file:///{}", active_file.to_string_lossy().replace('\\', "/"));

    let mut thread = blank_thread(&tid, None, "Subagent Settle Test", "antigravity", None);
    thread["status"] = json!("running");
    thread["model"] = json!("gemini-4-argon");
    thread["providerSessionId"] = json!("parent-sess");
    thread["items"] = json!([
        {
            "id": "t_run1_239",
            "kind": "tool",
            "toolKind": "subagent",
            "toolName": "invoke_subagent",
            "title": "Subagent · EOF Writer",
            "status": "failed",
            "streaming": false,
            "text": "Interrupted before completion; retried in subsequent steps.",
            "subagentMeta": {
                "subagentId": eof_cid,
                "role": "EOF Writer",
                "status": "running",
                "transcriptUri": eof_uri,
                "stepCount": 1
            }
        },
        {
            "id": "t_run1_240",
            "kind": "tool",
            "toolKind": "subagent",
            "toolName": "invoke_subagent",
            "title": "Subagent · Prior Session Writer",
            "status": "failed",
            "streaming": false,
            "text": "Interrupted before completion; retried in subsequent steps.",
            "subagentMeta": {
                "subagentId": prior_cid,
                "role": "Prior Session Writer",
                "status": "running",
                "transcriptUri": prior_uri,
                "stepCount": 1
            }
        },
        {
            "id": "sub_sub-conv-42",
            "kind": "tool",
            "toolKind": "subagent",
            "toolName": "invoke_subagent",
            "title": "Subagent · Subagent",
            "status": "completed",
            "streaming": false,
            "text": "",
            "subagentMeta": {
                "subagentId": "sub-conv-42",
                "role": "Subagent",
                "status": "completed",
                "transcriptUri": "file:///C:/nonexistent/sub-conv-42/transcript.jsonl",
                "stepCount": 0
            }
        },
        {
            "id": "t_91db3537_415",
            "kind": "tool",
            "toolKind": "subagent",
            "toolName": "invoke_subagent",
            "title": "Subagent · Subagent",
            "status": "completed",
            "streaming": false,
            "createdAtUnixMs": 1_899_999_999_000i64,
            "text": "",
            "subagentMeta": {
                "subagentId": "t_91db3537_415",
                "role": "Subagent",
                "status": "completed",
                "stepCount": 0
            }
        },
        {
            "id": format!("sub_{active_cid}"),
            "kind": "tool",
            "toolKind": "subagent",
            "toolName": "invoke_subagent",
            "title": "Subagent · Spec Verifier",
            "status": "running",
            "streaming": true,
            "createdAtUnixMs": 1_700_000_000_000i64,
            "text": "",
            "subagentMeta": {
                "subagentId": active_cid,
                "role": "Spec Verifier",
                "status": "running",
                "transcriptUri": active_uri,
                "stepCount": 1
            }
        },
        {
            "id": "t_run1_402",
            "kind": "tool",
            "toolKind": "subagent",
            "toolName": "send_message",
            "title": "Subagent · Subagent",
            "status": "completed",
            "streaming": false,
            "text": "Message sent.",
            "subagentMeta": {
                "subagentId": active_cid,
                "role": "Subagent",
                "status": "completed",
                "stepCount": 0
            }
        },
        {
            "id": "t_run1_46",
            "kind": "tool",
            "toolKind": "commandExecution",
            "toolName": "run_command",
            "title": "Run frontend tests",
            "status": "completed",
            "streaming": false,
            "text": "The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-18T00:00:10Z sender=parent-sess/task-46 priority=MESSAGE_PRIORITY_HIGH content=Task id \"parent-sess/task-46\" finished with result:\nCommand exited with code 0.\n\nCommand output:\nVITEST PASS\n</SYSTEM_MESSAGE>"
        },
        {
            "id": "t_run1_508",
            "kind": "tool",
            "toolKind": "commandExecution",
            "toolName": "run_command",
            "title": "Run `npx tsc --noEmit`",
            "status": "running",
            "streaming": true,
            "text": "Tool is running as a background task with task id: parent-sess/task-508\n"
        }
    ]);
    thread["subagentRuns"] = json!([
        {
            "subagentId": eof_cid,
            "parentThreadId": tid,
            "parentToolCallId": "t_run1_239",
            "role": "EOF Writer",
            "status": "running",
            "transcriptUri": eof_uri,
            "stepCount": 1,
            "items": []
        },
        {
            "subagentId": prior_cid,
            "parentThreadId": tid,
            "parentToolCallId": "t_run1_240",
            "role": "Prior Session Writer",
            "status": "running",
            "transcriptUri": prior_uri,
            "stepCount": 1,
            "items": []
        },
        {
            "subagentId": "sub-conv-42",
            "parentThreadId": tid,
            "parentToolCallId": "sub_sub-conv-42",
            "role": "Subagent",
            "status": "completed",
            "transcriptUri": "file:///C:/nonexistent/sub-conv-42/transcript.jsonl",
            "stepCount": 0,
            "items": []
        },
        {
            "subagentId": "t_91db3537_415",
            "parentThreadId": tid,
            "parentToolCallId": "t_91db3537_415",
            "role": "Subagent",
            "status": "completed",
            "stepCount": 0,
            "items": []
        },
        {
            "subagentId": active_cid,
            "parentThreadId": tid,
            "parentToolCallId": format!("sub_{active_cid}"),
            "role": "Spec Verifier",
            "status": "running",
            "transcriptUri": active_uri,
            "stepCount": 1,
            "items": []
        }
    ]);
    threads().lock().unwrap().push(thread);

    // Syncing `eof_cid` directly must transition both run and parent item to completed and clear bogus interrupted text.
    sync_transcript_file(&tid, &eof_cid, &eof_uri);
    {
        let mut list = threads().lock().unwrap();
        let stored = list.iter_mut().find(|t| t["id"] == tid).unwrap();
        hydrate_antigravity_subagents_with_logs_dir(stored, Some(&parent_logs));
    }

    let final_thread = threads()
        .lock()
        .unwrap()
        .iter()
        .find(|t| t["id"] == tid)
        .cloned()
        .unwrap();
    let final_items = final_thread["items"].as_array().unwrap();
    let final_runs = final_thread["subagentRuns"].as_array().unwrap();

    // Phantom `sub_sub-conv-42` and `t_91db3537_415` must be gone from both items and runs.
    assert!(
        !final_items.iter().any(|it| it["id"] == "sub_sub-conv-42" || it["id"] == "t_91db3537_415"),
        "phantom placeholders must be pruned from items: {final_items:?}"
    );
    assert!(
        !final_runs.iter().any(|r| r["subagentId"] == "sub-conv-42" || r["subagentId"] == "t_91db3537_415"),
        "phantom placeholders must be pruned from subagentRuns: {final_runs:?}"
    );

    // `eof_cid`, `prior_cid`, and `active_cid` must all be completed with cleared interrupted text.
    for (item_id, cid) in [
        ("t_run1_239", eof_cid.as_str()),
        ("t_run1_240", prior_cid.as_str()),
        (&format!("sub_{active_cid}"), active_cid.as_str()),
    ] {
        let it = final_items.iter().find(|i| i["id"] == item_id).expect(item_id);
        assert_eq!(it["status"], json!("completed"), "item {item_id} must be completed");
        assert_eq!(it["streaming"], json!(false));
        assert_eq!(it["subagentMeta"]["status"], json!("completed"));
        assert_eq!(it["text"], json!(""), "bogus interrupted text on {item_id} must be cleared");
        let run = final_runs.iter().find(|r| r["subagentId"] == cid).expect(cid);
        assert_eq!(run["status"], json!("completed"), "run {cid} must be completed");
        assert!(run["completedAtUnixMs"].as_i64().is_some());
    }

    // `send_message` item (`t_run1_402`) must be downgraded from `subagent` to `dynamicToolCall` without killing `active_cid` run.
    let send_it = final_items.iter().find(|i| i["id"] == "t_run1_402").expect("send_message item");
    assert_eq!(send_it["toolKind"], json!("dynamicToolCall"));
    assert!(send_it.get("subagentMeta").is_none());

    // Background `run_command` items `t_run1_46` and `t_run1_508` must be completed and free of `<SYSTEM_MESSAGE>`.
    for cmd_id in ["t_run1_46", "t_run1_508"] {
        let cmd_it = final_items.iter().find(|i| i["id"] == cmd_id).expect(cmd_id);
        assert_eq!(cmd_it["status"], json!("completed"), "{cmd_id} must be completed");
        assert_eq!(cmd_it["streaming"], json!(false));
        let txt = cmd_it["text"].as_str().unwrap_or("");
        assert!(
            !txt.contains("<SYSTEM_MESSAGE>") && !txt.contains("Tool is running as a background task"),
            "{cmd_id} text must be clean command output, got: {txt}"
        );
    }

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn async_invoke_subagent_launch_stays_running_until_transcript_ends_and_placeholder_adopts_live() {
    let root = std::env::temp_dir().join(format!(
        "kite-async-invoke-{}",
        uuid::Uuid::new_v4().simple()
    ));
    let child_cid = format!("cid-async-{}", uuid::Uuid::new_v4().simple());
    let child_logs = root.join(&child_cid).join(".system_generated").join("logs");
    std::fs::create_dir_all(&child_logs).unwrap();
    let child_file = child_logs.join("transcript.jsonl");
    // Child transcript is still mid-execution (tool call with no final PLANNER_RESPONSE yet).
    std::fs::write(
        &child_file,
        format!(
            "{}\n",
            json!({
                "step_index": 0,
                "type": "PLANNER_RESPONSE",
                "status": "DONE",
                "tool_calls": [{ "id": "tc1", "name": "read_file", "args": { "Path": "src/App.tsx" } }],
                "content": ""
            })
        ),
    )
    .unwrap();
    let child_uri = format!("file:///{}", child_file.to_string_lossy().replace('\\', "/"));

    let tid = format!("thread-async-invoke-{}", uuid::Uuid::new_v4().simple());
    let _cleanup = CleanupThread(tid.clone());
    let mut thread = blank_thread(&tid, None, "Async Launch Test", "antigravity", None);
    thread["status"] = json!("running");
    thread["model"] = json!("gemini-4-hydrogen");

    // 1. Direct invoke_subagent completion receipt with live child transcript must keep status "running".
    let invoke_out = format!(
        "Created the following subagent:\n{}",
        json!({ "conversationId": child_cid, "logAbsoluteUri": child_uri })
    );
    let invoke_item = acp_tool_to_chat_item(&build_acp_tool_call(
        "t_run_inv1".into(),
        "invoke_subagent",
        json!({
            "Role": "Async Explorer",
            "TypeName": "research",
            "Prompt": "Explore codebase",
            "Model": "inherit"
        }),
        "completed".into(),
        Some(invoke_out),
        None, None, None, None, None, None, None,
    ));
    upsert_item(&mut thread, &invoke_item);
    threads().lock().unwrap().push(thread);

    record_subagent_tool_call(&tid, &invoke_item);

    let snap = threads()
        .lock()
        .unwrap()
        .iter()
        .find(|t| t["id"] == tid)
        .cloned()
        .unwrap();
    assert_eq!(
        snap["subagentRuns"][0]["status"],
        json!("running"),
        "async invoke_subagent launch must stay running while child transcript is active"
    );
    assert!(
        snap["subagentRuns"][0].get("completedAtUnixMs").is_none_or(Value::is_null),
        "async invoke_subagent launch must not record completedAtUnixMs at +2s"
    );
    let stored_item = snap["items"].as_array().unwrap().iter().find(|it| it["id"] == "t_run_inv1").unwrap();
    assert_eq!(stored_item["status"], json!("running"));
    assert_eq!(stored_item["subagentMeta"]["status"], json!("running"));

    // 2. Unbound 0-step placeholder prematurely marked "completed" must adopt into "running" when child is still active.
    let tid2 = format!("thread-async-ph-{}", uuid::Uuid::new_v4().simple());
    let _cleanup2 = CleanupThread(tid2.clone());
    let parent_logs = root.join("parent").join(".system_generated").join("logs");
    std::fs::create_dir_all(&parent_logs).unwrap();
    std::fs::write(
        parent_logs.join("transcript_full.jsonl"),
        [
            json!({
                "step_index": 1,
                "type": "PLANNER_RESPONSE",
                "tool_calls": [{ "name": "invoke_subagent", "args": { "Role": "Live Explorer", "Prompt": "Map", "Model": "inherit" } }]
            })
            .to_string(),
            json!({
                "step_index": 2,
                "type": "GENERIC",
                "content": format!("Created the following subagent:\n{}", json!({ "conversationId": child_cid, "logAbsoluteUri": child_uri }))
            })
            .to_string(),
        ]
        .join("\n"),
    )
    .unwrap();
    let mut thread2 = blank_thread(&tid2, None, "Placeholder Live Test", "antigravity", None);
    thread2["status"] = json!("running");
    thread2["items"] = json!([{
        "id": "t_run_ph_1",
        "kind": "tool",
        "toolKind": "subagent",
        "toolName": "invoke_subagent",
        "title": "Subagent · Subagent",
        "status": "completed",
        "streaming": false,
        "createdAtUnixMs": 1_700_000_000_000i64,
        "subagentMeta": {
            "subagentId": "t_run_ph_1",
            "role": "Subagent",
            "status": "completed",
            "stepCount": 0
        }
    }]);
    thread2["subagentRuns"] = json!([{
        "subagentId": "t_run_ph_1",
        "parentThreadId": tid2,
        "parentToolCallId": "t_run_ph_1",
        "role": "Subagent",
        "status": "completed",
        "stepCount": 0,
        "items": [],
        "startedAtUnixMs": 1_700_000_000_000i64,
        "updatedAtUnixMs": 1_700_000_002_000i64,
        "completedAtUnixMs": 1_700_000_002_000i64
    }]);
    hydrate_antigravity_subagents_with_logs_dir(&mut thread2, Some(&parent_logs));
    assert_eq!(thread2["subagentRuns"][0]["subagentId"], json!(child_cid));
    assert_eq!(thread2["subagentRuns"][0]["status"], json!("running"));
    assert!(thread2["subagentRuns"][0].get("completedAtUnixMs").is_none_or(Value::is_null));
    assert_eq!(thread2["items"][0]["status"], json!("running"));
    assert_eq!(thread2["items"][0]["subagentMeta"]["status"], json!("running"));

    // 3. Unbound 0-step "completed" placeholder receives live record_subagent_tool_call adoption -> both run & item become "running".
    let tid3 = format!("thread-live-rec-ph-{}", uuid::Uuid::new_v4().simple());
    let _cleanup3 = CleanupThread(tid3.clone());
    let mut thread3 = blank_thread(&tid3, None, "Record Placeholder Adoption", "antigravity", None);
    thread3["status"] = json!("running");
    thread3["items"] = json!([{
        "id": "t_rec_ph_1",
        "kind": "tool",
        "toolKind": "subagent",
        "toolName": "invoke_subagent",
        "title": "Subagent · Subagent",
        "status": "completed",
        "streaming": false,
        "subagentMeta": {
            "subagentId": "t_rec_ph_1",
            "role": "Subagent",
            "status": "completed",
            "stepCount": 0
        }
    }]);
    thread3["subagentRuns"] = json!([{
        "subagentId": "t_rec_ph_1",
        "parentThreadId": tid3,
        "parentToolCallId": "t_rec_ph_1",
        "role": "Subagent",
        "status": "completed",
        "stepCount": 0,
        "items": [],
        "startedAtUnixMs": 1_700_000_000_000i64,
        "updatedAtUnixMs": 1_700_000_002_000i64,
        "completedAtUnixMs": 1_700_000_002_000i64
    }]);
    threads().lock().unwrap().push(thread3);

    let live_bind_item = acp_tool_to_chat_item(&build_acp_tool_call(
        "t_rec_ph_1".into(),
        "invoke_subagent",
        json!({ "Role": "Live Binder", "TypeName": "research", "Prompt": "Map", "Model": "inherit" }),
        "completed".into(),
        Some(format!(
            "Created the following subagent:\n{}",
            json!({ "conversationId": child_cid, "logAbsoluteUri": child_uri })
        )),
        None, None, None, None, None, None, None,
    ));
    record_subagent_tool_call(&tid3, &live_bind_item);
    let snap3 = threads().lock().unwrap().iter().find(|t| t["id"] == tid3).cloned().unwrap();
    assert_eq!(snap3["subagentRuns"][0]["subagentId"], json!(child_cid));
    assert_eq!(snap3["subagentRuns"][0]["status"], json!("running"));
    assert!(snap3["subagentRuns"][0].get("completedAtUnixMs").is_none_or(Value::is_null));
    assert_eq!(snap3["items"][0]["status"], json!("running"));
    assert_eq!(snap3["items"][0]["subagentMeta"]["status"], json!("running"));

    // 4. Settled "idle" parent without active turn must NOT convert completed invoke_subagent receipt to "running".
    let tid4 = format!("thread-settled-parent-{}", uuid::Uuid::new_v4().simple());
    let _cleanup4 = CleanupThread(tid4.clone());
    let mut thread4 = blank_thread(&tid4, None, "Settled Parent", "antigravity", None);
    thread4["status"] = json!("idle");
    let settled_item = acp_tool_to_chat_item(&build_acp_tool_call(
        "t_settled_1".into(),
        "invoke_subagent",
        json!({ "Role": "Done Worker", "TypeName": "research", "Prompt": "Inspect" }),
        "completed".into(),
        Some(format!(
            "Created the following subagent:\n{}",
            json!({ "conversationId": child_cid, "logAbsoluteUri": child_uri })
        )),
        None, None, None, None, None, None, None,
    ));
    upsert_item(&mut thread4, &settled_item);
    threads().lock().unwrap().push(thread4);
    record_subagent_tool_call(&tid4, &settled_item);
    let snap4 = threads().lock().unwrap().iter().find(|t| t["id"] == tid4).cloned().unwrap();
    assert_eq!(
        snap4["subagentRuns"][0]["status"],
        json!("completed"),
        "settled idle parent must not force completed invoke_subagent receipt back to running"
    );

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn load_thread_persists_null_session_completed_subagent_and_cancel_updates_all_matching_items() {
    let root = std::env::temp_dir().join(format!(
        "kite-load-heal-{}",
        uuid::Uuid::new_v4().simple()
    ));
    let done_cid = format!("cid-done-{}", uuid::Uuid::new_v4().simple());
    let done_logs = root.join(&done_cid).join(".system_generated").join("logs");
    std::fs::create_dir_all(&done_logs).unwrap();
    let done_file = done_logs.join("transcript.jsonl");
    std::fs::write(
        &done_file,
        format!(
            "{}\n",
            json!({
                "step_index": 12,
                "type": "PLANNER_RESPONSE",
                "status": "DONE",
                "tool_calls": [],
                "content": "Completed all checks."
            })
        ),
    )
    .unwrap();
    let done_uri = format!("file:///{}", done_file.to_string_lossy().replace('\\', "/"));

    // 1. Idle thread with providerSessionId = null and completed transcript still marked "running"
    let tid = format!("thread-null-sess-{}", uuid::Uuid::new_v4().simple());
    let _cleanup = CleanupThread(tid.clone());
    let mut thread = blank_thread(&tid, None, "Null Session Idle", "antigravity", None);
    thread["status"] = json!("idle");
    thread["providerSessionId"] = Value::Null;
    thread["updatedAtUnixMs"] = json!(crate::chat::utils::now_ms() - 60_000);
    thread["items"] = json!([{
        "id": "t_prev_1",
        "kind": "tool",
        "toolKind": "subagent",
        "toolName": "invoke_subagent",
        "title": "Subagent · Verifier",
        "status": "failed",
        "streaming": true,
        "text": "Interrupted before completion; retried in subsequent steps.",
        "subagentMeta": {
            "subagentId": done_cid,
            "role": "Verifier",
            "status": "running",
            "transcriptUri": done_uri,
            "stepCount": 1
        }
    }]);
    thread["subagentRuns"] = json!([{
        "subagentId": done_cid,
        "parentThreadId": tid,
        "parentToolCallId": "t_prev_1",
        "role": "Verifier",
        "status": "running",
        "transcriptUri": done_uri,
        "stepCount": 1,
        "items": [{ "id": "x", "kind": "reasoning", "text": "step" }],
        "startedAtUnixMs": 1_700_000_000_000i64,
        "updatedAtUnixMs": 1_700_000_001_000i64
    }]);
    threads().lock().unwrap().push(thread);

    assert!(
        needs_antigravity_transcript_reconcile(
            threads().lock().unwrap().iter().find(|t| t["id"] == tid).unwrap()
        ),
        "needs_antigravity_transcript_reconcile must not short-circuit when providerSessionId is null"
    );

    let loaded = crate::chat::threads::load_thread(&tid, None, "Null Session Idle");
    assert_eq!(loaded["subagentRuns"][0]["status"], json!("completed"));
    assert_eq!(loaded["items"][0]["status"], json!("completed"));
    assert_eq!(loaded["items"][0]["streaming"], json!(false));
    assert_eq!(loaded["items"][0]["subagentMeta"]["status"], json!("completed"));

    // Must ALSO be persisted into threads() so list_all_subagent_runs_snapshot sees the healed status!
    let in_memory = threads()
        .lock()
        .unwrap()
        .iter()
        .find(|t| t["id"] == tid)
        .cloned()
        .unwrap();
    assert_eq!(
        in_memory["subagentRuns"][0]["status"],
        json!("completed"),
        "load_thread must persist reconciled subagent repair back into threads()"
    );

    // 2. cancel_subagent_thread must settle ALL items matching subagentId even when parentToolCallId shifted to a later item.
    let tid_kill = format!("thread-kill-all-{}", uuid::Uuid::new_v4().simple());
    let _cleanup_kill = CleanupThread(tid_kill.clone());
    let mut kthread = blank_thread(&tid_kill, None, "Kill Split Items", "antigravity", None);
    kthread["status"] = json!("idle");
    kthread["items"] = json!([
        {
            "id": "t_267",
            "kind": "tool",
            "toolKind": "subagent",
            "toolName": "invoke_subagent",
            "title": "Subagent · Verifier",
            "status": "failed",
            "streaming": true,
            "subagentMeta": {
                "subagentId": "sub-split-1",
                "role": "Verifier",
                "status": "running"
            }
        },
        {
            "id": "t_463",
            "kind": "tool",
            "toolKind": "subagent",
            "toolName": "send_message",
            "title": "Subagent · Subagent",
            "status": "running",
            "streaming": true,
            "subagentMeta": {
                "subagentId": "sub-split-1",
                "role": "Subagent",
                "status": "running"
            }
        }
    ]);
    kthread["subagentRuns"] = json!([{
        "subagentId": "sub-split-1",
        "parentThreadId": tid_kill,
        "parentToolCallId": "t_463",
        "role": "Verifier",
        "status": "running",
        "startedAtUnixMs": 1_700_000_000_000i64,
        "updatedAtUnixMs": 1_700_000_001_000i64
    }]);
    threads().lock().unwrap().push(kthread);

    cancel_subagent_thread(&tid_kill, "sub-split-1").expect("cancel ok");
    let after_kill = threads()
        .lock()
        .unwrap()
        .iter()
        .find(|t| t["id"] == tid_kill)
        .cloned()
        .unwrap();
    for item_id in ["t_267", "t_463"] {
        let it = after_kill["items"].as_array().unwrap().iter().find(|i| i["id"] == item_id).unwrap();
        assert_eq!(it["streaming"], json!(false), "{item_id} streaming must be false");
        assert_eq!(
            it["subagentMeta"]["status"],
            json!("killed"),
            "{item_id} subagentMeta.status must be killed"
        );
    }

    // 3. list_all_subagent_runs_snapshot must reconcile stale running runs whose childThreadId is already idle/error.
    let child_idle_tid = format!("child-idle-{}", uuid::Uuid::new_v4().simple());
    let _c_child = CleanupThread(child_idle_tid.clone());
    let mut cthread = blank_thread(&child_idle_tid, None, "Child Idle", "antigravity", None);
    cthread["status"] = json!("idle");
    let parent_snap_tid = format!("parent-snap-{}", uuid::Uuid::new_v4().simple());
    let _c_parent = CleanupThread(parent_snap_tid.clone());
    let mut pthread = blank_thread(&parent_snap_tid, None, "Parent Snap", "antigravity", None);
    pthread["subagentRuns"] = json!([{
        "subagentId": child_idle_tid,
        "parentThreadId": parent_snap_tid,
        "parentToolCallId": "call-child",
        "childThreadId": child_idle_tid,
        "role": "Worker",
        "status": "running",
        "startedAtUnixMs": 1_700_000_000_000i64,
        "updatedAtUnixMs": 1_700_000_001_000i64
    }]);
    {
        let mut guard = threads().lock().unwrap();
        guard.push(cthread);
        guard.push(pthread);
    }
    let snap = list_all_subagent_runs_snapshot(None, 500);
    let found = snap["runs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["threadId"] == parent_snap_tid)
        .expect("parent entry");
    assert_eq!(
        found["run"]["status"],
        json!("completed"),
        "list_all_subagent_runs_snapshot must settle stale running run whose child thread is idle"
    );

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn heavy_parent_spawns_lightweight_subagent_without_inheriting_xhigh_effort() {
    let parent_id = format!("heavy-parent-{}", uuid::Uuid::new_v4().simple());
    let _cleanup_p = CleanupThread(parent_id.clone());

    let prev_last_model = crate::persist::last_model().lock().unwrap().clone();
    let prev_last_effort = crate::persist::last_effort().lock().unwrap().clone();
    *crate::persist::last_model().lock().unwrap() = Some("gemini-4-argon".to_string());
    *crate::persist::last_effort().lock().unwrap() = Some("xhigh".to_string());

    let mut parent = blank_thread(&parent_id, None, "Heavy Parent", "antigravity", None);
    parent["model"] = json!("gemini-4-argon");
    set_thread_effort_option(&mut parent, "xhigh");

    // Pre-insert an unbound MCP `mcp_kite-dispatch_kite_subagent_run` tool call with workspace: "worktree"
    let mcp_call = acp_tool_to_chat_item(&build_acp_tool_call(
        "call_mcp_sub_1".to_string(),
        "mcp_kite-dispatch_kite_subagent_run",
        json!({
            "role": "Fast Executor",
            "workspace": "worktree",
            "task": "Audit lightweight routing"
        }),
        "running".to_string(),
        None, None, None, None, None, None, None, None,
    ));
    assert_eq!(mcp_call["toolKind"], "subagent");
    assert_eq!(mcp_call["subagentMeta"]["workspaceMode"], "share");
    upsert_item(&mut parent, &mcp_call);
    threads().lock().unwrap().push(parent);
    record_subagent_tool_call(&parent_id, &mcp_call);

    let spawned = spawn_child_subagent_thread(ChildSubagentSpawnParams {
        parent_thread_id: Some(parent_id.clone()),
        provider: None,
        model: None,
        effort: None,
        role: Some("Fast Executor".to_string()),
        agent_id: None,
        mode: None,
        workspace_mode: "inherit".to_string(),
        task: "Audit lightweight routing".to_string(),
        fallback_cwd: None,
    });

    *crate::persist::last_model().lock().unwrap() = prev_last_model;
    *crate::persist::last_effort().lock().unwrap() = prev_last_effort;

    let res = spawned.expect("spawn child subagent thread");
    let _cleanup_c = CleanupThread(res.child_thread_id.clone());

    assert_eq!(res.provider, "antigravity");
    assert_eq!(
        res.model.as_deref(),
        Some("gemini-4-hydrogen"),
        "heavy parent (gemini-4-argon) must route child subagent to default gemini-4-hydrogen when --model is omitted"
    );

    let guard = threads().lock().unwrap();
    let child = guard
        .iter()
        .find(|t| t["id"] == res.child_thread_id)
        .expect("child thread");
    assert_eq!(child["model"], "gemini-4-hydrogen");
    assert!(
        child["effort"].is_null(),
        "child subagent must not inherit parent last_effort=xhigh when --effort is omitted: {:?}",
        child["effort"]
    );
    assert!(
        child["providerOptions"]
            .as_array()
            .is_none_or(|opts| opts.is_empty()),
        "child subagent providerOptions must not contain inherited effort: {:?}",
        child["providerOptions"]
    );

    let parent_after = guard
        .iter()
        .find(|t| t["id"] == parent_id)
        .expect("parent thread");
    let runs = parent_after["subagentRuns"].as_array().expect("subagentRuns");
    assert_eq!(
        runs.len(),
        1,
        "MCP kite_subagent_run tool call and spawned child thread must deduplicate into one SubagentRun: {runs:?}"
    );
    assert_eq!(runs[0]["childThreadId"], res.child_thread_id);
    assert_eq!(runs[0]["model"], "gemini-4-hydrogen");
}

#[test]
fn mcp_wait_read_send_never_pollute_subagent_runs_or_hijack_parent_call_and_async_start_stays_running() {
    let parent_id = format!("mcp-ctrl-parent-{}", uuid::Uuid::new_v4().simple());
    let child_id = format!("mcp-ctrl-child-{}", uuid::Uuid::new_v4().simple());
    let _cleanup_p = CleanupThread(parent_id.clone());
    let _cleanup_c = CleanupThread(child_id.clone());

    let mut parent = blank_thread(&parent_id, None, "Parent", "antigravity", None);
    parent["status"] = json!("running");
    let mut child = blank_thread(&child_id, None, "Child", "antigravity", None);
    child["parentThreadId"] = json!(parent_id);
    child["status"] = json!("running");

    let spawn_item = acp_tool_to_chat_item(&build_acp_tool_call(
        "call_spawn_1".to_string(),
        "call_mcp_tool",
        json!({
            "ServerName": "kite-dispatch",
            "ToolName": "kite_subagent_run",
            "Arguments": {
                "role": "Fast Executor",
                "workspace": "worktree",
                "wait": false,
                "task": "Inspect auth"
            }
        }),
        "completed".to_string(),
        Some(format!("started thread:{child_id}")),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    ));
    assert_eq!(spawn_item["toolKind"], "subagent");
    upsert_item(&mut parent, &spawn_item);

    {
        let mut guard = threads().lock().unwrap();
        guard.push(parent);
        guard.push(child);
    }

    record_subagent_tool_call(&parent_id, &spawn_item);

    {
        let guard = threads().lock().unwrap();
        let stored = guard.iter().find(|t| t["id"] == parent_id).unwrap();
        let runs = stored["subagentRuns"].as_array().unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0]["status"], "running", "wait:false spawn while child is running must stay running");
        assert_eq!(runs[0]["parentToolCallId"], "call_spawn_1");
        assert!(
            runs[0].get("completedAtUnixMs").is_none_or(Value::is_null),
            "running async spawn must not have completedAtUnixMs: {:?}",
            runs[0]
        );
        let stored_spawn = stored["items"].as_array().unwrap().iter().find(|i| i["id"] == "call_spawn_1").unwrap();
        assert_eq!(stored_spawn["status"], "running");
        assert_eq!(stored_spawn["subagentMeta"]["status"], "running");
    }

    // Now simulate wait / read / send calls (including legacy-shaped ones that carry subagentMeta)
    let wait_acp = acp_tool_to_chat_item(&build_acp_tool_call(
        "call_wait_1".to_string(),
        "call_mcp_tool",
        json!({
            "ServerName": "kite-dispatch",
            "ToolName": "kite_subagent_wait",
            "Arguments": { "children": "all" }
        }),
        "completed".to_string(),
        Some("active".to_string()),
        None, None, None, None, None, None, None,
    ));
    assert_eq!(wait_acp["toolKind"], "mcpToolCall");
    assert!(wait_acp.get("subagentMeta").is_none());

    let forged_read = json!({
        "id": "call_read_1",
        "kind": "tool",
        "toolKind": "subagent",
        "toolName": "call_mcp_tool",
        "serverName": "kite-dispatch",
        "title": "Subagent · Subagent",
        "detail": "{\"ServerName\":\"kite-dispatch\",\"ToolName\":\"kite_subagent_read\",\"Arguments\":{\"target\":\"thread:x\"}}",
        "status": "completed",
        "subagentMeta": {
            "subagentId": child_id,
            "childThreadId": child_id,
            "role": "Subagent",
            "status": "completed"
        }
    });
    let forged_send = json!({
        "id": "call_send_1",
        "kind": "tool",
        "toolKind": "subagent",
        "toolName": "mcp_kite-dispatch_kite_subagent_send",
        "title": "Subagent · Subagent",
        "detail": "",
        "status": "completed",
        "subagentMeta": {
            "subagentId": child_id,
            "childThreadId": child_id,
            "role": "Subagent",
            "status": "completed"
        }
    });

    {
        let mut guard = threads().lock().unwrap();
        let stored = guard.iter_mut().find(|t| t["id"] == parent_id).unwrap();
        upsert_item(stored, &wait_acp);
        upsert_item(stored, &forged_read);
        upsert_item(stored, &forged_send);
    }

    record_subagent_tool_call(&parent_id, &wait_acp);
    record_subagent_tool_call(&parent_id, &forged_read);
    record_subagent_tool_call(&parent_id, &forged_send);

    let guard = threads().lock().unwrap();
    let stored = guard.iter().find(|t| t["id"] == parent_id).unwrap();
    let runs = stored["subagentRuns"].as_array().unwrap();
    assert_eq!(runs.len(), 1, "wait/read/send must never create phantom runs: {runs:?}");
    assert_eq!(
        runs[0]["parentToolCallId"], "call_spawn_1",
        "read/send must never hijack parentToolCallId: {runs:?}"
    );
    assert_eq!(runs[0]["status"], "running");
    assert!(
        runs[0].get("completedAtUnixMs").is_none_or(Value::is_null),
        "read/send must never stamp completedAtUnixMs: {runs:?}"
    );

    let items = stored["items"].as_array().unwrap();
    let read_it = items.iter().find(|i| i["id"] == "call_read_1").unwrap();
    assert_eq!(read_it["toolKind"], "mcpToolCall");
    assert_eq!(read_it["title"], "kite-dispatch · kite_subagent_read");
    assert!(read_it.get("subagentMeta").is_none());

    let send_it = items.iter().find(|i| i["id"] == "call_send_1").unwrap();
    assert_eq!(send_it["toolKind"], "mcpToolCall");
    assert_eq!(send_it["title"], "kite-dispatch · kite_subagent_send");
    assert!(send_it.get("subagentMeta").is_none());
}

#[test]
fn sync_child_thread_to_parent_clears_stale_completed_timestamp_on_resumed_running_child() {
    let parent_id = format!("resume-parent-{}", uuid::Uuid::new_v4().simple());
    let child_id = format!("resume-child-{}", uuid::Uuid::new_v4().simple());
    let _cleanup_p = CleanupThread(parent_id.clone());
    let _cleanup_c = CleanupThread(child_id.clone());

    let mut parent = blank_thread(&parent_id, None, "Parent", "antigravity", None);
    parent["items"] = json!([
        {
            "id": "call_spawn_1",
            "kind": "tool",
            "toolKind": "subagent",
            "toolName": "mcp_kite-dispatch_kite_subagent_run",
            "title": "Subagent · Worker",
            "status": "completed",
            "streaming": false,
            "subagentMeta": {
                "subagentId": child_id,
                "childThreadId": child_id,
                "role": "Worker",
                "workspaceMode": "share",
                "status": "completed"
            }
        },
        {
            "id": "call_read_1",
            "kind": "tool",
            "toolKind": "mcpToolCall",
            "toolName": "mcp_kite-dispatch_kite_subagent_read",
            "title": "kite-dispatch · kite_subagent_read",
            "status": "completed",
            "streaming": false
        },
        {
            "id": "call_wait_legacy",
            "kind": "tool",
            "toolKind": "subagent",
            "toolName": "call_mcp_tool",
            "serverName": "kite-dispatch",
            "title": "Subagent · Subagent",
            "detail": "{\"ServerName\":\"kite-dispatch\",\"ToolName\":\"kite_subagent_wait\"}",
            "status": "completed",
            "streaming": false,
            "subagentMeta": {
                "subagentId": child_id,
                "childThreadId": child_id,
                "role": "Subagent",
                "status": "completed"
            }
        }
    ]);
    parent["subagentRuns"] = json!([{
        "subagentId": child_id,
        "parentThreadId": parent_id,
        "parentToolCallId": "call_spawn_1",
        "childThreadId": child_id,
        "role": "Worker",
        "status": "completed",
        "stepCount": 1,
        "items": [],
        "startedAtUnixMs": 100,
        "updatedAtUnixMs": 200,
        "completedAtUnixMs": 200
    }]);

    let mut child = blank_thread(&child_id, None, "Child", "antigravity", None);
    child["parentThreadId"] = json!(parent_id);
    child["status"] = json!("running");
    child["items"] = json!([{ "id": "u1", "kind": "user", "text": "Resume work" }]);

    {
        let mut guard = threads().lock().unwrap();
        guard.push(parent);
        guard.push(child);
    }

    sync_child_thread_to_parent(&child_id);

    let guard = threads().lock().unwrap();
    let updated = guard.iter().find(|t| t["id"] == parent_id).unwrap();
    let run = &updated["subagentRuns"][0];
    assert_eq!(run["status"], "running");
    assert!(
        run.get("completedAtUnixMs").is_none(),
        "stale completedAtUnixMs must be removed when child is running: {run:?}"
    );
    let items = updated["items"].as_array().unwrap();
    let spawn_it = items.iter().find(|i| i["id"] == "call_spawn_1").unwrap();
    assert_eq!(spawn_it["status"], "running");
    assert_eq!(spawn_it["streaming"], true);

    let read_it = items.iter().find(|i| i["id"] == "call_read_1").unwrap();
    assert_eq!(read_it["status"], "completed", "prior read item must not be re-animated");

    let wait_it = items.iter().find(|i| i["id"] == "call_wait_legacy").unwrap();
    assert_eq!(wait_it["status"], "completed", "legacy wait item must not be re-animated");
    assert_eq!(wait_it["toolKind"], "mcpToolCall");
    assert!(wait_it.get("subagentMeta").is_none());
}

#[test]
fn reconcile_duplicate_subagent_state_heals_legacy_kite_dispatch_read_send_cards_and_phantom_wait_runs() {
    let tid = format!("legacy-heal-{}", uuid::Uuid::new_v4().simple());
    let child_id = format!("legacy-child-{}", uuid::Uuid::new_v4().simple());
    let _cleanup = CleanupThread(tid.clone());

    let mut thread = blank_thread(&tid, None, "Legacy Parent", "antigravity", None);
    thread["items"] = json!([
        {
            "id": "call_spawn_1",
            "kind": "tool",
            "toolKind": "subagent",
            "toolName": "call_mcp_tool",
            "serverName": "kite-dispatch",
            "title": "Subagent · Fast Executor",
            "detail": "{\"ServerName\":\"kite-dispatch\",\"ToolName\":\"kite_subagent_run\",\"Arguments\":{\"role\":\"Fast Executor\",\"workspace\":\"share\"}}",
            "status": "completed",
            "subagentMeta": {
                "subagentId": child_id,
                "childThreadId": child_id,
                "role": "Fast Executor",
                "workspaceMode": "share",
                "status": "completed",
                "stepCount": 3
            }
        },
        {
            "id": "call_wait_1",
            "kind": "tool",
            "toolKind": "subagent",
            "toolName": "call_mcp_tool",
            "serverName": "kite-dispatch",
            "title": "Subagent · Subagent",
            "detail": "{\"ServerName\":\"kite-dispatch\",\"ToolName\":\"kite_subagent_wait\",\"Arguments\":{\"children\":\"all\"}}",
            "status": "completed",
            "subagentMeta": {
                "subagentId": "call_wait_1",
                "role": "Subagent",
                "status": "completed",
                "stepCount": 0
            }
        },
        {
            "id": "call_wait_legacy_no_detail",
            "kind": "tool",
            "toolKind": "subagent",
            "toolName": "call_mcp_tool",
            "serverName": "kite-dispatch",
            "title": "Subagent · Subagent",
            "detail": "",
            "status": "completed",
            "subagentMeta": {
                "subagentId": "call_wait_legacy_no_detail",
                "role": "Subagent",
                "status": "completed",
                "stepCount": 0
            }
        },
        {
            "id": "call_read_1",
            "kind": "tool",
            "toolKind": "subagent",
            "toolName": "call_mcp_tool",
            "serverName": "kite-dispatch",
            "title": "Subagent · Subagent",
            "detail": "{\"ServerName\":\"kite-dispatch\",\"ToolName\":\"kite_subagent_read\",\"Arguments\":{\"target\":\"thread:child\"}}",
            "status": "completed",
            "subagentMeta": {
                "subagentId": child_id,
                "childThreadId": child_id,
                "role": "Subagent",
                "status": "completed",
                "stepCount": 0
            }
        },
        {
            "id": "call_send_legacy",
            "kind": "tool",
            "toolKind": "subagent",
            "toolName": "call_mcp_tool",
            "serverName": "kite-dispatch",
            "title": "Subagent · Subagent",
            "detail": "",
            "status": "completed",
            "subagentMeta": {
                "subagentId": child_id,
                "childThreadId": child_id,
                "role": "Subagent",
                "prompt": "Follow-up task",
                "status": "completed",
                "stepCount": 0
            }
        }
    ]);
    thread["subagentRuns"] = json!([
        {
            "subagentId": "call_wait_1",
            "parentThreadId": tid,
            "parentToolCallId": "call_wait_1",
            "role": "Subagent",
            "status": "completed",
            "stepCount": 0,
            "items": [],
            "startedAtUnixMs": 100,
            "updatedAtUnixMs": 110
        },
        {
            "subagentId": "call_wait_legacy_no_detail",
            "parentThreadId": tid,
            "parentToolCallId": "call_wait_legacy_no_detail",
            "role": "Subagent",
            "status": "completed",
            "stepCount": 0,
            "items": [],
            "startedAtUnixMs": 120,
            "updatedAtUnixMs": 130
        },
        {
            "subagentId": child_id,
            "parentThreadId": tid,
            "parentToolCallId": "call_send_legacy",
            "childThreadId": child_id,
            "role": "Fast Executor",
            "workspaceMode": "share",
            "status": "completed",
            "stepCount": 3,
            "items": [{ "id": "s1", "kind": "assistant", "text": "Done" }],
            "startedAtUnixMs": 100,
            "updatedAtUnixMs": 200,
            "completedAtUnixMs": 200
        }
    ]);

    assert!(needs_antigravity_transcript_reconcile(&thread));
    reconcile_duplicate_subagent_state(&mut thread);
    assert!(
        !needs_antigravity_transcript_reconcile(&thread),
        "after healing, needs_antigravity_transcript_reconcile must be false"
    );

    let runs = thread["subagentRuns"].as_array().unwrap();
    assert_eq!(runs.len(), 1, "phantom wait runs must be pruned: {runs:?}");
    assert_eq!(runs[0]["subagentId"], child_id);
    assert_eq!(
        runs[0]["parentToolCallId"], "call_spawn_1",
        "real run must be re-anchored onto original spawn item: {runs:?}"
    );

    let items = thread["items"].as_array().unwrap();
    let spawn = items.iter().find(|i| i["id"] == "call_spawn_1").unwrap();
    assert_eq!(spawn["toolKind"], "subagent");
    assert!(spawn.get("subagentMeta").is_some());

    for (id, expected_title) in [
        ("call_wait_1", "kite-dispatch · kite_subagent_wait"),
        ("call_wait_legacy_no_detail", "kite-dispatch · kite_subagent_wait"),
        ("call_read_1", "kite-dispatch · kite_subagent_read"),
        ("call_send_legacy", "kite-dispatch · kite_subagent_send"),
    ] {
        let it = items.iter().find(|i| i["id"] == id).unwrap();
        assert_eq!(it["toolKind"], "mcpToolCall", "{id} must be downgraded to mcpToolCall");
        assert_eq!(it["title"], expected_title, "{id} title mismatch");
        assert!(it.get("subagentMeta").is_none(), "{id} subagentMeta must be stripped");
    }
}

#[test]
fn spawn_child_subagent_thread_persists_profile_id_and_mode_and_compiles_charter() {
    let agent_id = format!("agent-sub-{}", uuid::Uuid::new_v4().simple());
    {
        let mut list = crate::persist::agents().lock().unwrap();
        list.push(crate::persist::AgentProfile {
            id: agent_id.clone(),
            name: "Chartered Specialist".to_string(),
            engine: "codex".to_string(),
            purpose: "Verify charter inheritance".to_string(),
            brief: "Always check invariants before editing.".to_string(),
            avatar: None,
            created_at_unix_ms: 1_700_000_000_000,
            pinned: false,
            order: 0,
            memory_budget: Some(4000),
            reflection_mode: Some("ask".to_string()),
            allow_agent_scheduling: Some(true),
            allow_agent_messaging: Some(true),
            default_mode: Some("readOnly".to_string()),
            default_plan: Some(false),
            default_model: Some("gpt-5.3-codex".to_string()),
            default_provider_options: vec![json!({ "id": "effort", "value": "high" })],
            place_display_names: Vec::new(),
            disabled_plugin_ids: Vec::new(),
        });
    }

    let spawned = spawn_child_subagent_thread(ChildSubagentSpawnParams {
        parent_thread_id: None,
        provider: Some("codex".into()),
        model: Some("gpt-5.3-codex".into()),
        effort: Some("high".into()),
        role: Some("Chartered Specialist".into()),
        agent_id: Some(agent_id.clone()),
        mode: Some("readOnly".into()),
        workspace_mode: "inherit".into(),
        fallback_cwd: None,
        task: "Inspect invariants".into(),
    })
    .expect("spawn child with agent_id");
    let _cleanup = CleanupThread(spawned.child_thread_id.clone());

    let child = {
        let all = threads().lock().unwrap();
        all.iter()
            .find(|t| t["id"] == spawned.child_thread_id)
            .unwrap()
            .clone()
    };
    assert_eq!(child["profileId"].as_str(), Some(agent_id.as_str()));
    assert_eq!(child["mode"].as_str(), Some("readOnly"));
    assert_eq!(child["model"].as_str(), Some("gpt-5.3-codex"));
    assert_eq!(child["effort"].as_str(), Some("high"));

    let snapshot = crate::chat::recipe::snapshot_for_agent(&agent_id)
        .expect("snapshot_for_agent must load bound AgentProfile");
    assert!(snapshot.role.contains("Always check invariants"));

    crate::persist::agents().lock().unwrap().retain(|a| a.id != agent_id);
}

#[test]
fn unspawned_failed_native_invoke_never_creates_subagent_run_and_retires_when_delegation_succeeds() {
    use crate::acp::{parse_acp_stream_line, AcpStreamEvent};
    use crate::chat::runtime::state::{live_turns, TurnRun};
    use crate::chat::runtime::record_acp_tool_update;

    // 1. Live turn: native invoke_subagent starts RUNNING then fails via PreToolUse without spawning
    let tid = format!("live-blocked-invoke-{}", uuid::Uuid::new_v4().simple());
    let _cleanup = CleanupThread(tid.clone());
    let run_id = format!("run-blocked-{}", uuid::Uuid::new_v4().simple());
    let mut parent = blank_thread(&tid, None, "Blocked Native Invoke", "antigravity", None);
    parent["model"] = json!("gemini-4-neon");
    parent["status"] = json!("running");
    threads().lock().unwrap().push(parent);
    {
        let mut live = live_turns().lock().unwrap();
        live.by_thread.insert(tid.clone(), run_id.clone());
        live.runs.insert(
            run_id.clone(),
            TurnRun {
                revision: "1".into(),
                events: Vec::new(),
                next_sequence: 0,
                assistant_id: "asst_blocked".into(),
                assistant_text: String::new(),
                child: None,
                stdin: None,
                closing: false,
                finished: false,
                started_at_ms: 100,
                finished_at_ms: None,
                routine_id: None,
                delivered_through: 0,
                file_baselines: std::collections::HashMap::new(),
            },
        );
    }

    let running_line = r#"{"event":"step_update","step_update":{"step_index":40,"step_type":"subagent","tool_name":"invoke_subagent","state":"RUNNING","subagent_info":{"subagents":[{"type_name":"research","role":"Chat Keystroke Jump Investigator","initial_prompt":"Trace jump"}]}}}"#;
    let Some(AcpStreamEvent::ToolUpdate { tool: running_tool }) =
        parse_acp_stream_line(&tid, &run_id, running_line)
    else {
        panic!("expected RUNNING ToolUpdate");
    };
    let blocked_call_id = running_tool.id.clone();
    record_acp_tool_update(&tid, &run_id, running_tool);
    {
        let all = threads().lock().unwrap();
        let stored = all.iter().find(|t| t["id"] == tid).unwrap();
        assert_eq!(stored["subagentRuns"].as_array().unwrap().len(), 1);
    }

    let failed_line = r#"{"event":"step_update","step_update":{"step_index":40,"step_type":"subagent","tool_name":"invoke_subagent","state":"ERROR","subagent_info":{"subagents":[{"type_name":"research","role":"Chat Keystroke Jump Investigator","initial_prompt":"Trace jump"}]}}}"#;
    let Some(AcpStreamEvent::ToolUpdate { tool: failed_tool }) =
        parse_acp_stream_line(&tid, &run_id, failed_line)
    else {
        panic!("expected ERROR ToolUpdate");
    };
    record_acp_tool_update(&tid, &run_id, failed_tool);
    {
        let all = threads().lock().unwrap();
        let stored = all.iter().find(|t| t["id"] == tid).unwrap();
        assert_eq!(
            stored["subagentRuns"].as_array().unwrap().len(),
            0,
            "unspawned failed native invoke must not leave a SubagentRun in RightDock: {:?}",
            stored["subagentRuns"]
        );
        let item = stored["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|it| it["id"] == blocked_call_id)
            .expect("downgraded item present while retrying");
        assert_ne!(
            item["toolKind"], "subagent",
            "unspawned failed native invoke must downgrade out of SubagentActivityCard: {item:?}"
        );
        assert!(
            item.get("subagentMeta").is_none(),
            "downgraded item must drop subagentMeta: {item:?}"
        );
    }

    // Model retries via kite_subagent_run with a real childThreadId
    let child_id = format!("child-mcp-{}", uuid::Uuid::new_v4().simple());
    let _child_cleanup = CleanupThread(child_id.clone());
    let mut child = blank_thread(&child_id, None, "Child", "antigravity", None);
    child["parentThreadId"] = json!(tid);
    child["model"] = json!("gemini-4-hydrogen");
    child["startedByAgent"] = json!(true);
    child["subagentRole"] = json!("Chat Keystroke Jump Investigator");
    child["status"] = json!("idle");
    child["items"] = json!([
        { "id": "c-1", "kind": "reasoning", "text": "Inspecting composer" },
        { "id": "c-2", "kind": "assistant", "text": "Root cause found.", "streaming": false }
    ]);
    threads().lock().unwrap().push(child);

    let mcp_tool = build_acp_tool_call(
        format!("t_{run_id}_45"),
        "call_mcp_tool",
        json!({
            "ServerName": "kite-dispatch_kite-dispatch",
            "ToolName": "kite_subagent_run",
            "Arguments": { "role": "Chat Keystroke Jump Investigator", "task": "Trace jump" }
        }),
        "completed".to_string(),
        Some(json!({ "status": "completed", "target": format!("thread:{child_id}") }).to_string()),
        Some(12.0),
        Some("kite-dispatch".to_string()),
        None,
        None,
        None,
        None,
        None,
    );
    record_acp_tool_update(&tid, &run_id, mcp_tool);

    {
        let all = threads().lock().unwrap();
        let stored = all.iter().find(|t| t["id"] == tid).unwrap();
        let runs = stored["subagentRuns"].as_array().unwrap();
        assert_eq!(runs.len(), 1, "only real kite_subagent_run may remain: {runs:?}");
        assert_eq!(runs[0]["childThreadId"], child_id);
        let items = stored["items"].as_array().unwrap();
        assert!(
            items.iter().all(|it| it["id"] != blocked_call_id),
            "superseded blocked native invoke must be retired from timeline: {items:?}"
        );
    }
    let saw_remove = {
        let live = live_turns().lock().unwrap();
        live.runs
            .get(&run_id)
            .map(|r| {
                r.events.iter().any(|ev| {
                    ev.get("kind").and_then(Value::as_str) == Some("remove")
                        && ev.get("itemId").and_then(Value::as_str) == Some(blocked_call_id.as_str())
                })
            })
            .unwrap_or(false)
    };
    {
        let mut live = live_turns().lock().unwrap();
        live.by_thread.remove(&tid);
        live.runs.remove(&run_id);
    }
    assert!(saw_remove, "live turn stream must emit remove event when blocked attempt is retired");

    // 2. Persisted legacy thread with null providerSessionId heals on load/reconcile
    let legacy_tid = format!("legacy-blocked-{}", uuid::Uuid::new_v4().simple());
    let _legacy_cleanup = CleanupThread(legacy_tid.clone());
    let mut legacy = blank_thread(&legacy_tid, None, "Legacy Blocked", "antigravity", None);
    legacy["providerSessionId"] = Value::Null;
    legacy["items"] = json!([
        {
            "id": "t_old_40",
            "kind": "tool",
            "toolKind": "subagent",
            "toolName": "invoke_subagent",
            "title": "Subagent · Subagent",
            "status": "failed",
            "streaming": false,
            "detail": "",
            "text": "",
            "createdAtUnixMs": 1_700_000_000_000i64,
            "subagentMeta": {
                "subagentId": "t_old_40",
                "role": "Subagent",
                "model": "gemini-4-neon",
                "status": "failed",
                "stepCount": 0
            }
        },
        {
            "id": "t_old_45",
            "kind": "tool",
            "toolKind": "subagent",
            "toolName": "call_mcp_tool",
            "title": "Subagent · Chat Keystroke Jump Investigator",
            "status": "completed",
            "streaming": false,
            "createdAtUnixMs": 1_700_000_005_000i64,
            "subagentMeta": {
                "subagentId": "real-child-legacy",
                "childThreadId": "real-child-legacy",
                "role": "Chat Keystroke Jump Investigator",
                "model": "gemini-4-hydrogen",
                "status": "completed",
                "stepCount": 20
            }
        }
    ]);
    legacy["subagentRuns"] = json!([
        {
            "subagentId": "t_old_40",
            "parentThreadId": legacy_tid,
            "parentToolCallId": "t_old_40",
            "role": "Subagent",
            "model": "gemini-4-neon",
            "status": "failed",
            "stepCount": 0,
            "items": []
        },
        {
            "subagentId": "real-child-legacy",
            "parentThreadId": legacy_tid,
            "parentToolCallId": "t_old_45",
            "childThreadId": "real-child-legacy",
            "role": "Chat Keystroke Jump Investigator",
            "model": "gemini-4-hydrogen",
            "status": "completed",
            "stepCount": 20,
            "items": []
        }
    ]);
    assert!(
        needs_antigravity_transcript_reconcile(&legacy),
        "legacy thread with blocked 0-step native invoke must trigger reconcile even without providerSessionId"
    );
    let outcome = reconcile_antigravity_subagents_in_thread(&mut legacy, None, false);
    assert!(outcome.changed);
    assert_eq!(legacy["items"].as_array().unwrap().len(), 1);
    assert_eq!(legacy["items"][0]["id"], "t_old_45");
    assert_eq!(legacy["subagentRuns"].as_array().unwrap().len(), 1);
    assert_eq!(legacy["subagentRuns"][0]["subagentId"], "real-child-legacy");

    // 3. Prior-turn delegation must not falsely erase a later standalone blocked invoke that had no retry
    let mut later_unretried = legacy.clone();
    later_unretried["items"].as_array_mut().unwrap().push(json!({
        "id": "t_turn2_blocked",
        "kind": "tool",
        "toolKind": "subagent",
        "toolName": "invoke_subagent",
        "title": "Subagent · Later Verifier",
        "status": "failed",
        "streaming": false,
        "text": "",
        "createdAtUnixMs": 1_700_000_100_000i64,
        "subagentMeta": {
            "subagentId": "t_turn2_blocked",
            "role": "Later Verifier",
            "model": "gemini-4-neon",
            "status": "failed",
            "stepCount": 0
        }
    }));
    later_unretried["subagentRuns"].as_array_mut().unwrap().push(json!({
        "subagentId": "t_turn2_blocked",
        "parentThreadId": legacy_tid,
        "parentToolCallId": "t_turn2_blocked",
        "role": "Later Verifier",
        "status": "failed",
        "stepCount": 0,
        "items": []
    }));
    reconcile_antigravity_subagents_in_thread(&mut later_unretried, None, false);
    assert_eq!(later_unretried["subagentRuns"].as_array().unwrap().len(), 1);
    let kept = later_unretried["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|it| it["id"] == "t_turn2_blocked")
        .expect("unretried later turn blocked invoke remains as plain tool row");
    assert_eq!(kept["toolKind"], "dynamicToolCall");
    assert_eq!(kept["title"], "invoke_subagent · Later Verifier");
}

#[test]
fn parent_transcript_pre_tool_hook_denial_pops_pending_invoke_without_poisoning_next_spawn() {
    let root = std::env::temp_dir().join(format!("kite-agy-deny-{}", uuid::Uuid::new_v4().simple()));
    let logs = root.join("parent").join(".system_generated").join("logs");
    let cid = format!("cid-after-deny-{}", uuid::Uuid::new_v4().simple());
    let child_logs = root.join(&cid).join(".system_generated").join("logs");
    std::fs::create_dir_all(&logs).unwrap();
    std::fs::create_dir_all(&child_logs).unwrap();
    let child_transcript = child_logs.join("transcript.jsonl");
    std::fs::write(
        &child_transcript,
        json!({ "type": "PLANNER_RESPONSE", "created_at": "2026-11-19T22:39:05Z", "content": "Done." }).to_string(),
    )
    .unwrap();

    let lines = [
        json!({
            "type": "PLANNER_RESPONSE",
            "created_at": "2026-11-19T22:37:54Z",
            "tool_calls": [{
                "id": "call_blocked",
                "name": "invoke_subagent",
                "args": { "Role": "Blocked Role", "Prompt": "Blocked Prompt" }
            }]
        })
        .to_string(),
        json!({
            "type": "GENERIC",
            "status": "ERROR",
            "error": "tool call denied by pre-tool hook: Native `invoke_subagent` is blocked because Kite Subagents is configured for `antigravity/gemini-4-hydrogen`.",
            "created_at": "2026-11-19T22:38:17Z",
            "content": "Encountered error in step execution: tool call denied by pre-tool hook: Native `invoke_subagent` is blocked."
        })
        .to_string(),
        json!({
            "type": "PLANNER_RESPONSE",
            "created_at": "2026-11-19T22:38:40Z",
            "tool_calls": [{
                "id": "call_real",
                "name": "invoke_subagent",
                "args": { "Role": "Real Role", "Prompt": "Real Prompt" }
            }]
        })
        .to_string(),
        json!({
            "type": "TOOL_RESPONSE",
            "created_at": "2026-11-19T22:38:41Z",
            "content": json!({
                "conversationId": cid,
                "logAbsoluteUri": child_transcript.to_string_lossy()
            }).to_string()
        })
        .to_string(),
    ]
    .join("\n");
    std::fs::write(logs.join("transcript_full.jsonl"), lines).unwrap();

    let mut thread = blank_thread("agy-deny-queue", None, "Parent", "antigravity", None);
    thread["status"] = json!("idle");
    let outcome = reconcile_antigravity_subagents_in_thread(&mut thread, Some(&logs), true);
    assert!(outcome.changed);
    let runs = thread["subagentRuns"].as_array().unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0]["subagentId"], cid);
    assert_eq!(runs[0]["role"], "Real Role");
    assert_eq!(runs[0]["prompt"], "Real Prompt");

    let _ = std::fs::remove_dir_all(&root);
}
