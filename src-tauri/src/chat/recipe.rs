//! Agent recipe snapshotting for session start.
//!
//! A snapshot copies the agent record and the agent mind files before a process
//! starts. The session never reads the agent again, so editing the agent later
//! cannot rewrite a session that already started.

use std::io;
use std::path::Path;

use sha2::{Digest, Sha256};

use crate::agent_mind::memory::{read_agent_recipe_at, write_recipe_instructions};
use crate::chat::session::RecipeSnapshot;
use crate::persist::AgentProfile;

/// Copies the current recipe of a known agent. A loose chat has no agent, so it
/// never calls this and starts from the inherited CLI configuration instead.
///
/// The mind files are read once, here. The returned snapshot is the only source
/// a session may use after this point.
pub fn snapshot_for_agent(agent_id: &str) -> Option<RecipeSnapshot> {
    let root = crate::agent_mind::agents_root();
    let agents = crate::persist::agents().lock().ok()?.clone();
    snapshot_from_profiles(&root, &agents, agent_id)
}

/// The record lookup is a parameter so a snapshot can be built and tested
/// without global state.
pub(crate) fn snapshot_from_profiles(
    root: &Path,
    agents: &[AgentProfile],
    agent_id: &str,
) -> Option<RecipeSnapshot> {
    let agent = agents.iter().find(|agent| agent.id == agent_id)?;
    let role = if !agent.brief.trim().is_empty() {
        agent.brief.trim()
    } else {
        agent.purpose.trim()
    };
    let files = read_agent_recipe_at(root, agent_id);
    let revision = recipe_revision(agent_id, role, &files.memory, &files.user, &files.skills);
    Some(RecipeSnapshot {
        agent_id: agent_id.to_string(),
        revision,
        role: role.to_string(),
        memory: files.memory,
        user: files.user,
        skills: files.skills,
    })
}

/// Writes the recipe into the workspace the session will run in. The working
/// directory is not changed: the session is started in this directory, and the
/// document is already there when it starts.
///
/// The body and file names come from the existing instruction sync. Skill ids
/// are written because the snapshot carries the identity of each skill, not the
/// file that lived in the agent home at apply time.
pub fn apply_recipe(cwd: &Path, snapshot: &RecipeSnapshot) -> io::Result<()> {
    write_recipe_instructions(
        cwd,
        &snapshot.agent_id,
        &snapshot.role,
        &snapshot.memory,
        &snapshot.user,
        &snapshot.skills,
    )
}

