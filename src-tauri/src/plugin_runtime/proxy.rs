//! Dedicated per-sidecar loopback HTTP/1.1 + WebSocket reverse proxy (`S5`).
//!
//! Each active UI sidecar gets its own ephemeral `127.0.0.1:<proxy_port>`
//! listener so root-relative assets and WebSocket endpoints (`/api/*`,
//! `/mirror/ws`) work natively at `/`. Requests are authenticated using a
//! per-sidecar 256-bit token (`?__kite_token=<token>` -> `HttpOnly;
//! SameSite=None; Secure; Partitioned` cookie + `302` for cross-site WebView2
//! iframes), upstream `Host`/`Origin`/`Referer` headers are rewritten to
//! `127.0.0.1:<upstream_port>`, framing restrictions (`X-Frame-Options`,
//! CSP `frame-ancestors`) are stripped, and WebSocket `101` upgrades are
//! tunneled bidirectionally.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;

const MAX_HEADER_BYTES: usize = 64 * 1024;
const MAX_CHUNK_LINE_BYTES: usize = 8 * 1024;
const HEADER_READ_TIMEOUT: Duration = Duration::from_secs(30);
const BODY_IO_TIMEOUT: Duration = Duration::from_secs(30);
const UPSTREAM_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const UPSTREAM_HEAD_TIMEOUT: Duration = Duration::from_secs(30);
const PROXY_TOKIO_WORKERS: usize = 2;
const PROXY_TOKIO_MAX_BLOCKING: usize = 16;

const AUTH_COOKIE_NAME: &str = "kite_sidecar_auth";
const TOKEN_QUERY_PARAM: &str = "__kite_token";

static PROXY_RUNTIME: OnceLock<Result<tokio::runtime::Runtime, String>> = OnceLock::new();
static GLOBAL_PROXY_POOL: OnceLock<SidecarProxyPool> = OnceLock::new();

fn proxy_runtime() -> Result<&'static tokio::runtime::Runtime, String> {
    PROXY_RUNTIME
        .get_or_init(|| {
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(PROXY_TOKIO_WORKERS)
                .max_blocking_threads(PROXY_TOKIO_MAX_BLOCKING)
                .thread_name("kite-sidecar-proxy")
                .enable_all()
                .build()
                .map_err(|err| format!("failed to build sidecar proxy Tokio runtime: {err}"))
        })
        .as_ref()
        .map_err(Clone::clone)
}

pub fn global_sidecar_proxy_pool() -> &'static SidecarProxyPool {
    GLOBAL_PROXY_POOL.get_or_init(SidecarProxyPool::new)
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyEndpoint {
    pub port: u16,
    pub token: String,
    pub proxy_url: String,
}

impl ProxyEndpoint {
    /// Builds the authenticated entry URL for an extension sidecar view path.
    pub fn entry_url(&self, view_path: &str) -> String {
        let trimmed = view_path.trim();
        let (raw_before_hash, hash_suffix) = match trimmed.find('#') {
            Some(idx) => (&trimmed[..idx], &trimmed[idx..]),
            None => (trimmed, ""),
        };

        let normalized = if raw_before_hash.is_empty() {
            "/".to_string()
        } else if raw_before_hash.starts_with('?') {
            format!("/{raw_before_hash}")
        } else if raw_before_hash.starts_with('/') {
            raw_before_hash.to_string()
        } else {
            format!("/{raw_before_hash}")
        };

        let clean_path = strip_query_param(&normalized, TOKEN_QUERY_PARAM);
        let sep = if !clean_path.contains('?') {
            "?"
        } else if clean_path.ends_with('?') || clean_path.ends_with('&') {
            ""
        } else {
            "&"
        };

        format!(
            "http://127.0.0.1:{}{}{}{}={}{}",
            self.port, clean_path, sep, TOKEN_QUERY_PARAM, self.token, hash_suffix
        )
    }
}

pub type UpstreamPortLookup = Arc<dyn Fn() -> Option<u16> + Send + Sync>;

struct ProxySlot {
    endpoint: ProxyEndpoint,
    port_lookup: Arc<RwLock<UpstreamPortLookup>>,
    shutdown_tx: watch::Sender<bool>,
    alive: Arc<AtomicBool>,
}

pub struct SidecarProxyPool {
    entries: Mutex<HashMap<String, ProxySlot>>,
    next_conn_id: Arc<AtomicU64>,
}

impl Default for SidecarProxyPool {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for SidecarProxyPool {
    fn drop(&mut self) {
        self.shutdown_all();
    }
}

impl SidecarProxyPool {
    pub fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            next_conn_id: Arc::new(AtomicU64::new(1)),
        }
    }

    /// Ensures a dedicated loopback proxy listener is bound and serving for `namespaced_id`.
    ///
    /// Reuses the existing endpoint (and updates `port_lookup`) if already active so an
    /// open UI frame keeps the same origin and auth cookie across sidecar restarts.
    pub fn ensure_proxy(
        &self,
        namespaced_id: &str,
        port_lookup: UpstreamPortLookup,
    ) -> Result<ProxyEndpoint, String> {
        let key = namespaced_id.trim();
        if key.is_empty() {
            return Err("namespaced_id must not be empty".to_string());
        }

        let mut guard = self.entries.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(existing) = guard.get(key) {
            if existing.alive.load(Ordering::Acquire) {
                let mut lookup_guard = existing
                    .port_lookup
                    .write()
                    .unwrap_or_else(|p| p.into_inner());
                *lookup_guard = port_lookup;
                return Ok(existing.endpoint.clone());
            }
            let _ = existing.shutdown_tx.send(true);
            guard.remove(key);
        }

        let rt = proxy_runtime()?;
        let std_listener = std::net::TcpListener::bind("127.0.0.1:0")
            .map_err(|err| format!("failed to bind loopback proxy for {key}: {err}"))?;
        let port = std_listener
            .local_addr()
            .map_err(|err| format!("failed to read local address for {key}: {err}"))?
            .port();
        std_listener
            .set_nonblocking(true)
            .map_err(|err| format!("failed to mark proxy listener nonblocking for {key}: {err}"))?;

        let listener = {
            let _enter = rt.enter();
            TcpListener::from_std(std_listener).map_err(|err| {
                format!("failed to register proxy listener on Tokio runtime for {key}: {err}")
            })?
        };

        let token = generate_proxy_token();
        let endpoint = ProxyEndpoint {
            port,
            token: token.clone(),
            proxy_url: format!("http://127.0.0.1:{port}"),
        };

        let lookup_holder = Arc::new(RwLock::new(port_lookup));
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let alive = Arc::new(AtomicBool::new(true));

        let state = ProxyServerState {
            namespaced_id: key.to_string(),
            proxy_port: port,
            token,
            port_lookup: Arc::clone(&lookup_holder),
            next_conn_id: Arc::clone(&self.next_conn_id),
        };
        let alive_flag = Arc::clone(&alive);

        rt.spawn(async move {
            struct AliveGuard(Arc<AtomicBool>);
            impl Drop for AliveGuard {
                fn drop(&mut self) {
                    self.0.store(false, Ordering::Release);
                }
            }
            let _alive_guard = AliveGuard(alive_flag);
            run_accept_loop(listener, state, shutdown_rx).await;
        });

        guard.insert(
            key.to_string(),
            ProxySlot {
                endpoint: endpoint.clone(),
                port_lookup: lookup_holder,
                shutdown_tx,
                alive,
            },
        );

        Ok(endpoint)
    }

    pub fn get_endpoint(&self, namespaced_id: &str) -> Option<ProxyEndpoint> {
        let guard = self.entries.lock().unwrap_or_else(|p| p.into_inner());
        guard
            .get(namespaced_id.trim())
            .filter(|slot| slot.alive.load(Ordering::Acquire))
            .map(|slot| slot.endpoint.clone())
    }

    pub fn remove_proxy(&self, namespaced_id: &str) {
        let removed = {
            let mut guard = self.entries.lock().unwrap_or_else(|p| p.into_inner());
            guard.remove(namespaced_id.trim())
        };
        if let Some(slot) = removed {
            slot.alive.store(false, Ordering::Release);
            let _ = slot.shutdown_tx.send(true);
        }
    }

    /// Shuts down and removes all proxies whose `namespaced_id` is not in `keep`.
    pub fn retain_proxies(&self, keep: &std::collections::HashSet<String>) {
        let mut removed = Vec::new();
        {
            let mut guard = self.entries.lock().unwrap_or_else(|p| p.into_inner());
            let stale_keys: Vec<String> = guard
                .keys()
                .filter(|k| !keep.contains(*k))
                .cloned()
                .collect();
            for key in stale_keys {
                if let Some(slot) = guard.remove(&key) {
                    removed.push(slot);
                }
            }
        }
        for slot in removed {
            slot.alive.store(false, Ordering::Release);
            let _ = slot.shutdown_tx.send(true);
        }
    }

    pub fn shutdown_all(&self) {
        let drained: Vec<ProxySlot> = {
            let mut guard = self.entries.lock().unwrap_or_else(|p| p.into_inner());
            guard.drain().map(|(_, slot)| slot).collect()
        };
        for slot in drained {
            slot.alive.store(false, Ordering::Release);
            let _ = slot.shutdown_tx.send(true);
        }
    }
}

