//! `SessionTransport` adapter for the Native Rust Fast Lane (`S4`).
//!
//! [`NativeFastLaneTransport`] executes multi-step ReAct turns asynchronously
//! on a lightweight worker thread, emits [`TransportEvent`]s into a queue
//! bounded by [`MAX_PENDING_EVENTS`], bridges interactive approvals through
//! `write_frame` + [`crate::chat::approval`], and maintains the live
//! [`ACTIVE_FAST_LANE_SESSIONS`] gauge.

use std::collections::{HashSet, VecDeque};
use std::fmt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use serde_json::Value;

use crate::chat::approval::{approval_token, parse_decision, ApprovalDecision};
use crate::chat::persistent::controls::push_bounded;
use crate::chat::persistent::{PersistentControls, MAX_PENDING_EVENTS};
use crate::chat::session::{SessionTransport, TransportEvent, TransportSpec};

use super::loop_engine::{
    run_react_loop, HttpNativeProvider, NativeApprovalGate, NativeApprovalRequest,
    NativePermissionMode, NativeProvider, ReactLoopConfig, DEFAULT_MAX_STEPS, DEFAULT_TOKEN_BUDGET,
};
use super::mcp_client::NativeMcpClient;
use super::tools::NativeToolRegistry;
use super::types::{resolve_fast_lane_endpoint, FastLaneEndpoint, NativeMessage, NativeToolDef};

/// Live count of spawned, non-stopped Native Fast Lane sessions.
pub static ACTIVE_FAST_LANE_SESSIONS: AtomicUsize = AtomicUsize::new(0);

/// Returns the current number of active Native Fast Lane sessions.
pub fn active_fast_lane_count() -> usize {
    ACTIVE_FAST_LANE_SESSIONS.load(Ordering::Relaxed)
}

#[derive(Debug)]
struct PendingApprovalSlot {
    request_id: String,
    decision: Arc<(Mutex<Option<ApprovalDecision>>, Condvar)>,
}

struct TransportApprovalGate {
    events: Arc<Mutex<VecDeque<TransportEvent>>>,
    pending_slot: Arc<Mutex<Option<PendingApprovalSlot>>>,
}

impl NativeApprovalGate for TransportApprovalGate {
    fn request_approval(
        &self,
        req: &NativeApprovalRequest,
        cancel: &AtomicBool,
    ) -> Result<ApprovalDecision, String> {
        if cancel.load(Ordering::Acquire) {
            return Err("turn cancelled".to_string());
        }

        let decision_pair = Arc::new((Mutex::new(None::<ApprovalDecision>), Condvar::new()));
        {
            let mut slot = self
                .pending_slot
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            *slot = Some(PendingApprovalSlot {
                request_id: req.request_id.clone(),
                decision: Arc::clone(&decision_pair),
            });
        }

        {
            let mut q = self.events.lock().unwrap_or_else(|p| p.into_inner());
            push_bounded(
                &mut q,
                TransportEvent::ApprovalRequest {
                    id: req.request_id.clone(),
                    kind: req.tool_name.clone(),
                },
            );
        }

        let (lock, cv) = &*decision_pair;
        let mut guard = lock.lock().unwrap_or_else(|p| p.into_inner());
        let decision = loop {
            if let Some(d) = guard.take() {
                break Ok(d);
            }
            if cancel.load(Ordering::Acquire) {
                break Err("turn cancelled".to_string());
            }
            let (next, _) = cv
                .wait_timeout(guard, Duration::from_millis(25))
                .unwrap_or_else(|p| p.into_inner());
            guard = next;
        };

        if let Ok(mut slot) = self.pending_slot.lock() {
            if slot
                .as_ref()
                .is_some_and(|pending| pending.request_id == req.request_id)
            {
                *slot = None;
            }
        }

        decision
    }
}

