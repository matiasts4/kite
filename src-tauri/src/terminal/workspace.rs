use crate::logger::log_trace;
use crate::persist::workspace_path;
use crate::session_resolver::remove_persisted_terminal_session;
use crate::terminal::{
    delete_scrollback_file, get_terminals, should_proxy_to_core_daemon,
    spawn_session_with_size, write_terminal_sync,
};
use std::io::Write;
use std::sync::atomic::Ordering;
use uuid::Uuid;

pub fn launch_workspace_terminals(request: serde_json::Value) -> serde_json::Value {
    log_trace(&format!("Invoked launch_workspace_terminals: {:?}", request));
    let req = request.get("request").unwrap_or(&request);
    let request_id = req.get("requestId").cloned().unwrap_or_else(|| {
        serde_json::Value::String(Uuid::new_v4().to_string())
    });

    let count = req
        .get("count")
        .and_then(|v| v.as_u64())
        .unwrap_or_else(|| {
            req.get("seats")
                .and_then(|s| s.as_array())
                .map(|a| a.len() as u64)
                .unwrap_or(1)
        })
        .clamp(1, 6) as usize;

    let default_engine = req
        .get("engine")
        .and_then(|e| e.as_str())
        .unwrap_or("terminal");

    let seats = req.get("seats").and_then(|s| s.as_array());
    // Do not spawn here. The pane does not exist yet, so the only size we
    // could pass is 80×24. The view attaches after the host settles and
    // `attach_terminal` spawns at that grid. Spawning early let the CLI paint
    // into a buffer the view then drained and dropped, which left a blank
    // cursor on an otherwise running session.

    static CODENAME_COUNTER: std::sync::atomic::AtomicUsize =
        std::sync::atomic::AtomicUsize::new(0);

    const AGENT_CODENAMES: &[&str] = &[
        "Orion", "Nova", "Atlas", "Vega", "Titan", "Echo", "Phoenix", "Lyra", "Apex", "Zenith",
        "Cygnus", "Helios", "Falcon", "Sirius", "Altair", "Polaris", "Castor", "Pollux", "Astra",
        "Cosmo", "Vortex", "Nebula", "Specter", "Sol", "Aura", "Quantum", "Nexus", "Pulse",
        "Ranger", "Draco",
    ];

    let mut slots = Vec::new();
    for i in 0..count {
        let session_id = Uuid::new_v4().to_string();
        let pane_id = Uuid::new_v4().to_string();

        let engine = seats
            .and_then(|s| s.get(i))
            .and_then(|seat| seat.get("engine"))
            .and_then(|e| e.as_str())
            .unwrap_or(default_engine);

        let is_plain_shell = matches!(engine, "powershell" | "terminal" | "cmd" | "bash" | "zsh");

        let provided_agent_name = seats
            .and_then(|s| s.get(i))
            .and_then(|seat| seat.get("agentName"))
            .and_then(|a| a.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty());

        let codename = if is_plain_shell {
            "Terminal".to_string()
        } else if let Some(custom) = provided_agent_name {
            custom.to_string()
        } else {
            let next_idx = CODENAME_COUNTER.fetch_add(1, Ordering::SeqCst);
            AGENT_CODENAMES[next_idx % AGENT_CODENAMES.len()].to_string()
        };

        let work_title = codename.clone();

        let seat_label = seats
            .and_then(|s| s.get(i))
            .and_then(|seat| seat.get("label"))
            .and_then(|l| l.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty() && *s != "Terminal" && *s != engine)
            .map(|s| s.to_string())
            .unwrap_or_else(|| work_title.clone());

        slots.push(serde_json::json!({
            "index": i,
            "sessionId": session_id,
            "paneId": pane_id,
            "engine": engine,
            "displayName": seat_label,
            "agentName": if is_plain_shell { serde_json::Value::Null } else { serde_json::Value::String(codename) },
            "roleLabel": serde_json::Value::Null,
            "workTitle": work_title
        }));
    }

    serde_json::json!({
        "requestId": request_id,
        "attachedToExisting": false,
        "slots": slots
    })
}

pub fn list_terminal_profiles() -> serde_json::Value {
    serde_json::json!({
        "schemaVersion": 1,
        "profiles": [
            { "kind": "default" },
            { "kind": "powerShell" },
            { "kind": "commandPrompt" }
        ]
    })
}

pub fn request_body(request: &serde_json::Value) -> &serde_json::Value {
    request.get("request").unwrap_or(request)
}

pub fn option_body(request: &Option<serde_json::Value>) -> Option<&serde_json::Value> {
    request.as_ref().map(request_body)
}

fn owner_workspace_id(owner: &serde_json::Value) -> Option<&str> {
    let kind = owner.get("kind").and_then(|value| value.as_str())?;
    if kind == "workspace" || kind == "workspaceLaunch" {
        owner
            .get("workspaceId")
            .and_then(|value| value.as_str())
            .filter(|id| !id.is_empty())
    } else {
        None
    }
}

fn owner_agent_id(owner: &serde_json::Value) -> Option<&str> {
    let kind = owner.get("kind").and_then(|value| value.as_str())?;
    if kind == "agent" || kind == "agentLaunch" {
        owner
            .get("agentId")
            .and_then(|value| value.as_str())
            .filter(|id| !id.is_empty())
    } else {
        None
    }
}

