use super::*;

fn thought(line: &str) -> String {
    match parse_acp_stream_line("thread-1", "run-1", line).expect("frame") {
        AcpStreamEvent::ThoughtDelta { text, .. } => text,
        other => panic!("expected a thought, got {other:?}"),
    }
}

#[test]
fn provider_thought_frames_keep_their_text() {
    assert_eq!(
        thought(r#"{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"Look at the tests."}}"#),
        "Look at the tests."
    );
    assert_eq!(
        thought(r#"{"type":"item.completed","item":{"type":"reasoning","text":"Checked the diff."}}"#),
        "Checked the diff."
    );
    assert_eq!(
        thought(r#"{"type":"text","part":{"type":"reasoning","text":"Planning the edit."}}"#),
        "Planning the edit."
    );
    assert_eq!(
        thought(r#"{"type":"response.reasoning_text.delta","delta":"Tracing the call."}"#),
        "Tracing the call."
    );
    assert_eq!(
        thought(r#"{"type":"thinking","thinking":"Reading the file."}"#),
        "Reading the file."
    );
    assert_eq!(
        thought(r#"{"type":"thought","text":"Searching the repo."}"#),
        "Searching the repo."
    );
    assert_eq!(
        thought(r#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"Opening the editor."}]}}"#),
        "Opening the editor."
    );
}

#[test]
fn an_unreadable_thought_frame_stays_a_notice() {
    match parse_acp_stream_line(
        "thread-1",
        "run-1",
        r#"{"type":"reasoning","encrypted_content":"abc"}"#,
    )
    .expect("frame")
    {
        AcpStreamEvent::UnknownFrame { message } => {
            assert!(message.contains("reasoning"));
        }
        other => panic!("expected a notice, got {other:?}"),
    }
}

#[test]
fn read_file_keeps_a_capitalized_path() {
    let params = serde_json::json!({
        "Description": "Read file",
        "EndLine": 50,
        "Path": "C:/tmp/mcp/engram/mem_current_project.json",
        "StartLine": 1
    });
    let (_kind, _server, title, command, file_path, _, _) =
        classify_tool_metadata("read_file", &params);
    assert!(command.is_none());
    assert_eq!(
        file_path.as_deref(),
        Some("C:/tmp/mcp/engram/mem_current_project.json")
    );
    assert!(title.contains("mem_current_project.json"), "{title}");
}

#[test]
fn classifies_native_subagent_and_swarm_tools_with_metadata() {
    let agy_params = serde_json::json!({
        "TypeName": "research",
        "Role": "Codebase Architecture Explorer",
        "Model": "flash",
        "Workspace": "inherit",
        "Prompt": "Explore RightDock and ChatItemRow."
    });
    let agy_out = r#"{"conversationId":"sub-conv-42","logAbsoluteUri":"file:///tmp/transcript.jsonl"}"#;
    let (kind, _, title, _, _, _, _) = classify_tool_metadata("invoke_subagent", &agy_params);
    assert_eq!(kind, "subagent");
    assert!(title.contains("Codebase Architecture Explorer"), "{title}");

    let sub_meta = extract_subagent_meta(
        "invoke_subagent",
        "call-agy-1",
        &agy_params,
        Some(agy_out),
        "completed",
    )
    .expect("subagent meta");
    assert_eq!(sub_meta.subagent_id, "sub-conv-42");
    assert_eq!(sub_meta.role, "Codebase Architecture Explorer");
    assert_eq!(sub_meta.type_name.as_deref(), Some("research"));
    assert_eq!(sub_meta.model.as_deref(), Some("flash"));
    assert_eq!(sub_meta.workspace_mode.as_deref(), Some("inherit"));
    assert_eq!(
        sub_meta.transcript_uri.as_deref(),
        Some("file:///tmp/transcript.jsonl")
    );
    assert_eq!(sub_meta.status, "completed");

    let send_params = serde_json::json!({
        "Recipient": "sub-conv-42",
        "Message": "Also inspect swarm state."
    });
    let (send_kind, ..) = classify_tool_metadata("send_message", &send_params);
    assert_eq!(send_kind, "subagent");
    let send_meta =
        extract_subagent_meta("send_message", "call-send-1", &send_params, None, "running")
            .expect("send_message meta");
    assert_eq!(send_meta.subagent_id, "sub-conv-42");
    assert_eq!(send_meta.prompt.as_deref(), Some("Also inspect swarm state."));

    let swarm_add_params = serde_json::json!({
        "action": "add",
        "name": "worker",
        "model": "flash_lite",
        "workspace": "share",
        "brief": "Audit one slice and report #seq.",
        "tasks": ["slice-a", "slice-b"]
    });
    let (swarm_kind, ..) = classify_tool_metadata("swarm", &swarm_add_params);
    assert_eq!(swarm_kind, "swarm");
    let swarm_meta =
        extract_swarm_meta("swarm", &swarm_add_params, None).expect("swarm add meta");
    assert_eq!(swarm_meta.action, "add");
    assert_eq!(swarm_meta.member_names, vec!["worker-1", "worker-2"]);
    assert_eq!(swarm_meta.workspace_mode.as_deref(), Some("share"));
    assert_eq!(swarm_meta.model.as_deref(), Some("flash_lite"));

    let post_params = serde_json::json!({
        "channel": "parser",
        "message": "@verifier please check #4 and @#reviewers before @all merges"
    });
    let (post_kind, ..) = classify_tool_metadata("post_message", &post_params);
    assert_eq!(post_kind, "swarm");
    let post_meta = extract_swarm_meta(
        "post_message",
        &post_params,
        Some(r#"{"seq": 6}"#),
    )
    .expect("post_message meta");
    assert_eq!(post_meta.action, "post_message");
    assert_eq!(post_meta.channel.as_deref(), Some("parser"));
    assert_eq!(
        post_meta.mentions,
        vec!["@verifier", "@#reviewers", "@all"]
    );
    assert_eq!(post_meta.seq, Some(6));

    let cli_run = serde_json::json!({
        "CommandLine": "kite dispatch run --via thread --provider grok --model grok-3-mini --role \"Grok Worker\" --workspace branch \"Inspect parser\""
    });
    let (cli_kind, ..) = classify_tool_metadata("run_command", &cli_run);
    assert_eq!(cli_kind, "subagent");
    let cli_meta = extract_subagent_meta("run_command", "cmd-1", &cli_run, None, "running")
        .expect("cli subagent meta");
    assert_eq!(cli_meta.provider.as_deref(), Some("grok"));
    assert_eq!(cli_meta.model.as_deref(), Some("grok-3-mini"));
    assert_eq!(cli_meta.role, "Grok Worker");
    assert_eq!(cli_meta.workspace_mode.as_deref(), Some("branch"));
}

#[test]
fn diff_metadata_handles_partial_edits_nested_args_multi_chunks_and_acp_content() {
    // Partial replacement should diff lines rather than counting unchanged surrounding lines.
    let partial = serde_json::json!({
        "arguments": "{\"TargetFile\":\"src/app.ts\",\"TargetContent\":\"line1\\nold\\nline3\",\"ReplacementContent\":\"line1\\nnew_a\\nnew_b\\nline3\"}"
    });
    let (kind, _, _, _, path, added, removed) = classify_tool_metadata("replace_file_content", &partial);
    assert_eq!(kind, "fileChange");
    assert_eq!(path.as_deref(), Some("src/app.ts"));
    assert_eq!(added, Some(2));
    assert_eq!(removed, Some(1));

    // Multi-chunk edits (`multi_replace_file_content`) sum across ReplacementChunks.
    let multi = serde_json::json!({
        "TargetFile": "README.md",
        "ReplacementChunks": [
            { "TargetContent": "a\nb", "ReplacementContent": "a\nb\nc" },
            { "TargetContent": "x\ny", "ReplacementContent": "x" }
        ]
    });
    let (m_kind, _, _, _, m_path, m_added, m_removed) = classify_tool_metadata("multi_replace_file_content", &multi);
    assert_eq!(m_kind, "fileChange");
    assert_eq!(m_path.as_deref(), Some("README.md"));
    assert_eq!(m_added, Some(1));
    assert_eq!(m_removed, Some(1));

    // ACP `session/update` with `content` diff blocks + `locations` + `kind: "edit"`.
    let acp_line = serde_json::json!({
        "method": "session/update",
        "params": {
            "update": {
                "sessionUpdate": "tool_call_update",
                "toolCallId": "edit-1",
                "kind": "edit",
                "title": "Edit README.md",
                "status": "completed",
                "locations": [{ "path": "README.md" }],
                "content": [{
                    "type": "diff",
                    "path": "README.md",
                    "oldText": "Compile the standalone native Windows installer:\n\n```powershell",
                    "newText": "<!-- Thread diff test -->\nCompile the standalone native installer:\n```powershell"
                }]
            }
        }
    })
    .to_string();
    match parse_acp_stream_line("thread-1", "run-1", &acp_line) {
        Some(AcpStreamEvent::ToolUpdate { tool }) => {
            assert_eq!(tool.tool_kind, "fileChange");
            assert_eq!(tool.file_path.as_deref(), Some("README.md"));
            assert_eq!(tool.added_lines, Some(2));
            assert_eq!(tool.removed_lines, Some(2));
        }
        other => panic!("expected ToolUpdate, got {:?}", other.is_some()),
    }

    // Codex `item.completed` with `type: "file_change"`.
    let codex_line = serde_json::json!({
        "type": "item.completed",
        "item": {
            "id": "fc-1",
            "type": "file_change",
            "status": "completed",
            "changes": [{
                "path": "README.md",
                "kind": "update",
                "diff": "@@ -1,2 +1,2 @@\n-old line\n+new line\n+extra line\n"
            }]
        }
    })
    .to_string();
    match parse_acp_stream_line("thread-1", "run-1", &codex_line) {
        Some(AcpStreamEvent::ToolUpdate { tool }) => {
            assert_eq!(tool.tool_kind, "fileChange");
            assert_eq!(tool.file_path.as_deref(), Some("README.md"));
            assert_eq!(tool.added_lines, Some(2));
            assert_eq!(tool.removed_lines, Some(1));
        }
        other => panic!("expected Codex file_change ToolUpdate, got {:?}", other.is_some()),
    }
}
