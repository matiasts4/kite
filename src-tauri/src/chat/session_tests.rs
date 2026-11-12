use super::*;
use crate::chat::drivers::declaration;

fn recipe(revision: &str, role: &str) -> RecipeSnapshot {
    RecipeSnapshot {
        agent_id: "agent-1".to_string(),
        revision: revision.to_string(),
        role: role.to_string(),
        memory: "memory".to_string(),
        user: "user".to_string(),
        skills: vec!["root-cause".to_string()],
    }
}

fn spec(thread_id: &str, mode: SessionMode, recipe: Option<RecipeSnapshot>) -> SessionSpec {
    SessionSpec {
        thread_id: thread_id.to_string(),
        driver: "codex".to_string(),
        connection_id: Some("connection-1".to_string()),
        working_directory: Some("E:/kite".to_string()),
        mode,
        recipe,
        resume_handle: None,
        extra_env: Vec::new(),
    }
}

fn attach(
    manager: &mut SessionManager,
    spec: SessionSpec,
    transport: ScriptedTransport,
) -> ScriptedTransport {
    manager.attach(spec, Box::new(transport.clone())).unwrap();
    transport
}

#[test]
fn attaching_a_thread_twice_keeps_one_session_and_starts_nothing() {
    let mut manager = SessionManager::new();
    let transport = attach(&mut manager, spec("thread-1", SessionMode::Persistent, None), ScriptedTransport::new());

    let second = manager
        .attach(spec("thread-1", SessionMode::Persistent, None), Box::new(ScriptedTransport::new()))
        .unwrap();

    assert_eq!(second, AttachOutcome::AlreadyAttached { generation: 1, state: SessionState::Prepared });
    assert_eq!(manager.active_thread_count(), 1);
    assert_eq!(transport.spawn_count(), 0);
}

#[test]
fn start_spawns_one_process_per_thread() {
    let mut manager = SessionManager::new();
    let transport = attach(&mut manager, spec("thread-1", SessionMode::Persistent, None), ScriptedTransport::new());

    assert_eq!(manager.start("thread-1").unwrap(), 1);
    assert_eq!(manager.start("thread-1").unwrap(), 1);

    assert_eq!(transport.spawn_count(), 1);
    assert_eq!(manager.status("thread-1").unwrap().state, SessionState::Running);
}

#[test]
fn two_threads_of_one_agent_are_two_sessions() {
    let mut manager = SessionManager::new();
    let first = attach(&mut manager, spec("thread-1", SessionMode::Persistent, Some(recipe("r1", "role"))), ScriptedTransport::new());
    let second = attach(&mut manager, spec("thread-2", SessionMode::Persistent, Some(recipe("r1", "role"))), ScriptedTransport::new());

    manager.start("thread-1").unwrap();
    manager.start("thread-2").unwrap();

    assert_eq!(first.spawn_count(), 1);
    assert_eq!(second.spawn_count(), 1);
    assert_eq!(manager.active_thread_count(), 2);
    assert_ne!(
        first.spawned_specs()[0].session_id,
        second.spawned_specs()[0].session_id
    );
}

#[test]
fn the_recipe_is_fixed_before_the_process_starts() {
    let mut manager = SessionManager::new();
    let mut source = recipe("r1", "original role");
    let transport = attach(&mut manager, spec("thread-1", SessionMode::Persistent, Some(source.clone())), ScriptedTransport::new());

    source.role = "edited later".to_string();
    manager.start("thread-1").unwrap();

    assert_eq!(transport.spawned_specs()[0].recipe_revision.as_deref(), Some("r1"));
    assert_eq!(
        manager.status("thread-1").unwrap().recipe.unwrap().role,
        "original role"
    );
}

#[test]
fn a_later_turn_sends_only_the_new_message() {
    let mut manager = SessionManager::new();
    let transport = attach(&mut manager, spec("thread-1", SessionMode::Persistent, Some(recipe("r1", "role"))), ScriptedTransport::new());

    manager.start("thread-1").unwrap();
    manager.send_turn("thread-1", "command-1", "first").unwrap();
    manager.send_turn("thread-1", "command-2", "second").unwrap();

    assert_eq!(transport.written_turns(), vec!["first".to_string(), "second".to_string()]);
    assert_eq!(transport.spawn_count(), 1);
}

#[test]
fn replaying_a_command_returns_the_same_receipt_without_writing_again() {
    let mut manager = SessionManager::new();
    let transport = attach(&mut manager, spec("thread-1", SessionMode::Persistent, None), ScriptedTransport::new());
    manager.start("thread-1").unwrap();

    let first = manager.send_turn("thread-1", "command-1", "hello").unwrap();
    let replay = manager.send_turn("thread-1", "command-1", "hello").unwrap();

    assert!(!first.duplicate);
    assert!(replay.duplicate);
    assert_eq!(first.command_id, replay.command_id);
    assert_eq!(transport.written_turns(), vec!["hello".to_string()]);
}

