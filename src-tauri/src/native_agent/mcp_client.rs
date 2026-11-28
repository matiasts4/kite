//! Native Rust Pooled MCP Client (`S3`).
//!
//! Connects over Streamable HTTP/SSE (`POST /mcp` or `POST /mcp/pool/<server>`)
//! against the loopback `kite-core` MCP Hub (or any compliant HTTP MCP endpoint)
//! using the shared pooled `reqwest::Client` and optional Bearer authentication,
//! falls back to `SharedStdioMcpHub` for pooled stdio upstreams, and compresses
//! oversized MCP tool responses through `kite_ctx::mcp_proxy::compress_mcp_jsonrpc_line`.

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use kite_ctx::mcp_proxy::compress_mcp_jsonrpc_line;
use kite_ctx::ContextEngine;
use serde_json::{json, Value};

use crate::dispatch::mcp_http::{current_mcp_hub_info, mcp_hub_endpoint_path};
use crate::dispatch::mcp_hub::{
    global_stdio_mcp_hub, SharedStdioMcpHub, DEFAULT_MCP_REQUEST_TIMEOUT,
};

const MCP_PROTOCOL_VERSION: &str = "2024-11-05";
const MCP_HTTP_REQUEST_TIMEOUT: Duration = Duration::from_secs(180);
const MCP_RESPONSE_COMPRESS_THRESHOLD: usize = 4096;
const MAX_MCP_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const MAX_TOOLS_LIST_PAGES: usize = 32;

static GLOBAL_STDIO_REQ_ID: AtomicU64 = AtomicU64::new(1);

fn shared_ctx_engine() -> Option<&'static ContextEngine> {
    static ENGINE: OnceLock<Option<ContextEngine>> = OnceLock::new();
    ENGINE
        .get_or_init(|| {
            #[cfg(test)]
            let res = ContextEngine::open_in_memory();
            #[cfg(not(test))]
            let res = ContextEngine::open_default().or_else(|_| ContextEngine::open_in_memory());
            res.ok()
        })
        .as_ref()
}

fn normalize_mcp_endpoint_url(base_url: &str) -> String {
    let trimmed = base_url.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if let Some(scheme_end) = trimmed.find("://") {
        let after_scheme = &trimmed[scheme_end + 3..];
        if let Some(rel_idx) = after_scheme.find(['/', '?', '#']) {
            let split_at = scheme_end + 3 + rel_idx;
            let (origin, suffix) = trimmed.split_at(split_at);
            if suffix == "/" {
                format!("{origin}/mcp")
            } else if suffix.starts_with("/?") || suffix.starts_with("/#") {
                format!("{origin}/mcp{}", &suffix[1..])
            } else if suffix.starts_with('?') || suffix.starts_with('#') {
                format!("{origin}/mcp{suffix}")
            } else {
                trimmed.to_string()
            }
        } else {
            format!("{trimmed}/mcp")
        }
    } else if trimmed == "/" {
        "/mcp".to_string()
    } else {
        trimmed.to_string()
    }
}

fn server_label_from_url(endpoint_url: &str) -> String {
    let path_without_query = endpoint_url.split(['?', '#']).next().unwrap_or(endpoint_url);
    if let Some(pool_idx) = path_without_query.find("/mcp/pool/") {
        let candidate = &path_without_query[pool_idx + "/mcp/pool/".len()..];
        let name = candidate.trim_matches('/');
        if !name.is_empty() {
            return name.to_string();
        }
    }
    "kite-hub".to_string()
}

/// Async Streamable HTTP/SSE MCP client backed by the shared pooled `reqwest::Client`.
#[derive(Debug, Clone)]
pub struct NativeMcpClient {
    endpoint_url: String,
    bearer_token: Option<String>,
    extra_headers: Vec<(String, String)>,
    session_id: Arc<Mutex<Option<String>>>,
    client_id: String,
    next_id: Arc<AtomicU64>,
}

impl NativeMcpClient {
    /// Creates an HTTP/SSE MCP client targeting `base_url` (appending `/mcp` when
    /// only an origin URL is provided) with an optional Bearer token.
    pub fn connect_http(base_url: impl Into<String>, bearer_token: Option<String>) -> Self {
        let raw_url = base_url.into();
        let endpoint_url = normalize_mcp_endpoint_url(&raw_url);
        let clean_token = bearer_token
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty());

