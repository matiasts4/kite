use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::time::{Duration, Instant};

const MAX_DEC2026_HOLD: Duration = Duration::from_millis(1000);
const MAX_UNHANDLED_CSI_SAMPLES: usize = 16;
const REP_MAX: usize = 512;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CellSnapshot {
    pub ch: String,
    pub width: u8, // 0 = wide continuation cell, 1 = normal, 2 = wide head cell
    pub fg: [u8; 3],
    pub bg: [u8; 3],
    pub has_bg: bool,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub inverse: bool,
    pub dim: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RowSnapshot {
    pub row_idx: u16,
    pub cells: Vec<CellSnapshot>,
    /// True when the row continues onto the next visible row (soft wrap).
    #[serde(default)]
    pub wrapped: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CursorSnapshot {
    pub visible: bool,
    pub col: u16,
    pub row: u16,
    pub shape: String,
    #[serde(default)]
    pub blink: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderSnapshot {
    pub seq: u64,
    pub cols: u16,
    pub rows: u16,
    pub alternate_screen: bool,
    pub application_cursor: bool,
    pub bracketed_paste: bool,
    pub mouse_tracking: bool,
    pub mouse_mode: String, // "none" | "click" | "drag" | "any"
    pub sgr_mouse: bool,
    pub sgr_pixels_mouse: bool,
    pub focus_reporting: bool,
    pub win32_input_mode: bool,
    pub kitty_keyboard_flags: u8,
    pub scrollback_offset: u32,
    pub cursor: CursorSnapshot,
    pub dirty_rows: Vec<RowSnapshot>,
    pub full: bool,
    pub title: Option<String>,
    pub clipboard_write: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TerminalSnapshotPollResponse {
    Unchanged {
        seq: u64,
        exited: bool,
        exit_code: Option<i64>,
    },
    Snapshot {
        snapshot: RenderSnapshot,
        exited: bool,
        exit_code: Option<i64>,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VtDiagnostics {
    pub spawn_cols: u16,
    pub spawn_rows: u16,
    pub resize_count: u64,
    pub last_resize_from: (u16, u16),
    pub last_resize_to: (u16, u16),
    pub dec2026_holds_total: u64,
    pub dec2026_timeouts_total: u64,
    pub last_hold_duration_ms: u64,
    pub unhandled_csi_samples: VecDeque<String>,
}

#[derive(Debug, Clone)]
pub struct Dec2026TimeoutNotice {
    pub held_ms: u64,
    pub seq: u64,
}

pub struct TerminalVtEngine {
    parser: vt100::Parser,
    cols: u16,
    rows: u16,
    seq: u64,
    client_rows: Vec<Vec<CellSnapshot>>,
    last_cursor: CursorSnapshot,
    last_title: Option<String>,
    dirty: bool,
    render_held: bool,
    hold_started_at: Option<Instant>,
    cursor_shape: String,
    win32_input_mode: bool,
    win32_tail: Vec<u8>,
    focus_reporting: bool,
    in_band_resize: bool,
    sgr_pixels_mouse: bool,
    explicit_mouse_mode: Option<String>,
    explicit_sgr_mouse: Option<bool>,
    kitty_keyboard_stack: Vec<u8>,
    replies: Vec<u8>,
    pending_clipboard: Option<String>,
    current_title: Option<String>,
    canvas_active: bool,
    last_graphic_char: char,
    committed_snapshot: Option<RenderSnapshot>,
    diagnostics: VtDiagnostics,
    pending_timeouts: Vec<Dec2026TimeoutNotice>,
}

// Kite Dark Terminal Palette (matches TerminalView.tsx theme)
pub const DEFAULT_FG: [u8; 3] = [250, 250, 250]; // #fafafa
pub const DEFAULT_BG: [u8; 3] = [10, 10, 10];    // #0a0a0a

fn channel_luminance(v: u8) -> f32 {
    static LUT: std::sync::OnceLock<[f32; 256]> = std::sync::OnceLock::new();
    let table = LUT.get_or_init(|| {
        let mut arr = [0.0f32; 256];
        let mut i = 0;
        while i < 256 {
            let s = (i as f32) / 255.0;
            arr[i] = if s <= 0.03928 {
                s / 12.92
            } else {
                ((s + 0.055) / 1.055).powf(2.4)
            };
            i += 1;
        }
        arr
    });
    table[v as usize]
}

#[inline]
fn relative_luminance(rgb: [u8; 3]) -> f32 {
    0.2126 * channel_luminance(rgb[0])
        + 0.7152 * channel_luminance(rgb[1])
        + 0.0722 * channel_luminance(rgb[2])
}

#[inline]
fn contrast_ratio(a: [u8; 3], b: [u8; 3]) -> f32 {
    let la = relative_luminance(a);
    let lb = relative_luminance(b);
    (la.max(lb) + 0.05) / (la.min(lb) + 0.05)
}

#[inline]
fn is_graphics_glyph(ch: &str) -> bool {
    ch.chars().next().is_some_and(|c| {
        matches!(
            c as u32,
            0x23fa
                | 0x2500..=0x259f
                | 0x2800..=0x28ff
                | 0xe000..=0xf8ff
                | 0x1fb00..=0x1fbff
                | 0x1cc00..=0x1cebf
                | 0xf0000..=0x10fffd
        )
    })
}

#[inline]
fn ensure_readable_fg(fg: [u8; 3], bg: [u8; 3], ch: &str) -> [u8; 3] {
    if (fg == DEFAULT_FG && bg == DEFAULT_BG)
        || ch == " "
        || ch.trim().is_empty()
        || is_graphics_glyph(ch)
    {
        return fg;
    }
    let min_contrast = 3.2;
    if contrast_ratio(fg, bg) >= min_contrast {
        return fg;
    }
    let bg_lum = relative_luminance(bg);
    if bg_lum < 0.25 {
        [
            fg[0].saturating_add(((230u16.saturating_sub(fg[0] as u16)) * 65 / 100) as u8),
            fg[1].saturating_add(((230u16.saturating_sub(fg[1] as u16)) * 65 / 100) as u8),
            fg[2].saturating_add(((235u16.saturating_sub(fg[2] as u16)) * 65 / 100) as u8),
        ]
    } else {
        [
            (fg[0] as u16 * 35 / 100) as u8,
            (fg[1] as u16 * 35 / 100) as u8,
            (fg[2] as u16 * 35 / 100) as u8,
        ]
    }
}

fn ansi_color_to_rgb(color: vt100::Color, is_bg: bool, bold: bool) -> ([u8; 3], bool) {
    match color {
        vt100::Color::Default => {
            if is_bg {
                (DEFAULT_BG, false)
            } else {
                (DEFAULT_FG, true)
            }
        }
        vt100::Color::Idx(idx) => {
            let effective_idx = if !is_bg && bold && idx < 8 {
                idx + 8
            } else {
                idx
            };
            (indexed_color_to_rgb(effective_idx), true)
        }
        vt100::Color::Rgb(r, g, b) => ([r, g, b], true),
    }
}

fn indexed_color_to_rgb(idx: u8) -> [u8; 3] {
    match idx {
        0 => [23, 23, 23],       // #171717 Black
        1 => [224, 108, 117],    // #e06c75 Red
        2 => [127, 217, 154],    // #7fd99a Green
        3 => [232, 200, 122],    // #e8c87a Yellow
        4 => [92, 143, 255],     // #5c8fff Blue
        5 => [212, 160, 140],    // #d4a08c Magenta
        6 => [94, 200, 197],     // #5ec8c5 Cyan
        7 => [212, 212, 212],    // #d4d4d4 White
        8 => [118, 124, 138],    // #767c8a Bright Black
        9 => [255, 138, 138],    // #ff8a8a Bright Red
        10 => [168, 240, 184],   // #a8f0b8 Bright Green
        11 => [255, 224, 138],   // #ffe08a Bright Yellow
        12 => [138, 176, 255],   // #8ab0ff Bright Blue
        13 => [232, 196, 176],   // #e8c4b0 Bright Magenta
        14 => [138, 232, 228],   // #8ae8e4 Bright Cyan
        15 => [250, 250, 250],   // #fafafa Bright White
        16..=231 => {
            let n = idx - 16;
            let r = (n / 36) % 6;
            let g = (n / 6) % 6;
            let b = n % 6;
            let cv = |v: u8| if v == 0 { 0 } else { v * 40 + 55 };
            [cv(r), cv(g), cv(b)]
        }
        232..=255 => {
            let gray = 8 + (idx - 232) * 10;
            [gray, gray, gray]
        }
    }
}

fn rfind_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .rposition(|window| window == needle)
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|window| window == needle)
}

fn sync_hold_closes_within(bytes: &[u8]) -> bool {
    const START: &[u8] = b"\x1b[?2026h";
    const END: &[u8] = b"\x1b[?2026l";
    let mut depth = 1i32;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i..].starts_with(START) {
            depth += 1;
            i += START.len();
            continue;
        }
        if bytes[i..].starts_with(END) {
            depth -= 1;
            i += END.len();
            if depth == 0 {
                return true;
            }
            continue;
        }
        i += 1;
    }
    false
}

/// Strips leading Braille/star spinners from agent terminal titles so
/// 10Hz title animations do not cause unnecessary header churn.
pub fn shown_title(title: &str) -> &str {
    let is_spinner = |c: char| {
        matches!(
            c,
            '\u{2800}'..='\u{28ff}'
                | '\u{00b7}'
                | '\u{2722}'
                | '\u{2733}'
                | '\u{2736}'
                | '\u{273b}'
                | '\u{273d}'
                | '\u{25d0}'..='\u{25d3}'
        )
    };
    let rest = title.trim_start_matches(|c: char| is_spinner(c) || c.is_whitespace());
    let led = title.len() - rest.len();
    if rest.is_empty()
        || !title[..led].chars().any(is_spinner)
        || !title[..led].ends_with(char::is_whitespace)
    {
        title
    } else {
        rest
    }
}

fn decode_base64_utf8(input: &[u8]) -> Option<String> {
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    let mut buf = 0u32;
    let mut bits = 0u8;
    for &b in input {
        if b == b'=' || b.is_ascii_whitespace() {
            continue;
        }
        let val = match b {
            b'A'..=b'Z' => b - b'A',
            b'a'..=b'z' => b - b'a' + 26,
            b'0'..=b'9' => b - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        };
        buf = (buf << 6) | (val as u32);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buf >> bits) & 0xff) as u8);
            if out.len() > (1 << 20) {
                return None;
            }
        }
    }
    String::from_utf8(out).ok()
}

