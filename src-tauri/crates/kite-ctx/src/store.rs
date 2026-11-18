use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::Connection;

use crate::error::Result;

/// Environment override used by tests and isolated callers for the SQLite database path.
pub const ENV_DB_PATH: &str = "KITE_CTX_DB_PATH";

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
        configure_connection(&conn)?;
        init_schema(&conn)?;
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
        configure_connection(&conn)?;
        init_schema(&conn)?;
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

fn configure_connection(conn: &Connection) -> Result<()> {
    conn.busy_timeout(Duration::from_secs(5))?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA foreign_keys = ON;",
    )?;
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
            total_cached_tokens INTEGER NOT NULL
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
        ",
    )?;
    Ok(())
}
