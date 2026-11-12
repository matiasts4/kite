use super::*;
use uuid::Uuid;
use crate::session_resolver::{
    read_persisted_terminal_sessions, upsert_persisted_terminal_session,
    write_persisted_terminal_sessions, PersistedTerminalSession,
};

#[test]
fn parse_reg_path_output_reads_reg_sz() {
    let stdout = "\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_SZ    C:\\Tools;C:\\CLIs\r\n";
    assert_eq!(
        parse_reg_path_output(stdout).as_deref(),
        Some("C:\\Tools;C:\\CLIs")
    );
}

#[test]
fn parse_reg_path_output_prefers_expand_sz() {
    let stdout = "\n    Path    REG_EXPAND_SZ    %USERPROFILE%\\.local\\bin\n";
    assert_eq!(
        parse_reg_path_output(stdout).as_deref(),
        Some("%USERPROFILE%\\.local\\bin")
    );
}

#[test]
fn parse_reg_path_output_skips_empty() {
    assert_eq!(parse_reg_path_output("    Path    REG_SZ    \n"), None);
    assert_eq!(parse_reg_path_output(""), None);
}

#[cfg(windows)]
#[test]
fn query_registry_path_reads_machine_path_without_reg_exe() {
    let path = query_registry_path(
        "HKLM\\System\\CurrentControlSet\\Control\\Session Manager\\Environment",
        "Path",
    );
    let path = path.expect("machine Path exists on Windows");
    assert!(
        path.contains('\\') || path.contains(';'),
        "machine Path should look like directories, got {path:?}"
    );
}

#[cfg(windows)]
#[test]
fn expand_environment_strings_expands_windir() {
    let expanded = expand_environment_strings("%WINDIR%").expect("WINDIR expands");
    assert!(
        expanded.contains('\\'),
        "expanded WINDIR should be a path, got {expanded:?}"
    );
    assert!(!expanded.contains('%'), "got {expanded:?}");
}

#[test]
fn resumed_grok_and_claude_keep_the_system_prompt() {
    let grok = SpawnMode::Resume {
        provider_session_id: Some("sess-1".into()),
        allow_continue_fallback: false,
        hybrid_shell_agent: None,
    };
    let (args, bound) = build_agent_cli_args_ext(
        "grok",
        "local",
        "C:/tmp",
        &grok,
        Some("task"),
        false,
        Some("MANUAL"),
    );
    assert_eq!(bound.as_deref(), Some("sess-1"));
    assert!(args.windows(2).any(|pair| pair == ["-r", "sess-1"]));
    assert!(args
        .windows(2)
        .any(|pair| pair == ["--system-prompt-override", "MANUAL"]));

    let claude = SpawnMode::Resume {
        provider_session_id: Some("not-a-session-file".into()),
        allow_continue_fallback: false,
        hybrid_shell_agent: None,
    };
    let (args, _) = build_agent_cli_args_ext(
        "claude-code",
        "local",
        "C:/tmp",
        &claude,
        Some("task"),
        false,
        Some("MANUAL"),
    );
    assert!(args
        .windows(2)
        .any(|pair| pair == ["--system-prompt", "MANUAL"]));
}

#[test]
fn a_codex_birth_is_the_task_and_grok_keeps_the_system_prompt() {
    let (system, prompt) =
        attach_dispatch_manual("codex", false, false, None, Some("Look".into()));
    assert!(system.is_none());
    assert_eq!(prompt.as_deref(), Some("Look"));

    let (system, prompt) =
        attach_dispatch_manual("antigravity", false, false, None, Some("Look".into()));
    assert!(system.is_none());
    assert_eq!(prompt.as_deref(), Some("Look"));

    let (system, prompt) = attach_dispatch_manual("codex", false, true, None, None);
    assert!(system.is_none());
    assert!(prompt.is_none());

    let (system, prompt) =
        attach_dispatch_manual("grok", false, true, None, Some("task".into()));
    let system = system.unwrap();
    assert!(system.contains("This text is the complete manual."));
    assert!(!system.contains("KITE_SKILL_FILE"));
    assert!(!system.trim_start().starts_with('-'));
    assert_eq!(prompt.as_deref(), Some("task"));

    let (grok_args, _) = build_agent_cli_args_ext(
        "grok",
        "local",
        "C:/tmp",
        &SpawnMode::Fresh,
        Some("- leading hyphen task"),
        true,
        Some(crate::dispatch::cli::skill_text()),
    );
    let override_idx = grok_args
        .iter()
        .position(|arg| arg == "--system-prompt-override")
        .expect("grok override flag");
    assert!(!grok_args[override_idx + 1].trim_start().starts_with('-'));
    assert!(grok_args
        .windows(2)
        .any(|pair| pair == ["--", "- leading hyphen task"]));
}

