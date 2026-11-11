use serde_json::{json, Value};
use std::time::Duration;

const DEFAULT_BASE: &str = "http://127.0.0.1:8787";

fn is_loopback_http(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("http://") else {
        return false;
    };
    let host = rest.split('/').next().unwrap_or("");
    let host = host.rsplit('@').next().unwrap_or(host);
    let host_only = if let Some(stripped) = host.strip_prefix('[') {
        stripped.split(']').next().unwrap_or("")
    } else {
        host.split(':').next().unwrap_or("")
    };
    matches!(host_only, "127.0.0.1" | "localhost" | "::1")
}

fn headroom_base_url() -> String {
    match std::env::var("HEADROOM_PROXY_URL") {
        Ok(raw) => {
            let trimmed = raw.trim().trim_end_matches('/').to_string();
            if is_loopback_http(&trimmed) {
                trimmed
            } else {
                DEFAULT_BASE.to_string()
            }
        }
        Err(_) => DEFAULT_BASE.to_string(),
    }
}

#[tauri::command]
pub fn fetch_headroom_monitor() -> Value {
    let base = headroom_base_url();
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(4))
        .redirect(reqwest::redirect::Policy::none())
        .build()
    {
        Ok(client) => client,
        Err(_) => {
            return json!({ "ok": false, "error": "http client" });
        }
    };

    let stats = match client.get(format!("{base}/stats")).send() {
        Ok(response) if response.status().is_success() => match response.json::<Value>() {
            Ok(value) => value,
            Err(_) => return json!({ "ok": false, "error": "invalid stats" }),
        },
        _ => return json!({ "ok": false, "error": "connection refused" }),
    };

    let health = client
        .get(format!("{base}/health"))
        .send()
        .ok()
        .filter(|response| response.status().is_success())
        .and_then(|response| response.json::<Value>().ok());

    json!({
        "ok": true,
        "health": health,
        "stats": stats,
    })
}

#[cfg(test)]
mod tests {
    use super::is_loopback_http;

    #[test]
    fn accepts_only_loopback_http_proxy_urls() {
        assert!(is_loopback_http("http://127.0.0.1:8787"));
        assert!(is_loopback_http("http://localhost:8787"));
        assert!(is_loopback_http("http://[::1]:8787"));
        assert!(!is_loopback_http("https://127.0.0.1:8787"));
        assert!(!is_loopback_http("http://evil.example/stats"));
        assert!(!is_loopback_http("http://127.0.0.1.evil.example:8787"));
    }
}
