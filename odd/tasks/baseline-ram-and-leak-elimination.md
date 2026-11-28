# Baseline RAM & Leak Elimination (Phase 1 of 3)

Objective: Reduce Kite Code's idle and active baseline footprint (measured on v0.1.92 at 920.4 MB Working Set / 646.5 MB Private Bytes with 0 running agents: `kite-code.exe` 173.9 MB Priv, `kite-code.exe --daemon` 146.2 MB Priv, WebView2 326.4 MB Priv) to < 400 MB WS / < 260 MB Priv via lazy thread hydration, SQLite bloat compaction, daemon thread-store isolation, bounded Rust/frontend caches, and idle GPU/IPC elimination.
Branch: `feat/remote-control`. Delivery strategy: `work-unit-commits` (forecast ~1,100–1,450 authored changed lines across 6 parallel disjoint units `T1`–`T6` + parent seam check).
Test runner: `cargo test --manifest-path src-tauri/Cargo.toml --bin kite-code persist::tests chat:: dispatch_wire::tests`, `npx tsc --noEmit`, `npx vitest run`, `npm run build`, `npm run verify:ipc`, `npm run verify:design`, `node .kite/sanitizer/audit-references.mjs --check`.
Series: ODD 1 of 3 for Alternative 3 (paired with `odd/tasks/multiplexed-provider-daemons-and-mcp-hub.md` and `odd/tasks/native-rust-agent-fast-lane.md`).
Protected zones: Do NOT modify `src/components/TitleBar.tsx` (`mode-toggle--stadium`, `layoutId="titlebar-mode-toggle-indicator"`), and preserve the 4-tier corner radius and 3-tier control height contracts in `AGENTS.md`.

---

## Specs

- **S1 — Lazy Thread Stubs, Hydrated LRU, Legacy SQLite Compaction & Daemon SQL Isolation**:
  - Verbatim:
    > "Básicamente, nuestra aplicación tiene que ser cualiviana posible. Se logre. A lo que me refiero es que de, de base ya tenemos un consumo elevado. Entonces, la idea es pensar en ciertos puntos de optimización. Para llegar a abordarlos."
  - Behavior:
    1. **Thread Stubs & Hydrated LRU (`src-tauri/src/persist.rs`)**:
       - `load_or_migrate_sqlite()` dehydrates loaded threads (after startup healing) into metadata stubs via `to_thread_stub(thread)` (`items: []`, stripped `subagentRuns[].items`, `"_kiteStub": true`, `"itemCount": <len>`) before storing them in `PersistStores.threads`.
       - Export exact shared contract:
         - `pub const MAX_HYDRATED_THREADS: usize = 8;`
         - `pub fn is_thread_stub(thread: &Value) -> bool` (`_kiteStub == true`)
         - `pub fn hydrate_thread(thread_id: &str) -> bool` (loads full `data` JSON from SQLite `threads` into `threads()`, clears `_kiteStub`, tracks LRU order, flushes and dehydrates oldest idle non-running hydrated threads beyond `MAX_HYDRATED_THREADS`)
         - `pub fn dehydrate_idle_threads(keep_ids: &[&str]) -> usize`
         - `pub fn find_thread_direct(thread_id: &str) -> Option<Value>` (direct `SELECT data FROM threads WHERE id = ?1`, never initializing `PersistStores`)
         - `pub fn list_threads_direct_summaries() -> Vec<Value>` (direct SQLite query returning stubbed summaries, never initializing `PersistStores`)
         - `pub fn all_workspace_paths_direct() -> HashMap<String, String>` (direct SQLite query, never initializing `PersistStores`)
         - `pub fn list_workspaces_direct() -> Vec<Workspace>` (direct SQLite query, never initializing `PersistStores`)
       - **Data-safety invariant**: `collect_dirty_threads` and `upsert_threads_into_tx` MUST NEVER overwrite full SQLite rows with a stub (`if is_thread_stub(t) { continue; }`), while ALWAYS keeping the stub's `id` in `live_ids` so `prune_absent_threads` never deletes historical threads.
       - Callers in `chat/threads.rs`, `chat/runtime/spawn.rs`, and `chat/subagents/stream_ingest.rs` call `persist::hydrate_thread(id)` before reading or mutating full thread `items` or persisting metadata changes.
    2. **Daemon Isolation (`src-tauri/src/dispatch_wire/protocol.rs`, `server.rs`)**:
       - When `persist::is_daemon_process()` is `true`, read paths use `find_thread_direct`, `list_threads_direct_summaries`, `list_workspaces_direct`, `all_workspace_paths_direct` so `kite-code.exe --daemon` never initializes `PersistStores` or holds `threads` JSON in heap (~146 MB Priv -> < 30 MB Priv).
    3. **Stop Parent Subagent Item Duplication (`src-tauri/src/chat/subagents/lifecycle.rs`)**:
       - For child-backed subagent runs (`childThreadId` non-empty), store `run["items"] = []` in parent thread RAM/SQLite while keeping `stepCount`, `latestActivity`, `status`, and delta events intact.
    4. **One-Time Legacy SQLite Compaction (`persist.rs`)**:
       - Guarded by `app_state` key `legacy_bloat_compacted_v1`: strips embedded `items[]` from settled child/transcript-backed `subagentRuns`, externalizes inline `attachments[].previewDataUrl` to `chat-attachments/`, caps `dispatch_audit` to latest `2_000` rows, and runs `VACUUM` when freelist > 8 MiB.
  - Checks: `cargo test --manifest-path src-tauri/Cargo.toml --bin kite-code persist::tests chat:: dispatch_wire::tests`.

