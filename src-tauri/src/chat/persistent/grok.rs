//! Lasting grok session transport over `agent stdio`.

use std::collections::VecDeque;
use std::fmt;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::chat::drivers::{declaration, DriverProbe, SystemDriverProbe};
use crate::chat::runtime::bounded_notice;
use crate::chat::session::{SessionTransport, TransportEvent, TransportSpec};
use crate::chat::utils::resolve_bin;
use crate::hidden_exec::{spawn_streaming, HiddenChild};

use super::antigravity::ParsedLine;
use super::controls::{
    frame_schema, grok_session_args, push_bounded, read_tail, verify_driver_version,
    GROK_DRIVER, GROK_HANDSHAKE_TIMEOUT, PersistentControls,
};

fn rpc_line(id: u64, method: &str, params: Value) -> String {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    })
    .to_string()
}

/// `initialize` for ACP stdio. Client `fs` and `terminal` overrides are omitted
/// so the provider executes its native filesystem and shell tools directly.
pub fn grok_initialize_line(id: u64) -> String {
    rpc_line(
        id,
        "initialize",
        json!({
            "protocolVersion": 1,
            "clientCapabilities": {}
        }),
    )
}

/// `session/new` as the installed session guide documents it. No `_meta`.
pub fn grok_session_new_line(id: u64, cwd: &str) -> String {
    rpc_line(
        id,
        "session/new",
        json!({
            "cwd": cwd,
            "mcpServers": []
        }),
    )
}

/// `session/load` as the installed session guide documents it.
pub fn grok_session_load_line(id: u64, session_id: &str, cwd: &str) -> String {
    rpc_line(
        id,
        "session/load",
        json!({
            "sessionId": session_id,
            "cwd": cwd,
            "mcpServers": []
        }),
    )
}

/// `session/set_config_option` for `model` or `reasoning_effort`.
pub fn grok_config_line(id: u64, session_id: &str, config_id: &str, value: &str) -> String {
    rpc_line(
        id,
        "session/set_config_option",
        json!({
            "sessionId": session_id,
            "configId": config_id,
            "value": { "value": value }
        }),
    )
}

/// `session/prompt` as the installed agent-mode example documents it.
pub fn grok_prompt_line(id: u64, session_id: &str, prompt: &str) -> String {
    rpc_line(
        id,
        "session/prompt",
        json!({
            "sessionId": session_id,
            "prompt": [{ "type": "text", "text": prompt }]
        }),
    )
}

fn trimmed_control(value: &Option<String>) -> Option<&str> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

/// Model, then effort, then the message. Each line is one documented request.
pub fn grok_turn_lines(
    session_id: &str,
    controls: &PersistentControls,
    prompt: &str,
    next_id: &mut u64,
) -> Vec<String> {
    let mut lines = Vec::new();
    if let Some(model) = trimmed_control(&controls.model) {
        lines.push(grok_config_line(*next_id, session_id, "model", model));
        *next_id += 1;
    }
    if let Some(effort) = trimmed_control(&controls.effort) {
        lines.push(grok_config_line(
            *next_id,
            session_id,
            "reasoning_effort",
            effort,
        ));
        *next_id += 1;
    }
    lines.push(grok_prompt_line(*next_id, session_id, prompt));
    *next_id += 1;
    lines
}

fn rpc_request_id(value: &Value) -> Option<String> {
    let id = value.get("id")?;
    if id.is_null() {
        return None;
    }
    if let Some(number) = id.as_u64() {
        return Some(number.to_string());
    }
    if let Some(number) = id.as_i64() {
        return Some(number.to_string());
    }
    let text = id.as_str()?.trim();
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}


fn json_id(value: &Value) -> Option<u64> {
    value.get("id").and_then(|id| {
        id.as_u64()
            .or_else(|| id.as_str().and_then(|text| text.parse().ok()))
    })
}

fn session_id_of(value: &Value) -> Option<String> {
    ["/result/sessionId", "/params/sessionId"]
        .iter()
        .filter_map(|pointer| value.pointer(pointer).and_then(Value::as_str))
        .map(str::trim)
        .find(|candidate| !candidate.is_empty())
        .map(str::to_string)
}

fn rpc_error_text(value: &Value) -> String {
    value
        .get("error")
        .and_then(|error| {
            error
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| error.as_str().map(str::to_string))
        })
        .unwrap_or_else(|| "no detail was reported".to_string())
}

