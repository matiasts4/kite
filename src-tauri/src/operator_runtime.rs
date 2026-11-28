// Kite Code — operator agent runtime (Tauri IPC)
// Executes fast headless turns for the Kite Operator Assistant (AntiGravity, Grok, Codex)
// without launching visible windows or full TUI sessions.

use crate::chat::resolve_bin;
use crate::hidden_exec;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::Emitter;

#[path = "operator_warm_agy.rs"]
mod warm_agy;

pub use warm_agy::{reap_idle_warm_operator, shutdown_warm_operator_sessions};

pub fn query_operator_agent_direct(request: Value) -> Value {
    let req = request.get("request").unwrap_or(&request);

    let engine = req
        .get("engine")
        .and_then(|v| v.as_str())
        .unwrap_or("antigravity");

    let file_prompt = req
        .get("promptFile")
        .and_then(|v| v.as_str())
        .and_then(|path| std::fs::read_to_string(path).ok());

    let inline_prompt = req
        .get("prompt")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let prompt_owned = file_prompt.unwrap_or_else(|| inline_prompt.to_string());
    let prompt = prompt_owned.trim();

    let model = req
        .get("model")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let timeout_secs = req
        .get("timeoutSecs")
        .and_then(|v| v.as_u64())
        .unwrap_or(20);

    let start = Instant::now();

    if engine == "antigravity" || engine == "agy" {
        let Some(bin) = crate::chat::utils::resolve_agy_bin() else {
            return json!({
                "success": false,
                "error": "Antigravity CLI (agy) no está instalado o no se encuentra en el PATH.",
                "latencyMs": start.elapsed().as_millis() as u64
            });
        };

        return match warm_agy::run_warm_antigravity_turn(
            &bin,
            model,
            prompt,
            Duration::from_secs(timeout_secs),
        ) {
            Ok(stdout) => json!({
                "success": true,
                "stdout": stdout,
                "latencyMs": start.elapsed().as_millis() as u64,
                "engine": engine,
                "model": model
            }),
            Err(err) if err.timed_out => json!({
                "success": false,
                "error": format!("Tiempo de espera agotado ({timeout_secs}s) ejecutando {engine}"),
                "latencyMs": start.elapsed().as_millis() as u64
            }),
            Err(err) => json!({
                "success": false,
                "error": err.message,
                "latencyMs": start.elapsed().as_millis() as u64
            }),
        };
    }

    let (bin, args) = match engine {
        "grok" => {
            let bin = match resolve_bin("grok", &[]) {
                Some(b) => b,
                None => {
                    return json!({
                        "success": false,
                        "error": "Grok CLI no está instalado o no se encuentra en el PATH.",
                        "latencyMs": start.elapsed().as_millis() as u64
                    });
                }
            };

            let mut args = vec!["-p", prompt];
            if let Some(m) = model {
                args.push("-m");
                args.push(m);
            }
            (bin, args)
        }
        "codex" => {
            let bin = match crate::chat::utils::resolve_codex_bin() {
                Some(b) => b,
                None => {
                    return json!({
                        "success": false,
                        "error": "Codex no está instalado o no se encuentra en el PATH.",
                        "latencyMs": start.elapsed().as_millis() as u64
                    });
                }
            };

            let mut args = vec!["exec", prompt];
            if let Some(m) = model {
                args.push("--model");
                args.push(m);
            }
            (bin, args)
        }
        _ => {
            return json!({
                "success": false,
                "error": format!("Motor '{engine}' no soportado para consultas directas del operador."),
                "latencyMs": start.elapsed().as_millis() as u64
            });
        }
    };

    match hidden_exec::run(&bin, &args, Duration::from_secs(timeout_secs)) {
        Ok(out) => {
            let latency_ms = start.elapsed().as_millis() as u64;
            if out.timed_out {
                json!({
                    "success": false,
                    "error": format!("Tiempo de espera agotado ({timeout_secs}s) ejecutando {engine}"),
                    "latencyMs": latency_ms
                })
            } else if out.success() {
                json!({
                    "success": true,
                    "stdout": out.stdout_lossy().trim(),
                    "latencyMs": latency_ms,
                    "engine": engine,
                    "model": model
                })
            } else {
                json!({
                    "success": false,
                    "error": format!("Error en {engine} (código {:?}): {}", out.code, String::from_utf8_lossy(&out.stderr)),
                    "stdout": out.stdout_lossy().trim(),
                    "latencyMs": latency_ms
                })
            }
        }
        Err(err) => {
            json!({
                "success": false,
                "error": format!("Error ejecutando {engine}: {err}"),
                "latencyMs": start.elapsed().as_millis() as u64
            })
        }
    }
}

