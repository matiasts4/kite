//! Sandboxed MCP App (`ui://` SEP-1865) discovery, resource loading, CSP sanitization,
//! and app-tool dispatch.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::future::Future;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::dispatch::mcp_hub::{global_stdio_mcp_hub, SharedStdioMcpHub};
use crate::logger::log_trace;
use crate::native_agent::mcp_client::{
    call_pooled_stdio_tool_raw_on_hub, list_pooled_stdio_tools_raw_on_hub,
    read_pooled_stdio_resource_on_hub, NativeMcpClient,
};
use crate::plugin_runtime::types::{DiscoveredPlugin, PluginMcpServer, PluginMcpTransport};

/// Maximum permitted decoded HTML payload size for a `ui://` MCP App resource (`10 MiB`).
pub const MAX_MCP_APP_HTML_BYTES: usize = 10 * 1024 * 1024;
/// Maximum concurrent in-flight `tools/call` dispatches allowed per MCP App `instance_id`.
pub const MAX_CONCURRENT_APP_TOOL_CALLS: usize = 4;
const HTTP_APP_DISCOVERY_TIMEOUT: Duration = Duration::from_secs(6);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum McpAppSurfaceKind {
    AuxPane,
    Global,
    Title,
    Inline,
}

impl McpAppSurfaceKind {
    fn as_slug(self) -> &'static str {
        match self {
            Self::AuxPane => "aux_pane",
            Self::Global => "global",
            Self::Title => "title",
            Self::Inline => "inline",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpAppEntrypointDto {
    pub id: String,
    pub plugin_id: String,
    pub plugin_name: String,
    pub server_name: String,
    pub tool_name: String,
    pub title: String,
    pub description: Option<String>,
    pub resource_uri: String,
    pub surface: McpAppSurfaceKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpAppCspDto {
    pub connect_domains: Vec<String>,
    pub resource_domains: Vec<String>,
    pub frame_domains: Vec<String>,
    pub base_uri_domains: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpAppResourcePayload {
    pub uri: String,
    pub mime_type: String,
    pub html: String,
    pub csp: McpAppCspDto,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prefers_border: Option<bool>,
    pub server_name: String,
}

/// Thread-safe per-instance concurrency tracker enforcing [`MAX_CONCURRENT_APP_TOOL_CALLS`].
#[derive(Default)]
pub struct InstanceCallLimiter {
    in_flight: Mutex<HashMap<String, usize>>,
}

/// RAII concurrency permit released automatically when an app tool call finishes or cancels.
pub struct InstanceCallPermit {
    instance_id: String,
    limiter: Arc<InstanceCallLimiter>,
}

impl Drop for InstanceCallPermit {
    fn drop(&mut self) {
        self.limiter.release(&self.instance_id);
    }
}

impl InstanceCallLimiter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn acquire(self: &Arc<Self>, instance_id: &str) -> Result<InstanceCallPermit, String> {
        let clean = instance_id.trim();
        if clean.is_empty() {
            return Err("MCP App instanceId cannot be empty.".to_string());
        }
        let mut guard = self.in_flight.lock().unwrap_or_else(|p| p.into_inner());
        let active = guard.get(clean).copied().unwrap_or(0);
        if active >= MAX_CONCURRENT_APP_TOOL_CALLS {
            return Err(format!(
                "MCP App instance '{clean}' reached the limit of {MAX_CONCURRENT_APP_TOOL_CALLS} concurrent tool calls."
            ));
        }
        guard.insert(clean.to_string(), active + 1);
        Ok(InstanceCallPermit {
            instance_id: clean.to_string(),
            limiter: Arc::clone(self),
        })
    }

    fn release(&self, instance_id: &str) {
        let mut guard = self.in_flight.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(count) = guard.get_mut(instance_id) {
            if *count <= 1 {
                guard.remove(instance_id);
            } else {
                *count -= 1;
            }
        }
    }

    #[cfg(test)]
    fn active_count(&self, instance_id: &str) -> usize {
        self.in_flight
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(instance_id.trim())
            .copied()
            .unwrap_or(0)
    }
}

fn global_instance_limiter() -> &'static Arc<InstanceCallLimiter> {
    static LIMITER: OnceLock<Arc<InstanceCallLimiter>> = OnceLock::new();
    LIMITER.get_or_init(|| Arc::new(InstanceCallLimiter::new()))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ParsedToolAppMeta {
    pub resource_uri: String,
    pub model_visible: bool,
    pub app_visible: bool,
    pub surfaces: Vec<McpAppSurfaceKind>,
    pub title: Option<String>,
}

fn non_empty_trimmed(val: Option<&Value>) -> Option<String> {
    val.and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Validates that a URI uses the `ui://` scheme with a non-empty resource path and no
/// whitespace or control characters.
pub fn validate_ui_resource_uri(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("MCP App resource URI cannot be empty.".to_string());
    }
    if trimmed.chars().any(|ch| ch.is_control() || ch.is_whitespace()) {
        return Err("MCP App resource URI contains invalid whitespace or control characters.".to_string());
    }
    if trimmed.len() < 6 || !trimmed[..5].eq_ignore_ascii_case("ui://") {
        return Err(format!("Unsupported MCP App resource URI '{trimmed}'; expected 'ui://' scheme."));
    }
    let after_scheme = &trimmed[5..];
    if after_scheme.trim_start_matches('/').is_empty() {
        return Err(format!("Invalid MCP App resource URI '{trimmed}': missing host/path."));
    }
    Ok(format!("ui://{after_scheme}"))
}

/// Validates that a resource MIME type is `text/html` with `profile=mcp-app`,
/// safely allowing standard media-type parameters such as `charset=utf-8`.
pub fn validate_mcp_app_mime_type(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("MCP App resource is missing a mimeType.".to_string());
    }
    let mut parts = trimmed.split(';');
    let media_type = parts.next().unwrap_or("").trim();
    if !media_type.eq_ignore_ascii_case("text/html") {
        return Err(format!(
            "Unsupported MCP App MIME type '{trimmed}'; expected 'text/html;profile=mcp-app'."
        ));
    }

    let mut has_mcp_app_profile = false;
    for param in parts {
        let param = param.trim();
        if param.is_empty() {
            continue;
        }
        let Some((k, v)) = param.split_once('=') else {
            return Err(format!(
                "Malformed MIME parameter '{param}' in MCP App mimeType '{trimmed}'."
            ));
        };
        let key = k.trim();
        let mut val = v.trim();
        if val.len() >= 2 && val.starts_with('"') && val.ends_with('"') {
            val = &val[1..val.len() - 1];
        }
        if key.is_empty() || val.is_empty() {
            return Err(format!(
                "Empty MIME parameter in MCP App mimeType '{trimmed}'."
            ));
        }
        if key.eq_ignore_ascii_case("profile") {
            if !val.eq_ignore_ascii_case("mcp-app") {
                return Err(format!(
                    "Unsupported MCP App profile '{val}' in mimeType '{trimmed}'; expected 'mcp-app'."
                ));
            }
            has_mcp_app_profile = true;
        }
    }

    if !has_mcp_app_profile {
        return Err(format!(
            "MCP App MIME type '{trimmed}' must declare 'profile=mcp-app'."
        ));
    }

    Ok(trimmed.to_string())
}

fn is_valid_host_label(label: &str) -> bool {
    !label.is_empty()
        && !label.starts_with('-')
        && !label.ends_with('-')
        && label
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
}

fn sanitize_bare_origin(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed.contains('*')
        || trimmed.contains(';')
        || trimmed.contains(',')
        || trimmed.contains('"')
        || trimmed.contains('\'')
        || trimmed.contains('<')
        || trimmed.contains('>')
        || trimmed.contains('\\')
        || trimmed.chars().any(|ch| ch.is_control() || ch.is_whitespace())
    {
        return None;
    }

    let (raw_scheme, rest) = trimmed.split_once("://")?;
    let scheme = raw_scheme.to_ascii_lowercase();
    if !matches!(scheme.as_str(), "http" | "https" | "ws" | "wss") {
        return None;
    }
    if rest.is_empty()
        || rest.contains('/')
        || rest.contains('?')
        || rest.contains('#')
        || rest.contains('@')
    {
        return None;
    }

    if rest.starts_with('[') {
        let close_idx = rest.find(']')?;
        let ipv6 = &rest[1..close_idx];
        if ipv6.is_empty()
            || !ipv6.contains(':')
            || !ipv6.chars().all(|ch| ch.is_ascii_hexdigit() || ch == ':')
        {
            return None;
        }
        let after = &rest[close_idx + 1..];
        if after.is_empty() {
            return Some(format!("{scheme}://[{}]", ipv6.to_ascii_lowercase()));
        }
        let port_str = after.strip_prefix(':')?;
        if port_str.is_empty() || !port_str.chars().all(|ch| ch.is_ascii_digit()) {
            return None;
        }
        let port = port_str.parse::<u16>().ok().filter(|&p| p > 0)?;
        return Some(format!("{scheme}://[{}]:{port}", ipv6.to_ascii_lowercase()));
    }

    let (host, port_opt) = match rest.split_once(':') {
        Some((h, p)) => {
            if p.contains(':') || p.is_empty() || !p.chars().all(|ch| ch.is_ascii_digit()) {
                return None;
            }
            let port = p.parse::<u16>().ok().filter(|&n| n > 0)?;
            (h, Some(port))
        }
        None => (rest, None),
    };

    if host.is_empty() || host.starts_with('.') || host.ends_with('.') {
        return None;
    }
    if !host.split('.').all(is_valid_host_label) {
        return None;
    }

    let lower_host = host.to_ascii_lowercase();
    Some(match port_opt {
        Some(port) => format!("{scheme}://{lower_host}:{port}"),
        None => format!("{scheme}://{lower_host}"),
    })
}

fn sanitize_origin_list(val: Option<&Value>) -> Vec<String> {
    let Some(arr) = val.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for item in arr {
        if let Some(raw) = item.as_str() {
            if let Some(origin) = sanitize_bare_origin(raw) {
                if seen.insert(origin.clone()) {
                    out.push(origin);
                }
            }
        }
    }
    out
}

/// Sanitizes an optional `_meta.ui.csp` JSON value into bare `http(s)://` / `ws(s)://` origin allowlists.
pub fn sanitize_csp_allowlist(csp_val: Option<&Value>) -> McpAppCspDto {
    let Some(obj) = csp_val.and_then(Value::as_object) else {
        return McpAppCspDto::default();
    };
    McpAppCspDto {
        connect_domains: sanitize_origin_list(
            obj.get("connectDomains").or_else(|| obj.get("connect_domains")),
        ),
        resource_domains: sanitize_origin_list(
            obj.get("resourceDomains").or_else(|| obj.get("resource_domains")),
        ),
        frame_domains: sanitize_origin_list(
            obj.get("frameDomains").or_else(|| obj.get("frame_domains")),
        ),
        base_uri_domains: sanitize_origin_list(
            obj.get("baseUriDomains").or_else(|| obj.get("base_uri_domains")),
        ),
    }
}

fn parse_surface_kind(raw: &str) -> Option<McpAppSurfaceKind> {
    let normalized = raw.trim().to_ascii_lowercase().replace('-', "_");
    match normalized.as_str() {
        "aux_pane" | "auxpane" | "sidecar_ui_entrypoint_aux_pane" => {
            Some(McpAppSurfaceKind::AuxPane)
        }
        "global" | "sidecar_ui_entrypoint_global" => Some(McpAppSurfaceKind::Global),
        "title" | "titlebar" | "sidecar_ui_entrypoint_title" => Some(McpAppSurfaceKind::Title),
        "inline" | "chat" => Some(McpAppSurfaceKind::Inline),
        _ => None,
    }
}

fn parse_visibility(meta: Option<&Value>) -> (bool, bool) {
    let Some(meta_obj) = meta.and_then(Value::as_object) else {
        return (true, true);
    };
    let vis_val = meta_obj
        .get("ui")
        .and_then(Value::as_object)
        .and_then(|ui| ui.get("visibility"))
        .or_else(|| meta_obj.get("ui/visibility"));

    let Some(vis) = vis_val.filter(|v| !v.is_null()) else {
        return (true, true);
    };

    let mut model = false;
    let mut app = false;
    match vis {
        Value::Array(items) => {
            for item in items {
                if let Some(s) = item.as_str() {
                    match s.trim().to_ascii_lowercase().as_str() {
                        "model" => model = true,
                        "app" => app = true,
                        _ => {}
                    }
                }
            }
        }
        Value::String(s) => match s.trim().to_ascii_lowercase().as_str() {
            "model" => model = true,
            "app" => app = true,
            _ => {}
        },
        _ => {}
    }
    (model, app)
}

/// Returns `true` when an MCP tool descriptor permits `"app"` invocation under SEP-1865 visibility rules.
pub fn tool_allows_app_call(tool: &Value) -> bool {
    let (_, app_visible) = parse_visibility(tool.get("_meta"));
    app_visible
}

pub(crate) fn extract_tool_app_meta(tool: &Value) -> Option<ParsedToolAppMeta> {
    let meta = tool.get("_meta")?;
    let meta_obj = meta.as_object()?;
    let ui_obj = meta_obj.get("ui").and_then(Value::as_object);

    let raw_uri = ui_obj
        .and_then(|ui| non_empty_trimmed(ui.get("resourceUri")).or_else(|| non_empty_trimmed(ui.get("resource_uri"))))
        .or_else(|| non_empty_trimmed(meta_obj.get("ui/resourceUri")))?;

    let resource_uri = validate_ui_resource_uri(&raw_uri).ok()?;
    let (model_visible, app_visible) = parse_visibility(Some(meta));

    let mut surfaces = Vec::new();
    let mut seen_surfaces = HashSet::new();

    if let Some(arr) = ui_obj
        .and_then(|ui| ui.get("entrypoints"))
        .and_then(Value::as_array)
    {
        for item in arr {
            if let Some(s) = item.as_str().and_then(parse_surface_kind) {
                if seen_surfaces.insert(s) {
                    surfaces.push(s);
                }
            }
        }
    }

    for key in ["entrypoint", "entryPoint", "surface"] {
        if let Some(s) = ui_obj
            .and_then(|ui| ui.get(key))
            .and_then(Value::as_str)
            .and_then(parse_surface_kind)
        {
            if seen_surfaces.insert(s) {
                surfaces.push(s);
            }
        }
    }
    for legacy_key in ["ui/entrypoint", "ui/surface"] {
        if let Some(s) = meta_obj
            .get(legacy_key)
            .and_then(Value::as_str)
            .and_then(parse_surface_kind)
        {
            if seen_surfaces.insert(s) {
                surfaces.push(s);
            }
        }
    }

    if surfaces.is_empty() {
        surfaces.push(McpAppSurfaceKind::AuxPane);
    }

    let title = ui_obj.and_then(|ui| non_empty_trimmed(ui.get("title")));

    Some(ParsedToolAppMeta {
        resource_uri,
        model_visible,
        app_visible,
        surfaces,
        title,
    })
}

fn mcp_server_hub_key(server: &PluginMcpServer, plugin: &DiscoveredPlugin) -> String {
    let raw_id = server.id.trim();
    if !raw_id.is_empty() {
        return raw_id.to_string();
    }
    let plugin_id = if server.plugin_id.trim().is_empty() {
        plugin.dir_id.trim()
    } else {
        server.plugin_id.trim()
    };
    let srv_name = server.server_name.trim();
    if plugin_id.is_empty() {
        srv_name.to_string()
    } else {
        format!("{plugin_id}_{srv_name}")
    }
}

fn resolve_plugin_mcp_server<'a>(
    plugins: &'a [DiscoveredPlugin],
    server_name: &str,
) -> Result<(&'a DiscoveredPlugin, &'a PluginMcpServer, String), String> {
    let clean = server_name.trim();
    if clean.is_empty() {
        return Err("MCP server name cannot be empty.".to_string());
    }

    let enabled_servers: Vec<(&DiscoveredPlugin, &PluginMcpServer, String)> = plugins
        .iter()
        .filter(|p| p.enabled)
        .flat_map(|p| {
            p.mcp_servers
                .iter()
                .map(move |srv| (p, srv, mcp_server_hub_key(srv, p)))
        })
        .collect();

    if let Some((p, srv, key)) = enabled_servers.iter().find(|(_, _, key)| key == clean) {
        return Ok((p, srv, key.clone()));
    }
    if let Some((p, srv, key)) = enabled_servers
        .iter()
        .find(|(_, _, key)| key.eq_ignore_ascii_case(clean))
    {
        return Ok((p, srv, key.clone()));
    }

    let exact_name_matches: Vec<_> = enabled_servers
        .iter()
        .filter(|(_, srv, _)| srv.server_name.trim() == clean)
        .collect();
    if exact_name_matches.len() == 1 {
        let (p, srv, key) = exact_name_matches[0];
        return Ok((p, srv, key.clone()));
    }
    if exact_name_matches.len() > 1 {
        return Err(format!(
            "MCP server name '{clean}' matches multiple enabled plugins; specify the qualified server ID."
        ));
    }

    let ci_name_matches: Vec<_> = enabled_servers
        .iter()
        .filter(|(_, srv, _)| srv.server_name.trim().eq_ignore_ascii_case(clean))
        .collect();
    if ci_name_matches.len() == 1 {
        let (p, srv, key) = ci_name_matches[0];
        return Ok((p, srv, key.clone()));
    }
    if ci_name_matches.len() > 1 {
        return Err(format!(
            "MCP server name '{clean}' matches multiple enabled plugins; specify the qualified server ID."
        ));
    }

    for p in plugins.iter().filter(|p| !p.enabled) {
        for srv in &p.mcp_servers {
            let key = mcp_server_hub_key(srv, p);
            if key.eq_ignore_ascii_case(clean)
                || srv.server_name.trim().eq_ignore_ascii_case(clean)
            {
                return Err(format!(
                    "MCP server '{clean}' belongs to disabled plugin '{}'.",
                    p.dir_id
                ));
            }
        }
    }

    Err(format!(
        "MCP server '{clean}' is not registered by any enabled plugin."
    ))
}

fn resolve_active_plugins(workspace_dir: Option<&Path>) -> Vec<DiscoveredPlugin> {
    let cached = crate::plugin_runtime::cached_discovered_plugins();
    if !cached.is_empty() {
        match workspace_dir {
            Some(ws) if crate::plugin_runtime::current_workspace_dir().as_deref() == Some(ws) => {
                return cached;
            }
            None => return cached,
            _ => {}
        }
    }
    crate::plugin_runtime::sync_runtime_with_workspace(workspace_dir)
}

fn ensure_stdio_registered_on_global_hub(server: &PluginMcpServer, hub_key: &str) {
    let hub = global_stdio_mcp_hub();
    if hub.has_registered_server(hub_key) {
        return;
    }
    if let PluginMcpTransport::Stdio { command, args, env } = &server.config {
        let clean_cmd = command.trim();
        if clean_cmd.is_empty() {
            return;
        }
        let env_vec: Vec<(String, String)> = env.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        hub.register_server(hub_key, clean_cmd, args, &env_vec);
    }
}

fn run_http_future_blocking<F, T>(fut: F) -> Result<T, String>
where
    F: Future<Output = T> + Send,
    T: Send,
{
    if tokio::runtime::Handle::try_current().is_ok() {
        std::thread::scope(|scope| {
            let handle = std::thread::Builder::new()
                .name("kite-mcp-apps-http".to_string())
                .spawn_scoped(scope, move || {
                    let rt = tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                        .map_err(|err| format!("Failed to build Tokio runtime: {err}"))?;
                    Ok::<T, String>(rt.block_on(fut))
                })
                .map_err(|err| format!("Failed to spawn HTTP worker thread: {err}"))?;
            handle
                .join()
                .map_err(|_| "HTTP worker thread panicked".to_string())?
        })
    } else {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|err| format!("Failed to build Tokio runtime: {err}"))?;
        Ok(rt.block_on(fut))
    }
}

