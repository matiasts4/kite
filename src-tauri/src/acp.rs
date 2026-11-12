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

/// Reads active Antigravity credentials and ~/.gemini/google_accounts.json to list accounts.
#[tauri::command]
pub fn antigravity_list_google_accounts() -> Result<serde_json::Value, String> {
    accounts::antigravity_list_google_accounts_impl()
}

/// Switches the active Google account in ~/.gemini/google_accounts.json.
#[tauri::command]
pub fn antigravity_set_active_google_account(email: String) -> Result<serde_json::Value, String> {
    accounts::antigravity_set_active_google_account_impl(email)
}
