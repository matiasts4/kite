use serde_json::{json, Value};

use crate::dispatch::port::{Port, SubmitMeta};
use crate::dispatch::types::{DispatchError, Family};

use super::protocol::LivePort;
use super::server::{execute_argv_envelope, receipt_still_waiting, timeout_receipt};

#[test]
fn submit_rejects_a_terminal_session_that_does_not_exist() {
    let mut port = LivePort;
    let meta = SubmitMeta {
        mounted: false,
        source: None,
        label: None,
        presentation_emitted: true,
    };
    let err = port
        .submit(
            Family::Terminal,
            "missing-dispatch-terminal",
            "hello",
            &meta,
        )
        .expect_err("a missing terminal must reject the dispatch");
    assert!(
        matches!(err, DispatchError::DestinationGone),
        "expected DestinationGone, got {err:?}"
    );
}

#[test]
fn argv_envelope_runs_the_dispatch_command_path() {
    let argv: Vec<String> = ["kite", "dispatch", "ls"]
        .iter()
        .map(|part| (*part).to_string())
        .collect();
    let out = execute_argv_envelope(&json!({ "argv": argv, "id": "test-ls" }));
    assert!(out.get("exit").is_some(), "envelope must report an exit code");
    assert_eq!(out["receipt"]["op"], "ls");
}

#[test]
fn a_queued_wait_is_still_waiting_until_it_times_out() {
    let queued = json!({ "exit": 0, "receipt": { "op": "wait", "status": "queued", "submitted": false } });
    assert!(receipt_still_waiting(&queued));
    let settled = json!({ "exit": 0, "receipt": { "op": "wait", "status": "settled" } });
    assert!(!receipt_still_waiting(&settled));
    let timed = timeout_receipt(&queued);
    assert_eq!(timed["status"], "failed");
    assert_eq!(timed["error"], "timeout");
    assert_eq!(timed["submitted"], false);
}

#[test]
fn thread_presence_reflects_live_turn_and_persisted_state() {
    use crate::chat::runtime::state::{live_turns, TurnRun};
    use crate::chat::utils::now_ms;
    use crate::dispatch::presence::{BlockKind, PresenceState};
    use crate::persist::threads;

    let tid = "test-presence-live-turn-thread";
    let rid = "test-presence-live-turn-run";
    {
        let mut list = threads().lock().unwrap();
        list.retain(|t| t.get("id").and_then(Value::as_str) != Some(tid));
        list.push(json!({
            "id": tid,
            "status": "idle",
            "pendingApproval": Value::Null,
            "pendingUserInput": Value::Null,
            "items": [],
        }));
    }
    assert_eq!(super::protocol::thread_presence(tid), (PresenceState::Idle, None));

    {
        let mut live = live_turns().lock().unwrap();
        live.by_thread.insert(tid.to_string(), rid.to_string());
        live.runs.insert(
            rid.to_string(),
            TurnRun {
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
            },
        );
    }
    assert_eq!(super::protocol::thread_presence(tid), (PresenceState::Working, None));

    {
        let mut list = threads().lock().unwrap();
        if let Some(t) = list
            .iter_mut()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(tid))
        {
            t["pendingApproval"] = json!({ "id": "apr-1" });
        }
    }
    assert_eq!(
        super::protocol::thread_presence(tid),
        (PresenceState::Blocked, Some(BlockKind::Permission))
    );

    {
        let mut live = live_turns().lock().unwrap();
        live.by_thread.remove(tid);
        live.runs.remove(rid);
        let mut list = threads().lock().unwrap();
        if let Some(t) = list
            .iter_mut()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(tid))
        {
            t["pendingApproval"] = Value::Null;
            t["items"] = json!([{ "id": "a1", "kind": "assistant", "text": "finished" }]);
        }
    }
    assert_eq!(super::protocol::thread_presence(tid), (PresenceState::Done, None));

    let mut list = threads().lock().unwrap();
    list.retain(|t| t.get("id").and_then(Value::as_str) != Some(tid));
}

