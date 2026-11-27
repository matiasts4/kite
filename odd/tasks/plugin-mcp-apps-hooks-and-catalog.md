# Plugin MCP Apps, Native Lifecycle Hooks, Scheduled Sidecars, and Extensible Catalog

Objective: Complete Phase 2 of Kite's extensible plugin platform with sandboxed MCP Apps (`ui://` SEP-1865) inline and in RightDock, native Rust agent lifecycle hooks (`hooks.json`), cron-scheduled builtin sidecars integrated into Kite's scheduler, and a feed-driven Plugin Catalog browser.
Branch: `feat/remote-control`. Test runner: `npx vitest run` & `cargo test --manifest-path src-tauri/Cargo.toml --workspace`.
Does not change protected zones (`TitleBar.tsx` mode switcher).

## Specs

- **S1 — Sandboxed MCP Apps (`ui://` SEP-1865)**:
  - Behavior: Parse MCP tool `_meta.ui.resourceUri` (and legacy `_meta["ui/resourceUri"]`), `visibility` (`["model"]` / `["app"]`), and entrypoints (`aux_pane`, `global`, `title`). Fetch `ui://` HTML resources (`text/html;profile=mcp-app`, <= 10 MiB), sanitize `_meta.ui.csp` origin allowlists (bare `http(s)`/`ws(s)` origins only), and enforce server ownership, `"app"` visibility, and <= 4 concurrent in-flight tool calls per app instance. Render `McpAppFrame.tsx` in a sandboxed iframe (`sandbox="allow-scripts"`) implementing the SEP-1865 `postMessage` JSON-RPC bridge (`ui/initialize`, `ui/notifications/initialized`, `ui/notifications/tool-input`, `ui/notifications/tool-result`, `ui/notifications/host-context-changed`, `tools/call`, `ui/message`, `ui/update-model-context`, `ui/open-link`, `ui/notifications/size-changed`), both inline inside `ChatItemRow.tsx` (150px..800px) and in RightDock `mcp-app` tabs / `DockNewTabMenu.tsx`.
  - Checks: Rust unit tests in `plugin_runtime/mcp_apps.rs`, Vitest suite `McpAppFrame.test.tsx`.

- **S2 — Native Agent Lifecycle Hooks (`hooks.json`)**:
  - Behavior: Load and merge `hooks.json` files from enabled plugins and workspace `.agents/hooks.json`, honoring `"enabled": false`, `SessionStart`, `PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation`, and `Stop` events, regex tool matchers, timeout defaults (`30s`), `PLUGIN_ROOT`/`PLUGIN_DATA` env vars, and camelCase JSON stdin/stdout contracts (`allow|deny|ask|force_ask`, shallow top-level `overwrite` with rewrite notice, `injectSteps`, `terminationBehavior`, `Stop` `continue` with `continuationActive` and max 3 continuations). Wire an optional `NativeHookRunner` into `native_agent::loop_engine::ReactLoopConfig`.
  - Checks: Rust unit tests in `plugin_runtime/hooks.rs` and `native_agent::loop_engine::tests`.

- **S3 — Cron-Scheduled Sidecars (`builtin: schedule`)**:
  - Behavior: Reuse `routines::CronSchedule` (`parse_cron_schedule` and `matches_unix_ms`) without duplicating cron parsing. Discover enabled plugin sidecars declaring `"builtin": "schedule"`, validate 5-field cron `args[0]`, execute due runs once per minute via `hidden_exec` into `sidecar.log`, track status (`plugin_scheduled_sidecars_status`), and tick cleanly inside `routines::start_routine_scheduler`.
  - Checks: Rust unit tests in `plugin_runtime/scheduler.rs`.

- **S4 — Configurable Extensible Plugin Catalog Feeds**:
  - Behavior: Manage user-configured JSON catalog feed URLs/paths in `<roaming_app_dir>/plugin_catalog_sources.json`, fetch/parse `schemaVersion: 1` catalogs (supporting HTTPS and local `file://`/filesystem feeds), compute installed version parity (`installed` / `updateAvailable`), perform 1-click install/update via `plugin_runtime::registry`, and expose a searchable **Catalog** tab (`PluginCatalogTab.tsx`) alongside **Extensions** and **Service Connectors** in `PluginsView.tsx`.
  - Checks: Rust unit tests in `plugin_runtime/catalog.rs`, Vitest `PluginCatalogTab.test.tsx`.

- **S5 — Tier 3 Quality Gate & End-to-End Platform Verification**:
  - Behavior: Register all ODD 3 Tauri commands in `src-tauri/src/main.rs`, run clean-room sanitizer, IPC parity, design lint, TypeScript check, Vitest, Cargo workspace suite, live Android CLI sidecar smoke test, and Tier 3 `npm run verify:gate -- --rebuild-rust`.
  - Checks: `node .kite/sanitizer/audit-references.mjs --check`, `npm run verify:ipc`, `npm run verify:design`, `npx tsc --noEmit`, `npx vitest run`, `cargo test --manifest-path src-tauri/Cargo.toml --workspace`, `npm run verify:gate -- --rebuild-rust`.

## Tasks

- [ ] **T1** (`S1`, Risk: `item 2 (iframe sandbox/CSP & app-only tool gating)`, route: `delegated`): Implement `src-tauri/src/plugin_runtime/mcp_apps.rs`, `NativeMcpClient` raw tool/resource methods, `McpAppFrame.tsx`, `ChatItemRow.tsx` inline MCP app rendering, RightDock `mcp-app` mounting, and unit tests.
- [ ] **T2** (`S2`, Risk: `item 2 (hook command execution & tool argument rewrite)` + `item 3 (ReactLoopConfig extension)`, route: `delegated`): Implement `src-tauri/src/plugin_runtime/hooks.rs`, `NativeHookRunner` trait & integration in `native_agent/loop_engine.rs`, turn wiring, and unit tests.
- [ ] **T3** (`S3`, `S4`, Risk: `item 3 (routines cron helper reuse & PluginsView 3-tab catalog)`, route: `delegated`): Expose `routines::CronSchedule` helpers, implement `plugin_runtime/scheduler.rs` and `plugin_runtime/catalog.rs`, implement `PluginCatalogTab.tsx` + tests, and wire into `PluginsView.tsx`.
- [ ] **T4** (`S1`–`S5`, Risk: `item 3 (main.rs handler additions)` + `item 4 (scheduler & runtime lifecycles)`, route: `inline`): Register all ODD 3 IPC commands in `main.rs`, execute complete Tier 3 verification + live Android CLI verification + Desktop CDP visual check, close all 3 ODDs with observed evidence, and commit ODD 3.

## Log

- **L1 (2026-11-27)**:
  > "Sí, me parece correcto. Quisiera que plantearas todos los ODDs. Seguidos, porque trabajarás en todo seguido... ¿Me dejas poder llevar a tener funcionando el plugin que te pedí? Pero también hay que no lo sé, tener todo lo demás listo. Entonces, considerando eso, quiero que trabajes y plantees los ODDs correspondientes. Luego ataques, sin detenerte. Puedes hacerlo con bastantes subagentes"
