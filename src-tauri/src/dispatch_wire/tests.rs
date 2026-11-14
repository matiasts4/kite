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

    let expected = format!("{address} done");
    let mut row = None;
    for _ in 0..40 {
        row = {
            let svc = super::protocol::service().lock().unwrap();
            svc.ls()
                .into_iter()
                .find(|line| line.starts_with(&address))
        };
        if row.as_deref() == Some(expected.as_str()) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    assert_eq!(row.as_deref(), Some(expected.as_str()));

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

    // Interrupt on a persistent session leaves it Closed & Done/Idle (not Gone), ready for re-attach.
    let ptid = "test-interrupt-persistent-opencode";
    let paddr = format!("thread:{ptid}");
    {
        let mut list = threads().lock().unwrap();
        list.retain(|t| t.get("id").and_then(Value::as_str) != Some(ptid));
        list.push(json!({
            "id": ptid,
            "provider": "opencode",
            "status": "idle",
            "pendingApproval": Value::Null,
            "pendingUserInput": Value::Null,
            "items": [{ "id": "u1", "kind": "user", "text": "hello" }],
        }));
    }
    let first_tr = crate::chat::session::ScriptedTransport::new();
    {
        let mut mgr = crate::chat::session_manager().lock().unwrap();
        mgr.attach(
            crate::chat::session::SessionSpec {
                thread_id: ptid.to_string(),
                driver: "opencode".into(),
                connection_id: None,
                working_directory: None,
                mode: crate::chat::session::SessionMode::Persistent,
                recipe: None,
                resume_handle: None,
                extra_env: Vec::new(),
            },
            Box::new(first_tr.clone()),
        )
        .unwrap();
        mgr.start(ptid).unwrap();
    }
    let _ = svc.attach(Family::Thread, ptid, None, None, false);
    let preceipt = svc.interrupt("int-persistent-1", &paddr);
    assert_eq!(preceipt.status, ReceiptStatus::Submitted);
    assert_eq!(
        super::protocol::thread_presence(ptid),
        (crate::dispatch::presence::PresenceState::Done, None)
    );
    assert_eq!(first_tr.stop_count(), 1);
    {
        let mut mgr = crate::chat::session_manager().lock().unwrap();
        let next_tr = crate::chat::session::ScriptedTransport::new();
        mgr.attach(
            crate::chat::session::SessionSpec {
                thread_id: ptid.to_string(),
                driver: "opencode".into(),
                connection_id: None,
                working_directory: None,
                mode: crate::chat::session::SessionMode::Persistent,
                recipe: None,
                resume_handle: None,
                extra_env: Vec::new(),
            },
            Box::new(next_tr),
        )
        .expect("re-attach after interrupt must succeed");
    }

    // Kill -> mark_thread_killed -> clear_thread_killed (as on new UI turn) -> Done.
    let _ = svc.kill("test-cleanup-interrupt", &address);
    assert_eq!(
        super::protocol::thread_presence(tid),
        (crate::dispatch::presence::PresenceState::Gone, None)
    );
    super::protocol::clear_thread_killed(tid);
    assert_eq!(
        super::protocol::thread_presence(tid),
        (crate::dispatch::presence::PresenceState::Done, None)
    );

    let _ = svc.kill("test-cleanup-persistent", &paddr);
    let mut list = threads().lock().unwrap();
    list.retain(|t| {
        let id = t.get("id").and_then(Value::as_str).unwrap_or("");
        id != tid && id != ptid
    });
}

