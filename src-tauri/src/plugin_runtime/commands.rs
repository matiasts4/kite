//! Tauri IPC commands for Kite Code's extensible plugin runtime.

use crate::persist::{body, workspace_path};
use crate::plugin_runtime::registry::load_runtime_settings;
use crate::plugin_runtime::types::{
    PluginRecordDto, PluginRuntimeSettings, SidecarStatusSnapshot,
};
use serde_json::Value;
use std::path::{Path, PathBuf};

fn resolve_workspace_from_req(req: Option<&Value>) -> Option<PathBuf> {
    let req = req?;
    if let Some(ws_path) = req
        .get("workspacePath")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let p = PathBuf::from(ws_path);
        if p.is_dir() {
            return Some(p);
        }
    }
    if let Some(ws_id) = req
        .get("workspaceId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if let Some(resolved) = workspace_path(ws_id) {
            let p = PathBuf::from(resolved);
            if p.is_dir() {
                return Some(p);
            }
        }
    }
    None
}

fn required_str_field<'a>(req: &'a Value, keys: &[&str], label: &str) -> Result<&'a str, String> {
    for key in keys {
        if let Some(val) = req.get(*key).and_then(Value::as_str) {
            let trimmed = val.trim();
            if !trimmed.is_empty() {
                return Ok(trimmed);
            }
        }
    }
    Err(format!("Missing required field '{label}'."))
}

#[tauri::command]
pub async fn plugin_runtime_list(request: Option<Value>) -> Result<Vec<PluginRecordDto>, String> {
    let req = body(&request).cloned();
    tauri::async_runtime::spawn_blocking(move || {
        let ws = resolve_workspace_from_req(req.as_ref());
        let refresh = req
            .as_ref()
            .and_then(|r| r.get("refresh").and_then(Value::as_bool))
            .unwrap_or(false);
        Ok(crate::plugin_runtime::plugin_records_for(
            ws.as_deref(),
            refresh,
        ))
    })
    .await
    .map_err(|e| format!("plugin_runtime_list task failed: {e}"))?
}

#[tauri::command]
pub async fn plugin_runtime_refresh(request: Option<Value>) -> Result<Vec<PluginRecordDto>, String> {
    let req = body(&request).cloned();
    tauri::async_runtime::spawn_blocking(move || {
        let ws = resolve_workspace_from_req(req.as_ref());
        Ok(crate::plugin_runtime::plugin_records_for(
            ws.as_deref(),
            true,
        ))
    })
    .await
    .map_err(|e| format!("plugin_runtime_refresh task failed: {e}"))?
}

#[tauri::command]
pub async fn plugin_runtime_get_settings() -> Result<PluginRuntimeSettings, String> {
    tauri::async_runtime::spawn_blocking(load_runtime_settings)
        .await
        .map_err(|e| format!("plugin_runtime_get_settings task failed: {e}"))
}

#[tauri::command]
pub async fn plugin_runtime_save_settings(
    request: Option<Value>,
) -> Result<PluginRuntimeSettings, String> {
    let req = body(&request)
        .cloned()
        .ok_or_else(|| "Missing plugin runtime settings payload.".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let ws = resolve_workspace_from_req(Some(&req));
        let settings_val = req.get("settings").cloned().unwrap_or(req);
        let parsed: PluginRuntimeSettings = serde_json::from_value(settings_val)
            .map_err(|e| format!("Invalid plugin runtime settings: {e}"))?;
        crate::plugin_runtime::save_settings_and_sync(parsed, ws.as_deref())
    })
    .await
    .map_err(|e| format!("plugin_runtime_save_settings task failed: {e}"))?
}

#[tauri::command]
pub async fn plugin_runtime_set_enabled(
    request: Option<Value>,
) -> Result<Vec<PluginRecordDto>, String> {
    let req = body(&request)
        .cloned()
        .ok_or_else(|| "Missing plugin toggle payload.".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let dir_id = required_str_field(&req, &["dirId", "dir_id", "id"], "dirId")?;
        let enabled = req
            .get("enabled")
            .and_then(Value::as_bool)
            .ok_or_else(|| "Missing required boolean 'enabled'.".to_string())?;
        let ws = resolve_workspace_from_req(Some(&req));
        crate::plugin_runtime::set_plugin_enabled_and_sync(dir_id, enabled, ws.as_deref())
    })
    .await
    .map_err(|e| format!("plugin_runtime_set_enabled task failed: {e}"))?
}

#[tauri::command]
pub async fn plugin_runtime_install_folder(
    request: Option<Value>,
) -> Result<PluginRecordDto, String> {
    let req = body(&request)
        .cloned()
        .ok_or_else(|| "Missing folder install payload.".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let path_str = required_str_field(&req, &["path", "folderPath"], "path")?;
        let ws = resolve_workspace_from_req(Some(&req));
        crate::plugin_runtime::install_folder_and_sync(Path::new(path_str), ws.as_deref())
    })
    .await
    .map_err(|e| format!("plugin_runtime_install_folder task failed: {e}"))?
}

