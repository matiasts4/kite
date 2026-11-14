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

    threads().lock().unwrap().push(valid_grok);
    threads().lock().unwrap().push(poisoned_grok);

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