#[tauri::command]
pub async fn query_operator_agent(request: Value) -> Value {
    tauri::async_runtime::spawn_blocking(move || query_operator_agent_direct(request))
        .await
        .unwrap_or_else(|err| {
            json!({
                "success": false,
                "error": format!("Operator runtime join error: {err}"),
                "latencyMs": 0
            })
        })
}

pub fn prewarm_operator_agent_direct(request: Value) -> Value {
    let req = request.get("request").unwrap_or(&request);
    let engine = req
        .get("engine")
        .and_then(|v| v.as_str())
        .unwrap_or("antigravity");
    let model = req
        .get("model")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());

    if engine != "antigravity" && engine != "agy" {
        return json!({
            "success": true,
            "warmed": false,
            "engine": engine,
            "model": model
        });
    }

    let Some(bin) = crate::chat::utils::resolve_agy_bin() else {
        return json!({
            "success": false,
            "error": "Antigravity CLI (agy) no está instalado o no se encuentra en el PATH."
        });
    };

    match warm_agy::prewarm_warm_antigravity_session(&bin, model) {
        Ok(warmed) => json!({
            "success": true,
            "warmed": warmed,
            "engine": engine,
            "model": model
        }),
        Err(error) => json!({
            "success": false,
            "error": error
        }),
    }
}

#[tauri::command]
pub async fn prewarm_operator_agent(request: Value) -> Value {
    tauri::async_runtime::spawn_blocking(move || prewarm_operator_agent_direct(request))
        .await
        .unwrap_or_else(|err| {
            json!({
                "success": false,
                "error": format!("Operator runtime join error: {err}")
            })
        })
}

fn shared_http_client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .pool_idle_timeout(Duration::from_secs(90))
                .pool_max_idle_per_host(8)
                .tcp_keepalive(Duration::from_secs(30))
                .connect_timeout(Duration::from_secs(10))
                .build()
                .map_err(|e| format!("Failed to create pooled HTTP client: {e}"))
        })
        .as_ref()
        .map_err(|e| e.clone())
}

fn stream_cancel_registry(
) -> &'static Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>> =
        OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

struct PreparedOperatorHttpRequest {
    url: String,
    builder: reqwest::RequestBuilder,
    is_opencode_go_endpoint: bool,
    opencode_go_authenticated: bool,
    opencode_session: Option<String>,
}