#[derive(Clone)]
struct ProxyServerState {
    namespaced_id: String,
    proxy_port: u16,
    token: String,
    port_lookup: Arc<RwLock<UpstreamPortLookup>>,
    next_conn_id: Arc<AtomicU64>,
}

impl ProxyServerState {
    fn lookup_upstream_port(&self) -> Option<u16> {
        let lookup = self
            .port_lookup
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        lookup().filter(|&port| port > 0)
    }
}

fn generate_proxy_token() -> String {
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

async fn run_accept_loop(
    listener: TcpListener,
    state: ProxyServerState,
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
                        let _conn_id = conn_state.next_conn_id.fetch_add(1, Ordering::Relaxed);
                        tokio::spawn(async move {
                            handle_connection(stream, conn_state, conn_shutdown).await;
                        });
                    }
                    Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
        }
    }
}

#[derive(Debug)]
enum HeadReadError {
    TooLarge,
    Incomplete,
    Timeout,
    Io,
}

fn find_crlfcrlf(buf: &[u8], start_at: usize) -> Option<usize> {
    if buf.len() < 4 {
        return None;
    }
    let from = start_at.min(buf.len().saturating_sub(4));
    for i in from..=buf.len() - 4 {
        if &buf[i..i + 4] == b"\r\n\r\n" {
            return Some(i);
        }
    }
    None
}

async fn read_head_until_crlfcrlf(
    stream: &mut TcpStream,
    max_bytes: usize,
    timeout: Duration,
) -> Result<Option<(Vec<u8>, Vec<u8>)>, HeadReadError> {
    let mut buf = Vec::with_capacity(2048);
    let mut chunk = [0u8; 4096];

    loop {
        let prev_len = buf.len();
        let n = match tokio::time::timeout(timeout, stream.read(&mut chunk)).await {
            Ok(Ok(0)) => {
                if buf.is_empty() {
                    return Ok(None);
                }
                return Err(HeadReadError::Incomplete);
            }
            Ok(Ok(n)) => n,
            Ok(Err(_)) => return Err(HeadReadError::Io),
            Err(_) => {
                if buf.is_empty() {
                    return Ok(None);
                }
                return Err(HeadReadError::Timeout);
            }
        };

        buf.extend_from_slice(&chunk[..n]);
        let search_from = prev_len.saturating_sub(3);
        if let Some(hdr_end) = find_crlfcrlf(&buf, search_from) {
            if hdr_end + 4 > max_bytes {
                return Err(HeadReadError::TooLarge);
            }
            let tail = buf.split_off(hdr_end + 4);
            buf.truncate(hdr_end);
            return Ok(Some((buf, tail)));
        }

        if buf.len() > max_bytes {
            return Err(HeadReadError::TooLarge);
        }
    }
}

fn is_http_token(s: &str) -> bool {
    !s.is_empty()
        && s.bytes().all(|b| {
            matches!(
                b,
                b'!' | b'#' | b'$' | b'%' | b'&' | b'\'' | b'*' | b'+' | b'-' | b'.'
                    | b'^' | b'_' | b'`' | b'|' | b'~' | b'0'..=b'9' | b'A'..=b'Z' | b'a'..=b'z'
            )
        })
}

fn has_ctl_or_newline(s: &str) -> bool {
    s.bytes()
        .any(|b| b == b'\r' || b == b'\n' || b == 0 || (b < 0x20 && b != b'\t') || b == 0x7f)
}

fn normalize_request_target(raw_target: &str) -> Result<String, &'static str> {
    if raw_target.is_empty() || has_ctl_or_newline(raw_target) || raw_target.contains(' ') {
        return Err("invalid request target");
    }
    if raw_target.starts_with('/') || raw_target == "*" {
        return Ok(raw_target.to_string());
    }
    for scheme in ["http://", "https://"] {
        if raw_target
            .get(..scheme.len())
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case(scheme))
        {
            let rest = &raw_target[scheme.len()..];
            if rest.is_empty() {
                return Err("empty host in absolute request target");
            }
            return match rest.find('/') {
                Some(idx) => Ok(rest[idx..].to_string()),
                None => match rest.find('?') {
                    Some(q_idx) => Ok(format!("/{}", &rest[q_idx..])),
                    None => Ok("/".to_string()),
                },
            };
        }
    }
    Err("unsupported request target form")
}

struct ParsedRequestHead {
    method: String,
    target: String,
    version: String,
    headers: Vec<(String, String)>,
    content_length: Option<u64>,
    is_chunked: bool,
    is_websocket: bool,
    expect_100_continue: bool,
}

fn parse_request_head(head_bytes: &[u8]) -> Result<ParsedRequestHead, &'static str> {
    if head_bytes.contains(&0) {
        return Err("null byte in request head");
    }
    let head_str = std::str::from_utf8(head_bytes).map_err(|_| "non-utf8 request head")?;
    let mut lines = head_str.split("\r\n");
    let request_line = lines.next().ok_or("missing request line")?;
    if has_ctl_or_newline(request_line) {
        return Err("invalid control character in request line");
    }

    let mut req_parts = request_line.split(' ');
    let method = req_parts.next().ok_or("missing method")?;
    let raw_target = req_parts.next().ok_or("missing target")?;
    let version = req_parts.next().ok_or("missing version")?;
    if req_parts.next().is_some() {
        return Err("extra tokens in request line");
    }
    if !is_http_token(method) {
        return Err("invalid HTTP method");
    }
    if !(version == "HTTP/1.1" || version == "HTTP/1.0") {
        return Err("unsupported HTTP version");
    }
    let target = normalize_request_target(raw_target)?;

    let mut headers = Vec::new();
    let mut content_length: Option<u64> = None;
    let mut is_chunked = false;
    let mut has_upgrade_websocket = false;
    let mut expect_100_continue = false;

    for line in lines {
        if line.is_empty() {
            return Err("unexpected empty header line");
        }
        let (raw_name, raw_val) = line.split_once(':').ok_or("malformed header line")?;
        if !is_http_token(raw_name) {
            return Err("invalid header name");
        }
        let val = raw_val.trim_matches(|c| c == ' ' || c == '\t');
        if has_ctl_or_newline(val) {
            return Err("invalid header value");
        }

        if raw_name.eq_ignore_ascii_case("content-length") {
            if val.is_empty() || !val.bytes().all(|b| b.is_ascii_digit()) {
                return Err("invalid Content-Length");
            }
            let parsed = val.parse::<u64>().map_err(|_| "overflow Content-Length")?;
            if let Some(prev) = content_length {
                if prev != parsed {
                    return Err("conflicting Content-Length headers");
                }
            } else {
                content_length = Some(parsed);
            }
        } else if raw_name.eq_ignore_ascii_case("transfer-encoding") {
            if val
                .split(',')
                .any(|tok| tok.trim().eq_ignore_ascii_case("chunked"))
            {
                is_chunked = true;
            }
        } else if raw_name.eq_ignore_ascii_case("upgrade") {
            if val
                .split(',')
                .any(|tok| tok.trim().eq_ignore_ascii_case("websocket"))
            {
                has_upgrade_websocket = true;
            }
        } else if raw_name.eq_ignore_ascii_case("expect")
            && val.eq_ignore_ascii_case("100-continue")
        {
            expect_100_continue = true;
        }

        headers.push((raw_name.to_string(), val.to_string()));
    }

    if is_chunked && content_length.is_some() {
        return Err("both Transfer-Encoding chunked and Content-Length present");
    }

    let is_websocket = method.eq_ignore_ascii_case("GET") && has_upgrade_websocket;

    Ok(ParsedRequestHead {
        method: method.to_string(),
        target,
        version: version.to_string(),
        headers,
        content_length,
        is_chunked,
        is_websocket,
        expect_100_continue,
    })
}

