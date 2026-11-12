// Kite Code — Tickets & Tasks Subsystem and MCP Server
// Supports local task management, agent task execution, and stdio MCP server for agents

pub mod commands;
pub mod document;
pub mod mcp;
pub mod storage;

#[cfg(test)]
mod tests;

pub use commands::*;
pub use document::*;
pub use mcp::*;
pub use storage::*;

use serde_json::Value;

#[tauri::command]
pub fn ticket_snapshot() -> Value {
    commands::ticket_snapshot()
}

#[tauri::command]
pub fn ticket_call(request: Option<Value>) -> Value {
    commands::ticket_call(request)
}

#[tauri::command]
pub fn ticket_connect(request: Option<Value>) -> Value {
    commands::ticket_connect(request)
}

#[tauri::command]
pub fn ticket_configuration(request: Option<Value>) -> Value {
    commands::ticket_configuration(request)
}

#[tauri::command]
pub fn ticket_revoke(request: Option<Value>) -> Value {
    commands::ticket_revoke(request)
}

#[tauri::command]
pub fn ticket_recover(request: Option<Value>) -> Value {
    commands::ticket_recover(request)
}