fn prepare_operator_http_request(req: &Value) -> Result<PreparedOperatorHttpRequest, Value> {
    let url = match req.get("url").and_then(|v| v.as_str()) {
        Some(u) if !u.trim().is_empty() => u.to_string(),
        _ => {
            return Err(json!({
                "success": false,
                "error": "Missing 'url' parameter",
                "latencyMs": 0
            }));
        }
    };

    let method_str = req
        .get("method")
        .and_then(|v| v.as_str())
        .unwrap_or("GET")
        .to_uppercase();

    let timeout_secs = req
        .get("timeoutSecs")
        .and_then(|v| v.as_u64())
        .unwrap_or(30);

    let client = match shared_http_client() {
        Ok(c) => c,
        Err(e) => {
            return Err(json!({
                "success": false,
                "error": e,
                "latencyMs": 0
            }));
        }
    };

    let method = match method_str.as_str() {
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        "DELETE" => reqwest::Method::DELETE,
        "PATCH" => reqwest::Method::PATCH,
        "HEAD" => reqwest::Method::HEAD,
        _ => reqwest::Method::GET,
    };

    let mut builder = client
        .request(method, &url)
        .timeout(Duration::from_secs(timeout_secs));

    let mut has_authorization = false;
    let mut sent_authorization: Option<String> = None;
    let mut opencode_session: Option<String> = None;
    if let Some(headers) = req.get("headers").and_then(|v| v.as_object()) {
        for (k, v) in headers {
            if let Some(val_str) = v.as_str() {
                if val_str.trim().is_empty() {
                    continue;
                }
                if k.eq_ignore_ascii_case("authorization") {
                    has_authorization = true;
                    sent_authorization = Some(val_str.to_string());
                }
                if k.eq_ignore_ascii_case("x-opencode-session") {
                    opencode_session = Some(val_str.to_string());
                }
                builder = builder.header(k, val_str);
            }
        }
    }

    let is_opencode_go_endpoint = req
        .get("credentialProvider")
        .and_then(|v| v.as_str())
        == Some("opencode")
        && matches!(
            url.trim(),
            crate::quota::OPENCODE_GO_CHAT_ENDPOINT | crate::quota::OPENCODE_GO_MODELS_ENDPOINT
        );

    // OpenCode Go inference never receives the token from the webview. The
    // native proxy reads it from the local OpenCode CLI credential store and
    // injects both the Authorization and the required session header.
    let mut opencode_go_authenticated = false;
    if req
        .get("credentialProvider")
        .and_then(|v| v.as_str())
        == Some("opencode")
    {
        if !has_authorization {
            match crate::quota::resolve_opencode_go_api_key() {
                Some((token, _source)) => {
                    builder = builder.header("Authorization", format!("Bearer {token}"));
                    opencode_go_authenticated = is_opencode_go_endpoint;
                }
                None => {
                    let message = "No se encontró una credencial de OpenCode Go. Ejecutá `opencode auth login opencode-go` o guardá una API key en Kite.";
                    return Err(json!({
                        "success": false,
                        "status": 401,
                        "body": json!({ "error": { "message": message } }).to_string(),
                        "error": message,
                        "latencyMs": 0
                    }));
                }
            }
        } else if is_opencode_go_endpoint {
            // A webview-supplied key only verifies the Go connection when it is
            // the same key the native resolver reads; otherwise the request
            // authenticated some other account.
            let native = crate::quota::resolve_opencode_go_api_key();
            if let (Some((token, _source)), Some(sent)) =
                (native.as_ref(), sent_authorization.as_deref())
            {
                opencode_go_authenticated = bearer_token(sent) == Some(token.as_str());
            }
        }
        if opencode_session.is_none() {
            let session = format!("ses_kite_{}", uuid::Uuid::new_v4().simple());
            builder = builder.header("x-opencode-session", &session);
            opencode_session = Some(session);
        }
    }

    if let Some(b64) = req.get("bodyBase64").and_then(|v| v.as_str()) {
        if let Some(bytes) = crate::chat_attachments::decode_base64(b64.trim()) {
            builder = builder.body(bytes);
        } else {
            return Err(json!({
                "success": false,
                "error": "Failed to decode bodyBase64: invalid base64 encoding",
                "latencyMs": 0
            }));
        }
    } else if let Some(body) = req.get("body") {
        if let Some(s) = body.as_str() {
            builder = builder.body(s.to_string());
        } else if !body.is_null() {
            builder = builder.body(body.to_string());
        }
    }

    Ok(PreparedOperatorHttpRequest {
        url,
        builder,
        is_opencode_go_endpoint,
        opencode_go_authenticated,
        opencode_session,
    })
}

/// Drains all complete leading UTF-8 characters from `pending`, leaving any
/// incomplete trailing multi-byte sequence for the next network chunk.
fn drain_complete_utf8(pending: &mut Vec<u8>) -> String {
    if pending.is_empty() {
        return String::new();
    }
    match std::str::from_utf8(pending) {
        Ok(valid) => {
            let out = valid.to_string();
            pending.clear();
            out
        }
        Err(err) => {
            let valid_up_to = err.valid_up_to();
            let mut out = String::new();
            if valid_up_to > 0 {
                if let Ok(valid) = std::str::from_utf8(&pending[..valid_up_to]) {
                    out.push_str(valid);
                }
            }
            if let Some(error_len) = err.error_len() {
                // Invalid UTF-8 bytes in the middle: replace and continue.
                out.push('\u{FFFD}');
                let drain_end = (valid_up_to + error_len).min(pending.len());
                pending.drain(..drain_end);
                out.push_str(&drain_complete_utf8(pending));
            } else {
                // Incomplete multi-byte sequence at end of chunk: wait for next chunk.
                pending.drain(..valid_up_to);
            }
            out
        }
    }
}

