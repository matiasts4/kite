//! Persistent warm `agy --input-format stream-json` transport for the Zed Operator.
//! Reuses one headless Antigravity CLI process across turns so repeated commands avoid
//! cold CLI/auth/workspace startup overhead, while cleaning up on timeout, model switch,
//! turn cap, 5-minute idle TTL, or application exit.

use crate::chat::persistent::antigravity::{parse_antigravity_line, turn_line};
use crate::chat::persistent::controls::ANTIGRAVITY_STREAM_ARGS;
use crate::chat::session::TransportEvent;
use crate::chat::threads::sanitize_chat_text;
use crate::hidden_exec::{self, HiddenChild};
use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

const WARM_ANTIGRAVITY_MAX_TURNS: u32 = 24;
const WARM_ANTIGRAVITY_IDLE_TTL: Duration = Duration::from_secs(300);
const WARM_STDERR_TAIL_LIMIT: usize = 2048;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TurnRecvError {
    Timeout,
    Broken(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WarmTurnError {
    pub(crate) message: String,
    pub(crate) timed_out: bool,
}

pub(crate) trait StreamSessionIO: Send {
    fn write_line(&mut self, line: &str) -> Result<(), String>;
    fn recv_line(&mut self, timeout: Duration) -> Result<Option<String>, TurnRecvError>;
    fn stderr_tail(&self) -> String;
    fn kill_and_wait(&mut self);
}

struct WarmEntry {
    bin: PathBuf,
    model: Option<String>,
    turn_count: u32,
    last_used: Instant,
    io: Box<dyn StreamSessionIO>,
}

#[derive(Default)]
struct WarmSlotState {
    entry: Option<WarmEntry>,
    shutting_down: bool,
    reaper_running: bool,
}

pub(crate) struct WarmAntigravityPool {
    turn_lock: Mutex<()>,
    slot: Arc<(Mutex<WarmSlotState>, Condvar)>,
    max_turns: u32,
    idle_ttl: Duration,
}

impl WarmAntigravityPool {
    pub(crate) fn new(max_turns: u32, idle_ttl: Duration) -> Self {
        Self {
            turn_lock: Mutex::new(()),
            slot: Arc::new((Mutex::new(WarmSlotState::default()), Condvar::new())),
            max_turns,
            idle_ttl,
        }
    }

    pub(crate) fn execute_turn(
        &self,
        spawner: &dyn Fn(&Path, Option<&str>) -> Result<Box<dyn StreamSessionIO>, String>,
        bin: &Path,
        model: Option<&str>,
        prompt: &str,
        timeout: Duration,
    ) -> Result<String, WarmTurnError> {
        let _turn_guard = self.turn_lock.lock().unwrap_or_else(|p| p.into_inner());
        let normalized_model = model.map(str::trim).filter(|s| !s.is_empty());

        let mut taken = self.take_matching_or_kill_stale(bin, normalized_model)?;
        let deadline = Instant::now() + timeout;

        for attempt in 0..2 {
            let was_reused = taken.is_some();
            let mut entry = match taken.take() {
                Some(existing) => existing,
                None => {
                    let io = spawner(bin, normalized_model).map_err(|message| WarmTurnError {
                        message,
                        timed_out: false,
                    })?;
                    WarmEntry {
                        bin: bin.to_path_buf(),
                        model: normalized_model.map(str::to_string),
                        turn_count: 0,
                        last_used: Instant::now(),
                        io,
                    }
                }
            };

            if let Err(err) = entry.io.write_line(&turn_line(prompt)) {
                let tail = entry.io.stderr_tail();
                entry.io.kill_and_wait();
                if was_reused && attempt == 0 {
                    continue;
                }
                return Err(WarmTurnError {
                    message: format_io_error("Error enviando prompt a Antigravity", &err, &tail),
                    timed_out: false,
                });
            }

            let mut accumulated = String::new();
            let mut saw_delta = false;

            loop {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    entry.io.kill_and_wait();
                    return Err(WarmTurnError {
                        message: "Tiempo de espera agotado".to_string(),
                        timed_out: true,
                    });
                }

                match entry.io.recv_line(remaining) {
                    Ok(Some(line)) => {
                        if let Some(chunk) = extract_antigravity_step_delta(&line, &mut saw_delta) {
                            accumulated.push_str(&chunk);
                        }
                        let parsed = parse_antigravity_line(&line);
                        for ev in parsed.events {
                            match ev {
                                TransportEvent::TurnEnded => {
                                    entry.turn_count += 1;
                                    entry.last_used = Instant::now();
                                    self.park_entry(entry);
                                    return Ok(sanitize_chat_text(&accumulated).trim().to_string());
                                }
                                TransportEvent::TurnFailed(reason) => {
                                    let tail = entry.io.stderr_tail();
                                    entry.io.kill_and_wait();
                                    return Err(WarmTurnError {
                                        message: format_io_error(
                                            "Error en antigravity",
                                            &reason,
                                            &tail,
                                        ),
                                        timed_out: false,
                                    });
                                }
                                _ => {}
                            }
                        }
                    }
                    Ok(None) => {
                        let tail = entry.io.stderr_tail();
                        entry.io.kill_and_wait();
                        if was_reused && attempt == 0 && accumulated.is_empty() {
                            break;
                        }
                        return Err(WarmTurnError {
                            message: format_io_error(
                                "Antigravity CLI cerró la sesión inesperadamente",
                                "",
                                &tail,
                            ),
                            timed_out: false,
                        });
                    }
                    Err(TurnRecvError::Timeout) => {
                        entry.io.kill_and_wait();
                        return Err(WarmTurnError {
                            message: "Tiempo de espera agotado".to_string(),
                            timed_out: true,
                        });
                    }
                    Err(TurnRecvError::Broken(err)) => {
                        let tail = entry.io.stderr_tail();
                        entry.io.kill_and_wait();
                        if was_reused && attempt == 0 && accumulated.is_empty() {
                            break;
                        }
                        return Err(WarmTurnError {
                            message: format_io_error(
                                "Fallo leyendo respuesta de Antigravity CLI",
                                &err,
                                &tail,
                            ),
                            timed_out: false,
                        });
                    }
                }
            }
        }

        Err(WarmTurnError {
            message: "No se pudo completar el turno en Antigravity CLI.".to_string(),
            timed_out: false,
        })
    }

    fn take_matching_or_kill_stale(
        &self,
        bin: &Path,
        model: Option<&str>,
    ) -> Result<Option<WarmEntry>, WarmTurnError> {
        let (lock, _) = &*self.slot;
        let (matched, stale) = {
            let mut state = lock.lock().unwrap_or_else(|p| p.into_inner());
            if state.shutting_down {
                return Err(WarmTurnError {
                    message: "Kite se está cerrando.".to_string(),
                    timed_out: false,
                });
            }
            match state.entry.take() {
                Some(entry)
                    if entry.bin == bin
                        && entry.model.as_deref() == model
                        && entry.turn_count < self.max_turns
                        && entry.last_used.elapsed() < self.idle_ttl =>
                {
                    (Some(entry), None)
                }
                other => (None, other),
            }
        };
        if let Some(mut old) = stale {
            old.io.kill_and_wait();
        }
        Ok(matched)
    }

    fn park_entry(&self, mut entry: WarmEntry) {
        let (lock, cvar) = &*self.slot;
        let should_spawn_reaper = {
            let mut state = lock.lock().unwrap_or_else(|p| p.into_inner());
            if state.shutting_down {
                drop(state);
                entry.io.kill_and_wait();
                return;
            }
            state.entry = Some(entry);
            cvar.notify_all();
            if !state.reaper_running {
                state.reaper_running = true;
                true
            } else {
                false
            }
        };

        if should_spawn_reaper {
            let slot_arc = Arc::clone(&self.slot);
            let idle_ttl = self.idle_ttl;
            let _ = std::thread::Builder::new()
                .name("operator-agy-reaper".to_string())
                .spawn(move || {
                    let (lock, cvar) = &*slot_arc;
                    loop {
                        let expired_entry = {
                            let mut state = lock.lock().unwrap_or_else(|p| p.into_inner());
                            loop {
                                if state.shutting_down {
                                    state.reaper_running = false;
                                    return;
                                }
                                let Some(ref current) = state.entry else {
                                    state.reaper_running = false;
                                    return;
                                };
                                let elapsed = current.last_used.elapsed();
                                if elapsed >= idle_ttl {
                                    break state.entry.take();
                                }
                                let wait_for = idle_ttl.saturating_sub(elapsed);
                                let (next_state, _) = cvar
                                    .wait_timeout(state, wait_for)
                                    .unwrap_or_else(|p| p.into_inner());
                                state = next_state;
                            }
                        };
                        if let Some(mut stale) = expired_entry {
                            stale.io.kill_and_wait();
                        }
                    }
                });
        }
    }

    pub(crate) fn shutdown(&self) {
        let (lock, cvar) = &*self.slot;
        let stale = {
            let mut state = lock.lock().unwrap_or_else(|p| p.into_inner());
            state.shutting_down = true;
            cvar.notify_all();
            state.entry.take()
        };
        if let Some(mut entry) = stale {
            entry.io.kill_and_wait();
        }
    }
}

fn format_io_error(prefix: &str, detail: &str, tail: &str) -> String {
    let mut msg = if detail.trim().is_empty() {
        prefix.to_string()
    } else {
        format!("{prefix}: {}", detail.trim())
    };
    let clean_tail = tail.trim();
    if !clean_tail.is_empty() && !msg.contains(clean_tail) {
        msg.push_str(&format!(" ({clean_tail})"));
    }
    msg
}

fn extract_antigravity_step_delta(line: &str, saw_delta: &mut bool) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    let val: Value = serde_json::from_str(trimmed).ok()?;
    if val.get("event").and_then(Value::as_str) != Some("step_update") {
        return None;
    }
    let su = val.get("step_update")?;
    let step_type = su.get("step_type").and_then(Value::as_str).unwrap_or("");
    if step_type != "agent_response" && step_type != "planner_response" {
        return None;
    }
    if let Some(delta) = su.get("text_delta").and_then(Value::as_str) {
        if !delta.is_empty() {
            *saw_delta = true;
            return Some(delta.to_string());
        }
    }
    if !*saw_delta {
        if let Some(full) = su
            .get("text")
            .or_else(|| su.get("content"))
            .and_then(Value::as_str)
        {
            if !full.is_empty() {
                return Some(full.to_string());
            }
        }
    }
    None
}