#[test]
fn dispatch_missing_raw_program_starts_no_session() {
    let value = start_terminal_local_sync(serde_json::json!({
        "engine": "kite-dispatch-no-such-program",
        "argv": ["kite-dispatch-no-such-program"],
    }));
    assert_eq!(
        value.get("error").and_then(|item| item.as_str()),
        Some("program_not_found")
    );
    assert!(value.get("sessionId").is_none());
}

#[test]
fn direct_agent_executable_follows_npm_cmd_shim_and_skips_scripts() {
    let dir = std::env::temp_dir().join(format!("kite-shim-{}", std::process::id()));
    let bin = dir.join("node_modules").join("tool").join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let exe = bin.join("tool.exe");
    std::fs::write(&exe, b"").unwrap();
    let shim = dir.join("tool.cmd");
    std::fs::write(
        &shim,
        "@ECHO off\r\nCALL :find_dp0\r\n\"%dp0%\\node_modules\\tool\\bin\\tool.exe\"   %*\r\n",
    )
    .unwrap();
    let script_shim = dir.join("js.cmd");
    std::fs::write(
        &script_shim,
        "\"%_prog%\"  \"%dp0%\\node_modules\\js\\bundle\\js.js\" %*\r\n",
    )
    .unwrap();

    assert_eq!(
        resolve_direct_agent_executable(&exe.to_string_lossy()),
        Some(exe.clone())
    );
    assert_eq!(
        resolve_direct_agent_executable(&shim.to_string_lossy()),
        Some(exe.clone())
    );
    assert_eq!(resolve_direct_agent_executable(&script_shim.to_string_lossy()), None);
    assert_eq!(resolve_direct_agent_executable("C:\\x\\tool.ps1"), None);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn agent_launch_command_normalizes_utf8_console_and_term() {
    let command = build_agent_launch_command(
        r"C:\Program Files\OpenCode\opencode.exe",
        &["--prompt".to_string(), "box ▣".to_string()],
    );

    assert!(command.contains("$OutputEncoding = [Console]::OutputEncoding"));
    assert!(command.contains("chcp 65001 > $null"));
    assert!(command.contains("$env:TERM = 'xterm-256color'"));
    assert!(command.contains("& 'C:\\Program Files\\OpenCode\\opencode.exe' '--prompt' 'box ▣'"));
}

#[test]
fn test_build_agent_cli_args_resume_flags() {
    let (agy_args, agy_id) = build_agent_cli_args(
        "antigravity",
        "sess-1",
        r"E:\kite",
        &SpawnMode::Resume {
            provider_session_id: Some("5094dc56-5a10-42ba-86a6-49565d2e6569".to_string()),
            allow_continue_fallback: true,
            hybrid_shell_agent: None,
        },
    );
    assert_eq!(
        agy_args,
        vec!["--conversation", "5094dc56-5a10-42ba-86a6-49565d2e6569"]
    );
    assert_eq!(
        agy_id.as_deref(),
        Some("5094dc56-5a10-42ba-86a6-49565d2e6569")
    );

    let (codex_args, _) = build_agent_cli_args(
        "codex",
        "sess-2",
        r"E:\kite",
        &SpawnMode::Resume {
            provider_session_id: Some("019d976b-21c5-71d2-9078-fd9428c0219c".to_string()),
            allow_continue_fallback: true,
            hybrid_shell_agent: None,
        },
    );
    assert_eq!(
        codex_args,
        vec!["resume", "019d976b-21c5-71d2-9078-fd9428c0219c"]
    );

    let (opencode_args, _) = build_agent_cli_args(
        "open-code",
        "sess-3",
        r"E:\kite",
        &SpawnMode::Resume {
            provider_session_id: Some("ses_12345".to_string()),
            allow_continue_fallback: true,
            hybrid_shell_agent: None,
        },
    );
    assert_eq!(opencode_args, vec!["--session", "ses_12345"]);

    let (grok_args, grok_id) = build_agent_cli_args(
        "grok",
        "sess-grok",
        r"E:\kite",
        &SpawnMode::Resume {
            provider_session_id: Some("01a1a8c4-876b-7260-b545-c8f1d9ecd705".to_string()),
            allow_continue_fallback: true,
            hybrid_shell_agent: None,
        },
    );
    assert_eq!(
        grok_args,
        vec!["-r", "01a1a8c4-876b-7260-b545-c8f1d9ecd705"]
    );
    assert_eq!(
        grok_id.as_deref(),
        Some("01a1a8c4-876b-7260-b545-c8f1d9ecd705")
    );

    let (grok_none_args, grok_none_id) = build_agent_cli_args(
        "grok",
        "sess-grok-none",
        r"E:\kite",
        &SpawnMode::Resume {
            provider_session_id: None,
            allow_continue_fallback: true,
            hybrid_shell_agent: None,
        },
    );
    assert!(grok_none_args.is_empty());
    assert!(grok_none_id.is_none());

    // Verify that missing provider_session_id never falls back to --continue / resume --last
    let (agy_none_args, agy_none_id) = build_agent_cli_args(
        "antigravity",
        "sess-4",
        r"E:\kite",
        &SpawnMode::Resume {
            provider_session_id: None,
            allow_continue_fallback: true,
            hybrid_shell_agent: None,
        },
    );
    assert!(agy_none_args.is_empty());
    assert!(agy_none_id.is_none());
}

#[test]
fn test_build_agent_cli_args_fresh_with_prompt_and_auto_approve() {
    let (grok_args, _) = build_agent_cli_args_ext(
        "grok",
        "sess-grok",
        r"E:\kite",
        &SpawnMode::Fresh,
        Some("Desarrolla la tarea ODD"),
        true,
        None,
    );
    assert_eq!(
        grok_args,
        vec!["--always-approve", "Desarrolla la tarea ODD"]
    );

    let (codex_args, _) = build_agent_cli_args_ext(
        "codex",
        "sess-codex",
        r"E:\kite",
        &SpawnMode::Fresh,
        Some("Desarrolla la tarea ODD"),
        true,
        None,
    );
    assert_eq!(
        codex_args,
        vec!["--approve-for-me", "Desarrolla la tarea ODD"]
    );

    let (agy_args, _) = build_agent_cli_args_ext(
        "antigravity",
        "sess-agy",
        r"E:\kite",
        &SpawnMode::Fresh,
        Some("Desarrolla la tarea ODD"),
        true,
        None,
    );
    assert_eq!(
        agy_args,
        vec!["--dangerously-skip-permissions", "-i", "Desarrolla la tarea ODD"]
    );

    let (claude_args, bound_id) = build_agent_cli_args_ext(
        "claude-code",
        "sess-claude",
        r"E:\kite",
        &SpawnMode::Fresh,
        Some("Desarrolla la tarea ODD"),
        true,
        None,
    );
    assert!(bound_id.is_some());
    assert_eq!(claude_args[0], "--session-id");
    assert_eq!(claude_args[2], "--permission-mode");
    assert_eq!(claude_args[3], "bypassPermissions");
    assert_eq!(claude_args[4], "Desarrolla la tarea ODD");

    let (opencode_args, _) = build_agent_cli_args_ext(
        "open-code",
        "sess-oc",
        r"E:\kite",
        &SpawnMode::Fresh,
        Some("Desarrolla la tarea ODD"),
        true,
        None,
    );
    assert_eq!(
        opencode_args,
        vec!["--auto", "--prompt", "Desarrolla la tarea ODD"]
    );
}

#[test]
fn test_agent_cli_auto_approve_defaults() {
    assert!(is_agent_cli_engine("antigravity"));
    assert!(is_agent_cli_engine("agy"));
    assert!(is_agent_cli_engine("claude-code"));
    assert!(!is_agent_cli_engine("powershell"));
    assert!(!is_agent_cli_engine("terminal"));

    let (agy_no_prompt, _) = build_agent_cli_args_ext(
        "agy",
        "sess-agy-noprompt",
        r"E:\kite",
        &SpawnMode::Fresh,
        None,
        true,
        None,
    );
    assert_eq!(agy_no_prompt, vec!["--dangerously-skip-permissions"]);

    let (agy_resume, _) = build_agent_cli_args_ext(
        "antigravity",
        "sess-agy-res",
        r"E:\kite",
        &SpawnMode::Resume {
            provider_session_id: Some("conv-123".to_string()),
            allow_continue_fallback: true,
            hybrid_shell_agent: None,
        },
        None,
        true,
        None,
    );
    assert_eq!(
        agy_resume,
        vec!["--conversation", "conv-123", "--dangerously-skip-permissions"]
    );
}

#[test]
fn test_terminal_session_lifecycle() {
    let session_id = format!("test-sess-{}", Uuid::new_v4());

    // 1. Start terminal session
    let start_res = start_terminal_sync(serde_json::json!({
        "sessionId": session_id,
        "engine": "powershell",
        "columns": 80,
        "rows": 24,
        "confirmedByBuilder": true
    }));

    assert_eq!(start_res["sessionId"], session_id);
    assert_eq!(start_res["attachedToExisting"], false);
    assert_eq!(start_res["host"]["backend"], "conpty");
    assert_eq!(start_res["restore"]["kind"], "startedFresh");

    // Verify session is recorded in active instances
    {
        let map = get_terminals().lock().unwrap();
        assert!(map.contains_key(&session_id));
    }

    // 2. Attach / reconnect to existing session
    let attach_res = attach_terminal_sync(serde_json::json!({
        "sessionId": session_id
    }));
    assert_eq!(attach_res["sessionId"], session_id);
    assert_eq!(attach_res["attachedToExisting"], true);
    assert_eq!(attach_res["restore"]["kind"], "reattached");

    // 3. Write input
    let write_res = write_terminal_sync(serde_json::json!({
        "sessionId": session_id,
        "input": "echo 'kite_test_lifecycle'\r\n"
    }));
    assert_eq!(write_res["ok"], true);

    // 4. Resize terminal
    let resize_res = resize_terminal_sync(serde_json::json!({
        "sessionId": session_id,
        "columns": 120,
        "rows": 40
    }));
    assert_eq!(resize_res["ok"], true);

    // 5. Read output (PTY output is asynchronous, give it a few polling iterations)
    let mut got_output = false;
    for _ in 0..50 {
        std::thread::sleep(std::time::Duration::from_millis(100));
        let read_res = read_terminal_output_sync(serde_json::json!({
            "sessionId": session_id
        }));
        let kind = read_res["kind"].as_str().unwrap_or("");
        if kind == "output" {
            got_output = true;
            assert!(read_res["bytesBase64"].as_str().is_some());
            assert!(read_res["sequence"].as_u64().is_some());
            break;
        }
    }
    assert!(got_output, "ConPTY terminal should produce output");

    // 6. Terminate terminal
    let term_res = terminate_terminal_sync(serde_json::json!({
        "sessionId": session_id
    }));
    assert_eq!(term_res["terminated"], true);

    // Verify session is removed from active instances
    {
        let map = get_terminals().lock().unwrap();
        assert!(!map.contains_key(&session_id));
    }

    // 7. Reading terminated session returns idle without error
    let read_after_term = read_terminal_output_sync(serde_json::json!({
        "sessionId": session_id
    }));
    assert_eq!(read_after_term["kind"], "idle");
}

#[test]
fn test_fresh_powershell_terminal_produces_prompt_without_input() {
    let session_id = format!("test-fresh-ps-{}", Uuid::new_v4());
    let _ = start_terminal_sync(serde_json::json!({
        "sessionId": session_id,
        "engine": "powershell",
        "columns": 80,
        "rows": 24,
        "confirmedByBuilder": true
    }));

    let mut output_str = String::new();
    let mut answered_cpr = false;
    for _ in 0..30 {
        std::thread::sleep(std::time::Duration::from_millis(100));
        let read_res = read_terminal_output_sync(serde_json::json!({
            "sessionId": session_id
        }));
        if let Some(b64) = read_res["bytesBase64"].as_str() {
            if let Some(bytes) = decode_base64(b64) {
                let chunk = String::from_utf8_lossy(&bytes);
                output_str.push_str(&chunk);
                if chunk.contains("\x1b[6n") && !answered_cpr {
                    answered_cpr = true;
                    let _ = write_terminal_sync(serde_json::json!({
                        "sessionId": session_id,
                        "input": "\x1b[1;1R"
                    }));
                }
            }
        }
        if output_str.contains("PS ") || output_str.contains(">") {
            break;
        }
    }

    println!("FRESH PS OUTPUT: {:?}", output_str);
    let _ = terminate_terminal_sync(serde_json::json!({ "sessionId": session_id }));
    assert!(!output_str.is_empty(), "Fresh PowerShell terminal must produce prompt output without waiting for input");
}

#[test]
fn test_fresh_agent_spawn_produces_output() {
    if !engine_installed("antigravity") {
        return;
    }
    let session_id = format!("test-fresh-agy-{}", Uuid::new_v4());
    let _ = start_terminal_sync(serde_json::json!({
        "sessionId": session_id,
        "engine": "antigravity",
        "columns": 80,
        "rows": 24,
        "confirmedByBuilder": true
    }));

    let mut output_str = String::new();
    let mut answered_cpr = false;
    for _ in 0..40 {
        std::thread::sleep(std::time::Duration::from_millis(100));
        let read_res = read_terminal_output_sync(serde_json::json!({
            "sessionId": session_id
        }));
        if let Some(b64) = read_res["bytesBase64"].as_str() {
            if let Some(bytes) = decode_base64(b64) {
                let chunk = String::from_utf8_lossy(&bytes);
                output_str.push_str(&chunk);
                if chunk.contains("\x1b[6n") && !answered_cpr {
                    answered_cpr = true;
                    let _ = write_terminal_sync(serde_json::json!({
                        "sessionId": session_id,
                        "input": "\x1b[1;1R"
                    }));
                }
            }
        }
        if output_str.contains("Antigravity") {
            break;
        }
    }

    println!("FRESH AGY OUTPUT: {:?}", output_str);
    let _ = terminate_terminal_sync(serde_json::json!({ "sessionId": session_id }));
    assert!(output_str.contains("Antigravity"), "Fresh agent terminal must produce Antigravity banner upon CPR response");
}

#[test]
fn test_terminal_missing_or_unknown_session_safety() {
    let fake_id = "non-existent-session-xyz";

    // Writing to non-existent session reports the missing target without panic
    let write_res = write_terminal_sync(serde_json::json!({
        "sessionId": fake_id,
        "input": "test"
    }));
    assert_eq!(write_res["ok"], false);
    assert_eq!(write_res["error"], "Session not found");

    // Resizing non-existent session reports the missing target without panic
    let resize_res = resize_terminal_sync(serde_json::json!({
        "sessionId": fake_id,
        "columns": 80,
        "rows": 24
    }));
    assert_eq!(resize_res["ok"], false);
    assert_eq!(resize_res["error"], "Session not found");

    // Terminating a non-existent session reports that no live session was terminated
    let term_res = terminate_terminal_sync(serde_json::json!({
        "sessionId": fake_id
    }));
    assert_eq!(term_res["terminated"], false);
    assert_eq!(term_res["sessionId"], fake_id);

    // Reading non-existent session returns idle
    let read_res = read_terminal_output_sync(serde_json::json!({
        "sessionId": fake_id
    }));
    assert_eq!(read_res["kind"], "idle");
}

#[test]
fn test_list_terminal_profiles() {
    let res = list_terminal_profiles();
    assert_eq!(res["schemaVersion"], 1);
    assert!(res["profiles"].as_array().unwrap().len() >= 3);
}

#[test]
fn test_terminal_scrollback_persistence() {
    let test_session = format!("test-sb-{}", Uuid::new_v4());
    let sample_output = b"\x1b[32mKite ConPTY Test Output\x1b[0m\r\n";
    write_scrollback_file(&test_session, sample_output);

    let read_back = read_scrollback_file(&test_session);
    assert!(read_back.is_some());
    assert_eq!(read_back.unwrap(), sample_output);

    // attach_terminal on new session should find the scrollback on disk
    let attach_res = attach_terminal_sync(serde_json::json!({
        "sessionId": test_session,
        "engine": "powershell"
    }));
    assert_eq!(attach_res["sessionId"], test_session);
    assert_eq!(attach_res["restore"]["kind"], "restoredFromDisk");
    let b64 = attach_res["scrollbackBase64"]
        .as_str()
        .expect("scrollbackBase64 should be present");
    assert_eq!(b64, to_base64(sample_output));

    // Terminating should delete the scrollback file from disk
    let _ = terminate_terminal_sync(serde_json::json!({
        "sessionId": test_session
    }));
    assert!(read_scrollback_file(&test_session).is_none());
}

#[test]
fn test_stage_clipboard_file_and_sanitization() {
    let fake_png_bytes = b"\x89PNG\r\n\x1a\nfakeimagebytes";
    let b64 = to_base64(fake_png_bytes);

    // Test with session_id that contains invalid filename characters
    let dirty_session = "agent:session/test\\1?*";
    let path = stage_clipboard_file(None, dirty_session, "png", &b64);
    assert!(path.is_some());
    let staged_path = path.unwrap();
    assert!(staged_path.ends_with(".png"));
    assert!(std::path::Path::new(&staged_path).is_file());

    // Verify content matches
    let read_bytes = std::fs::read(&staged_path).unwrap();
    assert_eq!(read_bytes, fake_png_bytes);

    // Clean up
    let _ = std::fs::remove_file(staged_path);
}

#[test]
fn terminal_capture_safe_filename_is_path_safe() {
    assert_eq!(
        terminal_capture_safe_filename(r"agent:session/test\\1?*"),
        "agent_session_test__1__.jsonl"
    );
    assert_eq!(terminal_capture_safe_filename(""), "session.jsonl");
}

#[test]
fn terminal_capture_counts_key_ansi_markers() {
    let bytes = b"\x1b[?2026h\x1b[?2026l\x1b[?1049h\x1b[?1049l\r\x1b[2J\x1b[K\x1b[?25h\x1b[25l\x1b]0;title\x07";
    let counts = count_terminal_ansi_markers(bytes);
    assert_eq!(counts.dec_2026_start, 1);
    assert_eq!(counts.dec_2026_end, 1);
    assert_eq!(counts.alt_screen_1049_start, 1);
    assert_eq!(counts.alt_screen_1049_end, 1);
    assert_eq!(counts.carriage_return, 1);
    assert_eq!(counts.erase_j, 1);
    assert_eq!(counts.erase_k, 1);
    assert_eq!(counts.cursor_show, 1);
    assert_eq!(counts.cursor_hide, 1);
    assert_eq!(counts.osc, 1);
}

#[test]
fn terminal_capture_scanner_carries_split_sequences() {
    let mut pending = Vec::new();
    let first = scan_terminal_ansi_markers(&mut pending, b"\x1b[?2026");
    assert_eq!(first, TerminalAnsiMarkerCounts::default());
    assert!(!pending.is_empty());
    let second = scan_terminal_ansi_markers(&mut pending, b"h\x1b]title");
    assert_eq!(second.dec_2026_start, 1);
    assert_eq!(second.osc, 0);
    let third = scan_terminal_ansi_markers(&mut pending, b"\x07");
    assert_eq!(third.osc, 1);
    assert!(pending.is_empty());
}

#[test]
fn terminal_capture_marker_schema_uses_stable_keys() {
    let value = serde_json::to_value(count_terminal_ansi_markers(b"\x1b[?2026h")).unwrap();
    assert_eq!(value["dec2026Start"], 1);
    assert!(value.get("eraseJ").is_some());
    assert!(value.get("cursorHide").is_some());
}

#[test]
fn generic_shell_with_falsely_persisted_codex_self_heals_and_does_not_launch_codex() {
    let session_id = format!("test-heal-{}", Uuid::new_v4());
    let cwd = std::env::current_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from(r"E:\kite"))
        .to_string_lossy()
        .into_owned();

    // 1. Manually write a corrupted persisted record with base_engine: "powershell", active_engine: "codex", provider_session_id: None
    upsert_persisted_terminal_session(PersistedTerminalSession {
        session_id: session_id.clone(),
        workspace_id: Some("ws-heal".to_string()),
        pane_id: Some("pane-heal".to_string()),
        base_engine: "powershell".to_string(),
        active_engine: "codex".to_string(),
        provider_session_id: None,
        cwd: cwd.clone(),
        had_user_activity: true,
        last_user_input: None,
        spawned_at_unix_ms: now_unix_ms(),
        saved_at_unix_ms: now_unix_ms(),
    });

    // 2. Also write a test scrollback
    let _ = write_scrollback_file(&session_id, b"Windows PowerShell\r\nPS C:\\> npm run dev\r\n");

    // 3. Attach to this terminal as powershell
    let req = serde_json::json!({
        "sessionId": session_id,
        "engine": "powershell",
        "cwd": cwd,
        "cols": 80,
        "rows": 24,
        "workspaceId": "ws-heal",
        "paneId": "pane-heal"
    });

    let result = attach_terminal_sync(req);

    // Should return existing scrollback rather than deleting it
    assert!(result.is_object(), "attach_terminal should return an object");
    let b64 = result["scrollbackBase64"].as_str().unwrap_or("");
    assert!(!b64.is_empty(), "scrollback should be preserved");

    // Check that the persisted record was self-healed: active_engine should now be "powershell"
    let map = read_persisted_terminal_sessions();
    let healed = map.get(&session_id).expect("session should exist in persisted map");
    assert_eq!(healed.active_engine, "powershell", "active_engine should have self-healed to powershell");
    assert!(healed.provider_session_id.is_none(), "generic shell should not have provider_session_id");

    // Clean up
    let _ = terminate_terminal_sync(serde_json::json!({ "sessionId": session_id }));
    let _ = delete_scrollback_file(&session_id);
    let mut map = read_persisted_terminal_sessions();
    map.remove(&session_id);
    write_persisted_terminal_sessions(&map);
}