#[tauri::command]
pub async fn proxy_operator_http(request: Value) -> Value {
    let req = request.get("request").unwrap_or(&request);
    let start = Instant::now();

    let prepared = match prepare_operator_http_request(req) {
        Ok(p) => p,
        Err(err_json) => return err_json,
    };

    match prepared.builder.send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            if prepared.is_opencode_go_endpoint && prepared.opencode_go_authenticated {
                crate::quota::record_opencode_go_probe(
                    prepared.url.trim(),
                    prepared.opencode_session.as_deref(),
                    (200..300).contains(&status),
                    Some(status),
                );
            }
            match resp.text().await {
                Ok(text) => {
                    let latency_ms = start.elapsed().as_millis() as u64;
                    json!({
                        "success": status >= 200 && status < 300,
                        "status": status,
                        "body": text,
                        "latencyMs": latency_ms
                    })
                }
                Err(e) => {
                    let latency_ms = start.elapsed().as_millis() as u64;
                    json!({
                        "success": false,
                        "status": status,
                        "error": format!("Failed to read response body: {e}"),
                        "latencyMs": latency_ms
                    })
                }
            }
        }
        Err(e) => {
            let latency_ms = start.elapsed().as_millis() as u64;
            json!({
                "success": false,
                "error": format!("HTTP request failed: {e}"),
                "latencyMs": latency_ms
            })
        }
    }
}

#[tauri::command]
pub async fn proxy_operator_http_stream(app: tauri::AppHandle, request: Value) -> Value {
    let req = request.get("request").unwrap_or(&request);
    let start = Instant::now();

    let request_id = req
        .get("requestId")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("stream-{}", uuid::Uuid::new_v4().simple()));

    let prepared = match prepare_operator_http_request(req) {
        Ok(p) => p,
        Err(err_json) => return err_json,
    };

    let event_name = format!("operator:http-stream:{request_id}");
    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();
    if let Ok(mut reg) = stream_cancel_registry().lock() {
        reg.insert(request_id.clone(), cancel_tx);
    }

    let cleanup = |id: &str| {
        if let Ok(mut reg) = stream_cancel_registry().lock() {
            reg.remove(id);
        }
    };

    let send_result = tokio::select! {
        _ = &mut cancel_rx => {
            cleanup(&request_id);
            let _ = app.emit(&event_name, json!({ "kind": "aborted", "latencyMs": start.elapsed().as_millis() as u64 }));
            return json!({
                "success": false,
                "aborted": true,
                "requestId": request_id,
                "latencyMs": start.elapsed().as_millis() as u64
            });
        }
        res = prepared.builder.send() => res
    };

    let mut resp = match send_result {
        Ok(r) => r,
        Err(e) => {
            cleanup(&request_id);
            let latency_ms = start.elapsed().as_millis() as u64;
            let err_msg = format!("HTTP stream request failed: {e}");
            let _ = app.emit(&event_name, json!({ "kind": "error", "error": err_msg, "latencyMs": latency_ms }));
            return json!({
                "success": false,
                "requestId": request_id,
                "error": err_msg,
                "latencyMs": latency_ms
            });
        }
    };

    let status = resp.status().as_u16();
    let ok = (200..300).contains(&status);
    if prepared.is_opencode_go_endpoint && prepared.opencode_go_authenticated {
        crate::quota::record_opencode_go_probe(
            prepared.url.trim(),
            prepared.opencode_session.as_deref(),
            ok,
            Some(status),
        );
    }

    let _ = app.emit(
        &event_name,
        json!({
            "kind": "meta",
            "status": status,
            "ok": ok,
            "latencyMs": start.elapsed().as_millis() as u64
        }),
    );

    let mut pending_utf8: Vec<u8> = Vec::new();
    let mut aborted = false;

    loop {
        let next_chunk = tokio::select! {
            _ = &mut cancel_rx => {
                aborted = true;
                break;
            }
            chunk = resp.chunk() => chunk
        };

        match next_chunk {
            Ok(Some(bytes)) => {
                if bytes.is_empty() {
                    continue;
                }
                pending_utf8.extend_from_slice(&bytes);
                let text = drain_complete_utf8(&mut pending_utf8);
                if !text.is_empty() {
                    let _ = app.emit(
                        &event_name,
                        json!({
                            "kind": "chunk",
                            "text": text
                        }),
                    );
                }
            }
            Ok(None) => break,
            Err(e) => {
                cleanup(&request_id);
                let latency_ms = start.elapsed().as_millis() as u64;
                let err_msg = format!("HTTP stream read failed: {e}");
                let _ = app.emit(&event_name, json!({ "kind": "error", "error": err_msg, "latencyMs": latency_ms }));
                return json!({
                    "success": false,
                    "status": status,
                    "requestId": request_id,
                    "error": err_msg,
                    "latencyMs": latency_ms
                });
            }
        }
    }

    cleanup(&request_id);
    let latency_ms = start.elapsed().as_millis() as u64;

    if aborted {
        let _ = app.emit(&event_name, json!({ "kind": "aborted", "latencyMs": latency_ms }));
        return json!({
            "success": false,
            "status": status,
            "aborted": true,
            "requestId": request_id,
            "latencyMs": latency_ms
        });
    }

    if !pending_utf8.is_empty() {
        let tail = String::from_utf8_lossy(&pending_utf8).to_string();
        if !tail.is_empty() {
            let _ = app.emit(&event_name, json!({ "kind": "chunk", "text": tail }));
        }
    }

    let _ = app.emit(
        &event_name,
        json!({
            "kind": "done",
            "status": status,
            "latencyMs": latency_ms
        }),
    );

    json!({
        "success": ok,
        "status": status,
        "requestId": request_id,
        "latencyMs": latency_ms
    })
}

