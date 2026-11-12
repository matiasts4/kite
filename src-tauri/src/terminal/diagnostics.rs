use crate::logger::log_trace;
use crate::terminal::{get_terminals, now_unix_ms, should_proxy_to_core_daemon, to_base64};

pub fn log_dec2026_timeouts(session_id: &str, notes: Vec<crate::vt_engine::Dec2026TimeoutNotice>) {
    for note in notes {
        log_trace(&format!(
            "WARN dec2026_timeout: session_id={session_id}, held_ms={}, seq={}",
            note.held_ms, note.seq
        ));
    }
}

pub fn terminal_log_dir() -> std::path::PathBuf {
    let base = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| r"C:\Users\PC\AppData\Local".into());
    let folder = if cfg!(debug_assertions) {
        "Kite Code Dev"
    } else {
        "Kite Code"
    };
    let dir = std::path::PathBuf::from(base).join(folder);
    let _ = std::fs::create_dir_all(&dir);
    dir
}

pub async fn find_terminal_text(request: serde_json::Value) -> Result<serde_json::Value, String> {
    find_terminal_text_sync(request)
}

pub fn find_terminal_text_sync(request: serde_json::Value) -> Result<serde_json::Value, String> {
    let req = request.get("request").unwrap_or(&request);
    let session_id = req.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
    if should_proxy_to_core_daemon(session_id) {
        if let Ok(res) =
            crate::core_daemon::send_core_daemon_rpc("session.find_text", Some(req.clone()))
        {
            return Ok(res);
        }
    }
    find_terminal_text_local_sync(request)
}

pub fn find_terminal_text_local_sync(
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let req = request.get("request").unwrap_or(&request);
    let session_id = req.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
    let query = req.get("query").and_then(|v| v.as_str()).unwrap_or("");
    let limit = req.get("limit").and_then(|v| v.as_u64()).unwrap_or(40) as usize;
    if session_id.is_empty() {
        return Err("Session not found".to_string());
    }
    let inst = {
        let manager = get_terminals().lock().map_err(|e| e.to_string())?;
        manager
            .get(session_id)
            .cloned()
            .ok_or_else(|| "Session not found".to_string())?
    };
    let vt = inst.vt_engine.lock().map_err(|e| e.to_string())?;
    let hits = vt.find_text(query, limit);
    Ok(serde_json::json!({ "hits": hits }))
}

pub async fn get_terminal_selection_text(
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    get_terminal_selection_text_sync(request)
}

pub fn get_terminal_selection_text_sync(
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let req = request.get("request").unwrap_or(&request);
    let session_id = req.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
    if should_proxy_to_core_daemon(session_id) {
        if let Ok(res) = crate::core_daemon::send_core_daemon_rpc(
            "session.get_selection_text",
            Some(req.clone()),
        ) {
            return Ok(res);
        }
    }
    get_terminal_selection_text_local_sync(request)
}

pub fn get_terminal_selection_text_local_sync(
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let req = request.get("request").unwrap_or(&request);
    let session_id = req.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
    let start_row = req.get("startRow").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
    let start_col = req
        .get("startCol")
        .and_then(|v| v.as_u64())
        .unwrap_or(0)
        .min(u16::MAX as u64) as u16;
    let end_row = req.get("endRow").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
    let end_col = req
        .get("endCol")
        .and_then(|v| v.as_u64())
        .unwrap_or(0)
        .min(u16::MAX as u64) as u16;
    if session_id.is_empty() {
        return Err("Session not found".to_string());
    }
    let inst = {
        let manager = get_terminals().lock().map_err(|e| e.to_string())?;
        manager
            .get(session_id)
            .cloned()
            .ok_or_else(|| "Session not found".to_string())?
    };
    let vt = inst.vt_engine.lock().map_err(|e| e.to_string())?;
    let text = vt.selection_text(start_row, start_col, end_row, end_col);
    Ok(serde_json::json!({ "text": text }))
}

