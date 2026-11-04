use std::collections::VecDeque;

pub const FRAME_HEADER_LEN: usize = 9;
pub const MAX_PAYLOAD_LEN: usize = 16 * 1024 * 1024; // 16 MiB

pub const INITIAL_SNAPSHOT_CREDIT: u32 = 2;
pub const INITIAL_BYTE_CREDIT: u32 = 256 * 1024; // 256 KiB

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
    pub fn from_u8(val: u8) -> Result<Self, FrameCodecError> {
        match val {
            0x00 => Ok(Self::Rpc),
            0x01 => Ok(Self::Data),
            0x02 => Ok(Self::SnapshotBin),
            0x03 => Ok(Self::Credit),
            0x04 => Ok(Self::Resize),
            0x05 => Ok(Self::Focus),
            0x06 => Ok(Self::Close),
            0x07 => Ok(Self::Facts),
            other => Err(FrameCodecError::UnknownKind(other)),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub channel_id: u32,
    pub kind: FrameKind,
    pub payload: Vec<u8>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum FrameCodecError {
    UnknownKind(u8),
    PayloadTooLarge(usize),
    PayloadTooShort(&'static str, usize, usize),
    InvalidJson(String),
    RpcOnNonZeroChannel(u32),
}

impl std::fmt::Display for FrameCodecError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnknownKind(k) => write!(f, "Unknown frame kind: 0x{:02x}", k),
            Self::PayloadTooLarge(len) => {
                write!(f, "Payload length {} exceeds maximum of {} bytes", len, MAX_PAYLOAD_LEN)
            }
            Self::PayloadTooShort(kind, actual, expected) => {
                write!(f, "Payload too short for {}: have {} bytes, expected {}", kind, actual, expected)
            }
            Self::InvalidJson(err) => write!(f, "Invalid JSON UTF-8 payload: {}", err),
            Self::RpcOnNonZeroChannel(ch) => write!(f, "RPC frame received on non-zero channel: {}", ch),
        }
    }
}

impl std::error::Error for FrameCodecError {}

impl Frame {
    pub fn new(channel_id: u32, kind: FrameKind, payload: Vec<u8>) -> Self {
        Self {
            channel_id,
            kind,
            payload,
        }
    }

    /// Serializes the frame with its exact 9-byte little-endian header:
    /// `[u32 channel_id][u8 kind][u32 payload_len]` + payload bytes.
    pub fn encode(&self) -> Vec<u8> {
        let total_len = FRAME_HEADER_LEN + self.payload.len();
        let mut out = Vec::with_capacity(total_len);
        self.encode_to(&mut out);
        out
    }

    pub fn encode_to(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.channel_id.to_le_bytes()); // 0..4
        out.push(self.kind as u8); // 4
        let len = self.payload.len() as u32;
        out.extend_from_slice(&len.to_le_bytes()); // 5..9
        out.extend_from_slice(&self.payload);
    }

    pub fn decode_header(bytes: &[u8; FRAME_HEADER_LEN]) -> Result<(u32, FrameKind, u32), FrameCodecError> {
        let channel_id = u32::from_le_bytes(bytes[0..4].try_into().unwrap());
        let kind = FrameKind::from_u8(bytes[4])?;
        let payload_len = u32::from_le_bytes(bytes[5..9].try_into().unwrap());
        if (payload_len as usize) > MAX_PAYLOAD_LEN {
            return Err(FrameCodecError::PayloadTooLarge(payload_len as usize));
        }
        Ok((channel_id, kind, payload_len))
    }
}

/// Incremental streaming decoder for 9-byte framed binary multiplexed communication.
#[derive(Debug, Default)]
pub struct FrameStreamDecoder {
    buffer: VecDeque<u8>,
}

impl FrameStreamDecoder {
    pub fn new() -> Self {
        Self {
            buffer: VecDeque::new(),
        }
    }

    pub fn feed(&mut self, chunk: &[u8]) {
        self.buffer.extend(chunk);
    }

    pub fn next_frame(&mut self) -> Result<Option<Frame>, FrameCodecError> {
        if self.buffer.len() < FRAME_HEADER_LEN {
            return Ok(None);
        }

        let mut header = [0u8; FRAME_HEADER_LEN];
        for (i, b) in header.iter_mut().enumerate() {
            *b = self.buffer[i];
        }

        let (channel_id, kind, payload_len) = Frame::decode_header(&header)?;
        let total_required = FRAME_HEADER_LEN + (payload_len as usize);

        if self.buffer.len() < total_required {
            return Ok(None);
        }

        // Drain the header
        self.buffer.drain(0..FRAME_HEADER_LEN);

        // Drain payload
        let mut payload = Vec::with_capacity(payload_len as usize);
        for _ in 0..payload_len {
            if let Some(b) = self.buffer.pop_front() {
                payload.push(b);
            }
        }

        if kind == FrameKind::Rpc && channel_id != 0 {
            return Err(FrameCodecError::RpcOnNonZeroChannel(channel_id));
        }

        Ok(Some(Frame {
            channel_id,
            kind,
            payload,
        }))
    }
}