#[test]
fn subagent_worktree_and_child_thread_linkage_sync_to_parent() {
    use crate::chat::subagents::{
        extract_final_assistant_text, format_subagent_wait_output, provision_subagent_worktree,
        spawn_child_subagent_thread, sync_child_thread_to_parent, ChildSubagentSpawnParams,
    };
    use crate::persist::threads;

    let unique = format!(
        "kite-subagent-wt-{}-{}",
        std::process::id(),
        super::protocol::now_ms()
    );
    let repo_dir = std::env::temp_dir().join(&unique);
    let _ = std::fs::remove_dir_all(&repo_dir);
    std::fs::create_dir_all(&repo_dir).unwrap();
    let git = |args: &[&str]| {
        crate::git::run_git(&repo_dir, args).expect("git executable available for worktree test")
    };
    assert!(git(&["init"]).status.success());
    assert!(git(&["config", "user.email", "test@kite.local"]).status.success());
    assert!(git(&["config", "user.name", "Kite Test"]).status.success());
    std::fs::write(repo_dir.join("README.md"), "init\n").unwrap();
    assert!(git(&["add", "README.md"]).status.success());
    assert!(git(&["commit", "-m", "init"]).status.success());

    let wt_share = provision_subagent_worktree(&repo_dir, "share", "s1111111")
        .expect("share worktree should succeed");
    assert!(wt_share.starts_with(repo_dir.join(".kite").join("worktrees")));
    assert!(wt_share.join("README.md").exists());

    let wt_branch = provision_subagent_worktree(&repo_dir, "branch", "b2222222")
        .expect("branch worktree should succeed");
    assert!(wt_branch.starts_with(repo_dir.join(".kite").join("worktrees")));
    assert!(wt_branch.join("README.md").exists());
    let branch_out = crate::git::run_git(&wt_branch, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap();
    assert_eq!(
        String::from_utf8_lossy(&branch_out.stdout).trim(),
        "kite/subagent-b2222222"
    );

    let parent_id = "test-cross-provider-parent";
    {
        let mut list = threads().lock().unwrap();
        list.retain(|t| {
            let id = t.get("id").and_then(Value::as_str).unwrap_or("");
            id != parent_id && t.get("parentThreadId").and_then(Value::as_str) != Some(parent_id)
        });
        list.push(json!({
            "id": parent_id,
            "provider": "antigravity",
            "model": "claude-opus-4-6",
            "effort": "high",
            "workspaceId": "ws-parent-1",
            "workingDirectory": repo_dir.to_string_lossy().to_string(),
            "status": "running",
            "items": [],
            "subagentRuns": [],
        }));
    }

    let spawned = spawn_child_subagent_thread(ChildSubagentSpawnParams {
        parent_thread_id: Some(parent_id.to_string()),
        provider: Some("grok".to_string()),
        model: Some("grok-3-mini".to_string()),
        effort: Some("low".to_string()),
        role: Some("Grok Executor".to_string()),
        workspace_mode: "inherit".to_string(),
        fallback_cwd: Some(repo_dir.to_string_lossy().to_string()),
        task: "Inspect auth.rs".to_string(),
    })
    .expect("child thread spawn must succeed");

    let child_id = spawned.child_thread_id.clone();
    {
        let list = threads().lock().unwrap();
        let child = list
            .iter()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(child_id.as_str()))
            .expect("child thread must be persisted");
        assert!(child.get("profileId").is_none_or(Value::is_null));
        assert_eq!(child.get("workspaceId").and_then(Value::as_str), Some("ws-parent-1"));
        assert_eq!(child.get("parentThreadId").and_then(Value::as_str), Some(parent_id));
        assert_eq!(child.get("startedByAgent").and_then(Value::as_bool), Some(true));
        assert_eq!(child.get("sideChat").and_then(Value::as_bool), Some(true));
        assert_eq!(child.get("provider").and_then(Value::as_str), Some("grok"));
        assert_eq!(child.get("model").and_then(Value::as_str), Some("grok-3-mini"));
        assert_eq!(child.get("effort").and_then(Value::as_str), Some("low"));
        assert_eq!(child.get("subagentRole").and_then(Value::as_str), Some("Grok Executor"));
        assert_eq!(child.get("workspaceMode").and_then(Value::as_str), Some("inherit"));

        let parent = list
            .iter()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(parent_id))
            .expect("parent thread must exist");
        let runs = parent["subagentRuns"].as_array().expect("subagentRuns array");
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].get("childThreadId").and_then(Value::as_str), Some(child_id.as_str()));
        assert_eq!(runs[0].get("provider").and_then(Value::as_str), Some("grok"));
        assert_eq!(runs[0].get("status").and_then(Value::as_str), Some("running"));
        let tool_items = parent["items"].as_array().expect("parent items");
        assert_eq!(tool_items.len(), 1);
        assert_eq!(tool_items[0].get("toolKind").and_then(Value::as_str), Some("subagent"));
    }

    // Simulate child thread executing a tool and completing an assistant reply.
    {
        let mut list = threads().lock().unwrap();
        if let Some(child) = list
            .iter_mut()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(child_id.as_str()))
        {
            child["status"] = json!("idle");
            child["items"] = json!([
                { "id": "u1", "kind": "user", "text": "Inspect auth.rs" },
                { "id": "t1", "kind": "tool", "title": "Read auth.rs", "status": "completed" },
                { "id": "a1", "kind": "assistant", "text": "Auth token validation is clean." }
            ]);
        }
    }
    sync_child_thread_to_parent(&child_id);
    {
        let list = threads().lock().unwrap();
        let parent = list
            .iter()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(parent_id))
            .unwrap();
        let run = &parent["subagentRuns"][0];
        assert_eq!(run.get("status").and_then(Value::as_str), Some("completed"));
        assert_eq!(run.get("stepCount").and_then(Value::as_u64), Some(1));
        assert!(run.get("completedAtUnixMs").and_then(Value::as_i64).is_some());
    }

    let final_resp = extract_final_assistant_text(&child_id);
    let formatted = format_subagent_wait_output(&final_resp, &child_id);
    assert_eq!(
        formatted,
        format!("Auth token validation is clean.\n\n[subagent_id: thread:{child_id}]")
    );

    // Cross-provider spawn omitting --model must NOT leak global last_model from another provider.
    *crate::persist::last_model().lock().unwrap() = Some("claude-opus-4-6".to_string());
    *crate::persist::last_effort().lock().unwrap() = Some("max".to_string());
    let cross_codex = spawn_child_subagent_thread(ChildSubagentSpawnParams {
        parent_thread_id: Some(parent_id.to_string()),
        provider: Some("codex".to_string()),
        model: None,
        effort: None,
        role: Some("Codex Checker".to_string()),
        workspace_mode: "inherit".to_string(),
        fallback_cwd: Some(repo_dir.to_string_lossy().to_string()),
        task: "Verify edge case".to_string(),
    })
    .expect("codex spawn must succeed");
    let codex_id = cross_codex.child_thread_id.clone();
    {
        let list = threads().lock().unwrap();
        let codex_child = list
            .iter()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(codex_id.as_str()))
            .unwrap();
        assert!(codex_child.get("model").is_none_or(Value::is_null));
        assert!(codex_child.get("effort").is_none_or(Value::is_null));
    }

    // Killing a child thread syncs parent run status to "killed" instead of "completed".
    crate::dispatch_wire::protocol::mark_thread_killed(&codex_id);
    sync_child_thread_to_parent(&codex_id);
    crate::dispatch_wire::protocol::clear_thread_killed(&codex_id);
    {
        let list = threads().lock().unwrap();
        let parent = list
            .iter()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(parent_id))
            .unwrap();
        let killed_run = parent["subagentRuns"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r.get("childThreadId").and_then(Value::as_str) == Some(codex_id.as_str()))
            .unwrap();
        assert_eq!(killed_run.get("status").and_then(Value::as_str), Some("killed"));
    }

    // Cleanup worktrees and test threads
    let _ = git(&["worktree", "remove", "--force", &wt_share.to_string_lossy()]);
    let _ = git(&["worktree", "remove", "--force", &wt_branch.to_string_lossy()]);
    let _ = std::fs::remove_dir_all(&repo_dir);
    let mut list = threads().lock().unwrap();
    list.retain(|t| {
        let id = t.get("id").and_then(Value::as_str).unwrap_or("");
        id != parent_id && id != child_id.as_str() && id != codex_id.as_str()
    });
}