/// One stdout line from `agent stdio`. A known message chunk becomes text.
/// A prompt response ends the turn. Anything else stays a notice.
pub fn parse_grok_line(line: &str, prompt_id: Option<u64>) -> ParsedLine {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return ParsedLine::default();
    }
    let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
        return ParsedLine {
            conversation_id: None,
            events: vec![TransportEvent::Notice(bounded_notice(&format!(
                "grok wrote a non-JSON line (schema=non-json): {trimmed}"
            )))],
        };
    };

    let id = json_id(&value);
    let method = value.get("method").and_then(Value::as_str);
    if method.is_none() && (value.get("result").is_some() || value.get("error").is_some()) {
        let conversation_id = session_id_of(&value);
        if prompt_id.is_some() && id == prompt_id {
            if value.get("error").is_some() {
                return ParsedLine {
                    conversation_id,
                    events: vec![TransportEvent::TurnFailed(bounded_notice(&format!(
                        "grok reported an error: {}",
                        rpc_error_text(&value)
                    )))],
                };
            }
            return ParsedLine {
                conversation_id,
                events: vec![TransportEvent::TurnEnded],
            };
        }
        return ParsedLine {
            conversation_id,
            events: Vec::new(),
        };
    }

    if matches!(
        method,
        Some("session/update") | Some("_x.ai/session/update") | Some("x.ai/session/update")
    ) {
        return parse_grok_update(trimmed, &value);
    }
    if matches!(
        method,
        Some("session/request_permission")
            | Some("permission/request")
            | Some("x.ai/ask_user_question")
            | Some("_x.ai/ask_user_question")
            | Some("AskUserQuestion")
            | Some("x.ai/exit_plan_mode")
            | Some("_x.ai/exit_plan_mode")
    ) {
        return ParsedLine {
            conversation_id: session_id_of(&value),
            events: vec![TransportEvent::Activity(trimmed.to_string())],
        };
    }

    if method.is_some() {
        if let Some(id) = rpc_request_id(&value) {
            return ParsedLine {
                conversation_id: session_id_of(&value),
                events: vec![TransportEvent::UnhandledRequest { id }],
            };
        }
    }

    ParsedLine {
        conversation_id: session_id_of(&value),
        events: vec![TransportEvent::Notice(bounded_notice(&format!(
            "grok sent an unknown frame (schema={})",
            frame_schema(&value)
        )))],
    }
}

fn parse_grok_update(raw: &str, value: &Value) -> ParsedLine {
    let update = value.pointer("/params/update").cloned().unwrap_or(Value::Null);
    let kind = update
        .get("sessionUpdate")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let text = update
        .pointer("/content/text")
        .and_then(Value::as_str)
        .unwrap_or("");
    let events = match kind {
        "agent_message_chunk" if !text.is_empty() => {
            vec![TransportEvent::Text(text.to_string())]
        }
        "agent_message_chunk" => Vec::new(),
        // These frames are actions. A notice is not drawn in the transcript.
        "agent_thought_chunk"
        | "tool_call"
        | "tool_call_update"
        | "tool_call_content_chunk"
        | "plan"
        | "plan_update"
        | "usage_update" => {
            vec![TransportEvent::Activity(raw.to_string())]
        }
        "turn_completed" | "turn_complete" => {
            let mut out = Vec::new();
            if update.get("usage").is_some() {
                out.push(TransportEvent::Activity(raw.to_string()));
            }
            out.push(TransportEvent::TurnEnded);
            out
        }
        "available_commands_update"
        | "session_info_update"
        | "hook_execution"
        | "config_option_update"
        | "current_mode_update"
        | "mode_update"
        | "commands_update"
        | "user_message_chunk" => Vec::new(),
        other => vec![TransportEvent::Notice(bounded_notice(&format!(
            "grok session update `{other}` is not projected (schema={})",
            frame_schema(&update)
        )))],
    };
    ParsedLine {
        conversation_id: session_id_of(value),
        events,
    }
}

/// Resolves the grok launcher. A missing binary is a hard error so the caller
/// keeps one command per turn instead of pretending a session exists.
pub fn resolve_grok_program() -> Result<PathBuf, String> {
    let home = crate::quota::utils::user_home_dir();
    let grok_user = home.join(".grok").join("bin").join("grok.exe");
    resolve_bin("grok", &[&grok_user.to_string_lossy()]).ok_or_else(|| {
        "grok is not installed; a lasting session cannot start without it".to_string()
    })
}

