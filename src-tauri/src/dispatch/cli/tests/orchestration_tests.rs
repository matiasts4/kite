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
    assert_eq!(strip_skill_frontmatter(&skill), manual);

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

#[test]
fn cli_parses_equals_flags_timeout_ms_and_rejects_short_flag_typos() {
    let run_cmd = parse_args(&owned(&[
        "kite",
        "dispatch",
        "run",
        "--via=thread",
        "--provider=grok",
        "--model=grok-code-fast",
        "--effort=low",
        "--workspace=share",
        "--timeout-ms=12000",
        "--wait",
        "Audit parser",
    ]))
    .expect("run --flag=value must parse");
    match run_cmd {
        Command::Run {
            via,
            provider,
            model,
            effort,
            workspace,
            wait,
            timeout_ms,
            task,
            ..
        } => {
            assert_eq!(via, Family::Thread);
            assert_eq!(provider.as_deref(), Some("grok"));
            assert_eq!(model.as_deref(), Some("grok-code-fast"));
            assert_eq!(effort.as_deref(), Some("low"));
            assert_eq!(workspace.as_deref(), Some("share"));
            assert!(wait);
            assert_eq!(timeout_ms, Some(12_000));
            assert_eq!(task.as_deref(), Some("Audit parser"));
        }
        other => panic!("unexpected command: {other:?}"),
    }

    let wait_cmd = parse_args(&owned(&[
        "kite",
        "dispatch",
        "wait",
        "thread:abc",
        "--until=idle",
        "--timeout-ms=4500",
        "--children=all",
    ]))
    .expect("wait --timeout-ms=4500 must parse");
    assert_eq!(
        wait_cmd,
        Command::Wait {
            address: Some("thread:abc".into()),
            until: vec![PresenceState::Idle],
            children: Some(ChildrenMode::All),
            timeout_ms: 4500,
        }
    );

    let swarm_add = parse_args(&owned(&[
        "kite",
        "dispatch",
        "swarm",
        "add",
        "--name=reviewer",
        "--provider=codex",
        "--brief=Inspect API",
    ]))
    .expect("swarm add --flag=value must parse");
    assert!(matches!(swarm_add, Command::Swarm(SwarmCommand::Add { .. })));

    let swarm_wait = parse_args(&owned(&[
        "kite",
        "dispatch",
        "swarm",
        "wait",
        "--since=2",
        "--timeout-ms=8000",
        "--mentions-only=true",
    ]))
    .expect("swarm wait --flag=value must parse");
    assert_eq!(
        swarm_wait,
        Command::Swarm(SwarmCommand::Wait {
            since: 2,
            mentions_only: true,
            timeout_ms: 8000,
        })
    );

    assert_eq!(
        parse_args(&owned(&["kite", "dispatch", "send", "thread:abc", "-f", "foo"])),
        Err(DispatchError::BadArgs)
    );
    assert_eq!(
        parse_args(&owned(&["kite", "dispatch", "wait", "-t", "10"])),
        Err(DispatchError::BadArgs)
    );
    assert_eq!(
        parse_args(&owned(&["kite", "dispatch", "models", "--provider=grok"])),
        Ok(Command::Models {
            provider: Some("grok".to_string()),
            refresh: false,
        })
    );
    assert_eq!(
        parse_args(&owned(&["kite", "dispatch", "ls", "--bogus"])),
        Err(DispatchError::BadArgs)
    );
    assert_eq!(
        parse_args(&owned(&[
            "kite",
            "dispatch",
            "run",
            "--via",
            "thread",
            "--model",
            "-x",
            "hi"
        ])),
        Err(DispatchError::BadArgs)
    );
    assert_eq!(
        crate::dispatch::cli_wire::blocking_wait_ms(&owned(&[
            "kite",
            "dispatch",
            "wait",
            "thread:a",
            "--timeout",
            "1000",
            "--timeout-ms=7500",
        ])),
        Some(7500)
    );
    assert_eq!(
        crate::dispatch::cli_wire::blocking_run_wait_ms(&owned(&[
            "kite",
            "dispatch",
            "run",
            "--wait",
            "--timeout-ms=4000",
            "--timeout",
            "9000",
            "task",
        ])),
        Some(9000)
    );
    for flag in ["--mentions", "--mentions-only"] {
        assert_eq!(
            parse_args(&owned(&["kite", "dispatch", "swarm", "wait", "--since", "3", flag])),
            Ok(Command::Swarm(SwarmCommand::Wait {
                since: 3,
                mentions_only: true,
                timeout_ms: 60_000,
            }))
        );
    }
}