        Self {
            endpoint_url,
            bearer_token: clean_token,
            extra_headers: Vec::new(),
            session_id: Arc::new(Mutex::new(None)),
            client_id: format!("native-mcp-{}", uuid::Uuid::new_v4().simple()),
            next_id: Arc::new(AtomicU64::new(1)),
        }
    }

    /// Creates an HTTP/SSE MCP client with custom request headers (e.g. plugin MCP configs).
    pub fn connect_http_with_headers(
        base_url: impl Into<String>,
        headers: &std::collections::BTreeMap<String, String>,
    ) -> Self {
        let mut client = Self::connect_http(base_url, None);
        client.extra_headers = headers
            .iter()
            .filter_map(|(k, v)| {
                let key = k.trim();
                if key.is_empty() {
                    None
                } else {
                    Some((key.to_string(), v.clone()))
                }
            })
            .collect();
        client
    }

    /// Discovers the running loopback MCP Hub via `current_mcp_hub_info()` or by
    /// reading the persisted `mcp-hub.json` endpoint discovery file.
    pub fn from_discovered_hub() -> Result<Self, String> {
        if let Some((port, token)) = current_mcp_hub_info() {
            if port > 0 && !token.trim().is_empty() {
                return Ok(Self::connect_http(
                    format!("http://127.0.0.1:{port}/mcp"),
                    Some(token),
                ));
            }
        }
        Self::from_hub_file(&mcp_hub_endpoint_path())
    }

    pub(crate) fn from_hub_file(path: &Path) -> Result<Self, String> {
        let bytes = std::fs::read(path).map_err(|err| {
            format!(
                "Failed to read MCP Hub discovery file '{}': {err}",
                path.display()
            )
        })?;
        let parsed = serde_json::from_slice::<Value>(&bytes).map_err(|err| {
            format!(
                "Invalid JSON in MCP Hub discovery file '{}': {err}",
                path.display()
            )
        })?;

        let token = parsed
            .get("token")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .ok_or_else(|| {
                format!(
                    "MCP Hub discovery file '{}' is missing a valid bearer 'token'",
                    path.display()
                )
            })?;

        let base_url = parsed
            .get("url")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .or_else(|| {
                parsed
                    .get("port")
                    .and_then(Value::as_u64)
                    .and_then(|p| u16::try_from(p).ok())
                    .filter(|&p| p > 0)
                    .map(|p| format!("http://127.0.0.1:{p}"))
            })
            .ok_or_else(|| {
                format!(
                    "MCP Hub discovery file '{}' is missing a valid 'url' or 'port'",
                    path.display()
                )
            })?;

        Ok(Self::connect_http(base_url, Some(token)))
    }

    fn allocate_request_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    /// Performs MCP `initialize` handshake and emits best-effort `notifications/initialized`.
    pub async fn initialize(&self) -> Result<Value, String> {
        let params = json!({
            "protocolVersion": MCP_PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {
                "name": "kite-native-agent",
                "version": env!("CARGO_PKG_VERSION"),
            }
        });
        let resp = self.send_jsonrpc_request("initialize", Some(params)).await?;
        let result = extract_jsonrpc_result(resp)?;

        // Follow up with the MCP lifecycle notification (ignored if an endpoint declines notifications).
        let _ = self
            .send_jsonrpc_notification("notifications/initialized", None)
            .await;

        Ok(result)
    }

    /// Lists available MCP tools (`tools/list`), automatically following `nextCursor` pages.
    pub async fn list_tools(&self) -> Result<Vec<Value>, String> {
        let mut all_tools = Vec::new();
        let mut cursor: Option<String> = None;
        let mut seen_cursors: Vec<String> = Vec::new();

        for _ in 0..MAX_TOOLS_LIST_PAGES {
            let params = match cursor.as_deref() {
                Some(c) => json!({ "cursor": c }),
                None => json!({}),
            };
            let resp = self.send_jsonrpc_request("tools/list", Some(params)).await?;
            let result = extract_jsonrpc_result(resp)?;

            let tools = result
                .get("tools")
                .and_then(Value::as_array)
                .ok_or_else(|| "MCP tools/list response missing 'tools' array".to_string())?;
            all_tools.extend(tools.iter().cloned());

            let next_cursor = result
                .get("nextCursor")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);

            match next_cursor {
                Some(next) if !seen_cursors.contains(&next) => {
                    seen_cursors.push(next.clone());
                    cursor = Some(next);
                }
                _ => break,
            }
        }

        Ok(all_tools)
    }

    /// Lists available MCP tool definitions (`tools/list`), preserving `_meta` and schemas.
    pub async fn list_tools_raw(&self) -> Result<Vec<Value>, String> {
        self.list_tools().await
    }

    /// Reads a raw MCP resource (`resources/read`) for `uri`.
    pub async fn read_resource(&self, uri: &str) -> Result<Value, String> {
        let clean_uri = uri.trim();
        if clean_uri.is_empty() {
            return Err("MCP resource URI cannot be empty".to_string());
        }
        let resp = self
            .send_jsonrpc_request("resources/read", Some(json!({ "uri": clean_uri })))
            .await?;
        extract_jsonrpc_result(resp)
    }

    /// Calls an MCP tool (`tools/call`), compressing oversized JSON-RPC responses via
    /// `kite_ctx::mcp_proxy::compress_mcp_jsonrpc_line` before extracting text output.
    pub async fn call_tool(&self, name: &str, arguments: Value) -> Result<String, String> {
        let clean_name = name.trim();
        if clean_name.is_empty() {
            return Err("MCP tool name cannot be empty".to_string());
        }
        let normalized_args = if arguments.is_null() {
            json!({})
        } else {
            arguments
        };
        let params = json!({
            "name": clean_name,
            "arguments": normalized_args,
        });

        let resp = self.send_jsonrpc_request("tools/call", Some(params)).await?;
        let server_label = server_label_from_url(&self.endpoint_url);
        extract_compressed_tool_output(resp, &server_label)
    }

    /// Calls an MCP tool (`tools/call`) and returns the raw JSON-RPC `result` object
    /// without response compression or text flattening.
    pub async fn call_tool_raw(&self, name: &str, arguments: Value) -> Result<Value, String> {
        let clean_name = name.trim();
        if clean_name.is_empty() {
            return Err("MCP tool name cannot be empty".to_string());
        }
        let normalized_args = if arguments.is_null() {
            json!({})
        } else {
            arguments
        };
        let params = json!({
            "name": clean_name,
            "arguments": normalized_args,
        });
        let resp = self.send_jsonrpc_request("tools/call", Some(params)).await?;
        extract_jsonrpc_result(resp)
    }

    async fn send_jsonrpc_request(
        &self,
        method: &str,
        params: Option<Value>,
    ) -> Result<Value, String> {
        let id = json!(self.allocate_request_id());
        let mut body = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
        });
        if let Some(p) = params {
            if let Some(obj) = body.as_object_mut() {
                obj.insert("params".to_string(), p);
            }
        }

        self.post_jsonrpc(&body, Some(id))
            .await?
            .ok_or_else(|| format!("MCP server returned empty body for '{method}'"))
    }

    async fn send_jsonrpc_notification(
        &self,
        method: &str,
        params: Option<Value>,
    ) -> Result<(), String> {
        let mut body = json!({
            "jsonrpc": "2.0",
            "method": method,
        });
        if let Some(p) = params {
            if let Some(obj) = body.as_object_mut() {
                obj.insert("params".to_string(), p);
            }
        }

        let _ = self.post_jsonrpc(&body, None).await?;
        Ok(())
    }

    async fn post_jsonrpc(
        &self,
        payload: &Value,
        expected_id: Option<Value>,
    ) -> Result<Option<Value>, String> {
        if self.endpoint_url.is_empty() {
            return Err("MCP HTTP endpoint URL cannot be empty".to_string());
        }
        let client = super::types::shared_http_client();
        let body_bytes = serde_json::to_vec(payload)
            .map_err(|err| format!("Failed to serialize MCP JSON-RPC request: {err}"))?;

        let mut req = client
            .post(&self.endpoint_url)
            .timeout(MCP_HTTP_REQUEST_TIMEOUT)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header(
                reqwest::header::ACCEPT,
                "application/json, text/event-stream",
            )
            .header("X-Kite-Client-Id", &self.client_id)
            .body(body_bytes);

        if let Some(token) = self.bearer_token.as_deref() {
            req = req.header(
                reqwest::header::AUTHORIZATION,
                format!("Bearer {token}"),
            );
        }
        for (key, value) in &self.extra_headers {
            let trimmed = key.trim();
            if trimmed.is_empty()
                || trimmed.eq_ignore_ascii_case("content-type")
                || trimmed.eq_ignore_ascii_case("content-length")
                || trimmed.eq_ignore_ascii_case("host")
                || (self.bearer_token.is_some() && trimmed.eq_ignore_ascii_case("authorization"))
            {
                continue;
            }
            req = req.header(trimmed, value.as_str());
        }

        if let Some(sid) = self
            .session_id
            .lock()
            .ok()
            .and_then(|guard| guard.clone())
        {
            req = req.header("Mcp-Session-Id", sid);
        }

        let resp = req
            .send()
            .await
            .map_err(|err| format!("MCP HTTP request failed ({}): {err}", self.endpoint_url))?;

        if let Some(sid) = resp
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            if let Ok(mut guard) = self.session_id.lock() {
                *guard = Some(sid.to_string());
            }
        }

        let status = resp.status();
        let content_type = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_ascii_lowercase())
            .unwrap_or_default();

        if !status.is_success() {
            let err_bytes = resp
                .bytes()
                .await
                .map_err(|err| format!("MCP HTTP {status} (failed reading error body: {err})"))?;
            return Err(format_http_error(status, &err_bytes));
        }

        let Some(req_id) = expected_id else {
            return Ok(None);
        };

        if status == reqwest::StatusCode::ACCEPTED || status == reqwest::StatusCode::NO_CONTENT {
            return Err(format!(
                "MCP server returned {status} without a JSON-RPC response payload"
            ));
        }

        if content_type.contains("text/event-stream") {
            let parsed = read_sse_jsonrpc_response(resp, &req_id).await?;
            return Ok(Some(parsed));
        }

        let bytes = resp
            .bytes()
            .await
            .map_err(|err| format!("Failed reading MCP HTTP response body: {err}"))?;
        if bytes.is_empty() {
            return Err("MCP server returned an empty JSON-RPC response body".to_string());
        }

        if looks_like_sse_payload(&bytes) {
            let parsed = parse_sse_jsonrpc_bytes(&bytes, &req_id)?;
            return Ok(Some(parsed));
        }

        let parsed = serde_json::from_slice::<Value>(&bytes)
            .map_err(|err| format!("Invalid MCP JSON-RPC response JSON: {err}"))?;
        Ok(Some(parsed))
    }
}