- **S2 — Rust Runtime Thread-Spawn, Bounded Map, Child Browser WebView & Operator Warm Pool Fixes**:
  - Verbatim:
    > "de base ya tenemos un consumo elevado. Entonces, la idea es pensar en ciertos puntos de optimización."
  - Behavior:
    1. Replace per-delta `std::thread::spawn` in `src-tauri/src/chat/runtime/pipeline.rs` with a singleton `Condvar`-backed `DeltaFlushScheduler` timer thread.
    2. Prune `stderr_ring` and `result_failures` inside `clear_stream_run_state` (`stream_json.rs` / `settle.rs`).
    3. Bound `killed_threads()` (`kill_registry.rs` max `256`), `wait_hub()` (`swarm/state.rs` max `256` with `Arc::strong_count == 1` eviction), and `dispatch/policy/service.rs` (`receipts` max `512`, inactive `!ep.live` endpoints max `128`).
    4. Evict/close inactive child WebView2 surfaces (`webview.close()`) for other workspaces in `src-tauri/src/browser.rs` instead of keeping every visited workspace's Chromium child process alive offscreen forever.
    5. Tighten `WarmAntigravityPool` in `src-tauri/src/operator_warm_agy.rs`: `WARM_ANTIGRAVITY_IDLE_TTL` = `90s`, pass `--disable-telemetry`, and wire `reap_idle_warm_operator()` into the 60s `chat-session-reaper` loop.
  - Checks: Focused Rust unit tests for `DeltaFlushScheduler`, `stderr_ring` cleanup, bounded maps, and `reap_idle_warm_operator`.

- **S3 — Frontend Thread LRU Leak Fix, Unbounded Map Caps & Boot Bundle Code-Splitting**:
  - Verbatim:
    > "nuestra aplicación tiene que ser cualiviana posible."
  - Behavior:
    1. Evict removed thread IDs from `lastPersistedThreadsRef.current` when `pruneThreadsMapLru` runs (`useChatGridPersistence.ts`), ensuring GC frees closed threads; invoke `pruneThreadsMapLru` on create/home/init/send/split paths.
    2. Ensure all 6 `knownThreadsList` insertion sites store lightweight summaries via `toThreadSummary(...)` rather than full `ExtendedChatThread` objects with `items[]`.
    3. Cap `diffFileContents.ts` (`MAX_DIFF_CONTENTS_CACHE_ENTRIES = 24`) and `voiceSessionStore.ts` `turnsByThread` (`MAX_VOICE_HISTORY_THREADS = 8`).
    4. Code-split Operator/Argos out of the boot entry chunk by converting `argosRemoteBridge.ts`'s static import of `../operator/index` to dynamic `await import(...)`, and remove genuinely unused dependencies (`ai` if 0 references across repo).
  - Checks: `npx vitest run src/components/views/chat/hooks/useChatGridPersistence.test.ts src/components/views/chat/useChatSession.test.tsx`, `npm run build` confirming smaller entry `index-*.js` vs `1,044.6 KB`.

