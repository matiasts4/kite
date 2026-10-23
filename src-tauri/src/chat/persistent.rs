//! Lasting CLI transports for drivers whose wire can stay open.
//!
//! Only Antigravity's `agy` lasting channel is wired in this build. The
//! observed evidence is its `--input-format stream-json` / `--output-format
//! stream-json` pair: one NDJSON user message per line on stdin, one JSON frame
//! per line on stdout. The exact input frame is this adapter's own and was not
//! probed, so it stays a single, explicit shape instead of a guess spread across
//! the runtime. Every other driver keeps one command per turn.

use std::collections::VecDeque;
use std::fmt;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use serde_json::{json, Value};

use crate::chat::drivers::{declaration, DriverDeclaration};
use crate::chat::runtime::bounded_notice;
use crate::chat::session::{SessionTransport, TransportEvent, TransportSpec};
use crate::chat::utils::resolve_bin;
use crate::hidden_exec::{spawn_streaming, HiddenChild};

/// The canonical driver id whose lasting wire this module implements.
pub const ANTIGRAVITY_DRIVER: &str = "antigravity";

/// The argument prefix the lasting Antigravity wire needs. It is copied from
/// the observed flags: `--print` runs one turn without a prompt positional,
/// `--input-format stream-json` reads one NDJSON message per line, and the
/// matching output format is required by the observed launcher.
pub const ANTIGRAVITY_STREAM_ARGS: [&str; 5] =
    ["--print", "--input-format", "stream-json", "--output-format", "stream-json"];

/// A session queue that never grows without bound. Provider output is
/// operational, so an unread session drops the oldest frames instead of
/// retaining an unbounded transcript in memory.
pub const MAX_PENDING_EVENTS: usize = 512;

/// The composer values a lasting session may pass to its driver. Each one
/// reaches the command line only when the driver declaration accepts it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PersistentControls {
    pub model: Option<String>,
    pub effort: Option<String>,
    /// `readOnly`, `acceptEdits`, or `fullAccess`.
    pub permission_mode: Option<String>,
}

/// Whether this build has an adapter that speaks the driver's lasting wire.
/// The driver declaration records what the driver offers; this records what
/// the binary can actually be driven with here.
pub fn has_persistent_wire(driver: &str) -> bool {
    match declaration(driver) {
        Some(declared) => declared.driver == ANTIGRAVITY_DRIVER,
        None => false,
    }
}

/// Builds the lasting Antigravity command line. Controls are gated by the
/// declaration instead of being inferred from the driver id. The prompt is not
/// part of argv: a lasting session receives it on stdin, so nothing pastes the
/// thread into every turn.
pub fn antigravity_args(
    declared: &DriverDeclaration,
    controls: &PersistentControls,
    resume_handle: Option<&str>,
) -> Vec<String> {
    let mut args: Vec<String> = ANTIGRAVITY_STREAM_ARGS
        .iter()
        .map(|arg| arg.to_string())
        .collect();

    if let Some(handle) = resume_handle.map(str::trim).filter(|handle| !handle.is_empty()) {
        if declared.accepts_resume {
            args.push("--conversation".to_string());
            args.push(handle.to_string());
        }
    }

    match controls.permission_mode.as_deref() {
        Some("readOnly") if declared.has_work_mode("plan") => {
            args.push("--mode".to_string());
            args.push("plan".to_string());
        }
        Some("acceptEdits") if declared.has_work_mode("accept-edits") => {
            args.push("--mode".to_string());
            args.push("accept-edits".to_string());
        }
        Some("fullAccess") if declared.accepts_permission => {
            args.push("--dangerously-skip-permissions".to_string());
        }
        // A value the declaration does not map is omitted, never approximated.
        _ => {}
    }

    if declared.accepts_model {
        if let Some(model) = controls.model.as_deref().map(str::trim).filter(|model| !model.is_empty()) {
            args.push("--model".to_string());
            args.push(model.to_string());
        }
    }
    if declared.accepts_effort {
        if let Some(effort) = controls.effort.as_deref().map(str::trim).filter(|effort| !effort.is_empty()) {
            args.push("--effort".to_string());
            args.push(effort.to_string());
        }
    }

    args
}

/// One user message as one NDJSON line. `serde_json` escapes embedded newlines,
/// so a multi-line prompt stays a single frame and a single turn.
pub fn turn_line(prompt: &str) -> String {
    let message = json!({ "type": "user", "content": prompt });
    format!("{message}\n")
}

