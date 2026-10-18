use crate::persist::{persist, remember_workspace, workspace_path, workspaces, Workspace};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use uuid::Uuid;

static STORE_LOCK: Mutex<()> = Mutex::new(());

#[cfg(test)]
static TEST_CONFIG_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);

#[tauri::command]
pub async fn add_workspace(app: tauri::AppHandle) -> Value {
    use tauri_plugin_dialog::DialogExt;
    let picked = tokio::task::spawn_blocking(move || {
        app.dialog().file().set_title("Choose a workspace folder").blocking_pick_folder()
    })
    .await
    .ok()
    .flatten();
    let Some(picked) = picked else {
        return Value::Null;
    };
    let folder = match picked.into_path() {
        Ok(path) => path,
        Err(_) => return Value::Null,
    };
    if !folder.is_dir() {
        return Value::Null;
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(1791770226543);
    let name = folder
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("Workspace");
    remember_workspace(
        Workspace {
            id: Uuid::new_v4().to_string(),
            display_name: name.to_string(),
            created_at_unix_ms: now,
            last_opened_at_unix_ms: now,
            pinned: false,
            available: true,
        },
        folder,
    )
}

#[tauri::command]
pub fn copy_workspace_path(request: Option<Value>) -> Result<String, String> {
    let workspace_id = crate::persist::body(&request)
        .and_then(|req| req.get("workspaceId"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    workspace_path(workspace_id).ok_or_else(|| "workspace folder is unavailable".to_string())
}

#[tauri::command]
pub fn rename_workspace(request: Value) -> Vec<Workspace> {
    let req = request.get("request").unwrap_or(&request);
    let workspace_id = req.get("workspaceId").and_then(|v| v.as_str()).unwrap_or("");
    let new_name = req.get("name").and_then(|v| v.as_str()).unwrap_or("");

    let cloned = {
        let mut state = workspaces().lock().unwrap();
        if let Some(w) = state.iter_mut().find(|w| w.id == workspace_id) {
            w.display_name = new_name.to_string();
        }
        state.clone()
    };
    persist();
    cloned
}

#[tauri::command]
pub fn set_workspace_pinned(request: Value) -> Vec<Workspace> {
    let req = request.get("request").unwrap_or(&request);
    let workspace_id = req.get("workspaceId").and_then(|v| v.as_str()).unwrap_or("");
    let pinned = req.get("pinned").and_then(|v| v.as_bool()).unwrap_or(false);

    let cloned = {
        let mut state = workspaces().lock().unwrap();
        if let Some(w) = state.iter_mut().find(|w| w.id == workspace_id) {
            w.pinned = pinned;
        }
        state.clone()
    };
    persist();
    cloned
}

#[tauri::command]
pub fn remove_workspace_from_list(request: Value) -> Vec<Workspace> {
    let req = request.get("request").unwrap_or(&request);
    let workspace_id = req.get("workspaceId").and_then(|v| v.as_str()).unwrap_or("");

    let cloned = {
        let mut state = workspaces().lock().unwrap();
        state.retain(|w| w.id != workspace_id);
        state.clone()
    };
    persist();
    cloned
}

#[tauri::command]
pub fn move_workspace(request: Value) -> Vec<Workspace> {
    let req = request.get("request").unwrap_or(&request);
    let workspace_id = req.get("workspaceId").and_then(|v| v.as_str()).unwrap_or("");
    let to_index = req.get("toIndex").and_then(|v| v.as_u64()).unwrap_or(0) as usize;

    let cloned = {
        let mut state = workspaces().lock().unwrap();
        if let Some(pos) = state.iter().position(|w| w.id == workspace_id) {
            let item = state.remove(pos);
            let insert_idx = to_index.min(state.len());
            state.insert(insert_idx, item);
        }
        state.clone()
    };
    persist();
    cloned
}

fn open_folder(path: &str) -> Result<(), String> {
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

fn config_dir() -> PathBuf {
    #[cfg(test)]
    if let Some(dir) = TEST_CONFIG_DIR.lock().unwrap_or_else(|err| err.into_inner()).clone() {
        return dir;
    }
    crate::persist::state_path()
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn layouts_path() -> PathBuf {
    config_dir().join("layouts.json")
}

fn ssh_workspaces_path() -> PathBuf {
    config_dir().join("ssh-workspaces.json")
}

fn lock_store() -> std::sync::MutexGuard<'static, ()> {
    STORE_LOCK.lock().unwrap_or_else(|err| err.into_inner())
}

enum StoredObject {
    Map(Map<String, Value>),
    Unreadable,
}

fn read_stored_object(path: &Path) -> StoredObject {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return StoredObject::Map(Map::new()),
        Err(_) => return StoredObject::Unreadable,
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(map)) => StoredObject::Map(map),
        _ => StoredObject::Unreadable,
    }
}

fn write_stored_object(path: &Path, map: &Map<String, Value>) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let body = serde_json::to_vec_pretty(map)?;
    std::fs::write(path, body)
}

fn empty_layout(workspace_id: &str) -> Value {
    json!({
        "schemaVersion": 2,
        "workspaceId": workspace_id,
        "tabs": [],
        "activeTabId": null,
        "fullscreenLeafId": null
    })
}

fn layout_response(workspace_id: &str, layout: Option<Value>) -> Value {
    json!({
        "layout": layout.unwrap_or_else(|| empty_layout(workspace_id)),
        "recoveryNotices": [],
        "readOnly": false
    })
}

fn now_unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

fn non_empty_field(value: &Value, key: &str) -> Option<String> {
    let text = value.get(key)?.as_str()?.trim();
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

struct SshEndpoint {
    host: String,
    username: String,
    port: u16,
    folder: String,
}

fn parse_ssh_endpoint(value: &Value) -> Option<SshEndpoint> {
    let host = non_empty_field(value, "host")?;
    let username = non_empty_field(value, "username")?;
    let folder = non_empty_field(value, "folder")?;
    let port = value.get("port")?.as_i64()?;
    if !(1..=65535).contains(&port) {
        return None;
    }
    Some(SshEndpoint {
        host,
        username,
        port: u16::try_from(port).ok()?,
        folder,
    })
}

fn workspace_record(endpoint: &SshEndpoint) -> (String, Value, Value) {
    let now = now_unix_ms();
    let id = Uuid::new_v4().to_string();
    let workspace = Workspace {
        id: id.clone(),
        display_name: format!("{}@{}", endpoint.username, endpoint.host),
        created_at_unix_ms: now,
        last_opened_at_unix_ms: now,
        pinned: false,
        available: false,
    };
    let public_value = serde_json::to_value(&workspace).unwrap_or(Value::Null);
    let mut stored = public_value.clone();
    if let Some(obj) = stored.as_object_mut() {
        obj.insert("host".to_string(), Value::String(endpoint.host.clone()));
        obj.insert("username".to_string(), Value::String(endpoint.username.clone()));
        obj.insert("port".to_string(), json!(endpoint.port));
        obj.insert("folder".to_string(), Value::String(endpoint.folder.clone()));
    }
    (id, public_value, stored)
}

fn public_ssh_workspace(record: &Value) -> Value {
    let mut workspace = record.clone();
    if let Some(obj) = workspace.as_object_mut() {
        obj.remove("host");
        obj.remove("username");
        obj.remove("port");
        obj.remove("folder");
    }
    workspace
}

fn agent_resume_path() -> PathBuf {
    config_dir().join("agent-resume.json")
}

static STARTUP_PROMPT_DISMISSED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

fn normalize_agent_engine(raw: &str) -> Option<&'static str> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "antigravity" | "agy" => Some("antigravity"),
        "claude" | "claude-code" => Some("claude"),
        "codex" => Some("codex"),
        "gemini" => Some("gemini"),
        "opencode" | "open-code" => Some("opencode"),
        "cursor" => Some("cursor"),
        "droid" => Some("droid"),
        "grok" => Some("grok"),
        _ => None,
    }
}

