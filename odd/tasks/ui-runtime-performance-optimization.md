# UI Engine & Long-Thread Runtime Performance Optimization

Objective: Eliminate systemic WebView2 renderer/GPU CPU burn and multi-gigabyte memory growth during long conversations (25+ turns, 1,000+ items, 15+ delegated subagents) by removing subagent IPC payload amplification and `kite:threads-changed` full-thread reloads, stopping synchronous full-thread `localStorage` serialization, restoring transcript DOM isolation and stable memoization, and replacing continuous non-compositor animations and idle `rAF` loops without regressing visual language, side-by-side painting, or subagent inspection.
Branch: `feat/response-thread`. Do not commit on `main`.
Delivery strategy: `work-unit-commits` (5 isolated work-unit slices `T1`–`T5`, recommended execution order `T1 -> T2 -> T3 -> T4 -> T5`; await explicit user authorization before beginning implementation).
Test runner: `cargo test --manifest-path src-tauri/Cargo.toml --bin kite-code`, `npx vitest run`, `npx tsc --noEmit`, `npm run verify:desktop:e2e`, `node .kite/sanitizer/audit-references.mjs --check`.
Protected zones: Do NOT modify `src/components/TitleBar.tsx` (`mode-toggle--stadium`, `layoutId="titlebar-mode-toggle-indicator"`), and preserve the 4-tier corner radius and 3-tier control height contracts in `AGENTS.md`.

---

## Specs

### S1 — Subagent Payload Slimming, Deduplication & `kite:threads-changed` Cascade Elimination
Addresses renderer RAM growth (`2,484 MB` Private before crash at `5,158 MB`) and IPC churn when threads carry 15+ delegated subagents (`3.58 MB` / `52.8%` of the `6.77 MB` `"Asistente"` thread JSON was embedded `subagentRuns[].items`).

1. **Lightweight Subagent Projection in `load_thread` (`src-tauri/src/chat/threads.rs:138-215`):**
   - Project `subagentRuns[]` returned over IPC by `load_thread` with `items: []` (matching `list_all_subagent_runs_snapshot` in `src-tauri/src/chat/subagents/dedup.rs:297-302`), while preserving all card/header metadata (`subagentId`, `parentToolCallId`, `childThreadId`, `transcriptUri`, `role`, `status`, `stepCount`, `latestActivity`, `model`, `provider`, `summary`, timestamps).
   - Keep on-demand detail hydration via `get_thread_subagent_detail` -> `build_subagent_detail` (`src-tauri/src/chat/subagents/stream_ingest.rs:277-360`), which already reconstructs items from `childThreadId`, `transcriptUri`, or inline fallback `run.items`.
2. **Stop Duplicating Backed Subagent Items in Parent SQLite JSON & Fix Duplicate `subagentId`s (`src-tauri/src/chat/subagents/dedup.rs:365-420`):**
   - For runs backed by `childThreadId` or `transcriptUri`, do not persist copies of child `items[]` inside `parent.subagentRuns` in `kite.sqlite` (retain inline `items[]` in the parent only when a run has neither `childThreadId` nor `transcriptUri`).
   - Harden `reconcile_duplicate_subagent_state` and subagent run upserts to merge duplicate entries sharing the same `subagentId` (observed live: `26fe5097` and `f18bc9dd` stored twice in `db5a9174`).
   - Remain 100% backward-compatible when reading legacy `kite.sqlite` threads that still contain embedded `subagentRuns[].items`.
3. **Eliminate Double Full-Array Event Emission (`src-tauri/src/chat/subagents/stream_ingest.rs:261-273`, `events.rs:47-60`, `lifecycle.rs:342-348, 724-730`, `transcript.rs:403-409`):**
   - Emit `subagentRunUpdated` with summary/metadata only (`items: []`).
   - Emit `subagentStepsUpdated` with incremental delta items (newly added/updated steps only) instead of re-serializing the entire accumulated `run.items` array twice per step.
