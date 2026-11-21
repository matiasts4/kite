use crate::logger::log_trace;
use rusqlite::{params, Connection, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

static PERSIST_CALLS: AtomicU64 = AtomicU64::new(0);
static SQLITE_FLUSH_COUNT: AtomicU64 = AtomicU64::new(0);
static STORES_INITIALIZED: AtomicBool = AtomicBool::new(false);

const WAL_CHECKPOINT_CADENCE: u64 = 32;
const WAL_TRUNCATE_THRESHOLD_BYTES: u64 = 4 * 1024 * 1024;

#[cfg(test)]
pub fn persist_calls_count() -> u64 {
    PERSIST_CALLS.load(Ordering::Relaxed)
}

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

#[cfg(test)]
pub(crate) fn is_isolated_test_appdata(raw: &str) -> bool {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return false;
    }
    let norm = trimmed.to_ascii_lowercase().replace('\\', "/");
    let norm_trimmed = norm.trim_end_matches('/');
    let temp_norm = std::env::temp_dir()
        .to_string_lossy()
        .to_ascii_lowercase()
        .replace('\\', "/");
    let temp_trimmed = temp_norm.trim_end_matches('/');
    (!temp_trimmed.is_empty() && norm_trimmed.starts_with(temp_trimmed))
        || norm_trimmed.contains("f5-routines-test")
        || norm_trimmed.contains("kite-test")
        || norm_trimmed.contains("kite-cargo-test")
        || !norm_trimmed.ends_with("/appdata/roaming")
}

#[cfg(test)]
pub(crate) fn resolve_test_roaming_app_dir(appdata: Option<&str>, fallback: &Path) -> PathBuf {
    if let Some(raw) = appdata.filter(|raw| is_isolated_test_appdata(raw)) {
        return PathBuf::from(raw).join(app_data_folder());
    }
    fallback.join(app_data_folder())
}

pub fn roaming_app_dir() -> PathBuf {
    #[cfg(test)]
    {
        static TEST_APPDATA_ROOT: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
        let fallback = TEST_APPDATA_ROOT.get_or_init(|| {
            let dir = std::env::temp_dir().join(format!(
                "kite-cargo-test-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4().simple()
            ));
            let _ = fs::create_dir_all(&dir);
            dir
        });
        let appdata = std::env::var("APPDATA").ok();
        return resolve_test_roaming_app_dir(appdata.as_deref(), fallback);
    }
    #[cfg(not(test))]
    {
        let base = std::env::var("APPDATA")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                std::env::var("USERPROFILE")
                    .or_else(|_| std::env::var("HOME"))
                    .ok()
                    .filter(|v| !v.trim().is_empty())
                    .map(|home| PathBuf::from(home).join("AppData").join("Roaming"))
                    .unwrap_or_else(|| std::env::temp_dir().join("kite-appdata"))
            });
        base.join(app_data_folder())
    }
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
            default_mode: Some("fullAccess".into()),
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
            default_mode: Some("fullAccess".into()),
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
    pub last_model: Option<String>,
    pub last_effort: Option<String>,
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

pub(crate) fn configure_sqlite_pragmas(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA busy_timeout = 5000;
         PRAGMA cache_size = -8000;
         PRAGMA wal_autocheckpoint = 1000;",
    )
}

fn wal_path_for_db(db_file: &Path) -> PathBuf {
    PathBuf::from(format!("{}-wal", db_file.display()))
}

