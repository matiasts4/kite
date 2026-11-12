use serde_json::Value;

pub mod commands;
pub mod quota;
pub mod registry;
pub mod storage;

#[cfg(test)]
mod tests;

pub use commands::*;
pub use quota::*;
pub use registry::*;
pub use storage::*;

// ---------------------------------------------------------------------------
// Public Tauri Commands (thin delegators preserving macro registration)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_saved_accounts(request: Option<Value>) -> Value {
    commands::list_saved_accounts_impl(request).await
}

#[tauri::command]
pub fn list_detected_cli_accounts() -> Value {
    commands::list_detected_cli_accounts_impl()
}

#[tauri::command]
pub fn save_current_account_profile(request: Option<Value>) -> Value {
    commands::save_current_account_profile_impl(request)
}

#[tauri::command]
pub async fn switch_account_profile(request: Option<Value>) -> Value {
    commands::switch_account_profile_impl(request).await
}

#[tauri::command]
pub fn delete_account_profile(request: Option<Value>) -> Value {
    commands::delete_account_profile_impl(request)
}

#[tauri::command]
pub fn get_active_account_profile(request: Option<Value>) -> Value {
    commands::get_active_account_profile_impl(request)
}

#[tauri::command]
pub fn prepare_new_account_login(request: Option<Value>) -> Value {
    commands::prepare_new_account_login_impl(request)
}