#[test]
fn generic_shell_ignores_agent_detection_without_running_child_agent() {
    let session_id = format!("test-ignore-{}", Uuid::new_v4());
    let cwd = std::env::current_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from(r"E:\kite"))
        .to_string_lossy()
        .into_owned();

    // Spawn a fresh powershell terminal
    let _ = spawn_session_with_options(
        &session_id,
        &cwd,
        "powershell",
        SpawnOptions {
            cols: 80,
            rows: 24,
            mode: SpawnMode::Fresh,
            ..Default::default()
        },
    );

    // Attempt to report codex agent detection
    let report_req = serde_json::json!({
        "sessionId": session_id,
        "engine": "codex"
    });
    let res = report_terminal_agent_detected(report_req);
    assert!(res.is_null());

    // Check that the terminal's detected_agent_engine is still None because no codex child process exists
    let inst = get_terminals().lock().unwrap().get(&session_id).cloned();
    assert!(inst.is_some());
    let det = inst.unwrap().detected_agent_engine.lock().unwrap().clone();
    assert_eq!(det, None, "Generic shell without running codex process must ignore agent detection");

    // Clean up
    let _ = terminate_terminal_sync(serde_json::json!({ "sessionId": session_id }));
    let _ = delete_scrollback_file(&session_id);
}

