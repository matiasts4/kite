//! Native agent lifecycle hooks (`hooks.json`) loader, regex matcher, and runner.
//!
//! Discovers and merges `hooks.json` definitions across enabled plugin bundles
//! (`<plugin_root>/hooks.json` or `<plugin_root>/hooks/hooks.json`) and workspace
//! `.agents/hooks.json`, honoring per-entry `"enabled": false`, regex tool
//! matchers, 30s default timeouts, `PLUGIN_ROOT`/`PLUGIN_DATA` env injection,
//! hidden process execution, and camelCase JSON stdin/stdout contracts.

use crate::chat::utils::find_in_path;
use crate::hidden_exec::spawn_streaming_with_owned_env;
use crate::native_agent::loop_engine::{
    HookEventKind, HookExecutionOutcome, HookInvocationContext, HookPermissionDecision,
    HookTerminationBehavior, NativeHookRunner,
};
use crate::persist::roaming_app_dir;
use crate::plugin_runtime::manifest::parse_jsonc_value;
use crate::plugin_runtime::registry::discover_plugins_at;
#[cfg(not(test))]
use crate::plugin_runtime::registry::load_runtime_settings_at;
use crate::plugin_runtime::types::{DiscoveredPlugin, PluginRuntimeSettings};
use regex::Regex;
use serde_json::{Map, Value};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::future::Future;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

pub const DEFAULT_HOOK_TIMEOUT_MS: u64 = 30_000;
const MIN_HOOK_TIMEOUT_MS: u64 = 10;
const MAX_HOOK_TIMEOUT_MS: u64 = 600_000;
const MAX_HOOK_OUTPUT_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone)]
pub struct ResolvedHookEntry {
    pub event: HookEventKind,
    pub name: Option<String>,
    pub matcher_raw: Option<String>,
    matcher: Option<Regex>,
    matcher_valid: bool,
    pub command: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub cwd: Option<PathBuf>,
    pub timeout_ms: u64,
    pub plugin_id: Option<String>,
    pub plugin_root: PathBuf,
    pub plugin_data: PathBuf,
    pub source_path: PathBuf,
}

impl ResolvedHookEntry {
    /// Returns `true` if this entry applies to `ctx.event` and its regex matcher
    /// matches `ctx.tool_name` (or all invocations when matcher is empty/`*`).
    pub fn matches(&self, ctx: &HookInvocationContext) -> bool {
        if self.event != ctx.event || !self.matcher_valid {
            return false;
        }
        match &self.matcher {
            None => true,
            Some(re) => {
                let target = ctx.tool_name.as_deref().unwrap_or("");
                re.is_match(target)
            }
        }
    }
}

/// Lifecycle hook runner implementing [`NativeHookRunner`] for Kite plugin bundles
/// and workspace `.agents/hooks.json`.
#[derive(Debug, Clone)]
pub struct PluginHookRunner {
    workspace_root: Option<PathBuf>,
    entries: Vec<ResolvedHookEntry>,
}

impl PluginHookRunner {
    /// Creates a [`PluginHookRunner`] by discovering enabled plugins and workspace hooks
    /// for `workspace_root`.
    pub fn new(workspace_root: Option<PathBuf>) -> Self {
        Self::new_with_disabled(workspace_root, &[])
    }

    /// Creates a [`PluginHookRunner`] while filtering out per-agent `disabled_plugin_ids`.
    pub fn new_with_disabled(
        workspace_root: Option<PathBuf>,
        disabled_plugin_ids: &[String],
    ) -> Self {
        let app_dir = roaming_app_dir();

        #[cfg(test)]
        let plugins = {
            let settings = PluginRuntimeSettings {
                enable_shared_system_roots: false,
                ..Default::default()
            };
            discover_plugins_at(&app_dir, None, workspace_root.as_deref(), &settings)
        };

        #[cfg(not(test))]
        let plugins = {
            let cached = crate::plugin_runtime::cached_discovered_plugins();
            if !cached.is_empty()
                && crate::plugin_runtime::current_workspace_dir().as_deref()
                    == workspace_root.as_deref()
            {
                cached
            } else {
                let home_dir = resolve_home_dir();
                let settings = load_runtime_settings_at(&app_dir);
                discover_plugins_at(
                    &app_dir,
                    home_dir.as_deref(),
                    workspace_root.as_deref(),
                    &settings,
                )
            }
        };

        Self::from_plugins(app_dir, workspace_root, plugins, disabled_plugin_ids)
    }

    /// Creates a [`PluginHookRunner`] using explicit discovery roots (isolated for tests).
    pub fn from_discovery_roots(
        app_dir: PathBuf,
        home_dir: Option<PathBuf>,
        workspace_root: Option<PathBuf>,
        settings: PluginRuntimeSettings,
        disabled_plugin_ids: &[String],
    ) -> Self {
        let plugins = discover_plugins_at(
            &app_dir,
            home_dir.as_deref(),
            workspace_root.as_deref(),
            &settings,
        );
        Self::from_plugins(app_dir, workspace_root, plugins, disabled_plugin_ids)
    }

    /// Builds a [`PluginHookRunner`] from pre-discovered plugins and optional workspace root.
    pub fn from_plugins(
        app_dir: PathBuf,
        workspace_root: Option<PathBuf>,
        plugins: Vec<DiscoveredPlugin>,
        disabled_plugin_ids: &[String],
    ) -> Self {
        let entries = load_merged_hooks(
            &app_dir,
            workspace_root.as_deref(),
            &plugins,
            disabled_plugin_ids,
        );
        Self {
            workspace_root,
            entries,
        }
    }

    /// Returns all merged hook entries in execution order.
    pub fn entries(&self) -> &[ResolvedHookEntry] {
        &self.entries
    }

    /// Returns all hook entries matching `ctx.event` and `ctx.tool_name`.
    pub fn matching_hooks(&self, ctx: &HookInvocationContext) -> Vec<&ResolvedHookEntry> {
        self.entries
            .iter()
            .filter(|entry| entry.matches(ctx))
            .collect()
    }
}

impl NativeHookRunner for PluginHookRunner {
    fn run_hook<'a>(
        &'a self,
        ctx: HookInvocationContext,
    ) -> Pin<Box<dyn Future<Output = Result<HookExecutionOutcome, String>> + Send + 'a>> {
        let matching: Vec<ResolvedHookEntry> = self
            .entries
            .iter()
            .filter(|entry| entry.matches(&ctx))
            .cloned()
            .collect();
        if matching.is_empty() {
            return Box::pin(async { Ok(HookExecutionOutcome::default()) });
        }
        let workspace_root = self.workspace_root.clone();

        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                Ok(execute_hook_chain(
                    &matching,
                    &ctx,
                    workspace_root.as_deref(),
                ))
            })
            .await
            .map_err(|err| format!("Hook execution worker panicked: {err}"))?
        })
    }
}

#[allow(dead_code)]
fn resolve_home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    let raw = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME"));
    #[cfg(not(windows))]
    let raw = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE"));

    raw.ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

fn sanitize_path_segment(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '\0' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            other => other,
        })
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        "_".to_string()
    } else {
        trimmed.to_string()
    }
}

fn validate_inside_root(canonical_root: &Path, candidate: &Path) -> Option<PathBuf> {
    if !candidate.is_file() {
        return None;
    }
    let canonical = fs::canonicalize(candidate).ok()?;
    if canonical.starts_with(canonical_root) {
        Some(canonical)
    } else {
        None
    }
}

fn resolve_plugin_hooks_file(plugin: &DiscoveredPlugin) -> Option<(PathBuf, PathBuf)> {
    let canonical_root = fs::canonicalize(&plugin.root_path).ok()?;
    let mut candidates: Vec<PathBuf> = Vec::with_capacity(3);
    if let Some(ref explicit) = plugin.hooks_path {
        candidates.push(explicit.clone());
    }
    candidates.push(plugin.root_path.join("hooks.json"));
    candidates.push(plugin.root_path.join("hooks").join("hooks.json"));

    for candidate in candidates {
        if let Some(canonical) = validate_inside_root(&canonical_root, &candidate) {
            return Some((candidate, canonical));
        }
    }
    None
}

