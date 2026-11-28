use super::super::types::{
    shared_http_client, NativeRole, NativeStreamChunk, NativeTurnRequest, NativeUsage,
};
use super::stream_sse_response;
use serde_json::{json, Value};
use std::collections::HashMap;

pub const ANTHROPIC_API_VERSION: &str = "2023-06-01";

#[derive(Debug, Default)]
struct AnthropicSseState {
    current_event: Option<String>,
    data_lines: Vec<String>,
    tool_ids_by_index: HashMap<u64, String>,
    input_tokens: u64,
    cached_tokens: u64,
}

pub fn messages_endpoint(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.ends_with("/messages") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/messages")
    }
}

fn push_user_blocks(out: &mut Vec<Value>, new_blocks: Vec<Value>) {
    if new_blocks.is_empty() {
        return;
    }
    if let Some(last) = out.last_mut() {
        if last.get("role").and_then(Value::as_str) == Some("user") {
            if let Some(arr) = last.get_mut("content").and_then(Value::as_array_mut) {
                arr.extend(new_blocks);
                return;
            }
            if let Some(prev_text) = last.get("content").and_then(Value::as_str).map(str::to_string)
            {
                let mut combined = vec![json!({ "type": "text", "text": prev_text })];
                combined.extend(new_blocks);
                last["content"] = Value::Array(combined);
                return;
            }
        }
    }
    out.push(json!({
        "role": "user",
        "content": new_blocks
    }));
}

pub fn build_anthropic_payload(req: &NativeTurnRequest) -> Value {
    let mut system_parts: Vec<String> = Vec::new();
    if let Some(sys) = req
        .system_prompt
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        system_parts.push(sys.to_string());
    }

    let mut messages: Vec<Value> = Vec::new();
    for msg in &req.messages {
        match msg.role {
            NativeRole::System => {
                let s = msg.content.trim();
                if !s.is_empty() {
                    system_parts.push(s.to_string());
                }
            }
            NativeRole::User => {
                push_user_blocks(
                    &mut messages,
                    vec![json!({ "type": "text", "text": msg.content })],
                );
            }
            NativeRole::Assistant => {
                if msg.tool_calls.is_empty() {
                    messages.push(json!({
                        "role": "assistant",
                        "content": msg.content
                    }));
                } else {
                    let mut blocks: Vec<Value> = Vec::new();
                    if !msg.content.is_empty() {
                        blocks.push(json!({ "type": "text", "text": msg.content }));
                    }
                    for tc in &msg.tool_calls {
                        let input_val: Value = serde_json::from_str(&tc.arguments)
                            .unwrap_or_else(|_| json!({}));
                        blocks.push(json!({
                            "type": "tool_use",
                            "id": tc.id,
                            "name": tc.name,
                            "input": input_val
                        }));
                    }
                    messages.push(json!({
                        "role": "assistant",
                        "content": blocks
                    }));
                }
            }
            NativeRole::Tool => {
                push_user_blocks(
                    &mut messages,
                    vec![json!({
                        "type": "tool_result",
                        "tool_use_id": msg.tool_call_id.as_deref().unwrap_or(""),
                        "content": msg.content
                    })],
                );
            }
        }
    }

    let mut payload = json!({
        "model": req.endpoint.model,
        "max_tokens": req.max_tokens.unwrap_or(8192),
        "stream": true,
        "messages": messages,
    });

    if !system_parts.is_empty() {
        payload["system"] = json!([
            {
                "type": "text",
                "text": system_parts.join("\n\n"),
                "cache_control": { "type": "ephemeral" }
            }
        ]);
    }

    if !req.tools.is_empty() {
        let last_idx = req.tools.len() - 1;
        let tools: Vec<Value> = req
            .tools
            .iter()
            .enumerate()
            .map(|(idx, t)| {
                let mut tool_obj = json!({
                    "name": t.name,
                    "description": t.description,
                    "input_schema": t.parameters
                });
                if idx == last_idx {
                    tool_obj["cache_control"] = json!({ "type": "ephemeral" });
                }
                tool_obj
            })
            .collect();
        payload["tools"] = Value::Array(tools);
    }

    payload
}

