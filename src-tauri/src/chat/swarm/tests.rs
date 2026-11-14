use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

use super::*;
use crate::chat::subagents::set_thread_effort_option;
use crate::chat::threads::blank_thread;
use crate::dispatch::cli::SwarmCommand;
use crate::persist::threads;

struct CleanupSwarmThread(String, PathBuf);
impl Drop for CleanupSwarmThread {
    fn drop(&mut self) {
        if let Ok(mut list) = threads().lock() {
            list.retain(|t| {
                let id = t.get("id").and_then(Value::as_str).unwrap_or("");
                let pid = t.get("parentThreadId").and_then(Value::as_str).unwrap_or("");
                id != self.0 && pid != self.0
            });
        }
        let _ = fs::remove_dir_all(&self.1);
    }
}

fn init_git_repo(dir: &Path) {
    fs::create_dir_all(dir).unwrap();
    assert!(crate::git::run_git(dir, &["init"]).unwrap().status.success());
    assert!(crate::git::run_git(dir, &["config", "user.email", "test@kite.local"])
        .unwrap()
        .status
        .success());
    assert!(crate::git::run_git(dir, &["config", "user.name", "Kite Test"])
        .unwrap()
        .status
        .success());
    fs::write(dir.join("README.md"), "swarm seed\n").unwrap();
    assert!(crate::git::run_git(dir, &["add", "README.md"])
        .unwrap()
        .status
        .success());
    assert!(crate::git::run_git(dir, &["commit", "-m", "init"])
        .unwrap()
        .status
        .success());
}