#[test]
fn reusing_a_command_id_with_another_payload_is_rejected() {
    let mut manager = SessionManager::new();
    attach(&mut manager, spec("thread-1", SessionMode::Persistent, None), ScriptedTransport::new());
    manager.start("thread-1").unwrap();
    manager.send_turn("thread-1", "command-1", "hello").unwrap();

    let error = manager.send_turn("thread-1", "command-1", "other").unwrap_err();

    assert_eq!(error, SessionError::CommandConflict("command-1".to_string()));
}

#[test]
fn a_client_frame_reaches_the_session_that_owns_the_process() {
    let mut manager = SessionManager::new();
    let transport = attach(&mut manager, spec("thread-1", SessionMode::Persistent, None), ScriptedTransport::new());
    manager.start("thread-1").unwrap();

    manager.write_frame("thread-1", "{\"jsonrpc\":\"2.0\",\"id\":4,\"result\":{}}").unwrap();

    assert_eq!(
        transport.written_frames(),
        vec!["{\"jsonrpc\":\"2.0\",\"id\":4,\"result\":{}}".to_string()]
    );
}

#[test]
fn events_carry_a_monotonic_sequence() {
    let mut manager = SessionManager::new();
    let transport = attach(&mut manager, spec("thread-1", SessionMode::Persistent, None), ScriptedTransport::new());
    manager.start("thread-1").unwrap();
    transport.script(TransportEvent::Text("hi".to_string()));
    transport.script(TransportEvent::Notice("note".to_string()));

    manager.poll("thread-1").unwrap();

    let events = manager.events_since("thread-1", 0);
    let sequences: Vec<u64> = events.iter().map(|event| event.sequence).collect();
    assert_eq!(sequences, vec![1, 2, 3]);
    assert_eq!(manager.events_since("thread-1", 2).len(), 1);
}

#[test]
fn an_unknown_approval_does_not_mutate_the_session() {
    let mut manager = SessionManager::new();
    let transport = attach(&mut manager, spec("thread-1", SessionMode::Persistent, None), ScriptedTransport::new());
    manager.start("thread-1").unwrap();
    transport.script(TransportEvent::ApprovalRequest {
        id: "approval-1".to_string(),
        kind: "command".to_string(),
    });
    manager.poll("thread-1").unwrap();

    let error = manager
        .respond_approval("thread-1", "approval-unknown", ApprovalDecision::AllowOnce)
        .unwrap_err();

    assert_eq!(error, SessionError::UnknownApproval("approval-unknown".to_string()));
    let record = manager.status("thread-1").unwrap();
    assert_eq!(record.state, SessionState::Waiting);
    assert_eq!(record.pending_approvals, vec!["approval-1".to_string()]);
}

#[test]
fn a_provider_exit_settles_pending_approvals_and_fails_the_turn() {
    let mut manager = SessionManager::new();
    let transport = attach(&mut manager, spec("thread-1", SessionMode::Persistent, None), ScriptedTransport::new());
    manager.start("thread-1").unwrap();
    transport.script(TransportEvent::ApprovalRequest {
        id: "approval-1".to_string(),
        kind: "command".to_string(),
    });
    manager.poll("thread-1").unwrap();

    manager.handle_exit("thread-1", Some(1), Some("boom".to_string())).unwrap();

    let record = manager.status("thread-1").unwrap();
    assert_eq!(record.state, SessionState::Failed);
    assert!(record.pending_approvals.is_empty());
    assert!(manager
        .events_since("thread-1", 0)
        .iter()
        .any(|event| event.kind == "approvalSettled"));
}

#[test]
fn a_resumable_session_continues_only_with_a_provider_handle() {
    let mut manager = SessionManager::new();
    let transport = attach(
        &mut manager,
        spec("thread-1", SessionMode::Resumable, None),
        ScriptedTransport::new().with_resume_handle("provider-handle-1"),
    );
    manager.start("thread-1").unwrap();
    manager.handle_exit("thread-1", Some(0), None).unwrap();

    let record = manager.status("thread-1").unwrap();
    assert_eq!(record.state, SessionState::Resumable);
    assert_eq!(record.resume_handle.as_deref(), Some("provider-handle-1"));

    manager.resume("thread-1").unwrap();
    let specs = transport.spawned_specs();
    assert_eq!(specs.len(), 2);
    assert_eq!(specs[1].resume_handle.as_deref(), Some("provider-handle-1"));
}