/// Discovers, validates, and merges `hooks.json` definitions across enabled plugins
/// and workspace `<workspace>/.agents/hooks.json`.
pub fn load_merged_hooks(
    app_dir: &Path,
    workspace_root: Option<&Path>,
    plugins: &[DiscoveredPlugin],
    disabled_plugin_ids: &[String],
) -> Vec<ResolvedHookEntry> {
    let mut entries = Vec::new();
    let mut seen_files: HashSet<PathBuf> = HashSet::new();

    for plugin in plugins {
        if !plugin.enabled {
            continue;
        }
        if crate::plugins::is_plugin_disabled(disabled_plugin_ids, &plugin.dir_id)
            || (!plugin.name.trim().is_empty()
                && crate::plugins::is_plugin_disabled(disabled_plugin_ids, &plugin.name))
        {
            continue;
        }

        let Some((hooks_path, canonical_hooks)) = resolve_plugin_hooks_file(plugin) else {
            continue;
        };
        if !seen_files.insert(canonical_hooks) {
            continue;
        }

        let plugin_data = app_dir
            .join("sidecar_data")
            .join(sanitize_path_segment(&plugin.dir_id));
        parse_hooks_file(
            &hooks_path,
            Some(plugin.dir_id.clone()),
            plugin.root_path.clone(),
            plugin_data,
            &mut entries,
        );
    }

    if let Some(ws) = workspace_root.filter(|p| p.is_dir()) {
        if let Ok(canonical_ws) = fs::canonicalize(ws) {
            let ws_hooks = ws.join(".agents").join("hooks.json");
            if let Some(canonical_hooks) = validate_inside_root(&canonical_ws, &ws_hooks) {
                if seen_files.insert(canonical_hooks) {
                    let plugin_data = app_dir.join("sidecar_data").join("_workspace");
                    parse_hooks_file(
                        &ws_hooks,
                        None,
                        ws.to_path_buf(),
                        plugin_data,
                        &mut entries,
                    );
                }
            }
        }
    }

    entries
}

fn parse_event_kind(raw_key: &str) -> Option<HookEventKind> {
    let normalized: String = raw_key
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .map(|ch| ch.to_ascii_lowercase())
        .collect();
    match normalized.as_str() {
        "sessionstart" => Some(HookEventKind::SessionStart),
        "pretooluse" => Some(HookEventKind::PreToolUse),
        "posttooluse" => Some(HookEventKind::PostToolUse),
        "preinvocation" => Some(HookEventKind::PreInvocation),
        "postinvocation" => Some(HookEventKind::PostInvocation),
        "stop" => Some(HookEventKind::Stop),
        _ => None,
    }
}

fn is_entry_disabled(obj: &Map<String, Value>) -> bool {
    if obj.get("enabled").and_then(Value::as_bool) == Some(false) {
        return true;
    }
    if obj.get("disabled").and_then(Value::as_bool) == Some(true) {
        return true;
    }
    false
}

fn compile_matcher(raw: Option<&str>) -> (Option<String>, Option<Regex>, bool) {
    let Some(cleaned) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return (None, None, true);
    };
    if cleaned == "*" {
        return (Some("*".to_string()), None, true);
    }
    match Regex::new(cleaned) {
        Ok(re) => (Some(cleaned.to_string()), Some(re), true),
        Err(err) => {
            crate::logger::log_trace(&format!(
                "[PluginHooks] Ignoring invalid hook regex matcher '{cleaned}': {err}"
            ));
            (Some(cleaned.to_string()), None, false)
        }
    }
}

fn parse_timeout_ms_from_obj(obj: &Map<String, Value>, fallback_ms: u64) -> u64 {
    if let Some(ms_val) = obj.get("timeoutMs").or_else(|| obj.get("timeout_ms")) {
        if let Some(ms) = ms_val.as_u64() {
            return ms.clamp(MIN_HOOK_TIMEOUT_MS, MAX_HOOK_TIMEOUT_MS);
        }
        if let Some(ms_f) = ms_val.as_f64().filter(|v| v.is_finite() && *v > 0.0) {
            return (ms_f.round() as u64).clamp(MIN_HOOK_TIMEOUT_MS, MAX_HOOK_TIMEOUT_MS);
        }
    }

    if let Some(secs_val) = obj
        .get("timeoutSeconds")
        .or_else(|| obj.get("timeout_seconds"))
        .or_else(|| obj.get("timeoutSecs"))
        .or_else(|| obj.get("timeout_secs"))
    {
        if let Some(secs) = secs_val.as_u64() {
            return secs
                .saturating_mul(1_000)
                .clamp(MIN_HOOK_TIMEOUT_MS, MAX_HOOK_TIMEOUT_MS);
        }
        if let Some(secs_f) = secs_val.as_f64().filter(|v| v.is_finite() && *v > 0.0) {
            return ((secs_f * 1_000.0).round() as u64)
                .clamp(MIN_HOOK_TIMEOUT_MS, MAX_HOOK_TIMEOUT_MS);
        }
    }

    if let Some(raw_timeout) = obj.get("timeout") {
        match raw_timeout {
            Value::Number(num) => {
                if let Some(val) = num.as_f64().filter(|v| v.is_finite() && *v > 0.0) {
                    let ms = if val <= 60.0 {
                        (val * 1_000.0).round() as u64
                    } else {
                        val.round() as u64
                    };
                    return ms.clamp(MIN_HOOK_TIMEOUT_MS, MAX_HOOK_TIMEOUT_MS);
                }
            }
            Value::String(text) => {
                let lower = text.trim().to_ascii_lowercase();
                if let Some(ms_str) = lower.strip_suffix("ms") {
                    if let Ok(ms) = ms_str.trim().parse::<f64>() {
                        if ms.is_finite() && ms > 0.0 {
                            return (ms.round() as u64)
                                .clamp(MIN_HOOK_TIMEOUT_MS, MAX_HOOK_TIMEOUT_MS);
                        }
                    }
                } else if let Some(s_str) = lower.strip_suffix('s') {
                    if let Ok(secs) = s_str.trim().parse::<f64>() {
                        if secs.is_finite() && secs > 0.0 {
                            return ((secs * 1_000.0).round() as u64)
                                .clamp(MIN_HOOK_TIMEOUT_MS, MAX_HOOK_TIMEOUT_MS);
                        }
                    }
                } else if let Ok(val) = lower.parse::<f64>() {
                    if val.is_finite() && val > 0.0 {
                        let ms = if val <= 60.0 {
                            (val * 1_000.0).round() as u64
                        } else {
                            val.round() as u64
                        };
                        return ms.clamp(MIN_HOOK_TIMEOUT_MS, MAX_HOOK_TIMEOUT_MS);
                    }
                }
            }
            _ => {}
        }
    }

    fallback_ms
}

fn parse_env_map(val: Option<&Value>) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    let Some(obj) = val.and_then(Value::as_object) else {
        return env;
    };
    for (k, v) in obj {
        let key = k.trim();
        if key.is_empty() {
            continue;
        }
        let scalar = match v {
            Value::String(s) => s.clone(),
            Value::Number(n) => n.to_string(),
            Value::Bool(b) => b.to_string(),
            _ => continue,
        };
        env.insert(key.to_string(), scalar);
    }
    env
}

