use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::Connection;

use crate::error::Result;

/// Environment override used by tests and isolated callers for the SQLite database path.
pub const ENV_DB_PATH: &str = "KITE_CTX_DB_PATH";

/// Current SQLite schema revision tracked via `PRAGMA user_version` to skip redundant DDL.
pub const CURRENT_SCHEMA_VERSION: i64 = 3;

/// Default path under `~/.kite/ctx/store.db`.
pub fn default_db_path() -> PathBuf {
    if let Ok(override_path) = std::env::var(ENV_DB_PATH) {
        let trimmed = override_path.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }

    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
        .filter(|v| !v.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);

    home.join(".kite").join("ctx").join("store.db")
}

/// Current UNIX timestamp in seconds.
pub fn now_unix_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

/// Shared SQLite persistence layer backing CCR, read deduplication, shared handoffs,
/// KV-prefix tracking, and token-savings telemetry.
#[derive(Clone)]
pub struct ContextStore {
    conn: Arc<Mutex<Connection>>,
    path: Option<PathBuf>,
}

impl ContextStore {
    /// Open or initialize the SQLite database at the given path.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path_ref = path.as_ref();
        if let Some(parent) = path_ref.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)?;
            }
        }
        let conn = Connection::open(path_ref)?;
        ensure_initialized(&conn, false)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            path: Some(path_ref.to_path_buf()),
        })
    }

    /// Open the default database (`KITE_CTX_DB_PATH` or `~/.kite/ctx/store.db`).
    pub fn open_default() -> Result<Self> {
        Self::open(default_db_path())
    }

    /// Open an isolated in-memory database (useful for tests).
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        ensure_initialized(&conn, true)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            path: None,
        })
    }

    pub fn db_path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// Execute a closure with exclusive access to the underlying SQLite connection.
    pub fn with_conn<F, T>(&self, f: F) -> Result<T>
    where
        F: FnOnce(&mut Connection) -> Result<T>,
    {
        let mut guard = self
            .conn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        f(&mut guard)
    }
}

fn ensure_initialized(conn: &Connection, is_memory: bool) -> Result<()> {
    conn.busy_timeout(Duration::from_secs(5))?;
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap_or(0);
    if is_memory || version < CURRENT_SCHEMA_VERSION {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA foreign_keys = ON;",
        )?;
        init_schema(conn)?;
        migrate_schema(conn)?;
        conn.execute_batch(&format!("PRAGMA user_version = {CURRENT_SCHEMA_VERSION};"))?;
    } else {
        conn.execute_batch(
            "PRAGMA synchronous = NORMAL;
             PRAGMA foreign_keys = ON;",
        )?;
    }
    Ok(())
}

fn has_column(conn: &Connection, table: &str, col_name: &str) -> bool {
    let sql = format!("PRAGMA table_info({table})");
    let Ok(mut stmt) = conn.prepare(&sql) else {
        return false;
    };
    let Ok(mut rows) = stmt.query([]) else {
        return false;
    };
    while let Ok(Some(row)) = rows.next() {
        if let Ok(name) = row.get::<_, String>(1) {
            if name == col_name {
                return true;
            }
        }
    }
    false
}

