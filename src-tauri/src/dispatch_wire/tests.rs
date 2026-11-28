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
                finished_at_ms: None,
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
                finished_at_ms: None,
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
                    finished_at_ms: None,
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
        agent_id: None,
        mode: None,
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
        agent_id: None,
        mode: None,
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

#[test]
fn send_to_settled_subagent_child_thread_steers_clean_body_and_suppresses_wait_wakeup() {
    use crate::persist::threads;

    let parent_id = format!("wire-steer-parent-{}", uuid::Uuid::new_v4().simple());
    let child_id = format!("wire-steer-child-{}", uuid::Uuid::new_v4().simple());
    let child_addr = format!("thread:{child_id}");
    let parent_addr = format!("thread:{parent_id}");

    {
        let mut list = threads().lock().unwrap();
        list.push(json!({
            "id": parent_id,
            "provider": "antigravity",
            "status": "running",
            "items": [{
                "id": "sub_run_1",
                "kind": "tool",
                "toolKind": "subagent",
                "status": "completed",
                "streaming": false,
                "subagentMeta": {
                    "subagentId": "run_1",
                    "childThreadId": child_id,
                    "status": "completed",
                    "latestActivity": "Initial task done."
                }
            }],
            "subagentRuns": [{
                "subagentId": "run_1",
                "parentThreadId": parent_id,
                "childThreadId": child_id,
                "provider": "grok",
                "status": "completed",
                "stepCount": 1,
                "items": [],
                "completedAtUnixMs": 1_000
            }]
        }));
        list.push(json!({
            "id": child_id,
            "parentThreadId": parent_id,
            "startedByAgent": true,
            "sideChat": true,
            "provider": "grok",
            "status": "idle",
            "items": [
                { "id": "u1", "kind": "user", "text": "Initial task" },
                { "id": "a1", "kind": "assistant", "text": "Initial task done." }
            ]
        }));
    }

    {
        let mut svc = super::protocol::service().lock().unwrap();
        let _ = svc.attach(Family::Thread, &parent_id, None, None, false);
        let _ = svc.attach(Family::Thread, &child_id, None, Some(&parent_addr), false);
        super::protocol::publish_thread(&mut svc, &parent_id);
        super::protocol::publish_thread(&mut svc, &child_id);
        svc.suppress_parent_notice_for(&child_addr);
    }

    let envelope = execute_argv_envelope(&json!({
        "id": "wire-send-followup-1",
        "caller": "agent",
        "from": parent_addr,
        "argv": ["kite", "dispatch", "send", &child_addr, "Follow-up task", "--wait"]
    }));
    assert_eq!(envelope["exit"], 0, "envelope={envelope:?}");
    assert_eq!(envelope["receipt"]["status"], "submitted");
    assert_eq!(envelope["receipt"]["submitted"], true);

    {
        let list = threads().lock().unwrap();
        let child = list
            .iter()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(child_id.as_str()))
            .expect("child thread exists");
        let user_texts: Vec<&str> = child["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|it| it.get("kind").and_then(Value::as_str) == Some("user"))
            .filter_map(|it| it.get("text").and_then(Value::as_str))
            .collect();
        assert!(
            user_texts.contains(&"Follow-up task"),
            "expected clean follow-up prompt without dispatch envelope header, got: {user_texts:?}"
        );
        assert!(
            user_texts.iter().all(|t| !t.contains("[kite from=")),
            "dispatch envelope header must be stripped on subagent follow-up: {user_texts:?}"
        );

        let parent = list
            .iter()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(parent_id.as_str()))
            .expect("parent thread exists");
        assert_eq!(parent["subagentRuns"][0]["status"], "running");
        assert_eq!(parent["items"][0]["status"], "running");
        assert_eq!(parent["items"][0]["subagentMeta"]["status"], "running");
    }

    crate::chat::cancel_turn(&child_id);
    {
        let mut svc = super::protocol::service().lock().unwrap();
        let _ = svc.kill("cleanup-wire-steer-child", &child_addr);
        let _ = svc.kill("cleanup-wire-steer-parent", &parent_addr);
    }
    super::protocol::clear_thread_killed(&child_id);
    super::protocol::clear_thread_killed(&parent_id);
    crate::chat::threads::remove_thread(&child_id);
    crate::chat::threads::remove_thread(&parent_id);
}

#[test]
fn heavy_parent_delegates_two_parallel_lightweight_subagents_end_to_end() {
    use crate::persist::threads;

    let parent_id = format!("wire-e2e-2sub-parent-{}", uuid::Uuid::new_v4().simple());
    let parent_addr = format!("thread:{parent_id}");

    {
        let mut parent = crate::chat::threads::blank_thread(
            &parent_id,
            None,
            "Heavy Orchestrator",
            "antigravity",
            None,
        );
        parent["model"] = json!("gemini-4-argon");
        parent["effort"] = json!("xhigh");
        parent["status"] = json!("running");
        threads().lock().unwrap().push(parent);
    }

    let envelope = execute_argv_envelope(&json!({
        "id": "wire-e2e-2sub-1",
        "caller": "agent",
        "from": parent_addr,
        "argv": [
            "kite",
            "dispatch",
            "run",
            "--via",
            "thread",
            "--role",
            "Fast Executor",
            "--task",
            "Audit module A",
            "--task",
            "Audit module B",
            "--wait"
        ]
    }));
    assert_eq!(envelope["exit"], 0, "envelope={envelope:?}");
    let spawned_addrs = crate::dispatch::cli_wire::extract_spawned_thread_addresses(&envelope);
    assert_eq!(
        spawned_addrs.len(),
        2,
        "expected 2 spawned child thread addresses, got: {spawned_addrs:?}"
    );

    let child_ids: Vec<String> = spawned_addrs
        .iter()
        .map(|a| a.strip_prefix("thread:").unwrap_or(a).to_string())
        .collect();
    assert_ne!(child_ids[0], child_ids[1]);

    {
        let list = threads().lock().unwrap();
        let parent = list
            .iter()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(parent_id.as_str()))
            .expect("parent thread");
        let runs = parent["subagentRuns"].as_array().expect("subagentRuns array");
        assert_eq!(runs.len(), 2, "expected 2 SubagentRun entries on parent: {runs:?}");

        for cid in &child_ids {
            let child = list
                .iter()
                .find(|t| t.get("id").and_then(Value::as_str) == Some(cid.as_str()))
                .expect("child thread exists");
            assert_eq!(
                child.get("model").and_then(Value::as_str),
                Some("gemini-4-hydrogen"),
                "child subagent must route to default gemini-4-hydrogen instead of cloning heavy gemini-4-argon: {child:?}"
            );
            assert!(
                child.get("effort").is_none_or(Value::is_null),
                "child subagent must not inherit parent xhigh effort: {child:?}"
            );
        }
    }

    for (idx, addr) in spawned_addrs.iter().enumerate() {
        let cid = &child_ids[idx];
        crate::chat::cancel_turn(cid);
        if let Ok(mut svc) = super::protocol::service().lock() {
            let _ = svc.kill(&format!("cleanup-e2e-2sub-{idx}"), addr);
        }
        super::protocol::clear_thread_killed(cid);
        crate::chat::threads::remove_thread(cid);
    }
    if let Ok(mut svc) = super::protocol::service().lock() {
        let _ = svc.kill("cleanup-e2e-2sub-parent", &parent_addr);
    }
    super::protocol::clear_thread_killed(&parent_id);
    crate::chat::threads::remove_thread(&parent_id);
}