/// Lines a test session wrote, and the argv of the one process it spawned.
#[derive(Debug, Clone, Default)]
pub struct GrokRecord {
    inner: Arc<Mutex<GrokRecordState>>,
}

#[derive(Debug, Default)]
struct GrokRecordState {
    spawns: u32,
    args: Vec<String>,
    written: Vec<String>,
}

impl GrokRecord {
    fn new() -> Self {
        Self::default()
    }

    pub fn spawn_count(&self) -> u32 {
        self.inner.lock().map(|state| state.spawns).unwrap_or(0)
    }

    pub fn args(&self) -> Vec<String> {
        self.inner
            .lock()
            .map(|state| state.args.clone())
            .unwrap_or_default()
    }

    pub fn written(&self) -> Vec<String> {
        self.inner
            .lock()
            .map(|state| state.written.clone())
            .unwrap_or_default()
    }

    fn note_spawn(&self, args: &[String]) {
        if let Ok(mut state) = self.inner.lock() {
            state.spawns += 1;
            state.args = args.to_vec();
        }
    }

    fn note_written(&self, lines: &[String]) {
        if let Ok(mut state) = self.inner.lock() {
            state.written.extend(lines.iter().cloned());
        }
    }
}

/// One grok process on `agent stdio`. A second turn writes to that process.
pub struct GrokSession {
    controls: PersistentControls,
    program: Option<PathBuf>,
    probe: Box<dyn DriverProbe>,
    record: Option<GrokRecord>,
    child: Option<HiddenChild>,
    stdin: Option<Box<dyn Write + Send>>,
    reader: Option<JoinHandle<()>>,
    events: Arc<Mutex<VecDeque<TransportEvent>>>,
    responses: Arc<Mutex<VecDeque<Value>>>,
    ready: Arc<Condvar>,
    resume: Arc<Mutex<Option<String>>>,
    prompt_id: Arc<Mutex<Option<u64>>>,
    eof: Arc<AtomicBool>,
    stopping: bool,
    spawns: u32,
    next_id: u64,
}

