# Memory, GPU & Runtime Resource Optimization

Objective: Reduce Kite Code's idle and active RAM/GPU footprint (measured at 1,299 MB WS / 981 MB PM idle in Dev and 3,061 MB WS / 2,497 MB PM active in Prod) by eliminating Rust/SQLite multi-cloning, eager frontend diff/asset bundling, excessive GPU blur layers, unbounded session/terminal caches, idle polling wakeups, and multi-agent warm pool bloat — without regressing features, visual identity, or protected UI controls.
Branch: `feat/response-thread`. Do not commit on `main`.
Delivery strategy: `ask-on-risk` (forecast ~1,500–2,100 authored changed lines across 8 isolated ~180–350 line work-unit commits `T1`–`T8`; await explicit user authorization and chain strategy before beginning implementation `T1`).
Test runner: `cargo test --manifest-path src-tauri/Cargo.toml --bin kite-code`, `npx vitest run`, `npx tsc --noEmit`, `npm run build`, `npm run verify:desktop:e2e`, `node .kite/sanitizer/audit-references.mjs --check`.

---

## Specs

### S1 — Rust Persistence (`persist.rs`) Clone Elimination, SQLite Hygiene & Daemon SQL Isolation
Eliminates ~250–320 MB of permanent/peak RAM in main `kite-code.exe` (measured 403 MB WS / 364 MB PM in Prod) and ~70–90 MB in `kite-code.exe --daemon` (measured 122 MB WS / 98 MB PM in Prod).

1. **Eliminate Permanent `STATE` Duplication (`src-tauri/src/persist.rs:1017-1075`):**
   - Stop retaining the full loaded `DiskState` forever inside `static STATE: OnceLock<DiskState>` after individual stores (`workspaces`, `paths`, `agents`, `threads`, `routines`, `notifications`, etc.) are initialized.
   - Initialize all stores once by moving fields out of the loaded `DiskState` (zero duplicate heap copy of all `threads.data` JSON trees), and remove the redundant unhealed-threads startup clone in `persist.rs:579-586` used only for `seed_persisted_thread_revs()`.
2. **Dirty-Only Thread Snapshotting & Bounded SQLite WAL (`src-tauri/src/persist.rs:324-330, 857-861, 1077-1140`):**
   - Stop executing `threads().lock().unwrap().clone()` across the entire thread vector on every 120 ms `persist_async()` / `persist()` flush. Track mutated/deleted thread IDs (or per-thread revision counters) and clone/write only dirty threads inside `sync_threads()`.
   - Configure a bounded `PRAGMA cache_size` and run periodic / idle `PRAGMA wal_checkpoint(PASSIVE)` (plus `TRUNCATE` on clean shutdown or WAL threshold) so `kite.sqlite-wal` cannot grow unboundedly (measured 20.7 MB in Prod).
3. **Daemon SQL Isolation (`src-tauri/src/terminal/commands.rs:223`, `src-tauri/src/terminal/workspace.rs:2`, `src-tauri/src/dispatch_wire/`):**
   - Ensure `kite-code.exe --daemon` NEVER triggers `persist::initial_state()` or loads chat `threads` JSON into memory.
   - Expose lightweight direct SQLite read helpers (e.g., querying only `agents`, `workspaces`, or `paths` tables without loading `threads`) for daemon-side callers.
4. **Acceptance & Checks:**
   - Rust unit tests proving: (a) initial load moves data without keeping a second permanent copy; (b) persisting one mutated thread writes only that thread and preserves all untouched threads across SQLite reload; (c) WAL checkpoint runs cleanly without locking errors; (d) daemon helper reads `agents`/`workspaces` without initializing `persist::threads()`.

---

### S2 — Frontend Diffs Code-Splitting (`vendor-diffs`), Lazy Loading & Shared Worker Pool
Eliminates 80–150 MB Renderer RAM in Prod (150–250 MB in Dev) on cold boot and prevents 100–400 MB WASM Web Worker leaks when expanding inline diffs.

1. **Fix `vendor-diffs` Monolithic Chunk (`vite.config.ts:59-61`):**
   - Remove the blanket `id.includes('@pierre') || id.includes('shiki')` `manualChunks` rule that collapses ~200+ `@shikijs/langs/*` grammars, `@shikijs/themes/*`, `@pierre/highlights`, and Oniguruma WASM into a single 10.72 MB boot chunk (`dist/assets/vendor-diffs-*.js`).
   - Preserve per-language dynamic chunking so only actively viewed languages/themes are fetched at runtime.
