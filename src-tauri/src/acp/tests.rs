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
    let (send_kind, _, send_title, ..) = classify_tool_metadata("send_message", &send_params);
    assert_eq!(send_kind, "dynamicToolCall");
    assert_eq!(send_title, "send message");
    assert!(
        extract_subagent_meta("send_message", "call-send-1", &send_params, None, "running")
            .is_none(),
        "send_message is non-delegating and must not produce SubagentMeta"
    );

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

#[test]
fn cli_dispatch_strips_shell_redirections_avoids_run_command_role_and_propagates_failures() {
    let params = serde_json::json!({
        "CommandLine": "kite dispatch run --via thread --provider grok \"Audit auth 2>&1\" 2>&1 | tee dispatch.log && echo done"
    });
    let (kind, _, title, _, _, _, _) = classify_tool_metadata("run_command", &params);
    assert_eq!(kind, "subagent");
    assert!(!title.to_ascii_lowercase().contains("run command"), "{title}");

    let meta = extract_subagent_meta(
        "run_command",
        "cmd-redir",
        &params,
        Some("stderr noise\n{\"exit\":2,\"status\":\"rejected\",\"error\":\"Provider grok is not signed in\"}"),
        "completed",
    )
    .expect("subagent meta");
    assert_eq!(meta.role, "Grok subagent");
    assert_eq!(meta.prompt.as_deref(), Some("Audit auth 2>&1"));
    assert_eq!(meta.status, "failed");
    assert_eq!(
        meta.latest_activity.as_deref(),
        Some("Provider grok is not signed in")
    );

    let update_tool = acp_tool_from_update(
        &serde_json::json!({
            "toolCallId": "cmd-exit-2",
            "toolName": "bash",
            "status": "completed",
            "exitCode": 2,
            "rawInput": {
                "command": "kite dispatch run --provider codex \"Fix race\" > out.log 2>&1"
            }
        }),
        None,
        None,
    );
    assert_eq!(update_tool.tool_kind, "subagent");
    assert_eq!(update_tool.status, "failed");
    let update_meta = update_tool.subagent_meta.expect("subagent meta");
    assert_eq!(update_meta.role, "Codex subagent");
    assert_eq!(update_meta.prompt.as_deref(), Some("Fix race"));
    assert_eq!(update_meta.status, "failed");
}

#[test]
fn manage_subagents_and_define_subagent_do_not_classify_as_subagent_and_multiline_output_parses() {
    let list_params = serde_json::json!({ "Action": "list" });
    let (list_kind, ..) = classify_tool_metadata("manage_subagents", &list_params);
    assert_eq!(
        list_kind, "dynamicToolCall",
        "manage_subagents must not spawn subagent timeline cards"
    );
    assert!(
        extract_subagent_meta(
            "manage_subagents",
            "t_list_1",
            &list_params,
            Some("You have 1 active subagent(s):\n[{\"role\":\"Verifier\",\"conversationId\":\"cid-1\",\"state\":\"idle\"}]"),
            "completed",
        )
        .is_none(),
        "manage_subagents must not extract SubagentMeta"
    );

    let (def_kind, ..) = classify_tool_metadata("define_subagent", &serde_json::json!({ "Name": "reviewer" }));
    assert_eq!(def_kind, "dynamicToolCall");
    assert!(extract_subagent_meta("define_subagent", "t_def_1", &serde_json::json!({}), None, "completed").is_none());

    let invoke_params = serde_json::json!({
        "Role": "Independent Spec Verifier",
        "TypeName": "research",
        "Prompt": "Verify S1"
    });
    let invoke_out = "Created the following subagent:\n{\n  \"conversationId\": \"abc6835a-587c-41e4-ad92-3716bb4286e3\",\n  \"logAbsoluteUri\": \"file:///tmp/abc/transcript.jsonl\"\n}\nThe subagent will send you a message when done.";
    let invoke_meta = extract_subagent_meta(
        "invoke_subagent",
        "t_inv_1",
        &invoke_params,
        Some(invoke_out),
        "completed",
    )
    .expect("invoke_subagent meta");
    assert_eq!(invoke_meta.subagent_id, "abc6835a-587c-41e4-ad92-3716bb4286e3");
    assert_eq!(
        invoke_meta.transcript_uri.as_deref(),
        Some("file:///tmp/abc/transcript.jsonl")
    );

    let list_output = "You have 1 active subagent(s):\n[{\"role\":\"Independent Spec Verifier\",\"type\":\"research\",\"conversationId\":\"abc6835a-587c-41e4-ad92-3716bb4286e3\",\"transcript\":\"file:///C:/tmp/abc/transcript.jsonl\",\"state\":\"idle\"}]";
    let parsed_list = parse_output_json_array(Some(list_output)).expect("parsed subagent array");
    assert_eq!(parsed_list.len(), 1);
    assert_eq!(
        parsed_list[0]["conversationId"],
        "abc6835a-587c-41e4-ad92-3716bb4286e3"
    );
}