#[tauri::command]
pub async fn plugin_runtime_install_git(
    request: Option<Value>,
) -> Result<PluginRecordDto, String> {
    let req = body(&request)
        .cloned()
        .ok_or_else(|| "Missing Git install payload.".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let repo_url = required_str_field(&req, &["repoUrl", "url"], "repoUrl")?.to_string();
        let git_ref = req
            .get("gitRef")
            .or_else(|| req.get("ref"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let subdir = req
            .get("subdir")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let ws = resolve_workspace_from_req(Some(&req));
        crate::plugin_runtime::install_git_and_sync(
            &repo_url,
            git_ref.as_deref(),
            subdir.as_deref(),
            ws.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("plugin_runtime_install_git task failed: {e}"))?
}

#[tauri::command]
pub async fn plugin_runtime_install_archive(
    request: Option<Value>,
) -> Result<PluginRecordDto, String> {
    let req = body(&request)
        .cloned()
        .ok_or_else(|| "Missing archive install payload.".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let path_str = required_str_field(&req, &["path", "archivePath"], "path")?;
        let ws = resolve_workspace_from_req(Some(&req));
        crate::plugin_runtime::install_archive_and_sync(Path::new(path_str), ws.as_deref())
    })
    .await
    .map_err(|e| format!("plugin_runtime_install_archive task failed: {e}"))?
}

#[tauri::command]
pub async fn plugin_runtime_uninstall(request: Option<Value>) -> Result<(), String> {
    let req = body(&request)
        .cloned()
        .ok_or_else(|| "Missing uninstall payload.".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let dir_id = required_str_field(&req, &["dirId", "dir_id", "id"], "dirId")?;
        let ws = resolve_workspace_from_req(Some(&req));
        crate::plugin_runtime::uninstall_plugin_and_sync(dir_id, ws.as_deref())
    })
    .await
    .map_err(|e| format!("plugin_runtime_uninstall task failed: {e}"))?
}

#[tauri::command]
pub async fn plugin_runtime_pick_folder(
    app: tauri::AppHandle,
    request: Option<Value>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let mode = body(&request)
        .and_then(|r| r.get("mode").and_then(Value::as_str))
        .unwrap_or("folder")
        .to_string();

    let picked = tokio::task::spawn_blocking(move || {
        if mode == "archive" {
            app.dialog()
                .file()
                .set_title("Choose a plugin archive (.zip)")
                .add_filter("ZIP archive", &["zip"])
                .blocking_pick_file()
        } else {
            app.dialog()
                .file()
                .set_title("Choose a plugin folder")
                .blocking_pick_folder()
        }
    })
    .await
    .map_err(|e| format!("plugin_runtime_pick_folder task failed: {e}"))?;

    let Some(file_path) = picked else {
        return Ok(None);
    };
    let path = file_path
        .into_path()
        .map_err(|e| format!("Invalid selected path: {e}"))?;
    Ok(Some(path.to_string_lossy().to_string()))
}

#[tauri::command]
pub async fn plugin_runtime_sidecar_action(
    request: Option<Value>,
) -> Result<SidecarStatusSnapshot, String> {
    let req = body(&request)
        .cloned()
        .ok_or_else(|| "Missing sidecar action payload.".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let namespaced_id =
            required_str_field(&req, &["namespacedId", "sidecarId", "id"], "namespacedId")?;
        let action = required_str_field(&req, &["action"], "action")?;
        let view_path = req
            .get("viewPath")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let ws = resolve_workspace_from_req(Some(&req));
        crate::plugin_runtime::sidecar_action(namespaced_id, action, view_path, ws.as_deref())
    })
    .await
    .map_err(|e| format!("plugin_runtime_sidecar_action task failed: {e}"))?
}

#[tauri::command]
pub async fn plugin_runtime_sidecar_logs(request: Option<Value>) -> Result<Vec<String>, String> {
    let req = body(&request)
        .cloned()
        .ok_or_else(|| "Missing sidecar logs payload.".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let namespaced_id =
            required_str_field(&req, &["namespacedId", "sidecarId", "id"], "namespacedId")?;
        let tail = req
            .get("tailLines")
            .and_then(Value::as_u64)
            .unwrap_or(200) as usize;
        Ok(crate::plugin_runtime::sidecar_logs(namespaced_id, tail))
    })
    .await
    .map_err(|e| format!("plugin_runtime_sidecar_logs task failed: {e}"))?
}

#[tauri::command]
pub async fn plugin_runtime_list_sidecars(
    request: Option<Value>,
) -> Result<Vec<SidecarStatusSnapshot>, String> {
    let req = body(&request).cloned();
    tauri::async_runtime::spawn_blocking(move || {
        let ws = resolve_workspace_from_req(req.as_ref());
        Ok(crate::plugin_runtime::list_ui_sidecars(ws.as_deref()))
    })
    .await
    .map_err(|e| format!("plugin_runtime_list_sidecars task failed: {e}"))?
}
