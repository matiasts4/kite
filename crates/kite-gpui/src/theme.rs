//! Visual-language tokens shared by every native shell surface.
//!
//! Values match the four radius tiers, the three control heights, and the
//! protected stadium mode switcher in `AGENTS.md` / `visual-language.css`.

pub const RADIUS_XS: f32 = 4.0;
pub const RADIUS_SM: f32 = 6.0;
pub const RADIUS_CONTROL: f32 = 8.0;
pub const RADIUS_CARD: f32 = 12.0;
pub const RADIUS_DIALOG: f32 = 14.0;
pub const RADIUS_PILL: f32 = 9999.0;

pub const HEIGHT_STD: f32 = 32.0;
pub const HEIGHT_COMPACT: f32 = 28.0;
pub const HEIGHT_DENSE: f32 = 26.0;
pub const HEIGHT_HERO: f32 = 38.0;

pub const STADIUM_HEIGHT: f32 = 32.0;
pub const STADIUM_PADDING: f32 = 3.0;
pub const STADIUM_GAP: f32 = 2.0;
pub const STADIUM_ITEM_HEIGHT: f32 = 26.0;
pub const STADIUM_ITEM_PAD_X: f32 = 16.0;
pub const STADIUM_ITEM_MIN_WIDTH: f32 = 68.0;
pub const STADIUM_RADIUS: f32 = RADIUS_PILL;
pub const STADIUM_LABELS: [&str; 3] = ["Agent", "Code", "Thread"];

pub const DEFAULT_FG: u32 = 0xE6ED_F3FF;
pub const DEFAULT_BG: u32 = 0x0E11_16FF;
pub const CARD_BG: u32 = 0x161B_22FF;
pub const BORDER: u32 = 0x2A31_3CFF;
pub const ACCENT: u32 = 0x3D8B_FDFF;
pub const TEXT_MUTED: u32 = 0x8388_91FF;
pub const TEXT_ACTIVE: u32 = 0xFFFF_FFFF;

/// Concentric inner radius: `outer - 1px`, never negative.
pub fn inner_radius(outer: f32) -> f32 {
    (outer - 1.0).max(0.0)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShellMode {
    Agent = 0,
    Code = 1,
    Thread = 2,
}

impl ShellMode {
    pub fn label(self) -> &'static str {
        STADIUM_LABELS[self as usize]
    }

    pub fn from_index(index: usize) -> Option<Self> {
        match index {
            0 => Some(Self::Agent),
            1 => Some(Self::Code),
            2 => Some(Self::Thread),
            _ => None,
        }
    }
}

/// Sliding indicator geometry inside the stadium track.
/// The indicator is one item wide and moves by index; padding stays 3px.
pub fn stadium_indicator_x(active: ShellMode) -> f32 {
    let item = STADIUM_ITEM_MIN_WIDTH;
    STADIUM_PADDING + (active as u8 as f32) * (item + STADIUM_GAP)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn radius_and_height_contract() {
        assert_eq!(RADIUS_XS, 4.0);
        assert_eq!(RADIUS_SM, 6.0);
        assert_eq!(RADIUS_CONTROL, 8.0);
        assert_eq!(RADIUS_CARD, 12.0);
        assert_eq!(RADIUS_DIALOG, 14.0);
        assert_eq!(RADIUS_PILL, 9999.0);
        assert_eq!(HEIGHT_STD, 32.0);
        assert_eq!(HEIGHT_COMPACT, 28.0);
        assert_eq!(HEIGHT_DENSE, 26.0);
        assert_eq!(HEIGHT_HERO, 38.0);
    }

    #[test]
    fn optical_nesting_is_one_pixel_inside() {
        assert_eq!(inner_radius(RADIUS_CARD), 11.0);
        assert_eq!(inner_radius(RADIUS_CONTROL), 7.0);
        assert_eq!(inner_radius(0.5), 0.0);
    }

    #[test]
    fn stadium_matches_protected_switcher() {
        assert_eq!(STADIUM_LABELS, ["Agent", "Code", "Thread"]);
        assert_eq!(STADIUM_HEIGHT, HEIGHT_STD);
        assert_eq!(STADIUM_ITEM_HEIGHT, HEIGHT_DENSE);
        assert_eq!(STADIUM_RADIUS, 9999.0);
        assert_eq!(STADIUM_PADDING, 3.0);
        assert!((stadium_indicator_x(ShellMode::Code) - (3.0 + 70.0)).abs() < f32::EPSILON);
    }
}