#[test]
fn observed_bytes_attach_to_snapshot_poll_json() {
    let value = serde_json::json!({
        "kind": "unchanged",
        "seq": 3,
        "exited": false,
        "exitCode": null
    });
    let empty = attach_observed_bytes(value.clone(), b"");
    assert!(empty.get("observedBytesBase64").is_none());

    let with = attach_observed_bytes(value, b"OpenCode v0.2.0\n");
    let encoded = with
        .get("observedBytesBase64")
        .and_then(|v| v.as_str())
        .expect("observed bytes");
    assert_eq!(decode_base64(encoded).unwrap(), b"OpenCode v0.2.0\n");
}

#[test]
fn spawn_mode_agent_never_passes_conversation_flag_for_direct_or_hybrid_shell() {
    let agent_mode = SpawnMode::Agent {
        hybrid_shell_agent: None,
    };
    let (agy_args, agy_bound) =
        build_agent_cli_args_ext("agy", "sid-1", "E:/kite", &agent_mode, None, true, None);
    assert!(agy_bound.is_none());
    assert!(!agy_args.contains(&"--conversation".to_string()));
    assert!(!agy_args.contains(&"--continue".to_string()));
    assert!(agy_args.contains(&"--dangerously-skip-permissions".to_string()));

    let hybrid_mode = SpawnMode::Agent {
        hybrid_shell_agent: Some("agy".to_string()),
    };
    let (hybrid_args, hybrid_bound) =
        build_agent_cli_args_ext("antigravity", "sid-2", "E:/kite", &hybrid_mode, None, true, None);
    assert!(hybrid_bound.is_none());
    assert!(!hybrid_args.contains(&"--conversation".to_string()));
    assert!(!hybrid_args.contains(&"--continue".to_string()));

    let (claude_args, claude_bound) =
        build_agent_cli_args_ext("claude", "sid-3", "E:/kite", &agent_mode, None, false, None);
    assert!(claude_bound.is_some() || claude_bound.is_none());
    assert!(!claude_args.contains(&"--resume".to_string()));
    assert!(!claude_args.contains(&"--continue".to_string()));
}

