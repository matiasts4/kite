use super::*;
use serde_json::json;

#[test]
fn tool_frames_merge_path_status_and_output_by_id() {
    let mut tracker = ToolCallTracker::default();
    tracker.ingest(&json!({
        "sessionUpdate": "tool_call",
        "toolCallId": "call-1",
        "kind": "read",
        "title": "Read normalize.rs",
        "rawInput": { "path": "src-tauri/src/chat/normalize.rs" }
    }));
    tracker.ingest(&json!({
        "sessionUpdate": "tool_call_update",
        "toolCallId": "call-1",
        "status": "completed",
        "locations": [{ "path": "src-tauri/src/chat/normalize.rs" }],
        "diff": { "additions": 18, "deletions": 4 }
    }));
    tracker.ingest(&json!({
        "sessionUpdate": "tool_call_content_chunk",
        "toolCallId": "call-1",
        "content": "merged\n"
    }));
    let snap = tracker.snapshot("call-1").expect("merged tool");
    assert_eq!(snap.path.as_deref(), Some("src-tauri/src/chat/normalize.rs"));
    assert_eq!(snap.status, "completed");
    assert_eq!(snap.additions, Some(18));
    assert_eq!(snap.deletions, Some(4));
    assert_eq!(snap.output, "merged\n");
    assert_eq!(snap.kind, "read");
}

#[test]
fn deltas_flush_the_first_chunk_and_hold_the_next_until_the_window() {
    let mut coalescer = DeltaCoalescer::new(DELTA_WINDOW);
    let start = Instant::now();
    let first = coalescer.push_message("Hello", false, start);
    assert_eq!(first.as_deref(), Some("Hello"));
    assert!(coalescer.push_message(" there", false, start).is_none());
    assert!(coalescer.poll(start + Duration::from_millis(49)).is_empty());
    let flushed = coalescer.poll(start + DELTA_WINDOW);
    assert_eq!(flushed, vec![" there".to_string()]);
    let closed = coalescer.push_reasoning("done", true, start);
    assert_eq!(closed.as_deref(), Some("done"));
}

#[test]
fn unknown_frames_become_notices() {
    let mut tracker = ToolCallTracker::default();
    let events = tracker.ingest(&json!({ "method": "session/dance", "params": {} }));
    assert!(matches!(
        events.first(),
        Some(ProviderTurnEvent::Notice { code, .. }) if code == "unknownFrame"
    ));
}

#[test]
fn reverse_requests_become_questions_plans_and_approvals() {
    let mut tracker = ToolCallTracker::default();
    let question = tracker.ingest(&json!({
        "method": "x.ai/ask_user_question",
        "id": "q-1",
        "params": {
            "questions": [{
                "id": "color",
                "header": "Color",
                "options": ["red", "blue"],
                "allowCustomAnswer": true,
                "allowAttachments": false
            }]
        }
    }));
    assert!(matches!(
        question.first(),
        Some(ProviderTurnEvent::UserInputRequested { request }) if request.request_id == "q-1"
    ));
    let plan = tracker.ingest(&json!({
        "method": "x.ai/exit_plan_mode",
        "params": { "title": "Ship it", "plan": "do the thing" }
    }));
    assert!(matches!(plan.first(), Some(ProviderTurnEvent::PlanUpdated { .. })));
    let approval = tracker.ingest(&json!({
        "method": "session/request_permission",
        "id": "perm-1",
        "params": { "toolName": "shell", "title": "Run tests" }
    }));
    assert!(matches!(
        approval.first(),
        Some(ProviderTurnEvent::ApprovalRequested { request_id, .. }) if request_id == "perm-1"
    ));
}