pub fn cancel_operator_http_stream_direct(request_id: &str) -> bool {
    if let Ok(mut reg) = stream_cancel_registry().lock() {
        if let Some(tx) = reg.remove(request_id) {
            let _ = tx.send(());
            return true;
        }
    }
    false
}

#[tauri::command]
pub async fn cancel_operator_http_stream(request: Value) -> Value {
    let req = request.get("request").unwrap_or(&request);
    let request_id = req
        .get("requestId")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .unwrap_or("");
    let cancelled = if request_id.is_empty() {
        false
    } else {
        cancel_operator_http_stream_direct(request_id)
    };
    json!({ "cancelled": cancelled })
}

/// Extracts the token from a `Bearer <token>` header value.
fn bearer_token(value: &str) -> Option<&str> {
    let (scheme, token) = value.trim().split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let token = token.trim();
    if token.is_empty() {
        None
    } else {
        Some(token)
    }
}

fn current_date_slug() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = (secs / 86400) as i64;
    let z = days + 719468;
    let era = (if z >= 0 { z } else { z - 146096 }) / 146097;
    let doe = (z - era * 146097) as u32;
    let yoe = (doe - doe / 1020 + doe / 1461 - doe / 36524) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02}", y, m, d)
}

fn is_non_secret_token_metric_key(lower: &str) -> bool {
    matches!(
        lower,
        "tokencounts"
            | "token_counts"
            | "firsttoken"
            | "firsttokenms"
            | "first_token"
            | "first_token_ms"
            | "prompttokens"
            | "prompt_tokens"
            | "completiontokens"
            | "completion_tokens"
            | "cachedtokens"
            | "cached_tokens"
            | "inputtokens"
            | "input_tokens"
            | "outputtokens"
            | "output_tokens"
            | "maxtokens"
            | "max_tokens"
            | "totaltokens"
            | "total_tokens"
    )
}

fn redact_secrets_native(mut val: Value) -> Value {
    match &mut val {
        Value::String(s) => {
            if s.starts_with("Bearer ") || s.starts_with("sk-") || s.starts_with("xai-") || s.starts_with("ghp_") {
                *s = "[REDACTED_SECRET]".to_string();
            } else {
                for prefix in &["sk-", "xai-", "ghp_"] {
                    if let Some(idx) = s.find(prefix) {
                        let end = s[idx..]
                            .find(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == ',' || c == '}')
                            .map(|e| idx + e)
                            .unwrap_or(s.len());
                        if end - idx > 16 {
                            s.replace_range(idx..end, "[REDACTED_SECRET]");
                        }
                    }
                }
            }
        }
        Value::Array(arr) => {
            for item in arr {
                *item = redact_secrets_native(item.clone());
            }
        }
        Value::Object(map) => {
            let keys: Vec<String> = map.keys().cloned().collect();
            for k in keys {
                let lower = k.to_lowercase();
                if !is_non_secret_token_metric_key(&lower)
                    && (lower.contains("secret")
                        || lower.contains("apikey")
                        || lower.contains("api_key")
                        || lower.contains("password")
                        || lower.contains("token"))
                {
                    map.insert(k, Value::String("[REDACTED_SECRET]".to_string()));
                } else if let Some(v) = map.remove(&k) {
                    map.insert(k, redact_secrets_native(v));
                }
            }
        }
        _ => {}
    }
    val
}

