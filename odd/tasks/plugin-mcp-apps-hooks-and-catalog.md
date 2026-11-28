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

- [x] **T1** (`S1`, Risk: `item 2 (iframe sandbox/CSP & app-only tool gating)`, route: `delegated`): Implement `src-tauri/src/plugin_runtime/mcp_apps.rs`, `NativeMcpClient` raw tool/resource methods, `McpAppFrame.tsx`, `ChatItemRow.tsx` inline MCP app rendering, RightDock `mcp-app` mounting, and unit tests.
- [x] **T2** (`S2`, Risk: `item 2 (hook command execution & tool argument rewrite)` + `item 3 (ReactLoopConfig extension)`, route: `delegated`): Implement `src-tauri/src/plugin_runtime/hooks.rs`, `NativeHookRunner` trait & integration in `native_agent/loop_engine.rs`, turn wiring, and unit tests.
- [x] **T3** (`S3`, `S4`, Risk: `item 3 (routines cron helper reuse & PluginsView 3-tab catalog)` + `item 4 (scheduled sidecar execution dedupe)`, route: `delegated`): Expose `routines::CronSchedule` helpers, implement `plugin_runtime/scheduler.rs` and `plugin_runtime/catalog.rs`, implement `PluginCatalogTab.tsx` + tests, and wire into `PluginsView.tsx`.
- [ ] **T4** (`S1`–`S5`, Risk: `item 3 (main.rs handler additions & shared surfaces)` + `item 4 (scheduler & runtime lifecycles)`, route: `inline`): Register all ODD 3 IPC commands in `main.rs`, execute complete verification + live Android CLI verification + Desktop CDP visual check (kept `[ ]` strictly because unscoped `npm run verify:gate -- --rebuild-rust` exited 1 on pre-existing `ProviderConnectionPanel.tsx` static inline style violations in `feat/remote-control` and full `cargo test --workspace` reported 4 pre-existing unrelated `kite-code` test failures; verified in working tree without sweeping pre-existing `feat/remote-control` WIP).

## Log

- **L1 (2026-11-27)**:
  > "Sí, me parece correcto. Quisiera que plantearas todos los ODDs. Seguidos, porque trabajarás en todo seguido... ¿Me dejas poder llevar a tener funcionando el plugin que te pedí? Pero también hay que no lo sé, tener todo lo demás listo. Entonces, considerando eso, quiero que trabajes y plantees los ODDs correspondientes. Luego ataques, sin detenerte. Puedes hacerlo con bastantes subagentes"
- **L2 (2026-11-27 — ODD 3 Verification & Closeout)**:
  - `node .kite/sanitizer/audit-references.mjs --check`: `[AUDIT CLEAN] Scanned 632 file(s). Zero reference leaks detected.`
  - `npm run verify:ipc`: `[PASS] Zero new broken IPC contracts detected.` (`Registered: 433 | Rust #[tauri::command]: 434 | Frontend calls: 529 (349 unique)`).
  - `node scripts/quality/verify-design.mjs --strict --files` (15 new/refactored ODD 2+3 UI/IPC files): `Errors: 0 | Warnings: 0` (`[PASS]`).
  - `node scripts/quality/verify-design.mjs --files` (6 modified shared files `PluginsView.tsx`, `RightDock.tsx`, `MarkdownMessage.tsx`, `chat-markdown-actions.css`, `ChatItemRow.tsx`, `App.tsx`): `Errors: 0 | Warnings: 5` (pre-existing warnings in untouched lines).
  - `npx tsc --noEmit`: PASS (exit 0).
  - `npx vitest run` (15 plugin/dock/chat/agent test files): `15 passed (15) | Tests 134 passed (134)`.
  - `cargo build --manifest-path src-tauri/Cargo.toml --bin kite-code` & `cargo check --manifest-path src-tauri/Cargo.toml --bin kite`: PASS (exit 0).
  - Targeted `cargo test --manifest-path src-tauri/Cargo.toml`: `plugin_runtime` (`60 passed; 0 failed; 1 ignored`), `native_agent` (`53 passed; 0 failed`), `dispatch::mcp_hub` (`8 passed; 0 failed`), `routines` (`16 passed; 0 failed`), `acp::` (`23 passed; 0 failed`), `subagent_settings` (`6 passed; 0 failed`), `chat::runtime::spawn` (`8 passed; 0 failed`), `bin kite` (`24 passed; 0 failed`), `-p kite-ctx` (`50 passed; 0 failed`), and `live_android_cli_device_hub_proxy_smoke -- --ignored` (`1 passed; 0 failed` in `1.08s`).
  - `npm run verify:desktop:e2e -- --spec desktop-smoke`: `1/1 passed` (`2979ms`), CDP screenshots visually inspected cleanly with untouched TitleBar mode toggle and thread composer.
  - Known pre-existing blockers (unrelated to plugin runtime): `npm run verify:gate -- --rebuild-rust` passed `ipc` (`500ms`) and exited 1 on unscoped `design` over 561 working-tree files due to pre-existing static inline styles in `src/components/quota/ProviderConnectionPanel.tsx` (lines 268–472); full `cargo test --workspace` reported `1133 passed; 4 failed; 2 ignored` on pre-existing `agents::tests::install_curated_agent_template_is_idempotent_for_ship_guard_and_discovery_architect`, `quota::tests::test_fetch_grok_quota`, `terminal::tests::generic_shell_ignores_agent_detection_without_running_child_agent`, and one pre-existing subagent reconcile test.
  - Risk: item 2 (iframe sandbox/CSP, app-only tool gating, hook command execution & tool argument rewrite), item 3 (shared RightDock/PluginsView/ChatItemRow/main.rs/ReactLoopConfig/routines contracts), item 4 (MCP Hub unregister, scheduled sidecar dedupe, runtime lifecycles).