fn extract_occupant_engine(occ: &Map<String, Value>) -> &str {
    occ.get("engine")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            occ.get("runtime")
                .and_then(|r| r.get("engine"))
                .and_then(|v| v.as_str())
                .filter(|s| !s.trim().is_empty())
        })
        .unwrap_or("")
}

fn collect_layout_agent_leaves(node: &Value, out: &mut Vec<(String, String, String, String)>) {
    let Some(obj) = node.as_object() else {
        return;
    };
    let node_type = obj.get("type").and_then(|v| v.as_str()).unwrap_or("");
    if node_type == "leaf" {
        let pane_id = obj.get("id").and_then(|v| v.as_str()).unwrap_or("");
        if let Some(occ) = obj.get("occupant").and_then(|v| v.as_object()) {
            let kind = occ.get("kind").and_then(|v| v.as_str()).unwrap_or("");
            let raw_engine = extract_occupant_engine(occ);
            if kind == "terminal" {
                if let Some(engine) = normalize_agent_engine(raw_engine) {
                    let session_id = occ
                        .get("sessionId")
                        .and_then(|v| v.as_str())
                        .filter(|s| Uuid::parse_str(s).is_ok())
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| Uuid::new_v4().to_string());
                    let title = occ
                        .get("title")
                        .or_else(|| occ.get("label"))
                        .and_then(|v| v.as_str())
                        .map(|s| s.trim())
                        .filter(|s| !s.is_empty())
                        .unwrap_or(engine)
                        .to_string();
                    if Uuid::parse_str(pane_id).is_ok() {
                        out.push((pane_id.to_string(), engine.to_string(), session_id, title));
                    }
                }
            }
        }
    } else if let Some(children) = obj.get("children").and_then(|v| v.as_array()) {
        for child in children {
            collect_layout_agent_leaves(child, out);
        }
    }
}