/// Normalizes CSI sequences not natively supported by `vt100` (`CSI E`, `CSI F`, `CSI f`, `CSI s`, `CSI u`).
fn utf8_seq_len(lead: u8) -> usize {
    match lead {
        0x00..=0x7f => 1,
        0xc0..=0xdf => 2,
        0xe0..=0xef => 3,
        0xf0..=0xf7 => 4,
        _ => 1,
    }
}

fn push_graphic_bytes(out: &mut Vec<u8>, bytes: &[u8], i: &mut usize, last_graphic_char: &mut char) {
    let b = bytes[*i];
    if b < 0x20 || b == 0x7f {
        out.push(b);
        *i += 1;
        return;
    }
    let width = utf8_seq_len(b);
    if width == 1 || *i + width > bytes.len() {
        if b < 0x80 {
            *last_graphic_char = b as char;
        }
        out.push(b);
        *i += 1;
        return;
    }
    let slice = &bytes[*i..*i + width];
    if slice[1..].iter().all(|c| (*c & 0xc0) == 0x80) {
        if let Ok(text) = std::str::from_utf8(slice) {
            if let Some(ch) = text.chars().next() {
                if !ch.is_control() {
                    *last_graphic_char = ch;
                }
            }
            out.extend_from_slice(slice);
            *i += width;
            return;
        }
    }
    out.push(b);
    *i += 1;
}

fn repeat_last_graphic(out: &mut Vec<u8>, ch: char, count: usize) {
    let mut buf = [0u8; 4];
    let encoded = ch.encode_utf8(&mut buf);
    for _ in 0..count {
        out.extend_from_slice(encoded.as_bytes());
    }
}

fn rep_count(params: &[u8]) -> usize {
    let text = std::str::from_utf8(params).unwrap_or("");
    let first = text.split(';').next().unwrap_or("");
    let count = if first.is_empty() {
        1
    } else {
        first.parse::<usize>().unwrap_or(1)
    };
    count.clamp(1, REP_MAX)
}

fn normalize_csi_sequences(bytes: &[u8], last_graphic_char: &mut char) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != 0x1b {
            push_graphic_bytes(&mut out, bytes, &mut i, last_graphic_char);
            continue;
        }
        if i + 1 >= bytes.len() {
            out.push(0x1b);
            break;
        }
        match bytes[i + 1] {
            b'[' => {
                let mut k = i + 2;
                while k < bytes.len() && bytes[k] < 0x40 {
                    k += 1;
                }
                if k >= bytes.len() {
                    out.extend_from_slice(&bytes[i..]);
                    break;
                }
                let final_byte = bytes[k];
                let body = &bytes[i + 2..k];
                let private = body
                    .first()
                    .is_some_and(|b| matches!(b, b'?' | b'>' | b'<' | b'='));
                if !private && final_byte == b'b' && body.iter().all(|b| b.is_ascii_digit() || *b == b';') {
                    repeat_last_graphic(&mut out, *last_graphic_char, rep_count(body));
                    i = k + 1;
                    continue;
                }
                if !private {
                    match final_byte {
                        b'E' => {
                            let n = std::str::from_utf8(body)
                                .ok()
                                .and_then(|s| s.parse::<u16>().ok())
                                .unwrap_or(1)
                                .max(1);
                            out.extend_from_slice(format!("\x1b[{n}B\r").as_bytes());
                            i = k + 1;
                            continue;
                        }
                        b'F' => {
                            let n = std::str::from_utf8(body)
                                .ok()
                                .and_then(|s| s.parse::<u16>().ok())
                                .unwrap_or(1)
                                .max(1);
                            out.extend_from_slice(format!("\x1b[{n}A\r").as_bytes());
                            i = k + 1;
                            continue;
                        }
                        b'f' => {
                            out.extend_from_slice(b"\x1b[");
                            out.extend_from_slice(body);
                            out.push(b'H');
                            i = k + 1;
                            continue;
                        }
                        b's' if body.is_empty() => {
                            out.extend_from_slice(b"\x1b7");
                            i = k + 1;
                            continue;
                        }
                        b'u' if body.is_empty() => {
                            out.extend_from_slice(b"\x1b8");
                            i = k + 1;
                            continue;
                        }
                        _ => {}
                    }
                }
                out.extend_from_slice(&bytes[i..=k]);
                i = k + 1;
            }
            b']' => {
                let mut k = i + 2;
                while k < bytes.len() {
                    if bytes[k] == 0x07 {
                        k += 1;
                        break;
                    }
                    if bytes[k] == 0x1b && k + 1 < bytes.len() && bytes[k + 1] == b'\\' {
                        k += 2;
                        break;
                    }
                    k += 1;
                }
                let end = k.min(bytes.len());
                out.extend_from_slice(&bytes[i..end]);
                i = end;
            }
            _ => {
                out.push(bytes[i]);
                out.push(bytes[i + 1]);
                i += 2;
            }
        }
    }
    out
}

fn csi_params_end(body: &[u8], start: usize) -> usize {
    let mut idx = start;
    while idx < body.len() && (body[idx].is_ascii_digit() || body[idx] == b';') {
        idx += 1;
    }
    idx
}

fn csi_is_recognized(body: &[u8], final_byte: u8) -> bool {
    let private = matches!(body.first().copied(), Some(b'?' | b'>' | b'<' | b'='));
    let params_end = csi_params_end(body, if private { 1 } else { 0 });
    if params_end != body.len() {
        return false;
    }
    if private {
        return matches!(final_byte, b'h' | b'l' | b'J' | b'K' | b'n' | b'p' | b'u' | b'c');
    }
    matches!(
        final_byte,
        b'@' | b'A'
            | b'B'
            | b'C'
            | b'D'
            | b'E'
            | b'F'
            | b'G'
            | b'H'
            | b'J'
            | b'K'
            | b'L'
            | b'M'
            | b'P'
            | b'S'
            | b'T'
            | b'X'
            | b'b'
            | b'c'
            | b'd'
            | b'f'
            | b'h'
            | b'l'
            | b'm'
            | b'n'
            | b'q'
            | b'r'
            | b's'
            | b't'
            | b'u'
    )
}

fn color_json(color: vt100::Color) -> serde_json::Value {
    match color {
        vt100::Color::Default => serde_json::json!("default"),
        vt100::Color::Idx(index) => serde_json::json!(["index", index]),
        vt100::Color::Rgb(red, green, blue) => serde_json::json!(["rgb", red, green, blue]),
    }
}

impl TerminalVtEngine {
    pub fn new(cols: u16, rows: u16) -> Self {
        let cols = cols.max(1);
        let rows = rows.max(1);
        let parser = vt100::Parser::new(rows, cols, 5000);
        let empty_cursor = CursorSnapshot {
            visible: true,
            col: 0,
            row: 0,
            shape: "bar".to_string(),
            blink: false,
        };

        Self {
            parser,
            cols,
            rows,
            seq: 0,
            client_rows: Vec::new(),
            last_cursor: empty_cursor,
            last_title: None,
            dirty: true,
            render_held: false,
            hold_started_at: None,
            cursor_shape: "bar".to_string(),
            win32_input_mode: false,
            win32_tail: Vec::new(),
            focus_reporting: false,
            in_band_resize: false,
            sgr_pixels_mouse: false,
            explicit_mouse_mode: None,
            explicit_sgr_mouse: None,
            kitty_keyboard_stack: Vec::new(),
            replies: Vec::new(),
            pending_clipboard: None,
            current_title: None,
            canvas_active: false,
            last_graphic_char: ' ',
            committed_snapshot: None,
            diagnostics: VtDiagnostics {
                spawn_cols: cols,
                spawn_rows: rows,
                resize_count: 0,
                last_resize_from: (0, 0),
                last_resize_to: (0, 0),
                dec2026_holds_total: 0,
                dec2026_timeouts_total: 0,
                last_hold_duration_ms: 0,
                unhandled_csi_samples: VecDeque::new(),
            },
            pending_timeouts: Vec::new(),
        }
    }

    pub fn seq(&self) -> u64 {
        self.seq
    }

    /// Current OSC 0/2 window title, if the child ever set one.
    pub fn title(&self) -> Option<String> {
        self.current_title.clone()
    }

    /// True while a synchronized-output block is being painted in memory only.
    pub fn render_held(&self) -> bool {
        self.render_held
    }

    /// True when parsed output has not been published in a snapshot yet.
    pub fn has_pending_output(&self) -> bool {
        self.dirty || self.render_held
    }

    /// True when the grid has unpainted changes and DEC 2026 sync output is not holding paint.
    pub fn wants_paint(&self) -> bool {
        self.dirty && !self.render_held
    }

    /// Plain text contents of the current visible screen.
    pub fn screen_text(&self) -> String {
        self.parser.screen().contents()
    }

    /// Jump the viewport directly to an absolute scrollback offset.
    pub fn jump_scrollback(&mut self, offset: u32) {
        if self.parser.screen().alternate_screen() {
            return;
        }
        let current = self.parser.screen().scrollback();
        self.parser.set_scrollback(offset as usize);
        if self.parser.screen().scrollback() != current {
            self.dirty = true;
        }
    }

    /// Case-insensitive text search across visible screen rows.
    pub fn find_text(&self, query: &str, limit: usize) -> Vec<serde_json::Value> {
        let needle = query.trim();
        if needle.is_empty() || limit == 0 {
            return Vec::new();
        }
        let needle_lower = needle.to_lowercase();
        let screen = self.parser.screen();
        let mut hits = Vec::new();
        for r in 0..self.rows {
            let mut row_str = String::with_capacity(self.cols as usize);
            for c in 0..self.cols {
                if let Some(cell) = screen.cell(r, c) {
                    if !cell.is_wide_continuation() {
                        let ch = cell.contents();
                        if ch.is_empty() {
                            row_str.push(' ');
                        } else {
                            row_str.push_str(&ch);
                        }
                    }
                } else {
                    row_str.push(' ');
                }
            }
            let row_lower = row_str.to_lowercase();
            let mut search_from = 0;
            while let Some(pos) = row_lower[search_from..].find(&needle_lower) {
                let byte_col = search_from + pos;
                let char_col = row_lower[..byte_col].chars().count() as u16;
                hits.push(serde_json::json!({
                    "row": r,
                    "col": char_col,
                    "len": needle.chars().count(),
                    "line": row_str.trim_end(),
                }));
                if hits.len() >= limit {
                    return hits;
                }
                search_from = byte_col + needle_lower.len().max(1);
            }
        }
        hits
    }