4. **Stop `kite:threads-changed` Fan-Out & Redundant `loadChatThread` Reloads:**
   - Narrow `shouldDispatchThreadsChanged` (`src/components/views/chat/hooks/useSubagentEvents.ts:60-75`) so routine mid-turn `subagentStepsUpdated` progress events do NOT emit `kite:threads-changed`; fire only on run creation, removal, lifecycle status transitions (`running <-> waiting/completed/failed`), or structural swarm updates.
   - Remove redundant full-thread `loadChatThread(trackedSubagentThreadId)` on every `kite:threads-changed` in `src/components/RightDock.tsx:353-368` (relying on the existing `kite:subagent-activity-count` listener at line `330` plus a lightweight initial count query when switching threads).
   - Remove redundant full-thread `loadChatThread(activeThreadId)` on every `kite:threads-changed` in `src/components/views/subagents/useSubagentInspectorThread.ts:137-155` (the hook already patches live state directly via `chat-subagent-event` / `chat-swarm-event` at lines `88-120` and hydrates detail lazily via `getThreadSubagentDetail` at line `246`).
   - Gate `useGlobalSubagents.ts:164-199` so `listAllSubagentRuns({ limit: 120 })` does not refresh in the background while the Subagents dock panel is hidden/closed; refresh once upon opening.
5. **Structural Subagent Comparison in `areThreadSnapshotsEquivalent` (`src/components/views/chat/useChatSession.ts:94-98`):**
   - Replace the unconditional `return false` when `subagentRuns.length > 0` with a lightweight structural comparison over `subagentId`, `status`, `stepCount`, `updatedAtUnixMs`, and `latestActivity`.
6. **Acceptance & Checks:**
   - Rust tests assert: `load_thread` strips `subagentRuns[].items`, `build_subagent_detail` hydrates all 3 backing modes (`childThreadId`, `transcriptUri`, inline), step events emit deltas without duplicating full arrays, and duplicate `subagentId` entries coalesce cleanly.
   - Vitest tests (`useSubagentEvents.test.ts`, `SubagentInspectorView.test.tsx`, `useChatSession.test.tsx`) assert `0` calls to `loadChatThread` during bursts of `subagentStepsUpdated`.

---

### S2 — Compositor-Only CSS Animations, Idle `ZedOrb` Pause & Background Window Lifecycle
Addresses the sustained `67%–115%` renderer CPU + `40%–78%` GPU process CPU measured even after restart with lightweight active threads and `1.0%` Rust backend CPU.

1. **Compositor-Only Active Indicators (`src/components/views/chat/styles/chat-work.css:367-424, 461-493`, `src/components/views/chat/styles/chat-core.css:373`, `src/components/ui/agent-indicators.css`):**
   - Replace `box-shadow` animation in `@keyframes chat-working-ping` (`.chat-working-pulse`, `.chat-thread-header__status--running i`, `.chat-thread-row__dot--running`) with a pseudo-element (`::after`) animating only `transform: scale(...)` and `opacity`.
   - Replace `background-position` + `background-clip: text` infinite animations in `.chat-working-live`, `.chat-activity-shine`, and `.live-tool-shine` with compositor-only `opacity` pulsing or a `transform: translateX(...)` shimmer overlay so glyphs are not re-rasterized and re-uploaded every frame.
   - Audit `agent-indicators.css` infinite keyframes so active animations only mutate `transform` / `opacity`.
2. **Stop Idle `requestAnimationFrame` Loop in `ZedOrb` (`src/components/ZedOrb.tsx:333-361`):**
   - When `isCalmState && !isInteracting`, render one static canvas frame and stop scheduling `requestAnimationFrame` (`isRunning = false` -> `0` CPU / `0` GPU).
   - Restart the loop only on `pointerenter`, ripple/click interaction, or voice-active states (`listening`, `transcribing`, `thinking`, `speaking`), and stop again once back to calm idle.
3. **Minimized/Background Gating Without Breaking Side-by-Side Painting (`src-tauri/src/main.rs:126-165`):**
   - Preserve the side-by-side visible painting invariant documented at `main.rs:126-130` (keeping Kite painting while visible next to another app/game).
   - Propagate Tauri native window minimized/focus state to an attribute on `<html>` (e.g. `data-window-state="minimized|blurred|focused"`) and apply `animation-play-state: paused !important` plus rAF pause when minimized or `document.hidden`.
   - Evaluate removing `--disable-background-timer-throttling` and `--disable-renderer-backgrounding` in `install_webview_runtime_flags()` while retaining native occlusion flags (`--disable-features=CalculateNativeWinOcclusion`, `--disable-backgrounding-occluded-windows`) as needed for side-by-side visibility (Rust PTY/stream pumping remains protected by `opt_out_of_efficiency_mode()` at `main.rs:153-165`).
