//! Dispatch audit logging and historical message import.

use serde_json::Value;

use crate::dispatch::audit::{import_agent_messages, AuditRow};
use crate::dispatch::types::{Caller, Receipt};

use super::protocol::{import_marker, now_ms};

pub fn record_audit(receipt: &Receipt, body: &str, caller: Caller) {
    if receipt.replayed {
        return;
    }
    let row = AuditRow {
        id: receipt.id.clone(),
        op: receipt.op.clone(),
        address: receipt.address.clone(),
        body: body.to_string(),
        status: format!("{:?}", receipt.status).to_lowercase(),
        submitted: receipt.submitted,
        historical: false,
        sender_name: match caller {
            Caller::Human => "Builder".into(),
            Caller::Agent => "Agent".into(),
            Caller::Script => "Script".into(),
        },
        profile_id: receipt
            .address
            .strip_prefix("agent:")
            .unwrap_or("")
            .to_string(),
        created_ms: now_ms(),
    };
    let _ = insert_audit(&row);
}

pub fn audit_db() -> Option<rusqlite::Connection> {
    let path = crate::persist::db_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let conn = rusqlite::Connection::open(path).ok()?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS dispatch_audit (
            id TEXT PRIMARY KEY,
            op TEXT NOT NULL,
            address TEXT NOT NULL,
            body TEXT NOT NULL,
            status TEXT NOT NULL,
            submitted INTEGER NOT NULL,
            historical INTEGER NOT NULL,
            sender_name TEXT NOT NULL,
            profile_id TEXT NOT NULL,
            error TEXT,
            created_ms INTEGER NOT NULL
        );",
    )
    .ok()?;
    Some(conn)
}

pub fn insert_audit(row: &AuditRow) -> Option<()> {
    let conn = audit_db()?;
    conn.execute(
        "INSERT OR IGNORE INTO dispatch_audit
         (id, op, address, body, status, submitted, historical, sender_name, profile_id, error, created_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?10)",
        rusqlite::params![
            row.id,
            row.op,
            row.address,
            row.body,
            row.status,
            row.submitted as i64,
            row.historical as i64,
            row.sender_name,
            row.profile_id,
            row.created_ms as i64,
        ],
    )
    .ok()?;
    Some(())
}

pub fn import_historical() -> bool {
    if import_marker().exists() {
        return true;
    }
    let path = crate::persist::roaming_app_dir().join("agent-messages.json");
    let Ok(bytes) = std::fs::read(&path) else {
        return false;
    };
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return false;
    };
    let rows = import_agent_messages(&value);
    let Some(conn) = audit_db() else {
        return false;
    };
    for row in &rows {
        let inserted = conn.execute(
            "INSERT OR IGNORE INTO dispatch_audit
             (id, op, address, body, status, submitted, historical, sender_name, profile_id, error, created_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, 0, 1, ?6, ?7, NULL, ?8)",
            rusqlite::params![
                row.id,
                row.op,
                row.address,
                row.body,
                row.status,
                row.sender_name,
                row.profile_id,
                row.created_ms as i64,
            ],
        );
        if inserted.is_err() {
            return false;
        }
    }
    let _ = std::fs::write(import_marker(), b"ok");
    let _ = path;
    true
}
