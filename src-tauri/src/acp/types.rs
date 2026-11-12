//! ACP data types, models, event descriptors, and parsing helpers.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpModelDescriptor {
    pub id: String,
    pub name: String,
    pub description: String,
    pub supports_effort: bool,
    pub effort_options: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentMeta {
    pub subagent_id: String,
    pub role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub type_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcript_uri: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub child_thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_activity: Option<String>,
    #[serde(default)]
    pub step_count: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwarmMeta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub swarm_id: Option<String>,
    pub action: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub swarm_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub member_name: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub member_names: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub post_text: Option<String>,
    #[serde(default)]
    pub mentions: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brief: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpToolCall {
    pub id: String,
    pub name: String,
    pub title: String,
    pub detail: String,
    pub tool_kind: String, // "commandExecution" | "fileChange" | "mcpToolCall" | "webSearch" | "dynamicToolCall" | "subagent" | "swarm"
    pub server_name: Option<String>,
    pub command: Option<String>,
    pub file_path: Option<String>,
    pub added_lines: Option<usize>,
    pub removed_lines: Option<usize>,
    pub parameters: Value,
    pub status: String, // "pending" | "running" | "completed" | "failed" | "requiresApproval"
    pub output: Option<String>,
    pub duration_seconds: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent_meta: Option<SubagentMeta>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub swarm_meta: Option<SwarmMeta>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_tool_use_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpApprovalRequest {
    pub request_id: String,
    pub thread_id: String,
    pub run_id: String,
    pub tool_name: String,
    pub title: String,
    pub description: String,
    pub risk: String, // "command" | "fileChange" | "externalWrite" | "creditUse" | "unknown"
    pub impact: Option<String>,
    pub command: Option<String>,
    pub path: Option<String>,
    pub details: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AcpStreamEvent {
    Init {
        conversation_id: String,
        model: String,
    },
    ThoughtDelta {
        text: String,
        is_done: bool,
        duration_seconds: Option<f64>,
    },
    ContentDelta {
        text: String,
    },
    ToolUpdate {
        tool: AcpToolCall,
    },
    PermissionRequired {
        approval: AcpApprovalRequest,
    },
    PlanUpdate {
        step: String,
        status: String,
    },
    Result {
        status: String,
        input_tokens: i64,
        output_tokens: i64,
        duration_seconds: f64,
    },
    Raw {
        line: String,
    },
    /// A thought-shaped frame this build could not read. It stays visible as a notice.
    UnknownFrame {
        message: String,
    },
}

pub fn scalar_text(value: &Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    } else if let Some(items) = value.as_array() {
        let parts: Vec<&str> = items.iter().filter_map(|item| item.as_str()).collect();
        if parts.is_empty() {
            None
        } else {
            Some(parts.join(" "))
        }
    } else {
        None
    }
}

pub fn lookup_value(params: &Value, keys: &[&str]) -> Option<Value> {
    fn walk(params: &Value, keys: &[&str], depth: usize) -> Option<Value> {
        let obj = params.as_object()?;
        for (key, value) in obj {
            if keys.iter().any(|candidate| candidate.eq_ignore_ascii_case(key)) && !value.is_null() {
                return Some(value.clone());
            }
        }
        if depth >= 1 {
            return None;
        }
        for (key, value) in obj {
            if ["arguments", "args", "input", "parameters", "rawInput"]
                .iter()
                .any(|candidate| candidate.eq_ignore_ascii_case(key))
            {
                if let Some(found) = walk(value, keys, 1) {
                    return Some(found);
                }
                if let Some(text) = value.as_str() {
                    if let Ok(parsed) = serde_json::from_str::<Value>(text) {
                        if let Some(found) = walk(&parsed, keys, 1) {
                            return Some(found);
                        }
                    }
                }
            }
        }
        None
    }

    if let Some(text) = params.as_str() {
        let parsed = serde_json::from_str::<Value>(text).ok()?;
        return walk(&parsed, keys, 0);
    }
    walk(params, keys, 0)
}

pub fn lookup_text(params: &Value, keys: &[&str]) -> Option<String> {
    lookup_value(params, keys).and_then(|value| scalar_text(&value))
}

fn lookup_raw_str(params: &Value, keys: &[&str]) -> Option<String> {
    lookup_value(params, keys).and_then(|value| value.as_str().map(str::to_string))
}

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
        "failed" | "error" => "failed".to_string(),
        "killed" | "terminated" | "cancelled" | "canceled" => "killed".to_string(),
        "waiting" | "paused" | "requiresapproval" | "requires_approval" => "waiting".to_string(),
        _ => "running".to_string(),
    }
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

fn tokenize_shell_words(cmd: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut escape = false;
    for ch in cmd.chars() {
        if escape {
            current.push(ch);
            escape = false;
            continue;
        }
        match quote {
            Some(q) if ch == q => quote = None,
            Some(_) => {
                if ch == '\\' {
                    escape = true;
                } else {
                    current.push(ch);
                }
            }
            None if ch == '"' || ch == '\'' => quote = Some(ch),
            None if ch.is_whitespace() => {
                if !current.is_empty() {
                    words.push(std::mem::take(&mut current));
                }
            }
            None => current.push(ch),
        }
    }
    if !current.is_empty() {
        words.push(current);
    }
    words
}

enum DispatchCliCommand<'a> {
    Run(&'a [String]),
    Swarm(&'a [String]),
}

fn match_dispatch_cli(words: &[String]) -> Option<DispatchCliCommand<'_>> {
    for idx in 0..words.len() {
        let bin = Path::new(&words[idx])
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(&words[idx])
            .to_ascii_lowercase();
        if bin == "kite" && words.get(idx + 1).is_some_and(|w| w.eq_ignore_ascii_case("dispatch")) {
            let sub = words.get(idx + 2).map(|s| s.to_ascii_lowercase());
            if sub.as_deref() == Some("run") {
                return Some(DispatchCliCommand::Run(&words[idx + 3..]));
            }
            if sub.as_deref() == Some("swarm") {
                return Some(DispatchCliCommand::Swarm(&words[idx + 3..]));
            }
        } else if bin == "kite-dispatch" {
            let sub = words.get(idx + 1).map(|s| s.to_ascii_lowercase());
            if sub.as_deref() == Some("run") {
                return Some(DispatchCliCommand::Run(&words[idx + 2..]));
            }
            if sub.as_deref() == Some("swarm") {
                return Some(DispatchCliCommand::Swarm(&words[idx + 2..]));
            }
        }
    }
    None
}

fn take_cli_flag<'a>(args: &'a [String], names: &[&str]) -> Option<String> {
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if let Some((flag, val)) = arg.split_once('=') {
            if names.iter().any(|n| flag.eq_ignore_ascii_case(n)) {
                return Some(val.to_string());
            }
        }
        if names.iter().any(|n| arg.eq_ignore_ascii_case(n)) {
            if let Some(next) = args.get(i + 1) {
                return Some(next.clone());
            }
        }
        i += 1;
    }
    None
}