#[test]
fn on_thread_settled_publishes_done_presence_for_attached_thread() {
    use crate::dispatch::presence::PresenceState;
    use crate::persist::threads;

    let tid = "test-settled-publish-thread";
    let address = format!("thread:{tid}");
    {
        let mut list = threads().lock().unwrap();
        list.retain(|t| t.get("id").and_then(Value::as_str) != Some(tid));
        list.push(json!({
            "id": tid,
            "status": "idle",
            "pendingApproval": Value::Null,
            "pendingUserInput": Value::Null,
            "items": [{ "id": "a1", "kind": "assistant", "text": "completed work" }],
        }));
    }
    {
        let mut svc = super::protocol::service().lock().unwrap();
        let _ = svc.attach(Family::Thread, tid, None, None, false);
    }

    super::protocol::on_thread_settled(tid);

    let row = {
        let svc = super::protocol::service().lock().unwrap();
        svc.ls()
            .into_iter()
            .find(|line| line.starts_with(&address))
    };
    assert_eq!(row.as_deref(), Some(format!("{address} done").as_str()));

    {
        let mut svc = super::protocol::service().lock().unwrap();
        let _ = svc.kill("test-cleanup-settled", &address);
    }
    let mut list = threads().lock().unwrap();
    list.retain(|t| t.get("id").and_then(Value::as_str) != Some(tid));
}

#[test]
fn live_port_stop_cancels_active_live_turn_and_settles_presence() {
    use crate::chat::runtime::state::{live_turns, TurnRun};
    use crate::chat::utils::now_ms;
    use crate::dispatch::presence::PresenceState;
    use crate::persist::threads;

    let tid = "test-stop-live-turn-thread";
    let rid = "test-stop-live-turn-run";
    {
        let mut list = threads().lock().unwrap();
        list.retain(|t| t.get("id").and_then(Value::as_str) != Some(tid));
        list.push(json!({
            "id": tid,
            "status": "running",
            "pendingApproval": Value::Null,
            "pendingUserInput": Value::Null,
            "items": [{ "id": "a1", "kind": "assistant", "text": "", "streaming": true }],
        }));
    }
    {
        let mut live = live_turns().lock().unwrap();
        live.by_thread.insert(tid.to_string(), rid.to_string());
        live.runs.insert(
            rid.to_string(),
            TurnRun {
                revision: "rev".into(),
                events: Vec::new(),
                next_sequence: 0,
                assistant_id: "a1".into(),
                assistant_text: String::new(),
                child: None,
                stdin: None,
                closing: false,
                finished: false,
                started_at_ms: now_ms(),
                routine_id: None,
                delivered_through: 0,
                file_baselines: std::collections::HashMap::new(),
            },
        );
    }

    let mut port = LivePort;
    port.stop(Family::Thread, tid).expect("stop must succeed");

    assert!(!crate::chat::is_turn_running(tid));
    assert_eq!(super::protocol::thread_presence(tid), (PresenceState::Gone, None));

    // Also verify persistent warm/idle sessions close cleanly (Closed, not Interrupted)
    let p_tid = "test-stop-persistent-closed-thread";
    let transport = crate::chat::session::ScriptedTransport::new();
    {
        let mut mgr = crate::chat::session_manager().lock().unwrap();
        let spec = crate::chat::session::SessionSpec {
            thread_id: p_tid.to_string(),
            driver: "opencode".to_string(),
            connection_id: None,
            working_directory: None,
            mode: crate::chat::session::SessionMode::Persistent,
            recipe: None,
            resume_handle: None,
            extra_env: Vec::new(),
        };
        mgr.attach(spec, Box::new(transport.clone())).unwrap();
        mgr.start(p_tid).unwrap();
        mgr.send_turn(p_tid, "cmd-1", "hi").unwrap();
    }
    port.stop(Family::Thread, p_tid).expect("stop persistent must succeed");
    assert_eq!(transport.stop_count(), 1);
    {
        let mgr = crate::chat::session_manager().lock().unwrap();
        assert_eq!(
            mgr.status(p_tid).map(|r| r.state),
            Some(crate::chat::session::SessionState::Closed)
        );
    }
    assert_eq!(super::protocol::thread_presence(p_tid), (PresenceState::Gone, None));
    // Deferred settlement after stop must not clobber Gone back to Done.
    super::protocol::on_thread_settled(p_tid);
    assert_eq!(super::protocol::thread_presence(p_tid), (PresenceState::Gone, None));

    {
        let mut live = live_turns().lock().unwrap();
        live.by_thread.remove(tid);
        live.runs.remove(rid);
    }
    let mut list = threads().lock().unwrap();
    list.retain(|t| t.get("id").and_then(Value::as_str) != Some(tid));
}

