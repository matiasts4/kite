    use super::*;
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex};
    use crate::connections::EndpointVerification;
    use crate::chat::drivers::declaration;
    use crate::chat::persistent::PersistentControls;
    use crate::persist::{notifications, persist, threads, workspace_path};
    use crate::chat::session::{
        declared_session_mode, RecipeSnapshot, SendReceipt, SessionManager, SessionMode, SessionSpec,
    };
    use crate::chat::utils::{chat_log, clip_argv, now_ms, resolve_bin};
    use serde_json::{json, Value};

    const OPENCODE_GO_CHAT: &str =
        "https://opencode.ai/inference/go/openai/v1/chat/completions";

    #[test]
    fn a_headless_permission_denial_names_the_tool_and_ignores_a_long_answer() {
        let denial = "jetski: no output produced — a tool required the \"mcp\" permission that headless mode cannot prompt for, so it was auto-denied.";
        assert_eq!(headless_permission_denial(denial).as_deref(), Some("mcp"));
        let quoted = format!("The log said: {denial} and then the model kept writing. {}", "x".repeat(800));
        assert_eq!(headless_permission_denial(&quoted), None);
        assert_eq!(headless_permission_denial("the tool finished"), None);
    }

    struct HeadlessProbe {
        thread_id: &'static str,
        run_id: &'static str,
    }

    impl Drop for HeadlessProbe {
        fn drop(&mut self) {
            {
                let mut live = live_turns().lock().unwrap();
                live.runs.remove(self.run_id);
                live.by_thread.remove(self.thread_id);
            }
            crate::chat::remove_thread(self.thread_id);
        }
    }

    #[test]
    fn a_headless_denial_stays_waiting_when_the_process_exits() {
        let probe = HeadlessProbe {
            thread_id: "headless-perm-thread",
            run_id: "headless-perm-run",
        };
        {
            let mut items = threads().lock().unwrap();
            items.retain(|thread| thread.get("id").and_then(|v| v.as_str()) != Some(probe.thread_id));
            items.push(json!({
                "id": probe.thread_id,
                "status": "waiting",
                "title": "Probe",
                "provider": "grok",
                "pendingApproval": {
                    "id": "perm_headless-perm-run_headless",
                    "toolName": "mcp",
                    "status": "pending"
                },
                "items": []
            }));
        }
        {
            let mut live = live_turns().lock().unwrap();
            live.runs.insert(probe.run_id.to_string(), TurnRun {
                revision: "rev".into(),
                events: Vec::new(),
                next_sequence: 0,
                assistant_id: "asst".into(),
                assistant_text: String::new(),
                child: None,
                stdin: None,
                closing: false,
                finished: false,
                started_at_ms: now_ms(),
                finished_at_ms: None,
                routine_id: None,
                delivered_through: 0,
                file_baselines: std::collections::HashMap::new(),
            });
            live.by_thread.insert(probe.thread_id.to_string(), probe.run_id.to_string());
        }

        finish_run(probe.run_id, false, false, "The provider command exited with an error.");

        let stored = threads()
            .lock()
            .unwrap()
            .iter()
            .find(|thread| thread.get("id").and_then(|v| v.as_str()) == Some(probe.thread_id))
            .cloned()
            .expect("probe thread");
        assert_eq!(stored["status"], json!("waiting"));
        assert!(stored["pendingApproval"].is_object());
        let stored_items = stored.get("items").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        assert!(stored_items.iter().all(|item| item.get("kind").and_then(|v| v.as_str()) != Some("error")));

        let live = live_turns().lock().unwrap();
        let run = live.runs.get(probe.run_id).expect("probe run");
        assert!(run.finished);
        assert!(run.events.iter().all(|event| event.get("kind").and_then(|v| v.as_str()) != Some("finished")));
        assert!(run.events.iter().any(|event| {
            event.get("kind").and_then(|v| v.as_str()) == Some("status")
                && event.get("status").and_then(|v| v.as_str()) == Some("waiting")
        }));
        assert!(run.events.iter().all(|event| {
            event
                .get("item")
                .and_then(|item| item.get("kind"))
                .and_then(|v| v.as_str())
                != Some("error")
        }));
        drop(live);

        let notices = notifications().lock().unwrap();
        assert!(notices.iter().all(|notice| {
            notice.get("runId").and_then(|v| v.as_str()) != Some(probe.run_id)
                || notice
                    .get("kind")
                    .and_then(|kind| kind.get("kind"))
                    .and_then(|v| v.as_str())
                    != Some("settled")
        }));
    }

    fn send<'a>(
        model: Option<&'a str>,
        session_id: Option<&'a str>,
        connection_id: Option<&'a str>,
        supported_endpoint: Option<&'a str>,
        verified_endpoints: &'a [EndpointVerification],
    ) -> SendValues<'a> {
        SendValues {
            connection_id,
            model,
            session_id,
            supported_endpoint,
            verified_endpoints,
            agent: None,
        }
    }

    fn model_flags(args: &[String]) -> Vec<&str> {
        args.iter().map(String::as_str).filter(|arg| *arg == "--model").collect()
    }

    #[test]
    fn spawns_without_a_supported_endpoint_omit_model_and_session() {
        for provider in ["cursor", "gemini"] {
            let values = send(Some("go-model-1"), Some("session-1"), None, None, &[]);
            let spawn = spawn_args(provider, "fullAccess", &values, None, "hello")
                .unwrap_or_else(|error| panic!("{provider} spawn args: {error}"));

            let joined = spawn.args.join(" ");
            assert!(
                model_flags(&spawn.args).is_empty(),
                "{provider} must omit --model without a supported endpoint: {joined}"
            );
            assert!(
                !spawn.args.iter().any(|arg| arg == "--conversation" || arg == "--resume" || arg == "resume"),
                "{provider} must omit session resume: {joined}"
            );
            assert!(
                !spawn.args.iter().any(|arg| arg.contains("opencode.ai")),
                "{provider} must not name a network endpoint: {joined}"
            );
        }
    }

    #[test]
    fn supported_endpoint_flag_fails_on_a_spawn_without_model_support() {
        for provider in ["cursor", "gemini"] {
            let endpoint_id = spawn_endpoint(provider)
                .unwrap_or_else(|| panic!("{provider} endpoint"))
                .endpoint_id;
            let verified = vec![EndpointVerification {
                endpoint_id: endpoint_id.to_string(),
                ok: true,
            }];
            let values = send(
                Some("go-model-1"),
                None,
                Some("connection-1"),
                Some(endpoint_id),
                &verified,
            );
            let error = spawn_args(provider, "fullAccess", &values, None, "hello")
                .expect_err("a spawn without model support must fail, not add --model");

            assert!(
                error.contains("does not support model selection"),
                "{provider}: {error}"
            );
        }
    }

    #[test]
    fn supported_endpoint_without_a_verified_connection_endpoint_fails() {
        let unverified = vec![EndpointVerification {
            endpoint_id: "agy -p".to_string(),
            ok: false,
        }];
        let values = send(
            Some("gemini-4-argon"),
            None,
            Some("antigravity:api_key:email=|org=|account="),
            Some("agy -p"),
            &unverified,
        );
        let error = spawn_args("antigravity", "fullAccess", &values, None, "hello")
            .expect_err("an endpoint that is not verified on the connection must fail");
        assert!(error.contains("is not verified for connection"), "{error}");

        let without_connection = send(Some("gemini-4-argon"), None, None, Some("agy -p"), &[]);
        let error = spawn_args("antigravity", "fullAccess", &without_connection, None, "hello")
            .expect_err("a supported endpoint needs a connection");
        assert!(error.contains("must belong to a connection"), "{error}");
    }

    #[test]
    fn verified_supported_endpoint_forwards_connection_model_and_session() {
        let connection_id = "antigravity:api_key:email=|org=|account=";
        let verified = vec![EndpointVerification {
            endpoint_id: "agy -p".to_string(),
            ok: true,
        }];
        let values = send(
            Some("gemini-4-argon"),
            Some("conversation-1"),
            Some(connection_id),
            Some("agy -p"),
            &verified,
        );

        let resolved = resolve_send("antigravity", &values).expect("supported send");
        assert_eq!(resolved.endpoint.endpoint_id, "agy -p");
        assert_eq!(resolved.connection_id, Some(connection_id));
        assert_eq!(resolved.model, Some("gemini-4-argon"));
        assert_eq!(resolved.session_id, Some("conversation-1"));

        let spawn = spawn_args("antigravity", "fullAccess", &values, None, "hello")
            .expect("spawn args");
        assert_eq!(model_flags(&spawn.args), vec!["--model"]);
        assert!(spawn.args.iter().any(|arg| arg == "gemini-4-argon"));
        assert!(spawn.args.iter().any(|arg| arg == "--conversation"));
    }

    #[test]
    fn grok_sends_the_selected_model_and_the_documented_effort_alias() {
        let values = send(Some("grok-4.7"), Some("session-1"), None, None, &[]);
        let spawn = spawn_args("grok", "acceptEdits", &values, Some("high"), "hello")
            .expect("grok args");
        assert_eq!(
            spawn.args,
            vec![
                "-p",
                "hello",
                "--permission-mode",
                "default",
                "--model",
                "grok-4.7",
                "--effort",
                "high",
            ]
        );

        let without_level = spawn_args("grok", "fullAccess", &values, None, "hello").expect("grok args");
        assert!(without_level.args.windows(2).any(|pair| pair == ["--model", "grok-4.7"]));
        assert!(!without_level.args.iter().any(|arg| arg == "--effort" || arg == "--reasoning-effort"));
    }

    #[test]
    fn opencode_sends_effort_as_the_model_variant() {
        let values = send(Some("xai/grok-4.7"), None, None, None, &[]);
        let spawn = spawn_args("opencode", "fullAccess", &values, Some("ultra"), "hello")
            .expect("opencode args");
        assert!(spawn.args.windows(2).any(|pair| pair == ["--model", "xai/grok-4.7#ultra"]));
        assert!(!spawn.args.iter().any(|arg| arg == "--effort" || arg == "--thinking"));

        let replaced = send(Some("xai/grok-4.7#low"), None, None, None, &[]);
        let spawn = spawn_args("opencode", "fullAccess", &replaced, Some("high"), "hello")
            .expect("opencode args");
        assert!(spawn.args.windows(2).any(|pair| pair == ["--model", "xai/grok-4.7#high"]));

        let bare = spawn_args("opencode", "fullAccess", &values, None, "hello").expect("opencode args");
        assert!(bare.args.windows(2).any(|pair| pair == ["--model", "xai/grok-4.7"]));
    }

    #[test]
    fn drivers_without_an_observed_effort_flag_do_not_gain_one() {
        for provider in ["claude", "codex", "cursor", "gemini"] {
            let values = send(Some("contract-model"), None, None, None, &[]);
            let spawn = spawn_args(provider, "fullAccess", &values, Some("ultra"), "hello")
                .expect("args");
            assert!(
                !spawn.args.iter().any(|arg| {
                    arg == "--effort"
                        || arg == "--reasoning-effort"
                        || arg.contains("#ultra")
                        || arg == "--thinking"
                }),
                "{provider} invented an effort flag: {}",
                spawn.args.join(" ")
            );
        }
    }

    #[test]
    fn connection_without_a_named_supported_endpoint_fails() {
        let values = send(
            Some("composer"),
            None,
            Some("cursor:api_key:email=|org=|account="),
            None,
            &[],
        );
        let error = spawn_args("cursor", "fullAccess", &values, None, "hello")
            .expect_err("a connection needs a named endpoint");
        assert!(
            error.contains("without naming the endpoint that supports it"),
            "{error}"
        );
    }

    #[test]
    fn existing_model_and_session_flags_are_preserved() {
        let agy = spawn_args(
            "antigravity",
            "readOnly",
            &send(Some("gemini-4-argon"), Some("conversation-1"), None, None, &[]),
            Some("high"),
            "hello",
        )
        .expect("antigravity args");
        assert_eq!(
            agy.args,
            vec![
                "-p",
                "Read-only mode: do not create, edit, or delete files.\n\nhello",
                "--output-format",
                "stream-json",
                "--conversation",
                "conversation-1",
                "--mode",
                "plan",
                "--model",
                "gemini-4-argon",
                "--effort",
                "high",
            ]
        );

        let agy_orch = spawn_args(
            "antigravity",
            "fullAccess",
            &send(Some("gemini-pro-orchestrator-neon"), None, None, None, &[]),
            Some("high"),
            "hello",
        )
        .expect("antigravity orchestrator args");
        assert!(
            agy_orch
                .args
                .windows(2)
                .any(|pair| pair == ["--model", "gemini-pro-orchestrator-neon"])
        );
        assert!(
            !agy_orch.args.iter().any(|arg| arg == "--effort"),
            "orchestrator model must omit --effort on one-shot spawn, got: {:?}",
            agy_orch.args
        );

        let agy_minimal = spawn_args(
            "antigravity",
            "fullAccess",
            &send(Some("gemini-4-neon"), None, None, None, &[]),
            Some("minimal"),
            "hello",
        )
        .expect("antigravity minimal args");
        assert!(
            agy_minimal
                .args
                .windows(2)
                .any(|pair| pair == ["--effort", "low"]),
            "minimal effort must normalize to low for agy CLI, got: {:?}",
            agy_minimal.args
        );

        let claude = spawn_args(
            "claude",
            "acceptEdits",
            &send(Some("sonnet"), Some("conversation-1"), None, None, &[]),
            None,
            "hello",
        )
        .expect("claude args");
        assert_eq!(
            claude.args,
            vec![
                "-p",
                "--output-format",
                "stream-json",
                "--permission-mode",
                "acceptEdits",
                "--resume",
                "conversation-1",
                "--model",
                "sonnet",
                "hello",
            ]
        );

        let codex = spawn_args(
            "codex",
            "acceptEdits",
            &send(Some("gpt-6-sol"), Some("conversation-1"), None, None, &[]),
            None,
            "hello",
        )
        .expect("codex args");
        assert_eq!(
            codex.args,
            vec![
                "exec",
                "resume",
                "conversation-1",
                "--skip-git-repo-check",
                "--dangerously-bypass-approvals-and-sandbox",
                "--model",
                "gpt-6-sol",
                "--json",
                "hello",
            ]
        );
    }

    #[test]
    fn claiming_the_go_chat_endpoint_on_a_cli_spawn_fails() {
        let verified = vec![EndpointVerification {
            endpoint_id: OPENCODE_GO_CHAT.to_string(),
            ok: true,
        }];
        let values = send(
            Some("go-model-1"),
            Some("session-1"),
            Some("opencode:api_key:email=|org=|account="),
            Some(OPENCODE_GO_CHAT),
            &verified,
        );
        let error = spawn_args("opencode", "fullAccess", &values, None, "hello")
            .expect_err("the Go chat route is not the opencode run endpoint");
        assert!(
            error.contains("is not the endpoint the opencode spawn uses"),
            "{error}"
        );
    }

    #[test]
    fn opencode_run_is_not_evidence_for_the_go_chat_endpoint() {
        let endpoint = spawn_endpoint("opencode").expect("opencode endpoint");
        assert_eq!(endpoint.endpoint_id, "opencode run");
        assert_ne!(endpoint.endpoint_id, OPENCODE_GO_CHAT);
        assert!(
            !endpoint.endpoint_id.contains("opencode.ai"),
            "a local spawn endpoint is not a network route"
        );

        let spawn = spawn_args(
            "opencode",
            "fullAccess",
            &send(None, None, None, None, &[]),
            None,
            "hello",
        )
        .expect("opencode args");
        assert_eq!(spawn.args, vec!["run", "--format", "json", "hello"]);
        assert!(!spawn.args.iter().any(|arg| arg.contains(OPENCODE_GO_CHAT)));

        let mut values_with_agent = send(None, None, None, None, &[]);
        values_with_agent.agent = Some("gentle-orchestrator");
        let spawn_agent = spawn_args(
            "opencode",
            "fullAccess",
            &values_with_agent,
            None,
            "hello",
        ).expect("opencode args with agent");
        assert_eq!(spawn_agent.args, vec!["run", "--format", "json", "--agent", "gentle-orchestrator", "hello"]);
    }

    use crate::chat::session::{ScriptedTransport, SessionState};

    fn persistent_spec(thread_id: &str) -> SessionSpec {
        SessionSpec {
            thread_id: thread_id.to_string(),
            driver: "codex".to_string(),
            connection_id: None,
            working_directory: None,
            mode: SessionMode::Persistent,
            recipe: None,
            resume_handle: None,
            extra_env: Vec::new(),
        }
    }

    #[test]
    fn the_persistent_route_requires_a_persistent_declaration_and_the_flag() {
        for driver in ["antigravity", "agy", "opencode", "grok"] {
            assert_eq!(send_route(driver, true), SendRoute::Persistent, "{driver}");
            assert_eq!(send_route(driver, false), SendRoute::OneShot, "{driver}");
        }
        for driver in ["codex", "gemini", "cursor", "claude", "not-a-driver"] {
            assert_eq!(send_route(driver, true), SendRoute::OneShot, "{driver}");
            assert_eq!(send_route(driver, false), SendRoute::OneShot, "{driver}");
        }
    }

    #[test]
    fn sessions_stay_on_unless_the_gate_is_exactly_zero() {
        assert!(sessions_enabled_from(None));
        assert!(sessions_enabled_from(Some("1")));
        assert!(sessions_enabled_from(Some("")));
        assert!(!sessions_enabled_from(Some("0")));
    }

    #[test]
    fn operational_notices_stay_bounded() {
        let long = "é".repeat(MAX_NOTICE_CHARS + 250);
        let notice = bounded_notice(&long);

        assert_eq!(notice.chars().count(), MAX_NOTICE_CHARS);
        assert!(!notice.contains('\u{0}'));
    }

    #[test]
    fn a_managed_send_that_never_started_keeps_the_prompt_for_the_one_shot_path() {
        let mut manager = SessionManager::new();
        let transport = ScriptedTransport::new().failing_spawn("no lasting wire");

        let error = managed_send(
            &mut manager,
            persistent_spec("thread-1"),
            Box::new(transport),
            "command-1",
            "keep this prompt",
        )
        .unwrap_err();

        assert!(error.before_turn());
        assert!(error.reason().contains("no lasting wire"));
        assert_eq!(
            manager.status("thread-1").map(|record| record.state),
            Some(SessionState::Failed)
        );
    }

    #[test]
    fn a_managed_send_writes_only_the_new_message_to_one_session() {
        let mut manager = SessionManager::new();
        let transport = ScriptedTransport::new();
        let probe = transport.clone();

        managed_send(
            &mut manager,
            persistent_spec("thread-1"),
            Box::new(transport),
            "command-1",
            "first",
        )
        .expect("first managed send");
        managed_send(
            &mut manager,
            persistent_spec("thread-1"),
            Box::new(ScriptedTransport::new()),
            "command-2",
            "second",
        )
        .expect("second managed send");

        assert_eq!(probe.written_turns(), vec!["first".to_string(), "second".to_string()]);
        assert_eq!(probe.spawn_count(), 1);
    }

    #[test]
    fn the_manager_route_rejects_a_non_persistent_mode() {
        let mut manager = SessionManager::new();
        let mut spec = persistent_spec("thread-1");
        spec.mode = SessionMode::Resumable;

        let error = managed_send(
            &mut manager,
            spec,
            Box::new(ScriptedTransport::new()),
            "command-1",
            "hello",
        )
        .unwrap_err();

        assert!(error.before_turn());
        assert!(manager.status("thread-1").is_none());
    }

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "kite-runtime-{label}-{}-{nanos}",
                std::process::id()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn agent_recipe() -> RecipeSnapshot {
        RecipeSnapshot {
            agent_id: "agent-1".to_string(),
            revision: "r1".to_string(),
            role: "Ordered role.".to_string(),
            memory: "memory".to_string(),
            user: "user".to_string(),
            skills: vec!["root-cause".to_string()],
        }
    }

    #[test]
    fn the_recipe_is_written_before_the_session_starts() {
        let dir = TempDir::new("recipe-order");
        let recipe = agent_recipe();
        let mut spec = persistent_spec("thread-1");
        spec.recipe = Some(recipe.clone());
        let transport = ScriptedTransport::new();
        let probe = transport.clone();
        let observer = transport.clone();
        let spawns_at_prepare = Arc::new(Mutex::new(None));
        let observed = spawns_at_prepare.clone();
        let target = dir.path().to_path_buf();
        let for_prepare = recipe.clone();
        let mut manager = SessionManager::new();

        managed_send_prepared(
            &mut manager,
            spec,
            Box::new(transport),
            "command-1",
            "hello",
            move || {
                *observed.lock().unwrap() = Some(observer.spawn_count());
                apply_agent_recipe(&target, Some(&for_prepare)).map(|_| ())
            },
        )
        .expect("prepared send");

        assert_eq!(*spawns_at_prepare.lock().unwrap(), Some(0));
        let agents = std::fs::read_to_string(dir.path().join("AGENTS.md")).expect("recipe written");
        assert!(agents.contains("Ordered role."));
        assert_eq!(
            probe.spawned_specs()[0].recipe_revision.as_deref(),
            Some("r1")
        );
    }

    #[test]
    fn a_loose_chat_writes_no_recipe_before_the_session_starts() {
        let dir = TempDir::new("loose-chat");

        assert_eq!(apply_agent_recipe(dir.path(), None), Ok(false));
        assert!(!dir.path().join("AGENTS.md").exists());
        assert!(!dir.path().join("CLAUDE.md").exists());
    }

    #[test]
    fn a_live_session_does_not_start_another_process() {
        assert!(starts_new_session(None));
        assert!(!starts_new_session(Some(SessionState::Running)));
        assert!(!starts_new_session(Some(SessionState::Waiting)));
        assert!(!starts_new_session(Some(SessionState::Completed)));
        assert!(!starts_new_session(Some(SessionState::Idle)));
        assert!(!starts_new_session(Some(SessionState::Resurrecting)));
        assert!(starts_new_session(Some(SessionState::Closed)));
        assert!(starts_new_session(Some(SessionState::Failed)));
        assert!(starts_new_session(Some(SessionState::Interrupted)));
        assert!(starts_new_session(Some(SessionState::Resumable)));
        assert!(starts_new_session(Some(SessionState::Reaped)));
    }

    #[test]
    fn a_preparation_failure_starts_nothing_and_is_not_replayed() {
        let transport = ScriptedTransport::new();
        let probe = transport.clone();
        let mut manager = SessionManager::new();

        let error = managed_send_prepared(
            &mut manager,
            persistent_spec("thread-1"),
            Box::new(transport),
            "command-1",
            "keep this prompt",
            || Err("recipe could not be written".to_string()),
        )
        .unwrap_err();

        assert_eq!(
            error,
            ManagedSendError::Prepare("recipe could not be written".to_string())
        );
        assert!(!error.before_turn());
        assert_eq!(probe.spawn_count(), 0);
        assert!(manager.status("thread-1").is_none());
    }

    #[test]
    fn one_shot_notices_follow_the_driver_declaration() {
        for driver in ["gemini", "cursor"] {
            let notice = one_shot_notice(driver, true).expect("resumable notice");
            assert!(notice.contains("provider-issued id"), "{driver}: {notice}");
            assert!(
                notice.chars().count() <= MAX_NOTICE_CHARS,
                "{driver} notice must stay bounded"
            );
        }

        let claude = one_shot_notice("claude", true).expect("unobserved notice");
        assert!(claude.contains("could not be observed"), "{claude}");

        let disabled = one_shot_notice("antigravity", false).expect("disabled notice");
        assert!(disabled.contains("Persistent sessions are off"), "{disabled}");
        assert!(one_shot_notice("antigravity", true).is_none());
        assert!(one_shot_notice("codex", true).is_none());
        assert!(one_shot_notice("opencode", true).is_none());
        assert!(one_shot_notice("grok", true).is_none());
        assert!(one_shot_notice("not-a-driver", true).is_none());
    }

    #[test]
    fn transport_selection_follows_the_declaration_and_wire() {
        let antigravity = select_persistent_transport("antigravity", PersistentControls::default())
            .expect("antigravity transport");
        assert_eq!(antigravity.kind, TransportKind::Antigravity);
        assert_eq!(antigravity.driver, "antigravity");
        assert_eq!(antigravity.version.minimum.to_string(), "1.4.5");

        let opencode = select_persistent_transport("opencode", PersistentControls::default())
            .expect("opencode transport");
        assert_eq!(opencode.kind, TransportKind::OpenCodeServer);
        assert_eq!(opencode.version.minimum.to_string(), "2.1.4");

        let grok = select_persistent_transport("grok", PersistentControls::default())
            .expect("grok transport");
        assert_eq!(grok.kind, TransportKind::GrokAgent);
        assert_eq!(grok.driver, "grok");
        assert_eq!(grok.version.minimum.to_string(), "1.0.77");

        let codex = select_persistent_transport("codex", PersistentControls::default())
            .expect_err("codex documents no turn frame");
        assert!(codex.contains("Unsupported"), "{codex}");
        assert!(codex.contains("app-server"), "{codex}");

        for driver in ["claude", "gemini", "cursor"] {
            let error = select_persistent_transport(driver, PersistentControls::default())
                .expect_err("no lasting wire");
            assert!(error.contains("Unsupported"), "{driver}: {error}");
        }

        let unknown = select_persistent_transport("not-a-driver", PersistentControls::default())
            .expect_err("unknown driver");
        assert!(unknown.contains("no driver declaration"), "{unknown}");
    }

    #[test]
    fn an_unsupported_wire_keeps_the_prompt_and_attaches_nothing() {
        let mut manager = SessionManager::new();

        let outcome = match select_persistent_transport("codex", PersistentControls::default()) {
            Ok(selected) => managed_send_prepared(
                &mut manager,
                persistent_spec("thread-1"),
                selected.transport,
                "command-1",
                "keep this prompt",
                || Ok(()),
            ),
            Err(reason) => Err(ManagedSendError::Start(reason)),
        };

        let error = outcome.expect_err("the codex wire is refused");
        assert!(error.before_turn());
        assert!(error.reason().contains("app-server"), "{error:?}");
        assert!(manager.status("thread-1").is_none());
        assert_eq!(manager.active_thread_count(), 0);
    }

    #[test]
    fn a_fallback_notice_is_bounded_and_names_the_reason() {
        let reason = "Unsupported: codex: `codex app-server --help` documents the stdio transport";
        let notice = persistent_fallback_notice("codex", reason);

        assert!(notice.starts_with("Persistent sessions are enabled"), "{notice}");
        assert!(notice.contains("codex"), "{notice}");
        assert!(notice.contains("app-server"), "{notice}");
        assert!(notice.contains("This turn runs as one command."), "{notice}");
        assert!(notice.chars().count() <= MAX_NOTICE_CHARS);
    }

    #[test]
    fn a_version_mismatch_becomes_a_bounded_fallback_notice() {
        let evidence = declaration("antigravity")
            .expect("antigravity declaration")
            .version
            .expect("antigravity version evidence");
        let reason = crate::chat::drivers::evaluate_version("agy 1.0.0", &evidence)
            .expect_err("1.0.0 is older than 1.4.5");
        let notice = persistent_fallback_notice(
            "antigravity",
            &format!("antigravity version check failed: {reason}"),
        );

        assert!(notice.contains("1.0.0"), "{notice}");
        assert!(notice.contains("1.4.5"), "{notice}");
        assert!(notice.chars().count() <= MAX_NOTICE_CHARS);
    }

    #[test]
    fn a_started_turn_is_never_replayed_as_a_second_command() {
        let mut manager = SessionManager::new();
        let transport = ScriptedTransport::new().failing_write("the provider refused the message");

        let error = managed_send(
            &mut manager,
            persistent_spec("thread-1"),
            Box::new(transport),
            "command-1",
            "only once",
        )
        .unwrap_err();

        assert!(!error.before_turn(), "a started turn must not fall back");
        assert!(error.reason().contains("refused"), "{error:?}");
        assert_eq!(
            manager.status("thread-1").map(|record| record.state),
            Some(SessionState::Running)
        );
    }

    #[test]
    fn sync_thread_provider_session_id_updates_thread_record() {
        let thread_id = "test-sync-provider-session-thread";
        {
            let mut items = threads().lock().unwrap();
            items.retain(|t| t.get("id").and_then(|v| v.as_str()) != Some(thread_id));
            items.push(json!({
                "id": thread_id,
                "title": "Test Sync",
                "provider": "antigravity",
                "providerSessionId": Value::Null,
                "items": [],
            }));
        }

        sync_thread_provider_session_id(thread_id, Some("provider-session-xyz"));

        {
            let items = threads().lock().unwrap();
            let thread = items
                .iter()
                .find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id))
                .expect("thread found");
            assert_eq!(
                thread.get("providerSessionId").and_then(|v| v.as_str()),
                Some("provider-session-xyz")
            );
        }

        sync_thread_provider_session_id(thread_id, None);
        sync_thread_provider_session_id(thread_id, Some("   "));
        {
            let items = threads().lock().unwrap();
            let thread = items
                .iter()
                .find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id))
                .expect("thread found");
            assert_eq!(
                thread.get("providerSessionId").and_then(|v| v.as_str()),
                Some("provider-session-xyz")
            );
        }

        let mut items = threads().lock().unwrap();
        items.retain(|t| t.get("id").and_then(|v| v.as_str()) != Some(thread_id));
    }

    #[test]
    fn compose_thread_dispatch_env_injects_dispatch_address_workspace_skill_and_bin_path() {
        let with_ws = compose_thread_dispatch_env(
            "thread-abc-123",
            Some("ws-xyz"),
            std::path::Path::new("C:/Kite/skills/kite-dispatch/SKILL.md"),
            std::path::Path::new("C:/Kite/bin"),
            Some(std::path::Path::new("C:/Tools/agy/agy.exe")),
            "C:\\Windows\\System32",
        );
        let map: std::collections::HashMap<String, String> = with_ws.into_iter().collect();
        assert_eq!(map.get("KITE_DISPATCH").map(String::as_str), Some("1"));
        assert_eq!(
            map.get("KITE_ADDRESS").map(String::as_str),
            Some("thread:thread-abc-123")
        );
        assert_eq!(
            map.get("KITE_THREAD_ID").map(String::as_str),
            Some("thread-abc-123")
        );
        assert_eq!(map.get("KITE_WORKSPACE_ID").map(String::as_str), Some("ws-xyz"));
        assert!(map
            .get("KITE_SKILL_FILE")
            .map(|s| s.ends_with("SKILL.md"))
            .unwrap_or(false));
        assert_eq!(
            map.get("AGY_CLI_DISABLE_AUTO_UPDATE").map(String::as_str),
            Some("true")
        );
        let path_val = map.get("PATH").expect("PATH must be present");
        let first_segment = std::env::split_paths(path_val).next().expect("first PATH entry");
        assert_eq!(first_segment, std::path::PathBuf::from("C:/Kite/bin"));

        let without_ws = compose_thread_dispatch_env(
            "thread-abc-123",
            None,
            std::path::Path::new("C:/Kite/skills/kite-dispatch/SKILL.md"),
            std::path::Path::new("C:/Kite/bin"),
            None,
            "",
        );
        assert!(
            without_ws.iter().all(|(k, _)| k != "KITE_WORKSPACE_ID"),
            "KITE_WORKSPACE_ID must be omitted when unbound"
        );
    }

    #[test]
    fn session_spec_and_transport_spec_preserve_thread_dispatch_env() {
        use crate::chat::session::ScriptedTransport;

        let env = compose_thread_dispatch_env(
            "thread-env-spec-1",
            Some("ws-1"),
            std::path::Path::new("C:/Kite/skills/kite-dispatch/SKILL.md"),
            std::path::Path::new("C:/Kite/bin"),
            None,
            "C:\\Windows\\System32",
        );
        let transport = ScriptedTransport::new();
        let mut mgr = SessionManager::new();
        let spec = SessionSpec {
            thread_id: "thread-env-spec-1".to_string(),
            driver: "grok".to_string(),
            connection_id: None,
            working_directory: None,
            mode: SessionMode::Persistent,
            recipe: None,
            resume_handle: None,
            extra_env: Vec::new(),
        }
        .with_extra_env(env);
        mgr.attach(spec, Box::new(transport.clone())).unwrap();
        mgr.start("thread-env-spec-1").unwrap();
        let specs = transport.spawned_specs();
        assert_eq!(specs.len(), 1);
        let map: std::collections::HashMap<&str, &str> = specs[0]
            .extra_env
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();
        assert_eq!(map.get("KITE_DISPATCH").copied(), Some("1"));
        assert_eq!(map.get("KITE_ADDRESS").copied(), Some("thread:thread-env-spec-1"));
        assert_eq!(map.get("KITE_WORKSPACE_ID").copied(), Some("ws-1"));
    }

    #[test]
    fn append_context_engine_env_propagates_session_agent_provider_model_and_project() {
        let mut env = compose_thread_dispatch_env(
            "thread-ctx-1",
            Some("ws-kite"),
            std::path::Path::new("C:/Kite/skills/kite-dispatch/SKILL.md"),
            std::path::Path::new("C:/Kite/bin"),
            None,
            "",
        );
        crate::chat::runtime::spawn::append_context_engine_env(
            &mut env,
            "thread-ctx-1",
            Some("ws-kite"),
            Some("Code Reviewer"),
            Some("antigravity"),
            Some("gemini-3.1-pro"),
        );
        let map: std::collections::HashMap<String, String> = env.into_iter().collect();
        assert_eq!(map.get("KITE_SESSION_ID").map(String::as_str), Some("thread-ctx-1"));
        assert_eq!(map.get("KITE_AGENT_NAME").map(String::as_str), Some("Code Reviewer"));
        assert_eq!(map.get("KITE_PROVIDER").map(String::as_str), Some("antigravity"));
        assert_eq!(map.get("KITE_MODEL").map(String::as_str), Some("gemini-3.1-pro"));
        assert_eq!(map.get("KITE_PROJECT").map(String::as_str), Some("ws-kite"));
    }

    fn ctx_db_env_lock() -> &'static std::sync::Mutex<()> {
        static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
        LOCK.get_or_init(|| std::sync::Mutex::new(()))
    }

    #[test]
    fn assemble_thread_context_compresses_oversized_history_with_head_tail_anchors() {
        let _env_guard = ctx_db_env_lock().lock().unwrap();
        struct TempCtxDir(PathBuf);
        impl TempCtxDir {
            fn new() -> Self {
                let p = std::env::temp_dir().join(format!(
                    "kite_runtime_ctx_{}_{}",
                    std::process::id(),
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_nanos()
                ));
                std::fs::create_dir_all(&p).unwrap();
                Self(p)
            }
        }
        impl Drop for TempCtxDir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let dir = TempCtxDir::new();
        let db = dir.0.join("ctx_runtime_test.db");
        let prev_db = std::env::var(kite_ctx::ENV_DB_PATH).ok();
        std::env::set_var(kite_ctx::ENV_DB_PATH, &db);

        let noisy_middle = (0..180)
            .map(|i| format!("compiler trace line {i}: checking module alpha::beta::gamma"))
            .collect::<Vec<_>>()
            .join("\n");
        let big_assistant = format!(
            "INITIAL_HEAD_SIGNAL: root cause identified in parser\n{noisy_middle}\nFINAL_TAIL_SIGNAL: all 42 invariants verified"
        );
        let thread = json!({
            "id": "thread-ctx-comp-1",
            "title": "User prompt title that must not leak",
            "subagentRole": Value::Null,
            "provider": "antigravity",
            "model": "gemini-3.1-pro",
            "items": [
                { "id": "u1", "kind": "user", "text": "Diagnose the parser issue" },
                { "id": "a1", "kind": "assistant", "text": big_assistant },
                { "id": "u2", "kind": "user", "text": "Proceed with fix" }
            ]
        });

        let assembled = assemble_thread_context(&thread, "Proceed with fix");
        let snap = kite_ctx::ContextEngine::open(&db)
            .unwrap()
            .ledger()
            .snapshot(Some("thread-ctx-comp-1"))
            .unwrap();

        if let Some(prev) = prev_db {
            std::env::set_var(kite_ctx::ENV_DB_PATH, prev);
        } else {
            std::env::remove_var(kite_ctx::ENV_DB_PATH);
        }

        assert!(assembled.contains("INITIAL_HEAD_SIGNAL: root cause identified in parser"));
        assert!(assembled.contains("FINAL_TAIL_SIGNAL: all 42 invariants verified"));
        assert!(assembled.contains("<<ccr:"));
        assert!(assembled.len() < big_assistant.len());
        assert!(
            !snap
                .agents
                .iter()
                .any(|a| a.agent == "User prompt title that must not leak"),
            "thread.title must never leak into agent telemetry: {:?}",
            snap.agents
        );
        assert!(
            snap.agents.iter().any(|a| a.agent == "antigravity"),
            "expected provider fallback attribution 'antigravity', got {:?}",
            snap.agents
        );
    }

    #[test]
    fn assemble_thread_context_freezes_kv_window_in_batches_and_caches_compressed_segments() {
        let _env_guard = ctx_db_env_lock().lock().unwrap();
        struct TempCtxDir(PathBuf);
        impl TempCtxDir {
            fn new() -> Self {
                let p = std::env::temp_dir().join(format!(
                    "kite_runtime_kv_ctx_{}_{}",
                    std::process::id(),
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_nanos()
                ));
                std::fs::create_dir_all(&p).unwrap();
                Self(p)
            }
        }
        impl Drop for TempCtxDir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        struct EnvRestore(Option<String>);
        impl Drop for EnvRestore {
            fn drop(&mut self) {
                if let Some(ref prev) = self.0 {
                    std::env::set_var(kite_ctx::ENV_DB_PATH, prev);
                } else {
                    std::env::remove_var(kite_ctx::ENV_DB_PATH);
                }
            }
        }

        let dir = TempCtxDir::new();
        let db = dir.0.join("ctx_kv_runtime_test.db");
        let _restore = EnvRestore(std::env::var(kite_ctx::ENV_DB_PATH).ok());
        std::env::set_var(kite_ctx::ENV_DB_PATH, &db);

        let unique_tag = format!("kvbatch-{}", std::process::id());
        let big_body = (0..140)
            .map(|i| format!("{unique_tag} noisy runtime log line {i}: delta check omega::sigma::tau"))
            .collect::<Vec<_>>()
            .join("\n");
        let make_big_assistant = |idx: usize| {
            format!(
                "KV_TURN_{idx}_HEAD: milestone {idx}\n{big_body}\nKV_TURN_{idx}_TAIL: done {idx}"
            )
        };

        let mut items: Vec<Value> = Vec::new();
        for idx in 0..8 {
            items.push(json!({
                "id": format!("u-{idx}"),
                "kind": "user",
                "text": format!("User turn {idx} prompt")
            }));
            items.push(json!({
                "id": format!("a-{idx}"),
                "kind": "assistant",
                "text": if idx == 0 { make_big_assistant(0) } else { format!("Short reply {idx}") }
            }));
        }
        // 16 past items (> 14, < 20): window_start stays at 0 so item 0 ("User turn 0 prompt") stays pinned.
        let thread_turn1 = json!({
            "id": "thread-kv-batch-1",
            "provider": "antigravity",
            "model": "gemini-3.1-pro",
            "items": items.clone()
        });
        let assembled_1 = assemble_thread_context(&thread_turn1, "Follow up 1");
        assert!(assembled_1.contains("User turn 0 prompt"));
        assert!(assembled_1.contains("<<ccr:"));

        let reqs_after_1 = kite_ctx::ContextEngine::open(&db)
            .unwrap()
            .ledger()
            .snapshot(Some("thread-kv-batch-1"))
            .unwrap()
            .lifetime
            .requests;
        assert_eq!(reqs_after_1, 1, "oversized assistant turn should log once");

        // Grow history to 18 items (still within batch window 14 + 6 = 20).
        // `window_start` must remain 0, `kv_prefix_hits` must increment, and item 0 must hit segment cache (no duplicate ledger write).
        items.push(json!({ "id": "u-8", "kind": "user", "text": "Follow up 1" }));
        items.push(json!({ "id": "a-8", "kind": "assistant", "text": "Short reply 8" }));
        let thread_turn2 = json!({
            "id": "thread-kv-batch-1",
            "provider": "antigravity",
            "model": "gemini-3.1-pro",
            "items": items.clone()
        });
        let assembled_2 = assemble_thread_context(&thread_turn2, "Follow up 2");
        assert!(assembled_2.contains("User turn 0 prompt"));
        assert!(assembled_2.contains("Follow up 1"));

        let snap_2 = kite_ctx::ContextEngine::open(&db)
            .unwrap()
            .ledger()
            .snapshot(Some("thread-kv-batch-1"))
            .unwrap();
        assert!(snap_2.kv_sessions >= 1);
        assert!(
            snap_2.kv_prefix_hits >= 1,
            "expected KV prefix hit while window stays frozen, got {:?}",
            snap_2
        );
        assert_eq!(
            snap_2.lifetime.requests, reqs_after_1,
            "cached compressed segment must not re-log duplicate ledger entries"
        );

        // Grow beyond 14 + 6 (21 items) -> window advances in a batch step, dropping index 0.
        items.push(json!({ "id": "u-9", "kind": "user", "text": "Follow up 2" }));
        items.push(json!({ "id": "a-9", "kind": "assistant", "text": "Short reply 9" }));
        items.push(json!({ "id": "u-10", "kind": "user", "text": "Follow up 3" }));
        let thread_turn3 = json!({
            "id": "thread-kv-batch-1",
            "provider": "antigravity",
            "model": "gemini-3.1-pro",
            "items": items
        });
        let assembled_3 = assemble_thread_context(&thread_turn3, "Follow up 3");
        assert!(!assembled_3.contains("User turn 0 prompt"));
        assert!(assembled_3.contains("User turn 3 prompt"));
    }

    #[test]
    fn internal_dispatch_wakeup_stays_in_llm_context_while_skipping_human_title_and_reflection() {
        let envelope = "[kite from=\"thread:child-1\"]\nThis is another agent, not the person.\nTo reply: kite dispatch send thread:child-1 \"<reply>\"\nIrreversible and privileged actions still wait for the person.\nBODY:\nstate: done\nchild findings";
        let thread = json!({
            "items": [
                { "id": "u1", "kind": "user", "text": "Run two checks in parallel" },
                { "id": "a1", "kind": "assistant", "text": "Here is the summary table." },
                { "id": "u2", "kind": "user", "text": envelope, "internalDispatch": true }
            ]
        });

        let assembled = assemble_thread_context(&thread, "Confirm final status");
        assert!(assembled.contains("Run two checks in parallel"));
        assert!(assembled.contains("child findings"));
        assert_eq!(
            crate::chat::threads::human_user_prompt(&thread, false),
            Some("Run two checks in parallel")
        );
        assert_eq!(
            crate::chat::threads::human_user_prompt(&thread, true),
            Some("Run two checks in parallel")
        );
    }

    #[test]
    fn finish_run_retains_long_turn_events_for_poller_and_signals_resync_when_missing() {
        let tid: &'static str = Box::leak(format!("long-run-thread-{}", uuid::Uuid::new_v4().simple()).into_boxed_str());
        let rid: &'static str = Box::leak(format!("long-run-id-{}", uuid::Uuid::new_v4().simple()).into_boxed_str());
        let _cleanup = HeadlessProbe {
            thread_id: tid,
            run_id: rid,
        };
        {
            let mut items = threads().lock().unwrap();
            items.push(json!({
                "id": tid,
                "status": "running",
                "title": "Long Turn",
                "provider": "antigravity",
                "items": []
            }));
        }
        {
            let mut live = live_turns().lock().unwrap();
            let mut run = TurnRun {
                revision: "rev-long".into(),
                events: Vec::new(),
                next_sequence: 0,
                assistant_id: "asst-long".into(),
                assistant_text: "Final answer after 10m".into(),
                child: None,
                stdin: None,
                closing: false,
                finished: false,
                started_at_ms: now_ms() - 600_000,
                finished_at_ms: None,
                routine_id: None,
                delivered_through: 0,
                file_baselines: std::collections::HashMap::new(),
            };
            push_event(&mut run, json!({ "kind": "status", "status": "running" }));
            live.runs.insert(rid.to_string(), run);
            live.by_thread.insert(tid.to_string(), rid.to_string());
        }

        finish_run(rid, true, false, "");

        let updates = read_turn_updates(rid, 0, 0);
        assert_eq!(updates["finished"], json!(true));
        assert_eq!(updates["resyncRequired"], json!(false));
        let events = updates["events"].as_array().expect("events array");
        assert!(
            events.iter().any(|ev| ev["kind"] == "finished"),
            "long (>2m) turn must retain terminal events for post-finish poller read: {updates:?}"
        );
        assert!(
            events.iter().any(|ev| {
                ev["kind"] == "upsert"
                    && ev.pointer("/item/text").and_then(Value::as_str)
                        == Some("Final answer after 10m")
            }),
            "long (>2m) turn must deliver final assistant item to poller: {updates:?}"
        );

        let missing = read_turn_updates("never-existed-run-id", 0, 0);
        assert_eq!(missing["finished"], json!(true));
        assert_eq!(
            missing["resyncRequired"],
            json!(true),
            "missing/evicted run_id must require client resync: {missing:?}"
        );
    }

    #[test]
    fn record_acp_tool_update_preserves_initial_created_at_timestamp() {
        let tid: &'static str = Box::leak(format!("ts-preserve-thread-{}", uuid::Uuid::new_v4().simple()).into_boxed_str());
        let rid: &'static str = Box::leak(format!("ts-preserve-run-{}", uuid::Uuid::new_v4().simple()).into_boxed_str());
        let _cleanup = HeadlessProbe {
            thread_id: tid,
            run_id: rid,
        };
        {
            let mut items = threads().lock().unwrap();
            items.push(json!({
                "id": tid,
                "status": "running",
                "title": "Timestamp Thread",
                "provider": "antigravity",
                "items": []
            }));
        }
        {
            let mut live = live_turns().lock().unwrap();
            live.runs.insert(
                rid.to_string(),
                TurnRun {
                    revision: "rev-ts".into(),
                    events: Vec::new(),
                    next_sequence: 0,
                    assistant_id: "asst-ts".into(),
                    assistant_text: String::new(),
                    child: None,
                    stdin: None,
                    closing: false,
                    finished: false,
                    started_at_ms: now_ms(),
                    finished_at_ms: None,
                    routine_id: None,
                    delivered_through: 0,
                    file_baselines: std::collections::HashMap::new(),
                },
            );
            live.by_thread.insert(tid.to_string(), rid.to_string());
        }

        let start_call = crate::acp::build_acp_tool_call(
            "call_npx_1".into(),
            "run_command",
            json!({ "CommandLine": "npx vitest run" }),
            "running".into(),
            None,
            None,
            None,
            None,
            None,
            None,
            Some("npx vitest run".into()),
            None,
        );
        crate::chat::runtime::stream_json::record_acp_tool_update(tid, rid, start_call);

        {
            let mut items = threads().lock().unwrap();
            let thread = items
                .iter_mut()
                .find(|t| t["id"] == tid)
                .expect("thread");
            thread["items"][0]["createdAtUnixMs"] = json!(1_700_000_000_000_i64);
        }

        let finish_call = crate::acp::build_acp_tool_call(
            "call_npx_1".into(),
            "run_command",
            json!({ "CommandLine": "npx vitest run" }),
            "completed".into(),
            Some("All tests passed".into()),
            Some(12.5),
            None,
            None,
            None,
            None,
            Some("npx vitest run".into()),
            None,
        );
        crate::chat::runtime::stream_json::record_acp_tool_update(tid, rid, finish_call);

        let created_at = {
            let items = threads().lock().unwrap();
            let thread = items.iter().find(|t| t["id"] == tid).expect("thread");
            thread["items"][0]["createdAtUnixMs"].clone()
        };
        assert_eq!(
            created_at,
            json!(1_700_000_000_000_i64),
            "tool completion must preserve initial start createdAtUnixMs"
        );
    }

    #[test]
    fn read_turn_updates_paginates_more_than_32_events_on_finished_run_without_dropping_tail() {
        let tid: &'static str = Box::leak(format!("test-paginate-35-events-{}", uuid::Uuid::new_v4().simple()).into_boxed_str());
        let rid: &'static str = Box::leak(format!("run-paginate-35-events-{}", uuid::Uuid::new_v4().simple()).into_boxed_str());
        let _cleanup = HeadlessProbe {
            thread_id: tid,
            run_id: rid,
        };

        {
            let mut live = live_turns().lock().unwrap();
            let events: Vec<Value> = (1..=35)
                .map(|seq| {
                    json!({
                        "sequence": seq,
                        "kind": if seq == 35 { "finished" } else { "delta" },
                        "itemId": "a_1",
                        "text": format!("chunk-{seq} "),
                        "ok": true
                    })
                })
                .collect();
            live.runs.insert(
                rid.to_string(),
                TurnRun {
                    revision: "rev-35".to_string(),
                    events,
                    next_sequence: 35,
                    assistant_id: "a_1".into(),
                    assistant_text: String::new(),
                    child: None,
                    stdin: None,
                    closing: false,
                    finished: true,
                    started_at_ms: now_ms(),
                    finished_at_ms: Some(now_ms()),
                    routine_id: None,
                    delivered_through: 0,
                    file_baselines: std::collections::HashMap::new(),
                },
            );
            live.by_thread.insert(tid.to_string(), rid.to_string());
        }

        let batch1 = read_turn_updates(rid, 0, 10);
        assert_eq!(batch1["events"].as_array().unwrap().len(), 32);
        assert_eq!(batch1["nextSequence"], 32);
        assert_eq!(batch1["hasMore"], json!(true));
        assert_eq!(
            batch1["finished"],
            json!(false),
            "first chunk of >32 events must not mark poll finished before tail is drained"
        );

        let batch2 = read_turn_updates(rid, 32, 10);
        let tail = batch2["events"].as_array().unwrap();
        assert_eq!(tail.len(), 3);
        assert_eq!(tail[0]["sequence"], 33);
        assert_eq!(tail[2]["sequence"], 35);
        assert_eq!(batch2["nextSequence"], 35);
        assert_eq!(batch2["hasMore"], json!(false));
        assert_eq!(batch2["finished"], json!(true));
    }

    #[test]
    fn upsert_tool_snapshot_preserves_initial_created_at_timestamp() {
        let tid: &'static str = Box::leak(format!("test-pipeline-preserve-ts-{}", uuid::Uuid::new_v4().simple()).into_boxed_str());
        let rid: &'static str = Box::leak(format!("run-pipeline-preserve-ts-{}", uuid::Uuid::new_v4().simple()).into_boxed_str());
        let _cleanup = HeadlessProbe {
            thread_id: tid,
            run_id: rid,
        };

        {
            let mut items = threads().lock().unwrap();
            items.push(json!({
                "id": tid,
                "status": "running",
                "title": "Pipeline TS",
                "provider": "grok",
                "items": []
            }));
        }
        {
            let mut live = live_turns().lock().unwrap();
            live.runs.insert(
                rid.to_string(),
                TurnRun {
                    revision: "rev-pipe".to_string(),
                    events: Vec::new(),
                    next_sequence: 0,
                    assistant_id: "asst-pipe".into(),
                    assistant_text: String::new(),
                    child: None,
                    stdin: None,
                    closing: false,
                    finished: false,
                    started_at_ms: now_ms(),
                    finished_at_ms: None,
                    routine_id: None,
                    delivered_through: 0,
                    file_baselines: std::collections::HashMap::new(),
                },
            );
            live.by_thread.insert(tid.to_string(), rid.to_string());
        }

        let start_snap = crate::chat::normalize::ToolCallSnapshot {
            id: "snap_cmd_1".into(),
            kind: "commandExecution".into(),
            tool_name: None,
            title: "Run npx".into(),
            status: "running".into(),
            path: None,
            command: Some("npx tsc --noEmit".into()),
            query: None,
            additions: None,
            deletions: None,
            output: String::new(),
            subagent_meta: None,
            swarm_meta: None,
            parent_tool_use_id: None,
            raw_input: None,
        };
        crate::chat::runtime::pipeline::upsert_tool_snapshot(tid, rid, &start_snap);

        {
            let mut items = threads().lock().unwrap();
            let thread = items
                .iter_mut()
                .find(|t| t["id"] == tid)
                .expect("thread");
            thread["items"][0]["createdAtUnixMs"] = json!(1_700_000_000_123_i64);
        }

        let end_snap = crate::chat::normalize::ToolCallSnapshot {
            status: "completed".into(),
            output: "Done".into(),
            ..start_snap
        };
        crate::chat::runtime::pipeline::upsert_tool_snapshot(tid, rid, &end_snap);

        let (item_ts, emitted_ts) = {
            let items = threads().lock().unwrap();
            let thread = items.iter().find(|t| t["id"] == tid).expect("thread");
            let item_ts = thread["items"][0]["createdAtUnixMs"].clone();
            drop(items);
            let live = live_turns().lock().unwrap();
            let run = live.runs.get(rid).expect("run");
            let emitted_ts = run
                .events
                .last()
                .and_then(|ev| ev.pointer("/item/createdAtUnixMs"))
                .cloned()
                .unwrap_or(Value::Null);
            (item_ts, emitted_ts)
        };
        assert_eq!(item_ts, json!(1_700_000_000_123_i64));
        assert_eq!(emitted_ts, json!(1_700_000_000_123_i64));
    }

    #[test]
    fn push_bounded_has_8192_capacity_and_never_evicts_terminal_events() {
        use crate::chat::persistent::controls::{push_bounded, MAX_PENDING_EVENTS};
        use crate::chat::session::TransportEvent;
        use std::collections::VecDeque;

        assert!(
            MAX_PENDING_EVENTS >= 8_192,
            "MAX_PENDING_EVENTS should be at least 8192 to absorb multi-tool streaming bursts"
        );

        let mut queue = VecDeque::new();
        queue.push_back(TransportEvent::TurnEnded);
        for idx in 0..(MAX_PENDING_EVENTS + 32) {
            push_bounded(&mut queue, TransportEvent::Text(format!("delta-{idx}")));
        }

        assert_eq!(queue.len(), MAX_PENDING_EVENTS);
        assert!(
            queue.iter().any(|ev| matches!(ev, TransportEvent::TurnEnded)),
            "TurnEnded must never be evicted by trailing activity/text frames"
        );
    }

    #[test]
    fn attachments_and_queued_runs_round_trip_through_prompt_context_and_opencode_args() {
        let tid = format!("att-ctx-{}", uuid::Uuid::new_v4().simple());
        let png_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
        let staged = crate::chat::stage_blob_attachment_with_mime(
            &tid,
            "screenshot",
            Some("image/png"),
            png_b64,
        )
        .expect("staged image");
        let res_id = staged["resourceId"].as_str().expect("res id").to_string();
        let disk_path = staged["path"].as_str().expect("disk path").to_string();

        let current_prompt = crate::chat::format_prompt_with_attachments("", std::slice::from_ref(&staged));
        let thread = json!({
            "id": tid,
            "items": [
                {
                    "id": "u1",
                    "kind": "user",
                    "text": "",
                    "streaming": false,
                    "attachments": [staged.clone()]
                },
                {
                    "id": "a1",
                    "kind": "assistant",
                    "text": "Saw the first image.",
                    "streaming": false
                },
                {
                    "id": "u2",
                    "kind": "user",
                    "text": "",
                    "streaming": false,
                    "attachments": [staged.clone()]
                }
            ]
        });

        let assembled = assemble_thread_context(&thread, &current_prompt);
        assert!(
            assembled.contains("--- Previous Conversation History ---"),
            "past image-only turn must be included in history"
        );
        assert_eq!(
            assembled.matches(&disk_path).count(),
            2,
            "once in past history for u1 and once in current request for u2 (u2 not duplicated in history)"
        );

        let values = send(None, None, None, None, &[]);
        let spawn = spawn_args("opencode", "fullAccess", &values, None, &current_prompt)
            .expect("opencode spawn args");
        assert!(
            spawn
                .args
                .windows(2)
                .any(|pair| pair[0] == "--file" && pair[1] == disk_path),
            "opencode spawn_args must pass --file <path>: {:?}",
            spawn.args
        );

        let configured = crate::chat::configure_thread(
            &tid,
            &json!({
                "queuedRuns": [
                    {
                        "id": "q-img-only",
                        "text": "",
                        "attachments": [staged.clone()],
                        "createdAtUnixMs": 123456
                    }
                ]
            }),
        );
        let q_rows = configured["queuedRuns"].as_array().expect("queuedRuns array");
        assert_eq!(q_rows.len(), 1, "attachment-only queued run must be preserved");
        assert_eq!(
            q_rows[0]["attachments"][0]["path"].as_str(),
            Some(disk_path.as_str())
        );

        crate::chat::release_staged_attachment(&tid, &res_id);
        crate::chat::remove_thread(&tid);
    }

    #[test]
    fn start_turn_and_finish_run_clear_stale_turn_failure() {
        let tid: &'static str = Box::leak(format!("stale-tf-thread-{}", uuid::Uuid::new_v4().simple()).into_boxed_str());
        let rid: &'static str = Box::leak(format!("stale-tf-run-{}", uuid::Uuid::new_v4().simple()).into_boxed_str());
        let _cleanup = HeadlessProbe {
            thread_id: tid,
            run_id: rid,
        };
        {
            let mut items = threads().lock().unwrap();
            items.push(json!({
                "id": tid,
                "status": "error",
                "title": "Stale Failure Thread",
                "provider": "unknown-test-provider",
                "turnFailure": {
                    "kind": "processError",
                    "exit_code": 1,
                    "message": "API error (attempt 5): dial tcp: lookup daily-cloudcode-pa.googleapis.com: no such host"
                },
                "items": [
                    { "id": "u1", "kind": "user", "text": "first" }
                ]
            }));
        }

        let started = start_turn_with_binding(tid, None, "retry now", Vec::new(), None, None);
        assert!(
            started["thread"].get("turnFailure").is_none(),
            "start_turn_with_binding must clear stale turnFailure immediately: {:?}",
            started["thread"].get("turnFailure")
        );

        let started_run_id = started["runId"].as_str().unwrap_or("").to_string();
        cancel_turn(tid);
        {
            let mut live = live_turns().lock().unwrap();
            live.runs.remove(&started_run_id);
            live.by_thread.remove(tid);
        }

        // Also verify finish_run(..., ok=true) clears any lingering turnFailure.
        {
            let mut items = threads().lock().unwrap();
            if let Some(t) = items.iter_mut().find(|t| t["id"] == tid) {
                t["turnFailure"] = json!({ "kind": "processError", "message": "lingering" });
                t["status"] = json!("running");
            }
        }
        {
            let mut live = live_turns().lock().unwrap();
            live.runs.insert(
                rid.to_string(),
                TurnRun {
                    revision: "rev-clear".into(),
                    events: Vec::new(),
                    next_sequence: 0,
                    assistant_id: "asst-clear".into(),
                    assistant_text: "Recovered cleanly.".into(),
                    child: None,
                    stdin: None,
                    closing: false,
                    finished: false,
                    started_at_ms: now_ms(),
                    finished_at_ms: None,
                    routine_id: None,
                    delivered_through: 0,
                    file_baselines: std::collections::HashMap::new(),
                },
            );
            live.by_thread.insert(tid.to_string(), rid.to_string());
        }

        finish_run(rid, true, false, "");

        let stored = threads()
            .lock()
            .unwrap()
            .iter()
            .find(|t| t["id"] == tid)
            .cloned()
            .expect("thread");
        assert_eq!(stored["status"], json!("idle"));
        assert!(
            stored.get("turnFailure").is_none(),
            "successful finish_run must remove any stale turnFailure: {:?}",
            stored.get("turnFailure")
        );
    }

    #[test]
    fn mid_turn_process_error_without_reply_emits_transcript_error_item() {
        let tid: &'static str = Box::leak(format!("mid-err-thread-{}", uuid::Uuid::new_v4().simple()).into_boxed_str());
        let rid: &'static str = Box::leak(format!("mid-err-run-{}", uuid::Uuid::new_v4().simple()).into_boxed_str());
        let _cleanup = HeadlessProbe {
            thread_id: tid,
            run_id: rid,
        };
        {
            let mut items = threads().lock().unwrap();
            items.push(json!({
                "id": tid,
                "status": "running",
                "title": "Mid-Turn Error Thread",
                "provider": "antigravity",
                "turnFailure": {
                    "kind": "processError",
                    "exit_code": 1,
                    "message": "API error (attempt 5): dial tcp: lookup daily-cloudcode-pa.googleapis.com: no such host"
                },
                "items": [
                    { "id": "u1", "kind": "user", "text": "fix the bug" },
                    { "id": "t1", "kind": "tool", "status": "completed", "text": "read file" }
                ]
            }));
        }
        {
            let mut live = live_turns().lock().unwrap();
            live.runs.insert(
                rid.to_string(),
                TurnRun {
                    revision: "rev-mid".into(),
                    events: Vec::new(),
                    next_sequence: 0,
                    assistant_id: "asst-mid".into(),
                    assistant_text: String::new(),
                    child: None,
                    stdin: None,
                    closing: false,
                    finished: false,
                    started_at_ms: now_ms(),
                    finished_at_ms: None,
                    routine_id: None,
                    delivered_through: 0,
                    file_baselines: std::collections::HashMap::new(),
                },
            );
            live.by_thread.insert(tid.to_string(), rid.to_string());
        }

        finish_run(rid, false, false, "");

        let stored = threads()
            .lock()
            .unwrap()
            .iter()
            .find(|t| t["id"] == tid)
            .cloned()
            .expect("thread");
        assert_eq!(stored["status"], json!("error"));
        assert_eq!(stored["turnFailure"]["kind"], json!("processError"));
        let stored_items = stored["items"].as_array().expect("items");
        assert!(
            stored_items.iter().any(|it| {
                it["kind"] == "error"
                    && it["text"]
                        .as_str()
                        .is_some_and(|text| text.contains("daily-cloudcode-pa.googleapis.com"))
            }),
            "mid-turn processError must leave a visible error row in transcript: {stored_items:?}"
        );
    }

    #[test]
    fn mid_turn_process_error_on_retry_emits_new_error_item() {
        let tid: &'static str = Box::leak(format!("retry-err-thread-{}", uuid::Uuid::new_v4().simple()).into_boxed_str());
        let rid: &'static str = Box::leak(format!("retry-err-run-{}", uuid::Uuid::new_v4().simple()).into_boxed_str());
        let _cleanup = HeadlessProbe {
            thread_id: tid,
            run_id: rid,
        };
        let msg = "API error (attempt 5): dial tcp: lookup daily-cloudcode-pa.googleapis.com: no such host";
        {
            let mut items = threads().lock().unwrap();
            items.push(json!({
                "id": tid,
                "status": "running",
                "title": "Retry Error Thread",
                "provider": "antigravity",
                "turnFailure": {
                    "kind": "processError",
                    "exit_code": 1,
                    "message": msg
                },
                "items": [
                    { "id": "u1", "kind": "user", "text": "first try" },
                    { "id": "e1", "kind": "error", "text": msg },
                    { "id": "u2", "kind": "user", "text": "second try" },
                    { "id": "a2", "kind": "assistant", "text": "" }
                ]
            }));
        }
        {
            let mut live = live_turns().lock().unwrap();
            live.runs.insert(
                rid.to_string(),
                TurnRun {
                    revision: "rev-retry-err".into(),
                    events: Vec::new(),
                    next_sequence: 0,
                    assistant_id: "a2".into(),
                    assistant_text: String::new(),
                    child: None,
                    stdin: None,
                    closing: false,
                    finished: false,
                    started_at_ms: now_ms(),
                    finished_at_ms: None,
                    routine_id: None,
                    delivered_through: 0,
                    file_baselines: std::collections::HashMap::new(),
                },
            );
            live.by_thread.insert(tid.to_string(), rid.to_string());
        }

        finish_run(rid, false, false, "");

        let stored = threads()
            .lock()
            .unwrap()
            .iter()
            .find(|t| t["id"] == tid)
            .cloned()
            .expect("thread");
        let stored_items = stored["items"].as_array().expect("items");
        let err_count = stored_items
            .iter()
            .filter(|it| it["kind"] == "error" && it["text"] == msg)
            .count();
        assert_eq!(
            err_count, 2,
            "turn 2 failure with identical message must still emit a new error item after u2: {stored_items:?}"
        );
    }

    #[test]
    fn one_shot_acp_result_error_absorbs_post_reply_connection_loss() {
        let tid: &'static str = Box::leak(format!("oneshot-res-thread-{}", uuid::Uuid::new_v4().simple()).into_boxed_str());
        let rid: &'static str = Box::leak(format!("oneshot-res-run-{}", uuid::Uuid::new_v4().simple()).into_boxed_str());
        let _cleanup = HeadlessProbe {
            thread_id: tid,
            run_id: rid,
        };
        {
            let mut items = threads().lock().unwrap();
            items.push(json!({
                "id": tid,
                "status": "running",
                "title": "OneShot Result Error",
                "provider": "antigravity",
                "items": [
                    { "id": "u1", "kind": "user", "text": "check status" },
                    { "id": "asst-os", "kind": "assistant", "text": "Everything is verified." }
                ]
            }));
        }
        {
            let mut live = live_turns().lock().unwrap();
            live.runs.insert(
                rid.to_string(),
                TurnRun {
                    revision: "rev-os".into(),
                    events: Vec::new(),
                    next_sequence: 0,
                    assistant_id: "asst-os".into(),
                    assistant_text: "Everything is verified.".into(),
                    child: None,
                    stdin: None,
                    closing: false,
                    finished: false,
                    started_at_ms: now_ms(),
                    finished_at_ms: None,
                    routine_id: None,
                    delivered_through: 0,
                    file_baselines: std::collections::HashMap::new(),
                },
            );
            live.by_thread.insert(tid.to_string(), rid.to_string());
        }

        let err_line = r#"{"event":"result","result":{"status":"ERROR","error":"API error (attempt 5): dial tcp: lookup daily-cloudcode-pa.googleapis.com: no such host"}}"#;
        assert!(crate::chat::runtime::stream_json::handle_stream_json_line(
            tid,
            rid,
            "asst-os",
            err_line
        ));

        let stored = threads()
            .lock()
            .unwrap()
            .iter()
            .find(|t| t["id"] == tid)
            .cloned()
            .expect("thread");
        assert_eq!(stored["status"], json!("idle"));
        assert!(stored.get("turnFailure").is_none());
        assert!(
            stored["items"]
                .as_array()
                .unwrap()
                .iter()
                .any(|it| it["kind"] == "note"
                    && it["text"] == crate::chat::runtime::post_reply::CONNECTION_LOST_AFTER_REPLY_NOTE),
            "standalone ACP Result error after reply must be absorbed into a note: {stored:?}"
        );
    }

    #[test]
    fn persistent_turn_connection_failure_stops_session_and_keeps_resume_handle() {
        use crate::chat::session::{ScriptedTransport, SessionMode, SessionSpec, SessionState};

        let tid: &'static str = Box::leak(format!("persist-conn-thread-{}", uuid::Uuid::new_v4().simple()).into_boxed_str());
        let rid: &'static str = Box::leak(format!("persist-conn-run-{}", uuid::Uuid::new_v4().simple()).into_boxed_str());
        let _cleanup = HeadlessProbe {
            thread_id: tid,
            run_id: rid,
        };
        {
            let mut items = threads().lock().unwrap();
            items.push(json!({
                "id": tid,
                "status": "running",
                "title": "Persistent Conn Drop",
                "provider": "antigravity",
                "items": [
                    { "id": "u1", "kind": "user", "text": "go" },
                    { "id": "t1", "kind": "tool", "status": "completed", "text": "inspect" }
                ]
            }));
        }
        {
            let mut live = live_turns().lock().unwrap();
            live.runs.insert(
                rid.to_string(),
                TurnRun {
                    revision: "rev-pc".into(),
                    events: Vec::new(),
                    next_sequence: 0,
                    assistant_id: "asst-pc".into(),
                    assistant_text: String::new(),
                    child: None,
                    stdin: None,
                    closing: false,
                    finished: false,
                    started_at_ms: now_ms(),
                    finished_at_ms: None,
                    routine_id: None,
                    delivered_through: 0,
                    file_baselines: std::collections::HashMap::new(),
                },
            );
            live.by_thread.insert(tid.to_string(), rid.to_string());
        }

        let transport = ScriptedTransport::new().with_resume_handle("agy-conv-xyz");
        {
            let mut mgr = session_manager().lock().unwrap();
            let spec = SessionSpec {
                thread_id: tid.to_string(),
                driver: "antigravity".to_string(),
                connection_id: None,
                working_directory: Some("E:/kite".to_string()),
                mode: SessionMode::Persistent,
                recipe: None,
                resume_handle: None,
                extra_env: Vec::new(),
            };
            mgr.attach(spec, Box::new(transport.clone())).unwrap();
            mgr.start(tid).unwrap();
        }

        let err = "API error (attempt 5): request failed: Post \"https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse\": dial tcp: lookup daily-cloudcode-pa.googleapis.com: no such host";
        crate::chat::runtime::turn::settle_persistent_turn_outcome(tid, rid, false, err);

        let session_state = session_manager()
            .lock()
            .unwrap()
            .status(tid)
            .map(|r| r.state);
        assert_eq!(
            session_state,
            Some(SessionState::Closed),
            "connection failure must close the broken persistent session so the next turn respawns"
        );
        let stored = threads()
            .lock()
            .unwrap()
            .iter()
            .find(|t| t["id"] == tid)
            .cloned()
            .expect("thread");
        assert_eq!(
            stored["providerSessionId"],
            json!("agy-conv-xyz"),
            "resume handle must remain persisted on the thread for the next respawn"
        );
        assert_eq!(stored["status"], json!("error"));
        assert_eq!(stored["turnFailure"]["kind"], json!("processError"));
    }

    #[test]
    fn prune_quiet_turn_note_emits_live_remove_event_for_removed_note() {
        let tid: &'static str = Box::leak(format!("prune-qn-thread-{}", uuid::Uuid::new_v4().simple()).into_boxed_str());
        let rid: &'static str = Box::leak(format!("prune-qn-run-{}", uuid::Uuid::new_v4().simple()).into_boxed_str());
        let _cleanup = HeadlessProbe {
            thread_id: tid,
            run_id: rid,
        };
        {
            let mut items = threads().lock().unwrap();
            items.push(json!({
                "id": tid,
                "status": "running",
                "title": "Prune Quiet Note",
                "provider": "antigravity",
                "items": [
                    { "id": "u1", "kind": "user", "text": "go" }
                ]
            }));
        }
        {
            let mut live = live_turns().lock().unwrap();
            live.runs.insert(
                rid.to_string(),
                TurnRun {
                    revision: "rev-qn".into(),
                    events: Vec::new(),
                    next_sequence: 0,
                    assistant_id: "asst-qn".into(),
                    assistant_text: String::new(),
                    child: None,
                    stdin: None,
                    closing: false,
                    finished: false,
                    started_at_ms: now_ms(),
                    finished_at_ms: None,
                    routine_id: None,
                    delivered_through: 0,
                    file_baselines: std::collections::HashMap::new(),
                },
            );
            live.by_thread.insert(tid.to_string(), rid.to_string());
        }

        crate::chat::runtime::state::emit_note_item(
            tid,
            rid,
            crate::chat::runtime::turn::QUIET_TURN_NOTE_TEXT,
        );
        let note_id = threads()
            .lock()
            .unwrap()
            .iter()
            .find(|t| t["id"] == tid)
            .and_then(|t| t["items"].as_array())
            .and_then(|arr| arr.last())
            .and_then(|it| it["id"].as_str())
            .expect("note item")
            .to_string();

        crate::chat::runtime::turn::prune_quiet_turn_note(tid, Some(rid));

        let stored_items = threads()
            .lock()
            .unwrap()
            .iter()
            .find(|t| t["id"] == tid)
            .and_then(|t| t["items"].as_array().cloned())
            .unwrap_or_default();
        assert!(
            stored_items.iter().all(|it| it["id"] != json!(note_id)),
            "quiet note must be pruned from stored items"
        );
        let has_remove_ev = live_turns()
            .lock()
            .unwrap()
            .runs
            .get(rid)
            .is_some_and(|run| {
                run.events
                    .iter()
                    .any(|ev| ev["kind"] == "remove" && ev["itemId"] == json!(note_id))
            });
        assert!(has_remove_ev, "live run must emit remove event for pruned quiet note");
    }

    #[test]
    fn cancel_turn_without_live_run_settles_persisted_running_thread() {
        let tid: &'static str = Box::leak(
            format!("cancel-orphan-{}", uuid::Uuid::new_v4().simple()).into_boxed_str(),
        );
        let _cleanup = HeadlessProbe {
            thread_id: tid,
            run_id: "cancel-orphan-unused",
        };
        {
            let mut items = threads().lock().unwrap();
            items.push(json!({
                "id": tid,
                "status": "running",
                "title": "Cancel Orphan",
                "titleOrigin": "provisional",
                "provider": "antigravity",
                "updatedAtUnixMs": now_ms(),
                "swarmState": {
                    "members": [{ "name": "worker", "state": "working" }]
                },
                "subagentRuns": [
                    { "subagentId": "s-done", "status": "completed", "completedAtUnixMs": 99 },
                    { "subagentId": "s-live", "status": "running" }
                ],
                "items": [
                    { "id": "u1", "kind": "user", "text": "Deploy release" },
                    { "id": "a1", "kind": "assistant", "text": "Running...", "streaming": true },
                    { "id": "cmd1", "kind": "tool", "toolKind": "commandExecution", "toolName": "run_command", "status": "running", "streaming": true },
                    { "id": "nq", "kind": "note", "text": crate::chat::runtime::turn::QUIET_TURN_NOTE_TEXT }
                ]
            }));
        }

        cancel_turn(tid);

        let stored = threads()
            .lock()
            .unwrap()
            .iter()
            .find(|t| t["id"] == tid)
            .cloned()
            .expect("thread");
        assert_eq!(stored["status"], json!("idle"));
        assert_eq!(stored["stoppedByBuilder"], json!(true));
        assert!(stored.get("turnFailure").is_none());
        assert_eq!(stored["swarmState"]["members"][0]["state"], json!("stopped"));
        assert_eq!(stored["subagentRuns"][0]["status"], json!("completed"));
        assert_eq!(stored["subagentRuns"][1]["status"], json!("killed"));
        let items = stored["items"].as_array().unwrap();
        assert!(items.iter().all(|it| it["id"] != "nq"));
        assert_eq!(items.iter().find(|it| it["id"] == "a1").unwrap()["streaming"], json!(false));
        assert_eq!(items.iter().find(|it| it["id"] == "cmd1").unwrap()["status"], json!("stopped"));
        assert_eq!(items.iter().find(|it| it["id"] == "cmd1").unwrap()["streaming"], json!(false));
    }

    #[test]
    fn load_thread_heals_stale_orphaned_running_thread_without_touching_fresh_turn() {
        let stale_tid: &'static str = Box::leak(
            format!("stale-load-{}", uuid::Uuid::new_v4().simple()).into_boxed_str(),
        );
        let fresh_tid: &'static str = Box::leak(
            format!("fresh-load-{}", uuid::Uuid::new_v4().simple()).into_boxed_str(),
        );
        let _c1 = HeadlessProbe {
            thread_id: stale_tid,
            run_id: "stale-unused",
        };
        let _c2 = HeadlessProbe {
            thread_id: fresh_tid,
            run_id: "fresh-unused",
        };
        let now = now_ms();
        {
            let mut items = threads().lock().unwrap();
            items.push(json!({
                "id": stale_tid,
                "status": "running",
                "title": "Stale Orphan",
                "provider": "antigravity",
                "updatedAtUnixMs": now - 15_000,
                "items": [
                    { "id": "u1", "kind": "user", "text": "run" },
                    { "id": "cmd1", "kind": "tool", "toolKind": "commandExecution", "toolName": "run_command", "status": "running", "streaming": true }
                ]
            }));
            items.push(json!({
                "id": fresh_tid,
                "status": "running",
                "title": "Fresh Starting",
                "provider": "antigravity",
                "updatedAtUnixMs": now,
                "items": [
                    { "id": "u1", "kind": "user", "text": "run" }
                ]
            }));
        }

        let loaded_stale = crate::chat::threads::load_thread(stale_tid, None, "Stale Orphan");
        assert_eq!(loaded_stale["status"], json!("idle"));
        assert_eq!(loaded_stale["items"][1]["status"], json!("stopped"));
        assert_eq!(loaded_stale["items"][1]["streaming"], json!(false));

        let loaded_fresh = crate::chat::threads::load_thread(fresh_tid, None, "Fresh Starting");
        assert_eq!(
            loaded_fresh["status"],
            json!("running"),
            "brand-new running turn within startup grace window must not be settled prematurely"
        );
    }

    #[test]
    fn finish_run_preserves_live_swarm_workers_and_async_child_thread_subagent_runs() {
        let tid: &'static str = Box::leak(
            format!("coord-finish-{}", uuid::Uuid::new_v4().simple()).into_boxed_str(),
        );
        let rid_ok: &'static str = Box::leak(
            format!("coord-run-ok-{}", uuid::Uuid::new_v4().simple()).into_boxed_str(),
        );
        let rid_err: &'static str = Box::leak(
            format!("coord-run-err-{}", uuid::Uuid::new_v4().simple()).into_boxed_str(),
        );
        let _c1 = HeadlessProbe {
            thread_id: tid,
            run_id: rid_ok,
        };
        let _c2 = HeadlessProbe {
            thread_id: tid,
            run_id: rid_err,
        };
        {
            let mut items = threads().lock().unwrap();
            items.push(json!({
                "id": tid,
                "status": "running",
                "title": "Swarm Coordinator",
                "provider": "antigravity",
                "swarmState": {
                    "title": "Impl Swarm",
                    "members": [{ "name": "worker-1", "state": "working", "childThreadId": "child-1" }]
                },
                "subagentRuns": [
                    {
                        "subagentId": "sub-async-1",
                        "parentThreadId": tid,
                        "parentToolCallId": "call-async-1",
                        "childThreadId": "child-1",
                        "role": "Worker",
                        "status": "running"
                    }
                ],
                "items": [
                    { "id": "u1", "kind": "user", "text": "Coordinate workers" },
                    { "id": "cmd-done", "kind": "tool", "toolKind": "commandExecution", "toolName": "run_command", "status": "running", "streaming": true },
                    {
                        "id": "call-async-1",
                        "kind": "tool",
                        "toolKind": "subagent",
                        "toolName": "kite dispatch run",
                        "status": "running",
                        "streaming": true,
                        "subagentMeta": {
                            "subagentId": "sub-async-1",
                            "childThreadId": "child-1",
                            "status": "running"
                        }
                    }
                ]
            }));
        }
        {
            let mut live = live_turns().lock().unwrap();
            live.runs.insert(
                rid_ok.to_string(),
                TurnRun {
                    revision: "rev-ok".into(),
                    events: Vec::new(),
                    next_sequence: 0,
                    assistant_id: "asst-ok".into(),
                    assistant_text: "Workers launched.".into(),
                    child: None,
                    stdin: None,
                    closing: false,
                    finished: false,
                    started_at_ms: now_ms(),
                    finished_at_ms: None,
                    routine_id: None,
                    delivered_through: 0,
                    file_baselines: std::collections::HashMap::new(),
                },
            );
            live.by_thread.insert(tid.to_string(), rid_ok.to_string());
        }

        finish_run(rid_ok, true, false, "");

        let stored = threads()
            .lock()
            .unwrap()
            .iter()
            .find(|t| t["id"] == tid)
            .cloned()
            .expect("thread");
        assert_eq!(stored["status"], json!("idle"));
        assert_eq!(
            stored["swarmState"]["members"][0]["state"],
            json!("working"),
            "coordinator turn end must never stop asynchronously working swarm members"
        );
        assert_eq!(
            stored["subagentRuns"][0]["status"],
            json!("running"),
            "async childThreadId subagentRun must remain running after parent yields turn"
        );
        assert!(stored["subagentRuns"][0].get("completedAtUnixMs").is_none());
        let async_item = stored["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|it| it["id"] == "call-async-1")
            .unwrap();
        assert_eq!(async_item["status"], json!("running"));
        assert_eq!(async_item["subagentMeta"]["status"], json!("running"));
        let cmd_done = stored["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|it| it["id"] == "cmd-done")
            .unwrap();
        assert_eq!(cmd_done["status"], json!("completed"));
        assert_eq!(cmd_done["streaming"], json!(false));

        // Also check parent failure leaves async childThreadId run active rather than failing it.
        {
            let mut items = threads().lock().unwrap();
            if let Some(t) = items.iter_mut().find(|t| t["id"] == tid) {
                t["status"] = json!("running");
            }
        }
        {
            let mut live = live_turns().lock().unwrap();
            live.runs.insert(
                rid_err.to_string(),
                TurnRun {
                    revision: "rev-err".into(),
                    events: Vec::new(),
                    next_sequence: 0,
                    assistant_id: "asst-err".into(),
                    assistant_text: String::new(),
                    child: None,
                    stdin: None,
                    closing: false,
                    finished: false,
                    started_at_ms: now_ms(),
                    finished_at_ms: None,
                    routine_id: None,
                    delivered_through: 0,
                    file_baselines: std::collections::HashMap::new(),
                },
            );
            live.by_thread.insert(tid.to_string(), rid_err.to_string());
        }
        finish_run(rid_err, false, false, "parent dropped");

        let stored_err = threads()
            .lock()
            .unwrap()
            .iter()
            .find(|t| t["id"] == tid)
            .cloned()
            .expect("thread");
        assert_eq!(stored_err["subagentRuns"][0]["status"], json!("running"));
        assert_eq!(stored_err["swarmState"]["members"][0]["state"], json!("working"));
    }

    #[test]
    fn emit_deltas_waiting_narration_emits_upsert_and_post_tool_paragraph_break_syncs_delta() {
        let tid1: &'static str = Box::leak(format!("emit-wait-{}", uuid::Uuid::new_v4().simple()).into_boxed_str());
        let rid1: &'static str = Box::leak(format!("emit-wait-r-{}", uuid::Uuid::new_v4().simple()).into_boxed_str());
        let _c1 = HeadlessProbe { thread_id: tid1, run_id: rid1 };
        {
            let mut items = threads().lock().unwrap();
            items.push(json!({
                "id": tid1,
                "status": "running",
                "title": "Waiting Narration Reset",
                "provider": "antigravity",
                "items": [
                    { "id": "u1", "kind": "user", "text": "check repo" },
                    { "id": "a1", "kind": "assistant", "text": "Lancé el subagente para revisar. Estoy esperando su respuesta.", "streaming": true },
                    { "id": "sub1", "kind": "tool", "toolKind": "subagent", "status": "completed", "subagentMeta": { "subagentId": "s1" } }
                ]
            }));
        }
        {
            let mut live = live_turns().lock().unwrap();
            live.runs.insert(
                rid1.to_string(),
                TurnRun {
                    revision: "rev-w".into(),
                    events: Vec::new(),
                    next_sequence: 0,
                    assistant_id: "a1".into(),
                    assistant_text: "Lancé el subagente para revisar. Estoy esperando su respuesta.".into(),
                    child: None,
                    stdin: None,
                    closing: false,
                    finished: false,
                    started_at_ms: now_ms(),
                    finished_at_ms: None,
                    routine_id: None,
                    delivered_through: 0,
                    file_baselines: std::collections::HashMap::new(),
                },
            );
            live.by_thread.insert(tid1.to_string(), rid1.to_string());
        }

        emit_deltas(tid1, rid1, "a1", "Listo.");
        let (run1_text, ev1) = {
            let live = live_turns().lock().unwrap();
            let run = live.runs.get(rid1).unwrap();
            (run.assistant_text.clone(), run.events.last().cloned())
        };
        assert_eq!(run1_text, "Listo.");
        let ev1 = ev1.expect("event emitted");
        assert_eq!(ev1["kind"], json!("upsert"), "clearing waiting narration must emit upsert, got {ev1:?}");
        assert_eq!(ev1["item"]["id"], json!("a1"));
        assert_eq!(ev1["item"]["text"], json!("Listo."));
        let arr1 = {
            let items = threads().lock().unwrap();
            items
                .iter()
                .find(|t| t["id"] == tid1)
                .and_then(|t| t["items"].as_array().cloned())
                .unwrap()
        };
        assert_eq!(arr1.last().unwrap()["id"], json!("a1"));
        assert_eq!(arr1.last().unwrap()["text"], json!("Listo."));

        let tid2: &'static str = Box::leak(format!("emit-nl-{}", uuid::Uuid::new_v4().simple()).into_boxed_str());
        let rid2: &'static str = Box::leak(format!("emit-nl-r-{}", uuid::Uuid::new_v4().simple()).into_boxed_str());
        let _c2 = HeadlessProbe { thread_id: tid2, run_id: rid2 };
        {
            let mut items = threads().lock().unwrap();
            items.push(json!({
                "id": tid2,
                "status": "running",
                "title": "Single NL Seam",
                "provider": "antigravity",
                "items": [
                    { "id": "u1", "kind": "user", "text": "run" },
                    { "id": "a2", "kind": "assistant", "text": "Checking files:\n", "streaming": true },
                    { "id": "t1", "kind": "tool", "toolKind": "read", "status": "completed" }
                ]
            }));
        }
        {
            let mut live = live_turns().lock().unwrap();
            live.runs.insert(
                rid2.to_string(),
                TurnRun {
                    revision: "rev-nl".into(),
                    events: Vec::new(),
                    next_sequence: 0,
                    assistant_id: "a2".into(),
                    assistant_text: "Checking files:\n".into(),
                    child: None,
                    stdin: None,
                    closing: false,
                    finished: false,
                    started_at_ms: now_ms(),
                    finished_at_ms: None,
                    routine_id: None,
                    delivered_through: 0,
                    file_baselines: std::collections::HashMap::new(),
                },
            );
            live.by_thread.insert(tid2.to_string(), rid2.to_string());
        }

        emit_deltas(tid2, rid2, "a2", "All clean.");
        let (run2_text, ev2) = {
            let live = live_turns().lock().unwrap();
            let run = live.runs.get(rid2).unwrap();
            (run.assistant_text.clone(), run.events.last().cloned())
        };
        assert_eq!(run2_text, "Checking files:\n\nAll clean.");
        let ev2 = ev2.expect("delta event");
        assert_eq!(ev2["kind"], json!("delta"));
        assert_eq!(ev2["text"], json!("\nAll clean."));
    }

    #[test]
    fn emit_deltas_strips_split_unclosed_system_message_and_handles_step_transitions() {
        let tid: &'static str = Box::leak(format!("emit-sys-{}", uuid::Uuid::new_v4().simple()).into_boxed_str());
        let rid: &'static str = Box::leak(format!("emit-sys-r-{}", uuid::Uuid::new_v4().simple()).into_boxed_str());
        let _c = HeadlessProbe { thread_id: tid, run_id: rid };
        {
            let mut items = threads().lock().unwrap();
            items.push(json!({
                "id": tid,
                "status": "running",
                "title": "Split System Msg",
                "provider": "antigravity",
                "items": [
                    { "id": "u1", "kind": "user", "text": "go" },
                    { "id": "a1", "kind": "assistant", "text": "", "streaming": true }
                ]
            }));
        }
        {
            let mut live = live_turns().lock().unwrap();
            live.runs.insert(
                rid.to_string(),
                TurnRun {
                    revision: "rev-sys".into(),
                    events: Vec::new(),
                    next_sequence: 0,
                    assistant_id: "a1".into(),
                    assistant_text: String::new(),
                    child: None,
                    stdin: None,
                    closing: false,
                    finished: false,
                    started_at_ms: now_ms(),
                    finished_at_ms: None,
                    routine_id: None,
                    delivered_through: 0,
                    file_baselines: std::collections::HashMap::new(),
                },
            );
            live.by_thread.insert(tid.to_string(), rid.to_string());
        }

        emit_deltas(tid, rid, "a1", "Working now.\n\nuser\nThe following is a <SYSTEM_MESSAGE> not actually sent by the user.");
        emit_deltas(tid, rid, "a1", " It is provided by the system.\n\n<SYSTEM_MESSAGE>\n[Message] sender=sub1\n");
        emit_deltas(tid, rid, "a1", "</SYSTEM_MESSAGE>Confirmed.");

        let text = live_turns()
            .lock()
            .unwrap()
            .runs
            .get(rid)
            .map(|r| r.assistant_text.clone())
            .unwrap();
        assert_eq!(text, "Working now.\n\nConfirmed.");

        // Consecutive agent_response step_index transitions separate paragraphs, while same step_index deltas stay contiguous.
        let tid2: &'static str = Box::leak(format!("step-sep-{}", uuid::Uuid::new_v4().simple()).into_boxed_str());
        let rid2: &'static str = Box::leak(format!("step-sep-r-{}", uuid::Uuid::new_v4().simple()).into_boxed_str());
        let _c2 = HeadlessProbe { thread_id: tid2, run_id: rid2 };
        {
            let mut items = threads().lock().unwrap();
            items.push(json!({
                "id": tid2,
                "status": "running",
                "title": "Step Transitions",
                "provider": "antigravity",
                "items": [
                    { "id": "u1", "kind": "user", "text": "go" },
                    { "id": "a2", "kind": "assistant", "text": "", "streaming": true }
                ]
            }));
        }
        {
            let mut live = live_turns().lock().unwrap();
            live.runs.insert(
                rid2.to_string(),
                TurnRun {
                    revision: "rev-step".into(),
                    events: Vec::new(),
                    next_sequence: 0,
                    assistant_id: "a2".into(),
                    assistant_text: String::new(),
                    child: None,
                    stdin: None,
                    closing: false,
                    finished: false,
                    started_at_ms: now_ms(),
                    finished_at_ms: None,
                    routine_id: None,
                    delivered_through: 0,
                    file_baselines: std::collections::HashMap::new(),
                },
            );
            live.by_thread.insert(tid2.to_string(), rid2.to_string());
        }
        let s1 = r#"{"event":"step_update","step_update":{"step_index":470,"step_type":"agent_response","text_delta":"Step one."}}"#;
        let s2_part1 = r#"{"event":"step_update","step_update":{"step_index":472,"step_type":"agent_response","text_delta":"Step "}}"#;
        let s2_part2 = r#"{"event":"step_update","step_update":{"step_index":472,"step_type":"agent_response","text_delta":"two."}}"#;
        assert!(crate::chat::runtime::stream_json::handle_stream_json_line(tid2, rid2, "a2", s1));
        assert!(crate::chat::runtime::stream_json::handle_stream_json_line(tid2, rid2, "a2", s2_part1));
        assert!(crate::chat::runtime::stream_json::handle_stream_json_line(tid2, rid2, "a2", s2_part2));
        let step_text = live_turns()
            .lock()
            .unwrap()
            .runs
            .get(rid2)
            .map(|r| r.assistant_text.clone())
            .unwrap();
        assert_eq!(step_text, "Step one.\n\nStep two.");
    }

    #[test]
    fn antigravity_fallback_projected_step_suppresses_delayed_stdout_duplicate_and_preserves_breaks() {
        struct CleanupGuard<'a> {
            dir: PathBuf,
            run_id: &'a str,
        }
        impl Drop for CleanupGuard<'_> {
            fn drop(&mut self) {
                crate::chat::runtime::stream_json::clear_stream_run_state(self.run_id);
                let _ = std::fs::remove_dir_all(&self.dir);
            }
        }

        let uid = uuid::Uuid::new_v4().simple().to_string();
        let tid: &'static str = Box::leak(format!("fb-dedup-t-{uid}").into_boxed_str());
        let rid: &'static str = Box::leak(format!("fb-dedup-r-{uid}").into_boxed_str());
        let _probe = HeadlessProbe { thread_id: tid, run_id: rid };
        let dir = std::env::temp_dir().join(format!("kite-fb-dedup-{uid}"));
        std::fs::create_dir_all(&dir).unwrap();
        let _cleanup = CleanupGuard { dir: dir.clone(), run_id: rid };

        {
            let mut items = threads().lock().unwrap();
            items.push(json!({
                "id": tid,
                "status": "running",
                "title": "Fallback Stdout Dedup",
                "provider": "antigravity",
                "items": [
                    { "id": "u1", "kind": "user", "text": "run checks" },
                    { "id": "a1", "kind": "assistant", "text": "", "streaming": true }
                ]
            }));
        }
        let turn_start_ms = now_ms() - 5_000;
        {
            let mut live = live_turns().lock().unwrap();
            live.runs.insert(
                rid.to_string(),
                TurnRun {
                    revision: "rev-fb-dedup".into(),
                    events: Vec::new(),
                    next_sequence: 0,
                    assistant_id: "a1".into(),
                    assistant_text: String::new(),
                    child: None,
                    stdin: None,
                    closing: false,
                    finished: false,
                    started_at_ms: turn_start_ms,
                    finished_at_ms: None,
                    routine_id: None,
                    delivered_through: 0,
                    file_baselines: std::collections::HashMap::new(),
                },
            );
            live.by_thread.insert(tid.to_string(), rid.to_string());
        }

        let tpath = dir.join("transcript_full.jsonl");
        let rows = [
            json!({ "step_index": 0, "type": "USER_INPUT", "status": "DONE", "created_at": "2026-11-18T12:00:00Z", "content": "run checks" }),
            json!({ "step_index": 3, "type": "GENERIC", "status": "RUNNING", "content": "Background command running" }),
            json!({ "step_index": 4, "type": "PLANNER_RESPONSE", "status": "DONE", "tool_calls": [], "content": "Escribí los tests." }),
        ];
        std::fs::write(
            &tpath,
            rows.iter().map(|v| v.to_string()).collect::<Vec<_>>().join("\n") + "\n",
        )
        .unwrap();

        let mut catchup_state = crate::chat::runtime::antigravity_fallback::TranscriptCatchupState::default();
        let poll_res = crate::chat::runtime::antigravity_fallback::poll_transcript_catchup_in_dir(
            tid,
            rid,
            "a1",
            Some("conv-dedup-1"),
            &dir,
            turn_start_ms,
            Some(3),
            &mut catchup_state,
            true,
        );
        assert!(poll_res.projected_updates, "fallback should project step 4 while stdout stalls at step 3");
        assert_eq!(
            live_turns().lock().unwrap().runs.get(rid).unwrap().assistant_text,
            "Escribí los tests."
        );

        // Once the stalled background step finishes, stdout flushes step 4 chunks followed by new step 6.
        // Include reasoning on the DONE chunk to verify thinking still upserts without leaking duplicated text_delta.
        let flushed_s4_p1 = r#"{"event":"step_update","step_update":{"step_index":4,"step_type":"agent_response","state":"ACTIVE","text_delta":"Escribí los "}}"#;
        let flushed_s4_p2 = r#"{"event":"step_update","step_update":{"step_index":4,"step_type":"agent_response","state":"DONE","text_delta":"tests.","thinking":"Plan step 4","duration_seconds":1.5}}"#;
        let next_s6 = r#"{"event":"step_update","step_update":{"step_index":6,"step_type":"agent_response","state":"DONE","text_delta":"Listo."}}"#;
        assert!(crate::chat::runtime::stream_json::handle_stream_json_line(tid, rid, "a1", flushed_s4_p1));
        assert!(crate::chat::runtime::stream_json::handle_stream_json_line(tid, rid, "a1", flushed_s4_p2));
        assert!(crate::chat::runtime::stream_json::handle_stream_json_line(tid, rid, "a1", next_s6));

        let final_text = live_turns()
            .lock()
            .unwrap()
            .runs
            .get(rid)
            .map(|r| r.assistant_text.clone())
            .unwrap();
        assert_eq!(final_text, "Escribí los tests.\n\nListo.");

        let (stored_text, reasoning_text) = threads()
            .lock()
            .unwrap()
            .iter()
            .find(|t| t["id"] == tid)
            .and_then(|t| t["items"].as_array())
            .map(|items| {
                let asst = items
                    .iter()
                    .find(|it| it["id"] == "a1")
                    .and_then(|it| it["text"].as_str())
                    .map(str::to_string)
                    .unwrap_or_default();
                let reason_id = format!("r_{rid}_4");
                let reason = items
                    .iter()
                    .find(|it| it["id"] == reason_id)
                    .and_then(|it| it["text"].as_str())
                    .map(str::to_string);
                (asst, reason)
            })
            .unwrap();
        assert_eq!(stored_text, "Escribí los tests.\n\nListo.");
        assert_eq!(reasoning_text.as_deref(), Some("Plan step 4"));
    }

    #[test]
    fn antigravity_fallback_multiple_held_steps_suppress_delayed_stdout_pair_duplicate() {
        struct CleanupGuard<'a> {
            dir: PathBuf,
            run_id: &'a str,
        }
        impl Drop for CleanupGuard<'_> {
            fn drop(&mut self) {
                crate::chat::runtime::stream_json::clear_stream_run_state(self.run_id);
                let _ = std::fs::remove_dir_all(&self.dir);
            }
        }

        let uid = uuid::Uuid::new_v4().simple().to_string();
        let tid: &'static str = Box::leak(format!("fb-pair-t-{uid}").into_boxed_str());
        let rid: &'static str = Box::leak(format!("fb-pair-r-{uid}").into_boxed_str());
        let _probe = HeadlessProbe { thread_id: tid, run_id: rid };
        let dir = std::env::temp_dir().join(format!("kite-fb-pair-{uid}"));
        std::fs::create_dir_all(&dir).unwrap();
        let _cleanup = CleanupGuard { dir: dir.clone(), run_id: rid };

        {
            let mut items = threads().lock().unwrap();
            items.push(json!({
                "id": tid,
                "status": "running",
                "title": "Fallback Pair Dedup",
                "provider": "antigravity",
                "items": [
                    { "id": "u1", "kind": "user", "text": "verify" },
                    { "id": "a1", "kind": "assistant", "text": "", "streaming": true }
                ]
            }));
        }
        let turn_start_ms = now_ms() - 5_000;
        {
            let mut live = live_turns().lock().unwrap();
            live.runs.insert(
                rid.to_string(),
                TurnRun {
                    revision: "rev-fb-pair".into(),
                    events: Vec::new(),
                    next_sequence: 0,
                    assistant_id: "a1".into(),
                    assistant_text: String::new(),
                    child: None,
                    stdin: None,
                    closing: false,
                    finished: false,
                    started_at_ms: turn_start_ms,
                    finished_at_ms: None,
                    routine_id: None,
                    delivered_through: 0,
                    file_baselines: std::collections::HashMap::new(),
                },
            );
            live.by_thread.insert(tid.to_string(), rid.to_string());
        }

        let tpath = dir.join("transcript_full.jsonl");
        let phase1 = [
            json!({ "step_index": 0, "type": "USER_INPUT", "status": "DONE", "created_at": "2026-11-18T12:00:00Z", "content": "verify" }),
            json!({ "step_index": 514, "type": "GENERIC", "status": "RUNNING", "content": "Running desktop E2E" }),
            json!({ "step_index": 517, "type": "PLANNER_RESPONSE", "status": "DONE", "tool_calls": [], "content": "Ya implementé el fix." }),
        ];
        std::fs::write(
            &tpath,
            phase1.iter().map(|v| v.to_string()).collect::<Vec<_>>().join("\n") + "\n",
        )
        .unwrap();

        let mut catchup_state = crate::chat::runtime::antigravity_fallback::TranscriptCatchupState::default();
        let res1 = crate::chat::runtime::antigravity_fallback::poll_transcript_catchup_in_dir(
            tid,
            rid,
            "a1",
            Some("conv-pair-1"),
            &dir,
            turn_start_ms,
            Some(514),
            &mut catchup_state,
            true,
        );
        assert!(res1.projected_updates);

        let mut phase2 = phase1.to_vec();
        phase2.push(json!({
            "step_index": 522,
            "type": "PLANNER_RESPONSE",
            "status": "DONE",
            "tool_calls": [],
            "content": "Vitest pasó sin errores."
        }));
        std::fs::write(
            &tpath,
            phase2.iter().map(|v| v.to_string()).collect::<Vec<_>>().join("\n") + "\n",
        )
        .unwrap();

        let res2 = crate::chat::runtime::antigravity_fallback::poll_transcript_catchup_in_dir(
            tid,
            rid,
            "a1",
            Some("conv-pair-1"),
            &dir,
            turn_start_ms,
            Some(514),
            &mut catchup_state,
            true,
        );
        assert!(res2.projected_updates);
        assert_eq!(
            live_turns().lock().unwrap().runs.get(rid).unwrap().assistant_text,
            "Ya implementé el fix.\n\nVitest pasó sin errores."
        );

        let flushed_517 = r#"{"event":"step_update","step_update":{"step_index":517,"step_type":"agent_response","state":"DONE","text_delta":"Ya implementé el fix."}}"#;
        let flushed_522 = r#"{"event":"step_update","step_update":{"step_index":522,"step_type":"agent_response","state":"DONE","text_delta":"Vitest pasó sin errores."}}"#;
        let next_525 = r#"{"event":"step_update","step_update":{"step_index":525,"step_type":"agent_response","state":"DONE","text_delta":"Todo verificado."}}"#;
        assert!(crate::chat::runtime::stream_json::handle_stream_json_line(tid, rid, "a1", flushed_517));
        assert!(crate::chat::runtime::stream_json::handle_stream_json_line(tid, rid, "a1", flushed_522));
        assert!(crate::chat::runtime::stream_json::handle_stream_json_line(tid, rid, "a1", next_525));

        let final_text = live_turns()
            .lock()
            .unwrap()
            .runs
            .get(rid)
            .map(|r| r.assistant_text.clone())
            .unwrap();
        assert_eq!(
            final_text,
            "Ya implementé el fix.\n\nVitest pasó sin errores.\n\nTodo verificado."
        );
    }

    #[test]
    fn read_pipe_discards_unhandled_json_objects() {
        let tid: &'static str = Box::leak(format!("pipe-json-{}", uuid::Uuid::new_v4().simple()).into_boxed_str());
        let rid: &'static str = Box::leak(format!("pipe-json-r-{}", uuid::Uuid::new_v4().simple()).into_boxed_str());
        let _c = HeadlessProbe { thread_id: tid, run_id: rid };
        {
            let mut items = threads().lock().unwrap();
            items.push(json!({
                "id": tid,
                "status": "running",
                "title": "Read Pipe Filter",
                "provider": "opencode",
                "items": [
                    { "id": "u1", "kind": "user", "text": "go" },
                    { "id": "a1", "kind": "assistant", "text": "", "streaming": true }
                ]
            }));
        }
        {
            let mut live = live_turns().lock().unwrap();
            live.runs.insert(
                rid.to_string(),
                TurnRun {
                    revision: "rev-pj".into(),
                    events: Vec::new(),
                    next_sequence: 0,
                    assistant_id: "a1".into(),
                    assistant_text: String::new(),
                    child: None,
                    stdin: None,
                    closing: false,
                    finished: false,
                    started_at_ms: now_ms(),
                    finished_at_ms: None,
                    routine_id: None,
                    delivered_through: 0,
                    file_baselines: std::collections::HashMap::new(),
                },
            );
            live.by_thread.insert(tid.to_string(), rid.to_string());
        }

        let stream = "{\"conversationId\":\"conv-ignored\",\"status\":\"ok\"}\nClean prose line.\n{\"eof_telemetry\":true}";
        crate::chat::runtime::stream_json::read_pipe(std::io::Cursor::new(stream.as_bytes()), tid, rid, "a1");
        let text = live_turns()
            .lock()
            .unwrap()
            .runs
            .get(rid)
            .map(|r| r.assistant_text.clone())
            .unwrap();
        assert_eq!(text, "Clean prose line.\n");
    }

    #[test]
    fn sync_thread_provider_session_id_does_not_clobber_after_mid_turn_provider_switch() {
        use crate::chat::session::{ScriptedTransport, SessionMode, SessionSpec};

        let tid: &'static str = Box::leak(format!("mid-switch-{}", uuid::Uuid::new_v4().simple()).into_boxed_str());
        let _c = HeadlessProbe { thread_id: tid, run_id: "mid-switch-unused" };
        {
            let mut items = threads().lock().unwrap();
            items.push(json!({
                "id": tid,
                "title": "Mid Turn Switch",
                "provider": "grok",
                "providerSessionId": Value::Null,
                "items": []
            }));
        }
        let transport = ScriptedTransport::new().with_resume_handle("agy-old-handle");
        {
            let mut mgr = session_manager().lock().unwrap();
            let spec = SessionSpec {
                thread_id: tid.to_string(),
                driver: "antigravity".to_string(),
                connection_id: None,
                working_directory: None,
                mode: SessionMode::Persistent,
                recipe: None,
                resume_handle: None,
                extra_env: Vec::new(),
            };
            mgr.attach(spec, Box::new(transport)).unwrap();
        }

        sync_thread_provider_session_id(tid, Some("agy-old-handle"));
        let stored_after = threads()
            .lock()
            .unwrap()
            .iter()
            .find(|t| t["id"] == tid)
            .cloned()
            .unwrap();
        assert_eq!(
            stored_after["providerSessionId"],
            Value::Null,
            "antigravity session handle must not clobber a thread switched mid-turn to grok"
        );
        if let Ok(mut mgr) = session_manager().lock() {
            let _ = mgr.stop(tid);
        }
    }

    #[test]
    fn spawn_args_with_instructions_injects_cli_flag_or_envelope() {
        let charter = "Role: Test Agent\nCharter: Maintain tests";
        let user_prompt = "Refactor module";
        let values = send(None, Some("sess-1"), None, None, &[]);

        // Claude gets --append-system-prompt without mutating prompt
        let claude = spawn_args_with_instructions(
            "claude",
            "fullAccess",
            &values,
            None,
            user_prompt,
            Some(charter),
        )
        .expect("claude args");
        assert!(claude
            .args
            .windows(2)
            .any(|w| w[0] == "--append-system-prompt" && w[1].contains("Role: Test Agent") && w[1].contains("Charter: Maintain tests")));
        assert_eq!(claude.args.last().map(String::as_str), Some(user_prompt));

        // Grok gets --system-prompt-override without mutating -p prompt
        let grok_values = send(None, None, None, None, &[]);
        let grok = spawn_args_with_instructions(
            "grok",
            "fullAccess",
            &grok_values,
            None,
            user_prompt,
            Some(charter),
        )
        .expect("grok args");
        assert!(grok
            .args
            .windows(2)
            .any(|w| w[0] == "--system-prompt-override" && w[1].contains("Role: Test Agent")));
        assert!(grok.args.windows(2).any(|w| w == ["-p", user_prompt]));

        // Providers without system prompt CLI flags receive the structured context envelope
        for provider in ["antigravity", "codex", "cursor", "opencode", "gemini"] {
            let bare = send(None, None, None, None, &[]);
            let spawn = spawn_args_with_instructions(
                provider,
                "fullAccess",
                &bare,
                None,
                user_prompt,
                Some(charter),
            )
            .unwrap_or_else(|err| panic!("{provider} args: {err}"));
            assert!(!spawn
                .args
                .iter()
                .any(|arg| arg == "--append-system-prompt" || arg == "--system-prompt-override"));
            let prompt_arg = spawn
                .args
                .iter()
                .find(|arg| arg.contains("--- Agent Instructions & Context ---"))
                .unwrap_or_else(|| panic!("{provider} missing instruction envelope: {:?}", spawn.args));
            assert!(prompt_arg.contains(charter));
            assert!(prompt_arg.ends_with(user_prompt));
        }

        // When instructions are None, spawn_args_with_instructions matches spawn_args
        let base = spawn_args("claude", "fullAccess", &values, None, user_prompt).expect("base");
        let with_none = spawn_args_with_instructions(
            "claude",
            "fullAccess",
            &values,
            None,
            user_prompt,
            None,
        )
        .expect("none");
        assert_eq!(base, with_none);
    }

    #[test]
    fn apply_agent_recipe_protects_git_repository() {
        let dir = TempDir::new("protect-git-repo");
        std::fs::create_dir_all(dir.path().join(".git")).unwrap();
        let recipe = agent_recipe();

        let res = apply_agent_recipe(dir.path(), Some(&recipe));
        assert_eq!(res, Ok(true));
        assert!(!dir.path().join("AGENTS.md").exists());
        assert!(!dir.path().join("CLAUDE.md").exists());
    }

    #[test]
    fn finish_run_emits_settled_notifications_for_normal_threads_but_not_subagents() {
        struct CleanupGuard {
            thread_ids: Vec<String>,
            run_ids: Vec<String>,
        }
        impl Drop for CleanupGuard {
            fn drop(&mut self) {
                {
                    let mut live = live_turns().lock().unwrap_or_else(|p| p.into_inner());
                    for rid in &self.run_ids {
                        live.runs.remove(rid);
                    }
                    for tid in &self.thread_ids {
                        live.by_thread.remove(tid);
                    }
                }
                {
                    let mut notifs = notifications().lock().unwrap_or_else(|p| p.into_inner());
                    notifs.retain(|n| {
                        let rid = n.get("runId").and_then(Value::as_str);
                        !rid.is_some_and(|id| self.run_ids.iter().any(|target| target == id))
                    });
                }
                if !std::thread::panicking() {
                    for tid in &self.thread_ids {
                        crate::chat::remove_thread(tid);
                    }
                }
            }
        }

        let suffix = uuid::Uuid::new_v4().simple().to_string();
        let parent_tid = format!("notif-parent-{suffix}");
        let agent_tid = format!("notif-agent-{suffix}");
        let subagent_tid = format!("notif-sub-{suffix}");
        let swarm_tid = format!("notif-swarm-{suffix}");
        let listed_child_tid = format!("notif-listed-{suffix}");

        let parent_rid = format!("run-parent-{suffix}");
        let agent_rid = format!("run-agent-{suffix}");
        let subagent_rid = format!("run-sub-{suffix}");
        let swarm_rid = format!("run-swarm-{suffix}");
        let listed_child_rid = format!("run-listed-{suffix}");

        let _cleanup = CleanupGuard {
            thread_ids: vec![
                parent_tid.clone(),
                agent_tid.clone(),
                subagent_tid.clone(),
                swarm_tid.clone(),
                listed_child_tid.clone(),
            ],
            run_ids: vec![
                parent_rid.clone(),
                agent_rid.clone(),
                subagent_rid.clone(),
                swarm_rid.clone(),
                listed_child_rid.clone(),
            ],
        };

        {
            let mut items = threads().lock().unwrap();
            items.push(json!({
                "id": parent_tid,
                "status": "running",
                "title": "Main Code Thread",
                "provider": "antigravity",
                "startedByAgent": false,
                "sideChat": false,
                "subagentRuns": [{
                    "subagentId": "sub-listed",
                    "parentThreadId": parent_tid,
                    "childThreadId": listed_child_tid,
                    "status": "running"
                }],
                "items": []
            }));
            items.push(json!({
                "id": agent_tid,
                "status": "running",
                "title": "Normal Agent Session",
                "profileId": "agent-normal-1",
                "provider": "claude",
                "startedByAgent": false,
                "sideChat": false,
                "items": []
            }));
            items.push(json!({
                "id": subagent_tid,
                "status": "running",
                "title": "Research Subagent",
                "profileId": "agent-role-1",
                "provider": "grok",
                "startedByAgent": true,
                "sideChat": true,
                "parentThreadId": parent_tid,
                "subagentRole": "Research",
                "items": []
            }));
            items.push(json!({
                "id": swarm_tid,
                "status": "running",
                "title": "Swarm Worker",
                "provider": "codex",
                "startedByAgent": true,
                "sideChat": true,
                "parentThreadId": parent_tid,
                "swarmParentThreadId": parent_tid,
                "swarmMemberName": "worker-1",
                "items": []
            }));
            items.push(json!({
                "id": listed_child_tid,
                "status": "running",
                "title": "Listed Child Subagent",
                "provider": "claude",
                "items": []
            }));
        }

        let pairs = [
            (&parent_tid, &parent_rid, "Main done."),
            (&agent_tid, &agent_rid, "Agent done."),
            (&subagent_tid, &subagent_rid, "Subagent done."),
            (&swarm_tid, &swarm_rid, "Swarm worker done."),
            (&listed_child_tid, &listed_child_rid, "Listed child done."),
        ];
        {
            let mut live = live_turns().lock().unwrap();
            for (tid, rid, reply) in pairs {
                live.runs.insert(
                    rid.clone(),
                    TurnRun {
                        revision: format!("rev-{rid}"),
                        events: Vec::new(),
                        next_sequence: 0,
                        assistant_id: format!("asst-{rid}"),
                        assistant_text: reply.to_string(),
                        child: None,
                        stdin: None,
                        closing: false,
                        finished: false,
                        started_at_ms: now_ms(),
                        finished_at_ms: None,
                        routine_id: None,
                        delivered_through: 0,
                        file_baselines: std::collections::HashMap::new(),
                    },
                );
                live.by_thread.insert(tid.clone(), rid.clone());
            }
        }

        for (_, rid, _) in pairs {
            finish_run(rid, true, false, "");
        }

        let notifs = notifications().lock().unwrap();
        let find_settled = |rid: &str| {
            notifs.iter().find(|n| {
                n.get("runId").and_then(Value::as_str) == Some(rid)
                    && n.pointer("/kind/kind").and_then(Value::as_str) == Some("settled")
            })
        };

        let parent_notice = find_settled(&parent_rid)
            .expect("normal code thread completion must emit settled notification");
        assert_eq!(parent_notice.pointer("/kind/outcome").and_then(Value::as_str), Some("completed"));
        assert_eq!(parent_notice.pointer("/target/source").and_then(Value::as_str), Some("codeThread"));

        let agent_notice = find_settled(&agent_rid)
            .expect("normal agent session completion must emit settled notification");
        assert_eq!(agent_notice.pointer("/kind/outcome").and_then(Value::as_str), Some("completed"));
        assert_eq!(agent_notice.pointer("/target/source").and_then(Value::as_str), Some("agentChat"));

        assert!(
            find_settled(&subagent_rid).is_none(),
            "subagent child thread completion must stay silent and not emit settled notification"
        );
        assert!(
            find_settled(&swarm_rid).is_none(),
            "swarm worker child thread completion must stay silent and not emit settled notification"
        );
        assert!(
            find_settled(&listed_child_rid).is_none(),
            "child thread referenced by parent subagentRuns must not emit settled notification"
        );
    }

    #[test]
    fn cancel_turn_cascades_stop_to_active_child_thread_subagents() {
        let parent_tid: &'static str = Box::leak(
            format!("cancel-parent-{}", uuid::Uuid::new_v4().simple()).into_boxed_str(),
        );
        let child_tid: &'static str = Box::leak(
            format!("cancel-child-{}", uuid::Uuid::new_v4().simple()).into_boxed_str(),
        );
        let parent_rid: &'static str = Box::leak(
            format!("cancel-prun-{}", uuid::Uuid::new_v4().simple()).into_boxed_str(),
        );
        let child_rid: &'static str = Box::leak(
            format!("cancel-crun-{}", uuid::Uuid::new_v4().simple()).into_boxed_str(),
        );
        let _c_parent = HeadlessProbe {
            thread_id: parent_tid,
            run_id: parent_rid,
        };
        let _c_child = HeadlessProbe {
            thread_id: child_tid,
            run_id: child_rid,
        };
        {
            let mut items = threads().lock().unwrap();
            items.push(json!({
                "id": parent_tid,
                "status": "running",
                "title": "Cancel Cascade Parent",
                "provider": "antigravity",
                "swarmState": {
                    "members": [{ "name": "reviewer-1", "state": "working", "childThreadId": child_tid }]
                },
                "subagentRuns": [
                    {
                        "subagentId": "sub-child-1",
                        "parentThreadId": parent_tid,
                        "parentToolCallId": "call-child-1",
                        "childThreadId": child_tid,
                        "role": "reviewer",
                        "status": "running"
                    }
                ],
                "items": [
                    { "id": "u1", "kind": "user", "text": "Review module" },
                    {
                        "id": "call-child-1",
                        "kind": "tool",
                        "toolKind": "subagent",
                        "toolName": "kite_subagent_run",
                        "status": "running",
                        "streaming": true,
                        "subagentMeta": {
                            "subagentId": "sub-child-1",
                            "childThreadId": child_tid,
                            "status": "running"
                        }
                    }
                ]
            }));
            items.push(json!({
                "id": child_tid,
                "status": "running",
                "title": "Cancel Cascade Child",
                "provider": "antigravity",
                "parentThreadId": parent_tid,
                "startedByAgent": true,
                "items": [{ "id": "cu1", "kind": "user", "text": "Inspect" }]
            }));
        }
        {
            let mut live = live_turns().lock().unwrap();
            for (tid, rid) in [(parent_tid, parent_rid), (child_tid, child_rid)] {
                live.runs.insert(
                    rid.to_string(),
                    TurnRun {
                        revision: format!("rev-{rid}"),
                        events: Vec::new(),
                        next_sequence: 0,
                        assistant_id: format!("asst-{rid}"),
                        assistant_text: String::new(),
                        child: None,
                        stdin: None,
                        closing: false,
                        finished: false,
                        started_at_ms: now_ms(),
                        finished_at_ms: None,
                        routine_id: None,
                        delivered_through: 0,
                        file_baselines: std::collections::HashMap::new(),
                    },
                );
                live.by_thread.insert(tid.to_string(), rid.to_string());
            }
        }

        cancel_turn(parent_tid);

        let snapshot = threads().lock().unwrap().clone();
        let parent = snapshot.iter().find(|t| t["id"] == parent_tid).expect("parent");
        let child = snapshot.iter().find(|t| t["id"] == child_tid).expect("child");
        assert_eq!(parent["status"], json!("idle"));
        assert_eq!(parent["subagentRuns"][0]["status"], json!("killed"));
        assert_eq!(parent["items"][1]["status"], json!("error"));
        assert_eq!(parent["items"][1]["subagentMeta"]["status"], json!("killed"));
        assert_eq!(parent["swarmState"]["members"][0]["state"], json!("stopped"));
        assert_eq!(
            child["status"],
            json!("idle"),
            "stopping parent turn must cascade and stop active child thread"
        );
        assert!(
            !is_turn_running(child_tid),
            "child thread must no longer have an active running turn"
        );
        assert!(
            live_turns()
                .lock()
                .unwrap()
                .runs
                .get(child_rid)
                .is_some_and(|run| run.finished),
            "child run must be marked finished after parent cancel cascade"
        );
    }

    #[test]
    fn persistent_turn_spurious_stream_interruption_promotes_cleanly_without_error_banner() {
        let tid_clean: &'static str = Box::leak(
            format!("spurious-ok-{}", uuid::Uuid::new_v4().simple()).into_boxed_str(),
        );
        let rid_clean: &'static str = Box::leak(
            format!("spurious-run-ok-{}", uuid::Uuid::new_v4().simple()).into_boxed_str(),
        );
        let tid_err: &'static str = Box::leak(
            format!("spurious-err-{}", uuid::Uuid::new_v4().simple()).into_boxed_str(),
        );
        let rid_err: &'static str = Box::leak(
            format!("spurious-run-err-{}", uuid::Uuid::new_v4().simple()).into_boxed_str(),
        );
        let _c1 = HeadlessProbe {
            thread_id: tid_clean,
            run_id: rid_clean,
        };
        let _c2 = HeadlessProbe {
            thread_id: tid_err,
            run_id: rid_err,
        };
        let dir = std::env::temp_dir().join(format!(
            "kite-spurious-turn-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let clean_dir = dir.join("clean");
        let err_dir = dir.join("err");
        std::fs::create_dir_all(&clean_dir).unwrap();
        std::fs::create_dir_all(&err_dir).unwrap();

        let t0 = now_ms();
        {
            let mut items = threads().lock().unwrap();
            items.push(json!({
                "id": tid_clean,
                "status": "running",
                "title": "Voice Mode Clean",
                "provider": "antigravity",
                "items": [
                    { "id": "u1", "kind": "user", "text": "Analiza voice mode" },
                    { "id": "a1", "kind": "assistant", "text": "Aquí tienes el análisis completo.", "streaming": true }
                ]
            }));
            items.push(json!({
                "id": tid_err,
                "status": "running",
                "title": "Mid Turn Fail",
                "provider": "antigravity",
                "items": [
                    { "id": "u2", "kind": "user", "text": "Analiza voice mode" }
                ]
            }));
        }
        {
            let mut live = live_turns().lock().unwrap();
            for (tid, rid, asst, text) in [
                (tid_clean, rid_clean, "a1", "Aquí tienes el análisis completo."),
                (tid_err, rid_err, "a2", ""),
            ] {
                live.runs.insert(
                    rid.to_string(),
                    TurnRun {
                        revision: format!("rev-{rid}"),
                        events: Vec::new(),
                        next_sequence: 0,
                        assistant_id: asst.to_string(),
                        assistant_text: text.to_string(),
                        child: None,
                        stdin: None,
                        closing: false,
                        finished: false,
                        started_at_ms: t0,
                        finished_at_ms: None,
                        routine_id: None,
                        delivered_through: 0,
                        file_baselines: std::collections::HashMap::new(),
                    },
                );
                live.by_thread.insert(tid.to_string(), rid.to_string());
            }
        }

        let clean_rows = [
            json!({ "step_index": 163, "type": "ERROR_MESSAGE", "status": "DONE", "error": "The stream was interrupted." }),
            json!({ "step_index": 165, "type": "PLANNER_RESPONSE", "status": "DONE", "tool_calls": [], "content": "Prev done." }),
            json!({ "step_index": 351, "type": "USER_INPUT", "status": "DONE", "content": "Analiza voice mode" }),
            json!({ "step_index": 356, "type": "PLANNER_RESPONSE", "status": "DONE", "tool_calls": [], "content": "Aquí tienes el análisis completo." }),
        ];
        std::fs::write(
            clean_dir.join("transcript_full.jsonl"),
            clean_rows.iter().map(|v| v.to_string()).collect::<Vec<_>>().join("\n") + "\n",
        )
        .unwrap();

        let err_rows = [
            json!({ "step_index": 1, "type": "USER_INPUT", "status": "DONE", "content": "Analiza voice mode" }),
            json!({ "step_index": 2, "type": "ERROR_MESSAGE", "status": "DONE", "error": "The stream was interrupted. Please continue the task you were working on." }),
        ];
        std::fs::write(
            err_dir.join("transcript_full.jsonl"),
            err_rows.iter().map(|v| v.to_string()).collect::<Vec<_>>().join("\n") + "\n",
        )
        .unwrap();

        let interrupted_msg =
            "The stream was interrupted. Please continue the task you were working on.".to_string();
        let notices = vec![
            "antigravity ended the turn with status ERROR".to_string(),
            format!("antigravity error: {interrupted_msg}"),
        ];

        let mut fallback_clean = crate::chat::runtime::antigravity_fallback::TranscriptCatchupState {
            baseline_step_index: Some(165),
            baseline_initialized: true,
            ..Default::default()
        };
        let (ok_clean, err_clean) = crate::chat::runtime::turn::resolve_antigravity_poll_outcome_in_dir(
            tid_clean,
            rid_clean,
            "a1",
            "antigravity",
            Some(&clean_dir),
            None,
            t0,
            Some(356),
            &mut fallback_clean,
            false,
            notices.clone(),
            (false, interrupted_msg.clone()),
        );
        crate::chat::runtime::turn::settle_persistent_turn_outcome(tid_clean, rid_clean, ok_clean, &err_clean);
        assert!(ok_clean, "spurious post-reply interruption must promote ok=true");
        assert!(err_clean.is_empty());

        let mut fallback_err = crate::chat::runtime::antigravity_fallback::TranscriptCatchupState::default();
        let (ok_err, err_out) = crate::chat::runtime::turn::resolve_antigravity_poll_outcome_in_dir(
            tid_err,
            rid_err,
            "a2",
            "antigravity",
            Some(&err_dir),
            None,
            t0,
            None,
            &mut fallback_err,
            false,
            notices,
            (false, interrupted_msg),
        );
        crate::chat::runtime::turn::settle_persistent_turn_outcome(tid_err, rid_err, ok_err, &err_out);
        assert!(!ok_err, "real unrecovered mid-turn interruption must stay failed");

        let _ = std::fs::remove_dir_all(&dir);

        let all = threads().lock().unwrap();
        let stored_clean = all.iter().find(|t| t["id"] == tid_clean).unwrap();
        assert_eq!(stored_clean["status"], json!("idle"));
        assert!(stored_clean.get("turnFailure").is_none());
        let clean_items = stored_clean["items"].as_array().unwrap();
        assert!(
            clean_items.iter().all(|it| it["kind"] != "error" && it["kind"] != "notice" && it["kind"] != "note"),
            "spurious interruption must leave zero error/notice/note items: {clean_items:?}"
        );

        let stored_err = all.iter().find(|t| t["id"] == tid_err).unwrap();
        assert_eq!(stored_err["status"], json!("error"));
        assert!(stored_err.get("turnFailure").is_some());
    }

    #[test]
    fn pump_handle_sync_persists_initial_transport_handle_once_without_reclobbering_after_eviction() {
        let tid: &'static str = Box::leak(format!("pump-sync-{}", uuid::Uuid::new_v4().simple()).into_boxed_str());
        let _c = HeadlessProbe { thread_id: tid, run_id: "pump-sync-unused" };
        {
            let mut items = threads().lock().unwrap();
            items.push(json!({
                "id": tid,
                "title": "Pump Sync Test",
                "provider": "antigravity",
                "providerSessionId": Value::Null,
                "items": []
            }));
        }

        let mut last_synced_handle: Option<String> = None;
        let first = crate::chat::runtime::turn::resolve_pump_sync_handle(
            None,
            Some("84ad339b-init-handle"),
            last_synced_handle.as_deref(),
        );
        assert_eq!(first, Some("84ad339b-init-handle"));
        if let Some(h) = first {
            crate::chat::runtime::state::sync_thread_provider_session_id_for_provider(
                tid,
                Some("antigravity"),
                Some(h),
            );
            last_synced_handle = Some(h.to_string());
        }
        assert_eq!(
            threads().lock().unwrap().iter().find(|t| t["id"] == tid).unwrap()["providerSessionId"],
            json!("84ad339b-init-handle"),
            "initial transport resume handle must be persisted before TurnEnded/fallback stop"
        );

        // Simulate mid-turn account eviction clearing providerSessionId and record.resume_handle.
        {
            let mut items = threads().lock().unwrap();
            if let Some(pos) = items.iter().position(|t| t["id"] == tid) {
                crate::chat::runtime::state::clear_provider_thread_handles(
                    &mut items[pos..=pos],
                    "antigravity",
                );
            }
        }
        let after_evict = crate::chat::runtime::turn::resolve_pump_sync_handle(
            None,
            Some("84ad339b-init-handle"),
            last_synced_handle.as_deref(),
        );
        assert_eq!(
            after_evict, None,
            "transport handle must not re-clobber providerSessionId after mid-turn eviction"
        );
        assert_eq!(
            threads().lock().unwrap().iter().find(|t| t["id"] == tid).unwrap()["providerSessionId"],
            Value::Null
        );

        // A subsequent confirmed SessionRecord.resume_handle still syncs when distinct.
        let rotated = crate::chat::runtime::turn::resolve_pump_sync_handle(
            Some("rotated-session-handle"),
            Some("rotated-session-handle"),
            last_synced_handle.as_deref(),
        );
        assert_eq!(rotated, Some("rotated-session-handle"));
    }

    #[test]
    fn cancel_chat_turn_preserve_children_keeps_active_subagent_and_swarm_worker_alive_while_explicit_stop_kills_them() {
        let parent_id: &'static str =
            Box::leak(format!("steer-parent-{}", uuid::Uuid::new_v4().simple()).into_boxed_str());
        let child_id: &'static str =
            Box::leak(format!("steer-child-{}", uuid::Uuid::new_v4().simple()).into_boxed_str());
        let swarm_child_id: &'static str =
            Box::leak(format!("steer-swarm-{}", uuid::Uuid::new_v4().simple()).into_boxed_str());
        let parent_run_id: &'static str =
            Box::leak(format!("steer-prun-{}", uuid::Uuid::new_v4().simple()).into_boxed_str());
        let child_run_id: &'static str =
            Box::leak(format!("steer-crun-{}", uuid::Uuid::new_v4().simple()).into_boxed_str());
        let swarm_run_id: &'static str =
            Box::leak(format!("steer-srun-{}", uuid::Uuid::new_v4().simple()).into_boxed_str());

        let _p_guard = HeadlessProbe { thread_id: parent_id, run_id: parent_run_id };
        let _c_guard = HeadlessProbe { thread_id: child_id, run_id: child_run_id };
        let _s_guard = HeadlessProbe { thread_id: swarm_child_id, run_id: swarm_run_id };

        {
            let mut items = threads().lock().unwrap();
            items.push(json!({
                "id": parent_id,
                "title": "Parent Orchestrator",
                "provider": "antigravity",
                "status": "running",
                "items": [
                    { "id": "u1", "kind": "user", "text": "Delegate work" },
                    {
                        "id": "call-sub-1",
                        "kind": "tool",
                        "toolKind": "subagent",
                        "toolName": "kite_subagent_run",
                        "title": "Subagent · Researcher",
                        "status": "running",
                        "streaming": true,
                        "text": "",
                        "subagentMeta": {
                            "subagentId": "sub-1",
                            "role": "Researcher",
                            "childThreadId": child_id,
                            "status": "running"
                        }
                    },
                    {
                        "id": "call-cmd-1",
                        "kind": "tool",
                        "toolKind": "commandExecution",
                        "toolName": "run_command",
                        "title": "Parent command",
                        "status": "running",
                        "streaming": true,
                        "text": ""
                    }
                ],
                "subagentRuns": [
                    {
                        "subagentId": "sub-1",
                        "parentThreadId": parent_id,
                        "parentToolCallId": "call-sub-1",
                        "role": "Researcher",
                        "provider": "grok",
                        "model": "grok-fast",
                        "status": "running",
                        "childThreadId": child_id,
                        "stepCount": 1,
                        "items": [],
                        "startedAtUnixMs": 1000,
                        "updatedAtUnixMs": 1000
                    }
                ],
                "swarmState": {
                    "title": "Audit Swarm",
                    "members": [
                        {
                            "name": "worker-1",
                            "state": "working",
                            "childThreadId": swarm_child_id
                        }
                    ]
                }
            }));
            items.push(json!({
                "id": child_id,
                "parentThreadId": parent_id,
                "startedByAgent": true,
                "provider": "grok",
                "status": "running",
                "items": []
            }));
            items.push(json!({
                "id": swarm_child_id,
                "parentThreadId": parent_id,
                "startedByAgent": true,
                "provider": "grok",
                "status": "running",
                "items": []
            }));
        }

        let make_run = |asst_id: &str| TurnRun {
            revision: "rev".into(),
            events: Vec::new(),
            next_sequence: 0,
            assistant_id: asst_id.into(),
            assistant_text: String::new(),
            child: None,
            stdin: None,
            closing: false,
            finished: false,
            started_at_ms: now_ms(),
            finished_at_ms: None,
            routine_id: None,
            delivered_through: 0,
            file_baselines: std::collections::HashMap::new(),
        };
        {
            let mut live = live_turns().lock().unwrap();
            live.runs.insert(parent_run_id.to_string(), make_run("pa"));
            live.by_thread.insert(parent_id.to_string(), parent_run_id.to_string());
            live.runs.insert(child_run_id.to_string(), make_run("ca"));
            live.by_thread.insert(child_id.to_string(), child_run_id.to_string());
            live.runs.insert(swarm_run_id.to_string(), make_run("sa"));
            live.by_thread.insert(swarm_child_id.to_string(), swarm_run_id.to_string());
        }

        // 1. Steer / Send now cancel: preserveChildren = true must interrupt ONLY the parent turn.
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(crate::chat_commands::cancel_chat_turn(Some(json!({
            "threadId": parent_id,
            "preserveChildren": true
        }))));

        assert!(!is_turn_running(parent_id), "parent live turn must stop on steer cancel");
        assert!(is_turn_running(child_id), "async child subagent must stay alive on steer cancel");
        assert!(is_turn_running(swarm_child_id), "swarm worker must stay alive on steer cancel");
        assert!(!crate::chat::kill_registry::is_thread_killed(child_id));

        {
            let all = threads().lock().unwrap();
            let parent = all.iter().find(|t| t["id"] == parent_id).unwrap();
            assert_eq!(parent["status"], json!("idle"));
            assert_eq!(parent["subagentRuns"][0]["status"], json!("running"));
            assert_eq!(parent["swarmState"]["members"][0]["state"], json!("working"));
            let sub_item = parent["items"].as_array().unwrap().iter().find(|it| it["id"] == "call-sub-1").unwrap();
            assert_eq!(sub_item["status"], json!("running"));
            assert_eq!(sub_item["subagentMeta"]["status"], json!("running"));
            assert_eq!(sub_item["streaming"], json!(true));
            let cmd_item = parent["items"].as_array().unwrap().iter().find(|it| it["id"] == "call-cmd-1").unwrap();
            assert_eq!(cmd_item["status"], json!("stopped"));
            assert_eq!(cmd_item["streaming"], json!(false));

            let child = all.iter().find(|t| t["id"] == child_id).unwrap();
            assert_eq!(child["status"], json!("running"));
        }

        // 2. Explicit Stop button (default preserveChildren = false) MUST still stop parent + children.
        rt.block_on(crate::chat_commands::cancel_chat_turn(Some(json!({
            "threadId": parent_id
        }))));

        assert!(!is_turn_running(child_id), "explicit Stop must cancel child subagent");
        assert!(!is_turn_running(swarm_child_id), "explicit Stop must cancel swarm worker");
        {
            let all = threads().lock().unwrap();
            let parent = all.iter().find(|t| t["id"] == parent_id).unwrap();
            assert_eq!(parent["subagentRuns"][0]["status"], json!("killed"));
            assert_eq!(parent["swarmState"]["members"][0]["state"], json!("stopped"));
        }
        crate::chat::kill_registry::clear_thread_killed(child_id);
        crate::chat::kill_registry::clear_thread_killed(swarm_child_id);
    }

    #[test]
    fn cancel_chat_turn_preserve_children_without_live_run_heals_parent_without_killing_active_child_subagent() {
        let parent_id: &'static str =
            Box::leak(format!("steer-orphan-parent-{}", uuid::Uuid::new_v4().simple()).into_boxed_str());
        let child_id: &'static str =
            Box::leak(format!("steer-orphan-child-{}", uuid::Uuid::new_v4().simple()).into_boxed_str());
        let child_run_id: &'static str =
            Box::leak(format!("steer-orphan-crun-{}", uuid::Uuid::new_v4().simple()).into_boxed_str());

        let _p_guard = HeadlessProbe { thread_id: parent_id, run_id: "steer-orphan-unused" };
        let _c_guard = HeadlessProbe { thread_id: child_id, run_id: child_run_id };

        {
            let mut items = threads().lock().unwrap();
            items.push(json!({
                "id": parent_id,
                "title": "Orphan Parent",
                "provider": "antigravity",
                "status": "running",
                "items": [
                    {
                        "id": "call-sub-orphan",
                        "kind": "tool",
                        "toolKind": "subagent",
                        "toolName": "kite_subagent_run",
                        "status": "running",
                        "streaming": true,
                        "text": "",
                        "subagentMeta": {
                            "subagentId": "sub-orphan-1",
                            "role": "Executor",
                            "childThreadId": child_id,
                            "status": "running"
                        }
                    }
                ],
                "subagentRuns": [
                    {
                        "subagentId": "sub-orphan-1",
                        "parentThreadId": parent_id,
                        "parentToolCallId": "call-sub-orphan",
                        "role": "Executor",
                        "status": "running",
                        "childThreadId": child_id,
                        "stepCount": 1,
                        "items": [],
                        "startedAtUnixMs": 1000,
                        "updatedAtUnixMs": 1000
                    }
                ]
            }));
            items.push(json!({
                "id": child_id,
                "parentThreadId": parent_id,
                "startedByAgent": true,
                "provider": "grok",
                "status": "running",
                "items": []
            }));
        }
        {
            let mut live = live_turns().lock().unwrap();
            live.runs.insert(
                child_run_id.to_string(),
                TurnRun {
                    revision: "rev".into(),
                    events: Vec::new(),
                    next_sequence: 0,
                    assistant_id: "ca".into(),
                    assistant_text: String::new(),
                    child: None,
                    stdin: None,
                    closing: false,
                    finished: false,
                    started_at_ms: now_ms(),
                    finished_at_ms: None,
                    routine_id: None,
                    delivered_through: 0,
                    file_baselines: std::collections::HashMap::new(),
                },
            );
            live.by_thread.insert(child_id.to_string(), child_run_id.to_string());
        }

        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(crate::chat_commands::cancel_agent_chat_turn(Some(json!({
            "threadId": parent_id,
            "preserveChildren": true
        }))));

        assert!(is_turn_running(child_id), "child subagent must stay alive even when parent has no live run");
        let all = threads().lock().unwrap();
        let parent = all.iter().find(|t| t["id"] == parent_id).unwrap();
        assert_eq!(parent["status"], json!("idle"));
        assert_eq!(parent["subagentRuns"][0]["status"], json!("running"));
        assert_eq!(parent["items"][0]["status"], json!("running"));
        assert_eq!(parent["items"][0]["streaming"], json!(true));
    }

    #[test]
    fn active_background_subagents_context_appends_running_children_and_dedups_in_assemble_thread_context() {
        let thread = json!({
            "id": "parent-ctx-1",
            "provider": "antigravity",
            "model": "gemini-4-argon",
            "items": [
                { "id": "u1", "kind": "user", "text": "Start audit", "streaming": false },
                { "id": "a1", "kind": "assistant", "text": "Launched subagent.", "streaming": false },
                { "id": "u2", "kind": "user", "text": "Also consider edge case B", "streaming": false }
            ],
            "subagentRuns": [
                {
                    "subagentId": "sub-active",
                    "parentThreadId": "parent-ctx-1",
                    "parentToolCallId": "c1",
                    "role": "Code Researcher",
                    "provider": "grok",
                    "model": "grok-fast",
                    "status": "running",
                    "childThreadId": "child-active-1"
                },
                {
                    "subagentId": "sub-done",
                    "parentThreadId": "parent-ctx-1",
                    "parentToolCallId": "c2",
                    "role": "Old Runner",
                    "status": "completed",
                    "childThreadId": "child-done-1"
                }
            ],
            "swarmState": {
                "members": [
                    { "name": "worker-a", "role": "Tester", "state": "working", "childThreadId": "swarm-child-1" },
                    { "name": "worker-b", "role": "Idle", "state": "waiting", "childThreadId": "swarm-child-2" }
                ]
            }
        });

        let enriched = crate::chat::runtime::turn::append_active_subagents_context(
            &thread,
            "Also consider edge case B",
        );
        assert!(enriched.starts_with("Also consider edge case B"));
        assert!(enriched.contains("[Active Background Subagents]"));
        assert!(enriched.contains("thread:child-active-1"));
        assert!(enriched.contains("role: Code Researcher"));
        assert!(enriched.contains("model: grok/grok-fast"));
        assert!(enriched.contains("thread:swarm-child-1"));
        assert!(enriched.contains("member: @worker-a"));
        assert!(!enriched.contains("child-done-1"), "completed subagents must not be listed");
        assert!(!enriched.contains("swarm-child-2"), "waiting swarm workers must not be listed");

        // assemble_thread_context must deduplicate the trailing user message even with appended context
        let assembled = assemble_thread_context(&thread, &enriched);
        let occurrences = assembled.matches("Also consider edge case B").count();
        assert_eq!(
            occurrences, 1,
            "current user message must not be duplicated in assembled history: {assembled}"
        );
        assert!(assembled.contains("[Active Background Subagents]"));

        // When no active async subagents remain, prompt stays verbatim
        let idle_thread = json!({
            "id": "parent-ctx-2",
            "subagentRuns": [
                { "subagentId": "sub-done", "status": "completed", "childThreadId": "child-done-1" }
            ]
        });
        assert_eq!(
            crate::chat::runtime::turn::append_active_subagents_context(&idle_thread, "Plain message"),
            "Plain message"
        );
    }

    struct AcpWireTestGuard {
        tid: String,
        rid: String,
    }

    impl Drop for AcpWireTestGuard {
        fn drop(&mut self) {
            clear_acp_approval_wire(&self.tid);
            clear_session_auto_approved(&self.tid);
            {
                let mut live = live_turns().lock().unwrap();
                live.runs.remove(&self.rid);
                live.by_thread.remove(&self.tid);
            }
            {
                let mut items = threads().lock().unwrap();
                items.retain(|t| t.get("id").and_then(Value::as_str) != Some(self.tid.as_str()));
            }
            notifications()
                .lock()
                .unwrap()
                .retain(|n| n.pointer("/target/id").and_then(Value::as_str) != Some(self.tid.as_str()));
        }
    }

    #[test]
    fn acp_accept_edits_prompts_for_run_command_and_session_allow_persists_until_cleared() {
        let uid = uuid::Uuid::new_v4().simple().to_string();
        let tid = format!("acp-wire-t-{uid}");
        let rid = format!("acp-wire-r-{uid}");
        let _guard = AcpWireTestGuard {
            tid: tid.clone(),
            rid: rid.clone(),
        };

        threads().lock().unwrap().push(json!({
            "id": tid,
            "status": "running",
            "title": "ACP Permission Test",
            "provider": "antigravity",
            "mode": "acceptEdits",
            "items": []
        }));
        {
            let mut live = live_turns().lock().unwrap();
            live.runs.insert(
                rid.clone(),
                TurnRun {
                    revision: "rev-acp".into(),
                    events: Vec::new(),
                    next_sequence: 0,
                    assistant_id: "asst-acp".into(),
                    assistant_text: String::new(),
                    child: None,
                    stdin: None,
                    closing: false,
                    finished: false,
                    started_at_ms: now_ms(),
                    finished_at_ms: None,
                    routine_id: None,
                    delivered_through: 0,
                    file_baselines: std::collections::HashMap::new(),
                },
            );
            live.by_thread.insert(tid.clone(), rid.clone());
        }

        let handled = apply_known_turn_pipeline(
            &tid,
            &rid,
            "asst-acp",
            &json!({
                "jsonrpc": "2.0",
                "method": "session/request_permission",
                "params": {
                    "sessionId": "s-1",
                    "toolCall": {
                        "toolCallId": "call_1",
                        "name": "run_command",
                        "kind": "execute",
                        "title": "git status",
                        "rawInput": { "CommandLine": "git status" }
                    },
                    "options": [
                        { "optionId": "allow", "name": "Allow", "kind": "allow_once" },
                        { "optionId": "deny", "name": "Deny", "kind": "reject_once" }
                    ]
                },
                "id": "1"
            }),
        );
        assert!(handled);

        let stored = threads()
            .lock()
            .unwrap()
            .iter()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(tid.as_str()))
            .cloned()
            .unwrap();
        assert_eq!(stored["status"], json!("waiting"));
        assert_eq!(stored["pendingApproval"]["id"], json!("1"));
        assert_eq!(stored["pendingApproval"]["toolName"], json!("run_command"));
        assert_eq!(stored["pendingApproval"]["command"], json!("git status"));

        let notif_exists = notifications()
            .lock()
            .unwrap()
            .iter()
            .any(|n| n.get("id").and_then(Value::as_str) == Some("1")
                && n.pointer("/target/id").and_then(Value::as_str) == Some(tid.as_str()));
        assert!(notif_exists, "needsInput notification must be emitted for ACP command approval");

        write_approval_to_run(&tid, "1", "allowForSession");

        let after_reply = threads()
            .lock()
            .unwrap()
            .iter()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(tid.as_str()))
            .cloned()
            .unwrap();
        assert!(after_reply["pendingApproval"].is_null());
        assert_eq!(after_reply["status"], json!("running"));

        // Next command permission in same session should auto-approve instead of re-opening modal
        let handled_second = apply_known_turn_pipeline(
            &tid,
            &rid,
            "asst-acp",
            &json!({
                "jsonrpc": "2.0",
                "method": "session/request_permission",
                "params": {
                    "sessionId": "s-1",
                    "toolCall": {
                        "toolCallId": "call_2",
                        "name": "run_command",
                        "rawInput": { "CommandLine": "cargo test" }
                    },
                    "options": [{ "optionId": "allow", "kind": "allow_once" }]
                },
                "id": "2"
            }),
        );
        assert!(handled_second);
        let after_second = threads()
            .lock()
            .unwrap()
            .iter()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(tid.as_str()))
            .cloned()
            .unwrap();
        assert!(after_second["pendingApproval"].is_null());
    }

    #[test]
    fn multiplexed_caller_correlation_isolates_concurrent_sibling_threads() {
        crate::chat::runtime::clear_in_flight_dispatch_calls_for_test();
        let tid_a = format!("mux-thread-a-{}", uuid::Uuid::new_v4().simple());
        let tid_b = format!("mux-thread-b-{}", uuid::Uuid::new_v4().simple());

        crate::chat::runtime::register_in_flight_dispatch_call(
            crate::chat::runtime::InFlightDispatchCall {
                thread_id: tid_a.clone(),
                tool_call_id: "call_a_1".into(),
                tool_name: "kite_subagent_run".into(),
                role: Some("Frontend Auditor".into()),
                prompt: Some("Audit CSS tokens in src/".into()),
                tasks: Vec::new(),
                command: None,
                swarm_action: None,
                swarm_member: None,
                swarm_title: None,
                created_at_ms: crate::chat::utils::now_ms(),
                claimed: false,
            },
        );
        crate::chat::runtime::register_in_flight_dispatch_call(
            crate::chat::runtime::InFlightDispatchCall {
                thread_id: tid_b.clone(),
                tool_call_id: "call_b_1".into(),
                tool_name: "kite_subagent_run".into(),
                role: Some("Backend Verifier".into()),
                prompt: Some("Verify ACP daemon pool isolation".into()),
                tasks: Vec::new(),
                command: None,
                swarm_action: None,
                swarm_member: None,
                swarm_title: None,
                created_at_ms: crate::chat::utils::now_ms(),
                claimed: false,
            },
        );

        let mux_req = json!({
            "from": "",
            "threadMode": true,
            "multiplexedDaemon": true
        });
        let argv_b: Vec<String> = vec![
            "kite",
            "dispatch",
            "run",
            "--via",
            "thread",
            "--role",
            "Backend Verifier",
            "Verify ACP daemon pool isolation",
        ]
        .into_iter()
        .map(String::from)
        .collect();
        let resolved_b =
            crate::dispatch_wire::server::resolve_multiplexed_caller_thread(&mux_req, &argv_b);
        assert_eq!(resolved_b.as_deref(), Some(tid_b.as_str()));

        let argv_a: Vec<String> = vec![
            "kite",
            "dispatch",
            "run",
            "--via",
            "thread",
            "--role",
            "Frontend Auditor",
            "Audit CSS tokens in src/",
        ]
        .into_iter()
        .map(String::from)
        .collect();
        let resolved_a =
            crate::dispatch_wire::server::resolve_multiplexed_caller_thread(&mux_req, &argv_a);
        assert_eq!(resolved_a.as_deref(), Some(tid_a.as_str()));

        // Ambiguous ties across two threads must return None instead of leaking across threads.
        crate::chat::runtime::clear_in_flight_dispatch_calls_for_test();
        for tid in [&tid_a, &tid_b] {
            crate::chat::runtime::register_in_flight_dispatch_call(
                crate::chat::runtime::InFlightDispatchCall {
                    thread_id: tid.clone(),
                    tool_call_id: format!("call_tie_{tid}"),
                    tool_name: "kite_subagent_run".into(),
                    role: Some("Worker".into()),
                    prompt: Some("Identical prompt".into()),
                    tasks: Vec::new(),
                    command: None,
                    swarm_action: None,
                    swarm_member: None,
                    swarm_title: None,
                    created_at_ms: crate::chat::utils::now_ms(),
                    claimed: false,
                },
            );
        }
        let argv_tie: Vec<String> = vec![
            "kite",
            "dispatch",
            "run",
            "--via",
            "thread",
            "--role",
            "Worker",
            "Identical prompt",
        ]
        .into_iter()
        .map(String::from)
        .collect();
        assert_eq!(
            crate::dispatch_wire::server::resolve_multiplexed_caller_thread(&mux_req, &argv_tie),
            None
        );
        crate::chat::runtime::clear_in_flight_dispatch_calls_for_test();
    }

    #[test]
    fn wait_timeout_receipt_heals_persisted_false_failed_subagent_state() {
        let mut thread =
            crate::chat::threads::blank_thread("heal-timeout-1", None, "Parent", "antigravity", None);
        let timeout_json = json!({
            "schemaVersion": 1,
            "id": "cli",
            "op": "wait",
            "status": "failed",
            "address": "thread:child-healed-1",
            "submitted": false,
            "error": "timeout"
        })
        .to_string();
        thread["items"] = json!([{
            "id": "call_timeout_1",
            "kind": "tool",
            "toolKind": "subagent",
            "toolName": "kite_subagent_run",
            "title": "Subagent · Auditor",
            "status": "failed",
            "streaming": false,
            "text": timeout_json,
            "subagentMeta": {
                "subagentId": "child-healed-1",
                "childThreadId": "child-healed-1",
                "role": "Auditor",
                "status": "failed",
                "latestActivity": timeout_json,
                "stepCount": 6
            }
        }]);
        thread["subagentRuns"] = json!([{
            "subagentId": "child-healed-1",
            "parentThreadId": "heal-timeout-1",
            "parentToolCallId": "call_timeout_1",
            "childThreadId": "child-healed-1",
            "role": "Auditor",
            "status": "failed",
            "latestActivity": timeout_json,
            "stepCount": 6,
            "items": [{
                "id": "asst-1",
                "kind": "assistant",
                "text": "Audit complete with zero blockers."
            }]
        }]);

        crate::chat::subagents::reconcile_duplicate_subagent_state(&mut thread);

        assert_eq!(thread["subagentRuns"][0]["status"], json!("completed"));
        assert!(
            thread["subagentRuns"][0].get("latestActivity").is_none(),
            "bogus wait-timeout latestActivity must be cleared"
        );
        assert_eq!(thread["items"][0]["status"], json!("completed"));
        assert_eq!(thread["items"][0]["subagentMeta"]["status"], json!("completed"));
    }
