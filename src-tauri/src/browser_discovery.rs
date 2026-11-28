use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::str::FromStr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

pub const COMMON_DEV_PORTS: &[u16] = &[
    3000, 3001, 4173, 4200, 4321, 5173, 5174, 5175, 5500, 8000, 8080, 8081, 8888, 1420,
];

const DEFAULT_PROBE_TIMEOUT_MS: u64 = 150;
const MAX_PROBE_WORKERS: usize = 16;
const MAX_HTTP_SNIFF_BYTES: usize = 8192;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredServer {
    pub url: String,
    pub host: String,
    pub port: u16,
    pub source: String,
    pub framework_hint: Option<String>,
    pub title_hint: Option<String>,
    pub reachable: bool,
}

fn strip_ansi_sequences(input: &str) -> String {
    static ANSI_RE: OnceLock<Regex> = OnceLock::new();
    let re = ANSI_RE.get_or_init(|| {
        Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")
            .expect("valid ansi regex")
    });
    re.replace_all(input, "").into_owned()
}

fn is_local_hostname(host: &str) -> bool {
    let lower = host
        .trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if lower == "localhost"
        || lower.ends_with(".localhost")
        || lower == "::1"
        || lower == "0.0.0.0"
    {
        return true;
    }
    if let Ok(ip) = Ipv4Addr::from_str(&lower) {
        return ip.is_loopback();
    }
    false
}

fn parse_local_url_parts(raw_url: &str) -> Option<(String, String, u16)> {
    let trimmed = raw_url
        .trim()
        .trim_end_matches(|c: char| matches!(c, ')' | ']' | ',' | '.' | ';' | '\'' | '"' | '>'));
    let (scheme, rest) = if let Some(r) = trimmed.strip_prefix("https://") {
        ("https", r)
    } else if let Some(r) = trimmed.strip_prefix("http://") {
        ("http", r)
    } else {
        return None;
    };

    let (authority, suffix) = match rest.find(['/', '?', '#']) {
        Some(idx) => (&rest[..idx], &rest[idx..]),
        None => (rest, ""),
    };
    if authority.is_empty() || authority.contains('@') {
        return None;
    }

    let default_port = if scheme == "https" { 443 } else { 80 };
    let (host, port, normalized_authority) = if let Some(after_bracket) = authority.strip_prefix('[')
    {
        let close = after_bracket.find(']')?;
        let host_inner = after_bracket[..close].to_ascii_lowercase();
        let rem = &after_bracket[close + 1..];
        let port = if rem.is_empty() {
            default_port
        } else {
            rem.strip_prefix(':')?.parse::<u16>().ok()?
        };
        (
            host_inner.clone(),
            port,
            if rem.is_empty() {
                format!("[{host_inner}]")
            } else {
                format!("[{host_inner}]:{port}")
            },
        )
    } else {
        let mut parts = authority.split(':');
        let h_raw = parts.next()?.to_ascii_lowercase();
        let port_opt = parts.next();
        if parts.next().is_some() {
            return None;
        }
        let port = match port_opt {
            Some(p) => p.parse::<u16>().ok()?,
            None => default_port,
        };
        let normalized_host = if h_raw == "0.0.0.0" {
            "localhost".to_string()
        } else {
            h_raw
        };
        let auth = if port_opt.is_some() {
            format!("{normalized_host}:{port}")
        } else {
            normalized_host.clone()
        };
        (normalized_host, port, auth)
    };

    if port == 0 || !is_local_hostname(&host) {
        return None;
    }

    let normalized_url = format!("{scheme}://{normalized_authority}{suffix}");
    Some((normalized_url, host, port))
}

