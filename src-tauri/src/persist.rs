use crate::logger::log_trace;
use rusqlite::{params, Connection, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub display_name: String,
    pub created_at_unix_ms: i64,
    pub last_opened_at_unix_ms: i64,
    pub pinned: bool,
    pub available: bool,
}

fn deserialize_optional_bool_or_string<'de, D>(deserializer: D) -> Result<Option<bool>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let opt = Option::<Value>::deserialize(deserializer)?;
    match opt {
        Some(Value::Bool(b)) => Ok(Some(b)),
        Some(Value::String(s)) => Ok(Some(s == "true" || s == "1")),
        Some(Value::Number(n)) => Ok(Some(n.as_i64() == Some(1))),
        _ => Ok(None),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProfile {
    pub id: String,
    pub name: String,
    pub engine: String,
    #[serde(default)]
    pub purpose: String,
    #[serde(default)]
    pub brief: String,
    pub avatar: Option<String>,
    pub created_at_unix_ms: i64,
    pub pinned: bool,
    pub order: i32,
    #[serde(default)]
    pub memory_budget: Option<i64>,
    #[serde(default)]
    pub reflection_mode: Option<String>,
    #[serde(default)]
    pub allow_agent_scheduling: Option<bool>,
    #[serde(default)]
    pub allow_agent_messaging: Option<bool>,
    #[serde(default)]
    pub default_mode: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_bool_or_string")]
    pub default_plan: Option<bool>,
    #[serde(default)]
    pub default_model: Option<String>,
    #[serde(default)]
    pub default_provider_options: Vec<Value>,
    #[serde(default)]
    pub place_display_names: Vec<String>,
    #[serde(default)]
    pub disabled_plugin_ids: Vec<String>,
}

pub fn app_data_folder() -> &'static str {
    if cfg!(debug_assertions) {
        "Kite Code Dev"
    } else {
        "Kite Code"
    }
}

pub fn roaming_app_dir() -> PathBuf {
    let base = std::env::var("APPDATA").unwrap_or_else(|_| r"C:\Users\PC\AppData\Roaming".into());
    PathBuf::from(base).join(app_data_folder())
}

pub fn db_path() -> PathBuf {
    roaming_app_dir().join("kite.sqlite")
}

pub fn state_path() -> PathBuf {
    roaming_app_dir().join("state.json")
}

pub fn seed_workspaces() -> Vec<Workspace> {
    vec![]
}

pub fn seed_agents() -> Vec<AgentProfile> {
    vec![
        AgentProfile {
            id: "c3333333-3333-4333-8333-333333333333".into(),
            name: "Orion".into(),
            engine: "antigravity".into(),
            purpose: "Autonomous software engineering and code analysis assistant".into(),
            brief: "Autonomous software engineering and code analysis assistant".into(),
            avatar: None,
            created_at_unix_ms: 1791770226543,
            pinned: true,
            order: 0,
            memory_budget: Some(2200),
            reflection_mode: Some("ask".into()),
            allow_agent_scheduling: Some(true),
            allow_agent_messaging: Some(true),
            default_mode: Some("acceptEdits".into()),
            default_plan: None,
            default_model: None,
            default_provider_options: vec![],
            place_display_names: vec![],
            disabled_plugin_ids: vec![],
        },
        AgentProfile {
            id: "d4444444-4444-4444-8444-444444444444".into(),
            name: "Claude Code".into(),
            engine: "claude-code".into(),
            purpose: "Anthropic Claude coding agent in terminal".into(),
            brief: "Anthropic Claude coding agent in terminal".into(),
            avatar: None,
            created_at_unix_ms: 1791770226543,
            pinned: false,
            order: 1,
            memory_budget: Some(2200),
            reflection_mode: Some("ask".into()),
            allow_agent_scheduling: Some(true),
            allow_agent_messaging: Some(true),
            default_mode: Some("acceptEdits".into()),
            default_plan: None,
            default_model: None,
            default_provider_options: vec![],
            place_display_names: vec![],
            disabled_plugin_ids: vec![],
        },
    ]
}

pub fn seed_paths() -> HashMap<String, String> {
    HashMap::new()
}

pub fn seed_routines() -> Vec<Value> {
    let now = 1791770226543i64;
    vec![
        json!({
            "id": "r1111111-1111-4111-8111-111111111111",
            "agentId": "c3333333-3333-4333-8333-333333333333",
            "name": "Daily Project Health Check",
            "prompt": "Inspect codebase health and verify repository status.",
            "cadence": { "kind": "interval", "seconds": 86400 },
            "enabled": true,
            "author": { "kind": "user" },
            "workspaceId": "b2222222-2222-4222-8222-222222222222",
            "createdAtUnixMs": now, "nextRunAtUnixMs": now + 86400000,
            "lastRunAtUnixMs": Value::Null, "lastRunThreadId": Value::Null, "lastError": Value::Null
        })
    ]
}

