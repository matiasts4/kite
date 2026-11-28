use std::collections::HashMap;

use crate::ccr_store::CcrStore;
use crate::lossless::compact_lossless;
use crate::pipeline::ContentKind;

const MAX_SEARCH_LINES_DIRECT: usize = 80;
const MAX_SEARCH_BYTES_DIRECT: usize = 6_000;
const MAX_SEARCH_OUTPUT_ROWS: usize = 60;
const MAX_SEARCH_OUTPUT_CHARS: usize = 5_500;

pub fn filter_search(output: &str) -> Option<(&'static str, String)> {
    filter_search_with_ccr(output, None)
}

pub fn filter_search_with_ccr(
    output: &str,
    ccr: Option<&CcrStore>,
) -> Option<(&'static str, String)> {
    let non_empty: Vec<&str> = output.lines().filter(|l| !l.trim().is_empty()).collect();
    if non_empty.len() <= MAX_SEARCH_LINES_DIRECT && output.len() <= MAX_SEARCH_BYTES_DIRECT {
        let folded = compact_lossless(output, ContentKind::Grep);
        return Some(("search", folded));
    }

    let mut groups: Vec<(String, Vec<String>)> = Vec::new();
    let mut index_by_file: HashMap<String, usize> = HashMap::new();
    let mut total_matches = 0usize;

    for line in &non_empty {
        if let Some((path, rest)) = split_grep_row(line) {
            total_matches += 1;
            if let Some(&idx) = index_by_file.get(path) {
                groups[idx].1.push(rest.to_string());
            } else {
                let idx = groups.len();
                index_by_file.insert(path.to_string(), idx);
                groups.push((path.to_string(), vec![rest.to_string()]));
            }
        }
    }

    // Handle `git grep -l` / `rg --files` style path lists cleanly when no `file:line:` rows exist.
    if groups.is_empty() {
        let paths_folded = compact_lossless(output, ContentKind::Paths);
        let lines: Vec<&str> = paths_folded.lines().collect();
        if lines.len() <= MAX_SEARCH_LINES_DIRECT && paths_folded.len() <= MAX_SEARCH_BYTES_DIRECT {
            return Some(("search", paths_folded));
        }
        let kept: Vec<&str> = lines.iter().take(60).copied().collect();
        let omitted = lines.len().saturating_sub(kept.len());
        let mut out = kept.join("\n");
        let ccr_hash = ccr.and_then(|s| s.put(output, &out, "cmd_filter", "search").ok());
        if let Some(hash) = ccr_hash {
            out.push_str(&format!(
                "\n... (+{omitted} lines omitted — run `kite ctx retrieve {hash} --search <term>` or `--lines N-M`) <<ccr:{hash}>>"
            ));
        } else {
            out.push_str(&format!("\n... (+{omitted} lines omitted)"));
        }
        return Some(("search", out));
    }

    let total_files = groups.len();
    let per_file_cap = if total_files <= 3 {
        18
    } else if total_files <= 12 {
        5
    } else {
        3
    };

    // Pass 1: allocate at least 1-2 lines per distinct file so later files are never starved.
    let mut taken_per_file = vec![0usize; total_files];
    let mut selected_rows = 0usize;
    let initial_seed = if total_files <= 20 { 2 } else { 1 };
    for (idx, (_, rows)) in groups.iter().enumerate() {
        if selected_rows >= MAX_SEARCH_OUTPUT_ROWS {
            break;
        }
        let take_n = rows.len().min(initial_seed).min(per_file_cap);
        taken_per_file[idx] = take_n;
        selected_rows += take_n;
    }

    // Pass 2: top up per-file slots until the row budget is reached.
    for (idx, (_, rows)) in groups.iter().enumerate() {
        if selected_rows >= MAX_SEARCH_OUTPUT_ROWS {
            break;
        }
        let target = rows.len().min(per_file_cap);
        if taken_per_file[idx] < target {
            let add = (target - taken_per_file[idx]).min(MAX_SEARCH_OUTPUT_ROWS - selected_rows);
            taken_per_file[idx] += add;
            selected_rows += add;
        }
    }

    let mut body = Vec::new();
    let mut body_chars = 0usize;
    let mut shown_files = 0usize;
    let mut shown_matches = 0usize;

    for (idx, (path, rows)) in groups.iter().enumerate() {
        let count = taken_per_file[idx];
        if count == 0 {
            continue;
        }
        let header_line = if rows.len() > count {
            format!("{path} ({} matches, showing {count}):", rows.len())
        } else {
            path.clone()
        };
        if body_chars + header_line.len() > MAX_SEARCH_OUTPUT_CHARS && shown_files > 0 {
            break;
        }
        body_chars += header_line.len() + 1;
        body.push(header_line);
        shown_files += 1;

        for row in rows.iter().take(count) {
            if body_chars + row.len() + 2 > MAX_SEARCH_OUTPUT_CHARS {
                break;
            }
            body_chars += row.len() + 2;
            body.push(format!("  {row}"));
            shown_matches += 1;
        }
    }

    let omitted_files = total_files.saturating_sub(shown_files);
    let mut result = String::new();
    let preview_body = body.join("\n");
    let ccr_hash = ccr.and_then(|s| s.put(output, &preview_body, "cmd_filter", "search").ok());

    result.push_str(&format!(
        "[search: {total_matches} matches across {total_files} files — showing {shown_matches}]"
    ));
    result.push('\n');
    result.push_str(&preview_body);
    if omitted_files > 0 || shown_matches < total_matches {
        match ccr_hash {
            Some(hash) => result.push_str(&format!(
                "\n... (+{} matches / +{omitted_files} files omitted — run `kite ctx retrieve {hash} --search <term>` for full matches) <<ccr:{hash}>>",
                total_matches.saturating_sub(shown_matches)
            )),
            None => result.push_str(&format!(
                "\n... (+{} matches / +{omitted_files} files omitted)",
                total_matches.saturating_sub(shown_matches)
            )),
        }
    }
    Some(("search", result))
}

fn split_grep_row(line: &str) -> Option<(&str, &str)> {
    let bytes = line.as_bytes();
    let start_scan = if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        2
    } else {
        0
    };
    let rel_first = line[start_scan..].find(':')?;
    let first_colon = start_scan + rel_first;
    if first_colon == 0 {
        return None;
    }
    let after_first = &line[first_colon + 1..];
    let second_colon = after_first.find(':')?;
    let line_num = &after_first[..second_colon];
    if line_num.is_empty() || !line_num.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some((&line[..first_colon], after_first))
}

pub fn filter_listing(output: &str) -> Option<(&'static str, String)> {
    let folded = compact_lossless(output, ContentKind::Paths);
    if folded.len() < output.len() {
        return Some(("listing", folded));
    }
    let clean = compact_lossless(output, ContentKind::Text);
    Some(("listing", clean))
}
