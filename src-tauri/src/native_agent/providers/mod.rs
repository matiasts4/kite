pub mod anthropic;
pub mod gemini;
pub mod openai_compat;

use super::types::{DirectEligibility, GatewayKind, NativeStreamChunk, NativeTurnRequest};
use serde_json::Value;

/// Executes one streaming Fast Lane turn against an eligible official HTTPS/SSE
/// provider adapter, normalizing output into `NativeStreamChunk` callbacks.
pub async fn execute_turn(
    req: &NativeTurnRequest,
    on_chunk: &mut (dyn FnMut(NativeStreamChunk) + Send),
) -> Result<(), String> {
    if matches!(
        req.endpoint.eligibility,
        DirectEligibility::OfficialGateway(GatewayKind::OpenCodeGo)
    ) {
        return openai_compat::execute_openai_compat_turn(req, on_chunk).await;
    }

    match req.endpoint.provider.trim().to_ascii_lowercase().as_str() {
        "anthropic" => anthropic::execute_anthropic_turn(req, on_chunk).await,
        "gemini" | "google" => gemini::execute_gemini_turn(req, on_chunk).await,
        "openai" | "xai" | "x-ai" | "grok" | "deepseek" | "kimi" | "moonshot" | "vercel"
        | "cloudflare" | "opencode_go" | "opencode-go" | "opencode" => {
            openai_compat::execute_openai_compat_turn(req, on_chunk).await
        }
        other => Err(format!("Unsupported Fast Lane provider '{}'", other)),
    }
}

/// Drains complete leading UTF-8 codepoints from `pending`, retaining any
/// incomplete trailing multi-byte sequence for the next network chunk.
pub(crate) fn drain_complete_utf8(pending: &mut Vec<u8>) -> String {
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
                out.push('\u{FFFD}');
                let drain_end = (valid_up_to + error_len).min(pending.len());
                pending.drain(..drain_end);
                out.push_str(&drain_complete_utf8(pending));
            } else {
                pending.drain(..valid_up_to);
            }
            out
        }
    }
}

pub(crate) fn parse_retry_after_ms(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    if let Some(ms_val) = headers.get("retry-after-ms").and_then(|v| v.to_str().ok()) {
        let trimmed = ms_val.trim();
        if let Ok(ms) = trimmed.parse::<u64>() {
            return Some(ms);
        }
        if let Ok(ms_f) = trimmed.parse::<f64>() {
            if ms_f.is_finite() && ms_f >= 0.0 {
                return Some(ms_f.round() as u64);
            }
        }
    }

    let raw = headers.get(reqwest::header::RETRY_AFTER)?.to_str().ok()?;
    let trimmed = raw.trim();
    if let Ok(secs) = trimmed.parse::<u64>() {
        return Some(secs.saturating_mul(1000));
    }
    if let Ok(secs_f) = trimmed.parse::<f64>() {
        if secs_f.is_finite() && secs_f >= 0.0 {
            return Some((secs_f * 1000.0).round() as u64);
        }
    }
    None
}

pub(crate) fn extract_error_message_from_body(body: &str) -> Option<String> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
        if let Some(msg) = parsed
            .pointer("/error/message")
            .and_then(Value::as_str)
            .or_else(|| parsed.get("message").and_then(Value::as_str))
            .or_else(|| parsed.get("error").and_then(Value::as_str))
        {
            let m = msg.trim();
            if !m.is_empty() {
                return Some(m.to_string());
            }
        }
    }
    let clipped: String = trimmed.chars().take(400).collect();
    Some(clipped)
}

