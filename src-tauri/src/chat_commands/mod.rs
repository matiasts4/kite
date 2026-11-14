use serde_json::Value;

mod attachments_cmd;
mod subagents_ui;
mod threads_cmd;
mod turns_cmd;

pub(crate) use threads_cmd::forget_thread;

#[tauri::command]
pub fn create_general_chat(request: Option<Value>) -> Value {
    threads_cmd::create_general_chat(request)
}

#[tauri::command]
pub fn create_agent_chat(request: Option<Value>) -> Value {
    threads_cmd::create_agent_chat(request)
}

#[tauri::command]
pub async fn load_chat_thread(request: Option<Value>) -> Value {
    tokio::task::spawn_blocking(move || threads_cmd::load_chat_thread(request))
        .await
        .unwrap_or(Value::Null)
}

#[tauri::command]
pub async fn load_agent_chat_thread(request: Option<Value>) -> Value {
    tokio::task::spawn_blocking(move || threads_cmd::load_agent_chat_thread(request))
        .await
        .unwrap_or(Value::Null)
}

#[tauri::command]
pub fn recover_chat_thread(request: Option<Value>) -> Value {
    threads_cmd::recover_chat_thread(request)
}

#[tauri::command]
pub fn rename_chat_thread(request: Option<Value>) -> Value {
    threads_cmd::rename_chat_thread(request)
}

#[tauri::command]
pub fn rename_agent_chat_thread(request: Option<Value>) -> Value {
    threads_cmd::rename_agent_chat_thread(request)
}

#[tauri::command]
pub fn set_chat_thread_pinned(request: Option<Value>) -> Value {
    threads_cmd::set_chat_thread_pinned(request)
}

#[tauri::command]
pub fn set_agent_chat_model(request: Option<Value>) -> Value {
    threads_cmd::set_agent_chat_model(request)
}

#[tauri::command]
pub fn set_agent_chat_plan(request: Option<Value>) -> Value {
    threads_cmd::set_agent_chat_plan(request)
}

#[tauri::command]
pub fn update_chat_configuration(request: Option<Value>) -> Value {
    threads_cmd::update_chat_configuration(request)
}

#[tauri::command]
pub async fn list_chat_summaries(request: Option<Value>) -> Value {
    tokio::task::spawn_blocking(move || threads_cmd::list_chat_summaries(request))
        .await
        .unwrap_or_else(|_| serde_json::json!({ "summaries": [] }))
}

#[tauri::command]
pub async fn list_agent_chat_summaries(request: Option<Value>) -> Value {
    tokio::task::spawn_blocking(move || threads_cmd::list_agent_chat_summaries(request))
        .await
        .unwrap_or_else(|_| serde_json::json!({ "summaries": [] }))
}

#[tauri::command]
pub fn list_archived_chats(request: Option<Value>) -> Vec<Value> {
    threads_cmd::list_archived_chats(request)
}

#[tauri::command]
pub fn restore_archived_chat(request: Option<Value>) -> Value {
    threads_cmd::restore_archived_chat(request)
}

#[tauri::command]
pub fn archive_chat_thread(request: Option<Value>) -> Value {
    threads_cmd::archive_chat_thread(request)
}

#[tauri::command]
pub fn archive_agent_chat_thread(request: Option<Value>) -> Value {
    threads_cmd::archive_agent_chat_thread(request)
}

#[tauri::command]
pub fn delete_chat_thread(request: Option<Value>) -> Value {
    threads_cmd::delete_chat_thread(request)
}

#[tauri::command]
pub fn delete_agent_chat_thread(request: Option<Value>) -> Value {
    threads_cmd::delete_agent_chat_thread(request)
}

#[tauri::command]
pub fn purge_archived_chat(request: Option<Value>) -> Value {
    threads_cmd::purge_archived_chat(request)
}

#[tauri::command]
pub fn reorder_agent_chat_tabs(request: Option<Value>) -> Value {
    threads_cmd::reorder_agent_chat_tabs(request)
}

#[tauri::command]
pub async fn list_chat_provider_models(request: Option<Value>) -> Value {
    tokio::task::spawn_blocking(move || turns_cmd::list_chat_provider_models(request))
        .await
        .unwrap_or(Value::Null)
}

#[tauri::command]
pub async fn list_provider_agents(request: Option<Value>) -> Value {
    tokio::task::spawn_blocking(move || turns_cmd::list_provider_agents(request))
        .await
        .unwrap_or(Value::Null)
}

#[tauri::command]
pub fn list_live_chat_runs(_request: Option<Value>) -> Vec<Value> {
    turns_cmd::list_live_chat_runs(_request)
}

#[tauri::command]
pub fn get_chat_session_status(request: Option<Value>) -> Value {
    turns_cmd::get_chat_session_status(request)
}

#[tauri::command]
pub fn start_chat_turn(request: Option<Value>) -> Value {
    turns_cmd::start_chat_turn(request)
}

#[tauri::command]
pub fn start_agent_chat_turn(request: Option<Value>) -> Value {
    turns_cmd::start_agent_chat_turn(request)
}

#[tauri::command]
pub fn read_chat_turn_updates(request: Option<Value>) -> Value {
    turns_cmd::read_chat_turn_updates(request)
}

