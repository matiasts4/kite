# Top-Bar Popovers Visual Overhaul

Objective: Upgrade the expanded popover views of Kite Code's four top-bar surfaces (Agent Updates, System Resource Monitor, Subscription Quota Monitor, and Notifications) from generic boxy inline-styled panels to a cohesive, bespoke Kite Studio visual system using crisp native SVG iconography (zero emojis) and design tokens, while keeping collapsed top-bar triggers untouched.
Branch: feat/remote-control. Delivery strategy: ask-on-risk. Test runner: `npx vitest run`, `npx tsc --noEmit`, `npm run verify:gate`.
Does not change protected zones (`TitleBar.tsx` mode switcher) or collapsed top-bar badge triggers.

## Specs

- **S1 — Cohesive Kite Studio Popover Architecture (Expanded Views Only)**:
  - Verbatim:
    > "Mira, me gustaría mejorar una serie de componentes que creo que se están quedando atrás en cuanto a visualización. O sea, en cuanto al aspecto. Que bueno, son todos los componentes superiores. Tanto el de actualizaciones, de monitor de recursos, el de monitor de cuota. El de notificaciones."
    > "lo que me disgusta no es como su contenido, o sea, no es como su vista. Contraída, sino que su vista expandida de cada uno, eso es lo que no me gusta."
    > "Siento que está como muy genérico realmente, ese es mi problema."
  - Behavior: Keep all collapsed top-bar triggers (`TitleBar.tsx`, `AgentUpdatesBadge`, `SystemResourceBadge`, `SubscriptionQuotaBadge`, notification bell) unchanged. Unify all four expanded popovers under a shared Kite Studio popover surface architecture (`--dialog-radius: 14px`, specular top rim `--vl-inset`, layered overlay shadows, three-tier surface stratification, recessed segmented tracks, tactile buttons, tabular numerals, proper `:hover` / `:active` / `:focus-visible` states, light/dark/glass parity, zero static inline style props, zero hardcoded hex colors, zero arbitrary pixel radii/heights).
  - Checks: `npm run verify:design`, `npm run verify:ipc`, `npx tsc --noEmit`.

- **S2 — Crisp Native SVG Iconography (Zero Emojis)**:
  - Verbatim:
    > "Y claro, no me gusta que hayan emojis ni ese tipo de cosas. Siglos, íconos, nativos. De, no lo sé, arte o cualquier otro, pero ese tipo de cosas."
  - Behavior: Remove every emoji and raw Unicode glyph (`✨`, `⚠️`, `📁`, `🖥️`, `🤖`, `💻`, `▶`, `✕`, `→`) from all four expanded popovers and sub-tabs, replacing them with crisp, uniform stroke SVG icons.
  - Checks: Unit tests asserting zero emoji glyphs rendered in `AgentUpdatesPopover`, `SystemResourcePopover` (all tabs), `SubscriptionQuotaPopover`, and `NotificationsView`; visual inspection of captured CDP screenshots.

- **S3 — Agent Updates & Notifications Expanded Popover Overhaul**:
  - Verbatim:
    > "Tanto el de actualizaciones... El de notificaciones... podríamos mejorar bastante esa parte."
  - Behavior:
    - `AgentUpdatesPopover`: Migrate all inline styles to dedicated CSS tokens; elevate header, agent update cards (pedestal logo frame, monospace version diff pills `vX → vY`, Kite tactile primary/running/done/retry actions), SVG-based empty state, and command-bar footer.
    - `AppNotificationsPopover` / `NotificationsView` (`notifications.css`): Align outer overlay shell to `--dialog-radius: 14px` and studio elevation, polish header with double-check SVG on `Mark all read` (preserving zero clutter buttons contract), add hairline section headers, upgrade notification rows (2-line clamped detail text, left accent unread bar, semantic icon tiles, tactile hover states), polish `AutoSwitchConfirmCard`, empty state, and footer.
  - Checks: `npx vitest run src/components/updates/AgentUpdates.test.tsx src/components/views/NotificationsView.test.tsx`.

- **S4 — Subscription Quota Monitor Expanded Popover Overhaul**:
  - Verbatim:
    > "el de monitor de cuota... su vista expandida... Siento que está como muy genérico realmente"
  - Behavior: Migrate `SubscriptionQuotaPopover`, `QuotaPopoverHeader`, `QuotaPopoverContent`, and `QuotaAccountSwitcher` from inline styles to modular token CSS. Hide unused scroll arrows when provider tabs do not overflow, add elevated active provider caps and uniform `26px` header icon buttons, craft an instrument-grade Hero Quota Card (44px precision ring + logo pedestal, tonal ambient health wash, bold tabular readout, clock-icon countdown, integrated plan/identity metadata strip), upgrade the Account Switcher bar and opaque vault drawer (`--menu-plate`, `32px` recessed field, crisp profile rows), elevate model window meters and diagnostic/empty cards, and keep all multi-account sync and stale/partial-exhaustion contracts passing.
  - Checks: `npx vitest run src/components/quota/SubscriptionQuota.test.tsx src/components/quota/UnifiedAccountSync.test.tsx`.