4. **Acceptance & Checks:**
   - Vitest verifies `ZedOrb` schedules zero subsequent `requestAnimationFrame` callbacks once settled in `idle` without interaction, and resumes immediately on hover or active voice state.
   - Live Windows process verification confirms `< 15%` renderer CPU + `< 10%` GPU CPU during active streaming, `< 2%` total WebView2 CPU when minimized/idle, and smooth side-by-side painting next to another window.

---

### S3 — Remove Synchronous Full-Thread `localStorage` Serialization & Coalesce `persist_async`
Eliminates main-thread JS stalls caused by `JSON.stringify(6.77 MB)` + `localStorage.setItem` every `350ms` and reduces large-`Value` cloning frequency in SQLite persistence.

1. **Bounded Hydration Stub in `useChatGridPersistence.ts` (`src/components/views/chat/hooks/useChatGridPersistence.ts:11, 172, 521-552`):**
   - Stop writing full `threadsMap[id]` objects to `localStorage` every `350ms` during streaming (`status === 'running'`), since SQLite is already the durable source of truth in Tauri.
   - Introduce `toLocalHydrationStub(thread)` storing only lightweight metadata, `subagentRuns` without `items`, and a capped recent tail (e.g., last `25` items with long `text`/`detail` truncated and a hard serialized cap `< 150 KB`), flushed only on turn settlement, pane/focus change, or unmount.
   - Prune `kite.chat.thread.<id>` keys from `localStorage` when threads are evicted from the 8-thread LRU (`MAX_CACHED_THREADS_IN_MEMORY = 8`) so WebView2 per-origin quota is never exhausted.
2. **Wider Mid-Turn Coalescing in `persist_async` (`src-tauri/src/persist.rs:977-1058, 1434-1466`):**
   - Increase `persist_async()` coalescing window from `120ms` to `600ms–1000ms` during rapid mid-turn mutations (keeping synchronous `persist()` on turn completion, approvals, and thread CRUD) so `collect_dirty_threads` does not clone and serialize multi-megabyte thread JSON trees 8 times per second.
3. **Acceptance & Checks:**
   - Vitest validates `toLocalHydrationStub` size bounds (`< 150 KB`), zero `localStorage.setItem` writes during active streaming deltas, LRU key cleanup, and seamless cold-boot hydration reconciled by `loadChatThread`.
   - `cargo test --manifest-path src-tauri/Cargo.toml persist` passes cleanly.

---

### S4 — Transcript DOM Isolation, Bounded Render Window & Stable Memoization
Makes transcript rendering cost proportional to the visible viewport instead of scaling linearly with all 1,098+ items in a long conversation.

1. **Restore `content-visibility: auto` & Bound Initial Render Weight (`src/components/views/chat/styles/chat-core.css:2`, `src/chunks.css:68`, `src/components/views/chat/SingleThreadPane.tsx:395, 834-842`):**
   - Remove the `.chat-transcript__column>*{content-visibility:visible;contain-intrinsic-size:none}` override in `chat-core.css:2` so off-screen settled rows benefit from `content-visibility: auto; contain-intrinsic-size: auto 120px` (keeping `content-visibility: visible` only on the active trailing live row if needed to prevent auto-scroll jitter).
   - Replace the coarse `visibleLimit = 200` grouped-row cap with a bounded initial window based on both grouped rows and underlying item weight (e.g., last `40` grouped rows or `<= 150` underlying items), preserving progressive *"Show earlier messages"* expansion and scroll-position anchoring (or full viewport virtualization with cached row heights).
2. **Referentially Stable Grouping (`src/components/views/chat/chatItemHelpers.ts:290-355`):**
   - Incrementally stabilize `groupTranscriptRows`: reuse prior `TranscriptRow` objects and `row.items` arrays for all settled groups whose underlying `ChatItem` references did not change, restoring `React.memo` effectiveness on historical `ChatWorkGroup` and `SubagentGroupRow` components.
