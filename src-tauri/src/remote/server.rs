use crate::remote::auth::{host_name, percent_decode, AuthStore, PairError, PairedDeviceInfo};
use crate::remote::events::RemoteEventBus;
use crate::remote::rpc::{dispatch_frame, RpcContext};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::{Response as HttpResponse, StatusCode};
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::Message;

const MAX_HEADER_BYTES: usize = 16 * 1024;
const MAX_PAIR_BODY_BYTES: usize = 64 * 1024;
const HEARTBEAT_SECS: u64 = 25;
const MAX_IN_FLIGHT_RPCS: usize = 16;

pub struct ServerHandle {
    pub local_addr: SocketAddr,
    pub shutdown_tx: watch::Sender<bool>,
    pub join_handle: tokio::task::JoinHandle<()>,
}

pub async fn start_server(
    bind_addr: SocketAddr,
    auth: Arc<AuthStore>,
    events: Arc<RemoteEventBus>,
) -> Result<ServerHandle, String> {
    let listener = TcpListener::bind(bind_addr)
        .await
        .map_err(|e| format!("Failed binding remote gateway on {bind_addr}: {e}"))?;
    let local_addr = listener
        .local_addr()
        .map_err(|e| format!("Failed reading local address: {e}"))?;
    let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
    crate::remote::mobile_update::spawn_update_watcher(Arc::clone(&events), shutdown_rx.clone());

    let join_handle = tokio::spawn(async move {
        loop {
            tokio::select! {
                changed = shutdown_rx.changed() => {
                    if changed.is_err() || *shutdown_rx.borrow() {
                        events.disconnect_all();
                        break;
                    }
                }
                accepted = listener.accept() => {
                    match accepted {
                        Ok((stream, _)) => {
                            let auth_c = Arc::clone(&auth);
                            let events_c = Arc::clone(&events);
                            let shutdown_c = shutdown_rx.clone();
                            tokio::spawn(async move {
                                handle_connection(stream, auth_c, events_c, shutdown_c).await;
                            });
                        }
                        Err(_) => tokio::time::sleep(Duration::from_millis(20)).await,
                    }
                }
            }
        }
    });

    Ok(ServerHandle { local_addr, shutdown_tx, join_handle })
}

async fn handle_connection(
    stream: TcpStream,
    auth: Arc<AuthStore>,
    events: Arc<RemoteEventBus>,
    shutdown_rx: watch::Receiver<bool>,
) {
    let head = match peek_http_head(&stream).await {
        Some(bytes) => bytes,
        None => return,
    };
    let head_str = String::from_utf8_lossy(&head);
    let mut lines = head_str.lines();
    let req_line = lines.next().unwrap_or("");
    let target = req_line.split_whitespace().nth(1).unwrap_or("/");
    let path = target.split('?').next().unwrap_or("/");
    let is_ws_upgrade = lines.any(|line| {
        line.split_once(':').is_some_and(|(k, v)| {
            k.trim().eq_ignore_ascii_case("upgrade") && v.to_ascii_lowercase().contains("websocket")
        })
    });

    if is_ws_upgrade && (path == "/ws" || path.starts_with("/ws/")) {
        handle_ws_connection(stream, auth, events, shutdown_rx).await;
    } else {
        handle_http_connection(stream, auth, events).await;
    }
}

async fn peek_http_head(stream: &TcpStream) -> Option<Vec<u8>> {
    let mut buf = [0u8; 8192];
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let Ok(Ok(n)) = tokio::time::timeout(Duration::from_secs(2), stream.peek(&mut buf)).await else {
            return None;
        };
        if n == 0 {
            return None;
        }
        let slice = &buf[..n];
        if slice.windows(4).any(|w| w == b"\r\n\r\n")
            || slice.windows(2).any(|w| w == b"\n\n")
            || n == buf.len()
            || Instant::now() >= deadline
        {
            return Some(slice.to_vec());
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

fn reject_ws(status: StatusCode, message: &str) -> ErrorResponse {
    HttpResponse::builder()
        .status(status)
        .header("Content-Type", "application/json")
        .body(Some(json!({ "error": message }).to_string()))
        .unwrap_or_else(|_| HttpResponse::new(Some(message.to_string())))
}

fn extract_ws_token(req: &Request) -> Option<String> {
    if let Some(auth_val) = req.headers().get("authorization").and_then(|v| v.to_str().ok()) {
        let trimmed = auth_val.trim();
        if trimmed.len() > 7 && trimmed[..7].eq_ignore_ascii_case("bearer ") {
            let tok = trimmed[7..].trim();
            if !tok.is_empty() {
                return Some(tok.to_string());
            }
        }
    }
    let query = req.uri().query()?;
    for pair in query.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            if k == "token" {
                let decoded = percent_decode(v);
                if !decoded.trim().is_empty() {
                    return Some(decoded.trim().to_string());
                }
            }
        }
    }
    None
}

