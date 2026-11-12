# Kite motion standard

The Animate UI motion system validated in the `?animate` lab is Kite's production
motion standard. The lab is the reference; production code imports the shared
tables under `src/motion/standard/`.

## Source of truth

| File | Owns |
| --- | --- |
| `src/motion/standard/tokens.ts` | Springs, tweens, curves, scale, blur and shift values. |
| `src/motion/standard/context.tsx` | `MotionProvider`, `useMotionStandard()`, `useReduceMotion()`. |
| `src/motion/standard/surfaces.ts` | `surfaceMotion(kind)` entry/exit props for dialogs, popovers, menus, sheets, toasts, panels and scrims. |
| `src/motion/standard/standard.css` | CSS-only press values and global duration/easing tokens. |

Never hand-type a spring that a role token covers. If a new role is needed, add
it to `tokens.ts` first.

## Role tokens

| Token | Use |
| --- | --- |
| `spring.press` | Press feedback on any control. |
| `spring.pop` | Tooltips, popovers, anchored toasts. |
| `spring.dialog` | Dialogs and alerts. |
| `spring.toast` | Toasts entering from an edge. |
| `spring.selection` | Indicators moving between tabs or segments. |
| `spring.highlight` | A surface following the pointer or the selected row. |
| `spring.reflow` | Items making room in a list. |
| `spring.thumb` | Switch thumbs and stretch. |
| `spring.number` | Numbers and bars rolling to a value. |
| `spring.bounce` | Marks that pop: checks, radios, grouped arrivals. |
| `transition.dismiss` | Every exit. Exits are always faster than entries. |
| `transition.swap` | Two labels or icons changing in place. |
| `transition.shake` | Error marks. |

## Rules

1. **Entry on a role spring, exit on a short tween.** Use
   `surfaceMotion(kind)`; do not write ad-hoc `initial`/`exit` objects for a
   surface that already has a kind.
2. **Transform and opacity only.** Animated `height` is allowed only for a
   disclosure. Never animate `width`, `top`, `left` or `box-shadow` on a large
   surface.
3. **Origin matters.** An anchored surface scales from its trigger. Use
   `surfaceOrigin(side)` or set `transformOrigin` explicitly.
4. **Indicators share a layout id.** Tabs, segmented controls, sidebar selection
   and pagination use one `layoutId` and `spring.selection`, not a new keyframe.
5. **Interruption is expected.** Springs retarget; a second click must not
   restart the animation. Never gate motion on a timeout when the state already
   changed.
6. **Exits keep the surface mounted.** Use `AnimatePresence` (or a presence
   timer that matches the exit duration). A surface must not disappear before
   its exit plays.
7. **Reduced motion removes transforms, not feedback.** `MotionProvider` sets
   `MotionConfig reducedMotion="always"` and `html[data-motion="reduce"]`; CSS
   fallbacks must honor both.
8. **Focus, ARIA and keyboard behavior never change for motion.** A conversion
   is not complete if focus return or an ARIA role regressed.
9. **The lab is dev-only.** Production code must not import
   `src/motion/animate/**`.

## Usage

```tsx
import { AnimatePresence, motion } from 'motion/react';
import { surfaceMotion, surfaceOrigin } from '../../motion/standard/surfaces';

<AnimatePresence>
  {open && (
    <motion.div
      {...surfaceMotion('popover')}
      transition={springs.pop}
      style={{ transformOrigin: surfaceOrigin('top') }}
    >
      {children}
    </motion.div>
  )}
</AnimatePresence>
```

```tsx
import { motion } from 'motion/react';
import { springs } from '../../motion/standard/tokens';

<motion.span layoutId="tabs-indicator" transition={springs.selection} />
```

```css
/* CSS-only press for controls that cannot mount Motion. */
.my-control {
  transition: scale var(--duration-press) var(--motion-spring);
}
.my-control:active:not(:disabled) {
  scale: var(--press-scale);
}
```

## Adoption status

| Surface | State |
| --- | --- |
| Notification popover (`App.tsx`) | Converted to `AnimatePresence` + `surfaceMotion('popover')`. |
| `Sheet` | Converted to `motion.dialog`, `spring.dialog`, 200 ms dismiss. |
| `SelectMenu` | Converted to origin-aware `spring.pop`, gliding highlight/check. |
| `AgentPaneResumeModal`, `AccountSwitcherModal`, `AppIntro` | Converted to `surfaceMotion('dialog'/'scrim')`; splash mark keeps its pop. |
| `Sidebar`, `RightDock` | Converted to `surfaceMotion('panel-left'/'panel')`; width stays instant. |
| Quota, telemetry and sidebar context popovers | Converted to `surfaceMotion('popover'/'menu')`. |
| `ui-switch`, `ui-segmented`, primary/secondary/danger buttons | Standard press and spring travel in CSS; every segmented group has a gliding `SegmentedIndicator`. |
| Settings rail | Selection glides on `spring.selection`. |
| Agent and thread rosters | Rows reflow on `spring.reflow`. |
| Quota handoff banner, saved badge | Banner enters on `spring.toast`; the badge swaps with blur. |
| Chat transcript rows | New rows enter on `tweens.reveal`; the live edge and grouping are unchanged. |
| Diff/terminal/data surfaces | Pending. |

## Migration checklist

- [ ] The public props and class names are unchanged.
- [ ] Entry uses a role token; exit is faster and is not cut by a timer.
- [ ] Reduced motion keeps opacity/blur and removes transforms.
- [ ] Keyboard, focus return and ARIA are unchanged.
- [ ] No animated width/height on a large surface.
- [ ] `npx tsc --noEmit` and the surface's tests pass.
- [ ] The dev lab still renders the same behavior at `?animate`.
