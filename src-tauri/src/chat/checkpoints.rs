//! Hidden Git checkpoints captured before a turn starts.
//!
//! A checkpoint is a ref under `refs/kite/checkpoints/<thread>/<run>`. Capture
//! uses `git stash create` and `git update-ref`, so it does not commit on the
//! user's branch and does not move HEAD. File restore is refused before any
//! git command unless the provider can rewind and the thread has its own
//! isolated checkout.

use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

pub const CHECKPOINT_REF_PREFIX: &str = "refs/kite/checkpoints";

pub const PROVIDER_CANNOT_REWIND: &str = "The provider cannot rewind this conversation.";

pub const CHECKOUT_NOT_ISOLATED: &str =
    "File restore stays off unless this thread has its own isolated checkout.";

/// `refs/kite/checkpoints/<thread>/<run>`. `/` and spaces cannot add a component.
pub fn checkpoint_ref_name(thread_id: &str, run_id: &str) -> String {
    format!(
        "{CHECKPOINT_REF_PREFIX}/{}/{}",
        sanitize_ref_component(thread_id),
        sanitize_ref_component(run_id)
    )
}

/// True only for an explicit JSON boolean `providerCanRewind: true`.
pub fn provider_can_rewind(thread: &Value) -> bool {
    thread.get("providerCanRewind").and_then(Value::as_bool) == Some(true)
}

/// True only for an explicit JSON boolean `isolatedCheckout: true`. Missing is false.
pub fn isolated_checkout(thread: &Value) -> bool {
    thread.get("isolatedCheckout").and_then(Value::as_bool) == Some(true)
}

/// The refusal, if file restore must not run. This reads JSON only.
pub fn file_restore_refusal(thread: &Value) -> Option<&'static str> {
    if !provider_can_rewind(thread) {
        return Some(PROVIDER_CANNOT_REWIND);
    }
    if !isolated_checkout(thread) {
        return Some(CHECKOUT_NOT_ISOLATED);
    }
    None
}

/// Stores `checkpointRef` on the thread value. Persistence is the caller's job.
pub fn record_checkpoint_ref(thread: &mut Value, ref_name: &str) {
    if let Some(object) = thread.as_object_mut() {
        object.insert(
            "checkpointRef".to_string(),
            Value::String(ref_name.to_string()),
        );
    }
}

/// The workspace folder for a thread, when one is registered and present.
pub fn workspace_dir(thread: &Value) -> Option<PathBuf> {
    let id = thread
        .get("workspaceId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())?;
    let folder = crate::persist::workspace_path(id)?;
    let path = PathBuf::from(folder);
    if path.is_dir() {
        Some(path)
    } else {
        None
    }
}

/// Captures a checkpoint for the thread's workspace. `None` means the turn still starts.
pub fn capture_for_thread(thread: &Value, thread_id: &str, run_id: &str) -> Option<String> {
    let dir = workspace_dir(thread)?;
    capture_turn_checkpoint(&dir, thread_id, run_id)
}

/// Writes `refs/kite/checkpoints/<thread>/<run>` without moving HEAD.
///
/// A missing folder, a non-repo, and any git failure return `None`. A clean
/// tree has no stash object, so the hidden ref points at the current HEAD.
pub fn capture_turn_checkpoint(worktree: &Path, thread_id: &str, run_id: &str) -> Option<String> {
    if !worktree.is_dir() {
        return None;
    }
    let ref_name = checkpoint_ref_name(thread_id, run_id);
    if !is_safe_checkpoint_ref(&ref_name) {
        return None;
    }
    let hash = stash_or_head(worktree)?;
    update_ref(worktree, &ref_name, &hash).ok()?;
    Some(ref_name)
}

/// Restores tracked files from `checkpointRef`.
///
/// The refusal check returns before any git command. A shared checkout and a
/// provider that cannot rewind never reach a worktree write.
pub fn restore_workspace_files(thread: &Value, worktree: &Path) -> Result<(), String> {
    if let Some(reason) = file_restore_refusal(thread) {
        return Err(reason.to_string());
    }
    let checkpoint_ref = thread
        .get("checkpointRef")
        .and_then(Value::as_str)
        .filter(|name| is_safe_checkpoint_ref(name))
        .ok_or_else(|| "No checkpoint is stored for this thread.".to_string())?;
    if !worktree.is_dir() {
        return Err("The workspace folder is unavailable.".to_string());
    }
    apply_checkpoint(worktree, checkpoint_ref)
}

fn sanitize_ref_component(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len().max(1));
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            out.push(ch);
        } else {
            out.push('-');
        }
    }
    while out.contains("..") {
        out = out.replace("..", "-");
    }
    if out.is_empty() {
        "checkpoint".to_string()
    } else {
        out
    }
}