struct RealHiddenChildIO {
    child: HiddenChild,
    stdin: Option<Box<dyn Write + Send>>,
    rx: Receiver<Result<String, String>>,
    stderr_tail: Arc<Mutex<String>>,
    stdout_thread: Option<JoinHandle<()>>,
    stderr_thread: Option<JoinHandle<()>>,
}

impl RealHiddenChildIO {
    pub(crate) fn spawn(bin: &Path, model: Option<&str>) -> Result<Box<dyn StreamSessionIO>, String> {
        let mut args: Vec<&str> = ANTIGRAVITY_STREAM_ARGS.to_vec();
        args.push("--disable-slash-commands");
        if let Some(m) = model.map(str::trim).filter(|s| !s.is_empty()) {
            args.push("--model");
            args.push(m);
        }
        let cwd = std::env::temp_dir();
        let mut child = hidden_exec::spawn_streaming(bin, &args, Some(&cwd))
            .map_err(|e| format!("Error ejecutando antigravity: {e}"))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Antigravity CLI no expuso stdin.".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Antigravity CLI no expuso stdout.".to_string())?;
        let stderr = child.stderr.take();

        let (tx, rx) = mpsc::channel();
        let stdout_thread = std::thread::Builder::new()
            .name("operator-agy-stdout".to_string())
            .spawn(move || {
                let mut reader = BufReader::new(stdout);
                let mut line = String::new();
                loop {
                    line.clear();
                    match reader.read_line(&mut line) {
                        Ok(0) => break,
                        Ok(_) => {
                            if tx.send(Ok(std::mem::take(&mut line))).is_err() {
                                break;
                            }
                        }
                        Err(err) => {
                            let _ = tx.send(Err(err.to_string()));
                            break;
                        }
                    }
                }
            })
            .map_err(|e| format!("No se pudo iniciar lector stdout de antigravity: {e}"))?;