pub fn seed_notifications() -> Vec<Value> {
    let now = 1791770226543i64;
    vec![
        json!({
            "id": "e1111111-1111-4111-8111-111111111111",
            "runId": "f2222222-2222-4222-8222-222222222222",
            "target": {
                "source": "codeThread",
                "id": "11111111-1111-4111-8111-111111111111"
            },
            "profileId": Value::Null,
            "routineId": Value::Null,
            "kind": {
                "kind": "settled",
                "outcome": "completed"
            },
            "resolution": "attended",
            "createdAtUnixMs": now,
            "isRead": false,
            "isWaitingForInput": false
        })
    ]
}

#[derive(Clone)]
pub struct DiskState {
    pub workspaces: Vec<Workspace>,
    pub paths: HashMap<String, String>,
    pub agents: Vec<AgentProfile>,
    pub threads: Vec<Value>,
    pub last_provider: String,
    pub grid: Value,
    pub revision: u64,
    pub routines: Vec<Value>,
    pub notifications: Vec<Value>,
}

const SCHEMA_SQL: &str = "
CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    folder_path TEXT NOT NULL,
    created_at_unix_ms INTEGER NOT NULL,
    last_opened_at_unix_ms INTEGER NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0,
    available INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    engine TEXT NOT NULL,
    purpose TEXT NOT NULL,
    brief TEXT NOT NULL DEFAULT '',
    avatar TEXT,
    created_at_unix_ms INTEGER NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    memory_budget INTEGER,
    reflection_mode TEXT,
    allow_agent_scheduling INTEGER,
    allow_agent_messaging INTEGER,
    default_mode TEXT,
    default_plan TEXT,
    default_model TEXT,
    default_provider_options TEXT NOT NULL DEFAULT '[]',
    place_display_names TEXT NOT NULL DEFAULT '[]',
    disabled_plugin_ids TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    created_at_unix_ms INTEGER NOT NULL,
    updated_at_unix_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS app_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS routines (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run_at_unix_ms INTEGER
);
CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    read INTEGER NOT NULL DEFAULT 0,
    created_at_unix_ms INTEGER NOT NULL
);
";

fn open_connection() -> Connection {
    let p = db_path();
    if let Some(parent) = p.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let conn = Connection::open(&p).expect("failed to open studio.sqlite");
    conn.execute_batch(&format!("PRAGMA journal_mode = WAL;{SCHEMA_SQL}"))
        .expect("failed to initialize sqlite schema");
    for col in [
        "memory_budget INTEGER", "reflection_mode TEXT", "allow_agent_scheduling INTEGER",
        "allow_agent_messaging INTEGER", "default_mode TEXT", "default_plan TEXT", "default_model TEXT",
        "brief TEXT", "default_provider_options TEXT", "place_display_names TEXT", "disabled_plugin_ids TEXT",
    ] {
        let _ = conn.execute(&format!("ALTER TABLE agents ADD COLUMN {col}"), []);
    }
    conn
}

pub fn db_connection() -> &'static Mutex<Connection> {
    static CELL: std::sync::OnceLock<Mutex<Connection>> = std::sync::OnceLock::new();
    CELL.get_or_init(|| Mutex::new(open_connection()))
}

fn default_disk_state() -> DiskState {
    DiskState {
        workspaces: seed_workspaces(),
        paths: seed_paths(),
        agents: seed_agents(),
        threads: Vec::new(),
        last_provider: "claude".into(),
        grid: Value::Null,
        revision: 1,
        routines: seed_routines(),
        notifications: seed_notifications(),
    }
}

fn load_legacy_state_json() -> Option<DiskState> {
    let path = state_path();
    let text = fs::read_to_string(&path).ok()?;
    let value = serde_json::from_str::<Value>(&text).ok()?;
    let mut state = default_disk_state();

    if let Some(items) = value.get("workspaces").and_then(|v| v.as_array()) {
        let parsed: Vec<Workspace> = items.iter().filter_map(|v| serde_json::from_value(v.clone()).ok()).collect();
        if !parsed.is_empty() {
            state.workspaces = parsed;
        }
    }
    if let Some(map) = value.get("paths").and_then(|v| v.as_object()) {
        for (id, path) in map {
            if let Some(path) = path.as_str() {
                state.paths.insert(id.clone(), path.to_string());
            }
        }
    }
    if let Some(items) = value.get("agents").and_then(|v| v.as_array()) {
        let parsed: Vec<AgentProfile> = items.iter().filter_map(|v| serde_json::from_value(v.clone()).ok()).collect();
        if !parsed.is_empty() {
            state.agents = parsed;
        }
    }
    if let Some(items) = value.get("threads").and_then(|v| v.as_array()) {
        state.threads = items.clone();
    }
    if let Some(provider) = value.get("lastProvider").and_then(|v| v.as_str()) {
        state.last_provider = provider.to_string();
    }
    if let Some(grid) = value.get("grid") {
        state.grid = grid.clone();
    }
    if let Some(revision) = value.get("revision").and_then(|v| v.as_u64()) {
        state.revision = revision.max(1);
    }
    Some(state)
}

