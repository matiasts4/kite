# Startup, Thread Loading, and Mode Persistence Guide

This document explains why Kite startup slowed down after the large modularization and diff-viewer updates, why switching to **Thread** showed a static loading icon and slow initial paint, how **Agent | Code | Thread** mode persistence works, and which guardrails prevent these regressions from returning.

## Quick outcome summary

| Metric / Behavior | Baseline (`ec710bc`, pre-modularization) | Pre-fix Regression (`feat/response-thread` + `app.log`) | Post-fix Verified |
| --- | --- | --- | --- |
| Rust `.setup()` duration (`app.log`) | `2 ms` (`Kite Code\app.log`, 2026-11-05) | `37–158 ms` + up to `500 ms` daemon pipe poll (`Kite Code Dev\app.log`, 2026-11-13) | Setup backgrounded; window shows without waiting on shim, skill copies, or daemon poll |
| Dev page load + boot (`app.log`) | `101–167 ms` page load (`0.37–1.89 s` to `bootstrap()`) | `2.29 s` warm, `33.6–70.5 s` cold page load (`85.4 s` / `131 s` with Vite reload) | Lazy route & worker deferral + single bootstrap call |
| Startup JS preloaded in `dist/index.html` | Monolithic app shell without `@pierre/diffs` | Preloaded `vendor-diffs` (`11.2 MB`) / `vendor-mermaid` (`5.2 MB`) via Rollup preload helper placement | `1,082.33 kB` raw / `317.27 kB` gzip (Vite build output across `index`, `vendor-runtime`, `vendor-react`, `vendor-motion`, `vendor-tauri`); `vendor-diffs` (`11,220.31 kB`) and `vendor-mermaid` (`5,224.16 kB`) excluded |
| `getBootstrap()` calls on launch | Triggered multiple times via `loadThreads` dependency | `2–4x` duplicate invocations (`bootstrap()` + `auth_bootstrap()` twice per launch in `app.log`) | `1x` single bootstrap call on launch |
| Post-bootstrap splash hold (`APP_INTRO_MIN_MS`) | `3000 ms` | `3000 ms` minimum hold after first frame | `250 ms` minimum hold |
| Thread spinner animation | Static (no keyframes in CSS, `SpinnerIcon` lacked class) | Static icon (`SpinnerIcon` + `.animate-spin` no-ops) | Smooth `@keyframes spin` + `prefers-reduced-motion` guard |
| Thread `load_thread` SQLite cost | Rewrote all SQLite tables on every unmodified read | Full `persist()` on read + synchronous IPC command | Skips `persist()` when unmodified; heavy chat reads offloaded to `spawn_blocking` |
| Initial mode on launch | Forced `'code'` even if last mode was `'chat'` or `'agent'` | Forced `'code'` (`saved === 'code'` guard in `App.tsx`) | Reopens last active `'agent' \| 'code' \| 'chat'` from `kite.workMode` |

## Pre- vs. Post-Modularization Traceability

A detached baseline comparison worktree is kept at:

- `C:\Users\PC\Desktop\Proyectos\kite-worktrees\pre-modularization` (`ec710bc`, `2026-11-11`)

Across `ec710bc..4105f00`, **440 files** changed and source granularity expanded rapidly before adding uncommitted diff-viewer dependencies:

| Milestone | Commit / Date | Measured / Architectural Impact |
| --- | --- | --- |
| Baseline snapshot | `ec710bc` (2026-11-11) | `555` `src/` `.ts/.tsx` files, `93` `src-tauri/src/` `.rs` files; no `@pierre/diffs`; `.setup()` took `2 ms` (`Kite Code\app.log`); `App.tsx` already forced `'code'` and re-ran `loadBootstrap` via `loadThreads` deps. |
| Frontend & backend modularization wave | `109687f`, `b8731ad`, `678449e`, `9bf6ebe` (2026-11-11 to 2026-11-12) | Grew source module count to `646` `src/` `.ts/.tsx` files (`+16%`) and `129` `src-tauri/src/` `.rs` files (`+39%`). In unbundled Vite dev (`http://127.0.0.1:1420`), statically imported top-level views caused WebView2 to fetch hundreds of small ESM files serially/concurrently before `App` mounted. |
| CLI shim & live GUI dispatch bridge | `f746d60` (2026-11-12) | Added synchronous `dispatch_wire::start_gui_background()` inside `main.rs` `.setup()`, copying `kite.exe` via full-binary `std::fs::read`, rewriting `SKILL.md` across up to 16 home skill roots, and running `import_historical()` before setup finished. |
| Backend submodule splits & test expansion | `74d446b`, `ce45367`, `217aa9d`, `78e67f3`, `4105f00` + working tree (2026-11-13) | Expanded source tree to `726` `src/` `.ts/.tsx` files (`+31%` vs `ec710bc`) and `248` `src-tauri/src/` `.rs` files (`+167%` vs `ec710bc`) by splitting `chat`, `dispatch`, `chat_commands`, and terminal subsystems into domain submodules. |
| Diff viewer dependencies (uncommitted work) | Working tree (`package.json`) | Added `@pierre/diffs` (`1.6.4`) and `@pierre/highlights` (`0.4.0`), plus Shiki language bundles (~80 chunks) and wrapped `<App />` in `<DiffWorkerPoolProvider>` inside `src/main.tsx`. |

