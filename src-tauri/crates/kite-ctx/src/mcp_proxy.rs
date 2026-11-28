//! Lightweight stdio MCP response compressor (`kite ctx mcp-proxy`).
//!
//! Wraps any stdio MCP server without adding an HTTP daemon: forwards stdin JSON-RPC
//! requests untouched and compresses oversized non-error `result.content[].text`
//! responses through [`ContextEngine`], storing originals in `ccr_store` and
//! recording `mcp:<server>` savings telemetry in [`SavingsLedger`].

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde_json::{json, Value};

use crate::browser_cache::{
    redact_sensitive_browser_text, BrowserReadMode, BrowserSnapshotInput,
};
use crate::crusher::SmartCrusher;
use crate::error::{CtxError, Result};
use crate::ledger::LedgerEventInput;
use crate::lossless::compact_lossless;
use crate::pipeline::{detect_content_kind, ContentKind};
use crate::tokens::{estimate_tokens, sha256_hex};
use crate::ContextEngine;

pub const DEFAULT_MCP_MIN_BYTES: usize = 1024;

/// Metadata captured from an outbound JSON-RPC `tools/call` request so the corresponding
/// response can be routed through stateful browser caching, crushing, and image dedup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpToolCallMeta {
    pub tool_name: String,
    pub tab_id: String,
    pub url: Option<String>,
    pub mode: BrowserReadMode,
    pub fresh: bool,
}

/// Per-proxy-session tracking state mapping JSON-RPC `id`s to tool call metadata and
/// deduplicating identical base64 screenshots per `(session_id, tab_id)`.
#[derive(Debug, Default)]
pub struct McpProxySessionState {
    pub pending_calls: HashMap<String, McpToolCallMeta>,
    pub seen_image_hashes: HashMap<(String, String), HashMap<String, usize>>,
    pub turn_counter: usize,
}

