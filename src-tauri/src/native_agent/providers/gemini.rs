use super::super::types::{
    shared_http_client, NativeRole, NativeStreamChunk, NativeTurnRequest, NativeUsage,
};
use super::stream_sse_response;
use serde_json::{json, Value};
use std::collections::HashMap;

#[derive(Debug, Default)]
struct GeminiSseState {
    next_call_seq: u64,
}

pub fn stream_generate_endpoint(base_url: &str, model: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.contains(":streamGenerateContent") {
        if trimmed.contains("alt=sse") {
            trimmed.to_string()
        } else if trimmed.contains('?') {
            format!("{trimmed}&alt=sse")
        } else {
            format!("{trimmed}?alt=sse")
        }
    } else {
        let clean_model = model.trim().trim_start_matches("models/");
        format!("{trimmed}/models/{clean_model}:streamGenerateContent?alt=sse")
    }
}

fn push_gemini_user_parts(contents: &mut Vec<Value>, new_parts: Vec<Value>) {
    if new_parts.is_empty() {
        return;
    }
    if let Some(last) = contents.last_mut() {
        if last.get("role").and_then(Value::as_str) == Some("user") {
            if let Some(arr) = last.get_mut("parts").and_then(Value::as_array_mut) {
                arr.extend(new_parts);
                return;
            }
        }
    }
    contents.push(json!({
        "role": "user",
        "parts": new_parts
    }));
}

pub fn build_gemini_payload(req: &NativeTurnRequest) -> Value {
    let mut system_parts: Vec<String> = Vec::new();
    if let Some(sys) = req
        .system_prompt
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        system_parts.push(sys.to_string());
    }

    let mut tool_id_to_name: HashMap<String, String> = HashMap::new();
    let mut contents: Vec<Value> = Vec::new();

    for msg in &req.messages {
        match msg.role {
            NativeRole::System => {
                let s = msg.content.trim();
                if !s.is_empty() {
                    system_parts.push(s.to_string());
                }
            }
            NativeRole::User => {
                push_gemini_user_parts(&mut contents, vec![json!({ "text": msg.content })]);
            }
            NativeRole::Assistant => {
                let mut parts: Vec<Value> = Vec::new();
                if !msg.content.is_empty() {
                    parts.push(json!({ "text": msg.content }));
                }
                for tc in &msg.tool_calls {
                    tool_id_to_name.insert(tc.id.clone(), tc.name.clone());
                    let args_val: Value = serde_json::from_str(&tc.arguments)
                        .unwrap_or_else(|_| json!({}));
                    parts.push(json!({
                        "functionCall": {
                            "name": tc.name,
                            "args": args_val
                        }
                    }));
                }
                if !parts.is_empty() {
                    contents.push(json!({
                        "role": "model",
                        "parts": parts
                    }));
                }
            }
            NativeRole::Tool => {
                let call_id = msg.tool_call_id.as_deref().unwrap_or("");
                let func_name = tool_id_to_name
                    .get(call_id)
                    .map(String::as_str)
                    .filter(|s| !s.is_empty())
                    .unwrap_or(if call_id.is_empty() { "tool" } else { call_id });
                push_gemini_user_parts(
                    &mut contents,
                    vec![json!({
                        "functionResponse": {
                            "name": func_name,
                            "response": { "result": msg.content }
                        }
                    })],
                );
            }
        }
    }

    let mut payload = json!({
        "contents": contents,
    });

    if !system_parts.is_empty() {
        payload["systemInstruction"] = json!({
            "parts": [{ "text": system_parts.join("\n\n") }]
        });
    }

    if !req.tools.is_empty() {
        let decls: Vec<Value> = req
            .tools
            .iter()
            .map(|t| {
                json!({
                    "name": t.name,
                    "description": t.description,
                    "parameters": t.parameters
                })
            })
            .collect();
        payload["tools"] = json!([{ "functionDeclarations": decls }]);
    }

    if let Some(max_tokens) = req.max_tokens {
        payload["generationConfig"] = json!({
            "maxOutputTokens": max_tokens
        });
    }

    payload
}

