//! Cross-module contract verification for the session layer.
//!
//! Test-only. This module proves the pieces compose: lifecycle, fallback,
//! normalization, recovery, and environment preservation.

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, HashSet};
    use std::fs;
    use std::path::{Path, PathBuf};

    use serde_json::{json, Value};

    use crate::chat::drivers::{declaration, DriverProbe, DriverVersion};
    use crate::chat::event_log::{
        recover_thread_with_snapshot, RecoverySource, ThreadEventKind, ThreadEventLog,
    };
    use crate::chat::normalize::{
        map_approval, normalize_frame, replay_fixture, ApprovalMapping, NormalizedEvent,
    };
    use crate::chat::persistent::{has_persistent_wire, AntigravitySession, PersistentControls};
    use crate::chat::provider_env::{
        auth_recovery_instruction, environment_for, inherited_environment, Preservation,
        ProviderEnvironment,
    };
    use crate::chat::runtime::{
        one_shot_notice, resolve_send, select_persistent_transport, send_route, spawn_args,
        spawn_endpoint, ManagedSendError, SendRoute, SendValues,
    };
    use crate::chat::session::{
        declared_session_mode, ApprovalDecision, AttachOutcome, RecipeSnapshot, ScriptedTransport,
        SessionError, SessionManager, SessionMode, SessionRecord, SessionSpec, SessionState,
        SessionTransport, TransportEvent, TransportSpec,
    };
    use crate::chat::threads::chat_item;

    const DRIVERS: [&str; 7] = [
        "antigravity",
        "claude",
        "codex",
        "cursor",
        "gemini",
        "grok",
        "opencode",
    ];

    const APPROVAL_REQUEST: &str =
        include_str!("../../tests/fixtures/approval.antigravity.stream.json");
    const APPROVAL_RESPONSE: &str =
        include_str!("../../tests/fixtures/approval.antigravity.response.json");
    const MALFORMED_FRAME: &str =
        include_str!("../../tests/fixtures/antigravity.malformed.frame.json");
    const OVERSIZED_FRAME: &str =
        include_str!("../../tests/fixtures/antigravity.oversized.frame.json");

    const THREAD_STATUS_READABLE: &str = "error";

    fn thread_base(thread_id: &str) -> Value {
        json!({
            "schemaVersion": 1,
            "revision": "rev-1",
            "id": thread_id,
            "profileId": Value::Null,
            "provider": "codex",
            "providerSessionId": Value::Null,
            "title": "Contract",
            "items": [],
            "plans": [],
            "mode": "acceptEdits",
            "plan": false,
            "model": Value::Null,
            "providerOptions": [],
            "status": "idle",
            "usage": { "inputTokens": 0, "outputTokens": 0, "costUsd": 0.0 },
            "workspaceId": Value::Null,
            "pinned": false,
            "pendingApproval": Value::Null,
            "createdAtUnixMs": 1_700_000_000_000i64,
            "updatedAtUnixMs": 1_700_000_000_000i64
        })
    }

    fn approval_value() -> Value {
        json!({
            "id": "approval-1",
            "toolName": "shell",
            "title": "Run a command",
            "detail": Value::Null,
            "risk": "low",
            "impact": "writes a file",
            "status": "pending"
        })
    }

    fn recipe(revision: &str) -> RecipeSnapshot {
        RecipeSnapshot {
            agent_id: "agent-contract".to_string(),
            revision: revision.to_string(),
            role: "the contract role".to_string(),
            memory: "the contract memory".to_string(),
            user: "the contract user".to_string(),
            skills: vec!["root-cause".to_string()],
        }
    }

    fn session_spec(
        thread_id: &str,
        driver: &str,
        mode: SessionMode,
        recipe: Option<RecipeSnapshot>,
    ) -> SessionSpec {
        SessionSpec {
            thread_id: thread_id.to_string(),
            driver: driver.to_string(),
            connection_id: Some("connection-contract".to_string()),
            working_directory: Some("E:/kite".to_string()),
            mode,
            recipe,
        }
    }

    fn transport_spec(driver: &str) -> TransportSpec {
        TransportSpec {
            session_id: "thread-contract:1".to_string(),
            driver: driver.to_string(),
            working_directory: None,
            mode: SessionMode::Persistent,
            recipe_revision: Some("r1".to_string()),
            resume_handle: None,
        }
    }

    /// A checked-in frame fixture's provider. A probe record is not a wire
    /// frame, so it is skipped. An unmapped fixture fails the test until its
    /// provider is declared, which keeps the replay set complete.
    fn fixture_provider(name: &str) -> Option<&'static str> {
        if name.starts_with("driver-") {
            return None;
        }
        for (marker, provider) in [
            ("antigravity", "antigravity"),
            ("acp", "acp"),
            ("claude", "claude"),
            ("codex", "codex"),
            ("unknown", "antigravity"),
            ("settled", "antigravity"),
        ] {
            if name.contains(marker) {
                return Some(provider);
            }
        }
        panic!("fixture {name} has no replay provider");
    }

    fn looks_secret(name: &str) -> bool {
        let upper = name.to_ascii_uppercase();
        ["KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL"]
            .iter()
            .any(|marker| upper.contains(marker))
    }

    fn environment_fields(environment: &ProviderEnvironment) -> Vec<&str> {
        std::iter::once(environment.driver.as_str())
            .chain(std::iter::once(environment.auth_source.as_str()))
            .chain(std::iter::once(environment.auth_recovery.as_str()))
            .chain(environment.inherited_names.iter().map(String::as_str))
            .chain(environment.mcp_sources.iter().map(String::as_str))
            .collect()
    }

    /// A scratch directory outside the worktree, removed on drop.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "kite-contract-{label}-{}",
                uuid::Uuid::new_v4().simple()
            ));
            fs::create_dir_all(&path).expect("create temp dir");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }

        fn join(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }

        fn write(&self, relative: &str, contents: &str) {
            let path = self.0.join(relative);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).expect("create fixture directory");
            }
            fs::write(path, contents).expect("write fixture");
        }

        fn snapshot(&self) -> BTreeMap<PathBuf, Vec<u8>> {
            let mut files = BTreeMap::new();
            let mut pending = vec![self.0.clone()];
            while let Some(directory) = pending.pop() {
                for entry in fs::read_dir(&directory).expect("read temp dir") {
                    let entry = entry.expect("read temp dir entry");
                    let path = entry.path();
                    if entry.file_type().expect("temp entry type").is_dir() {
                        pending.push(path);
                    } else {
                        let relative = path
                            .strip_prefix(&self.0)
                            .expect("relative fixture path")
                            .to_path_buf();
                        files.insert(relative, fs::read(&path).expect("read temp file"));
                    }
                }
            }
            files
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// A probe that reports a version below the declared minimum. It starts no
    /// process, so the version gate can be exercised on any machine.
    #[derive(Debug)]
    struct StaleVersionProbe;

    impl DriverProbe for StaleVersionProbe {
        fn probe(
            &self,
            _driver: &str,
            _program: &Path,
            _evidence: &DriverVersion,
        ) -> Result<String, String> {
            Ok("agy 1.0.0".to_string())
        }
    }

    /// S1, S3, S4, S10, S16, S17, S18.
    #[test]
    fn a_scripted_session_keeps_one_process_per_thread_and_attaches_once() {
        let mut manager = SessionManager::new();
        let first = ScriptedTransport::new();
        let duplicate_attempt = ScriptedTransport::new();
        let second = ScriptedTransport::new();
        let recipe = recipe("r1");

        manager
            .attach(
                session_spec("thread-1", "codex", SessionMode::Persistent, Some(recipe.clone())),
                Box::new(first.clone()),
            )
            .unwrap();
        let again = manager
            .attach(
                session_spec("thread-1", "codex", SessionMode::Persistent, Some(recipe.clone())),
                Box::new(duplicate_attempt.clone()),
            )
            .unwrap();

        assert_eq!(
            again,
            AttachOutcome::AlreadyAttached {
                generation: 1,
                state: SessionState::Prepared
            },
            "attaching a thread twice keeps the first session"
        );
        assert_eq!(first.spawn_count(), 0, "attach starts nothing");
        assert_eq!(duplicate_attempt.spawn_count(), 0);

        manager
            .attach(
                session_spec("thread-2", "codex", SessionMode::Persistent, Some(recipe)),
                Box::new(second.clone()),
            )
            .unwrap();
        assert_eq!(manager.active_thread_count(), 2);

        assert_eq!(manager.start("thread-1").unwrap(), 1);
        assert_eq!(manager.start("thread-1").unwrap(), 1, "start is once");
        assert_eq!(manager.start("thread-2").unwrap(), 1);
        assert_eq!(first.spawn_count(), 1, "one process for the thread");
        assert_eq!(second.spawn_count(), 1);

        let first_spawn = &first.spawned_specs()[0];
        let second_spawn = &second.spawned_specs()[0];
        assert_ne!(
            first_spawn.session_id, second_spawn.session_id,
            "two threads of one agent are two sessions"
        );
        assert_eq!(
            first_spawn.recipe_revision.as_deref(),
            Some("r1"),
            "the recipe revision reaches the transport before the spawn"
        );
        assert_eq!(second_spawn.recipe_revision.as_deref(), Some("r1"));
        assert_eq!(
            first_spawn.working_directory, second_spawn.working_directory,
            "both threads share the workspace but not the process"
        );

        manager
            .send_turn("thread-1", "command-1", "first question")
            .unwrap();
        manager
            .send_turn("thread-1", "command-2", "second question")
            .unwrap();

        assert_eq!(
            first.written_turns(),
            vec!["first question".to_string(), "second question".to_string()],
            "a later turn carries only the new message"
        );
        assert!(
            !first
                .written_turns()
                .iter()
                .any(|turn| turn.contains("the contract role")),
            "the recipe is never repeated on a later turn"
        );
        assert_eq!(first.spawn_count(), 1, "the same process serves both turns");

        let replay = manager
            .send_turn("thread-1", "command-2", "second question")
            .unwrap();
        assert!(replay.duplicate, "a command id is idempotent");
        assert_eq!(first.written_turns().len(), 2, "a replay writes nothing");

        let sequences: Vec<u64> = manager
            .events_since("thread-1", 0)
            .iter()
            .map(|event| event.sequence)
            .collect();
        assert!(
            sequences.windows(2).all(|pair| pair[0] < pair[1]),
            "durable event sequences are monotonic"
        );
        assert_eq!(
            manager.events_since("thread-1", sequences[0]).len(),
            sequences.len() - 1
        );
    }

    /// S10, S12, S13.
    #[test]
    fn an_approval_opens_resolves_and_an_exit_settles_the_rest() {
        let mut manager = SessionManager::new();
        let transport = ScriptedTransport::new();
        manager
            .attach(
                session_spec("thread-1", "antigravity", SessionMode::Persistent, None),
                Box::new(transport.clone()),
            )
            .unwrap();
        manager.start("thread-1").unwrap();

        let mut opened = normalize_frame("antigravity", APPROVAL_REQUEST);
        assert_eq!(opened.len(), 1, "the fixture is one request frame");
        let NormalizedEvent::ApprovalOpened { approval } = opened.remove(0) else {
            panic!("the approval fixture must open an approval");
        };
        transport.script(TransportEvent::ApprovalRequest {
            id: approval.id.clone(),
            kind: approval.risk.clone(),
        });
        manager.poll("thread-1").unwrap();

        let waiting = manager.status("thread-1").unwrap();
        assert_eq!(waiting.state, SessionState::Waiting);
        assert_eq!(waiting.pending_approvals, vec![approval.id.clone()]);
        assert!(
            manager
                .events_since("thread-1", 0)
                .iter()
                .any(|event| event.kind == "approvalOpened"
                    && event.payload["requestId"].as_str() == Some(approval.id.as_str())),
            "the approval is on the thread with the provider-issued id"
        );

        let ApprovalMapping::Decision(decision) =
            map_approval("antigravity", APPROVAL_RESPONSE)
        else {
            panic!("the response fixture must map onto the canonical vocabulary");
        };
        assert_eq!(decision, ApprovalDecision::AllowForSession);
        manager
            .respond_approval("thread-1", &approval.id, decision)
            .unwrap();

        let resolved = manager.status("thread-1").unwrap();
        assert_eq!(resolved.state, SessionState::Running);
        assert!(resolved.pending_approvals.is_empty());
        let resolution = manager
            .events_since("thread-1", 0)
            .into_iter()
            .find(|event| event.kind == "approvalResolved")
            .expect("a resolution event is recorded");
        assert_eq!(
            resolution.payload["requestId"].as_str(),
            Some(approval.id.as_str())
        );
        assert_eq!(
            resolution.payload["decision"].as_str(),
            Some("allowForSession")
        );

        // S12: the whole canonical vocabulary is available at the same
        // boundary, not only the token this fixture happened to carry.
        for decision in [
            ApprovalDecision::AllowOnce,
            ApprovalDecision::Deny,
            ApprovalDecision::DenyAndStop,
        ] {
            let raw = format!("{{\"decision\":\"{}\"}}", decision.as_str());
            assert_eq!(
                map_approval("antigravity", &raw),
                ApprovalMapping::Decision(decision),
                "{}",
                decision.as_str()
            );
        }

        let events_before = manager.events_since("thread-1", 0);
        let record_before = manager.status("thread-1").unwrap();
        let rejected = manager
            .respond_approval("thread-1", &approval.id, ApprovalDecision::Deny)
            .unwrap_err();
        assert_eq!(
            rejected,
            SessionError::UnknownApproval(approval.id.clone()),
            "an already-settled request cannot be settled twice"
        );
        assert_eq!(manager.events_since("thread-1", 0), events_before);
        assert_eq!(manager.status("thread-1").unwrap(), record_before);

        transport.script(TransportEvent::ApprovalRequest {
            id: "approval-exit".to_string(),
            kind: "command".to_string(),
        });
        manager.poll("thread-1").unwrap();
        manager
            .handle_exit("thread-1", Some(1), Some("the provider exited".to_string()))
            .unwrap();

        let failed = manager.status("thread-1").unwrap();
        assert_eq!(failed.state, SessionState::Failed);
        assert!(
            failed.pending_approvals.is_empty(),
            "an exit settles pending approvals"
        );
        assert!(manager
            .events_since("thread-1", 0)
            .iter()
            .any(|event| event.kind == "approvalSettled"
                && event.payload["requestId"].as_str() == Some("approval-exit")));
        assert!(manager
            .events_since("thread-1", 0)
            .iter()
            .any(|event| event.kind == "exited"));
    }

    /// S3, S13.
    #[test]
    fn resume_needs_a_provider_issued_handle() {
        let mut manager = SessionManager::new();
        let with_handle = ScriptedTransport::new().with_resume_handle("provider-handle-9");
        manager
            .attach(
                session_spec("thread-resume", "gemini", SessionMode::Resumable, None),
                Box::new(with_handle.clone()),
            )
            .unwrap();
        manager.start("thread-resume").unwrap();
        manager.handle_exit("thread-resume", Some(0), None).unwrap();

        let record = manager.status("thread-resume").unwrap();
        assert_eq!(record.state, SessionState::Resumable);
        assert_eq!(record.resume_handle.as_deref(), Some("provider-handle-9"));
        assert!(record.can_resume());

        manager.resume("thread-resume").unwrap();
        let spawns = with_handle.spawned_specs();
        assert_eq!(spawns.len(), 2);
        assert_eq!(
            spawns[1].resume_handle.as_deref(),
            Some("provider-handle-9"),
            "a resume passes the provider-issued handle, not a derived id"
        );

        let without_handle = ScriptedTransport::new();
        manager
            .attach(
                session_spec("thread-no-handle", "gemini", SessionMode::Resumable, None),
                Box::new(without_handle.clone()),
            )
            .unwrap();
        manager.start("thread-no-handle").unwrap();
        manager.handle_exit("thread-no-handle", Some(0), None).unwrap();

        let closed = manager.status("thread-no-handle").unwrap();
        assert_eq!(
            closed.state,
            SessionState::Closed,
            "no provider handle means no resumable state"
        );
        assert!(!closed.can_resume());
        assert_eq!(closed.resume_handle, None);
        assert_eq!(
            manager.resume("thread-no-handle").unwrap_err(),
            SessionError::NotResumable("thread-no-handle".to_string())
        );
        assert_eq!(without_handle.spawn_count(), 1, "a refused resume starts nothing");
    }

    /// S1, S10, S13.
    #[test]
    fn a_spawn_failure_keeps_the_prompt_and_leaves_the_thread_readable() {
        let prompt = "please keep this prompt";
        let mut log = ThreadEventLog::from_thread(&thread_base("thread-failure")).unwrap();
        log.append(
            ThreadEventKind::ItemUpsert,
            json!({ "item": chat_item("user-1", "user", prompt, false) }),
        )
        .unwrap();

        let mut manager = SessionManager::new();
        let transport = ScriptedTransport::new().failing_spawn("the provider binary is missing");
        manager
            .attach(
                session_spec("thread-failure", "codex", SessionMode::Persistent, None),
                Box::new(transport.clone()),
            )
            .unwrap();
        let error = manager.start("thread-failure").unwrap_err();

        assert_eq!(
            error,
            SessionError::SpawnFailed("the provider binary is missing".to_string())
        );
        let failed = manager.status("thread-failure").unwrap();
        assert_eq!(failed.state, SessionState::Failed);
        assert_eq!(transport.spawn_count(), 0);
        assert!(
            transport.written_turns().is_empty(),
            "no prompt reaches a process that never started"
        );
        assert!(manager
            .events_since("thread-failure", 0)
            .iter()
            .any(|event| event.kind == "failed"));

        log.append(
            ThreadEventKind::Lifecycle,
            json!({ "state": "failed", "reason": error.to_string() }),
        )
        .unwrap();

        let dir = TempDir::new("spawn-failure");
        let path = dir.join("thread.json");
        log.save_to(&path).unwrap();
        let recovered =
            recover_thread_with_snapshot("thread-failure", &path, Some(&thread_base("thread-failure")));

        assert_eq!(recovered.source, RecoverySource::Log);
        assert!(recovered.diagnostic.is_none());
        assert_eq!(recovered.thread["status"], THREAD_STATUS_READABLE);
        assert_eq!(recovered.thread["items"][0]["text"], prompt);
        assert_eq!(recovered.thread["items"].as_array().unwrap().len(), 1);
    }

    /// S7, S13, S14.
    #[test]
    fn a_version_mismatch_or_an_unsupported_wire_keeps_the_one_shot_fallback() {
        // S14: codex documents a lasting transport, so this build refuses its
        // wire explicitly instead of inventing a request frame.
        let refusal = select_persistent_transport("codex", PersistentControls::default())
            .expect_err("codex has no served lasting wire in this build");
        assert!(refusal.contains("Unsupported:"), "{refusal}");
        assert!(refusal.contains("app-server"), "{refusal}");
        assert!(refusal.contains("request frame"), "{refusal}");

        let unsupported = ManagedSendError::Start(refusal);
        assert!(
            unsupported.before_turn(),
            "selection failed before any turn was written"
        );
        let codex_fallback = spawn_args(
            "codex",
            "acceptEdits",
            &SendValues::default(),
            None,
            "keep this prompt",
        )
        .unwrap();
        assert!(
            codex_fallback
                .args
                .iter()
                .any(|arg| arg == "keep this prompt"),
            "the kept prompt still runs as one command"
        );

        // S14: a declared wire fails closed when the installed version is below
        // the declared minimum, before any process starts.
        let mut stale = AntigravitySession::with_probe(
            PersistentControls::default(),
            Some(PathBuf::from("kite-missing-agy-binary")),
            Box::new(StaleVersionProbe),
        );
        let version_error = stale.spawn(&transport_spec("antigravity")).unwrap_err();
        assert!(
            version_error.contains("older than the minimum"),
            "{version_error}"
        );
        assert!(version_error.contains("1.4.5"), "{version_error}");
        assert_eq!(stale.spawn_count(), 0, "a mismatch never starts a process");
        assert!(stale.drain().is_empty());

        let stale = ManagedSendError::Start(version_error);
        assert!(stale.before_turn());
        let antigravity_fallback = spawn_args(
            "antigravity",
            "acceptEdits",
            &SendValues::default(),
            None,
            "keep this prompt",
        )
        .unwrap();
        assert!(antigravity_fallback
            .args
            .iter()
            .any(|arg| arg == "keep this prompt"));
        assert!(antigravity_fallback
            .args
            .iter()
            .any(|arg| arg == "--output-format"));

        // S7: a connection alone does not authorize a send, and another
        // driver's endpoint is never accepted as this spawn's endpoint.
        let connection_only = SendValues {
            connection_id: Some("connection-contract"),
            ..SendValues::default()
        };
        let endpoint_error = resolve_send("codex", &connection_only).unwrap_err();
        assert!(endpoint_error.contains("endpoint"), "{endpoint_error}");
        let wrong_endpoint = SendValues {
            connection_id: Some("connection-contract"),
            supported_endpoint: Some("claude -p"),
            ..SendValues::default()
        };
        assert!(resolve_send("codex", &wrong_endpoint).is_err());
    }

    /// S4, S13.
    #[test]
    fn only_a_served_wire_can_keep_a_session() {
        // The declaration resolves to one command; no opt-in and no wiring can
        // promote it, and the thread says why.
        for driver in ["claude", "cursor", "gemini", "grok"] {
            let declared = declaration(driver).unwrap_or_else(|| panic!("{driver} declaration"));
            assert_eq!(
                declared_session_mode(&declared, true),
                SessionMode::OneShot,
                "{driver} must not be promoted by a declaration"
            );
            assert!(!has_persistent_wire(driver), "{driver}");
            assert!(
                select_persistent_transport(driver, PersistentControls::default()).is_err(),
                "{driver} has no served lasting wire"
            );
            let spec = session_spec("thread-1", driver, SessionMode::OneShot, None)
                .with_declared_mode(&declared, true);
            assert_eq!(spec.mode, SessionMode::OneShot);
            assert!(
                one_shot_notice(driver, true).is_some(),
                "the thread says why {driver} stays one command"
            );
            assert!(
                !spawn_args(driver, "acceptEdits", &SendValues::default(), None, "hello")
                    .unwrap()
                    .args
                    .is_empty(),
                "{driver} keeps a one-command form"
            );
        }

        // Codex declares a lasting channel, but this build refuses that wire.
        // The route may not start, so the caller falls back with a diagnostic
        // instead of reporting a persistent session.
        let codex = declaration("codex").expect("codex declaration");
        assert_eq!(codex.session_mode, Some(SessionMode::Persistent));
        assert!(!has_persistent_wire("codex"));
        assert!(select_persistent_transport("codex", PersistentControls::default()).is_err());
        assert!(one_shot_notice("codex", true).is_none());
        assert!(one_shot_notice("codex", false).is_some());

        // A one-shot record is never resumable, even with a handle attached.
        let invented = SessionRecord {
            thread_id: "thread-1".to_string(),
            session_id: "thread-1:1".to_string(),
            generation: 1,
            driver: "gemini".to_string(),
            connection_id: None,
            working_directory: None,
            mode: SessionMode::OneShot,
            state: SessionState::Running,
            recipe: None,
            resume_handle: Some("provider-handle-1".to_string()),
            started_at_ms: 0,
            next_sequence: 0,
            pending_approvals: Vec::new(),
        };
        assert!(!SessionMode::OneShot.keeps_process());
        assert!(!SessionMode::OneShot.accepts_another_turn());
        assert!(!invented.can_resume());
    }

    /// S11.
    #[test]
    fn a_malformed_frame_never_panics_and_becomes_a_bounded_notice() {
        let malformed = [
            "{\"event\":\"step_update\",\"step_update\":{\"text\":\"unterminated",
            "{\"kind\":\"telemetry\"",
            "{\"event\":123}",
            "{\"type\":null}",
            "[]",
            "null",
            "42",
            "\"text\"",
            "\u{0}\u{1}\u{2}",
            "   ",
        ];

        for raw in malformed {
            let events = normalize_frame("antigravity", raw);
            if raw.trim().is_empty() {
                assert!(events.is_empty(), "an empty frame has no event");
                continue;
            }
            assert_eq!(events.len(), 1, "{raw:?}");
            match &events[0] {
                NormalizedEvent::Notice {
                    provider,
                    code,
                    message,
                    hint,
                } => {
                    assert_eq!(provider, "antigravity");
                    assert!(!code.is_empty(), "{raw:?}");
                    assert!(
                        message.chars().count() <= 280,
                        "{raw:?} produced {} characters",
                        message.chars().count()
                    );
                    assert!(!hint.is_empty(), "{raw:?}");
                }
                other => panic!("{raw:?} must become a notice, got {other:?}"),
            }
        }

        // The JSON parser rejects deep nesting; it never reaches a transcript
        // unbounded and never panics.
        let mut deep = String::from("1");
        for _ in 0..300 {
            deep = format!("{{\"a\":{deep}}}");
        }
        assert!(matches!(
            normalize_frame("antigravity", &deep).as_slice(),
            [NormalizedEvent::Notice { .. }]
        ));

        let malformed_fixture = normalize_frame("antigravity", MALFORMED_FRAME);
        assert_eq!(malformed_fixture.len(), 1);
        match &malformed_fixture[0] {
            NormalizedEvent::Notice {
                provider,
                code,
                message,
                hint,
            } => {
                assert_eq!(provider, "antigravity");
                assert_eq!(code, "malformedFrame");
                assert!(message.chars().count() <= 280);
                assert!(hint.contains("event"));
            }
            other => panic!("the malformed fixture must become a notice, got {other:?}"),
        }

        let oversized = normalize_frame("agy", OVERSIZED_FRAME);
        assert_eq!(oversized.len(), 1);
        match &oversized[0] {
            NormalizedEvent::Notice {
                provider,
                code,
                message,
                hint,
            } => {
                assert_eq!(provider, "antigravity", "the alias is reported canonically");
                assert_eq!(code, "unknownEvent");
                assert!(
                    message.chars().count() <= 280,
                    "the message is bounded, got {}",
                    message.chars().count()
                );
                assert!(
                    message.chars().count() < OVERSIZED_FRAME.chars().count(),
                    "the raw payload is not copied into the transcript"
                );
                assert!(hint.contains("event"));
            }
            other => panic!("the oversized fixture must become a notice, got {other:?}"),
        }
    }

    /// S11.
    #[test]
    fn every_checked_in_frame_fixture_replays_identically_twice() {
        let directory = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures");
        let mut replayed = Vec::new();

        for entry in fs::read_dir(&directory).expect("fixture directory") {
            let path = entry.expect("fixture entry").path();
            let name = path
                .file_name()
                .expect("fixture name")
                .to_string_lossy()
                .to_string();
            let Some(provider) = fixture_provider(&name) else {
                continue;
            };
            let body = fs::read_to_string(&path).expect("fixture is text");

            let first = replay_fixture(provider, &body);
            let second = replay_fixture(provider, &body);
            assert_eq!(first, second, "{name} must replay identically");
            assert!(!first.is_empty(), "{name} must not drop every event");
            replayed.push(name);
        }

        for required in [
            "antigravity.malformed.frame.json",
            "antigravity.oversized.frame.json",
        ] {
            assert!(
                replayed.iter().any(|name| name == required),
                "{required} must be checked in and replayed"
            );
        }
        assert!(
            replayed.len() >= 11,
            "every frame fixture is replayed, got {}",
            replayed.len()
        );
    }

    /// S5, S6.
    #[test]
    fn a_provider_home_is_byte_identical_across_lookup_and_passthrough() {
        const SECRET: &str = "contract-secret-4f1c9a-not-a-real-credential";
        let home = TempDir::new("provider-home");
        home.write(
            "auth.json",
            &json!({ "token": SECRET }).to_string(),
        );
        home.write(
            "mcp.json",
            &json!({ "mcpServers": { "local": { "env": { "API_KEY": SECRET } } } }).to_string(),
        );
        home.write(
            "config.toml",
            "[mcp_servers.local]\ncommand = \"fixture\"\n",
        );
        home.write("antigravity/mcp_config.json", "{\"fixture\":true}");
        let before = home.snapshot();
        let home_text = home.path().to_string_lossy().to_string();

        let process_environment: Vec<(String, String)> = std::env::vars().collect();
        let process_secrets: Vec<(String, String)> = process_environment
            .iter()
            .filter(|(name, value)| looks_secret(name) && value.len() >= 8)
            .cloned()
            .collect();

        // S5: a signed-out CLI reports its own recovery instruction, and an
        // unobserved command is explicit about the unknown.
        assert_eq!(
            auth_recovery_instruction("claude").as_deref(),
            Some("claude login")
        );
        assert_eq!(
            auth_recovery_instruction("codex").as_deref(),
            Some("codex login")
        );
        for driver in ["antigravity", "cursor", "gemini", "grok", "opencode"] {
            let text = auth_recovery_instruction(driver).expect("known driver");
            assert!(
                text.starts_with("unknown:"),
                "{driver} recovery must not invent a command: {text}"
            );
        }
        assert!(auth_recovery_instruction("not-a-driver").is_none());

        for driver in DRIVERS {
            let environment = environment_for(driver).expect("known driver");
            assert_eq!(environment.driver, driver);
            assert_eq!(environment.mcp_preservation, Preservation::Unknown);
            assert_eq!(
                environment.auth_recovery,
                auth_recovery_instruction(driver).expect("known driver"),
                "{driver} keeps one recovery text"
            );

            for field in environment_fields(&environment) {
                assert!(
                    !field.contains(SECRET),
                    "{driver} stored a secret from the provider home"
                );
                assert!(
                    !field.contains(home_text.as_str()),
                    "{driver} resolved a provider path instead of naming it"
                );
                for (name, value) in &process_secrets {
                    assert!(
                        !field.contains(value.as_str()),
                        "{driver} leaked the value of {name}"
                    );
                }
            }
        }

        let passthrough = inherited_environment(&[]);
        assert_eq!(
            home.snapshot(),
            before,
            "lookup and passthrough must not write provider configuration"
        );

        let mut seen = HashSet::new();
        for (name, _) in &passthrough {
            assert!(seen.insert(name.clone()), "{name} has two entries");
        }
        let after: BTreeMap<String, String> = passthrough.into_iter().collect();
        for (name, value) in &process_environment {
            assert_eq!(
                after.get(name),
                Some(value),
                "{name} must pass through unchanged"
            );
        }
        for (name, value) in &process_secrets {
            assert_eq!(
                after.get(name),
                Some(value),
                "the inherited value of {name} stays under its own name"
            );
        }
    }

    /// S3, S10.
    #[test]
    fn a_corrupt_log_falls_back_to_the_stored_snapshot_without_writing() {
        let dir = TempDir::new("corrupt-log");
        let path = dir.join("thread.json");
        let garbage = b"{ not json".to_vec();
        fs::write(&path, &garbage).unwrap();
        let snapshot = thread_base("thread-corrupt");

        let recovered =
            recover_thread_with_snapshot("thread-corrupt", &path, Some(&snapshot));

        assert_eq!(recovered.source, RecoverySource::Snapshot);
        assert_eq!(recovered.thread, snapshot);
        assert!(recovered.events.is_empty());
        assert!(
            recovered
                .diagnostic
                .as_deref()
                .unwrap_or("")
                .contains("corrupt"),
            "{:?}",
            recovered.diagnostic
        );
        assert_eq!(fs::read(&path).unwrap(), garbage);
        assert_eq!(
            fs::read_dir(dir.path()).unwrap().count(),
            1,
            "recovery writes no temporary sibling"
        );
    }

    /// S10.
    #[test]
    fn folding_the_same_log_twice_is_identical() {
        let base = thread_base("thread-fold");
        let mut log = ThreadEventLog::from_thread(&base).unwrap();
        log.append(
            ThreadEventKind::ItemUpsert,
            json!({ "item": chat_item("user-1", "user", "do the thing", false) }),
        )
        .unwrap();
        log.append(ThreadEventKind::Lifecycle, json!({ "state": "running" }))
            .unwrap();
        log.append(
            ThreadEventKind::ItemUpsert,
            json!({ "item": chat_item("assistant-1", "assistant", "working", false) }),
        )
        .unwrap();
        log.append(
            ThreadEventKind::ApprovalOpened,
            json!({ "approval": approval_value() }),
        )
        .unwrap();
        log.append(
            ThreadEventKind::ApprovalResolved,
            json!({ "requestId": "approval-1", "decision": "denyAndStop" }),
        )
        .unwrap();
        log.append(ThreadEventKind::Lifecycle, json!({ "state": "interrupted" }))
            .unwrap();

        let first = log.fold(&base);
        let second = log.fold(&base);
        assert_eq!(first, second);
        assert_eq!(first["status"], "idle");
        assert!(first["pendingApproval"].is_null());
        assert_eq!(first["items"][0]["text"], "do the thing");

        log.compact(3).unwrap();
        assert_eq!(
            log.fold(&base),
            first,
            "compaction keeps the folded thread identical"
        );

        let dir = TempDir::new("fold");
        let path = dir.join("thread.json");
        log.save_to(&path).unwrap();
        let bytes = fs::read(&path).unwrap();
        let loaded = ThreadEventLog::load("thread-fold", &path).unwrap();
        assert_eq!(loaded.fold(&base), first);
        assert_eq!(fs::read(&path).unwrap(), bytes, "loading never rewrites");
    }

    /// S4, S9, S13, S17.
    #[test]
    fn the_one_shot_argv_stays_pinned_for_every_driver() {
        const READ_ONLY_PREFIX: &str = "Read-only mode: do not create, edit, or delete files.\n\n";

        let read_only = format!("{READ_ONLY_PREFIX}hello");
        let cases: &[(&str, &str, &str, &[&str])] = &[
            (
                "antigravity",
                "agy -p",
                "acceptEdits",
                &["-p", "hello", "--output-format", "stream-json", "--mode", "accept-edits"],
            ),
            (
                "antigravity",
                "agy -p",
                "readOnly",
                &[
                    "-p",
                    read_only.as_str(),
                    "--output-format",
                    "stream-json",
                    "--mode",
                    "plan",
                ],
            ),
            (
                "claude",
                "claude -p",
                "acceptEdits",
                &["-p", "--output-format", "text", "--permission-mode", "acceptEdits", "hello"],
            ),
            (
                "claude",
                "claude -p",
                "readOnly",
                &[
                    "-p",
                    "--output-format",
                    "text",
                    "--permission-mode",
                    "plan",
                    read_only.as_str(),
                ],
            ),
            (
                "codex",
                "codex exec",
                "acceptEdits",
                &["exec", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "--json", "hello"],
            ),
            (
                "codex",
                "codex exec",
                "readOnly",
                &[
                    "exec",
                    "--skip-git-repo-check",
                    "--sandbox",
                    "read-only",
                    "--json",
                    read_only.as_str(),
                ],
            ),
            ("cursor", "cursor-agent -p", "acceptEdits", &["-p", "hello"]),
            ("grok", "grok -p", "acceptEdits", &["-p", "--permission-mode", "acceptEdits", "hello"]),
            ("opencode", "opencode run", "acceptEdits", &["run", "--format", "json", "hello"]),
            ("gemini", "gemini --prompt", "acceptEdits", &["--prompt", "hello"]),
        ];

        for &(driver, endpoint, mode, expected) in cases {
            let args =
                spawn_args(driver, mode, &SendValues::default(), None, "hello").unwrap();
            assert_eq!(args.endpoint.endpoint_id, endpoint, "{driver} endpoint");
            let expected: Vec<String> = expected.iter().map(|arg| (*arg).to_string()).collect();
            assert_eq!(args.args, expected, "{driver} in {mode} mode");
        }

        // S9: a control reaches the one-shot command line only when the driver
        // declaration accepts it.
        for driver in DRIVERS {
            let declared = declaration(driver).unwrap_or_else(|| panic!("{driver} declaration"));
            let endpoint = spawn_endpoint(driver).unwrap_or_else(|| panic!("{driver} endpoint"));
            let values = SendValues {
                model: Some("contract-model"),
                session_id: Some("provider-handle-9"),
                ..SendValues::default()
            };
            let args = spawn_args(driver, "acceptEdits", &values, Some("high"), "hello").unwrap();
            let joined = args.args.join("\u{1f}");

            let model_expected =
                declared.accepts_model && endpoint.accepts_model && endpoint.model_by_default;
            assert_eq!(
                joined.contains("contract-model"),
                model_expected,
                "{driver} model control"
            );
            assert_eq!(
                joined.contains("--effort"),
                declared.accepts_effort,
                "{driver} effort control"
            );
            assert_eq!(
                joined.contains("provider-handle-9"),
                endpoint.accepts_session,
                "{driver} session control"
            );
            let permission_flag = [
                "--permission-mode",
                "--mode",
                "--dangerously-skip-permissions",
                "--dangerously-bypass-approvals-and-sandbox",
                "--full-auto",
                "--sandbox",
            ]
            .iter()
            .any(|flag| args.args.iter().any(|arg| arg == flag));
            // A control the declaration does not accept never reaches argv.
            if !declared.accepts_permission {
                assert!(
                    !permission_flag,
                    "{driver} must not pass an undeclared permission control"
                );
            } else {
                assert!(
                    permission_flag,
                    "{driver} must map its declared permission control"
                );
            }
        }
    }

    /// S4, S14, S17.
    #[test]
    fn every_driver_keeps_its_declared_session_mode() {
        // driver, declaration, a lasting wire this build can actually serve
        let expected: &[(&str, Option<SessionMode>, bool)] = &[
            ("antigravity", Some(SessionMode::Persistent), true),
            ("claude", None, false),
            ("codex", Some(SessionMode::Persistent), false),
            ("cursor", Some(SessionMode::Resumable), false),
            ("gemini", Some(SessionMode::Resumable), false),
            ("grok", Some(SessionMode::Resumable), false),
            ("opencode", Some(SessionMode::Persistent), true),
        ];

        for &(driver, declared_mode, lasting_available) in expected {
            let declared = declaration(driver).unwrap_or_else(|| panic!("{driver} declaration"));
            assert_eq!(declared.session_mode, declared_mode, "{driver} declaration");

            let promoted = declared_session_mode(&declared, true) == SessionMode::Persistent;
            assert_eq!(
                promoted,
                declared_mode == Some(SessionMode::Persistent),
                "{driver} must not be promoted by the helper"
            );

            assert_eq!(
                select_persistent_transport(driver, PersistentControls::default()).is_ok(),
                lasting_available,
                "{driver} lasting transport"
            );
            assert_eq!(
                has_persistent_wire(driver),
                lasting_available,
                "{driver} served wire"
            );
            assert_eq!(
                send_route(driver, false),
                SendRoute::OneShot,
                "{driver} stays one command without the opt-in"
            );
            assert!(
                one_shot_notice(driver, false).is_some(),
                "{driver} says each send is a new command"
            );
        }

        // Only the observed lasting wires may keep a process. A declaration
        // alone, a resume flag, or a parser is not enough.
        for driver in DRIVERS {
            assert_eq!(
                has_persistent_wire(driver),
                matches!(driver, "antigravity" | "opencode"),
                "{driver} served wire"
            );
        }

        // Claude was not observable on this machine: unknown stays unknown.
        let claude = declaration("claude").expect("claude declaration");
        assert_eq!(claude.session_mode, None);
        assert!(claude.version.is_none());
    }
}