impl McpProxySessionState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Inspect an outbound stdin JSON-RPC request line and record `tools/call` metadata.
    pub fn observe_request_line(&mut self, line: &str) {
        if !line.contains("\"tools/call\"") {
            return;
        }
        let Ok(parsed) = serde_json::from_str::<Value>(line) else {
            return;
        };
        if parsed.get("method").and_then(Value::as_str) != Some("tools/call") {
            return;
        }
        let Some(id_key) = jsonrpc_id_key(parsed.get("id")) else {
            return;
        };
        let Some(params) = parsed.get("params").and_then(Value::as_object) else {
            return;
        };
        let base_name = params
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if base_name.is_empty() {
            return;
        }
        let args = params.get("arguments").and_then(Value::as_object);
        let action = args
            .and_then(|a| a.get("action"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let tool_name = match action {
            Some(act) => format!("{base_name}:{act}"),
            None => base_name.to_string(),
        };
        let tab_id = args
            .and_then(|a| a.get("tab_id").or_else(|| a.get("tabId")))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("default")
            .to_string();
        let url = args
            .and_then(|a| a.get("url"))
            .and_then(Value::as_str)
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let mode = args
            .and_then(|a| a.get("mode"))
            .and_then(Value::as_str)
            .map(BrowserReadMode::from_str_lossy)
            .unwrap_or(BrowserReadMode::Auto);
        let fresh = args
            .and_then(|a| a.get("fresh"))
            .and_then(Value::as_bool)
            .unwrap_or(false);

        self.pending_calls.insert(
            id_key,
            McpToolCallMeta {
                tool_name,
                tab_id,
                url,
                mode,
                fresh,
            },
        );
    }

    pub fn take_call_meta(&mut self, id: Option<&Value>) -> Option<McpToolCallMeta> {
        let key = jsonrpc_id_key(id)?;
        self.pending_calls.remove(&key)
    }

    /// Record `sha256` for `(session_id, tab_id)` and return `Some(first_turn)` if already seen.
    pub fn check_or_record_image(
        &mut self,
        session_id: &str,
        tab_id: &str,
        sha256: &str,
    ) -> Option<usize> {
        let bucket = self
            .seen_image_hashes
            .entry((session_id.to_string(), tab_id.to_string()))
            .or_default();
        if let Some(&first_turn) = bucket.get(sha256) {
            return Some(first_turn);
        }
        bucket.insert(sha256.to_string(), self.turn_counter);
        None
    }
}

fn jsonrpc_id_key(id: Option<&Value>) -> Option<String> {
    match id? {
        Value::String(s) => Some(format!("s:{s}")),
        Value::Number(n) => Some(format!("n:{n}")),
        _ => None,
    }
}

fn is_browser_snapshot_tool(tool_name: &str) -> bool {
    let lower = tool_name.to_ascii_lowercase();
    lower.contains("snapshot") || lower.contains("ax_tree") || lower.contains("axtree")
}

fn is_browser_network_or_console_tool(tool_name: &str) -> bool {
    let lower = tool_name.to_ascii_lowercase();
    lower.contains("network") || lower.contains("console") || lower.contains(":errors")
}

/// Inspect a single JSON-RPC stdout line from an MCP server and compress oversized
/// text content blocks if doing so reduces token footprint.
#[allow(clippy::too_many_arguments)]
pub fn compress_mcp_jsonrpc_line(
    engine: &ContextEngine,
    line: &str,
    server_name: &str,
    min_bytes: usize,
    session_id: &str,
    agent: &str,
    provider: &str,
    model: &str,
) -> String {
    let threshold = min_bytes.max(128);
    if line.len() < threshold || !line.contains("\"result\"") || !line.contains("\"content\"") {
        return line.to_string();
    }

    let start = Instant::now();
    let Ok(mut parsed) = serde_json::from_str::<Value>(line) else {
        return line.to_string();
    };

    let Some(result_obj) = parsed.get_mut("result").and_then(Value::as_object_mut) else {
        return line.to_string();
    };

    if result_obj
        .get("isError")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return line.to_string();
    }

    let Some(content_arr) = result_obj.get_mut("content").and_then(Value::as_array_mut) else {
        return line.to_string();
    };

    let mut total_raw_tokens = 0usize;
    let mut total_compressed_tokens = 0usize;
    let mut any_compressed = false;

    for item in content_arr.iter_mut() {
        let is_text = item
            .get("type")
            .and_then(Value::as_str)
            .is_some_and(|t| t == "text");
        if !is_text {
            continue;
        }
        let Some(raw_text) = item.get("text").and_then(Value::as_str) else {
            continue;
        };
        if raw_text.len() < threshold {
            continue;
        }

        let raw_tokens = estimate_tokens(raw_text);
        let compressed = compress_mcp_text_payload(engine, raw_text, threshold, session_id);
        let comp_tokens = estimate_tokens(&compressed);

        if comp_tokens < raw_tokens && compressed.len() < raw_text.len() {
            if let Some(obj) = item.as_object_mut() {
                obj.insert("text".to_string(), Value::String(compressed));
            }
            total_raw_tokens += raw_tokens;
            total_compressed_tokens += comp_tokens;
            any_compressed = true;
        }
    }

    if !any_compressed {
        return line.to_string();
    }

    let Ok(serialized) = serde_json::to_string(&parsed) else {
        return line.to_string();
    };

    let label = if server_name.trim().is_empty() {
        "mcp:stdio".to_string()
    } else if server_name.starts_with("mcp:") {
        server_name.trim().to_string()
    } else {
        format!("mcp:{}", server_name.trim())
    };

    let _ = engine.ledger().record(&LedgerEventInput {
        session_id: session_id.to_string(),
        agent: agent.to_string(),
        provider: provider.to_string(),
        model: model.to_string(),
        category: "mcp".to_string(),
        command_or_tool: label,
        raw_tokens: total_raw_tokens,
        compressed_tokens: total_compressed_tokens,
        cache_hit: false,
        overhead_ms: start.elapsed().as_millis() as u64,
    });

    serialized
}