/// One parsed stdout line. A frame may carry an observable conversation id and
/// any number of transport events, because one provider line can both report a
/// failure and end the turn.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ParsedLine {
    pub conversation_id: Option<String>,
    pub events: Vec<TransportEvent>,
}

/// Normalizes one Antigravity stream line. Known turn text becomes `Text`, a
/// finished turn becomes `TurnEnded`, and anything this session does not
/// project becomes a bounded `Notice` that names the provider and the frame
/// schema.
pub fn parse_antigravity_line(line: &str) -> ParsedLine {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return ParsedLine::default();
    }

    let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
        return ParsedLine {
            conversation_id: None,
            events: vec![TransportEvent::Notice(bounded_notice(&format!(
                "antigravity wrote a non-JSON line (schema=non-json): {trimmed}"
            )))],
        };
    };

    let Some(event) = value.get("event").and_then(Value::as_str) else {
        return ParsedLine {
            conversation_id: None,
            events: vec![TransportEvent::Notice(bounded_notice(&format!(
                "antigravity sent an unknown frame (schema={})",
                frame_schema(&value)
            )))],
        };
    };

    match event {
        "init" => ParsedLine {
            conversation_id: conversation_id(&value),
            events: Vec::new(),
        },
        "step_update" => {
            let step = value.get("step_update").cloned().unwrap_or(Value::Null);
            let step_type = step.get("step_type").and_then(Value::as_str).unwrap_or("unknown");
            if step_type == "agent_response" {
                let text = step
                    .get("text_delta")
                    .or_else(|| step.get("text"))
                    .or_else(|| step.get("content"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if text.is_empty() {
                    ParsedLine::default()
                } else {
                    ParsedLine {
                        conversation_id: None,
                        events: vec![TransportEvent::Text(text.to_string())],
                    }
                }
            } else {
                let state = step.get("state").and_then(Value::as_str).unwrap_or("unknown");
                ParsedLine {
                    conversation_id: None,
                    events: vec![TransportEvent::Notice(bounded_notice(&format!(
                        "antigravity {step_type} step ({state}) is not projected by this session yet"
                    )))],
                }
            }
        }
        "result" => {
            let status = value
                .pointer("/result/status")
                .and_then(Value::as_str)
                .unwrap_or("SUCCESS");
            let mut events = Vec::new();
            if !status.eq_ignore_ascii_case("SUCCESS") {
                events.push(TransportEvent::Notice(bounded_notice(&format!(
                    "antigravity ended the turn with status {status}"
                ))));
            }
            events.push(TransportEvent::TurnEnded);
            ParsedLine {
                conversation_id: None,
                events,
            }
        }
        "error" => ParsedLine {
            conversation_id: None,
            events: vec![TransportEvent::Notice(bounded_notice(&format!(
                "antigravity reported an error: {}",
                error_detail(&value)
            )))],
        },
        other => ParsedLine {
            conversation_id: None,
            events: vec![TransportEvent::Notice(bounded_notice(&format!(
                "antigravity frame `{other}` is not recognized (schema={})",
                frame_schema(&value)
            )))],
        },
    }
}

fn conversation_id(value: &Value) -> Option<String> {
    ["/init/conversation_id", "/init/conversationId", "/init/session_id", "/init/sessionId"]
        .iter()
        .filter_map(|pointer| value.pointer(pointer).and_then(Value::as_str))
        .map(str::trim)
        .find(|candidate| !candidate.is_empty())
        .map(str::to_string)
}

fn error_detail(value: &Value) -> String {
    ["/error/message", "/message", "/error"]
        .iter()
        .filter_map(|pointer| value.pointer(pointer))
        .find_map(|detail| detail.as_str().map(str::to_string))
        .unwrap_or_else(|| "no detail was reported".to_string())
}

/// A short, bounded description of the top-level keys, used as schema metadata
/// for a frame this session does not understand.
fn frame_schema(value: &Value) -> String {
    let Some(object) = value.as_object() else {
        return "non-object".to_string();
    };
    let mut keys: Vec<&str> = object.keys().take(6).map(String::as_str).collect();
    if object.len() > keys.len() {
        keys.push("...");
    }
    keys.join(",")
}

/// Resolves the observed launcher. A missing binary is a hard error: the caller
/// falls back to one command per turn instead of pretending a session exists.
pub fn resolve_antigravity_program() -> Result<PathBuf, String> {
    resolve_bin("agy", &[r"C:\Users\PC\AppData\Local\agy\bin\agy.exe"]).ok_or_else(|| {
        "Antigravity CLI (agy) is not installed; a lasting session cannot start without it"
            .to_string()
    })
}

/// The real Antigravity session. It owns one child process, its stdin, and the
/// thread that drains stdout into the bounded event queue.
pub struct AntigravitySession {
    controls: PersistentControls,
    program: Option<PathBuf>,
    child: Option<HiddenChild>,
    stdin: Option<Box<dyn Write + Send>>,
    reader: Option<JoinHandle<()>>,
    events: Arc<Mutex<VecDeque<TransportEvent>>>,
    resume: Arc<Mutex<Option<String>>>,
    eof: Arc<AtomicBool>,
    stopping: bool,
    spawns: u32,
}

impl AntigravitySession {
    pub fn new(controls: PersistentControls) -> Self {
        Self::with_program(controls, None)
    }

    /// `program` is injectable so argv and failure behavior can be tested
    /// without resolving or starting a real provider.
    pub fn with_program(controls: PersistentControls, program: Option<PathBuf>) -> Self {
        Self {
            controls,
            program,
            child: None,
            stdin: None,
            reader: None,
            events: Arc::new(Mutex::new(VecDeque::new())),
            resume: Arc::new(Mutex::new(None)),
            eof: Arc::new(AtomicBool::new(false)),
            stopping: false,
            spawns: 0,
        }
    }

    fn stop_process(&mut self) {
        self.stopping = true;
        self.stdin = None;
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
        }
    }
}

