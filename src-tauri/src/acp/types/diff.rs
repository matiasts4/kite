use serde_json::Value;

use super::*;

/// Computes `(added_lines, removed_lines)` between `before` and `after` using a
/// bounded 1D LCS after stripping matching leading/trailing lines.
pub fn diff_line_counts(before: &str, after: &str) -> (usize, usize) {
    let a: Vec<&str> = before.lines().collect();
    let b: Vec<&str> = after.lines().collect();

    let mut prefix = 0usize;
    while prefix < a.len() && prefix < b.len() && a[prefix] == b[prefix] {
        prefix += 1;
    }

    let mut suffix = 0usize;
    while suffix + prefix < a.len()
        && suffix + prefix < b.len()
        && a[a.len() - 1 - suffix] == b[b.len() - 1 - suffix]
    {
        suffix += 1;
    }

    let a_mid = &a[prefix..a.len() - suffix];
    let b_mid = &b[prefix..b.len() - suffix];

    if a_mid.is_empty() && b_mid.is_empty() {
        return (0, 0);
    }
    if a_mid.is_empty() {
        return (b_mid.len(), 0);
    }
    if b_mid.is_empty() {
        return (0, a_mid.len());
    }

    let lcs = if a_mid.len().saturating_mul(b_mid.len()) <= 2_000_000 {
        let (rows, cols) = if a_mid.len() >= b_mid.len() {
            (a_mid, b_mid)
        } else {
            (b_mid, a_mid)
        };
        let mut prev = vec![0usize; cols.len() + 1];
        let mut curr = vec![0usize; cols.len() + 1];
        for r in rows {
            curr[0] = 0;
            for (j, c) in cols.iter().enumerate() {
                curr[j + 1] = if r == c {
                    prev[j] + 1
                } else {
                    prev[j + 1].max(curr[j])
                };
            }
            std::mem::swap(&mut prev, &mut curr);
        }
        prev[cols.len()]
    } else {
        let mut counts = std::collections::HashMap::<&str, usize>::with_capacity(a_mid.len());
        for line in a_mid {
            *counts.entry(*line).or_insert(0) += 1;
        }
        let mut shared = 0usize;
        for line in b_mid {
            if let Some(count) = counts.get_mut(line) {
                if *count > 0 {
                    *count -= 1;
                    shared += 1;
                }
            }
        }
        shared
    };

    (b_mid.len() - lcs, a_mid.len() - lcs)
}

/// Counts `(added, removed)` lines inside a unified diff snippet.
pub fn unified_diff_line_counts(diff_text: &str) -> Option<(usize, usize)> {
    let mut added = 0usize;
    let mut removed = 0usize;
    let mut saw_header = false;
    for line in diff_text.lines() {
        if line.starts_with("@@")
            || line.starts_with("diff --git")
            || line.starts_with("--- ")
            || line.starts_with("+++ ")
        {
            saw_header = true;
            continue;
        }
        if line.starts_with('+') {
            added += 1;
        } else if line.starts_with('-') {
            removed += 1;
        }
    }
    if saw_header || added > 0 || removed > 0 {
        Some((added, removed))
    } else {
        None
    }
}

pub fn normalize_tool_kind_name(raw_kind: &str) -> String {
    match raw_kind.trim().to_ascii_lowercase().as_str() {
        "edit" | "delete" | "move" | "write" | "filechange" | "file_change" | "file-change" => {
            "fileChange".to_string()
        }
        _ => raw_kind.trim().to_string(),
    }
}