/// Stateful variant of [`compress_mcp_jsonrpc_line`] that correlates JSON-RPC response IDs
/// with recorded `tools/call` metadata to route browser snapshots through [`BrowserReadCache`],
/// network/console arrays through [`SmartCrusher`], and base64 `image` blocks through SHA-256
/// per-tab deduplication.
#[allow(clippy::too_many_arguments)]
pub fn compress_mcp_jsonrpc_line_stateful(
    engine: &ContextEngine,
    state: &mut McpProxySessionState,
    line: &str,
    server_name: &str,
    min_bytes: usize,
    session_id: &str,
    agent: &str,
    provider: &str,
    model: &str,
) -> String {
    let threshold = min_bytes.max(128);
    if !line.contains("\"result\"") || !line.contains("\"content\"") {
        return line.to_string();
    }

    let start = Instant::now();
    let Ok(mut parsed) = serde_json::from_str::<Value>(line) else {
        return line.to_string();
    };

    let meta = state.take_call_meta(parsed.get("id"));
    let Some(result_obj) = parsed.get_mut("result").and_then(Value::as_object_mut) else {
        return line.to_string();
    };
    if result_obj
        .get("isError")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return line.to_string();
    }
    let Some(content_arr) = result_obj.get_mut("content").and_then(Value::as_array_mut) else {
        return line.to_string();
    };

    state.turn_counter += 1;
    let tab_id = meta
        .as_ref()
        .map(|m| m.tab_id.clone())
        .unwrap_or_else(|| "default".to_string());
    let tool_name = meta
        .as_ref()
        .map(|m| m.tool_name.as_str())
        .unwrap_or("");

    let mut any_modified = false;
    let mut generic_raw_tokens = 0usize;
    let mut generic_comp_tokens = 0usize;

    for item in content_arr.iter_mut() {
        let item_type = item.get("type").and_then(Value::as_str).unwrap_or("");
        if item_type == "image" {
            let Some(b64_data) = item.get("data").and_then(Value::as_str) else {
                continue;
            };
            if b64_data.is_empty() {
                continue;
            }
            let digest = sha256_hex(b64_data);
            if let Some(first_turn) = state.check_or_record_image(session_id, &tab_id, &digest) {
                let raw_tokens = estimate_tokens(b64_data);
                let short_sha = &digest[..12.min(digest.len())];
                let stub = format!(
                    "[Screenshot unchanged since turn #{first_turn} — tab:{tab_id} sha256:{short_sha}]"
                );
                let comp_tokens = estimate_tokens(&stub);
                *item = json!({
                    "type": "text",
                    "text": stub,
                });
                let _ = engine.ledger().record(&LedgerEventInput {
                    session_id: session_id.to_string(),
                    agent: agent.to_string(),
                    provider: provider.to_string(),
                    model: model.to_string(),
                    category: "browser".to_string(),
                    command_or_tool: "browser:screenshot_dedup".to_string(),
                    raw_tokens,
                    compressed_tokens: comp_tokens,
                    cache_hit: true,
                    overhead_ms: start.elapsed().as_millis() as u64,
                });
                any_modified = true;
            }
            continue;
        }

        if item_type != "text" {
            continue;
        }
        let Some(raw_text) = item.get("text").and_then(Value::as_str) else {
            continue;
        };

        let detected = detect_content_kind(raw_text);
        if is_browser_snapshot_tool(tool_name) || detected == ContentKind::AxTree {
            let url = meta
                .as_ref()
                .and_then(|m| m.url.clone())
                .unwrap_or_else(|| format!("browser://{server_name}/{tab_id}"));
            let input = BrowserSnapshotInput {
                session_id: session_id.to_string(),
                tab_id: tab_id.clone(),
                url,
                title: None,
                raw_text: raw_text.to_string(),
                nodes: None,
                mode: meta
                    .as_ref()
                    .map(|m| m.mode)
                    .unwrap_or(BrowserReadMode::Auto),
                fresh: meta.as_ref().is_some_and(|m| m.fresh),
                agent: agent.to_string(),
                provider: provider.to_string(),
                model: model.to_string(),
            };
            if let Ok(res) =
                engine
                    .browser_cache()
                    .ingest_snapshot(&input, engine.ccr(), engine.ledger())
            {
                if res.text != raw_text {
                    if let Some(obj) = item.as_object_mut() {
                        obj.insert("text".to_string(), Value::String(res.text));
                    }
                    any_modified = true;
                }
            }
            continue;
        }

        if is_browser_network_or_console_tool(tool_name)
            || detected == ContentKind::NetworkWaterfall
        {
            let scrubbed = redact_sensitive_browser_text(raw_text);
            let raw_tokens = estimate_tokens(raw_text);
            let crushed = if serde_json::from_str::<Value>(scrubbed.trim()).is_ok() {
                SmartCrusher::default()
                    .crush(&scrubbed, Some(engine.ccr()))
                    .map(|c| c.output)
                    .unwrap_or_else(|_| compact_lossless(&scrubbed, ContentKind::NetworkWaterfall))
            } else {
                compact_lossless(&scrubbed, ContentKind::NetworkWaterfall)
            };
            let comp_tokens = estimate_tokens(&crushed);
            if crushed != raw_text && (comp_tokens < raw_tokens || crushed.len() < raw_text.len()) {
                if let Some(obj) = item.as_object_mut() {
                    obj.insert("text".to_string(), Value::String(crushed));
                }
                let is_net = tool_name.to_ascii_lowercase().contains("network")
                    || detected == ContentKind::NetworkWaterfall;
                let feature_cmd = if is_net {
                    "browser:network_crush".to_string()
                } else {
                    format!("browser:{}", server_name.trim())
                };
                let _ = engine.ledger().record(&LedgerEventInput {
                    session_id: session_id.to_string(),
                    agent: agent.to_string(),
                    provider: provider.to_string(),
                    model: model.to_string(),
                    category: "browser".to_string(),
                    command_or_tool: feature_cmd,
                    raw_tokens,
                    compressed_tokens: comp_tokens,
                    cache_hit: false,
                    overhead_ms: start.elapsed().as_millis() as u64,
                });
                any_modified = true;
            }
            continue;
        }

        if raw_text.len() < threshold {
            continue;
        }
        let raw_tokens = estimate_tokens(raw_text);
        let compressed = compress_mcp_text_payload(engine, raw_text, threshold, session_id);
        let comp_tokens = estimate_tokens(&compressed);
        if comp_tokens < raw_tokens && compressed.len() < raw_text.len() {
            if let Some(obj) = item.as_object_mut() {
                obj.insert("text".to_string(), Value::String(compressed));
            }
            generic_raw_tokens += raw_tokens;
            generic_comp_tokens += comp_tokens;
            any_modified = true;
        }
    }

    if !any_modified {
        return line.to_string();
    }

    if generic_raw_tokens > 0 {
        let label = if server_name.trim().is_empty() {
            "mcp:stdio".to_string()
        } else if server_name.starts_with("mcp:") {
            server_name.trim().to_string()
        } else {
            format!("mcp:{}", server_name.trim())
        };
        let _ = engine.ledger().record(&LedgerEventInput {
            session_id: session_id.to_string(),
            agent: agent.to_string(),
            provider: provider.to_string(),
            model: model.to_string(),
            category: "mcp".to_string(),
            command_or_tool: label,
            raw_tokens: generic_raw_tokens,
            compressed_tokens: generic_comp_tokens,
            cache_hit: false,
            overhead_ms: start.elapsed().as_millis() as u64,
        });
    }

    serde_json::to_string(&parsed).unwrap_or_else(|_| line.to_string())
}

