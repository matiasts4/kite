use crate::chat::{
    apply_launch_choices, archived_at_ms, cancel_turn, configure_thread, create_thread, history, live_turns,
    load_thread, parse_attachments, provider_models_for, provider_ok, read_turn_updates, recover_thread,
    release_staged_attachment, remove_thread, rename_thread, set_agent_model, set_agent_plan, set_pinned,
    stage_blob_attachment, stage_dropped_path, stage_dropped_paths, start_turn_with_binding, touch,
    SendBinding, ThreadEventLog,
};
use crate::persist::{body, load_grid, persist, save_grid, threads};
use serde_json::{json, Value};
use uuid::Uuid;

use super::threads_cmd::request_thread_id;

pub async fn pick_chat_attachments(app: tauri::AppHandle, request: Option<Value>) -> Value {
    let req = body(&request);
    let thread_id = req
        .and_then(|item| item.get("threadId"))
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string();
    let kind = req
        .and_then(|item| item.get("kind"))
        .and_then(|value| value.as_str())
        .unwrap_or("files")
        .to_string();
    if thread_id.is_empty() {
        return json!([]);
    }
    let picked = tokio::task::spawn_blocking(move || pick_attachment_paths(app, &kind))
        .await
        .ok()
        .flatten();
    let Some(paths) = picked else {
        return json!([]);
    };
    let staged = paths
        .iter()
        .take(16)
        .filter_map(|path| stage_dropped_path(&thread_id, path))
        .collect::<Vec<_>>();
    Value::Array(staged)
}

pub(super) fn pick_attachment_paths(app: tauri::AppHandle, kind: &str) -> Option<Vec<std::path::PathBuf>> {
    use tauri_plugin_dialog::DialogExt;
    if kind == "folder" {
        let folder = app.dialog().file().set_title("Add folder").blocking_pick_folder()?;
        Some(vec![folder.into_path().ok()?])
    } else {
        let files = app.dialog().file().set_title("Add files").blocking_pick_files()?;
        let paths = files
            .into_iter()
            .filter_map(|file| file.into_path().ok())
            .take(16)
            .collect::<Vec<_>>();
        if paths.is_empty() {
            None
        } else {
            Some(paths)
        }
    }
}

pub fn stage_chat_blob(request: Option<Value>) -> Value {
    let req = body(&request);
    let thread_id = req.and_then(|item| item.get("threadId")).and_then(|value| value.as_str()).unwrap_or("");
    let display_name = req
        .and_then(|item| item.get("displayName"))
        .and_then(|value| value.as_str())
        .unwrap_or("attachment");
    let data_base64 = req
        .and_then(|item| item.get("dataBase64"))
        .and_then(|value| value.as_str())
        .unwrap_or("");
    stage_blob_attachment(thread_id, display_name, data_base64).unwrap_or(Value::Null)
}

pub fn stage_dropped_chat_attachments(request: Option<Value>) -> Value {
    let req = body(&request);
    let thread_id = req.and_then(|item| item.get("threadId")).and_then(|value| value.as_str()).unwrap_or("");
    let mut paths = Vec::new();
    if let Some(items) = req.and_then(|item| item.get("paths")).and_then(|value| value.as_array()) {
        for item in items.iter().take(16) {
            if let Some(path) = item.as_str() {
                if !path.is_empty() && path.len() <= 4096 {
                    paths.push(std::path::PathBuf::from(path));
                }
            }
        }
    }
    Value::Array(stage_dropped_paths(thread_id, &paths))
}

pub fn rewind_thread_transcript(request: Option<Value>) -> Value {
    let req = body(&request);
    let thread_id = req.and_then(|item| item.get("threadId")).and_then(|value| value.as_str()).unwrap_or("");
    let message_id = req
        .and_then(|item| item.get("messageId"))
        .and_then(|value| value.as_str())
        .unwrap_or("");
    match crate::chat::threads::rewind_thread_transcript(thread_id, message_id) {
        Ok(text) => {
            let thread = threads()
                .lock()
                .unwrap()
                .iter()
                .find(|thread| thread.get("id").and_then(|value| value.as_str()) == Some(thread_id))
                .cloned()
                .unwrap_or(Value::Null);
            json!({ "text": text, "thread": thread, "error": Value::Null })
        }
        Err(error) => json!({ "text": Value::Null, "thread": Value::Null, "error": error }),
    }
}

/// Restores workspace files from the thread's stored checkpoint.
///
/// The folder comes from `workspaceId` via `persist::workspace_path`. A path in
/// the request is ignored. Refusal runs before any git write.
pub fn restore_thread_checkpoint(request: Option<Value>) -> Value {
    let Some(thread_id) = request_thread_id(&request).filter(|id| !id.is_empty()) else {
        return json!({ "restored": false, "error": "threadId is required" });
    };
    let thread = {
        let stored = threads().lock().unwrap();
        stored
            .iter()
            .find(|thread| thread.get("id").and_then(|value| value.as_str()) == Some(thread_id.as_str()))
            .cloned()
    };
    let Some(thread) = thread else {
        return json!({
            "restored": false,
            "error": crate::chat::threads::REWIND_THREAD_MISSING
        });
    };
    if let Some(reason) = crate::chat::checkpoints::file_restore_refusal(&thread) {
        return json!({ "restored": false, "error": reason });
    }
    let Some(worktree) = crate::chat::checkpoints::workspace_dir(&thread) else {
        return json!({ "restored": false, "error": "The workspace folder is unavailable." });
    };
    match crate::chat::checkpoints::restore_workspace_files(&thread, &worktree) {
        Ok(()) => json!({ "restored": true, "error": Value::Null }),
        Err(error) => json!({ "restored": false, "error": error }),
    }
}

pub fn release_chat_attachment(request: Option<Value>) -> Value {
    let req = body(&request);
    let thread_id = req.and_then(|item| item.get("threadId")).and_then(|value| value.as_str()).unwrap_or("");
    let resource_id = req
        .and_then(|item| item.get("resourceId"))
        .and_then(|value| value.as_str())
        .unwrap_or("");
    release_staged_attachment(thread_id, resource_id);
    Value::Null
}