/// Extracts deduplicated local loopback URLs (`localhost`, `127.0.0.1`, `[::1]`, `0.0.0.0` normalized)
/// from terminal output or text snippets, stripping ANSI color sequences.
pub fn extract_local_urls_from_text(text: &str) -> Vec<String> {
    static URL_RE: OnceLock<Regex> = OnceLock::new();
    let re = URL_RE.get_or_init(|| {
        Regex::new(r#"https?://(?:\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+)(?::\d{1,5})?(?:[^\s"'<>`]*)"#)
            .expect("valid local url regex")
    });

    let clean = strip_ansi_sequences(text);
    let mut seen = HashSet::new();
    let mut urls = Vec::new();
    for m in re.find_iter(&clean) {
        if let Some((normalized, _, _)) = parse_local_url_parts(m.as_str()) {
            if seen.insert(normalized.clone()) {
                urls.push(normalized);
            }
        }
    }
    urls
}

fn decode_basic_html_entities(text: &str) -> String {
    text.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
}

/// Extracts framework/server hints and HTML `<title>` from an HTTP response prefix (headers + head).
pub fn sniff_framework_and_title(http_head: &str) -> (Option<String>, Option<String>) {
    static TITLE_RE: OnceLock<Regex> = OnceLock::new();
    let title_re = TITLE_RE.get_or_init(|| {
        Regex::new(r"(?is)<title\b[^>]*>(.*?)</title>").expect("valid html title regex")
    });

    let title_hint = title_re.captures(http_head).and_then(|caps| {
        let collapsed = caps
            .get(1)?
            .as_str()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        let decoded = decode_basic_html_entities(collapsed.trim());
        if decoded.is_empty() {
            None
        } else {
            Some(decoded)
        }
    });

    let lower = http_head.to_ascii_lowercase();
    let framework_hint = if lower.contains("x-powered-by: next.js")
        || lower.contains("/_next/static/")
        || lower.contains("__next_data__")
    {
        Some("Next.js".to_string())
    } else if lower.contains("x-powered-by: nuxt")
        || lower.contains("/_nuxt/")
        || lower.contains("__nuxt__")
    {
        Some("Nuxt".to_string())
    } else if lower.contains("/_astro/")
        || lower.contains("astro-island")
        || lower.contains("content=\"astro")
    {
        Some("Astro".to_string())
    } else if lower.contains("__sveltekit") || lower.contains("/@sveltejs/") {
        Some("SvelteKit".to_string())
    } else if lower.contains("ng-version=") || lower.contains("/@angular/") {
        Some("Angular".to_string())
    } else if lower.contains("__remixcontext") {
        Some("Remix".to_string())
    } else if lower.contains("/@vite/client")
        || lower.contains("/@react-refresh")
        || lower.contains("data-vite-dev-id")
    {
        Some("Vite".to_string())
    } else if lower.contains("__tauri__") || lower.contains("tauri://") {
        Some("Tauri".to_string())
    } else if lower.contains("server: uvicorn") || lower.contains("fastapi") {
        Some("FastAPI".to_string())
    } else if lower.contains("server: werkzeug") {
        Some("Flask".to_string())
    } else if lower.contains("x-powered-by: express") {
        Some("Express".to_string())
    } else if lower.contains("/static/js/bundle.js") || lower.contains("data-reactroot") {
        Some("React".to_string())
    } else if lower.contains("__vue__") {
        Some("Vue".to_string())
    } else {
        None
    };

    (framework_hint, title_hint)
}

fn connect_loopback(port: u16, timeout: Duration) -> Option<(TcpStream, &'static str)> {
    let started = Instant::now();
    let v4_addr = SocketAddr::from(([127, 0, 0, 1], port));
    if let Ok(stream) = TcpStream::connect_timeout(&v4_addr, timeout) {
        return Some((stream, "localhost"));
    }

    let elapsed = started.elapsed();
    if elapsed >= timeout / 2 {
        return None;
    }
    let remaining = timeout.saturating_sub(elapsed);
    let v6_addr = SocketAddr::from(([0, 0, 0, 0, 0, 0, 0, 1], port));
    TcpStream::connect_timeout(&v6_addr, remaining)
        .ok()
        .map(|stream| (stream, "::1"))
}

/// Probes a single loopback TCP port with a tight timeout and sniffs HTTP headers/title when available.
pub fn probe_loopback_port(port: u16, timeout_ms: u64) -> Option<DiscoveredServer> {
    if port == 0 {
        return None;
    }
    let timeout = Duration::from_millis(timeout_ms.max(10));
    let started = Instant::now();
    let (mut stream, host) = connect_loopback(port, timeout)?;

    let remaining = timeout
        .saturating_sub(started.elapsed())
        .max(Duration::from_millis(25));
    let _ = stream.set_read_timeout(Some(remaining));
    let _ = stream.set_write_timeout(Some(remaining));

    let request = format!(
        "GET / HTTP/1.1\r\nHost: localhost:{port}\r\nConnection: close\r\nAccept: text/html,*/*;q=0.8\r\nUser-Agent: KiteCode-Discovery/1.0\r\n\r\n"
    );

    let mut head_text = String::new();
    if stream.write_all(request.as_bytes()).is_ok() {
        let mut buf = [0u8; MAX_HTTP_SNIFF_BYTES];
        let mut total = 0usize;
        while total < buf.len() && started.elapsed() < timeout {
            match stream.read(&mut buf[total..]) {
                Ok(0) => break,
                Ok(n) => {
                    total += n;
                    let chunk = String::from_utf8_lossy(&buf[..total]);
                    let lower = chunk.to_ascii_lowercase();
                    if lower.contains("</head>") || lower.contains("</html>") {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        if total > 0 {
            head_text = String::from_utf8_lossy(&buf[..total]).into_owned();
        }
    }

    let (framework_hint, title_hint) = if head_text.starts_with("HTTP/") {
        sniff_framework_and_title(&head_text)
    } else {
        (None, None)
    };

    let url = if host == "::1" {
        format!("http://[::1]:{port}/")
    } else {
        format!("http://localhost:{port}/")
    };

    Some(DiscoveredServer {
        url,
        host: host.to_string(),
        port,
        source: "port_probe".to_string(),
        framework_hint,
        title_hint,
        reachable: true,
    })
}

/// Discovers local dev servers concurrently across `COMMON_DEV_PORTS`, `extra_ports`,
/// local URLs extracted from `terminal_snippets`, and `open_urls`.
pub fn discover_local_servers(
    extra_ports: &[u16],
    terminal_snippets: &[String],
    open_urls: &[String],
) -> Vec<DiscoveredServer> {
    let mut candidate_ports: Vec<u16> = Vec::new();
    let mut port_seen: HashSet<u16> = HashSet::new();
    let mut hinted_by_port: BTreeMap<u16, (String, String, String)> = BTreeMap::new();

    for &port in COMMON_DEV_PORTS {
        if port != 0 && port_seen.insert(port) {
            candidate_ports.push(port);
        }
    }
    for &port in extra_ports {
        if port != 0 && port_seen.insert(port) {
            candidate_ports.push(port);
        }
    }

    for url in open_urls {
        if let Some((normalized, host, port)) = parse_local_url_parts(url) {
            if port_seen.insert(port) {
                candidate_ports.push(port);
            }
            hinted_by_port
                .entry(port)
                .or_insert_with(|| (normalized, host, "open_tab".to_string()));
        }
    }

    for snippet in terminal_snippets {
        for extracted in extract_local_urls_from_text(snippet) {
            if let Some((normalized, host, port)) = parse_local_url_parts(&extracted) {
                if port_seen.insert(port) {
                    candidate_ports.push(port);
                }
                hinted_by_port
                    .entry(port)
                    .or_insert_with(|| (normalized, host, "terminal".to_string()));
            }
        }
    }

    let cursor = AtomicUsize::new(0);
    let results = Mutex::new(BTreeMap::<u16, DiscoveredServer>::new());
    let worker_count = candidate_ports.len().min(MAX_PROBE_WORKERS);

    if worker_count > 0 {
        std::thread::scope(|scope| {
            for _ in 0..worker_count {
                scope.spawn(|| loop {
                    let idx = cursor.fetch_add(1, Ordering::Relaxed);
                    if idx >= candidate_ports.len() {
                        break;
                    }
                    let port = candidate_ports[idx];
                    if let Some(server) = probe_loopback_port(port, DEFAULT_PROBE_TIMEOUT_MS) {
                        let mut guard = results.lock().expect("discovery results lock");
                        guard.insert(port, server);
                    }
                });
            }
        });
    }

    let mut discovered_by_port = results.into_inner().expect("discovery results lock");

    for (port, (hint_url, hint_host, source)) in hinted_by_port {
        if let Some(existing) = discovered_by_port.get_mut(&port) {
            existing.url = hint_url;
            existing.host = hint_host;
            existing.source = source;
        } else {
            discovered_by_port.insert(
                port,
                DiscoveredServer {
                    url: hint_url,
                    host: hint_host,
                    port,
                    source,
                    framework_hint: None,
                    title_hint: None,
                    reachable: false,
                },
            );
        }
    }

    let mut list: Vec<DiscoveredServer> = discovered_by_port.into_values().collect();
    list.sort_by(|a, b| b.reachable.cmp(&a.reachable).then_with(|| a.port.cmp(&b.port)));
    list
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn extracts_local_urls_and_strips_ansi_and_punctuation() {
        let terminal = "\
            \x1b[32m  ➜  Local:\x1b[0m   \x1b[36mhttp://localhost:5173/\x1b[0m\n\
            \x1b[32m  ➜  Network:\x1b[0m http://192.168.1.44:5173/\n\
            INFO:     Uvicorn running on http://0.0.0.0:8000 (Press CTRL+C to quit)\n\
            Repeat: http://localhost:5173/, and IPv6 http://[::1]:1420/app.\n\
            Ignore external: https://example.com:8443/docs\n";

        let urls = extract_local_urls_from_text(terminal);
        assert_eq!(
            urls,
            vec![
                "http://localhost:5173/".to_string(),
                "http://localhost:8000".to_string(),
                "http://[::1]:1420/app".to_string(),
            ]
        );
    }

    #[test]
    fn sniffs_framework_and_html_title() {
        let vite_resp = "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n\
            <!doctype html><html><head><title>Kite &amp; App\n  Dashboard</title>\
            <script type=\"module\" src=\"/@vite/client\"></script></head><body></body></html>";
        let (fw, title) = sniff_framework_and_title(vite_resp);
        assert_eq!(fw.as_deref(), Some("Vite"));
        assert_eq!(title.as_deref(), Some("Kite & App Dashboard"));

        let next_resp = "HTTP/1.1 200 OK\r\nX-Powered-By: Next.js\r\n\r\n<html><head><title>Next App</title></head></html>";
        let (fw2, title2) = sniff_framework_and_title(next_resp);
        assert_eq!(fw2.as_deref(), Some("Next.js"));
        assert_eq!(title2.as_deref(), Some("Next App"));
    }

    #[test]
    fn probes_live_ephemeral_tcp_listener_and_discovers_it() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
        let port = listener.local_addr().expect("local addr").port();

        let handle = std::thread::spawn(move || {
            for _ in 0..2 {
                if let Ok((mut conn, _)) = listener.accept() {
                    let mut req_buf = [0u8; 512];
                    let _ = conn.read(&mut req_buf);
                    let body = "<html><head><title>Ephemeral Vite</title><script src=\"/@vite/client\"></script></head><body>ok</body></html>";
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = conn.write_all(resp.as_bytes());
                }
            }
        });

        let probed = probe_loopback_port(port, 150).expect("ephemeral server should be reachable");
        assert!(probed.reachable);
        assert_eq!(probed.port, port);
        assert_eq!(probed.framework_hint.as_deref(), Some("Vite"));
        assert_eq!(probed.title_hint.as_deref(), Some("Ephemeral Vite"));

        let started = Instant::now();
        let snippets = vec![format!("Local: http://127.0.0.1:{port}/preview")];
        let servers = discover_local_servers(&[port], &snippets, &[]);
        assert!(
            started.elapsed() < Duration::from_millis(500),
            "discovery took too long: {:?}",
            started.elapsed()
        );

        let found = servers
            .iter()
            .find(|s| s.port == port)
            .expect("discovered server should include ephemeral port");
        assert!(found.reachable);
        assert_eq!(found.source, "terminal");
        assert_eq!(found.url, format!("http://127.0.0.1:{port}/preview"));
        assert_eq!(found.framework_hint.as_deref(), Some("Vite"));
        assert_eq!(found.title_hint.as_deref(), Some("Ephemeral Vite"));

        let _ = handle.join();
    }
}