fn env_lookup(extra_env: &[(String, String)], keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some((_, val)) = extra_env.iter().find(|(k, _)| k == key) {
            let trimmed = val.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn resolve_api_key_for_driver(driver: &str, extra_env: &[(String, String)]) -> Option<String> {
    if let Some(explicit) = env_lookup(extra_env, &["KITE_FAST_LANE_API_KEY", "KITE_API_KEY"]) {
        return Some(explicit);
    }

    let norm = driver.trim().to_ascii_lowercase();
    let vault_keys: &[&str] = match norm.as_str() {
        "xai" | "x-ai" | "grok" => &["grok", "xai"],
        "opencode_go" | "opencode-go" => &["opencode_go", "opencode"],
        "gemini" | "google" => &["gemini"],
        "deepseek" => &["deepseek"],
        "kimi" | "moonshot" => &["kimi"],
        "vercel" => &["vercel"],
        "cloudflare" => &["cloudflare"],
        "openai" => &["openai"],
        "anthropic" => &["anthropic"],
        _ => &[],
    };
    for k in vault_keys {
        if let Some(secret) = crate::credentials::resolve_provider_key(k) {
            if !secret.trim().is_empty() {
                return Some(secret);
            }
        }
    }

    let env_vars: &[&str] = match norm.as_str() {
        "openai" => &["OPENAI_API_KEY"],
        "anthropic" => &["ANTHROPIC_API_KEY"],
        "xai" | "x-ai" | "grok" => &["XAI_API_KEY", "GROK_API_KEY"],
        "gemini" | "google" => &["GEMINI_API_KEY"],
        "deepseek" => &["DEEPSEEK_API_KEY"],
        "kimi" | "moonshot" => &["KIMI_API_KEY", "MOONSHOT_API_KEY"],
        "vercel" => &["VERCEL_API_KEY", "VERCEL_AI_GATEWAY_TOKEN"],
        "cloudflare" => &["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_AUTH_TOKEN"],
        "opencode_go" | "opencode-go" => &["OPENCODE_GO_API_KEY", "OPENCODE_API_KEY"],
        _ => &[],
    };
    for var in env_vars {
        if let Ok(val) = std::env::var(var) {
            let trimmed = val.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn infer_auth_kind(driver: &str, extra_env: &[(String, String)], has_api_key: bool) -> String {
    if let Some(explicit) = env_lookup(extra_env, &["KITE_FAST_LANE_AUTH_KIND", "KITE_AUTH_KIND"])
    {
        return explicit;
    }
    let norm = driver.trim().to_ascii_lowercase();
    if matches!(norm.as_str(), "opencode_go" | "opencode-go") {
        return "opencode_go".to_string();
    }
    if has_api_key
        && matches!(
            norm.as_str(),
            "openai"
                | "anthropic"
                | "xai"
                | "x-ai"
                | "grok"
                | "gemini"
                | "google"
                | "deepseek"
                | "kimi"
                | "moonshot"
                | "vercel"
                | "cloudflare"
        )
    {
        return "api_key".to_string();
    }
    "oauth".to_string()
}

fn parse_approval_frame(frame: &str) -> Result<(Option<String>, ApprovalDecision), String> {
    let trimmed = frame.trim();
    if trimmed.is_empty() {
        return Err("approval frame cannot be empty".to_string());
    }

    if let Ok(val) = serde_json::from_str::<Value>(trimmed) {
        let req_id = val
            .get("id")
            .or_else(|| val.get("requestId"))
            .or_else(|| val.get("request_id"))
            .and_then(|v| {
                v.as_str()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .or_else(|| v.as_i64().map(|n| n.to_string()))
            });

        if let Some(token) = approval_token(&val) {
            let decision = parse_decision(token).ok_or_else(|| {
                format!("unsupported approval decision token `{token}`")
            })?;
            return Ok((req_id, decision));
        }

        if let Some(approved) = val
            .get("approved")
            .or_else(|| val.pointer("/result/approved"))
            .and_then(Value::as_bool)
        {
            let decision = if approved {
                ApprovalDecision::AllowOnce
            } else {
                ApprovalDecision::Deny
            };
            return Ok((req_id, decision));
        }

        return Err("approval JSON frame missing decision or approved boolean".to_string());
    }

    let decision = parse_decision(trimmed)
        .ok_or_else(|| format!("unrecognized approval frame `{trimmed}`"))?;
    Ok((None, decision))
}

/// [`SessionTransport`] implementation running Native Fast Lane ReAct turns in-process.
pub struct NativeFastLaneTransport {
    controls: PersistentControls,
    provider: Arc<dyn NativeProvider>,
    endpoint_override: Option<FastLaneEndpoint>,
    endpoint: Option<FastLaneEndpoint>,
    workspace_root: PathBuf,
    system_prompt: Option<String>,
    token_budget: usize,
    max_steps: usize,
    extra_tools: Vec<NativeToolDef>,
    mcp_client: Option<NativeMcpClient>,
    mcp_tool_names: HashSet<String>,
    hook_runner: Option<Arc<dyn crate::native_agent::loop_engine::NativeHookRunner>>,
    events: Arc<Mutex<VecDeque<TransportEvent>>>,
    history: Arc<Mutex<Vec<NativeMessage>>>,
    session_approved: Arc<Mutex<bool>>,
    cancel_flag: Arc<AtomicBool>,
    pending_approval: Arc<Mutex<Option<PendingApprovalSlot>>>,
    turn_active: Arc<AtomicBool>,
    turn_thread: Option<JoinHandle<()>>,
    resume_handle: Option<String>,
    spawns: u32,
    stopping: bool,
    session_counted: bool,
}

impl fmt::Debug for NativeFastLaneTransport {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("NativeFastLaneTransport")
            .field("spawns", &self.spawns)
            .field("stopping", &self.stopping)
            .field("session_counted", &self.session_counted)
            .field("workspace_root", &self.workspace_root)
            .field("resume_handle", &self.resume_handle)
            .finish()
    }
}

impl NativeFastLaneTransport {
    pub fn new(controls: PersistentControls) -> Self {
        Self::with_provider(controls, Arc::new(HttpNativeProvider::new()))
    }

    pub fn with_provider(
        controls: PersistentControls,
        provider: Arc<dyn NativeProvider>,
    ) -> Self {
        Self {
            controls,
            provider,
            endpoint_override: None,
            endpoint: None,
            workspace_root: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
            system_prompt: None,
            token_budget: DEFAULT_TOKEN_BUDGET,
            max_steps: DEFAULT_MAX_STEPS,
            extra_tools: Vec::new(),
            mcp_client: None,
            mcp_tool_names: HashSet::new(),
            hook_runner: None,
            events: Arc::new(Mutex::new(VecDeque::with_capacity(64))),
            history: Arc::new(Mutex::new(Vec::new())),
            session_approved: Arc::new(Mutex::new(false)),
            cancel_flag: Arc::new(AtomicBool::new(false)),
            pending_approval: Arc::new(Mutex::new(None)),
            turn_active: Arc::new(AtomicBool::new(false)),
            turn_thread: None,
            resume_handle: None,
            spawns: 0,
            stopping: false,
            session_counted: false,
        }
    }

    pub fn with_endpoint(mut self, endpoint: FastLaneEndpoint) -> Self {
        self.endpoint_override = Some(endpoint);
        self
    }

    pub fn with_system_prompt(mut self, prompt: impl Into<String>) -> Self {
        let trimmed = prompt.into();
        if !trimmed.trim().is_empty() {
            self.system_prompt = Some(trimmed);
        }
        self
    }

    pub fn with_token_budget(mut self, token_budget: usize) -> Self {
        if token_budget > 0 {
            self.token_budget = token_budget;
        }
        self
    }

    pub fn with_max_steps(mut self, max_steps: usize) -> Self {
        if max_steps > 0 {
            self.max_steps = max_steps;
        }
        self
    }

    pub fn with_mcp_tools(
        mut self,
        client: NativeMcpClient,
        tools: Vec<NativeToolDef>,
    ) -> Self {
        for tool in &tools {
            self.mcp_tool_names.insert(tool.name.clone());
        }
        self.extra_tools.extend(tools);
        self.mcp_client = Some(client);
        self
    }

    fn wake_pending_approval(&self, decision: ApprovalDecision) {
        if let Ok(slot) = self.pending_approval.lock() {
            if let Some(pending) = slot.as_ref() {
                let (lock, cv) = &*pending.decision;
                if let Ok(mut guard) = lock.lock() {
                    *guard = Some(decision);
                }
                cv.notify_all();
            }
        }
    }

    fn release_active_count(&mut self) {
        if self.session_counted {
            self.session_counted = false;
            let _ = ACTIVE_FAST_LANE_SESSIONS.fetch_update(
                Ordering::AcqRel,
                Ordering::Acquire,
                |cur| Some(cur.saturating_sub(1)),
            );
        }
    }

    fn join_finished_turn(&mut self) {
        if let Some(handle) = self.turn_thread.take() {
            let _ = handle.join();
        }
    }
}

impl SessionTransport for NativeFastLaneTransport {
    fn spawn(&mut self, spec: &TransportSpec) -> Result<(), String> {
        if self.turn_active.load(Ordering::Acquire) {
            return Err("the native fast-lane session already has an active turn".to_string());
        }
        self.join_finished_turn();

        let endpoint = if let Some(ref ep) = self.endpoint_override {
            ep.clone()
        } else {
            let model = self
                .controls
                .model
                .clone()
                .or_else(|| env_lookup(&spec.extra_env, &["KITE_FAST_LANE_MODEL", "KITE_MODEL"]))
                .unwrap_or_default();
            let api_key = resolve_api_key_for_driver(&spec.driver, &spec.extra_env);
            let base_url = env_lookup(
                &spec.extra_env,
                &["KITE_FAST_LANE_BASE_URL", "KITE_BASE_URL"],
            );
            let auth_kind = infer_auth_kind(&spec.driver, &spec.extra_env, api_key.is_some());
            resolve_fast_lane_endpoint(
                &spec.driver,
                &model,
                api_key.as_deref(),
                base_url.as_deref(),
                &auth_kind,
                Some(&spec.session_id),
            )
            .map_err(|err| err.to_string())?
        };

        if let Some(dir) = spec
            .working_directory
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            self.workspace_root = PathBuf::from(dir);
        }
        if let Some(sys) = env_lookup(&spec.extra_env, &["KITE_FAST_LANE_SYSTEM_PROMPT"]) {
            self.system_prompt = Some(sys);
        }
        let disabled_plugins: Vec<String> = env_lookup(&spec.extra_env, &["KITE_DISABLED_PLUGINS"])
            .map(|raw| {
                raw.split(',')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        self.hook_runner = Some(Arc::new(
            crate::plugin_runtime::hooks::PluginHookRunner::new_with_disabled(
                Some(self.workspace_root.clone()),
                &disabled_plugins,
            ),
        ));
        if let Some(plugin_ctx) = crate::plugin_runtime::context::build_active_plugin_context(
            Some(&self.workspace_root),
            &disabled_plugins,
        ) {
            let trimmed_ctx = plugin_ctx.trim();
            if !trimmed_ctx.is_empty() {
                match self.system_prompt {
                    Some(ref mut existing) => {
                        if !existing.contains(trimmed_ctx)
                            && !existing.contains("<plugin_skills>")
                            && !existing.contains("<plugin_rules>")
                            && !existing.contains("<plugin_sidecars>")
                        {
                            if existing.trim().is_empty() {
                                *existing = trimmed_ctx.to_string();
                            } else {
                                existing.push_str("\n\n");
                                existing.push_str(trimmed_ctx);
                            }
                        }
                    }
                    None => {
                        self.system_prompt = Some(trimmed_ctx.to_string());
                    }
                }
            }
        }
        if let Some(raw_budget) = env_lookup(&spec.extra_env, &["KITE_FAST_LANE_TOKEN_BUDGET"]) {
            if let Ok(parsed) = raw_budget.parse::<usize>() {
                if parsed > 0 {
                    self.token_budget = parsed;
                }
            }
        }
        if let Some(raw_steps) = env_lookup(&spec.extra_env, &["KITE_FAST_LANE_MAX_STEPS"]) {
            if let Ok(parsed) = raw_steps.parse::<usize>() {
                if parsed > 0 {
                    self.max_steps = parsed;
                }
            }
        }

        if let Some(ref handle) = spec.resume_handle {
            if !handle.trim().is_empty() {
                self.resume_handle = Some(handle.clone());
            }
        } else if self.resume_handle.is_none() {
            self.resume_handle = Some(format!("fastlane:{}", spec.session_id));
        }

        self.endpoint = Some(endpoint);
        self.stopping = false;
        self.cancel_flag.store(false, Ordering::Release);
        self.spawns += 1;

        if !self.session_counted {
            ACTIVE_FAST_LANE_SESSIONS.fetch_add(1, Ordering::AcqRel);
            self.session_counted = true;
        }

        Ok(())
    }

    fn write_turn(&mut self, prompt: &str) -> Result<(), String> {
        if self.stopping {
            return Err("the native fast-lane session has stopped".to_string());
        }
        let Some(endpoint) = self.endpoint.clone() else {
            return Err("the native fast-lane session has not spawned".to_string());
        };
        if prompt.trim().is_empty() {
            return Err("a turn needs a message".to_string());
        }
        if self.turn_active.load(Ordering::Acquire) {
            return Err("a native fast-lane turn is already in progress".to_string());
        }
        self.join_finished_turn();

        self.cancel_flag.store(false, Ordering::Release);
        self.turn_active.store(true, Ordering::Release);

        let provider = Arc::clone(&self.provider);
        let events = Arc::clone(&self.events);
        let history_arc = Arc::clone(&self.history);
        let session_approved_arc = Arc::clone(&self.session_approved);
        let cancel_flag = Arc::clone(&self.cancel_flag);
        let pending_slot = Arc::clone(&self.pending_approval);
        let turn_active = Arc::clone(&self.turn_active);
        let prompt_owned = prompt.to_string();

        let mut config = ReactLoopConfig::new(endpoint, self.workspace_root.clone());
        config.system_prompt = self.system_prompt.clone();
        config.permission_mode =
            NativePermissionMode::from_control_str(self.controls.permission_mode.as_deref());
        config.max_steps = self.max_steps;
        config.token_budget = self.token_budget;
        config.extra_tools = self.extra_tools.clone();
        config.mcp_client = self.mcp_client.clone();
        config.mcp_tool_names = self.mcp_tool_names.clone();
        config.hook_runner = self.hook_runner.clone();

        let spawned = std::thread::Builder::new()
            .name("kite-fast-lane-turn".to_string())
            .spawn(move || {
                struct ActiveResetGuard(Arc<AtomicBool>);
                impl Drop for ActiveResetGuard {
                    fn drop(&mut self) {
                        self.0.store(false, Ordering::Release);
                    }
                }
                let _active_guard = ActiveResetGuard(Arc::clone(&turn_active));

                let mut history = history_arc
                    .lock()
                    .map(|mut g| std::mem::take(&mut *g))
                    .unwrap_or_default();
                let mut session_approved = session_approved_arc
                    .lock()
                    .map(|g| *g)
                    .unwrap_or(false);

                let registry = NativeToolRegistry::new();
                let gate = TransportApprovalGate {
                    events: Arc::clone(&events),
                    pending_slot,
                };

                let mut saw_terminal = false;
                let res = run_react_loop(
                    provider.as_ref(),
                    &registry,
                    &config,
                    &mut history,
                    &prompt_owned,
                    &cancel_flag,
                    Some(&gate),
                    &mut session_approved,
                    &mut |ev| {
                        if matches!(
                            ev,
                            TransportEvent::TurnEnded
                                | TransportEvent::TurnFailed(_)
                                | TransportEvent::Exit { .. }
                        ) {
                            saw_terminal = true;
                        }
                        if let Ok(mut q) = events.lock() {
                            push_bounded(&mut q, ev);
                        }
                    },
                );

                if let Ok(mut g) = history_arc.lock() {
                    *g = history;
                }
                if let Ok(mut g) = session_approved_arc.lock() {
                    *g = session_approved;
                }

                if let Err(err) = res {
                    if !saw_terminal {
                        if let Ok(mut q) = events.lock() {
                            push_bounded(&mut q, TransportEvent::TurnFailed(err));
                        }
                    }
                } else if !saw_terminal {
                    if let Ok(mut q) = events.lock() {
                        push_bounded(&mut q, TransportEvent::TurnEnded);
                    }
                }
            });

        match spawned {
            Ok(handle) => {
                self.turn_thread = Some(handle);
                Ok(())
            }
            Err(err) => {
                self.turn_active.store(false, Ordering::Release);
                Err(format!("failed to spawn native fast-lane turn thread: {err}"))
            }
        }
    }

    fn write_frame(&mut self, frame: &str) -> Result<(), String> {
        if self.stopping {
            return Err("the native fast-lane session has stopped".to_string());
        }
        let (req_id, decision) = parse_approval_frame(frame)?;

        let slot = self
            .pending_approval
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let Some(pending) = slot.as_ref() else {
            return Err("the native fast-lane session has no pending approval request".to_string());
        };
        if let Some(ref id) = req_id {
            if id != &pending.request_id {
                return Err(format!(
                    "approval request `{id}` does not match active request `{}`",
                    pending.request_id
                ));
            }
        }

        let (lock, cv) = &*pending.decision;
        {
            let mut guard = lock.lock().unwrap_or_else(|p| p.into_inner());
            *guard = Some(decision);
        }
        cv.notify_all();
        Ok(())
    }

    fn interrupt(&mut self) -> Result<(), String> {
        self.cancel_flag.store(true, Ordering::Release);
        self.wake_pending_approval(ApprovalDecision::DenyAndStop);
        Ok(())
    }

    fn stop(&mut self) -> Result<(), String> {
        self.stopping = true;
        self.cancel_flag.store(true, Ordering::Release);
        self.wake_pending_approval(ApprovalDecision::DenyAndStop);
        self.join_finished_turn();
        self.release_active_count();
        Ok(())
    }

    fn spawn_count(&self) -> u32 {
        self.spawns
    }

    fn resume_handle(&self) -> Option<String> {
        self.resume_handle.clone()
    }

    fn drain(&mut self) -> Vec<TransportEvent> {
        let mut q = self.events.lock().unwrap_or_else(|p| p.into_inner());
        debug_assert!(q.len() <= MAX_PENDING_EVENTS);
        q.drain(..).collect()
    }

    fn is_alive(&self) -> bool {
        if self.spawns == 0 {
            return !self.stopping;
        }
        !self.stopping && self.endpoint.is_some()
    }

    fn controls(&self) -> Option<PersistentControls> {
        Some(self.controls.clone())
    }

    fn update_controls(&mut self, next: &PersistentControls) -> bool {
        self.controls = next.clone();
        if let Some(ref mut ep) = self.endpoint {
            if let Some(model) = next
                .model
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                ep.model = model.to_string();
            }
        }
        true
    }
}

impl Drop for NativeFastLaneTransport {
    fn drop(&mut self) {
        self.stopping = true;
        self.cancel_flag.store(true, Ordering::Release);
        self.wake_pending_approval(ApprovalDecision::DenyAndStop);
        self.join_finished_turn();
        self.release_active_count();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::session::{SessionManager, SessionMode, SessionState};
    use crate::native_agent::types::NativeStreamChunk;

    static FAST_LANE_COUNTER_LOCK: Mutex<()> = Mutex::new(());

    fn temp_workspace(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "kite-fastlane-transport-{tag}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    struct MockTransportProvider {
        steps: Mutex<VecDeque<Vec<NativeStreamChunk>>>,
    }

    impl MockTransportProvider {
        fn new(steps: Vec<Vec<NativeStreamChunk>>) -> Self {
            Self {
                steps: Mutex::new(VecDeque::from(steps)),
            }
        }
    }

    impl NativeProvider for MockTransportProvider {
        fn stream_turn(
            &self,
            _req: &crate::native_agent::types::NativeTurnRequest,
            on_chunk: &mut (dyn FnMut(NativeStreamChunk) + Send),
        ) -> Result<(), String> {
            let chunks = self
                .steps
                .lock()
                .unwrap()
                .pop_front()
                .ok_or_else(|| "no scripted step".to_string())?;
            for c in chunks {
                on_chunk(c);
            }
            Ok(())
        }
    }

    fn test_endpoint() -> FastLaneEndpoint {
        resolve_fast_lane_endpoint(
            "openai",
            "gpt-5-mini",
            Some("test-key"),
            None,
            "api_key",
            None,
        )
        .unwrap()
    }

    fn base_spec(thread_id: &str, driver: &str, dir: &std::path::Path) -> TransportSpec {
        TransportSpec {
            session_id: format!("{thread_id}:1"),
            driver: driver.to_string(),
            working_directory: Some(dir.to_string_lossy().to_string()),
            mode: SessionMode::Persistent,
            recipe_revision: None,
            resume_handle: None,
            extra_env: Vec::new(),
        }
    }

    #[test]
    fn rejects_consumer_oauth_drivers_and_tracks_active_count() {
        let _guard = FAST_LANE_COUNTER_LOCK.lock().unwrap();
        let baseline = active_fast_lane_count();
        let ws = temp_workspace("ineligible");

        let mut bad = NativeFastLaneTransport::new(PersistentControls::default());
        let bad_res = bad.spawn(&base_spec("th-bad", "antigravity", &ws));
        assert!(bad_res.is_err());
        assert_eq!(active_fast_lane_count(), baseline);

        let provider = Arc::new(MockTransportProvider::new(vec![]));
        let mut good = NativeFastLaneTransport::with_provider(
            PersistentControls {
                model: Some("gpt-5-mini".into()),
                effort: None,
                permission_mode: Some("readOnly".into()),
            },
            provider,
        )
        .with_endpoint(test_endpoint());

        good.spawn(&base_spec("th-good", "openai", &ws)).unwrap();
        assert_eq!(good.spawn_count(), 1);
        assert!(good.is_alive());
        assert_eq!(active_fast_lane_count(), baseline + 1);

        good.stop().unwrap();
        assert!(!good.is_alive());
        assert_eq!(active_fast_lane_count(), baseline);

        // Second stop is idempotent and never underflows
        good.stop().unwrap();
        assert_eq!(active_fast_lane_count(), baseline);

        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn session_manager_approval_roundtrip_via_write_frame() {
        let _guard = FAST_LANE_COUNTER_LOCK.lock().unwrap();
        let baseline = active_fast_lane_count();
        let ws = temp_workspace("approval");

        let provider = Arc::new(MockTransportProvider::new(vec![
            vec![
                NativeStreamChunk::ToolCallStart {
                    id: "w1".into(),
                    name: "write_file".into(),
                },
                NativeStreamChunk::ToolCallDelta {
                    id: "w1".into(),
                    arguments_delta: r#"{"path":"created.txt","content":"via-approval"}"#.into(),
                },
                NativeStreamChunk::Done,
            ],
            vec![
                NativeStreamChunk::TextDelta("File written.".into()),
                NativeStreamChunk::Done,
            ],
        ]));

        let transport = NativeFastLaneTransport::with_provider(
            PersistentControls {
                model: Some("gpt-5-mini".into()),
                effort: None,
                permission_mode: Some("supervised".into()),
            },
            provider,
        )
        .with_endpoint(test_endpoint());

        let mut manager = SessionManager::new();
        manager
            .attach(
                crate::chat::session::SessionSpec {
                    thread_id: "th-fast".into(),
                    driver: "openai".into(),
                    connection_id: None,
                    working_directory: Some(ws.to_string_lossy().to_string()),
                    mode: SessionMode::Persistent,
                    recipe: None,
                    resume_handle: None,
                    extra_env: Vec::new(),
                },
                Box::new(transport),
            )
            .unwrap();
        manager.start("th-fast").unwrap();
        assert_eq!(active_fast_lane_count(), baseline + 1);

        manager.send_turn("th-fast", "cmd-1", "create file").unwrap();

        let mut approval_id: Option<String> = None;
        for _ in 0..80 {
            let events = manager.poll("th-fast").unwrap();
            for ev in events {
                if ev.kind == "approvalOpened" {
                    approval_id = ev
                        .payload
                        .get("requestId")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                }
            }
            if approval_id.is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }

        let req_id = approval_id.expect("expected approvalOpened event");
        assert_eq!(manager.status("th-fast").unwrap().state, SessionState::Waiting);

        let frame = crate::acp::format_acp_approval_response(&req_id, "allow_once");
        manager
            .respond_approval("th-fast", &req_id, ApprovalDecision::AllowOnce)
            .unwrap();
        manager.write_frame("th-fast", &frame).unwrap();

        let mut completed = false;
        let mut collected_text = String::new();
        for _ in 0..80 {
            let events = manager.poll("th-fast").unwrap();
            for ev in events {
                if ev.kind == "text" {
                    if let Some(t) = ev.payload.get("text").and_then(Value::as_str) {
                        collected_text.push_str(t);
                    }
                } else if ev.kind == "turnCompleted" {
                    completed = true;
                }
            }
            if completed {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }

        assert!(completed);
        assert_eq!(collected_text, "File written.");
        assert_eq!(
            std::fs::read_to_string(ws.join("created.txt")).unwrap(),
            "via-approval"
        );

        manager.stop("th-fast").unwrap();
        assert_eq!(active_fast_lane_count(), baseline);
        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn transport_interrupt_unblocks_pending_approval_with_turn_failed() {
        let _guard = FAST_LANE_COUNTER_LOCK.lock().unwrap();
        let baseline = active_fast_lane_count();
        let ws = temp_workspace("interrupt");

        let provider = Arc::new(MockTransportProvider::new(vec![vec![
            NativeStreamChunk::ToolCallStart {
                id: "w_cancel".into(),
                name: "write_file".into(),
            },
            NativeStreamChunk::ToolCallDelta {
                id: "w_cancel".into(),
                arguments_delta: r#"{"path":"never.txt","content":"nope"}"#.into(),
            },
            NativeStreamChunk::Done,
        ]]));

        let mut transport = NativeFastLaneTransport::with_provider(
            PersistentControls {
                model: Some("gpt-5-mini".into()),
                effort: None,
                permission_mode: Some("supervised".into()),
            },
            provider,
        )
        .with_endpoint(test_endpoint());

        transport.spawn(&base_spec("th-int", "openai", &ws)).unwrap();
        transport.write_turn("attempt write").unwrap();

        let mut saw_approval = false;
        for _ in 0..80 {
            let events = transport.drain();
            if events
                .iter()
                .any(|e| matches!(e, TransportEvent::ApprovalRequest { .. }))
            {
                saw_approval = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(saw_approval);

        transport.interrupt().unwrap();

        let mut saw_cancelled = false;
        for _ in 0..80 {
            let events = transport.drain();
            if events
                .iter()
                .any(|e| matches!(e, TransportEvent::TurnFailed(msg) if msg == "turn cancelled"))
            {
                saw_cancelled = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(saw_cancelled);
        assert!(!ws.join("never.txt").exists());

        transport.stop().unwrap();
        assert_eq!(active_fast_lane_count(), baseline);
        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn spawn_injects_active_plugin_context_and_honors_disabled_env() {
        let _guard = FAST_LANE_COUNTER_LOCK.lock().unwrap();
        let baseline = active_fast_lane_count();
        let ws = temp_workspace("plugin-ctx");
        let plugin_dir = ws.join(".agents").join("plugins").join("demo-ext");
        std::fs::create_dir_all(plugin_dir.join("skills").join("check")).unwrap();
        std::fs::create_dir_all(plugin_dir.join("rules")).unwrap();
        std::fs::write(plugin_dir.join("plugin.json"), r#"{"name":"demo-ext"}"#).unwrap();
        std::fs::write(
            plugin_dir.join("skills").join("check").join("SKILL.md"),
            "---\nname: check\ndescription: Verify workspace\n---\nSteps.\n",
        )
        .unwrap();
        std::fs::write(
            plugin_dir.join("rules").join("AGENTS.md"),
            "Follow demo extension policy.",
        )
        .unwrap();

        let mut transport = NativeFastLaneTransport::with_provider(
            PersistentControls::default(),
            Arc::new(MockTransportProvider::new(vec![])),
        )
        .with_endpoint(test_endpoint())
        .with_system_prompt("Base fast-lane prompt.");

        let spec = base_spec("th-plugin-ok", "openai", &ws);
        transport.spawn(&spec).unwrap();
        let sys = transport.system_prompt.clone().unwrap();
        assert!(sys.starts_with("Base fast-lane prompt.\n\n"));
        assert!(sys.contains("<plugin_skills>"));
        assert!(sys.contains("demo-ext/check: Verify workspace"));
        assert!(sys.contains("<plugin_rules>"));
        assert!(sys.contains("Follow demo extension policy."));

        // Calling spawn again must not duplicate injected plugin sections.
        transport.spawn(&spec).unwrap();
        let sys_again = transport.system_prompt.clone().unwrap();
        assert_eq!(sys_again.matches("<plugin_skills>").count(), 1);
        transport.stop().unwrap();

        // Disabled via KITE_DISABLED_PLUGINS omits plugin context entirely.
        let mut disabled_transport = NativeFastLaneTransport::with_provider(
            PersistentControls::default(),
            Arc::new(MockTransportProvider::new(vec![])),
        )
        .with_endpoint(test_endpoint());
        let mut disabled_spec = base_spec("th-plugin-off", "openai", &ws);
        disabled_spec
            .extra_env
            .push(("KITE_DISABLED_PLUGINS".to_string(), "demo-ext".to_string()));
        disabled_transport.spawn(&disabled_spec).unwrap();
        assert!(disabled_transport.system_prompt.is_none());
        disabled_transport.stop().unwrap();

        assert_eq!(active_fast_lane_count(), baseline);
        let _ = std::fs::remove_dir_all(&ws);
    }
}