fn pooled_stdio_client_id() -> String {
    format!("native-mcp-stdio-{}", std::process::id())
}

fn initialize_pooled_stdio_session_on_hub(
    hub: &SharedStdioMcpHub,
    server_name: &str,
    client_id: &str,
) -> Result<String, String> {
    let clean_server = server_name.trim();
    if clean_server.is_empty() {
        return Err("Pooled MCP server name cannot be empty".to_string());
    }

    let init_id = GLOBAL_STDIO_REQ_ID.fetch_add(1, Ordering::Relaxed);
    let init_req = json!({
        "jsonrpc": "2.0",
        "id": init_id,
        "method": "initialize",
        "params": {
            "protocolVersion": MCP_PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {
                "name": "kite-native-agent",
                "version": env!("CARGO_PKG_VERSION"),
            }
        }
    });

    match hub.forward_jsonrpc_blocking(
        clean_server,
        client_id,
        &init_req,
        DEFAULT_MCP_REQUEST_TIMEOUT,
    ) {
        Ok(Some(resp)) if resp.get("result").is_some() => {
            let notif = json!({
                "jsonrpc": "2.0",
                "method": "notifications/initialized"
            });
            let _ = hub.forward_jsonrpc_blocking(
                clean_server,
                client_id,
                &notif,
                DEFAULT_MCP_REQUEST_TIMEOUT,
            );
        }
        Ok(_) => {}
        Err(err) => return Err(err.to_string()),
    }

    Ok(clean_server.to_string())
}

fn pooled_stdio_rpc_on_hub(
    hub: &SharedStdioMcpHub,
    clean_server: &str,
    client_id: &str,
    method: &str,
    params: Value,
    label: &str,
) -> Result<Value, String> {
    let req_id = GLOBAL_STDIO_REQ_ID.fetch_add(1, Ordering::Relaxed);
    let req = json!({
        "jsonrpc": "2.0",
        "id": req_id,
        "method": method,
        "params": params,
    });

    hub.forward_jsonrpc_blocking(clean_server, client_id, &req, DEFAULT_MCP_REQUEST_TIMEOUT)
        .map_err(|err| err.to_string())?
        .ok_or_else(|| {
            format!("Pooled MCP server '{clean_server}' returned empty response for '{label}'")
        })
}

/// Lists raw tool definitions (`tools/list`) from a pooled stdio MCP server in [`SharedStdioMcpHub`].
pub fn list_pooled_stdio_tools_raw(server_name: &str) -> Result<Vec<Value>, String> {
    list_pooled_stdio_tools_raw_on_hub(global_stdio_mcp_hub(), server_name)
}

pub(crate) fn list_pooled_stdio_tools_raw_on_hub(
    hub: &SharedStdioMcpHub,
    server_name: &str,
) -> Result<Vec<Value>, String> {
    let client_id = pooled_stdio_client_id();
    let clean_server = initialize_pooled_stdio_session_on_hub(hub, server_name, &client_id)?;

    let mut all_tools = Vec::new();
    let mut cursor: Option<String> = None;
    let mut seen_cursors: Vec<String> = Vec::new();

    for _ in 0..MAX_TOOLS_LIST_PAGES {
        let params = match cursor.as_deref() {
            Some(c) => json!({ "cursor": c }),
            None => json!({}),
        };
        let resp = pooled_stdio_rpc_on_hub(
            hub,
            &clean_server,
            &client_id,
            "tools/list",
            params,
            "tools/list",
        )?;
        let result = extract_jsonrpc_result(resp)?;

        let tools = result
            .get("tools")
            .and_then(Value::as_array)
            .ok_or_else(|| "MCP tools/list response missing 'tools' array".to_string())?;
        all_tools.extend(tools.iter().cloned());

        let next_cursor = result
            .get("nextCursor")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);

        match next_cursor {
            Some(next) if !seen_cursors.contains(&next) => {
                seen_cursors.push(next.clone());
                cursor = Some(next);
            }
            _ => break,
        }
    }

    Ok(all_tools)
}

/// Reads a raw resource (`resources/read`) from a pooled stdio MCP server in [`SharedStdioMcpHub`].
pub fn read_pooled_stdio_resource(server_name: &str, uri: &str) -> Result<Value, String> {
    read_pooled_stdio_resource_on_hub(global_stdio_mcp_hub(), server_name, uri)
}

pub(crate) fn read_pooled_stdio_resource_on_hub(
    hub: &SharedStdioMcpHub,
    server_name: &str,
    uri: &str,
) -> Result<Value, String> {
    let clean_uri = uri.trim();
    if clean_uri.is_empty() {
        return Err("MCP resource URI cannot be empty".to_string());
    }
    let client_id = pooled_stdio_client_id();
    let clean_server = initialize_pooled_stdio_session_on_hub(hub, server_name, &client_id)?;
    let resp = pooled_stdio_rpc_on_hub(
        hub,
        &clean_server,
        &client_id,
        "resources/read",
        json!({ "uri": clean_uri }),
        clean_uri,
    )?;
    extract_jsonrpc_result(resp)
}

/// Calls a tool (`tools/call`) on a pooled stdio MCP server in [`SharedStdioMcpHub`] and
/// returns the raw JSON-RPC `result` payload without extra compression or flattening.
pub fn call_pooled_stdio_tool_raw(
    server_name: &str,
    name: &str,
    arguments: Value,
) -> Result<Value, String> {
    call_pooled_stdio_tool_raw_on_hub(global_stdio_mcp_hub(), server_name, name, arguments)
}

pub(crate) fn call_pooled_stdio_tool_raw_on_hub(
    hub: &SharedStdioMcpHub,
    server_name: &str,
    name: &str,
    arguments: Value,
) -> Result<Value, String> {
    let clean_name = name.trim();
    if clean_name.is_empty() {
        return Err("MCP tool name cannot be empty".to_string());
    }
    let client_id = pooled_stdio_client_id();
    let clean_server = initialize_pooled_stdio_session_on_hub(hub, server_name, &client_id)?;
    let normalized_args = if arguments.is_null() {
        json!({})
    } else {
        arguments
    };
    let resp = pooled_stdio_rpc_on_hub(
        hub,
        &clean_server,
        &client_id,
        "tools/call",
        json!({
            "name": clean_name,
            "arguments": normalized_args,
        }),
        clean_name,
    )?;
    extract_jsonrpc_result(resp)
}