fn parse_args_array(val: Option<&Value>) -> Vec<String> {
    val.and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|item| match item {
                    Value::String(s) => Some(s.clone()),
                    Value::Number(n) => Some(n.to_string()),
                    Value::Bool(b) => Some(b.to_string()),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default()
}

#[allow(clippy::too_many_arguments)]
fn build_entry_from_obj(
    event: HookEventKind,
    obj: &Map<String, Value>,
    fallback_matcher: Option<&str>,
    fallback_timeout_ms: u64,
    fallback_env: &BTreeMap<String, String>,
    fallback_cwd: Option<&Path>,
    plugin_id: Option<String>,
    plugin_root: &Path,
    plugin_data: &Path,
    source_path: &Path,
) -> Option<ResolvedHookEntry> {
    if is_entry_disabled(obj) {
        return None;
    }

    if let Some(kind) = obj.get("type").and_then(Value::as_str).map(str::trim) {
        if !kind.is_empty() && !kind.eq_ignore_ascii_case("command") {
            return None;
        }
    }

    let command = obj
        .get("command")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())?
        .to_string();

    let raw_matcher = obj
        .get("matcher")
        .and_then(Value::as_str)
        .or(fallback_matcher);
    let (matcher_raw, matcher, matcher_valid) = compile_matcher(raw_matcher);
    let timeout_ms = parse_timeout_ms_from_obj(obj, fallback_timeout_ms);

    let mut env = fallback_env.clone();
    env.extend(parse_env_map(obj.get("env")));

    let cwd = obj
        .get("cwd")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .or_else(|| fallback_cwd.map(Path::to_path_buf));

    let name = obj
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    Some(ResolvedHookEntry {
        event,
        name,
        matcher_raw,
        matcher,
        matcher_valid,
        command,
        args: parse_args_array(obj.get("args")),
        env,
        cwd,
        timeout_ms,
        plugin_id,
        plugin_root: plugin_root.to_path_buf(),
        plugin_data: plugin_data.to_path_buf(),
        source_path: source_path.to_path_buf(),
    })
}

fn parse_hooks_file(
    path: &Path,
    plugin_id: Option<String>,
    plugin_root: PathBuf,
    plugin_data: PathBuf,
    out: &mut Vec<ResolvedHookEntry>,
) {
    let Ok(raw) = fs::read_to_string(path) else {
        return;
    };
    let Ok(root_val) = parse_jsonc_value(&raw) else {
        crate::logger::log_trace(&format!(
            "[PluginHooks] Ignoring malformed hooks file {}",
            path.display()
        ));
        return;
    };
    let Some(root_obj) = root_val.as_object() else {
        return;
    };
    if is_entry_disabled(root_obj) {
        return;
    }

    let events_obj = root_obj
        .get("hooks")
        .and_then(Value::as_object)
        .unwrap_or(root_obj);

    const EVENT_ORDER: [HookEventKind; 6] = [
        HookEventKind::SessionStart,
        HookEventKind::PreToolUse,
        HookEventKind::PostToolUse,
        HookEventKind::PreInvocation,
        HookEventKind::PostInvocation,
        HookEventKind::Stop,
    ];

    for ordered_event in EVENT_ORDER {
        for (key, event_val) in events_obj {
            if parse_event_kind(key) != Some(ordered_event) {
                continue;
            }
            let Some(items) = event_val.as_array() else {
                continue;
            };

            for item in items {
                let Some(obj) = item.as_object() else {
                    continue;
                };
                if is_entry_disabled(obj) {
                    continue;
                }

                if let Some(nested_hooks) = obj.get("hooks").and_then(Value::as_array) {
                    let group_matcher = obj.get("matcher").and_then(Value::as_str);
                    let group_timeout = parse_timeout_ms_from_obj(obj, DEFAULT_HOOK_TIMEOUT_MS);
                    let group_env = parse_env_map(obj.get("env"));
                    let group_cwd = obj
                        .get("cwd")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(PathBuf::from);

                    for inner in nested_hooks {
                        let Some(inner_obj) = inner.as_object() else {
                            continue;
                        };
                        if let Some(entry) = build_entry_from_obj(
                            ordered_event,
                            inner_obj,
                            group_matcher,
                            group_timeout,
                            &group_env,
                            group_cwd.as_deref(),
                            plugin_id.clone(),
                            &plugin_root,
                            &plugin_data,
                            path,
                        ) {
                            out.push(entry);
                        }
                    }
                } else if let Some(entry) = build_entry_from_obj(
                    ordered_event,
                    obj,
                    None,
                    DEFAULT_HOOK_TIMEOUT_MS,
                    &BTreeMap::new(),
                    None,
                    plugin_id.clone(),
                    &plugin_root,
                    &plugin_data,
                    path,
                ) {
                    out.push(entry);
                }
            }
        }
    }
}

fn expand_hook_tokens(
    input: &str,
    plugin_root: &Path,
    plugin_data: &Path,
    workspace_root: Option<&Path>,
    plugin_id: Option<&str>,
) -> String {
    let mut out = input
        .replace("${PLUGIN_ROOT}", plugin_root.to_string_lossy().as_ref())
        .replace("${PLUGIN_DATA}", plugin_data.to_string_lossy().as_ref());
    if let Some(ws) = workspace_root {
        let ws_str = ws.to_string_lossy();
        out = out
            .replace("${WORKSPACE_ROOT}", ws_str.as_ref())
            .replace("${KITE_WORKSPACE_ROOT}", ws_str.as_ref());
    }
    if let Some(pid) = plugin_id {
        out = out.replace("${KITE_PLUGIN_ID}", pid);
    }
    out
}