fn is_safe_checkpoint_ref(name: &str) -> bool {
    let Some(rest) = name.strip_prefix(&format!("{CHECKPOINT_REF_PREFIX}/")) else {
        return false;
    };
    let mut parts = rest.split('/');
    let Some(thread) = parts.next() else {
        return false;
    };
    let Some(run) = parts.next() else {
        return false;
    };
    parts.next().is_none() && component_ok(thread) && component_ok(run)
}

fn component_ok(part: &str) -> bool {
    !part.is_empty()
        && part != "."
        && part != ".."
        && !part.ends_with(".lock")
        && part
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
}

fn is_oid(text: &str) -> bool {
    let text = text.trim();
    (text.len() == 40 || text.len() == 64) && text.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn stash_or_head(worktree: &Path) -> Option<String> {
    let output = git(worktree, &["stash", "create"]).ok()?;
    if !output.status.success() {
        return None;
    }
    if let Some(hash) = first_oid(&output.stdout) {
        return Some(hash);
    }
    // Clean tree: `stash create` prints nothing and does not move HEAD.
    let head = git(worktree, &["rev-parse", "--verify", "HEAD"]).ok()?;
    if !head.status.success() {
        return None;
    }
    first_oid(&head.stdout)
}

fn update_ref(worktree: &Path, ref_name: &str, hash: &str) -> Result<(), ()> {
    if !is_safe_checkpoint_ref(ref_name) || !is_oid(hash) {
        return Err(());
    }
    let output = git(worktree, &["update-ref", ref_name, hash]).map_err(|_| ())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(())
    }
}

fn apply_checkpoint(worktree: &Path, checkpoint_ref: &str) -> Result<(), String> {
    let output = git(
        worktree,
        &[
            "restore",
            "--source",
            checkpoint_ref,
            "--worktree",
            "--staged",
            "--",
            ".",
        ],
    )
    .map_err(|err| format!("Failed to execute git: {err}"))?;
    if output.status.success() {
        return Ok(());
    }
    let fallback = git(worktree, &["read-tree", "--reset", "-u", checkpoint_ref])
        .map_err(|err| format!("Failed to execute git: {err}"))?;
    if fallback.status.success() {
        return Ok(());
    }
    Err(clip_git_error(&output))
}

fn first_oid(bytes: &[u8]) -> Option<String> {
    String::from_utf8_lossy(bytes)
        .lines()
        .map(str::trim)
        .find(|line| is_oid(line))
        .map(str::to_string)
}

fn clip_git_error(output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let msg = if !stderr.is_empty() { stderr } else { stdout };
    let clipped: String = msg.chars().take(400).collect();
    if clipped.is_empty() {
        "git failed".to_string()
    } else {
        clipped
    }
}

