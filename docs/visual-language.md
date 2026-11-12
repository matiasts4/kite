# Kite visual language

Status: applied to the production base primitives; the dev-only lab at
`?animate=10` remains the reference.

The motion standard is already adopted. This document covers the other half:
shape, surface, control height, border and focus. The goal is not to change
Kite's color identity; it is to stop mixing values that were chosen one
component at a time.

## Principles

1. **4 px grid.** Every height, gap and padding is a multiple of 4.
2. **Three surfaces.** Canvas, raised and overlay. A component uses one, not an
   arbitrary background.
3. **Two stroke weights.** `12%` at rest, `22%` on hover or emphasis.
4. **One focus ring.** 2 px accent, 2 px offset, everywhere.
5. **Three control heights.** 26 compact, 32 default, 38 hero.
6. **One check language.** Fill first, then the mark draws. No scale on the box.

## Tokens

| Token | Value | Use |
| --- | --- | --- |
| `--vl-radius-xs` | 4 px | Checkbox, keycap |
| `--vl-radius-sm` | 6 px | Chip, tiny button |
| `--vl-radius-md` | 8 px | Control, input, button |
| `--vl-radius-lg` | 12 px | Card, agent tile |
| `--vl-radius-xl` | 14 px | Panel, overlay, dialog |
| `--vl-stroke` | `rgba(255,255,255,.12)` | Resting border |
| `--vl-stroke-strong` | `rgba(255,255,255,.22)` | Hover / emphasis |
| `--vl-focus` | accent | 2 px ring, 2 px offset |
| `--vl-surface-canvas` | `#0b0f14` | Page, well |
| `--vl-surface-raised` | `#161b22` | Card, row, secondary button |
| `--vl-surface-overlay` | `#1c2128` | Menu, dialog, panel |
| `--vl-inset` | `inset 0 1px 0 rgba(255,255,255,.06)` | Raised surfaces |
| `--vl-shadow-md` | `0 14px 28px -18px rgba(0,0,0,.8)` | Hover card |
| `--vl-shadow-lg` | `0 18px 40px -24px rgba(0,0,0,.8)` | Overlay |

## Controls

### Checkbox

- 16 × 16, radius 4, 1 px border, inset shadow.
- Checked: accent gradient fill, then the check draws over 180–220 ms.
- Indeterminate: horizontal dash; same fill.
- Invalid: danger border + 2 px danger ring.
- Disabled: 42% opacity.
- Focus: 2 px accent ring, 2 px offset.

### Radio

- 16 × 16 circle, 1 px border, inset shadow.
- Dot 7 px, accent gradient, `spring.pop`.
- Group gap 2 px; row padding 4/6.

### Switch

- Track 40 × 22, radius pill, 1 px border, inset shadow.
- Thumb 18 × 18, 2 px inset, gradient white, `spring.thumb`.
- Travel 18 px; pressed thumb stretches to 1.08 × 0.94 from the resting edge.
- Checked track: accent gradient; focus ring 2 px with offset.
- The current Kite switch is 44 × 20 with a 26 × 16 thumb; the proposal is
  taller and narrower so the thumb reads as a circle, not a pill.

## Fields

- Height 32 (default) / 26 (compact) / 38 (hero).
- Radius 8, 1 px border, `#0b0f14` surface, inset shadow.
- Hover: border strong. Focus: accent border + 2 px accent ring.
- Label 9.5 px/500; hint 9 px; error uses the danger border and hint.
- Search adds a 13 px icon and an optional `⌘K` keycap.
- Select keeps the native element for behavior, hides the native arrow and
  overlays a 12 px chevron.

## Buttons

| Size | Height | Padding | Font |
| --- | --- | --- | --- |
| sm | 26 | 0 9 | 10 |
| md | 32 | 0 12 | 11 |
| lg | 38 | 0 15 | 11.5 |

- Radius 8.
- Primary: near-black gradient, 1 px light border, inset highlight, short shadow.
  The accent is reserved for focus and semantic states, not for the fill.
- Primary disabled: same near-black surface at the shared disabled opacity; it
  never falls back to the accent fill.
- Secondary: raised surface, strong border, inset highlight.
- Ghost: transparent, hover fill only.
- Danger: danger-tinted outline, not a solid red block.
- Icon: 32 × 32, same radius.
- Hover: lift 1 px on a spring. Press: `scale.press` (0.97).

## Cards and overlays

- Card: radius 12, raised surface, 1 px border, inset highlight.
- Cover/media: 50 px, gradient, clipped by the card radius.
- Hover: lift 3 px, shadow bloom, border strong; press 0.985.
- Selected: accent border + 1 px accent ring.
- Agent tile: radius 12, 30 px avatar, status dot with a soft ring.
- Panel/overlay: radius 14, overlay surface, two-layer shadow, 10–14 px padding.

## Migration order

1. Checkbox/radio/switch (the most visible generic pieces).
2. Inputs/search/select.
3. Buttons and icon buttons.
4. Cards and overlay panels.
5. Replace the one-off values in settings, chat and code panes with the tokens.

Keep the motion standard untouched: shape changes, motion does not.
