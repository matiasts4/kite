use serde::{Deserialize, Serialize};
use serde_json::Value;

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

pub(super) fn lookup_raw_str(params: &Value, keys: &[&str]) -> Option<String> {
    lookup_value(params, keys).and_then(|value| value.as_str().map(str::to_string))
}