impl GrokSession {
    pub fn new(controls: PersistentControls) -> Self {
        Self::with_probe(controls, None, Box::new(SystemDriverProbe))
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
            record: None,
            child: None,
            stdin: None,
            reader: None,
            events: Arc::new(Mutex::new(VecDeque::new())),
            responses: Arc::new(Mutex::new(VecDeque::new())),
            ready: Arc::new(Condvar::new()),
            resume: Arc::new(Mutex::new(None)),
            prompt_id: Arc::new(Mutex::new(None)),
            eof: Arc::new(AtomicBool::new(false)),
            stopping: false,
            spawns: 0,
            next_id: 1,
        }
    }

    /// Records argv and session frames without starting a process.
    #[cfg(test)]
    pub fn recorded(controls: PersistentControls) -> (Self, GrokRecord) {
        let record = GrokRecord::new();
        let mut session = Self::with_probe(
            controls,
            Some(PathBuf::from("kite-recorded-grok")),
            Box::new(RecordedProbe),
        );
        session.record = Some(record.clone());
        (session, record)
    }

    fn alloc_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    fn provider_session_id(&self) -> Option<String> {
        self.resume.lock().ok().and_then(|handle| handle.clone())
    }

    fn stop_process(&mut self) {
        self.stopping = true;
        self.stdin = None;
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
        }
    }

    fn fail_start(&mut self, reason: String) -> Result<(), String> {
        self.stop_process();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
        if let Ok(mut handle) = self.resume.lock() {
            *handle = None;
        }
        Err(reason)
    }

    fn checked_launch(&self, spec: &TransportSpec) -> Result<(PathBuf, Vec<String>), String> {
        let declared = declaration(&spec.driver)
            .ok_or_else(|| format!("{} has no driver declaration in this build", spec.driver))?;
        if declared.driver != GROK_DRIVER {
            return Err(format!("{} does not speak the grok stdio wire", spec.driver));
        }
        let program = match self.program.clone() {
            Some(program) => program,
            None => resolve_grok_program()?,
        };
        verify_driver_version(GROK_DRIVER, &program, self.probe.as_ref())?;
        let args = grok_session_args(self.controls.permission_mode.as_deref());
        Ok((program, args))
    }

    fn spawn_recorded(&mut self, spec: &TransportSpec) -> Result<(), String> {
        let (_program, args) = self.checked_launch(spec)?;
        let record = self
            .record
            .clone()
            .ok_or_else(|| "the recorded grok session has no record".to_string())?;
        let session_id = spec
            .resume_handle
            .clone()
            .filter(|handle| !handle.trim().is_empty())
            .unwrap_or_else(|| "recorded-session".to_string());
        if let Ok(mut handle) = self.resume.lock() {
            *handle = Some(session_id);
        }
        record.note_spawn(&args);
        self.spawns += 1;
        self.stopping = false;
        self.eof.store(false, Ordering::SeqCst);
        Ok(())
    }

    fn write_raw(&mut self, frame: &str) -> Result<(), String> {
        let Some(stdin) = self.stdin.as_mut() else {
            return Err("the grok session has no open input".to_string());
        };
        stdin.write_all(frame.as_bytes()).map_err(|error| {
            format!("could not write the message to the grok session: {error}")
        })?;
        stdin.write_all(b"\n").map_err(|error| {
            format!("could not write the message to the grok session: {error}")
        })?;
        stdin
            .flush()
            .map_err(|error| format!("could not flush the grok session input: {error}"))
    }

    fn wait_response(&self, id: u64) -> Result<Value, String> {
        let deadline = Instant::now() + GROK_HANDSHAKE_TIMEOUT;
        let mut queue = self
            .responses
            .lock()
            .map_err(|_| "the session queue lock was poisoned".to_string())?;
        loop {
            if let Some(index) = queue.iter().position(|value| json_id(value) == Some(id)) {
                return Ok(queue.remove(index).expect("the matched response is present"));
            }
            if self.eof.load(Ordering::SeqCst) {
                return Err("the session ended before it answered".to_string());
            }
            let now = Instant::now();
            if now >= deadline {
                return Err(format!(
                    "the session did not answer within {} ms",
                    GROK_HANDSHAKE_TIMEOUT.as_millis()
                ));
            }
            let (next, _) = self
                .ready
                .wait_timeout(queue, deadline - now)
                .map_err(|_| "the session queue lock was poisoned".to_string())?;
            queue = next;
        }
    }

    fn open_session(&mut self, spec: &TransportSpec) -> Result<(), String> {
        let cwd = spec
            .working_directory
            .as_deref()
            .map(str::trim)
            .filter(|cwd| !cwd.is_empty())
            .unwrap_or(".");
        let init_id = self.alloc_id();
        self.write_raw(&grok_initialize_line(init_id))?;
        let initialized = self.wait_response(init_id)?;
        if initialized.get("error").is_some() {
            return Err(format!(
                "the grok session refused initialize: {}",
                rpc_error_text(&initialized)
            ));
        }
        let open_id = self.alloc_id();
        let open = if let Some(handle) = spec
            .resume_handle
            .as_deref()
            .map(str::trim)
            .filter(|handle| !handle.is_empty())
        {
            grok_session_load_line(open_id, handle, cwd)
        } else {
            grok_session_new_line(open_id, cwd)
        };
        self.write_raw(&open)?;
        let opened = self.wait_response(open_id)?;
        if opened.get("error").is_some() {
            return Err(format!(
                "the grok session refused to open: {}",
                rpc_error_text(&opened)
            ));
        }
        let session_id = session_id_of(&opened).or_else(|| {
            spec.resume_handle
                .as_deref()
                .map(str::trim)
                .filter(|handle| !handle.is_empty())
                .map(str::to_string)
        });
        let Some(session_id) = session_id else {
            return Err("the grok session did not return a session id".to_string());
        };
        if let Ok(mut handle) = self.resume.lock() {
            *handle = Some(session_id);
        }
        Ok(())
    }
}

impl fmt::Debug for GrokSession {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GrokSession")
            .field("controls", &self.controls)
            .field("program", &self.program)
            .field("spawns", &self.spawns)
            .finish()
    }
}

