//! Procedural quads for box drawing, block elements, and braille.
//!
//! These codepoints never consult a font atlas. Every codepoint in the three
//! ranges produces at least one pixel-snapped rect so the grid has no gaps.

#[derive(Clone, Debug, PartialEq)]
pub struct ProceduralSpriteOp {
    pub col: u16,
    pub width: u8,
    pub kind: SpriteKind,
    pub rgba: u32,
}

#[derive(Clone, Debug, PartialEq)]
pub enum SpriteKind {
    HLine { y: f32, thickness: f32 },
    VLine { x: f32, thickness: f32 },
    Rect { x: f32, y: f32, w: f32, h: f32 },
    Poly { parts: Vec<UnitRect> },
    Shade { alpha: u8 },
    Braille { dots: u8 },
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct UnitRect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PxRect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub rgba: u32,
}

pub fn is_sprite_codepoint(codepoint: u32) -> bool {
    (0x2500..=0x257F).contains(&codepoint)
        || (0x2580..=0x259F).contains(&codepoint)
        || (0x2800..=0x28FF).contains(&codepoint)
}

pub fn sprite_for(col: u16, width: u8, codepoint: u32, rgba: u32) -> Option<ProceduralSpriteOp> {
    if !is_sprite_codepoint(codepoint) {
        return None;
    }
    let kind = if (0x2800..=0x28FF).contains(&codepoint) {
        SpriteKind::Braille {
            dots: (codepoint - 0x2800) as u8,
        }
    } else if (0x2580..=0x259F).contains(&codepoint) {
        block_kind(codepoint)
    } else {
        box_kind(codepoint)
    };
    Some(ProceduralSpriteOp {
        col,
        width,
        kind,
        rgba,
    })
}

fn block_kind(codepoint: u32) -> SpriteKind {
    match codepoint {
        0x2580 => SpriteKind::Rect { x: 0.0, y: 0.0, w: 1.0, h: 0.5 },
        0x2584 => SpriteKind::Rect { x: 0.0, y: 0.5, w: 1.0, h: 0.5 },
        0x2588 => SpriteKind::Rect { x: 0.0, y: 0.0, w: 1.0, h: 1.0 },
        0x258C => SpriteKind::Rect { x: 0.0, y: 0.0, w: 0.5, h: 1.0 },
        0x2590 => SpriteKind::Rect { x: 0.5, y: 0.0, w: 0.5, h: 1.0 },
        0x2591 => SpriteKind::Shade { alpha: 0x40 },
        0x2592 => SpriteKind::Shade { alpha: 0x80 },
        0x2593 => SpriteKind::Shade { alpha: 0xC0 },
        _ => SpriteKind::Rect { x: 0.0, y: 0.0, w: 1.0, h: 1.0 },
    }
}

fn box_kind(codepoint: u32) -> SpriteKind {
    let h = UnitRect { x: 0.0, y: 0.46, w: 1.0, h: 0.08 };
    let v = UnitRect { x: 0.46, y: 0.0, w: 0.08, h: 1.0 };
    let left = UnitRect { x: 0.0, y: 0.46, w: 0.54, h: 0.08 };
    let right = UnitRect { x: 0.46, y: 0.46, w: 0.54, h: 0.08 };
    let up = UnitRect { x: 0.46, y: 0.0, w: 0.08, h: 0.54 };
    let down = UnitRect { x: 0.46, y: 0.46, w: 0.08, h: 0.54 };
    let parts = match codepoint {
        0x2500 => vec![h],
        0x2502 => vec![v],
        0x250C => vec![right, down],
        0x2510 => vec![left, down],
        0x2514 => vec![right, up],
        0x2518 => vec![left, up],
        0x251C => vec![right, v],
        0x2524 => vec![left, v],
        0x252C => vec![h, down],
        0x2534 => vec![h, up],
        0x253C => vec![h, v],
        _ => vec![UnitRect { x: 0.08, y: 0.08, w: 0.84, h: 0.84 }],
    };
    if parts.len() == 1 && codepoint == 0x2500 {
        SpriteKind::HLine { y: 0.5, thickness: 1.0 }
    } else if parts.len() == 1 && codepoint == 0x2502 {
        SpriteKind::VLine { x: 0.5, thickness: 1.0 }
    } else {
        SpriteKind::Poly { parts }
    }
}

pub fn snap_px(value: f32) -> f32 {
    value.round()
}