struct ParsedResponseHead {
    status: u16,
    status_line: String,
    headers: Vec<(String, String)>,
    content_length: Option<u64>,
    is_chunked: bool,
}

fn parse_response_head(head_bytes: &[u8]) -> Result<ParsedResponseHead, &'static str> {
    if head_bytes.contains(&0) {
        return Err("null byte in upstream response head");
    }
    let head_str = String::from_utf8_lossy(head_bytes);
    let mut lines = head_str.split("\r\n");
    let status_line = lines.next().ok_or("missing upstream status line")?;
    if !status_line.starts_with("HTTP/1.") {
        return Err("invalid upstream status line");
    }
    let status_code_str = status_line
        .split_whitespace()
        .nth(1)
        .ok_or("missing upstream status code")?;
    let status = status_code_str
        .parse::<u16>()
        .map_err(|_| "invalid upstream status code")?;

    let mut headers = Vec::new();
    let mut content_length: Option<u64> = None;
    let mut is_chunked = false;

    for line in lines {
        if line.is_empty() {
            continue;
        }
        let Some((raw_name, raw_val)) = line.split_once(':') else {
            return Err("malformed upstream header line");
        };
        let name = raw_name.trim();
        let val = raw_val.trim_matches(|c| c == ' ' || c == '\t');
        if name.eq_ignore_ascii_case("content-length") {
            if let Ok(len) = val.parse::<u64>() {
                content_length = Some(len);
            }
        } else if name.eq_ignore_ascii_case("transfer-encoding")
            && val
                .split(',')
                .any(|tok| tok.trim().eq_ignore_ascii_case("chunked"))
        {
            is_chunked = true;
        }
        headers.push((name.to_string(), val.to_string()));
    }

    Ok(ParsedResponseHead {
        status,
        status_line: status_line.to_string(),
        headers,
        content_length,
        is_chunked,
    })
}

fn has_valid_auth_cookie(headers: &[(String, String)], expected_token: &str) -> bool {
    for (name, val) in headers {
        if !name.eq_ignore_ascii_case("cookie") {
            continue;
        }
        for pair in val.split(';') {
            let pair = pair.trim();
            if let Some((cookie_name, cookie_val)) = pair.split_once('=') {
                if cookie_name.trim() == AUTH_COOKIE_NAME {
                    let candidate = cookie_val.trim().trim_matches('"');
                    if constant_time_eq(candidate.as_bytes(), expected_token.as_bytes()) {
                        return true;
                    }
                }
            }
        }
    }
    false
}

fn has_valid_query_token(target: &str, expected_token: &str) -> bool {
    let Some((_, query)) = target.split_once('?') else {
        return false;
    };
    let mut saw_token = false;
    for segment in query.split('&') {
        if let Some((k, v)) = segment.split_once('=') {
            if k == TOKEN_QUERY_PARAM {
                saw_token = true;
                if !constant_time_eq(v.as_bytes(), expected_token.as_bytes()) {
                    return false;
                }
            }
        } else if segment == TOKEN_QUERY_PARAM {
            return false;
        }
    }
    saw_token
}

fn strip_query_param(target: &str, param_name: &str) -> String {
    let Some((path, query)) = target.split_once('?') else {
        return target.to_string();
    };
    let kept: Vec<&str> = query
        .split('&')
        .filter(|seg| {
            if seg.is_empty() {
                return false;
            }
            let key = seg.split_once('=').map(|(k, _)| k).unwrap_or(seg);
            key != param_name
        })
        .collect();
    if kept.is_empty() {
        path.to_string()
    } else {
        format!("{path}?{}", kept.join("&"))
    }
}

fn safe_redirect_location(target: &str) -> String {
    let stripped = strip_query_param(target, TOKEN_QUERY_PARAM);
    if stripped.starts_with("//") {
        format!("/{}", stripped.trim_start_matches('/'))
    } else if stripped.starts_with('/') {
        stripped
    } else {
        format!("/{stripped}")
    }
}

fn strip_auth_cookie_from_header(cookie_val: &str) -> Option<String> {
    let kept: Vec<&str> = cookie_val
        .split(';')
        .map(str::trim)
        .filter(|pair| {
            if pair.is_empty() {
                return false;
            }
            let name = pair
                .split_once('=')
                .map(|(k, _)| k.trim())
                .unwrap_or(pair);
            name != AUTH_COOKIE_NAME
        })
        .collect();
    if kept.is_empty() {
        None
    } else {
        Some(kept.join("; "))
    }
}

fn rewrite_referer_origin(value: &str, proxy_port: u16, up_port: u16) -> String {
    for scheme in ["http://", "https://"] {
        let prefix = format!("{scheme}127.0.0.1:{proxy_port}");
        if value
            .get(..prefix.len())
            .is_some_and(|head| head.eq_ignore_ascii_case(&prefix))
        {
            let rest = &value[prefix.len()..];
            if rest.is_empty()
                || rest.starts_with('/')
                || rest.starts_with('?')
                || rest.starts_with('#')
            {
                let scheme_actual = &value[..scheme.len()];
                return format!("{scheme_actual}127.0.0.1:{up_port}{rest}");
            }
        }
    }
    value.to_string()
}

fn strip_csp_frame_ancestors(csp: &str) -> Option<String> {
    let kept: Vec<&str> = csp
        .split(';')
        .map(str::trim)
        .filter(|directive| {
            if directive.is_empty() {
                return false;
            }
            let lower = directive.to_ascii_lowercase();
            !(lower == "frame-ancestors"
                || lower.starts_with("frame-ancestors ")
                || lower.starts_with("frame-ancestors\t"))
        })
        .collect();
    if kept.is_empty() {
        None
    } else {
        Some(kept.join("; "))
    }
}

fn build_upstream_request_head(
    req: &ParsedRequestHead,
    proxy_port: u16,
    up_port: u16,
) -> Vec<u8> {
    let clean_target = strip_query_param(&req.target, TOKEN_QUERY_PARAM);
    let mut out = format!("{} {} {}\r\n", req.method, clean_target, req.version);

    for (name, val) in &req.headers {
        if name.eq_ignore_ascii_case("host") || name.eq_ignore_ascii_case("origin") {
            continue;
        }
        if !req.is_websocket
            && (name.eq_ignore_ascii_case("connection")
                || name.eq_ignore_ascii_case("keep-alive")
                || name.eq_ignore_ascii_case("proxy-connection")
                || name.eq_ignore_ascii_case("expect"))
        {
            continue;
        }
        if name.eq_ignore_ascii_case("cookie") {
            if let Some(filtered) = strip_auth_cookie_from_header(val) {
                out.push_str(&format!("{name}: {filtered}\r\n"));
            }
            continue;
        }
        if name.eq_ignore_ascii_case("referer") {
            let rewritten = rewrite_referer_origin(val, proxy_port, up_port);
            out.push_str(&format!("{name}: {rewritten}\r\n"));
            continue;
        }
        out.push_str(&format!("{name}: {val}\r\n"));
    }

    out.push_str(&format!("Host: 127.0.0.1:{up_port}\r\n"));
    out.push_str(&format!("Origin: http://127.0.0.1:{up_port}\r\n"));
    if !req.is_websocket {
        out.push_str("Connection: close\r\n");
    }
    out.push_str("\r\n");
    out.into_bytes()
}