pub fn operator_trace_path_direct() -> Result<String, String> {
    let dir = crate::persist::roaming_app_dir().join("operator-traces");
    if !dir.exists() {
        let _ = std::fs::create_dir_all(&dir);
    }
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn operator_trace_path() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(operator_trace_path_direct)
        .await
        .map_err(|e| format!("Failed to join operator trace path task: {e}"))?
}

pub fn operator_trace_reveal_direct(_request: Option<Value>) -> Value {
    let dir = crate::persist::roaming_app_dir().join("operator-traces");
    let _ = std::fs::create_dir_all(&dir);
    #[cfg(target_os = "windows")]
    let _ = std::process::Command::new("explorer").arg(&dir).spawn();
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg(&dir).spawn();
    #[cfg(target_os = "linux")]
    let _ = std::process::Command::new("xdg-open").arg(&dir).spawn();
    Value::Null
}

#[tauri::command]
pub async fn operator_trace_reveal(_request: Option<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || operator_trace_reveal_direct(_request))
        .await
        .unwrap_or(Value::Null)
}

pub fn operator_trace_append_direct(
    line: Option<String>,
    request: Option<Value>,
) -> Result<(), String> {
    use std::io::Write;
    let line_str = if let Some(l) = line {
        l
    } else if let Some(req) = request {
        if let Some(s) = req.as_str() {
            s.to_string()
        } else {
            req.get("line")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .ok_or_else(|| "Missing 'line' field in request".to_string())?
        }
    } else {
        return Err("Missing 'line' argument".to_string());
    };

    let dir = crate::persist::roaming_app_dir().join("operator-traces");
    if !dir.exists() {
        let _ = std::fs::create_dir_all(&dir);
    }
    let date_str = current_date_slug();
    let file_path = dir.join(format!("{}.jsonl", date_str));
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&file_path)
        .map_err(|e| format!("Failed to open operator trace file: {e}"))?;

    let final_line = match serde_json::from_str::<Value>(&line_str) {
        Ok(val) => serde_json::to_string(&redact_secrets_native(val)).unwrap_or(line_str),
        Err(_) => line_str,
    };

    writeln!(file, "{}", final_line.trim_end())
        .map_err(|e| format!("Failed to write operator trace: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn operator_trace_append(
    line: Option<String>,
    request: Option<Value>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || operator_trace_append_direct(line, request))
        .await
        .map_err(|e| format!("Failed to join operator trace append task: {e}"))?
}

fn safe_workspace_memory_slug(workspace_id: &str) -> String {
    use sha2::{Digest, Sha256};
    let trimmed = workspace_id.trim();
    if trimmed.is_empty() {
        return "default".to_string();
    }
    let clean: String = trimmed
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(48)
        .collect();
    let mut hasher = Sha256::new();
    hasher.update(trimmed.as_bytes());
    let digest = format!("{:x}", hasher.finalize());
    let short_hash = &digest[..12];
    if clean.is_empty() {
        format!("ws-{short_hash}")
    } else {
        format!("{clean}-{short_hash}")
    }
}

fn operator_memory_file_path(base_dir: &std::path::Path, workspace_id: &str) -> std::path::PathBuf {
    base_dir
        .join("operator-memory")
        .join(format!("{}.json", safe_workspace_memory_slug(workspace_id)))
}