impl fmt::Debug for AntigravitySession {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AntigravitySession")
            .field("controls", &self.controls)
            .field("program", &self.program)
            .field("spawns", &self.spawns)
            .finish()
    }
}

impl SessionTransport for AntigravitySession {
    fn spawn(&mut self, spec: &TransportSpec) -> Result<(), String> {
        if let Some(reader) = self.reader.take() {
            if reader.is_finished() {
                // The process is gone; the handle is reaped below.
            } else if self.stopping {
                // A stop already killed the process, so its reader is about to
                // observe EOF. Joining it keeps one reader per session.
                let _ = reader.join();
            } else {
                self.reader = Some(reader);
                return Err("the antigravity session already has a running process".to_string());
            }
        }
        if let Some(mut child) = self.child.take() {
            let _ = child.wait();
        }
        self.stdin = None;

        let declared = declaration(&spec.driver)
            .ok_or_else(|| format!("{} has no driver declaration in this build", spec.driver))?;
        if declared.driver != ANTIGRAVITY_DRIVER {
            return Err(format!("{} does not speak the antigravity wire", spec.driver));
        }

        let program = match self.program.clone() {
            Some(program) => program,
            None => resolve_antigravity_program()?,
        };
        let args = antigravity_args(&declared, &self.controls, spec.resume_handle.as_deref());
        let args_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let cwd = spec.working_directory.as_deref().map(Path::new);

        let mut child = spawn_streaming(&program, &args_refs, cwd).map_err(|error| {
            format!(
                "could not start the antigravity session with {}: {error}",
                program.display()
            )
        })?;
        let Some(stdout) = child.stdout.take() else {
            let _ = child.kill();
            return Err("the antigravity session started without a readable stdout".to_string());
        };

        self.stdin = child.stdin.take();
        self.child = Some(child);
        self.events.lock().unwrap().clear();
        *self.resume.lock().unwrap() = None;
        self.eof.store(false, Ordering::SeqCst);
        self.stopping = false;
        self.spawns += 1;

        let events = Arc::clone(&self.events);
        let resume = Arc::clone(&self.resume);
        let eof = Arc::clone(&self.eof);
        self.reader = Some(std::thread::spawn(move || {
            read_antigravity_stdout(stdout, events, resume, eof)
        }));
        Ok(())
    }

    fn write_turn(&mut self, prompt: &str) -> Result<(), String> {
        if self.eof.load(Ordering::SeqCst) {
            return Err("the antigravity session ended before the message was written".to_string());
        }
        let Some(stdin) = self.stdin.as_mut() else {
            return Err("the antigravity session has no open input".to_string());
        };
        stdin
            .write_all(turn_line(prompt).as_bytes())
            .map_err(|error| format!("could not write the message to the antigravity session: {error}"))?;
        stdin
            .flush()
            .map_err(|error| format!("could not flush the antigravity session input: {error}"))
    }

    fn interrupt(&mut self) -> Result<(), String> {
        self.stop_process();
        Ok(())
    }

    fn stop(&mut self) -> Result<(), String> {
        self.stop_process();
        Ok(())
    }

    fn spawn_count(&self) -> u32 {
        self.spawns
    }