/// Calls a tool on a pooled stdio MCP server registered inside [`SharedStdioMcpHub`],
/// compressing large responses via `kite_ctx::mcp_proxy::compress_mcp_jsonrpc_line`.
pub fn call_pooled_stdio_tool(
    server_name: &str,
    name: &str,
    arguments: Value,
) -> Result<String, String> {
    call_pooled_stdio_tool_on_hub(global_stdio_mcp_hub(), server_name, name, arguments)
}

pub(crate) fn call_pooled_stdio_tool_on_hub(
    hub: &SharedStdioMcpHub,
    server_name: &str,
    name: &str,
    arguments: Value,
) -> Result<String, String> {
    if server_name.trim().is_empty() {
        return Err("Pooled MCP server name cannot be empty".to_string());
    }
    let clean_name = name.trim();
    if clean_name.is_empty() {
        return Err("MCP tool name cannot be empty".to_string());
    }

    let client_id = pooled_stdio_client_id();
    let clean_server = initialize_pooled_stdio_session_on_hub(hub, server_name, &client_id)?;

    let normalized_args = if arguments.is_null() {
        json!({})
    } else {
        arguments
    };
    let resp = pooled_stdio_rpc_on_hub(
        hub,
        &clean_server,
        &client_id,
        "tools/call",
        json!({
            "name": clean_name,
            "arguments": normalized_args,
        }),
        clean_name,
    )?;

    extract_compressed_tool_output(resp, &clean_server)
}

fn format_http_error(status: reqwest::StatusCode, body: &[u8]) -> String {
    if let Ok(parsed) = serde_json::from_slice::<Value>(body) {
        if let Some(err_obj) = parsed.get("error").filter(|v| !v.is_null()) {
            return format!(
                "MCP HTTP {status}: {}",
                format_jsonrpc_error(err_obj)
            );
        }
    }
    let text = String::from_utf8_lossy(body);
    let snippet: String = text.trim().chars().take(512).collect();
    if snippet.is_empty() {
        format!("MCP HTTP request failed with status {status}")
    } else {
        format!("MCP HTTP {status}: {snippet}")
    }
}

fn format_jsonrpc_error(err_val: &Value) -> String {
    if let Some(msg) = err_val.as_str() {
        return msg.to_string();
    }
    let code = err_val.get("code").and_then(Value::as_i64);
    let message = err_val
        .get("message")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    match (code, message) {
        (Some(c), Some(m)) => format!("MCP error ({c}): {m}"),
        (None, Some(m)) => m.to_string(),
        (Some(c), None) => format!("MCP error ({c})"),
        (None, None) => serde_json::to_string(err_val).unwrap_or_else(|_| "MCP error".to_string()),
    }
}

fn extract_jsonrpc_result(resp: Value) -> Result<Value, String> {
    if let Some(err_obj) = resp.get("error").filter(|v| !v.is_null()) {
        return Err(format_jsonrpc_error(err_obj));
    }
    resp.get("result")
        .cloned()
        .ok_or_else(|| "MCP JSON-RPC response missing 'result' field".to_string())
}

fn maybe_compress_jsonrpc_response(resp: Value, server_label: &str) -> Value {
    let Ok(raw) = serde_json::to_string(&resp) else {
        return resp;
    };
    if raw.len() < MCP_RESPONSE_COMPRESS_THRESHOLD || raw.contains("<<ccr:") {
        return resp;
    }
    let Some(engine) = shared_ctx_engine() else {
        return resp;
    };
    let compressed = compress_mcp_jsonrpc_line(
        engine,
        &raw,
        server_label,
        MCP_RESPONSE_COMPRESS_THRESHOLD,
        "native-agent",
        "kite-native-agent",
        "mcp",
        server_label,
    );
    if compressed == raw {
        resp
    } else {
        serde_json::from_str(&compressed).unwrap_or(resp)
    }
}

fn extract_compressed_tool_output(resp: Value, server_label: &str) -> Result<String, String> {
    if let Some(err_obj) = resp.get("error").filter(|v| !v.is_null()) {
        return Err(format_jsonrpc_error(err_obj));
    }
    let compressed_resp = maybe_compress_jsonrpc_response(resp, server_label);
    let result = extract_jsonrpc_result(compressed_resp)?;
    extract_tool_result_text(&result)
}

fn extract_tool_result_text(result: &Value) -> Result<String, String> {
    let is_error = result
        .get("isError")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let mut parts: Vec<String> = Vec::new();
    if let Some(items) = result.get("content").and_then(Value::as_array) {
        for item in items {
            let item_type = item.get("type").and_then(Value::as_str).unwrap_or("");
            match item_type {
                "text" => {
                    if let Some(text) = item.get("text").and_then(Value::as_str) {
                        parts.push(text.to_string());
                    }
                }
                "resource" => {
                    if let Some(res) = item.get("resource") {
                        if let Some(text) = res.get("text").and_then(Value::as_str) {
                            parts.push(text.to_string());
                        } else if let Some(uri) = res.get("uri").and_then(Value::as_str) {
                            parts.push(format!("[resource: {uri}]"));
                        }
                    }
                }
                "resource_link" => {
                    let uri = item.get("uri").and_then(Value::as_str).unwrap_or("");
                    let label = item.get("name").and_then(Value::as_str).unwrap_or("");
                    if !label.is_empty() && !uri.is_empty() {
                        parts.push(format!("[resource_link: {label} ({uri})]"));
                    } else if !uri.is_empty() {
                        parts.push(format!("[resource_link: {uri}]"));
                    }
                }
                "image" | "audio" => {
                    let mime = item
                        .get("mimeType")
                        .and_then(Value::as_str)
                        .unwrap_or("application/octet-stream");
                    parts.push(format!("[{item_type}: {mime}]"));
                }
                _ => {
                    if let Some(text) = item.get("text").and_then(Value::as_str) {
                        parts.push(text.to_string());
                    } else if let Ok(raw) = serde_json::to_string(item) {
                        parts.push(raw);
                    }
                }
            }
        }
    }

    let text = if !parts.is_empty() {
        parts.join("\n")
    } else if let Some(structured) = result.get("structuredContent") {
        serde_json::to_string_pretty(structured)
            .or_else(|_| serde_json::to_string(structured))
            .unwrap_or_default()
    } else if let Some(s) = result.as_str() {
        s.to_string()
    } else if result.is_null() {
        String::new()
    } else {
        serde_json::to_string(result).unwrap_or_default()
    };

    if is_error {
        if text.trim().is_empty() {
            Err("MCP tool reported an error without details".to_string())
        } else {
            Err(text)
        }
    } else {
        Ok(text)
    }
}

