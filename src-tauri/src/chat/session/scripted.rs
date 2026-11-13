use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::chat::drivers::DriverDeclaration;
use crate::chat::utils::now_ms;

use super::*;

#[derive(Debug, Default)]
struct ScriptedState {
    spawns: u32,
    stops: u32,
    specs: Vec<TransportSpec>,
    turns: Vec<String>,
    frames: Vec<String>,
    pending: Vec<TransportEvent>,
    resume_handle: Option<String>,
    fail_spawn: Option<String>,
    fail_write: Option<String>,
}

/// Deterministic transport for tests. It records what it was asked to do and
/// replays a scripted event queue.
#[derive(Debug, Clone, Default)]
pub struct ScriptedTransport {
    state: Arc<Mutex<ScriptedState>>,
}

impl ScriptedTransport {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn written_frames(&self) -> Vec<String> {
        self.state.lock().unwrap().frames.clone()
    }

    pub fn script(&self, event: TransportEvent) {
        self.state.lock().unwrap().pending.push(event);
    }

    pub fn with_resume_handle(self, handle: &str) -> Self {
        self.state.lock().unwrap().resume_handle = Some(handle.to_string());
        self
    }

    pub fn failing_spawn(self, reason: &str) -> Self {
        self.state.lock().unwrap().fail_spawn = Some(reason.to_string());
        self
    }

    /// Accepted the process but refused the turn. Reproduces a provider that
    /// started and then rejected the message.
    pub fn failing_write(self, reason: &str) -> Self {
        self.state.lock().unwrap().fail_write = Some(reason.to_string());
        self
    }

    pub fn spawn_count(&self) -> u32 {
        self.state.lock().unwrap().spawns
    }

    pub fn stop_count(&self) -> u32 {
        self.state.lock().unwrap().stops
    }

    pub fn spawned_specs(&self) -> Vec<TransportSpec> {
        self.state.lock().unwrap().specs.clone()
    }

    pub fn written_turns(&self) -> Vec<String> {
        self.state.lock().unwrap().turns.clone()
    }
}

impl SessionTransport for ScriptedTransport {
    fn spawn(&mut self, spec: &TransportSpec) -> Result<(), String> {
        let mut state = self.state.lock().unwrap();
        if let Some(reason) = state.fail_spawn.clone() {
            return Err(reason);
        }
        state.spawns += 1;
        state.specs.push(spec.clone());
        Ok(())
    }

    fn write_turn(&mut self, prompt: &str) -> Result<(), String> {
        let mut state = self.state.lock().unwrap();
        if let Some(reason) = state.fail_write.clone() {
            return Err(reason);
        }
        state.turns.push(prompt.to_string());
        Ok(())
    }

    fn interrupt(&mut self) -> Result<(), String> {
        Ok(())
    }

    fn stop(&mut self) -> Result<(), String> {
        self.state.lock().unwrap().stops += 1;
        Ok(())
    }

    fn spawn_count(&self) -> u32 {
        self.state.lock().unwrap().spawns
    }

    fn resume_handle(&self) -> Option<String> {
        self.state.lock().unwrap().resume_handle.clone()
    }

    fn drain(&mut self) -> Vec<TransportEvent> {
        let mut state = self.state.lock().unwrap();
        std::mem::take(&mut state.pending)
    }

    fn write_frame(&mut self, frame: &str) -> Result<(), String> {
        self.state.lock().unwrap().frames.push(frame.to_string());
        Ok(())
    }
}
