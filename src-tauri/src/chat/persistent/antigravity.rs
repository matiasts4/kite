//! Lasting Antigravity (`agy`) session transport and frame handling.

use std::collections::VecDeque;
use std::fmt;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use serde_json::{json, Value};

use crate::chat::drivers::{declaration, DriverDeclaration, DriverProbe, SystemDriverProbe};
use crate::chat::runtime::bounded_notice;
use crate::chat::session::{SessionTransport, TransportEvent, TransportSpec};
use crate::chat::utils::resolve_bin;
use crate::hidden_exec::{spawn_streaming, HiddenChild};

use super::controls::{
    frame_schema, push_bounded, read_tail, tail_detail, verify_driver_version,
    ANTIGRAVITY_DRIVER, ANTIGRAVITY_STREAM_ARGS, PersistentControls,
};

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
            if declared.accepts_permission {
                args.push("--dangerously-skip-permissions".to_string());
            }
        }
        Some("acceptEdits") if declared.has_work_mode("accept-edits") => {
            args.push("--mode".to_string());
            args.push("accept-edits".to_string());
            if declared.accepts_permission {
                args.push("--dangerously-skip-permissions".to_string());
            }
        }
        Some("auto") if declared.accepts_permission => {
            args.push("--mode".to_string());
            args.push("auto".to_string());
            args.push("--dangerously-skip-permissions".to_string());
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
    let message = json!({
        "event": "user",
        "message": {
            "content": prompt
        }
    });
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
            if step_type == "user_input" {
                ParsedLine::default()
            } else if step_type == "agent_response" {
                let text = step
                    .get("text_delta")
                    .or_else(|| step.get("text"))
                    .or_else(|| step.get("content"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let thought = step
                    .get("thinking")
                    .or_else(|| step.get("thought"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if !text.is_empty() {
                    ParsedLine {
                        conversation_id: None,
                        events: vec![TransportEvent::Text(text.to_string())],
                    }
                } else if !thought.is_empty() {
                    ParsedLine {
                        conversation_id: None,
                        events: vec![TransportEvent::Activity(trimmed.to_string())],
                    }
                } else {
                    ParsedLine::default()
                }
            } else {
                ParsedLine {
                    conversation_id: None,
                    events: vec![TransportEvent::Activity(trimmed.to_string())],
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
            if let Some(err) = value.pointer("/result/error").and_then(Value::as_str) {
                let trimmed_err = err.trim();
                if !trimmed_err.is_empty() {
                    events.push(TransportEvent::Notice(bounded_notice(&format!(
                        "antigravity error: {trimmed_err}"
                    ))));
                }
            }
            if let Some(denied) = value.pointer("/result/denied_actions").and_then(Value::as_array) {
                if !denied.is_empty() {
                    let actions: Vec<&str> = denied
                        .iter()
                        .filter_map(|d| d.get("action").or_else(|| d.get("display_name")).and_then(Value::as_str))
                        .collect();
                    events.push(TransportEvent::Notice(bounded_notice(&format!(
                        "antigravity auto-denied tools in headless mode: {}",
                        actions.join(", ")
                    ))));
                }
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
    [
        "/conversation_id",
        "/conversationId",
        "/init/conversation_id",
        "/init/conversationId",
        "/init/session_id",
        "/init/sessionId",
    ]
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
    probe: Box<dyn DriverProbe>,
    child: Option<HiddenChild>,
    stdin: Option<Box<dyn Write + Send>>,
    reader: Option<JoinHandle<()>>,
    stderr_reader: Option<JoinHandle<()>>,
    stderr_tail: Arc<Mutex<String>>,
    events: Arc<Mutex<VecDeque<TransportEvent>>>,
    resume: Arc<Mutex<Option<String>>>,
    eof: Arc<AtomicBool>,
    stopping: bool,
    spawns: u32,
}

impl AntigravitySession {
    pub fn new(controls: PersistentControls) -> Self {
        Self::with_probe(controls, None, Box::new(SystemDriverProbe))
    }

    /// `program` is injectable so argv and failure behavior can be tested
    /// without resolving or starting a real provider.
    pub fn with_program(controls: PersistentControls, program: Option<PathBuf>) -> Self {
        Self::with_probe(controls, program, Box::new(SystemDriverProbe))
    }

    /// The version probe is injectable for the same reason as `program`: a test
    /// can decide the reported version without starting a process.
    pub fn with_probe(
        controls: PersistentControls,
        program: Option<PathBuf>,
        probe: Box<dyn DriverProbe>,
    ) -> Self {
        Self {
            controls,
            program,
            probe,
            child: None,
            stdin: None,
            reader: None,
            stderr_reader: None,
            stderr_tail: Arc::new(Mutex::new(String::new())),
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
        if let Some(reader) = self.stderr_reader.take() {
            let _ = reader.join();
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
        verify_driver_version(ANTIGRAVITY_DRIVER, &program, self.probe.as_ref())?;
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
        let stderr = child.stderr.take();

        self.stdin = child.stdin.take();
        self.child = Some(child);
        self.events.lock().unwrap().clear();
        *self.resume.lock().unwrap() = spec.resume_handle.clone();
        self.eof.store(false, Ordering::SeqCst);
        self.stopping = false;
        self.spawns += 1;

        let events = Arc::clone(&self.events);
        let resume = Arc::clone(&self.resume);
        let eof = Arc::clone(&self.eof);
        self.reader = Some(std::thread::spawn(move || {
            read_antigravity_stdout(stdout, events, resume, eof)
        }));

        let tail = Arc::new(Mutex::new(String::new()));
        self.stderr_tail = Arc::clone(&tail);
        self.stderr_reader = stderr.map(|mut pipe| {
            std::thread::spawn(move || read_tail(&mut pipe, tail))
        });
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

    fn write_frame(&mut self, frame: &str) -> Result<(), String> {
        if self.eof.load(Ordering::SeqCst) {
            return Err("the antigravity session ended before the frame was written".to_string());
        }
        let Some(stdin) = self.stdin.as_mut() else {
            return Err("the antigravity session has no open input".to_string());
        };
        let line = format!("{}\n", frame.trim_end());
        stdin.write_all(line.as_bytes()).map_err(|error| {
            format!("could not write the frame to the antigravity session: {error}")
        })?;
        stdin.flush().map_err(|error| {
            format!("could not flush the antigravity session input: {error}")
        })
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
                let tail = self
                    .stderr_tail
                    .lock()
                    .map(|tail| tail.clone())
                    .unwrap_or_default();
                let error = match code {
                    Some(0) => None,
                    Some(other) => Some(format!("antigravity exited with code {other}{}", tail_detail(&tail))),
                    None => None,
                };
                events.push(TransportEvent::Exit { code, error });
            }
            self.reader = None;
            self.stdin = None;
            if let Some(reader) = self.stderr_reader.take() {
                let _ = reader.join();
            }
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