fn collect_cli_positionals(args: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if arg.starts_with("--") {
            if !arg.contains('=')
                && !matches!(arg.as_str(), "--wait" | "--all" | "--json" | "--exact")
                && i + 1 < args.len()
            {
                i += 2;
                continue;
            }
            i += 1;
            continue;
        }
        out.push(arg.clone());
        i += 1;
    }
    out
}

fn strip_mcp_prefix(raw_name: &str, params: &Value) -> (Option<String>, String) {
    let mut server_name = params
        .get("ServerName")
        .or_else(|| params.get("serverName"))
        .or_else(|| params.get("server_name"))
        .and_then(|v| v.as_str())
        .map(String::from);

    let mut clean_name = raw_name.to_string();
    if raw_name == "call_mcp_tool" {
        if let Some(tn) = params
            .get("ToolName")
            .or_else(|| params.get("toolName"))
            .and_then(|v| v.as_str())
        {
            clean_name = tn.to_string();
        }
    } else if let Some(rest) = raw_name.strip_prefix("mcp__") {
        let parts: Vec<&str> = rest.splitn(2, "__").collect();
        if parts.len() == 2 {
            server_name = Some(parts[0].to_string());
            clean_name = parts[1].to_string();
        }
    } else if let Some(rest) = raw_name.strip_prefix("mcp_") {
        let parts: Vec<&str> = rest.splitn(2, '_').collect();
        if parts.len() == 2 && server_name.is_none() {
            server_name = Some(parts[0].to_string());
            clean_name = parts[1].to_string();
        }
    }
    (server_name, clean_name)
}

