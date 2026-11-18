//! Lightweight stdio MCP response compressor (`kite ctx mcp-proxy`).
//!
//! Wraps any stdio MCP server without adding an HTTP daemon: forwards stdin JSON-RPC
//! requests untouched and compresses oversized non-error `result.content[].text`
//! responses through [`ContextEngine`], storing originals in `ccr_store` and
//! recording `mcp:<server>` savings telemetry in [`SavingsLedger`].

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::time::Instant;

use serde_json::Value;

use crate::crusher::SmartCrusher;
use crate::error::{CtxError, Result};
use crate::ledger::LedgerEventInput;
use crate::lossless::compact_lossless;
use crate::pipeline::{detect_content_kind, ContentKind};
use crate::tokens::estimate_tokens;
use crate::ContextEngine;

pub const DEFAULT_MCP_MIN_BYTES: usize = 1024;

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
                "\n... [{omitted} lines compressed by kite-ctx MCP proxy — run `kite ctx retrieve {h}` for full output] <<ccr:{h}>> ...\n"
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

    // Forward stdin -> child_stdin transparently on a background thread.
    let stdin_forwarder = std::thread::spawn(move || {
        let mut writer = child_stdin;
        let stdin = std::io::stdin();
        let mut reader = BufReader::new(stdin.lock());
        let mut buf = Vec::with_capacity(4096);
        while let Ok(n) = reader.read_until(b'\n', &mut buf) {
            if n == 0 {
                break;
            }
            if writer.write_all(&buf).is_err() || writer.flush().is_err() {
                break;
            }
            buf.clear();
        }
    });

    // Read child_stdout line-by-line, compressing eligible JSON-RPC responses.
    let reader = BufReader::new(child_stdout);
    let mut stdout = std::io::stdout();
    for line_res in reader.lines() {
        let Ok(line) = line_res else {
            break;
        };
        let transformed = compress_mcp_jsonrpc_line(
            engine,
            &line,
            server_name,
            min_bytes,
            session_id,
            agent,
            provider,
            model,
        );
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
}
