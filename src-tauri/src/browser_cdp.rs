//! Native in-process WebView2 Chrome DevTools Protocol (CDP) automation engine.
//!
//! Uses `ICoreWebView2::CallDevToolsProtocolMethod` and `GetDevToolsProtocolEventReceiver`
//! directly in-process on Windows WebView2 child surfaces — zero external Chrome launch,
//! zero TCP remote-debugging ports, and full compatibility with Evergreen WebView2 >= 150.
//! Compresses snapshots, network/console diagnostics, and deterministic replay recipes
//! through `kite-ctx` v3.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use kite_ctx::browser_cache::{
    canonicalize_route, extract_origin, redact_sensitive_browser_text, AxNode, BrowserReadMode,
    BrowserSnapshotInput,
};
use kite_ctx::browser_recipes::{
    BrowserActionStep, BrowserRecipe, BrowserRecipeStore, LocatorSpec, RecipeLookupResult,
};
use kite_ctx::{ContextEngine, ContextScope, LedgerEventInput, SmartCrusher};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::browser;
use crate::browser_discovery::{self, DiscoveredServer};
use crate::browser_policy::{
    self, evaluate_js_eval, evaluate_navigation_url, load_policy_from_disk, scrub_headers,
    scrub_text_secrets, PolicyDecision,
};

const DEFAULT_CDP_TIMEOUT_MS: u64 = 10_000;
const MAX_CONSOLE_ENTRIES: usize = 100;
const MAX_NETWORK_ENTRIES: usize = 50;
const MAX_CONSOLE_TEXT_CHARS: usize = 512;
const DEFAULT_EMULATED_WIDTH: u32 = 1280;
const DEFAULT_EMULATED_HEIGHT: u32 = 800;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleEntry {
    pub level: String,
    pub text: String,
    pub source: Option<String>,
    pub line: Option<u64>,
    pub timestamp_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkEntry {
    pub request_id: String,
    pub url: String,
    pub method: String,
    pub status: Option<u16>,
    pub status_text: Option<String>,
    pub resource_type: Option<String>,
    pub mime_type: Option<String>,
    pub failed: bool,
    pub error_text: Option<String>,
    pub request_headers: serde_json::Map<String, Value>,
    pub response_headers: serde_json::Map<String, Value>,
    pub timestamp_ms: u64,
}

#[derive(Debug, Default)]
pub struct TabTelemetryState {
    pub attached: bool,
    pub console: VecDeque<ConsoleEntry>,
    pub network: VecDeque<NetworkEntry>,
    pub in_flight: HashMap<String, NetworkEntry>,
    pub last_screenshot_hash: Option<String>,
    pub last_screenshot_turn: usize,
    pub screenshot_turn_counter: usize,
}

impl TabTelemetryState {
    pub fn push_console(&mut self, mut entry: ConsoleEntry) {
        entry.text = truncate_chars(&scrub_text_secrets(&entry.text), MAX_CONSOLE_TEXT_CHARS);
        if self.console.len() >= MAX_CONSOLE_ENTRIES {
            self.console.pop_front();
        }
        self.console.push_back(entry);
    }

    pub fn record_network_request(&mut self, entry: NetworkEntry) {
        if self.in_flight.len() > 128 {
            self.in_flight.clear();
        }
        self.in_flight.insert(entry.request_id.clone(), entry);
    }

    pub fn finish_network_request(
        &mut self,
        request_id: &str,
        status: Option<u16>,
        status_text: Option<String>,
        mime_type: Option<String>,
        response_headers: serde_json::Map<String, Value>,
        failed: bool,
        error_text: Option<String>,
    ) {
        let mut entry = self.in_flight.remove(request_id).unwrap_or_else(|| NetworkEntry {
            request_id: request_id.to_string(),
            url: String::new(),
            method: "GET".to_string(),
            status: None,
            status_text: None,
            resource_type: None,
            mime_type: None,
            failed: false,
            error_text: None,
            request_headers: serde_json::Map::new(),
            response_headers: serde_json::Map::new(),
            timestamp_ms: now_ms(),
        });
        entry.status = status.or(entry.status);
        entry.status_text = status_text.or(entry.status_text);
        entry.mime_type = mime_type.or(entry.mime_type);
        entry.response_headers = scrub_headers(&response_headers);
        entry.failed = failed || entry.status.is_some_and(|s| s >= 400);
        entry.error_text = error_text.map(|e| scrub_text_secrets(&e));

        if self.network.len() >= MAX_NETWORK_ENTRIES {
            // Prefer evicting an older 2xx/3xx entry before dropping a 4xx/5xx failure.
            if let Some(idx) = self.network.iter().position(|n| !n.failed) {
                self.network.remove(idx);
            } else {
                self.network.pop_front();
            }
        }
        self.network.push_back(entry);
    }

    pub fn errors_only(&self) -> (Vec<ConsoleEntry>, Vec<NetworkEntry>) {
        let console_errors = self
            .console
            .iter()
            .filter(|c| matches!(c.level.as_str(), "error" | "warning" | "warn" | "exception"))
            .cloned()
            .collect();
        let network_errors = self
            .network
            .iter()
            .filter(|n| n.failed || n.status.is_some_and(|s| s >= 400))
            .cloned()
            .collect();
        (console_errors, network_errors)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedAxRef {
    pub ref_id: String,
    pub backend_dom_node_id: Option<i64>,
    pub role: String,
    pub name: String,
    pub landmark: Option<String>,
    pub value: Option<String>,
    pub stable_key: String,
    pub interactive: bool,
    pub disabled: bool,
}

#[derive(Debug, Clone, Default)]
pub struct AxSnapshotIndex {
    pub url: String,
    pub title: String,
    pub structure_hash: String,
    pub landmark_keys: Vec<String>,
    pub refs: HashMap<String, IndexedAxRef>,
    pub nodes: Vec<AxNode>,
}

fn telemetry_map() -> &'static Mutex<HashMap<String, TabTelemetryState>> {
    static CELL: OnceLock<Mutex<HashMap<String, TabTelemetryState>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(HashMap::new()))
}

fn ax_index_map() -> &'static Mutex<HashMap<String, AxSnapshotIndex>> {
    static CELL: OnceLock<Mutex<HashMap<String, AxSnapshotIndex>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn clear_surface_cdp_state(surface_id: &str) {
    if let Ok(mut map) = telemetry_map().lock() {
        map.remove(surface_id);
    }
    if let Ok(mut map) = ax_index_map().lock() {
        map.remove(surface_id);
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn truncate_chars(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max_chars).collect();
    out.push('…');
    out
}

fn sha256_short(data: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data.as_bytes());
    let digest = hasher.finalize();
    format!("{:x}", digest).chars().take(16).collect()
}

// ============================================================================
// Native In-Process Windows WebView2 COM CDP Bridge
// ============================================================================

#[cfg(windows)]
pub async fn call_cdp(
    webview: &tauri::Webview,
    method: &str,
    params: Value,
    timeout_ms: u64,
) -> Result<Value, String> {
    use tokio::sync::oneshot;
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use windows::core::{HSTRING, PCWSTR};

    let method_h = HSTRING::from(method);
    let params_json = serde_json::to_string(&params).unwrap_or_else(|_| "{}".to_string());
    let params_h = HSTRING::from(params_json.as_str());
    let method_name = method.to_string();

    let (tx, rx) = oneshot::channel::<Result<String, String>>();
    let tx_cell = std::sync::Arc::new(Mutex::new(Some(tx)));

    let dispatch_res = webview.with_webview(move |platform_wv| {
        let controller = platform_wv.controller();
        let core_res = unsafe { controller.CoreWebView2() };
        let core = match core_res {
            Ok(c) => c,
            Err(err) => {
                if let Ok(mut guard) = tx_cell.lock() {
                    if let Some(sender) = guard.take() {
                        let _ = sender.send(Err(format!("CoreWebView2 unavailable: {err}")));
                    }
                }
                return;
            }
        };

        let tx_cb = tx_cell.clone();
        let m_cb = method_name.clone();
        let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
            move |hr: windows::core::Result<()>, result_str: String| {
                let outcome = match hr {
                    Err(err) => Err(format!("CDP {m_cb} failed: {err}")),
                    Ok(()) => Ok(if result_str.trim().is_empty() {
                        "{}".to_string()
                    } else {
                        result_str
                    }),
                };
                if let Ok(mut guard) = tx_cb.lock() {
                    if let Some(sender) = guard.take() {
                        let _ = sender.send(outcome);
                    }
                }
                Ok(())
            },
        ));

        let call_res = unsafe {
            core.CallDevToolsProtocolMethod(
                PCWSTR::from_raw(method_h.as_ptr()),
                PCWSTR::from_raw(params_h.as_ptr()),
                &handler,
            )
        };
        if let Err(err) = call_res {
            if let Ok(mut guard) = tx_cell.lock() {
                if let Some(sender) = guard.take() {
                    let _ = sender.send(Err(format!("CDP {method_name} invoke error: {err}")));
                }
            }
        }
    });

    if let Err(err) = dispatch_res {
        return Err(format!("Webview STA dispatch failed for {method}: {err}"));
    }

    let raw = tokio::time::timeout(Duration::from_millis(timeout_ms.max(500)), rx)
        .await
        .map_err(|_| format!("CDP {method} timed out after {timeout_ms}ms"))?
        .map_err(|_| format!("CDP {method} callback channel closed"))??;

    serde_json::from_str::<Value>(&raw)
        .map_err(|err| format!("CDP {method} returned invalid JSON: {err}"))
}

#[cfg(not(windows))]
pub async fn call_cdp(
    _webview: &tauri::Webview,
    method: &str,
    _params: Value,
    _timeout_ms: u64,
) -> Result<Value, String> {
    Err(format!(
        "in_process_cdp_unsupported_platform: {method} requires Windows WebView2"
    ))
}