fn parse_gemini_sse_line_with_state(
    state: &mut GeminiSseState,
    line: &str,
) -> Vec<NativeStreamChunk> {
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

    if let Some(err) = parsed.get("error") {
        let message = err
            .get("message")
            .and_then(Value::as_str)
            .or_else(|| err.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| err.to_string());
        let is_rate_limit = err.get("code").and_then(Value::as_u64) == Some(429)
            || err.get("status").and_then(Value::as_str) == Some("RESOURCE_EXHAUSTED");
        return vec![if is_rate_limit {
            NativeStreamChunk::RateLimited {
                retry_after_ms: None,
                message,
            }
        } else {
            NativeStreamChunk::Error(message)
        }];
    }

    let mut chunks = Vec::new();

    if let Some(parts) = parsed
        .pointer("/candidates/0/content/parts")
        .and_then(Value::as_array)
    {
        for part in parts {
            let is_thought_flag = part.get("thought").and_then(Value::as_bool) == Some(true);
            if is_thought_flag {
                if let Some(text) = part.get("text").and_then(Value::as_str) {
                    if !text.is_empty() {
                        chunks.push(NativeStreamChunk::ReasoningDelta(text.to_string()));
                    }
                }
                continue;
            }
            if let Some(thought_text) = part.get("thought").and_then(Value::as_str) {
                if !thought_text.is_empty() {
                    chunks.push(NativeStreamChunk::ReasoningDelta(thought_text.to_string()));
                }
            }
            if let Some(text) = part.get("text").and_then(Value::as_str) {
                if !text.is_empty() {
                    chunks.push(NativeStreamChunk::TextDelta(text.to_string()));
                }
            }
            if let Some(fc) = part.get("functionCall") {
                let name = fc
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let seq = state.next_call_seq;
                state.next_call_seq += 1;
                let id = fc
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("gemini_call_{seq}"));
                let args_val = fc.get("args").cloned().unwrap_or_else(|| json!({}));
                let args_str = serde_json::to_string(&args_val).unwrap_or_else(|_| "{}".to_string());
                chunks.push(NativeStreamChunk::ToolCallStart {
                    id: id.clone(),
                    name,
                });
                chunks.push(NativeStreamChunk::ToolCallDelta {
                    id,
                    arguments_delta: args_str,
                });
            }
        }
    }

    if let Some(usage) = parsed.get("usageMetadata").filter(|u| u.is_object()) {
        let input_tokens = usage
            .get("promptTokenCount")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let output_tokens = usage
            .get("candidatesTokenCount")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let cached_tokens = usage
            .get("cachedContentTokenCount")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        chunks.push(NativeStreamChunk::Usage(NativeUsage {
            input_tokens,
            output_tokens,
            cached_tokens,
        }));
    }

    if let Some(finish) = parsed
        .pointer("/candidates/0/finishReason")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let _ = finish;
        chunks.push(NativeStreamChunk::Done);
    }

    chunks
}

/// Parses a single Gemini `streamGenerateContent?alt=sse` line into normalized
/// `NativeStreamChunk` items.
pub fn parse_gemini_sse_line(line: &str) -> Vec<NativeStreamChunk> {
    let mut state = GeminiSseState::default();
    parse_gemini_sse_line_with_state(&mut state, line)
}