fn load_or_migrate_sqlite() -> DiskState {
    let conn_guard = db_connection().lock().unwrap();
    let conn = &*conn_guard;

    let ws_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM workspaces", [], |row| row.get(0))
        .unwrap_or(0);

    if ws_count == 0 {
        // SQLite is empty, check if state.json exists for one-time migration
        log_trace("SQLite database empty, checking for state.json migration");
        let initial_state = if let Some(legacy) = load_legacy_state_json() {
            log_trace("Migrating data from state.json into studio.sqlite");
            legacy
        } else {
            log_trace("Initializing fresh seed data in studio.sqlite");
            default_disk_state()
        };
        drop(conn_guard);
        save_disk_to_sqlite(&initial_state);
        return initial_state;
    }

    // Load state from SQLite
    let mut ws_stmt = conn.prepare("SELECT id, display_name, folder_path, created_at_unix_ms, last_opened_at_unix_ms, pinned FROM workspaces ORDER BY sort_order ASC").expect("failed to prepare workspaces query");
    let ws_rows = ws_stmt.query_map([], |row| {
        let id: String = row.get(0)?;
        let display_name: String = row.get(1)?;
        let folder_path: String = row.get(2)?;
        let created_at_unix_ms: i64 = row.get(3)?;
        let last_opened_at_unix_ms: i64 = row.get(4)?;
        let pinned: bool = row.get::<_, i64>(5)? != 0;
        let available = Path::new(&folder_path).is_dir();
        Ok((Workspace {
            id: id.clone(),
            display_name,
            created_at_unix_ms,
            last_opened_at_unix_ms,
            pinned,
            available,
        }, id, folder_path))
    }).expect("failed to query workspaces");

    let mut workspaces = Vec::new();
    let mut paths = HashMap::new();
    for row in ws_rows.flatten() {
        workspaces.push(row.0);
        paths.insert(row.1, row.2);
    }

    let mut ag_stmt = conn.prepare("SELECT id, name, engine, purpose, avatar, created_at_unix_ms, pinned, sort_order, memory_budget, reflection_mode, allow_agent_scheduling, allow_agent_messaging, default_mode, default_plan, default_model, brief, default_provider_options, place_display_names, disabled_plugin_ids FROM agents ORDER BY sort_order ASC").expect("failed to prepare agents query");
    let ag_rows = ag_stmt.query_map([], |row| {
        let purpose: String = row.get(3)?;
        let brief: String = row.get::<_, Option<String>>(15).ok().flatten().unwrap_or_else(|| purpose.clone());
        let default_plan_str: Option<String> = row.get(13).ok();
        let default_plan = default_plan_str.map(|s| s == "true" || s == "1");
        let default_provider_options: Vec<Value> = row.get::<_, Option<String>>(16).ok().flatten()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let place_display_names: Vec<String> = row.get::<_, Option<String>>(17).ok().flatten()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let disabled_plugin_ids: Vec<String> = row.get::<_, Option<String>>(18).ok().flatten()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let raw_name: String = row.get(1)?;
        let engine: String = row.get(2)?;
        let name = if raw_name.eq_ignore_ascii_case("antigravity") && engine == "antigravity" {
            "Orion".to_string()
        } else {
            raw_name
        };
        Ok(AgentProfile {
            id: row.get(0)?,
            name,
            engine,
            purpose: if purpose.is_empty() { brief.clone() } else { purpose },
            brief,
            avatar: row.get(4)?,
            created_at_unix_ms: row.get(5)?,
            pinned: row.get::<_, i64>(6)? != 0,
            order: row.get::<_, i64>(7)? as i32,
            memory_budget: row.get(8).ok(),
            reflection_mode: row.get(9).ok(),
            allow_agent_scheduling: row.get::<_, Option<i64>>(10).ok().flatten().map(|v| v != 0),
            allow_agent_messaging: row.get::<_, Option<i64>>(11).ok().flatten().map(|v| v != 0),
            default_mode: row.get(12).ok(),
            default_plan,
            default_model: row.get(14).ok(),
            default_provider_options,
            place_display_names,
            disabled_plugin_ids,
        })
    }).expect("failed to query agents");
    let agents: Vec<AgentProfile> = ag_rows.flatten().collect();

    let mut th_stmt = conn.prepare("SELECT data FROM threads ORDER BY updated_at_unix_ms ASC").expect("failed to prepare threads query");
    let th_rows = th_stmt.query_map([], |row| {
        let data: String = row.get(0)?;
        Ok(serde_json::from_str::<Value>(&data).unwrap_or(Value::Null))
    }).expect("failed to query threads");
    let threads: Vec<Value> = th_rows.flatten().filter(|v| !v.is_null()).collect();

    let mut last_provider = "claude".to_string();
    let mut grid = Value::Null;
    let mut revision = 1u64;
    let mut routines_seeded = false;
    let mut notifications_seeded = false;

    let mut app_stmt = conn.prepare("SELECT key, value FROM app_state").expect("failed to prepare app_state query");
    let app_rows = app_stmt.query_map([], |row| {
        let key: String = row.get(0)?;
        let val: String = row.get(1)?;
        Ok((key, val))
    }).expect("failed to query app_state");

    for (k, v) in app_rows.flatten() {
        match k.as_str() {
            "lastProvider" => last_provider = v,
            "grid" => grid = serde_json::from_str(&v).unwrap_or(Value::Null),
            "revision" => revision = v.parse().unwrap_or(1),
            "routinesSeeded" => routines_seeded = v == "1",
            "notificationsSeeded" => notifications_seeded = v == "1",
            _ => {}
        }
    }

    let mut rt_stmt = conn.prepare("SELECT data FROM routines").expect("failed to prepare routines query");
    let rt_rows = rt_stmt.query_map([], |row| {
        let data: String = row.get(0)?;
        Ok(serde_json::from_str::<Value>(&data).unwrap_or(Value::Null))
    }).expect("failed to query routines");
    let mut routines: Vec<Value> = rt_rows.flatten().filter(|v| !v.is_null()).collect();
    let seed_routines_now = routines.is_empty() && !routines_seeded;
    if seed_routines_now {
        routines = seed_routines();
    }

    let mut notif_stmt = conn.prepare("SELECT data FROM notifications ORDER BY created_at_unix_ms DESC").expect("failed to prepare notifications query");
    let notif_rows = notif_stmt.query_map([], |row| {
        let data: String = row.get(0)?;
        Ok(serde_json::from_str::<Value>(&data).unwrap_or(Value::Null))
    }).expect("failed to query notifications");
    let mut notifications: Vec<Value> = notif_rows.flatten().filter(|v| !v.is_null()).collect();
    let seed_notifications_now = notifications.is_empty() && !notifications_seeded;
    if seed_notifications_now {
        notifications = seed_notifications();
    }

    let state = DiskState {
        workspaces,
        paths,
        agents,
        threads,
        last_provider,
        grid,
        revision,
        routines,
        notifications,
    };
    if seed_routines_now || seed_notifications_now {
        drop(ws_stmt);
        drop(ag_stmt);
        drop(th_stmt);
        drop(app_stmt);
        drop(rt_stmt);
        drop(notif_stmt);
        drop(conn_guard);
        save_disk_to_sqlite(&state);
    }
    state
}

