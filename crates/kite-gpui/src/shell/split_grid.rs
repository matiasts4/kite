//! One to four proportional terminal cards with a 12px radius and an 11px inner stroke.

use crate::theme;

#[derive(Clone, Debug, PartialEq)]
pub struct PaneSlot {
    pub index: usize,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

#[derive(Clone, Debug)]
pub struct SplitGrid {
    panes: usize,
    pub outer_radius: f32,
    pub inner_radius: f32,
    pub gap: f32,
}

impl SplitGrid {
    pub fn single() -> Self {
        Self {
            panes: 1,
            outer_radius: theme::RADIUS_CARD,
            inner_radius: theme::inner_radius(theme::RADIUS_CARD),
            gap: 8.0,
        }
    }

    pub fn set_pane_count(&mut self, count: usize) {
        self.panes = count.clamp(1, 4);
    }

    pub fn pane_count(&self) -> usize {
        self.panes
    }

    pub fn layout(&self, width: f32, height: f32) -> Vec<PaneSlot> {
        let count = self.panes.max(1);
        let cols = if count <= 1 { 1 } else { 2 };
        let rows = if count <= 2 { 1 } else { 2 };
        let gap_x = if cols == 1 { 0.0 } else { self.gap };
        let gap_y = if rows == 1 { 0.0 } else { self.gap };
        let cell_w = (width - gap_x * (cols as f32 - 1.0)) / cols as f32;
        let cell_h = (height - gap_y * (rows as f32 - 1.0)) / rows as f32;
        (0..count)
            .map(|index| {
                let col = index % cols;
                let row = index / cols;
                PaneSlot {
                    index,
                    x: col as f32 * (cell_w + gap_x),
                    y: row as f32 * (cell_h + gap_y),
                    w: cell_w,
                    h: cell_h,
                }
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cards_use_the_concentric_12_and_11_radii() {
        let mut grid = SplitGrid::single();
        assert_eq!(grid.outer_radius, 12.0);
        assert_eq!(grid.inner_radius, 11.0);
        grid.set_pane_count(4);
        let slots = grid.layout(200.0, 100.0);
        assert_eq!(slots.len(), 4);
        assert!(slots[1].x > slots[0].x);
        assert!(slots[2].y > slots[0].y);
        grid.set_pane_count(9);
        assert_eq!(grid.pane_count(), 4);
    }
}
