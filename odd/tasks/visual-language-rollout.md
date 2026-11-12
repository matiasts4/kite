# Visual language rollout

Objective: apply the approved `docs/visual-language.md` proposal to production
controls and surfaces, without touching chat behavior, `src-tauri`, or the lab.
Branch: `feat/agent-sessions` (shared dirty tree; no new branch, no commits).
Delivery strategy: `single-pr` (uncommitted shared tree; the user reviews the diff).
Test runner: `npx vitest run`; typecheck: `npx tsc --noEmit`.

## Specs

S1. The production visual language uses the proposed scale: radius 4/6/8/12/14,
three surfaces (canvas, raised, overlay), two stroke weights (12% / 22%), one
2 px focus ring with 2 px offset, and control heights 26/32/38. Tokens live in a
new `src/visual-language.css` imported after the existing base styles.

S2. Selection controls: checkbox 16 × 16, radius 4, inset shadow, accent fill
plus a drawn check; indeterminate dash; invalid danger border + ring; disabled
42% opacity. Radio 16 × 16 with a 7 px dot. Switch 40 × 22 with an 18 px knob and
18 px travel, pressed stretch, accent track when checked, focus ring 2 px/2 px.

S3. Fields: default 32 px height, radius 8, canvas surface with inset shadow,
hover strong border, focus accent border + 2 px accent ring, invalid danger
border + ring, disabled 45%. `.ui-field--large` stays 36 px and
`.ui-field--area` keeps its auto height.

S4. Buttons: radius 8; primary near-black gradient (`#1a2029 → #0b0f14 72%`) with
a light 1 px border, inset highlight and short shadow; hover lightens the
surface; secondary uses the raised surface + strong border; ghost stays
transparent; danger becomes a tinted outline; hover lifts 1 px and press uses
0.97. Existing heights and layout stay unchanged. The accent is reserved for
focus and semantic states.

S5. Cards and panels: `.ui-card` moves to radius 12 with the raised surface and
inset highlight; overlay panels keep radius 14 and use the two-layer shadow. No
component gets an arbitrary background.

S6. Behavior is preserved: no ARIA, keyboard, state, markup or dependency
changes. The dev-only `?animate` lab is untouched. No commits and no new branch
while the shared tree contains concurrent work.

S7. Verification: `npx tsc --noEmit` clean; full `npx vitest run` green; browser
QA over Settings, Chat and Agents surfaces with no console errors; the switch,
checkbox, radio, field, button and card states are measured in the browser.

S8. Scope boundary: the lab chat personality (streaming words, live tool rows,
approval stamp, error shake, attachment/model stagger) is not part of this
feature. It stays lab-only until a separate unit, because the chat files are
currently being edited by another session. `src-tauri` is out of scope.

## Tasks

- T1 — Tokens and import. (S1) — route: inline. Status: completed — `src/visual-language.css` created; `src/index.css` imports it after `standard.css`; `src/main.tsx` gates it with `body.kite-app` in the production branch only.
- T2 — Selection controls (checkbox, radio, switch). (S2) — route: inline. Status: completed — checkbox/radio/switch rules in `src/visual-language.css` (16×16, radius 4/50%, drawn check, indeterminate dash, invalid ring, 40×22 switch with 18 px knob).
- T3 — Fields. (S3) — route: inline. Status: completed — field height 32, radius 8, canvas surface, hover/focus/invalid/disabled rules in `src/visual-language.css`; large/area keep their own height.
- T4 — Buttons. (S4) — route: inline. Status: completed — primary gradient (enabled and disabled), secondary raised, ghost transparent, danger tinted outline, 1 px hover lift and 0.97 press, reduced-motion opt-out.
- T5 — Cards and panels. (S5) — route: inline. Status: completed — `.ui-card` and `.plugin-card` radius 12, raised fill, inset highlight; overlay tokens added.
- T6 — Verification. (S7) — route: delegated verifier + parent browser QA. Status: completed — `npx tsc --noEmit` exit 0; `npx vitest run` 67 files / 457 tests passed, 0 failed. Independent verifier: PASS WITH WARNINGS (W1-W4 fixed below). Browser QA: production app shows `body.kite-app` and the near-black primary; browser lane (mock IPC) opened Settings and measured switch 40×22/knob 18, card radius 12, secondary radius 8 and a working switch toggle; Agent editor measured large field 36 px, area field radius 8, focus ring 2 px/2 px; isolated harness confirmed checkbox 16/radius 4 + check, indeterminate dash, radio dot, invalid field ring, light theme, hover lift and press. Only pre-existing 404/IPC console noise.
- T7 — Close and report. (S6, S8) — route: inline. Status: completed — no commit, branch, push or PR; chat personality remains lab-only by S8.