#[test]
fn execute_command_skips_queued_wait_audit_rows_but_records_terminal_waits() {
    use crate::dispatch::cli::Command;
    use crate::dispatch::presence::PresenceState;
    use crate::dispatch::types::ReceiptStatus;
    use crate::persist::threads;

    let tid = format!("wire-audit-wait-{}", uuid::Uuid::new_v4().simple());
    let addr = format!("thread:{tid}");
    {
        let mut t = crate::chat::threads::blank_thread(&tid, None, "Audit Wait", "antigravity", None);
        t["status"] = json!("running");
        threads().lock().unwrap().push(t);
    }
    {
        let mut svc = super::protocol::service().lock().unwrap();
        svc.set_online(true);
        let _ = svc.attach(Family::Thread, &tid, None, None, false);
        let _ = svc.publish_pane(&addr, "working", 1, 1_000, None, None);
    }

    let queued_id = format!("audit-wait-queued-{}", uuid::Uuid::new_v4().simple());
    let queued_receipt = super::server::execute_command(
        &json!({ "caller": "agent", "from": "human" }),
        &Command::Wait {
            address: Some(addr.clone()),
            until: vec![PresenceState::Done],
            children: None,
            timeout_ms: 30_000,
        },
        &queued_id,
    );
    assert_eq!(queued_receipt.op, "wait");
    assert_eq!(queued_receipt.status, ReceiptStatus::Queued);

    let failed_id = format!("audit-wait-failed-{}", uuid::Uuid::new_v4().simple());
    let failed_receipt = super::server::execute_command(
        &json!({ "caller": "agent", "from": "human" }),
        &Command::Wait {
            address: Some(addr.clone()),
            until: vec![PresenceState::Done],
            children: None,
            timeout_ms: 0,
        },
        &failed_id,
    );
    assert_eq!(failed_receipt.op, "wait");
    assert_eq!(failed_receipt.status, ReceiptStatus::Failed);

    {
        let mut list = threads().lock().unwrap();
        if let Some(t) = list.iter_mut().find(|t| t.get("id").and_then(Value::as_str) == Some(tid.as_str())) {
            t["status"] = json!("idle");
            t["items"] = json!([{ "id": "a1", "kind": "assistant", "text": "done" }]);
        }
    }
    let settled_id = format!("audit-wait-settled-{}", uuid::Uuid::new_v4().simple());
    let settled_receipt = super::server::execute_command(
        &json!({ "caller": "agent", "from": "human" }),
        &Command::Wait {
            address: Some(addr.clone()),
            until: vec![PresenceState::Done],
            children: None,
            timeout_ms: 30_000,
        },
        &settled_id,
    );
    assert_eq!(settled_receipt.op, "wait");
    assert_eq!(settled_receipt.status, ReceiptStatus::Settled);

    let conn = super::audit::audit_db().expect("audit_db");
    let count_for = |id: &str| -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM dispatch_audit WHERE id = ?1",
            rusqlite::params![id],
            |r| r.get(0),
        )
        .unwrap_or(-1)
    };
    assert_eq!(count_for(&queued_id), 0, "queued wait poll must not write dispatch_audit row");
    assert_eq!(count_for(&failed_id), 1, "terminal timeout wait must be audited");
    assert_eq!(count_for(&settled_id), 1, "settled wait must be audited");

    let _ = conn.execute(
        "DELETE FROM dispatch_audit WHERE id IN (?1, ?2, ?3)",
        rusqlite::params![queued_id, failed_id, settled_id],
    );
    if let Ok(mut svc) = super::protocol::service().lock() {
        let _ = svc.kill("cleanup-audit-wait", &addr);
    }
    super::protocol::clear_thread_killed(&tid);
    crate::chat::threads::remove_thread(&tid);
}

#[test]
fn read_final_response_returns_concise_bounded_live_summary_while_running_and_bounds_thread_tail() {
    use crate::persist::threads;

    let tid = format!("wire-live-summary-{}", uuid::Uuid::new_v4().simple());
    let mut items = vec![
        json!({ "id": "u1", "kind": "user", "text": "Audit repository" }),
        json!({ "id": "r1", "kind": "reasoning", "text": "Inspecting auth and dispatch files" }),
        json!({ "id": "a1", "kind": "assistant", "text": "Checking authentication handlers now." }),
    ];
    for idx in 1..=10 {
        items.push(json!({
            "id": format!("t{idx}"),
            "kind": "tool",
            "title": format!("Read file #{idx}"),
            "status": if idx == 10 { "running" } else { "completed" },
            "output": format!("TOOL-{idx}-BODY-{}", "x".repeat(4_000)),
        }));
    }
    {
        let mut t = crate::chat::threads::blank_thread(&tid, None, "Live Summary", "antigravity", None);
        t["status"] = json!("running");
        t["items"] = Value::Array(items);
        threads().lock().unwrap().push(t);
    }

    let mut port = LivePort;
    let live_resp = port
        .read_final_response(Family::Thread, &tid)
        .expect("read_final_response while running");
    assert!(
        live_resp.chars().count() <= 8_000,
        "live summary exceeded 8000 chars: {}",
        live_resp.chars().count()
    );
    assert!(live_resp.contains("Status: working"), "resp={live_resp}");
    assert!(live_resp.contains("Inspecting auth and dispatch files"), "resp={live_resp}");
    assert!(live_resp.contains("Checking authentication handlers now."), "resp={live_resp}");
    assert!(live_resp.contains("Read file #10"), "latest tool missing: {live_resp}");
    assert!(!live_resp.contains("Read file #1\n"), "old tools should be omitted: {live_resp}");
    assert!(live_resp.contains("kite_subagent_wait"), "resp={live_resp}");

    // Oversized settled/failed thread_tail must cap around 12,000 chars while preserving turnFailure.
    {
        let mut list = threads().lock().unwrap();
        if let Some(t) = list.iter_mut().find(|t| t.get("id").and_then(Value::as_str) == Some(tid.as_str())) {
            t["status"] = json!("error");
            t["turnFailure"] = json!({ "message": "Fatal upstream quota failure" });
            t["items"] = json!([
                { "id": "a_big", "kind": "assistant", "text": format!("HEAD-DROP-{}TAIL-KEEP", "z".repeat(20_000)) }
            ]);
        }
    }
    let tail = super::protocol::thread_tail(&tid);
    assert!(
        tail.chars().count() <= 12_000,
        "thread_tail exceeded 12000 chars: {}",
        tail.chars().count()
    );
    assert!(tail.contains("TAIL-KEEP"), "tail missing recent text");
    assert!(tail.contains("Fatal upstream quota failure"), "tail dropped turnFailure");

    crate::chat::threads::remove_thread(&tid);
}