    pub fn alternate_screen(&self) -> bool {
        self.parser.screen().alternate_screen()
    }

    /// Escape codes that rebuild the current alternate screen (cells, cursor,
    /// input modes, title) on a fresh `xterm.js` of the same size. Returns
    /// `None` on the primary screen, where scrollback history is still replayed.
    /// Used when the user switches renderer, so a TUI is seeded from one
    /// consistent frame instead of a byte tail cut at an arbitrary offset.
    pub fn alternate_screen_seed(&self) -> Option<Vec<u8>> {
        let screen = self.parser.screen();
        if !screen.alternate_screen() {
            return None;
        }
        let mut seed = b"\x1b[?1049h\x1b[2J\x1b[H".to_vec();
        seed.extend_from_slice(&screen.state_formatted());
        Some(seed)
    }

    pub fn diagnostics(&self) -> &VtDiagnostics {
        &self.diagnostics
    }

    pub fn take_dec2026_timeouts(&mut self) -> Vec<Dec2026TimeoutNotice> {
        std::mem::take(&mut self.pending_timeouts)
    }

    pub fn set_canvas_active(&mut self, active: bool) {
        self.canvas_active = active;
    }

    pub fn is_canvas_active(&self) -> bool {
        self.canvas_active
    }

    pub fn take_replies(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.replies)
    }

    pub fn kitty_keyboard_flags(&self) -> u8 {
        self.kitty_keyboard_stack.last().copied().unwrap_or(0)
    }

    pub fn resize(&mut self, cols: u16, rows: u16) {
        let cols = cols.max(1);
        let rows = rows.max(1);
        if self.cols == cols && self.rows == rows {
            return;
        }
        let from = (self.cols, self.rows);
        self.cols = cols;
        self.rows = rows;
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.parser.set_size(rows, cols);
        }));
        if self.in_band_resize {
            let height_px = (rows as u32) * 18;
            let width_px = (cols as u32) * 9;
            self.replies
                .extend_from_slice(format!("\x1b[48;{rows};{cols};{height_px};{width_px}t").as_bytes());
        }
        self.diagnostics.resize_count = self.diagnostics.resize_count.saturating_add(1);
        self.diagnostics.last_resize_from = from;
        self.diagnostics.last_resize_to = (cols, rows);
        self.client_rows.clear();
        self.render_held = false;
        self.hold_started_at = None;
        self.dirty = true;
    }

    pub fn scroll_viewport(&mut self, delta_lines: i32) {
        if self.parser.screen().alternate_screen() {
            return;
        }
        let current = self.parser.screen().scrollback();
        let next = if delta_lines > 0 {
            current.saturating_add(delta_lines as usize)
        } else {
            current.saturating_sub((-delta_lines) as usize)
        };
        self.parser.set_scrollback(next);
        let updated = self.parser.screen().scrollback();
        if updated != current {
            self.dirty = true;
        }
    }

    pub fn reset_scrollback(&mut self) {
        if self.parser.screen().scrollback() > 0 {
            self.parser.set_scrollback(0);
            self.dirty = true;
        }
    }

    pub fn clear(&mut self) {
        self.parser.set_scrollback(0);
        self.parser.process(b"\x1b[2J\x1b[H");
        self.client_rows.clear();
        self.render_held = false;
        self.hold_started_at = None;
        self.dirty = true;
    }

    fn watch_win32_input_mode(&mut self, bytes: &[u8]) {
        const ON: &[u8] = b"\x1b[?9001h";
        const OFF: &[u8] = b"\x1b[?9001l";
        const KEEP: usize = ON.len() - 1;

        let mut edge = std::mem::take(&mut self.win32_tail);
        edge.extend_from_slice(&bytes[..bytes.len().min(KEEP)]);
        let latest = |buf: &[u8]| -> Option<bool> {
            let on_pos = rfind_subsequence(buf, ON);
            let off_pos = rfind_subsequence(buf, OFF);
            match (on_pos, off_pos) {
                (Some(on), off) => Some(off.is_none_or(|o| on > o)),
                (None, Some(_)) => Some(false),
                (None, None) => None,
            }
        };
        if let Some(on) = latest(bytes).or_else(|| latest(&edge)) {
            self.win32_input_mode = on;
        }
        let end = if bytes.len() >= KEEP { bytes } else { &edge };
        self.win32_tail = end[end.len().saturating_sub(KEEP)..].to_vec();
    }

    fn scan_protocol_sequences(&mut self, bytes: &[u8]) {
        self.watch_win32_input_mode(bytes);

        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] != 0x1b || i + 1 >= bytes.len() {
                i += 1;
                continue;
            }
            match bytes[i + 1] {
                b'[' => {
                    let start = i + 2;
                    let mut j = start;
                    while j < bytes.len()
                        && (bytes[j].is_ascii_digit()
                            || matches!(bytes[j], b';' | b'?' | b'>' | b'<' | b'=' | b' ' | b'$'))
                    {
                        j += 1;
                    }
                    if j >= bytes.len() {
                        break;
                    }
                    let final_byte = bytes[j];
                    let body = &bytes[start..j];
                    self.handle_csi_sequence(body, final_byte);
                    i = j + 1;
                }
                b']' => {
                    // OSC sequence: \x1b] ... (\x07 or \x1b\\)
                    let start = i + 2;
                    let mut j = start;
                    let mut term_len = 0;
                    while j < bytes.len() {
                        if bytes[j] == 0x07 {
                            term_len = 1;
                            break;
                        }
                        if bytes[j] == 0x1b && j + 1 < bytes.len() && bytes[j + 1] == b'\\' {
                            term_len = 2;
                            break;
                        }
                        j += 1;
                    }
                    if term_len == 0 {
                        break;
                    }
                    let osc_body = &bytes[start..j];
                    self.handle_osc_sequence(osc_body);
                    i = j + term_len;
                }
                _ => {
                    i += 1;
                }
            }
        }
    }

    fn handle_csi_sequence(&mut self, body: &[u8], final_byte: u8) {
        let Ok(s) = std::str::from_utf8(body) else {
            return;
        };

        // Cursor shape: DECSCUSR (\x1b[Ps q or \x1b[Ps SP q)
        if final_byte == b'q' {
            let trimmed = s.trim_end_matches(' ');
            match trimmed {
                "" | "0" | "1" | "2" => self.cursor_shape = "block".to_string(),
                "3" | "4" => self.cursor_shape = "underline".to_string(),
                "5" | "6" => self.cursor_shape = "bar".to_string(),
                _ => {}
            }
            return;
        }

        // DEC Private Mode Set / Reset (\x1b[?Pm h / l)
        if let Some(rest) = s.strip_prefix('?') {
            if final_byte == b'h' || final_byte == b'l' {
                let enable = final_byte == b'h';
                for part in rest.split(';') {
                    if let Ok(mode) = part.parse::<u16>() {
                        match mode {
                            1000 => {
                                self.explicit_mouse_mode =
                                    Some(if enable { "click" } else { "none" }.to_string());
                            }
                            1002 => {
                                self.explicit_mouse_mode =
                                    Some(if enable { "drag" } else { "none" }.to_string());
                            }
                            1003 => {
                                self.explicit_mouse_mode =
                                    Some(if enable { "any" } else { "none" }.to_string());
                            }
                            1004 => self.focus_reporting = enable,
                            1006 => self.explicit_sgr_mouse = Some(enable),
                            1016 => {
                                self.sgr_pixels_mouse = enable;
                                if enable {
                                    self.explicit_sgr_mouse = Some(true);
                                }
                            }
                            2048 => self.in_band_resize = enable,
                            9001 => self.win32_input_mode = enable,
                            _ => {}
                        }
                    }
                }
                return;
            }

            // DECRQM: Request DEC Private Mode (\x1b[?Ps$p -> \x1b[?Ps;Pm$y)
            if final_byte == b'p' && rest.ends_with('$') {
                let mode_str = rest.trim_end_matches('$');
                if let Ok(mode) = mode_str.parse::<u16>() {
                    let screen = self.parser.screen();
                    // Pm: 1 = set, 2 = reset, 0 = not recognized
                    let status = match mode {
                        25 => if screen.hide_cursor() { 2 } else { 1 },
                        1000 => if self.effective_mouse_mode() == "click" { 1 } else { 2 },
                        1002 => if self.effective_mouse_mode() == "drag" { 1 } else { 2 },
                        1003 => if self.effective_mouse_mode() == "any" { 1 } else { 2 },
                        1004 => if self.focus_reporting { 1 } else { 2 },
                        1006 => if self.effective_sgr_mouse() { 1 } else { 2 },
                        1016 => if self.sgr_pixels_mouse { 1 } else { 2 },
                        1049 => if screen.alternate_screen() { 1 } else { 2 },
                        2004 => if screen.bracketed_paste() { 1 } else { 2 },
                        2026 => if self.render_held { 1 } else { 2 },
                        2027 => 1,
                        2048 => if self.in_band_resize { 1 } else { 2 },
                        9001 => if self.win32_input_mode { 1 } else { 2 },
                        _ => 0,
                    };
                    self.replies
                        .extend_from_slice(format!("\x1b[?{mode};{status}$y").as_bytes());
                }
                return;
            }

            // Extended CPR (\x1b[?6n)
            if final_byte == b'n' && rest == "6" {
                let (r, c) = self.parser.screen().cursor_position();
                self.replies
                    .extend_from_slice(format!("\x1b[?{};{};1R", r + 1, c + 1).as_bytes());
                return;
            }

            // Kitty keyboard query (\x1b[?u)
            if final_byte == b'u' && rest.is_empty() {
                let flags = self.kitty_keyboard_flags();
                self.replies
                    .extend_from_slice(format!("\x1b[?{flags}u").as_bytes());
                return;
            }
        }

        // Kitty keyboard protocol push/pop/set (\x1b[>flags u, \x1b[<count u, \x1b[=flags;mode u)
        if final_byte == b'u' {
            if let Some(rest) = s.strip_prefix('>') {
                let flags = rest
                    .split(';')
                    .next()
                    .and_then(|v| v.parse::<u8>().ok())
                    .unwrap_or(0);
                if self.kitty_keyboard_stack.len() >= 16 {
                    self.kitty_keyboard_stack.remove(0);
                }
                self.kitty_keyboard_stack.push(flags);
                return;
            }
            if let Some(rest) = s.strip_prefix('<') {
                let count = rest.parse::<usize>().unwrap_or(1).max(1);
                for _ in 0..count {
                    self.kitty_keyboard_stack.pop();
                }
                return;
            }
            if let Some(rest) = s.strip_prefix('=') {
                let flags = rest
                    .split(';')
                    .next()
                    .and_then(|v| v.parse::<u8>().ok())
                    .unwrap_or(0);
                if let Some(last) = self.kitty_keyboard_stack.last_mut() {
                    *last = flags;
                } else {
                    self.kitty_keyboard_stack.push(flags);
                }
                return;
            }
        }

        // Device Status Report (DSR / CPR: \x1b[5n, \x1b[6n)
        if final_byte == b'n' {
            match s {
                "5" => self.replies.extend_from_slice(b"\x1b[0n"),
                "6" => {
                    let (r, c) = self.parser.screen().cursor_position();
                    self.replies
                        .extend_from_slice(format!("\x1b[{};{}R", r + 1, c + 1).as_bytes());
                }
                _ => {}
            }
            return;
        }

        // Device Attributes (DA1 / DA2: \x1b[c, \x1b[>c)
        if final_byte == b'c' {
            if s.is_empty() || s == "0" {
                self.replies.extend_from_slice(b"\x1b[?62;22c");
            } else if s == ">" || s == ">0" {
                self.replies.extend_from_slice(b"\x1b[>1;10;0c");
            }
            return;
        }

        // Window manipulation queries (\x1b[14t, \x1b[16t, \x1b[18t)
        if final_byte == b't' {
            match s {
                "14" => {
                    let h = (self.rows as u32) * 18;
                    let w = (self.cols as u32) * 9;
                    self.replies
                        .extend_from_slice(format!("\x1b[4;{h};{w}t").as_bytes());
                }
                "16" => {
                    self.replies.extend_from_slice(b"\x1b[6;18;9t");
                }
                "18" => {
                    self.replies
                        .extend_from_slice(format!("\x1b[8;{};{}t", self.rows, self.cols).as_bytes());
                }
                _ => {}
            }
        }

        if !csi_is_recognized(body, final_byte) {
            let mut raw = Vec::with_capacity(body.len() + 3);
            raw.extend_from_slice(b"\x1b[");
            raw.extend_from_slice(body);
            raw.push(final_byte);
            self.note_unhandled_csi(&raw);
        }
    }

    fn note_unhandled_csi(&mut self, raw: &[u8]) {
        let sample = String::from_utf8_lossy(raw).replace('\u{1b}', "ESC");
        if self.diagnostics.unhandled_csi_samples.len() >= MAX_UNHANDLED_CSI_SAMPLES {
            self.diagnostics.unhandled_csi_samples.pop_front();
        }
        self.diagnostics.unhandled_csi_samples.push_back(sample);
    }

    fn handle_osc_sequence(&mut self, body: &[u8]) {
        let Ok(s) = std::str::from_utf8(body) else {
            return;
        };
        let Some((code, rest)) = s.split_once(';') else {
            return;
        };
        match code {
            "0" | "2" => {
                let cleaned = shown_title(rest).to_string();
                self.current_title = Some(cleaned);
            }
            "10" if rest == "?" => {
                // Foreground color query (#fafafa)
                self.replies
                    .extend_from_slice(b"\x1b]10;rgb:fafa/fafa/fafa\x1b\\");
            }
            "11" if rest == "?" => {
                // Background color query (#0a0a0a) — critical for OpenCode / Lipgloss dark-mode detection!
                self.replies
                    .extend_from_slice(b"\x1b]11;rgb:0a0a/0a0a/0a0a\x1b\\");
            }
            "12" if rest == "?" => {
                // Cursor color query (#5c8fff)
                self.replies
                    .extend_from_slice(b"\x1b]12;rgb:5c5c/8f8f/ffff\x1b\\");
            }
            "52" => {
                // OSC 52 clipboard write: 52;c;<base64>
                if let Some((_target, b64)) = rest.split_once(';') {
                    if b64 != "?" {
                        if let Some(decoded) = decode_base64_utf8(b64.as_bytes()) {
                            self.pending_clipboard = Some(decoded);
                        }
                    }
                }
            }
            _ => {}
        }
    }

    fn effective_mouse_mode(&self) -> String {
        if let Some(ref explicit) = self.explicit_mouse_mode {
            if explicit != "none" {
                return explicit.clone();
            }
        }
        match self.parser.screen().mouse_protocol_mode() {
            vt100::MouseProtocolMode::None => "none".to_string(),
            vt100::MouseProtocolMode::Press | vt100::MouseProtocolMode::PressRelease => {
                "click".to_string()
            }
            vt100::MouseProtocolMode::ButtonMotion => "drag".to_string(),
            vt100::MouseProtocolMode::AnyMotion => "any".to_string(),
        }
    }

    fn effective_sgr_mouse(&self) -> bool {
        if let Some(explicit) = self.explicit_sgr_mouse {
            if explicit {
                return true;
            }
        }
        matches!(
            self.parser.screen().mouse_protocol_encoding(),
            vt100::MouseProtocolEncoding::Sgr
        )
    }

    fn process_parser(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.parser.process(bytes);
        }));
    }

    fn commit_snapshot(&mut self) {
        self.dirty = true;
        if let TerminalSnapshotPollResponse::Snapshot { snapshot, .. } =
            self.get_snapshot_diff(0, false, None)
        {
            if snapshot.clipboard_write.is_some() {
                self.pending_clipboard = snapshot.clipboard_write;
            }
        }
    }

    fn open_render_hold(&mut self) {
        self.commit_snapshot();
        self.render_held = true;
        self.hold_started_at = Some(Instant::now());
        self.diagnostics.dec2026_holds_total = self.diagnostics.dec2026_holds_total.saturating_add(1);
    }

    fn close_render_hold(&mut self) {
        let held_ms = self
            .hold_started_at
            .map(|started| started.elapsed().as_millis() as u64)
            .unwrap_or(0);
        self.diagnostics.last_hold_duration_ms = held_ms;
        self.render_held = false;
        self.hold_started_at = None;
        self.commit_snapshot();
    }

    fn frozen_clean_snapshot(&self) -> RenderSnapshot {
        if let Some(snapshot) = &self.committed_snapshot {
            let mut snapshot = snapshot.clone();
            snapshot.seq = self.seq;
            snapshot.clipboard_write = None;
            return snapshot;
        }
        RenderSnapshot {
            seq: self.seq,
            cols: self.cols,
            rows: self.rows,
            alternate_screen: false,
            application_cursor: false,
            bracketed_paste: false,
            mouse_tracking: self
                .explicit_mouse_mode
                .as_deref()
                .is_some_and(|mode| mode != "none"),
            mouse_mode: self
                .explicit_mouse_mode
                .clone()
                .unwrap_or_else(|| "none".to_string()),
            sgr_mouse: self.explicit_sgr_mouse.unwrap_or(false),
            sgr_pixels_mouse: self.sgr_pixels_mouse,
            focus_reporting: self.focus_reporting,
            win32_input_mode: self.win32_input_mode,
            kitty_keyboard_flags: self.kitty_keyboard_flags(),
            scrollback_offset: 0,
            cursor: self.last_cursor.clone(),
            dirty_rows: Vec::new(),
            full: true,
            title: self.current_title.clone(),
            clipboard_write: None,
        }
    }

    pub fn diagnostic_report(&self) -> serde_json::Value {
        let screen = self.parser.screen();
        let mut rows_text = Vec::with_capacity(self.rows as usize);
        let mut rows_attrs = Vec::with_capacity(self.rows as usize);
        for r in 0..self.rows {
            let mut text = String::new();
            let mut attrs = Vec::with_capacity(self.cols as usize);
            for c in 0..self.cols {
                if let Some(cell) = screen.cell(r, c) {
                    let raw = cell.contents();
                    let ch = if raw.is_empty() { " ".to_string() } else { raw };
                    if !cell.is_wide_continuation() {
                        text.push_str(&ch);
                    }
                    attrs.push(serde_json::json!({
                        "ch": ch,
                        "width": if cell.is_wide_continuation() { 0 } else if cell.is_wide() { 2 } else { 1 },
                        "bold": cell.bold(),
                        "italic": cell.italic(),
                        "underline": cell.underline(),
                        "inverse": cell.inverse(),
                        "fg": color_json(cell.fgcolor()),
                        "bg": color_json(cell.bgcolor()),
                    }));
                }
            }
            rows_text.push(text.trim_end().to_string());
            rows_attrs.push(attrs);
        }
        let (cursor_row, cursor_col) = screen.cursor_position();
        serde_json::json!({
            "cols": self.cols,
            "rows": self.rows,
            "altScreen": screen.alternate_screen(),
            "mouseMode": self.effective_mouse_mode(),
            "cursor": {
                "visible": !screen.hide_cursor(),
                "col": cursor_col,
                "row": cursor_row,
                "shape": self.cursor_shape,
            },
            "seq": self.seq,
            "diagnostics": self.diagnostics,
            "rowsText": rows_text,
            "rowsAttrs": rows_attrs,
        })
    }

    pub fn feed(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }

        let normalized = normalize_csi_sequences(bytes, &mut self.last_graphic_char);
        self.scan_protocol_sequences(bytes);

        const START: &[u8] = b"\x1b[?2026h";
        const END: &[u8] = b"\x1b[?2026l";
        let mut i = 0usize;
        let mut balanced_depth: i32 = 0;
        let mut dirty_tail = false;
        while i < normalized.len() {
            let rest = &normalized[i..];
            let start_at = find_subsequence(rest, START);
            let end_at = find_subsequence(rest, END);
            let next = match (start_at, end_at) {
                (None, None) => {
                    if !rest.is_empty() {
                        self.process_parser(rest);
                        dirty_tail = true;
                    }
                    break;
                }
                (Some(start), Some(end)) if end < start => (end, false),
                (Some(start), _) => (start, true),
                (None, Some(end)) => (end, false),
            };
            let (rel, is_start) = next;
            let marker_len = if is_start { START.len() } else { END.len() };
            let abs = i + rel;
            if abs > i {
                self.process_parser(&normalized[i..abs]);
            }
            self.process_parser(&normalized[abs..abs + marker_len]);
            if is_start {
                if balanced_depth > 0 {
                    balanced_depth += 1;
                    dirty_tail = true;
                } else if self.render_held {
                    dirty_tail = true;
                } else {
                    let after = &normalized[abs + marker_len..];
                    if sync_hold_closes_within(after) {
                        balanced_depth = 1;
                        dirty_tail = true;
                    } else {
                        self.open_render_hold();
                        dirty_tail = false;
                    }
                }
            } else if balanced_depth > 0 {
                balanced_depth -= 1;
                if balanced_depth == 0 {
                    self.commit_snapshot();
                    self.render_held = false;
                    self.hold_started_at = None;
                    dirty_tail = false;
                } else {
                    dirty_tail = true;
                }
            } else if self.render_held {
                self.close_render_hold();
                dirty_tail = false;
            } else {
                dirty_tail = true;
            }
            i = abs + marker_len;
        }
        if dirty_tail || self.render_held {
            self.dirty = true;
        }
    }

    pub fn get_snapshot_diff(
        &mut self,
        since_seq: u64,
        exited: bool,
        exit_code: Option<i64>,
    ) -> TerminalSnapshotPollResponse {
        if self.render_held {
            let elapsed = self.hold_started_at.map(|started| started.elapsed());
            let timed_out = elapsed.is_some_and(|elapsed| elapsed >= MAX_DEC2026_HOLD);
            let release = timed_out || exited || self.hold_started_at.is_none();
            if release {
                if timed_out {
                    let held_ms = elapsed.map(|elapsed| elapsed.as_millis() as u64).unwrap_or(0);
                    self.diagnostics.dec2026_timeouts_total =
                        self.diagnostics.dec2026_timeouts_total.saturating_add(1);
                    self.diagnostics.last_hold_duration_ms = held_ms;
                    self.pending_timeouts.push(Dec2026TimeoutNotice {
                        held_ms,
                        seq: self.seq,
                    });
                }
                self.render_held = false;
                self.hold_started_at = None;
                self.dirty = true;
            } else if since_seq == self.seq {
                return TerminalSnapshotPollResponse::Unchanged {
                    seq: self.seq,
                    exited,
                    exit_code,
                };
            } else {
                let mut snapshot = self.frozen_clean_snapshot();
                snapshot.clipboard_write = self.pending_clipboard.take();
                return TerminalSnapshotPollResponse::Snapshot {
                    snapshot,
                    exited,
                    exit_code,
                };
            }
        }

        if !self.dirty && since_seq == self.seq && since_seq != 0 {
            return TerminalSnapshotPollResponse::Unchanged {
                seq: self.seq,
                exited,
                exit_code,
            };
        }

        if !self.dirty {
            if let Some(mut snapshot) = self.committed_snapshot.clone() {
                snapshot.clipboard_write = self.pending_clipboard.take();
                return TerminalSnapshotPollResponse::Snapshot {
                    snapshot,
                    exited,
                    exit_code,
                };
            }
        }

        let screen = self.parser.screen();
        let (cursor_row, cursor_col) = screen.cursor_position();
        let scrollback_offset = screen.scrollback() as u32;
        let cursor_visible = !screen.hide_cursor() && scrollback_offset == 0;
        let alternate_screen = screen.alternate_screen();
        let application_cursor = screen.application_cursor();
        let bracketed_paste = screen.bracketed_paste();
        let mouse_mode = self.effective_mouse_mode();
        let mouse_tracking = mouse_mode != "none";
        let sgr_mouse = self.effective_sgr_mouse();
        let sgr_pixels_mouse = self.sgr_pixels_mouse;
        let focus_reporting = self.focus_reporting;
        let win32_input_mode = self.win32_input_mode;
        let kitty_keyboard_flags = self.kitty_keyboard_flags();

        let current_cursor = CursorSnapshot {
            visible: cursor_visible,
            col: cursor_col.min(self.cols.saturating_sub(1)),
            row: cursor_row.min(self.rows.saturating_sub(1)),
            shape: self.cursor_shape.clone(),
            // Blink is a renderer preference, not a VT grid fact.
            blink: false,
        };

        // A delta is against the last frame this engine published. If the
        // client is still on an older seq, that delta would patch the wrong
        // screen and leave one or two rows from the missed frame behind.
        let missed_frame = since_seq != 0 && since_seq < self.seq;
        let force_full = since_seq == 0
            || missed_frame
            || self.client_rows.len() != self.rows as usize
            || self.client_rows.first().map_or(0, |r| r.len()) != self.cols as usize;

        let mut current_matrix: Vec<Vec<CellSnapshot>> = Vec::with_capacity(self.rows as usize);
        let mut dirty_rows: Vec<RowSnapshot> = Vec::new();

        for r in 0..self.rows {
            let mut row_cells: Vec<CellSnapshot> = Vec::with_capacity(self.cols as usize);
            let mut prev_wide_bg: ([u8; 3], bool) = (DEFAULT_BG, false);

            for c in 0..self.cols {
                if let Some(cell) = screen.cell(r, c) {
                    if cell.is_wide_continuation() {
                        row_cells.push(CellSnapshot {
                            ch: String::new(),
                            width: 0,
                            fg: DEFAULT_FG,
                            bg: prev_wide_bg.0,
                            has_bg: prev_wide_bg.1,
                            bold: false,
                            italic: false,
                            underline: false,
                            inverse: false,
                            dim: false,
                        });
                        continue;
                    }

                    let bold = cell.bold();
                    let inverse = cell.inverse();
                    let (raw_fg, _) = ansi_color_to_rgb(cell.fgcolor(), false, bold);
                    let (raw_bg, has_bg) = ansi_color_to_rgb(cell.bgcolor(), true, false);
                    let ch = cell.contents();
                    let ch_str = if ch.is_empty() {
                        " ".to_string()
                    } else {
                        ch
                    };

                    let effective_bg = if inverse {
                        raw_fg
                    } else if has_bg {
                        raw_bg
                    } else {
                        DEFAULT_BG
                    };
                    let effective_fg = if inverse {
                        if has_bg {
                            raw_bg
                        } else {
                            DEFAULT_BG
                        }
                    } else {
                        ensure_readable_fg(raw_fg, effective_bg, &ch_str)
                    };

                    let width = if cell.is_wide() { 2 } else { 1 };
                    let effective_has_bg = has_bg || inverse;
                    if width == 2 {
                        prev_wide_bg = (effective_bg, effective_has_bg);
                    }

                    row_cells.push(CellSnapshot {
                        ch: ch_str,
                        width,
                        fg: effective_fg,
                        bg: effective_bg,
                        has_bg: effective_has_bg,
                        bold,
                        italic: cell.italic(),
                        underline: cell.underline(),
                        inverse: false,
                        dim: false,
                    });
                } else {
                    row_cells.push(CellSnapshot {
                        ch: " ".to_string(),
                        width: 1,
                        fg: DEFAULT_FG,
                        bg: DEFAULT_BG,
                        has_bg: false,
                        bold: false,
                        italic: false,
                        underline: false,
                        inverse: false,
                        dim: false,
                    });
                }
            }

            let is_dirty = force_full
                || self.client_rows.len() <= r as usize
                || self.client_rows[r as usize] != row_cells;

            if is_dirty {
                dirty_rows.push(RowSnapshot {
                    row_idx: r,
                    cells: row_cells.clone(),
                    wrapped: screen.row_wrapped(r),
                });
            }

            current_matrix.push(row_cells);
        }

        if since_seq != 0
            && dirty_rows.is_empty()
            && current_cursor == self.last_cursor
            && self.pending_clipboard.is_none()
            && self.current_title == self.last_title
        {
            self.dirty = false;
            return TerminalSnapshotPollResponse::Unchanged {
                seq: self.seq,
                exited,
                exit_code,
            };
        }

        self.seq += 1;
        self.client_rows = current_matrix;
        self.last_cursor = current_cursor.clone();
        self.last_title = self.current_title.clone();
        self.dirty = false;

        let full_rows: Vec<RowSnapshot> = self
            .client_rows
            .iter()
            .enumerate()
            .map(|(idx, cells)| RowSnapshot {
                row_idx: idx as u16,
                cells: cells.clone(),
                wrapped: screen.row_wrapped(idx as u16),
            })
            .collect();
        self.committed_snapshot = Some(RenderSnapshot {
            seq: self.seq,
            cols: self.cols,
            rows: self.rows,
            alternate_screen,
            application_cursor,
            bracketed_paste,
            mouse_tracking,
            mouse_mode: mouse_mode.clone(),
            sgr_mouse,
            sgr_pixels_mouse,
            focus_reporting,
            win32_input_mode,
            kitty_keyboard_flags,
            scrollback_offset,
            cursor: current_cursor.clone(),
            dirty_rows: full_rows,
            full: true,
            title: self.current_title.clone(),
            clipboard_write: None,
        });

        let snapshot = RenderSnapshot {
            seq: self.seq,
            cols: self.cols,
            rows: self.rows,
            alternate_screen,
            application_cursor,
            bracketed_paste,
            mouse_tracking,
            mouse_mode,
            sgr_mouse,
            sgr_pixels_mouse,
            focus_reporting,
            win32_input_mode,
            kitty_keyboard_flags,
            scrollback_offset,
            cursor: current_cursor,
            dirty_rows,
            full: force_full,
            title: self.current_title.clone(),
            clipboard_write: self.pending_clipboard.take(),
        };

        TerminalSnapshotPollResponse::Snapshot {
            snapshot,
            exited,
            exit_code,
        }
    }
}