pub(crate) fn checkpoint_wal_on_conn(
    conn: &Connection,
    wal_path: Option<&Path>,
    force_truncate: bool,
) -> Result<(i64, i64, i64), rusqlite::Error> {
    let should_truncate = force_truncate
        || wal_path
            .and_then(|p| fs::metadata(p).ok())
            .is_some_and(|m| m.len() >= WAL_TRUNCATE_THRESHOLD_BYTES);
    let sql = if should_truncate {
        "PRAGMA wal_checkpoint(TRUNCATE)"
    } else {
        "PRAGMA wal_checkpoint(PASSIVE)"
    };
    conn.query_row(sql, [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
}

fn maybe_checkpoint_wal(conn: &Connection) {
    let flush_num = SQLITE_FLUSH_COUNT.fetch_add(1, Ordering::Relaxed) + 1;
    let wal_path = wal_path_for_db(&db_path());
    let wal_exceeded = fs::metadata(&wal_path)
        .ok()
        .is_some_and(|m| m.len() >= WAL_TRUNCATE_THRESHOLD_BYTES);
    if flush_num % WAL_CHECKPOINT_CADENCE == 0 || wal_exceeded {
        if let Err(error) = checkpoint_wal_on_conn(conn, Some(&wal_path), wal_exceeded) {
            log_trace(&format!("WAL checkpoint failed: {error}"));
        }
    }
}

pub fn is_daemon_process() -> bool {
    static IS_DAEMON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *IS_DAEMON.get_or_init(|| {
        std::env::args()
            .nth(1)
            .is_some_and(|arg| arg == "daemon" || arg == "--daemon" || arg == "kite-core")
    })
}

fn open_connection() -> Connection {
    let p = db_path();
    if let Some(parent) = p.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let conn = Connection::open(&p).expect("failed to open studio.sqlite");
    configure_sqlite_pragmas(&conn).expect("failed to configure sqlite pragmas");
    conn.execute_batch(SCHEMA_SQL)
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
        last_model: None,
        last_effort: None,
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

const AGENT_COLUMNS_SQL: &str = "id, name, engine, purpose, avatar, created_at_unix_ms, pinned, sort_order, memory_budget, reflection_mode, allow_agent_scheduling, allow_agent_messaging, default_mode, default_plan, default_model, brief, default_provider_options, place_display_names, disabled_plugin_ids";

fn map_agent_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentProfile> {
    let purpose: String = row.get(3)?;
    let brief: String = row
        .get::<_, Option<String>>(15)
        .ok()
        .flatten()
        .unwrap_or_else(|| purpose.clone());
    let default_plan_str: Option<String> = row.get(13).ok();
    let default_plan = default_plan_str.map(|s| s == "true" || s == "1");
    let default_provider_options: Vec<Value> = row
        .get::<_, Option<String>>(16)
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let place_display_names: Vec<String> = row
        .get::<_, Option<String>>(17)
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let disabled_plugin_ids: Vec<String> = row
        .get::<_, Option<String>>(18)
        .ok()
        .flatten()
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
}

pub(crate) fn read_workspaces_from_conn(
    conn: &Connection,
) -> Result<(Vec<Workspace>, HashMap<String, String>), rusqlite::Error> {
    let mut ws_stmt = conn.prepare(
        "SELECT id, display_name, folder_path, created_at_unix_ms, last_opened_at_unix_ms, pinned
         FROM workspaces ORDER BY sort_order ASC",
    )?;
    let ws_rows = ws_stmt.query_map([], |row| {
        let id: String = row.get(0)?;
        let display_name: String = row.get(1)?;
        let folder_path: String = row.get(2)?;
        let created_at_unix_ms: i64 = row.get(3)?;
        let last_opened_at_unix_ms: i64 = row.get(4)?;
        let pinned: bool = row.get::<_, i64>(5)? != 0;
        let available = Path::new(&folder_path).is_dir();
        Ok((
            Workspace {
                id: id.clone(),
                display_name,
                created_at_unix_ms,
                last_opened_at_unix_ms,
                pinned,
                available,
            },
            id,
            folder_path,
        ))
    })?;

    let mut workspaces = Vec::new();
    let mut paths = HashMap::new();
    for row in ws_rows.flatten() {
        workspaces.push(row.0);
        paths.insert(row.1, row.2);
    }
    Ok((workspaces, paths))
}

pub(crate) fn read_workspace_path_from_conn(conn: &Connection, id: &str) -> Option<String> {
    conn.query_row(
        "SELECT folder_path FROM workspaces WHERE id = ?1",
        params![id],
        |row| row.get::<_, String>(0),
    )
    .ok()
    .filter(|p| !p.is_empty())
}

pub(crate) fn read_agents_from_conn(conn: &Connection) -> Result<Vec<AgentProfile>, rusqlite::Error> {
    let sql = format!("SELECT {AGENT_COLUMNS_SQL} FROM agents ORDER BY sort_order ASC");
    let mut ag_stmt = conn.prepare(&sql)?;
    let ag_rows = ag_stmt.query_map([], map_agent_row)?;
    Ok(ag_rows.flatten().collect())
}

pub(crate) fn read_agent_by_id_from_conn(conn: &Connection, id: &str) -> Option<AgentProfile> {
    let sql = format!("SELECT {AGENT_COLUMNS_SQL} FROM agents WHERE id = ?1 LIMIT 1");
    conn.query_row(&sql, params![id], map_agent_row).ok()
}

pub fn load_agents_direct() -> Vec<AgentProfile> {
    let conn = db_connection().lock().unwrap();
    read_agents_from_conn(&conn).unwrap_or_default()
}

pub fn load_agent_by_id_direct(id: &str) -> Option<AgentProfile> {
    let conn = db_connection().lock().unwrap();
    read_agent_by_id_from_conn(&conn, id)
}

pub fn load_workspaces_direct() -> Vec<Workspace> {
    let conn = db_connection().lock().unwrap();
    read_workspaces_from_conn(&conn)
        .map(|(workspaces, _)| workspaces)
        .unwrap_or_default()
}

pub fn load_workspace_path_direct(id: &str) -> Option<String> {
    let conn = db_connection().lock().unwrap();
    read_workspace_path_from_conn(&conn, id)
}

pub fn find_agent_by_id(id: &str) -> Option<AgentProfile> {
    if is_daemon_process() {
        return load_agent_by_id_direct(id);
    }
    agents().lock().ok()?.iter().find(|a| a.id == id).cloned()
}

pub fn list_agents_snapshot() -> Vec<AgentProfile> {
    if is_daemon_process() {
        return load_agents_direct();
    }
    agents().lock().map(|g| g.clone()).unwrap_or_default()
}

pub fn list_workspaces_snapshot() -> Vec<Workspace> {
    if is_daemon_process() {
        return load_workspaces_direct();
    }
    workspaces().lock().map(|g| g.clone()).unwrap_or_default()
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
    let (workspaces, paths) =
        read_workspaces_from_conn(conn).expect("failed to query workspaces");
    let agents = read_agents_from_conn(conn).expect("failed to query agents");

    let mut th_stmt = conn.prepare("SELECT data FROM threads ORDER BY updated_at_unix_ms ASC").expect("failed to prepare threads query");
    let th_rows = th_stmt.query_map([], |row| {
        let data: String = row.get(0)?;
        Ok(serde_json::from_str::<Value>(&data).unwrap_or(Value::Null))
    }).expect("failed to query threads");
    let mut threads: Vec<Value> = th_rows.flatten().filter(|v| !v.is_null()).collect();
    let healed_thread_ids = heal_loaded_threads(&mut threads);

    let mut last_provider = "claude".to_string();
    let mut last_model: Option<String> = None;
    let mut last_effort: Option<String> = None;
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
            "lastModel" => last_model = if v.trim().is_empty() { None } else { Some(v) },
            "lastEffort" => last_effort = if v.trim().is_empty() { None } else { Some(v) },
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
        last_model,
        last_effort,
        grid,
        revision,
        routines,
        notifications,
    };
    seed_persisted_thread_revs(&state.threads, &healed_thread_ids);
    if seed_routines_now || seed_notifications_now || !healed_thread_ids.is_empty() {
        drop(th_stmt);
        drop(app_stmt);
        drop(rt_stmt);
        drop(notif_stmt);
        drop(conn_guard);
        save_disk_to_sqlite(&state);
    }
    state
}

fn heal_loaded_threads(threads: &mut [Value]) -> std::collections::HashSet<String> {
    let mut healed_ids = std::collections::HashSet::new();
    for thread in threads.iter_mut() {
        if crate::chat::runtime::post_reply::heal_persisted_connection_loss_after_reply(thread) {
            if let Some(id) = json_row_id(thread) {
                healed_ids.insert(id.to_string());
            }
        }
    }
    let pre_heal_statuses: std::collections::HashMap<String, String> = threads
        .iter()
        .filter_map(|t| {
            let id = json_row_id(t)?;
            let status = t.get("status").and_then(Value::as_str).unwrap_or("idle");
            Some((id.to_string(), status.to_string()))
        })
        .collect();
    let now = crate::chat::utils::now_ms();
    for thread in threads.iter_mut() {
        let mut healed_children = false;
        if let Some(runs) = thread.get_mut("subagentRuns").and_then(Value::as_array_mut) {
            for run in runs.iter_mut() {
                let cur = run.get("status").and_then(Value::as_str);
                if matches!(cur, Some("completed" | "failed" | "killed")) {
                    continue;
                }
                let Some(cid) = run
                    .get("childThreadId")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                else {
                    continue;
                };
                let next_status = match pre_heal_statuses.get(cid).map(String::as_str) {
                    Some("idle") => "completed",
                    Some("error") => "failed",
                    _ => "killed",
                };
                run["status"] = json!(next_status);
                run["updatedAtUnixMs"] = json!(now);
                if run.get("completedAtUnixMs").is_none_or(Value::is_null) {
                    run["completedAtUnixMs"] = json!(now);
                }
                healed_children = true;
            }
        }
        let healed_reconcile = crate::chat::subagents::needs_antigravity_transcript_reconcile(thread)
            && crate::chat::subagents::reconcile_antigravity_subagents_in_thread(thread, None, false)
                .changed;
        let healed_running =
            crate::chat::runtime::heal_orphaned_thread_with_options(thread, false, true);
        if healed_children || healed_reconcile || healed_running {
            if let Some(id) = json_row_id(thread) {
                healed_ids.insert(id.to_string());
            }
        }
    }
    healed_ids
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

fn sync_workspaces_slice(
    tx: &Transaction<'_>,
    workspaces: &[Workspace],
    paths: &HashMap<String, String>,
) -> Result<(), rusqlite::Error> {
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
    let mut ids = Vec::with_capacity(workspaces.len());
    for (index, workspace) in workspaces.iter().enumerate() {
        let folder = paths.get(&workspace.id).cloned().unwrap_or_default();
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

fn sync_workspaces(tx: &Transaction<'_>, state: &DiskState) -> Result<(), rusqlite::Error> {
    sync_workspaces_slice(tx, &state.workspaces, &state.paths)
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

type ThreadRevCache = HashMap<String, (String, i64)>;

fn thread_sync_stamp(thread: &Value) -> Option<(String, i64)> {
    let rev = thread
        .get("revision")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())?;
    let updated = thread.get("updatedAtUnixMs").and_then(Value::as_i64).unwrap_or(0);
    Some((rev.to_string(), updated))
}

fn persisted_thread_revs() -> &'static Mutex<ThreadRevCache> {
    static CELL: std::sync::OnceLock<Mutex<ThreadRevCache>> = std::sync::OnceLock::new();
    CELL.get_or_init(|| Mutex::new(HashMap::new()))
}

fn seed_persisted_thread_revs(threads: &[Value], skip_ids: &std::collections::HashSet<String>) {
    if let Ok(mut cache) = persisted_thread_revs().lock() {
        cache.clear();
        for thread in threads {
            if let (Some(id), Some(stamp)) = (json_row_id(thread), thread_sync_stamp(thread)) {
                if !skip_ids.contains(id) {
                    cache.insert(id.to_string(), stamp);
                }
            }
        }
    }
}

pub(crate) fn collect_dirty_threads(
    threads: &[Value],
    known_revs: &ThreadRevCache,
) -> (Vec<Value>, Vec<String>) {
    let mut dirty = Vec::new();
    let mut live_ids = Vec::with_capacity(threads.len());
    for thread in threads {
        let Some(id) = json_row_id(thread) else {
            continue;
        };
        live_ids.push(id.to_string());
        let is_clean = thread_sync_stamp(thread)
            .as_ref()
            .is_some_and(|stamp| known_revs.get(id) == Some(stamp));
        if !is_clean {
            dirty.push(thread.clone());
        }
    }
    (dirty, live_ids)
}

pub(crate) struct DirtyDiskSnapshot {
    pub workspaces: Vec<Workspace>,
    pub paths: HashMap<String, String>,
    pub agents: Vec<AgentProfile>,
    pub dirty_threads: Vec<Value>,
    pub live_thread_ids: Vec<String>,
    pub last_provider: String,
    pub last_model: Option<String>,
    pub last_effort: Option<String>,
    pub grid: Value,
    pub revision: u64,
    pub routines: Vec<Value>,
    pub notifications: Vec<Value>,
}

fn upsert_threads_into_tx(
    tx: &Transaction<'_>,
    threads: &[Value],
    mut rev_cache: Option<&mut ThreadRevCache>,
    live_ids_out: Option<&mut Vec<String>>,
) -> Result<usize, rusqlite::Error> {
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
    let mut serialized_count = 0usize;
    let mut collected_ids = live_ids_out;
    for thread in threads {
        let Some(id) = json_row_id(thread) else {
            continue;
        };
        if let Some(ids) = collected_ids.as_deref_mut() {
            ids.push(id.to_string());
        }
        let stamp = thread_sync_stamp(thread);
        if let (Some(cache), Some(stamp_val)) = (rev_cache.as_deref(), stamp.as_ref()) {
            if cache.get(id) == Some(stamp_val) {
                continue;
            }
        }
        let created = thread.get("createdAtUnixMs").and_then(Value::as_i64).unwrap_or(0);
        let updated = thread.get("updatedAtUnixMs").and_then(Value::as_i64).unwrap_or(0);
        let data = serde_json::to_string(thread).unwrap_or_default();
        stmt.execute(params![id, data, created, updated])?;
        serialized_count += 1;
        if let Some(cache) = rev_cache.as_deref_mut() {
            if let Some(stamp_val) = stamp {
                cache.insert(id.to_string(), stamp_val);
            } else {
                cache.remove(id);
            }
        }
    }
    Ok(serialized_count)
}

fn prune_absent_threads(
    tx: &Transaction<'_>,
    live_ids: &[String],
    rev_cache: Option<&mut ThreadRevCache>,
) -> Result<(), rusqlite::Error> {
    delete_absent(
        tx,
        "DELETE FROM threads WHERE id NOT IN (SELECT value FROM json_each(?1))",
        live_ids,
    )?;
    if let Some(cache) = rev_cache {
        let live_set: std::collections::HashSet<&str> = live_ids.iter().map(String::as_str).collect();
        cache.retain(|k, _| live_set.contains(k.as_str()));
    }
    Ok(())
}

fn sync_threads(
    tx: &Transaction<'_>,
    threads: &[Value],
    mut rev_cache: Option<&mut ThreadRevCache>,
) -> Result<usize, rusqlite::Error> {
    let mut ids = Vec::with_capacity(threads.len());
    let serialized_count =
        upsert_threads_into_tx(tx, threads, rev_cache.as_deref_mut(), Some(&mut ids))?;
    prune_absent_threads(tx, &ids, rev_cache)?;
    Ok(serialized_count)
}

fn sync_dirty_threads(
    tx: &Transaction<'_>,
    dirty_threads: &[Value],
    live_thread_ids: &[String],
    mut rev_cache: Option<&mut ThreadRevCache>,
) -> Result<usize, rusqlite::Error> {
    let serialized_count =
        upsert_threads_into_tx(tx, dirty_threads, rev_cache.as_deref_mut(), None)?;
    prune_absent_threads(tx, live_thread_ids, rev_cache)?;
    Ok(serialized_count)
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

fn sync_app_state_fields(
    tx: &Transaction<'_>,
    last_provider: &str,
    last_model: Option<&str>,
    last_effort: Option<&str>,
    grid: &Value,
    revision: u64,
) -> Result<(), rusqlite::Error> {
    let grid = serde_json::to_string(grid).unwrap_or_default();
    let revision = revision.to_string();
    let last_model_val = last_model.unwrap_or("");
    let last_effort_val = last_effort.unwrap_or("");
    let rows = [
        ("lastProvider", last_provider),
        ("lastModel", last_model_val),
        ("lastEffort", last_effort_val),
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

fn apply_disk_state(
    tx: &Transaction<'_>,
    state: &DiskState,
    rev_cache: Option<&mut ThreadRevCache>,
) -> Result<usize, rusqlite::Error> {
    sync_workspaces(tx, state)?;
    sync_agents(tx, &state.agents)?;
    let serialized_threads = sync_threads(tx, &state.threads, rev_cache)?;
    sync_routines(tx, &state.routines)?;
    sync_notifications(tx, &state.notifications)?;
    sync_app_state_fields(
        tx,
        &state.last_provider,
        state.last_model.as_deref(),
        state.last_effort.as_deref(),
        &state.grid,
        state.revision,
    )?;
    Ok(serialized_threads)
}

fn apply_dirty_disk_snapshot(
    tx: &Transaction<'_>,
    snapshot: &DirtyDiskSnapshot,
    rev_cache: Option<&mut ThreadRevCache>,
) -> Result<usize, rusqlite::Error> {
    sync_workspaces_slice(tx, &snapshot.workspaces, &snapshot.paths)?;
    sync_agents(tx, &snapshot.agents)?;
    let serialized_threads = sync_dirty_threads(
        tx,
        &snapshot.dirty_threads,
        &snapshot.live_thread_ids,
        rev_cache,
    )?;
    sync_routines(tx, &snapshot.routines)?;
    sync_notifications(tx, &snapshot.notifications)?;
    sync_app_state_fields(
        tx,
        &snapshot.last_provider,
        snapshot.last_model.as_deref(),
        snapshot.last_effort.as_deref(),
        &snapshot.grid,
        snapshot.revision,
    )?;
    Ok(serialized_threads)
}

pub(crate) fn write_disk_state_with_cache(
    conn: &mut Connection,
    state: &DiskState,
    rev_cache: Option<&mut ThreadRevCache>,
) -> Result<usize, rusqlite::Error> {
    let mut staged_cache = rev_cache.as_deref().cloned();
    let tx = conn.transaction()?;
    let serialized_threads = apply_disk_state(&tx, state, staged_cache.as_mut())?;
    tx.commit()?;
    if let (Some(cache), Some(staged)) = (rev_cache, staged_cache) {
        *cache = staged;
    }
    Ok(serialized_threads)
}

pub(crate) fn write_dirty_disk_state_with_cache(
    conn: &mut Connection,
    snapshot: &DirtyDiskSnapshot,
    rev_cache: Option<&mut ThreadRevCache>,
) -> Result<usize, rusqlite::Error> {
    let mut staged_cache = rev_cache.as_deref().cloned();
    let tx = conn.transaction()?;
    let serialized_threads = apply_dirty_disk_snapshot(&tx, snapshot, staged_cache.as_mut())?;
    tx.commit()?;
    if let (Some(cache), Some(staged)) = (rev_cache, staged_cache) {
        *cache = staged;
    }
    Ok(serialized_threads)
}

#[allow(dead_code)]
fn write_disk_state(conn: &mut Connection, state: &DiskState) -> Result<(), rusqlite::Error> {
    write_disk_state_with_cache(conn, state, None).map(|_| ())
}

pub fn save_disk_to_sqlite(state: &DiskState) {
    let mut conn_guard = db_connection().lock().unwrap();
    let mut rev_guard = persisted_thread_revs().lock().unwrap();
    if let Err(error) = write_disk_state_with_cache(&mut conn_guard, state, Some(&mut rev_guard)) {
        log_trace(&format!("Failed to commit sqlite transaction: {error}"));
    } else {
        maybe_checkpoint_wal(&conn_guard);
    }
}

fn save_dirty_disk_to_sqlite(snapshot: &DirtyDiskSnapshot) {
    let mut conn_guard = db_connection().lock().unwrap();
    let mut rev_guard = persisted_thread_revs().lock().unwrap();
    if let Err(error) =
        write_dirty_disk_state_with_cache(&mut conn_guard, snapshot, Some(&mut rev_guard))
    {
        log_trace(&format!("Failed to commit sqlite transaction: {error}"));
    } else {
        maybe_checkpoint_wal(&conn_guard);
    }
}

struct PersistStores {
    workspaces: Mutex<Vec<Workspace>>,
    paths: Mutex<HashMap<String, String>>,
    agents: Mutex<Vec<AgentProfile>>,
    threads: Mutex<Vec<Value>>,
    last_provider: Mutex<String>,
    last_model: Mutex<Option<String>>,
    last_effort: Mutex<Option<String>>,
    grid: Mutex<Value>,
    revision: Mutex<u64>,
    routines: Mutex<Vec<Value>>,
    notifications: Mutex<Vec<Value>>,
}

fn stores() -> &'static PersistStores {
    static STORES: std::sync::OnceLock<PersistStores> = std::sync::OnceLock::new();
    STORES.get_or_init(|| {
        let state = load_or_migrate_sqlite();
        STORES_INITIALIZED.store(true, Ordering::Relaxed);
        PersistStores {
            workspaces: Mutex::new(state.workspaces),
            paths: Mutex::new(state.paths),
            agents: Mutex::new(state.agents),
            threads: Mutex::new(state.threads),
            last_provider: Mutex::new(state.last_provider),
            last_model: Mutex::new(state.last_model),
            last_effort: Mutex::new(state.last_effort),
            grid: Mutex::new(state.grid),
            revision: Mutex::new(state.revision),
            routines: Mutex::new(state.routines),
            notifications: Mutex::new(state.notifications),
        }
    })
}

#[cfg(test)]
pub(crate) fn stores_initialized() -> bool {
    STORES_INITIALIZED.load(Ordering::Relaxed)
}

pub fn initial_state() {
    let _ = stores();
}

pub fn workspaces() -> &'static Mutex<Vec<Workspace>> {
    &stores().workspaces
}

pub fn paths() -> &'static Mutex<HashMap<String, String>> {
    &stores().paths
}

pub fn agents() -> &'static Mutex<Vec<AgentProfile>> {
    &stores().agents
}

pub fn threads() -> &'static Mutex<Vec<Value>> {
    &stores().threads
}

pub fn last_provider() -> &'static Mutex<String> {
    &stores().last_provider
}

pub fn last_model() -> &'static Mutex<Option<String>> {
    &stores().last_model
}