    fn resume_handle(&self) -> Option<String> {
        self.resume.lock().ok().and_then(|handle| handle.clone())
    }

    fn drain(&mut self) -> Vec<TransportEvent> {
        let mut events: Vec<TransportEvent> = self
            .events
            .lock()
            .map(|mut queue| queue.drain(..).collect())
            .unwrap_or_default();

        let reader_finished = self.reader.as_ref().map(JoinHandle::is_finished).unwrap_or(false);
        if reader_finished && !self.stopping && self.eof.load(Ordering::SeqCst) {
            if let Some(mut child) = self.child.take() {
                let code = child.wait().ok();
                let error = match code {
                    Some(0) => None,
                    Some(other) => Some(format!("antigravity exited with code {other}")),
                    None => None,
                };
                events.push(TransportEvent::Exit { code, error });
            }
            self.reader = None;
            self.stdin = None;
        }

        events
    }
}

impl Drop for AntigravitySession {
    fn drop(&mut self) {
        self.stdin = None;
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
        }
    }
}

fn read_antigravity_stdout(
    stdout: Box<dyn Read + Send>,
    events: Arc<Mutex<VecDeque<TransportEvent>>>,
    resume: Arc<Mutex<Option<String>>>,
    eof: Arc<AtomicBool>,
) {
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {
                let parsed = parse_antigravity_line(&line);
                if let Some(conversation) = parsed.conversation_id {
                    if let Ok(mut handle) = resume.lock() {
                        *handle = Some(conversation);
                    }
                }
                if let Ok(mut queue) = events.lock() {
                    for event in parsed.events {
                        push_bounded(&mut queue, event);
                    }
                }
            }
            Err(_) => break,
        }
    }
    eof.store(true, Ordering::SeqCst);
}