#[test]
fn agent_service_tools_enforce_thread_pagination_memory_budget_and_permissions() {
    use crate::persist::{agents, threads, AgentProfile};

    let unique = uuid::Uuid::new_v4().simple().to_string();
    let agent_id = uuid::Uuid::new_v4().to_string();
    let ws_id = format!("ws-svc-{unique}");
    let t1 = format!("t1-{unique}");
    let t2 = format!("t2-{unique}");
    let t3 = format!("t3-{unique}");

    {
        let mut list = threads().lock().unwrap();
        for (tid, updated, msg) in [
            (&t1, 1000_i64, "alpha needle first"),
            (&t2, 2000_i64, "beta needle second"),
            (&t3, 3000_i64, "gamma other"),
        ] {
            let thread = json!({
                "id": tid,
                "title": format!("Thread {tid}"),
                "workspaceId": ws_id,
                "profileId": agent_id,
                "provider": "codex",
                "status": "idle",
                "createdAtUnixMs": 500,
                "updatedAtUnixMs": updated,
                "items": [
                    { "id": "i1", "kind": "user", "text": msg },
                    { "id": "i2", "kind": "assistant", "text": "item two" },
                    { "id": "i3", "kind": "assistant", "text": "item three" }
                ]
            });
            crate::chat::thread_index::index_thread(&thread);
            list.push(thread);
        }
    }

    {
        let mut list = agents().lock().unwrap();
        list.push(AgentProfile {
            id: agent_id.clone(),
            name: format!("SvcTester-{unique}"),
            engine: "codex".to_string(),
            purpose: "Test".to_string(),
            brief: "Test".to_string(),
            avatar: None,
            created_at_unix_ms: 1_000,
            pinned: false,
            order: 0,
            memory_budget: Some(120),
            reflection_mode: None,
            allow_agent_scheduling: Some(false),
            allow_agent_messaging: Some(false),
            default_mode: None,
            default_plan: None,
            default_model: None,
            default_provider_options: Vec::new(),
            place_display_names: Vec::new(),
            disabled_plugin_ids: vec!["kite-dispatch".to_string()],
        });
    }

    // 1. Thread list & search & read pagination
    let list_page1 = execute_argv_envelope(&json!({
        "argv": ["kite", "agent", "thread", "list", "--workspace-id", &ws_id, "--cursor", "0", "--limit", "2"],
        "agentId": &agent_id
    }));
    assert_eq!(list_page1["exit"], 0);
    assert_eq!(list_page1["result"]["threads"].as_array().unwrap().len(), 2);
    assert_eq!(list_page1["result"]["nextCursor"], 2);
    assert_eq!(list_page1["result"]["total"], 3);

    let search_res = execute_argv_envelope(&json!({
        "argv": ["kite", "agent", "thread", "search", "--query", "needle", "--workspace-id", &ws_id],
        "agentId": &agent_id
    }));
    assert_eq!(search_res["exit"], 0);
    assert_eq!(search_res["result"]["total"], 2);

    let read_res = execute_argv_envelope(&json!({
        "argv": ["kite", "agent", "thread", "read", "--thread-id", &t1, "--cursor", "0", "--limit", "2"],
        "agentId": &agent_id
    }));
    assert_eq!(read_res["exit"], 0);
    assert_eq!(read_res["result"]["items"].as_array().unwrap().len(), 2);
    assert_eq!(read_res["result"]["nextCursor"], 2);
    assert_eq!(read_res["result"]["totalItems"], 3);

    // 2. Memory add/read/search + budget enforcement
    let mem_add = execute_argv_envelope(&json!({
        "argv": ["kite", "agent", "memory", "add", "--target", "agent", "--text", "Fact alpha"],
        "agentId": &agent_id
    }));
    assert_eq!(mem_add["exit"], 0);
    let mem_read = execute_argv_envelope(&json!({
        "argv": ["kite", "agent", "memory", "read", "--target", "agent"],
        "agentId": &agent_id
    }));
    assert_eq!(mem_read["exit"], 0);
    assert!(mem_read["result"]["text"].as_str().unwrap().contains("Fact alpha"));

    let mem_search = execute_argv_envelope(&json!({
        "argv": ["kite", "agent", "memory", "search", "--target", "agent", "--query", "alpha"],
        "agentId": &agent_id
    }));
    assert_eq!(mem_search["exit"], 0);
    assert_eq!(mem_search["result"]["totalMatches"], 1);

    let huge = "x".repeat(200);
    let mem_over = execute_argv_envelope(&json!({
        "argv": ["kite", "agent", "memory", "add", "--target", "agent", "--text", &huge],
        "agentId": &agent_id
    }));
    assert_eq!(mem_over["exit"], 1);
    assert!(mem_over["textOut"].as_str().unwrap().contains("memory_over_budget"));

    // 3. allowAgentScheduling = false blocks kite agent routine
    let routine_denied = execute_argv_envelope(&json!({
        "argv": ["kite", "agent", "routine", "list"],
        "agentId": &agent_id
    }));
    assert_eq!(routine_denied["exit"], 1);
    assert!(routine_denied["textOut"].as_str().unwrap().contains("allowAgentScheduling"));

    // 4. allowAgentMessaging = false blocks kite agent teammate
    let teammate_denied = execute_argv_envelope(&json!({
        "argv": ["kite", "agent", "teammate", "list"],
        "agentId": &agent_id
    }));
    assert_eq!(teammate_denied["exit"], 1);
    assert!(teammate_denied["textOut"].as_str().unwrap().contains("allowAgentMessaging"));

    // 5. disabled_plugin_ids = ["kite-dispatch"] blocks kite dispatch ls
    let dispatch_denied = execute_argv_envelope(&json!({
        "argv": ["kite", "dispatch", "ls"],
        "agentId": &agent_id
    }));
    assert_eq!(dispatch_denied["exit"], 1);
    assert!(dispatch_denied["textOut"].as_str().unwrap().contains("kite-dispatch"));

    // Cleanup
    for tid in [&t1, &t2, &t3] {
        crate::chat::thread_index::remove_from_index(tid);
        crate::chat::threads::remove_thread(tid);
    }
    let _ = std::fs::remove_dir_all(crate::agent_mind::get_agent_home_dir(&agent_id));
    if let Ok(mut list) = agents().lock() {
        list.retain(|a| a.id != agent_id);
    }
}

#[test]
fn profile_first_role_resolution_prefers_agent_profile_over_markdown_and_falls_back() {
    use crate::dispatch::cli::{parse_args, Command, SwarmCommand};
    use crate::persist::{agents, AgentProfile};
    use crate::subagent_settings::{OverridePolicy, SubagentSettings};

    let tmp_ws = std::env::temp_dir().join(format!(
        "kite-wire-profile-first-{}",
        uuid::Uuid::new_v4().simple()
    ));
    let agents_dir = tmp_ws.join(".kite").join("agents");
    std::fs::create_dir_all(&agents_dir).unwrap();
    std::fs::write(
        agents_dir.join("security-auditor.md"),
        "---\ncommand: grok\nprovider: grok\nmodel: grok-4.7-build-fast\neffort: low\n---\nMarkdown fallback body.",
    )
    .unwrap();
    std::fs::write(
        agents_dir.join("md-only-role.md"),
        "---\ncommand: codex\nprovider: codex\nmodel: gpt-5.3-codex\neffort: high\n---\nOnly markdown exists.",
    )
    .unwrap();

    let profile_id = format!("agent-prof-{}", uuid::Uuid::new_v4().simple());
    {
        let mut list = agents().lock().unwrap();
        list.push(AgentProfile {
            id: profile_id.clone(),
            name: "Security Auditor".to_string(),
            engine: "claude-code".to_string(),
            purpose: "Audit security".to_string(),
            brief: "Audit auth and crypto carefully.".to_string(),
            avatar: None,
            created_at_unix_ms: 1_700_000_000_000,
            pinned: false,
            order: 0,
            memory_budget: Some(4000),
            reflection_mode: Some("ask".to_string()),
            allow_agent_scheduling: Some(true),
            allow_agent_messaging: Some(true),
            default_mode: Some("readOnly".to_string()),
            default_plan: Some(false),
            default_model: Some("claude-sonnet-4-5".to_string()),
            default_provider_options: vec![json!({ "id": "effort", "value": "high" })],
            place_display_names: Vec::new(),
            disabled_plugin_ids: Vec::new(),
        });
    }

    let settings = SubagentSettings {
        stack: Vec::new(),
        default_delegation: None,
        override_policy: OverridePolicy::Allow,
    };
    let req = json!({
        "from": "thread:main-1",
        "workspace": tmp_ws.to_string_lossy().to_string(),
    });

    // 1. By slug/name, AgentProfile wins over .md file and canonicalizes `claude-code` -> `claude`.
    for role_arg in [
        "security-auditor",
        "Security Auditor",
        profile_id.as_str(),
        &format!("agent:{profile_id}"),
    ] {
        let parsed = parse_args(&[
            "kite".into(),
            "dispatch".into(),
            "run".into(),
            "--via".into(),
            "thread".into(),
            "--role".into(),
            role_arg.to_string(),
            "Check auth".into(),
        ])
        .unwrap();
        let resolved = super::resolve_command_with_subagent_settings(&req, &parsed, &settings);
        match resolved {
            Command::Run {
                provider,
                model,
                effort,
                ..
            } => {
                assert_eq!(provider.as_deref(), Some("claude"), "role_arg={role_arg}");
                assert_eq!(model.as_deref(), Some("claude-sonnet-4-5"), "role_arg={role_arg}");
                assert_eq!(effort.as_deref(), Some("high"), "role_arg={role_arg}");
            }
            other => panic!("unexpected command: {other:?}"),
        }
    }

    // 2. Swarm add also resolves AgentProfile first.
    let swarm_parsed = parse_args(&[
        "kite".into(),
        "dispatch".into(),
        "swarm".into(),
        "add".into(),
        "--name".into(),
        "auditor".into(),
        "--role".into(),
        format!("agent:{profile_id}"),
        "--brief".into(),
        "Audit repo".into(),
    ])
    .unwrap();
    let swarm_resolved = super::resolve_command_with_subagent_settings(&req, &swarm_parsed, &settings);
    match swarm_resolved {
        Command::Swarm(SwarmCommand::Add {
            provider,
            model,
            effort,
            ..
        }) => {
            assert_eq!(provider.as_deref(), Some("claude"));
            assert_eq!(model.as_deref(), Some("claude-sonnet-4-5"));
            assert_eq!(effort.as_deref(), Some("high"));
        }
        other => panic!("unexpected swarm command: {other:?}"),
    }

    // 3. Explicit CLI overrides still win over AgentProfile defaults.
    let override_parsed = parse_args(&[
        "kite".into(),
        "dispatch".into(),
        "run".into(),
        "--via".into(),
        "thread".into(),
        "--role".into(),
        profile_id.clone(),
        "--provider".into(),
        "gemini".into(),
        "--model".into(),
        "gemini-2.5-pro".into(),
        "--effort".into(),
        "low".into(),
        "Check auth".into(),
    ])
    .unwrap();
    let override_resolved =
        super::resolve_command_with_subagent_settings(&req, &override_parsed, &settings);
    match override_resolved {
        Command::Run {
            provider,
            model,
            effort,
            ..
        } => {
            assert_eq!(provider.as_deref(), Some("gemini"));
            assert_eq!(model.as_deref(), Some("gemini-2.5-pro"));
            assert_eq!(effort.as_deref(), Some("low"));
        }
        other => panic!("unexpected override command: {other:?}"),
    }

    // 4. When no AgentProfile matches, .md role fallback works identically.
    let md_parsed = parse_args(&[
        "kite".into(),
        "dispatch".into(),
        "run".into(),
        "--via".into(),
        "thread".into(),
        "--role".into(),
        "md-only-role".into(),
        "Check fallback".into(),
    ])
    .unwrap();
    let md_resolved = super::resolve_command_with_subagent_settings(&req, &md_parsed, &settings);
    match md_resolved {
        Command::Run {
            provider,
            model,
            effort,
            ..
        } => {
            assert_eq!(provider.as_deref(), Some("codex"));
            assert_eq!(model.as_deref(), Some("gpt-5.3-codex"));
            assert_eq!(effort.as_deref(), Some("high"));
        }
        other => panic!("unexpected md command: {other:?}"),
    }

    agents().lock().unwrap().retain(|a| a.id != profile_id);
    let _ = std::fs::remove_dir_all(&tmp_ws);
}