fn looks_like_sse_payload(bytes: &[u8]) -> bool {
    let text = String::from_utf8_lossy(bytes);
    let trimmed = text.trim_start_matches('\u{feff}').trim_start();
    trimmed.starts_with("data:")
        || trimmed.starts_with("event:")
        || trimmed.starts_with(':')
        || trimmed.starts_with("id:")
}

struct SseEventAccumulator {
    event_type: String,
    data_lines: Vec<String>,
    expected_id: Value,
    fallback_response: Option<Value>,
}

impl SseEventAccumulator {
    fn new(expected_id: Value) -> Self {
        Self {
            event_type: "message".to_string(),
            data_lines: Vec::new(),
            expected_id,
            fallback_response: None,
        }
    }

    fn feed_line(&mut self, raw_line: &str) -> Option<Value> {
        let line = raw_line.trim_end_matches('\r');
        if line.is_empty() {
            return self.flush_event();
        }
        if line.starts_with(':') {
            return None;
        }
        let (field, raw_val) = match line.split_once(':') {
            Some((k, v)) => (k.trim(), v.strip_prefix(' ').unwrap_or(v)),
            None => (line.trim(), ""),
        };
        match field {
            "event" => {
                self.event_type = raw_val.trim().to_string();
            }
            "data" => {
                self.data_lines.push(raw_val.to_string());
            }
            _ => {}
        }
        None
    }

    fn flush_event(&mut self) -> Option<Value> {
        let ev_type = std::mem::replace(&mut self.event_type, "message".to_string());
        if self.data_lines.is_empty() {
            return None;
        }
        let payload = self.data_lines.join("\n");
        self.data_lines.clear();

        let trimmed = payload.trim();
        if trimmed.is_empty() || trimmed == "[DONE]" {
            return None;
        }
        if !ev_type.is_empty() && ev_type != "message" && ev_type != "error" {
            return None;
        }
        let Ok(parsed) = serde_json::from_str::<Value>(trimmed) else {
            return None;
        };
        if !parsed.is_object() {
            return None;
        }
        let is_jsonrpc_reply =
            parsed.get("result").is_some() || parsed.get("error").is_some();
        if !is_jsonrpc_reply {
            return None;
        }
        if parsed.get("id") == Some(&self.expected_id) {
            return Some(parsed);
        }
        self.fallback_response = Some(parsed);
        None
    }

    fn finish(mut self) -> Result<Value, String> {
        if let Some(matched) = self.flush_event() {
            return Ok(matched);
        }
        self.fallback_response.ok_or_else(|| {
            "MCP text/event-stream response ended without a JSON-RPC result".to_string()
        })
    }
}

async fn read_sse_jsonrpc_response(
    mut resp: reqwest::Response,
    expected_id: &Value,
) -> Result<Value, String> {
    let mut acc = SseEventAccumulator::new(expected_id.clone());
    let mut buf: Vec<u8> = Vec::new();
    let mut total_bytes: usize = 0;

    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|err| format!("Error reading MCP SSE stream: {err}"))?
    {
        total_bytes = total_bytes.saturating_add(chunk.len());
        if total_bytes > MAX_MCP_RESPONSE_BYTES {
            return Err("MCP SSE response exceeded maximum allowed size".to_string());
        }
        buf.extend_from_slice(&chunk);

        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line_bytes: Vec<u8> = buf.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line_bytes[..line_bytes.len() - 1]);
            let clean = line.strip_prefix('\u{feff}').unwrap_or(&line);
            if let Some(matched) = acc.feed_line(clean) {
                return Ok(matched);
            }
        }
    }

    if !buf.is_empty() {
        let tail = String::from_utf8_lossy(&buf);
        let clean_tail = tail.strip_prefix('\u{feff}').unwrap_or(&tail);
        for seg in clean_tail.split('\r') {
            if let Some(matched) = acc.feed_line(seg) {
                return Ok(matched);
            }
        }
    }

    acc.finish()
}