pub async fn dump_terminal_diagnostics(request: serde_json::Value) -> Result<String, String> {
    let req = request.get("request").unwrap_or(&request);
    let session_id = req
        .get("sessionId")
        .or_else(|| req.get("session_id"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if should_proxy_to_core_daemon(session_id) {
        if let Ok(res) =
            crate::core_daemon::send_core_daemon_rpc("session.dump_diagnostics", Some(req.clone()))
        {
            if let Some(path) = res.get("path").and_then(|v| v.as_str()) {
                return Ok(path.to_string());
            }
        }
    }
    dump_terminal_diagnostics_local_sync(request)
}

pub fn dump_terminal_diagnostics_local_sync(request: serde_json::Value) -> Result<String, String> {
    let req = request.get("request").unwrap_or(&request);
    let session_id = req
        .get("sessionId")
        .or_else(|| req.get("session_id"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if session_id.is_empty() {
        return Err("Session not found".to_string());
    }
    let inst = {
        let manager = get_terminals().lock().map_err(|e| e.to_string())?;
        manager
            .get(&session_id)
            .cloned()
            .ok_or_else(|| "Session not found".to_string())?
    };
    let mut report = {
        let vt = inst.vt_engine.lock().map_err(|e| e.to_string())?;
        vt.diagnostic_report()
    };
    let scrollback_b64 = {
        let bytes = inst.scrollback.lock().map_err(|e| e.to_string())?;
        let start = bytes.len().saturating_sub(16 * 1024);
        to_base64(&bytes[start..])
    };
    if let Some(obj) = report.as_object_mut() {
        obj.insert("sessionId".to_string(), serde_json::Value::String(session_id.clone()));
        obj.insert(
            "scrollbackBase64".to_string(),
            serde_json::Value::String(scrollback_b64),
        );
    }
    let safe_id: String = session_id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect();
    let stamp = now_unix_ms();
    let path = terminal_log_dir().join(format!("terminal-diag-{safe_id}-{stamp}.json"));
    let body = serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| e.to_string())?;
    let path_str = path.to_string_lossy().to_string();
    log_trace(&format!(
        "dump_terminal_diagnostics: session_id={session_id}, path={path_str}"
    ));
    Ok(path_str)
}

pub async fn clear_terminal_vt(request: serde_json::Value) -> serde_json::Value {
    clear_terminal_vt_sync(request)
}

pub fn clear_terminal_vt_sync(request: serde_json::Value) -> serde_json::Value {
    let req = request.get("request").unwrap_or(&request);
    let session_id = req.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
    if should_proxy_to_core_daemon(session_id) {
        if let Ok(res) =
            crate::core_daemon::send_core_daemon_rpc("session.clear_vt", Some(req.clone()))
        {
            return res;
        }
    }
    clear_terminal_vt_local_sync(request)
}

pub fn clear_terminal_vt_local_sync(request: serde_json::Value) -> serde_json::Value {
    let req = request.get("request").unwrap_or(&request);
    let session_id = req.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");

    let instance = {
        let map = get_terminals().lock().unwrap();
        map.get(session_id).cloned()
    };

    if let Some(inst) = instance {
        if let Ok(mut vt) = inst.vt_engine.lock() {
            vt.clear();
        }
    }
    serde_json::Value::Null
}

pub fn report_terminal_agent_detected(request: serde_json::Value) -> serde_json::Value {
    let req = request.get("request").unwrap_or(&request);
    let session_id = req.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
    if should_proxy_to_core_daemon(session_id) {
        if let Ok(res) = crate::core_daemon::send_core_daemon_rpc(
            "session.report_agent_detected",
            Some(req.clone()),
        ) {
            return res;
        }
    }
    report_terminal_agent_detected_local(request)
}

pub fn report_terminal_agent_detected_local(request: serde_json::Value) -> serde_json::Value {
    let req = request.get("request").unwrap_or(&request);
    let session_id = req.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
    let engine = req.get("engine").and_then(|v| v.as_str()).unwrap_or("");
    if session_id.is_empty() || engine.is_empty() || crate::session_resolver::is_generic_shell_engine(engine) {
        return serde_json::Value::Null;
    }

    let canonical = crate::session_resolver::canonical_agent_engine(engine);
    let instance = {
        let map = get_terminals().lock().unwrap();
        map.get(session_id).cloned()
    };
    if let Some(inst) = instance {
        // If this terminal instance is a generic shell (e.g. powershell, cmd, bash, terminal),
        // we must not blindly trust stdout text scraping unless an actual child agent process
        // is running under this shell.
        if crate::session_resolver::is_generic_shell_engine(&inst.engine) {
            let root_pid = inst.child.lock().ok().and_then(|c| c.process_id());
            let has_child_agent = root_pid.and_then(crate::session_resolver::detect_child_agent_in_shell);
            if has_child_agent.as_deref() != Some(canonical.as_str()) && has_child_agent.is_none() {
                // No actual agent process exists in the process tree of this generic shell.
                // Do not mark it as an agent engine.
                return serde_json::Value::Null;
            }
        }

        inst.had_user_activity.store(true, std::sync::atomic::Ordering::Relaxed);
        if let Ok(mut det) = inst.detected_agent_engine.lock() {
            *det = Some(canonical);
        }
        let _ = crate::terminal::try_bind_provider_session_id(session_id, &inst);
    }
    serde_json::Value::Null
}
