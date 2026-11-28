//! Runtime-probed adapter and fail-closed guard for `codex app-server`.
//!
//! `codex app-server --help` documents the stdio JSON-RPC transport and schema
//! generation subcommands, while user-turn request frames are only accepted when
//! explicitly verified at runtime. Whenever runtime probing observes only
//! transport or schema tooling (or fails), this module fails closed with
//! [`CODEX_APP_SERVER_GAP`] and invents zero wire frames.

use std::fmt;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::chat::drivers::{
    declaration, parse_version, DriverProbe, DriverVersion, SystemDriverProbe, Version,
    CODEX_APP_SERVER_GAP,
};
use crate::chat::session::{
    PersistentControls, SessionTransport, TransportEvent, TransportSpec,
};
use crate::chat::utils::{chat_log, resolve_codex_bin};

/// Documented user-turn JSON-RPC method identifiers that prove a runtime schema
/// exposes an explicit turn submission frame rather than transport/schema tooling alone.
const EXPLICIT_TURN_METHODS: &[&str] = &[
    "turn/start",
    "turn/send",
    "turn/submit",
    "turn/create",
    "turn/run",
    "turn.start",
    "turn.send",
    "turn.submit",
    "turn.create",
    "turn.run",
    "session/prompt",
    "session/turn",
    "session/turn/start",
    "thread/turn/start",
    "thread/turn",
    "user/turn",
    "user_turn/start",
    "conversation/turn",
    "sendUserTurn",
];

/// Result of probing `codex app-server` capability output at runtime.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CodexAppServerProbeResult {
    UnsupportedGap { detail: String },
    Verified {
        schema_version: Option<String>,
        turn_method: String,
    },
}

impl CodexAppServerProbeResult {
    pub fn is_verified(&self) -> bool {
        matches!(self, Self::Verified { .. })
    }
}

fn app_server_probe_evidence() -> DriverVersion {
    let base = declaration("codex").and_then(|d| d.version);
    DriverVersion {
        probe_args: vec!["app-server", "--help"],
        observed: base
            .as_ref()
            .map(|v| v.observed)
            .unwrap_or_else(|| Version::new(0, 163, 0)),
        minimum: base
            .as_ref()
            .map(|v| v.minimum)
            .unwrap_or_else(|| Version::new(0, 163, 0)),
        fixture: base
            .map(|v| v.fixture)
            .unwrap_or("tests/fixtures/driver-codex.version.txt"),
    }
}

fn contains_ascii_word(haystack: &str, needle: &str) -> bool {
    let mut start = 0;
    while let Some(offset) = haystack[start..].find(needle) {
        let idx = start + offset;
        let end = idx + needle.len();
        let left_ok = haystack[..idx]
            .chars()
            .next_back()
            .map_or(true, |c| !c.is_ascii_alphanumeric() && c != '-' && c != '_');
        let right_ok = haystack[end..]
            .chars()
            .next()
            .map_or(true, |c| !c.is_ascii_alphanumeric() && c != '-' && c != '_');
        if left_ok && right_ok {
            return true;
        }
        start = end;
    }
    false
}

fn documents_stdio_app_server_transport(raw: &str) -> bool {
    let lower = raw.to_ascii_lowercase();
    let has_stdio = lower.contains("stdio://") || contains_ascii_word(&lower, "stdio");
    let has_rpc_or_server = lower.contains("app-server")
        || lower.contains("app_server")
        || lower.contains("json-rpc")
        || lower.contains("jsonrpc");
    has_stdio && has_rpc_or_server
}

fn match_explicit_turn_method(candidate: &str) -> Option<String> {
    let trimmed = candidate.trim().trim_end_matches('.');
    if trimmed.is_empty() {
        return None;
    }
    EXPLICIT_TURN_METHODS
        .iter()
        .find(|known| trimmed.eq_ignore_ascii_case(known))
        .map(|_| trimmed.to_string())
}

