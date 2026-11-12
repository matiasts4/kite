use super::*;
use crate::dispatch::port::FakePort;

fn owned(args: &[&str]) -> Vec<String> {
    args.iter().map(|s| (*s).to_string()).collect()
}

#[test]
fn skill_mentions_the_gate_the_envelope_and_force() {
    let text = skill_text();
    assert!(text.contains("KITE_DISPATCH=1"));
    assert!(text.contains("This is another agent, not the person."));
    assert!(text.contains("force_forbidden"));
    assert!(text.contains("kind permission"));
    assert!(text.contains("kite dispatch run <program>"));
    assert!(!text.contains("kite dispatch run <role>"));
    assert!(text.contains("name: kite-dispatch"));
    assert!(text.contains("This text is the complete manual."));
    assert!(text.contains("Do not search the repository"));
    assert!(!text.contains("KITE_SKILL_FILE"));
    assert!(text.contains("--hidden"));
    assert!(text.contains("Inbox files do not open panes"));
    assert!(text.contains("An agent does not get a pane unless --pane"));
    assert!(text.contains(&super::super::programs::lines()));

    let manual = manual_text();
    assert!(manual.starts_with("Kite Dispatch\n"));
    assert!(!manual.contains("name: kite-dispatch"));
    assert_eq!(strip_skill_frontmatter(text), manual);
}