#[test]
fn swarm_title_add_mention_wakeup_channel_model_failover_and_kill() {
    let coord_id = format!("swarm-coord-{}", uuid::Uuid::new_v4().simple());
    let repo_dir = std::env::temp_dir().join(format!("kite-swarm-repo-{}", uuid::Uuid::new_v4().simple()));
    init_git_repo(&repo_dir);
    let _guard = CleanupSwarmThread(coord_id.clone(), repo_dir.clone());

    let mut coord = blank_thread(&coord_id, None, "Main Coordinator", "antigravity", None);
    coord["model"] = json!("claude-opus-4-6");
    coord["workingDirectory"] = json!(repo_dir.to_string_lossy().to_string());
    coord["items"] = json!([{ "id": "u0", "kind": "user", "text": "Coordinate swarm" }]);
    threads().lock().unwrap().push(coord);

    let launched: Arc<Mutex<Vec<(String, String)>>> = Arc::new(Mutex::new(Vec::new()));
    let launched_clone = launched.clone();
    let launcher_fn = move |cid: &str, prompt: &str| -> Result<(), String> {
        launched_clone
            .lock()
            .unwrap()
            .push((cid.to_string(), prompt.to_string()));
        Ok(())
    };

    let coord_addr = format!("thread:{coord_id}");
    let cwd_str = repo_dir.to_string_lossy().to_string();

    execute_swarm_action(
        &SwarmCommand::Title {
            title: "Cross-Provider Refactor".into(),
        },
        &coord_addr,
        Some(&cwd_str),
        Some(&launcher_fn),
    )
    .unwrap();

    // Reject reserved name
    assert!(execute_swarm_action(
        &SwarmCommand::Add {
            name: "coordinator".into(),
            provider: Some("grok".into()),
            model: Some("grok-3-mini".into()),
            effort: None,
            workspace: None,
            channels: Vec::new(),
            fork: None,
            role: None,
            override_stack: false,
            brief: "invalid".into(),
        },
        &coord_addr,
        Some(&cwd_str),
        Some(&launcher_fn),
    )
    .is_err());

    // Add grok worker with share worktree, forked context, and channel #parser
    let add_res = execute_swarm_action(
        &SwarmCommand::Add {
            name: "verifier".into(),
            provider: Some("grok".into()),
            model: Some("grok-3-mini".into()),
            effort: Some("low".into()),
            workspace: Some("share".into()),
            channels: vec!["parser".into()],
            fork: Some("coordinator".into()),
            role: Some("Parser Verifier".into()),
            override_stack: false,
            brief: "Audit token edge cases".into(),
        },
        &coord_addr,
        Some(&cwd_str),
        Some(&launcher_fn),
    )
    .unwrap();
    assert!(add_res.contains("added @verifier"), "add_res={add_res}");

    // Add second worker subscribed only to #ui
    execute_swarm_action(
        &SwarmCommand::Add {
            name: "ui-dev".into(),
            provider: Some("gemini".into()),
            model: Some("gemini-2.5-flash".into()),
            effort: None,
            workspace: Some("inherit".into()),
            channels: vec!["ui".into()],
            fork: None,
            role: Some("UI Worker".into()),
            override_stack: false,
            brief: "Polish badge".into(),
        },
        &coord_addr,
        Some(&cwd_str),
        Some(&launcher_fn),
    )
    .unwrap();

    let (state, swarm_path) = load_swarm_state(&coord_id, Some(&cwd_str));
    assert!(swarm_path.exists());
    assert_eq!(state.members.len(), 2);
    let verifier_cid = state.members[0].child_thread_id.clone().unwrap();
    let ui_cid = state.members[1].child_thread_id.clone().unwrap();
    let verifier_addr = format!("thread:{verifier_cid}");

    // Verify forked items & worktree on verifier child thread
    let verifier_wt = {
        let all = threads().lock().unwrap();
        let v = all.iter().find(|t| t["id"] == verifier_cid).unwrap();
        assert_eq!(v["items"].as_array().unwrap().len(), 1);
        v["worktreePath"].as_str().unwrap().to_string()
    };
    assert!(PathBuf::from(&verifier_wt).join("README.md").exists());

    // Settle both workers so they transition working -> waiting (zero idle tokens)
    on_worker_turn_settled_with_launcher(&verifier_cid, true, Some(&launcher_fn));
    on_worker_turn_settled_with_launcher(&ui_cid, true, Some(&launcher_fn));

    let status_waiting = execute_swarm_action(
        &SwarmCommand::Status,
        &coord_addr,
        Some(&cwd_str),
        Some(&launcher_fn),
    )
    .unwrap();
    assert!(status_waiting.contains("state=waiting"));

    // Channel mention @#parser wakes ONLY verifier, leaving ui-dev waiting!
    let launches_before = launched.lock().unwrap().len();
    execute_swarm_action(
        &SwarmCommand::Post {
            channel: Some("parser".into()),
            text: "@#parser check #1 again".into(),
        },
        &coord_addr,
        Some(&cwd_str),
        Some(&launcher_fn),
    )
    .unwrap();
    {
        let launches = launched.lock().unwrap();
        assert_eq!(launches.len(), launches_before + 1);
        assert_eq!(launches.last().unwrap().0, verifier_cid);
    }

    // While verifier is WORKING, posting another @verifier mention queues pending_wake (does not double-launch)
    execute_swarm_action(
        &SwarmCommand::Post {
            channel: None,
            text: "@verifier check #2 too".into(),
        },
        &coord_addr,
        Some(&cwd_str),
        Some(&launcher_fn),
    )
    .unwrap();
    assert_eq!(launched.lock().unwrap().len(), launches_before + 1);

    // Settling verifier drains pending_wake and immediately launches follow-up turn!
    on_worker_turn_settled_with_launcher(&verifier_cid, true, Some(&launcher_fn));
    assert_eq!(launched.lock().unwrap().len(), launches_before + 2);

    // Now verifier reads before settling, then settles -> waiting cleanly!
    let read_out = execute_swarm_action(
        &SwarmCommand::Read {
            since: 1,
            channel: None,
        },
        &verifier_addr,
        Some(&cwd_str),
        Some(&launcher_fn),
    )
    .unwrap();
    assert!(read_out.contains("check #2 too"));
    on_worker_turn_settled_with_launcher(&verifier_cid, true, Some(&launcher_fn));

    // Hot-swap verifier model across providers while keeping history intact
    {
        let mut all = threads().lock().unwrap();
        let v = all.iter_mut().find(|t| t["id"] == verifier_cid).unwrap();
        v["providerSessionId"] = json!("stale-grok-session");
        v["items"] = json!([
            { "id": "u0", "kind": "user", "text": "Coordinate swarm" },
            { "id": "a1", "kind": "assistant", "text": "Checked parser" }
        ]);
    }
    execute_swarm_action(
        &SwarmCommand::Model {
            name: "verifier".into(),
            provider: Some("codex".into()),
            model: "o4-mini".into(),
            effort: Some("high".into()),
            override_stack: false,
        },
        &coord_addr,
        Some(&cwd_str),
        Some(&launcher_fn),
    )
    .unwrap();
    {
        let all = threads().lock().unwrap();
        let v = all.iter().find(|t| t["id"] == verifier_cid).unwrap();
        assert_eq!(v["provider"], "codex");
        assert_eq!(v["model"], "o4-mini");
        assert!(v["providerSessionId"].is_null());
        assert_eq!(v["items"].as_array().unwrap().len(), 2);
    }

    // Kill verifier -> cleans clean worktree, marks killed permanently, refuses reuse
    execute_swarm_action(
        &SwarmCommand::Kill {
            name: "verifier".into(),
        },
        &coord_addr,
        Some(&cwd_str),
        Some(&launcher_fn),
    )
    .unwrap();
    assert!(!PathBuf::from(&verifier_wt).exists());
    assert!(execute_swarm_action(
        &SwarmCommand::Add {
            name: "verifier".into(),
            provider: Some("grok".into()),
            model: None,
            effort: None,
            workspace: None,
            channels: Vec::new(),
            fork: None,
            role: None,
            override_stack: false,
            brief: "reuse".into(),
        },
        &coord_addr,
        Some(&cwd_str),
        Some(&launcher_fn),
    )
    .is_err());
}

