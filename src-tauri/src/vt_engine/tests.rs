use super::*;

include!("../vt_engine_tests.rs");

#[test]
fn verifies_modular_decomposition_surface() {
    let mut engine = TerminalVtEngine::new(80, 24);
    assert_eq!(engine.seq(), 0);
    assert_eq!(engine.screen_text(), "");
    assert!(!engine.alternate_screen());
    assert_eq!(DEFAULT_FG, [250, 250, 250]);
    assert_eq!(DEFAULT_BG, [10, 10, 10]);
    assert_eq!(SNAPSHOT_BIN_HEADER_LEN, 32);

    engine.feed(b"Modular VT Engine\r\n");
    assert!(engine.has_pending_output());
    assert!(engine.wants_paint());

    let snap = match engine.get_snapshot_diff(0, false, None) {
        TerminalSnapshotPollResponse::Snapshot { snapshot, .. } => snapshot,
        _ => panic!("expected initial snapshot"),
    };
    assert_eq!(snap.seq, 1);
    assert!(snap.full);
    assert!(engine.screen_text().contains("Modular VT Engine"));
}