/// Attaches CDP console & network event listeners once per surface and enables required domains.
#[cfg(windows)]
pub async fn ensure_telemetry_attached(surface_id: &str, webview: &tauri::Webview) -> Result<(), String> {
    use webview2_com::DevToolsProtocolEventReceivedEventHandler;
    use windows::core::{HSTRING, PCWSTR, PWSTR};

    {
        let mut map = telemetry_map().lock().unwrap();
        let entry = map.entry(surface_id.to_string()).or_default();
        if entry.attached {
            return Ok(());
        }
        entry.attached = true;
    }

    let sid_owned = surface_id.to_string();
    let attach_res = webview.with_webview(move |platform_wv| {
        let Ok(core) = (unsafe { platform_wv.controller().CoreWebView2() }) else {
            return;
        };

        let events = [
            "Runtime.consoleAPICalled",
            "Runtime.exceptionThrown",
            "Network.requestWillBeSent",
            "Network.responseReceived",
            "Network.loadingFailed",
        ];

        for evt_name in events {
            let evt_h = HSTRING::from(evt_name);
            let receiver = match unsafe {
                core.GetDevToolsProtocolEventReceiver(PCWSTR::from_raw(evt_h.as_ptr()))
            } {
                Ok(r) => r,
                Err(_) => continue,
            };

            let sid = sid_owned.clone();
            let event_kind = evt_name.to_string();
            let handler = DevToolsProtocolEventReceivedEventHandler::create(Box::new(
                move |_wv, args| {
                    let Some(args) = args else {
                        return Ok(());
                    };
                    let mut raw_pwstr = PWSTR::null();
                    if unsafe { args.ParameterObjectAsJson(&mut raw_pwstr) }.is_err()
                        || raw_pwstr.is_null()
                    {
                        return Ok(());
                    }
                    let json_str = unsafe { raw_pwstr.to_string() }.unwrap_or_default();
                    unsafe {
                        windows::Win32::System::Com::CoTaskMemFree(Some(
                            raw_pwstr.as_ptr() as *const core::ffi::c_void,
                        ));
                    }
                    if let Ok(payload) = serde_json::from_str::<Value>(&json_str) {
                        ingest_cdp_event(&sid, &event_kind, &payload);
                    }
                    Ok(())
                },
            ));

            let mut token: i64 = 0;
            let _ = unsafe { receiver.add_DevToolsProtocolEventReceived(&handler, &mut token) };
        }
    });

    if let Err(err) = attach_res {
        if let Ok(mut map) = telemetry_map().lock() {
            if let Some(entry) = map.get_mut(surface_id) {
                entry.attached = false;
            }
        }
        return Err(format!("Failed to register CDP event receivers: {err}"));
    }

    let _ = call_cdp(webview, "Runtime.enable", json!({}), 3000).await;
    let _ = call_cdp(
        webview,
        "Network.enable",
        json!({ "maxTotalBufferSize": 4_194_304, "maxResourceBufferSize": 262_144 }),
        3000,
    )
    .await;
    let _ = call_cdp(webview, "Page.enable", json!({}), 3000).await;
    let _ = call_cdp(webview, "Accessibility.enable", json!({}), 3000).await;
    let _ = call_cdp(webview, "DOM.enable", json!({}), 3000).await;
    Ok(())
}

#[cfg(not(windows))]
pub async fn ensure_telemetry_attached(
    _surface_id: &str,
    _webview: &tauri::Webview,
) -> Result<(), String> {
    Ok(())
}

/// Processes raw CDP console/network events into bounded scrubbed ring buffers.
pub fn ingest_cdp_event(surface_id: &str, event_name: &str, payload: &Value) {
    let Ok(mut map) = telemetry_map().lock() else {
        return;
    };
    let state = map.entry(surface_id.to_string()).or_default();
    match event_name {
        "Runtime.consoleAPICalled" => {
            let level = payload
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("log")
                .to_ascii_lowercase();
            let args_text = payload
                .get("args")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(|a| {
                            a.get("value")
                                .map(|v| {
                                    if let Some(s) = v.as_str() {
                                        s.to_string()
                                    } else {
                                        v.to_string()
                                    }
                                })
                                .or_else(|| {
                                    a.get("description")
                                        .and_then(Value::as_str)
                                        .map(str::to_string)
                                })
                        })
                        .collect::<Vec<_>>()
                        .join(" ")
                })
                .unwrap_or_default();
            let top_frame = payload
                .get("stackTrace")
                .and_then(|s| s.get("callFrames"))
                .and_then(Value::as_array)
                .and_then(|f| f.first());
            let source = top_frame
                .and_then(|f| f.get("url"))
                .and_then(Value::as_str)
                .map(|u| truncate_chars(u, 256));
            let line = top_frame.and_then(|f| f.get("lineNumber")).and_then(Value::as_u64);
            state.push_console(ConsoleEntry {
                level,
                text: args_text,
                source,
                line,
                timestamp_ms: now_ms(),
            });
        }
        "Runtime.exceptionThrown" => {
            let details = payload.get("exceptionDetails");
            let text = details
                .and_then(|d| {
                    d.get("exception")
                        .and_then(|e| e.get("description"))
                        .and_then(Value::as_str)
                        .or_else(|| d.get("text").and_then(Value::as_str))
                })
                .unwrap_or("Uncaught page exception")
                .to_string();
            let source = details
                .and_then(|d| d.get("url"))
                .and_then(Value::as_str)
                .map(|u| truncate_chars(u, 256));
            let line = details.and_then(|d| d.get("lineNumber")).and_then(Value::as_u64);
            state.push_console(ConsoleEntry {
                level: "exception".to_string(),
                text,
                source,
                line,
                timestamp_ms: now_ms(),
            });
        }
        "Network.requestWillBeSent" => {
            let Some(req_id) = payload.get("requestId").and_then(Value::as_str) else {
                return;
            };
            let req = payload.get("request");
            let url = req
                .and_then(|r| r.get("url"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if url.starts_with("data:") {
                return;
            }
            let method = req
                .and_then(|r| r.get("method"))
                .and_then(Value::as_str)
                .unwrap_or("GET")
                .to_string();
            let raw_headers = req
                .and_then(|r| r.get("headers"))
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let resource_type = payload
                .get("type")
                .and_then(Value::as_str)
                .map(str::to_string);
            state.record_network_request(NetworkEntry {
                request_id: req_id.to_string(),
                url: truncate_chars(&scrub_text_secrets(&url), 1024),
                method,
                status: None,
                status_text: None,
                resource_type,
                mime_type: None,
                failed: false,
                error_text: None,
                request_headers: scrub_headers(&raw_headers),
                response_headers: serde_json::Map::new(),
                timestamp_ms: now_ms(),
            });
        }
        "Network.responseReceived" => {
            let Some(req_id) = payload.get("requestId").and_then(Value::as_str) else {
                return;
            };
            let resp = payload.get("response");
            let status = resp
                .and_then(|r| r.get("status"))
                .and_then(Value::as_u64)
                .map(|s| s as u16);
            let status_text = resp
                .and_then(|r| r.get("statusText"))
                .and_then(Value::as_str)
                .map(str::to_string);
            let mime_type = resp
                .and_then(|r| r.get("mimeType"))
                .and_then(Value::as_str)
                .map(str::to_string);
            let headers = resp
                .and_then(|r| r.get("headers"))
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            state.finish_network_request(
                req_id,
                status,
                status_text,
                mime_type,
                headers,
                false,
                None,
            );
        }
        "Network.loadingFailed" => {
            let Some(req_id) = payload.get("requestId").and_then(Value::as_str) else {
                return;
            };
            let err_text = payload
                .get("errorText")
                .and_then(Value::as_str)
                .unwrap_or("net::ERR_FAILED")
                .to_string();
            state.finish_network_request(
                req_id,
                None,
                None,
                None,
                serde_json::Map::new(),
                true,
                Some(err_text),
            );
        }
        _ => {}
    }
}

// ============================================================================
// Accessibility Tree Normalization & Compact @eN Ref Indexing
// ============================================================================

fn is_interactive_role(role: &str) -> bool {
    matches!(
        role.to_ascii_lowercase().as_str(),
        "button"
            | "link"
            | "textbox"
            | "searchbox"
            | "combobox"
            | "listbox"
            | "option"
            | "checkbox"
            | "radio"
            | "switch"
            | "slider"
            | "spinbutton"
            | "tab"
            | "menuitem"
            | "menuitemcheckbox"
            | "menuitemradio"
            | "treeitem"
    )
}

fn is_landmark_role(role: &str) -> bool {
    matches!(
        role.to_ascii_lowercase().as_str(),
        "banner"
            | "navigation"
            | "main"
            | "contentinfo"
            | "complementary"
            | "form"
            | "search"
            | "region"
            | "dialog"
            | "alertdialog"
    )
}

fn is_interesting_role(role: &str) -> bool {
    let lower = role.to_ascii_lowercase();
    is_interactive_role(&lower)
        || is_landmark_role(&lower)
        || matches!(
            lower.as_str(),
            "heading"
                | "status"
                | "alert"
                | "progressbar"
                | "table"
                | "row"
                | "cell"
                | "columnheader"
                | "img"
                | "article"
                | "list"
                | "listitem"
                | "rootwebarea"
        )
}