// -----------------------------------------------------------------------------
// Payload Codecs
// -----------------------------------------------------------------------------

/// Encodes a 4-byte `CREDIT` grant frame (`kind = 0x03`).
pub fn encode_credit_frame(channel_id: u32, amount: u32) -> Frame {
    Frame::new(channel_id, FrameKind::Credit, amount.to_le_bytes().to_vec())
}

/// Decodes a 4-byte `CREDIT` payload into a `u32` grant amount.
pub fn decode_credit_payload(payload: &[u8]) -> Result<u32, FrameCodecError> {
    if payload.len() < 4 {
        return Err(FrameCodecError::PayloadTooShort("CREDIT", payload.len(), 4));
    }
    Ok(u32::from_le_bytes(payload[0..4].try_into().unwrap()))
}

/// Encodes an 8-byte `RESIZE` frame (`kind = 0x04`).
pub fn encode_resize_frame(
    channel_id: u32,
    cols: u16,
    rows: u16,
    pixel_width: u16,
    pixel_height: u16,
) -> Frame {
    let mut payload = Vec::with_capacity(8);
    payload.extend_from_slice(&cols.to_le_bytes());
    payload.extend_from_slice(&rows.to_le_bytes());
    payload.extend_from_slice(&pixel_width.to_le_bytes());
    payload.extend_from_slice(&pixel_height.to_le_bytes());
    Frame::new(channel_id, FrameKind::Resize, payload)
}

/// Decodes an 8-byte `RESIZE` payload `[u16 cols][u16 rows][u16 pixel_width][u16 pixel_height]`.
pub fn decode_resize_payload(payload: &[u8]) -> Result<(u16, u16, u16, u16), FrameCodecError> {
    if payload.len() < 8 {
        return Err(FrameCodecError::PayloadTooShort("RESIZE", payload.len(), 8));
    }
    let cols = u16::from_le_bytes(payload[0..2].try_into().unwrap());
    let rows = u16::from_le_bytes(payload[2..4].try_into().unwrap());
    let pixel_width = u16::from_le_bytes(payload[4..6].try_into().unwrap());
    let pixel_height = u16::from_le_bytes(payload[6..8].try_into().unwrap());
    Ok((cols, rows, pixel_width, pixel_height))
}

/// Encodes a 2-byte `FOCUS` frame (`kind = 0x05`).
pub fn encode_focus_frame(channel_id: u32, focused: bool, live_visible: bool) -> Frame {
    Frame::new(
        channel_id,
        FrameKind::Focus,
        vec![if focused { 1 } else { 0 }, if live_visible { 1 } else { 0 }],
    )
}

/// Decodes a 2-byte `FOCUS` payload `[u8 focused][u8 live_visible]`.
pub fn decode_focus_payload(payload: &[u8]) -> Result<(bool, bool), FrameCodecError> {
    if payload.len() < 2 {
        return Err(FrameCodecError::PayloadTooShort("FOCUS", payload.len(), 2));
    }
    Ok((payload[0] != 0, payload[1] != 0))
}

/// Encodes a 5-byte `CLOSE` frame (`kind = 0x06`).
pub fn encode_close_frame(channel_id: u32, exited: bool, exit_code: i32) -> Frame {
    let mut payload = Vec::with_capacity(5);
    payload.push(if exited { 1 } else { 0 });
    payload.extend_from_slice(&exit_code.to_le_bytes());
    Frame::new(channel_id, FrameKind::Close, payload)
}

/// Decodes a 5-byte `CLOSE` payload `[u8 exited][i32 exit_code]`.
pub fn decode_close_payload(payload: &[u8]) -> Result<(bool, i32), FrameCodecError> {
    if payload.len() < 5 {
        return Err(FrameCodecError::PayloadTooShort("CLOSE", payload.len(), 5));
    }
    let exited = payload[0] != 0;
    let exit_code = i32::from_le_bytes(payload[1..5].try_into().unwrap());
    Ok((exited, exit_code))
}

