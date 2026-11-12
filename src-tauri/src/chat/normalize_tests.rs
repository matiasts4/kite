    use super::*;
    use crate::chat::session::{
        ScriptedTransport, SessionError, SessionManager, SessionMode, SessionSpec, TransportEvent,
    };

    const ANTIGRAVITY_STREAM: &str = include_str!("../../tests/fixtures/antigravity.stream.json");
    const CODEX_TOOL_CALL: &str = include_str!("../../tests/fixtures/codex.tool-call.json");
    const CLAUDE_TEXT: &str = include_str!("../../tests/fixtures/claude.text.txt");
    const UNKNOWN_FRAME: &str = include_str!("../../tests/fixtures/unknown.frame.json");
    const APPROVAL_ANTIGRAVITY: &str =
        include_str!("../../tests/fixtures/approval.antigravity.stream.json");
    const APPROVAL_ACP: &str =
        include_str!("../../tests/fixtures/approval.acp.session-request.json");
    const APPROVAL_ANTIGRAVITY_RESPONSE: &str =
        include_str!("../../tests/fixtures/approval.antigravity.response.json");
    const APPROVAL_ACP_RESPONSE: &str =
        include_str!("../../tests/fixtures/approval.acp.response.json");
    const APPROVAL_SETTLED: &str = include_str!("../../tests/fixtures/approval.settled.frame.json");

    const DECLARED: [&str; 8] = [
        "antigravity",
        "acp",
        "claude",
        "codex",
        "cursor",
        "gemini",
        "grok",
        "opencode",
    ];

    fn opened(provider: &str, body: &str) -> NormalizedApproval {
        let events = replay_fixture(provider, body);
        assert_eq!(events.len(), 1, "expected exactly one event for {body}");
        match events.into_iter().next().unwrap() {
            NormalizedEvent::ApprovalOpened { approval } => approval,
            other => panic!("expected an approvalOpened event, got {other:?}"),
        }
    }

    #[test]
    fn every_fixture_replays_deterministically_twice() {
        let fixtures = [
            ("antigravity", ANTIGRAVITY_STREAM),
            ("codex", CODEX_TOOL_CALL),
            ("claude", CLAUDE_TEXT),
            ("antigravity", UNKNOWN_FRAME),
            ("antigravity", APPROVAL_ANTIGRAVITY),
            ("acp", APPROVAL_ACP),
            ("antigravity", APPROVAL_ANTIGRAVITY_RESPONSE),
            ("acp", APPROVAL_ACP_RESPONSE),
            ("antigravity", APPROVAL_SETTLED),
        ];

        for (provider, body) in fixtures {
            let first = replay_fixture(provider, body);
            let second = replay_fixture(provider, body);
            assert_eq!(first, second, "{provider} fixture must replay identically");
            assert!(!first.is_empty(), "{provider} fixture must not drop every event");
        }
    }

    #[test]
    fn the_antigravity_stream_frame_becomes_text() {
        assert_eq!(
            replay_fixture("antigravity", ANTIGRAVITY_STREAM),
            vec![NormalizedEvent::Text {
                text: "I will inspect the workspace before editing.".to_string(),
            }]
        );
        assert_eq!(
            replay_fixture("agy", ANTIGRAVITY_STREAM),
            replay_fixture("antigravity", ANTIGRAVITY_STREAM),
            "the program alias is the same wire"
        );
    }

    #[test]
    fn the_codex_json_frame_becomes_a_tool() {
        let events = replay_fixture("codex", CODEX_TOOL_CALL);
        assert_eq!(events.len(), 1, "one frame is one event");
        match &events[0] {
            NormalizedEvent::Tool { tool } => {
                assert_eq!(tool.id, "call_codex_1");
                assert_eq!(tool.name, "shell");
                assert_eq!(tool.tool_kind, "commandExecution");
                assert_eq!(tool.command.as_deref(), Some("cargo test chat::normalize::"));
                assert_eq!(tool.status, "running");
                assert!(tool.detail.contains("cargo test chat::normalize::"));
            }
            other => panic!("expected a tool event, got {other:?}"),
        }
    }

    #[test]
    fn the_claude_text_frame_becomes_text() {
        assert_eq!(
            replay_fixture("claude", CLAUDE_TEXT),
            vec![NormalizedEvent::Text {
                text: "I will inspect the workspace before editing it.".to_string(),
            }]
        );
    }

    #[test]
    fn an_unknown_frame_is_a_bounded_notice_with_provider_metadata() {
        let events = replay_fixture("antigravity", UNKNOWN_FRAME);
        assert_eq!(events.len(), 1);
        match &events[0] {
            NormalizedEvent::Notice {
                provider,
                code,
                message,
                hint,
            } => {
                assert_eq!(provider, "antigravity");
                assert_eq!(code, "unknownFrame");
                assert!(message.contains("telemetry"), "the notice names the shape");
                assert!(
                    message.chars().count() <= 280,
                    "the notice is bounded, got {} chars",
                    message.chars().count()
                );
                assert!(!hint.is_empty());
                assert!(hint.contains("event"), "the hint names the expected schema");
            }
            other => panic!("expected a notice event, got {other:?}"),
        }

        match &normalize_frame("agy", UNKNOWN_FRAME)[0] {
            NormalizedEvent::Notice { provider, .. } => {
                assert_eq!(provider, "antigravity", "an alias is reported canonically")
            }
            other => panic!("expected a notice event, got {other:?}"),
        }
    }

    #[test]
    fn a_malformed_json_frame_is_bounded() {
        let raw = format!(
            "{{\"event\":\"step_update\",\"step_update\":{{\"text\":\"{}\"}}",
            "x".repeat(8_000)
        );
        let events = normalize_frame("antigravity", &raw);
        assert_eq!(events.len(), 1);
        match &events[0] {
            NormalizedEvent::Notice { code, message, .. } => {
                assert_eq!(code, "malformedFrame");
                assert!(message.chars().count() <= 280);
            }
            other => panic!("expected a notice event, got {other:?}"),
        }
    }

    #[test]
    fn a_non_json_frame_on_a_json_wire_is_a_notice() {
        let events = normalize_frame("antigravity", "starting provider...");
        match &events[0] {
            NormalizedEvent::Notice { code, .. } => assert_eq!(code, "nonJsonFrame"),
            other => panic!("expected a notice event, got {other:?}"),
        }
    }

    #[test]
    fn session_metadata_frames_produce_no_transcript_event() {
        assert!(normalize_frame(
            "antigravity",
            r#"{"event":"init","init":{"conversation_id":"conversation-1","model":"model-1"}}"#
        )
        .is_empty());
        assert!(normalize_frame("claude", r#"{"type":"system","session_id":"session-1"}"#)
            .is_empty());
    }

    #[test]
    fn provider_thought_frames_become_reasoning_items() {
        let samples = [
            (
                "claude",
                r#"{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"Look at the tests."}}"#,
                "Look at the tests.",
            ),
            (
                "codex",
                r#"{"type":"item.completed","item":{"type":"reasoning","text":"Checked the diff."}}"#,
                "Checked the diff.",
            ),
            (
                "opencode",
                r#"{"type":"text","part":{"type":"reasoning","text":"Planning the edit."}}"#,
                "Planning the edit.",
            ),
            (
                "grok",
                r#"{"type":"response.reasoning_text.delta","delta":"Tracing the call."}"#,
                "Tracing the call.",
            ),
            (
                "cursor",
                r#"{"type":"thinking","thinking":"Reading the file."}"#,
                "Reading the file.",
            ),
            (
                "gemini",
                r#"{"type":"thought","text":"Searching the repo."}"#,
                "Searching the repo.",
            ),
            (
                "antigravity",
                r#"{"event":"step_update","step_update":{"step_type":"thought","state":"DONE","step_index":1,"text":"I checked the parser."}}"#,
                "I checked the parser.",
            ),
        ];
        for (provider, raw, text) in samples {
            match &normalize_frame(provider, raw)[0] {
                NormalizedEvent::Reasoning { text: got, .. } => assert_eq!(got, text, "{provider}"),
                other => panic!("{provider} dropped a thought frame: {other:?}"),
            }
        }
        match &normalize_frame("grok", r#"{"type":"reasoning","encrypted_content":"abc"}"#)[0] {
            NormalizedEvent::Notice { code, .. } => assert_eq!(code, "unknownThought"),
            other => panic!("unreadable thought was dropped: {other:?}"),
        }
    }

    #[test]
    fn reasoning_plan_usage_and_error_frames_normalize() {
        assert_eq!(
            normalize_frame(
                "antigravity",
                r#"{"event":"step_update","step_update":{"step_type":"thought","state":"DONE","step_index":2,"text":"I checked the parser.","duration_seconds":1.5}}"#
            ),
            vec![NormalizedEvent::Reasoning {
                text: "I checked the parser.".to_string(),
                done: true,
                duration_seconds: Some(1.5),
            }]
        );

        assert_eq!(
            normalize_frame(
                "acp",
                r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"plan","step":"Run the focused tests","status":"completed"}}}"#
            ),
            vec![NormalizedEvent::Plan {
                step: "Run the focused tests".to_string(),
                status: "completed".to_string(),
            }]
        );

        assert_eq!(
            normalize_frame(
                "antigravity",
                r#"{"event":"result","result":{"status":"SUCCESS","usage":{"input_tokens":120,"output_tokens":30},"duration_seconds":2.5}}"#
            ),
            vec![NormalizedEvent::Usage {
                input_tokens: 120,
                output_tokens: 30,
                duration_seconds: 2.5,
            }]
        );

        assert_eq!(
            normalize_frame(
                "claude",
                r#"{"type":"result","usage":{"input_tokens":7,"output_tokens":3},"duration_ms":1500}"#
            ),
            vec![NormalizedEvent::Usage {
                input_tokens: 7,
                output_tokens: 3,
                duration_seconds: 1.5,
            }]
        );

        match &normalize_frame(
            "claude",
            r#"{"type":"error","error":{"code":"auth","message":"login required"}}"#,
        )[0]
        {
            NormalizedEvent::Error { code, message } => {
                assert_eq!(code, "auth");
                assert!(message.contains("login required"));
            }
            other => panic!("expected an error event, got {other:?}"),
        }
    }

    #[test]
    fn each_approval_request_opens_with_a_provider_issued_id() {
        let antigravity = opened("antigravity", APPROVAL_ANTIGRAVITY);
        assert_eq!(antigravity.id, "perm-agy-1");
        assert_eq!(antigravity.provider, "antigravity");
        assert_eq!(antigravity.risk, "command");
        assert_eq!(
            antigravity.command.as_deref(),
            Some("cargo publish --dry-run")
        );
        assert_eq!(antigravity.detail, "Publish the crate to the registry");

        let acp = opened("acp", APPROVAL_ACP);
        assert_eq!(acp.id, "perm-42");
        assert_eq!(acp.provider, "acp");
        assert_eq!(acp.tool_name, "shell");
        assert_eq!(acp.risk, "command");
        assert_eq!(acp.command.as_deref(), Some("cargo publish --dry-run"));
    }

    #[test]
    fn the_four_canonical_decisions_map_for_every_declared_provider() {
        for provider in DECLARED {
            for decision in [
                ApprovalDecision::AllowOnce,
                ApprovalDecision::AllowForSession,
                ApprovalDecision::Deny,
                ApprovalDecision::DenyAndStop,
            ] {
                let raw = format!("{{\"decision\":\"{}\"}}", decision.as_str());
                assert_eq!(
                    map_approval(provider, &raw),
                    ApprovalMapping::Decision(decision),
                    "{provider} must map {}",
                    decision.as_str()
                );
            }
        }
    }

    #[test]
    fn the_antigravity_vocabulary_maps_to_the_canonical_decisions() {
        let cases = [
            ("allow_once", ApprovalDecision::AllowOnce),
            ("allow_always", ApprovalDecision::AllowForSession),
            ("accept_for_session", ApprovalDecision::AllowForSession),
            ("reject_once", ApprovalDecision::Deny),
            ("reject_and_stop", ApprovalDecision::DenyAndStop),
            ("cancel", ApprovalDecision::DenyAndStop),
            ("approved", ApprovalDecision::AllowOnce),
        ];

        for (token, expected) in cases {
            let raw = format!(
                "{{\"jsonrpc\":\"2.0\",\"id\":\"perm-1\",\"result\":{{\"outcome\":{{\"outcome\":\"selected\",\"optionId\":\"{token}\"}}}}}}"
            );
            assert_eq!(
                map_approval("antigravity", &raw),
                ApprovalMapping::Decision(expected),
                "token {token}"
            );
            assert_eq!(
                map_approval("acp", &raw),
                ApprovalMapping::Decision(expected),
                "token {token} on the ACP wire"
            );
        }

        assert_eq!(
            map_approval("antigravity", APPROVAL_ANTIGRAVITY_RESPONSE),
            ApprovalMapping::Decision(ApprovalDecision::AllowForSession)
        );
        assert_eq!(
            map_approval("acp", APPROVAL_ACP_RESPONSE),
            ApprovalMapping::Decision(ApprovalDecision::Deny)
        );
    }

    #[test]
    fn an_unobserved_provider_vocabulary_is_explicitly_unsupported() {
        match map_approval("codex", r#"{"decision":"accept"}"#) {
            ApprovalMapping::Unsupported { reason } => {
                assert!(reason.contains("codex"), "the reason names the provider");
                assert!(reason.contains("accept"), "the reason names the token");
            }
            other => panic!("codex accept is not observed, got {other:?}"),
        }

        match map_approval("unknown-provider", r#"{"decision":"allowOnce"}"#) {
            ApprovalMapping::Unsupported { reason } => {
                assert!(reason.contains("unknown-provider"));
            }
            other => panic!("an undeclared provider must be unsupported, got {other:?}"),
        }

        match map_approval(
            "antigravity",
            r#"{"result":{"outcome":{"optionId":"maybe_later"}}}"#,
        ) {
            ApprovalMapping::Unsupported { reason } => {
                assert!(reason.contains("maybe_later"), "the reason names the token");
            }
            other => panic!("an unknown token must be unsupported, got {other:?}"),
        }
    }

    #[test]
    fn an_approval_request_is_not_a_settlement() {
        for (provider, body) in [
            ("antigravity", APPROVAL_ANTIGRAVITY),
            ("acp", APPROVAL_ACP),
        ] {
            match map_approval(provider, body) {
                ApprovalMapping::Unsupported { reason } => {
                    assert!(reason.contains("request"), "the reason names the request: {reason}");
                }
                other => panic!("an open request must not become a decision, got {other:?}"),
            }
        }
    }

    #[test]
    fn a_settled_request_is_never_settled_again() {
        let first = map_approval("antigravity", APPROVAL_SETTLED);
        let second = map_approval("antigravity", APPROVAL_SETTLED);
        assert_eq!(first, second, "mapping is pure and repeatable");
        match first {
            ApprovalMapping::Unsupported { reason } => {
                assert!(reason.contains("settled"), "the reason names the settled state");
            }
            other => panic!("a settled request must not map, got {other:?}"),
        }

        match map_approval(
            "antigravity",
            r#"{"decision":"allowOnce","status":"resolved"}"#,
        ) {
            ApprovalMapping::Unsupported { reason } => assert!(reason.contains("settled")),
            other => panic!("a settled marker must win over the token, got {other:?}"),
        }
    }

    #[test]
    fn a_settled_approval_cannot_be_settled_twice_on_the_thread() {
        let request = normalize_frame("antigravity", APPROVAL_ANTIGRAVITY);
        let NormalizedEvent::ApprovalOpened { approval } = &request[0] else {
            panic!("expected an approvalOpened event, got {:?}", request[0]);
        };
        let ApprovalMapping::Decision(decision) =
            map_approval("antigravity", APPROVAL_ANTIGRAVITY_RESPONSE)
        else {
            panic!("the response fixture must map");
        };

        let mut manager = SessionManager::new();
        let transport = ScriptedTransport::new();
        let spec = SessionSpec {
            thread_id: "thread-1".to_string(),
            driver: "antigravity".to_string(),
            connection_id: None,
            working_directory: None,
            mode: SessionMode::OneShot,
            recipe: None,
            resume_handle: None,
        };
        manager.attach(spec, Box::new(transport.clone())).unwrap();
        manager.start("thread-1").unwrap();
        transport.script(TransportEvent::ApprovalRequest {
            id: approval.id.clone(),
            kind: "command".to_string(),
        });
        manager.poll("thread-1").unwrap();

        manager
            .respond_approval("thread-1", &approval.id, decision)
            .unwrap();
        let events_after_first = manager.events_since("thread-1", 0);
        let record_after_first = manager.status("thread-1").unwrap();

        let error = manager
            .respond_approval("thread-1", &approval.id, decision)
            .unwrap_err();
        assert_eq!(error, SessionError::UnknownApproval(approval.id.clone()));
        assert_eq!(
            manager.events_since("thread-1", 0),
            events_after_first,
            "a rejected second settlement writes no event"
        );
        assert_eq!(
            manager.status("thread-1").unwrap(),
            record_after_first,
            "a rejected second settlement changes no session field"
        );
    }

    #[test]
    fn normalized_events_serialize_with_a_kind_tag() {
        let text = serde_json::to_value(NormalizedEvent::Text {
            text: "hi".to_string(),
        })
        .unwrap();
        assert_eq!(text, serde_json::json!({ "kind": "text", "text": "hi" }));

        let approval = serde_json::to_value(NormalizedEvent::ApprovalOpened {
            approval: opened("antigravity", APPROVAL_ANTIGRAVITY),
        })
        .unwrap();
        assert_eq!(approval["kind"], "approvalOpened");
        assert_eq!(approval["approval"]["id"], "perm-agy-1");
        assert_eq!(approval["approval"]["provider"], "antigravity");
    }

    #[test]
    fn the_existing_acp_parsers_are_unchanged() {
        use crate::acp::{format_acp_approval_response, parse_acp_stream_line, AcpStreamEvent};

        match parse_acp_stream_line("thread-1", "run-1", APPROVAL_ANTIGRAVITY.trim()).unwrap() {
            AcpStreamEvent::PermissionRequired { approval } => {
                assert_eq!(approval.request_id, "perm-agy-1");
                assert_eq!(approval.tool_name, "ask_permission");
                assert_eq!(approval.command.as_deref(), Some("cargo publish --dry-run"));
                assert_eq!(approval.title, "Publish the crate to the registry");
            }
            other => panic!("expected the antigravity approval shape, got {other:?}"),
        }

        match parse_acp_stream_line("thread-1", "run-1", APPROVAL_ACP.trim()).unwrap() {
            AcpStreamEvent::PermissionRequired { approval } => {
                assert_eq!(approval.request_id, "perm-42");
                assert_eq!(approval.tool_name, "shell");
                assert_eq!(approval.command.as_deref(), Some("cargo publish --dry-run"));
            }
            other => panic!("expected the ACP approval shape, got {other:?}"),
        }

        assert_eq!(
            format_acp_approval_response("perm-42", "allow_once"),
            "{\"id\":\"perm-42\",\"jsonrpc\":\"2.0\",\"result\":{\"approved\":true,\"decision\":\"approve\",\"outcome\":{\"optionId\":\"allow_once\",\"outcome\":\"selected\"}}}\n"
        );
    }
