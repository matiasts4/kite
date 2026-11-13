use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentRun {
    pub subagent_id: String,
    pub parent_thread_id: String,
    pub parent_tool_call_id: String,
    pub role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub swarm_member_name: Option<String>,
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
    #[serde(default)]
    pub items: Vec<Value>,
    pub started_at_unix_ms: i64,
    pub updated_at_unix_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at_unix_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwarmMember {
    pub name: String,
    pub role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_mode: Option<String>,
    pub state: String, // "waiting" | "working" | "stopped" | "killed"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_activity: Option<String>,
    #[serde(default)]
    pub channels: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub child_thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brief: Option<String>,
    #[serde(default)]
    pub last_read_seq: u64,
    #[serde(default)]
    pub pending_wake: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwarmBoardPost {
    pub seq: u64,
    pub author: String,
    pub channel: String,
    pub text: String,
    #[serde(default)]
    pub mentions: Vec<String>,
    pub created_at_unix_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwarmChannel {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub topic: Option<String>,
    #[serde(default)]
    pub archived: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwarmState {
    pub swarm_id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coordinator_model: Option<String>,
    #[serde(default)]
    pub members: Vec<SwarmMember>,
    #[serde(default)]
    pub posts: Vec<SwarmBoardPost>,
    #[serde(default)]
    pub channels: Vec<SwarmChannel>,
}

impl SwarmState {
    pub fn empty_for(thread_id: &str, coordinator_model: Option<String>) -> Self {
        Self {
            swarm_id: format!("swarm_{thread_id}"),
            title: "Swarm".to_string(),
            coordinator_model,
            members: Vec::new(),
            posts: Vec::new(),
            channels: vec![SwarmChannel {
                name: "main".to_string(),
                topic: None,
                archived: false,
            }],
        }
    }
}


#[derive(Debug, Clone)]
pub struct ChildSubagentSpawnParams {
    pub parent_thread_id: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub role: Option<String>,
    pub workspace_mode: String,
    pub fallback_cwd: Option<String>,
    pub task: String,
}

#[derive(Debug, Clone)]
pub struct ChildSubagentSpawnResult {
    pub child_thread_id: String,
    pub provider: String,
    pub model: Option<String>,
    pub working_directory: Option<String>,
}

