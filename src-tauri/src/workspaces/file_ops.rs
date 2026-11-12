//! File and folder reveal / open operations for workspaces and file trees.

use serde_json::Value;
use std::path::{Path, PathBuf};

use crate::persist::workspace_path;

pub fn open_folder(path: &str) -> Result<(), String> {
    let result = {
        #[cfg(windows)]
        {
            std::process::Command::new("explorer").arg(path).spawn()
        }
        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("open").arg(path).spawn()
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            std::process::Command::new("xdg-open").arg(path).spawn()
        }
    };
    result
        .map(|_| ())
        .map_err(|_| "This folder could not be shown.".to_string())
}

pub fn reveal_path_in_file_manager(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Err("This file could not be found.".to_string());
    }
    let result = {
        #[cfg(windows)]
        {
            if path.is_file() {
                std::process::Command::new("explorer")
                    .arg(format!("/select,{}", path.to_string_lossy()))
                    .spawn()
            } else {
                std::process::Command::new("explorer")
                    .arg(path.to_string_lossy().as_ref())
                    .spawn()
            }
        }
        #[cfg(target_os = "macos")]
        {
            if path.is_file() {
                std::process::Command::new("open")
                    .args(["-R", &path.to_string_lossy()])
                    .spawn()
            } else {
                std::process::Command::new("open")
                    .arg(&path.to_string_lossy())
                    .spawn()
            }
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            let target_dir = if path.is_file() {
                path.parent().unwrap_or(path)
            } else {
                path
            };
            std::process::Command::new("xdg-open")
                .arg(target_dir.to_string_lossy().as_ref())
                .spawn()
        }
    };
    result
        .map(|_| ())
        .map_err(|_| "This file could not be shown in file manager.".to_string())
}

pub fn open_path_with_default_app(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Err("This file could not be found.".to_string());
    }
    let result = {
        #[cfg(windows)]
        {
            // Spawn explorer.exe directly to open path with default system handler safely without cmd.exe
            std::process::Command::new("explorer")
                .arg(path.to_string_lossy().as_ref())
                .spawn()
        }
        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("open")
                .arg(path.to_string_lossy().as_ref())
                .spawn()
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            std::process::Command::new("xdg-open")
                .arg(path.to_string_lossy().as_ref())
                .spawn()
        }
    };
    result
        .map(|_| ())
        .map_err(|_| "This file could not be opened with default application.".to_string())
}

#[tauri::command]
pub fn reveal_workspace(request: Option<Value>) -> Result<Value, String> {
    let workspace_id = crate::persist::body(&request)
        .and_then(|req| req.get("workspaceId"))
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let Some(path) = workspace_path(workspace_id) else {
        return Err("This folder could not be shown.".to_string());
    };
    if !Path::new(&path).is_dir() {
        return Err("This folder could not be shown.".to_string());
    }
    open_folder(&path)?;
    Ok(Value::Null)
}

#[tauri::command]
pub fn reveal_file(app: tauri::AppHandle, request: Option<Value>) -> Result<Value, String> {
    use tauri_plugin_opener::OpenerExt;
    let req = crate::persist::body(&request);
    let path_str = req
        .and_then(|r| r.get("path").or_else(|| r.get("filePath")))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let workspace_id = req
        .and_then(|r| r.get("workspaceId"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let relative_path = req
        .and_then(|r| r.get("relativePath").or_else(|| r.get("candidate")))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();

    let target_path: PathBuf = if !path_str.is_empty() && Path::new(path_str).exists() {
        PathBuf::from(path_str)
    } else if !workspace_id.is_empty() {
        let Some(ws_path) = workspace_path(workspace_id) else {
            return Err("Workspace folder could not be found.".to_string());
        };
        let ws_root = PathBuf::from(ws_path);
        let joined = if relative_path.is_empty() {
            ws_root.clone()
        } else {
            let clean_rel = relative_path.trim_start_matches(|c| c == '/' || c == '\\');
            ws_root.join(clean_rel)
        };
        if let (Ok(canon_target), Ok(canon_root)) = (joined.canonicalize(), ws_root.canonicalize()) {
            if !canon_target.starts_with(&canon_root) {
                return Err("Access denied: path is outside the workspace root.".to_string());
            }
        }
        joined
    } else {
        return Err("No valid file path provided to reveal.".to_string());
    };

    if !target_path.exists() {
        return Err("The file or folder does not exist on disk.".to_string());
    }

    if app.opener().reveal_item_in_dir(target_path.to_string_lossy().to_string()).is_err() {
        reveal_path_in_file_manager(&target_path)?;
    }

    Ok(Value::Null)
}

#[tauri::command]
pub fn open_file_default(app: tauri::AppHandle, request: Option<Value>) -> Result<Value, String> {
    use tauri_plugin_opener::OpenerExt;
    let req = crate::persist::body(&request);
    let path_str = req
        .and_then(|r| r.get("path").or_else(|| r.get("filePath")))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let workspace_id = req
        .and_then(|r| r.get("workspaceId"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let relative_path = req
        .and_then(|r| r.get("relativePath").or_else(|| r.get("candidate")))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();

    let target_path: PathBuf = if !path_str.is_empty() && Path::new(path_str).exists() {
        PathBuf::from(path_str)
    } else if !workspace_id.is_empty() {
        let Some(ws_path) = workspace_path(workspace_id) else {
            return Err("Workspace folder could not be found.".to_string());
        };
        let ws_root = PathBuf::from(ws_path);
        let joined = if relative_path.is_empty() {
            ws_root.clone()
        } else {
            let clean_rel = relative_path.trim_start_matches(|c| c == '/' || c == '\\');
            ws_root.join(clean_rel)
        };
        if let (Ok(canon_target), Ok(canon_root)) = (joined.canonicalize(), ws_root.canonicalize()) {
            if !canon_target.starts_with(&canon_root) {
                return Err("Access denied: path is outside the workspace root.".to_string());
            }
        }
        joined
    } else {
        return Err("No valid file path provided to open.".to_string());
    };

    if !target_path.exists() {
        return Err("The file or folder does not exist on disk.".to_string());
    }

    if app.opener().open_path(target_path.to_string_lossy().to_string(), None::<&str>).is_err() {
        open_path_with_default_app(&target_path)?;
    }

    Ok(Value::Null)
}
