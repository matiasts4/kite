use std::path::Path;

use serde_json::Value;

use super::*;

pub fn classify_tool_metadata(raw_name: &str, params: &Value) -> (String, Option<String>, String, Option<String>, Option<String>, Option<usize>, Option<usize>) {
    let lower = raw_name.to_lowercase();
    let (server_name, clean_name) = strip_mcp_prefix(raw_name, params);

    let command = lookup_text(params, &["CommandLine", "command", "cmd"]);

    let file_path = lookup_text(
        params,
        &[
            "TargetFile",
            "AbsolutePath",
            "absolute_path",
            "filePath",
            "file_path",
            "filepath",
            "target_file",
            "targetPath",
            "path",
            "target",
            "file",
            "uri",
            "filename",
            "file_name",
        ],
    );

    let pattern = params
        .get("pattern")
        .or_else(|| params.get("query"))
        .or_else(|| params.get("search"))
        .or_else(|| params.get("url"))
        .and_then(|v| v.as_str())
        .map(String::from);

    let is_file_edit_tool = lower.contains("edit")
        || lower.contains("write")
        || lower.contains("replace")
        || lower.contains("patch")
        || lower.contains("sed_file");

    let target_str = lookup_raw_str(
        params,
        &[
            "TargetContent",
            "Target",
            "target",
            "old_string",
            "old_str",
            "oldText",
            "old_text",
            "oldString",
            "find",
        ],
    );

    let replacement_str = lookup_raw_str(
        params,
        &[
            "ReplacementContent",
            "Replacement",
            "replacement",
            "new_string",
            "new_str",
            "newText",
            "new_text",
            "newString",
            "replace",
        ],
    );

    let mut added_lines = None;
    let mut removed_lines = None;
    if let Some(chunks) = lookup_value(
        params,
        &["ReplacementChunks", "replacementChunks", "edits", "chunks"],
    )
    .and_then(|v| v.as_array().cloned())
    {
        let mut total_add = 0usize;
        let mut total_del = 0usize;
        let mut saw_chunk = false;
        for chunk in chunks {
            let old_s = lookup_raw_str(
                &chunk,
                &[
                    "TargetContent",
                    "Target",
                    "target",
                    "old_string",
                    "old_str",
                    "oldText",
                    "old_text",
                    "oldString",
                ],
            );
            let new_s = lookup_raw_str(
                &chunk,
                &[
                    "ReplacementContent",
                    "Replacement",
                    "replacement",
                    "new_string",
                    "new_str",
                    "newText",
                    "new_text",
                    "newString",
                ],
            );
            if old_s.is_some() || new_s.is_some() {
                let (add, del) = diff_line_counts(
                    old_s.as_deref().unwrap_or(""),
                    new_s.as_deref().unwrap_or(""),
                );
                total_add += add;
                total_del += del;
                saw_chunk = true;
            }
        }
        if saw_chunk {
            added_lines = Some(total_add);
            removed_lines = Some(total_del);
        }
    }

    if added_lines.is_none() {
        if let (Some(target), Some(replacement)) = (target_str.as_deref(), replacement_str.as_deref()) {
            let (add, del) = diff_line_counts(target, replacement);
            added_lines = Some(add);
            removed_lines = Some(del);
        } else if let Some(diff_text) = lookup_raw_str(params, &["diff", "patch", "unified_diff", "unifiedDiff"]) {
            if let Some((add, del)) = unified_diff_line_counts(&diff_text) {
                added_lines = Some(add);
                removed_lines = Some(del);
            }
        } else if is_file_edit_tool {
            if let Some(code) = lookup_raw_str(params, &["CodeContent", "Content", "content", "text"]) {
                if file_path.is_some() {
                    let count = code.lines().count();
                    added_lines = Some(if count == 0 && !code.is_empty() { 1 } else { count });
                    removed_lines = Some(0);
                }
            }
        }
    }

    let cli_tokens = command.as_deref().map(tokenize_shell_tokens);
    let cli_kind = cli_tokens.as_deref().and_then(match_dispatch_cli);

    let tool_kind = if is_swarm_tool_name(&clean_name) || matches!(cli_kind, Some(DispatchCliCommand::Swarm(_))) {
        "swarm"
    } else if is_subagent_tool_name(&clean_name) || matches!(cli_kind, Some(DispatchCliCommand::Run(_))) {
        "subagent"
    } else if server_name.is_some() || lower.contains("mcp") {
        "mcpToolCall"
    } else if command.is_some() || lower.contains("bash") || lower.contains("command") || lower.contains("shell") || lower.contains("exec") {
        "commandExecution"
    } else if added_lines.is_some() || is_file_edit_tool {
        "fileChange"
    } else if lower.contains("web") || lower.contains("url") || lower.contains("browser") || lower.contains("fetch") {
        "webSearch"
    } else {
        "dynamicToolCall"
    };

    let explicit_action = lookup_text(params, &["toolAction", "toolSummary", "Instruction", "Description"])
        .filter(|action| !generic_tool_action(action));

    let title = if tool_kind == "subagent" {
        if let Some(meta) = extract_subagent_meta(raw_name, "", params, None, "running") {
            format!("Subagent · {}", meta.role)
        } else if let Some(action) = explicit_action {
            action
        } else {
            clean_name.replace('_', " ")
        }
    } else if tool_kind == "swarm" {
        if let Some(meta) = extract_swarm_meta(raw_name, params, None) {
            if let Some(ref title) = meta.swarm_title {
                format!("Swarm · {}", title)
            } else if let Some(ref member) = meta.member_name {
                format!("Swarm {} · @{}", meta.action, member)
            } else {
                format!("Swarm · {}", meta.action)
            }
        } else if let Some(action) = explicit_action {
            action
        } else {
            clean_name.replace('_', " ")
        }
    } else if let Some(action) = explicit_action {
        action
    } else if let Some(ref srv) = server_name {
        format!("{} · {}", srv, clean_name)
    } else if let Some(ref cmd) = command {
        let short_cmd: String = cmd.chars().take(72).collect();
        format!("Run `{}`", short_cmd)
    } else if let Some(ref fp) = file_path {
        let base = Path::new(fp).file_name().and_then(|s| s.to_str()).unwrap_or(fp);
        if tool_kind == "fileChange" {
            format!("Edit {}", base)
        } else {
            format!("Read {}", base)
        }
    } else if let Some(ref pat) = pattern {
        if clean_name.contains("grep") || clean_name.contains("search") || clean_name.contains("find") {
            format!("Search `{}`", pat)
        } else if clean_name.contains("url") || clean_name.contains("fetch") {
            format!("Fetch {}", pat)
        } else {
            format!("{} {}", clean_name.replace('_', " "), pat)
        }
    } else {
        clean_name.replace('_', " ")
    };

    (
        tool_kind.to_string(),
        server_name,
        title,
        command,
        file_path,
        added_lines,
        removed_lines,
    )
}

