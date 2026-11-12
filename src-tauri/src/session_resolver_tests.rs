    use super::*;

    #[test]
    fn normalizes_paths_and_file_uris_consistently() {
        assert!(paths_match(r"E:\kite\", "e:/kite"));
        assert!(paths_match(r"\\?\E:\kite", "E:/kite"));
        assert_eq!(
            path_to_file_uri_normalized(r"E:\kite\"),
            "file:///e:/kite"
        );
    }

    #[test]
    fn computes_claude_project_slug_accurately() {
        assert_eq!(claude_project_slug(r"E:\kite"), "E--kite");
        assert_eq!(
            claude_project_slug(r"\\?\C:\Users\PC\my_repo"),
            "C--Users-PC-my-repo"
        );
    }

    #[test]
    fn grok_encode_cwd_matches_javascript_encode_uri_component() {
        assert_eq!(grok_encode_cwd(r"E:\kite"), "E%3A%5Ckite");
        assert_eq!(grok_encode_cwd("/home/user/kite"), "%2Fhome%2Fuser%2Fkite");
    }

    #[test]
    fn grok_rfc3339_epoch_is_zero() {
        assert_eq!(grok_rfc3339_to_unix_ms("1970-01-01T00:00:00Z"), Some(0));
    }

    #[test]
    fn resolve_grok_picks_unclaimed_cwd_session_closest_to_spawn() {
        let home = std::env::temp_dir().join(format!("kite-grok-home-{}", uuid::Uuid::new_v4()));
        let root = home.join("sessions").join(grok_encode_cwd(r"E:\kite"));
        let older = "11111111-1111-1111-1111-111111111111";
        let closer = "22222222-2222-2222-2222-222222222222";
        let claimed = "33333333-3333-3333-3333-333333333333";
        std::fs::create_dir_all(root.join(older)).unwrap();
        std::fs::create_dir_all(root.join(closer)).unwrap();
        std::fs::create_dir_all(root.join(claimed)).unwrap();
        let write_summary = |id: &str, created: &str| {
            let body = serde_json::json!({
                "info": { "id": id, "cwd": r"E:\kite" },
                "created_at": created,
                "last_active_at": created,
                "generated_title": "demo",
                "session_summary": "demo"
            });
            std::fs::write(root.join(id).join("summary.json"), body.to_string()).unwrap();
        };
        write_summary(older, "2026-11-04T20:00:00Z");
        write_summary(closer, "2026-11-04T22:53:34Z");
        write_summary(claimed, "2026-11-04T22:53:30Z");
        let mut taken = HashSet::new();
        taken.insert(claimed.to_string());
        let spawned = grok_rfc3339_to_unix_ms("2026-11-04T22:53:34Z").unwrap();
        let picked = resolve_grok_session_id_from_home(
            &home,
            r"E:\kite",
            "term-missing",
            spawned,
            &taken,
            None,
        );
        assert_eq!(picked.as_deref(), Some(closer));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn grok_owned_session_id_matches_only_this_process_tree() {
        let owners = vec![
            GrokActiveOwner {
                session_id: "owned".to_string(),
                pid: 42,
            },
            GrokActiveOwner {
                session_id: "sibling".to_string(),
                pid: 99,
            },
        ];
        let mut pids = HashSet::new();
        pids.insert(42);
        assert_eq!(grok_owned_session_id(&owners, &pids).as_deref(), Some("owned"));
        pids.clear();
        assert_eq!(grok_owned_session_id(&owners, &pids), None);
    }

    #[test]
    fn grok_parse_active_session_ids_reads_session_id_field() {
        let raw = r#"[{"session_id":"01a1a8c4-876b-7260-b545-c8f1d9ecd705","pid":14592,"cwd":"E:\\kite"}]"#;
        let ids = grok_parse_active_session_ids(raw);
        assert!(ids.contains("01a1a8c4-876b-7260-b545-c8f1d9ecd705"));
        assert_eq!(ids.len(), 1);
    }

    #[test]
    fn usable_grok_user_input_drops_sgr_mouse_noise() {
        let mouse = "[<35;24;58M[<35;23;59M[<35;22;59M genera";
        assert_eq!(usable_grok_user_input(Some(mouse)), None);
        assert_eq!(
            usable_grok_user_input(Some("investigar el primer frame")),
            Some("investigar el primer frame")
        );
    }

    #[test]
    fn restore_grok_keeps_saved_id_and_does_not_substitute() {
        let home = std::env::temp_dir().join(format!("kite-grok-home-{}", uuid::Uuid::new_v4()));
        let root = home.join("sessions").join(grok_encode_cwd(r"E:\kite"));
        let saved_id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
        let sibling = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
        std::fs::create_dir_all(root.join(saved_id)).unwrap();
        std::fs::create_dir_all(root.join(sibling)).unwrap();
        let write_summary = |id: &str, created: &str, active: &str| {
            let body = serde_json::json!({
                "info": { "id": id, "cwd": r"E:\kite" },
                "created_at": created,
                "last_active_at": active,
                "generated_title": "demo",
                "session_summary": "demo"
            });
            std::fs::write(root.join(id).join("summary.json"), body.to_string()).unwrap();
        };
        write_summary(saved_id, "2026-11-04T22:53:34Z", "2026-11-05T00:34:00Z");
        write_summary(sibling, "2026-11-04T22:44:26Z", "2026-11-04T23:47:26Z");
        std::fs::write(
            home.join("active_sessions.json"),
            format!(r#"[{{"session_id":"{saved_id}","pid":0,"cwd":"E:\\kite"}}]"#),
        )
        .unwrap();

        let kept = restore_grok_provider_id_from_home(
            &home,
            Some(saved_id),
            &HashSet::new(),
            r"E:\kite",
            "term-grok",
            grok_rfc3339_to_unix_ms("2026-11-05T00:23:40Z").unwrap(),
            Some("[<35;24;58M[<35;23;59M[<35;22;59M"),
        );
        assert_eq!(kept.as_deref(), Some(saved_id));

        std::fs::write(
            home.join("active_sessions.json"),
            format!(
                r#"[{{"session_id":"{saved_id}","pid":{},"cwd":"E:\\kite"}}]"#,
                std::process::id()
            ),
        )
        .unwrap();
        let blocked = restore_grok_provider_id_from_home(
            &home,
            Some(saved_id),
            &HashSet::new(),
            r"E:\kite",
            "term-grok",
            grok_rfc3339_to_unix_ms("2026-11-05T00:23:40Z").unwrap(),
            None,
        );
        assert_eq!(blocked, None);

        let discovered = restore_grok_provider_id_from_home(
            &home,
            None,
            &HashSet::new(),
            r"E:\kite",
            "term-grok",
            grok_rfc3339_to_unix_ms("2026-11-04T22:44:26Z").unwrap(),
            None,
        );
        assert_eq!(discovered, None);

        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn maps_executable_names_to_canonical_engines() {
        assert_eq!(
            map_executable_name_to_agent_engine("agy.exe"),
            Some("antigravity".to_string())
        );
        assert_eq!(
            map_executable_name_to_agent_engine("codex.exe"),
            Some("codex".to_string())
        );
        assert_eq!(
            map_executable_name_to_agent_engine("claude.exe"),
            Some("claude-code".to_string())
        );
        assert_eq!(
            map_executable_name_to_agent_engine("opencode.exe"),
            Some("open-code".to_string())
        );
        assert_eq!(
            map_executable_name_to_agent_engine("gentle-shell.cmd"),
            Some("gentle-shell".to_string())
        );
        assert_eq!(
            map_executable_name_to_agent_engine("grok.exe"),
            Some("grok".to_string())
        );
        assert_eq!(
            canonical_agent_engine("gentle-shell"),
            "gentle-shell".to_string()
        );
        assert_eq!(map_executable_name_to_agent_engine("powershell.exe"), None);
    }

    #[test]
    fn test_normalize_terminal_text_strips_ansi_and_normalizes_whitespace() {
        let raw = b"\x1b[32m\x1b[1m  Hello   World!\x1b[0m\r\nThis is   ANTIGRAVITY\t\ttest.  ";
        let norm = normalize_terminal_text(raw);
        assert_eq!(norm, " hello world! this is antigravity test. ");
    }

    #[test]
    fn test_extract_phrase_windows_produces_multi_word_phrases() {
        let norm = "quiero que investigues y explores exhaustivamente que esta sucediendo con las terminales";
        let wins = extract_phrase_windows(norm, 5);
        assert!(!wins.is_empty());
        assert!(wins[0].len() >= 16);
        assert!(wins[0].split_whitespace().count() >= 3);
    }

    #[test]
    fn test_resolve_provider_session_id_rejects_claimed_existing_id() {
        let mut claimed = HashSet::new();
        claimed.insert("existing-uuid-1234".to_string());

        // When existing_provider_id is claimed, antigravity should not return it directly
        let res = resolve_provider_session_id(
            "antigravity",
            r"C:\non_existent_folder_xyz_123",
            "dummy-term-session",
            Some("existing-uuid-1234"),
            0,
            &claimed,
        );
        assert_ne!(res.as_deref(), Some("existing-uuid-1234"));

        // When not claimed, it should return it
        let empty_claimed = HashSet::new();
        let res_ok = resolve_provider_session_id(
            "antigravity",
            r"C:\non_existent_folder_xyz_123",
            "dummy-term-session",
            Some("existing-uuid-1234"),
            0,
            &empty_claimed,
        );
        assert_eq!(res_ok.as_deref(), Some("existing-uuid-1234"));
    }

    #[test]
    fn restore_uses_only_the_saved_unclaimed_provider_id() {
        let mut claimed = HashSet::new();
        claimed.insert("taken".to_string());
        assert_eq!(
            choose_restore_provider_id(Some("mine"), &HashSet::new()).as_deref(),
            Some("mine")
        );
        assert_eq!(choose_restore_provider_id(Some("taken"), &claimed), None);
        assert_eq!(choose_restore_provider_id(Some("  "), &HashSet::new()), None);
        assert_eq!(choose_restore_provider_id(None, &HashSet::new()), None);
    }

    #[test]
    fn strong_discovery_replaces_stored_provider_id() {
        let claimed = HashSet::new();
        assert_eq!(
            pick_bound_provider_id(Some("old"), Some("new"), &claimed).as_deref(),
            Some("new")
        );
        assert_eq!(
            pick_bound_provider_id(Some("old"), None, &claimed).as_deref(),
            Some("old")
        );
        let mut taken = HashSet::new();
        taken.insert("new".to_string());
        assert_eq!(
            pick_bound_provider_id(Some("old"), Some("new"), &taken).as_deref(),
            Some("old")
        );
    }

    #[test]
    fn upsert_keeps_provider_id_until_an_explicit_clear() {
        let session_id = format!("test-upsert-clear-{}", uuid::Uuid::new_v4());
        let base = PersistedTerminalSession {
            session_id: session_id.clone(),
            workspace_id: Some("ws".to_string()),
            pane_id: Some("pane".to_string()),
            base_engine: "codex".to_string(),
            active_engine: "codex".to_string(),
            provider_session_id: Some("prov-a".to_string()),
            cwd: "E:/kite".to_string(),
            had_user_activity: true,
            last_user_input: None,
            spawned_at_unix_ms: 1,
            saved_at_unix_ms: 1,
        };
        upsert_persisted_terminal_session(base.clone());
        let mut partial = base.clone();
        partial.provider_session_id = None;
        partial.saved_at_unix_ms = 2;
        upsert_persisted_terminal_session(partial);
        let kept = read_persisted_terminal_sessions()
            .get(&session_id)
            .and_then(|row| row.provider_session_id.clone());
        assert_eq!(kept.as_deref(), Some("prov-a"));

        let mut cleared = base;
        cleared.provider_session_id = None;
        cleared.saved_at_unix_ms = 3;
        upsert_persisted_terminal_session_clearing_provider(cleared);
        let after = read_persisted_terminal_sessions()
            .get(&session_id)
            .and_then(|row| row.provider_session_id.clone());
        assert_eq!(after, None);
        remove_persisted_terminal_session(&session_id);
    }