#[test]
fn compose_manual_and_skill_reflect_configured_stack_and_roles() {
    use crate::subagent_settings::{
        DefaultDelegation, OverridePolicy, SubagentRoleRecord, SubagentSettings, SubagentStackEntry,
    };

    let settings = SubagentSettings {
        stack: vec![
            SubagentStackEntry {
                provider: "grok".to_string(),
                model: "grok-4.7-build-fast".to_string(),
                effort: Some("low".to_string()),
                enabled: true,
            },
            SubagentStackEntry {
                provider: "claude".to_string(),
                model: "claude-sonnet-4-6".to_string(),
                effort: None,
                enabled: false,
            },
        ],
        default_delegation: Some(DefaultDelegation {
            provider: "grok".to_string(),
            model: "grok-4.7-build-fast".to_string(),
            effort: Some("low".to_string()),
        }),
        override_policy: OverridePolicy::Ask,
    };
    let roles = vec![SubagentRoleRecord {
        slug: "reviewer".to_string(),
        scope: "workspace".to_string(),
        path: ".kite/agents/reviewer.md".to_string(),
        command: "grok".to_string(),
        description: Some("Fast code reviewer".to_string()),
        provider: Some("grok".to_string()),
        model: Some("grok-4.7-build-fast".to_string()),
        effort: Some("low".to_string()),
        workspace: Some("inherit".to_string()),
        body: "Review carefully.".to_string(),
    }];

    let manual = compose_manual_with(&settings, &roles);
    let skill = compose_skill_with(&settings, &roles);

    assert!(manual.contains("Override policy: `ask`"), "got: {manual}");
    assert!(manual.contains("grok/grok-4.7-build-fast (low)"), "got: {manual}");
    assert!(!manual.contains("claude/claude-sonnet-4-6"), "disabled stack entry leaked: {manual}");
    assert!(manual.contains("`reviewer` (workspace) [grok/grok-4.7-build-fast]"), "got: {manual}");
    assert!(skill.contains("Configured Subagents Stack & Roles:"), "got: {skill}");
    assert!(
        skill.contains("Omit --provider/--model to use the configured Settings -> Subagents default/stack"),
        "skill frontmatter should prioritize omitting --provider/--model when stack/default is configured: {skill}"
    );
    assert!(
        manual.contains("OMIT `--provider` and `--model`"),
        "manual should instruct omitting --provider/--model when default/stack is configured: {manual}"
    );
    assert!(!skill.contains("kite dispatch run <role>"), "must keep --role syntax invariant");
}