fn list_server_tools_sync(
    server: &PluginMcpServer,
    hub_key: &str,
    stdio_hub: Option<&SharedStdioMcpHub>,
) -> Result<Vec<Value>, String> {
    match &server.config {
        PluginMcpTransport::Stdio { .. } => {
            let hub = match stdio_hub {
                Some(h) => h,
                None => {
                    ensure_stdio_registered_on_global_hub(server, hub_key);
                    global_stdio_mcp_hub()
                }
            };
            list_pooled_stdio_tools_raw_on_hub(hub, hub_key)
        }
        PluginMcpTransport::Http { url, headers } => {
            let url = url.clone();
            let headers = headers.clone();
            run_http_future_blocking(async move {
                let client = NativeMcpClient::connect_http_with_headers(url, &headers);
                let _ = tokio::time::timeout(HTTP_APP_DISCOVERY_TIMEOUT, client.initialize()).await;
                tokio::time::timeout(HTTP_APP_DISCOVERY_TIMEOUT, client.list_tools_raw())
                    .await
                    .map_err(|_| "Timed out listing tools from HTTP MCP server".to_string())?
            })?
        }
    }
}

async fn list_server_tools_async(
    server: &PluginMcpServer,
    hub_key: &str,
    stdio_hub: Option<Arc<SharedStdioMcpHub>>,
) -> Result<Vec<Value>, String> {
    match &server.config {
        PluginMcpTransport::Stdio { .. } => {
            let key = hub_key.to_string();
            if stdio_hub.is_none() {
                ensure_stdio_registered_on_global_hub(server, hub_key);
            }
            tokio::task::spawn_blocking(move || match stdio_hub {
                Some(hub) => list_pooled_stdio_tools_raw_on_hub(&hub, &key),
                None => list_pooled_stdio_tools_raw_on_hub(global_stdio_mcp_hub(), &key),
            })
            .await
            .map_err(|e| format!("MCP tools/list task failed: {e}"))?
        }
        PluginMcpTransport::Http { url, headers } => {
            let client = NativeMcpClient::connect_http_with_headers(url, headers);
            let _ = client.initialize().await;
            client.list_tools_raw().await
        }
    }
}