fn flag(value: bool) -> i64 {
    i64::from(value)
}

fn json_row_id(value: &Value) -> Option<&str> {
    value.get("id").and_then(Value::as_str)
}

fn delete_absent(tx: &Transaction<'_>, sql: &str, ids: &[String]) -> Result<(), rusqlite::Error> {
    let payload = serde_json::to_string(ids).expect("row ids serialize");
    tx.execute(sql, [payload])?;
    Ok(())
}

fn sync_workspaces(tx: &Transaction<'_>, state: &DiskState) -> Result<(), rusqlite::Error> {
    let mut stmt = tx.prepare(
        "INSERT INTO workspaces (
             id, display_name, folder_path, created_at_unix_ms, last_opened_at_unix_ms,
             pinned, available, sort_order
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET
             display_name = excluded.display_name,
             folder_path = excluded.folder_path,
             created_at_unix_ms = excluded.created_at_unix_ms,
             last_opened_at_unix_ms = excluded.last_opened_at_unix_ms,
             pinned = excluded.pinned,
             available = excluded.available,
             sort_order = excluded.sort_order
         WHERE workspaces.display_name IS NOT excluded.display_name
            OR workspaces.folder_path IS NOT excluded.folder_path
            OR workspaces.created_at_unix_ms IS NOT excluded.created_at_unix_ms
            OR workspaces.last_opened_at_unix_ms IS NOT excluded.last_opened_at_unix_ms
            OR workspaces.pinned IS NOT excluded.pinned
            OR workspaces.available IS NOT excluded.available
            OR workspaces.sort_order IS NOT excluded.sort_order",
    )?;
    let mut ids = Vec::with_capacity(state.workspaces.len());
    for (index, workspace) in state.workspaces.iter().enumerate() {
        let folder = state.paths.get(&workspace.id).cloned().unwrap_or_default();
        stmt.execute(params![
            workspace.id,
            workspace.display_name,
            folder,
            workspace.created_at_unix_ms,
            workspace.last_opened_at_unix_ms,
            flag(workspace.pinned),
            flag(workspace.available),
            index as i64
        ])?;
        ids.push(workspace.id.clone());
    }
    drop(stmt);
    delete_absent(
        tx,
        "DELETE FROM workspaces WHERE id NOT IN (SELECT value FROM json_each(?1))",
        &ids,
    )
}

