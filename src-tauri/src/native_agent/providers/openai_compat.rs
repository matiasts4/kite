use super::super::types::{
    shared_http_client, NativeRole, NativeStreamChunk, NativeTurnRequest, NativeUsage,
};
use super::stream_sse_response;
use serde_json::{json, Value};
use std::collections::HashMap;

#[derive(Debug, Default)]
struct OpenAiSseState {
    tool_ids_by_index: HashMap<u64, String>,
}

pub fn chat_completions_endpoint(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.ends_with("/chat/completions") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/chat/completions")
    }
}

pub fn build_openai_payload(req: &NativeTurnRequest) -> Value {
    let mut messages: Vec<Value> = Vec::new();
    if let Some(sys) = req
        .system_prompt
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        messages.push(json!({
            "role": "system",
            "content": sys
        }));
    }

    for msg in &req.messages {
        match msg.role {
            NativeRole::System => {
                messages.push(json!({
                    "role": "system",
                    "content": msg.content
                }));
            }
            NativeRole::User => {
                messages.push(json!({
                    "role": "user",
                    "content": msg.content
                }));
            }
            NativeRole::Assistant => {
                if msg.tool_calls.is_empty() {
                    messages.push(json!({
                        "role": "assistant",
                        "content": msg.content
                    }));
                } else {
                    let tool_calls: Vec<Value> = msg
                        .tool_calls
                        .iter()
                        .map(|tc| {
                            json!({
                                "id": tc.id,
                                "type": "function",
                                "function": {
                                    "name": tc.name,
                                    "arguments": tc.arguments
                                }
                            })
                        })
                        .collect();
                    let content_val = if msg.content.is_empty() {
                        Value::Null
                    } else {
                        json!(msg.content)
                    };
                    messages.push(json!({
                        "role": "assistant",
                        "content": content_val,
                        "tool_calls": tool_calls
                    }));
                }
            }
            NativeRole::Tool => {
                messages.push(json!({
                    "role": "tool",
                    "tool_call_id": msg.tool_call_id.as_deref().unwrap_or(""),
                    "content": msg.content
                }));
            }
        }
    }

    let mut payload = json!({
        "model": req.endpoint.model,
        "stream": true,
        "messages": messages,
    });

    if req.endpoint.provider != "cloudflare" {
        payload["stream_options"] = json!({ "include_usage": true });
    }

    if let Some(max_tokens) = req.max_tokens {
        payload["max_tokens"] = json!(max_tokens);
    }

    if !req.tools.is_empty() {
        let tools: Vec<Value> = req
            .tools
            .iter()
            .map(|t| {
                json!({
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.parameters
                    }
                })
            })
            .collect();
        payload["tools"] = Value::Array(tools);
    }

    payload
}