fn resolve_executable_candidate(path: &Path) -> Option<PathBuf> {
    if path.is_file() {
        return Some(path.to_path_buf());
    }
    #[cfg(windows)]
    if path.extension().is_none() {
        for ext in [".exe", ".cmd", ".bat"] {
            let mut os = path.as_os_str().to_os_string();
            os.push(ext);
            let candidate = PathBuf::from(os);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn resolve_hook_executable(
    command: &str,
    cwd: Option<&Path>,
    plugin_root: &Path,
) -> Option<PathBuf> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return None;
    }

    let cmd_path = Path::new(trimmed);
    if cmd_path.is_absolute() {
        return resolve_executable_candidate(cmd_path);
    }

    let is_path_like = trimmed.contains('/') || trimmed.contains('\\') || trimmed.starts_with('.');
    if is_path_like {
        let from_plugin = plugin_root.join(cmd_path);
        if let Some(found) = resolve_executable_candidate(&from_plugin) {
            return Some(found);
        }
        if let Some(dir) = cwd {
            let from_cwd = dir.join(cmd_path);
            if let Some(found) = resolve_executable_candidate(&from_cwd) {
                return Some(found);
            }
        }
        return None;
    }

    let in_plugin = plugin_root.join(trimmed);
    if let Some(found) = resolve_executable_candidate(&in_plugin) {
        return Some(found);
    }
    if let Some(dir) = cwd {
        let in_cwd = dir.join(trimmed);
        if let Some(found) = resolve_executable_candidate(&in_cwd) {
            return Some(found);
        }
    }

    if let Some(found) = find_in_path(trimmed) {
        return Some(found);
    }

    #[cfg(windows)]
    if trimmed.eq_ignore_ascii_case("node") || trimmed.eq_ignore_ascii_case("node.exe") {
        let default_node = PathBuf::from(r"C:\Program Files\nodejs\node.exe");
        if default_node.is_file() {
            return Some(default_node);
        }
        if let Some(program_files) = std::env::var_os("ProgramFiles") {
            let pf_node = PathBuf::from(program_files).join("nodejs").join("node.exe");
            if pf_node.is_file() {
                return Some(pf_node);
            }
        }
    }

    None
}

/// Splits a simple command line into tokens while preserving Windows backslash paths
/// and returning `None` when unquoted shell metacharacters are present.
fn split_command_tokens(raw: &str) -> Option<Vec<String>> {
    let chars: Vec<char> = raw.chars().collect();
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut in_token = false;
    let mut quote: Option<char> = None;
    let mut i = 0;

    while i < chars.len() {
        let ch = chars[i];
        if let Some(q) = quote {
            if ch == q {
                quote = None;
                i += 1;
                continue;
            }
            if ch == '\\' && i + 1 < chars.len() && (chars[i + 1] == q || chars[i + 1] == '\\') {
                current.push(chars[i + 1]);
                i += 2;
                continue;
            }
            current.push(ch);
            i += 1;
            continue;
        }

        if matches!(ch, '|' | '&' | ';' | '>' | '<' | '\n' | '\r' | '`') {
            return None;
        }
        if ch == '$' && i + 1 < chars.len() && chars[i + 1] == '(' {
            return None;
        }

        if ch.is_whitespace() {
            if in_token {
                tokens.push(std::mem::take(&mut current));
                in_token = false;
            }
            i += 1;
        } else if ch == '"' || ch == '\'' {
            quote = Some(ch);
            in_token = true;
            i += 1;
        } else {
            current.push(ch);
            in_token = true;
            i += 1;
        }
    }

    if quote.is_some() {
        return None;
    }
    if in_token {
        tokens.push(current);
    }
    Some(tokens)
}

fn resolve_command_and_args(
    expanded_cmd: &str,
    expanded_args: &[String],
    cwd: Option<&Path>,
    plugin_root: &Path,
) -> Result<(PathBuf, Vec<String>), String> {
    if !expanded_args.is_empty() {
        let program = resolve_hook_executable(expanded_cmd, cwd, plugin_root)
            .ok_or_else(|| format!("Hook command not found: '{expanded_cmd}'"))?;
        return Ok((program, expanded_args.to_vec()));
    }

    if let Some(direct) = resolve_hook_executable(expanded_cmd, cwd, plugin_root) {
        return Ok((direct, Vec::new()));
    }

    if let Some(tokens) = split_command_tokens(expanded_cmd) {
        if let Some((head, tail)) = tokens.split_first() {
            if let Some(program) = resolve_hook_executable(head, cwd, plugin_root) {
                return Ok((program, tail.to_vec()));
            }
        }
    }

    #[cfg(windows)]
    {
        let cmd_exe = find_in_path("cmd.exe").unwrap_or_else(|| PathBuf::from("cmd.exe"));
        Ok((cmd_exe, vec!["/C".to_string(), expanded_cmd.to_string()]))
    }

    #[cfg(not(windows))]
    {
        Ok((
            PathBuf::from("/bin/sh"),
            vec!["-c".to_string(), expanded_cmd.to_string()],
        ))
    }
}

#[cfg(windows)]
struct ProcessSyncHandle(windows::Win32::Foundation::HANDLE);

#[cfg(windows)]
unsafe impl Send for ProcessSyncHandle {}

#[cfg(windows)]
impl ProcessSyncHandle {
    fn from_pid(pid: u32) -> Option<Self> {
        use windows::Win32::System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE};
        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, pid) }.ok()?;
        Some(Self(handle))
    }

    fn wait_exit(&self, timeout_ms: u32) -> bool {
        use windows::Win32::Foundation::WAIT_OBJECT_0;
        use windows::Win32::System::Threading::WaitForSingleObject;
        let result = unsafe { WaitForSingleObject(self.0, timeout_ms) };
        result == WAIT_OBJECT_0
    }
}

#[cfg(windows)]
impl Drop for ProcessSyncHandle {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

fn read_bounded_stream(
    mut stream: Box<dyn Read + Send>,
    eof_signal: &Arc<(Mutex<usize>, Condvar)>,
) -> Vec<u8> {
    let mut out = Vec::new();
    let mut buf = [0u8; 4096];
    loop {
        match stream.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let remaining = MAX_HOOK_OUTPUT_BYTES.saturating_sub(out.len());
                if remaining > 0 {
                    out.extend_from_slice(&buf[..n.min(remaining)]);
                }
            }
        }
    }
    let (lock, cvar) = &**eof_signal;
    if let Ok(mut count) = lock.lock() {
        *count += 1;
        cvar.notify_all();
    }
    out
}

fn wait_eof_timeout(eof_signal: &Arc<(Mutex<usize>, Condvar)>, timeout_ms: u64) -> bool {
    let (lock, cvar) = &**eof_signal;
    let Ok(guard) = lock.lock() else {
        return false;
    };
    if *guard >= 2 {
        return true;
    }
    let timeout = Duration::from_millis(timeout_ms);
    let Ok((guard, _)) = cvar.wait_timeout(guard, timeout) else {
        return false;
    };
    *guard >= 2
}

#[derive(Debug, Default, Clone)]
struct ParsedHookStdout {
    decision: Option<HookPermissionDecision>,
    reason: Option<String>,
    overwrite: Option<Map<String, Value>>,
    inject_steps: Vec<String>,
    termination_behavior: Option<HookTerminationBehavior>,
    continue_turn: bool,
}

#[derive(Debug)]
struct HookRunResult {
    parsed: ParsedHookStdout,
    exit_code: Option<i32>,
    timed_out: bool,
    stderr: String,
    spawn_error: Option<String>,
}

fn parse_decision_str(raw: &str) -> Option<HookPermissionDecision> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "allow" | "approve" => Some(HookPermissionDecision::Allow),
        "deny" | "block" | "reject" => Some(HookPermissionDecision::Deny),
        "force_ask" | "forceask" | "force-ask" => Some(HookPermissionDecision::ForceAsk),
        "ask" => Some(HookPermissionDecision::Ask),
        _ => None,
    }
}

fn parse_termination_str(raw: &str) -> Option<HookTerminationBehavior> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "stop" | "end" | "end_turn" | "endturn" | "finish" | "complete" | "graceful" => {
            Some(HookTerminationBehavior::Stop)
        }
        "fail" | "error" | "abort" | "halt" | "terminate" | "deny" | "block" => {
            Some(HookTerminationBehavior::Fail)
        }
        _ => None,
    }
}

fn parse_termination_value(val: &Value) -> Option<HookTerminationBehavior> {
    match val {
        Value::String(s) => parse_termination_str(s),
        Value::Bool(true) => Some(HookTerminationBehavior::Stop),
        Value::Object(obj) => obj
            .get("behavior")
            .or_else(|| obj.get("type"))
            .or_else(|| obj.get("mode"))
            .or_else(|| obj.get("kind"))
            .and_then(Value::as_str)
            .and_then(parse_termination_str),
        _ => None,
    }
}

fn extract_json_object(stdout: &str) -> Option<Map<String, Value>> {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(trimmed) {
        return Some(map);
    }
    for line in trimmed.lines().rev() {
        let candidate = line.trim();
        if candidate.starts_with('{') && candidate.ends_with('}') {
            if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(candidate) {
                return Some(map);
            }
        }
    }
    None
}

fn parse_hook_stdout(stdout: &str) -> ParsedHookStdout {
    let Some(obj) = extract_json_object(stdout) else {
        return ParsedHookStdout::default();
    };

    let decision = obj
        .get("decision")
        .or_else(|| obj.get("permissionDecision"))
        .or_else(|| obj.get("permission_decision"))
        .or_else(|| {
            obj.get("hookSpecificOutput")
                .and_then(|h| h.get("permissionDecision"))
        })
        .and_then(Value::as_str)
        .and_then(parse_decision_str);

    let reason = obj
        .get("reason")
        .or_else(|| obj.get("message"))
        .or_else(|| obj.get("systemMessage"))
        .or_else(|| obj.get("stopReason"))
        .or_else(|| obj.get("permissionDecisionReason"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let overwrite = obj
        .get("overwrite")
        .or_else(|| obj.get("updatedInput"))
        .or_else(|| {
            obj.get("hookSpecificOutput")
                .and_then(|h| h.get("updatedInput"))
        })
        .and_then(Value::as_object)
        .cloned();

    let inject_steps = match obj
        .get("injectSteps")
        .or_else(|| obj.get("inject_steps"))
        .or_else(|| obj.get("additionalContext"))
    {
        Some(Value::Array(arr)) => arr
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect(),
        Some(Value::String(s)) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                Vec::new()
            } else {
                vec![trimmed.to_string()]
            }
        }
        _ => Vec::new(),
    };

    let termination_behavior = obj
        .get("terminationBehavior")
        .or_else(|| obj.get("termination_behavior"))
        .and_then(parse_termination_value);

    let continue_turn = obj
        .get("continue")
        .or_else(|| obj.get("continueTurn"))
        .or_else(|| obj.get("continue_turn"))
        .and_then(Value::as_bool)
        .unwrap_or(false);

    ParsedHookStdout {
        decision,
        reason,
        overwrite,
        inject_steps,
        termination_behavior,
        continue_turn,
    }
}