#[test]
fn thread_presence_distinguishes_question_fallback_done_and_persistent_providers() {
    use crate::chat::session::{ScriptedTransport, SessionMode, SessionSpec, TransportEvent};
    use crate::dispatch::presence::{BlockKind, PresenceState};
    use crate::persist::threads;

    fn persistent_spec(tid: &str, driver: &str) -> SessionSpec {
        SessionSpec {
            thread_id: tid.to_string(),
            driver: driver.to_string(),
            connection_id: None,
            working_directory: None,
            mode: SessionMode::Persistent,
            recipe: None,
            resume_handle: None,
            extra_env: Vec::new(),
        }
    }

    // 1. pendingUserInput + status == "waiting" must yield BlockKind::Question, not Permission.
    let q_tid = "test-question-blocked-thread";
    {
        let mut list = threads().lock().unwrap();
        list.retain(|t| t.get("id").and_then(Value::as_str) != Some(q_tid));
        list.push(json!({
            "id": q_tid,
            "provider": "claude",
            "status": "waiting",
            "pendingApproval": Value::Null,
            "pendingUserInput": { "id": "ask-1", "question": "Proceed?" },
            "items": [{ "id": "u1", "kind": "user", "text": "hi" }],
        }));
    }
    assert_eq!(
        super::protocol::thread_presence(q_tid),
        (PresenceState::Blocked, Some(BlockKind::Question))
    );

    // 2. Persistent spawn failure (SessionState::Failed) + successful one-shot fallback => Done.
    let fb_tid = "test-failed-session-oneshot-fallback-thread";
    let fail_transport = ScriptedTransport::new().failing_spawn("boom");
    {
        let mut mgr = crate::chat::session_manager().lock().unwrap();
        let spec = persistent_spec(fb_tid, "grok");
        mgr.attach(spec, Box::new(fail_transport)).unwrap();
        let _ = mgr.start(fb_tid);
    }
    {
        let mut list = threads().lock().unwrap();
        list.retain(|t| t.get("id").and_then(Value::as_str) != Some(fb_tid));
        list.push(json!({
            "id": fb_tid,
            "provider": "grok",
            "status": "idle",
            "pendingApproval": Value::Null,
            "pendingUserInput": Value::Null,
            "items": [{ "id": "a1", "kind": "assistant", "text": "fallback ok" }],
        }));
    }
    assert_eq!(
        super::protocol::thread_presence(fb_tid),
        (PresenceState::Done, None)
    );

    // 3. Persistent grok & antigravity transitions: Running -> Working, TurnEnded -> Done.
    for provider in ["grok", "antigravity"] {
        let tid = format!("test-persistent-presence-{provider}");
        {
            let mut list = threads().lock().unwrap();
            list.retain(|t| t.get("id").and_then(Value::as_str) != Some(tid.as_str()));
            list.push(json!({
                "id": tid,
                "provider": provider,
                "status": "running",
                "pendingApproval": Value::Null,
                "pendingUserInput": Value::Null,
                "items": [{ "id": "u1", "kind": "user", "text": "hello" }],
            }));
        }
        let transport = ScriptedTransport::new();
        {
            let mut mgr = crate::chat::session_manager().lock().unwrap();
            let spec = persistent_spec(&tid, provider);
            mgr.attach(spec, Box::new(transport.clone())).unwrap();
            mgr.start(&tid).unwrap();
            mgr.send_turn(&tid, "turn-1", "hello").unwrap();
        }
        assert_eq!(
            super::protocol::thread_presence(&tid),
            (PresenceState::Working, None)
        );
        transport.script(TransportEvent::TurnEnded);
        {
            let mut mgr = crate::chat::session_manager().lock().unwrap();
            let _ = mgr.poll(&tid);
        }
        {
            let mut list = threads().lock().unwrap();
            if let Some(t) = list
                .iter_mut()
                .find(|t| t.get("id").and_then(Value::as_str) == Some(tid.as_str()))
            {
                t["status"] = json!("idle");
                t["items"] = json!([
                    { "id": "u1", "kind": "user", "text": "hello" },
                    { "id": "a1", "kind": "assistant", "text": "done" }
                ]);
            }
        }
        assert_eq!(
            super::protocol::thread_presence(&tid),
            (PresenceState::Done, None)
        );
        {
            let mut mgr = crate::chat::session_manager().lock().unwrap();
            let _ = mgr.stop(&tid);
        }
        let mut list = threads().lock().unwrap();
        list.retain(|t| t.get("id").and_then(Value::as_str) != Some(tid.as_str()));
    }

    // 4. One-shot claude & codex transitions via live_turns() -> Done.
    for provider in ["claude", "codex"] {
        let tid = format!("test-oneshot-presence-{provider}");
        let rid = format!("run-{provider}");
        {
            let mut list = threads().lock().unwrap();
            list.retain(|t| t.get("id").and_then(Value::as_str) != Some(tid.as_str()));
            list.push(json!({
                "id": tid,
                "provider": provider,
                "status": "running",
                "pendingApproval": Value::Null,
                "pendingUserInput": Value::Null,
                "items": [],
            }));
        }
        {
            let mut live = crate::chat::runtime::state::live_turns().lock().unwrap();
            live.by_thread.insert(tid.clone(), rid.clone());
            live.runs.insert(
                rid.clone(),
                crate::chat::runtime::state::TurnRun {
                    revision: "r".into(),
                    events: Vec::new(),
                    next_sequence: 0,
                    assistant_id: "a1".into(),
                    assistant_text: String::new(),
                    child: None,
                    stdin: None,
                    closing: false,
                    finished: false,
                    started_at_ms: 1,
                    routine_id: None,
                    delivered_through: 0,
                    file_baselines: std::collections::HashMap::new(),
                },
            );
        }
        assert_eq!(
            super::protocol::thread_presence(&tid),
            (PresenceState::Working, None)
        );
        {
            let mut live = crate::chat::runtime::state::live_turns().lock().unwrap();
            live.by_thread.remove(&tid);
            live.runs.remove(&rid);
            let mut list = threads().lock().unwrap();
            if let Some(t) = list
                .iter_mut()
                .find(|t| t.get("id").and_then(Value::as_str) == Some(tid.as_str()))
            {
                t["status"] = json!("idle");
                t["items"] = json!([{ "id": "a1", "kind": "assistant", "text": "done" }]);
            }
        }
        assert_eq!(
            super::protocol::thread_presence(&tid),
            (PresenceState::Done, None)
        );
    }

    let mut list = threads().lock().unwrap();
    list.retain(|t| {
        let id = t.get("id").and_then(Value::as_str).unwrap_or("");
        id != q_tid && id != fb_tid && !id.starts_with("test-oneshot-presence-")
    });
}