struct WsConnectionGuard {
    device_id: String,
    conn_id: u64,
    events: Arc<RemoteEventBus>,
    subscribed_threads: Arc<Mutex<HashSet<String>>>,
}

impl Drop for WsConnectionGuard {
    fn drop(&mut self) {
        let threads: Vec<String> = {
            let mut set = self.subscribed_threads.lock().unwrap_or_else(|e| e.into_inner());
            set.drain().collect()
        };
        for tid in threads {
            self.events.remove_thread_subscriber(&tid);
        }
        self.events.unregister_connection(&self.device_id, self.conn_id);
    }
}

async fn handle_ws_connection(
    stream: TcpStream,
    auth: Arc<AuthStore>,
    events: Arc<RemoteEventBus>,
    mut shutdown_rx: watch::Receiver<bool>,
) {
    let authed_slot: Arc<Mutex<Option<(PairedDeviceInfo, bool)>>> = Arc::new(Mutex::new(None));
    let auth_c = Arc::clone(&auth);
    let slot_c = Arc::clone(&authed_slot);

    let ws_res = tokio_tungstenite::accept_hdr_async(stream, move |req: &Request, resp: Response| {
        if req.uri().path() != "/ws" {
            return Err(reject_ws(StatusCode::NOT_FOUND, "WebSocket path must be /ws."));
        }
        let Some(token) = extract_ws_token(req) else {
            return Err(reject_ws(StatusCode::UNAUTHORIZED, "Missing device token."));
        };
        let Some((device, needs_persist)) = auth_c.verify_device_token_no_io(&token) else {
            return Err(reject_ws(StatusCode::UNAUTHORIZED, "Invalid or revoked device token."));
        };
        *slot_c.lock().unwrap_or_else(|e| e.into_inner()) = Some((device, needs_persist));
        Ok(resp)
    })
    .await;

    let Ok(ws_stream) = ws_res else { return };
    let Some((device, needs_persist)) = authed_slot.lock().unwrap_or_else(|e| e.into_inner()).take() else {
        return;
    };
    if needs_persist {
        let auth_p = Arc::clone(&auth);
        let _ = tokio::task::spawn_blocking(move || auth_p.flush_config_to_disk());
    }

    let (conn_id, mut kill_rx) = events.register_connection(&device.id);
    let subscribed_threads = Arc::new(Mutex::new(HashSet::new()));
    let _guard = WsConnectionGuard {
        device_id: device.id.clone(),
        conn_id,
        events: Arc::clone(&events),
        subscribed_threads: Arc::clone(&subscribed_threads),
    };

    let ctx = Arc::new(RpcContext {
        auth,
        events: Arc::clone(&events),
        subscribed_threads: Arc::clone(&subscribed_threads),
    });
    let rpc_sem = Arc::new(tokio::sync::Semaphore::new(MAX_IN_FLIGHT_RPCS));
    let (mut ws_tx, mut ws_rx) = ws_stream.split();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
    let mut event_rx = events.subscribe_events();
    let mut heartbeat = tokio::time::interval(Duration::from_secs(HEARTBEAT_SECS));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    heartbeat.tick().await;

    loop {
        tokio::select! {
            msg = ws_rx.next() => match msg {
                Some(Ok(Message::Text(txt))) => {
                    let permit = match Arc::clone(&rpc_sem).try_acquire_owned() {
                        Ok(p) => p,
                        Err(_) => {
                            let req_id = serde_json::from_str::<Value>(&txt)
                                .ok()
                                .and_then(|v| v.get("id").and_then(Value::as_str).map(str::to_string))
                                .unwrap_or_default();
                            let err = crate::remote::rpc::err_frame(
                                &req_id,
                                crate::remote::rpc::RpcError::new("rate_limited", "Too many concurrent RPC requests."),
                            );
                            let _ = out_tx.send(err);
                            continue;
                        }
                    };
                    let ctx_c = Arc::clone(&ctx);
                    let out_tx_c = out_tx.clone();
                    tokio::spawn(async move {
                        let _permit = permit;
                        if let Some(reply) = dispatch_frame(&ctx_c, &txt).await {
                            let _ = out_tx_c.send(reply);
                        }
                    });
                }
                Some(Ok(Message::Ping(data))) => {
                    if ws_tx.send(Message::Pong(data)).await.is_err() { break; }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            },
            out = out_rx.recv() => match out {
                Some(txt) => if ws_tx.send(Message::Text(txt)).await.is_err() { break; },
                None => break,
            },
            ev = event_rx.recv() => match ev {
                Ok(push) => {
                    if let Some(ref tid) = push.thread_id {
                        if !subscribed_threads.lock().unwrap_or_else(|e| e.into_inner()).contains(tid) {
                            continue;
                        }
                    }
                    if ws_tx.send(Message::Text(push.to_wire_json())).await.is_err() { break; }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                    let (seq, ts) = events.next_seq_and_ts();
                    let notice = json!({
                        "type": "event",
                        "event": "gateway.resync_required",
                        "seq": seq,
                        "ts": ts,
                        "payload": { "skipped": skipped },
                    })
                    .to_string();
                    if ws_tx.send(Message::Text(notice)).await.is_err() { break; }
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            },
            _ = kill_rx.changed() => {
                if *kill_rx.borrow() {
                    let _ = ws_tx.send(Message::Close(Some(CloseFrame {
                        code: CloseCode::Policy,
                        reason: "Device revoked".into(),
                    }))).await;
                    break;
                }
            }
            _ = shutdown_rx.changed() => {
                if *shutdown_rx.borrow() {
                    let _ = ws_tx.send(Message::Close(Some(CloseFrame {
                        code: CloseCode::Away,
                        reason: "Gateway shutting down".into(),
                    }))).await;
                    break;
                }
            }
            _ = heartbeat.tick() => {
                let ping = json!({ "type": "ping", "ts": crate::remote::auth::now_unix_ms() }).to_string();
                if ws_tx.send(Message::Text(ping)).await.is_err() { break; }
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairBody {
    code: String,
    secret: String,
    device_name: String,
    platform: String,
}

async fn handle_http_connection(
    mut stream: TcpStream,
    auth: Arc<AuthStore>,
    events: Arc<RemoteEventBus>,
) {
    let mut buf = Vec::with_capacity(2048);
    let mut tmp = [0u8; 2048];
    let header_end: usize;
    let sep_len: usize;
    loop {
        let Ok(Ok(n)) = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut tmp)).await else {
            return;
        };
        if n == 0 { return; }
        buf.extend_from_slice(&tmp[..n]);
        if let Some(pos) = find_subslice(&buf, b"\r\n\r\n") {
            header_end = pos; sep_len = 4; break;
        }
        if let Some(pos) = find_subslice(&buf, b"\n\n") {
            header_end = pos; sep_len = 2; break;
        }
        if buf.len() > MAX_HEADER_BYTES {
            let _ = write_http(&mut stream, 431, "Request Header Fields Too Large", Some(json!({ "error": "Headers too large" }))).await;
            return;
        }
    }

    let head_str = String::from_utf8_lossy(&buf[..header_end]);
    let mut lines = head_str.lines();
    let req_line = lines.next().unwrap_or("");
    let mut parts = req_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_ascii_uppercase();
    let raw_target = parts.next().unwrap_or("/");
    let (path, raw_query) = raw_target.split_once('?').unwrap_or((raw_target, ""));

    let mut content_len: usize = 0;
    let mut auth_header: Option<String> = None;
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            let key = k.trim();
            if key.eq_ignore_ascii_case("authorization") {
                auth_header = Some(v.trim().to_string());
            } else if key.eq_ignore_ascii_case("content-length") {
                match v.trim().parse::<usize>() {
                    Ok(len) if len <= MAX_PAIR_BODY_BYTES => content_len = len,
                    Ok(_) => {
                        let _ = write_http(&mut stream, 413, "Payload Too Large", Some(json!({ "error": "Body exceeds 64 KiB limit" }))).await;
                        return;
                    }
                    Err(_) => {
                        let _ = write_http(&mut stream, 400, "Bad Request", Some(json!({ "error": "Invalid Content-Length" }))).await;
                        return;
                    }
                }
            }
        }
    }

    let body_start = header_end + sep_len;
    let mut body = buf[body_start..].to_vec();
    if body.len() > MAX_PAIR_BODY_BYTES {
        let _ = write_http(&mut stream, 413, "Payload Too Large", Some(json!({ "error": "Body exceeds 64 KiB limit" }))).await;
        return;
    }
    while body.len() < content_len {
        let Ok(Ok(n)) = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut tmp)).await else {
            return;
        };
        if n == 0 { break; }
        body.extend_from_slice(&tmp[..n]);
        if body.len() > MAX_PAIR_BODY_BYTES {
            let _ = write_http(&mut stream, 413, "Payload Too Large", Some(json!({ "error": "Body exceeds 64 KiB limit" }))).await;
            return;
        }
    }
    if body.len() > content_len && content_len > 0 {
        body.truncate(content_len);
    }

    match (method.as_str(), path) {
        ("OPTIONS", _) => { let _ = write_http(&mut stream, 204, "No Content", None).await; }
        ("GET", "/api/v1/health") => {
            let payload = json!({
                "ok": true,
                "protocol": "kite-remote/v1",
                "appVersion": env!("CARGO_PKG_VERSION"),
                "hostName": host_name(),
                "pairingActive": auth.has_active_pairing(),
            });
            let _ = write_http(&mut stream, 200, "OK", Some(payload)).await;
        }
        ("GET", "/api/v1/session") => {
            let Some(device) = verify_http_token(&mut stream, &auth, auth_header.as_deref(), raw_query).await else {
                return;
            };
            let _ = write_http(&mut stream, 200, "OK", Some(json!({ "ok": true, "deviceId": device.id }))).await;
        }
        ("GET", "/api/v1/mobile/update") => {
            if verify_http_token(&mut stream, &auth, auth_header.as_deref(), raw_query).await.is_none() {
                return;
            }
            let current_version_code = parse_query_u32(raw_query, "currentVersionCode");
            let Ok(payload) = tokio::task::spawn_blocking(move || {
                crate::remote::mobile_update::check_mobile_update(current_version_code)
            })
            .await
            else {
                let _ = write_http(
                    &mut stream,
                    500,
                    "Internal Server Error",
                    Some(json!({ "error": "Mobile update check failed" })),
                )
                .await;
                return;
            };
            let _ = write_http(&mut stream, 200, "OK", Some(payload)).await;
        }
        ("GET", "/api/v1/mobile/update/apk") => {
            if verify_http_token(&mut stream, &auth, auth_header.as_deref(), raw_query).await.is_none() {
                return;
            }
            let latest = tokio::task::spawn_blocking(crate::remote::mobile_update::read_latest_manifest)
                .await
                .ok()
                .flatten();
            let Some((manifest, apk_path)) = latest else {
                let _ = write_http(
                    &mut stream,
                    404,
                    "Not Found",
                    Some(json!({ "error": "No mobile APK update available" })),
                )
                .await;
                return;
            };
            let Ok(mut file) = tokio::fs::File::open(&apk_path).await else {
                let _ = write_http(
                    &mut stream,
                    404,
                    "Not Found",
                    Some(json!({ "error": "Mobile APK file not found" })),
                )
                .await;
                return;
            };
            let Ok(meta) = file.metadata().await else {
                let _ = write_http(
                    &mut stream,
                    500,
                    "Internal Server Error",
                    Some(json!({ "error": "Failed reading APK metadata" })),
                )
                .await;
                return;
            };
            let safe_sha256: String = manifest
                .sha256
                .chars()
                .filter(|c| !matches!(c, '\r' | '\n'))
                .collect();
            let headers = format!(
                "HTTP/1.1 200 OK\r\n\
                 Content-Type: application/vnd.android.package-archive\r\n\
                 Content-Length: {}\r\n\
                 Content-Disposition: attachment; filename=\"{}\"\r\n\
                 X-Kite-Apk-Sha256: {}\r\n\
                 Cache-Control: no-store\r\n\
                 Access-Control-Allow-Origin: *\r\n\
                 Connection: close\r\n\r\n",
                meta.len(),
                manifest.filename,
                safe_sha256,
            );
            if stream_http_file(&mut stream, &headers, &mut file).await.is_err() {
                return;
            }
        }
        ("GET", "/api/v1/workspace/file/raw") => {
            if verify_http_token(&mut stream, &auth, auth_header.as_deref(), raw_query)
                .await
                .is_none()
            {
                return;
            }
            let Some(raw_path) = parse_query_str(raw_query, "path") else {
                let _ = write_http(
                    &mut stream,
                    400,
                    "Bad Request",
                    Some(json!({ "error": "path query parameter is required", "code": "invalid_params" })),
                )
                .await;
                return;
            };
            let workspace_id = parse_query_str(raw_query, "workspaceId");
            let relative_to = parse_query_str(raw_query, "relativeTo");
            let resolved_res = tokio::task::spawn_blocking(move || {
                crate::remote::file_preview::resolve_raw_preview_for_http(
                    workspace_id.as_deref(),
                    &raw_path,
                    relative_to.as_deref(),
                )
            })
            .await;
            let Ok(res) = resolved_res else {
                let _ = write_http(
                    &mut stream,
                    500,
                    "Internal Server Error",
                    Some(json!({ "error": "File preview resolution failed", "code": "internal_error" })),
                )
                .await;
                return;
            };
            let resolved = match res {
                Ok(r) => r,
                Err(err) => {
                    let _ = write_http(
                        &mut stream,
                        err.status,
                        err.reason,
                        Some(json!({ "error": err.message, "code": err.code })),
                    )
                    .await;
                    return;
                }
            };
            let Ok(mut file) = tokio::fs::File::open(&resolved.canon_path).await else {
                let _ = write_http(
                    &mut stream,
                    404,
                    "Not Found",
                    Some(json!({ "error": "Preview file not found", "code": "not_found" })),
                )
                .await;
                return;
            };
            let Ok(meta) = file.metadata().await else {
                let _ = write_http(
                    &mut stream,
                    500,
                    "Internal Server Error",
                    Some(json!({ "error": "Failed reading file metadata", "code": "internal_error" })),
                )
                .await;
                return;
            };
            if meta.len() > crate::remote::file_preview::MAX_IMAGE_BYTES {
                let _ = write_http(
                    &mut stream,
                    413,
                    "Payload Too Large",
                    Some(json!({ "error": "File exceeds the 15 MiB mobile preview limit.", "code": "payload_too_large" })),
                )
                .await;
                return;
            }
            let headers = format!(
                "HTTP/1.1 200 OK\r\n\
                 Content-Type: {}\r\n\
                 Content-Length: {}\r\n\
                 X-Content-Type-Options: nosniff\r\n\
                 Content-Security-Policy: default-src 'none'\r\n\
                 Cache-Control: private, max-age=30\r\n\
                 Access-Control-Allow-Origin: *\r\n\
                 Connection: close\r\n\r\n",
                resolved.mime_type,
                meta.len(),
            );
            let _ = stream_http_file(&mut stream, &headers, &mut file).await;
        }
        ("POST", "/api/v1/pair") => {
            let Ok(req) = serde_json::from_slice::<PairBody>(&body) else {
                let _ = write_http(&mut stream, 400, "Bad Request", Some(json!({ "error": "Malformed JSON payload" }))).await;
                return;
            };
            let auth_c = Arc::clone(&auth);
            let pair_res = tokio::task::spawn_blocking(move || {
                auth_c.verify_and_consume_pairing(&req.code, &req.secret, &req.device_name, &req.platform)
            })
            .await;
            let Ok(result) = pair_res else {
                let _ = write_http(&mut stream, 500, "Internal Server Error", Some(json!({ "error": "Pairing worker failed" }))).await;
                return;
            };
            match result {
                Ok((device, token)) => {
                    events.publish("gateway.devices_changed", json!({ "count": auth.device_count() }));
                    let _ = write_http(&mut stream, 200, "OK", Some(json!({
                        "deviceId": device.id,
                        "deviceToken": token,
                        "hostName": host_name(),
                        "protocol": "kite-remote/v1",
                        "wsPath": "/ws",
                    }))).await;
                }
                Err(PairError::BadRequest(msg)) => { let _ = write_http(&mut stream, 400, "Bad Request", Some(json!({ "error": msg }))).await; }
                Err(PairError::Unauthorized(msg)) => {
                    tokio::time::sleep(Duration::from_millis(250)).await;
                    let _ = write_http(&mut stream, 401, "Unauthorized", Some(json!({ "error": msg }))).await;
                }
                Err(PairError::Gone(msg)) => {
                    tokio::time::sleep(Duration::from_millis(250)).await;
                    let _ = write_http(&mut stream, 410, "Gone", Some(json!({ "error": msg }))).await;
                }
            }
        }
        _ => { let _ = write_http(&mut stream, 404, "Not Found", Some(json!({ "error": "Not found" }))).await; }
    }
}

