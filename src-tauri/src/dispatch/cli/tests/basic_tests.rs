use super::*;
use crate::dispatch::cli::*;
use crate::dispatch::policy::{ChildrenMode, RunInput, SendInput, Service, WaitInput};
use crate::dispatch::port::FakePort;
use crate::dispatch::presence::PresenceState;
use crate::dispatch::types::{exit_code, Caller, DispatchError, Family, Receipt, ReceiptStatus};

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
    assert!(text.contains(&crate::dispatch::programs::lines()));

    let manual = manual_text();
    assert!(manual.starts_with("Kite Dispatch\n"));
    assert!(!manual.contains("name: kite-dispatch"));
    assert_eq!(strip_skill_frontmatter(&text), manual);
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
            wait: false,
            timeout_ms: None,
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
            override_stack: false,
            name: Some("helper".into()),
            explicit_name: true,
            parent: None,
            outlive: false,
            role: None,
            explicit_role: false,
            file: None,
            task: None,
            tasks: Vec::new(),
            count: None,
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
            override_stack: false,
            name: Some("solo".into()),
            explicit_name: true,
            parent: None,
            outlive: false,
            role: None,
            explicit_role: false,
            file: None,
            task: None,
            tasks: Vec::new(),
            count: None,
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
    std::fs::write(
        crate::dispatch::role::roles_dir(&dir).join("review.md"),
        "command: codex\ndescription: Terminal review.\n\nReview the task. Report defects, risks, and a recommendation.\n",
    )
    .unwrap();
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
fn write_shim_skips_copy_when_metadata_matches_and_updates_when_stale() {
    let root = std::env::temp_dir().join(format!(
        "kite-shim-meta-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let exe_dir = root.join("exe");
    let bin_dir = root.join("bin");
    std::fs::create_dir_all(&exe_dir).unwrap();
    std::fs::create_dir_all(&bin_dir).unwrap();

    let console_name = if cfg!(windows) { "kite.exe" } else { "kite" };
    let gui_exe = exe_dir.join(if cfg!(windows) { "kite-code.exe" } else { "kite-code" });
    let src = exe_dir.join(console_name);
    let dest = bin_dir.join(console_name);

    std::fs::write(&gui_exe, b"gui").unwrap();
    std::fs::write(&src, b"AAA").unwrap();

    write_shim_to_dir(&bin_dir, &gui_exe);
    assert_eq!(std::fs::read(&dest).unwrap(), b"AAA");

    // Same length and newer dest mtime: metadata check avoids re-reading/copying src.
    let future = std::time::SystemTime::now() + std::time::Duration::from_secs(5);
    std::fs::write(&dest, b"BBB").unwrap();
    std::fs::File::options()
        .write(true)
        .open(&dest)
        .unwrap()
        .set_modified(future)
        .unwrap();
    write_shim_to_dir(&bin_dir, &gui_exe);
    assert_eq!(
        std::fs::read(&dest).unwrap(),
        b"BBB",
        "matching length and up-to-date mtime must skip full file comparison and copy"
    );

    // Different length: must refresh dest from src.
    std::fs::write(&src, b"AAAA").unwrap();
    write_shim_to_dir(&bin_dir, &gui_exe);
    assert_eq!(std::fs::read(&dest).unwrap(), b"AAAA");

    // Same length but newer src mtime: must refresh dest from src.
    std::fs::write(&src, b"CCCC").unwrap();
    let even_later = future + std::time::Duration::from_secs(10);
    std::fs::File::options()
        .write(true)
        .open(&src)
        .unwrap()
        .set_modified(even_later)
        .unwrap();
    write_shim_to_dir(&bin_dir, &gui_exe);
    assert_eq!(std::fs::read(&dest).unwrap(), b"CCCC");

    let _ = std::fs::remove_dir_all(&root);
}


