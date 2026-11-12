//! Protected stadium switcher and the WebView handoff control.

use serde_json::{json, Value};
use std::time::Duration;

use crate::theme::{self, ShellMode};

pub const HANDOFF_BUDGET: Duration = Duration::from_millis(50);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SurfaceKind {
    NativeGpu,
    WebView,
}

#[derive(Clone, Debug, PartialEq)]
pub struct HandoffPlan {
    pub from: SurfaceKind,
    pub to: SurfaceKind,
    pub detach: Value,
    pub attach: Value,
}

#[derive(Clone, Debug)]
pub struct TitleBar {
    pub mode: ShellMode,
    pub surface: SurfaceKind,
    pub indicator_x: f32,
    pub resource_badge: String,
}

impl TitleBar {
    pub fn new() -> Self {
        Self {
            mode: ShellMode::Agent,
            surface: SurfaceKind::NativeGpu,
            indicator_x: theme::stadium_indicator_x(ShellMode::Agent),
            resource_badge: "live".into(),
        }
    }

    pub fn set_mode(&mut self, mode: ShellMode) {
        self.mode = mode;
        self.indicator_x = theme::stadium_indicator_x(mode);
    }

    /// Spring step toward the active pill. Geometry (32px track, 3px pad, 26px item) stays fixed.
    pub fn step_indicator(&mut self, stiffness: f32) {
        let target = theme::stadium_indicator_x(self.mode);
        self.indicator_x += (target - self.indicator_x) * stiffness.clamp(0.0, 1.0);
    }

    pub fn plan_handoff(session_id: &str, channel_id: u32, cols: u16, rows: u16) -> HandoffPlan {
        HandoffPlan {
            from: SurfaceKind::NativeGpu,
            to: SurfaceKind::WebView,
            detach: json!({
                "jsonrpc": "2.0",
                "method": "session.detach",
                "params": { "sessionId": session_id, "channelId": channel_id }
            }),
            attach: json!({
                "jsonrpc": "2.0",
                "method": "session.attach",
                "params": {
                    "sessionId": session_id,
                    "mode": "snapshot_bin",
                    "cols": cols,
                    "rows": rows,
                    "live": true
                }
            }),
        }
    }

    pub fn swap_surface(&mut self) -> SurfaceKind {
        self.surface = match self.surface {
            SurfaceKind::NativeGpu => SurfaceKind::WebView,
            SurfaceKind::WebView => SurfaceKind::NativeGpu,
        };
        self.surface
    }
}

impl Default for TitleBar {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stadium_labels_and_indicator_stay_on_the_protected_track() {
        let mut bar = TitleBar::new();
        assert_eq!(theme::STADIUM_LABELS.len(), 3);
        assert_eq!(bar.mode.label(), "Agent");
        bar.set_mode(ShellMode::Thread);
        assert!((bar.indicator_x - theme::stadium_indicator_x(ShellMode::Thread)).abs() < f32::EPSILON);
        bar.indicator_x = 0.0;
        bar.step_indicator(1.0);
        assert!((bar.indicator_x - theme::stadium_indicator_x(ShellMode::Thread)).abs() < f32::EPSILON);
        assert_eq!(theme::STADIUM_HEIGHT, 32.0);
        assert_eq!(theme::STADIUM_ITEM_HEIGHT, 26.0);
        assert_eq!(theme::inner_radius(theme::RADIUS_CONTROL), 7.0);
    }
}