fn parse_sse_jsonrpc_bytes(bytes: &[u8], expected_id: &Value) -> Result<Value, String> {
    let text = String::from_utf8_lossy(bytes);
    let clean = text.strip_prefix('\u{feff}').unwrap_or(&text);
    let mut acc = SseEventAccumulator::new(expected_id.clone());
    for line in clean.lines() {
        if let Some(matched) = acc.feed_line(line) {
            return Ok(matched);
        }
    }
    acc.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    use crate::dispatch::mcp_hub::test_support::{make_mock_spawner, MockUpstreamMetrics};
    use crate::dispatch::mcp_hub::SharedStdioMcpHub;

    #[derive(Clone)]
    struct RecordedHttpRequest {
        method: String,
        path: String,
        headers: HashMap<String, String>,
        body: Value,
    }

    enum MockHttpReply {
        Json {
            status: u16,
            reason: &'static str,
            headers: Vec<(&'static str, String)>,
            body: Value,
        },
        Empty {
            status: u16,
            reason: &'static str,
        },
        SseStream {
            chunks: Vec<(u64, String)>,
            hold_open_ms: u64,
        },
    }

    fn find_header_end(buf: &[u8]) -> Option<(usize, usize)> {
        for i in 0..buf.len() {
            if i + 4 <= buf.len() && &buf[i..i + 4] == b"\r\n\r\n" {
                return Some((i, 4));
            }
            if i + 2 <= buf.len() && &buf[i..i + 2] == b"\n\n" {
                return Some((i, 2));
            }
        }
        None
    }

    async fn read_one_http_request(stream: &mut TcpStream) -> Option<RecordedHttpRequest> {
        let mut buf = Vec::new();
        let (hdr_end, sep_len) = loop {
            if let Some(found) = find_header_end(&buf) {
                break found;
            }
            let mut tmp = [0u8; 4096];
            let n = stream.read(&mut tmp).await.ok()?;
            if n == 0 {
                return None;
            }
            buf.extend_from_slice(&tmp[..n]);
        };

        let header_str = String::from_utf8_lossy(&buf[..hdr_end]).to_string();
        buf.drain(..hdr_end + sep_len);

        let mut lines = header_str.lines();
        let request_line = lines.next()?.trim_end_matches('\r');
        let mut parts = request_line.split_whitespace();
        let method = parts.next()?.to_string();
        let path = parts.next()?.to_string();

        let mut headers = HashMap::new();
        for line in lines {
            if let Some((k, v)) = line.trim_end_matches('\r').split_once(':') {
                headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
            }
        }

        let content_len = headers
            .get("content-length")
            .and_then(|v| v.parse::<usize>().ok())
            .unwrap_or(0);
        while buf.len() < content_len {
            let mut tmp = [0u8; 4096];
            let n = stream.read(&mut tmp).await.ok()?;
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&tmp[..n]);
        }
        let body: Value = if content_len > 0 {
            serde_json::from_slice(&buf[..content_len]).unwrap_or(Value::Null)
        } else {
            Value::Null
        };

        Some(RecordedHttpRequest {
            method,
            path,
            headers,
            body,
        })
    }

    async fn spawn_mock_mcp_server<F>(handler: F) -> (String, Arc<Mutex<Vec<RecordedHttpRequest>>>)
    where
        F: Fn(&RecordedHttpRequest) -> MockHttpReply + Send + Sync + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let recorded = Arc::new(Mutex::new(Vec::new()));
        let recorded_srv = Arc::clone(&recorded);
        let handler = Arc::new(handler);

        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let recorded_conn = Arc::clone(&recorded_srv);
                let handler_conn = Arc::clone(&handler);
                tokio::spawn(async move {
                    let Some(req) = read_one_http_request(&mut stream).await else {
                        return;
                    };
                    recorded_conn.lock().unwrap().push(req.clone());
                    match handler_conn(&req) {
                        MockHttpReply::Json {
                            status,
                            reason,
                            headers,
                            body,
                        } => {
                            let body_bytes = serde_json::to_vec(&body).unwrap();
                            let mut raw = format!(
                                "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n",
                                body_bytes.len()
                            );
                            for (k, v) in headers {
                                raw.push_str(&format!("{k}: {v}\r\n"));
                            }
                            raw.push_str("\r\n");
                            let _ = stream.write_all(raw.as_bytes()).await;
                            let _ = stream.write_all(&body_bytes).await;
                            let _ = stream.flush().await;
                        }
                        MockHttpReply::Empty { status, reason } => {
                            let raw = format!(
                                "HTTP/1.1 {status} {reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                            );
                            let _ = stream.write_all(raw.as_bytes()).await;
                            let _ = stream.flush().await;
                        }
                        MockHttpReply::SseStream {
                            chunks,
                            hold_open_ms,
                        } => {
                            let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n";
                            if stream.write_all(head.as_bytes()).await.is_err() {
                                return;
                            }
                            let _ = stream.flush().await;
                            for (delay_ms, chunk) in chunks {
                                if delay_ms > 0 {
                                    tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                                }
                                if stream.write_all(chunk.as_bytes()).await.is_err() {
                                    return;
                                }
                                let _ = stream.flush().await;
                            }
                            if hold_open_ms > 0 {
                                tokio::time::sleep(Duration::from_millis(hold_open_ms)).await;
                            }
                        }
                    }
                });
            }
        });

        (format!("http://{addr}"), recorded)
    }

    #[tokio::test]
    async fn http_mcp_lifecycle_verifies_bearer_headers_pagination_and_tool_call() {
        let expected_token = "secret-hub-token-3c";
        let (base_url, recorded) = spawn_mock_mcp_server(move |req| {
            let auth = req.headers.get("authorization").cloned().unwrap_or_default();
            if auth != format!("Bearer {expected_token}") {
                return MockHttpReply::Json {
                    status: 401,
                    reason: "Unauthorized",
                    headers: vec![],
                    body: json!({ "error": { "code": -32000, "message": "unauthorized" } }),
                };
            }

            let method = req.body.get("method").and_then(Value::as_str).unwrap_or("");
            let id = req.body.get("id").cloned().unwrap_or(Value::Null);
            match method {
                "initialize" => MockHttpReply::Json {
                    status: 200,
                    reason: "OK",
                    headers: vec![("Mcp-Session-Id", "sess-unit-3c".to_string())],
                    body: json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": {
                            "protocolVersion": "2024-11-05",
                            "capabilities": { "tools": {} },
                            "serverInfo": { "name": "mock-http-mcp", "version": "1.0.0" }
                        }
                    }),
                },
                "notifications/initialized" => MockHttpReply::Empty {
                    status: 202,
                    reason: "Accepted",
                },
                "tools/list" => {
                    let cursor = req
                        .body
                        .pointer("/params/cursor")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    if cursor == "page-2" {
                        MockHttpReply::Json {
                            status: 200,
                            reason: "OK",
                            headers: vec![],
                            body: json!({
                                "jsonrpc": "2.0",
                                "id": id,
                                "result": {
                                    "tools": [
                                        { "name": "second_tool", "description": "Page 2 tool" }
                                    ]
                                }
                            }),
                        }
                    } else {
                        MockHttpReply::Json {
                            status: 200,
                            reason: "OK",
                            headers: vec![],
                            body: json!({
                                "jsonrpc": "2.0",
                                "id": id,
                                "result": {
                                    "tools": [
                                        { "name": "echo_tool", "description": "Echoes text" }
                                    ],
                                    "nextCursor": "page-2"
                                }
                            }),
                        }
                    }
                }
                "tools/call" => {
                    let tool = req
                        .body
                        .pointer("/params/name")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    let msg = req
                        .body
                        .pointer("/params/arguments/message")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    MockHttpReply::Json {
                        status: 200,
                        reason: "OK",
                        headers: vec![],
                        body: json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": {
                                "content": [
                                    { "type": "text", "text": format!("{tool}:{msg}") }
                                ],
                                "isError": false
                            }
                        }),
                    }
                }
                other => MockHttpReply::Json {
                    status: 400,
                    reason: "Bad Request",
                    headers: vec![],
                    body: json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "error": { "code": -32601, "message": format!("Unknown method: {other}") }
                    }),
                },
            }
        })
        .await;

        // Unauthorized client fails cleanly with 401
        let unauth = NativeMcpClient::connect_http(&base_url, Some("wrong-token".to_string()));
        let err = unauth.initialize().await.unwrap_err();
        assert!(err.contains("401"), "expected 401 error, got: {err}");

        // Authorized client connects using origin URL (auto-normalized to /mcp)
        let client = NativeMcpClient::connect_http(&base_url, Some(expected_token.to_string()));
        let init = client.initialize().await.expect("initialize succeeds");
        assert_eq!(init["serverInfo"]["name"], "mock-http-mcp");

        let tools = client.list_tools().await.expect("list_tools succeeds");
        assert_eq!(tools.len(), 2);
        assert_eq!(tools[0]["name"], "echo_tool");
        assert_eq!(tools[1]["name"], "second_tool");

        let output = client
            .call_tool("echo_tool", json!({ "message": "hello-mcp" }))
            .await
            .expect("call_tool succeeds");
        assert_eq!(output, "echo_tool:hello-mcp");

        // Verify recorded HTTP headers & paths
        let log = recorded.lock().unwrap();
        let authed_reqs: Vec<&RecordedHttpRequest> = log
            .iter()
            .filter(|r| r.headers.get("authorization").map(String::as_str) == Some("Bearer secret-hub-token-3c"))
            .collect();
        assert!(authed_reqs.len() >= 4);
        for req in &authed_reqs {
            assert_eq!(req.method, "POST");
            assert_eq!(req.path, "/mcp");
            assert_eq!(
                req.headers.get("content-type").map(String::as_str),
                Some("application/json")
            );
            let accept = req.headers.get("accept").map(String::as_str).unwrap_or("");
            assert!(accept.contains("application/json"), "accept={accept}");
            assert!(accept.contains("text/event-stream"), "accept={accept}");
        }
        assert!(authed_reqs
            .iter()
            .skip(1)
            .all(|r| r.headers.get("mcp-session-id").map(String::as_str) == Some("sess-unit-3c")));
    }

    #[tokio::test]
    async fn parses_incremental_sse_responses_with_comments_notifications_and_multiline_data() {
        let (base_url, _) = spawn_mock_mcp_server(|req| {
            let method = req.body.get("method").and_then(Value::as_str).unwrap_or("");
            let id = req.body.get("id").cloned().unwrap_or(Value::Null);
            match method {
                "tools/list" => MockHttpReply::SseStream {
                    chunks: vec![(
                        0,
                        format!(
                            "event: message\ndata: {}\n\n",
                            json!({
                                "jsonrpc": "2.0",
                                "id": id,
                                "result": {
                                    "tools": [{ "name": "sse_tool" }]
                                }
                            })
                        ),
                    )],
                    hold_open_ms: 0,
                },
                "tools/call" => {
                    let id_json = serde_json::to_string(&id).unwrap();
                    MockHttpReply::SseStream {
                        chunks: vec![
                            (0, ": keepalive comment\n\n".to_string()),
                            (
                                5,
                                "event: message\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\",\"params\":{\"progress\":40}}\n\n"
                                    .to_string(),
                            ),
                            (
                                10,
                                format!("event: message\ndata: {{\"jsonrpc\":\"2.0\",\"id\":{id_json},\n"),
                            ),
                            (
                                10,
                                "data: \"result\":{\"content\":[{\"type\":\"text\",\"text\":\"sse-multiline-ok\"}]}}\n\n"
                                    .to_string(),
                            ),
                        ],
                        // Keep socket open 3s after emitting the matched frame to prove streaming returns immediately
                        hold_open_ms: 3000,
                    }
                }
                _ => MockHttpReply::Empty {
                    status: 202,
                    reason: "Accepted",
                },
            }
        })
        .await;

        let client = NativeMcpClient::connect_http(format!("{base_url}/mcp"), None);
        let tools = client.list_tools().await.expect("SSE tools/list");
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["name"], "sse_tool");

        let started = std::time::Instant::now();
        let output = client
            .call_tool("sse_tool", json!({ "k": "v" }))
            .await
            .expect("SSE tools/call");
        assert_eq!(output, "sse-multiline-ok");
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "SSE client waited for stream close instead of returning on matched frame ({:?})",
            started.elapsed()
        );
    }

    #[tokio::test]
    async fn compresses_large_http_mcp_tool_responses_via_kite_ctx() {
        let rows: Vec<Value> = (0..90)
            .map(|idx| {
                json!({
                    "id": idx,
                    "status": "ok",
                    "workspace": "kite-desktop",
                    "detail": format!("diagnostic telemetry item number {idx} from mcp server")
                })
            })
            .collect();
        let big_payload = serde_json::to_string_pretty(&rows).unwrap();
        assert!(big_payload.len() > 4096);
        let expected_raw_len = big_payload.len();

        let (base_url, _) = spawn_mock_mcp_server(move |req| {
            let id = req.body.get("id").cloned().unwrap_or(Value::Null);
            MockHttpReply::Json {
                status: 200,
                reason: "OK",
                headers: vec![],
                body: json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "content": [
                            { "type": "text", "text": &big_payload }
                        ]
                    }
                }),
            }
        })
        .await;

        let client = NativeMcpClient::connect_http(format!("{base_url}/mcp"), None);
        let compressed = client
            .call_tool("big_query", json!({}))
            .await
            .expect("large call_tool succeeds");
        assert!(
            compressed.len() < expected_raw_len,
            "expected compressed length < {expected_raw_len}, got {}",
            compressed.len()
        );
        assert!(
            compressed.contains("<<ccr:") || compressed.len() < expected_raw_len / 2,
            "expected kite-ctx compression/CCR marker in output: len={}",
            compressed.len()
        );
    }

    #[tokio::test]
    async fn surfaces_mcp_is_error_and_jsonrpc_errors() {
        let (base_url, _) = spawn_mock_mcp_server(|req| {
            let id = req.body.get("id").cloned().unwrap_or(Value::Null);
            let tool = req
                .body
                .pointer("/params/name")
                .and_then(Value::as_str)
                .unwrap_or("");
            if tool == "soft_fail" {
                MockHttpReply::Json {
                    status: 200,
                    reason: "OK",
                    headers: vec![],
                    body: json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": {
                            "isError": true,
                            "content": [{ "type": "text", "text": "tool rejected input" }]
                        }
                    }),
                }
            } else {
                MockHttpReply::Json {
                    status: 200,
                    reason: "OK",
                    headers: vec![],
                    body: json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "error": { "code": -32601, "message": "Unknown tool" }
                    }),
                }
            }
        })
        .await;

        let client = NativeMcpClient::connect_http(format!("{base_url}/mcp"), None);
        let soft_err = client.call_tool("soft_fail", json!({})).await.unwrap_err();
        assert_eq!(soft_err, "tool rejected input");

        let rpc_err = client.call_tool("missing_tool", json!({})).await.unwrap_err();
        assert!(rpc_err.contains("-32601"), "rpc_err={rpc_err}");
        assert!(rpc_err.contains("Unknown tool"), "rpc_err={rpc_err}");
    }

    #[tokio::test]
    async fn discovers_hub_from_mcp_hub_json_and_normalizes_urls() {
        assert_eq!(
            normalize_mcp_endpoint_url("http://127.0.0.1:4567"),
            "http://127.0.0.1:4567/mcp"
        );
        assert_eq!(
            normalize_mcp_endpoint_url("http://127.0.0.1:4567/"),
            "http://127.0.0.1:4567/mcp"
        );
        assert_eq!(
            normalize_mcp_endpoint_url("http://127.0.0.1:4567/mcp"),
            "http://127.0.0.1:4567/mcp"
        );
        assert_eq!(
            normalize_mcp_endpoint_url("http://127.0.0.1:4567/mcp/pool/engram"),
            "http://127.0.0.1:4567/mcp/pool/engram"
        );
        assert_eq!(
            server_label_from_url("http://127.0.0.1:4567/mcp/pool/engram"),
            "engram"
        );

        let token = "discovered-file-token";
        let (base_url, _) = spawn_mock_mcp_server(move |req| {
            let auth = req.headers.get("authorization").cloned().unwrap_or_default();
            let id = req.body.get("id").cloned().unwrap_or(Value::Null);
            if auth != format!("Bearer {token}") {
                return MockHttpReply::Json {
                    status: 401,
                    reason: "Unauthorized",
                    headers: vec![],
                    body: json!({ "error": "unauthorized" }),
                };
            }
            MockHttpReply::Json {
                status: 200,
                reason: "OK",
                headers: vec![],
                body: json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "protocolVersion": "2024-11-05",
                        "serverInfo": { "name": "discovered-hub" }
                    }
                }),
            }
        })
        .await;

        let temp_dir = std::env::temp_dir().join(format!(
            "kite-mcp-client-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let hub_file = temp_dir.join("mcp-hub.json");
        std::fs::write(
            &hub_file,
            serde_json::to_vec(&json!({
                "url": base_url,
                "token": token,
                "pid": 999999
            }))
            .unwrap(),
        )
        .unwrap();

        let client = NativeMcpClient::from_hub_file(&hub_file).expect("hub file discovery");
        let init = client.initialize().await.expect("discovered hub init");
        assert_eq!(init["serverInfo"]["name"], "discovered-hub");

        let empty_name_err = client.call_tool("   ", json!({})).await.unwrap_err();
        assert!(empty_name_err.contains("cannot be empty"));

        let missing_err = NativeMcpClient::from_hub_file(&temp_dir.join("missing.json")).unwrap_err();
        assert!(missing_err.contains("Failed to read"));

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn pooled_stdio_tool_reuses_upstream_and_compresses_large_results() {
        let metrics = Arc::new(MockUpstreamMetrics::default());
        let hub = SharedStdioMcpHub::with_spawner(make_mock_spawner(Arc::clone(&metrics), 0));
        hub.register_server("mock", "mock-mcp", &[], &[]);

        let out1 = call_pooled_stdio_tool_on_hub(
            &hub,
            "mock",
            "mock_echo",
            json!({ "tag": "unit-3c-1" }),
        )
        .expect("first pooled stdio call succeeds");
        assert_eq!(out1, "echo:unit-3c-1");

        let out2 = call_pooled_stdio_tool_on_hub(
            &hub,
            "mock",
            "mock_echo",
            json!({ "tag": "unit-3c-2" }),
        )
        .expect("second pooled stdio call succeeds");
        assert_eq!(out2, "echo:unit-3c-2");

        // Upstream was spawned and initialized once, then reused across calls
        assert_eq!(metrics.spawn_count.load(Ordering::SeqCst), 1);
        assert_eq!(metrics.initialize_count.load(Ordering::SeqCst), 1);
        assert_eq!(metrics.tool_call_count.load(Ordering::SeqCst), 2);

        // Large payload (> 4096 bytes) is compressed via kite-ctx
        let big_out = call_pooled_stdio_tool_on_hub(
            &hub,
            "mock",
            "mock_echo",
            json!({ "big_rows": 120 }),
        )
        .expect("large pooled stdio call succeeds");
        assert!(
            big_out.contains("<<ccr:") || big_out.len() < 4096,
            "expected large pooled stdio response to be compressed, len={}",
            big_out.len()
        );

        // Global hub call for unregistered server and empty inputs fail cleanly
        assert!(call_pooled_stdio_tool("", "mock_echo", json!({})).is_err());
        assert!(call_pooled_stdio_tool("mock", "", json!({})).is_err());
        let global_err = call_pooled_stdio_tool(
            "definitely-unregistered-3c-server",
            "mock_echo",
            json!({}),
        )
        .unwrap_err();
        assert!(
            global_err.contains("not registered"),
            "unexpected global hub error: {global_err}"
        );
    }

    #[tokio::test]
    async fn http_raw_helpers_preserve_tool_meta_read_resources_and_return_raw_call_result() {
        let (base_url, recorded) = spawn_mock_mcp_server(|req| {
            let method = req.body.get("method").and_then(Value::as_str).unwrap_or("");
            let id = req.body.get("id").cloned().unwrap_or(Value::Null);
            let header_val = req.headers.get("x-plugin-key").cloned().unwrap_or_default();
            if header_val != "custom-secret" {
                return MockHttpReply::Json {
                    status: 403,
                    reason: "Forbidden",
                    headers: vec![],
                    body: json!({ "error": { "code": -32000, "message": "missing plugin key" } }),
                };
            }
            match method {
                "tools/list" => MockHttpReply::Json {
                    status: 200,
                    reason: "OK",
                    headers: vec![],
                    body: json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": {
                            "tools": [{
                                "name": "render_chart",
                                "description": "Renders interactive chart",
                                "_meta": {
                                    "ui": {
                                        "resourceUri": "ui://charts/main.html",
                                        "visibility": ["model", "app"]
                                    }
                                }
                            }]
                        }
                    }),
                },
                "resources/read" => {
                    let uri = req.body.pointer("/params/uri").and_then(Value::as_str).unwrap_or("");
                    MockHttpReply::Json {
                        status: 200,
                        reason: "OK",
                        headers: vec![],
                        body: json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": {
                                "contents": [{
                                    "uri": uri,
                                    "mimeType": "text/html;profile=mcp-app",
                                    "text": "<!doctype html><html><body>Chart</body></html>"
                                }]
                            }
                        }),
                    }
                }
                "tools/call" => MockHttpReply::Json {
                    status: 200,
                    reason: "OK",
                    headers: vec![],
                    body: json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": {
                            "content": [{ "type": "text", "text": "raw-ok" }],
                            "structuredContent": { "series": [1, 2, 3] },
                            "isError": false
                        }
                    }),
                },
                _ => MockHttpReply::Empty {
                    status: 202,
                    reason: "Accepted",
                },
            }
        })
        .await;

        let headers = std::collections::BTreeMap::from([(
            "X-Plugin-Key".to_string(),
            "custom-secret".to_string(),
        )]);
        let client = NativeMcpClient::connect_http_with_headers(format!("{base_url}/mcp"), &headers);

        let tools = client.list_tools_raw().await.expect("list_tools_raw succeeds");
        assert_eq!(tools.len(), 1);
        assert_eq!(
            tools[0].pointer("/_meta/ui/resourceUri").and_then(Value::as_str),
            Some("ui://charts/main.html")
        );

        let res = client
            .read_resource("ui://charts/main.html")
            .await
            .expect("read_resource succeeds");
        assert_eq!(
            res.pointer("/contents/0/mimeType").and_then(Value::as_str),
            Some("text/html;profile=mcp-app")
        );
        assert!(client.read_resource("   ").await.is_err());

        let raw_call = client
            .call_tool_raw("render_chart", json!({ "limit": 5 }))
            .await
            .expect("call_tool_raw succeeds");
        assert_eq!(raw_call["structuredContent"]["series"], json!([1, 2, 3]));
        assert_eq!(raw_call["content"][0]["text"], "raw-ok");

        let reqs = recorded.lock().unwrap();
        assert_eq!(reqs.len(), 3);
    }

    #[test]
    fn pooled_stdio_raw_helpers_list_read_and_call_via_shared_hub() {
        let metrics = Arc::new(MockUpstreamMetrics::default());
        let hub = SharedStdioMcpHub::with_spawner(make_mock_spawner(Arc::clone(&metrics), 0));
        hub.register_server("mock", "mock-mcp", &[], &[]);

        let tools = list_pooled_stdio_tools_raw_on_hub(&hub, "mock").expect("list tools raw");
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["name"], "mock_echo");

        let raw = call_pooled_stdio_tool_raw_on_hub(&hub, "mock", "mock_echo", json!({ "tag": "raw" }))
            .expect("call tool raw");
        assert_eq!(raw["content"][0]["text"], "echo:raw");

        // Upstream does not implement resources/read in mock_spawner -> surfaces JSON-RPC error cleanly
        let res_err = read_pooled_stdio_resource_on_hub(&hub, "mock", "ui://mock/app").unwrap_err();
        assert!(res_err.contains("-32601"), "unexpected error: {res_err}");
        assert!(read_pooled_stdio_resource_on_hub(&hub, "mock", "  ").is_err());
        assert!(call_pooled_stdio_tool_raw_on_hub(&hub, "mock", " ", json!({})).is_err());
    }
}