- **S5 — System Resource Monitor Expanded Popover Overhaul & Compositor Perf Guarantee**:
  - Verbatim:
    > "de monitor de recursos... su vista expandida... no me gusta que hayan emojis"
  - Behavior: Migrate `SystemResourcePopover`, `OverviewTab`, `MemoryProcessTab`, `CpuTab`, `DiskTab`, `ContextTab`, and `TelemetryGauges` to modular token CSS while strictly preserving opaque `var(--menu-plate)` background, `backdrop-filter: none`, `contain: layout style paint`, compositor-isolated `.system-resource-popover__scroll` (`transform: translateZ(0)`, `will-change: scroll-position`), and zero nested `overflow-y: auto` scroll traps. Upgrade `Sparkline` with a live endpoint dot and `CircularGauge` with refined proportions; add a unified multi-segment horizontal memory allocation bar in the RAM hero card; replace all emojis in `MemoryProcessTab` with crisp stroke SVGs; upgrade segmented tabs, Overview bento cards, diagnostics strip, transport grid, CPU/Disk/Context cards, and the compact footer dock (`26px` segmented controls).
  - Checks: `npx vitest run src/components/telemetry/SystemResourceBadge.test.tsx src/components/telemetry/tabs/ContextTab.test.tsx`.

- **S6 — Tier 3 Quality Gate & Independent Visual Verification**:
  - Verbatim:
    > "quisiera que lo hicieras como tal."
  - Behavior: Run full Tier 3 `npm run verify:gate` (including `verify:ipc`, `verify:design`, `audit-references.mjs --check`, `tsc`, affected Vitest suites, and Desktop CDP E2E at `1366x840` and `960x680` with live screenshots of the expanded top-bar popovers) and obtain `APPROVE` from a fresh read-only Lane 4 Independent QA & Visual Verifier inspecting every captured PNG and `process-logs.txt`.
  - Checks: `npm run verify:gate` (`VERDICT: PASS`) + Lane 4 Verifier `APPROVE`.

## Tasks

- [ ] **T1** (`S1`, Risk: `none`, route: `inline`): Create shared Kite Studio top-bar popover stylesheet (`src/components/titlebar/topbar-popovers.css`) and shared crisp SVG icon primitives (`src/components/titlebar/TopbarPopoverIcons.tsx`) using only semantic visual-language tokens (zero hex colors, zero arbitrary radii/heights).
- [ ] **T2** (`S1`, `S2`, `S3`, Risk: `none`, route: `inline`): Overhaul `AgentUpdatesPopover` (component + `agent-updates-popover.css`) and `AppNotificationsPopover` / `NotificationsView` (`notifications.css`), removing all emojis and inline static styles, and add/update Vitest regression checks.
- [ ] **T3** (`S1`, `S2`, `S4`, Risk: `none`, route: `inline`): Overhaul `SubscriptionQuotaPopover`, `QuotaPopoverHeader`, `QuotaPopoverContent`, and `QuotaAccountSwitcher` with modular `quota-popover.css`, preserving all multi-account vault and stale/exhaustion contracts.
- [ ] **T4** (`S1`, `S2`, `S5`, Risk: `item 3 (preserves compositor-isolated opaque plate and scroll FPS contract in SystemResourcePopover)`, route: `inline`): Overhaul `SystemResourcePopover`, `TelemetryGauges`, `OverviewTab`, `MemoryProcessTab`, `CpuTab`, `DiskTab`, and `ContextTab`/`ContextTab.css` with `telemetry-popover.css`, zero emojis, unified allocation bar, and intact scroll/opaque-plate guarantees.
- [ ] **T5** (`S6`, Risk: `item 3 (adds Desktop CDP verification coverage for expanded top-bar popovers)`, route: `inline`): Add/verify Desktop CDP E2E coverage capturing live screenshots of the expanded top-bar popovers at `1366x840` and `960x680`, then run `npm run verify:gate` (scoped to this feature's changed files) and confirm `VERDICT: PASS`.
- [ ] **T6** (`S6`, Risk: `item 3 (Tier 3 visual gate across four top-bar popover domains)`, route: `delegated`): Run fresh read-only Lane 4 Independent QA & Visual Verifier over `verifier-handoff.md`, `report.json`, `process-logs.txt`, and all captured PNGs; fix any defect found, sync ODD + Engram mirror, and close with final `Risk:` line.

## Log

- **L1 (2026-11-26)**:
  > "Mira, me gustaría mejorar una serie de componentes que creo que se están quedando atrás en cuanto a visualización. O sea, en cuanto al aspecto. Que bueno, son todos los componentes superiores. Tanto el de actualizaciones, de monitor de recursos, el de monitor de cuota. El de notificaciones. Básicamente siento que todos esos son. Tienen muchos puntos de mejora y deberían. Poder. Mejorarse visualmente, claro. Entonces, quisiera que lo hicieras como tal."
- **L2 (2026-11-26)**:
  > "O sea, mira, lo que, lo que me disgusta no es como su contenido, o sea, no es como su vista. Contraída, sino que su vista expandida de cada uno, eso es lo que no me gusta. Creo que podríamos mejorar bastante esa parte. Y claro, no me gusta que hayan emojis ni ese tipo de cosas. Siglos, íconos, nativos. De, no lo sé, arte o cualquier otro, pero ese tipo de cosas. Entonces, no lo sé, podríamos mejorar bastante en esa, en esas partes. Siento que está como muy genérico realmente, ese es mi problema."
  - Scope locked: Expanded views of all four top-bar popovers only (Updates, Resource Monitor, Quota Monitor, Notifications); collapsed top-bar triggers and protected `TitleBar.tsx` mode switcher remain untouched. Forecast: ~900–1300 authored changed lines across 4 popover domains + shared CSS/icons + tests (ask-on-risk delivery strategy).