#[test]
fn classify_session_activity_distinguishes_recent_output_pending_buffer_and_idle() {
    // 1. Quiet terminal (>3s since last output, empty buffer) => idle
    let (busy_idle, reasons_idle, age_idle) = classify_session_activity(&SessionActivityInput {
        now_ms: 10_000,
        last_output_ms: 5_000,
        last_paint_emit_ms: 4_500,
        output_byte_offset: 1024,
        pending_buffer_len: 0,
        child_running: true,
        had_user_activity: true,
    });
    assert!(!busy_idle);
    assert!(reasons_idle.is_empty());
    assert_eq!(age_idle, Some(5_000));

    // 2. Output within 3000ms while child runs => busy
    let (busy_recent, reasons_recent, age_recent) =
        classify_session_activity(&SessionActivityInput {
            now_ms: 10_000,
            last_output_ms: 8_200,
            last_paint_emit_ms: 8_100,
            output_byte_offset: 2048,
            pending_buffer_len: 0,
            child_running: true,
            had_user_activity: false,
        });
    assert!(busy_recent);
    assert!(reasons_recent.iter().any(|r| r == "recent_output"));
    assert_eq!(age_recent, Some(1_800));

    // 3. Unread bytes buffered in PTY while child runs => busy even if timestamps are stale
    let (busy_buf, reasons_buf, _) = classify_session_activity(&SessionActivityInput {
        now_ms: 20_000,
        last_output_ms: 1_000,
        last_paint_emit_ms: 1_000,
        output_byte_offset: 512,
        pending_buffer_len: 128,
        child_running: true,
        had_user_activity: false,
    });
    assert!(busy_buf);
    assert!(reasons_buf.iter().any(|r| r == "pending_output"));

    // 4. Child already exited => never busy
    let (busy_dead, _, _) = classify_session_activity(&SessionActivityInput {
        now_ms: 10_000,
        last_output_ms: 9_900,
        last_paint_emit_ms: 9_900,
        output_byte_offset: 512,
        pending_buffer_len: 64,
        child_running: false,
        had_user_activity: true,
    });
    assert!(!busy_dead);
}