async fn read_server_resource_async(
    server: &PluginMcpServer,
    hub_key: &str,
    uri: &str,
    stdio_hub: Option<Arc<SharedStdioMcpHub>>,
) -> Result<Value, String> {
    match &server.config {
        PluginMcpTransport::Stdio { .. } => {
            let key = hub_key.to_string();
            let uri_owned = uri.to_string();
            if stdio_hub.is_none() {
                ensure_stdio_registered_on_global_hub(server, hub_key);
            }
            tokio::task::spawn_blocking(move || match stdio_hub {
                Some(hub) => read_pooled_stdio_resource_on_hub(&hub, &key, &uri_owned),
                None => read_pooled_stdio_resource_on_hub(global_stdio_mcp_hub(), &key, &uri_owned),
            })
            .await
            .map_err(|e| format!("MCP resources/read task failed: {e}"))?
        }
        PluginMcpTransport::Http { url, headers } => {
            let client = NativeMcpClient::connect_http_with_headers(url, headers);
            let _ = client.initialize().await;
            client.read_resource(uri).await
        }
    }
}

async fn call_server_tool_async(
    server: &PluginMcpServer,
    hub_key: &str,
    tool_name: &str,
    arguments: Value,
    stdio_hub: Option<Arc<SharedStdioMcpHub>>,
) -> Result<Value, String> {
    match &server.config {
        PluginMcpTransport::Stdio { .. } => {
            let key = hub_key.to_string();
            let tool = tool_name.to_string();
            if stdio_hub.is_none() {
                ensure_stdio_registered_on_global_hub(server, hub_key);
            }
            tokio::task::spawn_blocking(move || match stdio_hub {
                Some(hub) => call_pooled_stdio_tool_raw_on_hub(&hub, &key, &tool, arguments),
                None => {
                    call_pooled_stdio_tool_raw_on_hub(global_stdio_mcp_hub(), &key, &tool, arguments)
                }
            })
            .await
            .map_err(|e| format!("MCP tools/call task failed: {e}"))?
        }
        PluginMcpTransport::Http { url, headers } => {
            let client = NativeMcpClient::connect_http_with_headers(url, headers);
            let _ = client.initialize().await;
            client.call_tool_raw(tool_name, arguments).await
        }
    }
}