        let stderr_tail = Arc::new(Mutex::new(String::new()));
        let stderr_thread = stderr.and_then(|mut err_pipe| {
            let tail_ref = Arc::clone(&stderr_tail);
            std::thread::Builder::new()
                .name("operator-agy-stderr".to_string())
                .spawn(move || {
                    let mut buf = [0u8; 1024];
                    loop {
                        match err_pipe.read(&mut buf) {
                            Ok(0) | Err(_) => break,
                            Ok(n) => {
                                let text = String::from_utf8_lossy(&buf[..n]);
                                let mut guard = tail_ref.lock().unwrap_or_else(|p| p.into_inner());
                                guard.push_str(&text);
                                if guard.len() > WARM_STDERR_TAIL_LIMIT {
                                    let mut start = guard.len() - WARM_STDERR_TAIL_LIMIT;
                                    while !guard.is_char_boundary(start) && start < guard.len() {
                                        start += 1;
                                    }
                                    guard.drain(..start);
                                }
                            }
                        }
                    }
                })
                .ok()
        });

        Ok(Box::new(Self {
            child,
            stdin: Some(stdin),
            rx,
            stderr_tail,
            stdout_thread: Some(stdout_thread),
            stderr_thread,
        }))
    }
}

impl StreamSessionIO for RealHiddenChildIO {
    fn write_line(&mut self, line: &str) -> Result<(), String> {
        let Some(ref mut stdin) = self.stdin else {
            return Err("stdin cerrado".to_string());
        };
        stdin
            .write_all(line.as_bytes())
            .and_then(|_| stdin.flush())
            .map_err(|e| e.to_string())
    }