pub fn is_subagent_tool_name(clean_name: &str) -> bool {
    matches!(
        clean_name.trim().to_ascii_lowercase().as_str(),
        "invoke_subagent"
            | "define_subagent"
            | "send_message"
            | "manage_subagents"
            | "task"
            | "agent"
            | "dispatch_agent"
            | "subagent"
            | "delegate"
            | "spawn_agent"
    )
}

pub fn is_swarm_tool_name(clean_name: &str) -> bool {
    matches!(
        clean_name.trim().to_ascii_lowercase().as_str(),
        "swarm" | "post_message" | "read_board" | "swarm_wait"
    )
}

fn parse_output_json(output: Option<&str>) -> Option<Value> {
    let text = output?.trim();
    if text.starts_with('{') && text.ends_with('}') {
        serde_json::from_str::<Value>(text).ok()
    } else {
        None
    }
}

fn expand_swarm_members(base_name: Option<&str>, params: &Value) -> Vec<String> {
    let mut members = Vec::new();
    let Some(base) = base_name.map(str::trim).filter(|s| !s.is_empty()) else {
        return members;
    };
    if let Some(Value::Array(tasks)) = lookup_value(params, &["tasks"]) {
        if !tasks.is_empty() {
            for idx in 1..=tasks.len() {
                members.push(format!("{base}-{idx}"));
            }
            return members;
        }
    }
    if let Some(n_val) = lookup_value(params, &["n"]).and_then(|v| v.as_u64()) {
        if n_val > 1 {
            for idx in 1..=n_val {
                members.push(format!("{base}-{idx}"));
            }
            return members;
        }
    }
    members.push(base.to_string());
    members
}

