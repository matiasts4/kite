# Corner Radius Consolidation & Visual Language Synchronization

Objective: Consolidate Kite's corner radii into a unified semantic token system with centralized CSS variables, Tailwind configuration mapping, and an `AGENTS.md` design governance rule. This eliminates ad-hoc radius declarations across components while preserving the top-bar stadium mode switcher (`Agent | Code | Thread`).
Branch: `feat/agent-sessions` (shared tree; uncommitted changes respected, no new branch).
Delivery strategy: `single-pr` (uncommitted shared tree; user reviews diff).
Test runner: `npx vitest run`; typecheck: `npx tsc --noEmit`.

## Context & Architecture

High-cohesion desktop interfaces achieve visual consistency not by declaring dozens of independent radii, but by anchoring geometry to a minimal set of semantic root variables with mathematically aligned concentric scales.

In Kite, corner radius declarations previously suffered from scattered pixel values (e.g. 2px, 3px, 5px, 7px, 9px, 10px) and missing bindings in `tailwind.config.js`.

Rather than editing hundreds of stylesheet lines individually, this ODD implements an intelligent centralization approach:
1. Alias legacy variables (`--radius-card`, `--radius-row`, `--radius-chip`, `--radius-panel`) directly to the visual language tokens (`--vl-radius-*`) in `src/bundle.css` and `src/visual-language.css`.
2. Configure `tailwind.config.js` to map standard Tailwind utilities (`rounded-sm`, `rounded-md`, `rounded-lg`, `rounded-xl`) and semantic utilities (`rounded-control`, `rounded-card`, `rounded-dialog`) directly to the CSS tokens.
3. Protect the top-bar mode switcher (`TitleBar.tsx` stadium pill) from modification.
4. Establish `AGENTS.md` at root to prevent future agent hallucination.

## Specs

S1. **Semantic Radius Tokens**:
Consolidate corner geometry into 4 semantic tiers:
- `--control-radius: 8px` (`--vl-radius-md`): Interactive controls (buttons, inputs, select triggers, sidebar items, dropdown rows).
- `--card-radius: 12px` (`--vl-radius-lg`): Surfaces and containers (cards, panels, code blocks, preview frames).
- `--dialog-radius: 14px` (`--vl-radius-xl`): Overlays, dialogs, floating modals, main drawers.
- `--chip-radius: 6px` (`--vl-radius-sm`) / `--vl-radius-xs: 4px`: Micro-elements (tags, badges, keyboard hints, checkboxes).
- `--pill-radius: 9999px`: Avatars, stadium selectors, switches, status indicators.

S2. **Global Variable Cascading**:
In `src/bundle.css` and `src/visual-language.css`, alias legacy CSS variables so existing consumer classes automatically inherit the consolidated radii:
- `--radius-panel: var(--vl-radius-xl, 14px);`
- `--radius-card: var(--vl-radius-lg, 12px);`
- `--radius-composer: var(--vl-radius-lg, 12px);`
- `--radius-row: var(--vl-radius-md, 8px);`
- `--radius-tile: var(--vl-radius-md, 8px);`
- `--radius-chip: var(--vl-radius-sm, 6px);`
- `--radius-pill: 9999px;`
- `--control-radius: var(--vl-radius-md, 8px);`

S3. **Tailwind Theme Binding**:
Extend `theme.borderRadius` in `tailwind.config.js`:
- `control: 'var(--control-radius, 8px)'`
- `card: 'var(--card-radius, 12px)'`
- `dialog: 'var(--dialog-radius, 14px)'`
- `sm: 'var(--vl-radius-sm, 6px)'`
- `md: 'var(--vl-radius-md, 8px)'`
- `lg: 'var(--vl-radius-lg, 12px)'`
- `xl: 'var(--vl-radius-xl, 14px)'`
- `full: '9999px'`

S4. **Protected Top Bar Mode Switcher**:
The `TitleBar.tsx` stadium pill toggle (`Agent | Code | Thread`) and its motion indicator (`layoutId="titlebar-mode-toggle-indicator"`) remain strictly unchanged.

S5. **Design System Governance (`AGENTS.md`)**:
Create `AGENTS.md` at repository root defining Kite's agent rules:
- Prohibit hardcoded arbitrary px values (2px, 3px, 5px, 7px, 9px, 10px).
- Mandate the 4-tier radius table.
- Document optical nesting (`before:rounded-[calc(var(--radius)-1px)]`).
- Mark protected zones (TitleBar stadium toggle).

S6. **Verification**:
- `npx tsc --noEmit` exit 0.
- `npx vitest run` green.
- TitleBar mode toggle visual verification in browser.

## Tasks

- T1 — Centralize tokens and legacy variable aliases in `src/visual-language.css` and `src/bundle.css`. (S1, S2) — Status: completed — `--control-radius: 8px`, `--card-radius: 12px`, `--dialog-radius: 14px` declared, legacy aliases `--radius-card`, `--radius-row`, `--radius-chip`, `--radius-panel` mapped in `:root` and `body.kite-app`.
- T2 — Extend `tailwind.config.js` with semantic and standard border radius mappings. (S3) — Status: completed — `control`, `card`, `dialog`, `xs`, `sm`, `md`, `lg`, `xl`, `pill` configured to CSS variables.
- T3 — Author `AGENTS.md` at repository root with design system rules. (S5) — Status: completed — 4-tier radius table, optical nesting guidelines, and prohibition of ad-hoc px values established.
- T4 — Author public sanitized ODD `odd/tasks/corner-radius-consolidation.md`. (S5) — Status: completed.
- T5 — Verification (`tsc`, `vitest`, browser check). (S6) — Status: completed — `npx tsc --noEmit` exit 0; `npx vitest run` 76 files / 508 tests passed, 0 failed; sanitizer audit clean; TitleBar stadium switcher verified unchanged.

## Log

L1 — User request:
> Eh, sí, tendría que corregir, vamos, eso, que no sé si se pudieron quedar varios en el agents.md Eh, cómo están? Quiero que procedamos a corregirlo. Para tener un poco más de sincronización visual. Aunque, el que no me gustaría cambiar. Es el de la zona superior, es de Agent Code y Trail, ese me gusta como se ve, pero de los demás, ya podemos pasar a cambiar. Y corregir visualmente. Además de centralizar tal vez un poco, como dijiste tenemos muchísimas declaraciones. De, eh... de este tipo. Me gustaría hacer algo un poco más... inteligente. Y no declarar. Uno a uno, sino forzar algo como un sistema de variables más globales. Para desarrollarlo, no? Me compásame de plantear un ODD para llegar a implementar.

L2 — Baseline analysis:
Kite codebase contains ~790 `border-radius` references with high dispersion (2px-14px). Tailwind config lacked `borderRadius` definitions, causing agents to guess arbitrary classes. TitleBar mode toggle uses stadium pill styling (`mode-toggle--stadium`) with motion layoutId, which is explicitly protected.

L3 — Execution & Verification:
- `src/visual-language.css` and `src/bundle.css` updated with master radius tokens and aliases.
- `tailwind.config.js` updated with semantic radius scale.
- `AGENTS.md` created with strict design system governance and forbidden ad-hoc px rules.
- Test suite: 76 test files / 508 tests green (0 failed). Typecheck clean. Sanitizer audit clean.
