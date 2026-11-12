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
    assert_eq!(super::protocol::thread_presence(tid), (PresenceState::Done, None));

    {
        let mut live = live_turns().lock().unwrap();
        live.by_thread.remove(tid);
        live.runs.remove(rid);
    }
    let mut list = threads().lock().unwrap();
    list.retain(|t| t.get("id").and_then(Value::as_str) != Some(tid));
}
