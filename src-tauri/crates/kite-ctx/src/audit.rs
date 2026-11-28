//! Static Turn-0 prompt and rule-file auditor (`kite ctx audit`).
//!
//! Inspects agent instruction files (`GEMINI.md`, `CLAUDE.md`, `AGENTS.md`, and
//! active plugin/rule folders) to detect duplicate rule blocks across the same
//! agent's Turn-0 load, stale unregistered tool-routing blocks, and oversized
//! instruction files without hardcoding external references.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::tokens::estimate_tokens;

pub const OVERSIZED_PROMPT_TOKENS: usize = 8_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct PromptAuditFinding {
    pub kind: String,
    pub agent: String,
    pub path: String,
    pub label: String,
    pub wasted_tokens: usize,
    pub fixable: bool,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct PromptAuditSummary {
    pub total_files: usize,
    pub total_tokens: usize,
    pub wasted_tokens: usize,
    pub duplicate_blocks: usize,
    pub stale_blocks: usize,
    pub oversized_files: usize,
    pub findings: Vec<PromptAuditFinding>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct PromptAuditFixResult {
    pub modified_files: Vec<String>,
    pub removed_blocks: usize,
    pub tokens_reclaimed: usize,
    pub after: PromptAuditSummary,
}

#[derive(Clone)]
struct PromptFile {
    agent: &'static str,
    path: PathBuf,
    is_root_prompt: bool,
    content: String,
    tokens: usize,
}

#[derive(Clone)]
struct ManagedBlock {
    tag_key: String,
    label: String,
    /// 0-based inclusive line indices in the file.
    start_line: usize,
    end_line: usize,
    body: String,
    tokens: usize,
}

#[derive(Clone)]
struct PlannedRemoval {
    finding: PromptAuditFinding,
    start_line: usize,
    end_line: usize,
}

/// Inspect Turn-0 prompt and rule files across local agent homes and the workspace.
pub fn audit_host_prompts(home_dir: &Path, workspace_dir: &Path) -> PromptAuditSummary {
    let files = collect_prompt_files(home_dir, workspace_dir);
    let (summary, _) = analyze_prompt_files(&files, home_dir, workspace_dir);
    summary
}

/// Remove fixable duplicate and stale tool-rule blocks from Turn-0 prompt files
/// while preserving unmarked user prose and returning the updated audit summary.
pub fn fix_host_prompts(home_dir: &Path, workspace_dir: &Path) -> Result<PromptAuditFixResult> {
    let files = collect_prompt_files(home_dir, workspace_dir);
    let (_before, removals) = analyze_prompt_files(&files, home_dir, workspace_dir);

    let mut by_path: std::collections::BTreeMap<PathBuf, Vec<&PlannedRemoval>> =
        std::collections::BTreeMap::new();
    for rem in &removals {
        by_path
            .entry(PathBuf::from(&rem.finding.path))
            .or_default()
            .push(rem);
    }

    let mut modified_files = Vec::new();
    let mut removed_blocks = 0usize;
    let mut tokens_reclaimed = 0usize;

    for file in &files {
        let Some(file_removals) = by_path.get(&file.path) else {
            continue;
        };
        let lines: Vec<&str> = file.content.lines().collect();
        let mut drop_lines = vec![false; lines.len()];
        for rem in file_removals {
            removed_blocks += 1;
            tokens_reclaimed += rem.finding.wasted_tokens;
            for idx in rem.start_line..=rem.end_line.min(lines.len().saturating_sub(1)) {
                drop_lines[idx] = true;
            }
        }

        let mut kept: Vec<&str> = Vec::with_capacity(lines.len());
        let mut prev_blank = true;
        for (idx, line) in lines.iter().enumerate() {
            if drop_lines[idx] {
                continue;
            }
            let is_blank = line.trim().is_empty();
            if is_blank && prev_blank {
                continue;
            }
            kept.push(line);
            prev_blank = is_blank;
        }
        while kept.last().is_some_and(|l| l.trim().is_empty()) {
            kept.pop();
        }

        let mut new_content = kept.join("\n");
        if !new_content.is_empty() && file.content.ends_with('\n') {
            new_content.push('\n');
        }
        if new_content != file.content {
            std::fs::write(&file.path, &new_content)?;
            modified_files.push(file.path.to_string_lossy().into_owned());
        }
    }

    let after = audit_host_prompts(home_dir, workspace_dir);
    Ok(PromptAuditFixResult {
        modified_files,
        removed_blocks,
        tokens_reclaimed,
        after,
    })
}

fn collect_prompt_files(home_dir: &Path, workspace_dir: &Path) -> Vec<PromptFile> {
    let mut candidates: Vec<(&'static str, PathBuf, bool)> = vec![
        ("gemini", home_dir.join(".gemini").join("GEMINI.md"), true),
        ("claude", home_dir.join(".claude").join("CLAUDE.md"), true),
        ("codex", home_dir.join(".codex").join("AGENTS.md"), true),
        (
            "opencode",
            home_dir.join(".config").join("opencode").join("AGENTS.md"),
            true,
        ),
        ("workspace", workspace_dir.join("AGENTS.md"), false),
        ("workspace", workspace_dir.join("CLAUDE.md"), false),
        ("workspace", workspace_dir.join("GEMINI.md"), false),
    ];

    collect_md_files(
        "gemini",
        &home_dir.join(".gemini").join("config").join("rules"),
        &mut candidates,
    );
    let plugins_dir = home_dir.join(".gemini").join("config").join("plugins");
    if let Ok(entries) = std::fs::read_dir(&plugins_dir) {
        for ent in entries.flatten() {
            let p = ent.path();
            if p.is_dir() {
                collect_md_files("gemini", &p.join("rules"), &mut candidates);
            }
        }
    }

    let mut seen_paths = BTreeSet::new();
    let mut out = Vec::new();
    for (agent, path, is_root) in candidates {
        if !path.is_file() {
            continue;
        }
        let norm = path.to_string_lossy().replace('\\', "/").to_ascii_lowercase();
        if !seen_paths.insert(norm) {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        let tokens = estimate_tokens(&content);
        out.push(PromptFile {
            agent,
            path,
            is_root_prompt: is_root,
            content,
            tokens,
        });
    }
    out
}

fn collect_md_files(
    agent: &'static str,
    dir: &Path,
    out: &mut Vec<(&'static str, PathBuf, bool)>,
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for ent in entries.flatten() {
        let p = ent.path();
        if p.is_file()
            && p.extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("md"))
        {
            out.push((agent, p, false));
        }
    }
}

fn analyze_prompt_files(
    files: &[PromptFile],
    home_dir: &Path,
    workspace_dir: &Path,
) -> (PromptAuditSummary, Vec<PlannedRemoval>) {
    let mut total_tokens = 0usize;
    let mut findings = Vec::new();
    let mut removals = Vec::new();
    let mut duplicate_blocks = 0usize;
    let mut stale_blocks = 0usize;
    let mut oversized_files = 0usize;
    let mut wasted_tokens = 0usize;

    let has_ctx_mcp = host_has_ctx_tool_mcp(home_dir, workspace_dir);

    for file in files {
        total_tokens += file.tokens;
        let blocks = extract_managed_blocks(&file.content);
        let mut removed_ranges: Vec<(usize, usize)> = Vec::new();

        // Check each managed block in root prompts against sibling rule files in the same agent family.
        for blk in &blocks {
            if is_stale_tool_block(&blk.body) && !has_ctx_mcp {
                stale_blocks += 1;
                wasted_tokens += blk.tokens;
                let finding = PromptAuditFinding {
                    kind: "stale_tool_rules".to_string(),
                    agent: file.agent.to_string(),
                    path: file.path.to_string_lossy().into_owned(),
                    label: blk.label.clone(),
                    wasted_tokens: blk.tokens,
                    fixable: true,
                    detail: "References unregistered ctx_* MCP tools not active on this host"
                        .to_string(),
                };
                removed_ranges.push((blk.start_line, blk.end_line));
                removals.push(PlannedRemoval {
                    finding: finding.clone(),
                    start_line: blk.start_line,
                    end_line: blk.end_line,
                });
                findings.push(finding);
                continue;
            }

            if !file.is_root_prompt {
                continue;
            }

            let overlapping_siblings: Vec<&PromptFile> = files
                .iter()
                .filter(|other| {
                    other.agent == file.agent
                        && other.path != file.path
                        && blocks_overlap(blk, &other.content)
                })
                .collect();

            if !overlapping_siblings.is_empty() {
                let only_dispatch_cross_host = file.agent == "gemini"
                    && blk.tag_key == "kite-dispatch"
                    && overlapping_siblings.iter().all(|other| {
                        other
                            .path
                            .to_string_lossy()
                            .replace('\\', "/")
                            .to_ascii_lowercase()
                            .contains("/config/plugins/kite-dispatch/")
                    });

                if only_dispatch_cross_host {
                    findings.push(PromptAuditFinding {
                        kind: "cross_host_overlap".to_string(),
                        agent: file.agent.to_string(),
                        path: file.path.to_string_lossy().into_owned(),
                        label: blk.label.clone(),
                        wasted_tokens: blk.tokens,
                        fixable: false,
                        detail: "Shared between Gemini CLI (GEMINI.md) and Antigravity plugin (kite-dispatch); preserved for Gemini CLI compatibility".to_string(),
                    });
                } else {
                    duplicate_blocks += 1;
                    wasted_tokens += blk.tokens;
                    let finding = PromptAuditFinding {
                        kind: "duplicate_block".to_string(),
                        agent: file.agent.to_string(),
                        path: file.path.to_string_lossy().into_owned(),
                        label: blk.label.clone(),
                        wasted_tokens: blk.tokens,
                        fixable: true,
                        detail: format!(
                            "Duplicated by active rule/plugin file in '{}' family",
                            file.agent
                        ),
                    };
                    removed_ranges.push((blk.start_line, blk.end_line));
                    removals.push(PlannedRemoval {
                        finding: finding.clone(),
                        start_line: blk.start_line,
                        end_line: blk.end_line,
                    });
                    findings.push(finding);
                }
            }
        }

        // Duplicate identical managed tags inside the same file.
        let mut seen_tags: BTreeSet<String> = BTreeSet::new();
        for blk in &blocks {
            if removed_ranges
                .iter()
                .any(|&(s, e)| blk.start_line >= s && blk.end_line <= e)
            {
                continue;
            }
            if !seen_tags.insert(blk.tag_key.clone()) {
                duplicate_blocks += 1;
                wasted_tokens += blk.tokens;
                let finding = PromptAuditFinding {
                    kind: "duplicate_block".to_string(),
                    agent: file.agent.to_string(),
                    path: file.path.to_string_lossy().into_owned(),
                    label: blk.label.clone(),
                    wasted_tokens: blk.tokens,
                    fixable: true,
                    detail: "Repeated managed section within the same prompt file".to_string(),
                };
                removals.push(PlannedRemoval {
                    finding: finding.clone(),
                    start_line: blk.start_line,
                    end_line: blk.end_line,
                });
                findings.push(finding);
            }
        }

        if file.tokens > OVERSIZED_PROMPT_TOKENS {
            oversized_files += 1;
            let excess = file.tokens.saturating_sub(OVERSIZED_PROMPT_TOKENS);
            findings.push(PromptAuditFinding {
                kind: "oversized_file".to_string(),
                agent: file.agent.to_string(),
                path: file.path.to_string_lossy().into_owned(),
                label: file
                    .path
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("prompt")
                    .to_string(),
                wasted_tokens: excess,
                fixable: false,
                detail: format!(
                    "~{} static Turn-0 tokens exceeds {} token budget",
                    file.tokens, OVERSIZED_PROMPT_TOKENS
                ),
            });
        }
    }

    findings.sort_by(|a, b| {
        b.fixable
            .cmp(&a.fixable)
            .then_with(|| b.wasted_tokens.cmp(&a.wasted_tokens))
    });

    (
        PromptAuditSummary {
            total_files: files.len(),
            total_tokens,
            wasted_tokens,
            duplicate_blocks,
            stale_blocks,
            oversized_files,
            findings,
        },
        removals,
    )
}

fn is_stale_tool_block(body: &str) -> bool {
    let has_ctx_tools =
        body.contains("ctx_read(") && body.contains("ctx_shell(") && body.contains("ctx_search(");
    let forbids_native = body.contains("NEVER use native Read/Grep/Shell")
        || body.contains("use instead of native equivalents");
    has_ctx_tools && forbids_native
}

fn host_has_ctx_tool_mcp(home_dir: &Path, workspace_dir: &Path) -> bool {
    let mcp_candidates = [
        home_dir.join(".gemini").join("antigravity").join("mcp_config.json"),
        home_dir.join(".claude").join("settings.json"),
        home_dir.join(".claude.json"),
        home_dir.join(".codex").join("config.toml"),
        workspace_dir.join(".mcp.json"),
    ];
    for p in mcp_candidates {
        if let Ok(raw) = std::fs::read_to_string(p) {
            if raw.contains("ctx_read") || raw.contains("ctx-mcp") {
                return true;
            }
        }
    }
    false
}

fn blocks_overlap(block: &ManagedBlock, sibling_content: &str) -> bool {
    let tag = block.tag_key.as_str();
    if sibling_content.contains(&format!("<!-- {tag}:start -->"))
        || sibling_content.contains(&format!("<!-- BEGIN {tag}"))
    {
        return true;
    }

    // Match normalized H2 headings + shared prose lines when rule came from another setup tool.
    let block_headings: Vec<String> = block
        .body
        .lines()
        .map(str::trim)
        .filter(|l| l.starts_with("## "))
        .map(|h| h.split('—').next().unwrap_or(h).trim().to_ascii_lowercase())
        .collect();

    if block_headings.is_empty() {
        return false;
    }

    let sib_lower = sibling_content.to_ascii_lowercase();
    let heading_matches = block_headings
        .iter()
        .filter(|h| sib_lower.contains(h.as_str()))
        .count();

    if heading_matches == 0 {
        return false;
    }

    let meaningful_lines: Vec<&str> = block
        .body
        .lines()
        .map(str::trim)
        .filter(|l| l.len() >= 28 && !l.starts_with("<!--") && !l.starts_with('#'))
        .collect();
    if meaningful_lines.is_empty() {
        return heading_matches >= 2;
    }
    let shared_lines = meaningful_lines
        .iter()
        .filter(|l| sibling_content.contains(*l))
        .count();

    shared_lines * 10 >= meaningful_lines.len() * 4 || (heading_matches >= 2 && shared_lines >= 2)
}

fn extract_managed_blocks(content: &str) -> Vec<ManagedBlock> {
    let lines: Vec<&str> = content.lines().collect();
    let mut blocks = Vec::new();
    let mut i = 0usize;

    while i < lines.len() {
        let trimmed = lines[i].trim();
        if let Some((tag_key, end_marker)) = parse_block_open(trimmed) {
            if let Some(end_idx) = ((i + 1)..lines.len()).find(|&j| {
                let t = lines[j].trim();
                t == end_marker || t.starts_with(&end_marker)
            }) {
                // Include an immediately preceding `# ...` title line when it introduces the managed block.
                let mut start_line = i;
                if i > 0 {
                    let prev = lines[i - 1].trim();
                    if prev.starts_with("# ")
                        && prev
                            .to_ascii_lowercase()
                            .contains(&tag_key.to_ascii_lowercase())
                    {
                        start_line = i - 1;
                    }
                }
                let body = lines[start_line..=end_idx].join("\n");
                let label = body
                    .lines()
                    .find_map(|l| l.trim().strip_prefix("## ").or_else(|| l.trim().strip_prefix("# ")))
                    .map(|h| h.trim().to_string())
                    .unwrap_or_else(|| tag_key.clone());
                let tokens = estimate_tokens(&body);
                blocks.push(ManagedBlock {
                    tag_key,
                    label,
                    start_line,
                    end_line: end_idx,
                    body,
                    tokens,
                });
                i = end_idx + 1;
                continue;
            }
        }
        i += 1;
    }
    blocks
}

fn parse_block_open(line: &str) -> Option<(String, String)> {
    if !line.starts_with("<!--") || !line.ends_with("-->") {
        return None;
    }
    let inner = line
        .trim_start_matches("<!--")
        .trim_end_matches("-->")
        .trim();
    if inner.starts_with('/') || inner.starts_with("END ") {
        return None;
    }

    if let Some(base) = inner.strip_suffix(":start") {
        let key = base.trim().to_string();
        return Some((key.clone(), format!("<!-- {key}:end -->")));
    }
    if let Some(rest) = inner.strip_prefix("BEGIN ") {
        let before_dash = rest.split('—').next().unwrap_or(rest).trim();
        let key = before_dash.to_string();
        return Some((key.clone(), format!("<!-- END {key} -->")));
    }
    if inner.ends_with("_START") {
        let key = inner.trim_end_matches("_START").to_string();
        return Some((key.clone(), format!("<!-- {key}_END -->")));
    }
    // Versioned rule comment like `<!-- foo-rules-v11 -->` closed by `<!-- /foo -->`
    if let Some((prefix, _)) = inner.split_once("-rules-") {
        let key = prefix.trim().to_string();
        if !key.is_empty() {
            return Some((key.clone(), format!("<!-- /{key} -->")));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audits_and_fixes_duplicate_and_stale_prompt_blocks_while_preserving_user_prose() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let ws = tmp.path().join("ws");
        std::fs::create_dir_all(home.join(".gemini").join("config").join("rules")).unwrap();
        std::fs::create_dir_all(
            home.join(".gemini")
                .join("config")
                .join("plugins")
                .join("kite-dispatch")
                .join("rules"),
        )
        .unwrap();
        std::fs::create_dir_all(&ws).unwrap();

        let gemini_md = home.join(".gemini").join("GEMINI.md");
        let stale_block = "\
# legacy-ctx — Context Engineering Layer
<!-- legacy-ctx-rules-v11 -->
## Tool Mapping
| Read | `ctx_read(path, mode)` |
| Grep | `ctx_search(pattern, path)` |
| Shell | `ctx_shell(command)` |
NEVER use native Read/Grep/Shell when ctx_* equivalents are available.
<!-- /legacy-ctx -->

<!-- BEGIN SHARED MEMORY PROTOCOL — managed by setup -->
## Shared Memory Protocol
Persist verified knowledge that is durable and costly to reconstruct across sessions.
Search with mem_search before writing duplicate records to the project knowledge store.
<!-- END SHARED MEMORY PROTOCOL -->

<!-- CODEGRAPH_START -->
## CodeGraph
Use codegraph_explore for structural codebase maps.
<!-- CODEGRAPH_END -->

<!-- kite-dispatch:start -->
## Kite Subagents & Swarms (`kite-dispatch`)
Use kite_subagent_run for delegation.
<!-- kite-dispatch:end -->
";
        std::fs::write(&gemini_md, stale_block).unwrap();

        std::fs::write(
            home.join(".gemini")
                .join("config")
                .join("rules")
                .join("memory-protocol.md"),
            "\
## Shared Memory Protocol
Persist verified knowledge that is durable and costly to reconstruct across sessions.
Search with mem_search before writing duplicate records to the project knowledge store.
",
        )
        .unwrap();

        std::fs::write(
            home.join(".gemini")
                .join("config")
                .join("plugins")
                .join("kite-dispatch")
                .join("rules")
                .join("AGENTS.md"),
            "\
<!-- kite-dispatch:start -->
## Kite Subagents & Swarms (`kite-dispatch`)
Use kite_subagent_run for delegation.
<!-- kite-dispatch:end -->
",
        )
        .unwrap();

        let summary = audit_host_prompts(&home, &ws);
        assert_eq!(summary.stale_blocks, 1);
        assert_eq!(summary.duplicate_blocks, 1);
        assert!(summary.wasted_tokens > 30);
        assert!(summary
            .findings
            .iter()
            .any(|f| f.kind == "cross_host_overlap" && !f.fixable));

        let fixed = fix_host_prompts(&home, &ws).unwrap();
        assert_eq!(fixed.removed_blocks, 2);
        assert_eq!(fixed.after.stale_blocks, 0);
        assert_eq!(fixed.after.duplicate_blocks, 0);
        assert_eq!(fixed.after.wasted_tokens, 0);

        let updated = std::fs::read_to_string(&gemini_md).unwrap();
        assert!(!updated.contains("ctx_read("));
        assert!(!updated.contains("legacy-ctx"));
        assert!(!updated.contains("SHARED MEMORY PROTOCOL"));
        assert!(updated.contains("kite-dispatch:start"));
        assert!(updated.contains("## CodeGraph"));
        assert!(updated.contains("codegraph_explore"));
    }
}
