use crate::vt_engine::parser;
use crate::vt_engine::snapshot;
use crate::vt_engine::types::{
    color_json, CellSnapshot, CursorSnapshot, Dec2026TimeoutNotice, RenderSnapshot,
    TerminalSnapshotPollResponse, VtDiagnostics,
};
use std::collections::VecDeque;
use std::time::Instant;

pub struct TerminalVtEngine {
    pub(crate) parser: vt100::Parser,
    pub(crate) cols: u16,
    pub(crate) rows: u16,
    pub(crate) seq: u64,
    pub(crate) client_rows: Vec<Vec<CellSnapshot>>,
    pub(crate) last_cursor: CursorSnapshot,
    pub(crate) last_title: Option<String>,
    pub(crate) dirty: bool,
    pub(crate) render_held: bool,
    pub(crate) hold_started_at: Option<Instant>,
    pub(crate) cursor_shape: String,
    pub(crate) win32_input_mode: bool,
    pub(crate) win32_tail: Vec<u8>,
    pub(crate) focus_reporting: bool,
    pub(crate) in_band_resize: bool,
    pub(crate) sgr_pixels_mouse: bool,
    pub(crate) explicit_mouse_mode: Option<String>,
    pub(crate) explicit_sgr_mouse: Option<bool>,
    pub(crate) kitty_keyboard_stack: Vec<u8>,
    pub(crate) replies: Vec<u8>,
    pub(crate) pending_clipboard: Option<String>,
    pub(crate) current_title: Option<String>,
    pub(crate) canvas_active: bool,
    pub(crate) last_graphic_char: char,
    pub(crate) committed_snapshot: Option<RenderSnapshot>,
    pub(crate) diagnostics: VtDiagnostics,
    pub(crate) pending_timeouts: Vec<Dec2026TimeoutNotice>,
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

    /// Plain text between two buffer-relative positions (`rel_row = viewport_row - scrollback_offset`).
    pub fn selection_text(
        &self,
        start_row: i32,
        start_col: u16,
        end_row: i32,
        end_col: u16,
    ) -> String {
        self.parser
            .screen()
            .selection_text(start_row, start_col, end_row, end_col)
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

    #[inline]
    pub fn effective_mouse_mode(&self) -> String {
        parser::effective_mouse_mode(self)
    }

    #[inline]
    pub fn effective_sgr_mouse(&self) -> bool {
        parser::effective_sgr_mouse(self)
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

    #[inline]
    pub(crate) fn watch_win32_input_mode(&mut self, bytes: &[u8]) {
        parser::watch_win32_input_mode(self, bytes);
    }

    #[inline]
    pub(crate) fn scan_protocol_sequences(&mut self, bytes: &[u8]) {
        parser::scan_protocol_sequences(self, bytes);
    }

    #[inline]
    pub(crate) fn handle_csi_sequence(&mut self, body: &[u8], final_byte: u8) {
        parser::handle_csi_sequence(self, body, final_byte);
    }

    #[inline]
    pub(crate) fn note_unhandled_csi(&mut self, raw: &[u8]) {
        parser::note_unhandled_csi(self, raw);
    }

    #[inline]
    pub(crate) fn handle_osc_sequence(&mut self, body: &[u8]) {
        parser::handle_osc_sequence(self, body);
    }

    #[inline]
    pub(crate) fn process_parser(&mut self, bytes: &[u8]) {
        parser::process_parser(self, bytes);
    }

    #[inline]
    pub(crate) fn commit_snapshot(&mut self) {
        snapshot::commit_snapshot(self);
    }

    #[inline]
    pub(crate) fn open_render_hold(&mut self) {
        snapshot::open_render_hold(self);
    }

    #[inline]
    pub(crate) fn close_render_hold(&mut self) {
        snapshot::close_render_hold(self);
    }

    #[inline]
    pub(crate) fn frozen_clean_snapshot(&self) -> RenderSnapshot {
        snapshot::frozen_clean_snapshot(self)
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

        let normalized = parser::normalize_csi_sequences(bytes, &mut self.last_graphic_char);
        parser::scan_protocol_sequences(self, bytes);

        const START: &[u8] = b"\x1b[?2026h";
        const END: &[u8] = b"\x1b[?2026l";
        let mut i = 0usize;
        let mut balanced_depth: i32 = 0;
        let mut dirty_tail = false;
        while i < normalized.len() {
            let rest = &normalized[i..];
            let start_at = parser::find_subsequence(rest, START);
            let end_at = parser::find_subsequence(rest, END);
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
                    if parser::sync_hold_closes_within(after) {
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

    #[inline]
    pub fn get_snapshot_diff(
        &mut self,
        since_seq: u64,
        exited: bool,
        exit_code: Option<i64>,
    ) -> TerminalSnapshotPollResponse {
        snapshot::get_snapshot_diff(self, since_seq, exited, exit_code)
    }
}