pub fn extract_subagent_meta(
    raw_name: &str,
    tool_id: &str,
    params: &Value,
    output: Option<&str>,
    raw_status: &str,
) -> Option<SubagentMeta> {
    let (_, clean_name) = strip_mcp_prefix(raw_name, params);
    let command = lookup_text(params, &["CommandLine", "command", "cmd"]);
    let cli_words = command.as_deref().map(tokenize_shell_words);
    let is_cli_run = cli_words
        .as_deref()
        .is_some_and(|w| matches!(match_dispatch_cli(w), Some(DispatchCliCommand::Run(_))));
    if !is_subagent_tool_name(&clean_name) && !is_cli_run {
        return None;
    }

    let parsed_out = parse_output_json(output);
    let action = lookup_text(params, &["action", "Action"]);

    let mut role = lookup_text(
        params,
        &["Role", "role", "description", "Description", "name", "Name", "title"],
    );
    let mut type_name = lookup_text(
        params,
        &["TypeName", "typeName", "type_name", "subagent_type", "subagentType", "agentType"],
    );
    let mut provider = lookup_text(params, &["Provider", "provider"]);
    let mut model = lookup_text(params, &["Model", "model"]);
    let mut workspace_mode = lookup_text(
        params,
        &["Workspace", "workspace", "workspaceMode", "workspace_mode"],
    )
    .and_then(|w| normalize_workspace_mode(&w));
    let mut prompt = lookup_text(
        params,
        &["Prompt", "prompt", "Message", "message", "brief", "Brief", "task", "instruction"],
    );

    if let Some(words) = cli_words.as_deref() {
        if let Some(DispatchCliCommand::Run(args)) = match_dispatch_cli(words) {
            role = role.or_else(|| take_cli_flag(args, &["--role", "--title"]));
            type_name = type_name.or_else(|| take_cli_flag(args, &["--type"]));
            provider = provider.or_else(|| take_cli_flag(args, &["--provider", "--agent"]));
            model = model.or_else(|| take_cli_flag(args, &["--model"]));
            workspace_mode = workspace_mode.or_else(|| {
                take_cli_flag(args, &["--workspace"]).and_then(|w| normalize_workspace_mode(&w))
            });
            if prompt.is_none() {
                let pos = collect_cli_positionals(args);
                if !pos.is_empty() {
                    prompt = Some(pos.join(" "));
                }
            }
        }
    }

    let out_sub_id = parsed_out.as_ref().and_then(|o| {
        lookup_text(
            o,
            &[
                "conversationId",
                "conversation_id",
                "subagentId",
                "subagent_id",
                "childThreadId",
                "threadId",
                "session_id",
                "sessionId",
            ],
        )
    });
    let param_sub_id = lookup_text(
        params,
        &[
            "subagentId",
            "subagent_id",
            "conversationId",
            "conversation_id",
            "Recipient",
            "recipient",
            "childThreadId",
            "session_id",
            "sessionId",
        ],
    );
    let subagent_id = out_sub_id
        .or(param_sub_id)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            if tool_id.trim().is_empty() {
                clean_name.clone()
            } else {
                tool_id.to_string()
            }
        });

    let child_thread_id = parsed_out
        .as_ref()
        .and_then(|o| lookup_text(o, &["childThreadId", "child_thread_id", "threadId"]))
        .or_else(|| lookup_text(params, &["childThreadId", "child_thread_id"]));
    let transcript_uri = parsed_out
        .as_ref()
        .and_then(|o| {
            lookup_text(
                o,
                &["logAbsoluteUri", "log_absolute_uri", "transcriptUri", "transcript_uri"],
            )
        })
        .or_else(|| {
            lookup_text(
                params,
                &["logAbsoluteUri", "log_absolute_uri", "transcriptUri", "transcript_uri"],
            )
        });
    let latest_activity = parsed_out
        .as_ref()
        .and_then(|o| lookup_text(o, &["latestActivity", "latest_activity"]))
        .or_else(|| lookup_text(params, &["latestActivity", "latest_activity"]));
    let step_count = parsed_out
        .as_ref()
        .and_then(|o| lookup_value(o, &["stepCount", "step_count"]).and_then(|v| v.as_u64()))
        .unwrap_or(0) as usize;

    let resolved_role = role
        .or_else(|| type_name.clone())
        .unwrap_or_else(|| clean_name.replace('_', " "));
    let status = normalize_subagent_status(raw_status, action.as_deref());

    Some(SubagentMeta {
        subagent_id,
        role: resolved_role,
        type_name,
        provider,
        model,
        workspace_mode,
        prompt,
        status,
        transcript_uri,
        child_thread_id,
        latest_activity,
        step_count,
    })
}