/// A content revision is stable for identical recipe fields. Each field is
/// length-prefixed so content cannot shift across a boundary and collide.
fn recipe_revision(agent_id: &str, role: &str, memory: &str, user: &str, skills: &[String]) -> String {
    let mut canonical = String::from("recipe-v1\n");
    for part in [agent_id, role, memory, user] {
        canonical.push_str(&part.len().to_string());
        canonical.push(':');
        canonical.push_str(part);
        canonical.push('\n');
    }
    canonical.push_str(&skills.len().to_string());
    canonical.push('\n');
    for skill in skills {
        canonical.push_str(&skill.len().to_string());
        canonical.push(':');
        canonical.push_str(skill);
        canonical.push('\n');
    }
    let digest = Sha256::digest(canonical.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    const AGENT_ID: &str = "c3333333-3333-4333-8333-333333333333";

    /// A scratch directory outside the worktree. Dropping it removes the tree.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "kite-recipe-{label}-{}-{nanos}",
                std::process::id()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn profile(role: &str) -> AgentProfile {
        let mut record = crate::persist::seed_agents().remove(0);
        record.id = AGENT_ID.to_string();
        record.brief = role.to_string();
        record.purpose = role.to_string();
        record
    }

    fn write_agent_files(root: &Path, memory: &str, user: &str, skills: &[&str]) {
        let home = root.join(AGENT_ID);
        fs::create_dir_all(home.join("skills")).unwrap();
        fs::write(home.join("memory.txt"), memory).unwrap();
        fs::write(home.join("user.txt"), user).unwrap();
        for skill in skills {
            fs::write(
                home.join("skills").join(format!("{skill}.md")),
                format!("---\nname: {skill}\ndescription: when {skill} applies\n---\nbody of {skill}\n"),
            )
            .unwrap();
        }
    }

    fn snapshot(root: &Path, role: &str) -> RecipeSnapshot {
        snapshot_from_profiles(root, &[profile(role)], AGENT_ID).expect("known agent")
    }

    #[test]
    fn identical_content_keeps_one_revision() {
        let root = TempDir::new("stable");
        write_agent_files(root.path(), "remember the release date", "prefers short replies", &["root-cause"]);

        let first = snapshot(root.path(), "Ship the local note.");
        let second = snapshot(root.path(), "Ship the local note.");

        assert_eq!(first, second);
        assert_eq!(first.revision, second.revision);
        assert_eq!(first.agent_id, AGENT_ID);
        assert_eq!(first.role, "Ship the local note.");
        assert_eq!(first.memory, "remember the release date");
        assert_eq!(first.user, "prefers short replies");
        assert_eq!(first.skills, vec!["root-cause".to_string()]);
    }

    #[test]
    fn edited_agent_changes_the_revision_and_keeps_the_taken_snapshot() {
        let root = TempDir::new("edited");
        write_agent_files(root.path(), "old memory", "old user", &["root-cause"]);

        let first = snapshot(root.path(), "Original role.");
        write_agent_files(root.path(), "new memory", "old user", &["root-cause", "keep-a-memory"]);
        let second = snapshot(root.path(), "Original role.");

        assert_ne!(first.revision, second.revision);
        assert_eq!(first.memory, "old memory");
        assert_eq!(first.skills, vec!["root-cause".to_string()]);
        assert_eq!(second.memory, "new memory");
        assert_eq!(
            second.skills,
            vec!["keep-a-memory".to_string(), "root-cause".to_string()]
        );

        let role_edited = snapshot(root.path(), "Edited role.");
        assert_ne!(second.revision, role_edited.revision);
        assert_eq!(second.memory, role_edited.memory);

        let workspace = TempDir::new("edited-workspace");
        apply_recipe(workspace.path(), &first).unwrap();
        let applied = fs::read_to_string(workspace.path().join("AGENTS.md")).unwrap();
        assert!(applied.contains("old memory"));
        assert!(!applied.contains("new memory"));
        assert!(applied.contains("root-cause"));
        assert!(!applied.contains("keep-a-memory"));
    }

    #[test]
    fn a_workspace_receives_agents_md_and_claude_md() {
        let root = TempDir::new("workspace-agent");
        write_agent_files(root.path(), "remember the release date", "prefers short replies", &["root-cause"]);
        let recipe = snapshot(root.path(), "Ship the local note.");

        let workspace = TempDir::new("workspace");
        fs::write(workspace.path().join("README.md"), "project readme").unwrap();
        let before = std::env::current_dir().unwrap();

        apply_recipe(workspace.path(), &recipe).unwrap();

        let agents = fs::read_to_string(workspace.path().join("AGENTS.md")).unwrap();
        let claude = fs::read_to_string(workspace.path().join("CLAUDE.md")).unwrap();
        let expected = format!(
            "# Agent Instructions\n\nAgent ID: `{AGENT_ID}`\n\n## Role & Charter\n\nShip the local note.\n\nKite Code automatically synchronizes this context from memory, builder context, skills, and teammates.\n\n## Long-Term Memory (memory.txt)\n\nremember the release date\n\n## Builder Context & Preferences (user.txt)\n\nprefers short replies\n\n## Learned Skills\n\n- `root-cause`\n\n"
        );
        assert_eq!(agents, expected);
        assert_eq!(claude, expected);
        assert_eq!(
            fs::read_to_string(workspace.path().join("README.md")).unwrap(),
            "project readme"
        );
        assert!(!workspace.path().join("memory.txt").exists());
        assert_eq!(std::env::current_dir().unwrap(), before);

        apply_recipe(workspace.path(), &recipe).unwrap();
        assert_eq!(
            fs::read_to_string(workspace.path().join("AGENTS.md")).unwrap(),
            agents
        );
    }

    #[test]
    fn an_unknown_agent_has_no_snapshot() {
        let root = TempDir::new("unknown");

        assert_eq!(snapshot_from_profiles(root.path(), &[], AGENT_ID), None);
        assert_eq!(
            snapshot_from_profiles(root.path(), &[profile("role")], "not-an-agent"),
            None
        );
    }
}
