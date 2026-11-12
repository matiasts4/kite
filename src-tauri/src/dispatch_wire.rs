//! Live ports and the loopback CLI. Policy stays in `dispatch` and does not import this file.

pub mod audit;
pub mod commands;
pub mod protocol;
pub mod server;

#[cfg(test)]
mod tests;

pub use audit::*;
pub use commands::*;
pub use protocol::*;
pub use server::*;

use serde_json::Value;

// ---------------------------------------------------------------------------
// Tauri Command Delegators (preserving command registration contract)
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn dispatch_send(request: Option<Value>) -> Value {
    commands::dispatch_send(request)
}

#[tauri::command]
pub fn dispatch_publish(request: Option<Value>) -> Value {
    commands::dispatch_publish(request)
}

#[tauri::command]
pub fn dispatch_osc(request: Option<Value>) -> Value {
    commands::dispatch_osc(request)
}

#[tauri::command]
pub fn dispatch_ls(request: Option<Value>) -> Value {
    commands::dispatch_ls(request)
}

#[tauri::command]
pub fn dispatch_run(request: Option<Value>) -> Value {
    commands::dispatch_run(request)
}

#[tauri::command]
pub fn dispatch_wait(request: Option<Value>) -> Value {
    commands::dispatch_wait(request)
}

#[tauri::command]
pub fn dispatch_read(request: Option<Value>) -> Value {
    commands::dispatch_read(request)
}

#[tauri::command]
pub fn dispatch_report(request: Option<Value>) -> Value {
    commands::dispatch_report(request)
}

#[tauri::command]
pub fn dispatch_skill() -> Value {
    commands::dispatch_skill()
}

/// Records that a pane attached. Does not take the policy lock.
#[tauri::command]
pub fn dispatch_pane_shown(request: Option<Value>) -> Value {
    commands::dispatch_pane_shown(request)
}

#[tauri::command]
pub fn dispatch_kill(request: Option<Value>) -> Value {
    commands::dispatch_kill(request)
}

#[tauri::command]
pub fn dispatch_interrupt(request: Option<Value>) -> Value {
    commands::dispatch_interrupt(request)
}

#[tauri::command]
pub fn dispatch_keys(request: Option<Value>) -> Value {
    commands::dispatch_keys(request)
}

#[tauri::command]
pub fn dispatch_attach(request: Option<Value>) -> Value {
    commands::dispatch_attach(request)
}