fn execute_single_hook(
    entry: &ResolvedHookEntry,
    ctx: &HookInvocationContext,
    workspace_root: Option<&Path>,
) -> HookRunResult {
    let _ = fs::create_dir_all(&entry.plugin_data);

    let ws_effective = workspace_root.or_else(|| {
        let p = Path::new(&ctx.workspace_root);
        (!ctx.workspace_root.trim().is_empty() && p.is_dir()).then_some(p)
    });

    let expanded_cwd = entry.cwd.as_ref().map(|p| {
        PathBuf::from(expand_hook_tokens(
            &p.to_string_lossy(),
            &entry.plugin_root,
            &entry.plugin_data,
            ws_effective,
            entry.plugin_id.as_deref(),
        ))
    });
    let effective_cwd = expanded_cwd
        .as_deref()
        .filter(|p| p.is_dir())
        .or_else(|| ws_effective.filter(|p| p.is_dir()))
        .or_else(|| entry.plugin_root.is_dir().then_some(entry.plugin_root.as_path()));

    let expanded_cmd = expand_hook_tokens(
        &entry.command,
        &entry.plugin_root,
        &entry.plugin_data,
        ws_effective,
        entry.plugin_id.as_deref(),
    );
    let expanded_args: Vec<String> = entry
        .args
        .iter()
        .map(|arg| {
            expand_hook_tokens(
                arg,
                &entry.plugin_root,
                &entry.plugin_data,
                ws_effective,
                entry.plugin_id.as_deref(),
            )
        })
        .collect();

    let (program, final_args) = match resolve_command_and_args(
        &expanded_cmd,
        &expanded_args,
        effective_cwd,
        &entry.plugin_root,
    ) {
        Ok(pair) => pair,
        Err(err) => {
            return HookRunResult {
                parsed: ParsedHookStdout::default(),
                exit_code: None,
                timed_out: false,
                stderr: String::new(),
                spawn_error: Some(err),
            };
        }
    };

    let mut env_pairs: Vec<(String, String)> = entry
        .env
        .iter()
        .map(|(k, v)| {
            (
                k.clone(),
                expand_hook_tokens(
                    v,
                    &entry.plugin_root,
                    &entry.plugin_data,
                    ws_effective,
                    entry.plugin_id.as_deref(),
                ),
            )
        })
        .collect();
    env_pairs.push((
        "PLUGIN_ROOT".to_string(),
        entry.plugin_root.to_string_lossy().into_owned(),
    ));
    env_pairs.push((
        "PLUGIN_DATA".to_string(),
        entry.plugin_data.to_string_lossy().into_owned(),
    ));
    env_pairs.push(("KITE_HOOK_EVENT".to_string(), ctx.event.as_str().to_string()));
    if let Some(ws) = ws_effective {
        let ws_str = ws.to_string_lossy().into_owned();
        env_pairs.push(("KITE_WORKSPACE_ROOT".to_string(), ws_str.clone()));
        env_pairs.push(("KITE_PROJECT_DIR".to_string(), ws_str));
    }
    if let Some(ref pid) = entry.plugin_id {
        env_pairs.push(("KITE_PLUGIN_ID".to_string(), pid.clone()));
    }

    let arg_refs: Vec<&str> = final_args.iter().map(String::as_str).collect();
    let mut child = match spawn_streaming_with_owned_env(
        &program,
        &arg_refs,
        effective_cwd,
        &env_pairs,
    ) {
        Ok(c) => c,
        Err(err) => {
            return HookRunResult {
                parsed: ParsedHookStdout::default(),
                exit_code: None,
                timed_out: false,
                stderr: String::new(),
                spawn_error: Some(format!(
                    "Failed to spawn hook '{}': {err}",
                    program.display()
                )),
            };
        }
    };

    #[cfg(windows)]
    let sync_handle = ProcessSyncHandle::from_pid(child.id());

    let stdin_payload = serde_json::to_vec(ctx).unwrap_or_else(|_| b"{}".to_vec());
    let stdin_handle = child.stdin.take().map(|mut stdin| {
        std::thread::spawn(move || {
            let _ = stdin.write_all(&stdin_payload);
            let _ = stdin.flush();
            drop(stdin);
        })
    });

    let eof_signal = Arc::new((Mutex::new(0usize), Condvar::new()));
    let stdout_handle = if let Some(stdout) = child.stdout.take() {
        let sig = Arc::clone(&eof_signal);
        Some(std::thread::spawn(move || read_bounded_stream(stdout, &sig)))
    } else {
        if let Ok(mut count) = eof_signal.0.lock() {
            *count += 1;
            eof_signal.1.notify_all();
        }
        None
    };

    let stderr_handle = if let Some(stderr) = child.stderr.take() {
        let sig = Arc::clone(&eof_signal);
        Some(std::thread::spawn(move || read_bounded_stream(stderr, &sig)))
    } else {
        if let Ok(mut count) = eof_signal.0.lock() {
            *count += 1;
            eof_signal.1.notify_all();
        }
        None
    };

    let exited = {
        #[cfg(windows)]
        {
            if let Some(handle) = sync_handle {
                handle.wait_exit(entry.timeout_ms.min(u32::MAX as u64) as u32)
            } else {
                wait_eof_timeout(&eof_signal, entry.timeout_ms)
            }
        }
        #[cfg(not(windows))]
        {
            wait_eof_timeout(&eof_signal, entry.timeout_ms)
        }
    };

    let timed_out = !exited;
    if timed_out {
        let _ = child.kill();
    }
    let exit_code = child.wait().ok();
    drop(child);

    if let Some(h) = stdin_handle {
        let _ = h.join();
    }
    let stdout_bytes = stdout_handle
        .and_then(|h| h.join().ok())
        .unwrap_or_default();
    let stderr_bytes = stderr_handle
        .and_then(|h| h.join().ok())
        .unwrap_or_default();

    let stdout_str = String::from_utf8_lossy(&stdout_bytes).into_owned();
    let stderr_str = String::from_utf8_lossy(&stderr_bytes).into_owned();
    let parsed = if timed_out {
        ParsedHookStdout::default()
    } else {
        parse_hook_stdout(&stdout_str)
    };

    HookRunResult {
        parsed,
        exit_code,
        timed_out,
        stderr: stderr_str,
        spawn_error: None,
    }
}

fn decision_rank(d: HookPermissionDecision) -> u8 {
    match d {
        HookPermissionDecision::Allow => 1,
        HookPermissionDecision::Ask => 2,
        HookPermissionDecision::ForceAsk => 3,
        HookPermissionDecision::Deny => 4,
    }
}