fn sync_agents(tx: &Transaction<'_>, agents: &[AgentProfile]) -> Result<(), rusqlite::Error> {
    let mut stmt = tx.prepare(
        "INSERT INTO agents (
             id, name, engine, purpose, avatar, created_at_unix_ms, pinned, sort_order,
             memory_budget, reflection_mode, allow_agent_scheduling, allow_agent_messaging,
             default_mode, default_plan, default_model, brief, default_provider_options,
             place_display_names, disabled_plugin_ids
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)
         ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             engine = excluded.engine,
             purpose = excluded.purpose,
             avatar = excluded.avatar,
             created_at_unix_ms = excluded.created_at_unix_ms,
             pinned = excluded.pinned,
             sort_order = excluded.sort_order,
             memory_budget = excluded.memory_budget,
             reflection_mode = excluded.reflection_mode,
             allow_agent_scheduling = excluded.allow_agent_scheduling,
             allow_agent_messaging = excluded.allow_agent_messaging,
             default_mode = excluded.default_mode,
             default_plan = excluded.default_plan,
             default_model = excluded.default_model,
             brief = excluded.brief,
             default_provider_options = excluded.default_provider_options,
             place_display_names = excluded.place_display_names,
             disabled_plugin_ids = excluded.disabled_plugin_ids
         WHERE agents.name IS NOT excluded.name
            OR agents.engine IS NOT excluded.engine
            OR agents.purpose IS NOT excluded.purpose
            OR agents.avatar IS NOT excluded.avatar
            OR agents.created_at_unix_ms IS NOT excluded.created_at_unix_ms
            OR agents.pinned IS NOT excluded.pinned
            OR agents.sort_order IS NOT excluded.sort_order
            OR agents.memory_budget IS NOT excluded.memory_budget
            OR agents.reflection_mode IS NOT excluded.reflection_mode
            OR agents.allow_agent_scheduling IS NOT excluded.allow_agent_scheduling
            OR agents.allow_agent_messaging IS NOT excluded.allow_agent_messaging
            OR agents.default_mode IS NOT excluded.default_mode
            OR agents.default_plan IS NOT excluded.default_plan
            OR agents.default_model IS NOT excluded.default_model
            OR agents.brief IS NOT excluded.brief
            OR agents.default_provider_options IS NOT excluded.default_provider_options
            OR agents.place_display_names IS NOT excluded.place_display_names
            OR agents.disabled_plugin_ids IS NOT excluded.disabled_plugin_ids",
    )?;
    let mut ids = Vec::with_capacity(agents.len());
    for (index, agent) in agents.iter().enumerate() {
        let default_plan_str = agent.default_plan.map(|b| if b { "true" } else { "false" });
        let default_provider_opts_str = serde_json::to_string(&agent.default_provider_options).unwrap_or_else(|_| "[]".into());
        let place_display_names_str = serde_json::to_string(&agent.place_display_names).unwrap_or_else(|_| "[]".into());
        let disabled_plugin_ids_str = serde_json::to_string(&agent.disabled_plugin_ids).unwrap_or_else(|_| "[]".into());
        let brief_str = if agent.brief.is_empty() { &agent.purpose } else { &agent.brief };
        stmt.execute(params![
            agent.id,
            agent.name,
            agent.engine,
            agent.purpose,
            agent.avatar,
            agent.created_at_unix_ms,
            flag(agent.pinned),
            index as i64,
            agent.memory_budget,
            agent.reflection_mode,
            agent.allow_agent_scheduling.map(flag),
            agent.allow_agent_messaging.map(flag),
            agent.default_mode,
            default_plan_str,
            agent.default_model,
            brief_str,
            default_provider_opts_str,
            place_display_names_str,
            disabled_plugin_ids_str,
        ])?;
        ids.push(agent.id.clone());
    }
    drop(stmt);
    delete_absent(
        tx,
        "DELETE FROM agents WHERE id NOT IN (SELECT value FROM json_each(?1))",
        &ids,
    )
}

fn sync_threads(tx: &Transaction<'_>, threads: &[Value]) -> Result<(), rusqlite::Error> {
    let mut stmt = tx.prepare(
        "INSERT INTO threads (id, data, created_at_unix_ms, updated_at_unix_ms)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET
             data = excluded.data,
             created_at_unix_ms = excluded.created_at_unix_ms,
             updated_at_unix_ms = excluded.updated_at_unix_ms
         WHERE threads.data IS NOT excluded.data
            OR threads.created_at_unix_ms IS NOT excluded.created_at_unix_ms
            OR threads.updated_at_unix_ms IS NOT excluded.updated_at_unix_ms",
    )?;
    let mut ids = Vec::new();
    for thread in threads {
        let Some(id) = json_row_id(thread) else {
            continue;
        };
        let created = thread.get("createdAtUnixMs").and_then(Value::as_i64).unwrap_or(0);
        let updated = thread.get("updatedAtUnixMs").and_then(Value::as_i64).unwrap_or(0);
        let data = serde_json::to_string(thread).unwrap_or_default();
        stmt.execute(params![id, data, created, updated])?;
        ids.push(id.to_string());
    }
    drop(stmt);
    delete_absent(
        tx,
        "DELETE FROM threads WHERE id NOT IN (SELECT value FROM json_each(?1))",
        &ids,
    )
}

