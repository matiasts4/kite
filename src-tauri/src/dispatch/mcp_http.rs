//! Centralized Loopback MCP HTTP/1.1 Hub (`S4`).
//!
//! Binds strictly to `127.0.0.1:0`, authenticates `POST /mcp` and
//! `POST /mcp/pool/<server_name>` with a 256-bit bearer token persisted to
//! `roaming_app_dir().join("mcp-hub.json")`, serves `GET /health`, routes
//! `POST /mcp` directly to `dispatch::mcp::handle_jsonrpc_message`, and
//! multiplexes `POST /mcp/pool/<server_name>` through [`SharedStdioMcpHub`].

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;

use super::mcp_hub::{
    global_stdio_mcp_hub, McpHubError, SharedStdioMcpHub, DEFAULT_MCP_REQUEST_TIMEOUT,
};

const MAX_HEADER_BYTES: usize = 64 * 1024;
const MAX_BODY_BYTES: usize = 16 * 1024 * 1024;
const HEADER_READ_IDLE_TIMEOUT: Duration = Duration::from_secs(30);
const BODY_READ_TIMEOUT: Duration = Duration::from_secs(30);
const HTTP_HUB_TOKIO_WORKERS: usize = 2;
const HTTP_HUB_TOKIO_MAX_BLOCKING: usize = 8;

/// Returns `true` unless `KITE_MCP_HTTP_HUB` is explicitly set to `"0"`.
pub fn mcp_hub_enabled_from_env() -> bool {
    std::env::var("KITE_MCP_HTTP_HUB").ok().as_deref() != Some("0")
}

/// Path to the persisted loopback MCP HTTP Hub discovery file (`mcp-hub.json`).
pub fn mcp_hub_endpoint_path() -> PathBuf {
    crate::persist::roaming_app_dir().join("mcp-hub.json")
}

fn generate_bearer_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (&x, &y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn bearer_authorized(headers: &HashMap<String, String>, expected_token: &str) -> bool {
    let Some(auth) = headers.get("authorization") else {
        return false;
    };
    let trimmed = auth.trim();
    let mut parts = trimmed.splitn(2, char::is_whitespace);
    let scheme = parts.next().unwrap_or("");
    let presented = parts.next().unwrap_or("").trim();
    if !scheme.eq_ignore_ascii_case("bearer") || presented.is_empty() {
        return false;
    }
    constant_time_eq(presented.as_bytes(), expected_token.as_bytes())
}

fn write_hub_endpoint_file(path: &Path, port: u16, token: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let payload = json!({
        "url": format!("http://127.0.0.1:{port}"),
        "token": token,
        "pid": std::process::id(),
    });
    let bytes = serde_json::to_vec_pretty(&payload).unwrap_or_default();
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, &bytes).is_ok() {
        if std::fs::rename(&tmp, path).is_ok() {
            return Ok(());
        }
        let _ = std::fs::remove_file(&tmp);
    }
    std::fs::write(path, bytes)
}

#[derive(Clone)]
enum HubBackend {
    Global,
    Custom(Arc<SharedStdioMcpHub>),
}

impl HubBackend {
    fn as_ref(&self) -> &SharedStdioMcpHub {
        match self {
            Self::Global => global_stdio_mcp_hub(),
            Self::Custom(hub) => hub.as_ref(),
        }
    }
}

#[derive(Clone)]
struct ServerState {
    port: u16,
    token: String,
    hub: HubBackend,
    request_count: Arc<AtomicUsize>,
    next_conn_id: Arc<AtomicU64>,
}

struct GlobalHttpHubState {
    running: bool,
    port: u16,
    token: String,
    request_count: Arc<AtomicUsize>,
    shutdown_tx: watch::Sender<bool>,
}

static HUB_STATE: OnceLock<Mutex<Option<GlobalHttpHubState>>> = OnceLock::new();

fn hub_state_lock() -> &'static Mutex<Option<GlobalHttpHubState>> {
    HUB_STATE.get_or_init(|| Mutex::new(None))
}