#[tokio::test]
async fn swarm_wait_wakes_immediately_on_post_without_polling() {
    let coord_id = format!("swarm-wait-{}", uuid::Uuid::new_v4().simple());
    let scratch = std::env::temp_dir().join(format!("kite-swarm-wait-{}", uuid::Uuid::new_v4().simple()));
    fs::create_dir_all(&scratch).unwrap();
    let _guard = CleanupSwarmThread(coord_id.clone(), scratch.clone());

    let mut coord = blank_thread(&coord_id, None, "Wait Coordinator", "antigravity", None);
    coord["workingDirectory"] = json!(scratch.to_string_lossy().to_string());
    threads().lock().unwrap().push(coord);

    let coord_addr = format!("thread:{coord_id}");
    let noop_launcher = |_cid: &str, _prompt: &str| -> Result<(), String> { Ok(()) };
    execute_swarm_action(
        &SwarmCommand::Add {
            name: "verifier".into(),
            provider: Some("grok".into()),
            model: None,
            effort: None,
            workspace: Some("inherit".into()),
            channels: vec!["main".into()],
            fork: None,
            role: Some("Verifier".into()),
            override_stack: false,
            brief: "Check audit".into(),
        },
        &coord_addr,
        None,
        Some(&noop_launcher),
    )
    .unwrap();

    let worker_tid = {
        let (state, _) = load_swarm_state(&coord_id, None);
        state.members[0].child_thread_id.clone().unwrap()
    };
    let worker_addr = format!("thread:{worker_tid}");

    let coord_addr_bg = coord_addr.clone();
    let wait_task = tokio::spawn(async move {
        wait_swarm_async(&coord_addr_bg, 1, true, 5_000).await
    });

    tokio::time::sleep(Duration::from_millis(60)).await;
    execute_swarm_action(
        &SwarmCommand::Post {
            channel: None,
            text: "@coordinator [done] finished audit".into(),
        },
        &worker_addr,
        None,
        None,
    )
    .unwrap();

    let output = wait_task.await.unwrap().unwrap();
    assert!(output.contains("[done] finished audit"), "output={output}");
    crate::chat::threads::remove_thread(&worker_tid);
}