fn parse_anthropic_sse_event_with_state(
    state: &mut AnthropicSseState,
    event_name: Option<&str>,
    data: &str,
) -> Vec<NativeStreamChunk> {
    let trimmed = data.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    if trimmed == "[DONE]" {
        return vec![NativeStreamChunk::Done];
    }

    let Ok(parsed) = serde_json::from_str::<Value>(trimmed) else {
        return Vec::new();
    };

    let resolved_event = event_name
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or_else(|| parsed.get("type").and_then(Value::as_str))
        .unwrap_or("");

    match resolved_event {
        "ping" | "content_block_stop" => Vec::new(),
        "message_start" => {
            if let Some(usage) = parsed.pointer("/message/usage").filter(|u| u.is_object()) {
                let input_tokens = usage
                    .get("input_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                let output_tokens = usage
                    .get("output_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                let cached_tokens = usage
                    .get("cache_read_input_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                state.input_tokens = input_tokens;
                state.cached_tokens = cached_tokens;
                return vec![NativeStreamChunk::Usage(NativeUsage {
                    input_tokens,
                    output_tokens,
                    cached_tokens,
                })];
            }
            Vec::new()
        }
        "content_block_start" => {
            let idx = parsed.get("index").and_then(Value::as_u64).unwrap_or(0);
            let Some(block) = parsed.get("content_block") else {
                return Vec::new();
            };
            let block_type = block.get("type").and_then(Value::as_str).unwrap_or("");
            match block_type {
                "tool_use" => {
                    let id = block
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let name = block
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    if !id.is_empty() {
                        state.tool_ids_by_index.insert(idx, id.clone());
                    }
                    if !name.is_empty() || !id.is_empty() {
                        vec![NativeStreamChunk::ToolCallStart { id, name }]
                    } else {
                        Vec::new()
                    }
                }
                "text" => {
                    if let Some(text) = block.get("text").and_then(Value::as_str) {
                        if !text.is_empty() {
                            return vec![NativeStreamChunk::TextDelta(text.to_string())];
                        }
                    }
                    Vec::new()
                }
                "thinking" => {
                    if let Some(thinking) = block.get("thinking").and_then(Value::as_str) {
                        if !thinking.is_empty() {
                            return vec![NativeStreamChunk::ReasoningDelta(thinking.to_string())];
                        }
                    }
                    Vec::new()
                }
                _ => Vec::new(),
            }
        }
        "content_block_delta" => {
            let idx = parsed.get("index").and_then(Value::as_u64).unwrap_or(0);
            let Some(delta) = parsed.get("delta") else {
                return Vec::new();
            };
            let delta_type = delta.get("type").and_then(Value::as_str).unwrap_or("");
            match delta_type {
                "text_delta" => {
                    if let Some(text) = delta.get("text").and_then(Value::as_str) {
                        if !text.is_empty() {
                            return vec![NativeStreamChunk::TextDelta(text.to_string())];
                        }
                    }
                    Vec::new()
                }
                "thinking_delta" => {
                    if let Some(thinking) = delta.get("thinking").and_then(Value::as_str) {
                        if !thinking.is_empty() {
                            return vec![NativeStreamChunk::ReasoningDelta(thinking.to_string())];
                        }
                    }
                    Vec::new()
                }
                "input_json_delta" => {
                    if let Some(partial) = delta.get("partial_json").and_then(Value::as_str) {
                        if !partial.is_empty() {
                            let id = delta
                                .get("id")
                                .and_then(Value::as_str)
                                .map(str::to_string)
                                .or_else(|| state.tool_ids_by_index.get(&idx).cloned())
                                .unwrap_or_default();
                            return vec![NativeStreamChunk::ToolCallDelta {
                                id,
                                arguments_delta: partial.to_string(),
                            }];
                        }
                    }
                    Vec::new()
                }
                _ => Vec::new(),
            }
        }
        "message_delta" => {
            if let Some(usage) = parsed.get("usage").filter(|u| u.is_object()) {
                let input_tokens = usage
                    .get("input_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(state.input_tokens);
                let output_tokens = usage
                    .get("output_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                let cached_tokens = usage
                    .get("cache_read_input_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(state.cached_tokens);
                return vec![NativeStreamChunk::Usage(NativeUsage {
                    input_tokens,
                    output_tokens,
                    cached_tokens,
                })];
            }
            Vec::new()
        }
        "message_stop" => vec![NativeStreamChunk::Done],
        "error" => {
            let err_obj = parsed.get("error").unwrap_or(&parsed);
            let message = err_obj
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| err_obj.to_string());
            let is_rate_limit = err_obj
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(|t| t == "rate_limit_error");
            if is_rate_limit {
                vec![NativeStreamChunk::RateLimited {
                    retry_after_ms: None,
                    message,
                }]
            } else {
                vec![NativeStreamChunk::Error(message)]
            }
        }
        _ => Vec::new(),
    }
}

/// Parses a single Anthropic Messages SSE event (`event_name` + JSON `data`)
/// into normalized `NativeStreamChunk` items.
pub fn parse_anthropic_sse_event(event_name: Option<&str>, data: &str) -> Vec<NativeStreamChunk> {
    let mut state = AnthropicSseState::default();
    parse_anthropic_sse_event_with_state(&mut state, event_name, data)
}

fn process_anthropic_sse_line(state: &mut AnthropicSseState, line: &str) -> Vec<NativeStreamChunk> {
    let trimmed_end = line.trim_end_matches('\r');
    if trimmed_end.is_empty() {
        if state.data_lines.is_empty() {
            state.current_event = None;
            return Vec::new();
        }
        let joined = state.data_lines.join("\n");
        state.data_lines.clear();
        let event = state.current_event.take();
        return parse_anthropic_sse_event_with_state(state, event.as_deref(), &joined);
    }

    if trimmed_end.starts_with(':') {
        return Vec::new();
    }

    if let Some(ev) = trimmed_end.strip_prefix("event:") {
        state.current_event = Some(ev.trim().to_string());
        return Vec::new();
    }

    if let Some(data) = trimmed_end.strip_prefix("data:") {
        state.data_lines.push(data.trim_start().to_string());
    }

    Vec::new()
}

pub async fn execute_anthropic_turn(
    req: &NativeTurnRequest,
    on_chunk: &mut (dyn FnMut(NativeStreamChunk) + Send),
) -> Result<(), String> {
    let url = messages_endpoint(&req.endpoint.base_url);
    let payload = build_anthropic_payload(req);

    let resp = shared_http_client()
        .post(&url)
        .header("x-api-key", &req.endpoint.api_key)
        .header("anthropic-version", ANTHROPIC_API_VERSION)
        .header("content-type", "application/json")
        .header("accept", "text/event-stream")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Anthropic request failed: {e}"))?;

    let mut state = AnthropicSseState::default();
    stream_sse_response(resp, on_chunk, |line| {
        process_anthropic_sse_line(&mut state, line)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::super::types::{
        resolve_fast_lane_endpoint, NativeMessage, NativeToolCall, NativeToolDef,
    };

    fn run_async<F: std::future::Future>(fut: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio runtime")
            .block_on(fut)
    }

    #[test]
    fn builds_payload_with_ephemeral_cache_control_on_system_and_last_tool() {
        let ep = resolve_fast_lane_endpoint(
            "anthropic",
            "claude-sonnet-4-20250514",
            Some("sk-ant-api03-test"),
            None,
            "api_key",
            None,
        )
        .unwrap();

        let req = NativeTurnRequest {
            endpoint: ep,
            system_prompt: Some("Follow strict workspace rules.".to_string()),
            messages: vec![
                NativeMessage {
                    role: NativeRole::User,
                    content: "Read foo.rs".to_string(),
                    tool_call_id: None,
                    tool_calls: vec![],
                },
                NativeMessage {
                    role: NativeRole::Assistant,
                    content: String::new(),
                    tool_call_id: None,
                    tool_calls: vec![NativeToolCall {
                        id: "toolu_1".to_string(),
                        name: "read_file".to_string(),
                        arguments: r#"{"path":"foo.rs"}"#.to_string(),
                    }],
                },
                NativeMessage {
                    role: NativeRole::Tool,
                    content: "fn main() {}".to_string(),
                    tool_call_id: Some("toolu_1".to_string()),
                    tool_calls: vec![],
                },
            ],
            tools: vec![
                NativeToolDef {
                    name: "read_file".to_string(),
                    description: "Read file".to_string(),
                    parameters: json!({"type": "object"}),
                },
                NativeToolDef {
                    name: "write_file".to_string(),
                    description: "Write file".to_string(),
                    parameters: json!({"type": "object"}),
                },
            ],
            max_tokens: Some(4096),
        };

        let payload = build_anthropic_payload(&req);
        assert_eq!(payload["stream"], json!(true));
        assert_eq!(payload["max_tokens"], json!(4096));
        assert_eq!(
            payload.pointer("/system/0/cache_control/type"),
            Some(&json!("ephemeral"))
        );
        assert!(payload.pointer("/tools/0/cache_control").is_none());
        assert_eq!(
            payload.pointer("/tools/1/cache_control/type"),
            Some(&json!("ephemeral"))
        );
        assert_eq!(
            payload.pointer("/messages/2/content/0/type"),
            Some(&json!("tool_result"))
        );
    }

    #[test]
    fn parses_anthropic_sse_events_including_thinking_and_tool_use() {
        assert_eq!(
            parse_anthropic_sse_event(
                Some("message_start"),
                r#"{"type":"message_start","message":{"usage":{"input_tokens":200,"cache_read_input_tokens":150,"output_tokens":1}}}"#
            ),
            vec![NativeStreamChunk::Usage(NativeUsage {
                input_tokens: 200,
                output_tokens: 1,
                cached_tokens: 150,
            })]
        );

        assert_eq!(
            parse_anthropic_sse_event(
                Some("content_block_delta"),
                r#"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Analyzing..."}}"#
            ),
            vec![NativeStreamChunk::ReasoningDelta("Analyzing...".to_string())]
        );

        assert_eq!(
            parse_anthropic_sse_event(
                Some("content_block_delta"),
                r#"{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Done."}}"#
            ),
            vec![NativeStreamChunk::TextDelta("Done.".to_string())]
        );

        assert_eq!(
            parse_anthropic_sse_event(
                Some("content_block_start"),
                r#"{"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_99","name":"grep_search","input":{}}}"#
            ),
            vec![NativeStreamChunk::ToolCallStart {
                id: "toolu_99".to_string(),
                name: "grep_search".to_string(),
            }]
        );

        assert_eq!(
            parse_anthropic_sse_event(
                Some("content_block_delta"),
                r#"{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"q\":\"main\"}"}}"#
            ),
            vec![NativeStreamChunk::ToolCallDelta {
                id: String::new(),
                arguments_delta: "{\"q\":\"main\"}".to_string(),
            }]
        );

        assert_eq!(
            parse_anthropic_sse_event(Some("message_stop"), r#"{"type":"message_stop"}"#),
            vec![NativeStreamChunk::Done]
        );
    }

    #[test]
    fn streams_anthropic_turn_resolving_tool_ids_and_headers() {
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
                assert!(req_str.contains("x-api-key: sk-ant-test"));
                assert!(req_str.contains("anthropic-version: 2023-06-01"));

                let body = concat!(
                    "event: message_start\n",
                    "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":80,\"cache_read_input_tokens\":30,\"output_tokens\":1}}}\n\n",
                    "event: content_block_start\n",
                    "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_42\",\"name\":\"read_file\"}}\n\n",
                    "event: content_block_delta\n",
                    "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"path\\\":\\\"lib.rs\\\"}\"}}\n\n",
                    "event: message_delta\n",
                    "data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":19}}\n\n",
                    "event: message_stop\n",
                    "data: {\"type\":\"message_stop\"}\n\n"
                );
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                sock.write_all(resp.as_bytes()).await.unwrap();
            });

            let ep = resolve_fast_lane_endpoint(
                "anthropic",
                "claude-sonnet-4-20250514",
                Some("sk-ant-test"),
                Some(&format!("http://{addr}/v1")),
                "api_key",
                None,
            )
            .unwrap();

            let req = NativeTurnRequest {
                endpoint: ep,
                system_prompt: Some("Be precise.".to_string()),
                messages: vec![NativeMessage {
                    role: NativeRole::User,
                    content: "Inspect lib.rs".to_string(),
                    tool_call_id: None,
                    tool_calls: vec![],
                }],
                tools: vec![],
                max_tokens: None,
            };

            let mut chunks = Vec::new();
            execute_anthropic_turn(&req, &mut |c| chunks.push(c))
                .await
                .unwrap();

            server.await.unwrap();

            assert_eq!(
                chunks,
                vec![
                    NativeStreamChunk::Usage(NativeUsage {
                        input_tokens: 80,
                        output_tokens: 1,
                        cached_tokens: 30,
                    }),
                    NativeStreamChunk::ToolCallStart {
                        id: "toolu_42".to_string(),
                        name: "read_file".to_string(),
                    },
                    NativeStreamChunk::ToolCallDelta {
                        id: "toolu_42".to_string(),
                        arguments_delta: "{\"path\":\"lib.rs\"}".to_string(),
                    },
                    NativeStreamChunk::Usage(NativeUsage {
                        input_tokens: 80,
                        output_tokens: 19,
                        cached_tokens: 30,
                    }),
                    NativeStreamChunk::Done,
                ]
            );
        });
    }
}