pub fn build_acp_tool_call(
    id: String,
    raw_name: &str,
    params: Value,
    status: String,
    output: Option<String>,
    duration_seconds: Option<f64>,
    server_override: Option<String>,
    kind_override: Option<String>,
    title_override: Option<String>,
    detail_override: Option<String>,
    command_override: Option<String>,
    parent_tool_use_id: Option<String>,
) -> AcpToolCall {
    let (
        classified_kind,
        classified_server,
        classified_title,
        classified_command,
        file_path,
        added_lines,
        removed_lines,
    ) = classify_tool_metadata(raw_name, &params);
    let command = command_override.or(classified_command);
    let server_name = server_override.or(classified_server);
    let tool_kind = kind_override.unwrap_or(classified_kind);
    let title = title_override.unwrap_or(classified_title);
    let mut status = status;
    if status != "killed"
        && response_indicates_failure(&status, Some(&params), None, output.as_deref())
    {
        status = "failed".to_string();
    }
    let detail = detail_override.unwrap_or_else(|| summarize_tool_detail(&params, &output, &command, &file_path));
    let subagent_meta = extract_subagent_meta(raw_name, &id, &params, output.as_deref(), &status);
    let swarm_meta = extract_swarm_meta(raw_name, &params, output.as_deref());
    AcpToolCall {
        id,
        name: raw_name.to_string(),
        title,
        detail,
        tool_kind,
        server_name,
        command,
        file_path,
        added_lines,
        removed_lines,
        parameters: params,
        status,
        output,
        duration_seconds,
        subagent_meta,
        swarm_meta,
        parent_tool_use_id,
    }
}