fn git(worktree: &Path, args: &[&str]) -> std::io::Result<Output> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(worktree);
    cmd.args(args);
    cmd.env_remove("GIT_DIR");
    cmd.env_remove("GIT_WORK_TREE");
    cmd.env_remove("GIT_INDEX_FILE");
    cmd.env("GIT_AUTHOR_NAME", "Kite");
    cmd.env("GIT_AUTHOR_EMAIL", "kite-checkpoint@localhost");
    cmd.env("GIT_COMMITTER_NAME", "Kite");
    cmd.env("GIT_COMMITTER_EMAIL", "kite-checkpoint@localhost");
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.output()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    const PREFIX: &str = "refs/kite/checkpoints/";
    const PROVIDER_CANNOT_REWIND: &str = "The provider cannot rewind this conversation.";
    const CHECKOUT_NOT_ISOLATED: &str =
        "File restore stays off unless this thread has its own isolated checkout.";

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "kite-checkpoint-{label}-{}-{nanos}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("create temp dir");
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

    fn assert_under_prefix(name: &str) {
        assert!(name.starts_with(PREFIX), "{name}");
        let rest = &name[PREFIX.len()..];
        let parts: Vec<&str> = rest.split('/').collect();
        assert_eq!(parts.len(), 2, "{name}");
        for part in parts {
            assert!(!part.is_empty(), "{name}");
            assert!(part != "." && part != "..", "{name}");
            assert!(!part.contains(' '), "{name}");
            assert!(!part.contains('\\'), "{name}");
            assert!(!part.contains(".."), "{name}");
        }
    }

    #[test]
    fn checkpoint_ref_uses_thread_and_run_and_a_slash_cannot_escape() {
        assert_eq!(
            checkpoint_ref_name("thread-1", "run-1"),
            "refs/kite/checkpoints/thread-1/run-1"
        );
        assert_under_prefix(&checkpoint_ref_name("thread-1", "run-1"));

        let escaped = checkpoint_ref_name("thread/../../outside", "run/../id");
        assert_under_prefix(&escaped);
        assert!(!escaped.contains(".."), "{escaped}");
        assert!(!escaped.contains(' '), "{escaped}");

        let spaced = checkpoint_ref_name("my thread", "my run");
        assert_under_prefix(&spaced);
        assert!(!spaced.contains(' '), "{spaced}");
        assert_eq!(spaced, "refs/kite/checkpoints/my-thread/my-run");
    }

    fn git_available() -> bool {
        hidden_git(&std::env::temp_dir(), &["--version"])
            .map(|output| output.status.success())
            .unwrap_or(false)
    }

    fn hidden_git(dir: &Path, args: &[&str]) -> std::io::Result<std::process::Output> {
        let mut cmd = Command::new("git");
        cmd.arg("-C").arg(dir).args(args);
        cmd.env_remove("GIT_DIR");
        cmd.env_remove("GIT_WORK_TREE");
        cmd.env_remove("GIT_INDEX_FILE");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        cmd.output()
    }

    fn git(dir: &Path, args: &[&str]) -> std::process::Output {
        hidden_git(dir, args).expect("git is on PATH")
    }

    fn skip_without_git(label: &str) -> bool {
        if git_available() {
            return false;
        }
        eprintln!("git is not on PATH; skipping git integration test: {label}");
        true
    }

    fn init_repo(dir: &Path) {
        let init = git(dir, &["init"]);
        assert!(
            init.status.success(),
            "git init: {}",
            String::from_utf8_lossy(&init.stderr)
        );
        assert!(git(dir, &["config", "user.email", "kite-tests@example.com"])
            .status
            .success());
        assert!(git(dir, &["config", "user.name", "Kite Tests"])
            .status
            .success());
        assert!(git(dir, &["config", "core.autocrlf", "false"])
            .status
            .success());
    }

    fn commit_file(dir: &Path, name: &str, contents: &str, message: &str) {
        fs::write(dir.join(name), contents).unwrap();
        assert!(git(dir, &["add", name]).status.success());
        let commit = git(dir, &["commit", "-m", message]);
        assert!(
            commit.status.success(),
            "git commit: {}",
            String::from_utf8_lossy(&commit.stderr)
        );
    }

    fn rev_parse(dir: &Path, name: &str) -> String {
        let output = git(dir, &["rev-parse", name]);
        assert!(
            output.status.success(),
            "rev-parse {name}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn list_refs(dir: &Path) -> String {
        let output = git(dir, &["for-each-ref", "--format=%(refname)"]);
        assert!(output.status.success());
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    #[test]
    fn capture_on_a_missing_folder_does_not_fail() {
        let missing = std::env::temp_dir().join(format!(
            "kite-checkpoint-missing-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        assert!(!missing.exists());
        assert!(capture_turn_checkpoint(&missing, "thread-1", "run-1").is_none());
        assert!(!missing.exists());
    }

    #[test]
    fn a_thread_without_a_workspace_does_not_capture() {
        let thread = json!({ "id": "thread-1" });
        assert!(capture_for_thread(&thread, "thread-1", "run-1").is_none());
    }

    #[test]
    fn capture_outside_a_git_repo_does_not_fail() {
        let dir = TempDir::new("not-a-repo");
        fs::write(dir.path().join("note.txt"), "plain").unwrap();
        assert!(capture_turn_checkpoint(dir.path(), "thread-1", "run-1").is_none());
        assert_eq!(
            fs::read_to_string(dir.path().join("note.txt")).unwrap(),
            "plain"
        );
    }

    #[test]
    fn file_restore_is_refused_when_the_provider_cannot_rewind_before_any_git_write() {
        let dir = TempDir::new("refuse-rewind");
        let note = dir.path().join("note.txt");
        fs::write(&note, "keep-me").unwrap();
        let repo = if git_available() {
            init_repo(dir.path());
            commit_file(dir.path(), "note.txt", "base\n", "base");
            fs::write(&note, "dirty-and-must-stay\n").unwrap();
            true
        } else {
            eprintln!(
                "git is not on PATH; refusal still runs against a plain directory, without a git worktree proof"
            );
            false
        };
        let before = fs::read(&note).unwrap();
        let refs_before = repo.then(|| list_refs(dir.path()));
        let head_before = repo.then(|| rev_parse(dir.path(), "HEAD"));

        let thread = json!({
            "providerCanRewind": false,
            "isolatedCheckout": true,
            "checkpointRef": "refs/kite/checkpoints/thread-1/run-1"
        });
        let err = restore_workspace_files(&thread, dir.path()).expect_err("must refuse");
        assert_eq!(err, PROVIDER_CANNOT_REWIND);
        assert_eq!(
            fs::read(&note).unwrap(),
            before,
            "refused restore must not touch the worktree file"
        );
        if repo {
            assert_eq!(list_refs(dir.path()), refs_before.unwrap());
            assert_eq!(rev_parse(dir.path(), "HEAD"), head_before.unwrap());
        }

        let string_true = json!({
            "providerCanRewind": "true",
            "isolatedCheckout": true,
            "checkpointRef": "refs/kite/checkpoints/thread-1/run-1"
        });
        let err = restore_workspace_files(&string_true, dir.path())
            .expect_err("string true is not a bool");
        assert_eq!(err, PROVIDER_CANNOT_REWIND);
        assert_eq!(fs::read(&note).unwrap(), before);
    }

    #[test]
    fn file_restore_is_refused_when_the_checkout_is_not_isolated_even_if_rewind_is_true() {
        let dir = TempDir::new("refuse-shared");
        let note = dir.path().join("note.txt");
        fs::write(&note, "shared-keep").unwrap();
        let repo = if git_available() {
            init_repo(dir.path());
            commit_file(dir.path(), "note.txt", "base\n", "base");
            fs::write(&note, "shared-dirty\n").unwrap();
            true
        } else {
            eprintln!(
                "git is not on PATH; shared-checkout refusal still runs against a plain directory"
            );
            false
        };
        let before = fs::read(&note).unwrap();
        let refs_before = repo.then(|| list_refs(dir.path()));
        let head_before = repo.then(|| rev_parse(dir.path(), "HEAD"));

        for thread in [
            json!({
                "providerCanRewind": true,
                "isolatedCheckout": false,
                "checkpointRef": "refs/kite/checkpoints/thread-1/run-1"
            }),
            json!({
                "providerCanRewind": true,
                "checkpointRef": "refs/kite/checkpoints/thread-1/run-1"
            }),
        ] {
            let err = restore_workspace_files(&thread, dir.path())
                .expect_err("shared checkout must refuse");
            assert_eq!(err, CHECKOUT_NOT_ISOLATED);
            assert_eq!(
                fs::read(&note).unwrap(),
                before,
                "refused restore must not touch the worktree file"
            );
            if repo {
                assert_eq!(list_refs(dir.path()), refs_before.clone().unwrap());
                assert_eq!(rev_parse(dir.path(), "HEAD"), head_before.clone().unwrap());
            }
        }
    }

    #[test]
    fn capture_writes_the_hidden_ref_and_does_not_move_head() {
        if skip_without_git("capture writes the hidden ref") {
            return;
        }
        let dir = TempDir::new("capture");
        init_repo(dir.path());
        commit_file(dir.path(), "note.txt", "base\n", "base");
        let head_before = rev_parse(dir.path(), "HEAD");
        let branch_before = rev_parse(dir.path(), "--abbrev-ref HEAD");
        fs::write(dir.path().join("note.txt"), "dirty\n").unwrap();

        let ref_name = capture_turn_checkpoint(dir.path(), "thread-1", "run-1")
            .expect("capture in a git workspace");
        assert_eq!(ref_name, "refs/kite/checkpoints/thread-1/run-1");
        assert_eq!(rev_parse(dir.path(), "HEAD"), head_before);
        assert_eq!(rev_parse(dir.path(), "--abbrev-ref HEAD"), branch_before);
        assert_eq!(
            fs::read_to_string(dir.path().join("note.txt")).unwrap(),
            "dirty\n"
        );

        let pointed = rev_parse(dir.path(), &ref_name);
        assert_ne!(
            pointed, head_before,
            "a dirty checkpoint must not be HEAD itself"
        );
        let shown = git(dir.path(), &["show", &format!("{ref_name}:note.txt")]);
        assert!(
            shown.status.success(),
            "{}",
            String::from_utf8_lossy(&shown.stderr)
        );
        assert_eq!(String::from_utf8_lossy(&shown.stdout), "dirty\n");

        let mut thread = json!({ "id": "thread-1" });
        record_checkpoint_ref(&mut thread, &ref_name);
        assert_eq!(thread["checkpointRef"], ref_name);

        let escaped = capture_turn_checkpoint(dir.path(), "thread/../../outside", "run id")
            .expect("sanitized capture");
        assert_under_prefix(&escaped);
        assert!(rev_parse(dir.path(), &escaped).len() >= 40);
        assert_eq!(rev_parse(dir.path(), "HEAD"), head_before);
    }

    #[test]
    fn capture_of_a_clean_tree_points_at_head_without_moving_it() {
        if skip_without_git("clean capture") {
            return;
        }
        let dir = TempDir::new("capture-clean");
        init_repo(dir.path());
        commit_file(dir.path(), "note.txt", "base\n", "base");
        let head = rev_parse(dir.path(), "HEAD");
        let ref_name = capture_turn_checkpoint(dir.path(), "thread-1", "run-clean")
            .expect("clean capture");
        assert_eq!(ref_name, "refs/kite/checkpoints/thread-1/run-clean");
        assert_eq!(rev_parse(dir.path(), "HEAD"), head);
        assert_eq!(rev_parse(dir.path(), &ref_name), head);
        assert_eq!(
            fs::read_to_string(dir.path().join("note.txt")).unwrap(),
            "base\n"
        );
    }

    #[test]
    fn file_restore_in_an_isolated_checkout_rewinds_tracked_files_without_moving_head() {
        if skip_without_git("isolated file restore") {
            return;
        }
        let dir = TempDir::new("restore-ok");
        init_repo(dir.path());
        commit_file(dir.path(), "note.txt", "base\n", "base");
        fs::write(dir.path().join("note.txt"), "checkpoint\n").unwrap();
        let head = rev_parse(dir.path(), "HEAD");
        let ref_name = capture_turn_checkpoint(dir.path(), "thread-1", "run-9")
            .expect("capture before restore");
        fs::write(dir.path().join("note.txt"), "after-turn\n").unwrap();
        let thread = json!({
            "providerCanRewind": true,
            "isolatedCheckout": true,
            "checkpointRef": ref_name
        });
        restore_workspace_files(&thread, dir.path()).expect("allowed restore");
        assert_eq!(
            fs::read_to_string(dir.path().join("note.txt")).unwrap(),
            "checkpoint\n"
        );
        assert_eq!(rev_parse(dir.path(), "HEAD"), head);
    }
}