fn humanize_tool_title(tool: &Value, parsed_meta: &ParsedToolAppMeta, tool_name: &str) -> String {
    if let Some(t) = parsed_meta.title.as_deref() {
        return t.to_string();
    }
    if let Some(t) = non_empty_trimmed(tool.pointer("/annotations/title"))
        .or_else(|| non_empty_trimmed(tool.get("title")))
    {
        return t;
    }
    let clean = tool_name.replace('_', " ");
    let mut chars = clean.chars();
    match chars.next() {
        Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
        None => tool_name.to_string(),
    }
}

pub(crate) fn list_mcp_app_entrypoints_with_plugins(
    plugins: &[DiscoveredPlugin],
    stdio_hub: Option<&SharedStdioMcpHub>,
) -> Vec<McpAppEntrypointDto> {
    let mut out = Vec::new();
    let mut seen_ids = BTreeSet::new();

    for plugin in plugins {
        if !plugin.enabled {
            continue;
        }
        let plugin_name = if !plugin.display_name.trim().is_empty() {
            plugin.display_name.trim().to_string()
        } else if !plugin.name.trim().is_empty() {
            plugin.name.trim().to_string()
        } else {
            plugin.dir_id.trim().to_string()
        };

        for server in &plugin.mcp_servers {
            let hub_key = mcp_server_hub_key(server, plugin);
            let tools = match list_server_tools_sync(server, &hub_key, stdio_hub) {
                Ok(list) => list,
                Err(err) => {
                    log_trace(&format!(
                        "[McpApps] Skipping tool discovery for '{hub_key}': {err}"
                    ));
                    continue;
                }
            };

            for tool in tools {
                let Some(tool_name) = non_empty_trimmed(tool.get("name")) else {
                    continue;
                };
                let Some(meta) = extract_tool_app_meta(&tool) else {
                    continue;
                };
                let title = humanize_tool_title(&tool, &meta, &tool_name);
                let description = non_empty_trimmed(tool.get("description"));
                let multi_surface = meta.surfaces.len() > 1;

                for surface in &meta.surfaces {
                    let id = if multi_surface {
                        format!(
                            "{}:{}:{}:{}",
                            plugin.dir_id,
                            hub_key,
                            tool_name,
                            surface.as_slug()
                        )
                    } else {
                        format!("{}:{}:{}", plugin.dir_id, hub_key, tool_name)
                    };
                    if !seen_ids.insert(id.clone()) {
                        continue;
                    }
                    out.push(McpAppEntrypointDto {
                        id,
                        plugin_id: plugin.dir_id.clone(),
                        plugin_name: plugin_name.clone(),
                        server_name: hub_key.clone(),
                        tool_name: tool_name.clone(),
                        title: title.clone(),
                        description: description.clone(),
                        resource_uri: meta.resource_uri.clone(),
                        surface: *surface,
                    });
                }
            }
        }
    }

    out
}