#[tauri::command]
pub fn read_agent_chat_turn_updates(request: Option<Value>) -> Value {
    turns_cmd::read_agent_chat_turn_updates(request)
}

#[tauri::command]
pub fn cancel_chat_turn(request: Option<Value>) -> Value {
    turns_cmd::cancel_chat_turn(request)
}

#[tauri::command]
pub fn cancel_agent_chat_turn(request: Option<Value>) -> Value {
    turns_cmd::cancel_agent_chat_turn(request)
}

#[tauri::command]
pub fn respond_chat_approval(request: Option<Value>) -> Value {
    turns_cmd::respond_chat_approval(request)
}

#[tauri::command]
pub fn respond_chat_user_input(request: Option<Value>) -> Value {
    turns_cmd::respond_chat_user_input(request)
}

#[tauri::command]
pub async fn load_thread_grid(request: Option<Value>) -> Value {
    tokio::task::spawn_blocking(move || turns_cmd::load_thread_grid(request))
        .await
        .unwrap_or(Value::Null)
}

#[tauri::command]
pub fn save_thread_grid(request: Value) -> Value {
    turns_cmd::save_thread_grid(request)
}

#[tauri::command]
pub fn stage_chat_blob(request: Option<Value>) -> Value {
    attachments_cmd::stage_chat_blob(request)
}

#[tauri::command]
pub fn stage_dropped_chat_attachments(request: Option<Value>) -> Value {
    attachments_cmd::stage_dropped_chat_attachments(request)
}

#[tauri::command]
pub fn rewind_thread_transcript(request: Option<Value>) -> Value {
    attachments_cmd::rewind_thread_transcript(request)
}

#[tauri::command]
pub fn restore_thread_checkpoint(request: Option<Value>) -> Value {
    attachments_cmd::restore_thread_checkpoint(request)
}

#[tauri::command]
pub fn release_chat_attachment(request: Option<Value>) -> Value {
    attachments_cmd::release_chat_attachment(request)
}

#[tauri::command]
pub async fn get_thread_subagent_detail(request: Option<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || subagents_ui::get_thread_subagent_detail(request))
        .await
        .unwrap_or(Value::Null)
}

#[tauri::command]
pub async fn list_all_subagent_runs(request: Option<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || subagents_ui::list_all_subagent_runs(request))
        .await
        .unwrap_or(Value::Null)
}

#[tauri::command]
pub async fn get_thread_swarm_state(request: Option<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || subagents_ui::get_thread_swarm_state(request))
        .await
        .unwrap_or(Value::Null)
}

#[tauri::command]
pub async fn send_subagent_message(request: Option<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || subagents_ui::send_subagent_message(request))
        .await
        .unwrap_or_else(|e| serde_json::json!({ "error": e.to_string() }))
}

#[tauri::command]
pub async fn stop_subagent_run(request: Option<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || subagents_ui::stop_subagent_run(request))
        .await
        .unwrap_or_else(|e| serde_json::json!({ "error": e.to_string() }))
}

#[tauri::command]
pub async fn swarm_post_from_ui(request: Option<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || subagents_ui::swarm_post_from_ui(request))
        .await
        .unwrap_or_else(|e| serde_json::json!({ "error": e.to_string() }))
}

#[tauri::command]
pub async fn swarm_switch_worker_model(request: Option<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || subagents_ui::swarm_switch_worker_model(request))
        .await
        .unwrap_or_else(|e| serde_json::json!({ "error": e.to_string() }))
}

#[tauri::command]
pub async fn swarm_kill_worker_from_ui(request: Option<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || subagents_ui::swarm_kill_worker_from_ui(request))
        .await
        .unwrap_or_else(|e| serde_json::json!({ "error": e.to_string() }))
}

#[tauri::command]
pub async fn get_subagent_settings(request: Option<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || subagents_ui::get_subagent_settings(request))
        .await
        .unwrap_or_else(|e| serde_json::json!({ "error": e.to_string() }))
}

#[tauri::command]
pub async fn save_subagent_settings(request: Option<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || subagents_ui::save_subagent_settings(request))
        .await
        .unwrap_or_else(|e| serde_json::json!({ "error": e.to_string() }))
}

#[tauri::command]
pub async fn list_subagent_roles(request: Option<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || subagents_ui::list_subagent_roles(request))
        .await
        .unwrap_or_else(|e| serde_json::json!({ "error": e.to_string() }))
}

#[tauri::command]
pub async fn save_subagent_role(request: Option<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || subagents_ui::save_subagent_role(request))
        .await
        .unwrap_or_else(|e| serde_json::json!({ "error": e.to_string() }))
}

#[tauri::command]
pub async fn delete_subagent_role(request: Option<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || subagents_ui::delete_subagent_role(request))
        .await
        .unwrap_or_else(|e| serde_json::json!({ "error": e.to_string() }))
}

#[tauri::command]
pub async fn pick_chat_attachments(app: tauri::AppHandle, request: Option<Value>) -> Value {
    attachments_cmd::pick_chat_attachments(app, request).await
}

#[cfg(test)]
#[path = "../chat_commands_tests.rs"]
mod tests;