pub fn operator_memory_load_direct(workspace_id: &str) -> Result<Value, String> {
    let path = operator_memory_file_path(&crate::persist::roaming_app_dir(), workspace_id);
    if !path.exists() {
        return Ok(json!({ "workspaceId": workspace_id, "delegations": [], "sessions": [] }));
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read operator memory: {e}"))?;
    serde_json::from_str::<Value>(&raw)
        .map_err(|e| format!("Failed to parse operator memory: {e}"))
}

pub fn operator_memory_save_direct(workspace_id: &str, data: Value) -> Result<(), String> {
    let dir = crate::persist::roaming_app_dir().join("operator-memory");
    if !dir.exists() {
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create operator memory dir: {e}"))?;
    }
    let path = operator_memory_file_path(&crate::persist::roaming_app_dir(), workspace_id);
    let redacted = redact_secrets_native(data);
    let body = serde_json::to_string_pretty(&redacted)
        .map_err(|e| format!("Failed to serialize operator memory: {e}"))?;
    std::fs::write(&path, body).map_err(|e| format!("Failed to write operator memory: {e}"))
}

#[tauri::command]
pub async fn operator_memory_load(request: Value) -> Result<Value, String> {
    let req = request.get("request").unwrap_or(&request);
    let workspace_id = req
        .get("workspaceId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    tauri::async_runtime::spawn_blocking(move || operator_memory_load_direct(&workspace_id))
        .await
        .map_err(|e| format!("Failed to join operator memory load: {e}"))?
}

#[tauri::command]
pub async fn operator_memory_save(request: Value) -> Result<(), String> {
    let req = request.get("request").unwrap_or(&request);
    let workspace_id = req
        .get("workspaceId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let data = req.get("data").cloned().unwrap_or_else(|| json!({}));
    tauri::async_runtime::spawn_blocking(move || operator_memory_save_direct(&workspace_id, data))
        .await
        .map_err(|e| format!("Failed to join operator memory save: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_query_operator_agent_unsupported_engine() {
        let payload = json!({
            "engine": "unknown_ai_engine",
            "prompt": "ping"
        });
        let res = query_operator_agent_direct(payload.clone());

        assert_eq!(res["success"], false);
        assert!(res["error"].as_str().unwrap().contains("no soportado"));

        let async_res = tauri::async_runtime::block_on(query_operator_agent(payload));
        assert_eq!(async_res["success"], false);
        assert!(async_res["error"]
            .as_str()
            .unwrap()
            .contains("no soportado"));
    }

    #[test]
    fn test_shared_http_client_reuses_same_instance() {
        let c1 = shared_http_client().expect("pooled client") as *const reqwest::Client;
        let c2 = shared_http_client().expect("pooled client") as *const reqwest::Client;
        assert_eq!(c1, c2);
    }

    #[test]
    fn test_redact_secrets_preserves_token_counts_and_redacts_api_tokens() {
        let input = json!({
            "tokenCounts": { "prompt": 210, "completion": 42, "cache": 120 },
            "firstTokenMs": 310,
            "apiToken": "secret-token-value",
            "token": "raw-auth-token",
            "nested": { "password": "pw", "input_tokens": 99 }
        });
        let out = redact_secrets_native(input);
        assert_eq!(out["tokenCounts"]["prompt"], 210);
        assert_eq!(out["firstTokenMs"], 310);
        assert_eq!(out["apiToken"], "[REDACTED_SECRET]");
        assert_eq!(out["token"], "[REDACTED_SECRET]");
        assert_eq!(out["nested"]["password"], "[REDACTED_SECRET]");
        assert_eq!(out["nested"]["input_tokens"], 99);
    }

    #[test]
    fn test_drain_complete_utf8_handles_split_spanish_multibyte_chars() {
        // "ñ" is [0xC3, 0xB1]
        let mut buf = vec![b'h', b'o', b'l', b'a', b' ', 0xC3];
        let first = drain_complete_utf8(&mut buf);
        assert_eq!(first, "hola ");
        assert_eq!(buf, vec![0xC3]);
        buf.push(0xB1);
        let second = drain_complete_utf8(&mut buf);
        assert_eq!(second, "ñ");
        assert!(buf.is_empty());
    }

    #[test]
    fn test_cancel_operator_http_stream_signals_registered_sender() {
        let (tx, mut rx) = tokio::sync::oneshot::channel::<()>();
        {
            let mut reg = stream_cancel_registry().lock().unwrap();
            reg.insert("req-test-cancel".to_string(), tx);
        }
        assert!(cancel_operator_http_stream_direct("req-test-cancel"));
        assert!(!cancel_operator_http_stream_direct("req-test-cancel"));
        assert!(rx.try_recv().is_ok());
    }

    #[test]
    fn test_safe_workspace_memory_slug_blocks_traversal() {
        let s1 = safe_workspace_memory_slug("../../etc/passwd");
        assert!(!s1.contains(".."));
        assert!(!s1.contains('/'));
        assert!(!s1.contains('\\'));
        let s2 = safe_workspace_memory_slug("ws-alpha");
        let s3 = safe_workspace_memory_slug("ws-beta");
        assert_ne!(s2, s3);
    }
}