fn sync_layout_agent_resume_locked(workspace_id: &str, layout: &Value) {
    let Some(tabs) = layout.get("tabs").and_then(|v| v.as_array()) else {
        return;
    };
    let mut leaves = Vec::new();
    for tab in tabs {
        if let Some(root) = tab.get("root") {
            collect_layout_agent_leaves(root, &mut leaves);
        }
    }
    if leaves.is_empty() {
        return;
    }
    let path = agent_resume_path();
    let StoredObject::Map(mut store) = read_stored_object(&path) else {
        return;
    };
    let now = now_unix_ms();
    let panes_val = store
        .entry("panes".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    let Some(panes) = panes_val.as_object_mut() else {
        return;
    };

    for (pane_id, engine, session_id, _title) in leaves {
        let pane_key = format!("{}:{}:{}", workspace_id, pane_id, engine);
        match panes.get_mut(&pane_key).and_then(|v| v.as_object_mut()) {
            Some(entry) => {
                let prev_key = entry
                    .get("activeKey")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let prev_started = entry
                    .get("startedAtUnixMs")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(now);
                if !prev_key.is_empty() && prev_key != session_id {
                    let convs_val = entry
                        .entry("conversations".to_string())
                        .or_insert_with(|| Value::Array(Vec::new()));
                    if let Some(convs) = convs_val.as_array_mut() {
                        convs.retain(|c| c.get("key").and_then(|v| v.as_str()) != Some(&prev_key));
                        convs.insert(
                            0,
                            json!({
                                "key": prev_key,
                                "startedAtUnixMs": prev_started,
                                "archivedAtUnixMs": now
                            }),
                        );
                        convs.truncate(8);
                    }
                    entry.insert("activeKey".to_string(), Value::String(session_id));
                    entry.insert("startedAtUnixMs".to_string(), json!(now));
                }
            }
            None => {
                panes.insert(
                    pane_key,
                    json!({
                        "activeKey": session_id,
                        "startedAtUnixMs": now,
                        "conversations": []
                    }),
                );
            }
        }
    }
    let _ = write_stored_object(&path, &store);
}

#[tauri::command]
pub fn load_workspace_layout(request: Value) -> Value {
    let req = request.get("request").unwrap_or(&request);
    let workspace_id = req.get("workspaceId").and_then(|v| v.as_str()).unwrap_or("");
    let _guard = lock_store();
    let layout = match read_stored_object(&layouts_path()) {
        StoredObject::Map(map) => map.get(workspace_id).cloned().filter(|value| value.is_object()),
        StoredObject::Unreadable => None,
    };
    layout_response(workspace_id, layout)
}

#[tauri::command]
pub fn save_workspace_layout(request: Value) -> Value {
    let req = request.get("request").unwrap_or(&request);
    let layout = req.get("layout").unwrap_or(req);
    let Some(workspace_id) = layout.get("workspaceId").and_then(|v| v.as_str()).filter(|id| !id.is_empty()) else {
        return Value::Null;
    };
    if !layout.is_object() {
        return Value::Null;
    }
    let _guard = lock_store();
    let path = layouts_path();
    let StoredObject::Map(mut map) = read_stored_object(&path) else {
        return Value::Null;
    };
    map.insert(workspace_id.to_string(), layout.clone());
    let _ = write_stored_object(&path, &map);
    sync_layout_agent_resume_locked(workspace_id, layout);
    Value::Null
}

fn rotate_layout_agent_sessions(node: &mut Value) {
    let Some(obj) = node.as_object_mut() else {
        return;
    };
    let node_type = obj.get("type").and_then(|v| v.as_str()).unwrap_or("");
    if node_type == "leaf" {
        if let Some(occ) = obj.get_mut("occupant").and_then(|v| v.as_object_mut()) {
            let kind = occ.get("kind").and_then(|v| v.as_str()).unwrap_or("");
            let raw_engine = extract_occupant_engine(occ).to_string();
            if kind == "terminal" && normalize_agent_engine(&raw_engine).is_some() {
                occ.insert("sessionId".to_string(), Value::String(Uuid::new_v4().to_string()));
            }
        }
    } else if let Some(children) = obj.get_mut("children").and_then(|v| v.as_array_mut()) {
        for child in children {
            rotate_layout_agent_sessions(child);
        }
    }
}

#[tauri::command]
pub fn resume_prompt_get(_request: Option<Value>) -> Value {
    let _guard = lock_store();
    if STARTUP_PROMPT_DISMISSED.load(std::sync::atomic::Ordering::SeqCst) {
        return json!({
            "schemaVersion": 1,
            "status": "quiet",
            "reason": "quit",
            "agents": [],
            "total": 0
        });
    }

    let resume_store = match read_stored_object(&agent_resume_path()) {
        StoredObject::Map(map) => map,
        StoredObject::Unreadable => Map::new(),
    };
    let always_resume = resume_store
        .get("alwaysResume")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    if always_resume {
        return json!({
            "schemaVersion": 1,
            "status": "quiet",
            "reason": "quit",
            "agents": [],
            "total": 0
        });
    }

    let layouts = match read_stored_object(&layouts_path()) {
        StoredObject::Map(map) => map,
        StoredObject::Unreadable => Map::new(),
    };

    let ws_names: std::collections::HashMap<String, String> = {
        let list = workspaces().lock().unwrap();
        list.iter()
            .map(|w| (w.id.clone(), w.display_name.clone()))
            .collect()
    };

    let mut agents = Vec::new();
    for (ws_id, layout) in &layouts {
        let ws_name = ws_names
            .get(ws_id)
            .cloned()
            .unwrap_or_else(|| "Workspace".to_string());
        if let Some(tabs) = layout.get("tabs").and_then(|v| v.as_array()) {
            for tab in tabs {
                if let Some(root) = tab.get("root") {
                    let mut leaves = Vec::new();
                    collect_layout_agent_leaves(root, &mut leaves);
                    for (pane_id, engine, _session_id, title) in leaves {
                        agents.push(json!({
                            "paneId": pane_id,
                            "engine": engine,
                            "title": title,
                            "workspaceName": ws_name
                        }));
                    }
                }
            }
        }
    }

    let total = agents.len();
    agents.truncate(64);
    let status = if total > 0 { "pending" } else { "quiet" };

    json!({
        "schemaVersion": 1,
        "status": status,
        "reason": "quit",
        "agents": agents,
        "total": total
    })
}

#[tauri::command]
pub fn resume_prompt_answer(request: Option<Value>) -> Value {
    let req = crate::persist::body(&request);
    let choice = req
        .and_then(|r| r.get("choice"))
        .and_then(|v| v.as_str())
        .unwrap_or("resumeAll");
    let always_resume_opt = req
        .and_then(|r| r.get("alwaysResume"))
        .and_then(|v| v.as_bool());

    let _guard = lock_store();
    STARTUP_PROMPT_DISMISSED.store(true, std::sync::atomic::Ordering::SeqCst);

    let resume_path = agent_resume_path();
    if let StoredObject::Map(mut store) = read_stored_object(&resume_path) {
        if let Some(always) = always_resume_opt {
            store.insert("alwaysResume".to_string(), json!(always));
        }
        let _ = write_stored_object(&resume_path, &store);
    }

    if choice == "startFresh" {
        let l_path = layouts_path();
        if let StoredObject::Map(mut layouts) = read_stored_object(&l_path) {
            let workspace_ids: Vec<String> = layouts.keys().cloned().collect();
            for ws_id in workspace_ids {
                if let Some(layout) = layouts.get_mut(&ws_id) {
                    if let Some(tabs) = layout.get_mut("tabs").and_then(|v| v.as_array_mut()) {
                        for tab in tabs {
                            if let Some(root) = tab.get_mut("root") {
                                rotate_layout_agent_sessions(root);
                            }
                        }
                    }
                    let cloned = layout.clone();
                    sync_layout_agent_resume_locked(&ws_id, &cloned);
                }
            }
            let _ = write_stored_object(&l_path, &layouts);
        }
    }

    json!({
        "schemaVersion": 1,
        "status": "quiet",
        "reason": "quit",
        "agents": [],
        "total": 0
    })
}

#[tauri::command]
pub fn agent_resume_preferences_get(_request: Option<Value>) -> Value {
    let _guard = lock_store();
    let always_resume = match read_stored_object(&agent_resume_path()) {
        StoredObject::Map(map) => map
            .get("alwaysResume")
            .and_then(|v| v.as_bool())
            .unwrap_or(true),
        StoredObject::Unreadable => true,
    };
    json!({
        "schemaVersion": 1,
        "alwaysResume": always_resume,
        "readOnly": false
    })
}

#[tauri::command]
pub fn agent_resume_preferences_set(request: Option<Value>) -> Value {
    let req = crate::persist::body(&request);
    let always_resume = req
        .and_then(|r| r.get("alwaysResume"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let _guard = lock_store();
    let path = agent_resume_path();
    if let StoredObject::Map(mut store) = read_stored_object(&path) {
        store.insert("alwaysResume".to_string(), json!(always_resume));
        let _ = write_stored_object(&path, &store);
    }
    json!({
        "schemaVersion": 1,
        "alwaysResume": always_resume,
        "readOnly": false
    })
}

#[tauri::command]
pub fn agent_pane_history(request: Option<Value>) -> Value {
    let req = crate::persist::body(&request);
    let workspace_id = req
        .and_then(|r| r.get("workspaceId"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let pane_id = req
        .and_then(|r| r.get("paneId"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let raw_engine = req
        .and_then(|r| r.get("engine"))
        .and_then(|v| v.as_str())
        .unwrap_or("claude");
    let engine = normalize_agent_engine(raw_engine).unwrap_or("claude");
    let pane_key = format!("{}:{}:{}", workspace_id, pane_id, engine);

    let _guard = lock_store();
    let conversations = match read_stored_object(&agent_resume_path()) {
        StoredObject::Map(store) => store
            .get("panes")
            .and_then(|p| p.get(&pane_key))
            .and_then(|entry| entry.get("conversations"))
            .and_then(|c| c.as_array())
            .cloned()
            .unwrap_or_default(),
        StoredObject::Unreadable => Vec::new(),
    };

    json!({
        "schemaVersion": 1,
        "conversations": conversations
    })
}

#[tauri::command]
pub fn agent_pane_resume_choice(request: Option<Value>) -> Value {
    let req = crate::persist::body(&request);
    let workspace_id = req
        .and_then(|r| r.get("workspaceId"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let pane_id = req
        .and_then(|r| r.get("paneId"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let raw_engine = req
        .and_then(|r| r.get("engine"))
        .and_then(|v| v.as_str())
        .unwrap_or("claude");
    let engine = normalize_agent_engine(raw_engine).unwrap_or("claude");
    let choice_obj = req.and_then(|r| r.get("choice"));
    let choice_kind = choice_obj
        .and_then(|c| c.get("kind"))
        .and_then(|v| v.as_str())
        .unwrap_or("fresh");
    let target_key = choice_obj
        .and_then(|c| c.get("key"))
        .and_then(|v| v.as_str())
        .filter(|s| Uuid::parse_str(s).is_ok())
        .map(|s| s.to_string())
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    let pane_key = format!("{}:{}:{}", workspace_id, pane_id, engine);
    let now = now_unix_ms();

    let _guard = lock_store();
    let path = agent_resume_path();
    let StoredObject::Map(mut store) = read_stored_object(&path) else {
        return json!({ "schemaVersion": 1, "changed": false });
    };

    let panes_val = store
        .entry("panes".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    let Some(panes) = panes_val.as_object_mut() else {
        return json!({ "schemaVersion": 1, "changed": false });
    };

    let entry_val = panes.entry(pane_key).or_insert_with(|| {
        json!({
            "activeKey": Uuid::new_v4().to_string(),
            "startedAtUnixMs": now,
            "conversations": []
        })
    });
    let Some(entry) = entry_val.as_object_mut() else {
        return json!({ "schemaVersion": 1, "changed": false });
    };

    let current_key = entry
        .get("activeKey")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let current_started = entry
        .get("startedAtUnixMs")
        .and_then(|v| v.as_i64())
        .unwrap_or(now);

    let next_key = if choice_kind == "previous" {
        target_key
    } else {
        Uuid::new_v4().to_string()
    };

    if current_key == next_key {
        return json!({ "schemaVersion": 1, "changed": false });
    }

    let mut next_started = now;
    let convs_val = entry
        .entry("conversations".to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    if let Some(convs) = convs_val.as_array_mut() {
        if let Some(pos) = convs
            .iter()
            .position(|c| c.get("key").and_then(|v| v.as_str()) == Some(&next_key))
        {
            let removed = convs.remove(pos);
            next_started = removed
                .get("startedAtUnixMs")
                .and_then(|v| v.as_i64())
                .unwrap_or(now);
        }
        if !current_key.is_empty() && Uuid::parse_str(&current_key).is_ok() {
            convs.retain(|c| c.get("key").and_then(|v| v.as_str()) != Some(&current_key));
            convs.insert(
                0,
                json!({
                    "key": current_key,
                    "startedAtUnixMs": current_started,
                    "archivedAtUnixMs": now
                }),
            );
            convs.truncate(8);
        }
    }

    entry.insert("activeKey".to_string(), Value::String(next_key));
    entry.insert("startedAtUnixMs".to_string(), json!(next_started));
    let _ = write_stored_object(&path, &store);

    json!({
        "schemaVersion": 1,
        "changed": true
    })
}

#[tauri::command]
pub fn connect_ssh_workspace(request: Option<Value>) -> Value {
    // remember_workspace requires a local folder, so the endpoint stays in the sidecar file.
    let Some(value) = request else {
        return Value::Null;
    };
    let req = value.get("request").unwrap_or(&value);
    let Some(endpoint) = parse_ssh_endpoint(req) else {
        return Value::Null;
    };
    let (id, workspace, stored) = workspace_record(&endpoint);
    let _guard = lock_store();
    let path = ssh_workspaces_path();
    let StoredObject::Map(mut map) = read_stored_object(&path) else {
        return Value::Null;
    };
    map.insert(id, stored);
    if write_stored_object(&path, &map).is_err() {
        return Value::Null;
    }
    workspace
}

#[tauri::command]
pub fn reconnect_ssh_workspace(request: Option<Value>) -> Value {
    let Some(value) = request else {
        return Value::Null;
    };
    let req = value.get("request").unwrap_or(&value);
    let Some(workspace_id) = req.get("workspaceId").and_then(|v| v.as_str()).filter(|id| !id.is_empty()) else {
        return Value::Null;
    };
    let _guard = lock_store();
    match read_stored_object(&ssh_workspaces_path()) {
        StoredObject::Map(map) => map.get(workspace_id).map(public_ssh_workspace).unwrap_or(Value::Null),
        StoredObject::Unreadable => Value::Null,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::Path;

    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn with_temp_config(test: impl FnOnce(&Path)) {
        let _lock = TEST_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join(format!("kite-studio-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        *TEST_CONFIG_DIR.lock().unwrap() = Some(dir.clone());
        struct Clear(PathBuf);
        impl Drop for Clear {
            fn drop(&mut self) {
                *TEST_CONFIG_DIR.lock().unwrap() = None;
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _clear = Clear(dir.clone());
        test(&dir);
    }

    #[test]
    fn kite_layout_round_trip_without_tauri() {
        with_temp_config(|dir| {
            let workspace_id = "a1111111-1111-4111-8111-111111111111";
            let layout = json!({
                "schemaVersion": 2,
                "workspaceId": workspace_id,
                "tabs": [{ "id": "tab-1", "title": "Terminal" }],
                "activeTabId": "tab-1",
                "fullscreenLeafId": null
            });
            let saved = save_workspace_layout(json!({ "request": { "layout": layout } }));
            assert!(saved.is_null());

            let on_disk: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("layouts.json")).unwrap()).unwrap();
            assert_eq!(on_disk[workspace_id]["tabs"][0]["title"], "Terminal");

            let loaded = load_workspace_layout(json!({ "workspaceId": workspace_id }));
            assert_eq!(loaded["layout"]["schemaVersion"], 2);
            assert_eq!(loaded["layout"]["workspaceId"], workspace_id);
            assert_eq!(loaded["layout"]["tabs"], layout["tabs"]);
            assert_eq!(loaded["layout"]["activeTabId"], "tab-1");
            assert!(loaded["layout"]["fullscreenLeafId"].is_null());
            assert_eq!(loaded["recoveryNotices"], json!([]));
            assert_eq!(loaded["readOnly"], false);

            let again = load_workspace_layout(json!({ "request": { "workspaceId": workspace_id } }));
            assert_eq!(loaded, again);

            let missing_id = "b2222222-2222-4222-8222-222222222222";
            let missing = load_workspace_layout(json!({ "workspaceId": missing_id }));
            assert_eq!(missing["layout"], empty_layout(missing_id));
            assert_eq!(missing["recoveryNotices"], json!([]));
            assert_eq!(missing["readOnly"], false);
        });
    }

    #[test]
    fn kite_ssh_enrollment_records_endpoint() {
        with_temp_config(|dir| {
            let rejected = [
                json!({ "host": "", "username": "alice", "folder": "/work", "port": 22 }),
                json!({ "host": "   ", "username": "alice", "folder": "/work", "port": 22 }),
                json!({ "host": "example.com", "username": "", "folder": "/work", "port": 22 }),
                json!({ "host": "example.com", "username": "alice", "folder": "", "port": 22 }),
                json!({ "host": "example.com", "username": "alice", "folder": "   ", "port": 22 }),
                json!({ "host": "example.com", "username": "alice", "folder": "/work", "port": 0 }),
                json!({ "host": "example.com", "username": "alice", "folder": "/work", "port": 65536 }),
                json!({ "host": "example.com", "username": "alice", "folder": "/work", "port": -1 }),
            ];
            for request in rejected {
                assert!(connect_ssh_workspace(Some(request)).is_null());
            }
            assert!(!dir.join("ssh-workspaces.json").exists());

            let created = connect_ssh_workspace(Some(json!({
                "request": {
                    "host": "example.com",
                    "username": "alice",
                    "folder": "/work/app",
                    "port": 22,
                    "chooseKey": false
                }
            })));
            assert_eq!(created["displayName"], "alice@example.com");
            assert_eq!(created["pinned"], false);
            assert_eq!(created["available"], false);
            assert!(created.get("host").is_none());
            assert!(created.get("folder").is_none());
            let created_at = created["createdAtUnixMs"].as_i64().unwrap();
            let now = now_unix_ms();
            assert!((now - created_at).abs() < 10_000);
            assert_ne!(created["displayName"], "SSH Workspace");

            let id = created["id"].as_str().unwrap();
            let on_disk: Value = serde_json::from_str(
                &std::fs::read_to_string(dir.join("ssh-workspaces.json")).unwrap(),
            )
            .unwrap();
            assert_eq!(on_disk[id]["host"], "example.com");
            assert_eq!(on_disk[id]["username"], "alice");
            assert_eq!(on_disk[id]["port"], 22);
            assert_eq!(on_disk[id]["folder"], "/work/app");

            let reconnected = reconnect_ssh_workspace(Some(json!({ "workspaceId": id })));
            assert_eq!(reconnected, created);
            assert!(reconnect_ssh_workspace(Some(json!({
                "workspaceId": "c3333333-3333-4333-8333-333333333333"
            })))
            .is_null());
            assert!(reconnect_ssh_workspace(None).is_null());
        });
    }

    #[test]
    fn kite_agent_resume_lifecycle() {
        with_temp_config(|_dir| {
            STARTUP_PROMPT_DISMISSED.store(false, std::sync::atomic::Ordering::SeqCst);
            let workspace_id = "d4444444-4444-4444-8444-444444444444";
            let pane_id = "e5555555-5555-4555-8555-555555555555";
            let initial_session_id = "f6666666-6666-4666-8666-666666666666";

            let layout = json!({
                "schemaVersion": 2,
                "workspaceId": workspace_id,
                "tabs": [{
                    "id": "tab-1",
                    "title": "Agent Tab",
                    "root": {
                        "type": "leaf",
                        "id": pane_id,
                        "occupant": {
                            "kind": "terminal",
                            "sessionId": initial_session_id,
                            "title": "Claude Assistant",
                            "engine": "claude"
                        }
                    }
                }],
                "activeTabId": "tab-1",
                "fullscreenLeafId": null
            });
            save_workspace_layout(json!({ "request": { "layout": layout } }));

            // By default alwaysResume is true so startup resumes automatically without modal
            let prefs_default = agent_resume_preferences_get(None);
            assert_eq!(prefs_default["alwaysResume"], true);
            let prompt_auto = resume_prompt_get(None);
            assert_eq!(prompt_auto["status"], "quiet");

            // When user opts out of alwaysResume, prompt becomes pending on startup
            agent_resume_preferences_set(Some(json!({ "alwaysResume": false })));
            let prefs_before = agent_resume_preferences_get(None);
            assert_eq!(prefs_before["alwaysResume"], false);

            let prompt = resume_prompt_get(None);
            assert_eq!(prompt["schemaVersion"], 1);
            assert_eq!(prompt["status"], "pending");
            assert_eq!(prompt["total"], 1);
            assert_eq!(prompt["agents"][0]["paneId"], pane_id);
            assert_eq!(prompt["agents"][0]["engine"], "claude");

            // Preferences get & set
            agent_resume_preferences_set(Some(json!({ "alwaysResume": true })));
            let prefs_after = agent_resume_preferences_get(None);
            assert_eq!(prefs_after["alwaysResume"], true);
            agent_resume_preferences_set(Some(json!({ "alwaysResume": false })));

            // History starts empty
            let history_before = agent_pane_history(Some(json!({
                "workspaceId": workspace_id,
                "paneId": pane_id,
                "engine": "claude"
            })));
            assert_eq!(history_before["schemaVersion"], 1);
            assert_eq!(history_before["conversations"].as_array().unwrap().len(), 0);

            // Answer with resumeAll dismisses prompt
            let answered = resume_prompt_answer(Some(json!({
                "choice": "resumeAll",
                "alwaysResume": false
            })));
            assert_eq!(answered["status"], "quiet");
            let prompt_after = resume_prompt_get(None);
            assert_eq!(prompt_after["status"], "quiet");

            // Choice "fresh" archives current key and creates a fresh conversation
            let choice_fresh = agent_pane_resume_choice(Some(json!({
                "workspaceId": workspace_id,
                "paneId": pane_id,
                "engine": "claude",
                "choice": { "kind": "fresh" }
            })));
            assert_eq!(choice_fresh["changed"], true);

            // History now has the initial conversation archived
            let history_after = agent_pane_history(Some(json!({
                "workspaceId": workspace_id,
                "paneId": pane_id,
                "engine": "claude"
            })));
            let convs = history_after["conversations"].as_array().unwrap();
            assert_eq!(convs.len(), 1);
            assert_eq!(convs[0]["key"], initial_session_id);

            // Can resume the previous conversation
            let choice_previous = agent_pane_resume_choice(Some(json!({
                "workspaceId": workspace_id,
                "paneId": pane_id,
                "engine": "claude",
                "choice": { "kind": "previous", "key": initial_session_id }
            })));
            assert_eq!(choice_previous["changed"], true);
        });
    }
}
