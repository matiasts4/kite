// Kite Code — Tickets Persistence & Storage Layer
// File operations, mutex locking, atomic writing, and backup management

use super::document::TicketDocument;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

pub fn doc_lock() -> &'static Mutex<()> {
    static LOCK: Mutex<()> = Mutex::new(());
    &LOCK
}

pub fn tickets_file_path() -> PathBuf {
    crate::persist::roaming_app_dir().join("tickets.json")
}

pub fn tickets_backup_path() -> PathBuf {
    crate::persist::roaming_app_dir().join("tickets.backup.json")
}

pub fn create_default_document() -> TicketDocument {
    TicketDocument {
        schema_version: 1,
        revision: 1,
        projects: vec![],
        labels: vec![],
        issues: vec![],
        comments: vec![],
        history: vec![],
        connections: vec![],
    }
}

pub fn load_ticket_document_locked() -> TicketDocument {
    let path = tickets_file_path();
    if path.exists() {
        if let Ok(content) = fs::read_to_string(&path) {
            if let Ok(doc) = serde_json::from_str::<TicketDocument>(&content) {
                return doc;
            }
        }
    }

    let backup_path = tickets_backup_path();
    if backup_path.exists() {
        if let Ok(content) = fs::read_to_string(&backup_path) {
            if let Ok(doc) = serde_json::from_str::<TicketDocument>(&content) {
                return doc;
            }
        }
    }

    let default_doc = create_default_document();
    let _ = save_ticket_document_locked(&default_doc);
    default_doc
}

pub fn save_ticket_document_locked(doc: &TicketDocument) -> Result<(), String> {
    let path = tickets_file_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let data = serde_json::to_string_pretty(doc).map_err(|e| e.to_string())?;

    if path.exists() {
        let backup_path = tickets_backup_path();
        let _ = fs::copy(&path, &backup_path);
    }

    let tmp_path = path.with_extension("tmp");
    fs::write(&tmp_path, data).map_err(|e| e.to_string())?;
    fs::rename(&tmp_path, &path).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn load_ticket_document() -> TicketDocument {
    let _lock = doc_lock().lock().unwrap();
    load_ticket_document_locked()
}

pub fn save_ticket_document(doc: &TicketDocument) -> Result<(), String> {
    let _lock = doc_lock().lock().unwrap();
    save_ticket_document_locked(doc)
}