pub fn last_effort() -> &'static Mutex<Option<String>> {
    &stores().last_effort
}

pub fn grid_slot() -> &'static Mutex<Value> {
    &stores().grid
}

pub fn revision_counter() -> &'static Mutex<u64> {
    &stores().revision
}

pub fn routines() -> &'static Mutex<Vec<Value>> {
    &stores().routines
}

pub fn notifications() -> &'static Mutex<Vec<Value>> {
    &stores().notifications
}

fn snapshot_dirty_disk_state() -> DirtyDiskSnapshot {
    // CRITICAL: Lock, clone, and drop each mutex in its own separate statement.
    // Never construct `DirtyDiskSnapshot { workspaces: workspaces().lock()..., threads: threads().lock()... }`
    // inline, because Rust keeps all temporary MutexGuards alive until the terminating semicolon,
    // which holds all mutexes simultaneously and creates AB-BA deadlocks with callers that hold
    // `threads()` while querying `paths()`, `last_provider()`, `last_model()`, or `revision_counter()`.
    let known_revs = persisted_thread_revs().lock().unwrap().clone();
    let workspaces = workspaces().lock().unwrap().clone();
    let paths = paths().lock().unwrap().clone();
    let agents = agents().lock().unwrap().clone();
    let (dirty_threads, live_thread_ids) = {
        let threads_guard = threads().lock().unwrap();
        collect_dirty_threads(&threads_guard, &known_revs)
    };
    let last_provider = last_provider().lock().unwrap().clone();
    let last_model = last_model().lock().unwrap().clone();
    let last_effort = last_effort().lock().unwrap().clone();
    let grid = grid_slot().lock().unwrap().clone();
    let revision = *revision_counter().lock().unwrap();
    let routines = routines().lock().unwrap().clone();
    let notifications = notifications().lock().unwrap().clone();
    DirtyDiskSnapshot {
        workspaces,
        paths,
        agents,
        dirty_threads,
        live_thread_ids,
        last_provider,
        last_model,
        last_effort,
        grid,
        revision,
        routines,
        notifications,
    }
}