    fn recv_line(&mut self, timeout: Duration) -> Result<Option<String>, TurnRecvError> {
        match self.rx.recv_timeout(timeout) {
            Ok(Ok(line)) => Ok(Some(line)),
            Ok(Err(err)) => Err(TurnRecvError::Broken(err)),
            Err(RecvTimeoutError::Timeout) => Err(TurnRecvError::Timeout),
            Err(RecvTimeoutError::Disconnected) => Ok(None),
        }
    }

    fn stderr_tail(&self) -> String {
        self.stderr_tail
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    fn kill_and_wait(&mut self) {
        self.stdin.take();
        let _ = self.child.kill();
        if let Some(handle) = self.stdout_thread.take() {
            let _ = handle.join();
        }
        if let Some(handle) = self.stderr_thread.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for RealHiddenChildIO {
    fn drop(&mut self) {
        self.kill_and_wait();
    }
}

static WARM_ANTIGRAVITY_POOL: OnceLock<WarmAntigravityPool> = OnceLock::new();

pub(crate) fn run_warm_antigravity_turn(
    bin: &Path,
    model: Option<&str>,
    prompt: &str,
    timeout: Duration,
) -> Result<String, WarmTurnError> {
    let pool = WARM_ANTIGRAVITY_POOL.get_or_init(|| {
        WarmAntigravityPool::new(WARM_ANTIGRAVITY_MAX_TURNS, WARM_ANTIGRAVITY_IDLE_TTL)
    });
    pool.execute_turn(&RealHiddenChildIO::spawn, bin, model, prompt, timeout)
}

pub fn shutdown_warm_operator_sessions() {
    if let Some(pool) = WARM_ANTIGRAVITY_POOL.get() {
        pool.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicUsize, Ordering};

    enum FakeAction {
        Lines(Vec<Result<Option<String>, TurnRecvError>>),
        WriteErr(&'static str),
    }

    struct FakeIO {
        script: Arc<Mutex<VecDeque<FakeAction>>>,
        written: Arc<Mutex<Vec<String>>>,
        kills: Arc<AtomicUsize>,
        pending: VecDeque<Result<Option<String>, TurnRecvError>>,
    }

    impl StreamSessionIO for FakeIO {
        fn write_line(&mut self, line: &str) -> Result<(), String> {
            self.written.lock().unwrap().push(line.to_string());
            let next = self.script.lock().unwrap().pop_front();
            match next {
                Some(FakeAction::WriteErr(msg)) => Err(msg.to_string()),
                Some(FakeAction::Lines(lines)) => {
                    self.pending.extend(lines);
                    Ok(())
                }
                None => Ok(()),
            }
        }

        fn recv_line(&mut self, _timeout: Duration) -> Result<Option<String>, TurnRecvError> {
            self.pending.pop_front().unwrap_or(Ok(None))
        }

        fn stderr_tail(&self) -> String {
            String::new()
        }

        fn kill_and_wait(&mut self) {
            self.kills.fetch_add(1, Ordering::SeqCst);
        }
    }

    fn make_spawner(
        spawns: Arc<AtomicUsize>,
        kills: Arc<AtomicUsize>,
        models_seen: Arc<Mutex<Vec<Option<String>>>>,
        written: Arc<Mutex<Vec<String>>>,
        scripts: Arc<Mutex<VecDeque<VecDeque<FakeAction>>>>,
    ) -> impl Fn(&Path, Option<&str>) -> Result<Box<dyn StreamSessionIO>, String> {
        move |_bin, model| {
            spawns.fetch_add(1, Ordering::SeqCst);
            models_seen.lock().unwrap().push(model.map(str::to_string));
            let script = scripts.lock().unwrap().pop_front().unwrap_or_default();
            Ok(Box::new(FakeIO {
                script: Arc::new(Mutex::new(script)),
                written: Arc::clone(&written),
                kills: Arc::clone(&kills),
                pending: VecDeque::new(),
            }))
        }
    }

    fn ok_turn_lines(chunks: &[&str]) -> Vec<Result<Option<String>, TurnRecvError>> {
        let mut lines = vec![Ok(Some(
            r#"{"event":"init","init":{"conversation_id":"conv-1"}}"#.to_string(),
        ))];
        for chunk in chunks {
            lines.push(Ok(Some(
                json!({
                    "event": "step_update",
                    "step_update": {
                        "step_index": 2,
                        "step_type": "agent_response",
                        "state": "ACTIVE",
                        "text_delta": chunk
                    }
                })
                .to_string(),
            )));
        }
        lines.push(Ok(Some(
            r#"{"event":"result","result":{"status":"SUCCESS"}}"#.to_string(),
        )));
        lines
    }

    #[test]
    fn test_warm_antigravity_reuses_session_and_replaces_on_model_change() {
        let pool = WarmAntigravityPool::new(24, Duration::from_secs(300));
        let spawns = Arc::new(AtomicUsize::new(0));
        let kills = Arc::new(AtomicUsize::new(0));
        let models = Arc::new(Mutex::new(Vec::new()));
        let written = Arc::new(Mutex::new(Vec::new()));

        let mut s1 = VecDeque::new();
        s1.push_back(FakeAction::Lines(ok_turn_lines(&[
            "{\"reply\":",
            "\"hola ",
            "mundo\",\"actions\":[]}",
        ])));
        s1.push_back(FakeAction::Lines(ok_turn_lines(&["OK"])));
        let mut s2 = VecDeque::new();
        s2.push_back(FakeAction::Lines(ok_turn_lines(&["NEON"])));

        let scripts = Arc::new(Mutex::new(VecDeque::from([s1, s2])));
        let spawner = make_spawner(
            Arc::clone(&spawns),
            Arc::clone(&kills),
            Arc::clone(&models),
            Arc::clone(&written),
            scripts,
        );

        let r1 = pool
            .execute_turn(
                &spawner,
                Path::new("agy"),
                Some("gemini-3.8-flash-low"),
                "turn 1",
                Duration::from_secs(5),
            )
            .unwrap();
        let r2 = pool
            .execute_turn(
                &spawner,
                Path::new("agy"),
                Some("gemini-3.8-flash-low"),
                "turn 2",
                Duration::from_secs(5),
            )
            .unwrap();
        let r3 = pool
            .execute_turn(
                &spawner,
                Path::new("agy"),
                Some("gemini-4-neon-low"),
                "turn 3",
                Duration::from_secs(5),
            )
            .unwrap();

        assert_eq!(r1, "{\"reply\":\"hola mundo\",\"actions\":[]}");
        assert_eq!(r2, "OK");
        assert_eq!(r3, "NEON");
        assert_eq!(spawns.load(Ordering::SeqCst), 2);
        assert_eq!(kills.load(Ordering::SeqCst), 1);
        assert_eq!(
            *models.lock().unwrap(),
            vec![
                Some("gemini-3.8-flash-low".to_string()),
                Some("gemini-4-neon-low".to_string())
            ]
        );
        pool.shutdown();
        assert_eq!(kills.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn test_warm_antigravity_kills_on_timeout_and_respawns_dead_warm_child() {
        let pool = WarmAntigravityPool::new(24, Duration::from_secs(300));
        let spawns = Arc::new(AtomicUsize::new(0));
        let kills = Arc::new(AtomicUsize::new(0));
        let models = Arc::new(Mutex::new(Vec::new()));
        let written = Arc::new(Mutex::new(Vec::new()));

        let mut s1 = VecDeque::new();
        s1.push_back(FakeAction::Lines(ok_turn_lines(&["ONE"])));
        s1.push_back(FakeAction::WriteErr("broken pipe"));
        let mut s2 = VecDeque::new();
        s2.push_back(FakeAction::Lines(ok_turn_lines(&["RECOVERED"])));
        s2.push_back(FakeAction::Lines(vec![Err(TurnRecvError::Timeout)]));
        let mut s3 = VecDeque::new();
        s3.push_back(FakeAction::Lines(ok_turn_lines(&["FRESH"])));

        let scripts = Arc::new(Mutex::new(VecDeque::from([s1, s2, s3])));
        let spawner = make_spawner(
            Arc::clone(&spawns),
            Arc::clone(&kills),
            Arc::clone(&models),
            Arc::clone(&written),
            scripts,
        );

        assert_eq!(
            pool.execute_turn(&spawner, Path::new("agy"), Some("m"), "1", Duration::from_secs(5))
                .unwrap(),
            "ONE"
        );
        assert_eq!(
            pool.execute_turn(&spawner, Path::new("agy"), Some("m"), "2", Duration::from_secs(5))
                .unwrap(),
            "RECOVERED"
        );
        let err = pool
            .execute_turn(&spawner, Path::new("agy"), Some("m"), "3", Duration::from_secs(5))
            .unwrap_err();
        assert!(err.timed_out);
        assert_eq!(
            pool.execute_turn(&spawner, Path::new("agy"), Some("m"), "4", Duration::from_secs(5))
                .unwrap(),
            "FRESH"
        );
        assert_eq!(spawns.load(Ordering::SeqCst), 3);
        assert_eq!(kills.load(Ordering::SeqCst), 2);
        pool.shutdown();
    }

    #[test]
    fn test_warm_antigravity_rotates_on_max_turns() {
        let pool = WarmAntigravityPool::new(2, Duration::from_secs(300));
        let spawns = Arc::new(AtomicUsize::new(0));
        let kills = Arc::new(AtomicUsize::new(0));
        let models = Arc::new(Mutex::new(Vec::new()));
        let written = Arc::new(Mutex::new(Vec::new()));

        let mut s1 = VecDeque::new();
        s1.push_back(FakeAction::Lines(ok_turn_lines(&["T1"])));
        s1.push_back(FakeAction::Lines(ok_turn_lines(&["T2"])));
        let mut s2 = VecDeque::new();
        s2.push_back(FakeAction::Lines(ok_turn_lines(&["T3"])));

        let scripts = Arc::new(Mutex::new(VecDeque::from([s1, s2])));
        let spawner = make_spawner(
            Arc::clone(&spawns),
            Arc::clone(&kills),
            Arc::clone(&models),
            Arc::clone(&written),
            scripts,
        );

        assert_eq!(
            pool.execute_turn(&spawner, Path::new("agy"), Some("m"), "1", Duration::from_secs(5))
                .unwrap(),
            "T1"
        );
        assert_eq!(
            pool.execute_turn(&spawner, Path::new("agy"), Some("m"), "2", Duration::from_secs(5))
                .unwrap(),
            "T2"
        );
        assert_eq!(
            pool.execute_turn(&spawner, Path::new("agy"), Some("m"), "3", Duration::from_secs(5))
                .unwrap(),
            "T3"
        );
        assert_eq!(spawns.load(Ordering::SeqCst), 2);
        assert_eq!(kills.load(Ordering::SeqCst), 1);
        pool.shutdown();
    }

    #[test]
    fn test_warm_antigravity_clears_session_on_turn_failed_and_ignores_thought_frames() {
        let pool = WarmAntigravityPool::new(24, Duration::from_secs(300));
        let spawns = Arc::new(AtomicUsize::new(0));
        let kills = Arc::new(AtomicUsize::new(0));
        let models = Arc::new(Mutex::new(Vec::new()));
        let written = Arc::new(Mutex::new(Vec::new()));

        let mut s1 = VecDeque::new();
        s1.push_back(FakeAction::Lines(vec![
            Ok(Some(
                r#"{"event":"step_update","step_update":{"step_index":1,"step_type":"thought","text":"secret thought"}}"#
                    .to_string(),
            )),
            Ok(Some(
                r#"{"event":"result","result":{"status":"ERROR","error":"quota exceeded"}}"#
                    .to_string(),
            )),
        ]));
        let mut s2 = VecDeque::new();
        s2.push_back(FakeAction::Lines(vec![
            Ok(Some(
                r#"{"event":"step_update","step_update":{"step_index":1,"step_type":"thought","text":"hidden"}}"#
                    .to_string(),
            )),
            Ok(Some(
                r#"{"event":"step_update","step_update":{"step_index":2,"step_type":"planner_response","text":"FULL_TEXT"}}"#
                    .to_string(),
            )),
            Ok(Some(
                r#"{"event":"result","result":{"status":"SUCCESS"}}"#.to_string(),
            )),
        ]));

        let scripts = Arc::new(Mutex::new(VecDeque::from([s1, s2])));
        let spawner = make_spawner(
            Arc::clone(&spawns),
            Arc::clone(&kills),
            Arc::clone(&models),
            Arc::clone(&written),
            scripts,
        );

        let err = pool
            .execute_turn(&spawner, Path::new("agy"), Some("m"), "1", Duration::from_secs(5))
            .unwrap_err();
        assert!(!err.timed_out);
        assert!(err.message.contains("quota exceeded"));

        let ok = pool
            .execute_turn(&spawner, Path::new("agy"), Some("m"), "2", Duration::from_secs(5))
            .unwrap();
        assert_eq!(ok, "FULL_TEXT");
        assert_eq!(spawns.load(Ordering::SeqCst), 2);
        assert_eq!(kills.load(Ordering::SeqCst), 1);
        pool.shutdown();
    }

    #[test]
    #[ignore = "live agy CLI latency verification"]
    fn test_live_warm_antigravity_operator_latency() {
        let t1 = crate::operator_runtime::query_operator_agent_direct(json!({
            "engine": "antigravity",
            "model": "gemini-3.8-flash-low",
            "prompt": "Responde solo: OK",
            "timeoutSecs": 25
        }));
        let t2 = crate::operator_runtime::query_operator_agent_direct(json!({
            "engine": "antigravity",
            "model": "gemini-3.8-flash-low",
            "prompt": "Responde solo con JSON valido: {\"reply\":\"Abriendo terminales\",\"actions\":[{\"type\":\"open_terminals\",\"count\":2,\"engine\":\"powershell\"}]}",
            "timeoutSecs": 25
        }));
        let t3 = crate::operator_runtime::query_operator_agent_direct(json!({
            "engine": "antigravity",
            "model": "gemini-3.8-flash-low",
            "prompt": "Responde solo con JSON valido: {\"reply\":\"Listo\",\"actions\":[]}",
            "timeoutSecs": 25
        }));
        println!("LIVE T1 (cold): {t1}");
        println!("LIVE T2 (warm): {t2}");
        println!("LIVE T3 (warm): {t3}");
        shutdown_warm_operator_sessions();
        assert_eq!(t1["success"], true);
        assert_eq!(t2["success"], true);
        assert_eq!(t3["success"], true);
    }
}