#[test]
fn a_one_shot_session_starts_a_new_command_per_send() {
    let mut manager = SessionManager::new();
    let transport = attach(&mut manager, spec("thread-1", SessionMode::OneShot, None), ScriptedTransport::new());
    manager.start("thread-1").unwrap();
    manager.handle_exit("thread-1", Some(0), None).unwrap();

    manager.send_turn("thread-1", "command-2", "next").unwrap();

    let record = manager.status("thread-1").unwrap();
    assert_eq!(record.state, SessionState::Running);
    assert_eq!(record.generation, 2);
    assert_eq!(transport.spawn_count(), 2);
    assert_eq!(transport.written_turns(), vec!["next".to_string()]);
}

#[test]
fn a_declaration_chooses_the_mode_without_guessing() {
    let codex = declaration("codex").expect("codex declaration");
    assert_eq!(declared_session_mode(&codex, true), SessionMode::Persistent);
    assert_eq!(declared_session_mode(&codex, false), SessionMode::OneShot);

    let gemini = declaration("gemini").expect("gemini declaration");
    assert_eq!(declared_session_mode(&gemini, true), SessionMode::OneShot);

    let claude = declaration("claude").expect("claude declaration");
    assert_eq!(declared_session_mode(&claude, true), SessionMode::OneShot);
}

#[test]
fn a_spec_takes_its_mode_from_the_declaration() {
    let gemini = declaration("gemini").expect("gemini declaration");
    let declared = spec("thread-1", SessionMode::Persistent, None)
        .with_declared_mode(&gemini, true);

    assert_eq!(declared.mode, SessionMode::OneShot);
    assert_eq!(declared.driver, "codex");

    let codex = declaration("codex").expect("codex declaration");
    let live = spec("thread-2", SessionMode::OneShot, None)
        .with_declared_mode(&codex, true);
    assert_eq!(live.mode, SessionMode::Persistent);
}

#[test]
fn a_persistent_turn_end_keeps_one_process_for_the_next_message() {
    let mut manager = SessionManager::new();
    let transport = attach(
        &mut manager,
        spec("thread-1", SessionMode::Persistent, None),
        ScriptedTransport::new(),
    );
    manager.start("thread-1").unwrap();
    manager.send_turn("thread-1", "command-1", "first").unwrap();
    transport.script(TransportEvent::TurnEnded);
    manager.poll("thread-1").unwrap();

    assert_eq!(
        manager.status("thread-1").unwrap().state,
        SessionState::Idle
    );

    manager.send_turn("thread-1", "command-2", "second").unwrap();

    assert_eq!(transport.spawn_count(), 1);
    assert_eq!(
        transport.written_turns(),
        vec!["first".to_string(), "second".to_string()]
    );
    assert_eq!(
        manager.status("thread-1").unwrap().state,
        SessionState::Running
    );
}

#[test]
fn a_failed_turn_keeps_the_persistent_process_for_the_next_message() {
    let mut manager = SessionManager::new();
    let transport = attach(&mut manager, spec("thread-1", SessionMode::Persistent, None), ScriptedTransport::new());
    manager.start("thread-1").unwrap();
    manager.send_turn("thread-1", "command-1", "first").unwrap();
    transport.script(TransportEvent::TurnFailed("the provider rejected the turn".to_string()));
    manager.poll("thread-1").unwrap();

    let record = manager.status("thread-1").unwrap();
    assert_eq!(record.state, SessionState::Idle);
    assert!(manager
        .events_since("thread-1", 0)
        .iter()
        .any(|event| event.kind == "turnFailed"));

    manager.send_turn("thread-1", "command-2", "second").unwrap();

    assert_eq!(transport.spawn_count(), 1);
    assert_eq!(
        transport.written_turns(),
        vec!["first".to_string(), "second".to_string()]
    );
}

#[test]
fn a_turn_the_provider_refused_is_not_a_spawn_failure() {
    let mut manager = SessionManager::new();
    let transport = attach(
        &mut manager,
        spec("thread-1", SessionMode::Persistent, None),
        ScriptedTransport::new().failing_write("the provider refused the message"),
    );
    manager.start("thread-1").unwrap();

    let error = manager
        .send_turn("thread-1", "command-1", "hello")
        .unwrap_err();

    assert!(matches!(error, SessionError::Transport(_)), "{error}");
    assert_eq!(
        manager.status("thread-1").unwrap().state,
        SessionState::Running
    );
    assert!(transport.written_turns().is_empty());
}

