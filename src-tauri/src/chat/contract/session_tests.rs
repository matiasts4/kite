//! Tests covering session lifecycle, attachment, approvals, recovery, and folding.

use std::fs;

use serde_json::json;

use crate::chat::event_log::{
    recover_thread_with_snapshot, RecoverySource, ThreadEventKind, ThreadEventLog,
};
use crate::chat::normalize::{
    map_approval, normalize_frame, ApprovalMapping, NormalizedEvent,
};
use crate::chat::session::{
    ApprovalDecision, AttachOutcome, ScriptedTransport, SessionError, SessionManager,
    SessionMode, SessionState, TransportEvent,
};
use crate::chat::threads::chat_item;

use super::helpers::*;

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