pub const SNAPSHOT_BIN_HEADER_LEN: usize = 32;
pub const MODE_FLAG_APPLICATION_CURSOR: u8 = 0x40;
pub const MODE_FLAG_EXTENDED_META: u8 = 0x80;

#[repr(C, packed)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BinaryCellRecord {
    pub codepoint_or_span: u32,
    pub fg_rgba: u32,
    pub bg_rgba: u32,
    pub width: u8,
    pub attrs: u8,
    pub extra: u16,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExtendedSnapshotMeta {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clipboard_write: Option<String>,
    pub mouse_mode: String,
    pub sgr_mouse: bool,
    pub sgr_pixels_mouse: bool,
    pub focus_reporting: bool,
    pub win32_input_mode: bool,
    pub kitty_keyboard_flags: u8,
    pub scrollback_offset: u32,
    #[serde(default)]
    pub scrollback_depth: u32,
    #[serde(default)]
    pub benchmark_active: bool,
    /// Base64 of the PTY bytes this poll drained, mirroring the JSON
    /// `observedBytesBase64` field so both transports feed agent output capture.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed_bytes_base64: Option<String>,
}

/// Reads the 64-bit monotonic sequence number from a `SNAPSHOT_BIN` payload header.
pub fn snapshot_bin_seq(bytes: &[u8]) -> Option<u64> {
    if bytes.len() < 8 {
        return None;
    }
    let arr: [u8; 8] = bytes[0..8].try_into().ok()?;
    Some(u64::from_le_bytes(arr))
}