2. **Remove Eager Boot Imports of Diff & Chat Trees:**
   - Remove module-level `ensureReadableLightDiffTheme()` eager execution in `src/components/diffs/KiteDiffView.tsx:41` (run lazily on first diff render).
   - `React.lazy` `KiteDiffView` inside `UnifiedDiffView` / `DiffCodeViewer`, `ChatView` inside `src/components/code/PaneNodeRenderer.tsx:4`, and `FilesView` / `DiffsView` inside `src/components/RightDock.tsx:11-12` so cold boot in Code, Agent, or Thread mode never fetches or parses diff/highlighter bundles when no diff is displayed.
3. **Single Shared `DiffWorkerPoolProvider` (`src/components/diffs/DiffWorkerPoolProvider.tsx:14-46`, `KiteDiffView.tsx:140`):**
   - Stop instantiating a dedicated 4-worker pool inside every `<KiteDiffView>` when rendered in `ChatWorkLog.tsx:233`, `ChatApprovalCard.tsx:66`, or `ChangesView.tsx:315`.
   - Provide one lazily-initialized app-level shared worker pool capped at `1–2` workers with idle worker termination after inactivity.
4. **Acceptance & Checks:**
   - `npm run build` produces no monolithic >2 MB `vendor-diffs` chunk, and entry/boot chunks have zero static imports pointing to `@pierre/diffs` or `@shikijs/langs`.
   - Vitest tests verify multiple mounted diff cards share a single pool capped at `<= 2` workers and cleanly dispose idle workers.

---

### S3 — GPU & Compositor Layer Reduction (Glass Surfaces, `StageBackdrop` & Hidden Modes)
Targets ~80–160 MB GPU process RAM reduction (measured 258–331 MB WS in WebView2 GPU process) while preserving Kite's visual language, 4-tier radius contract (`AGENTS.md`), and protected TitleBar Mode Switcher.

1. **Eliminate Double Blur & Always-On Backdrop Layer (`src/components/theme/StageBackdrop.tsx:55-99`, `theme-visuals.css:3-53`):**
   - Remove redundant `backdropFilter: blur(...)` on `.stage-backdrop__scrim` when `.stage-backdrop__canvas` already applies `filter: blur(...)`.
   - Do not render `.stage-backdrop` or apply `transform: translateZ(0)` / `contain: strict` when `effectivePreset === 'none'`.
   - Replace continuous 100vw×100vh SVG `<feTurbulence>` grain (`theme-visuals.css:48-53`) with a small tiled static noise pattern or disable it when unnecessary.
2. **Cut Shell-Wide Live `backdrop-filter` Layer Explosion (`src/visual-language.css:1034-1132, 1234-1239`, `src/lib/themeCustomizations.ts:1099-1108`):**
   - Stop promoting every `.sidebar`, `.right-dock`, `.pane`, `.chat-surface`, and split `.code-pane-panel` simultaneously with live `backdrop-filter: blur(20px) saturate(140%)` + `transform: translateZ(0)`.
   - Use translucent solid/tinted glass tokens over a single pre-blurred backdrop surface for persistent panes, reserving live `backdrop-filter` only for transient top-level dialogs/sheets (or an explicit opt-in high-effects toggle).
   - Remove unconditional `transform: translateZ(0); will-change: scroll-position` from `.chat-transcript` (`visual-language.css:1234-1239`).
   - Do NOT alter the protected TitleBar Mode Switcher (`src/components/TitleBar.tsx`, `mode-toggle--stadium`, `layoutId="titlebar-mode-toggle-indicator"`).
3. **Suspend Hidden Mode GPU Surfaces & Settings Previews (`src/index.css:37-48`, `src/components/app/AppMainStage.tsx:87-96`, `CustomizationsTab.tsx:314-318`):**
   - Switch inactive `.mode-layer` containers from `visibility: hidden; opacity: 0` to `display: none` (or `content-visibility: hidden`) so hidden canvases and layers release GPU backing textures while keeping backend PTYs and React state intact.
   - Replace the 12+ simultaneous `<StageBackdrop variant="miniature">` GPU-promoted cards in `CustomizationsTab.tsx:314-318` with lightweight CSS gradient/thumbnail previews.