fn parse_openai_sse_line_with_state(state: &mut OpenAiSseState, line: &str) -> Vec<NativeStreamChunk> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with(':') {
        return Vec::new();
    }

    let Some(data_raw) = trimmed.strip_prefix("data:") else {
        return Vec::new();
    };
    let data = data_raw.trim();
    if data.is_empty() {
        return Vec::new();
    }
    if data == "[DONE]" {
        return vec![NativeStreamChunk::Done];
    }

    let Ok(parsed) = serde_json::from_str::<Value>(data) else {
        return Vec::new();
    };

    let mut chunks = Vec::new();

    if let Some(err) = parsed.get("error") {
        let message = err
            .get("message")
            .and_then(Value::as_str)
            .or_else(|| err.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| err.to_string());
        let is_rate_limit = err.get("code").and_then(Value::as_u64) == Some(429)
            || err
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(|t| t.contains("rate_limit"));
        if is_rate_limit {
            chunks.push(NativeStreamChunk::RateLimited {
                retry_after_ms: None,
                message,
            });
        } else {
            chunks.push(NativeStreamChunk::Error(message));
        }
        return chunks;
    }

    if let Some(delta) = parsed.pointer("/choices/0/delta") {
        if let Some(reasoning) = delta
            .get("reasoning_content")
            .or_else(|| delta.get("reasoning"))
            .and_then(Value::as_str)
        {
            if !reasoning.is_empty() {
                chunks.push(NativeStreamChunk::ReasoningDelta(reasoning.to_string()));
            }
        }

        if let Some(content) = delta.get("content").and_then(Value::as_str) {
            if !content.is_empty() {
                chunks.push(NativeStreamChunk::TextDelta(content.to_string()));
            }
        }

        if let Some(tool_calls) = delta.get("tool_calls").and_then(Value::as_array) {
            for tc in tool_calls {
                let idx = tc.get("index").and_then(Value::as_u64).unwrap_or(0);
                let explicit_id = tc
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string);

                if let Some(ref id) = explicit_id {
                    state.tool_ids_by_index.insert(idx, id.clone());
                }

                let resolved_id = explicit_id
                    .or_else(|| state.tool_ids_by_index.get(&idx).cloned())
                    .unwrap_or_default();

                if let Some(func) = tc.get("function") {
                    if let Some(name) = func.get("name").and_then(Value::as_str) {
                        if !name.is_empty() {
                            chunks.push(NativeStreamChunk::ToolCallStart {
                                id: resolved_id.clone(),
                                name: name.to_string(),
                            });
                        }
                    }
                    if let Some(args) = func.get("arguments").and_then(Value::as_str) {
                        if !args.is_empty() {
                            chunks.push(NativeStreamChunk::ToolCallDelta {
                                id: resolved_id,
                                arguments_delta: args.to_string(),
                            });
                        }
                    }
                }
            }
        }
    }

    if let Some(usage) = parsed.get("usage").filter(|u| u.is_object()) {
        let input_tokens = usage
            .get("prompt_tokens")
            .or_else(|| usage.get("input_tokens"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let output_tokens = usage
            .get("completion_tokens")
            .or_else(|| usage.get("output_tokens"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let cached_tokens = usage
            .pointer("/prompt_tokens_details/cached_tokens")
            .or_else(|| usage.get("cache_read_input_tokens"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        chunks.push(NativeStreamChunk::Usage(NativeUsage {
            input_tokens,
            output_tokens,
            cached_tokens,
        }));
    }

    chunks
}

/// Parses a single OpenAI-compatible SSE line (`data: {...}` or `data: [DONE]`)
/// into normalized `NativeStreamChunk` items.
pub fn parse_openai_sse_line(line: &str) -> Vec<NativeStreamChunk> {
    let mut state = OpenAiSseState::default();
    parse_openai_sse_line_with_state(&mut state, line)
}

pub async fn execute_openai_compat_turn(
    req: &NativeTurnRequest,
    on_chunk: &mut (dyn FnMut(NativeStreamChunk) + Send),
) -> Result<(), String> {
    let url = chat_completions_endpoint(&req.endpoint.base_url);
    let payload = build_openai_payload(req);

    let mut builder = shared_http_client()
        .post(&url)
        .header("Authorization", format!("Bearer {}", req.endpoint.api_key))
        .header("Content-Type", "application/json")
        .header("Accept", "text/event-stream");

    if let Some(session) = req
        .endpoint
        .session_header
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        builder = builder.header("x-opencode-session", session);
    }

    let resp = builder
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("OpenAI-compatible request failed: {e}"))?;

    let mut state = OpenAiSseState::default();
    stream_sse_response(resp, on_chunk, |line| {
        parse_openai_sse_line_with_state(&mut state, line)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::super::types::{resolve_fast_lane_endpoint, NativeMessage, NativeToolDef};

    fn run_async<F: std::future::Future>(fut: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio runtime")
            .block_on(fut)
    }

    #[test]
    fn parses_openai_sse_fixture_lines() {
        assert!(parse_openai_sse_line("").is_empty());
        assert!(parse_openai_sse_line(": keepalive").is_empty());

        let reasoning = parse_openai_sse_line(
            r#"data: {"choices":[{"delta":{"reasoning_content":"Thinking..."}}]}"#,
        );
        assert_eq!(
            reasoning,
            vec![NativeStreamChunk::ReasoningDelta("Thinking...".to_string())]
        );

        let text =
            parse_openai_sse_line(r#"data: {"choices":[{"delta":{"content":"Hello 🚀"}}]}"#);
        assert_eq!(
            text,
            vec![NativeStreamChunk::TextDelta("Hello 🚀".to_string())]
        );

        let tool_start = parse_openai_sse_line(
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\"path\":"}}]}}]}"#,
        );
        assert_eq!(
            tool_start,
            vec![
                NativeStreamChunk::ToolCallStart {
                    id: "call_1".to_string(),
                    name: "read_file".to_string(),
                },
                NativeStreamChunk::ToolCallDelta {
                    id: "call_1".to_string(),
                    arguments_delta: "{\"path\":".to_string(),
                },
            ]
        );

        let usage = parse_openai_sse_line(
            r#"data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":34,"prompt_tokens_details":{"cached_tokens":64}}}"#,
        );
        assert_eq!(
            usage,
            vec![NativeStreamChunk::Usage(NativeUsage {
                input_tokens: 120,
                output_tokens: 34,
                cached_tokens: 64,
            })]
        );

        assert_eq!(
            parse_openai_sse_line("data: [DONE]"),
            vec![NativeStreamChunk::Done]
        );
    }

    #[test]
    fn streams_opencode_go_with_session_header_and_split_utf8() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;

        run_async(async {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();

            let server = tokio::spawn(async move {
                let (mut sock, _) = listener.accept().await.unwrap();
                let mut req_buf = vec![0u8; 4096];
                let n = sock.read(&mut req_buf).await.unwrap();
                let req_str = String::from_utf8_lossy(&req_buf[..n]).to_lowercase();
                assert!(req_str.contains("x-opencode-session: ses_test_42"));
                assert!(req_str.contains("\"stream\":true"));

                let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n";
                sock.write_all(head.as_bytes()).await.unwrap();

                // Split a multi-byte emoji across two TCP writes.
                let full_sse = concat!(
                    "data: {\"choices\":[{\"delta\":{\"content\":\"Hi 🚀\"}}]}\r\n\r\n",
                    "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_abc\",\"function\":{\"name\":\"find_files\",\"arguments\":\"\"}}]}}]}\n\n",
                    "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"pattern\\\":\\\"*.rs\\\"}\"}}]}}]}\n\n",
                    "data: [DONE]\n\n"
                );
                let bytes = full_sse.as_bytes();
                let split_at = full_sse.find("🚀").unwrap() + 2;
                let chunk1 = format!("{:x}\r\n", split_at);
                sock.write_all(chunk1.as_bytes()).await.unwrap();
                sock.write_all(&bytes[..split_at]).await.unwrap();
                sock.write_all(b"\r\n").await.unwrap();

                let rest = &bytes[split_at..];
                let chunk2 = format!("{:x}\r\n", rest.len());
                sock.write_all(chunk2.as_bytes()).await.unwrap();
                sock.write_all(rest).await.unwrap();
                sock.write_all(b"\r\n0\r\n\r\n").await.unwrap();
            });

            let endpoint = resolve_fast_lane_endpoint(
                "opencode_go",
                "glm-5",
                Some("ocg-secret"),
                Some(&format!("http://{addr}/v1")),
                "opencode_go",
                Some("ses_test_42"),
            )
            .unwrap();

            let req = NativeTurnRequest {
                endpoint,
                system_prompt: Some("You are concise.".to_string()),
                messages: vec![NativeMessage {
                    role: NativeRole::User,
                    content: "Hello".to_string(),
                    tool_call_id: None,
                    tool_calls: vec![],
                }],
                tools: vec![NativeToolDef {
                    name: "find_files".to_string(),
                    description: "Find files".to_string(),
                    parameters: json!({"type": "object"}),
                }],
                max_tokens: Some(512),
            };

            let mut chunks = Vec::new();
            execute_openai_compat_turn(&req, &mut |c| chunks.push(c))
                .await
                .unwrap();

            server.await.unwrap();

            assert_eq!(
                chunks,
                vec![
                    NativeStreamChunk::TextDelta("Hi 🚀".to_string()),
                    NativeStreamChunk::ToolCallStart {
                        id: "call_abc".to_string(),
                        name: "find_files".to_string(),
                    },
                    NativeStreamChunk::ToolCallDelta {
                        id: "call_abc".to_string(),
                        arguments_delta: "{\"pattern\":\"*.rs\"}".to_string(),
                    },
                    NativeStreamChunk::Done,
                ]
            );
        });
    }

    #[test]
    fn emits_rate_limited_on_http_429_with_retry_after() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;

        run_async(async {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();

            let server = tokio::spawn(async move {
                let (mut sock, _) = listener.accept().await.unwrap();
                let mut buf = vec![0u8; 2048];
                let _ = sock.read(&mut buf).await;
                let body = r#"{"error":{"message":"Slow down"}}"#;
                let resp = format!(
                    "HTTP/1.1 429 Too Many Requests\r\nRetry-After: 4\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                sock.write_all(resp.as_bytes()).await.unwrap();
            });

            let endpoint = resolve_fast_lane_endpoint(
                "openai",
                "gpt-4.1-mini",
                Some("sk-test"),
                Some(&format!("http://{addr}/v1")),
                "api_key",
                None,
            )
            .unwrap();

            let req = NativeTurnRequest {
                endpoint,
                system_prompt: None,
                messages: vec![NativeMessage {
                    role: NativeRole::User,
                    content: "Hi".to_string(),
                    tool_call_id: None,
                    tool_calls: vec![],
                }],
                tools: vec![],
                max_tokens: None,
            };

            let mut chunks = Vec::new();
            execute_openai_compat_turn(&req, &mut |c| chunks.push(c))
                .await
                .unwrap();

            server.await.unwrap();

            assert_eq!(
                chunks,
                vec![NativeStreamChunk::RateLimited {
                    retry_after_ms: Some(4000),
                    message: "Slow down".to_string(),
                }]
            );
        });
    }
}