fn migrate_schema(conn: &Connection) -> Result<()> {
    if !has_column(conn, "kv_sessions", "prefix_hits") {
        conn.execute(
            "ALTER TABLE kv_sessions ADD COLUMN prefix_hits INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }
    // Virtual FTS5 table with Porter stemming + Unicode tokenizer for chunked CCR search.
    let _ = conn.execute_batch(
        "CREATE VIRTUAL TABLE IF NOT EXISTS ccr_chunks_fts USING fts5(
            hash UNINDEXED,
            line_start UNINDEXED,
            line_end UNINDEXED,
            content,
            tokenize='porter unicode61'
        );",
    );
    Ok(())
}

fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS ccr_entries (
            hash TEXT PRIMARY KEY,
            original_text TEXT NOT NULL,
            compressed_preview TEXT NOT NULL,
            strategy TEXT NOT NULL,
            tool_name TEXT NOT NULL,
            original_tokens INTEGER NOT NULL,
            compressed_tokens INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            last_accessed_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ccr_expires ON ccr_entries(expires_at);
        CREATE INDEX IF NOT EXISTS idx_ccr_lru ON ccr_entries(last_accessed_at);

        CREATE TABLE IF NOT EXISTS read_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            canonical_path TEXT NOT NULL,
            sha256 TEXT NOT NULL,
            mode TEXT NOT NULL,
            line_start INTEGER NOT NULL,
            line_end INTEGER NOT NULL,
            turn_index INTEGER NOT NULL,
            status TEXT NOT NULL,
            ccr_hash TEXT,
            content_snapshot TEXT NOT NULL,
            tokens INTEGER NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_read_session_path
            ON read_records(session_id, canonical_path, id DESC);

        CREATE TABLE IF NOT EXISTS shared_entries (
            scope TEXT NOT NULL,
            scope_id TEXT NOT NULL,
            key_name TEXT NOT NULL,
            source_agent TEXT NOT NULL,
            source_provider TEXT NOT NULL,
            compressed_text TEXT NOT NULL,
            ccr_hash TEXT NOT NULL,
            original_tokens INTEGER NOT NULL,
            compressed_tokens INTEGER NOT NULL,
            transforms_json TEXT NOT NULL,
            tree_hash TEXT,
            created_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            PRIMARY KEY (scope, scope_id, key_name)
        );
        CREATE INDEX IF NOT EXISTS idx_shared_expires ON shared_entries(expires_at);

        CREATE TABLE IF NOT EXISTS tool_cache (
            cache_key TEXT PRIMARY KEY,
            workspace_root TEXT NOT NULL,
            tree_hash TEXT NOT NULL,
            tool_name TEXT NOT NULL,
            args_hash TEXT NOT NULL,
            compressed_output TEXT NOT NULL,
            ccr_hash TEXT,
            raw_tokens INTEGER NOT NULL,
            compressed_tokens INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_tool_cache_tree ON tool_cache(workspace_root, tree_hash);

        CREATE TABLE IF NOT EXISTS kv_sessions (
            session_id TEXT PRIMARY KEY,
            provider TEXT NOT NULL,
            frozen_message_count INTEGER NOT NULL,
            last_prefix_hash TEXT NOT NULL,
            last_turn_at INTEGER NOT NULL,
            total_cached_tokens INTEGER NOT NULL,
            prefix_hits INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS ledger_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            agent TEXT NOT NULL,
            provider TEXT NOT NULL,
            model TEXT NOT NULL,
            category TEXT NOT NULL,
            command_or_tool TEXT NOT NULL,
            raw_tokens INTEGER NOT NULL,
            compressed_tokens INTEGER NOT NULL,
            tokens_saved INTEGER NOT NULL,
            cache_hit INTEGER NOT NULL,
            overhead_ms INTEGER NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ledger_created ON ledger_events(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_ledger_session ON ledger_events(session_id);

        CREATE TABLE IF NOT EXISTS browser_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            tab_id TEXT NOT NULL,
            origin TEXT NOT NULL,
            canonical_route TEXT NOT NULL,
            full_hash TEXT NOT NULL,
            structure_hash TEXT NOT NULL,
            chrome_hash TEXT,
            turn_index INTEGER NOT NULL,
            status TEXT NOT NULL,
            ccr_hash TEXT,
            nodes_json TEXT NOT NULL,
            tokens INTEGER NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_browser_snapshots_lookup
            ON browser_snapshots(session_id, tab_id, origin, canonical_route, id DESC);

        CREATE TABLE IF NOT EXISTS browser_chrome (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            origin TEXT NOT NULL,
            landmark_role TEXT NOT NULL,
            chrome_hash TEXT NOT NULL,
            ccr_hash TEXT,
            compact_text TEXT NOT NULL,
            summary_label TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(session_id, origin, landmark_role)
        );

        CREATE TABLE IF NOT EXISTS browser_recipes (
            recipe_key TEXT PRIMARY KEY,
            origin TEXT NOT NULL,
            route_pattern TEXT NOT NULL,
            structure_hash TEXT NOT NULL,
            landmark_keys_json TEXT NOT NULL,
            intent TEXT NOT NULL,
            steps_json TEXT NOT NULL,
            success_count INTEGER NOT NULL DEFAULT 0,
            failure_count INTEGER NOT NULL DEFAULT 0,
            consecutive_failures INTEGER NOT NULL DEFAULT 0,
            quarantined INTEGER NOT NULL DEFAULT 0,
            last_verified_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_browser_recipes_origin_route
            ON browser_recipes(origin, route_pattern, quarantined);
        ",
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_v2_database_to_v3_without_losing_existing_data() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("legacy_v2.db");

        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute_batch(
                "
                PRAGMA user_version = 2;
                CREATE TABLE ccr_entries (
                    hash TEXT PRIMARY KEY,
                    original_text TEXT NOT NULL,
                    compressed_preview TEXT NOT NULL,
                    strategy TEXT NOT NULL,
                    tool_name TEXT NOT NULL,
                    original_tokens INTEGER NOT NULL,
                    compressed_tokens INTEGER NOT NULL,
                    created_at INTEGER NOT NULL,
                    last_accessed_at INTEGER NOT NULL,
                    expires_at INTEGER NOT NULL
                );
                INSERT INTO ccr_entries VALUES (
                    'abc12345', 'full payload', 'preview', 'auto_ccr', 'test', 100, 10, 1, 1, 9999999999
                );
                CREATE TABLE kv_sessions (
                    session_id TEXT PRIMARY KEY,
                    provider TEXT NOT NULL,
                    frozen_message_count INTEGER NOT NULL,
                    last_prefix_hash TEXT NOT NULL,
                    last_turn_at INTEGER NOT NULL,
                    total_cached_tokens INTEGER NOT NULL,
                    prefix_hits INTEGER NOT NULL DEFAULT 0
                );
                INSERT INTO kv_sessions VALUES ('s1', 'anthropic', 3, 'h1', 100, 500, 2);
                ",
            )
            .unwrap();
        }

        let store = ContextStore::open(&db_path).unwrap();
        store
            .with_conn(|conn| {
                let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
                assert_eq!(version, CURRENT_SCHEMA_VERSION);
                assert_eq!(version, 3);

                let ccr_text: String = conn.query_row(
                    "SELECT original_text FROM ccr_entries WHERE hash = 'abc12345'",
                    [],
                    |r| r.get(0),
                )?;
                assert_eq!(ccr_text, "full payload");

                let prefix_hits: i64 = conn.query_row(
                    "SELECT prefix_hits FROM kv_sessions WHERE session_id = 's1'",
                    [],
                    |r| r.get(0),
                )?;
                assert_eq!(prefix_hits, 2);

                let table_count: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN (
                        'browser_snapshots', 'browser_chrome', 'browser_recipes'
                    )",
                    [],
                    |r| r.get(0),
                )?;
                assert_eq!(table_count, 3);
                Ok(())
            })
            .unwrap();
    }
}
