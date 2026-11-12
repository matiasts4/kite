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

#[test]
fn extracts_selection_text_across_scrollback_and_active_screen() {
    let mut engine = TerminalVtEngine::new(20, 4);
    for i in 1..=8 {
        if i < 8 {
            engine.feed(format!("Line {i:02}\r\n").as_bytes());
        } else {
            engine.feed(format!("Line {i:02}").as_bytes());
        }
    }
    // 8 lines in a 4-row terminal -> 4 lines in scrollback (-4..-1) and 4 in active screen (0..3)
    let text = engine.selection_text(-4, 0, 3, 20);
    assert_eq!(
        text,
        "Line 01\nLine 02\nLine 03\nLine 04\nLine 05\nLine 06\nLine 07\nLine 08"
    );
    // Partial column range across scrollback boundary (-1 to 0)
    let partial = engine.selection_text(-1, 5, 0, 7);
    assert_eq!(partial, "04\nLine 05");
}
