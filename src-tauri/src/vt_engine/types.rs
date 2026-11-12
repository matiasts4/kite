use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::time::Duration;

pub const MAX_DEC2026_HOLD: Duration = Duration::from_millis(1000);
pub const MAX_UNHANDLED_CSI_SAMPLES: usize = 16;
pub const REP_MAX: usize = 512;

// Kite Dark Terminal Palette (matches TerminalView.tsx theme)
pub const DEFAULT_FG: [u8; 3] = [250, 250, 250]; // #fafafa
pub const DEFAULT_BG: [u8; 3] = [10, 10, 10];    // #0a0a0a

pub const SNAPSHOT_BIN_HEADER_LEN: usize = 32;
pub const MODE_FLAG_APPLICATION_CURSOR: u8 = 0x40;
pub const MODE_FLAG_EXTENDED_META: u8 = 0x80;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RowSnapshot {
    pub row_idx: u16,
    pub cells: Vec<CellSnapshot>,
    /// True when the row continues onto the next visible row (soft wrap).
    #[serde(default)]
    pub wrapped: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CursorSnapshot {
    pub visible: bool,
    pub col: u16,
    pub row: u16,
    pub shape: String,
    #[serde(default)]
    pub blink: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    #[serde(default)]
    pub scrollback_depth: u32,
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

pub fn channel_luminance(v: u8) -> f32 {
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
pub fn relative_luminance(rgb: [u8; 3]) -> f32 {
    0.2126 * channel_luminance(rgb[0])
        + 0.7152 * channel_luminance(rgb[1])
        + 0.0722 * channel_luminance(rgb[2])
}

#[inline]
pub fn contrast_ratio(a: [u8; 3], b: [u8; 3]) -> f32 {
    let la = relative_luminance(a);
    let lb = relative_luminance(b);
    (la.max(lb) + 0.05) / (la.min(lb) + 0.05)
}

#[inline]
pub fn is_graphics_glyph(ch: &str) -> bool {
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
pub fn ensure_readable_fg(fg: [u8; 3], bg: [u8; 3], ch: &str) -> [u8; 3] {
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

pub fn ansi_color_to_rgb(color: vt100::Color, is_bg: bool, bold: bool) -> ([u8; 3], bool) {
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

pub fn indexed_color_to_rgb(idx: u8) -> [u8; 3] {
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

pub fn color_json(color: vt100::Color) -> serde_json::Value {
    match color {
        vt100::Color::Default => serde_json::json!("default"),
        vt100::Color::Idx(index) => serde_json::json!(["index", index]),
        vt100::Color::Rgb(red, green, blue) => serde_json::json!(["rgb", red, green, blue]),
    }
}