/// Starts the centralized loopback MCP HTTP Hub in the background (idempotent).
///
/// Binds strictly to `127.0.0.1:0`, writes `mcp-hub.json`, and returns `(port, token)`.
pub fn start_mcp_http_hub_background() -> Option<(u16, String)> {
    if !mcp_hub_enabled_from_env() {
        return None;
    }
    let mut guard = hub_state_lock().lock().unwrap_or_else(|p| p.into_inner());
    if let Some(existing) = guard.as_ref().filter(|s| s.running) {
        return Some((existing.port, existing.token.clone()));
    }

    let std_listener = std::net::TcpListener::bind("127.0.0.1:0").ok()?;
    let port = std_listener.local_addr().ok()?.port();
    if std_listener.set_nonblocking(true).is_err() {
        return None;
    }

    let token = generate_bearer_token();
    let endpoint_path = mcp_hub_endpoint_path();
    if write_hub_endpoint_file(&endpoint_path, port, &token).is_err() {
        return None;
    }

    let request_count = Arc::new(AtomicUsize::new(0));
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let server_state = ServerState {
        port,
        token: token.clone(),
        hub: HubBackend::Global,
        request_count: Arc::clone(&request_count),
        next_conn_id: Arc::new(AtomicU64::new(1)),
    };

    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        handle.spawn(async move {
            match TcpListener::from_std(std_listener) {
                Ok(listener) => run_accept_loop(listener, server_state, shutdown_rx).await,
                Err(err) => {
                    crate::logger::log_trace(&format!("mcp_http: TcpListener::from_std failed: {err}"));
                }
            }
        });
    } else {
        let spawned = std::thread::Builder::new()
            .name("kite-mcp-http-hub".to_string())
            .spawn(move || {
                let Ok(rt) = tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(HTTP_HUB_TOKIO_WORKERS)
                    .max_blocking_threads(HTTP_HUB_TOKIO_MAX_BLOCKING)
                    .enable_all()
                    .build()
                else {
                    return;
                };
                rt.block_on(async move {
                    match TcpListener::from_std(std_listener) {
                        Ok(listener) => run_accept_loop(listener, server_state, shutdown_rx).await,
                        Err(err) => {
                            crate::logger::log_trace(&format!(
                                "mcp_http: TcpListener::from_std failed: {err}"
                            ));
                        }
                    }
                });
            });
        if spawned.is_err() {
            return None;
        }
    }

    *guard = Some(GlobalHttpHubState {
        running: true,
        port,
        token: token.clone(),
        request_count,
        shutdown_tx,
    });

    Some((port, token))
}

/// Returns `(port, bearer_token)` if the global MCP HTTP Hub is currently running.
pub fn current_mcp_hub_info() -> Option<(u16, String)> {
    let guard = hub_state_lock().lock().unwrap_or_else(|p| p.into_inner());
    guard
        .as_ref()
        .filter(|s| s.running)
        .map(|s| (s.port, s.token.clone()))
}

/// Returns `(running, port, request_count)` for observability and health checks.
pub fn mcp_http_hub_stats() -> (bool, Option<u16>, usize) {
    let guard = hub_state_lock().lock().unwrap_or_else(|p| p.into_inner());
    match guard.as_ref() {
        Some(s) if s.running => (true, Some(s.port), s.request_count.load(Ordering::Relaxed)),
        _ => (false, None, 0),
    }
}

/// Shuts down the global MCP HTTP Hub listener and removes `mcp-hub.json` if owned by this PID.
pub fn shutdown_mcp_http_hub() {
    let state = {
        let mut guard = hub_state_lock().lock().unwrap_or_else(|p| p.into_inner());
        guard.take()
    };
    if let Some(s) = state {
        let _ = s.shutdown_tx.send(true);
    }
    let path = mcp_hub_endpoint_path();
    let remove_allowed = match std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
    {
        Some(file) => match file.get("pid").and_then(Value::as_u64) {
            Some(pid) => pid == u64::from(std::process::id()),
            None => true,
        },
        None => false,
    };
    if remove_allowed {
        let _ = std::fs::remove_file(path);
    }
}