#[test]
fn agent_profile_resolution_canonicalizes_all_seven_engines_and_fails_over_on_quota_exhaustion() {
    use crate::dispatch::cli::{parse_args, Command, SwarmCommand};
    use crate::persist::{agents, AgentProfile};
    use crate::subagent_settings::{
        DefaultDelegation, OverridePolicy, SubagentSettings, SubagentStackEntry,
    };

    let cases = [
        ("claude-code", "claude"),
        ("open-code", "opencode"),
        ("cursor-agent", "cursor"),
        ("agy", "antigravity"),
        ("gemini", "gemini"),
        ("codex", "codex"),
        ("grok", "grok"),
    ];
    let mut created_ids = Vec::new();
    for (idx, (raw_engine, _canon)) in cases.iter().enumerate() {
        let id = format!("agent-eng-{idx}-{}", uuid::Uuid::new_v4().simple());
        created_ids.push(id.clone());
        agents().lock().unwrap().push(AgentProfile {
            id,
            name: format!("Specialist {idx}"),
            engine: (*raw_engine).to_string(),
            purpose: "Test".to_string(),
            brief: "Test brief".to_string(),
            avatar: None,
            created_at_unix_ms: 1_700_000_000_000,
            pinned: false,
            order: idx as i32,
            memory_budget: Some(4000),
            reflection_mode: Some("ask".to_string()),
            allow_agent_scheduling: Some(true),
            allow_agent_messaging: Some(true),
            default_mode: Some("fullAccess".to_string()),
            default_plan: Some(false),
            default_model: None,
            default_provider_options: Vec::new(),
            place_display_names: Vec::new(),
            disabled_plugin_ids: Vec::new(),
        });
    }

    let settings = SubagentSettings {
        stack: Vec::new(),
        default_delegation: None,
        override_policy: OverridePolicy::Allow,
    };
    let req = json!({ "from": "thread:main-1" });
    for (idx, (_raw, expected_canon)) in cases.iter().enumerate() {
        let parsed = parse_args(&[
            "kite".into(),
            "dispatch".into(),
            "run".into(),
            "--via".into(),
            "thread".into(),
            "--role".into(),
            format!("agent:{}", created_ids[idx]),
            "Do work".into(),
        ])
        .unwrap();
        let resolved = super::server::resolve_command_with_subagent_settings_using(
            &req,
            &parsed,
            &settings,
            |_| true,
        );
        match resolved {
            Command::Run { provider, .. } => {
                assert_eq!(provider.as_deref(), Some(*expected_canon));
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    // Quota exhaustion / unavailability failover:
    // Specialist 0 (`claude-code` -> `claude`) is exhausted; stack has `gemini/gemini-2.5-pro` healthy.
    let failover_settings = SubagentSettings {
        stack: vec![
            SubagentStackEntry {
                provider: "claude".to_string(),
                model: "claude-sonnet-4-5".to_string(),
                effort: Some("high".to_string()),
                enabled: true,
            },
            SubagentStackEntry {
                provider: "gemini".to_string(),
                model: "gemini-2.5-pro".to_string(),
                effort: Some("medium".to_string()),
                enabled: true,
            },
        ],
        default_delegation: Some(DefaultDelegation {
            provider: "claude".to_string(),
            model: "claude-sonnet-4-5".to_string(),
            effort: Some("high".to_string()),
        }),
        override_policy: OverridePolicy::Strict,
    };

    let run_parsed = parse_args(&[
        "kite".into(),
        "dispatch".into(),
        "run".into(),
        "--via".into(),
        "thread".into(),
        "--role".into(),
        format!("agent:{}", created_ids[0]),
        "Check failover".into(),
    ])
    .unwrap();
    let run_resolved = super::server::resolve_command_with_subagent_settings_using(
        &req,
        &run_parsed,
        &failover_settings,
        |p| p != "claude",
    );
    match run_resolved {
        Command::Run {
            provider,
            model,
            effort,
            ..
        } => {
            assert_eq!(provider.as_deref(), Some("gemini"));
            assert_eq!(model.as_deref(), Some("gemini-2.5-pro"));
            assert_eq!(effort.as_deref(), Some("medium"));
        }
        other => panic!("unexpected run failover: {other:?}"),
    }

    let swarm_parsed = parse_args(&[
        "kite".into(),
        "dispatch".into(),
        "swarm".into(),
        "add".into(),
        "--name".into(),
        "worker-1".into(),
        "--role".into(),
        format!("agent:{}", created_ids[0]),
        "--brief".into(),
        "Check swarm failover".into(),
    ])
    .unwrap();
    let swarm_resolved = super::server::resolve_command_with_subagent_settings_using(
        &req,
        &swarm_parsed,
        &failover_settings,
        |p| p != "claude",
    );
    match swarm_resolved {
        Command::Swarm(SwarmCommand::Add {
            provider,
            model,
            effort,
            ..
        }) => {
            assert_eq!(provider.as_deref(), Some("gemini"));
            assert_eq!(model.as_deref(), Some("gemini-2.5-pro"));
            assert_eq!(effort.as_deref(), Some("medium"));
        }
        other => panic!("unexpected swarm failover: {other:?}"),
    }

    agents()
        .lock()
        .unwrap()
        .retain(|a| !created_ids.contains(&a.id));
}

#[test]
fn wake_on_message_attaches_existing_persisted_cold_thread_and_routes_delivery() {
    use crate::persist::{agents, threads, AgentProfile};

    let unique = uuid::Uuid::new_v4().simple().to_string();
    let profile_id = format!("cold-persisted-{unique}");
    let old_tid = format!("tid-old-{unique}");
    let recent_tid = format!("tid-recent-{unique}");
    let side_tid = format!("tid-side-{unique}");
    let msg_id = format!("msg-cold-{unique}");

    {
        let mut list = agents().lock().unwrap();
        list.push(AgentProfile {
            id: profile_id.clone(),
            name: "Cold Persisted".to_string(),
            engine: "gemini".to_string(),
            purpose: "Test".to_string(),
            brief: "Test".to_string(),
            avatar: None,
            created_at_unix_ms: 1_000,
            pinned: false,
            order: 0,
            memory_budget: Some(4000),
            reflection_mode: None,
            allow_agent_scheduling: Some(true),
            allow_agent_messaging: Some(true),
            default_mode: Some("auto".to_string()),
            default_plan: Some(false),
            default_model: Some("gemini-2.5-pro".to_string()),
            default_provider_options: Vec::new(),
            place_display_names: Vec::new(),
            disabled_plugin_ids: Vec::new(),
        });
    }
    {
        let mut list = threads().lock().unwrap();
        list.push(json!({
            "id": old_tid,
            "profileId": profile_id,
            "provider": "gemini",
            "status": "idle",
            "items": [],
            "updatedAtUnixMs": 1_000,
            "createdAtUnixMs": 1_000,
        }));
        list.push(json!({
            "id": recent_tid,
            "profileId": profile_id,
            "provider": "gemini",
            "status": "idle",
            "items": [],
            "updatedAtUnixMs": 5_000,
            "createdAtUnixMs": 4_000,
        }));
        list.push(json!({
            "id": side_tid,
            "profileId": profile_id,
            "provider": "gemini",
            "sideChat": true,
            "status": "idle",
            "items": [],
            "updatedAtUnixMs": 9_000,
            "createdAtUnixMs": 9_000,
        }));
    }

    let res = super::server::send_agent(
        &profile_id,
        "Wake persisted thread",
        "agent",
        "Coordinator",
        Some(msg_id.clone()),
    );
    assert_eq!(res["delivered"], true, "expected cold persisted thread to deliver: {res}");
    assert_eq!(res["status"], "submitted");
    assert_eq!(
        res["receipt"]["address"].as_str(),
        Some(format!("thread:{recent_tid}").as_str())
    );

    let inbox = super::server::inbox(&profile_id, None);
    let messages = inbox["messages"].as_array().unwrap();
    let found = messages
        .iter()
        .find(|m| m["id"].as_str() == Some(msg_id.as_str()))
        .expect("message should appear in inbox");
    assert_eq!(found["threadId"].as_str(), Some(recent_tid.as_str()));

    if let Ok(mut live) = crate::chat::live_turns().lock() {
        live.by_thread.remove(&recent_tid);
    }
    threads()
        .lock()
        .unwrap()
        .retain(|t| {
            let id = t.get("id").and_then(Value::as_str).unwrap_or("");
            id != old_tid && id != recent_tid && id != side_tid
        });
    agents().lock().unwrap().retain(|a| a.id != profile_id);
    if let Some(conn) = super::audit::audit_db() {
        let _ = conn.execute("DELETE FROM dispatch_audit WHERE id = ?1", rusqlite::params![msg_id]);
    }
}

#[test]
fn wake_on_message_creates_canonical_thread_across_persistent_and_oneshot_engines() {
    use crate::persist::{agents, threads, AgentProfile};

    let unique = uuid::Uuid::new_v4().simple().to_string();
    let codex_id = format!("cold-codex-{unique}");
    let claude_id = format!("cold-claude-{unique}");
    let msg_codex = format!("msg-codex-{unique}");
    let msg_claude = format!("msg-claude-{unique}");

    {
        let mut list = agents().lock().unwrap();
        list.push(AgentProfile {
            id: codex_id.clone(),
            name: "Codex Teammate".to_string(),
            engine: "codex".to_string(),
            purpose: "Backend".to_string(),
            brief: "Handle Rust".to_string(),
            avatar: None,
            created_at_unix_ms: 1_000,
            pinned: false,
            order: 0,
            memory_budget: Some(4000),
            reflection_mode: None,
            allow_agent_scheduling: Some(true),
            allow_agent_messaging: Some(true),
            default_mode: Some("auto".to_string()),
            default_plan: Some(false),
            default_model: Some("gpt-5.3-codex".to_string()),
            default_provider_options: vec![json!({ "id": "effort", "value": "high" })],
            place_display_names: Vec::new(),
            disabled_plugin_ids: Vec::new(),
        });
        list.push(AgentProfile {
            id: claude_id.clone(),
            name: "Claude Teammate".to_string(),
            engine: "claude-code".to_string(),
            purpose: "Review".to_string(),
            brief: "Review PRs".to_string(),
            avatar: None,
            created_at_unix_ms: 1_000,
            pinned: false,
            order: 1,
            memory_budget: Some(4000),
            reflection_mode: None,
            allow_agent_scheduling: Some(true),
            allow_agent_messaging: Some(true),
            default_mode: Some("readOnly".to_string()),
            default_plan: Some(true),
            default_model: Some("claude-sonnet-4-5".to_string()),
            default_provider_options: vec![json!({ "id": "effort", "value": "medium" })],
            place_display_names: Vec::new(),
            disabled_plugin_ids: Vec::new(),
        });
    }

    let res_codex = super::server::send_agent(
        &codex_id,
        "Run persistent wake",
        "agent",
        "Coordinator",
        Some(msg_codex.clone()),
    );
    assert_eq!(res_codex["delivered"], true, "codex wake failed: {res_codex}");
    assert_eq!(res_codex["status"], "submitted");
    let codex_tid = res_codex["receipt"]["address"]
        .as_str()
        .and_then(|a| a.strip_prefix("thread:"))
        .expect("codex receipt should target created thread")
        .to_string();

    let res_claude = super::server::send_agent(
        &claude_id,
        "Run one-shot wake",
        "agent",
        "Coordinator",
        Some(msg_claude.clone()),
    );
    assert_eq!(res_claude["delivered"], true, "claude wake failed: {res_claude}");
    assert_eq!(res_claude["status"], "submitted");
    let claude_tid = res_claude["receipt"]["address"]
        .as_str()
        .and_then(|a| a.strip_prefix("thread:"))
        .expect("claude receipt should target created thread")
        .to_string();

    {
        let list = threads().lock().unwrap();
        let t_codex = list
            .iter()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(codex_tid.as_str()))
            .expect("codex thread created");
        assert_eq!(t_codex["profileId"], codex_id);
        assert_eq!(t_codex["provider"], "codex");
        assert_eq!(t_codex["model"], "gpt-5.3-codex");
        assert_eq!(t_codex["mode"], "auto");
        assert_eq!(t_codex["effort"], "high");

        let t_claude = list
            .iter()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(claude_tid.as_str()))
            .expect("claude thread created");
        assert_eq!(t_claude["profileId"], claude_id);
        assert_eq!(t_claude["provider"], "claude");
        assert_eq!(t_claude["model"], "claude-sonnet-4-5");
        assert_eq!(t_claude["mode"], "readOnly");
        assert_eq!(t_claude["plan"], true);
        assert_eq!(t_claude["effort"], "medium");
    }

    let claude_inbox = super::server::inbox(&claude_id, None);
    let claude_msg = claude_inbox["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"].as_str() == Some(msg_claude.as_str()))
        .expect("claude message in inbox");
    assert_eq!(claude_msg["threadId"].as_str(), Some(claude_tid.as_str()));

    if let Ok(mut live) = crate::chat::live_turns().lock() {
        live.by_thread.remove(&codex_tid);
        live.by_thread.remove(&claude_tid);
    }
    threads()
        .lock()
        .unwrap()
        .retain(|t| {
            let id = t.get("id").and_then(Value::as_str).unwrap_or("");
            id != codex_tid && id != claude_tid
        });
    agents()
        .lock()
        .unwrap()
        .retain(|a| a.id != codex_id && a.id != claude_id);
    if let Some(conn) = super::audit::audit_db() {
        let _ = conn.execute(
            "DELETE FROM dispatch_audit WHERE id IN (?1, ?2)",
            rusqlite::params![msg_codex, msg_claude],
        );
    }
}