/// Streams a `reqwest::Response` over chunked UTF-8 reads (`response.chunk().await`,
/// never `.bytes_stream()`), splits `\n` / `\r\n` lines, handles HTTP 429
/// `Retry-After` rate limiting, and dispatches normalized SSE chunks.
pub(crate) async fn stream_sse_response<F>(
    mut resp: reqwest::Response,
    on_chunk: &mut (dyn FnMut(NativeStreamChunk) + Send),
    mut on_line: F,
) -> Result<(), String>
where
    F: FnMut(&str) -> Vec<NativeStreamChunk>,
{
    let status = resp.status();
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        let retry_after_ms = parse_retry_after_ms(resp.headers());
        let body = resp.text().await.unwrap_or_default();
        let message = extract_error_message_from_body(&body)
            .unwrap_or_else(|| "HTTP 429 Too Many Requests".to_string());
        on_chunk(NativeStreamChunk::RateLimited {
            retry_after_ms,
            message,
        });
        return Ok(());
    }

    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        let detail = extract_error_message_from_body(&body)
            .unwrap_or_else(|| status.canonical_reason().unwrap_or("Request failed").to_string());
        let err_msg = format!("HTTP {}: {}", status.as_u16(), detail);
        on_chunk(NativeStreamChunk::Error(err_msg.clone()));
        return Err(err_msg);
    }

    let mut pending_utf8: Vec<u8> = Vec::new();
    let mut line_buf = String::new();
    let mut saw_done = false;
    let mut saw_error = false;

    let mut emit_line = |line: &str| {
        for chunk in on_line(line) {
            match &chunk {
                NativeStreamChunk::Done => {
                    if saw_done {
                        continue;
                    }
                    saw_done = true;
                }
                NativeStreamChunk::Error(_) => {
                    saw_error = true;
                }
                _ => {}
            }
            on_chunk(chunk);
        }
    };

    while let Some(bytes) = resp
        .chunk()
        .await
        .map_err(|e| format!("SSE stream read failed: {e}"))?
    {
        if bytes.is_empty() {
            continue;
        }
        pending_utf8.extend_from_slice(&bytes);
        let text = drain_complete_utf8(&mut pending_utf8);
        if text.is_empty() {
            continue;
        }
        line_buf.push_str(&text);

        while let Some(nl_pos) = line_buf.find('\n') {
            let line = line_buf[..nl_pos].strip_suffix('\r').unwrap_or(&line_buf[..nl_pos]);
            emit_line(line);
            line_buf.drain(..=nl_pos);
        }
    }

    if !pending_utf8.is_empty() {
        line_buf.push_str(&String::from_utf8_lossy(&pending_utf8));
        pending_utf8.clear();
    }
    if !line_buf.is_empty() {
        let trailing = line_buf.strip_suffix('\r').unwrap_or(&line_buf);
        emit_line(trailing);
        line_buf.clear();
    }
    // Flush any trailing multi-line SSE event if EOF lacked a closing blank line.
    emit_line("");

    if !saw_done && !saw_error {
        on_chunk(NativeStreamChunk::Done);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drain_complete_utf8_buffers_split_multibyte_chars() {
        let rocket = "🚀".as_bytes();
        assert_eq!(rocket.len(), 4);

        let mut pending = vec![b'h', b'i', rocket[0], rocket[1]];
        assert_eq!(drain_complete_utf8(&mut pending), "hi");
        assert_eq!(pending, vec![rocket[0], rocket[1]]);

        pending.extend_from_slice(&rocket[2..]);
        assert_eq!(drain_complete_utf8(&mut pending), "🚀");
        assert!(pending.is_empty());
    }

    #[test]
    fn parse_retry_after_ms_supports_seconds_and_ms_headers() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(reqwest::header::RETRY_AFTER, "7".parse().unwrap());
        assert_eq!(parse_retry_after_ms(&headers), Some(7000));

        headers.insert(reqwest::header::RETRY_AFTER, "1.5".parse().unwrap());
        assert_eq!(parse_retry_after_ms(&headers), Some(1500));

        headers.insert("retry-after-ms", "350".parse().unwrap());
        assert_eq!(parse_retry_after_ms(&headers), Some(350));
    }

    #[test]
    fn execute_turn_routes_all_three_adapters_and_surfaces_http_errors() {
        use super::super::types::{resolve_fast_lane_endpoint, NativeMessage, NativeRole};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;

        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();

        rt.block_on(async {
            for (provider, auth, sse_body, expected_path) in [
                (
                    "xai",
                    "api_key",
                    "data: {\"choices\":[{\"delta\":{\"content\":\"grok ok\"}}]}\n\ndata: [DONE]\n\n",
                    "/v1/chat/completions",
                ),
                (
                    "anthropic",
                    "api_key",
                    "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"claude ok\"}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
                    "/v1/messages",
                ),
                (
                    "gemini",
                    "api_key",
                    "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"gemini ok\"}]},\"finishReason\":\"STOP\"}]}\n\n",
                    "/v1beta/models/m1:streamgeneratecontent?alt=sse",
                ),
            ] {
                let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                let addr = listener.local_addr().unwrap();
                let body_owned = sse_body.to_string();
                let path_expected = expected_path.to_string();
                let srv = tokio::spawn(async move {
                    let (mut sock, _) = listener.accept().await.unwrap();
                    let mut buf = vec![0u8; 4096];
                    let n = sock.read(&mut buf).await.unwrap();
                    let req_line = String::from_utf8_lossy(&buf[..n]).to_lowercase();
                    assert!(req_line.contains(&path_expected), "unexpected request: {req_line}");
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body_owned.len(),
                        body_owned
                    );
                    sock.write_all(resp.as_bytes()).await.unwrap();
                });

                let base = if provider == "gemini" {
                    format!("http://{addr}/v1beta")
                } else {
                    format!("http://{addr}/v1")
                };
                let ep = resolve_fast_lane_endpoint(provider, "m1", Some("k1"), Some(&base), auth, None)
                    .unwrap();
                let req = NativeTurnRequest {
                    endpoint: ep,
                    system_prompt: None,
                    messages: vec![NativeMessage {
                        role: NativeRole::User,
                        content: "hi".to_string(),
                        tool_call_id: None,
                        tool_calls: vec![],
                    }],
                    tools: vec![],
                    max_tokens: None,
                };
                let mut chunks = Vec::new();
                execute_turn(&req, &mut |c| chunks.push(c)).await.unwrap();
                srv.await.unwrap();
                assert!(chunks.iter().any(|c| matches!(c, NativeStreamChunk::TextDelta(_))));
                assert_eq!(chunks.last(), Some(&NativeStreamChunk::Done));
            }

            // Verify HTTP 500 surfaces NativeStreamChunk::Error and Err
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let srv = tokio::spawn(async move {
                let (mut sock, _) = listener.accept().await.unwrap();
                let mut buf = vec![0u8; 2048];
                let _ = sock.read(&mut buf).await;
                let err_body = r#"{"error":{"message":"Upstream failure"}}"#;
                let resp = format!(
                    "HTTP/1.1 500 Internal Server Error\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    err_body.len(),
                    err_body
                );
                sock.write_all(resp.as_bytes()).await.unwrap();
            });
            let ep = resolve_fast_lane_endpoint(
                "openai",
                "gpt-4.1",
                Some("k"),
                Some(&format!("http://{addr}/v1")),
                "api_key",
                None,
            )
            .unwrap();
            let req = NativeTurnRequest {
                endpoint: ep,
                system_prompt: None,
                messages: vec![NativeMessage {
                    role: NativeRole::User,
                    content: "hi".to_string(),
                    tool_call_id: None,
                    tool_calls: vec![],
                }],
                tools: vec![],
                max_tokens: None,
            };
            let mut chunks = Vec::new();
            let res = execute_turn(&req, &mut |c| chunks.push(c)).await;
            srv.await.unwrap();
            assert!(res.is_err());
            assert_eq!(
                chunks,
                vec![NativeStreamChunk::Error(
                    "HTTP 500: Upstream failure".to_string()
                )]
            );
        });
    }
}
