use crate::vt_engine::screen::TerminalVtEngine;
use crate::vt_engine::types::{
    ansi_color_to_rgb, ensure_readable_fg, CellSnapshot, CursorSnapshot, Dec2026TimeoutNotice,
    ExtendedSnapshotMeta, RenderSnapshot, RowSnapshot, TerminalSnapshotPollResponse, DEFAULT_BG,
    DEFAULT_FG, MAX_DEC2026_HOLD, MODE_FLAG_APPLICATION_CURSOR, MODE_FLAG_EXTENDED_META,
    SNAPSHOT_BIN_HEADER_LEN,
};
use std::time::Instant;

pub(crate) fn commit_snapshot(engine: &mut TerminalVtEngine) {
    engine.dirty = true;
    if let TerminalSnapshotPollResponse::Snapshot { snapshot, .. } =
        get_snapshot_diff(engine, 0, false, None)
    {
        if snapshot.clipboard_write.is_some() {
            engine.pending_clipboard = snapshot.clipboard_write;
        }
    }
}

pub(crate) fn open_render_hold(engine: &mut TerminalVtEngine) {
    commit_snapshot(engine);
    engine.render_held = true;
    engine.hold_started_at = Some(Instant::now());
    engine.diagnostics.dec2026_holds_total = engine.diagnostics.dec2026_holds_total.saturating_add(1);
}

pub(crate) fn close_render_hold(engine: &mut TerminalVtEngine) {
    let held_ms = engine
        .hold_started_at
        .map(|started| started.elapsed().as_millis() as u64)
        .unwrap_or(0);
    engine.diagnostics.last_hold_duration_ms = held_ms;
    engine.render_held = false;
    engine.hold_started_at = None;
    commit_snapshot(engine);
}

pub(crate) fn frozen_clean_snapshot(engine: &TerminalVtEngine) -> RenderSnapshot {
    if let Some(snapshot) = &engine.committed_snapshot {
        let mut snapshot = snapshot.clone();
        snapshot.seq = engine.seq;
        snapshot.clipboard_write = None;
        return snapshot;
    }
    RenderSnapshot {
        seq: engine.seq,
        cols: engine.cols,
        rows: engine.rows,
        alternate_screen: false,
        application_cursor: false,
        bracketed_paste: false,
        mouse_tracking: engine
            .explicit_mouse_mode
            .as_deref()
            .is_some_and(|mode| mode != "none"),
        mouse_mode: engine
            .explicit_mouse_mode
            .clone()
            .unwrap_or_else(|| "none".to_string()),
        sgr_mouse: engine.explicit_sgr_mouse.unwrap_or(false),
        sgr_pixels_mouse: engine.sgr_pixels_mouse,
        focus_reporting: engine.focus_reporting,
        win32_input_mode: engine.win32_input_mode,
        kitty_keyboard_flags: engine.kitty_keyboard_flags(),
        scrollback_offset: 0,
        scrollback_depth: 0,
        cursor: engine.last_cursor.clone(),
        dirty_rows: Vec::new(),
        full: true,
        title: engine.current_title.clone(),
        clipboard_write: None,
    }
}