#[test]
fn wake_on_message_respects_allow_agent_messaging_false() {
    use crate::persist::{agents, threads, AgentProfile};

    let unique = uuid::Uuid::new_v4().simple().to_string();
    let profile_id = format!("blocked-agent-{unique}");
    let msg_id = format!("msg-blocked-{unique}");

    {
        let mut list = agents().lock().unwrap();
        list.push(AgentProfile {
            id: profile_id.clone(),
            name: "Blocked Agent".to_string(),
            engine: "codex".to_string(),
            purpose: "Test".to_string(),
            brief: "Test".to_string(),
            avatar: None,
            created_at_unix_ms: 1_000,
            pinned: false,
            order: 0,
            memory_budget: Some(4000),
            reflection_mode: None,
            allow_agent_scheduling: Some(true),
            allow_agent_messaging: Some(false),
            default_mode: None,
            default_plan: None,
            default_model: None,
            default_provider_options: Vec::new(),
            place_display_names: Vec::new(),
            disabled_plugin_ids: Vec::new(),
        });
    }

    let res = super::server::send_agent(
        &profile_id,
        "Should be blocked",
        "agent",
        "Coordinator",
        Some(msg_id.clone()),
    );
    assert_eq!(res["delivered"], false);
    assert_eq!(res["status"], "rejected");
    assert_eq!(res["error"], "messaging_disabled");
    let created_any = threads()
        .lock()
        .unwrap()
        .iter()
        .any(|t| t.get("profileId").and_then(Value::as_str) == Some(profile_id.as_str()));
    assert!(!created_any, "blocked agent must not spawn a thread");

    agents().lock().unwrap().retain(|a| a.id != profile_id);
    if let Some(conn) = super::audit::audit_db() {
        let _ = conn.execute("DELETE FROM dispatch_audit WHERE id = ?1", rusqlite::params![msg_id]);
    }
}