## Root Causes and Implemented Fixes

### 1. App Startup Performance (Frontend)

| Root Cause | Evidence / Mechanism | Fix & File |
| --- | --- | --- |
| Root `<DiffWorkerPoolProvider>` spawned diff/Shiki worker machinery before shell paint | `<App />` was wrapped directly in `DiffWorkerPoolProvider` in `src/main.tsx` | Moved `DiffWorkerPoolProvider` to diff consumers in [`KiteDiffView.tsx`](../src/components/diffs/KiteDiffView.tsx) and [`DiffsView.tsx`](../src/components/views/diffs/DiffsView.tsx); kept [`main.tsx`](../src/main.tsx) minimal. |
| All heavy views & overlays eagerly loaded on boot | `AgentsView`, `CodeWorkspace`, `ChatView`, `RoutinesView`, `RightDock`, and `SettingsView` were static imports in `AppMainStage.tsx` / `App.tsx` | Lazy-loaded routes and overlays via `React.lazy` + `<Suspense>`, latched visited mode state (`hasOpenedAgent`, `hasOpenedCode`, `hasOpenedChat`, `hasOpenedRightDock`, `hasOpenedSettings`), honored `detail?.workspaceId ?? effectiveWorkspaceId` in `RightDock` browser requests without duplicate diff listeners, and preserved queued dock requests (`consumePendingBrowserRequest`, `peekPendingFilePreview`, `openDiffsInRightDock`) in [`AppMainStage.tsx`](../src/components/app/AppMainStage.tsx), [`App.tsx`](../src/App.tsx), [`RightDock.tsx`](../src/components/RightDock.tsx), [`terminalLinkNav.ts`](../src/lib/terminalLinkNav.ts), and [`useAppShortcuts.ts`](../src/components/app/useAppShortcuts.ts). |
| Rollup hoisted `vite/preload-helper` (`~1 kB`) into `vendor-diffs` (`11.2 MB`) and statically pulled `vendor-mermaid` (`5.2 MB`) | `manualChunks` returned `undefined` for virtual helper `\0vite/preload-helper.js`, so `dist/index.html` preloaded `vendor-diffs` on startup; static `import mermaid from 'mermaid'` plus a catch-all `'vendor'` bucket triggered circular chunks | Routed `vite/preload-helper` / `commonjsHelpers` to `vendor-runtime` (`1.24 kB`), narrowed `vendor-react` (`react\|react-dom\|scheduler`), removed catch-all `'vendor'` in [`vite.config.ts`](../vite.config.ts), and dynamically imported `mermaid` inside [`MermaidDiagram.tsx`](../src/components/ui/MermaidDiagram.tsx). |
| `loadBootstrap` re-executed on mode and agent changes | `loadBootstrap` depended on `loadThreads`, which depended on `[workMode, selectedAgentId]`, causing duplicate `bootstrap()` and `auth_bootstrap()` IPC calls seen in `app.log` | Decoupled `loadThreads` via `workModeRef` and `selectedAgentIdRef` and moved `archivedCount` updates into an independent post-bootstrap effect in [`App.tsx`](../src/App.tsx). |
| `Sidebar` re-probed `probe_agent_availability` on every revisit to `agent` mode | `useEffect` in `Sidebar.tsx` ran a fresh `probe_agent_availability` whenever `mode` returned to `'agent'` | Guarded initial availability probing with `availabilityProbedRef` in [`Sidebar.tsx`](../src/components/Sidebar.tsx). |
| Artificial `3000 ms` splash screen floor | `APP_INTRO_MIN_MS = 3000` held the intro overlay even when boot finished in `< 500 ms` | Reduced `APP_INTRO_MIN_MS` to `250 ms` in [`contract.ts`](../src/motion/contract.ts). |

### 2. App Startup Performance (Rust Backend)