#[test]
fn cli_execute_run_via_thread_wait_suppresses_child_notice() {
    let mut svc = Service::new(FakePort::default());
    svc.attach(Family::Thread, "parent-cli", None, None, false)
        .unwrap();
    svc.publish_pane("thread:parent-cli", "working", 1, 1_000, None, None)
        .unwrap();

    let cmd = parse_args(&owned(&[
        "kite",
        "dispatch",
        "run",
        "--via",
        "thread",
        "--wait",
        "Inspect package.json",
    ]))
    .expect("parse run --via thread --wait");
    let receipt = execute(
        &mut svc,
        &cmd,
        &ExecContext {
            id: "cli-run-wait-1",
            caller: Caller::Agent,
            from: "thread:parent-cli",
            now_ms: 1_100,
            config_dir: None,
            workspace: None,
            mounted: false,
        },
    )
    .expect("execute run --via thread --wait");
    assert_eq!(receipt.status, ReceiptStatus::Submitted);
    let child_addr = receipt.address.clone();

    svc.publish_pane(&child_addr, "done", 2, 1_200, Some("sync wait result"), None)
        .unwrap();
    svc.publish_pane("thread:parent-cli", "idle", 2, 1_300, None, None)
        .unwrap();

    assert!(
        svc.port_mut()
            .writes
            .iter()
            .all(|w| !w.text.contains(&format!("from=\"{child_addr}\""))),
        "run --via thread --wait should suppress delayed parent notice, got: {:?}",
        svc.port_mut().writes
    );
}

#[test]
fn cli_execute_agent_read_suppresses_settled_child_notice_only() {
    let mut svc = Service::new(FakePort::default());
    svc.attach(Family::Thread, "p-read", None, None, false).unwrap();
    svc.publish_pane("thread:p-read", "working", 1, 1_000, None, None)
        .unwrap();

    for (cid, done, body) in [
        ("c-read-done", true, Some("settled output")),
        ("c-read-work", false, None),
    ] {
        svc.attach(Family::Thread, cid, None, Some("thread:p-read"), false)
            .unwrap();
        svc.publish_pane(&format!("thread:{cid}"), "working", 1, 1_100, None, None)
            .unwrap();
        if done {
            svc.publish_pane(&format!("thread:{cid}"), "done", 2, 1_150, body, None)
                .unwrap();
        }
    }

    // Reading while still working must NOT suppress the child's later completion wakeup.
    let read_working = parse_args(&owned(&["kite", "dispatch", "read", "thread:c-read-work"]))
        .expect("parse read working child");
    let r_work = execute(
        &mut svc,
        &read_working,
        &ExecContext {
            id: "cli-read-work",
            caller: Caller::Agent,
            from: "thread:p-read",
            now_ms: 1_160,
            config_dir: None,
            workspace: None,
            mounted: false,
        },
    )
    .expect("execute read working child");
    assert_eq!(r_work.status, ReceiptStatus::Settled);

    // Agent read from parent on a settled child DOES suppress the queued/delayed wakeup.
    let read_done = parse_args(&owned(&["kite", "dispatch", "read", "thread:c-read-done"]))
        .expect("parse read done child");
    execute(
        &mut svc,
        &read_done,
        &ExecContext {
            id: "cli-read-agent",
            caller: Caller::Agent,
            from: "thread:p-read",
            now_ms: 1_180,
            config_dir: None,
            workspace: None,
            mounted: false,
        },
    )
    .expect("agent read");

    svc.publish_pane(
        "thread:c-read-work",
        "done",
        2,
        1_200,
        Some("finished later"),
        None,
    )
    .unwrap();
    svc.publish_pane("thread:p-read", "idle", 2, 1_300, None, None)
        .unwrap();

    assert!(
        svc.port_mut()
            .writes
            .iter()
            .all(|w| !w.text.contains("from=\"thread:c-read-done\"")),
        "agent read on settled child should suppress queued wakeup: {:?}",
        svc.port_mut().writes
    );
    assert!(
        svc.port_mut()
            .writes
            .iter()
            .any(|w| w.text.contains("from=\"thread:c-read-work\"")
                && w.text.contains("finished later")),
        "reading a working child early must still deliver completion wakeup: {:?}",
        svc.port_mut().writes
    );
}