fn sync_routines(tx: &Transaction<'_>, routines: &[Value]) -> Result<(), rusqlite::Error> {
    let mut stmt = tx.prepare(
        "INSERT INTO routines (id, data, enabled, last_run_at_unix_ms)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET
             data = excluded.data,
             enabled = excluded.enabled,
             last_run_at_unix_ms = excluded.last_run_at_unix_ms
         WHERE routines.data IS NOT excluded.data
            OR routines.enabled IS NOT excluded.enabled
            OR routines.last_run_at_unix_ms IS NOT excluded.last_run_at_unix_ms",
    )?;
    let mut ids = Vec::new();
    for routine in routines {
        let Some(id) = json_row_id(routine) else {
            continue;
        };
        let enabled = routine.get("enabled").and_then(Value::as_bool).unwrap_or(true);
        let last_run: Option<i64> = routine.get("lastRunAtUnixMs").and_then(Value::as_i64);
        let data = serde_json::to_string(routine).unwrap_or_default();
        stmt.execute(params![id, data, flag(enabled), last_run])?;
        ids.push(id.to_string());
    }
    drop(stmt);
    delete_absent(
        tx,
        "DELETE FROM routines WHERE id NOT IN (SELECT value FROM json_each(?1))",
        &ids,
    )
}

fn sync_notifications(tx: &Transaction<'_>, notifications: &[Value]) -> Result<(), rusqlite::Error> {
    let mut stmt = tx.prepare(
        "INSERT INTO notifications (id, data, read, created_at_unix_ms)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET
             data = excluded.data,
             read = excluded.read,
             created_at_unix_ms = excluded.created_at_unix_ms
         WHERE notifications.data IS NOT excluded.data
            OR notifications.read IS NOT excluded.read
            OR notifications.created_at_unix_ms IS NOT excluded.created_at_unix_ms",
    )?;
    let mut ids = Vec::new();
    for notification in notifications {
        let Some(id) = json_row_id(notification) else {
            continue;
        };
        let is_read = notification.get("isRead").and_then(Value::as_bool).unwrap_or(false);
        let created = notification.get("createdAtUnixMs").and_then(Value::as_i64).unwrap_or(0);
        let data = serde_json::to_string(notification).unwrap_or_default();
        stmt.execute(params![id, data, flag(is_read), created])?;
        ids.push(id.to_string());
    }
    drop(stmt);
    delete_absent(
        tx,
        "DELETE FROM notifications WHERE id NOT IN (SELECT value FROM json_each(?1))",
        &ids,
    )
}

fn sync_app_state(tx: &Transaction<'_>, state: &DiskState) -> Result<(), rusqlite::Error> {
    let grid = serde_json::to_string(&state.grid).unwrap_or_default();
    let revision = state.revision.to_string();
    let rows = [
        ("lastProvider", state.last_provider.as_str()),
        ("grid", grid.as_str()),
        ("revision", revision.as_str()),
        ("routinesSeeded", "1"),
        ("notificationsSeeded", "1"),
    ];
    let mut stmt = tx.prepare(
        "INSERT INTO app_state (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value
         WHERE app_state.value IS NOT excluded.value",
    )?;
    for (key, value) in rows {
        stmt.execute(params![key, value])?;
    }
    Ok(())
}

fn apply_disk_state(tx: &Transaction<'_>, state: &DiskState) -> Result<(), rusqlite::Error> {
    sync_workspaces(tx, state)?;
    sync_agents(tx, &state.agents)?;
    sync_threads(tx, &state.threads)?;
    sync_routines(tx, &state.routines)?;
    sync_notifications(tx, &state.notifications)?;
    sync_app_state(tx, state)?;
    Ok(())
}

fn write_disk_state(conn: &mut Connection, state: &DiskState) -> Result<(), rusqlite::Error> {
    let tx = conn.transaction()?;
    apply_disk_state(&tx, state)?;
    tx.commit()?;
    Ok(())
}

pub fn save_disk_to_sqlite(state: &DiskState) {
    let mut conn_guard = db_connection().lock().unwrap();
    if let Err(error) = write_disk_state(&mut conn_guard, state) {
        log_trace(&format!("Failed to commit sqlite transaction: {error}"));
    }
}

pub fn initial_state() -> &'static DiskState {
    static STATE: std::sync::OnceLock<DiskState> = std::sync::OnceLock::new();
    STATE.get_or_init(load_or_migrate_sqlite)
}

pub fn workspaces() -> &'static Mutex<Vec<Workspace>> {
    static CELL: std::sync::OnceLock<Mutex<Vec<Workspace>>> = std::sync::OnceLock::new();
    CELL.get_or_init(|| Mutex::new(initial_state().workspaces.clone()))
}

pub fn paths() -> &'static Mutex<HashMap<String, String>> {
    static CELL: std::sync::OnceLock<Mutex<HashMap<String, String>>> = std::sync::OnceLock::new();
    CELL.get_or_init(|| Mutex::new(initial_state().paths.clone()))
}

pub fn agents() -> &'static Mutex<Vec<AgentProfile>> {
    static CELL: std::sync::OnceLock<Mutex<Vec<AgentProfile>>> = std::sync::OnceLock::new();
    CELL.get_or_init(|| Mutex::new(initial_state().agents.clone()))
}

pub fn threads() -> &'static Mutex<Vec<Value>> {
    static CELL: std::sync::OnceLock<Mutex<Vec<Value>>> = std::sync::OnceLock::new();
    CELL.get_or_init(|| Mutex::new(initial_state().threads.clone()))
}

pub fn last_provider() -> &'static Mutex<String> {
    static CELL: std::sync::OnceLock<Mutex<String>> = std::sync::OnceLock::new();
    CELL.get_or_init(|| Mutex::new(initial_state().last_provider.clone()))
}