#[test]
fn dispatch_audit_migration_preserves_existing_rows_and_surfaces_thread_id() {
    let unique = uuid::Uuid::new_v4().simple().to_string();
    let profile_id = format!("audit-prof-{unique}");
    let legacy_id = format!("legacy-{unique}");
    let new_id = format!("new-{unique}");
    let target_tid = format!("tid-audit-{unique}");

    let conn = super::audit::audit_db().expect("audit_db");
    let has_col = conn
        .prepare("PRAGMA table_info(dispatch_audit)")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .flatten()
        .any(|c| c == "thread_id");
    assert!(has_col, "dispatch_audit must have thread_id column");

    conn.execute(
        "INSERT OR REPLACE INTO dispatch_audit
         (id, op, address, body, status, submitted, historical, sender_name, profile_id, error, created_ms, thread_id)
         VALUES (?1, 'send', ?2, 'Legacy body', 'submitted', 1, 0, 'Agent', ?3, NULL, 1000, NULL)",
        rusqlite::params![legacy_id, format!("agent:{profile_id}"), profile_id],
    )
    .unwrap();

    let row = crate::dispatch::audit::AuditRow {
        id: new_id.clone(),
        op: "send".into(),
        address: format!("thread:{target_tid}"),
        body: "New body".into(),
        status: "submitted".into(),
        submitted: true,
        historical: false,
        sender_name: "Agent".into(),
        profile_id: profile_id.clone(),
        created_ms: 2000,
    };
    super::audit::insert_audit_with_thread(&row, Some(&target_tid))
        .expect("insert_audit_with_thread");

    let inbox = super::server::inbox(&profile_id, None);
    let msgs = inbox["messages"].as_array().unwrap();
    let legacy_msg = msgs.iter().find(|m| m["id"] == legacy_id).expect("legacy row preserved");
    assert!(legacy_msg["threadId"].is_null());
    let new_msg = msgs.iter().find(|m| m["id"] == new_id).expect("new row present");
    assert_eq!(new_msg["threadId"].as_str(), Some(target_tid.as_str()));

    let _ = conn.execute(
        "DELETE FROM dispatch_audit WHERE id IN (?1, ?2)",
        rusqlite::params![legacy_id, new_id],
    );
}