async fn run_accept_loop(
    listener: TcpListener,
    state: ServerState,
    mut shutdown_rx: watch::Receiver<bool>,
) {
    loop {
        tokio::select! {
            _ = shutdown_rx.changed() => {
                if *shutdown_rx.borrow() {
                    break;
                }
            }
            accepted = listener.accept() => {
                match accepted {
                    Ok((stream, _peer)) => {
                        let _ = stream.set_nodelay(true);
                        let conn_state = state.clone();
                        let conn_shutdown = shutdown_rx.clone();
                        let conn_id = conn_state.next_conn_id.fetch_add(1, Ordering::Relaxed);
                        tokio::spawn(async move {
                            handle_connection(stream, conn_state, conn_id, conn_shutdown).await;
                        });
                    }
                    Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
        }
    }
}

struct ParsedHttpRequest {
    method: String,
    target: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
    keep_alive: bool,
}

enum HttpReadError {
    BadRequest(&'static str),
    HeadersTooLarge,
    PayloadTooLarge,
    Io,
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

async fn read_more_with_timeout(
    stream: &mut TcpStream,
    carry: &mut Vec<u8>,
    timeout: Duration,
) -> Result<usize, HttpReadError> {
    let mut chunk = [0u8; 4096];
    match tokio::time::timeout(timeout, stream.read(&mut chunk)).await {
        Ok(Ok(0)) => Ok(0),
        Ok(Ok(n)) => {
            carry.extend_from_slice(&chunk[..n]);
            Ok(n)
        }
        Ok(Err(_)) | Err(_) => Err(HttpReadError::Io),
    }
}

async fn read_chunked_body(
    stream: &mut TcpStream,
    carry: &mut Vec<u8>,
) -> Result<Vec<u8>, HttpReadError> {
    let mut out = Vec::new();
    loop {
        let line_end = loop {
            if let Some(pos) = carry.windows(2).position(|w| w == b"\r\n") {
                break pos;
            }
            if carry.len() > MAX_HEADER_BYTES {
                return Err(HttpReadError::BadRequest("chunk header too large"));
            }
            if read_more_with_timeout(stream, carry, BODY_READ_TIMEOUT).await? == 0 {
                return Err(HttpReadError::BadRequest("unexpected EOF in chunk header"));
            }
        };
        let size_line = String::from_utf8_lossy(&carry[..line_end]).to_string();
        carry.drain(..line_end + 2);
        let hex_part = size_line.split(';').next().unwrap_or("").trim();
        let chunk_size = usize::from_str_radix(hex_part, 16)
            .map_err(|_| HttpReadError::BadRequest("invalid chunk size"))?;
        if out.len().saturating_add(chunk_size) > MAX_BODY_BYTES {
            return Err(HttpReadError::PayloadTooLarge);
        }
        if chunk_size == 0 {
            // Consume trailing CRLF (or trailer lines ending in CRLFCRLF)
            loop {
                if carry.starts_with(b"\r\n") {
                    carry.drain(..2);
                    break;
                }
                if let Some(pos) = carry.windows(4).position(|w| w == b"\r\n\r\n") {
                    carry.drain(..pos + 4);
                    break;
                }
                if carry.len() > MAX_HEADER_BYTES {
                    return Err(HttpReadError::BadRequest("chunk trailer too large"));
                }
                if read_more_with_timeout(stream, carry, BODY_READ_TIMEOUT).await? == 0 {
                    break;
                }
            }
            break;
        }
        while carry.len() < chunk_size + 2 {
            if read_more_with_timeout(stream, carry, BODY_READ_TIMEOUT).await? == 0 {
                return Err(HttpReadError::BadRequest("unexpected EOF in chunk payload"));
            }
        }
        out.extend_from_slice(&carry[..chunk_size]);
        if &carry[chunk_size..chunk_size + 2] != b"\r\n" {
            return Err(HttpReadError::BadRequest("missing CRLF after chunk"));
        }
        carry.drain(..chunk_size + 2);
    }
    Ok(out)
}

async fn read_http_request(
    stream: &mut TcpStream,
    carry: &mut Vec<u8>,
) -> Result<Option<ParsedHttpRequest>, HttpReadError> {
    let (hdr_end, sep_len) = loop {
        if let Some(found) = find_header_end(carry) {
            break found;
        }
        if carry.len() > MAX_HEADER_BYTES {
            return Err(HttpReadError::HeadersTooLarge);
        }
        let timeout = if carry.is_empty() {
            HEADER_READ_IDLE_TIMEOUT
        } else {
            BODY_READ_TIMEOUT
        };
        let n = match read_more_with_timeout(stream, carry, timeout).await {
            Ok(n) => n,
            Err(_) if carry.is_empty() => return Ok(None),
            Err(err) => return Err(err),
        };
        if n == 0 {
            if carry.is_empty() {
                return Ok(None);
            }
            return Err(HttpReadError::BadRequest("incomplete HTTP headers"));
        }
    };

    let header_raw = String::from_utf8_lossy(&carry[..hdr_end]).to_string();
    carry.drain(..hdr_end + sep_len);

    let mut lines = header_raw.lines();
    let request_line = lines
        .next()
        .ok_or(HttpReadError::BadRequest("empty HTTP request line"))?
        .trim_end_matches('\r');
    let mut req_parts = request_line.split_whitespace();
    let method = req_parts
        .next()
        .ok_or(HttpReadError::BadRequest("missing HTTP method"))?
        .to_ascii_uppercase();
    let target = req_parts
        .next()
        .ok_or(HttpReadError::BadRequest("missing HTTP target"))?
        .to_string();
    let version = req_parts.next().unwrap_or("HTTP/1.1");

    let mut headers = HashMap::new();
    for line in lines {
        let trimmed = line.trim_end_matches('\r');
        if trimmed.is_empty() {
            continue;
        }
        if let Some((name, val)) = trimmed.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), val.trim().to_string());
        }
    }

    if headers
        .get("expect")
        .is_some_and(|v| v.eq_ignore_ascii_case("100-continue"))
    {
        if stream.write_all(b"HTTP/1.1 100 Continue\r\n\r\n").await.is_err() {
            return Err(HttpReadError::Io);
        }
    }

    let is_chunked = headers
        .get("transfer-encoding")
        .is_some_and(|v| v.to_ascii_lowercase().contains("chunked"));

    let body = if is_chunked {
        read_chunked_body(stream, carry).await?
    } else if let Some(raw_len) = headers.get("content-length") {
        let len = raw_len
            .trim()
            .parse::<usize>()
            .map_err(|_| HttpReadError::BadRequest("invalid Content-Length"))?;
        if len > MAX_BODY_BYTES {
            return Err(HttpReadError::PayloadTooLarge);
        }
        while carry.len() < len {
            if read_more_with_timeout(stream, carry, BODY_READ_TIMEOUT).await? == 0 {
                return Err(HttpReadError::BadRequest("unexpected EOF before Content-Length"));
            }
        }
        carry.drain(..len).collect()
    } else {
        Vec::new()
    };

    let conn_hdr = headers
        .get("connection")
        .map(|v| v.to_ascii_lowercase())
        .unwrap_or_default();
    let keep_alive = if version.eq_ignore_ascii_case("HTTP/1.0") {
        conn_hdr.contains("keep-alive")
    } else {
        !conn_hdr.contains("close")
    };

    Ok(Some(ParsedHttpRequest {
        method,
        target,
        headers,
        body,
        keep_alive,
    }))
}

async fn write_http_response(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    extra_headers: &[(&str, &str)],
    content_type: Option<&str>,
    body: &[u8],
    keep_alive: bool,
) -> std::io::Result<()> {
    let mut head = format!("HTTP/1.1 {status} {reason}\r\n");
    if let Some(ct) = content_type {
        head.push_str(&format!("Content-Type: {ct}\r\n"));
    }
    for (k, v) in extra_headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str(&format!(
        "Content-Length: {}\r\nConnection: {}\r\nCache-Control: no-store\r\n\r\n",
        body.len(),
        if keep_alive { "keep-alive" } else { "close" }
    ));
    stream.write_all(head.as_bytes()).await?;
    if !body.is_empty() {
        stream.write_all(body).await?;
    }
    stream.flush().await
}

async fn write_json_response(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    extra_headers: &[(&str, &str)],
    payload: &Value,
    keep_alive: bool,
) -> std::io::Result<()> {
    let body = serde_json::to_vec(payload).unwrap_or_else(|_| b"{}".to_vec());
    write_http_response(
        stream,
        status,
        reason,
        extra_headers,
        Some("application/json"),
        &body,
        keep_alive,
    )
    .await
}

async fn handle_connection(
    mut stream: TcpStream,
    state: ServerState,
    conn_id: u64,
    shutdown_rx: watch::Receiver<bool>,
) {
    let mut carry = Vec::with_capacity(4096);
    loop {
        if *shutdown_rx.borrow() {
            break;
        }
        let req = match read_http_request(&mut stream, &mut carry).await {
            Ok(Some(req)) => req,
            Ok(None) => break,
            Err(HttpReadError::HeadersTooLarge) => {
                let _ = write_json_response(
                    &mut stream,
                    431,
                    "Request Header Fields Too Large",
                    &[],
                    &json!({ "error": "headers_too_large" }),
                    false,
                )
                .await;
                break;
            }
            Err(HttpReadError::PayloadTooLarge) => {
                let _ = write_json_response(
                    &mut stream,
                    413,
                    "Payload Too Large",
                    &[],
                    &json!({ "error": "payload_too_large" }),
                    false,
                )
                .await;
                break;
            }
            Err(HttpReadError::BadRequest(msg)) => {
                let _ = write_json_response(
                    &mut stream,
                    400,
                    "Bad Request",
                    &[],
                    &json!({ "error": msg }),
                    false,
                )
                .await;
                break;
            }
            Err(HttpReadError::Io) => break,
        };

        state.request_count.fetch_add(1, Ordering::Relaxed);
        let keep_alive = req.keep_alive;
        if dispatch_http_request(&mut stream, &state, conn_id, req)
            .await
            .is_err()
        {
            break;
        }
        if !keep_alive {
            break;
        }
    }
}

async fn dispatch_http_request(
    stream: &mut TcpStream,
    state: &ServerState,
    conn_id: u64,
    req: ParsedHttpRequest,
) -> std::io::Result<()> {
    let path = req.target.split('?').next().unwrap_or(&req.target);
    let keep_alive = req.keep_alive;

    if path == "/health" {
        if req.method == "GET" {
            return write_json_response(
                stream,
                200,
                "OK",
                &[],
                &json!({ "ok": true, "port": state.port }),
                keep_alive,
            )
            .await;
        }
        return write_json_response(
            stream,
            405,
            "Method Not Allowed",
            &[("Allow", "GET")],
            &json!({ "error": "method_not_allowed" }),
            keep_alive,
        )
        .await;
    }

    if path == "/mcp" || path.starts_with("/mcp/") {
        if !bearer_authorized(&req.headers, &state.token) {
            return write_json_response(
                stream,
                401,
                "Unauthorized",
                &[("WWW-Authenticate", "Bearer")],
                &json!({ "error": "unauthorized" }),
                keep_alive,
            )
            .await;
        }
    } else {
        return write_json_response(
            stream,
            404,
            "Not Found",
            &[],
            &json!({ "error": "not_found" }),
            keep_alive,
        )
        .await;
    }

    if path == "/mcp" {
        if req.method != "POST" {
            return write_json_response(
                stream,
                405,
                "Method Not Allowed",
                &[("Allow", "POST")],
                &json!({ "error": "method_not_allowed" }),
                keep_alive,
            )
            .await;
        }
        let body: Value = match serde_json::from_slice(&req.body) {
            Ok(v) => v,
            Err(err) => {
                return write_json_response(
                    stream,
                    400,
                    "Bad Request",
                    &[],
                    &json!({
                        "jsonrpc": "2.0",
                        "id": Value::Null,
                        "error": { "code": -32700, "message": format!("Parse error: {err}") }
                    }),
                    keep_alive,
                )
                .await;
            }
        };

        let from_override = req
            .headers
            .get("x-kite-address")
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let result = tokio::task::spawn_blocking(move || {
            let options = crate::dispatch::cli_wire::LoopbackCallOptions {
                from_override: from_override.as_deref(),
                force_thread_mode: from_override.is_none(),
                force_multiplexed_daemon: from_override.is_none(),
            };
            let runner = |argv: &[String]| {
                crate::dispatch::cli_wire::execute_cli_captured_with_options(
                    argv,
                    options,
                    None,
                )
            };
            crate::dispatch::mcp::handle_jsonrpc_message(&body, &runner)
        })
        .await;

        return match result {
            Ok(Some(resp)) => {
                write_json_response(stream, 200, "OK", &[], &resp, keep_alive).await
            }
            Ok(None) => {
                write_http_response(stream, 202, "Accepted", &[], None, b"", keep_alive).await
            }
            Err(err) => {
                write_json_response(
                    stream,
                    500,
                    "Internal Server Error",
                    &[],
                    &json!({
                        "jsonrpc": "2.0",
                        "id": Value::Null,
                        "error": { "code": -32603, "message": format!("Internal error: {err}") }
                    }),
                    keep_alive,
                )
                .await
            }
        };
    }

    if let Some(server_name) = path.strip_prefix("/mcp/pool/") {
        if req.method != "POST" {
            return write_json_response(
                stream,
                405,
                "Method Not Allowed",
                &[("Allow", "POST")],
                &json!({ "error": "method_not_allowed" }),
                keep_alive,
            )
            .await;
        }
        if server_name.is_empty() || server_name.contains('/') {
            return write_json_response(
                stream,
                404,
                "Not Found",
                &[],
                &json!({ "error": "invalid_pool_server" }),
                keep_alive,
            )
            .await;
        }
        let body: Value = match serde_json::from_slice(&req.body) {
            Ok(v) => v,
            Err(err) => {
                return write_json_response(
                    stream,
                    400,
                    "Bad Request",
                    &[],
                    &json!({
                        "jsonrpc": "2.0",
                        "id": Value::Null,
                        "error": { "code": -32700, "message": format!("Parse error: {err}") }
                    }),
                    keep_alive,
                )
                .await;
            }
        };
        let orig_id = body.get("id").cloned().unwrap_or(Value::Null);
        let client_id = req
            .headers
            .get("mcp-session-id")
            .or_else(|| req.headers.get("x-kite-client-id"))
            .map(String::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("http-conn-{conn_id}"));

        return match state
            .hub
            .as_ref()
            .forward_jsonrpc(server_name, &client_id, &body, DEFAULT_MCP_REQUEST_TIMEOUT)
            .await
        {
            Ok(Some(resp)) => {
                write_json_response(stream, 200, "OK", &[], &resp, keep_alive).await
            }
            Ok(None) => {
                write_http_response(stream, 202, "Accepted", &[], None, b"", keep_alive).await
            }
            Err(McpHubError::ServerNotRegistered(msg)) => {
                write_json_response(
                    stream,
                    404,
                    "Not Found",
                    &[],
                    &json!({
                        "jsonrpc": "2.0",
                        "id": orig_id,
                        "error": { "code": -32001, "message": msg }
                    }),
                    keep_alive,
                )
                .await
            }
            Err(McpHubError::Timeout(msg)) => {
                write_json_response(
                    stream,
                    504,
                    "Gateway Timeout",
                    &[],
                    &json!({
                        "jsonrpc": "2.0",
                        "id": orig_id,
                        "error": { "code": -32002, "message": msg }
                    }),
                    keep_alive,
                )
                .await
            }
            Err(err) => {
                write_json_response(
                    stream,
                    502,
                    "Bad Gateway",
                    &[],
                    &json!({
                        "jsonrpc": "2.0",
                        "id": orig_id,
                        "error": { "code": -32000, "message": err.to_string() }
                    }),
                    keep_alive,
                )
                .await
            }
        };
    }

    write_json_response(
        stream,
        404,
        "Not Found",
        &[],
        &json!({ "error": "not_found" }),
        keep_alive,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch::mcp_hub::test_support::{make_mock_spawner, MockUpstreamMetrics};

    struct TestHttpServer {
        port: u16,
        token: String,
        request_count: Arc<AtomicUsize>,
        shutdown_tx: watch::Sender<bool>,
    }

    impl Drop for TestHttpServer {
        fn drop(&mut self) {
            let _ = self.shutdown_tx.send(true);
        }
    }

    async fn spawn_test_http_server(hub: Arc<SharedStdioMcpHub>) -> TestHttpServer {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let token = generate_bearer_token();
        let request_count = Arc::new(AtomicUsize::new(0));
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let state = ServerState {
            port,
            token: token.clone(),
            hub: HubBackend::Custom(hub),
            request_count: Arc::clone(&request_count),
            next_conn_id: Arc::new(AtomicU64::new(1)),
        };
        tokio::spawn(async move {
            run_accept_loop(listener, state, shutdown_rx).await;
        });
        TestHttpServer {
            port,
            token,
            request_count,
            shutdown_tx,
        }
    }

    async fn send_http_request(
        port: u16,
        method: &str,
        path: &str,
        headers: &[(&str, &str)],
        body: &[u8],
    ) -> (u16, Vec<u8>) {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let mut raw = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n");
        for (k, v) in headers {
            raw.push_str(&format!("{k}: {v}\r\n"));
        }
        raw.push_str(&format!(
            "Content-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        ));
        stream.write_all(raw.as_bytes()).await.unwrap();
        if !body.is_empty() {
            stream.write_all(body).await.unwrap();
        }
        stream.flush().await.unwrap();

        let mut resp_bytes = Vec::new();
        stream.read_to_end(&mut resp_bytes).await.unwrap();
        let (hdr_end, sep_len) = find_header_end(&resp_bytes).expect("http response headers");
        let hdr_text = String::from_utf8_lossy(&resp_bytes[..hdr_end]);
        let status = hdr_text
            .lines()
            .next()
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|s| s.parse::<u16>().ok())
            .expect("http status code");
        let body_out = resp_bytes[hdr_end + sep_len..].to_vec();
        (status, body_out)
    }

    static HUB_ENV_TEST_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn mcp_hub_enabled_from_env_defaults_true_and_respects_zero() {
        let _guard = HUB_ENV_TEST_LOCK.lock().unwrap();
        let prev = std::env::var_os("KITE_MCP_HTTP_HUB");

        std::env::remove_var("KITE_MCP_HTTP_HUB");
        assert!(mcp_hub_enabled_from_env());

        std::env::set_var("KITE_MCP_HTTP_HUB", "1");
        assert!(mcp_hub_enabled_from_env());

        std::env::set_var("KITE_MCP_HTTP_HUB", "0");
        assert!(!mcp_hub_enabled_from_env());

        match prev {
            Some(v) => std::env::set_var("KITE_MCP_HTTP_HUB", v),
            None => std::env::remove_var("KITE_MCP_HTTP_HUB"),
        }
    }

    #[tokio::test]
    async fn enforces_bearer_auth_serves_health_and_handles_direct_mcp_jsonrpc() {
        let hub = Arc::new(SharedStdioMcpHub::with_spawner(make_mock_spawner(
            Arc::new(MockUpstreamMetrics::default()),
            0,
        )));
        let srv = spawn_test_http_server(hub).await;

        // 1. GET /health succeeds without Bearer token
        let (status, body) = send_http_request(srv.port, "GET", "/health", &[], b"").await;
        assert_eq!(status, 200);
        let health: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(health["ok"], true);
        assert_eq!(health["port"], json!(srv.port));

        // 2. Missing or wrong Bearer token returns 401 Unauthorized on POST /mcp and /mcp/pool/mock
        let init_payload = serde_json::to_vec(&json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": { "protocolVersion": "2024-11-05" }
        }))
        .unwrap();
        let (unauth_status, _) = send_http_request(
            srv.port,
            "POST",
            "/mcp",
            &[("Content-Type", "application/json")],
            &init_payload,
        )
        .await;
        assert_eq!(unauth_status, 401);

        let (wrong_tok_status, _) = send_http_request(
            srv.port,
            "POST",
            "/mcp",
            &[
                ("Content-Type", "application/json"),
                ("Authorization", "Bearer wrong-token"),
            ],
            &init_payload,
        )
        .await;
        assert_eq!(wrong_tok_status, 401);

        let (pool_unauth_status, _) = send_http_request(
            srv.port,
            "POST",
            "/mcp/pool/mock",
            &[
                ("Content-Type", "application/json"),
                ("Authorization", "Bearer bad"),
            ],
            &init_payload,
        )
        .await;
        assert_eq!(pool_unauth_status, 401);

        // 3. Valid Bearer token serves POST /mcp initialize & tools/list
        let auth_hdr = format!("Bearer {}", srv.token);
        let (init_status, init_body) = send_http_request(
            srv.port,
            "POST",
            "/mcp",
            &[
                ("Content-Type", "application/json"),
                ("Authorization", &auth_hdr),
            ],
            &init_payload,
        )
        .await;
        assert_eq!(init_status, 200);
        let init_json: Value = serde_json::from_slice(&init_body).unwrap();
        assert_eq!(init_json["id"], 1);
        assert_eq!(init_json["result"]["serverInfo"]["name"], "kite-dispatch");

        let notif_payload = serde_json::to_vec(&json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized"
        }))
        .unwrap();
        let (notif_status, _) = send_http_request(
            srv.port,
            "POST",
            "/mcp",
            &[
                ("Content-Type", "application/json"),
                ("Authorization", &auth_hdr),
            ],
            &notif_payload,
        )
        .await;
        assert_eq!(notif_status, 202);

        let list_payload = serde_json::to_vec(&json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/list",
            "params": {}
        }))
        .unwrap();
        let (list_status, list_body) = send_http_request(
            srv.port,
            "POST",
            "/mcp",
            &[
                ("Content-Type", "application/json"),
                ("Authorization", &auth_hdr),
            ],
            &list_payload,
        )
        .await;
        assert_eq!(list_status, 200);
        let list_json: Value = serde_json::from_slice(&list_body).unwrap();
        assert_eq!(list_json["id"], 2);
        let tools = list_json["result"]["tools"].as_array().unwrap();
        assert!(tools.iter().any(|t| t["name"] == "kite_subagent_run"));
        assert!(srv.request_count.load(Ordering::Relaxed) >= 7);
    }

    #[tokio::test]
    async fn five_concurrent_http_clients_multiplex_over_pool_mock_to_one_upstream() {
        let metrics = Arc::new(MockUpstreamMetrics::default());
        let hub = Arc::new(SharedStdioMcpHub::with_spawner(make_mock_spawner(
            Arc::clone(&metrics),
            10,
        )));
        hub.register_server("mock", "mock-bin", &[], &[]);
        let srv = spawn_test_http_server(Arc::clone(&hub)).await;

        let tasks: Vec<_> = (0..5)
            .map(|idx| {
                let port = srv.port;
                let token = srv.token.clone();
                tokio::spawn(async move {
                    let auth = format!("Bearer {token}");
                    let client_hdr = format!("http-client-{idx}");

                    let list_req = serde_json::to_vec(&json!({
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": "tools/list",
                        "params": {}
                    }))
                    .unwrap();
                    let (list_status, list_body) = send_http_request(
                        port,
                        "POST",
                        "/mcp/pool/mock",
                        &[
                            ("Content-Type", "application/json"),
                            ("Authorization", &auth),
                            ("X-Kite-Client-Id", &client_hdr),
                        ],
                        &list_req,
                    )
                    .await;
                    assert_eq!(list_status, 200);
                    let list_json: Value = serde_json::from_slice(&list_body).unwrap();
                    assert_eq!(list_json["id"], 1);
                    assert_eq!(list_json["result"]["tools"][0]["name"], "mock_echo");

                    let call_req = serde_json::to_vec(&json!({
                        "jsonrpc": "2.0",
                        "id": 77,
                        "method": "tools/call",
                        "params": {
                            "name": "mock_echo",
                            "arguments": { "tag": format!("http-{idx}") }
                        }
                    }))
                    .unwrap();
                    let (call_status, call_body) = send_http_request(
                        port,
                        "POST",
                        "/mcp/pool/mock",
                        &[
                            ("Content-Type", "application/json"),
                            ("Authorization", &auth),
                            ("X-Kite-Client-Id", &client_hdr),
                        ],
                        &call_req,
                    )
                    .await;
                    assert_eq!(call_status, 200);
                    let call_json: Value = serde_json::from_slice(&call_body).unwrap();
                    assert_eq!(call_json["id"], 77);
                    assert_eq!(
                        call_json["result"]["content"][0]["text"],
                        format!("echo:http-{idx}")
                    );
                })
            })
            .collect();

        for task in tasks {
            task.await.expect("http client task succeeded");
        }

        assert_eq!(metrics.spawn_count.load(Ordering::SeqCst), 1);
        assert_eq!(metrics.tools_list_count.load(Ordering::SeqCst), 1);
        assert_eq!(metrics.tool_call_count.load(Ordering::SeqCst), 5);
        assert_eq!(hub.active_upstream_count(), 1);
    }

    #[test]
    fn background_hub_persists_mcp_hub_json_and_tracks_stats() {
        use std::io::{Read as _, Write as _};

        let _guard = HUB_ENV_TEST_LOCK.lock().unwrap();
        let prev = std::env::var_os("KITE_MCP_HTTP_HUB");
        std::env::remove_var("KITE_MCP_HTTP_HUB");

        let started = start_mcp_http_hub_background().expect("background hub should start");
        assert!(started.0 > 0);
        assert_eq!(started.1.len(), 64);
        assert_eq!(current_mcp_hub_info(), Some(started.clone()));

        // Calling start again is idempotent
        assert_eq!(start_mcp_http_hub_background(), Some(started.clone()));

        let persisted: Value =
            serde_json::from_slice(&std::fs::read(mcp_hub_endpoint_path()).unwrap()).unwrap();
        assert_eq!(persisted["url"], format!("http://127.0.0.1:{}", started.0));
        assert_eq!(persisted["token"], started.1);
        assert_eq!(persisted["pid"], json!(std::process::id()));

        // Real TCP GET /health against the spawned background server
        let mut sock = std::net::TcpStream::connect(("127.0.0.1", started.0)).unwrap();
        sock.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        sock.write_all(
            format!(
                "GET /health HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
                started.0
            )
            .as_bytes(),
        )
        .unwrap();
        let mut raw_resp = String::new();
        sock.read_to_string(&mut raw_resp).unwrap();
        assert!(raw_resp.starts_with("HTTP/1.1 200 OK"), "resp={raw_resp}");
        assert!(raw_resp.contains("\"ok\":true"), "resp={raw_resp}");

        let (running, port, count) = mcp_http_hub_stats();
        assert!(running);
        assert_eq!(port, Some(started.0));
        assert!(count >= 1, "expected request_count >= 1, got {count}");

        shutdown_mcp_http_hub();
        assert_eq!(current_mcp_hub_info(), None);
        assert_eq!(mcp_http_hub_stats(), (false, None, 0));
        assert!(!mcp_hub_endpoint_path().exists());

        if let Some(v) = prev {
            std::env::set_var("KITE_MCP_HTTP_HUB", v);
        }
    }
}