fn compress_mcp_text_payload(
    engine: &ContextEngine,
    raw_text: &str,
    min_bytes: usize,
    session_id: &str,
) -> String {
    let kind = detect_content_kind(raw_text);
    let stage_one = match kind {
        ContentKind::Json => match SmartCrusher::default().crush(raw_text, Some(engine.ccr())) {
            Ok(crushed) => crushed.output,
            Err(_) => compact_lossless(raw_text, kind),
        },
        other => compact_lossless(raw_text, other),
    };

    // If lossless/crusher already achieved >= 15% byte savings or fits comfortably, return it.
    let hard_cap = (min_bytes * 3).max(3072);
    if stage_one.len() <= hard_cap || stage_one.len() * 100 <= raw_text.len() * 85 {
        return stage_one;
    }

    // Otherwise store full text in CCR and preserve head + tail anchors.
    let lines: Vec<&str> = stage_one.lines().collect();
    if lines.len() > 40 {
        let head_count = 24;
        let tail_count = 10;
        let omitted = lines.len().saturating_sub(head_count + tail_count);
        let head = lines[..head_count].join("\n");
        let tail = lines[lines.len() - tail_count..].join("\n");
        let preview = format!("{head}\n...\n{tail}");
        let ccr_hash = engine
            .ccr()
            .put(raw_text, &preview, "mcp_proxy", session_id)
            .ok();
        let marker = match ccr_hash {
            Some(h) => format!(
                "\n... [{omitted} lines compressed by kite-ctx MCP proxy — run `kite ctx retrieve {h} --search <term>` or `--lines N-M`] <<ccr:{h}>> ...\n"
            ),
            None => format!("\n... [{omitted} lines compressed by kite-ctx MCP proxy] ...\n"),
        };
        return format!("{head}{marker}{tail}");
    }

    stage_one
}