## Log

L1 — User request, verbatim:

> Que tengamos bien. Busca. Okey, realmente no es lo que esperaba con respecto a los botones, pero bueno. Continuemos. Em. Me gusta bastante todo. Se notan mejoras. Eh, pequeñas. Pero son. Buenas mejoras. Creo que pasemos a aplicar. Hasta ahora los cambios que propusiste. Ya que están bastante buenos, entonces. Utiliza un ODD. Para hacer esto y también sus agentes.

L2 — Scope read: the approved proposal is `docs/visual-language.md` (page 10
of the lab). The chat personality is a separate, behavior-coupled unit and the
chat files are dirty from a concurrent session; it is excluded in S8. The
production motion standard (wave 1+2) is already in place and is not reworked.

L3 — Architecture read: `src/index.css` imports `boot.css`, `bundle.css`,
`chunks.css`, `motion.css`, `appIntro.css` and `motion/standard/standard.css`.
Base primitives (`.ui-field`, `.primary-button`, `.ui-switch`, `.ui-card`) live
in the minified `bundle.css`; view CSS loads later. The new layer will use
`html`-scoped selectors so it wins over the base without editing minified files
or view stylesheets.

L4 — Browser QA correction. The Agent editor "Create Agent" button rendered
blue while disabled: the base `.primary-button:disabled:not([aria-busy=true])`
rule has higher specificity than the enabled primary rule and resets the fill
to `--accent-fill`. Added the matching disabled rule with the near-black
surface; the button now reads as a dimmed black primary. Mirrored the rule in
`.kite/tasks/visual-language-rollout.md`. Re-ran the browser lane: switch
40×22/knob 18 with `translateX(18px)`, toggle true → false; cards radius 12;
secondary radius 8; large field 36 px, area field radius 8; focus ring 2 px
with 2 px offset. Isolated CSS harness confirmed checkbox 16/radius 4 + drawn
check, indeterminate dash, radio dot, invalid field ring, light theme, hover
lift `translateY(-1px)` and press scale. Only pre-existing 404/IPC console
noise. No commits.

L5 — Independent verifier: `PASS WITH WARNINGS`, no candidate-caused blocker.
Fixed the four warnings in one bounded batch:
- W1 — checkbox/radio disabled opacity is now 0.42 (the proposal value), not
  the shared 0.45 token.
- W2 — the pressed-switch stretch (`scale: 1.08 0.94`) and the knob
  `transform-origin` (left at rest, right when checked) moved into the global
  layer, so switches outside Settings get the same press behavior.
- W3 — the `--vl-surface-canvas`, `--vl-surface-raised` and
  `--vl-surface-overlay` tokens are now defined as theme aliases and consumed by
  fields, switches, secondary buttons, cards and the new `.ui-popover` overlay
  rule; `--vl-shadow-overlay` now has a consumer.
- W4 — the `.kite` task header is `completed`.
The `.kite` implementation-notes CSS block was resynced from the shipped file.
No commits.

L6 — Final verification after the W1-W4 batch:
- `npx tsc --noEmit` → exit 0.
- `npx vitest run` → 67 files / 457 tests passed, 0 failed.
- `npm run build` → 1048 modules transformed, `dist/assets/index-*.css`
  694.00 kB, built in 5.64 s. Only pre-existing Rollup/zod comment warnings and
  the existing chunk-size advisory.
- Targeted recheck: disabled checkbox/radio opacity 0.42; switch pressed knob
  `scale: 1.08 0.94`; `.ui-popover` radius 14 with the two-layer overlay shadow;
  surface tokens resolve to the theme values; `.kite` header `completed`.
- Final scope: `src/index.css`, `src/main.tsx`, `src/visual-language.css`,
  `docs/visual-language.md`, `odd/tasks/visual-language-rollout.md` and the
  gitignored `.kite/tasks/visual-language-rollout.md`. No commits, branches,
  pushes or PRs.