#[test]
fn steer_cancel_preserve_children_rearms_dispatch_notice_and_delivers_after_steered_turn_settles() {
    use crate::chat::runtime::state::{live_turns, TurnRun};
    use crate::persist::threads;

    let parent_id = format!("wire-steer-parent-{}", uuid::Uuid::new_v4().simple());
    let child_id = format!("wire-steer-child-{}", uuid::Uuid::new_v4().simple());
    let parent_addr = format!("thread:{parent_id}");
    let child_addr = format!("thread:{child_id}");
    let p_run_1 = format!("wire-steer-prun1-{}", uuid::Uuid::new_v4().simple());
    let c_run = format!("wire-steer-crun-{}", uuid::Uuid::new_v4().simple());

    {
        let mut list = threads().lock().unwrap();
        list.push(json!({
            "id": parent_id,
            "provider": "antigravity",
            "status": "running",
            "items": [
                { "id": "u1", "kind": "user", "text": "Delegate work" }
            ],
            "subagentRuns": [
                {
                    "subagentId": "sub-wire-1",
                    "parentThreadId": parent_id,
                    "parentToolCallId": "call-wire-1",
                    "role": "Researcher",
                    "status": "running",
                    "childThreadId": child_id,
                    "stepCount": 1,
                    "items": [],
                    "startedAtUnixMs": 1000,
                    "updatedAtUnixMs": 1000
                }
            ]
        }));
        list.push(json!({
            "id": child_id,
            "parentThreadId": parent_id,
            "startedByAgent": true,
            "sideChat": true,
            "provider": "grok",
            "status": "running",
            "items": [
                { "id": "cu1", "kind": "user", "text": "Inspect codebase" },
                { "id": "ca1", "kind": "assistant", "text": "Subagent finished findings." }
            ]
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
        started_at_ms: 1000,
        finished_at_ms: None,
        routine_id: None,
        delivered_through: 0,
        file_baselines: std::collections::HashMap::new(),
    };
    {
        let mut live = live_turns().lock().unwrap();
        live.runs.insert(p_run_1.clone(), make_run("pa1"));
        live.by_thread.insert(parent_id.clone(), p_run_1.clone());
        live.runs.insert(c_run.clone(), make_run("ca1"));
        live.by_thread.insert(child_id.clone(), c_run.clone());
    }

    // Attach parent + child with child's parent notice suppressed (simulating an active `run --wait`).
    {
        let mut svc = super::protocol::service().lock().unwrap();
        let _ = svc.attach(Family::Thread, &parent_id, None, None, false);
        let _ = svc.attach(Family::Thread, &child_id, None, Some(&parent_addr), false);
        super::protocol::publish_thread(&mut svc, &parent_id);
        super::protocol::publish_thread(&mut svc, &child_id);
        svc.suppress_parent_notice_for(&child_addr);
    }

    // 1. Steer cancel (preserve_children = true) stops parent, keeps child alive, and re-arms child's notice.
    crate::chat::cancel_turn_with_options(&parent_id, true);
    assert!(!crate::chat::is_turn_running(&parent_id));
    assert!(crate::chat::is_turn_running(&child_id));

    // 2. Steered parent turn starts -> publishes Working presence via on_thread_started.
    let started = crate::chat::start_turn(&parent_id, None, "Consider edge case X too", Vec::new(), None);
    let steered_run_id = started["runId"].as_str().unwrap().to_string();
    assert!(crate::chat::is_turn_running(&parent_id));

    // 3. Child completes while parent is running its steered turn -> notice must QUEUE, not replace parent's run!
    crate::chat::finish_run(&c_run, true, false, "");
    let active_parent_run = {
        let live = live_turns().lock().unwrap();
        live.by_thread.get(&parent_id).cloned()
    };
    assert_eq!(
        active_parent_run.as_deref(),
        Some(steered_run_id.as_str()),
        "child completion while parent is running steered turn must not clobber active steered run"
    );

    // 4. Parent finishes its steered turn -> queued child completion notice wakes parent automatically!
    crate::chat::finish_run(&steered_run_id, true, false, "");
    let has_child_notice = {
        let list = threads().lock().unwrap();
        list.iter()
            .find(|t| t["id"] == parent_id)
            .and_then(|parent| parent["items"].as_array())
            .is_some_and(|items| {
                items.iter().any(|it| {
                    it.get("kind").and_then(Value::as_str) == Some("user")
                        && it
                            .get("text")
                            .and_then(Value::as_str)
                            .is_some_and(|text| text.contains("Subagent finished findings."))
                })
            })
    };
    assert!(
        has_child_notice,
        "queued child completion notice must wake parent once steered turn finishes"
    );

    // Cleanup
    crate::chat::cancel_turn(&parent_id);
    {
        let mut svc = super::protocol::service().lock().unwrap();
        let _ = svc.kill("cleanup-wire-steer-p2-c", &child_addr);
        let _ = svc.kill("cleanup-wire-steer-p2-p", &parent_addr);
    }
    super::protocol::clear_thread_killed(&child_id);
    super::protocol::clear_thread_killed(&parent_id);
    crate::chat::threads::remove_thread(&child_id);
    crate::chat::threads::remove_thread(&parent_id);
}

#[test]
fn live_port_swarm_add_and_kill_do_not_self_deadlock_service_mutex() {
    use crate::persist::threads;

    let parent_id = format!("wire-swarm-reent-{}", uuid::Uuid::new_v4().simple());
    let parent_addr = format!("thread:{parent_id}");

    {
        let mut parent = crate::chat::threads::blank_thread(
            &parent_id,
            None,
            "Swarm Reentrancy Coordinator",
            "antigravity",
            None,
        );
        parent["status"] = json!("running");
        threads().lock().unwrap().push(parent);
    }

    // `execute_argv_envelope` locks `service()` -> `Service::swarm` -> `LivePort::swarm` ->
    // `execute_swarm_action` -> `start_turn` (`on_thread_started`) / `cancel_turn` (`on_thread_settled`).
    // Without `LivePortReentrancyGuard` in `LivePort::swarm`, either call would self-deadlock.
    let add_env = execute_argv_envelope(&json!({
        "id": "wire-swarm-reent-add-1",
        "caller": "agent",
        "from": parent_addr,
        "argv": [
            "kite", "dispatch", "swarm", "add",
            "--name", "auditor",
            "--brief", "Verify lock safety"
        ]
    }));
    assert_eq!(add_env["exit"], 0, "swarm add via LivePort::swarm failed: {add_env:?}");

    let child_tid = {
        let list = threads().lock().unwrap();
        list.iter()
            .find(|t| t["id"] == parent_id)
            .and_then(|t| t.pointer("/swarmState/members"))
            .and_then(Value::as_array)
            .and_then(|m| m.first())
            .and_then(|m| m.get("childThreadId"))
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    let child_tid = child_tid.expect("swarm add must create worker childThreadId");

    let kill_env = execute_argv_envelope(&json!({
        "id": "wire-swarm-reent-kill-1",
        "caller": "agent",
        "from": parent_addr,
        "argv": [
            "kite", "dispatch", "swarm", "kill",
            "--name", "auditor"
        ]
    }));
    assert_eq!(kill_env["exit"], 0, "swarm kill via LivePort::swarm failed: {kill_env:?}");

    crate::chat::cancel_turn(&child_tid);
    crate::chat::cancel_turn(&parent_id);
    super::protocol::clear_thread_killed(&child_tid);
    super::protocol::clear_thread_killed(&parent_id);
    crate::chat::threads::remove_thread(&child_tid);
    crate::chat::threads::remove_thread(&parent_id);
}

#[test]
fn thread_launch_parses_and_creates_top_level_thread_with_worktree_orchestrate_and_odd_path() {
    use crate::dispatch::cli::{is_agent_argv, parse_agent_args, AgentCommand};
    use crate::persist::{agents, paths, threads, workspaces, AgentProfile, Workspace};

    let launch_argv: Vec<String> = [
        "kite",
        "agent",
        "thread",
        "launch",
        "--title",
        "Launch V3",
        "--prompt",
        "Implement ODD spec",
        "--workspace",
        "ws-1",
        "--provider",
        "claude-code",
        "--model",
        "claude-sonnet-4-6",
        "--mode",
        "fullAccess",
        "--effort",
        "high",
        "--worktree",
        "--odd",
        "odd/tasks/v3.md",
        "--open",
        "--orchestrate",
    ]
    .iter()
    .map(|s| (*s).to_string())
    .collect();
    assert!(is_agent_argv(&launch_argv));
    assert_eq!(
        parse_agent_args(&launch_argv).unwrap(),
        AgentCommand::ThreadLaunch {
            title: Some("Launch V3".to_string()),
            prompt: "Implement ODD spec".to_string(),
            workspace_id: Some("ws-1".to_string()),
            provider: Some("claude".to_string()),
            model: Some("claude-sonnet-4-6".to_string()),
            mode: Some("fullAccess".to_string()),
            effort: Some("high".to_string()),
            worktree: true,
            odd_path: Some("odd/tasks/v3.md".to_string()),
            open: true,
            orchestrate: true,
        }
    );

    let pos_argv: Vec<String> = [
        "dispatch",
        "agent",
        "thread",
        "launch",
        "Positional kickoff prompt",
    ]
    .iter()
    .map(|s| (*s).to_string())
    .collect();
    assert!(is_agent_argv(&pos_argv));
    assert_eq!(
        parse_agent_args(&pos_argv).unwrap(),
        AgentCommand::ThreadLaunch {
            title: None,
            prompt: "Positional kickoff prompt".to_string(),
            workspace_id: None,
            provider: None,
            model: None,
            mode: None,
            effort: None,
            worktree: false,
            odd_path: None,
            open: false,
            orchestrate: false,
        }
    );

    let unique = uuid::Uuid::new_v4().simple().to_string();
    let repo_dir = std::env::temp_dir().join(format!("kite-thread-launch-{unique}"));
    let _ = std::fs::remove_dir_all(&repo_dir);
    std::fs::create_dir_all(&repo_dir).unwrap();
    let git = |args: &[&str]| {
        crate::git::run_git(&repo_dir, args).expect("git executable available for launch test")
    };
    assert!(git(&["init"]).status.success());
    assert!(git(&["config", "user.email", "test@kite.local"]).status.success());
    assert!(git(&["config", "user.name", "Kite Test"]).status.success());
    std::fs::write(repo_dir.join("README.md"), "launch\n").unwrap();
    assert!(git(&["add", "README.md"]).status.success());
    assert!(git(&["commit", "-m", "init"]).status.success());

    let ws_id = format!("ws-launch-{unique}");
    let agent_id = format!("agent-launch-{unique}");
    {
        workspaces().lock().unwrap().push(Workspace {
            id: ws_id.clone(),
            display_name: "Launch Test Repo".to_string(),
            created_at_unix_ms: 1_000,
            last_opened_at_unix_ms: 1_000,
            pinned: false,
            available: true,
        });
        paths()
            .lock()
            .unwrap()
            .insert(ws_id.clone(), repo_dir.to_string_lossy().to_string());
        agents().lock().unwrap().push(AgentProfile {
            id: agent_id.clone(),
            name: "Discovery Architect".to_string(),
            engine: "claude-code".to_string(),
            purpose: "Research and launch".to_string(),
            brief: "Research and launch".to_string(),
            avatar: None,
            created_at_unix_ms: 1_000,
            pinned: false,
            order: 0,
            memory_budget: Some(2200),
            reflection_mode: None,
            allow_agent_scheduling: Some(true),
            allow_agent_messaging: Some(true),
            default_mode: Some("fullAccess".to_string()),
            default_plan: Some(false),
            default_model: None,
            default_provider_options: Vec::new(),
            place_display_names: Vec::new(),
            disabled_plugin_ids: Vec::new(),
        });
    }

    // Launch by directory path + caller agent engine fallback + worktree + oddPath + orchestrate
    let env_res = execute_argv_envelope(&json!({
        "id": "wire-thread-launch-1",
        "agentId": &agent_id,
        "argv": [
            "kite",
            "agent",
            "thread",
            "launch",
            "--title",
            "Discovery Kickoff",
            "--workspace-id",
            repo_dir.to_string_lossy().to_string(),
            "--odd-path",
            "odd/tasks/feature-x.md",
            "--worktree",
            "--open",
            "--orchestrate",
            "--prompt",
            "Build feature X cleanly."
        ]
    }));
    assert_eq!(env_res["exit"], 0, "launch failed: {env_res:?}");
    let res = &env_res["result"];
    assert_eq!(res["schema"], "kite.thread-launch/v1");
    assert_eq!(res["provider"], "claude");
    assert_eq!(res["workspaceId"], ws_id);
    assert_eq!(res["open"], true);
    assert_eq!(res["status"], "running");
    assert!(res["runId"].as_str().is_some_and(|s| !s.is_empty()));
    let wt_str = res["worktreePath"].as_str().expect("worktreePath must be set");
    assert!(std::path::Path::new(wt_str).exists());
    let launched_tid = res["threadId"].as_str().unwrap().to_string();

    {
        let list = threads().lock().unwrap();
        let thread = list
            .iter()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(launched_tid.as_str()))
            .expect("launched thread must exist");
        assert!(thread.get("profileId").is_none_or(Value::is_null));
        assert_eq!(thread.get("sideChat").and_then(Value::as_bool), Some(false));
        assert_eq!(thread.get("startedByAgent").and_then(Value::as_bool), Some(false));
        assert!(thread.get("parentThreadId").is_none_or(Value::is_null));
        assert_eq!(
            thread.get("oddPath").and_then(Value::as_str),
            Some("odd/tasks/feature-x.md")
        );
        assert_eq!(thread.get("workspaceId").and_then(Value::as_str), Some(ws_id.as_str()));
        assert_eq!(thread.get("worktreePath").and_then(Value::as_str), Some(wt_str));
        assert_eq!(thread.get("workingDirectory").and_then(Value::as_str), Some(wt_str));
        assert_eq!(thread.get("workspaceMode").and_then(Value::as_str), Some("branch"));
        let first_user_text = thread["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|it| it.get("kind").and_then(Value::as_str) == Some("user"))
            .and_then(|it| it.get("text").and_then(Value::as_str))
            .unwrap_or("");
        assert!(first_user_text.contains("[Orchestrator Mode]"));
        assert!(first_user_text.contains("odd/tasks/feature-x.md"));
        assert!(first_user_text.contains("kite_subagent_run"));
        assert!(first_user_text.contains("Build feature X cleanly."));
    }

    crate::chat::cancel_turn(&launched_tid);
    crate::chat::threads::remove_thread(&launched_tid);
    let _ = git(&["worktree", "remove", "--force", wt_str]);
    let _ = std::fs::remove_dir_all(&repo_dir);
    workspaces().lock().unwrap().retain(|w| w.id != ws_id);
    paths().lock().unwrap().remove(&ws_id);
    agents().lock().unwrap().retain(|a| a.id != agent_id);
    if let Ok(conn) = crate::persist::db_connection().lock() {
        let _ = conn.execute(
            "DELETE FROM agent_audit_log WHERE agent_id = ?1",
            rusqlite::params![agent_id],
        );
    }
}

#[test]
fn agent_audit_log_records_thread_memory_routine_teammate_dispatch_and_policy_denials() {
    use crate::agents::{
        list_agent_audit_log_in_conn, save_agent_autonomy_config, AgentAutonomyConfig,
    };
    use crate::persist::{agents, db_connection, AgentProfile};

    let restricted_id = uuid::Uuid::new_v4().to_string();
    let allowed_id = uuid::Uuid::new_v4().to_string();

    {
        let mut list = agents().lock().unwrap();
        for (aid, sched, disabled) in [
            (&restricted_id, false, vec!["kite-dispatch".to_string()]),
            (&allowed_id, true, Vec::new()),
        ] {
            list.push(AgentProfile {
                id: aid.clone(),
                name: format!("Audit {aid}"),
                engine: "antigravity".to_string(),
                purpose: "Audit test".to_string(),
                brief: "Audit test".to_string(),
                avatar: None,
                created_at_unix_ms: 1_000,
                pinned: false,
                order: 0,
                memory_budget: Some(1000),
                reflection_mode: None,
                allow_agent_scheduling: Some(sched),
                allow_agent_messaging: Some(true),
                default_mode: None,
                default_plan: None,
                default_model: None,
                default_provider_options: Vec::new(),
                place_display_names: Vec::new(),
                disabled_plugin_ids: disabled,
            });
        }
    }

    let mut cfg = AgentAutonomyConfig::default();
    cfg.tool_policies.insert("thread".into(), "deny".into());
    cfg.tool_policies.insert("memory".into(), "allow".into());
    cfg.tool_policies.insert("teammate".into(), "ask".into());
    save_agent_autonomy_config(&restricted_id, &cfg).unwrap();

    // 1. thread -> policy deny
    let thread_denied = execute_argv_envelope(&json!({
        "id": "aud-thread-1",
        "agentId": &restricted_id,
        "argv": ["kite", "agent", "thread", "list"]
    }));
    assert_eq!(thread_denied["exit"], 1);

    // 2. memory -> allow
    let mem_ok = execute_argv_envelope(&json!({
        "id": "aud-mem-1",
        "agentId": &restricted_id,
        "argv": ["kite", "agent", "memory", "read"]
    }));
    assert_eq!(mem_ok["exit"], 0);

    // 3. routine -> allowAgentScheduling = false -> denied
    let routine_denied = execute_argv_envelope(&json!({
        "id": "aud-routine-1",
        "agentId": &restricted_id,
        "argv": ["kite", "agent", "routine", "list"]
    }));
    assert_eq!(routine_denied["exit"], 1);

    // 4. teammate -> policy ask without active interactive thread session -> denied
    let teammate_asked = execute_argv_envelope(&json!({
        "id": "aud-teammate-1",
        "agentId": &restricted_id,
        "argv": ["kite", "agent", "teammate", "list"]
    }));
    assert_eq!(teammate_asked["exit"], 1);

    // 5. kite-dispatch disabled -> denied
    let dispatch_denied = execute_argv_envelope(&json!({
        "id": "aud-dispatch-1",
        "agentId": &restricted_id,
        "argv": ["kite", "dispatch", "ls"]
    }));
    assert_eq!(dispatch_denied["exit"], 1);

    // 6. execute_command & execute_swarm_command with env.KITE_AGENT_ID
    let ls_ok = execute_argv_envelope(&json!({
        "id": "aud-exec-ls-1",
        "env": { "KITE_AGENT_ID": &allowed_id },
        "argv": ["kite", "dispatch", "ls"]
    }));
    assert_eq!(ls_ok["exit"], 0);

    let swarm_res = super::server::execute_swarm_command(
        &json!({
            "id": "aud-swarm-1",
            "caller": "agent",
            "from": "thread:missing-coord",
            "env": { "KITE_AGENT_ID": &allowed_id }
        }),
        "aud-swarm-1",
        &crate::dispatch::cli::SwarmCommand::Status,
    );
    assert_eq!(swarm_res.op, "swarm");

    {
        let conn = db_connection().lock().unwrap();
        let restricted_rows =
            list_agent_audit_log_in_conn(&conn, Some(&restricted_id), None, None, 20).unwrap();
        assert!(restricted_rows.iter().any(|r| r.tool_name == "kite_thread" && r.tool_family == "thread" && r.verdict == "denied"));
        assert!(restricted_rows.iter().any(|r| r.tool_name == "kite_memory" && r.tool_family == "memory" && r.verdict == "allowed"));
        assert!(restricted_rows.iter().any(|r| r.tool_name == "kite_routine" && r.tool_family == "routine" && r.verdict == "denied"));
        assert!(restricted_rows.iter().any(|r| r.tool_name == "kite_teammate" && r.tool_family == "teammate" && r.verdict == "denied"));
        assert!(restricted_rows.iter().any(|r| r.tool_name == "kite_dispatch" && r.tool_family == "subagents" && r.verdict == "denied"));

        let allowed_rows =
            list_agent_audit_log_in_conn(&conn, Some(&allowed_id), None, None, 20).unwrap();
        assert!(allowed_rows.iter().any(|r| r.tool_name == "kite_dispatch_ls" && r.tool_family == "subagents" && r.verdict == "allowed"));
        assert!(allowed_rows.iter().any(|r| r.tool_name == "kite_swarm" && r.tool_family == "subagents"));

        let _ = conn.execute(
            "DELETE FROM agent_audit_log WHERE agent_id IN (?1, ?2)",
            rusqlite::params![restricted_id, allowed_id],
        );
        let _ = conn.execute(
            "DELETE FROM agent_autonomy_config WHERE agent_id = ?1",
            rusqlite::params![restricted_id],
        );
    }
    let _ = std::fs::remove_dir_all(crate::agent_mind::get_agent_home_dir(&restricted_id));
    agents()
        .lock()
        .unwrap()
        .retain(|a| a.id != restricted_id && a.id != allowed_id);
}





