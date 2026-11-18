use crate::lossless::compact_lossless;
use crate::pipeline::ContentKind;

pub fn filter_git(args: &[String], output: &str, _exit_code: i32) -> Option<(&'static str, String)> {
    let sub = args.iter().find(|a| !a.starts_with('-')).map(String::as_str)?;
    match sub {
        "status" => Some(("git_status", compact_git_status(output))),
        "diff" => Some(("git_diff", compact_lossless(output, ContentKind::Diff))),
        "log" => Some(("git_log", compact_git_log(output))),
        _ => None,
    }
}

fn compact_git_status(output: &str) -> String {
    let mut branch: Option<String> = None;
    let mut staged: Vec<String> = Vec::new();
    let mut modified: Vec<String> = Vec::new();
    let mut untracked: Vec<String> = Vec::new();

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Section {
        None,
        Staged,
        Unstaged,
        Untracked,
    }
    let mut section = Section::None;

    for raw in output.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with("(use \"git ") {
            continue;
        }
        if let Some(rest) = line.strip_prefix("On branch ") {
            branch = Some(rest.to_string());
            continue;
        }
        if line.starts_with("HEAD detached") {
            branch = Some(line.to_string());
            continue;
        }
        if line.starts_with("Changes to be committed") {
            section = Section::Staged;
            continue;
        }
        if line.starts_with("Changes not staged") {
            section = Section::Unstaged;
            continue;
        }
        if line.starts_with("Untracked files") {
            section = Section::Untracked;
            continue;
        }
        if line.starts_with("nothing to commit") || line.starts_with("no changes added") {
            continue;
        }

        // Handle short status (` M file`, `?? file`) or verbose section items.
        match section {
            Section::Staged => staged.push(compact_status_entry(line)),
            Section::Unstaged => modified.push(compact_status_entry(line)),
            Section::Untracked => untracked.push(line.to_string()),
            Section::None => {
                if !line.starts_with("Your branch") {
                    modified.push(line.to_string());
                }
            }
        }
    }

    if staged.is_empty() && modified.is_empty() && untracked.is_empty() {
        if let Some(b) = branch {
            return format!("{b}: clean");
        }
        return output.trim().to_string();
    }

    let mut out = Vec::new();
    if let Some(b) = branch {
        out.push(format!("branch: {b}"));
    }
    if !staged.is_empty() {
        out.push(format!("staged ({}): {}", staged.len(), staged.join(", ")));
    }
    if !modified.is_empty() {
        out.push(format!(
            "modified ({}): {}",
            modified.len(),
            modified.join(", ")
        ));
    }
    if !untracked.is_empty() {
        out.push(format!(
            "untracked ({}): {}",
            untracked.len(),
            untracked.join(", ")
        ));
    }
    out.join("\n")
}

fn compact_status_entry(line: &str) -> String {
    for (prefix, code) in [
        ("modified:", "M"),
        ("new file:", "A"),
        ("deleted:", "D"),
        ("renamed:", "R"),
    ] {
        if let Some(rest) = line.strip_prefix(prefix) {
            return format!("{code} {}", rest.trim());
        }
    }
    line.to_string()
}

fn compact_git_log(output: &str) -> String {
    if !output.contains("commit ") {
        return output.to_string();
    }
    let mut entries = Vec::new();
    let mut sha = String::new();
    let mut author = String::new();
    let mut subject = String::new();

    let flush = |entries: &mut Vec<String>,
                 sha: &mut String,
                 author: &mut String,
                 subject: &mut String| {
        if !sha.is_empty() {
            let short = if sha.len() > 7 { &sha[..7] } else { sha.as_str() };
            if author.is_empty() {
                entries.push(format!("{short} {}", subject.trim()));
            } else {
                entries.push(format!("{short} {} ({})", subject.trim(), author.trim()));
            }
            sha.clear();
            author.clear();
            subject.clear();
        }
    };

    for line in output.lines() {
        if let Some(rest) = line.strip_prefix("commit ") {
            flush(&mut entries, &mut sha, &mut author, &mut subject);
            sha = rest.split_whitespace().next().unwrap_or("").to_string();
        } else if let Some(rest) = line.strip_prefix("Author:") {
            author = rest
                .split('<')
                .next()
                .unwrap_or(rest)
                .trim()
                .to_string();
        } else if line.starts_with("Date:") || line.starts_with("Merge:") {
            continue;
        } else if !line.trim().is_empty() && subject.is_empty() && !sha.is_empty() {
            subject = line.trim().to_string();
        }
    }
    flush(&mut entries, &mut sha, &mut author, &mut subject);

    if entries.is_empty() {
        output.to_string()
    } else {
        entries.join("\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compacts_verbose_git_log_to_oneline() {
        let log = "\
commit abcdef1234567890
Author: Alice <alice@example.com>
Date:   Mon Nov 18 01:00:00 2026 -0300

    feat(ctx): add lossless pipeline

commit 1234567abcdef890
Author: Bob <bob@example.com>
Date:   Mon Nov 18 00:00:00 2026 -0300

    fix(ctx): handle trailing newline
";
        let compact = compact_git_log(log);
        assert_eq!(
            compact,
            "abcdef1 feat(ctx): add lossless pipeline (Alice)\n1234567 fix(ctx): handle trailing newline (Bob)"
        );
    }
}
