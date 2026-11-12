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
            "workspaceId": Value::Null,
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

    // Cleanup worktrees and test threads
    let _ = git(&["worktree", "remove", "--force", &wt_share.to_string_lossy()]);
    let _ = git(&["worktree", "remove", "--force", &wt_branch.to_string_lossy()]);
    let _ = std::fs::remove_dir_all(&repo_dir);
    let mut list = threads().lock().unwrap();
    list.retain(|t| {
        let id = t.get("id").and_then(Value::as_str).unwrap_or("");
        id != parent_id && id != child_id.as_str()
    });
}