impl SessionTransport for GrokSession {
    fn spawn(&mut self, spec: &TransportSpec) -> Result<(), String> {
        if self.record.is_some() {
            return self.spawn_recorded(spec);
        }
        if let Some(reader) = self.reader.take() {
            if reader.is_finished() {
                // The process is gone; the handle is reaped below.
            } else if self.stopping {
                let _ = reader.join();
            } else {
                self.reader = Some(reader);
                return Err("the grok session already has a running process".to_string());
            }
        }
        if let Some(mut child) = self.child.take() {
            let _ = child.wait();
        }
        self.stdin = None;

        let (program, args) = self.checked_launch(spec)?;
        let args_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let cwd = spec.working_directory.as_deref().map(Path::new);
        let mut child = spawn_streaming(&program, &args_refs, cwd).map_err(|error| {
            format!(
                "could not start the grok session with {}: {error}",
                program.display()
            )
        })?;
        let Some(stdout) = child.stdout.take() else {
            let _ = child.kill();
            return Err("the grok session started without a readable stdout".to_string());
        };
        let stderr = child.stderr.take();
        self.stdin = child.stdin.take();
        self.child = Some(child);
        self.events.lock().unwrap().clear();
        self.responses.lock().unwrap().clear();
        self.eof.store(false, Ordering::SeqCst);
        self.stopping = false;
        self.next_id = 1;

        let events = Arc::clone(&self.events);
        let responses = Arc::clone(&self.responses);
        let ready = Arc::clone(&self.ready);
        let resume = Arc::clone(&self.resume);
        let prompt_id = Arc::clone(&self.prompt_id);
        let eof = Arc::clone(&self.eof);
        self.reader = Some(std::thread::spawn(move || {
            read_grok_stdout(stdout, events, responses, ready, resume, prompt_id, eof)
        }));
        if let Some(mut stderr) = stderr {
            std::thread::spawn(move || {
                let tail = Arc::new(Mutex::new(String::new()));
                read_tail(&mut stderr, tail);
            });
        }

        if let Err(reason) = self.open_session(spec) {
            return self.fail_start(reason);
        }
        self.spawns += 1;
        Ok(())
    }

    fn write_frame(&mut self, frame: &str) -> Result<(), String> {
        self.write_raw(frame.trim_end())
    }

    fn write_turn(&mut self, prompt: &str) -> Result<(), String> {
        let session_id = self
            .provider_session_id()
            .ok_or_else(|| "the grok session has no id, so the message was not written".to_string())?;
        let lines = grok_turn_lines(&session_id, &self.controls, prompt, &mut self.next_id);
        let prompt_line_id = self.next_id.saturating_sub(1);
        if let Some(record) = &self.record {
            record.note_written(&lines);
            return Ok(());
        }
        if self.eof.load(Ordering::SeqCst) {
            return Err("the grok session ended before the message was written".to_string());
        }
        if let Ok(mut id) = self.prompt_id.lock() {
            *id = Some(prompt_line_id);
        }
        for line in &lines {
            self.write_raw(line)?;
        }
        Ok(())
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
        self.provider_session_id()
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
                    Some(other) => Some(format!("grok exited with code {other}")),
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

impl Drop for GrokSession {
    fn drop(&mut self) {
        self.stdin = None;
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
        }
    }
}

#[cfg(test)]
#[derive(Debug)]
struct RecordedProbe;

#[cfg(test)]
impl DriverProbe for RecordedProbe {
    fn probe(
        &self,
        _driver: &str,
        _program: &Path,
        _evidence: &crate::chat::drivers::DriverVersion,
    ) -> Result<String, String> {
        Ok("grok 1.0.77 (50ca579fa996)".to_string())
    }
}

fn read_grok_stdout(
    stdout: Box<dyn Read + Send>,
    events: Arc<Mutex<VecDeque<TransportEvent>>>,
    responses: Arc<Mutex<VecDeque<Value>>>,
    ready: Arc<Condvar>,
    resume: Arc<Mutex<Option<String>>>,
    prompt_id: Arc<Mutex<Option<u64>>>,
    eof: Arc<AtomicBool>,
) {
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {
                let current = prompt_id.lock().ok().and_then(|id| *id);
                let parsed = parse_grok_line(&line, current);
                if let Some(conversation) = parsed.conversation_id.clone() {
                    if let Ok(mut handle) = resume.lock() {
                        *handle = Some(conversation);
                    }
                }
                if let Ok(value) = serde_json::from_str::<Value>(line.trim()) {
                    if value.get("method").is_none()
                        && (value.get("result").is_some() || value.get("error").is_some())
                    {
                        if let Ok(mut queue) = responses.lock() {
                            queue.push_back(value);
                        }
                        ready.notify_all();
                    }
                }
                if let Ok(mut queue) = events.lock() {
                    for event in parsed.events {
                        if matches!(
                            event,
                            TransportEvent::TurnEnded | TransportEvent::TurnFailed(_)
                        ) {
                            if let Ok(mut id) = prompt_id.lock() {
                                *id = None;
                            }
                        }
                        push_bounded(&mut queue, event);
                    }
                }
            }
            Err(_) => break,
        }
    }
    eof.store(true, Ordering::SeqCst);
    ready.notify_all();
}
