use std::collections::{BTreeMap, HashMap};

use crate::ccr_store::CcrStore;
use crate::lossless::diff_strip_index;

use super::{fs::filter_search_with_ccr, resolve_subcommand_index, GIT_VALUE_FLAGS};

const SMALL_STATUS_THRESHOLD: usize = 25;
const LARGE_STATUS_CAP_PER_DIR: usize = 10;
const SMALL_DIFF_MAX_LINES: usize = 160;
const SMALL_DIFF_MAX_BYTES: usize = 8_000;
const FOLDED_DIFF_MAX_LINES: usize = 220;
const FOLDED_DIFF_MAX_BYTES: usize = 9_500;
const STAT_DIFF_HUNK_BUDGET_CHARS: usize = 5_500;

pub fn filter_git(args: &[String], output: &str, exit_code: i32) -> Option<(&'static str, String)> {
    filter_git_with_ccr(args, output, exit_code, None)
}

pub fn filter_git_with_ccr(
    args: &[String],
    output: &str,
    _exit_code: i32,
    ccr: Option<&CcrStore>,
) -> Option<(&'static str, String)> {
    let idx = resolve_subcommand_index(args, GIT_VALUE_FLAGS, false)?;
    let sub = args[idx].as_str();
    match sub {
        "status" => Some(("git_status", compact_git_status(output, ccr))),
        "diff" => Some(("git_diff", compact_git_diff(output, ccr))),
        "show" => output
            .contains("diff --git ")
            .then(|| ("git_show", compact_git_diff(output, ccr))),
        "grep" => filter_search_with_ccr(output, ccr).map(|(_, txt)| ("git_grep", txt)),
        "log" => Some(("git_log", compact_git_log(output))),
        _ => None,
    }
}