/// Converts an ACP `tool_call` / `tool_call_update` JSON payload into a normalized `AcpToolCall`,
/// merging explicit ACP `kind`, `locations`, `diff`, and `content` diff blocks with `rawInput` metadata.
pub fn acp_tool_from_update(
    update: &Value,
    output: Option<String>,
    parent_tool_use_id: Option<String>,
) -> AcpToolCall {
    let tool_id = update
        .get("toolCallId")
        .or_else(|| update.get("id"))
        .and_then(|v| v.as_str())
        .unwrap_or("acp_tool")
        .to_string();
    let tool_name = update
        .get("toolName")
        .or_else(|| update.get("name"))
        .or_else(|| update.get("title"))
        .and_then(|v| v.as_str())
        .unwrap_or("tool");
    let raw_status = update
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("running");
    let status = if raw_status.eq_ignore_ascii_case("killed")
        || raw_status.eq_ignore_ascii_case("terminated")
        || raw_status.eq_ignore_ascii_case("cancelled")
        || raw_status.eq_ignore_ascii_case("canceled")
    {
        "killed"
    } else if response_indicates_failure(raw_status, Some(update), None, output.as_deref()) {
        "failed"
    } else {
        match raw_status {
            "completed" | "done" | "succeeded" => "completed",
            "failed" | "error" => "failed",
            "pending" => "pending",
            _ => "running",
        }
    };
    let tool_params = update
        .get("rawInput")
        .or_else(|| update.get("parameters"))
        .or_else(|| update.get("input"))
        .cloned()
        .unwrap_or(Value::Null);
    let kind_override = update
        .get("kind")
        .and_then(|v| v.as_str())
        .map(normalize_tool_kind_name)
        .filter(|k| !k.is_empty() && k == "fileChange");
    let title_override = update
        .get("title")
        .and_then(|v| v.as_str())
        .filter(|t| !t.trim().is_empty() && *t != tool_name && !generic_tool_action(t))
        .map(str::to_string);

    let mut tool = build_acp_tool_call(
        tool_id,
        tool_name,
        tool_params,
        status.to_string(),
        output,
        update.get("durationSeconds").and_then(|v| v.as_f64()),
        None,
        kind_override,
        title_override,
        None,
        None,
        parent_tool_use_id,
    );

    let (diff_path, diff_add, diff_del) = extract_acp_diff_and_path(update);
    if tool.file_path.is_none() {
        tool.file_path = diff_path;
        if let Some(ref fp) = tool.file_path {
            if tool.detail.is_empty() {
                tool.detail = fp.clone();
            }
        }
    }
    if tool.added_lines.is_none() && diff_add.is_some() {
        tool.added_lines = diff_add;
    }
    if tool.removed_lines.is_none() && diff_del.is_some() {
        tool.removed_lines = diff_del;
    }
    tool
}

pub fn summarize_tool_detail(params: &Value, output: &Option<String>, command: &Option<String>, file_path: &Option<String>) -> String {
    let mut parts = Vec::new();
    if let Some(cmd) = command {
        parts.push(format!("$ {}", cmd));
    } else if let Some(fp) = file_path {
        parts.push(fp.clone());
    } else if !params.is_null() {
        if let Ok(pretty) = serde_json::to_string_pretty(params) {
            if pretty != "{}" && pretty != "null" {
                parts.push(pretty);
            }
        }
    }
    if let Some(out) = output {
        let trimmed = out.trim();
        if !trimmed.is_empty() {
            parts.push(trimmed.to_string());
        }
    }
    parts.join("\n\n")
}

pub fn is_thought_kind(kind: &str) -> bool {
    matches!(
        kind,
        "thinking" | "reasoning" | "thought" | "thinking_delta" | "reasoning_delta" | "reasoning-delta" | "thought_delta"
    ) || kind.contains("reasoning")
}

pub fn frame_is_thought(value: &Value) -> bool {
    let marked = |pointer: &str| {
        value
            .pointer(pointer)
            .and_then(Value::as_str)
            .is_some_and(is_thought_kind)
    };
    value
        .get("type")
        .and_then(Value::as_str)
        .is_some_and(is_thought_kind)
        || marked("/delta/type")
        || marked("/part/type")
        || marked("/content_block/type")
        || marked("/item/type")
}

pub fn string_field(value: &Value) -> Option<&str> {
    value.as_str().map(str::trim).filter(|text| !text.is_empty())
}

pub fn thought_marker_is_empty(value: &Value) -> bool {
    let empty = |pointer: &str| {
        value
            .pointer(pointer)
            .and_then(Value::as_str)
            .is_some_and(|text| text.trim().is_empty())
    };
    empty("/delta/thinking")
        || empty("/delta/text")
        || empty("/thinking")
        || empty("/text")
        || empty("/item/text")
        || empty("/part/text")
}