fn extract_http_token(auth_header: Option<&str>, raw_query: &str) -> Option<String> {
    auth_header
        .and_then(|raw| {
            let trimmed = raw.trim();
            if trimmed.len() > 7 && trimmed[..7].eq_ignore_ascii_case("bearer ") {
                Some(trimmed[7..].trim())
            } else {
                None
            }
        })
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| {
            raw_query.split('&').find_map(|kv| {
                let (k, v) = kv.split_once('=')?;
                if k == "token" && !v.trim().is_empty() {
                    let decoded = percent_decode(v.trim());
                    let tok = decoded.trim();
                    if tok.is_empty() { None } else { Some(tok.to_string()) }
                } else {
                    None
                }
            })
        })
}

fn parse_query_str(raw_query: &str, key: &str) -> Option<String> {
    raw_query.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        if k == key {
            let decoded = percent_decode(v.trim());
            let trimmed = decoded.trim_matches(' ');
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        } else {
            None
        }
    })
}

fn parse_query_u32(raw_query: &str, key: &str) -> Option<u32> {
    raw_query.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        if k == key {
            let decoded = percent_decode(v.trim());
            decoded.trim().parse::<u32>().ok()
        } else {
            None
        }
    })
}

async fn verify_http_token(
    stream: &mut TcpStream,
    auth: &Arc<AuthStore>,
    auth_header: Option<&str>,
    raw_query: &str,
) -> Option<PairedDeviceInfo> {
    let Some(tok) = extract_http_token(auth_header, raw_query) else {
        let _ = write_http(
            stream,
            401,
            "Unauthorized",
            Some(json!({ "error": "Missing device token" })),
        )
        .await;
        return None;
    };
    let auth_c = Arc::clone(auth);
    let verified = tokio::task::spawn_blocking(move || auth_c.verify_device_token(&tok))
        .await
        .ok()
        .flatten();
    if verified.is_none() {
        let _ = write_http(
            stream,
            401,
            "Unauthorized",
            Some(json!({ "error": "Invalid or revoked device token" })),
        )
        .await;
    }
    verified
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

async fn stream_http_file(
    stream: &mut TcpStream,
    headers: &str,
    file: &mut tokio::fs::File,
) -> std::io::Result<()> {
    stream.write_all(headers.as_bytes()).await?;
    let mut chunk = vec![0u8; 65536];
    loop {
        let n = file.read(&mut chunk).await?;
        if n == 0 {
            break;
        }
        stream.write_all(&chunk[..n]).await?;
    }
    stream.flush().await?;
    let _ = stream.shutdown().await;
    Ok(())
}

async fn write_http(stream: &mut TcpStream, status: u16, reason: &str, json_body: Option<Value>) -> std::io::Result<()> {
    let body_bytes = json_body.map(|v| v.to_string().into_bytes()).unwrap_or_default();
    let content_type = if body_bytes.is_empty() { "" } else { "Content-Type: application/json\r\n" };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\n{content_type}Content-Length: {}\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Access-Control-Allow-Headers: Content-Type, Authorization\r\n\
         Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n\
         Connection: close\r\n\r\n",
        body_bytes.len()
    );
    stream.write_all(head.as_bytes()).await?;
    if !body_bytes.is_empty() {
        stream.write_all(&body_bytes).await?;
    }
    stream.flush().await?;
    let _ = stream.shutdown().await;
    Ok(())
}
