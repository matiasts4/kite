//! Shared test helpers, constants, and fixtures for contract verification.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::chat::drivers::{DriverProbe, DriverVersion};
use crate::chat::provider_env::ProviderEnvironment;
use crate::chat::session::{RecipeSnapshot, SessionMode, SessionSpec, TransportSpec};

pub const DRIVERS: [&str; 7] = [
    "antigravity",
    "claude",
    "codex",
    "cursor",
    "gemini",
    "grok",
    "opencode",
];

pub const APPROVAL_REQUEST: &str =
    include_str!("../../../tests/fixtures/approval.antigravity.stream.json");
pub const APPROVAL_RESPONSE: &str =
    include_str!("../../../tests/fixtures/approval.antigravity.response.json");
pub const MALFORMED_FRAME: &str =
    include_str!("../../../tests/fixtures/antigravity.malformed.frame.json");
pub const OVERSIZED_FRAME: &str =
    include_str!("../../../tests/fixtures/antigravity.oversized.frame.json");

pub const THREAD_STATUS_READABLE: &str = "error";

pub fn thread_base(thread_id: &str) -> Value {
    json!({
        "schemaVersion": 1,
        "revision": "rev-1",
        "id": thread_id,
        "profileId": Value::Null,
        "provider": "codex",
        "providerSessionId": Value::Null,
        "title": "Contract",
        "items": [],
        "plans": [],
        "mode": "acceptEdits",
        "plan": false,
        "model": Value::Null,
        "providerOptions": [],
        "status": "idle",
        "usage": { "inputTokens": 0, "outputTokens": 0, "costUsd": 0.0 },
        "workspaceId": Value::Null,
        "pinned": false,
        "pendingApproval": Value::Null,
        "createdAtUnixMs": 1_700_000_000_000i64,
        "updatedAtUnixMs": 1_700_000_000_000i64
    })
}

pub fn approval_value() -> Value {
    json!({
        "id": "approval-1",
        "toolName": "shell",
        "title": "Run a command",
        "detail": Value::Null,
        "risk": "low",
        "impact": "writes a file",
        "status": "pending"
    })
}

pub fn recipe(revision: &str) -> RecipeSnapshot {
    RecipeSnapshot {
        agent_id: "agent-contract".to_string(),
        revision: revision.to_string(),
        role: "the contract role".to_string(),
        memory: "the contract memory".to_string(),
        user: "the contract user".to_string(),
        skills: vec!["root-cause".to_string()],
    }
}

pub fn session_spec(
    thread_id: &str,
    driver: &str,
    mode: SessionMode,
    recipe: Option<RecipeSnapshot>,
) -> SessionSpec {
    SessionSpec {
        thread_id: thread_id.to_string(),
        driver: driver.to_string(),
        connection_id: Some("connection-contract".to_string()),
        working_directory: Some("E:/kite".to_string()),
        mode,
        recipe,
        resume_handle: None,
        extra_env: Vec::new(),
    }
}

pub fn transport_spec(driver: &str) -> TransportSpec {
    TransportSpec {
        session_id: "thread-contract:1".to_string(),
        driver: driver.to_string(),
        working_directory: None,
        mode: SessionMode::Persistent,
        recipe_revision: Some("r1".to_string()),
        resume_handle: None,
        extra_env: Vec::new(),
    }
}

/// A checked-in frame fixture's provider. A probe record is not a wire
/// frame, so it is skipped. An unmapped fixture fails the test until its
/// provider is declared, which keeps the replay set complete.
pub fn fixture_provider(name: &str) -> Option<&'static str> {
    if name.starts_with("driver-") {
        return None;
    }
    for (marker, provider) in [
        ("antigravity", "antigravity"),
        ("acp", "acp"),
        ("claude", "claude"),
        ("codex", "codex"),
        ("unknown", "antigravity"),
        ("settled", "antigravity"),
    ] {
        if name.contains(marker) {
            return Some(provider);
        }
    }
    panic!("fixture {name} has no replay provider");
}

pub fn looks_secret(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    ["KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL"]
        .iter()
        .any(|marker| upper.contains(marker))
}

pub fn environment_fields(environment: &ProviderEnvironment) -> Vec<&str> {
    std::iter::once(environment.driver.as_str())
        .chain(std::iter::once(environment.auth_source.as_str()))
        .chain(std::iter::once(environment.auth_recovery.as_str()))
        .chain(environment.inherited_names.iter().map(String::as_str))
        .chain(environment.mcp_sources.iter().map(String::as_str))
        .collect()
}

/// A scratch directory outside the worktree, removed on drop.
pub struct TempDir(pub PathBuf);

impl TempDir {
    pub fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "kite-contract-{label}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&path).expect("create temp dir");
        Self(path)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }

    pub fn join(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }

    pub fn write(&self, relative: &str, contents: &str) {
        let path = self.0.join(relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create fixture directory");
        }
        fs::write(path, contents).expect("write fixture");
    }

    pub fn snapshot(&self) -> BTreeMap<PathBuf, Vec<u8>> {
        let mut files = BTreeMap::new();
        let mut pending = vec![self.0.clone()];
        while let Some(directory) = pending.pop() {
            for entry in fs::read_dir(&directory).expect("read temp dir") {
                let entry = entry.expect("read temp dir entry");
                let path = entry.path();
                if entry.file_type().expect("temp entry type").is_dir() {
                    pending.push(path);
                } else {
                    let relative = path
                        .strip_prefix(&self.0)
                        .expect("relative fixture path")
                        .to_path_buf();
                    files.insert(relative, fs::read(&path).expect("read temp file"));
                }
            }
        }
        files
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// A probe that reports a version below the declared minimum. It starts no
/// process, so the version gate can be exercised on any machine.
#[derive(Debug)]
pub struct StaleVersionProbe;

impl DriverProbe for StaleVersionProbe {
    fn probe(
        &self,
        _driver: &str,
        _program: &Path,
        _evidence: &DriverVersion,
    ) -> Result<String, String> {
        Ok("agy 1.0.0".to_string())
    }
}
