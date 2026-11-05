//! Zero-copy reader for the 32-byte `SNAPSHOT_BIN` header and 16-byte cells.
//!
//! Layout matches `serialize_render_snapshot_bin` in the Phase 1 daemon:
//! header, dirty-row table, packed cells, overflow UTF-8, optional JSON tail.

use serde::{Deserialize, Serialize};

pub const SNAPSHOT_BIN_HEADER_LEN: usize = 32;
pub const CELL_LEN: usize = 16;

pub const MODE_FULL: u8 = 0x01;
pub const MODE_ALTERNATE: u8 = 0x02;
pub const MODE_MOUSE: u8 = 0x04;
pub const MODE_BRACKETED_PASTE: u8 = 0x08;
pub const MODE_SYNC_OUTPUT: u8 = 0x10;
pub const MODE_EXITED: u8 = 0x20;
pub const MODE_APPLICATION_CURSOR: u8 = 0x40;
pub const MODE_EXTENDED_META: u8 = 0x80;

pub const ATTR_BOLD: u8 = 0x01;
pub const ATTR_DIM: u8 = 0x02;
pub const ATTR_ITALIC: u8 = 0x04;
pub const ATTR_UNDERLINE: u8 = 0x08;
pub const ATTR_INVERSE: u8 = 0x10;
pub const ATTR_OVERFLOW: u8 = 0x80;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CursorShape {
    Block,
    Underline,
    Bar,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtendedSnapshotMeta {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub clipboard_write: Option<String>,
    #[serde(default)]
    pub mouse_mode: String,
    #[serde(default)]
    pub sgr_mouse: bool,
    #[serde(default)]
    pub sgr_pixels_mouse: bool,
    #[serde(default)]
    pub focus_reporting: bool,
    #[serde(default)]
    pub win32_input_mode: bool,
    #[serde(default)]
    pub kitty_keyboard_flags: u8,
    #[serde(default)]
    pub scrollback_offset: u32,
    #[serde(default)]
    pub scrollback_depth: u32,
    #[serde(default)]
    pub benchmark_active: bool,
    #[serde(default)]
    pub observed_bytes_base64: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedCell {
    pub codepoint: u32,
    pub grapheme: Option<String>,
    pub width: u8,
    pub fg_rgba: u32,
    pub bg_rgba: u32,
    pub bold: bool,
    pub dim: bool,
    pub italic: bool,
    pub underline: bool,
    pub inverse: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedRow {
    pub row_idx: u16,
    pub wrapped: bool,
    pub cells: Vec<ParsedCell>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedSnapshot {
    pub seq: u64,
    pub cols: u16,
    pub rows: u16,
    pub cursor_col: u16,
    pub cursor_row: u16,
    pub cursor_visible: bool,
    pub cursor_blink: bool,
    pub cursor_shape: CursorShape,
    pub full_frame: bool,
    pub alternate_screen: bool,
    pub mouse_tracking: bool,
    pub bracketed_paste: bool,
    pub application_cursor: bool,
    pub sync_output: bool,
    pub exited: bool,
    pub exit_code: i32,
    pub mode_flags: u8,
    pub dirty_rows: Vec<ParsedRow>,
    pub meta: ExtendedSnapshotMeta,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotError(pub String);

impl std::fmt::Display for SnapshotError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for SnapshotError {}

pub fn parse_snapshot_bin(bytes: &[u8]) -> Result<ParsedSnapshot, SnapshotError> {
    if bytes.len() < SNAPSHOT_BIN_HEADER_LEN {
        return Err(SnapshotError(format!(
            "binary snapshot payload too small: {} < {SNAPSHOT_BIN_HEADER_LEN}",
            bytes.len()
        )));
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
    let overflow_len = u32::from_le_bytes(bytes[24..28].try_into().unwrap()) as usize;
    let exit_code = i32::from_le_bytes(bytes[28..32].try_into().unwrap());

    let dirty_rows_end = SNAPSHOT_BIN_HEADER_LEN + dirty_row_count * 4;
    let cells_end = dirty_rows_end + total_cells * CELL_LEN;
    let overflow_end = cells_end + overflow_len;
    if bytes.len() < overflow_end {
        return Err(SnapshotError(format!(
            "binary snapshot truncated: expected at least {overflow_end} bytes, got {}",
            bytes.len()
        )));
    }
    let overflow = &bytes[cells_end..overflow_end];
    let mut dirty_rows = Vec::with_capacity(dirty_row_count);
    let mut cell_offset = dirty_rows_end;

    for index in 0..dirty_row_count {
        let entry = SNAPSHOT_BIN_HEADER_LEN + index * 4;
        let row_idx = u16::from_le_bytes(bytes[entry..entry + 2].try_into().unwrap());
        let raw_count = u16::from_le_bytes(bytes[entry + 2..entry + 4].try_into().unwrap());
        let count = (raw_count & 0x7fff) as usize;
        let wrapped = (raw_count & 0x8000) != 0;
        let mut cells = Vec::with_capacity(count);
        for _ in 0..count {
            if cell_offset + CELL_LEN > cells_end {
                return Err(SnapshotError("cell table overflow".into()));
            }
            let packed = u32::from_le_bytes(bytes[cell_offset..cell_offset + 4].try_into().unwrap());
            let fg_rgba = u32::from_le_bytes(bytes[cell_offset + 4..cell_offset + 8].try_into().unwrap());
            let bg_rgba = u32::from_le_bytes(bytes[cell_offset + 8..cell_offset + 12].try_into().unwrap());
            let width = bytes[cell_offset + 12];
            let attrs = bytes[cell_offset + 13];
            cell_offset += CELL_LEN;

            let (codepoint, grapheme) = if (attrs & ATTR_OVERFLOW) != 0 {
                let offset = (packed & 0x00ff_ffff) as usize;
                let len = ((packed >> 24) & 0xff) as usize;
                if offset + len <= overflow.len() {
                    let text = String::from_utf8_lossy(&overflow[offset..offset + len]).into_owned();
                    let first = text.chars().next().map(|ch| ch as u32).unwrap_or(0);
                    (first, Some(text))
                } else {
                    (0x20, Some(" ".to_string()))
                }
            } else {
                (packed, None)
            };

            cells.push(ParsedCell {
                codepoint,
                grapheme,
                width,
                fg_rgba,
                bg_rgba,
                bold: (attrs & ATTR_BOLD) != 0,
                dim: (attrs & ATTR_DIM) != 0,
                italic: (attrs & ATTR_ITALIC) != 0,
                underline: (attrs & ATTR_UNDERLINE) != 0,
                inverse: (attrs & ATTR_INVERSE) != 0,
            });
        }
        dirty_rows.push(ParsedRow {
            row_idx,
            wrapped,
            cells,
        });
    }

    let meta = if (mode_flags & MODE_EXTENDED_META) != 0 && bytes.len() > overflow_end {
        serde_json::from_slice(&bytes[overflow_end..]).unwrap_or_default()
    } else {
        ExtendedSnapshotMeta {
            mouse_mode: if (mode_flags & MODE_MOUSE) != 0 {
                "click".into()
            } else {
                "none".into()
            },
            ..ExtendedSnapshotMeta::default()
        }
    };

    let cursor_shape = match (cursor_flags >> 2) & 0x07 {
        1 => CursorShape::Underline,
        2 => CursorShape::Bar,
        _ => CursorShape::Block,
    };

    Ok(ParsedSnapshot {
        seq,
        cols,
        rows,
        cursor_col,
        cursor_row,
        cursor_visible: (cursor_flags & 0x01) != 0,
        cursor_blink: (cursor_flags & 0x02) != 0,
        cursor_shape,
        full_frame: (mode_flags & MODE_FULL) != 0,
        alternate_screen: (mode_flags & MODE_ALTERNATE) != 0,
        mouse_tracking: (mode_flags & MODE_MOUSE) != 0,
        bracketed_paste: (mode_flags & MODE_BRACKETED_PASTE) != 0,
        application_cursor: (mode_flags & MODE_APPLICATION_CURSOR) != 0,
        sync_output: (mode_flags & MODE_SYNC_OUTPUT) != 0,
        exited: (mode_flags & MODE_EXITED) != 0,
        exit_code,
        mode_flags,
        dirty_rows,
        meta,
    })
}

#[derive(Clone)]
pub struct CellSpec {
    pub ch: String,
    pub width: u8,
    pub fg: u32,
    pub bg: u32,
    pub attrs: u8,
}

/// Test/helper encoder that follows the daemon's little-endian layout.
pub fn encode_snapshot(spec: EncodeSpec) -> Vec<u8> {
    let mut overflow = Vec::new();
    let mut cell_bytes = Vec::new();
    let mut descriptors = Vec::new();
    let mut total_cells = 0u32;

    for row in &spec.dirty {
        let count = (row.cells.len().min(0x7fff)) as u16;
        let raw = if row.wrapped { count | 0x8000 } else { count };
        descriptors.extend_from_slice(&row.row_idx.to_le_bytes());
        descriptors.extend_from_slice(&raw.to_le_bytes());
        for cell in &row.cells {
            total_cells += 1;
            let mut attrs = cell.attrs;
            let packed = if cell.ch.chars().count() > 1 {
                let bytes = cell.ch.as_bytes();
                let len = bytes.len().min(255);
                let offset = overflow.len();
                overflow.extend_from_slice(&bytes[..len]);
                attrs |= ATTR_OVERFLOW;
                ((offset as u32) & 0x00ff_ffff) | ((len as u32) << 24)
            } else {
                cell.ch.chars().next().map(|ch| ch as u32).unwrap_or(0)
            };
            cell_bytes.extend_from_slice(&packed.to_le_bytes());
            cell_bytes.extend_from_slice(&cell.fg.to_le_bytes());
            cell_bytes.extend_from_slice(&cell.bg.to_le_bytes());
            cell_bytes.push(cell.width);
            cell_bytes.push(attrs);
            cell_bytes.extend_from_slice(&0u16.to_le_bytes());
        }
    }

    let meta_bytes = serde_json::to_vec(&spec.meta).unwrap_or_default();
    let mut mode_flags = spec.mode_flags;
    if !meta_bytes.is_empty() {
        mode_flags |= MODE_EXTENDED_META;
    }
    let dirty_count = spec.dirty.len() as u16;

    let mut out = Vec::new();
    out.extend_from_slice(&spec.seq.to_le_bytes());
    out.extend_from_slice(&spec.cols.to_le_bytes());
    out.extend_from_slice(&spec.rows.to_le_bytes());
    out.extend_from_slice(&spec.cursor_col.to_le_bytes());
    out.extend_from_slice(&spec.cursor_row.to_le_bytes());
    out.push(spec.cursor_flags);
    out.push(mode_flags);
    out.extend_from_slice(&dirty_count.to_le_bytes());
    out.extend_from_slice(&total_cells.to_le_bytes());
    out.extend_from_slice(&(overflow.len() as u32).to_le_bytes());
    out.extend_from_slice(&spec.exit_code.to_le_bytes());
    out.extend_from_slice(&descriptors);
    out.extend_from_slice(&cell_bytes);
    out.extend_from_slice(&overflow);
    out.extend_from_slice(&meta_bytes);
    out
}

pub struct EncodeRow {
    pub row_idx: u16,
    pub wrapped: bool,
    pub cells: Vec<CellSpec>,
}

pub struct EncodeSpec {
    pub seq: u64,
    pub cols: u16,
    pub rows: u16,
    pub cursor_col: u16,
    pub cursor_row: u16,
    pub cursor_flags: u8,
    pub mode_flags: u8,
    pub exit_code: i32,
    pub dirty: Vec<EncodeRow>,
    pub meta: ExtendedSnapshotMeta,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plain_cell(ch: &str, bg: u32) -> CellSpec {
        CellSpec {
            ch: ch.to_string(),
            width: if ch == "😀" { 2 } else { 1 },
            fg: 0xE6ED_F3FF,
            bg,
            attrs: 0,
        }
    }

    #[test]
    fn parses_header_dirty_rows_and_extended_meta() {
        let spec = EncodeSpec {
            seq: 42,
            cols: 4,
            rows: 2,
            cursor_col: 1,
            cursor_row: 0,
            cursor_flags: 0x01 | (2 << 2),
            mode_flags: MODE_FULL | MODE_APPLICATION_CURSOR | MODE_BRACKETED_PASTE,
            exit_code: 0,
            dirty: vec![EncodeRow {
                row_idx: 0,
                wrapped: true,
                cells: vec![
                    plain_cell("A", 0x1122_33FF),
                    plain_cell("A", 0x1122_33FF),
                    plain_cell("B", 0x0000_00FF),
                    CellSpec {
                        ch: "é́".into(),
                        width: 1,
                        fg: 0xFFFF_FFFF,
                        bg: 0,
                        attrs: ATTR_BOLD | ATTR_UNDERLINE,
                    },
                ],
            }],
            meta: ExtendedSnapshotMeta {
                title: Some("kite".into()),
                mouse_mode: "drag".into(),
                sgr_mouse: true,
                sgr_pixels_mouse: false,
                focus_reporting: true,
                win32_input_mode: true,
                kitty_keyboard_flags: 3,
                clipboard_write: Some("copied".into()),
                ..ExtendedSnapshotMeta::default()
            },
        };
        let bytes = encode_snapshot(spec);
        let parsed = parse_snapshot_bin(&bytes).unwrap();
        assert_eq!(parsed.seq, 42);
        assert_eq!(parsed.cols, 4);
        assert!(parsed.full_frame);
        assert!(parsed.application_cursor);
        assert!(parsed.bracketed_paste);
        assert_eq!(parsed.cursor_shape, CursorShape::Bar);
        assert!(parsed.cursor_visible);
        assert_eq!(parsed.dirty_rows.len(), 1);
        assert!(parsed.dirty_rows[0].wrapped);
        assert_eq!(parsed.dirty_rows[0].cells[0].codepoint, 'A' as u32);
        assert_eq!(parsed.dirty_rows[0].cells[3].grapheme.as_deref(), Some("é́"));
        assert!(parsed.dirty_rows[0].cells[3].bold);
        assert!(parsed.dirty_rows[0].cells[3].underline);
        assert_eq!(parsed.meta.title.as_deref(), Some("kite"));
        assert!(parsed.meta.sgr_mouse);
        assert!(parsed.meta.win32_input_mode);
        assert_eq!(parsed.meta.kitty_keyboard_flags, 3);
        assert_eq!(parsed.meta.clipboard_write.as_deref(), Some("copied"));
        assert_eq!(parsed.meta.mouse_mode, "drag");
        assert!(parsed.meta.focus_reporting);
    }

    #[test]
    fn trusts_the_cell_width_for_presentation_selectors() {
        let spec = EncodeSpec {
            seq: 1,
            cols: 2,
            rows: 1,
            cursor_col: 0,
            cursor_row: 0,
            cursor_flags: 1,
            mode_flags: MODE_FULL,
            exit_code: 0,
            dirty: vec![EncodeRow {
                row_idx: 0,
                wrapped: false,
                cells: vec![CellSpec {
                    ch: "❤".into(),
                    width: 2,
                    fg: 0xFFFF_FFFF,
                    bg: 0,
                    attrs: 0,
                }],
            }],
            meta: ExtendedSnapshotMeta::default(),
        };
        let parsed = parse_snapshot_bin(&encode_snapshot(spec)).unwrap();
        assert_eq!(parsed.dirty_rows[0].cells[0].width, 2);
        assert_eq!(parsed.dirty_rows[0].cells[0].codepoint, '❤' as u32);
    }

    #[test]
    fn rejects_a_truncated_payload() {
        let err = parse_snapshot_bin(&[0u8; 8]).unwrap_err();
        assert!(err.0.contains("too small"));
    }
}