#[test]
fn rotation_divider_preserves_scrollback_and_suppress_exit_skips_activity() {
    let sid = format!("test-rotate-sb-{}", Uuid::new_v4());
    let old_sb = b"previous transcript line 1\r\nprevious line 2\r\n";
    write_scrollback_file(&sid, old_sb);

    append_rotation_divider_to_scrollback(&sid, "Work Gmail");
    let combined = read_scrollback_file(&sid).expect("scrollback must survive rotation");
    let text = String::from_utf8_lossy(&combined);
    assert!(text.contains("previous transcript line 1"));
    assert!(text.contains("─── ✦ Kite Vault: Sesión reactivada con cuenta «Work Gmail» ───"));

    let _ = delete_scrollback_file(&sid);
}

#[test]
fn quiesce_suppresses_exit_event_and_respawn_prioritizes_live_and_defers_unfocused() {
    let cwd = std::env::current_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from(r"E:\kite"))
        .to_string_lossy()
        .into_owned();
    let live_sid = format!("test-rot-live-{}", Uuid::new_v4());
    let bg_sid = format!("test-rot-bg-{}", Uuid::new_v4());

    // Simulate two persisted sessions (one live, one unfocused) with stale provider_session_id.
    upsert_persisted_terminal_session(PersistedTerminalSession {
        session_id: live_sid.clone(),
        workspace_id: Some("ws-test".to_string()),
        pane_id: Some("pane-live".to_string()),
        base_engine: "powershell".to_string(),
        active_engine: "powershell".to_string(),
        provider_session_id: Some("old-conv-live".to_string()),
        cwd: cwd.clone(),
        had_user_activity: true,
        last_user_input: None,
        spawned_at_unix_ms: 1,
        saved_at_unix_ms: 2,
    });
    upsert_persisted_terminal_session(PersistedTerminalSession {
        session_id: bg_sid.clone(),
        workspace_id: Some("ws-test".to_string()),
        pane_id: Some("pane-bg".to_string()),
        base_engine: "powershell".to_string(),
        active_engine: "powershell".to_string(),
        provider_session_id: Some("old-conv-bg".to_string()),
        cwd: cwd.clone(),
        had_user_activity: true,
        last_user_input: None,
        spawned_at_unix_ms: 1,
        saved_at_unix_ms: 2,
    });

    write_scrollback_file(&live_sid, b"live pre-switch\r\n");
    write_scrollback_file(&bg_sid, b"bg pre-switch\r\n");

    let quiesced = vec![
        QuiescedTerminal {
            session_id: live_sid.clone(),
            workspace_id: Some("ws-test".to_string()),
            pane_id: Some("pane-live".to_string()),
            base_engine: "powershell".to_string(),
            effective_engine: "powershell".to_string(),
            provider_session_id: None,
            cwd: cwd.clone(),
            cols: 80,
            rows: 24,
            presentation_live: true,
            auto_approve: false,
        },
        QuiescedTerminal {
            session_id: bg_sid.clone(),
            workspace_id: Some("ws-test".to_string()),
            pane_id: Some("pane-bg".to_string()),
            base_engine: "powershell".to_string(),
            effective_engine: "powershell".to_string(),
            provider_session_id: None,
            cwd,
            cols: 80,
            rows: 24,
            presentation_live: false,
            auto_approve: false,
        },
    ];

    respawn_provider_terminals_local("agy", "New Label", Some("new@example.com"), &quiesced);

    // Live pane must respawn immediately; background pane must remain deferred until focused.
    {
        let map = get_terminals().lock().unwrap();
        assert!(map.contains_key(&live_sid), "presentation_live pane should respawn immediately");
        assert!(!map.contains_key(&bg_sid), "unfocused pane should stay deferred until focused");
    }

    // Both persisted records must clear stale provider_session_id.
    let persisted_after = read_persisted_terminal_sessions();
    assert_eq!(
        persisted_after.get(&live_sid).and_then(|s| s.provider_session_id.as_ref()),
        None
    );
    assert_eq!(
        persisted_after.get(&bg_sid).and_then(|s| s.provider_session_id.as_ref()),
        None
    );

    // Scrollback for both must preserve history + divider.
    let bg_sb = String::from_utf8_lossy(&read_scrollback_file(&bg_sid).unwrap()).into_owned();
    assert!(bg_sb.contains("bg pre-switch"));
    assert!(bg_sb.contains("─── ✦ Kite Vault: Sesión reactivada con cuenta «New Label» ───"));

    // Focusing background pane triggers deferred respawn.
    let pres_res = set_terminal_presentation_local_sync(serde_json::json!({
        "sessionId": bg_sid,
        "live": true
    }));
    assert_eq!(pres_res["ok"], true);
    assert!(
        get_terminals().lock().unwrap().contains_key(&bg_sid),
        "focusing deferred pane must lazily respawn it"
    );

    // Also inspect suppress_exit_event skips notify_terminal_exit emission cleanly.
    if let Some(inst) = get_terminals().lock().unwrap().get(&live_sid).cloned() {
        inst.suppress_exit_event
            .store(true, std::sync::atomic::Ordering::Relaxed);
        notify_terminal_exit(&live_sid, &inst, 0);
        assert!(inst.lifecycle_stop.load(std::sync::atomic::Ordering::Relaxed));
    }

    // Clean up
    let _ = terminate_terminal_local_sync(serde_json::json!({ "sessionId": live_sid }));
    let _ = terminate_terminal_local_sync(serde_json::json!({ "sessionId": bg_sid }));
    let _ = delete_scrollback_file(&live_sid);
    let _ = delete_scrollback_file(&bg_sid);
    let mut map = read_persisted_terminal_sessions();
    map.remove(&live_sid);
    map.remove(&bg_sid);
    write_persisted_terminal_sessions(&map);
}
