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
pub struct AcpToolCall {
    pub id: String,
    pub name: String,
    pub title: String,
    pub detail: String,
    pub tool_kind: String, // "commandExecution" | "fileChange" | "mcpToolCall" | "webSearch" | "dynamicToolCall"
    pub server_name: Option<String>,
    pub command: Option<String>,
    pub file_path: Option<String>,
    pub added_lines: Option<usize>,
    pub removed_lines: Option<usize>,
    pub parameters: Value,
    pub status: String, // "pending" | "running" | "completed" | "failed" | "requiresApproval"
    pub output: Option<String>,
    pub duration_seconds: Option<f64>,
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

pub fn lookup_text(params: &Value, keys: &[&str]) -> Option<String> {
    fn walk(params: &Value, keys: &[&str], depth: usize) -> Option<String> {
        let obj = params.as_object()?;
        for (key, value) in obj {
            if keys.iter().any(|candidate| candidate.eq_ignore_ascii_case(key)) {
                if let Some(text) = scalar_text(value) {
                    return Some(text);
                }
            }
        }
        if depth >= 1 {
            return None;
        }
        for (key, value) in obj {
            if ["arguments", "args", "input", "parameters"]
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

pub fn generic_tool_action(action: &str) -> bool {
    matches!(
        action.trim().to_ascii_lowercase().replace('_', " ").as_str(),
        "read" | "read file" | "edit" | "edit file" | "write" | "write file" | "file" | "tool" | "tool execution"
    )
}

pub fn classify_tool_metadata(raw_name: &str, params: &Value) -> (String, Option<String>, String, Option<String>, Option<String>, Option<usize>, Option<usize>) {
    let lower = raw_name.to_lowercase();

    // Extract MCP server name & clean tool name if formatted like mcp__server__tool or mcp_server_tool or call_mcp_tool
    let mut server_name = params
        .get("ServerName")
        .or_else(|| params.get("serverName"))
        .or_else(|| params.get("server_name"))
        .and_then(|v| v.as_str())
        .map(String::from);

    let mut clean_name = raw_name.to_string();
    if raw_name == "call_mcp_tool" {
        if let Some(tn) = params.get("ToolName").or_else(|| params.get("toolName")).and_then(|v| v.as_str()) {
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

    let target_str = params
        .get("TargetContent")
        .or_else(|| params.get("Target"))
        .or_else(|| params.get("target"))
        .or_else(|| params.get("old_string"))
        .or_else(|| params.get("old_str"))
        .or_else(|| params.get("oldText"))
        .or_else(|| params.get("old_text"))
        .or_else(|| params.get("find"))
        .and_then(|v| v.as_str());

    let replacement_str = params
        .get("ReplacementContent")
        .or_else(|| params.get("Replacement"))
        .or_else(|| params.get("replacement"))
        .or_else(|| params.get("new_string"))
        .or_else(|| params.get("new_str"))
        .or_else(|| params.get("newText"))
        .or_else(|| params.get("new_text"))
        .or_else(|| params.get("replace"))
        .and_then(|v| v.as_str());

    let mut added_lines = None;
    let mut removed_lines = None;
    if let (Some(target), Some(replacement)) = (target_str, replacement_str) {
        removed_lines = Some(target.lines().count().max(if target.is_empty() { 0 } else { 1 }));
        added_lines = Some(replacement.lines().count().max(if replacement.is_empty() { 0 } else { 1 }));
    } else if let Some(code) = params
        .get("CodeContent")
        .or_else(|| params.get("Content"))
        .or_else(|| params.get("content"))
        .or_else(|| params.get("text"))
        .and_then(|v| v.as_str())
    {
        if file_path.is_some() {
            added_lines = Some(code.lines().count().max(if code.is_empty() { 0 } else { 1 }));
            removed_lines = Some(0);
        }
    }

    let tool_kind = if server_name.is_some() || lower.contains("mcp") {
        "mcpToolCall"
    } else if command.is_some() || lower.contains("bash") || lower.contains("command") || lower.contains("shell") || lower.contains("exec") {
        "commandExecution"
    } else if added_lines.is_some()
        || lower.contains("edit")
        || lower.contains("write")
        || lower.contains("replace")
        || lower.contains("patch")
    {
        "fileChange"
    } else if lower.contains("web") || lower.contains("url") || lower.contains("browser") || lower.contains("fetch") {
        "webSearch"
    } else {
        "dynamicToolCall"
    };

    let explicit_action = lookup_text(params, &["toolAction", "toolSummary", "Instruction", "Description"])
        .filter(|action| !generic_tool_action(action));

    let title = if let Some(action) = explicit_action {
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
