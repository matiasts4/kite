//! Workspace file bodies. A path that escapes the workspace is rejected and nothing is sent.

use std::fs;
use std::path::{Component, Path, PathBuf};

use super::types::{BODY_LIMIT, DispatchError};

pub fn resolve_workspace_file(workspace: &Path, user_path: &str) -> Result<PathBuf, DispatchError> {
    let user_path = user_path.trim();
    if user_path.is_empty() || user_path.contains('\0') {
        return Err(DispatchError::PathRejected);
    }
    let raw = Path::new(user_path);
    if raw.is_absolute() {
        return Err(DispatchError::PathRejected);
    }
    for component in raw.components() {
        match component {
            Component::Normal(_) | Component::CurDir => {}
            _ => return Err(DispatchError::PathRejected),
        }
    }
    let workspace = workspace.canonicalize().map_err(|_| DispatchError::PathRejected)?;
    let joined = workspace.join(raw);
    let parent = joined.parent().ok_or(DispatchError::PathRejected)?;
    let parent = parent.canonicalize().map_err(|_| DispatchError::PathRejected)?;
    if !parent.starts_with(&workspace) {
        return Err(DispatchError::PathRejected);
    }
    let name = joined.file_name().ok_or(DispatchError::PathRejected)?;
    let full = parent.join(name);
    if !full.starts_with(&workspace) {
        return Err(DispatchError::PathRejected);
    }
    Ok(full)
}

pub fn read_workspace_file(workspace: &Path, user_path: &str) -> Result<String, DispatchError> {
    let path = resolve_workspace_file(workspace, user_path)?;
    let text = fs::read_to_string(&path).map_err(|_| DispatchError::PathRejected)?;
    if text.chars().count() > BODY_LIMIT {
        return Err(DispatchError::BodyTooLarge);
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_parent_escape_and_reads_a_file_inside() {
        let root = std::env::temp_dir().join(format!("kite-dispatch-path-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("inside")).unwrap();
        fs::write(root.join("inside").join("task.md"), "hello task").unwrap();
        let ws = root.canonicalize().unwrap();

        let ok = read_workspace_file(&ws, "inside/task.md").unwrap();
        assert_eq!(ok, "hello task");
        assert!(matches!(
            resolve_workspace_file(&ws, "../secret"),
            Err(DispatchError::PathRejected)
        ));
        assert!(matches!(
            resolve_workspace_file(&ws, "inside/../../secret"),
            Err(DispatchError::PathRejected)
        ));
        let _ = fs::remove_dir_all(&root);
    }
}
