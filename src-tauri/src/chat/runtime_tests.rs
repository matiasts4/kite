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