pub async fn execute_gemini_turn(
    req: &NativeTurnRequest,
    on_chunk: &mut (dyn FnMut(NativeStreamChunk) + Send),
) -> Result<(), String> {
    let url = stream_generate_endpoint(&req.endpoint.base_url, &req.endpoint.model);
    let payload = build_gemini_payload(req);

    let resp = shared_http_client()
        .post(&url)
        .header("x-goog-api-key", &req.endpoint.api_key)
        .header("content-type", "application/json")
        .header("accept", "text/event-stream")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Gemini request failed: {e}"))?;

    let mut state = GeminiSseState::default();
    stream_sse_response(resp, on_chunk, |line| {
        parse_gemini_sse_line_with_state(&mut state, line)
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
    fn builds_gemini_endpoint_and_payload_with_tool_response_mapping() {
        assert_eq!(
            stream_generate_endpoint(
                "https://generativelanguage.googleapis.com/v1beta",
                "models/gemini-2.5-pro"
            ),
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse"
        );

        let ep = resolve_fast_lane_endpoint(
            "gemini",
            "gemini-2.5-pro",
            Some("AIzaTest"),
            None,
            "api_key",
            None,
        )
        .unwrap();

        let req = NativeTurnRequest {
            endpoint: ep,
            system_prompt: Some("System guide".to_string()),
            messages: vec![
                NativeMessage {
                    role: NativeRole::User,
                    content: "Search symbol".to_string(),
                    tool_call_id: None,
                    tool_calls: vec![],
                },
                NativeMessage {
                    role: NativeRole::Assistant,
                    content: String::new(),
                    tool_call_id: None,
                    tool_calls: vec![NativeToolCall {
                        id: "call_g1".to_string(),
                        name: "grep_search".to_string(),
                        arguments: r#"{"pattern":"FastLane"}"#.to_string(),
                    }],
                },
                NativeMessage {
                    role: NativeRole::Tool,
                    content: "types.rs:10".to_string(),
                    tool_call_id: Some("call_g1".to_string()),
                    tool_calls: vec![],
                },
            ],
            tools: vec![NativeToolDef {
                name: "grep_search".to_string(),
                description: "Search files".to_string(),
                parameters: json!({"type": "object"}),
            }],
            max_tokens: Some(2048),
        };

        let payload = build_gemini_payload(&req);
        assert_eq!(
            payload.pointer("/systemInstruction/parts/0/text"),
            Some(&json!("System guide"))
        );
        assert_eq!(
            payload.pointer("/contents/2/parts/0/functionResponse/name"),
            Some(&json!("grep_search"))
        );
        assert_eq!(
            payload.pointer("/generationConfig/maxOutputTokens"),
            Some(&json!(2048))
        );
    }

    #[test]
    fn parses_gemini_sse_lines_with_thought_text_function_call_and_usage() {
        let thought = parse_gemini_sse_line(
            r#"data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"Planning step"}]}}]}"#,
        );
        assert_eq!(
            thought,
            vec![NativeStreamChunk::ReasoningDelta("Planning step".to_string())]
        );

        let fn_and_usage = parse_gemini_sse_line(
            r#"data: {"candidates":[{"content":{"parts":[{"text":"Checking"},{"functionCall":{"name":"read_file","args":{"path":"Cargo.toml"}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":50,"candidatesTokenCount":12,"cachedContentTokenCount":20}}"#,
        );
        assert_eq!(
            fn_and_usage,
            vec![
                NativeStreamChunk::TextDelta("Checking".to_string()),
                NativeStreamChunk::ToolCallStart {
                    id: "gemini_call_0".to_string(),
                    name: "read_file".to_string(),
                },
                NativeStreamChunk::ToolCallDelta {
                    id: "gemini_call_0".to_string(),
                    arguments_delta: r#"{"path":"Cargo.toml"}"#.to_string(),
                },
                NativeStreamChunk::Usage(NativeUsage {
                    input_tokens: 50,
                    output_tokens: 12,
                    cached_tokens: 20,
                }),
                NativeStreamChunk::Done,
            ]
        );
    }

    #[test]
    fn streams_gemini_turn_over_http_loopback() {
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
                assert!(req_str.contains("/v1beta/models/gemini-2.5-flash:streamgeneratecontent?alt=sse"));
                assert!(req_str.contains("x-goog-api-key: aiza-local"));

                let body = concat!(
                    "data: {\"candidates\":[{\"content\":{\"parts\":[{\"thought\":true,\"text\":\"Thinking\"}]}}]}\r\n\r\n",
                    "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"Result ok\"}]},\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":15,\"candidatesTokenCount\":5}}\r\n\r\n"
                );
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                sock.write_all(resp.as_bytes()).await.unwrap();
            });

            let ep = resolve_fast_lane_endpoint(
                "gemini",
                "gemini-2.5-flash",
                Some("aiza-local"),
                Some(&format!("http://{addr}/v1beta")),
                "api_key",
                None,
            )
            .unwrap();

            let req = NativeTurnRequest {
                endpoint: ep,
                system_prompt: None,
                messages: vec![NativeMessage {
                    role: NativeRole::User,
                    content: "Ping".to_string(),
                    tool_call_id: None,
                    tool_calls: vec![],
                }],
                tools: vec![],
                max_tokens: None,
            };

            let mut chunks = Vec::new();
            execute_gemini_turn(&req, &mut |c| chunks.push(c))
                .await
                .unwrap();

            server.await.unwrap();

            assert_eq!(
                chunks,
                vec![
                    NativeStreamChunk::ReasoningDelta("Thinking".to_string()),
                    NativeStreamChunk::TextDelta("Result ok".to_string()),
                    NativeStreamChunk::Usage(NativeUsage {
                        input_tokens: 15,
                        output_tokens: 5,
                        cached_tokens: 0,
                    }),
                    NativeStreamChunk::Done,
                ]
            );
        });
    }
}