pub fn persist() {
    PERSIST_CALLS.fetch_add(1, Ordering::Relaxed);
    let snapshot = snapshot_dirty_disk_state();
    save_dirty_disk_to_sqlite(&snapshot);
}

/// Schedules a coalesced background SQLite flush for high-frequency mid-turn updates
/// (such as streaming tool completions and background git diff line counts) so neither
/// the transport pump thread nor the diff worker stalls on synchronous disk I/O.
pub fn persist_async() {
    static WORKER: std::sync::OnceLock<std::sync::Arc<(Mutex<bool>, std::sync::Condvar)>> =
        std::sync::OnceLock::new();
    let pair = WORKER.get_or_init(|| {
        let pair = std::sync::Arc::new((Mutex::new(false), std::sync::Condvar::new()));
        let worker_pair = std::sync::Arc::clone(&pair);
        let _ = std::thread::Builder::new()
            .name("kite-persist-worker".to_string())
            .spawn(move || {
                let (lock, cv) = &*worker_pair;
                loop {
                    let mut dirty = lock.lock().unwrap();
                    while !*dirty {
                        dirty = cv.wait(dirty).unwrap();
                    }
                    drop(dirty);
                    std::thread::sleep(std::time::Duration::from_millis(120));
                    {
                        let mut d = lock.lock().unwrap();
                        *d = false;
                    }
                    persist();
                }
            });
        pair
    });
    let (lock, cv) = &**pair;
    let mut dirty = lock.lock().unwrap();
    if !*dirty {
        *dirty = true;
        cv.notify_one();
    }
}

pub fn next_revision() -> String {
    let mut counter = revision_counter().lock().unwrap();
    *counter = counter.saturating_add(1);
    format!("{:064x}", *counter)
}

pub fn workspace_path(id: &str) -> Option<String> {
    if is_daemon_process() {
        return load_workspace_path_direct(id);
    }
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

pub fn app_state_get(key: &str) -> Option<String> {
    db_connection()
        .lock()
        .unwrap()
        .query_row(
            "SELECT value FROM app_state WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .ok()
}

pub fn app_state_set_checked(key: &str, value: &str) -> Result<(), rusqlite::Error> {
    db_connection().lock().unwrap().execute(
        "INSERT INTO app_state (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

pub fn app_state_set(key: &str, value: &str) {
    let _ = app_state_set_checked(key, value);
}

#[cfg(test)]
#[path = "persist_tests.rs"]
mod tests;

