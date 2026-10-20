// Kite Code — Agent inbox on disk (.kite/inbox) for PTY-local handoff commands

use serde_json::{json, Value};
use std::fs;
use std::path::{Component, Path, PathBuf};

fn inbox_dir(cwd: &str) -> PathBuf {
    PathBuf::from(cwd).join(".kite").join("inbox")
}

fn ensure_inbox(cwd: &str) -> PathBuf {
    let dir = inbox_dir(cwd);
    let _ = fs::create_dir_all(&dir);
    dir
}

/// Reject paths that escape cwd (parent segments or absolute outside cwd).
pub fn validate_relative_path_under_cwd(cwd: &str, rel_path: &str) -> Result<PathBuf, String> {
    let trimmed = rel_path.trim();
    if trimmed.is_empty() {
        return Err("La ruta está vacía.".into());
    }

    let cwd_path = PathBuf::from(cwd);
    let cwd_canon = cwd_path
        .canonicalize()
        .unwrap_or_else(|_| cwd_path.clone());

    let candidate = if Path::new(trimmed).is_absolute() {
        PathBuf::from(trimmed)
    } else {
        cwd_path.join(trimmed)
    };

    for component in Path::new(trimmed).components() {
        if matches!(component, Component::ParentDir) {
            return Err("La ruta no puede contener ..".into());
        }
    }

    let resolved = candidate
        .canonicalize()
        .map_err(|e| format!("Ruta de tarea inválida: {e}"))?;

    if !resolved.starts_with(&cwd_canon) {
        return Err("La ruta está fuera del cwd del workspace.".into());
    }

    Ok(resolved)
}

#[tauri::command]
pub fn read_cwd_relative_text(request: Value) -> Value {
    let req = request.get("request").unwrap_or(&request);
    let cwd = req
        .get("cwd")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let path = req
        .get("path")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();

    if cwd.is_empty() {
        return json!({ "ok": false, "error": "Falta cwd." });
    }
    if path.is_empty() {
        return json!({ "ok": false, "error": "Falta path." });
    }

    match validate_relative_path_under_cwd(cwd, path) {
        Ok(full) => match fs::read_to_string(&full) {
            Ok(text) => json!({ "ok": true, "text": text, "path": full.to_string_lossy() }),
            Err(e) => json!({
                "ok": false,
                "error": format!("No se pudo leer {}: {e}", full.display())
            }),
        },
        Err(msg) => json!({ "ok": false, "error": msg }),
    }
}

#[tauri::command]
pub fn poll_agent_inbox(request: Value) -> Value {
    let req = request.get("request").unwrap_or(&request);
    let cwd = req
        .get("cwd")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();

    if cwd.is_empty() {
        return json!({ "requests": [] });
    }

    let dir = ensure_inbox(cwd);
    let mut requests: Vec<Value> = Vec::new();

    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return json!({ "requests": [] }),
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let file_name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) if n.ends_with(".request.json") => n.to_string(),
            _ => continue,
        };

        let raw = match fs::read_to_string(&path) {
            Ok(s) => s,
            Err(_) => continue,
        };

        let parsed: Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(_) => continue,
        };

        requests.push(parsed);

        if fs::remove_file(&path).is_err() {
            let _ = fs::rename(&path, dir.join(format!("{file_name}.consumed")));
        }
    }

    json!({ "requests": requests })
}

#[tauri::command]
pub fn complete_agent_inbox(request: Value) -> Value {
    let req = request.get("request").unwrap_or(&request);
    let cwd = req
        .get("cwd")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let id = req
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let ok = req.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    let message = req
        .get("message")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let session_id = req.get("sessionId").and_then(|v| v.as_str());
    let agent_name = req.get("agentName").and_then(|v| v.as_str());
    let agents = req.get("agents").cloned();

    if cwd.is_empty() || id.is_empty() {
        return json!({
            "ok": false,
            "error": "Faltan cwd o id para completar el buzón."
        });
    }

    let dir = ensure_inbox(cwd);
    let result_path = dir.join(format!("{id}.result.json"));

    let mut body = json!({
        "id": id,
        "ok": ok,
        "message": message,
    });
    if let Some(s) = session_id {
        body["sessionId"] = json!(s);
    }
    if let Some(a) = agent_name {
        body["agentName"] = json!(a);
    }
    if let Some(list) = agents {
        body["agents"] = list;
    }

    match fs::write(&result_path, serde_json::to_string_pretty(&body).unwrap_or_else(|_| "{}".into())) {
        Ok(()) => json!({ "ok": true, "path": result_path.to_string_lossy() }),
        Err(e) => json!({
            "ok": false,
            "error": format!("No se pudo escribir el resultado: {e}")
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_cwd(prefix: &str) -> (PathBuf, String) {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("kite-agent-inbox-{prefix}-{stamp}"));
        fs::create_dir_all(&dir).unwrap();
        (dir.clone(), dir.to_string_lossy().into_owned())
    }

    #[test]
    fn poll_consumes_valid_request_json() {
        let (_dir, cwd) = temp_cwd("poll");
        let inbox = ensure_inbox(&cwd);
        fs::write(
            inbox.join("abc.request.json"),
            r#"{"id":"abc","op":"agents","cwd":"ignored"}"#,
        )
        .unwrap();

        let res = poll_agent_inbox(json!({ "cwd": cwd }));
        let reqs = res["requests"].as_array().unwrap();
        assert_eq!(reqs.len(), 1);
        assert_eq!(reqs[0]["id"], "abc");
        assert!(!inbox.join("abc.request.json").exists());

        let _ = fs::remove_dir_all(PathBuf::from(&cwd));
    }

    #[test]
    fn poll_skips_invalid_json() {
        let (_dir, cwd) = temp_cwd("badjson");
        let inbox = ensure_inbox(&cwd);
        fs::write(inbox.join("bad.request.json"), "not-json").unwrap();

        let res = poll_agent_inbox(json!({ "cwd": cwd }));
        assert_eq!(res["requests"].as_array().unwrap().len(), 0);
        assert!(inbox.join("bad.request.json").exists());

        let _ = fs::remove_dir_all(PathBuf::from(&cwd));
    }

    #[test]
    fn complete_writes_result_file() {
        let (_dir, cwd) = temp_cwd("complete");
        let res = complete_agent_inbox(json!({
            "cwd": cwd,
            "id": "job-1",
            "ok": true,
            "message": "Listo",
            "sessionId": "sess-1"
        }));
        assert_eq!(res["ok"], true);
        let result_path = inbox_dir(&cwd).join("job-1.result.json");
        assert!(result_path.is_file());
        let text = fs::read_to_string(result_path).unwrap();
        assert!(text.contains("Listo"));

        let _ = fs::remove_dir_all(PathBuf::from(&cwd));
    }

    #[test]
    fn read_rejects_parent_path() {
        let (_dir, cwd) = temp_cwd("path");
        let res = read_cwd_relative_text(json!({
            "cwd": cwd,
            "path": "../outside.md"
        }));
        assert_eq!(res["ok"], false);

        let _ = fs::remove_dir_all(PathBuf::from(&cwd));
    }

    #[test]
    fn read_returns_file_text() {
        let (dir, cwd) = temp_cwd("read");
        let task = dir.join("task.md");
        fs::write(&task, "hola mundo\n").unwrap();

        let res = read_cwd_relative_text(json!({
            "cwd": cwd,
            "path": "task.md"
        }));
        assert_eq!(res["ok"], true);
        assert_eq!(res["text"], "hola mundo\n");

        let _ = fs::remove_dir_all(dir);
    }
}