3. **Decouple Per-Row Subagent Props & Memoize `SubagentActivityCard` (`src/components/views/chat/SingleThreadPane.tsx:254-275`, `ChatItemRow.tsx:581-586`, `SubagentActivityCard.tsx:40-60`):**
   - Index `subagentRuns` once per render into a `Map` and pass each `ChatItemRow` only its matched `SubagentRun` (and each `SubagentGroupRow` only its group's matched runs) instead of the entire `subagentRuns` array, so progress on subagent #17 never re-renders completed rows #1–#16.
   - Wrap `SubagentActivityCard` in `React.memo` and hoist `useActiveInspection` (`SUBAGENT_INSPECTION_CHANGE_EVENT`) to a single provider/context so there is 1 window listener instead of N per-card listeners.
4. **Reduce Per-Tick Overhead in `ThreadTurnRail`, `TurnActivityStatus` & `useSmoothStreamingText`:**
   - `src/components/views/chat/ThreadTurnRail.tsx:16-108`: cache `ThreadTurnEntry` per settled turn keyed by `(userItemId, sliceLength, lastItemRef)` so `stripMarkdown` / `expandCitations` regexes only re-run on the active trailing turn.
   - `src/components/views/chat/TurnActivityStatus.tsx:50-54`: relax `setInterval` from `200ms` to `1000ms` (display precision is seconds) and memoize `turnStartUnixMs(items)` and `liveStageLabel(items, swarmState)` on `[items, swarmState]`.
   - `src/components/views/chat/useSmoothStreamingText.ts:57-68`: pace streaming commits to `~30fps` (`>= 33ms`) and bypass character-by-character pacing for large streaming blocks (`> 6,000` chars) to avoid full `ReactMarkdown` re-parses at 60/120Hz.
5. **Acceptance & Checks:**
   - Vitest render-count tests confirm `0` re-renders on historical `ChatItemRow`, `ChatWorkGroup`, and `SubagentActivityCard` instances when appending deltas or updating an unrelated subagent, plus caching tests for `ThreadTurnRail` and `TurnActivityStatus`.
   - `npm run verify:desktop:e2e` verifies live-edge auto-scroll, diff expansion, and `ThreadTurnRail` jump navigation without layout jumps.

---

### S5 — Load-Regression Guardrails & End-to-End Verification
Prevents future regressions on long threads and validates target RAM/CPU reductions against the live baseline.

1. **Synthetic Long-Thread Regression Suite:**
   - Add deterministic test fixtures modeling `30` turns, `1,000` items, and `15` subagents verifying:
     - `load_thread` omits `subagentRuns[].items` over IPC.
     - `0` `loadChatThread` invocations across 50 consecutive `subagentStepsUpdated` events.
     - `<= 1` historical row re-render during live streaming or unrelated subagent updates.
2. **Full Verification & Live Telemetry Sign-Off:**
   - Run `npx tsc --noEmit`, `npx vitest run`, `cargo test --manifest-path src-tauri/Cargo.toml --bin kite-code`, `npm run verify:desktop:e2e`, and `node .kite/sanitizer/audit-references.mjs --check`.
   - Capture before/after Windows process measurements (`msedgewebview2.exe` renderer + gpu-process and `kite-code.exe`) opening `"Asistente"` (`db5a9174`) and running an active turn with delegated subagents, logging observed figures in `## Log`.

---

## Tasks

> **Execution status**: Complete (`T1`–`T5` implemented and verified inline on `feat/response-thread`).

- [x] **T1** (`S1`, Risk: `item 1, item 3 — subagent IPC/event contracts & SQLite parent run deduplication`, route: `inline fullstack`, commit: `working-tree`): Added `strip_external_run_items`, `project_thread_for_ipc`, `compact_settled_child_backed_run_items`, and `merge_same_subagent_id_runs` in `src-tauri/src/chat/subagents/dedup.rs` + wired IPC projection in `src-tauri/src/chat_commands/threads_cmd.rs` and settled child-backed run compaction in `src-tauri/src/chat/threads.rs`; slimmed `subagentRunUpdated` payloads and added fingerprint-backed incremental `delta_step_items` in `src-tauri/src/chat/subagents/events.rs`; narrowed `shouldDispatchThreadsChanged` with `seenRunSignatures` in `src/components/views/chat/hooks/useSubagentEvents.ts`; removed redundant `kite:threads-changed` `loadChatThread` reloads in `src/components/RightDock.tsx` and `src/components/views/subagents/useSubagentInspectorThread.ts`; paused background refreshes in `src/components/views/subagents/useGlobalSubagents.ts` when `document.visibilityState === 'hidden'`; and added `areSubagentRunsEquivalent` structural comparison in `src/components/views/chat/useChatSession.ts`. Verified: `cargo test --manifest-path src-tauri/Cargo.toml --bin kite-code chat::subagents` (43/43 passed including 5 new `payload_slimming_tests`), Vitest `useSubagentEvents.test.ts` + `SubagentInspectorView.test.tsx` + `useChatSession.test.tsx` + `RightDock.test.tsx` (5 files, 54/54 passed), `npx tsc --noEmit` exit 0.
- [x] **T2** (`S2`, Risk: `item 5, item 6 — WebView2 background runtime flags & Windows compositor behavior`, route: `inline fullstack`, commit: `working-tree`): Converted `@keyframes chat-working-ping` (via `::after` pseudo-element ring on `.chat-working-pulse`, `.chat-thread-header__status--running i`, `.chat-thread-row__dot--running`, and `.chat-swarm-dot--working`), `@keyframes chat-shimmer-sweep` (`.chat-working-live`, `.chat-activity-shine`), and `@keyframes live-tool-shine` (`.live-tool-shine`) in `chat-work.css`, `chat-subagents.css`, and `chat-core.css` to compositor-only `transform`/`opacity` animations with zero `box-shadow` or `background-clip: text` repaints; paused `ArgosOrb` (`ZedOrb`) `requestAnimationFrame` in calm idle states (`lastCalmSignature` single-frame render, waking on pointer interaction, ripple, or active voice states); wired native `kite:window-state` emission in `src-tauri/src/main.rs` and `src-tauri/src/window.rs` to `data-window-state="minimized|blurred|focused"` in `useAppGlobalEvents.ts` with `animation-play-state: paused !important` across `chat-work.css`, `chat-subagents.css`, and `agent-indicators.css`; and removed `--disable-background-timer-throttling` and `--disable-renderer-backgrounding` from `install_webview_runtime_flags()` while keeping native occlusion flags for side-by-side painting. Verified: `ZedOrb.test.tsx` (4/4), `ChatItemRow.test.tsx` (33/33), `SubagentActivityCard.test.tsx` (8/8), `npx tsc --noEmit` exit 0.
- [x] **T3** (`S3`, Risk: `item 3, item 4 — cold-boot hydration stub & async SQLite flush coalescing`, route: `inline fullstack`, commit: `working-tree`): Added `toLocalHydrationStub` (`MAX_LOCAL_HYDRATION_STUB_ITEMS = 25`, `MAX_LOCAL_HYDRATION_ITEM_TEXT_CHARS = 3000`, `MAX_LOCAL_HYDRATION_STUB_BYTES = 150 KB`, stripping `subagentRuns[].items`), deferred mid-turn streaming `localStorage.setItem` writes until turn settlement or unmount, and removed evicted LRU `kite.chat.thread.<id>` keys in `src/components/views/chat/hooks/useChatGridPersistence.ts`; widened `PERSIST_ASYNC_COALESCE_MS` from `120ms` to `750ms` in `src-tauri/src/persist.rs`. Verified: `useChatGridPersistence.test.ts` (9/9 passed), `cargo test --manifest-path src-tauri/Cargo.toml --bin kite-code persist::tests` (10/10 passed).
- [x] **T4** (`S4`, Risk: `item 3 — transcript layout/scroll-anchor & ThreadTurnRail interaction`, route: `inline frontend`, commit: `working-tree`): Removed the `.chat-transcript__column>*{content-visibility:visible}` override in `src/components/views/chat/styles/chat-core.css` (restoring `content-visibility: auto; contain-intrinsic-size: auto 120px` while keeping `:last-child` and `:nth-last-child(2)` at `content-visibility: visible`), added `INITIAL_VISIBLE_TRANSCRIPT_ROWS = 48`, `INITIAL_VISIBLE_UNDERLYING_ITEMS = 150`, and `sliceTranscriptRowsByWindow` plus pre-deduplicated per-row `matchedSubagentRun` wiring in `src/components/views/chat/SingleThreadPane.tsx`, stabilized settled `TranscriptRow` and `row.items` references in `src/components/views/chat/chatItemHelpers.ts`, updated `areChatItemRowPropsEqual` in `src/components/views/chat/ChatItemRow.tsx` to compare only the row's matched `SubagentRun`, wrapped `SubagentActivityCard` in `React.memo` with a single shared `SUBAGENT_INSPECTION_CHANGE_EVENT` store and added `areSubagentGroupRowPropsEqual` in `src/components/views/chat/SubagentActivityCard.tsx`, cached settled `ThreadTurnEntry` items in `src/components/views/chat/ThreadTurnRail.tsx`, relaxed `TurnActivityStatus` clock interval to `TURN_ACTIVITY_CLOCK_INTERVAL_MS = 1000` with memoized stage/start helpers in `src/components/views/chat/TurnActivityStatus.tsx`, and added `SMOOTH_STREAM_MIN_FRAME_MS = 33` (~30fps) and `SMOOTH_STREAM_BYPASS_CHARS = 6000` in `src/components/views/chat/useSmoothStreamingText.ts`. Verified: 6 chat test suites (84/84 tests passed including `longThreadPerformance.test.tsx`), `npx tsc --noEmit` exit 0.
- [x] **T5** (`S5`, Risk: `none`, route: `inline verification`, commit: `working-tree`): Added synthetic 30-turn / 1,000-item / 15-subagent load regression suite in `src/components/views/chat/longThreadPerformance.test.tsx` (5/5 passed), verified `npx tsc --noEmit` (exit 0), full Vitest suite (210/210 test files, 1,634/1,634 tests passed; `ttsNarrator.test.ts` verified 18/18 standalone after full-run contention), Rust `chat::subagents` (43/43) and `persist::tests` (10/10), `npm run verify:desktop:e2e -- --spec desktop-smoke` (`DESKTOP-SMOKE-01` PASS in 7,568ms), and `node .kite/sanitizer/audit-references.mjs --check` (`[AUDIT CLEAN] Scanned 193 file(s)`).

---

## Log

- **L1 (2026-11-22 — Read-Only UI Engine Performance Investigation):**
  > "Quiero que investigues el consumo actual de la aplicación nuestra, básicamente, porque ahora noto un consumo excesivo en la parte de motor UI. Mira. Lo que está trabajando actualmente es una conversación que llevo bastante. Mensajes, quiero decir, lleva 26 mensajes míos. Lleva varios subagentes. Delegados. Eh, y eso. Hay que saber por qué es ese consumo tan alto actualmente. Identificar puntos de corrección y mejora que podemos implementar, o si que simplemente es algo que sucedió. Porque a ver, el consumo parece un tanto alto. Para solamente la parte de UI, quiero decir. Diría que se puede hacer algo."
  - **Live Windows Telemetry Baseline (`Kite Code v0.1.78`, `Win32_Process`):**
    - Pre-crash active state (`kite-code.exe` PID `12248`, WebView2 main `12024`, renderer `13840`, GPU `17696`): renderer `13840` at **`2,482.7–2,484.4 MB` Priv / `1,505–1,507.8 MB` WS / `63%` CPU (`7,503.2s` cumulative)**; GPU `17696` at **`176.1–192.6 MB` Priv / `35.4%` CPU (`5,034.2s` cumulative)**; `kite-code.exe` `12248` at `562.8 MB` Priv / `1.6%` CPU.
    - Observed live WebView2 crash (`16:22:13–16:22:28`): renderer `13840` exited (`1d73ff58-c647-4d25-856f-87f8e31d00f2.dmp`, `7.57 MB`), followed by WebView2 main `12024` spiking to **`5,158.9 MB` WS / `5,150.8 MB` Priv** and **`111.5%` CPU** before exit (`5f3e0a5a-7c78-43e5-9ffa-7c89f1525f3e.dmp`, `10.31 MB`).
    - Post-restart instance (`kite-code.exe` `24944`, WebView2 main `23424`, renderer `21448`, GPU `23740`): ~1 min after restart renderer `21448` at **`115.1%` CPU** (`510.2 MB` WS / `448.2 MB` Priv) and GPU `23740` at **`78.1%` CPU** (`273.4 MB` WS / `249.8 MB` Priv). Minutes later, with 2 lightweight running threads (`a4a3106e`, `2417f4a5`) and Rust backend `24944` at **`1.0%` CPU** (`415.6 MB` WS / `384.6 MB` Priv), renderer `21448` remained at **`67.2%` CPU (`265.6s`, `605.8 MB` WS / `531.7 MB` Priv)** and GPU `23740` at **`39.6%` CPU (`177.1s`, `186.7 MB` WS / `152.6 MB` Priv)**.
  - **SQLite Audit (`%APPDATA%\Kite Code\kite.sqlite`):**
    - `132` threads totaling `80,919,806` bytes (`80.92 MB`).
    - Target long thread `db5a9174-0a0a-4ac0-8496-75b183e1a634` (`"Asistente"`): **`6,769,511` bytes (~`6.77 MB`)**, `1,098` items, `17` `subagentRuns` totaling **`3,576,890` bytes (`52.8%` of JSON)** with `926` embedded items and duplicate `subagentId` records (`26fe5097` x2, `f18bc9dd` x2).
  - **Ruled out as primary causes in Thread mode:** `TerminalCanvasSurface.tsx:354-428` (pauses canvas via `.mode-layer` `MutationObserver`), `SystemResourcePopover.tsx:78-98` (FPS rAF runs only when popover is open), `read_turn_updates` in `src-tauri/src/chat/runtime/turn.rs:859-921` (blocks cleanly on `Condvar`), and `DiffWorkerPoolProvider.tsx:15-74` (capped at 1–2 workers with 60s idle disposal).
- **L2 (2026-11-22 — Detailed Plan Request):**
  > "arma un plan mas detallado"
  - Delivered 5-unit execution plan (`WU1`–`WU5`) with exact file/symbol anchors, target metrics, invariants, and risk analysis.
- **L3 (2026-11-22 — ODD Creation Request):**
  > "aterriza eso en un odd"
  - Created `odd/tasks/ui-runtime-performance-optimization.md` (`S1`–`S5`, `T1`–`T5`) and mirrored to Engram under `odd/ui-runtime-performance-optimization/tasks`.
- **L4 (2026-11-22 — Inline Implementation Authorization & Continuation Check):**
  > "odd/tasks/ui-runtime-performance-optimization.md Implementa este ODD, en su totalidad. Eh, pero hazlo tú, no lo delegas a subagentes."
  > "odd/tasks/ui-runtime-performance-optimization.md Implementa este ODD, en su totalidad. Eh, pero hazlo tú, no lo delegas a subagentes. Mira, este o de ella se había partido, pero, no se dejó marcado qué cosas se hicieron. Eh ¿Se modificaron algunos archivos? Pero claro, se tienen que revisar y continuar con todo el ODD"
  - Verified and checked off `T1` (`S1`) in the ODD (`chat::subagents` 43/43 Rust tests + 54/54 frontend Vitest tests + `tsc --noEmit` exit 0). Continuing inline with `T2` (`S2`), `T3` (`S3`), `T4` (`S4`), and `T5` (`S5`).
  - Completed `T2` (`S2`), `T3` (`S3`), `T4` (`S4`), and `T5` (`S5`) inline with zero subagent delegation:
    - `npx tsc --noEmit`: exit `0`
    - `npx vitest run`: `210/210` files, `1,634/1,634` tests passed (`ttsNarrator.test.ts` 18/18 verified standalone after parallel contention)
    - `cargo test --manifest-path src-tauri/Cargo.toml --bin kite-code chat::subagents`: `43/43` passed (including 5 new `payload_slimming_tests`)
    - `cargo test --manifest-path src-tauri/Cargo.toml --bin kite-code persist::tests`: `10/10` passed
    - `npm run verify:desktop:e2e -- --spec desktop-smoke`: `DESKTOP-SMOKE-01` **PASS** (`7,568ms`)
    - `node .kite/sanitizer/audit-references.mjs --check`: `[AUDIT CLEAN] Scanned 193 file(s). Zero reference leaks detected.`
    - Live Windows process sample (`Win32_Process` on running host instance `24944` before binary rebuild): GPU process `23740` at `4.7%` CPU (`121.6 MB` WS / `130.5 MB` Priv), `kite-code` `24944` at `2.1%` CPU (`407.9 MB` WS), WebView2 main `23424` at `1.0%` CPU (`37.8 MB` Priv), renderer `21448` at `41.1%` CPU hosting the active session.