- **S4 — Hidden Diff Worker Disposal, Cross-Workspace Browser Cleanup, Idle Poller Gating & AgentChatShell Tail Windowing**:
  - Verbatim:
    > "de base ya tenemos un consumo elevado. Entonces, la idea es pensar en ciertos puntos de optimización."
  - Behavior:
    1. Hidden `KiteDiffView` instances inside inactive `.mode-layer` tabs release their `DiffWorkerPoolProvider` consumer reference while invisible and re-acquire when visible so idle diff Web Workers terminate cleanly after `60s`.
    2. `RightDock.tsx` + `browserSurfaceRegistry.ts` close inactive workspace browser surfaces on workspace switch/close (and avoid redundant `localStorage` parsing on every hidden render).
    3. Gate `Sidebar.tsx` (`4000ms` agent rail poll) on `!hidden && document.visibilityState === 'visible'`; pause `useNotifications.ts` polling while `document.hidden` and relax fallback cadence from `4s` to `15s` with focus catch-up.
    4. Add bounded tail-slicing (`INITIAL_VISIBLE_AGENT_ROWS = 48` + *"Show earlier"* expansion) to `src/components/views/agents/AgentChatShell.tsx`.
  - Checks: `npx vitest run src/components/RightDock.test.tsx src/lib/notifications/useNotifications.test.ts src/components/views/agents/AgentChatShell.test.tsx`.

- **S5 — Terminal Canvas DPR Cap, Hidden Canvas Backing Release, Minimized Heartbeat Removal & Inbox Guard Fix**:
  - Verbatim:
    > "nuestra aplicación tiene que ser cualiviana posible."
  - Behavior:
    1. Eliminate the `166ms` `replenish_terminal_credit` IPC timer while `document.visibilityState === 'hidden'` or `!surfaceLiveRef.current` in `TerminalCanvasSurface.tsx` / `outputClock.ts`.
    2. Cap terminal Canvas 2D backing DPR at `Math.min(devicePixelRatio, 1.5)` and release canvas backing store (`width = 0; height = 0`) when hidden beyond a short grace window (`canvasGridRenderer.ts` + `TerminalCanvasSurface.tsx`), reallocating cleanly on next visible paint.
    3. Update accessibility live text via DOM ref (`liveRegionRef.current.textContent`) instead of React `setLiveText` state every `250ms`.
    4. Remove duplicate `terminal://account-rotated` listener in `TerminalView.tsx`, fix `CodeWorkspace.tsx` `startAgentInboxPolling` hidden-mode visibility check, and cap `exitedSessionIds` / `lastPublishedPresence` (`128` entries) in `terminalRegistry.ts`.
  - Checks: `npx vitest run src/components/views/TerminalCanvasSurface.test.tsx src/components/views/TerminalView.test.tsx src/lib/terminalRegistry.test.ts`.

- **S6 — Fast Zero-Jank Mode Switching (`Agent | Code | Thread`)**:
  - Verbatim:
    > "Mira, ¿tú no te han resuelto problemas de velocidad al momento de seleccionar? No lo sé, la parte de Agents, Code o Thread, al pasarme por cada uno, se sienten muy lento y quiero ver si se demora como un segundo al pasar realmente. A veces es más rápido, claro, pero. se está demorando. Recientemente hicimos cambios de optimización y no sé si algo tuvo que ver con eso, pero la idea sería corregirlo."
  - Behavior:
    1. Wrap heavy top-level shell panes (`AppMainStage`, `AgentsView`, `CodeWorkspace`, `ChatView`, `SingleThreadPane`, `StageBackdrop`, `Sidebar`, `ThreadRoster`, `RightDock`) in `React.memo` and stabilize callback props in `App.tsx` and `AppMainStage.tsx` so switching `workMode` never re-renders hidden layers or defeats memoization.
    2. Prefetch `AgentsView`, `CodeWorkspace`, and `ChatView` JS chunks during idle time after boot without flipping `hasOpened*` lazy-mount flags before first visit (`TitleBar.tsx` remains untouched per `AGENTS.md` §3).
    3. Make `AgentsView` non-blocking when `agents` prop is already supplied, lazily load non-chat tabs/modals/starters and defer `load_agent_mind` off the `'chats'` critical path.
    4. Eliminate empty-draft `ChatComposer` forced synchronous reflow (`getComputedStyle` + `scrollHeight`) and deduplicate `listConnections` IPC calls with a short TTL cache.
    5. Guard `useTranscriptMotion`'s `useLayoutEffect` so hidden `.mode-layer` scrollers (`clientHeight === 0`) skip DOM queries and observer thrashing, memoize `ThreadRoster` thread filtering/grouping/sorting, and key `App.tsx` `listArchivedChats` fetches by `archivedOwnerId` so `Code <-> Thread` toggles fire zero extra IPCs.
  - Checks: Targeted Vitest suites (`AppMainStage.test.tsx`, `useTranscriptMotion*`, `ChatComposer.test.tsx`, `AgentsView*`), `tsc --noEmit`, `verify:design`, and real CDP mode-switch latency profiling before vs after.