#[test]
fn step_update_subagent_variant_emits_tool_update() {
    let line = r#"{"event":"step_update","step_update":{"step_index":301,"step_type":"subagent","tool_name":"invoke_subagent","state":"RUNNING","parameters":{"Role":"Independent Spec Verifier","TypeName":"research","Prompt":"Verify ODDs","Model":"inherit"}}}"#;
    match parse_acp_stream_line("t1", "r1", line) {
        Some(AcpStreamEvent::ToolUpdate { tool }) => {
            assert_eq!(tool.tool_kind, "subagent");
            assert_eq!(tool.name, "invoke_subagent");
            let meta = tool.subagent_meta.expect("subagent meta");
            assert_eq!(meta.role, "Independent Spec Verifier");
            assert_eq!(meta.type_name.as_deref(), Some("research"));
            assert!(meta.model.is_none(), "sentinel 'inherit' model must resolve to None/inherited parent model");
        }
        other => panic!("expected AcpStreamEvent::ToolUpdate for step_type=subagent, got {other:?}"),
    }
}

#[test]
fn cli_subagent_inherit_model_resolves_to_none() {
    let meta = extract_subagent_meta(
        "run_command",
        "call_cli_inherit",
        &serde_json::json!({
            "CommandLine": "kite dispatch run --role Auditor --model inherit -- Prompt check"
        }),
        None,
        "running",
    )
    .expect("subagent meta for kite dispatch run");
    assert_eq!(meta.role, "Auditor");
    assert!(
        meta.model.is_none(),
        "CLI `--model inherit` must resolve to None so parent model is inherited: {meta:?}"
    );
}

#[test]
fn parse_acp_stream_line_strips_system_message_envelopes_and_preserves_inline_mentions() {
    let glued = r#"{"event":"step_update","step_update":{"step_index":12,"step_type":"agent_response","text_delta":"user\nThe following is a <SYSTEM_MESSAGE> not actually sent by the user.\n</SYSTEM_MESSAGE>Confirmado."}}"#;
    match parse_acp_stream_line("t1", "r1", glued) {
        Some(AcpStreamEvent::ContentDelta { text }) => assert_eq!(text, "Confirmado."),
        other => panic!("expected ContentDelta, got {other:?}"),
    }

    let unclosed = r#"{"event":"step_update","step_update":{"step_index":13,"step_type":"agent_response","text_delta":"<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-18 sender=s1"}}"#;
    assert!(
        matches!(parse_acp_stream_line("t1", "r1", unclosed), Some(AcpStreamEvent::Raw { .. })),
        "protocol-only delta must be absorbed as Raw, not emitted as ContentDelta or UnknownFrame"
    );

    let mention = r#"{"event":"step_update","step_update":{"step_index":14,"step_type":"agent_response","text_delta":"Preserved `<SYSTEM_MESSAGE>` inline mention."}}"#;
    match parse_acp_stream_line("t1", "r1", mention) {
        Some(AcpStreamEvent::ContentDelta { text }) => {
            assert_eq!(text, "Preserved `<SYSTEM_MESSAGE>` inline mention.");
        }
        other => panic!("expected ContentDelta, got {other:?}"),
    }
}