pub fn extract_swarm_meta(
    raw_name: &str,
    params: &Value,
    output: Option<&str>,
) -> Option<SwarmMeta> {
    let (_, clean_name) = strip_mcp_prefix(raw_name, params);
    let command = lookup_text(params, &["CommandLine", "command", "cmd"]);
    let cli_words = command.as_deref().map(tokenize_shell_words);
    let is_cli_swarm = cli_words
        .as_deref()
        .is_some_and(|w| matches!(match_dispatch_cli(w), Some(DispatchCliCommand::Swarm(_))));
    if !is_swarm_tool_name(&clean_name) && !is_cli_swarm {
        return None;
    }

    let parsed_out = parse_output_json(output);
    let lower = clean_name.trim().to_ascii_lowercase();

    let mut action = match lower.as_str() {
        "post_message" => "post_message".to_string(),
        "read_board" => "read_board".to_string(),
        "swarm_wait" => "swarm_wait".to_string(),
        _ => lookup_text(params, &["action", "Action"])
            .unwrap_or_else(|| "status".to_string())
            .to_ascii_lowercase(),
    };
    let mut swarm_id = lookup_text(params, &["swarmId", "swarm_id"])
        .or_else(|| parsed_out.as_ref().and_then(|o| lookup_text(o, &["swarmId", "swarm_id"])));
    let mut swarm_title = lookup_text(params, &["title", "Title", "swarmTitle"]);
    let mut member_name = lookup_text(params, &["name", "Name", "memberName", "member_name"]);
    let mut member_names = expand_swarm_members(member_name.as_deref(), params);
    let mut model = lookup_text(params, &["model", "Model"]);
    let mut workspace_mode = lookup_text(
        params,
        &["workspace", "Workspace", "workspaceMode", "workspace_mode"],
    )
    .and_then(|w| normalize_workspace_mode(&w));
    let mut channel = lookup_text(params, &["channel", "Channel"]);
    let mut post_text = lookup_text(params, &["message", "Message", "text", "body", "postText"]);
    let mut brief = lookup_text(params, &["brief", "Brief"]);

    if let Some(words) = cli_words.as_deref() {
        if let Some(DispatchCliCommand::Swarm(args)) = match_dispatch_cli(words) {
            if let Some(sub) = args.first() {
                action = match sub.to_ascii_lowercase().as_str() {
                    "post" | "post_message" => "post_message".to_string(),
                    "read" | "read_board" => "read_board".to_string(),
                    "wait" | "swarm_wait" => "swarm_wait".to_string(),
                    other => other.to_string(),
                };
                let rest = &args[1..];
                swarm_id = swarm_id.or_else(|| take_cli_flag(rest, &["--swarm", "--swarm-id"]));
                swarm_title = swarm_title.or_else(|| take_cli_flag(rest, &["--title"]));
                member_name = member_name.or_else(|| take_cli_flag(rest, &["--name", "--member"]));
                model = model.or_else(|| take_cli_flag(rest, &["--model"]));
                workspace_mode = workspace_mode.or_else(|| {
                    take_cli_flag(rest, &["--workspace"]).and_then(|w| normalize_workspace_mode(&w))
                });
                channel = channel.or_else(|| take_cli_flag(rest, &["--channel"]));
                brief = brief.or_else(|| take_cli_flag(rest, &["--brief"]));

                if member_names.is_empty() {
                    if let Some(tasks_csv) = take_cli_flag(rest, &["--tasks"]) {
                        let base = member_name.as_deref().unwrap_or("worker");
                        let count = tasks_csv.split(',').filter(|s| !s.trim().is_empty()).count();
                        for idx in 1..=count {
                            member_names.push(format!("{base}-{idx}"));
                        }
                    } else if let Some(n_str) = take_cli_flag(rest, &["--n"]) {
                        if let Ok(n) = n_str.parse::<usize>() {
                            let base = member_name.as_deref().unwrap_or("worker");
                            for idx in 1..=n {
                                member_names.push(format!("{base}-{idx}"));
                            }
                        }
                    } else if let Some(ref m) = member_name {
                        member_names.push(m.clone());
                    }
                }

                let pos = collect_cli_positionals(rest);
                if action == "post_message" && post_text.is_none() && !pos.is_empty() {
                    post_text = Some(pos.join(" "));
                } else if action == "title" && swarm_title.is_none() && !pos.is_empty() {
                    swarm_title = Some(pos.join(" "));
                } else if action == "channel" && channel.is_none() && !pos.is_empty() {
                    channel = Some(pos[0].clone());
                } else if action == "add" && brief.is_none() && !pos.is_empty() {
                    brief = Some(pos.join(" "));
                }
            }
        }
    }

    if channel.is_none() && action == "post_message" {
        channel = Some("main".to_string());
    }
    let mentions = post_text
        .as_deref()
        .map(extract_mentions)
        .unwrap_or_default();
    let seq = parsed_out
        .as_ref()
        .and_then(|o| lookup_value(o, &["seq"]).and_then(|v| v.as_u64()))
        .or_else(|| lookup_value(params, &["seq"]).and_then(|v| v.as_u64()));

    Some(SwarmMeta {
        swarm_id,
        action,
        swarm_title,
        member_name,
        member_names,
        model,
        workspace_mode,
        channel,
        post_text,
        mentions,
        seq,
        brief,
    })
}