---

## Tasks

- [x] **T1** (`S1`, Risk: `item 1, item 3, item 4 — SQLite stub schema safety, lazy hydration LRU & legacy compaction`, route: `delegated (bounded-writer Unit 1A)`): Implement `to_thread_stub`, non-overwriting stub guards in `collect_dirty_threads` / `upsert_threads_into_tx`, `hydrate_thread`, `dehydrate_idle_threads`, direct SQLite helpers for daemon, and one-time `migrate_compact_legacy_sqlite` in `src-tauri/src/persist.rs` + tests in `persist_tests.rs`.
- [x] **T2** (`S1`, Risk: `item 3, item 4 — daemon SQL isolation & thread hydration invariants`, route: `delegated (bounded-writer Unit 1B)`): Route daemon `dispatch_wire/{protocol,server}.rs` reads to direct SQLite helpers, wire `persist::hydrate_thread` in `chat/threads.rs`, `chat/runtime/spawn.rs`, and `chat/subagents/stream_ingest.rs`, and stop duplicating `childThreadId`-backed `items[]` in `chat/subagents/lifecycle.rs`.
- [x] **T3** (`S2`, Risk: `item 4 — shared delta scheduler, browser WebView lifecycle & bounded runtime maps`, route: `delegated (bounded-writer Unit 1C)`): Replace per-delta `thread::spawn` with singleton `DeltaFlushScheduler`, prune `stderr_ring`/`result_failures` on run clear, bound `killed_threads`/`wait_hub`/`dispatch::policy::service` maps, destroy offscreen multi-workspace child WebViews in `browser.rs`, and tighten `operator_warm_agy.rs` idle TTL (`90s`) + reaper hook.
- [x] **T4** (`S3`, Risk: `item 3, item 5 — frontend chat LRU/summary contract & dependency/chunk trimming`, route: `delegated (bounded-writer Unit 1D)`): Fix `lastPersistedThreadsRef` retention leak and `knownThreadsList` summary sanitization, enforce `pruneThreadsMapLru` across all entry points, cap `diffFileContents` & `voiceSessionStore` caches, dynamic-import Operator inside `argosRemoteBridge.ts`, and remove unused dependencies in `package.json`.
- [x] **T5** (`S4`, Risk: `item 3 — hidden diff worker release, dock/notification polling & AgentChatShell windowing`, route: `delegated (bounded-writer Unit 1E)`): Release `DiffWorkerPoolProvider` consumer refs when `KiteDiffView` is hidden, evict inactive workspace browser surfaces, gate `Sidebar` and `useNotifications` idle pollers, and add 48-row tail windowing to `AgentChatShell.tsx`.
- [x] **T6** (`S5`, Risk: `item 3 — terminal canvas DPR cap, hidden backing release & minimized heartbeat elimination`, route: `delegated (bounded-writer Unit 1F)`): Remove minimized `166ms` `replenish_terminal_credit` storm, cap Canvas 2D DPR at `1.5` with hidden backing release, move terminal live-region text to DOM ref, deduplicate `account-rotated` listener, fix `CodeWorkspace` hidden-mode inbox check, and bound `terminalRegistry.ts` sets/maps.
- [x] **T7** (`S1`–`S5`, Risk: `none`, route: `inline seam & verification`): Wire `reap_idle_warm_operator()` in 60s reaper, verify all unit tests (`cargo test`, `tsc --noEmit`, `vitest run`, `npm run build`, `verify:ipc`, `verify:design`, `audit-references.mjs --check`), and log measured before/after baseline RAM.
- [x] **T8** (`S6`, Risk: `item 3 — shell mode-switching memoization & hook invariants`, route: `inline`): Eliminate UI stalls when switching across `Agent | Code | Thread` via `React.memo` layer isolation, callback stabilization, idle chunk prefetch, non-blocking `AgentsView`, `ChatComposer` reflow/IPC caching, hidden `useTranscriptMotion` guards, `ThreadRoster` memoization, and `listArchivedChats` owner scoping.

---

## Log