/// Spawn a downstream stdio MCP server and proxy stdin/stdout with response compression.
#[allow(clippy::too_many_arguments)]
pub fn run_mcp_stdio_proxy(
    engine: &ContextEngine,
    server_name: &str,
    min_bytes: usize,
    command: &[String],
    session_id: &str,
    agent: &str,
    provider: &str,
    model: &str,
) -> Result<i32> {
    let Some(program) = command.first() else {
        return Err(CtxError::InvalidInput(
            "mcp-proxy requires a command after `--`".to_string(),
        ));
    };
    let rest = &command[1..];

    let mut child = spawn_mcp_child(program, rest)?;
    let child_stdin = child
        .stdin
        .take()
        .ok_or_else(|| CtxError::InvalidInput("failed to open child stdin".to_string()))?;
    let child_stdout = child
        .stdout
        .take()
        .ok_or_else(|| CtxError::InvalidInput("failed to open child stdout".to_string()))?;

    let state = Arc::new(Mutex::new(McpProxySessionState::new()));
    let stdin_state = Arc::clone(&state);

    // Forward stdin -> child_stdin transparently on a background thread while recording tools/call metadata.
    let stdin_forwarder = std::thread::spawn(move || {
        let mut writer = child_stdin;
        let stdin = std::io::stdin();
        let mut reader = BufReader::new(stdin.lock());
        let mut buf = Vec::with_capacity(4096);
        while let Ok(n) = reader.read_until(b'\n', &mut buf) {
            if n == 0 {
                break;
            }
            if let Ok(req_line) = std::str::from_utf8(&buf) {
                if let Ok(mut guard) = stdin_state.lock() {
                    guard.observe_request_line(req_line);
                }
            }
            if writer.write_all(&buf).is_err() || writer.flush().is_err() {
                break;
            }
            buf.clear();
        }
    });

    // Read child_stdout line-by-line, compressing eligible JSON-RPC responses statefully.
    let reader = BufReader::new(child_stdout);
    let mut stdout = std::io::stdout();
    for line_res in reader.lines() {
        let Ok(line) = line_res else {
            break;
        };
        let transformed = if let Ok(mut guard) = state.lock() {
            compress_mcp_jsonrpc_line_stateful(
                engine,
                &mut guard,
                &line,
                server_name,
                min_bytes,
                session_id,
                agent,
                provider,
                model,
            )
        } else {
            compress_mcp_jsonrpc_line(
                engine,
                &line,
                server_name,
                min_bytes,
                session_id,
                agent,
                provider,
                model,
            )
        };
        let _ = writeln!(stdout, "{transformed}");
        let _ = stdout.flush();
    }

    let status = child.wait()?;
    drop(stdin_forwarder);
    Ok(status.code().unwrap_or(1))
}

