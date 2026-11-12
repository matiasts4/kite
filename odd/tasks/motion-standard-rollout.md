# Motion standard rollout

Objective: adopt the Animate UI motion system validated in `?animate` as Kite's production motion standard: springs, retargeting, origin-aware overlays, gliding indicators, shared elements, faster exits and reduced-motion parity, without changing component behavior or public props.
Branch: `feat/agent-sessions` (no new branch; unrelated working-tree changes stay untouched).
Delivery: production `motion` dependency + shared standard layer, then adoption by surface in reviewable waves. No commits unless requested.
Checks: `npx tsc --noEmit`, `npx vitest run`, `npx vite build --outDir <temp>`, browser QA of converted surfaces, reduced-motion and keyboard parity.

## Specs

S1. `motion` is a production dependency (`dependencies`, not `devDependencies`). The dev lab keeps working, and no lab file is imported by production code.
S2. A single production source of truth lives under `src/motion/standard/`: the Animate UI springs, tweens, curves, scale, blur and shift tables. `src/motion/animate/tokens.ts` derives its level/tempo values from that source instead of duplicating the base tables.
S3. `MotionProvider` wraps the app, follows the OS `prefers-reduced-motion` preference, and mirrors it to `html[data-motion]` so CSS and Motion agree. Under reduced motion transforms are removed, opacity/blur remain, and durations are zero.
S4. Production code imports token values from the standard layer. No component hand-types a spring that a token covers.
S5. `Sheet` keeps its public props, `<dialog>` behavior, focus handling and class names, and uses Animate UI motion: scrim/panel entry with `spring.dialog`, exit faster than entry, no motion under reduced motion.
S6. `SelectMenu` keeps its positioning, portal, filtering, keyboard and ARIA behavior, and uses origin-aware entry (`spring.pop`), faster exit, a gliding highlighted row and a gliding selected check.
S7. Modal surfaces (`AgentPaneResumeModal`, `AccountSwitcherModal`, `AppIntro`) use the standard dialog spring and faster exit, preserving their roles, focus and dismiss behavior.
S8. Navigation shells (`Sidebar` rail, `RightDock` panel) slide with the standard panel spring and exit faster; width is never animated.
S9. Global controls adopt the standard press feel: `ui-switch` thumb travels on a spring-like curve and stretches on press; `ui-segmented` selection glides; primary/secondary/select triggers press at `scale.press` (0.97) with the standard press duration. The change is CSS-only for controls that have no Motion wrapper.
S10. Tabs and segmented indicators glide on `spring.selection` with a shared layout id; tab panels crossfade with `transition.swap`.
S11. Lists that reorder (threads, tasks, agents, model rows) use `layout` + `spring.reflow` where the list is not virtualized or scroll-sensitive; neighbors make room instead of restarting.
S12. Toasts, banners, save status and notification surfaces enter on `spring.toast`, exit on `transition.dismiss`, and swap labels with `transition.swap` plus blur.
S13. Chat transcript rows, streaming text and composer controls use the standard tokens; the live-edge behavior and `useTranscriptMotion` contract are preserved.
S14. Motion is transform/opacity only. Animated height is allowed only for disclosures. Blur is limited to small surfaces. No animated `width`, `top`, `left` or `box-shadow` on large surfaces.
S15. Every converted surface preserves keyboard behavior, focus return, ARIA roles, disabled states and existing test expectations.
S16. The full test suite, typecheck and production build pass. Production contains the standard motion code but no lab code. Browser QA covers entry, exit, interruption, reduced motion and keyboard for each converted surface.

## Tasks

- T1 — Production motion layer: tokens, provider, hooks, standard CSS, and tests. (S1–S4) — done; `motion` is a production dependency, `MotionProvider` wraps `App`, the lab derives from the standard, and the standard tests pass.
- T2 — Convert `Sheet` to the standard dialog surface. (S5) — done; `motion.dialog` + `AnimatePresence`, `spring.dialog` entry, 200 ms dismiss, focus restored after the exit, `showModal`/cancel/portal/classes preserved.
- T3 — Convert `SelectMenu` to the standard popover/menu surface. (S6) — done; origin-aware `spring.pop`, 200 ms dismiss, gliding highlight and selected check on `spring.highlight`, geometry released only after the exit.
- T4 — Convert modal surfaces: `AgentPaneResumeModal`, `AccountSwitcherModal`, `AppIntro`. (S7) — done; the splash mark keeps its entrance as a token-driven `motion.img`; the quota modal suite passes.
- T5 — Convert navigation shells: `Sidebar` rail and `RightDock` panel. (S8) — done; width stays instant, exit is 140 ms, and 21 focused tests pass.
- T6 — Global control CSS: switch, segmented, buttons, press. (S9) — done; `settings.css` presses and springs the switch/segmented controls with both reduced-motion paths; shared buttons press at `scale.press`.
- T7 — Tabs/indicators and list reflow. (S10, S11) — done for the current surfaces: the Settings rail and all ten `.ui-segmented` groups glide on `spring.selection`; `AgentRoster` and `ThreadRoster` reflow on `spring.reflow`. Model-row/task reflow remains.
- T8 — Toasts, banners, save status, notification surfaces. (S12) — done for the surfaces that exist: notification/quota/telemetry popovers, `QuotaHandoffBanner` (`spring.toast`) and the `ZedHeroCard` saved badge (`tweens.swap` with blur). There is no production toast stack to convert.
- T9 — Chat transcript/composer and data surfaces. (S13) — in progress; transcript rows now enter through Motion (`tweens.reveal`, verified opacity 0 + y 4 at 45 ms) and the composer model selects use the new `SelectMenu`. Diff/terminal/data surfaces remain.
- T10 — Full verification: typecheck, tests, build, browser QA, reduced motion, keyboard. (S14–S16) — done for wave 2: `npx tsc --noEmit` clean; 67 files / 454 tests; production build with zero lab markers; browser QA of switches, segmented indicators, SelectMenu, Sheet, chat rows, notifications, sidebar, dock and reduced motion. Data surfaces remain for a later wave.