#[test]
fn stopped_worker_model_switch_resumes_working_and_keeps_history() {
    let coord_id = format!("swarm-failover-{}", uuid::Uuid::new_v4().simple());
    let scratch = std::env::temp_dir().join(format!(
        "kite-swarm-failover-{}",
        uuid::Uuid::new_v4().simple()
    ));
    fs::create_dir_all(&scratch).unwrap();
    let _guard = CleanupSwarmThread(coord_id.clone(), scratch.clone());

    let mut coord = blank_thread(&coord_id, None, "Coordinator", "antigravity", None);
    coord["workingDirectory"] = json!(scratch.to_string_lossy().to_string());
    threads().lock().unwrap().push(coord);

    let coord_addr = format!("thread:{coord_id}");
    let cwd_str = scratch.to_string_lossy().to_string();
    let launches = Arc::new(Mutex::new(Vec::<(String, String)>::new()));
    let launches_ref = Arc::clone(&launches);
    let launcher_fn = move |cid: &str, prompt: &str| -> Result<(), String> {
        launches_ref
            .lock()
            .unwrap()
            .push((cid.to_string(), prompt.to_string()));
        Ok(())
    };

    execute_swarm_action(
        &SwarmCommand::Add {
            name: "quota-worker".into(),
            provider: Some("grok".into()),
            model: Some("grok-3-mini".into()),
            effort: None,
            workspace: Some("inherit".into()),
            channels: vec!["main".into()],
            fork: None,
            role: Some("Quota Worker".into()),
            override_stack: false,
            brief: "Audit auth".into(),
        },
        &coord_addr,
        Some(&cwd_str),
        Some(&launcher_fn),
    )
    .unwrap();

    let worker_cid = {
        let (state, _) = load_swarm_state(&coord_id, None);
        state.members[0].child_thread_id.clone().unwrap()
    };
    {
        let mut all = threads().lock().unwrap();
        let w = all.iter_mut().find(|t| t["id"] == worker_cid).unwrap();
        w["items"] = json!([
            { "id": "u1", "kind": "user", "text": "Audit auth" },
            { "id": "a1", "kind": "assistant", "text": "Hit rate limit halfway" }
        ]);
    }
    // Settle with ok=false -> stopped
    on_worker_turn_settled_with_launcher(&worker_cid, false, Some(&launcher_fn));

    let res = execute_swarm_action(
        &SwarmCommand::Model {
            name: "quota-worker".into(),
            provider: Some("gemini".into()),
            model: "gemini-2.5-flash".into(),
            effort: Some("medium".into()),
            override_stack: false,
        },
        &coord_addr,
        Some(&cwd_str),
        Some(&launcher_fn),
    )
    .unwrap();
    assert!(res.contains("(resumed)"), "res={res}");

    let (state, _) = load_swarm_state(&coord_id, Some(&cwd_str));
    assert_eq!(state.members[0].state, "working");
    assert_eq!(state.members[0].provider.as_deref(), Some("gemini"));
    assert_eq!(state.members[0].model.as_deref(), Some("gemini-2.5-flash"));
    {
        let calls = launches.lock().unwrap();
        assert_eq!(calls.len(), 3, "calls={calls:?}");
        assert_eq!(calls[1].0, coord_id, "silent failure must wake coordinator");
        assert_eq!(calls[2].0, worker_cid, "failover switch must resume worker");
        assert!(calls[2].1.contains("Swarm Failover Resume"));
    }

    let all = threads().lock().unwrap();
    let w = all.iter().find(|t| t["id"] == worker_cid).unwrap();
    assert_eq!(w["items"].as_array().unwrap().len(), 2);
    drop(all);
    crate::chat::threads::remove_thread(&worker_cid);
}