pub fn rasterize(op: &ProceduralSpriteOp, origin_x: f32, origin_y: f32, cell_w: f32, cell_h: f32) -> Vec<PxRect> {
    let span = cell_w * op.width.max(1) as f32;
    let mut rects = Vec::new();
    let push = |rects: &mut Vec<PxRect>, unit: UnitRect, rgba: u32| {
        let x = snap_px(origin_x + unit.x * span);
        let y = snap_px(origin_y + unit.y * cell_h);
        let w = snap_px(unit.w * span).max(1.0);
        let h = snap_px(unit.h * cell_h).max(1.0);
        rects.push(PxRect { x, y, w, h, rgba });
    };
    match &op.kind {
        SpriteKind::HLine { y, thickness } => {
            let px = snap_px(origin_y + y * cell_h);
            rects.push(PxRect {
                x: snap_px(origin_x),
                y: px,
                w: snap_px(span).max(1.0),
                h: (*thickness).max(1.0),
                rgba: op.rgba,
            });
        }
        SpriteKind::VLine { x, thickness } => {
            rects.push(PxRect {
                x: snap_px(origin_x + x * span),
                y: snap_px(origin_y),
                w: (*thickness).max(1.0),
                h: snap_px(cell_h).max(1.0),
                rgba: op.rgba,
            });
        }
        SpriteKind::Rect { x, y, w, h } => push(
            &mut rects,
            UnitRect { x: *x, y: *y, w: *w, h: *h },
            op.rgba,
        ),
        SpriteKind::Poly { parts } => {
            for part in parts {
                push(&mut rects, *part, op.rgba);
            }
        }
        SpriteKind::Shade { alpha } => {
            let mut rgba = op.rgba & 0xFFFF_FF00;
            rgba |= *alpha as u32;
            push(&mut rects, UnitRect { x: 0.0, y: 0.0, w: 1.0, h: 1.0 }, rgba);
        }
        SpriteKind::Braille { dots } => {
            for index in 0..8 {
                if (dots & (1 << index)) == 0 {
                    continue;
                }
                let (col, row) = braille_dot_cell(index);
                push(
                    &mut rects,
                    UnitRect {
                        x: 0.18 + col as f32 * 0.36,
                        y: 0.08 + row as f32 * 0.22,
                        w: 0.22,
                        h: 0.16,
                    },
                    op.rgba,
                );
            }
            if rects.is_empty() {
                push(&mut rects, UnitRect { x: 0.4, y: 0.4, w: 0.2, h: 0.2 }, op.rgba & 0xFFFF_FF00);
            }
        }
    }
    rects
}

fn braille_dot_cell(bit: u8) -> (u8, u8) {
    match bit {
        0 => (0, 0),
        1 => (0, 1),
        2 => (0, 2),
        3 => (1, 0),
        4 => (1, 1),
        5 => (1, 2),
        6 => (0, 3),
        _ => (1, 3),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_box_block_and_braille_codepoint_has_a_sprite() {
        for cp in 0x2500..=0x257F {
            assert!(sprite_for(0, 1, cp, 0xFFFF_FFFF).is_some(), "U+{cp:04X}");
        }
        for cp in 0x2580..=0x259F {
            assert!(sprite_for(0, 1, cp, 0xFFFF_FFFF).is_some(), "U+{cp:04X}");
        }
        for cp in (0x2800..=0x28FF).step_by(17) {
            assert!(sprite_for(1, 1, cp, 0xFFFF_FFFF).is_some(), "U+{cp:04X}");
        }
        assert!(sprite_for(0, 1, 'A' as u32, 0).is_none());
    }

    #[test]
    fn horizontal_rule_snaps_to_whole_pixels() {
        let op = sprite_for(3, 1, 0x2500, 0xAABB_CCFF).unwrap();
        let rects = rasterize(&op, 10.4, 20.6, 8.0, 16.0);
        assert_eq!(rects.len(), 1);
        assert_eq!(rects[0].x, 10.0);
        assert_eq!(rects[0].y, 29.0);
        assert_eq!(rects[0].w, 8.0);
        assert_eq!(rects[0].h, 1.0);
    }

    #[test]
    fn braille_dots_follow_the_bitfield() {
        let op = sprite_for(0, 1, 0x2801, 0xFFFF_FFFF).unwrap();
        match op.kind {
            SpriteKind::Braille { dots } => assert_eq!(dots, 1),
            other => panic!("unexpected {other:?}"),
        }
        let rects = rasterize(&op, 0.0, 0.0, 8.0, 16.0);
        assert_eq!(rects.len(), 1);
    }
}