#[test]
fn grok_accept_edits_clamps_to_supervised_and_auto_approval_is_once() {
    let grok = effective_permission_mode("grok", "acceptEdits");
    assert!(grok.clamped);
    assert_eq!(grok.effective, PermissionMode::Supervised);
    assert_eq!(grok_permission_flag(grok.effective), "default");
    let fx = effective_permission_mode("fx", "fullAccess");
    assert_eq!(fx.effective, PermissionMode::Supervised);
    let muse = effective_permission_mode("muse", "auto");
    assert_eq!(muse.effective, PermissionMode::Supervised);
    assert_eq!(automatic_approval_decision(), ApprovalDecision::AllowOnce);
    assert!(should_auto_approve("fullAccess", "bash"));
    assert!(should_auto_approve("acceptEdits", "write_file"));
    assert!(!should_auto_approve("acceptEdits", "bash"));
    assert!(!should_auto_approve("supervised", "write_file"));
}

#[test]
fn clap_usage_on_stderr_adds_no_assistant_item() {
    let projected = project_process_failure(
        Some(2),
        "error: a value is required for '--single <PROMPT>' but none was supplied\nUsage: grok -p <PROMPT>",
        "grok",
        &[],
    );
    assert!(projected.assistant_items.is_empty());
    assert!(matches!(
        projected.failure,
        Some(TurnFailure::CliUsageError { .. })
    ));
}

#[test]
fn auth_and_cli_flag_failures_classify_correctly() {
    let auth = classify_turn_failure(
        Some(1),
        "error: not authenticated. Run 'agy auth' to log in.",
        "antigravity",
    );
    assert!(matches!(auth, Some(TurnFailure::AuthRequired { .. })));

    let flag_err = classify_turn_failure(
        Some(2),
        "flags provided but not defined: -invalid-flag",
        "antigravity",
    );
    assert!(matches!(flag_err, Some(TurnFailure::CliUsageError { .. })));

    let model_err = classify_turn_failure(
        Some(1),
        "error: invalid model selection (--model \"Gemini 3.0 Flash\"): invalid model",
        "antigravity",
    );
    assert!(matches!(model_err, Some(TurnFailure::CliUsageError { .. })));
}

#[test]
fn usage_has_no_synthetic_cost_and_cancel_stays_silent() {
    let usage = usage_from_provider(10, 4, Some(2), Some(128_000), Some(1.5));
    let value = serde_json::to_value(&usage).unwrap();
    assert!(value.get("costUsd").is_none());
    assert_eq!(value["inputTokens"], 10);
    assert_eq!(completion_cue("cancelled", true), CompletionCue::Silent);
    assert_eq!(completion_cue("interrupted", false), CompletionCue::Silent);
    assert_eq!(completion_cue("completed", true), CompletionCue::Chime);
    assert_eq!(completion_cue("completed", false), CompletionCue::Silent);
}

#[test]
fn a_resume_handle_sends_only_the_new_delta() {
    for provider in ["grok", "antigravity", "codex", "claude", "cursor", "opencode"] {
        assert!(
            follow_up_uses_delta_only(Some("provider-session"), false),
            "{provider}"
        );
        assert!(!follow_up_uses_delta_only(None, false), "{provider}");
    }
    assert!(follow_up_uses_delta_only(None, true));
}

#[test]
fn catalogs_are_keyed_by_provider_and_connection() {
    assert_ne!(
        catalog_cache_key("grok", Some("acc-a")),
        catalog_cache_key("grok", Some("acc-b"))
    );
    assert_eq!(
        catalog_cache_key("agy", Some("acc-a")),
        catalog_cache_key("antigravity", Some("acc-a"))
    );
}

#[test]
fn effort_round_trips_through_provider_options() {
    let options = effort_option(&json!([]), Some("high"));
    let thread = json!({ "providerOptions": options });
    assert_eq!(hydrated_effort(&thread).as_deref(), Some("high"));
    let cleared = effort_option(&thread["providerOptions"], None);
    let cleared_thread = json!({ "providerOptions": cleared, "effort": Value::Null });
    assert!(hydrated_effort(&cleared_thread).is_none());
}