fn push_bounded(queue: &mut VecDeque<TransportEvent>, event: TransportEvent) {
    if queue.len() >= MAX_PENDING_EVENTS {
        queue.pop_front();
    }
    queue.push_back(event);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::drivers::declaration;
    use crate::chat::runtime::MAX_NOTICE_CHARS;
    use crate::chat::session::SessionMode;

    fn controls(
        model: Option<&str>,
        effort: Option<&str>,
        permission_mode: Option<&str>,
    ) -> PersistentControls {
        PersistentControls {
            model: model.map(str::to_string),
            effort: effort.map(str::to_string),
            permission_mode: permission_mode.map(str::to_string),
        }
    }

    fn spec(driver: &str) -> TransportSpec {
        TransportSpec {
            session_id: "thread-1:1".to_string(),
            driver: driver.to_string(),
            working_directory: None,
            mode: SessionMode::Persistent,
            recipe_revision: Some("r1".to_string()),
            resume_handle: None,
        }
    }

    #[test]
    fn the_wire_is_the_observed_stream_json_pair() {
        let declared = declaration("antigravity").expect("antigravity declaration");
        let args = antigravity_args(&declared, &PersistentControls::default(), None);

        assert_eq!(
            args,
            vec![
                "--print".to_string(),
                "--input-format".to_string(),
                "stream-json".to_string(),
                "--output-format".to_string(),
                "stream-json".to_string(),
            ]
        );
    }

    #[test]
    fn controls_reach_the_wire_only_when_the_declaration_accepts_them() {
        let declared = declaration("antigravity").expect("antigravity declaration");
        let args = antigravity_args(
            &declared,
            &controls(Some("gemini-4-argon"), Some("high"), Some("fullAccess")),
            None,
        );
        assert!(args.windows(2).any(|pair| pair == ["--model", "gemini-4-argon"]));
        assert!(args.windows(2).any(|pair| pair == ["--effort", "high"]));
        assert!(args.iter().any(|arg| arg == "--dangerously-skip-permissions"));

        let mut closed = declared.clone();
        closed.accepts_model = false;
        closed.accepts_effort = false;
        closed.accepts_permission = false;
        closed.work_modes.clear();
        let args = antigravity_args(
            &closed,
            &controls(Some("gemini-4-argon"), Some("high"), Some("fullAccess")),
            None,
        );
        for flag in ["--model", "--effort", "--mode", "--dangerously-skip-permissions"] {
            assert!(!args.iter().any(|arg| arg == flag), "{flag} must be omitted");
        }
    }

    #[test]
    fn declared_work_modes_map_to_the_observed_mode_flag() {
        let declared = declaration("antigravity").expect("antigravity declaration");

        let read_only = antigravity_args(&declared, &controls(None, None, Some("readOnly")), None);
        assert!(read_only.windows(2).any(|pair| pair == ["--mode", "plan"]));

        let edits = antigravity_args(&declared, &controls(None, None, Some("acceptEdits")), None);
        assert!(edits.windows(2).any(|pair| pair == ["--mode", "accept-edits"]));

        let unknown = antigravity_args(&declared, &controls(None, None, Some("somethingElse")), None);
        assert!(!unknown.iter().any(|arg| arg == "--mode"));
        assert!(!unknown.iter().any(|arg| arg == "--dangerously-skip-permissions"));
    }

    #[test]
    fn a_resume_handle_is_passed_only_when_the_declaration_accepts_it() {
        let declared = declaration("antigravity").expect("antigravity declaration");
        let args = antigravity_args(&declared, &PersistentControls::default(), Some("conversation-1"));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--conversation", "conversation-1"]));

        let mut closed = declared;
        closed.accepts_resume = false;
        let args = antigravity_args(&closed, &PersistentControls::default(), Some("conversation-1"));
        assert!(!args.iter().any(|arg| arg == "--conversation"));
    }

    #[test]
    fn one_turn_is_one_ndjson_user_line() {
        let line = turn_line("first line\nsecond line");

        assert!(line.ends_with('\n'));
        assert_eq!(line.matches('\n').count(), 1, "a prompt stays one frame");
        let value: Value = serde_json::from_str(line.trim_end()).expect("one JSON object");
        assert_eq!(value.get("type").and_then(Value::as_str), Some("user"));
        assert_eq!(
            value.get("content").and_then(Value::as_str),
            Some("first line\nsecond line")
        );
    }

    #[test]
    fn stream_frames_become_text_notice_and_turn_end() {
        let text = parse_antigravity_line(
            r#"{"event":"step_update","step_update":{"step_type":"agent_response","text_delta":"hello"}}"#,
        );
        assert_eq!(text.events, vec![TransportEvent::Text("hello".to_string())]);

        let init = parse_antigravity_line(r#"{"event":"init","init":{"conversation_id":"conv-1"}}"#);
        assert_eq!(init.conversation_id.as_deref(), Some("conv-1"));
        assert!(init.events.is_empty());

        let success = parse_antigravity_line(r#"{"event":"result","result":{"status":"SUCCESS"}}"#);
        assert_eq!(success.events, vec![TransportEvent::TurnEnded]);

        let failed = parse_antigravity_line(r#"{"event":"result","result":{"status":"ERROR"}}"#);
        assert!(matches!(failed.events.first(), Some(TransportEvent::Notice(_))));
        assert_eq!(failed.events.last(), Some(&TransportEvent::TurnEnded));
    }

    #[test]
    fn unknown_frames_are_bounded_notices_with_provider_and_schema() {
        let huge = format!(
            r#"{{"event":"unheard_of","payload":"{}"}}"#,
            "x".repeat(MAX_NOTICE_CHARS * 2)
        );
        let parsed = parse_antigravity_line(&huge);
        let Some(TransportEvent::Notice(notice)) = parsed.events.first() else {
            panic!("an unknown frame must be a notice");
        };
        assert!(notice.contains("antigravity"));
        assert!(notice.contains("unheard_of"));
        assert!(notice.contains("schema="));
        assert!(notice.chars().count() <= MAX_NOTICE_CHARS);

        let non_json = parse_antigravity_line(&"y".repeat(MAX_NOTICE_CHARS + 100));
        let Some(TransportEvent::Notice(notice)) = non_json.events.first() else {
            panic!("a non-JSON line must be a notice");
        };
        assert!(notice.contains("non-json"));
        assert!(notice.chars().count() <= MAX_NOTICE_CHARS);
    }

    #[test]
    fn a_missing_binary_fails_before_a_process_starts() {
        let mut session = AntigravitySession::with_program(
            PersistentControls::default(),
            Some(PathBuf::from("kite-missing-agy-binary")),
        );

        let error = session.spawn(&spec("antigravity")).expect_err("no binary, no session");

        assert!(
            error.contains("could not start"),
            "the failure must name the missing launch: {error}"
        );
        assert_eq!(session.spawn_count(), 0);
        assert!(session.drain().is_empty());
    }

    #[test]
    fn only_antigravity_has_an_implemented_wire() {
        assert!(has_persistent_wire("antigravity"));
        assert!(has_persistent_wire("agy"));
        for driver in ["codex", "opencode", "claude", "gemini", "grok", "cursor", "unknown"] {
            assert!(!has_persistent_wire(driver), "{driver} has no wire in this build");
        }
    }
}
