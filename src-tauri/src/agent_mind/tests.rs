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

