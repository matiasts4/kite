    use super::*;
    use std::path::{Path, PathBuf};
    use std::time::Duration;
    use serde_json::{json, Value};
    use crate::chat::drivers::declaration;
    use crate::chat::runtime::MAX_NOTICE_CHARS;
    use crate::chat::session::{SessionMode, SessionTransport, TransportEvent, TransportSpec};

    fn controls(
        model: Option<&str>,
        effort: Option<&str>,
        permission_mode: Option<&str>,
    ) -> PersistentControls {
        PersistentControls {
            model: model.map(str::to_string),
            effort: effort.map(str::to_string),
            permission_mode: permission_mode.map(str::to_string),
        }
    }

    fn spec(driver: &str) -> TransportSpec {
        TransportSpec {
            session_id: "thread-1:1".to_string(),
            driver: driver.to_string(),
            working_directory: None,
            mode: SessionMode::Persistent,
            recipe_revision: Some("r1".to_string()),
            resume_handle: None,
            extra_env: Vec::new(),
        }
    }

    #[test]
    fn the_wire_is_the_observed_stream_json_pair() {
        let declared = declaration("antigravity").expect("antigravity declaration");
        let args = antigravity_args(&declared, &PersistentControls::default(), None);

        assert_eq!(
            args,
            vec![
                "--input-format".to_string(),
                "stream-json".to_string(),
                "--output-format".to_string(),
                "stream-json".to_string(),
            ]
        );
    }

    #[test]
    fn controls_reach_the_wire_only_when_the_declaration_accepts_them() {
        let declared = declaration("antigravity").expect("antigravity declaration");
        let args = antigravity_args(
            &declared,
            &controls(Some("gemini-4-argon"), Some("high"), Some("fullAccess")),
            None,
        );
        assert!(args.windows(2).any(|pair| pair == ["--model", "gemini-4-argon"]));
        assert!(args.windows(2).any(|pair| pair == ["--effort", "high"]));
        assert!(args.iter().any(|arg| arg == "--dangerously-skip-permissions"));

        let mut closed = declared.clone();
        closed.accepts_model = false;
        closed.accepts_effort = false;
        closed.accepts_permission = false;
        closed.work_modes.clear();
        let args = antigravity_args(
            &closed,
            &controls(Some("gemini-4-argon"), Some("high"), Some("fullAccess")),
            None,
        );
        for flag in ["--model", "--effort", "--mode", "--dangerously-skip-permissions"] {
            assert!(!args.iter().any(|arg| arg == flag), "{flag} must be omitted");
        }
    }

    #[test]
    fn declared_work_modes_map_to_the_observed_mode_flag() {
        let declared = declaration("antigravity").expect("antigravity declaration");

        let read_only = antigravity_args(&declared, &controls(None, None, Some("readOnly")), None);
        assert!(read_only.windows(2).any(|pair| pair == ["--mode", "plan"]));
        assert!(read_only.iter().any(|arg| arg == "--dangerously-skip-permissions"));

        let edits = antigravity_args(&declared, &controls(None, None, Some("acceptEdits")), None);
        assert!(edits.windows(2).any(|pair| pair == ["--mode", "accept-edits"]));
        assert!(edits.iter().any(|arg| arg == "--dangerously-skip-permissions"));

        let unknown = antigravity_args(&declared, &controls(None, None, Some("somethingElse")), None);
        assert!(!unknown.iter().any(|arg| arg == "--mode"));
        assert!(!unknown.iter().any(|arg| arg == "--dangerously-skip-permissions"));
    }

    #[test]
    fn a_resume_handle_is_passed_only_when_the_declaration_accepts_it() {
        let declared = declaration("antigravity").expect("antigravity declaration");
        let args = antigravity_args(&declared, &PersistentControls::default(), Some("conversation-1"));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--conversation", "conversation-1"]));

        let mut closed = declared;
        closed.accepts_resume = false;
        let args = antigravity_args(&closed, &PersistentControls::default(), Some("conversation-1"));
        assert!(!args.iter().any(|arg| arg == "--conversation"));
    }

    #[test]
    fn one_turn_is_one_ndjson_user_line() {
        let line = turn_line("first line\nsecond line");

        assert!(line.ends_with('\n'));
        assert_eq!(line.matches('\n').count(), 1, "a prompt stays one frame");
        let value: Value = serde_json::from_str(line.trim_end()).expect("one JSON object");
        assert_eq!(value.get("event").and_then(Value::as_str), Some("user"));
        assert_eq!(
            value.pointer("/message/content").and_then(Value::as_str),
            Some("first line\nsecond line")
        );
    }

    #[test]
    fn stream_frames_become_text_notice_and_turn_end() {
        let text = parse_antigravity_line(
            r#"{"event":"step_update","step_update":{"step_type":"agent_response","text_delta":"hello"}}"#,
        );
        assert_eq!(text.events, vec![TransportEvent::Text("hello".to_string())]);

        let init = parse_antigravity_line(r#"{"event":"init","init":{"conversation_id":"conv-1"}}"#);
        assert_eq!(init.conversation_id.as_deref(), Some("conv-1"));
        assert!(init.events.is_empty());

        let success = parse_antigravity_line(r#"{"event":"result","result":{"status":"SUCCESS"}}"#);
        assert_eq!(success.events, vec![TransportEvent::TurnEnded]);

        let failed = parse_antigravity_line(r#"{"event":"result","result":{"status":"ERROR"}}"#);
        assert!(matches!(failed.events.first(), Some(TransportEvent::Notice(_))));
        assert_eq!(failed.events.last(), Some(&TransportEvent::TurnEnded));
    }

    #[test]
    fn unknown_frames_are_bounded_notices_with_provider_and_schema() {
        let huge = format!(
            r#"{{"event":"unheard_of","payload":"{}"}}"#,
            "x".repeat(MAX_NOTICE_CHARS * 2)
        );
        let parsed = parse_antigravity_line(&huge);
        let Some(TransportEvent::Notice(notice)) = parsed.events.first() else {
            panic!("an unknown frame must be a notice");
        };
        assert!(notice.contains("antigravity"));
        assert!(notice.contains("unheard_of"));
        assert!(notice.contains("schema="));
        assert!(notice.chars().count() <= MAX_NOTICE_CHARS);

        let non_json = parse_antigravity_line(&"y".repeat(MAX_NOTICE_CHARS + 100));
        let Some(TransportEvent::Notice(notice)) = non_json.events.first() else {
            panic!("a non-JSON line must be a notice");
        };
        assert!(notice.contains("non-json"));
        assert!(notice.chars().count() <= MAX_NOTICE_CHARS);
    }

    #[test]
    fn a_missing_binary_fails_before_a_process_starts() {
        let mut session = AntigravitySession::with_program(
            PersistentControls::default(),
            Some(PathBuf::from("kite-missing-agy-binary")),
        );

        let error = session.spawn(&spec("antigravity")).expect_err("no binary, no session");

        assert!(
            error.contains("kite-missing-agy-binary"),
            "the failure must name the missing program: {error}"
        );
        assert_eq!(session.spawn_count(), 0);
        assert!(session.drain().is_empty());
    }

    #[test]
    fn the_implemented_wires_are_antigravity_and_opencode() {
        assert!(has_persistent_wire("antigravity"));
        assert!(has_persistent_wire("agy"));
        assert!(has_persistent_wire("opencode"));
        assert!(has_persistent_wire("grok"));
        for driver in ["codex", "claude", "gemini", "cursor", "unknown"] {
            assert!(!has_persistent_wire(driver), "{driver} has no implemented wire");
        }
    }

    #[test]
    fn codex_records_the_documented_app_server_command_and_refuses_it() {
        assert_eq!(CODEX_APP_SERVER_ARGS, ["app-server", "--listen", "stdio://"]);

        let refusal = unsupported_wire("codex").expect("codex must be refused");
        assert!(refusal.starts_with("Unsupported:"), "{refusal}");
        assert!(refusal.contains("app-server"), "{refusal}");
        assert!(refusal.contains("request frame"), "{refusal}");
        assert!(unsupported_wire("antigravity").is_none());
        assert!(unsupported_wire("opencode").is_none());
    }

    #[test]
    fn opencode_serve_uses_the_documented_flags() {
        assert_eq!(
            opencode_serve_args(45871),
            vec![
                "serve".to_string(),
                "--hostname".to_string(),
                "127.0.0.1".to_string(),
                "--port".to_string(),
                "45871".to_string(),
            ]
        );
        assert_eq!(opencode_server_url(45871), "http://127.0.0.1:45871");
    }

    #[test]
    fn an_opencode_turn_is_one_documented_client_invocation() {
        assert_eq!(
            opencode_turn_args(45871, "thread-1:1", "hello"),
            vec![
                "run".to_string(),
                "--server".to_string(),
                "http://127.0.0.1:45871".to_string(),
                "--session".to_string(),
                "thread-1:1".to_string(),
                "hello".to_string(),
            ]
        );
        // `--prompt` is a top-level flag, not a `run` flag, so a turn never
        // forwards it.
        assert!(!opencode_turn_args(45871, "thread-1:1", "hello")
            .iter()
            .any(|arg| arg == "--prompt"));
    }

    #[test]
    fn an_opencode_turn_sends_the_chosen_level_as_the_model_variant() {
        let model = opencode_model_arg("xai/grok-4.7", Some("ultra"));
        assert_eq!(
            opencode_turn_args_with_model(45871, "thread-1:1", "hello", Some(&model)),
            vec![
                "run".to_string(),
                "--server".to_string(),
                "http://127.0.0.1:45871".to_string(),
                "--session".to_string(),
                "thread-1:1".to_string(),
                "--model".to_string(),
                "xai/grok-4.7#ultra".to_string(),
                "hello".to_string(),
            ]
        );
        assert_eq!(
            opencode_model_arg("xai/grok-4.7#low", Some("high")),
            "xai/grok-4.7#high"
        );
    }

    #[test]
    fn opencode_output_is_text_and_no_frame_is_invented() {
        assert_eq!(
            opencode_line_event("hello there"),
            Some(TransportEvent::Text("hello there".to_string()))
        );
        assert_eq!(opencode_line_event("   "), None);
        assert_eq!(
            opencode_line_event(r#"{"kind":"unheard_of"}"#),
            Some(TransportEvent::Text(r#"{"kind":"unheard_of"}"#.to_string()))
        );
    }

    #[derive(Debug, Clone)]
    struct FakeProbe {
        raw: Result<String, String>,
    }

    impl crate::chat::drivers::DriverProbe for FakeProbe {
        fn probe(
            &self,
            _driver: &str,
            _program: &Path,
            _evidence: &crate::chat::drivers::DriverVersion,
        ) -> Result<String, String> {
            self.raw.clone()
        }
    }

    fn fake_probe(raw: Result<&str, &str>) -> Box<dyn crate::chat::drivers::DriverProbe> {
        Box::new(FakeProbe {
            raw: raw.map(str::to_string).map_err(str::to_string),
        })
    }

    #[test]
    fn a_version_mismatch_fails_before_any_process_starts() {
        let mut session = AntigravitySession::with_probe(
            PersistentControls::default(),
            Some(PathBuf::from("kite-fake-agy")),
            fake_probe(Ok("agy 1.0.0")),
        );

        let error = session.spawn(&spec("antigravity")).expect_err("stale version");

        assert!(error.contains("older than the minimum"), "{error}");
        assert!(error.contains("1.4.5"), "{error}");
        assert_eq!(session.spawn_count(), 0);
        assert!(session.drain().is_empty());
    }

    #[test]
    fn a_version_probe_that_cannot_run_fails_closed() {
        let mut session = OpenCodeServerSession::with_probe(
            Some(PathBuf::from("kite-fake-opencode")),
            fake_probe(Err("could not run the opencode version probe")),
        );

        let error = session.spawn(&spec("opencode")).expect_err("probe failed");

        assert!(error.contains("version probe"), "{error}");
        assert_eq!(session.spawn_count(), 0);
        assert!(session.drain().is_empty());
    }

    #[test]
    fn a_documented_version_does_not_prove_the_binary_exists() {
        let mut session = OpenCodeServerSession::with_probe(
            Some(PathBuf::from("kite-missing-opencode-binary")),
            fake_probe(Ok("opencode v2.1.4")),
        );

        let error = session.spawn(&spec("opencode")).expect_err("no binary, no server");

        assert!(error.contains("could not start the opencode server"), "{error}");
        assert_eq!(session.spawn_count(), 0);
    }

    #[test]
    fn the_handshake_requires_an_accepting_server() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("test listener");
        let port = listener.local_addr().expect("test address").port();

        wait_for_server(port, Duration::from_millis(500)).expect("a bound listener is ready");
        drop(listener);

        let error = wait_for_server(port, Duration::from_millis(150))
            .expect_err("no listener must fail the handshake");
        assert!(error.contains("127.0.0.1"), "{error}");
        assert!(error.contains("150 ms"), "{error}");
    }

    fn grok_spec(thread_id: &str) -> crate::chat::session::SessionSpec {
        crate::chat::session::SessionSpec {
            thread_id: thread_id.to_string(),
            driver: "grok".to_string(),
            connection_id: None,
            working_directory: Some("C:\\work".to_string()),
            mode: SessionMode::Persistent,
            recipe: None,
            resume_handle: None,
            extra_env: Vec::new(),
        }
    }

    fn method_of(line: &str) -> String {
        serde_json::from_str::<Value>(line)
            .ok()
            .and_then(|value| value.get("method").and_then(Value::as_str).map(str::to_string))
            .unwrap_or_default()
    }

    #[test]
    fn a_second_send_on_the_same_grok_thread_does_not_spawn_a_second_process() {
        let (session, record) = GrokSession::recorded(controls(
            Some("grok-4.7"),
            Some("high"),
            Some("acceptEdits"),
        ));
        let mut manager = crate::chat::session::SessionManager::new();

        crate::chat::runtime::managed_send(
            &mut manager,
            grok_spec("thread-1"),
            Box::new(session),
            "command-1",
            "first",
        )
        .expect("first grok send");
        crate::chat::runtime::managed_send(
            &mut manager,
            grok_spec("thread-1"),
            Box::new(GrokSession::recorded(controls(None, None, Some("acceptEdits"))).0),
            "command-2",
            "second",
        )
        .expect("second grok send");

        assert_eq!(record.spawn_count(), 1, "one process for the thread");
        let prompts: Vec<String> = record
            .written()
            .iter()
            .filter(|line| method_of(line) == "session/prompt")
            .cloned()
            .collect();
        assert_eq!(prompts.len(), 2, "both messages go to the same process");
        assert!(prompts[0].contains("first"), "{}", prompts[0]);
        assert!(prompts[1].contains("second"), "{}", prompts[1]);
        assert_eq!(
            record.args(),
            vec![
                "--permission-mode".to_string(),
                "default".to_string(),
                "agent".to_string(),
                "stdio".to_string(),
            ]
        );
    }

    #[test]
    fn grok_sets_model_and_effort_on_the_session_before_the_message() {
        let controls = controls(Some("grok-4.7"), Some("high"), Some("fullAccess"));
        let (mut session, record) = GrokSession::recorded(controls);
        session.spawn(&spec("grok")).expect("recorded session");
        session.write_turn("hello").expect("turn");

        let written = record.written();
        let methods: Vec<String> = written.iter().map(|line| method_of(line)).collect();
        assert_eq!(
            methods,
            vec![
                "session/set_config_option".to_string(),
                "session/set_config_option".to_string(),
                "session/prompt".to_string(),
            ]
        );
        let model_at = written
            .iter()
            .position(|line| line.contains("\"configId\":\"model\""))
            .expect("model is set on the session");
        let effort_at = written
            .iter()
            .position(|line| line.contains("\"configId\":\"reasoning_effort\""))
            .expect("effort is set on the session");
        let prompt_at = written
            .iter()
            .position(|line| line.contains("\"method\":\"session/prompt\""))
            .expect("prompt");
        assert!(model_at < prompt_at, "model is set before the message");
        assert!(effort_at < prompt_at, "effort is set before the message");
        assert!(written[model_at].contains("grok-4.7"), "{}", written[model_at]);
        assert!(written[effort_at].contains("high"), "{}", written[effort_at]);
        assert!(written[prompt_at].contains("hello"), "{}", written[prompt_at]);
        assert!(!written.iter().any(|line| line.contains("--effort")));
    }

    #[test]
    fn grok_accept_edits_runs_as_supervised_not_auto_accept() {
        let args = grok_session_args(Some("acceptEdits"));
        assert_eq!(
            args,
            vec![
                "--permission-mode".to_string(),
                "default".to_string(),
                "agent".to_string(),
                "stdio".to_string(),
            ]
        );
        assert!(!args.iter().any(|arg| arg == "acceptEdits"));
        assert!(!args.iter().any(|arg| arg == "--always-approve"));
        assert!(!args.iter().any(|arg| arg == "auto"));
        assert_eq!(grok_permission_mode(Some("acceptEdits")), "default");

        let full = grok_session_args(Some("fullAccess"));
        assert_eq!(full[0], "--permission-mode");
        assert_eq!(full[1], "bypassPermissions");
        assert_eq!(&full[2..], ["agent".to_string(), "stdio".to_string()]);
    }

    #[test]
    fn an_unknown_grok_frame_stays_a_notice() {
        let parsed = parse_grok_line(
            r#"{"jsonrpc":"2.0","method":"x.ai/fs/index","params":{"chunk":0}}"#,
            None,
        );
        let Some(TransportEvent::Notice(notice)) = parsed.events.first() else {
            panic!("a missing frame must stay a notice, got {:?}", parsed.events);
        };
        assert!(notice.contains("grok"));
        assert!(notice.contains("schema="));
        assert!(notice.chars().count() <= MAX_NOTICE_CHARS);
        assert!(!notice.contains("invented"));

        let text = parse_grok_line(
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hello"}}}}"#,
            None,
        );
        assert_eq!(text.events, vec![TransportEvent::Text("hello".to_string())]);
    }

    #[test]
    fn a_grok_tool_update_is_an_action_not_a_notice() {
        let line = r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call_update","toolCallId":"call-1","title":"Read odd/tasks/response-thread.md","kind":"read","status":"in_progress","rawInput":{"path":"odd/tasks/response-thread.md"}}}}"#;
        let parsed = parse_grok_line(line, None);
        let Some(TransportEvent::Activity(raw)) = parsed.events.first() else {
            panic!("a tool update must stay an action, got {:?}", parsed.events);
        };
        assert!(raw.contains("tool_call_update"));
        let event = crate::acp::parse_acp_stream_line("thread-1", "run-1", raw)
            .expect("the transcript builder must recognize the tool update");
        match event {
            crate::acp::AcpStreamEvent::ToolUpdate { tool } => {
                assert_eq!(tool.id, "call-1");
                assert!(tool.title.contains("response-thread.md") || tool.name.contains("response-thread.md"));
                assert_eq!(tool.status, "running");
            }
            other => panic!("expected a tool row, got {other:?}"),
        }
    }

    #[test]
    fn a_question_reaches_the_pipeline_and_an_unknown_request_is_answered() {
        let question = r#"{"jsonrpc":"2.0","id":"q-1","method":"x.ai/ask_user_question","params":{"questions":[{"id":"color","header":"Color"}]}}"#;
        let parsed = parse_grok_line(question, None);
        assert!(matches!(parsed.events.first(), Some(TransportEvent::Activity(raw)) if raw.contains("ask_user_question")));

        let plan = r#"{"jsonrpc":"2.0","id":7,"method":"x.ai/exit_plan_mode","params":{"title":"Ship it"}}"#;
        let parsed = parse_grok_line(plan, None);
        assert!(matches!(parsed.events.first(), Some(TransportEvent::Activity(raw)) if raw.contains("exit_plan_mode")));

        let unknown = r#"{"jsonrpc":"2.0","id":4,"method":"x.ai/fs/index","params":{"chunk":0}}"#;
        let parsed = parse_grok_line(unknown, None);
        assert_eq!(
            parsed.events,
            vec![TransportEvent::UnhandledRequest { id: "4".to_string() }]
        );
        let reply = unhandled_request_reply("4");
        assert!(reply.contains("\"id\":4"));
        assert!(reply.contains("-32601"));
        assert!(plan_request_ack("7").contains("\"result\":{}"));
    }

    #[test]
    fn the_grok_session_does_not_set_a_referrer() {
        let overrides = grok_session_env_overrides();
        assert!(overrides.is_empty());
        assert!(!overrides
            .iter()
            .any(|(key, _)| *key == "GROK_OAUTH2_REFERRER"));
        let joined = grok_session_args(Some("acceptEdits")).join(" ");
        assert!(!joined.contains("GROK_OAUTH2_REFERRER"));
        let init = grok_initialize_line(1);
        assert!(!init.contains("_meta"));
        assert!(!init.contains("yoloMode"));
        assert!(!init.contains("readTextFile"));
        assert!(!init.contains("writeTextFile"));
        assert!(!init.contains("\"terminal\":true"));
        let created = grok_session_new_line(2, ".");
        assert!(created.contains("session/new"));
        assert!(!created.contains("yoloMode"));
        assert!(!created.contains("_meta"));
    }

    #[test]
    fn xai_session_update_completes_the_turn_and_filters_housekeeping() {
        let completed = r#"{"jsonrpc":"2.0","method":"_x.ai/session/update","params":{"sessionId":"s-1","update":{"sessionUpdate":"turn_completed","usage":{"inputTokens":6407,"outputTokens":20,"totalTokens":28694,"cachedReadTokens":22267}}}}"#;
        let parsed = parse_grok_line(completed, None);
        assert_eq!(parsed.conversation_id.as_deref(), Some("s-1"));
        assert!(matches!(parsed.events.first(), Some(TransportEvent::Activity(_))));
        assert_eq!(parsed.events.last(), Some(&TransportEvent::TurnEnded));

        for housekeeping in [
            "available_commands_update",
            "session_info_update",
            "hook_execution",
            "config_option_update",
            "current_mode_update",
        ] {
            let line = format!(
                r#"{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"s-1","update":{{"sessionUpdate":"{housekeeping}"}}}}}}"#
            );
            let parsed = parse_grok_line(&line, None);
            assert!(
                parsed.events.is_empty(),
                "housekeeping `{housekeeping}` must not become a notice: {:?}",
                parsed.events
            );
        }
    }

    #[test]
    fn opencode_structured_tool_frames_become_activity() {
        let tool_line = r#"{"type":"tool_call","id":"call-1","name":"read_file","input":{"path":"README.md"}}"#;
        assert_eq!(
            opencode_line_event(tool_line),
            Some(TransportEvent::Activity(tool_line.to_string()))
        );
    }
