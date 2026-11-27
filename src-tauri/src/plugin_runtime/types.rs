//! Shared contracts and data types for Kite Code's extensible plugin runtime.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PluginSourceKind {
    Workspace,
    GlobalKite,
    SharedSystem,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PluginManifestFormat {
    Native,
    Claude,
    Cursor,
    GeminiExtension,
    LegacyManifest,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarUiView {
    pub title: String,
    pub path: String,
    pub entrypoint: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum SidecarRestartPolicy {
    Always,
    #[default]
    OnFailure,
    Never,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarSpec {
    pub id: String,
    pub namespaced_id: String,
    pub plugin_id: String,
    pub plugin_name: String,
    pub display_name: String,
    pub description: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub builtin: Option<String>,
    pub restart_policy: SidecarRestartPolicy,
    pub has_web_ui: bool,
    pub views: Vec<SidecarUiView>,
    pub working_dir: PathBuf,
    pub plugin_root: PathBuf,
    pub plugin_data: PathBuf,
    pub allows_user_interactions: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "transport", rename_all = "camelCase")]
pub enum PluginMcpTransport {
    Stdio {
        command: String,
        args: Vec<String>,
        env: BTreeMap<String, String>,
    },
    Http {
        url: String,
        headers: BTreeMap<String, String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginMcpServer {
    pub id: String,
    pub server_name: String,
    pub plugin_id: String,
    pub config: PluginMcpTransport,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSkillInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub path: PathBuf,
    pub disable_model_invocation: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRuleInfo {
    pub name: String,
    pub path: PathBuf,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginAgentProfileInfo {
    pub slug: String,
    pub name: String,
    pub description: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub workspace: Option<String>,
    pub body: String,
    pub path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredPlugin {
    pub dir_id: String,
    pub name: String,
    pub display_name: String,
    pub description: String,
    pub version: Option<String>,
    pub author: Option<String>,
    pub homepage: Option<String>,
    pub repository: Option<String>,
    pub license: Option<String>,
    pub keywords: Vec<String>,
    pub suggested_prompts: Vec<String>,
    pub logo_data_uri: Option<String>,
    pub source: PluginSourceKind,
    pub format: PluginManifestFormat,
    pub root_path: PathBuf,
    pub data_path: PathBuf,
    pub enabled: bool,
    pub manifest_disabled: bool,
    pub can_uninstall: bool,
    pub has_hooks: bool,
    pub hooks_path: Option<PathBuf>,
    pub sidecars: Vec<SidecarSpec>,
    pub mcp_servers: Vec<PluginMcpServer>,
    pub skills: Vec<PluginSkillInfo>,
    pub rules: Vec<PluginRuleInfo>,
    pub agents: Vec<PluginAgentProfileInfo>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRuntimeSettings {
    #[serde(default = "default_true")]
    pub enable_shared_system_roots: bool,
    #[serde(default)]
    pub extra_plugin_dirs: Vec<String>,
    #[serde(default = "default_true")]
    pub auto_start_ui_sidecars: bool,
}

impl Default for PluginRuntimeSettings {
    fn default() -> Self {
        Self {
            enable_shared_system_roots: true,
            extra_plugin_dirs: Vec::new(),
            auto_start_ui_sidecars: true,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum SidecarStateKind {
    #[default]
    Stopped,
    Starting,
    Running,
    Unhealthy,
    Crashed,
    Stopping,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarStatusSnapshot {
    pub namespaced_id: String,
    pub sidecar_id: String,
    pub plugin_id: String,
    pub plugin_name: String,
    pub display_name: String,
    pub description: String,
    pub has_web_ui: bool,
    pub views: Vec<SidecarUiView>,
    pub state: SidecarStateKind,
    pub pid: Option<u32>,
    pub upstream_port: Option<u16>,
    pub proxy_port: Option<u16>,
    pub proxy_url: Option<String>,
    pub entry_url: Option<String>,
    pub log_path: String,
    pub restart_count: u32,
    pub last_error: Option<String>,
    pub started_at_ms: Option<i64>,
    pub builtin: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSkillSummaryDto {
    pub id: String,
    pub name: String,
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginMcpSummaryDto {
    pub id: String,
    pub server_name: String,
    pub transport: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRecordDto {
    pub dir_id: String,
    pub name: String,
    pub display_name: String,
    pub description: String,
    pub version: Option<String>,
    pub author: Option<String>,
    pub homepage: Option<String>,
    pub repository: Option<String>,
    pub license: Option<String>,
    pub keywords: Vec<String>,
    pub suggested_prompts: Vec<String>,
    pub logo_data_uri: Option<String>,
    pub source: PluginSourceKind,
    pub format: PluginManifestFormat,
    pub root_path: String,
    pub enabled: bool,
    pub can_uninstall: bool,
    pub has_hooks: bool,
    pub skills: Vec<PluginSkillSummaryDto>,
    pub rule_names: Vec<String>,
    pub agent_slugs: Vec<String>,
    pub mcp_servers: Vec<PluginMcpSummaryDto>,
    pub sidecars: Vec<SidecarStatusSnapshot>,
}