/// Extracts fallback path and `(added_lines, removed_lines)` from ACP `content` diff blocks
/// (`[{ type: "diff", path, oldText, newText }]`), `locations`, or structured `diff` objects.
pub fn extract_acp_diff_and_path(container: &Value) -> (Option<String>, Option<usize>, Option<usize>) {
    let mut path = container
        .pointer("/locations/0/path")
        .or_else(|| container.pointer("/location/path"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let mut total_add = 0usize;
    let mut total_del = 0usize;
    let mut found_diff = false;

    if let Some(items) = container.get("content").and_then(Value::as_array) {
        for block in items {
            let block_type = block.get("type").and_then(Value::as_str).unwrap_or("");
            if block_type == "diff" || block.get("newText").is_some() || block.get("oldText").is_some() {
                if path.is_none() {
                    path = block
                        .get("path")
                        .or_else(|| block.get("filePath"))
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(str::to_string);
                }
                let old_text = block
                    .get("oldText")
                    .or_else(|| block.get("old_text"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let new_text = block
                    .get("newText")
                    .or_else(|| block.get("new_text"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let (add, del) = diff_line_counts(old_text, new_text);
                total_add += add;
                total_del += del;
                found_diff = true;
            }
        }
    }

    if !found_diff {
        let obj_add = container
            .pointer("/diff/additions")
            .or_else(|| container.get("addedLines"))
            .and_then(Value::as_u64)
            .map(|n| n as usize);
        let obj_del = container
            .pointer("/diff/deletions")
            .or_else(|| container.get("removedLines"))
            .and_then(Value::as_u64)
            .map(|n| n as usize);
        if obj_add.is_some() || obj_del.is_some() {
            return (path, Some(obj_add.unwrap_or(0)), Some(obj_del.unwrap_or(0)));
        }
        if let Some(diff_str) = container.get("diff").and_then(Value::as_str) {
            if let Some((add, del)) = unified_diff_line_counts(diff_str) {
                return (path, Some(add), Some(del));
            }
        }
    }

    if found_diff {
        (path, Some(total_add), Some(total_del))
    } else {
        (path, None, None)
    }
}

pub fn generic_tool_action(action: &str) -> bool {
    matches!(
        action.trim().to_ascii_lowercase().replace('_', " ").as_str(),
        "read" | "read file" | "edit" | "edit file" | "write" | "write file" | "file" | "tool" | "tool execution"
    )
}

pub fn normalize_workspace_mode(raw: &str) -> Option<String> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "inherit" => Some("inherit".to_string()),
        "share" | "shared" => Some("share".to_string()),
        "branch" | "branched" => Some("branch".to_string()),
        _ => None,
    }
}

pub fn normalize_subagent_status(raw_status: &str, action: Option<&str>) -> String {
    if action.is_some_and(|a| a.eq_ignore_ascii_case("kill") || a.eq_ignore_ascii_case("kill_all")) {
        return "killed".to_string();
    }
    match raw_status.trim().to_ascii_lowercase().as_str() {
        "completed" | "done" | "succeeded" | "success" => "completed".to_string(),
        "failed" | "error" | "rejected" | "denied" | "errored" | "timed_out" | "timeout" => {
            "failed".to_string()
        }
        "killed" | "terminated" | "cancelled" | "canceled" => "killed".to_string(),
        "waiting" | "paused" | "requiresapproval" | "requires_approval" => "waiting".to_string(),
        _ => "running".to_string(),
    }
}

pub(super) fn value_failure_flag(val: &Value, depth: u8) -> bool {
    if depth > 2 {
        return false;
    }
    let Some(obj) = val.as_object() else {
        return false;
    };
    if obj
        .get("isError")
        .or_else(|| obj.get("is_error"))
        .and_then(Value::as_bool)
        == Some(true)
    {
        return true;
    }
    if obj.get("ok").and_then(Value::as_bool) == Some(false) {
        return true;
    }
    for key in ["exitCode", "exit_code", "exit", "returnCode", "return_code"] {
        if let Some(code) = obj.get(key).and_then(Value::as_i64) {
            if code != 0 {
                return true;
            }
        }
    }
    if let Some(status) = obj.get("status").and_then(Value::as_str) {
        if matches!(
            status.trim().to_ascii_lowercase().as_str(),
            "failed" | "error" | "rejected" | "denied" | "errored" | "timed_out" | "timeout"
        ) {
            return true;
        }
    }
    if let Some(err) = obj.get("error") {
        let non_empty = match err {
            Value::Null => false,
            Value::Bool(b) => *b,
            Value::String(s) => !s.trim().is_empty(),
            Value::Object(m) => !m.is_empty(),
            Value::Array(a) => !a.is_empty(),
            Value::Number(_) => true,
        };
        if non_empty {
            return true;
        }
    }
    for nested_key in ["state", "metadata", "rawOutput", "output", "result"] {
        if let Some(nested) = obj.get(nested_key) {
            if value_failure_flag(nested, depth + 1) {
                return true;
            }
        }
    }
    false
}

/// Returns `true` when `output` is a blocking `wait` slice timeout receipt (either
/// raw JSON `{"op":"wait","status":"failed","error":"timeout",...}` or the non-error
/// `"still running after ... wait slice"` handoff text). A wait-slice timeout means the
/// child subagent is still alive, NOT that it failed.
pub fn is_wait_timeout_receipt(output: Option<&str>) -> bool {
    let Some(raw) = output.map(str::trim).filter(|s| !s.is_empty()) else {
        return false;
    };
    let lower = raw.to_ascii_lowercase();
    if lower.contains("still running after ") && lower.contains("wait slice") {
        return true;
    }
    if let Some(parsed) = parse_output_json(Some(raw)) {
        let receipt = parsed.get("receipt").unwrap_or(&parsed);
        let is_timeout_err = receipt
            .get("error")
            .and_then(Value::as_str)
            .is_some_and(|e| e.trim().eq_ignore_ascii_case("timeout"));
        if is_timeout_err {
            let op_is_wait = receipt
                .get("op")
                .and_then(Value::as_str)
                .is_some_and(|op| op.trim().eq_ignore_ascii_case("wait"));
            let has_thread_addr = receipt
                .get("address")
                .and_then(Value::as_str)
                .is_some_and(|addr| addr.trim().starts_with("thread:"));
            if op_is_wait || has_thread_addr {
                return true;
            }
        }
    }
    false
}

/// Returns `true` when any status, exit code, ACP error flag, or JSON receipt indicates failure.
pub fn response_indicates_failure(
    raw_status: &str,
    meta_val: Option<&Value>,
    parsed_output: Option<&Value>,
    output: Option<&str>,
) -> bool {
    if matches!(
        raw_status.trim().to_ascii_lowercase().as_str(),
        "failed" | "error" | "rejected" | "denied" | "errored" | "timed_out" | "timeout"
    ) {
        return true;
    }
    if meta_val.is_some_and(|v| value_failure_flag(v, 0)) {
        return true;
    }
    if parsed_output.is_some_and(|v| value_failure_flag(v, 0)) {
        return true;
    }
    if parsed_output.is_none() {
        if let Some(parsed) = parse_output_json(output) {
            if value_failure_flag(&parsed, 0) {
                return true;
            }
        }
    }
    false
}

pub fn extract_mentions(text: &str) -> Vec<String> {
    let mut mentions = Vec::new();
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '@' {
            let prev_ok = i == 0 || !chars[i - 1].is_alphanumeric();
            if prev_ok && i + 1 < chars.len() {
                let mut end = i + 1;
                if chars[end] == '#' {
                    end += 1;
                }
                let start_ident = end;
                while end < chars.len()
                    && (chars[end].is_alphanumeric() || matches!(chars[end], '_' | '-'))
                {
                    end += 1;
                }
                if end > start_ident {
                    let tag: String = chars[i..end].iter().collect();
                    if !mentions.contains(&tag) {
                        mentions.push(tag);
                    }
                    i = end;
                    continue;
                }
            }
        }
        i += 1;
    }
    mentions
}