- **L1 (2026-11-26 — Initial Audit Request):**
  > "Creo que hagamos una revisión exhaustiva sobre posibles optimizaciones en cuanto al consumo. Básicamente, nuestra aplicación tiene que ser cualiviana posible. Se logre. A lo que me refiero es que de, de base ya tenemos un consumo elevado. Entonces, la idea es pensar en ciertos puntos de optimización. Para llegar a abordarlos. También con respecto a los agentes y la comunicación ACP. Pensar en alternativas o formas de optimizar esto. Dado que, al tener muchos agentes, se vuelve muy costoso. Creo que en Anti-Gravity, inclusive teniendo, por ejemplo, cinco conversaciones. Y estos ejecutando sus agentes en cada una. No sube mucho. Quiero decir, a ver. En una conversación. Consume alrededor de un giga trescientos. De RAM. Y al tener por ejemplo cinco. En paralelo. Y cada uno con sus agentes. Consume alrededor de dos gigabytes. En cambio nosotros consumimos como unos cinco gigabytes, o, cuatro. Al tener esos cinco conversaciones en paralelo con sus agentes. Por ende tenemos que pensar en... cómo hacerlo. No lo sé, tal vez quitando la comunicación a CP o, buscando algún, alguna alternativa. No necesariamente quitándola, pero sí buscando. Como dije, una alternativa o creando nuestra propia CLI, o forma de. Mostrar todo. Utilizando las, las suscripciones como tal."
  - Baseline measured live on Windows (`v0.1.92`, `Win32_Process`, 0 active agents): **920.4 MB WS / 646.5 MB Priv** (`kite-code.exe` 194.0 MB WS / 173.9 MB Priv, `kite-code.exe --daemon` 155.4 MB WS / 146.2 MB Priv, WebView2 processes 570.4 MB WS / 326.4 MB Priv). `%APPDATA%\Kite Code\kite.sqlite` measured at `94.93 MB` (`167` threads = `77.43 MB` raw JSON, `10.0 MB` `subagentRuns`, `7.86 MB` inline `previewDataUrl`, `12,268` `dispatch_audit` rows).
- **L2 (2026-11-26 — User Selection of Alternative 3 & Parallel Subagent Authorization):**
  > "¿Ok, si me parece todo correcto? Nos quedamos con la alternativa tres. Quiero que plantees los ODS correspondientes para implementar. Quiero que utilices subagentes en paralelo para hacerlo más rápido. No importa cuántos sean, pueden ser hasta máximo seis en paralelo. Pero claro, tienen que ser tareas que se puedan hacer en paralelo ellos como tal. Quiero que continúes con todo."
  - Created 3-ODD series (`baseline-ram-and-leak-elimination.md`, `multiplexed-provider-daemons-and-mcp-hub.md`, `native-rust-agent-fast-lane.md`). Starting Wave 1 (`T1`–`T6`) in parallel with 6 `bounded-writer` subagents.
- **L3 (2026-11-26 — Phase 1 Verification & Seam Closeout):**
  - Seam fixes verified: added `browser_test_lock()` serialization in `src-tauri/src/browser.rs` for global `surfaces()` mutation tests, hardened `CleanupGuard::drop` in `src-tauri/src/chat/runtime_tests.rs`, removed unused `listen` / `isTauriEnvironment` imports in `src/components/views/TerminalView.tsx`, and awaited initial `attach_terminal` settlement in `src/components/views/TerminalView.test.tsx`.
  - Rust checks (`cargo test --manifest-path src-tauri/Cargo.toml --bin kite-code ... -- --test-threads=8`): `browser::` `10/10` passed, `chat::runtime::` `98/98` passed across 3 consecutive parallel runs, `persist::tests` `16/16` passed, `chat::` (`--skip reconcile_native_antigravity`) `361/361` passed, `dispatch_wire::tests` `29/29` passed, `dispatch::policy::` `27/27` passed, `operator_runtime::` `12/12` passed (`1` ignored).
  - Frontend & quality checks: `tsc --noEmit` 0 errors; targeted Phase 1 Vitest suites `8/8` files / `88/88` tests passed (`TerminalView.test.tsx` `4/4`, `TerminalCanvasSurface.test.tsx` `10/10`, `terminalRegistry.test.ts` `8/8`, `useChatGridPersistence.test.ts` `12/12`, `useChatSession.test.tsx` `17/17`, `RightDock.test.tsx` `15/15`, `useNotifications.test.ts` `11/11`, `AgentChatShell.test.tsx` `11/11`); prior full Vitest run had `254/256` files (`1941/1943` tests) with pre-fix `TerminalView.test.tsx` (now `4/4`) and parallel lazy-chunk timing in `SystemResourceBadge.test.tsx` (`6/6` in solo `2.87s`; full workspace Vitest re-run queued for Phase 3 closeout). `vite build` shrunk boot entry chunk `dist/assets/index-*.js` to `779.60 kB` (from `1,067.11 kB`). `verify-ipc.mjs` `[PASS]`; `verify-design.mjs` `[PASS]` on Phase 1 modified files; `audit-references.mjs --check` `[AUDIT CLEAN]`.
  - Pending: isolated live idle RAM benchmark after final Phase 3 build.
  - `Risk: item 1, item 3, item 4, item 5 (SQLite lazy stub safety + compaction in persist.rs, daemon direct-SQLite isolation, async runtime maps & child WebView eviction, entry bundle dependency/dynamic-import split)`.