#[test]
fn live_port_interrupt_and_sub_ms_publish_work_for_threads() {
    use crate::dispatch::types::ReceiptStatus;
    use crate::persist::threads;

    let tid = "test-interrupt-and-subms-thread";
    let address = format!("thread:{tid}");
    {
        let mut list = threads().lock().unwrap();
        list.retain(|t| t.get("id").and_then(Value::as_str) != Some(tid));
        list.push(json!({
            "id": tid,
            "provider": "claude",
            "status": "running",
            "pendingApproval": Value::Null,
            "pendingUserInput": Value::Null,
            "items": [{ "id": "u1", "kind": "user", "text": "work" }],
        }));
    }

    let mut svc = super::protocol::service().lock().unwrap();
    let _ = svc.attach(Family::Thread, tid, None, None, false);
    // Two publishes back-to-back within the same millisecond must not drop the second transition.
    super::protocol::publish_thread(&mut svc, tid);
    {
        let mut list = threads().lock().unwrap();
        if let Some(t) = list
            .iter_mut()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(tid))
        {
            t["status"] = json!("idle");
        }
    }
    super::protocol::publish_thread(&mut svc, tid);
    let row = svc
        .ls()
        .into_iter()
        .find(|line| line.starts_with(&address))
        .unwrap_or_default();
    assert_eq!(row, format!("{address} done"));

    // Interrupt must succeed for Family::Thread instead of TransportUnsupported.
    let receipt = svc.interrupt("int-thread-1", &address);
    assert_eq!(receipt.status, ReceiptStatus::Submitted, "receipt={receipt:?}");

    let _ = svc.kill("test-cleanup-interrupt", &address);
    let mut list = threads().lock().unwrap();
    list.retain(|t| t.get("id").and_then(Value::as_str) != Some(tid));
}
