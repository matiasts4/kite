use crate::agent_mind::service::list_agent_starters;
use serde_json::json;
use crate::agent_mind::memory::{load_agent_mind_at, sync_agent_instructions, write_agent_memory_at};
use crate::agent_mind::skills::{load_agent_skill_at, remove_agent_skill_at, write_agent_skill_at};
use crate::agent_mind::starters::install_agent_starter_at;
use crate::agent_mind::utils::empty_revision;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

    static TEMP_ROOT_SEQ: AtomicU64 = AtomicU64::new(0);

    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new() -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let seq = TEMP_ROOT_SEQ.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "kite-agent-mind-{}-{nanos}-{seq}",
                std::process::id()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn writes_memory_installs_starter_and_removes_one_skill() {
        let root = TempRoot::new();
        let agent_id = "c3333333-3333-4333-8333-333333333333";

        let fresh = load_agent_mind_at(&root.0, agent_id).unwrap();
        assert!(!fresh.is_null());
        assert_eq!(fresh["memory"].as_str(), Some(""));
        assert!(fresh["memoryUpdatedAtUnixMs"].is_null());
        assert_eq!(fresh["memoryRevision"].as_str(), Some(empty_revision().as_str()));
        assert_eq!(fresh["skills"].as_array().map(|items| items.len()), Some(0));

        let written = write_agent_memory_at(
            &root.0,
            agent_id,
            "memory",
            "Ship the local note.",
            "rawBuilderEdit",
            fresh["memoryRevision"].as_str(),
        )
        .unwrap();
        assert!(!written.is_null());
        assert_eq!(written["memory"].as_str(), Some("Ship the local note."));
        assert_eq!(
            written["memoryRevision"].as_str().map(|revision| revision.len()),
            Some(64)
        );

        let loaded = load_agent_mind_at(&root.0, agent_id).unwrap();
        assert_eq!(loaded["memory"], written["memory"]);
        assert_eq!(loaded["memoryRevision"], written["memoryRevision"]);
        assert_eq!(
            fs::read_to_string(root.0.join(agent_id).join("memory.txt")).unwrap(),
            "Ship the local note."
        );

        let installed = install_agent_starter_at(&root.0, agent_id, "keep-a-memory").unwrap();
        assert_eq!(installed["installed"], json!(true));
        assert_eq!(
            installed["mind"]["memory"].as_str(),
            Some("Ship the local note.")
        );
        let starter = load_agent_skill_at(&root.0, agent_id, "keep-a-memory").unwrap();
        assert!(starter["source"]
            .as_str()
            .unwrap()
            .contains("Write one durable line into agent memory"));
        assert_eq!(starter["name"].as_str(), Some("Keep a memory"));

        let extra = "---\nname: Local notes\ndescription: Notes that stay on this machine.\n---\nKeep the extra procedure.\n";
        write_agent_skill_at(&root.0, agent_id, "local-notes", extra, None).unwrap();
        let kept = load_agent_skill_at(&root.0, agent_id, "local-notes").unwrap();
        assert_eq!(kept["source"].as_str(), Some(extra));

        let revision = starter["revision"].as_str().unwrap();
        let removed = remove_agent_skill_at(&root.0, agent_id, "keep-a-memory", revision).unwrap();
        assert_eq!(removed["removed"], json!(true));
        assert_eq!(removed["mind"]["memory"].as_str(), Some("Ship the local note."));
        let remaining: Vec<&str> = removed["mind"]["skills"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|skill| skill["id"].as_str())
            .collect();
        assert_eq!(remaining, vec!["local-notes"]);
        assert!(!root
            .0
            .join(agent_id)
            .join("skills")
            .join("keep-a-memory.md")
            .exists());
        assert_eq!(
            fs::read_to_string(root.0.join(agent_id).join("skills").join("local-notes.md")).unwrap(),
            extra
        );
        assert!(root.0.join(agent_id).join("AGENTS.md").exists());
        let agents_md = fs::read_to_string(root.0.join(agent_id).join("AGENTS.md")).unwrap();
        assert!(agents_md.contains("Ship the local note."));
        assert!(agents_md.contains("local-notes"));

        let missing = load_agent_skill_at(&root.0, agent_id, "keep-a-memory").unwrap_err();
        assert_eq!(missing.code, "agent_data_unreadable");
        assert!(!missing.message.is_empty());

        let unknown = load_agent_mind_at(&root.0, "not-an-agent").unwrap_err();
        assert_eq!(unknown.code, "agent_data_failed");
        assert!(!unknown.message.is_empty());

        let starters = list_agent_starters(json!({ "request": { "supportedCatalogVersion": 1 } }));
        assert_eq!(
            starters.iter().filter_map(|s| s["id"].as_str()).collect::<Vec<_>>(),
            vec!["keep-a-memory", "write-a-skill", "research-a-question", "draft-for-a-reader", "root-cause"]
        );
    }

    #[test]
    fn instruction_sync_still_writes_the_agent_home_document() {
        let root = TempRoot::new();
        let agent_id = "e5555555-5555-4555-8555-555555555555";
        let home = root.0.join(agent_id);
        fs::create_dir_all(home.join("skills")).unwrap();
        fs::write(home.join("memory.txt"), "Keep the release notes in the repo.").unwrap();
        fs::write(home.join("user.txt"), "Prefers short answers.").unwrap();
        fs::write(
            home.join("skills").join("root-cause.md"),
            "---\nname: Root cause\ndescription: Trace a failure.\n---\nReproduce it first.\n",
        )
        .unwrap();

        sync_agent_instructions(&root.0, agent_id).unwrap();

        let agents = fs::read_to_string(home.join("AGENTS.md")).unwrap();
        assert_eq!(fs::read_to_string(home.join("CLAUDE.md")).unwrap(), agents);
        assert_eq!(fs::read_to_string(home.join("README.md")).unwrap(), agents);
        assert!(agents.starts_with("# Agent Instructions\n\nAgent ID: `"));
        assert!(agents.contains("## Long-Term Memory (memory.txt)\n\nKeep the release notes in the repo."));
        assert!(agents.contains("## Builder Context & Preferences (user.txt)\n\nPrefers short answers."));
        assert!(agents.contains("## Learned Skills\n\n### Root cause (`root-cause`)\nTrace a failure.\n\n```markdown\nReproduce it first.\n```"));
    }

    #[test]
    fn write_recipe_instructions_never_overwrites_existing_instructions() {
        let root = TempRoot::new();
        let target = root.0.join("repo");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("AGENTS.md"), "# Custom Repo Instructions\nOriginal content.").unwrap();
        fs::write(target.join("CLAUDE.md"), "# Custom Claude Instructions\nOriginal content.").unwrap();

        let res = crate::agent_mind::memory::write_recipe_instructions(
            &target,
            "agent-uuid",
            "Role",
            "Memory",
            "User",
            &["skill-1".to_string()],
        );
        assert!(res.is_ok());

        assert_eq!(
            fs::read_to_string(target.join("AGENTS.md")).unwrap(),
            "# Custom Repo Instructions\nOriginal content."
        );
        assert_eq!(
            fs::read_to_string(target.join("CLAUDE.md")).unwrap(),
            "# Custom Claude Instructions\nOriginal content."
        );
    }

    #[test]
    fn write_recipe_instructions_never_creates_files_inside_git_repository() {
        let root = TempRoot::new();
        let target = root.0.join("git-repo");
        fs::create_dir_all(target.join(".git")).unwrap();

        let res = crate::agent_mind::memory::write_recipe_instructions(
            &target,
            "agent-uuid",
            "Role",
            "Memory",
            "User",
            &["skill-1".to_string()],
        );
        assert!(res.is_ok());

        assert!(!target.join("AGENTS.md").exists());
        assert!(!target.join("CLAUDE.md").exists());
    }

    #[test]
    fn write_recipe_instructions_preserves_agent_home_instructions_without_stripping_bodies() {
        let root = TempRoot::new();
        let agent_id = "f6666666-6666-4666-8666-666666666666";
        let home = root.0.join(agent_id);
        fs::create_dir_all(home.join("skills")).unwrap();
        fs::write(home.join("memory.txt"), "Durable memory.").unwrap();
        fs::write(home.join("user.txt"), "User pref.").unwrap();
        fs::write(
            home.join("skills").join("full-skill.md"),
            "---\nname: Full Skill\ndescription: A complete skill.\n---\nFull body markdown code.\n",
        )
        .unwrap();

        sync_agent_instructions(&root.0, agent_id).unwrap();
        let before_agents = fs::read_to_string(home.join("AGENTS.md")).unwrap();
        assert!(before_agents.contains("Full body markdown code."));

        let res = crate::agent_mind::memory::write_recipe_instructions(
            &home,
            agent_id,
            "Role",
            "Durable memory.",
            "User pref.",
            &["full-skill".to_string()],
        );
        assert!(res.is_ok());

        let after_agents = fs::read_to_string(home.join("AGENTS.md")).unwrap();
        assert!(after_agents.contains("Full body markdown code."));
        assert!(!after_agents.contains("- `full-skill`\n\n"));
    }

    #[test]
    fn recipe_snapshot_compile_instructions_at_preserves_isolation_and_enriches_skills() {
        let root = TempRoot::new();
        let agent_id = "a1111111-1111-4111-8111-111111111111";
        let home = root.0.join(agent_id);
        fs::create_dir_all(home.join("skills")).unwrap();
        fs::write(home.join("memory.txt"), "Original disk memory").unwrap();
        fs::write(home.join("user.txt"), "Original disk user").unwrap();
        fs::write(
            home.join("skills").join("test-skill.md"),
            "---\nname: Test Skill\ndescription: Skill desc.\n---\nBody of test skill.\n",
        )
        .unwrap();

        let snapshot = crate::chat::session::RecipeSnapshot {
            agent_id: agent_id.to_string(),
            revision: "rev-1".to_string(),
            role: "Snapshot Frozen Role".to_string(),
            memory: "Snapshot Frozen Memory".to_string(),
            user: "Snapshot Frozen User".to_string(),
            skills: vec!["test-skill".to_string()],
        };

        // Mutate files on disk after snapshot was taken
        fs::write(home.join("memory.txt"), "Mutated memory that should NOT leak into snapshot").unwrap();
        fs::write(home.join("user.txt"), "Mutated user that should NOT leak into snapshot").unwrap();

        let compiled = snapshot.compile_instructions_at(&root.0);
        assert!(compiled.contains("## Role & Charter\n\nSnapshot Frozen Role"));
        assert!(compiled.contains("## Long-Term Memory (memory.txt)\n\nSnapshot Frozen Memory"));
        assert!(compiled.contains("## Builder Context & Preferences (user.txt)\n\nSnapshot Frozen User"));
        assert!(!compiled.contains("Mutated memory that should NOT leak into snapshot"));
        assert!(!compiled.contains("Mutated user that should NOT leak into snapshot"));
        assert!(compiled.contains("### Test Skill (`test-skill`)\nSkill desc.\n\n```markdown\nBody of test skill.\n```"));
    }

    #[test]
    fn dynamic_memory_budget_enforces_agent_profile_limit_over_4000() {
        let root = TempRoot::new();
        let agent_id = uuid::Uuid::new_v4().to_string();
        {
            let mut agents = crate::persist::agents().lock().unwrap();
            agents.push(crate::persist::AgentProfile {
                id: agent_id.clone(),
                name: "Budget Agent".into(),
                engine: "claude".into(),
                purpose: "Test".into(),
                brief: "Test".into(),
                avatar: None,
                created_at_unix_ms: 1_700_000_000_000,
                pinned: false,
                order: 99,
                memory_budget: Some(6000),
                reflection_mode: None,
                allow_agent_scheduling: None,
                allow_agent_messaging: None,
                default_mode: None,
                default_plan: None,
                default_model: None,
                default_provider_options: Vec::new(),
                place_display_names: Vec::new(),
                disabled_plugin_ids: Vec::new(),
            });
        }
        struct Cleanup(String);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                if let Ok(mut agents) = crate::persist::agents().lock() {
                    agents.retain(|a| a.id != self.0);
                }
            }
        }
        let _cleanup = Cleanup(agent_id.clone());

        let ok_5500 = "a".repeat(5500);
        let written = write_agent_memory_at(
            &root.0,
            &agent_id,
            "memory",
            &ok_5500,
            "structured",
            None,
        )
        .expect("5500 chars must succeed with 6000 budget");
        assert_eq!(written["memory"].as_str().map(str::len), Some(5500));

        let over_6500 = "b".repeat(6500);
        let err = write_agent_memory_at(
            &root.0,
            &agent_id,
            "memory",
            &over_6500,
            "structured",
            written["memoryRevision"].as_str(),
        )
        .unwrap_err();
        assert_eq!(err.code, "memory_over_budget");
    }

    #[test]
    fn shared_user_txt_is_shared_across_agents_while_memory_stays_isolated() {
        let root = TempRoot::new();
        let agent_a = "aaaaaaaa-1111-4111-8111-111111111111";
        let agent_b = "bbbbbbbb-2222-4222-8222-222222222222";

        write_agent_memory_at(&root.0, agent_a, "memory", "Memory A", "structured", None).unwrap();
        write_agent_memory_at(&root.0, agent_b, "memory", "Memory B", "structured", None).unwrap();
        write_agent_memory_at(&root.0, agent_a, "user", "Shared builder note", "structured", None).unwrap();

        assert!(root.0.join("user.txt").is_file(), "shared user.txt must live at root");
        let mind_a = load_agent_mind_at(&root.0, agent_a).unwrap();
        let mind_b = load_agent_mind_at(&root.0, agent_b).unwrap();
        assert_eq!(mind_a["user"].as_str(), Some("Shared builder note"));
        assert_eq!(mind_b["user"].as_str(), Some("Shared builder note"));
        assert_eq!(mind_a["memory"].as_str(), Some("Memory A"));
        assert_eq!(mind_b["memory"].as_str(), Some("Memory B"));

        // Legacy fallback: when root/user.txt is absent, fall back to root/<agent>/user.txt
        let legacy_root = TempRoot::new();
        fs::create_dir_all(legacy_root.0.join(agent_a)).unwrap();
        fs::write(legacy_root.0.join(agent_a).join("user.txt"), "Legacy user note").unwrap();
        let legacy_mind = load_agent_mind_at(&legacy_root.0, agent_a).unwrap();
        assert_eq!(legacy_mind["user"].as_str(), Some("Legacy user note"));
    }

    #[test]
    fn compile_snapshot_instructions_includes_places_authorized_roots() {
        let root = TempRoot::new();
        let dir_place = TempRoot::new();
        let ws_folder = TempRoot::new();
        let agent_id = format!("places-agent-{}", uuid::Uuid::new_v4().simple());
        let ws_id = format!("places-ws-{}", uuid::Uuid::new_v4().simple());
        let ws_name = format!("PlacesRepo-{}", uuid::Uuid::new_v4().simple());

        {
            let mut wss = crate::persist::workspaces().lock().unwrap();
            wss.push(crate::persist::Workspace {
                id: ws_id.clone(),
                display_name: ws_name.clone(),
                created_at_unix_ms: 1_700_000_000_000,
                last_opened_at_unix_ms: 1_700_000_000_000,
                pinned: false,
                available: true,
            });
            crate::persist::paths()
                .lock()
                .unwrap()
                .insert(ws_id.clone(), ws_folder.0.to_string_lossy().to_string());
            let mut agents = crate::persist::agents().lock().unwrap();
            agents.push(crate::persist::AgentProfile {
                id: agent_id.clone(),
                name: "Places Agent".into(),
                engine: "claude".into(),
                purpose: "Test".into(),
                brief: "Test".into(),
                avatar: None,
                created_at_unix_ms: 1_700_000_000_000,
                pinned: false,
                order: 99,
                memory_budget: None,
                reflection_mode: None,
                allow_agent_scheduling: None,
                allow_agent_messaging: None,
                default_mode: None,
                default_plan: None,
                default_model: None,
                default_provider_options: Vec::new(),
                place_display_names: vec![ws_name.clone(), dir_place.0.to_string_lossy().to_string()],
                disabled_plugin_ids: Vec::new(),
            });
        }
        struct Cleanup(String, String);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                if let Ok(mut agents) = crate::persist::agents().lock() {
                    agents.retain(|a| a.id != self.0);
                }
                if let Ok(mut wss) = crate::persist::workspaces().lock() {
                    wss.retain(|w| w.id != self.1);
                }
                if let Ok(mut paths) = crate::persist::paths().lock() {
                    paths.remove(&self.1);
                }
            }
        }
        let _cleanup = Cleanup(agent_id.clone(), ws_id.clone());

        let compiled = crate::agent_mind::memory::compile_snapshot_instructions_at(
            &root.0,
            &agent_id,
            "Test role",
            "",
            "",
            &[],
        );
        assert!(compiled.contains("## Places (Authorized Roots)"));
        assert!(compiled.contains(&ws_name));
        assert!(compiled.contains(&ws_folder.0.to_string_lossy().to_string()));
        assert!(compiled.contains(&dir_place.0.to_string_lossy().to_string()));
    }

    #[test]
    fn skills_enable_disable_and_telemetry_exclude_disabled_from_compiled_instructions() {
        let root = TempRoot::new();
        let agent_id = "b2222222-2222-4222-8222-222222222222";
        let home = root.0.join(agent_id);
        fs::create_dir_all(home.join("skills")).unwrap();
        fs::write(
            home.join("skills").join("alpha.md"),
            "---\nname: Alpha\ndescription: Alpha skill\n---\nAlpha body.\n",
        )
        .unwrap();
        fs::write(
            home.join("skills").join("beta.md"),
            "---\nname: Beta\ndescription: Beta skill\n---\nBeta body.\n",
        )
        .unwrap();

        // Disable beta
        let mind = crate::agent_mind::skills::set_agent_skill_enabled_at(&root.0, agent_id, "beta", false).unwrap();
        let skills = mind.get("skills").and_then(serde_json::Value::as_array).unwrap();
        let beta = skills.iter().find(|s| s.get("id").and_then(serde_json::Value::as_str) == Some("beta")).unwrap();
        assert_eq!(beta.get("enabled").and_then(serde_json::Value::as_bool), Some(false));

        let compiled = crate::agent_mind::memory::build_compiled_agent_instructions(&root.0, agent_id);
        assert!(compiled.contains("Alpha body."));
        assert!(!compiled.contains("Beta body."));

        let snapshot_compiled = crate::agent_mind::memory::compile_snapshot_instructions_at(
            &root.0,
            agent_id,
            "Role",
            "",
            "",
            &["alpha".to_string(), "beta".to_string()],
        );
        assert!(snapshot_compiled.contains("Alpha body."));
        assert!(!snapshot_compiled.contains("Beta body."));

        // Record usage telemetry
        crate::agent_mind::skills::record_skills_used_at(&root.0, agent_id, &["alpha".to_string()], Some("completed"));
        let mind_after = crate::agent_mind::memory::load_agent_mind_at(&root.0, agent_id).unwrap();
        let alpha = mind_after
            .get("skills")
            .and_then(serde_json::Value::as_array)
            .unwrap()
            .iter()
            .find(|s| s.get("id").and_then(serde_json::Value::as_str) == Some("alpha"))
            .unwrap();
        assert_eq!(alpha.get("uses").and_then(serde_json::Value::as_u64), Some(1));
        assert!(alpha.get("lastUsed").and_then(serde_json::Value::as_str).is_some());
    }

    #[test]
    fn post_turn_reflection_supports_auto_structured_and_ask_candidate_modes() {
        let root = TempRoot::new();
        let agent_id = uuid::Uuid::new_v4().to_string();
        {
            let mut agents = crate::persist::agents().lock().unwrap();
            agents.push(crate::persist::AgentProfile {
                id: agent_id.clone(),
                name: "Reflection Agent".into(),
                engine: "claude".into(),
                purpose: "Test".into(),
                brief: "Test".into(),
                avatar: None,
                created_at_unix_ms: 1_700_000_000_000,
                pinned: false,
                order: 99,
                memory_budget: Some(4000),
                reflection_mode: Some("ask".into()),
                allow_agent_scheduling: None,
                allow_agent_messaging: None,
                default_mode: None,
                default_plan: None,
                default_model: None,
                default_provider_options: Vec::new(),
                place_display_names: Vec::new(),
                disabled_plugin_ids: Vec::new(),
            });
        }
        struct Cleanup(String);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                if let Ok(mut agents) = crate::persist::agents().lock() {
                    agents.retain(|a| a.id != self.0);
                }
            }
        }
        let _cleanup = Cleanup(agent_id.clone());

        // Ask mode: returns candidate without writing memory.txt
        let candidate = crate::agent_mind::memory::apply_post_turn_reflection_at(
            &root.0,
            &agent_id,
            "From now on, use Vitest instead of Jest for unit tests.",
            "Understood, we will use Vitest.",
        );
        let candidate = candidate.expect("ask mode should return ReflectionCandidate");
        assert_eq!(candidate.agent_id, agent_id);
        assert!(candidate.note.contains("Vitest"));
        assert!(!root.0.join(&agent_id).join("memory.txt").exists());

        // Switch to auto mode: writes structured note & returns None
        {
            let mut agents = crate::persist::agents().lock().unwrap();
            if let Some(a) = agents.iter_mut().find(|a| a.id == agent_id) {
                a.reflection_mode = Some("auto".into());
            }
        }
        let auto_res = crate::agent_mind::memory::apply_post_turn_reflection_at(
            &root.0,
            &agent_id,
            "Our convention is to keep Tauri commands snake_case.",
            "Decision: Keep Tauri commands snake_case.",
        );
        assert!(auto_res.is_none());
        let mem = fs::read_to_string(root.0.join(&agent_id).join("memory.txt")).unwrap();
        assert!(mem.contains("snake_case"));
    }

    #[test]
    fn knowledge_pack_indexing_respects_places_token_caps_and_deduplicates_memory() {
        use crate::agent_mind::knowledge::{
            delete_knowledge_pack_at, glob_matches, render_knowledge_manifest_at,
            save_knowledge_pack_at, search_knowledge_packs_at, MANIFEST_MAX_CHARS,
            SEARCH_MAX_EXCERPT_CHARS,
        };
        use crate::agent_mind::memory::{
            find_similar_memory_entries, jaccard_similarity, load_memory_meta_map,
            update_memory_meta_at,
        };

        assert!(glob_matches("odd/tasks/*.md", "odd/tasks/spec.md"));
        assert!(glob_matches("docs/**/*.md", "docs/arch/overview.md"));
        assert!(!glob_matches("docs/*.md", "docs/arch/overview.md"));

        let root = TempRoot::new();
        let workspace_ok = root.0.join("workspace_ok");
        let outside_dir = root.0.join("outside_secret");
        fs::create_dir_all(workspace_ok.join("docs")).unwrap();
        fs::create_dir_all(&outside_dir).unwrap();
        fs::write(
            workspace_ok.join("docs/architecture.md"),
            "# Core Architecture\n\nKite Code uses a Rust backend and React frontend with Tauri IPC.\n\n## Playbooks\n\nPlaybooks coordinate stages via SharedContextStore.",
        )
        .unwrap();
        fs::write(outside_dir.join("secret.md"), "# Secret\nDo not leak").unwrap();

        let agent_id = "d4444444-4444-4444-8444-444444444444";
        let allowed = vec![workspace_ok.clone()];

        // Outside root must be rejected by Places boundary
        let denied = save_knowledge_pack_at(
            &root.0,
            agent_id,
            &allowed,
            None,
            "Outside",
            &outside_dir.to_string_lossy(),
            vec!["**/*.md".into()],
            true,
        );
        assert!(denied.is_err());

        // Inside authorized Place succeeds, renders compact manifest, and bounds search output
        let index = save_knowledge_pack_at(
            &root.0,
            agent_id,
            &allowed,
            None,
            "Architecture Docs",
            &workspace_ok.to_string_lossy(),
            vec!["docs/*.md".into()],
            true,
        )
        .unwrap();
        assert_eq!(index.packs.len(), 1);
        assert!(index.chunks.len() >= 2);

        let manifest = render_knowledge_manifest_at(&root.0, agent_id);
        assert!(manifest.contains("Architecture Docs"));
        assert!(manifest.chars().count() <= MANIFEST_MAX_CHARS + 2);

        let search = search_knowledge_packs_at(&root.0, agent_id, "SharedContextStore Playbooks", 5);
        assert!(!search["matches"].as_array().unwrap().is_empty());
        assert!(search["totalChars"].as_u64().unwrap() <= SEARCH_MAX_EXCERPT_CHARS as u64);

        let after_del = delete_knowledge_pack_at(&root.0, agent_id, &index.packs[0].id).unwrap();
        assert!(after_del.packs.is_empty());
        assert!(render_knowledge_manifest_at(&root.0, agent_id).is_empty());

        // Fuzzy Jaccard deduplication >= 0.85
        let sim = jaccard_similarity(
            "- Convention: Keep Tauri commands snake_case always.",
            "- Decision: Keep Tauri commands always snake_case",
        );
        assert!(sim >= 0.85, "expected high jaccard similarity, got {sim}");
        let hits = find_similar_memory_entries(
            "- Convention: Keep Tauri commands snake_case always.\n- Use Vitest for React tests.",
            "Keep Tauri commands always snake_case",
            0.85,
        );
        assert_eq!(hits.len(), 1);

        // Pin / archive / verify memory metadata
        let _ = update_memory_meta_at(&root.0, agent_id, "Keep Tauri commands", "pin", 1_700_000_000_000).unwrap();
        let meta = load_memory_meta_map(&root.0, agent_id);
        assert_eq!(meta.len(), 1);
        assert!(meta.values().next().unwrap().pinned);
    }

    #[test]
    fn parses_skill_frontmatter_controls_and_requirements() {
        use crate::agent_mind::skills::parse_skill_frontmatter;

        let inline_req_src = "---\nname: \"Pre-Push Gate\"\ndescription: Guard repository pushes\ndisable-model-invocation: true\ncontext: fork\nrequires: { bins: [\"git\", \"node\"], env: [\"GH_TOKEN\"] }\n---\nStep 1: run audit.\n\n---\n\nStep 2: ask user.\n";
        let (fm1, body1) = parse_skill_frontmatter(inline_req_src);
        assert_eq!(fm1.name.as_deref(), Some("Pre-Push Gate"));
        assert_eq!(fm1.description.as_deref(), Some("Guard repository pushes"));
        assert!(fm1.manual_only);
        assert_eq!(fm1.context_mode, "fork");
        assert_eq!(fm1.requires_bins, vec!["git", "node"]);
        assert_eq!(fm1.requires_env, vec!["GH_TOKEN"]);
        assert!(body1.contains("Step 1: run audit."));
        assert!(body1.contains("Step 2: ask user."));

        let block_req_src = "---\nname: Block Skill\nmanual-only: true\nrequires:\n  bins:\n    - cargo\n    - rustc\n  env:\n    - KITE_API_KEY\n    - KITE_ORG\n---\nRun cargo check.\n";
        let (fm2, body2) = parse_skill_frontmatter(block_req_src);
        assert_eq!(fm2.name.as_deref(), Some("Block Skill"));
        assert!(fm2.manual_only);
        assert_eq!(fm2.context_mode, "inline");
        assert_eq!(fm2.requires_bins, vec!["cargo", "rustc"]);
        assert_eq!(fm2.requires_env, vec!["KITE_API_KEY", "KITE_ORG"]);
        assert_eq!(body2, "Run cargo check.");
    }

    #[test]
    fn checks_skill_eligibility_for_path_bins_and_env_vars() {
        use crate::agent_mind::skills::check_skill_eligibility;
        use crate::agent_mind::types::SkillFrontmatter;

        let unique = uuid::Uuid::new_v4().simple().to_string();
        let env_name = format!("KITE_TEST_ELIG_ENV_{unique}");
        let missing_bin = format!("kite-nonexistent-bin-{unique}");

        let fm_missing = SkillFrontmatter {
            requires_bins: vec![missing_bin.clone()],
            requires_env: vec![env_name.clone()],
            ..SkillFrontmatter::default()
        };
        let (ok, missing) = check_skill_eligibility(&fm_missing);
        assert!(!ok);
        assert_eq!(
            missing,
            vec![format!("bin:{missing_bin}"), format!("env:{env_name}")]
        );

        let bin_dir = TempRoot::new();
        let bin_stem = format!("kite_test_cmd_{unique}");
        #[cfg(windows)]
        let bin_file = bin_dir.0.join(format!("{bin_stem}.cmd"));
        #[cfg(not(windows))]
        let bin_file = bin_dir.0.join(&bin_stem);
        fs::write(&bin_file, "@echo off\r\nexit /b 0\r\n").unwrap();

        let prev_path = std::env::var_os("PATH");
        let joined_path = match prev_path.as_ref() {
            Some(p) => {
                let mut dirs: Vec<PathBuf> = std::env::split_paths(p).collect();
                dirs.insert(0, bin_dir.0.clone());
                std::env::join_paths(dirs).unwrap()
            }
            None => std::env::join_paths([bin_dir.0.clone()]).unwrap(),
        };
        struct EnvGuard {
            prev_path: Option<std::ffi::OsString>,
            env_name: String,
        }
        impl Drop for EnvGuard {
            fn drop(&mut self) {
                std::env::remove_var(&self.env_name);
                match &self.prev_path {
                    Some(p) => std::env::set_var("PATH", p),
                    None => std::env::remove_var("PATH"),
                }
            }
        }
        let _guard = EnvGuard {
            prev_path,
            env_name: env_name.clone(),
        };
        std::env::set_var("PATH", &joined_path);
        std::env::set_var(&env_name, "present");

        let fm_ok = SkillFrontmatter {
            requires_bins: vec![bin_stem],
            requires_env: vec![env_name],
            ..SkillFrontmatter::default()
        };
        let (ok_after, missing_after) = check_skill_eligibility(&fm_ok);
        assert!(ok_after, "expected eligible, got missing: {missing_after:?}");
        assert!(missing_after.is_empty());
    }

    #[test]
    fn discovers_skills_with_workspace_precedence_and_reads_linked_refs_safely() {
        use crate::agent_mind::skills::{
            discover_available_skills_at, read_linked_skill_content,
        };

        let ws = TempRoot::new();
        let home = TempRoot::new();
        let outside = TempRoot::new();

        // Workspace .agents/skills + .claude/skills
        let ws_shared = ws.0.join(".agents").join("skills").join("shared-skill");
        fs::create_dir_all(&ws_shared).unwrap();
        fs::write(
            ws_shared.join("SKILL.md"),
            "---\nname: Workspace Shared\ndescription: From workspace\ncontext: fork\n---\nWorkspace body.\n",
        )
        .unwrap();

        let ws_claude_only = ws.0.join(".claude").join("skills").join("claude-only");
        fs::create_dir_all(&ws_claude_only).unwrap();
        fs::write(
            ws_claude_only.join("SKILL.md"),
            "---\nname: Claude Only\ndescription: From .claude\n---\nClaude body.\n",
        )
        .unwrap();

        // Global roots: same slug `shared-skill` (should be overridden by workspace), plus `global-only` and `kite-dispatch` (excluded)
        let gl_shared = home.0.join(".claude").join("skills").join("shared-skill");
        fs::create_dir_all(&gl_shared).unwrap();
        fs::write(
            gl_shared.join("SKILL.md"),
            "---\nname: Global Shared\ndescription: Should lose\n---\nGlobal body.\n",
        )
        .unwrap();

        let gl_only = home.0.join(".agents").join("skills").join("global-only");
        fs::create_dir_all(&gl_only).unwrap();
        fs::write(
            gl_only.join("SKILL.md"),
            "---\nname: Global Only\ndescription: Global desc\ndisable-model-invocation: true\n---\nManual global body.\n",
        )
        .unwrap();

        let gl_internal = home.0.join(".claude").join("skills").join("kite-dispatch");
        fs::create_dir_all(&gl_internal).unwrap();
        fs::write(
            gl_internal.join("SKILL.md"),
            "---\nname: Internal Dispatch\n---\nInternal.\n",
        )
        .unwrap();

        let outside_file = outside.0.join("secret.md");
        fs::write(&outside_file, "---\nname: Secret\n---\nSecret.\n").unwrap();

        let discovered = discover_available_skills_at(Some(&ws.0), &home.0);
        let ids: Vec<&str> = discovered.iter().filter_map(|s| s["id"].as_str()).collect();
        assert!(!ids.contains(&"kite-dispatch"), "internal kite-dispatch must be excluded");
        assert!(ids.contains(&"shared-skill"));
        assert!(ids.contains(&"claude-only"));
        assert!(ids.contains(&"global-only"));

        let shared = discovered
            .iter()
            .find(|s| s["id"].as_str() == Some("shared-skill"))
            .unwrap();
        assert_eq!(shared["scope"].as_str(), Some("workspace"));
        assert_eq!(shared["refKey"].as_str(), Some("workspace:shared-skill"));
        assert_eq!(shared["name"].as_str(), Some("Workspace Shared"));
        assert_eq!(shared["contextMode"].as_str(), Some("fork"));
        assert_eq!(shared["eligible"].as_bool(), Some(true));

        let global_only = discovered
            .iter()
            .find(|s| s["id"].as_str() == Some("global-only"))
            .unwrap();
        assert_eq!(global_only["scope"].as_str(), Some("global"));
        assert_eq!(global_only["refKey"].as_str(), Some("global:global-only"));
        assert_eq!(global_only["manualOnly"].as_bool(), Some(true));

        let loaded_ws = read_linked_skill_content("workspace:shared-skill", Some(&ws.0), &home.0).unwrap();
        assert_eq!(loaded_ws.body, "Workspace body.");
        let loaded_gl = read_linked_skill_content("global:global-only", Some(&ws.0), &home.0).unwrap();
        assert!(loaded_gl.frontmatter.manual_only);

        // Traversal and outside path checks must fail safely
        assert!(read_linked_skill_content("workspace:../secret", Some(&ws.0), &home.0).is_err());
        assert!(read_linked_skill_content("global:../../secret", Some(&ws.0), &home.0).is_err());
        assert!(read_linked_skill_content(
            &format!("path:{}/../secret.md", ws.0.display()),
            Some(&ws.0),
            &home.0
        )
        .is_err());
        assert!(read_linked_skill_content(
            &format!("path:{}", outside_file.display()),
            Some(&ws.0),
            &home.0
        )
        .is_err());
    }

    #[test]
    fn compiled_instructions_gate_ineligible_skills_and_separate_manual_only_skills() {
        use crate::agent_mind::memory::compile_snapshot_instructions_with_context_at;

        let root = TempRoot::new();
        let ws = TempRoot::new();
        let home = TempRoot::new();
        let agent_id = uuid::Uuid::new_v4().to_string();

        let skills_dir = root.0.join(&agent_id).join("skills");
        fs::create_dir_all(&skills_dir).unwrap();
        fs::write(
            skills_dir.join("local-auto.md"),
            "---\nname: Local Auto\ndescription: Auto local\n---\nLocal auto procedure.\n",
        )
        .unwrap();
        fs::write(
            skills_dir.join("local-ineligible.md"),
            "---\nname: Local Ineligible\ndescription: Missing tool\nrequires: { bins: [\"kite-missing-tool-xyz-999\"] }\n---\nSECRET_INELIGIBLE_BODY_MUST_NOT_APPEAR\n",
        )
        .unwrap();

        let ws_manual = ws.0.join(".agents").join("skills").join("pre-push-gate");
        fs::create_dir_all(&ws_manual).unwrap();
        fs::write(
            ws_manual.join("SKILL.md"),
            "---\nname: Pre-Push Gate\ndescription: Run clean-room audit before pushing\ndisable-model-invocation: true\ncontext: fork\n---\nMANUAL_SECRET_BODY_MUST_NOT_AUTO_INJECT\n",
        )
        .unwrap();

        let gl_auto = home.0.join(".agents").join("skills").join("global-helper");
        fs::create_dir_all(&gl_auto).unwrap();
        fs::write(
            gl_auto.join("SKILL.md"),
            "---\nname: Global Helper\ndescription: Helpful global skill\n---\nGlobal helper body.\n",
        )
        .unwrap();

        let gl_ineligible = home.0.join(".agents").join("skills").join("env-gated");
        fs::create_dir_all(&gl_ineligible).unwrap();
        fs::write(
            gl_ineligible.join("SKILL.md"),
            "---\nname: Env Gated\nrequires:\n  env:\n    - KITE_UNSET_ENV_VAR_XYZ_999\n---\nINELIGIBLE_LINKED_BODY\n",
        )
        .unwrap();

        let compiled = compile_snapshot_instructions_with_context_at(
            &root.0,
            &agent_id,
            "Specialist role",
            "",
            "",
            &["local-auto".to_string(), "local-ineligible".to_string()],
            &[
                "workspace:pre-push-gate".to_string(),
                "global:global-helper".to_string(),
                "global:env-gated".to_string(),
            ],
            &[ws.0.clone()],
            &home.0,
        );

        assert!(compiled.contains("Local auto procedure."));
        assert!(compiled.contains("Global helper body."));
        assert!(!compiled.contains("Local Ineligible"));
        assert!(!compiled.contains("SECRET_INELIGIBLE_BODY_MUST_NOT_APPEAR"));
        assert!(!compiled.contains("Env Gated"));
        assert!(!compiled.contains("INELIGIBLE_LINKED_BODY"));

        assert!(compiled.contains("## Manual-Trigger Skills (Explicit User Request Only)"));
        assert!(compiled.contains("Pre-Push Gate"));
        assert!(compiled.contains("workspace:pre-push-gate"));
        assert!(compiled.contains("[context: fork]"));
        assert!(!compiled.contains("MANUAL_SECRET_BODY_MUST_NOT_AUTO_INJECT"));
    }

    #[test]
    fn sqlite_persists_linked_skill_refs_and_service_commands_roundtrip_and_capture_from_chat() {
        use crate::agent_mind::service::{
            capture_agent_skill_from_chat, list_discoverable_skills, load_agent_mind,
            set_agent_linked_skills,
        };
        use crate::agent_mind::skills::capture_skill_from_chat_at;

        let root = TempRoot::new();
        let agent_id = uuid::Uuid::new_v4().to_string();
        let ws = TempRoot::new();
        let ws_id = format!("ws-linked-{}", uuid::Uuid::new_v4().simple());

        let ws_skill = ws.0.join(".agents").join("skills").join("ship-check");
        fs::create_dir_all(&ws_skill).unwrap();
        fs::write(
            ws_skill.join("SKILL.md"),
            "---\nname: Ship Check\ndescription: Verify diffs before ship\n---\nShip check steps.\n",
        )
        .unwrap();

        {
            let mut wss = crate::persist::workspaces().lock().unwrap();
            wss.push(crate::persist::Workspace {
                id: ws_id.clone(),
                display_name: "SkillRepo".into(),
                created_at_unix_ms: 1_700_000_000_000,
                last_opened_at_unix_ms: 1_700_000_000_000,
                pinned: false,
                available: true,
            });
        }
        {
            crate::persist::paths()
                .lock()
                .unwrap()
                .insert(ws_id.clone(), ws.0.to_string_lossy().to_string());
        }
        {
            let mut agents = crate::persist::agents().lock().unwrap();
            agents.push(crate::persist::AgentProfile {
                id: agent_id.clone(),
                name: "Linked Skill Agent".into(),
                engine: "antigravity".into(),
                purpose: "Test".into(),
                brief: "Test".into(),
                avatar: None,
                created_at_unix_ms: 1_700_000_000_000,
                pinned: false,
                order: 99,
                memory_budget: None,
                reflection_mode: None,
                allow_agent_scheduling: None,
                allow_agent_messaging: None,
                default_mode: None,
                default_plan: None,
                default_model: None,
                default_provider_options: Vec::new(),
                place_display_names: vec!["SkillRepo".into()],
                disabled_plugin_ids: Vec::new(),
            });
        }
        crate::persist::persist();

        struct Cleanup(String, String);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                if let Ok(mut agents) = crate::persist::agents().lock() {
                    agents.retain(|a| a.id != self.0);
                }
                if let Ok(mut wss) = crate::persist::workspaces().lock() {
                    wss.retain(|w| w.id != self.1);
                }
                if let Ok(mut paths) = crate::persist::paths().lock() {
                    paths.remove(&self.1);
                }
                crate::persist::persist();
                let _ = fs::remove_dir_all(crate::agent_mind::get_agent_home_dir(&self.0));
            }
        }
        let _cleanup = Cleanup(agent_id.clone(), ws_id.clone());

        let discovered = list_discoverable_skills(Some(json!({
            "request": { "workspaceId": ws_id, "agentId": agent_id }
        })))
        .unwrap();
        let disc_list = discovered["skills"].as_array().unwrap();
        assert!(disc_list
            .iter()
            .any(|s| s["refKey"].as_str() == Some("workspace:ship-check")));

        let updated_mind = set_agent_linked_skills(json!({
            "request": {
                "agentId": agent_id,
                "linkedSkillRefs": ["workspace:ship-check", "workspace:ship-check"]
            }
        }))
        .unwrap();
        assert_eq!(
            updated_mind["linkedSkillRefs"],
            json!(["workspace:ship-check"])
        );

        // Verify persist() does NOT clobber linked_skill_refs in SQLite
        crate::persist::persist();
        assert_eq!(
            crate::persist::get_agent_linked_skill_refs(&agent_id),
            vec!["workspace:ship-check".to_string()]
        );

        let reloaded = load_agent_mind(json!({ "request": { "agentId": agent_id } })).unwrap();
        assert_eq!(reloaded["linkedSkillRefs"], json!(["workspace:ship-check"]));

        // Reject path traversal in set_agent_linked_skills
        assert!(set_agent_linked_skills(json!({
            "request": {
                "agentId": agent_id,
                "linkedSkillRefs": ["workspace:../bad"]
            }
        }))
        .is_err());

        // Capture from chat (both direct helper and service command)
        let captured_mind = capture_skill_from_chat_at(
            &root.0,
            &agent_id,
            "Release Hygiene",
            "Verify clean tree and run tests",
            &[
                json!({ "role": "user", "text": "Always run git status and cargo test before pushing." }),
                json!({ "role": "assistant", "text": "1. Run sanitizer\n2. Run cargo test\n3. Ask before push." }),
            ],
            true,
        )
        .unwrap();
        assert_eq!(
            captured_mind["capturedSkillId"].as_str(),
            Some("release-hygiene")
        );
        let captured_skill = captured_mind["skills"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["id"].as_str() == Some("release-hygiene"))
            .unwrap();
        assert_eq!(captured_skill["manualOnly"].as_bool(), Some(true));

        let agents_doc = fs::read_to_string(root.0.join(&agent_id).join("AGENTS.md")).unwrap();
        assert!(agents_doc.contains("## Manual-Trigger Skills (Explicit User Request Only)"));
        assert!(agents_doc.contains("Release Hygiene"));

        let svc_captured = capture_agent_skill_from_chat(json!({
            "request": {
                "agentId": agent_id,
                "name": "Quick Check",
                "description": "Quick status check",
                "messages": [{ "role": "user", "text": "Check git status" }],
                "manualOnly": false
            }
        }))
        .unwrap();
        assert!(svc_captured["skills"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["id"].as_str() == Some("quick-check") && s["manualOnly"].as_bool() == Some(false)));
    }

