//! Tauri IPC telemetry bridge backed directly by `kite_ctx::SavingsLedger`.
//!
//! Reads directly from `~/.kite/ctx/store.db` (or `KITE_CTX_DB_PATH`) so every
//! CLI and desktop agent session contributes to live telemetry without relying on
//! external HTTP proxies.

use kite_ctx::ContextEngine;
use serde_json::{json, Value};

#[tauri::command]
pub fn fetch_context_monitor() -> Value {
    let engine = match ContextEngine::open_default() {
        Ok(e) => e,
        Err(err) => {
            return json!({
                "ok": false,
                "error": format!("store_unavailable: {err}")
            });
        }
    };

    match engine.ledger().snapshot(None) {
        Ok(mut snapshot) => {
            let home = kite_ctx::resolve_home_dir();
            let workspace = std::env::current_dir().unwrap_or_else(|_| home.clone());
            snapshot.discovery = kite_ctx::discover_from_host(&home, &workspace);
            serde_json::to_value(snapshot).unwrap_or_else(|err| {
                json!({
                    "ok": false,
                    "error": format!("serialize_failed: {err}")
                })
            })
        }
        Err(err) => json!({
            "ok": false,
            "error": format!("snapshot_failed: {err}")
        }),
    }
}

#[tauri::command]
pub fn reset_context_monitor() -> Value {
    let engine = match ContextEngine::open_default() {
        Ok(e) => e,
        Err(err) => {
            return json!({
                "ok": false,
                "error": format!("store_unavailable: {err}")
            });
        }
    };

    match engine.ledger().reset() {
        Ok(()) => json!({ "ok": true }),
        Err(err) => json!({
            "ok": false,
            "error": format!("reset_failed: {err}")
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kite_ctx::LedgerEventInput;
    use std::sync::{Mutex, OnceLock};

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    struct TestDir(std::path::PathBuf);
    impl TestDir {
        fn new(tag: &str) -> Self {
            let p = std::env::temp_dir().join(format!(
                "kite_{tag}_{}_{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&p).unwrap();
            Self(p)
        }
        fn path(&self) -> &std::path::Path {
            &self.0
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn fetches_and_resets_context_monitor_snapshot_from_sqlite() {
        let _guard = env_lock().lock().unwrap();
        let dir = TestDir::new("ctx_mon");
        let db = dir.path().join("monitor.db");
        let prev = std::env::var(kite_ctx::ENV_DB_PATH).ok();
        std::env::set_var(kite_ctx::ENV_DB_PATH, &db);

        let engine = ContextEngine::open_default().unwrap();
        engine
            .ledger()
            .record(&LedgerEventInput {
                session_id: "mon-s1".to_string(),
                agent: "Orion".to_string(),
                provider: "google".to_string(),
                model: "gemini-2.5-pro".to_string(),
                category: "exec".to_string(),
                command_or_tool: "cargo test".to_string(),
                raw_tokens: 2000,
                compressed_tokens: 200,
                cache_hit: false,
                overhead_ms: 2,
            })
            .unwrap();

        let payload = fetch_context_monitor();
        assert_eq!(payload["ok"], true);
        assert_eq!(payload["lifetime"]["tokens_saved"], 1800);
        assert_eq!(payload["session"]["requests"], 1);
        assert_eq!(payload["agents"][0]["agent"], "Orion");

        let reset = reset_context_monitor();
        assert_eq!(reset["ok"], true);
        let after = fetch_context_monitor();
        assert_eq!(after["lifetime"]["requests"], 0);

        if let Some(val) = prev {
            std::env::set_var(kite_ctx::ENV_DB_PATH, val);
        } else {
            std::env::remove_var(kite_ctx::ENV_DB_PATH);
        }
    }
}