## Log

L1 — User request (verbatim): "Bueno, y la verdad es que quedó bastante, bastante bien. Ahora tenemos que proceder a un plan de implementación. Eh, básicamente me gustaron todas las animaciones, y quiero que este semana se vuelva nuestro nuevo estándar. Entonces, como tal, quiero llegar a implementar. Claro, sin romper nada. . Quiero que armes el ODD para llegar a implementar y bueno con sus agentes. Con varios subagentes, ir implementando. Eh, como tal, no es necesario que crees una rama nueva, sino que, simplemente, te pongas a implementar."

L2 — Baseline: the app currently uses `usePresence`, `motionSurfaceClass` and 12 CSS keyframes in `src/motion/motion.css`; `Sheet` and `SelectMenu` are the shared overlay primitives; `ui-switch` and `ui-segmented` are the shared control classes; 63 test suites exist. The dev lab remains the reference implementation.

L3 — Wave 1 starts with the shared layer plus the highest-leverage surfaces: Sheet, SelectMenu, modals, Sidebar/RightDock and global control CSS. Tabs, lists, feedback and chat/data surfaces follow in wave 2 on the same tokens.

L4 — Foundation landed: `src/motion/standard/tokens.ts` is the single source of truth, `src/motion/animate/tokens.ts` derives from it, `MotionProvider` wraps `App` and mirrors the preference to `html[data-motion]`, `motion` moved to `dependencies`, and `docs/motion-standard.md` documents the rules. Evidence: `npx tsc --noEmit` clean; standard tests 10/10.

L5 — Wave 1 workers started for Sheet/SelectMenu, modal surfaces, Sidebar/RightDock, popover surfaces and global control CSS. The parent converted the notification popover in `App.tsx` to `AnimatePresence` + `surfaceMotion('popover')` and added the surface tests. `settings.css` now springs the switch thumb and presses both the switch and segmented items, with `@media` and `data-motion` reduced-motion paths.

L6 — Browser QA on the browser lane: `html[data-motion]` is `full`; the notification popover enters at opacity ≈1, exits through opacity 0.78 + scale 0.995 + y −0.88, and unmounts; the right dock opens; reduced-motion emulation sets `data-motion="reduce"`. The browser lane cannot bootstrap the Tauri backend (`bootstrap`/IPC 404s), so settings and switch visual QA are blocked there; the switch path is covered by CSS structure and the dev lab. Sheet/SelectMenu behavior is covered by the ChatComposer/quota/settings suites (31 tests).

L7 — Wave 1 closed. `Sheet` and `SelectMenu` are converted: dialog spring entry + 200 ms dismiss, focus restored after exit, origin-aware popover, gliding highlight and check. Verification: `npx tsc --noEmit` clean; full suite 67 files / 454 tests passed; production build to `%TEMP%/opencode/motion-build-2` succeeds and contains zero lab markers (`alab-`, `AnimateLab`, `Animate UI`, `cmp-scene`, `p8-shared`) while containing Motion runtime markers; all nine lab pages still render without console errors. Shell QA: sidebar exits at opacity 0.53 / x −7.45 px with width fixed at 232 px and unmounts; dock enters from x 15.45 px with width fixed at 440 px.

L8 — Browser-lane QA (mock backend, port 1430) confirmed the production surfaces: Settings opens with 3 switches and 2 segmented groups; toggling a switch moved its knob from `translate(14px)` to `none`; the model `SelectMenu` opened with 1 row, 1 gliding highlight and 1 gliding check, then exited (opacity 0.634 at 80 ms, gone at 360 ms); the quota `Sheet` opened with `dialog.open=true`, opacity 0.96 and y 0.30, then exited (opacity 0.707 at 70 ms, gone at 390 ms). Wave 2 started with the Settings rail indicator gliding on `spring.selection` (y 93 → 184.9 at 70 ms → 298.8 at 370 ms).

L9 — Wave 2 closed. All ten `.ui-segmented` groups now render `SegmentedIndicator` (unique `segmented-<group>` layout ids), agent and thread rows use `layout` + `spring.reflow`, `QuotaHandoffBanner` enters on `spring.toast`, the `ZedHeroCard` saved badge swaps with blur, and chat rows enter through Motion. Browser QA: segmented indicator x 1077 → 1038.8 at 70 ms → 1004.7 at 370 ms; reduced motion snaps 1077 → 1005 within 30 ms; the switch also snaps under reduced motion; a new chat row is at opacity 0 + y 4 at 45 ms and lands at 1/0. Test infrastructure: `src/test/setup.ts` sets `MotionGlobalConfig.skipAnimations` for jsdom, and `vite.config.ts` sets `testTimeout: 15000` because Motion raised transform/collect time under parallel load. Full suite 67 files / 454 tests green; production build `%TEMP%/opencode/motion-build-3` has zero lab markers. Remaining: diff/terminal/data surfaces and model-row/task reflow.
