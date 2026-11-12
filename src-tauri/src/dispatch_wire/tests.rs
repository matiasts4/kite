use serde_json::json;

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
