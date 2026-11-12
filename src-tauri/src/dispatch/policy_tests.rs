use super::*;
use crate::dispatch::port::FakePort;

fn service() -> Service<FakePort> {
    Service::new(FakePort::default())
}

fn send_to(address: &str, id: &str, body: &str, caller: Caller) -> SendInput {
    SendInput {
        id: id.into(),
        address: address.into(),
        body: body.into(),
        caller,
        force: false,
        allow_queue: true,
        only_ready: false,
        wrap: None,
        from: "alias:source".into(),
        mounted: false,
        source: None,
        label: None,
        now_ms: 1_000,
        profile_id: None,
        system: false,
        presentation_emitted: false,
    }
}

#[test]
fn alias_uniqueness_release_and_agent_resolution() {
    let mut svc = service();
    svc.attach(Family::Terminal, "s1", Some("review"), None, false)
        .unwrap();
    let err = svc
        .attach(Family::Terminal, "s2", Some("review"), None, false)
        .unwrap_err();
    assert_eq!(err, DispatchError::NameTaken);
    svc.stop("review").unwrap();
    svc.attach(Family::Terminal, "s3", Some("review"), None, false)
        .unwrap();

    let missing = svc.send(send_to("agent:p1", "a1", "hi", Caller::Human));
    assert_eq!(missing.error.as_deref(), Some("no_live_endpoint"));
    assert_eq!(svc.port_mut().pty_writes(), 0);
    svc.attach(Family::Thread, "t1", None, None, false).unwrap();
    svc.bind_agent("p1", "t1").unwrap();
    svc.publish_pane("thread:t1", "idle", 1, 1_000, None, None)
        .unwrap();
    let ok = svc.send(send_to("agent:p1", "a2", "hi", Caller::Human));
    assert_eq!(ok.status, ReceiptStatus::Submitted);
    assert_eq!(svc.port_mut().pty_writes(), 1);
}

#[test]
fn repeated_id_writes_once() {
    let mut svc = service();
    svc.attach(Family::Terminal, "s1", Some("review"), None, false)
        .unwrap();
    svc.publish_pane("review", "idle", 1, 1_000, None, None).unwrap();
    let first = svc.send(send_to("review", "same", "once", Caller::Human));
    let second = svc.send(send_to("review", "same", "once", Caller::Human));
    assert_eq!(first.status, second.status);
    assert!(second.replayed);
    assert!(!first.replayed);
    assert_eq!(svc.port_mut().pty_writes(), 1);
}

#[test]
fn blocked_permission_and_timeout_write_nothing() {
    let mut svc = service();
    svc.attach(Family::Terminal, "s1", Some("review"), None, false)
        .unwrap();
    svc.publish_reported("review", PresenceState::Blocked, Some(BlockKind::Permission), 2, 1_000)
        .unwrap();
    let mut forced = send_to("review", "b1", "approve", Caller::Human);
    forced.force = true;
    let blocked = svc.send(forced);
    assert_eq!(blocked.error.as_deref(), Some("destination_blocked"));
    assert_eq!(svc.port_mut().pty_writes(), 0);

    let mut agent_force = send_to("review", "b2", "approve", Caller::Agent);
    agent_force.force = true;
    let forbidden = svc.send(agent_force);
    assert_eq!(forbidden.error.as_deref(), Some("force_forbidden"));

    let wait = svc.wait(WaitInput {
        id: "w1".into(),
        address: Some("review".into()),
        until: vec![PresenceState::Idle],
        children: None,
        timeout_ms: 0,
        started_ms: 1_000,
        now_ms: 1_000,
    });
    assert_eq!(wait.error.as_deref(), Some("timeout"));
    assert!(!wait.submitted);
    assert_eq!(svc.port_mut().pty_writes(), 0);
}