fn compact_git_status(output: &str, ccr: Option<&CcrStore>) -> String {
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
    let verbose_mode = output.contains("Changes to be committed")
        || output.contains("Changes not staged")
        || output.contains("Untracked files")
        || output.contains("On branch ")
        || output.contains("nothing to commit");

    for raw in output.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with("(use \"git ") {
            continue;
        }
        if let Some(rest) = line.strip_prefix("On branch ") {
            branch = Some(rest.to_string());
            continue;
        }
        if let Some(rest) = line.strip_prefix("## ") {
            branch = Some(rest.split("...").next().unwrap_or(rest).trim().to_string());
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

        if !verbose_mode && raw.len() >= 4 {
            let bytes = raw.as_bytes();
            if bytes[2] == b' ' {
                let x = bytes[0] as char;
                let y = bytes[1] as char;
                let path = raw[3..].trim();
                if x == '?' && y == '?' {
                    untracked.push(path.to_string());
                    continue;
                }
                if x != ' ' && x != '?' {
                    staged.push(format!("{x} {path}"));
                }
                if y != ' ' && y != '?' {
                    modified.push(format!("{y} {path}"));
                }
                continue;
            }
        }

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

    let total_entries = staged.len() + modified.len() + untracked.len();
    if total_entries == 0 {
        if let Some(b) = branch {
            return format!("{b}: clean");
        }
        return output.trim().to_string();
    }

    let mut out = Vec::new();
    if let Some(b) = branch {
        out.push(format!("branch: {b}"));
    }

    if total_entries <= SMALL_STATUS_THRESHOLD {
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
        return out.join("\n");
    }

    let cap = if total_entries > 80 {
        LARGE_STATUS_CAP_PER_DIR
    } else {
        usize::MAX
    };
    if !staged.is_empty() {
        push_grouped_status_section("staged", &staged, cap, &mut out);
    }
    if !modified.is_empty() {
        push_grouped_status_section("modified", &modified, cap, &mut out);
    }
    if !untracked.is_empty() {
        push_grouped_status_section("untracked", &untracked, cap, &mut out);
    }

    let mut rendered = out.join("\n");
    if total_entries > 80 {
        if let Some(hash) = ccr.and_then(|s| s.put(output, &rendered, "cmd_filter", "git status").ok()) {
            rendered.push_str(&format!(
                "\n... [full status ({total_entries} files) in CCR — run `kite ctx retrieve {hash} --search <dir>`] <<ccr:{hash}>>"
            ));
        }
    }
    rendered
}

fn push_grouped_status_section(
    label: &str,
    items: &[String],
    cap_per_dir: usize,
    out: &mut Vec<String>,
) {
    out.push(format!("{label} ({}):", items.len()));
    let mut dirs: Vec<(String, Vec<String>)> = Vec::new();
    let mut dir_idx: HashMap<String, usize> = HashMap::new();

    for item in items {
        let (prefix, path_part) = split_status_prefix(item);
        let norm = path_part.replace('\\', "/");
        let (dir_key, base) = match norm.rfind('/') {
            Some(cut) => (norm[..=cut].to_string(), &norm[cut + 1..]),
            None => ("./".to_string(), norm.as_str()),
        };
        let entry_label = if prefix.is_empty() {
            base.to_string()
        } else {
            format!("{prefix} {base}")
        };
        if let Some(&idx) = dir_idx.get(&dir_key) {
            dirs[idx].1.push(entry_label);
        } else {
            let idx = dirs.len();
            dir_idx.insert(dir_key.clone(), idx);
            dirs.push((dir_key, vec![entry_label]));
        }
    }

    for (dir, names) in dirs {
        if names.len() > cap_per_dir {
            let head = names[..cap_per_dir].join(", ");
            let rem = names.len() - cap_per_dir;
            out.push(format!("  {dir} ({}): {head}, ... (+{rem} more)", names.len()));
        } else {
            out.push(format!("  {dir} ({}): {}", names.len(), names.join(", ")));
        }
    }
}

fn split_status_prefix(item: &str) -> (&str, &str) {
    let bytes = item.as_bytes();
    if bytes.len() >= 3 && bytes[1] == b' ' {
        (&item[..1], item[2..].trim())
    } else {
        ("", item.trim())
    }
}

fn compact_git_diff(output: &str, ccr: Option<&CcrStore>) -> String {
    let stripped = diff_strip_index(output);
    let sections = parse_diff_sections(&stripped);
    if sections.files.is_empty() {
        return stripped;
    }

    let has_generated = sections.files.iter().any(|s| is_lock_or_generated_path(&s.path));
    if !has_generated
        && stripped.lines().count() <= SMALL_DIFF_MAX_LINES
        && stripped.len() <= SMALL_DIFF_MAX_BYTES
    {
        return stripped;
    }

    let mut folded_parts: Vec<String> = Vec::new();
    if !sections.preamble.trim().is_empty() {
        folded_parts.push(sections.preamble.trim_end().to_string());
    }
    for sec in &sections.files {
        if is_lock_or_generated_path(&sec.path) && sec.line_count > 12 {
            folded_parts.push(format!(
                "diff --git a/{0} b/{0}\n[folded generated/lockfile diff: +{1}/-{2} lines]",
                sec.path, sec.adds, sec.dels
            ));
        } else {
            folded_parts.push(sec.body.trim_end().to_string());
        }
    }

    let folded = folded_parts.join("\n");
    if folded.lines().count() <= FOLDED_DIFF_MAX_LINES && folded.len() <= FOLDED_DIFF_MAX_BYTES {
        return folded;
    }

    // Stat-first summary + bounded code hunks + CCR recovery
    let total_adds: usize = sections.files.iter().map(|s| s.adds).sum();
    let total_dels: usize = sections.files.iter().map(|s| s.dels).sum();
    let mut out = Vec::new();
    if !sections.preamble.trim().is_empty() {
        out.push(sections.preamble.trim_end().to_string());
    }
    out.push(format!(
        "[git diff: {} files (+{total_adds}/-{total_dels})]",
        sections.files.len()
    ));

    let mut stats_by_file: BTreeMap<usize, String> = BTreeMap::new();
    for (i, sec) in sections.files.iter().enumerate() {
        if i < 40 {
            stats_by_file.insert(i, format!("  {} (+{}/-{})", sec.path, sec.adds, sec.dels));
        }
    }
    for (_, row) in stats_by_file {
        out.push(row);
    }
    if sections.files.len() > 40 {
        out.push(format!("  ... (+{} more files)", sections.files.len() - 40));
    }

    let mut hunk_chars = 0usize;
    let mut included_sections = 0usize;
    for sec in &sections.files {
        if is_lock_or_generated_path(&sec.path) {
            continue;
        }
        let body = sec.body.trim_end();
        if hunk_chars + body.len() <= STAT_DIFF_HUNK_BUDGET_CHARS || included_sections == 0 {
            if body.len() > STAT_DIFF_HUNK_BUDGET_CHARS && included_sections == 0 {
                let clipped: String = body.chars().take(STAT_DIFF_HUNK_BUDGET_CHARS).collect();
                out.push(clipped);
                included_sections += 1;
                break;
            }
            out.push(body.to_string());
            hunk_chars += body.len();
            included_sections += 1;
        } else {
            break;
        }
    }

    let preview = out.join("\n");
    if let Some(hash) = ccr.and_then(|s| s.put(output, &preview, "cmd_filter", "git diff").ok()) {
        format!(
            "{preview}\n... [full diff ({} lines, {} files) stored in CCR — run `kite ctx retrieve {hash} --search <file>` for specific hunks] <<ccr:{hash}>>",
            output.lines().count(),
            sections.files.len()
        )
    } else {
        format!(
            "{preview}\n... [diff truncated at {} files — showing first {included_sections} file hunks]",
            sections.files.len()
        )
    }
}

struct ParsedDiff {
    preamble: String,
    files: Vec<DiffSection>,
}

struct DiffSection {
    path: String,
    adds: usize,
    dels: usize,
    line_count: usize,
    body: String,
}

fn parse_diff_sections(text: &str) -> ParsedDiff {
    let mut preamble = String::new();
    let mut files: Vec<DiffSection> = Vec::new();
    let mut current_lines: Vec<&str> = Vec::new();
    let mut current_path = String::new();

    let flush = |lines: &mut Vec<&str>, path: &mut String, out: &mut Vec<DiffSection>| {
        if lines.is_empty() {
            return;
        }
        let mut adds = 0usize;
        let mut dels = 0usize;
        for line in lines.iter() {
            if line.starts_with('+') && !line.starts_with("+++ ") {
                adds += 1;
            } else if line.starts_with('-') && !line.starts_with("--- ") {
                dels += 1;
            }
        }
        out.push(DiffSection {
            path: std::mem::take(path),
            adds,
            dels,
            line_count: lines.len(),
            body: lines.join("\n"),
        });
        lines.clear();
    };

    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("diff --git ") {
            flush(&mut current_lines, &mut current_path, &mut files);
            current_path = extract_diff_path(rest);
            current_lines.push(line);
        } else if current_lines.is_empty() && files.is_empty() {
            preamble.push_str(line);
            preamble.push('\n');
        } else {
            current_lines.push(line);
        }
    }
    flush(&mut current_lines, &mut current_path, &mut files);

    ParsedDiff { preamble, files }
}