/// Serializes a `RenderSnapshot` into the packed `SNAPSHOT_BIN` binary wire format:
/// - 32-byte little-endian header (`cursor_flags` bit 1 = blink)
/// - 4-byte dirty row descriptors (`[u16 row_idx][u16 cell_count]`, `cell_count`
///   bit 15 = row soft-wrapped)
/// - 16-byte `BinaryCellRecord` entries
/// - trailing UTF-8 table (`overflow_utf8_len` bytes) for multi-codepoint graphemes
/// - trailing UTF-8 JSON `ExtendedSnapshotMeta` tail (flagged by `mode_flags` bit 7 `0x80`),
///   including `observedBytesBase64` when the poll drained PTY bytes
pub fn serialize_render_snapshot_bin(
    snapshot: &RenderSnapshot,
    exited: bool,
    exit_code: Option<i64>,
    sync_output: bool,
    benchmark_active: bool,
    observed_bytes_base64: Option<String>,
) -> Vec<u8> {
    let dirty_row_count = snapshot.dirty_rows.len().min(u16::MAX as usize) as u16;
    let total_cells: usize = snapshot
        .dirty_rows
        .iter()
        .take(dirty_row_count as usize)
        .map(|r| r.cells.len())
        .sum();

    let mut overflow_utf8: Vec<u8> = Vec::new();
    let mut cell_bytes: Vec<u8> = Vec::with_capacity(total_cells * 16);

    for row in snapshot.dirty_rows.iter().take(dirty_row_count as usize) {
        for cell in &row.cells {
            let mut attrs: u8 = 0;
            if cell.bold {
                attrs |= 0x01;
            }
            if cell.dim {
                attrs |= 0x02;
            }
            if cell.italic {
                attrs |= 0x04;
            }
            if cell.underline {
                attrs |= 0x08;
            }
            if cell.inverse {
                attrs |= 0x10;
            }

            let codepoint_or_span: u32 = if cell.ch.is_empty() {
                0
            } else {
                let mut chars = cell.ch.chars();
                let first = chars.next().unwrap_or('\0');
                if chars.next().is_none() {
                    first as u32
                } else {
                    let utf8 = cell.ch.as_bytes();
                    let offset = overflow_utf8.len();
                    let len = utf8.len().min(255);
                    if offset <= 0x00ff_ffff {
                        attrs |= 0x80;
                        overflow_utf8.extend_from_slice(&utf8[..len]);
                        ((offset as u32) & 0x00ff_ffff) | ((len as u32) << 24)
                    } else {
                        first as u32
                    }
                }
            };

            let fg_alpha: u8 = if cell.fg == DEFAULT_FG { 0x00 } else { 0xff };
            let fg_rgba: u32 = ((cell.fg[0] as u32) << 24)
                | ((cell.fg[1] as u32) << 16)
                | ((cell.fg[2] as u32) << 8)
                | (fg_alpha as u32);

            let bg_alpha: u8 = if cell.has_bg { 0xff } else { 0x00 };
            let bg_rgba: u32 = ((cell.bg[0] as u32) << 24)
                | ((cell.bg[1] as u32) << 16)
                | ((cell.bg[2] as u32) << 8)
                | (bg_alpha as u32);

            cell_bytes.extend_from_slice(&codepoint_or_span.to_le_bytes());
            cell_bytes.extend_from_slice(&fg_rgba.to_le_bytes());
            cell_bytes.extend_from_slice(&bg_rgba.to_le_bytes());
            cell_bytes.push(cell.width);
            cell_bytes.push(attrs);
            cell_bytes.extend_from_slice(&0u16.to_le_bytes());
        }
    }

    let shape_code: u8 = match snapshot.cursor.shape.as_str() {
        "underline" => 1,
        "bar" => 2,
        _ => 0,
    };
    let mut cursor_flags: u8 = (shape_code & 0x07) << 2;
    if snapshot.cursor.visible {
        cursor_flags |= 0x01;
    }
    if snapshot.cursor.blink {
        cursor_flags |= 0x02;
    }

    let meta = ExtendedSnapshotMeta {
        title: snapshot.title.clone(),
        clipboard_write: snapshot.clipboard_write.clone(),
        mouse_mode: snapshot.mouse_mode.clone(),
        sgr_mouse: snapshot.sgr_mouse,
        sgr_pixels_mouse: snapshot.sgr_pixels_mouse,
        focus_reporting: snapshot.focus_reporting,
        win32_input_mode: snapshot.win32_input_mode,
        kitty_keyboard_flags: snapshot.kitty_keyboard_flags,
        scrollback_offset: snapshot.scrollback_offset,
        scrollback_depth: 0,
        benchmark_active,
        observed_bytes_base64,
    };
    let meta_bytes = serde_json::to_vec(&meta).unwrap_or_default();

    let mut mode_flags: u8 = 0;
    if snapshot.full {
        mode_flags |= 0x01;
    }
    if snapshot.alternate_screen {
        mode_flags |= 0x02;
    }
    if snapshot.mouse_tracking {
        mode_flags |= 0x04;
    }
    if snapshot.bracketed_paste {
        mode_flags |= 0x08;
    }
    if sync_output {
        mode_flags |= 0x10;
    }
    if exited {
        mode_flags |= 0x20;
    }
    if snapshot.application_cursor {
        mode_flags |= MODE_FLAG_APPLICATION_CURSOR;
    }
    if !meta_bytes.is_empty() {
        mode_flags |= MODE_FLAG_EXTENDED_META;
    }

    let overflow_utf8_len = overflow_utf8.len() as u32;
    let raw_exit_code: i32 = exit_code.unwrap_or(0) as i32;

    let total_len = SNAPSHOT_BIN_HEADER_LEN
        + (dirty_row_count as usize) * 4
        + cell_bytes.len()
        + overflow_utf8.len()
        + meta_bytes.len();
    let mut out = Vec::with_capacity(total_len);

    // 32-byte header (Little-Endian)
    out.extend_from_slice(&snapshot.seq.to_le_bytes());
    out.extend_from_slice(&snapshot.cols.to_le_bytes());
    out.extend_from_slice(&snapshot.rows.to_le_bytes());
    out.extend_from_slice(&snapshot.cursor.col.to_le_bytes());
    out.extend_from_slice(&snapshot.cursor.row.to_le_bytes());
    out.push(cursor_flags);
    out.push(mode_flags);
    out.extend_from_slice(&dirty_row_count.to_le_bytes());
    out.extend_from_slice(&(total_cells as u32).to_le_bytes());
    out.extend_from_slice(&overflow_utf8_len.to_le_bytes());
    out.extend_from_slice(&raw_exit_code.to_le_bytes());

    // Dirty row index table
    for row in snapshot.dirty_rows.iter().take(dirty_row_count as usize) {
        let count = (row.cells.len().min(0x7fff)) as u16;
        let count_with_flags = if row.wrapped { count | 0x8000 } else { count };
        out.extend_from_slice(&row.row_idx.to_le_bytes());
        out.extend_from_slice(&count_with_flags.to_le_bytes());
    }

    // Packed cells + overflow UTF-8 + extended metadata JSON tail
    out.extend_from_slice(&cell_bytes);
    out.extend_from_slice(&overflow_utf8);
    out.extend_from_slice(&meta_bytes);
    out
}