/// Discovers SEP-1865 MCP App entrypoints (`_meta.ui.resourceUri` / `_meta["ui/resourceUri"]`)
/// exposed by enabled plugins' MCP servers.
pub fn list_mcp_app_entrypoints(workspace_dir: Option<&Path>) -> Vec<McpAppEntrypointDto> {
    let plugins = resolve_active_plugins(workspace_dir);
    list_mcp_app_entrypoints_with_plugins(&plugins, None)
}

fn extract_html_from_resource_item(item: &Value) -> Result<String, String> {
    if let Some(text) = item.get("text").and_then(Value::as_str) {
        if text.len() > MAX_MCP_APP_HTML_BYTES {
            return Err(format!(
                "MCP App HTML payload exceeds maximum size of {MAX_MCP_APP_HTML_BYTES} bytes ({} bytes).",
                text.len()
            ));
        }
        return Ok(text.to_string());
    }

    if let Some(blob) = item.get("blob").and_then(Value::as_str) {
        // Bound base64 input before decoding so maliciously large blobs cannot exhaust memory.
        let max_b64_len = (MAX_MCP_APP_HTML_BYTES / 3 + 1) * 4 + 4;
        if blob.len() > max_b64_len {
            return Err(format!(
                "MCP App HTML blob exceeds maximum size of {MAX_MCP_APP_HTML_BYTES} bytes."
            ));
        }
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(blob.trim())
            .map_err(|err| format!("Invalid base64 blob in MCP App resource: {err}"))?;
        if decoded.len() > MAX_MCP_APP_HTML_BYTES {
            return Err(format!(
                "MCP App HTML payload exceeds maximum size of {MAX_MCP_APP_HTML_BYTES} bytes ({} bytes).",
                decoded.len()
            ));
        }
        return String::from_utf8(decoded)
            .map_err(|err| format!("MCP App resource blob is not valid UTF-8 HTML: {err}"));
    }

    Err("MCP App resource item is missing 'text' or 'blob' content.".to_string())
}

