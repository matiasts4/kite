//! Dirty-row cache, 33 ms output clock, and the immediate typing path.

use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::snapshot_bin::{parse_snapshot_bin, ParsedCell, ParsedSnapshot, SnapshotError};
use crate::sprites::{is_sprite_codepoint, sprite_for, ProceduralSpriteOp};
use crate::theme::{DEFAULT_BG, DEFAULT_FG};

pub const OUTPUT_CLOCK: Duration = Duration::from_millis(33);
pub const TYPING_BYPASS: Duration = Duration::from_millis(200);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BgQuadOp {
    pub start_col: u16,
    pub end_col: u16,
    pub rgba: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GlyphOp {
    pub col: u16,
    pub width: u8,
    pub codepoint: u32,
    pub grapheme_utf8: Option<Arc<str>>,
    pub fg_rgba: u32,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub dim: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CachedRowOps {
    pub row_seq: u64,
    pub wrapped: bool,
    pub style_epoch: u32,
    pub bg_quads: Arc<[BgQuadOp]>,
    pub glyphs: Arc<[GlyphOp]>,
    pub sprites: Arc<[ProceduralSpriteOp]>,
}

#[derive(Clone, Debug)]
pub struct IngestEffect {
    pub immediate: bool,
    pub credit: u32,
    pub clipboard: Option<String>,
    pub title: Option<String>,
    pub rebuilt_rows: u16,
    pub paint_us: u128,
}

#[derive(Clone, Debug)]
pub struct GpuiTerminalView {
    pub channel_id: u32,
    pub session_id: String,
    pub cols: u16,
    pub rows: u16,
    pub painted_rows: Vec<Option<Arc<CachedRowOps>>>,
    pub cursor_col: u16,
    pub cursor_row: u16,
    pub cursor_visible: bool,
    pub last_seq: u64,
    pub mode_flags: u8,
    pub application_cursor: bool,
    pub bracketed_paste: bool,
    pub alternate_screen: bool,
    pub mouse_mode: String,
    pub sgr_mouse: bool,
    pub sgr_pixels_mouse: bool,
    pub focus_reporting: bool,
    pub win32_input_mode: bool,
    pub kitty_keyboard_flags: u8,
    pub title: Option<String>,
    pub scrollback_offset: u32,
    pub last_typed_at: Option<Instant>,
    pub pending_paint_credit: u32,
    pub focused: bool,
    pub live_visible: bool,
    pub style_epoch: u32,
    pub last_paint_us: u128,
}

impl GpuiTerminalView {
    pub fn new(channel_id: u32, session_id: impl Into<String>, cols: u16, rows: u16) -> Self {
        Self {
            channel_id,
            session_id: session_id.into(),
            cols,
            rows,
            painted_rows: vec![None; rows as usize],
            cursor_col: 0,
            cursor_row: 0,
            cursor_visible: true,
            last_seq: 0,
            mode_flags: 0,
            application_cursor: false,
            bracketed_paste: false,
            alternate_screen: false,
            mouse_mode: "none".into(),
            sgr_mouse: false,
            sgr_pixels_mouse: false,
            focus_reporting: false,
            win32_input_mode: false,
            kitty_keyboard_flags: 0,
            title: None,
            scrollback_offset: 0,
            last_typed_at: None,
            pending_paint_credit: 0,
            focused: true,
            live_visible: true,
            style_epoch: 1,
            last_paint_us: 0,
        }
    }

    pub fn note_typed(&mut self, now: Instant) {
        self.last_typed_at = Some(now);
    }

    pub fn typing_bypass(&self, now: Instant) -> bool {
        self.last_typed_at
            .is_some_and(|typed| now.saturating_duration_since(typed) < TYPING_BYPASS)
    }

    pub fn set_visible(&mut self, focused: bool, live_visible: bool) -> [u8; 2] {
        self.focused = focused;
        self.live_visible = live_visible;
        [u8::from(focused), u8::from(live_visible)]
    }

    pub fn ingest(&mut self, bytes: &[u8], now: Instant) -> Result<IngestEffect, SnapshotError> {
        let started = Instant::now();
        let snapshot = parse_snapshot_bin(bytes)?;
        let rebuilt = self.apply_snapshot(&snapshot);
        let paint_us = started.elapsed().as_micros();
        self.last_paint_us = paint_us;
        let immediate = self.typing_bypass(now);
        let credit = if immediate {
            let owed = self.pending_paint_credit.saturating_add(1);
            self.pending_paint_credit = 0;
            owed
        } else {
            self.pending_paint_credit = self.pending_paint_credit.saturating_add(1);
            0
        };
        Ok(IngestEffect {
            immediate,
            credit,
            clipboard: snapshot.meta.clipboard_write.clone(),
            title: self.title.clone(),
            rebuilt_rows: rebuilt,
            paint_us,
        })
    }

    /// Releases one coalesced credit grant when the shared 33 ms clock fires.
    pub fn take_clock_credit(&mut self) -> u32 {
        let credit = self.pending_paint_credit;
        self.pending_paint_credit = 0;
        credit
    }

    fn apply_snapshot(&mut self, snapshot: &ParsedSnapshot) -> u16 {
        if snapshot.full_frame && (snapshot.cols != self.cols || snapshot.rows != self.rows) {
            self.cols = snapshot.cols;
            self.rows = snapshot.rows;
            self.painted_rows = vec![None; snapshot.rows as usize];
        } else if snapshot.full_frame && self.painted_rows.len() != snapshot.rows as usize {
            self.painted_rows.resize(snapshot.rows as usize, None);
            self.cols = snapshot.cols;
            self.rows = snapshot.rows;
        }
        self.cursor_col = snapshot.cursor_col;
        self.cursor_row = snapshot.cursor_row;
        self.cursor_visible = snapshot.cursor_visible;
        self.last_seq = snapshot.seq;
        self.mode_flags = snapshot.mode_flags;
        self.application_cursor = snapshot.application_cursor;
        self.bracketed_paste = snapshot.bracketed_paste;
        self.alternate_screen = snapshot.alternate_screen;
        self.mouse_mode = if snapshot.meta.mouse_mode.is_empty() {
            if snapshot.mouse_tracking { "click" } else { "none" }.to_string()
        } else {
            snapshot.meta.mouse_mode.clone()
        };
        self.sgr_mouse = snapshot.meta.sgr_mouse;
        self.sgr_pixels_mouse = snapshot.meta.sgr_pixels_mouse;
        self.focus_reporting = snapshot.meta.focus_reporting;
        self.win32_input_mode = snapshot.meta.win32_input_mode;
        self.kitty_keyboard_flags = snapshot.meta.kitty_keyboard_flags;
        self.scrollback_offset = snapshot.meta.scrollback_offset;
        if snapshot.meta.title.is_some() {
            self.title = snapshot.meta.title.clone();
        }

        let mut rebuilt = 0u16;
        for row in &snapshot.dirty_rows {
            let index = row.row_idx as usize;
            if index >= self.painted_rows.len() {
                continue;
            }
            let ops = Arc::new(build_row_ops(snapshot.seq, row.wrapped, self.style_epoch, &row.cells));
            self.painted_rows[index] = Some(ops);
            rebuilt = rebuilt.saturating_add(1);
        }
        rebuilt
    }
}

pub fn build_row_ops(seq: u64, wrapped: bool, style_epoch: u32, cells: &[ParsedCell]) -> CachedRowOps {
    let mut bg_quads = Vec::new();
    let mut glyphs = Vec::new();
    let mut sprites = Vec::new();
    let mut col = 0u16;
    let mut index = 0usize;
    while index < cells.len() {
        let bg = effective_bg(&cells[index]);
        let start = col;
        let mut next = index;
        let mut end_col = col;
        while next < cells.len() && effective_bg(&cells[next]) == bg {
            let width = cells[next].width.max(if cells[next].width == 0 { 0 } else { 1 });
            let advance = if cells[next].width == 0 { 0 } else { width };
            end_col = end_col.saturating_add(advance as u16);
            next += 1;
        }
        if (bg & 0xff) != 0 {
            bg_quads.push(BgQuadOp {
                start_col: start,
                end_col,
                rgba: bg,
            });
        }
        index = next;
        col = end_col;
    }

    col = 0;
    for cell in cells {
        let advance = if cell.width == 0 { 0 } else { cell.width.max(1) };
        if cell.width == 0 {
            continue;
        }
        let (fg, _) = colors(cell);
        if is_sprite_codepoint(cell.codepoint) && cell.grapheme.is_none() {
            if let Some(sprite) = sprite_for(col, advance, cell.codepoint, fg) {
                sprites.push(sprite);
            }
        } else if cell.codepoint != 0 || cell.grapheme.is_some() {
            glyphs.push(GlyphOp {
                col,
                width: advance,
                codepoint: cell.codepoint,
                grapheme_utf8: cell.grapheme.as_ref().map(|text| Arc::<str>::from(text.as_str())),
                fg_rgba: fg,
                bold: cell.bold,
                italic: cell.italic,
                underline: cell.underline,
                dim: cell.dim,
            });
        }
        col = col.saturating_add(advance as u16);
    }

    CachedRowOps {
        row_seq: seq,
        wrapped,
        style_epoch,
        bg_quads: bg_quads.into(),
        glyphs: glyphs.into(),
        sprites: sprites.into(),
    }
}

fn effective_bg(cell: &ParsedCell) -> u32 {
    colors(cell).1
}

fn colors(cell: &ParsedCell) -> (u32, u32) {
    let fg = if (cell.fg_rgba & 0xff) == 0 { DEFAULT_FG } else { cell.fg_rgba };
    let bg = if (cell.bg_rgba & 0xff) == 0 { DEFAULT_BG & 0xFFFF_FF00 } else { cell.bg_rgba };
    if cell.inverse { (bg, fg) } else { (fg, bg) }
}

#[derive(Debug)]
pub struct OutputClock {
    pub interval: Duration,
    next_due: Option<Instant>,
}

impl OutputClock {
    pub fn new() -> Self {
        Self {
            interval: OUTPUT_CLOCK,
            next_due: None,
        }
    }

    pub fn arm(&mut self, now: Instant) {
        if self.next_due.is_none() {
            self.next_due = Some(now + self.interval);
        }
    }

    pub fn due(&self, now: Instant) -> bool {
        self.next_due.is_some_and(|due| now >= due)
    }

    /// When the credit clock is armed and still in the future, the caller may
    /// sleep until this instant. `None` means block on the pipe: a clean grid
    /// does not schedule another wake.
    pub fn wait_until(&self, now: Instant) -> Option<Instant> {
        self.next_due.filter(|due| *due > now)
    }

    pub fn complete(&mut self, now: Instant) {
        self.next_due = Some(now + self.interval);
    }

    pub fn clear(&mut self) {
        self.next_due = None;
    }
}

pub fn row_line(row: &CachedRowOps, cols: u16) -> String {
    let width = cols as usize;
    if width == 0 {
        return String::new();
    }
    let mut cells = vec![' '; width];
    for glyph in row.glyphs.iter() {
        let col = glyph.col as usize;
        if col >= cells.len() {
            continue;
        }
        let ch = glyph
            .grapheme_utf8
            .as_ref()
            .and_then(|text| text.chars().next())
            .or_else(|| char::from_u32(glyph.codepoint))
            .unwrap_or(' ');
        if ch != '\0' {
            cells[col] = ch;
        }
    }
    cells.into_iter().collect()
}

pub fn pane_lines(view: &GpuiTerminalView) -> Vec<String> {
    view.painted_rows
        .iter()
        .map(|row| match row {
            Some(ops) => row_line(ops, view.cols),
            None => String::new(),
        })
        .collect()
}

impl Default for OutputClock {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::snapshot_bin::{
        CellSpec, EncodeRow, EncodeSpec, ExtendedSnapshotMeta, ATTR_INVERSE, MODE_FULL,
    };
    use crate::theme;
    use std::sync::Arc;

    fn cell(ch: &str, bg: u32) -> CellSpec {
        CellSpec {
            ch: ch.into(),
            width: 1,
            fg: theme::DEFAULT_FG,
            bg,
            attrs: 0,
        }
    }

    fn frame(seq: u64, rows: Vec<EncodeRow>, full: bool) -> Vec<u8> {
        crate::snapshot_bin::encode_snapshot(EncodeSpec {
            seq,
            cols: 4,
            rows: 2,
            cursor_col: 1,
            cursor_row: 0,
            cursor_flags: 1,
            mode_flags: if full { MODE_FULL } else { 0 },
            exit_code: 0,
            dirty: rows,
            meta: ExtendedSnapshotMeta {
                title: Some("pane".into()),
                mouse_mode: "any".into(),
                sgr_mouse: true,
                ..ExtendedSnapshotMeta::default()
            },
        })
    }

    #[test]
    fn clean_rows_keep_their_arc_and_sprites_leave_the_atlas() {
        let now = Instant::now();
        let mut view = GpuiTerminalView::new(1, "s1", 4, 2);
        let first = frame(
            1,
            vec![
                EncodeRow {
                    row_idx: 0,
                    wrapped: false,
                    cells: vec![cell("A", 0x1111_11FF), cell("A", 0x1111_11FF), cell("─", 0), cell("B", 0x2222_22FF)],
                },
                EncodeRow {
                    row_idx: 1,
                    wrapped: true,
                    cells: vec![cell("Z", 0x3333_33FF)],
                },
            ],
            true,
        );
        view.ingest(&first, now).unwrap();
        let kept = Arc::clone(view.painted_rows[1].as_ref().unwrap());
        let row0 = view.painted_rows[0].as_ref().unwrap();
        assert_eq!(row0.bg_quads.len(), 2);
        assert_eq!(row0.bg_quads[0].end_col - row0.bg_quads[0].start_col, 2);
        assert_eq!(row0.sprites.len(), 1);
        assert!(row0.glyphs.iter().all(|glyph| glyph.codepoint != '─' as u32));
        assert!(row0.glyphs.iter().any(|glyph| glyph.codepoint == 'A' as u32));

        let second = frame(
            2,
            vec![EncodeRow {
                row_idx: 0,
                wrapped: false,
                cells: vec![cell("Q", 0x1111_11FF)],
            }],
            false,
        );
        let effect = view.ingest(&second, now).unwrap();
        assert_eq!(effect.rebuilt_rows, 1);
        assert!(Arc::ptr_eq(&kept, view.painted_rows[1].as_ref().unwrap()));
        assert_eq!(view.painted_rows[0].as_ref().unwrap().glyphs[0].codepoint, 'Q' as u32);
        assert_eq!(view.title.as_deref(), Some("pane"));
        assert!(view.sgr_mouse);
        assert_eq!(view.mouse_mode, "any");
        assert_eq!(effect.credit, 0);
        assert_eq!(view.pending_paint_credit, 2);
    }

    #[test]
    fn typing_bypasses_the_clock_and_returns_credit_immediately() {
        let start = Instant::now();
        let mut view = GpuiTerminalView::new(2, "s", 4, 2);
        let bytes = frame(1, vec![], true);
        view.ingest(&bytes, start).unwrap();
        assert_eq!(view.pending_paint_credit, 1);
        view.note_typed(start);
        let effect = view.ingest(&bytes, start + Duration::from_millis(50)).unwrap();
        assert!(effect.immediate);
        assert_eq!(effect.credit, 2);
        assert_eq!(view.pending_paint_credit, 0);
        view.ingest(&bytes, start + Duration::from_millis(400)).unwrap();
        assert_eq!(view.pending_paint_credit, 1);
        assert_eq!(view.take_clock_credit(), 1);
    }

    #[test]
    fn inverse_swaps_colors_and_width_is_preserved() {
        let cells = vec![ParsedCell {
            codepoint: '❤' as u32,
            grapheme: None,
            width: 2,
            fg_rgba: 0xFF00_00FF,
            bg_rgba: 0x0000_00FF,
            bold: false,
            dim: false,
            italic: false,
            underline: false,
            inverse: true,
        }];
        let _ = ATTR_INVERSE;
        let ops = build_row_ops(1, false, 1, &cells);
        assert_eq!(ops.glyphs[0].width, 2);
        assert_eq!(ops.glyphs[0].fg_rgba, 0x0000_00FF);
        assert_eq!(ops.bg_quads[0].rgba, 0xFF00_00FF);
    }

    #[test]
    fn a_full_viewport_rebuild_stays_under_two_milliseconds() {
        let mut cells = Vec::new();
        for col in 0..120 {
            let ch = if col % 10 == 0 { "─" } else { "x" };
            cells.push(cell(ch, if col % 4 == 0 { 0x1010_10FF } else { 0 }));
        }
        let rows: Vec<EncodeRow> = (0..36)
            .map(|row| EncodeRow {
                row_idx: row,
                wrapped: false,
                cells: cells.clone(),
            })
            .collect();
        let bytes = crate::snapshot_bin::encode_snapshot(EncodeSpec {
            seq: 9,
            cols: 120,
            rows: 36,
            cursor_col: 3,
            cursor_row: 4,
            cursor_flags: 1,
            mode_flags: MODE_FULL,
            exit_code: 0,
            dirty: rows,
            meta: ExtendedSnapshotMeta::default(),
        });
        let mut samples = Vec::new();
        let mut view = GpuiTerminalView::new(1, "bench", 120, 36);
        let now = Instant::now();
        for _ in 0..20 {
            let effect = view.ingest(&bytes, now).unwrap();
            samples.push(effect.paint_us);
        }
        samples.sort_unstable();
        let p99 = samples[samples.len() - 1];
        assert!(p99 < 2_000, "paint p99 {p99} µs");
    }

    #[test]
    fn a_clean_clock_does_not_schedule_another_wake() {
        let now = Instant::now();
        let mut clock = OutputClock::new();
        assert!(clock.wait_until(now).is_none());
        clock.arm(now);
        assert!(clock.wait_until(now).is_some());
        assert!(!clock.due(now + Duration::from_millis(10)));
        assert!(clock.due(now + Duration::from_millis(33)));
        clock.clear();
        assert!(clock.wait_until(now + Duration::from_millis(34)).is_none());
        assert!(!clock.due(now + Duration::from_millis(66)));
    }
}