/// Encodes a `FACTS` frame (`kind = 0x07`).
pub fn encode_facts_frame(channel_id: u32, facts: &serde_json::Value) -> Frame {
    let bytes = serde_json::to_vec(facts).unwrap_or_default();
    Frame::new(channel_id, FrameKind::Facts, bytes)
}

/// Decodes a `FACTS` frame into JSON.
pub fn decode_facts_payload(payload: &[u8]) -> Result<serde_json::Value, FrameCodecError> {
    serde_json::from_slice(payload).map_err(|e| FrameCodecError::InvalidJson(e.to_string()))
}

/// Encodes a JSON-RPC 2.0 message on Channel 0 (`kind = 0x00`).
pub fn encode_rpc_frame(value: &serde_json::Value) -> Frame {
    let bytes = serde_json::to_vec(value).unwrap_or_default();
    Frame::new(0, FrameKind::Rpc, bytes)
}

/// Decodes an RPC frame into JSON.
pub fn decode_rpc_payload(payload: &[u8]) -> Result<serde_json::Value, FrameCodecError> {
    serde_json::from_slice(payload).map_err(|e| FrameCodecError::InvalidJson(e.to_string()))
}

// -----------------------------------------------------------------------------
// Credit Flow Control State Machine
// -----------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelAttachMode {
    SnapshotBin,
    RawData,
}

/// Per-channel credit accounting and backpressure state machine.
#[derive(Debug)]
pub struct ChannelCreditTracker {
    channel_id: u32,
    mode: ChannelAttachMode,
    available_credit: u32,
    has_coalesced_pending: bool,
}

impl ChannelCreditTracker {
    pub fn new(channel_id: u32, mode: ChannelAttachMode) -> Self {
        let available_credit = match mode {
            ChannelAttachMode::SnapshotBin => INITIAL_SNAPSHOT_CREDIT,
            ChannelAttachMode::RawData => INITIAL_BYTE_CREDIT,
        };
        Self::with_credit(channel_id, mode, available_credit)
    }

    /// Builds a tracker with an explicit starting balance. Used for in-process
    /// sessions whose budget is defined entirely by `CREDIT` grants.
    pub fn with_credit(channel_id: u32, mode: ChannelAttachMode, available_credit: u32) -> Self {
        Self {
            channel_id,
            mode,
            available_credit,
            has_coalesced_pending: false,
        }
    }

    pub fn channel_id(&self) -> u32 {
        self.channel_id
    }

    pub fn mode(&self) -> ChannelAttachMode {
        self.mode
    }

    pub fn available_credit(&self) -> u32 {
        self.available_credit
    }

    pub fn is_exhausted(&self) -> bool {
        self.available_credit == 0
    }

    pub fn has_coalesced_pending(&self) -> bool {
        self.has_coalesced_pending
    }

    pub fn set_coalesced_pending(&mut self, pending: bool) {
        self.has_coalesced_pending = pending;
    }

    /// Grants additional credit budget received from a `CREDIT` frame (`kind = 0x03`).
    /// Returns true if this replenishment woke up a pending coalesced frame.
    pub fn replenish(&mut self, amount: u32) -> bool {
        self.available_credit = self.available_credit.saturating_add(amount);
        if self.available_credit > 0 && self.has_coalesced_pending {
            self.has_coalesced_pending = false;
            true
        } else {
            false
        }
    }

