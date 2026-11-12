//! Antigravity Agent Client Protocol (ACP) & Stream Protocol Engine
//! Provides structured bidirectional communication, interactive tool approvals,
//! and live thought/tool delta dispatch.

pub mod accounts;
pub mod stream;
pub mod types;

#[cfg(test)]
mod tests;

pub use accounts::*;
pub use stream::*;
pub use types::*;

/// Discovers native MCP servers grouped by provider (Antigravity, Claude Code, Codex, Cursor, Gemini, and Kite built-in).
#[tauri::command]
pub fn list_provider_mcp_servers(request: Option<serde_json::Value>) -> serde_json::Value {
    accounts::list_provider_mcp_servers_impl(request)
}
