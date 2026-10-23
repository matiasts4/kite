use crate::agent_mind::service::list_agent_starters;
use serde_json::json;
use crate::agent_mind::memory::{load_agent_mind_at, sync_agent_instructions, write_agent_memory_at};
use crate::agent_mind::skills::{load_agent_skill_at, remove_agent_skill_at, write_agent_skill_at};
use crate::agent_mind::starters::install_agent_starter_at;
use crate::agent_mind::utils::empty_revision;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new() -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "kite-agent-mind-{}-{nanos}",
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

