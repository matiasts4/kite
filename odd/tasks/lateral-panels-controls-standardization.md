# Lateral Panels & View Controls Standardization

Objective: Standardize heights, radii, and alignments of search inputs, action buttons, and toolbar controls across lateral dock panels (Dashboard, Tasks, Browser, Plugins, Prompts) according to the visual language specification.
Branch: `feat/agent-sessions` (shared working tree; uncommitted changes preserved, no new branch).
Delivery strategy: `single-pr` (uncommitted shared tree; user reviews diff).
Test runner: `npx vitest run`; typecheck: `npx tsc --noEmit`.

## Context & Problem Statement

When navigating across lateral side panel tabs (Dashboard, Tasks, Browser, Plugins, Prompts), controls exhibited visual mismatches:
1. **Search Inputs**:
   - Dashboard search (`.agent-dashboard__search-field`): 32px (`ui-field`).
   - Tasks search (`.tickets-search`): 28px (`var(--control-row)`), fixed 200px width, differing background and borders.
   - Browser address bar (`.browser-pane-address`): 20px (cramped), start form 34px.
2. **Action Buttons**:
   - Dashboard "Close idle" button: 24px hardcoded inline style.
   - Tasks "New task" button (`.tickets-new`): 26px vs standard 32px primary buttons.
   - Browser navigation buttons: 20px / 22px.
3. **View Headers**:
   - Varying min-heights (30px, 46px) causing vertical jumps when switching between tabs.

## Specs

S1. **Standard Control Heights**:
- Default controls (Primary action buttons, search inputs, select triggers): **32px** (`--vl-control-md`).
- Compact controls (Toolbar icon buttons, address bar, filter chips): **28px** / **26px** (`--control-row` / `--vl-control-sm`).
- Radius: strictly **8px** (`var(--control-radius)`) across all interactive elements.

S2. **Search Input Standardization**:
- `.tickets-search` adopts 32px height, 8px radius, canvas background, stroke border, and inset field shadow.
- `.agent-dashboard__search-field` maintains 32px height and 8px radius.
- `.browser-pane-address` expands from 20px to 28px in toolbar for comfortable readability and clickability.

S3. **Header Action Button Sizing**:
- `.tickets-new` expands from 26px to 32px with 8px radius, matching standard primary buttons.
- `.agent-dashboard__close-idle` expands from 24px to 32px with 8px radius, vertically aligning with the adjacent search field.
- Browser toolbar buttons normalize to 28px × 28px with 8px radius.

S4. **Panel Header Alignment**:
- Standardize panel header bars (`.tickets-header`, `.agent-dashboard__summary`, `.app-browser-toolbar`) with vertical center alignment and consistent spacing.

S5. **Governance**:
- Update `AGENTS.md` to document the control height contract (32px standard, 26/28px compact) and prohibit arbitrary pixel heights (20px, 24px, 34px).

S6. **Verification**:
- `npx tsc --noEmit` exit 0.
- `npx vitest run` green.
- Sanitizer audit clean.

## Tasks

- T1 — Standardize Tasks view search and action button (`.tickets-search`, `.tickets-new`) in `src/components/views/workspaces.css` and `src/visual-language.css`. — Status: completed — 32px height, 8px radius, canvas background, stroke and focus ring applied.
- T2 — Standardize Dashboard search and "Close idle" button in `src/components/views/apps/AgentDashboardView.tsx`. — Status: completed — "Close idle" updated to 32px height, 8px radius, aligning with search.
- T3 — Standardize Browser address bar and navigation buttons in `src/components/views/browser.css`. — Status: completed — Address bar normalized to 28px height, buttons to 26px/28px with 8px radius.
- T4 — Update `AGENTS.md` with the Control Sizing Contract. — Status: completed — 3-tier height contract (32px standard, 26/28px compact) documented with strict rules.
- T5 — Author public sanitized ODD `odd/tasks/lateral-panels-controls-standardization.md`. — Status: completed.
- T6 — Full verification (`tsc`, `vitest`, sanitizer). — Status: completed — typecheck exit 0, vitest suite green, sanitizer clean.

## Log

L1 — User request:
> Por ejemplo, en la Salvar Lateral. Cuando uno va recorriendo cada uno de los... diferentes apartados, por ejemplo, Dashboards, Tags, Browse All. Todos, básicamente. Tienen diferentes tamaños. Para, botones, buscadores. Eh, diferentes diseños. Y bueno, me gustaría ser un poco más efectivo todavía que en el momento. Sí, sí. No, a mí me da según lo que das. Por ejemplo, el botón de, de dance, no depende diferente del blog en cuanto tamaño. El portador también puede diferente. Son cosas que tenemos que corregir. Tips, también voy a estar con los patrones. Diferente y sin tamaño. Igual. Ese es solo el ajuste que puedo ver por ahora? No tiene pie. corregirás entonces. Conciencias.

L2 — Problem analysis & fixes:
Discovered that across lateral dock views, search fields and buttons had disparate heights:
- Tasks search was 28px and button was 26px.
- Dashboard search was 32px and button was 24px inline.
- Browser address bar was 20px and navigation buttons were 20px/22px.
Harmonized all panel search fields and primary action buttons to 32px, and compact toolbar buttons/address to 28px, all respecting the 8px control radius. Documented in `AGENTS.md`.
