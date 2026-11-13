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
