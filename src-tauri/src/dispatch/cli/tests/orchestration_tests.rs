use super::*;
use crate::dispatch::cli::*;
use crate::dispatch::policy::{ChildrenMode, RunInput, SendInput, Service, WaitInput};
use crate::dispatch::port::FakePort;
use crate::dispatch::presence::PresenceState;
use crate::dispatch::types::{exit_code, Caller, DispatchError, Family, Receipt, ReceiptStatus};

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
    assert_eq!(text, crate::dispatch::programs::lines());
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
    use crate::dispatch::cli_wire::{
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

