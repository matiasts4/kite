//! Native deck: stadium title bar, session sidebar, split grid, composer.

mod composer;
mod sidebar;
mod split_grid;
mod title_bar;

pub use composer::{Composer, PromptThrow, TelemetrySample};
pub use sidebar::{SessionRow, Sidebar};
pub use split_grid::SplitGrid;
pub use title_bar::{HandoffPlan, SurfaceKind, TitleBar, HANDOFF_BUDGET};

use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::core_client::Frame;
use crate::snapshot_bin::SnapshotError;
use crate::terminal_view::{GpuiTerminalView, IngestEffect, OutputClock};

#[derive(Debug)]
pub struct NativeDeck {
    pub title_bar: TitleBar,
    pub sidebar: Sidebar,
    pub grid: SplitGrid,
    pub composer: Composer,
    pub views: Vec<GpuiTerminalView>,
    pub clock: OutputClock,
    pub telemetry_open: bool,
    pub telemetry: TelemetrySample,
}

impl NativeDeck {
    pub fn new(workspace: impl Into<String>) -> Self {
        Self {
            title_bar: TitleBar::new(),
            sidebar: Sidebar::new(workspace),
            grid: SplitGrid::single(),
            composer: Composer::new(),
            views: Vec::new(),
            clock: OutputClock::new(),
            telemetry_open: false,
            telemetry: TelemetrySample::default(),
        }
    }

    pub fn attach_pane(&mut self, view: GpuiTerminalView) -> Result<(), &'static str> {
        if self.views.len() >= 4 {
            return Err("a native deck holds at most 4 panes");
        }
        self.grid.set_pane_count(self.views.len() + 1);
        self.views.push(view);
        Ok(())
    }

    pub fn ingest(&mut self, channel_id: u32, bytes: &[u8], now: Instant) -> Result<Vec<Frame>, SnapshotError> {
        let Some(view) = self.views.iter_mut().find(|view| view.channel_id == channel_id) else {
            return Ok(Vec::new());
        };
        let effect = view.ingest(bytes, now)?;
        self.after_ingest(channel_id, effect, now)
    }

    fn after_ingest(&mut self, channel_id: u32, effect: IngestEffect, now: Instant) -> Result<Vec<Frame>, SnapshotError> {
        let mut frames = Vec::new();
        if effect.immediate && effect.credit > 0 {
            frames.push(Frame::credit(channel_id, effect.credit));
        } else if effect.credit == 0 {
            self.clock.arm(now);
        }
        Ok(frames)
    }

    /// One window tick paints every held pane and returns a single credit per pane.
    pub fn tick(&mut self, now: Instant) -> Vec<Frame> {
        if !self.clock.due(now) {
            return Vec::new();
        }
        let mut frames = Vec::new();
        for view in &mut self.views {
            let credit = view.take_clock_credit();
            if credit > 0 {
                frames.push(Frame::credit(view.channel_id, credit));
            }
        }
        // One credit grant for the burst, then the presenter blocks on the pipe.
        self.clock.clear();
        frames
    }

    pub fn hide_pane(&mut self, channel_id: u32) -> Option<Frame> {
        let view = self.views.iter_mut().find(|view| view.channel_id == channel_id)?;
        let payload = view.set_visible(false, false);
        Some(Frame::focus(channel_id, payload[0] != 0, payload[1] != 0))
    }

    pub fn show_pane(&mut self, channel_id: u32, focused: bool) -> Option<Frame> {
        let view = self.views.iter_mut().find(|view| view.channel_id == channel_id)?;
        let payload = view.set_visible(focused, true);
        Some(Frame::focus(channel_id, payload[0] != 0, payload[1] != 0))
    }

    pub fn dispatch_prompt(&self) -> Value {
        self.composer.dispatch_params()
    }

    pub fn plan_surface_swap(&self, pane: usize) -> Option<HandoffPlan> {
        let view = self.views.get(pane)?;
        Some(TitleBar::plan_handoff(&view.session_id, view.channel_id, view.cols, view.rows))
    }
}

pub fn handoff_met(elapsed: Duration) -> bool {
    elapsed <= HANDOFF_BUDGET
}

pub fn resize_params(session_id: &str, cols: u16, rows: u16) -> Value {
    json!({ "sessionId": session_id, "cols": cols, "rows": rows })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::snapshot_bin::{encode_snapshot, EncodeRow, EncodeSpec, ExtendedSnapshotMeta, MODE_FULL};
    use crate::snapshot_bin::CellSpec;
    use std::time::Duration;

    fn tiny(seq: u64) -> Vec<u8> {
        encode_snapshot(EncodeSpec {
            seq,
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
                    ch: "A".into(),
                    width: 1,
                    fg: 0xFFFF_FFFF,
                    bg: 0,
                    attrs: 0,
                }],
            }],
            meta: ExtendedSnapshotMeta::default(),
        })
    }

    #[test]
    fn three_panes_share_one_clock_and_handoff_does_not_kill_the_session() {
        let start = Instant::now();
        let mut deck = NativeDeck::new("kite");
        for id in 1..=3 {
            deck.attach_pane(GpuiTerminalView::new(id, format!("s{id}"), 80, 24))
                .unwrap();
        }
        assert_eq!(deck.grid.pane_count(), 3);
        assert!(deck.attach_pane(GpuiTerminalView::new(4, "s4", 80, 24)).is_ok());
        assert!(deck.attach_pane(GpuiTerminalView::new(5, "s5", 80, 24)).is_err());

        for id in 1..=4 {
            let frames = deck.ingest(id, &tiny(1), start).unwrap();
            assert!(frames.is_empty());
        }
        assert!(!deck.clock.due(start + Duration::from_millis(10)));
        let credits = deck.tick(start + Duration::from_millis(33));
        assert_eq!(credits.len(), 4);
        assert!(credits.iter().all(|frame| frame.kind == crate::core_client::FrameKind::Credit));
        assert!(deck.clock.wait_until(start + Duration::from_millis(34)).is_none());
        assert!(deck.tick(start + Duration::from_millis(66)).is_empty());

        let hidden = deck.hide_pane(2).unwrap();
        assert_eq!(hidden.payload, vec![0, 0]);
        let plan = deck.plan_surface_swap(0).unwrap();
        assert_eq!(plan.detach["method"], "session.detach");
        assert_eq!(plan.attach["method"], "session.attach");
        assert!(plan.detach["method"] != "session.terminate");
        assert!(handoff_met(Duration::from_millis(12)));
        assert!(!handoff_met(Duration::from_millis(51)));
    }
}