fn extract_diff_path(header_rest: &str) -> String {
    if let Some((_, b_part)) = header_rest.rsplit_once(" b/") {
        return b_part.trim().to_string();
    }
    header_rest
        .split_whitespace()
        .last()
        .unwrap_or("unknown")
        .trim_start_matches("a/")
        .trim_start_matches("b/")
        .to_string()
}

fn is_lock_or_generated_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase().replace('\\', "/");
    let file_name = lower.rsplit('/').next().unwrap_or(&lower);
    matches!(
        file_name,
        "package-lock.json"
            | "cargo.lock"
            | "yarn.lock"
            | "pnpm-lock.yaml"
            | "bun.lock"
            | "bun.lockb"
            | "composer.lock"
            | "poetry.lock"
            | "gemfile.lock"
    ) || lower.ends_with(".min.js")
        || lower.ends_with(".min.css")
        || lower.ends_with(".map")
        || lower.starts_with("dist/")
        || lower.contains("/dist/")
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
            let short: String = sha.chars().take(7).collect();
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

    #[test]
    fn folds_lockfiles_in_diff_routes_grep_and_groups_large_status() {
        let mut lock_body = String::from(
            "diff --git a/package-lock.json b/package-lock.json\nindex 111..222 100644\n--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1,5 +1,180 @@\n",
        );
        for i in 0..180 {
            lock_body.push_str(&format!("+    \"pkg-{i}\": {{ \"version\": \"1.0.{i}\" }},\n"));
        }
        lock_body.push_str(
            "diff --git a/src/app.rs b/src/app.rs\nindex 333..444 100644\n--- a/src/app.rs\n+++ b/src/app.rs\n@@ -1,2 +1,2 @@\n-old();\n+new();\n",
        );
        let (_, diff_out) = filter_git(&["diff".to_string()], &lock_body, 0).unwrap();
        assert!(diff_out.contains("folded generated/lockfile diff"));
        assert!(diff_out.contains("+new();"));
        assert!(diff_out.len() < lock_body.len() / 2);

        let mut grep_lines = String::new();
        for f in 0..10 {
            for l in 1..=15 {
                grep_lines.push_str(&format!("src/mod_{f}/file.rs:{l}:let match_item_{l} = {f};\n"));
            }
        }
        let (_, grep_out) = filter_git(&["grep".to_string()], &grep_lines, 0).unwrap();
        assert!(grep_out.contains("src/mod_9/file.rs"));
        assert!(grep_out.lines().count() < 100);

        let mut short_status = String::from("## feat/test\n");
        for i in 0..45 {
            let dir = match i % 3 {
                0 => "src/components/views",
                1 => "src-tauri/src/chat",
                _ => "odd/tasks",
            };
            short_status.push_str(&format!(" M {dir}/file_{i}.rs\n"));
        }
        let (_, status_out) = filter_git(&["status".to_string()], &short_status, 0).unwrap();
        assert!(status_out.contains("src/components/views/"));
        assert!(status_out.len() < short_status.len() * 3 / 4);
    }
}