#[test]
fn swarm_worker_metadata_channel_priority_subagent_linkage_and_sync_wait() {
    let coord_id = format!("swarm-t3-audit-{}", uuid::Uuid::new_v4().simple());
    let scratch = std::env::temp_dir().join(format!(
        "kite-swarm-t3-audit-{}",
        uuid::Uuid::new_v4().simple()
    ));
    fs::create_dir_all(&scratch).unwrap();
    let _guard = CleanupSwarmThread(coord_id.clone(), scratch.clone());

    let mut coord = blank_thread(&coord_id, None, "Main", "antigravity", Some("ws-1"));
    coord["model"] = json!("claude-opus-4-6");
    set_thread_effort_option(&mut coord, "high");
    coord["workingDirectory"] = json!(scratch.to_string_lossy().to_string());
    threads().lock().unwrap().push(coord);

    let coord_addr = format!("thread:{coord_id}");
    let cwd_str = scratch.to_string_lossy().to_string();
    let noop_launcher = |_cid: &str, _prompt: &str| -> Result<(), String> { Ok(()) };

    execute_swarm_action(
        &SwarmCommand::Add {
            name: "parser".into(),
            provider: Some("grok".into()),
            model: None,
            effort: None,
            workspace: Some("inherit".into()),
            channels: vec!["parser".into()],
            fork: None,
            role: Some("Parser Specialist".into()),
            override_stack: false,
            brief: "Inspect lexer".into(),
        },
        &coord_addr,
        Some(&cwd_str),
        Some(&noop_launcher),
    )
    .unwrap();

    let (state, _) = load_swarm_state(&coord_id, Some(&cwd_str));
    assert_eq!(state.posts[0].channel, "parser");
    assert_eq!(state.members[0].channels, vec!["parser".to_string(), "main".to_string()]);
    let worker_cid = state.members[0].child_thread_id.clone().unwrap();

    let (child, parent) = {
        let all = threads().lock().unwrap();
        let child = all.iter().find(|t| t["id"] == worker_cid).unwrap().clone();
        let parent = all.iter().find(|t| t["id"] == coord_id).unwrap().clone();
        (child, parent)
    };
    assert!(child["profileId"].is_null(), "profileId={:?}", child["profileId"]);
    assert_eq!(child["workspaceId"].as_str(), Some("ws-1"));
    assert_ne!(child["model"].as_str(), Some("claude-opus-4-6"));
    assert_ne!(child["effort"].as_str(), Some("high"));

    let runs = parent["subagentRuns"].as_array().unwrap();
    assert!(
        runs.iter().any(|r| {
            r.get("childThreadId").and_then(Value::as_str) == Some(worker_cid.as_str())
                && r.get("swarmMemberName").and_then(Value::as_str) == Some("parser")
        }),
        "runs={runs:?}"
    );
    assert!(crate::chat::subagents::build_subagent_detail(&coord_id, &worker_cid).is_some());

    // Stopped worker stays stopped in build_swarm_state even if child["status"] == "idle".
    on_worker_turn_settled_with_launcher(&worker_cid, false, Some(&noop_launcher));
    let built = crate::chat::subagents::build_swarm_state(&coord_id);
    assert_eq!(built["members"][0]["state"], "stopped");

    // Filtered channel read must not advance last_read_seq past unread #main posts.
    execute_swarm_action(
        &SwarmCommand::Post {
            channel: Some("main".into()),
            text: "@all check main".into(),
        },
        &coord_addr,
        Some(&cwd_str),
        Some(&noop_launcher),
    )
    .unwrap();
    let before_read_seq = load_swarm_state(&coord_id, Some(&cwd_str)).0.members[0].last_read_seq;
    execute_swarm_action(
        &SwarmCommand::Read {
            since: 0,
            channel: Some("empty-ch".into()),
        },
        &format!("thread:{worker_cid}"),
        Some(&cwd_str),
        Some(&noop_launcher),
    )
    .unwrap();
    let after_read_seq = load_swarm_state(&coord_id, Some(&cwd_str)).0.members[0].last_read_seq;
    assert_eq!(after_read_seq, before_read_seq);

    // Concurrent blocking execute_swarm_wait wakes on worker post without AB-BA deadlock.
    let coord_id_wait = coord_id.clone();
    let handle = std::thread::spawn(move || {
        execute_swarm_wait(&coord_id_wait, "coordinator", 2, true, 5_000)
    });
    std::thread::sleep(Duration::from_millis(40));
    execute_swarm_action(
        &SwarmCommand::Post {
            channel: None,
            text: "@coordinator [done] checked".into(),
        },
        &format!("thread:{worker_cid}"),
        Some(&cwd_str),
        None,
    )
    .unwrap();
    let wait_out = handle.join().unwrap().unwrap();
    assert!(wait_out.contains("[done] checked"), "wait_out={wait_out}");

    crate::chat::threads::remove_thread(&worker_cid);
}

