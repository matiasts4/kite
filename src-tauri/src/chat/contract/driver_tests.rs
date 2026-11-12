//! Tests covering driver declarations, one-shot argv, persistent transport selection, and framing.

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::json;

use crate::chat::drivers::declaration;
use crate::chat::normalize::{normalize_frame, replay_fixture, NormalizedEvent};
use crate::chat::persistent::{has_persistent_wire, AntigravitySession, PersistentControls};
use crate::chat::provider_env::{
    auth_recovery_instruction, environment_for, inherited_environment, Preservation,
};
use crate::chat::runtime::{
    one_shot_notice, resolve_send, select_persistent_transport, send_route, spawn_args,
    spawn_endpoint, ManagedSendError, SendRoute, SendValues,
};
use crate::chat::session::{
    declared_session_mode, SessionMode, SessionRecord, SessionState, SessionTransport, TransportEvent,
};

use super::helpers::*;

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
    for driver in ["claude", "cursor", "gemini"] {
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
        last_active_at_ms: 0,
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
        ("grok", "grok -p", "acceptEdits", &["-p", "hello", "--permission-mode", "default"]),
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
        let effort_sent = if driver == "opencode" {
            args.args
                .windows(2)
                .any(|pair| pair[0] == "--model" && pair[1].ends_with("#high"))
        } else {
            args.args
                .windows(2)
                .any(|pair| pair[0] == "--effort" && pair[1] == "high")
        };
        assert_eq!(effort_sent, declared.accepts_effort, "{driver} effort control");
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
        ("grok", Some(SessionMode::Persistent), true),
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
            "{driver} stays one command when the gate is off"
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
            matches!(driver, "antigravity" | "opencode" | "grok"),
            "{driver} served wire"
        );
    }

    // Claude was not observable on this machine: unknown stays unknown.
    let claude = declaration("claude").expect("claude declaration");
    assert_eq!(claude.session_mode, None);
    assert!(claude.version.is_none());
}
