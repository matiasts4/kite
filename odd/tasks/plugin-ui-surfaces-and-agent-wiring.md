# Plugin UI Surfaces, Sidecar Panels, and Agent Wiring

Objective: Expose installed plugin bundles, UI sidecar panels inside RightDock, clickable `sidecar://` chat pills, a tabbed Extensions & Service Connectors manager, and automatic MCP/skills/rules/agent-profile wiring across all Kite agent runners while preserving 100% of existing service connector behavior.
Branch: `feat/remote-control`. Test runner: `npx vitest run` & `cargo test --manifest-path src-tauri/Cargo.toml`.
Does not change protected zones (`TitleBar.tsx` mode switcher).

## Specs

- **S1 — RightDock Sidecar Tabs & `SidecarPanelView`**:
  - Verbatim:
    > "te da la posibilidad de utilizar un Android. Dentro de la aplicación."
  - Behavior: Extend `dockConfig.tsx` with `'sidecar'` and `'mcp-app'` tab kinds, persist schema v5 tabs safely, populate an "Extensions" section in `DockNewTabMenu.tsx` listing enabled UI sidecars, implement `SidecarPanelView.tsx` + `sidecar-panel.css` with a compact 28px toolbar (live status dot, Reload, Restart, Start/Stop, Logs drawer) and full-bleed `<iframe>` protected by a pointer-events drag shield during dock resize, and listen for `kite:open-right-dock-sidecar` in `RightDock.tsx` and `App.tsx`.
  - Checks: `src/components/views/SidecarPanelView.test.tsx`, `src/components/RightDock.test.tsx`, `npm run verify:design`.

- **S2 — Clickable `sidecar://` Pills in Chat Markdown**:
  - Behavior: Update `MarkdownMessage.tsx` and `styles/chat-markdown-actions.css` so links using the `sidecar://<sidecar-id>/<view-path>` scheme are excluded from `isFileHref` and rendered as tactile `.md-sidecar-pill` buttons that call `openSidecarInRightDock` to open/focus the RightDock panel without launching an external browser.
  - Checks: `src/components/views/chat/MarkdownMessage.test.tsx`.

- **S3 — Plugins Manager Overhaul (Extensions + Legacy Service Connectors)**:
  - Verbatim:
    > "darle soporte para instalarlos o agregarlos como extensiones o algo así."
  - Behavior: Add a clean segmented switcher in `PluginsView.tsx` between **Extensions** (installed plugin bundles) and **Service Connectors** (preserving all 29 canonical service connectors and tests intact). Implement `useInstalledPlugins.ts`, `InstalledPluginCard.tsx`, `InstalledPluginDrawer.tsx` (metadata, sidecar start/stop/restart/open-panel/logs viewer, skills/rules/MCP/hooks summary, per-agent gating toggles, uninstall for Kite-managed bundles), and `InstallPluginModal.tsx` (Local Folder picker, Git Repo URL + ref/subdir, Archive `.zip`), plus a Shared System Roots toggle.
  - Checks: `InstalledPluginCard.test.tsx`, `InstallPluginModal.test.tsx`, `PluginsView.test.tsx`, `PluginCard.test.tsx`, `npm run verify:design`.

- **S4 — Agent Runtime Wiring (MCP Hub, Context Injection & Role Profiles)**:
  - Behavior: Add `SharedStdioMcpHub::unregister_server` in `src-tauri/src/dispatch/mcp_hub.rs`. Create `plugin_runtime/mcp_bridge.rs` to dynamically register/unregister enabled plugin Stdio MCP servers under `<plugin>_<server>` and expose HTTP endpoints, and `plugin_runtime/context.rs` to assemble active `<plugin_skills>`, `<plugin_rules>`, and `<plugin_sidecars>` (including `sidecar://` URIs, live ports, and log paths). Inject active plugin context and `KITE_ACTIVE_SIDECARS_JSON` in `chat/runtime/spawn.rs` and `chat/runtime/turn.rs` (respecting `agent.disabled_plugin_ids`), merge plugin MCP servers into `agents.rs` `list_provider_mcp_servers`, and merge plugin `agents/*.md` profiles into `subagent_settings.rs` `list_subagent_roles`.
  - Checks: Rust unit tests in `mcp_bridge.rs`, `context.rs`, `dispatch::mcp_hub`, and frontend `AgentSettingsTab.test.tsx`.

- **S5 — Typed IPC & Quality Gate Parity**:
  - Behavior: Export typed IPC wrappers in `src/lib/ipc/pluginRuntime.ts` and `src/lib/ipc/index.ts` with explicit error handling (zero silent catches) and full IPC registration parity.
  - Checks: `npm run verify:ipc`, `npm run verify:design`, `npx tsc --noEmit`, `node .kite/sanitizer/audit-references.mjs --check`.

## Tasks

- [ ] **T1** (`S1`, `S2`, `S5`, Risk: `item 3 (shared RightDock tabs persistence & MarkdownMessage link handling)`, route: `delegated`): Implement `src/lib/ipc/pluginRuntime.ts`, `src/lib/sidecarNav.ts`, `SidecarPanelView`, `dockConfig.tsx`, `DockNewTabMenu.tsx`, `RightDock.tsx`, `MarkdownMessage.tsx` `sidecar://` pills, `App.tsx` listener, and unit tests.
- [ ] **T2** (`S3`, `S5`, Risk: `item 3 (PluginsView surface preserving 29-connector tests)`, route: `delegated`): Implement `useInstalledPlugins.ts`, `InstalledPluginCard.tsx`, `InstalledPluginDrawer.tsx`, `InstallPluginModal.tsx`, `PluginsView.tsx` segmented Extensions/Connectors tabs, `plugins.css` token-compliant styles, and unit tests.
- [ ] **T3** (`S4`, Risk: `item 3 (shared agent MCP & turn context pipeline)` + `item 4 (MCP Hub dynamic unregister)`, route: `delegated`): Implement `SharedStdioMcpHub::unregister_server`, `plugin_runtime/mcp_bridge.rs`, `plugin_runtime/context.rs`, `chat/runtime/{spawn,turn}.rs` wiring, `agents.rs` & `subagent_settings.rs` integration, and unit tests.
- [ ] **T4** (`S1`–`S5`, Risk: `none` — verification & integration closeout, route: `inline`): Wire `src/lib/ipc/index.ts` and `mcp_bridge::sync_plugin_mcp_hub` triggers in `plugin_runtime/mod.rs`, run full verification (`verify:ipc`, `verify:design`, `tsc`, targeted Vitest + Cargo suites, `audit-references.mjs`), and commit ODD 2.

## Log

- **L1 (2026-11-27)**:
  > "Creo que tenemos que irnos en algo bastante grande, tiene que ver con dar soporte a plugins, pero reales. Por ejemplo. El de Android CLI ... Me parece bastante, bastante útil. Quiero decir, te da la posibilidad de utilizar un Android. Dentro de la aplicación... darle soporte para instalarlos o agregarlos como extensiones o algo así."
- **L2 (2026-11-27)**:
  > "Sí, me parece correcto. Quisiera que plantearas todos los ODDs. Seguidos, porque trabajarás en todo seguido... ¿Me dejas poder llevar a tener funcionando el plugin que te pedí? Pero también hay que no lo sé, tener todo lo demás listo. Entonces, considerando eso, quiero que trabajes y plantees los ODDs correspondientes. Luego ataques, sin detenerte. Puedes hacerlo con bastantes subagentes"