#[test]
fn mcp_kite_subagent_and_swarm_tools_classify_and_normalize_worktree_workspace() {
    // 1. Prefixed and unprefixed kite_subagent_run with workspace: "worktree" and tasks array
    let run_params = serde_json::json!({
        "role": "Fast Executor",
        "provider": "antigravity",
        "model": "gemini-3.8-flash",
        "workspace": "Worktree",
        "tasks": ["Inspect auth.rs", "Inspect session.rs"]
    });
    for tool_name in [
        "kite_subagent_run",
        "mcp_kite-dispatch_kite_subagent_run",
        "mcp__kite-dispatch__kite_subagent_run",
    ] {
        let (kind, server, title, ..) = classify_tool_metadata(tool_name, &run_params);
        assert_eq!(kind, "subagent", "tool_name={tool_name}");
        assert!(title.contains("Fast Executor"), "title={title}");
        if tool_name.starts_with("mcp") {
            assert_eq!(server.as_deref(), Some("kite-dispatch"));
        }
        let meta = extract_subagent_meta(
            tool_name,
            "call_mcp_run_1",
            &run_params,
            Some("Done.\n[subagent_id: thread:child-mcp-1]"),
            "completed",
        )
        .expect("kite_subagent_run meta");
        assert_eq!(meta.role, "Fast Executor");
        assert_eq!(meta.provider.as_deref(), Some("antigravity"));
        assert_eq!(meta.model.as_deref(), Some("gemini-3.8-flash"));
        assert_eq!(meta.workspace_mode.as_deref(), Some("share"));
        assert_eq!(meta.subagent_id, "child-mcp-1");
        assert_eq!(meta.child_thread_id.as_deref(), Some("child-mcp-1"));
        assert_eq!(
            meta.prompt.as_deref(),
            Some("(2) Inspect auth.rs | Inspect session.rs")
        );
    }

    // 2. Non-delegating control tools (`kite_subagent_send`, `kite_subagent_wait`, `kite_subagent_read`, and `call_mcp_tool` variants)
    //    must classify as `mcpToolCall` with readable titles and return `None` from `extract_subagent_meta`.
    let send_params = serde_json::json!({
        "target": "thread:child-mcp-1",
        "task": "Verify follow-up edge case",
        "workspace": "worktree"
    });
    let (send_kind, _, send_title, ..) = classify_tool_metadata("kite_subagent_send", &send_params);
    assert_eq!(send_kind, "mcpToolCall");
    assert_eq!(send_title, "kite-dispatch · kite_subagent_send");
    assert!(
        extract_subagent_meta(
            "kite_subagent_send",
            "call_mcp_send_1",
            &send_params,
            None,
            "running",
        )
        .is_none(),
        "kite_subagent_send must not produce SubagentMeta"
    );

    let wait_params = serde_json::json!({
        "targets": ["thread:child-mcp-1"]
    });
    let (wait_kind, wait_srv, wait_title, ..) =
        classify_tool_metadata("mcp_kite-dispatch_kite_subagent_wait", &wait_params);
    assert_eq!(wait_kind, "mcpToolCall");
    assert_eq!(wait_srv.as_deref(), Some("kite-dispatch"));
    assert_eq!(wait_title, "kite-dispatch · kite_subagent_wait");
    assert!(
        extract_subagent_meta(
            "mcp_kite-dispatch_kite_subagent_wait",
            "call_mcp_wait_1",
            &wait_params,
            None,
            "completed",
        )
        .is_none(),
        "kite_subagent_wait must not produce SubagentMeta"
    );

    let call_mcp_wait_params = serde_json::json!({
        "ServerName": "kite-dispatch",
        "ToolName": "kite_subagent_wait",
        "Arguments": { "children": "all" }
    });
    let (cm_wait_kind, cm_wait_srv, cm_wait_title, ..) =
        classify_tool_metadata("call_mcp_tool", &call_mcp_wait_params);
    assert_eq!(cm_wait_kind, "mcpToolCall");
    assert_eq!(cm_wait_srv.as_deref(), Some("kite-dispatch"));
    assert_eq!(cm_wait_title, "kite-dispatch · kite_subagent_wait");
    assert!(
        extract_subagent_meta(
            "call_mcp_tool",
            "call_mcp_wait_2",
            &call_mcp_wait_params,
            None,
            "completed",
        )
        .is_none(),
        "call_mcp_tool(kite_subagent_wait) must not produce SubagentMeta"
    );

    let read_params = serde_json::json!({
        "subagentId": "thread:child-mcp-1"
    });
    let (read_kind, _, read_title, ..) = classify_tool_metadata("kite_subagent_read", &read_params);
    assert_eq!(read_kind, "mcpToolCall");
    assert_eq!(read_title, "kite-dispatch · kite_subagent_read");
    assert!(
        extract_subagent_meta(
            "kite_subagent_read",
            "call_mcp_read_1",
            &read_params,
            None,
            "completed",
        )
        .is_none(),
        "kite_subagent_read must not produce SubagentMeta"
    );

    // 3. CLI `--workspace worktree` normalization
    let cli_wt_meta = extract_subagent_meta(
        "run_command",
        "call_cli_wt",
        &serde_json::json!({
            "CommandLine": "kite dispatch run --via thread --role Worker --workspace worktree \"Check files\""
        }),
        None,
        "running",
    )
    .expect("cli worktree meta");
    assert_eq!(cli_wt_meta.workspace_mode.as_deref(), Some("share"));

    // 4. kite_swarm (prefixed and unprefixed) with workspace: "worktree"
    let swarm_params = serde_json::json!({
        "action": "add",
        "title": "Parser Swarm",
        "name": "parser",
        "model": "gemini-3.8-flash",
        "workspace": "worktree",
        "channel": "parser",
        "brief": "Audit AST nodes"
    });
    for swarm_tool in ["kite_swarm", "mcp_kite-dispatch_kite_swarm"] {
        let (sw_kind, ..) = classify_tool_metadata(swarm_tool, &swarm_params);
        assert_eq!(sw_kind, "swarm", "swarm_tool={swarm_tool}");
        let sw_meta = extract_swarm_meta(swarm_tool, &swarm_params, None).expect("kite_swarm meta");
        assert_eq!(sw_meta.action, "add");
        assert_eq!(sw_meta.swarm_title.as_deref(), Some("Parser Swarm"));
        assert_eq!(sw_meta.member_name.as_deref(), Some("parser"));
        assert_eq!(sw_meta.model.as_deref(), Some("gemini-3.8-flash"));
        assert_eq!(sw_meta.workspace_mode.as_deref(), Some("share"));
        assert_eq!(sw_meta.channel.as_deref(), Some("parser"));
        assert_eq!(sw_meta.brief.as_deref(), Some("Audit AST nodes"));
    }
}