#[test]
fn cli_execute_human_or_unowned_read_does_not_suppress_child_notice() {
    let mut svc = Service::new(FakePort::default());
    svc.attach(Family::Thread, "p-own", None, None, false).unwrap();
    svc.publish_pane("thread:p-own", "working", 1, 1_000, None, None)
        .unwrap();
    svc.attach(Family::Thread, "c-own", None, Some("thread:p-own"), false)
        .unwrap();
    svc.publish_pane("thread:c-own", "working", 1, 1_100, None, None)
        .unwrap();
    svc.publish_pane("thread:c-own", "done", 2, 1_150, Some("unowned read report"), None)
        .unwrap();

    let read_cmd =
        parse_args(&owned(&["kite", "dispatch", "read", "thread:c-own"])).expect("parse read");
    execute(
        &mut svc,
        &read_cmd,
        &ExecContext {
            id: "cli-read-human-own",
            caller: Caller::Human,
            from: "thread:p-own",
            now_ms: 1_160,
            config_dir: None,
            workspace: None,
            mounted: false,
        },
    )
    .expect("human read");
    execute(
        &mut svc,
        &read_cmd,
        &ExecContext {
            id: "cli-read-unknown-own",
            caller: Caller::Agent,
            from: "agent",
            now_ms: 1_170,
            config_dir: None,
            workspace: None,
            mounted: false,
        },
    )
    .expect("unknown agent read");

    svc.publish_pane("thread:p-own", "idle", 2, 1_200, None, None)
        .unwrap();

    assert!(
        svc.port_mut()
            .writes
            .iter()
            .any(|w| w.text.contains("from=\"thread:c-own\"")
                && w.text.contains("unowned read report")),
        "human or unowned agent read must not suppress child wakeup: {:?}",
        svc.port_mut().writes
    );
}