fn execute_hook_chain(
    hooks: &[ResolvedHookEntry],
    ctx: &HookInvocationContext,
    workspace_root: Option<&Path>,
) -> HookExecutionOutcome {
    let mut best_decision: Option<HookPermissionDecision> = None;
    let mut reason: Option<String> = None;
    let mut merged_overwrite: Option<Map<String, Value>> = None;
    let mut inject_steps: Vec<String> = Vec::new();
    let mut termination_behavior: Option<HookTerminationBehavior> = None;
    let mut continue_turn = false;

    for entry in hooks {
        let res = execute_single_hook(entry, ctx, workspace_root);
        if let Some(ref spawn_err) = res.spawn_error {
            crate::logger::log_trace(&format!(
                "[PluginHooks] Hook '{}' spawn skipped ({}): {}",
                entry.source_path.display(),
                ctx.event.as_str(),
                spawn_err
            ));
            continue;
        }
        if res.timed_out {
            crate::logger::log_trace(&format!(
                "[PluginHooks] Hook '{}' timed out after {}ms on {}",
                entry.source_path.display(),
                entry.timeout_ms,
                ctx.event.as_str()
            ));
            continue;
        }
        if res.exit_code != Some(0) {
            crate::logger::log_trace(&format!(
                "[PluginHooks] Hook '{}' exited with code {:?} on {}: {}",
                entry.source_path.display(),
                res.exit_code,
                ctx.event.as_str(),
                res.stderr.trim()
            ));
        }

        let parsed = res.parsed;
        if let Some(d) = parsed.decision {
            let replace = best_decision
                .map(|cur| decision_rank(d) >= decision_rank(cur))
                .unwrap_or(true);
            if replace {
                best_decision = Some(d);
                if parsed.reason.is_some() {
                    reason = parsed.reason.clone();
                }
            }
        } else if parsed.reason.is_some() && reason.is_none() {
            reason = parsed.reason.clone();
        }

        if let Some(ow) = parsed.overwrite {
            let target = merged_overwrite.get_or_insert_with(Map::new);
            for (k, v) in ow {
                target.insert(k, v);
            }
        }

        inject_steps.extend(parsed.inject_steps);
        continue_turn |= parsed.continue_turn;

        match (termination_behavior, parsed.termination_behavior) {
            (_, Some(HookTerminationBehavior::Fail)) => {
                termination_behavior = Some(HookTerminationBehavior::Fail);
                if parsed.reason.is_some() {
                    reason = parsed.reason.clone();
                }
            }
            (None, Some(HookTerminationBehavior::Stop)) => {
                termination_behavior = Some(HookTerminationBehavior::Stop);
                if parsed.reason.is_some() {
                    reason = parsed.reason.clone();
                }
            }
            _ => {}
        }

        if best_decision == Some(HookPermissionDecision::Deny)
            || termination_behavior == Some(HookTerminationBehavior::Fail)
        {
            break;
        }
    }

    HookExecutionOutcome {
        decision: best_decision.unwrap_or(HookPermissionDecision::Ask),
        reason,
        overwrite: merged_overwrite,
        inject_steps,
        termination_behavior,
        continue_turn,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native_agent::loop_engine::{
        run_react_loop, NativePermissionMode, NativeProvider, ReactLoopConfig,
    };
    use crate::native_agent::tools::NativeToolRegistry;
    use crate::native_agent::types::{
        resolve_fast_lane_endpoint, FastLaneEndpoint, NativeStreamChunk, NativeTurnRequest,
    };
    use serde_json::json;
    use std::collections::VecDeque;
    use std::sync::atomic::AtomicBool;
    use std::sync::Mutex;
    use std::time::Instant;

    struct TempTestDir {
        path: PathBuf,
    }

    impl TempTestDir {
        fn new(label: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "kite-plugin-hooks-{label}-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4().simple()
            ));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Self { path: dir }
        }
    }

    impl Drop for TempTestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn base_ctx(event: HookEventKind, ws: &Path, tool_name: Option<&str>) -> HookInvocationContext {
        HookInvocationContext {
            event,
            workspace_root: ws.to_string_lossy().into_owned(),
            step: 0,
            tool_name: tool_name.map(str::to_string),
            tool_input: None,
            tool_output: None,
            tool_is_error: None,
            assistant_text: None,
            user_prompt: None,
            continuation_active: false,
            continuation_count: 0,
            session_id: Some("sess-hook-test".to_string()),
        }
    }

    #[test]
    fn merges_plugin_and_workspace_hooks_respecting_enabled_false_and_matchers() {
        let tmp = TempTestDir::new("merge");
        let app_dir = tmp.path.join("roaming");
        let ws_dir = tmp.path.join("workspace");
        let global_plugin = app_dir.join("plugins").join("alpha-plugin");
        let nested_plugin = app_dir.join("plugins").join("beta-plugin");
        let disabled_plugin = app_dir.join("plugins").join("gamma-disabled");

        fs::create_dir_all(global_plugin.join("hooks")).unwrap();
        fs::create_dir_all(nested_plugin.join("hooks")).unwrap();
        fs::create_dir_all(&disabled_plugin).unwrap();
        fs::create_dir_all(ws_dir.join(".agents")).unwrap();

        fs::write(global_plugin.join("plugin.json"), r#"{"name":"alpha-plugin"}"#).unwrap();
        fs::write(
            global_plugin.join("hooks.json"),
            r#"{
              "hooks": {
                "SessionStart": [
                  { "command": "node", "args": ["${PLUGIN_ROOT}/start.mjs"] },
                  { "enabled": false, "command": "node", "args": ["disabled-entry.mjs"] }
                ],
                "PreToolUse": [
                  {
                    "matcher": "^write_file|edit_file$",
                    "hooks": [
                      { "command": "node", "args": ["guard.mjs"], "timeoutMs": 5000 },
                      { "enabled": false, "command": "node", "args": ["skip-inner.mjs"] }
                    ]
                  },
                  {
                    "enabled": false,
                    "matcher": ".*",
                    "hooks": [
                      { "command": "node", "args": ["skip-group.mjs"] }
                    ]
                  }
                ]
              }
            }"#,
        )
        .unwrap();

        fs::write(nested_plugin.join("plugin.json"), r#"{"name":"beta-plugin"}"#).unwrap();
        fs::write(
            nested_plugin.join("hooks").join("hooks.json"),
            r#"{
              "PostToolUse": [
                { "matcher": "read_.*", "command": "node", "args": ["post.mjs"], "timeout": 15 }
              ],
              "PreInvocation": [
                { "command": "node", "args": ["pre_inv.mjs"] }
              ],
              "PostInvocation": [
                { "command": "node", "args": ["post_inv.mjs"] }
              ]
            }"#,
        )
        .unwrap();

        fs::write(
            disabled_plugin.join("plugin.json"),
            r#"{"name":"gamma-disabled","disabled":true}"#,
        )
        .unwrap();
        fs::write(
            disabled_plugin.join("hooks.json"),
            r#"{ "Stop": [{ "command": "node", "args": ["never.mjs"] }] }"#,
        )
        .unwrap();

        fs::write(
            ws_dir.join(".agents").join("hooks.json"),
            r#"{
              "Stop": [
                { "command": "node", "args": ["${WORKSPACE_ROOT}/stop.mjs"] }
              ]
            }"#,
        )
        .unwrap();

        let runner = PluginHookRunner::from_discovery_roots(
            app_dir.clone(),
            None,
            Some(ws_dir.clone()),
            PluginRuntimeSettings {
                enable_shared_system_roots: false,
                ..Default::default()
            },
            &[],
        );

        let entries = runner.entries();
        assert_eq!(entries.len(), 6, "entries: {entries:#?}");
        assert_eq!(entries[0].event, HookEventKind::SessionStart);
        assert_eq!(entries[1].event, HookEventKind::PreToolUse);
        assert_eq!(entries[1].timeout_ms, 5_000);
        assert_eq!(entries[2].event, HookEventKind::PostToolUse);
        assert_eq!(entries[2].timeout_ms, 15_000);
        assert_eq!(entries[3].event, HookEventKind::PreInvocation);
        assert_eq!(entries[3].timeout_ms, DEFAULT_HOOK_TIMEOUT_MS);
        assert_eq!(entries[4].event, HookEventKind::PostInvocation);
        assert_eq!(entries[5].event, HookEventKind::Stop);
        assert_eq!(entries[5].plugin_id, None);

        let pre_write = runner.matching_hooks(&base_ctx(
            HookEventKind::PreToolUse,
            &ws_dir,
            Some("write_file"),
        ));
        assert_eq!(pre_write.len(), 1);
        let pre_read = runner.matching_hooks(&base_ctx(
            HookEventKind::PreToolUse,
            &ws_dir,
            Some("read_file"),
        ));
        assert!(pre_read.is_empty());

        let post_read = runner.matching_hooks(&base_ctx(
            HookEventKind::PostToolUse,
            &ws_dir,
            Some("read_file"),
        ));
        assert_eq!(post_read.len(), 1);

        // Disabled plugin ID filter also excludes matching plugins.
        let filtered_runner = PluginHookRunner::from_discovery_roots(
            app_dir,
            None,
            Some(ws_dir),
            PluginRuntimeSettings {
                enable_shared_system_roots: false,
                ..Default::default()
            },
            &["beta-plugin".to_string()],
        );
        assert_eq!(filtered_runner.entries().len(), 3);
    }

    #[tokio::test]
    async fn executes_node_hook_with_camelcase_stdin_stdout_and_plugin_env_vars() {
        let tmp = TempTestDir::new("exec-env");
        let app_dir = tmp.path.join("roaming");
        let ws_dir = tmp.path.join("workspace");
        let plugin_dir = app_dir.join("plugins").join("env-guard");
        fs::create_dir_all(&plugin_dir).unwrap();
        fs::create_dir_all(&ws_dir).unwrap();

        let hook_js = r#"
import fs from 'node:fs';
import path from 'node:path';
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', () => {
  const ctx = JSON.parse(raw || '{}');
  fs.writeFileSync(path.join(process.env.PLUGIN_DATA, 'seen-ctx.json'), JSON.stringify({
    event: ctx.event,
    workspaceRoot: ctx.workspaceRoot,
    toolName: ctx.toolName,
    toolInput: ctx.toolInput,
    continuationActive: ctx.continuationActive,
    continuationCount: ctx.continuationCount,
    sessionId: ctx.sessionId,
    pluginRoot: process.env.PLUGIN_ROOT,
    pluginData: process.env.PLUGIN_DATA,
    hookEventEnv: process.env.KITE_HOOK_EVENT,
    arg0: process.argv[2]
  }));
  console.log(JSON.stringify({
    permissionDecision: 'allow',
    overwrite: { content: 'hook-rewritten' },
    injectSteps: ['Follow plugin checklist'],
    reason: 'approved and rewritten by env-guard'
  }));
});
"#;
        fs::write(plugin_dir.join("guard.mjs"), hook_js).unwrap();
        fs::write(plugin_dir.join("plugin.json"), r#"{"name":"env-guard"}"#).unwrap();
        fs::write(
            plugin_dir.join("hooks.json"),
            r#"{
              "PreToolUse": [
                {
                  "matcher": "write_.*",
                  "command": "node",
                  "args": ["${PLUGIN_ROOT}/guard.mjs", "${PLUGIN_DATA}"]
                }
              ]
            }"#,
        )
        .unwrap();

        let runner = PluginHookRunner::from_discovery_roots(
            app_dir.clone(),
            None,
            Some(ws_dir.clone()),
            PluginRuntimeSettings {
                enable_shared_system_roots: false,
                ..Default::default()
            },
            &[],
        );

        let mut ctx = base_ctx(HookEventKind::PreToolUse, &ws_dir, Some("write_file"));
        ctx.tool_input = Some(json!({ "path": "a.txt", "content": "orig" }));

        let outcome = runner.run_hook(ctx).await.expect("hook should succeed");
        assert_eq!(outcome.decision, HookPermissionDecision::Allow);
        assert_eq!(
            outcome.reason.as_deref(),
            Some("approved and rewritten by env-guard")
        );
        assert_eq!(
            outcome.inject_steps,
            vec!["Follow plugin checklist".to_string()]
        );
        assert_eq!(
            outcome
                .overwrite
                .as_ref()
                .and_then(|m| m.get("content"))
                .and_then(Value::as_str),
            Some("hook-rewritten")
        );

        let expected_data_dir = app_dir.join("sidecar_data").join("env-guard");
        let captured: Value = serde_json::from_str(
            &fs::read_to_string(expected_data_dir.join("seen-ctx.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(captured["event"], "PreToolUse");
        assert_eq!(captured["toolName"], "write_file");
        assert_eq!(captured["toolInput"]["path"], "a.txt");
        assert_eq!(captured["continuationActive"], false);
        assert_eq!(captured["continuationCount"], 0);
        assert_eq!(captured["sessionId"], "sess-hook-test");
        assert_eq!(
            captured["pluginRoot"].as_str(),
            Some(plugin_dir.to_string_lossy().as_ref())
        );
        assert_eq!(
            captured["pluginData"].as_str(),
            Some(expected_data_dir.to_string_lossy().as_ref())
        );
        assert_eq!(captured["hookEventEnv"], "PreToolUse");
        assert_eq!(
            captured["arg0"].as_str(),
            Some(expected_data_dir.to_string_lossy().as_ref())
        );
    }

    #[tokio::test]
    async fn handles_timeouts_and_non_json_or_nonzero_exit_gracefully() {
        let tmp = TempTestDir::new("timeout-nonjson");
        let app_dir = tmp.path.join("roaming");
        let ws_dir = tmp.path.join("workspace");
        let plugin_dir = app_dir.join("plugins").join("resilient");
        fs::create_dir_all(&plugin_dir).unwrap();
        fs::create_dir_all(&ws_dir).unwrap();

        fs::write(
            plugin_dir.join("plugin.json"),
            r#"{"name":"resilient"}"#,
        )
        .unwrap();
        fs::write(
            plugin_dir.join("hooks.json"),
            r#"{
              "SessionStart": [
                {
                  "command": "node",
                  "args": ["-e", "setTimeout(() => console.log('{\"decision\":\"deny\"}'), 5000);"],
                  "timeoutMs": 150
                },
                {
                  "command": "node",
                  "args": ["-e", "console.log('not json output'); process.exit(2);"]
                }
              ],
              "PreInvocation": [
                {
                  "command": "node",
                  "args": ["-e", "console.log('{\"injectSteps\":[\"survived\"]}');"]
                }
              ]
            }"#,
        )
        .unwrap();

        let runner = PluginHookRunner::from_discovery_roots(
            app_dir,
            None,
            Some(ws_dir.clone()),
            PluginRuntimeSettings {
                enable_shared_system_roots: false,
                ..Default::default()
            },
            &[],
        );

        let started = Instant::now();
        let outcome = runner
            .run_hook(base_ctx(HookEventKind::SessionStart, &ws_dir, None))
            .await
            .expect("timeout and non-json non-zero exit must not crash");
        let elapsed = started.elapsed();
        assert!(
            elapsed < Duration::from_secs(3),
            "hook timeout should kill process promptly, took {:?}",
            elapsed
        );
        assert_eq!(outcome.decision, HookPermissionDecision::Ask);
        assert!(!outcome.continue_turn);
        assert!(outcome.termination_behavior.is_none());

        let pre_outcome = runner
            .run_hook(base_ctx(HookEventKind::PreInvocation, &ws_dir, None))
            .await
            .expect("valid subsequent hook works");
        assert_eq!(pre_outcome.inject_steps, vec!["survived".to_string()]);
    }

    #[tokio::test]
    async fn parses_stop_continue_and_termination_behavior_from_workspace_hooks() {
        let tmp = TempTestDir::new("stop-ws");
        let app_dir = tmp.path.join("roaming");
        let ws_dir = tmp.path.join("workspace");
        fs::create_dir_all(ws_dir.join(".agents")).unwrap();

        fs::write(
            ws_dir.join(".agents").join("hooks.json"),
            r#"{
              "Stop": [
                {
                  "command": "node",
                  "args": [
                    "-e",
                    "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const ctx=JSON.parse(d||'{}');console.log(JSON.stringify({continue:true,injectSteps:['Keep verifying step '+(ctx.continuationCount+1)]}));});"
                  ]
                }
              ],
              "PostInvocation": [
                {
                  "command": "node",
                  "args": ["-e", "console.log(JSON.stringify({terminationBehavior:'stop',reason:'done early'}));"]
                }
              ]
            }"#,
        )
        .unwrap();

        let runner = PluginHookRunner::from_discovery_roots(
            app_dir,
            None,
            Some(ws_dir.clone()),
            PluginRuntimeSettings {
                enable_shared_system_roots: false,
                ..Default::default()
            },
            &[],
        );

        let stop_outcome = runner
            .run_hook(base_ctx(HookEventKind::Stop, &ws_dir, None))
            .await
            .unwrap();
        assert!(stop_outcome.continue_turn);
        assert_eq!(
            stop_outcome.inject_steps,
            vec!["Keep verifying step 1".to_string()]
        );

        let post_outcome = runner
            .run_hook(base_ctx(HookEventKind::PostInvocation, &ws_dir, None))
            .await
            .unwrap();
        assert_eq!(
            post_outcome.termination_behavior,
            Some(HookTerminationBehavior::Stop)
        );
        assert_eq!(post_outcome.reason.as_deref(), Some("done early"));
    }

    #[test]
    fn end_to_end_plugin_hook_runner_drives_react_loop_overwrite_and_stop_continue() {
        struct ScriptedMockProvider {
            steps: Mutex<VecDeque<Vec<NativeStreamChunk>>>,
        }
        impl NativeProvider for ScriptedMockProvider {
            fn stream_turn(
                &self,
                _req: &NativeTurnRequest,
                on_chunk: &mut (dyn FnMut(NativeStreamChunk) + Send),
            ) -> Result<(), String> {
                let chunks = self.steps.lock().unwrap().pop_front().unwrap();
                for c in chunks {
                    on_chunk(c);
                }
                Ok(())
            }
        }

        let tmp = TempTestDir::new("e2e-loop");
        let app_dir = tmp.path.join("roaming");
        let ws_dir = tmp.path.join("workspace");
        let plugin_dir = app_dir.join("plugins").join("e2e-hooks");
        fs::create_dir_all(&plugin_dir).unwrap();
        fs::create_dir_all(&ws_dir).unwrap();

        fs::write(plugin_dir.join("plugin.json"), r#"{"name":"e2e-hooks"}"#).unwrap();
        fs::write(
            plugin_dir.join("hooks.json"),
            r#"{
              "PreToolUse": [
                {
                  "matcher": "write_file",
                  "command": "node",
                  "args": ["-e", "console.log(JSON.stringify({decision:'allow',overwrite:{content:'plugin-rewritten'}}))"]
                }
              ],
              "Stop": [
                {
                  "command": "node",
                  "args": ["-e", "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const ctx=JSON.parse(d||'{}');console.log(JSON.stringify({continue:ctx.continuationCount<1,injectSteps:['Final verification']}));});"]
                }
              ]
            }"#,
        )
        .unwrap();

        let hook_runner = Arc::new(PluginHookRunner::from_discovery_roots(
            app_dir,
            None,
            Some(ws_dir.clone()),
            PluginRuntimeSettings {
                enable_shared_system_roots: false,
                ..Default::default()
            },
            &[],
        ));

        let provider = ScriptedMockProvider {
            steps: Mutex::new(VecDeque::from(vec![
                vec![
                    NativeStreamChunk::ToolCallStart {
                        id: "c1".into(),
                        name: "write_file".into(),
                    },
                    NativeStreamChunk::ToolCallDelta {
                        id: "c1".into(),
                        arguments_delta: r#"{"path":"demo.txt","content":"original"}"#.into(),
                    },
                    NativeStreamChunk::Done,
                ],
                vec![
                    NativeStreamChunk::TextDelta("Initial completion.".into()),
                    NativeStreamChunk::Done,
                ],
                vec![
                    NativeStreamChunk::TextDelta("Verified completion.".into()),
                    NativeStreamChunk::Done,
                ],
            ])),
        };

        let endpoint: FastLaneEndpoint =
            resolve_fast_lane_endpoint("openai", "gpt-5-mini", Some("k"), None, "api_key", None)
                .unwrap();
        let mut config = ReactLoopConfig::new(endpoint, ws_dir.clone());
        config.permission_mode = NativePermissionMode::Supervised;
        config.hook_runner = Some(hook_runner);

        let registry = NativeToolRegistry::new();
        let mut history = Vec::new();
        let cancel = AtomicBool::new(false);
        let mut session_approved = false;
        let mut events = Vec::new();

        let outcome = run_react_loop(
            &provider,
            &registry,
            &config,
            &mut history,
            "Write demo.txt",
            &cancel,
            None,
            &mut session_approved,
            &mut |ev| events.push(ev),
        )
        .unwrap();

        assert_eq!(outcome.steps_executed, 3);
        assert_eq!(outcome.final_text, "Verified completion.");
        assert_eq!(
            fs::read_to_string(ws_dir.join("demo.txt")).unwrap(),
            "plugin-rewritten"
        );
        assert!(history.iter().any(|m| m
            .content
            .contains("[hook] Tool 'write_file' arguments modified by lifecycle hook")));
        assert!(history.iter().any(|m| m.content == "Final verification"));
    }

    #[tokio::test]
    async fn aggregates_hook_decisions_merges_overwrites_and_handles_command_strings() {
        let tmp = TempTestDir::new("aggregate-cmdstr");
        let app_dir = tmp.path.join("roaming");
        let ws_dir = tmp.path.join("workspace");
        let plugin_dir = app_dir.join("plugins").join("chain-plugin");
        fs::create_dir_all(&plugin_dir).unwrap();
        fs::create_dir_all(ws_dir.join(".agents")).unwrap();

        fs::write(
            plugin_dir.join("allow_and_patch.mjs"),
            "console.log(JSON.stringify({ decision: 'allow', overwrite: { a: 1, shared: 'from-plugin' } }));\n",
        )
        .unwrap();
        fs::write(plugin_dir.join("plugin.json"), r#"{"name":"chain-plugin"}"#).unwrap();
        fs::write(
            plugin_dir.join("hooks.json"),
            r#"{
              "PreToolUse": [
                {
                  "matcher": "write_file",
                  "command": "node \"${PLUGIN_ROOT}/allow_and_patch.mjs\""
                },
                {
                  "matcher": "[invalid-regex",
                  "command": "node",
                  "args": ["-e", "console.log(JSON.stringify({decision:'deny'}))"]
                }
              ]
            }"#,
        )
        .unwrap();

        // Workspace hook returns empty JSON object (no decision) + second overwrite key;
        // must preserve plugin's `allow` while merging overwrite fields.
        fs::write(
            ws_dir.join(".agents").join("hooks.json"),
            r#"{
              "PreToolUse": [
                {
                  "matcher": "*",
                  "command": "node",
                  "args": ["-e", "console.log(JSON.stringify({ overwrite: { b: 2, shared: 'from-ws' } }))"]
                }
              ],
              "PostToolUse": [
                {
                  "matcher": "read_file",
                  "command": "node",
                  "args": ["-e", "console.log(JSON.stringify({ decision: 'force_ask', reason: 'confirm read' }))"]
                }
              ]
            }"#,
        )
        .unwrap();

        let runner = PluginHookRunner::from_discovery_roots(
            app_dir,
            None,
            Some(ws_dir.clone()),
            PluginRuntimeSettings {
                enable_shared_system_roots: false,
                ..Default::default()
            },
            &[],
        );

        let pre_outcome = runner
            .run_hook(base_ctx(HookEventKind::PreToolUse, &ws_dir, Some("write_file")))
            .await
            .unwrap();
        assert_eq!(pre_outcome.decision, HookPermissionDecision::Allow);
        let ow = pre_outcome.overwrite.expect("merged overwrite map");
        assert_eq!(ow.get("a"), Some(&json!(1)));
        assert_eq!(ow.get("b"), Some(&json!(2)));
        assert_eq!(ow.get("shared"), Some(&json!("from-ws")));

        let post_outcome = runner
            .run_hook(base_ctx(HookEventKind::PostToolUse, &ws_dir, Some("read_file")))
            .await
            .unwrap();
        assert_eq!(post_outcome.decision, HookPermissionDecision::ForceAsk);
        assert_eq!(post_outcome.reason.as_deref(), Some("confirm read"));
    }
}