#[test]
fn step_update_subagent_info_populates_role_type_prompt_and_child_refs_when_tool_info_omitted() {
    let blocked_line = r#"{"event":"step_update","step_update":{"step_index":40,"step_type":"subagent","tool_name":"invoke_subagent","state":"ERROR","subagent_info":{"subagents":[{"type_name":"research","role":"Chat Keystroke Jump Investigator","initial_prompt":"Trace keystroke jump"}]}}}"#;
    match parse_acp_stream_line("t1", "r40", blocked_line) {
        Some(AcpStreamEvent::ToolUpdate { tool }) => {
            assert_eq!(tool.tool_kind, "subagent");
            assert_eq!(tool.name, "invoke_subagent");
            assert_eq!(tool.status, "failed");
            assert_eq!(tool.title, "Subagent · Chat Keystroke Jump Investigator");
            let meta = tool.subagent_meta.expect("subagent meta");
            assert_eq!(meta.role, "Chat Keystroke Jump Investigator");
            assert_eq!(meta.type_name.as_deref(), Some("research"));
            assert_eq!(meta.prompt.as_deref(), Some("Trace keystroke jump"));
        }
        other => panic!("expected AcpStreamEvent::ToolUpdate, got {other:?}"),
    }

    let spawned_line = r#"{"event":"step_update","step_update":{"step_index":41,"step_type":"subagent","state":"DONE","subagent_info":{"subagents":[{"type_name":"research","role":"Spec Verifier","initial_prompt":"Verify specs","conversation_id":"conv-agy-41","log_uri":"file:///tmp/conv-agy-41/transcript.jsonl"}]}}}"#;
    match parse_acp_stream_line("t1", "r40", spawned_line) {
        Some(AcpStreamEvent::ToolUpdate { tool }) => {
            assert_eq!(tool.name, "invoke_subagent");
            let meta = tool.subagent_meta.expect("subagent meta");
            assert_eq!(meta.subagent_id, "conv-agy-41");
            assert_eq!(meta.role, "Spec Verifier");
            assert_eq!(meta.type_name.as_deref(), Some("research"));
            assert_eq!(meta.prompt.as_deref(), Some("Verify specs"));
            assert_eq!(
                meta.transcript_uri.as_deref(),
                Some("file:///tmp/conv-agy-41/transcript.jsonl")
            );
        }
        other => panic!("expected AcpStreamEvent::ToolUpdate, got {other:?}"),
    }
}