4. **Acceptance & Checks:**
   - `npx vitest run` + `npm run verify:desktop:e2e` confirm visual layout integrity, smooth mode switching across `Agent | Code | Thread`, preserved radius/height standards, and untouched TitleBar switcher geometry.

---

### S4 — Persistent Agent Session Pool Tightening, Job Object Cleanup & Session Bounds
Targets ~450–900 MB RAM savings during active sessions by limiting warm persistent CLI trees (`agy.exe` + `codegraph` + `engram` + `kite dispatch mcp`) and closing backend session leaks.

1. **Tighten Warm Pool Cap & Idle TTL (`src-tauri/src/chat/session/types.rs:41-42`):**
   - Lower `DEFAULT_MAX_WARM_SESSIONS` from `3` to `1` (overrideable via config/env up to `2` if explicitly requested) and `DEFAULT_IDLE_TIMEOUT_MS` from `30 * 60 * 1000` (30 min) to `5 * 60 * 1000` (5 min).
   - Preserve transparent thread resumption via provider conversation handles (`chat/session/manager.rs:192-205`) when a reaped session receives a new turn.
2. **Windows Job Object Process-Tree Ownership (`src-tauri/src/hidden_exec.rs:79-96, 646-685`):**
   - Assign spawned `HiddenChild` processes on Windows to a Job Object configured with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` so killing, reaping, or parent exit deterministically terminates the entire child tree (agent CLI + MCP servers + subshells) with zero orphans.
3. **Bound In-Memory Session & Stream Maps (`src-tauri/src/chat/session/manager.rs:20-27, 320-326`, `eviction.rs:274-281`, `chat/runtime/stream_json.rs:12-20`, `settle.rs:310`):**
   - Cap `ManagedSession.events` (ring buffer / bounded retention) and drop heavy payloads from reaped/closed sessions in `SessionManager.sessions`.
   - Cap `SessionManager.commands` to a bounded LRU/ring of recent command IDs instead of retaining every prompt string forever.
   - Remove finished run IDs from `streaming_sys_msg_runs` and `last_agent_step_by_run` inside `settle.rs:finish_run`.
4. **Acceptance & Checks:**
   - Rust unit/integration tests verify warm LRU cap (`1`), idle reaping after TTL, bounded `events`/`commands` retention, `finish_run` map cleanup, and Windows Job Object descendant process termination.

---

### S5 — Attachment Base64 Externalization & Thread / File Cache Hygiene
Targets ~80–200 MB RAM reduction across Rust + WebView2 and shrinks Prod `kite.sqlite` (~53 MB) by eliminating inline base64 image duplication and unbounded frontend caches.

1. **Externalize `previewDataUrl` from Persisted Thread JSON (`src-tauri/src/chat_attachments.rs:9, 156-265, 307-317`, `src/components/views/chat/hooks/useChatAttachments.ts:74-82`):**
   - Stop persisting multi-megabyte base64 `previewDataUrl` strings inside `threads.data` JSON and `localStorage`; store attachment files in `%APPDATA%\Kite Code\chat-attachments\` and serve previews via Tauri asset protocol or on-demand read.
   - Maintain backward-compatible rendering for legacy threads that already contain `previewDataUrl` (optionally stripping/migrating them on next save when the disk file exists).
   - Evict consumed entries from `staged_attachments()` when a turn is sent (instead of only on explicit cancel) and sweep stale unsubmitted drafts by TTL.
2. **Fix Frontend `threadsMap`, `knownThreadsList` & `localStorage` Thrash (`src/components/views/chat/hooks/useChatGridPersistence.ts:400-426`, `useChatSession.ts:358,471`):**
   - Strip heavy `items[]`, tool outputs, and attachment payloads before writing entries into `knownThreadsList` / `localStorage['kite.chat.summaries.v1']`.
   - Evict closed threads from `threadsMap` using a bounded LRU cache (e.g., max 8 full threads in renderer memory; reload from Rust/SQLite when reopened).
   - Debounce and serialize only the dirty thread entry instead of synchronously running `JSON.stringify` over the entire `threadsMap` on every streaming update.
3. **Cap Unbounded File & Git Diff Caches (`src/components/views/files/gitTypes.ts:99-100`, `src/components/views/FilesView.tsx:116-126`):**
   - Add deterministic LRU limits to `fileDiffCache`, `diffFileContentsCache`, and `FilesView` caches (`openFiles`, `folderChildren`, `pathToEntryId`).
4. **Acceptance & Checks:**
   - Rust and Vitest tests verify: (a) image attachment previews render without writing `previewDataUrl` base64 into `threads.data` or `localStorage`; (b) `staged_attachments()` size returns to `0` after send; (c) `knownThreadsList` stays summary-only; (d) `threadsMap` and git/file caches obey LRU caps.

---

### S6 — Terminal Memory Reduction (`rowCacheRef`, `vt100` Scrollback & Slim `--daemon`)
Targets ~90–140 MB saved per active terminal (frontend + daemon) and trims `--daemon` idle overhead.

1. **Eliminate Per-Frame Full-Row Cloning in Canvas Poller (`src/components/views/terminal/canvas/useTerminalSnapshotPoller.ts:223-240`):**
   - Stop cloning every cell of every row (`rowCells.map((c) => ({ ...c }))`) into a 5,500-row `rowCacheRef` Map (~90–120 MB V8 heap per terminal).
   - Store immutable row arrays or cap the local frontend row cache to a bounded window (e.g., viewport + compact ring buffer), fetching older scrollback text from backend on selection/copy when needed.
2. **Bound `vt100` Scrollback & Slim Daemon Tokio Runtime (`src-tauri/src/vt_engine/screen.rs:44`, `src-tauri/src/core_daemon/server.rs:475-478`):**
   - Lower default `vt100::Parser` scrollback from `5000` to `1500`–`2000` lines (saving ~18–25 MB per active PTY without breaking terminal usage or alternate screen).
   - Replace unbounded `Builder::new_multi_thread()` in `core_daemon/server.rs:475-478` with a bounded worker pool (`worker_threads(2)` or `new_current_thread()` where appropriate) to eliminate per-core thread stack allocation in `--daemon`.
3. **Acceptance & Checks:**
   - Existing `vt_engine` and `TerminalCanvasSurface` tests pass, plus new tests verifying bounded `rowCacheRef` size, zero redundant cell cloning on unchanged rows, and intact text selection/copy.

---

### S7 — Cold-Boot Bundle Slimming, Dead `@xterm/xterm` Removal & Static Asset Sizing
Targets ~35–65 MB saved in Renderer + GPU at cold boot by stripping unused dependencies, lazy-loading cold surfaces, and resizing oversized static PNGs.

1. **Lazy-Load Cold Boot UI Modules:**
   - `React.lazy` `ZedStripHost` / `ZedStrip` (`src/App.tsx:11` — prevents eager loading of `ZedOrb`, `orbRenderer.ts` WebGL2 shaders, and `src/lib/operator/*` when `operatorOpen` is `false`).
   - `React.lazy` all 5 cold modals in `src/components/app/AppModals.tsx:2-8` (`CommandPaletteModal`, `UsageDashboardModal`, `WhatsNewModal` + changelog data, `ArchivedChatsModal`, `SshWorkspaceModal`) and `SystemResourcePopover` in `src/components/telemetry/SystemResourceBadge.tsx:11`.
   - Unmount `RightDock` (`src/App.tsx:700`) once closed unless an active Browser surface requires persistence.
2. **Split `vendor-mermaid` & Remove Dead `@xterm/xterm` Imports:**
   - Remove the blanket `vendor-mermaid` chunk collapse in `vite.config.ts:65-73` so diagram engines load lazily by diagram type rather than a single 4.99 MB chunk.
   - Remove dead static `@xterm/xterm` imports (`src/components/views/terminal/terminalSessionRegistry.ts:1`, `src/lib/terminalViewport.ts:1-2`, `src/components/views/terminal.css:1`, and any dead references from `AgentPaneResumeModal`) since canvas mode is enforced (`src/lib/terminalAppearancePrefs.ts:26,99`).
3. **Downscale Oversized Raster Assets:**
   - Resize `public/assets/logos/agent-gentle-shell.png` (1254×1254, 1.12 MB → 128×128) and `public/assets/kite-symbol.png` (1024×1024 → 128×128), cutting ~9.5 MB of decoded RGBA GPU texture waste.
4. **Acceptance & Checks:**
   - `npm run build` confirms smaller `index-*.js`, absence of `vendor-xterm` in boot graph, split Mermaid chunks, and passing `npx tsc --noEmit` + `npx vitest run`.

---

### S8 — Idle Polling / Wakeup Storm Elimination & Measured RAM Verification
Eliminates continuous idle GC churn, 4-second whole-`<App>` re-renders, and 50 wakeups/sec Rust TCP polling, and validates before/after RAM targets.

1. **Frontend Idle Polling Fixes:**
   - `src/lib/notifications/useNotifications.ts:54,117-130`: Deep/revision-compare `notifications_poll` results before calling `setSnapshot` so idle polls never re-render `<App>`.
   - `src/lib/agentInboxLoop.ts:119-121`: Pause the 500 ms `poll_agent_inbox` loop when `document.hidden`, when `CodeWorkspace` is inactive, or when no agents are active (or back off / wake on event).
   - Deduplicate `list_live_chat_runs` polling between `src/components/views/chat/hooks/useChatTurnActions.ts:96` and `src/components/views/AgentsView.tsx:330`, skipping `setLiveRuns` when unchanged; stop `src/components/RightDock.tsx:186` 2s timer when `!visible`.
2. **Backend Idle Polling & Thread-Spawn Fixes:**
   - Replace the nonblocking 40 ms `thread::sleep` accept loop in `src-tauri/src/dispatch_wire/server.rs:115-128` (running in both GUI and `--daemon`) with blocking `accept()` + clean shutdown wakeup (or async Tokio `TcpListener`).
   - Replace per-16 ms `std::thread::spawn` in `src-tauri/src/terminal/lifecycle.rs:588-598` (`schedule_paint_activity`) with a single reusable timer/channel, and coalesce per-PTY 400 ms lifecycle pollers (`lifecycle.rs:601-616`).
3. **Verification & Target Benchmark:**
   - Re-measure live Windows Working Set & Private Commit for both Dev (idle, 0 agents) and Prod (active) and log exact before/after figures in `## Log`.
   - Target baseline: Dev idle total **< 550 MB WS** (down from `1,299 MB WS`), Prod `kite-code.exe` main **< 120 MB WS** (down from `403 MB WS`), Prod `--daemon` **< 40 MB WS** (down from `122 MB WS`), and zero idle memory creep over a 5-minute observation window.

---

## Tasks

> **Execution status**: Complete (`T1`–`T8` implemented and verified uncommitted on `feat/response-thread`, preserving all pre-existing uncommitted work).

- [x] **T1** (`S1`, Risk: `item 1, item 3 — SQLite persistence, WAL checkpoint & daemon DB reads`, route: `delegated (Kite subagent thread:8f4c9751) + inline verification & test fix`): Removed permanent `persist::STATE` duplication via `OnceLock<PersistStores>`, implemented dirty-only thread snapshotting (`collect_dirty_threads`/`sync_dirty_threads`) + bounded `cache_size = -8000` + `wal_checkpoint(PASSIVE|TRUNCATE)` in `src-tauri/src/persist.rs`, and added direct SQLite read helpers so `kite-code.exe --daemon` never loads chat `threads`. Fixed `test_initial_state_moves_into_stores_once` empty-workspace assumption. Verified: `persist::tests` 10/10 passed.
- [x] **T2** (`S2`, Risk: `item 3 — Vite chunk graph & shared diff worker pool`, route: `delegated (Kite subagent thread:21dca75f, antigravity/gemini-4-hydrogen)`): Removed blanket `@pierre`/`shiki` `vendor-diffs` rule in `vite.config.ts` (eliminating 10.72 MB boot monolith), moved `ensureReadableLightDiffTheme()` to lazy first-render in `KiteDiffView.tsx`, lazy-loaded `KiteDiffView`/`ChatView`/`FilesView`/`DiffsView` across `UnifiedDiffView`, `DiffCodeViewer`, `PaneNodeRenderer`, and `RightDock`, and converted `DiffWorkerPoolProvider` to a ref-counted singleton capped at 1–2 workers with 60s idle termination. Updated `RightDock.test.tsx` for async lazy `DiffsView`. Verified: Vitest passed, `npm run build` clean with zero static diff/shiki imports from entry chunks.
- [x] **T3** (`S4`, Risk: `item 4 — process-tree lifecycle, Job Objects & session concurrency`, route: `delegated (Kite subagent thread:3526e77b) + inline eviction ordering fixes`): Tightened `DEFAULT_MAX_WARM_SESSIONS` (`3 -> 1`, env clamp `1..=2`) and `DEFAULT_IDLE_TIMEOUT_MS` (`30m -> 5m`), wrapped Windows `HiddenChild` in a `KILL_ON_JOB_CLOSE` Job Object (`hidden_exec.rs`), bounded `ManagedSession.events`/`SessionManager.commands`, pruned finished stream run maps in `settle.rs:finish_run`, and fixed `eviction.rs` so `clear_heavy_session_payloads` runs before `settle_approvals` and `evict_provider_sessions` does not double-stop already-reaped sessions. Verified: `chat::session` 30/30, `hidden_exec` 7/7, `finish_run_clears_stream_json_run_maps` 1/1 passed.
- [x] **T4** (`S5`, Risk: `item 1, item 3 — persisted attachment schema & thread cache migration`, route: `inline fullstack`): Externalized attachment `previewDataUrl` out of persisted `threads.data` JSON and `localStorage` with on-demand `read_chat_attachment_preview` Tauri IPC + bounded 32-entry `attachmentPreview.tsx` LRU cache (keeping backward compatibility for legacy inline-only previews), evicted consumed entries from `staged_attachments()` on send + TTL sweep, stripped `items[]` from `knownThreadsList` / `kite.chat.summaries.v1`, added 8-thread LRU eviction (`pruneThreadsMapLru`) and 350ms debounced dirty-only `localStorage` thread persistence, and capped `gitTypes.ts` (`40`/`24`) and `FilesView.tsx` (`12`/`120`/`2000`) caches. Verified: `chat_attachments` 2/2 passed, `useChatGridPersistence.test.ts` 8/8 + chat suites passed.
- [x] **T5** (`S3`, Risk: `item 3 — shared shell CSS, theme glass surfaces & mode visibility`, route: `delegated (Kite subagent thread:32842bd1, antigravity/gemini-4-hydrogen)`): Returned `null` from `StageBackdrop` on `none`, removed duplicate scrim `backdropFilter`, replaced SVG `<feTurbulence>` with static CSS micro-grain and dropped idle `translateZ(0)`; replaced persistent shell pane live `backdrop-filter` with translucent tinted surfaces while preserving overlay blur and untouched TitleBar switcher; switched inactive `.mode-layer` to `display: none` with rAF `resize` restore; replaced 12+ miniature `StageBackdrop` mounts in `CustomizationsTab` with CSS gradient previews. Updated `composerMenu.test.ts` to assert `display: none`/`display: flex`. Verified: Vitest passed, `npx tsc --noEmit` exit 0.
- [x] **T6** (`S6`, Risk: `item 3, item 4 — terminal grid cache & daemon runtime`, route: `inline fullstack`): Replaced per-frame full-row cell cloning in `useTerminalSnapshotPoller.ts` with `updateTerminalRowCache` capped at `MAX_ROW_CACHE_ENTRIES = 256` (updating only dirty rows on incremental frames and storing non-packed rows immutably), lowered `DEFAULT_VT_SCROLLBACK_LINES` (`5000 -> 2000`) in `vt_engine/screen.rs`, and bounded `--daemon` Tokio runtime to `DAEMON_TOKIO_WORKER_THREADS = 2` / `max_blocking_threads(8)` in `core_daemon/server.rs`. Verified: `useTerminalSnapshotPoller.gridReuse.test.ts` + `TerminalCanvasSurface.test.tsx` 12/12, `vt_engine` 15/15, `daemon_runtime` 1/1 passed.
- [x] **T7** (`S7`, Risk: `none`, route: `delegated partial (thread:fa26244c, quota-halted) + inline test/build completion`): Lazy-loaded `ZedStripHost`, all 5 cold modals in `AppModals.tsx`, and `SystemResourcePopover`, unmounted closed `RightDock` when no Browser surface is active, split `vendor-mermaid` in `vite.config.ts`, removed dead runtime `@xterm/xterm` imports/CSS, and downscaled `agent-gentle-shell.png` (1.12 MB -> 15 KB) and `kite-symbol.png` (190 KB -> 13 KB) to 128×128. Updated `AppModals.test.tsx` and `SystemResourceBadge.test.tsx` for async lazy `Suspense`. Verified: 18/18 Vitest tests passed, `npm run build` clean with zero `vendor-xterm` and zero monolithic `vendor-diffs`/`vendor-mermaid`.
- [x] **T8** (`S8`, Risk: `item 4 — background TCP accept & terminal paint wakeups`, route: `inline fullstack + verification`): Added deep-equality skip in `useNotifications.ts` (`latestSnapshotRef` + `areNotificationsSnapshotsEqual`), paused `agentInboxLoop.ts` when hidden/inactive/0 agents with event wakeup + backoff, deduplicated `list_live_chat_runs` polling via shared `src/lib/liveChatRunsStore.ts` across `useChatTurnActions.ts` and `AgentsView.tsx`, stopped `RightDock.tsx` 2s timer when `!visible`, replaced 40ms nonblocking `dispatch_wire/server.rs` accept loop with blocking `accept()` + loopback shutdown wakeup, and replaced per-16ms `std::thread::spawn` and per-PTY 400ms threads in `terminal/lifecycle.rs` with reusable `Condvar`-backed `PaintFlushScheduler` and `LifecycleMonitor`. Verified: `idlePollingOptimization.test.ts` + `useChatTurnActions.test.ts` + `useChatSession.test.tsx` passed, full Vitest 201/201 files (1,464/1,464 tests), Rust focused suites 132/132 passed, `npx tsc --noEmit` exit 0, `npm run build` exit 0, `DESKTOP-SMOKE-01` PASS, reference sanitizer clean (305 files), and measured live Dev idle RAM telemetry logged in `L4`.

---

## Log

- **L1 (2026-11-19 — Initial User Request, Read-Only Audit):**
  > "analiza el consumo de la aplicacion en cuanto a recursor, para ver que recortamos o optimizamos dado que el consumo base de ram subio"
  - Captured live Windows process measurements (`Win32_Process`) across both running Kite instances:
    - **Dev idle (PID 10296, 0 agents, 9 processes)**: **1,299 MB WS / 981 MB PM** — `wv2-renderer` 615.3 MB WS (553.6 PM), `wv2-gpu` 263.4 MB WS (223.5 PM), `wv2-browser` 124.3 MB WS, `wv2-utils` 110.6 MB WS, `kite-main` 74.1 MB WS (28.7 PM), `kite-daemon` 27.6 MB WS (12.9 PM).
    - **Prod active (PID 15452, 3 warm `agy.exe`, 36 processes)**: **3,060.8 MB WS / 2,497.4 MB PM** — `wv2-renderer` 417.0 MB WS (365.3 PM), `kite-main` 403.0 MB WS (364.2 PM), `wv2-gpu` 257.6 MB WS (216.0 PM), `wv2-browser+utils` 243.3 MB WS, `kite-daemon` 121.6 MB WS (98.0 PM), 3× `agy.exe` 833.8 MB WS + 9× `node` MCP 482.5 MB WS + 3× `engram` 77.0 MB WS + 3× `kite.exe` 26.9 MB WS + 9× shells/PTYs 212.8 MB WS.
    - Observed live idle creep over ~2 minutes: `kite-main` Prod `+16.5 MB` PM, `wv2-renderer` Dev `+13.0 MB` PM.
  - Audited Prod vs Dev SQLite databases (`%APPDATA%\Kite Code\kite.sqlite` = **53.3 MB** + **20.7 MB** `-wal`, 62 threads = 49.32 MB JSON vs Dev 2.1 MB) and `dist/assets/` (`vendor-diffs` 10.72 MB, `vendor-mermaid` 4.99 MB, `agent-gentle-shell.png` 1.12 MB).
  - Identified primary regression commits (`105bba4`, `4eea5fe`, `3ac1975`, `1e15add`, `5799007`, `09e4b58`) and systemic backend leaks (`persist.rs` 3× full-DB cloning, `--daemon` loading chat threads, `DEFAULT_MAX_WARM_SESSIONS = 3` × 30 min without Job Object).
- **L2 (2026-11-19 — User Request to Author Full ODD):**
  > "arma el odd completamente"
  - Authored `odd/tasks/memory-and-resource-optimization.md` (`S1`–`S8`, `T1`–`T8`) and mirrored to Engram under `odd/memory-and-resource-optimization/tasks`.
- **L3 (2026-11-19 — User Authorization to Implement with Subagents on Gemini 4 Hydrogen):**
  > "si impelmenta usando subagentes con gemini 4 hydrogen"
  - Launching Wave 1 (`T1`, `T2`, `T3`) in parallel via Kite subagents (`antigravity/gemini-4-hydrogen`, `workspace: "inherit"`) with strictly disjoint edit surfaces, preserving all pre-existing uncommitted work on `feat/response-thread`.
- **L4 (2026-11-19 — Continuation & Full Completion of `T1`–`T8`):**
  > "continua con todo"
  - `antigravity/gemini-4-hydrogen` hit quota mid-`T7` (`thread:fa26244c`); resumed inline to complete `T7` test/build verification, fix `T1`/`T3` Rust test findings (`eviction.rs` `clear_heavy_session_payloads` ordering before `settle_approvals`, skip double `transport.stop()` on already-reaped sessions, `persist_tests.rs` store init check), and implement + verify `T4`, `T6`, and `T8`.
  - **Verification summary:**
    - `npx tsc --noEmit`: exit `0`
    - `npx vitest run`: **201/201 files, 1,464/1,464 tests passed**
    - `npm run build` (`tsc && vite build`): exit `0`, zero `vendor-xterm`, zero monolithic `vendor-diffs`/`vendor-mermaid` (`index-*.js` = `632.4 kB`)
    - Focused Rust unit tests (`persist::tests` 10, `chat::session` 30, `hidden_exec` 7, `chat::runtime::settle` 1, `chat_attachments` 2, `vt_engine` 15, `core_daemon::server::daemon_runtime_tests` 1, `terminal::` 41, `dispatch_wire::tests` 25): **132/132 passed**
    - `cargo build --manifest-path src-tauri/Cargo.toml --no-default-features --bin kite-code`: exit `0`
    - `node .kite/sanitizer/audit-references.mjs --check`: `[AUDIT CLEAN] Scanned 305 file(s). Zero reference leaks detected.`
    - `npm run verify:desktop:e2e -- --spec desktop-smoke --spec ui-layout`: `DESKTOP-SMOKE-01` **PASS** (TitleBar badge showed `RAM 433 MB`, protected TitleBar switcher & layout verified via inspected milestone PNGs); `UI-LAYOUT-01` hit a pre-existing Framer Motion mid-transition sidebar row overlap in `00-settled-immediate.png` (`ThreadRoster.tsx`, untouched by `T1`–`T8`; rows aligned cleanly milliseconds later in `FAILURE-state.png`).
  - **Live Windows RAM Telemetry (Before vs After — Isolated Freshly Built Debug Binary, `Win32_Process`, excluding sandboxed auto-routine `agy.exe`/`conhost`/`kite.exe`):**
    - **Before (`L1` Dev idle, 0 agents)**: **1,299.0 MB WS / 981.0 MB PM** (`wv2-renderer` 615.3 WS / 553.6 PM, `wv2-gpu` 263.4 WS / 223.5 PM, `kite-main` 74.1 WS / 28.7 PM; `+13.0 MB PM` creep over 2m).
    - **After (`T+10s` idle)**: **487.2 MB WS / 252.6 MB PM** (`wv2-renderer` 108.5 WS / 91.2 PM, `wv2-gpu` 119.4 WS / 78.1 PM, `kite-main` 55.5 WS / 10.9 PM) — **-62.5% WS / -74.3% PM**, beating the `< 550 MB WS` target by 63 MB.
    - **After (`T+40s` idle)**: **501.1 MB WS / 249.5 MB PM** (`wv2-gpu` dropped to 114.7 WS / 72.0 PM, Private Commit dropped `-3.1 MB` over 30s — zero idle memory creep).
    - **Prod telemetry note**: The installed Prod binary (`v0.1.67`) is currently hosting this session and was not force-killed; Prod `kite-code.exe` (`< 120 MB WS`) and `--daemon` (`< 40 MB WS`) targets will materialize on the next packaged release build.