#[test]
fn cli_multi_task_and_count_fanout_spawns_distinct_threads_and_suppresses_wait_notices() {
    assert_eq!(normalize_workspace_mode("worktree").as_deref(), Some("share"));
    assert_eq!(normalize_workspace_mode("WORKTREE").as_deref(), Some("share"));
    let ws_cmd = parse_args(&owned(&[
        "kite",
        "dispatch",
        "run",
        "--via",
        "thread",
        "--workspace",
        "worktree",
        "Check worktree alias",
    ]))
    .expect("worktree workspace alias must parse");
    match ws_cmd {
        Command::Run { workspace, .. } => {
            assert_eq!(workspace.as_deref(), Some("share"));
        }
        other => panic!("expected Command::Run, got {other:?}"),
    }

    let mut svc = Service::new(FakePort::default());
    svc.attach(Family::Thread, "parent-batch", None, None, false)
        .unwrap();
    svc.publish_pane("thread:parent-batch", "working", 1, 1_000, None, None)
        .unwrap();

    let multi_task_cmd = parse_args(&owned(&[
        "kite",
        "dispatch",
        "run",
        "--via",
        "thread",
        "--role",
        "Fast Executor",
        "--task",
        "Audit A",
        "--task",
        "Audit B",
        "--wait",
    ]))
    .expect("parse multi-task run");
    match &multi_task_cmd {
        Command::Run {
            tasks,
            task,
            wait,
            ..
        } => {
            assert_eq!(tasks, &vec!["Audit A".to_string(), "Audit B".to_string()]);
            assert_eq!(task.as_deref(), Some("Audit A"));
            assert!(*wait);
        }
        other => panic!("expected Command::Run, got {other:?}"),
    }

    let receipt = execute(
        &mut svc,
        &multi_task_cmd,
        &ExecContext {
            id: "batch-run-1",
            caller: Caller::Agent,
            from: "thread:parent-batch",
            now_ms: 1_100,
            config_dir: None,
            workspace: None,
            mounted: false,
        },
    )
    .expect("execute multi-task run");
    assert_eq!(receipt.status, ReceiptStatus::Submitted);
    assert_eq!(receipt.address, "thread:th-1");
    assert_eq!(receipt.text.as_deref(), Some("thread:th-1,thread:th-2"));
    assert_eq!(svc.port_mut().thread_starts.len(), 2);
    assert_eq!(svc.port_mut().thread_starts[0].task, "Audit A");
    assert_eq!(
        svc.port_mut().thread_starts[0].role.as_deref(),
        Some("Fast Executor #1")
    );
    assert_eq!(svc.port_mut().thread_starts[1].task, "Audit B");
    assert_eq!(
        svc.port_mut().thread_starts[1].role.as_deref(),
        Some("Fast Executor #2")
    );

    svc.publish_pane("thread:th-1", "done", 2, 1_200, Some("Audit A done"), None)
        .unwrap();
    svc.publish_pane("thread:th-2", "done", 2, 1_210, Some("Audit B done"), None)
        .unwrap();
    svc.publish_pane("thread:parent-batch", "idle", 2, 1_300, None, None)
        .unwrap();
    assert!(
        svc.port_mut().writes.iter().all(|w| {
            !w.text.contains("from=\"thread:th-1\"") && !w.text.contains("from=\"thread:th-2\"")
        }),
        "batch --wait must suppress parent wakeup notices on all spawned children: {:?}",
        svc.port_mut().writes
    );

    // Parallel fan-out via --count 2 / -n 2
    let count_cmd = parse_args(&owned(&[
        "kite",
        "dispatch",
        "run",
        "--via",
        "thread",
        "--count",
        "2",
        "Run parallel check",
    ]))
    .expect("parse --count 2 run");
    let count_receipt = execute(
        &mut svc,
        &count_cmd,
        &ExecContext {
            id: "count-run-1",
            caller: Caller::Agent,
            from: "thread:parent-batch",
            now_ms: 1_400,
            config_dir: None,
            workspace: None,
            mounted: false,
        },
    )
    .expect("execute --count 2 run");
    assert_eq!(count_receipt.status, ReceiptStatus::Submitted);
    assert_eq!(count_receipt.address, "thread:th-3");
    assert_eq!(
        count_receipt.text.as_deref(),
        Some("thread:th-3,thread:th-4")
    );
    assert_eq!(svc.port_mut().thread_starts.len(), 4);
    assert_eq!(svc.port_mut().thread_starts[2].task, "Run parallel check");
    assert_eq!(svc.port_mut().thread_starts[3].task, "Run parallel check");

    assert!(parse_args(&owned(&["kite", "dispatch", "run", "--via", "thread", "-n", "2", "check"])).is_ok());
    assert_eq!(
        parse_args(&owned(&["kite", "dispatch", "run", "--via", "thread", "--count", "0", "check"])),
        Err(DispatchError::BadArgs)
    );
    assert_eq!(
        parse_args(&owned(&["kite", "dispatch", "run", "--via", "thread", "--count", "9", "check"])),
        Err(DispatchError::BadArgs)
    );
    assert_eq!(
        parse_args(&owned(&["kite", "dispatch", "run", "--via", "thread", "--count", "abc", "check"])),
        Err(DispatchError::BadArgs)
    );
}