- **L4 (2026-11-26 — Post-Build Full Vitest & Isolated Live Idle RAM Benchmark):**
  - Full Vitest run (`node ./node_modules/vitest/vitest.mjs run`) passed `256/256` files / `1,947/1,947` tests (`93.25s`) and `DESKTOP-SMOKE-01` CDP E2E passed `1/1` (`7.12s`).
  - Isolated live benchmark (sandboxed debug `kite-code.exe` + `--daemon` loaded with a copy of `94.9 MB` 167-thread `kite.sqlite`, serving Vite `:1420` + CDP):
    - Rust GUI host: **77.9 MB WS / 33.7 MB Priv** (down **-80.6% Priv** from `173.9 MB` in v0.1.92)
    - Rust `--daemon`: **27.8 MB WS / 17.3 MB Priv** (down **-88.2% Priv** from `146.2 MB` in v0.1.92)
    - Combined Rust (`kite-code` + daemon): **105.7 MB WS / 51.0 MB Priv** (down **-84.1% Priv** from `320.1 MB`)
    - WebView2 (7 child processes under Vite dev server `:1420` + active CDP debugger): **590.5 MB WS / 361.8 MB Priv**; total debug-mode sandbox **696.1 MB WS / 412.8 MB Priv** (vs `920.4 MB WS / 646.5 MB Priv`; note release build WebView2 without dev bundle/CDP wasn't spawned separately so user's running v0.1.92 stays untouched). Post-startup open DB read `94.9 MB` + `61.0 MB` WAL prior to WAL checkpoint.
- **L5 (2026-11-26 — Mode-Switch Latency Investigation & CDP Profiling Baseline):**
  > "Mira, ¿tú no te han resuelto problemas de velocidad al momento de seleccionar? No lo sé, la parte de Agents, Code o Thread, al pasarme por cada uno, se sienten muy lento y quiero ver si se demora como un segundo al pasar realmente. A veces es más rápido, claro, pero. se está demorando. Recientemente hicimos cambios de optimización y no sé si algo tuvo que ver con eso, pero la idea sería corregirlo."
  - Profiled isolated desktop sandbox over CDP against clean 168-thread SQLite (`task-1004`): `-> Agent` measured `style=215.1ms (813 recalcs), layout=114.4ms (13), script=453ms` (top CPU: `66x ChatComposer.tsx:333` empty-draft `getComputedStyle`/reflow + `listConnections`, eager `AgentsView` subtab imports, `load_agent_mind`/`list_agent_starters`), and `-> Thread` measured `raf3=111.1ms, layout=18.3ms (47)` (top CPU: `useTranscriptMotion.ts` unbounded `useLayoutEffect` querying/reading hidden layers + `scrollLeft`/re-rendering unmemoized layers). Added `S6` / `T8`.
  - Verified `T8`: `tsc --noEmit`, 11 Vitest files (120/120 tests), `vite build`, `verify:ipc`, `verify:design`, `audit-references --check`, and `DESKTOP-SMOKE-01` (6955ms) passed; CDP re-profile on `kite_clean.sqlite` dropped `-> Agent` to `style=19.4ms, layout=2.9ms, script=18ms, raf3=23.1ms`, `-> Thread` `raf3=20.4ms, script=24.2ms`, and steady-state flips to `raf3=15.7-21.8ms` with 0 long tasks and `ChatComposer`/`useTranscriptMotion` absent from `TOP_CPU`.
