use crate::persist::{body, workspace_path};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitError {
    pub code: String,
    pub message: String,
}

impl GitError {
    pub fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.to_string(),
            message: message.to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpstreamInfo {
    pub ahead: u64,
    pub behind: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileChange {
    pub path: String,
    pub status: String, // "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted"
    pub old_path: Option<String>,
    pub staged: bool,
    pub unstaged: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceChanges {
    pub is_repo: bool,
    pub branch: Option<String>,
    pub files: Vec<WorkspaceFileChange>,
    pub workspace_prefix: String,
    pub upstream: Option<UpstreamInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: String, // "context" | "added" | "removed" | "hunk" | "meta"
    pub old_number: Option<u64>,
    pub new_number: Option<u64>,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileDiff {
    pub lines: Vec<DiffLine>,
    pub truncated: bool,
}

fn resolve_workspace_dir(req: &Value) -> Result<PathBuf, GitError> {
    let ws_id = req
        .get("workspaceId")
        .or_else(|| req.get("workspace_id"))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    if !ws_id.is_empty() {
        if let Some(p) = workspace_path(ws_id) {
            let path = PathBuf::from(p);
            if path.is_dir() {
                return Ok(path);
            }
        }
        let direct = PathBuf::from(ws_id);
        if direct.is_dir() {
            return Ok(direct);
        }
    }

    if let Some(folder) = req
        .get("folderPath")
        .or_else(|| req.get("path"))
        .and_then(|v| v.as_str())
    {
        let direct = PathBuf::from(folder);
        if direct.is_dir() {
            return Ok(direct);
        }
    }

    Err(GitError::new(
        "not_a_repository",
        "That workspace folder is unavailable.",
    ))
}

fn run_git(dir: &Path, args: &[&str]) -> Result<std::process::Output, GitError> {
    let mut cmd = std::process::Command::new("git");
    cmd.current_dir(dir);
    cmd.args(args);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    match cmd.output() {
        Ok(output) => Ok(output),
        Err(err) => Err(GitError::new(
            "git_failed",
            &format!("Failed to execute git: {err}"),
        )),
    }
}

fn run_git_checked(dir: &Path, args: &[&str]) -> Result<String, GitError> {
    let output = run_git(dir, args)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let msg = if !stderr.is_empty() { stderr } else { stdout };

        if msg.contains("not a git repository") {
            return Err(GitError::new(
                "not_a_repository",
                "This folder isn't inside a git repository.",
            ));
        }
        if msg.contains("did not match any file(s) known to git") {
            return Err(GitError::new(
                "untracked_discard_unsupported",
                "Git has no saved copy of an untracked file to restore.",
            ));
        }
        if msg.contains("No configured push destination")
            || msg.contains("has no upstream branch")
            || msg.contains("fatal: The current branch")
        {
            return Err(GitError::new(
                "no_remote",
                "This repository has no remote to push to.",
            ));
        }

        return Err(GitError::new("git_failed", &msg));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn clean_path(raw: &str) -> String {
    let trimmed = raw.trim();
    let unquoted = if trimmed.starts_with('"') && trimmed.ends_with('"') && trimmed.len() >= 2 {
        &trimmed[1..trimmed.len() - 1]
    } else {
        trimmed
    };
    unquoted.replace('\\', "/")
}

pub fn parse_porcelain_v2(
    output: &str,
) -> (Option<String>, Option<UpstreamInfo>, Vec<WorkspaceFileChange>) {
    let mut branch = None;
    let mut upstream = None;
    let mut files = Vec::new();

    for line in output.lines() {
        if line.starts_with("# branch.head ") {
            let head = line["# branch.head ".len()..].trim();
            if head != "(detached)" && !head.is_empty() {
                branch = Some(head.to_string());
            }
        } else if line.starts_with("# branch.ab ") {
            let ab = line["# branch.ab ".len()..].trim();
            let mut parts = ab.split_whitespace();
            let ahead_str = parts.next().unwrap_or("").trim_start_matches('+');
            let behind_str = parts.next().unwrap_or("").trim_start_matches('-');
            let ahead = ahead_str.parse::<u64>().unwrap_or(0);
            let behind = behind_str.parse::<u64>().unwrap_or(0);
            upstream = Some(UpstreamInfo { ahead, behind });
        } else if line.starts_with("1 ") {
            // Ordinary changed entry:
            // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
            let parts: Vec<&str> = line.splitn(9, ' ').collect();
            if parts.len() >= 9 {
                let xy = parts[1];
                let path = clean_path(parts[8]);
                let x = xy.chars().next().unwrap_or('.');
                let y = xy.chars().nth(1).unwrap_or('.');
                let staged = x != '.';
                let unstaged = y != '.';
                let status = if x == 'A' && y != 'D' {
                    "added"
                } else if x == 'D' || y == 'D' {
                    "deleted"
                } else if x == 'R' {
                    "renamed"
                } else {
                    "modified"
                };
                files.push(WorkspaceFileChange {
                    path,
                    status: status.to_string(),
                    old_path: None,
                    staged,
                    unstaged,
                });
            }
        } else if line.starts_with("2 ") {
            // Renamed/copied entry:
            // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path><TAB><origPath>
            let parts: Vec<&str> = line.splitn(10, ' ').collect();
            if parts.len() >= 10 {
                let xy = parts[1];
                let x = xy.chars().next().unwrap_or('.');
                let y = xy.chars().nth(1).unwrap_or('.');
                let staged = x != '.';
                let unstaged = y != '.';
                let paths_raw = parts[9];
                let (path, orig_path) = match paths_raw.split_once('\t').or_else(|| paths_raw.split_once("\\t")) {
                    Some((p, orig)) => (clean_path(p), Some(clean_path(orig))),
                    None => (clean_path(paths_raw), None),
                };
                files.push(WorkspaceFileChange {
                    path,
                    status: "renamed".to_string(),
                    old_path: orig_path,
                    staged,
                    unstaged,
                });
            }
        } else if line.starts_with("u ") {
            // Unmerged / conflicted entry:
            // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
            let parts: Vec<&str> = line.splitn(11, ' ').collect();
            if parts.len() >= 11 {
                let xy = parts[1];
                let x = xy.chars().next().unwrap_or('.');
                let staged = x != '.';
                let path = clean_path(parts[10]);
                files.push(WorkspaceFileChange {
                    path,
                    status: "conflicted".to_string(),
                    old_path: None,
                    staged,
                    unstaged: true,
                });
            }
        } else if line.starts_with("? ") {
            // Untracked entry:
            let path = clean_path(&line[2..]);
            files.push(WorkspaceFileChange {
                path,
                status: "untracked".to_string(),
                old_path: None,
                staged: false,
                unstaged: true,
            });
        }
    }

    (branch, upstream, files)
}

pub fn parse_hunk_header(line: &str) -> Option<(u64, u64)> {
    let trimmed = line.trim();
    if !trimmed.starts_with("@@") {
        return None;
    }
    let rest = trimmed.strip_prefix("@@")?.trim_start();
    let end_idx = rest.find("@@")?;
    let header_content = rest[..end_idx].trim();
    let mut parts = header_content.split_whitespace();
    let old_part = parts.next()?;
    let new_part = parts.next()?;

    let old_start = old_part
        .strip_prefix('-')?
        .split(',')
        .next()?
        .parse::<u64>()
        .unwrap_or(1);

    let new_start = new_part
        .strip_prefix('+')?
        .split(',')
        .next()?
        .parse::<u64>()
        .unwrap_or(1);

    Some((old_start, new_start))
}

pub fn parse_unified_diff(diff_str: &str) -> (Vec<DiffLine>, bool) {
    let mut lines = Vec::new();
    let mut truncated = false;
    let mut old_counter: u64 = 1;
    let mut new_counter: u64 = 1;

    for line in diff_str.lines() {
        if lines.len() >= 10_000 {
            truncated = true;
            break;
        }

        if line.starts_with("diff ")
            || line.starts_with("index ")
            || line.starts_with("--- ")
            || line.starts_with("+++ ")
            || line.starts_with("similarity ")
            || line.starts_with("rename ")
            || line.starts_with("new file ")
            || line.starts_with("deleted file ")
        {
            lines.push(DiffLine {
                kind: "meta".to_string(),
                old_number: None,
                new_number: None,
                text: line.to_string(),
            });
        } else if line.starts_with("@@") {
            if let Some((old_start, new_start)) = parse_hunk_header(line) {
                old_counter = old_start;
                new_counter = new_start;
            }
            lines.push(DiffLine {
                kind: "hunk".to_string(),
                old_number: None,
                new_number: None,
                text: line.to_string(),
            });
        } else if line.starts_with('+') {
            lines.push(DiffLine {
                kind: "added".to_string(),
                old_number: None,
                new_number: Some(new_counter),
                text: line[1..].to_string(),
            });
            new_counter = new_counter.saturating_add(1);
        } else if line.starts_with('-') {
            lines.push(DiffLine {
                kind: "removed".to_string(),
                old_number: Some(old_counter),
                new_number: None,
                text: line[1..].to_string(),
            });
            old_counter = old_counter.saturating_add(1);
        } else if line.starts_with('\\') {
            lines.push(DiffLine {
                kind: "meta".to_string(),
                old_number: None,
                new_number: None,
                text: line.to_string(),
            });
        } else {
            let text = if line.starts_with(' ') {
                &line[1..]
            } else {
                line
            };
            lines.push(DiffLine {
                kind: "context".to_string(),
                old_number: Some(old_counter),
                new_number: Some(new_counter),
                text: text.to_string(),
            });
            old_counter = old_counter.saturating_add(1);
            new_counter = new_counter.saturating_add(1);
        }
    }

    (lines, truncated)
}

pub fn read_workspace_changes_internal(dir: &Path) -> Result<WorkspaceChanges, GitError> {
    let check = run_git(dir, &["rev-parse", "--is-inside-work-tree"]);
    let is_repo = match check {
        Ok(out) => out.status.success() && String::from_utf8_lossy(&out.stdout).trim() == "true",
        Err(_) => false,
    };

    if !is_repo {
        return Ok(WorkspaceChanges {
            is_repo: false,
            branch: None,
            files: Vec::new(),
            workspace_prefix: String::new(),
            upstream: None,
        });
    }

    let prefix_out = run_git(dir, &["rev-parse", "--show-prefix"])
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
        .replace('\\', "/");
    let workspace_prefix = if !prefix_out.is_empty() && !prefix_out.ends_with('/') {
        format!("{prefix_out}/")
    } else {
        prefix_out
    };

    let status_out = run_git(
        dir,
        &[
            "-c",
            "core.quotepath=false",
            "status",
            "--porcelain=v2",
            "--branch",
            "-uall",
            ".",
        ],
    )?;
    if !status_out.status.success() {
        let stderr = String::from_utf8_lossy(&status_out.stderr).trim().to_string();
        return Err(GitError::new("git_failed", &stderr));
    }

    let stdout_str = String::from_utf8_lossy(&status_out.stdout);
    let (branch, upstream, files) = parse_porcelain_v2(&stdout_str);

    Ok(WorkspaceChanges {
        is_repo: true,
        branch,
        files,
        workspace_prefix,
        upstream,
    })
}

#[tauri::command]
pub fn read_workspace_changes(request: Option<Value>) -> Result<WorkspaceChanges, GitError> {
    let req = body(&request).ok_or_else(|| {
        GitError::new("invalid_request", "Missing request parameters.")
    })?;
    let dir = match resolve_workspace_dir(req) {
        Ok(d) => d,
        Err(_) => {
            return Ok(WorkspaceChanges {
                is_repo: false,
                branch: None,
                files: Vec::new(),
                workspace_prefix: String::new(),
                upstream: None,
            });
        }
    };
    read_workspace_changes_internal(&dir)
}

#[tauri::command]
pub fn read_workspace_file_diff(request: Option<Value>) -> Result<WorkspaceFileDiff, GitError> {
    let req = body(&request).ok_or_else(|| {
        GitError::new("invalid_request", "Missing request parameters.")
    })?;
    let dir = resolve_workspace_dir(req)?;
    let path = req.get("path").and_then(|v| v.as_str()).unwrap_or("");
    let untracked = req.get("untracked").and_then(|v| v.as_bool()).unwrap_or(false);

    if path.is_empty() {
        return Err(GitError::new("invalid_request", "File path is required."));
    }

    if untracked {
        let full_path = dir.join(path);
        let content = std::fs::read_to_string(&full_path).map_err(|e| {
            GitError::new("git_failed", &format!("Cannot read untracked file: {e}"))
        })?;
        let mut lines = Vec::new();
        let mut truncated = false;
        for (idx, line) in content.lines().enumerate() {
            if idx >= 10_000 {
                truncated = true;
                break;
            }
            lines.push(DiffLine {
                kind: "added".to_string(),
                old_number: None,
                new_number: Some((idx + 1) as u64),
                text: line.to_string(),
            });
        }
        return Ok(WorkspaceFileDiff { lines, truncated });
    }

    let diff_output = run_git(&dir, &["-c", "core.quotepath=false", "diff", "HEAD", "--", path])?;
    let diff_str = if diff_output.status.success() {
        String::from_utf8_lossy(&diff_output.stdout).to_string()
    } else {
        let fallback = run_git(&dir, &["-c", "core.quotepath=false", "diff", "--", path])?;
        String::from_utf8_lossy(&fallback.stdout).to_string()
    };

    let (lines, truncated) = parse_unified_diff(&diff_str);
    Ok(WorkspaceFileDiff { lines, truncated })
}

#[tauri::command]
pub fn stage_workspace_changes(request: Option<Value>) -> Result<WorkspaceChanges, GitError> {
    let req = body(&request).ok_or_else(|| {
        GitError::new("invalid_request", "Missing request parameters.")
    })?;
    let dir = resolve_workspace_dir(req)?;
    let paths_val = req.get("paths").and_then(|v| v.as_array());
    let paths_str: Vec<&str> = paths_val
        .map(|arr| arr.iter().filter_map(|v| v.as_str()).collect())
        .unwrap_or_default();
    if paths_str.is_empty() {
        return read_workspace_changes_internal(&dir);
    }
    let mut args = vec!["add", "--"];
    for p in &paths_str {
        args.push(p);
    }
    run_git_checked(&dir, &args)?;
    read_workspace_changes_internal(&dir)
}

#[tauri::command]
pub fn stage_all_workspace_changes(request: Option<Value>) -> Result<WorkspaceChanges, GitError> {
    let req = body(&request).ok_or_else(|| {
        GitError::new("invalid_request", "Missing request parameters.")
    })?;
    let dir = resolve_workspace_dir(req)?;
    run_git_checked(&dir, &["add", "-A"])?;
    read_workspace_changes_internal(&dir)
}

#[tauri::command]
pub fn unstage_workspace_changes(request: Option<Value>) -> Result<WorkspaceChanges, GitError> {
    let req = body(&request).ok_or_else(|| {
        GitError::new("invalid_request", "Missing request parameters.")
    })?;
    let dir = resolve_workspace_dir(req)?;
    let paths_val = req.get("paths").and_then(|v| v.as_array());
    let paths_str: Vec<&str> = paths_val
        .map(|arr| arr.iter().filter_map(|v| v.as_str()).collect())
        .unwrap_or_default();
    if paths_str.is_empty() {
        return read_workspace_changes_internal(&dir);
    }

    let mut args = vec!["restore", "--staged", "--"];
    for p in &paths_str {
        args.push(p);
    }
    let res = run_git(&dir, &args);
    if let Ok(output) = res {
        if !output.status.success() {
            let mut reset_args = vec!["reset", "HEAD", "--"];
            for p in &paths_str {
                reset_args.push(p);
            }
            run_git_checked(&dir, &reset_args)?;
        }
    } else {
        return Err(GitError::new("git_failed", "Failed to run git restore"));
    }

    read_workspace_changes_internal(&dir)
}

#[tauri::command]
pub fn discard_workspace_changes(request: Option<Value>) -> Result<WorkspaceChanges, GitError> {
    let req = body(&request).ok_or_else(|| {
        GitError::new("invalid_request", "Missing request parameters.")
    })?;
    let dir = resolve_workspace_dir(req)?;
    let paths_val = req.get("paths").and_then(|v| v.as_array());
    let paths_str: Vec<&str> = paths_val
        .map(|arr| arr.iter().filter_map(|v| v.as_str()).collect())
        .unwrap_or_default();
    if paths_str.is_empty() {
        return read_workspace_changes_internal(&dir);
    }

    let mut args = vec!["restore", "--"];
    for p in &paths_str {
        args.push(p);
    }
    let output = run_git(&dir, &args)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("did not match any file(s) known to git") {
            return Err(GitError::new(
                "untracked_discard_unsupported",
                "Git has no saved copy of an untracked file to restore.",
            ));
        }
        let mut checkout_args = vec!["checkout", "--"];
        for p in &paths_str {
            checkout_args.push(p);
        }
        run_git_checked(&dir, &checkout_args)?;
    }

    read_workspace_changes_internal(&dir)
}

#[tauri::command]
pub fn commit_workspace_changes(request: Option<Value>) -> Result<WorkspaceChanges, GitError> {
    let req = body(&request).ok_or_else(|| {
        GitError::new("invalid_request", "Missing request parameters.")
    })?;
    let dir = resolve_workspace_dir(req)?;
    let message = req
        .get("message")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if message.is_empty() {
        return Err(GitError::new(
            "git_failed",
            "Commit message cannot be empty.",
        ));
    }
    let stage_all = req
        .get("stageAll")
        .or_else(|| req.get("stage_all"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if stage_all {
        run_git_checked(&dir, &["add", "-A"])?;
    }

    run_git_checked(&dir, &["commit", "-m", message])?;
    read_workspace_changes_internal(&dir)
}

#[tauri::command]
pub fn pull_workspace_changes(request: Option<Value>) -> Result<WorkspaceChanges, GitError> {
    let req = body(&request).ok_or_else(|| {
        GitError::new("invalid_request", "Missing request parameters.")
    })?;
    let dir = resolve_workspace_dir(req)?;
    run_git_checked(&dir, &["pull"])?;
    read_workspace_changes_internal(&dir)
}

#[tauri::command]
pub fn push_workspace_changes(request: Option<Value>) -> Result<WorkspaceChanges, GitError> {
    let req = body(&request).ok_or_else(|| {
        GitError::new("invalid_request", "Missing request parameters.")
    })?;
    let dir = resolve_workspace_dir(req)?;
    run_git_checked(&dir, &["push"])?;
    read_workspace_changes_internal(&dir)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceBranches {
    pub current: Option<String>,
    pub branches: Vec<String>,
}

pub fn list_workspace_branches_internal(dir: &Path) -> Result<WorkspaceBranches, GitError> {
    let output = run_git_checked(dir, &["branch", "--list", "--no-color"])?;
    let mut current = None;
    let mut branches = Vec::new();

    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if line.starts_with('*') {
            let name = line[1..].trim().to_string();
            if !name.starts_with('(') {
                current = Some(name.clone());
                branches.push(name);
            }
        } else {
            branches.push(trimmed.to_string());
        }
    }

    if current.is_none() {
        if let Ok(curr) = run_git_checked(dir, &["branch", "--show-current"]) {
            let curr_trimmed = curr.trim();
            if !curr_trimmed.is_empty() {
                current = Some(curr_trimmed.to_string());
                if !branches.contains(&curr_trimmed.to_string()) {
                    branches.insert(0, curr_trimmed.to_string());
                }
            }
        }
    }

    Ok(WorkspaceBranches { current, branches })
}

#[tauri::command]
pub fn list_workspace_branches(request: Option<Value>) -> Result<WorkspaceBranches, GitError> {
    let req = body(&request).cloned().unwrap_or(Value::Null);
    let dir = resolve_workspace_dir(&req)?;
    list_workspace_branches_internal(&dir)
}

#[tauri::command]
pub fn switch_workspace_branch(request: Option<Value>) -> Result<WorkspaceBranches, GitError> {
    let req = body(&request).cloned().unwrap_or(Value::Null);
    let dir = resolve_workspace_dir(&req)?;
    let branch = req
        .get("branch")
        .and_then(|v| v.as_str())
        .ok_or_else(|| GitError::new("missing_branch", "Branch name is required."))?;

    run_git_checked(&dir, &["checkout", branch])?;
    list_workspace_branches_internal(&dir)
}

#[tauri::command]
pub fn create_workspace_branch(request: Option<Value>) -> Result<WorkspaceBranches, GitError> {
    let req = body(&request).cloned().unwrap_or(Value::Null);
    let dir = resolve_workspace_dir(&req)?;
    let branch = req
        .get("branch")
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| GitError::new("missing_branch", "Branch name cannot be empty."))?;

    run_git_checked(&dir, &["checkout", "-b", branch])?;
    list_workspace_branches_internal(&dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_porcelain_v2_clean() {
        let sample = "\
# branch.oid 09e93f22d9e475660f89f535d178a7ed1281ac90
# branch.head main
# branch.upstream origin/main
# branch.ab +2 -1
";
        let (branch, upstream, files) = parse_porcelain_v2(sample);
        assert_eq!(branch.as_deref(), Some("main"));
        assert!(upstream.is_some());
        let up = upstream.unwrap();
        assert_eq!(up.ahead, 2);
        assert_eq!(up.behind, 1);
        assert!(files.is_empty());
    }

    #[test]
    fn test_parse_porcelain_v2_changes() {
        let sample = "\
# branch.oid 09e93f22d9e475660f89f535d178a7ed1281ac90
# branch.head feature-x
1 .M N... 100644 100644 100644 hash1 hash2 Cargo.toml
1 M. N... 100644 100644 100644 hash1 hash2 staged.rs
1 A. N... 000000 100644 100644 hash1 hash2 added.rs
1 .D N... 100644 000000 000000 hash1 hash2 deleted.rs
2 R. N... 100644 100644 100644 hash1 hash2 R100 new.rs\told.rs
u UU N... 100644 100644 100644 100644 h1 h2 h3 conflict.rs
? untracked.txt
";
        let (branch, upstream, files) = parse_porcelain_v2(sample);
        assert_eq!(branch.as_deref(), Some("feature-x"));
        assert!(upstream.is_none());
        assert_eq!(files.len(), 7);

        assert_eq!(files[0].path, "Cargo.toml");
        assert_eq!(files[0].status, "modified");
        assert!(!files[0].staged);
        assert!(files[0].unstaged);

        assert_eq!(files[1].path, "staged.rs");
        assert_eq!(files[1].status, "modified");
        assert!(files[1].staged);
        assert!(!files[1].unstaged);

        assert_eq!(files[2].path, "added.rs");
        assert_eq!(files[2].status, "added");
        assert!(files[2].staged);
        assert!(!files[2].unstaged);

        assert_eq!(files[3].path, "deleted.rs");
        assert_eq!(files[3].status, "deleted");
        assert!(!files[3].staged);
        assert!(files[3].unstaged);

        assert_eq!(files[4].path, "new.rs");
        assert_eq!(files[4].status, "renamed");
        assert_eq!(files[4].old_path.as_deref(), Some("old.rs"));
        assert!(files[4].staged);
        assert!(!files[4].unstaged);

        assert_eq!(files[5].path, "conflict.rs");
        assert_eq!(files[5].status, "conflicted");
        assert!(files[5].staged);
        assert!(files[5].unstaged);

        assert_eq!(files[6].path, "untracked.txt");
        assert_eq!(files[6].status, "untracked");
        assert!(!files[6].staged);
        assert!(files[6].unstaged);
    }

    #[test]
    fn test_parse_hunk_header() {
        assert_eq!(parse_hunk_header("@@ -4,6 +4,7 @@"), Some((4, 4)));
        assert_eq!(parse_hunk_header("@@ -1 +1 @@"), Some((1, 1)));
        assert_eq!(parse_hunk_header("@@ -10,5 +20,8 @@ fn test() {"), Some((10, 20)));
        assert_eq!(parse_hunk_header("not a hunk"), None);
    }

    #[test]
    fn test_parse_unified_diff() {
        let diff = "\
diff --git a/file.txt b/file.txt
index 1234..5678 100644
--- a/file.txt
+++ b/file.txt
@@ -1,3 +1,4 @@
 line 1
-line 2
+line 2 mod
+line 2 extra
 line 3
";
        let (lines, truncated) = parse_unified_diff(diff);
        assert!(!truncated);
        assert_eq!(lines.len(), 10);
        assert_eq!(lines[0].kind, "meta");
        assert_eq!(lines[4].kind, "hunk");
        assert_eq!(lines[5].kind, "context");
        assert_eq!(lines[5].old_number, Some(1));
        assert_eq!(lines[5].new_number, Some(1));
        assert_eq!(lines[6].kind, "removed");
        assert_eq!(lines[6].old_number, Some(2));
        assert_eq!(lines[6].new_number, None);
        assert_eq!(lines[7].kind, "added");
        assert_eq!(lines[7].old_number, None);
        assert_eq!(lines[7].new_number, Some(2));
        assert_eq!(lines[8].kind, "added");
        assert_eq!(lines[8].old_number, None);
        assert_eq!(lines[8].new_number, Some(3));
        assert_eq!(lines[9].kind, "context");
        assert_eq!(lines[9].old_number, Some(3));
        assert_eq!(lines[9].new_number, Some(4));
    }
}