#[test]
fn cli_send_thread_with_wait_transitions_to_working_and_suppresses_wakeup() {
    let args = owned(&[
        "kite",
        "dispatch",
        "send",
        "thread:th-1",
        "Follow-up task",
        "--wait",
        "--timeout-ms",
        "45000",
    ]);
    assert_eq!(blocking_send_wait_ms(&args), Some(45_000));
    assert_eq!(
        blocking_send_wait_ms(&owned(&["kite", "dispatch", "send", "thread:th-1", "Follow-up task", "--wait"])),
        Some(300_000)
    );
    assert_eq!(
        blocking_send_wait_ms(&owned(&["kite", "dispatch", "send", "thread:th-1", "Follow-up task"])),
        None
    );

    let cmd = parse_args(&args).expect("parse send --wait");
    match &cmd {
        Command::Send {
            address,
            body,
            wait,
            timeout_ms,
            ..
        } => {
            assert_eq!(address, "thread:th-1");
            assert_eq!(body.as_deref(), Some("Follow-up task"));
            assert!(*wait);
            assert_eq!(*timeout_ms, Some(45_000));
        }
        other => panic!("expected Command::Send, got {other:?}"),
    }

    let mut svc = Service::new(FakePort::default());
    svc.attach(Family::Thread, "parent-send", None, None, false)
        .unwrap();
    svc.publish_pane("thread:parent-send", "working", 1, 1_000, None, None)
        .unwrap();
    svc.attach(Family::Thread, "th-1", None, Some("thread:parent-send"), false)
        .unwrap();
    svc.publish_pane("thread:th-1", "working", 1, 1_100, None, None)
        .unwrap();
    svc.publish_pane("thread:th-1", "done", 2, 1_200, Some("first turn done"), None)
        .unwrap();
    svc.suppress_parent_notice_for("thread:th-1");

    let send_receipt = execute(
        &mut svc,
        &cmd,
        &ExecContext {
            id: "send-followup-1",
            caller: Caller::Agent,
            from: "thread:parent-send",
            now_ms: 1_500,
            config_dir: None,
            workspace: None,
            mounted: false,
        },
    )
    .expect("execute send --wait");
    assert_eq!(send_receipt.status, ReceiptStatus::Submitted);
    assert!(send_receipt.submitted);
    assert!(
        svc.ls().iter().any(|row| row == "thread:th-1 working"),
        "send to settled thread must transition endpoint back to working: {:?}",
        svc.ls()
    );

    svc.publish_pane("thread:th-1", "done", 3, 1_600, Some("follow-up done"), None)
        .unwrap();
    svc.publish_pane("thread:parent-send", "idle", 2, 1_700, None, None)
        .unwrap();
    assert!(
        svc.port_mut()
            .writes
            .iter()
            .all(|w| !w.text.contains("from=\"thread:th-1\"")),
        "send --wait must suppress duplicate parent wakeup notice when follow-up turn settles: {:?}",
        svc.port_mut().writes
    );
}

#[test]
fn parse_agent_service_tool_commands_across_all_domains() {
    assert!(is_agent_argv(&owned(&["kite", "agent", "thread", "list"])));
    assert!(is_agent_argv(&owned(&["kite", "dispatch", "agent", "memory", "read"])));
    assert!(!is_agent_argv(&owned(&["kite", "dispatch", "ls"])));

    let t_list = parse_agent_args(&owned(&[
        "kite",
        "agent",
        "thread",
        "list",
        "--workspace-id",
        "ws-1",
        "--cursor",
        "10",
        "--limit",
        "25",
    ]))
    .unwrap();
    assert_eq!(
        t_list,
        AgentCommand::ThreadList {
            workspace_id: Some("ws-1".to_string()),
            agent_id: None,
            cursor: 10,
            limit: 25,
        }
    );

    let m_add = parse_agent_args(&owned(&[
        "kite",
        "dispatch",
        "agent",
        "memory",
        "add",
        "--target",
        "user",
        "--text",
        "Prefers concise diffs",
    ]))
    .unwrap();
    assert_eq!(
        m_add,
        AgentCommand::MemoryAdd {
            text: "Prefers concise diffs".to_string(),
            target: "user".to_string(),
            agent_id: None,
        }
    );

    let r_create = parse_agent_args(&owned(&[
        "agent",
        "routine",
        "create",
        "--name",
        "Hourly",
        "--prompt",
        "Check CI",
        "--every",
        "3600",
    ]))
    .unwrap();
    assert_eq!(
        r_create,
        AgentCommand::RoutineCreate {
            agent_id: None,
            name: "Hourly".to_string(),
            prompt: "Check CI".to_string(),
            cadence_seconds: 3600,
            workspace_id: None,
        }
    );

    let tm_send = parse_agent_args(&owned(&[
        "kite",
        "agent",
        "teammate",
        "send",
        "--target",
        "agent:1234",
        "--message",
        "Review PR",
    ]))
    .unwrap();
    assert_eq!(
        tm_send,
        AgentCommand::TeammateSend {
            target: "agent:1234".to_string(),
            message: "Review PR".to_string(),
        }
    );
}