fn parse_resource_payload(
    requested_uri: &str,
    canonical_server_name: &str,
    result: Value,
) -> Result<McpAppResourcePayload, String> {
    let contents = result
        .get("contents")
        .and_then(Value::as_array)
        .filter(|arr| !arr.is_empty())
        .ok_or_else(|| "MCP resources/read response missing non-empty 'contents' array.".to_string())?;

    let item = contents
        .iter()
        .find(|entry| {
            entry
                .get("uri")
                .and_then(Value::as_str)
                .is_some_and(|u| u.trim() == requested_uri)
        })
        .unwrap_or(&contents[0]);

    let resolved_uri = match item.get("uri").and_then(Value::as_str) {
        Some(raw) if !raw.trim().is_empty() => validate_ui_resource_uri(raw)?,
        _ => requested_uri.to_string(),
    };

    let raw_mime = item
        .get("mimeType")
        .or_else(|| item.get("mime_type"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let mime_type = validate_mcp_app_mime_type(raw_mime)?;
    let html = extract_html_from_resource_item(item)?;

    let csp_val = item
        .pointer("/_meta/ui/csp")
        .or_else(|| item.get("_meta").and_then(|m| m.get("ui/csp")))
        .or_else(|| result.pointer("/_meta/ui/csp"))
        .or_else(|| result.get("_meta").and_then(|m| m.get("ui/csp")));
    let csp = sanitize_csp_allowlist(csp_val);

    let prefers_border = item
        .pointer("/_meta/ui/prefersBorder")
        .or_else(|| item.pointer("/_meta/ui/prefers_border"))
        .or_else(|| result.pointer("/_meta/ui/prefersBorder"))
        .or_else(|| result.pointer("/_meta/ui/prefers_border"))
        .and_then(Value::as_bool);

    Ok(McpAppResourcePayload {
        uri: resolved_uri,
        mime_type,
        html,
        csp,
        prefers_border,
        server_name: canonical_server_name.to_string(),
    })
}

pub(crate) async fn read_mcp_app_resource_with_plugins(
    plugins: &[DiscoveredPlugin],
    server_name: &str,
    uri: &str,
    stdio_hub: Option<Arc<SharedStdioMcpHub>>,
) -> Result<McpAppResourcePayload, String> {
    let clean_uri = validate_ui_resource_uri(uri)?;
    let (_, server, hub_key) = resolve_plugin_mcp_server(plugins, server_name)?;
    let result = read_server_resource_async(server, &hub_key, &clean_uri, stdio_hub).await?;
    parse_resource_payload(&clean_uri, &hub_key, result)
}

/// Fetches and sanitizes a `ui://` MCP App HTML resource from an enabled plugin MCP server.
pub async fn read_mcp_app_resource(
    server_name: &str,
    uri: &str,
    workspace_dir: Option<&Path>,
) -> Result<McpAppResourcePayload, String> {
    let _ = validate_ui_resource_uri(uri)?;
    let ws_owned = workspace_dir.map(Path::to_path_buf);
    let plugins = tokio::task::spawn_blocking(move || resolve_active_plugins(ws_owned.as_deref()))
        .await
        .map_err(|e| format!("Failed resolving active plugins: {e}"))?;
    read_mcp_app_resource_with_plugins(&plugins, server_name, uri, None).await
}

pub(crate) async fn call_mcp_app_tool_with_deps(
    plugins: &[DiscoveredPlugin],
    limiter: &Arc<InstanceCallLimiter>,
    instance_id: &str,
    server_name: &str,
    tool_name: &str,
    arguments: Value,
    stdio_hub: Option<Arc<SharedStdioMcpHub>>,
) -> Result<Value, String> {
    let clean_tool = tool_name.trim();
    if clean_tool.is_empty() {
        return Err("MCP tool name cannot be empty.".to_string());
    }
    let _permit = limiter.acquire(instance_id)?;
    let (_, server, hub_key) = resolve_plugin_mcp_server(plugins, server_name)?;

    let tools = list_server_tools_async(server, &hub_key, stdio_hub.clone()).await?;
    let matched_tool = tools
        .iter()
        .find(|t| t.get("name").and_then(Value::as_str).map(str::trim) == Some(clean_tool))
        .ok_or_else(|| {
            format!("Tool '{clean_tool}' does not belong to MCP server '{hub_key}'.")
        })?;

    if !tool_allows_app_call(matched_tool) {
        return Err(format!(
            "Tool '{clean_tool}' on MCP server '{hub_key}' is restricted from MCP App invocation."
        ));
    }

    let normalized_args = if arguments.is_null() {
        json!({})
    } else {
        arguments
    };

    call_server_tool_async(server, &hub_key, clean_tool, normalized_args, stdio_hub).await
}

/// Invokes a tool on behalf of an active MCP App instance after verifying server ownership,
/// `"app"` visibility gating, and the per-instance concurrency limit (max 4 in-flight).
pub async fn call_mcp_app_tool(
    instance_id: &str,
    server_name: &str,
    tool_name: &str,
    arguments: Value,
    workspace_dir: Option<&Path>,
) -> Result<Value, String> {
    let ws_owned = workspace_dir.map(Path::to_path_buf);
    let plugins = tokio::task::spawn_blocking(move || resolve_active_plugins(ws_owned.as_deref()))
        .await
        .map_err(|e| format!("Failed resolving active plugins: {e}"))?;
    call_mcp_app_tool_with_deps(
        &plugins,
        global_instance_limiter(),
        instance_id,
        server_name,
        tool_name,
        arguments,
        None,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch::mcp_hub::{PooledServerSpec, UpstreamSpawner, UpstreamTransport};
    use crate::plugin_runtime::types::{PluginManifestFormat, PluginSourceKind};
    use std::collections::BTreeMap;
    use std::io::{BufRead, BufReader, Cursor, Read, Write};
    use std::path::PathBuf;
    use std::sync::{Arc, Barrier};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn make_test_plugin(
        dir_id: &str,
        enabled: bool,
        servers: Vec<PluginMcpServer>,
    ) -> DiscoveredPlugin {
        DiscoveredPlugin {
            dir_id: dir_id.to_string(),
            name: dir_id.to_string(),
            display_name: format!("{dir_id} Display"),
            description: "Test plugin".to_string(),
            version: Some("1.0.0".to_string()),
            author: None,
            homepage: None,
            repository: None,
            license: None,
            keywords: Vec::new(),
            suggested_prompts: Vec::new(),
            logo_data_uri: None,
            source: PluginSourceKind::GlobalKite,
            format: PluginManifestFormat::Native,
            root_path: PathBuf::from(format!("/plugins/{dir_id}")),
            data_path: PathBuf::from(format!("/plugin_data/{dir_id}")),
            enabled,
            manifest_disabled: !enabled,
            can_uninstall: true,
            has_hooks: false,
            hooks_path: None,
            sidecars: Vec::new(),
            mcp_servers: servers,
            skills: Vec::new(),
            rules: Vec::new(),
            agents: Vec::new(),
        }
    }

    fn stdio_srv(plugin_id: &str, server_name: &str) -> PluginMcpServer {
        PluginMcpServer {
            id: format!("{plugin_id}_{server_name}"),
            server_name: server_name.to_string(),
            plugin_id: plugin_id.to_string(),
            config: PluginMcpTransport::Stdio {
                command: "mock-app-mcp".to_string(),
                args: vec![],
                env: BTreeMap::new(),
            },
        }
    }

    struct ChannelWriter(std::sync::mpsc::Sender<Vec<u8>>);
    impl Write for ChannelWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0
                .send(buf.to_vec())
                .map_err(|_| std::io::Error::new(std::io::ErrorKind::BrokenPipe, "closed"))?;
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    struct ChannelReader {
        rx: std::sync::mpsc::Receiver<Vec<u8>>,
        cur: Cursor<Vec<u8>>,
    }
    impl Read for ChannelReader {
        fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
            loop {
                let n = std::io::Read::read(&mut self.cur, out)?;
                if n > 0 {
                    return Ok(n);
                }
                match self.rx.recv() {
                    Ok(bytes) => self.cur = Cursor::new(bytes),
                    Err(_) => return Ok(0),
                }
            }
        }
    }

    fn make_mcp_app_mock_spawner(html_body: String, call_barrier: Option<Arc<Barrier>>) -> UpstreamSpawner {
        Arc::new(move |_spec: &PooledServerSpec| {
            let (in_tx, in_rx) = std::sync::mpsc::channel::<Vec<u8>>();
            let (out_tx, out_rx) = std::sync::mpsc::channel::<Vec<u8>>();
            let html = html_body.clone();
            let barrier = call_barrier.clone();

            std::thread::spawn(move || {
                let mut reader = BufReader::new(ChannelReader {
                    rx: in_rx,
                    cur: Cursor::new(Vec::new()),
                });
                let mut line = String::new();
                while reader.read_line(&mut line).unwrap_or(0) > 0 {
                    let trimmed = line.trim().to_string();
                    line.clear();
                    if trimmed.is_empty() {
                        continue;
                    }
                    let Ok(req) = serde_json::from_str::<Value>(&trimmed) else {
                        continue;
                    };
                    let method = req.get("method").and_then(Value::as_str).unwrap_or("").to_string();
                    let Some(id) = req.get("id").cloned() else {
                        continue;
                    };
                    let params = req.get("params").cloned().unwrap_or_else(|| json!({}));
                    let out_tx_w = out_tx.clone();
                    let html_w = html.clone();
                    let barrier_w = barrier.clone();

                    std::thread::spawn(move || {
                        let resp = match method.as_str() {
                            "initialize" => json!({
                                "jsonrpc": "2.0",
                                "id": id,
                                "result": { "protocolVersion": "2024-11-05", "capabilities": {} }
                            }),
                            "tools/list" => json!({
                                "jsonrpc": "2.0",
                                "id": id,
                                "result": {
                                    "tools": [
                                        {
                                            "name": "open_dashboard",
                                            "description": "Opens widget",
                                            "_meta": {
                                                "ui": {
                                                    "resourceUri": "ui://demo/dashboard.html",
                                                    "visibility": ["model", "app"],
                                                    "entrypoint": "aux_pane"
                                                }
                                            }
                                        },
                                        {
                                            "name": "app_refresh",
                                            "description": "App-only refresh",
                                            "_meta": {
                                                "ui/resourceUri": "ui://demo/legacy.html",
                                                "ui": {
                                                    "visibility": ["app"],
                                                    "entrypoints": ["global", "title"]
                                                }
                                            }
                                        },
                                        {
                                            "name": "model_secret",
                                            "description": "Model-only tool",
                                            "_meta": {
                                                "ui": {
                                                    "resourceUri": "ui://demo/model-view.html",
                                                    "visibility": ["model"],
                                                    "entrypoint": "inline"
                                                }
                                            }
                                        },
                                        {
                                            "name": "plain_default_tool",
                                            "description": "Tool without explicit visibility"
                                        }
                                    ]
                                }
                            }),
                            "resources/read" => {
                                let uri = params.get("uri").and_then(Value::as_str).unwrap_or("");
                                if uri == "ui://demo/bad-mime.html" {
                                    json!({
                                        "jsonrpc": "2.0",
                                        "id": id,
                                        "result": {
                                            "contents": [{
                                                "uri": uri,
                                                "mimeType": "text/html",
                                                "text": "<html><body>No profile</body></html>"
                                            }]
                                        }
                                    })
                                } else {
                                    json!({
                                        "jsonrpc": "2.0",
                                        "id": id,
                                        "result": {
                                            "contents": [{
                                                "uri": uri,
                                                "mimeType": "text/html; charset=utf-8; profile=mcp-app",
                                                "text": html_w,
                                                "_meta": {
                                                    "ui": {
                                                        "prefersBorder": false,
                                                        "csp": {
                                                            "connectDomains": [
                                                                "https://api.example.com",
                                                                "wss://Stream.Example.COM:8443",
                                                                "https://*.wildcard.com",
                                                                "https://evil.com/path",
                                                                "javascript:alert(1)"
                                                            ],
                                                            "resourceDomains": [
                                                                "https://cdn.example.com:443",
                                                                "data:text/html,evil"
                                                            ],
                                                            "frameDomains": ["http://localhost:3000", "https://foo.com?q=1"],
                                                            "baseUriDomains": ["https://base.example.com", "*"]
                                                        }
                                                    }
                                                }
                                            }]
                                        }
                                    })
                                }
                            }
                            "tools/call" => {
                                if let Some(b) = barrier_w {
                                    b.wait();
                                }
                                let tool = params.get("name").and_then(Value::as_str).unwrap_or("");
                                json!({
                                    "jsonrpc": "2.0",
                                    "id": id,
                                    "result": {
                                        "content": [{ "type": "text", "text": format!("called:{tool}") }],
                                        "structuredContent": { "tool": tool, "args": params.get("arguments") }
                                    }
                                })
                            }
                            _ => json!({
                                "jsonrpc": "2.0",
                                "id": id,
                                "error": { "code": -32601, "message": "unknown" }
                            }),
                        };
                        let mut encoded = serde_json::to_string(&resp).unwrap();
                        encoded.push('\n');
                        let _ = out_tx_w.send(encoded.into_bytes());
                    });
                }
            });

            Ok(UpstreamTransport {
                writer: Box::new(ChannelWriter(in_tx)),
                reader: Box::new(BufReader::new(ChannelReader {
                    rx: out_rx,
                    cur: Cursor::new(Vec::new()),
                })),
                terminator: Box::new(|| {}),
                alive_probe: None,
            })
        })
    }

    #[test]
    fn parses_modern_and_legacy_tool_meta_visibility_and_entrypoints() {
        let hub = SharedStdioMcpHub::with_spawner(make_mcp_app_mock_spawner(
            "<html><body>Hi</body></html>".to_string(),
            None,
        ));
        hub.register_server("alpha_widgets", "mock-app-mcp", &[], &[]);
        hub.register_server("disabled_hidden", "mock-app-mcp", &[], &[]);

        let plugins = vec![
            make_test_plugin("alpha", true, vec![stdio_srv("alpha", "widgets")]),
            make_test_plugin("disabled", false, vec![stdio_srv("disabled", "hidden")]),
        ];

        let entries = list_mcp_app_entrypoints_with_plugins(&plugins, Some(&hub));
        assert_eq!(entries.len(), 4);
        assert_eq!(entries[0].server_name, "alpha_widgets");
        assert_eq!(entries[0].tool_name, "open_dashboard");
        assert_eq!(entries[0].resource_uri, "ui://demo/dashboard.html");
        assert_eq!(entries[0].surface, McpAppSurfaceKind::AuxPane);

        // Legacy _meta["ui/resourceUri"] with multiple entrypoints emits global + title
        assert_eq!(entries[1].tool_name, "app_refresh");
        assert_eq!(entries[1].resource_uri, "ui://demo/legacy.html");
        assert_eq!(entries[1].surface, McpAppSurfaceKind::Global);
        assert_eq!(entries[2].surface, McpAppSurfaceKind::Title);

        // Inline entrypoint
        assert_eq!(entries[3].tool_name, "model_secret");
        assert_eq!(entries[3].surface, McpAppSurfaceKind::Inline);
    }

    #[test]
    fn validates_ui_uri_mime_types_and_csp_origin_allowlists() {
        assert_eq!(
            validate_ui_resource_uri("ui://app/index.html").unwrap(),
            "ui://app/index.html"
        );
        assert!(validate_ui_resource_uri("https://example.com").is_err());
        assert!(validate_ui_resource_uri("javascript:alert(1)").is_err());
        assert!(validate_ui_resource_uri("ui://").is_err());
        assert!(validate_ui_resource_uri("ui://app/bad path").is_err());

        assert!(validate_mcp_app_mime_type("text/html;profile=mcp-app").is_ok());
        assert!(validate_mcp_app_mime_type("text/html; charset=utf-8; profile=mcp-app").is_ok());
        assert!(validate_mcp_app_mime_type("TEXT/HTML; profile=\"mcp-app\"; charset=UTF-8").is_ok());
        assert!(validate_mcp_app_mime_type("text/html").is_err());
        assert!(validate_mcp_app_mime_type("text/html;profile=other").is_err());
        assert!(validate_mcp_app_mime_type("application/javascript").is_err());

        let csp = sanitize_csp_allowlist(Some(&json!({
            "connectDomains": [
                "https://api.example.com",
                "HTTPS://API.EXAMPLE.COM",
                "wss://ws.example.com:9443",
                "http://[::1]:8080",
                "https://*.wildcard.example.com",
                "https://api.example.com/v1",
                "https://api.example.com?foo=bar",
                "https://user:pass@api.example.com",
                "data:text/plain,abc",
                "javascript:void(0)",
                "'unsafe-inline'",
                "*"
            ],
            "resourceDomains": ["https://cdn.example.com/assets/app.js", "https://cdn.example.com"],
            "frameDomains": ["http://127.0.0.1:4173", "ftp://files.example.com"],
            "baseUriDomains": ["https://origin.example.com#hash", "https://origin.example.com"]
        })));

        assert_eq!(
            csp.connect_domains,
            vec![
                "https://api.example.com",
                "wss://ws.example.com:9443",
                "http://[::1]:8080",
            ]
        );
        assert_eq!(csp.resource_domains, vec!["https://cdn.example.com"]);
        assert_eq!(csp.frame_domains, vec!["http://127.0.0.1:4173"]);
        assert_eq!(csp.base_uri_domains, vec!["https://origin.example.com"]);
    }

    #[tokio::test]
    async fn enforces_html_size_limit_and_returns_sanitized_resource_payload() {
        let hub = Arc::new(SharedStdioMcpHub::with_spawner(make_mcp_app_mock_spawner(
            "<!doctype html><html><body>OK</body></html>".to_string(),
            None,
        )));
        hub.register_server("alpha_widgets", "mock-app-mcp", &[], &[]);
        let plugins = vec![make_test_plugin(
            "alpha",
            true,
            vec![stdio_srv("alpha", "widgets")],
        )];

        let payload = read_mcp_app_resource_with_plugins(
            &plugins,
            "widgets",
            "ui://demo/dashboard.html",
            Some(Arc::clone(&hub)),
        )
        .await
        .expect("resource read succeeds");
        assert_eq!(payload.server_name, "alpha_widgets");
        assert_eq!(payload.prefers_border, Some(false));
        assert_eq!(
            payload.csp.connect_domains,
            vec![
                "https://api.example.com",
                "wss://stream.example.com:8443",
            ]
        );
        assert_eq!(payload.csp.resource_domains, vec!["https://cdn.example.com:443"]);
        assert_eq!(payload.csp.frame_domains, vec!["http://localhost:3000"]);
        assert_eq!(payload.csp.base_uri_domains, vec!["https://base.example.com"]);

        // Rejects invalid MIME (missing profile=mcp-app)
        let mime_err = read_mcp_app_resource_with_plugins(
            &plugins,
            "alpha_widgets",
            "ui://demo/bad-mime.html",
            Some(Arc::clone(&hub)),
        )
        .await
        .unwrap_err();
        assert!(mime_err.contains("profile=mcp-app"), "err={mime_err}");

        // Enforces 10 MiB HTML limit
        let too_big = "a".repeat(MAX_MCP_APP_HTML_BYTES + 1);
        let big_hub = Arc::new(SharedStdioMcpHub::with_spawner(make_mcp_app_mock_spawner(
            too_big, None,
        )));
        big_hub.register_server("alpha_widgets", "mock-app-mcp", &[], &[]);
        let size_err = read_mcp_app_resource_with_plugins(
            &plugins,
            "alpha_widgets",
            "ui://demo/dashboard.html",
            Some(big_hub),
        )
        .await
        .unwrap_err();
        assert!(size_err.contains("maximum size"), "err={size_err}");
    }

    #[tokio::test]
    async fn enforces_server_ownership_app_visibility_and_http_transport() {
        let hub = Arc::new(SharedStdioMcpHub::with_spawner(make_mcp_app_mock_spawner(
            "<html></html>".to_string(),
            None,
        )));
        hub.register_server("alpha_widgets", "mock-app-mcp", &[], &[]);

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut buf = [0u8; 8192];
                    let n = stream.read(&mut buf).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    let raw = String::from_utf8_lossy(&buf[..n]);
                    let body_str = raw.split("\r\n\r\n").nth(1).unwrap_or("");
                    let body: Value = serde_json::from_str(body_str).unwrap_or(Value::Null);
                    let id = body.get("id").cloned().unwrap_or(Value::Null);
                    let method = body.get("method").and_then(Value::as_str).unwrap_or("");
                    let reply = match method {
                        "initialize" => json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": { "protocolVersion": "2024-11-05", "capabilities": {} }
                        }),
                        "tools/list" => json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": {
                                "tools": [{
                                    "name": "http_widget_action",
                                    "_meta": { "ui": { "resourceUri": "ui://http/app.html", "visibility": ["app"] } }
                                }]
                            }
                        }),
                        "tools/call" => json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": { "content": [{ "type": "text", "text": "http-ok" }] }
                        }),
                        _ => json!({ "jsonrpc": "2.0", "id": id, "result": {} }),
                    };
                    let bytes = serde_json::to_vec(&reply).unwrap();
                    let head = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        bytes.len()
                    );
                    let _ = stream.write_all(head.as_bytes()).await;
                    let _ = stream.write_all(&bytes).await;
                });
            }
        });

        let http_srv = PluginMcpServer {
            id: "alpha_remote".to_string(),
            server_name: "remote".to_string(),
            plugin_id: "alpha".to_string(),
            config: PluginMcpTransport::Http {
                url: format!("http://{addr}/mcp"),
                headers: BTreeMap::new(),
            },
        };
        let plugins = vec![
            make_test_plugin(
                "alpha",
                true,
                vec![stdio_srv("alpha", "widgets"), http_srv],
            ),
            make_test_plugin("beta", false, vec![stdio_srv("beta", "off")]),
        ];
        let limiter = Arc::new(InstanceCallLimiter::new());

        // App-only and default-visibility tools on owned server succeed
        let res = call_mcp_app_tool_with_deps(
            &plugins,
            &limiter,
            "inst-1",
            "alpha_widgets",
            "app_refresh",
            json!({ "force": true }),
            Some(Arc::clone(&hub)),
        )
        .await
        .expect("app-only tool succeeds");
        assert_eq!(res["structuredContent"]["tool"], "app_refresh");

        let default_res = call_mcp_app_tool_with_deps(
            &plugins,
            &limiter,
            "inst-1",
            "alpha_widgets",
            "plain_default_tool",
            json!({}),
            Some(Arc::clone(&hub)),
        )
        .await
        .expect("default visibility allows app");
        assert_eq!(default_res["structuredContent"]["tool"], "plain_default_tool");

        // HTTP server tool call succeeds
        let http_res = call_mcp_app_tool_with_deps(
            &plugins,
            &limiter,
            "inst-1",
            "alpha_remote",
            "http_widget_action",
            json!({}),
            None,
        )
        .await
        .expect("http tool succeeds");
        assert_eq!(http_res["content"][0]["text"], "http-ok");

        // Model-only tool is rejected
        let model_err = call_mcp_app_tool_with_deps(
            &plugins,
            &limiter,
            "inst-1",
            "alpha_widgets",
            "model_secret",
            json!({}),
            Some(Arc::clone(&hub)),
        )
        .await
        .unwrap_err();
        assert!(model_err.contains("restricted"), "err={model_err}");

        // Unknown tool on owned server is rejected
        let unknown_tool_err = call_mcp_app_tool_with_deps(
            &plugins,
            &limiter,
            "inst-1",
            "alpha_widgets",
            "http_widget_action",
            json!({}),
            Some(Arc::clone(&hub)),
        )
        .await
        .unwrap_err();
        assert!(unknown_tool_err.contains("does not belong"), "err={unknown_tool_err}");

        // Disabled plugin and unknown server are rejected
        let disabled_err = call_mcp_app_tool_with_deps(
            &plugins,
            &limiter,
            "inst-1",
            "beta_off",
            "app_refresh",
            json!({}),
            Some(Arc::clone(&hub)),
        )
        .await
        .unwrap_err();
        assert!(disabled_err.contains("disabled"), "err={disabled_err}");
        assert_eq!(limiter.active_count("inst-1"), 0);
    }

    #[test]
    fn enforces_max_4_concurrent_tool_calls_per_instance_with_raii_cleanup() {
        let limiter = Arc::new(InstanceCallLimiter::new());
        let p1 = limiter.acquire("inst-a").unwrap();
        let p2 = limiter.acquire("inst-a").unwrap();
        let p3 = limiter.acquire("inst-a").unwrap();
        let p4 = limiter.acquire("inst-a").unwrap();
        assert_eq!(limiter.active_count("inst-a"), 4);

        // 5th call on same instance fails immediately
        let err = limiter.acquire("inst-a").err().expect("5th permit rejected");
        assert!(err.contains("4 concurrent tool calls"), "err={err}");

        // Independent instance still succeeds
        let other = limiter.acquire("inst-b").unwrap();
        assert_eq!(limiter.active_count("inst-b"), 1);

        // Dropping one permit frees capacity immediately
        drop(p1);
        assert_eq!(limiter.active_count("inst-a"), 3);
        let p5 = limiter.acquire("inst-a").unwrap();
        assert_eq!(limiter.active_count("inst-a"), 4);

        drop((p2, p3, p4, p5, other));
        assert_eq!(limiter.active_count("inst-a"), 0);
        assert_eq!(limiter.active_count("inst-b"), 0);
    }
}
