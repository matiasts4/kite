//! Loopback file server for the local update feed.
//! Binds 127.0.0.1:9101 and serves the repo `feed/` directory.
//! The running app must not spawn a Node process for this.

use std::fs::File;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

const FEED_ADDR: &str = "127.0.0.1:9101";

static STARTED: AtomicBool = AtomicBool::new(false);

pub fn ensure_local_feed() {
    if feed_port_open() {
        return;
    }
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(|| {
        if let Err(err) = serve() {
            crate::logger::log_trace(&format!("local feed: {err}"));
            STARTED.store(false, Ordering::SeqCst);
        }
    });
}

fn feed_port_open() -> bool {
    let Ok(addr) = FEED_ADDR.parse() else {
        return false;
    };
    TcpStream::connect_timeout(&addr, Duration::from_millis(60)).is_ok()
}

fn serve() -> Result<(), String> {
    let listener = TcpListener::bind(FEED_ADDR).map_err(|err| err.to_string())?;
    crate::logger::log_trace(&format!("local feed: listening on {FEED_ADDR}"));
    for stream in listener.incoming() {
        let Ok(mut stream) = stream else {
            continue;
        };
        let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
        let _ = handle_connection(&mut stream);
    }
    Ok(())
}

fn handle_connection(stream: &mut TcpStream) -> Result<(), String> {
    let mut buf = [0u8; 4096];
    let n = stream.read(&mut buf).map_err(|err| err.to_string())?;
    if n == 0 {
        return Ok(());
    }
    let text = String::from_utf8_lossy(&buf[..n]);
    let mut lines = text.lines();
    let request = lines.next().unwrap_or("");
    let mut parts = request.split_whitespace();
    let method = parts.next().unwrap_or("");
    let raw_path = parts.next().unwrap_or("/");
    let path = raw_path.split('?').next().unwrap_or("/");

    if method == "OPTIONS" {
        let _ = write_headers(stream, 204, "text/plain", 0, true);
        return Ok(());
    }
    if method != "GET" && method != "HEAD" {
        let _ = write_headers(stream, 405, "text/plain", 0, false);
        return Ok(());
    }
    if path == "/health" {
        let body = b"ok";
        write_headers(stream, 200, "text/plain", body.len(), false)?;
        if method != "HEAD" {
            let _ = stream.write_all(body);
        }
        return Ok(());
    }

    let Some(root) = resolve_feed_dir() else {
        let _ = write_headers(stream, 404, "text/plain", 0, false);
        return Ok(());
    };
    let Some(file_path) = feed_file_for_url(&root, path) else {
        let _ = write_headers(stream, 404, "text/plain", 0, false);
        return Ok(());
    };
    let mut file = File::open(&file_path).map_err(|err| err.to_string())?;
    let meta = file.metadata().map_err(|err| err.to_string())?;
    let len = meta.len() as usize;
    let content_type = content_type_for(&file_path);
    write_headers(stream, 200, content_type, len, false)?;
    if method != "HEAD" {
        let mut body = Vec::with_capacity(len.min(1024 * 1024));
        file.read_to_end(&mut body).map_err(|err| err.to_string())?;
        let _ = stream.write_all(&body);
    }
    Ok(())
}

fn write_headers(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    len: usize,
    no_body: bool,
) -> Result<(), String> {
    let reason = match status {
        200 => "OK",
        204 => "No Content",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "Error",
    };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, HEAD, OPTIONS\r\nAccess-Control-Allow-Headers: *\r\nContent-Type: {content_type}\r\nContent-Length: {len}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(response.as_bytes())
        .map_err(|err| err.to_string())?;
    let _ = no_body;
    Ok(())
}

fn content_type_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
    {
        "json" => "application/json; charset=utf-8",
        "exe" => "application/octet-stream",
        "sig" => "text/plain",
        _ => "application/octet-stream",
    }
}

pub fn resolve_feed_dir() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("feed"));
        candidates.push(cwd.join("..").join("feed"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("feed"));
            candidates.push(dir.join("..").join("..").join("feed"));
            candidates.push(dir.join("..").join("..").join("..").join("feed"));
        }
    }
    candidates.into_iter().find(|path| path.is_dir())
}

/// Join `url_path` onto `root`. Parent segments and absolute paths are rejected.
pub fn feed_file_for_url(root: &Path, url_path: &str) -> Option<PathBuf> {
    let decoded = percent_decode(url_path);
    let trimmed = decoded.trim_start_matches('/');
    if trimmed.is_empty() || trimmed.contains('\0') {
        return None;
    }
    let mut out = root.to_path_buf();
    for component in Path::new(trimmed).components() {
        match component {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            _ => return None,
        }
    }
    if out.is_file() {
        Some(out)
    } else {
        None
    }
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(value) = u8::from_str_radix(
                std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""),
                16,
            ) {
                out.push(value);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn feed_path_rejects_parent_segments() {
        let root = std::env::temp_dir().join(format!("kite-feed-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("studio")).unwrap();
        fs::write(root.join("studio").join("latest.json"), b"{}").unwrap();
        fs::write(root.join("secret.txt"), b"nope").unwrap();

        assert!(feed_file_for_url(&root, "/studio/../../secret.txt").is_none());
        assert!(feed_file_for_url(&root, "/../secret.txt").is_none());
        assert!(feed_file_for_url(&root, "/studio/latest.json")
            .unwrap()
            .ends_with("latest.json"));

        let _ = fs::remove_dir_all(&root);
    }
}