| Root Cause | Evidence / Mechanism | Fix & File |
| --- | --- | --- |
| Full-binary read when checking `kite.exe` shim freshness | `write_shim_to_dir` called `std::fs::read(&src) != std::fs::read(&dest)` on every launch, reading the entire executable into RAM twice | Replaced byte-for-byte read with `shim_matches_metadata` comparing byte length and `modified()` timestamp in [`install.rs`](../src-tauri/src/dispatch/cli/install.rs). |
| Synchronous filesystem housekeeping on loopback bind | `bind_dispatch_listener` ran `install_kite_shim`, `install_dispatch_skill` (scanning 16 home skill roots), `ensure_sample_role`, and `import_historical` synchronously | Binds TCP loopback listener immediately and offloads housekeeping to `spawn_dispatch_housekeeping()` on a background thread in [`server.rs`](../src-tauri/src/dispatch_wire/server.rs). |
| Synchronous daemon pipe poll (`500 ms`) & early SQLite touch before setup | `main.rs` called `persist::workspaces()` before Tauri builder and blocked `.setup()` on `start_gui_background()` + `ensure_core_daemon_started()` (up to `50 * 10ms`) | Removed pre-builder `persist::workspaces()` (already warmed on background thread in `initial_state()`), split `dispatch_wire::start_gui_background()` and `core_daemon` initialization onto parallel background threads inside `.setup()`, and added `DaemonStartupGate` / `CoreDaemonStartupGuard` so early `is_external_daemon_owner()` IPC checks wait cleanly until `CORE_DAEMON_OWNER` resolves without blocking window display in [`main.rs`](../src-tauri/src/main.rs) and [`credits.rs`](../src-tauri/src/core_daemon/credits.rs). |

### 3. Thread (`chat`) Spinner & Loading Performance

| Root Cause | Evidence / Mechanism | Fix & File |
| --- | --- | --- |
| Static / frozen spinner icon | `src/index.css` had no `@keyframes spin` or `.animate-spin` definition (Tailwind utilities were not injected globally) and `SpinnerIcon` lacked `animate-spin` | Defined `@keyframes spin`, `.animate-spin`, and `@media (prefers-reduced-motion: reduce)` in [`index.css`](../src/index.css) and applied `animate-spin` in [`ChatIcons.tsx`](../src/components/views/chat/ChatIcons.tsx). |
| Unconditional SQLite write on read inside `load_thread` | `load_thread` always called `persist()` (`save_disk_to_sqlite`), rewriting every table on disk when opening/switching existing threads | Tracks `mutated` (only when `profileId` actually changes or a blank thread is created) and skips `persist()` on unmodified reads in [`threads.rs`](../src-tauri/src/chat/threads.rs). Instrumented `PERSIST_CALLS` counter in [`persist.rs`](../src-tauri/src/persist.rs). |
| Blocking chat reads on Tauri IPC thread | `load_chat_thread`, `load_agent_chat_thread`, `list_chat_summaries`, `list_agent_chat_summaries`, `load_thread_grid`, `list_chat_provider_models`, `list_provider_agents` were synchronous `fn` handlers | Converted all seven commands to `async` with `tokio::task::spawn_blocking` in [`chat_commands/mod.rs`](../src-tauri/src/chat_commands/mod.rs). |
| Sequential waterfall without cache hydration in `useChatSession` | Switching to Thread waited for sequential `summaries -> grid -> thread` IPC calls behind `isLoadingInitial = true`, ignoring cached `localStorage` data and launching all provider CLI probes simultaneously | Added synchronous cache hydration (`hydrateInitialChatState` reading `kite.chat.summaries.v1`, `kite.chat.grid.v1`, `kite.chat.thread.*`), parallelized `Promise.all([loadChatSummariesWithFallback, loadSavedGrid])`, ensured initial mount always reconciles with the backend (`hasInitializedRef`) while separating authoritative empty IPC responses from offline fallback cache in [`useChatGridPersistence.ts`](../src/components/views/chat/hooks/useChatGridPersistence.ts) and [`useChatSession.ts`](../src/components/views/chat/useChatSession.ts), and prioritized the active provider while staggering non-active provider queries (`350 ms`) in [`useChatAgents.ts`](../src/components/views/chat/hooks/useChatAgents.ts) and [`useChatModels.ts`](../src/components/views/chat/hooks/useChatModels.ts). |
| Abrupt Thread-to-Thread switch (`setIsLoadingInitial(true)` flash + `0 ms` DOM swap) | After initial mount consumed `skipInitialSpinnerRef`, changing `threadId` re-ran `initChatView()`, resetting `isLoadingInitial = true` (flashing the centered spinner while re-fetching all summaries) and hard-cutting the pane/transcript DOM in `0 ms` with no crossfade | Split initial load vs `switchToThread` in [`useChatSession.ts`](../src/components/views/chat/useChatSession.ts) (reusing in-memory/`localStorage` snapshots synchronously with `switchRequestSeqRef` stale-response protection, holding the active pane mounted during cold loads without flashing the spinner, and never calling `persistGrid` when `agentId` is active), and added `AnimatePresence` crossfade/handoff transitions using Kite standard tokens (`tweens.fade`, `tweens.swap`, `shift.handoff`, `inert`/`aria-hidden` on exiting panes) in [`ThreadGrid.tsx`](../src/components/views/chat/ThreadGrid.tsx), [`SingleThreadPane.tsx`](../src/components/views/chat/SingleThreadPane.tsx), and [`AgentChatShell.tsx`](../src/components/views/agents/AgentChatShell.tsx). |