#[test]
fn coordinator_auto_wake_fires_when_idle_skips_when_waiting_and_matches_blocked() {
    use crate::chat::subagents::SwarmBoardPost;
    use crate::chat::utils::now_ms;
    assert!(coordinator_matches_post(&SwarmBoardPost {
        seq: 1,
        author: "worker-a".into(),
        channel: "main".into(),
        text: "[blocked] waiting on migration decision".into(),
        mentions: vec![],
        created_at_unix_ms: 10,
    }));

    let coord_id = format!("swarm-coord-wake-{}", uuid::Uuid::new_v4().simple());
    let scratch = std::env::temp_dir().join(format!(
        "kite-swarm-coord-wake-{}",
        uuid::Uuid::new_v4().simple()
    ));
    fs::create_dir_all(&scratch).unwrap();
    let _guard = CleanupSwarmThread(coord_id.clone(), scratch.clone());

    let coord = blank_thread(&coord_id, None, "Main Coord", "antigravity", None);
    threads().lock().unwrap().push(coord);

    let coord_addr = format!("thread:{coord_id}");
    let cwd_str = scratch.to_string_lossy().to_string();
    let launches: std::sync::Arc<std::sync::Mutex<Vec<(String, String)>>> =
        std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let launches_ref = std::sync::Arc::clone(&launches);
    let launcher_fn = move |tid: &str, prompt: &str| -> Result<(), String> {
        launches_ref
            .lock()
            .unwrap()
            .push((tid.to_string(), prompt.to_string()));
        Ok(())
    };

    execute_swarm_action(
        &SwarmCommand::Add {
            name: "worker-a".into(),
            provider: Some("grok".into()),
            model: None,
            effort: None,
            workspace: Some("inherit".into()),
            channels: vec!["main".into()],
            fork: None,
            role: None,
            override_stack: false,
            brief: "Check module".into(),
        },
        &coord_addr,
        Some(&cwd_str),
        Some(&launcher_fn),
    )
    .unwrap();
    let worker_cid = load_swarm_state(&coord_id, Some(&cwd_str)).0.members[0]
        .child_thread_id
        .clone()
        .unwrap();

    // 1. Worker posts [blocked] while coordinator is idle and not waiting => auto-wake fires for coordinator.
    execute_swarm_action(
        &SwarmCommand::Post {
            channel: None,
            text: "[blocked] Need schema decision".into(),
        },
        &format!("thread:{worker_cid}"),
        Some(&cwd_str),
        Some(&launcher_fn),
    )
    .unwrap();
    {
        let calls = launches.lock().unwrap();
        assert_eq!(calls.len(), 2, "calls={calls:?}");
        assert_eq!(calls[1].0, coord_id);
        assert!(calls[1].1.contains("[blocked] Need schema decision"));
    }

    // 2. While coordinator has an active turn, post must NOT double-wake; settling worker later wakes once idle.
    let run_id = format!("run-busy-{}", uuid::Uuid::new_v4().simple());
    {
        use crate::chat::runtime::state::{live_turns, TurnRun};
        let mut live = live_turns().lock().unwrap();
        live.by_thread.insert(coord_id.clone(), run_id.clone());
        live.runs.insert(
            run_id.clone(),
            TurnRun {
                revision: "1".into(),
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
    execute_swarm_action(
        &SwarmCommand::Post {
            channel: None,
            text: "@coordinator intermediate update".into(),
        },
        &format!("thread:{worker_cid}"),
        Some(&cwd_str),
        Some(&launcher_fn),
    )
    .unwrap();
    assert_eq!(launches.lock().unwrap().len(), 2);

    // Clear coordinator live turn, then settle worker -> wakes idle coordinator for unread post.
    {
        use crate::chat::runtime::state::live_turns;
        let mut live = live_turns().lock().unwrap();
        live.by_thread.remove(&coord_id);
        live.runs.remove(&run_id);
    }
    on_worker_turn_settled_with_launcher(&worker_cid, true, Some(&launcher_fn));
    {
        let calls = launches.lock().unwrap();
        assert_eq!(calls.len(), 3, "calls={calls:?}");
        assert_eq!(calls[2].0, coord_id);
        assert!(calls[2].1.contains("intermediate update"));
    }

    // 3. While coordinator is actively in execute_swarm_wait, auto-wake must NOT launch a second turn.
    let waiter_coord = coord_id.clone();
    let head_seq = load_swarm_state(&coord_id, Some(&cwd_str))
        .0
        .last_coordinator_wake_seq;
    let handle = std::thread::spawn(move || {
        execute_swarm_wait(&waiter_coord, "coordinator", head_seq, true, 5_000)
    });
    std::thread::sleep(Duration::from_millis(50));
    execute_swarm_action(
        &SwarmCommand::Post {
            channel: None,
            text: "@coordinator [done] all fixed".into(),
        },
        &format!("thread:{worker_cid}"),
        Some(&cwd_str),
        Some(&launcher_fn),
    )
    .unwrap();
    let waited = handle.join().unwrap().unwrap();
    assert!(waited.contains("[done] all fixed"), "waited={waited}");
    assert_eq!(launches.lock().unwrap().len(), 3);

    // 4. Coordinator settles own turn while unread @coordinator posts exist -> auto-wake delivers them,
    // and launch failure rolls back last_coordinator_wake_seq.
    let before_fail_count = launches.lock().unwrap().len();
    execute_swarm_action(
        &SwarmCommand::Post {
            channel: None,
            text: "@coordinator follow-up while coord busy".into(),
        },
        &format!("thread:{worker_cid}"),
        Some(&cwd_str),
        Some(&|_tid: &str, _prompt: &str| Err("simulated launch error".to_string())),
    )
    .unwrap();
    let head_seq = load_swarm_state(&coord_id, Some(&cwd_str))
        .0
        .posts
        .last()
        .unwrap()
        .seq;
    assert!(
        load_swarm_state(&coord_id, Some(&cwd_str))
            .0
            .last_coordinator_wake_seq
            < head_seq,
        "failed launch must roll back wake cursor"
    );
    // Settling coordinator now drains unread @coordinator posts on coordinator thread.
    on_worker_turn_settled_with_launcher(&coord_id, true, Some(&launcher_fn));
    {
        let calls = launches.lock().unwrap();
        assert_eq!(calls.len(), before_fail_count + 1);
        assert!(calls.last().unwrap().1.contains("follow-up while coord busy"));
    }

    crate::chat::threads::remove_thread(&worker_cid);
}

#[test]
fn swarm_add_injects_role_body_and_model_switch_enforces_stack_policy() {
    use crate::subagent_settings::{OverridePolicy, SubagentSettings, SubagentStackEntry};

    let coord_id = format!("swarm-role-test-{}", uuid::Uuid::new_v4().simple());
    let scratch = std::env::temp_dir().join(format!(
        "kite-swarm-role-test-{}",
        uuid::Uuid::new_v4().simple()
    ));
    let agents_dir = scratch.join(".kite").join("agents");
    fs::create_dir_all(&agents_dir).unwrap();
    fs::write(
        agents_dir.join("edge-auditor.md"),
        "---\ncommand: grok\nprovider: grok\nmodel: grok-4.7-build-fast\neffort: low\nworkspace: inherit\n---\nVerify all boundary conditions strictly.",
    )
    .unwrap();
    let _guard = CleanupSwarmThread(coord_id.clone(), scratch.clone());

    let coord = blank_thread(&coord_id, None, "Main Coord", "antigravity", None);
    threads().lock().unwrap().push(coord);

    let coord_addr = format!("thread:{coord_id}");
    let cwd_str = scratch.to_string_lossy().to_string();
    let launches: std::sync::Arc<std::sync::Mutex<Vec<(String, String)>>> =
        std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let launches_ref = std::sync::Arc::clone(&launches);
    let launcher_fn = move |tid: &str, prompt: &str| -> Result<(), String> {
        launches_ref
            .lock()
            .unwrap()
            .push((tid.to_string(), prompt.to_string()));
        Ok(())
    };

    execute_swarm_action(
        &SwarmCommand::Add {
            name: "auditor".into(),
            provider: None,
            model: None,
            effort: None,
            workspace: None,
            channels: vec!["main".into()],
            fork: None,
            role: Some("edge-auditor".into()),
            override_stack: false,
            brief: "Check src/main.ts".into(),
        },
        &coord_addr,
        Some(&cwd_str),
        Some(&launcher_fn),
    )
    .unwrap();

    {
        let calls = launches.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert!(
            calls[0].1.contains("Verify all boundary conditions strictly."),
            "worker initial prompt must include role body: {}",
            calls[0].1
        );
        assert!(calls[0].1.contains("Check src/main.ts"));
    }

    // Set worker state to waiting so execute_swarm_model_with_settings can inspect stack rules.
    {
        let (mut st, path) = load_swarm_state(&coord_id, Some(&cwd_str));
        st.members[0].state = "waiting".to_string();
        save_and_broadcast_swarm(&coord_id, &path, &st);
    }

    let ask_settings = SubagentSettings {
        stack: vec![SubagentStackEntry {
            provider: "grok".into(),
            model: "grok-4.7-build-fast".into(),
            effort: Some("low".into()),
            enabled: true,
        }],
        default_delegation: None,
        override_policy: OverridePolicy::Ask,
    };

    assert!(execute_swarm_model_with_settings(
        &coord_id,
        Some(&cwd_str),
        Some(&launcher_fn),
        "auditor",
        Some("claude"),
        "claude-sonnet-4-6",
        None,
        false,
        &ask_settings,
    )
    .is_err());

    let strict_settings = SubagentSettings {
        override_policy: OverridePolicy::Strict,
        ..ask_settings.clone()
    };
    assert!(execute_swarm_model_with_settings(
        &coord_id,
        Some(&cwd_str),
        Some(&launcher_fn),
        "auditor",
        Some("claude"),
        "claude-sonnet-4-6",
        None,
        true,
        &strict_settings,
    )
    .is_err());

    assert!(execute_swarm_model_with_settings(
        &coord_id,
        Some(&cwd_str),
        Some(&launcher_fn),
        "auditor",
        Some("claude"),
        "claude-sonnet-4-6",
        None,
        true,
        &ask_settings,
    )
    .is_ok());

    let worker_cid = load_swarm_state(&coord_id, Some(&cwd_str)).0.members[0]
        .child_thread_id
        .clone()
        .unwrap();
    crate::chat::threads::remove_thread(&worker_cid);
}