#[test]
fn gui_bridge_forwards_thread_and_swarm_requests_with_gui_token() {
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;

    let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock gui bridge");
    let port = listener.local_addr().unwrap().port();
    let dir = std::env::temp_dir().join(format!("kite-gui-bridge-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let endpoint = dir.join("gui-dispatch-endpoint.json");
    std::fs::write(
        &endpoint,
        serde_json::to_vec(&json!({ "token": "gui-secret", "port": port, "pid": std::process::id() })).unwrap(),
    )
    .unwrap();

    let server_handle = std::thread::spawn(move || {
        let (stream, _) = listener.accept().expect("accept forwarded request");
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let req: Value = serde_json::from_str(line.trim()).unwrap();
        let reply = json!({
            "exit": 0,
            "forwardedToken": req.get("token").cloned().unwrap_or(Value::Null),
            "argv": req.get("argv").cloned().unwrap_or(Value::Null),
        });
        let s = reader.get_mut();
        s.write_all(&serde_json::to_vec(&reply).unwrap()).unwrap();
        s.write_all(b"\n").unwrap();
        s.flush().unwrap();
    });

    let ls_req = json!({ "token": "daemon-tok", "argv": ["ls"], "from": "session:abc" });
    assert!(
        super::server::try_forward_to_gui_bridge_at(&endpoint, &ls_req).is_none(),
        "terminal ls must stay on daemon without forwarding to GUI bridge"
    );

    let thread_req = json!({
        "token": "daemon-tok",
        "argv": ["run", "--via", "thread", "--provider", "grok", "hi"],
        "from": "thread:root"
    });
    let forwarded = super::server::try_forward_to_gui_bridge_at(&endpoint, &thread_req)
        .expect("thread run must forward to GUI bridge");
    assert_eq!(forwarded["exit"], 0);
    assert_eq!(forwarded["forwardedToken"], "gui-secret");

    server_handle.join().unwrap();
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn argv_envelope_reports_descriptive_errors_for_invalid_provider_and_serves_providers_discovery() {
    let bad = execute_argv_envelope(&json!({
        "argv": ["kite", "dispatch", "run", "--via", "thread", "--provider", "nonexistent", "hi"],
        "id": "bad-prov"
    }));
    assert_eq!(bad["exit"], 2);
    assert_eq!(bad["receipt"]["error"], "bad_args");
    let detail = bad["receipt"]["text"].as_str().unwrap_or("");
    assert!(detail.contains("Unknown thread provider"), "got: {detail}");
    assert!(detail.contains("kite dispatch providers"), "got: {detail}");

    let providers = execute_argv_envelope(&json!({
        "argv": ["kite", "dispatch", "providers"],
        "id": "list-prov"
    }));
    assert_eq!(providers["exit"], 0);
    let text = providers["textOut"].as_str().unwrap_or("");
    assert!(text.contains("antigravity"), "got: {text}");
    assert!(text.contains("grok"), "got: {text}");
    assert!(text.contains("codex"), "got: {text}");
}

#[test]
fn live_thread_for_profile_skips_side_chats_and_agent_children() {
    use crate::chat::session::{ScriptedTransport, SessionMode, SessionSpec};
    use crate::persist::threads;

    let profile = format!("prof-iso-{}", uuid::Uuid::new_v4().simple());
    let side_id = format!("side-{}", uuid::Uuid::new_v4().simple());
    let child_id = format!("child-{}", uuid::Uuid::new_v4().simple());
    let main_id = format!("main-{}", uuid::Uuid::new_v4().simple());

    {
        let mut mgr = crate::chat::session_manager().lock().unwrap();
        for tid in [&side_id, &child_id, &main_id] {
            let spec = SessionSpec {
                thread_id: tid.clone(),
                driver: "grok".to_string(),
                connection_id: None,
                working_directory: None,
                mode: SessionMode::Persistent,
                recipe: None,
                resume_handle: None,
                extra_env: Vec::new(),
            };
            mgr.attach(spec, Box::new(ScriptedTransport::new())).unwrap();
        }
    }

    {
        let mut list = threads().lock().unwrap();
        list.push(json!({
            "id": side_id,
            "profileId": profile,
            "sideChat": true,
        }));
        list.push(json!({
            "id": child_id,
            "profileId": profile,
            "startedByAgent": true,
            "parentThreadId": "parent-root",
        }));
    }
    assert_eq!(super::protocol::live_thread_for_profile(&profile), None);

    threads().lock().unwrap().push(json!({
        "id": main_id,
        "profileId": profile,
    }));
    assert_eq!(
        super::protocol::live_thread_for_profile(&profile).as_deref(),
        Some(main_id.as_str())
    );

    if let Ok(mut mgr) = crate::chat::session_manager().lock() {
        for tid in [&side_id, &child_id, &main_id] {
            let _ = mgr.stop(tid);
        }
    }
    threads()
        .lock()
        .unwrap()
        .retain(|t| {
            let id = t.get("id").and_then(Value::as_str).unwrap_or("");
            id != side_id && id != child_id && id != main_id
        });
}

#[test]
fn subagent_settings_resolves_workspace_role_defaults_and_enforces_stack_override_policy() {
    use crate::dispatch::cli::{parse_args, Command};
    use crate::subagent_settings::{
        check_stack_policy, DefaultDelegation, OverridePolicy, SubagentSettings, SubagentStackEntry,
    };

    let tmp_ws = std::env::temp_dir().join(format!(
        "kite-wire-role-test-{}",
        uuid::Uuid::new_v4().simple()
    ));
    let agents_dir = tmp_ws.join(".kite").join("agents");
    std::fs::create_dir_all(&agents_dir).unwrap();
    std::fs::write(
        agents_dir.join("fast-reviewer.md"),
        "---\ncommand: grok\nprovider: grok\nmodel: grok-4.7-build-fast\neffort: low\nworkspace: inherit\ndescription: Fast review specialist\n---\nCheck edge cases concisely.",
    )
    .unwrap();

    let parsed = parse_args(&[
        "kite".to_string(),
        "dispatch".to_string(),
        "run".to_string(),
        "--via".to_string(),
        "thread".to_string(),
        "--role".to_string(),
        "fast-reviewer".to_string(),
        "Inspect src/main.ts".to_string(),
    ])
    .expect("parse role run");

    let settings = SubagentSettings {
        stack: vec![
            SubagentStackEntry {
                provider: "antigravity".to_string(),
                model: "gemini-3-flash".to_string(),
                effort: Some("medium".to_string()),
                enabled: true,
            },
            SubagentStackEntry {
                provider: "grok".to_string(),
                model: "grok-4.7-build-fast".to_string(),
                effort: Some("low".to_string()),
                enabled: true,
            },
        ],
        default_delegation: Some(DefaultDelegation {
            provider: "antigravity".to_string(),
            model: "gemini-3-flash".to_string(),
            effort: Some("medium".to_string()),
        }),
        override_policy: OverridePolicy::Ask,
    };

    let req = json!({
        "from": "thread:main-1",
        "workspace": tmp_ws.to_string_lossy().to_string(),
    });
    let resolved = super::resolve_command_with_subagent_settings(&req, &parsed, &settings);
    match &resolved {
        Command::Run {
            provider,
            model,
            effort,
            workspace,
            ..
        } => {
            assert_eq!(provider.as_deref(), Some("grok"));
            assert_eq!(model.as_deref(), Some("grok-4.7-build-fast"));
            assert_eq!(effort.as_deref(), Some("low"));
            assert_eq!(workspace.as_deref(), Some("inherit"));
        }
        other => panic!("expected Command::Run, got {other:?}"),
    }

    assert!(check_stack_policy(&settings, Some("grok"), Some("grok-4.7-build-fast"), false).is_ok());
    let err = check_stack_policy(&settings, Some("claude"), Some("claude-sonnet-4-6"), false)
        .expect_err("out-of-stack under ask without override must error");
    assert!(err.contains("--override-stack"), "got: {err}");
    assert!(check_stack_policy(&settings, Some("claude"), Some("claude-sonnet-4-6"), true).is_ok());

    let strict_settings = SubagentSettings {
        override_policy: OverridePolicy::Strict,
        ..settings.clone()
    };
    assert!(check_stack_policy(&strict_settings, Some("claude"), Some("claude-sonnet-4-6"), true).is_err());

    let default_parsed = parse_args(&[
        "kite".to_string(),
        "dispatch".to_string(),
        "run".to_string(),
        "Inspect build scripts".to_string(),
    ])
    .expect("parse default run");
    let default_resolved =
        super::resolve_command_with_subagent_settings(&req, &default_parsed, &settings);
    match default_resolved {
        Command::Run {
            provider,
            model,
            effort,
            ..
        } => {
            assert_eq!(provider.as_deref(), Some("antigravity"));
            assert_eq!(model.as_deref(), Some("gemini-3-flash"));
            assert_eq!(effort.as_deref(), Some("medium"));
        }
        other => panic!("expected Command::Run, got {other:?}"),
    }

    // dispatch_run JSON overloading `"workspace": "share"` still resolves workspace path from `from` thread.
    let parent_tid = format!("wire-parent-{}", uuid::Uuid::new_v4().simple());
    crate::persist::threads().lock().unwrap().push(json!({
        "id": parent_tid,
        "provider": "antigravity",
        "workingDirectory": tmp_ws.to_string_lossy().to_string(),
    }));
    let share_req = json!({
        "from": format!("thread:{parent_tid}"),
        "workspace": "share",
    });
    assert_eq!(
        super::server::resolve_request_workspace_path(&share_req).as_deref(),
        Some(tmp_ws.as_path())
    );
    let share_resolved =
        super::resolve_command_with_subagent_settings(&share_req, &parsed, &settings);
    match share_resolved {
        Command::Run {
            provider,
            model,
            workspace,
            ..
        } => {
            assert_eq!(provider.as_deref(), Some("grok"));
            assert_eq!(model.as_deref(), Some("grok-4.7-build-fast"));
            assert_eq!(workspace.as_deref(), Some("inherit"));
        }
        other => panic!("expected Command::Run, got {other:?}"),
    }
    crate::persist::threads()
        .lock()
        .unwrap()
        .retain(|t| t.get("id").and_then(Value::as_str) != Some(parent_tid.as_str()));

    // Skill / manual composition includes workspace `.kite/agents/*.md` roles and `--timeout-ms`.
    let roles = crate::subagent_settings::list_roles(Some(&tmp_ws));
    let skill = crate::dispatch::cli::compose_skill_with(&settings, &roles);
    assert!(skill.contains("fast-reviewer"), "skill missing workspace role: {skill}");
    assert!(skill.contains("--timeout-ms"), "skill missing --timeout-ms flag: {skill}");

    // Roles saved with `command: auto` (Inherit / Stack default) under `--via terminal --role`
    // resolve engine from stack default or explicit `--engine`, and reject cleanly if unset.
    std::fs::write(
        tmp_ws.join(".kite").join("agents").join("auto-role.md"),
        "---\ncommand: auto\ndescription: Inherit role\n---\n\nCheck inherited role behavior.",
    )
    .expect("write auto role");

    let term_auto_parsed = parse_args(&[
        "kite".to_string(),
        "dispatch".to_string(),
        "run".to_string(),
        "--via".to_string(),
        "terminal".to_string(),
        "--role".to_string(),
        "auto-role".to_string(),
        "Check terminal inherit".to_string(),
    ])
    .expect("parse terminal auto-role");
    let term_auto_resolved =
        super::resolve_command_with_subagent_settings(&req, &term_auto_parsed, &settings);
    match &term_auto_resolved {
        Command::Run {
            via,
            engine,
            model,
            effort,
            ..
        } => {
            assert_eq!(*via, Family::Terminal);
            assert_eq!(engine.as_deref(), Some("antigravity"));
            assert_eq!(model.as_deref(), Some("gemini-3-flash"));
            assert_eq!(effort.as_deref(), Some("medium"));
        }
        other => panic!("expected Command::Run, got {other:?}"),
    }

    let cfg_dir = tmp_ws.join(".cfg-test");
    std::fs::create_dir_all(&cfg_dir).unwrap();
    let exec_ctx = crate::dispatch::cli::ExecContext {
        id: "exec-auto-1",
        from: "",
        caller: crate::dispatch::types::Caller::Human,
        mounted: false,
        config_dir: Some(&cfg_dir),
        workspace: Some(&tmp_ws),
        now_ms: 10_000,
    };
    let mut svc = crate::dispatch::policy::Service::new(crate::dispatch::port::FakePort::default());
    let receipt = crate::dispatch::cli::execute(&mut svc, &term_auto_resolved, &exec_ctx)
        .expect("execute stack-resolved terminal auto-role");
    assert_eq!(receipt.status, crate::dispatch::types::ReceiptStatus::Submitted);
    assert_eq!(svc.port_mut().starts.len(), 1);
    assert_eq!(svc.port_mut().starts[0].engine, "antigravity");
    assert_eq!(svc.port_mut().starts[0].command, None);

    let term_override_parsed = parse_args(&[
        "kite".to_string(),
        "dispatch".to_string(),
        "run".to_string(),
        "--via".to_string(),
        "terminal".to_string(),
        "--role".to_string(),
        "auto-role".to_string(),
        "--engine".to_string(),
        "codex".to_string(),
        "Override engine".to_string(),
    ])
    .expect("parse terminal auto-role override");
    let term_override_resolved =
        super::resolve_command_with_subagent_settings(&req, &term_override_parsed, &settings);
    let mut svc_override =
        crate::dispatch::policy::Service::new(crate::dispatch::port::FakePort::default());
    let exec_ctx2 = crate::dispatch::cli::ExecContext {
        id: "exec-auto-2",
        from: "",
        caller: crate::dispatch::types::Caller::Human,
        mounted: false,
        config_dir: Some(&cfg_dir),
        workspace: Some(&tmp_ws),
        now_ms: 11_000,
    };
    let receipt2 =
        crate::dispatch::cli::execute(&mut svc_override, &term_override_resolved, &exec_ctx2)
            .expect("execute explicit engine override with auto-role");
    assert_eq!(receipt2.status, crate::dispatch::types::ReceiptStatus::Submitted);
    assert_eq!(svc_override.port_mut().starts[0].engine, "codex");
    assert_eq!(svc_override.port_mut().starts[0].command, None);

    let mut svc_unset =
        crate::dispatch::policy::Service::new(crate::dispatch::port::FakePort::default());
    let exec_ctx3 = crate::dispatch::cli::ExecContext {
        id: "exec-auto-3",
        from: "",
        caller: crate::dispatch::types::Caller::Human,
        mounted: false,
        config_dir: Some(&cfg_dir),
        workspace: Some(&tmp_ws),
        now_ms: 12_000,
    };
    let receipt3 = crate::dispatch::cli::execute(&mut svc_unset, &term_auto_parsed, &exec_ctx3)
        .expect("execute unresolved auto-role");
    assert_eq!(receipt3.status, crate::dispatch::types::ReceiptStatus::Rejected);
    assert_eq!(receipt3.error.as_deref(), Some("program_not_found"));
    assert!(svc_unset.port_mut().starts.is_empty());

    let _ = std::fs::remove_dir_all(&tmp_ws);
}

#[test]
fn thread_tail_prefers_turn_failure_message_over_user_prompt() {
    let tid = format!("tail-fail-{}", uuid::Uuid::new_v4().simple());
    let mut thread = crate::chat::threads::blank_thread(&tid, None, "Fail Tail", "grok", None);
    thread["status"] = json!("error");
    thread["turnFailure"] = json!({ "message": "Provider rate limit exceeded" });
    thread["items"] = json!([{
        "id": "user-1",
        "kind": "user",
        "text": "Original user prompt should not mask turnFailure"
    }]);

    crate::persist::threads().lock().unwrap().push(thread);
    let tail = super::protocol::thread_tail(&tid);
    assert!(
        tail.contains("Provider rate limit exceeded"),
        "expected turnFailure message in thread_tail, got: {tail}"
    );
    assert!(
        !tail.contains("Original user prompt should not mask turnFailure"),
        "user prompt should not be returned as failure tail, got: {tail}"
    );

    {
        let mut guard = crate::persist::threads().lock().unwrap();
        let stored = guard
            .iter_mut()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(tid.as_str()))
            .unwrap();
        crate::chat::threads::upsert_item(
            stored,
            &json!({
                "id": "assistant-partial-1",
                "kind": "assistant",
                "text": "Partial stream before error"
            }),
        );
    }
    let mut live_port = super::protocol::LivePort;
    let final_resp = crate::dispatch::port::Port::read_final_response(
        &mut live_port,
        crate::dispatch::types::Family::Thread,
        &tid,
    )
    .expect("read_final_response");
    crate::chat::threads::remove_thread(&tid);

    assert!(
        final_resp.contains("Partial stream before error"),
        "expected partial assistant text in read_final_response, got: {final_resp}"
    );
    assert!(
        final_resp.contains("Provider rate limit exceeded"),
        "expected turnFailure message in read_final_response alongside partial assistant text, got: {final_resp}"
    );
}