/// Decodes a `SNAPSHOT_BIN` payload back into `(RenderSnapshot, exited, exit_code, sync_output)`.
pub fn decode_render_snapshot_bin(
    bytes: &[u8],
) -> Result<(RenderSnapshot, bool, Option<i64>, bool), String> {
    if bytes.len() < SNAPSHOT_BIN_HEADER_LEN {
        return Err(format!(
            "Binary snapshot payload too small: {} < {}",
            bytes.len(),
            SNAPSHOT_BIN_HEADER_LEN
        ));
    }

    let seq = u64::from_le_bytes(bytes[0..8].try_into().unwrap());
    let cols = u16::from_le_bytes(bytes[8..10].try_into().unwrap());
    let rows = u16::from_le_bytes(bytes[10..12].try_into().unwrap());
    let cursor_col = u16::from_le_bytes(bytes[12..14].try_into().unwrap());
    let cursor_row = u16::from_le_bytes(bytes[14..16].try_into().unwrap());
    let cursor_flags = bytes[16];
    let mode_flags = bytes[17];
    let dirty_row_count = u16::from_le_bytes(bytes[18..20].try_into().unwrap()) as usize;
    let total_cells = u32::from_le_bytes(bytes[20..24].try_into().unwrap()) as usize;
    let overflow_utf8_len = u32::from_le_bytes(bytes[24..28].try_into().unwrap()) as usize;
    let raw_exit_code = i32::from_le_bytes(bytes[28..32].try_into().unwrap());

    let dirty_rows_end = SNAPSHOT_BIN_HEADER_LEN + dirty_row_count * 4;
    let cells_end = dirty_rows_end + total_cells * 16;
    let overflow_end = cells_end + overflow_utf8_len;

    if bytes.len() < overflow_end {
        return Err(format!(
            "Binary snapshot truncated: expected at least {} bytes, got {}",
            overflow_end,
            bytes.len()
        ));
    }

    let overflow_slice = &bytes[cells_end..overflow_end];
    let mut dirty_rows = Vec::with_capacity(dirty_row_count);
    let mut cell_offset = dirty_rows_end;

    for r in 0..dirty_row_count {
        let entry_offset = SNAPSHOT_BIN_HEADER_LEN + r * 4;
        let row_idx = u16::from_le_bytes(bytes[entry_offset..entry_offset + 2].try_into().unwrap());
        let raw_count =
            u16::from_le_bytes(bytes[entry_offset + 2..entry_offset + 4].try_into().unwrap());
        let count = (raw_count & 0x7fff) as usize;
        let wrapped = (raw_count & 0x8000) != 0;
        let mut cells = Vec::with_capacity(count);

        for _ in 0..count {
            if cell_offset + 16 > cells_end {
                return Err("Cell table overflow in binary snapshot".to_string());
            }
            let codepoint_or_span =
                u32::from_le_bytes(bytes[cell_offset..cell_offset + 4].try_into().unwrap());
            let fg_rgba =
                u32::from_le_bytes(bytes[cell_offset + 4..cell_offset + 8].try_into().unwrap());
            let bg_rgba =
                u32::from_le_bytes(bytes[cell_offset + 8..cell_offset + 12].try_into().unwrap());
            let width = bytes[cell_offset + 12];
            let attrs = bytes[cell_offset + 13];
            cell_offset += 16;

            let ch = if (attrs & 0x80) != 0 {
                let offset = (codepoint_or_span & 0x00ff_ffff) as usize;
                let len = ((codepoint_or_span >> 24) & 0xff) as usize;
                if offset + len <= overflow_slice.len() {
                    String::from_utf8_lossy(&overflow_slice[offset..offset + len]).into_owned()
                } else {
                    " ".to_string()
                }
            } else if codepoint_or_span == 0 {
                String::new()
            } else {
                char::from_u32(codepoint_or_span)
                    .map(|c| c.to_string())
                    .unwrap_or_else(|| " ".to_string())
            };

            let fg = if (fg_rgba & 0xff) == 0 {
                DEFAULT_FG
            } else {
                [
                    ((fg_rgba >> 24) & 0xff) as u8,
                    ((fg_rgba >> 16) & 0xff) as u8,
                    ((fg_rgba >> 8) & 0xff) as u8,
                ]
            };

            let has_bg = (bg_rgba & 0xff) != 0;
            let bg = if !has_bg {
                DEFAULT_BG
            } else {
                [
                    ((bg_rgba >> 24) & 0xff) as u8,
                    ((bg_rgba >> 16) & 0xff) as u8,
                    ((bg_rgba >> 8) & 0xff) as u8,
                ]
            };

            cells.push(CellSnapshot {
                ch,
                width,
                fg,
                bg,
                has_bg,
                bold: (attrs & 0x01) != 0,
                dim: (attrs & 0x02) != 0,
                italic: (attrs & 0x04) != 0,
                underline: (attrs & 0x08) != 0,
                inverse: (attrs & 0x10) != 0,
            });
        }

        dirty_rows.push(RowSnapshot { row_idx, cells, wrapped });
    }

    let cursor_visible = (cursor_flags & 0x01) != 0;
    let cursor_blink = (cursor_flags & 0x02) != 0;
    let cursor_shape = match (cursor_flags >> 2) & 0x07 {
        1 => "underline".to_string(),
        2 => "bar".to_string(),
        _ => "block".to_string(),
    };

    let full = (mode_flags & 0x01) != 0;
    let alternate_screen = (mode_flags & 0x02) != 0;
    let mouse_tracking = (mode_flags & 0x04) != 0;
    let bracketed_paste = (mode_flags & 0x08) != 0;
    let sync_output = (mode_flags & 0x10) != 0;
    let exited = (mode_flags & 0x20) != 0;
    let application_cursor = (mode_flags & MODE_FLAG_APPLICATION_CURSOR) != 0;
    let exit_code = if exited {
        Some(raw_exit_code as i64)
    } else {
        None
    };

    let meta: Option<ExtendedSnapshotMeta> =
        if (mode_flags & MODE_FLAG_EXTENDED_META) != 0 && bytes.len() > overflow_end {
            serde_json::from_slice(&bytes[overflow_end..]).ok()
        } else {
            None
        };

    let snapshot = RenderSnapshot {
        seq,
        cols,
        rows,
        alternate_screen,
        application_cursor,
        bracketed_paste,
        mouse_tracking,
        mouse_mode: meta
            .as_ref()
            .map(|m| m.mouse_mode.clone())
            .unwrap_or_else(|| {
                if mouse_tracking {
                    "click".to_string()
                } else {
                    "none".to_string()
                }
            }),
        sgr_mouse: meta.as_ref().map(|m| m.sgr_mouse).unwrap_or(false),
        sgr_pixels_mouse: meta.as_ref().map(|m| m.sgr_pixels_mouse).unwrap_or(false),
        focus_reporting: meta.as_ref().map(|m| m.focus_reporting).unwrap_or(false),
        win32_input_mode: meta.as_ref().map(|m| m.win32_input_mode).unwrap_or(false),
        kitty_keyboard_flags: meta.as_ref().map(|m| m.kitty_keyboard_flags).unwrap_or(0),
        scrollback_offset: meta.as_ref().map(|m| m.scrollback_offset).unwrap_or(0),
        cursor: CursorSnapshot {
            visible: cursor_visible,
            col: cursor_col,
            row: cursor_row,
            shape: cursor_shape,
            blink: cursor_blink,
        },
        dirty_rows,
        full,
        title: meta.as_ref().and_then(|m| m.title.clone()),
        clipboard_write: meta.as_ref().and_then(|m| m.clipboard_write.clone()),
    };

    Ok((snapshot, exited, exit_code, sync_output))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_intermediate_dirty_rows_across_multi_step_feeds() {
        let mut engine = TerminalVtEngine::new(40, 10);
        engine.feed(b"Row 0 text\r\n");
        let first = match engine.get_snapshot_diff(0, false, None) {
            TerminalSnapshotPollResponse::Snapshot { snapshot, .. } => snapshot,
            _ => panic!("expected snapshot"),
        };
        assert_eq!(first.seq, 1);
        assert!(first.full);

        engine.feed(b"Row 1 text\r\n");
        engine.feed(b"Row 2 text\r\n");

        let second = match engine.get_snapshot_diff(first.seq, false, None) {
            TerminalSnapshotPollResponse::Snapshot { snapshot, .. } => snapshot,
            _ => panic!("expected snapshot"),
        };
        assert!(!second.full);
        let dirty_row_indices: Vec<u16> = second.dirty_rows.iter().map(|r| r.row_idx).collect();
        assert!(dirty_row_indices.contains(&1));
        assert!(dirty_row_indices.contains(&2));
        let row1: String = second
            .dirty_rows
            .iter()
            .find(|r| r.row_idx == 1)
            .unwrap()
            .cells
            .iter()
            .map(|c| c.ch.as_str())
            .collect();
        let row2: String = second
            .dirty_rows
            .iter()
            .find(|r| r.row_idx == 2)
            .unwrap()
            .cells
            .iter()
            .map(|c| c.ch.as_str())
            .collect();
        assert!(row1.starts_with("Row 1 text"));
        assert!(row2.starts_with("Row 2 text"));
    }

    #[test]
    fn resolves_inverse_cells_once_with_readable_contrast() {
        let mut engine = TerminalVtEngine::new(20, 4);
        engine.feed(b"\x1b[7mStatus\x1b[0m");
        let snap = match engine.get_snapshot_diff(0, false, None) {
            TerminalSnapshotPollResponse::Snapshot { snapshot, .. } => snapshot,
            _ => panic!("expected snapshot"),
        };
        let c0 = &snap.dirty_rows[0].cells[0];
        assert!(c0.has_bg);
        assert_eq!(c0.bg, DEFAULT_FG);
        assert_eq!(c0.fg, DEFAULT_BG);
        assert!(!c0.inverse);
    }

    #[test]
    fn marks_wide_character_continuation_cells_as_zero_width() {
        let mut engine = TerminalVtEngine::new(20, 4);
        engine.feed("🚀A".as_bytes());
        let snap = match engine.get_snapshot_diff(0, false, None) {
            TerminalSnapshotPollResponse::Snapshot { snapshot, .. } => snapshot,
            _ => panic!("expected snapshot"),
        };
        let row = &snap.dirty_rows[0].cells;
        assert_eq!(row[0].width, 2);
        assert_eq!(row[1].width, 0);
        assert_eq!(row[1].ch, "");
        assert_eq!(row[2].ch, "A");
    }

    #[test]
    fn answers_osc11_decrqm_and_cpr_queries_and_tracks_modes() {
        let mut engine = TerminalVtEngine::new(80, 24);
        engine.feed(b"\x1b[?1003;1006h\x1b[?9001h\x1b[>1u\x1b]11;?\x07\x1b[?2026$p\x1b[6n\x1b]52;c;SGVsbG8=\x07");
        let replies = String::from_utf8(engine.take_replies()).unwrap();
        assert!(replies.contains("\x1b]11;rgb:0a0a/0a0a/0a0a\x1b\\"));
        assert!(replies.contains("\x1b[?2026;2$y"));
        assert!(replies.contains("\x1b[1;1R"));

        let snap = match engine.get_snapshot_diff(0, false, None) {
            TerminalSnapshotPollResponse::Snapshot { snapshot, .. } => snapshot,
            _ => panic!("expected snapshot"),
        };
        assert_eq!(snap.mouse_mode, "any");
        assert!(snap.sgr_mouse);
        assert!(snap.win32_input_mode);
        assert_eq!(snap.kitty_keyboard_flags, 1);
        assert_eq!(snap.clipboard_write.as_deref(), Some("Hello"));
    }

    #[test]
    fn strips_spinner_prefix_from_shown_title() {
        assert_eq!(shown_title("⠋ Building project"), "Building project");
        assert_eq!(shown_title("✳ Fixing tests"), "Fixing tests");
        assert_eq!(shown_title("✓ Build passed"), "✓ Build passed");
    }

    #[test]
    fn does_not_panic_when_scrollback_offset_exceeds_screen_rows() {
        let mut engine = TerminalVtEngine::new(40, 10);
        for i in 0..60 {
            engine.feed(format!("Line number {i}\r\n").as_bytes());
        }
        // Scroll up 1 line, then feed 30 more lines so vt100 auto-increments scrollback_offset > rows (10)
        engine.scroll_viewport(1);
        for i in 60..90 {
            engine.feed(format!("Line number {i}\r\n").as_bytes());
        }
        let snap1 = engine.get_snapshot_diff(0, false, None);
        assert!(matches!(snap1, TerminalSnapshotPollResponse::Snapshot { .. }));

        // Scroll up 45 lines explicitly (far exceeding 10 rows)
        engine.scroll_viewport(45);
        let snap2 = engine.get_snapshot_diff(0, false, None);
        assert!(matches!(snap2, TerminalSnapshotPollResponse::Snapshot { .. }));

        // Shrink terminal rows while scrolled back
        engine.resize(25, 5);
        let snap3 = engine.get_snapshot_diff(0, false, None);
        assert!(matches!(snap3, TerminalSnapshotPollResponse::Snapshot { .. }));
    }

    fn row_text(snapshot: &RenderSnapshot, row: u16) -> String {
        snapshot
            .dirty_rows
            .iter()
            .find(|entry| entry.row_idx == row)
            .map(|entry| {
                entry
                    .cells
                    .iter()
                    .map(|cell| if cell.width == 0 { "" } else { cell.ch.as_str() })
                    .collect::<String>()
            })
            .unwrap_or_default()
    }

    #[test]
    fn dec2026_hold_returns_pre_hold_clean_snapshot_not_partial_frame() {
        let mut engine = TerminalVtEngine::new(20, 4);
        engine.feed(b"HELLO");
        let clean = match engine.get_snapshot_diff(0, false, None) {
            TerminalSnapshotPollResponse::Snapshot { snapshot, .. } => snapshot,
            TerminalSnapshotPollResponse::Unchanged { .. } => panic!("expected clean snapshot"),
        };
        assert!(row_text(&clean, 0).starts_with("HELLO"));

        engine.feed(b"\x1b[?2026h\x1b[1;1HXXXX");
        let during = match engine.get_snapshot_diff(0, false, None) {
            TerminalSnapshotPollResponse::Snapshot { snapshot, .. } => snapshot,
            TerminalSnapshotPollResponse::Unchanged { .. } => panic!("expected frozen snapshot"),
        };
        let text = row_text(&during, 0);
        assert!(text.starts_with("HELLO"), "frozen frame was {text}");
        assert!(!text.contains('X'), "partial frame leaked: {text}");
    }

    #[test]
    fn rep_csi_5_b_repeats_preceding_graphic_five_additional_times() {
        let mut engine = TerminalVtEngine::new(20, 3);
        engine.feed(b"A\x1b[5b");
        let snapshot = match engine.get_snapshot_diff(0, false, None) {
            TerminalSnapshotPollResponse::Snapshot { snapshot, .. } => snapshot,
            TerminalSnapshotPollResponse::Unchanged { .. } => panic!("expected snapshot"),
        };
        let text = row_text(&snapshot, 0);
        assert!(
            text.starts_with("AAAAAA"),
            "ECMA-48 REP repeats the preceding graphic count additional times, got {text}"
        );
    }

    #[test]
    fn vs16_widens_narrow_symbol_to_two_cells_preventing_conpty_autowrap_shift() {
        // Reproduces the exact 28-column toast overwrite from the OpenCode ConPTY stream:
        // seq=4 writes a 28-col line ending with ┃ at column 28;
        // seq=5 overwrites it with "⚠️ gentle-ai-verify returned" (2 + 26 = 28 cells).
        let mut engine = TerminalVtEngine::new(34, 4);
        engine.feed("    ┃Warning                       ┃".as_bytes());
        engine.feed("\x1b[1;5H\u{26a0}\u{fe0f} gentle-ai-verify returned".as_bytes());
        let snapshot = match engine.get_snapshot_diff(0, false, None) {
            TerminalSnapshotPollResponse::Snapshot { snapshot, .. } => snapshot,
            TerminalSnapshotPollResponse::Unchanged { .. } => panic!("expected snapshot"),
        };
        let row0 = row_text(&snapshot, 0);
        assert!(
            !row0.contains("returned┃"),
            "VS16 emoji must occupy 2 cells and overwrite the right toast border, got {row0:?}"
        );
        assert!(
            row0.starts_with("    \u{26a0}\u{fe0f} gentle-ai-verify returned"),
            "unexpected row0: {row0:?}"
        );
    }

    #[test]
    fn missed_sync_frame_poll_returns_the_whole_screen_not_the_tail_row() {
        let mut engine = TerminalVtEngine::new(20, 4);
        engine.feed(b"HELLO\r\n");
        let first = match engine.get_snapshot_diff(0, false, None) {
            TerminalSnapshotPollResponse::Snapshot { snapshot, .. } => snapshot,
            TerminalSnapshotPollResponse::Unchanged { .. } => panic!("expected first snapshot"),
        };

        // The synced block publishes a frame inside the engine. The tail after
        // the closer is a later dirty row. The client is still on first.seq.
        engine.feed(b"\x1b[?2026h\x1b[1;1HWORLD\x1b[?2026l\x1b[2;1HTAIL");
        let next = match engine.get_snapshot_diff(first.seq, false, None) {
            TerminalSnapshotPollResponse::Snapshot { snapshot, .. } => snapshot,
            TerminalSnapshotPollResponse::Unchanged { .. } => panic!("expected a snapshot"),
        };

        assert!(
            next.full,
            "a client that missed the synced frame must not receive a one-row delta"
        );
        assert!(
            row_text(&next, 0).contains("WORLD"),
            "row 0 was {}",
            row_text(&next, 0)
        );
        assert!(
            row_text(&next, 1).contains("TAIL"),
            "row 1 was {}",
            row_text(&next, 1)
        );
    }

    #[test]
    fn binary_snapshot_round_trips_full_metadata_and_graphemes_with_exact_parity() {
        let mut engine = TerminalVtEngine::new(24, 4);
        engine.feed(
            "\x1b[?1h\x1b[?1002;1006;1004;2004h\x1b[?9001h\x1b[>3u\x1b]0;Agent Title\x07\x1b]52;c;SGVsbG8=\x07\x1b[1;31m🚀\u{26a0}\u{fe0f}Hi\x1b[0m"
                .as_bytes(),
        );
        let snap = match engine.get_snapshot_diff(0, false, None) {
            TerminalSnapshotPollResponse::Snapshot { snapshot, .. } => snapshot,
            TerminalSnapshotPollResponse::Unchanged { .. } => panic!("expected snapshot"),
        };

        let bytes = serialize_render_snapshot_bin(&snap, true, Some(42), true, true, None);
        assert_eq!(snapshot_bin_seq(&bytes), Some(snap.seq));

        let (decoded, dec_exited, dec_exit_code, dec_sync) =
            decode_render_snapshot_bin(&bytes).expect("decode should succeed");
        assert!(dec_exited);
        assert_eq!(dec_exit_code, Some(42));
        assert!(dec_sync);
        assert_eq!(decoded.seq, snap.seq);
        assert_eq!(decoded.cols, snap.cols);
        assert_eq!(decoded.rows, snap.rows);
        assert_eq!(decoded.application_cursor, snap.application_cursor);
        assert_eq!(decoded.bracketed_paste, snap.bracketed_paste);
        assert_eq!(decoded.mouse_tracking, snap.mouse_tracking);
        assert_eq!(decoded.mouse_mode, snap.mouse_mode);
        assert_eq!(decoded.sgr_mouse, snap.sgr_mouse);
        assert_eq!(decoded.focus_reporting, snap.focus_reporting);
        assert_eq!(decoded.win32_input_mode, snap.win32_input_mode);
        assert_eq!(decoded.kitty_keyboard_flags, snap.kitty_keyboard_flags);
        assert_eq!(decoded.title, snap.title);
        assert_eq!(decoded.clipboard_write, snap.clipboard_write);
        assert_eq!(decoded.cursor, snap.cursor);
        assert_eq!(decoded.dirty_rows, snap.dirty_rows);
    }

    #[test]
    fn binary_snapshot_carries_row_wrap_cursor_blink_and_observed_bytes() {
        let mut engine = TerminalVtEngine::new(16, 3);
        engine.feed(b"WRAP-ROW\r\nSECOND\r\n");
        let mut snap = match engine.get_snapshot_diff(0, false, None) {
            TerminalSnapshotPollResponse::Snapshot { snapshot, .. } => snapshot,
            TerminalSnapshotPollResponse::Unchanged { .. } => panic!("expected snapshot"),
        };
        assert!(
            snap.dirty_rows.len() >= 2,
            "the first poll must publish every row so wrap flags can be asserted"
        );

        snap.cursor.blink = true;
        for (idx, row) in snap.dirty_rows.iter_mut().enumerate() {
            row.wrapped = idx == 0;
        }

        let observed = crate::terminal::to_base64(b"agent rolling output\n");
        let bytes =
            serialize_render_snapshot_bin(&snap, false, None, false, false, Some(observed.clone()));

        assert_eq!(
            bytes[16] & 0x02,
            0x02,
            "cursor blink must map to bit 1 of cursor_flags"
        );
        let first_row_count = u16::from_le_bytes(bytes[34..36].try_into().unwrap());
        let second_row_count = u16::from_le_bytes(bytes[38..40].try_into().unwrap());
        assert_eq!(
            first_row_count & 0x8000,
            0x8000,
            "a wrapped row must set bit 15 of its dirty-row cell_count"
        );
        assert_eq!(
            second_row_count & 0x8000,
            0x0000,
            "a non-wrapped row must clear bit 15 of its dirty-row cell_count"
        );

        let tail = String::from_utf8_lossy(&bytes);
        assert!(
            tail.contains("\"observedBytesBase64\""),
            "the extended metadata tail must carry the observed output bytes"
        );
        assert!(tail.contains(&observed));

        let (decoded, exited, exit_code, sync_output) =
            decode_render_snapshot_bin(&bytes).expect("decode should succeed");
        assert!(!exited);
        assert_eq!(exit_code, None);
        assert!(!sync_output);
        assert!(decoded.cursor.blink);
        assert!(decoded.dirty_rows[0].wrapped);
        assert!(!decoded.dirty_rows[1].wrapped);
        assert_eq!(decoded.cursor, snap.cursor);
        assert_eq!(decoded.dirty_rows, snap.dirty_rows);

        let without_observed =
            serialize_render_snapshot_bin(&snap, false, None, false, false, None);
        assert!(
            !String::from_utf8_lossy(&without_observed).contains("observedBytesBase64"),
            "an empty observed buffer must not emit the key at all"
        );
    }
}