#[test]
fn reaping_idle_session_stops_transport_and_preserves_resume_handle() {
    let mut manager = SessionManager::new();
    let transport = attach(
        &mut manager,
        spec("thread-1", SessionMode::Persistent, None),
        ScriptedTransport::new().with_resume_handle("handle-1"),
    );
    manager.start("thread-1").unwrap();
    manager.send_turn("thread-1", "cmd-1", "hello").unwrap();
    transport.script(TransportEvent::TurnEnded);
    manager.poll("thread-1").unwrap();

    assert_eq!(manager.status("thread-1").unwrap().state, SessionState::Idle);
    assert_eq!(manager.warm_count(), 1);

    let handle = manager.reap_session("thread-1").unwrap();
    assert_eq!(handle.as_deref(), Some("handle-1"));
    assert_eq!(manager.status("thread-1").unwrap().state, SessionState::Reaped);
    assert_eq!(manager.warm_count(), 0);
    assert_eq!(transport.stop_count(), 1);

    // Resurrecting from reaped with send_turn
    manager.send_turn("thread-1", "cmd-2", "world").unwrap();
    assert_eq!(manager.status("thread-1").unwrap().state, SessionState::Running);
    assert_eq!(manager.warm_count(), 1);
    let specs = transport.spawned_specs();
    assert_eq!(specs.len(), 2);
    assert_eq!(specs[1].resume_handle.as_deref(), Some("handle-1"));
}

#[test]
fn reap_idle_sessions_respects_idle_timeout() {
    let mut manager = SessionManager::new();
    let transport1 = attach(&mut manager, spec("t1", SessionMode::Persistent, None), ScriptedTransport::new());
    let transport2 = attach(&mut manager, spec("t2", SessionMode::Persistent, None), ScriptedTransport::new());

    manager.start("t1").unwrap();
    manager.start("t2").unwrap();

    transport1.script(TransportEvent::TurnEnded);
    transport2.script(TransportEvent::TurnEnded);
    manager.poll("t1").unwrap();
    manager.poll("t2").unwrap();

    // Mutate t1's last_active_at_ms to be older than timeout
    if let Some(session) = manager.sessions.get_mut("t1") {
        session.record.last_active_at_ms = now_ms() - 100_000;
    }

    let reaped = manager.reap_idle_sessions(50_000);
    assert_eq!(reaped, vec!["t1".to_string()]);
    assert_eq!(manager.status("t1").unwrap().state, SessionState::Reaped);
    assert_eq!(manager.status("t2").unwrap().state, SessionState::Idle);
}

#[test]
fn enforce_lru_capacity_reaps_oldest_idle_sessions() {
    let mut manager = SessionManager::new();
    let t1 = attach(&mut manager, spec("t1", SessionMode::Persistent, None), ScriptedTransport::new());
    let t2 = attach(&mut manager, spec("t2", SessionMode::Persistent, None), ScriptedTransport::new());
    let t3 = attach(&mut manager, spec("t3", SessionMode::Persistent, None), ScriptedTransport::new());

    manager.start("t1").unwrap();
    manager.start("t2").unwrap();
    manager.start("t3").unwrap();

    t1.script(TransportEvent::TurnEnded);
    t2.script(TransportEvent::TurnEnded);
    t3.script(TransportEvent::TurnEnded);
    manager.poll("t1").unwrap();
    manager.poll("t2").unwrap();
    manager.poll("t3").unwrap();

    if let Some(session) = manager.sessions.get_mut("t1") {
        session.record.last_active_at_ms = 100;
    }
    if let Some(session) = manager.sessions.get_mut("t2") {
        session.record.last_active_at_ms = 200;
    }
    if let Some(session) = manager.sessions.get_mut("t3") {
        session.record.last_active_at_ms = 300;
    }

    assert_eq!(manager.warm_count(), 3);
    // Enforce max capacity of 1 warm session: should reap t1 and t2 (oldest)
    let reaped = manager.enforce_lru_capacity(1);
    assert_eq!(reaped, vec!["t1".to_string(), "t2".to_string()]);
    assert_eq!(manager.status("t1").unwrap().state, SessionState::Reaped);
    assert_eq!(manager.status("t2").unwrap().state, SessionState::Reaped);
    assert_eq!(manager.status("t3").unwrap().state, SessionState::Idle);
    assert_eq!(manager.warm_count(), 1);
}

#[test]
fn stop_all_terminates_all_active_transports() {
    let mut manager = SessionManager::new();
    let t1 = attach(&mut manager, spec("t1", SessionMode::Persistent, None), ScriptedTransport::new());
    let t2 = attach(&mut manager, spec("t2", SessionMode::Persistent, None), ScriptedTransport::new());

    manager.start("t1").unwrap();
    manager.start("t2").unwrap();

    let stopped = manager.stop_all();
    assert_eq!(stopped.len(), 2);
    assert_eq!(t1.stop_count(), 1);
    assert_eq!(t2.stop_count(), 1);
}