#[test]
fn stall_is_submitted_and_does_not_write_again() {
    let mut svc = service();
    svc.attach(Family::Terminal, "s1", Some("review"), None, false)
        .unwrap();
    svc.publish_pane("review", "idle", 1, 1_000, None, None).unwrap();
    let sent = svc.send(send_to("review", "st", "body", Caller::Human));
    assert!(sent.submitted);
    let stalled = svc.settle("st", 1_000 + STALL_MS).unwrap();
    assert_eq!(stalled.status, ReceiptStatus::Stalled);
    assert!(stalled.submitted);
    assert_eq!(svc.port_mut().pty_writes(), 1);
    let replay = svc.send(send_to("review", "st", "body", Caller::Human));
    assert_eq!(replay.status, ReceiptStatus::Stalled);
    assert_eq!(svc.port_mut().pty_writes(), 1);
}

#[test]
fn queue_full_keeps_the_tail_and_unknown_is_queued() {
    let mut svc = service();
    svc.attach(Family::Terminal, "s1", Some("review"), None, false)
        .unwrap();
    svc.publish_pane("review", "working", 1, 1_000, None, None)
        .unwrap();
    for n in 0..QUEUE_DEPTH {
        let receipt = svc.send(send_to("review", &format!("q{n}"), "x", Caller::Human));
        assert_eq!(receipt.status, ReceiptStatus::Queued);
    }
    let full = svc.send(send_to("review", "overflow", "x", Caller::Human));
    assert_eq!(full.error.as_deref(), Some("queue_full"));
    let queued = svc.endpoints.get("session:s1").unwrap().queue.len();
    assert_eq!(queued, QUEUE_DEPTH);
    assert!(svc
        .endpoints
        .get("session:s1")
        .unwrap()
        .queue
        .iter()
        .all(|item| item.id != "overflow"));
    assert_eq!(svc.port_mut().pty_writes(), 0);

    svc.publish_pane("review", "done", 2, 2_000, None, None).unwrap();
    assert_eq!(svc.port_mut().pty_writes(), 1);
}

#[test]
fn mounted_submit_does_not_count_as_a_pty_write() {
    let mut svc = service();
    svc.attach(Family::Terminal, "s1", Some("review"), None, false)
        .unwrap();
    svc.publish_pane("review", "idle", 1, 1_000, None, None).unwrap();
    let mut input = send_to("review", "m1", "fly", Caller::Human);
    input.mounted = true;
    let receipt = svc.send(input);
    assert!(receipt.submitted);
    assert_eq!(svc.port_mut().pty_writes(), 0);
    assert_eq!(svc.port_mut().writes.len(), 1);
}

#[test]
fn child_notice_outlive_and_dead_parent() {
    let mut svc = service();
    svc.attach(Family::Terminal, "parent", Some("lead"), None, false)
        .unwrap();
    svc.publish_pane("lead", "idle", 1, 1_000, None, None).unwrap();
    svc.attach(Family::Terminal, "child", Some("helper"), Some("lead"), false)
        .unwrap();
    svc.attach(Family::Terminal, "kept", Some("keeper"), Some("lead"), true)
        .unwrap();
    svc.publish_pane("helper", "working", 1, 1_000, None, None)
        .unwrap();
    svc.publish_pane("helper", "exited", 2, 2_000, Some("last line"), Some("exit 1"))
        .unwrap();
    let notices = svc
        .port_mut()
        .writes
        .iter()
        .filter(|w| w.text.contains("state: gone"))
        .count();
    assert_eq!(notices, 1);
    assert!(svc.port_mut().writes[0].text.contains("This is another agent, not the person."));
    assert!(!svc.port_mut().writes[0].text.contains("callee transcript"));

    svc.publish_pane("helper", "exited", 3, 3_000, None, None).unwrap();
    let notices = svc
        .port_mut()
        .writes
        .iter()
        .filter(|w| w.text.contains("state: gone"))
        .count();
    assert_eq!(notices, 1);

    let missing = svc.report(
        "r-dead",
        Some("keeper"),
        Some("alias:ghost"),
        "done",
        Caller::Agent,
        4_000,
    );
    assert_eq!(missing.error.as_deref(), Some("parent_missing"));
    assert_eq!(svc.port_mut().pty_writes(), notices);

    svc.stop("lead").unwrap();
    let stopped: Vec<&str> = svc.port_mut().stops.iter().map(|(_, id)| id.as_str()).collect();
    assert!(stopped.contains(&"child"));
    assert!(!stopped.contains(&"kept"));
}