pub fn merge_subagent_meta(existing: Option<&SubagentMeta>, mut incoming: SubagentMeta) -> SubagentMeta {
    if let Some(prev) = existing {
        if incoming.subagent_id.is_empty() || incoming.subagent_id == prev.subagent_id {
            // Keep prev if incoming only had a fallback tool id while prev resolved conversationId.
        } else if !prev.subagent_id.starts_with("call")
            && !prev.subagent_id.starts_with("tool")
            && incoming.subagent_id.starts_with("tool")
        {
            incoming.subagent_id = prev.subagent_id.clone();
        }
        if incoming.role.trim().is_empty()
            || is_subagent_tool_name(&incoming.role.replace(' ', "_"))
        {
            if !prev.role.trim().is_empty() {
                incoming.role = prev.role.clone();
            }
        }
        if incoming.type_name.is_none() {
            incoming.type_name = prev.type_name.clone();
        }
        if incoming.provider.is_none() {
            incoming.provider = prev.provider.clone();
        }
        if incoming.model.is_none() {
            incoming.model = prev.model.clone();
        }
        if incoming.workspace_mode.is_none() {
            incoming.workspace_mode = prev.workspace_mode.clone();
        }
        if incoming.prompt.is_none() {
            incoming.prompt = prev.prompt.clone();
        }
        if incoming.transcript_uri.is_none() {
            incoming.transcript_uri = prev.transcript_uri.clone();
        }
        if incoming.child_thread_id.is_none() {
            incoming.child_thread_id = prev.child_thread_id.clone();
        }
        if incoming.latest_activity.is_none() {
            incoming.latest_activity = prev.latest_activity.clone();
        }
        if incoming.step_count == 0 {
            incoming.step_count = prev.step_count;
        }
    }
    incoming
}

pub fn merge_swarm_meta(existing: Option<&SwarmMeta>, mut incoming: SwarmMeta) -> SwarmMeta {
    if let Some(prev) = existing {
        if incoming.swarm_id.is_none() {
            incoming.swarm_id = prev.swarm_id.clone();
        }
        if incoming.swarm_title.is_none() {
            incoming.swarm_title = prev.swarm_title.clone();
        }
        if incoming.member_name.is_none() {
            incoming.member_name = prev.member_name.clone();
        }
        if incoming.member_names.is_empty() {
            incoming.member_names = prev.member_names.clone();
        }
        if incoming.model.is_none() {
            incoming.model = prev.model.clone();
        }
        if incoming.workspace_mode.is_none() {
            incoming.workspace_mode = prev.workspace_mode.clone();
        }
        if incoming.channel.is_none() {
            incoming.channel = prev.channel.clone();
        }
        if incoming.post_text.is_none() {
            incoming.post_text = prev.post_text.clone();
        }
        if incoming.mentions.is_empty() {
            incoming.mentions = prev.mentions.clone();
        }
        if incoming.seq.is_none() {
            incoming.seq = prev.seq;
        }
        if incoming.brief.is_none() {
            incoming.brief = prev.brief.clone();
        }
    }
    incoming
}

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

    let cli_words = command.as_deref().map(tokenize_shell_words);
    let cli_kind = cli_words.as_deref().and_then(match_dispatch_cli);

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
    let status = match raw_status {
        "completed" | "done" | "succeeded" => "completed",
        "failed" | "error" => "failed",
        "pending" => "pending",
        _ => "running",
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