#[test]
fn copy_skill_writes_only_into_existing_roots() {
    let home = std::env::temp_dir().join(format!(
        "kite-skill-home-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let grok = home.join(".grok").join("skills");
    let opencode = home.join(".config").join("opencode").join("skills");
    std::fs::create_dir_all(&grok).unwrap();
    std::fs::create_dir_all(&opencode).unwrap();
    copy_skill_into_existing_roots(&home, "SKILL BODY");
    let written = grok.join("kite-dispatch").join("SKILL.md");
    let written_opencode = opencode.join("kite-dispatch").join("SKILL.md");
    assert_eq!(std::fs::read_to_string(&written).unwrap(), "SKILL BODY");
    assert_eq!(
        std::fs::read_to_string(&written_opencode).unwrap(),
        "SKILL BODY"
    );
    assert!(!home.join(".claude").join("skills").exists());
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn one_line_run_takes_a_program_and_a_task() {
    let parsed = parse_args(&owned(&[
        "kite",
        "dispatch",
        "run",
        "review",
        "Revisa src/x.rs",
    ]))
    .unwrap();
    match parsed {
        Command::Run {
            role,
            explicit_role,
            name,
            task,
            hidden,
            pane,
            engine,
            file,
            program,
            ..
        } => {
            assert!(role.is_none());
            assert!(!explicit_role);
            assert_eq!(program.as_deref(), Some("review"));
            assert_eq!(name.as_deref(), Some("review"));
            assert_eq!(task.as_deref(), Some("Revisa src/x.rs"));
            assert!(!hidden);
            assert!(!pane);
            assert!(engine.is_none());
            assert!(file.is_none());
        }
        _ => panic!("expected run"),
    }

    let flagged = parse_args(&owned(&[
        "dispatch",
        "run",
        "--hidden",
        "--engine",
        "codex",
        "look here",
    ]))
    .unwrap();
    match flagged {
        Command::Run {
            role,
            explicit_role,
            engine,
            task,
            hidden,
            program,
            pane,
            ..
        } => {
            assert!(role.is_none());
            assert!(!explicit_role);
            assert!(program.is_none());
            assert_eq!(engine.as_deref(), Some("codex"));
            assert_eq!(task.as_deref(), Some("look here"));
            assert!(hidden);
            assert!(!pane);
        }
        _ => panic!("expected flagged run"),
    }

    let named = parse_args(&owned(&[
        "dispatch", "run", "--name", "helper", "review", "task text",
    ]))
    .unwrap();
    match named {
        Command::Run {
            role,
            program,
            name,
            task,
            ..
        } => {
            assert!(role.is_none());
            assert_eq!(program.as_deref(), Some("review"));
            assert_eq!(name.as_deref(), Some("helper"));
            assert_eq!(task.as_deref(), Some("task text"));
        }
        _ => panic!("expected named run"),
    }
}

#[test]
fn bad_args_exit_2_and_bad_token_writes_nothing() {
    assert!(parse_args(&owned(&["kite", "dispatch"])).is_err());
    assert!(parse_args(&owned(&["dispatch", "send"])).is_err());
    let parsed = parse_args(&owned(&["dispatch", "send", "review", "hello"])).unwrap();
    assert!(matches!(parsed, Command::Send { force: false, .. }));

    assert!(!check_token("secret", "nope"));
    assert!(check_token("secret", "secret"));
    let mut spawned = 0;
    let (code, receipt) = client_when_unreachable(&mut spawned);
    assert_eq!(code, 1);
    assert_eq!(receipt.error.as_deref(), Some("runtime_offline"));
    assert_eq!(spawned, 0);
    let bad = bad_token_receipt("1", "send");
    assert_eq!(bad.error.as_deref(), Some("bad_token"));
    assert!(!bad.submitted);

    let mut service = Service::new(FakePort::default());
    let rejected = execute(
        &mut service,
        &Command::Send {
            address: "review".into(),
            body: Some("hi".into()),
            file: None,
            force: true,
            only_ready: false,
            allow_queue: true,
        },
        &ExecContext {
            id: "c1",
            caller: Caller::Agent,
            from: "alias:other",
            now_ms: 10,
            config_dir: None,
            workspace: None,
            mounted: false,
        },
    )
    .unwrap();
    assert_eq!(rejected.error.as_deref(), Some("unknown_address"));
    assert_eq!(service.port_mut().pty_writes(), 0);
}

#[test]
fn run_inherits_a_session_parent_and_ignores_the_word_human() {
    let mut service = Service::new(FakePort::default());
    service
        .attach(Family::Terminal, "parent-1", Some("lead"), None, false)
        .unwrap();
    let started = execute(
        &mut service,
        &Command::Run {
            via: Family::Terminal,
            explicit_via: true,
            engine: Some("codex".into()),
            provider: None,
            model: None,
            effort: None,
            workspace: None,
            name: Some("helper".into()),
            explicit_name: true,
            parent: None,
            outlive: false,
            role: None,
            explicit_role: false,
            file: None,
            task: None,
            wait: false,
            timeout_ms: None,
            hidden: false,
            pane: false,
            program: None,
            words: Vec::new(),
        },
        &ExecContext {
            id: "run-parent",
            caller: Caller::Agent,
            from: "session:parent-1",
            now_ms: 10,
            config_dir: None,
            workspace: None,
            mounted: false,
        },
    )
    .unwrap();
    assert_eq!(started.status, ReceiptStatus::Submitted);
    service.stop("lead").unwrap();
    assert!(service
        .port_mut()
        .stops
        .iter()
        .any(|(_, id)| id == "term-1"));

    let mut plain = Service::new(FakePort::default());
    let human = execute(
        &mut plain,
        &Command::Run {
            via: Family::Terminal,
            explicit_via: true,
            engine: Some("codex".into()),
            provider: None,
            model: None,
            effort: None,
            workspace: None,
            name: Some("solo".into()),
            explicit_name: true,
            parent: None,
            outlive: false,
            role: None,
            explicit_role: false,
            file: None,
            task: None,
            wait: false,
            timeout_ms: None,
            hidden: false,
            pane: false,
            program: None,
            words: Vec::new(),
        },
        &ExecContext {
            id: "run-human",
            caller: Caller::Human,
            from: "human",
            now_ms: 10,
            config_dir: None,
            workspace: None,
            mounted: false,
        },
    )
    .unwrap();
    assert_eq!(human.status, ReceiptStatus::Submitted);
    assert!(human.error.is_none());
}

#[test]
fn one_line_run_puts_the_task_on_the_start_prompt() {
    use crate::dispatch::role::ensure_sample_role;
    use crate::dispatch::types::PaneVisibility;

    let dir = std::env::temp_dir().join(format!("kite-dispatch-oneline-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    ensure_sample_role(&dir).unwrap();
    let command = parse_args(&owned(&[
        "kite",
        "dispatch",
        "run",
        "review",
        "Revisa src/x.rs",
    ]))
    .unwrap();
    let mut service = Service::new(FakePort::default());
    let started = execute(
        &mut service,
        &command,
        &ExecContext {
            id: "one-line",
            caller: Caller::Agent,
            from: "agent",
            now_ms: 10,
            config_dir: Some(&dir),
            workspace: None,
            mounted: false,
        },
    )
    .unwrap();
    assert_eq!(started.status, ReceiptStatus::Submitted);
    assert_eq!(started.pane, Some(PaneVisibility::Hidden));
    assert_eq!(service.port_mut().starts[0].engine, "codex");
    assert!(!service.port_mut().starts[0].manual_as_system);
    let prompt = service.port_mut().starts[0].prompt.clone().unwrap_or_default();
    assert!(prompt.contains("Review the task."));
    assert!(prompt.contains("Revisa src/x.rs"));
    assert!(!prompt.contains("This text is the complete manual."));
    assert!(!prompt.contains("kite dispatch kill"));
    assert!(!prompt.contains("KITE_SKILL_FILE"));
    assert!(!prompt.contains("kite dispatch run <role>"));
    assert_eq!(service.port_mut().pty_writes(), 0);
    let _ = std::fs::remove_dir_all(&dir);
}

fn exec_run<'a>(
    service: &mut Service<FakePort>,
    command: &Command,
    id: &'a str,
    caller: Caller,
    config_dir: Option<&'a std::path::Path>,
) -> Receipt {
    execute(
        service,
        command,
        &ExecContext {
            id,
            caller,
            from: "agent",
            now_ms: 10,
            config_dir,
            workspace: None,
            mounted: false,
        },
    )
    .unwrap()
}

#[test]
fn run_grok_starts_without_a_role_file() {
    use crate::dispatch::types::PaneVisibility;

    let command = parse_args(&owned(&[
        "kite",
        "dispatch",
        "run",
        "grok",
        "Look at the login bug",
    ]))
    .unwrap();
    let mut service = Service::new(FakePort::default());
    let started = exec_run(&mut service, &command, "grok-run", Caller::Agent, None);
    assert_eq!(started.status, ReceiptStatus::Submitted);
    assert_eq!(started.pane, Some(PaneVisibility::Hidden));
    let start = &service.port_mut().starts[0];
    assert_eq!(start.engine, "grok");
    assert!(start.manual_as_system);
    assert_eq!(start.prompt.as_deref(), Some("Look at the login bug"));
    assert!(!start.prompt.as_deref().unwrap_or("").contains("KITE_SKILL_FILE"));
    service
        .publish_pane("grok", "idle", 1, 20, None, None)
        .unwrap();
    assert_eq!(service.port_mut().pty_writes(), 0);
    assert!(service.port_mut().writes.is_empty());
}

#[test]
fn unknown_word_starts_that_program_without_a_prompt() {
    let command = parse_args(&owned(&["dispatch", "run", "cargo", "test"])).unwrap();
    let mut service = Service::new(FakePort::default());
    let started = exec_run(&mut service, &command, "cargo-test", Caller::Agent, None);
    assert_eq!(started.status, ReceiptStatus::Submitted);
    let start = &service.port_mut().starts[0];
    assert_eq!(start.argv, vec!["cargo".to_string(), "test".to_string()]);
    assert!(start.prompt.is_none());

    let review = parse_args(&owned(&["dispatch", "run", "review", "task"])).unwrap();
    let mut plain = Service::new(FakePort::default());
    let started = exec_run(&mut plain, &review, "review-no-dir", Caller::Human, None);
    assert_eq!(started.status, ReceiptStatus::Submitted);
    let start = &plain.port_mut().starts[0];
    assert_eq!(start.argv, vec!["review".to_string(), "task".to_string()]);
    assert!(start.prompt.is_none());
}

#[test]
fn wait_defaults_to_thirty_seconds_and_control_commands_parse() {
    assert_eq!(
        blocking_wait_ms(&owned(&["dispatch", "wait", "review"])),
        Some(30_000)
    );
    assert_eq!(
        blocking_wait_ms(&owned(&["dispatch", "wait", "review", "--timeout", "1500"])),
        Some(1_500)
    );
    assert!(blocking_wait_ms(&owned(&["dispatch", "ls"])).is_none());
    let keys = parse_args(&owned(&["dispatch", "keys", "review", "up", "enter"])).unwrap();
    match keys {
        Command::Keys { address, keys } => {
            assert_eq!(address, "review");
            assert_eq!(keys, vec!["up".to_string(), "enter".to_string()]);
        }
        _ => panic!("expected keys"),
    }
    assert!(parse_args(&owned(&["dispatch", "kill"])).is_err());
    assert!(matches!(
        parse_args(&owned(&["dispatch", "interrupt", "review"])).unwrap(),
        Command::Interrupt { .. }
    ));
}

#[test]
fn explicit_missing_role_stays_role_not_found() {
    let dir = std::env::temp_dir().join(format!(
        "kite-dispatch-missing-role-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let command = parse_args(&owned(&[
        "dispatch",
        "run",
        "--role",
        "missing",
        "task words",
    ]))
    .unwrap();
    match &command {
        Command::Run {
            explicit_role,
            role,
            program,
            task,
            ..
        } => {
            assert!(*explicit_role);
            assert_eq!(role.as_deref(), Some("missing"));
            assert!(program.is_none());
            assert_eq!(task.as_deref(), Some("task words"));
        }
        _ => panic!("expected run"),
    }
    let mut service = Service::new(FakePort::default());
    let started = exec_run(
        &mut service,
        &command,
        "missing-role",
        Caller::Agent,
        Some(&dir),
    );
    assert_eq!(started.error.as_deref(), Some("role_not_found"));
    assert!(service.port_mut().starts.is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn parse_and_execute_thread_subagent_run_supports_provider_model_effort_workspace_and_wait() {
    let args = owned(&[
        "dispatch",
        "run",
        "--via",
        "thread",
        "--provider",
        "grok",
        "--model",
        "grok-3-mini",
        "--effort",
        "low",
        "--role",
        "Fast Executor",
        "--workspace",
        "share",
        "--wait",
        "--timeout-ms",
        "45000",
        "Refactor parser",
    ]);
    assert_eq!(blocking_run_wait_ms(&args), Some(45_000));
    let cmd = parse_args(&args).expect("thread subagent args must parse");
    match &cmd {
        Command::Run {
            via,
            explicit_via,
            provider,
            model,
            effort,
            role,
            workspace,
            wait,
            timeout_ms,
            task,
            ..
        } => {
            assert_eq!(*via, Family::Thread);
            assert!(*explicit_via);
            assert_eq!(provider.as_deref(), Some("grok"));
            assert_eq!(model.as_deref(), Some("grok-3-mini"));
            assert_eq!(effort.as_deref(), Some("low"));
            assert_eq!(role.as_deref(), Some("Fast Executor"));
            assert_eq!(workspace.as_deref(), Some("share"));
            assert!(*wait);
            assert_eq!(*timeout_ms, Some(45_000));
            assert_eq!(task.as_deref(), Some("Refactor parser"));
        }
        _ => panic!("expected Command::Run"),
    }

    // Positional provider + default via from thread caller + custom --role without role .md file
    let implicit_cmd = parse_args(&owned(&[
        "dispatch",
        "run",
        "--role",
        "Database Researcher",
        "Inspect schema",
    ]))
    .unwrap();
    let mut service = Service::new(FakePort::default());
    let receipt = execute(
        &mut service,
        &implicit_cmd,
        &ExecContext {
            id: "run-implicit-thread",
            caller: Caller::Agent,
            from: "thread:parent-1",
            workspace: None,
            now_ms: 5_000,
            config_dir: None,
            mounted: false,
        },
    )
    .expect("thread caller defaults to Family::Thread without needing role .md dir");
    assert_eq!(receipt.status, ReceiptStatus::Submitted);
    assert_eq!(receipt.address, "thread:th-1");
    assert!(receipt
        .text
        .as_deref()
        .unwrap_or("")
        .contains("[subagent_id: thread:th-1]"));
    assert_eq!(service.port_mut().thread_starts.len(), 1);
    assert_eq!(
        service.port_mut().thread_starts[0].parent.as_deref(),
        Some("thread:parent-1")
    );
    assert_eq!(
        service.port_mut().thread_starts[0].role.as_deref(),
        Some("Database Researcher")
    );
    assert_eq!(service.port_mut().thread_starts[0].task, "Inspect schema");

    // Positional provider on explicit --via thread
    let pos_prov = parse_args(&owned(&[
        "dispatch",
        "run",
        "--via",
        "thread",
        "gemini",
        "Summarize module",
    ]))
    .unwrap();
    match pos_prov {
        Command::Run {
            provider,
            task,
            name,
            ..
        } => {
            assert_eq!(provider.as_deref(), Some("gemini"));
            assert_eq!(task.as_deref(), Some("Summarize module"));
            assert!(name.is_none());
        }
        _ => panic!("expected Command::Run"),
    }

    // Inherit provider when positionals are task words
    let inherit_cmd = parse_args(&owned(&[
        "dispatch",
        "run",
        "--via",
        "thread",
        "Analyze login bug",
    ]))
    .unwrap();
    match inherit_cmd {
        Command::Run {
            provider,
            task,
            program,
            ..
        } => {
            assert!(provider.is_none());
            assert!(program.is_none());
            assert_eq!(task.as_deref(), Some("Analyze login bug"));
        }
        _ => panic!("expected Command::Run"),
    }

    assert!(parse_args(&owned(&["dispatch", "run", "--via", "thread", "--workspace", "invalid", "x"])).is_err());
    assert!(parse_args(&owned(&["dispatch", "run", "--via", "thread", "--effort", "turbo", "x"])).is_err());
}

#[test]
fn role_file_named_like_a_program_wins() {
    let dir = std::env::temp_dir().join(format!(
        "kite-dispatch-role-wins-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    let roles = crate::dispatch::role::roles_dir(&dir);
    std::fs::create_dir_all(&roles).unwrap();
    std::fs::write(
        roles.join("grok.md"),
        "command: codex\n\nPreface from the role file.\n",
    )
    .unwrap();
    let command = parse_args(&owned(&[
        "kite",
        "dispatch",
        "run",
        "grok",
        "task text",
    ]))
    .unwrap();
    let mut service = Service::new(FakePort::default());
    let started = exec_run(
        &mut service,
        &command,
        "role-wins",
        Caller::Agent,
        Some(&dir),
    );
    assert_eq!(started.status, ReceiptStatus::Submitted);
    let start = &service.port_mut().starts[0];
    assert_eq!(start.engine, "codex");
    assert!(!start.manual_as_system);
    let prompt = start.prompt.clone().unwrap_or_default();
    assert!(prompt.contains("Preface from the role file."));
    assert!(prompt.contains("task text"));
    assert!(!prompt.contains("This text is the complete manual."));
    assert!(!prompt.contains("KITE_SKILL_FILE"));
    assert!(!prompt.contains("kite dispatch run <role>"));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn programs_text_matches_the_skill_names() {
    let command = parse_args(&owned(&["dispatch", "programs"])).unwrap();
    let mut service = Service::new(FakePort::default());
    service.set_online(false);
    let receipt = execute(
        &mut service,
        &command,
        &ExecContext {
            id: "programs",
            caller: Caller::Agent,
            from: "agent",
            now_ms: 10,
            config_dir: None,
            workspace: None,
            mounted: false,
        },
    )
    .unwrap();
    assert_eq!(receipt.op, "programs");
    assert_eq!(receipt.status, ReceiptStatus::Settled);
    let text = receipt.text.clone().unwrap_or_default();
    assert_eq!(text, super::super::programs::lines());
    assert!(skill_text().contains(&text));
    assert!(service.port_mut().starts.is_empty());
}

#[test]
fn pane_policy_is_pending_or_hidden_without_a_wait() {
    use crate::dispatch::types::PaneVisibility;

    let human_cmd = parse_args(&owned(&["dispatch", "run", "grok", "hello"])).unwrap();
    let mut human_svc = Service::new(FakePort::default());
    let human = execute(
        &mut human_svc,
        &human_cmd,
        &ExecContext {
            id: "human-pane",
            caller: Caller::Human,
            from: "human",
            now_ms: 10,
            config_dir: None,
            workspace: None,
            mounted: false,
        },
    )
    .unwrap();
    assert_eq!(human.pane, Some(PaneVisibility::Pending));
    assert!(!human_svc.port_mut().starts[0].hidden);
    assert_eq!(human_svc.port_mut().starts.len(), 1);
    let json = serde_json::to_string(&human).unwrap();
    assert!(json.contains("\"pane\":\"pending\""));

    let pane_cmd = parse_args(&owned(&[
        "dispatch", "run", "--pane", "grok", "hello",
    ]))
    .unwrap();
    let mut pane_svc = Service::new(FakePort::default());
    let pane = exec_run(&mut pane_svc, &pane_cmd, "agent-pane", Caller::Agent, None);
    assert_eq!(pane.pane, Some(PaneVisibility::Pending));
    assert!(!pane_svc.port_mut().starts[0].hidden);

    let hidden_cmd = parse_args(&owned(&[
        "dispatch", "run", "--hidden", "--pane", "grok", "hello",
    ]))
    .unwrap();
    let mut hidden_svc = Service::new(FakePort::default());
    let hidden = exec_run(
        &mut hidden_svc,
        &hidden_cmd,
        "agent-hidden",
        Caller::Agent,
        None,
    );
    assert_eq!(hidden.pane, Some(PaneVisibility::Hidden));
    assert!(hidden_svc.port_mut().starts[0].hidden);

    let script_cmd = parse_args(&owned(&["dispatch", "run", "codex", "quiet"])).unwrap();
    let mut script_svc = Service::new(FakePort::default());
    let script = exec_run(
        &mut script_svc,
        &script_cmd,
        "script-hidden",
        Caller::Script,
        None,
    );
    assert_eq!(script.pane, Some(PaneVisibility::Hidden));
}

#[test]
fn parse_and_execute_swarm_commands_covers_all_subcommands() {
    let cases: Vec<(&[&str], &str)> = vec![
        (&["dispatch", "swarm", "title", "Auth Refactor Swarm"], "title"),
        (
            &[
                "dispatch",
                "swarm",
                "add",
                "--name",
                "grok-exec",
                "--provider",
                "grok",
                "--model",
                "grok-3-mini",
                "--effort",
                "low",
                "--workspace",
                "share",
                "--channels",
                "parser,tests",
                "--fork",
                "coordinator",
                "--role",
                "Grok Executor",
                "--brief",
                "Fix token parser",
            ],
            "add",
        ),
        (
            &[
                "dispatch",
                "swarm",
                "post",
                "--channel",
                "parser",
                "@grok-exec check edge case #1",
            ],
            "post",
        ),
        (
            &["dispatch", "swarm", "read", "--since", "2", "--channel", "*"],
            "read",
        ),
        (
            &[
                "dispatch",
                "swarm",
                "wait",
                "--since",
                "3",
                "--mentions-only",
                "true",
                "--timeout-ms",
                "12000",
            ],
            "wait",
        ),
        (&["dispatch", "swarm", "status"], "status"),
        (
            &[
                "dispatch",
                "swarm",
                "model",
                "--name",
                "grok-exec",
                "--provider",
                "gemini",
                "--model",
                "gemini-2.5-flash",
                "--effort",
                "medium",
            ],
            "model",
        ),
        (&["dispatch", "swarm", "kill", "--name", "grok-exec"], "kill"),
        (
            &[
                "dispatch",
                "swarm",
                "channel",
                "create",
                "--channel",
                "parser",
                "--topic",
                "Parser workers",
            ],
            "channel",
        ),
    ];

    assert_eq!(
        blocking_swarm_wait_ms(&owned(&[
            "dispatch",
            "swarm",
            "wait",
            "--since",
            "3",
            "--timeout-ms",
            "12000",
        ])),
        Some(12_000)
    );

    let mut service = Service::new(FakePort::default());
    for (idx, (argv, label)) in cases.iter().enumerate() {
        let cmd = parse_args(&owned(argv)).unwrap_or_else(|e| panic!("failed {label}: {e:?}"));
        let id = format!("swarm-{idx}-{label}");
        let receipt = execute(
            &mut service,
            &cmd,
            &ExecContext {
                id: &id,
                caller: Caller::Agent,
                from: "thread:coord-1",
                now_ms: 1_000 + idx as u64,
                config_dir: None,
                workspace: None,
                mounted: false,
            },
        )
        .unwrap();
        assert_eq!(receipt.status, ReceiptStatus::Settled, "case={label}");
    }
    assert_eq!(service.port_mut().swarm_cmds.len(), 9);
}

#[test]
fn manual_and_skill_document_cross_provider_subagents_and_swarm() {
    let manual = manual_text();
    let skill = skill_text();

    assert!(skill.contains("cross-provider subagent"));
    assert!(skill.contains("swarm"));
    assert_eq!(strip_skill_frontmatter(skill), manual);

    for required in [
        "--via thread",
        "--provider",
        "--model",
        "--effort",
        "--role",
        "--workspace",
        "inherit|share|branch",
        "--wait",
        "--last",
        "--children all",
        "kite dispatch run --via thread --provider",
        "kite dispatch read",
        "kite dispatch swarm title",
        "kite dispatch swarm add",
        "kite dispatch swarm post",
        "kite dispatch swarm read",
        "kite dispatch swarm wait",
        "kite dispatch swarm status",
        "kite dispatch swarm model",
        "kite dispatch swarm kill",
        "kite dispatch swarm channel",
        "@mention",
        "zero token cost",
    ] {
        assert!(
            manual.contains(required),
            "manual missing `{required}`"
        );
        assert!(
            skill.contains(required),
            "skill missing `{required}`"
        );
    }
}

#[test]
fn test_binary_path_guard_detects_cargo_test_harnesses_without_blocking_release_binaries() {
    assert!(is_test_binary_path(std::path::Path::new(
        r"C:\repo\src-tauri\target\debug\deps\kite_code-bfcae09c3d87a467.exe"
    )));
    assert!(is_test_binary_path(std::path::Path::new(
        r"/tmp/target/debug/deps/kite_code-abc123"
    )));
    assert!(!is_test_binary_path(std::path::Path::new(
        r"C:\repo\src-tauri\target\debug\kite-code.exe"
    )));
    assert!(!is_test_binary_path(std::path::Path::new(
        r"C:\repo\src-tauri\target\debug\kite.exe"
    )));
}

#[test]
fn write_shim_to_dir_prefers_sibling_console_kite_binary() {
    let dir = std::env::temp_dir().join(format!("kite-shim-test-{}", std::process::id()));
    let bin_dir = dir.join("app");
    let out_dir = dir.join("roaming-bin");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&bin_dir).expect("create app dir");

    let console_name = if cfg!(windows) { "kite.exe" } else { "kite" };
    let gui_name = if cfg!(windows) { "kite-code.exe" } else { "kite-code" };
    let console_src = bin_dir.join(console_name);
    let gui_src = bin_dir.join(gui_name);
    std::fs::write(&console_src, b"console-binary-bytes").expect("write mock kite binary");
    std::fs::write(&gui_src, b"gui-binary-bytes").expect("write mock gui binary");

    write_shim_to_dir(&out_dir, &gui_src);

    let copied = out_dir.join(console_name);
    assert_eq!(std::fs::read(&copied).expect("copied console binary"), b"console-binary-bytes");

    #[cfg(windows)]
    {
        let cmd = std::fs::read_to_string(out_dir.join("kite.cmd")).expect("read kite.cmd");
        assert!(cmd.contains(&copied.display().to_string()), "kite.cmd must target console kite.exe: {cmd}");
        assert!(!cmd.contains("kite-code.exe"), "kite.cmd must not target GUI subsystem executable: {cmd}");
    }

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn cli_wire_routes_thread_and_swarm_commands_to_gui_endpoint() {
    use super::super::cli_wire::{
        blocking_run_wait_ms as wire_run_wait_ms,
        blocking_wait_ms as wire_wait_ms,
        should_prefer_gui_endpoint,
    };

    assert!(should_prefer_gui_endpoint(&owned(&["run", "--via", "thread", "grok", "hi"]), None));
    assert!(should_prefer_gui_endpoint(&owned(&["swarm", "status"]), None));
    assert!(should_prefer_gui_endpoint(&owned(&["providers"]), None));
    assert!(should_prefer_gui_endpoint(&owned(&["models", "grok"]), None));
    assert!(should_prefer_gui_endpoint(&owned(&["read", "thread:abc", "--last"]), None));
    assert!(should_prefer_gui_endpoint(&owned(&["run", "grok", "hi"]), Some("thread:parent")));
    assert!(!should_prefer_gui_endpoint(&owned(&["run", "--via", "terminal", "grok", "hi"]), Some("thread:parent")));
    assert!(!should_prefer_gui_endpoint(&owned(&["ls"]), None));
    assert_eq!(wire_run_wait_ms(&owned(&["run", "--wait", "--timeout-ms", "45000", "hi"])), Some(45_000));
    assert_eq!(wire_wait_ms(&owned(&["wait", "thread:abc", "--timeout", "1500"])), Some(1_500));
}

#[test]
fn providers_and_models_commands_parse_and_skill_has_no_legacy_model_literals() {
    let prov = parse_args(&owned(&["kite", "dispatch", "providers", "--refresh"])).unwrap();
    assert_eq!(prov, Command::Providers { refresh: true });

    let mods = parse_args(&owned(&["kite", "dispatch", "models", "open-code", "--refresh"])).unwrap();
    assert_eq!(
        mods,
        Command::Models {
            provider: Some("opencode".to_string()),
            refresh: true,
        }
    );

    let (err, detail) =
        parse_args_detailed(&owned(&["run", "--via", "thread", "--provider", "bogus", "hi"]))
            .expect_err("unknown provider must fail with descriptive message");
    assert_eq!(err, DispatchError::BadArgs);
    assert!(detail.contains("Allowed thread providers"));
    assert!(detail.contains("kite dispatch providers"));

    assert_eq!(canonical_thread_provider("claude-code"), Some("claude"));
    assert_eq!(canonical_thread_provider("open-code"), Some("opencode"));
    assert_eq!(canonical_thread_provider("cursor-agent"), Some("cursor"));
    assert_eq!(parse_args(&owned(&["kite", "dispatch", "--help"])).unwrap(), Command::Skill);
    assert_eq!(parse_args(&owned(&["kite", "dispatch", "-h"])).unwrap(), Command::Skill);
    assert_eq!(parse_args(&owned(&["kite", "dispatch", "help"])).unwrap(), Command::Skill);

    let manual = manual_text();
    let skill = skill_text();
    for text in [manual, skill] {
        assert!(text.contains("kite dispatch providers"));
        assert!(text.contains("kite dispatch models"));
        assert!(!text.contains("grok-3-mini"));
        assert!(!text.contains("o4-mini"));
        assert!(!text.contains("gemini-2.5-flash"));
    }
}