#[test]
fn role_starts_one_command_and_one_first_send_after_idle() {
    let mut svc = service();
    let dir = std::env::temp_dir().join(format!("kite-dispatch-run-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let missing = svc.run_role(
        "missing",
        &dir,
        "reviewer",
        None,
        None,
        Caller::Human,
        1_000,
        None,
        false,
        false,
        None,
    );
    assert_eq!(missing.error.as_deref(), Some("role_not_found"));
    assert!(svc.port_mut().starts.is_empty());

    crate::dispatch::role::ensure_sample_role(&dir).unwrap();
    let started = svc.run_role(
        "run-1",
        &dir,
        "reviewer",
        Some("Task body".into()),
        None,
        Caller::Human,
        1_000,
        None,
        false,
        false,
        None,
    );
    assert_eq!(started.status, ReceiptStatus::Submitted);
    assert_eq!(svc.port_mut().starts.len(), 1);
    assert_eq!(svc.port_mut().starts[0].engine, "codex");
    let prompt = svc.port_mut().starts[0].prompt.clone().unwrap_or_default();
    assert!(prompt.contains("Task body"));
    assert!(!prompt.contains("This text is the complete manual."));
    assert!(!prompt.contains("kite dispatch kill"));
    assert!(!prompt.contains("KITE_SKILL_FILE"));
    assert!(!prompt.contains("kite dispatch run <role>"));
    assert!(!svc.port_mut().starts[0].manual_as_system);
    assert_eq!(svc.port_mut().pty_writes(), 0);
    svc.publish_pane("reviewer", "idle", 1, 2_000, None, None)
        .unwrap();
    assert_eq!(svc.port_mut().pty_writes(), 0);
    assert!(svc.port_mut().writes.is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn engine_run_queues_one_task_and_lists_the_engine() {
    let mut svc = service();
    let started = svc.run(RunInput {
        id: "run-task".into(),
        via: Family::Terminal,
        engine: Some("codex".into()),
        command: None,
        name: Some("helper".into()),
        parent: None,
        outlive: false,
        role: None,
        role_missing: false,
        task: Some("Look at the tests".into()),
        caller: Caller::Agent,
        cwd: None,
        now_ms: 1_000,
        hidden: false,
        argv: Vec::new(),
    });
    assert_eq!(started.status, ReceiptStatus::Submitted);
    let prompt = svc.port_mut().starts[0].prompt.clone().unwrap_or_default();
    assert!(prompt.contains("Look at the tests"));
    assert!(!prompt.contains("This text is the complete manual."));
    assert!(!prompt.contains("kite dispatch kill"));
    assert!(!prompt.contains("KITE_SKILL_FILE"));
    assert!(!prompt.contains("kite dispatch run <role>"));
    assert!(!svc.port_mut().starts[0].manual_as_system);
    assert_eq!(svc.port_mut().pty_writes(), 0);
    svc.publish_pane("helper", "idle", 1, 2_000, None, None).unwrap();
    assert_eq!(svc.port_mut().pty_writes(), 0);
    assert!(svc.port_mut().writes.is_empty());
    let row = svc.ls().into_iter().next().unwrap_or_default();
    assert!(row.contains("alias:helper"));
    assert!(row.contains("codex"));
    assert!(row.contains("idle"));

    let grok = svc.run(RunInput {
        id: "run-grok".into(),
        via: Family::Terminal,
        engine: Some("grok".into()),
        command: None,
        name: Some("grok".into()),
        parent: None,
        outlive: false,
        role: None,
        role_missing: false,
        task: Some("Look at the login bug".into()),
        caller: Caller::Agent,
        cwd: None,
        now_ms: 3_000,
        hidden: true,
        argv: Vec::new(),
    });
    assert_eq!(grok.status, ReceiptStatus::Submitted);
    assert_eq!(grok.pane, Some(crate::dispatch::types::PaneVisibility::Hidden));
    let start = &svc.port_mut().starts[1];
    assert_eq!(start.engine, "grok");
    assert!(start.manual_as_system);
    assert_eq!(start.prompt.as_deref(), Some("Look at the login bug"));
    assert!(!start.prompt.as_deref().unwrap_or("").contains("KITE_SKILL_FILE"));
    svc.publish_pane("grok", "idle", 2, 4_000, None, None).unwrap();
    assert_eq!(svc.port_mut().pty_writes(), 0);
    assert!(svc.port_mut().writes.is_empty());
}

#[test]
fn read_prefers_live_text_over_a_published_tail() {
    let mut svc = service();
    svc.attach(Family::Terminal, "s1", Some("review"), None, false)
        .unwrap();
    svc.publish_pane("review", "idle", 1, 1_000, Some("old tail"), None)
        .unwrap();
    svc.port_mut()
        .buffers
        .push(((Family::Terminal, "s1".into()), "live line".into()));
    let receipt = svc.read("rd-live", "review", 80);
    assert_eq!(receipt.text.as_deref(), Some("live line"));
    assert_eq!(svc.port_mut().pty_writes(), 0);
}

#[test]
fn read_does_not_clear_done() {
    let mut svc = service();
    svc.attach(Family::Terminal, "s1", Some("review"), None, false)
        .unwrap();
    svc.publish_pane("review", "done", 1, 1_000, None, None).unwrap();
    svc.port_mut()
        .buffers
        .push(((Family::Terminal, "s1".into()), "one\ntwo\nthree".into()));
    let receipt = svc.read("rd", "review", 2);
    assert_eq!(receipt.text.as_deref(), Some("two\nthree"));
    assert_eq!(svc.effective("session:s1").state, PresenceState::Done);
    assert_eq!(svc.port_mut().pty_writes(), 0);
}

#[test]
fn osc_clear_restores_observed_and_stale_report_is_ignored() {
    let mut svc = service();
    svc.attach(Family::Terminal, "s1", Some("review"), None, false)
        .unwrap();
    svc.publish_pane("review", "idle", 1, 1_000, None, None).unwrap();
    assert!(svc
        .publish_osc("review", "state=working:seq=5", 1_100)
        .unwrap());
    assert_eq!(svc.effective("session:s1").state, PresenceState::Working);
    assert!(!svc.publish_osc("review", "state=done:seq=4", 1_200).unwrap());
    assert_eq!(svc.effective("session:s1").state, PresenceState::Working);
    assert!(svc.publish_osc("review", "state=clear:seq=6", 1_300).unwrap());
    assert_eq!(svc.effective("session:s1").state, PresenceState::Idle);
    assert!(!svc.publish_osc("review", "state=working:broken", 1_400).unwrap());
    assert_eq!(svc.effective("session:s1").state, PresenceState::Idle);
}

#[test]
fn offline_and_messaging_do_not_write() {
    let mut svc = service();
    svc.attach(Family::Terminal, "s1", Some("review"), None, false)
        .unwrap();
    svc.publish_pane("review", "idle", 1, 1_000, None, None).unwrap();
    svc.set_online(false);
    let off = svc.send(send_to("review", "off", "x", Caller::Agent));
    assert_eq!(off.error.as_deref(), Some("runtime_offline"));
    svc.set_online(true);
    svc.set_messaging(false, false);
    let denied = svc.send(send_to("review", "msg", "x", Caller::Agent));
    assert_eq!(denied.error.as_deref(), Some("messaging_disabled"));
    let human = svc.send(send_to("review", "human", "x", Caller::Human));
    assert_eq!(human.status, ReceiptStatus::Submitted);
    svc.set_messaging(true, true);
    let readonly = svc.send(send_to("review", "ro", "x", Caller::Script));
    assert_eq!(readonly.error.as_deref(), Some("messaging_disabled"));
    assert_eq!(svc.port_mut().pty_writes(), 1);
}

#[test]
fn parent_hears_blocked_then_gone_once_each() {
    let mut svc = service();
    svc.attach(Family::Terminal, "parent", Some("lead"), None, false)
        .unwrap();
    svc.publish_pane("lead", "idle", 1, 1_000, None, None).unwrap();
    svc.attach(Family::Terminal, "child", Some("helper"), Some("lead"), false)
        .unwrap();
    svc.publish_pane("helper", "waitingForYou", 1, 1_100, None, None)
        .unwrap();
    let blocked = svc
        .port_mut()
        .writes
        .iter()
        .filter(|w| w.text.contains("state: blocked"))
        .count();
    assert_eq!(blocked, 1);
    svc.publish_pane("lead", "idle", 2, 1_150, None, None).unwrap();

    svc.publish_pane("helper", "working", 2, 1_200, None, None)
        .unwrap();
    svc.publish_pane("helper", "waitingForYou", 3, 1_300, None, None)
        .unwrap();
    svc.publish_pane("lead", "idle", 3, 1_350, None, None).unwrap();
    svc.publish_pane("helper", "exited", 4, 1_400, Some("last line"), Some("exit 1"))
        .unwrap();
    svc.publish_pane("helper", "exited", 5, 1_500, None, None)
        .unwrap();
    let blocked = svc
        .port_mut()
        .writes
        .iter()
        .filter(|w| w.text.contains("state: blocked"))
        .count();
    let gone = svc
        .port_mut()
        .writes
        .iter()
        .filter(|w| w.text.contains("state: gone"))
        .count();
    assert_eq!(blocked, 2);
    assert_eq!(gone, 1);
}

#[test]
fn a_report_since_working_suppresses_the_parent_notice() {
    let mut svc = service();
    svc.attach(Family::Terminal, "parent", Some("lead"), None, false)
        .unwrap();
    svc.publish_pane("lead", "idle", 1, 1_000, None, None).unwrap();
    svc.attach(Family::Terminal, "child", Some("helper"), Some("lead"), false)
        .unwrap();
    svc.publish_pane("helper", "working", 1, 1_100, None, None)
        .unwrap();
    let reported = svc.report(
        "rep",
        Some("helper"),
        None,
        "Findings are in.",
        Caller::Agent,
        1_200,
    );
    assert_eq!(reported.status, ReceiptStatus::Submitted);
    svc.publish_pane("helper", "waitingForYou", 2, 1_300, None, None)
        .unwrap();
    svc.publish_pane("helper", "exited", 3, 1_400, None, None)
        .unwrap();
    assert!(svc
        .port_mut()
        .writes
        .iter()
        .all(|w| !w.text.contains("state: blocked") && !w.text.contains("state: gone")));
}

#[test]
fn a_report_blocks_send_until_the_session_is_killed() {
    let mut svc = service();
    svc.attach(Family::Terminal, "s1", Some("review"), None, false)
        .unwrap();
    assert!(svc
        .publish_osc("review", "state=blocked:seq=2", 1_000)
        .unwrap());
    svc.publish_pane("review", "idle", 1_700_000_000_000, 1_100, None, None)
        .unwrap();
    let blocked = svc.send(send_to("review", "blocked-send", "hi", Caller::Agent));
    assert_eq!(blocked.error.as_deref(), Some("destination_blocked"));
    assert_eq!(svc.port_mut().pty_writes(), 0);

    let killed = svc.kill("kill-review", "review");
    assert_eq!(killed.status, ReceiptStatus::Settled);
    assert_eq!(killed.presence_at_submit.as_deref(), Some("gone"));
    assert!(svc.ls().is_empty());
    assert!(svc.port_mut().stops.iter().any(|(_, id)| id == "s1"));
}

#[test]
fn kill_stops_a_session_the_service_has_not_attached() {
    let mut svc = service();
    let killed = svc.kill("kill-raw", "session:missing-pane");
    assert_eq!(killed.status, ReceiptStatus::Settled);
    assert!(svc
        .port_mut()
        .stops
        .iter()
        .any(|(family, id)| *family == Family::Terminal && id == "missing-pane"));
}

#[test]
fn interrupt_writes_ctrl_c_while_blocked_and_keys_do_not_add_enter() {
    let mut svc = service();
    svc.attach(Family::Terminal, "s1", Some("review"), None, false)
        .unwrap();
    svc.publish_osc("review", "state=working:seq=3", 1_000)
        .unwrap();
    let interrupted = svc.interrupt("int-1", "review");
    assert_eq!(interrupted.status, ReceiptStatus::Submitted);
    assert_eq!(svc.port_mut().writes.len(), 1);
    assert_eq!(svc.port_mut().writes[0].text, "\u{3}");
    assert!(svc.port_mut().writes[0].pty);
    assert!(!svc.port_mut().writes[0].presentation);

    let typed = svc.keys("keys-1", "review", &["up".into(), "enter".into()]);
    assert_eq!(typed.status, ReceiptStatus::Submitted);
    assert_eq!(svc.port_mut().writes[1].text, "\u{1b}[A\r");

    let rejected = svc.keys("keys-bad", "review", &["not-a-key".into()]);
    assert_eq!(rejected.error.as_deref(), Some("bad_args"));
    assert_eq!(svc.port_mut().writes.len(), 2);
}

#[test]
fn attach_reveals_the_session_and_raw_argv_is_not_a_prompt() {
    let mut svc = service();
    svc.attach(Family::Terminal, "s1", Some("review"), None, false)
        .unwrap();
    if let Some(ep) = svc.endpoints.get_mut("session:s1") {
        ep.engine = Some("codex".into());
    }
    let shown = svc.show("show-1", "review");
    assert_eq!(shown.status, ReceiptStatus::Settled);
    assert_eq!(
        svc.port_mut().reveals,
        vec![("s1".into(), "codex".into(), Some("review".into()))]
    );

    let started = svc.run(RunInput {
        id: "raw-1".into(),
        via: Family::Terminal,
        engine: Some("cargo".into()),
        command: Some("cargo".into()),
        name: None,
        parent: None,
        outlive: false,
        role: None,
        role_missing: false,
        task: Some("do not type this".into()),
        caller: Caller::Agent,
        cwd: None,
        now_ms: 10,
        hidden: true,
        argv: vec!["cargo".into(), "test".into()],
    });
    assert_eq!(started.status, ReceiptStatus::Submitted);
    let start = &svc.port_mut().starts[0];
    assert_eq!(start.argv, vec!["cargo".to_string(), "test".to_string()]);
    assert!(start.prompt.is_none());
}

#[test]
fn default_engine_runs_receive_canonical_codenames_and_clean_notice_tails() {
    let mut svc = service();
    // Parent claims Orion (even with Title Case)
    svc.attach(Family::Terminal, "parent", Some("Orion"), None, false)
        .unwrap();
    svc.publish_pane("Orion", "idle", 1, 1_000, None, None)
        .unwrap();

    let first = svc.run(RunInput {
        id: "del-1".into(),
        via: Family::Terminal,
        engine: Some("antigravity".into()),
        command: None,
        name: Some("antigravity".into()),
        parent: Some("alias:Orion".into()),
        outlive: false,
        role: None,
        role_missing: false,
        task: Some("Audit repo".into()),
        caller: Caller::Agent,
        cwd: None,
        now_ms: 1_100,
        hidden: false,
        argv: Vec::new(),
    });
    assert_eq!(first.status, ReceiptStatus::Submitted);
    assert_eq!(svc.port_mut().starts[0].name.as_deref(), Some("nova"));

    let second = svc.run(RunInput {
        id: "del-2".into(),
        via: Family::Terminal,
        engine: Some("antigravity".into()),
        command: None,
        name: Some("antigravity".into()),
        parent: Some("Orion".into()),
        outlive: false,
        role: None,
        role_missing: false,
        task: Some("Audit tests".into()),
        caller: Caller::Agent,
        cwd: None,
        now_ms: 1_200,
        hidden: false,
        argv: Vec::new(),
    });
    assert_eq!(second.status, ReceiptStatus::Submitted);
    assert_eq!(svc.port_mut().starts[1].name.as_deref(), Some("atlas"));

    let ls = svc.ls();
    assert!(ls.iter().any(|row| row.contains("alias:orion")));
    assert!(ls.iter().any(|row| row.contains("alias:nova antigravity")));
    assert!(ls.iter().any(|row| row.contains("alias:atlas antigravity")));

    let pasted = format_terminal_paste("line 1\r\nline 2\n");
    assert_eq!(pasted, "\u{1b}[200~line 1\nline 2\u{1b}[201~");
    let tail = clean_notice_tail("⢿  Running...\n⣻  Running...\nSummary complete\n\n", 20);
    assert_eq!(tail, "Summary complete");
}