    /// Attempts to consume credit for an outgoing transmission.
    /// In `SnapshotBin` mode, each snapshot frame deducts 1 credit.
    /// In `RawData` mode, each frame deducts `bytes.len()` credits.
    /// Returns true if transmission is permitted, or false if credit is exhausted
    /// (triggering in-memory coalescing without wire emission).
    pub fn try_consume(&mut self, amount: u32) -> bool {
        if self.available_credit >= amount {
            self.available_credit -= amount;
            true
        } else {
            self.has_coalesced_pending = true;
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_frame_header_exact_9_bytes_little_endian() {
        let frame = Frame::new(42, FrameKind::SnapshotBin, vec![1, 2, 3, 4, 5]);
        let encoded = frame.encode();

        assert_eq!(encoded.len(), 9 + 5);
        // Channel ID: 42 (u32 LE) -> [42, 0, 0, 0]
        assert_eq!(&encoded[0..4], &[42, 0, 0, 0]);
        // Kind: SnapshotBin (0x02)
        assert_eq!(encoded[4], 0x02);
        // Payload len: 5 (u32 LE) -> [5, 0, 0, 0]
        assert_eq!(&encoded[5..9], &[5, 0, 0, 0]);
        // Payload
        assert_eq!(&encoded[9..14], &[1, 2, 3, 4, 5]);
    }

    #[test]
    fn test_streaming_decoder_handles_chunked_and_multiple_frames() {
        let mut decoder = FrameStreamDecoder::new();

        let frame1 = Frame::new(1, FrameKind::Data, b"hello".to_vec());
        let frame2 = Frame::new(2, FrameKind::Credit, 4u32.to_le_bytes().to_vec());

        let mut stream = Vec::new();
        frame1.encode_to(&mut stream);
        frame2.encode_to(&mut stream);

        // Feed half of header of frame1
        decoder.feed(&stream[0..5]);
        assert_eq!(decoder.next_frame().unwrap(), None);

        // Feed rest of frame1 + part of frame2
        decoder.feed(&stream[5..16]);
        let res1 = decoder.next_frame().unwrap();
        assert_eq!(res1, Some(frame1));
        assert_eq!(decoder.next_frame().unwrap(), None);

        // Feed rest of frame2
        decoder.feed(&stream[16..]);
        let res2 = decoder.next_frame().unwrap();
        assert_eq!(res2, Some(frame2));
        assert_eq!(decoder.next_frame().unwrap(), None);
    }

    #[test]
    fn test_oversized_payload_rejected() {
        let mut header = [0u8; 9];
        // Channel 1
        header[0..4].copy_from_slice(&1u32.to_le_bytes());
        // Kind Data
        header[4] = 0x01;
        // Length: 17 MiB (> 16 MiB max)
        let too_big = (17 * 1024 * 1024) as u32;
        header[5..9].copy_from_slice(&too_big.to_le_bytes());

        let err = Frame::decode_header(&header).unwrap_err();
        assert!(matches!(err, FrameCodecError::PayloadTooLarge(_)));
    }

    #[test]
    fn test_payload_codecs() {
        // Credit
        let c_frame = encode_credit_frame(10, 500);
        assert_eq!(c_frame.kind, FrameKind::Credit);
        assert_eq!(decode_credit_payload(&c_frame.payload).unwrap(), 500);

        // Resize
        let r_frame = encode_resize_frame(5, 120, 40, 1200, 800);
        assert_eq!(r_frame.kind, FrameKind::Resize);
        assert_eq!(
            decode_resize_payload(&r_frame.payload).unwrap(),
            (120, 40, 1200, 800)
        );

        // Focus
        let f_frame = encode_focus_frame(5, true, false);
        assert_eq!(f_frame.kind, FrameKind::Focus);
        assert_eq!(decode_focus_payload(&f_frame.payload).unwrap(), (true, false));

        // Close
        let cl_frame = encode_close_frame(5, true, 137);
        assert_eq!(cl_frame.kind, FrameKind::Close);
        assert_eq!(decode_close_payload(&cl_frame.payload).unwrap(), (true, 137));

        // Facts
        let facts = serde_json::json!({ "cwd": "/home/kite", "title": "zsh" });
        let facts_frame = encode_facts_frame(5, &facts);
        assert_eq!(decode_facts_payload(&facts_frame.payload).unwrap(), facts);

        // RPC
        let rpc = serde_json::json!({ "jsonrpc": "2.0", "method": "session.list" });
        let rpc_frame = encode_rpc_frame(&rpc);
        assert_eq!(rpc_frame.channel_id, 0);
        assert_eq!(decode_rpc_payload(&rpc_frame.payload).unwrap(), rpc);
    }

    #[test]
    fn test_credit_flow_control_state_machine() {
        let mut tracker = ChannelCreditTracker::new(1, ChannelAttachMode::SnapshotBin);
        assert_eq!(tracker.available_credit(), INITIAL_SNAPSHOT_CREDIT);
        assert_eq!(tracker.is_exhausted(), false);

        // Consume first frame
        assert_eq!(tracker.try_consume(1), true);
        assert_eq!(tracker.available_credit(), 1);

        // Consume second frame
        assert_eq!(tracker.try_consume(1), true);
        assert_eq!(tracker.available_credit(), 0);
        assert_eq!(tracker.is_exhausted(), true);

        // Third frame must fail and set coalesced pending
        assert_eq!(tracker.try_consume(1), false);
        assert_eq!(tracker.has_coalesced_pending(), true);

        // Replenish with 2 credits
        let woke = tracker.replenish(2);
        assert_eq!(woke, true, "replenishing should wake coalesced frame");
        assert_eq!(tracker.has_coalesced_pending(), false);
        assert_eq!(tracker.available_credit(), 2);
    }
}
