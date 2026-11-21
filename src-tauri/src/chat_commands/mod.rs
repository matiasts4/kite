use serde_json::Value;

mod attachments_cmd;
mod subagents_ui;
mod threads_cmd;
mod turns_cmd;

pub(crate) use threads_cmd::forget_thread;

#[tauri::command]
pub async fn create_general_chat(request: Option<Value>) -> Value {
    tokio::task::spawn_blocking(move || threads_cmd::create_general_chat(request))
        .await
        .unwrap_or(Value::Null)
}

#[tauri::command]
pub async fn create_agent_chat(request: Option<Value>) -> Value {
    tokio::task::spawn_blocking(move || threads_cmd::create_agent_chat(request))
        .await
        .unwrap_or(Value::Null)
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
pub async fn recover_chat_thread(request: Option<Value>) -> Value {
    tokio::task::spawn_blocking(move || threads_cmd::recover_chat_thread(request))
        .await
        .unwrap_or(Value::Null)
}

#[tauri::command]
pub async fn rename_chat_thread(request: Option<Value>) -> Value {
    tokio::task::spawn_blocking(move || threads_cmd::rename_chat_thread(request))
        .await
        .unwrap_or(Value::Null)
}

#[tauri::command]
pub async fn rename_agent_chat_thread(request: Option<Value>) -> Value {
    tokio::task::spawn_blocking(move || threads_cmd::rename_agent_chat_thread(request))
        .await
        .unwrap_or(Value::Null)
}

#[tauri::command]
pub async fn regenerate_chat_thread_title(request: Option<Value>) -> Value {
    tokio::task::spawn_blocking(move || threads_cmd::regenerate_chat_thread_title(request))
        .await
        .unwrap_or(Value::Null)
}

#[tauri::command]
pub async fn set_chat_thread_pinned(request: Option<Value>) -> Value {
    tokio::task::spawn_blocking(move || threads_cmd::set_chat_thread_pinned(request))
        .await
        .unwrap_or(Value::Null)
}

#[tauri::command]
pub async fn set_agent_chat_model(request: Option<Value>) -> Value {
    tokio::task::spawn_blocking(move || threads_cmd::set_agent_chat_model(request))
        .await
        .unwrap_or(Value::Null)
}

#[tauri::command]
pub async fn set_agent_chat_plan(request: Option<Value>) -> Value {
    tokio::task::spawn_blocking(move || threads_cmd::set_agent_chat_plan(request))
        .await
        .unwrap_or(Value::Null)
}

#[tauri::command]
pub async fn update_chat_configuration(request: Option<Value>) -> Value {
    tokio::task::spawn_blocking(move || threads_cmd::update_chat_configuration(request))
        .await
        .unwrap_or(Value::Null)
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
pub async fn list_archived_chats(request: Option<Value>) -> Vec<Value> {
    tokio::task::spawn_blocking(move || threads_cmd::list_archived_chats(request))
        .await
        .unwrap_or_default()
}

#[tauri::command]
pub async fn restore_archived_chat(request: Option<Value>) -> Value {
    tokio::task::spawn_blocking(move || threads_cmd::restore_archived_chat(request))
        .await
        .unwrap_or(Value::Null)
}

#[tauri::command]
pub async fn archive_chat_thread(request: Option<Value>) -> Value {
    tokio::task::spawn_blocking(move || threads_cmd::archive_chat_thread(request))
        .await
        .unwrap_or(Value::Null)
}

#[tauri::command]
pub async fn archive_agent_chat_thread(request: Option<Value>) -> Value {
    tokio::task::spawn_blocking(move || threads_cmd::archive_agent_chat_thread(request))
        .await
        .unwrap_or(Value::Null)
}

#[tauri::command]
pub async fn delete_chat_thread(request: Option<Value>) -> Value {
    tokio::task::spawn_blocking(move || threads_cmd::delete_chat_thread(request))
        .await
        .unwrap_or(Value::Null)
}

#[tauri::command]
pub async fn delete_agent_chat_thread(request: Option<Value>) -> Value {
    tokio::task::spawn_blocking(move || threads_cmd::delete_agent_chat_thread(request))
        .await
        .unwrap_or(Value::Null)
}

#[tauri::command]
pub async fn purge_archived_chat(request: Option<Value>) -> Value {
    tokio::task::spawn_blocking(move || threads_cmd::purge_archived_chat(request))
        .await
        .unwrap_or(Value::Null)
}

#[tauri::command]
pub async fn reorder_agent_chat_tabs(request: Option<Value>) -> Value {
    tokio::task::spawn_blocking(move || threads_cmd::reorder_agent_chat_tabs(request))
        .await
        .unwrap_or(Value::Null)
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
pub async fn list_live_chat_runs(request: Option<Value>) -> Vec<Value> {
    tokio::task::spawn_blocking(move || turns_cmd::list_live_chat_runs(request))
        .await
        .unwrap_or_default()
}

#[tauri::command]
pub async fn get_chat_session_status(request: Option<Value>) -> Value {
    tokio::task::spawn_blocking(move || turns_cmd::get_chat_session_status(request))
        .await
        .unwrap_or(Value::Null)
}

#[tauri::command]
pub async fn start_chat_turn(request: Option<Value>) -> Value {
    tokio::task::spawn_blocking(move || turns_cmd::start_chat_turn(request))
        .await
        .unwrap_or_else(|e| serde_json::json!({ "error": format!("start turn task failed: {e}") }))
}

#[tauri::command]
pub async fn start_agent_chat_turn(request: Option<Value>) -> Value {
    tokio::task::spawn_blocking(move || turns_cmd::start_agent_chat_turn(request))
        .await
        .unwrap_or_else(|e| serde_json::json!({ "error": format!("start turn task failed: {e}") }))
}

#[tauri::command]
pub async fn read_chat_turn_updates(request: Option<Value>) -> Value {
    tokio::task::spawn_blocking(move || turns_cmd::read_chat_turn_updates(request))
        .await
        .unwrap_or_else(|e| serde_json::json!({ "error": format!("turn update task failed: {e}") }))
}

#[tauri::command]
pub async fn read_agent_chat_turn_updates(request: Option<Value>) -> Value {
    tokio::task::spawn_blocking(move || turns_cmd::read_agent_chat_turn_updates(request))
        .await
        .unwrap_or_else(|e| serde_json::json!({ "error": format!("turn update task failed: {e}") }))
}

#[tauri::command]
pub async fn cancel_chat_turn(request: Option<Value>) -> Value {
    tokio::task::spawn_blocking(move || turns_cmd::cancel_chat_turn(request))
        .await
        .unwrap_or(Value::Null)
}

#[tauri::command]
pub async fn cancel_agent_chat_turn(request: Option<Value>) -> Value {
    tokio::task::spawn_blocking(move || turns_cmd::cancel_agent_chat_turn(request))
        .await
        .unwrap_or(Value::Null)
}

#[tauri::command]
pub async fn respond_chat_approval(request: Option<Value>) -> Value {
    tokio::task::spawn_blocking(move || turns_cmd::respond_chat_approval(request))
        .await
        .unwrap_or(Value::Null)
}

#[tauri::command]
pub async fn respond_chat_user_input(request: Option<Value>) -> Value {
    tokio::task::spawn_blocking(move || turns_cmd::respond_chat_user_input(request))
        .await
        .unwrap_or(Value::Null)
}

#[tauri::command]
pub async fn load_thread_grid(request: Option<Value>) -> Value {
    tokio::task::spawn_blocking(move || turns_cmd::load_thread_grid(request))
        .await
        .unwrap_or(Value::Null)
}

#[tauri::command]
pub async fn save_thread_grid(request: Value) -> Value {
    tokio::task::spawn_blocking(move || turns_cmd::save_thread_grid(request))
        .await
        .unwrap_or(Value::Null)
}

#[tauri::command]
pub async fn stage_chat_blob(request: Option<Value>) -> Value {
    tokio::task::spawn_blocking(move || attachments_cmd::stage_chat_blob(request))
        .await
        .unwrap_or(Value::Null)
}

#[tauri::command]
pub async fn stage_dropped_chat_attachments(request: Option<Value>) -> Value {
    tokio::task::spawn_blocking(move || attachments_cmd::stage_dropped_chat_attachments(request))
        .await
        .unwrap_or(Value::Null)
}

#[tauri::command]
pub async fn read_chat_attachment_preview(request: Option<Value>) -> Value {
    tokio::task::spawn_blocking(move || attachments_cmd::read_chat_attachment_preview(request))
        .await
        .unwrap_or(Value::Null)
}

#[tauri::command]
pub async fn rewind_thread_transcript(request: Option<Value>) -> Value {
    tokio::task::spawn_blocking(move || attachments_cmd::rewind_thread_transcript(request))
        .await
        .unwrap_or(Value::Null)
}

#[tauri::command]
pub async fn restore_thread_checkpoint(request: Option<Value>) -> Value {
    tokio::task::spawn_blocking(move || attachments_cmd::restore_thread_checkpoint(request))
        .await
        .unwrap_or(Value::Null)
}

#[tauri::command]
pub async fn release_chat_attachment(request: Option<Value>) -> Value {
    tokio::task::spawn_blocking(move || attachments_cmd::release_chat_attachment(request))
        .await
        .unwrap_or(Value::Null)
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