fn build_sanitized_response_head(resp: &ParsedResponseHead, preserve_upgrade: bool) -> Vec<u8> {
    let mut out = format!("{}\r\n", resp.status_line);
    let force_close = !(preserve_upgrade && resp.status == 101);

    for (name, val) in &resp.headers {
        if name.eq_ignore_ascii_case("x-frame-options") {
            continue;
        }
        if name.eq_ignore_ascii_case("content-security-policy") {
            if let Some(sanitized) = strip_csp_frame_ancestors(val) {
                out.push_str(&format!("{name}: {sanitized}\r\n"));
            }
            continue;
        }
        if force_close
            && (name.eq_ignore_ascii_case("connection")
                || name.eq_ignore_ascii_case("keep-alive")
                || name.eq_ignore_ascii_case("proxy-connection"))
        {
            continue;
        }
        out.push_str(&format!("{name}: {val}\r\n"));
    }

    if force_close {
        out.push_str("Connection: close\r\n");
    }
    out.push_str("\r\n");
    out.into_bytes()
}

async fn write_simple_response(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    content_type: &str,
    extra_headers: &[(&str, &str)],
    body: &[u8],
    is_head_method: bool,
) {
    let mut head = format!("HTTP/1.1 {status} {reason}\r\n");
    head.push_str(&format!("Content-Type: {content_type}\r\n"));
    for (k, v) in extra_headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str(&format!(
        "Cache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    ));
    let _ = stream.write_all(head.as_bytes()).await;
    if !is_head_method && !body.is_empty() {
        let _ = stream.write_all(body).await;
    }
    let _ = stream.flush().await;
    let _ = stream.shutdown().await;
}

async fn write_503_unavailable(
    stream: &mut TcpStream,
    namespaced_id: &str,
    is_head_method: bool,
) {
    let escaped_id = namespaced_id
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    let html = format!(
        "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>503 Service Unavailable</title>\
         <style>body{{font-family:system-ui,sans-serif;background:#111318;color:#e6eaf2;display:grid;place-items:center;min-height:100vh;margin:0}}\
         main{{max-width:420px;padding:24px;border:1px solid #262b36;border-radius:12px;background:#171a21}}\
         h1{{font-size:16px;margin:0 0 8px}}p{{font-size:13px;color:#9aa3b2;margin:0}}</style></head>\
         <body><main><h1>Sidecar Service Unavailable</h1>\
         <p>Extension sidecar <code>{escaped_id}</code> is offline or still starting.</p></main></body></html>"
    );
    write_simple_response(
        stream,
        503,
        "Service Unavailable",
        "text/html; charset=utf-8",
        &[],
        html.as_bytes(),
        is_head_method,
    )
    .await;
}

async fn write_302_auth_redirect(
    stream: &mut TcpStream,
    location: &str,
    token: &str,
) {
    // Production Tauri WebView2 serves the host UI on `http://tauri.localhost` while
    // sidecar frames load `http://127.0.0.1:<proxy_port>` (cross-site). Chromium
    // strips `SameSite=Lax` cookies on cross-site iframe navigations, whereas
    // `SameSite=None; Secure; Partitioned` is accepted on loopback (`127.0.0.1` is
    // a W3C potentially trustworthy origin) and keeps the cookie isolated to Kite's
    // top-level site even when third-party cookies are restricted.
    let cookie = format!(
        "{AUTH_COOKIE_NAME}={token}; HttpOnly; SameSite=None; Secure; Partitioned; Path=/"
    );
    let head = format!(
        "HTTP/1.1 302 Found\r\nLocation: {location}\r\nSet-Cookie: {cookie}\r\nCache-Control: no-store\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    let _ = stream.write_all(head.as_bytes()).await;
    let _ = stream.flush().await;
    let _ = stream.shutdown().await;
}

async fn read_into_carry(stream: &mut TcpStream, carry: &mut Vec<u8>) -> Result<usize, ()> {
    let mut buf = [0u8; 4096];
    match tokio::time::timeout(BODY_IO_TIMEOUT, stream.read(&mut buf)).await {
        Ok(Ok(n)) => {
            if n > 0 {
                carry.extend_from_slice(&buf[..n]);
            }
            Ok(n)
        }
        Ok(Err(_)) | Err(_) => Err(()),
    }
}

async fn forward_fixed_body(
    client: &mut TcpStream,
    upstream: &mut TcpStream,
    tail: &[u8],
    content_length: u64,
) -> Result<(), ()> {
    let from_tail = tail.len().min(content_length as usize);
    if from_tail > 0 {
        upstream.write_all(&tail[..from_tail]).await.map_err(|_| ())?;
    }
    let mut remaining = content_length - from_tail as u64;
    let mut buf = [0u8; 16 * 1024];
    while remaining > 0 {
        let to_read = (remaining as usize).min(buf.len());
        let n = match tokio::time::timeout(BODY_IO_TIMEOUT, client.read(&mut buf[..to_read])).await {
            Ok(Ok(0)) => return Err(()),
            Ok(Ok(n)) => n,
            Ok(Err(_)) | Err(_) => return Err(()),
        };
        upstream.write_all(&buf[..n]).await.map_err(|_| ())?;
        remaining -= n as u64;
    }
    Ok(())
}

async fn forward_chunked_body(
    client: &mut TcpStream,
    upstream: &mut TcpStream,
    tail: Vec<u8>,
) -> Result<(), ()> {
    let mut carry = tail;
    let mut buf = [0u8; 16 * 1024];

    loop {
        let line_end = loop {
            if let Some(pos) = carry.windows(2).position(|w| w == b"\r\n") {
                break pos;
            }
            if carry.len() > MAX_CHUNK_LINE_BYTES {
                return Err(());
            }
            if read_into_carry(client, &mut carry).await? == 0 {
                return Err(());
            }
        };

        let line_str = std::str::from_utf8(&carry[..line_end]).map_err(|_| ())?;
        let hex_part = line_str.split(';').next().unwrap_or("").trim();
        let chunk_size = usize::from_str_radix(hex_part, 16).map_err(|_| ())?;

        upstream
            .write_all(&carry[..line_end + 2])
            .await
            .map_err(|_| ())?;
        carry.drain(..line_end + 2);

        if chunk_size == 0 {
            loop {
                if carry.starts_with(b"\r\n") {
                    upstream.write_all(b"\r\n").await.map_err(|_| ())?;
                    carry.drain(..2);
                    return Ok(());
                }
                if let Some(trailer_end) = carry.windows(4).position(|w| w == b"\r\n\r\n") {
                    upstream
                        .write_all(&carry[..trailer_end + 4])
                        .await
                        .map_err(|_| ())?;
                    carry.drain(..trailer_end + 4);
                    return Ok(());
                }
                if carry.len() > MAX_HEADER_BYTES {
                    return Err(());
                }
                if read_into_carry(client, &mut carry).await? == 0 {
                    return Err(());
                }
            }
        }

        let mut remaining = chunk_size;
        if !carry.is_empty() {
            let take_now = carry.len().min(remaining);
            upstream.write_all(&carry[..take_now]).await.map_err(|_| ())?;
            carry.drain(..take_now);
            remaining -= take_now;
        }
        while remaining > 0 {
            let to_read = remaining.min(buf.len());
            let n = match tokio::time::timeout(BODY_IO_TIMEOUT, client.read(&mut buf[..to_read]))
                .await
            {
                Ok(Ok(0)) => return Err(()),
                Ok(Ok(n)) => n,
                Ok(Err(_)) | Err(_) => return Err(()),
            };
            upstream.write_all(&buf[..n]).await.map_err(|_| ())?;
            remaining -= n;
        }

        while carry.len() < 2 {
            if read_into_carry(client, &mut carry).await? == 0 {
                return Err(());
            }
        }
        if &carry[..2] != b"\r\n" {
            return Err(());
        }
        upstream.write_all(b"\r\n").await.map_err(|_| ())?;
        carry.drain(..2);
    }
}

async fn forward_upstream_http_body(
    client: &mut TcpStream,
    upstream: &mut TcpStream,
    resp: &ParsedResponseHead,
    resp_tail: &[u8],
    is_head_method: bool,
    mut shutdown_rx: watch::Receiver<bool>,
) {
    let has_no_body = is_head_method
        || resp.status == 204
        || resp.status == 304
        || (100..200).contains(&resp.status);
    if has_no_body {
        let _ = client.flush().await;
        return;
    }

    if let (Some(cl), false) = (resp.content_length, resp.is_chunked) {
        let from_tail = resp_tail.len().min(cl as usize);
        if from_tail > 0 {
            if client.write_all(&resp_tail[..from_tail]).await.is_err() {
                return;
            }
            let _ = client.flush().await;
        }
        let remaining = cl - from_tail as u64;
        if remaining > 0 {
            let mut limited = upstream.take(remaining);
            tokio::select! {
                _ = shutdown_rx.changed() => {}
                _ = tokio::io::copy(&mut limited, client) => {}
            }
        }
    } else {
        if !resp_tail.is_empty() {
            if client.write_all(resp_tail).await.is_err() {
                return;
            }
            let _ = client.flush().await;
        }
        tokio::select! {
            _ = shutdown_rx.changed() => {}
            _ = tokio::io::copy(upstream, client) => {}
        }
    }
    let _ = client.flush().await;
}

async fn read_upstream_final_response_head(
    upstream: &mut TcpStream,
    is_websocket: bool,
) -> Result<(ParsedResponseHead, Vec<u8>), ()> {
    loop {
        let (head_bytes, tail) =
            match read_head_until_crlfcrlf(upstream, MAX_HEADER_BYTES, UPSTREAM_HEAD_TIMEOUT).await
            {
                Ok(Some(pair)) => pair,
                _ => return Err(()),
            };
        let parsed = parse_response_head(&head_bytes).map_err(|_| ())?;
        if !is_websocket && (100..200).contains(&parsed.status) && parsed.status != 101 {
            // Skip intermediate 1xx informational headers on normal HTTP requests;
            // if bytes were buffered after the 1xx head they would belong to the next response.
            if tail.is_empty() {
                continue;
            }
        }
        return Ok((parsed, tail));
    }
}

async fn handle_connection(
    mut client_stream: TcpStream,
    state: ProxyServerState,
    mut shutdown_rx: watch::Receiver<bool>,
) {
    let (head_bytes, req_tail) = tokio::select! {
        _ = shutdown_rx.changed() => return,
        res = read_head_until_crlfcrlf(&mut client_stream, MAX_HEADER_BYTES, HEADER_READ_TIMEOUT) => {
            match res {
                Ok(Some(pair)) => pair,
                Ok(None) => return,
                Err(HeadReadError::TooLarge) => {
                    write_simple_response(
                        &mut client_stream,
                        431,
                        "Request Header Fields Too Large",
                        "text/plain; charset=utf-8",
                        &[],
                        b"Request Header Fields Too Large",
                        false,
                    )
                    .await;
                    return;
                }
                Err(HeadReadError::Incomplete | HeadReadError::Timeout | HeadReadError::Io) => {
                    write_simple_response(
                        &mut client_stream,
                        400,
                        "Bad Request",
                        "text/plain; charset=utf-8",
                        &[],
                        b"Bad Request",
                        false,
                    )
                    .await;
                    return;
                }
            }
        }
    };

    let req = match parse_request_head(&head_bytes) {
        Ok(parsed) => parsed,
        Err(_) => {
            write_simple_response(
                &mut client_stream,
                400,
                "Bad Request",
                "text/plain; charset=utf-8",
                &[],
                b"Bad Request",
                false,
            )
            .await;
            return;
        }
    };

    let is_head_method = req.method.eq_ignore_ascii_case("HEAD");
    let cookie_ok = has_valid_auth_cookie(&req.headers, &state.token);
    let query_token_ok = has_valid_query_token(&req.target, &state.token);

    if !cookie_ok && !query_token_ok {
        write_simple_response(
            &mut client_stream,
            401,
            "Unauthorized",
            "text/plain; charset=utf-8",
            &[],
            b"Unauthorized",
            is_head_method,
        )
        .await;
        return;
    }

    if query_token_ok
        && !req.is_websocket
        && (req.method.eq_ignore_ascii_case("GET") || is_head_method)
    {
        let location = safe_redirect_location(&req.target);
        write_302_auth_redirect(&mut client_stream, &location, &state.token).await;
        return;
    }

    let Some(up_port) = state.lookup_upstream_port() else {
        write_503_unavailable(&mut client_stream, &state.namespaced_id, is_head_method).await;
        return;
    };

    let mut upstream_stream = match tokio::time::timeout(
        UPSTREAM_CONNECT_TIMEOUT,
        TcpStream::connect(("127.0.0.1", up_port)),
    )
    .await
    {
        Ok(Ok(stream)) => {
            let _ = stream.set_nodelay(true);
            stream
        }
        _ => {
            write_503_unavailable(&mut client_stream, &state.namespaced_id, is_head_method).await;
            return;
        }
    };

    let upstream_req_head = build_upstream_request_head(&req, state.proxy_port, up_port);
    if upstream_stream.write_all(&upstream_req_head).await.is_err() {
        write_503_unavailable(&mut client_stream, &state.namespaced_id, is_head_method).await;
        return;
    }

    if req.is_websocket {
        if !req_tail.is_empty() && upstream_stream.write_all(&req_tail).await.is_err() {
            return;
        }
        if upstream_stream.flush().await.is_err() {
            return;
        }

        let Ok((resp_head, resp_tail)) =
            read_upstream_final_response_head(&mut upstream_stream, true).await
        else {
            write_simple_response(
                &mut client_stream,
                502,
                "Bad Gateway",
                "text/plain; charset=utf-8",
                &[],
                b"Bad Gateway",
                false,
            )
            .await;
            return;
        };

        let sanitized = build_sanitized_response_head(&resp_head, true);
        if client_stream.write_all(&sanitized).await.is_err() {
            return;
        }

        if resp_head.status == 101 {
            if !resp_tail.is_empty() && client_stream.write_all(&resp_tail).await.is_err() {
                return;
            }
            if client_stream.flush().await.is_err() {
                return;
            }
            tokio::select! {
                _ = shutdown_rx.changed() => {}
                _ = tokio::io::copy_bidirectional(&mut client_stream, &mut upstream_stream) => {}
            }
        } else {
            forward_upstream_http_body(
                &mut client_stream,
                &mut upstream_stream,
                &resp_head,
                &resp_tail,
                false,
                shutdown_rx,
            )
            .await;
            let _ = client_stream.shutdown().await;
        }
        return;
    }

    if req.expect_100_continue {
        if client_stream
            .write_all(b"HTTP/1.1 100 Continue\r\n\r\n")
            .await
            .is_err()
        {
            return;
        }
        let _ = client_stream.flush().await;
    }

    if req.is_chunked {
        if forward_chunked_body(&mut client_stream, &mut upstream_stream, req_tail)
            .await
            .is_err()
        {
            return;
        }
    } else if let Some(len) = req.content_length {
        if len > 0
            && forward_fixed_body(&mut client_stream, &mut upstream_stream, &req_tail, len)
                .await
                .is_err()
        {
            return;
        }
    }

    if upstream_stream.flush().await.is_err() {
        return;
    }

    let Ok((resp_head, resp_tail)) =
        read_upstream_final_response_head(&mut upstream_stream, false).await
    else {
        write_simple_response(
            &mut client_stream,
            502,
            "Bad Gateway",
            "text/plain; charset=utf-8",
            &[],
            b"Bad Gateway",
            is_head_method,
        )
        .await;
        return;
    };

    let sanitized = build_sanitized_response_head(&resp_head, false);
    if client_stream.write_all(&sanitized).await.is_err() {
        return;
    }

    forward_upstream_http_body(
        &mut client_stream,
        &mut upstream_stream,
        &resp_head,
        &resp_tail,
        is_head_method,
        shutdown_rx,
    )
    .await;
    let _ = client_stream.shutdown().await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use std::sync::atomic::AtomicUsize;
    use tokio::io::{AsyncBufReadExt, BufReader};
    use tokio_tungstenite::tungstenite::handshake::server::{
        ErrorResponse, Request as WsRequest, Response as WsResponse,
    };
    use tokio_tungstenite::tungstenite::Message;

    fn port_fn(port: u16) -> UpstreamPortLookup {
        Arc::new(move || Some(port))
    }

    async fn send_raw_http(port: u16, raw: &[u8]) -> Vec<u8> {
        let mut stream = TcpStream::connect(("127.0.0.1", port))
            .await
            .expect("connect to proxy");
        stream.write_all(raw).await.expect("write raw request");
        stream.flush().await.expect("flush raw request");
        let mut resp = Vec::new();
        stream.read_to_end(&mut resp).await.expect("read response");
        resp
    }

    fn split_http_response(raw: &[u8]) -> (String, Vec<u8>) {
        let idx = find_crlfcrlf(raw, 0).expect("response should contain CRLFCRLF");
        let head = String::from_utf8_lossy(&raw[..idx]).to_string();
        let body = raw[idx + 4..].to_vec();
        (head, body)
    }

    async fn spawn_http_test_server<F, Fut>(handler: F) -> u16
    where
        F: Fn(String, HashMap<String, String>, Vec<u8>) -> Fut + Send + Sync + 'static,
        Fut: std::future::Future<Output = Vec<u8>> + Send + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let handler = Arc::new(handler);
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                let h = Arc::clone(&handler);
                tokio::spawn(async move {
                    let Ok(Some((head, tail))) =
                        read_head_until_crlfcrlf(&mut sock, MAX_HEADER_BYTES, HEADER_READ_TIMEOUT)
                            .await
                    else {
                        return;
                    };
                    let head_str = String::from_utf8_lossy(&head).to_string();
                    let mut lines = head_str.split("\r\n");
                    let req_line = lines.next().unwrap_or("").to_string();
                    let mut hdrs = HashMap::new();
                    for line in lines {
                        if let Some((k, v)) = line.split_once(':') {
                            hdrs.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
                        }
                    }
                    let mut body = tail;
                    if let Some(cl) = hdrs.get("content-length").and_then(|v| v.parse::<usize>().ok()) {
                        while body.len() < cl {
                            let mut buf = [0u8; 2048];
                            let n = sock.read(&mut buf).await.unwrap_or(0);
                            if n == 0 {
                                break;
                            }
                            body.extend_from_slice(&buf[..n]);
                        }
                        body.truncate(cl);
                    }
                    let resp = h(req_line, hdrs, body).await;
                    let _ = sock.write_all(&resp).await;
                    let _ = sock.flush().await;
                    let _ = sock.shutdown().await;
                });
            }
        });
        port
    }

    #[test]
    fn entry_url_normalizes_paths_queries_and_fragments() {
        let ep = ProxyEndpoint {
            port: 43210,
            token: "tok123".to_string(),
            proxy_url: "http://127.0.0.1:43210".to_string(),
        };
        assert_eq!(ep.entry_url(""), "http://127.0.0.1:43210/?__kite_token=tok123");
        assert_eq!(ep.entry_url("/"), "http://127.0.0.1:43210/?__kite_token=tok123");
        assert_eq!(
            ep.entry_url("devices"),
            "http://127.0.0.1:43210/devices?__kite_token=tok123"
        );
        assert_eq!(
            ep.entry_url("/mirror?id=emu-1"),
            "http://127.0.0.1:43210/mirror?id=emu-1&__kite_token=tok123"
        );
        assert_eq!(
            ep.entry_url("/mirror?id=emu-1&__kite_token=stale#pane"),
            "http://127.0.0.1:43210/mirror?id=emu-1&__kite_token=tok123#pane"
        );
    }

    #[tokio::test]
    async fn unauthenticated_returns_401_and_token_sets_cookie_with_302() {
        let up_port = spawn_http_test_server(|req_line, hdrs, _body| async move {
            let cookie = hdrs.get("cookie").cloned().unwrap_or_default();
            let payload = format!("{req_line}|cookie={cookie}");
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                payload.len(),
                payload
            )
            .into_bytes()
        })
        .await;

        let pool = SidecarProxyPool::new();
        let ep = pool
            .ensure_proxy("ext/device-hub", port_fn(up_port))
            .expect("ensure_proxy should succeed inside tokio runtime");
        assert_eq!(ep.token.len(), 64);

        // 1. Unauthenticated -> 401
        let resp_401 = send_raw_http(
            ep.port,
            format!("GET / HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n\r\n", ep.port).as_bytes(),
        )
        .await;
        let (head_401, _) = split_http_response(&resp_401);
        assert!(head_401.starts_with("HTTP/1.1 401 Unauthorized"), "{head_401}");
        assert!(head_401.contains("Connection: close"), "{head_401}");

        // 2. Wrong token -> 401
        let resp_bad = send_raw_http(
            ep.port,
            format!(
                "GET /?__kite_token=wrong HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n\r\n",
                ep.port
            )
            .as_bytes(),
        )
        .await;
        let (head_bad, _) = split_http_response(&resp_bad);
        assert!(head_bad.starts_with("HTTP/1.1 401 Unauthorized"), "{head_bad}");

        // 3. Valid __kite_token on GET -> 302 + Set-Cookie + Location without token
        let resp_302 = send_raw_http(
            ep.port,
            format!(
                "GET /devices?tab=usb&__kite_token={} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n\r\n",
                ep.token, ep.port
            )
            .as_bytes(),
        )
        .await;
        let (head_302, body_302) = split_http_response(&resp_302);
        assert!(head_302.starts_with("HTTP/1.1 302 Found"), "{head_302}");
        assert!(
            head_302.contains("Location: /devices?tab=usb\r\n"),
            "Location header mismatch: {head_302}"
        );
        assert!(
            head_302.contains(&format!(
                "Set-Cookie: kite_sidecar_auth={}; HttpOnly; SameSite=None; Secure; Partitioned; Path=/",
                ep.token
            )),
            "Set-Cookie header mismatch: {head_302}"
        );
        assert!(head_302.contains("Cache-Control: no-store"), "{head_302}");
        assert!(head_302.contains("Content-Length: 0"), "{head_302}");
        assert!(head_302.contains("Connection: close"), "{head_302}");
        assert!(body_302.is_empty());

        // 4. Subsequent request with cookie + another cookie strips kite_sidecar_auth upstream
        let resp_200 = send_raw_http(
            ep.port,
            format!(
                "GET /devices?tab=usb HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nCookie: session=abc; kite_sidecar_auth={}; theme=dark\r\n\r\n",
                ep.port, ep.token
            )
            .as_bytes(),
        )
        .await;
        let (head_200, body_200) = split_http_response(&resp_200);
        assert!(head_200.starts_with("HTTP/1.1 200 OK"), "{head_200}");
        let body_str = String::from_utf8_lossy(&body_200);
        assert_eq!(body_str, "GET /devices?tab=usb HTTP/1.1|cookie=session=abc; theme=dark");
    }

    #[tokio::test]
    async fn strict_upstream_rejects_bad_origin_403_and_succeeds_200_through_proxy() {
        let up_port = spawn_http_test_server(|_req_line, hdrs, _body| async move {
            let expected_origin = hdrs.get("host").map(|h| format!("http://{h}")).unwrap_or_default();
            let origin = hdrs.get("origin").cloned().unwrap_or_default();
            let host = hdrs.get("host").cloned().unwrap_or_default();
            let referer = hdrs.get("referer").cloned().unwrap_or_default();

            if origin.is_empty()
                || origin != expected_origin
                || !host.starts_with("127.0.0.1:")
                || !referer.starts_with(&expected_origin)
            {
                return b"HTTP/1.1 403 Forbidden\r\nContent-Length: 9\r\nConnection: close\r\n\r\nforbidden"
                    .to_vec();
            }

            let ok_body = format!("origin={origin};host={host};referer={referer}");
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                ok_body.len(),
                ok_body
            )
            .into_bytes()
        })
        .await;

        let pool = SidecarProxyPool::new();
        let ep = pool.ensure_proxy("ext/strict-origin", port_fn(up_port)).unwrap();

        // Direct request with proxy's Origin fails with 403 on strict upstream
        let direct_403 = send_raw_http(
            up_port,
            format!(
                "GET /api/devices HTTP/1.1\r\nHost: 127.0.0.1:{up_port}\r\nOrigin: http://127.0.0.1:{}\r\nReferer: http://127.0.0.1:{}/ui\r\nConnection: close\r\n\r\n",
                ep.port, ep.port
            )
            .as_bytes(),
        )
        .await;
        let (direct_head, _) = split_http_response(&direct_403);
        assert!(direct_head.starts_with("HTTP/1.1 403 Forbidden"), "{direct_head}");

        // Same request routed through proxy succeeds with rewritten Host, Origin, and Referer
        let proxied_200 = send_raw_http(
            ep.port,
            format!(
                "GET /api/devices HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nOrigin: http://127.0.0.1:{}\r\nReferer: http://127.0.0.1:{}/ui?tab=1\r\nCookie: kite_sidecar_auth={}\r\n\r\n",
                ep.port, ep.port, ep.port, ep.token
            )
            .as_bytes(),
        )
        .await;
        let (proxied_head, proxied_body) = split_http_response(&proxied_200);
        assert!(proxied_head.starts_with("HTTP/1.1 200 OK"), "{proxied_head}");
        assert_eq!(
            String::from_utf8_lossy(&proxied_body),
            format!(
                "origin=http://127.0.0.1:{up_port};host=127.0.0.1:{up_port};referer=http://127.0.0.1:{up_port}/ui?tab=1"
            )
        );
    }

    #[tokio::test]
    async fn strips_x_frame_options_and_csp_frame_ancestors() {
        let up_port = spawn_http_test_server(|req_line, _hdrs, _body| async move {
            if req_line.starts_with("GET /only-frame-ancestors ") {
                return b"HTTP/1.1 200 OK\r\nX-Frame-Options: SAMEORIGIN\r\nContent-Security-Policy: frame-ancestors 'none'\r\nKeep-Alive: timeout=5\r\nConnection: keep-alive\r\nContent-Length: 2\r\n\r\nok".to_vec();
            }
            b"HTTP/1.1 200 OK\r\nX-Frame-Options: DENY\r\nContent-Security-Policy: default-src 'self'; frame-ancestors 'none'; img-src *\r\nKeep-Alive: timeout=5\r\nConnection: keep-alive\r\nContent-Length: 5\r\n\r\nhello".to_vec()
        })
        .await;

        let pool = SidecarProxyPool::new();
        let ep = pool.ensure_proxy("ext/csp-test", port_fn(up_port)).unwrap();

        let resp = send_raw_http(
            ep.port,
            format!(
                "GET / HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nCookie: kite_sidecar_auth={}\r\n\r\n",
                ep.port, ep.token
            )
            .as_bytes(),
        )
        .await;
        let (head, body) = split_http_response(&resp);
        let lower = head.to_ascii_lowercase();
        assert!(head.starts_with("HTTP/1.1 200 OK"), "{head}");
        assert!(!lower.contains("x-frame-options"), "{head}");
        assert!(!lower.contains("frame-ancestors"), "{head}");
        assert!(!lower.contains("keep-alive"), "{head}");
        assert!(
            head.contains("Content-Security-Policy: default-src 'self'; img-src *\r\n"),
            "{head}"
        );
        assert!(head.contains("Connection: close"), "{head}");
        assert_eq!(body, b"hello");

        let resp2 = send_raw_http(
            ep.port,
            format!(
                "GET /only-frame-ancestors HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nCookie: kite_sidecar_auth={}\r\n\r\n",
                ep.port, ep.token
            )
            .as_bytes(),
        )
        .await;
        let (head2, body2) = split_http_response(&resp2);
        assert!(!head2.to_ascii_lowercase().contains("content-security-policy"), "{head2}");
        assert!(!head2.to_ascii_lowercase().contains("x-frame-options"), "{head2}");
        assert_eq!(body2, b"ok");
    }

    #[tokio::test]
    async fn offline_upstream_returns_503_service_unavailable() {
        let pool = SidecarProxyPool::new();

        // Case 1: port_lookup returns None
        let ep_none = pool
            .ensure_proxy("ext/offline-none", Arc::new(|| None))
            .unwrap();
        let resp_none = send_raw_http(
            ep_none.port,
            format!(
                "GET / HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nCookie: kite_sidecar_auth={}\r\n\r\n",
                ep_none.port, ep_none.token
            )
            .as_bytes(),
        )
        .await;
        let (head_none, body_none) = split_http_response(&resp_none);
        assert!(head_none.starts_with("HTTP/1.1 503 Service Unavailable"), "{head_none}");
        assert!(head_none.contains("Cache-Control: no-store"), "{head_none}");
        assert!(head_none.contains("Connection: close"), "{head_none}");
        assert!(String::from_utf8_lossy(&body_none).contains("Sidecar Service Unavailable"));

        // Case 2: port_lookup returns an unbound port
        let temp_listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let closed_port = temp_listener.local_addr().unwrap().port();
        drop(temp_listener);

        let ep_closed = pool
            .ensure_proxy("ext/offline-closed", port_fn(closed_port))
            .unwrap();
        let resp_closed = send_raw_http(
            ep_closed.port,
            format!(
                "GET / HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nCookie: kite_sidecar_auth={}\r\n\r\n",
                ep_closed.port, ep_closed.token
            )
            .as_bytes(),
        )
        .await;
        let (head_closed, _) = split_http_response(&resp_closed);
        assert!(
            head_closed.starts_with("HTTP/1.1 503 Service Unavailable"),
            "{head_closed}"
        );
    }

    #[tokio::test]
    async fn post_bodies_and_non_get_query_token_stripping_work() {
        let up_port = spawn_http_test_server(|req_line, _hdrs, body| async move {
            let body_text = String::from_utf8_lossy(&body);
            let out = format!("{req_line}|{body_text}");
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                out.len(),
                out
            )
            .into_bytes()
        })
        .await;

        let pool = SidecarProxyPool::new();
        let ep = pool.ensure_proxy("ext/post-test", port_fn(up_port)).unwrap();

        // POST with __kite_token in query should strip token and forward Content-Length body
        let payload = br#"{"action":"tap","x":10}"#;
        let resp = send_raw_http(
            ep.port,
            format!(
                "POST /api/input?__kite_token={}&dev=1 HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Length: {}\r\n\r\n{}",
                ep.token,
                ep.port,
                payload.len(),
                std::str::from_utf8(payload).unwrap()
            )
            .as_bytes(),
        )
        .await;
        let (head, body) = split_http_response(&resp);
        assert!(head.starts_with("HTTP/1.1 200 OK"), "{head}");
        assert_eq!(
            String::from_utf8_lossy(&body),
            r#"POST /api/input?dev=1 HTTP/1.1|{"action":"tap","x":10}"#
        );

        // Chunked POST upstream test
        let chunked_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let chunked_port = chunked_listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut sock, _) = chunked_listener.accept().await.unwrap();
            let Some((head, mut tail)) =
                read_head_until_crlfcrlf(&mut sock, MAX_HEADER_BYTES, HEADER_READ_TIMEOUT)
                    .await
                    .unwrap()
            else {
                return;
            };
            assert!(String::from_utf8_lossy(&head).contains("Transfer-Encoding: chunked"));
            while !tail.windows(5).any(|w| w == b"0\r\n\r\n") {
                let mut buf = [0u8; 512];
                let n = sock.read(&mut buf).await.unwrap();
                if n == 0 {
                    break;
                }
                tail.extend_from_slice(&buf[..n]);
            }
            let reply = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                tail.len()
            );
            sock.write_all(reply.as_bytes()).await.unwrap();
            sock.write_all(&tail).await.unwrap();
            let _ = sock.shutdown().await;
        });

        let ep2 = pool
            .ensure_proxy("ext/chunked-test", port_fn(chunked_port))
            .unwrap();
        let chunked_req = format!(
            "POST /upload HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nCookie: kite_sidecar_auth={}\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n",
            ep2.port, ep2.token
        );
        let resp_chunked = send_raw_http(ep2.port, chunked_req.as_bytes()).await;
        let (head_chunked, body_chunked) = split_http_response(&resp_chunked);
        assert!(head_chunked.starts_with("HTTP/1.1 200 OK"), "{head_chunked}");
        assert_eq!(body_chunked, b"5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n");
    }

    #[tokio::test]
    async fn sse_streaming_response_flushes_chunks_promptly() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let up_port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let _ = read_head_until_crlfcrlf(&mut sock, MAX_HEADER_BYTES, HEADER_READ_TIMEOUT).await;
            sock.write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\n\r\n",
            )
            .await
            .unwrap();
            sock.write_all(b"data: first\n\n").await.unwrap();
            sock.flush().await.unwrap();
            tokio::time::sleep(Duration::from_millis(120)).await;
            sock.write_all(b"data: second\n\n").await.unwrap();
            sock.flush().await.unwrap();
            let _ = sock.shutdown().await;
        });

        let pool = SidecarProxyPool::new();
        let ep = pool.ensure_proxy("ext/sse-test", port_fn(up_port)).unwrap();

        let mut client = TcpStream::connect(("127.0.0.1", ep.port)).await.unwrap();
        client
            .write_all(
                format!(
                    "GET /events HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nCookie: kite_sidecar_auth={}\r\n\r\n",
                    ep.port, ep.token
                )
                .as_bytes(),
            )
            .await
            .unwrap();

        let mut reader = BufReader::new(client);
        let mut line = String::new();
        loop {
            line.clear();
            reader.read_line(&mut line).await.unwrap();
            if line == "\r\n" {
                break;
            }
        }

        let start = std::time::Instant::now();
        let mut first_event = String::new();
        reader.read_line(&mut first_event).await.unwrap();
        assert_eq!(first_event, "data: first\n");
        assert!(
            start.elapsed() < Duration::from_millis(90),
            "first SSE event should arrive before server finishes sleeping: {:?}",
            start.elapsed()
        );
    }

    #[tokio::test]
    async fn invalid_or_oversized_request_headers_return_400_and_431() {
        let pool = SidecarProxyPool::new();
        let ep = pool
            .ensure_proxy("ext/bad-req", Arc::new(|| None))
            .unwrap();

        let bad_resp = send_raw_http(ep.port, b"INVALID_REQUEST_LINE\r\n\r\n").await;
        let (bad_head, _) = split_http_response(&bad_resp);
        assert!(bad_head.starts_with("HTTP/1.1 400 Bad Request"), "{bad_head}");

        let huge_val = "a".repeat(MAX_HEADER_BYTES + 1024);
        let huge_req = format!(
            "GET / HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nX-Huge: {huge_val}\r\n\r\n",
            ep.port
        );
        let big_resp = send_raw_http(ep.port, huge_req.as_bytes()).await;
        let (big_head, _) = split_http_response(&big_resp);
        assert!(
            big_head.starts_with("HTTP/1.1 431 Request Header Fields Too Large"),
            "{big_head}"
        );
    }

    #[tokio::test]
    async fn websocket_upgrade_101_bidirectional_echo_through_proxy() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let up_port = listener.local_addr().unwrap().port();

        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let ws_stream = tokio_tungstenite::accept_hdr_async(
                stream,
                move |req: &WsRequest, mut resp: WsResponse| -> Result<WsResponse, ErrorResponse> {
                    let host = req
                        .headers()
                        .get("host")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("");
                    let origin = req
                        .headers()
                        .get("origin")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("");
                    let cookie = req
                        .headers()
                        .get("cookie")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("");
                    assert_eq!(host, format!("127.0.0.1:{up_port}"));
                    assert_eq!(origin, format!("http://127.0.0.1:{up_port}"));
                    assert!(
                        !cookie.contains(AUTH_COOKIE_NAME),
                        "auth cookie leaked upstream: {cookie}"
                    );
                    resp.headers_mut()
                        .insert("X-Frame-Options", "DENY".parse().unwrap());
                    Ok(resp)
                },
            )
            .await
            .expect("upstream WS accept");

            let (mut write, mut read) = ws_stream.split();
            while let Some(Ok(msg)) = read.next().await {
                match msg {
                    Message::Text(txt) => {
                        write.send(Message::Text(format!("echo:{txt}"))).await.unwrap();
                    }
                    Message::Binary(bin) => {
                        write.send(Message::Binary(bin)).await.unwrap();
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
        });

        let pool = SidecarProxyPool::new();
        let ep = pool.ensure_proxy("ext/ws-mirror", port_fn(up_port)).unwrap();

        let tcp = TcpStream::connect(("127.0.0.1", ep.port)).await.unwrap();
        let ws_req = tokio_tungstenite::tungstenite::http::Request::builder()
            .uri(format!("ws://127.0.0.1:{}/mirror/ws", ep.port))
            .header("Host", format!("127.0.0.1:{}", ep.port))
            .header("Origin", format!("http://127.0.0.1:{}", ep.port))
            .header("Cookie", format!("{AUTH_COOKIE_NAME}={}; ui=1", ep.token))
            .header("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
            .header("Sec-WebSocket-Version", "13")
            .header("Connection", "Upgrade")
            .header("Upgrade", "websocket")
            .body(())
            .unwrap();

        let (mut ws_client, ws_resp) = tokio_tungstenite::client_async(ws_req, tcp)
            .await
            .expect("WS handshake through proxy should succeed");
        assert_eq!(ws_resp.status().as_u16(), 101);
        assert!(
            !ws_resp.headers().contains_key("x-frame-options"),
            "X-Frame-Options should be stripped from 101 handshake"
        );

        ws_client
            .send(Message::Text("frame-1".to_string()))
            .await
            .unwrap();
        let msg1 = ws_client.next().await.unwrap().unwrap();
        assert_eq!(msg1, Message::Text("echo:frame-1".to_string()));

        ws_client
            .send(Message::Binary(vec![0xde, 0xad, 0xbe, 0xef]))
            .await
            .unwrap();
        let msg2 = ws_client.next().await.unwrap().unwrap();
        assert_eq!(msg2, Message::Binary(vec![0xde, 0xad, 0xbe, 0xef]));

        ws_client.close(None).await.unwrap();
    }

    #[test]
    fn ensure_proxy_reuses_endpoint_updates_lookup_and_shutdown_cleans_up() {
        let pool = SidecarProxyPool::new();
        let active_port = Arc::new(AtomicUsize::new(0));
        let lookup1_port = Arc::clone(&active_port);
        let ep1 = pool
            .ensure_proxy(
                "ext/lifecycle",
                Arc::new(move || {
                    let p = lookup1_port.load(Ordering::Relaxed);
                    if p == 0 {
                        None
                    } else {
                        Some(p as u16)
                    }
                }),
            )
            .unwrap();

        assert_eq!(pool.get_endpoint("ext/lifecycle"), Some(ep1.clone()));

        let ep2 = pool
            .ensure_proxy("ext/lifecycle", port_fn(12345))
            .unwrap();
        assert_eq!(ep1, ep2);

        pool.remove_proxy("ext/lifecycle");
        assert_eq!(pool.get_endpoint("ext/lifecycle"), None);

        let ep3 = pool.ensure_proxy("ext/other", port_fn(12346)).unwrap();
        assert!(pool.get_endpoint("ext/other").is_some());
        pool.shutdown_all();
        assert_eq!(pool.get_endpoint("ext/other"), None);
        drop(ep3);
    }
}