pub fn extract_workspace_id(req: &serde_json::Value) -> Option<String> {
    req.get("workspaceId")
        .and_then(|value| value.as_str())
        .filter(|id| !id.is_empty())
        .or_else(|| req.get("owner").and_then(owner_workspace_id))
        .map(str::to_string)
}

pub fn extract_pane_id(req: &serde_json::Value) -> Option<String> {
    req.get("paneId")
        .and_then(|value| value.as_str())
        .filter(|id| !id.is_empty())
        .or_else(|| {
            req.get("owner")
                .and_then(|o| o.get("paneId"))
                .and_then(|v| v.as_str())
                .filter(|id| !id.is_empty())
        })
        .map(str::to_string)
}

pub fn workspace_cwd(req: &serde_json::Value) -> String {
    if let Some(cwd) = req
        .get("cwd")
        .and_then(|value| value.as_str())
        .filter(|path| std::path::Path::new(path).is_dir())
    {
        return cwd.to_string();
    }
    let workspace_id = req
        .get("workspaceId")
        .and_then(|value| value.as_str())
        .filter(|id| !id.is_empty())
        .or_else(|| req.get("owner").and_then(owner_workspace_id));
    if let Some(path) = workspace_id
        .and_then(workspace_path)
        .filter(|path| std::path::Path::new(path).is_dir())
    {
        return path;
    }

    let agent_id = req
        .get("agentId")
        .and_then(|value| value.as_str())
        .filter(|id| !id.is_empty())
        .or_else(|| req.get("owner").and_then(owner_agent_id));
    if let Some(aid) = agent_id {
        let home = crate::agent_mind::get_agent_home_dir(aid);
        let _ = std::fs::create_dir_all(&home);
        let _ = crate::agent_mind::sync_agent_instructions(
            home.parent().unwrap_or(std::path::Path::new(".")),
            aid,
        );
        return home.to_string_lossy().into_owned();
    }

    std::env::current_dir()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|_| ".".into())
}

pub fn write_session(session_id: &str, text: &str) -> bool {
    if session_id.is_empty() || text.is_empty() {
        return false;
    }
    if should_proxy_to_core_daemon(session_id) {
        let res = write_terminal_sync(serde_json::json!({
            "sessionId": session_id,
            "input": text,
        }));
        return res.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    }
    let instance = {
        let map = get_terminals().lock().unwrap();
        map.get(session_id).cloned()
    };
    let Some(instance) = instance else {
        return false;
    };
    instance.had_user_activity.store(true, Ordering::Relaxed);
    if let Ok(mut writer) = instance.writer.lock() {
        let _ = writer.write_all(text.as_bytes());
        let _ = writer.flush();
        return true;
    }
    false
}

pub fn remove_session(session_id: &str) -> Option<(String, String)> {
    if session_id.is_empty() {
        return None;
    }
    let instance = {
        let mut map = get_terminals().lock().unwrap();
        map.remove(session_id)
    }?;
    let live_dir = instance
        .live_cwd
        .lock()
        .ok()
        .map(|c| c.clone())
        .filter(|c| !c.is_empty())
        .unwrap_or_else(|| instance.cwd.clone());
    let home = (live_dir, instance.engine.clone());
    if let Ok(mut child) = instance.child.lock() {
        let _ = child.kill();
    }
    delete_scrollback_file(session_id);
    remove_persisted_terminal_session(session_id);
    Some(home)
}

pub fn restart_agent_terminal_for_autopilot(request: serde_json::Value) -> serde_json::Value {
    let req = request_body(&request);
    let old_id = req
        .get("oldSessionId")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    if should_proxy_to_core_daemon(old_id) {
        if let Ok(res) = crate::core_daemon::send_core_daemon_rpc(
            "session.restart_autopilot",
            Some(req.clone()),
        ) {
            return res;
        }
    }
    restart_agent_terminal_for_autopilot_local_sync(request)
}

pub fn restart_agent_terminal_for_autopilot_local_sync(
    request: serde_json::Value,
) -> serde_json::Value {
    let req = request_body(&request);
    let old_id = req
        .get("oldSessionId")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let new_id = req
        .get("newSessionId")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let prompt = req
        .get("prompt")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let cols = req
        .get("columns")
        .and_then(|value| value.as_u64())
        .unwrap_or(80)
        .clamp(2, 512) as u16;
    let rows = req
        .get("rows")
        .and_then(|value| value.as_u64())
        .unwrap_or(24)
        .clamp(1, 256) as u16;
    let previous = remove_session(old_id);
    let (cwd, engine) = previous.unwrap_or_else(|| (workspace_cwd(req), "powershell".to_string()));
    if !new_id.is_empty() && new_id != old_id {
        remove_session(new_id);
        spawn_session_with_size(new_id, &cwd, &engine, cols, rows);
        let prompt = prompt.trim();
        if !prompt.is_empty() {
            let _ = write_session(new_id, &format!("{prompt}\r\n"));
        }
    }
    serde_json::json!({
        "sessionId": new_id,
        "attachedToExisting": false,
        "host": { "backend": "conpty", "buildNumber": 22631 },
        "restore": { "kind": "startedFresh", "reason": "noConversation" }
    })
}

