use std::fmt;

/// Unified error type for the `kite-ctx` context optimization engine.
#[derive(Debug)]
pub enum CtxError {
    Io(std::io::Error),
    Sqlite(rusqlite::Error),
    Json(serde_json::Error),
    InvalidInput(String),
    NotFound(String),
}

pub type Result<T> = std::result::Result<T, CtxError>;

impl fmt::Display for CtxError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(err) => write!(f, "I/O error: {err}"),
            Self::Sqlite(err) => write!(f, "SQLite error: {err}"),
            Self::Json(err) => write!(f, "JSON error: {err}"),
            Self::InvalidInput(msg) => write!(f, "Invalid input: {msg}"),
            Self::NotFound(msg) => write!(f, "Not found: {msg}"),
        }
    }
}

impl std::error::Error for CtxError {}

impl From<std::io::Error> for CtxError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<rusqlite::Error> for CtxError {
    fn from(value: rusqlite::Error) -> Self {
        Self::Sqlite(value)
    }
}

impl From<serde_json::Error> for CtxError {
    fn from(value: serde_json::Error) -> Self {
        Self::Json(value)
    }
}