fn spawn_mcp_child(program: &str, rest: &[String]) -> std::io::Result<std::process::Child> {
    match Command::new(program)
        .args(rest)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
    {
        Ok(child) => Ok(child),
        Err(err) if cfg!(windows) && err.kind() == std::io::ErrorKind::NotFound => {
            Command::new("cmd")
                .arg("/C")
                .arg(program)
                .args(rest)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()
        }
        Err(err) => Err(err),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn compresses_large_mcp_tool_responses_and_preserves_errors_and_small_messages() {
        let engine = ContextEngine::open_in_memory().unwrap();

        // 1. Small response is untouched
        let small = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": {
                "content": [{"type": "text", "text": "short response"}]
            }
        })
        .to_string();
        assert_eq!(
            compress_mcp_jsonrpc_line(&engine, &small, "context7", 512, "s1", "agy", "google", "gemini-3.1-pro"),
            small
        );

        // 2. Error response is untouched even if large
        let noisy_err = "error line\n".repeat(120);
        let err_msg = json!({
            "jsonrpc": "2.0",
            "id": 2,
            "result": {
                "isError": true,
                "content": [{"type": "text", "text": noisy_err}]
            }
        })
        .to_string();
        assert_eq!(
            compress_mcp_jsonrpc_line(&engine, &err_msg, "context7", 256, "s1", "agy", "google", "gemini-3.1-pro"),
            err_msg
        );

        // 3. Large uniform JSON array inside MCP text response is crushed and recorded in ledger
        let rows: Vec<Value> = (0..40)
            .map(|i| {
                json!({
                    "id": i,
                    "status": "active",
                    "workspace": "kite-desktop",
                    "description": format!("item number {i} in documentation query")
                })
            })
            .collect();
        let raw_payload = serde_json::to_string_pretty(&rows).unwrap();
        let big_msg = json!({
            "jsonrpc": "2.0",
            "id": 3,
            "result": {
                "content": [{"type": "text", "text": raw_payload}]
            }
        })
        .to_string();

        let compressed_line = compress_mcp_jsonrpc_line(
            &engine,
            &big_msg,
            "context7",
            256,
            "s-mcp",
            "Orion",
            "anthropic",
            "claude-sonnet-4-5",
        );
        assert!(compressed_line.len() < big_msg.len());

        let parsed: Value = serde_json::from_str(&compressed_line).unwrap();
        let text_out = parsed["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text_out.contains("<<ccr:"));

        let snap = engine.ledger().snapshot(Some("s-mcp")).unwrap();
        assert_eq!(snap.session.requests, 1);
        assert!(snap.session.tokens_saved > 0);
        assert!(snap.features.iter().any(|f| f.feature == "mcp:context7"));
    }

    #[test]
    fn stateful_proxy_caches_snapshots_crushes_network_and_deduplicates_images() {
        let engine = ContextEngine::open_in_memory().unwrap();
        let mut state = McpProxySessionState::new();

        // 1. Track snapshot tools/call and return unchanged stub on repeat
        let snap_req1 = json!({
            "jsonrpc": "2.0",
            "id": 10,
            "method": "tools/call",
            "params": {
                "name": "kite_browser",
                "arguments": { "action": "snapshot", "tab_id": "tab-a", "url": "http://localhost:5173/app" }
            }
        })
        .to_string();
        state.observe_request_line(&snap_req1);

        let ax = "RootWebArea \"App\"\n  main\n    heading \"Home\"\n    button \"Run Tests\" [@e1]\n    link \"Settings\" [@e2]\n".to_string();
        let snap_resp1 = json!({
            "jsonrpc": "2.0",
            "id": 10,
            "result": { "content": [{ "type": "text", "text": ax }] }
        })
        .to_string();
        let out1 = compress_mcp_jsonrpc_line_stateful(
            &engine, &mut state, &snap_resp1, "kite", 1024, "s-b", "Browser", "google", "gemini-4",
        );
        assert!(out1.contains("Run Tests"));

        let snap_req2 = json!({
            "jsonrpc": "2.0",
            "id": 11,
            "method": "tools/call",
            "params": {
                "name": "kite_browser",
                "arguments": { "action": "snapshot", "tab_id": "tab-a", "url": "http://localhost:5173/app" }
            }
        })
        .to_string();
        state.observe_request_line(&snap_req2);
        let snap_resp2 = json!({
            "jsonrpc": "2.0",
            "id": 11,
            "result": { "content": [{ "type": "text", "text": ax }] }
        })
        .to_string();
        let out2 = compress_mcp_jsonrpc_line_stateful(
            &engine, &mut state, &snap_resp2, "kite", 1024, "s-b", "Browser", "google", "gemini-4",
        );
        assert!(out2.contains("[Unchanged #1"));

        // 2. Deduplicate identical base64 image block on same (session_id, tab_id)
        let img_req1 = json!({
            "jsonrpc": "2.0",
            "id": 12,
            "method": "tools/call",
            "params": { "name": "kite_browser", "arguments": { "action": "screenshot", "tab_id": "tab-a" } }
        })
        .to_string();
        state.observe_request_line(&img_req1);
        let fake_png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ".repeat(12);
        let img_resp1 = json!({
            "jsonrpc": "2.0",
            "id": 12,
            "result": { "content": [{ "type": "image", "data": fake_png, "mimeType": "image/png" }] }
        })
        .to_string();
        let img_out1 = compress_mcp_jsonrpc_line_stateful(
            &engine, &mut state, &img_resp1, "kite", 256, "s-b", "Browser", "google", "gemini-4",
        );
        assert!(img_out1.contains("\"type\":\"image\""));

        let img_req2 = json!({
            "jsonrpc": "2.0",
            "id": 13,
            "method": "tools/call",
            "params": { "name": "kite_browser", "arguments": { "action": "screenshot", "tab_id": "tab-a" } }
        })
        .to_string();
        state.observe_request_line(&img_req2);
        let img_resp2 = json!({
            "jsonrpc": "2.0",
            "id": 13,
            "result": { "content": [{ "type": "image", "data": fake_png, "mimeType": "image/png" }] }
        })
        .to_string();
        let img_out2 = compress_mcp_jsonrpc_line_stateful(
            &engine, &mut state, &img_resp2, "kite", 256, "s-b", "Browser", "google", "gemini-4",
        );
        assert!(img_out2.contains("Screenshot unchanged since turn #3"));

        // 3. Network JSON array crushed and scrubbed
        let net_req = json!({
            "jsonrpc": "2.0",
            "id": 14,
            "method": "tools/call",
            "params": { "name": "kite_browser", "arguments": { "action": "network", "tab_id": "tab-a" } }
        })
        .to_string();
        state.observe_request_line(&net_req);
        let net_rows: Vec<Value> = (0..30)
            .map(|i| {
                json!({
                    "method": "GET",
                    "url": format!("https://api.local/items/{i}"),
                    "status": 200,
                    "duration_ms": 12 + i,
                    "authorization": "Bearer secret-jwt-token"
                })
            })
            .collect();
        let net_resp = json!({
            "jsonrpc": "2.0",
            "id": 14,
            "result": { "content": [{ "type": "text", "text": serde_json::to_string(&net_rows).unwrap() }] }
        })
        .to_string();
        let net_out = compress_mcp_jsonrpc_line_stateful(
            &engine, &mut state, &net_resp, "kite", 256, "s-b", "Browser", "google", "gemini-4",
        );
        assert!(!net_out.contains("secret-jwt-token"));
        assert!(net_out.len() < net_resp.len());

        let snap = engine.ledger().snapshot(Some("s-b")).unwrap();
        assert!(snap.features.iter().any(|f| f.feature == "browser:snapshot_stub"));
        assert!(snap.features.iter().any(|f| f.feature == "browser:screenshot_dedup"));
        assert!(snap.features.iter().any(|f| f.feature == "browser:network_crush"));
    }
}