/// Converts a raw CDP `Accessibility.getFullAXTree` JSON payload into canonical `AxNode`s,
/// compact interactive `@eN` refs, and a clean indented ARIA snapshot string.
pub fn parse_cdp_ax_tree(
    raw_cdp_result: &Value,
    url: &str,
    title: &str,
    interactive_only: bool,
) -> (Vec<AxNode>, AxSnapshotIndex, String) {
    let raw_nodes = raw_cdp_result
        .get("nodes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut by_id: HashMap<String, &Value> = HashMap::with_capacity(raw_nodes.len());
    for n in &raw_nodes {
        if let Some(id) = n.get("nodeId").and_then(Value::as_str) {
            by_id.insert(id.to_string(), n);
        }
    }

    let mut ax_nodes: Vec<AxNode> = Vec::new();
    let mut refs_map: HashMap<String, IndexedAxRef> = HashMap::new();
    let mut lines: Vec<String> = Vec::new();
    let mut ref_counter: usize = 0;
    let mut sibling_counts: HashMap<(String, String, String), usize> = HashMap::new();
    let mut landmark_set: HashSet<String> = HashSet::new();
    let mut visited: HashSet<String> = HashSet::new();

    #[allow(clippy::too_many_arguments)]
    fn walk(
        node_id: &str,
        depth: usize,
        active_landmark: Option<&str>,
        by_id: &HashMap<String, &Value>,
        interactive_only: bool,
        visited: &mut HashSet<String>,
        sibling_counts: &mut HashMap<(String, String, String), usize>,
        landmark_set: &mut HashSet<String>,
        ref_counter: &mut usize,
        ax_nodes: &mut Vec<AxNode>,
        refs_map: &mut HashMap<String, IndexedAxRef>,
        lines: &mut Vec<String>,
    ) {
        if depth > 40 || !visited.insert(node_id.to_string()) {
            return;
        }
        let Some(node) = by_id.get(node_id) else {
            return;
        };
        let ignored = node.get("ignored").and_then(Value::as_bool).unwrap_or(false);
        let role = node
            .get("role")
            .and_then(|r| r.get("value"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let role_lower = role.to_ascii_lowercase();
        let name_raw = node
            .get("name")
            .and_then(|n| n.get("value"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        let name = redact_sensitive_browser_text(&name_raw);

        let value_raw = node
            .get("value")
            .and_then(|v| v.get("value"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);

        let mut disabled = false;
        let mut checked: Option<bool> = None;
        let mut expanded: Option<bool> = None;
        let mut is_password = false;

        if let Some(props) = node.get("properties").and_then(Value::as_array) {
            for prop in props {
                let pname = prop.get("name").and_then(Value::as_str).unwrap_or("");
                let pval = prop.get("value").and_then(|v| v.get("value"));
                match pname {
                    "disabled" => disabled = pval.and_then(Value::as_bool).unwrap_or(false),
                    "checked" => {
                        checked = pval.and_then(|v| {
                            v.as_bool()
                                .or_else(|| v.as_str().map(|s| s == "true"))
                        });
                    }
                    "expanded" => expanded = pval.and_then(Value::as_bool),
                    "inputType" => {
                        if pval
                            .and_then(Value::as_str)
                            .is_some_and(|t| t.eq_ignore_ascii_case("password"))
                        {
                            is_password = true;
                        }
                    }
                    _ => {}
                }
            }
        }

        let value = if is_password {
            Some("[REDACTED]".to_string())
        } else {
            value_raw.map(|v| redact_sensitive_browser_text(&v))
        };

        let next_landmark_owned: Option<String> = if is_landmark_role(&role_lower) {
            landmark_set.insert(role_lower.clone());
            Some(role_lower.clone())
        } else {
            active_landmark.map(str::to_string)
        };
        let next_landmark = next_landmark_owned.as_deref();

        let interactive = !ignored && is_interactive_role(&role_lower);
        let interesting = !ignored
            && is_interesting_role(&role_lower)
            && (!role_lower.is_empty())
            && (interactive
                || is_landmark_role(&role_lower)
                || !name.is_empty()
                || value.is_some());

        let emit_node = if interactive_only {
            interactive || is_landmark_role(&role_lower)
        } else {
            interesting
        };

        if emit_node && role_lower != "rootwebarea" {
            let frame_id = node
                .get("frameId")
                .and_then(Value::as_str)
                .unwrap_or("top")
                .to_string();
            let counter_key = (
                next_landmark.unwrap_or("root").to_string(),
                role_lower.clone(),
                name.clone(),
            );
            let ord = sibling_counts.entry(counter_key).or_insert(0);
            let sibling_ordinal = *ord;
            *ord += 1;

            let stable_key = AxNode::compute_stable_key(
                &frame_id,
                next_landmark,
                &role_lower,
                &name,
                sibling_ordinal,
            );
            let ref_id = if interactive || is_landmark_role(&role_lower) {
                *ref_counter += 1;
                Some(format!("e{}", *ref_counter))
            } else {
                None
            };

            let backend_dom_node_id = node.get("backendDOMNodeId").and_then(Value::as_i64);

            if let Some(ref rid) = ref_id {
                refs_map.insert(
                    rid.clone(),
                    IndexedAxRef {
                        ref_id: rid.clone(),
                        backend_dom_node_id,
                        role: role_lower.clone(),
                        name: name.clone(),
                        landmark: next_landmark.map(str::to_string),
                        value: value.clone(),
                        stable_key: stable_key.clone(),
                        interactive,
                        disabled,
                    },
                );
            }

            let indent = "  ".repeat(depth.min(8));
            let mut line = format!("{indent}- {role_lower}");
            if !name.is_empty() {
                line.push_str(&format!(" \"{}\"", truncate_chars(&name, 120)));
            }
            if let Some(ref rid) = ref_id {
                line.push_str(&format!(" [ref={rid}]"));
            }
            if let Some(ref val) = value {
                line.push_str(&format!(" val=\"{}\"", truncate_chars(val, 80)));
            }
            if disabled {
                line.push_str(" [disabled]");
            }
            if let Some(c) = checked {
                line.push_str(if c { " [checked]" } else { " [unchecked]" });
            }
            if let Some(e) = expanded {
                line.push_str(if e { " [expanded]" } else { " [collapsed]" });
            }
            lines.push(line);

            ax_nodes.push(AxNode {
                ref_id,
                role: role_lower,
                name,
                value,
                landmark: next_landmark.map(str::to_string),
                frame_id,
                depth,
                sibling_ordinal,
                interactive,
                disabled,
                checked,
                expanded,
                stable_key,
            });
        }

        if let Some(children) = node.get("childIds").and_then(Value::as_array) {
            for cid in children.iter().filter_map(Value::as_str) {
                walk(
                    cid,
                    if emit_node { depth + 1 } else { depth },
                    next_landmark,
                    by_id,
                    interactive_only,
                    visited,
                    sibling_counts,
                    landmark_set,
                    ref_counter,
                    ax_nodes,
                    refs_map,
                    lines,
                );
            }
        }
    }

    if let Some(root_id) = raw_nodes
        .first()
        .and_then(|n| n.get("nodeId"))
        .and_then(Value::as_str)
    {
        walk(
            root_id,
            0,
            None,
            &by_id,
            interactive_only,
            &mut visited,
            &mut sibling_counts,
            &mut landmark_set,
            &mut ref_counter,
            &mut ax_nodes,
            &mut refs_map,
            &mut lines,
        );
    }

    let (_, structure_hash) = kite_ctx::browser_cache::compute_ax_hashes(&ax_nodes);
    let mut landmark_keys: Vec<String> = landmark_set.into_iter().collect();
    landmark_keys.sort();

    let header = if title.trim().is_empty() {
        format!("RootWebArea \"{url}\"")
    } else {
        format!("RootWebArea \"{}\" ({url})", truncate_chars(title, 120))
    };
    let mut full_text = String::with_capacity(header.len() + lines.len() * 48);
    full_text.push_str(&header);
    for l in &lines {
        full_text.push('\n');
        full_text.push_str(l);
    }

    let index = AxSnapshotIndex {
        url: url.to_string(),
        title: title.to_string(),
        structure_hash,
        landmark_keys,
        refs: refs_map,
        nodes: ax_nodes.clone(),
    };

    (ax_nodes, index, full_text)
}

/// Resolves a `@eN` ref, role+name, or locator spec against an `AxSnapshotIndex`.
pub fn resolve_locator_in_index<'a>(
    index: &'a AxSnapshotIndex,
    ref_or_selector: Option<&str>,
    locator: Option<&LocatorSpec>,
) -> Option<&'a IndexedAxRef> {
    if let Some(raw) = ref_or_selector {
        let cleaned = raw
            .trim()
            .trim_start_matches('@')
            .trim_start_matches("ref=");
        if let Some(found) = index.refs.get(cleaned) {
            return Some(found);
        }
    }
    if let Some(loc) = locator {
        if let Some(ref sk) = loc.stable_key {
            if let Some(found) = index.refs.values().find(|r| r.stable_key == *sk) {
                return Some(found);
            }
        }
        let target_role = loc.role.trim().to_ascii_lowercase();
        let target_name = loc.name.trim().to_ascii_lowercase();
        if let Some(found) = index.refs.values().find(|r| {
            r.role.eq_ignore_ascii_case(&target_role)
                && r.name.trim().to_ascii_lowercase() == target_name
                && loc
                    .landmark
                    .as_deref()
                    .is_none_or(|lm| r.landmark.as_deref() == Some(lm))
        }) {
            return Some(found);
        }
        if !target_name.is_empty() {
            if let Some(found) = index.refs.values().find(|r| {
                r.role.eq_ignore_ascii_case(&target_role)
                    && r.name.to_ascii_lowercase().contains(&target_name)
            }) {
                return Some(found);
            }
        }
    }
    None
}

// ============================================================================
// Live WebView2 CDP Operations (Snapshot, Emulation, Screenshot, Act, Batch)
// ============================================================================

pub async fn set_viewport_emulation(
    webview: &tauri::Webview,
    width: u32,
    height: u32,
    mobile: bool,
) -> Result<(), String> {
    call_cdp(
        webview,
        "Emulation.setDeviceMetricsOverride",
        json!({
            "width": width.clamp(320, 3840),
            "height": height.clamp(320, 2160),
            "deviceScaleFactor": 1.0,
            "mobile": mobile,
        }),
        4000,
    )
    .await
    .map(|_| ())
}

async fn read_page_meta(webview: &tauri::Webview) -> (String, String) {
    let eval = call_cdp(
        webview,
        "Runtime.evaluate",
        json!({
            "expression": "JSON.stringify({ url: location.href, title: document.title || '' })",
            "returnByValue": true
        }),
        3000,
    )
    .await;
    if let Ok(val) = eval {
        if let Some(raw) = val
            .get("result")
            .and_then(|r| r.get("value"))
            .and_then(Value::as_str)
        {
            if let Ok(parsed) = serde_json::from_str::<Value>(raw) {
                let url = parsed
                    .get("url")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let title = parsed
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                return (url, title);
            }
        }
    }
    (String::new(), String::new())
}

async fn resolve_center_point(
    webview: &tauri::Webview,
    surface_id: &str,
    step: &Value,
) -> Result<(f64, f64), String> {
    if let (Some(x), Some(y)) = (
        step.get("x").and_then(Value::as_f64),
        step.get("y").and_then(Value::as_f64),
    ) {
        return Ok((x, y));
    }

    let ref_str = step
        .get("ref")
        .or_else(|| step.get("refId"))
        .and_then(Value::as_str);
    let locator: Option<LocatorSpec> = step
        .get("locator")
        .and_then(|v| serde_json::from_value(v.clone()).ok());

    let backend_node_id = {
        let map = ax_index_map().lock().unwrap();
        map.get(surface_id)
            .and_then(|idx| resolve_locator_in_index(idx, ref_str, locator.as_ref()))
            .and_then(|r| r.backend_dom_node_id)
    };

    if let Some(backend_id) = backend_node_id {
        let _ = call_cdp(
            webview,
            "DOM.scrollIntoViewIfNeeded",
            json!({ "backendNodeId": backend_id }),
            3000,
        )
        .await;
        if let Ok(box_res) = call_cdp(
            webview,
            "DOM.getBoxModel",
            json!({ "backendNodeId": backend_id }),
            3000,
        )
        .await
        {
            if let Some(quad) = box_res
                .get("model")
                .and_then(|m| m.get("content"))
                .and_then(Value::as_array)
            {
                if quad.len() >= 8 {
                    let x0 = quad[0].as_f64().unwrap_or(0.0);
                    let y0 = quad[1].as_f64().unwrap_or(0.0);
                    let x2 = quad[4].as_f64().unwrap_or(x0);
                    let y2 = quad[5].as_f64().unwrap_or(y0);
                    return Ok(((x0 + x2) / 2.0, (y0 + y2) / 2.0));
                }
            }
        }
    }

    let selector = step
        .get("selector")
        .and_then(Value::as_str)
        .or_else(|| locator.as_ref().and_then(|l| l.css_fallback.as_deref()));

    if let Some(sel) = selector {
        let sel_json = serde_json::to_string(sel).unwrap_or_else(|_| "\"\"".to_string());
        let expr = format!(
            "(() => {{ const el = document.querySelector({sel_json}); if (!el) return null; el.scrollIntoView({{ block: 'center', inline: 'center' }}); const r = el.getBoundingClientRect(); return {{ x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }}; }})()"
        );
        let res = call_cdp(
            webview,
            "Runtime.evaluate",
            json!({ "expression": expr, "returnByValue": true }),
            4000,
        )
        .await?;
        let val = res.get("result").and_then(|r| r.get("value"));
        if let Some(obj) = val.and_then(Value::as_object) {
            if let (Some(x), Some(y)) = (
                obj.get("x").and_then(Value::as_f64),
                obj.get("y").and_then(Value::as_f64),
            ) {
                return Ok((x, y));
            }
        }
        return Err(format!("Element not found for selector `{sel}`"));
    }

    Err("Target element not resolved: provide `ref`, `selector`, `locator`, or `(x, y)` coordinates.".to_string())
}

async fn dispatch_mouse_click(webview: &tauri::Webview, x: f64, y: f64, click_count: u32) -> Result<(), String> {
    call_cdp(
        webview,
        "Input.dispatchMouseEvent",
        json!({ "type": "mouseMoved", "x": x, "y": y }),
        3000,
    )
    .await?;
    call_cdp(
        webview,
        "Input.dispatchMouseEvent",
        json!({ "type": "mousePressed", "x": x, "y": y, "button": "left", "clickCount": click_count }),
        3000,
    )
    .await?;
    call_cdp(
        webview,
        "Input.dispatchMouseEvent",
        json!({ "type": "mouseReleased", "x": x, "y": y, "button": "left", "clickCount": click_count }),
        3000,
    )
    .await?;
    Ok(())
}

async fn dispatch_key_press(webview: &tauri::Webview, key: &str) -> Result<(), String> {
    let (code, vk) = match key {
        "Enter" => ("Enter", 13),
        "Escape" => ("Escape", 27),
        "Tab" => ("Tab", 9),
        "Backspace" => ("Backspace", 8),
        "Delete" => ("Delete", 46),
        "ArrowUp" => ("ArrowUp", 38),
        "ArrowDown" => ("ArrowDown", 40),
        "ArrowLeft" => ("ArrowLeft", 37),
        "ArrowRight" => ("ArrowRight", 39),
        "Space" | " " => ("Space", 32),
        other => (other, 0),
    };
    call_cdp(
        webview,
        "Input.dispatchKeyEvent",
        json!({
            "type": "keyDown",
            "key": key,
            "code": code,
            "windowsVirtualKeyCode": vk
        }),
        3000,
    )
    .await?;
    call_cdp(
        webview,
        "Input.dispatchKeyEvent",
        json!({
            "type": "keyUp",
            "key": key,
            "code": code,
            "windowsVirtualKeyCode": vk
        }),
        3000,
    )
    .await?;
    Ok(())
}

/// Captures a snapshot via in-process CDP and compresses/diffs it through `kite-ctx`.
pub async fn capture_ax_snapshot(
    webview: &tauri::Webview,
    surface_id: &str,
    session_id: &str,
    mode: BrowserReadMode,
    fresh: bool,
    agent: &str,
    provider: &str,
    model: &str,
) -> Result<Value, String> {
    ensure_telemetry_attached(surface_id, webview).await?;
    let (live_url, title) = read_page_meta(webview).await;
    if !title.is_empty() {
        browser::update_surface_title(surface_id, &title);
    }

    // Check for sensitive page pause before handing page state to agent.
    let effective_url = if live_url.is_empty() {
        browser::surface_url_of(surface_id).unwrap_or_default()
    } else {
        live_url.clone()
    };
    if let Some(sensitive) =
        browser_policy::detect_sensitive_page(&effective_url, Some(&title), None)
    {
        let reason = format!(
            "Paused on {:?} page ({effective_url}). Complete authentication or payment manually, then resume the agent.",
            sensitive
        );
        browser::set_browser_surface_paused(surface_id, true, Some(&reason));
        return Ok(json!({
            "ok": false,
            "pausedForUser": true,
            "sensitiveKind": sensitive,
            "surfaceId": surface_id,
            "url": effective_url,
            "title": title,
            "reason": reason
        }));
    }

    let raw_ax = call_cdp(
        webview,
        "Accessibility.getFullAXTree",
        json!({ "depth": 18 }),
        DEFAULT_CDP_TIMEOUT_MS,
    )
    .await?;

    let interactive_only = matches!(mode, BrowserReadMode::InteractiveOnly);
    let (ax_nodes, index, raw_text) =
        parse_cdp_ax_tree(&raw_ax, &effective_url, &title, interactive_only);

    let ref_count = index.refs.len();
    let structure_hash = index.structure_hash.clone();
    if let Ok(mut map) = ax_index_map().lock() {
        map.insert(surface_id.to_string(), index);
    }

    if let Ok(engine) = ContextEngine::open_default() {
        let input = BrowserSnapshotInput {
            session_id: session_id.to_string(),
            tab_id: surface_id.to_string(),
            url: effective_url.clone(),
            title: if title.is_empty() {
                None
            } else {
                Some(title.clone())
            },
            raw_text: raw_text.clone(),
            nodes: Some(ax_nodes),
            mode,
            fresh,
            agent: agent.to_string(),
            provider: provider.to_string(),
            model: model.to_string(),
        };
        if let Ok(res) = engine
            .browser_cache()
            .ingest_snapshot(&input, &engine.ccr(), &engine.ledger())
        {
            return Ok(json!({
                "ok": true,
                "surfaceId": surface_id,
                "url": effective_url,
                "title": title,
                "outcome": res.outcome,
                "snapshot": res.text,
                "fullHash": res.full_hash,
                "structureHash": res.structure_hash,
                "chromeHash": res.chrome_hash,
                "ccrHash": res.ccr_hash,
                "rawTokens": res.raw_tokens,
                "deliveredTokens": res.delivered_tokens,
                "tokensSaved": res.tokens_saved,
                "nodeCount": res.node_count,
                "refCount": ref_count
            }));
        }
    }

    Ok(json!({
        "ok": true,
        "surfaceId": surface_id,
        "url": effective_url,
        "title": title,
        "outcome": "full",
        "snapshot": raw_text,
        "structureHash": structure_hash,
        "refCount": ref_count
    }))
}

/// Captures an on-demand screenshot via CDP with SHA-256 deduplication and telemetry logging.
pub async fn capture_screenshot(
    webview: &tauri::Webview,
    surface_id: &str,
    session_id: &str,
    format: &str,
    quality: u8,
    full_page: bool,
    dedup: bool,
) -> Result<Value, String> {
    ensure_telemetry_attached(surface_id, webview).await?;
    let fmt = if format.eq_ignore_ascii_case("png") {
        "png"
    } else {
        "jpeg"
    };
    let mut params = json!({
        "format": fmt,
        "fromSurface": true,
        "captureBeyondViewport": full_page,
    });
    if fmt == "jpeg" {
        params["quality"] = json!(quality.clamp(35, 95));
    }

    let res = call_cdp(webview, "Page.captureScreenshot", params, DEFAULT_CDP_TIMEOUT_MS).await?;
    let data = res
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(|| "CDP Page.captureScreenshot returned empty data".to_string())?;
    let hash = sha256_short(data);
    let mime = if fmt == "png" { "image/png" } else { "image/jpeg" };

    let mut duplicate_turn: Option<usize> = None;
    if let Ok(mut map) = telemetry_map().lock() {
        let st = map.entry(surface_id.to_string()).or_default();
        st.screenshot_turn_counter += 1;
        if dedup && st.last_screenshot_hash.as_deref() == Some(hash.as_str()) {
            duplicate_turn = Some(st.last_screenshot_turn);
        } else {
            st.last_screenshot_hash = Some(hash.clone());
            st.last_screenshot_turn = st.screenshot_turn_counter;
        }
    }

    if let Some(prev_turn) = duplicate_turn {
        if let Ok(engine) = ContextEngine::open_default() {
            let _ = engine.ledger().record(&LedgerEventInput {
                session_id: session_id.to_string(),
                agent: "browser".to_string(),
                provider: "local".to_string(),
                model: "webview2-cdp".to_string(),
                category: "browser".to_string(),
                command_or_tool: "browser:screenshot_dedup".to_string(),
                raw_tokens: 1300,
                compressed_tokens: 15,
                cache_hit: true,
                overhead_ms: 1,
            });
        }
        return Ok(json!({
            "ok": true,
            "surfaceId": surface_id,
            "unchanged": true,
            "sha256": hash,
            "mimeType": mime,
            "summary": format!("[Screenshot unchanged since capture #{prev_turn} — sha256:{hash}]")
        }));
    }

    Ok(json!({
        "ok": true,
        "surfaceId": surface_id,
        "unchanged": false,
        "sha256": hash,
        "mimeType": mime,
        "byteLength": data.len(),
        "dataBase64": data
    }))
}

/// Executes a single structured browser action or assertion step.
pub async fn execute_single_step(
    webview: &tauri::Webview,
    surface_id: &str,
    step: &Value,
) -> Result<Value, String> {
    if browser::is_agent_takeover_requested(surface_id) {
        return Err("agent_takeover_requested: user stopped agent control on this tab.".to_string());
    }

    let op = step
        .get("op")
        .or_else(|| step.get("action"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();

    match op.as_str() {
        "click" | "double_click" => {
            let (x, y) = resolve_center_point(webview, surface_id, step).await?;
            let count = if op == "double_click" { 2 } else { 1 };
            dispatch_mouse_click(webview, x, y, count).await?;
            Ok(json!({ "op": op, "ok": true, "x": x, "y": y }))
        }
        "hover" => {
            let (x, y) = resolve_center_point(webview, surface_id, step).await?;
            call_cdp(
                webview,
                "Input.dispatchMouseEvent",
                json!({ "type": "mouseMoved", "x": x, "y": y }),
                3000,
            )
            .await?;
            Ok(json!({ "op": "hover", "ok": true, "x": x, "y": y }))
        }
        "fill" | "type" => {
            let text = step
                .get("value")
                .or_else(|| step.get("text"))
                .and_then(Value::as_str)
                .ok_or_else(|| format!("`{op}` requires `value` or `text`"))?;
            let (x, y) = resolve_center_point(webview, surface_id, step).await?;
            dispatch_mouse_click(webview, x, y, 1).await?;
            if op == "fill" {
                let _ = call_cdp(
                    webview,
                    "Runtime.evaluate",
                    json!({
                        "expression": "(() => { const el = document.activeElement; if (el && 'value' in el) { el.select?.(); el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); } })()"
                    }),
                    2000,
                )
                .await;
            }
            call_cdp(webview, "Input.insertText", json!({ "text": text }), 3000).await?;
            Ok(json!({ "op": op, "ok": true, "chars": text.len() }))
        }
        "press" => {
            let key = step
                .get("key")
                .or_else(|| step.get("value"))
                .and_then(Value::as_str)
                .ok_or_else(|| "`press` requires `key`".to_string())?;
            dispatch_key_press(webview, key).await?;
            Ok(json!({ "op": "press", "ok": true, "key": key }))
        }
        "scroll" => {
            let delta_x = step.get("deltaX").and_then(Value::as_f64).unwrap_or(0.0);
            let delta_y = step.get("deltaY").and_then(Value::as_f64).unwrap_or(400.0);
            let x = step.get("x").and_then(Value::as_f64).unwrap_or(640.0);
            let y = step.get("y").and_then(Value::as_f64).unwrap_or(400.0);
            call_cdp(
                webview,
                "Input.dispatchMouseEvent",
                json!({
                    "type": "mouseWheel",
                    "x": x,
                    "y": y,
                    "deltaX": delta_x,
                    "deltaY": delta_y
                }),
                3000,
            )
            .await?;
            Ok(json!({ "op": "scroll", "ok": true, "deltaX": delta_x, "deltaY": delta_y }))
        }
        "select" => {
            let selector = step
                .get("selector")
                .and_then(Value::as_str)
                .ok_or_else(|| "`select` requires `selector`".to_string())?;
            let value = step
                .get("value")
                .and_then(Value::as_str)
                .ok_or_else(|| "`select` requires `value`".to_string())?;
            let sel_j = serde_json::to_string(selector).unwrap_or_else(|_| "\"\"".to_string());
            let val_j = serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string());
            let expr = format!(
                "(() => {{ const el = document.querySelector({sel_j}); if (!el) return false; el.value = {val_j}; el.dispatchEvent(new Event('change', {{ bubbles: true }})); return true; }})()"
            );
            let res = call_cdp(
                webview,
                "Runtime.evaluate",
                json!({ "expression": expr, "returnByValue": true }),
                3000,
            )
            .await?;
            let matched = res
                .get("result")
                .and_then(|r| r.get("value"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if !matched {
                return Err(format!("Select target `{selector}` not found"));
            }
            Ok(json!({ "op": "select", "ok": true, "selector": selector, "value": value }))
        }
        "wait_for" => {
            let timeout_ms = step
                .get("timeoutMs")
                .and_then(Value::as_u64)
                .unwrap_or(5000)
                .clamp(100, 30_000);
            let target_text = step.get("text").and_then(Value::as_str);
            let target_sel = step.get("selector").and_then(Value::as_str);
            let target_url = step.get("urlContains").and_then(Value::as_str);
            let started = Instant::now();
            while started.elapsed() < Duration::from_millis(timeout_ms) {
                if browser::is_agent_takeover_requested(surface_id) {
                    return Err("agent_takeover_requested".to_string());
                }
                if let Some(sub) = target_url {
                    let (url, _) = read_page_meta(webview).await;
                    if url.contains(sub) {
                        return Ok(json!({ "op": "wait_for", "ok": true, "url": url }));
                    }
                } else if let Some(sel) = target_sel {
                    let sel_j = serde_json::to_string(sel).unwrap_or_else(|_| "\"\"".to_string());
                    let res = call_cdp(
                        webview,
                        "Runtime.evaluate",
                        json!({
                            "expression": format!("Boolean(document.querySelector({sel_j}))"),
                            "returnByValue": true
                        }),
                        2000,
                    )
                    .await;
                    if res
                        .ok()
                        .and_then(|v| v.get("result")?.get("value")?.as_bool())
                        .unwrap_or(false)
                    {
                        return Ok(json!({ "op": "wait_for", "ok": true, "selector": sel }));
                    }
                } else if let Some(txt) = target_text {
                    let txt_j = serde_json::to_string(txt).unwrap_or_else(|_| "\"\"".to_string());
                    let res = call_cdp(
                        webview,
                        "Runtime.evaluate",
                        json!({
                            "expression": format!("(document.body?.innerText || '').includes({txt_j})"),
                            "returnByValue": true
                        }),
                        2000,
                    )
                    .await;
                    if res
                        .ok()
                        .and_then(|v| v.get("result")?.get("value")?.as_bool())
                        .unwrap_or(false)
                    {
                        return Ok(json!({ "op": "wait_for", "ok": true, "text": txt }));
                    }
                } else {
                    tokio::time::sleep(Duration::from_millis(timeout_ms.min(500))).await;
                    return Ok(json!({ "op": "wait_for", "ok": true }));
                }
                tokio::time::sleep(Duration::from_millis(120)).await;
            }
            Err(format!("wait_for timed out after {timeout_ms}ms"))
        }
        "assert_text" => {
            let expected = step
                .get("expected")
                .or_else(|| step.get("text"))
                .and_then(Value::as_str)
                .ok_or_else(|| "`assert_text` requires `expected` or `text`".to_string())?;
            let exp_j = serde_json::to_string(expected).unwrap_or_else(|_| "\"\"".to_string());
            let res = call_cdp(
                webview,
                "Runtime.evaluate",
                json!({
                    "expression": format!("(document.body?.innerText || '').includes({exp_j})"),
                    "returnByValue": true
                }),
                3000,
            )
            .await?;
            let passed = res
                .get("result")
                .and_then(|r| r.get("value"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if !passed {
                return Err(format!("Assertion failed: text `{expected}` not found on page"));
            }
            Ok(json!({ "op": "assert_text", "ok": true, "passed": true, "expected": expected }))
        }
        "assert_url" => {
            let expected = step
                .get("expected")
                .or_else(|| step.get("urlContains"))
                .and_then(Value::as_str)
                .ok_or_else(|| "`assert_url` requires `expected`".to_string())?;
            let (url, _) = read_page_meta(webview).await;
            if !url.contains(expected) {
                return Err(format!(
                    "Assertion failed: URL `{url}` does not contain `{expected}`"
                ));
            }
            Ok(json!({ "op": "assert_url", "ok": true, "passed": true, "actual": url, "expected": expected }))
        }
        "assert_no_errors" => {
            let (console_errs, net_errs) = telemetry_map()
                .lock()
                .ok()
                .and_then(|m| m.get(surface_id).map(|s| s.errors_only()))
                .unwrap_or_default();
            let hard_console: Vec<_> = console_errs
                .into_iter()
                .filter(|c| matches!(c.level.as_str(), "error" | "exception"))
                .collect();
            if !hard_console.is_empty() || !net_errs.is_empty() {
                return Err(format!(
                    "Assertion failed: {} console error(s), {} failed network request(s)",
                    hard_console.len(),
                    net_errs.len()
                ));
            }
            Ok(json!({ "op": "assert_no_errors", "ok": true, "passed": true }))
        }
        "resize" => {
            let width = step
                .get("width")
                .and_then(Value::as_u64)
                .unwrap_or(DEFAULT_EMULATED_WIDTH as u64) as u32;
            let height = step
                .get("height")
                .and_then(Value::as_u64)
                .unwrap_or(DEFAULT_EMULATED_HEIGHT as u64) as u32;
            let mobile = step.get("mobile").and_then(Value::as_bool).unwrap_or(width <= 500);
            set_viewport_emulation(webview, width, height, mobile).await?;
            Ok(json!({ "op": "resize", "ok": true, "width": width, "height": height, "mobile": mobile }))
        }
        other => Err(format!("Unsupported browser action `{other}`")),
    }
}

/// Runs a batched multi-step action sequence in one round-trip, stopping immediately
/// on user takeover, sensitive page transition, or first failure.
pub async fn execute_batch(
    webview: &tauri::Webview,
    surface_id: &str,
    session_id: &str,
    steps: &[Value],
    include_final_snapshot: bool,
    agent: &str,
    provider: &str,
    model: &str,
) -> Value {
    let mut results: Vec<Value> = Vec::with_capacity(steps.len());
    for (idx, step) in steps.iter().enumerate() {
        let label = step
            .get("op")
            .or_else(|| step.get("action"))
            .and_then(Value::as_str)
            .unwrap_or("step");
        browser::set_browser_surface_agent_state(
            surface_id,
            true,
            Some(&format!("Step {}/{}: {label}", idx + 1, steps.len())),
        );
        match execute_single_step(webview, surface_id, step).await {
            Ok(res) => results.push(json!({ "index": idx, "result": res })),
            Err(err) => {
                browser::set_browser_surface_agent_state(surface_id, false, None);
                let snap = if include_final_snapshot {
                    capture_ax_snapshot(
                        webview,
                        surface_id,
                        session_id,
                        BrowserReadMode::Diff,
                        false,
                        agent,
                        provider,
                        model,
                    )
                    .await
                    .ok()
                } else {
                    None
                };
                return json!({
                    "ok": false,
                    "surfaceId": surface_id,
                    "completedSteps": idx,
                    "totalSteps": steps.len(),
                    "failedStepIndex": idx,
                    "error": err,
                    "steps": results,
                    "snapshot": snap
                });
            }
        }
    }

    browser::set_browser_surface_agent_state(surface_id, false, None);
    let snap = if include_final_snapshot {
        capture_ax_snapshot(
            webview,
            surface_id,
            session_id,
            BrowserReadMode::Diff,
            false,
            agent,
            provider,
            model,
        )
        .await
        .ok()
    } else {
        None
    };

    json!({
        "ok": true,
        "surfaceId": surface_id,
        "completedSteps": steps.len(),
        "totalSteps": steps.len(),
        "steps": results,
        "snapshot": snap
    })
}

/// Executes a verified `BrowserRecipe` deterministically at ~0 LLM tokens with 2-strike
/// quarantine and structured self-healing diagnostics if a step fails.
pub async fn replay_recipe_on_surface(
    webview: &tauri::Webview,
    surface_id: &str,
    session_id: &str,
    intent: &str,
    params: &HashMap<String, String>,
    agent: &str,
    provider: &str,
    model: &str,
) -> Value {
    let Ok(engine) = ContextEngine::open_default() else {
        return json!({ "ok": false, "error": "kite-ctx store unavailable for recipe replay" });
    };

    let (url, _) = read_page_meta(webview).await;
    let effective_url = if url.is_empty() {
        browser::surface_url_of(surface_id).unwrap_or_default()
    } else {
        url
    };
    let origin = extract_origin(&effective_url);
    let route = canonicalize_route(&effective_url);

    let (structure_hash, landmark_keys) = {
        let map = ax_index_map().lock().unwrap();
        map.get(surface_id)
            .map(|idx| (idx.structure_hash.clone(), idx.landmark_keys.clone()))
            .unwrap_or_default()
    };

    let lookup = match engine.browser_recipes().resolve(
        &origin,
        &route,
        intent,
        &structure_hash,
        &landmark_keys,
    ) {
        Ok(r) => r,
        Err(err) => return json!({ "ok": false, "error": format!("recipe lookup failed: {err}") }),
    };

    let recipe = match lookup {
        RecipeLookupResult::Hit { recipe, .. } => recipe,
        RecipeLookupResult::Quarantined { recipe_key, reason } => {
            return json!({
                "ok": false,
                "status": "quarantined",
                "recipeKey": recipe_key,
                "reason": reason
            });
        }
        RecipeLookupResult::StructureMismatch {
            recipe_key,
            similarity,
            threshold,
        } => {
            return json!({
                "ok": false,
                "status": "structure_mismatch",
                "recipeKey": recipe_key,
                "similarity": similarity,
                "threshold": threshold
            });
        }
        RecipeLookupResult::Miss => {
            return json!({
                "ok": false,
                "status": "miss",
                "origin": origin,
                "route": route,
                "intent": intent
            });
        }
    };

    let resolved_steps = match engine
        .browser_recipes()
        .substitute_params(&recipe.steps, params)
    {
        Ok(steps) => steps,
        Err(err) => {
            return json!({
                "ok": false,
                "status": "param_error",
                "recipeKey": recipe.recipe_key,
                "error": format!("Recipe parameter substitution failed: {err}")
            });
        }
    };
    let step_count = resolved_steps.len();

    for (idx, step) in resolved_steps.iter().enumerate() {
        browser::set_browser_surface_agent_state(
            surface_id,
            true,
            Some(&format!("Replay {}/{}: {}", idx + 1, step_count, step.action)),
        );
        let mut candidates: Vec<&LocatorSpec> = Vec::with_capacity(1 + step.fallback_locators.len());
        candidates.push(&step.primary_locator);
        for fb in &step.fallback_locators {
            candidates.push(fb);
        }

        let mut last_err = String::new();
        let mut step_ok = false;
        for loc in candidates {
            let mut payload = json!({
                "op": step.action,
                "locator": loc,
            });
            if let Some(ref val) = step.value_or_param {
                payload["value"] = json!(val);
            }
            if let Some(ref css) = loc.css_fallback {
                payload["selector"] = json!(css);
            }
            match execute_single_step(webview, surface_id, &payload).await {
                Ok(_) => {
                    step_ok = true;
                    break;
                }
                Err(err) => last_err = err,
            }
        }

        if !step_ok {
            browser::set_browser_surface_agent_state(surface_id, false, None);
            let quarantined = engine
                .browser_recipes()
                .record_failure(&recipe.recipe_key)
                .unwrap_or(false);
            let delta = capture_ax_snapshot(
                webview,
                surface_id,
                session_id,
                BrowserReadMode::Diff,
                false,
                agent,
                provider,
                model,
            )
            .await
            .ok();
            return json!({
                "ok": false,
                "status": "needs_self_heal",
                "recipeKey": recipe.recipe_key,
                "failedStepIndex": idx,
                "failedStep": step,
                "error": last_err,
                "quarantined": quarantined,
                "snapshot": delta
            });
        }
    }

    browser::set_browser_surface_agent_state(surface_id, false, None);
    let _ = engine.browser_recipes().record_success(&recipe.recipe_key);
    let estimated_saved = (step_count as usize).saturating_mul(2200).max(1500);
    let _ = engine.ledger().record(&LedgerEventInput {
        session_id: session_id.to_string(),
        agent: agent.to_string(),
        provider: provider.to_string(),
        model: model.to_string(),
        category: "browser".to_string(),
        command_or_tool: "browser:recipe_replay".to_string(),
        raw_tokens: estimated_saved,
        compressed_tokens: 0,
        cache_hit: true,
        overhead_ms: 1,
    });

    json!({
        "ok": true,
        "status": "replayed",
        "recipeKey": recipe.recipe_key,
        "intent": intent,
        "stepsExecuted": step_count,
        "tokensSaved": estimated_saved
    })
}

/// Saves a verified multi-step flow into `kite-ctx` `BrowserRecipeStore` for 0-token replay.
pub fn save_recipe_for_surface(
    surface_id: &str,
    intent: &str,
    route_pattern: Option<&str>,
    steps: Vec<BrowserActionStep>,
) -> Value {
    let Ok(engine) = ContextEngine::open_default() else {
        return json!({ "ok": false, "error": "kite-ctx store unavailable" });
    };
    let (url, structure_hash, landmark_keys) = {
        let map = ax_index_map().lock().unwrap();
        if let Some(idx) = map.get(surface_id) {
            (
                idx.url.clone(),
                idx.structure_hash.clone(),
                idx.landmark_keys.clone(),
            )
        } else {
            (
                browser::surface_url_of(surface_id).unwrap_or_default(),
                String::new(),
                Vec::new(),
            )
        }
    };
    let origin = extract_origin(&url);
    let canonical_route = canonicalize_route(&url);
    let pattern = route_pattern
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&canonical_route)
        .to_string();

    let recipe = BrowserRecipe {
        recipe_key: BrowserRecipeStore::make_recipe_key(&origin, &pattern, intent),
        origin,
        route_pattern: pattern,
        structure_hash,
        landmark_keys,
        intent: intent.to_string(),
        steps,
        success_count: 1,
        failure_count: 0,
        consecutive_failures: 0,
        quarantined: false,
        last_verified_at: 0,
        expires_at: 0,
        created_at: 0,
    };

    match engine.browser_recipes().upsert_recipe(recipe) {
        Ok(saved) => json!({
            "ok": true,
            "recipeKey": saved.recipe_key,
            "origin": saved.origin,
            "routePattern": saved.route_pattern,
            "intent": saved.intent,
            "steps": saved.steps.len()
        }),
        Err(err) => json!({ "ok": false, "error": format!("Failed to save recipe: {err}") }),
    }
}

/// Unified high-level dispatcher shared by `kite_browser` MCP, `kite browser` CLI,
/// `dispatch_wire` GUI handler, and Tauri IPC commands.
pub async fn execute_browser_action(app: Option<&tauri::AppHandle>, request: &Value) -> Value {
    let action = request
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let session_id = request
        .get("sessionId")
        .or_else(|| request.get("session_id"))
        .and_then(Value::as_str)
        .unwrap_or("default");
    let thread_id = request
        .get("threadId")
        .or_else(|| request.get("thread_id"))
        .and_then(Value::as_str)
        .map(|s| s.strip_prefix("thread:").unwrap_or(s));
    let agent = request
        .get("agent")
        .and_then(Value::as_str)
        .unwrap_or("browser-agent");
    let provider = request
        .get("provider")
        .and_then(Value::as_str)
        .unwrap_or("local");
    let model = request
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or("webview2-cdp");

    match action.as_str() {
        "discover" => {
            let extra_ports: Vec<u16> = request
                .get("ports")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_u64().map(|p| p as u16))
                        .collect()
                })
                .unwrap_or_default();
            let snippets: Vec<String> = request
                .get("terminalSnippets")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            let open_urls = browser::all_open_surface_urls();
            let servers: Vec<DiscoveredServer> =
                browser_discovery::discover_local_servers(&extra_ports, &snippets, &open_urls);
            let tabs = browser::list_surface_views(
                request
                    .get("workspaceId")
                    .or_else(|| request.get("workspace_id"))
                    .and_then(Value::as_str),
            );
            json!({
                "ok": true,
                "action": "discover",
                "servers": servers,
                "openTabs": tabs
            })
        }
        "tabs" => {
            let ws = request
                .get("workspaceId")
                .or_else(|| request.get("workspace_id"))
                .and_then(Value::as_str);
            json!({
                "ok": true,
                "action": "tabs",
                "tabs": browser::list_surface_views(ws)
            })
        }
        "takeover" => {
            let Some(sid) = resolve_surface_id(request) else {
                return json!({ "ok": false, "error": "surfaceId / tab_id is required" });
            };
            match browser::request_agent_takeover(&sid, app) {
                Ok(view) => json!({ "ok": true, "action": "takeover", "surface": view }),
                Err(err) => json!({ "ok": false, "error": err }),
            }
        }
        "resume" => {
            let Some(sid) = resolve_surface_id(request) else {
                return json!({ "ok": false, "error": "surfaceId / tab_id is required" });
            };
            match browser::resume_agent_control(&sid, thread_id, app) {
                Ok(view) => json!({ "ok": true, "action": "resume", "surface": view }),
                Err(err) => json!({ "ok": false, "error": err }),
            }
        }
        "open" => {
            let Some(url) = request.get("url").and_then(Value::as_str) else {
                return json!({ "ok": false, "error": "`open` requires `url`" });
            };
            let policy = load_policy_from_disk().unwrap_or_default();
            let open_urls = browser::all_open_surface_urls();
            let discovered_ports: Vec<u16> =
                browser_discovery::discover_local_servers(&[], &[], &open_urls)
                    .into_iter()
                    .map(|s| s.port)
                    .collect();
            match evaluate_navigation_url(url, &policy, &discovered_ports) {
                PolicyDecision::Allow => {}
                PolicyDecision::Deny { reason } => {
                    return json!({ "ok": false, "blocked": true, "decision": "deny", "reason": reason });
                }
                PolicyDecision::Ask { reason, rule_hint } => {
                    return json!({
                        "ok": false,
                        "requiresApproval": true,
                        "decision": "ask",
                        "reason": reason,
                        "ruleHint": rule_hint
                    });
                }
                PolicyDecision::PauseForUser { kind, reason } => {
                    return json!({
                        "ok": false,
                        "pausedForUser": true,
                        "sensitiveKind": kind,
                        "reason": reason
                    });
                }
            }

            let Some(app_handle) = app else {
                return json!({
                    "ok": false,
                    "error": "gui_unavailable: Kite Code desktop window must be running to open embedded browser tabs."
                });
            };
            let ws_id = request
                .get("workspaceId")
                .or_else(|| request.get("workspace_id"))
                .and_then(Value::as_str);
            let isolated = request
                .get("isolated")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let background = request
                .get("background")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let requested_sid = request
                .get("surfaceId")
                .or_else(|| request.get("tab_id"))
                .and_then(Value::as_str);

            match browser::open_or_navigate_agent_surface(
                app_handle,
                requested_sid,
                url,
                ws_id,
                thread_id,
                !background,
                isolated,
            )
            .await
            {
                Ok((placement, webview)) => {
                    let _ = ensure_telemetry_attached(&placement.surface_id, &webview).await;
                    if background {
                        let w = request
                            .get("width")
                            .and_then(Value::as_u64)
                            .unwrap_or(DEFAULT_EMULATED_WIDTH as u64)
                            as u32;
                        let h = request
                            .get("height")
                            .and_then(Value::as_u64)
                            .unwrap_or(DEFAULT_EMULATED_HEIGHT as u64)
                            as u32;
                        let _ = set_viewport_emulation(&webview, w, h, w <= 500).await;
                    }
                    json!({
                        "ok": true,
                        "action": "open",
                        "surfaceId": placement.surface_id,
                        "surface": placement.view
                    })
                }
                Err(err) => json!({ "ok": false, "error": err }),
            }
        }
        "close" => {
            let Some(sid) = resolve_surface_id(request) else {
                return json!({ "ok": false, "error": "surfaceId / tab_id is required" });
            };
            clear_surface_cdp_state(&sid);
            if let Ok(engine) = ContextEngine::open_default() {
                let _ = engine.browser_cache().invalidate_tab(session_id, &sid);
            }
            if let Some(app_handle) = app {
                let _ = browser::close_surface_by_id(app_handle, &sid);
            }
            json!({ "ok": true, "action": "close", "surfaceId": sid, "closed": true })
        }
        "console" | "network" | "errors" => {
            let Some(sid) = resolve_surface_id(request) else {
                return json!({ "ok": false, "error": "surfaceId / tab_id is required" });
            };
            let raw_payload = {
                let map = telemetry_map().lock().unwrap();
                let Some(st) = map.get(&sid) else {
                    return json!({
                        "ok": true,
                        "action": action,
                        "surfaceId": sid,
                        "console": [],
                        "network": []
                    });
                };
                match action.as_str() {
                    "console" => json!(st.console.iter().collect::<Vec<_>>()),
                    "network" => json!(st.network.iter().collect::<Vec<_>>()),
                    _ => {
                        let (c_err, n_err) = st.errors_only();
                        json!({ "consoleErrors": c_err, "networkErrors": n_err })
                    }
                }
            };
            let raw_json = serde_json::to_string(&raw_payload).unwrap_or_default();
            if action == "network" && raw_json.len() >= 1024 {
                if let Ok(engine) = ContextEngine::open_default() {
                    let crusher = SmartCrusher::default();
                    if let Ok(crushed) = crusher.crush(&raw_json, Some(&engine.ccr())) {
                        let _ = engine.ledger().record(&LedgerEventInput {
                            session_id: session_id.to_string(),
                            agent: agent.to_string(),
                            provider: provider.to_string(),
                            model: model.to_string(),
                            category: "browser".to_string(),
                            command_or_tool: "browser:network_crush".to_string(),
                            raw_tokens: crushed.raw_tokens,
                            compressed_tokens: crushed.compressed_tokens,
                            cache_hit: false,
                            overhead_ms: 1,
                        });
                        return json!({
                            "ok": true,
                            "action": "network",
                            "surfaceId": sid,
                            "compressed": true,
                            "stage": crushed.stage,
                            "ccrHash": crushed.ccr_hash,
                            "output": crushed.output
                        });
                    }
                }
            }
            json!({
                "ok": true,
                "action": action,
                "surfaceId": sid,
                "data": raw_payload
            })
        }
        "snapshot" | "act" | "batch" | "replay" | "save_recipe" | "screenshot" | "eval" => {
            let Some(sid) = resolve_surface_id(request) else {
                return json!({ "ok": false, "error": "surfaceId / tab_id is required (call `open` or `tabs` first)" });
            };
            if action == "save_recipe" {
                let intent = request
                    .get("intent")
                    .and_then(Value::as_str)
                    .unwrap_or("unnamed_flow");
                let route_pattern = request
                    .get("routePattern")
                    .or_else(|| request.get("route_pattern"))
                    .and_then(Value::as_str);
                let steps: Vec<BrowserActionStep> = request
                    .get("steps")
                    .and_then(|v| serde_json::from_value(v.clone()).ok())
                    .unwrap_or_default();
                return save_recipe_for_surface(&sid, intent, route_pattern, steps);
            }

            let Some(app_handle) = app else {
                return json!({ "ok": false, "error": "gui_unavailable: Kite Code desktop app must be running" });
            };
            let Some(webview) = browser::webview_for_surface(app_handle, &sid) else {
                return json!({ "ok": false, "error": format!("browser_not_found: no live webview for `{sid}`") });
            };

            match action.as_str() {
                "snapshot" => {
                    let mode_raw = request
                        .get("mode")
                        .and_then(Value::as_str)
                        .unwrap_or("auto");
                    let fresh = request.get("fresh").and_then(Value::as_bool).unwrap_or(false);
                    match capture_ax_snapshot(
                        &webview,
                        &sid,
                        session_id,
                        BrowserReadMode::from_str_lossy(mode_raw),
                        fresh,
                        agent,
                        provider,
                        model,
                    )
                    .await
                    {
                        Ok(val) => {
                            // Mirror compressed page state in SharedContextStore for parent/subagent handoff.
                            if let (Ok(engine), Some(snap_txt)) = (
                                ContextEngine::open_default(),
                                val.get("snapshot").and_then(Value::as_str),
                            ) {
                                let key = format!("browser:tab:{sid}:state");
                                let _ = engine.share_put_with_telemetry(
                                    ContextScope::Session,
                                    session_id,
                                    &key,
                                    snap_txt,
                                    agent,
                                    provider,
                                    None,
                                    session_id,
                                    model,
                                );
                            }
                            val
                        }
                        Err(err) => json!({ "ok": false, "error": err }),
                    }
                }
                "act" => {
                    let step = request.get("step").unwrap_or(request);
                    match execute_single_step(&webview, &sid, step).await {
                        Ok(res) => json!({ "ok": true, "action": "act", "surfaceId": sid, "result": res }),
                        Err(err) => json!({ "ok": false, "action": "act", "surfaceId": sid, "error": err }),
                    }
                }
                "batch" => {
                    let steps = request
                        .get("steps")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    let include_snap = request
                        .get("includeSnapshot")
                        .or_else(|| request.get("include_snapshot"))
                        .and_then(Value::as_bool)
                        .unwrap_or(true);
                    execute_batch(
                        &webview,
                        &sid,
                        session_id,
                        &steps,
                        include_snap,
                        agent,
                        provider,
                        model,
                    )
                    .await
                }
                "replay" => {
                    let intent = request
                        .get("intent")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    let params: HashMap<String, String> = request
                        .get("params")
                        .and_then(Value::as_object)
                        .map(|obj| {
                            obj.iter()
                                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                                .collect()
                        })
                        .unwrap_or_default();
                    replay_recipe_on_surface(
                        &webview, &sid, session_id, intent, &params, agent, provider, model,
                    )
                    .await
                }
                "screenshot" => {
                    let fmt = request
                        .get("format")
                        .and_then(Value::as_str)
                        .unwrap_or("jpeg");
                    let quality = request.get("quality").and_then(Value::as_u64).unwrap_or(78) as u8;
                    let full_page = request
                        .get("fullPage")
                        .or_else(|| request.get("full_page"))
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    let dedup = request.get("dedup").and_then(Value::as_bool).unwrap_or(true);
                    match capture_screenshot(&webview, &sid, session_id, fmt, quality, full_page, dedup)
                        .await
                    {
                        Ok(val) => val,
                        Err(err) => json!({ "ok": false, "error": err }),
                    }
                }
                "eval" => {
                    let Some(script) = request
                        .get("script")
                        .or_else(|| request.get("expression"))
                        .and_then(Value::as_str)
                    else {
                        return json!({ "ok": false, "error": "`eval` requires `script`" });
                    };
                    let url = browser::surface_url_of(&sid).unwrap_or_default();
                    let policy = load_policy_from_disk().unwrap_or_default();
                    match evaluate_js_eval(&url, &policy) {
                        PolicyDecision::Allow => {}
                        PolicyDecision::Deny { reason } => {
                            return json!({ "ok": false, "blocked": true, "decision": "deny", "reason": reason });
                        }
                        PolicyDecision::Ask { reason, rule_hint } => {
                            return json!({
                                "ok": false,
                                "requiresApproval": true,
                                "decision": "ask",
                                "reason": reason,
                                "ruleHint": rule_hint
                            });
                        }
                        PolicyDecision::PauseForUser { kind, reason } => {
                            return json!({
                                "ok": false,
                                "pausedForUser": true,
                                "sensitiveKind": kind,
                                "reason": reason
                            });
                        }
                    }
                    match call_cdp(
                        &webview,
                        "Runtime.evaluate",
                        json!({ "expression": script, "returnByValue": true, "awaitPromise": true }),
                        DEFAULT_CDP_TIMEOUT_MS,
                    )
                    .await
                    {
                        Ok(res) => {
                            let val = res
                                .get("result")
                                .and_then(|r| r.get("value"))
                                .cloned()
                                .unwrap_or(Value::Null);
                            json!({ "ok": true, "action": "eval", "surfaceId": sid, "value": val })
                        }
                        Err(err) => json!({ "ok": false, "error": err }),
                    }
                }
                _ => json!({ "ok": false, "error": format!("Unsupported action `{action}`") }),
            }
        }
        other => json!({
            "ok": false,
            "error": format!("Unknown kite_browser action `{other}`. Valid actions: discover, tabs, open, close, snapshot, act, batch, replay, save_recipe, console, network, errors, screenshot, eval, takeover, resume.")
        }),
    }
}

fn resolve_surface_id(request: &Value) -> Option<String> {
    request
        .get("surfaceId")
        .or_else(|| request.get("tab_id"))
        .or_else(|| request.get("tabId"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(browser::most_recent_surface_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_cdp_ax_tree_assigns_refs_and_redacts_passwords() {
        let sample = json!({
            "nodes": [
                {
                    "nodeId": "1",
                    "ignored": false,
                    "role": { "value": "RootWebArea" },
                    "name": { "value": "Checkout" },
                    "childIds": ["2", "3"]
                },
                {
                    "nodeId": "2",
                    "ignored": false,
                    "role": { "value": "main" },
                    "name": { "value": "" },
                    "childIds": ["4", "5", "6"]
                },
                {
                    "nodeId": "3",
                    "ignored": true,
                    "role": { "value": "generic" },
                    "childIds": []
                },
                {
                    "nodeId": "4",
                    "ignored": false,
                    "backendDOMNodeId": 101,
                    "role": { "value": "textbox" },
                    "name": { "value": "Password" },
                    "value": { "value": "super-secret-123" },
                    "properties": [{ "name": "inputType", "value": { "value": "password" } }],
                    "childIds": []
                },
                {
                    "nodeId": "5",
                    "ignored": false,
                    "backendDOMNodeId": 102,
                    "role": { "value": "button" },
                    "name": { "value": "Submit Order" },
                    "childIds": []
                },
                {
                    "nodeId": "6",
                    "ignored": false,
                    "role": { "value": "heading" },
                    "name": { "value": "Order Summary" },
                    "childIds": []
                }
            ]
        });

        let (nodes, index, text) =
            parse_cdp_ax_tree(&sample, "http://localhost:5173/checkout", "Checkout", false);
        assert!(nodes.len() >= 4);
        assert!(!text.contains("super-secret-123"));
        assert!(text.contains("[REDACTED]"));
        assert!(text.contains("button \"Submit Order\" [ref=e"));
        assert!(index.landmark_keys.contains(&"main".to_string()));

        let by_loc = resolve_locator_in_index(
            &index,
            None,
            Some(&LocatorSpec {
                role: "button".to_string(),
                name: "Submit Order".to_string(),
                landmark: Some("main".to_string()),
                stable_key: None,
                css_fallback: None,
            }),
        );
        assert!(by_loc.is_some());
        assert_eq!(by_loc.unwrap().backend_dom_node_id, Some(102));

        let by_ref = resolve_locator_in_index(&index, Some(&format!("@{}", by_loc.unwrap().ref_id)), None);
        assert_eq!(by_ref.unwrap().backend_dom_node_id, Some(102));
    }

    #[test]
    fn telemetry_ring_buffers_bound_entries_and_scrub_secrets() {
        let sid = "test-cdp-telemetry-1";
        clear_surface_cdp_state(sid);

        ingest_cdp_event(
            sid,
            "Runtime.consoleAPICalled",
            &json!({
                "type": "error",
                "args": [{ "value": "Auth failed with Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaa.bbb" }]
            }),
        );
        ingest_cdp_event(
            sid,
            "Network.requestWillBeSent",
            &json!({
                "requestId": "req-1",
                "type": "XHR",
                "request": {
                    "url": "http://localhost:5173/api/orders",
                    "method": "POST",
                    "headers": {
                        "Authorization": "Bearer secret-token-value",
                        "Content-Type": "application/json"
                    }
                }
            }),
        );
        ingest_cdp_event(
            sid,
            "Network.responseReceived",
            &json!({
                "requestId": "req-1",
                "response": {
                    "status": 500,
                    "statusText": "Internal Server Error",
                    "mimeType": "application/json",
                    "headers": { "Set-Cookie": "sid=xyz" }
                }
            }),
        );

        let (c_err, n_err) = telemetry_map()
            .lock()
            .unwrap()
            .get(sid)
            .unwrap()
            .errors_only();
        assert_eq!(c_err.len(), 1);
        assert!(!c_err[0].text.contains("eyJhbGci"));
        assert!(c_err[0].text.contains("[REDACTED]"));
        assert_eq!(n_err.len(), 1);
        assert_eq!(n_err[0].status, Some(500));
        assert_eq!(
            n_err[0].request_headers.get("Authorization").and_then(Value::as_str),
            Some("[REDACTED]")
        );
        assert_eq!(
            n_err[0].response_headers.get("Set-Cookie").and_then(Value::as_str),
            Some("[REDACTED]")
        );

        clear_surface_cdp_state(sid);
    }
}
