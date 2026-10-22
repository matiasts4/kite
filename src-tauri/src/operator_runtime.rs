// Kite Code — operator agent runtime (Tauri IPC)
// Executes fast headless turns for the Kite Operator Assistant (AntiGravity, Grok, Codex)
// without launching visible windows or full TUI sessions.

use crate::chat::resolve_bin;
use crate::hidden_exec;
use serde_json::{json, Value};
use std::time::{Duration, Instant};

#[tauri::command]
pub fn query_operator_agent(request: Value) -> Value {
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
        .map(|s| s.trim());

    let timeout_secs = req
        .get("timeoutSecs")
        .and_then(|v| v.as_u64())
        .unwrap_or(20);

    let start = Instant::now();

    let (bin, args) = match engine {
        "antigravity" | "agy" => {
            let bin = match resolve_bin("agy", &[r"C:\Users\PC\AppData\Local\agy\bin\agy.exe"]) {
                Some(b) => b,
                None => {
                    return json!({
                        "success": false,
                        "error": "Antigravity CLI (agy) no está instalado o no se encuentra en el PATH.",
                        "latencyMs": start.elapsed().as_millis() as u64
                    });
                }
            };

            let mut args = vec!["-p", prompt, "--output-format", "text"];
            if let Some(m) = model {
                args.push("--model");
                args.push(m);
            }
            (bin, args)
        }
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
            let bin = match resolve_bin("codex", &[
                r"C:\Users\PC\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe",
                r"C:\Users\PC\AppData\Local\Programs\OpenAI\codex.exe",
            ]) {
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
pub async fn proxy_operator_http(request: Value) -> Value {
    let req = request.get("request").unwrap_or(&request);

    let url = match req.get("url").and_then(|v| v.as_str()) {
        Some(u) => u,
        None => {
            return json!({
                "success": false,
                "error": "Missing 'url' parameter",
                "latencyMs": 0
            });
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

    let start = Instant::now();

    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return json!({
                "success": false,
                "error": format!("Failed to create HTTP client: {e}"),
                "latencyMs": start.elapsed().as_millis() as u64
            });
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

    let mut builder = client.request(method, url);

    if let Some(headers) = req.get("headers").and_then(|v| v.as_object()) {
        for (k, v) in headers {
            if let Some(val_str) = v.as_str() {
                builder = builder.header(k, val_str);
            }
        }
    }

    if let Some(b64) = req.get("bodyBase64").and_then(|v| v.as_str()) {
        if let Some(bytes) = crate::chat_attachments::decode_base64(b64.trim()) {
            builder = builder.body(bytes);
        } else {
            return json!({
                "success": false,
                "error": "Failed to decode bodyBase64: invalid base64 encoding",
                "latencyMs": 0
            });
        }
    } else if let Some(body) = req.get("body") {
        if let Some(s) = body.as_str() {
            builder = builder.body(s.to_string());
        } else if !body.is_null() {
            builder = builder.body(body.to_string());
        }
    }

    match builder.send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
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
                if lower.contains("secret")
                    || lower.contains("apikey")
                    || lower.contains("api_key")
                    || lower.contains("password")
                    || lower.contains("token")
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

#[tauri::command]
pub fn operator_trace_path() -> Result<String, String> {
    let dir = crate::persist::roaming_app_dir().join("operator-traces");
    if !dir.exists() {
        let _ = std::fs::create_dir_all(&dir);
    }
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
pub fn operator_trace_append(line: String) -> Result<(), String> {
    use std::io::Write;
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

    let final_line = match serde_json::from_str::<Value>(&line) {
        Ok(val) => serde_json::to_string(&redact_secrets_native(val)).unwrap_or(line),
        Err(_) => line,
    };

    writeln!(file, "{}", final_line.trim_end())
        .map_err(|e| format!("Failed to write operator trace: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_query_operator_agent_unsupported_engine() {
        let res = query_operator_agent(json!({
            "engine": "unknown_ai_engine",
            "prompt": "ping"
        }));

        assert_eq!(res["success"], false);
        assert!(res["error"].as_str().unwrap().contains("no soportado"));
    }
}