pub fn grid_slot() -> &'static Mutex<Value> {
    static CELL: std::sync::OnceLock<Mutex<Value>> = std::sync::OnceLock::new();
    CELL.get_or_init(|| Mutex::new(initial_state().grid.clone()))
}

pub fn revision_counter() -> &'static Mutex<u64> {
    static CELL: std::sync::OnceLock<Mutex<u64>> = std::sync::OnceLock::new();
    CELL.get_or_init(|| Mutex::new(initial_state().revision))
}

pub fn routines() -> &'static Mutex<Vec<Value>> {
    static CELL: std::sync::OnceLock<Mutex<Vec<Value>>> = std::sync::OnceLock::new();
    CELL.get_or_init(|| Mutex::new(initial_state().routines.clone()))
}

pub fn notifications() -> &'static Mutex<Vec<Value>> {
    static CELL: std::sync::OnceLock<Mutex<Vec<Value>>> = std::sync::OnceLock::new();
    CELL.get_or_init(|| Mutex::new(initial_state().notifications.clone()))
}

pub fn persist() {
    let state = DiskState {
        workspaces: workspaces().lock().unwrap().clone(),
        paths: paths().lock().unwrap().clone(),
        agents: agents().lock().unwrap().clone(),
        threads: threads().lock().unwrap().clone(),
        last_provider: last_provider().lock().unwrap().clone(),
        grid: grid_slot().lock().unwrap().clone(),
        revision: *revision_counter().lock().unwrap(),
        routines: routines().lock().unwrap().clone(),
        notifications: notifications().lock().unwrap().clone(),
    };
    save_disk_to_sqlite(&state);
}

pub fn next_revision() -> String {
    let mut counter = revision_counter().lock().unwrap();
    *counter = counter.saturating_add(1);
    format!("{:064x}", *counter)
}

pub fn workspace_path(id: &str) -> Option<String> {
    paths().lock().unwrap().get(id).cloned().filter(|p| !p.is_empty())
}

pub fn all_workspace_paths() -> HashMap<String, String> {
    paths().lock().unwrap().clone()
}

fn plain_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    text.strip_prefix(r"\\?\").unwrap_or(text.as_ref()).to_string()
}

pub fn remember_workspace(workspace: Workspace, folder: PathBuf) -> Value {
    let canonical = folder.canonicalize().unwrap_or(folder);
    let key = plain_path(&canonical);
    {
        let paths = paths().lock().unwrap();
        if let Some((id, _)) = paths.iter().find(|(_, existing)| *existing == &key) {
            let id = id.clone();
            drop(paths);
            if let Some(existing) = workspaces().lock().unwrap().iter().find(|w| w.id == id) {
                return serde_json::to_value(existing).unwrap_or(Value::Null);
            }
        }
    }
    paths().lock().unwrap().insert(workspace.id.clone(), key);
    workspaces().lock().unwrap().push(workspace.clone());
    persist();
    serde_json::to_value(workspace).unwrap_or(Value::Null)
}

pub fn save_grid(grid: Value) {
    *grid_slot().lock().unwrap() = grid;
    persist();
}

pub fn load_grid() -> Value {
    json!({
        "grid": grid_slot().lock().unwrap().clone(),
        "recoveryNotices": [],
        "readOnly": false
    })
}

