//! Async client for the 9-byte `kite-core` frame protocol.
//!
//! The UI process never owns a PTY. Session lifetime stays inside `kite-core`.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};

pub const FRAME_HEADER_LEN: usize = 9;
pub const MAX_PAYLOAD_LEN: usize = 16 * 1024 * 1024;
pub const PROTOCOL: &str = "kite-core/v1";
pub const CONNECT_BUDGET: Duration = Duration::from_millis(2000);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum FrameKind {
    Rpc = 0x00,
    Data = 0x01,
    SnapshotBin = 0x02,
    Credit = 0x03,
    Resize = 0x04,
    Focus = 0x05,
    Close = 0x06,
    Facts = 0x07,
}

impl FrameKind {
    pub fn from_u8(value: u8) -> Result<Self, FrameError> {
        match value {
            0x00 => Ok(Self::Rpc),
            0x01 => Ok(Self::Data),
            0x02 => Ok(Self::SnapshotBin),
            0x03 => Ok(Self::Credit),
            0x04 => Ok(Self::Resize),
            0x05 => Ok(Self::Focus),
            0x06 => Ok(Self::Close),
            0x07 => Ok(Self::Facts),
            other => Err(FrameError::UnknownKind(other)),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub channel_id: u32,
    pub kind: FrameKind,
    pub payload: Vec<u8>,
}

impl Frame {
    pub fn new(channel_id: u32, kind: FrameKind, payload: Vec<u8>) -> Self {
        Self {
            channel_id,
            kind,
            payload,
        }
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(FRAME_HEADER_LEN + self.payload.len());
        out.extend_from_slice(&self.channel_id.to_le_bytes());
        out.push(self.kind as u8);
        out.extend_from_slice(&(self.payload.len() as u32).to_le_bytes());
        out.extend_from_slice(&self.payload);
        out
    }

    pub fn decode_header(bytes: &[u8; FRAME_HEADER_LEN]) -> Result<(u32, FrameKind, u32), FrameError> {
        let channel_id = u32::from_le_bytes(bytes[0..4].try_into().unwrap());
        let kind = FrameKind::from_u8(bytes[4])?;
        let payload_len = u32::from_le_bytes(bytes[5..9].try_into().unwrap());
        if payload_len as usize > MAX_PAYLOAD_LEN {
            return Err(FrameError::PayloadTooLarge(payload_len as usize));
        }
        Ok((channel_id, kind, payload_len))
    }

    pub fn credit(channel_id: u32, amount: u32) -> Self {
        Self::new(channel_id, FrameKind::Credit, amount.to_le_bytes().to_vec())
    }

    pub fn data(channel_id: u32, bytes: Vec<u8>) -> Self {
        Self::new(channel_id, FrameKind::Data, bytes)
    }

    pub fn resize(channel_id: u32, cols: u16, rows: u16, pixel_width: u16, pixel_height: u16) -> Self {
        let mut payload = Vec::with_capacity(8);
        payload.extend_from_slice(&cols.to_le_bytes());
        payload.extend_from_slice(&rows.to_le_bytes());
        payload.extend_from_slice(&pixel_width.to_le_bytes());
        payload.extend_from_slice(&pixel_height.to_le_bytes());
        Self::new(channel_id, FrameKind::Resize, payload)
    }

    pub fn focus(channel_id: u32, focused: bool, live_visible: bool) -> Self {
        Self::new(
            channel_id,
            FrameKind::Focus,
            vec![u8::from(focused), u8::from(live_visible)],
        )
    }

    pub fn rpc(value: &Value) -> Self {
        let bytes = serde_json::to_vec(value).unwrap_or_default();
        Self::new(0, FrameKind::Rpc, bytes)
    }
}

#[derive(Debug)]
pub struct FrameDecoder {
    buffer: VecDeque<u8>,
}

impl Default for FrameDecoder {
    fn default() -> Self {
        Self::new()
    }
}

impl FrameDecoder {
    pub fn new() -> Self {
        Self {
            buffer: VecDeque::new(),
        }
    }

    pub fn feed(&mut self, chunk: &[u8]) {
        self.buffer.extend(chunk);
    }

    pub fn next_frame(&mut self) -> Result<Option<Frame>, FrameError> {
        if self.buffer.len() < FRAME_HEADER_LEN {
            return Ok(None);
        }
        let mut header = [0u8; FRAME_HEADER_LEN];
        for (index, byte) in header.iter_mut().enumerate() {
            *byte = self.buffer[index];
        }
        let (channel_id, kind, payload_len) = Frame::decode_header(&header)?;
        let total = FRAME_HEADER_LEN + payload_len as usize;
        if self.buffer.len() < total {
            return Ok(None);
        }
        for _ in 0..FRAME_HEADER_LEN {
            self.buffer.pop_front();
        }
        let mut payload = Vec::with_capacity(payload_len as usize);
        for _ in 0..payload_len {
            if let Some(byte) = self.buffer.pop_front() {
                payload.push(byte);
            }
        }
        if kind == FrameKind::Rpc && channel_id != 0 {
            return Err(FrameError::RpcOnNonZeroChannel(channel_id));
        }
        Ok(Some(Frame {
            channel_id,
            kind,
            payload,
        }))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FrameError {
    UnknownKind(u8),
    PayloadTooLarge(usize),
    PayloadTooShort(&'static str, usize, usize),
    RpcOnNonZeroChannel(u32),
    Io(String),
    Protocol(String),
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnknownKind(kind) => write!(f, "unknown frame kind 0x{kind:02x}"),
            Self::PayloadTooLarge(len) => write!(f, "payload {len} exceeds {MAX_PAYLOAD_LEN}"),
            Self::PayloadTooShort(kind, have, need) => {
                write!(f, "{kind} payload has {have} bytes, need {need}")
            }
            Self::RpcOnNonZeroChannel(channel) => write!(f, "rpc on channel {channel}"),
            Self::Io(message) | Self::Protocol(message) => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for FrameError {}

pub fn decode_credit(payload: &[u8]) -> Result<u32, FrameError> {
    if payload.len() < 4 {
        return Err(FrameError::PayloadTooShort("CREDIT", payload.len(), 4));
    }
    Ok(u32::from_le_bytes(payload[0..4].try_into().unwrap()))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandshakeRequest {
    pub protocol: String,
    pub framed: bool,
    pub client: String,
    pub pid: u32,
    pub auth_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandshakeResponse {
    pub protocol: String,
    pub framed: bool,
    pub core_version: String,
    pub core_pid: u32,
    pub active_sessions: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LiveSession {
    pub session_id: String,
    #[serde(default)]
    pub channel_id: Option<u32>,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub pane_id: Option<String>,
    #[serde(default)]
    pub engine: String,
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub root_pid: u32,
    #[serde(default)]
    pub cols: u16,
    #[serde(default)]
    pub rows: u16,
    #[serde(default)]
    pub exited: bool,
    #[serde(default)]
    pub exit_code: Option<i64>,
    #[serde(default)]
    pub spawned_at_unix_ms: i64,
}

pub fn pipe_name() -> String {
    if let Ok(custom) = std::env::var("KITE_CORE_PIPE") {
        let trimmed = custom.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    let stem = if cfg!(debug_assertions) {
        "kite-core-v1-dev"
    } else {
        "kite-core-v1"
    };
    #[cfg(windows)]
    {
        let user = std::env::var("USERNAME").unwrap_or_else(|_| "user".to_string());
        return format!(r"\\.\pipe\{stem}-{user}");
    }
    #[cfg(not(windows))]
    {
        if let Ok(xdg) = std::env::var("XDG_RUNTIME_DIR") {
            format!("{xdg}/{stem}.sock")
        } else {
            format!("/tmp/{stem}.sock")
        }
    }
}

fn appdata_dir() -> PathBuf {
    if let Ok(appdata) = std::env::var("APPDATA") {
        return PathBuf::from(appdata);
    }
    PathBuf::from(r"C:\Users\PC\AppData\Roaming")
}

/// Reads candidate daemon tokens in priority order (`Kite Code` and `Kite Code Dev`).
pub fn read_auth_tokens() -> Vec<String> {
    let mut tokens = Vec::new();
    if let Ok(token) = std::env::var("KITE_CORE_TOKEN") {
        let trimmed = token.trim();
        if !trimmed.is_empty() {
            tokens.push(trimmed.to_string());
        }
    }
    let root = appdata_dir();
    let mut folders = if cfg!(debug_assertions) {
        vec!["Kite Code Dev".to_string(), "Kite Code".to_string()]
    } else {
        vec!["Kite Code".to_string(), "Kite Code Dev".to_string()]
    };
    if let Ok(extra) = std::env::var("KITE_CORE_TOKEN_DIR") {
        let trimmed = extra.trim().to_string();
        if !trimmed.is_empty() {
            folders.insert(0, trimmed);
        }
    }
    for folder in &folders {
        let path = root.join(folder).join("core-session.token");
        if let Ok(content) = std::fs::read_to_string(path) {
            let trimmed = content.trim().to_string();
            if !trimmed.is_empty() && !tokens.contains(&trimmed) {
                tokens.push(trimmed);
            }
        }
    }
    if tokens.is_empty() {
        tokens.push(String::new());
    }
    tokens
}

/// Reads the preferred daemon token.
pub fn read_auth_token() -> String {
    read_auth_tokens().into_iter().next().unwrap_or_default()
}

pub fn spawn_daemon() -> bool {
    let Some(exe) = daemon_executable() else {
        return false;
    };
    let mut command = std::process::Command::new(exe);
    command.arg("--daemon");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        command.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);
    }
    command.spawn().is_ok()
}

fn daemon_executable() -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("KITE_CODE_EXE") {
        let path = PathBuf::from(explicit.trim());
        if path.is_file() {
            return Some(path);
        }
    }
    let mut candidates = Vec::new();
    if let Ok(current) = std::env::current_exe() {
        if let Some(dir) = current.parent() {
            candidates.push(dir.join("kite-code.exe"));
            candidates.push(dir.join("kite-code"));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        if cfg!(debug_assertions) {
            candidates.push(cwd.join("src-tauri/target/debug/kite-code.exe"));
            candidates.push(cwd.join("src-tauri/target/release/kite-code.exe"));
        } else {
            candidates.push(cwd.join("src-tauri/target/release/kite-code.exe"));
            candidates.push(cwd.join("src-tauri/target/debug/kite-code.exe"));
        }
    }
    candidates.into_iter().find(|path| path.is_file())
}

pub struct CoreClient<R, W> {
    reader: BufReader<R>,
    writer: W,
    decoder: FrameDecoder,
    pending: VecDeque<Frame>,
    next_id: u64,
    pub handshake: HandshakeResponse,
}

impl<R, W> CoreClient<R, W>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    pub async fn handshake_on(stream_read: R, mut stream_write: W, token: &str) -> Result<Self, FrameError> {
        let request = HandshakeRequest {
            protocol: PROTOCOL.to_string(),
            framed: true,
            client: "kite-gpui".to_string(),
            pid: std::process::id(),
            auth_token: token.to_string(),
        };
        let line = serde_json::to_string(&request).map_err(|err| FrameError::Protocol(err.to_string()))?;
        stream_write
            .write_all(format!("{line}\n").as_bytes())
            .await
            .map_err(|err| FrameError::Io(err.to_string()))?;
        stream_write
            .flush()
            .await
            .map_err(|err| FrameError::Io(err.to_string()))?;

        let mut reader = BufReader::new(stream_read);
        let mut response_line = String::new();
        let read = reader
            .read_line(&mut response_line)
            .await
            .map_err(|err| FrameError::Io(err.to_string()))?;
        if read == 0 {
            return Err(FrameError::Protocol("daemon closed during handshake".into()));
        }
        let handshake: HandshakeResponse = serde_json::from_str(response_line.trim())
            .map_err(|err| FrameError::Protocol(err.to_string()))?;
        if handshake.protocol != PROTOCOL || !handshake.framed {
            return Err(FrameError::Protocol(format!(
                "unexpected handshake protocol {}",
                handshake.protocol
            )));
        }
        Ok(Self {
            reader,
            writer: stream_write,
            decoder: FrameDecoder::new(),
            pending: VecDeque::new(),
            next_id: 1,
            handshake,
        })
    }

    pub async fn from_split<S>(stream: S, token: &str) -> Result<CoreClient<tokio::io::ReadHalf<S>, tokio::io::WriteHalf<S>>, FrameError>
    where
        S: AsyncRead + AsyncWrite + Unpin,
    {
        let (read, write) = tokio::io::split(stream);
        CoreClient::handshake_on(read, write, token).await
    }

    pub async fn write_frame(&mut self, frame: &Frame) -> Result<(), FrameError> {
        self.writer
            .write_all(&frame.encode())
            .await
            .map_err(|err| FrameError::Io(err.to_string()))?;
        self.writer
            .flush()
            .await
            .map_err(|err| FrameError::Io(err.to_string()))
    }

    async fn read_wire_frame(&mut self) -> Result<Frame, FrameError> {
        loop {
            if let Some(frame) = self.decoder.next_frame()? {
                return Ok(frame);
            }
            let mut chunk = [0u8; 8192];
            let read = self
                .reader
                .read(&mut chunk)
                .await
                .map_err(|err| FrameError::Io(err.to_string()))?;
            if read == 0 {
                return Err(FrameError::Protocol("connection closed".into()));
            }
            self.decoder.feed(&chunk[..read]);
        }
    }

    pub async fn read_frame(&mut self) -> Result<Frame, FrameError> {
        if let Some(frame) = self.pending.pop_front() {
            return Ok(frame);
        }
        self.read_wire_frame().await
    }

    pub async fn call(&mut self, method: &str, params: Value) -> Result<Value, FrameError> {
        let id = self.next_id;
        self.next_id += 1;
        let request = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        self.write_frame(&Frame::rpc(&request)).await?;
        loop {
            let frame = self.read_wire_frame().await?;
            if frame.kind == FrameKind::Rpc && frame.channel_id == 0 {
                let payload: Value = serde_json::from_slice(&frame.payload)
                    .map_err(|err| FrameError::Protocol(err.to_string()))?;
                let matches = payload.get("id").and_then(|value| value.as_u64()) == Some(id);
                if !matches {
                    self.pending.push_back(frame);
                    continue;
                }
                if let Some(error) = payload.get("error") {
                    return Err(FrameError::Protocol(error.to_string()));
                }
                return Ok(payload.get("result").cloned().unwrap_or(Value::Null));
            }
            self.pending.push_back(frame);
        }
    }

    pub async fn list_sessions(&mut self) -> Result<Vec<LiveSession>, FrameError> {
        let result = self.call("session.list", json!({})).await?;
        let sessions = result
            .get("sessions")
            .cloned()
            .unwrap_or_else(|| json!([]));
        serde_json::from_value(sessions).map_err(|err| FrameError::Protocol(err.to_string()))
    }

    pub async fn create_session(&mut self, params: Value) -> Result<Value, FrameError> {
        self.call("session.create", params).await
    }

    pub async fn attach(
        &mut self,
        session_id: &str,
        cols: u16,
        rows: u16,
        live: bool,
    ) -> Result<AttachResult, FrameError> {
        let result = self
            .call(
                "session.attach",
                json!({
                    "sessionId": session_id,
                    "mode": "snapshot_bin",
                    "cols": cols,
                    "rows": rows,
                    "live": live,
                }),
            )
            .await?;
        let channel_id = result
            .get("channelId")
            .and_then(|value| value.as_u64())
            .ok_or_else(|| FrameError::Protocol("attach response missing channelId".into()))?
            as u32;
        Ok(AttachResult {
            session_id: session_id.to_string(),
            channel_id,
            raw: result,
        })
    }

    pub async fn detach(&mut self, session_id: &str, channel_id: Option<u32>) -> Result<Value, FrameError> {
        let mut params = json!({ "sessionId": session_id });
        if let Some(channel_id) = channel_id {
            params["channelId"] = json!(channel_id);
        }
        self.call("session.detach", params).await
    }

    pub async fn dispatch(&mut self, params: Value) -> Result<Value, FrameError> {
        self.call("agent.dispatch", params).await
    }
}

#[derive(Debug, Clone)]
pub struct AttachResult {
    pub session_id: String,
    pub channel_id: u32,
    pub raw: Value,
}

/// Connects to the named pipe, spawning `kite-code --daemon` when it is down.
pub async fn connect() -> Result<CoreClient<tokio::io::ReadHalf<PipeStream>, tokio::io::WriteHalf<PipeStream>>, FrameError> {
    let tokens = read_auth_tokens();
    if let Some(client) = try_handshake_tokens(&tokens).await {
        return Ok(client);
    }
    let _ = spawn_daemon();
    let started = std::time::Instant::now();
    loop {
        let tokens = read_auth_tokens();
        if let Some(client) = try_handshake_tokens(&tokens).await {
            return Ok(client);
        }
        if started.elapsed() >= CONNECT_BUDGET {
            return Err(FrameError::Protocol(
                "kite-core pipe did not answer within connect budget".into(),
            ));
        }
        tokio::time::sleep(Duration::from_millis(15)).await;
    }
}

async fn try_handshake_tokens(
    tokens: &[String],
) -> Option<CoreClient<tokio::io::ReadHalf<PipeStream>, tokio::io::WriteHalf<PipeStream>>> {
    for token in tokens {
        let Ok(stream) = open_pipe().await else {
            return None;
        };
        let (read, write) = tokio::io::split(stream);
        if let Ok(client) = CoreClient::handshake_on(read, write, token).await {
            return Some(client);
        }
    }
    None
}

#[cfg(windows)]
pub type PipeStream = tokio::net::windows::named_pipe::NamedPipeClient;

#[cfg(not(windows))]
pub type PipeStream = tokio::net::UnixStream;

async fn open_pipe() -> std::io::Result<PipeStream> {
    #[cfg(windows)]
    {
        tokio::net::windows::named_pipe::ClientOptions::new().open(pipe_name())
    }
    #[cfg(not(windows))]
    {
        tokio::net::UnixStream::connect(pipe_name()).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{duplex, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};

    #[test]
    fn frame_header_is_nine_little_endian_bytes() {
        let frame = Frame::new(42, FrameKind::SnapshotBin, vec![1, 2, 3, 4, 5]);
        let encoded = frame.encode();
        assert_eq!(encoded.len(), 14);
        assert_eq!(&encoded[0..4], &[42, 0, 0, 0]);
        assert_eq!(encoded[4], 0x02);
        assert_eq!(&encoded[5..9], &[5, 0, 0, 0]);
        assert_eq!(&encoded[9..], &[1, 2, 3, 4, 5]);
    }

    #[test]
    fn decoder_accepts_split_chunks() {
        let mut decoder = FrameDecoder::new();
        let first = Frame::new(1, FrameKind::Data, b"hello".to_vec());
        let second = Frame::credit(2, 4);
        let mut stream = Vec::new();
        stream.extend(first.encode());
        stream.extend(second.encode());
        decoder.feed(&stream[..5]);
        assert!(decoder.next_frame().unwrap().is_none());
        decoder.feed(&stream[5..16]);
        assert_eq!(decoder.next_frame().unwrap(), Some(first));
        assert!(decoder.next_frame().unwrap().is_none());
        decoder.feed(&stream[16..]);
        assert_eq!(decoder.next_frame().unwrap().unwrap().kind, FrameKind::Credit);
        assert_eq!(decode_credit(&second.payload).unwrap(), 4);
    }

    #[test]
    fn oversized_payload_is_rejected() {
        let mut header = [0u8; 9];
        header[4] = 0x01;
        header[5..9].copy_from_slice(&((17 * 1024 * 1024) as u32).to_le_bytes());
        let err = Frame::decode_header(&header).unwrap_err();
        assert!(matches!(err, FrameError::PayloadTooLarge(_)));
    }

    #[test]
    fn rpc_on_a_session_channel_is_rejected() {
        let mut decoder = FrameDecoder::new();
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&7u32.to_le_bytes());
        bytes.push(0x00);
        bytes.extend_from_slice(&2u32.to_le_bytes());
        bytes.extend_from_slice(b"{}");
        decoder.feed(&bytes);
        assert!(matches!(
            decoder.next_frame(),
            Err(FrameError::RpcOnNonZeroChannel(7))
        ));
    }

    #[test]
    fn focus_resize_and_credit_payloads_match_the_daemon() {
        let focus = Frame::focus(3, true, false);
        assert_eq!(focus.payload, vec![1, 0]);
        let resize = Frame::resize(3, 120, 36, 960, 576);
        assert_eq!(resize.payload.len(), 8);
        assert_eq!(u16::from_le_bytes(resize.payload[0..2].try_into().unwrap()), 120);
        assert_eq!(u16::from_le_bytes(resize.payload[2..4].try_into().unwrap()), 36);
    }

    async fn serve_one_client(mut read: tokio::io::ReadHalf<tokio::io::DuplexStream>, mut write: tokio::io::WriteHalf<tokio::io::DuplexStream>) {
        let mut buffered = BufReader::new(&mut read);
        let mut line = String::new();
        buffered.read_line(&mut line).await.unwrap();
        let request: HandshakeRequest = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(request.client, "kite-gpui");
        assert_eq!(request.protocol, PROTOCOL);
        assert!(request.framed);
        let response = json!({
            "protocol": PROTOCOL,
            "framed": true,
            "coreVersion": "test",
            "corePid": 7,
            "activeSessions": 1
        });
        write
            .write_all(format!("{response}\n").as_bytes())
            .await
            .unwrap();
        write.flush().await.unwrap();

        let mut decoder = FrameDecoder::new();
        let mut chunk = [0u8; 1024];
        loop {
            let n = buffered.read(&mut chunk).await.unwrap();
            if n == 0 {
                return;
            }
            decoder.feed(&chunk[..n]);
            while let Some(frame) = decoder.next_frame().unwrap() {
                let payload: Value = serde_json::from_slice(&frame.payload).unwrap();
                let id = payload["id"].clone();
                let method = payload["method"].as_str().unwrap();
                let result = match method {
                    "session.list" => json!({
                        "sessions": [{
                            "sessionId": "s1",
                            "cwd": "E:/kite",
                            "cols": 80,
                            "rows": 24,
                            "engine": "powershell",
                            "rootPid": 11
                        }]
                    }),
                    "session.attach" => json!({
                        "sessionId": payload["params"]["sessionId"],
                        "channelId": 4,
                        "rootPid": 11
                    }),
                    "session.detach" => json!({ "detached": true }),
                    "agent.dispatch" => json!({ "ok": true, "action": payload["params"]["action"] }),
                    other => json!({ "error": other }),
                };
                let reply = json!({"jsonrpc":"2.0","id":id,"result":result});
                write.write_all(&Frame::rpc(&reply).encode()).await.unwrap();
                if method == "session.attach" {
                    write
                        .write_all(&Frame::new(4, FrameKind::SnapshotBin, vec![9, 9, 9]).encode())
                        .await
                        .unwrap();
                }
                write.flush().await.unwrap();
            }
        }
    }

    #[tokio::test]
    async fn duplex_handshake_lists_attaches_and_dispatches() {
        let (client_side, server_side) = duplex(64 * 1024);
        let (server_read, server_write) = tokio::io::split(server_side);
        tokio::spawn(serve_one_client(server_read, server_write));

        let (read, write) = tokio::io::split(client_side);
        let mut client = CoreClient::handshake_on(read, write, "token").await.unwrap();
        assert_eq!(client.handshake.active_sessions, 1);
        let sessions = client.list_sessions().await.unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session_id, "s1");
        let attached = client.attach("s1", 120, 36, true).await.unwrap();
        assert_eq!(attached.channel_id, 4);
        let snapshot = client.read_frame().await.unwrap();
        assert_eq!(snapshot.kind, FrameKind::SnapshotBin);
        assert_eq!(snapshot.channel_id, 4);
        assert_eq!(snapshot.payload, vec![9, 9, 9]);
        let detached = client.detach("s1", Some(4)).await.unwrap();
        assert_eq!(detached["detached"], true);
        let dispatched = client
            .dispatch(json!({"action":"send","address":"s1","body":"hi"}))
            .await
            .unwrap();
        assert_eq!(dispatched["ok"], true);
    }

    #[test]
    fn pipe_name_uses_the_phase1_path() {
        std::env::set_var("KITE_CORE_PIPE", r"\\.\pipe\kite-core-test");
        assert_eq!(pipe_name(), r"\\.\pipe\kite-core-test");
        std::env::remove_var("KITE_CORE_PIPE");
    }
}