### 4. Reopening Last Active View Mode (`Agent | Code | Thread`)

| Root Cause | Mechanism | Fix & File |
| --- | --- | --- |
| `App.tsx` discarded `'chat'` and `'agent'` on boot | `localStorage` initializer explicitly checked `if (saved === 'code') return 'code'` and ignored `'agent'` / `'chat'` | Added `VALID_WORK_MODES`, `isValidWorkMode`, `readSavedWorkMode`, `writeSavedWorkMode` in [`kitePrefs.ts`](../src/lib/kitePrefs.ts); restored initial `workMode`, wrote updates immediately via `workModeRef`, respected local saved mode over stale backend preferences, and kept browser test lane `'agent'` override in [`App.tsx`](../src/App.tsx). |

## Prevention Checklist & Invariants

Keep these rules enforced in future PRs and audits:

- **Never wrap `<App />` in feature-heavy providers**: Worker pools (diffs, Shiki, Mermaid, xterm) belong inside the view or leaf component that renders them, never in `src/main.tsx`.
- **Keep top-level views behind `React.lazy`**: `AgentsView`, `CodeWorkspace`, `ChatView`, `RoutinesView`, `RightDock`, and `SettingsView` must remain code-split with queued pending-navigation helpers so deep-links work even when a dock or pane has not mounted yet.
- **Inspect `dist/index.html` after bundler changes**: Verify `<link rel="modulepreload">` contains only runtime, React, motion, and Tauri core—never `vendor-diffs`, `vendor-mermaid`, or `vendor-xterm`.
- **Keep `.setup()` sub-10ms**: File copies, skill distribution, SQLite migrations, and daemon pipe polling must run on spawned background threads after the main window setup completes.
- **No SQLite `persist()` on read paths**: Functions named `load_*`, `list_*`, or `history*` must not write to disk unless state actually mutated.
- **Offload blocking Rust commands**: Any IPC command acquiring locks across I/O or probing CLIs/models must use `async` + `tokio::task::spawn_blocking`.
- **Never set `isLoadingInitial(true)` during thread-to-thread switches**: Initial mount (`initChatView`) only runs once per scope (`hasInitializedRef` / `agentId` change); thread switches must go through `switchToThread` with sequence-guarded background refresh so existing panes crossfade cleanly without spinner flashes.
- **Break `useCallback` / `useEffect` chains on `loadBootstrap`**: Bootstrap effects must not include view state (`workMode`, `selectedAgentId`) in their dependency graph.

## Verification Coverage

- Frontend unit & regression tests: [`App.startup.test.tsx`](../src/App.startup.test.tsx), [`Sidebar.test.tsx`](../src/components/Sidebar.test.tsx), [`AppMainStage.test.tsx`](../src/components/app/AppMainStage.test.tsx), [`ChatIcons.test.tsx`](../src/components/views/chat/ChatIcons.test.tsx), [`useChatGridPersistence.test.ts`](../src/components/views/chat/hooks/useChatGridPersistence.test.ts), [`useChatModels.test.ts`](../src/components/views/chat/hooks/useChatModels.test.ts), [`useChatSession.test.tsx`](../src/components/views/chat/useChatSession.test.tsx), [`ThreadGrid.test.tsx`](../src/components/views/chat/ThreadGrid.test.tsx), [`AgentChatShell.test.tsx`](../src/components/views/agents/AgentChatShell.test.tsx).
- Rust unit & regression tests: `load_thread_read_does_not_persist_when_unmodified` in [`threads.rs`](../src-tauri/src/chat/threads.rs), `write_shim_skips_copy_when_metadata_matches_and_updates_when_stale` in [`basic_tests.rs`](../src-tauri/src/dispatch/cli/tests/basic_tests.rs), and `DaemonStartupGate` tests in [`credits.rs`](../src-tauri/src/core_daemon/credits.rs).
- Commands: `npx tsc --noEmit`, `npx vitest run`, `npm run build`, `cargo test --manifest-path src-tauri/Cargo.toml`, and `node .kite/sanitizer/audit-references.mjs --check`.