fn extract_turn_method_from_json(value: &Value, depth: usize) -> Option<String> {
    if depth > 24 {
        return None;
    }
    match value {
        Value::Object(map) => {
            for key in ["method", "const", "name", "requestMethod", "request_method"] {
                if let Some(raw) = map.get(key).and_then(Value::as_str) {
                    if let Some(found) = match_explicit_turn_method(raw) {
                        return Some(found);
                    }
                }
            }
            if let Some(Value::Array(items)) = map.get("enum") {
                for item in items {
                    if let Some(raw) = item.as_str() {
                        if let Some(found) = match_explicit_turn_method(raw) {
                            return Some(found);
                        }
                    }
                }
            }
            for container_key in ["methods", "requests"] {
                if let Some(container) = map.get(container_key) {
                    match container {
                        Value::Object(methods) => {
                            for method_name in methods.keys() {
                                if let Some(found) = match_explicit_turn_method(method_name) {
                                    return Some(found);
                                }
                            }
                        }
                        Value::Array(methods) => {
                            for item in methods {
                                if let Some(raw) = item.as_str() {
                                    if let Some(found) = match_explicit_turn_method(raw) {
                                        return Some(found);
                                    }
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
            for child in map.values() {
                if let Some(found) = extract_turn_method_from_json(child, depth + 1) {
                    return Some(found);
                }
            }
            None
        }
        Value::Array(items) => {
            for item in items {
                if let Some(found) = extract_turn_method_from_json(item, depth + 1) {
                    return Some(found);
                }
            }
            None
        }
        _ => None,
    }
}

fn extract_turn_method_from_text(raw: &str) -> Option<String> {
    for token in raw.split(|c: char| {
        c.is_whitespace()
            || matches!(
                c,
                '"' | '\'' | '`' | ',' | ';' | '(' | ')' | '[' | ']' | '{' | '}' | ':' | '='
            )
    }) {
        if let Some(found) = match_explicit_turn_method(token) {
            return Some(found);
        }
    }
    None
}

fn version_value_to_string(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => {
            let trimmed = s.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        }
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn extract_schema_version_from_json(value: &Value, depth: usize) -> Option<String> {
    if depth > 8 {
        return None;
    }
    match value {
        Value::Object(map) => {
            for key in ["schemaVersion", "schema_version", "protocolVersion", "version"] {
                if let Some(found) = map.get(key).and_then(version_value_to_string) {
                    return Some(found);
                }
            }
            for child in map.values() {
                if let Some(found) = extract_schema_version_from_json(child, depth + 1) {
                    return Some(found);
                }
            }
            None
        }
        Value::Array(items) => {
            for item in items {
                if let Some(found) = extract_schema_version_from_json(item, depth + 1) {
                    return Some(found);
                }
            }
            None
        }
        _ => None,
    }
}

fn extract_schema_version(raw: &str, json_val: Option<&Value>) -> Option<String> {
    if let Some(val) = json_val {
        if let Some(ver) = extract_schema_version_from_json(val, 0) {
            return Some(ver);
        }
    }
    parse_version(raw).map(|ver| ver.to_string())
}

/// Checks whether a `codex app-server --help` or generated schema output
/// explicitly documents BOTH stdio JSON-RPC app-server transport AND a
/// verified user-turn request method. Fails closed with [`CODEX_APP_SERVER_GAP`]
/// whenever only transport or schema tooling is present.
pub fn probe_codex_app_server_help(help_or_schema: &str) -> CodexAppServerProbeResult {
    let trimmed = help_or_schema.trim();
    if trimmed.is_empty() || !documents_stdio_app_server_transport(trimmed) {
        return CodexAppServerProbeResult::UnsupportedGap {
            detail: CODEX_APP_SERVER_GAP.to_string(),
        };
    }

    let parsed_json = serde_json::from_str::<Value>(trimmed).ok();
    let turn_method = parsed_json
        .as_ref()
        .and_then(|val| extract_turn_method_from_json(val, 0))
        .or_else(|| extract_turn_method_from_text(trimmed));

    match turn_method {
        Some(turn_method) => CodexAppServerProbeResult::Verified {
            schema_version: extract_schema_version(trimmed, parsed_json.as_ref()),
            turn_method,
        },
        None => CodexAppServerProbeResult::UnsupportedGap {
            detail: CODEX_APP_SERVER_GAP.to_string(),
        },
    }
}

/// Executes `codex app-server --help` via the provided [`DriverProbe`] and
/// fails closed to [`CodexAppServerProbeResult::UnsupportedGap`] on any error
/// or unverified help output.
pub fn probe_codex_app_server(
    program: &Path,
    probe: &dyn DriverProbe,
) -> CodexAppServerProbeResult {
    let evidence = app_server_probe_evidence();
    match probe.probe("codex", program, &evidence) {
        Ok(raw) => {
            let result = probe_codex_app_server_help(&raw);
            if matches!(result, CodexAppServerProbeResult::UnsupportedGap { .. }) {
                chat_log(&format!(
                    "codex app-server probe stayed fail-closed for {}: no verified user-turn request frame",
                    program.display()
                ));
            }
            result
        }
        Err(err) => {
            chat_log(&format!(
                "codex app-server probe failed closed for {}: {err}",
                program.display()
            ));
            CodexAppServerProbeResult::UnsupportedGap {
                detail: CODEX_APP_SERVER_GAP.to_string(),
            }
        }
    }
}

/// Runtime-probed `codex app-server` transport adapter.
///
/// Fails closed inside [`SessionTransport::spawn`] whenever runtime capability
/// probing reports [`CodexAppServerProbeResult::UnsupportedGap`], ensuring zero
/// unverified wire frames are ever invented or sent.
pub struct CodexAppServerSession {
    controls: PersistentControls,
    program: Option<PathBuf>,
    probe: Box<dyn DriverProbe>,
    last_probe: Option<CodexAppServerProbeResult>,
    resume_handle: Option<String>,
    spawns: u32,
}

impl CodexAppServerSession {
    pub fn new(controls: PersistentControls) -> Self {
        Self::with_probe(controls, None, Box::new(SystemDriverProbe))
    }

    /// `program` is injectable so capability probing and fail-closed behavior
    /// can be verified without resolving or launching a real binary.
    pub fn with_program(controls: PersistentControls, program: Option<PathBuf>) -> Self {
        Self::with_probe(controls, program, Box::new(SystemDriverProbe))
    }

    pub fn with_probe(
        controls: PersistentControls,
        program: Option<PathBuf>,
        probe: Box<dyn DriverProbe>,
    ) -> Self {
        Self {
            controls,
            program,
            probe,
            last_probe: None,
            resume_handle: None,
            spawns: 0,
        }
    }

    pub fn last_probe(&self) -> Option<&CodexAppServerProbeResult> {
        self.last_probe.as_ref()
    }

    pub fn probe_capabilities(&mut self) -> CodexAppServerProbeResult {
        let program = self
            .program
            .clone()
            .or_else(resolve_codex_bin)
            .unwrap_or_else(|| PathBuf::from("codex"));
        let result = probe_codex_app_server(&program, self.probe.as_ref());
        self.last_probe = Some(result.clone());
        result
    }
}

impl fmt::Debug for CodexAppServerSession {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CodexAppServerSession")
            .field("controls", &self.controls)
            .field("program", &self.program)
            .field("last_probe", &self.last_probe)
            .field("spawns", &self.spawns)
            .finish()
    }
}

impl SessionTransport for CodexAppServerSession {
    fn spawn(&mut self, spec: &TransportSpec) -> Result<(), String> {
        if !spec.driver.trim().eq_ignore_ascii_case("codex") {
            return Err(format!(
                "{} does not speak the codex app-server wire",
                spec.driver
            ));
        }
        self.resume_handle = spec.resume_handle.clone();
        match self.probe_capabilities() {
            CodexAppServerProbeResult::UnsupportedGap { .. } => {
                Err(CODEX_APP_SERVER_GAP.to_string())
            }
            CodexAppServerProbeResult::Verified {
                schema_version,
                turn_method,
            } => Err(format!(
                "codex app-server probed verified turn method `{turn_method}` (schema {}), but this build keeps codex fail-closed on one command per turn without inventing wire frames",
                schema_version.as_deref().unwrap_or("unversioned")
            )),
        }
    }

    fn write_turn(&mut self, _prompt: &str) -> Result<(), String> {
        Err(CODEX_APP_SERVER_GAP.to_string())
    }

    fn write_frame(&mut self, _frame: &str) -> Result<(), String> {
        Err(CODEX_APP_SERVER_GAP.to_string())
    }

    fn interrupt(&mut self) -> Result<(), String> {
        Ok(())
    }

    fn stop(&mut self) -> Result<(), String> {
        Ok(())
    }

    fn spawn_count(&self) -> u32 {
        self.spawns
    }

    fn resume_handle(&self) -> Option<String> {
        self.resume_handle.clone()
    }

    fn drain(&mut self) -> Vec<TransportEvent> {
        Vec::new()
    }

    fn is_alive(&self) -> bool {
        false
    }

    fn controls(&self) -> Option<PersistentControls> {
        Some(self.controls.clone())
    }

    fn update_controls(&mut self, next: &PersistentControls) -> bool {
        self.controls = next.clone();
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use crate::chat::session::SessionMode;

    #[derive(Debug, Clone)]
    struct FakeProbe {
        raw: Result<String, String>,
        recorded_args: Arc<Mutex<Vec<Vec<&'static str>>>>,
    }

    impl FakeProbe {
        fn new(raw: Result<&str, &str>) -> Self {
            Self {
                raw: raw.map(str::to_string).map_err(str::to_string),
                recorded_args: Arc::new(Mutex::new(Vec::new())),
            }
        }
    }

    impl DriverProbe for FakeProbe {
        fn probe(
            &self,
            driver: &str,
            _program: &Path,
            evidence: &DriverVersion,
        ) -> Result<String, String> {
            assert_eq!(driver, "codex");
            self.recorded_args
                .lock()
                .unwrap()
                .push(evidence.probe_args.clone());
            self.raw.clone()
        }
    }

    fn codex_spec() -> TransportSpec {
        TransportSpec {
            session_id: "thread-codex-1:1".to_string(),
            driver: "codex".to_string(),
            working_directory: None,
            mode: SessionMode::Persistent,
            recipe_revision: None,
            resume_handle: None,
            extra_env: Vec::new(),
        }
    }

    #[test]
    fn help_with_only_transport_and_schema_tooling_fails_closed_with_gap() {
        let help = "\
Run the Codex app-server (experimental)
Usage: codex app-server [OPTIONS] [COMMAND]

Commands:
  generate-ts           Generate TypeScript bindings for the schema
  generate-json-schema  Generate JSON schema for protocol messages

Options:
  --listen <LISTEN_URL>  Transport URL [default: stdio://]
  -h, --help             Print help
";
        assert_eq!(
            probe_codex_app_server_help(help),
            CodexAppServerProbeResult::UnsupportedGap {
                detail: CODEX_APP_SERVER_GAP.to_string(),
            }
        );

        let prose_only = "\
codex-cli 0.163.0 app-server --listen stdio:// JSON-RPC
Note: user turn frames and turn/interrupt notifications are listed in schema tooling.
";
        assert_eq!(
            probe_codex_app_server_help(prose_only),
            CodexAppServerProbeResult::UnsupportedGap {
                detail: CODEX_APP_SERVER_GAP.to_string(),
            }
        );

        assert_eq!(
            probe_codex_app_server_help(""),
            CodexAppServerProbeResult::UnsupportedGap {
                detail: CODEX_APP_SERVER_GAP.to_string(),
            }
        );
    }

    #[test]
    fn explicit_turn_method_without_stdio_transport_still_fails_closed() {
        let missing_transport = r#"{"schemaVersion":"1.0.0","method":"turn/start"}"#;
        assert_eq!(
            probe_codex_app_server_help(missing_transport),
            CodexAppServerProbeResult::UnsupportedGap {
                detail: CODEX_APP_SERVER_GAP.to_string(),
            }
        );
    }

    #[test]
    fn verified_when_explicit_stdio_transport_and_turn_frames_are_present() {
        let schema = r#"{
            "schemaVersion": "0.180.0",
            "transport": "stdio://",
            "jsonrpc": "2.0",
            "definitions": {
                "TurnStartRequest": {
                    "properties": {
                        "method": { "const": "turn/start" }
                    }
                }
            }
        }"#;
        assert_eq!(
            probe_codex_app_server_help(schema),
            CodexAppServerProbeResult::Verified {
                schema_version: Some("0.180.0".to_string()),
                turn_method: "turn/start".to_string(),
            }
        );

        let help_text = "\
codex-cli 0.181.0
Usage: codex app-server --listen stdio://
JSON-RPC Requests:
  turn/start    Submit a user turn
";
        assert_eq!(
            probe_codex_app_server_help(help_text),
            CodexAppServerProbeResult::Verified {
                schema_version: Some("0.181.0".to_string()),
                turn_method: "turn/start".to_string(),
            }
        );
    }

    #[test]
    fn probe_codex_app_server_runs_app_server_help_and_falls_back_on_error() {
        let failing_probe = FakeProbe::new(Err("binary missing"));
        let args_log = Arc::clone(&failing_probe.recorded_args);
        let result = probe_codex_app_server(Path::new("codex"), &failing_probe);
        assert_eq!(
            result,
            CodexAppServerProbeResult::UnsupportedGap {
                detail: CODEX_APP_SERVER_GAP.to_string(),
            }
        );
        assert_eq!(
            *args_log.lock().unwrap(),
            vec![vec!["app-server", "--help"]]
        );

        let verified_probe = FakeProbe::new(Ok(
            "codex app-server --listen stdio:// JSON-RPC\nMethods:\n  turn/start\n",
        ));
        let verified = probe_codex_app_server(Path::new("codex"), &verified_probe);
        assert_eq!(
            verified,
            CodexAppServerProbeResult::Verified {
                schema_version: None,
                turn_method: "turn/start".to_string(),
            }
        );
    }

    #[test]
    fn session_spawn_fails_closed_with_codex_app_server_gap_on_unsupported_probe() {
        let help_only_probe = FakeProbe::new(Ok(
            "codex app-server --listen stdio://\nCommands:\n  generate-json-schema\n",
        ));
        let mut session = CodexAppServerSession::with_probe(
            PersistentControls::default(),
            Some(PathBuf::from("codex")),
            Box::new(help_only_probe),
        );

        let error = session
            .spawn(&codex_spec())
            .expect_err("codex app-server without turn frame must fail closed");
        assert_eq!(error, CODEX_APP_SERVER_GAP);
        assert_eq!(session.spawn_count(), 0);
        assert!(!session.is_alive());
        assert!(session.drain().is_empty());
        assert_eq!(
            session.last_probe(),
            Some(&CodexAppServerProbeResult::UnsupportedGap {
                detail: CODEX_APP_SERVER_GAP.to_string(),
            })
        );
        assert_eq!(
            session.write_turn("hello").unwrap_err(),
            CODEX_APP_SERVER_GAP
        );
    }
}