pub fn get_snapshot_diff(
    engine: &mut TerminalVtEngine,
    since_seq: u64,
    exited: bool,
    exit_code: Option<i64>,
) -> TerminalSnapshotPollResponse {
    if engine.render_held {
        let elapsed = engine.hold_started_at.map(|started| started.elapsed());
        let timed_out = elapsed.is_some_and(|elapsed| elapsed >= MAX_DEC2026_HOLD);
        let release = timed_out || exited || engine.hold_started_at.is_none();
        if release {
            if timed_out {
                let held_ms = elapsed.map(|elapsed| elapsed.as_millis() as u64).unwrap_or(0);
                engine.diagnostics.dec2026_timeouts_total =
                    engine.diagnostics.dec2026_timeouts_total.saturating_add(1);
                engine.diagnostics.last_hold_duration_ms = held_ms;
                engine.pending_timeouts.push(Dec2026TimeoutNotice {
                    held_ms,
                    seq: engine.seq,
                });
            }
            engine.render_held = false;
            engine.hold_started_at = None;
            engine.dirty = true;
        } else if since_seq == engine.seq {
            return TerminalSnapshotPollResponse::Unchanged {
                seq: engine.seq,
                exited,
                exit_code,
            };
        } else {
            let mut snapshot = frozen_clean_snapshot(engine);
            snapshot.clipboard_write = engine.pending_clipboard.take();
            return TerminalSnapshotPollResponse::Snapshot {
                snapshot,
                exited,
                exit_code,
            };
        }
    }

    if !engine.dirty && since_seq == engine.seq && since_seq != 0 {
        return TerminalSnapshotPollResponse::Unchanged {
            seq: engine.seq,
            exited,
            exit_code,
        };
    }

    if !engine.dirty {
        if let Some(mut snapshot) = engine.committed_snapshot.clone() {
            snapshot.clipboard_write = engine.pending_clipboard.take();
            return TerminalSnapshotPollResponse::Snapshot {
                snapshot,
                exited,
                exit_code,
            };
        }
    }

    let screen = engine.parser.screen();
    let (cursor_row, cursor_col) = screen.cursor_position();
    let scrollback_offset = screen.scrollback() as u32;
    let scrollback_depth = screen.scrollback_depth() as u32;
    let cursor_visible = !screen.hide_cursor() && scrollback_offset == 0;
    let alternate_screen = screen.alternate_screen();
    let application_cursor = screen.application_cursor();
    let bracketed_paste = screen.bracketed_paste();
    let mouse_mode = engine.effective_mouse_mode();
    let mouse_tracking = mouse_mode != "none";
    let sgr_mouse = engine.effective_sgr_mouse();
    let sgr_pixels_mouse = engine.sgr_pixels_mouse;
    let focus_reporting = engine.focus_reporting;
    let win32_input_mode = engine.win32_input_mode;
    let kitty_keyboard_flags = engine.kitty_keyboard_flags();

    let current_cursor = CursorSnapshot {
        visible: cursor_visible,
        col: cursor_col.min(engine.cols.saturating_sub(1)),
        row: cursor_row.min(engine.rows.saturating_sub(1)),
        shape: engine.cursor_shape.clone(),
        // Blink is a renderer preference, not a VT grid fact.
        blink: false,
    };

    // A delta is against the last frame this engine published. If the
    // client is still on an older seq, that delta would patch the wrong
    // screen and leave one or two rows from the missed frame behind.
    let missed_frame = since_seq != 0 && since_seq < engine.seq;
    let force_full = since_seq == 0
        || missed_frame
        || engine.client_rows.len() != engine.rows as usize
        || engine.client_rows.first().map_or(0, |r| r.len()) != engine.cols as usize;

    let mut current_matrix: Vec<Vec<CellSnapshot>> = Vec::with_capacity(engine.rows as usize);
    let mut dirty_rows: Vec<RowSnapshot> = Vec::new();

    for r in 0..engine.rows {
        let mut row_cells: Vec<CellSnapshot> = Vec::with_capacity(engine.cols as usize);
        let mut prev_wide_bg: ([u8; 3], bool) = (DEFAULT_BG, false);

        for c in 0..engine.cols {
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
            || engine.client_rows.len() <= r as usize
            || engine.client_rows[r as usize] != row_cells;

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
        && current_cursor == engine.last_cursor
        && engine.pending_clipboard.is_none()
        && engine.current_title == engine.last_title
    {
        engine.dirty = false;
        return TerminalSnapshotPollResponse::Unchanged {
            seq: engine.seq,
            exited,
            exit_code,
        };
    }

    engine.seq += 1;
    engine.client_rows = current_matrix;
    engine.last_cursor = current_cursor.clone();
    engine.last_title = engine.current_title.clone();
    engine.dirty = false;

    let full_rows: Vec<RowSnapshot> = engine
        .client_rows
        .iter()
        .enumerate()
        .map(|(idx, cells)| RowSnapshot {
            row_idx: idx as u16,
            cells: cells.clone(),
            wrapped: screen.row_wrapped(idx as u16),
        })
        .collect();
    engine.committed_snapshot = Some(RenderSnapshot {
        seq: engine.seq,
        cols: engine.cols,
        rows: engine.rows,
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
        scrollback_depth,
        cursor: current_cursor.clone(),
        dirty_rows: full_rows,
        full: true,
        title: engine.current_title.clone(),
        clipboard_write: None,
    });

    let snapshot = RenderSnapshot {
        seq: engine.seq,
        cols: engine.cols,
        rows: engine.rows,
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
        scrollback_depth,
        cursor: current_cursor,
        dirty_rows,
        full: force_full,
        title: engine.current_title.clone(),
        clipboard_write: engine.pending_clipboard.take(),
    };

    TerminalSnapshotPollResponse::Snapshot {
        snapshot,
        exited,
        exit_code,
    }
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
        scrollback_depth: snapshot.scrollback_depth,
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
        scrollback_depth: meta.as_ref().map(|m| m.scrollback_depth).unwrap_or(0),
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