pub fn body<'a>(request: &'a Option<Value>) -> Option<&'a Value> {
    request.as_ref().map(|value| value.get("request").unwrap_or(value))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn count_where(conn: &Connection, sql: &str, id: &str) -> i64 {
        conn.query_row(sql, [id], |row| row.get(0)).unwrap()
    }

    fn app_value(conn: &Connection, key: &str) -> String {
        conn.query_row(
            "SELECT value FROM app_state WHERE key = ?1",
            [key],
            |row| row.get(0),
        )
        .unwrap()
    }

    #[test]
    fn test_sqlite_round_trip() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA_SQL).unwrap();
        conn.execute_batch(
            "CREATE TABLE workspace_events (kind TEXT NOT NULL);
             CREATE TRIGGER workspace_deleted AFTER DELETE ON workspaces BEGIN
                 INSERT INTO workspace_events (kind) VALUES ('delete');
             END;
             CREATE TRIGGER workspace_updated AFTER UPDATE ON workspaces BEGIN
                 INSERT INTO workspace_events (kind) VALUES ('update');
             END;",
        )
        .unwrap();

        let workspace_id = "ws-round-trip";
        let thread_id = "th-round-trip";
        let routine_id = "rt-round-trip";
        let notification_id = "nt-round-trip";
        let mut state = DiskState {
            workspaces: vec![Workspace {
                id: workspace_id.into(),
                display_name: "Round Trip".into(),
                created_at_unix_ms: 11,
                last_opened_at_unix_ms: 22,
                pinned: true,
                available: false,
            }],
            paths: HashMap::from([(workspace_id.into(), r"E:\round-trip".into())]),
            agents: vec![AgentProfile {
                id: "ag-round-trip".into(), name: "Round Agent".into(), engine: "claude".into(),
                purpose: "round trip".into(), brief: "round trip".into(), avatar: None, created_at_unix_ms: 11, pinned: false, order: 0,
                memory_budget: None, reflection_mode: None, allow_agent_scheduling: None,
                allow_agent_messaging: None, default_mode: None, default_plan: None, default_model: None,
                default_provider_options: vec![], place_display_names: vec![], disabled_plugin_ids: vec![],
            }],
            threads: vec![json!({ "id": thread_id, "createdAtUnixMs": 11, "updatedAtUnixMs": 33, "title": "kept" })],
            last_provider: "claude".into(),
            grid: json!({ "cols": 2 }),
            revision: 4,
            routines: vec![json!({ "id": routine_id, "enabled": true, "name": "once" })],
            notifications: vec![json!({ "id": notification_id, "isRead": false, "createdAtUnixMs": 44 })],
        };

        write_disk_state(&mut conn, &state).unwrap();

        let (name, folder, pinned, available): (String, String, i64, i64) = conn
            .query_row(
                "SELECT display_name, folder_path, pinned, available FROM workspaces WHERE id = ?1",
                [workspace_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(name, "Round Trip");
        assert_eq!(folder, r"E:\round-trip");
        assert_eq!(pinned, 1);
        assert_eq!(available, 0);

        let (data, created, updated): (String, i64, i64) = conn
            .query_row(
                "SELECT data, created_at_unix_ms, updated_at_unix_ms FROM threads WHERE id = ?1",
                [thread_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        let parsed: Value = serde_json::from_str(&data).unwrap();
        assert_eq!(parsed["id"], thread_id);
        assert_eq!(parsed["title"], "kept");
        assert_eq!(created, 11);
        assert_eq!(updated, 33);
        assert_eq!(count_where(&conn, "SELECT COUNT(*) FROM workspace_events WHERE kind = ?1", "delete"), 0);

        state.workspaces[0].display_name = "Still here".into();
        state.threads[0]["title"] = json!("renamed");
        write_disk_state(&mut conn, &state).unwrap();

        let renamed: String = conn
            .query_row(
                "SELECT data FROM threads WHERE id = ?1",
                [thread_id],
                |row| row.get(0),
            )
            .unwrap();
        let renamed: Value = serde_json::from_str(&renamed).unwrap();
        assert_eq!(renamed["title"], "renamed");
        assert_eq!(count_where(&conn, "SELECT COUNT(*) FROM threads WHERE id = ?1", thread_id), 1);
        assert_eq!(count_where(&conn, "SELECT COUNT(*) FROM workspace_events WHERE kind = ?1", "update"), 1);
        assert_eq!(count_where(&conn, "SELECT COUNT(*) FROM workspace_events WHERE kind = ?1", "delete"), 0);

        state.threads.clear();
        state.routines.clear();
        state.notifications.clear();
        write_disk_state(&mut conn, &state).unwrap();

        assert_eq!(count_where(&conn, "SELECT COUNT(*) FROM threads WHERE id = ?1", thread_id), 0);
        assert_eq!(count_where(&conn, "SELECT COUNT(*) FROM routines WHERE id = ?1", routine_id), 0);
        assert_eq!(count_where(&conn, "SELECT COUNT(*) FROM notifications WHERE id = ?1", notification_id), 0);
        let routine_total: i64 = conn.query_row("SELECT COUNT(*) FROM routines", [], |row| row.get(0)).unwrap();
        let notification_total: i64 = conn
            .query_row("SELECT COUNT(*) FROM notifications", [], |row| row.get(0))
            .unwrap();
        assert_eq!(routine_total, 0);
        assert_eq!(notification_total, 0);

        let (name_after, workspace_total): (String, i64) = conn
            .query_row(
                "SELECT display_name, (SELECT COUNT(*) FROM workspaces) FROM workspaces WHERE id = ?1",
                [workspace_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(name_after, "Still here");
        assert_eq!(workspace_total, 1);
        assert_eq!(count_where(&conn, "SELECT COUNT(*) FROM workspace_events WHERE kind = ?1", "delete"), 0);
        assert_eq!(count_where(&conn, "SELECT COUNT(*) FROM workspace_events WHERE kind = ?1", "update"), 1);
        let agent_name: String = conn
            .query_row(
                "SELECT name FROM agents WHERE id = 'ag-round-trip'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(agent_name, "Round Agent");

        write_disk_state(&mut conn, &state).unwrap();
        assert_eq!(count_where(&conn, "SELECT COUNT(*) FROM workspace_events WHERE kind = ?1", "update"), 1);
        assert_eq!(count_where(&conn, "SELECT COUNT(*) FROM workspace_events WHERE kind = ?1", "delete"), 0);

        assert_eq!(app_value(&conn, "lastProvider"), "claude");
        assert_eq!(app_value(&conn, "revision"), "4");
        assert_eq!(app_value(&conn, "routinesSeeded"), "1");
        assert_eq!(app_value(&conn, "notificationsSeeded"), "1");
        let grid: Value = serde_json::from_str(&app_value(&conn, "grid")).unwrap();
        assert_eq!(grid["cols"], 2);
    }
}

